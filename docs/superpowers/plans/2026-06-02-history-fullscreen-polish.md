# History Fullscreen Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the fullscreen history Data view — remove leftover "History" chrome, give the chart ~90% of the screen, revise gestures (two-finger card switch, contextual one-finger, calendar month paging), make pinch fluid and location-aware, and add a landscape layout.

**Architecture:** Edge-only (`web/react-gui`), mobile-first. No API/data/schema/Node-RED changes. Edits concentrate in the fullscreen page, the gesture model + hook, the visualization surface, the view components, and the calendar view. Pure gesture math stays in `gestureModel.ts` (unit-tested); the React hook wires it to live `requestAnimationFrame` viewport updates and contextual callbacks.

**Tech Stack:** Vite + React 18 + TypeScript, React Router (HashRouter), SWR, i18next, Recharts, Vitest + Testing Library + `tsx --test`.

---

## Source documents

- Design spec: `docs/superpowers/specs/2026-06-02-history-fullscreen-polish-design.md`
- Prior round design: `docs/superpowers/specs/2026-06-02-history-fullscreen-gesture-redesign-design.md`

## Constraints

- Edge-only; no `osi-server`, no Node-RED/helper/schema changes; offline-first preserved.
- Routes unchanged (`#/history/zones/:zoneId(/cards/:cardId)`); change only visible strings.
- Do not reintroduce range or view-mode buttons.
- Pinch/pan and multi-touch cannot be verified by Playwright (single-finger only) — they get a manual real-device loop.

## Branch

```bash
cd /home/phil/Repos/osi-os
git status --short --branch
git switch feat/history-data-visualization
```

## Common verification

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
npm run build
```

## Review loop (every slice)

1. Run verification. 2. Commit each task. 3. Request review. 4. Apply `fix:` commits. 5. Re-verify. 6. Second review before next slice.

---

## Slice 1 — Strip "History" chrome and per-chart labels

**Purpose:** Remove the back button, inline source subtitle, all visible "History" text, and the per-chart label rows. Move the view/range label into a small in-chart overlay.

**Files:**
- Modify: `web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/EnvironmentLineChartView.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/DendroLineChartView.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/DailyMinMaxView.tsx`
- Modify: relevant tests under `web/react-gui/src/components/history/__tests__/`
- Modify: `web/react-gui/public/locales/*/history.json` (remove visible "History"/"Back to history" strings if referenced)

### Task 1.1 — Remove back button + inline sources from the header

- [ ] **Step 1: Update the detail test** in `HistoryCardDetailPage.test.tsx`:

```tsx
it('header has no back button, no inline sources, no History text', async () => {
  renderDetailRoute({ card: soilCardTwoSources });
  await screen.findByText(/Soil - Root Zone/i);
  expect(screen.queryByRole('button', { name: /back to history/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/back to history/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/2 sources/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/\bhistory\b/i)).not.toBeInTheDocument();
});
```

(Use the existing render helper in that file; `soilCardTwoSources` should have `sourceDeviceCount: 2`.)

- [ ] **Step 2: Run, confirm fail.** `cd web/react-gui && npm run test:unit:vitest -- HistoryCardDetailPage`.

- [ ] **Step 3: Edit `HistoryDetailHeader.tsx`.** Remove the back `Link`/button element and the inline source-summary line (the element rendering `sourceLabel`/"N sources: …"). Keep the title, the `⊟ sources` control (HistorySourcePopover, multi-source only), and `⋯`. Remove any `backHref`/`onBack` prop and its usages.

- [ ] **Step 4: Edit `HistoryCardDetailPage.tsx`.** Remove the prop that passed the back target and the source-subtitle text into `HistoryDetailHeader`.

- [ ] **Step 5: Run, confirm pass.** `npm run test:unit:vitest -- HistoryCardDetailPage`.

- [ ] **Step 6: Commit.**

```bash
git add web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/__tests__
git commit -m "feat(history): remove back button and inline sources from detail header"
```

### Task 1.2 — View/range label becomes an in-chart overlay

- [ ] **Step 1: Update the test** to expect the label inside the visualization, not as a standalone row:

```tsx
it('shows the view-mode label as a chart overlay', async () => {
  renderDetailRoute({ card: soilCard });
  const overlay = await screen.findByTestId('view-mode-label');
  expect(overlay).toHaveTextContent(/Soil Profile/i);
  expect(overlay.className).toMatch(/absolute/);
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Edit `HistoryCardDetailPage.tsx`.** Move the `<div data-testid="view-mode-label">{formatViewLabel(t, selectedView)} · {viewport.range.label}</div>` from its own row to an absolutely-positioned overlay inside the visualization container: `className="absolute top-1 left-2 z-10 text-[10px] text-[var(--text-tertiary)] pointer-events-none"`. Ensure the visualization container is `relative`.

- [ ] **Step 4: Run, confirm pass.**

### Task 1.3 — Strip per-chart labels

- [ ] **Step 1: Add/extend tests** for each line view asserting the labels are gone:

```tsx
// SoilLineChartView.test.tsx
expect(screen.queryByText(/soil line chart/i)).not.toBeInTheDocument();
expect(screen.queryByText(/\breadings\b/i)).not.toBeInTheDocument();
expect(screen.queryByText('Soil 1')).not.toBeInTheDocument();
// EnvironmentLineChartView test
expect(screen.queryByText(/environment trend/i)).not.toBeInTheDocument();
expect(screen.queryByText(/external temperature/i)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Edit the four view components.** Remove the title/subtitle/`{n} readings` header block and any series-legend rows rendered above the chart (the `Soil 1/2/3`, `External temperature`, etc. lists). Keep the Recharts `<XAxis>`/`<YAxis>` unit labels and the chart itself. Keep the real empty state.

- [ ] **Step 4: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/components/history/visualizations web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/__tests__ web/react-gui/public/locales
git commit -m "feat(history): strip chart labels and overlay the view-mode label"
```

---

## Slice 2 — Maximise chart to ~90% of the screen

**Purpose:** Remove nested container boxes; the active view fills a flex body sized to ~90% of viewport height.

**Files:**
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx`
- Modify: `web/react-gui/src/components/history/visualizations/SoilProfileView.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryCardDetailPage.test.tsx`

### Task 2.1 — Flatten the layout

- [ ] **Step 1: Write the test** asserting a single visualization container with the fill class and no double nesting:

```tsx
it('renders the visualization in a single flex-fill container', async () => {
  renderDetailRoute({ card: soilCard });
  const surface = await screen.findByTestId('history-visualization-surface');
  // the surface should be the flex-filled body, not wrapped in an extra bordered card
  expect(surface.className).toMatch(/flex-1/);
  expect(surface.parentElement?.className ?? '').not.toMatch(/border /);
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Edit `HistoryCardDetailPage.tsx`.** Make the page a column flex of full height: header (auto) + body (`flex-1 min-h-0`). Remove the outer grey wrapper and the inner white card around the surface. The `<HistoryVisualizationSurface>` becomes the direct `flex-1 min-h-0 relative` body holding the active view + the label overlay.

- [ ] **Step 4: Edit `HistoryVisualizationSurface.tsx`** to apply `className="flex-1 min-h-0 relative"` (merge with existing) and keep `data-testid` + `touch-action: none`.

- [ ] **Step 5: Edit `SoilProfileView.tsx`** to drop any extra card nesting so layer rows use full width inside the surface.

- [ ] **Step 6: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx web/react-gui/src/components/history/visualizations/SoilProfileView.tsx web/react-gui/src/components/history/__tests__
git commit -m "feat(history): flatten detail layout so chart fills the body"
```

---

## Slice 3 — Gesture model: two-finger card swipe + contextual one-finger

**Purpose:** Card switch becomes two-finger horizontal; one-finger horizontal is contextual (pan when zoomed / calendar month / else no-op); one-finger vertical stays view mode.

**Files:**
- Modify: `web/react-gui/src/history/gestureModel.ts`
- Modify: `web/react-gui/src/history/useVisualizationGestures.ts`
- Modify: `web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Tests: `web/react-gui/src/components/history/__tests__/HistoryGestureModel.test.ts`, `HistoryVisualizationSurface.test.tsx`

### Task 3.1 — Pure two-finger classification

- [ ] **Step 1: Add tests** to `HistoryGestureModel.test.ts`:

```ts
import { classifyTwoFinger } from '../../../history/gestureModel';

test('two-finger: distance change => pinch; parallel translation => swipe', () => {
  // start finger positions
  const start = [{ x: 100, y: 200 }, { x: 200, y: 200 }];
  // moved apart (distance grows, midpoint ~same) => pinch
  const apart = [{ x: 60, y: 200 }, { x: 240, y: 200 }];
  assert.equal(classifyTwoFinger(start, apart), 'pinch');
  // both shifted left by 120, distance ~same => swipe
  const shifted = [{ x: -20, y: 200 }, { x: 80, y: 200 }];
  assert.equal(classifyTwoFinger(start, shifted), 'swipe');
});
```

- [ ] **Step 2: Run, confirm fail.** `npm run test:unit:vitest -- HistoryGestureModel`.

- [ ] **Step 3: Implement `classifyTwoFinger` in `gestureModel.ts`:**

```ts
const TWO_FINGER_PINCH_RATIO = 0.15; // |Δdistance|/distance to count as pinch
const TWO_FINGER_SWIPE_PX = 30;      // midpoint translation to count as swipe

export function classifyTwoFinger(start: Point[], next: Point[]): 'pinch' | 'swipe' | null {
  if (start.length < 2 || next.length < 2) return null;
  const d0 = distance(start[0], start[1]);
  const d1 = distance(next[0], next[1]);
  const distRatio = d0 > 0 ? Math.abs(d1 - d0) / d0 : 0;
  const m0 = midpoint(start[0], start[1]);
  const m1 = midpoint(next[0], next[1]);
  const midShiftX = Math.abs(m1.x - m0.x);
  if (distRatio >= TWO_FINGER_PINCH_RATIO && distRatio * d0 >= midShiftX) return 'pinch';
  if (midShiftX >= TWO_FINGER_SWIPE_PX) return 'swipe';
  return null;
}
```

- [ ] **Step 4: Run, confirm pass.**

### Task 3.2 — Contextual callback surface on the hook

- [ ] **Step 1: Update `HistoryVisualizationSurface.test.tsx`** to dispatch touch events and assert the new callbacks. Add a helper to build `Touch`-like events for jsdom, and:

```tsx
it('two-finger horizontal => onCardSwipe; one-finger vertical => onViewSwipe', () => {
  const onCardSwipe = vi.fn(); const onViewSwipe = vi.fn();
  render(<HistoryVisualizationSurface viewport={v24h} defaultRange="24h" activeView="line-chart" isZoomed={false}
    onViewportChange={vi.fn()} onCardSwipe={onCardSwipe} onViewSwipe={onViewSwipe} onMonthSwipe={vi.fn()} onInspect={vi.fn()}>
    <div>chart</div></HistoryVisualizationSurface>);
  const s = screen.getByTestId('history-visualization-surface');
  twoFingerSwipe(s, { fromMidX: 300, toMidX: 150 }); // helper
  expect(onCardSwipe).toHaveBeenCalledWith(-1);
  oneFingerSwipe(s, { fromY: 400, toY: 150 });
  expect(onViewSwipe).toHaveBeenCalledWith(-1);
});

it('one-finger horizontal in calendar => onMonthSwipe (inner only)', () => {
  const onMonthSwipe = vi.fn();
  render(<HistoryVisualizationSurface viewport={v24h} defaultRange="24h" activeView="calendar" isZoomed={false}
    onViewportChange={vi.fn()} onCardSwipe={vi.fn()} onViewSwipe={vi.fn()} onMonthSwipe={onMonthSwipe} onInspect={vi.fn()}>
    <div>cal</div></HistoryVisualizationSurface>);
  const s = screen.getByTestId('history-visualization-surface');
  oneFingerSwipe(s, { fromX: 250, toX: 120, startXFromEdge: 60 }); // inner
  expect(onMonthSwipe).toHaveBeenCalledWith(-1);
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Rework `useVisualizationGesturesInput`** in `useVisualizationGestures.ts`. Replace `onSwipe` with:

```ts
interface UseVisualizationGesturesInput {
  viewport: HistoryTimeViewport;
  defaultRange: HistoryRangeLabel;
  activeView: HistoryViewMode;
  isZoomed: boolean;
  onViewportChange: (viewport: HistoryTimeViewport) => void;
  onCardSwipe: (delta: -1 | 1) => void;   // two-finger horizontal
  onViewSwipe: (delta: -1 | 1) => void;   // one-finger vertical
  onMonthSwipe: (delta: -1 | 1) => void;  // one-finger horizontal, calendar, inner
  onInspect?: (selection: InspectSelection) => void;
}
const EDGE_GUTTER_PX = 24;
```

Touch handling:
- **2 touches:** track start positions; on move use `classifyTwoFinger(start, next)` → `'pinch'` drives zoom (Slice 4), `'swipe'` (on end, by midpoint sign) calls `onCardSwipe(midShiftX < 0 ? -1 : 1)`.
- **1 touch on end:** `swipeDirection({dx,dy})`:
  - `vertical` → `onViewSwipe(dy < 0 ? -1 : 1)`.
  - `horizontal` → if `activeView === 'calendar'` and the touch started ≥ `EDGE_GUTTER_PX` from both edges → `onMonthSwipe(dx < 0 ? -1 : 1)`; else if `isZoomed` → pan (already handled live via `applyDragPan`); else no-op.
- Long-press / double-tap unchanged.

- [ ] **Step 4: Update `HistoryVisualizationSurface.tsx`** to accept and forward `activeView`, `isZoomed`, `onCardSwipe`, `onViewSwipe`, `onMonthSwipe`.

- [ ] **Step 5: Update `HistoryCardDetailPage.tsx`.** Replace `handleVisualizationSwipe` with three handlers:
  - `onCardSwipe(delta)` → reuse the existing card prev/next nav logic (the body of the old horizontal branch).
  - `onViewSwipe(delta)` → reuse the existing view prev/next logic (old vertical branch).
  - `onMonthSwipe(delta)` → Slice 5.
  Pass `activeView={selectedView}` and `isZoomed={viewport.range.label === 'custom'}`. Remove the separate `cardSwipeStartRef` pointer-based card swipe (now handled by two-finger in the surface) — keep pull-refresh.

- [ ] **Step 6: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/history/gestureModel.ts web/react-gui/src/history/useVisualizationGestures.ts web/react-gui/src/components/history/mobile/HistoryVisualizationSurface.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/__tests__
git commit -m "feat(history): two-finger card swipe and contextual one-finger gestures"
```

---

## Slice 4 — Fluid, location-aware pinch

**Purpose:** Pinch updates the window continuously via `requestAnimationFrame`, anchored at the finger-midpoint timestamp.

**Files:**
- Modify: `web/react-gui/src/history/gestureModel.ts` (anchor already present — verify)
- Modify: `web/react-gui/src/history/useVisualizationGestures.ts`
- Test: `web/react-gui/src/components/history/__tests__/HistoryGestureModel.test.ts`

### Task 4.1 — Anchored zoom math

- [ ] **Step 1: Add a test** that zooming keeps the anchor timestamp fixed:

```ts
import { applyPinchZoom, anchorRatioForPoint } from '../../../history/gestureModel';
test('pinch keeps the anchor timestamp under the fingers', () => {
  const v = { range: { label: '7d', from: '2026-06-01T00:00:00Z', to: '2026-06-08T00:00:00Z' }, aggregation: 'auto' } as any;
  const anchorRatio = 0.0; // Monday = start
  const zoomed = applyPinchZoom(v, { previousDistancePx: 80, nextDistancePx: 240, anchorRatio }); // apart => narrower
  // Monday (the from edge) should still be at/near the from edge
  assert.equal(zoomed.range.from, '2026-06-01T00:00:00Z');
  assert.ok(Date.parse(zoomed.range.to) - Date.parse(zoomed.range.from) < 7 * 86400000);
});
```

- [ ] **Step 2: Run, confirm fail/pass.** If the existing `applyPinchZoom` already anchors correctly the test passes — keep it; if not, fix `applyPinchZoom` so the timestamp at `anchorRatio` is invariant under scaling (scale `from`/`to` around the anchor timestamp).

### Task 4.2 — rAF live update in the hook

- [ ] **Step 1: Add a hook-level test** in `HistoryVisualizationSurface.test.tsx` that multiple pinch `touchmove`s within one frame coalesce to a single `onViewportChange` per frame. Mock `requestAnimationFrame` to a controllable queue and assert one call per flushed frame.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Edit `useVisualizationGestures.ts`.** During a two-finger pinch, on each `touchmove` compute the next viewport (anchored at current finger midpoint ratio) but store it in a ref and schedule a single `requestAnimationFrame` that calls `onViewportChange(pendingViewport)` and clears the handle. Cancel the rAF on `touchend`/unmount. This makes the chart track fingers live instead of jumping on release.

- [ ] **Step 4: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/history/gestureModel.ts web/react-gui/src/history/useVisualizationGestures.ts web/react-gui/src/components/history/__tests__
git commit -m "feat(history): fluid location-aware pinch via requestAnimationFrame"
```

---

## Slice 5 — Calendar month paging

**Purpose:** Inner one-finger horizontal swipe changes the visible month in calendar view.

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`

### Task 5.1 — Month state + data range

- [ ] **Step 1: Write the test** that `onMonthSwipe(-1)` moves the calendar to the previous month and refetches:

```tsx
it('month swipe changes the visible month', async () => {
  renderDetailRoute({ card: soilCard, initialView: 'calendar' });
  expect(await screen.findByText(/June 2026/i)).toBeInTheDocument();
  act(() => fireMonthSwipe(-1)); // helper that calls the surface's onMonthSwipe
  expect(await screen.findByText(/May 2026/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Add `monthOffset` state in `HistoryCardDetailPage.tsx`** (default 0). `onMonthSwipe(delta)` adjusts it (`-1`/`+1`). Derive the calendar fetch range (`from`/`to`) from the current month + offset and pass it to the calendar data request. Pass the computed month label to the calendar view.

- [ ] **Step 4: Edit `HistoryMonthCalendarView.tsx`** to render the passed month label/grid for the offset month (it already renders a month grid; ensure it uses the provided month rather than always "now").

- [ ] **Step 5: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/__tests__
git commit -m "feat(history): calendar month paging via inner swipe"
```

---

## Slice 6 — Landscape layout

**Purpose:** Thin persistent header; chart uses the wide aspect; no page scroll in either orientation.

**Files:**
- Create: `web/react-gui/src/history/useOrientation.ts`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Modify: `web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx`
- Test: `web/react-gui/src/history/__tests__` or `web/react-gui/tests/useOrientation.test.ts`

### Task 6.1 — Orientation hook

- [ ] **Step 1: Write the test** `web/react-gui/tests/useOrientation.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { orientationFromQuery } from '../src/history/useOrientation';
test('maps matchMedia result to orientation', () => {
  assert.equal(orientationFromQuery(true), 'landscape');
  assert.equal(orientationFromQuery(false), 'portrait');
});
```

- [ ] **Step 2: Run, confirm fail.** `npx tsx --test tests/useOrientation.test.ts`.

- [ ] **Step 3: Implement `src/history/useOrientation.ts`:**

```ts
import { useEffect, useState } from 'react';
export function orientationFromQuery(isLandscape: boolean): 'landscape' | 'portrait' {
  return isLandscape ? 'landscape' : 'portrait';
}
export function useOrientation(): 'landscape' | 'portrait' {
  const get = () => orientationFromQuery(typeof window !== 'undefined' && window.matchMedia?.('(orientation: landscape)').matches);
  const [o, setO] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)');
    const on = () => setO(orientationFromQuery(mq.matches));
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return o;
}
```

- [ ] **Step 4: Run, confirm pass.**

### Task 6.2 — Apply landscape layout

- [ ] **Step 1: Edit `HistoryCardDetailPage.tsx`.** Use `useOrientation()`; in landscape, apply a slimmer header (single row, reduced padding) and ensure the column flex still gives the body `flex-1 min-h-0` so the chart fills the wide area without page scroll. No control relocation (decision D = thin persistent header).

- [ ] **Step 2: Edit `HistoryDetailHeader.tsx`** to accept a `compact` boolean prop that reduces padding/height when landscape.

- [ ] **Step 3: Build; commit.** (Visual verification happens in Slice 7.)

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/history/useOrientation.ts web/react-gui/tests/useOrientation.test.ts web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx
git commit -m "feat(history): landscape layout with thin persistent header"
```

---

## Slice 7 — Live verification (automated + manual device loop)

**Purpose:** Confirm the automatable changes on kaba100 and run the manual multi-touch/pinch loop.

**Files:** Modify `docs/ux/history-data-visualization-kaba100-issues.md`.

### Task 7.1 — Build, deploy, automated Playwright pass

- [ ] **Step 1:** `cd web/react-gui && npm run build`; deploy to kaba100 (do not overwrite `/data/db/farming.db`); confirm the served `index-*.js` hash matches `build/assets/`.
- [ ] **Step 2: Playwright (iPhone portrait + landscape, kaba100)** confirm:
  - No "History" or "Back to history" text anywhere in the detail view; header has only title + ⊟ (multi-source) + ⋯.
  - No inline "N sources" subtitle; view-mode label is an in-chart overlay.
  - Visualization fills ~90% of the viewport height; stripped per-chart labels absent.
  - Landscape renders a thin header with a wide chart and no page scroll.
  - Soil layer colours and calendar colours from the prior round still correct.
- [ ] **Step 3: Record results + screenshots** in the kaba100 issues doc.

### Task 7.2 — Manual real-device loop (multi-touch)

- [ ] **Step 1:** Ask the user (Phil) to verify on a real phone: two-finger horizontal = switch card; live, location-aware pinch (pinch into Monday on 7d → ~24h Monday, tracking fingers fluidly); one-finger horizontal pan when zoomed; calendar inner-swipe changes month; screen-edge back-swipe still works.
- [ ] **Step 2:** Iterate thresholds (`TWO_FINGER_PINCH_RATIO`, `TWO_FINGER_SWIPE_PX`, `EDGE_GUTTER_PX`, rAF cadence) on `useVisualizationGestures.ts`/`gestureModel.ts` until the user confirms it feels right. Commit `fix:` per iteration.
- [ ] **Step 3: Record confirmed behaviour; final verification.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs(history): record fullscreen polish verification"
```

---

## Self-review (coverage map)

- Remove back button + inline sources + "History" text (spec A) → Task 1.1.
- View label overlay (spec B) → Task 1.2 · strip per-chart labels (spec B) → Task 1.3 · ~90% chart (spec B) → Slice 2.
- Two-finger card swipe (spec C) → Task 3.1/3.2 · contextual one-finger + edge gutter (spec C) → Task 3.2 · vertical view mode (spec C) → Task 3.2.
- Live location-aware pinch (spec E) → Slice 4.
- Calendar month paging (spec C/§3.5) → Slice 5.
- Landscape thin persistent header (spec D) → Slice 6.
- Verification incl. manual loop (spec §6) → Slice 7.

## Acceptance criteria

- No "History"/"Back to history"/inline-sources text in the detail view; header = title + ⊟ (multi) + ⋯; browser back works.
- Chart occupies ~90% of the screen; per-chart labels removed; view label is a small overlay.
- Two-finger horizontal switches card; one-finger vertical changes view; one-finger horizontal pans when zoomed and changes month (inner swipe) in calendar; edges preserved for browser back.
- Pinch tracks fingers live and is location-aware (anchored at finger midpoint).
- Landscape shows a thin persistent header with a wide chart and no page scroll.
- `npm run test:unit` + `npm run build` green; manual device loop confirmed by the user.
