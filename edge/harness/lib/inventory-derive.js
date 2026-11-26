'use strict';
// Which mutants exercise one dispatch-inventory check (inventory-mutate.js).
//
// A check names the Node-RED test (js), the Go line that makes the same test
// (go), optional further refs, and a probe scenario#step. Its inputs are:
//   - the probe step's own sites (request fields, uplink payload leaves);
//   - the literals earlier sql steps of the probe scenario write (stored rows
//     the step reads);
//   - stored columns: a table and one of its columns that the check's code
//     both names and no earlier sql literal writes. A column step
//     `UPDATE t SET c = <expression of c>` just before the probe step rewrites
//     whatever the column holds, whoever wrote it (a no-op in the control).
// A site fits the check when its name (sql column, JSON key, query or form
// key) is an identifier in the check's code: the js, go and refs line ranges,
// plus the bodies of the functions those ranges call, to `depth` levels. The
// probe step's own sites are all kept when none of them matches a name.
// An explicit `mutation` field on the check replaces the derivation:
//   { "sites": "REGEX", "steps": ["id"], "operators": ["name"],
//     "columns": [{ "table": "t", "column": "c", "where": "SQL" }], "skip": "why" }
const fs = require('node:fs'), path = require('node:path');
const { sitesOf, mutantsOf } = require('./mutate-sites');
const { findWrittenLiterals, affinityOf } = require('./mutate-sql');

// The operator families of the CTO ruling for inventory rows.
const OPERATORS = ['whitespace-trim', 'nul-char', 'case-flip', 'blob-text', 'numeric-text', 'malformed-valve-eui', 'unparseable-timestamp'];
// Quick mode (review rounds): one or two variants per operator.
const QUICK = {
  'whitespace-trim': ['only-feff', 'pad-tab'],
  'nul-char': ['nul-tail'],
  'case-flip': ['flip'],
  'blob-text': ['blob'],
  'numeric-text': ['nbsp'],
  'malformed-valve-eui': ['nonhex'],
  'unparseable-timestamp': ['garbage'],
};
const isQuick = (m) => (QUICK[m.operator] || []).some((q) => m.variant === q || m.variant.endsWith('=' + q));

function parseRef(ref) {
  const m = /^([^:#\s]+):(\d+)(?:-(\d+))?$/.exec(ref || '');
  if (!m) return null;
  const start = Number(m[2]), end = m[3] ? Number(m[3]) : start;
  return { file: m[1], start, end: Math.max(start, end) };
}

// Function bodies by name. Go: every non-test file under edge/go, a body runs
// from `func … Name(` to the first `}` in column 0 (gofmt). JavaScript: the
// files a check names, a body runs from `function Name(` to its matching brace.
function goIndex(root) {
  const index = new Map();
  (function walk(d) {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const p = path.posix.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.go') && !p.endsWith('_test.go')) {
        const lines = fs.readFileSync(path.join(root, p), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = /^func (?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/.exec(lines[i]);
          if (!m) continue;
          let j = i;
          while (j < lines.length && lines[j] !== '}') j++;
          const body = lines.slice(i, j + 1).join('\n');
          index.set(m[1], (index.get(m[1]) || '') + '\n' + body);
        }
      }
    }
  })('edge/go');
  return index;
}

// A body longer than this is a brace the scan lost (a regex literal with a
// quote); it is cut there.
const MAX_BODY = 20000;
function jsBodies(text) {
  const out = new Map();
  const re = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1] || m[2];
    const open = text.indexOf('{', re.lastIndex);
    if (open === -1 || open - re.lastIndex > 400) continue;
    let depth = 0, i = open, quote = null;
    const cap = Math.min(text.length, open + MAX_BODY);
    for (; i < cap; i++) {
      const c = text[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl === -1 ? cap : nl; continue; }
      if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? cap : e + 1; continue; }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    out.set(name, (out.get(name) || '') + '\n' + text.slice(m.index, i + 1));
  }
  return out;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
const identifiers = (text) => new Set((text.match(IDENT) || []).map((x) => x.toLowerCase()));

// The code text of a check and the identifiers in it.
function codeOf(check, { root, go, depth = 1 }) {
  const refs = [check.js, check.go, ...(check.refs || []).map((r) => r.at)].map(parseRef).filter(Boolean);
  const files = new Map();
  const read = (f) => { if (!files.has(f)) files.set(f, fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : ''); return files.get(f); };
  let text = refs.map((r) => read(r.file).split('\n').slice(r.start - 1, r.end).join('\n')).join('\n');
  // flows.json keeps a function node on one line as an escaped JSON string.
  text = text.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  const js = new Map();
  // JavaScript callees: functions of the module file a ref points into; for
  // flows.json only the referenced lines (one function node each).
  for (const r of refs) {
    if (r.file.endsWith('.go')) continue;
    const src = r.file.endsWith('.json') ? read(r.file).split('\n').slice(r.start - 1, r.end).join('\n') : read(r.file);
    for (const [k, v] of jsBodies(src.replace(/\\n/g, '\n').replace(/\\"/g, '"'))) js.set(k, (js.get(k) || '') + v);
  }
  const seen = new Set();
  let frontier = text;
  for (let d = 0; d < depth; d++) {
    let next = '';
    for (const id of new Set(frontier.match(IDENT) || [])) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (go.has(id)) next += go.get(id);
      if (js.has(id)) next += js.get(id);
    }
    if (!next) break;
    text += '\n' + next;
    frontier = next;
  }
  return { text, names: identifiers(text) };
}

// The name a site is matched by: sql column, the last key of a JSON path,
// the base of a query or form key.
function siteName(site) {
  const label = site.site || site.label;
  if (label.startsWith('sql.')) {
    const json = label.indexOf('$');
    if (json !== -1) { const keys = label.slice(json + 1).match(/[A-Za-z_][\w]*/g); return (keys ? keys[keys.length - 1] : '').toLowerCase(); }
    return label.slice(4).split('#')[0].split('.').pop().toLowerCase();
  }
  if (label.startsWith('query.') || label.startsWith('form.')) return label.replace(/^(query|form)\./, '').split('[')[0].toLowerCase();
  const keys = label.match(/[A-Za-z_][\w]*/g) || [];
  return (keys[keys.length - 1] || '').toLowerCase();
}

// Column steps never touch keys (the joins between device rows would break;
// malformed-valve-eui carries a key instead), the harness's own bookkeeping,
// or the outbox the checks write to.
const NOT_INJECTED = /^(id|deveui|device_eui|.*_uuid|.*_id)$/i;
const NOT_INJECTED_TABLES = new Set(['sync_outbox', 'schema_migrations', 'schema_object_fingerprints', 'sqlite_sequence']);

// Stored columns a check reads that no earlier sql literal writes: a table
// and one of its columns both named in the check's code.
function columnsFor(names, scenario, probeIndex, columnsOf, tables) {
  const literal = new Set();
  for (const s of scenario.steps.slice(0, probeIndex)) {
    if (typeof s.sql === 'string') for (const l of findWrittenLiterals(s.sql, columnsOf)) literal.add(String(l.table).toLowerCase() + '.' + String(l.column).toLowerCase());
  }
  const out = [];
  for (const table of [...tables].sort()) {
    if (!names.has(table) || NOT_INJECTED_TABLES.has(table)) continue;
    for (const c of columnsOf(table)) {
      const col = c.name.toLowerCase();
      if (!names.has(col) || NOT_INJECTED.test(col) || literal.has(table + '.' + col)) continue;
      out.push({ table, column: c.name, affinity: affinityOf(c.type) });
    }
  }
  return out;
}

// The column step put just before the probe step: a no-op in the control
// (WHERE 0, so no trigger fires); its mutants rewrite the stored value.
const columnStep = (probeStepId, col) => ({ id: 'col-' + probeStepId + '-' + col.table + '.' + col.column,
  why: 'inventory-mutate: the stored value the check reads, rewritten in place by the mutant',
  column: { table: col.table, column: col.column, affinity: col.affinity, ...(col.where ? { where: col.where } : {}) },
  sql: 'UPDATE "' + col.table + '" SET "' + col.column + '" = "' + col.column + '" WHERE 0;' });

// Mutants of one column step (ids do not depend on the other steps).
function columnMutants(scenario, probeIndex, col, ops, pickQuick) {
  const step = columnStep(scenario.steps[probeIndex].id, col);
  const augmented = { ...scenario, steps: [...scenario.steps.slice(0, probeIndex), step, scenario.steps[probeIndex]] };
  return { ...col, stepId: step.id, step, mutants: pickQuick(mutantsOf(augmented, ops, { keep: (site, st) => st === step })) };
}

// The plan for one check: { source, scenarioFile, scenario, probeIndex,
// mutants (literal and request sites), columns (column steps with mutants) }.
function planCheck(check, { root, go, depth, columnsOf, tables, operators, quick }) {
  const probe = /^(edge\/harness\/scenarios\/[^#]+\.json)#(.+)$/.exec(check.probe || '');
  if (!probe) return { source: 'no-probe', mutants: [], columns: [] };
  const scenarioFile = probe[1];
  const scenario = JSON.parse(fs.readFileSync(path.join(root, scenarioFile), 'utf8'));
  const probeIndex = scenario.steps.findIndex((s) => s.id === probe[2]);
  if (probeIndex === -1) return { source: 'no-probe', mutants: [], columns: [] };
  const explicit = check.mutation || null;
  if (explicit && explicit.skip) return { source: 'skip', why: explicit.skip, scenarioFile, scenario, probeIndex, mutants: [], columns: [] };
  const ops = explicit && explicit.operators ? operators.filter((o) => explicit.operators.includes(o.name)) : operators;
  const truncated = { ...scenario, steps: scenario.steps.slice(0, probeIndex + 1) };
  const { names } = codeOf(check, { root, go, depth });
  const pickQuick = (ms) => (quick ? ms.filter(isQuick) : ms);
  if (explicit && (explicit.sites || explicit.steps || explicit.columns)) {
    const re = explicit.sites ? new RegExp(explicit.sites) : null;
    const plain = explicit.sites || explicit.steps ? mutantsOf(truncated, ops, { columnsOf }).filter((m) => (m.stepIndex === probeIndex || truncated.steps[m.stepIndex].sql)
      && (!explicit.steps || explicit.steps.includes(m.stepId)) && (!re || re.test(m.site))) : [];
    const columns = (explicit.columns || []).map((c) => {
      const info = columnsOf(c.table).find((x) => x.name.toLowerCase() === String(c.column).toLowerCase());
      return columnMutants(scenario, probeIndex, { table: c.table, column: info ? info.name : c.column, affinity: affinityOf(info && info.type), ...(c.where ? { where: c.where } : {}) }, ops, pickQuick);
    });
    return { source: 'explicit', scenarioFile, scenario, probeIndex, names, mutants: pickQuick(plain), columns };
  }
  // Sites first, mutants only for the kept ones. A step with several uplinks
  // keeps one uplink per payload field (the first that has it).
  const probeSites = sitesOf(truncated.steps[probeIndex], columnsOf);
  const field = (label) => label.replace(/^uplinks\[\d+\]\./, 'uplinks.');
  const firstOf = new Map();
  for (const st of probeSites) if (!firstOf.has(field(st.label))) firstOf.set(field(st.label), st.label);
  const representative = probeSites.filter((st) => firstOf.get(field(st.label)) === st.label);
  const anyNamed = representative.some((st) => names.has(siteName(st)));
  const keepDirect = new Set(representative.filter((st) => !anyNamed || names.has(siteName(st))).map((st) => st.label));
  // Quick mode keeps one literal per column (and JSON path): the first.
  const seenColumn = new Set();
  const keep = (site, step, i) => {
    if (i === probeIndex) return keepDirect.has(site.label);
    if (!(i < probeIndex && (site.container === 'sql' || site.container === 'sql-json') && names.has(siteName(site)))) return false;
    if (!quick) return true;
    const k = site.label.replace(/#\d+/, '');
    if (seenColumn.has(k)) return false;
    seenColumn.add(k);
    return true;
  };
  const mutants = pickQuick(mutantsOf(truncated, ops, { columnsOf, keep }));
  const columns = columnsFor(names, scenario, probeIndex, columnsOf, tables).map((c) => columnMutants(scenario, probeIndex, c, ops, pickQuick)).filter((c) => c.mutants.length);
  const any = mutants.length || columns.length;
  return { source: any ? 'derived' : 'none', scenarioFile, scenario, probeIndex, names, mutants, columns, directMatched: anyNamed };
}

module.exports = { OPERATORS, QUICK, isQuick, parseRef, goIndex, jsBodies, codeOf, siteName, columnsFor, columnStep, columnMutants, planCheck, sitesOf, NOT_INJECTED_TABLES };
