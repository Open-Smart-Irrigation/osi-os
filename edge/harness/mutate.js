#!/usr/bin/env node
'use strict';
// Tier-B mutation pass (CHARTER.md §1.4 point 4). See MUTATION.md.
//   node edge/harness/mutate.js --scenario FILE [--scoped] --backend-cmd "BIN" --out DIR
//        [--operators a,b] [--steps id,id] [--sites REGEX] [--ids REGEX] [--ids-file FILE] [--limit N]
//        [--continue sql|all|none] [--ticks a,b] [--rounds N] [--no-control] [--no-confirm] [--keep] [--list]
// For each selected mutant: boot Node-RED and the backend on the oracle's
// snapshot from just before the mutated step, run the mutated step (plus the
// remaining steps for sql setup mutants), run the quiescence ticks, and
// compare effects. Verdicts: TIER-B-FAIL (Go did more), LOGGED (only status,
// body, missing effects or timeouts differ), OK, ERROR (no verdict possible),
// REJECTED (the schema refused the mutated sql setup).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { loadOperators } = require('./lib/mutate-ops');
const { mutantsOf } = require('./lib/mutate-sites');
const { runSide, prefixPass } = require('./lib/mutate-backend');
const { probeEnv } = require('./lib/probe-env');
const { verdict, effectsOf, minus, stable, denumber } = require('./lib/mutate-effects');
const { view } = require('./lib/compare');
const { make } = require('./lib/normalize');
const ROOT = path.resolve(__dirname, '../..');
const TIMERS = require('./timers.json');

// Quiescence tick families (oracle inject names in timers.json). The ticks a
// scenario itself drives come first, then valve, then sync.
const VALVE_TICKS = ['valve-once-tick', 'valve-clock-tick', 'valve-observe-tick', 'strega-reconciliation-tick', 'conditional-due-tick'];
const SYNC_TICKS = ['sync-outbox-flush', 'sync-history-batch', 'sync-history-manifest', 'sync-pending-commands', 'command-ack-flush',
  'sync-token-refresh', 'sync-bootstrap', 'journal-v2-replication'];

function args(argv) {
  const o = { scoped: false, continue: 'sql', rounds: 3, control: true, keep: false, list: false, confirm: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--scenario') o.scenario = path.resolve(next());
    else if (a === '--backend-cmd') o.cmd = next().split(/\s+/).filter(Boolean);
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--scoped') o.scoped = true;
    else if (a === '--operators') o.operators = next().split(',');
    else if (a === '--steps') o.steps = next().split(',');
    else if (a === '--sites') o.sites = new RegExp(next());
    else if (a === '--ids') o.ids = new RegExp(next());
    else if (a === '--ids-file') o.idsFile = new Set(JSON.parse(fs.readFileSync(path.resolve(next()), 'utf8')));
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--continue') o.continue = next();
    else if (a === '--ticks') o.ticks = next().split(',').filter(Boolean);
    else if (a === '--rounds') o.rounds = Number(next());
    else if (a === '--no-control') o.control = false;
    else if (a === '--no-confirm') o.confirm = false;
    else if (a === '--keep') o.keep = true;
    else if (a === '--list') o.list = true;
    else throw new Error('unknown argument ' + a);
  }
  if (!o.scenario) throw new Error('--scenario is required');
  if (!o.list && (!o.cmd || !o.out)) throw new Error('--backend-cmd and --out are required');
  if (!['sql', 'all', 'none'].includes(o.continue)) throw new Error('--continue is sql, all or none');
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

function ticksFor(scenario, o) {
  if (o.ticks) return o.ticks;
  const declared = [...new Set(scenario.steps.filter((s) => s.timer).map((s) => s.timer))];
  return [...new Set([...declared, ...VALVE_TICKS, ...SYNC_TICKS])].filter((t) => TIMERS[t]);
}

const continues = (mutantOrContainer, o) => {
  if (typeof mutantOrContainer === 'object' && mutantOrContainer.rest && o.continue !== 'none') return true;
  const c = typeof mutantOrContainer === 'string' ? mutantOrContainer : mutantOrContainer.container;
  return o.continue === 'all' || (o.continue === 'sql' && (c === 'sql' || c === 'sql-json' || c === 'sql-column'));
};
// The steps after a mutant: a carried value's rewritten rest, or the scenario's.
const restOf = (m, scenario, o) => (!continues(m, o) ? [] : m.rest || scenario.steps.slice(m.stepIndex + 1));

// The control's oracle record for the step against the continuous prefix
// pass: differences show what a restart from the snapshot loses (in-memory
// flow context).
function fidelity(prefixRec, controlRec) {
  if (!prefixRec || !controlRec) return { same: false, why: 'missing record' };
  const a = effectsOf([prefixRec]), b = effectsOf([controlRec]);
  const n1 = make(), n2 = make();
  const va = view(prefixRec, n1), vb = view(controlRec, n2);
  const ra = denumber({ status: va.status, body: va.body }), rb = denumber({ status: vb.status, body: vb.body });
  const onlyPrefix = minus(a, b).map((x) => x.key), onlyControl = minus(b, a).map((x) => x.key);
  const same = !onlyPrefix.length && !onlyControl.length && stable(ra) === stable(rb);
  return same ? { same } : { same, onlyPrefix, onlyControl, response: stable(ra) === stable(rb) ? 'same' : { prefix: ra, control: rb } };
}

function brief(side) {
  return { ms: side.ms, bootMs: side.bootMs, errors: side.errors, timeouts: side.timeouts, unregistered: side.unregistered,
    tickErrors: side.tickErrors, sqlRejected: side.sqlRejected };
}

async function main() {
  const o = args(process.argv.slice(2));
  const scenario = JSON.parse(fs.readFileSync(o.scenario, 'utf8'));
  // The probe's recording environment (lib/probe-env.js) on both sides: the
  // oracle wrapper for the prefix pass and the oracle side, the same variable
  // change for the backend, and scoped mode for a probe recorded only scoped
  // (a probe recorded both ways runs in the mode --scoped picks). A caller's
  // OSI_ORACLE_NODE stays the Node the wrapper runs.
  const env = probeEnv(scenario.name);
  if (env.scoped) o.scoped = true;
  if (env.oracleNode) {
    if (process.env.OSI_ORACLE_NODE && !process.env.OSI_ORACLE_NODE_REAL) process.env.OSI_ORACLE_NODE_REAL = process.env.OSI_ORACLE_NODE;
    process.env.OSI_ORACLE_NODE = env.oracleNode;
  }
  const operators = loadOperators(o.operators);
  // With --ids-file, only the sites those ids name are expanded.
  let keep = null;
  if (o.idsFile) {
    const prefixes = new Set();
    for (const id of o.idsFile) for (let i = id.indexOf('/'); i !== -1; i = id.indexOf('/', i + 1)) prefixes.add(id.slice(0, i + 1));
    keep = (site, step) => prefixes.has([scenario.name, step.id, site.label].join('/') + '/');
  }
  const all = mutantsOf(scenario, operators, { columnsOf: columnsReader(), keep });
  let selected = all.filter((m) => (!o.steps || o.steps.includes(m.stepId)) && (!o.sites || o.sites.test(m.site)) && (!o.ids || o.ids.test(m.id)) && (!o.idsFile || o.idsFile.has(m.id)));
  if (o.limit) selected = selected.slice(0, o.limit);
  if (o.list) { for (const m of selected) console.log(m.id); console.log('MUTANTS', selected.length, 'of', all.length); return; }
  if (scenario.cloud === true) console.log('NOTE scenario uses the cloud broker (Podman required)');
  if (env.profile || o.scoped) console.log('PROBE ENV', env.profile || 'default', o.scoped ? 'scoped' : 'legacy');
  fs.mkdirSync(o.out, { recursive: true });
  const t0 = Date.now();
  const ticks = ticksFor(scenario, o);
  const wanted = new Set(selected.map((m) => m.stepIndex));
  // `env -u NAME BIN` runs the backend without a variable (the noapp probes).
  const binary = fs.realpathSync(o.cmd[0] === 'env' ? o.cmd[o.cmd.length - 1] : o.cmd[0]);
  const meta = { scenario: path.relative(ROOT, o.scenario), scenarioName: scenario.name, scoped: o.scoped, probeEnv: env.profile, backendCmd: o.cmd.join(' '),
    backendSha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    harnessHead: execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
    operators: operators.map((x) => x.name), ticks, rounds: o.rounds, continue: o.continue,
    generated: all.length, selected: selected.length, startedAt: new Date(t0).toISOString() };
  console.log('MUTATE', meta.scenarioName, 'mutants', selected.length, 'of', all.length, 'at', wanted.size, 'steps; ticks', ticks.join(','));
  const summary = { meta, controls: [], mutants: [], fidelity: [] };
  const write = () => fs.writeFileSync(path.join(o.out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  if (!selected.length) { write(); return; }

  const prefix = await prefixPass({ scenario, wanted, dir: o.out, scoped: o.scoped, cloud: scenario.cloud === true, keep: o.keep });
  meta.prefixMs = prefix.ms;
  console.log('PREFIX', (prefix.ms / 1000).toFixed(1), 's');
  const work = path.join(o.out, 'work');
  const recordsDir = path.join(o.out, 'records');
  fs.mkdirSync(recordsDir, { recursive: true });
  let n = 0;
  // A column step (inventory-mutate.js) is harness input: its own row changes
  // are left out of the verdict. They differ between the sides whenever the
  // boot from the snapshot changed that column on one side only.
  const harnessSteps = new Set(scenario.steps.filter((s) => s.column).map((s) => s.id));
  const judged = (side) => (harnessSteps.size ? { ...side, records: side.records.filter((rec) => !harnessSteps.has(rec.id)) } : side);
  const run = async (label, steps, snap) => {
    // Both sides expand the scenario's date tokens from the instant this
    // control or mutant starts, so a time-relative literal is the same text.
    const common = { snapshot: snap.db, steps, vars: snap.vars, ticks, rounds: o.rounds, scoped: o.scoped, cloud: scenario.cloud === true,
      scenarioName: scenario.name, keep: o.keep, anchorMs: Date.now() };
    const oracle = await runSide({ ...common, side: 'oracle', run: path.join(work, label + '-oracle') });
    const go = await runSide({ ...common, side: 'go', goCmd: o.cmd, goEnv: env.goEnv, run: path.join(work, label + '-go') });
    return { oracle, go };
  };
  const saveRecords = (label, r) => fs.writeFileSync(path.join(recordsDir, label + '.json'),
    JSON.stringify({ oracle: r.oracle.records, go: r.go.records, files: { oracle: r.oracle.files, go: r.go.files } }) + '\n');

  for (const stepIndex of [...wanted].sort((a, b) => a - b)) {
    const snap = prefix.snaps[stepIndex];
    const original = scenario.steps[stepIndex];
    const atStep = selected.filter((m) => m.stepIndex === stepIndex);
    const modes = [...new Set(atStep.map((m) => continues(m, o)))];
    const controls = {};
    for (const cont of modes) {
      const rest = cont ? scenario.steps.slice(stepIndex + 1) : [];
      if (!o.control) { controls[cont] = null; continue; }
      const label = 'control-' + String(stepIndex).padStart(3, '0') + (cont ? '-cont' : '');
      let r = await run(label, [original, ...rest], snap);
      let v = verdict(judged(r.oracle), judged(r.go), null);
      let flaky = false;
      // Confirmation: see the mutant loop below. A control that fails once
      // and not again is replaced by its re-run.
      if (o.confirm && v.verdict === 'TIER-B-FAIL') {
        saveRecords(label + '-first', r);
        const r2 = await run(label + '-confirm', [original, ...rest], snap);
        const v2 = verdict(judged(r2.oracle), judged(r2.go), null);
        if (v2.verdict !== 'TIER-B-FAIL') { r = r2; v = v2; flaky = true; }
      }
      saveRecords(label, r);
      controls[cont] = v;
      const prefixRec = prefix.records.find((x) => x.id === scenario.name + '/' + original.id) || prefix.records[stepIndex];
      summary.fidelity.push({ stepId: original.id, ...fidelity(prefixRec, r.oracle.records[0]) });
      summary.controls.push({ stepId: original.id, continued: cont, verdict: v.verdict, ...(flaky && { flaky }), more: v.more, lessCount: v.less.length, less: v.less.slice(0, 20), lessUnported: v.lessUnported.slice(0, 20),
        responseDiffs: v.responseDiffs.length, errors: v.errors, oracle: brief(r.oracle), go: brief(r.go) });
      console.log('CONTROL', v.verdict.padEnd(11), original.id + (cont ? ' (+rest)' : ''), v.more.length ? JSON.stringify(v.more).slice(0, 300) : '');
      write();
    }
    for (const m of atStep) {
      const cont = continues(m, o);
      const rest = restOf(m, scenario, o);
      const label = 'm' + String(++n).padStart(4, '0');
      const r = await run(label, [m.step, ...rest], snap);
      const v = verdict(judged(r.oracle), judged(r.go), controls[cont]);
      // Confirmation: the two sides run seconds apart from a snapshot whose
      // stamps keep ageing, so a time window (a 30 s debounce, a 5-minute
      // cap, a 10-minute grace) can close between the oracle's run and the
      // backend's. A TIER-B-FAIL runs once more; one that does not fail again
      // is FLAKY: listed with both records, not counted as a failure.
      let confirm = null;
      if (o.confirm && v.verdict === 'TIER-B-FAIL') {
        const r2 = await run(label + '-confirm', [m.step, ...rest], snap);
        const v2 = verdict(judged(r2.oracle), judged(r2.go), controls[cont]);
        saveRecords(label + '-confirm', r2);
        confirm = { verdict: v2.verdict, more: v2.more.slice(0, 20), lessCount: v2.less.length };
        if (v2.verdict !== 'TIER-B-FAIL') v.verdict = 'FLAKY';
      }
      // A sql mutant the schema refuses (CHECK, foreign key) never reached a
      // backend: report it apart instead of counting it as OK.
      const rejected = r.oracle.sqlRejected.some((e) => e.startsWith(m.stepId + ':'));
      if (rejected && (v.verdict === 'OK' || v.verdict === 'LOGGED')) v.verdict = 'REJECTED';
      if (v.verdict !== 'OK') saveRecords(label, r);
      summary.mutants.push({ n, label, id: m.id, stepId: m.stepId, site: m.site, operator: m.operator, variant: m.variant, continued: cont,
        carried: Boolean(m.rest && cont), verdict: v.verdict, attributable: v.attributable, ...(confirm && { confirm }), controlVerdict: controls[cont] ? controls[cont].verdict : null,
        more: v.more, lessCount: v.less.length, less: v.less.slice(0, 20), lessUnportedCount: v.lessUnported.length, responseDiffs: v.responseDiffs.slice(0, 5), errors: v.errors,
        oracle: brief(r.oracle), go: brief(r.go) });
      console.log(v.verdict.padEnd(11), (v.attributable === false ? '[base] ' : '') + m.id, v.more.length ? JSON.stringify(v.more).slice(0, 300) : v.less.length ? '(less ' + v.less.length + ')' : '');
      write();
    }
  }
  const totals = {};
  for (const m of summary.mutants) totals[m.verdict] = (totals[m.verdict] || 0) + 1;
  meta.totals = totals;
  meta.seconds = (Date.now() - t0) / 1000;
  meta.unregisteredGoTicks = [...new Set(summary.mutants.flatMap((m) => m.go.unregistered))];
  write();
  if (!o.keep) fs.rmSync(work, { recursive: true, force: true });
  console.log('TOTALS', JSON.stringify(totals), 'in', meta.seconds.toFixed(1), 's ->', path.join(o.out, 'summary.json'));
  process.exitCode = totals['TIER-B-FAIL'] || totals.ERROR ? 1 : 0;
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 2; });
