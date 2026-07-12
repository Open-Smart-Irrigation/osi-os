'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScheduleTick } = require('./scenario-clock-jump');

const WINDOW_START = Date.parse('2026-05-10T06:00:00Z'); // the daily 06:00 window
const DAY = 24 * 3600 * 1000;

test('forward jump across the window does NOT auto-fire a missed window', () => {
  // Clock leaps from yesterday to well past today's 06:00; last fire was 2 days ago.
  const r = runScheduleTick({
    nowMs: WINDOW_START + 5 * 3600 * 1000, // 11:00, past the 06:00 tick
    lastTriggeredMs: WINDOW_START - 2 * DAY,
    forwardJump: true,
    meanKpa: 100, thresholdKpa: 50, // soil dry enough that a naive backfill WOULD fire
  });
  assert.equal(r.fired, false, 'a forward jump must never backfill a missed window');
  assert.equal(r.logEvent, 'clock_jump_forward');
});

test('backward jump with same-window last_triggered_at is suppressed (no double-fire)', () => {
  const r = runScheduleTick({
    nowMs: WINDOW_START, // clock rewound back onto 06:00
    lastTriggeredMs: WINDOW_START + 60 * 1000, // already fired today (1 min after the window)
    backwardJump: true,
    meanKpa: 100, thresholdKpa: 50,
  });
  assert.equal(r.fired, false, 'the same-day last_triggered_at guard must suppress the re-fire');
  assert.equal(r.logEvent, 'clock_jump_backward_suppressed');
});

test('normal tick (no jump, last fire yesterday, soil dry) fires as before', () => {
  const r = runScheduleTick({
    nowMs: WINDOW_START,
    lastTriggeredMs: WINDOW_START - DAY,
    meanKpa: 100, thresholdKpa: 50,
  });
  assert.equal(r.fired, true, 'the guard must not break normal daily operation');
  assert.equal(r.logEvent, null);
});

test('normal tick but soil wet (below threshold) does not fire', () => {
  const r = runScheduleTick({
    nowMs: WINDOW_START,
    lastTriggeredMs: WINDOW_START - DAY,
    meanKpa: 20, thresholdKpa: 50,
  });
  assert.equal(r.fired, false);
});
