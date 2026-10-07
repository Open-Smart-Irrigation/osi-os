import { describe, it, expect } from 'vitest';
import { buildCorrelationOption, buildSmallMultiplesOption, buildTimeSeriesOption } from '../echartsOptions';
import { groupByUnit } from '../unitGrouping';
import { SERIES_PALETTE, seriesColor } from '../seriesColors';
import type { AnalysisPoint, AnalysisSeries } from '../types';

function series(id: string, unit: string, values: (number | null)[]): AnalysisSeries {
  return {
    seriesId: id,
    resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: id },
    label: id, unit, coveragePct: 100,
    points: values.map((v, i) => ({
      t: `2026-06-18T0${i}:00:00Z`,
      value: v,
      count: v === null ? 0 : 1,
      quality: v === null ? 'gap' : 'ok',
    })),
    truncated: false, cadence: 'hourly', timezone: null,
  };
}

function tooltipValueFormatter(option: Record<string, unknown>) {
  return (option.tooltip as { valueFormatter?: (value: number | null | undefined) => string }).valueFormatter;
}

describe('buildTimeSeriesOption', () => {
  it('single unit renders one grid and keeps gaps as nulls', () => {
    const s = [series('a', 'kPa', [1, null, 3]), series('b', 'kPa', [2, 2, 2])];
    const option = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false });
    expect(option.color).toEqual(SERIES_PALETTE);
    expect((option.grid as unknown[])).toHaveLength(1);
    expect((option.series as Array<Record<string, unknown>>)).toHaveLength(2);
    expect((option.series as Array<Record<string, unknown>>)[0].connectNulls).toBe(false);
    expect((option.series as Array<{ data: unknown[][] }>)[0].data[1][1]).toBeNull();
  });

  it('mixed units stack into one grid per unit with linked axis pointer', () => {
    const s = [series('a', 'kPa', [1]), series('b', 'C', [20])];
    const option = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false });
    expect((option.grid as unknown[])).toHaveLength(2);
    expect((option.xAxis as unknown[])).toHaveLength(2);
    expect(option.axisPointer).toBeDefined();
  });

  it('keeps each series colour stable across the mixed-unit regrouping (matches chips)', () => {
    const s = [series('a', 'kPa', [1]), series('b', 'C', [2]), series('c', 'kPa', [3])];
    const option = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false });
    const ech = option.series as Array<{ name: string; color?: string }>;
    const colorByName = new Map(ech.map((e, i) => [e.name, e.color ?? seriesColor(i)]));
    // stacked draws [a, c, b] but colours must follow ORIGINAL order
    expect(colorByName.get('a')).toBe(seriesColor(0));
    expect(colorByName.get('b')).toBe(seriesColor(1));
    expect(colorByName.get('c')).toBe(seriesColor(2));
  });

  it('disambiguates duplicate labels in timeline and small-multiples legends', () => {
    const s = [series('device-a', 'kPa', [1]), series('device-b', 'kPa', [2]), series('device-c', 'kPa', [3])];
    s[0].label = 'Rain';
    s[1].label = 'Rain';
    s[2].label = 'Rain (1)';

    const options = [
      buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false }),
      buildSmallMultiplesOption(s, false),
    ];
    for (const option of options) {
      const names = (option.series as Array<{ name: string }>).reduce<Record<string, string>>((byId, item, index) => {
        byId[s[index].seriesId] = item.name;
        return byId;
      }, {});
      expect(names).toEqual({ 'device-a': 'Rain (2)', 'device-b': 'Rain (3)', 'device-c': 'Rain (1)' });
      expect(new Set(Object.values(names)).size).toBe(3);
    }
  });

  it('multiAxis collapses mixed units to one grid with a y-axis per unit', () => {
    const s = [series('a', 'kPa', [1]), series('b', 'C', [20])];
    const option = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: true });
    expect((option.grid as unknown[])).toHaveLength(1);
    expect((option.yAxis as unknown[])).toHaveLength(2);
  });

  it('normalize scales each series to 0..100 and labels the axis percent', () => {
    const s = [series('a', 'kPa', [10, 20])]; // -> 0, 100
    const option = buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: true, multiAxis: false });
    const data = (option.series as Array<{ data: [string, number][] }>)[0].data;
    expect(data[0][1]).toBe(0);
    expect(data[1][1]).toBe(100);
    expect((option.yAxis as Array<{ name: string }>)[0].name).toBe('%');
  });

  it('rounds displayed tooltip values to 1 decimal without changing data', () => {
    const s = [series('a', 'kPa', [62.2545])];
    const options = [
      buildTimeSeriesOption({ panels: groupByUnit(s), series: s, normalize: false, multiAxis: false }),
      buildSmallMultiplesOption(s, false),
      buildCorrelationOption({
        zonePairs: [{ groupId: 'zone:1', zoneId: 1, label: 'Zone 1', points: [[62.2545, 3]] }],
        channelXLabel: 'Soil tension',
        channelYLabel: 'Stem change',
      }),
    ];

    for (const option of options) {
      const formatter = tooltipValueFormatter(option);
      expect(formatter).toEqual(expect.any(Function));
      expect(formatter?.(62.2545)).toBe('62.3');
      expect(formatter?.(null)).toBe('–');
    }
  });
});

describe('time axis date labels', () => {
  const series = [{
    seriesId: 'a', resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
    label: 'A', unit: 'kPa', coveragePct: 100,
    points: [{ t: '2026-06-21T00:00:00Z', value: 1, count: 1, quality: 'ok' }], truncated: false, cadence: 'hourly', timezone: null,
  }] as never;

  it('formats day-boundary ticks as DD.MM.', () => {
    const opt = buildTimeSeriesOption({ panels: [{ unit: 'kPa', seriesIds: ['a'] }], series, normalize: false, multiAxis: false }) as any;
    const xAxis = Array.isArray(opt.xAxis) ? opt.xAxis[0] : opt.xAxis;
    expect(xAxis.axisLabel.formatter.day).toBe('{dd}.{MM}.');
    expect(xAxis.axisLabel.formatter.hour).toBe('{HH}:{mm}');
  });
});

describe('export legend', () => {
  const series = [{
    seriesId: 'a', resolved: { hubEui: null, zoneId: 1, cardType: 'soil', sourceKey: 'root-zone', channelKey: 'swt_1' },
    label: 'A', unit: 'kPa', coveragePct: 100, points: [], truncated: false, cadence: 'hourly', timezone: null,
  }] as never;
  const panels = [{ unit: 'kPa', seriesIds: ['a'] }];

  it('omits the legend on screen', () => {
    const opt = buildTimeSeriesOption({ panels, series, normalize: false, multiAxis: false }) as any;
    expect(opt.legend).toBeUndefined();
  });

  it('adds a bottom legend for export', () => {
    const opt = buildTimeSeriesOption({ panels, series, normalize: false, multiAxis: false, includeLegend: true }) as any;
    expect(opt.legend.bottom).toBe(8);
  });
});

function mkSeries(seriesId: string, channelKey: string, unit: string | null, extra?: Partial<AnalysisSeries>): AnalysisSeries {
  return {
    seriesId,
    resolved: { hubEui: null, zoneId: 1, zoneName: 'Z', cardType: 'soil', sourceKey: 's', channelKey },
    label: seriesId,
    unit,
    coveragePct: null,
    points: [],
    truncated: false, cadence: 'hourly', timezone: null,
    ...extra,
  } as AnalysisSeries;
}

const resolve = (key: string, unit: string | null) => `Q:${key} (${unit})`;

describe('axisNameSpec via buildTimeSeriesOption', () => {
  it('overlay shared axis with mixed units → comma-joined pretty units, not editable', () => {
    const s = [mkSeries('a', 'swt_1', 'kPa'), mkSeries('b', 'dendro_stem_change_um', 'um'), mkSeries('c', 'ext_temperature_c', 'C')];
    const opt = buildTimeSeriesOption({ panels: [{ unit: 'kPa', seriesIds: ['a', 'b', 'c'] }], series: s, normalize: false, multiAxis: false, resolveAxisLabel: resolve });
    const y = (opt.yAxis as any[])[0];
    expect(y.name).toBe('kPa, µm, °C');
    expect(y.triggerEvent).toBeUndefined();
  });

  it('single-unit axis → descriptive editable label, parallel placement', () => {
    const s = [mkSeries('a', 'swt_1', 'kPa'), mkSeries('b', 'swt_2', 'kPa')];
    const opt = buildTimeSeriesOption({ panels: [{ unit: 'kPa', seriesIds: ['a', 'b'] }], series: s, normalize: false, multiAxis: false, resolveAxisLabel: resolve });
    const y = (opt.yAxis as any[])[0];
    expect(y.name).toBe('Q:swt_1 (kPa)');
    expect(y.nameLocation).toBe('middle');
    expect(y.nameRotate).toBe(90);
    expect(y.id).toBe('swt_1#0');
    expect(y.triggerEvent).toBe(true);
  });
});

describe('buildCorrelationOption', () => {
  it('correlation Y-axis label is parallel (not floating at the end)', () => {
    const opt = buildCorrelationOption({ zonePairs: [], channelXLabel: 'X', channelYLabel: 'Y' });
    const y = (opt.yAxis as any[])[0];
    expect(y.nameLocation).toBe('middle');
    expect(y.nameRotate).toBe(90);
  });
});

describe('axisNameSpec via buildSmallMultiplesOption', () => {
  it('small multiples normalizes each cell independently when normalize=true', () => {
    const resolve = (k: string, u: string | null) => `Q:${k} (${u})`;
    const s = mkSeries('a', 'swt_1', 'kPa');
    s.points = [
      { t: '2026-06-01T00:00:00Z', value: 10, count: 1, quality: 'ok' },
      { t: '2026-06-01T01:00:00Z', value: 20, count: 1, quality: 'ok' },
    ];
    const opt = buildSmallMultiplesOption([s], true, resolve);
    const y = (opt.yAxis as any[])[0];
    expect(y.name).toBe('%');
    const data = (opt.series as any[])[0].data as [string, number | null][];
    expect(data.map((d) => d[1])).toEqual([0, 100]);
  });

  it('small multiples keeps raw values + descriptive label when normalize=false', () => {
    const resolve = (k: string, u: string | null) => `Q:${k} (${u})`;
    const opt = buildSmallMultiplesOption([mkSeries('a', 'swt_1', 'kPa')], false, resolve);
    expect((opt.yAxis as any[])[0].name).toBe('Q:swt_1 (kPa)');
  });

  it('small multiples cell → descriptive editable label + unit (regression: had none)', () => {
    const s = [mkSeries('a', 'swt_1', 'kPa')];
    const opt = buildSmallMultiplesOption(s, false, resolve);
    const y = (opt.yAxis as any[])[0];
    expect(y.name).toBe('Q:swt_1 (kPa)');
    expect(y.nameRotate).toBe(90);
    expect(y.id).toBe('swt_1#0');
    expect(y.triggerEvent).toBe(true);
  });
});

describe('weather series', () => {
  const hoursPartial = (point: AnalysisPoint) => (point.quality === 'partial' ? ` (${point.count} of ${point.expected} h)` : '');
  const tooltipFormatter = (option: Record<string, unknown>) => (option.tooltip as { formatter: (params: unknown) => string }).formatter;
  const visibleText = (html: string) => html.replace(/<[^>]*>/g, '');

  it('draws symbols for a daily-cadence series so a lone valid day stays visible', () => {
    const daily: AnalysisSeries = { ...series('et0', 'mm/d', [null, 1.2, null]), cadence: 'daily' };
    const hourly = series('rain', 'mm/h', [0.1, 0.2, 0.3]);
    const option = buildTimeSeriesOption({ panels: groupByUnit([daily, hourly]), series: [daily, hourly], normalize: false, multiAxis: false });
    const drawn = option.series as Array<{ name: string; showSymbol: boolean; symbolSize?: number }>;
    expect(drawn.find((s) => s.name === 'et0')).toMatchObject({ showSymbol: true, symbolSize: 4 });
    expect(drawn.find((s) => s.name === 'rain')?.showSymbol).toBe(false);
    const multiples = buildSmallMultiplesOption([daily], false);
    expect((multiples.series as Array<{ showSymbol: boolean }>)[0].showSymbol).toBe(true);
  });

  it('ends the tooltip row of a partial point with its count, in the default tooltip layout', () => {
    const rain: AnalysisSeries = { ...series('rain', 'mm/d', [4.2, 3.1]), cadence: 'daily' };
    rain.points[0] = { ...rain.points[0], count: 23, expected: 24, quality: 'partial' };
    const option = buildTimeSeriesOption({ panels: groupByUnit([rain]), series: [rain], normalize: false, multiAxis: false, formatPartial: hoursPartial });
    const formatter = tooltipFormatter(option);
    const partial = formatter([{ seriesIndex: 0, dataIndex: 0, marker: '', seriesName: 'rain', value: [rain.points[0].t, 4.2], axisValueLabel: '2026-06-18 00:00' }]);
    expect(visibleText(partial)).toBe('2026-06-18 00:00rain4.2 (23 of 24 h)');
    expect(partial).toContain('float:right');
    expect(partial).toContain('font-weight:900');
    expect(visibleText(formatter([{ seriesIndex: 0, dataIndex: 1, marker: '', seriesName: 'rain', value: [rain.points[1].t, 3.1] }]))).toBe('rain3.1');
    const escaped = formatter([{ seriesIndex: 0, dataIndex: 1, marker: '', seriesName: '<b>x</b>', value: [rain.points[1].t, 3.1] }]);
    expect(escaped).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(escaped).not.toContain('<b>');
  });

  it('finds the hovered point in ECharts series order in the stacked layout', () => {
    // Stacked is the workspace default; ECharts draws the panels' series in
    // panel order, [a, c, b] here, not in the order of `series`.
    const a = series('a', 'kPa', [10, 11]);
    const b: AnalysisSeries = { ...series('b', 'mm/d', [4.2, 3.1]), cadence: 'daily' };
    b.points[0] = { ...b.points[0], count: 23, expected: 24, quality: 'partial' };
    const c = series('c', 'kPa', [12, 13]);
    const input = [a, b, c];
    const option = buildTimeSeriesOption({ panels: groupByUnit(input), series: input, normalize: false, multiAxis: false, formatPartial: hoursPartial });
    expect((option.series as Array<{ name: string }>).map((s) => s.name)).toEqual(['a', 'c', 'b']);
    const formatter = tooltipFormatter(option);
    const hover = (seriesIndex: number, seriesName: string, value: number) => visibleText(
      formatter([{ seriesIndex, dataIndex: 0, marker: '', seriesName, value: ['2026-06-18T00:00:00Z', value] }]),
    );
    expect(hover(2, 'b', 4.2)).toBe('b4.2 (23 of 24 h)');
    expect(hover(1, 'c', 12)).toBe('c12.0');
  });
});
