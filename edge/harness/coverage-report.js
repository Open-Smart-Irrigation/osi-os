#!/usr/bin/env node
'use strict';
// V8 coverage of the Node-RED oracle, merged over recordings.
//   OSI_ORACLE_COVERAGE_DIR=DIR node edge/harness/record.js --out REC SCENARIO.json
//   node edge/harness/coverage-report.js --out OUT_DIR [--modules a,b,c] DIR/REC...
// Each argument is one recording's NODE_V8_COVERAGE directory (coverage-*.json,
// see lib/backend.js; a directory also holds what the oracle's child processes
// wrote, which is never in scope). OUT_DIR receives report.json, files.tsv,
// nodes.tsv and, for the --modules list (default: the modules the Go port
// touches), unexecuted.txt. A line counts as executed when any byte of it lies
// in a range with count > 0 and no narrower range with count 0 covers it
// entirely. Totals count non-blank, non-comment lines. Function nodes run as
// vm scripts named "Function node[ setup| cleanup]:<id> [<name>]": a Node-RED
// wrapper around the node's func, initialize or finalize. A node that never ran
// has no script and no executed line; nodes in disabled flows are never
// instantiated and are totalled apart.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const NODE_RED = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const GO_PORT_MODULES = ['osi-valve-control', 'osi-command-ingress', 'osi-scope-helper', 'osi-local-password-reset',
  'osi-system-settings', 'osi-entity-name', 'osi-chirpstack-helper', 'osi-daily-scheduler', 'osi-irrigation-policy',
  'osi-device-writer', 'osi-uplink-dedup-guard'];
// What @node-red/nodes/core/function/10-function.js (3.1.15) puts around a
// function node's source. Every script must reproduce its V8 length exactly.
const WRAPPERS = {
  body: ['var results = null;results = (async function(msg,__send__,__done__){ var __msgid__ = msg._msgid;var node = {id:__node__.id,name:__node__.name,path:__node__.path,outputCount:__node__.outputCount,log:__node__.log,error:__node__.error,warn:__node__.warn,debug:__node__.debug,trace:__node__.trace,on:__node__.on,status:__node__.status,send:function(msgs,cloneMsg){ __node__.send(__send__,__msgid__,msgs,cloneMsg);},done:__done__};\n', '\n})(msg,__send__,__done__);'],
  setup: ['\n                    (async function(__send__) {\n                        var node = {\n                            id:__node__.id,\n                            name:__node__.name,\n                            path:__node__.path,\n                            outputCount:__node__.outputCount,\n                            log:__node__.log,\n                            error:__node__.error,\n                            warn:__node__.warn,\n                            debug:__node__.debug,\n                            trace:__node__.trace,\n                            status:__node__.status,\n                            send: function(msgs, cloneMsg) {\n                                __node__.send(__send__, RED.util.generateId(), msgs, cloneMsg);\n                            }\n                        };\n                        ', '\n                    })(__initSend__);'],
  cleanup: ['(function () {\n                        var node = {\n                            id:__node__.id,\n                            name:__node__.name,\n                            path:__node__.path,\n                            outputCount:__node__.outputCount,\n                            log:__node__.log,\n                            error:__node__.error,\n                            warn:__node__.warn,\n                            debug:__node__.debug,\n                            trace:__node__.trace,\n                            status:__node__.status,\n                            send: function(msgs, cloneMsg) {\n                                __node__.error("Cannot send from close function");\n                            }\n                        };\n                        ', '\n                    })();'],
};
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const KEYWORDS = new Set(['break', 'const', 'continue', 'debugger', 'export', 'import', 'var', 'let', 'function', 'class', 'if', 'while', 'for', 'with',
  'switch', 'try', 'finally', 'default', 'static', 'extends', 'enum']);
const PAREN_WORDS = new Set(['if', 'while', 'for', 'with']);

// Line starts, which lines hold code, and the comment ranges of one JS source.
function lex(source) {
  const starts = [0];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
  const code = new Uint8Array(starts.length), comments = [];
  const n = source.length, parens = [], slots = [];
  let i = 0, line = 0, prev = 'op', word = '', parenWord = '', depth = 0, template = false;
  const take = () => { if (source.charCodeAt(i) === 10) line++; i++; };
  const mark = () => { if (source[i] !== '\n') code[line] = 1; take(); };
  const ident = (c) => /[A-Za-z_$]/.test(c) || c > '\x7f';
  const digit = (c) => c >= '0' && c <= '9';
  while (i < n) {
    const c = source[i];
    if (template) {
      if (c === '\\') { mark(); if (i < n) mark(); } else if (c === '`') { mark(); template = false; prev = 'expr'; }
      else if (c === '$' && source[i + 1] === '{') { mark(); mark(); slots.push(depth); template = false; prev = 'op'; }
      else if (/\s/.test(c)) take(); else mark();
      continue;
    }
    if (/\s/.test(c)) { take(); continue; }
    if ((c === '/' && source[i + 1] === '/') || (c === '#' && i === 0 && source[1] === '!')) {
      const at = i; while (i < n && source[i] !== '\n') take(); comments.push([at, i]); continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const at = i; take(); take();
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) take();
      if (i < n) { take(); take(); } comments.push([at, i]); continue;
    }
    if (c === '"' || c === "'") {
      mark(); while (i < n && source[i] !== c) { if (source[i] === '\\') { mark(); if (i < n) mark(); } else mark(); }
      if (i < n) mark(); prev = 'expr'; continue;
    }
    if (c === '`') { mark(); template = true; continue; }
    if (c === '/' && (prev === 'op' || prev === 'brace' || (prev === 'paren' && PAREN_WORDS.has(parenWord)))) {
      mark(); let cls = false;
      while (i < n && (cls || source[i] !== '/')) {
        if (source[i] === '\\') { mark(); if (i < n) mark(); continue; }
        if (source[i] === '[') cls = true; else if (source[i] === ']') cls = false;
        mark();
      }
      if (i < n) mark(); while (i < n && /\w/.test(source[i])) mark(); prev = 'expr'; continue;
    }
    if (ident(c)) {
      const at = i; while (i < n && (ident(source[i]) || digit(source[i]))) mark();
      word = source.slice(at, i); prev = REGEX_KEYWORDS.has(word) || KEYWORDS.has(word) ? 'op' : 'expr'; continue;
    }
    if (digit(c) || (c === '.' && digit(source[i + 1]))) {
      while (i < n && (/\w/.test(source[i]) || (source[i] === '.' && digit(source[i + 1])))) {
        mark(); if (/[eE]/.test(source[i - 1]) && (source[i] === '+' || source[i] === '-') && i < n) mark();
      }
      prev = 'expr'; continue;
    }
    if (c === '(') { parens.push(word); prev = 'op'; }
    else if (c === ')') { parenWord = parens.pop(); prev = 'paren'; }
    else if (c === '[') prev = 'op'; else if (c === ']') prev = 'expr';
    else if (c === '{') { depth++; prev = 'op'; }
    else if (c === '}' && slots.length && depth === slots[slots.length - 1]) { slots.pop(); template = true; mark(); continue; }
    else if (c === '}') { depth--; prev = 'brace'; }
    else if ((c === '+' || c === '-') && source[i + 1] === c) { mark(); mark(); prev = 'expr'; continue; }
    else prev = 'op';
    mark();
  }
  return { starts, code, comments };
}

// True when the source still parses once every comment is blanked out.
function compiles(source, comments, wrap) {
  let text = source;
  for (let k = comments.length - 1; k >= 0; k--) text = text.slice(0, comments[k][0]) + text.slice(comments[k][0], comments[k][1]).replace(/[^\n]/g, ' ') + text.slice(comments[k][1]);
  try { new vm.Script(wrap[0] + text + wrap[1]); return true; } catch (e) { return false; }
}

// Segments [start, end) of one V8 script whose innermost range has count > 0.
function executedRanges(script) {
  const ranges = [];
  for (const f of script.functions) for (const r of f.ranges) ranges.push([r.startOffset, r.endOffset, r.count]);
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const stack = [], out = [];
  let at = 0;
  const inner = () => (stack.length ? stack[stack.length - 1][1] : 0);
  for (const r of ranges) {
    while (stack.length && stack[stack.length - 1][0] <= r[0]) { const [end, count] = stack.pop(); if (count > 0 && end > at) out.push([at, end]); at = end; }
    if (inner() > 0 && r[0] > at) out.push([at, r[0]]);
    at = r[0]; stack.push([r[1], r[2]]);
  }
  while (stack.length) { const [end, count] = stack.pop(); if (count > 0 && end > at) out.push([at, end]); at = end; }
  return out;
}

// Marks the code lines (script offsets from..to) that meet an executed segment.
function markLines(ranges, m, from, to) {
  let k = 0;
  for (const [s, e] of ranges) {
    if (e <= from || s >= to) continue;
    const a = Math.max(s, from) - from, b = Math.min(e, to) - from;
    while (k + 1 < m.starts.length && m.starts[k + 1] <= a) k++;
    for (let j = k; j < m.starts.length && m.starts[j] < b; j++) if (m.code[j] && (j + 1 < m.starts.length ? m.starts[j + 1] - 1 : m.source.length) > a) m.executed[j] = 1;
  }
}

function measure(source, wrap) {
  const lx = lex(source);
  return { raw: source ? lx.starts.length - (source.endsWith('\n') ? 1 : 0) : 0, starts: lx.starts, code: lx.code, source, runs: 0, executed: new Uint8Array(lx.starts.length), compiles: compiles(source, lx.comments, wrap) };
}
function count(bytes) { let n = 0; for (const v of bytes) n += v; return n; }
function pct(part, whole) { return whole ? (100 * part / whole).toFixed(1) : '0.0'; }
function total(list) { return list.reduce((a, r) => ({ n: a.n + 1, raw: a.raw + r.lines.raw, sloc: a.sloc + count(r.lines.code), executed: a.executed + count(r.lines.executed) }), { n: 0, raw: 0, sloc: 0, executed: 0 }); }
function row(label, t) { return [label, t.n, t.raw, t.sloc, t.executed, pct(t.executed, t.sloc)]; }

function jsFiles(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out); else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

function rangesOf(flags) {
  const out = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    const at = i; while (i + 1 < flags.length && flags[i + 1]) i++;
    out.push(at === i ? String(i + 1) : (at + 1) + '-' + (i + 1));
  }
  return out.join(', ');
}

function table(head, rows) {
  const width = head.map((h, c) => Math.max(h.length, ...rows.map((r) => String(r[c]).length)));
  const line = (r) => r.map((v, c) => (c ? String(v).padStart(width[c]) : String(v).padEnd(width[c]))).join('  ');
  return [line(head), line(width.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

function main() {
  const o = { runs: [], modules: GO_PORT_MODULES };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--out') o.out = path.resolve(process.argv[++i]);
    else if (a === '--modules') o.modules = process.argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else o.runs.push(path.resolve(a));
  }
  if (!o.out || !o.runs.length) throw new Error('usage: coverage-report.js --out DIR [--modules a,b] RUN_DIR...');

  const files = [];
  for (const dir of fs.readdirSync(NODE_RED).sort()) {
    if (!dir.startsWith('osi-')) continue;
    for (const p of jsFiles(path.join(NODE_RED, dir), []).sort()) {
      const file = path.relative(NODE_RED, p).split(path.sep).join('/');
      files.push({ file, module: dir, test: /\.(test|spec)\.m?js$/.test(p), lines: measure(fs.readFileSync(p, 'utf8'), ['(function (exports, require, module, __filename, __dirname) {\n', '\n})']) });
    }
  }
  const byFile = new Map(files.map((f) => [f.file, f]));
  const flows = JSON.parse(fs.readFileSync(path.join(NODE_RED, '../flows.json'), 'utf8'));
  const disabledTabs = new Set(flows.filter((n) => n.type === 'tab' && (n.disabled || n.d)).map((n) => n.id));
  const parts = [], byUrl = new Map();
  for (const n of flows) {
    if (n.type !== 'function') continue;
    for (const part of ['body', 'setup', 'cleanup']) {
      const text = part === 'body' ? n.func || '' : (n[part === 'setup' ? 'initialize' : 'finalize'] || '').trim();
      if (!text) continue;
      const record = { id: n.id, name: n.name || '', part, disabled: disabledTabs.has(n.z), lines: measure(text, ['(async function (msg, send, done) {\n', '\n})']) };
      parts.push(record); byUrl.set('Function node' + (part === 'body' ? '' : ' ' + part) + ':' + n.id + (n.name ? ' [' + n.name + ']' : ''), record);
    }
  }

  const diag = { coverageFiles: 0, scripts: 0, moduleScripts: 0, nodeScripts: 0, otherScripts: 0, lengthMismatch: [], unknownNodeUrl: [], runsWithoutCoverage: [] };
  for (const run of o.runs) {
    const touched = new Set();
    const names = fs.existsSync(run) ? fs.readdirSync(run).filter((f) => /^coverage-.*\.json$/.test(f)).sort() : [];
    if (!names.length) diag.runsWithoutCoverage.push(path.basename(run));
    for (const name of names) {
      diag.coverageFiles++;
      for (const script of JSON.parse(fs.readFileSync(path.join(run, name), 'utf8')).result) {
        diag.scripts++;
        const url = script.url;
        const record = byUrl.get(url) || byFile.get(/(?:^|\/)(osi-[^/]+\/[^/?#]+\.m?js)$/.exec(url.replace(/^file:\/\//, ''))?.[1]);
        if (url.startsWith('Function node') && !record) { diag.unknownNodeUrl.push(url); continue; }
        if (!record || !script.functions.length) { if (!record) diag.otherScripts++; continue; }
        const [head, tail] = record.part ? WRAPPERS[record.part] : ['', ''];
        if (script.functions[0].ranges[0].endOffset !== head.length + record.lines.source.length + tail.length) {
          if (!diag.lengthMismatch.includes(url)) diag.lengthMismatch.push(url);
          continue;
        }
        if (record.part) diag.nodeScripts++; else diag.moduleScripts++;
        markLines(executedRanges(script), record.lines, head.length, head.length + record.lines.source.length);
        touched.add(record);
      }
    }
    for (const record of touched) record.lines.runs++;
  }

  const moduleFiles = files.filter((f) => !f.test), testFiles = files.filter((f) => f.test);
  const live = parts.filter((p) => !p.disabled);
  const bodies = live.filter((p) => p.part === 'body'), hooks = live.filter((p) => p.part !== 'body');
  const directories = [...new Set(files.map((f) => f.module))].sort().map((m) => ({ module: m, ...total(files.filter((f) => f.module === m && !f.test)) }));
  const totals = [
    row('osi-* modules (*.js, not tests)', total(moduleFiles)), row('osi-* test files (*.test.js)', total(testFiles)),
    row('function nodes (func)', total(bodies)), row('function nodes (initialize + finalize)', total(hooks)),
    row('function nodes in disabled flows (never instantiated)', total(parts.filter((p) => p.disabled))),
    row('TOTAL in scope', total([...moduleFiles, ...bodies, ...hooks])),
  ];
  const uncompiled = [...files.filter((f) => !f.lines.compiles).map((f) => f.file), ...parts.filter((p) => !p.lines.compiles).map((p) => p.id + ':' + p.part)];
  const head = ['scope', 'files', 'raw lines', 'code lines', 'executed', '%'];

  fs.mkdirSync(o.out, { recursive: true });
  const json = {
    generatedAt: new Date().toISOString(), node: process.versions.node,
    gitHead: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (e) { return null; } })(),
    runs: o.runs.map((r) => path.basename(r)),
    rule: 'a line is executed when any byte of it lies in a V8 range with count > 0 and no narrower range with count 0 covers it entirely; code lines are non-blank and non-comment',
    totals, directories, uncompiled,
    files: files.map((f) => ({ file: f.file, module: f.module, test: f.test, raw: f.lines.raw, sloc: count(f.lines.code), executed: count(f.lines.executed), runs: f.lines.runs })),
    nodes: parts.map((p) => ({ id: p.id, name: p.name, part: p.part, disabledFlow: p.disabled, raw: p.lines.raw, sloc: count(p.lines.code), executed: count(p.lines.executed), runs: p.lines.runs })),
    diagnostics: diag,
  };
  fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify(json, null, 1) + '\n');
  fs.writeFileSync(path.join(o.out, 'files.tsv'), ['file\ttest\traw\tsloc\texecuted\truns', ...files.map((f) => [f.file, f.test ? 'test' : 'no', f.lines.raw, count(f.lines.code), count(f.lines.executed), f.lines.runs].join('\t'))].join('\n') + '\n');
  fs.writeFileSync(path.join(o.out, 'nodes.tsv'), ['id\tname\tpart\traw\tsloc\texecuted\truns', ...parts.map((p) => [p.id, p.name, p.part, p.lines.raw, count(p.lines.code), count(p.lines.executed), p.lines.runs].join('\t'))].join('\n') + '\n');
  const unexecuted = ['# Unexecuted code lines per file. Line numbers are 1-based; a range runs from the first to the',
    '# last unexecuted code line with no executed code line between. "never loaded": no recording',
    '# required the file. Test files are not loaded by the oracle and are not listed.'];
  for (const m of o.modules) {
    const list = files.filter((f) => f.module === m && !f.test), t = total(list);
    unexecuted.push('', m + ': ' + t.executed + '/' + t.sloc + ' code lines executed in ' + t.n + ' files');
    const width = Math.max(44, ...list.map((f) => f.file.length));
    for (const f of list) {
      const sloc = count(f.lines.code), executed = count(f.lines.executed);
      const missed = Array.from(f.lines.code, (c, i) => c && !f.lines.executed[i]);
      unexecuted.push('  ' + f.file.padEnd(width) + (f.lines.runs ? String(executed).padStart(5) + '/' + String(sloc).padEnd(5) + ' ' + pct(executed, sloc).padStart(5) + '%  unexecuted: ' + (rangesOf(missed) || 'none')
        : 'never loaded (' + sloc + ' code lines)'));
    }
  }
  fs.writeFileSync(path.join(o.out, 'unexecuted.txt'), unexecuted.join('\n') + '\n');

  console.log(`Recordings: ${o.runs.length}; coverage files: ${diag.coverageFiles}; scripts: ${diag.scripts} (osi-* modules ${diag.moduleScripts}, function nodes ${diag.nodeScripts}, other ${diag.otherScripts})`);
  console.log(`Function nodes: ${flows.filter((n) => n.type === 'function').length} in flows.json (${new Set(parts.filter((p) => p.disabled).map((p) => p.id)).size} in disabled flows, never instantiated); ${new Set(parts.filter((p) => p.lines.runs).map((p) => p.id)).size} ran in at least one recording`);
  console.log(`Comment-scan self-check (source parses with comments blanked): ${files.length + parts.length - uncompiled.length}/${files.length + parts.length}` + (uncompiled.length ? ' WARNING, failed for ' + uncompiled.join(', ') : ''));
  console.log('\n' + table(['module', ...head.slice(1)], directories.map((d) => [d.module, d.n, d.raw, d.sloc, d.executed, pct(d.executed, d.sloc)])));
  console.log('\n' + table(['module (' + o.modules.length + ' the Go port touches)', ...head.slice(1)], o.modules.map((m) => { const d = directories.find((x) => x.module === m); return d ? [d.module, d.n, d.raw, d.sloc, d.executed, pct(d.executed, d.sloc)] : [m, 'not found']; })));
  console.log('\n' + table(head, totals));
  console.log(`\nWritten: ${['report.json', 'files.tsv', 'nodes.tsv', 'unexecuted.txt'].map((f) => path.join(o.out, f)).join(', ')}`);
  if (diag.lengthMismatch.length) console.log('WARNING: source length differs from the recording for ' + diag.lengthMismatch.length + ' script(s): ' + diag.lengthMismatch.slice(0, 5).join(', '));
  if (diag.unknownNodeUrl.length) console.log('WARNING: function node scripts not in flows.json: ' + diag.unknownNodeUrl.slice(0, 5).join(', '));
  if (diag.runsWithoutCoverage.length) console.log('WARNING: no coverage files in ' + diag.runsWithoutCoverage.join(', '));
  if (diag.lengthMismatch.length) process.exitCode = 1;
}
main();
