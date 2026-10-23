# Mobile history zoom prototype plan review

Execution update: the [approved execution amendment](2026-10-07-mobile-history-zoom-execution-amendment.md) governs the shared D3 controller for all three renderers, passing gesture gates, and the test-server deployment.

Three Sol agents authored the plans. The root orchestrator reviewed them, requested revisions, and applied the final cross-plan corrections. This record describes the review decisions and the execution handoff. Product implementation has not started.

The planning worktree is `.worktrees/mobile-history-zoom-prototypes`, on branch `plan/mobile-history-zoom-prototypes`, based on `origin/main` at `242ca6349`. The current main checkout contains newer presentation-build work; the prototype is an independent package and does not depend on that work.

The user selected the orchestration roles: Sol writes each plan, the root reviews and revises it, Luna implements, and a fresh Sol context reviews the implementation. Model selection stays the same at the implementation handoff.

| Review finding | Required plan treatment |
| --- | --- |
| State-only tests can pass when a chart never changes. | Read the rendered domain through each adapter's chart API and compare it with the requested domain after native touch input. |
| Native Chart.js gestures and a shared D3 overlay would compete. | Mount the overlay only for ECharts and uPlot. Send Chart.js input to its own canvas. |
| A D3 callback echoed into a programmatic transform can disturb an active gesture. | Distinguish gesture proposals from external viewport changes and prevent callback loops. |
| A candidate switch could reset the time window and invalidate comparison. | Preserve the viewport and fixture across switches; destroy the previous chart and its listeners. |
| uPlot's published demo removes its movement listener when one finger lifts. | Use D3's touch tracking for the candidate and test both finger-release orders. |
| Alignment artifacts can become false gaps in asynchronous sensor series. | Keep absent alignment entries distinct from explicit null readings in the uPlot conversion. Test the plotted gap as well as conversion output. |
| Fixture features outside the initial window make the first screen unrepresentative. | Put an outage, a real zero, a spike, and offset sampling times inside the initial 24 hours. |
| A long-running response can overwrite a later selection. | Include a bounded delayed-fixture scenario that discards stale responses without changing the viewport. |
| A gesture library's limitations could disappear behind skipped tests. | Report failed suitability criteria explicitly. Require separate passing implementation correctness checks. |
| Counting animation callbacks does not establish chart rendering performance. | Record diagnostic frame timings; leave the physical Pixel 8 Pro feel and performance verdict pending. |

The initial comparison fixes the vertical domain at 0–100 kPa and varies the horizontal time domain. Momentum after release is outside the first comparison. The uPlot touch demo remains the user's reference for finger-following behavior.

Implementation will begin with the shared harness. Candidate workers receive the reviewed common contract and their own plan after that harness is independently checked. A fresh Sol reviewer then checks each adapter and the assembled comparison, including actual browser behavior. The root verifies review evidence and sends required fixes back to Luna.

No production routes, cloud APIs, gateway state, or deployed assets are part of the prototype. Real edge/cloud integration is a later decision after the comparison.

## Plans and execution order

Read the [prototype brief](../specs/2026-10-07-mobile-history-zoom-prototype-brief.md) first. It describes the phone interaction and the comparison boundary.

| Order | Plan | Implementer and review |
| --- | --- | --- |
| 1 | [Shared harness](2026-10-07-mobile-history-zoom-shared.md), Tasks 1–4 | Luna builds the package, data, controller, and shell. Fresh Sol reviews the working harness before adapters start. |
| 2 | [uPlot](2026-10-07-mobile-history-zoom-uplot.md), Tasks 1–2 | Luna builds the renderer and data conversion. Root coordinates a fresh Sol review. |
| 2 | [ECharts](2026-10-07-mobile-history-zoom-echarts.md), adapter task | A separate Luna builds the renderer. Root coordinates a fresh Sol review. |
| 2 | [Chart.js](2026-10-07-mobile-history-zoom-chartjs.md), Tasks 1–2 | A separate Luna builds the native-gesture candidate. Root coordinates a fresh Sol review. |
| 3 | Shared Tasks 5–6 and every adapter's browser-verification tasks | Luna assembles the common browser suite. Fresh Sol independently runs and reviews the whole comparison. |

The root dispatches bounded tasks, reviews evidence, and sends corrections to Luna. Each meaningful task receives an independent Sol review; the final review uses a fresh context. Adapter work can run in parallel after the shared contract is stable. Keep the existing source ownership boundaries so parallel workers do not change the same files. Browser tasks depend on the completed shared suite and all candidate modules; adapter unit tests and builds run earlier.

The first preview opens uPlot. Candidate switching retains the fixture and time window. The result is one local comparison page, three implementations, native-touch test evidence, and LAN links for the Pixel 8 Pro. Edge and cloud adoption follows the comparison; these plans do not choose a production replacement yet.

## Final root revisions

- Removed a harness/adapter build dependency cycle with lazy discovery and an explicit unavailable state.
- Replaced an incompatible Vite/Vitest pairing and supplied missing test dependencies. npm registry metadata confirms the pinned versions and relevant peer ranges; installation remains an implementation check.
- Aligned ownership, probe names, two-pixel anchor tolerance, test profiles, line widths, and sparse-marker rules across plans.
- Preserved explicit missing readings in the inspector and made sparse and single samples visible.
- Added callback direction rules, stale route-import protection, cancellation resynchronization, and resize ordering.
- Corrected cleanup tests so input at a reused screen location still reaches the new chart; only an empty former frame must remain silent.
- Kept cleanup and renderer/data correctness as hard gates, with gesture suitability reported separately using equal thresholds.

Plan review status: complete, awaiting the user's review before implementation. No product code, dependency installation, or deployment has occurred.

Checks: prose checker passed with no tier-1 findings; the tier-2 wording warnings refer to device orientation. Whitespace checks passed. Documentation hygiene passed using built-in patterns only; the private name list was not supplied, so that part of the check and allowlist staleness remain unchecked. These are documentation checks, not evidence that the unbuilt prototypes work.
