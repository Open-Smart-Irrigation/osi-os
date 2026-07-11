# Mobile History Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 7 bugs and visual-polish issues found in the 2026-07-11 live mobile review of the kaba100 History UI (calendar touch hijack, stuck tooltips, missing i18n keys, dendro line-chart scales, calendar future handling, invisible reboot button, chart label collisions).

**Architecture:** Almost entirely frontend (`web/react-gui`), one small backend slice (the `data-coverage-gap` interpretation rule in `osi-history-helper` + its `flows.json` caller, mirrored across both Pi profiles). Each fix is an independent task with its own tests. The final task is a live re-verification pass on kaba100 using the same Playwright CDP-touch driver as the review.

**Tech Stack:** React 18 + TypeScript + Recharts + Tailwind (vite build), vitest + @testing-library/react, Node-RED function nodes calling `osi-history-helper` (plain Node, tested via `scripts/test-history-helper.js`).

**Findings evidence:** review screenshots in `/home/phil/playwright-osi/screenshots-mobile-gesture-review-2026-07-11/`; gesture driver scripts in `/home/phil/playwright-osi/mobile-gesture-suite/`.

## Global Constraints

- **NEVER overwrite or reseed `/data/db/farming.db` on kaba100** (AGENTS.md live-deploy safety rules). Task 13's deploy uses the guarded `deploy.sh` flow / static GUI tar only.
- Any edit to `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` or `.../osi-history-helper/index.js` **must be mirrored** to `conf/full_raspberrypi_bcm2709/files/usr/share/...`, followed by `node scripts/verify-profile-parity.js` (22 checks must pass).
- Before editing `flows.json`, load the `osi-flows-json-editing` skill. Before Task 13 (live Pi work), load the `osi-live-ops-runbook` skill.
- Frontend tests: `cd web/react-gui && npx vitest run <path>`. Full suite before the final commit of each frontend task: `cd web/react-gui && npm run test:unit:vitest`.
- Locale files: all 7 locales must be updated together: `de-CH`, `en`, `es`, `fr`, `it`, `lg`, `pt` under `web/react-gui/public/locales/`.
- Work on a feature branch off the current checkout: `git checkout -b fix/mobile-history-review-2026-07-11`.
- Commit after every task (conventional commits, `fix(gui): ...` / `fix(history-api): ...`).

---

### Task 1: Add missing i18n keys + locale-coverage regression test

The header export button renders the raw key `history.export.open` on every card detail page; the export sheet title renders `history.export.title`. `history.desktop.railLabel` is also missing. Only the test mock defines them, so tests pass while the live UI shows raw keys.

**Files:**
- Modify: `web/react-gui/public/locales/en/history.json`
- Modify: `web/react-gui/public/locales/de-CH/history.json`
- Modify: `web/react-gui/public/locales/es/history.json`
- Modify: `web/react-gui/public/locales/fr/history.json`
- Modify: `web/react-gui/public/locales/it/history.json`
- Modify: `web/react-gui/public/locales/lg/history.json`
- Modify: `web/react-gui/public/locales/pt/history.json`
- Test: `web/react-gui/src/history/__tests__/historyLocaleKeys.test.ts` (create)

**Interfaces:**
- Produces: locale keys `history.export.open`, `history.export.title`, `history.desktop.railLabel` in every locale; a regression test that fails whenever a literal `t('history.…')` key used in `src/` is missing from `en/history.json`.

- [ ] **Step 1: Write the failing regression test**

Create `web/react-gui/src/history/__tests__/historyLocaleKeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const GUI_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(GUI_ROOT, 'src');
const LOCALES_ROOT = path.join(GUI_ROOT, 'public/locales');
const LOCALES = ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt'];
const NEW_KEYS = ['history.export.open', 'history.export.title', 'history.desktop.railLabel'];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function usedHistoryKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/t\(\s*['"`](history\.[a-zA-Z0-9_.]+)['"`]/g)) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function localeKeys(locale: string): Set<string> {
  const file = path.join(LOCALES_ROOT, locale, 'history.json');
  return new Set(flattenKeys(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

describe('history locale key coverage', () => {
  it('defines every literal history.* key used in src in the en locale', () => {
    const defined = localeKeys('en');
    const missing = usedHistoryKeys().filter((key) => !defined.has(key));
    expect(missing).toEqual([]);
  });

  it('defines the export/rail keys in every locale', () => {
    for (const locale of LOCALES) {
      const defined = localeKeys(locale);
      const missing = NEW_KEYS.filter((key) => !defined.has(key));
      expect(missing, `locale ${locale}`).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/historyLocaleKeys.test.ts`
Expected: FAIL — first test lists `history.desktop.railLabel`, `history.export.open`, `history.export.title` as missing; second test fails for every locale.

- [ ] **Step 3: Add the keys to all 7 locale files**

In each `history.json`, inside the top-level `"history"` object, add an `"export"` object and a `"desktop"` object (merge into existing objects if `"desktop"` already exists — check first with `grep -n '"desktop"' public/locales/en/history.json`). Values per locale:

| Locale | `export.open` | `export.title` | `desktop.railLabel` |
|---|---|---|---|
| en | `Export` | `Export data` | `Cards` |
| de-CH | `Exportieren` | `Daten exportieren` | `Karten` |
| es | `Exportar` | `Exportar datos` | `Tarjetas` |
| fr | `Exporter` | `Exporter les données` | `Cartes` |
| it | `Esporta` | `Esporta dati` | `Schede` |
| pt | `Exportar` | `Exportar dados` | `Cartões` |
| lg | see note | see note | see note |

For `lg` (Luganda): first `grep -in 'export' web/react-gui/public/locales/lg/history.json` and reuse the verb the existing zone-CSV export strings use; if the lg file falls back to English for technical terms (it does in places), use the English values.

Example for `en/history.json` (same shape in every locale):

```json
"export": {
  "open": "Export",
  "title": "Export data"
},
"desktop": {
  "railLabel": "Cards"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/historyLocaleKeys.test.ts`
Expected: PASS (2 tests). If the first test now reports *other* missing keys beyond the three, add those to `en/history.json` too (with sensible English values) — the test is the source of truth.

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/public/locales web/react-gui/src/history/__tests__/historyLocaleKeys.test.ts
git commit -m "fix(gui): add missing history export/rail i18n keys + locale coverage test"
```

---

### Task 2: Stop calendar day cells from hijacking touch gestures

`HistoryMonthCalendarView` calls `selectCell()` inside `onPointerDown` for touch/pen pointers, so **any** swipe or pinch that starts on a day cell instantly opens the day inspector sheet, whose backdrop then swallows the rest of the gesture (proven live: one month-swipe fired both the month change and the inspector for the day under the start point). Replace immediate selection with tap detection: select only when the pointer goes down and up on the same cell with ≤10 px movement.

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx:242-279`
- Test: `web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`

**Interfaces:**
- Consumes: existing `onInspectDate?: (selection: HistoryCalendarDateSelection) => void` prop (unchanged).
- Produces: unchanged component API; new interaction contract "touch selects on tap only".

- [ ] **Step 1: Write the failing test**

Add to `HistoryMonthCalendarView.test.tsx` (reuse the file's existing `translateForTest` mock and calendar fixtures — follow the established `render(<HistoryMonthCalendarView …/>)` + `fireEvent` pattern):

```tsx
it('does not open the inspector when a touch gesture starts on a day cell and moves away', () => {
  const onInspectDate = vi.fn();
  render(
    <HistoryMonthCalendarView cardType="dendro" calendar={calendarFixture} onInspectDate={onInspectDate} />,
  );
  const cell = screen.getByTestId('calendar-cell-2026-07-05');
  fireEvent.pointerDown(cell, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(cell, { pointerType: 'touch', pointerId: 1, clientX: 160, clientY: 100 });
  fireEvent.pointerUp(cell, { pointerType: 'touch', pointerId: 1, clientX: 160, clientY: 100 });
  expect(onInspectDate).not.toHaveBeenCalled();
});

it('opens the inspector on a touch tap (down and up without movement)', () => {
  const onInspectDate = vi.fn();
  render(
    <HistoryMonthCalendarView cardType="dendro" calendar={calendarFixture} onInspectDate={onInspectDate} />,
  );
  const cell = screen.getByTestId('calendar-cell-2026-07-05');
  fireEvent.pointerDown(cell, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(cell, { pointerType: 'touch', pointerId: 1, clientX: 103, clientY: 101 });
  expect(onInspectDate).toHaveBeenCalledTimes(1);
});
```

Use whatever July-2026 date exists in the file's existing calendar fixture for the `calendar-cell-…` testid; `calendarFixture` stands for that existing fixture variable.

- [ ] **Step 2: Run tests to verify the first fails**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`
Expected: the "moves away" test FAILS (current code selects on pointerDown). If any *existing* test asserts that pointerDown alone selects, update that test to the new contract in this step and say so in the commit message.

- [ ] **Step 3: Implement tap detection**

In `HistoryMonthCalendarView.tsx`:

Add near the other imports/state (top of component, after `internalSelectedDate`):

```tsx
const touchTapRef = React.useRef<{ date: string; pointerId: number; x: number; y: number } | null>(null);
const suppressNextClickRef = React.useRef(false);
const TOUCH_TAP_SLOP_PX = 10;
```

Replace the button's event handlers (currently `onClick`/`onMouseDown`/`onMouseUp`/`onPointerDown`/`onPointerMove`/`onPointerUp`/`onPointerCancel`) with:

```tsx
onClick={(event) => {
  stopCalendarGesture(event);
  if (suppressNextClickRef.current) {
    suppressNextClickRef.current = false;
    return;
  }
  selectCell();
}}
onPointerDown={(event) => {
  stopCalendarGesture(event);
  if (event.pointerType === 'touch' || event.pointerType === 'pen') {
    touchTapRef.current = { date: cell.date, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }
}}
onPointerMove={(event) => {
  stopCalendarGesture(event);
  const tap = touchTapRef.current;
  if (tap && tap.pointerId === event.pointerId
    && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TOUCH_TAP_SLOP_PX) {
    touchTapRef.current = null;
  }
}}
onPointerUp={(event) => {
  stopCalendarGesture(event);
  const tap = touchTapRef.current;
  touchTapRef.current = null;
  if (!tap || tap.date !== cell.date || tap.pointerId !== event.pointerId) return;
  if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TOUCH_TAP_SLOP_PX) return;
  suppressNextClickRef.current = true;
  selectCell();
}}
onPointerCancel={(event) => {
  stopCalendarGesture(event);
  touchTapRef.current = null;
}}
```

Notes: `onMouseDown`/`onMouseUp` handlers are deleted entirely (mouse selection flows through `onClick`, keyboard activation still fires `onClick`). The `stopCalendarGesture` propagation stops are kept so pointer events don't leak to page-level pull-to-refresh handlers; the gesture surface listens to **touch** events, which still propagate — that is what keeps pan/pinch/month-swipe working over day cells.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`
Expected: PASS, including both new tests.

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx
git commit -m "fix(gui): calendar day cells select on tap only, not on touch pointerdown"
```

---

### Task 3: Suppress hover tooltips on touch devices

Recharts tooltips appear on page load with zero interaction and stay permanently open after every touch gesture — on the Environment 24h chart the stuck tooltip box covered ~8 hours of data. Mobile already has a dedicated selection affordance (long-press inspector), so hover tooltips should only render on hover-capable devices.

**Files:**
- Create: `web/react-gui/src/history/useHoverCapable.ts`
- Modify: every history visualization that renders `<Tooltip` (enumerate with `grep -rln '<Tooltip' web/react-gui/src/components/history/visualizations/` — at minimum `DendroGrowthTimelineView.tsx`, `DendroLineChartView.tsx`, `EnvironmentLineChartView.tsx`, `DailyMinMaxView.tsx`, `SoilLineChartView.tsx`; apply to every file the grep returns)
- Test: `web/react-gui/src/history/__tests__/useHoverCapable.test.ts` (create)

**Interfaces:**
- Produces: `useHoverCapable(): boolean` — `true` only when `matchMedia('(hover: hover) and (pointer: fine)')` matches; `false` when `matchMedia` is unavailable (jsdom default → tooltips absent in tests).

- [ ] **Step 1: Write the failing hook test**

Create `web/react-gui/src/history/__tests__/useHoverCapable.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHoverCapable } from '../useHoverCapable';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('useHoverCapable', () => {
  it('returns true on hover-capable devices', () => {
    stubMatchMedia(true);
    expect(renderHook(() => useHoverCapable()).result.current).toBe(true);
  });

  it('returns false on touch-only devices', () => {
    stubMatchMedia(false);
    expect(renderHook(() => useHoverCapable()).result.current).toBe(false);
  });

  it('returns false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => useHoverCapable()).result.current).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/useHoverCapable.test.ts`
Expected: FAIL with "Cannot find module '../useHoverCapable'".

- [ ] **Step 3: Implement the hook**

Create `web/react-gui/src/history/useHoverCapable.ts`:

```ts
import { useEffect, useState } from 'react';

const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

function currentHoverCapability(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(HOVER_QUERY).matches;
}

/**
 * True only on devices with a hover-capable fine pointer (mouse/trackpad).
 * Touch devices use the long-press inspector instead of hover tooltips, and
 * Recharts tooltips otherwise stick open after synthesized touch gestures.
 */
export function useHoverCapable(): boolean {
  const [hoverCapable, setHoverCapable] = useState(currentHoverCapability);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mediaQuery = window.matchMedia(HOVER_QUERY);
    const onChange = (event: MediaQueryListEvent) => setHoverCapable(event.matches);
    mediaQuery.addEventListener?.('change', onChange);
    return () => mediaQuery.removeEventListener?.('change', onChange);
  }, []);

  return hoverCapable;
}
```

- [ ] **Step 4: Run hook test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/useHoverCapable.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Gate every visualization Tooltip behind the hook**

In each file returned by `grep -rln '<Tooltip' web/react-gui/src/components/history/visualizations/`, add the import and call the hook inside the component body, then wrap the `<Tooltip …/>` element. Pattern (shown for `EnvironmentLineChartView.tsx`, apply identically in each file):

```tsx
import { useHoverCapable } from '../../../history/useHoverCapable';
// inside the component, next to the other hooks:
const hoverCapable = useHoverCapable();
// in the chart JSX, replace the bare tooltip element:
{hoverCapable && (
  <Tooltip
    isAnimationActive={false}
    labelFormatter={formatTimestampMs}
    formatter={(value, _name, item) => {
      const series = group.seriesByKey.get(String(item.dataKey));
      return [
        formatTooltipValue(value, series?.unit ?? ''),
        series?.label ?? t('history.environmentLineChart.series.environment'),
      ];
    }}
  />
)}
```

Keep each file's existing Tooltip props exactly as they are — only wrap in `{hoverCapable && (…)}`. `React.memo`-wrapped components: the hook goes in the inner component function.

- [ ] **Step 6: Run the history test suites**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__ src/history/__tests__`
Expected: PASS. If any existing view test asserted tooltip presence, stub `matchMedia` to `matches: true` in that test's setup instead of deleting the assertion.

- [ ] **Step 7: Commit**

```bash
git add web/react-gui/src/history/useHoverCapable.ts web/react-gui/src/history/__tests__/useHoverCapable.test.ts web/react-gui/src/components/history/visualizations
git commit -m "fix(gui): render chart hover tooltips only on hover-capable devices"
```

---

### Task 4: Calendar future handling — future day cells, month clamp, inspector coverage tile

Today (live-verified): future days render as "No data" cells, month swipe navigates into fully-future months (August 2026), tapping a future day opens an inspector showing "No data" beside a card-level "100% coverage" tile.

**Files:**
- Modify: `web/react-gui/src/history/calendarMonth.ts` (add two pure helpers)
- Modify: `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx:591-593` (`handleMonthSwipe`)
- Modify: `web/react-gui/src/components/history/mobile/HistoryInspectorSheet.tsx` (coverage tile, ~line 219)
- Test: `web/react-gui/src/history/__tests__/calendarMonth.test.ts` (extend or create alongside existing pattern), `web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`

**Interfaces:**
- Produces:
  - `isFutureCalendarDate(date: string, todayIsoDate: string): boolean` in `calendarMonth.ts`
  - `clampCalendarMonthOffset(baseIso: string | null | undefined, currentOffset: number, delta: -1 | 1, nowMs?: number): number` in `calendarMonth.ts`
  - New optional prop `todayIso?: string` on `HistoryMonthCalendarView` (ISO date `YYYY-MM-DD`, defaults to today; tests pass it explicitly for determinism)

- [ ] **Step 1: Write failing helper tests**

In `web/react-gui/src/history/__tests__/calendarMonth.test.ts` (create the file if it doesn't exist, following the plain-vitest style of the other `src/history/__tests__` files):

```ts
import { describe, expect, it } from 'vitest';
import { clampCalendarMonthOffset, isFutureCalendarDate } from '../calendarMonth';

const NOW_MS = Date.UTC(2026, 6, 11, 12); // 2026-07-11T12:00Z

describe('isFutureCalendarDate', () => {
  it('flags dates after today', () => {
    expect(isFutureCalendarDate('2026-07-12', '2026-07-11')).toBe(true);
  });
  it('keeps today and the past', () => {
    expect(isFutureCalendarDate('2026-07-11', '2026-07-11')).toBe(false);
    expect(isFutureCalendarDate('2026-06-30', '2026-07-11')).toBe(false);
  });
});

describe('clampCalendarMonthOffset', () => {
  const base = '2026-07-11T09:00:00.000Z'; // viewport ends in the current month
  it('blocks swiping into a future month', () => {
    expect(clampCalendarMonthOffset(base, 0, 1, NOW_MS)).toBe(0);
  });
  it('allows returning to the current month from the past', () => {
    expect(clampCalendarMonthOffset(base, -1, 1, NOW_MS)).toBe(0);
  });
  it('always allows going further into the past', () => {
    expect(clampCalendarMonthOffset(base, -1, -1, NOW_MS)).toBe(-2);
  });
  it('clamps when the viewport base is already a past month', () => {
    expect(clampCalendarMonthOffset('2026-05-20T00:00:00.000Z', 2, 1, NOW_MS)).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/calendarMonth.test.ts`
Expected: FAIL — the two functions don't exist yet.

- [ ] **Step 3: Implement the helpers**

Append to `web/react-gui/src/history/calendarMonth.ts`:

```ts
/** Calendar dates are YYYY-MM-DD strings, so lexicographic comparison is correct. */
export function isFutureCalendarDate(date: string, todayIsoDate: string): boolean {
  return date > todayIsoDate;
}

/**
 * Month-swipe clamp: never navigate the calendar into a month that starts
 * after the current month. `baseIso` is the viewport anchor the month offset
 * is applied to (same base as monthRangeFromViewport in HistoryCardDetailPage).
 */
export function clampCalendarMonthOffset(
  baseIso: string | null | undefined,
  currentOffset: number,
  delta: -1 | 1,
  nowMs: number = Date.now(),
): number {
  const next = currentOffset + delta;
  const baseMs = baseIso ? Date.parse(baseIso) : NaN;
  const base = Number.isFinite(baseMs) ? new Date(baseMs) : new Date(nowMs);
  const targetMonthStartMs = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + next, 1);
  const now = new Date(nowMs);
  const currentMonthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return targetMonthStartMs > currentMonthStartMs ? currentOffset : next;
}
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run: `cd web/react-gui && npx vitest run src/history/__tests__/calendarMonth.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing view test for future day cells**

Add to `HistoryMonthCalendarView.test.tsx`:

```tsx
it('renders future days as inert placeholders without a no-data label', () => {
  const onInspectDate = vi.fn();
  render(
    <HistoryMonthCalendarView
      cardType="dendro"
      calendar={calendarFixture} // July 2026 fixture
      onInspectDate={onInspectDate}
      todayIso="2026-07-11"
    />,
  );
  const futureCell = screen.getByTestId('calendar-cell-2026-07-20');
  expect(futureCell.tagName).toBe('DIV');
  expect(futureCell).toHaveAttribute('data-state', 'future');
  expect(futureCell).not.toHaveTextContent('No data');
  fireEvent.click(futureCell);
  expect(onInspectDate).not.toHaveBeenCalled();
});
```

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryMonthCalendarView.test.tsx` — expected: FAIL (cell is currently a BUTTON with "No data").

- [ ] **Step 6: Implement future day cells**

In `HistoryMonthCalendarView.tsx`:

1. Extend props:

```tsx
interface HistoryMonthCalendarViewProps {
  cardType: HistoryCardType;
  calendar: HistoryCalendar | null | undefined;
  onInspectDate?: (selection: HistoryCalendarDateSelection) => void;
  selectedDate?: string | null;
  /** ISO date (YYYY-MM-DD) treated as "today"; defaults to the current UTC date. */
  todayIso?: string;
}
```

2. Import the helper: `import { formatHistoryCalendarMonthLabel, isFutureCalendarDate, latestCalendarMonth } from '../../../history/calendarMonth';`

3. In the component body: `const todayIsoDate = todayIso ?? new Date().toISOString().slice(0, 10);`

4. In `cells.map`, immediately after the `blank` branch, add:

```tsx
if (isFutureCalendarDate(cell.date, todayIsoDate)) {
  return (
    <div
      key={cell.key}
      role="gridcell"
      aria-label={`${cell.dayOfMonth}`}
      data-testid={`calendar-cell-${cell.date}`}
      data-state="future"
      className="flex aspect-square min-h-12 flex-col rounded-md border border-transparent p-1 text-left opacity-40 sm:p-1.5"
    >
      <span className="text-xs font-bold leading-none text-[var(--text-tertiary)] sm:text-sm">
        {cell.dayOfMonth}
      </span>
    </div>
  );
}
```

- [ ] **Step 7: Clamp the month swipe in the detail page**

In `HistoryCardDetailPage.tsx`, import the helper (`import { clampCalendarMonthOffset } from '../history/calendarMonth';` — merge with the file's existing `calendarMonth` import if present) and replace `handleMonthSwipe`:

```tsx
const handleMonthSwipe = useCallback((delta: -1 | 1) => {
  const baseIso = timeViewport.viewport.range.to ?? timeViewport.viewport.range.from;
  setCalendarMonthOffset((offset) => clampCalendarMonthOffset(baseIso, offset, delta));
}, [timeViewport.viewport.range.to, timeViewport.viewport.range.from]);
```

- [ ] **Step 8: Hide the card-level coverage tile for date selections**

In `HistoryInspectorSheet.tsx`, the `<dl>` grid contains a COVERAGE tile fed by `formatCoverage(t, data)` — card-level coverage, which contradicts day-level "No data" (live-observed "No data / 100% coverage"). Wrap that one `<div>` tile in a `selection.kind === 'timestamp'` condition:

```tsx
{selection.kind === 'timestamp' && (
  <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
    <dt className="text-xs font-semibold uppercase text-[var(--text-tertiary)]">
      {t('history.inspector.coverage')}
    </dt>
    <dd className="mt-1 font-semibold text-[var(--text)]">{formatCoverage(t, data)}</dd>
  </div>
)}
```

(Date selections already show day-level coverage via `calendarCoverageLabel` in the date block above.)

- [ ] **Step 9: Run the affected suites**

Run: `cd web/react-gui && npx vitest run src/history/__tests__ src/components/history/__tests__ src/pages/__tests__`
Expected: PASS. Fix any detail-page test that pinned the old unclamped `handleMonthSwipe` behavior.

- [ ] **Step 10: Commit**

```bash
git add web/react-gui/src/history/calendarMonth.ts web/react-gui/src/history/__tests__/calendarMonth.test.ts web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx web/react-gui/src/components/history/mobile/HistoryInspectorSheet.tsx
git commit -m "fix(gui): calendar treats future days as future, clamps month swipe, fixes inspector coverage tile"
```

---

### Task 5: `data-coverage-gap` interpretation must ignore future time (backend, both profiles)

The rule in `osi-history-helper` fires whenever `coveragePct < 80`, and the calendar's month window includes future days — so every current-month calendar shows "Sensor data is incomplete" even with perfect uptime. Scale coverage to the *elapsed* portion of the window before applying the threshold.

> **Coordination note (2026-07-11):** the interpretation-layer rescale below is the interim fix. `docs/superpowers/plans/2026-07-11-rollup-hardening.md` Task 3 supersedes it with an aggregation-layer clamp and removes the rescale again (keeping this task's fully-future skip and `rangeFrom`/`rangeTo` plumbing). If the orchestrator schedules the hardening plan FIRST, execute this task with the hardening plan's Task 3 Step-4 code instead of the rescale block below. Do not let both corrections be active at once.

**Prerequisite: load the `osi-flows-json-editing` skill before editing `flows.json`.**

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js:2134-2166` (`buildLocalInterpretations`)
- Modify: `conf/full_raspberrypi_bcm2709/files/usr/share/node-red/osi-history-helper/index.js` (identical change)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (the single `buildLocalInterpretations({` call site)
- Modify: `conf/full_raspberrypi_bcm2709/files/usr/share/flows.json` (same call site)
- Test: `scripts/test-history-helper.js` (append cases)

**Interfaces:**
- Consumes: `buildLocalInterpretations(input)` already exported by the helper (`module.exports` line ~2621).
- Produces: two new optional input fields `rangeFrom` / `rangeTo` (ISO strings). Existing callers that omit them keep the old behavior exactly.

- [ ] **Step 1: Append failing tests to the helper harness**

`scripts/test-history-helper.js` is a plain-`assert` node script that `require`s the bcm2712 helper. Append before its final success log:

```js
// --- data-coverage-gap: future time must not count as missing data ---
{
  const base = {
    cardType: 'dendro',
    generatedAt: '2026-07-11T12:00:00.000Z',
    coverageConfidence: 'configured',
    rangeFrom: '2026-07-01T00:00:00.000Z',
    rangeTo: '2026-08-01T00:00:00.000Z', // month window: ~10.5 of 31 days elapsed
  };
  const fullElapsedCoverage = helper.buildLocalInterpretations({ ...base, coveragePct: 34 });
  assert(
    !fullElapsedCoverage.some((item) => item.ruleId === 'data-coverage-gap'),
    'coverage gap must not fire when the elapsed part of the window is fully covered',
  );

  const realGap = helper.buildLocalInterpretations({ ...base, coveragePct: 15 });
  assert(
    realGap.some((item) => item.ruleId === 'data-coverage-gap'),
    'coverage gap must still fire for genuinely low elapsed coverage',
  );

  const pastWindow = helper.buildLocalInterpretations({
    ...base,
    rangeFrom: '2026-06-01T00:00:00.000Z',
    rangeTo: '2026-06-30T00:00:00.000Z',
    coveragePct: 70,
  });
  assert(
    pastWindow.some((item) => item.ruleId === 'data-coverage-gap'),
    'past windows keep the plain <80% threshold',
  );

  const fullyFuture = helper.buildLocalInterpretations({
    ...base,
    rangeFrom: '2026-08-01T00:00:00.000Z',
    rangeTo: '2026-09-01T00:00:00.000Z',
    coveragePct: null,
    coverageConfidence: 'unknown',
  });
  assert(
    !fullyFuture.some((item) => item.ruleId === 'data-coverage-gap'),
    'fully-future windows must not warn about missing data',
  );
}
console.log('data-coverage-gap future-window tests passed');
```

- [ ] **Step 2: Run to verify failure**

Run: `node scripts/test-history-helper.js`
Expected: FAIL on the first new assert (34% < 80 fires today).

- [ ] **Step 3: Implement the clamp in the bcm2712 helper**

In `buildLocalInterpretations` (bcm2712 `index.js`), replace the coverage block:

```js
  if (coverageConfidence === 'unknown' || (coveragePct !== null && coveragePct < 80)) {
```

with:

```js
  const generatedMs = parseTime(generatedAt);
  const rangeFromMs = parseTime(input.rangeFrom);
  const rangeToMs = parseTime(input.rangeTo);
  const windowKnown = rangeFromMs !== null && rangeToMs !== null && generatedMs !== null && rangeToMs > rangeFromMs;
  const fullyFutureWindow = windowKnown && rangeFromMs >= generatedMs;
  // Coverage is computed over the whole requested window; when the window
  // extends past "now", rescale it to the elapsed portion so future time
  // does not count as missing data.
  let effectiveCoveragePct = coveragePct;
  if (coveragePct !== null && windowKnown && rangeToMs > generatedMs) {
    const totalMs = rangeToMs - rangeFromMs;
    const elapsedMs = generatedMs - rangeFromMs;
    effectiveCoveragePct = elapsedMs <= 0 ? null : Math.min(100, coveragePct * (totalMs / elapsedMs));
  }
  const coverageGapFires = effectiveCoveragePct !== null
    ? effectiveCoveragePct < 80
    : (coverageConfidence === 'unknown' && !fullyFutureWindow);
  if (coverageGapFires) {
```

and inside the pushed item keep the existing fields but extend `params`/`evidence` to expose the effective value:

```js
      params: { coveragePct: effectiveCoveragePct ?? coveragePct, coverageConfidence },
      evidence: [{ type: 'coverage', coveragePct: effectiveCoveragePct ?? coveragePct, coverageConfidence }],
```

(The `severity` line keeps its existing `coverageConfidence === 'unknown' ? 'info' : 'warning'` expression.)

- [ ] **Step 4: Run helper tests**

Run: `node scripts/test-history-helper.js`
Expected: PASS including the four new asserts and every pre-existing assert (backward compat: inputs without `rangeFrom`/`rangeTo` take `windowKnown === false` → old thresholds).

- [ ] **Step 5: Pass the range from the flows.json caller**

Locate the single call: `grep -n 'buildLocalInterpretations({' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`. In that function node's source, the call currently passes `cardType`, `status`, `dendroStatus`, `generatedAt`, `coveragePct`, `coverageConfidence`. Read the ~15 surrounding lines to identify the in-scope query/range object (the node has the request range available — it feeds the aggregation call). Add two properties to the call, using that object's from/to fields verbatim, e.g. if the object is `query`:

```js
    rangeFrom: query.from,
    rangeTo: query.to,
```

Follow `osi-flows-json-editing` mechanics for editing the embedded `func` string (escaped `\n` newlines).

- [ ] **Step 6: Mirror both files to bcm2709 and verify parity**

Apply the identical helper edit to `conf/full_raspberrypi_bcm2709/files/usr/share/node-red/osi-history-helper/index.js` and the identical flows edit to `conf/full_raspberrypi_bcm2709/files/usr/share/flows.json`, then:

Run: `node scripts/verify-profile-parity.js`
Expected: all 22 checks pass.

Run: `node scripts/verify-sync-flow.js`
Expected: pass (guards against accidental flows.json structural damage).

- [ ] **Step 7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js conf/full_raspberrypi_bcm2709/files/usr/share/node-red/osi-history-helper/index.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm2709/files/usr/share/flows.json scripts/test-history-helper.js
git commit -m "fix(history-api): data-coverage-gap interpretation ignores future time in the window"
```

---

### Task 6: Dendro Line Chart — plot stem change only; diagnostics stay in Advanced View

Live-verified: the dendro line chart plots Stem Change (~3169 µm), Position (~19.5 mm), Ratio (~0.72) and Delta (~0.006) on one y-axis, rendering three series as flat lines at zero. **Adjudicated default (confirm at review):** the farmer-facing line chart plots the stem-change series only; Position/Ratio/Delta are decoder diagnostics already exposed in Advanced View. Also add units to the dendro tooltip.

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/DendroLineChartView.tsx`
- Test: `web/react-gui/src/components/history/__tests__/DendroLineChartView.test.tsx` (extend; create following the sibling view tests if absent)

**Interfaces:**
- Produces: exported pure function `selectPlottedSeries(seriesList: RenderSeries[]): RenderSeries[]` (exported for tests, alongside the file's existing exported `buildNumericRows`). `RenderSeries` gains a `source: string` field.

- [ ] **Step 1: Write the failing test**

```tsx
import { selectPlottedSeries } from '../visualizations/DendroLineChartView';

const series = (source: string) => ({
  key: source, label: source, unit: 'um', source,
  points: [{ t: '2026-07-10T00:00:00.000Z', value: 1 }],
});

describe('selectPlottedSeries', () => {
  it('keeps only stem-change series when one exists', () => {
    const picked = selectPlottedSeries([
      series('stem_change_um Stem Change'),
      series('position_mm Position'),
      series('dendro_ratio Ratio'),
      series('delta_mm Delta'),
    ]);
    expect(picked.map((entry) => entry.source)).toEqual(['stem_change_um Stem Change']);
  });

  it('falls back to all series when no stem series exists', () => {
    const input = [series('position_mm Position'), series('dendro_ratio Ratio')];
    expect(selectPlottedSeries(input)).toEqual(input);
  });
});
```

Add these into the existing `DendroLineChartView` test file (match its mock/i18n setup); if none exists, create one modeled on `HistoryMonthCalendarView.test.tsx`'s structure.

- [ ] **Step 2: Run to verify failure**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/DendroLineChartView.test.tsx`
Expected: FAIL — `selectPlottedSeries` is not exported.

- [ ] **Step 3: Implement**

In `DendroLineChartView.tsx`:

1. Add `source: string` to the `RenderSeries` type and include the already-computed local `source` string in the object `normalizeSeriesList` returns (it currently computes `source` from `series.id` + `series.label` around line 93 but discards it).

2. Add and export:

```ts
/**
 * The farmer-facing line chart plots stem change only; position/ratio/delta
 * are decoder diagnostics with incompatible scales (µm vs mm vs unitless)
 * and live in Advanced View.
 */
export function selectPlottedSeries(seriesList: RenderSeries[]): RenderSeries[] {
  const stemSeries = seriesList.filter((series) => /stem/i.test(series.source));
  return stemSeries.length > 0 ? stemSeries : seriesList;
}
```

3. In the component, apply it after the existing visible-series filter, and build a lookup for the tooltip:

```ts
const plottedSeries = selectPlottedSeries(visibleSeries);
const seriesByKey = React.useMemo(
  () => new Map(plottedSeries.map((series) => [series.key, series])),
  [plottedSeries],
);
```

Use `plottedSeries` everywhere the render previously used `visibleSeries` (row building and `<Line>` mapping), and give the Tooltip a unit-aware formatter (mirroring EnvironmentLineChartView's):

```tsx
<Tooltip
  isAnimationActive={false}
  labelFormatter={formatTimestampMs}
  formatter={(value, _name, item) => {
    const series = seriesByKey.get(String(item.dataKey));
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
    const text = numeric === null ? '-' : `${Number.isInteger(numeric) ? numeric : numeric.toFixed(1)} ${series?.unit ?? ''}`.trim();
    return [text, series?.label ?? ''];
  }}
/>
```

(Task 3's `hoverCapable` gate wraps this Tooltip; Task 7 upgrades the unit string.)

- [ ] **Step 4: Run tests**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/DendroLineChartView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/components/history/visualizations/DendroLineChartView.tsx web/react-gui/src/components/history/__tests__/DendroLineChartView.test.tsx
git commit -m "fix(gui): dendro line chart plots stem change only; diagnostics stay in Advanced View"
```

---

### Task 7: Human unit labels (°C, µm) across chart axes and tooltips

Axes and tooltips show raw unit tokens `C` and `um` (live: "External Temperature : 26.1 C", y-axis "um").

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/chartAxis.ts`
- Modify: `web/react-gui/src/components/history/visualizations/EnvironmentLineChartView.tsx` (`formatValue`), `DendroLineChartView.tsx` (tooltip from Task 6), `DailyMinMaxView.tsx` and `SoilLineChartView.tsx` (wherever they format a unit — locate with `grep -n 'unit' <file>`)
- Test: `web/react-gui/src/components/history/__tests__/chartAxis.test.ts` (extend; create if absent)

**Interfaces:**
- Produces: `formatDisplayUnit(unit: string | null | undefined): string` exported from `chartAxis.ts`; `historyValueYAxis` renders its axis title through it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { formatDisplayUnit, historyValueYAxis } from '../visualizations/chartAxis';

describe('formatDisplayUnit', () => {
  it('maps raw unit tokens to display units', () => {
    expect(formatDisplayUnit('C')).toBe('°C');
    expect(formatDisplayUnit('um')).toBe('µm');
  });
  it('passes through unknown units and blanks', () => {
    expect(formatDisplayUnit('kPa')).toBe('kPa');
    expect(formatDisplayUnit('')).toBe('');
    expect(formatDisplayUnit(null)).toBe('');
  });
});

describe('historyValueYAxis', () => {
  it('renders the axis title with the display unit', () => {
    expect(historyValueYAxis('um').label).toMatchObject({ value: 'µm' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/chartAxis.test.ts`
Expected: FAIL — `formatDisplayUnit` not exported.

- [ ] **Step 3: Implement**

In `chartAxis.ts`:

```ts
const UNIT_DISPLAY: Record<string, string> = { C: '°C', um: 'µm' };

/** Maps raw backend unit tokens (device_data column units) to human display units. */
export function formatDisplayUnit(unit: string | null | undefined): string {
  const trimmed = (unit ?? '').trim();
  return trimmed ? (UNIT_DISPLAY[trimmed] ?? trimmed) : '';
}
```

In `historyValueYAxis`, change the label to `value: formatDisplayUnit(unit)` (the `unit ? … : undefined` guard stays keyed on the raw `unit` argument).

In each view's value/tooltip formatter, wrap the unit: e.g. `EnvironmentLineChartView.formatValue` becomes `return unit ? `${formatted} ${formatDisplayUnit(unit)}` : formatted;` and Task 6's dendro tooltip uses `formatDisplayUnit(series?.unit)`. Apply the same one-line wrap in `DailyMinMaxView.tsx` / `SoilLineChartView.tsx` where they interpolate `unit` into user-visible text (grep confirms the exact lines).

- [ ] **Step 4: Run tests**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__`
Expected: PASS (update any test that pinned the raw `um`/`C` strings).

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/components/history/visualizations web/react-gui/src/components/history/__tests__/chartAxis.test.ts
git commit -m "fix(gui): display °C/µm instead of raw unit tokens on chart axes and tooltips"
```

---

### Task 8: Fix top-of-chart label collisions (clipped top tick, "C axis" ghost)

The absolutely-positioned view/range pill (`HistoryCardDetailPage.tsx:799-813`, `absolute left-1 top-1`) overlaps (a) the top y-axis tick of every Recharts view (margin top is only 20 px) and (b) the in-flow unit heading of `EnvironmentLineChartView` ("C axis" showing through behind the pill).

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/chartAxis.ts:9-11`
- Modify: `web/react-gui/src/components/history/visualizations/EnvironmentLineChartView.tsx:270-277`

**Interfaces:**
- Produces: `HISTORY_CHART_MARGIN.top === 36`; env unit heading only when more than one unit group.

- [ ] **Step 1: Bump the shared top margin**

In `chartAxis.ts` replace lines 9-11:

```ts
// `top: 36` keeps the top y-axis tick clear of the absolutely-positioned
// view-mode/device pills that HistoryCardDetailPage overlays at top-1 (~22px tall).
// `bottom: 28` keeps x-axis ticks above mobile browser chrome and home indicators.
export const HISTORY_CHART_MARGIN = { top: 36, right: 16, bottom: 28, left: 8 } as const;
```

- [ ] **Step 2: Render the env unit heading only for multi-unit charts**

In `EnvironmentLineChartView.tsx`, wrap the `<h4>` (lines 273-277) so single-unit charts rely on the y-axis title instead (the heading was colliding with the overlay pill):

```tsx
{groups.length > 1 && (
  <h4 className="text-xs font-semibold text-[var(--text-tertiary)]">
    {group.unit
      ? t('history.environmentLineChart.axisLabel', { unit: group.unit })
      : t('history.environmentLineChart.axisNoUnit')}
  </h4>
)}
```

- [ ] **Step 3: Run the history suite + build**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__ && npm run build`
Expected: tests PASS (update any snapshot pinning the old margin/heading), build succeeds. Visual confirmation happens in Task 13.

- [ ] **Step 4: Commit**

```bash
git add web/react-gui/src/components/history/visualizations/chartAxis.ts web/react-gui/src/components/history/visualizations/EnvironmentLineChartView.tsx
git commit -m "fix(gui): clear chart top labels from the overlay pill; drop redundant single-unit heading"
```

---

### Task 9: Calendar day-label clipping + marker legend

Live: "Reduced" clips mid-glyph in 390 px-wide viewports; the 1–2 dot markers per day have no legend anywhere.

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx`
- Test: `web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`

**Interfaces:**
- Produces: `data-testid="calendar-marker-legend"` section listing each distinct marker type/label present in the month.

- [ ] **Step 1: Write the failing legend test**

```tsx
it('renders a legend for the marker dots present in the month', () => {
  render(<HistoryMonthCalendarView cardType="dendro" calendar={calendarWithMarkersFixture} todayIso="2026-07-11" />);
  const legend = screen.getByTestId('calendar-marker-legend');
  expect(legend).toHaveTextContent('Rain'); // matches the fixture's marker labelKey translation
});
```

Use (or extend) an existing fixture that includes at least one day with `markers: [{ type: 'rain', labelKey: 'history.calendar.marker.rain' }]` — the test file's translation mock already maps that key to `Rain`.

- [ ] **Step 2: Run to verify failure**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`
Expected: FAIL — testid not found.

- [ ] **Step 3: Implement label fit + legend**

In `HistoryMonthCalendarView.tsx`:

1. Day-cell fit: on the day `<button>` change `p-1.5` → `p-1 sm:p-1.5`, and on the state-label `<span>` change `line-clamp-2` → `line-clamp-2 break-words` (long single words like "Reduced" wrap instead of clipping mid-glyph).

2. Legend, computed above the return:

```tsx
const legendMarkers = useMemo(() => {
  const seen = new Map<string, HistoryCalendarMarker>();
  for (const day of days) {
    for (const marker of day.markers ?? []) {
      const key = `${marker.type}:${marker.labelKey}`;
      if (!seen.has(key)) seen.set(key, marker);
    }
  }
  return [...seen.values()];
}, [days]);
```

3. Render after the closing `</div>` of the grid, inside the section:

```tsx
{legendMarkers.length > 0 && (
  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1" data-testid="calendar-marker-legend">
    {legendMarkers.map((marker) => (
      <span
        key={`${marker.type}:${marker.labelKey}`}
        className="flex items-center gap-1 text-[0.65rem] font-semibold text-[var(--text-tertiary)]"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${markerClass(marker)}`} aria-hidden="true" />
        {markerLabel(t, marker)}
      </span>
    ))}
  </div>
)}
```

- [ ] **Step 4: Run tests**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx web/react-gui/src/components/history/__tests__/HistoryMonthCalendarView.test.tsx
git commit -m "fix(gui): calendar day labels wrap instead of clipping; add marker legend"
```

---

### Task 10: Daily Min/Max — narrow the single-bucket expansion

`expandSinglePointRows` (`DailyMinMaxView.tsx:169`) expands a lone daily bucket to ±6 h, rendering a 12-hour-wide block that dominates the 24h view. Narrow to ±45 min: still wide enough that Recharts draws paths instead of forced dots (the original purpose, commit `2b93ab15`), but visually a band, not a wall.

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/DailyMinMaxView.tsx:169-183`
- Test: `web/react-gui/src/components/history/__tests__/DailyMinMaxView.test.tsx`

- [ ] **Step 1: Extend the existing single-bucket test**

The file already asserts single-bucket expansion preserves min/max/mean. Add:

```tsx
it('expands a single bucket to a narrow ±45min segment', () => {
  const rows = expandSinglePointRows([singleBucketRow]); // reuse the file's existing single-row fixture
  expect(rows).toHaveLength(2);
  expect(rows[1].tMs - rows[0].tMs).toBe(90 * 60 * 1000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/DailyMinMaxView.test.tsx`
Expected: FAIL — current delta is `12 * 60 * 60 * 1000`.

- [ ] **Step 3: Implement**

In `expandSinglePointRows` change:

```ts
  const preferredHalfSegmentMs = 45 * 60 * 1000;
```

(keep the surrounding function unchanged; update its nearby comment if it mentions 6 hours).

- [ ] **Step 4: Run tests**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/DailyMinMaxView.test.tsx`
Expected: PASS (including the pre-existing min/max/mean preservation test).

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/components/history/visualizations/DailyMinMaxView.tsx web/react-gui/src/components/history/__tests__/DailyMinMaxView.test.tsx
git commit -m "fix(gui): daily min/max single bucket renders as a narrow band, not a 12h block"
```

---

### Task 11: Overflow menu — close on Escape, outside tap, and card change

Live: the "…" menu ignores Escape and stayed open across card navigation (it floated over two subsequent card screens).

**Files:**
- Modify: `web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx:94-139`
- Modify: `web/react-gui/src/pages/HistoryCardDetailPage.tsx` (effect near `settingsOpen` state, line ~391)
- Test: `web/react-gui/src/components/history/__tests__/HistoryDetailHeader.test.tsx` (extend; create following sibling tests if absent)

- [ ] **Step 1: Write the failing tests**

```tsx
it('closes the settings menu on Escape', () => {
  const onSettingsToggle = vi.fn();
  render(<HistoryDetailHeader zoneName="Zone A" card={cardFixture} settingsOpen onSettingsToggle={onSettingsToggle} onResetRange={vi.fn()} onRefresh={vi.fn()} />);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onSettingsToggle).toHaveBeenCalledTimes(1);
});

it('closes the settings menu when tapping the backdrop', () => {
  const onSettingsToggle = vi.fn();
  render(<HistoryDetailHeader zoneName="Zone A" card={cardFixture} settingsOpen onSettingsToggle={onSettingsToggle} onResetRange={vi.fn()} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByTestId('history-settings-backdrop'));
  expect(onSettingsToggle).toHaveBeenCalledTimes(1);
});
```

(`cardFixture` = the file's existing minimal `HistoryCardSummary` fixture; create one matching the type if the file is new.)

- [ ] **Step 2: Run to verify failure**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__/HistoryDetailHeader.test.tsx`
Expected: FAIL (no Escape handler, no backdrop).

- [ ] **Step 3: Implement in the header**

In `HistoryDetailHeader.tsx` add a document-level Escape listener and a backdrop:

```tsx
React.useEffect(() => {
  if (!settingsOpen || !onSettingsToggle) return undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') onSettingsToggle();
  };
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}, [settingsOpen, onSettingsToggle]);
```

and inside the `{settingsOpen && (…)}` block, render before the menu `<div role="menu">`:

```tsx
<button
  type="button"
  aria-hidden="true"
  tabIndex={-1}
  data-testid="history-settings-backdrop"
  className="fixed inset-0 z-10 cursor-default"
  onClick={onSettingsToggle}
/>
```

(the menu itself is `z-20`, so it stays above the backdrop; this mirrors `HistoryInspectorSheet`'s backdrop pattern).

- [ ] **Step 4: Close on card change in the detail page**

In `HistoryCardDetailPage.tsx`, after the `settingsOpen` state declaration (line ~391), add:

```tsx
useEffect(() => {
  setSettingsOpen(false);
}, [displayCard?.cardId]);
```

(`displayCard` is the page's existing resolved-card variable — see `handleViewSwipe` at line ~580.)

- [ ] **Step 5: Run tests**

Run: `cd web/react-gui && npx vitest run src/components/history/__tests__ src/pages/__tests__`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/react-gui/src/components/history/mobile/HistoryDetailHeader.tsx web/react-gui/src/components/history/__tests__/HistoryDetailHeader.test.tsx web/react-gui/src/pages/HistoryCardDetailPage.tsx
git commit -m "fix(gui): history overflow menu closes on Escape, backdrop tap, and card change"
```

---

### Task 12: Make the Reboot Gateway button visible in light theme

`SystemPanel.tsx` styles "⟳ Reboot Gateway" with `text-[var(--error-text)]` — but `--error-text` is `#FFFFFF` in light theme (`index.css:27`; it's an *on-error-background* token), on a white `--card` background: invisible. Introduce a foreground danger token.

**Files:**
- Modify: `web/react-gui/src/index.css` (light-theme block near line 27, dark-theme block near line 62)
- Modify: `web/react-gui/src/components/farming/SystemPanel.tsx:234-239`

- [ ] **Step 1: Add the token**

In `index.css`, after `--error-text: #FFFFFF;` in the light block add:

```css
  --danger-fg: #DC2626; /* danger-coloured text on normal card/surface backgrounds */
```

and after `--error-text: #FEE2E2;` in the dark block add:

```css
  --danger-fg: #F87171;
```

- [ ] **Step 2: Use it on the reboot button**

`grep -n 'error-text' web/react-gui/src/components/farming/SystemPanel.tsx` — on the "⟳ Reboot Gateway" button (default branch, line ~236) replace `text-[var(--error-text)]` with `text-[var(--danger-fg)]`. Leave any usage that sits on an `--error-bg` background unchanged.

- [ ] **Step 3: Verify by build + render**

Run: `cd web/react-gui && npx vitest run src/components/farming/__tests__ && npm run build`
Expected: PASS + build success. Visual check (both themes) happens in Task 13's live pass; for an immediate check, `npm run dev` and confirm the button text is red on the white card.

- [ ] **Step 4: Commit**

```bash
git add web/react-gui/src/index.css web/react-gui/src/components/farming/SystemPanel.tsx
git commit -m "fix(gui): reboot button uses danger foreground token, was white-on-white in light theme"
```

---

### Task 13: Live verification on kaba100

**Prerequisite: load the `osi-live-ops-runbook` skill and follow it exactly (backup, deploy flow, BusyBox traps, post-checks). Never touch `/data/db/farming.db`.**

**Files:** none in-repo (live verification). Driver scripts: `/home/phil/playwright-osi/mobile-gesture-suite/{lib.js,step2-gestures.js,step4-remaining.js}` (CDP touch-synthesis suite from the 2026-07-11 review — `lib.js` exposes `login/pinch/drag/swipe/twoFingerSwipe/longPress/doubleTap` against `http://100.93.68.86:1880`).

- [ ] **Step 1: Full test + build gate**

```bash
cd web/react-gui && npm run test:unit && npm run build
node scripts/verify-profile-parity.js && node scripts/test-history-helper.js && node scripts/verify-sync-flow.js
```
Expected: everything passes.

- [ ] **Step 2: Deploy to kaba100**

- If Task 5 (flows/helper) is included in this deploy: use the full runbook reverse-tunnel `deploy.sh` flow (download-then-run form), then `/etc/init.d/node-red restart`.
- If deploying GUI-only: `tar czf react_gui.tar.gz -C web/react-gui/build .` and extract into `/usr/lib/node-red/gui/` per the runbook's static-deploy pattern.
- Post-checks per runbook: GUI bundle hash changed, `farming.db` row count not decreased, `:1880/gui` → 301, `export.csv` → 401.

- [ ] **Step 3: Create the temporary review user (established kaba100 pattern)**

```bash
curl -s -X POST http://100.93.68.86:1880/auth/register -H 'Content-Type: application/json' -d '{"username":"playwright","password":"osireview2026"}'
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@100.93.68.86 '
PID=$(sqlite3 /data/db/farming.db "SELECT id FROM users WHERE username='"'"'playwright'"'"';")
sqlite3 /data/db/farming.db "UPDATE irrigation_zones SET user_id=$PID WHERE id IN (3,12);"
sqlite3 /data/db/farming.db "UPDATE devices SET user_id=$PID WHERE irrigation_zone_id IN (3,12);"'
```

- [ ] **Step 4: Run the regression checklist** (drive with the mobile-gesture-suite scripts; screenshot each item)

| # | Check | Pass condition |
|---|---|---|
| 1 | Card detail header | Button reads "Export" (localized), no raw `history.export.*` keys anywhere; title no longer crushed |
| 2 | Fresh detail load + after pinch/drag/view-swipe | No tooltip box visible at any point on the touch-emulated session |
| 3 | Pinch open/close, drag-pan, double-tap, long-press inspector, two-finger card swipe | All still work (pill label changes as in the 2026-07-11 review) |
| 4 | Calendar: horizontal swipe starting ON a day cell | Month changes, **no** inspector sheet opens |
| 5 | Calendar: tap a past day | Inspector opens for that day; no card-level coverage tile contradiction |
| 6 | Calendar July 2026 | Days after today render muted/blank (not "No data"); **no** "Sensor data is incomplete" banner when elapsed coverage is healthy |
| 7 | Calendar: swipe left from current month | Stays on current month (no August) |
| 8 | Calendar day labels | "Reduced" wraps, no mid-glyph clipping; marker legend visible below grid |
| 9 | Dendro line chart | Single stem-change series, y-axis "µm", tooltip absent on touch |
| 10 | Environment 24h | No "C axis" ghost; y-axis "°C"; top tick not clipped |
| 11 | Env daily min/max (24h) | Narrow band instead of 12h block |
| 12 | Overflow menu | Closes on outside tap; gone after card swipe |
| 13 | Dashboard (light theme) | "⟳ Reboot Gateway" clearly visible in red |
| 14 | Export sheet | Title localized ("Export data"), flow unchanged |

- [ ] **Step 5: Restore and clean up (mandatory)**

```bash
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes root@100.93.68.86 '
sqlite3 /data/db/farming.db "UPDATE irrigation_zones SET user_id=2 WHERE id IN (3,12);"
sqlite3 /data/db/farming.db "UPDATE devices SET user_id=2 WHERE irrigation_zone_id IN (3,12);"
sqlite3 /data/db/farming.db "DELETE FROM users WHERE username='"'"'playwright'"'"';"
sqlite3 /data/db/farming.db "SELECT COUNT(*) FROM users WHERE username='"'"'playwright'"'"';"'
```
Expected: final count `0`; zones/devices back on `user_id=2`.

- [ ] **Step 6: Record results + commit any doc updates**

Append a dated verification section to `docs/ux/history-data-visualization-kaba100-issues.md` (pass/fail per checklist row, screenshot paths, served bundle hash), then:

```bash
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs: record 2026-07 mobile gesture fix verification on kaba100"
```

---

## Explicitly deferred (needs its own spec/plan — do NOT bundle into this one)

1. **Environment "All sources" per-source series split.** The merged single `ext_temperature_c` series interleaves Temp1 (~22 °C) and Dendro1 (~24.5 °C) into a false sawtooth. Splitting per source touches the raw aggregation path, the rollup read path, CSV expectations, and both profiles. **Analysis 2026-07-11 (follow-up):** the suspected "rollup overwrite bug" in `rollupRowsToResult` does **not** exist in current behavior — merged cards write ONE combined-aggregate row per bucket/channel under a single `logical_source_key` (`microclimate`/`root-zone`), verified live on kaba100 (2026-07-09 daily env bucket: mean 24.028 = union mean of both devices, sample_count 144 = 72+72). However `rollupRowsToResult` keys `bucket.series` by `channel_id` only, so it *silently drops data if ever fed rows spanning multiple source keys* — an unguarded invariant that becomes a real bug the moment this per-source split adds per-source rollup rows. The spec for this item must extend the read path (and add a guard/test for the invariant) as part of the design, and note the rollup functions currently have zero coverage in the co-located `index.test.js` (refactor item 1.A3).
2. **Dashboard header layout** (Account button beside an empty grid slot) — plausibly intentional; needs a product call before touching.
3. **Zone selector ordering** on `/history` (Zone B listed/selected before Zone A) — ordering comes from the zones API; decide sort-by-name vs meaningful order first.
4. **Inspector value display** — the long-press inspector shows timestamp/source/coverage but not the measured value at that timestamp; a nice-to-have needing UX input.

## Self-review notes

- Every review finding maps to a task (1: i18n keys, 2: touch hijack, 3: stuck tooltip, 4+5: calendar future handling incl. false banner, 6: mixed scales, 7: units, 8: clipped tick + ghost label, 9: label clip + legend dots, 10: min/max block, 11: menu close, 12: reboot button, 13: live re-verification) or is explicitly deferred with a reason (env sawtooth, dashboard layout, zone order, inspector value).
- Task 6 and Task 4's future-cell rendering encode **adjudicated defaults** — flag both at review time.
- Type consistency: `RenderSeries.source` (Task 6) is added in the same file that consumes it; `clampCalendarMonthOffset`/`isFutureCalendarDate` signatures match between Task 4's steps; `todayIso` prop name is consistent across component and tests.
