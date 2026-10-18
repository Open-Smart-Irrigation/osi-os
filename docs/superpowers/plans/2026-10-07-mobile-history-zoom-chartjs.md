# Chart.js mobile history zoom candidate implementation plan

Execution update: the [approved execution amendment](2026-10-07-mobile-history-zoom-execution-amendment.md) governs the shared D3 controller for all three renderers, passing gesture gates, and the test-server deployment.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Chart.js 4.5.1 candidate and measure whether chartjs-plugin-zoom 2.2.0 gives fluid, anchored mobile history navigation at a Pixel 8 Pro viewport.

**Architecture:** `mountChartjs` owns one Chart.js instance and exposes its live x scale through the shared `ChartAdapter`. Chart.js receives touch on its canvas and chartjs-plugin-zoom is the only gesture owner. Plugin pan and zoom callbacks publish renderer state during movement; `setData`, `setViewport`, and `resize` run behind a source guard and never echo callbacks.

**Tech Stack:** TypeScript 5.9.3, Chart.js 4.5.1, chartjs-plugin-zoom 2.2.0, Hammer.js 2.0.8, Vitest 4.1.6, shared Playwright 1.63 browser harness

**Spec:** `docs/superpowers/specs/2026-10-07-mobile-history-zoom-prototype-brief.md`

## Global constraints

- Create or modify only `web/history-zoom-prototypes/src/adapters/chartjs.ts` and `web/history-zoom-prototypes/tests/chartjs-adapter.test.ts`. The shared plan owns package files, the shell, CDP driver, browser scenarios, diagnostics, and README.
- Export `mountChartjs(host: HTMLElement, initial: Viewport, onViewportChange: (viewport: Viewport) => void): ChartAdapter` as both a named and default export so the shared lazy route loader receives `default: MountAdapter`.
- `getViewport()` reads `chart.scales.x.min` and `chart.scales.x.max`. It must not return cached application state.
- `setViewport`, `setData`, and `resize` never call `onViewportChange`. Native `onPan` and `onZoom` callbacks publish the renderer's current range during movement. Completion callbacks perform a final deduplicated publish.
- Use a Chart.js `linear` x scale with epoch-millisecond x values. Do not use category labels, equidistant `timeseries`, a date adapter, custom pointer handling, or D3.
- Limit x to the shared 90-day `FIXTURE_EXTENT`, with `minRange: MIN_SPAN_MS` (one hour). The extent supplies the 90-day maximum. Start at `INITIAL_VIEWPORT` (the final 24 hours).
- Fix y at 0 through 100 kPa. Preserve real zero, `{x, y: null}` timestamps, irregular spacing, outages, and spikes. Set `spanGaps: false`; do not coerce, interpolate, or discard missing values.
- Apply `PLOT_INSETS = {top: 16, right: 12, bottom: 36, left: 52}` in CSS pixels. A one-point series gets a visible point; ordinary series remain line-only.
- Mount with no series. Later `setData` calls, including empty and one-point fixtures, preserve the current rendered viewport.
- Treat plugin behavior as evidence. A native failure in pinch orientation, moving-centroid translation, input-density invariance, or `1 -> 2 -> 1` continuity remains an explicit shared suitability result. Do not replace or patch the packaged recognizers.
- Keep implementation correctness separate from suitability. Conversion, fixed domains, callback direction, renderer readback, viewport retention, geometry, and cleanup must pass.
- Frame timings come from requestAnimationFrame intervals. They do not establish 60 fps on a physical Pixel 8 Pro.

## Review focus

- An explicit null keeps its timestamp and breaks the line; a later zero renders at y=0.
- `setData` after a gesture retains the live x-scale range even when the new dataset has different bounds.
- `getPlotRect` converts Chart.js chart-area coordinates to viewport CSS coordinates after device-pixel-ratio scaling and resize.
- Plugin callbacks report actual scale bounds throughout a gesture; programmatic methods emit nothing.
- `destroy` is idempotent and calls `chart.destroy()`, allowing the zoom plugin to remove Hammer listeners.

## Verified library constraints

The pinned plugin's `src/hammer.js` derives active pinch axes from finger orientation before applying `zoom.mode`. A mostly vertical two-finger gesture can calculate only a y pinch and leave x unchanged even when mode is `x`. Configure x mode correctly, then preserve the observed result.

That source installs separate `Hammer.Pinch` and `Hammer.Pan` recognizers without `recognizeWith`. Pan defaults to one pointer. Two-finger translation and the transition from one finger to two and back can stop, restart, or jump. Adding recognizer coordination would create a custom candidate.

The plugin applies incremental zoom updates. Its linear-scale formula can make a 60-move pinch finish at a different range than a four-move pinch with the same endpoints. Both runs keep the common 1% range and two-CSS-pixel anchor tolerances; a miss is a suitability failure.

### Task 1: Define the data and renderer configuration

**Files:**
- Create: `web/history-zoom-prototypes/src/adapters/chartjs.ts`
- Create: `web/history-zoom-prototypes/tests/chartjs-adapter.test.ts`

**Interfaces:**
- Consumes: `ChartAdapter`, `SensorSeries`, `Viewport`, `FIXTURE_EXTENT`, `MIN_SPAN_MS`, `PLOT_INSETS`, and `SERIES_COLORS` from `src/shared/types.ts`; `sameViewport` from `src/shared/viewport.ts`.
- Produces: named and default `mountChartjs` exports.
- Produces for focused tests: `toChartjsDatasets(series): ChartDataset<'line'>[]` and `chartjsOptions(initial, publish): ChartOptions<'line'>`.

- [ ] **Step 1: Write failing conversion and option tests**

Create `tests/chartjs-adapter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_EXTENT,
  INITIAL_VIEWPORT,
  MIN_SPAN_MS,
  PLOT_INSETS,
  type SensorSeries,
} from '../src/shared/types';
import { chartjsOptions, toChartjsDatasets } from '../src/adapters/chartjs';

const series: readonly SensorSeries[] = [{
  id: 'swt-1', label: '20 cm', unit: 'kPa',
  points: [
    { t: 1_700_000_000_000, value: 12 },
    { t: 1_700_003_600_000, value: null },
    { t: 1_700_010_800_000, value: 0 },
  ],
}];

describe('Chart.js data and options', () => {
  it('keeps epoch spacing, explicit null timestamps, and real zeroes', () => {
    const [dataset] = toChartjsDatasets(series);
    expect(dataset.data).toEqual([
      { x: 1_700_000_000_000, y: 12 },
      { x: 1_700_003_600_000, y: null },
      { x: 1_700_010_800_000, y: 0 },
    ]);
    expect(dataset.parsing).toBe(false);
    expect(dataset.spanGaps).toBe(false);
  });

  it('shows sparse markers but keeps dense series line-only', () => {
    const single = toChartjsDatasets([{ ...series[0], points: [series[0].points[0]] }])[0];
    const many = toChartjsDatasets([{ ...series[0], points: Array.from({ length: 501 }, (_, i) => ({ t: i * 1000, value: 20 })) }])[0];
    expect((single.pointRadius as (context: { dataset: { data: unknown[] } }) => number)(
      { dataset: { data: single.data } },
    )).toBe(2);
    expect((many.pointRadius as (context: { dataset: { data: unknown[] } }) => number)(
      { dataset: { data: many.data } },
    )).toBe(0);
  });

  it('uses proportional epoch time, hard extent limits, and fixed y', () => {
    const options = chartjsOptions(INITIAL_VIEWPORT, vi.fn());
    expect(options.scales?.x).toMatchObject({
      type: 'linear', min: INITIAL_VIEWPORT.from, max: INITIAL_VIEWPORT.to,
    });
    expect(options.scales?.y).toMatchObject({ type: 'linear', min: 0, max: 100 });
    expect(options.plugins?.zoom?.limits?.x).toEqual({
      min: FIXTURE_EXTENT.from, max: FIXTURE_EXTENT.to, minRange: MIN_SPAN_MS,
    });
  });

  it('enables native x pan and pinch and reports movement plus completion', () => {
    const publish = vi.fn();
    const options = chartjsOptions(INITIAL_VIEWPORT, publish);
    expect(options.plugins?.zoom?.pan).toMatchObject({ enabled: true, mode: 'x', threshold: 0 });
    expect(options.plugins?.zoom?.zoom).toMatchObject({
      mode: 'x', wheel: { enabled: false }, drag: { enabled: false }, pinch: { enabled: true },
    });
    expect(options.plugins?.zoom?.pan?.onPan).toEqual(expect.any(Function));
    expect(options.plugins?.zoom?.pan?.onPanComplete).toEqual(expect.any(Function));
    expect(options.plugins?.zoom?.zoom?.onZoom).toEqual(expect.any(Function));
    expect(options.plugins?.zoom?.zoom?.onZoomComplete).toEqual(expect.any(Function));
  });

  it('rejects a gesture that begins outside the current plot area', () => {
    const options = chartjsOptions(INITIAL_VIEWPORT, vi.fn());
    const chart = { chartArea: { left: 52, right: 388, top: 16, bottom: 324 } };
    expect(options.plugins?.zoom?.pan?.onPanStart?.({ chart, point: { x: 100, y: 100 } } as never))
      .not.toBe(false);
    expect(options.plugins?.zoom?.pan?.onPanStart?.({ chart, point: { x: 20, y: 100 } } as never))
      .toBe(false);
    expect(options.plugins?.zoom?.zoom?.onZoomStart?.({ chart, point: { x: 100, y: 340 } } as never))
      .toBe(false);
  });

  it('pins chart-area insets and disables interpolation and animation', () => {
    const options = chartjsOptions(INITIAL_VIEWPORT, vi.fn());
    expect(options.animation).toBe(false);
    expect(options.plugins?.legend?.display).toBe(false);
    expect(options.plugins?.tooltip?.enabled).toBe(false);
    expect(options.layout).toEqual({ padding: { top: PLOT_INSETS.top, right: PLOT_INSETS.right } });
    const x = options.scales?.x;
    const y = options.scales?.y;
    if (!x || !y || typeof x === 'string' || typeof y === 'string') throw new Error('scales missing');
    const xAxis = { height: 0 };
    const yAxis = { width: 0 };
    x.afterFit?.(xAxis as never);
    y.afterFit?.(yAxis as never);
    expect(xAxis.height).toBe(PLOT_INSETS.bottom);
    expect(yAxis.width).toBe(PLOT_INSETS.left);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it is red**

Run: `cd web/history-zoom-prototypes && npm test -- tests/chartjs-adapter.test.ts`

Expected: FAIL because `src/adapters/chartjs.ts` is absent.

- [ ] **Step 3: Implement conversion and options**

Create `src/adapters/chartjs.ts`:

```ts
import {
  Chart, LinearScale, LineController, LineElement, PointElement,
  type ChartDataset, type ChartOptions,
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import {
  FIXTURE_EXTENT, MIN_SPAN_MS, PLOT_INSETS, SERIES_COLORS,
  type ChartAdapter, type SensorSeries, type Viewport,
} from '../shared/types';
import { sameViewport } from '../shared/viewport';

Chart.register(LineController, LineElement, PointElement, LinearScale, zoomPlugin);

type NullablePoint = { x: number; y: number | null };

function formatEpochTick(value: string | number): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(Number(value)));
}

export function toChartjsDatasets(series: readonly SensorSeries[]): ChartDataset<'line'>[] {
  return series.map((sensor, index) => ({
    label: `${sensor.label} (${sensor.unit})`,
    data: sensor.points.map((point): NullablePoint => ({ x: point.t, y: point.value }))
      as unknown as ChartDataset<'line'>['data'],
    parsing: false,
    normalized: false,
    spanGaps: false,
    pointRadius: (context) => context.dataset.data.length <= 500 ? 2 : 0,
    pointHitRadius: 8,
    borderWidth: 2,
    borderColor: SERIES_COLORS[index % SERIES_COLORS.length],
    backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length],
  }));
}

function rendererViewport(chart: Pick<Chart, 'scales'>): Viewport {
  const x = chart.scales.x;
  if (!x || !Number.isFinite(x.min) || !Number.isFinite(x.max)) {
    throw new Error('Chart.js x scale has no finite rendered viewport');
  }
  return { from: x.min, to: x.max };
}

export function chartjsOptions(
  initial: Viewport,
  publish: (viewport: Viewport) => void,
): ChartOptions<'line'> {
  const report = ({ chart }: { chart: Chart }) => publish(rendererViewport(chart));
  const startsInPlot = ({ chart, point }: { chart: Chart; point: { x: number; y: number } }) => {
    const { left, right, top, bottom } = chart.chartArea;
    return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
  };
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    layout: { padding: { top: PLOT_INSETS.top, right: PLOT_INSETS.right } },
    interaction: { intersect: false, mode: 'nearest' },
    scales: {
      x: {
        type: 'linear', min: initial.from, max: initial.to, bounds: 'ticks',
        afterFit(axis) { axis.height = PLOT_INSETS.bottom; },
        ticks: { callback: formatEpochTick, maxRotation: 0 },
      },
      y: {
        type: 'linear', min: 0, max: 100,
        afterFit(axis) { axis.width = PLOT_INSETS.left; },
        title: { display: false },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },
      zoom: {
        limits: { x: { min: FIXTURE_EXTENT.from, max: FIXTURE_EXTENT.to, minRange: MIN_SPAN_MS } },
        pan: {
          enabled: true, mode: 'x', threshold: 0,
          onPanStart: startsInPlot, onPan: report, onPanComplete: report,
        },
        zoom: {
          mode: 'x', wheel: { enabled: false }, drag: { enabled: false }, pinch: { enabled: true },
          onZoomStart: startsInPlot, onZoom: report, onZoomComplete: report,
        },
      },
    },
  };
}
```

The localized cast is deliberate: Chart.js renders object-form `y: null` as a gap, but its `ScatterDataPoint` declaration accepts only `number`. Do not widen TypeScript settings or replace null with `NaN`.

- [ ] **Step 4: Run the focused gate and baseline build**

Run: `cd web/history-zoom-prototypes && npm test -- tests/chartjs-adapter.test.ts && npm run build`

Expected: six tests pass, TypeScript reports no diagnostics, and Vite builds the baseline package.

- [ ] **Step 5: Commit the renderer boundary**

```bash
git add web/history-zoom-prototypes/src/adapters/chartjs.ts web/history-zoom-prototypes/tests/chartjs-adapter.test.ts
git commit -m "test: define Chart.js history rendering"
```

### Task 2: Implement lifecycle, live readback, and source suppression

**Files:**
- Modify: `web/history-zoom-prototypes/src/adapters/chartjs.ts`
- Modify: `web/history-zoom-prototypes/tests/chartjs-adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 builders and the six-method `ChartAdapter`.
- Produces: an empty-data-safe adapter whose public state comes from Chart.js scales and whose internal updates cannot emit plugin callbacks.

- [ ] **Step 1: Add a controlled Chart.js test double**

Mock `chart.js` before importing the adapter. The fake must expose scale and chart-area state and deliberately call plugin callbacks during `update()` and `resize()`. This behavior is stronger than Chart.js runtime behavior and proves the source guard:

```ts
const chartState = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock('chart.js', () => {
  class FakeChart {
    static register() {}
    canvas: HTMLCanvasElement;
    data: { datasets: unknown[] };
    options: any;
    scales: { x: { min: number; max: number; type: string } };
    chartArea = { left: 52, right: 388, top: 16, bottom: 324 };
    width = 400;
    height = 360;
    destroyCalls = 0;
    resizeCalls = 0;

    constructor(canvas: HTMLCanvasElement, config: any) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      this.scales = { x: { min: config.options.scales.x.min, max: config.options.scales.x.max, type: 'linear' } };
      chartState.instances.push(this);
    }
    update() {
      this.scales.x.min = Number(this.options.scales.x.min);
      this.scales.x.max = Number(this.options.scales.x.max);
      this.options.plugins.zoom.pan.onPan({ chart: this });
      this.options.plugins.zoom.zoom.onZoom({ chart: this });
    }
    resize() { this.resizeCalls += 1; this.update(); }
    destroy() { this.destroyCalls += 1; }
  }
  return {
    Chart: FakeChart,
    LinearScale: {}, LineController: {}, LineElement: {}, PointElement: {},
  };
});
vi.mock('chartjs-plugin-zoom', () => ({ default: {} }));
```

Move `chartjs.ts` imports below the mocks and clear `chartState.instances` in `beforeEach`.

- [ ] **Step 2: Write failing lifecycle tests**

Append these cases:

```ts
describe('Chart.js adapter lifecycle', () => {
  it('mounts empty, reads renderer state, and does not echo setViewport', () => {
    const host = document.createElement('div');
    const notify = vi.fn();
    const adapter = mountChartjs(host, INITIAL_VIEWPORT, notify);
    expect(host.querySelectorAll('canvas[data-chart="chartjs"]')).toHaveLength(1);
    expect(adapter.getViewport()).toEqual(INITIAL_VIEWPORT);
    const shifted = {
      from: INITIAL_VIEWPORT.from - 6 * 60 * 60 * 1000,
      to: INITIAL_VIEWPORT.to - 6 * 60 * 60 * 1000,
    };
    adapter.setViewport(shifted);
    expect(adapter.getViewport()).toEqual(shifted);
    expect(notify).not.toHaveBeenCalled();
  });

  it('publishes live native scale movement and deduplicates completion', () => {
    const notify = vi.fn();
    const adapter = mountChartjs(document.createElement('div'), INITIAL_VIEWPORT, notify);
    const chart = chartState.instances.at(-1)!;
    chart.scales.x.min -= 3_600_000;
    chart.scales.x.max -= 3_600_000;
    chart.options.plugins.zoom.pan.onPan({ chart });
    chart.options.plugins.zoom.pan.onPanComplete({ chart });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith({ from: chart.scales.x.min, to: chart.scales.x.max });
    expect(adapter.getViewport()).toEqual(notify.mock.calls[0][0]);
  });

  it('retains the live viewport through data replacement and resize without notifications', () => {
    const notify = vi.fn();
    const adapter = mountChartjs(document.createElement('div'), INITIAL_VIEWPORT, notify);
    const chart = chartState.instances.at(-1)!;
    chart.scales.x.min -= 7_200_000;
    chart.scales.x.max -= 7_200_000;
    const before = adapter.getViewport();
    adapter.setData(series);
    adapter.resize();
    expect(adapter.getViewport()).toEqual(before);
    expect(chart.data.datasets).toEqual(toChartjsDatasets(series));
    expect(chart.resizeCalls).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('returns the real viewport plot rectangle after backing-store scaling', () => {
    const adapter = mountChartjs(document.createElement('div'), INITIAL_VIEWPORT, vi.fn());
    const chart = chartState.instances.at(-1)!;
    vi.spyOn(chart.canvas, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 740,
      width: 800, height: 720, toJSON: () => ({}),
    });
    expect(adapter.getPlotRect().toJSON()).toMatchObject({ x: 114, y: 52, width: 672, height: 616 });
  });

  it('destroys Chart.js and removes the canvas exactly once', () => {
    const host = document.createElement('div');
    const adapter = mountChartjs(host, INITIAL_VIEWPORT, vi.fn());
    const chart = chartState.instances.at(-1)!;
    adapter.destroy();
    adapter.destroy();
    expect(chart.destroyCalls).toBe(1);
    expect(host.querySelector('canvas')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests and verify the missing lifecycle fails**

Run: `cd web/history-zoom-prototypes && npm test -- tests/chartjs-adapter.test.ts`

Expected: FAIL because `mountChartjs` is absent or an internal update reaches `notify`.

- [ ] **Step 4: Implement the adapter with one internal-update guard**

Complete `src/adapters/chartjs.ts`:

```ts
export function mountChartjs(
  host: HTMLElement,
  initial: Viewport,
  onViewportChange: (viewport: Viewport) => void,
): ChartAdapter {
  const canvas = document.createElement('canvas');
  canvas.dataset.chart = 'chartjs';
  host.replaceChildren(canvas);
  let destroyed = false;
  let internalUpdateDepth = 0;
  let lastPublished = initial;

  const publish = (viewport: Viewport) => {
    if (destroyed || internalUpdateDepth > 0 || sameViewport(lastPublished, viewport)) return;
    lastPublished = viewport;
    onViewportChange(viewport);
  };
  const chart = new Chart(canvas, {
    type: 'line', data: { datasets: [] }, options: chartjsOptions(initial, publish),
  });
  const assertLive = () => {
    if (destroyed) throw new Error('Chart.js adapter is destroyed');
  };
  const updateInternally = (mutation: () => void) => {
    internalUpdateDepth += 1;
    try {
      mutation();
      lastPublished = rendererViewport(chart);
    } finally {
      internalUpdateDepth -= 1;
    }
  };

  return {
    setData(nextSeries) {
      assertLive();
      const before = rendererViewport(chart);
      updateInternally(() => {
        chart.data.datasets = toChartjsDatasets(nextSeries);
        chart.options.scales!.x!.min = before.from;
        chart.options.scales!.x!.max = before.to;
        chart.update('none');
      });
    },
    setViewport(viewport) {
      assertLive();
      if (sameViewport(rendererViewport(chart), viewport)) return;
      updateInternally(() => {
        chart.options.scales!.x!.min = viewport.from;
        chart.options.scales!.x!.max = viewport.to;
        chart.update('none');
      });
    },
    getViewport() {
      assertLive();
      return rendererViewport(chart);
    },
    getPlotRect() {
      assertLive();
      const bounds = canvas.getBoundingClientRect();
      const area = chart.chartArea;
      const xRatio = bounds.width / chart.width;
      const yRatio = bounds.height / chart.height;
      return new DOMRectReadOnly(
        bounds.left + area.left * xRatio,
        bounds.top + area.top * yRatio,
        (area.right - area.left) * xRatio,
        (area.bottom - area.top) * yRatio,
      );
    },
    resize() {
      assertLive();
      const before = rendererViewport(chart);
      updateInternally(() => {
        chart.resize();
        chart.options.scales!.x!.min = before.from;
        chart.options.scales!.x!.max = before.to;
        chart.update('none');
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      chart.destroy();
      canvas.remove();
    },
  };
}

export default mountChartjs;
```

Do not call `chart.resetZoom()`. It restores plugin-captured original limits instead of the shell's current range. Keep readback synchronous: explicit Chart.js `update('none')` and `resize()` complete their layout in the call. The shared browser harness waits for the browser orientation change before asking the adapter to resize.

- [ ] **Step 5: Run owned tests and build**

Run: `cd web/history-zoom-prototypes && npm test -- tests/chartjs-adapter.test.ts && npm run build`

Expected: eleven adapter tests pass, TypeScript reports no diagnostics, and Vite builds the package.

- [ ] **Step 6: Commit lifecycle behavior**

```bash
git add web/history-zoom-prototypes/src/adapters/chartjs.ts web/history-zoom-prototypes/tests/chartjs-adapter.test.ts
git commit -m "feat: add Chart.js history adapter lifecycle"
```

### Task 3: Run the shared native-touch comparison

**Files:**
- Verify only: `web/history-zoom-prototypes/tests/browser/history-zoom.spec.ts`
- Inspect generated, gitignored: `web/history-zoom-prototypes/test-results/diagnostics/chartjs-nominal.json`
- Inspect generated, gitignored: `web/history-zoom-prototypes/test-results/diagnostics/chartjs-stress.json`

**Interfaces:**
- Consumes: the shared page probe's requested viewport, renderer-backed viewport, plot rectangle, counters, and `FrameSummary` samples.
- Consumes: `dispatchTouchSequence`, `pinchPoints`, `panPoints`, and `liftSecondFingerAndContinue` from `tests/browser/cdp-touch.ts`.
- Produces no source edits. Report a shared-harness mismatch to the root instead of editing shared-owned files.

- [ ] **Step 1: Run Chart.js through the shared browser scenarios**

Run: `cd web/history-zoom-prototypes && npm run test:browser -- --project=pixel-8-pro --grep "chartjs"`

The suite sends CDP touch directly to `canvas[data-chart="chartjs"]`; `.gesture-layer` is absent. Each assertion compares shared requested state with `adapter.getViewport()` after real native input.

- [ ] **Step 2: Require hard correctness evidence**

These checks must pass:

| Check | Required evidence |
| --- | --- |
| Initial state | Requested and rendered ranges equal the final 24-hour viewport within 1 ms. |
| Domain consistency | After native callbacks and normalization, requested and rendered edges agree within 1 ms and stay within the extent; actual pan movement is scored separately. |
| Range limits | Reverse zoom cannot cross the one-hour floor or 90-day extent. |
| Async data | An out-of-order stale request cannot replace the later fixture or reset a panned viewport. |
| Missing values | Shared pixel tests show zero, the 96 kPa spike, and a visible line break for the nominal null outage. |
| Resize | Portrait-to-landscape changes the real plot rectangle; the following pinch uses the new rectangle. |
| Callback source | Data, external viewport, resize, and remount emit nothing; native movement updates the callback. |
| Cleanup | Route change removes the old canvas and listeners; the detached canvas cannot notify Chart.js; new-chart input still works at the reused coordinates. |
| Cancel recovery | `touchCancel` followed by a fresh gesture still changes renderer state. |
| Page boundary | Touch outside the plot scrolls the page without changing the time viewport. |
| Long press | A 650 ms press/release inside the plot activates no route or control. |

An adapter-owned failure gets a red focused test before a fix. A shared harness defect is reported to the root with observed values; do not edit the shared file.

- [ ] **Step 3: Preserve every native suitability result**

The common scenario runner executes these named criteria with identical thresholds:

| Criterion ID | Threshold | Native risk |
| --- | --- | --- |
| `pinch-step-invariance` | Four-move and 60-move final spans differ by at most 1%; stationary anchor drift is at most two CSS pixels unless clamped. | Incremental zoom can depend on move count. |
| `moving-anchor` | Time under the translating pinch midpoint remains within two CSS pixels unless clamped. | Hammer pinch may not preserve translation while scaling. |
| `reverse-pinch` | Reverse pinch grows the rendered span by at least 10%. | Axis classification can suppress x zoom. |
| `initial-pan` | One finger shifts the midpoint by at least 5% of the visible span in the requested direction. | Pan must reach the canvas without a D3 layer. |
| `partial-lift-id-1` | The transition jump is at most two CSS pixels and finger 2 continues by at least 5% of span in the intended direction. | Separate Pan and Pinch recognizers may restart. |
| `partial-lift-id-2` | The transition jump is at most two CSS pixels and finger 1 continues by at least 5% of span in the intended direction. | The opposite release order can behave differently. |
| `cancel-recovery` | A fresh pan after `touchCancel` moves at least 5% of span. | Hammer state can remain cancelled. |
| `pinch-axis-orientation` | A mostly vertical finger alignment changes horizontal span within 1% of the horizontal equivalent's gap-ratio result. | `pinchAxes` can classify y-only before x mode is applied. |
| `device-orientation-resize` | Landscape geometry differs from portrait and the post-resize pinch anchor stays within two CSS pixels. | Stale plot bounds target the wrong epoch. |
| `cleanup` | Touch after route disposal causes zero later Chart.js notifications. | Leaked Hammer listeners keep the old canvas active. |
| Stress frame diagnostics | Record every real `FrameSummary` field; no fps threshold applies. | Desktop emulation cannot prove phone frame rate. |

Every row records observed values and `PASS`, `FAIL`, or `UNMEASURED`. A known native weakness is never skipped or hidden behind a relaxed threshold. Suitability `FAIL` is valid evidence when hard correctness passes.

- [ ] **Step 4: Inspect objective metadata**

Require route, fixture, point count, requested and rendered viewports, plot rectangle, callback counts, browser version, viewport, device-pixel ratio, and `FrameSummary` fields (`sampleCount`, `meanMs`, `p95Ms`, `maxMs`, `over16_7`, `over33_3`). Require this label:

```text
desktop Chromium Pixel 8 Pro emulation; real Pixel pending
```

Fewer than two frame timestamps yields `UNMEASURED`, never a calculated fps value.

- [ ] **Step 5: Run complete gates after every adapter exists**

Run:

```bash
cd web/history-zoom-prototypes
npm test
npm run build
npm run test:browser
```

Expected: unit tests and hard correctness checks pass. The browser command completes after recording each suitability result, including explicit native `FAIL` results. Stop and report if the shared runner treats a suitability failure as an implementation failure.

## Candidate risks

- Hammer.js 2.0.8 exposes orientation and recognizer-transition limits in this plugin. The comparison measures the package as shipped.
- Chart.js accepts nullable object points at runtime but its point declaration does not. Keep the cast at the conversion boundary and pin the behavior in the focused test.
- Canvas backing-store and CSS dimensions can differ. Scale chart-area coordinates through `getBoundingClientRect()` or CDP anchors target the wrong epoch.
- Plugin `minRange` enforces the one-hour floor. Fixed min/max extent enforces the 90-day ceiling and pan bounds; plugin 2.2.0 has no `maxRange` option.
- Plugin callbacks report view movement; requestAnimationFrame samples supply timing evidence.

## Final self-review

- Confirm both owned paths match the brief and no shared file appears in a `Create` or `Modify` list.
- Confirm all constants and contract types come from `src/shared/types.ts`.
- Confirm programmatic `setData`, `setViewport`, and `resize` use the same source guard.
- Confirm native evidence reads Chart.js scale bounds and uses common tolerances without D3 or custom Hammer behavior.
- Run `node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-07-mobile-history-zoom-chartjs.md` and resolve every tier-1 finding.
