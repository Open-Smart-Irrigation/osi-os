# Mobile history Slice 1 execution report

Status: Slice 1 complete and reviewed on 2026-10-25. Both production-build browser matrices passed. No deployment occurred.

## Delivered behavior

Edge and cloud have an authenticated internal Water tension Chart using their Analysis APIs. The compact header leaves room for the chart; the source chooser supports eight initial sources, a 25-source cap, and intentional zero selection. The chart keeps pan/zoom, a bottom-sheet time selector, hourly-average disclosure, and expandable Details. Missing or invalid averages remain gaps. Empty intervals preserve controls and offer a fresh latest-24-hour recovery request, including when the previous window was seven days.

The shared edge package owns selection, bucket intervals, formatting and the existing bounded loader. Removal immediately filters the chart without HTTP; additions debounce and reuse compatible backing data. Scope, selection revision and read policy prevent stale responses or previous sessions from entering the active chart. Platform adapters retain their different request bounds and raw/rollup policies.

Both routes require literal `VITE_MOBILE_HISTORY_INTERNAL=true` at build time. Edge uses `#/internal/mobile-history/zones/:zoneId`; cloud uses `/internal/mobile-history/zones/:zoneId`. The default-off build redirects to History and omits the internal lazy module. Existing navigation and defaults remain unchanged.

## Refs and review

| Item | Ref |
| --- | --- |
| Edge starting point | `55ec323f90d12864eab50cfeda74cb3bf8910834` |
| Cloud starting point | `f214163f29153c35821fe8f554b28ca7359760c2` |
| Both branches | `feat/mobile-history-real-data-slice1` |
| Canonical shared package | `e397fd527b4bd9937b71d3098a62b98889b50ea1` |
| Cloud vendor update | `cc89d945` |
| Prototype callback compatibility | `52c4da265` |
| Final edge browser harness | `7b107c863` |
| Final cloud browser harness | `fac6131c2` |

Execution used separate `.worktrees/mobile-history-real-data-slice1` worktrees. Original root checkouts and the hosted prototype worktree were read-only. Sol planned and reviewed, root reviewed and independently verified, and Luna implemented. The [product review](../reviews/2026-10-24-mobile-history-slice-1-final-product-review.md) records the final scoped PASS, including the latest-day correction. Its two recovery regressions first reproduced the wrong seven-day request, then passed with one fresh 24-hour request. Browser acceptance also caught a brief initial-selection empty-state flash; `e397fd527` shows Loading until accepted empty coverage exists. Its deferred-loader regression failed before the fix and passed afterward, including genuine all-null recovery and deliberate zero selection.

Cloud vendor verification passed for all 42 files against the canonical source and manifest. Manifest SHA-256: `6070c6e8644a835b3ee4964b96d50df7c728c63aa0a61fe1ddef36f9ece28ac4`.

## Code verification

| Gate | Result |
| --- | --- |
| Canonical `npm test` and `npm run build` after the initial-loading correction | 129 tests in 13 files passed; build passed |
| Edge `npm run test:unit:tsx-runner` | 338 passed; one existing skip |
| Edge `npm run test:unit:vitest -- --maxWorkers=2` | 3,009 passed in 275 files |
| Edge `npm run typecheck && npm run build` after the final core correction | Passed |
| Cloud `npm run test:unit -- --maxWorkers=2` | 292 Node tests and 2,973 Vitest tests passed; two existing Vitest skips |
| Cloud `npm run build` after the final vendor update | Passed |
| Cloud Java 21 `./gradlew test -x buildFrontend` | 5,181 tests; zero failures/errors; two skips across 604 XML reports |
| Edge `verify-sync-flow.js`, `verify-no-new-silent-catch.js`, `verify-profile-parity.js` | Passed |
| Vendor source/manifest verification and both `git diff --check` checks | Passed |

Full host unit suites preceded the final recovery and initial-loading corrections; the 129-test canonical suite and both host builds followed it. Initial concurrent frontend runs had five timeouts; bounded reruns passed without changing assertions or timeouts. A separate cloud locale-ratchet failure exposed an implicit host locale in timezone validation; both adapters now use an explicit validation locale, and the full cloud gate passed.

Backend compilation was deliberately separated from frontend verification. The full backend command used Java 21 at `/home/phil/.cache/osi-irrigation-jdk21/jdk-21.0.12.1+1`; its log is `/tmp/mobile-history-cloud-final-backend.log`. Frontend logs are `/tmp/mobile-history-edge-bounded-unit.log`, `/tmp/mobile-history-cloud-bounded-unit.log` and `/tmp/mobile-history-cloud-loading-build.log` and `/tmp/mobile-history-edge-loading-build.log`. Runtime logs are `/tmp/mobile-history-edge-final-sync.log` and `/tmp/mobile-history-edge-final-silent-catch.log`. Existing npm engine, Browserslist and large-chunk warnings did not fail the builds.

## Dense renderer budget

Root ran the unchanged `8 × 672` benchmark before implementation and after the latest-day correction, with other task browser/build work paused. `npm run test:browser:loading-baseline` passed six final runs and its fresh TypeScript/production build. The fixture matches commit `2b57875e5` byte-for-byte: SHA-256 `237f37d465543fc7d4a8e19642228ef658159262f5211f6ec4c3a3ac35a5183b`.

| API prefix | Final first-ready runs (ms) | Final median (ms) | Task 0 median (ms) | Ratio |
| --- | --- | --- | --- | --- |
| Edge | 3674, 3598, 3766 | 3674 | 3489 | 1.053 |
| Cloud | 3489, 3468, 3485 | 3485 | 3510 | 0.993 |

Highest gesture p95 was 16.8 ms, below 33.4 ms. Every run fulfilled two requests totaling 642,830 bytes, below 771,396 bytes, with at most one active response handler. All runs had exact requested/rendered viewport agreement and zero renderer mismatch. This fixture measures rendering/loading overhead, not production backend latency. The later initial-selection correction changes only `MobileTensionHistory` and its component test; the benchmark uses `PilotApp` directly, whose renderer/loader path is unchanged from this measured run.

Evidence: `/tmp/mobile-history-dense-task0-20261024`, `/tmp/mobile-history-dense-post-recovery-20261024`, and `/tmp/mobile-history-dense-post-recovery.log`.

## Production-route browser acceptance

Edge passed its final `npm run test:browser:mobile-history` matrix: 21 cases, zero failures/flaky retries. Its 21 skips are opposite-project exclusions: each case runs against its intended off or on build. Cloud passed all 22 cases, with 22 equivalent project exclusions and zero failures/flaky retries. Both commands exited 0.

Both runners build separate off/on production bundles, serve local SPA routes, intercept authentic Analysis/startup DTOs, and close on unexpected APIs or page errors. Tests use Chromium 153, Playwright 1.63.0, 448×998 CSS pixels, DPR 3 and touch. Responsive checks additionally use 320/390/448 px and measured 16/32 px root text. The unit's right edge matches numeric canvas ticks within one CSS pixel; labels stay inside the viewport and controls retain 44 px targets. Root inspected both platforms' 320 px normal/200% screenshots; enlarged text wraps vertically without horizontal overflow.

| Final route measurement | Edge | Cloud |
| --- | --- | --- |
| Navigation to ready | 2,758 ms | 2,205 ms |
| Navigation to zones request | 1,090 ms | 479 ms |
| Zones completion to catalog request | 16 ms | 105 ms |
| Catalog bytes | 3,351 | 2,135 |
| Initial series bytes / imposed delay | 19,647 / 757.176 ms | 18,980 / 751.84 ms |
| Initial hourly buckets | 25 | 25 |
| Unthrottled gesture p95 | 16.8 ms | 16.7 ms |
| 4× CPU gesture p95 (reported, not gated) | 66.7 ms | 33.4 ms |

The unthrottled checks passed the discovery-relative loading budget and the 33.4 ms frame budget. Requested and rendered viewports agree. Edge diagnostic samples recorded up to two cache entries/825 points; its performance run sampled idle lanes. Cloud performance samples recorded one entry/200 points and observed idle and foreground-active lanes; its backing-reuse samples stayed at one entry/200 points. Bounds remain eight entries/20,000 points with one foreground and one adjacent-prefetch slot. Empty-range tests verify exact accepted Details coverage before recovery. Source-cap tests identify the current foreground by viewport bounds and close legitimate neighboring prefetch work before navigation.

Coverage includes build-flag exclusion, source addition/removal, pending-addition cancellation, a 25-source cap, zero selection, complete empty intervals, outside-viewport finite values, exact hourly inspector boundaries, unavailable sources, oversized requests, retry, rapid reversal, stale response rejection, 401 expiry and route-local 403. A completed browser interception does not prove server cancellation. The named superseded-request tests accept fulfillment or cancellation while requiring current data to remain admitted.

Edge raw evidence: `/tmp/osi-mobile-history-edge-results-Nym4mi/results.json`, with screenshots under `mobile-tension-real-data-r-d1c74-normal-and-200-percent-text-edge-on/`; command log `/tmp/mobile-history-edge-final-browser-r8.log`. Cloud raw evidence: `/tmp/osi-mobile-history-cloud-results-YX4Cfi/results.json`, with screenshots under `mobile-tension-real-data-r-d1c74-normal-and-200-percent-text-cloud-on/`; command log `/tmp/mobile-history-cloud-final-browser-r4.log`. These local artifacts are not committed; both tracked runners reproduce the cases.

The preceding cloud run reached the same chart assertions but failed its console gate when Chromium reported `ERR_NETWORK_CHANGED` for local `locales/en/journal.json` and `locales/en/settings.json` requests. The unchanged rerun passed; the error gate and browser timeout were not relaxed. Earlier harness corrections addressed canvas coordinate conversion, locale expectations, request completion and legitimate prefetch work. The two product fixes discovered during acceptance were latest-24-hour recovery and the initial-selection loading state, both covered by RED/GREEN regressions.

The final [browser review](../reviews/2026-10-25-mobile-history-slice-1-browser-review.md) records Sol's static review and root's runtime evidence. Review the full changes with `git diff 55ec323f90d12864eab50cfeda74cb3bf8910834..HEAD` in edge and `git diff f214163f29153c35821fe8f554b28ca7359760c2..HEAD` in cloud.

## Release limits

This slice exposes Chart, Water tension, hourly averages and temporary 24-hour/seven-day windows only. Profile, Calendar, irrigation settings, custom ranges and 30/90-day integration remain later work. Existing fixture semantics are preserved.

An existing cloud `AnalysisGrid` precision defect blocks production release: an end instant at an exact hour plus 1–999 milliseconds is rounded down, so reported coverage ends before the requested interval. The client correctly rejects it. A separate backend change must ceil into the next hour and change the boundary regression to expect 25 buckets. No backend production code changed in this slice.

Client validation cannot identify every invalid raw constituent inside a valid hourly average: raw 30 and 1,000,001 kPa can average to 500,015.5 kPa. Values outside the accepted average range become gaps; zero remains valid. The edge's 30,000-row scan cap rejects the whole request and has no pagination.

Historical source discovery remains incomplete. Edge `other_supported` sources are unchecked with an availability warning; cloud rows without configuration state are `unknown`, and cloud can omit historical channels outside current device policy. Retained-history discovery, raw/15-minute detail, 90-day farm-local buckets and live rollup freshness are release checks. A valid `UTC` timezone is accepted because the backends cannot distinguish an operator choice from a database default; missing or invalid timezone blocks Analysis.

Local intercepted production builds do not establish physical Pixel 8 Pro performance, radio latency, backend query cost or cancellation of server work. Aborting client HTTP only fences client admission. No live host was accessed or deployed.
