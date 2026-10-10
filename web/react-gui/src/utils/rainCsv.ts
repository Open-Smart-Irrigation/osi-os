import { hasRainData, type RainHistory } from './rain';

const HEADER = [
  'day',
  'timezone',
  'timezone_basis',
  'period_start',
  'period_end',
  'total_mm',
  'quality',
  'quality_reasons',
  'sample_count',
  'so_far',
];

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize the gateway's already-bucketed daily history without inferring coverage or bounds. */
export function toRainHistoryCsv(history: RainHistory): string {
  const lines = [
    '# osi-rain-history-csv-version: 1',
    HEADER.join(','),
    ...history.days.map((day) => [
      day.day,
      history.timezone ?? '',
      history.timezoneBasis ?? '',
      day.period_start ?? '',
      day.period_end ?? '',
      hasRainData(day) ? String(day.total_mm) : '',
      day.quality,
      JSON.stringify(day.reasons ?? []),
      String(day.samples),
      String(day.so_far),
    ].map(escapeCsvCell).join(',')),
  ];
  return lines.join('\n');
}
