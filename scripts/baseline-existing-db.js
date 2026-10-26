#!/usr/bin/env node
'use strict';
// baseline-existing-db.js - the second sanctioned schema-bookkeeping tool
// alongside scripts/restamp-fingerprints.js. It stamps a pre-ledger device at
// the highest migration version N whose reference(N) the live schema
// semantically matches, tolerating forward drift and the named allowlist.
//
// Guardrails: refuses a missing DB path; on any gate failure prints classified
// diffs and stamps nothing. It never does DDL, application-data writes,
// backups, or applyPending.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner, nodeSqliteRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh, applyPending } = require('../lib/osi-migrate');
const { syncFingerprints } = require('../lib/osi-migrate/runner');
const { ensureLedger, successInsertSql } = require('../lib/osi-migrate/ledger');
const { loadMigrationCorpus, resolveCorpus, materializeMigrations } = require('../lib/osi-migrate/migrations-loader');
const { snapshotSchema, compareSchemas, FAILING_CLASSES } = require('./semantic-schema-compare');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const APP_VERSION = 'baseline-existing-db';
const PERSISTENT_RUNNER_ENV = 'OSI_BASELINE_RUNNER';
const runnerFactoryIds = new WeakMap();
let nextRunnerFactoryId = 1;

function resolveRunner(options = {}) {
  if (options.runnerFactory) {
    if (!runnerFactoryIds.has(options.runnerFactory)) {
      runnerFactoryIds.set(options.runnerFactory, nextRunnerFactoryId++);
    }
    return { factory: options.runnerFactory, key: `custom-${runnerFactoryIds.get(options.runnerFactory)}` };
  }
  if (process.env[PERSISTENT_RUNNER_ENV] === 'node-sqlite') {
    return { factory: nodeSqliteRunner, key: 'node-sqlite' };
  }
  return { factory: cliRunner, key: 'cli' };
}

// --- Reference chain cache -------------------------------------------------
// The candidate scan below needs reference(N) - "a fresh DB with exactly
// migrations 1..N applied" - for potentially every N from 1..head in one
// runBaseline() call (worst case: nothing matches, or --report walks every
// N). The naive approach rebuilds reference(N) from scratch per candidate,
// which independently replays migrations 1..N through bootstrapFresh() every
// time - O(head) rebuilds, each itself O(N) migrations with the runner's own
// per-migration fingerprint recompute, i.e. an O(head^3)-ish blowup as head
// grows (measured: a single N=45 bootstrap already costs ~107s; a top-down
// scan that reaches low N redoes that cost dozens of times).
//
// Fix: build ONE reference chain per migrationsDir, incrementally - apply
// migration 1, snapshot; apply migration 2, snapshot; ... up to head - reusing
// the SAME growing database and letting applyPending's own "already applied,
// skip" ledger logic do the incremental work. This issues the exact same
// bootstrapFresh()/applyPending() calls (same fingerprint stamping, same
// postflight, same everything) the runner would make for a real bootstrap -
// it just makes each one ONCE instead of redundantly once per candidate.
// Memoized at module scope (keyed by resolved migrationsDir and runner mode)
// because the chain is a pure function of the migration files and runner
// semantics on disk: safe to reuse
// across multiple runBaseline()/buildReference() calls within one process
// run (e.g. the whole test file), and a no-op difference for the normal
// CLI path, which only ever calls runBaseline() once per process.
const referenceChains = new Map();

function getChainState(migrationsDir, scratchRoot, runnerOptions = {}) {
  const corpus = resolveCorpus(migrationsDir, runnerOptions.corpus);
  const runner = resolveRunner(runnerOptions);
  const key = `${corpus.dir}\0${corpus.identity}\0${runner.key}`;
  let state = referenceChains.get(key);
  if (!state) {
    const dir = fs.mkdtempSync(path.join(scratchRoot, 'ref-chain-'));
    state = { dir, corpus, entries: corpus.migrations, workingDb: path.join(dir, 'working.db'),
      bootstrapped: false, nextIdx: 0, byVersion: new Map(), runner: null,
      runnerFactory: runner.factory, chain: Promise.resolve() };
    referenceChains.set(key, state);
  }
  return state;
}

function ensureReferenceUpTo(state, n) {
  const run = state.chain.then(async () => {
    if (!state.runner) state.runner = state.runnerFactory(state.workingDb);
    while (state.nextIdx < state.entries.length) {
      const entry = state.entries[state.nextIdx];
      if (entry.version > n) break;
      const stepRoot = fs.mkdtempSync(path.join(state.dir, 'subset-'));
      const subset = path.join(stepRoot, 'migrations');
      const corpus = materializeMigrations(subset, state.entries.slice(0, state.nextIdx + 1)
        .map((m) => ({ corpus: state.corpus, name: m.name })));
      const opts = { migrationsDir: subset, corpus, appVersion: 'stage0-reference', writersStopped: true };
      if (!state.bootstrapped) { await bootstrapFresh(state.runner, opts); state.bootstrapped = true; }
      else await applyPending(state.runner, opts);
      const snap = await snapshotSchema(state.runner);
      const savedPath = path.join(state.dir, `ref-${String(entry.version).padStart(4, '0')}.db`);
      fs.copyFileSync(state.workingDb, savedPath);
      state.byVersion.set(entry.version, { dbPath: savedPath, snap });
      state.nextIdx++;
    }
  });
  state.chain = run.catch(async () => {
    if (state.runner) await state.runner.close();
    state.runner = null;
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(state.workingDb + suffix, { force: true });
    if (state.nextIdx > 0) fs.copyFileSync(state.byVersion.get(state.entries[state.nextIdx - 1].version).dbPath, state.workingDb);
    state.bootstrapped = state.nextIdx > 0;
  });
  return run;
}

async function referenceSnapshot(migrationsDir, n, scratchRoot, runnerOptions = {}) {
  const state = getChainState(migrationsDir, scratchRoot, runnerOptions);
  if (!state.entries.some((m) => m.version === n)) throw new TypeError(`reference version ${n} has no migration file`);
  await ensureReferenceUpTo(state, n);
  return state.byVersion.get(n).snap;
}

// reference(N): a DB with exactly migrations 1..n applied (same runner calls,
// same fingerprint stamping as a real bootstrap - see the chain cache above).
// Backed by the shared incremental chain, so repeat calls for a version
// already reached (by this call or an earlier one, e.g. while computing
// head) are a cache hit, not a rebuild. External contract unchanged: still
// takes (migrationsDir, n, scratchRoot) and returns a dbPath. STRICT: throws
// if n has no migration file (interior gap, or n > the last present
// version) - see the comment above referenceSnapshot() for why (the live
// runner's drift-grace path depends on this).
//
// Callers: reconcile-ledger-numbering.js's buildReferenceAt, runBaseline()
// below, and lib/osi-migrate/runner.js's isBootOwnedTriggerBodyDrift (the
// live runner's drift-grace path, reached from applyPending/verifyHead) -
// the only one of the three that can hand this a version with no file, and
// the reason this function must stay strict rather than resolve gaps
// itself.
async function buildReference(migrationsDir, n, scratchRoot, runnerOptions = {}) {
  const state = getChainState(migrationsDir, scratchRoot, runnerOptions);
  if (!state.entries.some((m) => m.version === n)) throw new TypeError(`reference version ${n} has no migration file`);
  await ensureReferenceUpTo(state, n);
  return state.byVersion.get(n).dbPath;
}

function summarize(diffs) {
  return diffs.map((d) => `${d.class}:${d.kind}:${d.name}`).join(', ') || 'none';
}

function printDiffs(log, label, diffs) {
  log(`[baseline] ${label}:`);
  for (const d of diffs) log(`  [${d.class}] ${d.kind} ${d.name} - ${d.detail}`);
}

async function stamp(dbPath, migrations, n) {
  const runner = cliRunner(dbPath);
  await ensureLedger(runner);
  const inserts = migrations
    .filter((m) => m.version <= n)
    .map((m) => successInsertSql({
      version: m.version,
      name: m.name,
      checksum: m.checksum,
      appVersion: APP_VERSION,
      backupPath: '',
    }));
  await runner.exec(`BEGIN IMMEDIATE;\n${inserts.join('\n')}\nCOMMIT;`);
  await syncFingerprints(runner);
}

async function runBaseline({ dbPath, version = null, report = false, migrationsDir = DEFAULT_MIGRATIONS_DIR, log = console.error, runnerFactory = null }) {
  if (!dbPath) throw new Error('usage: baseline-existing-db.js <path-to-farming.db> [--version N] [--report]');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  const corpus = loadMigrationCorpus(migrationsDir);
  const migrations = corpus.migrations;
  const head = migrations[migrations.length - 1].version;
  if (version !== null && (!Number.isInteger(version) || version < 1 || version > head)) {
    throw new Error(`--version must be an integer in 1..${head}`);
  }
  // buildReference/referenceSnapshot are strict (see their comments): every
  // version reaching them must be a real migration file. head, above, always
  // is (it's a migration's own .version). An explicit --version must be
  // checked too - the range check alone accepts a gap number (e.g. this
  // branch's own missing 0059) that has no file behind it.
  if (version !== null && !migrations.some((m) => m.version === version)) {
    throw new Error(`--version ${version} has no migration file at that version (gap in ${migrationsDir})`);
  }

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-baseline-'));
  const liveSnap = await snapshotSchema(cliRunner(dbPath));
  const runnerOptions = { runnerFactory, corpus };
  const headSnap = await referenceSnapshot(migrationsDir, head, scratchRoot, runnerOptions);

  // Only scan versions that actually have a migration file. Walking every
  // bare integer down from head (the old behaviour) hit referenceSnapshot()
  // with version numbers that fall in a gap (e.g. this branch's own missing
  // 0059) and, before the resolvePresentVersion() fix above existed, threw;
  // scanning real versions only also avoids reporting a "matched" version
  // number that isn't backed by any file, and avoids redundant duplicate
  // comparisons against the same resolved snapshot. On a contiguous tree
  // (main) this is exactly [head, head-1, ..., 1] - identical to before.
  const candidates = version !== null ? [version] : migrations.map((m) => m.version).slice().reverse();
  const tried = [];
  let matched = null;
  for (const n of candidates) {
    const refSnap = n === head
      ? headSnap
      : await referenceSnapshot(migrationsDir, n, scratchRoot, runnerOptions);
    const res = compareSchemas(liveSnap, refSnap, headSnap);
    tried.push({ n, res });
    const failing = res.diffs.filter((d) => FAILING_CLASSES.has(d.class));
    const tolerated = res.diffs.filter((d) => !FAILING_CLASSES.has(d.class));
    log(res.ok
      ? `[baseline] N=${n}: PASS${tolerated.length ? ` (tolerated: ${summarize(tolerated)})` : ''}`
      : `[baseline] N=${n}: FAIL (${failing.length} failing: ${summarize(failing)})`);
    if (res.ok && matched === null) {
      matched = n;
      if (!report) break;
    }
  }
  if (matched === null) {
    const best = tried.slice().sort((a, b) => a.res.failingCount - b.res.failingCount)[0];
    log('[baseline] NO VERSION MATCHES - refusing to stamp.');
    printDiffs(log, `diff at N=${tried[0].n}`, tried[0].res.diffs);
    if (best.n !== tried[0].n) {
      printDiffs(log, `best-scoring candidate N=${best.n} (${best.res.failingCount} failing)`, best.res.diffs);
    }
    return { matched: null, tried };
  }
  if (report) {
    log(`[baseline] report mode: best match N=${matched}; nothing stamped`);
    return { matched, tried };
  }
  await stamp(dbPath, migrations, matched);
  log(`[baseline] stamped versions 1..${matched} (checksums from CHECKSUMS.json, app_version='${APP_VERSION}') and synced fingerprints.`);
  log('[baseline] next: Stage 1 applyPending (writers stopped) carries the device to head.');
  return { matched, tried };
}

function parseArgs(argv) {
  const opts = { dbPath: null, version: null, report: false, migrationsDir: DEFAULT_MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') opts.version = Number(argv[++i]);
    else if (a === '--report') opts.report = true;
    else if (a === '--migrations-dir') opts.migrationsDir = path.resolve(argv[++i] || '');
    else if (!opts.dbPath) opts.dbPath = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

if (require.main === module) {
  (async () => {
    const { matched } = await runBaseline(parseArgs(process.argv.slice(2)));
    process.exit(matched === null ? 1 : 0);
  })().catch((e) => { console.error(`[baseline] FAILED: ${e.message}`); process.exit(2); });
}

module.exports = { runBaseline, buildReference, referenceSnapshot, parseArgs, APP_VERSION };
