# Valve Control Phase B (edge half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `valve_schedules` changes flow to the cloud as `VALVE_SCHEDULE_UPSERTED` events, and accept cloud-authored schedule changes as commands, so `verify-sync-op-parity.js` goes green.

**Architecture:** A trigger-only SQLite migration (`0024`) puts `_ai`/`_au` triggers on `valve_schedules` that write `sync_outbox` rows, mirroring the existing `irrigation_schedules` pair. Four new cloud→edge commands route into the *existing* `osi-valve-control` REST handlers so the valve keeps exactly one writer. A backfill step enqueues existing schedules when a gateway first links.

**Tech Stack:** SQLite (triggers, ordered migrations), Node-RED `flows.json` function nodes, `osi-valve-control` CommonJS module, JSON-Schema contract files shared with osi-server.

**Spec:** [docs/superpowers/specs/2026-08-23-valve-cloud-parity-phase-b-design.md](../specs/2026-08-23-valve-cloud-parity-phase-b-design.md) — read §5 first; this plan assumes the **recommended** answers (D1=trigger, D2=edge-authoritative, D3=backfill-on-link, D4=`valve_settings` stays edge-only, D5=`deleted_at` carried in the upsert). **If review overturns any of these, stop and re-plan the affected task.**

## Global Constraints

- **This plan is HALF of a lockstep pair.** The edge migration must not reach a *cloud-linked* gateway before osi-server can accept `VALVE_SCHEDULE_UPSERTED`, or the outbox fills with terminally-rejected rows. The Bovey Pi 4 (`100.99.212.115`) is **unlinked** and is therefore the safe landing place for the edge half alone.
- **Migration number is `0024`.** `0023` is `app_settings`. Never renumber an existing ordered migration.
- **Trigger-only.** `schedule_uuid`, `sync_version`, `deleted_at` already exist on `valve_schedules` from Phase A. Adding a column makes this a different risk class — if you think you need one, stop.
- **`flows.json` is edited ONLY by a one-shot Node script** with a byte-identical roundtrip guard (`JSON.stringify(flows, null, 2) + '\n'`), never by hand or by string patching. Both hardware profiles (`bcm2712` canonical, `bcm2709` mirror) must stay byte-identical.
- **Never touch `sync-init-fn`** (the frozen boot-DDL node) for schema behaviour.
- **Weekday bit order is `bit0 = Sunday … bit6 = Saturday`.** The GUI displays Monday-first over the same 0=Sunday storage. Do not "fix" one to match the other.
- **Aggregate type `VALVE_SCHEDULE`, aggregate key `schedule_uuid`, op `VALVE_SCHEDULE_UPSERTED`** — exact strings, they are contract.
- Two repo gates already fail on this branch and on `main` — `verify-dendro-contract-mirror.js` and `verify-sync-op-parity.js`. The second is what this work fixes; the first is out of scope, do not touch it.
- **`event_uuid` must be ≤ 36 characters.** The server never records a longer
  one in `sync_inbox` (`SyncEventTxExecutor.java:25,194`), which means it can
  never be deduped and replays forever. `lower(hex(randomblob(16)))` yields 32 —
  keep it.
- **`payload_json` must carry top-level `contract_version: 1`.** The parity
  verifier enforces this on every `sync_outbox` insert
  (`verify-sync-op-parity.js:462`).
- Commit per task. Do not push without being asked.

---

### Task 1: Contract — canonicalization, resource, commands

**Files:**
- Modify: `docs/contracts/sync-schema/canonicalization.md`
- Modify: `docs/contracts/sync-schema/resources.schema.json`
- Modify: `docs/contracts/sync-schema/commands.schema.json`

**Interfaces:**
- Produces: the `ValveSchedule` resource shape and four command names that Tasks 2 and 3 must match exactly.

- [ ] **Step 1: Write the weekday-order contract**

Add to `canonicalization.md`, under the existing cross-runtime conventions:

```markdown
### Valve schedule weekday mask

`valve_schedules.weekdays_mask` is a 7-bit integer, `bit0 = Sunday` through
`bit6 = Saturday` (mask range 1..127). This is the STREGA wire order and the
storage order on both runtimes.

The edge GUI renders Monday-first (Swiss convention) purely as a display
ordering over the same 0=Sunday indices — see `WEEKDAY_DISPLAY_ORDER` in
`web/react-gui/src/components/farming/valves/valveState.ts`. Any consumer that
re-derives day names MUST use the 0=Sunday origin; treating bit0 as Monday
shifts a farmer's irrigation by one day.

`start_time` is local wall-clock `HH:MM` (24h, zero-padded) interpreted in the
schedule's own `timezone` (IANA name). It is NOT a UTC instant.
`fire_at` (ONCE schedules) IS a UTC ISO-8601 instant.
```

- [ ] **Step 2: Add the `ValveSchedule` resource**

In `resources.schema.json`, add alongside the existing resources:

```json
"ValveSchedule": {
  "type": "object",
  "required": ["schedule_uuid", "device_eui", "kind", "duration_minutes", "timezone", "enabled"],
  "properties": {
    "contract_version":  { "type": "integer", "const": 1 },
    "schedule_uuid":     { "type": "string" },
    "device_eui":        { "type": "string" },
    "kind":              { "type": "string", "enum": ["WEEKLY", "ONCE"] },
    "label":             { "type": ["string", "null"] },
    "weekdays_mask":     { "type": ["integer", "null"], "minimum": 1, "maximum": 127 },
    "start_time":        { "type": ["string", "null"], "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
    "fire_at":           { "type": ["string", "null"] },
    "duration_minutes":  { "type": "integer", "minimum": 1 },
    "timezone":          { "type": "string" },
    "enabled":           { "type": "integer", "enum": [0, 1] },
    "once_state":        { "type": ["string", "null"], "enum": ["PENDING", "FIRED", "SKIPPED", "CANCELLED", null] },
    "deleted_at":        { "type": ["string", "null"] },
    "sync_version":      { "type": "integer" }
  }
}
```

Note `deleted_at` is carried here (D5) — there is no separate `VALVE_SCHEDULE_DELETED` op.

- [ ] **Step 3: Add the four commands**

In `commands.schema.json`, add `UPSERT_VALVE_SCHEDULE`, `DELETE_VALVE_SCHEDULE`, `RESEND_VALVE_PLAN`, `SET_VALVE_SCHEDULER_STATUS` to the command-type enum, with payloads:

```json
"UPSERT_VALVE_SCHEDULE":     { "$ref": "#/definitions/ValveSchedule" },
"DELETE_VALVE_SCHEDULE":     { "type": "object", "required": ["schedule_uuid"], "properties": { "schedule_uuid": { "type": "string" } } },
"RESEND_VALVE_PLAN":         { "type": "object", "required": ["device_eui"], "properties": { "device_eui": { "type": "string" } } },
"SET_VALVE_SCHEDULER_STATUS":{ "type": "object", "required": ["device_eui", "status"], "properties": { "device_eui": { "type": "string" }, "status": { "type": "string", "enum": ["ACTIVE", "SKIP_TODAY", "DEACTIVATED"] } } }
```

- [ ] **Step 4: Verify the contract still parses and gates pass**

```bash
node -e "require('./docs/contracts/sync-schema/resources.schema.json'); require('./docs/contracts/sync-schema/commands.schema.json'); console.log('schemas parse')"
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
```
Expected: all pass. `verify-sync-op-parity.js` will still FAIL — the server half does not exist yet. That is expected until lockstep.

- [ ] **Step 5: Commit**

```bash
git add docs/contracts/sync-schema
git commit -m "contract: ValveSchedule resource, four valve commands, weekday bit order"
```

---

### Task 2: Migration 0024 — sync triggers on `valve_schedules`

**Files:**
- Create: `database/migrations/ordered/0024__valve_schedule_sync_triggers.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json`
- Modify: `database/seeds/seed-blank.sql` — **added after review.** The seed
  incorporates every migration's objects (0023's `app_settings` is at
  `seed-blank.sql:1080`), and the parity verifier reads ops out of the **bundled
  DBs**, not just the migrations. Seed, the bundled `farming.db` copies and the
  fingerprints all move with 0024. An earlier draft of this plan listed only the
  migration — follow `osi-schema-change-control` and Phase A design §4 here.
- Modify: the bundled seed databases for every profile
- Test: `scripts/test-valve-schedule-sync-triggers.js` (new)

**Interfaces:**
- Consumes: aggregate/op strings and the payload shape from Task 1.
- Produces: `sync_outbox` rows with `aggregate_type='VALVE_SCHEDULE'`, `aggregate_key=<schedule_uuid>`, `op='VALVE_SCHEDULE_UPSERTED'`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-valve-schedule-sync-triggers.js`. It must build a DB by replaying the ordered migrations, then assert four things. Use the existing helper style in `scripts/test-sync-history-schema.js` for the replay harness.

```js
// 1. UNLINKED gateway emits nothing
//    (no sync_link_state row) -> insert a valve_schedule -> expect 0 outbox rows
// 2. LINKED gateway emits on INSERT
//    -> expect exactly 1 row, aggregate_type='VALVE_SCHEDULE',
//       aggregate_key = the schedule_uuid, op='VALVE_SCHEDULE_UPSERTED'
// 3. _au does not fire on a bare unsynced-column touch
//    -> UPDATE once_fired_at ALONE, via raw SQL, without bumping sync_version
//       -> expect NO new outbox row.
//    CAUTION (review finding): this asserts an invariant PRODUCTION NEVER
//    EXERCISES. The real firing path goes through store.updateSchedule, which
//    always bumps sync_version, so a real firing DOES emit. Add a second case
//    asserting the production shape emits exactly ONE event — a test that only
//    covers the raw-SQL path is testing a situation that cannot occur.
// 4. _au DOES fire on a synced column
//    -> UPDATE enabled -> expect exactly 1 new outbox row
// 5. soft delete emits an upsert carrying deleted_at (D5)
//    -> UPDATE deleted_at -> expect 1 new row whose payload_json has deleted_at non-null
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node scripts/test-valve-schedule-sync-triggers.js
```
Expected: FAIL — the triggers do not exist, so assertion 2 finds 0 rows.

- [ ] **Step 3: Write the migration**

Create `database/migrations/ordered/0024__valve_schedule_sync_triggers.sql`. Mirror the schedules pair in `0003__stamp_contract_version_and_zone_op_split.sql` — the trigger is named **`trg_sync_schedules_outbox_au`** (NOT `trg_sync_irrigation_schedules_*`, which does not exist; an earlier draft of this plan named it wrongly). Open that file and copy the shape rather than inventing one.

```sql
DROP TRIGGER IF EXISTS trg_sync_valve_schedules_outbox_ai;
CREATE TRIGGER trg_sync_valve_schedules_outbox_ai
AFTER INSERT ON valve_schedules
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))),
    'VALVE_SCHEDULE',
    NEW.schedule_uuid,
    'VALVE_SCHEDULE_UPSERTED',
    json_object(
      'contract_version', 1,
      'schedule_uuid',    NEW.schedule_uuid,
      'device_eui',       NEW.device_eui,
      'kind',             NEW.kind,
      'label',            NEW.label,
      'weekdays_mask',    NEW.weekdays_mask,
      'start_time',       NEW.start_time,
      'fire_at',          NEW.fire_at,
      'duration_minutes', NEW.duration_minutes,
      'timezone',         NEW.timezone,
      'enabled',          NEW.enabled,
      'once_state',       NEW.once_state,
      'deleted_at',       NEW.deleted_at,
      'sync_version',     NEW.sync_version
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE(
      NULLIF(trim((SELECT gateway_device_eui FROM devices WHERE deveui = NEW.device_eui AND deleted_at IS NULL)), ''),
      NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud')), '')
    )
  );
END;

DROP TRIGGER IF EXISTS trg_sync_valve_schedules_outbox_au;
CREATE TRIGGER trg_sync_valve_schedules_outbox_au
AFTER UPDATE ON valve_schedules
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND (
    COALESCE(NEW.kind,'')             <> COALESCE(OLD.kind,'')             OR
    COALESCE(NEW.label,'')            <> COALESCE(OLD.label,'')            OR
    COALESCE(NEW.weekdays_mask,0)     <> COALESCE(OLD.weekdays_mask,0)     OR
    COALESCE(NEW.start_time,'')       <> COALESCE(OLD.start_time,'')       OR
    COALESCE(NEW.fire_at,'')          <> COALESCE(OLD.fire_at,'')          OR
    COALESCE(NEW.duration_minutes,0)  <> COALESCE(OLD.duration_minutes,0)  OR
    COALESCE(NEW.timezone,'')         <> COALESCE(OLD.timezone,'')         OR
    COALESCE(NEW.enabled,0)           <> COALESCE(OLD.enabled,0)           OR
    COALESCE(NEW.once_state,'')       <> COALESCE(OLD.once_state,'')       OR
    COALESCE(NEW.deleted_at,'')       <> COALESCE(OLD.deleted_at,'')       OR
    COALESCE(NEW.sync_version,0)      <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  -- identical INSERT ... VALUES block as _ai above; repeat it in full.
END;
```

**On `once_fired_at`:** it is absent from the guard, but do NOT justify that by
"so a firing emits nothing" — review showed that is false. `store.updateSchedule`
(`store.js`) *always* bumps `sync_version`, and `sync_version` IS in the guard, so
a production ONCE firing emits an event regardless. That is arguably desirable
(the cloud learns the schedule reached FIRED). The honest statement is: the guard
lists the fields whose change is *meaningful*, and `once_fired_at` adds nothing a
`sync_version` bump does not already carry.

- [ ] **Step 4: Declare the op as SQL-owned in the parity verifier**

`scripts/verify-sync-op-parity.js:83` has `SQL_OWNED_EVENT_OPS`, currently
holding only `WORK_REQUEST_SUBMITTED` with the comment "Emitted by
…seed DB trigger, not by flows.json." Our op is in exactly that category: the
verifier scans `flows.json` for edge emitters and will otherwise report
`VALVE_SCHEDULE_UPSERTED` as having no edge source.

```js
const SQL_OWNED_EVENT_OPS = new Set([
  'WORK_REQUEST_SUBMITTED',
  // Emitted by 0024__valve_schedule_sync_triggers.sql, not by flows.json.
  'VALVE_SCHEDULE_UPSERTED',
]);
```

Check whether `scripts/fixtures/sync-contract-staging.json` also needs the op —
the verifier mirrors its staged sets there.

- [ ] **Step 5: Register the checksum**

```bash
node scripts/verify-migrations.js
```
If it reports a missing/incorrect checksum, follow the repo's existing procedure to record `0024` in `CHECKSUMS.json`. Do not hand-edit a hash you have not computed.

- [ ] **Step 6: Run the test and the migration gates**

```bash
node scripts/test-valve-schedule-sync-triggers.js   # expect PASS
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-trigger-body-parity.js
```

- [ ] **Step 7: Commit**

```bash
git add database/migrations/ordered scripts/verify-sync-op-parity.js scripts/test-valve-schedule-sync-triggers.js
git commit -m "feat(sync): 0024 valve_schedules outbox triggers"
```

---

### Task 3: Route the four cloud commands into the existing handlers

**Files:**
- Modify (via one-shot script): `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify (mirror): `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Scratch only: a one-shot editor script in your scratchpad (NOT committed)

**Interfaces:**
- Consumes: command names from Task 1.
- Produces: no new module API — this delegates to `osi-valve-control`'s existing handlers so there is one code path per operation.

- [ ] **Step 1: Read the target node and the roundtrip rules**

Node `934bf2bc19a8ce22` ("Route Command"). Read `.claude/skills/osi-flows-json-editing/SKILL.md` in full before touching the file. Confirm the no-op roundtrip is byte-identical BEFORE mutating:

```bash
node -e "
const fs=require('fs');const p='conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const o=fs.readFileSync(p);const r=Buffer.from(JSON.stringify(JSON.parse(o.toString('utf8')),null,2)+'\n','utf8');
console.log('byte-identical:', Buffer.compare(o,r)===0, o.length, r.length);"
```
If that prints `false`, STOP.

- [ ] **Step 2: Add the four command cases**

Extend the existing `commandType` dispatch. Each case must call the same handler the REST route uses, so a cloud edit and a local edit compile identically:

- `UPSERT_VALVE_SCHEDULE` → the schedules POST/PUT handler
- `DELETE_VALVE_SCHEDULE` → the schedules DELETE handler
- `RESEND_VALVE_PLAN` → the `plan/resend` handler (`force: true`)
- `SET_VALVE_SCHEDULER_STATUS` → the `scheduler-status` handler

ACK via the existing command-ack path — do not invent a new one.

- [ ] **Step 3: Mirror to bcm2709 and verify parity**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
node scripts/verify-profile-parity.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-command-safety.js
node scripts/verify-flows-size-ratchet.js
```

- [ ] **Step 4: Commit**

```bash
git add conf/*/files/usr/share/flows.json
git commit -m "feat(sync): route the four cloud valve commands to the local handlers"
```

---

### Task 4: Backfill existing schedules when a gateway links

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store.js` (+ bcm2709 mirror)
- Test: the module's existing `store.test.js` (+ mirror)

**Interfaces:**
- Consumes: the trigger's aggregate/op strings from Task 2.
- Produces: `backfillSchedulesForLink(db, deviceEuiOrNull)` returning the count enqueued.

**Why:** the triggers only capture *changes*. A gateway that already has schedules when it first links would have them invisible to the cloud forever (spec §5 D3). Every gateway adopting valve control after Phase B is in exactly this position, including the Bovey Pi 4.

- [ ] **Step 1: Write the failing test**

In `store.test.js`, using the existing `tempDb()` helper:

```js
// seed: 3 valve_schedules (one soft-deleted), sync_link_state linked=1 inserted
//       AFTER the schedules, so no trigger ever fired for them
// act:  await store.backfillSchedulesForLink(db, null)
// assert: exactly 2 outbox rows (soft-deleted rows are NOT backfilled),
//         op='VALVE_SCHEDULE_UPSERTED', keys == the two live schedule_uuids
// assert: calling it twice does not double-enqueue (idempotent on aggregate_key
//         where delivered_at IS NULL)
```

- [ ] **Step 2: Run it, watch it fail**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control
node --test store.test.js
```
Expected: FAIL, `backfillSchedulesForLink is not a function`.

- [ ] **Step 3: Implement**

Add to `store.js`, exporting it from `module.exports`. It must build the same payload the trigger builds (keep the field list identical — a divergence here means backfilled rows and live rows disagree), and skip rows already pending in the outbox for the same `aggregate_key`.

- [ ] **Step 4: Run tests, mirror, verify**

```bash
node --test ack.test.js api.test.js plan.test.js push.test.js store.test.js workers.test.js
# NOTE: `node --test <dir>` silently runs only ONE file on this Node build (osi-os#182).
#       Always list the files explicitly.
cp store.js store.test.js ../../../../../../full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control/   # adjust path
node scripts/verify-profile-parity.js
node scripts/verify-helper-registration.js
```

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(sync): backfill existing valve schedules on first cloud link"
```

---

### Task 5: Full verification sweep

- [ ] **Step 1: Run every gate**

```bash
for g in scripts/verify-*.js scripts/test-*.js; do
  node "$g" >/dev/null 2>&1 && echo "PASS $g" || echo "FAIL $g"
done
```

Expected: everything passes EXCEPT:
- `verify-dendro-contract-mirror.js` — pre-existing, fails on `main` too, out of scope.
- `verify-sync-op-parity.js` — **still fails until the osi-server half ships.** Confirm the failure message no longer says `VALVE_SCHEDULE_UPSERTED` is *extra vs the server*; it should flip to green the moment the server registers the op. If it now complains about a *different* op, you have broken something.

- [ ] **Step 2: Frontend untouched, but confirm**

```bash
cd web/react-gui && npm run typecheck && npm run test:unit
```

- [ ] **Step 3: Deploy to the UNLINKED bench gateway only**

The Bovey Pi 4 (`100.99.212.115`) has no `sync_link_state` row, so the triggers must produce **zero** outbox rows there. That is the safe end-to-end check that the migration applies cleanly without emitting anything.

```sh
# after deploy, on the gateway:
sqlite3 /data/db/farming.db "select count(*) from sync_outbox;"          # expect 0
sqlite3 /data/db/farming.db "select count(*) from schema_migrations;"     # expect 24
sqlite3 /data/db/farming.db "select name from sqlite_master where type='trigger' and name like 'trg_sync_valve_schedules%';"  # expect 2
```

Deploy notes for this gateway: deploy.sh's post-flip health check gives Node-RED only 5s and false-negatives on a Pi 4 (osi-os#187), which then skips the React GUI step (osi-os#186). Read the evidence lines, not the exit code (osi-os#172).

- [ ] **Step 4: Commit any fixes and stop**

Do NOT link the Bovey gateway to the cloud as part of this plan. Linking is a separate, deliberate step once the osi-server half is deployed.

---

## Self-review notes

- **Spec coverage:** §6 items 1–4 map to Tasks 2, 1, 3, 4 respectively. §7 verification maps to Task 5.
- **Not covered by design:** `valve_settings` sync (D4 — deliberately out of scope; adding it later is a *column* migration, not trigger-only).
- **Type consistency:** the payload field list appears in Task 1 (schema), Task 2 (trigger `json_object`) and Task 4 (backfill). These three MUST agree field-for-field. If you change one, change all three.
