# Zone CSV Range Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a date-range calendar to the zone settings modal that downloads a combined tidy CSV (raw / hourly / daily) for the selected zone and range, built on demand from the database.

**Architecture:** Frontend adds a pure `rangeCalendarModel`, a `RangeCalendar` component, and a `DataExportSection` in `ZoneConfigModal` that GETs a new edge endpoint as a blob and saves it. The endpoint `GET /api/history/zones/:zoneId/export.csv` calls a new helper `buildZoneExportCsv` that emits the tidy long CSV (reusing the rollups branch's `toCsv`/`RAW_CSV_COLUMNS`/`AGG_CSV_COLUMNS` and the `rollups+live` read).

**Tech Stack:** React 18 + TypeScript + Tailwind (Vitest/Testing Library), Node-RED `flows.json`, `osi-history-helper` (CommonJS, tested via `scripts/test-history-helper.js` against in-memory SQLite), i18next.

---

## Source documents

- Spec: `docs/superpowers/specs/2026-06-03-zone-csv-range-export-design.md`
- Depends-on spec: `docs/superpowers/specs/2026-06-02-history-rollups-and-csv-export-design.md`

## Dependency & branch

This builds on the rollups branch (it reuses `toCsv`, `RAW_CSV_COLUMNS`, `AGG_CSV_COLUMNS`, `startOfLocalDayMs`, the `rollups+live` read). Branch from it:

```bash
cd /home/phil/Repos/osi-os
git switch feat/history-rollups-csv     # must contain the rollups work + the start-of-day fix
git switch -c feat/zone-csv-range-export
```

(If `feat/history-rollups-csv` has merged into the mainline history branch, branch from there instead.)

## Constraints

- Edge-only; no `osi-server`, no MQTT/topic changes.
- Mirror every `conf/.../bcm2712/files` change to the `bcm2709` path; `node scripts/verify-sync-flow.js` must pass (chains profile parity).
- Never replace `/data/db/farming.db`. No raw DevEUI in output (display-safe `source`).
- Auth: reuse the existing JWT + zone-access checks the other zone endpoints use.

## Common verification

```bash
cd /home/phil/Repos/osi-os
node scripts/test-history-helper.js
node scripts/verify-sync-flow.js
cd web/react-gui && npm run test:unit && npm run build
```

## Helper facts (verified)

- `osi-history-helper` exports include `deriveCardsForZone`, `startOfLocalDayMs`, `toCsv`, `RAW_CSV_COLUMNS`, `AGG_CSV_COLUMNS`, `aggregateDeviceData` (with the `rollups+live` merge), `normalizeTimezone`.
- `RAW_CSV_COLUMNS = ['timestamp','timezone','zone','card','source','variable','depth_cm','value','unit']`.
- `AGG_CSV_COLUMNS = ['bucket_start','bucket_end','timezone','zone','card','source','variable','depth_cm','unit','n','coverage_pct','mean','min','max','median','latest']`.
- The existing CSV download is served by a flows function node ("Rows → CSV + Download") that sets `msg.payload` (the CSV string) and `msg.headers` with `Content-Type: text/csv` + `Content-Disposition: attachment`.
- `ZoneConfigModal` renders sections as `<div className="rounded-xl border ...">` blocks inside `<div className="p-5 flex flex-col gap-4">`.

---

## Slice 1 — Pure range-calendar model

**Files:**
- Create: `web/react-gui/src/components/farming/rangeCalendarModel.ts`
- Create: `web/react-gui/tests/rangeCalendarModel.test.ts`

### Task 1.1 — month grid + selection state machine

- [ ] **Step 1: Write the test** `tests/rangeCalendarModel.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthGridDays, applyDayClick, applyDayDoubleClick, isInRange, shiftMonth } from '../src/components/farming/rangeCalendarModel';

test('monthGridDays returns leading/trailing days and flags', () => {
  const days = monthGridDays(2026, 5, '2026-05-15'); // month is 1-based: May 2026, today=May 15
  assert.equal(days.length % 7, 0);
  const may1 = days.find((d) => d.date === '2026-05-01');
  assert.ok(may1 && may1.inMonth);
  const future = days.find((d) => d.date === '2026-05-20');
  assert.ok(future && future.isFuture, 'days after today are future');
});

test('single click sets start, second click sets end (ordered)', () => {
  let s = { from: null, to: null };
  s = applyDayClick(s, '2026-05-11');
  assert.deepEqual(s, { from: '2026-05-11', to: null });
  s = applyDayClick(s, '2026-05-07');                 // earlier end -> reorder
  assert.deepEqual(s, { from: '2026-05-07', to: '2026-05-11' });
  s = applyDayClick(s, '2026-05-20');                 // click after complete range -> new start
  assert.deepEqual(s, { from: '2026-05-20', to: null });
});

test('double click selects a single day', () => {
  assert.deepEqual(applyDayDoubleClick({ from: '2026-05-01', to: '2026-05-09' }, '2026-05-15'), { from: '2026-05-15', to: '2026-05-15' });
});

test('isInRange and shiftMonth', () => {
  assert.ok(isInRange('2026-05-09', '2026-05-07', '2026-05-11'));
  assert.ok(!isInRange('2026-05-12', '2026-05-07', '2026-05-11'));
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
});
```

- [ ] **Step 2: Run, confirm fail.** `cd web/react-gui && npx tsx --test tests/rangeCalendarModel.test.ts`.

- [ ] **Step 3: Implement `rangeCalendarModel.ts`:**

```ts
export interface RangeValue { from: string | null; to: string | null }
export interface GridDay { date: string; day: number; inMonth: boolean; isFuture: boolean }

function pad(n: number): string { return String(n).padStart(2, '0'); }
function iso(y: number, m: number, d: number): string { return `${y}-${pad(m)}-${pad(d)}`; }

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = (year * 12 + (month - 1)) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

export function monthGridDays(year: number, month: number, todayIso: string): GridDay[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const startDow = (first.getUTCDay() + 6) % 7;          // Monday=0
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: GridDay[] = [];
  const push = (y: number, m: number, d: number, inMonth: boolean) => {
    const date = iso(y, m, d);
    cells.push({ date, day: d, inMonth, isFuture: date > todayIso });
  };
  const prev = shiftMonth(year, month, -1);
  const prevDays = new Date(Date.UTC(prev.year, prev.month, 0)).getUTCDate();
  for (let i = startDow - 1; i >= 0; i -= 1) push(prev.year, prev.month, prevDays - i, false);
  for (let d = 1; d <= daysInMonth; d += 1) push(year, month, d, true);
  const next = shiftMonth(year, month, 1);
  let d = 1;
  while (cells.length % 7 !== 0) { push(next.year, next.month, d, false); d += 1; }
  return cells;
}

export function isInRange(date: string, from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  return date >= from && date <= to;
}

export function applyDayClick(state: RangeValue, date: string): RangeValue {
  if (!state.from || (state.from && state.to)) return { from: date, to: null };
  return date < state.from ? { from: date, to: state.from } : { from: state.from, to: date };
}

export function applyDayDoubleClick(_state: RangeValue, date: string): RangeValue {
  return { from: date, to: date };
}
```

- [ ] **Step 4: Run, confirm pass; commit.**

```bash
cd web/react-gui && npx tsx --test tests/rangeCalendarModel.test.ts
git add web/react-gui/src/components/farming/rangeCalendarModel.ts web/react-gui/tests/rangeCalendarModel.test.ts
git commit -m "feat(export): pure range-calendar model"
```

---

## Slice 2 — RangeCalendar component + export API + DataExportSection

**Files:**
- Create: `web/react-gui/src/components/farming/RangeCalendar.tsx`
- Create: `web/react-gui/src/components/farming/DataExportSection.tsx`
- Modify: `web/react-gui/src/services/api.ts`
- Tests: `web/react-gui/src/components/farming/__tests__/DataExportSection.test.tsx`

### Task 2.1 — RangeCalendar component

- [ ] **Step 1: Implement `RangeCalendar.tsx`** — controlled component using the model. Props:
  `{ value: RangeValue; onChange: (v: RangeValue) => void; todayIso: string }`. Renders the month
  grid (Mon–Sun headers), `‹ ›` month nav (local `[year,month]` state), day buttons: disabled when
  `isFuture` or `!inMonth`; `onClick` → `onChange(applyDayClick(value, date))`; `onDoubleClick` →
  `onChange(applyDayDoubleClick(value, date))`; selected/in-range styled with theme tokens
  (`bg-[var(--primary)]` for endpoints, `bg-[var(--secondary-bg)]` for in-range). Each day button has
  `data-testid={`day-${date}`}` and `aria-pressed` for endpoints.

- [ ] **Step 2: Component renders** — quick smoke test (rendered grid has 42/35 buttons, future disabled). Add to the DataExportSection test file.

### Task 2.2 — export download API

- [ ] **Step 1: Write the API test** in `DataExportSection.test.tsx` (mock axios; assert URL + params + blob handling). 

- [ ] **Step 2: Add to `services/api.ts`:**

```ts
export const zoneExportAPI = {
  download: async (zoneId: number, opts: { from: string; to: string; granularity: 'raw' | 'hourly' | 'daily' }): Promise<void> => {
    const res = await api.get(`/api/history/zones/${zoneId}/export.csv`, {
      params: { from: opts.from, to: opts.to, granularity: opts.granularity },
      responseType: 'blob',
    });
    const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zone-${zoneId}-${opts.from}_${opts.to}-${opts.granularity}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  },
};
```

### Task 2.3 — DataExportSection

- [ ] **Step 1: Write the test** `DataExportSection.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DataExportSection } from '../DataExportSection';
import { zoneExportAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({ zoneExportAPI: { download: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe('DataExportSection', () => {
  it('downloads the selected range + granularity', async () => {
    render(<DataExportSection zoneId={12} todayIso="2026-06-03" />);
    fireEvent.doubleClick(screen.getByTestId('day-2026-06-01'));   // single-day range
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(zoneExportAPI.download).toHaveBeenCalledWith(12, { from: '2026-06-01', to: '2026-06-01', granularity: 'raw' }));
  });

  it('disables download until a range is chosen', () => {
    render(<DataExportSection zoneId={12} todayIso="2026-06-03" />);
    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run, confirm fail.** `npm run test:unit:vitest -- DataExportSection`.

- [ ] **Step 3: Implement `DataExportSection.tsx`** — holds `value: RangeValue`, `granularity` state; renders `<RangeCalendar>`, a granularity `<select>` (raw/hourly/daily), the selected-range summary, and a Download button (disabled when `!value.from`); on click calls `zoneExportAPI.download(zoneId, { from, to: value.to ?? value.from, granularity })` with loading/error state. All strings via `t('zone.export.*')`.

- [ ] **Step 4: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/components/farming/RangeCalendar.tsx web/react-gui/src/components/farming/DataExportSection.tsx web/react-gui/src/services/api.ts web/react-gui/src/components/farming/__tests__/DataExportSection.test.tsx
git commit -m "feat(export): range calendar, export section, blob download"
```

---

## Slice 3 — Helper `buildZoneExportCsv`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- Mirror: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js`
- Modify: `scripts/test-history-helper.js`

### Task 3.1 — raw export rows

- [ ] **Step 1: Write the test** (soil device, two raw rows, raw export → tidy rows with depth):

```js
test('buildZoneExportCsv raw emits tidy rows with depth and source', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at) VALUES('AA00000000000001','Chameleon 1','KIWI_SENSOR',1,12,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.2),
        ('AA00000000000001','2026-06-01T09:00:00.000Z',6.4);
    `);
    const res = await helper.buildZoneExportCsv(db, { zoneId: 12, from: '2026-06-01', to: '2026-06-01', granularity: 'raw', nowMs: Date.parse('2026-06-03T00:00:00.000Z') });
    assert.deepStrictEqual(res.columns, helper.RAW_CSV_COLUMNS);
    const swt1 = res.rows.find((r) => r.variable === 'swt_1' && r.value === 6.2);
    assert.ok(swt1);
    assert.strictEqual(swt1.zone, 'Zone B');
    assert.strictEqual(swt1.card, 'soil');
    assert.strictEqual(swt1.source, 'Chameleon 1');
    assert.strictEqual(swt1.unit, 'kPa');
    assert.ok(!res.rows.some((r) => /[A-F0-9]{16}/.test(String(r.source))), 'no raw DevEUI');
  } finally { db.close(); }
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** `buildZoneExportCsv(db, options)` raw branch: validate range/granularity; compute `[startOfLocalDayMs(from,tz), startOfLocalDayMs(to,tz)+86400000)`; resolve zone + `deriveCardsForZone`; for each non-gateway card/source query `device_data` over the range; map each (timestamp, channel) → a `RAW_CSV_COLUMNS` row (`timestamp` = recorded_at, `value`, `unit` from the channel, `depth_cm` from the source's depth fields, `source` display-safe name, `card` = cardType, `zone` = name, `timezone` = tz). Return `{ columns: RAW_CSV_COLUMNS, rows }`. Export it.

- [ ] **Step 4: Run, confirm pass.**

### Task 3.2 — hourly/daily export rows + range guard

- [ ] **Step 1: Add tests**: (a) daily export returns `AGG_CSV_COLUMNS` rows from a seeded rollup + today live; (b) raw range > 92 days throws/returns a guard error; (c) empty range → `rows: []`.

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement** the hourly/daily branch: for each card/source/channel call the existing `rollups+live` read over the range at that level; map each bucket → an `AGG_CSV_COLUMNS` row. Add the range guard: `raw` span > 92 days or `hourly` > 730 days → `throw Object.assign(new Error('range too large for this granularity'), { code: 'RANGE_TOO_LARGE', suggestion: 'choose a coarser granularity' })`. Return `{ columns: AGG_CSV_COLUMNS, rows }`.

- [ ] **Step 4: Run, confirm pass; mirror to bcm2709; commit.**

```bash
node scripts/test-history-helper.js
git add conf/.../osi-history-helper/index.js (both) scripts/test-history-helper.js
git commit -m "feat(export): buildZoneExportCsv for raw/hourly/daily with range guard"
```

---

## Slice 4 — Export endpoint in flows

**Files:** `flows.json` (both profiles), `scripts/verify-sync-flow.js`.

### Task 4.1 — `GET /api/history/zones/:zoneId/export.csv`

- [ ] **Step 1: Add a verifier assertion** to `scripts/verify-sync-flow.js`:

```js
expectIncludes('Zone CSV Export', 'osiHistory.buildZoneExportCsv', 'export endpoint builds the zone CSV via the helper');
```

- [ ] **Step 2: Run, confirm fail.** `node scripts/verify-sync-flow.js`.

- [ ] **Step 3: Add nodes** to `flows.json` (bcm2712), mirrored to bcm2709:
  - `http in` `GET /api/history/zones/:zoneId/export.csv`.
  - JWT auth + zone-access check (reuse the existing pattern from neighbouring zone endpoints).
  - A `function` node "Zone CSV Export":

```js
const osiHistory = global.get('osiHistory');
const db = /* existing history DB handle pattern, as in History API Router */;
const zoneId = Number(msg.req.params.zoneId);
const { from, to, granularity } = msg.req.query;
try {
  const { columns, rows } = await osiHistory.buildZoneExportCsv(db, { zoneId, from, to, granularity: granularity || 'raw', nowMs: Date.now() });
  msg.payload = osiHistory.toCsv(columns, rows);
  msg.headers = { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="zone-${zoneId}-${from}_${to}-${granularity || 'raw'}.csv"` };
  msg.statusCode = 200;
} catch (err) {
  msg.statusCode = err && err.code === 'RANGE_TOO_LARGE' ? 413 : 400;
  msg.headers = { 'Content-Type': 'application/json' };
  msg.payload = JSON.stringify({ error: String(err && err.message || err), suggestion: err && err.suggestion });
}
return msg;
```

  Wire `http in -> auth -> function -> http response`. Validate `from/to/granularity` (400 on bad input).

- [ ] **Step 4: Mirror to bcm2709; run verification.**

```bash
node scripts/verify-sync-flow.js && scripts/check-mqtt-topics.sh
git add conf/.../flows.json (both) scripts/verify-sync-flow.js
git commit -m "feat(export): zone CSV range export endpoint"
```

---

## Slice 5 — Wire into ZoneConfigModal + i18n

**Files:** `ZoneConfigModal.tsx`, `web/react-gui/public/locales/*/*.json` (the namespace the modal uses), tests.

### Task 5.1 — add the section

- [ ] **Step 1: Add a test** that `ZoneConfigModal` renders the export section (calendar present) for an existing zone. (Extend an existing modal test or add one; mock `zoneExportAPI`.)

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Edit `ZoneConfigModal.tsx`** — inside the sections container (`<div className="p-5 flex flex-col gap-4">`), add a new `rounded-xl border` block titled "Data export" rendering `<DataExportSection zoneId={zone.id} todayIso={todayIso} />` where `todayIso` is `new Date().toISOString().slice(0,10)`. Only render when editing an existing zone (has `zone.id`).

- [ ] **Step 4: Add i18n keys** `zone.export.title/from/to/granularity/raw/hourly/daily/download/selectRange/rangeSummary/error/tooLarge` to all locale files of the modal's namespace.

- [ ] **Step 5: Run, confirm pass; build; commit.**

```bash
cd web/react-gui && npm run test:unit && npm run build
git add web/react-gui/src/components/farming/ZoneConfigModal.tsx web/react-gui/public/locales web/react-gui/src/components/farming/__tests__
git commit -m "feat(export): add Data export section to zone settings"
```

---

## Slice 6 — Live kaba100 verification

**Files:** `docs/ux/history-data-visualization-kaba100-issues.md` (append).

- [ ] **Step 1: Deploy** updated helper + flows to `/srv/node-red/` and the GUI build to `/usr/lib/node-red/gui/` (tar-pipe; never overwrite `/data/db/farming.db`); restart Node-RED.
- [ ] **Step 2: Verify** (temp user as in prior rounds, restore after): open a zone's ⚙ settings → Data export; double-click a day → download Raw CSV; confirm it opens with the tidy header + `depth_cm` and includes today; pick Daily for a wide range → smaller file; request a >92-day Raw range → friendly 413 error.
- [ ] **Step 3: Record** results + a sample CSV header in the issues doc; final `node scripts/test-history-helper.js && node scripts/verify-sync-flow.js && (cd web/react-gui && npm run test:unit && npm run build)`.

```bash
git add docs/ux/history-data-visualization-kaba100-issues.md
git commit -m "docs(export): record zone CSV range export verification"
```

---

## Self-review (coverage)

- Placement in `ZoneConfigModal` (spec §2) → Slice 5.
- Calendar selection rules (§2) → Slice 1 (model) + Slice 2 (component).
- Query-DB source, raw + hourly/daily (§3.2) → Slice 3.
- Granularity selector + recency/today (§2) → Slice 2 (UI) + Slice 3 (live read).
- Tidy format reuse (§2/§3.2) → Slice 3 (RAW/AGG columns + toCsv).
- Endpoint + auth + headers + range guard (§3.1) → Slice 4 + Slice 3 (guard).
- Frontend download (§3.3) → Slice 2.
- Tests/verification (§6) → per-slice + Slice 6 live.

## Acceptance criteria

- Zone ⚙ settings shows a Data export section with a working month range-calendar (double-click = single day; click-start + click-end = range; future disabled; month nav).
- Download produces a tidy long CSV for the zone/range at the chosen granularity (Raw/Hourly/Daily), with `depth_cm` on soil rows and no raw DevEUI, today included.
- Over-large raw ranges return a friendly error; empty ranges return a header-only CSV.
- `node scripts/test-history-helper.js`, `node scripts/verify-sync-flow.js`, `npm run test:unit`, `npm run build` pass; profile parity holds; live kaba100 verified.
