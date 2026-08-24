# Valve Control Phase B (edge half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `valve_schedules` changes flow to the cloud as `VALVE_SCHEDULE_UPSERTED` events, and accept cloud-authored schedule changes as commands, so `verify-sync-op-parity.js` goes green.

**Architecture:** A trigger-only SQLite migration (`0024`) puts `_ai`/`_au` triggers on `valve_schedules` that write `sync_outbox` rows, mirroring the existing schedules pair. Four new cloud→edge commands route into the *existing* `osi-valve-control` REST handlers so the valve keeps exactly one writer. Pre-existing schedules reach the cloud through the **existing bootstrap snapshot** (not a bespoke backfill). A sixth task makes observed weekly runs visible to the cloud via the already-supported `IRRIGATION_EVENT_APPENDED` op.

**Tech Stack:** SQLite (triggers, ordered migrations), Node-RED `flows.json` function nodes, `osi-valve-control` CommonJS module, JSON-Schema contract files shared with osi-server.

**Spec:** [docs/superpowers/specs/2026-08-23-valve-cloud-parity-phase-b-design.md](../specs/2026-08-23-valve-cloud-parity-phase-b-design.md)

**RULED 2026-08-24** (independent review + operator acceptance). These are no
longer assumptions:

- **D1** trigger pair — as recommended.
- **D2** edge-authoritative, cloud writes as commands — as recommended.
- **D3** backfill YES, but **via the existing bootstrap snapshot**, NOT a bespoke
  outbox walk. The bespoke mechanism cannot work: ownership is checked *before*
  the parent-missing retry path, so a schedule arriving ahead of its device is
  dead-lettered **terminally**. Task 4 is rewritten accordingly.
- **D4** `valve_settings` stays edge-only. (Its original justification was false —
  see the spec's correction — but the ruling stands.)
- **D5** `deleted_at` carried in the upsert — as recommended.
- **Resource key:** composite **`device_eui|schedule_uuid`** server-side.
- **NEW — weekly runs reach the cloud (Task 6).** Review found the flagship
  weekly path is invisible: `irrigation_events` is written only by `runOnceTick`.

## Global Constraints

- **This plan is HALF of a lockstep pair.** The edge migration must not reach a *cloud-linked* gateway before osi-server can accept `VALVE_SCHEDULE_UPSERTED`, or the outbox fills with terminally-rejected rows. The Bovey Pi 4 (`100.99.212.115`) is **unlinked** and is therefore the safe landing place for the edge half alone.
- **Migration number is `0024`.** `0023` is `app_settings`. Never renumber an existing ordered migration.
- **Trigger-only.** `schedule_uuid`, `sync_version`, `deleted_at` already exist on `valve_schedules` from Phase A. Adding a column makes this a different risk class — if you think you need one, stop.
- **`flows.json` is edited ONLY by a one-shot Node script** with a byte-identical roundtrip guard (`JSON.stringify(flows, null, 2) + '\n'`), never by hand or by string patching. Both hardware profiles (`bcm2712` canonical, `bcm2709` mirror) must stay byte-identical.
- **Never touch `sync-init-fn`** (the frozen boot-DDL node) for schema behaviour.
- **Weekday bit order is `bit0 = Sunday … bit6 = Saturday`.** The GUI displays Monday-first over the same 0=Sunday storage. Do not "fix" one to match the other.
- **Aggregate type `VALVE_SCHEDULE`, aggregate key `schedule_uuid`, op `VALVE_SCHEDULE_UPSERTED`** — exact strings, they are contract.
- **Server-side resource id is the composite `device_eui|schedule_uuid`** (ruled 2026-08-24). Neither pure option works: a bare `schedule_uuid` cannot be resolved to an owner before the row exists, so every first upsert would be terminal `ownership_denied`; and `device_eui` alone collapses many schedules onto one watermark, so sibling schedules cross-reject as `stale_sync_version`. The composite follows the existing `DEVICE_DATA_ROW` (`deveui|recorded_at`) and `WORK_REQUEST` precedents, resolves ownership from the EUI prefix, and is 49 chars — inside `resource_id VARCHAR(128)`. The **edge** still sets `aggregate_key = schedule_uuid`; the server derives the composite. Record this in the contract so the lockstep half cannot miss it.
- **The lockstep osi-server change has three touch points that are easy to miss**, each of which silently breaks delivery: a `VALVE_SCHEDULE_` case in `resourceTypeFromOp` (today `VALVE_*` falls through to `"EVENT"`, which disables watermark dedupe/ordering), a case in `EdgeOwnershipService`, and an `isParentMissing` message prefix the valve applier actually throws (matching is on **literal** prefixes). Put these in the contract/PR description.
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

### Task 4: Carry `valve_schedules` in the bootstrap snapshot

**Files:**
- Modify (via one-shot script): both `flows.json` profiles — nodes
  `sync-bootstrap-build` **and** `sync-force-build`
- Modify: `docs/contracts/sync-schema/` bootstrap request shape if it is pinned there

**Why this and not a backfill walk (D3 ruling):** the triggers capture only
*changes*, so schedules that exist before a gateway links would be invisible to
the cloud forever. The obvious fix — enqueue outbox rows on link — **cannot
work**: `SyncEventTxExecutor` checks ownership *before* the parent-missing retry
branch, so a `VALVE_SCHEDULE` event whose device has not yet landed cloud-side
resolves to a null owner and is rejected **terminally**, not retried. The device
cannot arrive by events either (same gap) — devices land via the **bootstrap
snapshot**.

That snapshot already exists, already ships users/zones/`irrigation_schedules`/
devices/telemetry to `POST /api/v1/sync/edge/bootstrap`, is applied **in-process,
parents first, bypassing per-resource ownership**, and runs both on link and
**every 6 hours**. That 6-hourly cadence also self-heals the steady-state window
where a schedule is created before its device's first bootstrap.

- [ ] **Step 1: Read the existing bootstrap builder**

Find `sync-bootstrap-build` in `flows.json` and read how `irrigation_schedules`
is collected and shaped. Note the ORDER of the collections — the server applies
them in payload order.

- [ ] **Step 2: Add `valve_schedules` to both builders**

`sync-bootstrap-build` and `sync-force-build` must agree; a snapshot that differs
by trigger path is a bug that only shows under force.

Use **the same field list** as the 0024 trigger payload. That list now appears in
three places (schema, trigger, bootstrap) and they must not drift — Task 5's
verification includes checking they match.

- [ ] **Step 3: Ordering — parents before children**

**Critical:** the server's `applyBootstrap` loops in payload order, and the
existing schedules loop runs *before* devices. That is safe only because
`irrigation_schedules` parent on **zones**. `valve_schedules` parent on
**devices**, so the valve-schedule collection must be placed **after** the
devices loop. Getting this wrong reproduces the exact terminal-rejection failure
this task exists to avoid.

Record this as a note for the lockstep osi-server change; the edge side only
controls payload order.

- [ ] **Step 4: Mirror, verify, commit**

```bash
node scripts/verify-profile-parity.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-sync-flow.js
git add conf/*/files/usr/share/flows.json
git commit -m "feat(sync): carry valve_schedules in the bootstrap snapshot"
```

---

### Task 6: Make weekly/on-valve runs reach the cloud

**Files:**
- Modify (via one-shot script): both `flows.json` profiles — node
  `strega-reconciliation-monitor`
- Test: extend `scripts/test-flows-wiring.js` coverage or add a focused test

**Why:** review established that the cloud never sees a weekly run. Verified:
`irrigation_events` is written **only** at `osi-valve-control/workers.js:53,62`,
both inside `runOnceTick`; `runObserveTick` writes none; and
`valve_actuation_expectations` has **no sync trigger in any migration**. So under
Tasks 1–4 the cloud would receive valve *schedules* and never see them *execute*.

The cheap, correct fix reuses the existing server-supported
`IRRIGATION_EVENT_APPENDED` op rather than inventing a new one.

- [ ] **Step 1: Write the failing test**

```
// when the reconciliation monitor moves an expectation to OBSERVED_COMPLETE:
//  - trigger 'on_valve_schedule' or 'unexplained' -> writes exactly ONE
//    irrigation_events row, action IRRIGATE, duration from the OBSERVED span
//    (observed_close_at - observed_open_at), not the commanded duration
//  - trigger 'one_time' -> writes NOTHING. runOnceTick already logged this run
//    at fire time; logging again would double-count the farmer's water.
//  - a zone-less or user-less valve -> writes nothing (irrigation_events has
//    user_id and irrigation_zone_id NOT NULL), and warns
//  - event_uuid is OMITTED so trg_sync_irrigation_events_uuid_ai mints the
//    canonical 'irrig-<gwEui>-<seq>' key — a hand-rolled UUID ships a
//    non-conforming aggregate_key to the cloud
```

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Implement in `strega-reconciliation-monitor`**

The monitor already computes `observedCloseAt` and transitions to
`OBSERVED_COMPLETE` (it currently only UPDATEs `valve_actuation_expectations`).
Add the `irrigation_events` INSERT in the same transaction as that transition, so
a crash cannot produce a completed actuation with no event or vice versa.

Duration comes from the **observed** span. If `observed_open_at` is null, log no
duration rather than substituting the commanded one — the missing-data rule
applies: an unknown duration is unknown, not zero.

Reuse the `reason` vocabulary already in `irrigation_events`; add a value for
observed-on-valve runs rather than overloading `one_time_open`.

- [ ] **Step 4: Mirror both profiles, run the gates, commit**

---

### Task 5: Full verification sweep

- [ ] **Step 0: Confirm the three payload field lists agree**

Schema (Task 1), trigger `json_object` (Task 2), bootstrap builders (Task 4, both
nodes). A drift here means backfilled and live rows disagree on shape.

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

- **Spec coverage:** contract → Task 1, triggers → Task 2, commands → Task 3, pre-existing schedules → Task 4 (bootstrap), verification → Task 5, weekly-run visibility → Task 6.
- **Not covered by design:** `valve_settings` sync (D4 — deliberately out of scope; adding it later is a *column* migration, not trigger-only).
- **Type consistency:** the payload field list appears in **three** places — Task 1 (schema), Task 2 (trigger `json_object`), Task 4 (bootstrap builder, ×2 nodes). They MUST agree field-for-field; Task 5 checks it.
- **Ordering hazard:** Task 4's bootstrap collection must sit **after** devices, unlike the existing schedules collection which sits before. Wrong order = terminal rejections, which is the failure the task exists to prevent.
- **Task 6 double-count hazard:** ONCE runs already log at fire time. The monitor must log only for `on_valve_schedule` / `unexplained` triggers, or the farmer's water is counted twice.
