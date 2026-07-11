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
const { bootstrapFresh } = require('../lib/osi-migrate');
const { syncFingerprints } = require('../lib/osi-migrate/runner');
const { ensureLedger, successInsertSql } = require('../lib/osi-migrate/ledger');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { snapshotSchema, compareSchemas, FAILING_CLASSES } = require('./semantic-schema-compare');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const APP_VERSION = 'baseline-existing-db';

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

async function buildReference(migrationsDir, n, scratchRoot) {
  const dir = fs.mkdtempSync(path.join(scratchRoot, `ref-${String(n).padStart(4, '0')}-`));
  const subset = path.join(dir, 'migrations');
  fs.mkdirSync(subset);
  for (const f of fs.readdirSync(migrationsDir)) {
    if (!/^\d{4}__[a-z0-9_]+\.sql$/.test(f)) continue;
    if (Number(f.slice(0, 4)) <= n) fs.copyFileSync(path.join(migrationsDir, f), path.join(subset, f));
  }
  const dbPath = path.join(dir, 'reference.db');
  await bootstrapFresh(cliRunner(dbPath), { migrationsDir: subset, appVersion: 'stage0-reference' });
  return dbPath;
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
  const headSnap = await snapshotSchema(cliRunner(await buildReference(migrationsDir, head, scratchRoot)));

  const candidates = version !== null ? [version] : Array.from({ length: head }, (_, i) => head - i);
  const tried = [];
  let matched = null;
  for (const n of candidates) {
    const refSnap = n === head
      ? headSnap
      : await snapshotSchema(cliRunner(await buildReference(migrationsDir, n, scratchRoot)));
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
