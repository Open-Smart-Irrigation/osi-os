import type { AnalysisSeries, AnalysisCatalogEntry } from './types';

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

export function toTidyCsv(
  series: AnalysisSeries[],
  catalogById: Map<string, AnalysisCatalogEntry>,
): string {
  const lines: string[] = [HEADER.join(',')];
  for (const item of series) {
    const entry = catalogById.get(item.seriesId);
    const site = entry?.hubEui ?? item.resolved.hubEui ?? '';
    const zone = item.resolved.zoneId === null
      ? 'Unassigned devices'
      : (entry?.zoneName ?? String(item.resolved.zoneId));
    const label = entry?.displayName ?? item.label;
    for (const point of item.points) {
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
      ].map((cell) => escape(String(cell)));
      lines.push(row.join(','));
    }
  }
  return lines.join('\n');
}
