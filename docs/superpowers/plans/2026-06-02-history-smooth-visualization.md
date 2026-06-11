# Smooth History Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fullscreen history charts feel like a native Apple app — instant, continuous pinch/pan zoom with no draw animation, no measurement dots, and no per-frame network fetch.

**Architecture:** Edge-only (`web/react-gui`). Two changes: (1) make every line/area chart a clean numeric-time line (epoch-ms x-axis, `domain` clipping, animation off, dots off); (2) split the **live visual window** (drives the chart's x-domain, updated every gesture frame, zero network) from the **committed fetch range** (drives the SWR request, updated once on gesture end). During a pinch/pan the chart re-clips already-loaded points; on release it refetches once at the right aggregation, keeping the previous data on screen so there is no flash.

**Tech Stack:** Vite + React 18 + TypeScript, SWR, Recharts, Vitest + Testing Library + `tsx --test`.

---

## Source

- Analysis basis: `useHistoryCardData.ts` SWR key includes `range.from/to` (refetch per frame); line views use `dot={{ r: 3 }}` and default Recharts animation; x-axis is `dataKey="timestamp"` (category, can't clip to a live domain).
- Prior specs: `docs/superpowers/specs/2026-06-02-history-fullscreen-polish-design.md`.

## Constraints

- Edge-only; no API/Node-RED/schema/`osi-server` changes; offline-first preserved.
- No new range/view-mode buttons; gesture model from the prior round unchanged.
- Pinch/pan smoothness is only fully judgeable on a real device — Slice 4 is a manual loop.

## Branch & verification

```bash
cd /home/phil/Repos/osi-os && git switch feat/history-data-visualization
cd web/react-gui && npm run test:unit && npm run build
```

## Review loop (every slice): run verification → commit each task → review → `fix:` commits → re-verify → second review.

---

## Slice 1 — Clean numeric-time line charts (dots off, animation off)

**Purpose:** Remove the draw animation and dots; convert line/area views to a numeric epoch-ms x-axis that accepts a `domain`. No behaviour change yet (domain defaults to the data extent).

**Files (each line/area view):**
- Modify: `web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/EnvironmentLineChartView.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/DendroLineChartView.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/DendroGrowthTimelineView.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/DailyMinMaxView.tsx`
- Tests: matching `__tests__` files.

### Task 1.1 — Soil line chart: numeric axis, no dots, no animation

- [ ] **Step 1: Update `SoilLineChartView.test.tsx`** to assert no dots and numeric domain support. Since Recharts SVG internals are hard to assert, assert the row shape exposes a numeric `tMs` and the chart renders without throwing for a provided `window`:

```tsx
import { buildNumericRows } from '../visualizations/SoilLineChartView';
test('rows carry epoch-ms timestamps for numeric axis', () => {
  const rows = buildNumericRows([{ key: 'swt_1', label: 'L1', unit: 'kPa', points: [{ t: '2026-06-01T00:00:00Z', value: 6 }] }] as any);
  expect(rows[0].tMs).toBe(Date.parse('2026-06-01T00:00:00Z'));
});
```

- [ ] **Step 2: Run, confirm fail.** `cd web/react-gui && npm run test:unit:vitest -- SoilLineChartView`.

- [ ] **Step 3: Edit `SoilLineChartView.tsx`:**
  - Export `buildNumericRows` that maps each row to include `tMs: Date.parse(timestamp)` alongside the series values.
  - Accept a new optional prop `window?: { fromMs: number; toMs: number }`.
  - Change the chart:

```tsx
<LineChart data={rows} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
  <XAxis
    dataKey="tMs"
    type="number"
    scale="time"
    domain={window ? [window.fromMs, window.toMs] : ['dataMin', 'dataMax']}
    allowDataOverflow
    tickFormatter={(ms) => formatTimestamp(new Date(ms).toISOString())}
    minTickGap={28}
  />
  <YAxis width={52} label={{ value: 'kPa', angle: -90, position: 'insideLeft' }} />
  {visibleSeries.map((series, index) => (
    <Line
      key={series.key}
      type="monotone"
      dataKey={series.key}
      stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
      strokeWidth={2}
      dot={false}
      isAnimationActive={false}
      connectNulls={false}
    />
  ))}
</LineChart>
```

  (Keep `<Tooltip>` if present, but set `isAnimationActive={false}` on it too.)

- [ ] **Step 4: Run, confirm pass.**

- [ ] **Step 5: Commit.**

```bash
git add web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx web/react-gui/src/components/history/__tests__
git commit -m "perf(history): numeric-time soil line, no dots or animation"
```

### Task 1.2 — Apply the same to the other four views

- [ ] **Step 1:** For `EnvironmentLineChartView`, `DendroLineChartView`, `DendroGrowthTimelineView`, `DailyMinMaxView`: in each, convert the x-axis to `dataKey="tMs" type="number" scale="time" domain={window ? [...] : ['dataMin','dataMax']} allowDataOverflow`, add `tMs` to the rows, set every `<Line>`/`<Area>` to `dot={false} isAnimationActive={false}`, and add the optional `window` prop. (DailyMinMax keeps its min/max `<Area>` + mean `<Line>`; just dots off + animation off + numeric axis.)

- [ ] **Step 2:** Update each view's test to the `buildNumericRows`-style assertion (export a small rows builder per view or assert the component renders with a `window` prop without error).

- [ ] **Step 3: Run all, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/components/history/visualizations web/react-gui/src/components/history/__tests__
git commit -m "perf(history): numeric-time lines, dots and animation off across views"
```

---

## Slice 2 — Live visual window decoupled from data fetch

**Purpose:** During pinch/pan, drive only the chart's x-domain (instant, no network); commit the range to SWR once on gesture end; keep previous data on screen so there is no loading flash.

**Files:**
- Modify: `web/react-gui/src/history/useVisualizationGestures.ts`
- Modify: `web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx`
- Modify: `web/react-gui/src/components/history/HistoryCardVisualization.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/src/history/useHistoryCardData.ts`
- Tests: `web/react-gui/src/components/history/__tests__/HistoryVisualizationSurface.test.tsx`

### Task 2.1 — SWR keeps previous data (no flash on commit)

- [ ] **Step 1:** In `useHistoryCardData.ts`, pass `{ keepPreviousData: true }` as the SWR options so a new range keeps the old chart data visible until the new data resolves.

```ts
const swr = useSWR(getHistoryCardDataKey(options), () => fetch..., { keepPreviousData: true });
```

- [ ] **Step 2: Build, commit.**

```bash
cd web/react-gui && npm run build
git add web/react-gui/src/history/useHistoryCardData.ts
git commit -m "perf(history): keep previous card data during refetch"
```

### Task 2.2 — Gesture hook emits a live window during the gesture, commits on end

- [ ] **Step 1: Add a test** in `HistoryVisualizationSurface.test.tsx` that a pinch move calls `onVisualWindow` (not `onViewportChange`) and `touchend` calls `onViewportChange` once:

```tsx
it('pinch move updates visual window only; release commits the viewport', () => {
  const onVisualWindow = vi.fn(); const onViewportChange = vi.fn();
  render(<HistoryVisualizationSurface viewport={v24h} defaultRange="24h" activeView="line-chart" isZoomed={false}
    onVisualWindow={onVisualWindow} onViewportChange={onViewportChange}
    onCardSwipe={vi.fn()} onViewSwipe={vi.fn()} onMonthSwipe={vi.fn()} onInspect={vi.fn()}><div>c</div></HistoryVisualizationSurface>);
  const s = screen.getByTestId('history-visualization-surface');
  pinchMove(s, { startDist: 80, endDist: 200 });        // helper: 2-finger move apart
  expect(onVisualWindow).toHaveBeenCalled();
  expect(onViewportChange).not.toHaveBeenCalled();
  pinchEnd(s);
  expect(onViewportChange).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Edit `useVisualizationGestures.ts`.** Add `onVisualWindow?: (window: { fromMs: number; toMs: number }) => void` to the input. During a pinch/zoom-pan gesture:
  - Each rAF frame: compute the next window (anchored at the finger midpoint, as today) and call `onVisualWindow({ fromMs, toMs })` — do **not** call `onViewportChange`.
  - On `touchend`: call `onViewportChange(finalViewport)` exactly once with the committed range, then stop emitting the visual window (the committed range becomes the source of truth).
  Pan-when-zoomed behaves the same (visual window live, commit on release).

- [ ] **Step 4: Run, confirm pass.**

### Task 2.3 — Plumb the window to the charts; clear on commit

- [ ] **Step 1: Edit `HistoryVisualizationSurface.tsx`** to accept and forward `onVisualWindow`, and to accept a `window` prop it passes through to its children render (or expose it so the page can pass it down).

- [ ] **Step 2: Edit `HistoryCardDetailPage.tsx`:**
  - Add `const [visualWindow, setVisualWindow] = useState<{fromMs:number;toMs:number}|null>(null)`.
  - `onVisualWindow={setVisualWindow}`.
  - `onViewportChange={(v) => { timeViewport.setViewport(v); setVisualWindow(null); }}` — committing clears the transient window so the chart snaps to the freshly-fetched (and keep-previous) data at the committed domain.
  - Pass `window={visualWindow ?? committedWindowMs}` into `HistoryCardVisualization` (where `committedWindowMs` derives `{fromMs,toMs}` from `timeViewport.viewport.range`), so the chart always has an explicit domain — during the gesture it's the live window, otherwise the committed range.

- [ ] **Step 3: Edit `HistoryCardVisualization.tsx`** to accept `window?: {fromMs:number;toMs:number}` and pass it to each line/area view's new `window` prop.

- [ ] **Step 4: Add a detail-page test** that a visual-window update changes the chart domain without a new data request (mock `historyAPI`; assert call count unchanged during the gesture, +1 after release).

- [ ] **Step 5: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/history/useVisualizationGestures.ts web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx web/react-gui/src/components/history/HistoryCardVisualization.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/__tests__
git commit -m "perf(history): live visual-window zoom with commit-on-release"
```

---

## Slice 3 — 60fps polish

**Purpose:** Remove remaining jank sources so the motion is continuous.

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/*` (memoisation)
- Modify: `web/react-gui/src/history/useVisualizationGestures.ts`
- Modify: `web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx`

### Task 3.1 — Memoise rows and avoid re-mounting the chart

- [ ] **Step 1:** In each line/area view, wrap the row computation in `useMemo` keyed on the incoming `data` reference only (not on `window`), so changing the domain during a gesture does **not** rebuild the dataset — only Recharts re-clips. Confirm the `<ResponsiveContainer>`/`<LineChart>` element identity is stable across window changes (no conditional remount, stable `key`).

- [ ] **Step 2:** Ensure the label overlay and header do not re-render the chart subtree on each frame (split components / `React.memo` the chart view with a comparator that ignores unchanged `data` and compares `window` by value).

- [ ] **Step 3: Build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/components/history/visualizations web/react-gui/src/components/history/HistoryCardVisualization.tsx
git commit -m "perf(history): memoise chart rows and stabilise chart subtree"
```

### Task 3.2 — One viewport update per frame, clamped

- [ ] **Step 1:** Confirm the gesture hook coalesces all pinch `touchmove`s into a single `requestAnimationFrame` callback (one `onVisualWindow` per frame); cancel any pending frame on `touchend`/unmount. Clamp the window to `MIN_WINDOW`/`MAX_WINDOW` so zooming hits a hard stop (no NaN/inverted domains).

- [ ] **Step 2:** Add a unit test that two `pinchMove`s within one frame produce one `onVisualWindow` call (controllable rAF mock), and that the window never inverts (`fromMs < toMs`) at the clamp bounds.

- [ ] **Step 3: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/history/useVisualizationGestures.ts web/react-gui/src/components/history/__tests__
git commit -m "perf(history): single clamped viewport update per frame"
```

---

## Slice 4 — Device verification

**Purpose:** Confirm the motion feels native on a real phone.

**Files:** Modify `docs/ux/history-data-visualization-kaba100-issues.md`.

- [ ] **Step 1:** `cd web/react-gui && npm run build`; deploy to kaba100 (tar pipe to `/usr/lib/node-red/gui/`; never overwrite `/data/db/farming.db`); confirm served `index-*.js` hash matches `build/assets/`.
- [ ] **Step 2:** Playwright (kaba100, iPhone): line charts render with no dots and no draw-in animation on view/card switch; chart fills ~90%; soil/calendar colours intact. (Pinch smoothness itself is not automatable.)
- [ ] **Step 3 (manual, user):** On a real phone, pinch in/out and pan: motion tracks the fingers continuously with no flash, no redraw animation, no dots; release refills detail without a visible reload. Iterate `MIN/MAX_WINDOW`, rAF cadence, and commit timing until it feels native. Commit `fix:` per iteration.
- [ ] **Step 4:** Record the confirmed behaviour + screenshots; final `npm run test:unit && npm run build`; commit the doc.

```bash
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs(history): record smooth visualization verification"
```

---

## Self-review (coverage)

- Draw animation gone → Slice 1 (`isAnimationActive={false}`).
- Measurement dots gone, line only → Slice 1 (`dot={false}`).
- Render-as-fast-as-possible / no per-frame network → Slice 2 (live visual window vs commit-on-release + `keepPreviousData`).
- Numeric domain clipping that makes live zoom possible → Slice 1 (numeric `scale="time"` axis + `domain`).
- One continuous motion / 60fps → Slice 3 (memoised rows, single rAF/frame, clamp).
- Native-feel confirmation → Slice 4 (device loop).

## Acceptance criteria

- Lines render with no dots and no enter/draw animation; switching view/card shows data immediately, no draw-in.
- Pinch/pan zoom tracks the fingers continuously with no network fetch mid-gesture and no loading flash; a single refetch happens on release and the previous data stays visible until it resolves.
- Zoom is location-aware (anchored at finger midpoint) and clamped at min/max window with no inverted domains.
- `npm run test:unit` + `npm run build` green; user confirms the motion feels native on a real device.
