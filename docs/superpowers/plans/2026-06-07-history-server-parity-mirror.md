# History Server Parity Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the recent osi-os history polish (SWR de-duplication, calendar month context, "Soil Moisture" rename, source-name header) into the osi-server cloud frontend so both history UIs behave consistently.

**Architecture:** Behavioral port across a diverged frontend. osi-server shares component *names* with osi-os but the files differ, so each task names the exact osi-server file and shows the concrete change. The osi-os edge perf fixes (latest-row query, schema-guard cache, helper `ORDER BY`, phase timing) are SQLite/Node-RED specific and are **not** ported — Task 6 records the parity verification instead.

**Tech Stack:** Vite + React 18 + TypeScript, SWR, Recharts, Vitest + Testing Library, i18next. Repo: `/home/phil/Repos/osi-server`, branch `feat/history-data-visualization`.

**Source of truth (osi-os, already implemented):**
- `web/react-gui/src/history/useHistoryCardData.ts` (SWR keys + options)
- `web/react-gui/src/history/calendarMonth.ts` (month helper)
- `web/react-gui/src/components/history/visualizations/SoilLineChartView.tsx` (depth labels — see Task 5 note)

---

## Pre-flight

- [ ] **Step 0: Confirm branch and clean tree.**

Run:

```bash
cd /home/phil/Repos/osi-server && git status --short --branch
```

Expected: on `feat/history-data-visualization`. Stash unrelated edits to `AGENTS.md` if they would be swept into commits.

---

## Task 1: SWR de-duplication for card data

**Files:**
- Modify: `frontend/src/history/useHistoryCardData.ts`
- Test: `frontend/src/components/history/__tests__/useHistoryCardData.test.tsx`

- [ ] **Step 1: Add a failing test for minute-stable keys.**

Add to `useHistoryCardData.test.tsx` (adapt imports/fixtures to the file's existing helpers):

```tsx
it('does not refetch when range endpoints differ only within the same minute', async () => {
  const fetcher = vi.spyOn(historyAPI, 'getZoneCardData').mockResolvedValue(cardDataFixture);
  const base = {
    scope: { type: 'zone' as const, zoneId: 12 },
    cardId: 'soil',
    view: 'line-chart' as const,
    aggregation: 'auto' as const,
    overlays: [] as HistoryOverlayId[],
    enabled: true,
  };
  const { rerender } = renderHook((props) => useHistoryCardData(props), {
    initialProps: { ...base, range: { label: '24h', from: '2026-06-07T10:00:05.000Z', to: '2026-06-07T11:00:05.000Z', timezone: 'UTC' } },
  });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  rerender({ ...base, range: { label: '24h', from: '2026-06-07T10:00:42.000Z', to: '2026-06-07T11:00:48.000Z', timezone: 'UTC' } });
  await new Promise((r) => setTimeout(r, 20));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd frontend && npx vitest run src/components/history/__tests__/useHistoryCardData.test.tsx -t "same minute"`
Expected: FAIL — fetcher called twice (sub-minute changes currently change the key).

- [ ] **Step 3: Add the minute-canonical helper and use it in the key.**

In `useHistoryCardData.ts`, add near the top (after imports):

```ts
function canonicalIsoMinute(value: string | null | undefined): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}
```

Replace the two key lines (currently `range.from ?? ''` and `range.to ?? ''` around lines 32-33) with:

```ts
    canonicalIsoMinute(range.from),
    canonicalIsoMinute(range.to),
```

Keep the request body (the fetcher arguments) sending the exact `range` unchanged, so the backend still receives the precise viewport.

- [ ] **Step 4: Set de-dup options on the SWR call.**

Change the `useSWR` options object (around line 60, currently `revalidateOnFocus: true`) to:

```ts
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      dedupingInterval: 1_500,
    },
```

- [ ] **Step 5: Run the test file.**

Run: `cd frontend && npx vitest run src/components/history/__tests__/useHistoryCardData.test.tsx`
Expected: PASS (new test plus existing ones).

- [ ] **Step 6: Commit.**

```bash
git add frontend/src/history/useHistoryCardData.ts frontend/src/components/history/__tests__/useHistoryCardData.test.tsx
git commit -m "fix(history): de-duplicate cloud card data refetches"
```

---

## Task 2: SWR de-duplication for advanced data

**Files:**
- Modify: `frontend/src/history/useHistoryCardAdvancedData.ts`

- [ ] **Step 1: Add the same minute-canonical helper.**

In `useHistoryCardAdvancedData.ts`, add the identical `canonicalIsoMinute` helper after the imports (DRY note: the two hooks are independent modules in this repo today; a shared util is optional — keep parity with osi-os, which also duplicates it).

- [ ] **Step 2: Use it in the key.**

Replace the `range.from ?? ''` / `range.to ?? ''` key lines (around lines 29-30) with:

```ts
    canonicalIsoMinute(range.from),
    canonicalIsoMinute(range.to),
```

- [ ] **Step 3: Set de-dup options.**

Change the `useSWR` options (around line 61, `revalidateOnFocus: true`) to:

```ts
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      dedupingInterval: 1_500,
    },
```

- [ ] **Step 4: Run the history unit suite.**

Run: `cd frontend && npx vitest run src/components/history`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/history/useHistoryCardAdvancedData.ts
git commit -m "fix(history): de-duplicate cloud advanced data refetches"
```

---

## Task 3: Calendar month helper

**Files:**
- Create: `frontend/src/history/calendarMonth.ts`
- Test: `frontend/src/history/__tests__/calendarMonth.test.ts` (create if the dir lacks one)

- [ ] **Step 1: Write the failing test.**

Create `frontend/src/history/__tests__/calendarMonth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatHistoryCalendarMonthLabel, latestCalendarMonth } from '../calendarMonth';

const cal = (dates: string[]) => ({
  timezone: 'UTC',
  days: dates.map((date) => ({ date })),
}) as any;

describe('calendarMonth', () => {
  it('returns the latest populated month', () => {
    expect(latestCalendarMonth(cal(['2026-05-30', '2026-06-02']))).toEqual({ year: 2026, month: 6 });
  });
  it('formats a human month label', () => {
    expect(formatHistoryCalendarMonthLabel(cal(['2026-06-02']))).toMatch(/June 2026/);
  });
  it('returns null for empty/invalid calendars', () => {
    expect(formatHistoryCalendarMonthLabel(null)).toBeNull();
    expect(latestCalendarMonth(cal([]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd frontend && npx vitest run src/history/__tests__/calendarMonth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the helper (ported verbatim from osi-os).**

Create `frontend/src/history/calendarMonth.ts`:

```ts
import type { HistoryCalendar } from './types';

export function latestCalendarMonth(calendar: HistoryCalendar | null | undefined): { year: number; month: number } | null {
  const days = Array.isArray(calendar?.days) ? calendar.days : [];
  let latest: { date: string; year: number; month: number } | null = null;
  for (const day of days) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(day.date);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) continue;
    if (!latest || day.date > latest.date) latest = { date: day.date, year, month };
  }
  return latest ? { year: latest.year, month: latest.month } : null;
}

export function formatHistoryCalendarMonthLabel(calendar: HistoryCalendar | null | undefined): string | null {
  const month = latestCalendarMonth(calendar);
  if (!calendar || !month) return null;
  const timezone = calendar.timezone || 'UTC';
  const monthDate = new Date(Date.UTC(month.year, month.month - 1, 15, 12));
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(monthDate);
}
```

Note: `HistoryCalendar` already exists in `frontend/src/history/types.ts` (`{ timezone: string; days: HistoryCalendarDay[] }`), and `HistoryCalendarDay.date` is a `YYYY-MM-DD` string — verified compatible.

- [ ] **Step 4: Run the test.**

Run: `cd frontend && npx vitest run src/history/__tests__/calendarMonth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/history/calendarMonth.ts frontend/src/history/__tests__/calendarMonth.test.ts
git commit -m "feat(history): add cloud calendar month helper"
```

---

## Task 4: Show the calendar month in the persistent context

**Files:**
- Modify: `frontend/src/components/history/CalendarView.tsx`
- Test: `frontend/src/components/history/__tests__/HistoryCardFrame.calendarAdvanced.test.tsx` (existing calendar test) or a new `CalendarView.test.tsx`

- [ ] **Step 1: Read the current header of `CalendarView.tsx`.**

Open `frontend/src/components/history/CalendarView.tsx`. It currently renders `calendar?.timezone || 'UTC'` in a header span (around line 95) and per-day ticks. Identify the header row where the timezone is shown.

- [ ] **Step 2: Add a failing test for the month heading.**

Create `frontend/src/components/history/__tests__/CalendarView.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CalendarView } from '../CalendarView';

describe('CalendarView', () => {
  it('renders the active month heading', () => {
    const calendar = {
      timezone: 'UTC',
      days: [
        { date: '2026-06-01', status: 'optimal', sampleCount: 4 },
        { date: '2026-06-02', status: 'optimal', sampleCount: 4 },
      ],
    } as any;
    render(<CalendarView calendar={calendar} />);
    expect(screen.getByText(/June 2026/)).toBeInTheDocument();
  });
});
```

(Adjust the `CalendarView` prop name to match its real signature — confirm in Step 1 whether it takes `calendar` directly or a wrapper.)

- [ ] **Step 3: Run it and watch it fail.**

Run: `cd frontend && npx vitest run src/components/history/__tests__/CalendarView.test.tsx`
Expected: FAIL — "June 2026" not found.

- [ ] **Step 4: Render the month label.**

In `CalendarView.tsx`, import the helper and render it next to the timezone span:

```tsx
import { formatHistoryCalendarMonthLabel } from '../../history/calendarMonth';
// ...inside the component, where `calendar` is in scope:
const monthLabel = formatHistoryCalendarMonthLabel(calendar);
// ...in the header row, before/around the timezone span:
{monthLabel && <span className="text-sm font-semibold text-slate-700">{monthLabel}</span>}
```

- [ ] **Step 5: Run the test.**

Run: `cd frontend && npx vitest run src/components/history/__tests__/CalendarView.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the history suite to catch regressions.**

Run: `cd frontend && npx vitest run src/components/history`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add frontend/src/components/history/CalendarView.tsx frontend/src/components/history/__tests__/CalendarView.test.tsx
git commit -m "feat(history): show calendar month in cloud calendar view"
```

---

## Task 5: Rename Soil card to "Soil Moisture"

**Files:**
- Modify: `frontend/src/history/cardDefinitions.ts` (if `displayName`/title is hard-coded)
- Modify: all `frontend/public/locales/*/history.json` soil-title values
- Test: existing soil card tests (`HistoryCardFrameSoilProfile.test.tsx`)

**Note on the soil *line-chart* depth labels:** osi-server has no `SoilLineChartView` — the soil `line-chart` view renders no soil-specific chart (only `soil-profile` → `SoilProfileView`, which already labels rows by depth via `formatDepth`/`history.soilProfile.depthLabel`). So the osi-os "depth labels on the soil line chart" change has **no target here** and is intentionally out of scope for this plan; depth labeling is already present in the profile view. (If a soil line chart is later added in the desktop plan, depth labels come with it.)

- [ ] **Step 1: Locate the current soil title string.**

Run:

```bash
cd /home/phil/Repos/osi-server
grep -rn "history.card.soil.title" frontend/src/history/i18nKeys.ts
for f in frontend/public/locales/*/history.json; do echo "$f:"; python3 - "$f" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
def find(o,path=''):
    if isinstance(o,dict):
        for k,v in o.items(): find(v,path+'.'+k)
    elif 'soil' in path.lower() and 'title' in path.lower():
        print('  ', path, '=', o)
find(d)
PY
done
```

This prints the exact JSON path holding the soil title in each locale (the i18n key is `history.card.soil.title`).

- [ ] **Step 2: Update the English title and add a failing test.**

Set the en `history.card.soil.title` value to `Soil Moisture`. Add to `HistoryCardFrameSoilProfile.test.tsx` (or the nearest soil card render test) an assertion that the rendered soil card title reads `Soil Moisture` rather than the old `Soil - Root Zone`/`Soil`.

- [ ] **Step 3: Run it and watch it fail (for non-en or the assertion).**

Run: `cd frontend && npx vitest run src/components/history/__tests__/HistoryCardFrameSoilProfile.test.tsx`
Expected: FAIL until all locales updated / assertion satisfied.

- [ ] **Step 4: Update every locale's soil title.**

For each `frontend/public/locales/<lang>/history.json`, set the soil title to the locale-appropriate term for "Soil Moisture" (en: `Soil Moisture`; de-CH: `Bodenfeuchte`; es: `Humedad del suelo`; fr: `Humidité du sol`; it: `Umidità del suolo`; pt: `Humidade do solo`; lg: keep existing soil term + "moisture" equivalent, or the nearest existing locale term — do not inject English into a non-English file). If `cardDefinitions.ts` carries a hard-coded `displayName: 'Soil'` that surfaces in the UI, change it to `Soil Moisture` too.

- [ ] **Step 5: Run soil + frame tests.**

Run: `cd frontend && npx vitest run src/components/history`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add frontend/src/history/cardDefinitions.ts frontend/public/locales frontend/src/components/history/__tests__/HistoryCardFrameSoilProfile.test.tsx
git commit -m "fix(history): rename cloud soil card to Soil Moisture"
```

---

## Task 6: Source names in the card header + backend parity note

**Files:**
- Modify: `frontend/src/components/history/HistoryMobileShell.tsx` (renders `card.title` at line ~97) and `HistoryDesktopShell.tsx` header region
- Create: `docs/history-edge-parity.md` (parity verification record)

- [ ] **Step 1: Confirm the source fields exist on the summary type.**

Run: `grep -n "sourceLabel\|sourceSummary\|sourceDevices" frontend/src/history/types.ts`
Expected: the `HistoryCardSummary` type exposes `sourceLabel`/`sourceSummary` (display-safe). If absent, this task reduces to the parity note only and the header change is dropped from scope.

- [ ] **Step 2: Add a failing test for the source line.**

In `HistoryShell.test.tsx` (or the mobile shell test), assert that when a card has `sourceSummary: '2 sensors'` (or `sourceLabel: 'Chameleon 1'`), the header renders that display-safe text and does **not** render a raw 16-hex DevEUI.

- [ ] **Step 3: Run it and watch it fail.**

Run: `cd frontend && npx vitest run src/components/history/__tests__/HistoryShell.test.tsx`
Expected: FAIL — source text not rendered.

- [ ] **Step 4: Render the source line under the title.**

In `HistoryMobileShell.tsx`, below the `{card.title}` span (line ~97), add:

```tsx
{(card.sourceSummary || card.sourceLabel) && (
  <span className="block text-xs text-slate-500">{card.sourceSummary ?? card.sourceLabel}</span>
)}
```

Apply the equivalent in `HistoryDesktopShell.tsx` wherever the selected card's title is shown. Keep raw DevEUI in Advanced View only.

- [ ] **Step 5: Record the backend parity verification.**

Create `docs/history-edge-parity.md`:

```markdown
# History edge → cloud parity (2026-06-07)

The osi-os edge perf fixes are intentionally NOT mirrored to osi-server:

- `getLatestChameleonRows` MAX(id) JOIN rewrite — edge-only. Verified absent in
  `backend/src/main/java/org/osi/server/history/JdbcHistoryRawQueryRepository.java`,
  which uses a channel_key model with indexed `ORDER BY recorded_at ASC` and no MAX(id) latest-row join.
- Per-request schema guard caching — edge-only (Node-RED). The cloud uses migrations.
- Helper `ORDER BY deveui, recorded_at` — edge SQLite plan tuning; cloud query path differs.
- Phase timing (`phaseMs=`) — edge Node-RED log line; cloud has its own request metrics.

Mirrored to cloud: SWR de-dup, calendar month context, Soil Moisture rename, source-name header.
Depth labels: already present in cloud `SoilProfileView` via `formatDepth`; no soil line chart exists to mirror.
```

- [ ] **Step 6: Verify and commit.**

Run: `cd frontend && npx vitest run src/components/history`
Expected: PASS.

```bash
git add frontend/src/components/history/HistoryMobileShell.tsx frontend/src/components/history/HistoryDesktopShell.tsx docs/history-edge-parity.md
git commit -m "fix(history): show cloud card source names; record edge parity"
```

---

## Task 7: Full verification

- [ ] **Step 1: Run the frontend unit suite and build.**

Run:

```bash
cd /home/phil/Repos/osi-server/frontend
npx vitest run
npm run build
```

Expected: all tests pass; build succeeds.

- [ ] **Step 2: Run the backend history tests (no change expected, regression guard).**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests 'org.osi.server.history.*'
```

Expected: PASS.

- [ ] **Step 3: Commit any doc updates if generated.** (No code change expected here.)

---

## Self-Review notes (already applied)

- Spec coverage: SWR de-dup (T1-2), calendar month (T3-4), Soil Moisture rename (T5), source names (T6), backend parity verification (T6 doc), depth-labels resolution documented as already-satisfied (T5 note).
- No `revalidateOnFocus`/`dedupingInterval` drift: both hooks use `revalidateOnFocus: false` + `dedupingInterval: 1_500`.
- `canonicalIsoMinute` signature identical in both hooks and matches osi-os.
- Tasks requiring osi-server-specific component discovery (T4 header wiring, T5 locale paths, T6 source fields) include an explicit read/grep step because the cloud components diverge from osi-os.
