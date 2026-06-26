import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EDGE_TRIGGER_METRICS,
  normalizeTriggerMetric,
  schedulerTypeFromMetric,
} from '../src/components/farming/ScheduleSection.tsx';

test('schedule controls expose only edge-enforced trigger metrics', () => {
  assert.deepEqual(EDGE_TRIGGER_METRICS, ['SWT_1', 'SWT_2', 'SWT_3', 'SWT_AVG', 'DENDRO']);
});

test('normalizes legacy schedule metrics into the canonical set', () => {
  assert.equal(normalizeTriggerMetric('SWT_WM1'), 'SWT_1');
  assert.equal(normalizeTriggerMetric('SWT_WM2'), 'SWT_2');
  assert.equal(normalizeTriggerMetric('SWT_WM3'), 'SWT_3');
  assert.equal(normalizeTriggerMetric('SWT_1'), 'SWT_1');
  assert.equal(normalizeTriggerMetric('SWT_2'), 'SWT_2');
  assert.equal(normalizeTriggerMetric('SWT_3'), 'SWT_3');
  assert.equal(normalizeTriggerMetric('VWC'), 'VWC');
  assert.equal(normalizeTriggerMetric('DENDRO'), 'DENDRO');
});

test('schedulerTypeFromMetric maps VWC to its own type', () => {
  assert.equal(schedulerTypeFromMetric('VWC'), 'VWC');
  assert.equal(schedulerTypeFromMetric('SWT_WM3'), 'SWT');
  assert.equal(schedulerTypeFromMetric('DENDRO'), 'DENDRO');
});
