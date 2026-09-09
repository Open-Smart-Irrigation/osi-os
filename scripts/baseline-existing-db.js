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
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh, applyPending } = require('../lib/osi-migrate');
const { syncFingerprints } = require('../lib/osi-migrate/runner');
const { ensureLedger, successInsertSql } = require('../lib/osi-migrate/ledger');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { snapshotSchema, compareSchemas, FAILING_CLASSES } = require('./semantic-schema-compare');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const APP_VERSION = 'baseline-existing-db';

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
// Memoized at module scope (keyed by resolved migrationsDir) because the
// chain is a pure function of the migration files on disk: safe to reuse
// across multiple runBaseline()/buildReference() calls within one process
// run (e.g. the whole test file), and a no-op difference for the normal
// CLI path, which only ever calls runBaseline() once per process.
const referenceChains = new Map();

function getChainState(migrationsDir, scratchRoot) {
  const key = path.resolve(migrationsDir);
  let state = referenceChains.get(key);
  if (!state) {
    const dir = fs.mkdtempSync(path.join(scratchRoot, 'ref-chain-'));
    const subset = path.join(dir, 'migrations');
    fs.mkdirSync(subset);
    state = {
      dir,
      subset,
      workingDb: path.join(dir, 'working.db'),
      files: fs.readdirSync(migrationsDir)
        .filter((f) => /^\d{4}__[a-z0-9_]+\.sql$/.test(f))
        .sort(),
      bootstrapped: false,
      nextIdx: 0,
      byVersion: new Map(), // version -> { dbPath, snap }
      chain: Promise.resolve(),
    };
    referenceChains.set(key, state);
  }
  return state;
}

// Extends the shared chain to cover every migration <= n that isn't already
// built, applying only the newly-reached ones. Serialized on state.chain so
// concurrent callers for the same migrationsDir can't race the one working DB.
function ensureReferenceUpTo(migrationsDir, n, scratchRoot) {
  const state = getChainState(migrationsDir, scratchRoot);
  state.chain = state.chain.then(async () => {
    const runner = cliRunner(state.workingDb);
    while (state.nextIdx < state.files.length) {
      const f = state.files[state.nextIdx];
      const version = Number(f.slice(0, 4));
      if (version > n) break;
      fs.copyFileSync(path.join(migrationsDir, f), path.join(state.subset, f));
      if (!state.bootstrapped) {
        await bootstrapFresh(runner, { migrationsDir: state.subset, appVersion: 'stage0-reference' });
        state.bootstrapped = true;
      } else {
        await applyPending(runner, { migrationsDir: state.subset, appVersion: 'stage0-reference', writersStopped: true });
      }
      const snap = await snapshotSchema(runner);
      const savedPath = path.join(state.dir, `ref-${f.slice(0, 4)}.db`);
      fs.copyFileSync(state.workingDb, savedPath);
      state.byVersion.set(version, { dbPath: savedPath, snap });
      state.nextIdx += 1;
    }
  });
  return state.chain;
}

// Reference(N) snapshot, built (or reused) via the shared incremental chain.
async function referenceSnapshot(migrationsDir, n, scratchRoot) {
  await ensureReferenceUpTo(migrationsDir, n, scratchRoot);
  return getChainState(migrationsDir, scratchRoot).byVersion.get(n).snap;
}

function loadManifest(migrationsDir) {
  const p = path.join(migrationsDir, 'CHECKSUMS.json');
  if (!fs.existsSync(p)) throw new Error(`checksum manifest missing: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function assertManifestMatchesDisk(migrations, manifest) {
  const migrationNames = new Set(migrations.map((m) => m.name));
  for (const m of migrations) {
    if (manifest[m.name] !== m.checksum) {
      throw new Error(`checksum manifest mismatch for ${m.name}: this checkout's migration files diverge from CHECKSUMS.json - refusing to baseline anything`);
    }
  }
  for (const filename of Object.keys(manifest)) {
    if (!migrationNames.has(filename)) {
      throw new Error(`checksum manifest has no migration file for ${filename} - refusing to baseline anything`);
    }
  }
}

// reference(N): a DB with exactly migrations 1..n applied (same runner calls,
// same fingerprint stamping as a real bootstrap - see the chain cache above).
// Backed by the shared incremental chain, so repeat calls for a version
// already reached (by this call or an earlier one, e.g. while computing
// head) are a cache hit, not a rebuild. External contract unchanged: still
// takes (migrationsDir, n, scratchRoot) and returns a dbPath.
async function buildReference(migrationsDir, n, scratchRoot) {
  await ensureReferenceUpTo(migrationsDir, n, scratchRoot);
  return getChainState(migrationsDir, scratchRoot).byVersion.get(n).dbPath;
}

function summarize(diffs) {
  return diffs.map((d) => `${d.class}:${d.kind}:${d.name}`).join(', ') || 'none';
}

function printDiffs(log, label, diffs) {
  log(`[baseline] ${label}:`);
  for (const d of diffs) log(`  [${d.class}] ${d.kind} ${d.name} - ${d.detail}`);
}

async function stamp(dbPath, migrations, manifest, n) {
  const runner = cliRunner(dbPath);
  await ensureLedger(runner);
  const inserts = migrations
    .filter((m) => m.version <= n)
    .map((m) => successInsertSql({
      version: m.version,
      name: m.name,
      checksum: manifest[m.name],
      appVersion: APP_VERSION,
      backupPath: '',
    }));
  await runner.exec(`BEGIN IMMEDIATE;\n${inserts.join('\n')}\nCOMMIT;`);
  await syncFingerprints(runner);
}

async function runBaseline({ dbPath, version = null, report = false, migrationsDir = DEFAULT_MIGRATIONS_DIR, log = console.error }) {
  if (!dbPath) throw new Error('usage: baseline-existing-db.js <path-to-farming.db> [--version N] [--report]');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  const migrations = loadMigrations(migrationsDir);
  if (migrations.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);
  const manifest = loadManifest(migrationsDir);
  assertManifestMatchesDisk(migrations, manifest);
  const head = migrations[migrations.length - 1].version;
  if (version !== null && (!Number.isInteger(version) || version < 1 || version > head)) {
    throw new Error(`--version must be an integer in 1..${head}`);
  }

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-baseline-'));
  const liveSnap = await snapshotSchema(cliRunner(dbPath));
  const headSnap = await referenceSnapshot(migrationsDir, head, scratchRoot);

  const candidates = version !== null ? [version] : Array.from({ length: head }, (_, i) => head - i);
  const tried = [];
  let matched = null;
  for (const n of candidates) {
    const refSnap = n === head
      ? headSnap
      : await referenceSnapshot(migrationsDir, n, scratchRoot);
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
  await stamp(dbPath, migrations, manifest, matched);
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

module.exports = { runBaseline, buildReference, parseArgs, APP_VERSION };
