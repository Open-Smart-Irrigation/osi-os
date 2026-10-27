'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateCondition } = require('./evaluate');

const due = '2026-10-16T06:00:00Z';
const source = { device_eui: '0016C001F1000002', channel: 'vwc_1' };
const swtSource = { device_eui: '0016C001F1000003', channel: 'swt_1' };
const c = { kind: 'VWC', threshold_percent: 22, sources: [source] };
const evidence = (value) => ({ sources: [{ ...source, eligible: true,
  samples: [{ at: '2026-10-16T05:55:00Z', value }] }] });

test('VWC compares with <= and keeps an exact zero as MET', () => {
  assert.equal(evaluateCondition(c, evidence(0), due, 60).status, 'MET');
  assert.equal(evaluateCondition(c, evidence(22), due, 60).status, 'MET');
  assert.equal(evaluateCondition(c, evidence(23), due, 60).status, 'NOT_MET');
});

test('missing, typed-invalid, and out-of-range evidence is UNKNOWN', () => {
  for (const value of [null, '22', Number.NaN, Number.POSITIVE_INFINITY, -1, 101]) {
    assert.equal(evaluateCondition(c, evidence(value), due, 60).status, 'UNKNOWN', String(value));
  }
  assert.equal(evaluateCondition(c, { sources: [] }, due, 60).status, 'UNKNOWN');
  assert.equal(evaluateCondition({ ...c, sources: [{ ...source, channel: 'vwc_11' }] }, evidence(0), due, 60).status, 'UNKNOWN');
});

test('SWT compares with >= and includes both observation bounds', () => {
  const condition = { kind: 'SWT', threshold_kpa: 30, sources: [swtSource] };
  const got = (value, at) => evaluateCondition(condition, {
    sources: [{ ...swtSource, eligible: true, samples: [{ id: 1, at, value }] }],
  }, due, 60);
  assert.equal(got(30, '2026-10-16T05:00:00Z').status, 'MET');
  assert.equal(got(30, due).status, 'MET');
  assert.equal(got(29.99, due).status, 'NOT_MET');
});

test('SQLite timestamps include both exact bounds and reject malformed calendar dates', () => {
  const condition = { kind: 'SWT', threshold_kpa: 30, sources: [swtSource] };
  const samples = (at, value, id = 1) => ({ sources: [{ ...swtSource, eligible: true, samples: [{ id, at, value }] }] });
  assert.equal(evaluateCondition(condition, samples('2026-10-16 05:00:00', 30), due, 60).status, 'MET');
  assert.equal(evaluateCondition(condition, samples('2026-10-16 06:00:00', 30), due, 60).status, 'MET');
  assert.equal(evaluateCondition(condition, samples('2026-02-31 05:30:00', 30), due, 1440).status, 'UNKNOWN');
});

test('selected source means are averaged equally and later samples cannot decide', () => {
  const condition = { kind: 'VWC', threshold_percent: 23, sources: [source, { ...source, device_eui: '0016C001F1000004' }] };
  const result = evaluateCondition(condition, { sources: [
    { ...source, eligible: true, samples: [
      { id: 1, at: '2026-10-16T05:00:00Z', value: 10 },
      { id: 2, at: '2026-10-16T05:00:00Z', value: 30 },
      { id: 3, at: '2026-10-16T05:30:00Z', value: 20 },
      { id: 4, at: '2026-10-16T06:01:00Z', value: 0 },
    ] },
    { device_eui: '0016C001F1000004', channel: 'vwc_1', eligible: true,
      samples: [{ id: 5, at: '2026-10-16T05:00:00Z', value: 20 }] },
  ] }, due, 60);
  assert.equal(result.status, 'MET');
  assert.equal(result.value, 22.5);
  assert.equal(result.unit, '%');
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].samples.length, 2);
});

test('a higher-ID invalid correction wins duplicate timestamp selection and missing sources stay UNKNOWN', () => {
  const condition = { kind: 'VWC', threshold_percent: 22, sources: [source, { ...source, device_eui: '0016C001F1000004' }] };
  const result = evaluateCondition(condition, { sources: [
    { ...source, eligible: true, samples: [
      { id: 10, at: '2026-10-16 05:55:00', value: 0 },
      { id: 11, at: '2026-10-16 05:55:00', value: 'bad' },
    ] },
  ] }, due, 60);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.reason, 'missing_evidence');
  assert.equal(evaluateCondition({ ...condition, sources: [source, { ...source, device_eui: '0016C001F1000004' }] }, {
    sources: [{ ...source, eligible: true, samples: [{ id: 1, at: due, value: 0 }] }],
  }, due, 60).status, 'UNKNOWN');
});

test('DENDRO requires fresh usable local analysis and honors holds', () => {
  const condition = { kind: 'DENDRO', minimum_stress: 'moderate', response_mode: 'fixed' };
  const analysis = (overrides = {}) => ({ stress: 'significant', usable_tree_count: 2,
    action: 'maintain', computed_at: '2026-10-15T12:00:00Z', ...overrides });
  assert.equal(evaluateCondition(condition, { analysis: analysis() }, due, 60).status, 'MET');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ action: 'maintain_rain_suppression' }) }, due, 60).status, 'NOT_MET');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ action: 'maintain_recovery_hold' }) }, due, 60).status, 'NOT_MET');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ action: 'maintain', stress: 'mild' }) }, due, 60).status, 'NOT_MET');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ stress: 'mild' }) }, due, 60).status, 'NOT_MET');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ usable_tree_count: 0 }) }, due, 60).status, 'UNKNOWN');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ usable_tree_count: '2' }) }, due, 60).status, 'UNKNOWN');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ usable_tree_count: true }) }, due, 60).status, 'UNKNOWN');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ action: 'unrecognized' }) }, due, 60).status, 'UNKNOWN');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ computed_at: '2026-10-14T18:00:00Z' }) }, due, 60).status, 'MET');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ computed_at: '2026-10-13T17:59:59Z' }) }, due, 60).status, 'UNKNOWN');
  assert.equal(evaluateCondition(condition, { analysis: analysis({ computed_at: '2026-10-16T06:01:00Z' }) }, due, 60).status, 'UNKNOWN');
});
