# AgroLink Scoped Access — Phase A Implementation Plan

> **2026-07-23 integration overlay:** Treat source head `8921e6d1` as cumulative
> patch material, not a merge-ready branch. It contains credential-isolation,
> bootstrap-race, durable-flag, fresh-role, and first-assignment trigger fixes
> after the accepted `101d1f2f` user-version fix. Revalidate the entire
> cumulative diff against the current target instead of replaying its commits.
>
> Immediately before creating a migration, enumerate
> `database/migrations/ordered/` and select the next two free contiguous
> versions. At the audit head they are likely `0033` and `0034`; that observation
> is not an allocation. Record `LAST_VERSION`, `SCHEMA_VERSION`,
> `BACKFILL_VERSION`, `SCHEMA_MIGRATION`, and `BACKFILL_MIGRATION` from the live
> target and use those names in every checksum, fixture, command, and commit:
>
> ```bash
> LAST_VERSION="$(find database/migrations/ordered -maxdepth 1 -type f \
>   -name '[0-9][0-9][0-9][0-9]__*.sql' -printf '%f\n' |
>   sed 's/__.*//' | sort -n | tail -1)"
> SCHEMA_VERSION="$(printf '%04d' "$((10#$LAST_VERSION + 1))")"
> BACKFILL_VERSION="$(printf '%04d' "$((10#$LAST_VERSION + 2))")"
> SCHEMA_MIGRATION="${SCHEMA_VERSION}__scoped_access_schema.sql"
> BACKFILL_MIGRATION="${BACKFILL_VERSION}__scoped_access_backfill.sql"
> test ! -e "database/migrations/ordered/$SCHEMA_MIGRATION"
> test ! -e "database/migrations/ordered/$BACKFILL_MIGRATION"
> ```
>
> Re-run this allocation after any target-head change. Historical source labels
> must never become target filenames.

> **Accepted version contract:** Commit `101d1f2f` and its accepted report
> `2f7aa171` established durable `users.sync_version`. Every writer changing
> username, role, disabled state, or another synced user field increments the
> version in the same write. Migration-owned triggers emit `NEW.sync_version`;
> they do not increment it. The parity program strengthens the source default
> from zero to a positive initial version, because its fixture gate rejects any
> emitted user event at version zero. Rehearsals must prove a positive first
> emitted version and strictly greater versions after two later mutations.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the scoped-access foundation on the edge: the next two free migrations (schema + backfill), the `osi-scope-helper` seam module, the `OSI_SCOPED_ACCESS` feature flag, `/api/me`, and scoped-mode bootstrap registration, all behind the flag, with producers (sync events) gated off until Phase E.

**Architecture:** Per spec `docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md` v3 (§5 data model, §5.1 trigger constraint, §8 identifier bridge, §10 bootstrap). New triggers are migration-owned (never the boot node) and registered in `MIGRATION_OWNED_TRIGGERS`. All flow-node logic lives in the seam module loaded via `osiLib.require('scope')`; flow nodes stay thin to satisfy `verify-flows-size-ratchet.js`. Sync event emission is gated by a single-row SQL flag table (`scoped_access_emit`), default off, so Phase A cannot emit unknown aggregates at the cloud.

**Tech Stack:** SQLite (`lib/osi-migrate` ordered migrations), Node-RED function nodes (`flows.json` via one-shot mutation scripts only), Node built-in `node:test` + `node:sqlite` for rehearsals, `bcryptjs` (existing register chain).

**Skills the executor must load before starting:** `osi-schema-change-control` (Tasks 1–6), `osi-flows-json-editing` (Tasks 10–13), `osi-common-pitfalls` (throughout).

---

## Task 1: Failing rehearsal test for the selected migration pair

**Files:**
- Create: `scripts/rehearse-scoped-access-migration.test.js`

This test drives the two migration files. It uses `node:sqlite` (`DatabaseSync`) directly, with no `lib/osi-migrate` dependency, so it can also exercise trigger arms and the emit gate.

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
'use strict';
// Rehearsal for the selected scoped-access schema and data-backfill migrations.
// Drives: tables/indexes/triggers exist, emit gate
// default-off, USER three-arm trigger emits non-null user_uuid and monotonic
// positive versions, conditional bootstrap semantics, uuid/version backfill,
// and in-place admin promotion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
function readUniqueMigration(suffix) {
  const dir = path.join(ROOT, 'database/migrations/ordered');
  const matches = fs.readdirSync(dir).filter((name) => name.endsWith(suffix));
  assert.equal(matches.length, 1, `expected one migration ending ${suffix}`);
  return fs.readFileSync(path.join(dir, matches[0]), 'utf8');
}
const MIG_SCHEMA = readUniqueMigration('__scoped_access_schema.sql');
const MIG_BACKFILL = readUniqueMigration('__scoped_access_backfill.sql');

const USERS_DDL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  auth_mode TEXT NOT NULL DEFAULT 'local',
  user_uuid TEXT,
  cloud_user_id INTEGER
);`;
const UUID_TRIGGER = `CREATE TRIGGER trg_sync_users_uuid_ai
AFTER INSERT ON users FOR EACH ROW
WHEN NEW.user_uuid IS NULL OR NEW.user_uuid = ''
BEGIN
  UPDATE users SET user_uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;`;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(USERS_DDL);
  db.exec(UUID_TRIGGER);
  // Stub tables the schema-migration trigger bodies reference: SQLite resolves trigger-body
  // table names when preparing any DML on the trigger's table, even when the
  // WHEN clause is false, so these must exist in every test DB.
  db.exec(`CREATE TABLE sync_outbox (event_uuid TEXT PRIMARY KEY, aggregate_type TEXT, aggregate_key TEXT,
    op TEXT, payload_json TEXT, sync_version INTEGER, occurred_at TEXT, gateway_device_eui TEXT)`);
  db.exec(`CREATE TABLE sync_link_state (peer_node TEXT, gateway_device_eui TEXT)`);
  db.exec(MIG_SCHEMA);
  return db;
}
const objs = (db, type) =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type=? AND name LIKE ? ORDER BY name`).all(type, '%').map(r => r.name);

test('schema migration creates assignment tables, indexes, gate table, 7 triggers', () => {
  const db = freshDb();
  const tables = objs(db, 'table');
  for (const t of ['user_zone_assignments', 'user_plot_assignments', 'scoped_access_emit'])
    assert.ok(tables.includes(t), `missing table ${t}`);
  const indexes = objs(db, 'index');
  for (const i of ['uq_user_zone_active', 'idx_user_zone_by_zone', 'uq_user_plot_active', 'idx_user_plot_by_plot'])
    assert.ok(indexes.includes(i), `missing index ${i}`);
  const triggers = objs(db, 'trigger');
  for (const tr of [
    'trg_dp_user_zone_assign_outbox_ai', 'trg_dp_user_zone_assign_outbox_au',
    'trg_dp_user_plot_assign_outbox_ai', 'trg_dp_user_plot_assign_outbox_au',
    'trg_dp_users_outbox_uuid_au', 'trg_dp_users_outbox_ai', 'trg_dp_users_outbox_role_au',
  ]) assert.ok(triggers.includes(tr), `missing trigger ${tr}`);
  // node:sqlite rows are null-prototype objects; compare the scalar, not deepEqual.
  assert.equal(db.prepare('SELECT enabled FROM scoped_access_emit WHERE id=1').get().enabled, 0);
  db.close();
});

test('emit gate default off: no outbox rows until enabled', () => {
  const db = freshDb();
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('a','h','2026-01-01')`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_outbox').get().n, 0);
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('b','h','2026-01-01')`);
  const rows = db.prepare(`SELECT * FROM sync_outbox WHERE op='USER_UPSERTED'`).all();
  assert.equal(rows.length, 1);
  db.close();
});

test('USER trigger arms: uuid assigned by sibling trigger still emits non-null uuid', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  // Path 1: null uuid at insert -> uuid trigger fills -> uuid_au arm must emit non-null.
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('carol','h','2026-01-01')`);
  const p1 = JSON.parse(db.prepare(`SELECT payload_json FROM sync_outbox WHERE op='USER_UPSERTED'`).get().payload_json);
  assert.ok(p1.user_uuid && p1.user_uuid.length === 32, `null/short uuid in payload: ${p1.user_uuid}`);
  // Path 2: uuid supplied at insert -> ai arm fires exactly once more.
  db.exec(`INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES ('dave','h','2026-01-01', lower(hex(randomblob(16))))`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_UPSERTED'`).get().n, 2);
  // Path 3: role mutation and its version increment are one write.
  db.exec(`UPDATE users
              SET role='admin', sync_version=sync_version+1
            WHERE username='carol'`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_UPSERTED'`).get().n, 3);
  db.close();
});

test('USER events carry positive versions that increase on successive mutations', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  db.exec(`INSERT INTO users (username, password_hash, created_at)
           VALUES ('erin','h','2026-01-01')`);
  db.exec(`UPDATE users
              SET role='admin', sync_version=sync_version+1
            WHERE username='erin'`);
  db.exec(`UPDATE users
              SET username='erin-renamed', sync_version=sync_version+1
            WHERE username='erin'`);
  const versions = db.prepare(
    `SELECT sync_version, json_extract(payload_json, '$.sync_version') payload_version
       FROM sync_outbox
      WHERE op='USER_UPSERTED'
      ORDER BY rowid`
  ).all();
  assert.deepEqual(versions.map((row) => row.sync_version), [1, 2, 3]);
  assert.deepEqual(versions.map((row) => row.payload_version), [1, 2, 3]);
  db.close();
});

test('USER uuid arm emits only for first assignment, not a no-op rewrite', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  db.exec(`INSERT INTO users (username, password_hash, created_at)
           VALUES ('frank','h','2026-01-01')`);
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_UPSERTED'`).get().n,
    1
  );
  db.exec(`UPDATE users SET user_uuid=user_uuid WHERE username='frank'`);
  assert.equal(
    db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_UPSERTED'`).get().n,
    1
  );
  db.close();
});

test('assignment triggers emit upsert on grant and delete on tombstone', () => {
  const db = freshDb();
  db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
  db.exec(`INSERT INTO user_zone_assignments
             (assignment_uuid, user_uuid, zone_uuid, sync_version, created_at)
           VALUES ('as1','u1','z1',1,'2026-01-01')`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_ZONE_ASSIGNMENT_UPSERTED'`).get().n, 1);
  db.exec(`UPDATE user_zone_assignments SET deleted_at='2026-01-02', sync_version=sync_version+1 WHERE assignment_uuid='as1'`);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sync_outbox WHERE op='USER_ZONE_ASSIGNMENT_DELETED'`).get().n, 1);
  db.close();
});

test('backfill migration fills null user_uuid and promotes lowest-id admin; no-op on empty users', () => {
  const db = freshDb();
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('legacy1','h','2026-01-01')`);
  db.exec(`INSERT INTO users (username, password_hash, created_at) VALUES ('legacy2','h','2026-01-01')`);
  db.exec(`UPDATE users SET user_uuid=NULL`); // simulate pre-trigger-era rows
  db.exec(MIG_BACKFILL);
  const nulls = db.prepare(`SELECT COUNT(*) n FROM users WHERE user_uuid IS NULL OR user_uuid=''`).get().n;
  assert.equal(nulls, 0);
  const admins = db.prepare(`SELECT username FROM users WHERE role='admin'`).all().map(r => r.username);
  assert.deepEqual(admins, ['legacy1']); // lowest id promoted when no input
  const db2 = freshDb();
  db2.exec(MIG_BACKFILL);
  assert.equal(db2.prepare('SELECT COUNT(*) n FROM users').get().n, 0); // fresh image: no crash, no rows
  db.close(); db2.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/rehearse-scoped-access-migration.test.js`
Expected: FAIL — the schema-migration suffix has no matching file.

---

## Task 2: Selected additive schema migration

**Files:**
- Create: `database/migrations/ordered/$SCHEMA_MIGRATION` after repeating the allocation preflight

- [ ] **Step 1: Write the migration**

```sql
-- risk: additive
-- Scoped multi-user access (AgroLink) — roles, grants, emit gate,
-- migration-owned outbox triggers. Spec:
-- docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md §5.
-- All triggers here are migration-owned: registered in
-- scripts/verify-runtime-schema-parity.js MIGRATION_OWNED_TRIGGERS and never
-- added to the frozen sync-init-fn boot node.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'researcher'
  CHECK (role IN ('admin','researcher','viewer'));
ALTER TABLE users ADD COLUMN disabled_at TEXT;
ALTER TABLE users ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS user_zone_assignments (
  assignment_uuid       TEXT PRIMARY KEY,
  user_uuid             TEXT NOT NULL,
  zone_uuid             TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui    TEXT,
  sync_version          INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT,
  deleted_at            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_zone_active
  ON user_zone_assignments(user_uuid, zone_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_zone_by_zone
  ON user_zone_assignments(zone_uuid) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_plot_assignments (
  assignment_uuid       TEXT PRIMARY KEY,
  user_uuid             TEXT NOT NULL,
  plot_uuid             TEXT NOT NULL,
  assigned_by_user_uuid TEXT,
  gateway_device_eui    TEXT,
  sync_version          INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT,
  deleted_at            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_plot_active
  ON user_plot_assignments(user_uuid, plot_uuid) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_plot_by_plot
  ON user_plot_assignments(plot_uuid) WHERE deleted_at IS NULL;

-- Single-row emit gate: Phase A installs schema with producers OFF.
-- Phase E flips enabled=1 only after the server accepts the aggregates and
-- both sides support the versioned access-command contract.
CREATE TABLE IF NOT EXISTS scoped_access_emit (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO scoped_access_emit (id, enabled) VALUES (1, 0);

-- Grant triggers: upsert on insert, delete on tombstone.
CREATE TRIGGER IF NOT EXISTS trg_dp_user_zone_assign_outbox_ai
AFTER INSERT ON user_zone_assignments
FOR EACH ROW
WHEN (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER_ZONE_ASSIGNMENT',
    NEW.assignment_uuid,
    'USER_ZONE_ASSIGNMENT_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'assignment_uuid', NEW.assignment_uuid,
      'user_uuid', NEW.user_uuid,
      'zone_uuid', NEW.zone_uuid,
      'assigned_by_user_uuid', NEW.assigned_by_user_uuid,
      'gateway_device_eui', NEW.gateway_device_eui,
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.created_at
    ),
    NEW.sync_version,
    NEW.created_at,
    NEW.gateway_device_eui
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_user_zone_assign_outbox_au
AFTER UPDATE OF deleted_at ON user_zone_assignments
FOR EACH ROW
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER_ZONE_ASSIGNMENT',
    NEW.assignment_uuid,
    'USER_ZONE_ASSIGNMENT_DELETED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'assignment_uuid', NEW.assignment_uuid,
      'user_uuid', NEW.user_uuid,
      'zone_uuid', NEW.zone_uuid,
      'deleted_at', NEW.deleted_at,
      'gateway_device_eui', NEW.gateway_device_eui,
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.deleted_at
    ),
    NEW.sync_version,
    NEW.deleted_at,
    NEW.gateway_device_eui
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_user_plot_assign_outbox_ai
AFTER INSERT ON user_plot_assignments
FOR EACH ROW
WHEN (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER_PLOT_ASSIGNMENT',
    NEW.assignment_uuid,
    'USER_PLOT_ASSIGNMENT_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'assignment_uuid', NEW.assignment_uuid,
      'user_uuid', NEW.user_uuid,
      'plot_uuid', NEW.plot_uuid,
      'assigned_by_user_uuid', NEW.assigned_by_user_uuid,
      'gateway_device_eui', NEW.gateway_device_eui,
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.created_at
    ),
    NEW.sync_version,
    NEW.created_at,
    NEW.gateway_device_eui
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_user_plot_assign_outbox_au
AFTER UPDATE OF deleted_at ON user_plot_assignments
FOR EACH ROW
WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER_PLOT_ASSIGNMENT',
    NEW.assignment_uuid,
    'USER_PLOT_ASSIGNMENT_DELETED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'assignment_uuid', NEW.assignment_uuid,
      'user_uuid', NEW.user_uuid,
      'plot_uuid', NEW.plot_uuid,
      'deleted_at', NEW.deleted_at,
      'gateway_device_eui', NEW.gateway_device_eui,
      'sync_version', NEW.sync_version,
      'occurred_at', NEW.deleted_at
    ),
    NEW.sync_version,
    NEW.deleted_at,
    NEW.gateway_device_eui
  );
END;

-- USER aggregate, three arms (spec §5.2: sibling-trigger UPDATEs are
-- invisible to other AFTER INSERT triggers, so no bare-INSERT arm may rely
-- on trg_sync_users_uuid_ai having filled user_uuid).
--
-- Do NOT "simplify" this to a single bare AFTER INSERT trigger: NEW is bound
-- to the row image as of the original INSERT, so a bare INSERT arm sees a
-- null user_uuid on the common (uuid-not-supplied) registration path even
-- after trg_sync_users_uuid_ai's nested UPDATE has run.
--
-- Arm 1 below relies on that nested UPDATE (issued from inside
-- trg_sync_users_uuid_ai's own AFTER INSERT body) firing this AFTER UPDATE OF
-- user_uuid trigger. This is NOT blocked by SQLite's default
-- recursive_triggers=OFF: that pragma only suppresses a trigger re-firing
-- ITSELF (or a cycle back to itself), never a different, non-cyclic trigger
-- fired by DML issued from inside another trigger's body. Empirically
-- verified against both node:sqlite (bundled SQLite) and the on-device
-- sqlite3 npm binding during review: the cascade fires correctly under
-- default settings, no PRAGMA change required anywhere in this codebase.
-- Emit only on first assignment. A no-op rewrite at the same sync_version
-- would produce a different occurred_at and cause an equal-version conflict.
CREATE TRIGGER IF NOT EXISTS trg_dp_users_outbox_uuid_au
AFTER UPDATE OF user_uuid ON users
FOR EACH ROW
WHEN NEW.user_uuid IS NOT NULL AND NEW.user_uuid != ''
AND (OLD.user_uuid IS NULL OR OLD.user_uuid = '')
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER',
    NEW.user_uuid,
    'USER_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'user_uuid', NEW.user_uuid,
      'username', NEW.username,
      'role', NEW.role,
      'disabled_at', NEW.disabled_at,
      'sync_version', NEW.sync_version,
      'gateway_device_eui', (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'),
      'occurred_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_users_outbox_ai
AFTER INSERT ON users
FOR EACH ROW
WHEN NEW.user_uuid IS NOT NULL AND NEW.user_uuid != ''
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER',
    NEW.user_uuid,
    'USER_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'user_uuid', NEW.user_uuid,
      'username', NEW.username,
      'role', NEW.role,
      'disabled_at', NEW.disabled_at,
      'sync_version', NEW.sync_version,
      'gateway_device_eui', (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'),
      'occurred_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_dp_users_outbox_role_au
AFTER UPDATE OF username, role, disabled_at ON users
FOR EACH ROW
WHEN NEW.user_uuid IS NOT NULL AND NEW.user_uuid != ''
AND (SELECT enabled FROM scoped_access_emit WHERE id = 1) = 1
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'USER',
    NEW.user_uuid,
    'USER_UPSERTED',
    json_object(
      'contract_version', 1,
      'schema_version', 1,
      'user_uuid', NEW.user_uuid,
      'username', NEW.username,
      'role', NEW.role,
      'disabled_at', NEW.disabled_at,
      'sync_version', NEW.sync_version,
      'gateway_device_eui', (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud'),
      'occurred_at', strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')
  );
END;
```

Note: the rehearsal's in-memory DB creates `sync_outbox` itself; on real DBs the table already exists. The emit gate keeps every arm silent until Phase E.

- [ ] **Step 2: Run rehearsal — expect progress, still failing**

Run: `node --test scripts/rehearse-scoped-access-migration.test.js`
Expected: first 6 tests PASS, last test FAILS because the backfill migration is missing.

---

## Task 3: Selected data-backfill migration

**Files:**
- Create: `database/migrations/ordered/$BACKFILL_MIGRATION` from the same allocation

- [ ] **Step 1: Write the migration**

```sql
-- risk: data
-- Scoped access backfill (AgroLink), three idempotent jobs (spec §5.3):
-- 1. Assign user_uuid to any legacy user row missing one (the shipped
--    trg_sync_users_uuid_ai covers inserts; this closes the pre-trigger era).
-- 2. Normalize legacy user versions to the positive initial version required
--    before scoped USER producers can be enabled.
-- 3. In-place-upgrade admin promotion: when at least one user exists and no
--    admin does, promote the lowest-id active account. On a fresh image the
--    users table is empty and both jobs are no-ops; the fresh-hub admin path
--    is registration-time bootstrap (spec §10/§13).

UPDATE users
   SET user_uuid = lower(hex(randomblob(16)))
 WHERE user_uuid IS NULL OR user_uuid = '';

UPDATE users
   SET sync_version = 1
 WHERE sync_version < 1;

UPDATE users
   SET role = 'admin',
       sync_version = sync_version + 1
 WHERE id = (SELECT MIN(id) FROM users WHERE disabled_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
```

- [ ] **Step 2: Run rehearsal — expect all green**

Run: `node --test scripts/rehearse-scoped-access-migration.test.js`
Expected: 7/7 PASS.

---

## Task 4: CHECKSUMS.json + verify-migrations

**Files:**
- Modify: `database/migrations/ordered/CHECKSUMS.json`

- [ ] **Step 1: Append SHA-256 entries for the two new files**

```bash
cd "$(git rev-parse --show-toplevel)"
node -e "
const fs=require('fs'),crypto=require('crypto');
const p='database/migrations/ordered/CHECKSUMS.json';
const m=JSON.parse(fs.readFileSync(p,'utf8'));
const dir='database/migrations/ordered';
const files=fs.readdirSync(dir);
const suffixes=['__scoped_access_schema.sql','__scoped_access_backfill.sql'];
const selected=suffixes.map((suffix) => {
  const matches=files.filter((file) => file.endsWith(suffix));
  if (matches.length !== 1) throw new Error('expected one migration ending '+suffix);
  return matches[0];
});
for (const f of selected) {
  m[f]=crypto.createHash('sha256').update(fs.readFileSync(dir+'/'+f)).digest('hex');
}
fs.writeFileSync(p, JSON.stringify(m,null,2)+'\n');
console.log('entries:', Object.keys(m).length);
"
```

- [ ] **Step 2: Verify**

Run: `node scripts/verify-migrations.js`
Expected: exit 0 (well-formed and contiguous through `$BACKFILL_VERSION`, with both checksum entries present).

---

## Task 5: Seed parity, bundled DBs, parity allowlist, consistency contract

**Files:**
- Modify: `database/seed-blank.sql` (append the full DDL from Task 2's migration, minus the `-- risk:` header: tables, indexes, gate table + its seed row, all 7 triggers; place `role`/`disabled_at`/`sync_version` columns into the `CREATE TABLE users` body instead of ALTER)
- Modify: `scripts/verify-runtime-schema-parity.js` (extend `MIGRATION_OWNED_TRIGGERS`)
- Modify: `scripts/verify-db-schema-consistency.js` (extend hand-maintained contract)
- Modify: all 7 bundled `farming.db` copies (via migration apply + mirror copy)

- [ ] **Step 1: Extend `MIGRATION_OWNED_TRIGGERS`**

In `scripts/verify-runtime-schema-parity.js`, replace the set body:

```js
const MIGRATION_OWNED_TRIGGERS = new Set([
  // 0005__field_work_requests.sql is delivered by seed DBs and deploy.sh's
  // additive migration repair. Do not add it to the frozen sync-init-fn boot DDL.
  'trg_improvement_requests_outbox_ai',
  // The scoped-access schema migration is migration-owned,
  // emit-gated by scoped_access_emit, never in the frozen boot node.
  'trg_dp_user_zone_assign_outbox_ai',
  'trg_dp_user_zone_assign_outbox_au',
  'trg_dp_user_plot_assign_outbox_ai',
  'trg_dp_user_plot_assign_outbox_au',
  'trg_dp_users_outbox_uuid_au',
  'trg_dp_users_outbox_ai',
  'trg_dp_users_outbox_role_au',
]);
```

- [ ] **Step 2: Update `database/seed-blank.sql`**

Add `role`, `disabled_at`, and `sync_version` to the `CREATE TABLE users` column list (after `last_auth_sync_error`):

```sql
  last_auth_sync_error            TEXT,
  role                            TEXT NOT NULL DEFAULT 'researcher' CHECK (role IN ('admin','researcher','viewer')),
  disabled_at                     TEXT,
  sync_version                    INTEGER NOT NULL DEFAULT 1
```

Append the assignment tables, indexes, `scoped_access_emit` (+ seed row), and all 7 triggers verbatim from the migration file (drop only the `-- risk:` header lines).

- [ ] **Step 3: Apply the migration to the 6 non-mirror bundled DBs, then copy the mirror**

```bash
cd "$(git rev-parse --show-toplevel)"
for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do sqlite3 -bail "$db" < "database/migrations/ordered/$SCHEMA_MIGRATION" && echo "OK $db"; done
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
```

Do **not** apply `$BACKFILL_MIGRATION` to bundled DBs. It is a data migration; bundled DBs ship zero users, and the runner applies it at deploy.

- [ ] **Step 4: Extend the consistency contract**

In `scripts/verify-db-schema-consistency.js`, add to the hand-maintained contract: `users.role`, `users.disabled_at`, `users.sync_version`; tables `user_zone_assignments`, `user_plot_assignments`, `scoped_access_emit`; indexes `uq_user_zone_active`, `idx_user_zone_by_zone`, `uq_user_plot_active`, `idx_user_plot_by_plot`; trigger-name fragments for the 7 new triggers. Follow the existing declaration pattern in that file.

- [ ] **Step 5: Run the migration gate set**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
```
Expected: each prints its OK line; profile parity ends `All parity checks passed.`

- [ ] **Step 6: Commit**

```bash
git add database/ scripts/verify-runtime-schema-parity.js scripts/verify-db-schema-consistency.js \
  conf/*/files/usr/share/db/farming.db web/react-gui/farming.db scripts/rehearse-scoped-access-migration.test.js
git commit -m "feat(schema): add scoped access migrations with owned triggers"
```

---

## Task 6: Boot-survival test (restart-reversion guard)

**Files:**
- Create: `scripts/rehearse-scoped-trigger-boot-survival.test.js`

The §5.1 invariant: the frozen boot node must not drop or alter migration-owned triggers. This test runs the shipped `sync-init-fn` function text against a seeded DB and asserts the 7 triggers survive untouched. Pattern copied from `scripts/rehearse-devices-rebuild.test.js` (read it first for the facade-shim shape).

- [ ] **Step 1: Write the test**

```js
#!/usr/bin/env node
'use strict';
// Boot-survival guard: running the shipped sync-init-fn boot function must
// not drop or modify the migration-owned scoped-access triggers (spec §5.1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_TRIGGERS = [
  'trg_dp_user_zone_assign_outbox_ai', 'trg_dp_user_zone_assign_outbox_au',
  'trg_dp_user_plot_assign_outbox_ai', 'trg_dp_user_plot_assign_outbox_au',
  'trg_dp_users_outbox_uuid_au', 'trg_dp_users_outbox_ai', 'trg_dp_users_outbox_role_au',
];

function extractBootFunc() {
  const flows = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8'));
  const node = flows.find(n => n.id === 'sync-init-fn');
  if (!node) throw new Error('sync-init-fn not found');
  return node.func;
}

test('sync-init-fn text never references the migration-owned scoped triggers', () => {
  const func = extractBootFunc();
  for (const t of EXPECTED_TRIGGERS) {
    assert.ok(!func.includes(t), `boot node references ${t} — it must stay migration-owned`);
  }
});

test('sync-init-fn text has no DROP TRIGGER wildcard sweep beyond its own 31', () => {
  const func = extractBootFunc();
  const drops = new Set([...func.matchAll(/DROP TRIGGER IF EXISTS\s+([A-Za-z0-9_]+)/gi)].map(m => m[1]));
  for (const t of EXPECTED_TRIGGERS) assert.ok(!drops.has(t), `boot node drops ${t}`);
  // Pin: 30 distinct drops inside sync-init-fn (verified 2026-07-19; a 31st
  // drop in dendro-compute-fn is unrelated to the boot node).
  assert.equal(drops.size, 30, `expected the frozen 30 drop list, found ${drops.size}: ${[...drops].join(',')}`);
});
```

The static form of this guard (boot text must not name these triggers at all) is stronger than a runtime rehearsal and cannot false-pass on a shim. If the drop count ever intentionally changes, update the pin in the same commit with the reason.

- [ ] **Step 2: Run**

Run: `node --test scripts/rehearse-scoped-trigger-boot-survival.test.js`
Expected: 2/2 PASS (the boot node currently satisfies both).

---

## Task 7: `osi-scope-helper` seam module (TDD)

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/package.json`

The module is db-handle-injectable (like `osi-journal`): callers pass the `osiDb` facade (`await db.all(sql, params)` / `await db.get(...)`). The cache is module-local.

- [ ] **Step 1: Write the failing unit tests**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const scope = require('./index.js');

// Fake db: queues canned answers per SQL substring match.
function fakeDb(handlers) {
  const calls = [];
  return {
    calls,
    async all(sql, params) { calls.push({ sql, params }); return handlers.all ? handlers.all(sql, params) : []; },
    async get(sql, params) { calls.push({ sql, params }); return handlers.get ? handlers.get(sql, params) : undefined; },
  };
}

test.beforeEach(() => scope._resetForTests());

test('flag off: wildcard admin scope, zero db reads', async () => {
  const db = fakeDb({});
  const s = await scope.resolveScope(db, 'u1', { scopedMode: false });
  assert.equal(s.role, 'admin');
  assert.equal(s.wildcard, true);
  assert.equal(db.calls.length, 0);
});

test('union rule: owned zones (users.id) plus granted zones (user_uuid)', async () => {
  const db = fakeDb({
    get: (sql) => sql.includes('FROM users')
      ? { id: 7, role: 'researcher', disabled_at: null } : undefined,
    all: (sql) => {
      if (sql.includes('FROM irrigation_zones')) return [{ zone_uuid: 'z-owned' }];
      if (sql.includes('FROM user_zone_assignments')) return [{ zone_uuid: 'z-granted' }];
      if (sql.includes('FROM user_plot_assignments')) return [{ plot_uuid: 'p-granted' }];
      if (sql.includes('FROM journal_plots')) return [{ plot_uuid: 'p-owned' }];
      return [];
    },
  });
  const s = await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.deepEqual([...s.zoneUuids].sort(), ['z-granted', 'z-owned']);
  assert.deepEqual([...s.plotUuids].sort(), ['p-granted', 'p-owned']);
});

test('null user_uuid is a hard error, never an empty scope', async () => {
  const db = fakeDb({ get: () => ({ id: 7, role: 'researcher', disabled_at: null, user_uuid: null }) });
  await assert.rejects(() => scope.resolveScope(db, null, { scopedMode: true }), /user_uuid/);
});

test('cache: second resolve within TTL hits no db; invalidateScope forces re-read', async () => {
  let userReads = 0;
  const db = fakeDb({
    get: () => { userReads += 1; return { id: 7, role: 'viewer', disabled_at: null }; },
  });
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.equal(userReads, 1);
  scope.invalidateScope('u1');
  await scope.resolveScope(db, 'u1', { scopedMode: true });
  assert.equal(userReads, 2);
});

test('fresh asserts bypass cache; cached read path does not', async () => {
  let grantReads = 0;
  const db = fakeDb({
    get: (sql) => sql.includes('FROM users') ? { id: 7, role: 'researcher', disabled_at: null } : undefined,
    all: (sql) => {
      if (sql.includes('user_zone_assignments')) { grantReads += 1; return [{ zone_uuid: 'z1' }]; }
      return [];
    },
  });
  await scope.resolveScope(db, 'u1', { scopedMode: true });           // grants read #1
  await scope.assertZoneAccess(db, 'u1', 'z1', { scopedMode: true }); // cached: no new read
  assert.equal(grantReads, 1);
  await scope.assertFreshZoneAccess(db, 'u1', 'z1', { scopedMode: true }); // bypass: read #2
  assert.equal(grantReads, 2);
});

test('assertZoneAccess throws {status:404} outside scope; assertRole throws {status:403}', async () => {
  const db = fakeDb({
    get: () => ({ id: 7, role: 'viewer', disabled_at: null }),
    all: () => [],
  });
  await assert.rejects(
    () => scope.assertZoneAccess(db, 'u1', 'z-foreign', { scopedMode: true }),
    (e) => e.status === 404);
  await assert.rejects(
    () => scope.assertRole(db, 'u1', 'admin', { scopedMode: true }),
    (e) => e.status === 403);
});

test('disabled account fails closed on fresh paths', async () => {
  const db = fakeDb({ get: () => ({ id: 7, role: 'admin', disabled_at: '2026-07-01' }) });
  await assert.rejects(
    () => scope.assertFreshZoneAccess(db, 'u1', 'z1', { scopedMode: true }),
    (e) => e.status === 403 && /disabled/.test(e.message));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 3: Write the module**

`package.json`:

```json
{
  "name": "osi-scope-helper",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
```

`index.js`:

```js
'use strict';
// osi-scope-helper — scoped multi-user access resolution (AgroLink).
// Spec: docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md §4/§8.
// Scope = owned (integer users.id bindings) UNION granted (user_uuid rows).
// Read paths use a 30 s per-user cache; physical-effect paths use assertFresh*.
const CACHE_TTL_MS = 30000;
const cache = new Map(); // userUuid -> { at, scope }

function isScopedMode(envValue) {
  return String(envValue !== undefined ? envValue : process.env.OSI_SCOPED_ACCESS || '') === '1';
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function loadUser(db, userUuid) {
  if (!userUuid) throw httpError(500, 'resolveScope called without user_uuid');
  const row = await db.get(
    'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE user_uuid = ?',
    [userUuid]
  );
  if (!row) throw httpError(403, 'unknown user');
  if (!row.user_uuid) throw httpError(500, 'user row has null user_uuid (scoped-access backfill incomplete)');
  return row;
}

async function loadScope(db, userUuid) {
  const user = await loadUser(db, userUuid);
  const scope = {
    role: user.role,
    username: user.username,
    disabled: !!user.disabled_at,
    wildcard: false,
    zoneUuids: new Set(),
    plotUuids: new Set(),
  };
  if (user.disabled_at) return scope; // disabled: scope stays empty, role still reported
  const ownedZones = await db.all(
    'SELECT zone_uuid FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL AND zone_uuid IS NOT NULL',
    [user.id]
  );
  for (const r of ownedZones) scope.zoneUuids.add(r.zone_uuid);
  const grantedZones = await db.all(
    'SELECT zone_uuid FROM user_zone_assignments WHERE user_uuid = ? AND deleted_at IS NULL',
    [userUuid]
  );
  for (const r of grantedZones) scope.zoneUuids.add(r.zone_uuid);
  const ownedPlots = await db.all(
    'SELECT plot_uuid FROM journal_plots WHERE owner_user_uuid = ? AND deleted_at IS NULL',
    [userUuid]
  );
  for (const r of ownedPlots) scope.plotUuids.add(r.plot_uuid);
  const grantedPlots = await db.all(
    'SELECT plot_uuid FROM user_plot_assignments WHERE user_uuid = ? AND deleted_at IS NULL',
    [userUuid]
  );
  for (const r of grantedPlots) scope.plotUuids.add(r.plot_uuid);
  return scope;
}

async function resolveScope(db, userUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) {
    return { role: 'admin', disabled: false, wildcard: true, zoneUuids: null, plotUuids: null };
  }
  const hit = cache.get(userUuid);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scope;
  const scope = await loadScope(db, userUuid);
  cache.set(userUuid, { at: Date.now(), scope });
  return scope;
}

function invalidateScope(userUuid) {
  if (userUuid) cache.delete(userUuid);
  else cache.clear();
}

function scopeAllows(scope, kind, uuid) {
  if (scope.wildcard) return true;
  if (scope.disabled) return false;
  const set = kind === 'zone' ? scope.zoneUuids : scope.plotUuids;
  return set.has(uuid);
}

async function assertZoneAccess(db, userUuid, zoneUuid, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (!scopeAllows(scope, 'zone', zoneUuid)) throw httpError(404, 'zone not found');
  return scope;
}

async function assertPlotAccess(db, userUuid, plotUuid, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (!scopeAllows(scope, 'plot', plotUuid)) throw httpError(404, 'plot not found');
  return scope;
}

async function assertFreshZoneAccess(db, userUuid, zoneUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) return { role: 'admin', wildcard: true };
  const scope = await loadScope(db, userUuid); // no cache
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scopeAllows(scope, 'zone', zoneUuid)) throw httpError(404, 'zone not found');
  return scope;
}

async function assertFreshPlotAccess(db, userUuid, plotUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) return { role: 'admin', wildcard: true };
  const scope = await loadScope(db, userUuid);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scopeAllows(scope, 'plot', plotUuid)) throw httpError(404, 'plot not found');
  return scope;
}

async function assertRole(db, userUuid, role, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scope.wildcard && scope.role !== role) throw httpError(403, 'insufficient role');
  return scope;
}

async function isAdmin(db, userUuid, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  return !scope.disabled && (scope.wildcard || scope.role === 'admin');
}

async function filterZoneUuids(db, userUuid, zoneUuids, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (scope.wildcard) return zoneUuids;
  if (scope.disabled) return [];
  return zoneUuids.filter((z) => scope.zoneUuids.has(z));
}

function _resetForTests() { cache.clear(); }

module.exports = {
  isScopedMode, resolveScope, invalidateScope,
  assertZoneAccess, assertPlotAccess, assertFreshZoneAccess, assertFreshPlotAccess,
  assertRole, isAdmin, filterZoneUuids, _resetForTests,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js`
Expected: 7/7 PASS.

---

## Task 8: Helper registration surfaces

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js` (NAME_TO_PATH)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` (deps)
- Create: symlinks `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/osi-scope-helper` → `../osi-scope-helper`
- Modify: `deploy.sh` (fetch_required lines)
- Mirror: all of the above into the `bcm2709` profile (copy the module dir; replicate edits identically; create the same symlink)

- [ ] **Step 1: Register in osi-lib NAME_TO_PATH**

In `osi-lib/index.js`, add after the `'osi-journal'` line:

```js
  'scope': 'osi-scope-helper',
```

- [ ] **Step 2: package.json dependency**

Add to `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` dependencies (alphabetical, matching existing entries):

```json
    "osi-scope-helper": "file:osi-scope-helper",
```

- [ ] **Step 3: node_modules symlink (both profiles)**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules
ln -s ../osi-scope-helper osi-scope-helper
cd ../../../../../..
cp -r conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/
cd conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/node_modules
ln -s ../osi-scope-helper osi-scope-helper
```

Apply the osi-lib and package.json edits identically in the bcm2709 copies (they are byte-mirrored; edit both or edit bcm2712 then `cp` the two files over).

- [ ] **Step 4: deploy.sh fetch lines**

After the `osi-dendro-helper` fetch block (~line 414), add:

```sh
fetch_required "osi-scope-helper package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/package.json" \
    "/srv/node-red/osi-scope-helper/package.json"

fetch_required "osi-scope-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.js" \
    "/srv/node-red/osi-scope-helper/index.js"
```

- [ ] **Step 5: Verify registration + parity**

```bash
node scripts/verify-helper-registration.js
node scripts/verify-profile-parity.js
```
Expected: exit 0; parity ends `All parity checks passed.`

- [ ] **Step 6: Commit**

```bash
git add conf/ deploy.sh
git commit -m "feat(scope): osi-scope-helper seam module with registration surfaces"
```

---

## Task 9: `/api/me` endpoint (flow edit)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (+ byte-mirror to bcm2709)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json` (total allowance for the new thin nodes)

Load `osi-flows-json-editing` before this task. New nodes load logic via `osiLib.require('scope')` to stay thin.

- [ ] **Step 1: Copy the auth precedent and record the diff**

Node `get-zones-auth` ("Decode Token") is the auth-block precedent for a GET endpoint. Extract its `func` with the flow-edit script, copy the token-decode block verbatim, and diff your new node's auth section against it. Do not retype HMAC/expiry logic.

- [ ] **Step 2: Mutation script — add 3 nodes**

Add: `http in` GET `/api/me` → function `api-me-fn` ("Resolve Current User Scope") → `http response`. The function (thin; auth block copied verbatim from `get-zones-auth` per Step 1, then):

```js
// After the copied auth block, which leaves the authenticated username in
// flow.get('status_username') — keep the precedent's variable names.
const username = flow.get('status_username');
if (!username) { msg.statusCode = 401; msg.payload = { message: 'Unauthorized' }; return msg; }

const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
const load = osiLib.require('scope');
if (!load.ok) {
  node.error('api-me: scope module unavailable: ' + load.error, msg);
  msg.statusCode = 500; msg.payload = { message: 'scope resolver unavailable' }; return msg;
}
const S = load.value;

return (async () => {
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((res) => db.close(() => res()));
  try {
    const user = await db.get(
      'SELECT username, user_uuid, role, disabled_at FROM users WHERE username = ?', [username]);
    if (!user || user.disabled_at) { msg.statusCode = 403; msg.payload = { message: 'Forbidden' }; return msg; }
    let body;
    if (!scopedOn) {
      body = { username: user.username, user_uuid: user.user_uuid, role: 'admin',
               zone_uuids: null, plot_uuids: null, features: { scoped_access: false } };
    } else {
      const scope = await S.resolveScope(db, user.user_uuid, { scopedMode: true });
      body = { username: user.username, user_uuid: user.user_uuid, role: scope.role,
               zone_uuids: [...scope.zoneUuids], plot_uuids: [...scope.plotUuids],
               features: { scoped_access: true } };
    }
    msg.statusCode = 200;
    msg.payload = body;
    return msg;
  } catch (e) {
    node.warn('api-me failed: ' + (e && e.message ? e.message : e));
    msg.statusCode = 500; msg.payload = { message: 'unable to resolve scope' };
    return msg;
  } finally {
    try { await close(); } catch (e) { node.warn('api-me close failed: ' + (e && e.message ? e.message : e)); }
  }
})();
```

Node `libs`: `[{ "var": "osiLib", "module": "osi-lib" }, { "var": "osiDb", "module": "osi-db-helper" }]`. Mint fresh 16-hex ids. Place nodes on the same tab (`z`) as `get-zones-auth`.

- [ ] **Step 3: Allowance entry**

In `scripts/verify-flows-size-ratchet-allowances.json`, add a `total_allowance` delta covering the three new thin nodes' embedded JS with a reason (`AgroLink Phase A: /api/me thin scope-resolution endpoint`), or confirm the thin-new-node heuristic already covers them and leave the file unchanged. Run the ratchet to decide which:

```bash
node scripts/verify-flows-size-ratchet.js
```

- [ ] **Step 4: Pre-commit checklist**

Run every row of the `osi-flows-json-editing` pre-commit checklist (roundtrip guard both profiles, `verify-profile-parity.js`, `verify-sync-flow.js`, `check-mqtt-topics.sh`, `test-flows-wiring.js`, `verify-no-new-silent-catch.js`, `verify-no-stray-ddl.js`, `verify-flows-size-ratchet.js`, `flows-bare-require-scan.js`, `verify-flows-fn-parse.js`).

- [ ] **Step 5: Commit**

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json
git commit -m "feat(api): /api/me scope-profile endpoint behind OSI_SCOPED_ACCESS"
```

---

## Task 10: Scoped bootstrap registration in `auth-db-insert`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (node `auth-db-insert`, + mirror)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json` (node allowance for `auth-db-insert` growth)

Behavior (spec §10): legacy mode: unchanged. Scoped mode: single conditional write: first user becomes admin while no admin row exists in any state; otherwise 403. Losing a concurrent bootstrap race yields 403 with a distinct message.

- [ ] **Step 1: Replace `auth-db-insert` func via mutation script**

```js
return (async () => {
  const userInsert = msg.userInsert || {};
  const username = String(userInsert.username || '').trim();
  const passwordHash = String(userInsert.passwordHash || '').trim();
  const createdAt = String(userInsert.createdAt || '').trim();
  if (!username || !passwordHash || !createdAt) {
    msg.statusCode = 500;
    msg.payload = { message: 'User registration payload is incomplete' };
    return [null, msg];
  }

  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  const db = new osiDb.Database('/data/db/farming.db');
  const run = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
  const q = (sql, params) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
  const close = () => new Promise((resolve) => db.close(() => resolve()));

  try {
    if (scopedOn) {
      // Single conditional write: atomic bootstrap on the serialized queue.
      await run(
        "INSERT INTO users (username, password_hash, created_at, role) " +
        "SELECT ?, ?, ?, 'admin' " +
        "WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')",
        [username, passwordHash, createdAt]
      );
      const rows = await q('SELECT username FROM users WHERE username = ?', [username]);
      if (!rows.length) {
        msg.statusCode = 403;
        msg.payload = { message: 'Public registration is closed. Ask an admin to create your account.' };
        return [null, msg];
      }
      return [msg, null];
    }
    await run(
      'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
      [username, passwordHash, createdAt]
    );
    return [msg, null];
  } catch (error) {
    msg.statusCode = 500;
    msg.payload = { message: 'Unable to create local user', detail: String(error.message || error) };
    return [null, msg];
  } finally {
    try { await close(); } catch (e) { node.warn('auth-db-insert close failed: ' + (e && e.message ? e.message : e)); }
  }
})();
```

- [ ] **Step 2: Allowance entry for node growth**

Add to `verify-flows-size-ratchet-allowances.json` `node_allowances`:

```json
"auth-db-insert": { "delta": 1100, "reason": "AgroLink Phase A: scoped-mode conditional bootstrap insert (single atomic write, spec §10)" }
```

(Measure the real delta after the edit and use that value, keeping the reason.)

- [ ] **Step 3: Rehearsal of the conditional write semantics**

Extend `scripts/rehearse-scoped-access-migration.test.js` with:

```js
test('conditional bootstrap insert: exactly one admin, loser gets zero rows', () => {
  const db = freshDb();
  const BOOT = `INSERT INTO users (username, password_hash, created_at, role)
    SELECT ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role='admin')`;
  db.prepare(BOOT).run('first', 'h', '2026-01-01');
  db.prepare(BOOT).run('second', 'h', '2026-01-01'); // loses: admin now exists
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE role='admin'`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE username='second'`).get().n, 0);
  // A disabled admin still blocks bootstrap (spec §10: any-state count).
  db.exec(`UPDATE users
              SET disabled_at='2026-01-02', sync_version=sync_version+1
            WHERE role='admin'`);
  db.prepare(BOOT).run('third', 'h', '2026-01-01');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM users WHERE username='third'`).get().n, 0);
  db.close();
});
```

Run: `node --test scripts/rehearse-scoped-access-migration.test.js` — expect 8/8 PASS.

- [ ] **Step 4: Pre-commit checklist + commit**

Full flow checklist as in Task 9 Step 4, then:

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json scripts/rehearse-scoped-access-migration.test.js
git commit -m "feat(auth): scoped-mode atomic bootstrap registration"
```

---

## Task 11: `scoped_access` in `/api/system/features`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (node `history-api-router-fn`, + mirror)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

- [ ] **Step 1: Locate the features payload builder and add the flag**

In `history-api-router-fn`'s `func`, find the object literal that builds the `/api/system/features` response (it contains `fieldJournalUxEnabled`). Add a sibling key built from the same env-read style that node already uses:

```js
scoped_access: String(env.get('OSI_SCOPED_ACCESS') || '') === '1',
```

- [ ] **Step 2: Allowance + checklist + commit**

Measure the delta (expected < 100 chars), extend the existing `history-api-router-fn` allowance reason with `; AgroLink Phase A: scoped_access feature flag (+NN)`, run the full flow checklist, and:

```bash
git add conf/ scripts/verify-flows-size-ratchet-allowances.json
git commit -m "feat(api): expose scoped_access in /api/system/features"
```

---

## Task 12: Final gate and Phase A acceptance

- [ ] **Step 1: Full verifier sweep**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
node scripts/verify-helper-registration.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/test-flows-wiring.js
scripts/check-mqtt-topics.sh
node --test scripts/rehearse-scoped-access-migration.test.js
node --test scripts/rehearse-scoped-trigger-boot-survival.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-scope-helper/index.test.js
```
Expected: every command exit 0 with its documented OK line.

- [ ] **Step 2: Acceptance against spec §15 Phase A gate**

- Migration + parity verifiers green: Step 1 output.
- Fresh-image rehearsal: the backfill is a zero-user no-op and conditional bootstrap produces exactly one admin.
- In-place rehearsal: the data migration covers uuid/version backfill and lowest-id promotion.
- Version rehearsal: every emitted user event is positive, and two successive synced mutations increase its version.
- Restart-reversion: boot-survival test green.

---

## Notes for the executor

- **No DDL in flows.json.** All schema lives in Tasks 2–5. `verify-no-stray-ddl.js` must stay green; the conditional INSERT in Task 10 is DML, not DDL.
- **The emit gate stays off.** Nothing in Phase A sets `scoped_access_emit.enabled=1`. If any test or node does, that is a defect; Phase E owns the flip.
- **Profile parity is byte-level.** Every `conf/.../bcm2712/...` change has a `bcm2709` counterpart in the same commit.
- **Do not edit any migration present at `LAST_VERSION`.** Checksum enforcement will reject the run.
- If `verify-flows-size-ratchet.js` fails in a way this plan did not predict, stop and surface it; do not buy green with a larger unexplained allowance.
- **Program context.** The 2026-07-23 parity orchestrator owns cross-repository contract CI, desired state, scoped cloud administration, and protocol activation after this Phase A rebase. Do not pull those later slices into this plan.
