# Option B Stage 1 — Deploy-Time Migration Runner Invocation (issue #88) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes (learned from prior plans):** (1) work inside a feature worktree/branch (`feat/88-stage1-deploy-runner`), not the root `main` checkout; (2) run every command from the worktree root; (3) `deploy.sh` is BusyBox-`ash`-targeted (no bashisms — no arrays, `local` ok, `[ ]` not `[[ ]]`); (4) this plan **depends on Stage 0 being merged first** (`baseline-existing-db.js`, `repair-sync-outbox-v2.js`, `0005__analysis_views.sql`, `CHECKSUMS.json` with the `0005` entry) — verify they exist before starting (Task 0); (5) no live gateway, no SSH — the live runs are item 1.B2's runbook.
> **Spec:** [`docs/superpowers/specs/2026-07-08-option-b-stage1-deploy-runner-design.md`](../specs/2026-07-08-option-b-stage1-deploy-runner-design.md) (review round 1 accepted). Section refs (§A–§G, §B0) point there.

**Goal:** Make the ordered-migration runner the on-device schema-delivery mechanism at deploy time: a new `scripts/migrate-cli.js` entrypoint that takes an off-device fsync'd backup before any destructive/data migration, invokes `applyPending` (writers stopped), and restores the byte-image on failure; and a `deploy.sh` migration step that fetches the full migrations corpus, ensures the `sqlite3` CLI, stops Node-RED, baselines a first-run device via Stage 0's `baseline-existing-db.js`, runs `migrate-cli.js`, and restarts Node-RED on every exit path — replacing the five `ensure_*` functions. No boot-node change, no Uganda, no live device.

**Architecture:** `deploy.sh` gains one bracketed migration step (after `npm install`, before `fix_mosquitto_ownership`): fetch `database/migrations/ordered/*` + `CHECKSUMS.json` → `$TMP_DIR/migrations/ordered/` (§B0); `command -v sqlite3` or `opkg install sqlite3-cli`, else refuse (§B); `trap`-guarded `/etc/init.d/node-red stop` … `start` (§C); if no ledger, `repair-sync-outbox-v2.js` then `baseline-existing-db.js` (§D); `migrate-cli.js /data/db/farming.db --backup-dir $TMP_DIR/migrate-backup --migrations-dir $TMP_DIR/migrations/ordered` (§E); restart. `migrate-cli.js` wraps `applyPending` with an off-device backup (fsync file + dir) taken only when a `destructive`/`data` migration is pending, and a restore-from-byte-image on any throw. `lib/osi-migrate` is consumed, never modified.

**Tech Stack:** Node.js (`node:test`, `node:fs`, `node:child_process`), `sqlite3` CLI via the existing `cliRunner`, `lib/osi-migrate` (runner/ledger/loader/backup — consumed), `deploy.sh` (BusyBox ash), GitHub Actions.

## Global Constraints

- **Never modify** `lib/osi-migrate/*` or any `database/migrations/ordered/*.sql` / `CHECKSUMS.json` entry. Consume the runner; do not fork it.
- **Never touch** `sync-init-fn` (boot node, FROZEN — Stage 2), the boot-node `devices`-CHECK rebuild, or `scripts/repair-pi-schema.js` (it is not a deploy step; §F). No `flows.json` change of any kind.
- **No SSH, no live gateways, no production hosts.** Rehearsal (Task 6) uses a **copy** of the local kaba100 dev fixture `/home/phil/backups/kaba100-chameleon-zero-export-20260702/farming-kaba100-20260702T0754Z.db` in a scratch dir, read-only against the fixture (verify its sha256 is unchanged after).
- `migrate-cli.js` must NOT stop/start Node-RED (deploy.sh owns that bracket so the restart trap lives in one place — spec §E).
- CI (`.github/workflows/migrations.yml`) green at every commit.
- Work on `feat/88-stage1-deploy-runner`, commit per task, open a PR at the end, **do not merge**.

## Non-goals (do not do these)

- No Stage 2 (boot-DDL removal), no Uganda (#87), no live deploy (that is item 1.B2's runbook), no `CONFIG_PACKAGE_sqlite3-cli=y` firmware flip (follow-up), no node-sqlite3 runtime adapter.
- Do not add any migration file. `0005` is Stage 0's; head is `0005` after Stage 0 merges.

## File Structure (all changes)

- Create: `scripts/migrate-cli.js` + `scripts/migrate-cli.test.js` (Task 1)
- Modify: `deploy.sh` — new `run_schema_migration` function + its invocation, remove the five `ensure_*` bodies + calls (Tasks 2–4)
- Create: `scripts/test-deploy-migration-wiring.js` (static guard over `deploy.sh`, Task 5)
- Modify: `.github/workflows/migrations.yml` (wire the two new tests, Task 5)
- Modify: `.claude/skills/osi-schema-change-control/SKILL.md` (decision-table rows, Task 5)
- No file change in Task 6 (rehearsal + PR).

---

### Task 0: Verify Stage 0 is present (precondition gate — no commit)

- [ ] **Step 0.1: Confirm Stage 0 landed.** Run:

```bash
cd "$(git rev-parse --show-toplevel)"
ls database/migrations/ordered/0005__analysis_views.sql \
   scripts/baseline-existing-db.js scripts/repair-sync-outbox-v2.js \
   database/migrations/ordered/CHECKSUMS.json
node -e 'const m=require("./database/migrations/ordered/CHECKSUMS.json"); if(!m["0005__analysis_views.sql"]) { console.error("MISSING 0005 checksum"); process.exit(1) } console.log("0005 checksum present")'
node scripts/verify-migrations.js
```

Expected: all files exist; `0005 checksum present`; `verify-migrations: OK (5 migrations, ...)`. **If any is missing, STOP — Stage 0 (item 0.3) must merge first.** This plan is entirely downstream of it (spec m3).

- [ ] **Step 0.2: Baseline green on the branch base.** Run `node scripts/verify-sync-flow.js` and confirm it ends `All parity checks passed.` Record the head migration version (`ls database/migrations/ordered/` → expect `0001..0005`).

---

### Task 1: `scripts/migrate-cli.js` — runner invocation + off-device backup + restore (spec §E)

**Files:**
- Create: `scripts/migrate-cli.test.js`
- Create: `scripts/migrate-cli.js`

**Interfaces:**
- Produces: `runMigrateCli({ dbPath, backupDir, migrationsDir, log? }) → { applied: number[], offDeviceBackup: string|null, restored: boolean }`. CLI: `node scripts/migrate-cli.js <db> --backup-dir <dir> [--migrations-dir <dir>]` — exit 0 on success, 1 on migration-failure-restored, 2 on usage/refusal, 3 on failure-AND-restore-verify-failed (DB left in place, do NOT restart Node-RED against it).
- Consumes: `lib/osi-migrate` (`applyPending`, `verifyHead`), `runner-iface` (`cliRunner`), `migrations-loader` (`loadMigrations`), `ledger` (`ensureLedger`, `getApplied`), `backup` (`backupDb`).

- [ ] **Step 1.1: Write the failing test suite** — create `scripts/migrate-cli.test.js` with exactly:

```js
'use strict';
// Stage 1 migrate-cli: off-device fsync'd backup before destructive/data apply,
// applyPending under writersStopped, and byte-image restore on failure.
// Spec §E: docs/superpowers/specs/2026-07-08-option-b-stage1-deploy-runner-design.md
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh, verifyHead } = require('../lib/osi-migrate');
const { runMigrateCli } = require('./migrate-cli');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'migcli-')); }

// A device already at head (fresh bootstrap) — a second migrate run is a no-op,
// takes no off-device backup (nothing destructive/data pending).
test('device at head: no pending migrations, no off-device backup, applied empty', async () => {
  const dir = scratch();
  const db = path.join(dir, 'device.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
  const backupDir = path.join(dir, 'bak');
  const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  assert.deepEqual(res.applied, []);
  assert.equal(res.offDeviceBackup, null); // nothing destructive/data pending → no backup taken
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

// A device stamped at version 3 with pending 0004 (destructive) + 0005: the
// off-device backup MUST be taken and fsync-verified before apply, and apply
// carries it to head.
async function deviceAtV3(dir) {
  // Build reference(3) by bootstrapping only 0001..0003 into the db.
  const sub = path.join(dir, 'm3'); fs.mkdirSync(sub);
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (/^000[123]__/.test(f) || f === 'CHECKSUMS.json') fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(sub, f));
  }
  const db = path.join(dir, 'device.db');
  await bootstrapFresh(cliRunner(db), { migrationsDir: sub, appVersion: 'baseline-existing-db' });
  return db;
}

test('pending destructive: off-device backup taken + fsync-verified, applied [4,5], head ok', async () => {
  const dir = scratch();
  const db = await deviceAtV3(dir);
  const backupDir = path.join(dir, 'bak');
  const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: MIGRATIONS_DIR, log: () => {} });
  assert.deepEqual(res.applied, [4, 5]);
  assert.ok(res.offDeviceBackup && fs.existsSync(res.offDeviceBackup), 'off-device backup file must exist');
  // the backup is a valid standalone DB (integrity ok) — proven by opening it
  const bakRows = await cliRunner(res.offDeviceBackup).all("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1");
  assert.ok(bakRows.length >= 1);
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

test('injected migration failure: byte-image restored, exit-shaped result, DB unchanged', async () => {
  const dir = scratch();
  const db = await deviceAtV3(dir);
  const backupDir = path.join(dir, 'bak');
  // A poisoned migrations dir: 0001..0005 real, plus a 0006 data migration whose
  // INSERT violates the device_data→devices FK (FK enforcement ON): the statement
  // throws during apply (data-class takes a backup first) → applyPending throws →
  // migrate-cli restores the byte image. (Either the INSERT throwing or a postflight
  // failure reaches the same restore path; the INSERT throws first here.)
  const poisoned = path.join(dir, 'poisoned'); fs.mkdirSync(poisoned);
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(poisoned, f));
  const bad = '-- risk: data\nPRAGMA foreign_keys=ON;\nINSERT INTO device_data (deveui, recorded_at) VALUES (\'NO_SUCH_DEVICE_EUI\', \'2020-01-01T00:00:00Z\');\n';
  fs.writeFileSync(path.join(poisoned, '0006__bad.sql'), bad);
  const manifest = JSON.parse(fs.readFileSync(path.join(poisoned, 'CHECKSUMS.json'), 'utf8'));
  const crypto = require('node:crypto');
  manifest['0006__bad.sql'] = crypto.createHash('sha256').update(fs.readFileSync(path.join(poisoned, '0006__bad.sql'))).digest('hex');
  fs.writeFileSync(path.join(poisoned, 'CHECKSUMS.json'), JSON.stringify(manifest, null, 2) + '\n');

  const before = fs.readFileSync(db);
  const res = await runMigrateCli({ dbPath: db, backupDir, migrationsDir: poisoned, log: () => {}, expectThrow: true })
    .catch((e) => ({ error: e }));
  // runMigrateCli re-throws after restoring; the wrapper restored the byte image first.
  assert.ok(res.error, 'expected the run to throw after restoring');
  assert.equal((await cliRunner(db).all('PRAGMA integrity_check'))[0].integrity_check || 'ok', 'ok');
  // restored image is byte-identical to the pre-migration DB
  assert.ok(before.equals(fs.readFileSync(db)), 'DB must be byte-restored to pre-migration image');
});

test('refuses a missing db path (anti-typo)', async () => {
  await assert.rejects(
    () => runMigrateCli({ dbPath: '/nonexistent/nope.db', backupDir: scratch(), migrationsDir: MIGRATIONS_DIR, log: () => {} }),
    /does not exist/);
});

test('refuses a missing backup-dir argument', async () => {
  const dir = scratch();
  const db = path.join(dir, 'd.db');
  await cliRunner(db).exec('CREATE TABLE x (a TEXT);');
  await assert.rejects(
    () => runMigrateCli({ dbPath: db, backupDir: null, migrationsDir: MIGRATIONS_DIR, log: () => {} }),
    /backup-dir/);
});
```

- [ ] **Step 1.2: Run it (red)**

Run: `node --test scripts/migrate-cli.test.js`
Expected: FAIL — `Cannot find module './migrate-cli'`.

- [ ] **Step 1.3: Implement** — create `scripts/migrate-cli.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// migrate-cli.js — Option B Stage 1 (issue #88) deploy-time runner entrypoint.
// Spec §E: docs/superpowers/specs/2026-07-08-option-b-stage1-deploy-runner-design.md
//
// Wraps lib/osi-migrate applyPending with the two DD9 guarantees the runner does
// not provide itself:
//   1. an OFF-DEVICE backup, fsync'd (file + dir) BEFORE the first destructive
//      statement, so SD-card death mid-migration cannot lose the pre-image;
//   2. restore-of-the-byte-image ON FAILURE, actually invoked here.
// It does NOT stop/start Node-RED — deploy.sh owns that bracket (one restart
// trap). It does NOT baseline — that is Stage 0's baseline-existing-db.js, a
// separate blast radius, run by deploy.sh before this.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { applyPending } = require('../lib/osi-migrate');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { ensureLedger, getApplied } = require('../lib/osi-migrate/ledger');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function fsyncPath(p) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// SQLite online backup via the CLI .backup dot-command (consistent under WAL),
// then integrity_check the copy, then fsync copy + its dir.
function offDeviceBackup(dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `${path.basename(dbPath)}.premigrate-${stamp}`);
  const { execFileSync } = require('node:child_process');
  // .backup writes a standalone DB image; sqliteDotQuote not needed — dest is our own path.
  execFileSync('sqlite3', ['-cmd', '.timeout 30000', dbPath, `.backup '${dest}'`], { encoding: 'utf8', timeout: 120000 });
  const integ = (require('node:child_process').execFileSync('sqlite3', [dest, 'PRAGMA integrity_check'], { encoding: 'utf8' }).trim());
  if (integ !== 'ok') throw new Error(`off-device backup integrity_check failed: ${integ}`);
  fsyncPath(dest);
  fsyncPath(backupDir); // directory entry durable too
  return dest;
}

async function pendingRisksAfterApplied(dbPath, migrationsDir) {
  const runner = cliRunner(dbPath);
  await ensureLedger(runner);
  const appliedOk = new Set((await getApplied(runner)).filter((m) => m.status === 'applied').map((m) => m.version));
  return loadMigrations(migrationsDir).filter((m) => !appliedOk.has(m.version)).map((m) => m.risk);
}

function restoreByteImage(dbPath, backupPath) {
  for (const sidecar of ['-wal', '-shm', '-journal']) {
    try { fs.rmSync(dbPath + sidecar, { force: true }); } catch (_) {}
  }
  fs.copyFileSync(backupPath, dbPath);
  fsyncPath(dbPath);
  const { execFileSync } = require('node:child_process');
  const integ = execFileSync('sqlite3', [dbPath, 'PRAGMA integrity_check'], { encoding: 'utf8' }).trim();
  return integ === 'ok';
}

async function runMigrateCli({ dbPath, backupDir, migrationsDir = DEFAULT_MIGRATIONS_DIR, log = console.error }) {
  if (!dbPath) throw new Error('usage: migrate-cli.js <db> --backup-dir <dir> [--migrations-dir <dir>]');
  if (!fs.existsSync(dbPath)) {
    // sqlite3 would otherwise CREATE an empty DB at a typoed path and "migrate" THAT.
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  if (!backupDir) throw new Error('refusing: --backup-dir is required (off-device pre-migration backup, spec §E)');

  const risks = await pendingRisksAfterApplied(dbPath, migrationsDir);
  const needsBackup = risks.some((r) => r === 'destructive' || r === 'data');
  let offDevice = null;
  if (needsBackup) {
    offDevice = offDeviceBackup(dbPath, backupDir);
    log(`[migrate] off-device pre-migration backup: ${offDevice} (fsync'd, integrity ok)`);
  } else {
    log('[migrate] no destructive/data migration pending — off-device backup not required');
  }

  try {
    const res = await applyPending(cliRunner(dbPath), { migrationsDir, appVersion: 'stage1-deploy', writersStopped: true });
    log(`[migrate] applied: ${JSON.stringify(res.applied)}`);
    return { applied: res.applied, offDeviceBackup: offDevice, restored: false };
  } catch (err) {
    log(`[migrate] FAILED during applyPending: ${err.message}`);
    if (!offDevice) {
      // Only additive was pending (no backup); additive is non-destructive and the
      // runner rolled back the failing statement — nothing to restore. Re-throw.
      log('[migrate] failure was on additive-only work (runner rolled back); nothing to restore.');
      throw err;
    }
    log(`[migrate] restoring pre-migration byte image from ${offDevice}`);
    const ok = restoreByteImage(dbPath, offDevice);
    if (!ok) {
      log('[migrate] RESTORE INTEGRITY FAILED — leaving DB in place; recover manually from: ' + offDevice);
      const e = new Error(`migration failed AND restore integrity_check failed; off-device backup at ${offDevice}`);
      e.code = 3; // deploy.sh: do NOT restart Node-RED against this DB
      throw e;
    }
    log('[migrate] restored byte image; integrity ok. Re-throwing so deploy treats migration as failed.');
    const e = new Error(`migration failed; DB restored from ${offDevice}: ${err.message}`);
    e.code = 1; // restored-good: deploy.sh restarts Node-RED on the restored DB
    e.restored = true;
    throw e;
  }
}

function parseArgs(argv) {
  const opts = { dbPath: null, backupDir: null, migrationsDir: DEFAULT_MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--backup-dir') opts.backupDir = argv[++i];
    else if (a === '--migrations-dir') opts.migrationsDir = path.resolve(argv[++i] || '');
    else if (!opts.dbPath) opts.dbPath = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

if (require.main === module) {
  (async () => {
    try {
      await runMigrateCli(parseArgs(process.argv.slice(2)));
      process.exit(0);
    } catch (e) {
      console.error(`[migrate] ${e.message}`);
      process.exit(Number.isInteger(e.code) ? e.code : 2);
    }
  })();
}

module.exports = { runMigrateCli, parseArgs };
```

Note: the test's `expectThrow` key is ignored by `runMigrateCli` (extra keys are harmless); the test catches the re-thrown error. The `restoreByteImage` path is exercised by the injected-failure test.

- [ ] **Step 1.4: Run it (green)**

Run: `node --test scripts/migrate-cli.test.js`
Expected: `# pass 5`, exit 0. (Replays real migrations via the sqlite3 CLI — tens of seconds.) If the injected-failure test does not restore, the bug is in `restoreByteImage`/backup ordering — fix the CLI, not the test.

- [ ] **Step 1.5: Commit**

```bash
git add scripts/migrate-cli.js scripts/migrate-cli.test.js
git commit -m "feat(migrate): deploy-time runner entrypoint with off-device backup + restore-on-failure (#88 Stage 1)"
```

---

### Task 2: `deploy.sh` — the `run_schema_migration` function (spec §B0/§B/§C/§D/§E)

**Files:** Modify `deploy.sh` (add the function; wire it in Task 3; remove `ensure_*` in Task 4).

- [ ] **Step 2.1: Add the `run_schema_migration` function** to `deploy.sh`, immediately after the `ensure_gateway_health_schema()` closing `}` (around line 506, before `echo "=== OSI OS Deploy ==="`). BusyBox-ash compatible (no arrays; use a here-listed loop). Insert exactly:

```sh
# --- Option B Stage 1: deploy-time ordered-migration runner (issue #88) ---
# Replaces the additive-only ensure_* functions. Fetches the full ordered
# migrations corpus, ensures the sqlite3 CLI, stops Node-RED (writers quiesced),
# baselines a first-run device via Stage 0's baseline-existing-db.js, then runs
# migrate-cli.js (off-device fsync'd backup + restore-on-failure). Node-RED is
# restarted on EVERY exit path via a trap. Spec:
# docs/superpowers/specs/2026-07-08-option-b-stage1-deploy-runner-design.md
run_schema_migration() {
    echo "--- Schema migration (Option B Stage 1) ---"
    if [ ! -e "$DB_PATH" ]; then
        echo "SKIP: no live database at $DB_PATH (fresh device gets full schema from the seed)"
        return 0
    fi

    # §B0: fetch the full ordered-migrations corpus + CHECKSUMS.json on-device.
    mig_dir="$TMP_DIR/migrations/ordered"
    mkdir -p "$mig_dir"
    fetch_required "migration checksum manifest" \
        "database/migrations/ordered/CHECKSUMS.json" "$mig_dir/CHECKSUMS.json"
    # Fetch EVERY file the manifest lists — the manifest is the authoritative set,
    # so a missing/renamed migration is a HARD error (a silent gap would make
    # loadMigrations see a non-contiguous set and baseline/applyPending misbehave).
    # Enumerating from CHECKSUMS.json (not a hardcoded list) means new migrations
    # need no deploy.sh edit and a renamed file can't be silently skipped.
    for mf in $(node -e 'const m=require(process.argv[1]);for(const k of Object.keys(m))if(/\.sql$/.test(k))console.log(k)' "$mig_dir/CHECKSUMS.json"); do
        fetch_required "migration $mf" "database/migrations/ordered/$mf" "$mig_dir/$mf"
    done

    # §B: the runner + backup need the sqlite3 CLI binary; the image does not ship it.
    if ! command -v sqlite3 >/dev/null 2>&1; then
        echo "sqlite3 CLI absent — installing sqlite3-cli via opkg"
        opkg update >/dev/null 2>&1 || true
        opkg install sqlite3-cli >/dev/null 2>&1 || true
    fi
    if ! command -v sqlite3 >/dev/null 2>&1; then
        echo "ERROR: sqlite3 CLI unavailable and could not be installed; refusing schema migration." >&2
        echo "       Gateway keeps its current schema. Install sqlite3-cli and re-deploy." >&2
        return 1
    fi

    # §C: stop Node-RED so writers are quiesced; restart on EVERY exit via a trap.
    node_red_started=0
    restart_node_red() {
        if [ "$node_red_started" = "0" ]; then
            echo "restarting Node-RED"
            /etc/init.d/node-red start || true
            node_red_started=1
        fi
    }
    trap restart_node_red EXIT INT TERM

    echo "stopping Node-RED (writers quiesced for migration)"
    /etc/init.d/node-red stop || true
    # Bounded wait for the process to actually exit (WAL busy_timeout is 5s).
    i=0
    while pgrep -f 'node-red' >/dev/null 2>&1 && [ "$i" -lt 30 ]; do
        sleep 1; i=$((i + 1))
    done
    if pgrep -f 'node-red' >/dev/null 2>&1; then
        echo "ERROR: Node-RED did not stop within 30s; refusing migration (writers not quiesced)." >&2
        return 1
    fi
    # Checkpoint the WAL so backup + integrity see a fully-merged DB.
    sqlite3 -cmd '.timeout 5000' "$DB_PATH" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true

    # §D: first-run baselining (device has no schema_migrations ledger yet).
    has_ledger="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations';" 2>/dev/null || echo 0)"
    ledger_rows=0
    if [ "$has_ledger" != "0" ]; then
        ledger_rows="$(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM schema_migrations;' 2>/dev/null || echo 0)"
    fi
    if [ "$ledger_rows" = "0" ]; then
        echo "first-run device: pre-baseline repair + baseline"
        fetch "scripts/repair-sync-outbox-v2.js" "$TMP_DIR/repair-sync-outbox-v2.js"
        fetch "scripts/baseline-existing-db.js" "$TMP_DIR/baseline-existing-db.js"
        # repair-sync-outbox-v2 is idempotent; skip its failure only if sync_outbox
        # is entirely absent (the #87 whole-table gap — out of scope here, Uganda-only).
        node "$TMP_DIR/repair-sync-outbox-v2.js" "$DB_PATH" || {
            echo "ERROR: repair-sync-outbox-v2 refused (sync_outbox whole-table gap?); refusing migration." >&2
            return 1
        }
        node "$TMP_DIR/baseline-existing-db.js" "$DB_PATH" --migrations-dir "$mig_dir" || {
            echo "ERROR: baselining refused (schema does not match any reference version); refusing migration." >&2
            echo "       Investigate schema drift out-of-band; nothing was stamped." >&2
            return 1
        }
    else
        echo "device already has a $ledger_rows-row ledger; skipping baseline"
    fi

    # §E: apply pending migrations under the runner's writers-stopped/backup/postflight
    # guarantees, plus migrate-cli's off-device fsync'd backup + restore-on-failure.
    fetch "scripts/migrate-cli.js" "$TMP_DIR/migrate-cli.js"
    mkdir -p "$TMP_DIR/migrate-backup"
    if node "$TMP_DIR/migrate-cli.js" "$DB_PATH" \
            --backup-dir "$TMP_DIR/migrate-backup" \
            --migrations-dir "$mig_dir"; then
        echo "OK: schema migration complete"
    else
        rc=$?
        if [ "$rc" = "3" ]; then
            echo "ERROR: migration failed AND restore integrity failed; DB left in place for manual recovery." >&2
            echo "       Node-RED will NOT be restarted against a possibly-corrupt DB." >&2
            trap - EXIT INT TERM   # cancel the restart trap: do not start against a bad DB
            node_red_started=1
            return 1
        fi
        echo "ERROR: migration failed; DB was restored to its pre-migration image (rc=$rc). Node-RED will restart on the restored DB." >&2
        return 1
    fi
}
```

- [ ] **Step 2.2: Sanity-check the shell parses** (no execution of the migration itself):

```bash
sh -n deploy.sh && echo "deploy.sh parses OK"
```

Expected: `deploy.sh parses OK`. (`sh -n` is a syntax check; it does not run anything.)

---

### Task 3: Wire `run_schema_migration` in, replacing the `ensure_*` invocations

**Files:** Modify `deploy.sh`.

- [ ] **Step 3.1: Replace the five `ensure_*` calls** (currently lines ~643–647):

Replace exactly this block:

```sh
ensure_dendro_schema
ensure_zone_irrigation_calibration_schema
ensure_analysis_views_schema
ensure_chameleon_schema
ensure_gateway_health_schema
```

with:

```sh
run_schema_migration
```

- [ ] **Step 3.2: Confirm the invocation moved, not duplicated**

```bash
grep -n "run_schema_migration\|ensure_dendro_schema\|ensure_gateway_health_schema" deploy.sh
```

Expected: `run_schema_migration` appears exactly twice (its `run_schema_migration() {` definition + the one call); the `ensure_*` names still appear only in their (about-to-be-removed) definitions — no stray calls. `sh -n deploy.sh` still passes.

---

### Task 4: Remove the five `ensure_*` function bodies (spec §F)

**Files:** Modify `deploy.sh`.

- [ ] **Step 4.1: Delete the five function definitions.** Remove the complete function bodies (from each `ensure_<name>() {` through its matching closing `}`) for: `ensure_dendro_schema`, `ensure_zone_irrigation_calibration_schema`, `ensure_analysis_views_schema`, `ensure_chameleon_schema`, `ensure_gateway_health_schema`. Leave `seed_db_if_missing`, `run_communication_preflight`, `fetch`, `fetch_required`, `cleanup`, `detect_seed_db_rel`, `fix_mosquitto_ownership`, and the new `run_schema_migration` intact.

- [ ] **Step 4.2: Verify the removals are clean**

```bash
grep -c "ensure_dendro_schema\|ensure_zone_irrigation_calibration_schema\|ensure_analysis_views_schema\|ensure_chameleon_schema\|ensure_gateway_health_schema" deploy.sh
sh -n deploy.sh && echo "PARSES"
```

Expected: `0` (all five names gone) and `PARSES`.

- [ ] **Step 4.3: Confirm no stray-DDL regression** — removing the `ensure_*` inline DDL lowers `deploy.sh`'s DDL marker counts, which `verify-no-stray-ddl.js` (bans only net *increases* vs `origin/main`) allows:

```bash
git fetch --no-tags origin main:refs/remotes/origin/main 2>/dev/null || true
node scripts/verify-no-stray-ddl.js
```

Expected: passes (counts only decreased). If it errors that `origin/main` is missing, fetch it as shown.

- [ ] **Step 4.4: Commit deploy.sh (Tasks 2–4 together)**

```bash
git add deploy.sh
git commit -m "feat(deploy): Stage 1 runner migration step; retire additive-only ensure_* functions (#88)"
```

---

### Task 5: Static deploy-wiring guard + CI wiring + skill decision-table update

**Files:**
- Create: `scripts/test-deploy-migration-wiring.js`
- Modify: `.github/workflows/migrations.yml`, `.claude/skills/osi-schema-change-control/SKILL.md`

- [ ] **Step 5.1: Write the deploy-wiring guard** — create `scripts/test-deploy-migration-wiring.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Static guard over deploy.sh: Stage 1 migration wiring is present and the
// additive-only ensure_* delivery path is gone. Spec §B0/§B/§C/§D/§E/§F.
// Run: node --test scripts/test-deploy-migration-wiring.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DEPLOY = fs.readFileSync(path.resolve(__dirname, '..', 'deploy.sh'), 'utf8');

test('run_schema_migration is defined and invoked (once each)', () => {
  assert.equal((DEPLOY.match(/run_schema_migration\(\) \{/g) || []).length, 1, 'exactly one definition');
  // definition + one call = two total occurrences
  assert.equal((DEPLOY.match(/run_schema_migration/g) || []).length, 2, 'definition + single call');
});

test('the five ensure_* delivery functions are removed', () => {
  for (const fn of [
    'ensure_dendro_schema', 'ensure_zone_irrigation_calibration_schema',
    'ensure_analysis_views_schema', 'ensure_chameleon_schema', 'ensure_gateway_health_schema',
  ]) {
    assert.ok(!DEPLOY.includes(fn), `${fn} must be gone (retired by Stage 1)`);
  }
});

test('§B0 fetches the migrations corpus + CHECKSUMS.json', () => {
  assert.match(DEPLOY, /database\/migrations\/ordered\/CHECKSUMS\.json/);
  assert.match(DEPLOY, /0001__baseline\.sql/);
  assert.match(DEPLOY, /0005__analysis_views\.sql/);
});

test('§B refuses when sqlite3 CLI cannot be provisioned', () => {
  assert.match(DEPLOY, /opkg install sqlite3-cli/);
  assert.match(DEPLOY, /sqlite3 CLI unavailable and could not be installed/);
});

test('§C stops Node-RED and restarts it via a trap on every exit', () => {
  assert.match(DEPLOY, /\/etc\/init\.d\/node-red stop/);
  assert.match(DEPLOY, /trap restart_node_red EXIT/);
  assert.match(DEPLOY, /\/etc\/init\.d\/node-red start/);
});

test('§D baselines a first-run (ledger-less) device via Stage 0 tools', () => {
  assert.match(DEPLOY, /repair-sync-outbox-v2\.js/);
  assert.match(DEPLOY, /baseline-existing-db\.js/);
  assert.match(DEPLOY, /schema_migrations/);
});

test('§E invokes migrate-cli with an off-device backup dir', () => {
  assert.match(DEPLOY, /migrate-cli\.js/);
  assert.match(DEPLOY, /--backup-dir/);
  assert.match(DEPLOY, /--migrations-dir/);
});

test('§E rc=3 (restore-verify-failed) cancels the restart trap (no start against a bad DB)', () => {
  assert.match(DEPLOY, /trap - EXIT INT TERM/);
});

test('sync-init-fn / boot-node is NOT touched by deploy.sh', () => {
  assert.ok(!DEPLOY.includes('sync-init-fn'));
});
```

- [ ] **Step 5.2: Run it (green)**

Run: `node --test scripts/test-deploy-migration-wiring.js`
Expected: `# pass 9`, exit 0.

- [ ] **Step 5.3: Wire both new tests into CI.** In `.github/workflows/migrations.yml`, extend the scripts-test `- run: node --test ...` line by appending `scripts/migrate-cli.test.js scripts/test-deploy-migration-wiring.js`. (Match the existing line that already lists `scripts/*.test.js` files — the same line Stage 0 extended.)

- [ ] **Step 5.4: Update the skill decision table (domain-law surface — sanctioned edit).** In `.claude/skills/osi-schema-change-control/SKILL.md`, in the "Decision table: which mechanism do I use?", update the two rows that say on-device destructive/data change is "not currently supported without a boot-path project" to point at the Stage 1 runner path. Replace the `destructive` row's note and the "Any other on-device schema mutation" row's `Not currently supported...` with wording naming the deploy-time runner (`deploy.sh run_schema_migration` → `migrate-cli.js` → `applyPending`, writers stopped, off-device backup, restore-on-failure — Option B Stage 1, spec 2026-07-08). Keep every other row unchanged; do not touch the boot-node freeze or the sanctioned `devices`-CHECK exception.

- [ ] **Step 5.5: Full local gate**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-sync-flow.js
node --test scripts/migrate-cli.test.js scripts/test-deploy-migration-wiring.js
node --test lib/osi-migrate/__tests__/*.test.js
```

Expected: every script prints its OK line / `All parity checks passed.`; both `node --test` runs `# fail 0`. Any RED is a real regression.

- [ ] **Step 5.6: Commit**

```bash
git add scripts/test-deploy-migration-wiring.js .github/workflows/migrations.yml \
        .claude/skills/osi-schema-change-control/SKILL.md
git commit -m "test+ci+docs: deploy migration wiring guard; skill decision-table names Stage 1 runner (#88)"
```

---

### Task 6: Local rehearsal against the kaba100 dev fixture + PR

**Files:** none modified. Fixture is **read-only**; all work on a copy in a scratch dir. This is the local dry-run; the fresh-copy **rehearsal-of-record** (spec Rehearsal DoD, incl. the restore-path rehearsal on a fresh post-0.1-deploy copy) is item 1.B2's operator runbook step, listed under Follow-ups.

- [ ] **Step 6.1: Scratch copy + baseline (fixture untouched)**

```bash
FIXTURE=/home/phil/backups/kaba100-chameleon-zero-export-20260702/farming-kaba100-20260702T0754Z.db
SCRATCH=$(mktemp -d /tmp/stage1-dryrun-XXXXXX)
sha256sum "$FIXTURE" | tee "$SCRATCH/fixture.sha256"
cp "$FIXTURE" "$SCRATCH/kaba100-copy.db"
sqlite3 "$SCRATCH/kaba100-copy.db" 'PRAGMA integrity_check;'
```

Expected: `ok`. (~231 MB copy; budget ~1 GB free in /tmp for the copy + off-device backup.)

- [ ] **Step 6.2: Simulate item-0.1 deploy convergence on the copy** (the §D precondition — same three steps Stage 0's dry-run uses: `repair-sync-outbox-v2.js` ×2, `0002` additive, trigger convergence from the seed). Run Stage 0 plan Task 7 Step 7.4 (1)(2)(3) verbatim against `$SCRATCH/kaba100-copy.db`. Expected: repair no-ops on second run; `OK 0002`; `converged 30 triggers`.

- [ ] **Step 6.3: Baseline the copy** (Stage 0's tool, head-down):

```bash
node scripts/baseline-existing-db.js "$SCRATCH/kaba100-copy.db" 2>&1 | tee "$SCRATCH/baseline.txt"
```

Expected: `N=3: PASS`, stamps `1..3`, exit 0. Any `extra_unknown`/unpredicted diff = finding → stop and report.

- [ ] **Step 6.4: Run migrate-cli on the copy** (off-device backup + apply [4,5]):

```bash
mkdir -p "$SCRATCH/bak"
node scripts/migrate-cli.js "$SCRATCH/kaba100-copy.db" --backup-dir "$SCRATCH/bak" 2>&1 | tee "$SCRATCH/migrate.txt"
ls -la "$SCRATCH/bak"
```

Expected: `off-device pre-migration backup: ...premigrate-... (fsync'd, integrity ok)`, `applied: [4,5]`, exit 0; the backup file exists in `$SCRATCH/bak`.

- [ ] **Step 6.5: Restore-path rehearsal on a SECOND copy** (spec Rehearsal DoD step 3 — the load-bearing one):

```bash
cp "$SCRATCH/kaba100-copy.db" "$SCRATCH/restore-test.db"   # copy is already at head; re-baseline+poison
# Build a poisoned migrations dir with a failing 0006 data migration (dangling FK).
POISON=$(mktemp -d "$SCRATCH/poison-XXXX")
cp database/migrations/ordered/*.sql database/migrations/ordered/CHECKSUMS.json "$POISON/"
printf -- '-- risk: data\nPRAGMA foreign_keys=ON;\nINSERT INTO device_data (deveui, recorded_at) VALUES (%s, %s);\n' \
  "'NO_SUCH_DEVICE_EUI'" "'2020-01-01T00:00:00Z'" > "$POISON/0006__bad.sql"
node -e 'const c=require("crypto"),f=require("fs");const d="'"$POISON"'/";const m=JSON.parse(f.readFileSync(d+"CHECKSUMS.json"));m["0006__bad.sql"]=c.createHash("sha256").update(f.readFileSync(d+"0006__bad.sql")).digest("hex");f.writeFileSync(d+"CHECKSUMS.json",JSON.stringify(m,null,2)+"\n")'
BEFORE=$(sha256sum "$SCRATCH/restore-test.db" | cut -d' ' -f1)
node scripts/migrate-cli.js "$SCRATCH/restore-test.db" --backup-dir "$SCRATCH/bak2" --migrations-dir "$POISON"; echo "exit=$?"
AFTER=$(sha256sum "$SCRATCH/restore-test.db" | cut -d' ' -f1)
sqlite3 "$SCRATCH/restore-test.db" 'PRAGMA integrity_check;'
[ "$BEFORE" = "$AFTER" ] && echo "RESTORED BYTE-IDENTICAL" || echo "RESTORE MISMATCH — FINDING"
```

Expected: migrate-cli logs the failure + `restoring pre-migration byte image` + `restored byte image; integrity ok`, exit non-zero (1); `ok`; `RESTORED BYTE-IDENTICAL`. (This proves restore is *exercised*, not just coded — refactor-program's explicit gate.)

- [ ] **Step 6.6: Postflight + row-count invariants + CHECK widened** on the migrated copy from Step 6.4:

```bash
sqlite3 "$SCRATCH/kaba100-copy.db" 'PRAGMA integrity_check;'
sqlite3 "$SCRATCH/kaba100-copy.db" 'PRAGMA foreign_key_check;'
for t in irrigation_schedules device_data chameleon_readings dendrometer_readings dendrometer_daily irrigation_events zone_daily_environment zone_daily_recommendations analysis_views; do
  echo "$t $(sqlite3 "$SCRATCH/kaba100-copy.db" "SELECT COUNT(*) FROM $t" 2>/dev/null || echo ABSENT)"
done | tee "$SCRATCH/rowcounts.txt"
sqlite3 "$SCRATCH/kaba100-copy.db" "SELECT sql FROM sqlite_master WHERE name='irrigation_schedules'" | grep -o "SWT_1','SWT_2','SWT_3','DENDRO" && echo "CHECK WIDENED"
```

Expected: `ok`; empty FK output; row counts printed; `CHECK WIDENED` (0004's `irrigation_schedules` rebuild landed). `irrigation_schedules` count must be unchanged from before Step 6.4 (compare to `$SCRATCH/baseline.txt` context — the headline invariant against the history-loss class).

- [ ] **Step 6.7: Prove the fixture is untouched, clean up**

```bash
sha256sum -c "$SCRATCH/fixture.sha256"
rm -rf "$SCRATCH"
```

Expected: `...: OK`, scratch removed. Never commit anything from the scratch dir.

- [ ] **Step 6.8: Push branch and open the PR (do not merge)**

```bash
git push -u origin feat/88-stage1-deploy-runner
gh pr create --title "feat(deploy): Option B Stage 1 — deploy-time migration runner (#88)" --body "<body per below>"
```

PR body must contain: (1) scope — Stage 1 of #88 per the spec (link it); deploy-time runner + retirement of `ensure_*`, **no boot-node change, no Uganda, no live device** (live runs are item 1.B2's runbook); (2) the two verified constraints resolved (CLI absence → §B provisioning; Node-RED not stopped → §C trap bracket) one sentence each; (3) real outputs from Task 5 Step 5.5; (4) Task 6 dry-run evidence: baseline `N=3 PASS`, migrate `applied: [4,5]`, off-device backup present, **restore-path `RESTORED BYTE-IDENTICAL` + exit non-zero**, postflight `ok`, `CHECK WIDENED`, `irrigation_schedules` count invariant, fixture sha256 `OK`; (5) any findings verbatim; (6) follow-ups below. Reference "Part of #88".

## Follow-ups (operator runbook / firmware — NOT plan tasks)

- **Rehearsal-of-record (spec Rehearsal DoD):** on a FRESH byte-copy of kaba100 taken after the item-0.1 flows deploy, run the full §F rehearsal incl. Node-RED boot (step 6) against the migrated copy. Item 1.B2's runbook executes this before the live run.
- **Live rollout kaba100 → Silvan** is item 1.B2 (runbook). Uganda is item 2.1's combined window (plan §5). This plan produces the tooling; it deploys to no device.
- **`CONFIG_PACKAGE_sqlite3-cli=y` in both full profiles' `.config`** so future flashes ship the CLI (needs a firmware rebuild + boot test — separate PR).
- Delete `scripts/repair-sync-outbox-v2.js` (Stage 0) once the fleet is baselined (consumed-or-deleted).
