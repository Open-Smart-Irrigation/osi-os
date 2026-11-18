import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accountLinkAPI, api, devicesAPI, networkAPI} from '../../src/services/api';
import {createDemoAdapter} from '../adapter';
import {Simulator} from '../model';

function install(sim: Simulator): void { api.defaults.adapter = createDemoAdapter(sim); }
const fixedEui = '00000000000000A1';

test('NE01 and NE02 location and radio revisions are device scoped and exact-base', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  assert.equal(await networkAPI.location(fixedEui), null);
  assert.deepEqual(await networkAPI.radio(fixedEui), {device_eui: fixedEui, source: 'unknown'});
  const at = new Date(sim.now).toISOString();
  const location = await networkAPI.saveLocation(fixedEui, {revision_uuid: '00000000-0000-4000-8000-000000000011', base_revision_uuid: null,
    values: {latitude: 0.3476, longitude: 32.5825, effectiveFrom: at, coordinateSource: 'manual'}});
  assert.equal(location.revisionNo, 1);
  assert.equal((await networkAPI.location(fixedEui))?.latitude, 0.3476);
  const radio = await networkAPI.saveRadio(fixedEui, {revision_uuid: '00000000-0000-4000-8000-000000000012', base_revision_uuid: null,
    values: {txPowerDbm: 14, antennaGainDbi: 2, feederLossDb: 1, effectiveFrom: at, configurationSource: 'manual'}});
  assert.equal(radio.revisionNo, 1);
  assert.equal((await networkAPI.radio(fixedEui))?.antennaGainDbi, 2);
  await assert.rejects(networkAPI.saveLocation(fixedEui, {revision_uuid: '00000000-0000-4000-8000-000000000013', base_revision_uuid: null,
    values: {latitude: 1, longitude: 2, effectiveFrom: at}}), (error: any) => error.response?.status === 409);
  assert.equal((await networkAPI.location(fixedEui))?.revisionUuid, location.revisionUuid);
  await assert.rejects(networkAPI.saveRadio(fixedEui, {revision_uuid: '00000000-0000-4000-8000-000000000014', base_revision_uuid: radio.revisionUuid,
    values: {antennaGainDbi: 14, effectiveFrom: at}}), (error: any) => error.response?.status === 400);
  assert.equal((await networkAPI.radio(fixedEui))?.revisionUuid, radio.revisionUuid);
});

test('NE01/02 replay same revision idempotently and reject a changed UUID payload without mutation', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const beforeCount = (await accountLinkAPI.getSyncState()).pendingOutboxCount;
  const at = new Date(sim.now).toISOString();
  const body = {revision_uuid: '00000000-0000-4000-8000-000000000021', base_revision_uuid: null,
    values: {latitude: 0.3476, longitude: 32.5825, effectiveFrom: at, coordinateSource: 'manual'}};
  const created = await sim.requestResponse('PUT', `/api/devices/${fixedEui}/installation-location`, body);
  assert.equal(created.status, 201);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, beforeCount + 1);
  const replay = await sim.requestResponse('PUT', `/api/devices/${fixedEui}/installation-location`, body);
  assert.equal(replay.status, 200);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, beforeCount + 1);
  await assert.rejects(networkAPI.saveLocation(fixedEui, {...body, values: {...body.values, latitude: 0.4}}),
    (error: any) => error.response?.status === 409 && /revision UUID payload mismatch/.test(error.response?.data?.error));
  assert.equal((await networkAPI.location(fixedEui))?.latitude, 0.3476);
});

test('NE03 observations use stable filtered windows and native bounded offset pages', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const first = await networkAPI.observations(2, 0, {hours: 24});
  assert.equal(first.rows.length, 2);
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 2);
  assert.ok(first.rows.every(row => /^[0-9A-F]{16}$/.test(row.deveui) && row.recorded_at <= first.to && row.recorded_at >= first.from));
  const second = await networkAPI.observations(2, first.nextOffset!, {from: first.from, to: first.to});
  assert.equal(second.from, first.from);
  assert.equal(second.to, first.to);
  assert.notEqual(second.rows[0]?.id, first.rows[0]?.id);
  const capped = await networkAPI.observations(5000, 0, {hours: 720});
  assert.ok(capped.rows.length <= 5000);
  await assert.rejects(networkAPI.observations(10, 0, {from: 'invalid', to: first.to}), (error: any) => error.response?.status === 400);
});

test('NE02 write head follows revision number while reads follow effective time and UUID identity is table-wide', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const today = new Date(sim.now).toISOString(), yesterday = new Date(sim.now - 86400000).toISOString();
  const r1 = await networkAPI.saveLocation(fixedEui, {revision_uuid: '00000000-0000-4000-8000-000000000031', base_revision_uuid: null,
    values: {latitude: 0.3, longitude: 32.5, effectiveFrom: today}});
  const r2 = await networkAPI.saveLocation(fixedEui, {revision_uuid: '00000000-0000-4000-8000-000000000032', base_revision_uuid: r1.revisionUuid,
    values: {latitude: 0.31, longitude: 32.51, effectiveFrom: yesterday}});
  const r3 = await networkAPI.saveLocation(fixedEui, {revision_uuid: '00000000-0000-4000-8000-000000000033', base_revision_uuid: r2.revisionUuid,
    values: {latitude: 0.32, longitude: 32.52, effectiveFrom: yesterday}});
  assert.equal(r3.revisionNo, 3);
  assert.equal((await networkAPI.location(fixedEui))?.revisionUuid, r1.revisionUuid);
  const other = '00000000000001A1';
  await devicesAPI.add({deveui: other, name: 'Radio identity probe', type_id: 'KIWI_SENSOR', zone_id: 1});
  const beforeOutbox = (await accountLinkAPI.getSyncState()).pendingOutboxCount;
  await assert.rejects(networkAPI.saveLocation(other, {revision_uuid: r1.revisionUuid, base_revision_uuid: null,
    values: {latitude: 1, longitude: 2, effectiveFrom: today}}),
  (error: any) => error.response?.status === 409 && /payload mismatch/.test(error.response?.data?.error));
  assert.equal((await networkAPI.location(other)), null);
  assert.equal((await accountLinkAPI.getSyncState()).pendingOutboxCount, beforeOutbox);
});

test('NE03 real Axios array params filter canonical EUIs and reject invalid requested identities', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const first = await api.get<{rows: Array<{deveui: string}>}>('/api/network/observations', {params: {deviceEuis: [fixedEui], hours: 24}});
  assert.ok(first.data.rows.length > 0);
  assert.ok(first.data.rows.every(row => row.deveui === fixedEui));
  await assert.rejects(api.get('/api/network/observations', {params: {deviceEuis: ['bad-eui'], hours: 24}}),
    (error: any) => error.response?.status === 400);
});

test('NE03 numeric observation identities distinguish full canonical EUI and remain stable across refresh and paging', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const secondEui = '00000000000001A1';
  await devicesAPI.add({deveui: secondEui, name: 'Same suffix probe', type_id: 'KIWI_SENSOR', zone_id: 1});
  const query = () => api.get<{rows: Array<{id: number; deveui: string; recorded_at: string}>; from: string; to: string}>(
    '/api/network/observations', {params: {hours: 24, limit: 500}}).then(response => response.data);
  const first = await query(), refresh = await query();
  const paired = first.rows.filter(row => row.recorded_at === new Date(sim.now).toISOString()
    && [fixedEui, secondEui].includes(row.deveui));
  assert.equal(paired.length, 2);
  assert.notEqual(paired[0]?.id, paired[1]?.id);
  const refreshed = refresh.rows.filter(row => [fixedEui, secondEui].includes(row.deveui)
    && row.recorded_at === new Date(sim.now).toISOString());
  assert.deepEqual(refreshed.map(row => [row.deveui, row.id]).sort(), paired.map(row => [row.deveui, row.id]).sort());
  assert.equal(new Set(first.rows.map(row => row.id)).size, first.rows.length);
  const page = await api.get<{rows: Array<{id: number}>}>('/api/network/observations',
    {params: {from: first.from, to: first.to, limit: 500, offset: 0}});
  assert.deepEqual(page.data.rows.map(row => row.id), first.rows.map(row => row.id));
});
