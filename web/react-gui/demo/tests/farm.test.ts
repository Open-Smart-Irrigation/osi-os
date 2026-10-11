import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AxiosAdapter, AxiosResponse} from 'axios';
import {api, irrigationZonesAPI, devicesAPI, environmentAPI} from '../../src/services/api';
import {Simulator, VALVE_EUI} from '../model';

function bridge(sim: Simulator): void {
  const adapter: AxiosAdapter = async config => {
    const url = new URL(config.url ?? '', 'http://simulator.test');
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {};
    const data = sim.request(config.method ?? 'GET', `${url.pathname}${url.search}`, body);
    return {data, status: 200, statusText: 'OK', headers: {}, config} as AxiosResponse;
  };
  api.defaults.adapter = adapter;
}

test('FA05 allows deleting a starting zone and preserves device records as unassigned', async () => {
  bridge(new Simulator({mode: 'public'}));
  await irrigationZonesAPI.delete(1);
  const zones = await irrigationZonesAPI.getAll();
  const devices = await (await import('../../src/services/api')).devicesAPI.getAll();
  assert.deepEqual(zones.map(zone => zone.id), [2]);
  assert.ok(devices.some(device => device.name === 'Tomato soil probe' && device.irrigation_zone_id == null));
});

test('FA05 deleting either starting zone preserves a running label and new unassigned runs stay unassigned', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  const active = sim.outcomes[0];
  await irrigationZonesAPI.delete(1);
  assert.equal(sim.state.activeCommands.get(VALVE_EUI)?.zone_id, 1);
  assert.equal(sim.outcomes[0]?.zoneName, active.zoneName);
  sim.advanceTo(sim.now + 62000);
  assert.equal(sim.outcomes[0]?.status, 'COMPLETED');
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  assert.equal(sim.outcomes[0]?.zoneId, null);
  const spareZone = (await irrigationZonesAPI.create({name: 'Renamed spare'})).id;
  await irrigationZonesAPI.delete(spareZone);
  assert.deepEqual((await irrigationZonesAPI.getAll()).map(zone => zone.id), [2]);
});

test('FA08 saves zone agronomy and location fields for the next read', async () => {
  bridge(new Simulator({mode: 'public'}));
  await irrigationZonesAPI.updateConfig(1, {areaM2: 200, irrigationEfficiencyPct: 50, cropType: 'Maize', soilType: 'Clay', timezone: 'Europe/Zurich'});
  const zone = (await irrigationZonesAPI.getAll()).find(item => item.id === 1)!;
  assert.equal(zone.area_m2, 200);
  assert.equal(zone.irrigation_efficiency_pct, 50);
  assert.equal(zone.crop_type, 'Maize');
  assert.equal(zone.soil_type, 'Clay');
  assert.equal(zone.timezone, 'Europe/Zurich');
});

test('FA08 rejects a late invalid field without partially applying earlier zone fields', async () => {
  bridge(new Simulator({mode: 'public'}));
  const before = (await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)!;
  await assert.rejects(irrigationZonesAPI.updateConfig(1, {areaM2: 250, irrigationEfficiencyPct: 0}));
  const after = (await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)!;
  assert.equal(after.area_m2, before.area_m2);
  assert.equal(after.updated_at, before.updated_at);
});

test('FA10 saves a fictional location without browser geolocation and reopens it in summaries', async () => {
  bridge(new Simulator({mode: 'public'}));
  await irrigationZonesAPI.setZoneLocation(1, {latitude: 46.8523, longitude: 9.5311});
  const summary = await environmentAPI.getSummary(1);
  assert.equal(summary.location?.latitude, 46.8523);
  assert.equal(summary.location?.longitude, 9.5311);
  assert.equal(summary.location?.source, 'zone');
});

test('FA04 rejects invalid names without changing the zone', async () => {
  bridge(new Simulator({mode: 'public'}));
  await assert.rejects(irrigationZonesAPI.rename(1, '  '));
  assert.equal((await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)?.name, 'Tomato plot');
});

test('FA09 changes delivered volume through the saved zone flow calibration', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  await irrigationZonesAPI.updateCalibration(1, {measuredFlowRateLpm: 12, measurementMethod: 'bucket'});
  await devicesAPI.controlValve('00000000000000D1', {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(sim.now + 62000);
  assert.equal(sim.outcomes[0].estimatedGrossLiters, 12);
  assert.equal(sim.outcomes[0].flowRateLpm, 12);
});
