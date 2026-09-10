# Installation location and radio readiness plan

Status: phase 0 design record. This file authorizes no implementation or deployment.
It defines the smallest edge contract needed by the network observations work in
`network-observations-v1`.

## Verified integration points

The edge baseline is `492935d3e6d43378be52620efff54fa42e619844`. The paired server
worktree is `/home/phil/Repos/osi-server/.worktrees/network-observations-v1`.

| Concern | Current edge integration | Constraint for this slice |
|---|---|---|
| Gateway position | `database/seed-blank.sql` and `database/migrations/ordered/0001__baseline.sql` define `gateway_locations`; `flows.json` nodes `get-gateway-location-http`, `get-gateway-location-by-id-http`, `get-gateway-location-auth-fn`, `get-gateway-location-db`, and `get-gateway-location-format-fn` read it. | Keep this table and its gpsd writer authoritative. No gateway location revision table or manual gateway writer. |
| Gateway sync | `trg_gateway_locations_outbox_ai` / `_au` emit `GATEWAY_LOCATION_UPSERTED`; the cloud applies it in `backend/src/main/java/org/osi/server/sync/GatewayLocationApplier.java`. | A receiver snapshot may copy gateway coordinates, `sync_version`, status, and fix time as historical evidence. It must never become a second gateway authority. |
| Device identity | `devices.deveui`, `devices.gateway_device_eui`, `installation_identity`, and `osi-installation-helper/index.js` provide device and installation identity/recovery semantics. | Key revisions by normalized DevEUI and carry the existing `installation_uuid`; do not create a producer epoch or alternate identity. |
| Zone coordinates | `irrigation_zones.latitude` / `longitude`; `PUT /api/irrigation-zones/:zone_id/location`; `irrigationZonesAPI.setZoneLocation`; `ZoneConfigModal` plus `services/deviceLocation.ts`. | Preserve zone fallback as a read-time approximation. It cannot write a confirmed device position. |
| Device API and access | Device routes live in the `device-api-tab` portion of `conf/.../flows.json`; scoped mode uses `osi-scope-helper` / `scope` and `assertFreshDeviceAccess`. | New reads and writes must use the same bearer and scope resolver. Viewers read; only admin/researcher with device scope write. |
| Cloud command intake | `sync-worker` polls `/api/v1/sync/gateways/{eui}/pending-commands`; the pending envelope is routed through the command dispatch in `flows.json`. | Use REST pending commands. Never add an MQTT cloud-to-edge path or put cloud user tokens on the Pi. |
| Contracts | Edge-owned `docs/contracts/sync-schema/{events,commands,resources}.schema.json`, `effect-keys.md`, and `canonicalization.md`; server vendors these under `backend/src/test/resources/sync-contract/`. | Update edge contracts first, then byte-identical server vendors and golden fixtures in a paired change. |
| Terra | Server `terra-intelligence/src/.../useDevicePlacements.ts` and `TerraDeviceAnchorWriteService` use legacy analytical anchors. | Do not read, write, fingerprint, or migrate Terra anchors from the edge slice. |

The current GUI has no device installation location editor. `Device` in
`web/react-gui/src/types/farming.ts` has no location or radio revision fields;
`web/react-gui/src/services/api.ts` only exposes zone location writes. The existing
`ZoneConfigModal` device-location button captures browser/native coordinates for a
zone and must not be repurposed to claim an installed device location.

## Minimal edge schema

Installation revisions belong in `farming.db`. High-volume `radio_uplinks` and
receiver arrays belong in the separately designed `/data/db/radio.db`; this plan
does not duplicate that stream or add a foreign key from `device_data`.

Add one ordered additive migration, allocated after rechecking the current main
migration head. The migration must add these tables and indexes to the seed and
both bundled profile databases through the normal schema workflow. The exact
logical schema is:

```sql
device_installation_location_revisions(
  revision_uuid TEXT PRIMARY KEY,                 -- canonical UUID v4, lower-case
  device_eui TEXT NOT NULL,                       -- uppercase 16 hex
  installation_uuid TEXT NOT NULL,                -- existing installation identity
  source_gateway_device_eui TEXT,                 -- uppercase 16 hex or NULL
  base_revision_uuid TEXT,                        -- nullable for initial create
  revision_no INTEGER NOT NULL,
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  altitude_m REAL,
  vertical_reference TEXT,                        -- NULL or declared reference
  accuracy_m REAL,
  antenna_height_agl_m REAL,
  coordinate_source TEXT NOT NULL,                -- field, device_gps, manual
  effective_from TEXT NOT NULL,                   -- canonical UTC timestamp
  recorded_at TEXT NOT NULL,                      -- canonical UTC timestamp
  actor_user_uuid TEXT,                           -- NULL for local legacy mode
  supersedes_revision_uuid TEXT,
  sync_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CHECK(accuracy_m IS NULL OR accuracy_m >= 0),
  CHECK(antenna_height_agl_m IS NULL OR antenna_height_agl_m >= 0)
)

device_radio_configuration_revisions(
  revision_uuid TEXT PRIMARY KEY,
  device_eui TEXT NOT NULL,
  installation_uuid TEXT NOT NULL,
  base_revision_uuid TEXT,
  revision_no INTEGER NOT NULL,
  tx_power_dbm REAL,
  antenna_gain_dbi REAL,
  feeder_loss_db REAL,
  configuration_source TEXT NOT NULL,             -- device, label, manual, unknown
  effective_from TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_user_uuid TEXT,
  supersedes_revision_uuid TEXT,
  sync_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
)
```

`device_eui` and `installation_uuid` must be validated against the existing
`devices` and `installation_identity` semantics at write time. Add indexes on
`(device_eui, effective_from)`, `(installation_uuid, device_eui, effective_from)`,
and the open interval lookup. The writer must reject overlapping effective
intervals for one device, except when explicitly closing the prior interval in
the same transaction. A correction creates a new revision at the same effective
time and points `supersedes_revision_uuid` at the old assertion. Resolvers exclude
superseded rows while retaining them for audit; no prior row is updated. The
per-device `revision_no` is monotonic and `base_revision_uuid` is nullable only
for an initial create.

Null radio values mean unknown. Do not infer TX power, gain, feeder loss, altitude,
or antenna height from device type, zone data, or Terra anchors. Probe depth remains
the existing soil configuration and is not an antenna measurement.

## Sync resources and command shape

Register these aggregate types in the edge-owned resource contract:

- `DEVICE_INSTALLATION_LOCATION`, keyed by `revision_uuid`, with the exact location
  columns above and canonical snake_case JSON names.
- `DEVICE_RADIO_CONFIGURATION`, keyed by `revision_uuid`, with the exact radio
  columns above.

Register `DEVICE_INSTALLATION_LOCATION_UPSERTED` and
`DEVICE_RADIO_CONFIGURATION_UPSERTED` in `events.schema.json`. Both are low-volume
`PROTECTED` outbox resources. Their SQLite triggers must emit only after the local
transaction commits, use the row's `sync_version`, and include
`installation_uuid`, `device_eui`, `gateway_device_eui` where applicable, and all
nullable values. Add the aggregate types to the migration-owned outbox allowlist
and retention verifier. Do not register these rows with the `radio_uplinks` history
table or create a second history cursor.

Add these pending command types to `commands.schema.json`:

- `UPSERT_DEVICE_INSTALLATION_LOCATION`
- `UPSERT_DEVICE_RADIO_CONFIGURATION`

Each pending envelope carries the existing numeric `commandId`, `commandType`,
and delivery metadata. Its payload carries `command_id`, `command_type`,
`device_eui`, `installation_uuid`, `revision_uuid`, nullable `base_revision_uuid`,
`actor_user_uuid`, and a `values` object. The cloud derives the installation and
local actor from the linked gateway account. `effect_key` is respectively
`device_installation_location:<revision_uuid>:<base_revision_uuid|initial>` and
`device_radio_configuration:<revision_uuid>:<base_revision_uuid|initial>`.
The literal `initial` denotes a null base. UUID compare-and-swap matches the edge
revision head; a numeric sync version is not a command base.

The edge rejects absent or deleted devices, stale bases, foreign installations,
and actors without current mutation rights. A replay returns the stored result.

The edge command handler writes the local revision and outbox event in one SQLite
transaction, then returns the existing ACK shape. It validates only edge facts:
DevEUI, installation identity, interval consistency, numeric bounds, and current
device assignment. It does not receive or validate a cloud Terra inventory
fingerprint. Cloud-side geometry and anchor eligibility remain cloud decisions.

Advertise one capability, `installation_locations_v1`, through the existing
snake_case `syncCapabilities` field only after the edge handler, schemas, migration,
and golden vectors are shipped together. Do not advertise a radio capability for
the high-volume history stream.

## Edge API and GUI surface

Add authenticated routes in the device API tab:

- `GET /api/devices/:deveui/installation-location` returns the current resolved
  revision plus an `asOf` value and `source`; missing coordinates return explicit
  nulls and `source: "unknown"`.
- `GET /api/devices/:deveui/installation-location/revisions` returns the bounded
  revision list for an authorized device.
- `PUT /api/devices/:deveui/installation-location` creates a revision and accepts
  only the location fields. It must require `base_revision_uuid` when a current
  revision exists.
- `GET /api/devices/:deveui/radio-configuration` returns the effective radio
  revision, preserving null unknowns.
- `PUT /api/devices/:deveui/radio-configuration` creates a radio revision under
  the same version and authorization rules.

The service boundary belongs in `web/react-gui/src/services/api.ts`; types belong in
`web/react-gui/src/types/farming.ts`. Add an Installation section to the existing
device detail/editor surface, with a revision history link, explicit source and
as-of time, conflict response handling, and an unavailable state. Keep the zone
location editor and its `Use device location` flow unchanged. Add locale keys to
`en`, `de-CH`, `fr`, `it`, `es`, `pt`, and `lg`. Do not expose raw payloads, foreign
device metadata, credentials, or Terra anchor fields.

The map/read model may show `confirmed_device`, `zone_fallback`, or `unknown`.
Only `confirmed_device` comes from these revisions. `zone_fallback` reads the
existing zone coordinates at query time and must display that it is approximate;
it is never persisted as a device revision.

## Scoped permissions

In scoped mode, reads require an enabled account and fresh device access. Writes
require `admin` or `researcher` plus fresh access to that exact device; `viewer`
gets 403. A gateway-wide list is admin-only and must filter to devices visible to
the actor. Unknown or unassigned devices are admin-only. Disabled accounts and
deleted devices fail closed. In legacy mode, call the established legacy
authorization path and record that compatibility explicitly in tests; do not
invent a project role on the edge.

The required matrix covers scoped and legacy flags, admin/researcher/viewer,
own/foreign device, disabled account, deleted device, unassigned device, stale
base version, and duplicate command. The same decisions must hold for REST writes,
pending-command application, and list/read routes.

## Migration and acceptance gates

Implementation must use an additive ordered migration, update `seed-blank.sql`,
both full Raspberry Pi bundled DB copies, and the migration fingerprint. It must
not touch the frozen `sync-init-fn` schema block, rebuild `devices`, alter
`gateway_locations`, or modify Terra tables. No destructive migration or backup
fence is expected for these new tables.

Before implementation is accepted, run from the edge worktree:

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-op-parity.js
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
cd web/react-gui && npm run typecheck && npm run test:unit && npm run build
```

The paired server change must vendor the five edge contract files and add schema,
golden-vector, command-applier, stale-version, scope, and gateway-authority tests;
run its focused sync tests and `./gradlew test`. A production-copy rehearsal must
prove that applying a revision preserves prior rows, rejects an overlap, retries
idempotently, and leaves `gateway_locations` unchanged.

The phase gate is met only when a test gateway can create, read, sync, and replay a
device location and radio revision; a stale cloud command is rejected; missing
coordinates remain null; receiver snapshots still identify the historical gateway
fix; and the legacy Terra anchor path produces the same result before and after the
slice.


## Integration clarifications

Revision heads and current/history reads are scoped to the active installation.
`revision_no` remains monotonically increasing per device across installations to
preserve the existing `(device_eui, revision_no)` uniqueness rule. A new
installation starts with a null base UUID even if retained rows from a previous
installation exist. Such rows cannot supply the current position snapshot.

The network API checks each device’s explicit gateway against the active local
identity before applying zone or shared-weather rules. A null legacy gateway
binding remains local; an explicit foreign binding is denied. Observation queries
also require the active installation UUID.
