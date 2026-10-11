import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DemoError, Simulator, VALVE_EUI} from '../model';

const valvePath = `/api/valve/${VALVE_EUI}`;
const closeValve = (sim: Simulator) => sim.request('POST', valvePath, {action: 'CLOSE'});

test('manual open completes a full acknowledged run across a large tick', () => {
  const sim = new Simulator({mode: 'public'});
  const start = sim.now;
  const reply = sim.request('POST', valvePath, {action: 'OPEN_FOR_DURATION', duration_seconds: 60}) as {status: string};
  assert.equal(reply.status, 'queued');
  sim.advanceTo(start + 123_000);
  const outcome = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations[0]!;
  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(outcome.observedOpenAt, new Date(start + 2_000).toISOString());
  assert.equal(outcome.observedCloseAt, new Date(start + 62_000).toISOString());
  assert.equal(outcome.estimatedGrossLiters, 6);
});

test('cancel before open prevents water and records no observed open or close', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', valvePath, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(sim.now + 1_000);
  sim.request('POST', `${valvePath}/cancel`, {reason: 'operator_cancel'});
  sim.advanceTo(sim.now + 5_000);
  const outcome = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations[0]!;
  assert.equal(outcome.status, 'CANCELLED');
  assert.equal(outcome.observedOpenAt, null);
  assert.equal(outcome.observedCloseAt, null);
  assert.equal(outcome.estimatedGrossLiters, null);
});

test('cancelling an observed run leaves flow running until an explicit close acknowledgement', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', valvePath, {action: 'OPEN_FOR_DURATION', duration_seconds: 600});
  sim.advanceTo(sim.now + 2_000);
  sim.request('POST', `${valvePath}/cancel`, {reason: 'operator_cancel'});
  sim.advanceTo(sim.now + 10_000);
  assert.equal(sim.devices.find(device => device.deveui === VALVE_EUI)?.current_state, 'OPEN');
  closeValve(sim);
  sim.advanceTo(sim.now + 2_000);
  assert.equal(sim.devices.find(device => device.deveui === VALVE_EUI)?.current_state, 'CLOSED');
  const outcome = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations[0]!;
  assert.equal(outcome.status, 'CANCELLED');
  assert.equal(outcome.observedCloseAt, new Date(sim.now).toISOString());
});

test('Settings CLOSE closes an observed run after its own two-second acknowledgement', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', valvePath, {action: 'OPEN_FOR_DURATION', duration_seconds: 600});
  sim.advanceTo(sim.now + 2_000);
  const closeAt = sim.now;
  sim.request('POST', valvePath, {action: 'CLOSE'});
  sim.advanceTo(closeAt + 1_999);
  assert.equal(sim.devices.find(device => device.deveui === VALVE_EUI)?.current_state, 'OPEN');
  sim.advanceTo(closeAt + 2_000);
  assert.equal(sim.devices.find(device => device.deveui === VALVE_EUI)?.current_state, 'CLOSED');
  const outcome = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations[0]!;
  assert.equal(outcome.observedCloseAt, new Date(closeAt + 2_000).toISOString());
  assert.equal(outcome.estimatedGrossLiters, 0.2);
});

test('valve settings validate and persist calibration and default duration', () => {
  const sim = new Simulator({mode: 'public'});
  const response = sim.request('PUT', `/api/valves/${VALVE_EUI}/settings`, {
    strega_generation: 'GEN2', flow_rate_lpm: 8.5, flow_rate_source: 'measured', default_open_minutes: 3,
  }) as Record<string, unknown>;
  const settings = response.settings as Record<string, unknown>;
  assert.equal(settings.default_open_minutes, 3);
  assert.equal(settings.strega_generation, 'GEN2');
  assert.equal(settings.flow_rate_lpm, 8.5);
  const valve = (sim.request('GET', '/api/valves') as {valves: Array<Record<string, unknown>>}).valves.find(row => row.device_eui === VALVE_EUI)!;
  assert.equal(valve.default_open_minutes, 3);
  assert.equal(valve.strega_generation, 'GEN2');
  assert.equal(valve.flow_rate_lpm, 8.5);
});

test('public default open duration is isolated per valve', () => {
  const sim = new Simulator({mode: 'public'});
  const valves = (sim.request('GET', '/api/valves') as {valves: Array<{device_eui: string; default_open_minutes: number}>}).valves;
  const secondEui = valves.find(row => row.device_eui !== VALVE_EUI)!.device_eui;
  sim.request('PUT', `/api/valves/${VALVE_EUI}/settings`, {default_open_minutes: 3});
  const after = (sim.request('GET', '/api/valves') as {valves: Array<{device_eui: string; default_open_minutes: number}>}).valves;
  assert.equal(after.find(row => row.device_eui === VALVE_EUI)?.default_open_minutes, 3);
  assert.equal(after.find(row => row.device_eui === secondEui)?.default_open_minutes, 1);
});

test('presentation valve summary preserves the global default duration', () => {
  const sim = new Simulator();
  const response = sim.request('GET', '/api/valves') as {valves: Array<{default_open_minutes: number}>};
  assert.equal(response.valves[0]?.default_open_minutes, sim.state.defaultOpenMinutes);
});

test('offered service commands validate native units and produce meaningful device state', () => {
  const sim = new Simulator({mode: 'public'});
  const prefix = `/api/devices/${VALVE_EUI}/strega`;
  const calls: Array<[string, string, Record<string, unknown>]> = [
    ['PUT', `${prefix}/interval`, {closedMinutes: 60, openedMinutes: 5, tamperDisabled: true}],
    ['PUT', `${prefix}/model`, {model: 'MOTORIZED'}],
    ['PUT', `${prefix}/magnet`, {enabled: true}],
    ['PUT', `${prefix}/timed-action`, {action: 'OPEN', unit: 'seconds', amount: 10}],
    ['PUT', `${prefix}/partial-opening`, {action: 'OPEN', percentage: 40}],
    ['PUT', `${prefix}/flushing`, {returnPosition: 'CLOSE', percentage: 50}],
  ];
  for (const [method, path, body] of calls) sim.request(method, path, body);
  sim.advanceTo(sim.now + 20_000);
  const valve = sim.devices.find(device => device.deveui === VALVE_EUI) as typeof sim.devices[number] & Record<string, unknown>;
  assert.equal(valve.current_state, 'CLOSED');
  assert.equal(valve.strega_model, 'MOTORIZED');
  assert.equal(valve.strega_magnet_enabled, true);
  assert.equal(valve.strega_uplink_interval_closed_minutes, 60);
  assert.equal(valve.strega_uplink_interval_opened_minutes, 5);
  assert.equal(valve.valve_opening_percent, 0);
  const outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.trigger, 'service_action');
  assert.equal(outcomes[0]?.status, 'COMPLETED');
});

test('timed CLOSE and partial actions use bounded native units and return actionable state', () => {
  const sim = new Simulator({mode: 'public'});
  const prefix = `/api/devices/${VALVE_EUI}/strega`;
  assert.throws(() => sim.request('PUT', `${prefix}/timed-action`, {action: 'OPEN', unit: 'fortnights', amount: 1}));
  assert.throws(() => sim.request('PUT', `${prefix}/partial-opening`, {action: 'OPEN', percentage: 101}));
  sim.request('POST', valvePath, {action: 'OPEN_FOR_DURATION', duration_seconds: 600});
  sim.advanceTo(sim.now + 2_000);
  const start = sim.now;
  sim.request('PUT', `${prefix}/timed-action`, {action: 'CLOSE', unit: 'minutes', amount: 1});
  sim.advanceTo(start + 2_000);
  assert.equal(sim.devices.find(device => device.deveui === VALVE_EUI)?.current_state, 'CLOSED');
  sim.advanceTo(start + 62_000);
  assert.equal(sim.devices.find(device => device.deveui === VALVE_EUI)?.current_state, 'OPEN');
});

test('timed CLOSE restores the previous partial valve position after its hold', () => {
  const sim = new Simulator({mode: 'public'});
  const prefix = `/api/devices/${VALVE_EUI}/strega`;
  sim.request('PUT', `${prefix}/partial-opening`, {action: 'OPEN', percentage: 40});
  sim.advanceTo(sim.now + 2_000);
  sim.request('PUT', `${prefix}/timed-action`, {action: 'CLOSE', unit: 'seconds', amount: 10});
  sim.advanceTo(sim.now + 12_000);
  const valve = sim.devices.find(device => device.deveui === VALVE_EUI) as typeof sim.devices[number] & Record<string, unknown>;
  assert.equal(valve.current_state, 'OPEN');
  assert.equal(valve.valve_opening_percent, 40);
});

test('Settings CLOSE during a timed CLOSE hold cancels the timed return', () => {
  const sim = new Simulator({mode: 'public'});
  const prefix = `/api/devices/${VALVE_EUI}/strega`;
  sim.request('PUT', `${prefix}/partial-opening`, {action: 'OPEN', percentage: 40});
  sim.advanceTo(sim.now + 2_000);
  sim.request('PUT', `${prefix}/timed-action`, {action: 'CLOSE', unit: 'seconds', amount: 10});
  sim.advanceTo(sim.now + 2_000);
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'CLOSE'});
  sim.advanceTo(sim.now + 10_000);
  const valve = sim.devices.find(device => device.deveui === VALVE_EUI)!;
  assert.equal(valve.current_state, 'CLOSED');
  assert.equal(valve.target_state, 'CLOSED');
  assert.equal(sim.state.activeCommands.has(VALVE_EUI), false);
});

test('a timed CLOSE hold owns the valve and rejects competing manual OPEN', () => {
  const sim = new Simulator({mode: 'public'});
  const prefix = `/api/devices/${VALVE_EUI}/strega`;
  sim.request('PUT', `${prefix}/partial-opening`, {action: 'OPEN', percentage: 40});
  sim.advanceTo(sim.now + 2_000);
  sim.request('PUT', `${prefix}/timed-action`, {action: 'CLOSE', unit: 'seconds', amount: 10});
  sim.advanceTo(sim.now + 2_000);
  assert.throws(() => sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60}),
    error => error instanceof DemoError && error.status === 409 && error.code === 'busy');
  sim.advanceTo(sim.now + 10_000);
  const valve = sim.devices.find(device => device.deveui === VALVE_EUI) as typeof sim.devices[number] & Record<string, unknown>;
  assert.equal(valve.current_state, 'OPEN');
  assert.equal(valve.valve_opening_percent, 40);
});

test('pending timed CLOSE owns the valve and a pre-ACK Settings CLOSE cancels its return', () => {
  const sim = new Simulator({mode: 'public'});
  const prefix = `/api/devices/${VALVE_EUI}/strega`;
  sim.request('PUT', `${prefix}/partial-opening`, {action: 'OPEN', percentage: 40});
  sim.advanceTo(sim.now + 2_000);
  sim.request('PUT', `${prefix}/timed-action`, {action: 'CLOSE', unit: 'seconds', amount: 10});
  assert.throws(() => sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60}),
    error => error instanceof DemoError && error.status === 409 && error.code === 'busy');
  assert.throws(() => sim.request('PUT', `${prefix}/partial-opening`, {action: 'OPEN', percentage: 20}),
    error => error instanceof DemoError && error.status === 409 && error.code === 'busy');
  sim.advanceTo(sim.now + 1_000);
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'CLOSE'});
  sim.advanceTo(sim.now + 12_000);
  const valve = sim.devices.find(device => device.deveui === VALVE_EUI) as typeof sim.devices[number] & Record<string, unknown>;
  assert.equal(valve.current_state, 'CLOSED');
  assert.equal(valve.target_state, 'CLOSED');
  assert.equal(valve.valve_opening_percent, 0);
  assert.equal(sim.state.activeCommands.has(VALVE_EUI), false);
  assert.equal(sim.state.timedCloseHolds.has(VALVE_EUI), false);
});

test('one active command owns each valve and a colliding ONCE edge is retained as skipped', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 120});
  assert.throws(() => sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60}),
    error => error instanceof DemoError && error.status === 409 && error.code === 'busy');
  sim.request('POST', `/api/valves/${VALVE_EUI}/schedules`, {kind: 'ONCE', fire_at: new Date(sim.now + 10_000).toISOString(), duration_minutes: 1});
  sim.advanceTo(sim.now + 15_000);
  const outcomes = (sim.request('GET', '/api/irrigation/recent-actuations') as {actuations: Array<Record<string, unknown>>}).actuations;
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.cancelReason, 'busy');
  assert.equal(outcomes[1]?.status, 'RUNNING');
});
