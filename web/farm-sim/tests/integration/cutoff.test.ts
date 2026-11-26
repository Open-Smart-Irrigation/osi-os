import assert from 'node:assert/strict';
import test from 'node:test';
import {LABOUR} from '../../src/core/labour';
import {PLANS_PATH} from '../../src/core/osi/farm-builder';
import {MINUTE_MS, SECOND_MS} from '../../src/core/time';
import type {IrrigationEvent, Tier} from '../../src/core/types';
import {atHour, buildAdapter, environment, fixtureWeather, iso, meter, openFor, START, write} from './osi-fixture';

const OPEN = atHour(1, 7);
const ACK = OPEN + 2 * SECOND_MS;
const NATURAL_CLOSE = ACK + 10 * MINUTE_MS;
type Adapter = ReturnType<typeof buildAdapter>['adapter'];
const farm = (tank: number, tier: Tier = 3) => buildAdapter(tier, {tank, weather: fixtureWeather()}).adapter;

function result(adapter: Adapter) {
  const outcomes = adapter.simulatorSnapshot().outcomes;
  assert.equal(outcomes.length, 1);
  const [row] = outcomes;
  const from = row.observedOpenAt ? Date.parse(row.observedOpenAt) : adapter.now;
  const to = row.observedCloseAt ? Date.parse(row.observedCloseAt) : adapter.now;
  const liters = adapter.litersBetween(1, from, to);
  assert.equal(liters.estimated, row.estimatedGrossLiters ?? 0);
  const events = adapter.drain();
  const cutoff = events.find((event): event is Extract<IrrigationEvent, {kind: 'cutoff'}> => event.kind === 'cutoff');
  if (cutoff) {
    assert.deepEqual(cutoff.liters, liters);
    assert.equal(cutoff.status, row.status);
    assert.equal(cutoff.closedAt, to);
  }
  return {row, liters, cutoff, events};
}

function weekly(adapter: Adapter, minutes: number) {
  write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'WEEKLY', weekdays_mask: 127,
    start_time: '07:00', duration_minutes: minutes});
}

test('empty tank at 06:00 closes before the trigger acknowledgment', () => {
  const adapter = farm(0, 4);
  const trigger = atHour(2, 6);
  adapter.advance(trigger + 3 * SECOND_MS);
  const {row, liters, cutoff, events} = result(adapter);
  assert.equal(row.trigger, 'trigger_based');
  assert.equal(row.observedOpenAt, null);
  assert.equal(row.observedCloseAt, iso(trigger + 2 * SECOND_MS));
  assert.equal(row.status, 'CANCELLED');
  assert.deepEqual(liters, {estimated: 0, delivered: 0});
  assert.equal(cutoff?.at, trigger);
  assert.deepEqual(events.map(event => event.kind), ['commanded', 'closed', 'cutoff']);
});

test('a one-time plan sends the 0.15 L cutoff before acknowledgment', () => {
  const adapter = farm(.15);
  write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'ONCE', fire_at: iso(OPEN), duration_minutes: 10});
  adapter.advance(NATURAL_CLOSE);
  const {row, liters, cutoff} = result(adapter);
  assert.equal(row.observedOpenAt, iso(ACK));
  assert.equal(row.status, 'CANCELLED');
  assert.deepEqual(liters, {estimated: .15, delivered: .15});
  assert.equal(cutoff?.at, OPEN + 1_125);
});

test('weekly immediate start clamps the shortfall to two seconds of flow', () => {
  const adapter = farm(.15);
  weekly(adapter, 10);
  adapter.advance(NATURAL_CLOSE);
  const {row, liters, cutoff} = result(adapter);
  assert.equal(row.observedOpenAt, iso(OPEN));
  assert.equal(row.status, 'CANCELLED');
  assert.deepEqual(liters, {estimated: .27, delivered: .15});
  assert.equal(cutoff?.at, OPEN);
});

test('a can fill during the run leaves less than two seconds of flow', () => {
  const adapter = farm(18.15);
  openFor(adapter, OPEN, 10);
  adapter.advance(ACK + MINUTE_MS);
  assert.equal(adapter.world.fill(adapter.now, 'can'), 10);
  assert.equal(adapter.world.settledTankLiters(), .15);
  adapter.drainNow();
  adapter.advance(NATURAL_CLOSE);
  const {row, liters, cutoff} = result(adapter);
  assert.equal(row.status, 'CANCELLED');
  assert.deepEqual(liters, {estimated: 8.27, delivered: 8.15});
  assert.ok(liters.estimated - liters.delivered <= .27);
  assert.deepEqual(adapter.viewModel().today.cutoffs, [{at: cutoff?.at, liters}]);
});

test('a can fill two minutes before natural close brings forward the cutoff', () => {
  const adapter = farm(79);
  openFor(adapter, OPEN, 10);
  adapter.advance(NATURAL_CLOSE - 2 * MINUTE_MS);
  assert.equal(adapter.world.settledTankLiters(), 15);
  assert.equal(adapter.world.fill(adapter.now, 'can'), 10);
  adapter.drainNow();
  adapter.advance(NATURAL_CLOSE);
  const {row, liters, cutoff} = result(adapter);
  assert.equal(row.status, 'CANCELLED');
  assert.equal(cutoff?.at, NATURAL_CLOSE - 2 * MINUTE_MS + 35_500);
  assert.deepEqual(liters, {estimated: 69, delivered: 69});
});

for (const delay of [0, 1]) {
  test('pump completion at cutoff send time + ' + delay + ' ms', () => {
    const adapter = farm(79);
    const send = OPEN + 592_500;
    openFor(adapter, OPEN, 10);
    adapter.advance(send + delay - LABOUR.pumpMs);
    assert.equal(adapter.world.pump(adapter.now), send + delay);
    adapter.drainNow();
    adapter.advance(send);
    assert.equal(adapter.viewModel().valve, delay ? 'closing' : 'open');
    adapter.advance(NATURAL_CLOSE);
    const {row, liters, cutoff} = result(adapter);
    assert.equal(row.status, delay ? 'CANCELLED' : 'COMPLETED');
    assert.equal(cutoff?.at, delay ? send : undefined);
    assert.deepEqual(liters, delay ? {estimated: 79, delivered: 79} : {estimated: 80, delivered: 80});
  });
}

for (const kind of ['timed open', 'weekly plan']) {
  test('natural close wins an exact cutoff tie for a ' + kind, () => {
    const adapter = farm(80);
    const close = kind === 'weekly plan' ? NATURAL_CLOSE - 2 * SECOND_MS : NATURAL_CLOSE;
    if (kind === 'weekly plan') weekly(adapter, 10);
    else openFor(adapter, OPEN, 10);
    adapter.advance(close);
    const {row, liters, cutoff} = result(adapter);
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.observedCloseAt, iso(close));
    assert.equal(cutoff?.at, close - 2 * SECOND_MS);
    assert.equal(cutoff?.winner, 'natural');
    assert.deepEqual(liters, {estimated: 80, delivered: 80});
  });
}

test('ordinary valve run drives the view without changing it on read', () => {
  const adapter = farm(600);
  const view = () => adapter.viewModel();
  assert.equal(view().valve, 'closed');
  openFor(adapter, OPEN, 10);
  assert.equal(view().valve, 'pending');
  assert.ok(view().dripLine.every(tile => !tile.wet));
  adapter.advance(ACK);
  assert.equal(view().valve, 'open');
  assert.ok(view().dripLine.every(tile => tile.wet));
  assert.deepEqual(adapter.litersBetween(1, ACK, ACK + 30 * SECOND_MS), {estimated: 4, delivered: 4});
  assert.deepEqual(view(), view());
  adapter.advance(NATURAL_CLOSE);
  const {row, cutoff, liters, events} = result(adapter);
  assert.equal(row.status, 'COMPLETED');
  assert.equal(cutoff, undefined);
  assert.deepEqual(liters, {estimated: 80, delivered: 80});
  assert.deepEqual(events.map(event => [event.kind, event.at]), [['commanded', OPEN], ['opened', ACK], ['closed', NATURAL_CLOSE]]);
  assert.deepEqual(adapter.drain(), []);
  assert.equal(view().valve, 'closed');
});

test('midnight credits the uplink to the new meter day and splits physical delivery', () => {
  const adapter = farm(600);
  const midnight = atHour(3, 0);
  openFor(adapter, midnight - 5 * MINUTE_MS - 2 * SECOND_MS, 10);
  adapter.advance(midnight);
  assert.equal(meter(adapter).sampled_at, iso(midnight));
  assert.equal(meter(adapter).flow_liters_today, 40);
  adapter.advance(midnight + 10 * MINUTE_MS);
  const days = environment(adapter).water.daily;
  const previous = days.find(day => day.date === '2027-01-12');
  const today = days.find(day => day.date === '2027-01-13');
  assert.equal((previous?.irrigationLiters ?? 0) + (today?.irrigationLiters ?? 0), 80);
  assert.equal(today?.irrigationLiters, 80);
  assert.equal(adapter.viewModel().daily.find(day => day.date === '2027-01-12')?.irrigationLiters.valve, 40);
  assert.equal(adapter.viewModel().today.irrigationLiters.valve, 40);
  assert.deepEqual(adapter.litersBetween(1, START, adapter.now), {estimated: 80, delivered: 80});
});

test('a skipped plan does not animate a valve command', () => {
  const adapter = farm(600);
  openFor(adapter, OPEN, 10);
  write(adapter, 'POST', PLANS_PATH + '/schedules', {kind: 'ONCE', fire_at: iso(ACK), duration_minutes: 10});
  adapter.advance(NATURAL_CLOSE);
  assert.equal(adapter.simulatorSnapshot().outcomes[0].cancelReason, 'busy');
  assert.deepEqual(adapter.drain().map(event => event.kind), ['commanded', 'opened', 'closed']);
});
