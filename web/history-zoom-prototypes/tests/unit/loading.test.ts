import { afterEach, describe, expect, test, vi } from 'vitest';
import { createFixtureLoader, requestFixture } from '../../src/shared/loading';

describe('delayed fixture loading', () => {
  afterEach(() => vi.useRealTimers());

  test('resolves through the browser timer', async () => {
    vi.useFakeTimers();
    const promise = requestFixture('sparse', 10);
    await vi.advanceTimersByTimeAsync(10);
    expect((await promise).length).toBeGreaterThan(0);
  });

  test('applies only the latest request when an older response resolves last', async () => {
    const deferred: Array<(value: readonly never[]) => void> = [];
    const load = vi.fn(() => new Promise<readonly never[]>((resolve) => deferred.push(resolve)));
    const owner = createFixtureLoader(load);
    const applied: unknown[] = [];
    const first = owner.load('nominal', 100, (value) => applied.push(value));
    const second = owner.load('sparse', 10, (value) => applied.push(value));
    deferred[1]([]);
    expect(await second).toBe(true);
    deferred[0]([]);
    expect(await first).toBe(false);
    expect(applied).toHaveLength(1);
  });

  test('does not apply an outstanding request after destroy', async () => {
    let resolve!: (value: readonly never[]) => void;
    const owner = createFixtureLoader(() => new Promise<readonly never[]>((done) => { resolve = done; }));
    const applied: unknown[] = [];
    const pending = owner.load('nominal', 0, (value) => applied.push(value));
    owner.destroy();
    resolve([]);
    expect(await pending).toBe(false);
    expect(applied).toEqual([]);
  });
});
