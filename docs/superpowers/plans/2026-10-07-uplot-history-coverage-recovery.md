# uPlot history coverage and empty-interval recovery plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:test-driven-development` for each behavior change and `superpowers:verification-before-completion` before reporting completion.

**Goal:** Let the standalone uPlot pilot navigate to retained history older than 90 days, recover from an empty interval with native gestures, and describe an empty result without implying that the selected host has no older history.

**Architecture:** Separate the finite navigation extent from the 90-day maximum visible/request span, and propagate that maximum through the D3 gesture transform instead of relying on the store to repair an oversized zoom. Keep the uPlot interaction shell mounted for an accepted empty result so its shared viewport store and gesture scheduler can move into another interval. Do not change query aggregation policy in this slice.

**Tech stack:** React 18, TypeScript 5.9, uPlot 1.6.32, Vitest, Testing Library, Playwright.

**Related plans:** `docs/superpowers/specs/2026-10-07-uplot-real-history-pilot-design.md`, `docs/superpowers/plans/2026-10-07-uplot-loading-optimization.md`.

## Confirmed causes and contract boundaries

1. `usePilotHistory.ts` currently uses the same 90-day value for the navigation extent, viewport maximum, and largest request tier. The viewport store therefore clamps Back, Forward, pan, pinch, and prefetch to the latest 90 days. This is a frontend limit: the field gateway has 83,279 `device_data` rows from 11 April through 7 October 2026, so retained rows exist outside the pilot's current extent.
2. `PilotApp.tsx` renders `ChartHost` only when `accepted.series.length > 0`. A valid empty response therefore removes the element that owns native pinch and pan. The range buttons still work because they call the store outside the chart, which explains the reported one-way failure.
3. The existing request mapping is accepted by both APIs. Both support explicit `from`/`to`, the advertised `30d` range label, and `daily` aggregation. Cloud rejects a made-up `custom` range, while `season` has active-season semantics and is not a substitute for an arbitrary interval. Keep `range=30d` for daily requests.
4. Availability differs by host, card, source, channel, interval, and aggregation. On the field gateway raw rows begin in April. In the cloud snapshot, the three Kiwi raw streams begin on 10 September; daily soil rollups begin on 7 July and hourly soil rollups on 27 September. A 30-day historical request can therefore be empty at `hourly` while a daily rollup exists for the same bounds. The frontend cannot expose Pi-only rows through the cloud API.
5. Edge daily queries may read `history_channel_rollups` plus today's raw rows, or fall back to raw `device_data`; the soil-card safety rule deliberately bypasses merged rollups for an ineligible plain LSN50. Cloud ranges labelled `30d` read typed rollups and do not fall back to edge data. No backend, schema, sync, retention, or production deployment change is justified by this fix.

The gateway-wide row count proves that the 90-day frontend limit hides real retained data. It does not prove that every zone, card, channel, or interval has points. The UI and verification record must preserve that distinction.

## Fixed behavior

- Define `HISTORY_NAVIGATION_START_MS = 0` (the Unix epoch) and `HISTORY_MAX_VIEWPORT_SPAN_MS = 90 * DAY_MS` as separate named exports in `range.ts`. The epoch is a finite technical bound far earlier than any plausible OSI sensor record; it avoids replacing the current 90-day cutoff with another recent arbitrary cutoff.
- The navigation horizon is `{ from: HISTORY_NAVIGATION_START_MS, to: currentMinute }`. The initial viewport remains the latest 24 hours. Pinch zoom remains limited to 90 days, and `requestForViewport` continues to reject a span over 90 days. Back, Forward, pan, neighbor prefetch, cache lookup, and Latest use the broader navigation horizon but never fetch the full horizon.
- Add optional `maxSpanMs` plumbing from `ChartHost` to `attachD3ViewportController`. Set the D3 zoom scale extent to `[extentDuration / maxSpanMs, extentDuration / minSpanMs]`. The pilot passes 90 days. Comparison routes omit the prop and retain their current default of the full extent. This prevents D3 from proposing decade-wide transforms that the viewport store repeatedly clamps, which would otherwise create reverse-pinch hysteresis at the 90-day limit.
- Preserve the existing tier choice for the first request: up to 24 hours `24h/raw`, up to 7 days `7d/15m`, up to 30 days `30d/hourly`, and up to 90 days `30d/daily`.
- Keep the current aggregation policy unchanged. Do not silently retry empty raw/15m/hourly responses as daily, add a weekly tier, or infer that a different resolution contains equivalent detail. The observed cloud rollup gaps are documented evidence for a later card-specific availability design, not authority to change query meaning here.
- For an accepted empty response on a supported numeric card, keep `ChartHost` and `.pilot-chart-wrap` mounted with `series=[]`, the same `store`, navigation extent, minimum span, and fixed chart geometry. The current uPlot adapter already supports empty data (`[[]]`) and an automatic `[0,1]` y-range. Show one overlay/status message: **“No data for this card in this interval. Pinch, drag, Back, Forward, or Latest to try another interval.”**
- Keep the accepted range and returned aggregation visible for an empty response. For a context that previously had data, retain and render its last-known unit and series **metadata** (labels, units, ids, and enabled state) so the sensor/legend rows keep their space; pass no stale points to the chart. The toggles may continue to update the remembered selection. “All series are hidden” remains reserved for a nonempty accepted response whose user-disabled selection produces `series.length === 0`.
- A transient empty response in the same zone/card context must not erase the selected unit, enabled-series ids, known-series bookkeeping, or change the chart wrapper's measured bounds. When populated data returns, restore the prior compatible unit and toggles; if the returned card no longer has that unit or those ids, apply the existing valid-series reconciliation then. An initially empty card has no invented unit/series metadata, but still renders a fixed empty-state slot and interactive chart; its empty overlay must not intercept pointer or touch events.
- Initial catalog emptiness, unsupported cards, first-load HTTP/malformed errors, and auth-required state retain their current full-page behavior. They have no accepted data interval and need not mount a chart. A valid accepted empty interval is not an error and keeps the load status quiet (`Ready · no data`).
- README wording must say that navigation can address historical intervals back to the technical bound while each visible/requested interval is at most 90 days. It must also say that results describe the selected host/card/interval and that edge and cloud can retain or materialize different history.

## Task 1: Separate navigation extent from the maximum gesture/request span

**Owner:** one implementer; these scheduler and range files are coupled.

**Files:**
- Modify: `web/history-zoom-prototypes/src/pilot/range.ts`
- Modify: `web/history-zoom-prototypes/src/pilot/usePilotHistory.ts`
- Modify: `web/history-zoom-prototypes/src/ChartHost.tsx`
- Modify: `web/history-zoom-prototypes/src/shared/gestures.ts`
- Modify: `web/history-zoom-prototypes/tests/unit/pilot-range.test.ts`
- Modify: `web/history-zoom-prototypes/tests/unit/pilot-history.test.tsx`
- Modify: `web/history-zoom-prototypes/tests/unit/gestures.test.ts` (or the existing controller test file)

- [ ] Add failing range tests that pin the two independent bounds. A 24-hour and a 90-day viewport wholly older than `now - 90d` must map to the existing aggregation tiers; a viewport may move back beyond the former cutoff; the store still clamps zoom to 90 days; `requestForViewport` still rejects a span over 90 days; `neighborRequest` at the Unix boundary returns `null` without generating negative timestamps.
- [ ] Export the two constants, construct the hook horizon from the navigation start and current minute, and pass the 90-day constant as the viewport store's `maxSpanMs`. Keep `Latest` horizon refresh and the current visible span behavior intact. Update only unit assertions whose intended contract was the former 90-day navigation floor; do not weaken unrelated loading, cache, auth, or concurrency assertions.
- [ ] Add failing controller tests for the independent D3 limits. With an epoch-to-now extent and a 90-day maximum, the minimum scale must be `extentDuration / 90d`; zooming out stops at 90 days; a reverse pinch immediately zooms back in; panning at that span can still move to older intervals. With `maxSpanMs` omitted, comparison routes retain the full-extent minimum scale.
- [ ] Thread `maxSpanMs` through `ChartHost` and the controller options and use it in both transform normalization and `zoom.scaleExtent`. Keep defaults backward compatible and reject/non-fatally normalize invalid limits consistently with existing viewport helpers.
- [ ] Extend the existing hook tests to prove repeated Back navigation can cross `now - 90d`, every emitted request span is at most 90 days, `showLatest()` advances only the upper horizon, and account/context transitions reset to the latest viewport without widening a request.

Focused verification:

```bash
cd web/history-zoom-prototypes
npx vitest run tests/unit/pilot-range.test.ts tests/unit/pilot-history.test.tsx tests/unit/gestures.test.ts tests/unit/pilot-history-loader.test.ts
```

## Task 2: Preserve the gesture surface for accepted empty intervals

**Owner:** one UI/test implementer owns Task 2 and Task 3 because the component state and native recovery proof are one behavior. It may proceed in parallel with Task 1 after the `ChartHost.maxSpanMs` interface is fixed.

**Files:**
- Modify: `web/history-zoom-prototypes/src/pilot/PilotApp.tsx`
- Modify: `web/history-zoom-prototypes/src/styles.css`
- Modify: `web/history-zoom-prototypes/tests/unit/pilot-app.test.tsx`

- [ ] Replace the `accepted.series.length > 0` chart gate with a supported-card accepted-result gate. Keep the chart section at the same measured height for populated, refreshing, and empty states. Mount `ChartHost` with the current selected series, including an empty array.
- [ ] Keep last-known context-scoped unit/series descriptors for layout and controls, separate from the accepted response's point arrays. During a transient empty interval, render those descriptors and the user's enabled subset in the existing rows while giving `ChartHost` `series=[]`. For an initially empty context, render the reserved empty-state slot instead. Put the accepted-empty explanation in the stable chart wrapper as a non-blocking overlay (`pointer-events:none`) so the gesture layer remains reachable. Remove the duplicate page-level accepted-empty paragraph.
- [ ] Guard unit/toggle reconciliation from treating a transient empty response as a new set of available series. Add component tests proving an accepted empty result mounts one `ChartHost`, calls the adapter with an empty series list, exposes the interval-local recovery wording, and retains accepted range and aggregation metadata without showing “All series are hidden.” Transition populated → empty → populated in the same context and prove the compatible unit, enabled subset (including an all-disabled subset), descriptors, and chart bounds persist while no old samples are plotted. Cover initial empty → populated separately without inventing descriptors.
- [ ] Preserve existing assertions for auth, no zones, no cards, unsupported cards, errors, retry, truncation, and a user hiding every series. Add a geometry assertion that the chart wrapper keeps the same reserved height when populated data becomes empty.

Focused verification:

```bash
cd web/history-zoom-prototypes
npx vitest run tests/unit/pilot-app.test.tsx
```

## Task 3: Prove recovery and platform-specific coverage in Chromium fixtures

**Owner:** the same UI/test implementer as Task 2. Root owns the operation-record evidence and any preview deployment after independent review.

**Files:**
- Modify: `web/history-zoom-prototypes/tests/browser/pilot-history.spec.ts`
- Modify: `web/history-zoom-prototypes/tests/browser/pilot-fixtures.ts` only if the fixture needs a deterministic per-request response selector
- Modify: `web/history-zoom-prototypes/README.md`
- Modify: `docs/operations/uplot-real-history-pilot-2026-10-07.md` (root release evidence)

- [ ] Replace the old accepted-empty assertion that expects no chart. For both `edge` and `cloud`, begin with populated data, use native CDP pinch or pan to produce a valid accepted empty interval, and assert that `chart-host`, the page probe, and the chart bounding box remain present and stable.
- [ ] From that empty state, perform another native gesture with no button click. Make the fixture return populated data for the resulting current demand, then assert that the viewport changed, the empty message disappeared, the legend returned, and the accepted range covers the final visible viewport. Record the relevant requests by their actual bounds and aggregation rather than array position.
- [ ] For both platforms, select the 90-day span and move Back once. Assert that the requested interval reaches earlier than the former `now - 90d` boundary, uses `range=30d&aggregation=daily`, spans no more than 90 days, and can render a fixture response. Also assert the chart clamps at the Unix lower boundary without a negative request.
- [ ] Add native pinch proof at the 90-day maximum: further zoom-out leaves the span at 90 days, the next reverse pinch reduces the span immediately, and an older pan still works. Read the rendered viewport from the probe; do not infer it from URL counts.
- [ ] Keep request accounting split into foreground/prefetch/total/aborted using actual request objects. Production prefetch stays enabled. Do not use `networkidle`, global request counts, sleeps as correctness checks, or a button in the gesture-recovery assertion.
- [ ] Update the README and operation record with clear usage wording: each view is at most 90 days; pan, drag, or Back to visit older intervals. The pilot displays only data returned by this host for this card, channels, interval, and resolution. State the field evidence separately: the Pi retains April rows, while the inspected cloud raw streams begin in September and some daily rollups begin in June/July. Do not claim that this frontend change backfills cloud history or automatically changes resolution to find points.

Focused verification:

```bash
cd web/history-zoom-prototypes
npx playwright test tests/browser/pilot-history.spec.ts
```

## Final verification and release evidence

- [ ] Run the package gates from a clean process:

```bash
cd web/history-zoom-prototypes
npm test
npm run build
npm run test:browser
```

- [ ] Review the final diff against this plan and the loading-optimization invariants: token/session fencing, current-intent-only UI application, at most two physical card-data requests, no response merging, no viewport writes from network completion, Latest freshness, hidden-page cancellation, and chart geometry stability.
- [ ] Record unit/build/browser counts and the controlled edge/cloud request traces. Keep live Pi/cloud observations labeled read-only and observational; fixture tests prove client behavior and contracts, not production retention completeness.
- [ ] Root performs adversarial review and coordinates any separately authorized preview deployment. No backend, schema, sync, or live-gateway mutation belongs in this implementation.
