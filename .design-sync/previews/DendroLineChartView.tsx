import React from 'react';
import { DendroLineChartView } from 'open-smart-irrigation';

// Dendrometer line chart. Stories feed populated stem-diameter series (µm):
// steady growth trend plus the classic day/night cycle — the stem shrinks
// through the afternoon while the tree transpires and recovers overnight.
// Series ids contain "stem" so selectPlottedSeries keeps them.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Fixed anchor so stories render identically on every capture.
const END = Date.parse('2026-07-12T18:00:00Z');
const WEEK_START = END - 7 * DAY;

type Pt = { t: string; value: number | null; coverageConfidence: string };

// Daylight shrinkage curve: zero overnight, peaking mid-afternoon.
function shrink(hourOfDay: number): number {
  if (hourOfDay < 7 || hourOfDay > 20) return 0;
  return Math.sin(((hourOfDay - 7) / 13) * Math.PI);
}

function dendroWeek(opts: { base: number; growthPerDay: number; amps: number[] }): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i <= 7 * 24; i += 1) {
    const day = Math.min(Math.floor(i / 24), opts.amps.length - 1);
    const v = opts.base + opts.growthPerDay * (i / 24) - opts.amps[day] * shrink(i % 24);
    points.push({
      t: new Date(WEEK_START + i * HOUR).toISOString(),
      value: +v.toFixed(1),
      coverageConfidence: 'configured',
    });
  }
  return points;
}

// One stress day at 10-minute resolution: overnight rise, steep afternoon
// shrinkage, evening recovery that does not quite make it back.
function dendroStressDay(): Pt[] {
  const points: Pt[] = [];
  const dayStart = END - DAY; // 18:00 previous day -> 18:00 today
  for (let i = 0; i <= 144; i += 1) {
    const t = dayStart + i * 10 * 60_000;
    const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
    const v = 182 + 4.2 * (i / 144) - 31 * shrink(hour);
    points.push({ t: new Date(t).toISOString(), value: +v.toFixed(1), coverageConfidence: 'configured' });
  }
  return points;
}

const response = (
  series: Array<{ id: string; label: string; unit: string; points: Pt[] }>,
  range: { label: string; fromMs: number; toMs: number },
  aggregation: { level: string; bucketSizeSeconds: number },
) =>
  ({
    cardId: 'dendro-zone-12',
    cardType: 'dendro',
    view: 'line-chart',
    range: {
      label: range.label,
      from: new Date(range.fromMs).toISOString(),
      to: new Date(range.toMs).toISOString(),
      timezone: 'Europe/Zurich',
    },
    aggregation: {
      ...aggregation,
      coveragePct: 94,
      coverageConfidence: 'configured',
      pointCount: series[0].points.length,
      source: null,
      dominantStatusMethod: null,
    },
    limits: { maxPointsPerSeries: 2000, maxEvents: 200, maxInterpretations: 20, truncated: false },
    series,
    profiles: [],
    events: [],
    calendar: null,
    interpretations: [],
    freshness: { dataAsOf: new Date(range.toMs).toISOString(), syncState: 'synced' },
    advancedFields: {},
  }) as any;

// Fixed-height flex column parent, same as the app's visualization surface —
// the view itself is flex-1 with an absolute-inset ResponsiveContainer.
function ChartSurface({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: 340, maxWidth: 860, display: 'flex', flexDirection: 'column' }}>
      {children}
    </div>
  );
}

const weekWindow = { fromMs: WEEK_START, toMs: END };

export function WeekGrowthWithDailyShrinkage() {
  const data = response(
    [
      {
        id: 'dendro-1-stem-diameter',
        label: 'Stem diameter change',
        unit: 'um',
        // hot spell Thursday/Friday: deeper afternoon shrinkage
        points: dendroWeek({ base: 140, growthPerDay: 9, amps: [16, 18, 20, 26, 31, 22, 18] }),
      },
    ],
    { label: '7d', fromMs: WEEK_START, toMs: END },
    { level: 'hourly', bucketSizeSeconds: 3600 },
  );
  return (
    <ChartSurface>
      <DendroLineChartView data={data} window={weekWindow} />
    </ChartSurface>
  );
}

export function TwoTreesComparison() {
  const data = response(
    [
      {
        id: 'dendro-1-stem-diameter',
        label: 'Cherry 12 stem',
        unit: 'um',
        points: dendroWeek({ base: 150, growthPerDay: 10.5, amps: [15, 17, 18, 24, 27, 19, 16] }),
      },
      {
        id: 'dendro-2-stem-diameter',
        label: 'Cherry 47 stem',
        unit: 'um',
        // younger tree on the dry row: slower growth, harder afternoon shrink
        points: dendroWeek({ base: 96, growthPerDay: 4.5, amps: [22, 25, 27, 34, 38, 28, 24] }),
      },
    ],
    { label: '7d', fromMs: WEEK_START, toMs: END },
    { level: 'hourly', bucketSizeSeconds: 3600 },
  );
  return (
    <ChartSurface>
      <DendroLineChartView data={data} window={weekWindow} />
    </ChartSurface>
  );
}

export function StressDayDetail() {
  const data = response(
    [
      {
        id: 'dendro-1-stem-diameter',
        label: 'Stem diameter change',
        unit: 'um',
        points: dendroStressDay(),
      },
    ],
    { label: '24h', fromMs: END - DAY, toMs: END },
    { level: 'raw', bucketSizeSeconds: 600 },
  );
  return (
    <ChartSurface>
      <DendroLineChartView data={data} window={{ fromMs: END - DAY, toMs: END }} />
    </ChartSurface>
  );
}
