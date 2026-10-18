import { describe, expect, it } from 'vitest';
import { inspectAtTime } from '../../src/shared/inspection';
import { HOUR_MS, INITIAL_VIEWPORT, type SensorSeries } from '../../src/shared/types';

const series: SensorSeries = { id: 'one', label: 'One', unit: 'kPa', points: [{ t: INITIAL_VIEWPORT.to - HOUR_MS, value: 0 }, { t: INITIAL_VIEWPORT.to, value: null }] };

describe('inspectAtTime', () => {
  it('keeps zero values and their actual timestamp', () => {
    expect(inspectAtTime(series, series.points[0].t, INITIAL_VIEWPORT)).toMatchObject({ kind: 'value', value: 0, sampledAt: series.points[0].t });
  });
  it('chooses a nearby null sample as unavailable without searching past it', () => {
    expect(inspectAtTime(series, series.points[1].t + 1, INITIAL_VIEWPORT)).toEqual({ kind: 'unavailable' });
  });
  it('returns unavailable for empty data and distant taps', () => {
    expect(inspectAtTime({ ...series, points: [] }, INITIAL_VIEWPORT.from, INITIAL_VIEWPORT)).toEqual({ kind: 'unavailable' });
    expect(inspectAtTime(series, INITIAL_VIEWPORT.from, { from: INITIAL_VIEWPORT.from, to: INITIAL_VIEWPORT.from + HOUR_MS })).toEqual({ kind: 'unavailable' });
  });
  it('returns one row per series at the same pinned timestamp', () => {
    const second = { ...series, id: 'two', label: 'Two', points: [{ t: series.points[0].t, value: 12 }] };
    expect(inspectAtTime([series, second], series.points[0].t, INITIAL_VIEWPORT)).toHaveLength(2);
    expect(inspectAtTime([series, second], series.points[0].t, INITIAL_VIEWPORT)[1]).toMatchObject({ kind: 'value', sampledAt: series.points[0].t });
  });
});
