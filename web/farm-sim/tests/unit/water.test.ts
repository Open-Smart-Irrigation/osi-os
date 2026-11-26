import assert from 'node:assert/strict';
import test from 'node:test';
import {MINUTE_MS, SECOND_MS} from '../../src/core/time';
import {
  debitTank, drawCanPour, fillContainer, pendingCutoffAt, pourIntoTank, projectedSegmentDelivery,
  pumpWater, refillWell, runningCutoffAt, segmentLiters, WATER, waterState,
} from '../../src/core/water';

test('pumping respects tank headroom, per-action flow and well yield', () => {
  let state = waterState(0, 600);
  assert.equal(state.wellLiters, 480);
  for (let i = 0; i < 24; i++) {
    const result = pumpWater(state);
    assert.equal(result.liters, 20);
    state = result.state;
  }
  assert.equal(state.wellLiters, 0);
  assert.equal(state.tankLiters, 480);
  assert.equal(pumpWater(state).liters, 0);
  assert.equal(refillWell(state).wellLiters, 480);
  const last = pumpWater(waterState(998.75, 2));
  assert.equal(last.state.tankLiters, 1000);
  assert.equal(last.state.wellLiters, .75);
  assert.equal(last.liters, 1.25);
});

test('container fills and pours conserve actual contents', () => {
  const can = fillContainer(waterState(8.25, 0), 'can', 'tank');
  assert.equal(can.liters, 8.25);
  assert.equal(can.state.tankLiters, 0);
  const wet = drawCanPour(can.state);
  assert.equal(wet.liters, 2);
  assert.equal(wet.state.canLiters, 6.25);
  const carry = fillContainer(wet.state, 'jerrycan', 'shared-well');
  const tank = pourIntoTank(carry.state, 'jerrycan');
  assert.equal(tank.liters, 20);
  assert.equal(tank.state.jerrycanLiters, 0);
  assert.deepEqual(debitTank(tank.state, 21), {state: {...tank.state, tankLiters: 0}, liters: 20});
});

test('flow ledgers agree on wet runs, clamp delivery after exhaustion and add across partitions', () => {
  const segment = {startsAt: 1000, endsAt: 1000 + 10 * MINUTE_MS, availableLiters: 80, rateLpm: 8};
  assert.deepEqual(segmentLiters(segment, 0, Infinity), {estimated: 80, delivered: 80});
  const dry = {...segment, endsAt: 3_000, availableLiters: .15};
  assert.deepEqual(segmentLiters(dry, 0, 4_000), {estimated: .27, delivered: .15});
  const first = segmentLiters(dry, 0, 2_000);
  const second = segmentLiters(dry, 2_000, 4_000);
  assert.equal(first.estimated + second.estimated, .27);
  assert.equal(first.delivered + second.delivered, .15);
  assert.equal(segmentLiters(dry, 4_000, 5_000).delivered, 0);
  assert.equal(projectedSegmentDelivery(dry, 1_000, 1_001), 8 / MINUTE_MS);
});

test('pending and running cutoff times include the close delay and clamp to now', () => {
  const now = 1_000_000;
  const ackAt = now + 2 * SECOND_MS;
  const rate = WATER.dripRateLpm;
  assert.equal(pendingCutoffAt(now, ackAt, 0, rate), now);
  assert.equal(pendingCutoffAt(now, ackAt, 8, rate), now + MINUTE_MS);
  assert.equal(runningCutoffAt(now, 8, rate), now + MINUTE_MS - 2 * SECOND_MS);
  assert.equal(runningCutoffAt(now, .15, rate), now);
  assert.equal(runningCutoffAt(now, .3, rate), now + 250);
  assert.throws(() => runningCutoffAt(now, 8, 0), RangeError);
});
