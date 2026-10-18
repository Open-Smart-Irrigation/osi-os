# uPlot pilot plan review

The pilot architecture is approved for implementation. Extend the existing static comparison package with two same-origin real-history routes. Keep the proven uPlot/D3 interaction and the existing comparison defaults.

The user authorized the controller to review and revise Sol's plan, then have Luna implement and Sol review. This review is that gate; no additional user approval is needed for the implementation or the previously authorized test-server deployment.

## Findings resolved during drafting

| Finding | Required correction |
| --- | --- |
| Network completion intersected the viewport with returned sample extent | Acceptance updates data only; gestures and explicit controls own the viewport. |
| Coverage used first and last samples | Use response/request interval; sparse observations are not unfetched time. |
| A null point could fall back to an older mean | Explicit null is authoritative. Fallback applies only to an absent value property. |
| Source filtering was advertised without a supported API parameter | Use returned cards and series; omit the nonfunctional source filter. |
| Fixture dates and fixed 0–100 scale leaked into real data | Parameterize extent and y range while preserving comparison defaults. |
| Request identity included a raw token | Keep tokens in closures, use a session epoch for public identity. |
| Comparing the next buffered interval to coverage would refetch on every small pan | Compare visible normalized viewport and requested aggregation; buffer only when fetching. |

## Task consistency check

| Tasks | Shared contract or check | Ruling |
| --- | --- | --- |
| 1 → 2 | API types, normalized data, request owner and coverage policy | Use complete typed interfaces in the plan. Validate expected cardId at the API boundary, which knows the requested card. |
| 2 → 3 | Route names, labelled controls, diagnostic viewport and chart lifetime | Preserve old candidate routes/probe; add native-touch tests that observe the actual renderer. |
| 1 → 3 | Real endpoint paths and response envelope | Fixtures must match source contracts; intercepted tests do not count as authenticated live data. |
| 1 | Buffering, minute alignment, aggregation boundaries | Keep one accepted interval; rounding must not create a repeated miss at the right boundary. |
| 2 | Mount dependencies versus background updates | Identity/store/extent changes may remount. A same-identity response must only update data. |
| 3 | Browser runs and deployment evidence | Root owns serial full-suite runs and deployment. Workers must not start overlapping full browser runs. |

## Execution amendment

Split Task 2 into two reviewable pieces. Task 2a owns shared chart types, viewport conversion, D3 options, uPlot automatic y range and ChartHost options; it can run in parallel with Task 1. Task 2b owns routing, the pilot hook, controls and CSS after both foundations pass review. This changes execution order, not scope.

Use Sol for review and Luna for all product implementation. Each worker gets an owned-file brief, reports exact tests and commits, and stops on contradictions. Root checks the resulting artifact and coordinates final browser tests and static deployment.

## Live-test limit

The browser plugin could not initialize its native bridge, so browser verification uses the installed Playwright Chromium. Test-server access is available. Its configured bootstrap login returned 401; an existing test account/session has been requested. Ship only to the authorized test host. Report authenticated live-data acceptance separately from mocked edge/cloud tests and public auth-gate checks. Never create an account or bypass authentication to turn that status green.

## Implementation review

Sol reviewed the API/normalization/request owner, chart primitives, pilot UI and browser tests independently of their Luna authors. All four reviews finished GREEN after corrections. The controller reproduced the initial chart-mount and route-transition failures in Playwright before accepting their fixes.

The corrections cover token checks after response parsing, strict truncation metadata, safe automatic y ranges, stale inspection clearing, lazy adapter storage, route ownership, exact failed-request retries, Latest bounds, account-scoped sensor selection, empty/error states and coverage shading. The browser tests were also corrected to await debounced requests, use real response envelopes, correlate expected aborts and verify recovery rather than only the presence of a Retry button.

The controller independently verified 129 unit tests and 47 browser tests locally. Visual review added a final CSS-only correction so the not-loaded label sits below the chart readout. See the [execution record](../../operations/uplot-real-history-pilot-2026-10-07.md) for final deployed verification and the separate live-authentication limit.
