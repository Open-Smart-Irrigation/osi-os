# AgroLink Schedule and Irrigation-Calibration Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make zone schedules and measured irrigation calibration converge in
both directions between OSI OS and OSI Server without changing scheduler or
valve behavior.

**Architecture:** Schedule and irrigation calibration remain separate,
zone-keyed aggregates with independent versions and desired-state operations.
One edge helper applies both protected command families transactionally. One
capability activates both consumers, while legacy gateways retain their
existing schedule path and do not receive cloud calibration commands.

**Tech Stack:** SQLite ordered migrations, Node-RED function modules,
JSON Schema, Node test runner, Spring Boot/JPA/Flyway, PostgreSQL, React,
TypeScript, Vitest, and Gradle.

## Global Constraints

- OSI OS is canonical. Cloud writes remain desired state until ACK and mirror
  convergence.
- REST pending commands are the only cloud-to-edge path.
- Use the isolated edge worktree
  `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep` on
  `design-sync/agrolink`.
- Use the isolated server worktree
  `/home/phil/Repos/osi-server/.worktrees/agrolink` on `AgroLink`.
- Do not touch `/home/phil/Repos/osi-os-agrolink`.
- Mirror every maintained bcm2712 runtime file byte-for-byte to bcm2709.
- Edit `flows.json` only through a pinned, one-shot Node transformer.
- Do not add schema behavior to `sync-init-fn`.
- Use explicit file lists for every commit and verify the remote branch SHA
  after every push.
- Before each heavyweight command, record `free -m`, `pswpin`, `pswpout`, and
  the twelve highest-RSS processes. Do not start below 4,096 MiB available.
- Run Gradle from `backend/` with
  `NODE_OPTIONS=--max-old-space-size=2048`, `--no-daemon`, and
  `--max-workers=2`.
- Run frontend builds and full frontend tests with
  `NODE_OPTIONS=--max-old-space-size=2048`.
- Do not access production, `osicloud.ch`, a live gateway, an external key
  service, or an AgroLink SMB share.

---

## System map

**Where this fits:** `irrigation_schedules` is the edge scheduler policy for a
zone. `zone_irrigation_calibration` stores the measured L/min rate used only
when estimating timed valve volume without a healthy flow meter.

**Who calls it:** The edge schedule and zone-config React forms call the two
local routes. The cloud schedule editor calls
`IrrigationZoneController.updateSchedule`. The scheduler reads the schedule;
STREGA expectation persistence reads calibration.

**What it calls:** Local routes write SQLite. Triggers enqueue sync events.
OSI Server mirrors those events and sends protected REST pending commands.
`DesiredStateService` reconciles command ACKs with returning mirror payloads.

**Key seams:** Ordered migrations own calibration versioning; a new helper owns
protected command application; two server mutation services own desired
payload construction; existing controllers remain the HTTP seam.

**Neighbouring modules:** Zone desired state supplies authorization and command
patterns. The generic command ledger supplies replay and atomic ACK behavior.
Valve actuation and scheduler evaluation are consumers, not edit targets.

## Task 1: Version and mirror edge irrigation calibration

**Files:**

- Create:
  `database/migrations/ordered/0036__zone_irrigation_calibration_sync.sql`
- Create:
  `database/migrations/ordered/0037__zone_irrigation_calibration_backfill.sql`
- Create: `scripts/rehearse-irrigation-calibration-sync.test.js`
- Modify: `database/seed-blank.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json`
- Modify: `scripts/verify-runtime-schema-parity.js`
- Modify: `scripts/verify-db-schema-consistency.js`
- Modify: `scripts/verify-trigger-body-parity.js`
- Modify: all seven bundled `farming.db` files

**Interfaces:**

- Consumes: existing `zone_irrigation_calibration(zone_id, valve_device_eui,
  measured_flow_rate_lpm, measurement_method, measured_at, created_at,
  updated_at)`.
- Produces: `sync_version`, `deleted_at`, `last_applied_at`, and
  `ZONE_IRRIGATION_CALIBRATION_UPSERTED`.

- [ ] **Step 1: Write the failing migration rehearsal**

Create a Node test that loads the pre-migration seed, links the scratch
gateway, inserts an existing calibration, applies `0036` and `0037`, and
asserts:

```js
assert.equal(row.sync_version, 1);
assert.equal(events.length, 1);
assert.equal(events[0].op, 'ZONE_IRRIGATION_CALIBRATION_UPSERTED');
assert.deepEqual(JSON.parse(events[0].payload_json), {
  contract_version: 1,
  zone_uuid: ZONE_UUID,
  gateway_device_eui: GATEWAY_EUI,
  measured_flow_rate_lpm: 12.5,
  measurement_method: 'Timed bucket test',
  measured_at: '2026-07-24T10:00:00.000Z',
  sync_version: 1,
  deleted_at: null,
  last_applied_at: null,
});
```

Add a second case that updates the measured rate at version `2` and receives
one version-2 event.

- [ ] **Step 2: Run the focused test and preserve the red result**

Run:

```bash
node --test scripts/rehearse-irrigation-calibration-sync.test.js
```

Expected: failure because migrations `0036` and `0037` do not exist.

- [ ] **Step 3: Add the additive schema migration**

`0036` starts with `-- risk: additive`, adds the three columns, and creates:

```sql
CREATE TRIGGER trg_sync_zone_irrigation_calibration_defaults_ai
AFTER INSERT ON zone_irrigation_calibration
FOR EACH ROW
WHEN COALESCE(NEW.sync_version, 0) = 0
BEGIN
  UPDATE zone_irrigation_calibration
     SET sync_version = 1
   WHERE zone_id = NEW.zone_id;
END;
```

Add an update trigger that emits only after a portable field, tombstone, apply
timestamp, or version changes. Use the zone UUID and gateway EUI from
`irrigation_zones`; emit numeric `enabled` nowhere in this resource.

- [ ] **Step 4: Add the data backfill**

`0037` starts with `-- risk: data` and performs:

```sql
UPDATE zone_irrigation_calibration
   SET sync_version = 1
 WHERE COALESCE(sync_version, 0) = 0;
```

The `0036` update trigger supplies the initial event on linked installations.
The migration runner supplies the online backup.

- [ ] **Step 5: Update the seed, bundled databases, and verifiers**

Apply both migrations through the repository migration tooling. Do not
regenerate any database. Copy the canonical bcm2712 runtime database to the
bcm2709 mirror where profile parity requires it. Compute each new file's
SHA-256 with `sha256sum`, then add those exact hashes to `CHECKSUMS.json` with
`apply_patch`.

- [ ] **Step 6: Run the schema gate**

Run:

```bash
node --test scripts/rehearse-irrigation-calibration-sync.test.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-profile-parity.js
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit and push**

Stage only Task 1 files and commit:

```bash
git commit -m "feat(sync): version irrigation calibration"
```

Push `design-sync/agrolink` and compare `git rev-parse HEAD` with
`git ls-remote origin refs/heads/design-sync/agrolink`.

## Task 2: Specify and implement protected irrigation-config commands

**Files:**

- Modify: `docs/contracts/sync-schema/commands.schema.json`
- Modify: `docs/contracts/sync-schema/events.schema.json`
- Modify: `docs/contracts/sync-schema/resources.schema.json`
- Modify: `docs/contracts/sync-schema/sync-contract-golden.json`
- Modify: `docs/contracts/sync-schema/effect-keys.md`
- Modify: `docs/contracts/sync-schema/canonicalization.md`
- Modify: `scripts/test-contract-schemas.js`
- Modify: `scripts/verify-sync-contract.js`
- Create:
  `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-config-commands/index.js`
- Create:
  `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-config-commands/index.test.js`
- Create its `package.json`
- Mirror all three files under bcm2709
- Modify both `osi-command-ledger` copies and tests
- Modify both `osi-lib/index.js` copies
- Modify both Node-RED `package.json` and `package-lock.json` files
- Create: `scripts/test-irrigation-config-command-path.js`
- Modify: `deploy.sh`
- Modify: `scripts/verify-sync-flow.js`

**Interfaces:**

- Consumes: generic command-ledger replay, transaction, and terminal ACK APIs.
- Produces:

```js
applyIrrigationConfigCommand(db, command, runtime)
// -> Promise<{ handled: boolean, ack?: object }>
```

- [ ] **Step 1: Add failing contract tests**

Cover:

```text
UPSERT_SCHEDULE
  schedule:<zone_uuid>:<base>
UPSERT_ZONE_IRRIGATION_CALIBRATION
  irrigation_calibration:<zone_uuid>:<base>
```

Test valid create and update, `target !== base + 1`, wrong gateway, wrong UUID,
camel-case-only protected payload, unknown fields, unsupported metric,
non-finite threshold/rate, invalid duration, invalid response mode, and
non-canonical timestamp. Preserve legacy schedule shapes as accepted
compatibility forms. Stage the new calibration event and command in the golden
fixture; do not enable producers yet.

- [ ] **Step 2: Run contract tests and preserve the red result**

Run:

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
```

Expected: failure on the missing strict schemas and new operation.

- [ ] **Step 3: Write failing helper and ledger tests**

Use scratch SQLite databases to cover schedule and calibration create, update,
stale base, future base, missing zone, wrong gateway, exact command replay,
equivalent effect replay, changed intent under the same effect, and injected
write rollback.

Extend the ledger binding validator with:

```js
/^schedule:([^:]+):([0-9]+)$/
/^irrigation_calibration:([^:]+):([0-9]+)$/
```

Require the captured UUID and base to equal the protected envelope.

- [ ] **Step 4: Implement the helper**

The public dispatcher is:

```js
async function applyIrrigationConfigCommand(db, command, runtime) {
  const type = String(
    command.command_type || command.commandType || '',
  ).trim().toUpperCase();
  const protectedShape = command.effect_key != null
    || command.effectKey != null
    || command.base_sync_version != null
    || command.baseSyncVersion != null;
  if (!['UPSERT_SCHEDULE', 'UPSERT_ZONE_IRRIGATION_CALIBRATION'].includes(type)) {
    return { handled: false };
  }
  if (!protectedShape) return { handled: false };
  return type === 'UPSERT_SCHEDULE'
    ? applySchedule(db, command, runtime)
    : applyCalibration(db, command, runtime);
}
```

Both handlers use bound parameters inside `db.transaction()`. Schedule create
requires no active row at base `0`; update requires exact stored version.
Calibration follows the same rule. A conflict reports the current version.
The terminal ledger and ACK are written in the same transaction.

- [ ] **Step 5: Register and mirror the helper**

Register `irrigation-config-commands` through `osi-lib`, update package
manifests and deploy checks, mirror bcm2712 to bcm2709, and add verifier
assertions for both helper registrations.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-config-commands/index.test.js \
  scripts/test-irrigation-config-command-path.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
```

Expected: all tests pass while the new calibration operations remain staged.

- [ ] **Step 7: Commit and push**

Commit:

```bash
git commit -m "feat(sync): apply versioned irrigation config"
```

Push and verify the remote edge SHA.

## Task 3: Route protected commands and advertise capability

**Files:**

- Create: `scripts/migrate-flows-irrigation-config-command-applier.js`
- Create: `scripts/migrate-flows-irrigation-config-capability.js`
- Modify: both maintained `flows.json` files through those transformers
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/test-scoped-access-writes.js`

**Interfaces:**

- Consumes: Task 2 helper and existing pending-command envelope.
- Produces: protected routing plus
  `irrigation_config_desired_state_v1` in local-sync, bootstrap, and force-sync.

- [ ] **Step 1: Add failing flow tests**

Assert that:

- protected schedule and calibration commands reach the helper before legacy
  SQL construction;
- unprotected schedule commands fall through unchanged;
- local schedule saves increment only schedule version;
- local calibration saves increment only calibration version;
- bootstrap and force-sync include calibration rows; and
- all three capability payloads advertise
  `irrigation_config_desired_state_v1`.

- [ ] **Step 2: Run focused flow tests and preserve the red result**

Run:

```bash
node scripts/test-flows-wiring.js
node scripts/test-scoped-access-writes.js
```

Expected: the new routing, calibration bootstrap, and capability assertions
fail.

- [ ] **Step 3: Implement one-shot transformers**

Each transformer must:

1. parse and stringify each input byte-identically before editing;
2. pin every target node ID and preimage hash;
3. make only the bounded helper, local-write, bootstrap, or capability change;
4. copy the canonical result to bcm2709;
5. reject an unexpected preimage; and
6. produce byte-identical output on a second run.

Insert `Apply Irrigation Config Command` after the protected zone handler and
before the legacy route. Load the helper only through:

```js
const helper = osiLib.require('irrigation-config-commands');
```

Modify the local calibration upsert to preserve `valve_device_eui`, assign
`sync_version = current + 1`, and use bound parameters. Do not alter STREGA
expectation semantics.

- [ ] **Step 4: Run each transformer twice**

Hash both profiles before and after the second run. The second run must leave
both hashes unchanged.

- [ ] **Step 5: Run the edge umbrella gate**

Run:

```bash
node scripts/test-flows-wiring.js
node scripts/test-scoped-access-writes.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit and push**

Commit:

```bash
git commit -m "feat(sync): advertise irrigation config desired state"
```

Push and verify the remote edge SHA.

## Task 4: Add the server capability and calibration mirror

**Files:**

- Create:
  `backend/src/main/resources/db/migration/V2026_07_24_002__irrigation_config_parity.sql`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccount.java`
- Modify:
  `backend/src/main/java/org/osi/server/user/LinkedGatewayAccountService.java`
- Modify:
  `backend/src/main/java/org/osi/server/user/LinkedGatewaySyncService.java`
- Create:
  `backend/src/main/java/org/osi/server/zone/ZoneIrrigationCalibration.java`
- Create:
  `backend/src/main/java/org/osi/server/zone/ZoneIrrigationCalibrationRepository.java`
- Create:
  `backend/src/test/java/org/osi/server/zone/IrrigationConfigMigrationIT.java`
- Modify: `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Modify the matching capability, bootstrap, applier, ownership, and watermark
  tests

**Interfaces:**

- Consumes: `irrigation_config_desired_state_v1` and
  `ZONE_IRRIGATION_CALIBRATION_UPSERTED`.
- Produces: `isIrrigationConfigDesiredStateSupported()` and a one-to-one
  calibration mirror.

- [ ] **Step 1: Write failing Flyway and capability tests**

Assert the migration adds:

```sql
ALTER TABLE linked_gateway_accounts
  ADD COLUMN irrigation_config_desired_state_supported BOOLEAN NOT NULL DEFAULT FALSE;
```

Create `zone_irrigation_calibrations` with a unique `zone_id`, gateway EUI,
measured rate, method, measured/apply/tombstone timestamps, and sync version.
Test bootstrap and event capability ingestion.

- [ ] **Step 2: Write failing applier tests**

Cover create, newer update, exact replay, equal-version different payload,
stale event, wrong gateway, unknown zone, bootstrap import, and desired-state
mirror observation for resource type `IRRIGATION_CALIBRATION`.

- [ ] **Step 3: Implement migration, entity, and applier**

Extend `EdgeBootstrapRequest` with a trailing calibration list while preserving
existing constructor overloads with `List.of()`. Extend resource mapping:

```java
case "IRRIGATION_CALIBRATION" -> firstNonBlank(
        strFromPayload(event.payload(), "zone_uuid", "zoneUuid"),
        event.aggregateKey());
```

Map `ZONE_IRRIGATION_CALIBRATION_UPSERTED` to that resource type and apply it
through the same watermark and desired-state observation path as schedules.

- [ ] **Step 4: Run focused backend tests**

From `backend/`, after the memory preflight:

```bash
NODE_OPTIONS=--max-old-space-size=2048 \
./gradlew test \
  --tests org.osi.server.user.LinkedGatewayAccountServiceTest \
  --tests org.osi.server.user.LinkedGatewaySyncServiceTest \
  --tests org.osi.server.zone.IrrigationConfigMigrationIT \
  --tests org.osi.server.sync.SyncEventApplierTest \
  --tests org.osi.server.sync.SyncResourceWatermarkRepositoryTest \
  --no-daemon --max-workers=2
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit and push**

Commit:

```bash
git commit -m "feat(sync): mirror irrigation calibration"
```

Push `AgroLink` and verify the remote SHA.

## Task 5: Produce protected schedule and calibration desired state

**Files:**

- Create:
  `backend/src/main/java/org/osi/server/zone/ScheduleMutationService.java`
- Create:
  `backend/src/main/java/org/osi/server/zone/IrrigationCalibrationMutationService.java`
- Modify:
  `backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java`
- Modify the corresponding zone, scope, desired-state, ACK, and convergence
  tests

**Interfaces:**

- Produces:

```java
ScheduleMutationService.MutationResult upsert(
    User actor, IrrigationZone zone, ScheduleInput input)

IrrigationCalibrationMutationService.MutationResult upsert(
    User actor, IrrigationZone zone, CalibrationInput input)
```

- [ ] **Step 1: Write failing schedule producer tests**

Cover capable create at base `0`, capable update at the mirrored base, viewer
and unrelated-scope rejection, exact seven-value edge vocabulary, active
unleased coalescing, leased-command conflict, ACK without mirror, matching
mirror after ACK, divergent mirror, and legacy gateway fallback.

Assert the protected payload has:

```java
assertThat(payload).containsEntry("command_type", "UPSERT_SCHEDULE");
assertThat(payload).containsEntry("effect_key", "schedule:zone-1:4");
assertThat(payload).containsEntry("base_sync_version", 4L);
assertThat(payload).containsEntry("target_sync_version", 5L);
assertThat((Map<?, ?>) payload.get("schedule"))
        .containsEntry("sync_version", 5L)
        .containsEntry("enabled", 1);
```

- [ ] **Step 2: Write failing calibration producer tests**

Cover capable create/update, finite positive rate, 200-character method,
canonical measurement timestamp, pending response overlay, conflict,
authorization, cloud-local persistence, and unsupported legacy gateway.

- [ ] **Step 3: Implement the two services**

Both services resolve access with the existing zone gateway seam, require
`irrigation_config_desired_state_v1`, read the canonical base, include the full
resource in `desired`, and call:

```java
desiredStateService.request(
    gateway,
    actor,
    new DesiredStateService.Request(
        resourceType,
        zone.getZoneUuid(),
        commandType,
        DesiredStateMutationKind.CONFIG,
        base,
        desired,
        commandPayload,
        effectKey,
        null));
```

Use numeric `0` or `1` for desired schedule `enabled`, matching SQLite JSON.
Exclude `last_triggered_at` and `valve_device_eui`.

- [ ] **Step 4: Integrate controller responses**

For capable gateways, `updateSchedule` and the new calibration endpoint return
HTTP `202` plus the desired overlay. For legacy schedule gateways, preserve
the existing raw command. For a legacy calibration gateway, return `409` with
an explicit unsupported-capability error. Cloud-local zones write their server
rows directly.

Zone-list assembly attaches the latest desired operation separately to
schedule and calibration responses.

- [ ] **Step 5: Run focused backend tests**

From `backend/`:

```bash
NODE_OPTIONS=--max-old-space-size=2048 \
./gradlew test \
  --tests org.osi.server.zone.ScheduleMutationServiceTest \
  --tests org.osi.server.zone.IrrigationCalibrationMutationServiceTest \
  --tests org.osi.server.zone.IrrigationZoneControllerSyncTest \
  --tests org.osi.server.desiredstate.DesiredStateServiceTest \
  --no-daemon --max-workers=2
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Commit and push**

Commit:

```bash
git commit -m "feat: protect irrigation config mutations"
```

Push and verify the remote server SHA.

## Task 6: Add cloud pending-state and calibration UI

**Files:**

- Modify: `frontend/src/types/farming.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/services/__tests__/api.desiredState.test.ts`
- Modify: `frontend/src/components/farming/ScheduleSection.tsx`
- Create:
  `frontend/src/components/farming/__tests__/ScheduleSection.desiredState.test.tsx`
- Modify: `frontend/src/components/farming/AdvancedScheduleDrawer.tsx`
- Modify: `frontend/src/components/farming/ZoneConfigModal.tsx`
- Modify its focused tests
- Modify required `frontend/public/locales/*/devices.json` files

**Interfaces:**

- Consumes: schedule and nested calibration desired-state responses.
- Produces: immediate pending overlays and visible terminal states.

- [ ] **Step 1: Write failing API normalization tests**

Assert schedule and calibration operations normalize status case, snake-case
fields, numeric booleans, and conflict detail. Assert calibration requests use:

```ts
await api.post(
  `/api/v1/irrigation-zones/${zoneId}/calibration`,
  { measuredFlowRateLpm, measurementMethod },
);
```

- [ ] **Step 2: Write failing component tests**

Cover pending schedule values, conflicted schedule status, unsupported
edge-backed metric selection, pending calibration values, calibration conflict,
positive finite rate validation, and post-save list refresh without claiming
edge success.

- [ ] **Step 3: Implement types and API**

Add `desiredState?: DesiredStateOperation | null` to
`IrrigationSchedule`. Add:

```ts
export interface IrrigationCalibration {
  measuredFlowRateLpm: number | null;
  measurementMethod: string | null;
  measuredAt: string | null;
  syncVersion: number;
  deletedAt: string | null;
  lastAppliedAt: string | null;
  desiredState?: DesiredStateOperation | null;
}
```

Add `irrigationCalibration?: IrrigationCalibration | null` to
`IrrigationZone`.

- [ ] **Step 4: Implement honest pending UI**

Reuse `PendingStateNotice` for each resource. Keep schedule and calibration
saves separate. After HTTP `202`, call the existing refresh callback and let
the returned desired overlay render the pending value.

For an edge-backed zone, the metric selector offers only:

```text
SWT_WM1 SWT_WM2 SWT_AVG SWT_1 SWT_2 SWT_3 DENDRO
```

If the mirror contains another value, display it as unsupported and require a
supported choice before save.

- [ ] **Step 5: Run focused and full frontend gates**

After the memory preflight, run from `frontend/`:

```bash
NODE_OPTIONS=--max-old-space-size=2048 \
npx vitest run \
  src/services/__tests__/api.desiredState.test.ts \
  src/components/farming/__tests__/ScheduleSection.desiredState.test.tsx \
  src/components/farming/__tests__/ZoneConfigModal.weatherSource.test.tsx
npx tsc --noEmit
NODE_OPTIONS=--max-old-space-size=2048 npm run test:unit
NODE_OPTIONS=--max-old-space-size=2048 npm run build
```

Expected: all tests and the production build pass.

- [ ] **Step 6: Commit and push**

Commit:

```bash
git commit -m "feat: show pending irrigation config"
```

Push and verify the remote server SHA.

## Task 7: Activate the paired contract and verify the row

**Files:**

- Modify the six server vendor files under
  `backend/src/test/resources/sync-contract/`
- Modify edge golden rollout metadata
- Modify matrix and execution report after all gates pass

- [ ] **Step 1: Vendor the staged edge contract**

Copy exactly the six edge-owned contract files. Run:

```bash
sh scripts/verify-edge-sync-contract-vendor.test.sh
EDGE_CONTRACT_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/docs/contracts/sync-schema \
  sh scripts/verify-edge-sync-contract-vendor.sh
```

Run `SyncContractVendorTest` from `backend/`. Commit and push the vendor slice.

- [ ] **Step 2: Activate only after both consumers pass**

Move `ZONE_IRRIGATION_CALIBRATION_UPSERTED` from staged to edge-produced and
server-handled. Move `UPSERT_ZONE_IRRIGATION_CALIBRATION` from staged to
cloud-issued. Set both axes of `irrigation_config_desired_state_v1` to true.
The strict schedule form becomes active through the capability; legacy
schedule forms remain accepted.

- [ ] **Step 3: Re-vendor the activated bytes**

Copy the changed canonical files to the server vendor and repeat both
byte-identity gates.

- [ ] **Step 4: Run the final edge gates**

Run the focused tests from Tasks 1 through 3, then:

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-trigger-body-parity.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
OSI_SERVER_EDGE_SYNC_SERVICE=/home/phil/Repos/osi-server/.worktrees/agrolink/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
  node scripts/verify-sync-op-parity.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
```

- [ ] **Step 5: Run the final backend gate**

After the memory preflight, from `backend/`:

```bash
NODE_OPTIONS=--max-old-space-size=2048 \
./gradlew test --no-daemon --max-workers=2
```

Record the exact test count, failures, elapsed time, memory, and swap counters.

- [ ] **Step 6: Perform a separate full-diff self-review**

Check:

- no canonical mirror is written before edge confirmation;
- schedule and calibration versions never share an effect family;
- local-only valve EUI and scheduler runtime timestamps are not desired;
- protected SQL uses bound parameters;
- legacy gateways retain schedule behavior;
- new calibration commands are capability-gated;
- both flow profiles are byte-identical; and
- no unrelated or generated file is staged.

- [ ] **Step 7: Update and publish control documents**

Update:

- `docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-matrix.md`
- `docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-execution-report.md`

Mark row 2 `parity` only after local-to-cloud and cloud-to-edge convergence,
conflict, replay, authorization, legacy fallback, frontend, and full-suite
evidence are all green. Run the anti-slop checker and `git diff --check`.
Commit, push, and verify the edge remote SHA.

## Execution order and commit boundaries

1. Edge calibration schema and initial mirror.
2. Edge protected helper plus staged contract.
3. Edge routing, local writers, bootstrap, and capability advertisement.
4. Server capability and calibration mirror.
5. Server protected producers.
6. Frontend pending schedule and calibration UX.
7. Staged vendor, paired activation, activated vendor.
8. Matrix and execution evidence.

Do not start Task 8 row 3 until every accepted row-2 commit is pushed and both
worktrees are clean.
