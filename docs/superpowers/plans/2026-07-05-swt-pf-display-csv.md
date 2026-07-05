# SWT pF Display + CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** German soil-science users see soil water tension as pF on live dashboard surfaces (behind a local display preference) and every zone CSV export always carries both kPa and pF — with zero database or sync changes.

**Architecture:** pF is derived at read time from canonical kPa (`pF = log10(kPa*10)`), per the revised spec `docs/superpowers/specs/2026-07-05-swt-pf-unit-support-design.md`. One converter pair exists twice: in the React GUI (`utils/swt.ts`, drives a shared formatter + a localStorage display preference) and in the edge history helper (`osi-history-helper`, pairs every SWT kPa export row with a derived pF row inside the single CSV choke point `rawZoneExportRows`/`csvRowsFromAggregate`). Both are pinned to the same golden vectors.

**Tech Stack:** React 18 + TypeScript + vitest (jsdom) in `web/react-gui`; plain Node.js CommonJS helper + bespoke `test()` harness (`scripts/test-history-helper.js`, needs the `sqlite3` CLI) on the edge.

## Global Constraints

- **No schema, no sync, no scheduler changes.** This plan must not touch `database/`, any SQLite trigger, `flows.json`, or sync payloads. (Threshold authoring is a separate, later slice.)
- **Conversion rule (verbatim from spec):** `pF = log10(kPa * 10)`; for `NULL`, non-finite, or `<= 0` kPa the derived pF is `null`; converters never clamp and never round; display shows pF at 2 decimals; CSV carries pF rounded to 4 decimals.
- **Golden vectors:** `10 → 2.00`, `30 → 2.4771212547196626` (≈2.4771 @ 4dp), `60 → 2.7781512503836436`, `300 → 3.4771212547196626`, `0 → null`, `null → null`.
- **Profile parity:** any change under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` must be copied byte-identically to `conf/full_raspberrypi_bcm27xx_bcm2709/files/`; `node scripts/verify-profile-parity.js` must pass. Do NOT touch bcm2708.
- **Frontend gates:** `npm run test:unit` and `npm run typecheck` (run from `web/react-gui/`).
- **Edge gate:** `node scripts/test-history-helper.js` (from repo root; requires `sqlite3` on PATH).
- **localStorage key (verbatim from settings spec):** `osi.display.swtUnit` = `'kPa' | 'pF'`, default `'kPa'`. Components never read localStorage directly — only via the preference module.
- Work on a feature branch off `main`; commit at the end of every task. Note: the two specs this plan implements land with branch `docs/swt-pf-settings-review-updates` — merge/rebase that first if it hasn't reached `main` yet.

---

### Task 1: pF converters + shared formatter (`utils/swt.ts`)

**Files:**
- Modify: `web/react-gui/src/utils/swt.ts` (append; existing exports unchanged)
- Test: `web/react-gui/src/utils/__tests__/swt.test.ts` (new)

**Interfaces:**
- Consumes: existing `toFiniteSwtValue(value: unknown): number | null` in the same file.
- Produces: `export type SwtUnit = 'kPa' | 'pF'`; `kpaToPf(kpa: unknown): number | null`; `pfToKpa(pf: unknown): number | null`; `formatSwtValue(kpa: unknown, unit: SwtUnit): string | null` (returns e.g. `'30.0 kPa'`, `'2.48 pF'`, `'saturated'` for `kPa <= 0` under pF, `null` for missing values). Tasks 2–4 rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/utils/__tests__/swt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { formatSwtValue, kpaToPf, pfToKpa } from '../swt';

describe('kpaToPf golden vectors', () => {
  it('matches the contract-pinned vectors', () => {
    expect(kpaToPf(10)).toBeCloseTo(2.0, 12);
    expect(kpaToPf(30)).toBeCloseTo(2.4771212547196626, 12);
    expect(kpaToPf(60)).toBeCloseTo(2.7781512503836436, 12);
    expect(kpaToPf(300)).toBeCloseTo(3.4771212547196626, 12);
  });

  it('returns null for missing, zero, negative, and non-finite input', () => {
    expect(kpaToPf(null)).toBeNull();
    expect(kpaToPf(undefined)).toBeNull();
    expect(kpaToPf(0)).toBeNull();
    expect(kpaToPf(-5)).toBeNull();
    expect(kpaToPf(Number.NaN)).toBeNull();
    expect(kpaToPf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(kpaToPf('30' as unknown)).toBeNull();
  });
});

describe('pfToKpa', () => {
  it('inverts kpaToPf', () => {
    for (const kpa of [0.5, 10, 30, 60, 123.4, 300]) {
      expect(pfToKpa(kpaToPf(kpa))).toBeCloseTo(kpa, 9);
    }
  });

  it('returns null for missing and non-finite input', () => {
    expect(pfToKpa(null)).toBeNull();
    expect(pfToKpa(Number.NaN)).toBeNull();
  });
});

describe('formatSwtValue', () => {
  it('formats kPa at 1 decimal', () => {
    expect(formatSwtValue(30, 'kPa')).toBe('30.0 kPa');
    expect(formatSwtValue(6.25, 'kPa')).toBe('6.3 kPa');
  });

  it('formats pF at 2 decimals', () => {
    expect(formatSwtValue(30, 'pF')).toBe('2.48 pF');
    expect(formatSwtValue(10, 'pF')).toBe('2.00 pF');
  });

  it('labels non-positive tension as saturated under pF', () => {
    expect(formatSwtValue(0, 'pF')).toBe('saturated');
    expect(formatSwtValue(-1, 'pF')).toBe('saturated');
  });

  it('keeps showing raw kPa for non-positive tension under kPa', () => {
    expect(formatSwtValue(0, 'kPa')).toBe('0.0 kPa');
  });

  it('returns null for missing values in both units', () => {
    expect(formatSwtValue(null, 'kPa')).toBeNull();
    expect(formatSwtValue(undefined, 'pF')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/utils/__tests__/swt.test.ts`
Expected: FAIL — `kpaToPf` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `web/react-gui/src/utils/swt.ts`:

```ts
export type SwtUnit = 'kPa' | 'pF';

// pF = log10(tension in hPa); 1 kPa = 10 hPa. Non-positive tension has no pF.
export function kpaToPf(kpa: unknown): number | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null || value <= 0) return null;
  return Math.log10(value * 10);
}

export function pfToKpa(pf: unknown): number | null {
  const value = toFiniteSwtValue(pf);
  if (value === null) return null;
  return Math.pow(10, value) / 10;
}

export function formatSwtValue(kpa: unknown, unit: SwtUnit): string | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null) return null;
  if (unit === 'pF') {
    const pf = kpaToPf(value);
    return pf === null ? 'saturated' : `${pf.toFixed(2)} pF`;
  }
  return `${value.toFixed(1)} kPa`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/utils/__tests__/swt.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Typecheck and commit**

```bash
cd web/react-gui && npm run typecheck && cd ../..
git add web/react-gui/src/utils/swt.ts web/react-gui/src/utils/__tests__/swt.test.ts
git commit -m "feat(gui): pF converters + shared SWT formatter with golden-vector tests"
```

---

### Task 2: display-preferences module

**Files:**
- Create: `web/react-gui/src/utils/displayPreferences.ts`
- Test: `web/react-gui/src/utils/__tests__/displayPreferences.test.tsx` (new; `.tsx` because it uses `renderHook`)

**Interfaces:**
- Consumes: `SwtUnit` from Task 1.
- Produces: `interface DisplayPreferences { swtUnit: SwtUnit }`; `readDisplayPreferences(): DisplayPreferences`; `writeDisplayPreferences(next: Partial<DisplayPreferences>): void`; `useDisplayPreferences(): DisplayPreferences`. (Names match the global-settings spec so the later settings page extends this module rather than renaming it.) Tasks 3–4 call `useDisplayPreferences()`.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/utils/__tests__/displayPreferences.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  readDisplayPreferences,
  useDisplayPreferences,
  writeDisplayPreferences,
} from '../displayPreferences';

describe('display preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults the SWT unit to kPa', () => {
    expect(readDisplayPreferences()).toEqual({ swtUnit: 'kPa' });
  });

  it('persists and reloads the SWT unit', () => {
    writeDisplayPreferences({ swtUnit: 'pF' });
    expect(window.localStorage.getItem('osi.display.swtUnit')).toBe('pF');
    expect(readDisplayPreferences()).toEqual({ swtUnit: 'pF' });
  });

  it('treats unknown stored values as kPa', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'bars');
    expect(readDisplayPreferences()).toEqual({ swtUnit: 'kPa' });
  });

  it('updates live consumers when the preference changes', () => {
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.swtUnit).toBe('kPa');
    act(() => {
      writeDisplayPreferences({ swtUnit: 'pF' });
    });
    expect(result.current.swtUnit).toBe('pF');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/utils/__tests__/displayPreferences.test.tsx`
Expected: FAIL — module `../displayPreferences` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `web/react-gui/src/utils/displayPreferences.ts`:

```ts
import { useEffect, useState } from 'react';

import type { SwtUnit } from './swt';

const SWT_UNIT_KEY = 'osi.display.swtUnit';
const PREFERENCES_EVENT = 'osi-display-preferences';

export interface DisplayPreferences {
  swtUnit: SwtUnit;
}

export function readDisplayPreferences(): DisplayPreferences {
  let swtUnit: SwtUnit = 'kPa';
  try {
    if (window.localStorage.getItem(SWT_UNIT_KEY) === 'pF') swtUnit = 'pF';
  } catch {
    // storage unavailable (private mode / SSR) — keep defaults
  }
  return { swtUnit };
}

export function writeDisplayPreferences(next: Partial<DisplayPreferences>): void {
  try {
    if (next.swtUnit) window.localStorage.setItem(SWT_UNIT_KEY, next.swtUnit);
    window.dispatchEvent(new Event(PREFERENCES_EVENT));
  } catch {
    // storage unavailable — preference stays session-default
  }
}

export function useDisplayPreferences(): DisplayPreferences {
  const [preferences, setPreferences] = useState<DisplayPreferences>(readDisplayPreferences);

  useEffect(() => {
    const onChange = () => setPreferences(readDisplayPreferences());
    window.addEventListener(PREFERENCES_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(PREFERENCES_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  return preferences;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/utils/__tests__/displayPreferences.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd web/react-gui && npm run typecheck && cd ../..
git add web/react-gui/src/utils/displayPreferences.ts web/react-gui/src/utils/__tests__/displayPreferences.test.tsx
git commit -m "feat(gui): local display-preferences module with SWT unit"
```

---

### Task 3: live device cards follow the preference (Kiwi + Chameleon)

**Files:**
- Modify: `web/react-gui/src/components/farming/KiwiSensorCard.tsx:310,431,439` (+ imports)
- Modify: `web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx:212-214` (+ imports)
- Test: `web/react-gui/src/components/farming/__tests__/KiwiSensorCard.test.tsx` (new; representative end-to-end preference test)

**Interfaces:**
- Consumes: `formatSwtValue`, `useDisplayPreferences` from Tasks 1–2.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/components/farming/__tests__/KiwiSensorCard.test.tsx` (fixture pattern copied from `LoRainGaugeCard.test.tsx` in the same directory):

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { KiwiSensorCard } from '../KiwiSensorCard';

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
  deviceMetadataAPI: { setSoilMoistureDepths: vi.fn().mockResolvedValue(undefined) },
  kiwiAPI: {
    setUplinkInterval: vi.fn().mockResolvedValue(undefined),
    enableTemperatureHumidity: vi.fn().mockResolvedValue(undefined),
  },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

const kiwiDevice: Device = {
  id: 1,
  deveui: '70B3D5E75E004202',
  name: 'Kiwi row 3',
  type_id: 'KIWI_SENSOR',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  irrigation_zone_id: null,
  is_claimed: true,
  claimed_by_username: 'test',
  claimed_by_user_uuid: 'uuid-1',
  last_seen: '2026-07-05T12:00:00Z',
  latest_data: {
    swt_1: 30,
  },
} as unknown as Device;

describe('KiwiSensorCard SWT unit preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders SWT in kPa by default', () => {
    render(<KiwiSensorCard device={kiwiDevice} />);
    expect(screen.getByText('30.0 kPa')).toBeInTheDocument();
    expect(screen.queryByText('2.48 pF')).not.toBeInTheDocument();
  });

  it('renders SWT in pF when the display preference is pF', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<KiwiSensorCard device={kiwiDevice} />);
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
    expect(screen.queryByText('30.0 kPa')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/components/farming/__tests__/KiwiSensorCard.test.tsx`
Expected: the default-kPa test may already pass; the pF test FAILS (`2.48 pF` not found).

- [ ] **Step 3: Wire the preference into both components**

`web/react-gui/src/components/farming/KiwiSensorCard.tsx`:

Change the import on line 8 and add the preference import:

```tsx
import { canonicalSwtChannels, formatSwtValue } from '../../utils/swt';
import { useDisplayPreferences } from '../../utils/displayPreferences';
```

Inside the `KiwiSensorCard` component body, directly after line 310 (`const [swt1, swt2] = canonicalSwtChannels(device.latest_data);`), add:

```tsx
  const { swtUnit } = useDisplayPreferences();
```

Replace line 431:

```tsx
          {renderValue('swt_1', swt1 != null ? `${swt1.toFixed(1)} kPa` : null)}
```

with:

```tsx
          {renderValue('swt_1', formatSwtValue(swt1, swtUnit))}
```

Replace line 439:

```tsx
            {renderValue('swt_2', `${swt2.toFixed(1)} kPa`)}
```

with:

```tsx
            {renderValue('swt_2', formatSwtValue(swt2, swtUnit))}
```

`web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx`:

Add imports at the top of the file:

```tsx
import { formatSwtValue } from '../../utils/swt';
import { useDisplayPreferences } from '../../utils/displayPreferences';
```

Inside the component containing lines 212–214, add near its other hooks:

```tsx
  const { swtUnit } = useDisplayPreferences();
```

Replace lines 212–214:

```tsx
  const liveSwt1 = formatLiveMetric(device.latest_data?.swt_1, 'kPa', 1);
  const liveSwt2 = formatLiveMetric(device.latest_data?.swt_2, 'kPa', 1);
  const liveSwt3 = formatLiveMetric(device.latest_data?.swt_3, 'kPa', 1);
```

with:

```tsx
  const liveSwt1 = formatSwtValue(device.latest_data?.swt_1, swtUnit);
  const liveSwt2 = formatSwtValue(device.latest_data?.swt_2, swtUnit);
  const liveSwt3 = formatSwtValue(device.latest_data?.swt_3, swtUnit);
```

(`formatLiveMetric` stays — it is still used for the section's non-SWT metrics. If TypeScript then reports it unused, delete the local function.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web/react-gui && npx vitest run src/components/farming/__tests__/KiwiSensorCard.test.tsx`
Expected: PASS (both unit modes).

- [ ] **Step 5: Full frontend gates and commit**

```bash
cd web/react-gui && npm run typecheck && npm run test:unit && cd ../..
git add web/react-gui/src/components/farming/KiwiSensorCard.tsx web/react-gui/src/components/farming/DraginoChameleonSwtSection.tsx web/react-gui/src/components/farming/__tests__/KiwiSensorCard.test.tsx
git commit -m "feat(gui): Kiwi + Chameleon live SWT values follow the global unit preference"
```

---

### Task 4: zone summary + soil tab follow the preference

**Files:**
- Modify: `web/react-gui/src/components/farming/IrrigationZoneCard.tsx:353` (+ hook + imports; `soilNow` is computed at line 143)
- Modify: `web/react-gui/src/components/farming/environment/SoilTab.tsx:47,55` (+ hook + imports)
- Test: extend `web/react-gui/src/utils/__tests__/swt.test.ts` (no new component fixtures — both edits reuse the Task 1 formatter verbatim, and the preference→render path is already covered end-to-end by the Task 3 KiwiSensorCard test)

**Interfaces:**
- Consumes: `formatSwtValue`, `useDisplayPreferences` from Tasks 1–2.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Add a regression test pinning the zone-summary fallback string**

The zone card shows `'—'` when no SWT reading exists. Append to `web/react-gui/src/utils/__tests__/swt.test.ts` inside the `formatSwtValue` describe block:

```ts
  it('lets callers keep their placeholder for missing readings', () => {
    expect(formatSwtValue(null, 'pF') ?? '—').toBe('—');
  });
```

Run: `cd web/react-gui && npx vitest run src/utils/__tests__/swt.test.ts` — Expected: PASS (guards the `?? '—'` pattern used below).

- [ ] **Step 2: Wire IrrigationZoneCard**

`web/react-gui/src/components/farming/IrrigationZoneCard.tsx`:

Add imports at the top:

```tsx
import { formatSwtValue } from '../../utils/swt';
import { useDisplayPreferences } from '../../utils/displayPreferences';
```

(If the file already imports from `'../../utils/swt'`, merge `formatSwtValue` into that import list.)

Inside the component, near line 143 (`const soilNow = summarizeSwtValues(collectDeviceSwtValues(devices));`), add:

```tsx
  const { swtUnit } = useDisplayPreferences();
```

Replace line 353:

```tsx
                {soilNow.swt != null ? `${soilNow.swt.toFixed(1)} kPa` : '—'}
```

with:

```tsx
                {formatSwtValue(soilNow.swt, swtUnit) ?? '—'}
```

- [ ] **Step 3: Wire SoilTab**

`web/react-gui/src/components/farming/environment/SoilTab.tsx`:

Change the line-4 import and add the preference import:

```tsx
import { collectDeviceSwtValues, formatSwtValue } from '../../../utils/swt';
import { useDisplayPreferences } from '../../../utils/displayPreferences';
```

Inside the `SoilTab` component, after `const { t } = useTranslation('devices');`, add:

```tsx
  const { swtUnit } = useDisplayPreferences();
```

Replace both occurrences (lines 47 and 55) of:

```tsx
                {representativeSwt!.toFixed(1)} kPa
```

with:

```tsx
                {formatSwtValue(representativeSwt, swtUnit)}
```

(The surrounding `hasSwt` guard guarantees `representativeSwt` is non-null, so the formatter never returns `null` here.)

- [ ] **Step 4: Run full frontend gates**

Run: `cd web/react-gui && npm run typecheck && npm run test:unit`
Expected: PASS — including the untouched `IrrigationZoneCardData.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/components/farming/IrrigationZoneCard.tsx web/react-gui/src/components/farming/environment/SoilTab.tsx web/react-gui/src/utils/__tests__/swt.test.ts
git commit -m "feat(gui): zone soil summary + soil tab follow the SWT unit preference"
```

---

### Task 5: CSV export pairs every SWT kPa row with a pF row (edge helper)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
  - add `kpaToPf`, `isSwtKpaChannel`, `pfExportRow` (near `roundTo`, line ~137)
  - inject pairing in `rawZoneExportRows` (line ~1725) and `csvRowsFromAggregate` (line ~2022)
  - export `kpaToPf` from the `module.exports` block (line ~2502)
- Test: `scripts/test-history-helper.js` — 3 existing assertions updated + 3 new tests

**Interfaces:**
- Consumes: existing helper internals `toFiniteNumber`, `roundTo(value, decimals)`, `seriesLabel`, the tidy row shape `{ timestamp, site, zone, series_label, card_type, source_key, channel_key, depth_cm, array_id, unit, value }`.
- Produces: `helper.kpaToPf(kpa) -> number | null` (exported for tests and for the later threshold slice); paired export rows with `channel_key: '<swt_channel>_pf'`, `unit: 'pF'`, `series_label: '<kPa label> (pF)'`, `value` rounded to 4 decimals. Both `buildZoneExportCsv` (on-demand download) and `writeZoneCsv` (persisted `/data/exports` rollups) flow through these two functions, so both gain pF automatically.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-history-helper.js` (after the existing `buildZoneExportCsv` tests, line ~1400):

```js
test('kpaToPf matches the contract golden vectors', () => {
  assert.ok(Math.abs(helper.kpaToPf(10) - 2) < 1e-12);
  assert.ok(Math.abs(helper.kpaToPf(30) - 2.4771212547196626) < 1e-12);
  assert.ok(Math.abs(helper.kpaToPf(60) - 2.7781512503836436) < 1e-12);
  assert.ok(Math.abs(helper.kpaToPf(300) - 3.4771212547196626) < 1e-12);
  assert.strictEqual(helper.kpaToPf(0), null);
  assert.strictEqual(helper.kpaToPf(-4), null);
  assert.strictEqual(helper.kpaToPf(null), null);
  assert.strictEqual(helper.kpaToPf('nope'), null);
});

test('raw zone export pairs every SWT kPa row with a derived pF row', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,chameleon_swt1_depth_cm,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,5,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',6.2);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.strictEqual(res.rows.length, 2);
    const kpaRow = res.rows.find((row) => row.channel_key === 'swt_1');
    const pfRow = res.rows.find((row) => row.channel_key === 'swt_1_pf');
    assert.ok(kpaRow, 'kPa row present');
    assert.ok(pfRow, 'pF row present');
    assert.strictEqual(pfRow.unit, 'pF');
    assert.strictEqual(pfRow.value, 1.7924); // log10(62) rounded to 4 dp
    assert.strictEqual(pfRow.timestamp, kpaRow.timestamp);
    assert.strictEqual(pfRow.depth_cm, kpaRow.depth_cm);
    assert.strictEqual(pfRow.source_key, kpaRow.source_key);
    assert.strictEqual(pfRow.series_label, `${kpaRow.series_label} (pF)`);
  } finally {
    db.close();
  }
});

test('zone export emits no pF row for non-positive kPa values', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:00:00.000Z',0);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'raw',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    assert.ok(res.rows.some((row) => row.channel_key === 'swt_1' && row.value === 0), 'kPa zero row kept');
    assert.ok(!res.rows.some((row) => row.channel_key === 'swt_1_pf'), 'no pF row for saturated soil');
  } finally {
    db.close();
  }
});

test('aggregate zone export derives pF from the aggregated kPa mean', async () => {
  const db = createCliSqliteDb();
  try {
    db.runSql(`
      INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'u','h','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at) VALUES(12,'Zone B',1,'zb','UTC','2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,chameleon_enabled,created_at,updated_at)
        VALUES('AA00000000000001','Chameleon 1','DRAGINO_LSN50',1,12,1,'2026-05-31T00:00:00.000Z','2026-05-31T00:00:00.000Z');
      INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES
        ('AA00000000000001','2026-06-01T08:10:00.000Z',6.2),
        ('AA00000000000001','2026-06-01T08:20:00.000Z',6.4);
    `);
    const res = await helper.buildZoneExportCsv(db, {
      zoneId: 12,
      from: '2026-06-01',
      to: '2026-06-01',
      granularity: 'hourly',
      nowMs: Date.parse('2026-06-03T00:00:00.000Z'),
    });
    const pfRow = res.rows.find((row) => row.channel_key === 'swt_1_pf');
    assert.ok(pfRow, 'aggregate pF row present');
    assert.strictEqual(pfRow.unit, 'pF');
    assert.strictEqual(pfRow.value, 1.7993); // pF(mean 6.3 kPa) = log10(63) @ 4 dp
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node scripts/test-history-helper.js`
Expected: the 4 new tests FAIL (`helper.kpaToPf` undefined / no `swt_1_pf` rows); all pre-existing tests still PASS.

- [ ] **Step 3: Implement pairing in the canonical helper**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`, directly after the `roundTo` function (line ~142), add:

```js
// pF = log10(tension in hPa); 1 kPa = 10 hPa. Non-positive tension has no pF.
function kpaToPf(kpa) {
  const value = toFiniteNumber(kpa);
  if (value === null || value <= 0) return null;
  return Math.log10(value * 10);
}

function isSwtKpaChannel(channel) {
  return Boolean(channel) && channel.unit === 'kPa' && /^swt_/.test(String(channel.id || ''));
}

function pfExportRow(kpaRow, channel) {
  const pf = kpaToPf(kpaRow.value);
  if (pf === null) return null;
  return {
    ...kpaRow,
    series_label: `${kpaRow.series_label} (pF)`,
    channel_key: `${channel.id}_pf`,
    unit: 'pF',
    value: roundTo(pf, 4),
  };
}
```

In `rawZoneExportRows` (line ~1725), the inner channel loop currently ends with a single `rows.push({ ... })` object literal (fields `timestamp` … `value: roundTo(value)`). Assign that literal to a variable and pair it:

```js
        for (const channel of channels) {
          const value = channelValue(row, channel);
          if (value === null) continue;
          const csvRow = {
            timestamp: row.recorded_at,
            site: scope.site,
            zone: zoneName,
            series_label: seriesLabel(sourceName, channel),
            card_type: card.cardType,
            source_key: sourceKeyForCsv(card, device),
            channel_key: channel.id,
            depth_cm: soilDepthCm(device, channel.id),
            array_id: arrayId,
            unit: channel.unit || null,
            value: roundTo(value),
          };
          rows.push(csvRow);
          if (isSwtKpaChannel(channel)) {
            const pfRow = pfExportRow(csvRow, channel);
            if (pfRow) rows.push(pfRow);
          }
        }
```

In `csvRowsFromAggregate` (line ~2022), apply the same pattern to its `rows.push({ ... })`:

```js
    for (const channel of channels) {
      const stats = bucket.series && bucket.series[channel.id];
      if (!stats || Number(stats.sampleCount || 0) === 0) continue;
      const csvRow = {
        timestamp: bucket.bucketStart,
        site: context.site || '',
        zone: context.zone || '',
        series_label: seriesLabel(sourceName, channel),
        card_type: card.cardType,
        source_key: sourceKeyForCsv(card, device),
        channel_key: channel.id,
        depth_cm: soilDepthCm(device, channel.id),
        array_id: arrayId == null ? null : arrayId,
        unit: channel.unit || stats.unit || null,
        value: stats.mean,
      };
      rows.push(csvRow);
      if (isSwtKpaChannel(channel)) {
        const pfRow = pfExportRow(csvRow, channel);
        if (pfRow) rows.push(pfRow);
      }
    }
```

Add `kpaToPf,` to the `module.exports` block (line ~2502, alphabetically near the other lowercase exports).

- [ ] **Step 4: Update the three pre-existing assertions the pairing breaks**

In `scripts/test-history-helper.js`:

1. Test `'buildZoneExportCsv raw emits tidy rows with depth and source'` (line ~1258): change `assert.strictEqual(res.rows.length, 2);` to `assert.strictEqual(res.rows.length, 4);` (2 kPa rows + 2 paired pF rows).
2. Test `'buildZoneExportCsv channels filter keeps only requested canonical channel keys'` (line ~1301): change

```js
    assert.deepStrictEqual(Array.from(new Set(res.rows.map((row) => row.channel_key))), ['swt_1']);
```

to:

```js
    assert.deepStrictEqual(Array.from(new Set(res.rows.map((row) => row.channel_key))).sort(), ['swt_1', 'swt_1_pf']);
```

3. Test `'buildZoneExportCsv accepts legacy aliases but emits canonical channel keys'` (line ~1327): change

```js
    assert.ok(res.rows.every((row) => row.channel_key === 'swt_1'));
```

to:

```js
    assert.ok(res.rows.every((row) => row.channel_key === 'swt_1' || row.channel_key === 'swt_1_pf'));
```

- [ ] **Step 5: Run the full helper suite**

Run: `node scripts/test-history-helper.js`
Expected: ALL tests PASS (every pre-existing test plus the 4 new ones). If any other test fails on row counts or channel-key sets, it is the pairing showing up — update it with the same `swt_*_pf` reasoning as above and note it in the commit message.

- [ ] **Step 6: Commit (canonical profile only — parity comes next)**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js scripts/test-history-helper.js
git commit -m "feat(export): pair every SWT kPa CSV row with a derived pF row (both units, all history)"
```

---

### Task 6: profile parity, CI wiring, contract pin, spec example fix

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js` (byte-identical copy)
- Modify: `.github/workflows/migrations.yml` (add the helper test as a CI step)
- Modify: `docs/contracts/sync-schema/canonicalization.md` (append the pF rule + golden vectors)

**Interfaces:**
- Consumes: the Task 5 helper changes.
- Produces: green `verify-profile-parity.js`; the contract-pinned conversion/rounding rule that osi-server's Java implementation must match later.

- [ ] **Step 1: Mirror the helper to bcm2709 and verify parity**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
```

Expected: both verifiers exit 0.

- [ ] **Step 2: Wire the helper suite into CI**

In `.github/workflows/migrations.yml`, after the line `- run: node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js` (line 22), add:

```yaml
      - run: node scripts/test-history-helper.js
```

(The job already installs the `sqlite3` CLI the suite needs.)

- [ ] **Step 3: Pin the conversion rule in the contract**

Append to `docs/contracts/sync-schema/canonicalization.md`:

```markdown
## SWT pF derivation (display/export derived unit)

pF is never stored or synced for measurements; every consumer derives it from
canonical kPa with this exact rule:

- `pF = log10(kPa * 10)` (pF is the decimal logarithm of tension in hPa; 1 kPa = 10 hPa)
- `kPa = 10^pF / 10`
- `NULL`, non-finite, or `<= 0` kPa derives `null` (no clamping, no substitute values)
- Display rounding: pF `toFixed(2)` (round-half-up); CSV export value: 4 decimals
- CSV pairing: each SWT kPa row is paired with a row whose `channel_key` gains the
  `_pf` suffix, `unit` is `pF`, and `series_label` gains the ` (pF)` suffix

Golden vectors (all implementations — edge JS, GUI TS, server Java — must match):

| kPa  | pF (exact double)     | pF @ 2 dp | pF @ 4 dp |
|------|------------------------|-----------|-----------|
| 10   | 2.0                    | 2.00      | 2.0000    |
| 30   | 2.4771212547196626     | 2.48      | 2.4771    |
| 60   | 2.7781512503836436     | 2.78      | 2.7782    |
| 300  | 3.4771212547196626     | 3.48      | 3.4771    |
| 0    | null                   | —         | —         |
| -5   | null                   | —         | —         |
| null | null                   | —         | —         |
```

- [ ] **Step 4: Run every gate**

```bash
node scripts/test-history-helper.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
cd web/react-gui && npm run typecheck && npm run test:unit && npm run build && cd ../..
git diff --check
```

Expected: everything green; `npm run build` completes.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js .github/workflows/migrations.yml docs/contracts/sync-schema/canonicalization.md
git commit -m "chore(export): bcm2709 parity + CI for history-helper tests + pF contract pin"
```

---

## Out of scope (deliberately)

- **History cards & analysis pF display** (chart axes, tooltips, soil-profile values, `channelLabels.ts`/`unitGrouping.ts`/`echartsOptions.ts`): separate follow-up plan — those surfaces get their unit labels from the server channel manifest and need their own design pass.
- **Schedule threshold authoring** (`threshold_unit`/`threshold_pf`): separate slice, blocked on issue #92 (schedules CHECK fix) and the deploy-time migration-runner prerequisite.
- **Settings page UI** for flipping `osi.display.swtUnit`: the global-settings plan. Until it ships, the preference is set via localStorage (exactly what the tests do), and all surfaces default to kPa.
- Kiwi mini-chart axes (the `SENSORS` defs with `unit: 'kPa'` at `KiwiSensorCard.tsx:25-26`) stay kPa — they belong to the history/analysis follow-up.
