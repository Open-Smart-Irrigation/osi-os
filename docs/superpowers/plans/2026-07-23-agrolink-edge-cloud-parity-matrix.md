# AgroLink edge/cloud parity matrix

This matrix records the Task 0 launch inventory. Counts and classifications
come from the fetched integration heads, not the earlier planning audit.

**Launch heads (2026-07-23):**

- OSI OS `design-sync/agrolink`: `6a4271b0d502cab0bdcdba76b1eb0353e49fcce9`
- OSI OS `origin/main` and merge base: `b31825becbb8abcef86cfad9dc756cd2e351f135`
- OSI Server `AgroLink`: `3179df875204ac2c9d38e6d9c96cb2beaa15a1b4`
- OSI Server `origin/main` and merge base:
  `8cac33d3a8a210784fa5f9b73c8e4dfe796203f7`

## Accepted slices

| Task | Result | Commit |
|---|---|---|
| 0 | Launch inventory recorded; stale server frontend manifest pin repaired and all baseline suites passed | Edge `ed89dc010cfcccfea001b81583a0690608d1c3d9`; server `3179df875204ac2c9d38e6d9c96cb2beaa15a1b4` |
| 1 | Scoped authority, per-gateway cloud membership, dynamic migration allocation, and the accepted user-version contract reconciled in governing documents | Edge `459cf73f010a390c10b6dbb707de891f0179775e` |
| 2 | Edge-owned sync contracts, golden rollout metadata, byte-identical server vendors, and drift gates landed | Edge `8a06e630bd9dadc315c917f18850a19a1959e930`; server `04e60bf669cfd02c4ac756ddf956b8b8acefa8bf` |
| 3 | Scoped edge schema, scope helper, authentication, feature flag, and `/api/me` landed with migration and replay coverage | Edge `1f6f0933` through `4eb05522` |
| 4 | Durable cloud desired state, ACK and mirror convergence, zone-config overlay, and conflict handling landed | Server `7c009dad` through `b86473e8` |
| 5 | Journal mirrors, commands, exports, UI, and contract activation landed | Edge `6fd5d7fd`, `af274c9c`, and `9a2bcb09`; server `4bf1c67c` through `1c953c77` |
| 6 | Scoped edge reads, writes, physical effects, administration, and read-only GUI enforcement landed | Edge `31fd939d` through `b4b6c1a8`; report `0e5319a0` |
| 7 | Per-gateway cloud membership, scoped mirrors, authorization, desired access commands, edge application, administration UI, and contract activation landed | Edge `b4cb078c` through `0f17892f`; server `e8268566` through `5ca86425` |
| 8a | Zone create, aggregate update, location, portable configuration, and delete converge through protected desired state; legacy gateways retain their prior command path | Edge `b7787c17` through `be66dad6`; server `e860ed93` through `f83ef56a` |
| 8b | Schedules and measured irrigation calibration converge through separate protected desired-state resources; legacy gateways retain schedule compatibility and receive no calibration command | Edge `64d72f90` through `e1d487dd`; server `90b7553a` through `1d32cfc8` |

## Status rules

| Status | Meaning |
|---|---|
| `parity` | Portable behavior exists on both sides and has current evidence |
| `cloud-missing` | Portable edge behavior has no complete server counterpart |
| `edge-missing` | Portable cloud behavior has no complete edge counterpart |
| `partial` | Both sides contain part of the workflow, but semantics or coverage differ |
| `edge-only` | Deliberately hardware-local or gateway-operational |
| `cloud-only` | Deliberately fleet-wide or server-operational |
| `deferred` | Explicitly postponed with a trigger or maintainer decision |

## Portable workflow seed

| Surface | Launch status | Evidence and gap | Owning task |
|---|---|---|---|
| Gateway identity and location mirror | `partial` | Live EUI verification and server applier tests pass; complete create/update/replay parity remains in Task 8 | Task 8 |
| Zones, zone configuration, and zone location | `parity` | Local inserts now emit the complete mirror event. Capable gateways apply create, full-aggregate update, location, configuration, and delete with exact versions; cloud desired state remains visible through ACK and mirror convergence. Portable `soil_type` travels in the aggregate. | Tasks 4 and 8 |
| Irrigation schedules and measured flow calibration | `parity` | Edge changes emit versioned schedule and calibration mirrors. Capable gateways apply separate protected desired-state commands with independent effect keys; ACK and returning mirrors settle pending operations. Legacy gateways retain their schedule path and never receive calibration commands. Valve assignment and scheduler runtime timestamps remain edge-local. | Tasks 4 and 8 |
| Device provisioning and registration | `partial` | Bootstrap, registration, bulk claim, assignment, and command paths exist; authorization and six-family parity remain | Tasks 7 and 8 |
| Device assignment, flags, configuration, and unclaim | `partial` | Multiple pending command types exist; Task 0 must map device-family coverage and authorization | Tasks 7 and 8 |
| Journal entries | `parity` | Five edge events and five cloud commands are active; mirror, replay, desired-state conflict, exports, and cloud workspace suites pass | Task 5 |
| Farm history mirror | `partial` | Legacy durable delivery remains; the new batch mapper covers `device_data` only | Task 9 |
| Analysis and recommendations | `partial` | Both repositories contain analysis surfaces; input, scope, missing-data, and result semantics need route-level comparison | Task 8 |
| Account scope and per-gateway grants | `parity` | Edge owner-plus-grant enforcement and server per-gateway membership authorization pass for reads, writes, and effects; mirrors retain local user and assignment UUIDs | Tasks 3, 6, and 7 |
| Cloud access administration | `parity` | Cloud desired state queues six versioned commands; edge applies or rejects them transactionally; ACK plus mirror convergence drives pending, conflict, and rejection UI | Tasks 4 and 7 |
| Installation recovery | `cloud-missing` | No stable `installation_uuid` recovery model or encrypted recovery bundle exists | Task 10 |
| Optimistic zone edits | `parity` | Selected-gateway create, aggregate update, location, and delete use durable desired state. Pending creates remain visible, stale versions conflict, and canonical mirrors settle applied operations. | Tasks 4 and 8 |

## Deliberate product split

| Surface | Status | Reason |
|---|---|---|
| ChirpStack bootstrap and local device-server administration | `edge-only` | Requires gateway hardware and local services |
| Local network and AgroLink network-drive transport | `edge-only` | Final design and plan are boundary inputs; future tables and imported readings do not enter sync |
| Fan, filesystem, database download, and firmware controls | `edge-only` | Gateway operations, not portable farm workflows |
| Fleet administration and server operations | `cloud-only` | Cross-installation operational scope |
| Encrypted recovery storage | `cloud-only` | Server custody; restored state still becomes edge-canonical |
| Detailed SoilHive hydraulic profile | `cloud-only` | The canonical portable zone field is `soil_type`. Hydraulic catalog values are derived cloud data and are not written back to the edge aggregate. Missing values render as absent, never numeric zero. |
| Incremental bootstrap snapshots | `deferred` | Existing plan defers until scale or measured load justifies the complexity |
| Schema-driven DTO generation | `deferred` | Superseded by the narrow schema/contract ownership ADR; do not execute |
| Legacy history-path removal | `deferred` | Requires maintainer approval after the durable batch path converges |

## Contract and catalog baseline

- The current edge flow contains 17 active event operation strings.
- The edge seed contains 23 operation strings; five journal operations are
  module owned.
- The server operation mirror contains all 28 governed operations.
- The governed event schema contains 28 operation strings.
- Five journal operations and five scoped-access operations are active. The
  server operation scanner sees all 28 governed event operations.
- The edge-owned golden fixture separates schema acceptance from edge-producer
  and cloud-issuer enablement. It closes the current command ACK result
  vocabulary, with `CONFLICT` enabled for desired-state recovery.
- The supported device baseline is KIWI, TEKTELIC CLOVER, DRAGINO LSN50,
  SENSECAP S2120, AQUASCOPE LORAIN, and STREGA.
- UC512 remains schema-compatible but hidden from the supported parity catalog.

`node scripts/verify-sync-op-parity.js` produced these counts at exit 0.
`node scripts/test-contract-schemas.js` and
`node scripts/verify-sync-contract.js` also exited 0.

## Launch-head route inventory

### Edge HTTP

The canonical bcm2712 flow contains 118 `http in` nodes. The bcm2709 copy is
byte-identical under `node scripts/verify-profile-parity.js`.

```text
OPTIONS /api/*
DELETE /api/account-link
OPTIONS /api/account-link
POST /api/account-link
GET /api/account-link/status
GET /api/analysis/channels
POST /api/analysis/series
GET /api/analysis/views
POST /api/analysis/views
GET /api/catalog
GET /api/dendrometer/:deveui/daily
GET /api/dendrometer/:deveui/readings
OPTIONS /api/dendrometer/*
GET /api/devices
POST /api/devices
DELETE /api/devices/:deveui
PUT /api/devices/:deveui/chameleon
PUT /api/devices/:deveui/chameleon/depth
POST /api/devices/:deveui/chameleon/refresh-calibration
PUT /api/devices/:deveui/dendro
POST /api/devices/:deveui/dendro-baseline/reset
PUT /api/devices/:deveui/dendro-config
GET /api/devices/:deveui/dendro-history
PUT /api/devices/:deveui/flow-meter
PUT /api/devices/:deveui/kiwi/interval
POST /api/devices/:deveui/kiwi/temperature-humidity/enable
PUT /api/devices/:deveui/lsn50/5v-warmup
PUT /api/devices/:deveui/lsn50/interrupt-mode
PUT /api/devices/:deveui/lsn50/interval
PUT /api/devices/:deveui/lsn50/mode
PUT /api/devices/:deveui/rain-gauge
GET /api/devices/:deveui/rain-history
OPTIONS /api/devices/:deveui/reference-tree
PUT /api/devices/:deveui/reference-tree
GET /api/devices/:deveui/sensor-history
PUT /api/devices/:deveui/soil-moisture-depths
PUT /api/devices/:deveui/strega/flushing
PUT /api/devices/:deveui/strega/interval
PUT /api/devices/:deveui/strega/magnet
PUT /api/devices/:deveui/strega/model
PUT /api/devices/:deveui/strega/partial-opening
PUT /api/devices/:deveui/strega/timed-action
PUT /api/devices/:deveui/temp
GET /api/devices/:deveui/zone-assignments
PUT /api/devices/:deveui/zone-assignments
GET /api/gateway/location
GET /api/gateways/:gatewayEui/location
GET /api/history/gateways/:gatewayEui/cards
GET /api/history/gateways/:gatewayEui/cards/:cardId/advanced
GET /api/history/gateways/:gatewayEui/cards/:cardId/data
POST /api/history/gateways/:gatewayEui/cards/:cardId/opened
PUT /api/history/gateways/:gatewayEui/cards/:cardId/preferences
POST /api/history/rollups/run
GET /api/history/workspaces
POST /api/history/workspaces
DELETE /api/history/workspaces/:id
PUT /api/history/workspaces/:id
GET /api/history/zones/:zoneId/cards
GET /api/history/zones/:zoneId/cards/:cardId/advanced
GET /api/history/zones/:zoneId/cards/:cardId/data
POST /api/history/zones/:zoneId/cards/:cardId/opened
PUT /api/history/zones/:zoneId/cards/:cardId/preferences
GET /api/history/zones/:zoneId/export.csv
GET /api/improvement-requests
POST /api/improvement-requests
GET /api/improvement-requests/diagnostics-preview
GET /api/irrigation-zones
POST /api/irrigation-zones
DELETE /api/irrigation-zones/:id
POST /api/irrigation-zones/:id/calibration
DELETE /api/irrigation-zones/:id/devices/:deveui
PUT /api/irrigation-zones/:id/devices/:deveui
PUT /api/irrigation-zones/:id/schedule
OPTIONS /api/irrigation-zones/:zone_id/config
PUT /api/irrigation-zones/:zone_id/config
GET /api/irrigation-zones/:zone_id/environment-summary
OPTIONS /api/irrigation-zones/:zone_id/environment-summary
OPTIONS /api/irrigation-zones/:zone_id/location
PUT /api/irrigation-zones/:zone_id/location
GET /api/irrigation-zones/:zone_id/recommendations
OPTIONS /api/irrigation-zones/:zone_id/recommendations
PUT /api/irrigation-zones/:zone_id/timezone
POST /api/irrigation-zones/schedules/disable-all
GET /api/irrigation/recent-actuations
GET /api/journal/catalog
POST /api/journal/custom-vocab
PUT /api/journal/custom-vocab/:uuid
GET /api/journal/entries
POST /api/journal/entries
PUT /api/journal/entries/:uuid
POST /api/journal/entries/:uuid/void
GET /api/journal/export.adapt.json
GET /api/journal/export.csv
GET /api/journal/export.json
GET /api/journal/export.package
GET /api/journal/plot-groups
POST /api/journal/plot-groups
PUT /api/journal/plot-groups/:uuid
GET /api/journal/plots
POST /api/journal/plots
PUT /api/journal/plots/:uuid
POST /api/sync/force
GET /api/sync/state
OPTIONS /api/system/*
POST /api/system/fan
GET /api/system/features
POST /api/system/reboot
GET /api/system/stats
GET /api/v1/devices/:deveui/today-liters
POST /api/v1/valves/:deveui/cancel
POST /api/valve/:deveui
POST /api/valve/:deveui/cancel
OPTIONS /auth/*
POST /auth/login
POST /auth/register
GET /download-fieldtest
GET /download-sensordata
GET /download/database
```

### Edge GUI

The edge router exposes 14 paths:

```text
/login
/register
/dashboard
/account-link
/support-requests
/settings
/history
/analysis
/history/zones/:zoneId
/history/zones/:zoneId/cards/:cardId
/history/gateways/:gatewayEui/cards/:cardId
/
/journal
*
```

### Server controllers

The server contains 24 controller classes and 150 mapped methods. Counts below
come from Spring mapping annotations at
`3179df875204ac2c9d38e6d9c96cb2beaa15a1b4`.

| Controller | Base path | Mapped methods |
|---|---|---:|
| `AdminPredictionController` | `/api/v1/admin/prediction` | 13 |
| `AdminUserController` | `/api/v1/admin/users` | 3 |
| `AdminUserDirectoryController` | `/api/v1/admin/users` | 1 |
| `AnalysisController` | `/api/v1/analysis` | 5 |
| `AuthController` | `/auth` | 4 |
| `ChameleonCalibrationsAdminController` | `/api/v1/admin/chameleon/calibrations` | 2 |
| `ChameleonCalibrationsController` | `/api/v1/sync/chameleon/calibrations` | 2 |
| `CommandAckController` | absolute method mappings | 2 |
| `DendroController` | `/api/v1` | 7 |
| `DeviceController` | `/api/v1` | 38 |
| `EdgeSyncController` | `/api/v1/sync` | 8 |
| `ForgeController` | `/api/v1/forge/jobs` | 4 |
| `GatewayLocationController` | `/api/v1/gateways` | 1 |
| `HistoryController` | `/api/v1/history` | 16 |
| `HistoryRollupAdminController` | `/api/v1/admin/history/rollups` | 1 |
| `IrrigationZoneController` | `/api/v1/irrigation-zones` | 9 |
| `PredictionController` | `/api/v1` | 15 |
| `SpaController` | SPA fallbacks | 2 |
| `SyncDeadLetterAdminController` | `/api/v1/admin/sync-dead-letters` | 1 |
| `SyncHealthController` | `/api/v1/admin/sync-health` | 1 |
| `SystemFeatureController` | `/api/v1/system` | 1 |
| `UnlinkedWorkRequestController` | `/api/v1/support/edge/work-requests` | 2 |
| `UserController` | `/api/v1/users` | 6 |
| `WorkRequestAdminController` | `/api/v1/admin/work-requests` | 6 |

### Server GUI

The server router exposes 13 paths:

```text
/login
/register
/dashboard
/history
/history/zones/:zoneId
/analysis
/account
/devices/:deviceEui
/admin/users
/admin/devices
/admin/prediction
/admin/work-requests
*
```

## Operation and schema inventory

### Event operations

The governed schema contains 28 operations:

```text
CHAMELEON_READING_APPENDED
DENDRO_DAILY_UPSERTED
DENDRO_READING_APPENDED
DEVICE_ASSIGNED
DEVICE_DATA_APPENDED
DEVICE_FLAGS_UPDATED
DEVICE_UNASSIGNED
DEVICE_UNCLAIMED
GATEWAY_LOCATION_UPSERTED
IRRIGATION_EVENT_APPENDED
JOURNAL_ENTRY_UPSERTED
JOURNAL_ENTRY_VOIDED
JOURNAL_PLOT_GROUP_UPSERTED
JOURNAL_PLOT_UPSERTED
JOURNAL_VOCAB_UPSERTED
SCHEDULE_UPSERTED
USER_PLOT_ASSIGNMENT_DELETED
USER_PLOT_ASSIGNMENT_UPSERTED
USER_UPSERTED
USER_ZONE_ASSIGNMENT_DELETED
USER_ZONE_ASSIGNMENT_UPSERTED
WORK_REQUEST_SUBMITTED
ZONE_CONFIG_UPSERTED
ZONE_DELETED
ZONE_ENVIRONMENT_APPENDED
ZONE_LOCATION_UPSERTED
ZONE_RECOMMENDATION_UPSERTED
ZONE_UPSERTED
```

No event operation is deferred. The five journal operations are emitted by
edge modules, the five scoped-access operations by migration-owned triggers,
and the other 18 by flows or seed-owned modules. All 28 match the server
operation mirror. The runtime flow emits 17 because journal, scoped access,
and `WORK_REQUEST_SUBMITTED` are module or seed owned.

### Command operations

The governed schema contains 46 command types:

```text
OPEN_FOR_DURATION
UC512_OPEN_FOR_DURATION
SET_STREGA_TIMED_ACTION
CLOSE
VALVE_COMMAND
SET_STREGA_INTERVAL
SET_STREGA_MODEL
SET_STREGA_MAGNET_MODE
SET_STREGA_PARTIAL_OPENING
SET_STREGA_FLUSHING
SET_LSN50_MODE
SET_LSN50_INTERVAL
SET_LSN50_INTERRUPT_MODE
SET_LSN50_5V_WARMUP
SET_KIWI_INTERVAL
ENABLE_KIWI_TEMP_HUMIDITY
SET_CHAMELEON_CONFIG
REGISTER_DEVICE
REBOOT
REBOOT_DEVICE
REMOVE_DEVICE_FROM_ZONE
UNCLAIM_DEVICE
SET_FAN
FORCE_EDGE_SYNC
SYNC_LINKED_AUTH
UPSERT_ZONE
DELETE_ZONE
UPSERT_ZONE_CONFIG
UPSERT_ZONE_LOCATION
ASSIGN_DEVICE_TO_ZONE
UPSERT_DEVICE_FLAGS
UPSERT_DEVICE_SOIL_DEPTHS
UPDATE_SCHEDULE
UPSERT_SCHEDULE
WORK_REQUEST_STATUS
UPSERT_JOURNAL_ENTRY
VOID_JOURNAL_ENTRY
UPSERT_JOURNAL_CUSTOM_VOCAB
UPSERT_JOURNAL_PLOT
UPSERT_JOURNAL_PLOT_GROUP
UPSERT_SCOPED_USER
RESET_SCOPED_USER_PASSWORD
UPSERT_USER_ZONE_ASSIGNMENT
DELETE_USER_ZONE_ASSIGNMENT
UPSERT_USER_PLOT_ASSIGNMENT
DELETE_USER_PLOT_ASSIGNMENT
```

No command type is deferred. `UC512_OPEN_FOR_DURATION` stays schema-compatible
but is excluded from the supported catalog.

### Resource schemas

The resource file contains 24 domain definitions after excluding UUID,
timestamp, and EUI primitives:

```text
Zone
Device
Schedule
ScopedUser
ScopedUserCommand
UserZoneAssignment
UserZoneAssignmentCommand
UserPlotAssignment
UserPlotAssignmentCommand
JournalEntryValue
JournalEntry
JournalEntryAggregate
JournalEntryCommand
JournalVocabMapping
JournalVocab
JournalVocabAggregate
JournalVocabCommand
JournalPlotSettings
JournalPlot
JournalPlotAggregate
JournalPlotCommand
JournalPlotGroup
JournalPlotGroupAggregate
JournalPlotGroupCommand
```

### Capabilities

The golden contract records schema acceptance, edge production, and cloud
issuance independently. Journal event production and cloud issuance are
enabled. Scoped-access event production and command issuance are enabled on
their separate capability axes. Desired-state conflict handling is enabled.

## Ownership ledger

| Program/worktree | Reserved surface | Task 0 treatment |
|---|---|---|
| Parity orchestrator, `.worktrees/agrolink-parity-orchestrator-prep` | Matrix and execution report | Active owner |
| Scoped Phase A source, `.worktrees/agrolink-phase-a` | Patch material only; old migrations and scope work | Read-only until Task 3 |
| i18n review, `.worktrees/i18n-review-repairs` | Locale trees, including new Arabic files | Do not edit or stage; potential Task 6 blocker |
| Firmware builder, `.worktrees/firmware-image-builder` | `tools/firmware-image-builder/` | No overlap |
| Detached AgroLink checkout, `/home/phil/Repos/osi-os-agrolink` | Generated GUI assets and locales | Quarantined |
| Detached release checkout, `/home/phil/Repos/osi-os-agrolink-release` | Generated GUI, locales, image config | Quarantined |
| Network-drive planning | Design v3.1 and Phase 1 plan v2 | Finished; no implementation files exist |

No active worktree claims the matrix, execution report, contract schemas,
migration manifest, seed databases, scope helper, or maintained flow profiles
for Task 0. Future tasks must recheck this ledger before their first mutation.
