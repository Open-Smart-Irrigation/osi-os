# Network planning: consolidated external review

Date: 10 September 2026. Verdict: the external review correctly identifies defects in the initial specification. The paired specs have been rewritten around fetched main, with the qualifications below. They are proposed design documents; readiness contracts still precede schema freeze.

Reviewed inputs: external review file `2026-09-09-network-planning-observations-design-review.md`, [revised edge spec](2026-09-09-network-planning-observations-design.md), [revised cloud spec](../../../../osi-server/docs/superpowers/specs/2026-09-09-network-planning-observations-design.md). The external review remains its author's untracked file; this consolidation neither changes it nor commits it. The external review is not bundled with this commit.

## Evidence method

Fetched `origin/main` in both repositories and inspected tracked objects with `git show`/`git grep`, leaving the dirty edge checkout untouched. Baselines: edge `492935d3e6d43378be52620efff54fa42e619844`; cloud `122a14708acf7a56d07e2196cf38fa143e83192a`. Main's source contents, not working-tree line numbers in the external report, determine the decisions below. No production system was inspected and no runtime validation is claimed.

## Blocking findings

| ID | Disposition and specification change |
|---|---|
| B1 | Accepted with precision: edge lacked 335 main commits. Server's original SHA already equals fetched main; the error there was failure to notice durable history, not a stale server SHA. Both baseline sections now name actual main mechanisms. |
| B2 | Accepted: removed new route, envelope, sequence protocol, radio batch table and radio capability. Radio is a history-v1 table stream with embedded receivers and dirty-key correction. Corrected ACK language: validation quarantine may advance; hash/order failures and retryable errors stop the prefix. |
| B3 | Accepted: gateway revisions excluded from v1. `gateway_locations` remains sole writable authority. Receiver observation context snapshots a fix/version if applicable; stale or unavailable historical fixes stay uncertain. No new manual writer competes with gpsd. |
| B4 | Accepted: cloud projects plus account-partitioned browser copies. Pi stores no projects or per-user cloud tokens. Cloud account functions launch in the cloud origin; local imported data can be edited offline. No implicit project command stream or cross-origin auth proxy. |

Transport evidence: server `backend/src/main/java/org/osi/server/sync/history/EdgeHistoryIngestService.java`, methods `applyBatch`, `applyOrQuarantine`, `stopBeforeFirstRow`; `docs/sync/history-sync-v1.md`; edge canonical payload `osi-history-sync-helper/index.js` and `sync-history-build` in flows. Main code explicitly advances the cursor on validation quarantine, stops on hash mismatch, and rejects an unsupported table before the first row. The external report's shorthand listing statuses must not be read as acknowledging all permanent errors.

## Important findings

| ID | Disposition and specification change |
|---|---|
| I1 | Accepted. Confirmed position and analytical eligibility are separate. Cloud polygon/inventory checks cannot reject edge truth. V1 leaves legacy anchors untouched; later facade uses the known single writer. Edge commands check edge revision/assignment, not a cloud-only fingerprint. |
| I2 | Accepted topology and key evidence; qualified migration recommendation. There are nine subscribers on main. Generalize the field-testing capture branch/helper, retain other decoders, and preserve legacy tester tables/export in v1. Immediate retirement/payload deletion is not necessary to capture RF and risks historical/export regressions. New RF rows exclude payload bytes. Document restart loss explicitly. |
| I3 | Accepted. Added device-reported coordinates, GPS quality/source/time and reported-position precedence for surveys. Unknown codecs leave these null. |
| I4 | Accepted as a design choice with a dependency. Use dedicated radio.db and keep installation resources in farming.db. Existing history code assumes its DB adapter; a new source adapter and durable dirty-marker bridge are required. Scratch-branch primitives are not treated as merged. |
| I5 | Accepted. Name DEVICE_INSTALLATION_LOCATION and DEVICE_RADIO_CONFIGURATION, classify PROTECTED and migration-owned, and require the 50,000-row outbox cap/retention verifier. |
| I6 | Accepted. All seven host locales and their review/parity gates apply, including Luganda release review. Standalone compatibility does not define host locale scope. |
| I7 | Accepted need for explicit offline behavior. V1 shows cached coordinates/markers on a labelled plain background without tiles. No offline tile infrastructure or Mapbox token dependency. Bundle checks are required; the review's workstation OOM statement was not independently reproduced. |
| I8 | Accepted. Name UI extraction, canonical edge planner-core, deterministic vendoring/byte-parity checks, host adapters and translation/catalog consolidation. Standalone route stays available until migration/parity pass. |
| I9 | Accepted mechanism correction. No radio capability. Proposed installation_locations_v1 follows edge syncCapabilities/support-state and staged cloud acceptance. Unknown table is handled by actual history response, not fictional reverse advertisement. |

Geometry/writer evidence: cloud `zone/TerraDeviceAnchorWriteService.java` validates full inventory and polygon coverage; `ZoneAnchorInventoryJdbcRepository.replaceSnapshot` has one call site. GPS evidence: edge seed `gateway_locations`, its GATEWAY_LOCATION_UPSERTED triggers and cloud GatewayLocationApplier. Locale evidence: both main GUI `src/i18n/config.ts` files. Capture evidence: Field testing `Build FT SQL` and the nine MQTT nodes in canonical flows. Scoped permissions: `docs/adr/2026-07-19-scoped-multiuser-access-model.md` on edge main.

## Simplifications and additional review findings

- Removed cross-network-server correlation from scope. The ordinary topology is one joined network server publishing one event with multiple receivers. We do not assert that every possible forwarding/test topology is impossible; no correlation product is required here.
- Deferred survey-track erasure to the survey phase. Fixed operational evidence uses retention policy. This is a scope decision, not a claim that operational records are exempt from account deletion or privacy requirements.
- Reused server pacing fields and existing zone-location command structure. Deferred device_data linking. Cited scoped role and resource-access behavior instead of generic local authentication.
- V1 now has explicit non-goals. Account projects and comparison remain required later phases of the agreed product, rather than being quietly dropped.
- Additional blocker for broad capture: history-v1 manifests expect zero tombstones and the cloud currently preserves canonical history. The initial 30/180-day automatic retention would conflict with manifest repair. Withdrawn those defaults; bounded v1 capture pauses at its storage budget. A compatible radio retained-segment/archive policy is required before broad enablement.
- Additional integration gate: separate WAL databases cannot provide an assumed atomic mutation-plus-dirty-key transaction. The radio source needs an in-database correction marker and crash-safe idempotent bridge to the existing dirty queue, with restore/row-identity tests.
- Additional identity gate: the existing receiver key includes a nullable numeric ID. Its canonical null behavior must be frozen in cross-runtime vectors; SQLite UNIQUE constraints do not deduplicate NULL values by themselves.

## Remaining readiness gates

The obsolete transport and authority decisions are resolved in the documents. Before schema freeze, produce and review concrete radio database lifecycle/source-adapter recovery contracts, radio canonical columns/hash and receiver-null vectors, request/fan-out bounds, and the location resource/command/scoped-access matrix. These are bounded design dependencies, not reasons to reintroduce a second protocol.

Before broad deployment, prove retained-segment/archive compatibility, storage capacity and command responsiveness on a designated test gateway. No deployed migration state was inferred from migration filenames. Main contains ordered migration 0053 and cloud future-dated Flyway files; actual applied versions must be checked during an authorized deployment.

Verification for this revision: inspect main-source evidence, check document links and stale-protocol contradictions, run prose checker and git whitespace checks. Runtime tests and migration rehearsals remain implementation requirements.

A second bounded reviewer independently checked history adapter registration, the cross-database bridge, identity/hash handling and ACK semantics. Its useful findings are incorporated above. Two qualifications: receiver-local ID collisions are avoided by using the parent radio row as the history key and embedding receivers; adding a new table does not itself require changing hash-v1 for existing streams. Existing hash semantics must remain byte-compatible, with new radio fixtures proving the extension.
