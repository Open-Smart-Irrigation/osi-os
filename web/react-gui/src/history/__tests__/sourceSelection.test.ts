import { describe, expect, it } from 'vitest';
import { coarserRecoveryAggregation, historyRecoveryCapabilities } from '../sourceSelection';

describe('coarserRecoveryAggregation', () => {
  it('steps an explicit level one rung coarser', () => {
    expect(coarserRecoveryAggregation('raw', 'raw')).toBe('15m');
    expect(coarserRecoveryAggregation('15m', '15m')).toBe('hourly');
    expect(coarserRecoveryAggregation('hourly', 'hourly')).toBe('daily');
  });

  it('steps from the level the server resolved when the viewport asked for auto', () => {
    // A pinch or pan stores a custom viewport with aggregation 'auto'; the
    // point-budget response still names the level it resolved.
    expect(coarserRecoveryAggregation('auto', 'raw')).toBe('15m');
    expect(coarserRecoveryAggregation('auto', '15m')).toBe('hourly');
    expect(coarserRecoveryAggregation('auto', 'hourly')).toBe('daily');
  });

  it('prefers an explicit request over the resolved level', () => {
    expect(coarserRecoveryAggregation('hourly', 'raw')).toBe('daily');
  });

  it('offers nothing when no coarser rung exists or the level is unknown', () => {
    expect(coarserRecoveryAggregation('daily', 'daily')).toBeNull();
    expect(coarserRecoveryAggregation('weekly', 'weekly')).toBeNull();
    expect(coarserRecoveryAggregation('auto', 'daily')).toBeNull();
    expect(coarserRecoveryAggregation('auto', undefined)).toBeNull();
    expect(coarserRecoveryAggregation('auto', 'auto')).toBeNull();
  });

  it('pairs with point-budget recovery', () => {
    const recovery = historyRecoveryCapabilities(['point_budget_exceeded', 'select_fewer_sources_or_coarser_aggregation']);
    expect(recovery.canCoarsenAggregation).toBe(true);
    expect(coarserRecoveryAggregation('auto', 'raw')).toBe('15m');
  });
});
