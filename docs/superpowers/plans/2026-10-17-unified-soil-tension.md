# Unified soil water tension implementation plan

> **For agentic workers:** Use test-driven execution, then independent verification. The user approved planning, review and execution across both repositories in this conversation.

**Goal:** Treat every available soil water tension estimate as the same canonical kPa signal, with pF as the common display unit alternative, including WATERMARK values previously available only as finite bounds.

**Architecture:** Convert at edge ingestion, persist into `device_data.swt_1/2`, and mirror through existing sync. Consumers use canonical values without a WATERMARK quality gate. Raw electrical samples, diagnostic statuses and bound columns remain available in calibration diagnostics. No schema change or new conversion formula is required.

**Tech stack:** Node.js, SQLite, Node-RED, React/TypeScript, Spring/Java.

**Spec:** User-approved behavior: one numerical estimate in cards, charts, exports, zone calculations and irrigation, regardless of Tensiomark, KIWI or LSN50 WATERMARK origin. Existing finite WATERMARK bounds become the numerical estimates. Disconnected probes and unconvertible readings remain missing. The raw Tensiomark pF retention and common pF/kPa equation remain unchanged.

## Constraints

- Work in the existing paired `tensiomark-field-integration` worktrees. Do not change unrelated work or production hosts.
- Increment WATERMARK conversion version to `wm-lsn50-p3-v3`.
- Preserve raw samples and diagnostic bounds/statuses; ordinary cards show the numerical value, depth and soil temperature without electrical or quality annotations.
- Keep actual fault and missing-temperature behavior. A finite bound is required; never manufacture zero from null.
- Use `log10(kPa * 10)` through the existing common helpers; retain existing zero/pF presentation policy and raw native pF.
- Both Pi payload profiles must remain byte-identical. Edit flows through a guarded JSON round trip.
- No cloud recomputation or direct cloud history mutation. Corrections originate on edge.
- Historical correction is an explicit dry-run/apply operator tool with backup, atomicity, idempotence and outbox safeguards. Never modify historical non-null values.

## Review focus

1. Clipped frames with missing temperature, untrusted flags, suspected shorts or no finite bound must remain null.
2. Edge scheduler must accept ordinary WATERMARK observations even when Chameleon is disabled, and must count equal values equally across sensor types.
3. The UI must not reconstruct a number from diagnostic fields when canonical kPa is missing; historical rows are corrected at their source.
4. Updating history must correct both raw-channel kPa and canonical `device_data`, trigger existing versioned/dirty-key sync and preserve raw evidence.
5. Equal numeric values must render and aggregate equally in edge/cloud, including zero, stale records and pF mode.

## Task 1: Edge conversion and scheduler

Files: both profiles' `osi-watermark-helper/conversion.js`, `conversion.test.js`, `store.test.js`; `scripts/test-watermark-contact-payload.js`; both `flows.json`; new `scripts/test-unified-soil-tension-scheduler.js`; existing WATERMARK ingest flow test if it pins the superseded scheduler exclusion.

- [x] Add failing tests: finite clipped 1325-ohm fixture publishes 11.2 kPa; swapped polarity publishes 11.0; warm segment-edge bound publishes 93.2; invalid/no-temperature/out-of-range remains null; ingest persists identical channel and canonical kPa.
- [x] Add a real SQLite test executing the shipped scheduler query: equal KIWI, Tensiomark and WATERMARK values contribute equally for SWT_1, SWT_2 and SWT_AVG; null values remain excluded; unrelated devices and other zones stay excluded.
- [x] Publish finite `kpa_upper_bound` also as `kpa` for clipped channels, keeping diagnostics. Bump version.
- [x] Remove phase-1 WATERMARK scheduler exclusion; admit LSN50 rows with retained WATERMARK linkage as well as Chameleon rows. Preserve existing time/zone/metric behavior.
- [x] Run helper tests, ingest/contact tests, scheduler tests and profile/flow gates.

## Task 2: Historical correction tool

Files: new `scripts/repair-watermark-clipped.js` and `.test.js`.

- [x] Test dry-run no mutation; only accepted finite clipped candidates with matching linked device/time and null canonical/channel kPa are filled; both channels; zero; malformed bounds; faults; cross-device links; preexisting values; repeat execution; rollback; backup; unsent canonical append event refusal; dirty-key/versioned mirror propagation.
- [x] Use stored finite bound (0..200 kPa), preserving calibration of the time and every raw/diagnostic field. Do not recalculate from today's calibration. Record correction counts and historical conversion version provenance in the operator output.
- [x] Apply under a write transaction with candidate/backlog recheck and online backup before mutation. Do not offer a bypass for conflicting unsent canonical events. No explicit `DEVICE_DATA_APPENDED` enqueue.
- [x] Exercise on synthetic database copies only; document rollup refresh windows and deployment ordering.

## Task 3: Edge and cloud presentation and consumers

Files: edge `web/react-gui/src/components/farming/shared/WatermarkProbeSection.tsx` and tests; edge `src/utils/__tests__/zoneSoil.test.ts`; corresponding cloud components/utilities and tests found by cloud discovery. Cloud backend tests cover mirror/history/aggregation acceptance of a clipped channel carrying canonical kPa; change backend behavior only if it filters such values.

- [x] Add failing tests for canonical clipped/unsettled/saturated values shown as ordinary values with common colors and pF conversion; hide electrical details/status annotations on ordinary cards; keep errors for unavailable values and diagnostics in settings.
- [x] Remove card-level bound fallbacks and special color logic; render canonical `channel.kpa`. Do not infer missing numbers on the client.
- [x] Test equal-source zone aggregation and native pF retention. Verify raw/history and export paths consume canonical kPa without status suppression.
- [x] Run both frontend unit suites, type checks and builds, plus relevant server backend tests.

## Task 4: Independent review and delivery

- [x] Review plan before product edits; apply required findings.
- [x] Run independent whole-diff review after implementation, including the numeric meaning of the new estimate policy.
- [x] Run diff hygiene and applicable contract/profile/flow checks. Record exact results and any base failures.
- [x] Update current documentation with v3 behavior and correction instructions; retain historical specs as history with a supersession pointer.
- [x] Commit scoped changes in each repository and provide paired branch/commit references plus verification evidence. Do not claim live rollout from local checks.

## Adversarial review amendments

Sol review required the following, incorporated before product edits:

- Cloud task 3 explicitly covers `SoilDevicePolicy`, `JdbcHistoryRawQueryRepository.sourceScopePredicate`, frontend `soilSourcePolicy`, `zoneSensorPresence` canonical SWT_1/2/3 schedule selection, and Terra Tensiomark anchor inventory/depth mapping. Admit configured Tensiomark SWT channels including awaiting-first-reading; keep volumetric SDI-12 separate, preserve ownership and LSN50 structural mode/family safeguards.
- Remove edge zone aggregation's numerical WATERMARK status gate. Canonical null owns unavailability. Test canonical values with diagnostic flags contribute equally, and retain family-specific depth lookup.
- Both `Sdi12SoilCard` implementations must use the shared SWT numeric domain, removing their Tensiomark-only 0.1 kPa minimum. Zero displays as 0.0 kPa and remains unavailable in pF under the existing shared logarithm policy.
- Repair must refuse an unlinked gateway and conflicting pending canonical append events, rechecking both under the same write lock as candidate selection and updates. Test transaction rollback and verified online backup, no bypass switch.
- Test cloud correction of a previously mirrored null through the existing history-correction path, then read the finite value through history/aggregation. Do not send a changed same-version append.
- Scheduler negative fixture includes LSN50 without either Chameleon enablement or a linked WATERMARK observation. Such rows remain excluded. Preserve the existing SWT_AVG policy (mean of each record's available channels, then mean of records); this task removes source exclusions rather than changing temporal/channel weighting.

No live rollout is part of this repository implementation task. The correction tool is rehearsed locally and is ready for a separately verified rollout.

Further review decisions: cloud `zoneSensorPresence.collectDepthsCm` uses family-aware generic/layout depths for Tensiomark and WATERMARK and retains Chameleon depth provenance. Both GUI shared ordinary SWT domains become finite 0..1,000,000 kPa (inclusive), preserving the existing Tensiomark maximum across all sources. Card formatting, colors and zone aggregation share that domain; >50 kPa is dry. Test zero, negative, 300, 500, 1,000,000 and beyond, and equal 500 kPa from KIWI/Tensiomark. Hardware validation and configured irrigation threshold bounds remain unchanged. Ordinary Tensiomark cards no longer show the unverified-calibration qualifier or suppress common water-state colors; settings/raw diagnostics preserve provenance.

## Execution evidence

Completed across the paired integration worktrees. See [the verification report](../../operations/2026-10-17-unified-soil-tension-verification.md) for test counts, review findings, interrupted runs and rollout limits. Cloud Terra inventory uses the shared device policy for WATERMARK as well as Tensiomark, with active-family depth selection and stable KIWI inventory across missing readings. No live rollout or historical correction was performed.
