import assert from 'node:assert/strict';
import test from 'node:test';
import {START_TILE} from '../../src/core/map';
import {VALVE_PATH} from '../../src/core/osi/farm-builder';
import {createRun} from '../../src/core/replay';
import {runFigures} from '../../src/core/report';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {DAY_MS} from '../../src/core/time';
import {advanceUntil, evening, house, queueWalk, start} from './run-replay-session';

test('a T4 report keeps the hinted manual valve run, so the soil trigger is not credited with every valve day', () => {
  const run = createRun({...defaultHeader('test', TUTORIAL_SCENARIO, 4), pace: 300});
  // The day-1 hint at T3 and T4: open the valve for 10 minutes from the phone.
  run.apply({kind: 'phoneOpen'});
  assert.equal(run.request('POST', VALVE_PATH, {action: 'OPEN_FOR_DURATION', duration_seconds: 600}).status, 200);
  run.apply({kind: 'phoneClose'});
  queueWalk(run, START_TILE, house);
  for (let day = 0; day < 14; day++) {
    advanceUntil(run, evening + day * DAY_MS);
    run.apply({kind: 'sleep'});
    run.step(0);
  }
  advanceUntil(run, start + 14 * DAY_MS);
  const report = run.feedback().report;
  assert.ok(report);
  const manual = report.valveRuns.filter(valveRun => valveRun.trigger === 'manual');
  assert.equal(manual.length, 1);
  assert.ok(manual[0].openedAt > start && manual[0].openedAt < start + DAY_MS);
  assert.ok(report.valveRuns.some(valveRun => valveRun.trigger === 'trigger_based'));
  assert.equal(runFigures(report)?.triggerOnly, false);
});
