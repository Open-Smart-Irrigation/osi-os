import { describe, expect, it } from 'vitest';
import { computeWindRose, DEFAULT_WIND_SPEED_BINS } from '../wind';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const roseTotalPct = (r: ReturnType<typeof computeWindRose>) =>
  sum(r.sectors.map((s) => s.totalPct)) + r.calmPct;

describe('computeWindRose', () => {
  it('returns 16 sectors in COMPASS_POINTS order with default bins', () => {
    const rose = computeWindRose([]);
    expect(rose.sectors).toHaveLength(16);
    expect(rose.sectors[0].direction).toBe('N');
    expect(rose.sectors[4].direction).toBe('E');
    expect(rose.speedBins).toEqual(DEFAULT_WIND_SPEED_BINS);
    expect(rose.validSamples).toBe(0);
    expect(rose.calmPct).toBe(0);
  });

  it('ignores samples missing speed or direction', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 3, wind_direction_deg: null },
      { wind_speed_mps: null, wind_direction_deg: 90 },
      { wind_speed_mps: Number.NaN, wind_direction_deg: 90 },
    ]);
    expect(rose.validSamples).toBe(0);
  });

  it('buckets a sample into the correct direction sector and speed bin', () => {
    const rose = computeWindRose([{ wind_speed_mps: 3.5, wind_direction_deg: 90 }]);
    expect(rose.validSamples).toBe(1);
    const east = rose.sectors[4];
    expect(east.direction).toBe('E');
    expect(east.bins[3]).toBeCloseTo(100);
    expect(east.totalPct).toBeCloseTo(100);
  });

  it('treats bin boundaries as [min, max): 1.0 -> "1–2", 5.0 -> "5+"', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 1.0, wind_direction_deg: 0 },
      { wind_speed_mps: 5.0, wind_direction_deg: 0 },
    ]);
    const north = rose.sectors[0];
    expect(north.bins[1]).toBeCloseTo(50);
    expect(north.bins[5]).toBeCloseTo(50);
  });

  it('ignores null speed/direction even though Number(null) === 0', () => {
    const rose = computeWindRose([
      { wind_speed_mps: null, wind_direction_deg: 90 },
      { wind_speed_mps: 3, wind_direction_deg: null },
    ]);
    expect(rose.validSamples).toBe(0);
    expect(rose.calmSamples).toBe(0);
  });

  it('counts samples below the calm threshold as calm, excluded from petals', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 0.2, wind_direction_deg: 45 },
      { wind_speed_mps: 3, wind_direction_deg: 45 },
    ]);
    expect(rose.calmSamples).toBe(1);
    expect(rose.calmPct).toBeCloseTo(50);
    expect(sum(rose.sectors.map((s) => s.totalPct))).toBeCloseTo(50);
  });

  it('wraps direction at 0/360 degrees: 358 and 2 both land in N', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 3, wind_direction_deg: 358 },
      { wind_speed_mps: 3, wind_direction_deg: 2 },
    ]);
    expect(rose.sectors[0].direction).toBe('N');
    expect(rose.sectors[0].totalPct).toBeCloseTo(100);
  });

  it('petal percentages plus calm always sum to 100 for non-empty input', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 0.1, wind_direction_deg: 10 },
      { wind_speed_mps: 2.5, wind_direction_deg: 100 },
      { wind_speed_mps: 6, wind_direction_deg: 200 },
      { wind_speed_mps: 4.2, wind_direction_deg: 280 },
    ]);
    expect(roseTotalPct(rose)).toBeCloseTo(100);
  });

  it('honors a custom calm threshold', () => {
    const rose = computeWindRose(
      [{ wind_speed_mps: 0.8, wind_direction_deg: 45 }],
      { calmThreshold: 1.0 },
    );
    expect(rose.calmSamples).toBe(1);
  });

  it('reports 100% calm and zero petals when every sample is calm', () => {
    const rose = computeWindRose([
      { wind_speed_mps: 0.1, wind_direction_deg: 10 },
      { wind_speed_mps: 0.3, wind_direction_deg: 200 },
    ]);
    expect(rose.validSamples).toBe(2);
    expect(rose.calmSamples).toBe(2);
    expect(rose.calmPct).toBeCloseTo(100);
    expect(sum(rose.sectors.map((s) => s.totalPct))).toBeCloseTo(0);
  });
});
