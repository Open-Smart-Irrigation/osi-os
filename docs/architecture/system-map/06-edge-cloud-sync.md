# 06 — Edge ↔ Cloud Sync

[← Dashboard](05-dashboard-gui.md) · [Index](README.md) · [→ Cloud server](07-cloud-server.md)

Sync is the postal system between a farm gateway and the cloud. It is designed
around one non-negotiable idea: **the gateway is the authority for its farm.**
The cloud holds a mirror, and anything the cloud wants changed is a *request*
that waits until the gateway accepts it.

## The contract (the written rules both sides obey)

The machine-checkable agreement lives in this repo at
[docs/contracts/sync-schema/](../../contracts/sync-schema):

| File | Plain-language content |
|---|---|
| `events.schema.json` | The envelope format for every edge→cloud change event and the list of allowed operations. |
| `commands.schema.json` | The format of every cloud→edge pending command. |
| `resources.schema.json` | The canonical shapes of synced things (zones, schedules, devices…). |
| `effect-keys.md` | The idempotency rules for *physical* effects: how a valve command is keyed so a network retry can never water a field twice. |
| `canonicalization.md` | Cross-language math rules with golden test vectors (e.g. the pF formula, timestamp/UUID/number formatting) so JavaScript (edge), TypeScript (GUI), and Java (cloud) always compute byte-identical results. |

Sibling contracts: [docs/contracts/dendro/](../../contracts/dendro),
[docs/contracts/history-router/](../../contracts/history-router),
[docs/contracts/zone-env/](../../contracts/zone-env) (frozen input/output
vectors for the extracted helper modules), and
[docs/channel-manifest.md](../../channel-manifest.md) (the shared measurement
vocabulary). Breaking changes get a *new versioned file*, never an in-place
edit. Byte-identical mirror copies may exist in osi-server.

## The two transports

| Transport | Direction | Carries |
|---|---|---|
| **REST over HTTPS** | Both ways (gateway initiates everything) | State sync, history sync, **all** cloud→edge commands (the gateway polls; the cloud can never push), token refresh, account link. |
| **MQTT over WSS :443** | Edge → cloud **only** | Live telemetry, 60-second heartbeats, valve status changes, fast command receipts. The gateway is *not subscribed* to anything on the cloud broker. |

Cloud endpoints the gateway calls (implemented in **(osi-server)**
`backend/src/main/java/org/osi/server/sync/EdgeSyncController.java` and friends):
`/auth/local-sync`, `/auth/refresh-sync`, `/api/v1/sync/edge/bootstrap` (6 h),
`/api/v1/sync/edge/events` (30 s), `/api/v1/sync/gateways/{eui}/pending-commands`
(30 s), `…/status`, `…/reconciliation`, `/api/v1/devices/claim-bulk`.

MQTT topics: `devices/{eui}/heartbeat` · `devices/{eui}/telemetry` ·
`devices/{eui}/status` · `devices/{eui}/command_ack`.

## Edge → cloud: how changes travel

1. **Something changes locally**: a sensor row lands, a farmer edits a zone.
2. **A database trigger** drops an event into `sync_outbox` (the outgoing mail
   tray). No application code has to remember this step.
3. Every 30 s the flow node **Build Edge Event Batch** (tab "OSI-Server Cloud
   Integration") collects undelivered events and **POST Edge Events to Cloud
   IPv4** ships them; **Mark Synced Events Delivered** stamps them done.
   Delivery failures simply leave events in the tray for the next attempt.
4. On the cloud, `EdgeSyncService` + `SyncEventApplier` **(osi-server)**
   `backend/.../sync/` validate each event (schema, ownership, canonical
   payload hash via `SyncPayloadCanonicalizer`), apply it to the Postgres
   mirror, and record per-event results. Events that repeatedly fail land in a
   **dead-letter drawer** (`SyncDeadLetter*`, with an admin API) instead of
   blocking the queue; `SyncResourceWatermark` tracks how fresh each resource
   stream is.
5. Every 6 h the gateway additionally uploads a **full bootstrap snapshot**
   ("here is everything I have") which lets a new or drifted mirror catch up in
   one go.
6. Nightly retention (**Prune Sync Outbox**, 02:00) evicts old delivered events
   so the tray stays small.

## History shadow sync (the bulk archive channel)

Live events cover *current* state. Historical tables (sensor history, dendro
history, zone environment…) travel through a separate bulk channel built for
verifiability:

- Dirty-key triggers note which historical rows changed
  (`sync_history_dirty_keys`).
- Every 60 s the edge packs changed rows into **hashed segments**
  (`osi-history-sync-helper`, hash spec `scripts/lib/history-hash-v1.js`) and
  posts them (**Build/POST History Batch**); every 5 min it posts a **manifest**
  (a table of contents with content hashes) so the cloud can prove its copy
  matches (**Build/POST History Manifest**).
- The cloud ingests via **(osi-server)** `backend/.../sync/history/`
  (`EdgeHistoryIngestService`, `HistoryManifestIngestService`, `HistoryHashV1`,
  `HistoryColumnEncoder`, mappers); rows that fail validation go to a
  quarantine table on either side rather than vanishing.
- Cursors (`sync_history_cursors`, `sync_history_segments`) bookmark progress
  so sync resumes cleanly after any outage.

## Cloud → edge: pending commands

1. A cloud user edits a synced resource (or presses "open valve"). The cloud
   does **not** touch its mirror as if that were fact; it queues a
   **pending command** (`DeviceCommand` via `CommandService`, **(osi-server)**
   `backend/.../command/`) and shows the resource as "pending".
2. The gateway polls `GET …/pending-commands` every 30 s (**Build Pending
   Command Pull**). The cloud leases commands to the poll response
   (`CommandLeaseService` prevents double-delivery windows).
3. On the edge, **Deduplicate Pending Command** checks `sync_inbox` (has this
   command ID been processed before?) and, for physical effects, the
   `applied_commands` effect-key ledger, so replays become harmless no-ops.
4. **Route Command** dispatches by type: zone/schedule/config upserts, device
   claims, valve commands, fan/reboot, device registration, forced sync… (full
   list in [AGENTS.md](../../../AGENTS.md) § Sync REST endpoints).
5. The result (applied, already-applied, or rejected with a reason) is queued in
   `command_ack_outbox` and delivered both fast (MQTT `command_ack`) and
   reliably (REST ACK batch every 30 s). The cloud's `CommandAckController`
   marks the command's lifecycle accordingly, and only then does the mirror
   state stop being "pending".

## Account linking (how a gateway joins a cloud account)

The pairing ceremony lives in the flow tab **Account Link** (edge) and
`LocalSyncService` / `LinkedGatewayAccountService` (**(osi-server)**
`backend/.../user/`): the farmer signs in locally, the gateway calls
`/auth/local-sync` with proof, the cloud returns a **sync token** plus
**gateway-specific MQTT credentials**, the edge stores both and restarts its
cloud connections. Unlink reverses everything, with rollback nodes making the
ceremony crash-safe. Tokens are refreshed hourly. Linked login on the edge uses
a gateway-specific offline verifier; cloud password hashes never travel to the
farm.

## Special sync lanes

- **Chameleon calibrations**: the cloud owns the global soil-probe calibration
  table (fetched from via.farm). The edge asks for unknown array IDs in its
  30-second cycle (`POST /api/v1/sync/chameleon/calibrations/lookup`), stores
  results, and back-fills readings that were waiting ("pending" →
  "calibrated"). A 24-hour negative cache stops repeated asking.
- **Improvement requests**: farmer feedback rows are delivered upward every
  5 min (**support-delivery-worker**) and status updates flow back as commands
  (**Apply Work Request Status**). See chapter [08](08-operations.md).
- **Gateway location**: GPS fixes sync via their own applier
  (`GatewayLocationApplier`, cloud side).

## Who verifies all this

| Verifier (osi-os `scripts/`) | Checks |
|---|---|
| `verify-sync-flow.js` | The whole edge sync implementation (chains schema-consistency and profile parity too); the flagship verifier, CI-gated. |
| `verify-sync-contract.js` / `test-contract-schemas.js` | Contract files are valid and edge behavior matches them. |
| `verify-sync-op-parity.js` | Edge event operations and cloud appliers cover the same operation set. |
| `verify-communication-contract.js` | Preflight for the REST/MQTT communication contract. |
| `check-sync-parity.js` | Data-level spot comparison between an edge DB and its cloud mirror. |
| `test-sync-history-schema.js` / `test-sync-history-worker.js` / `verify-history-hash-fixtures.js` | History shadow-sync schema, worker behavior, and hash golden vectors. |
| `test-outbox-retention.js` | Retention/eviction behavior of the outbox. |

On the cloud side, `SyncPayloadCanonicalizerTest` and the sync service tests
(**(osi-server)** `backend/src/test/java/org/osi/server/sync/`) pin the same
golden vectors from the Java end.
