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
| Zones, zone configuration, and zone location | `partial` | Edge APIs, outbox operations, and pending command handlers exist; cloud optimistic desired-state and conflict behavior remain incomplete | Tasks 4 and 8 |
| Irrigation schedules | `partial` | Edge schedule mutations and cloud pending commands exist; current route, field, version, and conflict parity require inventory | Tasks 4 and 8 |
| Device provisioning and registration | `partial` | Bootstrap, registration, bulk claim, assignment, and command paths exist; authorization and six-family parity remain | Tasks 7 and 8 |
| Device assignment, flags, configuration, and unclaim | `partial` | Multiple pending command types exist; Task 0 must map device-family coverage and authorization | Tasks 7 and 8 |
| Journal entries | `cloud-missing` | Edge storage, UI, five event operations, and five command handlers exist; full server mirror/API/UI/issuer does not | Task 5 |
| Farm history mirror | `partial` | Legacy durable delivery remains; the new batch mapper covers `device_data` only | Task 9 |
| Analysis and recommendations | `partial` | Both repositories contain analysis surfaces; input, scope, missing-data, and result semantics need route-level comparison | Task 8 |
| Account scope and per-gateway grants | `partial` | Task 1 reconciled the governing model and Phase A rebase instructions; implementation, Phases B-D, and server enforcement remain open | Tasks 3, 6, and 7 |
| Cloud access administration | `cloud-missing` | Task 1 now governs this as durable desired state plus versioned edge-applied commands; implementation remains in Tasks 4 and 7 | Tasks 4 and 7 |
| Installation recovery | `cloud-missing` | No stable `installation_uuid` recovery model or encrypted recovery bundle exists | Task 10 |
| Optimistic zone and journal edits | `cloud-missing` | UX decision is immediate local desired state with background sync; durable state machine is not complete | Tasks 4 and 5 |

## Deliberate product split

| Surface | Status | Reason |
|---|---|---|
| ChirpStack bootstrap and local device-server administration | `edge-only` | Requires gateway hardware and local services |
| Local network and AgroLink network-drive transport | `edge-only` | Final design and plan are boundary inputs; future tables and imported readings do not enter sync |
| Fan, filesystem, database download, and firmware controls | `edge-only` | Gateway operations, not portable farm workflows |
| Fleet administration and server operations | `cloud-only` | Cross-installation operational scope |
| Encrypted recovery storage | `cloud-only` | Server custody; restored state still becomes edge-canonical |
| Incremental bootstrap snapshots | `deferred` | Existing plan defers until scale or measured load justifies the complexity |
| Schema-driven DTO generation | `deferred` | Superseded by the narrow schema/contract ownership ADR; do not execute |
| Legacy history-path removal | `deferred` | Requires maintainer approval after the durable batch path converges |

## Contract and catalog baseline

- The launch-head edge flow contains 17 active event operation strings.
- The edge seed and server operation mirror contain 18 operation strings.
- The governed event schema contains 23 operation strings.
- Five journal operations are intentionally staged but not enabled for cloud
  production until server acceptance is proven.
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

The governed schema contains 23 operations:

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
WORK_REQUEST_SUBMITTED
ZONE_CONFIG_UPSERTED
ZONE_DELETED
ZONE_ENVIRONMENT_APPENDED
ZONE_LOCATION_UPSERTED
ZONE_RECOMMENDATION_UPSERTED
ZONE_UPSERTED
```

The five journal operations are `cloudDeferred`. The other 18 match the server
operation mirror. The runtime flow emits 17 because
`WORK_REQUEST_SUBMITTED` is seed/module-owned.

### Command operations

The governed schema contains 40 command types:

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
```

The five journal commands are `cloudDeferred`. `UC512_OPEN_FOR_DURATION` stays
schema-compatible but is excluded from the supported catalog.

### Resource schemas

The resource file contains 18 domain definitions after excluding UUID,
timestamp, and EUI primitives:

```text
Zone
Device
Schedule
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

The edge currently advertises `linked_auth_sync_v1` and
`force_edge_sync_v1` during account link and bootstrap. No capability yet
distinguishes schema acceptance from event production or command issuance;
Task 2 owns that gap. The edge system-feature response separately exposes
history feature flags and keeps the journal UI flag off until Task 5.

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
