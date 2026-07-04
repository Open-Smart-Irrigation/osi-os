# Boot-Node `devices` Rebuild Fail-Close (Option B-minus) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shipped Node-RED boot-node `devices` rebuild **guarded** (skipped when the live CHECK already lists all required device types) and **fail-closed** (plain INSERT inside an atomic transaction + abort-without-swap + surfaced error + foreign keys always restored), replacing the every-boot `INSERT OR IGNORE` rebuild that can silently drop rows the way the history-loss incident did.

**Architecture:** The **only change to shipped device runtime behavior** in this effort — its own PR. The rebuild moves out of the swallow-loop into a block that runs inside `osi-db-helper`'s `_db.transaction()` (one `operationQueue` slot; `BEGIN IMMEDIATE`; auto-`ROLLBACK` on throw — verified `index.js:193-215`), with the FK/legacy-alter fence toggled outside the transaction and restored in a `finally`. It is validated by a rehearsal that **executes the actual shipped func** against throwaway copies, backed by a facade-compatible shim over Node's built-in `node:sqlite` (a real engine, no native dependency — the shipped `sqlite3` native module is Pi-only and unresolvable on dev/CI).

**Tech Stack:** Node-RED inline `func` (JS), `node:sqlite` (built-in, Node ≥ 22), Node.js `node:test`, `sqlite3` CLI, GitHub Actions.

## Global Constraints

- **TWO byte-identical flows files.** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and `.../bcm2709/.../flows.json` have a **byte-identical** `sync-init-fn` func (verified: 69691 == 69691). Both MUST be edited identically. `scripts/verify-profile-parity.js:42-43` hashes the flows file + the whole `node-red` dir → byte-parity is enforced; `scripts/verify-runtime-schema-parity.js` (in CI) loops BOTH files.
- **`verify-sync-flow.js` is RED at baseline and not in CI.** It exits 1 today (crashes in a chained `test-sync-history-schema.js` sub-check via the pre-existing `data_invalid`/`comp_pending` duplicate-column parse errors — AGENTS.md documents this), so its FK-fence assertion at line 1362 is currently unreachable, and no workflow runs it. Therefore: **(1)** still rewrite `expectSyncInitDevicesRebuildForeignKeyFence()` so that script is internally correct for the new structure (it greps the OLD double-quoted literals this change removes), and **(2)** add a NEW standalone `scripts/verify-devices-rebuild-fence.js` wired into `migrations.yml` as the ACTUAL CI gate. Do not claim `verify-sync-flow.js` "exits 0."
- **The rehearsal must use a REAL engine, never a fake.** Back it with a `node:sqlite` facade shim (below), not a fabricated stub. The one in-repo precedent (`verify-sync-flow.js:937-941`) injects a fake sqlite — do NOT copy that here; a fake would convert this regression gate into a false green.
- **`PRAGMA foreign_keys` is a no-op inside a transaction** — set it OFF before `BEGIN` (it persists through the txn) and restore it ON in a `finally` on EVERY exit path (open the `try` immediately after `foreign_keys=OFF` so a throw from the `legacy_alter_table` pragma is also caught).
- **The func's free identifiers are `osiDb`, `env`, `node`** (locals `_db`, `exec`, `close` derive from `osiDb`). No `msg`/`flow`/`global`/`context`/`require`. The func body is `return (async()=>{…})().catch(…)` — it resolves to a promise and never rejects, so the rehearsal asserts on **DB state**, not exceptions.
- **NEVER run against a live `farming.db`.** Rehearsal uses copies; the production gate (Task 4) pulls a copy via the existing `scripts/download-farming-db.sh`.
- **Required device-type set (6), verbatim:** `KIWI_SENSOR`, `STREGA_VALVE`, `DRAGINO_LSN50`, `TEKTELIC_CLOVER`, `SENSECAP_S2120`, `AQUASCOPE_LORAIN`.

---

## File Structure

- `scripts/rehearse-devices-rebuild.js` — per-case CLI harness: seed a copy DB into a chosen state, execute the SHIPPED `sync-init-fn` func against a `node:sqlite` facade shim pointed at the copy, then assert the devices outcome. Supports an `existing` mode (no reseed) for the production-copy gate. **(Task 1)**
- `scripts/rehearse-devices-rebuild.test.js` — spawns the harness once per case (fresh process each) and asserts all cases. **(Task 1)**
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and `.../bcm2709/.../flows.json` — the `sync-init-fn` func edit (identical). **(Task 2)**
- `scripts/verify-devices-rebuild-fence.js` — standalone CI gate asserting the new fail-closed structure across both flows files. **(Task 2)**
- `scripts/verify-sync-flow.js` — rewrite `expectSyncInitDevicesRebuildForeignKeyFence()` for the new structure (internal correctness). **(Task 2)**
- `.github/workflows/migrations.yml` — run the new fence check + the rehearsal test. **(Task 2)**
- `AGENTS.md` — document the guarded fail-closed rebuild, reconcile the freeze note, record the merge gate. **(Task 2)**

---

### Task 1: Rehearsal harness that executes the SHIPPED func (node:sqlite shim)

**Why:** The regression gate must exercise the real func's control flow + SQL. The shipped facade requires a native `sqlite3` unavailable on dev/CI, so back the func with a facade-compatible shim over the built-in `node:sqlite` — a real engine. Written first, it goes RED against the current func: `healthy` fails (current func rebuilds unconditionally — `skipped=false`), `would-drop` fails (`INSERT OR IGNORE` drops the offending row — `rowsPreserved=false`).

**Files:**
- Create: `scripts/rehearse-devices-rebuild.js`
- Create: `scripts/rehearse-devices-rebuild.test.js`

**Interfaces:**
- `rehearse-devices-rebuild.js <case> <copyDbPath>`, `<case>` ∈ `healthy|would-drop|legit-upgrade|existing`. Prints one JSON line `{ case, skipped, rowsPreserved, hasLorain, errorSurfaced, before, after, ok }`, exits 0 iff `ok`.

- [ ] **Step 1: Write the harness**

Create `scripts/rehearse-devices-rebuild.js`:

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const SEED = path.join(REPO, 'database/seed-blank.sql');
const FLOWS = path.join(REPO, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const REQUIRED = ['KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN'];

function sh(db, sql) { execFileSync('sqlite3', ['-bail', db], { input: sql, encoding: 'utf8' }); }
function funcText() { return JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === 'sync-init-fn').func; }

function readDevices(dbPath) {
  const db = new DatabaseSync(dbPath);
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'").get() || {}).sql || '';
  const count = Number(db.prepare('SELECT COUNT(*) c FROM devices').get().c);
  db.close();
  return { ddl, count };
}

// Facade-compatible shim over node:sqlite (REAL engine). Mirrors the osi-db-helper API the
// sync-init-fn func uses: run/get/all/exec (promise OR node-style callback) + transaction + close.
function makeFacadeShim(dbPath) {
  const db = new DatabaseSync(dbPath);
  const call = (kind) => (sql, cb) => {
    try {
      let r;
      if (kind === 'run' || kind === 'exec') { db.exec(sql); r = undefined; }
      else if (kind === 'get') r = db.prepare(sql).get();
      else r = db.prepare(sql).all();
      if (typeof cb === 'function') { process.nextTick(() => cb(null, r)); return; }
      return Promise.resolve(r);
    } catch (e) {
      if (typeof cb === 'function') { process.nextTick(() => cb(e)); return; }
      return Promise.reject(e);
    }
  };
  const scope = { run: call('run'), all: call('all'), get: call('get'), exec: call('exec') };
  return Object.assign({}, scope, {
    async transaction(executor) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = await executor(scope); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
    close(cb) { try { db.close(); } catch (_) {} if (typeof cb === 'function') cb(); },
  });
}

function reseedDevicesCheck(db, types) {
  const ddl = (execFileSync('sqlite3', ['-json', db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'"], { encoding: 'utf8' }).trim());
  const cur = JSON.parse(ddl)[0].sql;
  const list = types.map((t) => `'${t}'`).join(',');
  const nu = cur.replace(/CHECK\s*\(\s*type_id\s+IN\s*\([\s\S]*?\)/i, `CHECK(type_id IN (${list})`);
  sh(db, 'PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;' +
    `ALTER TABLE devices RENAME TO devices_seedtmp; ${nu};` +
    'INSERT INTO devices SELECT * FROM devices_seedtmp; DROP TABLE devices_seedtmp;' +
    'PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON;');
}

function seed(db, mode) {
  sh(db, fs.readFileSync(SEED, 'utf8'));
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const row = (eui, type) => `INSERT INTO devices (deveui,name,type_id,created_at,updated_at) VALUES ('${eui}','n','${type}',${now},${now});`;
  if (mode === 'healthy') sh(db, row('AAAA000000000001', 'AQUASCOPE_LORAIN') + row('AAAA000000000002', 'KIWI_SENSOR'));
  else if (mode === 'would-drop') {
    reseedDevicesCheck(db, REQUIRED.filter((t) => t !== 'AQUASCOPE_LORAIN').concat(['BOGUS_TYPE']));
    sh(db, row('AAAA000000000003', 'KIWI_SENSOR') + row('AAAA000000000004', 'BOGUS_TYPE'));
  } else if (mode === 'legit-upgrade') {
    reseedDevicesCheck(db, REQUIRED.filter((t) => t !== 'AQUASCOPE_LORAIN'));
    sh(db, row('AAAA000000000005', 'KIWI_SENSOR') + row('AAAA000000000006', 'STREGA_VALVE'));
  } else if (mode !== 'existing') throw new Error(`unknown case ${mode}`);
}

async function runFuncAgainst(copyDb, errors) {
  const osiDb = { Database: function () { return makeFacadeShim(copyDb); }, verbose() { return osiDb; } };
  const env = { get: (k) => (k === 'DEVICE_EUI' ? '0016C001F1000001' : '') };
  const node = { error(m) { errors.push(String(m)); }, warn() {}, status() {}, log() {} };
  const fn = new Function('osiDb', 'env', 'node', 'msg', funcText());
  await fn(osiDb, env, node, {});
}

async function main() {
  const [mode, copyDb] = process.argv.slice(2);
  if (mode !== 'existing') seed(copyDb, mode);
  const before = readDevices(copyDb);
  const errors = [];
  await runFuncAgainst(copyDb, errors);
  const after = readDevices(copyDb);
  const result = {
    case: mode, before: before.count, after: after.count,
    skipped: before.ddl === after.ddl,
    rowsPreserved: after.count === before.count,
    hasLorain: /'AQUASCOPE_LORAIN'/.test(after.ddl),
    // Specifically the rebuild-abort message, not just any node.error (e.g. the outer catch).
    errorSurfaced: errors.some((m) => /rebuild ABORTED/.test(m)),
  };
  if (mode === 'healthy' || mode === 'existing') result.ok = result.skipped && result.rowsPreserved;
  else if (mode === 'would-drop') result.ok = result.rowsPreserved && result.errorSurfaced; // no silent drop, surfaced as ABORTED
  else if (mode === 'legit-upgrade') result.ok = result.rowsPreserved && result.hasLorain;
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
main().catch((e) => { console.log(JSON.stringify({ case: process.argv[2], ok: false, error: e.message })); process.exit(1); });
```

- [ ] **Step 2: Write the test that spawns each case in a fresh process**

Create `scripts/rehearse-devices-rebuild.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');

function runCase(mode) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reh-')), 'copy.db');
  let out, code = 0;
  try { out = execFileSync('node', [path.join(__dirname, 'rehearse-devices-rebuild.js'), mode, db], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status || 1; }
  // The harness prints one JSON line to stdout; node:sqlite's ExperimentalWarning goes to stderr.
  // Take the last line that starts with '{' so the diagnostics survive a non-zero exit.
  const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || '{}';
  return { json: JSON.parse(line), code };
}

test('healthy DB: guard SKIPS the rebuild, rows preserved', () => {
  const { json, code } = runCase('healthy');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.skipped, true);
});

test('a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced', () => {
  const { json, code } = runCase('would-drop');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.rowsPreserved, true);
  assert.strictEqual(json.errorSurfaced, true);
});

test('legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN', () => {
  const { json, code } = runCase('legit-upgrade');
  assert.strictEqual(code, 0, JSON.stringify(json));
  assert.strictEqual(json.hasLorain, true);
});
```

- [ ] **Step 3: Run against the CURRENT (unfixed) func to confirm RED**

Run: `node --test scripts/rehearse-devices-rebuild.test.js`
Expected: FAIL — `healthy` (`skipped=false`) and `would-drop` (`rowsPreserved=false`). `legit-upgrade` may already pass. If a case ERRORS before asserting (e.g. a shim gap — a func method the shim doesn't implement, or a `node:sqlite` pragma rejection), fix the shim until `legit-upgrade` runs cleanly; never weaken the assertions.

- [ ] **Step 4: Commit the harness (RED)**

```bash
git add scripts/rehearse-devices-rebuild.js scripts/rehearse-devices-rebuild.test.js
git commit -m "test(edge): rehearse the shipped sync-init-fn against node:sqlite copies (RED)"
```

---

### Task 2: Fix the func + fence, both profiles, one coherent change

**Why:** Lift the rebuild out of the swallow-loop; skip when the CHECK already lists all 6 types; otherwise rebuild inside a transaction with a plain INSERT (violation → ROLLBACK, devices untouched), FK restored on every exit, errors surfaced. The fence rewrite lands in the **same commit** as the func edit (the func edit removes the literals the old fence asserts).

**Files:** both `flows.json`; `scripts/verify-sync-flow.js`; `scripts/verify-devices-rebuild-fence.js` (new); `.github/workflows/migrations.yml`; `AGENTS.md`.

- [ ] **Step 1: Add the two SQL constants to the bcm2712 func**

Before `const stmts = [`, add (copy the exact shipped `CREATE TABLE IF NOT EXISTS devices_new (...)` text and the copy-SELECT **verbatim** from `stmts`, changing only `INSERT OR IGNORE` → `INSERT`):

```js
const DEVICES_NEW_DDL = "CREATE TABLE IF NOT EXISTS devices_new (…paste the exact shipped devices_new DDL…)";
const DEVICES_COPY_SQL = "INSERT INTO devices_new SELECT id,deveui,name,type_id,… FROM devices"; // was INSERT OR IGNORE
```

- [ ] **Step 2: Remove the ten rebuild statements from `stmts`**

Delete the consecutive elements `"PRAGMA foreign_keys=OFF"`, `"CREATE TABLE IF NOT EXISTS devices_new …"`, `"INSERT OR IGNORE INTO devices_new … FROM devices"`, `"PRAGMA legacy_alter_table=ON"`, `"DROP TABLE IF EXISTS devices_old"`, `"ALTER TABLE devices RENAME TO devices_old"`, `"ALTER TABLE devices_new RENAME TO devices"`, `"DROP TABLE IF EXISTS devices_old"`, `"PRAGMA foreign_keys=ON"`, `"PRAGMA legacy_alter_table=OFF"`. Leave the four `"CREATE INDEX IF NOT EXISTS idx_devices_*…"` elements in place.

- [ ] **Step 3: Insert the guarded fail-closed block after the swallow-loop**

Immediately after `for (const sql of stmts) { try { await exec(sql); } catch (_) {} }` and before the self-heal (`q2`/`bad2`) block, insert (copy the four `idx_devices_*` CREATE INDEX statements verbatim from `stmts`):

```js
// --- devices rebuild: guarded + fail-closed (Option B-minus) ---
try {
  const cur = await _db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='devices'");
  const liveDdl = (cur && cur.sql) || '';
  const REQUIRED_TYPES = ['KIWI_SENSOR','STREGA_VALVE','DRAGINO_LSN50','TEKTELIC_CLOVER','SENSECAP_S2120','AQUASCOPE_LORAIN'];
  const cm = /CHECK\s*\(\s*type_id\s+IN\s*\(([\s\S]*?)\)/i.exec(liveDdl);
  const liveTypes = new Set(((cm && cm[1].match(/'[^']*'/g)) || []).map((s) => s.slice(1, -1)));
  // Missing devices table => leave it to the seed/image; do not bootstrap from an empty rebuild.
  const needsRebuild = liveDdl && !REQUIRED_TYPES.every((t) => liveTypes.has(t));
  if (needsRebuild) {
    await _db.run('PRAGMA foreign_keys=OFF');
    try {
      await _db.run('PRAGMA legacy_alter_table=ON');
      await _db.transaction(async (t) => {
        await t.run('DROP TABLE IF EXISTS devices_new'); // clear any stale devices_new from a prior crash
        await t.run(DEVICES_NEW_DDL);
        await t.run(DEVICES_COPY_SQL); // plain INSERT: any CHECK violation throws => ROLLBACK, devices untouched
        await t.run('DROP TABLE IF EXISTS devices_old');
        await t.run('ALTER TABLE devices RENAME TO devices_old');
        await t.run('ALTER TABLE devices_new RENAME TO devices');
        await t.run('DROP TABLE IF EXISTS devices_old');
        await t.run("CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id)");
        // …paste the remaining three idx_devices_* CREATE INDEX statements verbatim…
      });
      node.status({ fill: 'green', shape: 'dot', text: 'devices CHECK upgraded' });
    } catch (e) {
      node.error('devices rebuild ABORTED (devices left intact): ' + e.message);
    } finally {
      // Restore the safety-critical pragma FIRST, and guard each so one failure can't skip the other.
      try { await _db.run('PRAGMA foreign_keys=ON'); } catch (_) {}
      try { await _db.run('PRAGMA legacy_alter_table=OFF'); } catch (_) {}
    }
  }
} catch (e) {
  node.error('devices rebuild guard error: ' + e.message);
}
```

- [ ] **Step 4: Verify the bcm2712 flow parses and the rehearsal goes GREEN**

Run: `node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8')); console.log('parses')"`
Run: `node --test scripts/rehearse-devices-rebuild.test.js`
Expected: parses; all three cases PASS.

- [ ] **Step 5: Mirror the edit into the bcm2709 flow, byte-identically**

Apply the identical three edits to `.../bcm2709/.../flows.json`, then:
Run: `node -e "const f=(p)=>JSON.parse(require('fs').readFileSync(p,'utf8')).find(n=>n.id==='sync-init-fn').func; console.log('identical:', f('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json')===f('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'))"`
Expected: `identical: true`.

- [ ] **Step 6: Add the standalone CI fence check**

Create `scripts/verify-devices-rebuild-fence.js` (the ACTUAL CI gate — `verify-sync-flow.js` is red at baseline for unrelated reasons):

```js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(path.resolve(__dirname, '..'), p));
const problems = [];
for (const fp of FLOWS) {
  const func = (JSON.parse(fs.readFileSync(fp, 'utf8')).find((n) => n.id === 'sync-init-fn') || {}).func || '';
  const rel = path.basename(path.dirname(path.dirname(path.dirname(path.dirname(fp)))));
  if (/INSERT OR IGNORE INTO devices_new/.test(func)) problems.push(`${rel}: devices copy still uses INSERT OR IGNORE (silent drop)`);
  if (!/_db\.transaction\s*\(/.test(func)) problems.push(`${rel}: rebuild not inside _db.transaction()`);
  if (!/REQUIRED_TYPES[\s\S]*needsRebuild/.test(func)) problems.push(`${rel}: rebuild not guarded by the live CHECK`);
  const off = func.indexOf('foreign_keys=OFF'), on = func.indexOf('foreign_keys=ON'), fin = func.indexOf('finally');
  if (off < 0 || on < 0 || !(fin >= 0 && fin < on)) problems.push(`${rel}: FK fence must restore foreign_keys=ON in a finally`);
}
if (problems.length) { console.error('verify-devices-rebuild-fence: FAIL'); problems.forEach((p) => console.error('  - ' + p)); process.exit(1); }
console.log(`verify-devices-rebuild-fence: OK (${FLOWS.length} flows)`); process.exit(0);
```

- [ ] **Step 7: Rewrite the in-script fence in verify-sync-flow.js (internal correctness)**

Read `scripts/verify-sync-flow.js:355-385`, then replace the body of `expectSyncInitDevicesRebuildForeignKeyFence()` to assert the same new invariants, locating the func via `findNodeById('sync-init-fn')` (NOT `findNodeByName`, which matches the display name `'Sync Init Schema + Triggers'`). Keep the top-level call. This keeps that script correct for whenever its pre-existing baseline crash is fixed; it is not this plan's CI gate.

- [ ] **Step 8: Wire the gate + rehearsal into CI (and bump Node to 22)**

In `.github/workflows/migrations.yml`, the harness uses the built-in `node:sqlite`, which requires **Node ≥ 22.5** — the workflow currently pins `node-version: '20'` (line 18). Change it to `'22'` (verified: all existing steps pass on Node 22.22), then add the two gate steps:

```yaml
        # (existing actions/setup-node@v4 block)
          node-version: '22'
```

```yaml
      - run: node scripts/verify-devices-rebuild-fence.js
      - run: node --test scripts/rehearse-devices-rebuild.test.js
```

- [ ] **Step 9: Document + reconcile the freeze note**

In `AGENTS.md`, in the `sync-init-fn` freeze paragraph, add: the boot node remains frozen for *schema* changes; this **safety fix** (guarded + fail-closed `devices` rebuild — plain INSERT in `_db.transaction()`; CHECK violation rolls back with `devices` intact; FK restored in `finally`; errors surfaced) is the sanctioned exception. Merge gate: `verify-runtime-schema-parity.js` + `verify-profile-parity.js` + `verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild` green, and a production-copy rehearsal (Task 4).

- [ ] **Step 10: Commit (func + fence together)**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-devices-rebuild-fence.js scripts/verify-sync-flow.js .github/workflows/migrations.yml AGENTS.md
git commit -m "fix(edge): guard + fail-close the boot-time devices rebuild (both profiles) + fence"
```

---

### Task 3: Run the full gate

**Why:** Confirm the change is green across the verifiers that actually run.

- [ ] **Step 1: Run the CI-gated verifiers**

Run: `node scripts/verify-devices-rebuild-fence.js`
Run: `node scripts/verify-runtime-schema-parity.js`
Run: `node scripts/verify-profile-parity.js`
Run: `node --test scripts/rehearse-devices-rebuild.test.js`
Expected: all exit 0 / PASS.

- [ ] **Step 2: Sanity-check the in-script fence in isolation (verify-sync-flow.js is red at baseline)**

Because `verify-sync-flow.js` crashes earlier for unrelated reasons, verify only the rewritten fence function, e.g.:
Run: `node -e "const m=require('./scripts/verify-sync-flow.js'); /* if it exports the fn, call it; else eval the fence function against the flows and assert no throw */"`
Expected: the fence function does not throw against the new func. (If `verify-sync-flow.js` is not modular, confirm by inspection that it no longer references the removed double-quoted literals.)

---

### Task 4: Production-copy rehearsal gate (manual, pre-merge)

**Why:** The one production gateway (Uganda) is the only DB whose loss matters. Prove the new func is a **no-op** there (its CHECK is already 6-type → guard SKIPS).

- [ ] **Step 1: Pull a copy via the existing helper (never touch the live file)**

Run: `bash scripts/download-farming-db.sh` against the Uganda host (it wraps `sqlite3 .backup` + scp). If the gateway lacks the `sqlite3` CLI, use the helper's node-sqlite path or copy the DB file directly. Result: a local `uganda.copy.db`.

- [ ] **Step 2: Rehearse against the copy in `existing` mode**

Run: `node scripts/rehearse-devices-rebuild.js existing /path/to/uganda.copy.db`
Expected: JSON with `skipped: true`, `rowsPreserved: true`, `ok: true` — the guard skips and nothing changes (Uganda already runs a 6-type CHECK). Paste this into the PR description as the production gate.

Interpreting a non-skip result: `{ skipped: false, rowsPreserved: true, hasLorain: true }` means the copy's CHECK was legitimately stale and the fixed func performed a **correct** upgrade (rows preserved, type added) — investigate why Uganda's CHECK was stale, but this is NOT a failure of the change and NOT a reason to rerun-until-green or weaken the `existing` mode. Only `rowsPreserved: false` is a stop-the-line result.

- [ ] **Step 3: Open the PR**

Open the PR with the rehearsal output + the production-copy result. Do NOT merge until every CI-gated verifier and the copy gate are green.

---

## Self-Review

**Spec coverage:** unconditional rebuild → guard (Task 2 Step 3); silent-drop `INSERT OR IGNORE` → plain INSERT in a txn (Task 2); stale `devices_new` → `DROP TABLE IF EXISTS devices_new` first (Task 2 Step 3); non-atomic swap / FK leak → `_db.transaction()` + `try` opened before the pragmas + `finally` restore (Task 2 Step 3); swallowed errors → surfaced `node.error` (Task 2) asserted by the harness (`errorSurfaced`); lost indexes → recreated post-swap (Task 2 Step 3); second flows file → Task 2 Step 5; broken/red fence verifier → standalone `verify-devices-rebuild-fence.js` in CI + in-script fence rewrite (Task 2 Steps 6-7); real-func fidelity without a native dep → node:sqlite shim (Task 1); production safety → Task 4 `existing` mode.

**Placeholder scan:** the three `…paste verbatim…` markers (devices_new DDL, copy-SELECT, remaining indexes) are deliberate anti-transcription-drift; exact source locations are given (the shipped `stmts`). Everything else is complete.

**Consistency:** the guard's CHECK regex byte-matches `checkTypes()` (`verify-runtime-schema-parity.js:19-21`); `DEVICES_NEW_DDL`/`DEVICES_COPY_SQL` defined Step 1, consumed Step 3; both the standalone fence and the in-script fence assert the tokens Step 3 introduces (`_db.transaction(`, `foreign_keys=OFF/ON`, `finally` before `ON`, `REQUIRED_TYPES`/`needsRebuild`, no `INSERT OR IGNORE`); the harness shim implements exactly the methods the func calls (`run`/`get`/`all`/`exec` promise+callback, `transaction`, `close`).

**Accepted limitation (documented):** the FK-off `run()` and the `transaction()` are separate `operationQueue` slots (four inter-slot gaps), so a concurrent flow op could momentarily run with FK enforcement off on the rare rebuild path at boot. The swap itself cannot interleave (it is one `transaction()` slot). Eliminating the inter-slot window entirely requires a facade change (a single atomic slot spanning the fence), deferred to Option B proper. This is far smaller than the current every-boot `INSERT OR IGNORE` hazard.

**Fidelity note (accepted):** the node:sqlite shim is a real engine executing the real func, but it does not exercise the shipped facade's `operationQueue`/`transaction()` wrapper (a thin, code-reviewed layer whose semantics were confirmed against `osi-db-helper/index.js:193-215`). The transaction rollback-on-throw and pragma persistence that the safety property depends on are SQL-engine behavior, which the shim reproduces faithfully. **One blind spot to keep in review:** inside the `transaction(async (t) => { … })` executor, use ONLY `t.run/get/all` — a facade-level `_db.*` call there deadlocks on-device (it enqueues an op that waits on the in-flight transaction slot, `index.js:117-136/197`) but silently "works" in the shim. The Step 3 block uses only `t.*`; a reviewer must keep it that way.
```