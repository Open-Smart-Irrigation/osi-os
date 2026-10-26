# Mobile history real-data phased roadmap and Slice 1 design

**Status:** Roadmap revised after the [external review](../reviews/2026-10-24-mobile-history-real-data-external-review.md) on 2026-10-24. This is a phased roadmap and a bounded Slice 1 design, not an executable implementation plan. The detailed [Slice 1 implementation plan](2026-10-24-mobile-history-real-data-slice-1.md) resolves the first route, catalog, request and rendering seams.

**Specification:** [Mobile history real-data integration](../specs/2026-10-24-mobile-history-real-data.md)

## Delivery rules

- Sol prepares and reviews each slice. Root reviews the plan and final evidence. Luna implements only an approved slice.
- Create clean edge and cloud worktrees from the refs root approves at execution time. Do not implement production changes in the stale prototype worktree or the dirty root checkouts.
- Keep the public preview fixture-only until a real-data slice passes both platform contracts. Existing authorization for test-preview hosting remains in force. Production access and deployment remain restricted.
- Pair changes that alter the edge/cloud Analysis response. Preserve edge profile parity for every runtime payload file.
- Put Slice 1 behind an internal opt-in route or feature gate. Do not replace or change the existing default history route, fixture preview or real-data pilot.

## Slice 1: Water tension Chart over authentic series

This internal tranche ships no Calendar or Profile UI. It supports one zone, Water tension sources, temporary 24-hour and 7-day windows, source inclusion, pan/pinch, inspector, empty intervals and the accepted 25-series ceiling. Raw/15-minute detail, retained-history discovery and ninety-day parity remain release gates. The first internal slice uses hourly aggregates honestly labelled as such.

### Task 1: Pin the common Analysis contract

**Edge evidence:**

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/device-sources.js`
- `web/react-gui/src/analysis/types.ts`

**Cloud evidence:**

- `backend/src/main/java/org/osi/server/analysis/AnalysisCatalogService.java`
- `backend/src/main/java/org/osi/server/analysis/AnalysisSeriesService.java`
- `backend/src/main/java/org/osi/server/device/SoilDevicePolicy.java`
- `frontend/src/analysis/types.ts`

Add paired contract fixtures that contain two devices, repeated depths, a configured channel with no samples, a historically known channel outside the current configuration, a measured zero and one invalid SWT value. Assert that the mobile-facing common subset contains opaque `seriesId`, zone, source key, channel key, device name, depth, unit and availability. Record how each backend distinguishes current capability from retained history. Do not approve permanent omission of `other_supported` entries in this tranche.

For series requests, assert `[from,to)`, no more than 25 selectors, explicit dropped selectors and no silent truncation. Match the response by opaque ID; response order is not a contract. Treat a missing selected ID as incomplete even when `dropped` is empty. Reject duplicate IDs and non-finite timestamps, and preserve coverage plus the applied aggregation. Do not add a new backend endpoint in this task. If the common assertions cannot be met by adapters, stop and propose the smallest additive Analysis field.

The detailed plan defines protected internal routes behind a default-off build flag and their disabled redirects. The accepted fixture preview and pilot keep their current routes and 90-day controls.

### Task 2: Give the shared chart an explicit locale and timezone

**Files:**

- Edge source: `web/history-uplot-core/src/ChartHost.tsx`
- Edge source: `web/history-uplot-core/src/adapters/uplot.ts`
- Edge tests: `web/history-uplot-core/tests/`
- Cloud vendored copy: `frontend/vendor/history-uplot-core/`

Add `locale` and `timeZone` options to the chart host and uPlot adapter. Use them for axis ticks, visible-window text and pinned-reading timestamps. Keep instants unchanged.

Test `en-GB` and `de-CH` with a browser timezone different from the supplied zone. Include the Europe/Zurich DST transition. Run the shared-core test suite on edge, copy the reviewed core into the cloud vendor directory through the new copy/parity workflow specified in the detailed Slice 1 plan, and run its parity and frontend tests.

### Task 3: Add a production Analysis-to-chart adapter

**Edge files:**

- Create `web/react-gui/src/history/mobileMeasurementCatalog.ts`
- Create `web/react-gui/src/history/mobileAnalysisHistoryAdapter.ts`
- Add focused tests under `web/react-gui/src/history/__tests__/`

**Cloud files:**

- Create the corresponding modules under `frontend/src/history/`
- Add focused tests under the cloud frontend test tree

Define a closed Water tension entry that accepts only soil `swt_1..3` catalog rows with `kPa`. Preserve `seriesId`, `sourceKey`, `channelKey`, device name and depth. Do not use the unit as the measurement identity, construct source hashes, or infer channel availability from samples in the selected interval.

The loader posts selected opaque IDs and explicit bounds to `analysisAPI.getSeries`. It adapts only requested series. A selected ID in `dropped`, a missing or duplicate ID, `truncated=true`, an unexpected unit, a non-finite timestamp or an unrequested returned ID produces an incomplete-result state rather than a normal plot. Carry coverage and applied aggregation into the chart state. Apply the current finite `0..1,000,000 kPa` display domain to hourly averages, retaining measured zero. This cannot prove their raw constituents were valid; include the mixed-invalid-bucket limitation and bucket-aware inspection tests.

Partition caches by platform, authenticated session, zone and compatible transport policy; cloud raw-hourly and rollup-hourly results cannot satisfy each other's completed requests. Test logout, account and zone changes; an empty interval; zero selected sources; a disappeared catalog entry; cancellation; stale response rejection; duplicate and missing IDs; malformed timestamps; and a dropped selected series. Keep the existing card-history adapter unchanged.

### Task 4: Port the accepted shell for the Chart slice

Port the smallest set of preview-owned components needed for measurement choice, Water tension source choice, Time, Chart and Details. Reuse canonical `ChartHost` and `SeriesLegend`. Do not port fixture arrays, Calendar, Profile or Irrigation history into the production route in this slice.

The route filters the catalog to its active zone. It remembers selected sources for the route lifetime, keeps a fixed navigation horizon, preserves viewport through source and legend changes, and retains the plot when the interval is empty. During range loading, keep cached samples at their true timestamps under the active viewport and show a compact loading state. Clear the plot on account, zone or measurement changes. Deselect locally without refetching a loaded remainder; retain compatible selected data while additions load. Never relabel old data as the requested result. Show 24 hours and 7 days only in this internal tranche; this makes the daily-bucket gate visible instead of presenting UTC and farm-day results as equivalent.

Preserve the measured pilot’s existing limits: at most one foreground request, one adjacent prefetch, eight cached entries and 20,000 points. Deduplicate compatible requests and cancel prefetch for foreground work. Use the tracked dense baseline to compare request count, response bytes, time to first plot and gesture frames; add real-app selection and cancellation acceptance separately.

Use separate production-app browser harnesses, with explicit auth/API fixtures, rather than the static presentation demo. Test both platforms at 320/390/448 pixels and normal/200% text.

Keep all eligible sources visible. Default to at most eight ordered by source key then channel key. At 25 selected series, explain the cap and disable additional selections while preserving deselection. Include a fixture with more than 25 eligible sources and verify there is no silent loss of sources or remembered selections.

Add component tests for source discovery without samples, selection reconciliation, focus/inclusion separation, pan/pinch persistence and the visible incomplete-result state. Verify 320, 390 and 448 CSS pixels at normal and 200% text.

### Task 5: Verify and review Slice 1

The later detailed Slice 1 plan will name exact commands after the seams and owning test suites are confirmed. Its verification matrix must include focused backend contracts, both frontend suites, shared-core tests, edge profile parity, production builds and browser tests with intercepted edge and cloud Analysis responses.

Capture the current pilot's throttled-network baseline first. Compare Slice 1 against the agreed request, byte, first-plot, memory and frame budgets, including rapid viewport changes that cancel work. Verify that plotted data stays visible during loading and stale responses never replace the active viewport.

Sol reviews the implementation against the specification. Root checks the refs, diff, test logs and screenshots before deciding whether to expose a reviewed real-data route. The existing fixture route remains the comparison oracle.

## Slice 2: Farm-day 30-day and 90-day Chart

Align cloud daily aggregation with the zone's IANA timezone. Return the applied aggregation and zone timezone in a common response shape. Add 30-day, 90-day and custom controls only after paired tests prove:

- farm-local bucket boundaries across ordinary, 23-hour and 25-hour days, intersected with the requested interval and carrying partial-boundary coverage;
- the accepted 90 × 24-hour elapsed preset, without silently expanding it to 90 whole local dates; custom dates retain the same elapsed-span validation;
- no silent truncation or partial success;
- the same local dates for equivalent edge and cloud input rows.

This slice may change the cloud Analysis grid and rollup query. Keep that change inside the existing Analysis module; do not rewrite card history or sync.

## Slice 3: Calendar API and UI

First write example edge and cloud response fixtures for the daily contract in the specification. Resolve the 14:30 observation rule and irrigation event semantics during review. Then implement the smallest zone-scoped read service that joins:

- the selected source's named daily observation;
- `zone_daily_environment` rain fields and resolved gauge name;
- irrigation events for count, duration and read-only rows.

Test missing, invalid, partial and zero independently. Test rain coverage values, ambiguous gauge selection, received-only rain and late corrected days. The cloud test must use mirrored edge rows rather than recomputing a different rain source policy.

Only after contract parity passes should Luna port the accepted Calendar and day sheet. Keep rainfall Calendar-only until a separate bar-renderer decision.

## Slice 4: Exact Profile snapshot

Approve a single-device profile selection rule and a snapshot rule. Add a response with one declared `snapshotAt` and layers taken from the same device row. Preserve null layers and observation timestamps. Reject any implementation that combines each channel's latest value or merges devices at equal depths.

Port the accepted Profile UI after the API tests pass. Chart inclusion must not remove Profile layers. Multiple probes remain separate selections until a reviewed comparison design exists.

## Slice 5: Remaining measurements and irrigation destination

Add Volumetric water content, Air temperature, Relative humidity and Rainfall by extending the closed frontend catalog over existing Analysis channel keys. Each addition needs a unit/validity contract and a supported-presentation declaration. Reuse the VWC `0..100 %` contract.

Add the separate read-only Irrigation history destination after Slice 3 supplies event count, duration and outcomes. Do not add valve controls, schedules or settings to this route.

## Stop conditions

Stop the active slice and return to design review if:

- edge and cloud select different physical sources for the same catalog facts;
- a successful API response can be silently partial;
- a daily bucket cannot be tied to the zone's local day;
- Calendar needs an invented observation time or inferred rain total;
- Profile values cannot be proven to share one source row and snapshot;
- implementation requires a generic plugin registry, sync rewrite or broad card-history replacement.
