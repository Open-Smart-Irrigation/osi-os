'use strict';
// Static scan of the Go port for the dispatch inventory
// (edge/contracts/dispatch-inventory.json): which entry points exist, which
// effect sinks exist, and which effects each entry point can reach through a
// name-based call graph. Pure functions over file text; the caller supplies
// the files, so tests run on in-memory fixtures.
//
// The call graph over-approximates on purpose: a name resolves to every Go
// function of that name the call form allows (a plain call to package
// functions, a selector call to methods and package functions). An entry that
// may reach a sink must have an inventory row; a false reach costs one row,
// a missed reach costs a silent boundary.

// Replace comments with spaces, keeping newlines and string contents, so line
// numbers survive and commented-out code does not count.
function stripGoComments(text) {
  let out = '', i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === '"' || c === '\'') {
      out += c; i++;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') { out += text[i++]; }
        if (i < n) out += text[i++];
      }
      if (i < n) out += text[i++];
    } else if (c === '`') {
      out += c; i++;
      while (i < n && text[i] !== '`') out += text[i++];
      if (i < n) out += text[i++];
    } else { out += c; i++; }
  }
  return out;
}

const FUNC_RE = /^func\s+(?:\(\s*\w*\s*\*?\s*(\w+)\s*\)\s*)?(\w+)\s*[([]/;

// Functions of one Go file. gofmt puts the closing brace of a top-level
// function at column 0, which is what the body scan relies on.
function parseGoFile(file, text) {
  const code = stripGoComments(text);
  const lines = code.split('\n');
  const pkg = (/^package\s+(\w+)/m.exec(code) || [])[1] || '';
  const funcs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FUNC_RE.exec(lines[i]);
    if (!m) continue;
    let end = i;
    if (!/\{\s*$/.test(lines[i]) || /\{\s*\}\s*$/.test(lines[i])) {
      // One-line body, or a signature that continues: find the column-0 brace.
      if (/\{.*\}\s*$/.test(lines[i])) end = i;
      else { end = i + 1; while (end < lines.length && lines[end] !== '}') end++; }
    } else { end = i + 1; while (end < lines.length && lines[end] !== '}') end++; }
    funcs.push({ file, pkg, recv: m[1] || null, name: m[2], line: i + 1, endLine: end + 1, body: lines.slice(i, end + 1).join('\n') });
    i = end;
  }
  return { file, pkg, code, funcs };
}

// ---- Sinks ---------------------------------------------------------------

// ChirpStack DeviceService requests by their request type. Reads are not
// effects; every other request type must be classified here, or the scan
// fails so the new call gets a sink class.
const CHIRPSTACK_EFFECTS = {
  EnqueueDeviceQueueItemRequest: 'enqueue',
  FlushDeviceQueueRequest: 'flush',
  CreateDeviceRequest: 'device-create',
  CreateDeviceKeysRequest: 'device-keys',
  UpdateDeviceKeysRequest: 'device-keys',
  UpdateDeviceRequest: 'device-update',
  DeleteDeviceRequest: 'device-delete',
};
const CHIRPSTACK_READ = /^(Get|List)\w*Request$/;

// Effects the static scan proves. Other effect names in the inventory
// (valve-state, actuator-log, ...) are descriptive and not cross-checked.
const SINK_EFFECTS = ['enqueue', 'flush', 'device-create', 'device-keys', 'device-update', 'device-delete',
  'cloud-mqtt', 'local-mqtt', 'outbox', 'history', 'hold-file', 'file-write'];

// Effects with no Go sink today. A hit means Go started doing something
// Node-RED's boundary list has no row for.
const EXPECTED_ABSENT = ['local-mqtt', 'hold-file'];

// Tables whose triggers write sync_outbox (effect outbox) or
// sync_history_dirty_keys (effect history), from the seed schema.
function triggerTables(schemaSql) {
  const out = { outbox: {}, history: {} };
  const re = /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+(?:BEFORE|AFTER|INSTEAD\s+OF)?\s*(INSERT|UPDATE|DELETE)(?:\s+OF\s+[\w\s,]+?)?\s+ON\s+(\w+)([\s\S]*?)\bEND\s*;/gi;
  let m;
  while ((m = re.exec(schemaSql))) {
    const [, name, event, table, body] = m;
    const add = (kind) => { ((out[kind][table.toLowerCase()] ||= {})[event.toUpperCase()] ||= []).push(name); };
    if (/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sync_outbox\b/i.test(body)) add('outbox');
    if (/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sync_history_dirty_keys\b/i.test(body)) add('history');
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Sink sites inside one function body: [{effect, sink, line}].
function sinksIn(fn, tables, problems) {
  const hits = [];
  const add = (effect, sink, index) => hits.push({ effect, sink, line: fn.line + lineOf(fn.body, index) - 1 });
  const body = fn.body;
  let m;
  const reqRe = /\bapi\.(\w+Request)\s*\{/g;
  while ((m = reqRe.exec(body))) {
    if (CHIRPSTACK_READ.test(m[1])) continue;
    const effect = CHIRPSTACK_EFFECTS[m[1]];
    if (effect) add(effect, 'chirpstack ' + m[1], m.index);
    else problems.push(`${fn.file}:${fn.line + lineOf(body, m.index) - 1}: unclassified ChirpStack request api.${m[1]}; add it to CHIRPSTACK_EFFECTS in edge/harness/lib/dispatch-scan.js`);
  }
  if (fn.pkg !== 'cloudmqtt') {
    const pubRe = /\.cloud\.Publish(?:Await)?\s*\(/g;
    while ((m = pubRe.exec(body))) add('cloud-mqtt', 'cloud publish', m.index);
    const startRe = /\bcloudmqtt\.Start\s*\(/g;
    while ((m = startRe.exec(body))) add('cloud-mqtt', 'cloud connect', m.index);
  }
  if (fn.pkg === 'ingest' || fn.pkg === 'main') {
    const localRe = /\b(?:c|client|mqtt)\.Publish\s*\(/g;
    while ((m = localRe.exec(body))) add('local-mqtt', 'local publish', m.index);
  }
  const fileRe = /\bos\.(WriteFile|Create|CreateTemp|OpenFile|Rename|Remove|RemoveAll|Mkdir|MkdirAll|Symlink|Link|Chmod|Truncate)\s*\(/g;
  while ((m = fileRe.exec(body))) {
    const around = body.slice(Math.max(0, m.index - 200), m.index + 200);
    const hold = /osi-recovery|\.lock\b|repair-hold|writer-hold/.test(around);
    add(hold ? 'hold-file' : 'file-write', 'os.' + m[1], m.index);
  }
  // SQL: whole-body matching, since statements span lines.
  const sqlRe = /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)\b/gi;
  while ((m = sqlRe.exec(body))) {
    const verb = m[1].toUpperCase(), table = m[2].toLowerCase();
    if (verb.startsWith('UPDATE') && !/^\s*SET\b/i.test(body.slice(m.index + m[0].length, m.index + m[0].length + 40).replace(/^["`]/, ''))) continue;
    if (table === 'sync_outbox') { if (!verb.startsWith('DELETE') && !verb.startsWith('UPDATE')) add('outbox', 'INSERT INTO sync_outbox', m.index); continue; }
    const events = verb.startsWith('INSERT') || verb.startsWith('REPLACE') ? ['INSERT'] : verb.startsWith('UPDATE') ? ['UPDATE'] : ['DELETE'];
    if (verb.startsWith('INSERT') && /\bON\s+CONFLICT\b[^;`]*\bDO\s+UPDATE\b/i.test(body.slice(m.index, m.index + 2000).split(/`/)[0])) events.push('UPDATE');
    if (verb.startsWith('REPLACE') || /OR\s+REPLACE/i.test(verb)) events.push('DELETE');
    for (const kind of ['outbox', 'history']) {
      const t = tables[kind][table];
      if (!t) continue;
      const names = events.flatMap((e) => t[e] || []);
      if (names.length) add(kind, `${verb.replace(/\s+/g, ' ')} ${table} (trigger ${names[0]}${names.length > 1 ? ' +' + (names.length - 1) : ''})`, m.index);
    }
  }
  return hits;
}

// ---- Entry points --------------------------------------------------------

function scanEntries(parsed) {
  const entries = [];
  for (const f of parsed) {
    const lines = f.code.split('\n');
    lines.forEach((ln, i) => {
      let m;
      const at = `${f.file}:${i + 1}`;
      if ((m = /\bregister(?:WithCatch)?\(\s*"(\w+)",\s*"([^"]+)",\s*\(\*backend\)\.(\w+)/.exec(ln))) entries.push({ kind: 'http', name: `${m[1]} ${m[2]}`, handler: m[3], recv: 'backend', registered: at });
      else if ((m = /\bregister(?:Calendar)?Timer\(\s*"([^"]+)",.*\(\*backend\)\.(\w+)\)/.exec(ln))) entries.push({ kind: 'timer', name: m[1], handler: m[2], recv: 'backend', registered: at });
      else if ((m = /\bregisterUplink\(\s*"([^"]+)",\s*\(\*backend\)\.(\w+)/.exec(ln))) entries.push({ kind: 'uplink', name: m[1], handler: m[2], recv: 'backend', registered: at });
      else if ((m = /\.ingest\.Handle(?:OnReceipt)?\(\s*"([^"]+)",\s*(.*)$/.exec(ln))) {
        const rest = m[2];
        const call = /(\w+)\.(\w+)\s*\(\s*b\b/.exec(rest) || /\bb\.(\w+)\s*\)/.exec(rest);
        if (call) entries.push({ kind: 'uplink', name: m[1], handler: call[2] || call[1], recv: call[2] ? null : 'backend', registered: at });
      }
    });
  }
  // The HTTP dispatcher itself (test hooks and anything served outside the
  // route table). Route handlers are cut like every other entry's handler.
  const serve = parsed.flatMap((f) => f.funcs).find((x) => x.name === 'ServeHTTP' && x.recv === 'backend');
  if (serve) entries.push({ kind: 'http', name: 'ServeHTTP', handler: 'ServeHTTP', recv: 'backend', registered: `${serve.file}:${serve.line}` });
  if (parsed.some((f) => f.funcs.some((fn) => fn.name === 'main' && fn.pkg === 'main' && !fn.recv))) {
    const fn = parsed.flatMap((f) => f.funcs).find((x) => x.name === 'main' && x.pkg === 'main' && !x.recv);
    entries.push({ kind: 'startup', name: 'main', handler: 'main', recv: null, registered: `${fn.file}:${fn.line}` });
  }
  return entries;
}

// Every registration call site must parse into an entry. Calls that pass a
// variable name are allowed only inside the register* helpers themselves and
// in the uplinkHandlers loop; anything else (a multi-line call, a closure
// handler) is reported so the parser above gets extended.
const REGISTER_CALL = /((?<![\w.])register(?:WithCatch|Timer|CalendarTimer|Uplink)?|\.ingest\.Handle(?:OnReceipt)?)\s*\(/g;
function unparsedRegistrations(parsed, entries) {
  const parsedAt = new Set(entries.map((e) => e.registered));
  const out = [];
  for (const f of parsed) {
    const helpers = f.funcs.filter((fn) => !fn.recv && /^register/.test(fn.name));
    const lines = f.code.split('\n');
    lines.forEach((ln, i) => {
      for (const m of ln.matchAll(REGISTER_CALL)) {
        if (/^func\s/.test(ln)) continue;
        const at = `${f.file}:${i + 1}`;
        if (parsedAt.has(at)) continue;
        const inHelper = helpers.some((fn) => i + 1 > fn.line && i + 1 <= fn.endLine);
        const handlerLoop = /\.ingest\.Handle\(\s*h\.name\b/.test(ln) && /range\s+uplinkHandlers/.test(lines.slice(Math.max(0, i - 3), i).join('\n'));
        if (inHelper || handlerLoop) continue;
        out.push(`${at}: registration call ${m[1]}(...) did not parse into an entry point; extend scanEntries in edge/harness/lib/dispatch-scan.js`);
      }
    });
  }
  return out;
}

// ---- Call graph ----------------------------------------------------------

const GO_KEYWORDS = new Set(['if', 'for', 'switch', 'return', 'func', 'go', 'defer', 'select', 'case', 'range', 'make', 'len', 'cap', 'append', 'new', 'panic', 'recover', 'copy', 'delete', 'close', 'string', 'int', 'byte', 'error', 'bool', 'float64', 'int64', 'uint32', 'any', 'min', 'max', 'clear', 'print', 'println']);

function buildGraph(parsed) {
  const funcs = parsed.flatMap((f) => f.funcs);
  const plainByPkg = {}, methods = {}, pkgNames = new Set(parsed.map((f) => f.pkg));
  for (const fn of funcs) {
    if (fn.recv) (methods[fn.name] ||= []).push(fn);
    else ((plainByPkg[fn.pkg] ||= {})[fn.name] ||= []).push(fn);
  }
  const callees = new Map();
  for (const fn of funcs) {
    const out = new Set();
    // Calls and method values: name( , x.name( , (*T).name , x.name passed as a value.
    const re = /(\b\w+\s*\.\s*|\)\s*\.\s*)?\b([A-Za-z_]\w*)\b(\s*\()?/g;
    const code = fn.body.replace(/"(?:[^"\\\n]|\\.)*"|`[^`]*`/g, (s) => ' '.repeat(s.length));
    let m;
    const header = /^[^{]*/.exec(code)[0].length;
    // Names the function declares itself (parameters, :=, var, range) shadow
    // package functions of the same name.
    const locals = new Set();
    // Parameter lists of the function and of every closure in it.
    const sig = code.slice(0, header).replace(/^func\s+(\([^)]*\))?\s*\w+/, 'func');
    for (const list of (sig + code.slice(header)).matchAll(/\bfunc\s*\(([^()]*)\)/g)) {
      for (const part of list[1].split(',')) { const id = /^\s*(\w+)/.exec(part); if (id) locals.add(id[1]); }
    }
    for (const d of code.matchAll(/\b((?:\w+\s*,\s*)*\w+)\s*:=/g)) d[1].split(',').forEach((x) => locals.add(x.trim()));
    for (const d of code.matchAll(/\bvar\s+(\w+)/g)) locals.add(d[1]);
    re.lastIndex = header;
    while ((m = re.exec(code))) {
      const [, sel, name, call] = m;
      if (GO_KEYWORDS.has(name)) continue;
      if (!sel && locals.has(name)) continue;
      if (sel) {
        const qual = sel.replace(/[\s.]/g, '');
        if (pkgNames.has(qual) && plainByPkg[qual] && plainByPkg[qual][name]) { plainByPkg[qual][name].forEach((t) => out.add(t)); continue; }
        (methods[name] || []).forEach((t) => out.add(t));
      } else if (call) {
        ((plainByPkg[fn.pkg] || {})[name] || []).forEach((t) => out.add(t));
      } else {
        // A bare identifier names a function value only when it is one.
        ((plainByPkg[fn.pkg] || {})[name] || []).forEach((t) => out.add(t));
      }
    }
    out.delete(fn);
    // Process entry functions are never callees: Go starts them.
    for (const t of [...out]) if (!t.recv && t.pkg === 'main' && ['main', 'init'].includes(t.name)) out.delete(t);
    callees.set(fn, out);
  }
  return { funcs, plainByPkg, methods, callees };
}

function handlerFunc(graph, entry) {
  if (entry.recv) return (graph.methods[entry.handler] || []).filter((f) => f.recv === entry.recv);
  if (entry.kind === 'startup') return ((graph.plainByPkg.main || {})[entry.handler] || []);
  return graph.methods[entry.handler] || ((graph.plainByPkg.main || {})[entry.handler] || []);
}

// ---- Scan ----------------------------------------------------------------

// files: [{file, text}] (non-test Go under edge/go); schemaSql: seed schema text.
// shared: Go functions ("name" or "(recv).name") that the inventory lists as
// shared boundaries. A walk from an entry point stops there and reports the
// shared entry instead; each shared function is scanned as its own entry.
function scan(files, schemaSql, shared = [], { canary = true } = {}) {
  const problems = [];
  const parsed = files.filter((f) => /\.go$/.test(f.file) && !/_test\.go$/.test(f.file)).map((f) => parseGoFile(f.file, f.text));
  const tables = triggerTables(schemaSql);
  const graph = buildGraph(parsed);
  const sinks = new Map();
  const sinkSites = [];
  for (const fn of graph.funcs) {
    const hits = sinksIn(fn, tables, problems);
    if (hits.length) sinks.set(fn, hits);
    hits.forEach((h) => sinkSites.push({ ...h, func: fn.name, file: fn.file }));
  }
  const entries = scanEntries(parsed);
  const sharedFuncs = new Map();
  for (const spec of shared) {
    const m = /^(?:\((\w+)\)\.)?(\w+)$/.exec(spec);
    const found = m && graph.funcs.filter((f) => f.name === m[2] && (m[1] ? f.recv === m[1] : true));
    if (!found || found.length !== 1) { problems.push(`shared boundary ${spec} matches ${found ? found.length : 0} Go functions (need exactly 1)`); continue; }
    sharedFuncs.set(found[0], spec);
    entries.push({ kind: 'shared', name: spec, handler: found[0].name, recv: found[0].recv, registered: `${found[0].file}:${found[0].line}`, fn: found[0] });
  }
  const handlerSet = new Set(entries.flatMap((e) => (e.fn ? [e.fn] : handlerFunc(graph, e))));
  for (const e of entries) {
    const starts = e.fn ? [e.fn] : handlerFunc(graph, e);
    if (!starts.length) { problems.push(`${e.registered}: handler ${e.handler} for ${e.kind} ${e.name} not found`); e.effects = {}; e.viaShared = {}; e.sites = []; continue; }
    e.go = `${starts[0].file}:${starts[0].line}`;
    // BFS that does not enter another entry's handler (startup wires them all).
    const parent = new Map(starts.map((s) => [s, null]));
    const queue = [...starts];
    const effects = {};
    const viaShared = {};
    const sites = [];
    while (queue.length) {
      const fn = queue.shift();
      if (sharedFuncs.has(fn) && !starts.includes(fn)) {
        const chain = [];
        for (let x = fn; x; x = parent.get(x)) chain.unshift(`${x.recv ? '(' + x.recv + ').' : ''}${x.name}`);
        viaShared[sharedFuncs.get(fn)] ||= chain;
        continue;
      }
      for (const h of sinks.get(fn) || []) {
        const chain = [];
        for (let x = fn; x; x = parent.get(x)) chain.unshift(`${x.recv ? '(' + x.recv + ').' : ''}${x.name}`);
        const site = { effect: h.effect, sink: h.sink, at: `${fn.file}:${h.line}`, chain };
        sites.push(site);
        if (!effects[h.effect]) effects[h.effect] = site;
      }
      for (const next of graph.callees.get(fn) || []) {
        if (parent.has(next) || (handlerSet.has(next) && !starts.includes(next))) continue;
        parent.set(next, fn);
        queue.push(next);
      }
    }
    e.effects = effects;
    e.viaShared = viaShared;
    e.sites = sites;
  }
  problems.push(...unparsedRegistrations(parsed, entries));
  // Sinks outside any function body (package-level vars, init expressions)
  // would be invisible to the walk.
  for (const f of parsed) {
    const whole = sinksIn({ file: f.file, pkg: f.pkg, line: 1, body: f.code }, tables, []);
    const inFuncs = sinkSites.filter((x) => x.file === f.file).length;
    if (whole.length !== inFuncs) problems.push(`${f.file}: ${whole.length} sink site(s) in the file but ${inFuncs} inside function bodies; a sink outside a function is not walked`);
  }
  for (const effect of SINK_EFFECTS) {
    const n = sinkSites.filter((s) => s.effect === effect).length;
    if (EXPECTED_ABSENT.includes(effect)) {
      if (n) problems.push(`sink class ${effect} now has ${n} Go site(s) (${sinkSites.filter((s) => s.effect === effect).map((s) => s.file + ':' + s.line).join(', ')}); Node-RED's inventory has no row for it`);
    } else if (canary && !n) {
      problems.push(`canary: sink class ${effect} matched no Go site; the pattern in edge/harness/lib/dispatch-scan.js is probably stale`);
    }
  }
  return { entries, sinkSites, tables, problems };
}

module.exports = { scan, stripGoComments, parseGoFile, triggerTables, SINK_EFFECTS, EXPECTED_ABSENT, CHIRPSTACK_EFFECTS };
