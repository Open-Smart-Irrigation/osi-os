import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EDGE_TRIGGER_METRICS,
  normalizeTriggerMetric,
  schedulerTypeFromMetric,
} from '../src/components/farming/ScheduleSection.tsx';

test('schedule controls expose only edge-enforced trigger metrics', () => {
  assert.deepEqual(EDGE_TRIGGER_METRICS, ['SWT_WM1', 'SWT_WM2', 'SWT_AVG', 'DENDRO']);
});

test('normalizes legacy schedule metrics into the edge-enforced set', () => {
  assert.equal(normalizeTriggerMetric('SWT_1'), 'SWT_WM1');
  assert.equal(normalizeTriggerMetric('SWT_2'), 'SWT_WM2');
  assert.equal(normalizeTriggerMetric('SWT_3'), 'SWT_AVG');
  assert.equal(normalizeTriggerMetric('SWT_WM3'), 'SWT_AVG');
  assert.equal(normalizeTriggerMetric('VWC'), 'SWT_WM1');
  assert.equal(normalizeTriggerMetric('DENDRO'), 'DENDRO');
});

test('unsupported non-dendro metrics render through the SWT schedule path', () => {
  assert.equal(schedulerTypeFromMetric('VWC'), 'SWT');
  assert.equal(schedulerTypeFromMetric('SWT_WM3'), 'SWT');
  assert.equal(schedulerTypeFromMetric('DENDRO'), 'DENDRO');
});
