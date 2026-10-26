# Mobile history real-data Slice 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Sol writes and reviews; root reviews the plan and final evidence; Luna implements only after root approval.

**Review status:** Revised after external findings, root-reviewed and independently passed by Sol on 2026-10-24. See the [consolidated findings](../reviews/2026-10-24-mobile-history-real-data-external-review.md). Implementation completed on 2026-10-25; the execution report records the passing gates, review evidence and release limits.

**Goal:** Add an internal, authenticated Water tension Chart backed by authentic edge and cloud Analysis data for one zone over temporary 24-hour and 7-day windows.

**Architecture:** The Analysis catalog remains the source-discovery contract and opaque `seriesId` remains the only selection token. The shared core owns selection, failure and bucket-interval rules; thin platform adapters normalize DTOs and construct different edge and cloud transport bounds. The existing bounded loader remains the only range cache and scheduler. The edge package is canonical and is copied byte-for-byte into a new cloud vendor directory by a checked sync workflow.

**Tech Stack:** TypeScript 5, React 18, SWR, axios, uPlot, Vitest/Testing Library, Node test runner, Playwright, Node-RED JavaScript tests, Spring Boot/JUnit 5.

**Spec:** `docs/superpowers/specs/2026-10-24-mobile-history-real-data.md`

**Loading baseline:** `docs/operations/mobile-history-loading-baseline-2026-10-24.md`

## Global constraints

- Start implementation in clean edge and cloud worktrees at exact cached refs approved by root. The present prototype worktree and both dirty root checkouts are read-only inputs.
- Do not connect to or deploy to `osicloud.ch`. This plan contains no deployment.
- Keep the fixture preview, `/history`, `/history/zones/:zoneId`, `/analysis`, and their current defaults unchanged.
- Add hidden protected routes only: edge `#/internal/mobile-history/zones/:zoneId`, cloud `/internal/mobile-history/zones/:zoneId`.
- Gate both routes with build-time `VITE_MOBILE_HISTORY_INTERNAL === 'true'`. The default is false. A build operator enables it for an internal build; it persists for that build only. There is no navigation link. A disabled or malformed direct route redirects to the platform's existing `/history` page.
- Slice 1 exposes only Chart, Water tension, and 24 h / 7 d. Calendar, Profile, Irrigation, 30 d, 90 d, and custom ranges are absent. Preserve the accepted 90-day fixture semantics for later release work.
- Slice 1 is an hourly transport proof. Both presets request and display `hourly`; never label the result raw, 15-minute, observation-level, or complete history. Restoring raw/15-minute detail is a release gate alongside edge/cloud 90-day farm-day parity.
- All logical viewports and requests are `[from,to)`. Cloud sends the exact logical bounds. Edge alone floors `from` and ceils `to` to UTC hours so overlapping requests have stable bucket anchors; this may extend a seven-day transport by less than two hours and does not raise the seven-day viewport maximum. Keep every returned bucket at its actual anchor and model its own half-open interval, including a partial final edge bucket.
- A successful response is usable only when every selected opaque ID appears exactly once, no selected ID is dropped, no unrequested ID appears, every returned series is untruncated, all timestamps are finite, units are `kPa`, applied aggregation is `hourly`, and the resolved transport range covers the requested interval.
- Missing data remains missing. Measured `0 kPa` is valid. The client can validate only returned hourly averages: replace a finite average outside `0..1,000,000 kPa` with `null` and report it as an invalid hourly average. Do not claim that this detects invalid raw readings; a mixed `30` and `1,000,001` bucket averaging `500,015.5` is an explicit release limitation.
- The selection cap is 25. Initially include at most eight sources ordered by `sourceKey`, then `channelKey`, then `seriesId`. Retain an intentionally empty set. When a selected row disappears, remove it from the executable selection, clear its plotted data, and name it in a source-chooser recovery notice; never discard it silently or wedge the route.
- Catalog policy for this slice: retain eligible edge `other_supported` rows, show them unchecked with “Historical availability not verified”; treat cloud rows without `configurationState` as `unknown`, not proven current. Default inclusion may use `current` and `unknown`, never `other_supported`. Cloud currently omits channels outside current device policy even when rollups retain samples, so route copy and the report must call source discovery incomplete and release-gated.
- Auth scope identity includes platform/server instance, authenticated session epoch, zone and measurement. Logout, auth expiry, account change, zone change or measurement change clears all plotted and cached data immediately and aborts its requests.
- Loader cache, in-flight joining and accepted-data reuse also require an equal read-policy key: `edge-hourly`, `cloud-raw-hourly` or `cloud-rollup-hourly`. A seven-day cloud rollup may remain visibly marked as old data while a 24-hour raw request loads, but it can never satisfy or commit as the raw-hour result.
- Selection is separate from auth scope, displayed data and request revision. Removing a source filters it from the ready plot immediately and sends no request. Adding a source retains compatible displayed series; after a 150 ms debounce it loads the full selected set only when accepted/cache data cannot already satisfy it. A removal during that debounce cancels the addition. A stale revision cannot commit.
- Reuse the current cache limits and lanes: eight entries, 20,000 total points, one foreground request, one adjacent prefetch. Equal requests deduplicate; foreground work cancels prefetch first. Slice 1 does not change these limits.
- No schema, sync contract, Node-RED boot DDL, card-history endpoint, or production feature default changes are in scope.

## Verified feasibility and deliberate limits

- Edge Analysis accepts explicit sub-day and seven-day bounds, scans no more than 30,000 raw rows across the selected device groups, and rejects the whole request if that cap is crossed. It has no pagination, does not return `bucketSizeSeconds`, and never returns a successful truncated series.
- Cloud reads raw hourly aggregates only when the exact request span is at most 24 hours. Therefore Analysis requests have no generic padding: label a logical span `24h` iff it is at most 24 hours and `7d` otherwise, and always send `aggregation: hourly`.
- Cloud aligns the returned grid to UTC hours and reports `grid.stepSeconds`; validate `3600`. Edge reports applied hourly aggregation and aligned range bounds; derive each edge bucket interval from consecutive anchors and the returned range end rather than inventing a fixed final width.
- Edge card history supports per-source filtering, but cloud card history does not. Mixing Analysis discovery with card-history reads would merge or select sources differently, so Slice 1 does not use that path.
- Cached cloud `origin/main` has no shared-core vendor copy or copy script. Task 2 establishes that workflow; do not describe it as pre-existing.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `web/history-uplot-core/src/history/rangeStrategy.ts` | Default card strategy plus the bounded hourly Analysis strategy for 24 h / 7 d. |
| `web/history-uplot-core/src/history/useHistoryWindow.ts` | Consume an injected range strategy and separate viewport identity from data/cache identity. |
| `web/history-uplot-core/src/history/historyLoader.ts` | Use the demand's precomputed adjacent request; retain existing LRU and lanes. |
| `web/history-uplot-core/src/shared/types.ts` | Export range, bucket, selection, locale/timezone, `MobileTensionSource`, `MobileAnalysisWindow`, failure and shared-route prop types. |
| `web/history-uplot-core/src/mobile/mobileTensionPolicy.ts` | Own default selection, reconciliation, complete-response invariants, invalid-hourly-average counting and visible-empty detection. |
| `web/history-uplot-core/src/ChartHost.tsx`, `src/adapters/uplot.ts` and `src/shared/inspection.ts` | Format axes, values, visible window and bucket-aware inspector output with explicit locale and IANA timezone. |
| `web/history-uplot-core/src/mobile/MobileTensionHistory.tsx` | Platform-neutral Chart shell, source chooser, cap messaging, loading/error/empty states, legend and chart. |
| `scripts/sync-history-uplot-core-vendor.mjs` | Deterministically replace the cloud vendor package and write source metadata beside the compared package. |
| `scripts/verify-history-uplot-core-vendor.mjs` | Compare canonical and vendored file paths and SHA-256 bytes; fail on missing, extra, or changed files. |
| `frontend/vendor/history-uplot-core/**` | Byte-for-byte cloud copy of the canonical edge package. |
| `frontend/vendor/history-uplot-core-origin.json` | Source commit and sorted hashes, outside the byte-compared package. |
| `*/src/history/mobileMeasurementCatalog.ts` | Platform catalog normalization and the explicit `current`, `other_supported`, or `unknown` policy. |
| `*/src/history/mobileAnalysisHistoryAdapter.ts` | Platform request construction and DTO normalization before shared validation. |
| `*/src/history/useMobileTensionCatalog.ts` | Session- and zone-keyed SWR catalog read. |
| `*/src/pages/MobileTensionHistoryRoute.tsx` | Resolve route zone/timezone/session and compose the shared shell. |
| `*/src/history/mobileHistoryInternalGate.ts` | Strict build-time gate parsing shared by route wiring and tests. |
| `web/history-zoom-prototypes/tests/browser/loading-baseline.spec.ts` | Tracked dense pilot runner that reproduces the recorded baseline. |
| `web/react-gui/playwright.mobile-history.config.ts` and `frontend/playwright.mobile-history.config.ts` | Production-build browser projects, independent of the edge presentation demo. |

## Review focus

- A late response from a previous login, zone, addition revision or viewport must never replace the active plot; Tasks 1 and 3 own the races, including `8 -> 7 -> 8` and add-then-remove.
- Edge UTC anchoring must make overlapping requests return identical intervals and values; Task 3 owns paired transport tests.
- A selected source can disappear without a `dropped` entry; Task 3 owns one catalog refresh followed by explicit per-source removal recovery.
- An interval is empty only after complete coverage and no selected finite bucket overlaps the visible range; Task 1 owns this predicate and Task 4 owns the state.
- At 25 selected sources every unchecked source stays visible and disabled with an explanation, while selected sources remain removable; Task 4 owns the interaction test.

---

### Task 0: Import and rerun the tracked loading baseline

**Files:**
- Import from prototype commit `2b57875e5`: `web/history-zoom-prototypes/tests/browser/loading-baseline.spec.ts`
- Modify: `web/history-zoom-prototypes/package.json`
- Modify: `docs/operations/mobile-history-loading-baseline-2026-10-24.md`

**Interfaces:**
- Produces: `npm run test:browser:loading-baseline`, using the tracked `playwright.config.ts`, its Chromium `448x998`, DPR 3 and touch settings, and the existing Vite pilot on `http://127.0.0.1:4178/`.
- Produces: six raw run records under ignored `test-results/slice1-baseline/`; the spec itself contains the dense `8 x 672` fixture and `600 ms + bytes / 125_000` response delay.

- [x] **Step 1: Import the root-reviewed tracked artifact into the clean edge execution worktree.** Import the runner and package script from reviewed commit `2b57875e5` (`test(history): track reproducible mobile loading baseline`); do not reconstruct it from ignored `test-results/` or assume baseline commit `5b62f8706` is on main. Keep edge and cloud API-prefix runs separate and write raw results only to ignored `test-results/slice1-baseline/`.

- [x] **Step 2: Run the exact baseline command.**

Run: `cd web/history-zoom-prototypes && npm run test:browser:loading-baseline`

Expected: three edge-prefix and three cloud-prefix runs complete with two data requests, 642,830 response bytes, exact viewport agreement, and raw timing/frame output. Timing remains reported evidence rather than a deterministic unit-test assertion.

- [x] **Step 3: Update the baseline document and commit the runner before product work.** Replace the ignored-config command with the tracked script and record the execution commit and environment. Do not commit `test-results/`.

```bash
git add web/history-zoom-prototypes/package.json web/history-zoom-prototypes/tests/browser/loading-baseline.spec.ts docs/operations/mobile-history-loading-baseline-2026-10-24.md
git commit -m "test(history): track slice 1 loading baseline"
```

### Task 1: Make selection, buckets, time formatting and range scheduling explicit

**Files:**
- Modify: `web/history-uplot-core/src/shared/types.ts`
- Create: `web/history-uplot-core/src/history/rangeStrategy.ts`
- Modify: `web/history-uplot-core/src/history/range.ts`
- Modify: `web/history-uplot-core/src/history/types.ts`
- Modify: `web/history-uplot-core/src/history/useHistoryWindow.ts`
- Modify: `web/history-uplot-core/src/history/historyLoader.ts`
- Create: `web/history-uplot-core/src/mobile/mobileTensionPolicy.ts`
- Modify: `web/history-uplot-core/src/ChartHost.tsx`
- Modify: `web/history-uplot-core/src/adapters/uplot.ts`
- Modify: `web/history-uplot-core/src/shared/inspection.ts`
- Modify: `web/history-uplot-core/src/index.ts`
- Test: `web/history-uplot-core/tests/range.test.ts`
- Test: `web/history-uplot-core/tests/historyLoader.test.ts`
- Test: `web/history-uplot-core/tests/useHistoryWindow.test.tsx`
- Test: `web/history-uplot-core/tests/chartHost.test.tsx`
- Test: `web/history-uplot-core/tests/uplot.test.ts`
- Test: `web/history-uplot-core/tests/mobileTensionPolicy.test.ts`

**Interfaces:**
- Produces: `HistoryRangeStrategy` with `requestForViewport(viewport)`, `bufferedRequest(viewport,horizon)`, and `neighborRequest(viewport,direction,horizon)`.
- Produces: unchanged `cardHistoryRangeStrategy` and new `analysisHourlyRangeStrategy`, limited to viewports `<= 7 * DAY_MS`; it does not pad the logical request, uses label `24h` iff `to - from <= DAY_MS`, otherwise `7d`, and always carries `aggregation: 'hourly'`.
- Produces: `HistoryDemand.neighbor: HistoryWindowRequest | null`; the loader no longer recalculates adjacency with card rules.
- Produces: `HistoryWindowOptions.rangeStrategy?: HistoryRangeStrategy`, defaulting to `cardHistoryRangeStrategy` with byte-for-byte current behavior.
- Produces: `HistoryWindowOptions.viewportIdentity?: string`; `viewportStore` uses it while auth scope changes still clear the loader.
- Produces: optional `HistoryWindowOptions.readPolicy?(request): 'edge-hourly' | 'cloud-raw-hourly' | 'cloud-rollup-hourly'` for the mobile route. `HistoryDemand` and accepted data carry this key; cache lookup, in-flight matching, coverage reuse and selection-backed reuse all require equality. Existing callers default to `card-default`.
- Produces: `HistoryWindowOptions.maxSpanMs?: number`, defaulting to the current 90-day constant; the internal route passes seven days and the hook uses it for viewport construction, preset movement and clamping.
- Produces: `MobileSelectionState { selectedIds: readonly string[]; displayedIds: readonly string[]; requestRevision: number }` and `HistoryDemand.selectionKey`, the sorted requested-ID set. The hook keeps accepted backing series separate from the displayed filter. Cache reuse requires the entry to contain every requested ID (a superset may satisfy a subset); in-flight joining requires the same selection key. Every selection change updates `selectedIds` and the displayed filter immediately and advances the revision fence, cancelling obsolete addition timers/requests. A removal retains compatible backing data and schedules no new load when that data covers the remaining selection. An addition absent from compatible accepted/cache data waits 150 ms before loading the full selected set; that revision fences the commit but is not itself a cache key.
- Produces: `HistoryLoader.evictSeries(ids)` and the corresponding hook operation. Shared recovery marks denied IDs unavailable for the current scope, removes them from selected/displayed/accepted backing data, and rewrites every affected cache entry without those series, updating its ID set and point accounting. Abort and fence in-flight demands containing them. Stale catalog responses and cached supersets cannot restore denied IDs; test both re-add and cache-hit attempts. Compatible remaining data stays plotted.
- Produces: optional `HistoryWindowOptions.onDiagnostics(snapshot)` reporting request reason plus the loader's foreground/prefetch booleans, entries and points. Existing callers omit it; the internal route uses it only for browser acceptance.
- Produces: closed shared `MobileTensionSource`, `MobileBucket { from; to; value; count; quality }`, `MobileAnalysisWindow`, response-validation and failure types. `MobileAnalysisWindow` stores per-series bucket intervals, latest finite bucket time and invalid hourly-average count; it does not expose response-generation time as freshness.
- Produces: optional `ChartHostProps.locale?: string`, `timeZone?: string` and `inspectionMode?: 'nearest-point' | 'containing-bucket'`; explicit mode formats values with `Intl.NumberFormat(locale, { maximumSignificantDigits: 6 })`, labels the value “Hourly average”, shows the bucket start–end interval, and selects only the half-open bucket containing the tap. Omission preserves current callers exactly.

- [x] **Step 1: Add failing default-strategy regression tests.** Assert every existing `requestForViewport`, buffered request, adjacent request, card cache hit, preset and prefetch expectation remains unchanged when no strategy is supplied.

- [x] **Step 2: Add failing Analysis-strategy, read-policy, selection and split-identity tests.** Assert logical requests are exact, a span of exactly 24 hours uses `24h`, one millisecond more uses `7d`, and adjacent requests stay inside the horizon. Cache a covering cloud seven-day rollup, then select 24 hours: it must issue a `cloud-raw-hourly` request even though coverage and aggregation match; the old rollup may remain marked pending but cannot commit as raw. With `maxSpanMs = 7 * DAY_MS`, pinch-out clamps at seven days. A same-scope removal filters immediately with zero loads; re-adding a still-backed series restores it without a load. An uncached addition keeps existing series visible, waits 150 ms, then loads the full selection. Cover `8 -> 7 -> 8`, pending addition then removal, late revisions, and a scope change that clears all state and aborts work.

- [x] **Step 3: Run the focused tests and confirm the new exports/options are absent.**

Run: `cd web/history-uplot-core && npm test -- tests/range.test.ts tests/historyLoader.test.ts tests/useHistoryWindow.test.tsx`

Expected: FAIL only on the new strategy and demand assertions.

- [x] **Step 4: Implement the strategy, loader and selection seams.** Move existing range policy into `cardHistoryRangeStrategy`, keep compatibility exports, and calculate the neighbor once. Add read-policy and selection-set checks to cache/in-flight/reuse decisions. Keep backing accepted data behind the displayed filter, debounce only additions, and fence their commits with `requestRevision`.

- [x] **Step 5: Add failing formatting, inspection and policy tests.** With the browser timezone away from Europe/Zurich, assert `en-GB` and `de-CH` axes, visible-window text and bucket intervals use supplied inputs. Assert `23.416666666666668` renders as `23.4167` for both `en-GB` and `de-CH`, and as `23,4167` for `fr`, a tiny finite nonzero remains nonzero, and zero remains `0`. For one-hour, 24-hour and seven-day views, taps inside `[bucket.from,bucket.to)` select that bucket; a tap at `bucket.to` never selects the previous bucket, a null bucket reports unavailable, and no nearest neighbor is substituted. Assert visible-empty requires complete coverage and no finite selected bucket overlapping the visible range; zero selected sources is a separate state.

- [x] **Step 6: Implement the shared policy and explicit rendering inputs.** Construct formatters from supplied locale/timezone only in the new mode. Derive inspector rows from bucket intervals. Keep the existing nearest-point behavior and default formatters byte-for-byte for existing callers.

- [x] **Step 7: Run the complete canonical core gates.**

Run: `cd web/history-uplot-core && npm test && npm run build`

Expected: all tests pass and `tsc --noEmit` exits 0.

- [x] **Step 8: Commit Task 1 in the clean edge worktree.**

```bash
git add web/history-uplot-core
git commit -m "feat(history): add mobile analysis selection and bucket seams"
```

### Task 2: Establish the cloud vendor workflow

**Files:**
- Create: `scripts/sync-history-uplot-core-vendor.mjs`
- Create: `scripts/verify-history-uplot-core-vendor.mjs`
- Create: `frontend/vendor/history-uplot-core/` from `web/history-uplot-core/`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `.github/workflows/frontend-ci.yml`
- Test: `scripts/verify-history-uplot-core-vendor.test.mjs`
- Test: `frontend/src/history/__tests__/vendoredReactResolution.test.tsx`

**Interfaces:**
- Consumes: the approved edge worktree path passed explicitly as `--source`; never infer a dirty root checkout.
- Produces: `frontend/vendor/history-uplot-core-origin.json` with source commit and sorted `{ path, sha256 }` entries. The compared package contains no generated metadata.
- Produces: cloud dependency `"@osi/history-uplot": "file:vendor/history-uplot-core"`.
- Produces: verifier source mode (`--source /absolute/edge/worktree`) and source-free `--manifest` mode. Manifest mode hashes the installed vendor file set against `frontend/vendor/history-uplot-core-origin.json`, so cloud CI can detect drift without an edge checkout.
- Produces: Vite/Vitest `resolve.dedupe: ['react', 'react-dom']`, preventing the vendored package's development install from supplying a second React runtime.

- [x] **Step 1: Write failing sync/verifier tests.** In temporary directories assert deterministic sorted copying, ignored `node_modules`/build artifacts, sibling-manifest creation, identical source/vendor path sets, and failures for changed, missing and extra tracked vendor files in both source and manifest modes.

- [x] **Step 2: Run the test and confirm both scripts are missing.**

Run: `cd /path/to/clean/osi-server && node --test scripts/verify-history-uplot-core-vendor.test.mjs`

Expected: FAIL because the sync/verifier entry points do not exist.

- [x] **Step 3: Implement the scripts and vendor the approved Task 1 commit.** Accept `--source /absolute/edge/worktree`; require its clean package path; copy source, tests, package metadata and styles; exclude dependencies and outputs; write the manifest atomically. The verifier compares both file sets and hashes.

- [x] **Step 4: Add the file dependency, React dedupe and hook-render regression, then prove a clean install.** Render one exported vendored hook/component through the cloud test runtime after installing the vendor package's own development dependencies; the test must fail without dedupe rather than accepting an invalid-hook warning.

Run: `cd frontend && npm install --package-lock-only && npm ci && npm --prefix vendor/history-uplot-core ci && npx vitest run --environment jsdom src/history/__tests__/vendoredReactResolution.test.tsx`

Expected: lockfile resolves `@osi/history-uplot` from `vendor/history-uplot-core` and the command exits 0.

- [x] **Step 5: Add the manifest self-check to cloud CI and verify the vendored package.** In `.github/workflows/frontend-ci.yml`, whose default working directory is `frontend`, run `node ../scripts/verify-history-uplot-core-vendor.mjs --manifest` after checkout and before `npm ci`; add the verifier/sync scripts and workflow file to the path filter.

Run: `node scripts/verify-history-uplot-core-vendor.mjs --source /absolute/approved/edge/worktree && node scripts/verify-history-uplot-core-vendor.mjs --manifest && npm --prefix frontend/vendor/history-uplot-core test && npm --prefix frontend/vendor/history-uplot-core run build`

Expected: parity passes; vendored tests and typecheck pass.

- [x] **Step 6: Commit Task 2 in the clean cloud worktree.**

```bash
git add scripts frontend/vendor/history-uplot-core frontend/vendor/history-uplot-core-origin.json frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/src/history/__tests__/vendoredReactResolution.test.tsx .github/workflows/frontend-ci.yml
git commit -m "build(history): vendor the shared mobile chart core"
```

### Task 3: Define and validate the mobile Analysis contract on both platforms

Implementation details and root-reviewed error contracts: [adapter brief](2026-10-24-mobile-history-slice-1-adapter-brief.md).

**Files (edge):**
- Modify: `web/react-gui/src/analysis/types.ts`
- Modify: `web/react-gui/src/services/api.ts`
- Create: `web/react-gui/src/history/mobileMeasurementCatalog.ts`
- Create: `web/react-gui/src/history/mobileAnalysisHistoryAdapter.ts`
- Create: `web/react-gui/src/history/useMobileTensionCatalog.ts`
- Create: `web/react-gui/src/history/__tests__/mobileMeasurementCatalog.test.ts`
- Create: `web/react-gui/src/history/__tests__/mobileAnalysisHistoryAdapter.test.ts`
- Create: `web/react-gui/src/history/__tests__/useMobileTensionCatalog.test.tsx`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js`
- Mirror byte-for-byte: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.test.js`

**Files (cloud):**
- Modify: `frontend/src/analysis/types.ts`
- Modify: `frontend/src/services/api.ts`
- Create: `frontend/src/history/mobileMeasurementCatalog.ts`
- Create: `frontend/src/history/mobileAnalysisHistoryAdapter.ts`
- Create: `frontend/src/history/useMobileTensionCatalog.ts`
- Create: `frontend/src/history/__tests__/mobileMeasurementCatalog.test.ts`
- Create: `frontend/src/history/__tests__/mobileAnalysisHistoryAdapter.test.ts`
- Create: `frontend/src/history/__tests__/useMobileTensionCatalog.test.tsx`
- Modify: `backend/src/test/java/org/osi/server/analysis/AnalysisCatalogServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/analysis/AnalysisSeriesServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/analysis/AnalysisControllerTest.java`

**Interfaces:**
- Consumes the closed shared source, bucket, window, selection, validation and failure types from Task 1. Platform code must not copy those policies.
- Produces: platform catalog normalization followed by shared `selectMobileTensionSources(catalog, zoneId)`, accepting only the active zone, `soil`, `swt_1|swt_2|swt_3`, `available`, non-legacy, `kPa`; repeated depths and devices remain distinct.
- Produces: `buildEdgeMobileAnalysisRequest(ids, logical)` that floors `from` and ceils `to` to UTC hours, and `buildCloudMobileAnalysisRequest(ids, logical)` that sends the exact bounds. Both use selected order, `24h` iff logical span is at most 24 hours, otherwise `7d`, and `aggregation: 'hourly'`; zero IDs skips the builder and HTTP entirely.
- Produces: response normalizers that feed the shared validator. Cloud requires `grid.stepSeconds === 3600`, a positive integer `grid.bucketCount`, `grid.to === grid.from + grid.bucketCount * 3600 seconds`, and exactly that many ordered points in every series at `grid.from + i * 3600 seconds`. Edge requires applied `hourly`, aligned transport bounds enclosing the logical request, and derives `[from,to)` bucket intervals from adjacent anchors plus `range.to`, requiring the first anchor to equal `range.from`, strictly increasing hourly anchors with no missing buckets, and a final width greater than zero and at most one hour. Null values preserve their grid positions.
- Produces: `classifyMobileAnalysisFailure(error)` with explicit results. Both 401 and 403 map to `HistoryAuthError`; the handler branches on status. A 401 clears private cache and follows existing auth expiry. A 403 clears route plots and shows access denied without inventing global logout. HTTP 413 or the explicit `range_too_large` code on HTTP 400 is recognized as a size limit and offers fewer sources/shorter window; another 400 is a protocol error. Network/5xx is transient Retry.
- Produces: source recovery for missing/dropped selected IDs with one catalog refresh per failed request generation. `access_denied` immediately hides and evicts that series; a still-stale catalog never re-enables it automatically. Other missing/dropped reasons remain a visible incomplete protocol result with manual source exclusion.
- Produces: `useMobileTensionCatalog({ enabled, zoneId, sessionKey })` with a `refresh()` that performs one network revalidation for an incomplete request revision even when the server's 60-second catalog cache still returns the old row.

- [x] **Step 1: Pin paired catalog and value fixtures.** Add two devices, repeated depths, measured zero, invalid returned hourly average `1_000_001`, a configured channel without samples, an edge `other_supported` row, and a cloud row with unknown history state. Add raw readings `30` and `1_000_001` whose returned average `500,015.5` passes the client display-domain check; label this the raw-validity release limitation. Assert opaque IDs pass through unchanged and no unit-based grouping occurs.

- [x] **Step 2: Pin paired backend range/limit behavior.** Assert an exact cloud 24-hour request uses raw-hour aggregation, while one millisecond over 24 hours and seven days use stored rollups. Assert 25 selectors succeed, 26 reject; edge raw-row overflow and cloud grid overflow reject rather than truncate; all success series say `truncated=false`. Pin cloud's retry case where a changed-zone series is omitted without a `dropped` row. On edge, issue two overlapping UTC-aligned requests and assert shared bucket anchors and values match. Copy the edge helper test byte-for-byte into bcm2709.

- [x] **Step 3: Run the additive backend contract tests and record their baseline.** These tests pin existing behavior; they require no production backend edit and must pass before frontend implementation starts.

Run edge: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.test.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.test.js && node scripts/verify-profile-parity.js`

Run cloud: `cd backend && ./gradlew test --tests 'org.osi.server.analysis.AnalysisCatalogServiceTest' --tests 'org.osi.server.analysis.AnalysisSeriesServiceTest' --tests 'org.osi.server.analysis.AnalysisControllerTest'`

Expected: all existing and additive contract assertions pass, with no production backend change required.

- [x] **Step 4: Write failing catalog/request-adapter tests.** Cover deterministic order, initial eight, 25 cap, deliberate empty selection, vanished selection, `other_supported` visible/unselected, cloud unknown default eligibility and repeated identities. Assert zero IDs makes zero requests; 25 unique IDs work; duplicates and 26 IDs fail before HTTP. Assert edge floor/ceil bounds can exceed a seven-day visible window by less than two hours, while cloud bounds remain exact and both labels derive from the logical span.

- [x] **Step 5: Write failing response and failure-classification tests.** Reject missing, duplicate, unrequested, dropped and truncated series; wrong step/applied aggregation; duplicate, unordered, skipped or incorrectly spaced bucket anchors; cloud grid/count/end inconsistencies; malformed timestamps; non-covering transport range; and invalid selected count. Retain a cloud bucket anchored before logical `from` when its half-open interval overlaps. Derive the final edge bucket end from returned `range.to`. Replace a returned `1,000,001` average with null and increment the counter; keep measured zero and the mixed-raw `500,015.5` average. Assert 401 uses existing expiry and clears private data; 403 clears route plots without global logout. Treat HTTP 413 as oversized without requiring a body code; match `range_too_large` by explicit code on HTTP 400 and do not treat another 400 as oversized. Network/5xx offers Retry. `access_denied` immediately hides/evicts the source and refreshes the catalog once per generation; stale catalog data cannot restore it. Other missing/dropped reasons also refresh the catalog once, then remain visible incomplete results with manual exclusion and no success normalization.

- [x] **Step 6: Implement API cancellation and thin platform adapters.** `analysisAPI.getSeries(request, { signal })` passes the signal to axios. Keep DTO casing and transport-bound differences in the adapter, then call shared validation. Do not construct or translate `seriesId`.

- [x] **Step 7: Write and implement catalog-hook isolation tests.** Prove equal session/zone reads deduplicate; a new session or zone gets a different key; a late old response cannot populate the active key; disabled mode makes no request; and one forced refresh bypasses the client cache without entering a loop.

- [x] **Step 8: Run focused frontend tests on both platforms.**

Run edge: `cd web/react-gui && npx vitest run src/history/__tests__/mobileMeasurementCatalog.test.ts src/history/__tests__/mobileAnalysisHistoryAdapter.test.ts src/history/__tests__/useMobileTensionCatalog.test.tsx`

Run cloud: `cd frontend && npx vitest run --environment jsdom src/history/__tests__/mobileMeasurementCatalog.test.ts src/history/__tests__/mobileAnalysisHistoryAdapter.test.ts src/history/__tests__/useMobileTensionCatalog.test.tsx`

Expected: all focused tests pass.

- [x] **Step 9: Commit Task 3 separately in edge and cloud.**

Edge commit: `feat(history): adapt analysis data for mobile tension`

Cloud commit: `feat(history): adapt analysis data for mobile tension`

### Task 4: Build the shared internal Chart and route wrappers

The [root-reviewed shell brief](2026-10-24-mobile-history-slice-1-shell-brief.md) refines this task: request-dependent `readPolicy`, generation-aware catalog refresh, closed errors and complete localized labels, no unnecessary i18n registration changes, and canvas tick alignment checks in Task 5. Its explicit contracts supersede the abbreviated interfaces below.

**Files (canonical/shared):**
- Create: `web/history-uplot-core/src/mobile/MobileTensionHistory.tsx`
- Create: `web/history-uplot-core/src/mobile/mobileTension.css`
- Modify: `web/history-uplot-core/src/index.ts`
- Create: `web/history-uplot-core/tests/mobileTensionHistory.test.tsx`

**Files (edge):**
- Create: `web/react-gui/src/history/mobileHistoryInternalGate.ts`
- Create: `web/react-gui/src/pages/MobileTensionHistoryRoute.tsx`
- Modify: `web/react-gui/src/App.tsx`
- Modify: `web/react-gui/src/vite-env.d.ts`
- Modify: every `web/react-gui/public/locales/*/history.json`
- Modify: `docs/i18n/pending-luganda-translations.md`
- Create: `web/react-gui/src/pages/__tests__/MobileTensionHistoryRoute.test.tsx`
- Create: `web/react-gui/tests/mobileHistoryLocales.test.ts`

**Files (cloud):**
- Resync: `frontend/vendor/history-uplot-core/`
- Create: `frontend/src/history/mobileHistoryInternalGate.ts`
- Create: `frontend/src/pages/MobileTensionHistoryRoute.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/vite-env.d.ts`
- Modify: every supported cloud locale's history file; existing namespace registration already covers `history`.
- Create: `frontend/src/pages/__tests__/MobileTensionHistoryRoute.test.tsx`

**Interfaces:**
- Consumes: `MobileTensionSource[]`, selected IDs, `MobileAnalysisWindow` loader, locale, zone timezone, session-scoped context and zone label.
- Produces: source chooser with separate inclusion and legend focus, `ChartHost` with `analysisHourlyRangeStrategy`, and only `24 h`/`7 d` controls.
- Produces: `mobileHistoryInternalEnabled(env): boolean`, true only for the exact string `'true'`.
- Produces: auth scope context with `sessionKey`, `scopeKey = "zone:" + zoneId`, `cardId = "mobile-water-tension"`, and stable `viewportIdentity = [sessionKey, zoneId, "water-tension"].join("|")`. Selected IDs and request revision travel through the Task 1 selection interface, never `context.sourceKey`.
- Produces: the full `MobileTensionHistoryLabels` contract in the shell brief, covering all ChartHost, SeriesLegend, dialog, source, loading, Details and recovery strings. Route-only zone/timezone states remain outside shell props.
- Produces: `MobileTensionHistoryProps { sources; defaultSelectedIds; catalogError; catalogLoading; context; readPolicy(request); locale; timeZone; zoneLabel; labels; load(request, signal, context); refreshCatalogForGeneration(generation); onAuthError(error) }`. Use the complete typed labels and props in the shell brief, including its optional diagnostics seam. Failure and recovery props use the shared closed taxonomy rather than arbitrary error strings.

- [x] **Step 1: Write failing shared-shell interaction tests.** Assert initial inclusion policy, deliberate empty selection with zero requests, independent focus, and preserved viewport during focus, disclosure and source changes. Removal filters only that series from a ready plot and sends no request. An uncached addition retains the old series through its debounced load. Cover `8 -> 7 -> 8`, pending addition then removal, and late addition response rejection. Same-selection viewport refresh may retain plotted data at true timestamps.

- [x] **Step 2: Add cap, availability and failure tests.** With 26 sources, assert the 26th stays visible and disabled at cap while selected sources stay removable. `access_denied` immediately hides/evicts its series, performs one catalog refresh and stays unavailable when that refresh is stale. Another missing/dropped reason retains only previously accepted compatible data and shows the incomplete source with one-tap exclusion. Never commit a subset from an incomplete response. On the first load, keep the plot unavailable until exclusion yields a complete reduced-selection result or compatible cache entry. Assert request-too-large offers fewer sources/shorter window without Retry; transient failure offers Retry; 401 follows auth expiry; 403 clears the route and shows access denied.

- [x] **Step 3: Add data-state and fidelity tests.** Preserve the accepted compact header, tall chart, aligned unit, Time bottom sheet containing 24 h, 7 d and Latest, and compact legend. Show “Hourly averages” as one small caption; put invalid-hourly-average count, transport coverage and each series' latest finite bucket in Details. Zero plots; rejected averages become gaps. Report empty only after complete coverage and no finite selected bucket overlaps the visible range; uncovered work stays loading. Empty intervals retain controls/sources plus Show latest 24 hours. Zero selected sources shows Choose sources and sends no request.

- [x] **Step 4: Implement the shared shell with existing core pieces.** Reuse `ChartHost`, `SeriesLegend`, appearances, viewport store and the existing bounded history loader. Do not add a parallel response cache. Give auth scope, selected IDs, displayed backing data and request revision separate ownership. Use a horizon from Unix epoch to current minute, minimum span one hour and maximum span seven days.

- [x] **Step 5: Commit the reviewed canonical shared-core change before vendoring it.**

```bash
git add web/history-uplot-core
git commit -m "feat(history): add shared mobile tension chart"
```

- [x] **Step 6: Sync and verify the cloud vendor from that clean canonical commit.**

Run: `node scripts/sync-history-uplot-core-vendor.mjs --source /absolute/approved/edge/worktree && node scripts/verify-history-uplot-core-vendor.mjs --source /absolute/approved/edge/worktree`

Expected: no missing, extra or changed vendor files.

- [x] **Step 7: Write failing platform route/gate tests.** Assert exact false-default parsing, no navigation link, protected route behavior, disabled redirect to `/history`, malformed/non-numeric/inaccessible zone redirect, and enabled route composition. Prove edge HashRouter and cloud BrowserRouter paths remain in their established forms. The literal false branch must not import the internal route module.

- [x] **Step 8: Implement lazy thin platform wrappers.** Put each route behind a lazy import inside the literal build-time gate so the false build omits its chunk. Resolve the zone from `irrigationZonesAPI.getAll()` and use its timezone exactly; an absent or invalid IANA value blocks Analysis. A valid `UTC` must be accepted because neither backend distinguishes an operator choice from the database default; record that release limitation. Use `i18n.resolvedLanguage ?? i18n.language`. Edge reuses `serializeSessionIdentity` from `services/authSession.ts` and supplies `edge-hourly`. Cloud reuses `serializeSessionIdentity` from `contexts/AuthSessionDataBoundary.tsx` and supplies `cloud-raw-hourly` for logical spans at most 24 hours, otherwise `cloud-rollup-hourly`. Each wrapper builds labels with `t(...)`, loads the scoped catalog and passes only platform normalization/loading into the shared shell.

- [x] **Step 9: Add reviewed farmer-facing keys to every supported locale.** Reuse existing translated history keys where their meaning matches. Add reviewed translations for new `de-CH`, `es`, `fr`, `it` and `pt` prose. New `lg` keys copy English on both platforms until human review; on edge add them to `docs/i18n/pending-luganda-translations.md` and the focused pending-key test/allowlist while preserving existing human Luganda. Run placeholder, missing-key and cloud locale-parity gates; do not add prose to a European identical-English allowlist.

- [x] **Step 10: Run canonical, edge and cloud focused tests.**

Run canonical: `cd web/history-uplot-core && npm test && npm run build`

Run edge: `cd web/react-gui && npx vitest run src/pages/__tests__/MobileTensionHistoryRoute.test.tsx src/history/__tests__ && node scripts/run-tsx-tests.mjs 'tests/mobileHistoryLocales.test.ts' && npm run typecheck`

Run cloud: `cd frontend && npx vitest run --environment jsdom src/pages/__tests__/MobileTensionHistoryRoute.test.tsx src/history/__tests__ src/i18n/__tests__/localeParity.test.ts src/i18n/__tests__/missingKeyScan.test.ts && npm run build`

Expected: all commands pass; cloud build resolves only the vendored package.

- [x] **Step 11: Commit the remaining Task 4 platform work separately in edge and cloud.**

Edge commit: `feat(history): wire internal mobile tension route`

Cloud commit: `feat(history): add internal mobile tension chart`

### Task 5: Browser acceptance, measured budgets and full verification

Use the [root-reviewed browser brief](2026-10-24-mobile-history-slice-1-browser-brief.md) for exact startup fixtures, logical-span labels, valid grids, and diagnostics. Add its optional adapter-reader/shell-snapshot seam and strict diagnostics build flag during Task 4. Task 5 consumes that seam to compare independent requested and rendered viewports.

**Files (edge):**
- Modify: `web/react-gui/package.json`
- Create: `web/react-gui/playwright.mobile-history.config.ts`
- Create: `web/react-gui/scripts/run-mobile-tension-build-matrix.mjs`
- Create: `web/react-gui/scripts/serve-mobile-history-build.mjs`
- Create: `web/react-gui/tests/browser/mobile-history-fixtures.ts`
- Create: `web/react-gui/tests/browser/mobile-tension-real-data.spec.ts`
- Create: `docs/superpowers/reports/2026-10-24-mobile-history-real-data-slice-1.md`

**Files (cloud):**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/playwright.mobile-history.config.ts`
- Create: `frontend/scripts/run-mobile-tension-build-matrix.mjs`
- Create: `frontend/scripts/serve-mobile-history-build.mjs`
- Create: `frontend/tests/browser/mobile-history-fixtures.ts`
- Create: `frontend/tests/browser/mobile-tension-real-data.spec.ts`
- Create: `docs/superpowers/reports/2026-10-24-mobile-history-real-data-slice-1.md`

**Interfaces:**
- Consumes: intercepted authentic edge and cloud Analysis response shapes, never live production.
- Produces: edge `test:browser:mobile-history` and cloud `test:browser:mobile-history`, each invoking its matrix runner and its own Playwright config. Neither uses edge `demo/`.
- Produces: edge servers mounted at `/gui/` on 4181/4182 with `/gui/index.html` fallback; cloud servers mounted at `/` on 4281/4282 with `index.html` fallback for BrowserRouter deep links.
- Produces: matrix runners that build into temporary directories, wait for both health URLs, invoke Playwright with explicit off/on base-URL environment variables, and terminate servers plus remove outputs in `finally` on pass or failure.
- Produces: deterministic authentication fixtures. Edge writes `auth_token` and `username` before app startup, fulfills `GET /api/me` with a valid unscoped profile, and fulfills `GET /api/system/stats` with a valid stats DTO including `restartPending: null`. Cloud writes a syntactically valid subject JWT plus `username`/`role`, fulfills `GET /api/v1/users/me`, `GET /api/v1/users/me/linked-gateways` with an empty array, and `GET /api/v1/user/module-preferences`, and uses `page.routeWebSocket('**/ws', ...)` to answer the STOMP `CONNECT` frame with `CONNECTED`. Both intercept their exact zones, Analysis catalog and Analysis series paths. Fail browser acceptance on any unexpected/unhandled API request or page startup error; do not let a SPA fallback mask missing stubs.
- Produces: review evidence with exact refs, commands, request/byte/frame measurements, screenshots and hourly/raw-validity limitations.

- [x] **Step 1: Rerun the dense pilot beside the completed core in the same environment.** Use Task 0's tracked command before and after the core change. Require at most 771,396 total bytes, paired first-ready median no worse than 1.2x, gesture frame p95 at most 33.4 ms, zero renderer errors, exact viewport agreement, at most one foreground and at most one prefetch from the diagnostics hook, and no increase from eight cache entries / 20,000 points. A cache hit may have neither lane active. Keep this `8 x 672` renderer test separate from valid hourly Analysis fixtures.

- [x] **Step 2: Build the edge production harness.** The runner invokes Vite twice with `VITE_BASE_PATH=/gui/`: strict false to a temporary off directory on 4181 and strict true to an on directory on 4182, then removes both. The Playwright base URLs include `/gui/`, and the route is `#/internal/mobile-history/zones/1`. Intercept `GET /api/me`, `GET /api/system/stats`, `GET /api/irrigation-zones`, `GET /api/analysis/channels` and `POST /api/analysis/series`. Assert the false build redirects and its manifest/chunks contain no internal route module; the true build serves it. No query or local-storage value may bypass a false build.

- [x] **Step 3: Build the cloud production harness.** Add `@playwright/test`; build false/true outputs on 4281/4282. Open `/internal/mobile-history/zones/1` through the SPA fallback. Intercept `GET /api/v1/users/me`, `GET /api/v1/users/me/linked-gateways`, `GET /api/v1/user/module-preferences`, `GET /api/v1/irrigation-zones`, `GET /api/v1/analysis/channels` and `POST /api/v1/analysis/series`. Use cloud DTO casing, a 3,600-second UTC grid and an overlapping first bucket. Apply the same false-build module-absence and no-bypass assertions.

- [x] **Step 4: Run the production acceptance matrix.** At 448x998/DPR 3/touch, generate one bucket per UTC hour in each platform's aligned transport range, including overlapping boundaries (a minute-offset 24-hour request has 25 buckets and a minute-offset seven-day request has 169). Use eight series and the actual serialized-byte delay `600 ms + bytes / 125_000`. Record navigation-to-zones, zones-to-catalog, discovery bytes and discovery completion separately because cloud discovery is account-wide and no discovery baseline exists. Require series first-ready by discovery completion plus imposed transfer plus 1,000 ms, at most two series requests for the fixed pan/pinch, at most one foreground and one prefetch, p95 at most 33.4 ms, exact viewport agreement and zero renderer errors. Cover containing-bucket inspector boundaries, removal without a request, debounced addition, cap, zero selection, finite-overlap empty state, unavailable-source removal, request-too-large without Retry, transient Retry, rapid reversal, stale response, 401/session expiry and route-local 403. Match displayed instants across platforms for identical anchors.

- [x] **Step 5: Run responsive and CPU evidence.** On both enabled production builds, test 320, 390 and 448 CSS-pixel widths at normal root size and 200% root text. Open the compact header, source chooser with cap message and Details; assert no horizontal overflow or clipped labels and every visible control is at least 44x44 CSS pixels. Separately rerun the gesture scenario with CDP 4x CPU throttling and report frames without comparing them to the unthrottled 33.4 ms gate. State that neither run measures a physical phone, radio, backend query cost or cancellation of server work.

- [x] **Step 6: Run all edge gates.**

```bash
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-profile-parity.js
cd web/history-uplot-core && npm test && npm run build
cd ../react-gui && npm run typecheck && npm run test:unit && npm run build && npm run test:browser:mobile-history
cd ../.. && git diff --check
```

Expected: every command exits 0. If no runtime/profile file changed, the parity verifier still proves the branch preserved that invariant.

- [x] **Step 7: Run all cloud gates.**

```bash
node scripts/verify-history-uplot-core-vendor.mjs --source /absolute/approved/edge/worktree
node scripts/verify-history-uplot-core-vendor.mjs --manifest
cd frontend && npm run test:unit && npm run build && npm run test:browser:mobile-history
cd ../backend && ./gradlew test
cd .. && git diff --check
```

Expected: every command exits 0. Do not suppress unrelated failures; distinguish a proven base failure with exact reproduction if one exists.

- [x] **Step 8: Write the execution report.** Include approved base/branch SHAs, both diffs, exact pass counts, screenshots, measured budgets, vendor manifest SHA, route/gate behavior, the invalid-raw-inside-valid-average case, valid-UTC ambiguity, backend caps, discovery timings, historical-source policy and confirmation that no deployment occurred. Record that aborting HTTP does not prove cancellation of edge scans or cloud queries.

- [x] **Step 9: Commit reports, then stop for Sol and root review.**

Edge commit: `docs(history): record Slice 1 verification`

Cloud commit: `docs(history): record Slice 1 verification`

Do not expose the internal build or change any default after tests pass. Sol reviews both implementations against this plan and the specification; root reviews refs, diffs, logs, screenshots and benchmark evidence before deciding any next step.
