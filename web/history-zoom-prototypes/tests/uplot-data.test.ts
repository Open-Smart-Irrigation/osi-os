import { describe, expect, it, vi } from 'vitest';
import type { SensorSeries } from '../src/shared/types';

vi.hoisted(() => {
  if (typeof globalThis.matchMedia !== 'function') {
    globalThis.matchMedia = (() => ({
      matches: false,
      media: '',
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof globalThis.matchMedia;
  }
});

import { toUplotData } from '../src/adapters/uplot-data';

const series: readonly SensorSeries[] = [
  {
    id: 'upper',
    label: 'Upper soil',
    unit: 'kPa',
    points: [
      { t: 4_000, value: 20 },
      { t: 0, value: 10 },
      { t: 2_000, value: null },
      { t: 0, value: 0 },
    ],
  },
  {
    id: 'lower',
    label: 'Lower soil',
    unit: 'kPa',
    points: [
      { t: 1_000, value: 30 },
      { t: 3_000, value: 96 },
    ],
  },
];

describe('toUplotData', () => {
  it('expands explicit gaps across adjacent alignment holes', () => {
    expect(toUplotData(series)).toEqual([
      [0, 1, 2, 3, 4],
      [0, null, null, null, 20],
      [undefined, 30, undefined, 96, undefined],
    ]);
  });

  it('keeps an entire outage null without fabricating values', () => {
    expect(
      toUplotData([
        {
          id: 'outage',
          label: 'Outage',
          unit: 'kPa',
          points: [
            { t: 0, value: null },
            { t: 2_000, value: null },
          ],
        },
        {
          id: 'reference',
          label: 'Reference',
          unit: 'kPa',
          points: [{ t: 1_000, value: 30 }],
        },
      ]),
    ).toEqual([
      [0, 1, 2],
      [null, null, null],
      [undefined, 30, undefined],
    ]);
  });

  it('does not mutate source point order', () => {
    const before = series.map((item) => [...item.points]);
    toUplotData(series);
    expect(series.map((item) => item.points)).toEqual(before);
  });

  it('returns an x column for an empty series list', () => {
    expect(toUplotData([])).toEqual([[]]);
  });
});
