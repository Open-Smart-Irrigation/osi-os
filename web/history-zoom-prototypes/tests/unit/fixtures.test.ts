import { describe, expect, test, vi } from 'vitest';
import { DAY_MS, FIXTURE_EXTENT, HOUR_MS, type FixtureKind } from '../../src/shared/types';
import { FIXTURE_FEATURES, fixtureSeries } from '../../src/shared/fixtures';

describe('deterministic history fixtures', () => {
  test('returns frozen, sorted nominal points with explicit initial-window evidence', () => {
    const series = fixtureSeries('nominal');
    expect(series).toHaveLength(3);
    expect(series.flatMap((item) => item.points).length).toBeGreaterThanOrEqual(FIXTURE_FEATURES.nominal.minimumPointCount);
    expect(Object.isFrozen(series)).toBe(true);
    for (const item of series) {
      expect(Object.isFrozen(item)).toBe(true);
      expect(Object.isFrozen(item.points)).toBe(true);
      expect(item.points.every((point, index, points) => index === 0 || point.t > points[index - 1].t)).toBe(true);
    }
    const initial = series.flatMap((item) => item.points).filter((point) => point.t >= FIXTURE_EXTENT.to - DAY_MS);
    expect(initial.some((point) => point.value === 0)).toBe(true);
    expect(initial.some((point) => point.t === FIXTURE_FEATURES.nominal.outageStart)).toBe(true);
    expect(initial.some((point) => point.t === FIXTURE_FEATURES.nominal.outageEnd)).toBe(true);
    expect(initial.some((point) => point.value === 96)).toBe(true);
    const outage = series[0].points.filter((point) => point.t >= FIXTURE_FEATURES.nominal.outageStart && point.t <= FIXTURE_FEATURES.nominal.outageEnd);
    expect(outage.length).toBeGreaterThan(2);
    expect(outage.every((point) => point.value === null)).toBe(true);
    expect(series[0].points.find((point) => point.t === FIXTURE_FEATURES.nominal.outageStart - 1 * 60_000)?.value).toBeTypeOf('number');
    expect(series[0].points.find((point) => point.t === FIXTURE_FEATURES.nominal.outageEnd + 1 * 60_000)?.value).toBeTypeOf('number');
    expect(new Set(initial.map((point) => point.t % HOUR_MS)).size).toBeGreaterThan(1);
  });

  test.each(['nominal', 'sparse', 'stress'] as FixtureKind[])('is repeatable across independent generations for %s', async (kind) => {
    const first = fixtureSeries(kind);
    vi.resetModules();
    const freshModule = await import('../../src/shared/fixtures');
    expect(freshModule.fixtureSeries(kind)).toEqual(first);
  });

  test('generates stress with at least one hundred thousand points', () => {
    expect(fixtureSeries('stress').flatMap((item) => item.points)).toHaveLength(129_600);
  });

  test('supports empty and single states without changing the fixed extent', () => {
    expect(fixtureSeries('empty')).toEqual([]);
    const single = fixtureSeries('single');
    expect(single).toHaveLength(1);
    expect(single[0].points).toHaveLength(1);
    expect(FIXTURE_EXTENT.to - FIXTURE_EXTENT.from).toBe(90 * DAY_MS);
  });

  test('keeps sparse evidence in the initial window', () => {
    const points = fixtureSeries('sparse').flatMap((item) => item.points).filter((point) => point.t >= FIXTURE_EXTENT.to - DAY_MS);
    expect(points.some((point) => point.value === null)).toBe(true);
    expect(points.some((point) => point.value !== null)).toBe(true);
    expect(new Set(points.map((point) => point.t)).size).toBeGreaterThan(3);
  });
});
