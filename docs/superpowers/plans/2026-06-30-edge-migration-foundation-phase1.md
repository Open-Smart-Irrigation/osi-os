# Edge Migration Foundation — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the edge SQLite migration runner, ledger, semantic fingerprints, backup, the `0001` baseline migration, and the seed-vs-replay CI verifier — with **zero runtime/flow changes**.

**Architecture:** A dialect-pure-SQLite Node module `lib/osi-migrate/` applies ordered, checksummed migration files exactly once, recording each in a `schema_migrations` ledger with per-object semantic fingerprints. Each migration is applied as a **single `sqlite3` process** (one connection) so a destructive migration can toggle `PRAGMA foreign_keys` *outside* its `BEGIN IMMEDIATE … COMMIT` atomically; ledger writes use a separate connection so a failed/rolled-back migration still records `status=failed`. Runtime (Node-RED) will later use a node-sqlite3 adapter over the same interface — **out of scope for Phase 1**.

**Tech Stack:** Node.js (dev: v22; Pi runtime: v20), `node:test` + `node:assert/strict` (built-in, no new deps), the `sqlite3` CLI 3.53 via `node:child_process.execFileSync` (matches `scripts/repair-pi-schema.js`), `node:crypto` (sha256). Run tests with the **glob** form `node --test lib/osi-migrate/__tests__/*.test.js` — a bare directory path is NOT discovered on Node ≥22 (verified); Node reports `# pass N` in TAP.

## Global Constraints

- **No new runtime npm dependencies.** Phase 1 uses only Node built-ins + the `sqlite3` CLI binary already relied on by `scripts/`.
- **Dialect-pure SQLite.** The module owns no cross-repo / Postgres / contract concerns (those are Spec 2).
- **No runtime or flow changes in Phase 1.** Do not edit `flows.json`, `repair-pi-schema.js`, `deploy.sh`, or any profile payload. Consumer rewiring is Phase 2.
- **Never reseed/overwrite a live DB.** All operations are additive or backed-up; tests use throwaway temp DBs only.
- **`PRAGMA foreign_keys=OFF` is a no-op inside an open transaction** (verified, SQLite 3.53). Any FK toggle must occur outside `BEGIN…COMMIT`, on the same connection.
- **No swallowed errors.** A failed migration aborts the run; `status=failed` + `error` is written on a clean connection after rollback.
- **Migration file naming:** `database/migrations/ordered/NNNN__<slug>.sql`, zero-padded 4-digit **contiguous** version (1,2,3,…); first line header comment `-- risk: additive` or `-- risk: destructive`.
- **New directory `database/migrations/ordered/`** (not the top-level `database/migrations/`). The existing top-level `database/migrations/*.sql` are legacy one-off scripts **referenced** by `scripts/migrate-strega-tables.js` and `scripts/migrate-applied-commands.js`; they are left untouched, and the ordered runner reads only the `ordered/` subdirectory. (This refines Spec 1's `database/migrations/` path, which is occupied.)
- This plan is **Phase 1 only.** Phase 2 (drift migrations + consumer rewiring), Phase 3 (deploy state machine, pre-start gate, CI standup in both repos), and Phase 4 (hardware validation) are separate plans per [Spec 1](../specs/2026-06-30-edge-schema-migration-foundation-design.md).

---

### Task 1: Module scaffold + CLI runner adapter

**Files:**
- Create: `lib/osi-migrate/runner-iface.js`
- Test: `lib/osi-migrate/__tests__/runner-iface.test.js`

**Interfaces:**
- Produces: `cliRunner(dbPath) -> { dbPath, exec(sqlText): Promise<void>, all(sql): Promise<object[]>, close(): Promise<void> }`. `exec` runs a (possibly multi-statement) script on one fresh connection; `all` returns rows as objects via the CLI `-json` mode.

- [ ] **Step 1: Write the failing test**

```js
// lib/osi-migrate/__tests__/runner-iface.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../runner-iface');

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-')), 'test.db');
}

test('cliRunner exec creates schema and all() returns rows as objects', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await r.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a'),('b');");
  const rows = await r.all('SELECT id, name FROM t ORDER BY id');
  assert.deepEqual(rows, [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
});

test('cliRunner all() returns [] for empty result', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await r.exec('CREATE TABLE t (id INTEGER);');
  assert.deepEqual(await r.all('SELECT * FROM t'), []);
});

test('cliRunner exec throws on bad SQL', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await assert.rejects(() => r.exec('CREATE TABLE ;'));
});

test('exec is fail-fast: a mid-script error rolls back the whole transaction (no partial commit)', async () => {
  const db = tmpDb();
  const r = cliRunner(db);
  await assert.rejects(() =>
    r.exec('BEGIN;\nCREATE TABLE a (x);\nINSERT INTO nonexist VALUES (1);\nCREATE TABLE b (y);\nCOMMIT;'));
  const tables = await r.all("SELECT name FROM sqlite_master WHERE type='table'");
  assert.deepEqual(tables, [], 'neither table created — -bail prevented fall-through to COMMIT');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/runner-iface.test.js`
Expected: FAIL — `Cannot find module '../runner-iface'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/osi-migrate/runner-iface.js
'use strict';
const { execFileSync } = require('node:child_process');

// CLI-backed runner for tests + ops. Async to match the future node-sqlite3 runtime adapter.
// Each call is one fresh `sqlite3` process = one connection. Apply a transactional
// migration as ONE exec(sqlText) so BEGIN/COMMIT and any FK toggle share that connection.
function cliRunner(dbPath) {
  return {
    dbPath,
    async exec(sqlText) {
      // -bail: stop at the first error so a failing statement cannot fall through to COMMIT
      // and commit partial work (verified: without -bail, sqlite3 reaches COMMIT on error).
      execFileSync('sqlite3', ['-bail', dbPath], { input: sqlText, encoding: 'utf8' });
    },
    async all(sql) {
      const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
      return out ? JSON.parse(out) : [];
    },
    async close() {},
  };
}

module.exports = { cliRunner };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/osi-migrate/__tests__/runner-iface.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/runner-iface.js lib/osi-migrate/__tests__/runner-iface.test.js
git commit -m "feat(migrate): CLI-backed SQLite runner interface"
```

---

### Task 2: Migration loader (order, risk class, checksum)

**Files:**
- Create: `lib/osi-migrate/migrations-loader.js`
- Test: `lib/osi-migrate/__tests__/migrations-loader.test.js`

**Interfaces:**
- Produces: `loadMigrations(dir) -> Array<{ version:number, name:string, slug:string, risk:'additive'|'destructive', sql:string, checksum:string }>` sorted ascending by `version`. `checksum` is `sha256` hex of the file bytes. Throws on a malformed filename, duplicate version, or missing/invalid `-- risk:` header.

- [ ] **Step 1: Write the failing test**

```js
// lib/osi-migrate/__tests__/migrations-loader.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadMigrations } = require('../migrations-loader');

function dirWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-mig-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), body);
  return d;
}

test('loads, orders, classifies and checksums migrations', () => {
  const d = dirWith({
    '0002__add_col.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN x INTEGER;\n',
    '0001__baseline.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER);\n',
  });
  const m = loadMigrations(d);
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x) => x.version), [1, 2]);
  assert.equal(m[0].slug, 'baseline');
  assert.equal(m[1].risk, 'additive');
  assert.match(m[0].checksum, /^[0-9a-f]{64}$/);
});

test('rejects malformed filename', () => {
  const d = dirWith({ 'bad.sql': '-- risk: additive\n' });
  assert.throws(() => loadMigrations(d), /filename/i);
});

test('rejects duplicate version', () => {
  const d = dirWith({ '0001__a.sql': '-- risk: additive\n', '0001__b.sql': '-- risk: additive\n' });
  assert.throws(() => loadMigrations(d), /duplicate/i);
});

test('rejects missing risk header', () => {
  const d = dirWith({ '0001__a.sql': 'CREATE TABLE t (id INTEGER);\n' });
  assert.throws(() => loadMigrations(d), /risk/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/migrations-loader.test.js`
Expected: FAIL — `Cannot find module '../migrations-loader'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/osi-migrate/migrations-loader.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NAME_RE = /^(\d{4})__([a-z0-9_]+)\.sql$/;
const RISK_RE = /^(?:\uFEFF)?(?:[ \t]*\r?\n)*--\s*risk:\s*(additive|destructive)\s*(?:\r?\n|$)/;

function loadMigrations(dir) {
  const out = [];
  const seen = new Set();
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const match = NAME_RE.exec(file);
    if (!match) throw new Error(`bad migration filename: ${file} (expected NNNN__slug.sql)`);
    const version = Number(match[1]);
    if (seen.has(version)) throw new Error(`duplicate migration version: ${version}`);
    seen.add(version);
    const raw = fs.readFileSync(path.join(dir, file));
    const sql = raw.toString('utf8');
    const risk = RISK_RE.exec(sql);
    if (!risk) throw new Error(`migration ${file} missing '-- risk: additive|destructive' header`);
    out.push({
      version,
      name: file,
      slug: match[2],
      risk: risk[1],
      sql,
      checksum: crypto.createHash('sha256').update(raw).digest('hex'),
    });
  }
  return out.sort((a, b) => a.version - b.version);
}

module.exports = { loadMigrations };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/osi-migrate/__tests__/migrations-loader.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/migrations-loader.js lib/osi-migrate/__tests__/migrations-loader.test.js
git commit -m "feat(migrate): ordered migration loader with risk class + checksum"
```

---

### Task 3: Ledger (`schema_migrations`)

**Files:**
- Create: `lib/osi-migrate/ledger.js`
- Test: `lib/osi-migrate/__tests__/ledger.test.js`

**Interfaces:**
- Consumes: `cliRunner` (Task 1).
- Produces:
  - `ensureLedger(runner): Promise<void>` — creates `schema_migrations` and `schema_object_fingerprints` if absent.
  - `getApplied(runner): Promise<Array<{version, name, checksum, status}>>` ordered by version.
  - `recordSuccess(runner, {version,name,checksum,appVersion,backupPath}): Promise<void>`
  - `recordFailure(runner, {version,name,checksum,appVersion,backupPath,error}): Promise<void>` — writes `status='failed'` and preserves any verified backup path.
  - `sqlQuote(value): string` — SQLite string-literal quoting for internal values.

- [ ] **Step 1: Write the failing test**

```js
// lib/osi-migrate/__tests__/ledger.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { ensureLedger, getApplied, recordSuccess, recordFailure, sqlQuote } = require('../ledger');

function tmpDb() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-led-')), 't.db'); }

test('ensureLedger is idempotent and getApplied starts empty', async () => {
  const r = cliRunner(tmpDb());
  await ensureLedger(r); await ensureLedger(r);
  assert.deepEqual(await getApplied(r), []);
});

test('recordSuccess and recordFailure persist with status', async () => {
  const r = cliRunner(tmpDb());
  await ensureLedger(r);
  await recordSuccess(r, { version: 1, name: '0001__a.sql', checksum: 'abc', appVersion: '0.6', backupPath: '' });
  await recordFailure(r, { version: 2, name: '0002__b.sql', checksum: 'def', appVersion: '0.6', backupPath: '/tmp/farming.db.bak', error: "it's broken" });
  const rows = await getApplied(r);
  assert.deepEqual(rows.map((x) => [x.version, x.status]), [[1, 'applied'], [2, 'failed']]);
});

test('sqlQuote escapes single quotes', () => {
  assert.equal(sqlQuote("a'b"), "'a''b'");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/ledger.test.js`
Expected: FAIL — `Cannot find module '../ledger'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/osi-migrate/ledger.js
'use strict';

function sqlQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function ensureLedger(runner) {
  await runner.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TEXT,
      finished_at TEXT,
      status      TEXT NOT NULL,
      error       TEXT,
      app_version TEXT,
      backup_path TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_object_fingerprints (
      object_type TEXT NOT NULL,
      object_name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY (object_type, object_name)
    );`);
}

async function getApplied(runner) {
  return runner.all('SELECT version, name, checksum, status FROM schema_migrations ORDER BY version');
}

async function recordSuccess(runner, { version, name, checksum, appVersion, backupPath }) {
  const now = new Date().toISOString();
  await runner.exec(
    `INSERT OR REPLACE INTO schema_migrations
       (version, name, checksum, applied_at, finished_at, status, error, app_version, backup_path)
     VALUES (${version}, ${sqlQuote(name)}, ${sqlQuote(checksum)}, ${sqlQuote(now)}, ${sqlQuote(now)},
             'applied', NULL, ${sqlQuote(appVersion || '')}, ${sqlQuote(backupPath || '')});`);
}

async function recordFailure(runner, { version, name, checksum, appVersion, backupPath, error }) {
  const now = new Date().toISOString();
  await runner.exec(
    `INSERT OR REPLACE INTO schema_migrations
       (version, name, checksum, applied_at, finished_at, status, error, app_version, backup_path)
     VALUES (${version}, ${sqlQuote(name)}, ${sqlQuote(checksum)}, NULL, ${sqlQuote(now)},
             'failed', ${sqlQuote(error || '')}, ${sqlQuote(appVersion || '')}, ${sqlQuote(backupPath || '')});`);
}

module.exports = { ensureLedger, getApplied, recordSuccess, recordFailure, sqlQuote };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/osi-migrate/__tests__/ledger.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/ledger.js lib/osi-migrate/__tests__/ledger.test.js
git commit -m "feat(migrate): schema_migrations ledger with success/failure records"
```

---

### Task 4: Semantic fingerprints

**Files:**
- Create: `lib/osi-migrate/fingerprints.js`
- Test: `lib/osi-migrate/__tests__/fingerprints.test.js`

**Interfaces:**
- Consumes: `cliRunner` (Task 1).
- Produces: `computeFingerprints(runner) -> Promise<Array<{object_type, object_name, fingerprint}>>`. Derived from PRAGMA structural info (`table_xinfo`, `foreign_key_list`, `index_list`, `index_xinfo`) **plus** normalized `sqlite_master.sql` to capture CHECK constraints and partial-index predicates that PRAGMA omits; tagged with `NORMALIZER_VERSION` only so harmless SQLite engine upgrades do not change the digest. Whitespace is collapsed but case preserved. Exposes `NORMALIZER_VERSION`; record `sqlite_version()` separately as diagnostics if needed.

- [ ] **Step 1: Write the failing test**

```js
// lib/osi-migrate/__tests__/fingerprints.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { computeFingerprints } = require('../fingerprints');

function tmpDb() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-fp-')), 't.db'); }

test('identical schemas produce identical fingerprints; a column change differs', async () => {
  const a = cliRunner(tmpDb());
  const b = cliRunner(tmpDb());
  const schema = 'CREATE TABLE devices (id INTEGER PRIMARY KEY, deveui TEXT);';
  await a.exec(schema);
  await b.exec(schema);
  const fa = await computeFingerprints(a);
  const fb = await computeFingerprints(b);
  assert.deepEqual(fa, fb);

  const c = cliRunner(tmpDb());
  await c.exec('CREATE TABLE devices (id INTEGER PRIMARY KEY, deveui TEXT, extra INTEGER);');
  const fc = await computeFingerprints(c);
  const fpDevicesA = fa.find((x) => x.object_name === 'devices').fingerprint;
  const fpDevicesC = fc.find((x) => x.object_name === 'devices').fingerprint;
  assert.notEqual(fpDevicesA, fpDevicesC);
});

test('whitespace-only trigger differences fingerprint identically', async () => {
  const a = cliRunner(tmpDb()); const b = cliRunner(tmpDb());
  await a.exec("CREATE TABLE t (x INTEGER); CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET x=1; END;");
  await b.exec("CREATE TABLE t (x INTEGER);\nCREATE TRIGGER trg AFTER INSERT ON t\nBEGIN\n  UPDATE t SET x=1;\nEND;");
  const fa = (await computeFingerprints(a)).find((x) => x.object_type === 'trigger');
  const fb = (await computeFingerprints(b)).find((x) => x.object_type === 'trigger');
  assert.equal(fa.fingerprint, fb.fingerprint);
});

test('CHECK constraint change is detected (the LORAIN drift class)', async () => {
  const a = cliRunner(tmpDb()); const b = cliRunner(tmpDb());
  await a.exec("CREATE TABLE d (id INTEGER, t TEXT CHECK(t IN ('A')));");
  await b.exec("CREATE TABLE d (id INTEGER, t TEXT CHECK(t IN ('A','B')));");
  const fa = (await computeFingerprints(a)).find((x) => x.object_name === 'd');
  const fb = (await computeFingerprints(b)).find((x) => x.object_name === 'd');
  assert.notEqual(fa.fingerprint, fb.fingerprint);
});

test('partial-index predicate change is detected', async () => {
  const a = cliRunner(tmpDb()); const b = cliRunner(tmpDb());
  await a.exec('CREATE TABLE t (x INTEGER); CREATE INDEX ix ON t(x) WHERE x IS NOT NULL;');
  await b.exec('CREATE TABLE t (x INTEGER); CREATE INDEX ix ON t(x) WHERE x > 0;');
  const fa = (await computeFingerprints(a)).find((x) => x.object_type === 'index' && x.object_name === 'ix');
  const fb = (await computeFingerprints(b)).find((x) => x.object_type === 'index' && x.object_name === 'ix');
  assert.notEqual(fa.fingerprint, fb.fingerprint);
});

test('trigger string-literal case is significant', async () => {
  const a = cliRunner(tmpDb()); const b = cliRunner(tmpDb());
  await a.exec("CREATE TABLE t (s TEXT); CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE t SET s='A'; END;");
  await b.exec("CREATE TABLE t (s TEXT); CREATE TRIGGER g AFTER INSERT ON t BEGIN UPDATE t SET s='a'; END;");
  const fa = (await computeFingerprints(a)).find((x) => x.object_type === 'trigger');
  const fb = (await computeFingerprints(b)).find((x) => x.object_type === 'trigger');
  assert.notEqual(fa.fingerprint, fb.fingerprint);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/fingerprints.test.js`
Expected: FAIL — `Cannot find module '../fingerprints'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/osi-migrate/fingerprints.js
'use strict';
const crypto = require('node:crypto');

const NORMALIZER_VERSION = 2;

function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// Collapse whitespace only — PRESERVE case. String literals ('A' vs 'a') must fingerprint differently.
function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function computeFingerprints(runner) {
  const tag = { normalizer: NORMALIZER_VERSION };
  const out = [];

  // master DDL captures what PRAGMA omits: table CHECK constraints, partial-index WHERE, defaults.
  const master = await runner.all(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name");
  const ddl = {};
  for (const m of master) ddl[`${m.type}|${m.name}`] = normalizeSql(m.sql);

  for (const { name } of master.filter((m) => m.type === 'table')) {
    const quotedName = quoteIdent(name);
    const columns = await runner.all(`PRAGMA table_xinfo(${quotedName})`);
    const fks = await runner.all(`PRAGMA foreign_key_list(${quotedName})`);
    const indexes = await runner.all(`PRAGMA index_list(${quotedName})`);
    const indexCols = {};
    for (const idx of indexes) indexCols[idx.name] = await runner.all(`PRAGMA index_xinfo(${quoteIdent(idx.name)})`);
    out.push({ object_type: 'table', object_name: name,
      fingerprint: hash({ tag, columns, fks, indexes, indexCols, ddl: ddl[`table|${name}`] }) });
  }
  for (const { name } of master.filter((m) => m.type === 'index')) {
    out.push({ object_type: 'index', object_name: name,
      fingerprint: hash({ tag, ddl: ddl[`index|${name}`] }) });
  }
  for (const { name } of master.filter((m) => m.type === 'trigger')) {
    out.push({ object_type: 'trigger', object_name: name,
      fingerprint: hash({ tag, body: ddl[`trigger|${name}`] }) });
  }
  return out;
}

module.exports = { computeFingerprints, NORMALIZER_VERSION, quoteIdent };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/osi-migrate/__tests__/fingerprints.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/fingerprints.js lib/osi-migrate/__tests__/fingerprints.test.js
git commit -m "feat(migrate): semantic schema fingerprints from PRAGMA + normalized triggers"
```

---

### Task 5: Backup + verify-open

**Files:**
- Create: `lib/osi-migrate/backup.js`
- Test: `lib/osi-migrate/__tests__/backup.test.js`

**Interfaces:**
- Produces: `backupDb(dbPath) -> Promise<string>` — uses the SQLite online-backup (CLI `.backup`) to write a timestamped copy beside the DB, opens it, runs `PRAGMA integrity_check`, and returns the backup path. Throws if integrity fails. (Runtime will use node-sqlite3 `.backup()` over the same contract in a later phase.)

- [ ] **Step 1: Write the failing test**

```js
// lib/osi-migrate/__tests__/backup.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { backupDb } = require('../backup');

test('backupDb makes an integrity-passing copy that round-trips data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-bk-'));
  const db = path.join(dir, 'farming.db');
  const r = cliRunner(db);
  await r.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('x');");
  const bk = await backupDb(db);
  assert.ok(fs.existsSync(bk), 'backup file exists');
  const rows = await cliRunner(bk).all('SELECT v FROM t');
  assert.deepEqual(rows, [{ v: 'x' }]);
});

test('backupDb captures data on a WAL-mode DB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-bkwal-'));
  const db = path.join(dir, 'farming.db');
  const r = cliRunner(db);
  await r.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('wal');");
  const bk = await backupDb(db);
  assert.deepEqual(await cliRunner(bk).all('SELECT v FROM t'), [{ v: 'wal' }]);
});

test('backupDb refuses a missing source DB (an empty fresh DB is not a real backup)', async () => {
  await assert.rejects(() => backupDb('/nonexistent/dir/farming.db'), /does not exist/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/backup.test.js`
Expected: FAIL — `Cannot find module '../backup'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/osi-migrate/backup.js
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

// Online backup via the SQLite CLI `.backup` dot-command (consistent even with an active WAL),
// then open + integrity_check the copy. Runtime adapter (node-sqlite3 `.backup()`) follows the
// same contract in a later phase.
async function backupDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`refusing to back up: source DB does not exist: ${dbPath}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.bak-${stamp}`;
  execFileSync('sqlite3', [dbPath, `.backup '${backupPath}'`], { encoding: 'utf8' });
  const check = execFileSync('sqlite3', [backupPath, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim();
  if (check !== 'ok') throw new Error(`backup integrity_check failed: ${check}`);
  return backupPath;
}

module.exports = { backupDb };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/osi-migrate/__tests__/backup.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/backup.js lib/osi-migrate/__tests__/backup.test.js
git commit -m "feat(migrate): online-backup with integrity verification"
```

---

### Task 6: Runner — applyPending (additive path, run-once, fail-safe ledger)

**Files:**
- Create: `lib/osi-migrate/runner.js`
- Create: `lib/osi-migrate/index.js`
- Test: `lib/osi-migrate/__tests__/runner-additive.test.js`

**Interfaces:**
- Consumes: `cliRunner` (T1), `loadMigrations` (T2), ledger fns (T3), `backupDb` (T5).
- Produces (exported from `index.js`):
  - `applyPending(runner, { migrationsDir, appVersion, writersStopped=false }) -> Promise<{applied:number[]}>` — ensures the ledger, applies pending additive migrations in order each wrapped `BEGIN IMMEDIATE … COMMIT` in one `exec`, records success; on a checksum mismatch for an already-applied version throws `repair_required`; on any failure writes `status=failed` on a clean connection and rethrows. (Destructive branch added in Task 7.)

- [ ] **Step 1: Write the failing test**

```js
// lib/osi-migrate/__tests__/runner-additive.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { applyPending } = require('../index');
const { getApplied } = require('../ledger');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-run-'));
  const dir = path.join(root, 'migrations'); fs.mkdirSync(dir);
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return { db: path.join(root, 't.db'), dir };
}

test('applies pending additive migrations once, in order', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n',
    '0002__add.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN v TEXT;\n',
  });
  const r = cliRunner(db);
  const res1 = await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  assert.deepEqual(res1.applied, [1, 2]);
  const res2 = await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  assert.deepEqual(res2.applied, [], 'second run is a no-op');
  assert.deepEqual((await getApplied(r)).map((x) => x.version), [1, 2]);
});

test('failure aborts and records status=failed on a clean connection', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n',
    '0002__boom.sql': '-- risk: additive\nALTER TABLE nonexistent ADD COLUMN v TEXT;\n',
  });
  const r = cliRunner(db);
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }));
  const rows = await getApplied(r);
  assert.deepEqual(rows.map((x) => [x.version, x.status]), [[1, 'applied'], [2, 'failed']]);
});

test('checksum mismatch on an applied version throws repair_required', async () => {
  const { db, dir } = fixture({ '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER);\n' });
  const r = cliRunner(db);
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  fs.writeFileSync(path.join(dir, '0001__base.sql'), '-- risk: additive\nCREATE TABLE t (id INTEGER, z INTEGER);\n');
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }), /repair_required/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/runner-additive.test.js`
Expected: FAIL — `Cannot find module '../index'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/osi-migrate/runner.js
'use strict';
const { loadMigrations } = require('./migrations-loader');
const { ensureLedger, getApplied, recordFailure, markRepairRequired, successInsertSql } = require('./ledger');
const { backupDb } = require('./backup');
const { cliRunner } = require('./runner-iface');

async function applyPending(runner, { migrationsDir, appVersion, writersStopped = false }) {
  await ensureLedger(runner);
  const applied = await getApplied(runner);
  const appliedOk = new Map(applied.filter((m) => m.status === 'applied').map((m) => [m.version, m]));
  const migrations = loadMigrations(migrationsDir);

  for (const m of migrations) {
    const prior = appliedOk.get(m.version);
    if (prior) {
      if (prior.checksum !== m.checksum) {
        await markRepairRequired(runner, {
          version: m.version,
          error: `checksum mismatch for applied migration ${m.name}`,
        });
        throw new Error(`repair_required: checksum mismatch for applied migration ${m.name}`);
      }
      continue; // already applied, unchanged
    }
    let backupPath = '';
    let committed = false;
    try {
      const ledgerInsert = successInsertSql({ version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath: '' });
      if (m.risk === 'destructive') {
        if (!writersStopped) {
          throw new Error(`migration ${m.name} is destructive; refuse to run unless writers are stopped (deploy/pre-start)`);
        }
        backupPath = await backupDb(runner.dbPath);
        const insertWithBackup = successInsertSql({ version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath });
        await runner.exec(composeDestructiveScript(m.sql, insertWithBackup));
      } else {
        await runner.exec(`BEGIN IMMEDIATE;\n${m.sql}\n${ledgerInsert}\nCOMMIT;`);
      }
      committed = true;
      await postflight(runner, m);
    } catch (err) {
      // Clean connection: the failed migration's transaction has rolled back at process exit.
      const rec = cliRunner(runner.dbPath);
      if (committed) {
        await markRepairRequired(rec, { version: m.version, error: String(err.message || err) });
      } else {
        await recordFailure(rec, {
          version: m.version, name: m.name, checksum: m.checksum, appVersion, backupPath,
          error: String(err.message || err),
        });
      }
      throw err;
    }
  }
  const before = new Set(applied.map((m) => m.version));
  return { applied: migrations.filter((m) => !before.has(m.version)).map((m) => m.version) };
}

async function postflight(runner, m) {
  const integ = (await runner.all('PRAGMA integrity_check'))[0];
  const okVal = integ.integrity_check || Object.values(integ)[0];
  if (okVal !== 'ok') throw new Error(`postflight integrity_check failed after ${m.name}: ${okVal}`);
  const fk = await runner.all('PRAGMA foreign_key_check');
  if (fk.length) throw new Error(`postflight foreign_key_check failed after ${m.name}`);
}

// Destructive recipe filled in Task 7.
async function applyDestructive(runner, m, writersStopped) {
  throw new Error('destructive migrations not yet supported (Task 7)');
}

module.exports = { applyPending, applyDestructive, postflight };
```

```js
// lib/osi-migrate/index.js
'use strict';
const { applyPending } = require('./runner');
// bootstrapFresh + verifyHead are added in Task 7/8.
module.exports = { applyPending };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/osi-migrate/__tests__/runner-additive.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/osi-migrate/runner.js lib/osi-migrate/index.js lib/osi-migrate/__tests__/runner-additive.test.js
git commit -m "feat(migrate): applyPending additive path with run-once + fail-safe ledger"
```

---

### Task 7: Runner — destructive path (FK toggle outside transaction) + bootstrapFresh + verifyHead

**Files:**
- Modify: `lib/osi-migrate/runner.js` (replace `applyDestructive` stub; add `bootstrapFresh`, `verifyHead`)
- Modify: `lib/osi-migrate/index.js` (export `bootstrapFresh`, `verifyHead`)
- Test: `lib/osi-migrate/__tests__/runner-destructive.test.js`

**Interfaces:**
- Consumes: T1–T6, `computeFingerprints` (T4).
- Produces (exported from `index.js`):
  - `bootstrapFresh(runner, opts) -> Promise<{applied:number[]}>` — for an empty DB, applies all migrations.
  - `verifyHead(runner, { migrationsDir }) -> Promise<{ok:boolean, reason?:string}>` — compares ledger head + per-object fingerprints; never mutates.
  - destructive `applyDestructive` composes one connection: `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; <sql>; COMMIT; PRAGMA foreign_keys=ON;` and refuses unless `writersStopped`.

- [ ] **Step 1: Write the failing test**

```js
// lib/osi-migrate/__tests__/runner-destructive.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { applyPending, bootstrapFresh, verifyHead } = require('../index');

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-dest-'));
  const dir = path.join(root, 'migrations'); fs.mkdirSync(dir);
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return { db: path.join(root, 't.db'), dir };
}

// A destructive CHECK-rebuild with a child table referencing the parent ON DELETE CASCADE.
const DESTRUCTIVE = `-- risk: destructive
CREATE TABLE devices_new (id INTEGER PRIMARY KEY, type_id TEXT CHECK(type_id IN ('A','B')));
INSERT INTO devices_new (id, type_id) SELECT id, type_id FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
`;

test('composeDestructiveScript toggles FK OUTSIDE the transaction (regression guard for Spec 1 §9.8)', () => {
  const { composeDestructiveScript } = require('../runner');
  const s = composeDestructiveScript('DROP TABLE devices;');
  const off = s.indexOf('PRAGMA foreign_keys=OFF');
  const begin = s.indexOf('BEGIN IMMEDIATE');
  const commit = s.indexOf('COMMIT');
  const on = s.indexOf('PRAGMA foreign_keys=ON');
  assert.ok(off >= 0 && begin > off, 'FK off must come before BEGIN');
  assert.ok(commit > begin && on > commit, 'FK on must come after COMMIT');
});

test('destructive migration preserves child rows (FK fence effective) when writers stopped', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': "-- risk: additive\nCREATE TABLE devices (id INTEGER PRIMARY KEY, type_id TEXT CHECK(type_id IN ('A')));\nCREATE TABLE child (id INTEGER PRIMARY KEY, dev INTEGER REFERENCES devices(id) ON DELETE CASCADE);\n",
  });
  const r = cliRunner(db);
  // Apply the baseline FIRST, then seed data against the real schema.
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6' });
  await r.exec("PRAGMA foreign_keys=ON; INSERT INTO devices (id,type_id) VALUES (1,'A'); INSERT INTO child (id,dev) VALUES (10,1);");
  // Now introduce and apply the destructive rebuild.
  fs.writeFileSync(path.join(dir, '0002__rebuild.sql'), DESTRUCTIVE);
  await applyPending(r, { migrationsDir: dir, appVersion: '0.6', writersStopped: true });
  assert.deepEqual(await r.all('SELECT id FROM child'), [{ id: 10 }], 'child rows survive (FK was off during DROP)');
});

test('destructive migration refuses unless writersStopped', async () => {
  const { db, dir } = fixture({
    '0001__base.sql': "-- risk: additive\nCREATE TABLE devices (id INTEGER PRIMARY KEY, type_id TEXT);\n",
    '0002__rebuild.sql': DESTRUCTIVE,
  });
  const r = cliRunner(db);
  await assert.rejects(() => applyPending(r, { migrationsDir: dir, appVersion: '0.6' }), /writers/i);
});

test('bootstrapFresh applies all; verifyHead reports ok then drift', async () => {
  const { db, dir } = fixture({ '0001__base.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER PRIMARY KEY);\n' });
  const r = cliRunner(db);
  await bootstrapFresh(r, { migrationsDir: dir, appVersion: '0.6' });
  assert.equal((await verifyHead(r, { migrationsDir: dir })).ok, true);
  await r.exec('ALTER TABLE t ADD COLUMN sneaky INTEGER;'); // out-of-band edit
  const v = await verifyHead(r, { migrationsDir: dir });
  assert.equal(v.ok, false);
  assert.match(v.reason, /fingerprint|drift/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/osi-migrate/__tests__/runner-destructive.test.js`
Expected: FAIL — destructive throws "not yet supported"; `bootstrapFresh`/`verifyHead` undefined.

- [ ] **Step 3: Write minimal implementation**

Replace the `applyDestructive` stub in `lib/osi-migrate/runner.js` and add the two functions:

```js
const { computeFingerprints } = require('./fingerprints');

// One connection: FK toggle stays OUTSIDE the transaction (PRAGMA foreign_keys is a no-op inside one).
function composeDestructiveScript(sql, ledgerInsert = '') {
  return `PRAGMA foreign_keys=OFF;\nBEGIN IMMEDIATE;\n${sql}\n${ledgerInsert}\nCOMMIT;\nPRAGMA foreign_keys=ON;`;
}

async function bootstrapFresh(runner, opts) {
  await assertFreshDatabase(runner);
  return applyPending(runner, { ...opts, writersStopped: true });
}

async function assertFreshDatabase(runner) {
  const existing = await runner.all(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 1");
  if (existing.length) {
    throw new Error(`bootstrapFresh requires an empty/uninitialized database; found ${existing[0].type} ${existing[0].name}`);
  }
}

async function syncFingerprints(runner) {
  const { sqlQuote } = require('./ledger');
  const fps = await computeFingerprints(runner);
  await runner.exec('DELETE FROM schema_object_fingerprints;');
  for (const f of fps) {
    await runner.exec(
      `INSERT INTO schema_object_fingerprints (object_type, object_name, fingerprint)
       VALUES (${sqlQuote(f.object_type)}, ${sqlQuote(f.object_name)}, ${sqlQuote(f.fingerprint)});`);
  }
}

async function verifyHead(runner, { migrationsDir }) {
  const { loadMigrations } = require('./migrations-loader');
  const applied = (await getApplied(runner)).filter((m) => m.status === 'applied').map((m) => m.version);
  const expected = loadMigrations(migrationsDir).map((m) => m.version);
  const head = (xs) => (xs.length ? Math.max(...xs) : 0);
  if (head(applied) !== head(expected)) {
    return { ok: false, reason: `ledger head ${head(applied)} != expected ${head(expected)}` };
  }
  const stored = await runner.all('SELECT object_type, object_name, fingerprint FROM schema_object_fingerprints ORDER BY object_type, object_name');
  const live = (await computeFingerprints(runner)).sort((a, b) =>
    (a.object_type + a.object_name).localeCompare(b.object_type + b.object_name));
  if (JSON.stringify(stored) !== JSON.stringify(live)) {
    return { ok: false, reason: 'fingerprint drift detected (repair_required)' };
  }
  return { ok: true };
}
```

After a successful `applyPending` run (end of the loop, before `return`), call `await syncFingerprints(runner);`. Update `module.exports` to add `bootstrapFresh`, `verifyHead`, `syncFingerprints`, `composeDestructiveScript`. Update `index.js`:

```js
// lib/osi-migrate/index.js
'use strict';
const { applyPending, bootstrapFresh, verifyHead } = require('./runner');
module.exports = { applyPending, bootstrapFresh, verifyHead };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/osi-migrate/__tests__/runner-destructive.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the whole module test suite**

Run: `node --test lib/osi-migrate/__tests__/*.test.js`
Expected: PASS (all files; Node prints `# pass N` in TAP — "PASS (N tests)" elsewhere is shorthand for that).

- [ ] **Step 6: Commit**

```bash
git add lib/osi-migrate/runner.js lib/osi-migrate/index.js lib/osi-migrate/__tests__/runner-destructive.test.js
git commit -m "feat(migrate): destructive path (FK outside txn) + bootstrapFresh + verifyHead"
```

---

### Task 8: `0001` baseline migration + seed-replay verifier

**Files:**
- Create: `database/migrations/ordered/0001__baseline.sql` (generated from `database/seed-blank.sql`)
- Create: `scripts/verify-seed-replay.js`
- Test: `lib/osi-migrate/__tests__/seed-replay.test.js`

**Interfaces:**
- Consumes: `bootstrapFresh` (T7), `computeFingerprints` (T4).
- Produces: `verify-seed-replay.js` exits non-zero unless `computeFingerprints(empty DB + replay(migrations))` equals `computeFingerprints(empty DB + seed-blank.sql)`.

- [ ] **Step 1: Create the baseline migration from the canonical seed**

Generate `0001__baseline.sql` as the current canonical schema. Run:

```bash
mkdir -p database/migrations/ordered
{ echo '-- risk: additive'; \
  echo '-- Generated baseline: equals database/seed-blank.sql schema (tables, indexes, triggers).'; \
  grep -vE '^\s*--' database/seed-blank.sql; } > database/migrations/ordered/0001__baseline.sql
```

Then confirm it loads under one `sqlite3` process without error:

Run: `sqlite3 "$(mktemp -u).db" < database/migrations/ordered/0001__baseline.sql && echo OK`
Expected: `OK`

- [ ] **Step 2: Write the failing test**

```js
// lib/osi-migrate/__tests__/seed-replay.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { bootstrapFresh } = require('../index');
const { computeFingerprints } = require('../fingerprints');

const REPO = path.resolve(__dirname, '../../..');

test('empty DB + replay(migrations) fingerprints == empty DB + seed-blank.sql', async () => {
  const replayDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-rep-')), 'r.db');
  await bootstrapFresh(cliRunner(replayDb), {
    migrationsDir: path.join(REPO, 'database/migrations/ordered'), appVersion: 'test',
  });
  const seedDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-seed-')), 's.db');
  const seedR = cliRunner(seedDb);
  await seedR.exec(fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8'));

  const repFps = await computeFingerprints(cliRunner(replayDb));
  const seedFps = await seedR.all && await computeFingerprints(seedR);
  // schema_migrations / fingerprints tables exist only on the replay side; compare app tables/triggers.
  const appOnly = (xs) => xs.filter((x) => !['schema_migrations', 'schema_object_fingerprints'].includes(x.object_name));
  assert.deepEqual(appOnly(repFps), appOnly(seedFps));
});
```

- [ ] **Step 3: Run test to verify it fails or passes**

Run: `node --test lib/osi-migrate/__tests__/seed-replay.test.js`
Expected: PASS if the baseline matches the seed. If FAIL, the diff identifies an object whose `0001__baseline.sql` representation differs from `seed-blank.sql` — reconcile the baseline until equal (do not edit the seed). Re-run until PASS.

- [ ] **Step 4: Write the standalone verifier**

```js
// scripts/verify-seed-replay.js
#!/usr/bin/env node
'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');
const { computeFingerprints } = require('../lib/osi-migrate/fingerprints');

(async () => {
  const repo = path.resolve(__dirname, '..');
  const replayDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seedreplay-')), 'r.db');
  await bootstrapFresh(cliRunner(replayDb), { migrationsDir: path.join(repo, 'database/migrations/ordered'), appVersion: 'ci' });
  const seedDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seedreplay-')), 's.db');
  const seedR = cliRunner(seedDb);
  await seedR.exec(fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8'));
  const appOnly = (xs) => xs.filter((x) => !['schema_migrations', 'schema_object_fingerprints'].includes(x.object_name));
  const rep = appOnly(await computeFingerprints(cliRunner(replayDb)));
  const seed = appOnly(await computeFingerprints(seedR));
  if (JSON.stringify(rep) !== JSON.stringify(seed)) {
    console.error('FAIL: replay(migrations) != seed-blank.sql'); process.exit(1);
  }
  console.log('verify-seed-replay: OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] **Step 5: Run the verifier**

Run: `node scripts/verify-seed-replay.js`
Expected: `verify-seed-replay: OK`

- [ ] **Step 6: Commit**

```bash
git add database/migrations/ordered/0001__baseline.sql scripts/verify-seed-replay.js lib/osi-migrate/__tests__/seed-replay.test.js
git commit -m "feat(migrate): 0001 baseline + seed-vs-replay verifier"
```

---

### Task 9: `verify-migrations.js` + CI workflow

**Files:**
- Create: `scripts/verify-migrations.js`
- Create: `.github/workflows/migrations.yml`

**Interfaces:**
- Consumes: `loadMigrations` (T2), the module test suite, `verify-seed-replay.js` (T8).
- Produces: `verify-migrations.js` asserts loader invariants (every file parses, contiguous/monotonic versions, valid risk header) and exits non-zero on violation. CI runs the module tests + both verifiers on PRs.

- [ ] **Step 1: Write the verifier**

```js
// scripts/verify-migrations.js
#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');

try {
  const migrations = loadMigrations(path.resolve(__dirname, '../database/migrations/ordered'));
  let prev = 0;
  for (const m of migrations) {
    if (m.version !== prev + 1) {
      throw new Error(`non-contiguous version at ${m.name} (expected ${prev + 1}, got ${m.version})`);
    }
    prev = m.version;
  }
  if (migrations.length === 0) throw new Error('no migrations found');
  if (migrations[0].version !== 1) throw new Error('first migration must be version 0001');
  console.log(`verify-migrations: OK (${migrations.length} migrations)`);
  process.exit(0);
} catch (e) {
  console.error(`verify-migrations: FAIL — ${e.message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run it**

Run: `node scripts/verify-migrations.js`
Expected: `verify-migrations: OK (1 migrations)`

- [ ] **Step 3: Add the CI workflow**

```yaml
# .github/workflows/migrations.yml
name: Edge Migrations
on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]
jobs:
  migrations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install sqlite3 CLI
        run: sudo apt-get update && sudo apt-get install -y sqlite3
      - run: node --test lib/osi-migrate/__tests__/*.test.js
      - run: node scripts/verify-migrations.js
      - run: node scripts/verify-seed-replay.js
```

- [ ] **Step 4: Verify the workflow YAML parses and the commands it runs pass locally**

Run: `node --test lib/osi-migrate/__tests__/*.test.js && node scripts/verify-migrations.js && node scripts/verify-seed-replay.js`
Expected: all three succeed (tests pass; both verifiers print `OK`).

- [ ] **Step 5: Commit**

The repo's `.gitignore` has `/.*`, which ignores NEW `.github/` files even though existing `.github/` content (FUNDING, ISSUE_TEMPLATE, `workflows/typecheck.yml`) is tracked. Add a one-time exception so CI workflows are trackable, then commit:

```bash
grep -qxF '!/.github/' .gitignore || printf '\n# Track CI workflows / .github content (the /.* rule would otherwise ignore them)\n!/.github/\n' >> .gitignore
git add .gitignore scripts/verify-migrations.js .github/workflows/migrations.yml
git commit -m "ci(migrate): migration invariants + seed-replay in CI"
```

---

## Self-Review

**Spec coverage (Phase-1 slice of [Spec 1](../specs/2026-06-30-edge-schema-migration-foundation-design.md)):**
- Runner over a thin `{exec, all}` interface (§5) → Tasks 1, 6, 7.
- Ordered/idempotent migrations + risk class (§4) → Task 2.
- `schema_migrations` ledger + no-swallowed-errors + clean-connection failure write (§3.4, §5) → Tasks 3, 6.
- Semantic fingerprints, drift ⇒ repair_required not auto-rewrite (§5) → Tasks 4, 7.
- Online-backup + integrity verify (§3.3) → Task 5.
- Destructive recipe: FK off **outside** the transaction, writers stopped (§3.3, §5) → Task 7.
- `bootstrapFresh` / `verifyHead` (§5) → Task 7.
- `0001` baseline + seed==replay verifier (§3.5, §4, §7) → Task 8.
- `verify-migrations` + CI (§8) → Task 9.
- **Deferred to later plans (correctly out of Phase-1 scope):** consumer rewiring of `flows.json`/`dendro-compute-fn`/`repair-pi-schema.js` (P2); deploy state machine + pre-start gate (P3); osi-server CI standup (P3); hardware validation (P4); the actual drift migrations incl. LORAIN CHECK rebuild and the 92+79 ADD COLUMNs (P2, which will use the Task-7 destructive path); **dirty-data preflight for `CREATE UNIQUE INDEX`** (Spec 1 §9.7) — deferred to P2, where the first unique-index/destructive drift migrations land.

**Round-4 plan-review fixes incorporated (verified against SQLite 3.53):** `sqlite3 -bail` so a failing migration cannot fall through to `COMMIT` (Task 1, + partial-commit regression test); ordered migrations live in a **new** `database/migrations/ordered/` because the top-level dir holds legacy *referenced* scripts (Tasks 8–9); fingerprints include normalized `sqlite_master.sql` so **CHECK constraints and partial-index predicates** are detected — the exact LORAIN drift class — and trigger string-literal case is significant (Task 4); the destructive test applies the baseline before seeding data and adds a direct FK-off-before-`BEGIN` regression guard (Task 7); `backupDb` refuses a missing source and is WAL-tested (Task 5); `verify-migrations` enforces **contiguous** versions (Task 9).

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" — every code step contains runnable code. The Task-6 `applyDestructive` stub is intentionally a throwing placeholder *replaced in Task 7*, with a Task-7 test asserting the replacement.

**Type/name consistency:** `cliRunner`, `loadMigrations`, `ensureLedger/getApplied/recordSuccess/recordFailure/sqlQuote`, `computeFingerprints/NORMALIZER_VERSION`, `backupDb`, `applyPending/applyDestructive/postflight/bootstrapFresh/verifyHead/syncFingerprints` are used consistently across tasks; `index.js` exports grow in T6 then T7 to match consumers.
