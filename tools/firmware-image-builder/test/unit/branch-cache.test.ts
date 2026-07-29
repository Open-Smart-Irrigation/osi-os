import { describe, expect, it } from 'vitest';

import {
  BranchCache,
  DEFAULT_BRANCH_CACHE_TTL_MS,
  type BranchCacheSource,
} from '../../api/src/branch-cache.js';
import type { BranchList } from '../../api/src/git/source-resolver.js';

const FETCHED_AT = '2026-07-29T10:00:00.000Z';
const COMMIT_TIME = '2026-07-28T10:00:00.000Z';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function branch(name: string, sha = SHA_A) {
  return { name, sha, commitTime: COMMIT_TIME, subject: `${name} subject` };
}

function list(...branches: ReturnType<typeof branch>[]): BranchList {
  return { fetchedAt: FETCHED_AT, branches };
}

class TypedFetchError extends Error {
  readonly kind = 'typed-fetch-error';
}

function sourceFor(...results: (BranchList | Error)[]): BranchCacheSource & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async listBranches() {
      const result = results[Math.min(calls++, results.length - 1)];
      if (result instanceof Error) throw result;
      return result!;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('BranchCache', () => {
  it('uses the default TTL and fetches when there is no snapshot', async () => {
    expect(DEFAULT_BRANCH_CACHE_TTL_MS).toBe(300_000);
    let now = 1_000;
    const source = sourceFor(list(branch('main')));
    const cache = new BranchCache(source, { clock: () => now });

    expect(cache.peek()).toEqual({ snapshot: null, stale: false });
    const snapshot = await cache.get();

    expect(snapshot.branches.map(({ name }) => name)).toEqual(['main']);
    expect(source.calls).toBe(1);
    expect(cache.peek()).toEqual({ snapshot, stale: false });
  });

  it('keeps a snapshot fresh through the exact TTL boundary', async () => {
    let now = 1_000;
    const source = sourceFor(list(branch('main')), list(branch('next')));
    const cache = new BranchCache(source, { clock: () => now });

    const first = await cache.get();
    now += DEFAULT_BRANCH_CACHE_TTL_MS;

    expect(await cache.get()).toBe(first);
    expect(source.calls).toBe(1);
    expect(cache.peek()).toEqual({ snapshot: first, stale: false });
  });

  it('starts the TTL at successful fetch completion', async () => {
    let now = 1_000;
    const pending = deferred<BranchList>();
    let calls = 0;
    const source: BranchCacheSource = {
      listBranches: async () => {
        calls += 1;
        return calls === 1 ? pending.promise : list(branch('next'));
      },
    };
    const cache = new BranchCache(source, { clock: () => now });
    const firstFetch = cache.get();
    now = 2_000;
    pending.resolve(list(branch('main')));
    const first = await firstFetch;

    now = 2_000 + DEFAULT_BRANCH_CACHE_TTL_MS;
    expect(await cache.get()).toBe(first);
    now += 1;
    expect((await cache.get()).branches[0]?.name).toBe('next');
    expect(calls).toBe(2);
  });

  it('refreshes a stale snapshot and marks it stale without fetching from peek', async () => {
    let now = 1_000;
    const source = sourceFor(list(branch('main')), list(branch('next')));
    const cache = new BranchCache(source, { clock: () => now });

    const first = await cache.get();
    now += DEFAULT_BRANCH_CACHE_TTL_MS + 1;

    expect(cache.peek()).toEqual({ snapshot: first, stale: true });
    expect(source.calls).toBe(1);
    const second = await cache.get();

    expect(second.branches[0]?.name).toBe('next');
    expect(source.calls).toBe(2);
    expect(cache.peek()).toEqual({ snapshot: second, stale: false });
  });

  it('force-refreshes even while the retained snapshot is fresh', async () => {
    let now = 1_000;
    const source = sourceFor(list(branch('main')), list(branch('next')));
    const cache = new BranchCache(source, { clock: () => now });

    const first = await cache.get();
    const second = await cache.refresh();

    expect(second).not.toBe(first);
    expect(second.branches[0]?.name).toBe('next');
    expect(source.calls).toBe(2);
  });

  it('shares one in-flight fetch between concurrent get and refresh calls', async () => {
    const pending = deferred<BranchList>();
    let calls = 0;
    const source: BranchCacheSource = {
      listBranches: async () => {
        calls += 1;
        return pending.promise;
      },
    };
    const cache = new BranchCache(source, { clock: () => 1_000 });

    const first = cache.get();
    const second = cache.refresh();
    pending.resolve(list(branch('main')));

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(Object.isFrozen(firstSnapshot)).toBe(true);
  });

  it('retains the last successful snapshot and preserves the original fetch error', async () => {
    let now = 1_000;
    const failure = new TypedFetchError('remote unavailable');
    const source = sourceFor(list(branch('main')), failure);
    const cache = new BranchCache(source, { clock: () => now });
    const first = await cache.get();
    now += DEFAULT_BRANCH_CACHE_TTL_MS + 1;

    await expect(cache.get()).rejects.toBe(failure);
    expect(cache.peek()).toEqual({ snapshot: first, stale: true });
  });

  it('rejects malformed results without replacing a successful snapshot', async () => {
    let now = 1_000;
    const source = sourceFor(list(branch('main')), { fetchedAt: 'not-an-instant', branches: [] } as unknown as BranchList);
    const cache = new BranchCache(source, { clock: () => now });
    const first = await cache.get();
    now += DEFAULT_BRANCH_CACHE_TTL_MS + 1;

    await expect(cache.get()).rejects.toThrow();
    expect(cache.peek()).toEqual({ snapshot: first, stale: true });
  });

  it('sorts unique branch records in the immutable snapshot', async () => {
    let now = 1_000;
    const source = sourceFor(list(branch('zeta', SHA_B), branch('main')));
    const cache = new BranchCache(source, { clock: () => now });
    const snapshot = await cache.get();

    expect(snapshot.branches.map(({ name }) => name)).toEqual(['main', 'zeta']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.branches)).toBe(true);
    expect(Object.isFrozen(snapshot.branches[0])).toBe(true);
  });

  it('does not retain mutations to the source result or expose mutable cache state', async () => {
    let now = 1_000;
    const sourceResult = { fetchedAt: FETCHED_AT, branches: [branch('main')] };
    const source = sourceFor(sourceResult);
    const cache = new BranchCache(source, { clock: () => now });
    const snapshot = await cache.get();

    sourceResult.branches[0]!.name = 'changed';
    sourceResult.branches.push(branch('other'));

    expect(snapshot.branches).toHaveLength(1);
    expect(snapshot.branches[0]?.name).toBe('main');
    const mutableBranches = snapshot.branches as unknown as { push: (value: ReturnType<typeof branch>) => void };
    const mutableBranch = snapshot.branches[0] as unknown as { name: string };
    expect(() => mutableBranches.push(branch('other'))).toThrow(TypeError);
    expect(() => { mutableBranch.name = 'changed'; }).toThrow(TypeError);
  });

  it.each([
    ['invalid branch name', list(branch('HEAD'))],
    ['invalid SHA', list(branch('main', 'A'.repeat(40)))],
    ['non-canonical commit time', { fetchedAt: FETCHED_AT, branches: [{ ...branch('main'), commitTime: '2026-07-28T10:00:00Z' }] }],
    ['oversized subject', { fetchedAt: FETCHED_AT, branches: [{ ...branch('main'), subject: 'a'.repeat(65_537) }] }],
    ['duplicate branch name', list(branch('main'), branch('main', SHA_B))],
    ['too many branches', { fetchedAt: FETCHED_AT, branches: Array.from({ length: 1_001 }, (_, index) => branch(`branch-${index}`)) }],
  ])('rejects %s', async (_description, malformed) => {
    const source = sourceFor(malformed as BranchList);
    const cache = new BranchCache(source, { clock: () => 1_000 });

    await expect(cache.get()).rejects.toThrow();
    expect(cache.peek()).toEqual({ snapshot: null, stale: false });
  });

  it('validates TTL and clock values and rejects clock regression', async () => {
    const source = sourceFor(list(branch('main')));
    expect(() => new BranchCache(source, { ttlMs: -1 })).toThrow(TypeError);
    expect(() => new BranchCache(source, { ttlMs: Number.NaN })).toThrow(TypeError);
    expect(() => new BranchCache(source, { clock: () => Number.POSITIVE_INFINITY }).get()).toThrow(TypeError);

    let now = 1_000;
    const cache = new BranchCache(source, { clock: () => now });
    await cache.get();
    now = 999;

    expect(() => cache.peek()).toThrow(/regression/i);
  });
});
