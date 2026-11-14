import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Simulator, PUBLIC_EPOCH} from '../model';
import {SimulationClock} from '../model/clock';

test('clock processes every boundary in timestamp and priority order', () => {
  const clock = new SimulationClock(0);
  const seen: string[] = [];
  clock.schedule(2000, () => seen.push('later-priority'), {priority: 4, id: 'late'});
  clock.schedule(1000, () => seen.push('first'), {priority: 5, id: 'first'});
  clock.schedule(1000, () => seen.push('close'), {priority: 1, id: 'close'});

  clock.advanceTo(2500);

  assert.deepEqual(seen, ['close', 'first', 'later-priority']);
  assert.equal(clock.now, 2500);
});

test('clock refuses backward movement and repeated target ticks are idempotent', () => {
  const clock = new SimulationClock(100);
  let count = 0;
  clock.schedule(200, () => {count += 1;}, {id: 'once'});
  clock.advanceTo(200);
  clock.advanceTo(200);
  assert.throws(() => clock.advanceTo(199), /backward/i);
  assert.equal(count, 1);
  assert.equal(clock.now, 200);
});

test('public speed, pause, reset, and next-event jump share one clock', () => {
  const sim = new Simulator({mode: 'public'});
  assert.equal(sim.now, PUBLIC_EPOCH);
  sim.speed = 10;
  sim.advance(1000);
  assert.equal(sim.now, PUBLIC_EPOCH + 10000);
  sim.active = false;
  sim.advance(5000);
  assert.equal(sim.now, PUBLIC_EPOCH + 10000);

  sim.active = true;
  sim.request('POST', '/api/valve/00000000000000D1', {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.active = false;
  const pausedAt = sim.now;
  assert.equal(sim.jumpToNextEvent(), true);
  assert.equal(sim.now, pausedAt + 2000);
  assert.equal(sim.active, false);
  assert.equal(sim.devices.find(device => device.deveui === '00000000000000D1')?.current_state, 'OPEN');

  sim.reset();
  assert.equal(sim.now, PUBLIC_EPOCH);
  assert.equal(sim.speed, 1);
  assert.equal(sim.active, true);
  assert.equal(sim.jumpToNextEvent(), false); // routine samples and disabled seed triggers are not jump targets
  sim.request('PUT', '/api/irrigation-zones/1/schedule', {trigger_metric: 'SWT_1', threshold_kpa: 40, enabled: true, duration_minutes: 5});
  assert.equal(sim.jumpToNextEvent(), true); // enabled trigger makes the 06:00 evaluation reachable
  assert.equal(sim.now, PUBLIC_EPOCH + 10000);
});

test('routine samples run en route but do not become jump targets', () => {
  const clock = new SimulationClock(0);
  let sampled = 0;
  let service = 0;
  clock.schedule(30000, () => {sampled += 1;}, {id: 'sample-1', meaningful: false});
  clock.schedule(60000, () => {sampled += 1;}, {id: 'sample-2', meaningful: false});
  clock.schedule(90000, () => {service += 1;}, {id: 'service', meaningful: true});
  assert.equal(clock.nextEventAt(), 90000);
  clock.advanceTo(clock.nextEventAt()!);
  assert.equal(sampled, 2);
  assert.equal(service, 1);
  assert.equal(clock.nextEventAt(), null);
});

test('next event search is bounded and recalculates 06:00 after a timezone change', () => {
  const clock = new SimulationClock(0);
  clock.schedule(9 * 24 * 60 * 60 * 1000, () => {}, {id: 'too-far', meaningful: true});
  assert.equal(clock.nextEventAt(), null);

  const sim = new Simulator({mode: 'public'});
  sim.setGatewayTimezone('America/New_York');
  assert.equal(sim.clock.nextEventAt(), null);
  sim.request('PUT', '/api/irrigation-zones/1/schedule', {trigger_metric: 'SWT_1', threshold_kpa: 40, enabled: true, duration_minutes: 5});
  const next = sim.clock.nextEventAt()!;
  const local = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(next));
  assert.equal(local, '06:00');
});

test('maximum supported acceleration processes chronological routine samples', () => {
  const sim = new Simulator({mode: 'public'});
  const before = sim.readings.forDevice('00000000000000A1').length;
  sim.speed = 60;
  assert.equal(sim.advance(30 * 60 * 1000), true);
  assert.equal(sim.now, PUBLIC_EPOCH + 30 * 60 * 1000 * 60);
  assert.equal(sim.readings.forDevice('00000000000000A1').length, before + 60);
});

test('a user request drains clock events already due at the current timestamp first', () => {
  const sim = new Simulator({mode: 'public'});
  sim.clock.schedule(sim.now, () => {sim.state.sessions.username = 'clock event completed';}, {id: 'due-before-write'});
  sim.request('POST', '/api/irrigation-zones', {name: 'After due event'});
  assert.equal(sim.state.sessions.username, 'clock event completed');
});
