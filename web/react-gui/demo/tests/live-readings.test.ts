import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Simulator, PUBLIC_EPOCH, VALVE_EUI} from '../model';

test('public mode retains a deterministic 90-day measured ledger and missing channels', () => {
  const a = new Simulator({mode: 'public'});
  const b = new Simulator({mode: 'public'});
  const first = a.readings.forDevice('00000000000000A1');
  assert.ok(first.length >= 90 * 48);
  assert.deepEqual(first, b.readings.forDevice('00000000000000A1'));
  assert.equal(first.at(-1)?.at, PUBLIC_EPOCH);
  assert.equal(a.readings.latest('00000000000000A1', 'swt_3'), 55);
  assert.equal(a.readings.latest('00000000000000A1', 'vwc'), null);
  assert.equal(a.readings.latest('00000000000000A1', 'rain_mm_delta'), 0);
});

test('live samples advance the ledger while preserving missing data and explicit zero', () => {
  const sim = new Simulator({mode: 'public'});
  const before = sim.readings.forDevice('00000000000000A1').length;
  sim.advance(30 * 60 * 1000);
  assert.equal(sim.readings.forDevice('00000000000000A1').length, before + 1);
  const latest = sim.readings.forDevice('00000000000000A1').at(-1)!;
  assert.equal(latest.values.vwc, null);
  assert.equal(latest.values.rain_mm_delta, 0);
  assert.equal(sim.readings.latest('00000000000000A1', 'rain_mm_delta'), 0);
});

test('flow is integrated only over observed-open time and shared by readings and summaries', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advance(62000);
  assert.equal(sim.now, PUBLIC_EPOCH + 62000);
  const liters = sim.readings.latest('00000000000000E1', 'flow_liters_delta');
  assert.equal(liters, 6);
  assert.equal(sim.zones[0].daily_volume_liters, 6);
  assert.equal(sim.devices.find(device => device.deveui === '00000000000000E1')?.latest_data.flow_liters_today, 6);
});

test('public manual close waits for its local acknowledgement and integrates until observed close', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(PUBLIC_EPOCH + 12000);
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'CLOSE'});
  assert.equal(sim.outcomes[0].observedCloseAt, null);
  assert.equal(sim.devices.find(device => device.deveui === VALVE_EUI)?.current_state, 'OPEN');
  sim.advanceTo(PUBLIC_EPOCH + 14000);
  assert.equal(sim.outcomes[0].observedCloseAt, new Date(PUBLIC_EPOCH + 14000).toISOString());
  assert.equal(sim.outcomes[0].estimatedGrossLiters, 1.2);
});

test('observed flow survives a same-timestamp routine sample and feeds daily ledger summary', () => {
  const sim = new Simulator({mode: 'public'});
  const boundary = PUBLIC_EPOCH + 30 * 60 * 1000;
  sim.advanceTo(boundary - 62000);
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(boundary);
  const flow = sim.readings.forDevice('00000000000000E1').find(sample => sample.at === boundary);
  assert.equal(flow?.source, 'observed-flow');
  assert.equal(flow?.values.flow_liters_delta, 6);
  const summary = sim.request('GET', '/api/irrigation-zones/1/environment-summary') as any;
  assert.equal(summary.water.irrigationTodayLiters, 6);
  assert.equal(summary.water.daily.at(-1).irrigationLiters, 6);
});

test('public seed contains both valves and the enabled dendrometer cohort', () => {
  const sim = new Simulator({mode: 'public'});
  const valves = sim.devices.filter(device => device.type_id === 'STREGA_VALVE');
  assert.deepEqual(new Set(sim.devices.map(device => device.type_id)), new Set([
    'KIWI_SENSOR', 'STREGA_VALVE', 'DRAGINO_LSN50', 'TEKTELIC_CLOVER', 'SENSECAP_S2120',
    'AQUASCOPE_LORAIN', 'MILESIGHT_UC512', 'DRAGINO_SDI12', 'RAK10701_FIELD_TESTER',
  ]));
  assert.equal(valves.length, 2);
  assert.deepEqual(new Set(valves.map(valve => valve.irrigation_zone_id)), new Set([1, 2]));
  assert.ok(sim.devices.some(device => device.type_id === 'DRAGINO_LSN50' && device.dendro_enabled === 1 && device.irrigation_zone_id === 2));
});

test('public valve listing remains truthful after deleting all valves', () => {
  const sim = new Simulator({mode: 'public'});
  for (const valve of sim.devices.filter(device => device.type_id === 'STREGA_VALVE')) sim.removeDevice(valve.deveui);
  assert.deepEqual((sim.request('GET', '/api/valves') as {valves: unknown[]}).valves, []);
});

test('public water history iterates local calendar days across spring and fall DST changes', () => {
  const sim = new Simulator({mode: 'public'});
  const zone = sim.zones.find(candidate => candidate.id === 1)!;
  zone.timezone = 'Europe/Zurich';
  const daysAt = (at: string) => {
    sim.clock.reset(Date.parse(at));
    const summary = sim.request('GET', '/api/irrigation-zones/1/environment-summary') as any;
    return summary.water.daily.map((day: {date: string}) => day.date);
  };
  assert.deepEqual(daysAt('2026-03-29T22:30:00.000Z'), [
    '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30',
  ]);
  assert.deepEqual(daysAt('2026-10-25T22:30:00.000Z'), [
    '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25',
  ]);
});

test('reset clears live records and reconstructs the exact deterministic public seed', () => {
  const sim = new Simulator({mode: 'public'});
  const seed = sim.readings.forDevice('00000000000000A1');
  sim.advance(30 * 60 * 1000);
  assert.equal(sim.readings.forDevice('00000000000000A1').length, seed.length + 1);
  sim.reset();
  assert.deepEqual(sim.readings.forDevice('00000000000000A1'), seed);
  assert.equal(sim.now, PUBLIC_EPOCH);
});

test('ledger aggregation preserves observed zero and absent samples across a local-day boundary', () => {
  const sim = new Simulator({mode: 'public'});
  const eui = '00000000000000E1';
  const start = Date.parse('2026-10-09T20:40:00.000Z');
  const afterMidnight = Date.parse('2026-10-09T22:10:00.000Z'); // Includes samples on both sides of Kampala midnight.
  assert.equal(sim.readings.aggregate(eui, 'rain_mm_delta', start, afterMidnight), 0);
  assert.equal(sim.readings.aggregate('removed-device', 'rain_mm_delta', start, afterMidnight), null);
  sim.removeDevice(eui);
  assert.equal(sim.readings.aggregate(eui, 'rain_mm_delta', start, afterMidnight), 0);
});

test('removing a device invalidates its pending samples and retains its historical ledger', () => {
  const sim = new Simulator({mode: 'public'});
  const eui = '00000000000000A1';
  const before = sim.readings.forDevice(eui).length;
  const nextSample = sim.now + 30 * 60 * 1000;
  sim.removeDevice(eui);
  sim.advanceTo(nextSample);
  assert.equal(sim.devices.some(device => device.deveui === eui), false);
  assert.equal(sim.readings.forDevice(eui).length, before);
});

test('removing a valve invalidates its queued ACK and closure events', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.removeDevice(VALVE_EUI);
  sim.advanceTo(sim.now + 62000);
  assert.equal(sim.devices.some(device => device.deveui === VALVE_EUI), false);
  assert.equal(sim.outcomes[0].status, 'CANCELLED');
  assert.equal(sim.outcomes[0].observedCloseAt, null);
});

test('new public devices receive explicitly tagged deterministic demonstration history', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', '/api/devices', {deveui: '00000000000000B0', name: 'New fictional sensor', type_id: 'KIWI_SENSOR'});
  const samples = sim.readings.forDevice('00000000000000B0');
  assert.equal(samples.length, 90 * 48 + 1);
  assert.ok(samples.slice(0, -1).every(sample => sample.source === 'fictional-history'));
  assert.equal(samples.at(-1)?.source, 'synthetic');
});

test('active commands and closure generations are independent per valve', () => {
  const sim = new Simulator({mode: 'public'});
  const second = sim.devices.find(device => device.type_id === 'STREGA_VALVE' && device.deveui !== VALVE_EUI)!;
  assert.ok(second);
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.request('POST', `/api/valve/${second.deveui}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  assert.equal(sim.state.activeCommands.size, 2);
  sim.advanceTo(sim.now + 62000);
  assert.equal(sim.state.activeCommands.size, 0);
  assert.equal(sim.outcomes.length, 2);
  assert.ok(sim.outcomes.every(outcome => outcome.status === 'COMPLETED' && outcome.estimatedGrossLiters === 6));
});

test('delayed soil response changes measured readings only after the response event', () => {
  const sim = new Simulator({mode: 'public'});
  const eui = '00000000000000A1';
  const before = sim.readings.latest(eui, 'swt_1')!;
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(sim.now + 62000);
  assert.equal(sim.readings.latest(eui, 'swt_1'), before);
  const ordinaryDrying = 46.5;
  sim.advanceTo(sim.now + 10 * 60 * 1000);
  assert.ok((sim.readings.latest(eui, 'swt_1') ?? Infinity) < ordinaryDrying);
});
