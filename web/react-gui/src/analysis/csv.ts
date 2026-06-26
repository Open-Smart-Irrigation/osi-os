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
    const zone = entry?.zoneName ?? String(item.resolved.zoneId);
    const label = entry?.displayName ?? item.label;
    for (const point of item.points) {
      const row = [
        point.t,
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
