# Radio storage readiness plan

This Phase 0 plan defines the interfaces needed before implementing network
observation capture. It is based on the revised design and the current main
surfaces: `osi-db-helper` is the Node-RED SQLite facade, `osi-history-sync-helper`
owns history table definitions/hash/cursor logic, and `sync_history_*` state is
currently in `farming.db`. The scratch branch `createDedicatedDatabase`
primitive is not a dependency.

## 1. Dedicated database lifecycle

Add a path-aware extension to
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js`
and mirror it byte-for-byte to bcm2709. Preserve `new Database()` and the
existing `/data/db/farming.db` behavior. The facade should expose:

```js
Database.open('/data/db/radio.db', { role: 'radio' })
Database.path('/data/db/radio.db') // canonical validated path
Database.health('/data/db/radio.db')
```

`open()` returns the same callback/Promise facade (`all`, `get`, `run`, `exec`,
`transaction`, `readSnapshot`, `close`) but maintains an independent connection,
operation queue, health record, and `busy_timeout`. Only allow the two exact
approved paths (`farming.db`, `radio.db`); reject symlinks, parent traversal,
directories, and arbitrary caller paths. Set radio pragmas to WAL,
`synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, and a bounded
checkpoint policy. `close()` must actually drain and close the path-owned
connection; the legacy facade remains a no-op close for compatibility until all
callers migrate.

Add `lib/osi-radio-store/` (or the equivalent deployed helper module) for
lifecycle operations rather than putting radio DDL in the frozen
`sync-init-fn` node:

```js
await radioStore.ensure({ dbPath: '/data/db/radio.db', migrationsDir })
await radioStore.integrityCheck()
await radioStore.backup({ reason })
await radioStore.checkpoint({ mode: 'PASSIVE' })
await radioStore.status() // schema head, bytes, oldest unsynced age, paused state
```

Use a radio-specific ordered migration ledger and fingerprints, with the next
available migration number chosen from refreshed main at implementation time.
The migration runner must use the existing backup/integrity machinery with the
radio path, and radio migration failure must not block agronomic DB startup.
The lifecycle creates the file only when absent, never replaces an existing
radio DB, and pauses capture on migration, integrity, disk-budget, or restore
failure. A 512 MiB configurable budget and reserved-free-space check stop new
radio writes before the hard limit; they do not prune rows.

## 2. Radio source and history adapter

Add a source adapter beside
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.js`
with the existing helper contract extended for `radio_uplinks`:

```js
radioSource = {
  tableName: 'radio_uplinks',
  cursorKind: 'id',
  readSnapshot(fn),             // one read-only radio transaction
  snapshotHigh(),
  batch(after, high, limit, phase),
  rowByHistoryKey(historyKey),
  segment(segmentKey),
  prepareRow(row), segmentKey(row),
}
```

`readSnapshot()` must read each parent and its embedded receiver array from one
radio connection snapshot. `radio_uplinks.id` is the only parent cursor and is
never replaced by receiver IDs. Receiver ordering, null receiver-ID handling,
UTC timestamps, finite numeric values, and JSON ordering are frozen in shared
fixtures. Receiver fan-out exceeding explicit limits is quarantined; it is
never silently truncated. The adapter registers `TABLE_COLUMNS`,
`TABLE_DEFINITIONS`, `tableNames`, cursor, segment, dirty lookup, and hash paths
without changing existing table hashes or hash versions.

The `Build History Batch`, `Mark History Batch ACK`, and manifest/repair paths
must obtain radio rows through this adapter and keep cursor advancement in
`farming.db` only after the existing durable acknowledgement. The transport
stays `POST /api/v1/sync/edge/history/batches` with `tableName=radio_uplinks`;
no radio-specific endpoint, cursor envelope, or capability is introduced.

## 3. Durable dirty bridge

Radio schema adds a local `radio_history_dirty` table keyed by `(history_key)`
with `generation INTEGER`, `change_kind`, `source_row_id`, `changed_at`, and
`status`. The capture transaction inserts/updates the parent and its receiver
payload, then upserts its dirty marker with `generation = generation + 1` in the
same radio transaction. A receiver correction therefore cannot commit without
its correction marker.

Farming schema adds a bridge ledger, through the normal ordered migration, with
`radio_history_bridge(history_key PRIMARY KEY, generation, status,
claimed_at, transferred_at, last_error)`. A dedicated bridge tick:

1. reads a bounded radio marker snapshot;
2. inserts/updates the matching `sync_history_dirty_keys` row in `farming.db`
   (`table_name='radio_uplinks'`, preserving `change_kind` and source row ID);
3. records the transferred generation in `radio_history_bridge`; and
4. clears or marks the radio marker only with a compare-and-set on its captured
   generation.

Repeating the tick is idempotent. If capture races the bridge, a newer
generation remains pending. If the process dies between either database
commit, the marker or bridge ledger causes replay. The bridge must expose
pending/error counts and oldest age, and it must fail closed when either DB is
unavailable. It must not claim a cross-database transaction or delete a marker
based on an eventual cloud ACK; the existing history ACK path owns dirty-key
completion in `farming.db`.

## 4. Restore and identity safeguards

The first radio migration creates `radio_store_identity` as a singleton keyed
by `singleton_id=1`, with `radio_store_uuid`, `installation_uuid`,
`created_at`, `updated_at`, and state (`ACTIVE`, `RESTORING`, `RECONCILING`,
`BLOCKED`). The first `radio_uplinks` table is deliberately narrow and stable:
`id INTEGER PRIMARY KEY`, `installation_uuid TEXT`, `deveui TEXT`,
`recorded_at TIMESTAMP`, `deduplication_id TEXT`, and `metadata_json JSON`;
receiver records and optional RF/GPS fields live in the bounded canonical JSON
object. Freeze the final hash-column list in fixtures before producer enablement.
Radio metadata must contain the edge `installation_uuid`, the current gateway
EUI at creation, a radio-store UUID, schema head, and creation timestamp. On
open, `radioStore` reads `installation_identity` from `farming.db` and refuses
radio writes, history reads, and sync when the stored installation UUID does
not match. A missing metadata row is treated as an uninitialized/recovery state,
not as permission to adopt the file silently. A recreated empty DB receives a
new radio-store UUID and remains capture-paused until an explicit reconcile
operation binds it to the existing installation; it must never reuse old row
IDs against an old cursor by accident. If a prior radio-store marker exists in
farming DB but `radio.db` is missing, startup refuses to create a new store and
enters recovery.

Restore is an operator lifecycle: stop radio writers, verify the backup with
`PRAGMA integrity_check`, verify metadata installation UUID and expected
current/previous gateway EUI, then copy via the approved backup path while
preserving `radio_uplinks.id`. Set `installation_identity.recovery_state` to
`RESTORING` with a fresh operation UUID and write `installation_recovery_audit`
events. After restore, run identity/schema/integrity checks and a reconciliation
pass; only then set `ACTIVE`, clear the operation, and resume capture/sync. Any
mismatch sets `BLOCKED` and leaves radio capture and history sync paused. Do not
derive identity from a candidate EUI or overwrite `installation_identity` from
the radio file.

## 5. Implementation files and verification

Expected implementation surfaces (both maintained profiles where payload files
are touched):

- `osi-db-helper/index.js` and tests for independent path queues, path rejection,
  snapshots, close, WAL/checkpoint, and failure isolation.
- `lib/osi-radio-store/` plus radio ordered migration/seed/install lifecycle,
  backup and integrity tests.
- `osi-history-sync-helper/index.js` and canonical radio/hash fixtures.
- `flows.json`: one capture writer, bridge tick, and history source wiring; no
  DDL in `sync-init-fn`.
- `database/seed-blank.sql` only for the farming bridge table; radio schema is
  owned by the radio migration ledger.
- `scripts/verify-radio-storage.js` and focused Node tests for crash/replay,
  generation CAS, restore mismatch, ID preservation, budget pause, and radio
  history ACK semantics.

Before implementation merge, run at minimum:

```bash
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-profile-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/test-osi-db-helper-read-snapshot.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper/index.test.js
node --test scripts/test-sync-history-durable-flow.js scripts/test-sync-history-durable-integration.js
node --test scripts/verify-radio-storage.test.js
```

Add radio lifecycle/restore tests to the migration gate and run the full GUI
suite only if the eventual change touches GUI routes or types.
