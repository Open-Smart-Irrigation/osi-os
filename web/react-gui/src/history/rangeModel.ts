import type { HistoryAggregationLevel, HistoryRangeLabel } from './types.ts';

export function defaultAggregationForRange(range: HistoryRangeLabel): HistoryAggregationLevel {
  switch (range) {
    case '12h':
    case '24h':
      return 'raw';
    case '7d':
      return 'hourly';
    case '30d':
      return 'daily';
    case 'season':
      return 'weekly';
    case 'custom':
      return 'auto';
  }
}
