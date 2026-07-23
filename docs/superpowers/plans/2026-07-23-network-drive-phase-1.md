# Network Drive Phase 1 Implementation Plan (Schema, Seam, Local Backend, Export Pipeline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The network-drive export scaffold running against a local-directory backend: schema, the account-scoped transfer seam, slug/lifecycle/config machinery, and the day-partition CSV export pipeline — everything in spec v3.1 that needs nothing from Agroscope IT. The importer (ledger, claim state machine, polling) is deferred wholesale to Phase 3.

**Architecture:** Per [2026-07-22-agrolink-network-drive-design.md](../specs/2026-07-22-agrolink-network-drive-design.md): one `osi-drive-helper` seam module owns all drive I/O behind account-scoped operations (D1, D12); Phase 1 ships only the `local` backend (D2's `smbclient` backend is Phase 2). Export regenerates day partitions with published-hash skip, daily reconciliation, and a resumable rebuild cursor (§6). Five tables ship now; `drive_import_files` moves to Phase 3's migration (which exists anyway for the gated `external_readings`).

**Tech Stack:** Node-RED function nodes (thin call-outs only), CommonJS helper modules under `usr/share/node-red/`, `node:test` + `node:sqlite`, `lib/osi-migrate` ordered migrations.

**Prerequisites (hard gate):** AgroLink scoped-access Phase A merged — migrations 0022–0023 present, `osi-scope-helper` registered with `assertFreshZoneAccess`, `users.role` live. **Not true of the current checkout (ordered migrations stop at 0021); do not start execution before that merge.** Migration numbering below assumes 0024 is then the next free slot; renumber if not.

## Global Constraints

- Execute in an isolated worktree (`superpowers:using-git-worktrees`). Every commit stages an explicit file list (`git add <paths>`), then `git diff --cached --check` before `git commit`. Never `git add -A`.
- Feature flag `OSI_NETWORK_DRIVE`, default off; no behavior change anywhere when off (spec D10).
- All new tables are edge-local: no sync triggers, no outbox rows, nothing near `sync-init-fn` (spec D8).
- Every module edit lands in both `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` and the `bcm2709` mirror.
- Slugs are frozen at assignment, never recomputed (spec D5/§5); retired slugs never reassigned.
- Seam callers pass account/zone uuids, never paths (spec D12); all path resolution and validation happens inside the seam at time of use.
- Credential path is fixed (`/etc/osi/drive.cred`, spec §10) and is a Phase 2 concern — no UCI key for it.
- Timestamps in CSV output: RFC 3339 with numeric UTC offset; partition days on the Europe/Zurich calendar (§6). `device_data` queries use indexed range predicates on `recorded_at` (`recorded_at >= ? AND recorded_at < ?`), never `datetime()` wrappers.
- CSV defaults pending the interface agreement: semicolon delimiter, UTF-8 BOM, point decimals (§6).
- Every seam and admin operation writes a `drive_audit_log` row with outcome (`ok` or the error class) and correlation id — failures and refusals included, not only successes (§10).
- Load `osi-schema-change-control` before Task 1, `osi-flows-json-editing` + `osi-config-and-flags` before Task 7, `osi-verification-commands` before any gate run.

---

### Task 1: Migration `0024__network_drive.sql`, seed + bundled-DB parity

**Files:**
- Create: `database/migrations/ordered/0024__network_drive.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json` (register the final SHA-256)
- Modify: `database/seed-blank.sql` (append same DDL block)
- Modify: every bundled `farming.db` (all copies under `conf/` and `database/` — enumerate with `find . -name farming.db`); apply via the repo's migration runner, not hand SQL
- Modify: `scripts/verify-db-schema-consistency.js` (extend the hand-maintained schema contract with the new tables)

**Interfaces:**
- Produces: tables `drive_account_config`, `drive_slugs`, `drive_export_state`, `drive_audit_log`, `drive_state` exactly as below; every later task's SQL must match these column names.

- [ ] **Step 1: Invoke `osi-schema-change-control`; confirm 0024 is next free** (`ls database/migrations/ordered/ | tail -3`).

- [ ] **Step 2: Write the migration.** First non-blank line MUST be the risk header:

```sql
-- risk: additive
-- 0024: network-drive tables (spec docs/superpowers/specs/2026-07-22-agrolink-network-drive-design.md §8).
-- Edge-local only: no sync triggers on any of these tables (spec D8).
-- drive_import_files and external_readings deliberately deferred to the Phase 3 migration.
CREATE TABLE drive_account_config (
  account_uuid        TEXT PRIMARY KEY,
  enabled             INTEGER NOT NULL DEFAULT 0,
  export_override     TEXT,
  import_override     TEXT,
  provisioning_state  TEXT NOT NULL DEFAULT 'unconfirmed'
                      CHECK (provisioning_state IN ('unconfirmed','confirmed')),
  ad_identity_ref     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE drive_slugs (
  slug        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('account','zone')),
  owner_uuid  TEXT NOT NULL,
  retired_at  TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (kind, owner_uuid)
);
CREATE UNIQUE INDEX idx_drive_slugs_ci ON drive_slugs (kind, lower(slug));

CREATE TABLE drive_export_state (
  account_uuid    TEXT NOT NULL,
  zone_uuid       TEXT NOT NULL,
  day             TEXT NOT NULL,             -- YYYY-MM-DD, Europe/Zurich calendar
  published_hash  TEXT,
  published_size  INTEGER,                   -- reconciliation compares remote size against this
  last_success_at TEXT,
  last_error      TEXT,
  in_use_since    TEXT,
  PRIMARY KEY (account_uuid, zone_uuid, day)
);

CREATE TABLE drive_audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  system_actor   TEXT NOT NULL,              -- 'export-worker' | 'admin-api'
  admin_uuid     TEXT,                       -- acting admin for administrative actions
  subject_uuid   TEXT,                       -- account whose folder/config was touched
  operation      TEXT NOT NULL,
  share_path     TEXT,
  content_hash   TEXT,
  outcome        TEXT NOT NULL,              -- 'ok' | error class (SCOPE_DENIED, SIZE_MISMATCH, ...)
  correlation_id TEXT,
  before_value   TEXT,
  after_value    TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE drive_state (
  key        TEXT PRIMARY KEY
             CHECK (key IN ('auth_disabled','alarm','export_cursor','rebuild_cursor')),
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 3: Register the checksum** in `CHECKSUMS.json` (compute with the same tool the repo's checksum entries use — see `osi-schema-change-control`), append the identical DDL block to `database/seed-blank.sql`, apply the migration to every bundled `farming.db` via the runner, and extend the `verify-db-schema-consistency.js` contract.

- [ ] **Step 4: Run the complete edge-schema gate set** — the full list from `osi-verification-commands`, not a subset. At the time of writing that is: `verify-migrations`, `verify-seed-replay`, `verify-runtime-schema-parity`, `verify-db-schema-consistency`, `verify-devices-rebuild-fence`, plus `scripts/test-journal-schema.js` (bundled-DB row content) and the semantic schema compare; take the authoritative list from the skill.
Expected: all PASS; no fingerprint drift.

- [ ] **Step 5: Commit** — stage exactly the migration, CHECKSUMS.json, seed, bundled DBs, and the verifier contract; `git diff --cached --check`; `git commit -m "feat(drive): migration 0024 network-drive tables, seed + bundled-DB parity"`

---

### Task 2: `osi-drive-helper` slugs and Windows-name rules

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-drive-helper/index.js` (+ bcm2709 mirror)
- Create: `.../osi-drive-helper/index.test.js` (+ mirror)

**Interfaces:**
- Produces: `slugify(raw) -> string`, `assignSlug(db, kind, ownerUuid, rawName) -> string` (frozen; transactional; returns existing on re-call), `safeWindowsName(name) -> boolean`.

- [ ] **Step 1: Write failing tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const drive = require('./index.js');

test('slug: transliterates, lowercases, strips illegal chars', () => {
  assert.equal(drive.slugify('Bewässerung Müller'), 'bewaesserung_mueller');
  assert.equal(drive.slugify('CON'), 'con_x');                    // reserved device name
  assert.equal(drive.slugify('x<>:"/\\|?*y.'), 'xy');             // illegal chars + trailing dot
});

test('slug base leaves room for collision suffix: total length stays <= 32', () => {
  const rows = new Map(); const db = fakeSlugDb(rows);
  const long = 'a'.repeat(60);
  const s1 = drive.assignSlug(db, 'account', 'u1', long);
  const s2 = drive.assignSlug(db, 'account', 'u2', long);
  assert.ok(s1.length <= 32 && s2.length <= 32);
  assert.notEqual(s1, s2);                                        // suffix fits inside the cap
});

test('assignSlug freezes on first call, retries on unique-conflict, never reuses retired', () => {
  const rows = new Map(); const db = fakeSlugDb(rows);
  const s1 = drive.assignSlug(db, 'account', 'u1', 'Müller');
  assert.equal(drive.assignSlug(db, 'account', 'u1', 'Renamed'), s1);   // frozen (spec D5)
  db.failInsertOnce('SQLITE_CONSTRAINT');                         // race: someone took the slug between check and insert
  const s2 = drive.assignSlug(db, 'account', 'u2', 'Müller');
  assert.equal(s2, 'mueller_2');
  rows.get('account:u1').retired_at = '2026-01-01';
  assert.equal(drive.assignSlug(db, 'account', 'u3', 'mueller'), 'mueller_3');  // burned
});

test('safeWindowsName normalizes before reserved-name check', () => {
  for (const bad of ['CON .csv', 'con.csv', 'NUL..csv', 'a;b.csv', '!x.csv', 'ü.csv',
                     'x.csv:stream', '../up.csv', 'a'.repeat(130) + '.csv']) {
    assert.equal(drive.safeWindowsName(bad), false, bad);
  }
  assert.ok(drive.safeWindowsName('Sensor Data 2026.csv'));
});
```

`fakeSlugDb` backs the three `assignSlug` queries with the Map and supports `failInsertOnce`; copy the fake-db style from `osi-scope-helper/index.test.js`.

- [ ] **Step 2: Run to verify failure** — `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-drive-helper/` → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
'use strict';
const TRANSLIT = { 'ä':'ae','ö':'oe','ü':'ue','é':'e','è':'e','ê':'e','à':'a','ç':'c','ß':'ss' };
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SLUG_BASE_MAX = 28;                                  // + '_999' still <= 32
const IMPORT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}\.csv$/;

function slugify(raw) {
  let s = String(raw || '').toLowerCase()
    .replace(/[äöüéèêàçß]/g, (c) => TRANSLIT[c] || '')
    .replace(/[^a-z0-9._ -]/g, '')
    .replace(/[ .]+$/g, '')
    .replace(/ /g, '_')
    .replace(/\.+/g, '');
  if (!s) s = 'account';
  if (RESERVED.test(s)) s = s + '_x';
  return s.slice(0, SLUG_BASE_MAX);
}

function assignSlug(db, kind, ownerUuid, rawName) {
  const existing = db.getSlug(kind, ownerUuid);
  if (existing) return existing.slug;                      // frozen, even if retired
  const base = slugify(rawName);
  for (let n = 1; n <= 999; n++) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (db.slugTaken(kind, candidate)) continue;           // retired rows count as taken
    try { db.insertSlug(kind, ownerUuid, candidate); return candidate; }
    catch (e) { if (!/SQLITE_CONSTRAINT/.test(String(e.code || e))) throw e; }  // race: try next
  }
  throw new Error('slug space exhausted for ' + kind);
}

function safeWindowsName(name) {
  if (!IMPORT_NAME_RE.test(name)) return false;
  if (name.includes('..') || name.includes(':')) return false;
  const base = name.replace(/\.csv$/i, '').replace(/[ .]+$/g, '');   // normalize BEFORE reserved check
  return !RESERVED.test(base);
}

module.exports = { slugify, assignSlug, safeWindowsName, IMPORT_NAME_RE, SLUG_BASE_MAX };
```

- [ ] **Step 4: Run tests to green; copy module + tests to the bcm2709 mirror; re-run against the mirror path.**

- [ ] **Step 5: Commit** (scoped add of the four files) — `git commit -m "feat(drive): osi-drive-helper slugs and Windows-name rules"`

---

### Task 3: Helper registration and delivery

**Files:**
- Create: `.../osi-drive-helper/package.json` (+ mirror)
- Modify: `osi-lib` registry, runtime `package.json`/lockfile, seed-copy loop, `node_modules` symlink set, and `deploy.sh` helper fetch list — the exact touchpoints are enumerated by `scripts/verify-helper-registration.js`; follow the registration pattern of `osi-scope-helper` file-for-file, logical key `drive`.

**Interfaces:**
- Produces: `osiLib.require('drive')` resolves on a Pi and in local tests.

- [ ] **Step 1: Run `node scripts/verify-helper-registration.js`** → expect FAIL naming the missing registration points for `osi-drive-helper` (this is the failing test for this task).
- [ ] **Step 2: Register at every point the gate names,** copying `osi-scope-helper`'s entries (both board trees).
- [ ] **Step 3: Re-run the gate** → PASS. Also `node --test scripts/osi-lib-binding-audit.test.js` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(drive): register osi-drive-helper across runtime and deploy"`

---

### Task 4: Transfer seam with `local` backend (export surface only)

**Files:**
- Modify: `.../osi-drive-helper/index.js` (+ mirror)
- Create: `.../osi-drive-helper/backend-local.js` (+ mirror)
- Modify: `.../osi-drive-helper/index.test.js` (+ mirror)

**Interfaces:**
- Consumes: Task 2 slugs; `osi-scope-helper.assertFreshZoneAccess(db, userUuid, zoneUuid)` (Phase A/C surface); Task 5's generator via construction-time wiring.
- Produces: `createSeam({backend, db, rootDir, generator, signal}) -> seam` with `health()` and `publishZoneDay(accountUuid, zoneUuid, day) -> {published: boolean, hash, size}`. `generator` is wired once at construction (the seam's own module supplies the default `require('./export-csv')`); callers of the seam never pass content or functions — spec D12 as tightened by plan review. No import operations in Phase 1.

- [ ] **Step 1: Write failing tests** (local backend on a temp dir; fake db as in Task 2)

```js
test('publishZoneDay: unique tmp per attempt, size verified before rename, no tmp left behind', async (t) => {
  const { seam, root } = mkSeam(t);                        // generator stub streams 'a;b\r\n1;2\r\n'
  const r = await seam.publishZoneDay('u1', 'z1', '2026-07-22');
  const out = path.join(root, 'acct1', 'export', 'zone1', '2026', '07', 'zone1_20260722.csv');
  assert.equal(fs.readFileSync(out, 'utf8'), '﻿a;b\r\n1;2\r\n');
  assert.deepEqual(Object.keys(r).sort(), ['hash', 'published', 'size']);
  assert.equal(fs.readdirSync(path.dirname(out)).filter(f => f.includes('.tmp')).length, 0);
});

test('publishZoneDay refuses: out-of-scope zone, unprovisioned account, disabled account', async (t) => {
  await assert.rejects(() => mkSeam(t, { scopeDenies: true }).seam.publishZoneDay('u1', 'zX', '2026-07-22'),
    (e) => e.code === 'SCOPE_DENIED');
  await assert.rejects(() => mkSeam(t, { provisioning: 'unconfirmed' }).seam.publishZoneDay('u1', 'z1', '2026-07-22'),
    (e) => e.code === 'NOT_PROVISIONED');                  // spec §5 fail-closed
  await assert.rejects(() => mkSeam(t, { enabled: 0 }).seam.publishZoneDay('u1', 'z1', '2026-07-22'),
    (e) => e.code === 'DISABLED');
});

test('path resolution: override escaping rootDir is refused at time of use', async (t) => {
  for (const evil of ['../outside', '/abs/path', 'a/../../b', 'x:stream']) {
    const { seam } = mkSeam(t, { exportOverride: evil });
    await assert.rejects(() => seam.publishZoneDay('u1', 'z1', '2026-07-22'), (e) => e.code === 'PATH_DENIED');
  }
});

test('local backend refuses symlink escape from rootDir', async (t) => {
  const { seam, root } = mkSeam(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'acct1'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'acct1', 'export'));    // export/ points outside
  await assert.rejects(() => seam.publishZoneDay('u1', 'z1', '2026-07-22'), (e) => e.code === 'PATH_DENIED');
});

test('every operation audits outcome incl. failures, with correlation id', async (t) => {
  const { seam, db } = mkSeam(t, { scopeDenies: true });
  await seam.publishZoneDay('u1', 'zX', '2026-07-22').catch(() => {});
  const rows = db.auditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'SCOPE_DENIED');
  assert.ok(rows[0].correlation_id);
});

test('auth-classed backend errors latch drive_state.auth_disabled; path errors do not', async (t) => {
  const a = mkSeam(t, { backendFail: 'auth' });
  await assert.rejects(() => a.seam.publishZoneDay('u1', 'z1', '2026-07-22'), (e) => e.code === 'AUTH_DISABLED');
  assert.equal(a.db.state('auth_disabled'), 'true');
  const b = mkSeam(t, { backendFail: 'path' });
  await b.seam.publishZoneDay('u1', 'z1', '2026-07-22').catch(() => {});
  assert.equal(b.db.state('auth_disabled'), undefined);
});

test('abort: an aborted publish makes no state commit and leaves no final file', async (t) => {
  const ctl = new AbortController();
  const { seam, root } = mkSeam(t, { signal: ctl.signal, generatorSlow: () => ctl.abort() });
  await assert.rejects(() => seam.publishZoneDay('u1', 'z1', '2026-07-22'), (e) => e.code === 'ABORTED');
  assert.ok(!fs.existsSync(path.join(root, 'acct1', 'export', 'zone1', '2026', '07', 'zone1_20260722.csv')));
});
```

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement.** `backend-local.js`: raw transport (`putStream`, `renameReplace`, `stat`, `list`, `remove`, `mkdirp`) rooted at `rootDir`, every resolved path passed through one `resolveContained(rootDir, rel)` that path-normalizes, rejects `..`/absolute/`:` segments, then `fs.realpath`s the deepest existing ancestor and requires containment in `realpath(rootDir)`. `index.js`: `publishZoneDay` checks enabled → provisioning → `assertFreshZoneAccess`, derives the path from frozen slugs (creating date subdirectories only), streams the generator into `<target>.<correlationId>.tmp` while accumulating SHA-256 and byte count, `stat`s the tmp and verifies size, `renameReplace`s, audits, returns `{published: true, hash, size}`. Abort checks between every backend call; abort after tmp write removes the tmp and commits nothing. Auth-class backend errors latch `drive_state.auth_disabled` per §4 taxonomy.

- [ ] **Step 4: Run to green; mirror copy; re-run mirror.**

- [ ] **Step 5: Commit** — `git commit -m "feat(drive): transfer seam with contained local backend and audited publish"`

---

### Task 5: CSV generator (streamed day partition)

**Files:**
- Create: `.../osi-drive-helper/export-csv.js` (+ mirror)
- Create: `.../osi-drive-helper/export-csv.test.js` + `export-csv.golden.csv` (+ mirrors)
- Modify: `conf/.../node-red/osi-lib/index.js` + `conf/.../node-red/osi-journal/api.js` (+ mirrors): move `formulaSafeText`/`csvCell` into `osi-lib`, re-require from `osi-journal` (DRY; spec §6 mandates this sanitizer).

**Interfaces:**
- Consumes: `device_data` via keyset-paged reads; the CSV column contract from `osi-history-helper` (the `SELECT deveui, recorded_at, <fields>` contract around `index.js:1110` — extract the field list to a shared export rather than copying); `osi-lib` sanitizers; day-boundary helpers from `osi-history-helper` if exported, else compute with `Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Zurich'})`.
- Produces: `streamZoneDayCsv(db, zoneUuid, dayISO, sink) -> Promise<{rowCount}>` — writes UTF-8-BOM-prefixed, CRLF, semicolon-delimited chunks to `sink(chunk)`; the seam (Task 4) supplies the sink. Query shape: `recorded_at >= ? AND recorded_at < ?` with the day's Europe/Zurich UTC bounds, keyset-paged by `(recorded_at, id)` at 500 rows per page.

- [ ] **Step 1: Failing tests** — seeded `node:sqlite` in-memory DB; golden-file byte comparison. Cases: SWT positive kPa (paired `_pf` row expected), negative air temperature (NOT escaped), text field starting `\t=cmd()` (escaped via shared `formulaSafeText`), more rows than one page (paging exercised, order stable), the 23-hour day `2026-03-29` and the 25-hour day `2026-10-25` (row at 02:30 both offsets; UTC bounds computed per calendar), timestamps rendered RFC 3339 with offset.
- [ ] **Step 2: Run to verify failure.  Step 3: Implement (paged loop, incremental sink writes, no full-partition string).  Step 4: Green + both mirrors + `node --test` on osi-journal to prove the sanitizer move broke nothing.**
- [ ] **Step 5: Commit** — `git commit -m "feat(drive): streamed day-partition CSV generator, shared formulaSafeText"`

---

### Task 6: Export worker (window, hash skip, reconciliation, fairness, retention)

**Files:**
- Create: `.../osi-drive-helper/export-worker.js` (+ mirror)
- Create: `.../osi-drive-helper/export-worker.test.js` (+ mirror)

**Interfaces:**
- Consumes: seam `publishZoneDay` (metadata return feeds hash skip), `drive_export_state`, `drive_state` keys `export_cursor`/`rebuild_cursor`.
- Produces: `runExportCycle({seam, db, now, signal, budgetMs, perAccountMs}) -> {published, skipped, inUse, errors, reconciled}`; `computeStaleness(db, now)`; `runRetention(db, now)`; `resumeRebuild({seam, db, batch})`.

- [ ] **Step 1: Failing tests**

```js
test('single-flight: a second runExportCycle while one runs resolves to {skipped: "in-flight"}', ...);
test('regenerates current day + changed days inside rolling window (default 2)', ...);
test('hash skip: unchanged partition not republished (publishZoneDay not called for it)', ...);
test('in-use partition: in_use_since set, retried next cycle, excluded from hard staleness, escalates after 24h', ...);
test('rotating cursor persists in drive_state.export_cursor; order shifts across cycles', ...);
test('per-account deadline + AbortSignal: slow account aborted, later accounts still run, no late state commit', ...);
test('staleness keys on oldest overdue partition per account+zone, threshold 3 cycles', ...);
test('reconciliation: remote file missing or size != published_size -> republished', ...);
test('resumable rebuild: rebuild_cursor advances per batch and survives restart', ...);
test('retention: audit rows past 12 months archived+truncated; export_state pruned past rebuild horizon', ...);
```

Test bodies seed state tables through the fake db and assert on the summary plus state writes; single-flight is an in-module guard, not a DB lock.

- [ ] **Step 2: Run to verify failure.  Step 3: Implement.  Step 4: Green + mirror.**
- [ ] **Step 5: Commit** — `git commit -m "feat(drive): export worker with reconciliation, fair cursor, retention"`

---

### Task 7: Admin/config ops and slug lifecycle wiring

**Files:**
- Modify: `.../osi-drive-helper/index.js` (+ mirror), `.../index.test.js`

**Interfaces:**
- Produces: `setAccountEnabled(db, adminUuid, accountUuid, on)` — enabling assigns the frozen account slug transactionally (Task 2 `assignSlug`); `setPathOverride(db, adminUuid, accountUuid, kind, path)` — resets `provisioning_state` to `'unconfirmed'` (spec §5); `confirmProvisioning(db, adminUuid, accountUuid)`; `reenableAuth(db, adminUuid)`. Zone slugs are assigned inside `publishZoneDay` on first export of that zone, same transactional path. All ops audit with `admin_uuid`, `before_value`, `after_value`.

- [ ] **Step 1: Failing tests** — enable assigns slug once (re-enable keeps it; account rename changes nothing); first `publishZoneDay` for a zone assigns its slug and the export path uses it forever after; override resets provisioning and audits before/after; `reenableAuth` clears `auth_disabled` and audits; disabled account refused by `publishZoneDay`.
- [ ] **Steps 2–4: Red, implement, green + mirror.**
- [ ] **Step 5: Commit** — `git commit -m "feat(drive): audited admin ops with transactional slug lifecycle"`

---

### Task 8: Flag, UCI-to-env wiring, scheduled flow

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (+ bcm2709 mirror)
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` (UCI → env mapping, following the existing `procd_set_param env DEVICE_EUI=...` pattern)
- Modify: the UCI defaults file `osi-config-and-flags` names for `osi-server` settings; the `/api/system/features` handler node

**Interfaces:**
- Consumes: `runExportCycle` (Task 6) via `osiLib.require('drive')`.
- Produces: UCI `osi-server.drive.{enabled,unc,root,direct_unc,backend,local_root}` mapped by `node-red.init` to env `OSI_NETWORK_DRIVE`, `OSI_DRIVE_UNC`, `OSI_DRIVE_ROOT`, `OSI_DRIVE_DIRECT_UNC`, `OSI_DRIVE_BACKEND` (default `local`), `OSI_DRIVE_LOCAL_ROOT` (default `/data/drive-local`); flag exposed in `/api/system/features`; an hourly inject (±10 min jitter) → one thin function node that builds the seam once (module-scope memo: db handle via the flow's existing `osi-db-helper` pattern, backend from env, AbortController per cycle) and calls `runExportCycle`. No `credentials_file` key anywhere (fixed path, Phase 2).

- [ ] **Step 1: Invoke `osi-flows-json-editing` and `osi-config-and-flags`; follow their mechanics for node insertion, `osiLib.require`, UCI defaults, and init-script env mapping.**
- [ ] **Step 2: Implement flag + UCI + init mapping + inject/function nodes; function body stays under the size ratchet: read env, memoized seam, call worker, log summary.**
- [ ] **Step 3: Gates** — `node --test scripts/flows-bare-require-scan.test.js scripts/flows-size-scan.test.js scripts/osi-lib-binding-audit.test.js` → PASS; boot Node-RED locally: with the flag unset the inject fires and exits without touching any drive code path (log assertion).
- [ ] **Step 4: Commit** — `git commit -m "feat(drive): flag, UCI-to-env wiring, scheduled export flow"`

---

### Task 9: Phase gate

- [ ] **Step 1: Full verification sweep** per `osi-verification-commands`: the complete Task 1 schema gate list, `node --test` on both module trees, flows gates, `verify-helper-registration`.
- [ ] **Step 2: Event-loop latency gate** (spec §11/§12): a `node:test` harness drives `runExportCycle` over a seeded multi-account DB while a 10 ms interval timer measures loop delay; assert p95 loop delay under 50 ms during the cycle. Commit the harness as `.../osi-drive-helper/latency-gate.test.js`.
- [ ] **Step 3: Flag-off regression check** — `OSI_NETWORK_DRIVE` unset: features endpoint omits/falses the flag; no drive code executes (log grep on a local boot).
- [ ] **Step 4: Write `docs/superpowers/plans/2026-07-23-network-drive-phase-1-execution-report.md`** with per-task evidence (command + output), per repo convention; commit.

---

## Self-review notes

Plan-review findings all applied: risk header + CHECKSUMS + bundled DBs + consistency contract (T1), helper registration as its own gated task (T3), no caller-supplied generator and metadata-only publish return with `assertFreshZoneAccess` (T4), streamed paged generation with `recorded_at` range predicates and DST-day tests (T5), explicit cursor keys in `drive_state`, reconciliation with `published_size`, single-flight + abort + retention (T1/T6), transactional slug lifecycle at enablement/first-export (T7), full runtime wiring incl. `node-red.init` env mapping and no `credentials_file` key (T8), failure-outcome auditing everywhere (T4/T7), slug suffix inside the 32 cap + normalized reserved-name check + insert retry (T2), scoped staging on every commit (global constraints), importer deferred wholesale to Phase 3 (tables and code). Type check: `publishZoneDay(accountUuid, zoneUuid, day) -> {published, hash, size}` consistent across T4/T6/T8; `drive_state` CHECK covers exactly the four keys T6 uses; `streamZoneDayCsv` sink contract matches T4's streaming publish.
