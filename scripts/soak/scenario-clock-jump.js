#!/usr/bin/env node
'use strict';
const { emitArtifact } = require('./rig');

const DAY_MS = 24 * 3600 * 1000;

function sameUtcDay(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function runScheduleTick({ nowMs, lastTriggeredMs, forwardJump = false, backwardJump = false, meanKpa, thresholdKpa }) {
  if (forwardJump) {
    return { fired: false, lastTriggeredAtWritten: false, logEvent: 'clock_jump_forward' };
  }
  if (backwardJump && lastTriggeredMs != null && sameUtcDay(nowMs, lastTriggeredMs)) {
    return { fired: false, lastTriggeredAtWritten: false, logEvent: 'clock_jump_backward_suppressed' };
  }
  if (lastTriggeredMs != null && sameUtcDay(nowMs, lastTriggeredMs)) {
    return { fired: false, lastTriggeredAtWritten: false, logEvent: null };
  }
  const fired = Number(meanKpa) >= Number(thresholdKpa);
  return { fired, lastTriggeredAtWritten: fired, logEvent: null };
}

async function run({ artifactDir } = {}) {
  const WINDOW = Date.parse('2026-05-10T06:00:00Z');
  const cases = [
    ['forward_no_backfill', runScheduleTick({ nowMs: WINDOW + 5 * 3600 * 1000, lastTriggeredMs: WINDOW - 2 * DAY_MS, forwardJump: true, meanKpa: 100, thresholdKpa: 50 }).fired === false],
    ['backward_suppressed', runScheduleTick({ nowMs: WINDOW, lastTriggeredMs: WINDOW + 60000, backwardJump: true, meanKpa: 100, thresholdKpa: 50 }).fired === false],
    ['normal_fires', runScheduleTick({ nowMs: WINDOW, lastTriggeredMs: WINDOW - DAY_MS, meanKpa: 100, thresholdKpa: 50 }).fired === true],
  ];
  const outcome = cases.every(([, ok]) => ok) ? 'pass' : 'fail';
  const result = {
    inputs: { windowIso: new Date(WINDOW).toISOString() },
    invariants: Object.fromEntries(cases),
    outcome,
    timingsMs: 0,
    notes: '5.6 regression net; re-point at real node 5f0d2b7e9b9b1b3a once 5.6 lands its guard.',
  };
  if (artifactDir) result.artifactPath = emitArtifact(artifactDir, 'clock-jump', result);
  return result;
}

module.exports = { runScheduleTick, sameUtcDay, run };

if (require.main === module) {
  run({ artifactDir: require('node:path').join(__dirname, 'artifacts') })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.outcome === 'pass' ? 0 : 1); })
    .catch((e) => { console.error(`[clock-jump] ERROR: ${e.message}`); process.exit(2); });
}
