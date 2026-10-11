import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AxiosAdapter, AxiosResponse} from 'axios';
import {api, devicesAPI, irrigationZonesAPI, s2120API, lsn50API, kiwiAPI, deviceMetadataAPI, fetchSdi12Profiles,
  putSdi12Config, postSdi12Identify, postSdi12RecipeApply, postSdi12RecipeRollback, dendroAnalyticsAPI, sensorAPI,
  valvesAPI} from '../../src/services/api';
import {Simulator, SPARE_EUI, VALVE_EUI} from '../model';
import {convertWatermarkChannel} from '../model/watermark';

function bridge(sim: Simulator): void {
  const adapter: AxiosAdapter = async config => {
    const url = new URL(config.url ?? '', 'http://simulator.test');
    for (const [key, value] of Object.entries(config.params ?? {})) if (value != null) url.searchParams.set(key, String(value));
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {};
    const data = sim.request(config.method ?? 'GET', `${url.pathname}${url.search}`, body);
    return {data, status: 200, statusText: 'OK', headers: {}, config} as AxiosResponse;
  };
  api.defaults.adapter = adapter;
}

test('DV18 uses the source-pinned watermark resistor sweep vector', () => {
  const result = convertWatermarkChannel(800, 3291, 19.88, {pullup_1_ohm: 41670, pulldown_1_ohm: 41260,
    series_fwd_1_ohm: 130, series_rev_1_ohm: 112}, 1);
  assert.equal(result.r_solved, 9977);
  assert.equal(result.kpa, 56.4);
  assert.equal(result.status, 'ok');
});

test('DV01 and DV02 expose and register every offered catalogue type', async () => {
  bridge(new Simulator({mode: 'public'}));
  const catalogue = await devicesAPI.getCatalog();
  assert.equal(catalogue.length, 9);
  for (const [index, item] of catalogue.entries()) {
    const eui = `00000000000000B${index.toString(16).toUpperCase()}`;
    const device = await devicesAPI.add({deveui: eui, name: `Fictional ${item.id}`, type_id: item.id});
    assert.equal(device.type_id, item.id);
    assert.equal((await devicesAPI.getAll()).find(row => row.deveui === eui)?.type_id, item.id);
  }
});

test('presentation keeps its original Kiwi-only registration catalogue', async () => {
  bridge(new Simulator());
  assert.deepEqual((await devicesAPI.getCatalog()).map(item => item.id), ['KIWI_SENSOR']);
  const kiwi = await devicesAPI.add({deveui: 'AABBCCDDEEFF0011', name: 'Presentation Kiwi', type_id: 'KIWI_SENSOR'});
  assert.equal(kiwi.type_id, 'KIWI_SENSOR');
});

test('DV02 rejects duplicate identifiers but allows duplicate display names', async () => {
  bridge(new Simulator({mode: 'public'}));
  await devicesAPI.add({deveui: '00000000000000B1', name: 'Repeated label', type_id: 'KIWI_SENSOR'});
  await devicesAPI.add({deveui: '00000000000000B2', name: 'Repeated label', type_id: 'TEKTELIC_CLOVER', zone_id: 1});
  await assert.rejects(devicesAPI.add({deveui: '00000000000000B1', name: 'Other label', type_id: 'KIWI_SENSOR'}));
  assert.equal((await devicesAPI.getAll()).filter(device => device.name === 'Repeated label').length, 2);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === '00000000000000B2')?.irrigation_zone_id, 1);
});

test('DV02 accepts canonical full hex EUIs and preserves selected Strega generation without keeping AppKeys', async () => {
  bridge(new Simulator({mode: 'public'}));
  const eui = 'AABBCCDDEEFF0001';
  const added = await devicesAPI.add({deveui: eui.toLowerCase(), name: 'GEN2 valve', type_id: 'STREGA_VALVE',
    strega_generation: 'GEN2', appkey: 'AABBCCDDEEFF00112233445566778899'});
  assert.equal(added.deveui, eui);
  assert.equal(added.strega_generation, 'GEN2');
  assert.equal(Object.hasOwn(added, 'appkey'), false);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === eui)?.strega_generation, 'GEN2');
  assert.equal((await valvesAPI.list()).find(valve => valve.deviceEui === eui)?.stregaGeneration, 'GEN2');
});

test('DV07 returns the saved soil depths immediately and treats zero or blank as disconnected channels', async () => {
  bridge(new Simulator({mode: 'public'}));
  const eui = '00000000000000B9';
  await devicesAPI.add({deveui: eui, name: 'Depth settings Kiwi', type_id: 'KIWI_SENSOR'});
  const saved = await deviceMetadataAPI.setSoilMoistureDepths(eui, {swt_1: 25, swt_2: 0});
  assert.equal(saved.soil_moisture_probe_depths_json?.swt_1, 25);
  assert.equal(saved.soil_moisture_probe_depths_json?.swt_2, 0);
  assert.equal(saved.soilMoistureProbeDepths?.swt_1, 25);
  assert.equal(saved.soilMoistureProbeDepths?.swt_2, undefined);
  const readBack = (await devicesAPI.getAll()).find(device => device.deveui === eui)!;
  assert.equal(readBack.soil_moisture_probe_depths_json?.swt_1, 25);
  assert.equal(readBack.soil_moisture_probe_depths_json?.swt_2, 0);
  const cleared = await deviceMetadataAPI.setSoilMoistureDepths(eui, {});
  assert.deepEqual(cleared.soil_moisture_probe_depths_json, {});
  assert.deepEqual((await devicesAPI.getAll()).find(device => device.deveui === eui)?.soil_moisture_probe_depths_json, {});
});

test('DV05-DV06 and DV10-DV12 accept native interval and warm-up limits while rejecting values outside them', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const kiwiEui = '00000000000000B9';
  const kiwi = await devicesAPI.add({deveui: kiwiEui, name: 'Boundary Kiwi', type_id: 'KIWI_SENSOR'});
  assert.equal(kiwi.temp_humidity_enabled, 0);
  assert.equal(kiwi.latest_data.ambient_temperature, undefined);
  assert.equal(kiwi.latest_data.relative_humidity, undefined);
  assert.equal((await sensorAPI.getHistory(kiwiEui, 'ambient_temperature', 12)).length, 0);
  await kiwiAPI.setUplinkInterval(kiwiEui, 1440);
  await kiwiAPI.enableTemperatureHumidity(kiwiEui, 1440);
  await assert.rejects(kiwiAPI.setUplinkInterval(kiwiEui, 1441));
  await assert.rejects(kiwiAPI.enableTemperatureHumidity(kiwiEui, 0));
  sim.advanceTo(sim.now + 2000);
  const configuredKiwi = (await devicesAPI.getAll()).find(device => device.deveui === kiwiEui)!;
  assert.equal(configuredKiwi.uplink_interval_minutes, 1440);
  assert.equal(configuredKiwi.temp_humidity_interval_minutes, 1440);
  assert.equal(configuredKiwi.temp_humidity_enabled, 1);
  assert.equal(configuredKiwi.requested_uplink_interval_minutes, 1440);
  assert.equal(configuredKiwi.latest_data.ambient_temperature, undefined, 'ACK changes configuration, not an unsent reading');
  sim.advanceTo(sim.now + 24 * 60 * 60 * 1000);
  const enabledKiwi = (await devicesAPI.getAll()).find(device => device.deveui === kiwiEui)!;
  assert.equal(typeof enabledKiwi.latest_data.ambient_temperature, 'number');
  assert.equal(typeof enabledKiwi.latest_data.relative_humidity, 'number');

  const lsnEui = '00000000000000BA';
  await devicesAPI.add({deveui: lsnEui, name: 'Boundary LSN', type_id: 'DRAGINO_LSN50'});
  await lsn50API.setUplinkInterval(lsnEui, 279620);
  await lsn50API.setFiveVoltWarmup(lsnEui, 65535);
  await assert.rejects(lsn50API.setUplinkInterval(lsnEui, 279621));
  await assert.rejects(lsn50API.setFiveVoltWarmup(lsnEui, 65536));
  sim.advanceTo(sim.now + 2000);
  const configuredLsn = (await devicesAPI.getAll()).find(device => device.deveui === lsnEui)!;
  assert.equal(configuredLsn.uplink_interval_minutes, 279620);
  assert.equal(configuredLsn.five_volt_warmup_ms, 65535);
  const priorSeen = configuredLsn.last_seen;
  sim.advanceTo(sim.now + 60 * 60 * 1000);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === lsnEui)?.last_seen, priorSeen,
    'the applied long LSN interval is used for future sampling');
});

test('DV05-DV06 and DV10-DV12 accept maximum native values and reject one above each limit', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const kiwiEui = '00000000000000BB';
  await devicesAPI.add({deveui: kiwiEui, name: 'Max Kiwi', type_id: 'KIWI_SENSOR'});
  await kiwiAPI.setUplinkInterval(kiwiEui, 1);
  await kiwiAPI.enableTemperatureHumidity(kiwiEui, 1);
  await assert.doesNotReject(kiwiAPI.setUplinkInterval(kiwiEui, 1440));
  await assert.doesNotReject(kiwiAPI.enableTemperatureHumidity(kiwiEui, 1440));
  await assert.rejects(kiwiAPI.setUplinkInterval(kiwiEui, 1441));
  await assert.rejects(kiwiAPI.enableTemperatureHumidity(kiwiEui, 1441));
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === kiwiEui)?.requested_uplink_interval_minutes, 1440);
  sim.advanceTo(sim.now + 2000);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === kiwiEui)?.uplink_interval_minutes, 1440);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === kiwiEui)?.temp_humidity_interval_minutes, 1440);

  const lsnEui = '00000000000000BC';
  await devicesAPI.add({deveui: lsnEui, name: 'Max LSN', type_id: 'DRAGINO_LSN50'});
  await lsn50API.setUplinkInterval(lsnEui, 1);
  await lsn50API.setFiveVoltWarmup(lsnEui, 0);
  await assert.doesNotReject(lsn50API.setUplinkInterval(lsnEui, 279620));
  await assert.doesNotReject(lsn50API.setFiveVoltWarmup(lsnEui, 65535));
  await assert.rejects(lsn50API.setUplinkInterval(lsnEui, 279621));
  await assert.rejects(lsn50API.setFiveVoltWarmup(lsnEui, 65536));
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === lsnEui)?.requested_uplink_interval_minutes, 279620);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === lsnEui)?.five_volt_warmup_ms, undefined);
  sim.advanceTo(sim.now + 2000);
  const savedLsn = (await devicesAPI.getAll()).find(device => device.deveui === lsnEui)!;
  assert.equal(savedLsn.uplink_interval_minutes, 279620);
  assert.equal(savedLsn.five_volt_warmup_ms, 65535);
  const cadenceEui = '00000000000000BD';
  await devicesAPI.add({deveui: cadenceEui, name: 'One minute LSN', type_id: 'DRAGINO_LSN50'});
  await lsn50API.setUplinkInterval(cadenceEui, 1);
  sim.advanceTo(sim.now + 2000);
  const beforeCadenceSample = (await devicesAPI.getAll()).find(device => device.deveui === cadenceEui)!.last_seen;
  sim.advanceTo(sim.now + 60 * 1000);
  assert.notEqual((await devicesAPI.getAll()).find(device => device.deveui === cadenceEui)!.last_seen, beforeCadenceSample);
});

test('DV08-DV09 enable, mode, interval, and sensor flags control future LSN50 channels', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const eui = '00000000000000BE';
  await devicesAPI.add({deveui: eui, name: 'Mode-specific LSN', type_id: 'DRAGINO_LSN50'});
  await lsn50API.setMode(eui, 'MOD1');
  await lsn50API.setTempEnabled(eui, true);
  await lsn50API.setRainGaugeEnabled(eui, false);
  await lsn50API.setFlowMeterEnabled(eui, false);
  await lsn50API.setChameleonEnabled(eui, false);
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  let sample = sim.readings.latestSample(eui)!.values;
  assert.equal(typeof sample.ext_temperature_c, 'number');
  assert.equal(sample.rain_mm_delta, undefined);
  assert.equal(sample.flow_liters_delta, undefined);
  assert.equal(sample.swt_1, undefined);
  for (const hours of [12, 24, 168, 720, 2160]) {
    const rows = await sensorAPI.getHistory(eui, 'ext_temperature_c', hours);
    assert.ok(rows.length > 0 && rows.every(row => Number.isFinite(row.value)), `MOD1/ext_temperature_c/${hours}h`);
  }
  assert.ok((await sensorAPI.getHistory(eui, 'rain_mm_delta', 12)).length > 0,
    'historical readings from the earlier MOD9 profile remain in the ledger');

  await lsn50API.setMode(eui, 'MOD9');
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  sample = sim.readings.latestSample(eui)!.values;
  assert.equal(sample.ext_temperature_c, undefined);
  assert.equal(sample.rain_mm_delta, undefined);
  assert.equal(sample.flow_liters_delta, undefined);

  await lsn50API.setRainGaugeEnabled(eui, true);
  await lsn50API.setFlowMeterEnabled(eui, true);
  await lsn50API.setUplinkInterval(eui, 1);
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 60 * 1000);
  sample = sim.readings.latestSample(eui)!.values;
  assert.equal(typeof sample.rain_mm_delta, 'number');
  assert.equal(typeof sample.flow_liters_delta, 'number');
  for (const field of ['rain_mm_delta','flow_liters_delta']) for (const hours of [12, 24, 168, 720, 2160]) {
    const rows = await sensorAPI.getHistory(eui, field, hours);
    assert.ok(rows.length > 0 && rows.every(row => Number.isFinite(row.value)), `MOD9/${field}/${hours}h`);
  }
});

test('DV05-DV16 apply native settings after ACK and change sampling cadence and selected LSN50 channels', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const eui = '00000000000000C8';
  await devicesAPI.add({deveui: eui, name: 'Configurable Kiwi', type_id: 'KIWI_SENSOR'});
  const before = (await devicesAPI.getAll()).find(device => device.deveui === eui)!;
  const createdAt = before.last_seen;
  await kiwiAPI.setUplinkInterval(eui, 20);
  await kiwiAPI.enableTemperatureHumidity(eui, 15);
  assert.equal(sim.devices.find(device => device.deveui === eui)?.uplink_interval_minutes, before.uplink_interval_minutes);
  assert.equal(sim.devices.find(device => device.deveui === eui)?.temp_humidity_enabled, 0);
  sim.advanceTo(sim.now + 2000);
  assert.equal(sim.devices.find(device => device.deveui === eui)?.uplink_interval_minutes, 20);
  assert.equal(sim.devices.find(device => device.deveui === eui)?.temp_humidity_interval_minutes, 15);
  sim.advanceTo(sim.now + 20 * 60 * 1000);
  const sampledKiwi = (await devicesAPI.getAll()).find(device => device.deveui === eui)!;
  assert.notEqual(sampledKiwi.last_seen, createdAt);
  assert.equal(typeof sampledKiwi.latest_data.ambient_temperature, 'number');
  assert.equal(typeof sampledKiwi.latest_data.relative_humidity, 'number');

  const lsn = (await devicesAPI.getAll()).find(device => device.type_id === 'DRAGINO_LSN50')!;
  await lsn50API.setMode(lsn.deveui, 'MOD3');
  await lsn50API.setChameleonEnabled(lsn.deveui, true);
  sim.advanceTo(sim.now + 2000);
  const configured = (await devicesAPI.getAll()).find(device => device.deveui === lsn.deveui)!;
  assert.equal(configured.latest_data.lsn50_mode_label, 'MOD3');
  assert.equal(configured.device_mode, 3);
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  const latest = (await devicesAPI.getAll()).find(device => device.deveui === lsn.deveui)!.latest_data;
  assert.ok(typeof latest.adc_ch0v === 'number' && typeof latest.adc_ch1v === 'number');
  assert.ok(typeof latest.swt_1 === 'number' && typeof latest.swt_2 === 'number' && typeof latest.swt_3 === 'number');
  assert.equal(latest.rain_mm_delta, undefined);
});

test('DV17-DV20 watermark preview uses submitted coefficients; save backfills and delete affects future frames only', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const eui = '00000000000000E5';
  const seeded = await devicesAPI.getAll();
  assert.equal(seeded.find(device => device.deveui === eui)?.name, 'Bed Watermark demonstration');
  assert.ok(seeded.find(device => device.deveui === eui)?.latest_data.watermark);
  assert.equal(seeded.find(device => device.deveui === '00000000000000E3')?.latest_data.watermark, undefined);
  const first = {pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
    pullup_2_ohm: 41670, pulldown_2_ohm: 41260, series_fwd_2_ohm: 130, series_rev_2_ohm: 112};
  const second = {...first, pullup_1_ohm: 50000, pulldown_1_ohm: 50000};
  const previewA = await lsn50API.previewWatermarkCalibration(eui, first);
  const previewB = await lsn50API.previewWatermarkCalibration(eui, second);
  assert.notDeepEqual(previewA.preview?.channels.map(channel => channel.r_solved), previewB.preview?.channels.map(channel => channel.r_solved));
  assert.equal((await lsn50API.getWatermarkCalibration(eui)).sync_version, 0);
  const saved = await lsn50API.saveWatermarkCalibration(eui, first, 0);
  assert.ok(saved.backfilled > 0);
  const convertedBeforeDelete = sim.readings.forDevice(eui).filter(sample => typeof sample.values.watermark_ch1_kpa === 'number').length;
  assert.ok(convertedBeforeDelete > 0);
  await lsn50API.deleteWatermarkCalibration(eui, saved.sync_version);
  const convertedAfterDelete = sim.readings.forDevice(eui).filter(sample => typeof sample.values.watermark_ch1_kpa === 'number').length;
  assert.equal(convertedAfterDelete, convertedBeforeDelete);
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  assert.equal(sim.readings.latestSample(eui)?.values.watermark_ch1_status, 'calibration_required');
});

test('RD01 covers displayed chart series and every monitor window for seeded and new catalogue devices', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const catalogue = await devicesAPI.getCatalog();
  const newDevices = [];
  for (const [index, item] of catalogue.entries()) {
    newDevices.push(await devicesAPI.add({deveui: `00000000000000B${index.toString(16).toUpperCase()}`, name: `History ${item.id}`, type_id: item.id}));
  }
  const channelsFor = (device: Awaited<ReturnType<typeof devicesAPI.getAll>>[number]): string[] => {
    if (device.type_id === 'KIWI_SENSOR') return ['swt_1','swt_2','swt_3','light_lux',
      ...(device.temp_humidity_enabled === 1 || device.deveui.endsWith('A1') || device.deveui.endsWith('A2') ? ['ambient_temperature','relative_humidity'] : [])];
    if (device.type_id === 'TEKTELIC_CLOVER') return ['swt_1','swt_2','ambient_temperature','relative_humidity','light_lux'];
    if (device.type_id === 'STREGA_VALVE') return ['valve_state'];
    if (device.type_id === 'DRAGINO_LSN50') {
      const mode = Number(device.device_mode ?? device.lsn50_mode_code ?? 9);
      return [...(mode === 9 && device.rain_gauge_enabled === 1 ? ['rain_mm_delta'] : []),
        ...(mode === 9 && device.flow_meter_enabled === 1 ? ['flow_liters_delta'] : []),
        ...(mode === 3 && device.chameleon_enabled === 1 ? ['adc_ch0v','adc_ch1v','swt_1','swt_2','swt_3'] : []),
        ...(mode === 1 && device.temp_enabled === 1 ? ['ext_temperature_c'] : []),
        ...(device.dendro_enabled === 1 && (mode === 1 || mode === 3) ? ['dendro_position_mm','dendro_stem_change_um'] : [])];
    }
    if (device.type_id === 'SENSECAP_S2120') return ['ambient_temperature','relative_humidity','wind_speed_mps','wind_gust_mps','wind_direction_deg','rain_mm_delta','barometric_pressure_hpa'];
    if (device.type_id === 'AQUASCOPE_LORAIN') return ['rain_mm_delta','rain_mm_today','rain_gauge_cumulative_mm'];
    if (device.type_id === 'MILESIGHT_UC512') return ['bat_pct','ext_temperature_c'];
    if (device.type_id === 'RAK10701_FIELD_TESTER') return ['bat_pct','rssi','snr'];
    const profile = device.sdi12_probe_profile ?? 'GENERIC_VWC';
    if (profile === 'SENTEK_ENVIROSCAN') return (device.sdi12_channel_layout_json?.sensors ?? []).flatMap(sensor => [`vwc_${sensor.channel}`, ...(sensor.type === 'TRISCAN' ? [`soil_vic_${sensor.channel}`] : [])]);
    if (profile === 'HYDRASCOUT') return ['vwc_1','soil_temp_1','soil_ec_1','vwc_2','soil_temp_2','soil_ec_2'];
    if (profile === 'TENSIOMARK') return ['swt_1','soil_temp_1'];
    if (profile === 'IMKO_PICO64') return ['vwc_1','soil_temp_1'];
    const count = Math.max(1, Math.min(8, Number(device.sdi12_value_count) || 2));
    return Array.from({length: count}, (_, index) => `vwc_${index + 1}`);
  };
  const windows = [12, 24, 168, 720, 2160];
  for (const device of [...(await devicesAPI.getAll()), ...newDevices]) {
    const offered = channelsFor(device);
    for (const field of offered) for (const hours of windows) {
      const rows = await sensorAPI.getHistory(device.deveui, field, hours);
      assert.ok(rows.length > 0, `${device.type_id}/${field}/${hours}h`);
      assert.ok(rows.every(row => typeof row.t === 'string' && Number.isFinite(row.value)), `${device.type_id}/${field}/${hours}h values`);
    }
  }
  sim.advanceTo(sim.now + 30 * 60 * 1000);
});

test('RD01 derives every SDI-12 profile series from the profile contract across all chart windows', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const cases = [
    {profile: 'GENERIC_VWC', config: {value_count: 4, depths: {vwc_1: 10, vwc_2: 20, vwc_3: 30, vwc_4: 40}}, channels: ['vwc_1','vwc_2','vwc_3','vwc_4']},
    {profile: 'SENTEK_ENVIROSCAN', config: {address: 'L', sensors: [
      {channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN'},
      {channel: 3, response_position: 2, depth_cm: 30, type: 'TRISCAN'}]}, channels: ['vwc_1','vwc_3','soil_vic_3']},
    {profile: 'DELTAT_PR2_4', config: {value_count: 4}, channels: ['vwc_1','vwc_2','vwc_3','vwc_4']},
    {profile: 'DELTAT_PR2_6', config: {value_count: 6}, channels: ['vwc_1','vwc_2','vwc_3','vwc_4','vwc_5','vwc_6']},
    {profile: 'TENSIOMARK', config: {value_count: 2}, channels: ['swt_1','soil_temp_1']},
    {profile: 'IMKO_PICO64', config: {value_count: 2}, channels: ['vwc_1','soil_temp_1']},
    {profile: 'HYDRASCOUT', config: {value_count: 6}, channels: ['vwc_1','soil_temp_1','soil_ec_1','vwc_2','soil_temp_2','soil_ec_2']},
  ] as const;
  const allPossibleChannels = ['vwc_1','vwc_2','vwc_3','vwc_4','vwc_5','vwc_6','vwc_7','vwc_8',
    'soil_vic_1','soil_vic_2','soil_vic_3','soil_vic_4','soil_vic_5','soil_vic_6','soil_vic_7','soil_vic_8','soil_vic_9','soil_vic_10',
    'soil_temp_1','soil_temp_2','soil_temp_3','soil_temp_4','soil_temp_5','soil_temp_6','soil_temp_7','soil_temp_8',
    'soil_ec_1','soil_ec_2','soil_ec_3','soil_ec_4','soil_ec_5','soil_ec_6','soil_ec_7','soil_ec_8','swt_1','swt_2','swt_3'];
  const windows = [12, 24, 168, 720, 2160];
  for (const [index, item] of cases.entries()) {
    const eui = `00000000000000C${index.toString(16).toUpperCase()}`;
    await devicesAPI.add({deveui: eui, name: `${item.profile} history`, type_id: 'DRAGINO_SDI12'});
    await putSdi12Config(eui, {probe_profile: item.profile, ...item.config});
    sim.advanceTo(sim.now + 30 * 60 * 1000);
    const latest = sim.readings.latestSample(eui)!.values;
    for (const field of item.channels) assert.equal(typeof latest[field], 'number', `${item.profile}/${field} is generated`);
    for (const field of allPossibleChannels.filter(channel => !item.channels.includes(channel))) {
      assert.equal(latest[field], undefined, `${item.profile}/${field} is not offered`);
    }
    for (const field of item.channels) for (const hours of windows) {
      const rows = await sensorAPI.getHistory(eui, field, hours);
      assert.ok(rows.length > 0, `${item.profile}/${field}/${hours}h`);
      assert.ok(rows.every(row => Number.isFinite(row.value)), `${item.profile}/${field}/${hours}h values`);
    }
  }
});

test('DV04 removes all devices and stops an active valve without losing its completed record', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  await devicesAPI.controlValve(VALVE_EUI, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advanceTo(sim.now + 2000);
  await devicesAPI.remove(VALVE_EUI);
  assert.equal((await devicesAPI.getAll()).some(device => device.deveui === VALVE_EUI), false);
  assert.equal(sim.outcomes[0]?.status, 'CANCELLED');
  assert.ok(sim.readings.forDevice(VALVE_EUI).length > 0);
  const lsn = sim.devices.find(device => device.deveui === '00000000000000E3')!;
  const originalMode = lsn.lsn50_mode;
  await lsn50API.setMode(lsn.deveui, 'MOD9');
  await lsn50API.refreshChameleonCalibration(lsn.deveui);
  sim.reset();
  assert.equal(sim.clock.ids().some(id => id.startsWith(`lsn50-mode-ack:${lsn.deveui}`) || id.startsWith(`chameleon-calibration:${lsn.deveui}`)), false);
  assert.equal(sim.devices.find(device => device.deveui === lsn.deveui)?.lsn50_mode, originalMode);
  const resetLsn = sim.devices.find(device => device.deveui === lsn.deveui)!;
  await lsn50API.setMode(resetLsn.deveui, 'MOD9');
  await lsn50API.refreshChameleonCalibration(resetLsn.deveui);
  await devicesAPI.remove(resetLsn.deveui);
  assert.equal(sim.clock.ids().some(id => id.includes(resetLsn.deveui)), false);
  for (const device of await devicesAPI.getAll()) await devicesAPI.remove(device.deveui);
  assert.deepEqual(await devicesAPI.getAll(), []);
  sim.reset();
  assert.ok((await devicesAPI.getAll()).length > 0);
  assert.equal(sim.outcomes.length, 0);
});

test('DV19 calibration saves a new version and remains readable', async () => {
  bridge(new Simulator({mode: 'public'}));
  const eui = '00000000000000B9';
  await devicesAPI.add({deveui: eui, name: 'Watermark demo', type_id: 'DRAGINO_LSN50'});
  const before = await lsn50API.getWatermarkCalibration(eui);
  assert.equal(before.sync_version, 0);
  const values = {pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
    pullup_2_ohm: 41670, pulldown_2_ohm: 41260, series_fwd_2_ohm: 130, series_rev_2_ohm: 112};
  const saved = await lsn50API.saveWatermarkCalibration(eui, values, before.sync_version);
  assert.equal(saved.sync_version, 1);
  assert.equal((await lsn50API.getWatermarkCalibration(eui)).sync_version, 1);
});

test('FA06 assignment and FA07 unassignment update native zone/device reads', async () => {
  bridge(new Simulator({mode: 'public'}));
  await irrigationZonesAPI.assignDevice(2, SPARE_EUI);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === SPARE_EUI)?.irrigation_zone_id, 2);
  await irrigationZonesAPI.removeDevice(2, SPARE_EUI);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === SPARE_EUI)?.irrigation_zone_id, null);
});

test('DV05-DV16 persist the native sensor settings in subsequent device reads', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const kiwi = await devicesAPI.getAll().then(rows => rows.find(row => row.type_id === 'KIWI_SENSOR')!);
  await kiwiAPI.setUplinkInterval(kiwi.deveui, 20);
  await kiwiAPI.enableTemperatureHumidity(kiwi.deveui, 15);
  await deviceMetadataAPI.setSoilMoistureDepths(kiwi.deveui, {swt_1: 25, swt_2: 50});
  const lsn = await devicesAPI.getAll().then(rows => rows.find(row => row.type_id === 'DRAGINO_LSN50')!);
  await lsn50API.setDendroEnabled(lsn.deveui, true);
  await lsn50API.setTempEnabled(lsn.deveui, true);
  await lsn50API.setRainGaugeEnabled(lsn.deveui, false);
  await lsn50API.setFlowMeterEnabled(lsn.deveui, false);
  await lsn50API.setChameleonEnabled(lsn.deveui, true);
  await lsn50API.setMode(lsn.deveui, 'MOD3');
  await lsn50API.setUplinkInterval(lsn.deveui, 30);
  await lsn50API.setInterruptMode(lsn.deveui, 1);
  await lsn50API.setFiveVoltWarmup(lsn.deveui, 5000);
  await lsn50API.setDendroConfig(lsn.deveui, {dendroForceLegacy: true, dendroStrokeMm: 12,
    dendroRatioAtRetracted: 0.4, dendroRatioAtExtended: 0.5});
  await lsn50API.setChameleonDepth(lsn.deveui, {chameleonSwt1DepthCm: 20});
  sim.advanceTo(sim.now + 2000);
  const after = await devicesAPI.getAll();
  const savedKiwi = after.find(row => row.deveui === kiwi.deveui)!;
  const savedLsn = after.find(row => row.deveui === lsn.deveui)!;
  assert.equal(savedKiwi.uplink_interval_minutes, 20);
  assert.equal(savedKiwi.soil_moisture_probe_depths_json?.swt_2, 50);
  assert.equal(savedLsn.lsn50_mode, 'MOD3');
  assert.equal(savedLsn.rain_gauge_enabled, 0);
  assert.equal(savedLsn.chameleon_swt1_depth_cm, 20);
  assert.equal(savedLsn.dendro_stroke_mm, 12);
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  assert.ok((await devicesAPI.getAll()).find(row => row.deveui === kiwi.deveui)?.last_seen);
  const beforeBaseline = sim.readings.latestSample(lsn.deveui)!.values;
  assert.equal(typeof beforeBaseline.dendro_position_raw_mm, 'number');
  const historyBeforeReset = sim.readings.forDevice(lsn.deveui);
  await lsn50API.resetDendroBaseline(lsn.deveui);
  const resetDevice = (await devicesAPI.getAll()).find(row => row.deveui === lsn.deveui)! as typeof lsn & {
    dendro_baseline_position_mm?: number | null;
    dendro_baseline_mode_used?: string | null;
    dendro_baseline_calibration_signature?: string | null;
    dendro_baseline_pending?: number | null;
    dendro_baseline_at?: string | null;
  };
  assert.equal(resetDevice.dendro_baseline_pending, 1);
  assert.equal(resetDevice.dendro_baseline_position_mm, null);
  assert.equal(resetDevice.dendro_baseline_mode_used, null);
  assert.equal(resetDevice.dendro_baseline_calibration_signature, null);
  assert.equal(resetDevice.dendro_baseline_at, null);
  assert.deepEqual(sim.readings.forDevice(lsn.deveui), historyBeforeReset,
    'local reset clears only current baseline state and leaves recorded readings untouched');
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  const firstAfterReset = sim.readings.latestSample(lsn.deveui)!.values;
  const firstRawAfterReset = firstAfterReset.dendro_position_raw_mm;
  const establishedDevice = (await devicesAPI.getAll()).find(row => row.deveui === lsn.deveui)! as typeof resetDevice;
  assert.equal(typeof firstRawAfterReset, 'number');
  assert.equal(firstAfterReset.dendro_stem_change_um, 0);
  assert.equal(establishedDevice.dendro_baseline_pending, 0);
  assert.equal(establishedDevice.dendro_baseline_position_mm, firstRawAfterReset);
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  const lsnValues = sim.readings.latestSample(lsn.deveui)!.values;
  assert.notEqual(lsnValues.dendro_position_mm, lsnValues.dendro_position_raw_mm);
  assert.ok(typeof lsnValues.adc_ch0v === 'number' && typeof lsnValues.swt_3 === 'number');
  assert.equal(lsnValues.dendro_stem_change_um,
    Math.round((Number(lsnValues.dendro_position_raw_mm) - Number(firstRawAfterReset)) * 1000));
});

test('DV15 known and unknown Chameleon calibrations report only fictional source states', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const known = (await devicesAPI.getAll()).find(device => device.deveui === '00000000000000E3')!;
  assert.ok(known.latest_data.chameleon_array_id, 'public seed exposes an applicable fictional known array');
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  const sampledKnown = (await devicesAPI.getAll()).find(device => device.deveui === known.deveui)!;
  assert.ok(sampledKnown.latest_data.sampled_at, 'routine sample ran before the calibration request');
  assert.ok(sampledKnown.latest_data.chameleon_array_id, 'routine samples preserve the fictional array identity');
  assert.equal((await lsn50API.refreshChameleonCalibration(known.deveui)).status, 'pending');
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === known.deveui)?.calibration_status, 'pending');
  sim.advanceTo(sim.now + 5000);
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === known.deveui)?.calibration_status, 'calibrated');
  const unknown = (await devicesAPI.getAll()).find(device => device.deveui === '00000000000000E4')!;
  assert.ok(unknown.latest_data.chameleon_array_id, 'public seed includes a nonempty unknown fixture ID');
  assert.equal((await lsn50API.refreshChameleonCalibration(unknown.deveui)).status, 'unknown');
});

test('DV22 rejects invalid Sentek response positions and depths before changing stored configuration', async () => {
  bridge(new Simulator({mode: 'public'}));
  const eui = '00000000000000B9';
  await devicesAPI.add({deveui: eui, name: 'Sentek validation node', type_id: 'DRAGINO_SDI12'});
  const valid = {probe_profile: 'SENTEK_ENVIROSCAN', address: 'L', value_count: 2, sensors: [
    {channel: 1, response_position: 1, depth_cm: 1, type: 'ENVIROSCAN'},
    {channel: 2, response_position: 2, depth_cm: 1000, type: 'TRISCAN'},
  ]};
  await putSdi12Config(eui, valid);
  const original = (await devicesAPI.getAll()).find(device => device.deveui === eui)!;
  const invalidCases = [
    {...valid, sensors: [valid.sensors[0], {...valid.sensors[1], response_position: 1}]},
    {...valid, sensors: [valid.sensors[0], {...valid.sensors[1], response_position: 3}]},
    {...valid, sensors: [valid.sensors[0], {...valid.sensors[1], depth_cm: 1}]},
    {...valid, sensors: [valid.sensors[0], {...valid.sensors[1], depth_cm: 1.5}]},
    {...valid, sensors: [valid.sensors[0], {...valid.sensors[1], depth_cm: 0}]},
    {...valid, sensors: [valid.sensors[0], {...valid.sensors[1], depth_cm: 1001}]},
    {...valid, sensors: [valid.sensors[0], {...valid.sensors[1], response_position: 1.5}]},
  ];
  for (const invalid of invalidCases) {
    await assert.rejects(putSdi12Config(eui, invalid));
    const current = (await devicesAPI.getAll()).find(device => device.deveui === eui)!;
    assert.deepEqual(current.sdi12_channel_layout_json, original.sdi12_channel_layout_json);
  }
});

test('DV17-DV20 preview is read-only; save and delete advance watermark calibration versions', async () => {
  bridge(new Simulator({mode: 'public'}));
  const eui = '00000000000000B9';
  await devicesAPI.add({deveui: eui, name: 'Watermark demo', type_id: 'DRAGINO_LSN50'});
  const values = {pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
    pullup_2_ohm: 41670, pulldown_2_ohm: 41260, series_fwd_2_ohm: 130, series_rev_2_ohm: 112};
  const before = await lsn50API.getWatermarkCalibration(eui);
  await lsn50API.previewWatermarkCalibration(eui, values);
  assert.equal((await lsn50API.getWatermarkCalibration(eui)).sync_version, before.sync_version);
  const saved = await lsn50API.saveWatermarkCalibration(eui, values, before.sync_version);
  assert.equal(saved.sync_version, 1);
  await assert.rejects(lsn50API.saveWatermarkCalibration(eui, values, 0));
  const deleted = await lsn50API.deleteWatermarkCalibration(eui, 1);
  assert.equal(deleted.sync_version, 2);
  assert.equal(deleted.calibration, null);
});

test('DV21-DV25 serve all source profiles and retain SDI-12 configuration and recipe deployment', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const profiles = await fetchSdi12Profiles();
  assert.deepEqual(profiles.profiles.map(profile => profile.id), ['GENERIC_VWC','SENTEK_ENVIROSCAN','DELTAT_PR2_4','DELTAT_PR2_6','TENSIOMARK','IMKO_PICO64','HYDRASCOUT']);
  assert.equal(profiles.profiles.find(profile => profile.id === 'DELTAT_PR2_4')?.provisional, true);
  const eui = '00000000000000B9';
  await devicesAPI.add({deveui: eui, name: 'SDI-12 node', type_id: 'DRAGINO_SDI12'});
  await putSdi12Config(eui, {probe_profile: 'TENSIOMARK', depths: {swt_1: 30}, value_count: 2, address: '0'});
  assert.equal((await devicesAPI.getAll()).find(row => row.deveui === eui)?.sdi12_probe_profile, 'TENSIOMARK');
  await postSdi12Identify(eui);
  sim.advanceTo(sim.now + 5000);
  assert.equal((await devicesAPI.getAll()).find(row => row.deveui === eui)?.sdi12_probe_status, 'identified');
  const prior = await postSdi12RecipeApply(eui);
  sim.advanceTo(sim.now + 2000);
  assert.equal((await devicesAPI.getAll()).find(row => row.deveui === eui)?.sdi12_recipe_deployment?.status, 'observed_compatible');
  const profileRows = await sensorAPI.getHistory(eui, 'vwc_1', 2160);
  assert.ok(profileRows.length > 0 && profileRows.some(row => row.value !== 25));
  assert.equal((await sensorAPI.getHistory(eui, 'soil_temp_1', 2160)).length, 0);
  await putSdi12Config(eui, {probe_profile: 'SENTEK_ENVIROSCAN', address: 'L', value_count: 3,
    sensors: [{channel: 1, response_position: 1, depth_cm: 20, type: 'ENVIROSCAN'},
      {channel: 3, response_position: 2, depth_cm: 40, type: 'TRISCAN'}]});
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  let sentek = sim.readings.latestSample(eui)!.values;
  assert.equal(typeof sentek.soil_vic_3, 'number');
  assert.equal((await postSdi12RecipeApply(eui))?.status, 'queueing');
  sim.advanceTo(sim.now + 2000);
  assert.equal((await devicesAPI.getAll()).find(row => row.deveui === eui)?.sdi12_recipe_deployment?.status, 'observed_compatible');
  await putSdi12Config(eui, {probe_profile: 'HYDRASCOUT', depths: {vwc_1: 15, vwc_2: 30}, value_count: 6, address: '0'});
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  assert.ok((await sensorAPI.getHistory(eui, 'soil_ec_2', 2160)).length > 0);
  const rollback = await postSdi12RecipeRollback(eui);
  assert.equal(rollback?.desired_version, prior?.desired_version);
  const afterRollback = (await devicesAPI.getAll()).find(row => row.deveui === eui)!;
  assert.equal(afterRollback.sdi12_probe_profile, 'SENTEK_ENVIROSCAN');
  assert.equal(afterRollback.sdi12_channel_layout_json?.sensors.length, 2);
  assert.ok((await sensorAPI.getHistory(eui, 'soil_ec_2', 2160)).length > 0, 'old rows remain in the shared ledger');
  sim.advanceTo(sim.now + 30 * 60 * 1000);
  sentek = sim.readings.latestSample(eui)!.values;
  assert.equal(typeof sentek.vwc_1, 'number');
  assert.equal(typeof sentek.vwc_3, 'number');
  assert.equal(typeof sentek.soil_vic_3, 'number');
  assert.equal(sentek.vwc_2, undefined);
  assert.equal(sentek.soil_ec_2, undefined);
});

test('DV26-DV27 station assignments and reference-tree designation re-read from device state', async () => {
  bridge(new Simulator({mode: 'public'}));
  const eui = '00000000000000F2';
  await s2120API.setZoneAssignments(eui, [1, 2]);
  assert.deepEqual(await s2120API.getZoneAssignments(eui), [{zone_id: 1, zone_name: 'Tomato plot'}, {zone_id: 2, zone_name: 'Demonstration bed'}]);
  await dendroAnalyticsAPI.setReferenceTree('00000000000000E3', true);
  assert.equal((await devicesAPI.getAll()).find(row => row.deveui === '00000000000000E3')?.is_reference_tree, 1);
});

test('DV26 deleting a zone removes its weather-station assignment while keeping remaining assignments useful', async () => {
  bridge(new Simulator({mode: 'public'}));
  const eui = '00000000000000F2';
  await s2120API.setZoneAssignments(eui, [1, 2]);
  await irrigationZonesAPI.delete(2);
  const assignments = await s2120API.getZoneAssignments(eui);
  assert.deepEqual(assignments.map(item => item.zone_id), [1]);
  assert.equal(assignments.some(item => item.zone_name == null), false);
  const remainingSummary = await api.get('/api/irrigation-zones/1/environment-summary');
  assert.equal(remainingSummary.data.generatedAt != null, true);
  assert.equal(typeof remainingSummary.data.water.rainTodayMm, 'number');
});
