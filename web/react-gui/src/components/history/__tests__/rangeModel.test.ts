import { describe, expect, it } from 'vitest';

import { defaultAggregationForRange } from '../../../history/rangeModel';

describe('history range aggregation defaults', () => {
  it.each([
    ['12h', 'raw'],
    ['24h', 'raw'],
    ['7d', 'hourly'],
    ['30d', 'daily'],
    ['season', 'weekly'],
    ['custom', 'auto'],
  ] as const)('maps %s to %s aggregation', (range, aggregation) => {
    expect(defaultAggregationForRange(range)).toBe(aggregation);
  });
});
