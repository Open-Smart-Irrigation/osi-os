# AgroLink Zone Parity Implementation Plan

**Goal:** Make zone creation, deletion, portable configuration, location, and
portable soil type converge in both directions between OSI OS and OSI Server.

**Scope:** Task 8, row 1 of the AgroLink edge/cloud parity orchestrator. This
plan does not include schedules, irrigation calibration, device assignment,
device configuration, history, or the remaining account workflows.

## Verified starting point

The canonical edge routes are:

- `POST /api/irrigation-zones`
- `DELETE /api/irrigation-zones/:id`
- `PUT /api/irrigation-zones/:zone_id/config`
- `PUT /api/irrigation-zones/:zone_id/location`

`irrigation_zones.soil_type` is the portable soil-profile setting. The detailed
SoilHive profile returned by OSI Server's
`GET /api/v1/irrigation-zones/{zoneId}/soil-profile` is derived cloud data. It
is advisory and read-only, not canonical edge state.

The current implementation has four convergence defects:

1. The edge has only an `AFTER UPDATE` zone outbox trigger. A locally inserted
   zone does not emit `ZONE_UPSERTED`.
2. The legacy pending-command flow writes zone SQL without checking the
   command's base version. An update that changes zero rows can still receive a
   success ACK.
3. OSI Server uses desired state only for zone configuration. Create, delete,
   and location issue raw commands, and pending creates disappear after the
   create response until the edge mirror arrives.
4. Cloud zone authorization still assumes one global user identity. The
   selected gateway's `local_user_uuid` is not used for cloud-originated zone
   creation, and `GatewayScopeService` identifies owned zones by comparing that
   local UUID with the cloud user's global UUID.

## Resolved design

### Portable and cloud-only fields

The portable zone aggregate is:

- `zone_uuid`
- `name`
- `gateway_device_eui`
- `timezone`
- `latitude`
- `longitude`
- `phenological_stage`
- `calibration_key`
- `crop_type`
- `variety`
- `soil_type`
- `irrigation_method`
- `area_m2`
- `irrigation_efficiency_pct`
- `scheduling_mode`
- `prediction_card_enabled`
- `notes`
- `sync_version`
- `deleted_at`
- the edge owner identity under `user.user_uuid`

`weather_source` remains cloud-only because the edge schema and canonical edge
routes do not own it. The cloud response may display it, but it must not be part
of the desired payload used to decide edge convergence.

SoilHive horizons, hydraulic properties, dataset references, refresh status,
and warnings remain cloud-derived and read-only. Missing hydraulic values render
as unavailable; the UI must not turn missing values into zero.

### Version and effect protocol

The protected command forms are `UPSERT_ZONE`, `DELETE_ZONE`,
`UPSERT_ZONE_CONFIG`, and `UPSERT_ZONE_LOCATION`. Each protected payload has:

- `command_id`: logical UUID
- `command_type`: exact command type
- `effect_key`: exact resource/base binding
- `zone_uuid`
- `gateway_device_eui`
- `base_sync_version`
- `target_sync_version`, exactly `base_sync_version + 1`
- `zone`: the command-specific canonical snake-case resource object

`UPSERT_ZONE`, `UPSERT_ZONE_CONFIG`, and `UPSERT_ZONE_LOCATION` bind to
`zone:<zone_uuid>:<base_sync_version>`. `DELETE_ZONE` binds to
`zone_delete:<zone_uuid>:<base_sync_version>`.

Using one `zone:` effect family for all non-delete edits is deliberate. OSI
Server will produce a full `UPSERT_ZONE` aggregate for both the config and
location endpoints. `DesiredStateService` can then coalesce an unleased config
edit and location edit into one command at one base version. This avoids the
known race where the current modal sends config and location sequentially while
both still observe the same canonical version.

The edge helper accepts only the protected shape. Legacy commands without the
protected envelope continue to the existing route during rolling deployment.
OSI Server emits the protected shape only for a linked account advertising
`zone_desired_state_v1`.

### Edge transaction

A new `osi-zone-commands` module owns protected zone application. In one SQLite
transaction it:

1. validates command identity, effect binding, gateway binding, finite numeric
   fields, and `target = base + 1`;
2. loads the canonical row and checks its exact `sync_version`;
3. inserts or updates the zone with bound parameters;
4. for delete, detaches assigned devices before tombstoning the zone;
5. relies on canonical triggers to enqueue zone and device events;
6. records the terminal command result in `applied_commands`; and
7. enqueues the terminal ACK in `command_ack_outbox`.

Create requires base `0`, target `1`, no existing zone UUID, and a local user
matching `zone.user.user_uuid`. Update and delete require an existing row whose
gateway and version match. A stale or future base receives `CONFLICT` with the
current version. Invalid identity, gateway, payload, or missing parent receives
`REJECTED_PERMANENT`. A database failure receives `FAILED_RETRYABLE` and leaves
the canonical mutation and terminal ledger absent.

Exact command-ID replay and equivalent effect replay return the stored terminal
result without applying the mutation again.

### Cloud authorization and pending state

For edge-backed zones, OSI Server resolves `GatewayScope` from the authenticated
cloud user and the zone's gateway. Viewer memberships are read-only.
Researchers and admins may create. Existing-zone mutation additionally requires
owned or granted zone access.

Owned-zone calculation compares the mirrored zone's associated cloud user ID
with the authenticated cloud user ID. It does not compare the gateway-local UUID
with the cloud-global UUID. Cloud-originated create sends the selected scope's
`local_user_uuid` plus `cloudUserId`, allowing the edge to select the correct
local owner and the returning event to associate the mirror with the existing
cloud user.

Create, aggregate update, and delete use `DesiredStateService`. A pending-create
query by creator and resource type lets `GET /api/v1/irrigation-zones` synthesize
pending zone cards until the canonical mirror exists. Once a mirrored zone with
the same UUID exists, the synthetic card is omitted. Pending deletion keeps the
canonical card visible with its desired-state status until the edge tombstone is
mirrored.

The existing config and location endpoints stay available. On capable gateways
they both build the same full portable aggregate and issue/coalesce
`UPSERT_ZONE`. On older gateways they retain their current command behavior.

## Task A: Add the missing edge create event

**Files:**

- Create `database/migrations/ordered/0035__zone_insert_outbox.sql`
- Modify `database/seed-blank.sql`
- Modify `scripts/verify-db-schema-consistency.js`
- Update all seven bundled `farming.db` files

**Test first:**

1. Add a schema verifier assertion for `trg_sync_zones_outbox_ai`.
2. Add a migration rehearsal that links a scratch edge database, inserts a
   zone, and expects one `ZONE_UPSERTED` row with the complete portable payload,
   owner UUID, gateway EUI, and sync version `1`.
3. Run the focused test and preserve the red result before implementation.

**Implementation:**

1. Add an additive `AFTER INSERT` trigger in migration `0035`.
2. Add the same trigger to the fresh seed.
3. Apply the migration to the six canonical bundled databases, then copy the
   bcm2712 full-profile database over the bcm2709 mirror.
4. Regenerate `CHECKSUMS.json` using the repository's migration manifest tool.
5. Do not modify the frozen boot DDL node.

**Verification:**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/test-journal-schema.js
```

## Task B: Specify protected zone commands

**Files:**

- Modify `docs/contracts/sync-schema/commands.schema.json`
- Modify `docs/contracts/sync-schema/resources.schema.json`
- Modify `docs/contracts/sync-schema/operations.json`
- Modify the matching contract tests and verifiers under `scripts/`
- Modify `docs/sync/edge-cloud-contract.md`

**Test first:**

Add contract cases for:

- valid create at base `0`;
- valid full aggregate update;
- valid delete;
- each legacy zone command remaining accepted as a staged compatibility form;
- target not equal to base plus one;
- effect key bound to another UUID or base;
- camel-case-only protected payload;
- unknown portable field;
- missing local owner on create; and
- non-finite latitude, longitude, area, or efficiency.

The activation sequence is edge implementation, server vendoring, then paired
operation activation. No producer is enabled while the operation is staged.

## Task C: Implement `osi-zone-commands`

**Files:**

- Create
  `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js`
- Create its focused test beside the module
- Mirror the module under the bcm2709 profile
- Modify both `osi-command-ledger/index.js` copies and tests
- Modify `conf/.../usr/share/node-red/osi-lib/index.js` in both profiles
- Modify helper registration, deploy coverage, and sync-flow verifiers
- Modify both `flows.json` files with one one-shot Node transformer

**Test first:**

Use a real SQLite scratch database to cover:

- create, update, config, location, and delete success;
- create owner missing;
- missing zone on update/delete;
- wrong gateway;
- stale base and future base;
- exact replay;
- same effect under a different delivery ID;
- same version with different desired payload;
- rollback after an injected write failure;
- delete detaches devices;
- terminal ACK facts and applied sync version; and
- a legacy no-effect command returning `handled: false`.

Extend command-ledger tests for the two zone effect grammars before changing the
validator.

**Flow edit:**

Add `Apply Zone Command` after `Apply Scoped Access Command` and before the
legacy `Route Command` node. It loads the helper through
`osiLib.require('zone-commands')`, passes the trusted pending-command envelope,
and routes unhandled legacy commands unchanged.

The transformer must first parse and stringify each flow file byte-identically,
pin the current node IDs and hashes, make the bounded edit, prove the two
profiles identical, and prove a second application is byte-identical.

## Task D: Advertise and ingest the capability

**Edge files:**

- Modify the local-sync/bootstrap capability construction in both flow profiles
- Modify its focused tests and `scripts/verify-sync-contract.js`

**Server files:**

- Create
  `backend/src/main/resources/db/migration/V2026_07_24_001__zone_desired_state_capability.sql`
- Modify `LinkedGatewayAccount`
- Modify `LinkedGatewayAccountService`
- Modify linked-account response DTOs and tests

Advertise `zone_desired_state_v1` only from an edge image that contains the
registered helper and protected contract. Persist the advertised fact per linked
gateway account. The server must not infer support from build version.

## Task E: Make server zone mutation convergent

**Files:**

- Create `backend/src/main/java/org/osi/server/zone/ZoneMutationService.java`
- Modify `IrrigationZoneController`
- Modify `GatewayScopeService`
- Modify `DesiredStateOperationRepository`
- Modify `DesiredStateService`
- Modify zone, scope, desired-state, command-ACK, and sync convergence tests

**Test first:**

Add failing tests for:

- pending create uses the selected gateway's local UUID and base `0`;
- viewer create is forbidden;
- researcher create is accepted;
- owner and granted researcher config/location/delete are accepted;
- an unrelated membership receives not-found;
- one cloud user has distinct local UUIDs on two gateways;
- config followed by location rewrites one unleased full-zone command;
- a leased command produces a second operation and the stale base conflicts;
- pending create appears in the list and is removed after the mirror exists;
- pending delete remains visible;
- ACK alone does not claim applied;
- matching mirror after ACK applies the operation;
- divergent mirror conflicts;
- edge `CONFLICT` exposes the recoverable conflict state;
- legacy gateways retain the pre-capability path; and
- cloud ownership works when the gateway-local UUID differs from the cloud
  user's UUID.

`ZoneMutationService` builds one canonical snake-case aggregate for desired
comparison and one strict protected envelope for command delivery. Weather
source is excluded from both. The existing local-cloud-only mutation path stays
unchanged.

## Task F: Make the frontend installation-aware and honest about missing soil data

**Files:**

- Modify `frontend/src/components/farming/CreateZoneModal.tsx`
- Add `frontend/src/components/farming/__tests__/CreateZoneModal.gateway.test.tsx`
- Modify `frontend/src/components/farming/ZoneConfigModal.tsx`
- Extend its focused tests
- Modify `frontend/src/components/farming/prediction/PredictionCard.tsx`
- Add a focused soil missing-data test
- Modify `frontend/src/services/api.ts` and desired-state API tests
- Modify the required locale files

**Test first:**

Cover:

- a single linked gateway is selected automatically;
- multiple linked gateways require an explicit selection;
- the request contains `gatewayDeviceEui`;
- a pending created zone triggers list refresh without claiming edge success;
- one aggregate update carries config and location together;
- pending and conflicted cards remain visible; and
- every absent SoilHive hydraulic value renders `—`, never `0`.

The modal uses `userAPI.getLinkedGateways()`. No linked gateway preserves the
existing cloud-local create option. The main zone configuration save uses one
aggregate API request so config and location share one versioned command.

## Task G: Activate, verify, and report

1. Vendor the edge contract into OSI Server and prove byte identity.
2. Activate the four protected command schemas and
   `zone_desired_state_v1` only after both consumers pass.
3. Run edge focused tests, contract/schema checks, migration gates,
   `verify-sync-flow.js`, profile parity, and the frontend unit/build gates.
4. Before Gradle, run the memory/swap/RSS preflight. Then run:

```bash
cd backend
NODE_OPTIONS=--max-old-space-size=2048 \
  ./gradlew test --no-daemon --max-workers=2
```

5. Before the frontend suite/build, repeat the memory preflight and set
   `NODE_OPTIONS=--max-old-space-size=2048`.
6. Update
   `docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-matrix.md`
   and the execution report with exact commands, counts, commit SHAs, and
   observed convergence evidence.
7. Mark the row `parity` only if:
   - local create/update/location/config/delete mirror to the cloud;
   - cloud create/update/location/config/delete apply at the edge;
   - ACK plus mirror convergence reaches `applied`;
   - stale versions reach `conflicted`;
   - old gateways keep their existing behavior; and
   - the detailed SoilHive profile remains explicitly cloud-derived.

Commit and push in this order:

1. edge insert-trigger repair;
2. edge protected command consumer and staged contract;
3. server capability ingestion and protected producer;
4. paired contract activation;
5. frontend installation/pending/missing-data UX;
6. matrix and execution evidence.

Each commit stages explicit files only. After each push, compare the remote branch
SHA with the local commit SHA.

## Adversarial self-review

The initial idea of issuing separate versioned config and location commands was
rejected: the current modal sends both before the mirror advances, so the second
command would share a stale base. Full-aggregate `UPSERT_ZONE` coalescing removes
that deterministic conflict.

Adding only a protected command helper was rejected: it would fix cloud-to-edge
mutation but leave local create absent from edge-to-cloud event delivery. The
insert trigger is a prerequisite for honest two-way parity.

Using the cloud user's global UUID as the edge owner was rejected: one cloud
account may map to a different local UUID on every gateway. The selected
`GatewayScope.localUserUuid` is the only valid command-side owner identity.

Comparing a mirrored zone owner to `GatewayScope.localUserUuid` was rejected
because the server associates mirrored zones with a cloud `User` entity. The
scope check must compare that cloud user association, while command payloads
continue to carry the gateway-local UUID.

Including `weather_source` in desired convergence was rejected because it has
no canonical edge field. Doing so would leave operations permanently pending or
conflicted even when every portable field converged.

Treating missing SoilHive values as zero was rejected because zero is a valid
measurement. The cloud UI must preserve the distinction between absent and
measured zero.

No production server, live gateway, SMB mount, recovery key service, or external
storage is required or permitted for this slice.
