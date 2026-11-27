#!/usr/bin/env node
'use strict';
// Runs every dispatch-inventory check's probe under every mutation operator
// that fits its inputs (CTO ruling: a row is ok only through its probe, and
// the probe must also hold under whitespace/trim, NUL, case, BLOB, numeric
// text, malformed EUI and unparseable timestamp mutants). See MUTATION.md,
// "Inventory pass".
//
//   node edge/harness/inventory-mutate.js --backend-cmd BIN --out DIR
//        [--quick] [--rows REGEX] [--groups REGEX] [--jobs N] [--chunk N] [--depth N] [--rounds N]
//
// Full mode reads each check's js, go and refs lines plus the functions they
// call (--depth, default 1), keeps every literal and every variant. --quick
// (review rounds) reads the check's own lines (the callees only when those
// name no input), keeps the first literal per column and one or two variants
// per operator (lib/inventory-derive.js QUICK), and runs 2 tick rounds.
//        [--inventory FILE] [--list] [--report-only] [--retry-errors] [--rejudge]
//
// --list prints each check's derivation and mutant count and runs nothing.
// The run is resumable: a mutant id already in a group's summaries for the
// same binary is not run again. --report-only rebuilds the report from them.
// Writes DIR/inventory-mutation.json and DIR/REPORT-TABLE.md. Exit 1 when any
// mutant is TIER-B-FAIL or ERROR.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { loadOperators } = require('./lib/mutate-ops');
const { OPERATORS, planCheck, goIndex } = require('./lib/inventory-derive');
const { probeEnv } = require('./lib/probe-env');

const ROOT = path.resolve(__dirname, '../..');
// A row's verdict is its worst mutant. REJECTED (the schema refused the
// value) ranks below OK: it is no pass, but coverage is counted apart.
// FLAKY (a TIER-B-FAIL its confirmation run did not repeat) ranks with
// LOGGED: listed, not a failure.
const RANK = { 'TIER-B-FAIL': 5, ERROR: 4, FLAKY: 3, LOGGED: 3, OK: 2, REJECTED: 1 };

function args(argv) {
  const o = { quick: false, jobs: 2, chunk: 40, depth: 1, rounds: 3, list: false, reportOnly: false, inventory: 'edge/contracts/dispatch-inventory.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--backend-cmd') o.cmd = path.resolve(next());
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--quick') o.quick = true;
    else if (a === '--rows') o.rows = new RegExp(next());
    else if (a === '--groups') o.groups = new RegExp(next());
    else if (a === '--jobs') o.jobs = Number(next());
    else if (a === '--chunk') o.chunk = Number(next());
    else if (a === '--depth') o.depth = Number(next());
    else if (a === '--rounds') o.rounds = Number(next());
    else if (a === '--inventory') o.inventory = next();
    else if (a === '--list') o.list = true;
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '--retry-errors') o.retryErrors = true;
    else if (a === '--rejudge') { o.rejudge = true; o.reportOnly = true; }
    else throw new Error('unknown argument ' + a);
  }
  if (!o.list && (!o.cmd || !o.out)) throw new Error('--backend-cmd and --out are required');
  if (o.quick && !argv.includes('--rounds')) o.rounds = 2;
  return o;
}

function columnsReader() {
  const db = new DatabaseSync(path.join(ROOT, 'database/farming.db'), { readOnly: true });
  const cache = {};
  return (table) => {
    if (!table) return [];
    if (!cache[table]) {
      try { cache[table] = db.prepare('SELECT name, type FROM pragma_table_info(?)').all(table).map((r) => ({ name: r.name, type: r.type })); }
      catch { cache[table] = []; }
    }
    return cache[table];
  };
}

const groupName = (scenarioFile) => scenarioFile.replace(/^edge\/harness\/scenarios\//, '').replace(/\.json$/, '').replace(/[^A-Za-z0-9._-]+/g, '_');

// Groups: one mutate.js run per probe scenario, cut after its last probe
// step, with each check's column steps put just before its probe step.
function plan(o) {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, o.inventory), 'utf8'));
  const operators = loadOperators(OPERATORS);
  const columnsOf = columnsReader();
  const tables = tableNames();
  const go = goIndex(ROOT);
  const checks = [], groups = new Map();
  for (const e of inventory.entries) {
    for (const c of e.checks || []) {
      const key = e.id + '/' + c.id;
      if (o.rows && !o.rows.test(key) && !o.rows.test('row' + c.row)) continue;
      // Quick mode reads only the check's own lines first, and the functions
      // they call only when those lines name no input.
      let depth = o.quick ? 0 : o.depth;
      let p = planCheck(c, { root: ROOT, go, depth, columnsOf, tables, operators, quick: o.quick });
      if (p.source === 'none' && depth < o.depth) { depth = o.depth; p = planCheck(c, { root: ROOT, go, depth, columnsOf, tables, operators, quick: o.quick }); }
      // A probe recorded legacy and scoped runs as two groups; the scoped one
      // is named <group>@scoped (lib/probe-env.js).
      const modes = p.scenario ? probeEnv(p.scenario.name).modes : ['legacy'];
      const named = p.scenarioFile ? modes.map((mode) => ({ mode, name: groupName(p.scenarioFile) + (mode === 'scoped' && modes.length > 1 ? '@scoped' : '') })) : [];
      const wanted = o.groups ? named.filter((x) => o.groups.test(x.name)) : named;
      if (o.groups && !wanted.length) continue;
      const row = { key, entry: e.id, check: c.id, row: c.row ?? null, probe: c.probe, status: c.status, source: p.source, why: p.why, depth,
        mutantIds: [], columns: [], group: null, groups: [] };
      checks.push(row);
      const ms = [...p.mutants, ...(p.columns || []).flatMap((x) => x.mutants)];
      row.sites = [...new Set(ms.map((m) => (m.container === 'sql-column' ? '' : m.stepId + ':') + m.site))];
      row.operators = [...new Set(ms.map((m) => m.operator))];
      row.columns = (p.columns || []).map((x) => x.table + '.' + x.column);
      if (!ms.length) continue;
      for (const m of ms) row.mutantIds.push(m.id);
      for (const { mode, name } of wanted) {
        const gkey = p.scenarioFile + '#' + mode;
        if (!groups.has(gkey)) {
          groups.set(gkey, { key: gkey, name, scoped: mode === 'scoped',
            scenarioFile: p.scenarioFile, scenario: p.scenario, cut: -1, columnSteps: new Map(), ids: new Set() });
        }
        const g = groups.get(gkey);
        g.cut = Math.max(g.cut, p.probeIndex);
        for (const x of p.columns || []) {
          const list = g.columnSteps.get(p.probeIndex) || [];
          if (!list.some((s) => s.id === x.step.id)) list.push(x.step);
          g.columnSteps.set(p.probeIndex, list);
        }
        for (const m of ms) g.ids.add(m.id);
        row.groups.push(g.name);
      }
      row.group = row.groups[0] || null;
    }
  }
  return { checks, groups: [...groups.values()] };
}

function tableNames() {
  const db = new DatabaseSync(path.join(ROOT, 'database/farming.db'), { readOnly: true });
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name.toLowerCase()));
}

// The scenario a group runs: steps up to the cut, column steps in place.
function groupScenario(g) {
  const steps = [];
  g.scenario.steps.slice(0, g.cut + 1).forEach((s, i) => { steps.push(...(g.columnSteps.get(i) || []), s); });
  return { ...g.scenario, steps };
}

// Summaries already written for a group with this binary, merged.
function readParts(dir, sha, scoped = false) {
  const out = { mutants: new Map(), controls: [], parts: [] };
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir).filter((x) => /^part-\d+$/.test(x)).sort()) {
    const f = path.join(dir, d, 'summary.json');
    if (!fs.existsSync(f)) continue;
    let s; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (s.meta.backendSha256 !== sha || Boolean(s.meta.scoped) !== Boolean(scoped)) continue;
    out.parts.push({ dir: path.join(dir, d), meta: s.meta });
    out.controls.push(...s.controls.map((c) => ({ ...c, part: d })));
    // A later part's result replaces an earlier one (a re-run ERROR).
    for (const m of s.mutants) if (!(out.mutants.has(m.id) && m.verdict === 'ERROR' && out.mutants.get(m.id).verdict !== 'ERROR')) out.mutants.set(m.id, { ...m, part: d });
  }
  return out;
}

// The mutate.js runs a group still needs: its ids not yet in a summary for
// this binary, sorted by step and cut into chunks of --chunk ids, each its
// own run (prefix pass and controls included) so a large group runs in
// parallel. Part numbers are taken here, before any run starts.
function tasksOf(g, o, sha) {
  const dir = path.join(o.out, 'groups', g.name);
  fs.mkdirSync(dir, { recursive: true });
  const done = readParts(dir, sha, g.scoped);
  const scenario = groupScenario(g);
  const order = new Map(scenario.steps.map((st, i) => [st.id, i]));
  const todo = [...g.ids].filter((id) => !done.mutants.has(id) || (o.retryErrors && done.mutants.get(id).verdict === 'ERROR')).sort((x, y) => order.get(x.split('/')[1]) - order.get(y.split('/')[1]));
  if (!todo.length) return [];
  const scenarioFile = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 1) + '\n');
  let n = fs.readdirSync(dir).filter((x) => /^part-\d+$/.test(x) || /^ids-\d+\.json$/.test(x)).map((x) => Number(/\d+/.exec(x)[0])).reduce((a, x) => Math.max(a, x), 0);
  const tasks = [];
  for (let i = 0; i < todo.length; i += o.chunk) {
    n++;
    const ids = todo.slice(i, i + o.chunk);
    fs.writeFileSync(path.join(dir, 'ids-' + n + '.json'), JSON.stringify(ids) + '\n');
    tasks.push({ g, dir, n, ids, scenarioFile });
  }
  return tasks;
}

function runTask(t, o) {
  const { g, dir, n, ids, scenarioFile } = t;
  // mutate.js applies the probe's environment and mode (lib/probe-env.js).
  const env = { ...process.env };
  const argv = [path.join(__dirname, 'mutate.js'), '--scenario', scenarioFile, '--operators', OPERATORS.join(','), '--ids-file', path.join(dir, 'ids-' + n + '.json'),
    '--rounds', String(o.rounds), '--backend-cmd', o.cmd, '--out', path.join(dir, 'part-' + n), ...(g.scoped ? ['--scoped'] : [])];
  return new Promise((resolve) => {
    const log = fs.openSync(path.join(dir, 'part-' + n + '.log'), 'w');
    const t0 = Date.now();
    console.log('START', g.name + '#' + n, ids.length, 'mutants');
    const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: ['ignore', log, log] });
    child.on('exit', (code) => { console.log('DONE ', g.name + '#' + n, 'exit', code, ((Date.now() - t0) / 1000).toFixed(0) + 's'); resolve({ g, code }); });
  });
}

// Recomputes the verdict of every saved non-OK mutant and control from its
// raw records with the current effect comparison (lib/mutate-effects.js), so
// a comparator fix does not need a re-run. An OK mutant has no records and
// stays OK (a fix that only merges effects cannot turn OK into anything else).
// The first rejudge keeps the original as summary.orig.json.
function rejudge(o, groups, sha) {
  const { verdict } = require('./lib/mutate-effects');
  let changed = 0;
  for (const g of groups) {
    const dir = path.join(o.out, 'groups', g.name);
    if (!fs.existsSync(path.join(dir, 'scenario.json'))) continue;
    const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
    const harnessSteps = new Set(scenario.steps.filter((st) => st.column).map((st) => st.id));
    const judged = (side) => ({ ...side, records: side.records.filter((rec) => !harnessSteps.has(rec.id)) });
    for (const part of fs.readdirSync(dir).filter((x) => /^part-\d+$/.test(x))) {
      const f = path.join(dir, part, 'summary.json');
      if (!fs.existsSync(f)) continue;
      const sum = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (sum.meta.backendSha256 !== sha) continue;
      const load = (label) => { const p = path.join(dir, part, 'records', label + '.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
      const sideOf = (r, which, brief) => ({ errors: [], timeouts: [], unregistered: [], ...brief, records: r[which], files: (r.files || {})[which] || [] });
      const controls = {};
      for (const c of sum.controls) {
        const idx = scenario.steps.findIndex((st) => st.id === c.stepId);
        const r = load('control-' + String(idx).padStart(3, '0') + (c.continued ? '-cont' : ''));
        if (!r) continue;
        const v = verdict(judged(sideOf(r, 'oracle', c.oracle)), judged(sideOf(r, 'go', c.go)), null);
        controls[c.stepId + '\u0000' + c.continued] = v;
        if (v.verdict !== c.verdict) { c.verdictBefore = c.verdictBefore || c.verdict; c.verdict = v.verdict; c.more = v.more; changed++; }
      }
      for (const m of sum.mutants) {
        if (m.verdict === 'OK' || m.verdict === 'REJECTED') continue;
        const r = load(m.label);
        if (!r) continue;
        const control = controls[m.stepId + '\u0000' + m.continued] || null;
        const v = verdict(judged(sideOf(r, 'oracle', m.oracle)), judged(sideOf(r, 'go', m.go)), control);
        // A failure whose confirmation run (mutate.js) is on disk and does
        // not fail is FLAKY, as the run judged it.
        const r2 = v.verdict === 'TIER-B-FAIL' && load(m.label + '-confirm');
        if (r2 && verdict(judged(sideOf(r2, 'oracle', m.oracle)), judged(sideOf(r2, 'go', m.go)), control).verdict !== 'TIER-B-FAIL') v.verdict = 'FLAKY';
        if (v.verdict !== m.verdict || JSON.stringify(v.more) !== JSON.stringify(m.more)) {
          m.verdictBefore = m.verdictBefore || m.verdict;
          Object.assign(m, { verdict: v.verdict, attributable: v.attributable, more: v.more, lessCount: v.less.length, less: v.less.slice(0, 20) });
          changed++;
        }
      }
      if (!fs.existsSync(path.join(dir, part, 'summary.orig.json'))) fs.copyFileSync(f, path.join(dir, part, 'summary.orig.json'));
      fs.writeFileSync(f, JSON.stringify(sum, null, 1) + '\n');
    }
  }
  console.log('REJUDGE changed', changed, 'verdicts');
}

async function pool(items, jobs, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const worst = (vs) => vs.reduce((a, v) => (RANK[v] > (RANK[a] || 0) ? v : a), null);

// First extra effect's step for a failing mutant: from its `more` list.
const failAt = (m) => [...new Set((m.more || []).map((x) => x.at))];

// Pairs each extra effect with the oracle's missing effect of the same kind
// and table that differs in the fewest fields (rows flattened, JSON text
// included). A paired extra is the same write with other values; an unpaired
// one is a write the oracle never made.
function flat(v, pre = '', out = {}) {
  if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) flat(x, pre ? (k === '<json-text>' ? pre : pre + '.' + k) : k, out); }
  else out[pre] = JSON.stringify(v);
  return out;
}
function pairDiff(more, less) {
  const used = new Set();
  return (more || []).map((x) => {
    const body = (e) => { if (e.row !== undefined) return e.row; const { at, k, table, ...rest } = e; return rest; };
    const fx = flat(body(x));
    let best = null;
    (less || []).forEach((y, i) => {
      if (used.has(i) || y.k !== x.k || y.table !== x.table || (x.col && y.col !== x.col)) return;
      const fy = flat(body(y));
      const keys = [...new Set([...Object.keys(fx), ...Object.keys(fy)])].filter((k) => fx[k] !== fy[k]);
      if (!best || keys.length < best.keys.length) best = { i, keys };
    });
    const tag = x.table || x.fn || x.topic || x.k;
    if (best && best.keys.length <= 3) { used.add(best.i); return { at: x.at, effect: x.k + ' ' + tag + (x.col ? '.' + x.col : ''), differs: best.keys }; }
    return { at: x.at, effect: x.k + ' ' + tag + (x.col ? '.' + x.col : ''), extra: true };
  });
}

function report(o, checks, groups, sha, wallMs) {
  const results = new Map(), overhead = new Map();
  for (const g of groups) {
    const parts = readParts(path.join(o.out, 'groups', g.name), sha, g.scoped);
    for (const [id, m] of parts.mutants) results.set(g.name + '\u0000' + id, { ...m, group: g.name });
    const ms = parts.parts.reduce((a, p) => a + (p.meta.prefixMs || 0), 0) + parts.controls.reduce((a, c) => a + (c.oracle.ms || 0) + (c.go.ms || 0), 0);
    overhead.set(g.name, { ms, controls: parts.controls });
  }
  const byIds = (row, id) => (row.groups || []).map((g) => results.get(g + '\u0000' + id)).filter(Boolean);
  // A column mutant is vacuous when the prefix snapshot before its step has
  // no row (blank variants) or no non-NULL value (the others) to rewrite.
  const vacuous = new Set();
  for (const g of groups) {
    const sc = groupScenario(g);
    const dir = path.join(o.out, 'groups', g.name);
    sc.steps.forEach((st, i) => {
      if (!st.column) return;
      const snap = fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^part-\d+$/.test(d)).map((d) => path.join(dir, d, 'snap-' + String(i).padStart(3, '0') + '.db')).find((f) => fs.existsSync(f)) : null;
      if (!snap) return;
      let rows = 0, values = 0;
      try {
        const db = new DatabaseSync(snap, { readOnly: true });
        const q = (x) => '"' + String(x).replace(/"/g, '""') + '"';
        const r = db.prepare('SELECT count(*) AS rows, count(' + q(st.column.column) + ') AS vals FROM ' + q(st.column.table)).get();
        rows = r.rows; values = r.vals;
        db.close();
      } catch { return; }
      for (const id of g.ids) {
        if (!id.startsWith(g.scenario.name + '/' + st.id + '/')) continue;
        const blank = /\/only-[a-z]+$/.test(id);
        if (blank ? rows === 0 : values === 0) vacuous.add(g.name + '\u0000' + id);
      }
    });
  }
  const rows = [];
  for (const c of checks) {
    const all = c.mutantIds.flatMap((id) => byIds(c, id));
    // Only an OK can be vacuous: a boot from the snapshot may fill the column
    // on one side (Node-RED's installation helper does), so a flag stays.
    const isVacuous = (m) => m.verdict === 'OK' && vacuous.has(m.group + '\u0000' + m.id);
    const empty = all.filter(isVacuous);
    const ms = all.filter((m) => !isVacuous(m));
    const counts = {};
    for (const m of ms) counts[m.verdict] = (counts[m.verdict] || 0) + 1;
    const fails = ms.filter((m) => m.verdict === 'TIER-B-FAIL');
    const over = (c.groups || []).map((g) => overhead.get(g) || {});
    const runtime = ms.reduce((a, m) => a + (m.oracle.ms || 0) + (m.go.ms || 0), 0) + over.reduce((a, x) => a + (x.ms || 0), 0);
    const verdicts = ms.map((m) => m.verdict);
    const covered = verdicts.some((v) => v === 'OK' || v === 'LOGGED' || v === 'FLAKY' || v === 'TIER-B-FAIL');
    const controls = over.flatMap((x) => x.controls || []).map((x) => x.stepId + ':' + x.verdict);
    rows.push({ ...c, planned: c.mutantIds.length * Math.max(1, (c.groups || []).length), ran: all.length, vacuous: empty.length, counts, verdict: c.source === 'no-probe' ? 'NO-PROBE' : c.source === 'skip' ? 'SKIP' : !c.mutantIds.length ? 'NOT-COVERED' : !all.length ? 'NOT-RUN' : !ms.length ? 'NOT-COVERED' : worst(verdicts),
      covered, controls: [...new Set(controls)],
      ...(fails.length && !fails.some((m) => m.attributable !== false) ? { verdictNote: 'base' } : {}), attributableFails: fails.filter((m) => m.attributable !== false).length, baseFails: fails.filter((m) => m.attributable === false).length,
      failures: fails.map((m) => ({ id: m.id, attributable: m.attributable !== false, at: failAt(m), diff: pairDiff(m.more, m.less), more: m.more, less: m.less, lessCount: m.lessCount, group: m.group, label: m.label, part: m.part })),
      runtimeS: Math.round(runtime / 1000) });
  }
  const uniqueFails = new Map();
  for (const r of rows) for (const f of r.failures) {
    const k = f.group + '\u0000' + f.id;
    if (!uniqueFails.has(k)) uniqueFails.set(k, { ...f, rows: [] });
    uniqueFails.get(k).rows.push(r.key);
  }
  const out = { meta: { generatedAt: new Date().toISOString(), backendCmd: o.cmd, backendSha256: sha, quick: o.quick, depth: o.depth, rounds: o.rounds,
    harnessHead: execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(), inventory: o.inventory, wallS: Math.round(wallMs / 1000), operators: OPERATORS },
  rows, failures: [...uniqueFails.values()] };
  fs.writeFileSync(path.join(o.out, 'inventory-mutation.json'), JSON.stringify(out, null, 1) + '\n');
  fs.writeFileSync(path.join(o.out, 'REPORT-TABLE.md'), table(out));
  return out;
}

const cell = (s) => String(s == null || s === '' ? '—' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
function table(out) {
  const L = [];
  L.push('| Row | Check | Probe | Source | Operators | Mutants | OK | LOGGED | TIER-B-FAIL | Other | Verdict | s |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of out.rows) {
    const other = Object.entries(r.counts).filter(([k]) => !['OK', 'LOGGED', 'TIER-B-FAIL'].includes(k)).map(([k, v]) => k + ' ' + v)
      .concat(r.vacuous ? ['vacuous ' + r.vacuous] : []).join(', ');
    const fail = r.counts['TIER-B-FAIL'] ? r.counts['TIER-B-FAIL'] + (r.baseFails ? ' (' + r.baseFails + ' base)' : '') : '';
    L.push(`| ${cell(r.row)} | ${cell(r.key)} | ${cell((r.probe || '').replace(/^edge\/harness\/scenarios\//, ''))} | ${cell(r.source)}${r.columns.length ? ' + ' + r.columns.length + ' col' : ''} | ${cell(r.operators && r.operators.join(', '))} | ${r.ran}/${r.planned} | ${r.counts.OK || ''} | ${r.counts.LOGGED || ''} | ${fail} | ${cell(other)} | ${r.verdict}${r.verdictNote ? ' (' + r.verdictNote + ')' : ''} | ${r.runtimeS} |`);
  }
  L.push('');
  return L.join('\n');
}

async function main() {
  const o = args(process.argv.slice(2));
  const t0 = Date.now();
  const { checks, groups } = plan(o);
  if (o.list) {
    for (const c of checks) {
      console.log(`${String(c.row ?? '-').padStart(3)} ${c.key.padEnd(46)} ${(c.source + (c.depth ? '@' + c.depth : '')).padEnd(11)} mutants ${String(c.mutantIds.length).padStart(4)}  sites ${(c.sites || []).length}  ${(c.operators || []).join(',')}${c.columns.length ? '  columns ' + c.columns.join(' ') : ''}`);
    }
    const total = groups.reduce((a, g) => a + g.ids.size, 0);
    console.log('GROUPS', groups.length, 'MUTANTS', total, 'CHECKS', checks.length, 'NOT COVERED', checks.filter((c) => !c.mutantIds.length).length);
    return;
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(fs.realpathSync(o.cmd))).digest('hex');
  fs.mkdirSync(o.out, { recursive: true });
  const prev = path.join(o.out, 'wall.json');
  let wall = 0; try { wall = JSON.parse(fs.readFileSync(prev, 'utf8')).ms || 0; } catch { /* first run */ }
  if (!o.reportOnly) {
    // Largest groups first, so the pool's tail is short.
    const tasks = [...groups].sort((a, b) => b.ids.size - a.ids.size).flatMap((g) => tasksOf(g, o, sha));
    console.log('TASKS', tasks.length, 'mutants', tasks.reduce((a, t) => a + t.ids.length, 0), 'jobs', o.jobs);
    await pool(tasks, o.jobs, (t) => runTask(t, o));
    wall += Date.now() - t0;
    fs.writeFileSync(prev, JSON.stringify({ ms: wall }) + '\n');
  }
  if (o.rejudge) rejudge(o, groups, sha);
  const out = report(o, checks, groups, sha, wall);
  const totals = {};
  for (const r of out.rows) for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] || 0) + v;
  console.log('ROWS', out.rows.length, 'covered', out.rows.filter((r) => r.covered).length, 'mutant verdicts (per row)', JSON.stringify(totals), 'unique failures', out.failures.length,
    '->', path.join(o.out, 'REPORT-TABLE.md'));
  process.exitCode = out.failures.length || totals.ERROR ? 1 : 0;
}

if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 2; });
module.exports = { plan, table };
