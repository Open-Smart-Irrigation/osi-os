# Sync-contract deploy order, v0.8.1 to main (2026-11-09)

Pre-flight item "Decide whether the sync contract changed since the previous
release" (`docs/versioning-workflow.md`) for the next edge release.

- Edge: `v0.8.1` (5e20911a6) to `origin/main` f360e9eba.
- Cloud: osi-server `origin/main` 3f670d6e9 (2026-11-09).
- Scope: `git diff --stat v0.8.1..origin/main -- docs/contracts/`, 35 files,
  +6969/-1012.
- Method: read-only. Each file traced to its commits with `git log`; server
  support checked with `git grep` and `git show` on osi-server `origin/main`;
  event-op parity run against exported server trees (below).

## Event-op parity

`OSI_SERVER_EDGE_SYNC_SERVICE=<export>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js`,
with the server's `backend/src/main/java` exported by `git archive`:

| osi-server revision | Result |
|---|---|
| 3f670d6e9 (main, 2026-11-09) | `verify-sync-op-parity: OK (44 server ops; 17 via EdgeSyncService switch, 27 via SyncEventApplier classes in 20 files)` |
| 460c424b (#389, 2026-10-27) | `OK`, same counts |
| 0534ae13 (#372, 2026-10-18) | `FAIL (40 server ops ...)`, `server missing from union: IRRIGATION_POLICY_DECISION_UPSERTED, IRRIGATION_POLICY_RUNTIME_CHANGED, IRRIGATION_POLICY_UPSERTED, IRRIGATION_POLICY_VALVE_RUNTIME_CHANGED` |

All three runs report the six journal ops as "server ahead of edge activation"
(sanctioned). The cited server commits form one line on osi-server main:
26d81145, 8288a4a6, 0534ae13, 460c424b, 6e42a93a, 3f670d6e9.

Server mirror check: `resources.schema.json`, `canonicalization.md` and
`conditional-irrigation-v1.schema.json` are byte-identical to the edge on
`origin/main`. The server's `commands.schema.json` and `events.schema.json`
mirrors differ in bytes but contain every edge command type and event op (array
order and cloud-only branches differ). The server mirrors are test resources;
the server does not validate live DEVICE payloads against them.

## Changes by contract

Direction: **edge-sends** widens what the edge sends (cloud must accept first);
**cloud-sends** widens what the cloud sends (gateways first, or a capability
gate); **value-only** changes values or display with no shape change;
**docs-only** has no runtime effect.

| Contract | Change | Direction | Server side on osi-server main? | Capability gate | Required order | CHANGELOG note? |
|---|---|---|---|---|---|---|
| sync-schema: `events.schema.json`, `resources.schema.json` (`IrrigationPolicy*` refs), `conditional-irrigation-v1.schema.json`, `conditional-irrigation-runtime-validation-cases.json` | Four new event ops: `IRRIGATION_POLICY_UPSERTED`, `_RUNTIME_CHANGED`, `_VALVE_RUNTIME_CHANGED`, `_DECISION_UPSERTED`; `VALVE_SCHEDULE` payloads gain `condition_policy_uuid` / `effective_from` (a runtime payload, held by the same outbox filter; no schema edit). Edge 33cdfae5f (#515). | edge-sends | Yes: `IrrigationPolicyApplier`, `IrrigationPolicyRuntimeApplier`, guarded routes `/auth/local-sync/conditional-irrigation-v1`, `/api/v1/sync/edge/{bootstrap,events}/conditional-irrigation-v1`. 460c424b (#389). | Edge self-gates on the cloud reporting `conditional_irrigation_v1`: the 0077 triggers emit only then, and the outbox and force-sync builders exclude `IRRIGATION_POLICY_%` and conditional `VALVE_SCHEDULE` rows otherwise. Support is re-read every sync cycle, so a linked gateway starts replicating after a cloud upgrade without re-linking. | Cloud first (at least 460c424b) for the feature. Against an older cloud nothing is rejected: the events wait in the outbox. But parity fails below 460c424b, and a link or re-link of a gateway that holds a live policy takes the guarded route and fails closed. | No |
| sync-schema: `commands.schema.json` | Three new command types `UPSERT_IRRIGATION_POLICY`, `PAUSE_IRRIGATION_POLICY`, `RETRY_IRRIGATION_VALVE` and their fields (`policy_uuid`, `expected_policy_version`, `condition`, `schedules`, ...); `PAUSE` accepts `expected_policy_version: null`. Edge 33cdfae5f (#515). Most of the +2864/-1012 textual diff is reformatting. | cloud-sends | Issuer present: `IrrigationPolicyCommandService`, `GatewayCommandCapabilityPolicy`. 460c424b (#389). | Yes: `GatewayCommandCapabilityPolicy.requiredCapability` maps all three to `CONDITIONAL_IRRIGATION`; `mayDeliver` requires every linked account to have reported `conditional_irrigation_v1`. The edge advertises it from #515 on (`docs/api/sync-endpoints.md`). | None beyond the gate: a v0.8.1 gateway never reports the token and receives none of these commands. | Partial: `[Unreleased]` / Changed has the `PAUSE` null entry; it names no order. |
| sync-schema: `resources.schema.json` `TensiomarkChannelLayout` | New value form of DEVICE `sdi12_channel_layout_json`. Edge 55b3d4b7b (#503). | edge-sends | Yes. The DEVICE applier stores the field as a JSONB map (`EdgeSyncService` `jsonObjectMap`), so an older cloud stores it without understanding it; Tensiomark readers from 0534ae13 (#372). | None | Cloud first, soft: an older cloud stores the layout and does not interpret it. | No |
| matric-potential: `v1.md`, `observation-v1.json`, `vectors.json` | New history table `tensiomark_observations` (hash v1, key `TENSIOMARK_OBSERVATION\|<gateway>\|<id>`); pF conversion keeps negative pF below 0.1 kPa. Edge 55b3d4b7b (#503). | edge-sends (table); value-only (pF display) | Yes: `TensiomarkObservationMirror`, Flyway `V2026_10_16_001`. 0534ae13 (#372). The three files are byte-identical on the server. | None. A cloud without the mapper answers `REJECTED_PERMANENT` / `unsupported_table` (server since 0c26767f); the edge leaves that cursor unadvanced and rotates to the other tables (`scripts/test-tensiomark-precision.js`). | Cloud first, soft: before it, observations stay pending and other history continues. The contract says "Deploy cloud support before edge emission". | No |
| sync-schema: `resources.schema.json` `push_state` | Optional `lost`, `scheduler_status_lost` and per-weekday `lost`; `lost` is a subset of `failed`. Edge d3ba6b9fb (#506), wording 55ec323f9 (#514). | edge-sends (optional, additive) | Stored: `ValveRuntimeApplier` keeps `push_state` as a JSONB passthrough (since `V2026_08_26_002`). Displayed from 460c424b (#389). | None | None. An older cloud keeps the keys and shows the slots as failed. | No |
| sync-schema: `canonicalization.md`, `resources.schema.json` `archived_at` | Snapshot producers derive `archived_at` from `observed_close_at`, else `commanded_at`, no longer `expected_close_at`. Edge a4d4d3f8c (#572). The SWT pF section is relabelled legacy (55b3d4b7b, #503). | value-only (archive); docs-only (pF section) | Appliers unchanged: both paths ignore a strictly older value and apply an equal one. Test mirror 6e42a93a (#395). | None | None. Residual: a cloud row that already holds a legacy `archived_at` taken from `expected_close_at` is later than the new `commanded_at` value, so the new snapshot is ignored and that row does not converge. Correcting those rows is separate work (#331 stays open). | No |
| sync-schema: `README.md`; rainfall: `zone-day-projection.md`, `README.md` | `ZONE_ENVIRONMENT_APPENDED`, bootstrap and history rows gain `rain_coverage`, `rain_selected_deveui`, `rain_policy_version`, `rain_quality_reasons`, `rain_received_mm`; `rainfall_mm` is null unless coverage is `complete`, and a present null replaces the stored amount. Contract f6380b888 (#489), cc4269b89 (#493); edge emission 044a182b0 (#497). All after the v0.8.1 tag. | edge-sends | Yes: receiver and Flyway `V2026_10_10_001` in 26d81145 (#366). | None | Cloud first, hard. An older cloud does not reject the rows; it reads `rainfall_mm: null` as "keep the previous value" and a new row as 0 mm, so cloud rain and advice go wrong without an error. | No (the order is stated only in the contract and the sync-schema README) |
| rainfall: `rain-resolution-policy.md` | One rain-resolution order for edge and cloud advice. 98fd1fee1 (#492). | value-only | Cloud consumers 8288a4a6 (#368). | None | Either order. From 8288a4a6 the cloud advice reads rain the same way the edge does. | No |
| rainfall: `lorain.md` | Owner decision replaces D4: elapsed-time LoRain rates are cleared. Edge migration 0078 (data) nulls them; the device_data update trigger queues each cleared row as a history correction. d1cc14b7d (#584). | value-only (data) | Yes: Flyway `V2026_10_30_001` clears the cloud copy. 3f670d6e9 (#396), today's server head. | None | Gateways before 3f670d6e9, or in the same release window. Edge first: an older cloud stores the corrected nulls and still offers the emptied channel until 3f670d6e9. Cloud first: a v0.8.1 gateway still writes the elapsed-time rate (the edge writer stopped in 1a2ad3412, #488), so rows it sends after the one-time Flyway clear keep it in the cloud, not shown or exported, until that gateway's 0078 re-sends them cleared. | No |
| sync-schema: `journal-mutation-rejection-v1.schema.json`, `-golden.json` | Receipt definition for the journal V2 mutation 400 body. 25658521a (#574). | docs-only | Absent on the server; no producer or consumer in either repo. | n/a | None | No |
| radio-observations: `v1.md` | Tester GPS decoded only for `RAK10701_FIELD_TESTER` fPort-1 frames; capture flag on only for `1`/`true`. 56a660982 (#398). | value-only | n/a (no shape change) | None | None | No |
| swt-water-status: `README.md`, `vectors.json` | Display bands to 1,000,000 kPa; stale-reading pill. 945027b1f (#508). | value-only (display) | `vectors.json` byte-identical on the server. | None | None | No |
| vwc-display: `README.md`, `vectors.json` | VWC display formatting contract. 5d9426a2b (#509). | value-only (display) | `vectors.json` byte-identical on the server. | None | None | No |
| zone-env: `README.md`, six `cases/*.expected.json` | `reasonCodes` on drift, `fallbackReasonCode` on display, elapsed provider rain evidence. 60e74b37a (#496), 63a3cf188 (#582), 5dce03738 (#583). | docs-only (local REST response; the README states that nothing syncs or mirrors these fields) | n/a | None | None | No |
| history-source-v2 (4 files); history-router `cases/series-aggregate`, `cases/csv-export`; dendro `edge-node-cases/daily-analytics` | Per-host history API identity and aggregation vectors; edge-local outputs. 045bc846d (#502), 55b3d4b7b (#503), 60e74b37a (#496). | docs-only for sync (host HTTP responses, not sync payloads) | history-source-v2 vectors byte-identical in server `backend/src/test/resources/history-source-v2/`. | None | None | No |

## CHANGELOG gap

`CHANGELOG.md` `[Unreleased]` at f360e9eba had no "Upgrade notes" section. The only
contract-related entry is the `PAUSE_IRRIGATION_POLICY` null entry under
"Changed", and it names no order. `docs/versioning-workflow.md` requires the
upgrade notes to name the order for every change that widens what either side
sends. Before the release, the notes need at least:

- conditional irrigation, cloud first (osi-server 460c424b or later);
- zone-day rain quality fields, cloud first (26d81145 or later, hard);
- Tensiomark observations and layout, cloud first (0534ae13 or later, soft);
- the three conditional commands, capability-gated by the cloud, no gateway-first step;
- LoRain rain rates, gateways before or with osi-server 3f670d6e9 (#396);
- the `archived_at` residual for cloud rows that hold a legacy future value.

The change that adds this report writes those notes under `[Unreleased]`.

## Release order

This edge release can go to linked gateways only against an osi-server
revision at or after 460c424b (#389, 2026-10-27), the lowest revision that
passes the pre-flight gate `verify-sync-op-parity.js`. It contains every
cloud-first receiver in the table.
Current server main (3f670d6e9) also passes and adds the LoRain cloud cleanup
(#396); after that deploy, upgrade LoRain gateways in the same release window
(see the LoRain row). 26d81145 (#366, 2026-10-10) is the data-safety floor. Below it, the zone-day
rain fields leave wrong rain on the cloud with no error. Between 26d81145 and
460c424b, delivery keeps working: conditional events wait in the outbox and
Tensiomark observations wait until 0534ae13. Parity still fails there, and a
gateway that holds a live conditional policy cannot link or re-link. No item
needs gateways first: the cloud sends the three new command types only to
gateways that report `conditional_irrigation_v1`. The production cloud
revision is not known to this report. Read its `BACKEND_IMAGE_TAG=sha-<short>`
and run `git -C <osi-server> merge-base --is-ancestor 460c424b <sha>`. If that
fails, a cloud release (Step 6) must come before the edge release is published
and before any linked gateway is upgraded. The CHANGELOG upgrade notes above
must be written before Step 7 in either case.
