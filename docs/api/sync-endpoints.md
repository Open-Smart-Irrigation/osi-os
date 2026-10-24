# Sync REST endpoints, MQTT topics and gateway telemetry

Reference detail for the edge side of the sync transport. It moved out of
`AGENTS.md` on 2026-10-22 so that harnesses which read only the start of that
file still receive its binding rules; `AGENTS.md` keeps the transport rules and
a short summary, and this page carries the same authority. The contract itself
lives in [`docs/contracts/sync-schema/`](../contracts/sync-schema/README.md).

## REST endpoints the edge calls

| Endpoint | Method | Purpose | Cadence |
|----------|--------|---------|---------|
| `/auth/local-sync` | POST | Account link + sync token | On-demand |
| `/auth/refresh-sync` | POST | Refresh sync token | Hourly |
| `/api/v1/sync/edge/bootstrap` | POST | Full state snapshot upload | Every 6 h |
| `/api/v1/sync/edge/events` | POST | Outbox event delivery | Every 30 s |
| `/api/v1/sync/gateways/{eui}/pending-commands` | GET | Pull cloud-originated commands | Every 30 s |
| `/api/v1/sync/gateways/{eui}/command-acks` | POST | Command ACK batch | Every 30 s |
| `/api/v1/sync/edge/history/batches` | POST | Durable history batch | Every 30 s |
| `/api/v1/sync/edge/history/manifests` | POST | History manifest | Every 300 s |
| `/api/v1/sync/gateways/{eui}/environment-bundles` | GET | Zone environment | On-demand |

`/api/v1/sync/gateways/{eui}/status` and `/reconciliation` are cloud diagnostics; the edge never calls them, nor the legacy `/api/v1/devices/claim-bulk`.

## Cloud to edge command types

Delivered via pending-commands:
`UPSERT_ZONE`, `DELETE_ZONE`, `UPSERT_SCHEDULE`, `UPDATE_SCHEDULE`, `UPSERT_ZONE_CONFIG`, `UPSERT_ZONE_LOCATION`, `ASSIGN_DEVICE_TO_ZONE`, `REMOVE_DEVICE_FROM_ZONE`, `UPSERT_DEVICE_FLAGS`, `UNCLAIM_DEVICE`, `SYNC_LINKED_AUTH`, `FORCE_EDGE_SYNC`, `VALVE_COMMAND`, `SET_LSN50_*`, `SET_KIWI_*`, `SET_STREGA_*`, `SET_FAN`, `REBOOT`, `REGISTER_DEVICE`, `UPSERT_ZONE_NAME`, `UPSERT_DEVICE_NAME`.

WATERMARK cloud parity adds four protected exact-base commands:
`SET_WATERMARK_CALIBRATION`, `DELETE_WATERMARK_CALIBRATION`,
`SET_CHAMELEON_CONFIG`, and `UPSERT_DEVICE_SOIL_DEPTHS`. An applied write stays
pending until both the authoritative acknowledgement and mirror convergence
arrive, in either order. A definitive non-application acknowledgement settles
without mirror convergence. The cloud never updates the confirmed edge-owned
value when it queues a command. Effect keys, base rules and deploy order:
[WATERMARK cloud parity](../sync/watermark-cloud-parity.md).

`UPSERT_ZONE_NAME` and `UPSERT_DEVICE_NAME` are applied by
`entity-name-command-apply-fn`. Cloud main does not issue them yet; when it
does, only to a gateway that reported `entity_name_commands_v1`.

## Edge rename routes

Local dashboard to gateway, HMAC bearer:
`PUT /api/irrigation-zones/:id/name` answers
`200 { id, zone_uuid, name, sync_version, changed }`, and
`PUT /api/devices/:deveui/name` answers
`200 { deveui, name, sync_version, changed, chirpstack }` with `chirpstack` in
`updated` / `failed` / `skipped`. Both answer `400 { message, reason }` with a
reason code from the shared name rule in `osi-entity-name`, which is also what
zone create, device create, `REGISTER_DEVICE` and both `UPSERT_ZONE` paths
apply. The `chirpstack` update is best effort, and its read and its write share
one 5 s gRPC budget instead of the 20 s default: a ChirpStack that accepts the
connection and never answers costs the caller five seconds in total, not five
per call.

## Sync capabilities the edge reports

Built identically by `sync-bootstrap-build`, `al-link-build-req` and
`sync-force-build`: `linked_auth_sync_v1`,
`force_edge_sync_v1`, `installation_recovery_v1`, `installation_locations_v1`,
`entity_name_commands_v1`, `zone_config_weather_source_v1`,
`zone_config_stage_started_on_v1`, `watermark_v1`,
`chameleon_config_commands_v1`, `device_soil_depth_commands_v1`, and
`field_journal_v1` when the journal is enabled. `watermark_v1` covers the
calibration resource, its set/delete commands, snapshots, and events. The other
two tokens independently gate their named exact-base device commands. The cloud
reads the list as `gatewayIdentity.syncCapabilities()`. It puts `weatherSource`
into `UPSERT_ZONE` and `UPSERT_ZONE_CONFIG` only for a gateway that reported
`zone_config_weather_source_v1`, and `stageStartedOn` only for one that
reported `zone_config_stage_started_on_v1`. The edge itself, on every zone
update event and in the bootstrap and force-sync snapshots, sends `weather_source` only when the stored value is not
`auto` or (update event only) changed in that update, never as an unconditional
default -- see "Zone weather_source" in `docs/contracts/sync-schema/README.md` and
the deploy-order note there. `stage_started_on` is an ordinary zone field: every
zone update event and both snapshots carry it, null when unset (see "Zone
`stage_started_on`" in the same README).

## MQTT broker and topics (edge to cloud only)

Broker: `${OSI_CLOUD_BROKER_URL}` in the "OSI Cloud Broker" node, set by
`node-red.init` from `osi-server.cloud.mqtt_broker_url`, else
`wss://<osi-server.cloud.server_host>/mqtt`, else the default
`wss://server.opensmartirrigation.org/mqtt`.

The topic table stays in `AGENTS.md`.

## Heartbeat error counters

Error-counter heartbeat fields: catch nodes feed `Record Error` (`global.error_counts`); `Gather Edge Health` copies them into `edge_health`, and the heartbeat carries `health.errors_total` / `health.errors_last_at`.

## Fan telemetry/control

Gateway stats expose `fan_available`, `fan_mode`, `fan_value`, and `fan_max`; cloud fan control arrives as `SET_FAN`. Fan detection/control prefers the `pwmfan` hwmon device (`/sys/class/hwmon/*/pwm1`, `pwm1_enable`; the Pi 5 image enables it through `dtparam=cooling_fan=okay` and `kmod-hwmon-pwmfan`) and falls back to raw `/sys/class/pwm/pwmchip2/pwm3` only when no `pwmfan` hwmon exists; raw writes fail with `EBUSY` while the driver owns the channel.

## Gateway health persistence

The same CPU/memory/load/fan facts the 60 s heartbeat reports are also persisted locally (osi-os #68) via its own 60s inject `gateway-health-sample-tick`: `gateway_health_samples` (raw, default 14 d) and `gateway_health_hourly` (min/mean/max rollups, default 365 d) in `/data/db/farming.db`, written by the `Persist Gateway Health` node and rolled up + pruned daily at 02:10 by `Gateway Health Rollup`. Includes the best-effort `get_throttled` bitfield. Schema: `database/migrations/ordered/0002__gateway_health.sql`; local-only (not cloud-synced) in v1. Operator guide: [edge-history-retention.md](../operations/edge-history-retention.md).
