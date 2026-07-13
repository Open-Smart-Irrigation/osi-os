# 06 — Sync protocol

[← Edge GUI](05-dashboard-gui.md) · [Index](README.md) · [→ Cloud server](07-cloud-server.md)

Sync keeps a gateway and its cloud mirror consistent under intermittent
connectivity, with the edge as authority. Design consequences: all writes
commit locally first and replicate asynchronously; all cloud-originated
mutations are pending commands until edge application; every channel is
idempotent under retry.

## Contract package

[docs/contracts/sync-schema/](../../contracts/sync-schema) in osi-os is the
source of truth; osi-server mirrors must match byte-for-byte.

| File | Defines |
|---|---|
| `events.schema.json` | Edge→cloud event envelope and operation enum. |
| `commands.schema.json` | Cloud→edge pending-command payloads. |
| `resources.schema.json` | Canonical resource shapes. |
| `effect-keys.md` | Idempotency keys for physical effects (a replayed valve command must not actuate twice) and their authority rules. |
| `canonicalization.md` | Cross-runtime formulas with golden vectors. Example: `pF = log10(kPa·10)`, 30 kPa → 2.4771212547196626, non-positive kPa → null; JS (edge), TS (GUI), and Java (`SyncPayloadCanonicalizer`) must agree byte-for-byte. |

Breaking changes create a new versioned file with a deprecation window on
both runtimes; v1 semantics are never edited in place. Identifiers crossing
the boundary: `user_uuid`, `zone_uuid`, `gateway_device_eui`,
`sync_version`. Deletions are `deleted_at` tombstones, never hard deletes.
Related contracts: `docs/contracts/dendro/`, `docs/contracts/history-router/`,
`docs/contracts/zone-env/` (golden vectors for the extracted helpers) and
`docs/channel-manifest.md`.

## Transports

| Transport | Direction | Content |
|---|---|---|
| REST/HTTPS (edge-initiated) | bidirectional | Events, bootstrap snapshots, history segments, pending-command polls, ACK batches, token refresh, account link. |
| MQTT over WSS:443 | edge→cloud only | `devices/{eui}/heartbeat` (60 s), `…/telemetry` (per uplink), `…/status` (on change), `…/command_ack` (fast lane). The edge holds no cloud-broker subscription. |

Cloud endpoints (implemented in **(osi-server)**
`backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`):

| Endpoint | Method | Cadence |
|---|---|---|
| `/auth/local-sync` | POST | link ceremony |
| `/auth/refresh-sync` | POST | 3600 s |
| `/api/v1/sync/edge/bootstrap` | POST | 21600 s |
| `/api/v1/sync/edge/events` | POST | 30 s |
| `/api/v1/sync/gateways/{eui}/pending-commands` | GET | 30 s |
| `/api/v1/sync/gateways/{eui}/status`, `…/reconciliation` | GET | on demand |
| `/api/v1/devices/claim-bulk` | POST | link ceremony |
| `/api/v1/sync/chameleon/calibrations/lookup` | POST | 30 s when misses exist |

## Edge→cloud lifecycle

1. Local commit. Database triggers append to `sync_outbox`
   (`aggregate_type`, payload, `occurred_at`, `delivered_at NULL`).
2. Every 30 s the sync worker batches undelivered events, posts them, and
   stamps `delivered_at` on acknowledgement. Failed delivery leaves rows
   untouched for the next tick. Retention prunes delivered rows nightly
   (cron `0 2 * * *`; eviction index `idx_sync_outbox_eviction`).
3. Cloud ingest (`EdgeSyncService`, `SyncEventApplier`,
   `SyncEventTxExecutor`) validates ownership and schema, canonicalizes the
   payload hash, applies to the mirror, and returns per-event results.
   `SyncExceptionClassifier` separates retryable from poison; poison events
   land in `SyncDeadLetter` with an admin API instead of blocking the stream.
   `SyncResourceWatermark` tracks per-resource freshness.
4. Every 6 h the edge posts a full bootstrap snapshot, which reconciles
   mirrors that missed events or joined late.

## History shadow sync

Bulk historical tables replicate on a separate channel with verifiable
content:

- Update triggers record dirty keys (`sync_history_dirty_keys`).
- Every 60 s `osi-history-sync-helper` packs dirty rows into segments hashed
  per `scripts/lib/history-hash-v1.js` and posts them; every 300 s a manifest
  (segment inventory + hashes) lets the cloud verify coverage.
- Cloud ingest lives in **(osi-server)** `backend/.../sync/history/`
  (`EdgeHistoryIngestService`, `HistoryManifestIngestService`,
  `HistoryHashV1`, `HistoryColumnEncoder`, `HistoryTableMapper`). Rows
  failing validation quarantine on either side
  (`sync_history_quarantine`, `HistoryQuarantineRepository`) rather than
  dropping. Cursors (`sync_history_cursors`, `sync_history_segments`) make
  the stream resumable.

## Cloud→edge command lifecycle

1. A cloud mutation on a gateway-backed resource creates a `DeviceCommand`
   (**(osi-server)** `backend/.../command/`, `CommandService`) and the mirror
   presents the resource as pending. Command types are listed in
   [AGENTS.md](../../../AGENTS.md) (zone/schedule/config upserts, device
   claim/unclaim, `VALVE_COMMAND`, `SET_*` device settings, `SET_FAN`,
   `REBOOT`, `FORCE_EDGE_SYNC`, `REGISTER_DEVICE`).
2. The edge polls every 30 s. `CommandLeaseService` leases returned commands
   to bound redelivery windows.
3. Edge application: `sync_inbox` dedupes by command id;
   `applied_commands` dedupes physical effects by `effect_key`; the router
   dispatches to per-type appliers. Results are `applied`,
   `already-applied`, or `rejected` with a stable reason; protocol rejection
   is never collapsed into delivered success.
4. ACKs queue in `command_ack_outbox` and deliver both over MQTT
   `command_ack` and in REST batches every 30 s (`CommandAckController`
   cloud-side). Only the ACK transitions the cloud resource out of pending.

## Account link

Pairing exchanges a local login for a sync token plus per-gateway MQTT
credentials: edge tab "Account Link" calls `/auth/local-sync`; cloud side is
`LocalSyncService` and `LinkedGatewayAccountService` (**(osi-server)**
`backend/.../user/`), with `DeviceMqttProvisioningService` creating broker
credentials. The edge persists both, restarts its cloud connections, and
refreshes the token hourly. Unlink reverses the state machine; rollback
nodes cover mid-ceremony crashes. Offline linked login verifies
`bcrypt(password::DEVICE_EUI)`; password hashes never sync.

## Auxiliary lanes

- Chameleon calibrations: the 30 s worker batches unknown `array_id`s to the
  lookup endpoint, persists results, backfills pending `device_data.swt_*`
  rows, and negative-caches misses for 24 h.
- Work requests: `improvement_requests` deliver upward every 300 s; status
  updates return as commands ("Apply Work Request Status").
- Gateway locations: dedicated applier (`GatewayLocationApplier`).

## Verification

Edge: `scripts/verify-sync-flow.js` (flagship, chains schema consistency and
profile parity; CI workflow `verify-sync-flow.yml`),
`verify-sync-contract.js`, `test-contract-schemas.js`,
`verify-sync-op-parity.js` (edge ops vs cloud appliers),
`verify-communication-contract.js`, `check-sync-parity.js` (edge DB vs
mirror spot check), `test-sync-history-schema.js`,
`test-sync-history-worker.js`, `verify-history-hash-fixtures.js`,
`test-outbox-retention.js`. Cloud: canonicalizer golden-vector tests under
**(osi-server)** `backend/src/test/java/org/osi/server/sync/`.
