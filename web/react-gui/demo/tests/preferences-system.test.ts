import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AxiosError} from 'axios';
import {api, irrigationZonesAPI, systemAPI, systemSettingsAPI, valvesAPI} from '../../src/services/api';
import {createDemoAdapter} from '../adapter';
import {Simulator, VALVE_EUI} from '../model';

function install(sim: Simulator) { api.defaults.adapter = createDemoAdapter(sim); }

test('presentation entry keeps its original disabled gateway modules while the public seed starts enabled', () => {
  const presentation = new Simulator({mode: 'presentation'});
  const publicSim = new Simulator({mode: 'public'});
  for (const key of ['dataModuleEnabled', 'networkModuleEnabled', 'gatewayHubModuleEnabled', 'journalModuleEnabled'] as const) {
    assert.equal((presentation.request('GET', '/api/system/settings') as Record<string, unknown>)[key], false);
    assert.equal((publicSim.request('GET', '/api/system/settings') as Record<string, unknown>)[key], true);
  }
  assert.deepEqual(presentation.request('GET', '/api/system/features'), {});
  assert.deepEqual(publicSim.request('GET', '/api/system/features'), {
    historyUxEnabled: true, historyComparisonEnabled: true, historyWorkspacesEnabled: true,
    historyAdvancedOverlaysEnabled: true, historyCloudAiEnabled: false,
  });
});

test('public gateway settings expose enabled module defaults and update all four switches', async () => {
  install(new Simulator({mode: 'public'}));
  const initial = await systemSettingsAPI.get();
  assert.equal(initial.gatewayTimezone, 'Africa/Kampala');
  assert.deepEqual(initial.moduleDefaults, {
    dataModuleEnabled: true, networkModuleEnabled: true, gatewayHubModuleEnabled: true, journalModuleEnabled: true,
  });
  for (const key of ['dataModuleEnabled', 'networkModuleEnabled', 'gatewayHubModuleEnabled', 'journalModuleEnabled'] as const) {
    assert.equal(initial[key], true);
    const updated = await systemSettingsAPI.update({[key]: false});
    assert.equal(updated[key], false);
    assert.equal((await systemSettingsAPI.get())[key], false);
  }
});

test('gateway timezone writes preserve explicit zone times and update inherited zone times atomically', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  sim.zones[1]!.timezone = null as unknown as string;
  const explicitBefore = sim.zones[0]!.timezone;
  const inheritedBefore = sim.zones[1]!.timezone;
  const changed = await systemSettingsAPI.update({gatewayTimezone: 'Europe/Zurich'});
  assert.equal(changed.zonesUpdated, 0);
  assert.equal(sim.state.settings.gatewayTimezone, 'Europe/Zurich');
  assert.equal(sim.zones[0]!.timezone, explicitBefore);
  assert.equal(sim.zones[1]!.timezone, inheritedBefore);
  await assert.rejects(systemSettingsAPI.update({gatewayTimezone: 'Mars/Olympus'}), error => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 422);
    assert.deepEqual(error.response?.data, {error: 'invalid_timezone', message: 'gatewayTimezone must be a valid IANA time zone'});
    return true;
  });
  assert.equal(sim.state.settings.gatewayTimezone, 'Europe/Zurich');

  const applied = await systemSettingsAPI.update({gatewayTimezone: 'Europe/Zurich', applyToAllZones: true});
  assert.equal(applied.zonesUpdated, 2);
  assert.ok((await irrigationZonesAPI.getAll()).every(zone => zone.timezone === 'Europe/Zurich'));
  sim.state.settings.defaultTimezone = '';
  const created = await irrigationZonesAPI.create({name: 'New timezone plot'});
  assert.equal(created.timezone, 'Europe/Zurich');
});

test('apply-to-all counts and versions only zones whose timezone actually changes', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const same = sim.zones[0]! as typeof sim.zones[number] & {sync_version?: number};
  const changed = sim.zones[1]! as typeof sim.zones[number] & {sync_version?: number};
  same.sync_version = 4;
  changed.sync_version = 8;
  changed.timezone = 'Europe/Zurich';
  const sameUpdatedAt = same.updated_at;
  const changedUpdatedAt = changed.updated_at;

  sim.advanceTo(sim.now + 1_000);
  const result = await systemSettingsAPI.update({gatewayTimezone: 'Africa/Kampala', applyToAllZones: true});
  assert.equal(result.zonesUpdated, 1);
  assert.equal(same.sync_version, 4);
  assert.equal(same.updated_at, sameUpdatedAt);
  assert.equal(changed.timezone, 'Africa/Kampala');
  assert.equal(changed.sync_version, 9);
  assert.ok(Date.parse(changed.updated_at) > Date.parse(changedUpdatedAt));

  const appliedUpdatedAt = changed.updated_at;
  const repeated = await systemSettingsAPI.update({gatewayTimezone: 'Africa/Kampala', applyToAllZones: true});
  assert.equal(repeated.zonesUpdated, 0);
  assert.equal(changed.sync_version, 9);
  assert.equal(changed.updated_at, appliedUpdatedAt);
});

test('scheduler disable batches enabled local triggers, versions only changed zones once, and preserves valve work', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);

  const makeTrigger = (zoneId: number, enabled: boolean) => api.put(`/api/irrigation-zones/${zoneId}/schedule`, {
    trigger_metric: 'SWT_1', threshold_kpa: 40, enabled, duration_minutes: 5,
  });
  await makeTrigger(1, true);
  await makeTrigger(2, true);
  const alreadyDisabled = await irrigationZonesAPI.create({name: 'Already disabled plot'});
  await makeTrigger(alreadyDisabled.id, false);
  const deleted = await irrigationZonesAPI.create({name: 'Deleted trigger plot'});
  await makeTrigger(deleted.id, true);
  await irrigationZonesAPI.delete(deleted.id);

  const plan = await valvesAPI.createSchedule(VALVE_EUI, {
    kind: 'ONCE', label: 'Keep pending plan', fireAt: new Date(sim.now + 60_000).toISOString(), durationMinutes: 5, enabled: true,
  });
  assert.ok(plan.schedule.scheduleUuid);
  assert.equal(sim.startActuation(VALVE_EUI, 300, 'manual', 2_000, true), true);
  const pendingPlans = structuredClone([...sim.state.schedules.entries()]);
  const activeCommands = structuredClone([...sim.state.activeCommands.entries()]);

  const changedZones = [sim.zones.find(zone => zone.id === 1)!, sim.zones.find(zone => zone.id === 2)!];
  const oldVersions = changedZones.map(zone => (zone.schedule as typeof zone.schedule & {sync_version: number}).sync_version);
  const oldScheduleTimestamps = changedZones.map(() => '2026-10-09T00:00:00.000Z');
  const oldZoneTimestamps = changedZones.map(zone => zone.updated_at);
  changedZones.forEach((zone, index) => { (zone.schedule as typeof zone.schedule & {updated_at: string}).updated_at = oldScheduleTimestamps[index]!; });
  const disabledZone = sim.zones.find(zone => zone.id === alreadyDisabled.id)!;
  const disabledVersion = (disabledZone.schedule as typeof disabledZone.schedule & {sync_version: number}).sync_version;
  const disabledScheduleTimestamp = (disabledZone.schedule as typeof disabledZone.schedule & {updated_at: string}).updated_at;
  const disabledTimestamp = disabledZone.updated_at;
  const pendingBefore = sim.state.sessions.pendingOutboxCount;

  sim.advanceTo(sim.now + 1_000);
  const response = await api.post<{disabledSchedules: number}>('/api/irrigation-zones/schedules/disable-all');
  assert.deepEqual(response.data, {disabledSchedules: 2});
  assert.deepEqual(changedZones.map(zone => zone.schedule?.enabled), [false, false]);
  assert.deepEqual(changedZones.map(zone => (zone.schedule as typeof zone.schedule & {sync_version: number}).sync_version),
    oldVersions.map(version => version + 1));
  const changedScheduleTimestamps = changedZones.map(zone => (zone.schedule as typeof zone.schedule & {updated_at: string}).updated_at);
  assert.deepEqual(changedScheduleTimestamps, [new Date(sim.now).toISOString(), new Date(sim.now).toISOString()]);
  assert.notDeepEqual(changedScheduleTimestamps, oldScheduleTimestamps);
  assert.deepEqual(changedZones.map(zone => zone.updated_at), oldZoneTimestamps);
  assert.equal(disabledZone.schedule?.enabled, false);
  assert.equal((disabledZone.schedule as typeof disabledZone.schedule & {sync_version: number}).sync_version, disabledVersion);
  assert.equal((disabledZone.schedule as typeof disabledZone.schedule & {updated_at: string}).updated_at, disabledScheduleTimestamp);
  assert.equal(disabledZone.updated_at, disabledTimestamp);
  assert.equal(sim.zones.some(zone => zone.id === deleted.id), false);
  assert.equal(sim.state.sessions.pendingOutboxCount, pendingBefore + 1);
  assert.equal(sim.clock.ids().some(id => id.startsWith('daily-trigger:')), false);
  assert.deepEqual([...sim.state.schedules.entries()], pendingPlans);
  assert.deepEqual([...sim.state.activeCommands.entries()], activeCommands);

  const afterFirstMutation = changedZones.map(zone => ({version: (zone.schedule as typeof zone.schedule & {sync_version: number}).sync_version, updatedAt: zone.updated_at}));
  const repeated = await api.post<{disabledSchedules: number}>('/api/irrigation-zones/schedules/disable-all');
  assert.deepEqual(repeated.data, {disabledSchedules: 0});
  assert.deepEqual(changedZones.map(zone => ({version: (zone.schedule as typeof zone.schedule & {sync_version: number}).sync_version, updatedAt: zone.updated_at})), afterFirstMutation);
  assert.equal(sim.state.sessions.pendingOutboxCount, pendingBefore + 1);
});

test('empty settings use the source required-timezone error response', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  await assert.rejects(api.put('/api/system/settings', {}), (error: unknown) => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 422);
    assert.deepEqual(error.response?.data, {error: 'invalid_timezone', message: 'gatewayTimezone is required'});
    return true;
  });
});

test('module settings preserve the source invalid-request code and field message', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  await assert.rejects(api.put('/api/system/settings', {dataModuleEnabled: 'false'}), (error: unknown) => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 422);
    assert.deepEqual(error.response?.data, {error: 'invalid_request', message: 'dataModuleEnabled must be a boolean'});
    return true;
  });
});

test('settings trim gateway timezone before validating and storing it', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const trimmed = await systemSettingsAPI.update({gatewayTimezone: ' Europe/Zurich '});
  assert.equal(trimmed.gatewayTimezone, 'Europe/Zurich');
});

test('invalid mixed settings writes leave gateway and zone state unchanged', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const before = await systemSettingsAPI.get();
  const zonesBefore = sim.zones.map(zone => ({timezone: zone.timezone, updated_at: zone.updated_at}));
  let caught: unknown;
  try { await api.put('/api/system/settings', {gatewayTimezone: 'Mars/Olympus', dataModuleEnabled: false}); }
  catch (error) { caught = error; }
  assert.deepEqual(await systemSettingsAPI.get(), before);
  assert.deepEqual(sim.zones.map(zone => ({timezone: zone.timezone, updated_at: zone.updated_at})), zonesBefore);
  assert.ok(caught instanceof AxiosError);
  assert.equal(caught.response?.status, 422);
  assert.deepEqual(caught.response?.data, {error: 'invalid_timezone', message: 'gatewayTimezone must be a valid IANA time zone'});
});

test('gateway timezone API updates daily trigger and fallback skip-today rollover, preserving explicit zone timezones', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.clock.reset(Date.parse('2026-10-10T20:30:00.000Z'));
  const fallbackZone = sim.zones.find(zone => zone.id === 1)!;
  const explicitZone = sim.zones.find(zone => zone.id === 2)!;
  fallbackZone.timezone = null as unknown as string;
  explicitZone.timezone = 'Europe/Zurich';
  install(sim);
  await api.put('/api/irrigation-zones/1/schedule', {trigger_metric: 'SWT_1', threshold_kpa: 40, enabled: true, duration_minutes: 5});
  const beforeTrigger = sim.clock.ids().find(id => id.startsWith('daily-trigger:'));
  assert.ok(beforeTrigger);
  await valvesAPI.setSchedulerStatus(VALVE_EUI, 'SKIP_TODAY');
  await systemSettingsAPI.update({gatewayTimezone: 'Asia/Tokyo'});
  const afterTrigger = sim.clock.ids().find(id => id.startsWith('daily-trigger:'));
  assert.ok(afterTrigger);
  assert.notEqual(afterTrigger, beforeTrigger);
  const triggerAt = Number(afterTrigger!.slice('daily-trigger:'.length));
  assert.equal(new Intl.DateTimeFormat('en', {timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
    .format(new Date(triggerAt)), '06:00');
  const valve = (await api.get<{valves: Array<{device_eui: string; scheduler_status: string}>}>('/api/valves'))
    .data.valves.find(row => row.device_eui === VALVE_EUI)!;
  assert.equal(valve.scheduler_status, 'ACTIVE');
  assert.equal(fallbackZone.timezone, null);
  assert.equal(explicitZone.timezone, 'Europe/Zurich');
});

test('system samples are fictional, clock driven, fan edits persist, and restart completes on the simulation clock', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const before = await systemAPI.getStats();
  assert.equal(before.fan_available, true);
  assert.equal(before.fan_mode, 'pwm');
  assert.equal(before.fan_max, 255);
  assert.ok(before.mem_total_mb > before.mem_used_mb);
  assert.ok(before.mem_free_mb > 0);
  await systemAPI.setFan(40);
  assert.equal((await systemAPI.getStats()).fan_value, 40);
  assert.deepEqual(await systemAPI.getFeatures(), {
    historyUxEnabled: true, historyComparisonEnabled: true, historyWorkspacesEnabled: true,
    historyAdvancedOverlaysEnabled: true, historyCloudAiEnabled: false,
  });
  const zoneBefore = (await irrigationZonesAPI.getAll()).map(zone => zone.name);
  await systemAPI.reboot();
  assert.ok((await systemAPI.getStats()).restartPending?.restartAt);
  sim.advanceTo(sim.now + 5_000);
  assert.equal((await systemAPI.getStats()).restartPending, null);
  assert.deepEqual((await irrigationZonesAPI.getAll()).map(zone => zone.name), zoneBefore);
  await assert.rejects(systemAPI.setFan(256), error => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 400);
    assert.deepEqual(error.response?.data, {error: 'Provide speed: 0-255'});
    return true;
  });
  assert.equal((await systemAPI.getStats()).fan_value, 40);
  assert.equal((await valvesAPI.list()).find(valve => valve.deviceEui === VALVE_EUI)?.currentState, 'CLOSED');
});
