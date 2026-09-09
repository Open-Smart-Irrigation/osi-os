# OSI OS: network planning, installation locations and reception history

Status: proposed specification for review. The user approved the architectural direction and requested paired specifications; this document does not authorize implementation or deployment. Date: 9 September 2026.

Companion: [OSI Server specification](../../../../osi-server/docs/superpowers/specs/2026-09-09-network-planning-observations-design.md). This edge document owns the proposed cross-repository semantics; the server document owns cloud implementation and consumption requirements. New names below are proposed, not existing APIs or registered capabilities.

## 1. Outcome and scope

A user can maintain several deployment projects, compare gateway and antenna scenarios, confirm an installation, collect field surveys and inspect recent network reception through the existing OSI accounts. Confirmed device positions also feed Terra and prediction inputs. Both applications support English, German, French and Italian.

An account project may predate any farm or gateway. An installation remains edge-authoritative. Planning edits have no effect on valve operation, schedules, device provisioning or installed locations until an explicit authorized action is applied by the edge.

The first release includes per-device confirmed coordinates with an explicitly labelled zone-location fallback. It captures reception metadata for every application uplink delivered to the OSI ingest boundary, across supported device types and field testers. It cannot capture transmissions that the network server never delivers, and does not claim packet-delivery ratio without attempted-transmission evidence.

## 2. Verified baseline

Inspected working-tree sources at osi-os HEAD `d6d8b66cd` and osi-server HEAD `122a1470`; unrelated local edits are outside this proposal. The planner exists separately at `../osi-planner`, initial commit `ea2dea0`.

- `database/seed-blank.sql` has `field_tester_uplinks` and per-gateway `field_tester_rxinfo`: coordinates, GPS quality, radio parameters, RSSI/SNR and deduplication IDs already exist for field testing.
- Maintained Node-RED flows expose `/download-fieldtest`. General reception capture must cover the common uplink input rather than depend on a successful device decoder.
- `docs/twatch-ultra/05-mvp-design.md` describes attempted transmissions and survey metrics. It is design input, not evidence that those capabilities are shipped.
- Cloud `TerraDeviceAnchorWriteService` writes an anchor snapshot directly, using anchor revision and inventory-fingerprint preconditions. `ZoneSensorAnchorService` is a legacy adapter to that v2 model. `PredictionSpatialUnitAssembler` consumes device anchors today.
- Current sync contracts live in `docs/contracts/sync-schema/`. The new resources and commands described here have not been added to those contracts.

Implementation must recheck these sources against the selected paired branches, including AgroLink device support. Existing cloud anchors require the explicit transition in section 6.

## 3. Ownership and user workflow

| Fact | Authority | Offline behavior |
|---|---|---|
| Account project, membership and shared scenario head | OSI Server | Edge keeps a versioned working copy; disconnected edits become proposals |
| Unlinked local project | Its creating edge until claimed | Editable locally; claim imports an idempotent snapshot into an account |
| Installed location and radio configuration | Assigned edge | Local authorized changes apply immediately and queue sync |
| Raw reception and local survey records | Originating edge | Persist locally and upload later |
| Cloud analysis and simulation artifacts | Producing service, immutable inputs | Saved artifacts can be viewed offline when downloaded |

Workflow: create project → add scenarios → simulate → bind planned endpoints to real identities → confirm installation → observe/survey → compare. Binding and location confirmation never implicitly provision a device or command a valve. A multi-gateway confirmation exposes each gateway's pending/applied/rejected state; there is no fictional distributed transaction.

Existing local authentication controls local edits. Linked account permissions control project download and cloud publication. New cloud installation commands must pass normal edge authorization and expected-version checks. Local and cloud roles must not be treated as interchangeable credentials.

## 4. Shared domain contract

Use UUIDs for projects, scenarios, revisions, installation epochs and observations, plus normalized existing gateway/device EUIs and zone UUIDs. WGS84 coordinates use explicitly named latitude/longitude fields; GeoJSON coordinates remain longitude-first. Times are UTC with separate observation and ingest times. Unknown numeric values are null, including antenna gain and GPS accuracy. A supplied zero is a value.

### Projects and snapshots

A project has an owner account, optional farm association, title, lifecycle status and explicit memberships. A scenario revision contains proposed endpoints, device/variant identifiers, assumptions, radio settings and search extent. Each endpoint has a stable planning UUID independent of its eventual DevEUI.

Simulation snapshots preserve scenario revision, canonical input hash, model/catalog versions, terrain source/resolution/datum, RF assumptions, search bounds, warnings and artifact checksum. Re-running creates a new snapshot. Save meaningful comparisons independently of the planner's expiring job cache.

Offline scenario edits carry their base revision and request UUID. Server publication uses optimistic concurrency. If the head changed, retain the local work as a conflict copy; never last-write-wins overwrite either version. Offline project creation can be claimed once using its original UUID and authenticated ownership handshake.

### Installed locations

An installation location revision contains subject kind (gateway/device), subject identity, installation epoch, authority gateway, coordinates, horizontal accuracy, coordinate source, optional elevation with vertical reference, antenna height AGL, effective-from and recorded-at times, actor and revision/supersession identity. Radio configuration revisions separately capture gain, feeder loss, transmit-power setting and verified/assumed/user provenance. Preserve unknowns.

Per-device coordinates are independent of zone assignment. A resolved position returns `confirmed_device`, `confirmed_gateway`, `zone_fallback` or `unknown`, with the exact referenced version. Zone fallback never writes a manufactured device position. Probe/channel depth and any explicit probe offset remain separate from the radio endpoint. Reuse existing canonical probe-depth fields; do not introduce another calibration or depth authority.

Intervals are nonoverlapping per subject and installation epoch. Ordinary edits are effective now. Explicit retrospective corrections retain the original assertion and record a replacement with its effective interval; saved comparisons keep their original resolved context. Late uplinks resolve against observation time, with uncertainty exposed when clock or interval information is inadequate. Reassignment to another gateway creates an authority epoch; the prior gateway cannot edit the new epoch.

### Uplinks and receptions

Store one source uplink event plus zero or more gateway-reception rows. Proposed edge tables: `radio_uplinks`, `radio_receptions`, `installation_location_revisions`, `installation_radio_revisions`, `radio_sync_batches`, and `radio_retention_gaps`. Reuse or adapt survey tables after checking their actual shipped state.

Uplink fields include source gateway/installation epoch, network-server namespace, native deduplication ID, DevEUI, observed/ingested times, frame counter, session discriminator when available, frequency, SF, bandwidth, coding rate, ADR and decoder status. Native deduplication identity is scoped to its network-server source. Frame counter alone is never an identity. If no stable native identity exists, persist a local ingress UUID and mark cross-delivery deduplication uncertain rather than collapsing plausible distinct transmissions.

Reception fields include parent uplink UUID, receiving gateway identity, receiver installation revision if known, uplink receiver ID when supplied, RSSI dBm, SNR dB, channel, CRC status if supplied and timestamp quality. Preserve all distinct receiver entries and deduplicate replayed entries by a specified canonical key. Unknown receivers retain their identifier but gain no invented location. Global cross-server correlation is optional derived metadata, not destructive merging of source records.

Do not duplicate AppKeys, session keys or raw application payloads into this store. Existing sensor measurements stay canonical in their current tables. Where possible link a measurement to its uplink UUID; legacy time-based association must report ambiguity.

## 5. Edge capture, persistence and synchronization

Add one common capture path for `application/+/device/+/event/up`, before device-specific filters. Decoder failure must not discard RF metadata. Avoid attaching independent writers to every device branch. Do not turn radio-storage failure into loss of normal sensor ingest or blocked valve control; report the failure and its time span visibly.

Persist uplink and receiver rows transactionally, with a durable monotonically ordered local sequence for upload. Corrections and late receiver additions receive their own change sequence; they must not hide behind an already acknowledged parent cursor. Use short transactions and indexes for time/device/gateway queries. A bounded ingest buffer must count and expose overflow; no silent drop policy.

Transport uses authenticated REST and dedicated bounded history batches, not one existing operational outbox event per receiver and not cloud-to-edge MQTT. Proposed route: `POST /api/v1/sync/radio/batches`. Envelope: schema version, source gateway and installation epoch, stable batch UUID, sequence range, content hash, uplinks, receptions and gap records. Proposed acceptance capability: `radio-observations-v1`.

Cloud acceptance is atomic per batch. Identical retry returns the same durable acknowledgement; reused identity with different content is rejected. Persist ACK cursor only after cloud commit; a crash then causes safe replay. Validate parent references, ownership and monotonic ranges. A bad batch is quarantined with a visible error and repair/export path; do not silently acknowledge it. Poll ordinary commands and deliver operational events ahead of historical catch-up.

Initial proposed budgets: batches up to 500 uplinks, 2,000 receptions or 512 KiB encoded, whichever first; one history upload in flight per edge, at most one batch per 10 seconds while draining. Receiver fan-out beyond the batch limit splits into subsequent changes with valid parent references. Version/capability acceptance lands on cloud before edge production is enabled. An older cloud leaves capture local with a visible unsynced backlog.

### Storage and retention

Initial configurable defaults for review: edge raw history 30 days, cloud raw history 180 days, hourly summaries 2 years. Edge RF storage budget starts at 512 MiB and must be verified on a measured fleet workload before enabling capture by default. Report record counts, bytes, oldest unsynced time and receiver fan-out.

Unacknowledged records are not removed by ordinary age pruning. Disk-pressure handling pauses new RF capture at the configured hard limit and records a durable gap/counter where possible; it does not fill the disk or jeopardize agronomic history. Expose this degraded state on edge and cloud. Operators can export or explicitly discard backlog with an audit entry. Separate command traffic remains available.

Pinned survey/comparison evidence has a manifest, checksums and reserved quota. Pinning succeeds only after the evidence is durably retained in a permitted location; pending upload is not a successful pin. Account deletion or explicit privacy deletion can supersede a pin, leaving the report labelled evidence unavailable. Default retention values are deployment settings, not radio-model constants.

## 6. Harmonizing existing Terra anchors

Do not create a second editable coordinate store beside Terra v2 anchors. Inventory and anchor revision/fingerprint checks remain part of the shared location facade.

For edge-backed zones, existing cloud anchors become preserved legacy assertions. Offer them to the edge as installation-location proposals with provenance `legacy_terra`; they become confirmed only after edge validation and application. Keep the legacy snapshot visible during migration. Do not fabricate historical effective times, accuracy or installation height.

Enable the new authority mode per gateway only after capability negotiation and reconciliation. In that mode both the legacy anchor API and v2 UI submit pending installation edits through the shared facade; neither may write confirmed coordinates directly. A stale base revision or changed device inventory produces conflict, not an overwrite. During transition consumers receive explicit legacy/confirmed/fallback provenance. Before enabling prediction use of the new facade, verify equal outputs for unchanged legacy anchors.

Unlinked cloud planning remains cloud-owned. An edge-created local project can attach to an account without claiming unrelated cloud resources. Moving or sharing a project does not grant access to a device's historical telemetry; authorization is independently checked.

## 7. Edge UI and local APIs

Add project list, scenario editor, installation confirmation, survey sessions and network map to the existing authenticated GUI. Reuse the planner UI/calculation contract through a maintained shared package or module boundary; do not fork its RF formulas into both frontends. Replace the standalone shared-key login with host-account integration.

Local proposed endpoints under `/api/planning/` expose local projects/scenario proposals and saved artifacts. `/api/network/observations` and `/api/network/map` are authenticated bounded read models. Installed-location changes go through one service used by Terra adapters and the planning UI. Exact route names must be reserved against current routes during implementation; API schemas must specify pagination, limits and error envelopes before coding.

Offline users can edit working copies, confirm authorized local installations, record observations and view cached plans. New simulations run through an available authorized calculation service; if it is unreachable, retain the request and show unavailable/queued-local state. A Pi is not required to run Rasterio or provide offline terrain calculation in v1. Never display a cached simulation as a newly computed result.

## 8. Measured maps and comparisons

Default network view uses the last 24 hours, with 1-hour and 7-day presets and explicit as-of time. Show sample count, last contact, median and lower-tail RSSI/SNR, grouped by device, receiver and radio settings. Unplaced devices remain in a list. A freshness threshold uses known expected cadence when available; otherwise say last seen, not offline.

Fixed endpoints establish observations at points and links. They do not establish coverage in unsampled ground. Keep measured points, survey cells and predicted coverage in separately labelled layers. No received-packet map may label unsampled cells failed. Packet-delivery ratio requires a reliable attempted-transmission log and explicit exclusion of non-transmissions; frame-counter gaps alone are insufficient.

Comparison samples the model at each actual observation position for the matching receiver and time-valid radio installation. Residual is measured uplink RSSI minus predicted uplink receive power in dB. SNR remains separate unless the model explicitly predicts noise. Downlink reliability requires downlink evidence. Unknown tester gain, TX power or height produces an assumption-labelled comparison or exclusion according to the saved comparison policy.

Keep raw samples immutable. A comparison manifest records observation IDs, time window, location/radio revisions, assumptions, sample counts, excluded/unknown observations and prediction snapshot. Model calibration is a later opt-in analysis with separate validation data and no automatic replacement of the original simulation.

## 9. Acceptance and rollout

Paired phases:

1. Freeze shared schemas and identity vectors; establish location facade and legacy-anchor reconciliation design.
2. Cloud batch acceptance and migrations; edge location history/capture behind disabled flags. Teams can work in parallel against frozen fixtures.
3. Enable edge upload and confirmed-location commands after capability checks; verify restart/replay, conflicts and storage limits.
4. Account projects/offline working copies and measured map can proceed in parallel once contracts are stable.
5. Survey matching and simulation comparisons; then Terra/prediction provenance integration and parity checks.
6. Test-server and test-gateway pilot, storage soak, staged enablement. Production rollout is a separate authorized operation.

Required acceptance cases: every supported decoder and malformed payload still yields metadata; one uplink heard by three gateways yields one source event and three receiver rows; duplicate delivery/retry/restart produces no extra records; equal frame counters in new sessions do not collapse; late receiver additions sync; delayed samples use old locations; zone fallback is visibly approximate; cloud conflict cannot overwrite a local move; unsupported cloud does not lose backlog; disk pressure preserves sensor/control operation; unauthorized project/device access fails; archived comparisons survive ordinary retention; GPS/clock uncertainty remains visible.

New SQLite behavior uses ordered migrations and mirrors maintained Pi payloads byte-for-byte. Do not edit frozen boot DDL or reseed a provisioned database. Sync resource/canonicalization contracts are edge-owned with paired server acceptance and tests. Implementation gates include schema/profile/sync verifiers, GUI tests/build, idempotence tests and provisioned-copy migration rehearsals. This documentation change runs prose/link checks only.

## 10. Review resolutions: identities, ordering and lifecycle

### Source authority and upload ordering

The source network-server installation owns an uplink event. Its designated OSI ingest edge persists the event and every receiver entry supplied by that network server. Receiving gateways are not additional owners of that same source record. Configure one ingest producer per network-server namespace; changing that producer requires an explicit producer epoch and handover, not simultaneous competing writers. Independent network servers retain independent source events even when they heard the same over-air transmission. The map can show correlation candidates, but must not count them as a proven single transmission or derive delivery ratio from them. The one-event/three-receiver acceptance case means one network-server event containing three receivers.

Within a producer epoch, use contiguous change sequences. Cloud accepts only the next contiguous batch or an identical committed retry. An out-of-order future range receives a retryable sequence-gap response with the durable expected sequence; it is not acknowledged or buffered indefinitely. Thus the reordered-batch test expects safe rejection and subsequent successful replay in order. A correction has its own UUID and sequence and references the immutable assertion it supersedes. A late receiver addition has its own stable receiver-record identity and a new sequence referencing the persisted parent. Batch identity, record identity and correction identity are separate. The cloud ACK is the highest contiguously committed sequence, never the highest merely observed sequence.

### Permission intersection and offline use

A local operator with existing installation-edit permission can edit installed locations offline for that edge's current authority epoch. Cloud project membership alone confers no local installation-edit permission. Publishing a shared scenario requires online account authentication and current project editor/owner permission, rechecked at publication; a cached membership cannot authorize publication after revocation. Users without bound-device access can edit permitted hypothetical scenario endpoints but cannot fetch installed context or reception evidence for that device.

Cloud observation queries, clusters, summaries and exports apply the intersection of current project access (when project-scoped) and current resource access before aggregation. Local observation reads use existing local gateway authorization and expose only records available to that edge. Offline account working copies contain only explicitly downloaded authorized snapshots. Revocation takes effect at the next online check; already downloaded evidence cannot be recalled. Account logout removes the application cache, while user-exported files remain outside its control.

### Retention and deletion

Age pruning is local to each store and does not send a semantic deletion to the other: cloud may retain 180 days after edge's 30-day pruning. Explicit deletion is different. A location correction preserves history; it is not a privacy deletion. Account/project archive removes neither installed device state nor agronomic data.

An explicit authorized radio-evidence erasure creates a durable deletion record scoped to resource, ownership epoch and observation interval. Cloud applies it to its evidence/artifacts immediately and sends a REST pending erasure command to each source edge; an authorized local erasure publishes the corresponding deletion event. Each side acknowledges durable application, redacts invalidated comparison manifests and prevents later replay from restoring erased records. Pinned evidence cannot override an explicit erasure. Unacknowledged matching upload records are removed or replaced by a gap/deletion change, with sequence continuity retained.

Deletion suppression records remain for the lifetime of an upload-capable producer epoch. Final account unlink/revocation closes that epoch and rejects all subsequent uploads under it; a new link receives a new epoch and cannot automatically re-import erased historical data. Audit records keep deletion request identity, scope, actor and completion status without retaining deleted coordinates or reception values. A disconnected edge is shown as erasure pending until it acknowledges; cloud never claims remote physical deletion has already happened.

### Complete anchor cutover

Before enabling confirmed-location mode, inventory every anchor writer: legacy and v2 APIs, imports, background reconciliation and recomputation triggers. All must use the facade or become read-only for that gateway. Old clients that cannot represent pending state receive an explicit upgrade-required error on writes; they must not receive a false successful confirmed snapshot.

Legacy-mode zones continue the existing cloud anchor behavior with legacy provenance until explicit reconciliation/cutover. Confirmed-mode gateways stay in that mode when offline: cloud edits remain pending rather than reverting to direct writes. Retrospective corrections specify their effective interval and superseded assertion; dependent recomputations select a declared corrected-context version. Previously saved comparisons and historical prediction manifests retain their original location and anchor revision references. Late observations resolve against the interval and authority epoch, never by reading only the current anchor row.
