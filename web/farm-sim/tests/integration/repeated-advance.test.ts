import assert from 'node:assert/strict';
import test from 'node:test';
import {Simulator} from '@osi-demo/model';
import {PLANS_PATH} from '../../src/core/osi/farm-builder';
import {TICK_MS} from '../../src/core/replay';
import {localDayStart, MINUTE_MS} from '../../src/core/time';
import {atHour, buildAdapter, iso, write} from './osi-fixture';

/**
 * Plan 4.2: after each step, advanceOsi runs drainNow's first pass without its leading `sim.advanceTo(sim.now)`,
 * because that call would repeat the step's own `sim.advanceTo` at the same instant. This pins why that is safe: right
 * after any `sim.advanceTo`, a second call at the instant just reached runs no clock event and leaves the simulator's
 * digest inputs unchanged. The run below steps tick by tick, as the game does, through uplinks, a one-time plan's
 * start and its valve events, local midnight and the 06:00 trigger.
 */
test('a second sim.advanceTo at the instant just reached changes nothing', () => {
  const {adapter, header} = buildAdapter(4);
  const fireAt = adapter.now + 30 * MINUTE_MS;
  write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'ONCE', fire_at: iso(fireAt), duration_minutes: 5});
  const digest = () => JSON.stringify(adapter.simulatorSnapshot());
  const seen = {calls: 0, compared: 0, uplink: 0, planStart: 0, valveRun: 0, midnight: 0, trigger: 0};
  const original = Simulator.prototype.advanceTo;
  Simulator.prototype.advanceTo = function (this: Simulator, target: number) {
    const revision = this.clock.revision;
    const day = localDayStart(this.now);
    const sample = adapter.latestProbeSample();
    const runs = this.outcomes.length;
    const evaluations = this.state.triggerEvaluations.length;
    original.call(this, target);
    seen.calls++;
    const ranEvent = this.clock.revision !== revision;
    const crossedMidnight = localDayStart(this.now) !== day;
    const before = ranEvent || crossedMidnight ? digest() : '';
    const settled = this.clock.revision;
    original.call(this, this.now);
    assert.equal(this.clock.revision, settled, `the repeated call at ${iso(this.now)} ran a clock event`);
    if (!ranEvent && !crossedMidnight) return;
    assert.equal(digest(), before, `the repeated call at ${iso(this.now)} changed the simulator`);
    seen.compared++;
    if (adapter.latestProbeSample() !== sample) seen.uplink++;
    if (ranEvent && this.now === fireAt) seen.planStart++;
    if (this.outcomes.length > runs) seen.valveRun++;
    if (crossedMidnight) seen.midnight++;
    if (this.state.triggerEvaluations.length > evaluations) seen.trigger++;
  };
  try {
    const end = atHour(2, 7);
    const tick = TICK_MS * header.pace;
    while (adapter.now < end) adapter.advance(Math.min(end, adapter.now + tick));
  } finally {
    Simulator.prototype.advanceTo = original;
  }
  // Every kind of stop the reason depends on was reached, so the checks above did not pass on idle instants alone.
  for (const [kind, count] of Object.entries(seen)) assert.ok(count > 0, `no ${kind}: ${JSON.stringify(seen)}`);
});
