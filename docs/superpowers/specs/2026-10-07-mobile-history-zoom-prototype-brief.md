# Mobile sensor-history zoom prototype brief

Execution update: the [approved execution amendment](../plans/2026-10-07-mobile-history-zoom-execution-amendment.md) governs the shared D3 controller for all three renderers, passing gesture gates, and the test-server deployment.

## Decision to make

Build three disposable smartphone prototypes to decide which chart stack gives OSI sensor history the best anchored pinch zoom and horizontal pan on a Pixel 8 Pro. The candidates are ECharts 5.6 with a shared D3 controller, uPlot with that same controller, and Chart.js with its native zoom plugin. The official [uPlot touch demo](https://leeoniya.github.io/uPlot/demos/zoom-touch.html) is the feel reference; it is not a fourth implementation.

The work lives only in `web/history-zoom-prototypes/`, a standalone Vite, React 18, and TypeScript package. It must not import from or change `web/react-gui`, production routes, Node-RED, a backend, or `osi-server`. The package may be deleted after the comparison.

## User experience under test

The chart occupies a mobile page sized for the Pixel 8 Pro CSS viewport. One finger pans time. Two fingers zoom time around their live midpoint: spreading fingers narrows the time range and pinching them together widens it. Translating both fingers while their separation changes moves the data under the moving midpoint instead of snapping around the chart center. Lifting either finger during a two-finger gesture must leave the remaining finger able to continue a pan without a jump.

Gestures begin inside the renderer's plot rectangle. A vertical swipe above or below the chart scrolls the page. Chart.js receives events through its canvas, which also contains axes, while tests target the plot rectangle. No inertia is required. Native page zoom is not part of this comparison.

All candidates draw two-pixel lines and four-pixel-diameter markers for series with at most 500 input points; larger series omit markers. The shared shell owns the legend and kPa label. All candidates use the same fixed y-domain of 0 to 100 kPa, plot margins, height, series colors, fixture picker, reset control, viewport readout, loading controls, and diagnostics. This isolates horizontal navigation. At most one chart is mounted at a time.

## Routes and ownership

The shared shell selects the active candidate by hash: `#/echarts`, `#/uplot`, or `#/chartjs`. An unknown or empty hash redirects to `#/uplot`, matching the demo the user already likes. Switching routes destroys the old adapter before mounting the new one and preserves the shared viewport.

The shared implementation owns package metadata and lockfile, Vite and test configuration, the React shell, routing, fixtures, viewport rules, D3 gestures, loading simulation, diagnostics, test drivers, styling, and README. Candidate owners modify only their named adapter and adapter tests:

| Candidate | Owned implementation |
| --- | --- |
| ECharts | `src/adapters/echarts.ts`, `tests/echarts-adapter.test.ts` |
| uPlot | `src/adapters/uplot.ts`, `src/adapters/uplot-data.ts`, `tests/uplot-adapter.test.ts`, `tests/uplot-data.test.ts` |
| Chart.js | `src/adapters/chartjs.ts`, `tests/chartjs-adapter.test.ts` |

The root agent reviews the shared types and APIs before implementation begins. Luna implements the reviewed plans. A fresh Sol agent performs the final independent review and records the commands and phone-check limits.

## Shared data and adapter contract

Time values are epoch milliseconds. The contract is deliberately small:

```ts
export interface Viewport {
  from: number;
  to: number;
}

export interface Point {
  t: number;
  value: number | null;
}

export interface SensorSeries {
  id: string;
  label: string;
  unit: string;
  points: readonly Point[];
}

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

`setViewport` is one-way and never calls `onViewportChange`. An adapter calls the callback only for a gesture it owns. `getViewport` reads the renderer's actual x-domain through its public scale API; it must not return a cached copy of the requested viewport. In this prototype, Chart.js owns its native plugin gestures. The shared D3 controller owns gestures for ECharts and uPlot and reports directly to the viewport store. The shell normalizes every proposed viewport, stores it outside React, then sends it to the active adapter. React renders only on route, fixture, loading-status, or throttled inspector changes, never on every gesture frame.

The D3 controller tags its own gesture updates. The shell must not feed the resulting store notification back through `zoom.transform` during that active gesture, because resetting D3's transform between touch moves breaks its finger anchors. External changes such as reset, route mount, and resize synchronize D3 once under a callback guard.

For ECharts and uPlot, the shared shell creates a transparent sibling gesture layer positioned from `adapter.getPlotRect()`. This avoids exposing renderer-specific DOM through `ChartAdapter`. The layer has `touch-action: none`; the surrounding page keeps normal vertical scrolling. The Chart.js route creates no layer because touch events must reach its canvas and native plugin.

## Viewport rules

The fixture extent is a fixed 90-day interval. The initial viewport is its final 24 hours. The minimum span is one hour and the maximum span is 90 days. Pans clamp at the extent without changing span. Zooms clamp the span while retaining the gesture anchor whenever the extent permits it.

The shared D3 controller uses `d3-zoom` 3.0.0 with the full extent as its base linear scale. Its transform is the view state, with scale extent `1` through `2160` (`90 days / 1 hour`). It has no transition or inertia. D3's touch identifier tracking supplies finger-distance scaling, midpoint translation, cancellation, and the `1 -> 2 -> 1` transition. Programmatic synchronization suppresses its zoom callback so `setViewport` cannot loop.

Chart.js uses `chartjs-plugin-zoom` callbacks as its only gesture owner. It must meet the same shared viewport rules and callback direction.

## Fixtures and loading

Every ordinary fixture has three SWT series and explicit `null` points. Lines do not span nulls. All candidates receive the same immutable arrays. The fixed extent remains available when a renderer receives no series or one sample, so those states still show a valid time axis. Empty data inspects as unavailable; a nearby single sample displays its value.

- `nominal` contains about 10,000 deterministic points across three series. Its initial 24-hour window includes offset timestamps, real zero values, both boundaries of a six-hour outage, and one 96 kPa spike.
- `sparse` contains irregular samples with long gaps and isolated points.
- `stress` contains at least 100,000 points across three 90-day series, with deterministic gaps, zeros, and spikes.

The shell can request a fixture with an artificial delay. A later request supersedes an earlier one even when the earlier promise resolves last. Applying any successful fixture calls `adapter.setData` and then reapplies the current viewport; it never resets to 24 hours. This is a renderer-update test, not a cache or request-management subsystem. There is no real API.

## Reading inspector

A tap in the plot pins a vertical reading time and opens the same inspector for every candidate. It shows the target timestamp and one row per series with label, numeric value, unit, and the selected sample's timestamp. Selection considers the nearest point including nulls; a nearest null is unavailable and the search never skips across it to a valid sample. A series is also unavailable when that point is farther than `min(6 hours, max(5 minutes, visible span / 80))`. A real zero renders as `0 kPa`. The inspector has an explicit close button. A drag, pinch, cancellation, or long press release must not synthesize the tap that opens or closes it.

## Inspection and performance evidence

The page exposes `window.__historyZoomProbe` only for tests. It reports the current route, requested viewport, rendered viewport from `adapter.getViewport()`, the real adapter plot rectangle, counts of adapter `setViewport` calls and viewport notifications, React render count, and `requestAnimationFrame` interval samples. Browser assertions obtain both viewports after actual touch events and adapter updates. Tests must not pass by changing a fabricated viewport object that bypasses the renderer.

Frame intervals are diagnostic evidence from desktop Chromium emulating the Pixel viewport. They do not establish 60 fps on a Pixel. The final record must state that real-device feel and performance remain pending until the user opens the local-network preview on the Pixel 8 Pro.

## Required automated evidence

Unit tests cover viewport clamping and anchored zoom math, deterministic fixture contents, stale delayed-response suppression, adapter data conversion, viewport updates through each renderer's public API, stable viewport during `setData`, resize geometry, and idempotent cleanup.

Playwright uses a Chromium CDP session and `Input.dispatchTouchEvent`, not mouse-wheel stand-ins. At the Pixel 8 Pro viewport it covers:

- a 60-move pinch and a four-move pinch with the same endpoints, whose final ranges agree within 1% and whose stationary and moving rendered anchors stay within two CSS pixels except where an extent boundary clamps movement;
- a pinch whose centroid translates horizontally, proving the time under the moving midpoint remains anchored within two CSS pixels away from an extent clamp;
- reverse zoom, initial one-finger pan, and a `1 -> 2 -> 1` gesture;
- `touchCancel`, with the following fresh gesture still working;
- vertical page scrolling outside the plot while the viewport stays unchanged;
- portrait-to-landscape resize, plot-rectangle refresh, and a subsequent anchored pinch;
- delayed requests resolving out of order without stale data or viewport reset;
- route switching with the viewport preserved, one active chart host, destroyed old listeners, no orphan candidate DOM, and no viewport notifications after cleanup;
- actual rendered evidence for the nominal fixture's zero, 96 kPa spike, and visible null gap;
- the stress fixture with frame intervals captured for comparison.

The tests run separately against all three hash routes. Tolerances are identical across candidates.

## Completion boundary

Completion produces a runnable local prototype, automated evidence, and instructions for phone access using the repository's existing local-network setup. The README gives `npm run dev -- --host 0.0.0.0` and `npm run preview -- --host 0.0.0.0`, plus the three hash links. Vite bundles all runtime assets locally; the built page makes no CDN request. It does not deploy the prototype or alter production dependencies.

Each candidate receives a suitability result per criterion. A known native limitation is recorded as `FAIL` with the observed requested and rendered domains; it is never skipped, hidden by a wider candidate-specific tolerance, or changed into a passing test. Hard shared correctness failures block completion. Frame timing remains diagnostic.

The user performs the final Pixel 8 Pro feel check and compares anchoring, continuity, visual gaps, and perceived latency. The independent reviewer confirms tests use each real plot API, records desktop frame diagnostics without a 60 fps claim, and lists real-device verification as pending.
