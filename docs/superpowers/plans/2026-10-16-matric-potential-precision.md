# Matric potential precision implementation plan

> **For agentic workers:** Use the existing subagent execution and independent review workflow. The user has authorized implementation and verification.

**Goal:** Use the same hPa-convention equation for every matric-potential sensor, retain received pF from qualified live Tensiomark observations, and remove early rounding from their canonical channels and SWT conversion/export paths.

**Architecture:** A sensor-independent mathematical helper converts signed potential magnitude; adapters retain their sensor validity rules. Canonical soil tension remains positive kPa. Native pF is observation provenance, never a second selectable metric. The cloud mirrors the edge-computed double without recomputing it.

**Tech stack:** Node.js, SQLite, TypeScript/React, Java/Spring, PostgreSQL with an exact-text observation mirror.

**Design brief:** The user's equation selects the vendor's hPa convention. The old floor is a presentation rule, and is superseded by an explicit mathematical conversion contract. Native tokens preserve signs and trailing zeros. Binary floating-point conversion retains full double precision; this cannot make irrational conversion results exact decimal real numbers.

## Constraints

- `pF = log10(abs(kPa)) + 1`; finite zero has no finite pF and yields null. Negative pF is valid mathematics.
- `kPa magnitude = 10 ** (pF - 1)`; reject non-finite, zero-underflow and overflow results.
- Tensiomark still accepts pF 0..7, documented temperature bounds and complete validated replies only. The generic absolute value never rescues a sentinel.
- Use hPa consistently. Conventional cm water is a separate scale (0.0980665 kPa per cm); do not switch the acquisition conversion to that scale.
- Apply no decimal-place rounding to qualified live Tensiomark acquisition, persistence or transport, or to canonical SWT conversion and raw export. Existing unrelated calibration and offline interpretation contracts remain unchanged. Display strings may format decimals, but formatted values never feed calculations or persistence.
- Aggregate in canonical kPa, then convert that aggregate for pF display. Never replace it with a mean of native pF values.
- Keep the sensor recipe, depth settings, identities and calibration qualification unchanged.
- Preserve customer overlays and use only the already-authorized customer cloud and Pi. No production-cloud access or repository push.

## Review focus

Signed input, zero, sub-0.1 kPa, non-finite numbers and negative pF; exact native token spelling and two-probe association; SQLite JSON shortening an IEEE754 value; raw-only historical corrections and equal-hash dedupe; preserving older devices and unrelated history.

## Task 1: Shared mathematical contract and full-precision presentation inputs

- [x] Add `docs/contracts/matric-potential/v1.md` and `vectors.json`, mirrored byte-for-byte to the cloud.
- [x] Add `osi-matric-potential/index.js` (both Pi profiles) and matching `utils/matricPotential.ts` in both frontends. Reuse one helper per runtime from SDI12 normalization and history export; use common vectors to enforce cross-runtime parity. Java's `SoilTensionPf` delegates to `org.osi.server.history.MatricPotential`. Contract vectors, not legacy frontend pfVectors.json, are authoritative. Wire the new edge package through both profile package.json/package-lock, 98_osi_node_red_seed, deploy.sh and deployment verifiers.
- [x] Replace the old floor in mathematical `kpaToPf` and inverse functions. Preserve validity checks in sensor cards and adapters. Mark the old floor/CSV rule as legacy in the original contract, linking the new version; do not change payload-hash canonicalization.
- [x] First run failing tests for +/-30kPa => 2.4771212547196626, +/-0.05 => -0.3010299956639812, zero => null, pF-1 => .01kPa, pF1.395 => approximately 2.4831331052955703 and pF.164 => .14588142602753484. Compare numerical golden vectors with relative tolerance 2e-14 (absolute tolerance 2e-14 near zero), never exact decimal strings. Prove transport separately by exact IEEE754 equality. Cover null, NaN, infinities and overflow/underflow.
- [x] Remove early rounding from live Tensiomark kPa and accepted temperature. Preserve the native pF token at parse time as transient `nativePf` metadata; Task 2 owns its persistence shape. Assert sensor sentinels and invalid layouts still fail closed.
- [x] Remove raw SWT CSV rounding before pF conversion and pF CSV rounding. Keep chart display formatting separate. Preserve computed doubles in edge SWT aggregate stats (`statsForValues`) before API/CSV pF conversion; preserve non-SWT formatting policy. Test original canonical values remain unchanged through repeated unit switching.

## Task 2: Native pF retention and exact transport

Extend the existing observation record, with `normalization_version: 2`, `conversion: "matric-potential-hpa-v1"`, `native_pf: {"swt_1": "+1.395", "swt_2": "+0.164"}`, full-precision `channels`, and disposition inside normalized_json. Rejected observations have no valid native_pf entries. Retain original raw response, original packet and acquisition configuration. This is evidence attached to an observation, not a separate channel.

Mirror this existing table through a new v1 history table definition whose hash covers every transmitted field, including exact normalized_json TEXT. Existing device_data v1 and v2 hash definitions remain unchanged. Transfer raw_response as `raw_response_hex`, selected with `hex(CAST(raw_response AS BLOB))`, as a lossless encoded field so rejected binary/control-byte evidence does not introduce PostgreSQL TEXT NUL errors. Add a customer-cloud mirror keyed by gateway plus edge observation ID, with existing device-ownership enforcement, and extend history capability/table handling. Cloud support deploys before edge emission. A new additive edge migration installs only the observation dirty-key trigger; no new measurement columns or channel-catalog entries. A new cloud Flyway migration creates the observation mirror. The implementation files are `osi-sdi12-commissioning/tensiomark.js` (atomic observation write), `osi-history-sync-helper/index.js` (registry, typed hash membership and queries), `sync-history-build` in flows.json (correction phase), and `database/migrations/ordered/0075__tensiomark_observation_history.sql` (dirty trigger), mirrored across profiles. Cloud adds `TensiomarkObservationHistoryMapper` and `TensiomarkObservationMirror`, plus `V2026_10_16_001__tensiomark_observation_mirror.sql`; it uses the existing history worker and authenticated gateway ownership checks. All eleven transmitted fields are covered by the new table's v1 typed hash. `normalized_json` and `configuration_json` hash as TEXT, preserving their exact representation.

Capture the outbox's highest rowid inside the same SQLite write transaction before inserting a Tensiomark reading. After the insert, select only newly-created DEVICE_DATA_APPENDED rows for its aggregate key, merge the canonical channel doubles into the existing payload object, and persist with JSON.stringify. Refuse multiple matching new events rather than changing unrelated events. This changes neither event identity nor delivery semantics and completes before any consumer can see the transaction.

Tests in `scripts/test-tensiomark-precision.js` cover exact native token association, IEEE754 equality from normalizer through SQLite/event/history, source-byte transfer containing NUL, hash changes for lexical-only native differences, and dirty correction. Paired Java tests consume the same observation golden fixture and prove durable mirror insertion, replay, corrections and owner rejection. Fresh schema, upgrade preservation and all seed copies must pass existing migration and profile verifiers.

Ensure the ordinary kPa append event uses the exact JS value rather than SQLite json_object's shortened decimal. Cover actual SQLite write, outbox payload, JSON serialization, history hashing and cloud persistence with exact double comparisons. Historical kPa and raw provenance corrections use their respective history tables and dirty keys.

## Task 3: Historical repair, review and delivery

- [x] Recompute only from unambiguous accepted observations with retained payload, layout and canonical row ID. Preserve original audit records; never infer native pF from old rounded kPa.
- [x] Produce a dry-run report and rehearse against a database copy. Apply repairs by row ID and use history dirty-key correction; never enqueue replacement append events.
- [x] Independent reviewers rerun numerical vectors, database/transport regression, history/hash and affected UI/backend suites. Build both frontends, verify both Pi payloads and contract mirrors.
- [x] Port reviewed commits to private deployment branches, produce backups and immutable artifacts, deploy in compatibility order, then verify raw token, canonical IEEE754 value and cloud value for actual rows. Verify history counts and unrelated services remain intact.
- [x] Record source revisions, tests, deployment evidence and any browser limitation in the [execution report](2026-10-16-matric-potential-precision-execution-report.md).

## Plan review

Sol required explicit numerical tolerance, package delivery wiring, aggregate-precision coverage, separate token persistence ownership and an authoritative vector source. All five are incorporated before Task 1 execution. Astra independently required separate mathematics and sensor validity, exact native provenance, complete transport/hash checks and evidence-based repairs; these are included. Astra reviewed storage Task 2 and required preservation of rejected malformed Base64 source text. That fix passed a failing-then-passing regression and PostgreSQL replay/correction tests. Independent review also added transaction-time repair eligibility checks and active-helper provenance checks before live repair.

## Task 4: WATERMARK temperature placement and Data source

The operator added this requirement during implementation. Independent Sol traced the temperature to canonical `ext_temperature_c`: the edge writes it only for the valid soil-temperature source and carries it through ordinary measurement sync. The nested WATERMARK soil temperature is diagnostic and must not override the canonical value.

- [x] Both GUIs place “Soil temperature” beside WATERMARK probe 1 with a separate history action. Remove its footer placement and suppress the duplicate standalone temperature tile while WATERMARK tiles are shown. Keep probe 2 tension-only. Do not nest buttons. Missing canonical temperature stays missing even if a nested diagnostic temperature exists.
- [x] Add a positive WATERMARK predicate in cloud `SoilDevicePolicy`: LSN50, no dendrometer/rain/flow mode, and retained WATERMARK calibration or finite SWT1/SWT2; a Chameleon flag requires retained WATERMARK calibration. Add `ext_temperature_c` only to per-device soil-source channels, never the root-zone tension contributor list.
- [x] Update `HistoryCardService` environmental-source classification to exclude that same WATERMARK temperature, preventing a duplicate environmental leaf. Update `JdbcHistoryRawQueryRepository.sourceScopePredicate` with the matching per-device WATERMARK temperature scope while retaining exact device filtering. `AnalysisCatalogService` labels this leaf “Soil temperature” and gives it no inferred depth.
- [x] Confirm the corresponding edge Data discovery exposes the same canonical temperature once. Keep soil temperature separate from tension aggregation and environmental weather inputs.
- [x] Test first-row placement, distinct history controls, missing data, diagnostic/canonical disagreement and the legacy temperature flag. Backend tests cover source catalog, raw and rollup queries, excluded device modes and unchanged root SWT contributors.

Task 4 plan review: Sol GREEN. No new measurement schema or sync payload is needed.
