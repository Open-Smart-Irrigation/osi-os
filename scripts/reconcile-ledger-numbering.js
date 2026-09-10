#!/usr/bin/env node
'use strict';
// Ledger numbering reconciliation — the ONLY sanctioned recovery path for a
// gateway whose schema_migrations ledger was stamped under a foreign branch's
// version numbering (AgroLink, Bovey/Valve-focused) that now collides with
// main's own numbering. See .superpowers/sdd/stabilization-plan-2026-09-10.md
// §3.5c and .claude/skills/osi-schema-change-control/SKILL.md.
//
// Problem: a foreign-numbered device's schema_migrations rows record
// versions/checksums from ITS OWN migration files. lib/osi-migrate's
// applyPending correctly refuses the moment it meets a version number whose
// stored checksum doesn't match main's file at that version (checksum
// mismatch -> repair_required) — safe, but leaves the device permanently
// wedged with nothing to run next. This tool proves, migration-by-migration,
// that a foreign-numbered ledger row's content is EXACTLY what some main
// migration already delivers (possibly at a different version number, i.e. a
// pure renumbering), and if so — and ONLY if so — rewrites that one ledger
// row's version/name/checksum to match main, so applyPending can carry on
// from an honestly-labeled head. It never runs DDL itself; it never touches a
// row it cannot prove.
//
// Classification per ledger row, refuse-on-doubt throughout:
//   1. EXACT match: the row's checksum equals a main migration's raw-byte
//      checksum exactly (byte-identical content, no proof needed — the two
//      files ARE the same bytes). If that main migration's version already
//      equals the row's own version, this is a no-op ("already matches
//      main"); otherwise it's a straight renumber.
//   2. HEADER-STRIPPED match: the row's checksum is unknown to main directly,
//      but is known to us via the vendored lineage registry (the ledger
//      checksum is a sha256 over raw bytes computed by the ORIGINAL foreign
//      device; we can only recognize it if we independently possess
//      byte-identical source text — scripts/fixtures/lineages/<lineage>/ —
//      vendored copies of the two known foreign lineages' migration files,
//      audited 1:1 onto main). Once identified, we strip the leading
//      `-- risk: ...` / `-- NNNN: ...` comment block from that known foreign
//      text and from every main migration, and look for a body-only hash
//      match. Exactly one candidate is required (zero or >1 both refuse).
//      A candidate found this way is NOT remapped on text similarity alone:
//      structural proof (below) must pass first.
//   3. STRUCTURAL PROOF (required before applying a header-stripped match):
//      build reference(target.version - 1) — a scratch DB with exactly
//      main's own migrations 1..(target.version-1) applied (reusing
//      baseline-existing-db.js's memoized reference chain) — then apply the
//      device's known foreign migration text to one copy and main's
//      candidate migration text to a second copy of that SAME pre-state, and
//      snapshotSchema/compareSchemas (scripts/semantic-schema-compare.js)
//      the two results. Zero diffs of any class required; anything else
//      refuses that row.
//   4. UNKNOWN checksum (matches neither main nor the vendored lineage
//      registry) -> refuse (possible orphan; do not guess).
//   5. Batch-level ambiguity: after per-row classification, any target
//      version claimed by more than one ledger row (or reachable via >1
//      header-stripped candidate) refuses every row in that collision, not
//      just one arbitrary pick.
//
// Apply (--apply only, never --report): requires EVERY ledger row to
// classify as 'match' or 'remap' (a single 'refuse' anywhere refuses the
// whole run — nothing is touched). Requires writersStopped (same contract as
// migrate-cli.js / applyPending). Takes the same persistent, fsync'd,
// retention-pruned off-device backup migrate-cli.js takes (reused from
// there), rewrites version/name/checksum/status for every 'remap' row inside
// one BEGIN IMMEDIATE/COMMIT (DELETE-then-INSERT so mid-transaction primary
// key collisions between rows trading version slots are impossible), then
// syncFingerprints, then a post-apply consistency self-check MUST pass
// (deliberately narrower than lib/osi-migrate's verifyHead — see
// verifyReconciliationConsistency below for why verifyHead's own
// "every migration ever shipped is applied" bar is the wrong gate here) —
// otherwise the byte image is restored from the just-taken backup and the
// process exits non-zero. It never runs migration DDL itself (structural proof runs
// against disposable scratch copies only, never the live/target DB) and
// never edits a row it did not prove.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { ensureLedger, sqlQuote } = require('../lib/osi-migrate/ledger');
const { syncFingerprints, readStoredFingerprints, sortFps } = require('../lib/osi-migrate/runner');
const { computeFingerprints } = require('../lib/osi-migrate/fingerprints');
const { snapshotSchema, compareSchemas } = require('./semantic-schema-compare');
const { buildReference } = require('./baseline-existing-db');
const { offDeviceBackup, restoreByteImage } = require('./migrate-cli');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const DEFAULT_FIXTURES_DIR = path.join(REPO, 'scripts/fixtures/lineages');
const APP_VERSION = 'reconcile-ledger-numbering';

// --- header-stripped hashing -----------------------------------------------

// Strip ONLY the leading contiguous run of blank/`--`-comment lines (the
// mandatory `-- risk: ...` line plus any `-- NNNN: ...` description lines
// immediately below it) — never comments deeper in the file, which are real
// migration content. Operates on decoded text (checksums are still computed
// over raw bytes below, matching migrations-loader.js's own convention).
function stripLeadingCommentBlock(sql) {
  const lines = String(sql === null || sql === undefined ? '' : sql).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || /^\s*--/.test(lines[i]))) i += 1;
  return lines.slice(i).join('\n');
}

function headerStrippedChecksum(sql) {
  return crypto.createHash('sha256').update(stripLeadingCommentBlock(sql), 'utf8').digest('hex');
}

// --- indices -----------------------------------------------------------

// Exact + header-stripped indices over main's OWN ordered migrations
// (database/migrations/ordered/CHECKSUMS.json + files, per the ledger
// reconciliation brief).
function buildMainIndex(migrationsDir) {
  const migrations = loadMigrations(migrationsDir);
  const byChecksum = new Map();
  const byVersion = new Map();
  const byHeaderStrippedChecksum = new Map();
  for (const m of migrations) {
    byChecksum.set(m.checksum, m);
    byVersion.set(m.version, m);
    const hs = headerStrippedChecksum(m.sql);
    const list = byHeaderStrippedChecksum.get(hs) || [];
    list.push(m);
    byHeaderStrippedChecksum.set(hs, list);
  }
  return { migrations, byChecksum, byVersion, byHeaderStrippedChecksum };
}

// Registry of every vendored known-foreign-lineage migration file, keyed by
// its OWN raw-byte checksum — the only way a live device's ledger checksum
// (itself computed by the original foreign device over ITS OWN raw bytes) can
// ever be recognized again: we must independently hold byte-identical source
// text. Refuses (throws) if a vendored file's bytes have drifted from its own
// checksum manifest — the fixtures must stay exactly what was audited.
function buildLineageRegistry(fixturesDir) {
  const byChecksum = new Map();
  const lineages = {};
  if (!fs.existsSync(fixturesDir)) return { byChecksum, lineages };
  for (const lineage of fs.readdirSync(fixturesDir).sort()) {
    const dir = path.join(fixturesDir, lineage);
    if (!fs.statSync(dir).isDirectory()) continue;
    const manifestPath = path.join(dir, 'CHECKSUMS.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const migrations = loadMigrations(dir);
    for (const m of migrations) {
      if (manifest[m.name] !== m.checksum) {
        throw new Error(
          `lineage fixture drift: ${lineage}/${m.name} does not match ${lineage}/CHECKSUMS.json — refusing to build the lineage registry`
        );
      }
      byChecksum.set(m.checksum, { ...m, lineage });
    }
    for (const filename of Object.keys(manifest)) {
      if (!migrations.some((m) => m.name === filename)) {
        throw new Error(`lineage fixture manifest ${lineage}/CHECKSUMS.json names ${filename}, which is missing on disk`);
      }
    }
    lineages[lineage] = migrations.map((m) => m.name);
  }
  return { byChecksum, lineages };
}

// --- ledger read ---------------------------------------------------------

async function readLedgerRows(runner) {
  await ensureLedger(runner);
  return runner.all('SELECT version, name, checksum, status FROM schema_migrations ORDER BY version');
}

// --- classification --------------------------------------------------------

// Pure, synchronous per-row classification against the two indices. Does NOT
// run structural proof (that needs I/O — see resolveStructuralProofs below).
// Every row gets exactly one of: 'match' (already correct, no-op), 'remap'
// (exact byte match, safe without further proof), 'pending-proof'
// (header-stripped match found; structural proof required before it can
// become 'remap'), or 'refuse' (unknown checksum, or no/ambiguous
// header-stripped candidates).
function classifyRow(row, mainIndex, lineageRegistry) {
  const exact = mainIndex.byChecksum.get(row.checksum);
  if (exact) {
    if (exact.version === row.version && row.status !== 'repair_required') {
      return { ...row, decision: 'match', matchType: 'exact', target: exact, reason: 'already matches main at this version' };
    }
    return { ...row, decision: 'remap', matchType: 'exact', target: exact, reason: 'byte-identical to a main migration at a different version slot' };
  }
  const foreign = lineageRegistry.byChecksum.get(row.checksum);
  if (!foreign) {
    return {
      ...row,
      decision: 'refuse',
      matchType: 'unknown',
      target: null,
      reason: `unknown checksum ${String(row.checksum).slice(0, 12)}… — not found in main's migrations or any known lineage fixture (possible orphan)`,
    };
  }
  const hs = headerStrippedChecksum(foreign.sql);
  const candidates = mainIndex.byHeaderStrippedChecksum.get(hs) || [];
  if (candidates.length === 0) {
    return {
      ...row,
      decision: 'refuse',
      matchType: 'header-stripped',
      target: null,
      foreignLineage: foreign.lineage,
      foreignName: foreign.name,
      foreignText: foreign.sql,
      foreignRisk: foreign.risk,
      reason: `known ${foreign.lineage} migration ${foreign.name} has no header-stripped match in main`,
    };
  }
  if (candidates.length > 1) {
    return {
      ...row,
      decision: 'refuse',
      matchType: 'header-stripped',
      target: null,
      foreignLineage: foreign.lineage,
      foreignName: foreign.name,
      foreignText: foreign.sql,
      foreignRisk: foreign.risk,
      reason: `ambiguous: header-stripped body matches ${candidates.length} main migrations (${candidates.map((c) => c.name).join(', ')})`,
    };
  }
  return {
    ...row,
    decision: 'pending-proof',
    matchType: 'header-stripped',
    target: candidates[0],
    foreignLineage: foreign.lineage,
    foreignName: foreign.name,
    foreignText: foreign.sql,
    foreignRisk: foreign.risk,
    reason: 'header-only diff from main; structural proof required',
  };
}

// Batch-level: every row settles on exactly one FINAL version slot — its own
// current version if 'match' (a no-op, it never moves), or target.version if
// 'remap'/'pending-proof'. Any slot claimed by more than one row is unsafe:
// applying it would mean either two rows colliding on the same INTEGER
// PRIMARY KEY, or — more dangerously — a remap silently overwriting an
// unrelated, already-correct 'match' row that happens to already sit at the
// destination version. Refuse every MOVE into a contested slot (an
// already-correct 'match' row is left alone, since it never touches disk).
function refuseVersionSlotCollisions(rows) {
  const bySlot = new Map();
  for (const r of rows) {
    let slot = null;
    if (r.decision === 'match') slot = r.version;
    else if (r.decision === 'remap' || r.decision === 'pending-proof') slot = r.target.version;
    if (slot === null) continue;
    const list = bySlot.get(slot) || [];
    list.push(r);
    bySlot.set(slot, list);
  }
  for (const [slot, contributors] of bySlot) {
    if (contributors.length <= 1) continue;
    for (const r of contributors) {
      if (r.decision === 'match') continue; // untouched, already-correct — leave it be
      r.decision = 'refuse';
      r.reason = `ambiguous: version slot ${slot} is claimed by ${contributors.length} ledger rows (versions ${contributors.map((c) => c.version).join(', ')}) — refusing the move(s) rather than risk overwriting an occupied slot`;
    }
  }
  return rows;
}

// Applies a migration's raw SQL directly to a scratch DB, honoring the same
// risk-class transaction shape runner.js uses — WITHOUT any ledger
// bookkeeping (structural proof only cares about the resulting application
// schema; schema_migrations/schema_object_fingerprints are excluded from
// snapshotSchema's comparison anyway). Never called against a live/target DB
// — only against disposable scratch copies of a reference(N) snapshot.
async function applyRawMigrationSql(dbPath, { sql, risk }) {
  const runner = cliRunner(dbPath);
  if (risk === 'destructive') {
    await runner.exec(`PRAGMA foreign_keys=OFF;\nBEGIN IMMEDIATE;\n${sql}\nCOMMIT;\nPRAGMA foreign_keys=ON;`);
  } else {
    await runner.exec(`BEGIN IMMEDIATE;\n${sql}\nCOMMIT;`);
  }
}

// buildReference (reused from baseline-existing-db.js) memoizes its reference
// chain at MODULE scope, keyed only by the resolved migrationsDir — NOT by
// whatever scratchRoot happens to be passed on a given call. A second
// runReconcile() call in the same process against the same migrationsDir
// (e.g. --report followed by --apply, or two devices sharing main's
// migrationsDir in one test run) is therefore a cache HIT that reuses file
// paths anchored under whichever scratchRoot was passed on the FIRST call
// ever made for that dir. Those files must outlive any single call, so they
// are kept in one process-lifetime scratch directory that is never deleted —
// the same (undeleted) contract baseline-existing-db.js's own scratchRoot
// already relies on; runReconcile's per-call scratchRoot (which IS cleaned
// up) is used only for the ephemeral structural-proof copies below, never
// for the reference chain itself.
let referenceScratchRoot = null;
function getReferenceScratchRoot() {
  if (!referenceScratchRoot) referenceScratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-reconcile-refchain-'));
  return referenceScratchRoot;
}

async function buildReferenceAt(migrationsDir, n) {
  const refRoot = getReferenceScratchRoot();
  if (n <= 0) {
    const dbPath = path.join(fs.mkdtempSync(path.join(refRoot, 'ref-empty-')), 'empty.db');
    await cliRunner(dbPath).exec('PRAGMA user_version=0;');
    return dbPath;
  }
  return buildReference(migrationsDir, n, refRoot);
}

// Resolves every 'pending-proof' row in place (mutates decision/proof/reason)
// by structurally comparing the device's known foreign migration text against
// main's candidate, both replayed onto the SAME reference(target.version-1)
// pre-state. Sequential on purpose: buildReference's own chain cache is
// serialized per migrationsDir already, and this path only ever has a
// handful of candidates per real device.
async function resolveStructuralProofs(rows, { migrationsDir, scratchRoot }) {
  for (const r of rows) {
    if (r.decision !== 'pending-proof') continue;
    const refDbPath = await buildReferenceAt(migrationsDir, r.target.version - 1);
    const proofDir = fs.mkdtempSync(path.join(scratchRoot, `proof-v${r.version}-`));
    const copyForeign = path.join(proofDir, 'foreign.db');
    const copyMain = path.join(proofDir, 'main.db');
    fs.copyFileSync(refDbPath, copyForeign);
    fs.copyFileSync(refDbPath, copyMain);
    await applyRawMigrationSql(copyForeign, { sql: r.foreignText, risk: r.foreignRisk });
    await applyRawMigrationSql(copyMain, { sql: r.target.sql, risk: r.target.risk });
    const snapForeign = await snapshotSchema(cliRunner(copyForeign));
    const snapMain = await snapshotSchema(cliRunner(copyMain));
    // No headSnap, no allowlist: for structural proof we require the two
    // applies to be IDENTICAL, not merely forward-drift-tolerant.
    const cmp = compareSchemas(snapForeign, snapMain, null, {});
    if (cmp.diffs.length === 0) {
      r.decision = 'remap';
      r.proof = { ok: true, diffs: [] };
    } else {
      r.decision = 'refuse';
      r.proof = { ok: false, diffs: cmp.diffs };
      r.reason = `structural proof failed: ${r.foreignLineage}/${r.foreignName} and main's ${r.target.name} do not produce an identical schema from the same pre-state (${cmp.diffs.length} diff(s): ${cmp.diffs.map((d) => `${d.class}:${d.kind}:${d.name}`).join(', ')})`;
    }
    fs.rmSync(proofDir, { recursive: true, force: true });
  }
  return rows;
}

// Full classification pipeline: per-row classify, batch collision refusal,
// then structural proof for whatever is still pending. Returns
// { rows, refused, summary }. Touches nothing on disk except disposable
// scratch copies under scratchRoot.
async function classifyLedger(ledgerRows, { mainIndex, lineageRegistry, migrationsDir, scratchRoot }) {
  let rows = ledgerRows.map((row) => classifyRow(row, mainIndex, lineageRegistry));
  rows = refuseVersionSlotCollisions(rows);
  rows = await resolveStructuralProofs(rows, { migrationsDir, scratchRoot });
  // A structural-proof pass can turn a 'pending-proof' winner into 'remap',
  // which could newly collide with another row's already-claimed target
  // (e.g. two header-stripped candidates both proving into the same slot
  // is not possible given refuseVersionSlotCollisions ran first over
  // pending-proof rows too — but re-run defensively since it is cheap and
  // the invariant is cheap to re-check, not to trust).
  rows = refuseVersionSlotCollisions(rows);
  const refused = rows.filter((r) => r.decision === 'refuse');
  const summary = {
    total: rows.length,
    match: rows.filter((r) => r.decision === 'match').length,
    remapExact: rows.filter((r) => r.decision === 'remap' && r.matchType === 'exact').length,
    remapHeaderStripped: rows.filter((r) => r.decision === 'remap' && r.matchType === 'header-stripped').length,
    refused: refused.length,
  };
  return { rows, refused: refused.length > 0, summary };
}

// --- post-apply self-check ---------------------------------------------

// Deliberately narrower than lib/osi-migrate's verifyHead: verifyHead
// requires the applied SET to exactly equal EVERY migration main has ever
// shipped (i.e. "have we reached head"), which a reconciled-but-not-yet-
// caught-up device will never satisfy on its own — reconciliation fixes the
// NUMBERING of rows that already exist, it does not apply migrations the
// device never had (a foreign lineage can be missing whole features, e.g.
// an AgroLink-only device has never run main's valve-control migrations at
// all — that is real, legitimate pending work for the applyPending call
// that follows reconciliation, not a reconciliation failure). Using
// verifyHead itself as this tool's own self-check would therefore refuse
// and roll back a CORRECT reconciliation any time real pending work
// remains, which is true for essentially every real foreign-numbered
// device. The self-check reconciliation actually owes is narrower and
// achievable: every row this tool touched (or left alone) must now be
// internally consistent with main — no row left `repair_required`, no
// `applied` row whose checksum still disagrees with main's checksum at
// that version — plus the same live-vs-stamped fingerprint comparison
// verifyHead performs (proving syncFingerprints actually took).
async function verifyReconciliationConsistency(runner, { migrationsDir }) {
  const rows = await runner.all('SELECT version, checksum, status FROM schema_migrations ORDER BY version');
  const mainByVersion = buildMainIndex(migrationsDir).byVersion;
  for (const r of rows) {
    if (r.status === 'repair_required') {
      return { ok: false, reason: `version ${r.version} is still repair_required after reconciliation` };
    }
    if (r.status !== 'applied') continue;
    const main = mainByVersion.get(r.version);
    if (!main || main.checksum !== r.checksum) {
      return { ok: false, reason: `version ${r.version} checksum does not match main after reconciliation` };
    }
  }
  const stored = await readStoredFingerprints(runner);
  const live = sortFps(await computeFingerprints(runner));
  if (JSON.stringify(stored) !== JSON.stringify(live)) {
    return { ok: false, reason: 'fingerprint drift detected after reconciliation (stored fingerprints do not match the live schema)' };
  }
  return { ok: true };
}

// --- apply -----------------------------------------------------------------

function remapSql({ oldVersion, newVersion, name, checksum }) {
  const now = new Date().toISOString();
  return {
    del: `DELETE FROM schema_migrations WHERE version=${oldVersion};`,
    ins: `INSERT INTO schema_migrations
        (version, name, checksum, applied_at, finished_at, status, error, app_version, backup_path)
      VALUES (${newVersion}, ${sqlQuote(name)}, ${sqlQuote(checksum)}, ${sqlQuote(now)}, ${sqlQuote(now)},
              'applied', NULL, ${sqlQuote(APP_VERSION)}, '');`,
  };
}

// Rewrites every 'remap' row's version/name/checksum/status inside ONE
// transaction. DELETE-then-INSERT (not UPDATE) so rows trading version slots
// with each other can never collide on the INTEGER PRIMARY KEY mid-batch —
// every old row is gone before any new row is (re-)inserted.
async function applyRemap(runner, rows) {
  const remapped = rows.filter((r) => r.decision === 'remap');
  if (remapped.length === 0) return { remapped: 0 };
  const deletes = [];
  const inserts = [];
  for (const r of remapped) {
    const { del, ins } = remapSql({ oldVersion: r.version, newVersion: r.target.version, name: r.target.name, checksum: r.target.checksum });
    deletes.push(del);
    inserts.push(ins);
  }
  await runner.exec(`BEGIN IMMEDIATE;\n${deletes.join('\n')}\n${inserts.join('\n')}\nCOMMIT;`);
  return { remapped: remapped.length };
}

// Orchestrates one full reconcile run against a real DB path: read ledger,
// classify, and — only in apply mode, and only if nothing refused — back up,
// remap, re-stamp fingerprints, and self-check with
// verifyReconciliationConsistency, rolling back the byte image if that
// self-check fails.
async function runReconcile({
  dbPath,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  fixturesDir = DEFAULT_FIXTURES_DIR,
  backupDir = null,
  apply = false,
  writersStopped = false,
  log = console.error,
} = {}) {
  if (!dbPath) throw new Error('usage: reconcile-ledger-numbering.js <db> [--migrations-dir <dir>] [--backup-dir <dir>] [--report|--apply]');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-reconcile-'));
  try {
    const runner = cliRunner(dbPath);
    const ledgerRows = await readLedgerRows(runner);
    const mainIndex = buildMainIndex(migrationsDir);
    const lineageRegistry = buildLineageRegistry(fixturesDir);
    const { rows, refused, summary } = await classifyLedger(ledgerRows, { mainIndex, lineageRegistry, migrationsDir, scratchRoot });

    for (const r of rows) {
      const targetDesc = r.target ? `-> v${r.target.version} ${r.target.name}` : '';
      log(`[reconcile] v${r.version} ${r.name}: ${r.decision} (${r.matchType}) ${targetDesc} — ${r.reason}`);
    }
    log(`[reconcile] summary: ${JSON.stringify(summary)}`);

    if (refused) {
      log('[reconcile] REFUSED: one or more ledger rows could not be classified. Nothing was touched.');
      return { applied: false, refused: true, rows, summary, backupPath: null };
    }

    if (!apply) {
      log('[reconcile] report mode: nothing applied.');
      return { applied: false, refused: false, rows, summary, backupPath: null };
    }

    if (!writersStopped) {
      throw new Error('reconcile-ledger-numbering: refuse to apply unless writers are stopped (deploy/pre-start)');
    }
    if (!backupDir) {
      throw new Error('refusing: --backup-dir is required to --apply (persistent pre-reconciliation backup)');
    }

    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = offDeviceBackup(dbPath, backupDir);
    log(`[reconcile] persistent pre-reconciliation backup: ${backupPath} (fsync'd, integrity ok)`);

    const { remapped } = await applyRemap(runner, rows);
    log(`[reconcile] remapped ${remapped} ledger row(s)`);
    await syncFingerprints(runner);

    const check = await verifyReconciliationConsistency(runner, { migrationsDir });
    if (!check.ok) {
      log(`[reconcile] post-apply consistency self-check FAILED: ${check.reason}`);
      const restored = restoreByteImage(dbPath, backupPath);
      if (!restored) {
        throw new Error(`reconciliation apply failed the consistency self-check AND restore integrity_check failed; backup at ${backupPath}`);
      }
      const e = new Error(`reconciliation applied but the post-apply consistency self-check failed; DB restored from ${backupPath}: ${check.reason}`);
      e.restored = true;
      throw e;
    }
    log('[reconcile] post-apply consistency self-check: ok');
    return { applied: true, refused: false, rows, summary, backupPath };
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// --- repair_required targeted recovery -------------------------------------

// Narrower recovery path than the full classify+remap pipeline above: for
// each CURRENTLY repair_required row, checks whether its checksum ALREADY
// matches main's checksum at its OWN current version number (e.g. a prior
// reconcile run remapped version/checksum correctly but the process died
// before the status flip — the same "commit landed, bookkeeping didn't"
// class of crash restamp-fingerprints.js recovers from, just for the status
// column instead of fingerprints). Never blindly clears the flag: a row
// whose checksum still does not match main at its current version is left
// alone and reported, not silently unstuck.
async function clearRepairRequired({
  dbPath,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  backupDir = null,
  writersStopped = false,
  log = console.error,
} = {}) {
  if (!dbPath) throw new Error('usage: reconcile-ledger-numbering.js <db> --clear-repair-required [--migrations-dir <dir>] [--backup-dir <dir>]');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  const runner = cliRunner(dbPath);
  const ledgerRows = await readLedgerRows(runner);
  const mainIndex = buildMainIndex(migrationsDir);
  const wedged = ledgerRows.filter((r) => r.status === 'repair_required');
  if (wedged.length === 0) {
    log('[reconcile] no repair_required rows found; nothing to clear.');
    return { cleared: 0, stillWedged: [] };
  }
  const clearable = [];
  const stillWedged = [];
  for (const row of wedged) {
    const main = mainIndex.byVersion.get(row.version);
    if (main && main.checksum === row.checksum) {
      clearable.push(row);
    } else {
      stillWedged.push(row);
      log(`[reconcile] v${row.version} ${row.name}: still repair_required — checksum does not match main's v${row.version} (${main ? main.name : 'no main migration at this version'}). Run reconciliation (--apply) first, or investigate manually.`);
    }
  }
  if (clearable.length === 0) {
    log('[reconcile] REFUSED: no repair_required row has a checksum matching main at its own version. Nothing cleared.');
    return { cleared: 0, stillWedged };
  }
  if (!writersStopped) {
    throw new Error('reconcile-ledger-numbering: refuse to clear repair_required unless writers are stopped (deploy/pre-start)');
  }
  if (!backupDir) {
    throw new Error('refusing: --backup-dir is required to clear repair_required (persistent backup)');
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = offDeviceBackup(dbPath, backupDir);
  log(`[reconcile] persistent pre-clear backup: ${backupPath} (fsync'd, integrity ok)`);
  const now = new Date().toISOString();
  const updates = clearable.map((r) => `UPDATE schema_migrations SET status='applied', error=NULL, finished_at=${sqlQuote(now)} WHERE version=${r.version};`).join('\n');
  await runner.exec(`BEGIN IMMEDIATE;\n${updates}\nCOMMIT;`);
  await syncFingerprints(runner);
  const check = await verifyReconciliationConsistency(runner, { migrationsDir });
  if (!check.ok) {
    const restored = restoreByteImage(dbPath, backupPath);
    if (!restored) {
      throw new Error(`clear-repair-required failed the consistency self-check AND restore integrity_check failed; backup at ${backupPath}`);
    }
    throw new Error(`clear-repair-required applied but the post-apply consistency self-check failed; DB restored from ${backupPath}: ${check.reason}`);
  }
  log(`[reconcile] cleared repair_required on ${clearable.length} row(s); post-apply consistency self-check: ok`);
  return { cleared: clearable.length, stillWedged };
}

// --- CLI --------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dbPath: null,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    fixturesDir: DEFAULT_FIXTURES_DIR,
    backupDir: null,
    apply: false,
    clearRepairRequired: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--migrations-dir') opts.migrationsDir = path.resolve(argv[++i] || '');
    else if (a === '--fixtures-dir') opts.fixturesDir = path.resolve(argv[++i] || '');
    else if (a === '--backup-dir') opts.backupDir = argv[++i];
    else if (a === '--apply') opts.apply = true;
    else if (a === '--report') opts.apply = false;
    else if (a === '--clear-repair-required') opts.clearRepairRequired = true;
    else if (a === '--json') opts.json = true;
    else if (!opts.dbPath) opts.dbPath = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.json ? () => {} : console.error;
  if (opts.clearRepairRequired) {
    const res = await clearRepairRequired({ ...opts, writersStopped: true, log });
    if (opts.json) console.log(JSON.stringify(res));
    process.exit(res.cleared > 0 || res.stillWedged.length === 0 ? 0 : 1);
  }
  const res = await runReconcile({ ...opts, writersStopped: opts.apply, log });
  if (opts.json) console.log(JSON.stringify(res));
  process.exit(res.refused ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => { console.error(`[reconcile] FAILED: ${e.message}`); process.exit(2); });
}

module.exports = {
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_FIXTURES_DIR,
  APP_VERSION,
  stripLeadingCommentBlock,
  headerStrippedChecksum,
  buildMainIndex,
  buildLineageRegistry,
  readLedgerRows,
  classifyRow,
  refuseVersionSlotCollisions,
  resolveStructuralProofs,
  classifyLedger,
  applyRemap,
  verifyReconciliationConsistency,
  runReconcile,
  clearRepairRequired,
  parseArgs,
};
