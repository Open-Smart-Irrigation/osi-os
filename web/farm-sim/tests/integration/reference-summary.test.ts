import assert from 'node:assert/strict';
import test from 'node:test';
import {SCENARIOS} from '../../src/core/scenario';
import {round2} from '../../src/core/units';
import timerReferences from '../../src/scenarios/reference-summary.json';
import golden from './reference-golden.json';

test('the report\'s timer reference equals the daily-timer (T3) rows of the closed-loop goldens', () => {
  const expected = Object.fromEntries(SCENARIOS.map(scenario => {
    const policy = scenario.reference.tiers.find(candidate => candidate.tier === 3);
    // An every-day plan runs once a day, so its runs with water are its irrigation days.
    assert.ok(policy?.kind === 'weekly-plan' && policy.weekdays === 127, scenario.id + ' T3 is a daily timer');
    const timer = golden[scenario.id].tiers['3'];
    assert.ok(timer.runLiters.length <= 14, scenario.id + ' T3 runs at most once a day');
    return [scenario.id, {
      liters: round2(timer.runLiters.reduce((sum, liters) => sum + liters, 0)),
      pumpStrokes: timer.pumpStrokes,
      carryTrips: timer.carryTrips,
      harvestedKg: timer.harvestedKg,
      stressDays: timer.stressDays,
      irrigationDays: timer.runLiters.filter(liters => liters > 0).length,
      soilWaterEndMm: timer.soilWaterMm.end,
    }] as const;
  }));
  assert.deepEqual(timerReferences, expected);
});
