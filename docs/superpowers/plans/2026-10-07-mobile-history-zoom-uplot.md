# uPlot mobile sensor-history zoom prototype implementation plan

Execution update: the [approved execution amendment](2026-10-07-mobile-history-zoom-execution-amendment.md) governs the shared D3 controller for all three renderers, passing gesture gates, and the test-server deployment.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the uPlot candidate to the standalone phone prototype so the shared D3 controller can drive a real uPlot 1.6.32 time scale while missing samples, explicit outages, zero readings, and viewport state remain truthful.

**Architecture:** A small data helper converts immutable epoch-millisecond series into uPlot's aligned seconds-based columns. It uses stable uPlot 1.6.32's `join` behavior: timestamps absent from a particular series become `undefined`, while explicit `null` values remain line-breaking gaps. The adapter owns only rendering and public-scale translation; the shared D3 controller owns pan and pinch gestures through the sibling `.gesture-layer`.

**Tech Stack:** React 18 shell, TypeScript, Vite, uPlot 1.6.32, D3 Zoom 3.0.0, Vitest, Playwright with Chromium CDP touch events

**Spec:** `docs/superpowers/specs/2026-10-07-mobile-history-zoom-prototype-brief.md`

## Global constraints

- Work only in `web/history-zoom-prototypes/`; do not change `web/react-gui`, Node-RED, a backend, `osi-server`, or production package dependencies.
- The shared router defaults unknown and empty hashes to `#/uplot`; export the adapter as both named `mountUplot` and the default `MountAdapter` for its typed `import.meta.glob` loader.
- Implement against released `uplot@1.6.32`. The checked `master` documentation contains unreleased APIs and is evidence only for the touch-demo comparison.
- Keep the shared `Viewport` values in epoch milliseconds. Convert x values to Unix seconds only at the uPlot boundary and convert `u.scales.x.min` and `u.scales.x.max` back to milliseconds in `getViewport()`.
- Keep the y-domain fixed at `0..100` kPa. The shared gesture layer changes x only; uPlot must never auto-range y after data, viewport, or size changes.
- Use `PLOT_INSETS = { top: 16, right: 12, bottom: 36, left: 52 }`, `CHART_HEIGHT = 360`, and `SERIES_COLORS` from `src/shared/types.ts` so the candidates have the same geometry.
- `setViewport()` is one-way and never calls `onViewportChange`. uPlot owns no gestures in this prototype, so its adapter never invokes that callback.
- Do not add inertia, wheel zoom, uPlot's demo touch plugin, or a renderer-specific gesture listener. The shared D3 controller is the only touch owner for this route.
- Mount one chart at a time. `destroy()` must be idempotent and must call uPlot's public `destroy()` exactly once.
- The shared shell implementation and tests are prerequisites. If their reviewed names or signatures differ from this plan, stop and report the divergence instead of adding a second contract.

## File structure

- Create `web/history-zoom-prototypes/src/adapters/uplot-data.ts`: normalize ordering and duplicate timestamps, convert milliseconds to seconds, and call stable uPlot's aligned-data join.
- Create `web/history-zoom-prototypes/src/adapters/uplot.ts`: mount and update uPlot, translate viewports, expose the measured plot rectangle, resize, and clean up.
- Create `web/history-zoom-prototypes/tests/uplot-data.test.ts`: pin conversion against the real uPlot package.
- Create `web/history-zoom-prototypes/tests/uplot-adapter.test.ts`: pin the mounted adapter's public calls and lifecycle with a uPlot spy.
- Do not edit shared shell, gesture, fixture, browser-driver, configuration, package, lock, README, or shared browser-test files in this plan. Those belong to the shared implementation plan.

## Shared interfaces consumed by this plan

```ts
// src/shared/types.ts
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
```

```ts
// src/shared/types.ts
export const PLOT_INSETS = { top: 16, right: 12, bottom: 36, left: 52 } as const;
export const CHART_HEIGHT = 360;
export const SERIES_COLORS: readonly string[];
```

The shell calls `mountUplot(host, initial, onViewportChange)`, then `setData`, `setViewport`, and `resize` before it measures `getPlotRect()` and creates the D3 gesture layer. The shared browser driver exports these exact helpers from `tests/browser/cdp-touch.ts`:

```ts
dispatchTouchSequence(cdp, steps)
pinchPoints(rect, { startGap, endGap, startCenterX, endCenterX, y, steps })
panPoints(rect, { fromX, toX, y, steps })
liftSecondFingerAndContinue(...)
```

`window.__historyZoomProbe` reports `requestedViewport`, `renderedViewport`, `plotRect`, `adapterSetViewportCalls`, `viewportNotifications`, `reactRenderCount`, and `frameSamples`. `renderedViewport` must come from this adapter's `getViewport()`, which reads uPlot's scale rather than a cached request.

## Review focus

- A timestamp present only in a neighboring sensor must produce `undefined` for this sensor, so asynchronous sampling does not invent an outage; `tests/uplot-data.test.ts` distinguishes it from an explicit `null`.
- A real zero must remain numeric `0` through alignment and rendering; the converter test and the shared real-canvas browser check pin it.
- Repeated or out-of-order input timestamps must not violate uPlot's ascending unique-x requirement; the converter sorts a copy and applies a documented last-input-wins duplicate rule.
- Delayed `setData` calls and resizes must preserve the current x-domain; adapter unit tests read the spy's actual scale and shared Playwright reads `renderedViewport` after both operations.
- Plot bounds are CSS-pixel DOM geometry from `u.rect` after `syncRect()`. No device-pixel-ratio multiplication is allowed; the resize unit test and post-rotation anchored-pinch browser case pin this boundary.

---

### Task 1: Preserve asynchronous samples and explicit outages in uPlot data

**Files:**

- Create: `web/history-zoom-prototypes/src/adapters/uplot-data.ts`
- Create: `web/history-zoom-prototypes/tests/uplot-data.test.ts`

**Interfaces:**

- Consumes: `SensorSeries` from `src/shared/types.ts`; stable `uPlot.join(tables)` from `uplot@1.6.32`.
- Produces: `toUplotData(series: readonly SensorSeries[]): uPlot.AlignedData`.
- Invariant: input arrays remain untouched; points are sorted by `t`; the last point in source order wins when one series repeats a millisecond timestamp; milliseconds are divided by `1000` after deduplication.
- Null rule: call `uPlot.join(tables)` without `nullModes`. In stable 1.6.32 this is `JoinNullMode.Retain`: explicit nulls remain `null`, and alignment artifacts remain `undefined`. Do not import the declaration-only `const enum` as a runtime value and do not use Expand, which would enlarge an outage across neighboring sensors' timestamps.

- [ ] **Step 1: Write the failing alignment and null-semantics tests**

Create `tests/uplot-data.test.ts` with concrete inputs whose timestamps do not line up:

```ts
import { describe, expect, it } from "vitest";
import type { SensorSeries } from "../src/shared/types";
import { toUplotData } from "../src/adapters/uplot-data";

const series: readonly SensorSeries[] = [
  {
    id: "upper",
    label: "Upper soil",
    unit: "kPa",
    points: [
      { t: 4_000, value: 20 },
      { t: 0, value: 10 },
      { t: 2_000, value: null },
      { t: 0, value: 0 },
    ],
  },
  {
    id: "lower",
    label: "Lower soil",
    unit: "kPa",
    points: [
      { t: 1_000, value: 30 },
      { t: 3_000, value: 96 },
    ],
  },
];

describe("toUplotData", () => {
  it("uses ascending seconds and distinguishes alignment holes from explicit gaps", () => {
    expect(toUplotData(series)).toEqual([
      [0, 1, 2, 3, 4],
      [0, undefined, null, undefined, 20],
      [undefined, 30, undefined, 96, undefined],
    ]);
  });

  it("does not mutate source point order", () => {
    const before = series.map((item) => [...item.points]);
    toUplotData(series);
    expect(series.map((item) => item.points)).toEqual(before);
  });

  it("returns an x column for an empty series list", () => {
    expect(toUplotData([])).toEqual([[]]);
  });
});
```

This one fixture pins all four conversion hazards: milliseconds versus seconds, out-of-order points, duplicate timestamps, and zero versus null. The duplicate at `t = 0` proves the last source occurrence wins.

- [ ] **Step 2: Run the focused test and verify the expected red state**

Run:

```bash
cd web/history-zoom-prototypes
npm run test -- tests/uplot-data.test.ts
```

Expected: FAIL because `src/adapters/uplot-data.ts` cannot be resolved. A pass, a different missing shared-module error, or “no tests found” is a harness divergence; stop and repair the prerequisite rather than counting it as red.

- [ ] **Step 3: Implement the converter with the released join API**

Create `src/adapters/uplot-data.ts`:

```ts
import uPlot from "uplot";
import type { SensorSeries } from "../shared/types";

type UplotTable = [number[], Array<number | null>];

function normalizeTable(series: SensorSeries): UplotTable {
  const valueByMillisecond = new Map<number, number | null>();

  for (const point of series.points) {
    valueByMillisecond.set(point.t, point.value);
  }

  const ordered = [...valueByMillisecond.entries()].sort(
    ([left], [right]) => left - right,
  );

  return [
    ordered.map(([timestamp]) => timestamp / 1_000),
    ordered.map(([, value]) => value),
  ];
}

export function toUplotData(
  series: readonly SensorSeries[],
): uPlot.AlignedData {
  if (series.length === 0) {
    return [[]];
  }

  return uPlot.join(series.map(normalizeTable));
}
```

Do not replace `undefined` with `null` after the join. In uPlot's line builder `undefined` skips an alignment-only point, while `null` contributes a real gap when `spanGaps` is false.

- [ ] **Step 4: Run the converter test and package typecheck**

Run:

```bash
cd web/history-zoom-prototypes
npm run test -- tests/uplot-data.test.ts
npm run build
```

Expected: the three converter tests PASS, and the Vite TypeScript build exits 0.

- [ ] **Step 5: Commit the data boundary**

```bash
git add web/history-zoom-prototypes/src/adapters/uplot-data.ts \
  web/history-zoom-prototypes/tests/uplot-data.test.ts
git commit -m "test: preserve uplot sensor gap semantics"
```

---

### Task 2: Mount uPlot behind the shared chart contract

**Files:**

- Create: `web/history-zoom-prototypes/src/adapters/uplot.ts`
- Create: `web/history-zoom-prototypes/tests/uplot-adapter.test.ts`

**Interfaces:**

- Consumes: `ChartAdapter`, `MountAdapter`, `SensorSeries`, `Viewport`, `CHART_HEIGHT`, `PLOT_INSETS`, and `SERIES_COLORS` from `src/shared/types.ts`; `toUplotData` from Task 1.
- Produces: named `mountUplot: MountAdapter` and `export default mountUplot`.
- Renderer calls: `setData(data, false)`, `batch(...)`, `setScale("x", { min, max })`, `setSize({ width, height })`, `syncRect()`, `rect`, `scales.x.min/max`, `addSeries`, `delSeries`, and `destroy()` from stable uPlot 1.6.32.
- Gesture boundary: the callback argument is intentionally unused because the sibling D3 layer owns all uPlot gestures. Built-in cursor drag and wheel behavior stay disabled.

- [ ] **Step 1: Write the failing public-contract tests with a renderer spy**

Register `vi.doMock("uplot", ...)` and dynamically import `src/adapters/uplot.ts` so the mounted adapter receives the fake constructor. Give `FakeUPlot` the same public members the adapter uses: static `join`, `series`, `scales`, `rect`, `setData`, `batch`, `setScale`, `setSize`, `syncRect`, `addSeries`, `delSeries`, and `destroy`. `join` returns a harmless aligned-data stub for lifecycle tests, `batch` invokes its callback immediately, and `setScale` updates `scales.x.min/max`; otherwise `getViewport()` could pass by reading requested state instead of renderer state. Task 1 already tests the real join separately.

Create `tests/uplot-adapter.test.ts` with this setup before the adapter assertions:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SensorSeries, Viewport } from "../src/shared/types";

const initialViewport: Viewport = {
  from: 1_700_000_000_000,
  to: 1_700_086_400_000,
};

function sensor(
  id: string,
  label: string,
  points: SensorSeries["points"],
): SensorSeries {
  return { id, label, unit: "kPa", points };
}

const emptyThreeSeries: readonly SensorSeries[] = [
  sensor("swt-1", "Upper", []),
  sensor("swt-2", "Middle", []),
  sensor("swt-3", "Lower", []),
];
const populatedThreeSeries: readonly SensorSeries[] = [
  sensor("swt-1", "Upper", [{ t: 12_000, value: 0 }]),
  sensor("swt-2", "Middle", [{ t: 13_000, value: null }]),
  sensor("swt-3", "Lower", [{ t: 14_000, value: 96 }]),
];
const relabeledThreeSeries: readonly SensorSeries[] = [
  sensor("swt-1", "SWT 10 cm", [{ t: 12_000, value: 0 }]),
  sensor("swt-2", "SWT 30 cm", [{ t: 13_000, value: null }]),
  sensor("swt-3", "SWT 60 cm", [{ t: 14_000, value: 96 }]),
];

const constructed: FakeUPlot[] = [];

class FakeUPlot {
  static join = vi.fn(() => [[]]);
  options: Record<string, any>;
  series: Array<Record<string, any>>;
  scales = { x: { min: null as number | null, max: null as number | null } };
  rect = new DOMRect(52, 16, 348, 308);
  setData = vi.fn();
  setSize = vi.fn();
  syncRect = vi.fn();
  destroy = vi.fn();
  batch = vi.fn((run: () => void) => run());
  setScale = vi.fn(
    (_key: string, limits: { min: number; max: number }) => {
      this.scales.x = { ...limits };
    },
  );
  addSeries = vi.fn((options: Record<string, any>) => {
    this.series.push(options);
  });
  delSeries = vi.fn((index: number) => {
    this.series.splice(index, 1);
  });

  constructor(
    options: Record<string, any>,
    _data: unknown,
    _host: HTMLElement,
  ) {
    this.options = options;
    this.series = [...options.series];
    constructed.push(this);
  }
}

vi.doMock("uplot", () => ({ default: FakeUPlot }));
const { mountUplot } = await import("../src/adapters/uplot");

function mountAt(
  size: { width: number; height: number },
  onViewportChange = vi.fn(),
) {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { value: size.width, configurable: true },
    clientHeight: { value: size.height, configurable: true },
  });
  const adapter = mountUplot(host, initialViewport, onViewportChange);
  const plot = constructed.at(-1)!;
  return { adapter, host, onViewportChange, options: plot.options, plot };
}

beforeEach(() => {
  constructed.length = 0;
});
```

Use `expect(constructed).toHaveLength(1)` in the series-reconciliation case. Do not try to use `toHaveBeenCalledTimes` on the fake class constructor itself.

Use these tests and exact assertions:

```ts
it("configures fixed geometry and a fixed 0..100 kPa y scale", () => {
  const { options } = mountAt({ width: 412, height: 360 });
  expect(options.padding).toEqual([16, 12, 0, 0]);
  expect(options.axes[0].size).toBe(36);
  expect(options.axes[1].size).toBe(52);
  expect(options.scales.y).toMatchObject({ auto: false, range: [0, 100] });
  expect(options.cursor.drag.setScale).toBe(false);
  expect(options.legend.show).toBe(false);
});

it("writes seconds to uPlot and reads the renderer scale back as milliseconds", () => {
  const { adapter, plot } = mountAt({ width: 412, height: 360 });
  adapter.setViewport({ from: 1_700_000_000_000, to: 1_700_086_400_000 });
  expect(plot.setScale).toHaveBeenLastCalledWith("x", {
    min: 1_700_000_000,
    max: 1_700_086_400,
  });
  expect(plot.batch).toHaveBeenCalled();

  plot.scales.x.min = 1_700_000_123;
  plot.scales.x.max = 1_700_086_523;
  expect(adapter.getViewport()).toEqual({
    from: 1_700_000_123_000,
    to: 1_700_086_523_000,
  });
});

it("keeps the renderer viewport when asynchronous data arrives", () => {
  const { adapter, plot } = mountAt({ width: 412, height: 360 });
  adapter.setViewport({ from: 10_000, to: 20_000 });
  adapter.setData(emptyThreeSeries);
  adapter.setData(populatedThreeSeries);
  expect(plot.setData).toHaveBeenLastCalledWith(expect.any(Array), false);
  expect(adapter.getViewport()).toEqual({ from: 10_000, to: 20_000 });
});

it("measures the real CSS plot rectangle again after resize", () => {
  const { adapter, host, plot } = mountAt({ width: 412, height: 360 });
  Object.defineProperty(host, "clientWidth", { value: 824 });
  plot.rect = new DOMRect(52, 16, 760, 308);
  adapter.resize();
  expect(plot.setSize).toHaveBeenLastCalledWith({ width: 824, height: 360 });
  expect(plot.syncRect).toHaveBeenCalled();
  expect(adapter.getPlotRect()).toEqual(plot.rect);
  expect(adapter.getViewport()).toEqual(initialViewport);
});

it("reconciles series metadata without mounting a second chart", () => {
  const { adapter, plot } = mountAt({ width: 412, height: 360 });
  adapter.setData(populatedThreeSeries);
  adapter.setData(relabeledThreeSeries);
  expect(constructed).toHaveLength(1);
  expect(plot.series).toHaveLength(4);
  expect(plot.series.slice(1).map((item) => item.label)).toEqual([
    "SWT 10 cm (kPa)",
    "SWT 30 cm (kPa)",
    "SWT 60 cm (kPa)",
  ]);
  expect(plot.series[1].points.show).toBe(true);
  adapter.setData([sensor("swt-1", "Upper", Array.from({ length: 501 }, (_, i) => ({ t: i * 1000, value: 20 })))]);
  expect(plot.series[1].points.show).toBe(false);
});

it("destroys uPlot once and never emits a viewport callback", () => {
  const onViewportChange = vi.fn();
  const { adapter, plot } = mountAt(
    { width: 412, height: 360 },
    onViewportChange,
  );
  adapter.setViewport({ from: 10_000, to: 20_000 });
  adapter.destroy();
  adapter.destroy();
  expect(plot.destroy).toHaveBeenCalledTimes(1);
  expect(onViewportChange).not.toHaveBeenCalled();
});
```

Define `initialViewport` as a 24-hour millisecond range. Define `emptyThreeSeries`, `populatedThreeSeries`, and `relabeledThreeSeries` in this test file with three complete `SensorSeries` objects; `relabeledThreeSeries` keeps the same IDs and changes the labels to those asserted above. `mountAt` creates a real `div`, stubs `clientWidth` and `clientHeight`, mounts the adapter, and returns the one constructed spy instance. Do not assert on a second cache maintained by the fake.

- [ ] **Step 2: Run the adapter test and verify the expected red state**

Run:

```bash
cd web/history-zoom-prototypes
npm run test -- tests/uplot-adapter.test.ts
```

Expected: FAIL because `src/adapters/uplot.ts` cannot be resolved. Missing shared types or constants indicate the shared prerequisite is incomplete and must be reported.

- [ ] **Step 3: Implement the adapter with fixed scales and public readback**

Create `src/adapters/uplot.ts` with this structure:

```ts
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type {
  ChartAdapter,
  MountAdapter,
  SensorSeries,
  Viewport,
} from "../shared/types";
import {
  CHART_HEIGHT,
  PLOT_INSETS,
  SERIES_COLORS,
} from "../shared/types";
import { toUplotData } from "./uplot-data";

const EMPTY_DATA: uPlot.AlignedData = [[]];
const MAX_MARKER_POINTS = 500;

function seconds(viewport: Viewport): { min: number; max: number } {
  return { min: viewport.from / 1_000, max: viewport.to / 1_000 };
}

function seriesKey(series: readonly SensorSeries[]): string {
  return series
    .map(({ id, label, unit, points }) => `${id}\u0000${label}\u0000${unit}\u0000${points.length <= MAX_MARKER_POINTS}`)
    .join("\u0001");
}

export const mountUplot: MountAdapter = (
  host,
  initial,
  onViewportChange,
): ChartAdapter => {
  void onViewportChange;

  const plot = new uPlot(
    {
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight || CHART_HEIGHT),
      ms: 1e-3,
      padding: [PLOT_INSETS.top, PLOT_INSETS.right, 0, 0],
      legend: { show: false },
      cursor: {
        show: false,
        drag: { setScale: false, x: false, y: false },
      },
      scales: {
        x: { time: true, auto: false },
        y: { auto: false, range: [0, 100] },
      },
      axes: [
        { size: PLOT_INSETS.bottom },
        { size: PLOT_INSETS.left },
      ],
      series: [{}],
    },
    EMPTY_DATA,
    host,
  );

  let mountedSeriesKey = "";
  let destroyed = false;

  function applyViewport(viewport: Viewport): void {
    plot.batch(() => {
      plot.setScale("x", seconds(viewport));
    });
  }

  function readViewport(): Viewport {
    const { min, max } = plot.scales.x;
    if (min == null || max == null) {
      throw new Error("uPlot x scale is unavailable");
    }
    return { from: min * 1_000, to: max * 1_000 };
  }

  function reconcileSeries(series: readonly SensorSeries[]): void {
    const nextKey = seriesKey(series);
    if (nextKey === mountedSeriesKey) return;

    for (let index = plot.series.length - 1; index >= 1; index -= 1) {
      plot.delSeries(index);
    }

    series.forEach((item, index) => {
      plot.addSeries({
        label: `${item.label} (${item.unit})`,
        stroke: SERIES_COLORS[index % SERIES_COLORS.length],
        width: 2,
        spanGaps: false,
        points: {
          show: item.points.length <= MAX_MARKER_POINTS,
          size: 4,
        },
      });
    });

    mountedSeriesKey = nextKey;
  }

  applyViewport(initial);

  return {
    setData(series) {
      reconcileSeries(series);
      const visible = readViewport();
      plot.setData(toUplotData(series), false);
      applyViewport(visible);
    },
    setViewport(viewport) {
      applyViewport(viewport);
    },
    getViewport() {
      return readViewport();
    },
    getPlotRect() {
      plot.syncRect();
      return plot.rect;
    },
    resize() {
      const visible = readViewport();
      plot.setSize({
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight || CHART_HEIGHT),
      });
      applyViewport(visible);
      plot.syncRect();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      plot.destroy();
    },
  };
};

export default mountUplot;
```

The adapter deliberately preserves the visible scale around `setData(data, false)` even though stable uPlot documents `false` as “do not reset scales.” The explicit reapply catches future series reconciliation behavior and makes the async-arrival invariant visible in the spy test. `batch` matters because stable 1.6.32 normally commits scale updates in a microtask; an immediate `getViewport()` must observe the public scale, including while the chart still has empty data. No dummy readings are needed. Four-pixel markers appear for series with at most 500 input points, matching the other adapters. The series key includes this marker-policy boundary so replacing data updates point visibility even when names stay unchanged.

- [ ] **Step 4: Run the adapter tests, converter tests, and build**

Run:

```bash
cd web/history-zoom-prototypes
npm run test -- tests/uplot-data.test.ts tests/uplot-adapter.test.ts
npm run build
```

Expected: both test files PASS, and the production build exits 0. Importing `uplot/dist/uPlot.min.css` is expected; unresolved `uplot`, duplicate React, or a `const enum` runtime import is a failure.

- [ ] **Step 5: Commit the renderer adapter**

```bash
git add web/history-zoom-prototypes/src/adapters/uplot.ts \
  web/history-zoom-prototypes/tests/uplot-adapter.test.ts
git commit -m "feat: add uplot mobile history adapter"
```

---

### Task 3: Prove the shared touch contract against the real uPlot canvas

**Files:**

- Verify only: `web/history-zoom-prototypes/tests/browser/history-zoom.spec.ts`
- Verify only: `web/history-zoom-prototypes/tests/browser/cdp-touch.ts`
- Verify only: `web/history-zoom-prototypes/src/shared/inspection.ts`
- Verify only: `web/history-zoom-prototypes/README.md`

**Interfaces:**

- Consumes: the shared CDP helpers listed above, the `#/uplot` route, the sibling `.gesture-layer`, and `window.__historyZoomProbe`.
- Produces: no new interface or shared-file edit. This task is the uPlot acceptance gate over shared tests. If a required case is absent, report it to the shared-plan owner; do not add a private uPlot-only gesture rule.

- [ ] **Step 1: Verify that the shared suite contains the required renderer-level assertions**

Open `tests/browser/history-zoom.spec.ts` and confirm its `#/uplot` cases do all of the following through CDP touch input and the real probe:

1. Compare 60-move and four-move pinches with identical endpoints and require final spans within 1%.
2. Move the pinch midpoint and require the time beneath that midpoint to remain anchored within two CSS pixels away from an extent clamp.
3. Compare mostly horizontal and mostly vertical finger alignment with the same Euclidean gap ratio; record `pinch-axis-orientation` as PASS only when final spans agree within 1%.
4. Run one-finger pan, add a second finger, lift it, then continue with the remaining finger; require continuous movement with no viewport jump.
5. Reverse the pinch direction, send `touchCancel`, and prove a fresh gesture still changes the viewport.
6. Change the emulated viewport from `448 x 998` to `998 x 448`, observe a changed real `plotRect`, then complete another anchored pinch with at most two CSS pixels of anchor drift.
7. Resolve delayed fixture requests out of order and require the latest data plus an unchanged rendered viewport.
8. Switch away from and back to `#/uplot`, require one `chart-host`, no orphan prior renderer root or gesture layer, and no notification from the destroyed chart. Do not count canvases because a renderer may legitimately own more than one.
9. Read actual canvas pixels for the fixture's explicit null outage, real zero, and 96 kPa spike. An aligned-array assertion or probe-only data echo does not meet this check.
10. Load the stress fixture and retain `frameSamples` as diagnostic output without a 60 fps assertion.

The shared tests use the exact titles `preserves the renderer viewport through equivalent 60-step and 4-step pinches`, `keeps the moving pinch midpoint anchored`, `continues 1 -> 2 -> 1 without a jump`, and `renders zero, spike, and a visible null gap from the nominal fixture`. The partial-lift case must exercise both release orders. Viewport assertions compare `probe.requestedViewport` and `probe.renderedViewport`; the latter reflects `u.scales.x`. Touch coordinates come from the observed `probe.plotRect`, never from `PLOT_INSETS` or hard-coded Pixel coordinates.

- [ ] **Step 2: Run the shared browser matrix and inspect the uPlot results**

Run:

```bash
cd web/history-zoom-prototypes
npm run test:browser
```

Run this integration task after all three adapters and shared Task 5 exist. Expected: uPlot's renderer-integrity cases PASS, its gesture suitability entries contain measurements, and the run produces all six candidate/fixture diagnostic files required by the shared plan. A missing uPlot result, skipped criterion, or “no tests found” is a failure.

- [ ] **Step 3: Diagnose failures at the correct ownership boundary**

Use these mappings rather than weakening shared tolerances:

- If requested and rendered viewports differ by exactly `1000`, fix the seconds/milliseconds translation in `src/adapters/uplot.ts`.
- If a neighboring sensor timestamp creates a line break, inspect `toUplotData` for conversion of `undefined` to `null`.
- If explicit outages connect, keep `spanGaps: false` and the default retain mode in `uPlot.join`.
- If the plot rectangle shifts after rotation, call `setSize` and then `syncRect`; do not synthesize a rectangle from insets.
- If `1 -> 2 -> 1` stops after the second finger lifts, inspect the shared D3 controller. Do not copy uPlot's demo plugin: its unconditional `touchend` removal is the known failure this prototype avoids.
- If pinch length changes the result, inspect shared D3 transform synchronization and event ordering. Do not add adapter smoothing or inertia.
- If route switching leaves another canvas or emits after cleanup, first confirm the shell calls adapter and D3 cleanup. The uPlot adapter's owned responsibility is one idempotent `plot.destroy()`.

After any fix in an owned file, rerun the focused unit file, then the full uPlot browser slice.

- [ ] **Step 4: Run the complete automated gate**

Run:

```bash
cd web/history-zoom-prototypes
npm run check
```

Expected: unit tests, TypeScript/build checks, and renderer-integrity Playwright checks PASS for all three routes. The Chart.js suitability record may contain an explicit measured `FAIL` while `npm run check` exits 0; that is a valid comparison result. A broken mount, stale renderer domain, missing diagnostic, skipped criterion, or harness assertion remains a release blocker and belongs with that plan's owner.

- [ ] **Step 5: Exercise the Pixel 8 Pro handoff without claiming phone performance**

Start the local-network preview exactly as documented by the shared README:

```bash
cd web/history-zoom-prototypes
npm run dev -- --host 0.0.0.0
```

On the Pixel 8 Pro, open the documented LAN URL with `#/uplot` and ask the user to check:

- a slow one-finger pan tracks the finger without lag or a release jump;
- a two-finger spread narrows the time range around the live midpoint;
- moving both fingers together while spreading keeps the data under the midpoint;
- lifting one finger allows the other to continue panning without a jump;
- the nominal outage is visibly broken, zero is plotted at the baseline, and the 96 kPa spike remains visible;
- the stress fixture feels responsive relative to the other two routes.

Record desktop Chromium `frameSamples` separately from the user's observations. State “real Pixel performance pending” until the user performs this step; viewport emulation and CDP touch events do not prove 60 fps or physical-device feel.

- [ ] **Step 6: Inspect the final owned diff**

Run:

```bash
git status --short
git diff --check 242ca634961b5305f40197e771e197a5eaa0f61a...HEAD -- \
  web/history-zoom-prototypes/src/adapters/uplot.ts \
  web/history-zoom-prototypes/src/adapters/uplot-data.ts \
  web/history-zoom-prototypes/tests/uplot-adapter.test.ts \
  web/history-zoom-prototypes/tests/uplot-data.test.ts
git diff 242ca634961b5305f40197e771e197a5eaa0f61a...HEAD -- \
  web/history-zoom-prototypes/src/adapters/uplot.ts \
  web/history-zoom-prototypes/src/adapters/uplot-data.ts \
  web/history-zoom-prototypes/tests/uplot-adapter.test.ts \
  web/history-zoom-prototypes/tests/uplot-data.test.ts
```

Expected: the base-to-HEAD whitespace check exits 0; the second diff displays the four uPlot-owned implementation/test files for review; `git status --short` shows no unfinished uPlot edits. This plan's commits contain no production GUI code, shared gesture code, dependency files, or another candidate adapter.
