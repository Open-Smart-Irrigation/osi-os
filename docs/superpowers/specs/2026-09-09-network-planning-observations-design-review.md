# Review: network planning and reception history specifications

Reviewed 9 September 2026. Subjects: [OSI OS specification](2026-09-09-network-planning-observations-design.md) at commit `6ed921a50` and [OSI Server specification](../../../../osi-server/docs/superpowers/specs/2026-09-09-network-planning-observations-design.md) at commit `6cb370c5`. Every claim below was checked against the current checkouts; paths and line numbers point at the evidence.

Verdict: **needs revision before phase 1 ("freeze shared schemas") can start.** The design principles hold up: edge authority for installed state, nulls for unknowns, no delivery ratio from frame-counter gaps, no cloud-to-edge MQTT, measured and predicted layers kept apart. The defects are in the baseline and in the transport. The specification was written against a checkout 335 commits behind `origin/main`, and it re-specifies an edge-to-cloud history batch protocol that already exists on both sides with different, deliberately chosen, poison-row semantics. Four findings block; nine need a spec change; the rest are simplifications.

## Blocking

### B1. The "verified baseline" is a stale feature branch

Section 2 of the edge spec cites osi-os HEAD `d6d8b66cd`. That commit is on `feat/valve-control`, and `git rev-list --left-right --count origin/main...HEAD` returns `335 1`: the checkout is 335 commits behind `origin/main` (head `492935d3e`, PR #206). Claims that are false on this branch and true on main include:

| Claim area | On `feat/valve-control` | On `origin/main` |
|---|---|---|
| History sync | shadow-only; `history_mirror_write_v1_confirmed` is never set | durable; migration `0051__durable_history_batch.sql`, `serverConfirmsDurable(response)` |
| Ordered migrations | highest `0025` | highest `0053__installation_identity_backfill.sql` |
| Uplink subscribers | 8 `mqtt in` nodes on `application/+/device/+/event/up` | 9 (adds `sdi12-mqtt-in`) |
| Local users and roles | no `role` column, no `/api/me` | `/api/grants`, `/api/me`, `/api/users` live |
| Advertised capabilities | `linked_auth_sync_v1`, `force_edge_sync_v1` | plus `installation_recovery_v1` |

On the server side the durable history mirror landed on 2026-09-08 in commit `658909e3`, one day before the spec's inspection of `122a1470`, and the newest Flyway file is `V2026_09_14_001__desired_state_capability_extension.sql`. Re-baseline both documents on `origin/main` of each repository and restate section 2 from that inspection. The playbook rule ("re-verify against current main") exists because of exactly this drift.

### B2. The proposed radio batch route duplicates history sync v1 and inverts its failure semantics

Edge spec section 5 proposes `POST /api/v1/sync/radio/batches` with a stable batch UUID, contiguous sequence ranges, atomic per-batch acceptance, and whole-batch quarantine on any bad record. Section 10 adds "cloud accepts only the next contiguous batch" and a retryable sequence-gap response.

A history stream with the same purpose is merged and durable on both sides:

- Edge: `sync-history-build` builds `POST {serverUrl}/api/v1/sync/edge/history/batches` ([flows.json:6037](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json#L6037)), manifests at [flows.json:6140](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json#L6140); state in `sync_history_cursors` (per `table_name`), `sync_history_dirty_keys` (corrections), `sync_history_segments`, `sync_history_quarantine` ([seed-blank.sql:685-745](../../../database/seed-blank.sql#L685-L745)); hashing in `osi-history-sync-helper` via `osiLib.require('history-sync')`.
- Cloud: `EdgeSyncController` routes `POST /edge/history/batches` and `/edge/history/manifests`; `HistoryBatchRequest` carries `protocolVersion, gatewayDeviceEui, batchId, tableName, phase, hashVersion, cursor, rows[historyKey, naturalKey, payloadHash, payload]`; `HistoryBatchResponse` returns `ackedThroughId, recommendedBatchSize, minIntervalMs, durableMirrorConfirmed` and per-row `APPLIED | DUPLICATE | UPDATED | QUARANTINED | REJECTED_PERMANENT | RETRYABLE_ERROR`. Documented in `/home/phil/Repos/osi-server/docs/sync/history-sync-v1.md`.

The existing protocol quarantines a bad row and still advances the ACK cursor; the spec's design rejects the whole batch and blocks the stream at that sequence until an operator repairs it. That is the poison-pill behaviour the sync rework spent a quarter removing (`SyncEventTxExecutor`, dead letters, per-event `REQUIRES_NEW`). On a Uganda gateway one unparseable `rxInfo` entry from a ChirpStack upgrade would halt radio history indefinitely.

Required change: drop the new route, envelope, sequence protocol and `radio_sync_batches` table. Specify `radio_uplinks` as a new `tableName` stream of history sync v1. Embed the receiver list in the uplink payload so a batch never carries child rows with unresolved parents; a late receiver addition is a correction through `sync_history_dirty_keys` and surfaces as `UPDATED`. The "older cloud" case then needs no new capability: an unknown `tableName` returns a structured rejection and the cursor stays put, mirroring how `durableMirrorConfirmed` gates the existing stream. Section 10's contiguity, gap-response and correction-sequence paragraphs are then deleted rather than ported.

### B3. Gateway installed location would be the second edge coordinate authority

`gateway_locations` already exists on the edge ([seed-blank.sql:1301-1320](../../../database/seed-blank.sql#L1301-L1320)) with `source` defaulting to `gpsd`, a ChirpStack mirror status, `GATEWAY_LOCATION_UPSERTED` outbox triggers ([seed-blank.sql:2484-2530](../../../database/seed-blank.sql#L2484-L2530)), a `GATEWAY_LOCATION` protected outbox class, and a cloud applier (`GatewayLocationApplier.java`, table `gateway_locations` from `V22__gateway_locations.sql`). The bootstrap payload carries `gatewayLocations` every six hours.

Neither spec mentions this store. `installation_location_revisions` with subject kind `gateway` would sit beside it, and the pitfall card's "one source of truth per fact" rule applies. Decide one of:

1. gpsd fixes are a coordinate source only; a gateway installation revision with `coordinate_source = 'gpsd'` is created from `gateway_locations` when a fix qualifies, and consumers read revisions.
2. Gateways are out of the revision model in v1; the receiver's position resolves from `gateway_locations`, labelled `gps_fix` provenance, and only devices get installation revisions.

Option 2 is smaller and still yields a receiver position for every reception. Either way the spec must say which store the network map and comparison sections read for receiver position, and what happens when a live GPS fix moves after an installer confirmed a gateway position by hand.

### B4. Offline project working copies imply a new sync direction and user credentials on the Pi, neither specified

Section 3 puts project, membership and scenario head authority on the server and gives the edge "a versioned working copy; disconnected edits become proposals". Section 7 adds queued simulation requests from the edge. Today cloud-to-edge traffic is pending commands only, authenticated as the gateway, and no project resource stream exists in either direction. Two things are therefore missing:

- How a project working copy reaches the Pi, and how proposals return. Pending commands are gateway-scoped and unsuitable for per-user project state.
- Whose credential the Pi presents. Section 3 correctly says local and cloud roles are not interchangeable, so the Pi would have to hold a per-user account token to download projects and to submit simulations on a user's behalf.

The planner design of 8 September chose browser storage for projects ("Keep project files in the browser for the first version"). The cheapest consistent resolution is to keep projects, scenarios and simulations cloud-plus-browser: the edge GUI's browser talks to the cloud directly for project features when online, offline copies live in the browser, and the Pi stores only installation revisions and reception history. If the spec instead wants project copies in the Pi's SQLite, it must add the resource stream, the credential model and the token storage rules. Until this is decided, sections 3, 6 and 7 cannot be frozen.

## Important

### I1. Cloud anchor invariants do not exist on the edge

`TerraDeviceAnchorWriteService` replaces a per-zone snapshot under a revision compare-and-swap, re-checks the device inventory fingerprint after the swap, and rejects a device placed outside the zone's saved field geometry (lines 55-87 and 162-188). The edge has no field geometry at all: no polygon, GeoJSON or centroid column exists in `seed-blank.sql`. An edge-confirmed WGS84 position can therefore violate a cloud-only invariant that the edge cannot evaluate. The facade must define the outcome, and "reject" is not available because the edge is authoritative. Recommended: a confirmed location is stored with provenance regardless, and anchor eligibility (inside geometry, inventory match) is a separately computed cloud state with a warning, so `PredictionSpatialUnitAssembler` sees "confirmed, not anchor-eligible" instead of a rejected write.

The same section proposes an `UPSERT_INSTALLATION_LOCATION` command carrying an expected inventory fingerprint. The fingerprint formula lives only in the cloud. If the edge is to check it, the formula must move into the edge-owned canonicalization contract; otherwise the command should carry only the edge's own expected revision and the cloud translates.

Good news from the inventory check the spec demands in section 10: there is exactly one anchor writer. `zone_device_sensor_anchors` is written only by `ZoneAnchorInventoryJdbcRepository.replaceSnapshot`, called only from `TerraDeviceAnchorWriteService`; the legacy JPA `ZoneSensorAnchorRepository` has no callers. The cutover inventory is a one-line fact, not a project.

### I2. There is no "before device-specific filters" point in the flows

Section 5 asks for one common capture path before device filters. The flows have no such point: eight parallel `mqtt in` nodes (nine on main) subscribe to the same topic, one per sensor tab, and every production path drops `rxInfo`. Only the Field testing tab consumes it, in `Build FT SQL` ([flows.json:3129](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json#L3129), node lines 145-157), writing `field_tester_rxinfo` with unique key `(deduplication_id, gateway_id, uplink_id_num)`. That key is the canonical receiver identity the spec leaves unspecified in section 4.

Rewrite the capture paragraph as: generalize the Field testing subscriber to every application, write the new tables, and retire `field_tester_uplinks` / `field_tester_rxinfo` with a data migration and a rewired `/download-fieldtest` ([flows.json:3194](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json#L3194)). Say explicitly that `payload_b64` is dropped, since section 4 forbids raw payloads in the new store while the tester table keeps them. Note also that capture is at-most-once from the MQTT boundary: a Node-RED restart loses whatever sat in the in-memory buffer, and the overflow counter cannot count that.

### I3. Survey positions are missing from the uplink record

Section 4's uplink field list has no device-reported position or GPS quality. `field_tester_uplinks` carries `latitude, longitude, altitude_m, hdop, sats, accuracy_m` for exactly this purpose, and sections 8 and 9 (survey matching, residuals at "each actual observation position") cannot work without them. Add nullable reported-position fields plus fix quality to the uplink record, and state that the T-Watch survey design (`docs/twatch-ultra/05-mvp-design.md`, attempts and link events at its lines 226 and 360) feeds the same fields.

### I4. Which database file holds the radio tables is undecided, and it matters

Adding six high-churn tables to `farming.db` means ordered migrations, seven bundled databases, `CHECKSUMS.json`, schema fingerprints, the frozen boot node and every schema verifier, plus WAL checkpoint pressure on the agronomic store. The spec's own rule that radio storage failure must never block sensor ingest or valve control argues for isolation. A review-approved `createDedicatedDatabase` primitive exists on the unmerged scratch branch `sdd/dbhelper-primitives` (commit `578b7073d`); it is not on `origin/main`, so adopting it means landing that slice first or re-deriving it. Recommend: reception history and gap records in a dedicated radio database with its own retention; installation and radio-configuration revisions stay in `farming.db` because they are synced resources with outbox triggers.

### I5. New outbox triggers must be classified or the retention test fails

Installation and radio-configuration revisions will emit outbox events through triggers. `prune-sync-outbox` ([flows.json:8883](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json#L8883)) partitions aggregate types into `TELEMETRY` and `PROTECTED`, and `scripts/test-outbox-retention.js` fails with `UNCLASSIFIED` for any trigger-backed type in neither set. The spec should name the new aggregate types and place them in `PROTECTED`, and note the `OSI_OUTBOX_MAX_ROWS` cap of 50,000 rows when sizing.

### I6. "Four languages" contradicts both GUIs' locale sets

Both `web/react-gui/src/i18n/config.ts` and the server's `frontend/src/i18n/config.ts` ship seven locales: en, de-CH, fr, it, es, pt, lg. The server has `localeParity.test.ts`; the edge locale convention is per-key edits in both trees. New namespaces must exist in all seven or the gates go red. State the policy instead of a language count: keys in all seven, human translations for de-CH, fr, it; es and pt by the existing review process; lg by the Uganda human-native gate, or the surface stays feature-flagged off on the Uganda gateway until that pass.

### I7. Offline map on the Pi has no basemap strategy

Neither GUI has a map library; Terra uses `mapbox-gl` with a required public token, which is online-only. An offline-first edge GUI with a network map and scenario editor needs either an offline tile cache with a disk budget or an explicit "coordinates and markers without basemap when offline" mode. Pick one in section 7. Also note the build cost: the workstation already runs out of memory on frontend builds, so a map dependency needs a bundle-size check.

### I8. Planner UI reuse is an extraction project, not a packaging step

The planner at `/home/phil/Repos/osi-planner` has one commit. Its frontend is a single `App.tsx` owning state, strings, catalog fetch and polling; `vite.config.ts` hardcodes `base: '/planner/'`; auth is `X-Planner-Key` in `sessionStorage`; translations live in three unlinked dictionaries (`i18n.ts`, `App.tsx`, `export.py`); the device-type enum is copied in three files. "Reuse through a maintained shared package" therefore means extracting `MapView`, `EndpointFields`, `ResultsPanel`, `validation.ts` and `types.ts` into a real package, replacing the base URL and auth, and adopting react-i18next. The spec should name the vendoring mechanism (the `ui-core` precedent with a byte-parity verifier) and say what happens to the standalone `/planner/` deployment after integration.

### I9. Capability names and the "older cloud" check must match the real mechanism

Capabilities are advertised edge-to-cloud in `syncCapabilities` at bootstrap ([flows.json:5843](../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json#L5843)) and persisted as `*_supported` columns in `linked_gateway_accounts`; design-time staging is `sync-contract-golden.json` `capabilities/staged`. The cloud does not advertise anything back. Names are snake case with a version suffix (`installation_recovery_v1`), so `radio-observations-v1` should become `radio_observations_v1`, and `installation_locations_v1` needs a `staged` entry on the server before any edge producer. For the history stream, adopting B2 removes the need for a separate capability.

## Simplifications and scope

- **Cross-network-server correlation is a non-case.** A device joins one network server; a second server drops its frames at MIC check and never publishes an application uplink. Section 10's producer-namespace, correlation-candidate and "independent source events" text can go. The one-event-three-receivers case is one ChirpStack event with three `rxInfo` entries.
- **Scope erasure to survey sessions.** Fixed-device receptions are operational data under retention. Personal GPS tracks from a surveyor are the actual deletion driver. Limiting the deletion-record, suppression-epoch and pin-invalidation machinery to survey sessions removes most of section 10's retention text from v1.
- **Use the server's pacing fields.** `recommendedBatchSize` and `minIntervalMs` already exist in the history response; drop the fixed one-batch-per-10-seconds constant.
- **Reuse `UPSERT_ZONE_LOCATION`.** A cloud-issued location command already exists (`IrrigationZoneController.java:471`, `ZoneMutationCommandService.java:30`). Shape `UPSERT_INSTALLATION_LOCATION` on it and cite it.
- **Take measurement-to-uplink linking out of v1.** It adds a column to `device_data`, whose sync trigger is insert-only and whose payload is a contract; either specify that change or defer it.
- **Write a v1 non-goals list.** Section 1 names a first release but sections 3 to 10 read as one scope. A defensible v1: reception capture on every uplink, the history stream, per-device confirmed location on the edge with the cloud network map reading provenance, legacy anchors untouched. Projects, scenarios, offline copies, comparisons, calibration and erasure follow once that ships on the test gateway.
- **Cite the scoped-access model.** Section 10's "existing installation-edit permission" should reference the 2026-07-19 scoped multiuser ADR and the `/api/me` role surface on main rather than "existing local authentication".
- **Fix small factual slips.** The server compose file is `docker/docker-compose.yml`, not `compose.yaml`; the server contract mirror is `backend/src/test/resources/sync-contract/`, and its AGENTS.md lines 196-211 are the authority for the byte-parity versus cloud-ahead split the cloud spec cites.

What transfers from this review to the next revision: baseline on `origin/main`, extend history sync v1 instead of adding a transport, decide the gateway-location and project-storage questions before freezing anything, and cut v1 to what the test gateway can prove.
