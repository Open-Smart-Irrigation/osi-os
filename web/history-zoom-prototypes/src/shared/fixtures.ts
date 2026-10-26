import { DAY_MS, FIXTURE_EXTENT, HOUR_MS, MINUTE_MS, type FixtureKind, type Point, type SensorSeries } from './types';

export const FIXTURE_FEATURES = {
  nominal: {
    outageStart: FIXTURE_EXTENT.to - 17 * HOUR_MS,
    outageEnd: FIXTURE_EXTENT.to - 11 * HOUR_MS,
    spike: FIXTURE_EXTENT.to - 5 * HOUR_MS,
    zero: FIXTURE_EXTENT.to - 3 * HOUR_MS,
    minimumPointCount: 10_000,
  },
  sparse: {
    initialNull: FIXTURE_EXTENT.to - 18 * HOUR_MS,
    initialIsolated: FIXTURE_EXTENT.to - 7 * HOUR_MS,
  },
} as const;

const labels = ['SWT 1', 'SWT 2', 'SWT 3'];
const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

function freezeSeries(series: SensorSeries[]): readonly SensorSeries[] {
  for (const item of series) {
    for (const point of item.points) Object.freeze(point);
    Object.freeze(item.points);
    Object.freeze(item);
  }
  return Object.freeze(series);
}

function makeSeries(id: string, index: number, points: Point[]): SensorSeries {
  points.sort((a, b) => a.t - b.t);
  const unique = new Map<number, Point>();
  for (const point of points) unique.set(point.t, point);
  return { id, label: labels[index], unit: 'kPa', points: [...unique.values()] };
}

function nominal(): readonly SensorSeries[] {
  const start = FIXTURE_EXTENT.from;
  const random = seeded(0x51a7 + 17);
  const series = [0, 1, 2].map((index) => {
    const points: Point[] = [];
    for (let t = start; t <= FIXTURE_EXTENT.to; t += 40 * MINUTE_MS) {
      points.push({ t, value: Number((18 + index * 7 + random() * 36).toFixed(2)) });
    }
    for (let i = 0; i < 150; i += 1) {
      points.push({ t: start + 89 * DAY_MS + i * 9 * MINUTE_MS + (index + 1) * MINUTE_MS, value: Number((20 + index * 5 + random() * 45).toFixed(2)) });
    }
    if (index === 0) {
      points.push(
        { t: FIXTURE_FEATURES.nominal.outageStart - MINUTE_MS, value: 38 },
        { t: FIXTURE_FEATURES.nominal.outageStart, value: null },
        { t: FIXTURE_FEATURES.nominal.spike, value: 96 },
        { t: FIXTURE_FEATURES.nominal.zero, value: 0 },
      );
      for (let t = FIXTURE_FEATURES.nominal.outageStart + 40 * MINUTE_MS; t < FIXTURE_FEATURES.nominal.outageEnd; t += 40 * MINUTE_MS) points.push({ t, value: null });
      points.push({ t: FIXTURE_FEATURES.nominal.outageEnd, value: null }, { t: FIXTURE_FEATURES.nominal.outageEnd + MINUTE_MS, value: 41 });
      for (const point of points) {
        if (point.t >= FIXTURE_FEATURES.nominal.outageStart && point.t <= FIXTURE_FEATURES.nominal.outageEnd) point.value = null;
      }
    }
    return makeSeries(`swt-${index + 1}`, index, points);
  });
  return freezeSeries(series);
}

function sparse(): readonly SensorSeries[] {
  const series = [0, 1, 2].map((index) => {
    const points: Point[] = [];
    for (let i = 0; i < 36; i += 1) {
      const t = FIXTURE_EXTENT.from + (i < 8 ? i * 11 * HOUR_MS : 40 * DAY_MS + (i - 8) * 31 * HOUR_MS) + index * 7 * MINUTE_MS;
      points.push({ t, value: i % 9 === 0 ? null : 12 + index * 8 + i });
    }
    const initial = FIXTURE_EXTENT.to - DAY_MS;
    points.push(
      { t: initial + 37 * MINUTE_MS + index * MINUTE_MS, value: 22 + index },
      { t: FIXTURE_FEATURES.sparse.initialNull + index * MINUTE_MS, value: null },
      { t: FIXTURE_FEATURES.sparse.initialIsolated + index * MINUTE_MS, value: 68 + index },
      { t: FIXTURE_EXTENT.to - 2 * HOUR_MS + index * MINUTE_MS, value: 31 + index },
    );
    return makeSeries(`swt-${index + 1}`, index, points);
  });
  return freezeSeries(series);
}

function stress(): readonly SensorSeries[] {
  const series = [0, 1, 2].map((index) => {
    const points: Point[] = [];
    const random = seeded(0x900d + index);
    for (let i = 0; i < 43_200; i += 1) {
      const t = FIXTURE_EXTENT.from + i * 3 * MINUTE_MS;
      let value: number | null = Number((15 + index * 10 + random() * 60).toFixed(2));
      if (i % 7_777 === 0) value = null;
      if (i % 10_001 === 0) value = 0;
      if (i % 12_345 === 0) value = 96;
      points.push({ t, value });
    }
    return makeSeries(`swt-${index + 1}`, index, points);
  });
  return freezeSeries(series);
}

let cache: Partial<Record<FixtureKind, readonly SensorSeries[]>> = {};

export function fixtureSeries(kind: FixtureKind): readonly SensorSeries[] {
  if (cache[kind]) return cache[kind]!;
  const result = kind === 'nominal' ? nominal() : kind === 'sparse' ? sparse() : kind === 'stress' ? stress() : kind === 'empty' ? Object.freeze([]) : freezeSeries([makeSeries('swt-1', 0, [{ t: FIXTURE_EXTENT.to - 2 * HOUR_MS, value: 42 }])]);
  cache = { ...cache, [kind]: result };
  return result;
}
