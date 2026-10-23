# ECharts mobile history adapter implementation plan

Execution update: the [approved execution amendment](2026-10-07-mobile-history-zoom-execution-amendment.md) governs the shared D3 controller for all three renderers, passing gesture gates, and the test-server deployment.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ECharts 5.6 candidate to the shared mobile sensor-history harness without letting ECharts own touch gestures.

**Architecture:** The adapter renders an ordinary fixed-y ECharts line chart and changes the x-axis bounds through public `setOption`. The shared D3 layer owns pan and pinch, while `convertFromPixel` reads the actual rendered x-domain for browser evidence.

**Tech Stack:** ECharts 5.6.0 modular core, Canvas renderer, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-10-07-mobile-history-zoom-prototype-brief.md`

## Global constraints

- Create or modify only `web/history-zoom-prototypes/src/adapters/echarts.ts` and `web/history-zoom-prototypes/tests/echarts-adapter.test.ts`. Package, shell, and shared test changes belong to the shared plan.
- Export `mountEcharts(host, initial, onViewportChange): ChartAdapter` with the exact shared contract, including live `getViewport()` readback.
- Do not import `DataZoomComponent`, configure `dataZoom.inside`, or attach touch, pointer, wheel, or gesture listeners. The shared D3 overlay is the sole gesture owner for this route.
- Keep x as epoch-millisecond numeric time, y at 0 through 100 kPa, `connectNulls:false`, no smoothing, no animation, and exact shared plot insets.
- `setData` must preserve the rendered viewport within 1 ms for nominal, sparse, stress, empty, and single-point data.
- Use ECharts public APIs. Do not read model internals or ZRender private fields.
- Luna implements this plan after the root agent accepts the shared interfaces. A fresh Sol agent reviews the completed branch.

## Review focus

- `notMerge` data replacement must carry the current rendered x bounds into the replacement option.
- Empty and single-point input must retain numeric x bounds instead of allowing ECharts auto-range.
- Null values must remain null pairs so ECharts draws a real break; zero must not be filtered by truthiness, and a one-point series must render a 4 px marker.
- `getViewport` must derive values from rendered pixel conversion rather than a cached requested object.
- Repeated `destroy` and any later shell cleanup must not call a disposed chart.

### Task 1: ECharts option and live viewport adapter

**Files:**
- Create: `web/history-zoom-prototypes/src/adapters/echarts.ts`
- Create: `web/history-zoom-prototypes/tests/echarts-adapter.test.ts`

**Interfaces:**
- Consumes: `ChartAdapter`, `MountAdapter`, `Viewport`, `SensorSeries`, `PLOT_INSETS`, `CHART_HEIGHT`, `SERIES_COLORS` from `src/shared/types.ts`.
- Produces: named `mountEcharts: MountAdapter` and the same function as the module's default export for the shared `import.meta.glob` loader.

- [ ] **Step 1: Write the failing adapter contract tests**

Mock `echarts/core.init` with a chart double that records `setOption`, `resize`, `convertFromPixel`, and `dispose`. Make `convertFromPixel({xAxisIndex:0}, 52)` return the last applied x minimum and conversion at `host.clientWidth - 12` return its maximum. Cover these cases:

```ts
it('mounts with numeric time and fixed y geometry')
it('keeps null, zero, and spike values without smoothing')
it('reads the rendered viewport through convertFromPixel')
it('preserves the rendered viewport when data changes')
it('keeps the extent for empty and single-point data')
it('resizes and reports the inset plot rectangle')
it('disposes exactly once and never emits a gesture callback')
```

The option assertions must find `xAxis.type === 'value'`, `xAxis.min/max` equal to the supplied initial viewport, `yAxis.min === 0`, `yAxis.max === 100`, no y-axis name, and grid values equal to `PLOT_INSETS`. Assert series with more than 500 points have `type:'line'`, `showSymbol:false`, `connectNulls:false`, `smooth:false`, and data entries shaped as `[epochMs, number|null]`. Pass the sparse and single fixtures and assert `showSymbol:true` with `symbolSize:4` so its only sample is visible.

- [ ] **Step 2: Run the test and verify the expected red state**

Run: `cd web/history-zoom-prototypes && npm test -- tests/echarts-adapter.test.ts`

Expected: FAIL because `src/adapters/echarts.ts` does not exist.

- [ ] **Step 3: Register only the required ECharts modules**

Start the adapter with these imports and registration. Do not add any data-zoom module:

```ts
import { LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { ChartAdapter, MountAdapter, SensorSeries, Viewport } from '../shared/types';
import { PLOT_INSETS, SERIES_COLORS } from '../shared/types';

use([LineChart, GridComponent, CanvasRenderer]);
```

Do not register Tooltip for this adapter. The shared inspector owns tap readings, which prevents a second interaction path and keeps every candidate's display identical.

- [ ] **Step 4: Implement a complete option builder**

Use stable series ids so replacements cannot retain stale series:

```ts
function buildOption(series: readonly SensorSeries[], viewport: Viewport): EChartsCoreOption {
  const tickFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return {
    animation: false,
    grid: {
      top: PLOT_INSETS.top,
      right: PLOT_INSETS.right,
      bottom: PLOT_INSETS.bottom,
      left: PLOT_INSETS.left,
      containLabel: false,
    },
    xAxis: {
      type: 'value',
      min: viewport.from,
      max: viewport.to,
      axisLabel: { formatter: (value: number) => tickFormatter.format(new Date(value)) },
      splitNumber: 4,
    },
    yAxis: { type: 'value', min: 0, max: 100, splitNumber: 4 },
    series: series.map((item, index) => ({
      id: item.id,
      name: item.label,
      type: 'line',
      data: item.points.map((point) => [point.t, point.value]),
      showSymbol: item.points.length <= 500,
      symbolSize: 4,
      connectNulls: false,
      smooth: false,
      animation: false,
      lineStyle: { width: 2, color: SERIES_COLORS[index % SERIES_COLORS.length] },
      itemStyle: { color: SERIES_COLORS[index % SERIES_COLORS.length] },
      silent: true,
    })),
  };
}
```

Do not enable ECharts `sampling`: the prototype must retain the known zero and 96 kPa spike, and all candidates should receive the same point semantics. The stress timing captures the cost.

- [ ] **Step 5: Implement mount, replacement, readback, geometry, and cleanup**

Implement the full lifecycle with no adapter-owned listeners:

```ts
export const mountEcharts: MountAdapter = (host, initial, _onViewportChange): ChartAdapter => {
  const chart: EChartsType = init(host, undefined, { renderer: 'canvas' });
  let destroyed = false;

  chart.setOption(buildOption([], initial), { notMerge: true, lazyUpdate: false, silent: true });

  const getViewport = (): Viewport => {
    const left = chart.convertFromPixel({ xAxisIndex: 0 }, PLOT_INSETS.left);
    const right = chart.convertFromPixel({ xAxisIndex: 0 }, host.clientWidth - PLOT_INSETS.right);
    if (typeof left !== 'number' || typeof right !== 'number' || !Number.isFinite(left) || !Number.isFinite(right)) {
      throw new Error('ECharts x-axis pixel conversion did not return finite numbers');
    }
    return { from: left, to: right };
  };

  const setViewport = (viewport: Viewport) => {
    if (destroyed) return;
    chart.setOption({ xAxis: { min: viewport.from, max: viewport.to } }, { lazyUpdate: false, silent: true });
  };

  return {
    setData(series) {
      if (destroyed) return;
      const viewport = getViewport();
      chart.setOption(buildOption(series, viewport), { notMerge: true, lazyUpdate: false, silent: true });
    },
    setViewport,
    getViewport,
    getPlotRect() {
      const rect = host.getBoundingClientRect();
      return new DOMRectReadOnly(
        rect.left + PLOT_INSETS.left,
        rect.top + PLOT_INSETS.top,
        Math.max(0, rect.width - PLOT_INSETS.left - PLOT_INSETS.right),
        Math.max(0, rect.height - PLOT_INSETS.top - PLOT_INSETS.bottom),
      );
    },
    resize() {
      if (!destroyed) chart.resize();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      chart.dispose();
      host.replaceChildren();
    },
  };
};

export default mountEcharts;
```

If ECharts 5.6 returns an array for x-axis conversion in the real browser, stop: record the observed API result and revise the readback using the documented `convertFromPixel({xAxisIndex:0}, pixel)` scalar form. Do not fall back to the cached input viewport.

- [ ] **Step 6: Run the focused test and typecheck**

Run: `cd web/history-zoom-prototypes && npm test -- tests/echarts-adapter.test.ts && npx tsc --noEmit`

Expected: PASS. The test proves `onViewportChange` has zero calls because shared D3 owns all ECharts gestures.

- [ ] **Step 7: Commit the adapter**

```bash
git add web/history-zoom-prototypes/src/adapters/echarts.ts web/history-zoom-prototypes/tests/echarts-adapter.test.ts
git commit -m "feat: add ECharts history zoom candidate"
```

### Task 2: Real-renderer integration and suitability evidence

**Files:**
- Verify only: `web/history-zoom-prototypes/tests/browser/history-zoom.spec.ts`
- Verify only: `web/history-zoom-prototypes/test-results/diagnostics/echarts-*.json`
- Verify only: `web/history-zoom-prototypes/test-results/diagnostics/suitability.json`

**Interfaces:**
- Consumes: shared CDP touch helpers, requested viewport, ECharts-backed rendered viewport, fixture controls, and fixed suitability tolerances.
- Produces no shared code; failures return to the task that owns the broken behavior.

- [ ] **Step 1: Run only the ECharts browser project/cases**

Run: `cd web/history-zoom-prototypes && npm run test:browser -- --grep ECharts`

Expected: hard renderer-integrity cases PASS. These include the actual canvas-pixel test named `renders zero, spike, and a visible null gap from the nominal fixture`, delayed data replacement within 1 ms, empty/single data, route cleanup, scrolling outside the chart, orientation geometry, and requested-versus-rendered readback.

- [ ] **Step 2: Inspect fixed-tolerance gesture results**

Read `test-results/diagnostics/suitability.json`. The ECharts entries must exist for equivalent 60-step/four-step pinch, moving midpoint, horizontal-versus-mostly-vertical finger arrangement, reverse pinch, initial pan, both `1 -> 2 -> 1` lift orders, cancellation recovery, device-orientation resize, and cleanup. A result is `PASS` only when the shared plan's named criterion meets its fixed threshold. Otherwise the entry remains `FAIL` with observed values; do not change ECharts or shared tolerances merely to make the comparison green.

- [ ] **Step 3: Check that the adapter has no competing gesture owner**

Run:

```bash
rg -n "DataZoom|dataZoom|touch(start|move|end)|pointer(down|move|up)|wheel|gesture" web/history-zoom-prototypes/src/adapters/echarts.ts
```

Expected: no matches.

- [ ] **Step 4: Run the complete prototype gates**

Run:

```bash
cd web/history-zoom-prototypes
npm test
npm run build
npm run test:browser
```

Expected: all hard gates exit 0, diagnostics include ECharts nominal and stress records, and the build output contains local JavaScript assets with no CDN URL.

- [ ] **Step 5: Independent review**

The fresh Sol reviewer compares `getViewport` with live pixel conversion, checks set-data viewport stability, verifies D3 is the sole gesture owner, and reruns the commands above. The review reports suitability `PASS` and `FAIL` cells as experimental results, keeps desktop frame timing diagnostic, and lists Pixel 8 Pro verification as pending.
