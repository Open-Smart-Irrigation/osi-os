import { describe, expect, it } from 'vitest';
import type { RainHistory } from '../rain';
import { toRainHistoryCsv } from '../rainCsv';
import { A12_DST_DAYS, A19_HISTORY, a12History } from '../../analysis/__tests__/fixtures/rainAcceptance';

function parseCsv(source: string): string[][] {
  return source.split('\n').map((line) => {
    const fields: string[] = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted && char === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        fields.push(field);
        field = '';
      } else {
        field += char;
      }
    }
    fields.push(field);
    return fields;
  });
}

describe('toRainHistoryCsv', () => {
  it('exports API-order history states, server bounds, reasons and null versus measured zero', () => {
    const csv = toRainHistoryCsv(A19_HISTORY);
    const [marker, header, ...rows] = parseCsv(csv);

    expect(marker).toEqual(['# osi-rain-history-csv-version: 1']);
    expect(header).toEqual(['day', 'timezone', 'timezone_basis', 'period_start', 'period_end', 'total_mm', 'quality', 'quality_reasons', 'sample_count', 'so_far']);
    expect(rows).toEqual([
      ['2026-10-22', 'Europe/Zurich', 'zone', '2026-10-21T22:00:00.000Z', '2026-10-22T22:00:00.000Z', '', 'received_only', '[]', '0', 'false'],
      ['2026-10-23', 'Europe/Zurich', 'zone', '2026-10-22T22:00:00.000Z', '2026-10-23T22:00:00.000Z', '0.5', 'received_only', '[]', '1', 'false'],
      ['2026-10-24', 'Europe/Zurich', 'zone', '2026-10-23T22:00:00.000Z', '2026-10-24T22:00:00.000Z', '1', 'partial', '["instrument says \\"coverage, incomplete\\""]', '2', 'false'],
      ['2026-10-25', 'Europe/Zurich', 'zone', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', '0', 'complete', '["all samples received"]', '3', 'false'],
    ]);
  });

  it('preserves unknown quality for an empty day instead of converting it to received-only', () => {
    const empty = { ...A19_HISTORY.days[0], quality: 'unknown' as const };
    const csv = toRainHistoryCsv({ ...A19_HISTORY, days: [empty] });

    expect(parseCsv(csv)[2]).toEqual([
      '2026-10-22', 'Europe/Zurich', 'zone', '2026-10-21T22:00:00.000Z', '2026-10-22T22:00:00.000Z',
      '', 'unknown', '[]', '0', 'false',
    ]);
  });

  it.each(A12_DST_DAYS)('keeps the Zurich $day farm day and exact DST bounds', (day) => {
    const csv = toRainHistoryCsv(a12History(day));
    const row = parseCsv(csv)[2];
    expect(row).toEqual([
      day.day, 'Europe/Zurich', 'zone', day.period_start, day.period_end,
      String(day.total_mm), day.quality, '[]', String(day.samples), 'false',
    ]);
    const expectedHours = day.day === '2026-03-29' ? 23 : 25;
    expect(Date.parse(row[4]) - Date.parse(row[3])).toBe(expectedHours * 60 * 60 * 1000);
  });

  it('keeps a current day request-time end and so-far marker without extending the bucket', () => {
    const history: RainHistory = {
      timezone: 'Europe/Zurich', timezoneBasis: 'zone',
      periodStart: '2026-03-29T22:00:00.000Z', periodEnd: '2026-03-30T12:30:00.000Z',
      days: [{
        day: '2026-03-30', period_start: '2026-03-29T22:00:00.000Z', period_end: '2026-03-30T12:30:00.000Z',
        total_mm: 0.2, samples: 1, quality: 'partial', reasons: [], so_far: true,
      }],
    };

    expect(parseCsv(toRainHistoryCsv(history))[2]).toEqual([
      '2026-03-30', 'Europe/Zurich', 'zone', '2026-03-29T22:00:00.000Z', '2026-03-30T12:30:00.000Z',
      '0.2', 'partial', '[]', '1', 'true',
    ]);
  });
});
