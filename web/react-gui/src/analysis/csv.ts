import type { AnalysisPoint, AnalysisSeries, AnalysisCatalogEntry } from './types';
import { presentRainfallName } from './channelLabels';
import { canonicalize } from '../channels/registry';
import { msUntilNextFarmMidnight } from '../utils/rainDay';

const HEADER = [
  'timestamp',
  'site',
  'zone',
  'series_label',
  'card_type',
  'source_key',
  'channel_key',
  'depth_cm',
  'array_id',
  'unit',
  'value',
  'depth_reference',
];

// A daily-cadence point stands for one zone-local day, so its row carries
// that date; an invalid zone timezone falls back to UTC as the backend does.
function localDate(t: string, timeZone: string | null): string {
  const format = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(t));
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  try {
    return format(timeZone || 'UTC');
  } catch {
    return format('UTC');
  }
}

function escape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Columns a version 2 export appends to the version 1 columns (owner decision D3). */
export const CSV_V2_EXTRA_COLUMNS = ['timezone', 'period_start', 'period_end', 'quality', 'coverage', 'sample_count'];

export interface TidyCsvOptions {
  /** 1 (default) keeps the original columns byte for byte; 2 adds CSV_V2_EXTRA_COLUMNS. */
  version?: 1 | 2;
  /** The applied aggregation (`aggregation.applied`): names a rain amount and bounds a bucket. */
  aggregation?: string;
  /** The end of the requested range (`range.to`): the last bucket of a series ends there. */
  rangeEnd?: string;
}

// Rain amounts arrive as sparse reports; a version 2 row marks them `received_only`
// (no completeness certified) and never states a coverage figure for them.
const RAIN_AMOUNT_KEYS = new Set(['rain_mm_delta', 'rain_tips_delta']);

const HOUR_MS = 3600000;

function isoPlus(t: string, ms: number): string {
  return new Date(Date.parse(t) + ms).toISOString();
}

// [period_start, period_end] of one point, ISO UTC. A daily-cadence point is one zone-local
// day (23 or 25 hours across a clock change). A device bucket ends where the next one starts
// (the gateway emits every bucket of the range, clipped to it); a raw device sample is an
// instant, and a raw rain report covers an interval that ends at it. A weather row below
// daily is one hour.
function periodBounds(item: AnalysisSeries, index: number, entry: AnalysisCatalogEntry | undefined, options: TidyCsvOptions, rainAmount: boolean): [string, string] {
  const point = item.points[index];
  if (item.cadence === 'daily') return [point.t, isoPlus(point.t, msUntilNextFarmMidnight(item.timezone || 'UTC', Date.parse(point.t)))];
  const device = (entry?.sourceKind ?? 'device') === 'device';
  if (!device) return [point.t, isoPlus(point.t, HOUR_MS)];
  if (options.aggregation === 'raw') return [rainAmount ? '' : point.t, point.t];
  const next = item.points[index + 1];
  return [point.t, next ? next.t : (options.rangeEnd ? new Date(options.rangeEnd).toISOString() : '')];
}

function coverage(point: AnalysisPoint, rainAmount: boolean): string {
  if (rainAmount || typeof point.expected !== 'number' || point.expected <= 0) return '';
  return String(Math.round((point.count / point.expected) * 1000) / 1000);
}

export function toTidyCsv(
  series: AnalysisSeries[],
  catalogById: Map<string, AnalysisCatalogEntry>,
  options: TidyCsvOptions = {},
): string {
  const v2 = options.version === 2;
  const lines: string[] = v2
    ? ['# osi-csv-version: 2', [...HEADER, ...CSV_V2_EXTRA_COLUMNS].join(',')]
    : [HEADER.join(',')];
  for (const item of series) {
    const entry = catalogById.get(item.seriesId);
    const site = entry?.hubEui ?? item.resolved.hubEui ?? '';
    const zone = item.resolved.zoneId === null
      ? 'Unassigned devices'
      : (entry?.zoneName ?? String(item.resolved.zoneId));
    const label = entry ? presentRainfallName(entry, options.aggregation) : item.label;
    const rainAmount = RAIN_AMOUNT_KEYS.has(canonicalize(item.resolved.channelKey))
      && (entry?.sourceKind ?? 'device') === 'device';
    item.points.forEach((point, index) => {
      const row = [
        item.cadence === 'daily' ? localDate(point.t, item.timezone) : point.t,
        site,
        zone,
        label,
        item.resolved.cardType,
        item.resolved.sourceKey,
        item.resolved.channelKey,
        entry?.depthCm ?? '',
        '',
        item.unit ?? '',
        point.value === null ? '' : String(point.value),
        entry?.depthCm == null ? '' : entry.depthReference === 'current_layout' ? 'current_layout' : 'unspecified',
      ];
      if (v2) {
        const [periodStart, periodEnd] = periodBounds(item, index, entry, options, rainAmount);
        row.push(
          item.timezone ?? '',
          periodStart,
          periodEnd,
          rainAmount ? 'received_only' : point.quality === 'partial' ? 'partial' : '',
          coverage(point, rainAmount),
          String(point.count),
        );
      }
      lines.push(row.map((cell) => escape(String(cell))).join(','));
    });
  }
  return lines.join('\n');
}
