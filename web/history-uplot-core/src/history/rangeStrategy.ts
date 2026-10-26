import type { HistoryRangeRequest } from './types';
import type { Viewport } from '../shared/types';
import { DAY_MS } from '../shared/types';
import {
  bufferedRequest as cardBufferedRequest,
  neighborRequest as cardNeighborRequest,
  requestForViewport as cardRequestForViewport,
} from './range';

export interface HistoryRangeStrategy {
  requestForViewport(viewport: Viewport): HistoryRangeRequest;
  bufferedRequest(viewport: Viewport, horizon: Viewport): HistoryRangeRequest;
  neighborRequest(viewport: Viewport, direction: 'back' | 'forward', horizon: Viewport): HistoryRangeRequest | null;
}

export const cardHistoryRangeStrategy: HistoryRangeStrategy = {
  requestForViewport: cardRequestForViewport,
  bufferedRequest: cardBufferedRequest,
  neighborRequest: cardNeighborRequest,
};

export const analysisHourlyRangeStrategy: HistoryRangeStrategy = {
  requestForViewport(viewport) {
    const span = viewport.to - viewport.from;
    if (!Number.isFinite(span) || span <= 0 || span > 7 * DAY_MS) throw new Error('Viewport exceeds analysis horizon');
    return {
      from: viewport.from,
      to: viewport.to,
      rangeLabel: span <= DAY_MS ? '24h' : '7d',
      aggregation: 'hourly',
    };
  },
  bufferedRequest(viewport) {
    return this.requestForViewport(viewport);
  },
  neighborRequest(viewport, direction, horizon) {
    const span = viewport.to - viewport.from;
    if (!Number.isFinite(span) || span <= 0 || horizon.to <= horizon.from) return null;
    const delta = span * 0.8 * (direction === 'back' ? -1 : 1);
    const candidate = { from: viewport.from + delta, to: viewport.to + delta };
    const shifted = candidate.from >= horizon.from && candidate.to <= horizon.to
      ? candidate
      : candidate.from < horizon.from
        ? { from: horizon.from, to: horizon.from + span }
        : { from: horizon.to - span, to: horizon.to };
    if (shifted.from < horizon.from || shifted.to > horizon.to || (shifted.from === viewport.from && shifted.to === viewport.to)) return null;
    return this.requestForViewport(shifted);
  },
};
