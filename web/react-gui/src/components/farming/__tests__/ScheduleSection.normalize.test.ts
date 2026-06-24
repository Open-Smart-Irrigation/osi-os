import { describe, expect, it } from 'vitest';
import { normalizeTriggerMetric } from '../ScheduleSection';

describe('normalizeTriggerMetric (canonical preservation)', () => {
  it('canonicalises legacy SWT aliases', () => {
    expect(normalizeTriggerMetric('SWT_WM1')).toBe('SWT_1');
    expect(normalizeTriggerMetric('SWT_WM2')).toBe('SWT_2');
    expect(normalizeTriggerMetric('SWT_WM3')).toBe('SWT_3');
  });
  it('preserves canonical and passthrough metrics', () => {
    expect(normalizeTriggerMetric('SWT_1')).toBe('SWT_1');
    expect(normalizeTriggerMetric('SWT_3')).toBe('SWT_3');
    expect(normalizeTriggerMetric('SWT_AVG')).toBe('SWT_AVG');
    expect(normalizeTriggerMetric('DENDRO')).toBe('DENDRO');
    expect(normalizeTriggerMetric('VWC')).toBe('VWC');
  });
});
