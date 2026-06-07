# History Desktop Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mouse-native desktop history experience to both `osi-os` and `osi-server`: scroll-to-zoom (anchored at cursor), drag-to-pan, hover crosshair, an overview/brush strip, range presets, and an ad-hoc Compare view — built on one shared interaction contract so the two repos behave identically.

**Architecture:** A framework-agnostic, DOM-free **viewport reducer** (`{fromMs,toMs}` + `zoomAt`/`pan`/`reset`/`setRange`) plus a thin **pointer adapter** hook that maps wheel/drag/hover/dblclick to reducer actions. The adapter sits *beside* osi-os's existing touch surface (mobile untouched). Recharts stays for rendering; a custom `HistoryOverviewStrip` provides the full-range brush. Layout is **focused single-card** (left rail → zone/card) with a **Compare** toggle that swaps the chart for a 2–4 card grid sharing one time window (no persistence). The same three shared modules are created identically in both repos.

**Tech Stack:** Vite + React 18 + TypeScript, Recharts, Vitest + Testing Library. Repos: `/home/phil/Repos/osi-os` (`web/react-gui`) and `/home/phil/Repos/osi-server` (`frontend`), both branch `feat/history-data-visualization`.

**Decisions locked in brainstorming:** layout C (focused + ad-hoc Compare); interaction A (drag = pan); zoom = wheel anchored at cursor, time axis only; double-click resets; keyboard/`+`/`−` fallback; honor `prefers-reduced-motion`. Non-goals: saved workspaces / cross-zone comparison; new charting library; backend changes.

---

## Phase 1 — Shared interaction core (osi-os first)

### Task B1: Viewport reducer

**Files:**
- Create: `web/react-gui/src/history/historyViewport.ts`
- Test: `web/react-gui/src/history/__tests__/historyViewport.test.ts`

- [ ] **Step 1: Write the failing tests.**

Create `web/react-gui/src/history/__tests__/historyViewport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { panViewport, resetViewport, zoomViewport, MIN_SPAN_MS } from '../historyViewport';

const bounds = { minMs: 0, maxMs: 1_000_000 };

describe('historyViewport', () => {
  it('zooms in around the anchor, keeping the anchor at the same relative position', () => {
    const vp = { fromMs: 0, toMs: 1_000_000 };
    const next = zoomViewport(vp, bounds, 250_000, 0.5); // anchor at 25%
    expect(next.toMs - next.fromMs).toBeCloseTo(500_000, -1);
    const rel = (250_000 - next.fromMs) / (next.toMs - next.fromMs);
    expect(rel).toBeCloseTo(0.25, 5);
  });

  it('clamps zoom-out to bounds', () => {
    const vp = { fromMs: 100_000, toMs: 200_000 };
    const next = zoomViewport(vp, bounds, 150_000, 100); // huge zoom-out
    expect(next.fromMs).toBe(0);
    expect(next.toMs).toBe(1_000_000);
  });

  it('does not zoom below MIN_SPAN_MS', () => {
    const vp = { fromMs: 0, toMs: MIN_SPAN_MS * 2 };
    const next = zoomViewport(vp, bounds, 0, 0.0001);
    expect(next.toMs - next.fromMs).toBeGreaterThanOrEqual(MIN_SPAN_MS);
  });

  it('pans and clamps at the left bound', () => {
    const vp = { fromMs: 100_000, toMs: 200_000 };
    const next = panViewport(vp, bounds, -500_000);
    expect(next.fromMs).toBe(0);
    expect(next.toMs).toBe(100_000);
  });

  it('reset returns the default range clamped to bounds', () => {
    expect(resetViewport(bounds, 300_000)).toEqual({ fromMs: 700_000, toMs: 1_000_000 });
  });
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/historyViewport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reducer.**

Create `web/react-gui/src/history/historyViewport.ts`:

```ts
export interface HistoryViewport { fromMs: number; toMs: number }
export interface ViewportBounds { minMs: number; maxMs: number }

export const MIN_SPAN_MS = 5 * 60 * 1000; // 5 minutes

function clampSpanToBounds(from: number, to: number, bounds: ViewportBounds): HistoryViewport {
  let span = Math.min(Math.max(to - from, MIN_SPAN_MS), bounds.maxMs - bounds.minMs);
  let nextFrom = from;
  let nextTo = from + span;
  if (nextFrom < bounds.minMs) { nextFrom = bounds.minMs; nextTo = nextFrom + span; }
  if (nextTo > bounds.maxMs) { nextTo = bounds.maxMs; nextFrom = nextTo - span; }
  if (nextFrom < bounds.minMs) nextFrom = bounds.minMs;
  return { fromMs: nextFrom, toMs: nextTo };
}

export function zoomViewport(vp: HistoryViewport, bounds: ViewportBounds, anchorMs: number, factor: number): HistoryViewport {
  const span = vp.toMs - vp.fromMs;
  const anchor = Math.min(Math.max(anchorMs, vp.fromMs), vp.toMs);
  const rel = span > 0 ? (anchor - vp.fromMs) / span : 0.5;
  const maxSpan = bounds.maxMs - bounds.minMs;
  const nextSpan = Math.min(Math.max(span * factor, MIN_SPAN_MS), maxSpan);
  const nextFrom = anchor - rel * nextSpan;
  return clampSpanToBounds(nextFrom, nextFrom + nextSpan, bounds);
}

export function panViewport(vp: HistoryViewport, bounds: ViewportBounds, deltaMs: number): HistoryViewport {
  return clampSpanToBounds(vp.fromMs + deltaMs, vp.toMs + deltaMs, bounds);
}

export function resetViewport(bounds: ViewportBounds, defaultSpanMs: number): HistoryViewport {
  const span = Math.min(Math.max(defaultSpanMs, MIN_SPAN_MS), bounds.maxMs - bounds.minMs);
  return { fromMs: bounds.maxMs - span, toMs: bounds.maxMs };
}
```

- [ ] **Step 4: Run the tests.**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/historyViewport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/history/historyViewport.ts web/react-gui/src/history/__tests__/historyViewport.test.ts
git commit -m "feat(history): add shared viewport reducer for desktop zoom/pan"
```

---

### Task B2: Mouse interaction hook

**Files:**
- Create: `web/react-gui/src/history/useChartMouseInteractions.ts`
- Test: `web/react-gui/src/history/__tests__/useChartMouseInteractions.test.ts`

- [ ] **Step 1: Write a failing logic test (pure mapping, no DOM render).**

Create `web/react-gui/src/history/__tests__/useChartMouseInteractions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pixelToTime, wheelZoomFactor } from '../useChartMouseInteractions';

describe('chart mouse mapping', () => {
  it('maps a pixel x within the plot to a timestamp in the viewport', () => {
    const t = pixelToTime({ left: 100, width: 400 }, { fromMs: 0, toMs: 1000 }, 300); // 50% across
    expect(t).toBeCloseTo(500, 5);
  });
  it('wheel up (negative deltaY) zooms in (factor < 1)', () => {
    expect(wheelZoomFactor(-100)).toBeLessThan(1);
    expect(wheelZoomFactor(100)).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/useChartMouseInteractions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook + pure helpers.**

Create `web/react-gui/src/history/useChartMouseInteractions.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { panViewport, zoomViewport, type HistoryViewport, type ViewportBounds } from './historyViewport';

export function pixelToTime(rect: { left: number; width: number }, vp: HistoryViewport, clientX: number): number {
  if (rect.width <= 0) return vp.fromMs;
  const rel = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  return vp.fromMs + rel * (vp.toMs - vp.fromMs);
}

export function wheelZoomFactor(deltaY: number): number {
  // deltaY < 0 (wheel up) → zoom in; clamp per-notch to a gentle step
  const step = Math.min(Math.max(deltaY / 1000, -0.2), 0.2);
  return 1 + step; // <1 when deltaY<0
}

export interface ChartMouseOptions {
  viewport: HistoryViewport;
  bounds: ViewportBounds;
  onViewportChange: (vp: HistoryViewport) => void;
  onReset: () => void;
}

export function useChartMouseInteractions({ viewport, bounds, onViewportChange, onReset }: ChartMouseOptions) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startVp: HistoryViewport } | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef<HistoryViewport | null>(null);

  const commit = useCallback((vp: HistoryViewport) => {
    pending.current = vp;
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) onViewportChange(pending.current);
    });
  }, [onViewportChange]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = pixelToTime(rect, viewport, e.clientX);
      commit(zoomViewport(viewport, bounds, anchor, wheelZoomFactor(e.deltaY)));
    };
    const onDown = (e: MouseEvent) => { dragRef.current = { startX: e.clientX, startVp: viewport }; };
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      setHoverMs(pixelToTime(rect, viewport, e.clientX));
      const drag = dragRef.current;
      if (!drag) return;
      const span = drag.startVp.toMs - drag.startVp.fromMs;
      const deltaMs = -((e.clientX - drag.startX) / rect.width) * span;
      commit(panViewport(drag.startVp, bounds, deltaMs));
    };
    const onUp = () => { dragRef.current = null; };
    const onLeave = () => { setHoverMs(null); dragRef.current = null; };
    const onDouble = () => onReset();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('dblclick', onDouble);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('dblclick', onDouble);
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [viewport, bounds, commit, onReset]);

  return { ref, hoverMs };
}
```

- [ ] **Step 4: Run the test.**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/useChartMouseInteractions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add web/react-gui/src/history/useChartMouseInteractions.ts web/react-gui/src/history/__tests__/useChartMouseInteractions.test.ts
git commit -m "feat(history): add mouse interaction hook for desktop charts"
```

---

### Task B3: Overview/brush strip

**Files:**
- Create: `web/react-gui/src/components/history/desktop/HistoryOverviewStrip.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryOverviewStrip.test.tsx`

- [ ] **Step 1: Write the failing test.**

Create the test:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HistoryOverviewStrip } from '../desktop/HistoryOverviewStrip';

describe('HistoryOverviewStrip', () => {
  it('renders a draggable window and reports a new viewport on click-drag', () => {
    const onChange = vi.fn();
    render(
      <HistoryOverviewStrip
        bounds={{ minMs: 0, maxMs: 1000 }}
        viewport={{ fromMs: 400, toMs: 600 }}
        onChange={onChange}
      />,
    );
    const window = screen.getByTestId('overview-window');
    expect(window).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryOverviewStrip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the strip.**

Create `web/react-gui/src/components/history/desktop/HistoryOverviewStrip.tsx`:

```tsx
import React from 'react';
import type { HistoryViewport, ViewportBounds } from '../../../history/historyViewport';
import { panViewport } from '../../../history/historyViewport';

interface Props {
  bounds: ViewportBounds;
  viewport: HistoryViewport;
  onChange: (vp: HistoryViewport) => void;
}

export const HistoryOverviewStrip: React.FC<Props> = ({ bounds, viewport, onChange }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const total = Math.max(bounds.maxMs - bounds.minMs, 1);
  const leftPct = ((viewport.fromMs - bounds.minMs) / total) * 100;
  const widthPct = ((viewport.toMs - viewport.fromMs) / total) * 100;
  const drag = React.useRef<{ startX: number; startVp: HistoryViewport } | null>(null);

  const onMove = React.useCallback((e: MouseEvent) => {
    const el = ref.current; const d = drag.current;
    if (!el || !d) return;
    const rect = el.getBoundingClientRect();
    const deltaMs = ((e.clientX - d.startX) / rect.width) * total;
    onChange(panViewport(d.startVp, bounds, deltaMs));
  }, [bounds, onChange, total]);

  React.useEffect(() => {
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', up); };
  }, [onMove]);

  return (
    <div ref={ref} className="relative mt-2 h-9 rounded-md border border-[var(--border)] bg-[var(--bg)]" role="group" aria-label="Time range overview">
      <div
        data-testid="overview-window"
        onMouseDown={(e) => { drag.current = { startX: e.clientX, startVp: viewport }; }}
        className="absolute top-0 bottom-0 cursor-grab bg-[var(--accent,#3b82f6)]/20 border-x-2 border-[var(--accent,#3b82f6)]"
        style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 2)}%` }}
      />
    </div>
  );
};
```

- [ ] **Step 4: Run the test.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryOverviewStrip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add web/react-gui/src/components/history/desktop/HistoryOverviewStrip.tsx web/react-gui/src/components/history/__tests__/HistoryOverviewStrip.test.tsx
git commit -m "feat(history): add desktop overview brush strip"
```

---

## Phase 2 — osi-os desktop integration

### Task B4: Desktop detection hook

**Files:**
- Create: `web/react-gui/src/history/useIsDesktop.ts`
- Test: `web/react-gui/src/history/__tests__/useIsDesktop.test.tsx`

- [ ] **Step 1: Write the failing test.**

```tsx
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_MIN_WIDTH, useIsDesktop } from '../useIsDesktop';

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
  }));
}

describe('useIsDesktop', () => {
  it('is true at/above the desktop breakpoint', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useIsDesktop());
    expect(result.current).toBe(true);
    expect(DESKTOP_MIN_WIDTH).toBe(1024);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/useIsDesktop.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook.**

Create `web/react-gui/src/history/useIsDesktop.ts`:

```ts
import { useEffect, useState } from 'react';

export const DESKTOP_MIN_WIDTH = 1024;

export function useIsDesktop(): boolean {
  const query = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setIsDesktop(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return isDesktop;
}
```

- [ ] **Step 4: Run the test.**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/useIsDesktop.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add web/react-gui/src/history/useIsDesktop.ts web/react-gui/src/history/__tests__/useIsDesktop.test.tsx
git commit -m "feat(history): add desktop breakpoint hook"
```

---

### Task B5: Desktop detail surface (rail + interactive chart)

**Files:**
- Create: `web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx`

- [ ] **Step 1: Read the current detail page to find the data + viewport plumbing.**

Open `web/react-gui/src/pages/HistoryCardDetailPage.tsx`. Identify: the `useHistoryCardData` call, the resolved card list for the zone, the current touch viewport state, and the `selectedView`/range-preset handlers. The desktop surface reuses these; it must not remove the mobile gesture path.

- [ ] **Step 2: Write a failing test for the desktop detail.**

Create `HistoryDesktopDetail.test.tsx` asserting that: (a) the zone/card rail renders the provided cards with display-safe titles (no 16-hex DevEUI); (b) a chart container with `data-testid="desktop-chart-surface"` is present; (c) `+`/`−` zoom buttons and a reset button render. Mock `useHistoryCardData` to return a small fixture.

- [ ] **Step 3: Run it and watch it fail.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryDesktopDetail.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `HistoryDesktopDetail`.**

Compose: a left `<nav>` rail listing the zone's thematic cards (reuse the existing display-safe title/source helpers from the detail page), a header reading `${card.title} ${zoneName}` (reuse the `detailCardTitle` helper added in the loading-polish work), a `data-testid="desktop-chart-surface"` div whose `ref` comes from `useChartMouseInteractions`, the existing `HistoryCardFrame` visualization rendered inside it with the `window={{fromMs,toMs}}` viewport, `HistoryOverviewStrip` below it, range-preset buttons (24h/7D/30D/Season) calling `setRange`, and `+`/`−`/reset buttons calling `zoomViewport(..., 0.8)` / `zoomViewport(..., 1.25)` / `onReset`. Derive `bounds` from the loaded series min/max timestamps (fallback to the preset range). Respect `prefers-reduced-motion` by skipping the rAF coalescing when `window.matchMedia('(prefers-reduced-motion: reduce)').matches`.

- [ ] **Step 5: Gate the detail page on the breakpoint.**

In `HistoryCardDetailPage.tsx`, call `const isDesktop = useIsDesktop();` and render `<HistoryDesktopDetail .../>` when `isDesktop`, else the existing mobile gesture surface. Pass the shared card-data, viewport state, and handlers to both. The mobile branch is unchanged.

- [ ] **Step 6: Run tests.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryDesktopDetail.test.tsx src/components/history/__tests__/HistoryCardDetailPage.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx
git commit -m "feat(history): desktop detail surface with mouse zoom/pan"
```

---

### Task B6: Keyboard + accessibility controls

**Files:**
- Modify: `web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx`

- [ ] **Step 1: Add a failing test.**

Assert that pressing `ArrowRight` on the focused chart surface calls the viewport-change handler with a later `fromMs` (pan right), and `+`/`-` keys change the span. Use `fireEvent.keyDown(surface, { key: 'ArrowRight' })`.

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryDesktopDetail.test.tsx -t "keyboard"`
Expected: FAIL.

- [ ] **Step 3: Implement keyboard handling.**

Give the chart surface `tabIndex={0}` and an `onKeyDown` mapping: `ArrowLeft`/`ArrowRight` → `panViewport(vp, bounds, ∓span*0.1)`; `+`/`=` → `zoomViewport(vp, bounds, center, 0.8)`; `-` → `zoomViewport(vp, bounds, center, 1.25)`; `0` → `onReset()`, where `center = (vp.fromMs+vp.toMs)/2`. Add `aria-label="History chart, use arrow keys to pan and plus or minus to zoom"`.

- [ ] **Step 4: Run tests.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryDesktopDetail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx web/react-gui/src/components/history/__tests__/HistoryDesktopDetail.test.tsx
git commit -m "feat(history): keyboard zoom/pan fallback for desktop chart"
```

---

### Task B7: Compare toggle (ad-hoc grid)

**Files:**
- Create: `web/react-gui/src/components/history/desktop/HistoryCompareGrid.tsx`
- Modify: `web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryCompareGrid.test.tsx`

- [ ] **Step 1: Write a failing test.**

Assert: a `Compare` button toggles a grid; selecting 2 cards renders 2 `HistoryCardFrame` panels; all panels receive the same `window` viewport prop; no persistence call is made (no workspace API import).

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryCompareGrid.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `HistoryCompareGrid`.**

Render a responsive 1–2 column grid of up to 4 selected zone cards, each an existing `HistoryCardFrame` in its default view, all passed the shared `{fromMs,toMs}` viewport and shared range presets. A checklist (max 4) selects which zone cards appear. State is local component state only — no workspace persistence.

- [ ] **Step 4: Wire the toggle into `HistoryDesktopDetail`.**

Add a `Focus | Compare` segmented control. `Focus` shows the single chart surface (Task B5); `Compare` shows `HistoryCompareGrid`. The viewport/range state is shared so toggling preserves the window.

- [ ] **Step 5: Run tests.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryCompareGrid.test.tsx src/components/history/__tests__/HistoryDesktopDetail.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add web/react-gui/src/components/history/desktop/HistoryCompareGrid.tsx web/react-gui/src/components/history/desktop/HistoryDesktopDetail.tsx web/react-gui/src/components/history/__tests__/HistoryCompareGrid.test.tsx
git commit -m "feat(history): ad-hoc compare grid for desktop"
```

---

### Task B8: osi-os full verification + live check

- [ ] **Step 1: Run the full unit suite and build.**

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
npm run build
```

Expected: all pass.

- [ ] **Step 2: Mobile regression guard.**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryCardDetailPage.test.tsx`
Expected: PASS — existing mobile-gesture tests unchanged.

- [ ] **Step 3: Live desktop check on kaba100.**

Deploy GUI-only to kaba100 (do not overwrite `/data/db/farming.db`), open the history detail in a desktop-width browser, and verify: wheel zooms around the cursor, drag pans, hover shows a crosshair/tooltip, the overview window drags, double-click resets, presets work, `+`/`−`/keyboard work, and the Compare toggle shows a synced grid. On a phone width, the existing gesture UI still loads.

- [ ] **Step 4: Record the verification.**

Append a dated desktop-mode verification block to `docs/ux/history-data-visualization-kaba100-issues.md` (served asset hash, deployed commit, pass/fail per interaction).

```bash
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs(history): record desktop mode verification"
```

---

## Phase 3 — osi-server desktop integration

> The three shared modules are created **identically** to the osi-os versions (Tasks B1-B3), under `frontend/src/...`. Imports/paths differ only by repo root.

### Task B9: Port shared core to osi-server

**Files:**
- Create: `frontend/src/history/historyViewport.ts` (identical content to Task B1 Step 3)
- Create: `frontend/src/history/__tests__/historyViewport.test.ts` (identical to Task B1 Step 1)
- Create: `frontend/src/history/useChartMouseInteractions.ts` (identical to Task B2 Step 3)
- Create: `frontend/src/history/__tests__/useChartMouseInteractions.test.ts` (identical to Task B2 Step 1)
- Create: `frontend/src/components/history/desktop/HistoryOverviewStrip.tsx` (identical to Task B3 Step 3, fix the relative import depth: `../../../history/historyViewport`)
- Create: `frontend/src/components/history/__tests__/HistoryOverviewStrip.test.tsx` (identical to Task B3 Step 1)
- Create: `frontend/src/history/useIsDesktop.ts` (identical to Task B4 Step 3)

- [ ] **Step 1: Create the files with identical content.** Copy each module verbatim from the osi-os equivalents above, adjusting only relative import paths to the osi-server tree.

- [ ] **Step 2: Run the ported unit tests.**

Run: `cd /home/phil/Repos/osi-server/frontend && npx vitest run src/history/__tests__/historyViewport.test.ts src/history/__tests__/useChartMouseInteractions.test.ts src/components/history/__tests__/HistoryOverviewStrip.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
cd /home/phil/Repos/osi-server
git add frontend/src/history/historyViewport.ts frontend/src/history/useChartMouseInteractions.ts frontend/src/history/useIsDesktop.ts frontend/src/components/history/desktop/HistoryOverviewStrip.tsx frontend/src/history/__tests__ frontend/src/components/history/__tests__/HistoryOverviewStrip.test.tsx
git commit -m "feat(history): port shared desktop interaction core to cloud"
```

---

### Task B10: Refactor `HistoryDesktopShell` to focused + Compare

**Files:**
- Modify: `frontend/src/components/history/HistoryDesktopShell.tsx`
- Modify: `frontend/src/components/history/TimelineBrush.tsx` (reuse or replace — see Step 1)
- Test: `frontend/src/components/history/__tests__/HistoryShell.test.tsx`

- [ ] **Step 1: Read the current desktop shell and brush.**

Open `HistoryDesktopShell.tsx` (~494 lines) and `TimelineBrush.tsx` (~115 lines). Decide: reuse `TimelineBrush` as the overview strip if its prop contract already reports a `{from,to}` window, otherwise replace its usage with `HistoryOverviewStrip`. Record the choice in the commit message. Identify where the selected card's chart (`HistoryCardFrame`) is rendered and where the sidebar lists zones/cards.

- [ ] **Step 2: Add a failing test for the interactive chart surface.**

In `HistoryShell.test.tsx`, assert the desktop shell renders a `data-testid="desktop-chart-surface"` element and `+`/`−`/reset controls, and that the existing sidebar still lists zone cards.

- [ ] **Step 3: Run it and watch it fail.**

Run: `cd frontend && npx vitest run src/components/history/__tests__/HistoryShell.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Wire the mouse surface into the shell.**

Wrap the selected card's `HistoryCardFrame` in a `ref`'d `data-testid="desktop-chart-surface"` div driven by `useChartMouseInteractions`, pass the shared `{fromMs,toMs}` viewport to the frame, render `HistoryOverviewStrip` (or the reused `TimelineBrush`) beneath it, and add `+`/`−`/reset + keyboard handling (mirror Task B5/B6). Keep the existing sidebar; drop or hide the saved-workspaces controls only if they conflict with the focused model (otherwise leave them — out of scope to remove).

- [ ] **Step 5: Add the Compare toggle.**

Add a `Focus | Compare` control. Reuse the osi-os `HistoryCompareGrid` design: create `frontend/src/components/history/desktop/HistoryCompareGrid.tsx` (same structure as Task B7, server imports) rendering up to 4 `HistoryCardFrame` panels sharing the viewport, no persistence.

- [ ] **Step 6: Run tests.**

Run: `cd frontend && npx vitest run src/components/history`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add frontend/src/components/history/HistoryDesktopShell.tsx frontend/src/components/history/TimelineBrush.tsx frontend/src/components/history/desktop/HistoryCompareGrid.tsx frontend/src/components/history/__tests__/HistoryShell.test.tsx
git commit -m "feat(history): focused+compare desktop shell with mouse zoom/pan"
```

---

### Task B11: osi-server verification

- [ ] **Step 1: Frontend suite + build.**

Run:

```bash
cd /home/phil/Repos/osi-server/frontend
npx vitest run
npm run build
```

Expected: all pass.

- [ ] **Step 2: Backend regression guard (no change expected).**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests 'org.osi.server.history.*'
```

Expected: PASS.

- [ ] **Step 3: Commit any doc updates.** (No backend change expected.)

---

## Self-Review notes (already applied)

- **Spec coverage:** scroll-zoom anchored (B1 `zoomViewport` + B2 `pixelToTime`/`wheelZoomFactor`), drag-pan (B1 `panViewport` + B2 drag), crosshair/hover (B2 `hoverMs`), overview strip (B3), double-click reset (B2 `onDouble`→`onReset`, B1 `resetViewport`), presets kept (B5/B10), keyboard + `+`/`−` fallback (B6), `prefers-reduced-motion` (B5), focused+Compare layout (B5/B7/B10), both repos (Phase 2 osi-os, Phase 3 osi-server), mobile untouched (B5 Step 5, B8 Step 2).
- **Type consistency:** `HistoryViewport`/`ViewportBounds` names and `zoomViewport(vp,bounds,anchorMs,factor)` / `panViewport(vp,bounds,deltaMs)` / `resetViewport(bounds,defaultSpanMs)` signatures are identical everywhere they are used. `data-testid="desktop-chart-surface"` is the single shared hook point across B5, B6, and B10.
- **No new charting library; no backend code changes; no workspace persistence** — all enforced by task scope.
- **Discovery steps** are explicitly flagged where osi-os and osi-server components diverge (B5 Step 1, B10 Step 1) because exact line numbers differ between the repos.
- **osi-os profile parity:** this plan touches only `web/react-gui` and `frontend` (no `conf/.../files/`), so `verify-profile-parity.js` is not implicated.
