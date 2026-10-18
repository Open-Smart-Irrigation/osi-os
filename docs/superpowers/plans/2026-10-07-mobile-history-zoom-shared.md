# Mobile history zoom shared harness implementation plan

Execution update: the [approved execution amendment](2026-10-07-mobile-history-zoom-execution-amendment.md) governs the shared D3 controller for all three renderers, passing gesture gates, and the test-server deployment.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone shell, shared data, viewport controller, diagnostics, and native-touch browser harness used to compare ECharts, uPlot, and Chart.js on a phone.

**Architecture:** A non-React viewport store is the source of intent. The active adapter renders it and exposes its actual x-domain for comparison. ECharts and uPlot share one D3 gesture layer; Chart.js receives touches on its canvas and reports native plugin changes through the same store.

**Tech Stack:** React 18.3.1, Vite 7.3.7, TypeScript 5.9.3, D3 zoom 3.0.0, Vitest 4.1.6, Playwright 1.63.0

**Spec:** `docs/superpowers/specs/2026-10-07-mobile-history-zoom-prototype-brief.md`

## Global constraints

- Create product files only below `web/history-zoom-prototypes/`; do not import from or edit `web/react-gui`, backend code, or the sister repository.
- Keep `Viewport` values in epoch milliseconds and y fixed at 0 through 100 kPa.
- Use the exact `ChartAdapter` contract in Task 1. Adapter `setViewport` never invokes its callback; `getViewport` reads the live renderer scale.
- Mount one adapter at a time. Create the D3 gesture layer only for ECharts and uPlot. Preserve the viewport when the candidate route changes.
- Use immutable local fixtures and delayed promises only. Do not add a cache, HTTP client, or production integration.
- Treat harness integrity, renderer readback, data fidelity, lifecycle, and evidence completeness as hard gates. Record gesture behavior against fixed suitability criteria, where an observed candidate limitation is an explicit `FAIL`. Treat desktop frame intervals as diagnostics and record that the Pixel 8 Pro check is pending.
- Luna implements the reviewed plan. A fresh Sol agent independently reviews the result before the user performs the real-phone check.

## Review focus

- Empty data and a single point retain the known 90-day x-domain instead of producing `NaN`; empty inspection is unavailable and a nearby single point displays its value.
- A stale delayed fixture response cannot overwrite newer data or reset a panned viewport, even when it resolves after the accepted response.
- A touch release after a long press cannot click a route or control underneath the chart.
- Plot bounds refresh after scroll, resize, and orientation change, so D3 uses current local CSS pixels.
- Route cleanup removes D3 listeners, animation frames, resize observers, and the old renderer before the next adapter mounts.

## File map and ownership

The shared implementer owns all files below except `src/adapters/{echarts,uplot,chartjs}.ts`, `src/adapters/uplot-data.ts`, their three adapter unit tests, and `tests/uplot-data.test.ts`. Do not edit another candidate's adapter to make an integration test pass.

```text
web/history-zoom-prototypes/
  package.json                    pinned dependencies and scripts
  package-lock.json               generated npm lock
  index.html                      Vite entry
  vite.config.ts                  Vitest/jsdom config
  playwright.config.ts            Pixel 8 Pro Chromium project
  tsconfig.json                    strict browser TypeScript
  src/main.tsx                     React mount
  src/App.tsx                      controls, fixture requests, route changes
  src/ChartHost.tsx                adapter lifecycle and conditional gesture layer
  src/routes.ts                    hash parsing and lazy adapter selection
  src/styles.css                   mobile layout and exact chart geometry
  src/shared/types.ts              contract, constants, fixture names
  src/shared/fixtures.ts           deterministic immutable fixture factories
  src/shared/viewport.ts           clamp/store/transform conversion
  src/shared/gestures.ts           D3 overlay controller
  src/shared/inspection.ts         live value lookup and test probe
  src/shared/loading.ts            latest-request-wins fixture delay
  src/shared/metrics.ts            requestAnimationFrame diagnostics
  tests/setup.ts                   jsdom geometry/observer shims
  tests/unit/*.test.ts             shared unit tests
  tests/browser/cdp-touch.ts       native CDP touch sequence builders
  tests/browser/history-zoom.spec.ts cross-candidate behavior
  README.md                        local and phone commands, result limits
```

### Task 1: Package and stable public contract

**Files:**
- Create: `web/history-zoom-prototypes/package.json`
- Create: `web/history-zoom-prototypes/package-lock.json`
- Create: `web/history-zoom-prototypes/index.html`
- Create: `web/history-zoom-prototypes/vite.config.ts`
- Create: `web/history-zoom-prototypes/playwright.config.ts`
- Create: `web/history-zoom-prototypes/tsconfig.json`
- Create: `web/history-zoom-prototypes/src/shared/types.ts`
- Create: `web/history-zoom-prototypes/tests/setup.ts`
- Test: `web/history-zoom-prototypes/tests/unit/types.test.ts`

**Interfaces:**
- Produces: `Viewport`, `Point`, `SensorSeries`, `ChartAdapter`, `MountAdapter`, `Candidate`, `FixtureKind`, `ViewportSource`, `FrameSummary`, `HistoryZoomProbe`, `MINUTE_MS`, `HOUR_MS`, `DAY_MS`, `FIXTURE_EXTENT`, `INITIAL_VIEWPORT`, `MIN_SPAN_MS`, `MAX_SPAN_MS`, `PLOT_INSETS`, `CHART_HEIGHT`, `SERIES_COLORS`, and `SUITABILITY_CRITERIA`.

- [ ] **Step 1: Create minimal test and build scaffolding**

Create `package.json` with the scripts printed in Step 4 before running the first test. Use exact runtime dependencies `react@18.3.1`, `react-dom@18.3.1`, `echarts@5.6.0`, `uplot@1.6.32`, `chart.js@4.5.1`, `chartjs-plugin-zoom@2.2.0`, `d3-selection@3.0.0`, `d3-zoom@3.0.0`, and `d3-scale@4.0.2`. Pin dev packages to the versions in the header plus `@playwright/test@1.63.0`, `@vitejs/plugin-react@4.7.0`, `@types/node@22.20.5`, `@types/react@18.3.31`, `@types/react-dom@18.3.7`, `@types/d3-selection@3.0.12`, `@types/d3-zoom@3.0.9`, `@types/d3-scale@4.0.9`, `@testing-library/react@16.3.2`, `@testing-library/dom@10.4.2`, `jsdom@29.1.1`, `pngjs@7.0.0`, and `@types/pngjs@6.0.5`. Run `npm install` to produce the lock. Node 22.23.2 satisfies Vite 7 and jsdom 29; do not inherit the production GUI's Vite 5 constraint into this isolated package.

Configure Vitest with `environment:'jsdom'`, `setupFiles:['tests/setup.ts']`, `include:['tests/**/*.test.ts','tests/**/*.test.tsx']`, and `exclude:['tests/browser/**']`. Configure `tsconfig.json` with `strict:true`, DOM libraries, `jsx:'react-jsx'`, and includes for `src`, `tests/unit`, `tests/*.test.ts`, and `tests/*.test.tsx`; exclude `tests/browser` because Playwright compiles that suite. Configure Playwright separately with `testDir:'tests/browser'`, `viewport:{width:448,height:998}`, `deviceScaleFactor:3`, `isMobile:true`, `hasTouch:true`, Chromium, and a Vite web server command. Name the project `pixel-8-pro`. This is a fixed comparison profile, not a claim about the user's browser viewport: Android display settings and browser chrome change CSS dimensions. Also test 998 by 448 on rotation and a compact 390 by 844 profile; record actual `innerWidth`, `innerHeight`, and DPR during the physical-phone check.

- [ ] **Step 2: Write the contract test**

Assert exact values: extent `Date.UTC(2026, 6, 1)` through 90 days later, initial viewport the final 24 hours, minimum one hour, maximum 90 days, chart height 360, and insets `{top:16,right:12,bottom:36,left:52}`. Add a compile-time adapter literal with all six methods, including renderer readback:

```ts
const adapter: ChartAdapter = {
  setData: (_series) => undefined,
  setViewport: (_viewport) => undefined,
  getViewport: () => INITIAL_VIEWPORT,
  getPlotRect: () => new DOMRectReadOnly(52, 16, 326, 308),
  resize: () => undefined,
  destroy: () => undefined,
};
expect(adapter.getViewport()).toEqual(INITIAL_VIEWPORT);
```

- [ ] **Step 3: Run the test and observe the missing module failure**

Run: `cd web/history-zoom-prototypes && npm test -- tests/unit/types.test.ts`

Expected: FAIL because `src/shared/types.ts` does not exist.

- [ ] **Step 4: Create the contract**

Use scripts:

```json
{
  "dev": "vite --host 0.0.0.0",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview --host 0.0.0.0",
  "test": "vitest run",
  "test:browser": "playwright test",
  "check": "npm test && npm run build && npm run test:browser"
}
```

Define `ChartAdapter` exactly as follows:

```ts
export interface ChartAdapter {
  setData(series: readonly SensorSeries[]): void;
  setViewport(viewport: Viewport): void;
  getViewport(): Viewport;
  getPlotRect(): DOMRectReadOnly;
  resize(): void;
  destroy(): void;
}
export type MountAdapter = (
  host: HTMLElement,
  initial: Viewport,
  onViewportChange: (viewport: Viewport) => void,
) => ChartAdapter;
```

Define `FixtureKind = 'nominal' | 'sparse' | 'stress' | 'empty' | 'single'` and `ViewportSource = 'gesture' | 'external'`. Define `MINUTE_MS = 60_000`, `HOUR_MS = 60 * MINUTE_MS`, and `DAY_MS = 24 * HOUR_MS`; derive every extent and tolerance from these constants. Put `FrameSummary` and the exact `HistoryZoomProbe` interface from Task 4 in this file so adapters, shell, and tests share one type source. Define `SUITABILITY_CRITERIA` as `['pinch-step-invariance','moving-anchor','pinch-axis-orientation','reverse-pinch','initial-pan','partial-lift-id-1','partial-lift-id-2','cancel-recovery','device-orientation-resize'] as const`. Keep this package independent; do not add a root workspace entry.

- [ ] **Step 5: Run the contract test and typecheck**

Run: `cd web/history-zoom-prototypes && npm test -- tests/unit/types.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit the package boundary**

```bash
git add web/history-zoom-prototypes/package.json web/history-zoom-prototypes/package-lock.json web/history-zoom-prototypes/index.html web/history-zoom-prototypes/vite.config.ts web/history-zoom-prototypes/playwright.config.ts web/history-zoom-prototypes/tsconfig.json web/history-zoom-prototypes/src/shared/types.ts web/history-zoom-prototypes/tests/setup.ts web/history-zoom-prototypes/tests/unit/types.test.ts
git commit -m "test: define history zoom prototype contract"
```

### Task 2: Deterministic fixtures, viewport store, and latest-request loading

**Files:**
- Create: `web/history-zoom-prototypes/src/shared/fixtures.ts`
- Create: `web/history-zoom-prototypes/src/shared/viewport.ts`
- Create: `web/history-zoom-prototypes/src/shared/loading.ts`
- Test: `web/history-zoom-prototypes/tests/unit/fixtures.test.ts`
- Test: `web/history-zoom-prototypes/tests/unit/viewport.test.ts`
- Test: `web/history-zoom-prototypes/tests/unit/loading.test.ts`

**Interfaces:**
- Produces: `fixtureSeries(kind): readonly SensorSeries[]`, `requestFixture(kind, delayMs)`, `normalizeViewport`, `sameViewport`, `ViewportStore`, `createViewportStore`, `viewportToTransform`, and `transformToViewport`.
- Consumes: constants and data types from Task 1.

- [ ] **Step 1: Write failing fixture tests**

Assert frozen arrays, sorted epoch milliseconds, distinct offset timestamps, all three series, and exact initial-window evidence: at least one `0`, the null run's start and end, and a `96` spike. Assert `stress` has at least 100,000 total points. Assert `empty` returns `[]` and `single` returns one one-point series without changing `FIXTURE_EXTENT`.

- [ ] **Step 2: Write failing viewport and loading tests**

Use table cases for spans below one hour, above 90 days, left/right boundary pans, and invalid `NaN`/reversed input (fall back to the prior valid viewport supplied to the store). Prove these signatures:

```ts
normalizeViewport(candidate, extent, minSpanMs, maxSpanMs, fallback): Viewport
sameViewport(a, b, epsilonMs = 1): boolean
viewportToTransform(viewport, extent, width): ZoomTransform
transformToViewport(transform, extent, width, fallback): Viewport
interface ViewportStore {
  get(): Viewport;
  set(candidate: Viewport, source: ViewportSource): Viewport;
  subscribe(listener: (viewport: Viewport, source: ViewportSource) => void): () => void;
}
createViewportStore(initial, extent): {
  get(): Viewport;
  set(candidate: Viewport, source: ViewportSource): Viewport;
  subscribe(listener: (viewport: Viewport, source: ViewportSource) => void): () => void;
}
```

For loading, start `nominal` at 100 ms and `sparse` at 10 ms. Accept sparse, advance fake timers until nominal resolves last, and assert nominal cannot apply.

- [ ] **Step 3: Run the focused tests and verify red**

Run: `cd web/history-zoom-prototypes && npm test -- tests/unit/fixtures.test.ts tests/unit/viewport.test.ts tests/unit/loading.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 4: Implement only deterministic generation and normalization**

Use a fixed-seed integer PRNG, not `Math.random`. Generate nominal at 40-minute cadence (about 9,723 values across three 90-day series), then insert enough offset samples in its last day to exceed 10,000 total and place zero, outage boundaries, and the 96 kPa spike there. Generate stress at three-minute cadence (about 129,603 values). Freeze series, point arrays, and point objects.

Implement viewport normalization with these exact operations. If either edge is non-finite or `from >= to`, return a copy of the supplied fallback (the store passes its current value). Clamp the candidate span to `[minSpanMs, maxSpanMs]`, preserve its midpoint, then shift both edges right when `from < extent.from` or left when `to > extent.to`. The known extent is at least `maxSpanMs`, so the final result has the chosen span and lies inside the extent. `sameViewport` compares both edges with `Math.abs(edgeA - edgeB) <= epsilonMs`.

Use the full extent as a D3 base scale with range `[0, width]`. Convert a viewport to a zoom transform with:

```ts
const k = (extent.to - extent.from) / (viewport.to - viewport.from);
const x = -((viewport.from - extent.from) / (extent.to - extent.from)) * width * k;
return zoomIdentity.translate(x, 0).scale(k);
```

Convert back with `transform.rescaleX(baseScale).domain()`, then normalize the two returned edges. The store skips notifications when both normalized edges equal the current value within 1 ms; otherwise it stores a fresh object and passes the unchanged source to each listener.

Implement loading as one delayed local promise:

```ts
export function requestFixture(kind: FixtureKind, delayMs: number) {
  return new Promise<readonly SensorSeries[]>((resolve) => {
    window.setTimeout(() => resolve(fixtureSeries(kind)), delayMs);
  });
}
```

This function has no cache, retry, or networking behavior.

Add the bounded stale-response owner the shell uses:

```ts
export function createFixtureLoader(load = requestFixture) {
  let generation = 0;
  let destroyed = false;
  return {
    async load(kind: FixtureKind, delayMs: number, apply: (series: readonly SensorSeries[]) => void) {
      const mine = ++generation;
      const series = await load(kind, delayMs);
      if (destroyed || mine !== generation) return false;
      apply(series);
      return true;
    },
    destroy() { destroyed = true; generation += 1; },
  };
}
```

Unit-test a deferred loader whose second promise resolves first, then whose first promise resolves last. Assert `apply` receives only the second result. Destroy with a request outstanding and assert it applies nothing.

- [ ] **Step 5: Run focused tests**

Run: `cd web/history-zoom-prototypes && npm test -- tests/unit/fixtures.test.ts tests/unit/viewport.test.ts tests/unit/loading.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit shared state rules**

```bash
git add web/history-zoom-prototypes/src/shared/{fixtures,viewport,loading}.ts web/history-zoom-prototypes/tests/unit/{fixtures,viewport,loading}.test.ts
git commit -m "feat: add shared history fixtures and viewport state"
```

### Task 3: D3 gesture controller and geometry refresh

**Files:**
- Create: `web/history-zoom-prototypes/src/shared/gestures.ts`
- Test: `web/history-zoom-prototypes/tests/unit/gestures.test.ts`

**Interfaces:**
- Produces: `attachD3ViewportController(host, layer, adapter, store): { sync(viewport): void; refreshGeometry(): void; destroy(): void }`.
- Consumes: `ChartAdapter`, viewport store, `viewportToTransform`, `transformToViewport`.

- [ ] **Step 1: Write failing controller tests**

Use a 390 px host and adapter plot rect derived from the real host rect. Assert that `refreshGeometry()` positions `.gesture-layer` at the adapter's left/top offset and plot width/height; scroll and resize change those values. Dispatch D3 transforms and assert store updates, adapter `setViewport` is called, and `getViewport` agrees. Call `sync` and assert it does not notify the store. Destroy twice, then dispatch touch/zoom and assert no notification.

- [ ] **Step 2: Run the test and verify red**

Run: `cd web/history-zoom-prototypes && npm test -- tests/unit/gestures.test.ts`

Expected: FAIL because `gestures.ts` is absent.

- [ ] **Step 3: Implement a single D3 owner**

Create a base `scaleLinear().domain([extent.from, extent.to]).range([0, width])`. Configure zoom with `scaleExtent([1, 2160])`, matching `extent` and `translateExtent`, no transitions, and `filter(event => event.type.startsWith('touch'))` for this phone-only comparison. This filter must accept two-finger touch events, not only the first touch identifier. In the zoom handler, replace `pendingViewport` with the latest converted proposal and request one animation frame when none is pending. Use this flush shape so the adapter updates only for an accepted change:

```ts
function flushPending() {
  frameId = null;
  if (!pendingViewport) return;
  const proposal = pendingViewport;
  pendingViewport = null;
  const before = store.get();
  const accepted = store.set(proposal, 'gesture');
  if (!sameViewport(before, accepted)) adapter.setViewport(accepted);
}
```

Do not render once per raw touch event.

On D3 `end`, cancel the outstanding frame if present and synchronously run the same flush function. This makes the final finger position observable before a browser test reads `getViewport`. In the D3 end handler, inspect `event.sourceEvent?.type`. For `touchcancel`, cancel the pending frame, discard the proposal, and synchronize D3 back to `store.get()` under the callback guard after the gesture ends. Otherwise flush the final proposal. This prevents a cancelled unrendered transform from changing the next gesture's starting point.

Use a `syncing` boolean around `selection.call(zoom.transform, viewportToTransform(viewport, extent, width))` so programmatic synchronization cannot re-enter. Subscribe to the store and call this synchronization only when `source === 'external'`; never echo `gesture` back to D3 during an active touch. `refreshGeometry` must call `adapter.getPlotRect()` live and subtract `host.getBoundingClientRect()`, then rebuild the base range and D3 extents. A passive scroll listener refreshes position only. A ResizeObserver on the chart frame first calls `adapter.resize()`, then refreshes the overlay and synchronizes D3 from `store.get()` under the guard when its width changes. Do not resynchronize for position-only scrolling. Disconnect the observer during cleanup. Cancel pending animation frames and remove the store subscription plus namespaced D3/window listeners in idempotent `destroy`.

The shell changes an external viewport in one place:

```ts
function applyExternalViewport(candidate: Viewport) {
  const before = store.get();
  const accepted = store.set(candidate, 'external');
  if (!sameViewport(before, accepted)) adapter.setViewport(accepted);
}
```

The controller's synchronous store listener synchronizes its D3 transform for `external`; its `syncing` guard ignores the generated D3 event. `applyExternalViewport` then updates the adapter. Reset uses this function. Chart.js's mount callback instead runs `const accepted = store.set(proposed, 'gesture'); if (!sameViewport(accepted, proposed)) adapter.setViewport(accepted);`. Its renderer has already applied the native gesture; only a normalization correction writes back. Guard late callbacks with the current mount generation. Increment that generation on route change and ignore a lazy adapter import that resolves for an older generation. Route mount initializes the adapter and D3 controller from `store.get()` without writing the store. Data refresh reapplies `adapter.setViewport(store.get())` directly without changing or notifying the store.

Set `touch-action:none` and `user-select:none` only on the plot-sized layer. Prevent the synthetic click following a moved or long-pressed chart touch, but do not install document-wide click suppression.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web/history-zoom-prototypes && npm test -- tests/unit/gestures.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit the shared gesture owner**

```bash
git add web/history-zoom-prototypes/package.json web/history-zoom-prototypes/package-lock.json web/history-zoom-prototypes/src/shared/gestures.ts web/history-zoom-prototypes/tests/unit/gestures.test.ts
git commit -m "feat: add anchored D3 history gestures"
```

### Task 4: Shell, adapter lifecycle, inspection, and diagnostics

**Files:**
- Create: `web/history-zoom-prototypes/src/main.tsx`
- Create: `web/history-zoom-prototypes/src/App.tsx`
- Create: `web/history-zoom-prototypes/src/ChartHost.tsx`
- Create: `web/history-zoom-prototypes/src/routes.ts`
- Create: `web/history-zoom-prototypes/src/styles.css`
- Create: `web/history-zoom-prototypes/src/shared/inspection.ts`
- Create: `web/history-zoom-prototypes/src/shared/metrics.ts`
- Test: `web/history-zoom-prototypes/tests/unit/shell.test.tsx`
- Test: `web/history-zoom-prototypes/tests/unit/inspection.test.ts`
- Test: `web/history-zoom-prototypes/tests/unit/metrics.test.ts`

**Interfaces:**
- Produces: lazy route loaders, `inspectAtTime`, the tap-pinned reading inspector, `startFrameSampler`, and `window.__historyZoomProbe`.
- Consumes: shared contract, store, loaders, fixtures, and candidate adapters.

- [ ] **Step 1: Write failing lifecycle and inspection tests**

Inject fake route adapters into `ChartHost`. Prove lifecycle order is mount empty adapter, `setData` with non-empty nominal data, `setViewport`, `resize`, then D3 attachment for ECharts/uPlot. Prove Chart.js gets no `.gesture-layer`. Route switching calls controller destroy and adapter destroy before the next mount while preserving fixture and viewport. Resolve an old fixture after a newer one and assert its `setData` never runs; resolve current data after a pan and assert the requested and rendered viewports differ by at most 1 ms from the pre-load viewport.

Test `inspectAtTime` with zero, null, an outage, empty data, and a single sample. Its tolerance is `Math.min(6 * HOUR_MS, Math.max(5 * MINUTE_MS, viewportSpan / 80))`. Choose the nearest point including nulls; if that point is null, return unavailable and never search past it. Null, absent, and farther samples return `{kind:'unavailable'}`; zero returns `{kind:'value', value:0, sampledAt:number}`. Test that each value row shows its actual sample timestamp, a sample-point tap finds the single value, the close button closes the panel, and a moved, pinched, cancelled, or long-pressed touch does not synthesize an inspector tap.

- [ ] **Step 2: Write failing metrics tests**

Specify:

```ts
interface FrameSummary {
  sampleCount: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  over16_7: number;
  over33_3: number;
}
startFrameSampler(requestFrame?, cancelFrame?, now?): { stop(): FrameSummary }
```

Drive fake RAF timestamps `[0, 16, 34, 70]` and assert the summary counts the three intervals. Assert `stop()` is idempotent and cancels the scheduled callback.

- [ ] **Step 3: Run focused tests and verify red**

Run: `cd web/history-zoom-prototypes && npm test -- tests/unit/shell.test.tsx tests/unit/inspection.test.ts tests/unit/metrics.test.ts`

Expected: FAIL on missing shell and helpers.

- [ ] **Step 4: Implement the shell without per-frame React state**

Parse only `echarts`, `uplot`, and `chartjs`; replace unknown hashes with `#/uplot`. Discover candidates without importing missing files during the shared-harness stage:

```ts
const modules = import.meta.glob<{ default: MountAdapter }>([
  './adapters/echarts.ts', './adapters/uplot.ts', './adapters/chartjs.ts',
]);
const paths = {
  echarts: './adapters/echarts.ts',
  uplot: './adapters/uplot.ts',
  chartjs: './adapters/chartjs.ts',
} as const;
export async function loadAdapter(candidate: Candidate): Promise<MountAdapter | null> {
  const load = modules[paths[candidate]];
  return load ? (await load()).default : null;
}
```

Render `Candidate unavailable: adapter not implemented` when the result is null; do not create placeholder adapter files. `ChartHost` also accepts an injected `MountAdapter` for unit tests. This lets the shared `npm test` and `npm run build` pass before candidate work begins.

`App` owns one viewport store, the accepted fixture data, and one `createFixtureLoader` instance so viewport and data survive candidate changes. `ChartHost` keeps only its adapter and optional D3 controller in refs. Its store subscription mutates the pinned inspector guide through a ref and schedules at most one 100 ms React diagnostic update. Candidate buttons and fixture controls live outside the chart frame and use `data-testid="candidate-{name}"`, `fixture-select`, `load-delay-ms`, `load-fixture`, and `reset-viewport`.

On fixture selection, call `fixtureLoader.load(kind, delayMs, apply)`. Let older promises resolve so the out-of-order test exercises the loader's generation guard. In `apply`, store the accepted immutable series in `App`; the active `ChartHost` effect then calls `adapter.setData(series)` followed by `adapter.setViewport(store.get())`. Compare `adapter.getViewport()` within 1 ms and expose disagreement in the probe. Destroy the loader only when `App` unmounts. A route change mounts the new adapter with the already accepted series before attaching gestures.

The chart host uses `data-testid="chart-host"`; the D3-only layer uses `gesture-layer`. A plot tap converts its x coordinate through the current viewport, pins the inspector, and renders `data-testid="inspector"` with timestamp and value/unit rows plus `inspector-close`. Gesture movement beyond four CSS pixels, multiple touches, cancellation, or a press lasting 500 ms suppresses the following click. Keep this suppression within the chart host.

Use the canonical `HistoryZoomProbe` from `types.ts`, with these exact fields and callable sampling methods:

```ts
interface HistoryZoomProbe {
  route: Candidate;
  requestedViewport: Viewport;
  renderedViewport: Viewport;
  plotRect: { left:number; top:number; width:number; height:number };
  adapterSetViewportCalls: number;
  viewportNotifications: number;
  reactRenderCount: number;
  frameSamples: readonly FrameSummary[];
  startFrameSampling(): void;
  stopFrameSampling(): FrameSummary;
}
```

Do not let diagnostics intercept pointer events. Give the page enough content above and below the chart to test scrolling. Use the exact shared chart height and plot insets. Render one shared legend and kPa label outside the chart frame. Use two-pixel lines and four-pixel-diameter markers when a series has at most 500 input points; larger series omit markers.

- [ ] **Step 5: Run shell tests and build**

Run: `cd web/history-zoom-prototypes && npm test -- tests/unit/shell.test.tsx tests/unit/inspection.test.ts tests/unit/metrics.test.ts && npm run build`

Expected: PASS; `dist/index.html` exists.

At this point no adapter file is required. The unit suite uses injected fakes and the built page shows the honest unavailable state. Candidate browser cases begin only after all three candidate plans have added their modules.

- [ ] **Step 6: Commit the working shell**

```bash
git add web/history-zoom-prototypes/src web/history-zoom-prototypes/tests/unit
git commit -m "feat: add mobile history comparison shell"
```

### Task 5: Native CDP behavior suite and phone handoff

**Files:**
- Create: `web/history-zoom-prototypes/tests/browser/cdp-touch.ts`
- Create: `web/history-zoom-prototypes/tests/browser/history-zoom.spec.ts`
- Create: `web/history-zoom-prototypes/README.md`
- Create: `web/history-zoom-prototypes/.gitignore`

**Interfaces:**
- Produces: `dispatchTouchSequence`, `pinchPoints`, `panPoints`, `liftSecondFingerAndContinue`.
- Consumes: the real page probe and all three complete adapters.

- [ ] **Step 1: Implement the exact CDP event builder and write failing browser cases**

Represent each step as `{type:'touchStart'|'touchMove'|'touchEnd'|'touchCancel', active: TouchPoint[], changed?: TouchPoint[]}`. `dispatchTouchSequence` sends active points for starts/moves. For a partial lift it sends `touchEnd` with the released finger as the changed point while the other finger remains active, matching the successful research trace. Exercise both orders: release id 2 and continue id 1, then reset, release id 1 and continue id 2.

`pinchPoints(rect,{startGap,endGap,startCenterX,endCenterX,y,steps})` must interpolate both separation and centroid. `panPoints(rect,{fromX,toX,y,steps})` uses one stable id. All coordinates derive from the current probe plot rectangle and remain at least two CSS pixels from an edge unless a boundary case says otherwise.

Wrap route cases in `test.describe(candidate, ...)` so `--grep chartjs` and the other candidate filters select real tests. For each route, use the exact test titles `preserves the renderer viewport through equivalent 60-step and 4-step pinches`, `keeps the moving pinch midpoint anchored`, and `continues 1 -> 2 -> 1 without a jump`. Assert requested and rendered domains after initial pan, reverse pinch, cancellation then fresh pan, both partial-lift orders, and orientation resize then pinch. Assert no extra click changes the route or inspector after long press/release. Scroll above and below the chart and assert `window.scrollY` changes while both viewports do not.

- [ ] **Step 2: Add loading, cleanup, and diagnostic cases**

Trigger slow nominal then fast sparse, pan before resolution, and prove sparse wins and both domains remain within 1 ms. Cycle all routes and assert one `chart-host`, no orphan candidate root or gesture layer, and no duplicate notifications attributable to the old adapter. Old and new plots occupy the same coordinates, so a touch there must still operate the new chart. Separately unmount the chart, keep its frame empty, send touch at the former rectangle, and assert zero notifications; unit tests also dispatch to retained detached elements. Assert the viewport is preserved within 1 ms through each switch and agrees with the newly mounted renderer.

Use the pinned `pngjs` package in the test `renders zero, spike, and a visible null gap from the nominal fixture`. Capture each route and map the known nominal timestamps and values into the adapter-backed plot rectangle. Decode a screenshot captured with `scale:'css'` so PNG coordinates match the CSS plot rectangle. A 5 by 5 pixel neighborhood at the real zero and 96 kPa spike must contain a pixel within RGB Euclidean distance 40 of that series' stroke; the same neighborhood halfway across the explicit null interval must contain none. Import the fixture and color from shared modules so the browser test uses exact known coordinates. This is renderer evidence, not an assertion on fixture arrays.

At device scale factor 3, record nominal (about 10,000 points) and stress (at least 100,000) samples. Write `test-results/diagnostics/{route}-{fixture}.json` with route, fixture, point count, `FrameSummary`, browser version, viewport, DPR, and `environment: "desktop Chromium Pixel 8 Pro emulation; real Pixel pending"`. Write each route’s gesture results to a distinct temporary result file. A final single-writer aggregation step produces `test-results/diagnostics/suitability.json` after validating that every route and criterion exists; parallel workers must not overwrite the same file. Do not assert a 60 fps threshold.

Load the production build in one browser case, record every request, and fail if an HTTP request leaves the Vite preview origin. Local JavaScript chunks, `data:` URLs, and `blob:` URLs are allowed. This proves the static prototype does not depend on a runtime CDN.

- [ ] **Step 3: Run browser tests and inspect failures**

Run: `cd web/history-zoom-prototypes && npm run test:browser`

Expected before all candidate plans are complete: shared unit tests and build PASS, while the full browser matrix waits for candidate modules. After all three adapter plans, harness and renderer-integrity assertions PASS and six diagnostic JSON files exist. Gesture comparisons produce a suitability record instead of failing the Playwright process for a candidate's measured behavior. Apply these fixed rules:

- `pinch-step-invariance`: 60-step and four-step final spans differ by at most 1%.
- `moving-anchor`: the time under the moving centroid drifts by at most two CSS pixels away from an extent clamp.
- `pinch-axis-orientation`: a mostly vertical and a horizontal two-finger arrangement using the same Euclidean gap ratio produce final spans within 1%.
- `reverse-pinch`: the span grows by at least 10% and rendered/requested edges agree within 1 ms.
- `initial-pan`: the domain moves in the intended direction by at least 5% of its span and rendered/requested edges agree within 1 ms.
- `partial-lift-id-1` and `partial-lift-id-2`: the transition jumps by at most two CSS pixels, then the remaining finger pans at least 5% of the span in the intended direction.
- `cancel-recovery`: the next fresh pan moves at least 5% of the span and rendered/requested edges agree within 1 ms.
- `device-orientation-resize`: plot geometry changes, the domain survives within 1 ms, and the next anchored pinch drifts by at most two CSS pixels.
Cleanup is a hard correctness assertion, not a gesture score: with the chart unmounted and its frame left empty, touches at its former position produce zero notifications.

Otherwise record `FAIL` with observed values. No result may be skipped or use a candidate-specific tolerance.

- [ ] **Step 4: Document local and phone use**

The README lists `npm install`, `npm run dev`, `npm test`, `npm run build`, `npm run preview`, and `npm run test:browser`. Give LAN URLs ending in `/#/echarts`, `/#/uplot`, and `/#/chartjs`, using the host address printed by Vite. Link the uPlot demo as the feel reference. State that frame files are desktop diagnostics, real Pixel 8 Pro feel/performance is pending, and production deployment is outside scope.

- [ ] **Step 5: Run all shared and candidate gates**

Run:

```bash
cd web/history-zoom-prototypes
npm test
npm run build
npm run test:browser
```

Expected: all hard correctness commands exit 0. Confirm each browser measurement reads both `requestedViewport` and adapter-backed `renderedViewport`. Confirm the suitability JSON contains an explicit `PASS` or `FAIL` for every gesture criterion and route.

- [ ] **Step 6: Run prose check and commit**

Run: `node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/specs/2026-10-07-mobile-history-zoom-prototype-brief.md docs/superpowers/plans/2026-10-07-mobile-history-zoom-shared.md web/history-zoom-prototypes/README.md`

Expected: `slop-check: PASS (no tier-1 findings)`.

```bash
git add web/history-zoom-prototypes/tests/browser web/history-zoom-prototypes/README.md web/history-zoom-prototypes/.gitignore docs/superpowers/specs/2026-10-07-mobile-history-zoom-prototype-brief.md docs/superpowers/plans/2026-10-07-mobile-history-zoom-shared.md
git commit -m "test: verify mobile history gestures across adapters"
```

### Task 6: Independent review and user evidence

**Files:**
- Modify only if review finds a defect: files owned by the failing task

- [ ] **Step 1: Have a fresh Sol agent review the completed branch**

The reviewer checks the shared interface, each adapter's public scale readback, CDP partial-lift payload, scroll boundary, current plot geometry, data-refresh stability, cleanup, and diagnostic wording. They rerun `npm test`, `npm run build`, and `npm run test:browser` and report exact output. The author applies required findings with a red test first and repeats the affected gates.

- [ ] **Step 2: Hand the local preview to the user**

Run `cd web/history-zoom-prototypes && npm run preview -- --host 0.0.0.0`. Give the three LAN hash links. Ask the user to compare pinch anchoring, `1 -> 2 -> 1` continuity, gap rendering, and perceived latency on the Pixel 8 Pro. Record the real-device result separately; do not infer it from desktop emulation.
