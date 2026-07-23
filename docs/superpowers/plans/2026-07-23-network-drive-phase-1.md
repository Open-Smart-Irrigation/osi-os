# Network Drive Phase 1 Implementation Plan (Schema, Seam, Local Backend, Export Pipeline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The complete network-drive scaffold running against a local-directory backend: schema, the account-scoped transfer seam, slug/lifecycle/config machinery, and the day-partition CSV export pipeline — everything in spec v3.1 that needs nothing from Agroscope IT.

**Architecture:** Per [2026-07-22-agrolink-network-drive-design.md](../specs/2026-07-22-agrolink-network-drive-design.md): one `osi-drive-helper` seam module owns all drive I/O behind account-scoped operations (D1, D12); Phase 1 ships only the `local` backend (D2's `smbclient` backend is Phase 2). Export regenerates day partitions with published-hash skip (§6). Six of the seven tables ship now; `external_readings` stays gated on the format agreement (§8, §14).

**Tech Stack:** Node-RED function nodes (thin call-outs only), CommonJS modules under `usr/share/node-red/`, `node:test` + `node:sqlite`, `lib/osi-migrate` ordered migrations.

**Prerequisites:** AgroLink scoped-access Phase A merged (migrations 0022–0023, `osi-scope-helper`, `users.role`). Phase 1 consumes `osi-scope-helper` for the `publishZoneDay` scope check.

## Global Constraints

- Feature flag `OSI_NETWORK_DRIVE`, default off; no behavior change anywhere when off (spec D10).
- All new tables are edge-local: no sync triggers, no outbox rows, nothing near `sync-init-fn` (spec D8).
- Every module edit lands in both `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` and the `bcm2709` mirror.
- Slugs are frozen at assignment, never recomputed (spec D5/§5); retired slugs never reassigned.
- Seam callers pass account/zone uuids or artifact ids, never paths (spec D12).
- No remote-controlled string reaches a shell or command token unvalidated (spec D13).
- Timestamps in CSV output: RFC 3339 with numeric UTC offset; partition days on the Europe/Zurich calendar (§6).
- CSV defaults pending the interface agreement: semicolon delimiter, UTF-8 BOM, point decimals (§6).
- Migration slot below assumes 0024 is next free at execution time; renumber to the actual next slot if not, everything else unchanged.
- Load `osi-schema-change-control` before Task 1, `osi-flows-json-editing` + `osi-config-and-flags` before Task 7, `osi-verification-commands` before any gate run.

---

### Task 1: Migration `0024__network_drive.sql` + seed parity

**Files:**
- Create: `database/migrations/ordered/0024__network_drive.sql`
- Modify: `database/seed-blank.sql` (append same DDL block)
- Test: repo verifier suite (no new test file)

**Interfaces:**
- Produces: tables `drive_account_config`, `drive_slugs`, `drive_export_state`, `drive_import_files`, `drive_audit_log`, `drive_state` exactly as below; every later task's SQL must match these column names.

- [ ] **Step 1: Invoke `osi-schema-change-control` and confirm 0024 is the next free slot** (`ls database/migrations/ordered/ | tail -3`).

- [ ] **Step 2: Write the migration**

```sql
-- 0024__network_drive.sql — spec docs/superpowers/specs/2026-07-22-agrolink-network-drive-design.md §8
-- Edge-local only: no sync triggers on any of these tables (spec D8).
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
  last_success_at TEXT,
  last_error      TEXT,
  in_use_since    TEXT,
  PRIMARY KEY (account_uuid, zone_uuid, day)
);

CREATE TABLE drive_import_files (
  artifact_id    TEXT PRIMARY KEY,
  account_uuid   TEXT NOT NULL,
  original_path  TEXT NOT NULL,
  size_bytes     INTEGER,
  mtime          TEXT,
  content_hash   TEXT,
  parser_version TEXT,
  state          TEXT NOT NULL
                 CHECK (state IN ('claim_intent','claimed','imported','rejected','duplicate')),
  move_pending   INTEGER NOT NULL DEFAULT 0,
  reason         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_drive_import_files_account ON drive_import_files (account_uuid, state);

CREATE TABLE drive_audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  system_actor   TEXT NOT NULL,              -- 'export-worker' | 'import-worker' | 'admin-api'
  admin_uuid     TEXT,                       -- acting admin for administrative actions
  subject_uuid   TEXT,                       -- account whose folder/config was touched
  operation      TEXT NOT NULL,
  share_path     TEXT,
  content_hash   TEXT,
  outcome        TEXT NOT NULL,
  correlation_id TEXT,
  before_value   TEXT,
  after_value    TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE drive_state (
  key        TEXT PRIMARY KEY CHECK (key IN ('auth_disabled','alarm')),
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`external_readings` is deliberately absent — gated on the interface agreement (spec §8/§14). The `drive_import_files` → `external_readings` restricting FK ships with that later migration (FK lives on the readings side, so this ordering is safe).

- [ ] **Step 3: Append the identical DDL block to `database/seed-blank.sql`** in the same position convention the 0022/0023 blocks use.

- [ ] **Step 4: Run the full edge-schema gate set** (exact list from `osi-verification-commands`; at minimum):

Run: `node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-db-schema-consistency.js`
Expected: all PASS; no fingerprint drift; no trigger findings.

- [ ] **Step 5: Commit** — `git commit -m "feat(drive): migration 0024 network-drive tables + seed parity"`

---

### Task 2: `osi-drive-helper` slugs, path tokens, filename grammar

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-drive-helper/index.js` (+ bcm2709 mirror)
- Create: `.../osi-drive-helper/index.test.js` (+ mirror)

**Interfaces:**
- Produces: `assignSlug(db, kind, ownerUuid, rawName) -> string` (frozen; returns existing on re-call), `validFileToken(name) -> boolean`, `IMPORT_NAME_RE`.

- [ ] **Step 1: Write failing tests**

```js
const test = require('node:test');
const assert = require('node:assert');
const drive = require('./index.js');

test('slug: transliterates, lowercases, strips illegal chars, caps 32', () => {
  assert.equal(drive.slugify('Bewässerung Müller'), 'bewaesserung_mueller');
  assert.equal(drive.slugify('CON'), 'con_x');                 // reserved device name
  assert.equal(drive.slugify('a'.repeat(40)).length, 32);
  assert.equal(drive.slugify('x<>:"/\\|?*y.'), 'xy');          // illegal chars + trailing dot
});

test('assignSlug freezes on first call and never recomputes', () => {
  const rows = new Map();
  const db = fakeSlugDb(rows);
  const s1 = drive.assignSlug(db, 'account', 'u1', 'Müller');
  const s2 = drive.assignSlug(db, 'account', 'u1', 'Renamed Completely');
  assert.equal(s1, s2);                                        // frozen (spec D5)
});

test('assignSlug: case-insensitive collision gets numeric suffix; retired slug never reused', () => {
  const rows = new Map();
  const db = fakeSlugDb(rows);
  drive.assignSlug(db, 'account', 'u1', 'mueller');
  const s2 = drive.assignSlug(db, 'account', 'u2', 'MUELLER');
  assert.equal(s2, 'mueller_2');
  rows.get('account:u1').retired_at = '2026-01-01';
  const s3 = drive.assignSlug(db, 'account', 'u3', 'mueller');
  assert.equal(s3, 'mueller_3');                               // burned, not reused
});

test('import filename grammar: conservative ASCII, rejects hostile names', () => {
  assert.ok(drive.validFileToken('Sensor Data 2026.csv'));
  for (const bad of ['a;b.csv', '!x.csv', 'a?.csv', '*.csv', 'ü.csv', '.hidden.csv',
                     'x.csv:stream', '../up.csv', 'file.CSV.exe', 'a'.repeat(130) + '.csv']) {
    assert.equal(drive.validFileToken(bad), false, bad);
  }
});
```

`fakeSlugDb` backs `assignSlug`'s three queries (existing row by kind+owner, case-insensitive slug lookup, insert) with the Map; copy the fake-db style from `osi-scope-helper/index.test.js`.

- [ ] **Step 2: Run to verify failure** — `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-drive-helper/` → FAIL (module missing).

- [ ] **Step 3: Implement**

```js
'use strict';
const TRANSLIT = { 'ä':'ae','ö':'oe','ü':'ue','é':'e','è':'e','ê':'e','à':'a','ç':'c','ß':'ss' };
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
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
  return s.slice(0, 32);
}

function assignSlug(db, kind, ownerUuid, rawName) {
  const existing = db.getSlug(kind, ownerUuid);
  if (existing) return existing.slug;                       // frozen, even if retired
  const base = slugify(rawName);
  let candidate = base, n = 1;
  while (db.slugTaken(kind, candidate)) candidate = `${base}_${++n}`;  // retired rows count as taken
  db.insertSlug(kind, ownerUuid, candidate);
  return candidate;
}

function validFileToken(name) {
  if (!IMPORT_NAME_RE.test(name)) return false;
  if (name.includes('..') || name.includes(':')) return false;
  if (RESERVED.test(name.replace(/\.csv$/i, ''))) return false;
  return true;
}

module.exports = { slugify, assignSlug, validFileToken, IMPORT_NAME_RE };
```

`x.csv:stream` and `../up.csv` already fail `IMPORT_NAME_RE`; the explicit re-checks are defense in depth per D13.

- [ ] **Step 4: Run tests to green**, copy module + tests to the bcm2709 mirror, re-run against the mirror path.

- [ ] **Step 5: Commit** — `git commit -m "feat(drive): osi-drive-helper slugs and filename grammar"`

---

### Task 3: Transfer seam with `local` backend

**Files:**
- Modify: `.../osi-drive-helper/index.js` (+ mirror)
- Create: `.../osi-drive-helper/backend-local.js` (+ mirror)
- Modify: `.../osi-drive-helper/index.test.js` (+ mirror)

**Interfaces:**
- Consumes: Task 2 slugs.
- Produces: `createSeam({backend, db, rootDir}) -> seam` with `health()`, `publishZoneDay(accountUuid, zoneUuid, day, generateFn)`, `listImport(accountUuid)`, `claimImport(accountUuid, fileToken)`, `getArtifact(artifactId)`, `finishArtifact(artifactId, disposition, reason)`. `generateFn(accountUuid, zoneUuid, day) -> {csv: string}` is injected so the seam binds content generation to the scope-checked call (spec D12/§4); Task 5 supplies it.

- [ ] **Step 1: Write failing tests** (local backend on a temp dir)

```js
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

function mkSeam(t, dbOverrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = fakeDriveDb(dbOverrides);   // slugs, account_config(confirmed), scope-check stub, ledger Map
  return { seam: drive.createSeam({ backend: 'local', db, rootDir: root }), root, db };
}

test('publishZoneDay writes tmp, verifies size, renames; path derived from frozen slugs', async (t) => {
  const { seam, root } = mkSeam(t);
  await seam.publishZoneDay('u1', 'z1', '2026-07-22', async () => ({ csv: 'a;b\n1;2\n' }));
  const out = path.join(root, 'acct1', 'export', 'zone1', '2026', '07', 'zone1_20260722.csv');
  assert.equal(fs.readFileSync(out, 'utf8'), 'a;b\n1;2\n');
  assert.equal(fs.readdirSync(path.dirname(out)).filter(f => f.endsWith('.tmp')).length, 0);
});

test('publishZoneDay refuses out-of-scope zone and unprovisioned account (fail closed)', async (t) => {
  const { seam } = mkSeam(t, { scopeAllows: false });
  await assert.rejects(() => seam.publishZoneDay('u1', 'z-foreign', '2026-07-22', async () => ({ csv: 'x' })),
    (e) => e.code === 'SCOPE_DENIED');
  const { seam: s2 } = mkSeam(t, { provisioning: 'unconfirmed' });
  await assert.rejects(() => s2.publishZoneDay('u1', 'z1', '2026-07-22', async () => ({ csv: 'x' })),
    (e) => e.code === 'NOT_PROVISIONED');
});

test('claimImport: intent row first, atomic rename into processing/, artifact readable', async (t) => {
  const { seam, root, db } = mkSeam(t);
  const imp = path.join(root, 'acct1', 'import'); fs.mkdirSync(imp, { recursive: true });
  fs.writeFileSync(path.join(imp, 'data.csv'), 'm;v\n');
  const { artifactId } = await seam.claimImport('u1', 'data.csv');
  assert.ok(db.ledgerRow(artifactId));                                  // claim_intent persisted before rename
  assert.ok(!fs.existsSync(path.join(imp, 'data.csv')));
  assert.equal((await seam.getArtifact(artifactId)).content.toString(), 'm;v\n');
});

test('finishArtifact moves to processed/YYYY-MM with artifact-id prefix; rejected gets sidecar', async (t) => {
  const { seam, root } = mkSeam(t);
  /* claim as above, then: */
  await seam.finishArtifact(aid1, 'imported');
  await seam.finishArtifact(aid2, 'rejected', 'unknown metric "xq"');
  assert.ok(fs.existsSync(path.join(root, 'acct1', 'processed', '2026-07', `${aid1}_data.csv`)));
  const rej = path.join(root, 'acct1', 'rejected', '2026-07');
  assert.ok(fs.readdirSync(rej).some(f => f.endsWith('.rejected.txt')));
});

test('listImport applies grammar and excludes subdirectories and .part files', async (t) => { /* seeds
  import/ with good.csv, bad;name.csv, x.part, and a subdir; expects only good.csv listed, with
  bad;name.csv in result.ignored */ });

test('auth-classed backend errors latch drive_state.auth_disabled; path errors do not', async (t) => { /*
  local backend injected with failure modes via backend hook: {authError:true} on any op sets
  db.state('auth_disabled'); {pathError:true} records per-path failure and leaves state clear */ });
```

- [ ] **Step 2: Run to verify failures.**

- [ ] **Step 3: Implement** — `backend-local.js` exposes the raw transport (`put`, `renameReplace`, `stat`, `list`, `read`, `mkdirp`, `remove`) against `rootDir`; `createSeam` owns everything else:

```js
// index.js additions (shape; local backend keeps identical semantics to the future smbclient one)
async function publishZoneDay(accountUuid, zoneUuid, day, generateFn) {
  const cfg = db.accountConfig(accountUuid);
  if (!cfg || !cfg.enabled) throw err('DISABLED');
  if (cfg.provisioning_state !== 'confirmed') throw err('NOT_PROVISIONED');   // spec §5 fail-closed
  if (!(await db.scopeAllows(accountUuid, zoneUuid))) throw err('SCOPE_DENIED');
  const rel = exportPath(db, accountUuid, zoneUuid, day);        // slugs only, never caller input
  const { csv } = await generateFn(accountUuid, zoneUuid, day);
  const tmp = rel + '.' + correlationId() + '.tmp';              // unique per attempt (spec §4)
  await backend.put(tmp, Buffer.from(csv, 'utf8'));
  const st = await backend.stat(tmp);                            // verify BEFORE rename (spec §4)
  if (st.size !== Buffer.byteLength(csv, 'utf8')) { await backend.remove(tmp); throw err('SIZE_MISMATCH'); }
  await backend.renameReplace(tmp, rel);
  audit(db, 'export-worker', accountUuid, 'publish', rel, hash(csv), 'ok');
}
```

`claimImport` writes the `claim_intent` ledger row, then renames `import/<name>` → `processing/<artifactId>_<name>`, then flips state to `claimed`. `finishArtifact` sets the terminal state with `move_pending=1`, performs the archive rename (`processed/` or `rejected/<YYYY-MM>/` + sidecar), then clears `move_pending`. Error classification: backend errors carry `{authClass: boolean}`; auth-class sets `drive_state.auth_disabled` and throws `AUTH_DISABLED` (spec §4 taxonomy).

- [ ] **Step 4: Run to green; mirror copy; re-run mirror.**

- [ ] **Step 5: Commit** — `git commit -m "feat(drive): transfer seam with local backend, claim state machine"`

---

### Task 4: CSV generator (day partition)

**Files:**
- Create: `.../osi-drive-helper/export-csv.js` (+ mirror)
- Create: `.../osi-drive-helper/export-csv.test.js` (+ mirror)
- Modify: `conf/.../node-red/osi-lib/index.js` + `conf/.../node-red/osi-journal/api.js` (+ mirrors): move `formulaSafeText`/`csvCell` into `osi-lib`, re-require from `osi-journal` (DRY; spec §6 mandates this sanitizer).

**Interfaces:**
- Consumes: `device_data` rows via injected query fn; `osi-lib` sanitizers.
- Produces: `generateZoneDayCsv(db, zoneUuid, dayISO) -> {csv, rowCount}` — the `generateFn` Task 3's seam injects; column set identical to the existing zone export (`osi-history-router` export.csv), including paired `_pf` rows.

- [ ] **Step 1: Failing tests** — golden-file fixture: seeded rows in a `node:sqlite` in-memory DB covering an SWT sensor (positive kPa → `_pf` row expected), a negative air temperature (must NOT be apostrophe-escaped), a text field starting with `\t=cmd()` (MUST be escaped), a DST-fold instant (2026-10-25 02:30 both offsets); assert byte-identical output against `export-csv.golden.csv` committed beside the test: UTF-8 BOM present, `;` delimiter, CRLF, RFC 3339 timestamps with offset, header naming units.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — query rows where `datetime(ts)` falls in the Europe/Zurich day (compute the day's UTC bounds with `Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Zurich'})`, no dependency), map through the shared `csvCell`, prepend BOM, join CRLF. Reuse the existing export's column definition by requiring the column list from `osi-history-router` if it exports one; otherwise copy the column array with a comment naming the source lines.

- [ ] **Step 4: Green + mirror + `node --test` on osi-journal to prove the sanitizer move broke nothing.**

- [ ] **Step 5: Commit** — `git commit -m "feat(drive): day-partition CSV generator, shared formulaSafeText"`

---

### Task 5: Export worker (rolling window, hash skip, staleness, fairness)

**Files:**
- Create: `.../osi-drive-helper/export-worker.js` (+ mirror)
- Create: `.../osi-drive-helper/export-worker.test.js` (+ mirror)

**Interfaces:**
- Consumes: seam `publishZoneDay`, Task 4 `generateZoneDayCsv`, `drive_export_state`.
- Produces: `runExportCycle({seam, db, now}) -> {published, skipped, inUse, errors}`; `computeStaleness(db, now) -> [{accountUuid, zoneUuid, day, overdueSince}]`.

- [ ] **Step 1: Failing tests**

```js
test('regenerates current day + changed days inside rolling window (default 2)', ...);
test('skips publish when regenerated hash equals published_hash (mtime stability)', ...);
test('in-use partition: recorded with in_use_since, retried next cycle, excluded from hard staleness', ...);
test('rotating cursor persists: account order shifts each cycle so tail accounts are not starved', ...);
test('per-account deadline: one slow account cannot consume the whole cycle budget', ...);
test('staleness keys on oldest overdue partition per account+zone, threshold 3 cycles', ...);
```

Each test body seeds `drive_export_state`/fake rows and asserts on the returned summary plus state-table writes — same fake-db style as Task 3; the cursor persists in `drive_state`-adjacent storage via `db.getCursor()/setCursor()` backed by `drive_account_config.updated_at` ordering.

- [ ] **Step 2: Run to verify failure.  Step 3: Implement.  Step 4: Green + mirror.**

- [ ] **Step 5: Commit** — `git commit -m "feat(drive): export worker with rolling window, hash skip, fair cursor"`

---

### Task 6: Admin/config surface in the DB layer

**Files:**
- Modify: `.../osi-drive-helper/index.js` (+ mirror), `.../index.test.js`

**Interfaces:**
- Produces: `setAccountEnabled(db, adminUuid, accountUuid, on)`, `setPathOverride(db, adminUuid, accountUuid, kind, path)` (resets `provisioning_state` to `'unconfirmed'` — spec §5), `confirmProvisioning(db, adminUuid, accountUuid)`, `reenableAuth(db, adminUuid)`; every one writes a `drive_audit_log` row with `admin_uuid`, `before_value`, `after_value`.

- [ ] **Step 1: Failing tests** — override resets provisioning to unconfirmed and audits before/after; reenableAuth clears `auth_disabled` and audits; disabled account is refused by `publishZoneDay` (ties to Task 3's `DISABLED`).
- [ ] **Steps 2–4: Red, implement, green + mirror.**
- [ ] **Step 5: Commit** — `git commit -m "feat(drive): admin config ops with audited before/after"`

---

### Task 7: Flag, UCI config, and scheduled-flow wiring

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (+ bcm2709 mirror)
- Modify: the `/api/system/features` handler node (flag exposure) and the UCI defaults file that `osi-config-and-flags` identifies for `osi-server` settings

**Interfaces:**
- Consumes: `runExportCycle` from Task 5.
- Produces: `OSI_NETWORK_DRIVE` in `/api/system/features`; UCI section `osi-server.drive` (`enabled`, `unc`, `root`, `credentials_file`, `direct_unc`); an hourly inject node (±10 min jitter) → one thin function node calling `osiLib.require('osi-drive-helper')` and `runExportCycle`, hard-gated on the flag.

- [ ] **Step 1: Invoke `osi-flows-json-editing` and `osi-config-and-flags`; follow their mechanics for node insertion, `osiLib.require`, and flag/UCI conventions — do not hand-edit flows.json outside that process.**
- [ ] **Step 2: Add the flag (default off), UCI keys, inject + function node; function node body stays under the size ratchet: read flag + config, call worker, log summary.**
- [ ] **Step 3: Run the flows gates** — `node --test scripts/flows-bare-require-scan.test.js scripts/flows-size-scan.test.js scripts/osi-lib-binding-audit.test.js` → PASS; boot Node-RED locally if the skill's checklist calls for it and confirm flag-off is a no-op.
- [ ] **Step 4: Commit** — `git commit -m "feat(drive): OSI_NETWORK_DRIVE flag, UCI config, scheduled export flow"`

---

### Task 8: Phase gate

- [ ] **Step 1: Full verification sweep** per `osi-verification-commands`: schema gates (Task 1 list), `node --test` on both module trees, flows gates, plus `node scripts/test-journal-schema.js` (bundled-DB row-content gate).
- [ ] **Step 2: Flag-off regression check:** with `OSI_NETWORK_DRIVE` unset, `/api/system/features` omits or falses the flag and no drive code path executes (grep worker logs in a local Node-RED boot).
- [ ] **Step 3: Write `docs/superpowers/plans/2026-07-23-network-drive-phase-1-execution-report.md`** with per-task evidence (command + output), per repo convention.
- [ ] **Step 4: Commit** — `git commit -m "docs(drive): phase 1 execution report"`

---

## Self-review notes

Spec coverage for Phase 1 scope: §4 seam + taxonomy (T3), §5 slugs/lifecycle/fail-closed/override-reset (T2/T3/T6), §6 generator + worker (T4/T5), §8 six tables + audit columns (T1), §10 audit actor model (T1/T6), D10 flag (T7), D13 grammar (T2). Deferred by design: smbclient backend + CI Samba container + fault injection (§4/§12 — Phase 2), import parser child process + caps (§7 — Phase 3, though the claim state machine ships here in T3 because the seam owns it), `external_readings` (§8 gate), GUI/i18n (§9 — Phase 4), lifecycle *event* handlers beyond override/disable (zone deletion hooks land with Phase 4's admin surface). Type check: `publishZoneDay(accountUuid, zoneUuid, day, generateFn)` consistent across T3/T5/T7; ledger states in T1 CHECK match T3's machine; `in_use_since` (T1) matches T5's staleness exclusion.
