import { HistoryAuthError, HistoryAbortError } from "./types";
import type {
  HistoryAcceptedData,
  HistoryContext,
  HistoryDemand,
  HistoryLoadHandle,
  HistoryLoader,
  HistoryLoadValue,
  HistoryRangeRequest,
} from "./types";
import { coverageContains, neighborRequest } from "./range";

export const HISTORY_CACHE_MAX_ENTRIES = 8;
export const HISTORY_CACHE_MAX_POINTS = 20_000;
export const HISTORY_CACHE_TTL_MS = 5 * 60_000;
export const HISTORY_LATEST_TTL_MS = 15_000;
export const HISTORY_PREFETCH_IDLE_MS = 500;
export const HISTORY_PREFETCH_COOLDOWN_MS = 500;
export const HISTORY_SETTLE_MS = 150;
export const HISTORY_NEIGHBOR_SHIFT = 0.8;

type SlotPriority = "foreground" | "prefetch";
interface CacheEntry {
  context: HistoryContext;
  request: HistoryRangeRequest;
  data: HistoryAcceptedData;
  receivedAt: number;
  lastUsed: number;
  lastUsedOrdinal: number;
  points: number;
  horizonEnd: number;
}
interface Slot {
  priority: SlotPriority;
  demand: HistoryDemand;
  controller: AbortController;
  promise: Promise<HistoryLoadValue>;
  reject: (error: unknown) => void;
  settled: boolean;
  startOrdinal: number;
}

const sameContext = (a: HistoryContext, b: HistoryContext) =>
  a.sessionKey === b.sessionKey &&
  a.scopeKey === b.scopeKey &&
  a.cardId === b.cardId &&
  (a.sourceKey ?? null) === (b.sourceKey ?? null);
const sameRequest = (a: HistoryRangeRequest, b: HistoryRangeRequest) =>
  a.from === b.from &&
  a.to === b.to &&
  a.aggregation === b.aggregation &&
  a.rangeLabel === b.rangeLabel;
const intersects = (a: HistoryRangeRequest, b: { from: number; to: number }) =>
  a.from <= b.to && a.to >= b.from;
const pointCost = (data: HistoryAcceptedData) =>
  data.series.reduce((total, series) => total + series.points.length, 0);
const validCoverage = (data: HistoryAcceptedData) =>
  Number.isFinite(data.coverage.from) &&
  Number.isFinite(data.coverage.to) &&
  data.coverage.to >= data.coverage.from;
const cacheEligible = (data: HistoryAcceptedData, request: HistoryRangeRequest) =>
  validCoverage(data) &&
  !data.limits.truncated &&
  data.aggregation.level === request.aggregation &&
  Number.isFinite(pointCost(data));

export function createHistoryLoader(
  options: { now?: () => number } = {},
): HistoryLoader {
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();
  let foreground: Slot | null = null;
  let prefetch: Slot | null = null;
  let totalPoints = 0;
  let destroyed = false;
  let startOrdinal = 0;
  let accessOrdinal = 0;

  const cacheKey = (context: HistoryContext, request: HistoryRangeRequest) =>
    `${context.sessionKey}|${context.scopeKey}|${context.cardId}|${context.sourceKey ?? ''}|${request.from}|${request.to}|${request.aggregation}|${request.rangeLabel}`;
  const ttlFor = (entry: CacheEntry) =>
    Math.abs(entry.horizonEnd - entry.request.to) <= 60_000
      ? HISTORY_LATEST_TTL_MS
      : HISTORY_CACHE_TTL_MS;
  const fresh = (entry: CacheEntry) =>
    now() - entry.receivedAt <= ttlFor(entry);
  const findCache = (demand: HistoryDemand): CacheEntry | null => {
    const candidates = [...cache.values()].filter(
      (entry) =>
        sameContext(entry.context, demand.context) &&
        entry.request.aggregation === demand.request.aggregation &&
        !entry.data.limits.truncated &&
        entry.data.aggregation.level === demand.request.aggregation &&
        coverageContains(
          entry.data,
          demand.visible,
          demand.request.aggregation,
        ) &&
        fresh(entry),
    );
    candidates.sort((a, b) => {
      const aSize = a.data.coverage.to - a.data.coverage.from;
      const bSize = b.data.coverage.to - b.data.coverage.from;
      return aSize - bSize || b.lastUsedOrdinal - a.lastUsedOrdinal;
    });
    const hit = candidates[0];
    if (hit) {
      hit.lastUsed = now();
      hit.lastUsedOrdinal = ++accessOrdinal;
      const key = cacheKey(hit.context, hit.request);
      cache.delete(key);
      cache.set(key, hit);
    }
    return hit ?? null;
  };
  const admit = (demand: HistoryDemand, value: HistoryLoadValue) => {
    const points = pointCost(value.data);
    if (
      !cacheEligible(value.data, demand.request) ||
      points > HISTORY_CACHE_MAX_POINTS
    )
      return;
    const key = cacheKey(demand.context, demand.request);
    const previous = cache.get(key);
    if (previous) totalPoints -= previous.points;
    cache.delete(key);
    cache.set(key, {
      context: demand.context,
      request: demand.request,
      data: value.data,
      receivedAt: value.receivedAt,
      lastUsed: now(),
      lastUsedOrdinal: ++accessOrdinal,
      points,
      horizonEnd: demand.horizon.to,
    });
    totalPoints += points;
    for (const [oldKey, entry] of [...cache.entries()]) {
      if (now() - entry.receivedAt > ttlFor(entry)) {
        cache.delete(oldKey);
        totalPoints -= entry.points;
      }
    }
    while (
      cache.size > HISTORY_CACHE_MAX_ENTRIES ||
      totalPoints > HISTORY_CACHE_MAX_POINTS
    ) {
      const oldest = cache.entries().next().value as
        | [string, CacheEntry]
        | undefined;
      if (!oldest) break;
      cache.delete(oldest[0]);
      totalPoints -= oldest[1].points;
    }
  };
  const abortSlot = (
    slot: Slot | null,
    reason: "superseded" | "cleared" | "destroyed",
  ) => {
    if (!slot || slot.settled) return;
    slot.controller.abort();
    slot.reject(new HistoryAbortError(reason));
    slot.settled = true;
  };
  const matchingSlot = (demand: HistoryDemand): Slot | null => {
    const matches = [foreground, prefetch].filter((slot): slot is Slot => !!slot && !slot.settled && !slot.controller.signal.aborted &&
      (
        slot &&
        sameContext(slot.demand.context, demand.context) &&
        slot.demand.request.aggregation === demand.request.aggregation &&
        (sameRequest(slot.demand.request, demand.request) ||
          (slot.demand.request.from <= demand.visible.from &&
            slot.demand.request.to >= demand.visible.to))
      ));
    matches.sort((a, b) => b.startOrdinal - a.startOrdinal);
    return matches[0] ?? null;
  };
  const makeSlot = (
    demand: HistoryDemand,
    load: (signal: AbortSignal) => Promise<HistoryAcceptedData>,
    priority: SlotPriority,
  ): Slot => {
    const controller = new AbortController();
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<HistoryLoadValue>((resolve, reject) => {
      rejectPromise = reject;
      void load(controller.signal)
        .then((data) => {
          const value = { data, receivedAt: now() };
          if (!controller.signal.aborted) admit(demand, value);
          resolve(value);
        })
        .catch((error) => reject(error));
    });
    const slot: Slot = {
      priority,
      demand,
      controller,
      promise,
      reject: rejectPromise,
      settled: false,
      startOrdinal: ++startOrdinal,
    };
    promise.then(
      () => {
        slot.settled = true;
        if (foreground === slot) foreground = null;
        if (prefetch === slot) prefetch = null;
      },
      () => {
        slot.settled = true;
        if (foreground === slot) foreground = null;
        if (prefetch === slot) prefetch = null;
      },
    );
    return slot;
  };
  const handleFor = (
    source: HistoryLoadHandle["source"],
    demand: HistoryDemand,
    result: Promise<HistoryLoadValue>,
  ): HistoryLoadHandle => ({ source, request: demand.request, result });
  const promote = (slot: Slot) => {
    slot.priority = "foreground";
    foreground = slot;
    if (prefetch === slot) prefetch = null;
  };
  const usefulness = (slot: Slot, demand: HistoryDemand): number => {
    if (!sameContext(slot.demand.context, demand.context) || slot.demand.request.aggregation !== demand.request.aggregation) return 0;
    if (intersects(slot.demand.request, demand.visible)) return 2;
    const neighbor = neighborRequest(demand.visible, demand.direction ?? "back", demand.horizon);
    return neighbor && intersects(slot.demand.request, neighbor) ? 1 : 0;
  };
  const retainBest = (demand: HistoryDemand, candidates: Slot[]): void => {
    if (prefetch && candidates.includes(prefetch)) prefetch = null;
    const useful = candidates
      .map((slot) => ({ slot, rank: usefulness(slot, demand) }))
      .filter(({ slot, rank }) => !slot.settled && !slot.controller.signal.aborted && rank > 0)
      .sort((a, b) => b.rank - a.rank || b.slot.startOrdinal - a.slot.startOrdinal);
    const keep = useful[0]?.slot ?? null;
    for (const slot of candidates) {
      if (slot === keep) {
        slot.priority = "prefetch";
        prefetch = slot;
      } else abortSlot(slot, "superseded");
    }
  };
  const startForeground = (
    demand: HistoryDemand,
    load: (signal: AbortSignal) => Promise<HistoryAcceptedData>,
  ) => {
    const slot = makeSlot(demand, load, "foreground");
    foreground = slot;
    return handleFor("network", demand, slot.promise);
  };
  const foregroundMethod = (
    demand: HistoryDemand,
    load: (signal: AbortSignal) => Promise<HistoryAcceptedData>,
  ): HistoryLoadHandle => {
    if (destroyed)
      return handleFor(
        "in-flight",
        demand,
        Promise.reject(new HistoryAbortError("destroyed")),
      );
    if (!demand.forceFresh) {
      const hit = findCache(demand);
      if (hit) {
        retainBest(demand, [foreground, prefetch].filter((slot): slot is Slot => !!slot));
        foreground = null;
        const value = { data: hit.data, receivedAt: hit.receivedAt };
        return handleFor("cache", demand, Promise.resolve(value));
      }
    }
    const joined = matchingSlot(demand);
    if (joined) {
      const other = [foreground, prefetch].filter((slot): slot is Slot => !!slot && slot !== joined);
      promote(joined);
      retainBest(demand, other);
      return handleFor("in-flight", demand, joined.promise);
    }
    const oldSlots = [foreground, prefetch].filter((slot): slot is Slot => !!slot);
    foreground = null;
    prefetch = null;
    retainBest(demand, oldSlots);
    return startForeground(demand, load);
  };
  return {
    foreground: foregroundMethod,
    async prefetch(demand, load) {
      if (destroyed) return "skipped";
      if (findCache(demand)) return "cached";
      const joined = matchingSlot(demand);
      if (joined) {
        if (joined.priority === "prefetch") return "joined";
        promote(joined);
        return "joined";
      }
      if (prefetch) {
        if (!prefetch.settled) return "skipped";
        prefetch = null;
      }
      const slot = makeSlot(demand, load, "prefetch");
      prefetch = slot;
      try {
        const value = await slot.promise;
        return cacheEligible(value.data, demand.request) && pointCost(value.data) <= HISTORY_CACHE_MAX_POINTS ? "joined" : "skipped";
      } catch (error) {
        if (error instanceof HistoryAuthError) throw error;
        return "skipped";
      }
    },
    abortPrefetch() {
      abortSlot(prefetch, "superseded");
      prefetch = null;
    },
    clear() {
      for (const slot of [foreground, prefetch]) abortSlot(slot, "cleared");
      foreground = null;
      prefetch = null;
      cache.clear();
      totalPoints = 0;
    },
    destroy() {
      destroyed = true;
      for (const slot of [foreground, prefetch]) abortSlot(slot, "destroyed");
      foreground = null;
      prefetch = null;
      cache.clear();
      totalPoints = 0;
    },
    diagnostics: () => ({
      entries: cache.size,
      points: totalPoints,
      foregroundActive: foreground !== null && !foreground.settled,
      prefetchActive: prefetch !== null && !prefetch.settled,
    }),
  };
}
