# Daily Agronomy Parity E4: Daily Record Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `zone_daily_agronomy` row replicates to OSI Server: migration 0065 versions the rows and adds two migration-owned outbox triggers that emit `ZONE_AGRONOMY_UPSERTED`, the writer inserts at version 1, adds 1 per real change and retracts a clock-ahead row by an update instead of deleting it, and the scheduled bootstrap carries the last 30 days of each zone.

**Architecture:** The triggers follow `trg_dp_zone_env_outbox_ai/au` (0058) with one addition, a zone guard in `WHEN` (live zone with a UUID), so the aggregate key is always `zone_uuid|date`. They live in 0065 and the seed, not in the boot node, and are listed as migration-owned in the two parity verifiers. The event contract gains the op with a version binding and no key binding (the key is composite). `osi-agronomy-daily` sets `sync_version` in its upsert and replaces its `DELETE` with a retraction `UPDATE`. `sync-bootstrap-build` adds a `zoneAgronomy` list next to `zoneEnvironments`; `sync-force-build` is not extended.

**Tech Stack:** Node.js 22 (`node:test`, `node:sqlite`), SQLite triggers through the `osi-migrate` runner, Node-RED function nodes edited by a one-shot script, JSON Schema draft-07 (`events.schema.json`, `test-contract-schemas.js`), `verify-sync-op-parity.js` against the paired osi-server branch.

**Spec:** `docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md` (B3, B4 "Upsert" versions and "Retraction", B6, D "Deploy order" and "The `unknown_op` hazard", E row "E4").

**Prerequisites (check before Task 1):**

1. Plans E2a, E2b and E3 are done on this branch: 0064 exists, `verify-sync-op-parity.js` reads 0063's `CASE` payload (E2a Task 1 Step 2), the writer freezes `stage_started_on`, `kc_stage_day`, `stage_overrun` and writes `et0_source = 'fao56_hourly'` for station days. `ls database/migrations/ordered/0064__stage_started_on.sql` and `grep -c "fao56_hourly" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js` (prints `1`).
2. The paired osi-server branch `feat/daily-agronomy-parity` carries plan CC1 (the applier `ZoneAgronomyApplier` with `supportedOps() = Set.of("ZONE_AGRONOMY_UPSERTED")`, the op in its vendored contract and goldens). `verify-sync-op-parity.js` fails without it ("server missing from union: ZONE_AGRONOMY_UPSERTED"), in CI and locally.
3. **Deploy gate, not a code gate:** no gateway linked to a cloud may run a build with this plan until plan CC (CC1 and CC2) is deployed on that cloud, on main and on every customer instance (spec D). A cloud without the applier answers every daily row with a terminal `unknown_op`; a resend answers DUPLICATE, so the dead letters stay until an operator replays them. A customer cloud that runs from a branch without the appliers gets them first; the private SDD ledger lists the customer clouds and their deployed revisions, and this public plan names none of them (controller ruling on plan review E2-E4 I4). Pushing, merging and deploying stay Phil's call.
4. If the RAK branch's 0060 lands on main first, 0065 is renumbered with the rest (spec B constraints).

## Global Constraints

From the spec, verbatim:

- "schema only through ordered migrations, never in flows or `deploy.sh`, and never in the frozen `sync-init-fn`"; "bundled seeds rebuilt with `node scripts/build-seed-db.js` (seven DBs)"; "the flows size ratchet gets a measured allowance for every node that grows, and `scripts/verify-live-gateway-identity.js` `expectedGrowth` is re-pinned for `sync-bootstrap-build`, `sync-force-build` and `al-link-build-req` when they grow; the migrate-runner pin in `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js` lists 64 and 65."
- B3: "There is no `AFTER DELETE` trigger and no delete op: the writer never deletes a row (B4)." "The migration file writes the `au` body out in full."
- B3: "Follow-ups: seed, seven DBs, `CHECKSUMS.json`, `schemaContract`, `MIGRATION_OWNED_TRIGGERS` in `verify-runtime-schema-parity.js` (two entries, owner `0065__zone_daily_agronomy_sync.sql`; precedent 0046, 0056) and `MIGRATION_OWNED_TRIGGER_NAMES` in `verify-trigger-body-parity.js`. The triggers are migration-owned and absent from the boot node, so they do not join the `verify-sync-flow.js` loop at lines 1567-1581 … `verify-sync-flow.js` gets seed-only pins instead".
- B3 versions: "The writer inserts a row with `sync_version = 1`, and its upsert sets `sync_version = zone_daily_agronomy.sync_version + 1` whenever the `WHERE` finds a changed column (the 0015 rule), so `au` fires once per real change." "Rows that exist before 0065 keep version 0 until their first change; the bootstrap brings them over."
- B4 retraction: the `DELETE … WHERE date >= today` "becomes an update that nulls the values of rows a clock that ran ahead wrote … The count joins `summary.retracted` (renamed from `deleted`)."
- B6: "`sync-force-build` is not extended (spec decision; a force sync posts no `zoneAgronomy`, the cloud treats the missing list as empty, and the next scheduled bootstrap carries it)." "`osi-history-sync-helper` does not learn `zone_daily_agronomy`."
- B6 contract: "the op enum gains `ZONE_AGRONOMY_UPSERTED`; `x-semantic-bindings` gains it with `{"sync_version_path": "payload.sync_version"}` and no `aggregate_key_path` … The op enters the edge schema with the edge producer, in this PR; no staging entry is used (D)."
- B6 verifiers: "`verify-sync-op-parity.js`: the op joins `SQL_OWNED_EVENT_OPS` (lines 159-191) with the comment "Emitted by 0065__zone_daily_agronomy_sync.sql's trg_dp_zone_agronomy_outbox_* triggers, not by flows.json"."
- D: "The cloud deploys before any edge that carries this branch, on main and on every customer instance." "Merge order is not deploy order; deploy stays cloud first."

Operational rules:

- Work only in `<osi-os>/.worktrees/daily-agronomy-parity`; run every command from its root. Never `cd` into `<osi-os>` or `<osi-server>`. Never bare `git stash`. Never push, never deploy. Commits use `git -c user.name=Project-OSI commit`.
- `$SCRATCH` is the session scratchpad; one-shot scripts live there and are never committed. `$CLOUD_WT` is `<osi-server>/.worktrees/daily-agronomy-cloud` (read only).
- Every file changed under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is mirrored byte for byte under `bcm2709`.
- The ratchet numbers assume `origin/main` at 1580418 characters per profile, as sub-project 3 and plan E2a measured, and carry plan E2a's totals as its one-shots measured them on the rebased branch (total +16789, `sync-bootstrap-build` +252); pin what the scripts print. Test counts likewise: pin the count the runner prints.
- Prose passes `node .claude/skills/anti-slop-writing/slop-check.js`.

## Review Focus

1. **A clock that ran ahead and wrote rows for today or later.** Each such row is retracted once (values null, `null_reason = 'retracted'`, version + 1, one event with nulls), a second run does not bump it again, and the day's later computation overwrites it with the next version, so the cloud never sees a version go backwards. Pinned in Task 2 ("retraction: a clock-ahead row is retracted once …" and the trigger test "the writer: each new day emits version 1; a retraction emits one event with null values and the next version").
2. **A run that changes nothing.** No row's version moves and no event is emitted; a changed day moves by exactly 1. Pinned in Task 2 ("versions: an insert is version 1, a changed day adds 1, an unchanged run adds nothing" and the writer trigger test's second run).
3. **A zone without a UUID, a deleted zone, an unlinked gateway.** The triggers emit nothing, so the aggregate key never needs a `zone-id:` fallback and the cloud never receives a row it cannot place. Pinned in Task 1 ("nothing is emitted while the gateway is unlinked, for a zone without a UUID, or for a deleted zone").
4. **A large gateway in the bootstrap.** 39 live zones × 30 days exceed the cap: the list stops at 1,000 rows, the newest day of every zone comes first, nothing older than 30 days and nothing of a deleted zone is sent. Pinned in Task 3 ("the bootstrap snapshot carries zoneAgronomy …").
5. **An update that touches a row without changing its version** (a `computed_at` refresh, a manual repair). The `au` trigger stays silent, so the cloud's version check never sees an equal version with a different payload. Pinned in Task 1 ("an update emits only when sync_version changes, with the same payload shape").

## File Map

| File | Change | Task |
|---|---|---|
| `database/migrations/ordered/0065__zone_daily_agronomy_sync.sql`, `CHECKSUMS.json`, `database/seed-blank.sql`, seven bundled DBs | `sync_version`, the two triggers | 1 |
| `scripts/verify-runtime-schema-parity.js`, `scripts/verify-trigger-body-parity.js`, `scripts/verify-db-schema-consistency.js` | migration-owned lists, schema contract | 1 |
| `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `scripts/reconcile-ledger-numbering.test.js` | pins through 0065 | 1 |
| `docs/contracts/sync-schema/events.schema.json`, `scripts/test-contract-schemas.js`, `scripts/verify-sync-contract.js`, `scripts/verify-sync-op-parity.js` | the op, its binding (in the schema and in both pinned binding maps), SQL-owned | 1 |
| `scripts/test-zone-agronomy-sync-triggers.js` (new), `.github/workflows/verify-sync-flow.yml`, `scripts/verify-sync-flow.js` | trigger tests, CI, seed-only pins | 1, 2, 3 |
| `.../osi-agronomy-daily/index.js`, `index.test.js` | versions, retraction | 2 |
| both `flows.json`: `sync-bootstrap-build`; `scripts/verify-flows-size-ratchet-*.json`, `scripts/verify-live-gateway-identity.js` | `zoneAgronomy` | 3 |
| `docs/operations/edge-history-retention.md`, `AGENTS.md` (the provider weather store paragraph), `docs/contracts/sync-schema/README.md`, `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md` (plan E2a started it) | docs, report sections E3 and E4 | 4 |

In the tasks below `.../` stands for `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`.

---

### Task 1: Migration 0065, the triggers and the contract

**Files:**
- Create: `database/migrations/ordered/0065__zone_daily_agronomy_sync.sql`, `scripts/test-zone-agronomy-sync-triggers.js`
- Modify: `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql`, the seven bundled DBs (by `build-seed-db.js`), `scripts/verify-runtime-schema-parity.js`, `scripts/verify-trigger-body-parity.js`, `scripts/verify-db-schema-consistency.js`, `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `scripts/reconcile-ledger-numbering.test.js`, `docs/contracts/sync-schema/events.schema.json`, `scripts/test-contract-schemas.js`, `scripts/verify-sync-contract.js`, `scripts/verify-sync-op-parity.js`, `scripts/verify-sync-flow.js`, `.github/workflows/verify-sync-flow.yml`
- Scratch: `$SCRATCH/seed-0065.js`, `$SCRATCH/verifier-lists.py`, `$SCRATCH/contract-e4.py`, `$SCRATCH/vsf-e4-task1.py`

**Interfaces:**
- Produces: `zone_daily_agronomy.sync_version INTEGER NOT NULL DEFAULT 0`; triggers `trg_dp_zone_agronomy_outbox_ai` (every insert) and `trg_dp_zone_agronomy_outbox_au` (an update that changes `sync_version`), both gated on a linked cloud and a live zone with a UUID, each inserting one `sync_outbox` row `{ aggregate_type: 'ZONE_AGRONOMY', aggregate_key: '<zone_uuid>|<date>', op: 'ZONE_AGRONOMY_UPSERTED', sync_version: NEW.sync_version }` whose payload has exactly the 23 keys `contract_version, zone_id, zone_uuid, date, et0_mm, et0_tier, et0_source, et0_station_id, location_key, kc, kc_source, kc_stage_day, stage_overrun, crop_type, phenological_stage, stage_started_on, etc_mm, hours_present, expected_hours, null_reason, computed_at, gateway_device_eui, sync_version` (spec B3). The cloud's `ZoneAgronomyApplier` (plan CC1) reads that payload.

- [ ] **Step 1: Write the failing tests and put them in CI**

`scripts/test-zone-agronomy-sync-triggers.js` (Tasks 2 and 3 append to it):
```js
#!/usr/bin/env node
'use strict';

// Migration 0065: the daily agronomy record's outbox triggers (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B3). They
// are migration-owned (sync-init-fn does not create them), emit only while the
// gateway is linked and only for a zone with a UUID, carry the B3 payload, fire
// on update only when sync_version changes, and see a retraction as an
// ordinary ZONE_AGRONOMY_UPSERTED with null values.
//
// Run: node --test scripts/test-zone-agronomy-sync-triggers.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0065__zone_daily_agronomy_sync.sql'), 'utf8');
const GATEWAY = '00000000000000A1';
const ZONE_UUID = '306fa8ef-20f8-4911-b9c4-f99f60252579';
const PAYLOAD_KEYS = ['contract_version', 'zone_id', 'zone_uuid', 'date', 'et0_mm', 'et0_tier', 'et0_source', 'et0_station_id',
  'location_key', 'kc', 'kc_source', 'kc_stage_day', 'stage_overrun', 'crop_type', 'phenological_stage', 'stage_started_on',
  'etc_mm', 'hours_present', 'expected_hours', 'null_reason', 'computed_at', 'gateway_device_eui', 'sync_version'];
const TRIGGERS = ['trg_dp_zone_agronomy_outbox_ai', 'trg_dp_zone_agronomy_outbox_au'];

function database({ linked = true, zoneUuid = ZONE_UUID, deleted = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (7, 'grower', 'x', '2026-01-01')");
  db.prepare("INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, latitude, longitude, crop_type, phenological_stage, created_at, updated_at) VALUES (1, 'North', 7, ?, ?, 1, 'Europe/Zurich', 46.8, 6.95, 'maize', 'mid_season', '2026-01-01', '2026-01-01')")
    .run(zoneUuid, GATEWAY);
  if (linked) db.exec(`INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '${GATEWAY}', '2026-01-01')`);
  // A zone's defaults trigger assigns a UUID at insert; clear it afterwards for the guard case.
  if (zoneUuid === null) db.exec('UPDATE irrigation_zones SET zone_uuid = NULL WHERE id = 1');
  if (deleted) db.exec("UPDATE irrigation_zones SET deleted_at = '2026-09-01T00:00:00Z' WHERE id = 1");
  db.exec('DELETE FROM sync_outbox');
  return db;
}
function agronomyEvents(db) {
  return db.prepare("SELECT aggregate_key, op, sync_version, gateway_device_eui, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE_AGRONOMY' ORDER BY rowid").all()
    .map((row) => ({ key: row.aggregate_key, op: row.op, syncVersion: Number(row.sync_version), eui: row.gateway_device_eui, payload: JSON.parse(row.payload_json) }));
}
const ROW = "INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, et0_tier, et0_source, et0_station_id, kc, kc_source, kc_stage_day, stage_overrun, crop_type, phenological_stage, stage_started_on, etc_mm, hours_present, expected_hours, computed_at, sync_version) "
  + "VALUES (1, '2026-09-20', 3.12, 'station_fao56', 'fao56_hourly', 'S2120AAAA00000001', 0.75, 'fao56_curve', 16, 0, 'maize', 'late_season', '2026-09-05', 2.34, 24, 24, '2026-09-21T00:30:02.114Z', 1)";

test('0065 applies to a database at 0064: the column and both triggers, which sync-init-fn does not create', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SEED);
    for (const name of TRIGGERS) db.exec(`DROP TRIGGER ${name}`);
    db.exec('ALTER TABLE zone_daily_agronomy DROP COLUMN sync_version');
    db.exec(MIGRATION);
    assert.ok(db.prepare('PRAGMA table_info(zone_daily_agronomy)').all().some((c) => c.name === 'sync_version' && c.notnull === 1 && c.dflt_value === '0'));
    for (const name of TRIGGERS) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name), name);
    const flows = fs.readFileSync(path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'), 'utf8');
    for (const name of TRIGGERS) assert.ok(!flows.includes(name), `${name} must stay out of the boot node`);
  } finally {
    db.close();
  }
});

test('an insert emits one ZONE_AGRONOMY_UPSERTED with the B3 payload, keyed zone_uuid|date, at the row version', () => {
  const db = database();
  try {
    db.exec(ROW);
    const [event, ...rest] = agronomyEvents(db);
    assert.deepEqual(rest, []);
    assert.deepEqual([event.key, event.op, event.syncVersion, event.eui], [`${ZONE_UUID}|2026-09-20`, 'ZONE_AGRONOMY_UPSERTED', 1, GATEWAY]);
    assert.deepEqual(Object.keys(event.payload), PAYLOAD_KEYS);
    assert.deepEqual(event.payload, {
      contract_version: 1, zone_id: 1, zone_uuid: ZONE_UUID, date: '2026-09-20', et0_mm: 3.12, et0_tier: 'station_fao56', et0_source: 'fao56_hourly',
      et0_station_id: 'S2120AAAA00000001', location_key: null, kc: 0.75, kc_source: 'fao56_curve', kc_stage_day: 16, stage_overrun: 0,
      crop_type: 'maize', phenological_stage: 'late_season', stage_started_on: '2026-09-05', etc_mm: 2.34, hours_present: 24, expected_hours: 24,
      null_reason: null, computed_at: '2026-09-21T00:30:02.114Z', gateway_device_eui: GATEWAY, sync_version: 1,
    });
  } finally {
    db.close();
  }
});

test('an update emits only when sync_version changes, with the same payload shape', () => {
  const db = database();
  try {
    db.exec(ROW);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE zone_daily_agronomy SET computed_at = '2026-09-21T01:30:00.000Z' WHERE zone_id = 1");
    assert.deepEqual(agronomyEvents(db), [], 'no version change, no event');
    db.exec('UPDATE zone_daily_agronomy SET et0_mm = 3.2, sync_version = sync_version + 1 WHERE zone_id = 1');
    const events = agronomyEvents(db);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].syncVersion, events[0].payload.sync_version, events[0].payload.et0_mm], [2, 2, 3.2]);
    assert.deepEqual(Object.keys(events[0].payload), PAYLOAD_KEYS);
  } finally {
    db.close();
  }
});

test('nothing is emitted while the gateway is unlinked, for a zone without a UUID, or for a deleted zone', () => {
  for (const options of [{ linked: false }, { zoneUuid: null }, { deleted: true }]) {
    const db = database(options);
    try {
      db.exec(ROW);
      db.exec('UPDATE zone_daily_agronomy SET sync_version = 2 WHERE zone_id = 1');
      assert.deepEqual(agronomyEvents(db), [], JSON.stringify(options));
    } finally {
      db.close();
    }
  }
});
```

In `.github/workflows/verify-sync-flow.yml`, after plan E2a's step `Zone stage start date round trip` (its `run:` line ends `scripts/test-legacy-upsert-zone-config.js`), add:
```yaml
      # Daily agronomy parity: the daily record's migration-owned outbox triggers
      # (0065), the writer's versions and retraction, and the bootstrap list.
      - name: Daily agronomy record sync
        run: node --test scripts/test-zone-agronomy-sync-triggers.js
```

Append before the line `if (!ok) process.exit(1);` of `scripts/test-contract-schemas.js` (the third line from the end, before the PASS line and the export; plan E2a's `stage_started_on` checks sit just above it):
```js

// Daily agronomy parity (plan E4): a ZONE_AGRONOMY_UPSERTED event binds its
// version to the payload; the composite key zone_uuid|date is not bound.
const zoneAgronomyEvent = {
    eventUuid: 'evt-zone-agronomy', aggregateType: 'ZONE_AGRONOMY', aggregateKey: '306fa8ef-20f8-4911-b9c4-f99f60252579|2026-09-20',
    op: 'ZONE_AGRONOMY_UPSERTED', syncVersion: 2, occurredAt: '2026-09-21T00:30:02.114Z',
    payload: { contract_version: 1, zone_uuid: '306fa8ef-20f8-4911-b9c4-f99f60252579', date: '2026-09-20', et0_mm: 3.12, sync_version: 2 },
};
expectValid('a ZONE_AGRONOMY_UPSERTED event with a composite key', eventsSchema, zoneAgronomyEvent, eventsSchema);
expectInvalid('a ZONE_AGRONOMY_UPSERTED event whose version differs from its payload', eventsSchema,
    { ...zoneAgronomyEvent, syncVersion: 3 }, /syncVersion: must equal payload\.sync_version/, eventsSchema);
```

Run:
```bash
node --test scripts/test-zone-agronomy-sync-triggers.js
node scripts/test-contract-schemas.js
```
Expected: the trigger test fails at load with `ENOENT … 0065__zone_daily_agronomy_sync.sql`; the contract script fails `a ZONE_AGRONOMY_UPSERTED event with a composite key` (`op` not in the enum) and the binding check.

- [ ] **Step 2: Write 0065**

`database/migrations/ordered/0065__zone_daily_agronomy_sync.sql`, exactly (the `au` body is written out in full, identical to the `ai` body after its `WHEN`):
```sql
-- risk: additive
-- 0065: the daily agronomy record replicates to the cloud (spec
-- docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B3). A row is
-- inserted at sync_version 1 and every real change adds 1; a row is never deleted,
-- only retracted by an update (null values, null_reason 'retracted'), so its
-- version never goes back. Both triggers are migration-owned: sync-init-fn does
-- not create them. A zone without a UUID emits nothing (zone guard in WHEN).
ALTER TABLE zone_daily_agronomy ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS trg_dp_zone_agronomy_outbox_ai;
CREATE TRIGGER trg_dp_zone_agronomy_outbox_ai AFTER INSERT ON zone_daily_agronomy FOR EACH ROW WHEN EXISTS ( SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1 ) AND EXISTS ( SELECT 1 FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL AND zone_uuid IS NOT NULL ) BEGIN INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui) VALUES (lower(hex(randomblob(16))), 'ZONE_AGRONOMY', (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id) || '|' || NEW.date, 'ZONE_AGRONOMY_UPSERTED', json_object('contract_version', 1, 'zone_id', NEW.zone_id, 'zone_uuid', (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id), 'date', NEW.date, 'et0_mm', NEW.et0_mm, 'et0_tier', NEW.et0_tier, 'et0_source', NEW.et0_source, 'et0_station_id', NEW.et0_station_id, 'location_key', NEW.location_key, 'kc', NEW.kc, 'kc_source', NEW.kc_source, 'kc_stage_day', NEW.kc_stage_day, 'stage_overrun', NEW.stage_overrun, 'crop_type', NEW.crop_type, 'phenological_stage', NEW.phenological_stage, 'stage_started_on', NEW.stage_started_on, 'etc_mm', NEW.etc_mm, 'hours_present', NEW.hours_present, 'expected_hours', NEW.expected_hours, 'null_reason', NEW.null_reason, 'computed_at', NEW.computed_at, 'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id), NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')), 'sync_version', NEW.sync_version ), NEW.sync_version, strftime('%Y-%m-%dT%H:%M:%fZ','now'), COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id), NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))); END;

DROP TRIGGER IF EXISTS trg_dp_zone_agronomy_outbox_au;
CREATE TRIGGER trg_dp_zone_agronomy_outbox_au AFTER UPDATE ON zone_daily_agronomy FOR EACH ROW WHEN EXISTS ( SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1 ) AND EXISTS ( SELECT 1 FROM irrigation_zones WHERE id = NEW.zone_id AND deleted_at IS NULL AND zone_uuid IS NOT NULL ) AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0) BEGIN INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui) VALUES (lower(hex(randomblob(16))), 'ZONE_AGRONOMY', (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id) || '|' || NEW.date, 'ZONE_AGRONOMY_UPSERTED', json_object('contract_version', 1, 'zone_id', NEW.zone_id, 'zone_uuid', (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id), 'date', NEW.date, 'et0_mm', NEW.et0_mm, 'et0_tier', NEW.et0_tier, 'et0_source', NEW.et0_source, 'et0_station_id', NEW.et0_station_id, 'location_key', NEW.location_key, 'kc', NEW.kc, 'kc_source', NEW.kc_source, 'kc_stage_day', NEW.kc_stage_day, 'stage_overrun', NEW.stage_overrun, 'crop_type', NEW.crop_type, 'phenological_stage', NEW.phenological_stage, 'stage_started_on', NEW.stage_started_on, 'etc_mm', NEW.etc_mm, 'hours_present', NEW.hours_present, 'expected_hours', NEW.expected_hours, 'null_reason', NEW.null_reason, 'computed_at', NEW.computed_at, 'gateway_device_eui', COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id), NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')), 'sync_version', NEW.sync_version ), NEW.sync_version, strftime('%Y-%m-%dT%H:%M:%fZ','now'), COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id), NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))); END;
```

- [ ] **Step 3: Seed parity, checksums, the seven databases**

`$SCRATCH/seed-0065.js` (the column in the table definition and the two triggers in the seed's pretty style, placed before the zone recommendations triggers):
```js
// One-shot (plan E4, Task 1): seed-blank.sql gains zone_daily_agronomy.sync_version
// and the two migration-owned triggers of 0065, in the file's pretty style.
'use strict';
const fs = require('fs');
const FILE = 'database/seed-blank.sql';
let text = fs.readFileSync(FILE, 'utf8');
function swapOnce(from, to) {
  if (text.split(from).length !== 2) throw new Error(`expected exactly one match for: ${from.slice(0, 80)}`);
  text = text.replace(from, to);
}
swapOnce("  stage_overrun        INTEGER,\n  PRIMARY KEY (zone_id, date)\n",
  "  stage_overrun        INTEGER,\n  sync_version         INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (zone_id, date)\n");
const EUI = "COALESCE((SELECT gateway_device_eui FROM irrigation_zones WHERE id = NEW.zone_id),NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),''))";
function trigger(name, event, extraWhen) {
  return [
    `-- zone_daily_agronomy → sync_outbox (${event === 'INSERT' ? 'insert' : 'update'}; migration 0065, not created by sync-init-fn)`,
    `CREATE TRIGGER ${name}`,
    `AFTER ${event} ON zone_daily_agronomy`,
    'FOR EACH ROW',
    'WHEN EXISTS (',
    '  SELECT 1 FROM sync_link_state',
    "   WHERE peer_node = 'cloud' AND linked = 1",
    ')',
    ' AND EXISTS (',
    '  SELECT 1 FROM irrigation_zones',
    '   WHERE id = NEW.zone_id AND deleted_at IS NULL AND zone_uuid IS NOT NULL',
    ')',
    ...(extraWhen ? [extraWhen] : []),
    'BEGIN',
    '  INSERT INTO sync_outbox(',
    '    event_uuid, aggregate_type, aggregate_key, op, payload_json,',
    '    sync_version, occurred_at, gateway_device_eui',
    '  ) VALUES (',
    '    lower(hex(randomblob(16))),',
    "    'ZONE_AGRONOMY',",
    "    (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id) || '|' || NEW.date,",
    "    'ZONE_AGRONOMY_UPSERTED',",
    '    json_object(',
    "      'contract_version', 1,",
    "      'zone_id',            NEW.zone_id,",
    "      'zone_uuid',          (SELECT zone_uuid FROM irrigation_zones WHERE id = NEW.zone_id),",
    "      'date',               NEW.date,",
    "      'et0_mm',             NEW.et0_mm,",
    "      'et0_tier',           NEW.et0_tier,",
    "      'et0_source',         NEW.et0_source,",
    "      'et0_station_id',     NEW.et0_station_id,",
    "      'location_key',       NEW.location_key,",
    "      'kc',                 NEW.kc,",
    "      'kc_source',          NEW.kc_source,",
    "      'kc_stage_day',       NEW.kc_stage_day,",
    "      'stage_overrun',      NEW.stage_overrun,",
    "      'crop_type',          NEW.crop_type,",
    "      'phenological_stage', NEW.phenological_stage,",
    "      'stage_started_on',   NEW.stage_started_on,",
    "      'etc_mm',             NEW.etc_mm,",
    "      'hours_present',      NEW.hours_present,",
    "      'expected_hours',     NEW.expected_hours,",
    "      'null_reason',        NEW.null_reason,",
    "      'computed_at',        NEW.computed_at,",
    `      'gateway_device_eui', ${EUI},`,
    "      'sync_version',       NEW.sync_version",
    '    ),',
    '    NEW.sync_version,',
    "    strftime('%Y-%m-%dT%H:%M:%fZ','now'),",
    `    ${EUI}`,
    '  );',
    'END;',
    '',
  ].join('\n');
}
const anchor = '-- zone_daily_recommendations → sync_outbox (insert)\n';
swapOnce(anchor, trigger('trg_dp_zone_agronomy_outbox_ai', 'INSERT', null) + '\n'
  + trigger('trg_dp_zone_agronomy_outbox_au', 'UPDATE', ' AND COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)') + '\n' + anchor);
fs.writeFileSync(FILE, text);
console.log('seed-blank.sql: sync_version and the two 0065 triggers');
```
```bash
node "$SCRATCH/seed-0065.js"
node -e "
const fs=require('fs'),crypto=require('crypto'),p='database/migrations/ordered/';
const m={};for(const f of fs.readdirSync(p).filter(f=>f.endsWith('.sql')).sort()){m[f]=crypto.createHash('sha256').update(fs.readFileSync(p+f)).digest('hex');}
fs.writeFileSync(p+'CHECKSUMS.json',JSON.stringify(m,null,2)+'\n');console.log(Object.keys(m).length,'entries');"
node scripts/build-seed-db.js
```
Expected: `seed-blank.sql: sync_version and the two 0065 triggers`; `65 entries`; `build-seed-db: OK (7 image(s), …)` (about 3 minutes; 10-minute timeout).

- [ ] **Step 4: The two triggers are migration-owned**

`$SCRATCH/verifier-lists.py`:
```python
# One-shot (plan E4, Task 1): the two 0065 triggers are migration-owned; the
# schema contract lists zone_daily_agronomy.sync_version.
import pathlib
def patch(path, swaps):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    for old, new in swaps:
        if s.count(old) != 1:
            raise SystemExit(f"{path}: expected one match for: {old[:80]}")
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")
patch("scripts/verify-runtime-schema-parity.js", [(
"""  ['trg_sync_valve_actuation_dirty_au', '0051__durable_history_batch.sql'],
]);""",
"""  ['trg_sync_valve_actuation_dirty_au', '0051__durable_history_batch.sql'],
  // 0065__zone_daily_agronomy_sync.sql (daily agronomy parity, plan E4) emits
  // ZONE_AGRONOMY_UPSERTED for the daily agronomy record. Seed DB + deploy-time
  // migration runner delivery, not the frozen sync-init-fn boot DDL.
  ['trg_dp_zone_agronomy_outbox_ai', '0065__zone_daily_agronomy_sync.sql'],
  ['trg_dp_zone_agronomy_outbox_au', '0065__zone_daily_agronomy_sync.sql'],
]);""")])
patch("scripts/verify-trigger-body-parity.js", [(
"""  'trg_sync_weather_station_zones_outbox_au',
]);""",
"""  'trg_sync_weather_station_zones_outbox_au',
  'trg_dp_zone_agronomy_outbox_ai',
  'trg_dp_zone_agronomy_outbox_au',
]);""")])
patch("scripts/verify-db-schema-consistency.js", [(
"""    'stage_started_on',
    'kc_stage_day',
    'stage_overrun',
  ],
  weather_station_hours: [""",
"""    'stage_started_on',
    'kc_stage_day',
    'stage_overrun',
    'sync_version',
  ],
  weather_station_hours: [""")])
print("verifier lists: 0065 triggers migration-owned, sync_version in the schema contract")
```
Run: `python3 "$SCRATCH/verifier-lists.py"`. Expected: `verifier lists: 0065 triggers migration-owned, sync_version in the schema contract`. The third patch is this diff to the `schemaContract` entry plan E2a Task 1 wrote:
```diff
   zone_daily_agronomy: [
     …
     'stage_started_on',
     'kc_stage_day',
     'stage_overrun',
+    'sync_version',
   ],
   weather_station_hours: [
```

- [ ] **Step 5: Migration corpus pins**

`lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`: the title becomes `'affected gateway ledger applies original pending migrations through 0065'` and the assertion ends `…, 62, 63, 64, 65]);`. `scripts/reconcile-ledger-numbering.test.js`: in both lineages the comment's list gains `, daily agronomy record sync` and reads `0054-0065`, the first lineage fixture's `pending is {22,23,24,25,54,...,65}`, and every `assert.deepEqual` that plan E2a ended `…, 63, 64]` now ends `…, 63, 64, 65]`.

- [ ] **Step 6: The contract and the op parity**

`$SCRATCH/contract-e4.py` (the op enum and binding in `events.schema.json`, the expected binding in `test-contract-schemas.js` and in `verify-sync-contract.js`, the SQL-owned op in `verify-sync-op-parity.js`). `verify-sync-contract.js` pins its own `EXACT_EVENT_SEMANTIC_BINDINGS` and `assertExactMetadata` compares it with the schema's `x-semantic-bindings`, so without the fourth patch `verify-sync-contract.js` fails with `events.schema.json x-semantic-bindings must match the reviewed executable semantic bindings` (plan review chair B1):
```python
# One-shot (plan E4, Task 1): ZONE_AGRONOMY_UPSERTED in the event contract, its
# binding pinned by test-contract-schemas.js and verify-sync-contract.js, SQL-owned in
# verify-sync-op-parity.js.
import pathlib
def patch(path, swaps):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    for old, new in swaps:
        if s.count(old) != 1:
            raise SystemExit(f"{path}: expected one match for: {old[:80]}")
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")
patch("docs/contracts/sync-schema/events.schema.json", [
    ('''        "WEATHER_STATION_ZONES_REPLACED": {"aggregate_key_path": "payload.device_eui", "sync_version_path": "payload.sync_version"}
    },''', '''        "WEATHER_STATION_ZONES_REPLACED": {"aggregate_key_path": "payload.device_eui", "sync_version_path": "payload.sync_version"},
        "ZONE_AGRONOMY_UPSERTED": {"sync_version_path": "payload.sync_version"}
    },'''),
    ('''                "WORK_REQUEST_SUBMITTED",
                "ZONE_CONFIG_UPSERTED",''', '''                "WORK_REQUEST_SUBMITTED",
                "ZONE_AGRONOMY_UPSERTED",
                "ZONE_CONFIG_UPSERTED",'''),
])
patch("scripts/test-contract-schemas.js", [
    ('''    ...Object.fromEntries(
        Object.entries(ZONE_CALIBRATION_WEATHER_EVENT_KEY_FIELDS).map(([op, keyField]) => [op, {
            aggregate_key_path: `payload.${keyField}`,
            sync_version_path: 'payload.sync_version',
        }])
    ),
};''', '''    ...Object.fromEntries(
        Object.entries(ZONE_CALIBRATION_WEATHER_EVENT_KEY_FIELDS).map(([op, keyField]) => [op, {
            aggregate_key_path: `payload.${keyField}`,
            sync_version_path: 'payload.sync_version',
        }])
    ),
    // The key is the composite zone_uuid|date, which no single payload path
    // holds, so only the version is bound (spec 2026-09-27-daily-agronomy-parity B6).
    ZONE_AGRONOMY_UPSERTED: {sync_version_path: 'payload.sync_version'},
};'''),
])
patch("scripts/verify-sync-op-parity.js", [
    ('''  'DEVICE_INSTALLATION_LOCATION_REVISED',
  'DEVICE_RADIO_CONFIGURATION_REVISED',
]);''', '''  'DEVICE_INSTALLATION_LOCATION_REVISED',
  'DEVICE_RADIO_CONFIGURATION_REVISED',
  // Emitted by 0065__zone_daily_agronomy_sync.sql's trg_dp_zone_agronomy_outbox_* triggers, not by flows.json.
  'ZONE_AGRONOMY_UPSERTED',
]);'''),
])
patch("scripts/verify-sync-contract.js", [
    ('''    WEATHER_STATION_ZONES_REPLACED: { aggregate_key_path: 'payload.device_eui', sync_version_path: 'payload.sync_version' },
};''', '''    WEATHER_STATION_ZONES_REPLACED: { aggregate_key_path: 'payload.device_eui', sync_version_path: 'payload.sync_version' },
    // The key is the composite zone_uuid|date: only the version is bound (spec B6).
    ZONE_AGRONOMY_UPSERTED: { sync_version_path: 'payload.sync_version' },
};'''),
])
print("contract: ZONE_AGRONOMY_UPSERTED")
```
Run: `python3 "$SCRATCH/contract-e4.py"`. Expected: `contract: ZONE_AGRONOMY_UPSERTED`. No entry goes into `scripts/fixtures/sync-contract-staging.json` (spec D: its arrays are pinned to exact constants and cannot stage a non-journal op).

- [ ] **Step 7: Seed-only pins in `verify-sync-flow.js`**

`$SCRATCH/vsf-e4-task1.py`:
```python
# One-shot (plan E4, Task 1): verify-sync-flow.js seed-only pins for the two 0065 triggers.
import pathlib
p = pathlib.Path("scripts/verify-sync-flow.js"); s = p.read_text(encoding="utf-8")
anchor = "expectFileIncludes('seed-blank.sql', seedSqlSource, 'sync_link_state', 'link-gates sync triggers');\n"
if s.count(anchor) != 1:
    raise SystemExit("expected one match for the link-gate pin")
s = s.replace(anchor, anchor +
    "// 0065 (daily agronomy parity, plan E4): migration-owned, so the seed carries them and\n"
    "// the boot node does not; they stay out of the runtime-trigger loop below.\n"
    "for (const triggerName of ['trg_dp_zone_agronomy_outbox_ai', 'trg_dp_zone_agronomy_outbox_au']) {\n"
    "  expectFileIncludes('seed-blank.sql', seedSqlSource, triggerName, `defines ${triggerName}`);\n"
    "  expectTriggerIncludes('seed-blank.sql', seedSqlSource, triggerName, \"WHERE peer_node = 'cloud' AND linked = 1\", 'cloud link gate');\n"
    "  expectTriggerIncludes('seed-blank.sql', seedSqlSource, triggerName, 'WHERE id = NEW.zone_id AND deleted_at IS NULL AND zone_uuid IS NOT NULL', 'zone UUID guard');\n"
    "  expectTriggerIncludes('seed-blank.sql', seedSqlSource, triggerName, \"'ZONE_AGRONOMY_UPSERTED'\", 'emits ZONE_AGRONOMY_UPSERTED');\n"
    "  expectExcludes('Sync Init Schema + Triggers', triggerName, `leaves the migration-owned ${triggerName} to 0065`);\n"
    "}\n")
p.write_text(s, encoding="utf-8"); print("verify-sync-flow: 0065 seed-only pins")
```
Run: `python3 "$SCRATCH/vsf-e4-task1.py"`. Expected: `verify-sync-flow: 0065 seed-only pins`.

- [ ] **Step 8: Run the gates**

```bash
node --test scripts/test-zone-agronomy-sync-triggers.js
node scripts/test-contract-schemas.js && node scripts/verify-sync-contract.js
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server>/.worktrees/daily-agronomy-cloud/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server>/.worktrees/daily-agronomy-cloud/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node --test scripts/verify-sync-op-parity.test.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-trigger-body-parity.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-seed-db-ledger.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-profile-parity.js && node scripts/test-journal-schema.js
node scripts/generate-sync-trigger-source.js --check && node --test scripts/test-sync-trigger-source.js scripts/verify-trigger-body-parity.test.js
node scripts/verify-sync-flow.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js
node --test lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js
node --test scripts/reconcile-ledger-numbering.test.js
```
Expected: the trigger test `# pass 4`; `PASS: contract schema checks pass`, `verify-sync-contract: OK` (it compares the new binding in both places); `verify-sync-op-parity: OK` when the paired branch carries plan CC1 (without it: `server missing from union: ZONE_AGRONOMY_UPSERTED` and FAIL, prerequisite 2; plan E2a Task 1 Step 2 taught the verifier 0063's `CASE` payload, without which every source reports `payload_json missing contract_version`); its unit tests `# pass 46`, `# fail 0` under the same pairing (without CC1, `parity check accepts seed SQL trigger ops as a canonical subset` fails with that line); `verify-migrations: OK (65 migrations, …)`, `verify-seed-replay: OK`, `verify-runtime-schema-parity: OK (…)`, `verify-trigger-body-parity: OK`, `DB schema consistency verification passed`, `verify-seed-db-ledger: OK (7 images stamped at migration head 65)`, the other schema gates OK; the trigger source check passes (0065 touches no boot-owned trigger); verify-sync-flow ends `All parity checks passed.`; the writer suite still passes (it inserts at the column default 0 until Task 2); the runner pin 2/2; `reconcile-ledger-numbering.test.js` all pass (about 13 minutes).

- [ ] **Step 9: Commit**

```bash
git add database lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js scripts/reconcile-ledger-numbering.test.js scripts/test-zone-agronomy-sync-triggers.js scripts/verify-runtime-schema-parity.js scripts/verify-trigger-body-parity.js scripts/verify-db-schema-consistency.js scripts/test-contract-schemas.js scripts/verify-sync-contract.js scripts/verify-sync-op-parity.js scripts/verify-sync-flow.js docs/contracts/sync-schema/events.schema.json .github/workflows/verify-sync-flow.yml $(node -e "console.log(require('./scripts/seed-db-paths.js').SEED_DB_RELATIVE_PATHS.join(' '))")
git -c user.name=Project-OSI commit -m "feat(sync): daily agronomy rows emit ZONE_AGRONOMY_UPSERTED (migration 0065, migration-owned triggers, contract)"
git status --short
```
`git status --short` lists none of the seven bundled databases.

---

### Task 2: The writer versions its rows and retracts instead of deleting

**Files:**
- Modify: `.../osi-agronomy-daily/index.js`, `.../osi-agronomy-daily/index.test.js` (both profiles), `scripts/test-zone-agronomy-sync-triggers.js` (append)
- Scratch: `$SCRATCH/writer-tests.py`, `$SCRATCH/writer-versions.py`

**Interfaces:**
- Consumes: `zone_daily_agronomy.sync_version` and the two triggers (Task 1).
- Produces: `UPSERT_SQL` inserts at `sync_version` 1 and its `DO UPDATE` sets `sync_version = zone_daily_agronomy.sync_version + 1`, both only when the `WHERE` finds a changed column; `RETRACT_SQL` (`UPDATE … SET <every value> = NULL, null_reason = 'retracted', computed_at = ?, sync_version = sync_version + 1 WHERE zone_id = ? AND date >= ? AND null_reason IS NOT 'retracted' RETURNING date`) replaces the `DELETE`; the run summary's `deleted` becomes `retracted` (the in-flight summary too). `agronomy-daily-fn` reads only `latestNull`, `zones`, `skipped` and `error`, so no flow node changes.

- [ ] **Step 1: Write the failing tests**

`$SCRATCH/writer-tests.py` (the two clock tests follow the retraction, and two version tests are appended):
```python
# One-shot (plan E4, Task 2): the clock tests follow the retraction.
import pathlib
p = pathlib.Path("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)
swap("""test('clock: a run 25 h behind the newest stored hour is skipped; rows dated today or later are deleted', async () => {""",
     """test('clock: a run 25 h behind the newest stored hour is skipped; rows dated today or later are retracted', async () => {""")
swap("""  const summary = await run(db);
  assert.equal(summary.deleted, 2);
  assert.equal(rows(db).filter((r) => r.date >= '2026-09-26').length, 0);
});""", """  const summary = await run(db);
  assert.equal(summary.retracted, 2);
  assert.deepEqual(rows(db).filter((r) => r.date >= '2026-09-26').map((r) => [r.date, r.et0_mm, r.null_reason]), [['2026-09-26', null, 'retracted'], ['2026-09-30', null, 'retracted']]);
});""")
swap("""test('a transaction that fails after its delete rolls back and the summary counts nothing for that zone', async () => {""",
     """test('a transaction that fails after its retraction rolls back and the summary counts nothing for that zone', async () => {""")
swap("""  assert.deepEqual([summary.zones, summary.deleted, summary.written, summary.unchanged], [0, 0, 0, 0]);
  assert.equal(rows(db).length, 1, 'the rollback kept the row the delete had removed');""",
     """  assert.deepEqual([summary.zones, summary.retracted, summary.written, summary.unchanged], [0, 0, 0, 0]);
  assert.deepEqual(rows(db).map((r) => [r.date, r.et0_mm, r.null_reason]), [['2026-09-27', 3, null]], 'the rollback kept the row the retraction had nulled');""")
s += """
// Contract v2 record sync (spec 2026-09-27-daily-agronomy-parity B3, B4): rows
// carry a version that starts at 1 and grows by 1 per real change.
test('versions: an insert is version 1, a changed day adds 1, an unchanged run adds nothing', async () => {
  const db = scratchDb();
  seedZone(db);
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  assert.equal(row(db, '2026-09-25').sync_version, 1);
  assert.equal(row(db, '2026-09-24').sync_version, 1, 'a no_source row is a row too');
  await run(db, '2026-09-26T06:30:00Z');
  assert.equal(row(db, '2026-09-25').sync_version, 1);
  db.raw.prepare("UPDATE weather_provider_hours SET et0_mm = 0.25 WHERE hour_start = ?").run(ad.localDayWindow('2026-09-25', TZ).hourStarts[12]);
  await run(db, '2026-09-26T07:00:00Z');
  assert.deepEqual([row(db, '2026-09-25').et0_mm, row(db, '2026-09-25').sync_version], [4.85, 2]);
});

test('retraction: a clock-ahead row is retracted once, keeps growing its version, and is overwritten with the next version', async () => {
  const db = scratchDb();
  seedZone(db);
  db.raw.prepare("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, kc, kc_source, crop_type, phenological_stage, etc_mm, computed_at, sync_version) VALUES (1, '2026-09-27', 3, 1.2, 'fao56_crop', 'maize', 'mid_season', 3.6, '2026-09-28T00:00:00Z', 4)").run();
  const first = await run(db);
  assert.equal(first.retracted, 1);
  const retracted = row(db, '2026-09-27');
  assert.deepEqual([retracted.et0_mm, retracted.kc, retracted.etc_mm, retracted.crop_type, retracted.null_reason, retracted.sync_version, retracted.computed_at], [null, null, null, null, 'retracted', 5, NOW]);
  const second = await run(db, '2026-09-26T06:30:00Z');
  assert.equal(second.retracted, 0);
  assert.equal(row(db, '2026-09-27').sync_version, 5, 'a second run does not bump a retracted row');
  seedProviderDay(db, OM, '2026-09-27');
  await run(db, '2026-09-28T06:00:00Z');
  const recomputed = row(db, '2026-09-27');
  assert.deepEqual([recomputed.et0_mm, recomputed.kc, recomputed.null_reason, recomputed.sync_version], [4.8, 1.2, null, 6]);
});
"""
p.write_text(s, encoding="utf-8")
print("index.test.js: retraction and versions")
```
Run: `python3 "$SCRATCH/writer-tests.py"`. Expected: `index.test.js: retraction and versions`.

Append to `scripts/test-zone-agronomy-sync-triggers.js`:
```js

const daily = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily');

function facade(db) {
  const scope = { all: async (sql, params) => db.prepare(sql).all(...(params || [])), run: async (sql, params) => { db.prepare(sql).run(...(params || [])); } };
  return {
    ...scope,
    transaction: async (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await fn(scope); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

test('the writer: each new day emits version 1; a retraction emits one event with null values and the next version', async () => {
  daily.resetState();
  const db = database();
  try {
    db.exec("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, kc, kc_source, crop_type, phenological_stage, etc_mm, computed_at, sync_version) VALUES (1, '2026-09-27', 3, 1.2, 'fao56_crop', 'maize', 'mid_season', 3.6, '2026-09-28T00:00:00Z', 3)");
    db.exec('DELETE FROM sync_outbox');
    const summary = await daily.runDaily({ db: facade(db), nowIso: '2026-09-26T06:00:00Z', deploymentDefault: 'open_meteo', warn: () => {} });
    assert.equal(summary.retracted, 1);
    const events = agronomyEvents(db);
    const retraction = events.filter((e) => e.payload.date === '2026-09-27');
    assert.equal(retraction.length, 1);
    assert.deepEqual([retraction[0].syncVersion, retraction[0].payload.null_reason, retraction[0].payload.et0_mm, retraction[0].payload.kc, retraction[0].payload.etc_mm], [4, 'retracted', null, null, null]);
    const newDays = events.filter((e) => e.payload.date < '2026-09-26');
    assert.equal(newDays.length, 7, 'the seven latest completed days, each a new row');
    assert.ok(newDays.every((e) => e.syncVersion === 1 && e.payload.null_reason === 'no_source'));
    db.exec('DELETE FROM sync_outbox');
    await daily.runDaily({ db: facade(db), nowIso: '2026-09-26T06:30:00Z', deploymentDefault: 'open_meteo', warn: () => {} });
    assert.deepEqual(agronomyEvents(db), [], 'an unchanged run emits nothing, and the retracted row is not retracted again');
  } finally {
    db.close();
  }
});
```

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js
node --test scripts/test-zone-agronomy-sync-triggers.js
```
Expected: four failures in the writer suite (the clock test and the rollback test read `summary.retracted`, undefined; the version test finds `sync_version` 0; the retraction test finds the row deleted) and one in the trigger file (the writer test).

- [ ] **Step 2: Versions and the retraction**

`$SCRATCH/writer-versions.py`:
```python
# One-shot (plan E4, Task 2): the daily writer versions its rows and retracts
# instead of deleting (spec 2026-09-27-daily-agronomy-parity B3, B4).
import pathlib
p = pathlib.Path("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)
swap("""const UPSERT_SQL =
  'INSERT INTO zone_daily_agronomy (zone_id, date, ' + ROW_COLUMNS.join(', ') + ', computed_at) VALUES (?, ?, ' + ROW_COLUMNS.map(() => '?').join(', ') + ', ?) ' +
  'ON CONFLICT(zone_id, date) DO UPDATE SET ' + ROW_COLUMNS.map((c) => c + ' = excluded.' + c).join(', ') + ', computed_at = excluded.computed_at ' +
  'WHERE ' + ROW_COLUMNS.map((c) => 'zone_daily_agronomy.' + c + ' IS NOT excluded.' + c).join(' OR ') + ' ' +
  'RETURNING zone_id';""", """// A row is inserted at sync_version 1 and every real change adds 1 (the 0015
// rule); the WHERE keeps an unchanged day from bumping or emitting. A row is
// never deleted, so its version only grows (migration 0065's triggers emit
// ZONE_AGRONOMY_UPSERTED on each insert and version change).
const UPSERT_SQL =
  'INSERT INTO zone_daily_agronomy (zone_id, date, ' + ROW_COLUMNS.join(', ') + ', computed_at, sync_version) VALUES (?, ?, ' + ROW_COLUMNS.map(() => '?').join(', ') + ', ?, 1) ' +
  'ON CONFLICT(zone_id, date) DO UPDATE SET ' + ROW_COLUMNS.map((c) => c + ' = excluded.' + c).join(', ') + ', computed_at = excluded.computed_at, sync_version = zone_daily_agronomy.sync_version + 1 ' +
  'WHERE ' + ROW_COLUMNS.map((c) => 'zone_daily_agronomy.' + c + ' IS NOT excluded.' + c).join(' OR ') + ' ' +
  'RETURNING zone_id';
// Rows a clock that ran ahead wrote for today or later: values nulled once,
// next version, never deleted. A later computation of the date overwrites the
// row with a fresh snapshot (its kc is null) and the next version.
const RETRACT_SQL =
  'UPDATE zone_daily_agronomy SET et0_mm = NULL, et0_source = NULL, et0_tier = NULL, et0_station_id = NULL, location_key = NULL, ' +
  'hours_present = NULL, expected_hours = NULL, kc = NULL, kc_source = NULL, kc_stage_day = NULL, stage_overrun = NULL, ' +
  "crop_type = NULL, phenological_stage = NULL, stage_started_on = NULL, etc_mm = NULL, null_reason = 'retracted', " +
  'computed_at = ?, sync_version = sync_version + 1 ' +
  "WHERE zone_id = ? AND date >= ? AND null_reason IS NOT 'retracted' RETURNING date";""")
swap("""  const summary = { zones: 0, days: 0, written: 0, unchanged: 0, deleted: 0, nulls: [], latestNull: 0, tzFallback: [] };""",
     """  const summary = { zones: 0, days: 0, written: 0, unchanged: 0, retracted: 0, nulls: [], latestNull: 0, tzFallback: [] };""")
swap("""        const c = { deleted: 0, written: 0, unchanged: 0 };
        c.deleted = (await tx.all('DELETE FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? RETURNING date', [zone.id, today])).length;""",
     """        const c = { retracted: 0, written: 0, unchanged: 0 };
        c.retracted = (await tx.all(RETRACT_SQL, [nowIso, zone.id, today])).length;""")
swap("""      summary.deleted += counts.deleted;""", """      summary.retracted += counts.retracted;""")
swap("""  if (inFlight) return { zones: 0, days: 0, written: 0, unchanged: 0, deleted: 0, nulls: [], latestNull: 0, tzFallback: [], skipped: 'in_flight' };""",
     """  if (inFlight) return { zones: 0, days: 0, written: 0, unchanged: 0, retracted: 0, nulls: [], latestNull: 0, tzFallback: [], skipped: 'in_flight' };""")
p.write_text(s, encoding="utf-8")
print("osi-agronomy-daily: versions and retraction")
```
```bash
python3 "$SCRATCH/writer-versions.py"
for f in index.js index.test.js; do cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/$f conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily/$f; done
```
Expected: `osi-agronomy-daily: versions and retraction`.

- [ ] **Step 3: Run the gates**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/facade-contract.test.js
node --test scripts/test-zone-agronomy-sync-triggers.js
node scripts/verify-profile-parity.js
```
Expected: the writer suite `# pass 36` (sub-project 2's 27, E2a's 3, E3's 4, these 2; pin what the runner prints) and the facade test pass; the trigger file `# pass 5`; `All parity checks passed.`

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily scripts/test-zone-agronomy-sync-triggers.js
git -c user.name=Project-OSI commit -m "feat(agronomy-daily): rows start at version 1 and grow by 1 per change; a clock-ahead row is retracted, never deleted"
```

---

### Task 3: The bootstrap carries `zoneAgronomy`

**Files:**
- Modify (by one-shot script): both `flows.json`, node `sync-bootstrap-build`
- Modify: `scripts/test-zone-agronomy-sync-triggers.js` (append), `scripts/verify-sync-flow.js`, `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`
- Unchanged by design: `sync-force-build`, `osi-history-sync-helper`
- Scratch: `$SCRATCH/flows-bootstrap-agronomy.js`, `$SCRATCH/vsf-e4-task3.py`, `$SCRATCH/ratchet-e4-task3.js`

**Interfaces:**
- Produces: the bootstrap payload gains `zoneAgronomy`, placed after `zoneEnvironments`: an array of `{ zone_id, zone_uuid, date, et0_mm, et0_tier, et0_source, et0_station_id, location_key, kc, kc_source, kc_stage_day, stage_overrun, crop_type, phenological_stage, stage_started_on, etc_mm, hours_present, expected_hours, null_reason, computed_at, sync_version }` for rows of the last 30 days (`date >= date('now', '-30 day')`) of live zones with a UUID, ordered `date DESC, zone_id ASC`, at most 1,000. The cloud's `EdgeBootstrapRequest.zoneAgronomy` (plan CC1) reads it; a missing list (an older edge, a force sync) counts as empty.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-zone-agronomy-sync-triggers.js`:
```js

const { executeFunction, loadNode } = require('./lib/scoped-access-harness');
async function bootstrapPayload(db) {
  // The bootstrap is built only for a cloud-linked account.
  db.exec("UPDATE users SET auth_mode = 'server', server_url = 'https://cloud.example.test', server_sync_token = 'fixture-token', user_uuid = COALESCE(user_uuid, '55555555-5555-4555-8555-555555555555') WHERE id = 7");
  const run = await executeFunction(loadNode('sync-bootstrap-build'), {
    msg: {},
    env: { DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'fixture', DEVICE_EUI_CONFIDENCE: 'authoritative' },
    db,
    osiLibModules: { installation: require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper') },
    globals: { fs: { existsSync: () => false, readFileSync: () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } } },
  });
  assert.ok(run.result && run.result.payload, 'the bootstrap node must build a payload: ' + run.warnings.join('; '));
  return run.result.payload;
}

test('the bootstrap snapshot carries zoneAgronomy: 30 days per live zone with a UUID, newest days of every zone first, at most 1,000 rows', async () => {
  const db = database();
  try {
    db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid) VALUES (8, 'second', 'x', '2026-01-01', '66666666-6666-4666-8666-666666666666')");
    const insertZone = db.prepare("INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, created_at, updated_at) VALUES (?, ?, 7, ?, ?, 1, 'UTC', '2026-01-01', '2026-01-01')");
    for (let id = 2; id <= 40; id += 1) insertZone.run(id, 'Z' + id, `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, GATEWAY);
    db.exec("UPDATE irrigation_zones SET deleted_at = '2026-09-01T00:00:00Z' WHERE id = 40");
    const insertRow = db.prepare("INSERT INTO zone_daily_agronomy (zone_id, date, et0_mm, computed_at, sync_version) VALUES (?, date('now', ?), 3, '2026-09-01T00:00:00Z', 1)");
    for (let id = 1; id <= 40; id += 1) for (let back = 1; back <= 31; back += 1) insertRow.run(id, `-${back} day`);
    const payload = await bootstrapPayload(db);
    const rows = payload.zoneAgronomy;
    assert.equal(rows.length, 1000, '39 live zones x 29 or 30 days exceed the cap');
    assert.ok(rows.every((r) => r.zone_id !== 40), 'a deleted zone sends nothing');
    const newest = rows[0].date;
    assert.equal(rows.filter((r) => r.date === newest).length, 39, 'the newest day of every live zone comes first');
    assert.ok(rows.every((r) => r.date >= rows[rows.length - 1].date));
    assert.deepEqual(Object.keys(rows[0]), ['zone_id', 'zone_uuid', 'date', 'et0_mm', 'et0_tier', 'et0_source', 'et0_station_id', 'location_key', 'kc', 'kc_source', 'kc_stage_day', 'stage_overrun', 'crop_type', 'phenological_stage', 'stage_started_on', 'etc_mm', 'hours_present', 'expected_hours', 'null_reason', 'computed_at', 'sync_version']);
    const oldest = db.prepare("SELECT date('now', '-30 day') AS d").get().d;
    assert.ok(rows.every((r) => r.date >= oldest), 'nothing older than 30 days');
  } finally {
    db.close();
  }
});
```

`$SCRATCH/vsf-e4-task3.py`:
```python
# One-shot (plan E4, Task 3): verify-sync-flow.js pins for the zoneAgronomy bootstrap list.
import pathlib
p = pathlib.Path("scripts/verify-sync-flow.js"); s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:90])
    s = s.replace(old, new)
swap("  for (const key of ['sensorData', 'dendroReadings', 'chameleonReadings', 'dendroDaily', 'zoneRecommendations', 'zoneEnvironments', 'gatewayLocations', 'irrigationEvents']) {",
     "  for (const key of ['sensorData', 'dendroReadings', 'chameleonReadings', 'dendroDaily', 'zoneRecommendations', 'zoneEnvironments', 'zoneAgronomy', 'gatewayLocations', 'irrigationEvents']) {")
anchor = "  expectExcludes('Sync Init Schema + Triggers', triggerName, `leaves the migration-owned ${triggerName} to 0065`);\n}\n"
swap(anchor, anchor +
     "expectIncludes('Build Cloud Bootstrap', 'FROM zone_daily_agronomy za', 'includes the daily agronomy record in bootstrap snapshots');\n"
     "expectIncludes('Build Cloud Bootstrap', \"'LIMIT 1000'\", 'bounds the daily agronomy snapshot at 1,000 rows');\n")
p.write_text(s, encoding="utf-8"); print("verify-sync-flow: zoneAgronomy bootstrap pins")
```
```bash
python3 "$SCRATCH/vsf-e4-task3.py"
node --test scripts/test-zone-agronomy-sync-triggers.js
node scripts/verify-sync-flow.js
```
Expected: `verify-sync-flow: zoneAgronomy bootstrap pins`; the bootstrap test fails (`rows` is undefined); verify-sync-flow reports `bootstrap payload missing zoneAgronomy` and the two missing pins.

- [ ] **Step 2: The one-shot flows edit**

`$SCRATCH/flows-bootstrap-agronomy.js`:
```js
#!/usr/bin/env node
// One-shot (plan E4, Task 3): the scheduled bootstrap carries zoneAgronomy, the
// last 30 days of zone_daily_agronomy per zone, at most 1,000 rows.
'use strict';
const fs = require('fs');
const path = require('path');
const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function assertRoundtrip(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) throw new Error('roundtrip guard failed for ' + filePath);
  return parsed;
}
const flows = assertRoundtrip(CANONICAL);
if (Buffer.compare(fs.readFileSync(CANONICAL), fs.readFileSync(MIRROR)) !== 0) throw new Error('profiles differ before the edit');
const node = flows.find((n) => n.id === 'sync-bootstrap-build');
if (!node) throw new Error('sync-bootstrap-build not found');
const swaps = [
  ["  const gatewayLocations = await q([\n",
    "  // Daily agronomy record (spec 2026-09-27-daily-agronomy-parity B6): 30 days per\n" +
    "  // zone, newest days of every zone first, at most 1,000 rows per gateway.\n" +
    "  const zoneAgronomy = await q([\n" +
    "    'SELECT',\n" +
    "    '  za.zone_id,',\n" +
    "    '  iz.zone_uuid,',\n" +
    "    '  za.date,',\n" +
    "    '  za.et0_mm,',\n" +
    "    '  za.et0_tier,',\n" +
    "    '  za.et0_source,',\n" +
    "    '  za.et0_station_id,',\n" +
    "    '  za.location_key,',\n" +
    "    '  za.kc,',\n" +
    "    '  za.kc_source,',\n" +
    "    '  za.kc_stage_day,',\n" +
    "    '  za.stage_overrun,',\n" +
    "    '  za.crop_type,',\n" +
    "    '  za.phenological_stage,',\n" +
    "    '  za.stage_started_on,',\n" +
    "    '  za.etc_mm,',\n" +
    "    '  za.hours_present,',\n" +
    "    '  za.expected_hours,',\n" +
    "    '  za.null_reason,',\n" +
    "    '  za.computed_at,',\n" +
    "    '  za.sync_version',\n" +
    "    'FROM zone_daily_agronomy za',\n" +
    "    'JOIN irrigation_zones iz ON iz.id = za.zone_id',\n" +
    "    \"WHERE za.date >= date('now', '-30 day') AND iz.deleted_at IS NULL AND iz.zone_uuid IS NOT NULL\",\n" +
    "    'ORDER BY za.date DESC, za.zone_id ASC',\n" +
    "    'LIMIT 1000'\n" +
    "  ].join('\\n'));\n\n" +
    "  const gatewayLocations = await q([\n"],
  ["    zoneEnvironments,\n    gatewayLocations,\n", "    zoneEnvironments,\n    zoneAgronomy,\n    gatewayLocations,\n"],
];
for (const [from, to] of swaps) {
  const count = node.func.split(from).length - 1;
  if (count !== 1) throw new Error(`expected one match, found ${count}: ${from.slice(0, 80)}`);
  node.func = node.func.replace(from, to);
}
fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
console.log('edited sync-bootstrap-build in both profiles');
```
```bash
node "$SCRATCH/flows-bootstrap-agronomy.js"
node scripts/verify-flows-fn-parse.js
```
Expected: `edited sync-bootstrap-build in both profiles`; `verify-flows-fn-parse: OK`.

- [ ] **Step 3: Size ratchet and identity pins**

`$SCRATCH/ratchet-e4-task3.js`:
```js
#!/usr/bin/env node
// Measures the named nodes and the per-profile total against origin/main and
// writes the exact allowances verify-flows-size-ratchet reads.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nodeSizes, totalChars } = require(path.join(process.cwd(), 'scripts/flows-size-scan'));
const REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const FILE = 'scripts/verify-flows-size-ratchet-allowances.json';
const head = JSON.parse(fs.readFileSync(REL, 'utf8'));
const base = JSON.parse(execFileSync('git', ['show', 'origin/main:' + REL], { maxBuffer: 64 * 1024 * 1024 }).toString());
const h = nodeSizes(head);
const b = nodeSizes(base);
const before = fs.readFileSync(FILE, 'utf8');
const allowances = JSON.parse(before);
if (JSON.stringify(allowances, null, 2) + '\n' !== before) throw new Error(FILE + ' does not round-trip');
const SENTINEL = ' The live identity restart sentinel (Option C Slice 1) provenance that verify-live-gateway-identity.js pins for this node id is carried forward.';
const WHY = 'Daily agronomy parity (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md), measured with verify-flows-size-ratchet nodeSizes over both byte-identical profiles: ';
const PRIOR = '. Supersedes the prior entry, whose growth this delta includes. ';
const NODES = {
  'sync-bootstrap-build': (m) => `${WHY}${m}${PRIOR}The bootstrap carries zoneAgronomy (plan E4): the last 30 days of zone_daily_agronomy per live zone with a UUID, newest days first, at most 1,000 rows.${SENTINEL}`,
};
for (const [id, reason] of Object.entries(NODES)) {
  const delta = h.get(id).chars - b.get(id).chars;
  const measured = `origin/main ${b.get(id).chars} -> HEAD ${h.get(id).chars} = +${delta}`;
  allowances.node_allowances[id] = { delta, reason: reason(measured) };
  console.log(id, measured);
}
const totalDelta = totalChars(head) - totalChars(base);
allowances.total_allowance = {
  delta: totalDelta,
  reason: `Branch feat/daily-agronomy-parity, stacked on feat/weather-data-view and feat/daily-agronomy (the weather provider store, the daily agronomy record, the weather data view and daily agronomy parity, all unmerged to origin/main), measured with verify-flows-size-ratchet totalChars over both byte-identical profiles: origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}. Carried from feat/daily-agronomy: +4138 (weather-provider-tick 0, weather-provider-fn 1467, station-hours-fn 1525, agronomy-daily-fn 1515, zone-env-fn -369). Carried from feat/weather-data-view: +4307 (sync-init-fn 1394, zone-config-fn 737, get-zones-query 19, get-zones-response 337, sync-bootstrap-build 150, sync-force-build 150, al-link-build-req 33, 4f4a765f36cee6f3 1487). This branch: sync-init-fn (0064), zone-config-fn, get-zones-query, get-zones-response, sync-bootstrap-build (stage_started_on and zoneAgronomy), sync-force-build, al-link-build-req, 4f4a765f36cee6f3 and zone-env-fn grew by the deltas of their node entries. When the earlier branches merge to origin/main their share moves into the base total and this entry drops by it.`,
};
console.log('total', `origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}`);
fs.writeFileSync(FILE, JSON.stringify(allowances, null, 2) + '\n');
```
```bash
node "$SCRATCH/ratchet-e4-task3.js"
node scripts/verify-flows-size-ratchet.js --write-baseline
node scripts/verify-flows-size-ratchet.js
```
Expected: `sync-bootstrap-build origin/main 44956 -> HEAD 46212 = +1256` (the weather data view's 150, E2a's 102, this task's 1004); `total origin/main 1580418 -> HEAD 1598211 = +17793`; ratchet OK. Pin what the script prints.

In `scripts/verify-live-gateway-identity.js`, `expectedGrowth` (keep every comment above the entry and add this one):
```js
    // Daily agronomy parity (plan E4 Task 3): re-pinned from 252 to +1256. The bootstrap
    // carries zoneAgronomy (the last 30 days of zone_daily_agronomy per live zone with a
    // UUID, at most 1,000 rows), +1004 on top of plan E2a's +252. Re-measured fresh:
    // origin/main 44956 -> HEAD 46212 = +1256.
    'sync-bootstrap-build': 1256,
```
and the total pin plan E2a left at 16789 becomes:
```js
  // 17793: plan E4 Task 3 adds sync-bootstrap-build +1004 (the zoneAgronomy bootstrap list)
  // to plan E2a's 16789. verify-flows-size-ratchet totalChars over both byte-identical
  // profiles: origin/main 1580418 -> HEAD 1598211 = +17793.
  expectCondition(sizeAllowances.total_allowance?.delta === 17793,
    'size total allowance: exact cumulative delta 17793',
    'size total allowance: expected exact cumulative delta 17793');
```

- [ ] **Step 4: Run the gates**

```bash
node --test scripts/test-zone-agronomy-sync-triggers.js scripts/test-zone-update-sync-version.js scripts/test-terra-selection-edge-acceptance.js
node scripts/test-journal-bootstrap.js
node scripts/verify-profile-parity.js && node scripts/verify-flows-fn-parse.js && node scripts/flows-bare-require-scan.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-osi-lib-db-caller-binding.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
```
Expected: the trigger file `# pass 6`, the other suites `# fail 0`; `test-journal-bootstrap.js` all pass (its fixture database answers a query it does not know with no rows, so `zoneAgronomy` is an empty list there); the static gates pass; ratchet OK, `Live gateway identity verification passed.`, verify-sync-flow ends `All parity checks passed.`

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-zone-agronomy-sync-triggers.js scripts/verify-sync-flow.js scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js
git -c user.name=Project-OSI commit -m "feat(sync): the bootstrap carries zoneAgronomy, 30 days per zone, at most 1,000 rows"
```

---

### Task 4: Docs, whole-branch gates, execution report

**Files:**
- Modify: `docs/operations/edge-history-retention.md`, `AGENTS.md`, `docs/contracts/sync-schema/README.md`, `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md` (plan E2a Task 6 created it; E2b appended its section)
- Scratch: `$SCRATCH/retention-doc.py`, `$SCRATCH/agents-daily-record.py`, `$SCRATCH/sync-schema-readme-e4.py`

- [ ] **Step 1: The retention document**

`$SCRATCH/retention-doc.py`:
```python
# One-shot (plan E4, Task 4): the retention document follows the daily record sync.
import pathlib
p = pathlib.Path("docs/operations/edge-history-retention.md")
s = p.read_text(encoding="utf-8")
old_start = "It is not synced\nto OSI Server:"
old_end = "`weather_station_hours` has one.\n"
i = s.index(old_start)
j = s.index(old_end, i) + len(old_end)
if s.count(old_start) != 1:
    raise SystemExit("expected one 'It is not synced' sentence")
frozen = "freezes the crop and stage current at fill time"
if s.count(frozen) != 1:
    raise SystemExit("expected one 'freezes the crop and stage' sentence")
s = s.replace(frozen, "freezes the crop, stage and stage start date current at fill time")
i = s.index(old_start)
j = s.index(old_end, i) + len(old_end)
s = s[:i] + """Since daily agronomy
parity (migration `0065__zone_daily_agronomy_sync.sql`) the table replicates to
OSI Server: the migration-owned triggers `trg_dp_zone_agronomy_outbox_ai` and
`_au` emit `ZONE_AGRONOMY_UPSERTED` for a row insert and for every change of
its `sync_version`, while the gateway is linked and the zone has a UUID, and
the scheduled bootstrap carries the last 30 days of each zone (at most 1,000
rows). The writer never deletes a row: a row its clock wrote ahead of time is
retracted in place (values null, `null_reason = 'retracted'`, next version),
so the row count still grows by one row per zone and day.
`weather_station_hours` has no outbox trigger and stays on the gateway.
""" + s[j:]
p.write_text(s, encoding="utf-8")
print("edge-history-retention.md: daily agronomy record sync")
```
```bash
python3 "$SCRATCH/retention-doc.py"
node .claude/skills/anti-slop-writing/slop-check.js docs/operations/edge-history-retention.md
```
Expected: `edge-history-retention.md: daily agronomy record sync`; `slop-check: PASS (no tier-1 findings)`.

`$SCRATCH/agents-daily-record.py` (AGENTS.md's provider weather store paragraph still calls the station tier the daily equation and says nothing of the sync; plan review E2-E4 minor 7):
```python
# One-shot (plan E4, Task 4): AGENTS.md describes the hourly station tier, the Kc curve and the daily record sync.
import pathlib
p = pathlib.Path("AGENTS.md")
s = p.read_text(encoding="utf-8")
old = ("(a local station's FAO-56 Penman-Monteith, the stored provider hours summed, or "
       "Hargreaves-Samani from the station's daily min/max) and a Kc from the FAO-56 catalogue in "
       "`docs/contracts/agronomy/`.")
if s.count(old) != 1:
    raise SystemExit("expected one tier sentence in the provider weather store paragraph")
s = s.replace(old, "(the hourly FAO-56 Penman-Monteith sum over a local station's complete hours, "
              "`et0_source = 'fao56_hourly'`; the stored provider hours summed; or Hargreaves-Samani "
              "from the station's daily min/max) and a Kc from the FAO-56 catalogue in "
              "`docs/contracts/agronomy/`, on the FAO-56 curve when the zone has a stage start date. "
              "The rows replicate to OSI Server as `ZONE_AGRONOMY_UPSERTED` (migration 0065) and in "
              "the bootstrap's `zoneAgronomy` list (the last 30 days of each zone).")
p.write_text(s, encoding="utf-8")
print("AGENTS.md: daily record")
```
`$SCRATCH/sync-schema-readme-e4.py`:
```python
# One-shot (plan E4, Task 4): docs/contracts/sync-schema/README.md explains ZONE_AGRONOMY_UPSERTED.
import pathlib
p = pathlib.Path("docs/contracts/sync-schema/README.md")
s = p.read_text(encoding="utf-8")
anchor = "## Versioning\n"
if s.count(anchor) != 1:
    raise SystemExit("expected one '## Versioning' heading")
s = s.replace(anchor, """## `ZONE_AGRONOMY_UPSERTED`

One event per insert of a `zone_daily_agronomy` row and per change of its
`sync_version`, emitted by the migration-owned triggers of
`0065__zone_daily_agronomy_sync.sql` while the gateway is linked and the zone is
live with a UUID. The aggregate key is the composite `zone_uuid|date`, which no
single payload path holds, so `x-semantic-bindings` binds only
`payload.sync_version` (`test-contract-schemas.js` and `verify-sync-contract.js`
pin the same entry). Rows are never deleted: a row written ahead of the clock is
retracted by an update with null values, `null_reason = 'retracted'` and the next
version. The scheduled bootstrap repeats the last 30 days of each zone in
`zoneAgronomy` (at most 1,000 rows); a force sync does not.

""" + anchor)
p.write_text(s, encoding="utf-8")
print("sync-schema README: ZONE_AGRONOMY_UPSERTED")
```
```bash
python3 "$SCRATCH/agents-daily-record.py"
python3 "$SCRATCH/sync-schema-readme-e4.py"
node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md docs/contracts/sync-schema/README.md
```
Expected: `AGENTS.md: daily record`; `sync-schema README: ZONE_AGRONOMY_UPSERTED`; `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 2: Every edge gate of the spec's Testing section**

```bash
node scripts/verify-agronomy-contract.js
node scripts/verify-agronomy-contract.js <osi-server>/.worktrees/daily-agronomy-cloud
node scripts/verify-sync-flow.js
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server>/.worktrees/daily-agronomy-cloud/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js
node scripts/verify-sync-contract.js && node scripts/test-contract-schemas.js
node scripts/verify-runtime-schema-parity.js && node scripts/verify-trigger-body-parity.js && node scripts/generate-sync-trigger-source.js --check && node --test scripts/test-sync-trigger-source.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-profile-parity.js
node scripts/test-flows-wiring.js && node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js
node --test lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js
node --test scripts/test-stage-started-on-migration.js scripts/test-zone-agronomy-sync-triggers.js scripts/test-zone-command-path.js scripts/test-legacy-upsert-zone-config.js scripts/test-terra-zone-config-command-flow.js scripts/test-zone-update-sync-version.js scripts/test-terra-selection-edge-acceptance.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/*.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-station-hours/*.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js
node scripts/capture-zone-env-vectors.js --verify
(cd web/react-gui && npm run typecheck && npm run test:unit)
node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/agronomy/README.md docs/operations/edge-history-retention.md docs/i18n/pending-luganda-translations.md docs/contracts/sync-schema/README.md AGENTS.md
OSI_SERVER_ROOT=<osi-server>/.worktrees/daily-agronomy-cloud node --test scripts/test-shared-agronomy-locales.js
```
Expected: every line OK, PASS or `# fail 0`. The second agronomy command prints `cloud copies byte-identical in <osi-server>/.worktrees/daily-agronomy-cloud` once plan CA has run there. The channels byte check of `migrations.yml` (the step `Cross-repo channels.json byte-identity (DD5)`) is sub-project 3's; run it by hand with `sha256sum` on `web/react-gui/src/channels/channels.json` and the two copies on osi-server `feat/weather-data-view` (spec "Cross-repo").

- [ ] **Step 3: The cross-repo checks of the spec**

```bash
EDGE_WT=<osi-os>/.worktrees/daily-agronomy-parity
CLOUD_WT=<osi-server>/.worktrees/daily-agronomy-cloud
git -C "$CLOUD_WT" show feat/daily-agronomy-parity:backend/src/test/resources/sync-contract/resources.schema.json | cmp - "$EDGE_WT/docs/contracts/sync-schema/resources.schema.json" && echo resources identical
OSI_SERVER_EDGE_SYNC_SERVICE=$CLOUD_WT/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js | tail -1
node scripts/verify-agronomy-contract.js "$CLOUD_WT" | tail -1
```
Expected: `resources identical` once the controller's re-vendor after E2 has copied this branch's file to the cloud branch (plan CC1 Task 4 copied it before plan E2a added `stage_started_on`; until the re-vendor `cmp` prints `differ: char 3717, line 80`, the `stage_started_on` line, and exits 1), the op parity OK, the agronomy OK line. The cloud-side check `EDGE_CONTRACT_ROOT=$EDGE_WT sh scripts/verify-edge-sync-contract-vendor.sh` runs in the cloud checkout as part of the cloud plans; it is read-only here and not run from this worktree.

- [ ] **Step 4: The execution report**

Append to `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md` (plan E2a Task 6 wrote the E1 and E2a sections, plan E2b its own): an **E3** section and an **E4** section (per task, what was built and the commit; E3's section carries the `sample_count` distribution E3 Task 2 Step 4 read, or says it was not read yet); the gate table with the verbatim pass lines of Step 2 and Step 3; E4 Task 3's ratchet numbers with the origin/main size they were measured against; every deviation from the plans and why; what was left out (the spec's "Not in scope" list and E1's follow-ups); and the deploy constraints the handover must carry, in general terms (osi-os is public: the report names no customer instance, customer branch or live deployment hash; the private SDD ledger lists them):

- cloud before edge: no linked gateway runs this branch before plan CC is deployed on its cloud, on main and on every customer instance; a customer cloud whose branch lacks the appliers gets them first;
- the first run after the deploy recomputes the last seven station days (`fao56_hourly`) and, with a linked cloud, emits one `ZONE_AGRONOMY_UPSERTED` per changed row; rows older than seven days keep their values and `station_fao56` source;
- rows written before 0065 carry version 0 until their first change; the next bootstrap (8 s after a Node-RED start, then every 6 hours) brings the last 30 days of each zone;
- a force sync posts no `zoneAgronomy` (spec decision); the scheduled bootstrap repairs within 6 hours.

Then:
```bash
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md
```
Expected: `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 5: Commit**

```bash
git add docs/operations/edge-history-retention.md AGENTS.md docs/contracts/sync-schema/README.md docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md
git -c user.name=Project-OSI commit -m "docs: daily agronomy record sync in the retention notes, AGENTS.md and the contract README; edge execution report, E3 and E4"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| B3 0065 (column, `ai`, `au` in full, zone guard, no delete trigger), payload shape, follow-ups (seed, seven DBs, CHECKSUMS, `schemaContract`, both migration-owned lists), seed-only pins | 1 |
| B constraints: runner pin 65 | 1 |
| B3/B4 versions (insert 1, + 1 per change, unchanged rows silent) | 2 |
| B4 retraction (`UPDATE … RETURNING date`, `summary.retracted`) | 2 |
| B6 bootstrap `zoneAgronomy` (30 days, LIMIT 1000, order), force sync not extended, no history batch | 3 |
| B6 contract (enum, binding without key path, expected bindings in `test-contract-schemas.js` and `verify-sync-contract.js`, no staging entry) | 1 |
| B6 verifiers (`SQL_OWNED_EVENT_OPS` with its comment, bootstrap key list, seed-only pins) | 1, 3 |
| Testing `scripts/test-zone-agronomy-sync-triggers.js` and the writer rows of `osi-agronomy-daily/index.test.js` | 1, 2, 3 |
| D deploy order, the `unknown_op` hazard, first runs | prerequisites, Task 4 report |
| Docs: retention notes, AGENTS.md provider weather paragraph, sync-schema README | 4 |
| Execution report (E3 and E4 sections, gate table, deploy constraints) | 4 |
