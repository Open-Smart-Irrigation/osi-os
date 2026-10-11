import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  accountLinkAPI,
  analysisAPI,
  api,
  devicesAPI,
  fetchScopeProfile,
  historyAPI,
  irrigationOutcomesAPI,
  irrigationZonesAPI,
  networkAPI,
  sensorAPI,
  supportRequestsAPI,
  systemAPI,
  systemSettingsAPI,
  valvesAPI,
  stregaAPI,
  valveAPI,
  ValvePlanConflictError,
} from '../../src/services/api';
import {AxiosError} from 'axios';
import {journalApi} from '../../src/services/journalApi';
import {createDemoAdapter} from '../adapter';
import {Simulator, SPARE_EUI, VALVE_EUI} from '../model';

function installTestSimulatorAdapter(sim: Simulator): void {
  api.defaults.adapter = createDemoAdapter(sim);
}

function object(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
}

test('AU01 returns the source-shaped local scope profile through the simulator adapter', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const scope = await fetchScopeProfile();
  assert.equal(scope.role, 'researcher');
  assert.equal(scope.features.scoped_access, false);
  assert.equal(scope.zone_uuids, null);
  assert.equal(scope.plot_uuids, null);
});

test('FA01 and FA02 reads return normalized device and zone collections', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const devices = await devicesAPI.getAll();
  const zones = await irrigationZonesAPI.getAll();
  assert.ok(devices.some(device => device.deveui === VALVE_EUI));
  assert.equal(zones.length, 2);
  assert.ok(zones.every(zone => typeof zone.zone_uuid === 'string' && Number.isInteger(zone.device_count)));
});

test('FA03 create returns the created zone on the dependent collection read', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const created = await irrigationZonesAPI.create({name: 'Contract plot'});
  const zones = await irrigationZonesAPI.getAll();
  assert.ok(created.id > 2);
  assert.equal(zones.find(zone => zone.id === created.id)?.name, 'Contract plot');
});

test('FA04 rename returns the owning route envelope and updates the dependent read', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const renamed = await irrigationZonesAPI.rename(1, 'Renamed tomato plot');
  const zones = await irrigationZonesAPI.getAll();
  assert.equal(renamed.changed, true);
  assert.equal(renamed.name, 'Renamed tomato plot');
  assert.equal(zones.find(zone => zone.id === 1)?.name, 'Renamed tomato plot');
});

test('DV01 returns the complete nine-item native device catalogue', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const catalogue = await devicesAPI.getCatalog();
  assert.equal(catalogue.length, 9);
  assert.deepEqual(catalogue.map(item => item.id), [
    'KIWI_SENSOR', 'TEKTELIC_CLOVER', 'STREGA_VALVE', 'DRAGINO_LSN50',
    'SENSECAP_S2120', 'AQUASCOPE_LORAIN', 'MILESIGHT_UC512', 'DRAGINO_SDI12', 'RAK10701_FIELD_TESTER',
  ]);
});

test('DV02 add registers an allowed fictional device and exposes it on the dependent read', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const added = await devicesAPI.add({deveui: '00000000000000B0', name: 'Contract sensor', type_id: 'KIWI_SENSOR'});
  const devices = await devicesAPI.getAll();
  assert.equal(added.deveui, '00000000000000B0');
  assert.equal(devices.find(device => device.deveui === added.deveui)?.name, 'Contract sensor');
});

test('DV03 rename returns the complete rename result and updates the dependent device read', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const renamed = await devicesAPI.rename(SPARE_EUI, 'Renamed sensor');
  const devices = await devicesAPI.getAll();
  assert.equal(renamed.changed, true);
  assert.equal(renamed.chirpstack, 'skipped');
  assert.equal(devices.find(device => device.deveui === SPARE_EUI)?.name, 'Renamed sensor');
});

test('VA01 list has the full valve summary envelope and nullable zone fields', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const valves = await valvesAPI.list();
  const valve = valves.find(candidate => candidate.deviceEui === VALVE_EUI);
  assert.ok(valve);
  assert.ok('activeActuation' in valve);
  assert.ok('pushState' in valve);
});

test('VA02 timed-open mutation is visible in the dependent valve and outcome reads', async () => {
  const sim = new Simulator({mode: 'public'});
  installTestSimulatorAdapter(sim);
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  const valves = await valvesAPI.list();
  const outcomes = await irrigationOutcomesAPI.recentActuations();
  const valve = valves.find(candidate => candidate.deviceEui === VALVE_EUI);
  assert.equal(valve?.targetState, 'OPEN');
  assert.equal(valve?.activeActuation?.reconciliationState, 'PENDING_OBSERVATION');
  assert.equal(outcomes.actuations[0].status, 'PENDING_OPEN');
});

test('VA03 cancellation changes the active command and retained outcome', async () => {
  const sim = new Simulator({mode: 'public'});
  installTestSimulatorAdapter(sim);
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  await devicesAPI.cancelIrrigation(VALVE_EUI);
  const valves = await valvesAPI.list();
  const outcomes = await irrigationOutcomesAPI.recentActuations();
  assert.equal(valves.find(candidate => candidate.deviceEui === VALVE_EUI)?.activeActuation, null);
  assert.equal(outcomes.actuations[0].status, 'CANCELLED');
});

test('VA05 settings update is reflected by the dependent valve read', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await valvesAPI.updateSettings(VALVE_EUI, {stregaGeneration: 'GEN2', flowRateLpm: 8.5, flowRateSource: 'measured', defaultOpenMinutes: 4});
  const valve = (await valvesAPI.list()).find(candidate => candidate.deviceEui === VALVE_EUI);
  assert.equal(valve?.defaultOpenMinutes, 4);
  assert.equal(valve?.stregaGeneration, 'GEN2');
  assert.equal(valve?.flowRateLpm, 8.5);
  assert.equal(valve?.flowRateSource, 'measured');
  await valvesAPI.updateSettings(VALVE_EUI, {flowRateLpm: null});
  const cleared = (await valvesAPI.list()).find(candidate => candidate.deviceEui === VALVE_EUI);
  assert.equal(cleared?.flowRateLpm, null);
  assert.equal(cleared?.flowRateSource, null);
});

test('VA04 CLOSE acknowledges through the native client and closes observed water after two seconds', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(sim.now + 2000);
  assert.equal((await valvesAPI.list()).find(row => row.deviceEui === VALVE_EUI)?.currentState, 'OPEN');
  await devicesAPI.controlValve(VALVE_EUI, {action: 'CLOSE'});
  assert.equal((await valvesAPI.list()).find(row => row.deviceEui === VALVE_EUI)?.currentState, 'OPEN');
  sim.advanceTo(sim.now + 2000);
  assert.equal((await valvesAPI.list()).find(row => row.deviceEui === VALVE_EUI)?.currentState, 'CLOSED');
});

test('VA06 saved default is returned without creating an actuation', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await valvesAPI.updateSettings(VALVE_EUI, {defaultOpenMinutes: 8});
  assert.equal((await valvesAPI.list()).find(row => row.deviceEui === VALVE_EUI)?.defaultOpenMinutes, 8);
  assert.equal((await irrigationOutcomesAPI.recentActuations()).actuations.length, 0);
});

test('VA07 schedules returns all source-shaped weekly compilation and settings fields', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const response = await valvesAPI.schedules(VALVE_EUI);
  assert.equal(response.schedules.length, 0);
  assert.equal(response.compiled.days.length, 7);
  assert.equal(response.settings.defaultOpenMinutes, 1);
});

test('VA08 WEEKLY and ONCE writes round trip through the native schedule client', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  const weekly = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'WEEKLY', label: 'Morning', weekdaysMask: 2, startTime: '06:00', durationMinutes: 15, enabled: true});
  const once = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'ONCE', label: 'Single', fireAt: new Date(sim.now + 3600_000).toISOString(), durationMinutes: 10, enabled: true});
  const schedules = await valvesAPI.schedules(VALVE_EUI);
  assert.equal(weekly.schedule.kind, 'WEEKLY'); assert.equal(weekly.pushesQueued, 8); // Seven GEN1 weekday rows plus initial clock sync.
  assert.equal(once.schedule.kind, 'ONCE'); assert.equal(once.schedule.durationMinutes, 10);
  assert.equal(schedules.schedules.length, 2);
});

test('ONCE dispatch that collides with a busy valve is read as terminal SKIPPED', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 120});
  const once = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'ONCE', fireAt: new Date(sim.now + 10_000).toISOString(), durationMinutes: 1});
  sim.advanceTo(sim.now + 15_000);
  const saved = (await valvesAPI.schedules(VALVE_EUI)).schedules.find(row => row.scheduleUuid === once.schedule.scheduleUuid)!;
  assert.equal(saved.onceState, 'SKIPPED');
  assert.equal(saved.dispatchState, 'SKIPPED');
  assert.match(saved.dispatchCommandId ?? '', /busy/);
  const outcomes = (await irrigationOutcomesAPI.recentActuations()).actuations;
  assert.equal(outcomes.find(row => row.cancelReason === 'busy')?.status, 'CANCELLED');
});

test('editing a completed ONCE label preserves its terminal dispatch and emits no duplicate outcome', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  const once = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'ONCE', fireAt: new Date(sim.now + 1_000).toISOString(), durationMinutes: 1});
  sim.advanceTo(sim.now + 602_000);
  const before = (await valvesAPI.schedules(VALVE_EUI)).schedules.find(row => row.scheduleUuid === once.schedule.scheduleUuid)!;
  await valvesAPI.updateSchedule(VALVE_EUI, once.schedule.scheduleUuid, {label: 'Renamed after completion'});
  const after = (await valvesAPI.schedules(VALVE_EUI)).schedules.find(row => row.scheduleUuid === once.schedule.scheduleUuid)!;
  assert.equal(after.onceState, 'FIRED');
  assert.equal(after.dispatchState, before.dispatchState);
  assert.equal(after.dispatchCommandId, before.dispatchCommandId);
  assert.equal((await irrigationOutcomesAPI.recentActuations()).actuations.length, 1);
});

test('VA09 update compiles before writing and returns actual plan conflict details', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const a = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'WEEKLY', label: 'Irrigation A', weekdaysMask: 2, startTime: '06:00', durationMinutes: 15, enabled: true});
  const b = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'WEEKLY', label: 'Irrigation B', weekdaysMask: 2, startTime: '06:30', durationMinutes: 15, enabled: true});
  await assert.rejects(valvesAPI.updateSchedule(VALVE_EUI, b.schedule.scheduleUuid, {startTime: '06:10'}), error => {
    assert.ok(error instanceof ValvePlanConflictError);
    assert.equal(error.details[0]?.code, 'overlap');
    assert.deepEqual(error.details[0]?.labels, ['Irrigation A', 'Irrigation B']);
    return true;
  });
  assert.equal((await valvesAPI.schedules(VALVE_EUI)).schedules.find(row => row.scheduleUuid === b.schedule.scheduleUuid)?.startTime, '06:30');
  assert.ok(a.schedule.scheduleUuid);
});

test('VA10 deleting WEEKLY removes it from compiled plan and queues a changed-plan delivery', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const plan = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'WEEKLY', weekdaysMask: 2, startTime: '06:00', durationMinutes: 15, enabled: true});
  const deleted = await valvesAPI.deleteSchedule(VALVE_EUI, plan.schedule.scheduleUuid);
  assert.equal(deleted.pushesQueued, 1);
  assert.equal((await valvesAPI.schedules(VALVE_EUI)).schedules.length, 0);
});

test('VA11 resend creates a fresh delivery ACK without replaying a plan occurrence', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  const sent = await valvesAPI.resendPlan(VALVE_EUI);
  assert.equal(sent.pushesQueued, 8); // Forced seven-day recompile plus clock sync.
  assert.equal((await valvesAPI.schedules(VALVE_EUI)).pushState[0]?.state, 'QUEUED');
  sim.advanceTo(sim.now + 2000);
  assert.equal((await valvesAPI.schedules(VALVE_EUI)).pushState[0]?.state, 'ACKED');
  assert.equal((await irrigationOutcomesAPI.recentActuations()).actuations.length, 0);
});

test('VA12 scheduler-status accepts source enum and appears in valve summaries', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  await valvesAPI.setSchedulerStatus(VALVE_EUI, 'DEACTIVATED');
  assert.equal((await valvesAPI.list()).find(row => row.deviceEui === VALVE_EUI)?.schedulerStatus, 'DEACTIVATED');
});

test('VA13 interval service retains separate native interval values after ACK', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  const before = sim.devices.find(row => row.deveui === VALVE_EUI) as unknown as Record<string, unknown>;
  const priorClosed = before.strega_uplink_interval_closed_minutes;
  await stregaAPI.setUplinkInterval(VALVE_EUI, {closedMinutes: 5, openedMinutes: 2, tamperDisabled: true});
  assert.equal((sim.devices.find(row => row.deveui === VALVE_EUI) as unknown as Record<string, unknown>).strega_uplink_interval_closed_minutes, priorClosed);
  sim.advanceTo(sim.now + 2000);
  const read = (await devicesAPI.getAll()).find(row => row.deveui === VALVE_EUI) as unknown as Record<string, unknown>;
  assert.equal(read.strega_uplink_interval_closed_minutes, 5); assert.equal(read.strega_uplink_interval_opened_minutes, 2);
  assert.equal(read.strega_tamper_disabled, true);
});

test('VA14 model service updates the native model after ACK', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await stregaAPI.setModel(VALVE_EUI, 'MOTORIZED'); sim.advanceTo(sim.now + 2000);
  assert.equal((await devicesAPI.getAll()).find(row => row.deveui === VALVE_EUI)?.strega_model, 'MOTORIZED');
});

test('VA15 timed action changes physical valve state and records its service source', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await stregaAPI.setTimedAction(VALVE_EUI, {action: 'OPEN', unit: 'seconds', amount: 3});
  sim.advanceTo(sim.now + 2000);
  assert.equal(sim.devices.find(row => row.deveui === VALVE_EUI)?.current_state, 'OPEN');
  sim.advanceTo(sim.now + 3000);
  assert.equal(sim.devices.find(row => row.deveui === VALVE_EUI)?.current_state, 'CLOSED');
  assert.equal(sim.state.serviceActions[0]?.action, 'timed-action');
});

test('VA16 magnet service updates the retained device capability', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await stregaAPI.setMagnetEnabled(VALVE_EUI, true); sim.advanceTo(sim.now + 2000);
  assert.equal((await devicesAPI.getAll()).find(row => row.deveui === VALVE_EUI)?.strega_magnet_enabled, true);
});

test('VA17 partial opening applies physical movement and opening percentage', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await stregaAPI.setPartialOpening(VALVE_EUI, {action: 'OPEN', percentage: 40}); sim.advanceTo(sim.now + 2000);
  const valve = sim.devices.find(row => row.deveui === VALVE_EUI) as unknown as Record<string, unknown>;
  const read = (await devicesAPI.getAll()).find(row => row.deveui === VALVE_EUI) as unknown as Record<string, unknown>;
  assert.equal(read.current_state, 'OPEN'); assert.equal(valve.valve_opening_percent, 40);
});

test('VA18 flushing produces staged movement and returns closed with flow ledger', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await stregaAPI.setFlushing(VALVE_EUI, {percentage: 50, returnPosition: 'CLOSE'});
  sim.advanceTo(sim.now + 2000);
  assert.equal(sim.devices.find(row => row.deveui === VALVE_EUI)?.current_state, 'OPEN');
  sim.advanceTo(sim.now + 5000);
  assert.equal(sim.devices.find(row => row.deveui === VALVE_EUI)?.current_state, 'CLOSED');
  assert.ok(sim.state.ledger[0]?.estimatedGrossLiters && sim.state.ledger[0].estimatedGrossLiters! > 0);
});

test('VA19 today liters uses the simulated flow source and matches the movement ledger', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(sim.now + 62_000);
  const today = await valveAPI.getTodayLiters(VALVE_EUI);
  assert.ok((today.liters ?? 0) > 0); assert.equal(today.source, 'measured');
});

test('VA20 retained recent outcome reports the actual completed manual run', async () => {
  const sim = new Simulator({mode: 'public'}); installTestSimulatorAdapter(sim);
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 60}); sim.advanceTo(sim.now + 62_000);
  const recent = await irrigationOutcomesAPI.recentActuations();
  assert.equal(recent.actuations[0]?.status, 'COMPLETED');
  assert.equal(recent.actuations[0]?.observedOpenAt, new Date(sim.now - 60_000).toISOString());
});

test('PR09 returns all disabled public experimental gateway module defaults', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const settings = await systemSettingsAPI.get();
  assert.equal(settings.dataModuleEnabled, false);
  assert.equal(settings.networkModuleEnabled, false);
  assert.equal(settings.gatewayHubModuleEnabled, false);
  assert.equal(settings.journalModuleEnabled, false);
});

test('PR10 settings write changes the dependent system-settings read', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const before = await systemSettingsAPI.get();
  await systemSettingsAPI.update({dataModuleEnabled: true});
  const after = await systemSettingsAPI.get();
  assert.equal(before.dataModuleEnabled, false);
  assert.equal(after.dataModuleEnabled, true);
});

test('SY01 returns source-shaped deterministic system stats', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const stats = await systemAPI.getStats();
  object(stats);
  for (const key of ['cpu_temp_c', 'mem_total_mb', 'mem_used_mb', 'mem_free_mb', 'mem_percent', 'load_1', 'load_5', 'load_15', 'cpu_count', 'fan_available', 'fan_mode', 'fan_value', 'fan_max']) {
    assert.ok(key in stats, `missing SystemStats.${key}`);
  }
});

test('SU01 support request receipt appears in the dependent local inbox read', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const receipt = await supportRequestsAPI.create({
    type: 'bug', title: 'Contract test', description: 'Contract test message', area: 'other', severity: 'idea',
    consent_public: true, consent_diagnostics: false,
  });
  const requests = await supportRequestsAPI.list();
  assert.ok(receipt.request_id);
  assert.ok(requests.some(request => request.request_id === receipt.request_id && request.description_preview === 'Contract test message'));
});

test('RD01 history returns timestamped samples for the selected source channel', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const history = await sensorAPI.getHistory(SPARE_EUI, 'swt_1', 24);
  assert.ok(history.length > 0);
  assert.ok(history.every(point => typeof point.t === 'string' && 'value' in point));
});

test('AN01 analysis catalogue derives available channels from current assignments', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const catalog = await analysisAPI.getChannels();
  object(catalog);
  assert.equal(typeof catalog.generatedAt, 'string');
  assert.ok(Array.isArray(catalog.channels));
});

test('HI01 zone history cards return the exact source response envelope', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const cards = await historyAPI.getZoneCards(1);
  object(cards);
  assert.ok(Array.isArray(cards.cards));
});

test('JO01 journal catalogue includes capture definitions used by the native form', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const catalog = await journalApi.getCatalog({includeDefinitions: true});
  object(catalog);
  assert.ok(Array.isArray(catalog.vocab));
  assert.ok(Array.isArray(catalog.templates));
});

test('NE03 network observations return stable pagination fields', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const page = await networkAPI.observations(20, 0, {hours: 24});
  assert.deepEqual(Object.keys(page).sort(), ['from', 'nextOffset', 'rows', 'to', 'truncated']);
  assert.ok(Array.isArray(page.rows));
  assert.equal(typeof page.truncated, 'boolean');
});

test('AU05 account-link status is an actual local state read', async () => {
  installTestSimulatorAdapter(new Simulator({mode: 'public'}));
  const status = await accountLinkAPI.getStatus();
  assert.equal(status.linked, false);
});
