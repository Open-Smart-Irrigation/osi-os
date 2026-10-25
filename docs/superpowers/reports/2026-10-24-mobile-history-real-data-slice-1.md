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

## PR-stage verification, 2026-10-25

The edge branch incorporates current main `63c7a70f8` through a clean merge. That incoming commit changes guidance and documentation checks, not product code. Root independently reran canonical core tests/build (129 passed), edge Node tests (339 passed, no skips), all 3,009 existing Vitest tests, the two App route tests, typecheck, the 18 demo tests and production build. All final commands exited 0. Logs are `/tmp/mobile-history-pr-core-test.log`, `/tmp/mobile-history-pr-edge-node.log`, `/tmp/mobile-history-pr-edge-vitest-final.log`, `/tmp/mobile-history-pr-edge-app-route.log`, `/tmp/mobile-history-pr-edge-typecheck-final.log`, `/tmp/mobile-history-pr-edge-demo.log` and `/tmp/mobile-history-pr-edge-build.log`.

The first fresh edge Vitest run failed 84 cases across four unchanged Journal suites during Zurich's repeated DST hour. Each suite initialized its normal-path form from the real clock; occurrence validation correctly rejected the ambiguous local time. The separate test-only commit `4b55ca1b8` pins Date to an unambiguous instant and keeps polling timers real. All 247 focused tests passed, including the unchanged gap/fold occurrence regressions, followed by the full green rerun above. Production Journal behavior is unchanged and tracked in [#517](https://github.com/Open-Smart-Irrigation/osi-os/issues/517).

Hosted inventory CI found the new App route test outside the existing unit-test directories. Commit `9c3d58289` adds its exact path to the aggregate script. The controlled production-browser matrix has one documented exact-path inventory exclusion, with its reproducible command and rollout issue. Root independently passed all 50 inventory/runner tests and the 832-file inventory scan. The full local suite above ran before the aggregate-script addition; its two additional route cases passed separately. Hosted CI must run the updated aggregate command on the final PR head.

The narrow hygiene allowance in `f22f7e460` covers eight synthetic SHA-256 series IDs, not deployment identifiers. Root passed all 95 hygiene tests; the private-term scan and pre-push historical scan passed. Sync verification ended with all parity checks passed; the silent-catch ratchet and vendor verifier self-test also passed. No product bytes changed during PR preparation, so the recorded 21-case edge and 22-case cloud browser matrices remain the final product acceptance evidence.

Paired PRs: [edge #518](https://github.com/Open-Smart-Irrigation/osi-os/pull/518) and [cloud #391](https://github.com/Open-Smart-Irrigation/osi-server/pull/391). Merge edge first using **Create a merge commit**, preserving canonical source commit `e397fd527b4bd9937b71d3098a62b98889b50ea1`. If edge is squashed or rebased, cloud must resync from clean edge main, commit the provenance update and rerun source/manifest verification before merging. The [PR-preparation review](../reviews/2026-10-25-mobile-history-pr-preparation-review.md) records Sol's scoped review of all three corrections.

Cloud hosted checks could not start because GitHub reported failed account payments or a spending-limit block; its PR remains draft until Actions capacity is restored and checks run. This is separate from local cloud verification, which passed. Current hosted results belong to the PRs themselves. The grid precision defect is [cloud #390](https://github.com/Open-Smart-Irrigation/osi-server/issues/390), and production-enablement checks are [edge #516](https://github.com/Open-Smart-Irrigation/osi-os/issues/516). No merge, deployment or production-host access occurred.

## Final review corrections, 2026-10-25

Review of PR #518 found that React StrictMode replay terminally destroyed the retained loader and that neighboring prefetch requests used the foreground viewport as their cache-admission interval. The correction clears the reusable loader during component cleanup and validates each prefetch against its own requested interval. Foreground validation, request concurrency, cache bounds and revision fencing are unchanged.

Root reproduced three regression failures in an isolated copy with the two old source lines: StrictMode never called transport, and both button and gesture paths failed to fetch their neighbor. Restoring the two source changes passed all 135 then-current core tests and TypeScript. Invalid prefetch coverage, policy and selected-series membership remain rejected. Evidence: `/tmp/mobile-history-review-independent-red.log` and `/tmp/mobile-history-review-independent-core-green.log`.

Repeated local-hour chart ticks now identify both UTC offsets. The containing-bucket inspector also qualifies its target and interval endpoints; ordinary axis labels and compact date summaries keep their existing format. Real uPlot rendering exposed bottom and right-edge clipping after adding the offset line. Conditional axis margins now reserve 52 px below and 28 px on the right when needed, restoring 36 px and 12 px for ordinary labels.

Root's Chromium check passed at 320, 390 and 448 CSS pixels with DPR 3. Both offset lines stayed inside the canvas, and panning the same adapter from the rollback interval to an ordinary interval and back restored the exact corresponding plot rectangles. Kampala labels and wide date-only labels were unchanged; no page errors occurred. Evidence: `/tmp/mobile-history-dst-visual.json`, `/tmp/mobile-history-dst-visual.log` and `/tmp/mobile-history-dst-axis-448.png`. This supplements the production-route matrix and does not measure physical-phone performance.

The final canonical suite passed 140 tests across 13 files, followed by TypeScript, in root's independent run. The 832-file test inventory and `git diff --check` also passed. Core log: `/tmp/mobile-history-final-corrections-core-root.log`. The [correction plan](../plans/2026-10-25-mobile-history-final-review-corrections.md) and [independent review](../reviews/2026-10-25-mobile-history-final-corrections-review.md) describe the scope and acceptance checks.

Luna's final edge host run passed typecheck, all 339 Node/TSX tests, 3,011 Vitest tests across 276 files and the production build. The production browser matrix passed 21 cases with 21 opposite-project exclusions, zero failures and zero flaky retries. Root checked the resulting JSON: `/tmp/osi-mobile-history-edge-final-r10/results.json`. The matrix covers the corrected prefetch behavior without changing its acceptance thresholds. Its unthrottled gesture p95 was 16.8 ms; the separate 4× CPU sample reported 33.4 ms.

Root then ran the unchanged six-case dense benchmark with task browser/build workloads paused. All six cases and its build passed. Every run used two requests, 642,830 bytes and at most one active response handler; maximum gesture p95 was 16.8 ms and renderer mismatch was zero. Edge first-ready times were 3,495, 3,627 and 3,441 ms; cloud-prefix times were 4,098, 3,433 and 3,437 ms. The fixture hash remains `237f37d465543fc7d4a8e19642228ef658159262f5211f6ec4c3a3ac35a5183b`. Evidence: `/tmp/mobile-history-final-corrections-dense.log`. Documentation/private-term hygiene scanned 386 files successfully, and the silent-catch gate passed.

The canonical correction is ready to commit and push for fresh hosted checks. Cloud must resync from that clean commit and rerun its local gates; its existing account billing/spending-limit block still prevents hosted checks. This section supersedes the earlier source pin once the paired cloud manifest is updated. Both PRs remain draft until their own final-head checks pass. No merge, deployment or production-host access occurred.
