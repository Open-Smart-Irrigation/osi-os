# OSI OS: network planning and reception history

Status: revised proposal, 10 September 2026. Supersedes the initial specification and its appended review resolutions. This is documentation, not authorization to implement or deploy. The complete product remains the user's account-integrated plan → deploy → observe → compare workflow; v1 below is its first independently verifiable release.

Companion: [OSI Server specification](../../../../osi-server/docs/superpowers/specs/2026-09-09-network-planning-observations-design.md). Review disposition: [consolidated review](2026-09-10-network-planning-review-consolidation.md). Existing edge-owned sync contracts remain authoritative. Proposed additions below do not change those contracts until separately reviewed implementation work lands.

## 1. Verified baseline and corrections

Fetched and inspected `origin/main` on 10 September 2026, without checking out or modifying unrelated work:

| Repository | Inspected commit |
|---|---|
| osi-os | `492935d3e6d43378be52620efff54fa42e619844` |
| osi-server | `122a14708acf7a56d07e2196cf38fa143e83192a` |

The original edge inspection used `d6d8b66cd`, which lacks 335 commits now in edge main. The original server SHA was already the current main SHA, but the inspection missed durable history sync. Baseline correction therefore requires new findings, not just substituting commit IDs.

Verified main surfaces:

- Ordered migrations reach `0053__installation_identity_backfill.sql`; `0051__durable_history_batch.sql` supports durable history. Never allocate migrations from the stale branch's 0025 baseline.
- `osi-history-sync-helper/index.js` under the canonical Pi payload and the `sync-history-build` flow implement per-table history batches, cursors, dirty-key corrections and manifests. Server `docs/sync/history-sync-v1.md` documents the durable mirror.
- There are nine parallel MQTT subscribers to `application/+/device/+/event/up`, not one common entry point. `Build FT SQL` on the Field testing path already extracts receivers and tester GPS.
- `gateway_locations` is the existing gpsd-fed gateway position authority, mirrored by `GATEWAY_LOCATION_UPSERTED`, bootstrap and server `GatewayLocationApplier`.
- The scoped-access model is defined in `docs/adr/2026-07-19-scoped-multiuser-access-model.md`; main exposes `/api/me`, `/api/grants` and `/api/users`. Capabilities travel edge-to-cloud in `syncCapabilities`; there is no generic reverse capability advertisement.
- Both GUI locale sets are `en`, `de-CH`, `fr`, `it`, `es`, `pt`, `lg`.
- Terra currently writes cloud-local device anchors through `TerraDeviceAnchorWriteService` → `ZoneAnchorInventoryJdbcRepository.replaceSnapshot`. Its geometry and inventory-fingerprint checks do not exist on the edge.

Paths in this baseline refer to the pinned main trees, not to the stale current checkout. Implementation branches must start from refreshed main and recheck these facts.

## 2. Release boundaries

V1 delivers reception capture for application uplinks, a `radio_uplinks` stream of existing history sync v1, confirmed per-device installation positions, and an authorized cloud network map showing provenance. Local read-only network observations and coordinate editing use the existing edge GUI. Legacy Terra anchors remain unchanged in v1 and are labelled separately from installed locations.

V1 non-goals:

- Pi-hosted project copies, cloud user tokens on the Pi, new cloud-to-edge project synchronization or offline terrain computation.
- Account project CRUD, scenario comparison and planner UI extraction; these follow in the next product phase, not removed from the agreed outcome.
- Replacement of Terra anchor writers, prediction weighting changes or a second gateway-coordinate authority.
- Changes to `device_data`, measurement-to-uplink foreign keys or the agronomic payload contract.
- Transmission-attempt logging, downlink testing, PDR inference, cross-network-server correlation, automatic RF calibration or irrigation control changes.
- Dropping legacy field-tester tables, general erasure epochs or a new history transport.

The phase gate is a working test-gateway slice, not a simultaneous launch of the entire product.

## 3. Ownership, access and offline storage

Installed device coordinates and radio configuration are edge-authoritative. Cloud edits follow REST pending commands and remain pending until the edge applies them. Reuse the `UPSERT_ZONE_LOCATION` command pattern for the proposed device-location command, preserving edge authorization, request idempotency and expected-version conflict handling.

Local rights come from scoped access: gateway-wide configuration is admin-only; device installation edits require the permitted admin/researcher role and actual resource scope. Viewers cannot edit. Read-only radio queries use the existing scope resolver; shared weather-device rules are preserved. Unassigned/unknown-device metadata is admin-only. In legacy flag mode use the existing legacy authorization policy explicitly, not an invented project role. Add a role × own/foreign scope × disabled × flag-state test matrix before exposing routes.

Account projects and immutable scenario revisions will be cloud-owned with browser working copies. Offline storage is IndexedDB or equivalent browser storage, partitioned by cloud account and project. The Pi stores neither projects nor per-user cloud access/refresh tokens. Local files may be imported into the cloud by the browser after account authentication. Publication uses a base revision; stale updates retain a conflict copy instead of overwriting either version.

For v1 local maps, cached observations and coordinate lists remain usable offline with a clear as-of time. Without an available basemap show coordinates/markers on a labelled plain background. No offline tile download or Pi tile service is implied.

For the project phase, the edge GUI offers an authenticated cloud planner launch using a validated return link; project login and saved account operations happen in the cloud origin. Shared presentation modules can run locally over local inputs, but cloud-backed features open the cloud session rather than passing credentials through the Pi. This avoids inventing cross-origin cookies, permissive CORS or a shared-device token vault. A later inline integration needs its own browser auth design.

## 4. Locations and historical context

### Device installation positions

Proposed `device_installation_location_revisions` in `farming.db` stores subject DevEUI, existing installation identity, source gateway, revision UUID/version, latitude/longitude, accuracy, coordinate source, optional altitude and vertical reference, antenna height AGL, effective-from, recorded-at, actor and superseded revision. Reuse main's installation identity/recovery semantics; do not add a competing producer epoch system.

Retain nonoverlapping effective intervals and explicit retrospective corrections. Default edits apply now. Late observations resolve by observation time; an uncertain clock produces uncertain context. The resolved position is `confirmed_device`, `zone_fallback` or `unknown`. A zone fallback is a read-time approximation and never manufactures a confirmed device position.

Store versioned installed radio settings separately from positions, with TX power, gain and feeder loss provenance. Unknown is null. Existing probe/channel depth remains canonical; antenna height and probe depth are distinct. No probe-depth/calibration migration belongs in this project.

Proposed aggregate types `DEVICE_INSTALLATION_LOCATION` and `DEVICE_RADIO_CONFIGURATION` belong to the outbox's `PROTECTED` partition and the migration-owned trigger allowlist. Update the retention verifier when registering them; sizing must respect `OSI_OUTBOX_MAX_ROWS` (50,000). These low-volume resources use existing events/bootstrap, not history batches. New migration IDs are chosen from current main at implementation time.

### Gateway positions

Gateways stay outside the new revision model in v1. Read `gateway_locations`, including `sync_version`, source, fix status/quality and fix times. The network map labels the receiver position `gps_fix`, stale or unknown as applicable. A proposed manually positioned gateway in a scenario is not a write to this store. V1 adds no manual gateway confirmation path, so it cannot silently overwrite or fight a subsequent gpsd fix.

At ingest, snapshot the known receiver location value and its version/fix time into the observation context when available. It is evidence of what was known then, not another writable authority. A delayed uplink must not use today's GPS fix as a historical fact; require a fix contemporaneous with the observation under the declared freshness policy, otherwise retain unknown/uncertain context. Other receivers without known authoritative location remain unplaced. GPS movement affects new observations and the current map, never rewrites a saved comparison's receiver snapshot.

### Terra eligibility

An edge-confirmed position can be outside a cloud field polygon or have no polygon at all. Cloud must preserve the confirmed fact and separately derive anchor eligibility: eligible, outside geometry, missing geometry, inventory mismatch or review required. Do not reject an authoritative location because the edge cannot validate cloud geometry.

V1 keeps existing Terra anchor editing and prediction behavior unchanged. The two concepts are explicitly labelled: installed position versus legacy analytical anchor. The later facade transition maps confirmed locations into eligible anchor views, preserving cloud anchor revision/fingerprint checks. The proposed edge command checks the edge's own expected location revision and current device assignment; it does not pretend to validate the cloud-only fingerprint. Cloud validates its fingerprint before issuance and recomputes eligibility after edge application.

## 5. Reception capture and schema

Refactor the Field testing subscriber's parsing into a reusable metadata helper and widen that single capture branch to all application uplinks. Keep the other device subscribers intact. Do not add a metadata writer in each of the nine branches. Metadata persistence must not depend on successful device decoding.

Preserve the field-tester decoder/export contract. During v1 the same capture helper supports the new RF store while legacy field-tester storage and `/download-fieldtest` remain compatible and access-checked. Optional historical backfill is bounded and idempotent. Retirement, raw-payload removal from old tables and a rewritten export are a separate migration after comparison tests, not prerequisites for metadata capture.

One ChirpStack event contains one source uplink and its `rxInfo` list. New `radio_uplinks` rows have a stable persisted local ID scoped to existing source installation identity; retain native `deduplicationId` and DevEUI for replay deduplication. Frame counter alone is not identity. Missing stable native identity is explicitly uncertain; a persisted ingress ID prevents retry duplication after capture but cannot prove two network deliveries are the same transmission.

Fields include observed/ingested times and clock quality, frequency, SF/BW, coding rate, frame counter, ADR, decoder status, optional device-reported latitude/longitude/altitude, HDOP, satellites, accuracy, fix validity/source and timestamp. Tester/mobile reported position takes precedence for that observation; it does not move a fixed installation. Known tester codecs populate these fields; unknown payloads retain nulls. Future T-Watch adapters target this schema without claiming the draft watch implementation is shipped.

Embed a canonical receiver array in each history payload, including gateway ID, numeric uplink receiver ID when supplied, RSSI, SNR, channel, CRC status if provided and receiver position context. Reuse the Field testing key `(deduplication_id, gateway_id, uplink_id_num)`. Define null receiver-ID handling in shared hash fixtures before freeze: repeated null-ID entries must not rely on SQLite UNIQUE-null behavior; conflicting ambiguous entries remain flagged rather than silently averaged. Use the parent radio table ID for history cursor/lookup; receiver-local IDs are never parent history keys. Sort receiver records deterministically before hashing. A late receiver updates the canonical parent payload and marks its history key dirty.

Do not copy keys, credentials, raw payload bytes/base64 or unrelated sensor readings into the new RF store. Retain GPS only for authorized devices/surveys, never expose foreign application metadata to ordinary users.

Capture guarantees begin after local durable commit. Current MQTT/Node-RED delivery is not a replayable WAL: restarts can lose buffered messages, and an overflow counter cannot measure every outage loss. Record restart/downtime windows and explicit drop counters where observable. Maps show completeness as unknown during such intervals; they do not promise capture of all transmitted or even all previously delivered messages.

## 6. Storage isolation and existing history sync

Use a dedicated `/data/db/radio.db` for high-churn uplinks, receiver payloads and capture diagnostics. Installation revisions stay in `farming.db`. This choice requires a dedicated-database lifecycle and history-source adapter; it is not supported merely by adding a table name today. The scratch-branch `createDedicatedDatabase` primitive is not a main dependency: independently review/land the required slice or implement an equivalent through the approved DB facade. Never import the scratch branch wholesale.

The RF database needs its own versioned migration ledger, backup/restore coverage, bounded WAL/checkpoint policy, integrity checks and disk budget. Do not attach long radio transactions to the agronomic writer queue. Preserve radio row IDs on restore and integrate existing installation recovery checks; a recreated empty database must not reuse identities against an old cloud cursor.

Extend history sync v1's source adapter to read this database while preserving existing per-table cursor/dirty-key/manifests behavior. Payload mutation and its correction marker must commit together in radio.db. A restart-safe bridge transfers those markers into `sync_history_dirty_keys` in farming.db; it removes a local marker only after durable transfer. Replay of the bridge is idempotent. Marker transfer/cleanup compares the captured marker generation, so a concurrent receiver correction cannot be cleared by an older transfer or ACK. Read the parent and embedded receivers from one coherent source snapshot. Cursor updates in farming.db occur only after durable server acknowledgement. Capture remains recoverable if a crash occurs between either database's commits. Do not claim a cross-database atomic transaction under WAL.

Transport remains `POST /api/v1/sync/edge/history/batches`, with `tableName=radio_uplinks`, existing phases/hash versions, manifests and dirty-key corrections. Add radio registration to the helper TABLE_COLUMNS/TABLE_DEFINITIONS, cursor/segment/dirty lookup paths, source adapter, server mapper/writer and round-robin scheduling. Freeze cross-runtime canonical columns/hash fixtures including JSON ordering, finite values and UTC normalization. Adding the new table must not change hashes for any existing table; do not casually change hash versions or treat a JavaScript JSON hash as equivalent to the existing encoder. No `/sync/radio/batches`, `radio_sync_batches`, independent sequence envelope or radio capability is introduced. Receiver additions are parent-row corrections returning `UPDATED`; child streams cannot orphan parents.

Preserve exact existing status semantics: applied/duplicate/updated rows contribute to the durable prefix; validation quarantine may advance it; retryable errors stop it; hash mismatch and ordering rejection also stop it. A quarantined bad radio row must not block later valid rows. Do not reinterpret every permanent rejection as acknowledged. Unknown table/version returns a structured rejection without advancing that stream. Other supported streams must continue; bound retries and expose unsupported-radio state.

Use `durableMirrorConfirmed`, `recommendedBatchSize`, `minIntervalMs` and existing request limits/backoff. Shadow validation is not durable storage. Cloud mapper acceptance lands before radio producer enablement. Test a radio payload against the existing history size cap; bound receiver fan-out using explicit validation/quarantine, never silent truncation. Preserve normal command/event scheduling during catch-up.

### Retention and evidence

Existing history v1 manifests expect zero tombstones and the cloud retains canonical mirrored history. Automatic deletion of radio rows at 30/180 days would conflict with repair/manifests; those earlier defaults are withdrawn.

V1 is a bounded capture pilot: set an initial configurable 512 MiB radio budget, monitor rows/bytes/oldest unsynced age, and pause new RF capture before the hard limit or reserved system disk floor. Continue agronomic ingest and valve control. Do not silently prune acknowledged or unacknowledged rows to regain space. Record the pause and restart time. This limitation must be visible and prevents claiming indefinite collection.

Before broad capture, design and test a radio-specific retained-segment/archive policy compatible with history manifests and repair. Retention changes must not alter existing agronomic streams. Archive manifests identify available evidence ranges; comparison snapshots pin copies only after durable evidence storage. Survey-track erasure belongs to the later survey phase and requires anti-resurrection behavior for archived/dirty-key repair. V1 creates no general distributed erasure or producer-suppression epoch protocol.

## 7. Maps, later projects and comparisons

V1 cloud map shows authorized observed devices and receiving gateways, sample counts, last observation, cloud sync age and selected-window RSSI/SNR statistics. Default window is 24 hours, with 1-hour and 7-day options. Filter by radio settings; missing placement remains in a list. Expected cadence, if actually known, can support freshness; otherwise label last seen. Fixed endpoint evidence never fills unsampled ground as measured coverage, and received packets alone cannot establish PDR.

The project phase adds account-owned projects, editor/viewer membership, immutable scenarios, planned-to-installed bindings, browser offline conflict copies and saved simulation artifacts. Project permission never grants underlying device telemetry rights. Confirm each actual installation separately; binding does not provision or actuate hardware. A multi-gateway project exposes per-edge pending/applied states.

Comparisons preserve exact model/terrain/catalog versions, scenario inputs, searched extent, RF assumptions, observation position and installation context. Residual is measured uplink RSSI minus simulated uplink receive power at the actual tester/device position for the actual receiver. SNR and downlink evidence are separate. Unknown tester height/TX/gain limits comparability; measured tester behavior is not automatically valve behavior. Saved results outlive temporary jobs and are reproducible only while their pinned evidence is available.

## 8. Shared UI extraction and localization

The current standalone planner is not a reusable package: `App.tsx` owns state/auth/polling and strings, Vite fixes `/planner/`, and browser auth uses `X-Planner-Key`. Budget an explicit extraction phase.

Canonical shared presentation source will live under edge `web/planner-core/`, vendored by a deterministic sync script into server and standalone planner, with a byte-parity manifest/verifier following the `ui-core` approach. Host adapters own base URL, auth, navigation, storage, catalogs and jobs. Extract map, endpoint editor, results, validation and public types; centralize device identity through the OSI catalog contract. Keep one scientific engine, not copies in Java and browser code.

Use host react-i18next namespaces and structured diagnostic codes. Add keys for all seven host locales with existing translation review gates, including human Luganda review before enabling the new surface on Uganda deployments. PNG diagnostics/labels consume the same versioned translation catalog. Standalone four-language compatibility can remain during extraction; it cannot dictate host locale coverage.

The standalone `/planner/` test deployment stays available during integration with its existing auth adapter. Retire or redirect it only after account import/export and integrated parity pass; do not silently invalidate saved browser projects. Measure bundle/map dependency costs on both host builds. No Mapbox token or offline basemap infrastructure is assumed for the extracted Leaflet view.

## 9. Phases and freeze gates

1. Readiness design: specify radio.db lifecycle/adapter crash recovery, canonical row/receiver hash vectors and null-ID behavior, location resource/command contracts and scoped route matrix. These artifacts must be reviewed before schema freeze; this proposal alone is not a freeze approval.
2. V1 foundations: cloud history mapper and location acceptance; in parallel edge capture/database/source adapter behind disabled flags, location revisions and map read model. No production enabling before paired compatibility tests.
3. V1 pilot: enable cloud acceptance first, then edge radio stream and location production on a designated test gateway. Verify storage limits and command responsiveness. No production host access is implied.
4. Account planning: shared UI extraction and browser/cloud project persistence can run in parallel against frozen adapters. Import existing standalone projects and preserve seven-locale behavior.
5. Survey/comparison and retained-evidence policy; then Terra eligibility/facade transition and prediction parity. Calibration and attempted-transmission logging remain separate optional follow-ups.

Implementation gates include profile/schema parity, migration-owned triggers, `scripts/test-outbox-retention.js`, history durable integration/hash/manifests tests, scoped access matrices, GUI locale/build tests and provisioned-copy migration/restart rehearsals. Dedicated-database creation, backup and disk-pressure tests are mandatory. New history stream tests cover duplicates, late receivers, malformed GPS, null receiver IDs, validation quarantine followed by valid rows, hash rejection, unsupported table, dirty-bridge crash and restore identity.

This revision changes documents only. Prose, relative links and consistency are checked; runtime tests are implementation acceptance criteria, not claimed results of this review.
