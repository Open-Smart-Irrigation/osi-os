import React from 'react';
import { SoilLineChartView } from 'open-smart-irrigation';

// Soil-water-tension line chart. The floor card already shows the empty
// state, so every story here feeds a populated HistoryCardDataResponse:
// tension climbs while the soil dries, drops sharply after each irrigation,
// deeper sensors react slower and stay wetter (12–40 kPa band).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Fixed anchor so stories render identically on every capture.
const END = Date.parse('2026-07-12T18:00:00Z');
const WEEK_START = END - 7 * DAY;

type Pt = { t: string; value: number | null; coverageConfidence: string };

function soilWeek(opts: {
  start: number;
  ratePerH: number;
  irrigateTo: number;
  lagH: number;
  gap?: [number, number];
}): Pt[] {
  const points: Pt[] = [];
  let v = opts.start;
  for (let i = 0; i <= 7 * 24; i += 1) {
    // irrigation events early morning on day 2 and day 5
    if (i === 54 + opts.lagH || i === 126 + opts.lagH) v = opts.irrigateTo;
    else v = Math.min(41, v + opts.ratePerH * (0.85 + 0.3 * Math.sin(i / 3.1)));
    const diurnal = 0.9 * Math.sin((((i % 24) - 8) / 24) * 2 * Math.PI);
    const inGap = opts.gap ? i >= opts.gap[0] && i <= opts.gap[1] : false;
    points.push({
      t: new Date(WEEK_START + i * HOUR).toISOString(),
      value: inGap ? null : +(v + diurnal).toFixed(1),
      coverageConfidence: 'configured',
    });
  }
  return points;
}

function soilDay(opts: { start: number; irrigateAtQ: number; irrigateTo: number }): Pt[] {
  const points: Pt[] = [];
  let v = opts.start;
  const dayStart = END - DAY;
  for (let i = 0; i <= 96; i += 1) {
    if (i === opts.irrigateAtQ) v = opts.irrigateTo;
    else v = Math.min(41, v + 0.055 * (0.8 + 0.4 * Math.sin(i / 7)));
    points.push({
      t: new Date(dayStart + i * 15 * 60_000).toISOString(),
      value: +v.toFixed(1),
      coverageConfidence: 'configured',
    });
  }
  return points;
}

const response = (
  series: Array<{ id: string; label: string; unit: string; depthCm: number; points: Pt[] }>,
  range: { label: string; fromMs: number; toMs: number },
  aggregation: { level: string; bucketSizeSeconds: number },
) =>
  ({
    cardId: 'soil-zone-12',
    cardType: 'soil',
    view: 'line-chart',
    range: {
      label: range.label,
      from: new Date(range.fromMs).toISOString(),
      to: new Date(range.toMs).toISOString(),
      timezone: 'Europe/Zurich',
    },
    aggregation: {
      ...aggregation,
      coveragePct: 97,
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

// The view sizes itself with flex-1 + an absolute-inset ResponsiveContainer,
// so it needs a fixed-height flex column parent — same as the app's
// visualization surface.
function ChartSurface({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: 340, maxWidth: 860, display: 'flex', flexDirection: 'column' }}>
      {children}
    </div>
  );
}

const weekWindow = { fromMs: WEEK_START, toMs: END };

export function WeekThreeDepths() {
  const data = response(
    [
      { id: 'soil-swt-15', label: 'swt_1', unit: 'kPa', depthCm: 15, points: soilWeek({ start: 18, ratePerH: 0.32, irrigateTo: 13, lagH: 0 }) },
      { id: 'soil-swt-30', label: 'swt_2', unit: 'kPa', depthCm: 30, points: soilWeek({ start: 16, ratePerH: 0.22, irrigateTo: 15, lagH: 2 }) },
      { id: 'soil-swt-60', label: 'swt_3', unit: 'kPa', depthCm: 60, points: soilWeek({ start: 14, ratePerH: 0.1, irrigateTo: 16, lagH: 5 }) },
    ],
    { label: '7d', fromMs: WEEK_START, toMs: END },
    { level: 'hourly', bucketSizeSeconds: 3600 },
  );
  return (
    <ChartSurface>
      <SoilLineChartView data={data} window={weekWindow} />
    </ChartSurface>
  );
}

export function DayIrrigationDip() {
  const data = response(
    [
      { id: 'soil-swt-15', label: 'swt_1', unit: 'kPa', depthCm: 15, points: soilDay({ start: 31, irrigateAtQ: 25, irrigateTo: 14 }) },
      { id: 'soil-swt-30', label: 'swt_2', unit: 'kPa', depthCm: 30, points: soilDay({ start: 26, irrigateAtQ: 33, irrigateTo: 17 }) },
    ],
    { label: '24h', fromMs: END - DAY, toMs: END },
    { level: 'raw', bucketSizeSeconds: 900 },
  );
  return (
    <ChartSurface>
      <SoilLineChartView data={data} window={{ fromMs: END - DAY, toMs: END }} />
    </ChartSurface>
  );
}

export function WeekWithSensorGap() {
  const data = response(
    [
      { id: 'soil-swt-15', label: 'swt_1', unit: 'kPa', depthCm: 15, points: soilWeek({ start: 18, ratePerH: 0.32, irrigateTo: 13, lagH: 0 }) },
      // mid-week radio outage on the 30 cm sensor: 16 h of missing samples
      { id: 'soil-swt-30', label: 'swt_2', unit: 'kPa', depthCm: 30, points: soilWeek({ start: 16, ratePerH: 0.22, irrigateTo: 15, lagH: 2, gap: [80, 96] }) },
    ],
    { label: '7d', fromMs: WEEK_START, toMs: END },
    { level: 'hourly', bucketSizeSeconds: 3600 },
  );
  return (
    <ChartSurface>
      <SoilLineChartView data={data} window={weekWindow} />
    </ChartSurface>
  );
}
