# Edge Migration Runner Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the low-risk, verified runner/ops defects from two independent expert reviews (Opus + Fable 5) — the demonstrated drift-laundering defect, non-deterministic fingerprint ordering, missing busy timeout, unbounded backups, a missing `data` risk class, an ADR overstatement, and an unverifiable "cloud parity is our DR" assumption.

**Architecture:** All changes are in `osi-os`, in `lib/osi-migrate/` (not on the device boot path — the runner is deploy-time only today) plus two ops/docs additions. **The higher-risk boot-node `devices` rebuild rework (formerly Task 6) is split into its own plan+PR:** `docs/superpowers/plans/2026-07-03-boot-node-devices-rebuild-failclose.md`. This plan is safe to execute and merge on its own.

**Tech Stack:** Node.js (`node:test`), the `sqlite3` CLI (one process per migration = one connection), GitHub Actions.

## Global Constraints

- **Node ≥ 22 test invocation is a glob, never a dir:** `node --test lib/osi-migrate/__tests__/*.test.js` (CI: `.github/workflows/migrations.yml:21`).
- **Every migration runs through `sqlite3 -bail`, one process per migration** (`lib/osi-migrate/runner-iface.js`). Without `-bail`, sqlite3 reaches `COMMIT` on error and commits partial work.
- **`PRAGMA foreign_keys` is a no-op inside a transaction** — any FK toggle stays OUTSIDE `BEGIN…COMMIT`.
- **Schema change + ledger row must be atomic**; post-commit postflight failure → terminal `repair_required`, never re-run. **The fingerprint stamp is a SEPARATE transaction** from the migration commit (`runner.js:65`) — a crash between them leaves a stale stamp; recovery is via the restamp verb (Task 6-of-this-plan / Task R).
- **NEVER reseed a live `farming.db`.** Rehearsals run against copies.
- **On-device shell is BusyBox `ash` (no bash).** Ops scripts are Node or POSIX `sh`.
- **Nothing calls `applyPending` on the device today** — the runner is invoked only at deploy/CI time. The new preflight throw therefore cannot brick a booting gateway; it fails a deploy loudly, which is the intent.

---

## File Structure

- `lib/osi-migrate/runner.js` — shared fingerprint helpers (`sortFps`, `readStoredFingerprints`); inline preflight drift check + a corrected refresh guard in `applyPending`; deterministic sort in `verifyHead`; a named `restampFingerprints` recovery export. **(Tasks 1, 2, R)**
- `lib/osi-migrate/runner-iface.js` — busy timeout on the CLI runner; process timeout raised above it. **(Task 3)**
- `lib/osi-migrate/backup.js` — retention cap for `.bak-*` siblings. **(Task 4)**
- `lib/osi-migrate/migrations-loader.js` + `lib/osi-migrate/runner.js` — the `data` risk class. **(Task 5)**
- `scripts/restamp-fingerprints.js` — operator recovery CLI for a stale stamp. **(Task R)**
- `docs/adr/2026-06-30-schema-and-contract-ownership.md` — reword "eliminating" → "will eliminate once Option B lands." **(Task 7)**
- `scripts/check-sync-parity.js` + `scripts/check-sync-parity.test.js` + `docs/operations/cloud-parity-dr.md` — read-only DR-parity check (link-aware, history-aware). **(Task 8)**
- `.github/workflows/migrations.yml` — run the new `scripts/check-sync-parity.test.js`. **(Task 8)**
- `AGENTS.md` — document the `data` risk class + the restamp verb. **(folded into Tasks 5, R)**

Tests live in `lib/osi-migrate/__tests__/*.test.js` and `scripts/*.test.js`.

---

### Task 1: Stop drift laundering — inline preflight + corrected refresh guard

**Why:** *Demonstrated defect (Fable, reproduced against merged code).* `applyPending` calls `syncFingerprints` unconditionally (`runner.js:65`) even when zero migrations were applied, so a no-op run on a drifted DB re-stamps the drift (`verifyHead` flips `false`→`true`). Fix = refuse to apply onto out-of-band drift (preflight), and only re-stamp when migrations were applied **or nothing is stamped yet**. The `|| stored.length === 0` clause is load-bearing: it heals the "applied-but-never-stamped" crash state and is exactly the baseline-stamp an Option-B cutover of an existing field DB needs — without it, such a DB is stuck at `verifyHead.ok=false` after a no-op run.

**Files:**
- Modify: `lib/osi-migrate/runner.js`
- Test: `lib/osi-migrate/__tests__/runner-drift-preflight.test.js`

**Interfaces:**
- Produces (exported from `runner.js`): `sortFps(fps) -> fps[]` (binary, matches SQL `ORDER BY`), `readStoredFingerprints(runner) -> Promise<row[]>`. Rows are `{ object_type, object_name, fingerprint }` in that key order.

- [ ] **Step 1: Write the failing tests**

Create `lib/osi-migrate/__tests__/runner-drift-preflight.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPending, verifyHead } = require('../runner');
const { cliRunner } = require('../runner-iface');

function tmpMigrations() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const dir = path.join(root, 'm');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'),
    '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  return { db: path.join(root, 't.db'), dir };
}

test('a no-op applyPending refuses to launder out-of-band drift', async () => {
  const { db, dir } = tmpMigrations();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  await r.exec('ALTER TABLE t ADD COLUMN sneaky INTEGER;'); // out-of-band change

  const v1 = await verifyHead(r, { migrationsDir: dir });
  assert.strictEqual(v1.ok, false, 'drift must be detected');

  await assert.rejects(
    applyPending(r, { migrationsDir: dir, appVersion: 'x' }),
    /drift/i,
    'applyPending must fail closed on drift, not launder it');

  const v2 = await verifyHead(r, { migrationsDir: dir });
  assert.strictEqual(v2.ok, false, 'drift still visible after the refusal');
});

test('a no-op applyPending re-stamps when fingerprints are missing (crash self-heal)', async () => {
  const { db, dir } = tmpMigrations();
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  // Simulate "migration committed but stamp never written" (crash between the two txns).
  await r.exec('DELETE FROM schema_object_fingerprints;');
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, false);

  await applyPending(r, { migrationsDir: dir, appVersion: 'x' }); // must re-stamp, not throw
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, true,
    'empty-stamp state must self-heal on the next run');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/osi-migrate/__tests__/runner-drift-preflight.test.js`
Expected: FAIL — before the fix, the first test's `assert.rejects` fails (laundering resolves) and the second passes only by luck.

- [ ] **Step 3: Add the shared helpers**

In `lib/osi-migrate/runner.js`, after `composeFingerprintRefresh` (the function ending at current line 106), add:

```js
// Deterministic ordering that matches SQLite `ORDER BY object_type, object_name`
// (BINARY collation). Do NOT use localeCompare — it diverges from SQL ordering.
function sortFps(fps) {
  return fps.slice().sort((a, b) =>
    a.object_type < b.object_type ? -1 : a.object_type > b.object_type ? 1 :
    a.object_name < b.object_name ? -1 : a.object_name > b.object_name ? 1 : 0);
}

async function readStoredFingerprints(runner) {
  return runner.all(
    'SELECT object_type, object_name, fingerprint FROM schema_object_fingerprints ORDER BY object_type, object_name');
}
```

- [ ] **Step 4: Inline the preflight and correct the refresh guard**

In `applyPending`, right after the `if (broken) { throw … }` block (ending current line 15), insert:

```js
  // Preflight: refuse to apply onto a schema that drifted out-of-band since the last
  // stamp. Applying + re-stamping would silently bless the drift (runner-drift-preflight).
  const storedFps = await readStoredFingerprints(runner);
  if (storedFps.length > 0) {
    const liveFps = sortFps(await computeFingerprints(runner));
    if (JSON.stringify(storedFps) !== JSON.stringify(liveFps)) {
      throw new Error('schema drift detected before applying migrations: live schema does not match the last-stamped fingerprints. Refuse to proceed. If the live schema is known-correct, re-baseline with `node scripts/restamp-fingerprints.js <db>`; otherwise this is an out-of-band change needing manual repair.');
    }
  }
```

Then change the unconditional refresh (current line 65) from:

```js
  await syncFingerprints(runner);
  return { applied: appliedNow };
```

to:

```js
  // Re-stamp when migrations changed the schema, OR when nothing is stamped yet
  // (fresh bootstrap / crash self-heal — there is no baseline to launder).
  if (appliedNow.length > 0 || storedFps.length === 0) await syncFingerprints(runner);
  return { applied: appliedNow };
```

- [ ] **Step 5: Export the helpers**

Extend `module.exports` (current line 130) with `sortFps, readStoredFingerprints`:

```js
module.exports = { applyPending, postflight, bootstrapFresh, verifyHead, syncFingerprints, composeDestructiveScript, composeFingerprintRefresh, assertFreshDatabase, sortFps, readStoredFingerprints };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test lib/osi-migrate/__tests__/runner-drift-preflight.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full migrate suite (no regressions)**

Run: `node --test lib/osi-migrate/__tests__/*.test.js`
Expected: PASS (fresh bootstrap has no stored fingerprints → preflight is a no-op; `bootstrapFresh` unaffected).

- [ ] **Step 8: Commit**

```bash
git add lib/osi-migrate/runner.js lib/osi-migrate/__tests__/runner-drift-preflight.test.js
git commit -m "fix(migrate): fail closed on out-of-band drift; re-stamp only on apply or empty baseline"
```

---

### Task 2: Deterministic fingerprint ordering in `verifyHead`

**Why:** *Defect (Fable, reproduced).* `verifyHead` compares `stored` (SQL `ORDER BY`, BINARY collation) against `live` sorted with `localeCompare` on the concatenated key (`runner.js:122-123`) — the two orderings diverge (e.g. binary `table/aB` < `table/a_b`; locale reverses them), producing false drift or masking real drift. Reuse `sortFps` from Task 1.

**Files:**
- Modify: `lib/osi-migrate/runner.js` (`verifyHead`)
- Test: `lib/osi-migrate/__tests__/fingerprint-sort.test.js`

- [ ] **Step 1: Write the failing test**

Create `lib/osi-migrate/__tests__/fingerprint-sort.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sortFps } = require('../runner');

test('sortFps matches SQL ORDER BY object_type, object_name (BINARY), not localeCompare', () => {
  const input = [
    { object_type: 'table', object_name: 'a_b', fingerprint: '1' },
    { object_type: 'table', object_name: 'aB', fingerprint: '2' },
    { object_type: 'index', object_name: 'z', fingerprint: '3' },
  ];
  const got = sortFps(input).map((x) => `${x.object_type}/${x.object_name}`);
  // BINARY: 'index' < 'table'; within table, 'aB' (B=0x42) < 'a_b' (_=0x5f).
  assert.deepStrictEqual(got, ['index/z', 'table/aB', 'table/a_b']);
});
```

(We deliberately do NOT assert what `localeCompare` produces — that would test the ICU build, not our code, and fails on Intl-less Node.)

- [ ] **Step 2: Run test to verify it passes at the helper level**

Run: `node --test lib/osi-migrate/__tests__/fingerprint-sort.test.js`
Expected: PASS (helper added in Task 1). If Task 1 is not merged yet, FAIL with "sortFps is not a function".

- [ ] **Step 3: Use the deterministic sort in `verifyHead`**

In `verifyHead`, replace the fingerprint block (current lines 121-123):

```js
  const stored = await runner.all('SELECT object_type, object_name, fingerprint FROM schema_object_fingerprints ORDER BY object_type, object_name');
  const live = (await computeFingerprints(runner)).sort((a, b) =>
    (a.object_type + a.object_name).localeCompare(b.object_type + b.object_name));
```

with:

```js
  const stored = await readStoredFingerprints(runner);
  const live = sortFps(await computeFingerprints(runner));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/osi-migrate/__tests__/fingerprint-sort.test.js lib/osi-migrate/__tests__/verify-head-gap.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/runner.js lib/osi-migrate/__tests__/fingerprint-sort.test.js
git commit -m "fix(migrate): deterministic fingerprint ordering in verifyHead (binary, not locale)"
```

---

### Task R: Named restamp recovery verb

**Why:** *Fable (P4).* The preflight (Task 1) turns a stale stamp into a hard refusal. The sanctioned recovery must exist and be named, not "hand-craft SQL." `syncFingerprints` already does the work; expose it as a deliberate, logged CLI verb so an operator who has confirmed the live schema is correct can re-baseline in one line.

**Files:**
- Create: `scripts/restamp-fingerprints.js`
- Modify: `AGENTS.md`
- Test: `scripts/restamp-fingerprints.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/restamp-fingerprints.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applyPending, verifyHead } = require('../lib/osi-migrate/runner');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

test('restamp-fingerprints re-baselines a stale stamp', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restamp-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__b.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: 'x' });
  // Introduce a "known-correct" out-of-band change + a stale stamp.
  await r.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY);');
  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, false);

  execFileSync('node', [path.join(__dirname, 'restamp-fingerprints.js'), db], { encoding: 'utf8' });

  assert.strictEqual((await verifyHead(r, { migrationsDir: dir })).ok, true,
    'restamp makes the live schema the new baseline');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/restamp-fingerprints.test.js`
Expected: FAIL — the script does not exist yet.

- [ ] **Step 3: Implement the CLI**

Create `scripts/restamp-fingerprints.js`:

```js
#!/usr/bin/env node
'use strict';
const { syncFingerprints } = require('../lib/osi-migrate/runner');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: restamp-fingerprints.js <path-to-farming.db>');
    console.error('Re-baselines schema_object_fingerprints to the CURRENT live schema.');
    console.error('Only run this after confirming the live schema is correct.');
    process.exit(2);
  }
  const runner = cliRunner(dbPath);
  console.error(`[restamp] re-baselining fingerprints for ${dbPath} to the current live schema`);
  await syncFingerprints(runner);
  console.error('[restamp] done. Run verifyHead to confirm ok:true.');
}
main().catch((e) => { console.error(`[restamp] FAILED: ${e.message}`); process.exit(1); });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/restamp-fingerprints.test.js`
Expected: PASS.

- [ ] **Step 5: Document the recovery verb**

In `AGENTS.md`, in the migration section, add:

```markdown
- **Stale-stamp recovery:** if `applyPending`/`verifyHead` report fingerprint drift after a crash between a migration commit and its stamp, and the live schema is confirmed correct, re-baseline with `node scripts/restamp-fingerprints.js /data/db/farming.db`. This is the ONLY sanctioned way to overwrite the fingerprint baseline; do not hand-edit `schema_object_fingerprints`.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/restamp-fingerprints.js scripts/restamp-fingerprints.test.js AGENTS.md
git commit -m "feat(migrate): restamp-fingerprints recovery verb for a stale post-crash stamp"
```

---

### Task 3: Busy timeout on the CLI runner

**Why:** *Minor gap (Fable).* Each CLI connection has no `busy_timeout`, so a `BEGIN IMMEDIATE` under any concurrent writer fails immediately with `SQLITE_BUSY`. Set it via `-cmd '.timeout N'` (verified: no output pollution). Also raise the **process** timeout above the **busy** timeout so a legitimate ~29s lock wait is not SIGKILLed with a confusing `ETIMEDOUT`.

**Files:**
- Modify: `lib/osi-migrate/runner-iface.js`
- Test: `lib/osi-migrate/__tests__/runner-iface.test.js`

- [ ] **Step 1: Write/confirm the no-pollution test**

Ensure `lib/osi-migrate/__tests__/runner-iface.test.js` contains:

```js
test('all() is not polluted by the busy-timeout pragma', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { cliRunner } = require('../runner-iface');
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iface-')), 't.db');
  const r = cliRunner(db);
  await r.exec('CREATE TABLE t(x);');
  assert.deepStrictEqual(await r.all('SELECT 1 AS x'), [{ x: 1 }]);
});
```

- [ ] **Step 2: Run test (guards against a polluting implementation)**

Run: `node --test lib/osi-migrate/__tests__/runner-iface.test.js`
Expected: PASS.

- [ ] **Step 3: Add the busy timeout and raise the process timeout**

In `lib/osi-migrate/runner-iface.js`, change ONLY the constants block (do not re-declare the existing `SQLITE_MAX_BUFFER`):

```js
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_TIMEOUT_MS = 120_000; // process timeout must exceed the busy timeout
const SQLITE_MAX_BUFFER = 64 * 1024 * 1024;
```

`exec`:

```js
    async exec(sqlText) {
      execFileSync('sqlite3',
        ['-bail', '-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, dbPath],
        { ...SQLITE_EXEC_OPTIONS, input: sqlText });
    },
```

`all`:

```js
    async all(sql) {
      const out = execFileSync('sqlite3',
        ['-json', '-cmd', `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, dbPath, sql],
        SQLITE_EXEC_OPTIONS).trim();
      return out ? JSON.parse(out) : [];
    },
```

Extend `module.exports` to add `SQLITE_BUSY_TIMEOUT_MS`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/osi-migrate/__tests__/runner-iface.test.js lib/osi-migrate/__tests__/runner-additive.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/runner-iface.js lib/osi-migrate/__tests__/runner-iface.test.js
git commit -m "fix(migrate): set sqlite busy_timeout on the CLI runner; raise process timeout above it"
```

---

### Task 4: Cap backup retention

**Why:** *Minor gap (Fable).* `backupDb` writes `.bak-<stamp>` siblings and never prunes — on the Pi's constrained storage they accumulate until the partition fills. Keep the newest N (default 5). (Note: pruning may eventually remove files referenced by older ledger `backup_path` rows — acceptable; those rows are audit history, not restore guarantees.)

**Files:**
- Modify: `lib/osi-migrate/backup.js`
- Test: `lib/osi-migrate/__tests__/backup.test.js`

- [ ] **Step 1: Write the failing test**

Append to `lib/osi-migrate/__tests__/backup.test.js`:

```js
test('pruneBackups keeps only the newest N .bak- siblings', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { pruneBackups } = require('../backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'));
  const db = path.join(dir, 'farming.db');
  fs.writeFileSync(db, 'x');
  for (const s of ['01', '02', '03', '04', '05', '06', '07', '08']) {
    fs.writeFileSync(`${db}.bak-2026-01-${s}`, 's');
  }
  const removed = pruneBackups(db, 5);
  const left = fs.readdirSync(dir).filter((f) => f.startsWith('farming.db.bak-')).sort();
  assert.strictEqual(removed, 3);
  assert.deepStrictEqual(left, [
    'farming.db.bak-2026-01-04', 'farming.db.bak-2026-01-05',
    'farming.db.bak-2026-01-06', 'farming.db.bak-2026-01-07',
    'farming.db.bak-2026-01-08']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/backup.test.js`
Expected: FAIL with "pruneBackups is not a function".

- [ ] **Step 3: Implement `pruneBackups` and call it from `backupDb`**

In `lib/osi-migrate/backup.js`, add `const path = require('node:path');` at the top, then:

```js
// ISO stamps sort lexically = chronologically. Keep the newest `keep`.
function pruneBackups(dbPath, keep = 5) {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.bak-`;
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  for (const f of excess) fs.unlinkSync(path.join(dir, f));
  return excess.length;
}
```

Change the `backupDb` signature to `async function backupDb(dbPath, { keep = 5 } = {})`, and just before `return backupPath;` add `pruneBackups(dbPath, keep);`. Extend `module.exports` to add `pruneBackups`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/osi-migrate/__tests__/backup.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/backup.js lib/osi-migrate/__tests__/backup.test.js
git commit -m "fix(migrate): cap migration backup retention (keep newest 5)"
```

---

### Task 5: Add the `data` risk class

**Why:** *Fable.* A backfill needs a backup but not the destructive machinery (writers-stopped + FK toggle). Add `data`: backup + normal transactional apply. Guidance to document: `data` migrations still normally run at deploy (they hold the write lock past `osi-db-helper`'s 5s busy timeout, so live writers would error during a long backfill), and must be written **idempotently** against the old row format (rows written by old code after the backfill commits aren't covered).

**Files:**
- Modify: `lib/osi-migrate/migrations-loader.js`, `lib/osi-migrate/runner.js`, `AGENTS.md`
- Test: `lib/osi-migrate/__tests__/runner-data-risk.test.js`

**Interfaces:** Consumes `backupDb(dbPath, {keep})` (Task 4), `successInsertSql`, `cliRunner`.

- [ ] **Step 1: Write the failing test**

Create `lib/osi-migrate/__tests__/runner-data-risk.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { applyPending } = require('../runner');
const { cliRunner } = require('../runner-iface');

test('a data-risk migration takes a backup and applies without writers stopped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-'));
  const dir = path.join(root, 'm'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '0001__seed.sql'),
    '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);\nINSERT INTO t (id, v) VALUES (1, 0);\n');
  fs.writeFileSync(path.join(dir, '0002__backfill.sql'),
    '-- risk: data\nUPDATE t SET v = 42 WHERE id = 1;\n');
  const db = path.join(root, 't.db');
  const r = cliRunner(db);
  const res = await applyPending(r, { migrationsDir: dir, appVersion: 'x' }); // writersStopped defaults false
  assert.deepStrictEqual(res.applied, [1, 2]);
  assert.strictEqual((await r.all('SELECT v FROM t WHERE id = 1'))[0].v, 42);
  assert.strictEqual(fs.readdirSync(root).filter((f) => f.startsWith('t.db.bak-')).length, 1,
    'data migration must create exactly one backup');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/runner-data-risk.test.js`
Expected: FAIL — the loader rejects `-- risk: data`.

- [ ] **Step 3: Accept `data` in the risk header regex**

In `lib/osi-migrate/migrations-loader.js`, change `RISK_RE` (line 7) to accept `data`:

```js
const RISK_RE = /^(?:﻿)?(?:[ \t]*\r?\n)*--\s*risk:\s*(additive|destructive|data)\s*(?:\r?\n|$)/;
```

and the error message (line 22) to `'-- risk: additive|destructive|data'`.

- [ ] **Step 4: Handle the `data` branch in `applyPending`**

In `applyPending`, add a branch between `destructive` and the additive `else`:

```js
      } else if (m.risk === 'data') {
        // Backfill: take a backup, apply in a normal transaction (no FK toggle,
        // no writers-stopped gate). Write data migrations idempotently vs the old format.
        backupPath = await backupDb(runner.dbPath);
        const insertWithBackup = successInsertSql({ version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath });
        await runner.exec(`BEGIN IMMEDIATE;\n${m.sql}\n${insertWithBackup}\nCOMMIT;`);
      } else {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/osi-migrate/__tests__/runner-data-risk.test.js lib/osi-migrate/__tests__/migrations-loader.test.js lib/osi-migrate/__tests__/runner-destructive.test.js`
Expected: PASS.

- [ ] **Step 6: Document the taxonomy**

In `AGENTS.md`, add:

```markdown
- `data` — data backfill/mutation: takes an online backup, applies in a normal transaction (no FK fence, no writers-stopped gate). Run at deploy (a long backfill holds the write lock past the 5s runtime busy timeout); write it idempotently against the pre-migration row format.
```

- [ ] **Step 7: Commit**

```bash
git add lib/osi-migrate/migrations-loader.js lib/osi-migrate/runner.js lib/osi-migrate/__tests__/runner-data-risk.test.js AGENTS.md
git commit -m "feat(migrate): add 'data' risk class (backup + plain transaction)"
```

---

### Task 7: Correct the ADR "eliminates" overstatement

**Why:** Both reviews flagged it. The boot node still owns inline DDL until Option B lands.

**Files:** Modify `docs/adr/2026-06-30-schema-and-contract-ownership.md`

- [ ] **Step 1: Reword the Consequences bullet**

Change line 41 from:

```markdown
- The edge gains a real, auditable migration system it currently lacks, eliminating the every-boot mutation class that caused the history-loss incident.
```

to:

```markdown
- The edge gains a real, auditable migration system it currently lacks. The boot node's every-boot mutation class (which caused the history-loss incident) is de-fanged by the guarded fail-closed rebuild (see the boot-node-devices-rebuild plan) and will be fully eliminated once the boot-path cutover (Option B) moves DDL to the runner.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/2026-06-30-schema-and-contract-ownership.md
git commit -m "docs(adr): boot-DDL is de-fanged now, eliminated at Option B (not yet)"
```

---

### Task 8: Link-aware, history-aware cloud-parity health check

**Why:** You've chosen cloud parity as the DR strategy. A parity check must NOT be fail-open. *Verified:* outbox triggers are gated on `sync_link_state.linked=1` (`seed-blank.sql:258`), so an **unlinked** gateway enqueues nothing → naive "pending=0" reads healthy while the mirror is arbitrarily behind. And history parity flows through `sync_history_dirty_keys` (status `pending`), NOT `sync_outbox`. The check must require `linked=1`, count pending dirty history keys, and consider delivery recency.

**Files:**
- Create: `scripts/check-sync-parity.js`, `scripts/check-sync-parity.test.js`, `docs/operations/cloud-parity-dr.md`
- Modify: `.github/workflows/migrations.yml`

**Interfaces:**
- `sync_link_state(peer_node, linked, …)`; `sync_outbox(…, occurred_at, delivered_at, rejected_at, …)`; `sync_history_dirty_keys(…, status, changed_at)`.
- Produces: `checkSyncParity(dbPath, { maxPendingAgeSec }) -> { linked, pending, pendingHistory, oldestPendingSec, rejected, lastDelivered, healthy }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/check-sync-parity.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkSyncParity } = require('./check-sync-parity');

function mkDb(linked) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'par-')), 'farming.db');
  execFileSync('sqlite3', ['-bail', db], { input:
    'CREATE TABLE sync_link_state (peer_node TEXT PRIMARY KEY, linked INTEGER NOT NULL DEFAULT 0);' +
    'CREATE TABLE sync_outbox (event_uuid TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, delivered_at TEXT, rejected_at TEXT);' +
    'CREATE TABLE sync_history_dirty_keys (peer_node TEXT, table_name TEXT, row_key TEXT, changed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', PRIMARY KEY(peer_node,table_name,row_key));' +
    `INSERT INTO sync_link_state(peer_node,linked) VALUES ('cloud',${linked});` });
  return db;
}

test('unlinked gateway is UNHEALTHY even with an empty outbox (no fail-open)', () => {
  const res = checkSyncParity(mkDb(0), { maxPendingAgeSec: 3600 });
  assert.strictEqual(res.linked, false);
  assert.strictEqual(res.healthy, false);
});

test('linked + delivered + no pending history = healthy; a reject or pending history flips it', () => {
  const db = mkDb(1);
  execFileSync('sqlite3', ['-bail', db], { input:
    "INSERT INTO sync_outbox VALUES ('a','2026-07-03T00:00:00Z','2026-07-03T00:00:01Z',NULL);" });
  assert.strictEqual(checkSyncParity(db, { maxPendingAgeSec: 3600 }).healthy, true);

  execFileSync('sqlite3', ['-bail', db], { input:
    "INSERT INTO sync_history_dirty_keys VALUES ('cloud','device_data','k','2026-07-03T00:00:00Z','pending');" });
  const res = checkSyncParity(db, { maxPendingAgeSec: 3600 });
  assert.strictEqual(res.pendingHistory, 1);
  assert.strictEqual(res.healthy, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/check-sync-parity.test.js`
Expected: FAIL with "Cannot find module './check-sync-parity'".

- [ ] **Step 3: Implement the check**

Create `scripts/check-sync-parity.js`:

```js
#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');

function q(db, sql) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

function checkSyncParity(dbPath, { maxPendingAgeSec = 3600 } = {}) {
  const linkRow = q(dbPath, "SELECT linked FROM sync_link_state WHERE peer_node='cloud'")[0];
  const linked = !!(linkRow && linkRow.linked);
  const pending = q(dbPath, "SELECT COUNT(*) c FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL")[0].c;
  const rejected = q(dbPath, "SELECT COUNT(*) c FROM sync_outbox WHERE rejected_at IS NOT NULL")[0].c;
  const pendingHistory = q(dbPath, "SELECT COUNT(*) c FROM sync_history_dirty_keys WHERE status='pending'")[0].c;
  const oldest = q(dbPath,
    "SELECT CAST((julianday('now') - julianday(MIN(occurred_at))) * 86400 AS INTEGER) s " +
    "FROM sync_outbox WHERE delivered_at IS NULL AND rejected_at IS NULL");
  const lastDelivered = q(dbPath, "SELECT MAX(delivered_at) d FROM sync_outbox")[0].d || null;
  // NULL oldest (no pending) -> 0; NULL/garbage occurred_at would make julianday NULL -> treat
  // as MAX (fail-safe, not fail-open).
  const rawOldest = oldest[0] ? oldest[0].s : 0;
  const oldestPendingSec = (pending > 0 && (rawOldest === null || rawOldest === undefined))
    ? Number.MAX_SAFE_INTEGER : (rawOldest || 0);
  const healthy = linked && rejected === 0 && pendingHistory === 0 && oldestPendingSec <= maxPendingAgeSec;
  return { linked, pending, pendingHistory, oldestPendingSec, rejected, lastDelivered, healthy };
}

if (require.main === module) {
  const res = checkSyncParity(process.argv[2] || '/data/db/farming.db', {});
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.healthy ? 0 : 1);
}

module.exports = { checkSyncParity };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/check-sync-parity.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the test into CI**

In `.github/workflows/migrations.yml`, after the existing `node --test lib/osi-migrate/__tests__/*.test.js` step (line 21), add a step:

```yaml
      - run: node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js
```

- [ ] **Step 6: Document the DR posture**

Create `docs/operations/cloud-parity-dr.md`:

```markdown
# Cloud parity as the edge DR strategy

The edge `farming.db` is the source of truth, but our disaster-recovery posture is
**cloud parity**: canonical changes are mirrored to OSI Server (which is backed up).
That is only a safety net while parity is *current*.

`check-sync-parity.js` is fail-SAFE: it reports UNHEALTHY when the gateway is not
`linked` to the cloud (nothing is being enqueued), when there are rejected events,
when history dirty-keys are pending, or when the oldest un-delivered event exceeds the
age threshold. Green means the DR net is actually current.

**Verify before any risky edge change** (schema migration, boot-node change, Option B):

    node scripts/check-sync-parity.js /data/db/farming.db   # exit 0 = safe to proceed

On-device note: this uses the `sqlite3` CLI. If a gateway lacks it (per project memory,
only some Pis have it installed), run the check from a workstation against a pulled copy,
or port it to the on-device node-sqlite3 binding.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/check-sync-parity.js scripts/check-sync-parity.test.js docs/operations/cloud-parity-dr.md .github/workflows/migrations.yml
git commit -m "feat(ops): link-aware, history-aware cloud-parity health check + DR doc"
```

---

## Roadmap — follow-on plans (sequenced; NOT executed in this plan)

1. **Boot-node `devices` rebuild fail-close (Option B-minus)** — its own plan/PR: `docs/superpowers/plans/2026-07-03-boot-node-devices-rebuild-failclose.md`. The only change to shipped runtime behavior.
2. **osi-server CI (P0 next).** Stand up build+test; wire `verify-sync-contract` into osi-os CI.
3. **Spec 2 Tranche A, re-scoped:** generate the `op`-name enum (the real `EdgeSyncService.java` coupling), dead-letter unknown ops, stamp `contract_version` into the event envelope now.
4. **`DeviceType.java` forward-tolerance** (opaque string + validate-where-branching + alarm; never reject).
5. **Option B proper** (boot-path cutover to the runner) at the next planned release, rehearsed on a Uganda-copy.
6. **Generate `seed-blank.sql` from replay; decompose `flows.json`.** Reconcile the runtime↔seed parity-guard semantics/docs (`setEq`).

---

## Self-Review

**Spec coverage:** laundering → Task 1; sort divergence → Task 2; stale-stamp recovery → Task R; busy_timeout + process-timeout → Task 3; unbounded backups → Task 4; `data` class → Task 5; ADR wording → Task 7; fail-open parity → Task 8; CI wiring for new tests → Task 8 Step 5. Boot-node rebuild → separate plan.

**Placeholder scan:** none; every code step shows complete code; every run step shows the command + expected result.

**Type consistency:** `sortFps`/`readStoredFingerprints` defined+exported in Task 1, consumed in Task 2 and (via `storedFps`) inline in Task 1; `syncFingerprints` (pre-existing export) consumed by Task R; `backupDb(dbPath,{keep})` updated in Task 4, called by the `data` branch in Task 5; `checkSyncParity(dbPath,{maxPendingAgeSec})` defined+consumed in Task 8.

**Ordering:** Task 2 depends on Task 1's helpers; Task R depends on the exported `syncFingerprints` (already present); Task 5's `data` branch depends on Task 4's `backupDb` signature. Execute in listed order. All tasks here are low-risk and CI-gated; none touches the device boot path.
```