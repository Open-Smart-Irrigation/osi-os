import { createHistoryLoader } from "../../../history-uplot-core/src/history/historyLoader";
import {
  HISTORY_CACHE_MAX_ENTRIES,
  HISTORY_CACHE_MAX_POINTS,
  HISTORY_CACHE_TTL_MS,
  HISTORY_LATEST_TTL_MS,
  HISTORY_PREFETCH_COOLDOWN_MS,
  HISTORY_PREFETCH_IDLE_MS,
  HISTORY_SETTLE_MS,
  HISTORY_NEIGHBOR_SHIFT,
} from "../../../history-uplot-core/src/history/historyLoader";
import { HISTORY_MAX_VIEWPORT_SPAN_MS, HISTORY_NAVIGATION_START_MS } from "../../../history-uplot-core/src/history/range";
import { HistoryAbortError, HistoryAuthError } from "../../../history-uplot-core/src/history/types";
import { PilotAuthError, PilotHistoryAbortError } from "./types";
import type {
  PilotAcceptedData,
  PilotHistoryDemand,
  PilotHistoryLoadHandle,
  PilotHistoryLoader,
  PilotHistoryLoadValue,
} from "./types";

export {
  HISTORY_CACHE_MAX_ENTRIES,
  HISTORY_CACHE_MAX_POINTS,
  HISTORY_CACHE_TTL_MS,
  HISTORY_LATEST_TTL_MS,
  HISTORY_PREFETCH_COOLDOWN_MS,
  HISTORY_PREFETCH_IDLE_MS,
  HISTORY_SETTLE_MS,
  HISTORY_NEIGHBOR_SHIFT,
  HISTORY_MAX_VIEWPORT_SPAN_MS,
  HISTORY_NAVIGATION_START_MS,
};

const contextFor = (demand: PilotHistoryDemand) => ({
  sessionKey: `${demand.context.platform}:${demand.context.sessionEpoch}`,
  scopeKey: `zone:${demand.context.zoneId}`,
  cardId: demand.context.cardId,
});

const sharedDemandFor = (demand: PilotHistoryDemand) => ({
  context: contextFor(demand),
  visible: demand.visible,
  request: demand.request,
  horizon: demand.horizon,
  reason: demand.reason,
  forceFresh: demand.forceFresh,
  direction: demand.direction,
});

const sharedLoad = (load: (signal: AbortSignal) => Promise<PilotAcceptedData>) =>
  async (signal: AbortSignal): Promise<PilotAcceptedData> => {
    try {
      return await load(signal);
    } catch (error) {
      if (error instanceof PilotAuthError) {
        throw new HistoryAuthError(error.status, error.message);
      }
      throw error;
    }
  };

const pilotHandle = (
  handle: ReturnType<ReturnType<typeof createHistoryLoader>["foreground"]>,
): PilotHistoryLoadHandle => ({
  source: handle.source,
  request: handle.request,
  result: handle.result.then((value) => value as PilotHistoryLoadValue, (error: unknown) => {
    if (error instanceof HistoryAbortError) {
      throw new PilotHistoryAbortError(error.reason);
    }
    if (error instanceof HistoryAuthError) {
      throw new PilotAuthError(error.status, error.message);
    }
    throw error;
  }),
});

const pilotError = (error: unknown): never => {
  if (error instanceof HistoryAuthError) throw new PilotAuthError(error.status, error.message);
  throw error;
};

export function createPilotHistoryLoader(options: { now?: () => number } = {}): PilotHistoryLoader {
  const shared = createHistoryLoader(options);
  return {
    foreground(demand, load) {
      return pilotHandle(shared.foreground(
        sharedDemandFor(demand),
        sharedLoad(load),
      ));
    },
    prefetch(demand, load) {
      return shared.prefetch(
        sharedDemandFor(demand),
        sharedLoad(load),
      ).catch(pilotError);
    },
    abortPrefetch: () => shared.abortPrefetch(),
    clear: () => shared.clear(),
    destroy: () => shared.destroy(),
    diagnostics: () => shared.diagnostics(),
  };
}
