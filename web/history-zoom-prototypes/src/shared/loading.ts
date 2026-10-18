import { fixtureSeries } from './fixtures';
import type { FixtureKind, SensorSeries } from './types';

export function requestFixture(kind: FixtureKind, delayMs: number): Promise<readonly SensorSeries[]> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(fixtureSeries(kind)), delayMs);
  });
}

export function createFixtureLoader(load = requestFixture) {
  let generation = 0;
  let destroyed = false;
  return {
    async load(kind: FixtureKind, delayMs: number, apply: (series: readonly SensorSeries[]) => void) {
      const mine = ++generation;
      const series = await load(kind, delayMs);
      if (destroyed || mine !== generation) return false;
      apply(series);
      return true;
    },
    destroy() { destroyed = true; generation += 1; },
  };
}
