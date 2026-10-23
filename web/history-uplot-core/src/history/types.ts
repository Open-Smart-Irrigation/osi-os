import type {
  HistoryWindowContext,
  HistoryWindowReason,
  HistoryWindowRequest,
  HistoryWindowResponse,
  SensorSeries,
  Viewport,
} from '../shared/types';

export type HistoryAcceptedData = HistoryWindowResponse;
export type HistoryRangeRequest = HistoryWindowRequest;
export type HistoryContext = HistoryWindowContext;

export interface HistoryDemand {
  context: HistoryContext;
  visible: Viewport;
  request: HistoryRangeRequest;
  horizon: Viewport;
  reason: HistoryWindowReason;
  forceFresh: boolean;
  direction?: 'back' | 'forward';
}

export interface HistoryLoadValue {
  data: HistoryAcceptedData;
  receivedAt: number;
}

export interface HistoryLoadHandle {
  source: 'cache' | 'network' | 'in-flight';
  request: HistoryRangeRequest;
  result: Promise<HistoryLoadValue>;
}

export class HistoryAbortError extends Error {
  readonly name = 'AbortError' as const;
  constructor(readonly reason: 'superseded' | 'cleared' | 'destroyed') {
    super(`History request aborted: ${reason}`);
  }
}

export interface HistoryLoader {
  foreground(
    demand: HistoryDemand,
    load: (signal: AbortSignal) => Promise<HistoryAcceptedData>,
  ): HistoryLoadHandle;
  prefetch(
    demand: HistoryDemand,
    load: (signal: AbortSignal) => Promise<HistoryAcceptedData>,
  ): Promise<'cached' | 'joined' | 'skipped'>;
  abortPrefetch(): void;
  clear(): void;
  destroy(): void;
  diagnostics(): {
    entries: number;
    points: number;
    foregroundActive: boolean;
    prefetchActive: boolean;
  };
}

export class HistoryAuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'HistoryAuthError';
    this.status = status;
  }
}

export type { HistoryWindowReason, SensorSeries, Viewport };
