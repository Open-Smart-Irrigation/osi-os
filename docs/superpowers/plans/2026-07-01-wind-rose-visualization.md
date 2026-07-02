# Wind Rose Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rotated-arrow "Direction history" grid in the S2120 `WindMonitor` modal with a real wind rose (16 directions × speed bins) rendered with echarts.

**Architecture:** A pure, unit-tested aggregator (`computeWindRose`) turns the modal's already-fetched wind history into a direction × speed-bin distribution. A presentational `WindRoseChart` component builds an echarts polar option and renders it through the existing `EChart` wrapper; because that module imports echarts, it is lazy-loaded from `WindMonitor` so echarts stays out of the main bundle.

**Tech Stack:** React + TypeScript, echarts `^5.6.0` (existing, lazy chunk), Vitest, existing `EChart` wrapper.

## Global Constraints

- No backend, schema, API, or history-card changes — reuse the modal's existing `wind_speed_mps` / `wind_direction_deg` fetch.
- echarts MUST NOT enter the main bundle: the only new module that imports `EChart`/echarts is `WindRoseChart.tsx`, and `WindMonitor` imports it via `React.lazy` inside `<Suspense>` (mirrors `src/pages/AnalysisRoute.tsx`).
- Reuse existing helpers: `COMPASS_POINTS`, `roundWindDirectionDegrees`, `toCompassDirection` in `src/utils/wind.ts`; the `EChart` wrapper in `src/components/analysis/EChart.tsx`.
- Meteorological convention: direction = where wind blows **from**; N at top, clockwise. The S2120 decoder is silent on from/to, so record that assumption and verify it by field/vendor sanity-check (Task 3).
- Frequencies are % of total valid (speed+direction finite) samples; `calmPct` + all petal percentages sum to 100 (within rounding).
- Calm threshold default: **0.5 m/s**. Speed bins default: `<1, 1–2, 2–3, 3–4, 4–5, 5+ m/s` (top bin is `[5, ∞)`, labelled `5+`).
- Tests run via `npm run test:unit` (Vitest covers `src/utils/__tests__` and `src/components/farming/__tests__`). Typecheck: `npm run typecheck`. All commands run from `web/react-gui/`.

---

### Task 1: `computeWindRose` pure aggregator

**Files:**
- Modify: `web/react-gui/src/utils/wind.ts` (append types + function; keep existing helpers)
- Test: `web/react-gui/src/utils/__tests__/wind.test.ts` (create)

**Interfaces:**
- Consumes: nothing new (reuses `COMPASS_POINTS`, `toCompassDirection` already in this file).
- Produces (later tasks rely on these exact names/types):

```ts
export interface WindSample {
  wind_speed_mps: number | null;
  wind_direction_deg: number | null;
}

export interface WindSpeedBin {
  label: string;        // e.g. '<1', '1–2', '5+'
  min: number;          // inclusive lower bound (m/s)
  max: number | null;   // exclusive upper bound; null = open-ended
  color: string;        // hex
}

export interface WindRoseSector {
  direction: string;    // 'N', 'NNE', ... (COMPASS_POINTS order)
  bins: number[];       // frequency % per speed bin, aligned to speedBins order
  totalPct: number;     // sum of bins
}

export interface WindRose {
  sectors: WindRoseSector[];   // length 16, COMPASS_POINTS order
  speedBins: WindSpeedBin[];   // the bins used (echo of input/default)
  validSamples: number;        // points with both speed & direction finite
  calmSamples: number;         // valid points with speed < calmThreshold
  calmPct: number;             // calmSamples / validSamples * 100, or 0
}

export interface WindRoseOptions {
  calmThreshold?: number;      // default 0.5
  speedBins?: WindSpeedBin[];  // default DEFAULT_WIND_SPEED_BINS
}

export const DEFAULT_WIND_SPEED_BINS: WindSpeedBin[];
export function computeWindRose(samples: WindSample[], options?: WindRoseOptions): WindRose;
```

- [ ] **Step 1: Write the failing tests**

Create `web/react-gui/src/utils/__tests__/wind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeWindRose, DEFAULT_WIND_SPEED_BINS } from '../wind';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const roseTotalPct = (r: ReturnType<typeof computeWindRose>) =>
  sum(r.sectors.map((s) => s.totalPct)) + r.calmPct;

describe('computeWindRose', () => {
  it('returns 16 sectors in COMPASS_POINTS order with default bins', () => {
    const rose = computeWindRose([]);
    expect(rose.sectors).toHaveLength(16);
    expect(rose.sectors[0].direction).toBe('N');
    expect(rose.sectors[4].direction).toBe('E');
    expect(rose.speedBins).toEqual(DEFAULT_WIND_SPEED_BINS);
    expect(rose.validSamples).toBe(0);
    expect(rose.calmPct).toBe(0);
  });

  it('ignores samples missing speed or direction', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 3, wind_direction_deg: null },
      { wind_speed_mps: null, wind_direction_deg: 90 },
      { wind_speed_mps: Number.NaN, wind_direction_deg: 90 },
    ]);
    expect(rose.validSamples).toBe(0);
  });

  it('buckets a sample into the correct direction sector and speed bin', () => {
    // 3.5 m/s from due East (90°) -> sector 'E' (index 4), bin '3–4' (index 3)
    const rose = computeWindRose([{ wind_speed_mps: 3.5, wind_direction_deg: 90 }]);
    expect(rose.validSamples).toBe(1);
    const east = rose.sectors[4];
    expect(east.direction).toBe('E');
    expect(east.bins[3]).toBeCloseTo(100);
    expect(east.totalPct).toBeCloseTo(100);
  });

  it('treats bin boundaries as [min, max): 1.0 -> "1–2", 5.0 -> "5+"', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 1.0, wind_direction_deg: 0 },
      { wind_speed_mps: 5.0, wind_direction_deg: 0 },
    ]);
    const north = rose.sectors[0];
    expect(north.bins[1]).toBeCloseTo(50); // '1–2'
    expect(north.bins[5]).toBeCloseTo(50); // '5+'
  });

  it('ignores null speed/direction even though Number(null) === 0', () => {
    // Regression guard: Number(null) is 0 (finite) and roundWindDirectionDegrees(null)
    // is 0, so without an explicit null check these would count as a calm N sample.
    const rose = computeWindRose([
      { wind_speed_mps: null, wind_direction_deg: 90 },
      { wind_speed_mps: 3, wind_direction_deg: null },
    ]);
    expect(rose.validSamples).toBe(0);
    expect(rose.calmSamples).toBe(0);
  });

  it('counts samples below the calm threshold as calm, excluded from petals', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 0.2, wind_direction_deg: 45 },
      { wind_speed_mps: 3, wind_direction_deg: 45 },
    ]);
    expect(rose.calmSamples).toBe(1);
    expect(rose.calmPct).toBeCloseTo(50);
    // the 0.2 sample must NOT contribute to any petal
    expect(sum(rose.sectors.map((s) => s.totalPct))).toBeCloseTo(50);
  });

  it('wraps direction at 0/360°: 358° and 2° both land in N', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 3, wind_direction_deg: 358 },
      { wind_speed_mps: 3, wind_direction_deg: 2 },
    ]);
    expect(rose.sectors[0].direction).toBe('N');
    expect(rose.sectors[0].totalPct).toBeCloseTo(100);
  });

  it('petal percentages plus calm always sum to 100 for non-empty input', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 0.1, wind_direction_deg: 10 },
      { wind_speed_mps: 2.5, wind_direction_deg: 100 },
      { wind_speed_mps: 6, wind_direction_deg: 200 },
      { wind_speed_mps: 4.2, wind_direction_deg: 280 },
    ]);
    expect(roseTotalPct(rose)).toBeCloseTo(100);
  });

  it('honors a custom calm threshold', () => {
    const rose = computeWindRose(
      [{ wind_speed_mps: 0.8, wind_direction_deg: 45 }],
      { calmThreshold: 1.0 },
    );
    expect(rose.calmSamples).toBe(1);
  });

  it('reports 100% calm and zero petals when every sample is calm', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 0.1, wind_direction_deg: 10 },
      { wind_speed_mps: 0.3, wind_direction_deg: 200 },
    ]);
    expect(rose.validSamples).toBe(2);
    expect(rose.calmSamples).toBe(2);
    expect(rose.calmPct).toBeCloseTo(100);
    expect(sum(rose.sectors.map((s) => s.totalPct))).toBeCloseTo(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web/react-gui && npx vitest run src/utils/__tests__/wind.test.ts`
Expected: FAIL — `computeWindRose` / `DEFAULT_WIND_SPEED_BINS` are not exported.

- [ ] **Step 3: Implement the aggregator**

Append to `web/react-gui/src/utils/wind.ts` (below the existing helpers; do not remove them):

```ts
export interface WindSample {
  wind_speed_mps: number | null;
  wind_direction_deg: number | null;
}

export interface WindSpeedBin {
  label: string;
  min: number;
  max: number | null;
  color: string;
}

export interface WindRoseSector {
  direction: string;
  bins: number[];
  totalPct: number;
}

export interface WindRose {
  sectors: WindRoseSector[];
  speedBins: WindSpeedBin[];
  validSamples: number;
  calmSamples: number;
  calmPct: number;
}

export interface WindRoseOptions {
  calmThreshold?: number;
  speedBins?: WindSpeedBin[];
}

// Blue→red ramp mirroring the reference wind-rose legend (theme-friendly).
export const DEFAULT_WIND_SPEED_BINS: WindSpeedBin[] = [
  { label: '<1', min: 0, max: 1, color: '#64748b' },
  { label: '1–2', min: 1, max: 2, color: '#2563eb' },
  { label: '2–3', min: 2, max: 3, color: '#06b6d4' },
  { label: '3–4', min: 3, max: 4, color: '#22c55e' },
  { label: '4–5', min: 4, max: 5, color: '#eab308' },
  { label: '5+', min: 5, max: null, color: '#dc2626' },
];

const DEFAULT_CALM_THRESHOLD = 0.5;

function speedBinIndex(speed: number, bins: WindSpeedBin[]): number {
  for (let i = 0; i < bins.length; i += 1) {
    const { min, max } = bins[i];
    if (speed >= min && (max == null || speed < max)) {
      return i;
    }
  }
  return bins.length - 1; // speeds at/above the last bin's min land in the open bin
}

export function computeWindRose(samples: WindSample[], options: WindRoseOptions = {}): WindRose {
  const speedBins = options.speedBins ?? DEFAULT_WIND_SPEED_BINS;
  const calmThreshold = options.calmThreshold ?? DEFAULT_CALM_THRESHOLD;

  // counts[sectorIndex][binIndex]
  const counts: number[][] = COMPASS_POINTS.map(() => speedBins.map(() => 0));
  let validSamples = 0;
  let calmSamples = 0;

  for (const sample of samples) {
    // Guard null/undefined explicitly: Number(null) === 0 (finite) and
    // roundWindDirectionDegrees(null) === 0 would otherwise count as a valid
    // calm North sample. NaN speeds are still caught by the isFinite check below.
    if (sample.wind_speed_mps == null || sample.wind_direction_deg == null) {
      continue;
    }
    const speed = Number(sample.wind_speed_mps);
    const direction = roundWindDirectionDegrees(sample.wind_direction_deg);
    if (!Number.isFinite(speed) || direction == null) {
      continue;
    }
    validSamples += 1;
    if (speed < calmThreshold) {
      calmSamples += 1;
      continue;
    }
    const compass = toCompassDirection(direction);
    const sectorIndex = compass ? COMPASS_POINTS.indexOf(compass) : -1;
    if (sectorIndex < 0) {
      continue;
    }
    counts[sectorIndex][speedBinIndex(speed, speedBins)] += 1;
  }

  const denom = validSamples || 1;
  const sectors: WindRoseSector[] = COMPASS_POINTS.map((direction, sectorIndex) => {
    const bins = counts[sectorIndex].map((count) => (count / denom) * 100);
    return { direction, bins, totalPct: bins.reduce((a, b) => a + b, 0) };
  });

  return {
    sectors,
    speedBins,
    validSamples,
    calmSamples,
    calmPct: validSamples ? (calmSamples / validSamples) * 100 : 0,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web/react-gui && npx vitest run src/utils/__tests__/wind.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck**

Run: `cd web/react-gui && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd web/react-gui
git add src/utils/wind.ts src/utils/__tests__/wind.test.ts
git commit -m "feat(wind): add computeWindRose aggregator for wind-rose distribution"
```

---

### Task 2: `WindRoseChart` component + `buildWindRoseOption`

**Files:**
- Create: `web/react-gui/src/components/farming/WindRoseChart.tsx`
- Test: `web/react-gui/src/components/farming/__tests__/WindRoseChart.test.tsx`

**Interfaces:**
- Consumes: `WindRose`, `WindSpeedBin` from `../../utils/wind` (Task 1); `EChart` from `../analysis/EChart`.
- Produces:

```ts
export interface WindRoseTheme {
  axisLine: string;
  axisLabel: string;
  splitLine: string;
  legendText: string;
}
export function buildWindRoseOption(rose: WindRose, theme: WindRoseTheme): Record<string, unknown>;
export const WindRoseChart: React.FC<{ rose: WindRose }>;
```

`buildWindRoseOption` is a pure function — it takes the theme colors as an argument (no DOM/echarts access), so it is fully unit-testable. `WindRoseChart` reads the CSS theme vars and passes them in, then renders `<EChart option={...} />`. This module is the echarts lazy boundary — nothing else imports it except via `React.lazy`.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/components/farming/__tests__/WindRoseChart.test.tsx`:

```ts
import { describe, expect, it } from 'vitest';
import { buildWindRoseOption, type WindRoseTheme } from '../WindRoseChart';
import { computeWindRose } from '../../../utils/wind';

const THEME: WindRoseTheme = {
  axisLine: '#111',
  axisLabel: '#222',
  splitLine: '#333',
  legendText: '#444',
};

describe('buildWindRoseOption', () => {
  const rose = computeWindRose([
    { wind_speed_mps: 3.5, wind_direction_deg: 90 },
    { wind_speed_mps: 6, wind_direction_deg: 200 },
  ]);
  const option = buildWindRoseOption(rose, THEME) as any;

  it('produces a polar coordinate system', () => {
    expect(option.polar).toBeDefined();
  });

  it('uses the 16 compass directions as the angle axis, N first, clockwise from top', () => {
    expect(option.angleAxis.type).toBe('category');
    expect(option.angleAxis.data).toHaveLength(16);
    expect(option.angleAxis.data[0]).toBe('N');
    expect(option.angleAxis.startAngle).toBe(90);
    expect(option.angleAxis.clockwise).toBe(true);
  });

  it('emits one stacked polar bar series per speed bin', () => {
    expect(option.series).toHaveLength(rose.speedBins.length);
    for (const series of option.series) {
      expect(series.type).toBe('bar');
      expect(series.coordinateSystem).toBe('polar');
      expect(series.stack).toBe('total');
      expect(series.data).toHaveLength(16);
    }
  });

  it('colors each series from its speed bin and names it with the bin label', () => {
    expect(option.series[0].name).toBe(rose.speedBins[0].label);
    expect(option.series[0].itemStyle.color).toBe(rose.speedBins[0].color);
  });

  it('lists the speed-bin labels in the legend', () => {
    expect(option.legend.data).toEqual(rose.speedBins.map((b) => b.label));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/components/farming/__tests__/WindRoseChart.test.tsx`
Expected: FAIL — `WindRoseChart`/`buildWindRoseOption` module does not exist.

- [ ] **Step 3: Implement the component**

Create `web/react-gui/src/components/farming/WindRoseChart.tsx`:

```tsx
import React from 'react';
import { EChart } from '../analysis/EChart';
import type { WindRose } from '../../utils/wind';

export interface WindRoseTheme {
  axisLine: string;
  axisLabel: string;
  splitLine: string;
  legendText: string;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readTheme(): WindRoseTheme {
  return {
    axisLine: cssVar('--border', '#e2e8f0'),
    axisLabel: cssVar('--text-secondary', '#64748b'),
    splitLine: cssVar('--border', '#e2e8f0'),
    legendText: cssVar('--text-secondary', '#64748b'),
  };
}

// Pure (theme is passed in): builds the echarts polar wind-rose option.
// Orientation: N at top (startAngle 90), sectors clockwise NNE→E→S→W.
export function buildWindRoseOption(rose: WindRose, theme: WindRoseTheme): Record<string, unknown> {
  const directions = rose.sectors.map((s) => s.direction);
  return {
    tooltip: { trigger: 'item' },
    legend: {
      data: rose.speedBins.map((b) => b.label),
      bottom: 0,
      textStyle: { color: theme.legendText },
    },
    polar: {},
    angleAxis: {
      type: 'category',
      data: directions,
      startAngle: 90,
      clockwise: true,
      boundaryGap: true,
      axisLine: { lineStyle: { color: theme.axisLine } },
      axisLabel: { color: theme.axisLabel },
    },
    radiusAxis: {
      min: 0,
      axisLabel: {
        color: theme.axisLabel,
        formatter: (v: number) => `${Math.round(v)}%`,
      },
      splitLine: { lineStyle: { color: theme.splitLine } },
    },
    series: rose.speedBins.map((bin, binIndex) => ({
      name: bin.label,
      type: 'bar',
      coordinateSystem: 'polar',
      stack: 'total',
      data: rose.sectors.map((s) => s.bins[binIndex]),
      itemStyle: { color: bin.color },
    })),
  };
}

export const WindRoseChart: React.FC<{ rose: WindRose }> = ({ rose }) => {
  const option = React.useMemo(() => buildWindRoseOption(rose, readTheme()), [rose]);
  return (
    <div style={{ width: '100%', height: 340 }}>
      <EChart option={option} className="h-full w-full" />
    </div>
  );
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/components/farming/__tests__/WindRoseChart.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `cd web/react-gui && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd web/react-gui
git add src/components/farming/WindRoseChart.tsx src/components/farming/__tests__/WindRoseChart.test.tsx
git commit -m "feat(wind): add WindRoseChart echarts polar renderer"
```

---

### Task 3: Integrate the rose into `WindMonitor` (lazy) and remove the arrow grid

**Files:**
- Modify: `web/react-gui/src/components/farming/WindMonitor.tsx`
- Reference (read-only, convention check): the S2120 decoder under `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/sensecap_s2120_decoder.js`

**Interfaces:**
- Consumes: `computeWindRose`, `WindRose` from `../../utils/wind`; `WindRoseChart` from `./WindRoseChart` (via `React.lazy`).
- Produces: no new exports; the modal now renders a wind rose in place of the direction-arrow grid.

- [ ] **Step 1: Note the direction convention (no code yet)**

Run: `grep -niE "wind.?dir|direction|4104|from" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/sensecap_s2120_decoder.js | head`
Expected: the decoder only labels measurement `4104` as "Wind Direction Sensor" — it does **not** state a from/to convention. Do **not** treat the grep as confirmation. "From" (meteorological) remains an *assumption* grounded in the SenseCAP vendor spec, not something the code proves. Carry the assumption into implementation and pin it down in Step 7 by sanity-checking the rendered prevailing direction against known field/site wind (or vendor docs). Keep orientation trivially flippable: the rose uses `startAngle: 90, clockwise: true`; if the prevailing petal is mirrored 180°, the fix is a single direction offset. Record the finding in the commit message.

- [ ] **Step 2: Add lazy import + Suspense scaffolding to `WindMonitor.tsx`**

At the top of `web/react-gui/src/components/farming/WindMonitor.tsx`, change the React import and add the lazy component + rose helper import.

Replace line 1:
```tsx
import React, { useEffect, useMemo, useState } from 'react';
```
with:
```tsx
import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
```

Replace the wind-helper import (line 13):
```tsx
import { formatWindDirection, roundWindDirectionDegrees, toCompassDirection } from '../../utils/wind';
```
with (drop the now-unused helpers, add the aggregator):
```tsx
import { computeWindRose, formatWindDirection } from '../../utils/wind';
```

Add, immediately after the imports (above `interface Props`):
```tsx
const WindRoseChart = lazy(() =>
  import('./WindRoseChart').then((module) => ({ default: module.WindRoseChart })),
);

const MIN_ROSE_SAMPLES = 10;
```

- [ ] **Step 3: Replace the direction-history section with the wind rose**

Delete the `sampledDirectionPoints` memo (lines ~159-169) — it is no longer used.

Compute the rose from the merged `data` (add near the other derived values, after `hasAnyData`):
```tsx
  const windRose = useMemo(() => computeWindRose(data), [data]);
```

Replace the entire "Direction history" `<div>` block (the `<div>` starting `<div className="mb-3 flex items-center justify-between gap-3">`'s parent — i.e. the second child under the charts, lines ~294-330) with:
```tsx
              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="font-bold text-[var(--text)]">Wind rose (direction × speed)</h3>
                  <p className="text-xs text-[var(--text-tertiary)]">
                    {windRose.validSamples} samples · {Math.round(windRose.calmPct)}% calm
                  </p>
                </div>
                {windRose.validSamples >= MIN_ROSE_SAMPLES ? (
                  <Suspense
                    fallback={
                      <div className="flex h-[340px] items-center justify-center">
                        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--primary)] border-t-transparent" />
                      </div>
                    }
                  >
                    <WindRoseChart rose={windRose} />
                  </Suspense>
                ) : (
                  <div className="rounded-lg bg-[var(--card)] p-4 text-sm text-[var(--text-tertiary)]">
                    Not enough wind data to plot a rose in this window.
                  </div>
                )}
              </div>
```

- [ ] **Step 4: Typecheck (catches unused imports / leftover references)**

Run: `cd web/react-gui && npm run typecheck`
Expected: no errors. In particular, no "declared but never used" for `roundWindDirectionDegrees`, `toCompassDirection`, or `sampledDirectionPoints`. If any appear, remove the offending leftover.

- [ ] **Step 5: Run the full unit suite**

Run: `cd web/react-gui && npm run test:unit`
Expected: PASS (existing suites unaffected; Task 1 & 2 suites green).

- [ ] **Step 6: Build to confirm the lazy chunk splits cleanly**

Run: `cd web/react-gui && npm run build`
Expected: build succeeds; the output shows a separate echarts-containing chunk (as it already does for Analysis). echarts must not be folded into the main/index chunk.

- [ ] **Step 7: Manual verification (record result in commit)**

Start the dev server (`npm run dev`), open an S2120 card, click Wind Speed/Direction to open the modal, and confirm:
- The wind rose renders in place of the old arrow grid, N at top, petals clockwise.
- The prevailing-direction petal points to the direction wind comes **from** (sanity-check against current `formatWindDirection` reading in the stat tile / known site wind).
- Switching time windows (12h/24h/7d/30d/90d) re-aggregates the rose.
- On a narrow viewport the rose resizes without overflow.
- If prevailing direction is mirrored 180°, revisit the Step 1 convention finding.

- [ ] **Step 8: Commit**

```bash
cd web/react-gui
git add src/components/farming/WindMonitor.tsx
git commit -m "feat(wind): show wind rose in WindMonitor, replacing arrow grid (lazy echarts)"
```

---

## Self-Review

**Spec coverage:**
- Wind rose (dir × speed), replacing arrow grid → Tasks 1–3. ✓
- Pure, unit-tested aggregator in `utils/wind.ts` → Task 1. ✓
- echarts via `EChart`, lazy-loaded, out of main bundle → Task 2 (module boundary) + Task 3 (React.lazy) + build check. ✓
- Calm handling (0.5 m/s), 6-bin speed scale, % of valid samples, calm+petals=100 → Task 1 (tested). ✓
- 16 sectors, N top clockwise, meteorological "from" assumption + decoder-silence note + field sanity-check → Task 2 option + Task 3 Step 1/7. ✓
- Low-data state (<10 samples) → Task 3 Step 3. ✓
- Keep speed/gust chart + stat tiles; card unchanged → Task 3 only touches the direction section. ✓
- Tests via `npm run test:unit` → all tasks. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `WindSample`, `WindSpeedBin`, `WindRose`, `WindRoseSector`, `WindRoseTheme`, `computeWindRose`, `DEFAULT_WIND_SPEED_BINS`, `buildWindRoseOption`, `WindRoseChart` are named identically across Tasks 1→2→3. `buildWindRoseOption(rose, theme)` takes the theme argument consistently in Task 2's impl and test. `WindHistoryPoint` (defined locally in WindMonitor with `wind_speed_mps`/`wind_direction_deg`) structurally satisfies `WindSample`, so `computeWindRose(data)` typechecks. ✓

## Notes / follow-ups (out of scope)

- Direction overlaid on the speed/gust time series (dual-axis).
- Zone-scoped wind view in the `environment` history card.
- Beaufort / spray-drift plain-language cues.
- **Pre-existing latent bug (separate change):** `roundWindDirectionDegrees(null)`
  returns `0` (because `Number(null) === 0` passes `isFinite`), so
  `formatWindDirection(null)` renders `"N 0°"` instead of `"—"` on the S2120 card
  when direction is missing. This plan sidesteps it with an explicit null guard in
  `computeWindRose` rather than changing the shared helper (which has other
  callers). Worth a focused fix + regression test on its own.
