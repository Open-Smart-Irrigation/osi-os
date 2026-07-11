'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const da = require('./index.js');

test('basic numeric helpers preserve current Daily Dendro behavior', () => {
  assert.equal(da.round(12.345, 2), 12.35);
  assert.equal(da.round(Number.POSITIVE_INFINITY, 1), null);
  assert.equal(da.avg([1, null, 5, Number.NaN]), 3);
  assert.equal(da.percentile([5, 1, 3, 9], 0.5), 5);
  assert.deepEqual(da.median3([1, 100, 3, 4]), [100, 3, 4, 4]);
});

test('date and timezone helpers preserve current window calculations', () => {
  assert.equal(da.localHour('2026-07-10T05:30:00.000Z', 'UTC'), 5);
  assert.equal(da.localTimeStr('2026-07-10T05:30:00.000Z', 'UTC'), '05:30');
  assert.deepEqual(da.localDateParts('2026-07-10T23:30:00.000Z', 'Europe/Zurich'), {
    year: 2026,
    month: 7,
    day: 11,
  });
  assert.equal(da.shiftDateIso('2026-07-01', -1), '2026-06-30');
  assert.equal(da.tzOffsetMinutes('2026-07-10T00:00:00.000Z', 'Europe/Zurich'), 120);
  assert.equal(da.localMidnightUtcIso('2026-07-10', 'Europe/Zurich'), '2026-07-09T22:00:00.000Z');
  assert.deepEqual(da.computeZoneDayWindow('2026-07-11T12:00:00.000Z', 'UTC'), {
    date: '2026-07-10',
    windowStartInclusive: '2026-07-10T00:00:00.000Z',
    windowEndExclusive: '2026-07-11T00:00:00.000Z',
  });
  assert.equal(da.calibrationForKey('apple').thresholds.severe, 130);
});

test('daily stem-series helpers preserve current filtering and extremes behavior', () => {
  const jumpRows = [
    { p: 0, t: '2026-07-10T05:00:00.000Z' },
    { p: 250, t: '2026-07-10T06:00:00.000Z' },
    { p: 260, t: '2026-07-10T14:00:00.000Z' },
  ];
  assert.equal(da.detectJumps(jumpRows), true);
  assert.deepEqual(da.removeJumps(jumpRows), [
    { p: 0, t: '2026-07-10T05:00:00.000Z' },
    { p: 0, t: '2026-07-10T06:00:00.000Z' },
    { p: 10, t: '2026-07-10T14:00:00.000Z' },
  ]);

  const rows = [
    { p: 108, t: '2026-07-10T05:30:00.000Z' },
    { p: 112, t: '2026-07-10T06:15:00.000Z' },
    { p: 92, t: '2026-07-10T13:30:00.000Z' },
    { p: 95, t: '2026-07-10T15:30:00.000Z' },
  ];
  assert.deepEqual(da.extractExtremes(rows, 'UTC'), {
    dMax: 112,
    dMin: 92,
    dMaxTime: '06:15',
    dMinTime: '13:30',
    predawnSamples: 2,
    afternoonSamples: 2,
  });
});

test('agronomy and QA helpers preserve current computed values', () => {
  assert.equal(da.computeVPD(30, 50), 2.122);
  assert.deepEqual(da.buildQaFlags(80, 2, 2, false, 40), {
    enoughSamplesDay: true,
    enoughSamplesPredawn: true,
    enoughSamplesAfternoon: true,
    usedFullDayFallback: false,
    suspectedStepArtifact: false,
    lowSignalDay: false,
    lowConfidenceDay: false,
    confidenceScore: 1,
  });
  assert.deepEqual(da.buildQaFlags(4, 0, 0, true, 5), {
    enoughSamplesDay: false,
    enoughSamplesPredawn: false,
    enoughSamplesAfternoon: false,
    usedFullDayFallback: true,
    suspectedStepArtifact: true,
    lowSignalDay: true,
    lowConfidenceDay: true,
    confidenceScore: 0,
  });
});

test('envelope, TWD, and per-tree state helpers preserve current behavior', () => {
  const sequence = [
    { date: '2026-07-07', dMax: 100, dMin: 70 },
    { date: '2026-07-08', dMax: 110, dMin: 80 },
    { date: '2026-07-09', dMax: 105, dMin: 60 },
  ];
  assert.deepEqual(da.computeEnvelope(sequence, 'stepwise'), [
    { envelopeRef: 100, twdNight: 0, twdDay: 30, mds: 30 },
    { envelopeRef: 110, twdNight: 0, twdDay: 30, mds: 30 },
    { envelopeRef: 110, twdNight: 5, twdDay: 50, mds: 45 },
  ]);
  assert.deepEqual(da.computeEnvelope(sequence, 'linear'), [
    { envelopeRef: 100, twdNight: 0, twdDay: 30, mds: 30 },
    { envelopeRef: 110, twdNight: 0, twdDay: 30, mds: 30 },
    { envelopeRef: 110, twdNight: 5, twdDay: 50, mds: 45 },
  ]);
  assert.equal(da.classifyAbsoluteTwd(95, 1, da.CALIBRATIONS.apple), 'significant');
  assert.equal(da.carryForwardState({ tree_state_v5: 'moderate', stress_level: 'mild' }), 'moderate');
  assert.equal(da.carryForwardState(null), 'unknown');
  assert.equal(da.computeAbsoluteDeltaTwdSmoothed(70, 50, [10, 20]), 16.7);
  assert.equal(da.computeRDelta5day(20, 50, [{ dr_um: 10, mds_um: 40 }, { dr_um: 30, mds_um: 60 }]), -30);
  assert.equal(da.adjustStress('moderate', 1), 'significant');
  assert.equal(da.computeR2([1, 2, 3, 4], [2, 4, 6, 8]), 1);
});

test('zone stress aggregation preserves current quorum, confidence, and outlier behavior', () => {
  const trees = [
    { twd_day_um: 35, tree_state_v5: 'mild', confidence_score: 1, low_confidence_day: 0 },
    { twd_day_um: 80, tree_state_v5: 'significant', confidence_score: 0.9, low_confidence_day: 0 },
    { twd_day_um: 90, tree_state_v5: 'severe', confidence_score: 0.8, low_confidence_day: 0 },
    { twd_day_um: 20, tree_state_v5: 'none', confidence_score: 0.1, low_confidence_day: 1 },
  ];
  const result = da.aggregateZoneStress(trees);
  assert.equal(result.zoneStress, 'severe');
  assert.equal(result.usableTreeCount, 3);
  assert.equal(result.lowConfidenceTreeCount, 1);
  assert.equal(result.zoneConfidenceScore, 0.7);
});

test('irrigation decision helpers preserve schedule gating and rain suppression behavior', () => {
  assert.equal(da.dendroThresholdStressLevel(3), 'significant');
  assert.equal(da.decisionEscalationStress('increase_10', ['significant']), 'significant');
  assert.deepEqual(
    da.irrDecision(['mild'], { daily_mm: 0, rolling7d: 0 }, {}, [], { computedAt: '2026-07-11T10:00:00.000Z' }),
    { action: 'decrease_10', reasoning: 'No stress ≥2 of 3 days' },
  );
  assert.deepEqual(
    da.applyDendroSchedulePolicy(
      { action: 'increase_10', reasoning: 'Moderate stress' },
      ['moderate'],
      { enabled: 1, trigger_metric: 'DENDRO', threshold_kpa: 3 },
    ),
    {
      action: 'maintain',
      reasoning: 'Moderate stress Blocked by DENDRO threshold: requires significant stress or higher.',
    },
  );

  const computedAt = '2026-07-11T10:00:00.000Z';
  const rainyState = {};
  assert.deepEqual(
    da.irrDecision(
      ['none', 'none', 'none'],
      { daily_mm: 8, rolling7d: 8 },
      rainyState,
      [{ twd_night_um: 100 }, { twd_night_um: 80 }],
      { computedAt, nowMs: Date.parse(computedAt) },
    ),
    { action: 'maintain_rain_suppression', reasoning: 'New rain: 8mm' },
  );
  assert.equal(rainyState.rain_suppression_start, computedAt);
  assert.equal(rainyState.rain_suppression_timeout_h, 48);
  assert.equal(rainyState.pre_rain_twd_norm_avg, 90);

  const logs = [];
  const suppressState = {
    rain_suppression_active: 1,
    rain_suppression_start: '2026-07-10T10:00:00.000Z',
    rain_suppression_timeout_h: 48,
    pre_rain_twd_norm_avg: 100,
  };
  assert.deepEqual(
    da.irrDecision(
      ['none', 'none', 'none'],
      { daily_mm: 0, rolling7d: 0 },
      suppressState,
      [{ twd_night_um: 70 }, { twd_night_um: 72 }],
      { computedAt, nowMs: Date.parse(computedAt), log: (message) => logs.push(message) },
    ),
    { action: 'decrease_10', reasoning: 'No stress ≥2 of 3 days' },
  );
  assert.equal(suppressState.rain_suppression_active, 0);
  assert.deepEqual(logs, ['Zone: rain suppression exited — TWD responded']);
});
