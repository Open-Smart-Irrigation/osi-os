# Mobile history zoom prototype verification

The three standalone prototypes pass the local correctness gates with final application build `2a80b3b2f`. They compare uPlot, ECharts, and Chart.js with the same D3 touch controller and synthetic sensor history. The package is `web/history-zoom-prototypes`; it does not replace Data History in either the edge or cloud application.

## Verification

The root orchestrator independently ran these commands after Luna's implementation and Sol's scoped reviews:

| Check | Result |
| --- | --- |
| `npm test` | 78 tests passed across 14 files |
| `npm run build` | TypeScript, including browser tests, and Vite production build passed |
| Local `npm run test:browser` | 34 tests passed in 2.9 minutes at `ca319171f`; final inward edge-label alignment then passed the focused adapter suite and full mobile screenshot smoke |
| Deployed `npm run test:browser` | 34 tests passed in 3.2 minutes on final build `2a80b3b2f` |
| Gesture suitability | All 9 criteria passed on each of the 3 routes |
| Separate mobile smoke | Pan, pinch, tap inspection, close, and screenshots passed on all 3 routes without captured page, console, or request errors |
| `git diff 242ca6349 HEAD --check` | Passed |

Playwright ran Chromium 153.0.8010.12 with touch enabled at 448 × 998 CSS pixels and DPR 3. The suite also covered 998 × 448 rotation and 390 × 844 compact screens. It dispatched real Chrome DevTools touch events, including both partial finger-release orders, and read each renderer's public scale API. No test changed the viewport through the diagnostic probe.

A 60-move pinch and a four-move pinch produced equal final spans. Moving-midpoint drift measured 0.800017 CSS pixels on all three routes; requested and rendered viewport edges agreed exactly in that check. The suite also verified cancellation recovery, native scrolling outside the plot, route cleanup, delayed-load races, measured zero and spike rendering, and empty missing-data intervals.

## Frame diagnostics

These are desktop Chromium frame intervals during gestures against the final deployed build, not physical Pixel performance claims. The nominal fixture contains 10,175 points and the stress fixture 129,600 points. Each measurement had more than 100 recorded frame intervals.

| Renderer | Nominal p95 interval | Stress p95 interval |
| --- | --- | --- |
| uplot | 16.7 ms | 16.7 ms |
| echarts | 16.7 ms | 83.4 ms |
| chartjs | 33.4 ms | 450.1 ms |

uPlot is the first candidate to try on the Pixel. ECharts and Chart.js pass the interaction correctness checks, but their stress traces show slower redraws. The hardware comparison remains open.

## Decisions and corrections

The original Chart.js native-plugin experiment failed the agreed gesture behavior: its four-step and 60-step spread differed by 6.27%, its vertical spread did not zoom, and a moving midpoint drifted 87.66 pixels. All three deployed candidates therefore use D3 for gestures. The native measurements remain in the execution amendment; there is no fourth route.

Live screenshot checks found small uPlot line fragments inside a null outage. Its default join mode retained null samples but left alignment holes between them, fragmenting the gap. The converter now uses null-expansion mode for explicit gaps while preserving finite zeros and unrelated alignment holes. The unchanged browser pixel assertion passes. The upstream behavior is documented in [uPlot's join implementation](https://github.com/leeoniya/uPlot/blob/master/src/utils.js).

Other fixes covered loading races, cleanup after unmount, canonical hash routes, reading-panel spacing, and diagnostics updates. Final screenshot review also caught overlapping time labels in ECharts and Chart.js. Both now use hours and minutes through 48 hours, dates beyond that, and inward alignment at plot boundaries. ECharts uses its suggested tick count with overlap hiding; it does not promise an exact count of four ticks. Root rejected an earlier browser implementation with weak assertions and replaced it with the reviewed Sol-authored test plan. Earlier interrupted and overlapping browser runs are not completion evidence.

The user's requested roles governed execution: Sol wrote plans, root reviewed and revised them, Luna implemented, and Sol reviewed the changes. Independent adapters used disjoint files; root coordinated commits. Final browser verification ran once against a settled tree, with prior diagnostics removed.

Deployment is authorized only for the standalone static test-server path. It uses bundled synthetic fixtures, retains a Caddyfile backup, verifies public asset hashes, and rolls routing back if post-activation checks fail. No production cloud, database, gateway, or existing GUI deployment is part of this work.

## Test-server release

All three routes are deployed and verified:

- [uPlot](https://server.opensmartirrigation.org/prototypes/history-zoom/#/uplot)
- [ECharts](https://server.opensmartirrigation.org/prototypes/history-zoom/#/echarts)
- [Chart.js](https://server.opensmartirrigation.org/prototypes/history-zoom/#/chartjs)

Release: `20261007T111149Z-2a80b3b2fd35`. Application commit: `2a80b3b2fd35`. Archive SHA-256: `5ba5fdccdbe676ed232a77bde2b02e540e386d06f5a568a83379552cd1bcffa5`.

The final HTTPS run passed all 34 Playwright tests and all 27 measured gesture criteria. A separate smoke test watched for page, console, and failed-request errors during pan, pinch, tap inspection, and close on every route. It also zoomed beyond 48 hours and captured nine screenshots. Root and Sol inspected the compact axis labels; the final build preserves readable labels and fixed plot geometry.

Every publicly served release file matched its SHA-256 manifest. The bare-path redirect preserves query strings; static responses use `Cache-Control: no-store`, and missing files return 404. Root, health, and neighboring-route checks matched the captured baseline. Caddy reloaded gracefully. No rollback was needed.

The local evidence directory is `.superpowers/sdd/2026-10-07-mobile-history-zoom-shared/deployment-20261007T111149Z-2a80b3b2fd35/`. It contains HTTP fingerprints, manifests, combined Caddy validation/reload logs, browser output, frame diagnostics, screenshots, and the retained Caddyfile backup.

Rollback to the prior working preview: `ssh <test-host> bash /home/rocky/caddy/deploy-staging/20261007T111149Z-2a80b3b2fd35/rollback.sh`. The release directory is `/data/prototypes/history-zoom/releases/20261007T111149Z-2a80b3b2fd35`.

The implementation and verification records are committed locally on `plan/mobile-history-zoom-prototypes`. Physical Pixel 8 Pro testing remains pending.
