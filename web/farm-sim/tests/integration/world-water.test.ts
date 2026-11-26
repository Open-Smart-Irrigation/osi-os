import assert from 'node:assert/strict';
import test from 'node:test';
import {defaultHeader, TUTORIAL_SCENARIO} from '../../src/core/scenario';
import {MINUTE_MS, nextLocalMidnight} from '../../src/core/time';
import {projectedSegmentDelivery, segmentLiters} from '../../src/core/water';
import type {FlowSegment} from '../../src/core/water';
import {World} from '../../src/core/world';

test('a pump settles the valve before refilling and delivery is split at local midnight', () => {
  const scenario = {...TUTORIAL_SCENARIO, initial: {...TUTORIAL_SCENARIO.initial, tankLiters: 600}};
  const world = new World(defaultHeader('integration', scenario, 3), scenario);
  const midnight = nextLocalMidnight(scenario.start);
  const open = midnight - 5 * MINUTE_MS;
  const close = midnight + 5 * MINUTE_MS;
  const pumpAt = open + 2 * MINUTE_MS;
  const completion = pumpAt + MINUTE_MS;
  const closed: FlowSegment[] = [];
  let active: FlowSegment = {startsAt: open, endsAt: close, rateLpm: 8, availableLiters: 600};
  world.attachValveTap({
    litersBetween: (_zone, from, to) => [...closed, active].reduce((total, segment) => {
      const delivery = segmentLiters(segment, from, to);
      return {estimated: total.estimated + delivery.estimated, delivered: total.delivered + delivery.delivered};
    }, {estimated: 0, delivered: 0}),
    projectedDelivery: (_zone, from, to) => [...closed, active]
      .reduce((total, segment) => total + projectedSegmentDelivery(segment, from, to), 0),
    nextInputChangeAfter: (from, through) => [open, close].find(at => at > from && at <= through) ?? null,
    settleTo: at => {
      assert.equal(world.settledTankLiters(), 600);
      assert.equal(at, completion);
      assert.equal(world.debitValve(at, segmentLiters(active, open, at).delivered), 24);
      closed.push({...active, endsAt: at});
    },
    tankChanged: (at, tankLiters) => {
      assert.equal(at, completion);
      active = {...active, startsAt: at, availableLiters: tankLiters};
    },
  });
  world.stepTo(pumpAt);
  assert.equal(world.pump(pumpAt), completion);
  world.stepTo(completion);
  world.applyDueTankEvents(completion);
  assert.equal(world.settledTankLiters(), 596);
  world.stepTo(close);
  const view = world.viewModel(close);
  assert.equal(view.daily[0].irrigationLiters.valve, 40);
  assert.equal(view.today.irrigationLiters.valve, 40);
  assert.equal(view.water.tankLiters, 540);
  assert.equal(view.daily[0].waterMinutes, 1);
});
