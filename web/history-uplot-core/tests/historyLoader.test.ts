import { describe, expect, test, vi } from "vitest";
import {
  createHistoryLoader,
  HISTORY_CACHE_MAX_ENTRIES,
  HISTORY_CACHE_MAX_POINTS,
  HISTORY_CACHE_TTL_MS,
  HISTORY_LATEST_TTL_MS,
} from "../src/history/historyLoader";
import type {
  HistoryAcceptedData,
  HistoryDemand,
  HistoryRangeRequest,
} from "../src/history/types";
import { HistoryAuthError } from "../src/history/types";
import { DAY_MS } from "../src/shared/types";

const request: HistoryRangeRequest = {
  from: 0,
  to: 100,
  rangeLabel: "24h",
  aggregation: "raw",
};
const data = (
  overrides: Partial<HistoryAcceptedData> = {},
): HistoryAcceptedData => ({
  cardId: "soil",
  request,
  coverage: { from: 0, to: 100 },
  series: [
    {
      id: "s",
      label: "S",
      unit: "kPa",
      points: [
        { t: 1, value: 0 },
        { t: 2, value: null },
      ],
    },
  ],
  unitGroups: [{ unit: "kPa", label: "kPa", seriesIds: ["s"] }],
  aggregation: { level: "raw", pointCount: 2 },
  limits: { maxPointsPerSeries: 2000, truncated: false },
  ...overrides,
});
const demand = (
  overrides: Partial<HistoryDemand> = {},
): HistoryDemand => ({
  context: { sessionKey: "session-1", scopeKey: "zone:7", cardId: "soil" },
  visible: { from: 10, to: 90 },
  request,
  horizon: { from: -100, to: 100 },
  reason: "initial",
  forceFresh: false,
  ...overrides,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("pilot whole-response history loader", () => {
  test('keeps equal range coverage separate by read policy', async () => {
    const loader = createHistoryLoader();
    const load = vi.fn(async () => data());
    await loader.foreground(demand({ request: { ...request, readPolicy: 'cloud-rollup-hourly' }, readPolicy: 'cloud-rollup-hourly' }), load).result;
    await loader.foreground(demand({ request: { ...request, readPolicy: 'cloud-raw-hourly' }, readPolicy: 'cloud-raw-hourly' }), load).result;
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('serves a selected subset from a cached superset and evicts denied series', async () => {
    const loader = createHistoryLoader();
    const superset = data({ series: [{ id: 'a', label: 'A', unit: 'kPa', points: [{ t: 1, value: 1 }] }, { id: 'b', label: 'B', unit: 'kPa', points: [{ t: 1, value: 2 }] }] });
    const load = vi.fn(async () => superset);
    const full = demand({ selectedIds: ['a', 'b'], selectionKey: '["a","b"]' });
    await loader.foreground(full, load).result;
    const subset = loader.foreground(demand({ selectedIds: ['a'], selectionKey: '["a"]' }), load);
    expect(subset.source).toBe('cache');
    expect((await subset.result).data.series.map((item) => item.id)).toEqual(['a']);
    loader.evictSeries(['b']);
    const after = loader.foreground(full, load);
    expect(after.source).toBe('network');
  });

  test('eviction aborts an in-flight demand containing a denied series', async () => {
    const loader = createHistoryLoader();
    const pending = deferred<HistoryAcceptedData>();
    const handle = loader.foreground(demand({ selectedIds: ['a'], selectionKey: '["a"]' }), () => pending.promise);
    loader.evictSeries(['a']);
    await expect(handle.result).rejects.toMatchObject({ name: 'AbortError', reason: 'superseded' });
    pending.resolve(data());
  });
  test('does not admit an ignored-abort response after selection eviction', async () => {
    const loader = createHistoryLoader();
    const pending = deferred<HistoryAcceptedData>();
    const handle = loader.foreground(demand({ selectedIds: ['a'], selectionKey: '["a"]' }), () => pending.promise);
    loader.evictSeries(['a']);
    await expect(handle.result).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve(data({ series: [{ ...data().series[0], id: 'a' }] }));
    await Promise.resolve();
    const next = loader.foreground(demand({ selectedIds: ['a'], selectionKey: '["a"]' }), () => Promise.resolve(data({ series: [{ ...data().series[0], id: 'a' }] })));
    expect(next.source).toBe('network');
  });

  test('passes ordered selection context to the transport', async () => {
    const loader = createHistoryLoader();
    const seen: unknown[] = [];
    const load = vi.fn(async (_signal: AbortSignal) => data({ series: [{ ...data().series[0], id: 'a' }, { ...data().series[0], id: 'b' }] }));
    const selected = ['b', 'a'];
    await loader.foreground(demand({ selectedIds: selected, selectionKey: '["a","b"]', request: { ...request, selectionKey: '["a","b"]' }, requestRevision: 3 }), (signal) => { seen.push(signal.aborted); return load(signal); }).result;
    expect(seen).toEqual([false]);
    expect(load).toHaveBeenCalledTimes(1);
  });
  test("returns a covering cache hit while preserving original response age", async () => {
    let clock = 1_000;
    const loader = createHistoryLoader({ now: () => clock });
    const load = vi.fn(async () => data());
    await loader.foreground(demand(), load).result;
    clock += 100;
    const hit = loader.foreground(
      demand({ visible: { from: 20, to: 80 } }),
      load,
    );
    expect(hit.source).toBe("cache");
    expect((await hit.result).receivedAt).toBe(1_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
  test("does not cache truncation or a different actual aggregation", async () => {
    const loader = createHistoryLoader();
    const truncated = vi.fn(async () =>
      data({ limits: { maxPointsPerSeries: 2_000, truncated: true } }),
    );
    await loader.foreground(demand(), truncated).result;
    await loader.foreground(demand(), truncated).result;
    expect(truncated).toHaveBeenCalledTimes(2);
    const mismatch = vi.fn(async () =>
      data({ aggregation: { level: "15m", pointCount: 2 } }),
    );
    await loader.foreground(demand(), mismatch).result;
    await loader.foreground(demand(), mismatch).result;
    expect(mismatch).toHaveBeenCalledTimes(2);
  });
  test("joins exact foreground work and admits an empty response", async () => {
    const loader = createHistoryLoader();
    const pending = deferred<HistoryAcceptedData>();
    const load = vi.fn((signal: AbortSignal) => {
      signal;
      return pending.promise;
    });
    const first = loader.foreground(demand(), load);
    const second = loader.foreground(
      demand({ reason: "retry", forceFresh: true }),
      load,
    );
    expect(second.source).toBe("in-flight");
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(data({ series: [] }));
    await second.result;
    expect(loader.diagnostics().entries).toBe(1);
  });
  test("enforces entry and point bounds", async () => {
    const loader = createHistoryLoader();
    for (let i = 0; i < HISTORY_CACHE_MAX_ENTRIES + 2; i++) {
      const req = { ...request, from: i * 1_000, to: i * 1_000 + 100 };
      await loader.foreground(
        demand({ request: req, visible: { from: req.from, to: req.to } }),
        async () =>
          data({ request: req, coverage: { from: req.from, to: req.to } }),
      ).result;
    }
    expect(loader.diagnostics().entries).toBeLessThanOrEqual(
      HISTORY_CACHE_MAX_ENTRIES,
    );
    expect(loader.diagnostics().points).toBeLessThanOrEqual(
      HISTORY_CACHE_MAX_POINTS,
    );
  });
  test("expires horizon-edge entries more quickly and forceFresh bypasses cache", async () => {
    let clock = 0;
    const loader = createHistoryLoader({ now: () => clock });
    const load = vi.fn(async () => data());
    await loader.foreground(demand(), load).result;
    clock = HISTORY_LATEST_TTL_MS + 1;
    await loader.foreground(demand(), load).result;
    expect(load).toHaveBeenCalledTimes(2);
    clock += HISTORY_CACHE_TTL_MS + 1;
    await loader.foreground(demand({ forceFresh: true }), load).result;
    expect(load).toHaveBeenCalledTimes(3);
  });
  test("clear aborts pending work and removes cache", async () => {
    const loader = createHistoryLoader();
    const pending = deferred<HistoryAcceptedData>();
    const handle = loader.foreground(demand(), () => pending.promise);
    loader.clear();
    await expect(handle.result).rejects.toMatchObject({
      name: "AbortError",
      reason: "cleared",
    });
    expect(loader.diagnostics()).toEqual({
      entries: 0,
      points: 0,
      foregroundActive: false,
      prefetchActive: false,
    });
  });

  test("isolates cache by context and requested aggregation", async () => {
    const loader = createHistoryLoader();
    const load = vi.fn(async () => data());
    await loader.foreground(demand(), load).result;
    await loader.foreground(demand({ context: { ...demand().context, scopeKey: 'zone:8' } }), load).result;
    await loader.foreground(demand({ request: { ...request, aggregation: "15m", rangeLabel: "7d" } }), load).result;
    expect(load).toHaveBeenCalledTimes(3);
  });

  test("uses historical TTL, exact point cost, and skips oversized prefetch responses", async () => {
    let clock = 0;
    const loader = createHistoryLoader({ now: () => clock });
    const historical = demand({ horizon: { from: -DAY_MS, to: 90 * DAY_MS } });
    const load = vi.fn(async () => data());
    await loader.foreground(historical, load).result;
    clock = HISTORY_CACHE_TTL_MS + 1;
    await loader.foreground(historical, load).result;
    expect(load).toHaveBeenCalledTimes(2);
    const oversized = data({ series: [{ ...data().series[0], points: Array.from({ length: HISTORY_CACHE_MAX_POINTS + 1 }, (_, index) => ({ t: index, value: 1 })) }] });
    const prefetch = loader.prefetch(demand({ context: { ...demand().context, cardId: "oversized" } }), async () => oversized);
    await expect(prefetch).resolves.toBe("skipped");
    expect(loader.diagnostics().points).toBeLessThanOrEqual(HISTORY_CACHE_MAX_POINTS);
  });

  test("replaces an LRU entry at the newest position", async () => {
    let clock = 0;
    const loader = createHistoryLoader({ now: () => clock });
    const first = demand();
    const second = demand({ request: { ...request, from: 50, to: 150 }, visible: { from: 60, to: 140 } });
    const load = vi.fn(async (which: HistoryDemand) => data({ request: which.request, coverage: { from: which.request.from, to: which.request.to } }));
    await loader.foreground(first, () => load(first)).result;
    await loader.foreground(second, () => load(second)).result;
    clock += 1;
    await loader.foreground(first, () => load(first)).result;
    expect(loader.foreground(first, () => Promise.resolve(data())).source).toBe("cache");
    for (let index = 0; index < HISTORY_CACHE_MAX_ENTRIES - 1; index += 1) {
      const req = { ...request, from: 1_000 + index * 200, to: 1_100 + index * 200 };
      await loader.foreground(demand({ request: req, visible: { from: req.from, to: req.to } }), () => Promise.resolve(data({ request: req, coverage: { from: req.from, to: req.to } }))).result;
    }
    expect(loader.foreground(first, () => Promise.resolve(data())).source).toBe("cache");
  });

  test("returns skipped for ineligible prefetch data", async () => {
    const loader = createHistoryLoader();
    await expect(loader.prefetch(demand(), async () => data({ limits: { maxPointsPerSeries: 2_000, truncated: true } }))).resolves.toBe("skipped");
    await expect(loader.prefetch(demand(), async () => data({ aggregation: { level: "15m", pointCount: 2 } }))).resolves.toBe("skipped");
  });

  test.each([
    ['short coverage', data({ coverage: { from: 0, to: 99 }, readPolicy: 'edge-hourly' })],
    ['mismatched read policy', data({ readPolicy: 'cloud-rollup-hourly' })],
    ['missing selected series', data({ readPolicy: 'edge-hourly', series: [], unitGroups: [] })],
  ])('does not cache a prefetch response with %s', async (_label, invalid) => {
    const loader = createHistoryLoader();
    const neighbor = demand({
      selectedIds: ['s'],
      selectionKey: '["s"]',
      visible: { from: request.from, to: request.to },
      readPolicy: 'edge-hourly',
      request: { ...request, readPolicy: 'edge-hourly' },
    });
    await loader.prefetch(neighbor, async () => invalid);
    expect(loader.diagnostics().entries).toBe(0);
    const foreground = loader.foreground(neighbor, async () => data({ readPolicy: 'edge-hourly' }));
    expect(foreground.source).toBe('network');
    await foreground.result;
  });

  test("joins a covering request but does not join an overlapping partial request", async () => {
    const loader = createHistoryLoader();
    const pending = deferred<HistoryAcceptedData>();
    const load = vi.fn(() => pending.promise);
    const first = loader.foreground(demand({ request: { ...request, from: 0, to: 200 }, visible: { from: 20, to: 180 } }), load);
    const joined = loader.foreground(demand({ request: { ...request, from: 0, to: 200 }, visible: { from: 80, to: 120 } }), load);
    expect(joined.source).toBe("in-flight");
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(data({ request: { ...request, from: 0, to: 200 }, coverage: { from: 0, to: 200 } }));
    await first.result;
    const partial = loader.foreground(demand({ request: { ...request, from: 100, to: 300 }, visible: { from: 220, to: 280 } }), load);
    expect(partial.source).toBe("network");
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("promoting a newer prefetch reconciles both lanes and clear settles every signal", async () => {
    const loader = createHistoryLoader();
    const calls: Array<{ signal: AbortSignal; pending: ReturnType<typeof deferred<HistoryAcceptedData>>; settled: boolean }> = [];
    const load = vi.fn((signal: AbortSignal) => {
      const call = { signal, pending: deferred<HistoryAcceptedData>(), settled: false };
      calls.push(call);
      return call.pending.promise.finally(() => { call.settled = true; });
    });
    const horizon = { from: 0, to: 90 * DAY_MS };
    const a = { ...request, from: 20 * DAY_MS, to: 21 * DAY_MS };
    const b = { ...request, from: 20.5 * DAY_MS, to: 21.5 * DAY_MS };
    const aDemand = demand({ request: a, visible: { from: a.from + 0.1 * DAY_MS, to: a.to - 0.1 * DAY_MS }, horizon });
    const bDemand = demand({ request: b, visible: { from: b.from + 0.1 * DAY_MS, to: b.to - 0.1 * DAY_MS }, horizon });
    const first = loader.foreground(aDemand, load);
    const prefetchPromise = loader.prefetch(bDemand, load);
    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => !call.signal.aborted && !call.settled)).toHaveLength(2);
    const promoted = loader.foreground(demand({ request: { ...request, from: 20.6 * DAY_MS, to: 20.9 * DAY_MS }, visible: { from: 20.7 * DAY_MS, to: 20.8 * DAY_MS }, horizon }), load);
    expect(promoted.source).toBe("in-flight");
    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => !call.signal.aborted && !call.settled)).toHaveLength(2);
    calls[0].pending.resolve(data({ request: a, coverage: { from: a.from, to: a.to } }));
    await first.result;
    expect(loader.diagnostics().entries).toBe(1);
    expect(calls.filter((call) => !call.signal.aborted && !call.settled)).toHaveLength(1);
    const subsequent = loader.prefetch(demand({ request: { ...request, from: 22 * DAY_MS, to: 23 * DAY_MS }, visible: { from: 22.1 * DAY_MS, to: 22.9 * DAY_MS }, horizon }), load);
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => !call.signal.aborted && !call.settled)).toHaveLength(2);
    loader.clear();
    await expect(first.result).resolves.toBeTruthy();
    await expect(promoted.result).rejects.toMatchObject({ reason: "cleared" });
    await expect(prefetchPromise).resolves.toBe("skipped");
    await expect(subsequent).resolves.toBe("skipped");
    expect(calls.every((call) => call.signal.aborted || call.settled)).toBe(true);
  });

  test("prefetch auth errors reject while ordinary errors stay skipped and destroy settles every handle", async () => {
    const loader = createHistoryLoader();
    await expect(loader.prefetch(demand(), async () => { throw new HistoryAuthError(401, "expired"); })).rejects.toBeInstanceOf(HistoryAuthError);
    await expect(loader.prefetch(demand({ context: { ...demand().context, cardId: "other" } }), async () => { throw new Error("offline"); })).resolves.toBe("skipped");
    const pending = deferred<HistoryAcceptedData>();
    const handle = loader.foreground(demand(), () => pending.promise);
    loader.destroy();
    await expect(handle.result).rejects.toMatchObject({ reason: "destroyed" });
    expect(loader.diagnostics().foregroundActive).toBe(false);
  });

  test("uses newer access ordinal when equal-size cache coverage ties", async () => {
    const loader = createHistoryLoader();
    const first = demand({ request: { ...request, from: 0, to: 100 }, visible: { from: 10, to: 90 } });
    const second = demand({ request: { ...request, from: 50, to: 150 }, visible: { from: 60, to: 140 } });
    const firstData = data({ request: first.request, coverage: { from: 0, to: 100 } });
    const secondData = data({ request: second.request, coverage: { from: 50, to: 150 } });
    await loader.foreground(first, () => Promise.resolve(firstData)).result;
    await loader.foreground(second, () => Promise.resolve(secondData)).result;
    const equalTarget = loader.foreground(demand({ request: { ...request, from: 60, to: 90 }, visible: { from: 60, to: 90 } }), () => Promise.resolve(data()));
    expect(equalTarget.source).toBe("cache");
    expect((await equalTarget.result).data.request.from).toBe(50);
  });

  test("evicts by the normalized point budget", async () => {
    const loader = createHistoryLoader();
    const points = Array.from({ length: 3_000 }, (_, index) => ({ t: index, value: index }));
    for (let index = 0; index < 7; index += 1) {
      const req = { ...request, from: index * 10_000, to: index * 10_000 + 100 };
      await loader.foreground(demand({ request: req, visible: { from: req.from, to: req.to } }), () => Promise.resolve(data({ request: req, coverage: { from: req.from, to: req.to }, series: [{ ...data().series[0], points }] }))).result;
    }
    expect(loader.diagnostics().points).toBeLessThanOrEqual(HISTORY_CACHE_MAX_POINTS);
  });

  test("chooses the newer covering prefetch when foreground and prefetch both match", async () => {
    const loader = createHistoryLoader();
    const first = deferred<HistoryAcceptedData>();
    const second = deferred<HistoryAcceptedData>();
    const firstRequest = { ...request, from: 0, to: 200 };
    const secondRequest = { ...request, from: 0, to: 300 };
    const firstHandle = loader.foreground(demand({ request: firstRequest, visible: { from: 20, to: 180 } }), () => first.promise);
    const prefetch = loader.prefetch(demand({ request: secondRequest, visible: { from: 20, to: 280 } }), () => second.promise);
    const joined = loader.foreground(demand({ request: { ...request, from: 40, to: 160 }, visible: { from: 50, to: 150 } }), () => Promise.resolve(data()));
    expect(joined.source).toBe("in-flight");
    second.resolve(data({ request: secondRequest, coverage: { from: 0, to: 300 } }));
    first.resolve(data({ request: firstRequest, coverage: { from: 0, to: 200 } }));
    expect((await joined.result).data.request.to).toBe(300);
    await expect(firstHandle.result).resolves.toBeTruthy();
    await expect(prefetch).resolves.toBe("joined");
  });

  test("forceFresh bypasses an unexpired cache and joins the exact pending refresh", async () => {
    const loader = createHistoryLoader();
    const load = vi.fn(async () => data());
    await loader.foreground(demand(), load).result;
    const pending = deferred<HistoryAcceptedData>();
    const refresh = loader.foreground(demand({ forceFresh: true, reason: "retry" }), () => pending.promise);
    const joined = loader.foreground(demand({ forceFresh: true, reason: "latest" }), () => pending.promise);
    expect(refresh.source).toBe("network");
    expect(joined.source).toBe("in-flight");
    pending.resolve(data());
    await joined.result;
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("same-key replacement remains newest through entry-limit eviction", async () => {
    const loader = createHistoryLoader();
    const base = demand();
    await loader.foreground(base, () => Promise.resolve(data({ series: [{ ...data().series[0], label: "old" }] }))).result;
    const replacement = loader.foreground({ ...base, forceFresh: true }, () => Promise.resolve(data({ series: [{ ...data().series[0], label: "replacement" }] })));
    await replacement.result;
    for (let index = 0; index < HISTORY_CACHE_MAX_ENTRIES - 1; index += 1) {
      const req = { ...request, from: (index + 1) * 10_000, to: (index + 1) * 10_000 + 100 };
      await loader.foreground(demand({ request: req, visible: { from: req.from, to: req.to } }), () => Promise.resolve(data({ request: req, coverage: { from: req.from, to: req.to } }))).result;
    }
    const retained = loader.foreground(base, () => Promise.resolve(data()));
    expect(retained.source).toBe("cache");
    expect((await retained.result).data.series[0].label).toBe("replacement");
  });

  test("does not union adjacent cached responses for a straddling demand", async () => {
    const loader = createHistoryLoader();
    const left = { ...request, from: 0, to: 100 };
    const right = { ...request, from: 100, to: 200 };
    await loader.foreground(demand({ request: left, visible: { from: 10, to: 90 } }), () => Promise.resolve(data({ request: left, coverage: { from: 0, to: 100 } }))).result;
    await loader.foreground(demand({ request: right, visible: { from: 110, to: 190 } }), () => Promise.resolve(data({ request: right, coverage: { from: 100, to: 200 } }))).result;
    const straddling = loader.foreground(demand({ request: { ...request, from: 50, to: 150 }, visible: { from: 50, to: 150 } }), () => Promise.resolve(data()));
    expect(straddling.source).toBe("network");
  });

  test("cache win leaves no foreground lane and retains only the best useful background slot", async () => {
    const loader = createHistoryLoader();
    const cachedRequest = { ...request, from: 100, to: 200 };
    await loader.foreground(demand({ request: cachedRequest, visible: { from: 110, to: 190 } }), () => Promise.resolve(data({ request: cachedRequest, coverage: { from: 100, to: 200 } }))).result;
    const foregroundPending = deferred<HistoryAcceptedData>();
    const prefetchPending = deferred<HistoryAcceptedData>();
    const foreground = loader.foreground(demand({ request: { ...request, from: 80, to: 180 }, visible: { from: 90, to: 170 } }), () => foregroundPending.promise);
    const prefetch = loader.prefetch(demand({ request: { ...request, from: 400, to: 500 }, visible: { from: 410, to: 490 } }), () => prefetchPending.promise);
    const hit = loader.foreground(demand({ request: cachedRequest, visible: { from: 110, to: 190 } }), () => Promise.resolve(data()));
    expect(hit.source).toBe("cache");
    expect(loader.diagnostics().foregroundActive).toBe(false);
    expect(loader.diagnostics().prefetchActive).toBe(true);
    loader.clear();
    await expect(foreground.result).rejects.toMatchObject({ reason: "cleared" });
    await expect(prefetch).resolves.toBe("skipped");
  });

  test.each([
    ["session", { sessionKey: "session-2" }],
    ["scope", { scopeKey: "zone:8" }],
    ["card", { cardId: "environment" }],
    ["aggregation", { request: { ...request, aggregation: "15m" as const, rangeLabel: "7d" as const } }],
  ])("isolates cache by %s", async (_label, change) => {
    const loader = createHistoryLoader();
    const load = vi.fn(async () => data());
    await loader.foreground(demand(), load).result;
    const variant = "request" in change
      ? demand({ request: change.request })
      : demand({ context: { ...demand().context, ...change } });
    await loader.foreground(variant, load).result;
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("post-destroy demand rejects with destroyed", async () => {
    const loader = createHistoryLoader();
    loader.destroy();
    await expect(loader.foreground(demand(), () => Promise.resolve(data())).result).rejects.toMatchObject({ reason: "destroyed" });
    await expect(loader.prefetch(demand(), () => Promise.resolve(data()))).resolves.toBe("skipped");
  });
});
