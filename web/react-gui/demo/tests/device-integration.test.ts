import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import type {AxiosAdapter, AxiosResponse} from 'axios';
import {analysisAPI, api, devicesAPI, irrigationOutcomesAPI, irrigationZonesAPI, kiwiAPI, lsn50API, postSdi12RecipeApply, postSdi12RecipeRollback, putSdi12Config, networkAPI, s2120API, sensorAPI} from '../../src/services/api';
import {Simulator} from '../model';

const require = createRequire(import.meta.url);
const nativeDendro = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js') as {
  buildDendroDerivedMetrics(options: Record<string, unknown>): {
    positionRawMm: number | null; positionMm: number | null; dendroSaturated: number; dendroSaturationSide: string | null;
  };
};

function bridge(sim: Simulator): void {
  api.defaults.adapter = (async config => {
    const url = new URL(config.url ?? '', 'http://simulator.test');
    for (const [key, value] of Object.entries(config.params ?? {})) if (value != null) url.searchParams.set(key, String(value));
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {};
    const data = sim.request(config.method ?? 'GET', `${url.pathname}${url.search}`, body);
    return {data, status: 200, statusText: 'OK', headers: {}, config} as AxiosResponse;
  }) as AxiosAdapter;
}

const hasNoSoilMetadata = (device: Awaited<ReturnType<typeof devicesAPI.getAll>>[number]) => {
  assert.equal(device.soil_moisture_probe_depths_configured, undefined, `${device.type_id} has no copied depth-configured flag`);
  assert.equal(device.soil_moisture_probe_depths_json, undefined, `${device.type_id} has no copied probe depths`);
};

test('native seed exposes source-shaped current data while preserving the two legacy SWT anchors', async () => {
  bridge(new Simulator({mode: 'public'}));
  const devices = await devicesAPI.getAll();
  const byEui = (eui: string) => devices.find(device => device.deveui === eui)!;
  assert.deepEqual([byEui('00000000000000A1').latest_data.swt_1, byEui('00000000000000A1').latest_data.swt_2,
    byEui('00000000000000A1').latest_data.swt_3], [45, 50, 55]);
  assert.deepEqual([byEui('00000000000000A2').latest_data.swt_1, byEui('00000000000000A2').latest_data.swt_2,
    byEui('00000000000000A2').latest_data.swt_3], [10, 12, 14]);
  assert.equal(byEui('00000000000000F1').latest_data.swt_1, null);
  assert.equal(byEui('00000000000000F1').latest_data.swt_2, null);
  assert.equal(byEui('00000000000000F1').latest_data.swt_3, null);
  assert.equal(typeof byEui('00000000000000F1').latest_data.bat_pct, 'number', 'seeded Clover keeps its supplied health channel');
  assert.equal(byEui('00000000000000F1').latest_data.swt_wm1, null);
  assert.equal(byEui('00000000000000F4').latest_data.ext_temperature_c, undefined);
  assert.equal(byEui('00000000000000F4').latest_data.pipe_pressure_kpa, 220);
  assert.equal(byEui('00000000000000F4').latest_data.valve_1_state, 'close');
  assert.equal(byEui('00000000000000F4').latest_data.valve_2_state, 'close');
  assert.equal(byEui('00000000000000F5').sdi12_probe_profile, 'TENSIOMARK');
  assert.deepEqual(byEui('00000000000000F5').soil_moisture_probe_depths_json, {swt_1: 30, soil_temp_1: 30});
  assert.equal(byEui('00000000000000F5').soil_moisture_probe_depths_configured, 1);
  for (const eui of ['00000000000000D1', '00000000000000F1', '00000000000000F2', '00000000000000F3',
    '00000000000000F4', '00000000000000F6']) hasNoSoilMetadata(byEui(eui));
});

test('all nine native Add families start from usable source-shaped snapshots and sample through native clients', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const catalog = await devicesAPI.getCatalog();
  assert.deepEqual(catalog.map(row => row.id), ['KIWI_SENSOR', 'TEKTELIC_CLOVER', 'STREGA_VALVE', 'DRAGINO_LSN50',
    'SENSECAP_S2120', 'AQUASCOPE_LORAIN', 'MILESIGHT_UC512', 'DRAGINO_SDI12', 'RAK10701_FIELD_TESTER']);
  const added = [];
  for (const [index, item] of catalog.entries()) {
    added.push(await devicesAPI.add({deveui: `00000000000000C${index.toString(16).toUpperCase()}`,
      name: `Fictional ${item.name}`, type_id: item.id}));
  }
  const byType = (type: string) => added.find(device => device.type_id === type)!;
  const kiwi = byType('KIWI_SENSOR');
  assert.equal(typeof kiwi.latest_data.swt_1, 'number');
  assert.equal(typeof kiwi.latest_data.swt_2, 'number');
  assert.equal(kiwi.latest_data.swt_3, undefined);
  assert.equal(byType('TEKTELIC_CLOVER').latest_data.swt_1, null);
  assert.equal(typeof byType('TEKTELIC_CLOVER').latest_data.ambient_temperature, 'number');
  assert.equal(byType('TEKTELIC_CLOVER').latest_data.bat_pct, 90, 'Add initializes Clover health deliberately');
  const strega = byType('STREGA_VALVE');
  assert.equal(strega.latest_data.bat_pct, 90);
  assert.equal(strega.latest_data.bat_v, undefined);
  hasNoSoilMetadata(strega);
  const lsn = byType('DRAGINO_LSN50');
  assert.equal(lsn.lsn50_mode, 'MOD9');
  assert.equal(lsn.latest_data.lsn50_mode_label, 'MOD9');
  assert.equal(lsn.latest_data.rain_mm_delta, 0);
  assert.equal(lsn.latest_data.flow_liters_delta, 0);
  assert.equal(lsn.chameleon_enabled, 0);
  hasNoSoilMetadata(lsn);
  const s2120 = byType('SENSECAP_S2120');
  for (const field of ['ambient_temperature', 'relative_humidity', 'light_lux', 'wind_speed_mps', 'wind_direction_deg',
    'wind_gust_mps', 'uv_index', 'barometric_pressure_hpa', 'rain_mm_delta', 'rain_gauge_cumulative_mm', 'bat_pct']) {
    assert.equal(typeof s2120.latest_data[field], 'number', `S2120 ${field}`);
  }
  assert.equal(s2120.latest_data.rain_day, new Intl.DateTimeFormat('en-CA', {timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(sim.now)));
  assert.equal(s2120.latest_data.rain_delta_status, 'ok');
  assert.equal(s2120.latest_data.counter_interval_seconds, 1800);
  const rainDayStart = Date.parse(`${s2120.latest_data.rain_day}T00:00:00+03:00`);
  const rainRows = await sensorAPI.getHistory(s2120.deveui, 'rain_mm_delta', 24);
  const todayDeltaTotal = rainRows.filter(row => Date.parse(row.t) >= rainDayStart && Date.parse(row.t) <= sim.now)
    .reduce((sum, row) => sum + Number(row.value ?? 0), 0);
  assert.equal(s2120.latest_data.rain_mm_today, todayDeltaTotal, 'S2120 current day total matches one sum of retained deltas');
  assert.equal(s2120.latest_data.rain_mm_per_10min, Number((Number(s2120.latest_data.rain_mm_delta) * 600 /
    Number(s2120.latest_data.counter_interval_seconds)).toFixed(3)), 'S2120 normalized interval rate follows the actual accepted boundary');
  const lorain = byType('AQUASCOPE_LORAIN');
  assert.equal(lorain.latest_data.rain_tips_delta, 0);
  assert.equal(lorain.latest_data.rain_mm_per_10min, null);
  assert.equal(lorain.latest_data.rain_mm_per_hour, null);
  assert.equal(lorain.latest_data.rain_gauge_cumulative_mm, undefined);
  assert.equal(lorain.latest_data.bat_v, 3.3);
  const uc512 = byType('MILESIGHT_UC512');
  assert.equal(uc512.latest_data.bat_pct, 90);
  assert.equal(uc512.latest_data.pipe_pressure_kpa, 220);
  for (const field of ['valve_1_pulse', 'valve_2_pulse']) assert.ok(Number.isInteger(uc512.latest_data[field]), `UC512 ${field}`);
  assert.equal(uc512.latest_data.valve_1_state, 'close');
  assert.equal(uc512.latest_data.valve_2_state, 'close');
  assert.equal(uc512.latest_data.ext_temperature_c, undefined);
  assert.equal(uc512.target_state, undefined);
  hasNoSoilMetadata(uc512);
  const sdi = byType('DRAGINO_SDI12');
  assert.equal(sdi.sdi12_probe_profile, 'TENSIOMARK');
  assert.deepEqual(sdi.soil_moisture_probe_depths_json, {swt_1: 30, soil_temp_1: 30});
  assert.equal(typeof sdi.latest_data.swt_1, 'number');
  assert.equal(typeof sdi.latest_data.soil_temp_1, 'number');
  assert.equal(sdi.latest_data.vwc_1, undefined);
  const rak = byType('RAK10701_FIELD_TESTER');
  assert.equal(rak.latest_data.bat_pct, undefined);
  assert.equal(typeof rak.latest_data.rssi, 'number');
  assert.equal(typeof rak.latest_data.snr, 'number');
  hasNoSoilMetadata(rak);
  const observationBounds = {from: rak.latest_data.sampled_at, to: rak.latest_data.sampled_at};
  const observations = await networkAPI.observations(500, 0, observationBounds);
  assert.equal(observations.from, observationBounds.from);
  assert.equal(observations.to, observationBounds.to);
  const observation = observations.rows.find(row => row.deveui === rak.deveui && row.recorded_at === rak.latest_data.sampled_at)!;
  assert.ok(observation, 'network observation uses the same timestamp as the current RAK sample');
  const networkFacts = JSON.parse(observation.metadata_json ?? '{}');
  const nativeObservation = rak.latest_data.network_observation as {reported_position: unknown};
  assert.deepEqual(networkFacts.reported_position, nativeObservation.reported_position);
  assert.equal(networkFacts.version, 1);
  assert.equal(networkFacts.timestamp_source, 'ingest');
  assert.equal(typeof networkFacts.ingested_at, 'string');
  assert.equal(networkFacts.deduplication_uncertain, true);
  assert.deepEqual(Object.keys(networkFacts.radio).sort(), ['adr','bandwidth_hz','coding_rate','f_cnt','f_port','frequency_hz','spreading_factor']);
  assert.deepEqual(Object.keys(networkFacts.reported_position).sort(),
    ['accuracy_m','altitude_m','fix_time','hdop','latitude','longitude','satellites','source']);
  assert.equal(networkFacts.receivers[0].gateway_id, '0016C001F1000001');
  assert.equal(networkFacts.receivers[0].uplink_id_num, null);
  assert.ok(Object.hasOwn(networkFacts.receivers[0], 'channel'));
  assert.ok(Object.hasOwn(networkFacts.receivers[0], 'crc_status'));
  assert.equal(networkFacts.receivers[0].position.sync_version, null);
  assert.equal(networkFacts.device_location, null);
  assert.equal(networkFacts.receivers[0].rssi_dbm, rak.latest_data.rssi);
  const originalObservation = structuredClone(observation);
  await networkAPI.saveLocation(rak.deveui, {revision_uuid: '00000000-0000-4000-8000-0000000000C1', base_revision_uuid: null,
    values: {latitude: 0.348, longitude: 32.583, effectiveFrom: observation.recorded_at, coordinateSource: 'manual'}});
  await networkAPI.saveRadio(rak.deveui, {revision_uuid: '00000000-0000-4000-8000-0000000000C2', base_revision_uuid: null,
    values: {txPowerDbm: 14, antennaGainDbi: 2, feederLossDb: 0.5, configurationSource: 'manual', effectiveFrom: observation.recorded_at}});
  const unchanged = await networkAPI.observations(500, 0, observationBounds);
  assert.deepEqual(unchanged.rows.filter(row => row.deveui === rak.deveui), [originalObservation],
    'fixed-bound RAK observation rows remain byte-for-byte unchanged by location and radio revisions');

  sim.advanceTo(sim.now + 30 * 60_000);
  const sampled = await devicesAPI.getAll();
  const sampledLoRain = sampled.find(device => device.deveui === lorain.deveui)!;
  assert.equal(sampledLoRain.latest_data.counter_interval_seconds, null, 'received-only LoRain does not claim an unverified window');
  const typesWithSensorHistory = ['KIWI_SENSOR', 'TEKTELIC_CLOVER', 'DRAGINO_LSN50', 'SENSECAP_S2120',
    'AQUASCOPE_LORAIN', 'DRAGINO_SDI12'];
  for (const type of typesWithSensorHistory) {
    const device = sampled.find(row => row.deveui === byType(type).deveui)!;
    const sampledAt = device.latest_data.sampled_at;
    assert.equal(typeof sampledAt, 'string', `${type} current sample time`);
    const channel = type === 'DRAGINO_SDI12' ? 'swt_1' : type === 'AQUASCOPE_LORAIN' ? 'rain_mm_delta'
      : type === 'DRAGINO_LSN50' ? 'rain_mm_delta' : type === 'SENSECAP_S2120' ? 'ambient_temperature'
      : type === 'TEKTELIC_CLOVER' ? 'ambient_temperature' : 'swt_1';
    const rows = await sensorAPI.getHistory(device.deveui, channel, 24);
    assert.ok(rows.some(row => row.t === sampledAt && row.value === device.latest_data[channel]), `${type}/${channel} current/history`);
  }
  await lsn50API.setMode(lsn.deveui, 'MOD3');
  await lsn50API.setChameleonEnabled(lsn.deveui, true);
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60_000);
  const attached = (await devicesAPI.getAll()).find(device => device.deveui === lsn.deveui)!;
  assert.equal(attached.lsn50_mode, 'MOD3');
  assert.match(String(attached.latest_data.chameleon_array_id), /^SIM-CHAMELEON-KNOWN-/);
  assert.notEqual(attached.latest_data.chameleon_array_id, 'SIM-CHAMELEON-KNOWN-01');
  assert.equal(attached.latest_data.calibration_status, 'calibrated');
  for (const field of ['swt_1','swt_2','swt_3']) assert.equal(typeof attached.latest_data[field], 'number');
  assert.equal(attached.latest_data.flow_liters_delta, undefined, 'MOD3 never receives attributed flow');
  const channels = (await analysisAPI.getChannels()).channels;
  assert.equal(channels.some(row => row.deviceName === uc512.name && row.channelKey === 'pipe_pressure_kpa' && row.unit === 'kPa'), true);
  assert.equal(channels.some(row => row.deviceName === uc512.name && row.channelKey === 'ext_temperature_c'), false);
});

test('native dendro values keep MOD1 and MOD3 electrical, displacement, clipping, and site-day facts consistent', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const eui = '00000000000000E3';
  await lsn50API.setDendroConfig(eui, {dendroStrokeMm: 10, dendroRatioAtRetracted: 0.49, dendroRatioAtExtended: 0.48});
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60_000);
  let dendro = (await devicesAPI.getAll()).find(device => device.deveui === eui)!;
  const ratio = Number(dendro.latest_data.dendro_ratio);
  assert.ok(ratio >= 0.458 && ratio <= 0.462, 'MOD3 uses the published ~0.46 ratio');
  assert.ok(Math.abs(Number(dendro.latest_data.adc_ch0v) / Number(dendro.latest_data.adc_ch1v) - ratio) < 0.001);
  let derived = nativeDendro.buildDendroDerivedMetrics({effectiveMode: 3, adcCh0V: dendro.latest_data.adc_ch0v,
    adcCh1V: dendro.latest_data.adc_ch1v, strokeMm: 10, ratioAtRetracted: 0.49, ratioAtExtended: 0.48});
  assert.equal(dendro.latest_data.dendro_position_raw_mm, derived.positionRawMm);
  assert.equal(dendro.latest_data.dendro_position_mm, derived.positionMm);
  assert.equal(dendro.latest_data.dendro_saturated, derived.dendroSaturated);
  assert.equal(dendro.latest_data.dendro_saturation_side, derived.dendroSaturationSide);

  await lsn50API.setMode(eui, 'MOD1');
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60_000);
  dendro = (await devicesAPI.getAll()).find(device => device.deveui === eui)!;
  assert.equal(dendro.latest_data.dendro_ratio, null, 'MOD1 has no two-channel ratio');
  assert.equal(dendro.latest_data.adc_ch1v, undefined);
  assert.equal(dendro.latest_data.dendro_mode_used, 'legacy_single_adc');
  derived = nativeDendro.buildDendroDerivedMetrics({effectiveMode: 1, adcCh0V: dendro.latest_data.adc_ch0v,
    strokeMm: 10, ratioAtRetracted: 0.49, ratioAtExtended: 0.48});
  assert.equal(dendro.latest_data.dendro_position_raw_mm, derived.positionRawMm);
  assert.equal(dendro.latest_data.dendro_position_mm, derived.positionMm);
  assert.equal(dendro.latest_data.dendro_saturated, derived.dendroSaturated);
  assert.equal(dendro.latest_data.dendro_saturation_side, derived.dendroSaturationSide);
});


test('soil rain response is invariant to report and clock partitions across the same physical rain event', async () => {
  const wide = new Simulator({mode: 'public'});
  bridge(wide);
  const wideKiwi = (await devicesAPI.getAll()).find(device => device.deveui === '00000000000000A1')!;
  await kiwiAPI.setUplinkInterval(wideKiwi.deveui, 30);
  wide.advanceTo(wide.now + 72 * 60 * 60_000);
  const wideCurrent = (await devicesAPI.getAll()).find(device => device.deveui === wideKiwi.deveui)!;
  const wideHistory = await sensorAPI.getHistory(wideKiwi.deveui, 'swt_1', 24);

  const fine = new Simulator({mode: 'public'});
  bridge(fine);
  const fineKiwi = (await devicesAPI.getAll()).find(device => device.deveui === '00000000000000A1')!;
  await kiwiAPI.setUplinkInterval(fineKiwi.deveui, 15);
  for (let index = 0; index < 12; index++) fine.advanceTo(fine.now + 6 * 60 * 60_000);
  const fineCurrent = (await devicesAPI.getAll()).find(device => device.deveui === fineKiwi.deveui)!;
  const fineHistory = await sensorAPI.getHistory(fineKiwi.deveui, 'swt_1', 24);
  const fineByTime = new Map(fineHistory.map(row => [row.t, row.value]));
  const sharedObservation = wideHistory.find(row => fineByTime.has(row.t));
  assert.ok(sharedObservation, 'the same physical observation time exists under both report partitions');
  assert.equal(sharedObservation.value, fineByTime.get(sharedObservation.t));
  assert.equal(typeof wideCurrent.latest_data.swt_1, 'number');
  assert.equal(typeof fineCurrent.latest_data.swt_1, 'number');
});

test('native observed irrigation wets every eligible zone probe once using opening-time geometry across clock partitions', async () => {
  const euis = {valve: '00000000000000D1', kiwi: '00000000000000A1', otherZoneKiwi: '00000000000000A2',
    sdi: '00000000000000F5', otherZoneChameleon: '00000000000000E3'};
  async function run(options: {interval?: number; action: boolean; editGeometryAfterOpen?: boolean;
    unknownGeometry?: boolean; missingArea?: boolean; missingEfficiency?: boolean; zeroEfficiency?: boolean}) {
    const sim = new Simulator({mode: 'public'});
    bridge(sim);
    const lsn = await devicesAPI.add({deveui: '00000000000000C9', name: 'Zone one calibrated Chameleon', type_id: 'DRAGINO_LSN50', zone_id: 1});
    await lsn50API.setMode(lsn.deveui, 'MOD3');
    await lsn50API.setChameleonEnabled(lsn.deveui, true);
    await irrigationZonesAPI.removeDevice(2, euis.sdi);
    await irrigationZonesAPI.assignDevice(1, euis.sdi);
    await putSdi12Config(euis.sdi, {probe_profile: 'TENSIOMARK', value_count: 2, depths: {1: 30}});
    if (options.interval) await kiwiAPI.setUplinkInterval(euis.kiwi, options.interval);
    await irrigationZonesAPI.updateConfig(1, {areaM2: options.unknownGeometry || options.missingArea ? null : 100,
      irrigationEfficiencyPct: options.unknownGeometry || options.missingEfficiency ? null : options.zeroEfficiency ? 0 : 85});
    sim.advanceTo(sim.now + 2000);
    const actionStart = sim.now;
    if (options.action) {
      await devicesAPI.controlValve(euis.valve, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
      sim.advanceTo(actionStart + 2000);
      const running = (await devicesAPI.getAll()).find(device => device.deveui === euis.valve)!;
      assert.equal(running.active_valve_actuation?.reconciliation_state, 'OBSERVED_RUNNING');
      const activeOutcome = (await irrigationOutcomesAPI.recentActuations()).actuations.find(item => item.deviceEui === euis.valve)!;
      assert.equal(activeOutcome.status, 'RUNNING');
      assert.equal(activeOutcome.observedOpenAt, new Date(actionStart + 2000).toISOString());
      if (options.editGeometryAfterOpen) {
        sim.advanceTo(actionStart + 12_000);
        await irrigationZonesAPI.updateConfig(1, {areaM2: 10_000, irrigationEfficiencyPct: 10});
      }
      if (options.interval === 15) {
        for (const offset of [32_000, 62_000]) sim.advanceTo(actionStart + offset);
        for (let offset = 15 * 60_000; offset <= 3 * 60 * 60_000; offset += 15 * 60_000) sim.advanceTo(actionStart + offset);
      } else sim.advanceTo(actionStart + 3 * 60 * 60_000);
      const completed = await devicesAPI.getAll();
      const valve = completed.find(device => device.deveui === euis.valve)!;
      assert.equal(valve.active_valve_actuation, null);
      const outcomes = await irrigationOutcomesAPI.recentActuations();
      const outcome = outcomes.actuations.find(item => item.deviceEui === euis.valve)!;
      assert.equal(outcome.status, 'COMPLETED');
      assert.equal(outcome.observedCloseAt, new Date(actionStart + 62_000).toISOString());
      assert.equal(outcome.estimatedGrossLiters, 6, 'the observed 60-second opening contributes exactly one six-litre run');
      return {sim, devices: completed};
    }
    sim.advanceTo(actionStart + 3 * 60 * 60_000);
    return {sim, devices: await devicesAPI.getAll()};
  }
  const dry = await run({action: false});
  const wide = await run({action: true});
  const partitioned = await run({action: true, interval: 15, editGeometryAfterOpen: true});
  const unknown = await run({action: true, unknownGeometry: true});
  const missingArea = await run({action: true, missingArea: true});
  const missingEfficiency = await run({action: true, missingEfficiency: true});
  const current = (result: typeof dry, eui: string) => result.devices.find(device => device.deveui === eui)!;
  const probeRows = [[euis.kiwi, 'swt_1'], [euis.sdi, 'swt_1'], ['00000000000000C9', 'swt_1']] as const;
  bridge(partitioned.sim);
  for (const [eui, channel] of probeRows) {
    const dryDevice = current(dry, eui), wideDevice = current(wide, eui), partitionedDevice = current(partitioned, eui);
    assert.ok(typeof dryDevice.latest_data[channel] === 'number' && typeof wideDevice.latest_data[channel] === 'number');
    assert.ok(Number(wideDevice.latest_data[channel]) < Number(dryDevice.latest_data[channel]), `${eui}/${channel} receives observed irrigation wetting`);
    assert.equal(partitionedDevice.latest_data[channel], wideDevice.latest_data[channel], `${eui}/${channel} keeps the same action response across 15/30-minute reporting`);
    const rows = await sensorAPI.getHistory(eui, channel, 24);
    assert.ok(rows.some(row => row.t === partitionedDevice.latest_data.sampled_at && row.value === partitionedDevice.latest_data[channel]), `${eui}/${channel} native history agrees with current`);
    assert.equal(current(unknown, eui).latest_data[channel], null, `${eui}/${channel} remains unknown when delivery geometry is unknown`);
    assert.equal(current(missingArea, eui).latest_data[channel], null, `${eui}/${channel} remains unknown with missing area alone`);
    assert.equal(current(missingEfficiency, eui).latest_data[channel], null, `${eui}/${channel} remains unknown with missing efficiency alone`);
  }
  for (const eui of [euis.otherZoneKiwi, euis.otherZoneChameleon]) {
    assert.equal(current(wide, eui).latest_data.swt_1, current(dry, eui).latest_data.swt_1, `${eui} stays isolated in zone two`);
    assert.equal(current(partitioned, eui).latest_data.swt_1, current(dry, eui).latest_data.swt_1, `${eui} stays isolated across reporting partitions`);
    assert.equal(current(unknown, eui).latest_data.swt_1, current(dry, eui).latest_data.swt_1, `${eui} is unaffected by another zone's unknown geometry`);
  }
});

test('known zero irrigation efficiency is distinct from unavailable efficiency', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  await irrigationZonesAPI.updateConfig(1, {areaM2: 100, irrigationEfficiencyPct: 0});
  assert.equal((await irrigationZonesAPI.getAll()).find(zone => zone.id === 1)?.irrigation_efficiency_pct, 0);
});

test('S2120 assignment readback follows one owner through native reads and zone renames', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const stationEui = '00000000000000F2';
  const historyBefore = await sensorAPI.getHistory(stationEui, 'rain_mm_delta', 24);
  const seededStation = (await devicesAPI.getAll()).find(device => device.deveui === stationEui)!;
  assert.deepEqual(seededStation.zone_ids, [1, 2], 'seeded assignment owner projects through devicesAPI');
  await s2120API.setZoneAssignments(stationEui, [1, 2]);
  let station = (await devicesAPI.getAll()).find(device => device.deveui === stationEui)!;
  assert.deepEqual(station.zone_ids, [1, 2]);
  assert.deepEqual(station.zone_names, ['Tomato plot', 'Demonstration bed']);
  assert.deepEqual((await s2120API.getZoneAssignments(stationEui)).map(row => row.zone_id), [1, 2]);
  await irrigationZonesAPI.rename(2, 'Renamed demonstration bed');
  station = (await devicesAPI.getAll()).find(device => device.deveui === stationEui)!;
  assert.deepEqual(station.zone_names, ['Tomato plot', 'Renamed demonstration bed']);
  await s2120API.setZoneAssignments(stationEui, [2]);
  station = (await devicesAPI.getAll()).find(device => device.deveui === stationEui)!;
  assert.deepEqual(station.zone_ids, [2]);
  assert.deepEqual(station.zone_names, ['Renamed demonstration bed']);
  assert.deepEqual(await sensorAPI.getHistory(stationEui, 'rain_mm_delta', 24), historyBefore);
  const addedStation = await devicesAPI.add({deveui: '00000000000000CB', name: 'Added weather station', type_id: 'SENSECAP_S2120'});
  await s2120API.setZoneAssignments(addedStation.deveui, [1]);
  const projectedAdd = (await devicesAPI.getAll()).find(device => device.deveui === addedStation.deveui)!;
  assert.deepEqual(projectedAdd.zone_ids, [1], 'new assignment owner also projects after save');
  assert.deepEqual(projectedAdd.zone_names, ['Tomato plot']);
});

test('observed flow publishes one native current/history snapshot during a run and at a nonperiodic close', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const flowEui = '00000000000000E1';
  const valveEui = '00000000000000D1';
  await devicesAPI.controlValve(valveEui, {action: 'OPEN_FOR_DURATION', duration_seconds: 3600});
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60_000);
  const during = (await devicesAPI.getAll()).find(device => device.deveui === flowEui)!;
  const duringHistory = await sensorAPI.getHistory(flowEui, 'flow_liters_delta', 24);
  const duringPoint = duringHistory.find(row => row.t === during.latest_data.sampled_at)!;
  assert.ok(duringPoint, 'open-run current timestamp is present in native history');
  assert.equal(during.latest_data.flow_liters_delta, duringPoint.value);
  assert.ok(Number(during.latest_data.flow_liters_delta) > 0);
  assert.ok(Number(during.latest_data.flow_liters_per_10min) > 0);
  assert.equal(during.latest_data.flow_delta_status, 'ok');

  await devicesAPI.controlValve(valveEui, {action: 'CLOSE'});
  sim.advanceTo(sim.now + 2000);
  const closed = (await devicesAPI.getAll()).find(device => device.deveui === flowEui)!;
  const closeHistory = await sensorAPI.getHistory(flowEui, 'flow_liters_delta', 24);
  const closePoint = closeHistory.find(row => row.t === closed.latest_data.sampled_at)!;
  assert.ok(closePoint, 'nonperiodic close timestamp is present in native history');
  assert.equal(closed.latest_data.flow_liters_delta, closePoint.value);
  assert.ok(Number(closed.latest_data.flow_liters_delta) > 0);
  assert.ok(Number(closed.latest_data.flow_liters_per_10min) > 0);
  assert.equal(closed.latest_data.flow_delta_status, 'ok');
});

test('Chameleon exposes native calibration and full-identity attachment while retaining unknown calibration', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const seed = await devicesAPI.getAll();
  const known = seed.find(device => device.deveui === '00000000000000E3')!;
  const unknown = seed.find(device => device.deveui === '00000000000000E4')!;
  assert.equal(known.calibration_status, 'calibrated');
  assert.deepEqual([known.chameleon_swt1_depth_cm, known.chameleon_swt2_depth_cm, known.chameleon_swt3_depth_cm], [10, 20, 40]);
  assert.equal(unknown.calibration_status, 'unknown');
  assert.equal(unknown.latest_data.swt_1, null);
  assert.equal((await lsn50API.refreshChameleonCalibration(unknown.deveui)).status, 'unknown', 'unlisted calibration refresh remains explicitly unavailable');
  assert.equal((await devicesAPI.getAll()).find(device => device.deveui === unknown.deveui)?.calibration_status, 'unknown');

  await lsn50API.refreshChameleonCalibration(known.deveui);
  const pending = (await devicesAPI.getAll()).find(device => device.deveui === known.deveui)!;
  assert.equal(pending.calibration_status, 'pending');
  assert.equal(typeof pending.latest_data.swt_1, 'number', 'valid cached calibration remains usable while refreshing');
  sim.advanceTo(sim.now + 5000);
  const refreshed = (await devicesAPI.getAll()).find(device => device.deveui === known.deveui)!;
  assert.equal(refreshed.calibration_status, 'calibrated');
  const cachedSwt = refreshed.latest_data.swt_1;
  const cachedHistory = await sensorAPI.getHistory(known.deveui, 'swt_1', 24);
  await lsn50API.setChameleonDepth(known.deveui, {chameleonSwt3DepthCm: null});
  sim.advanceTo(sim.now + 2000);
  const clearedDepth = (await devicesAPI.getAll()).find(device => device.deveui === known.deveui)!;
  assert.equal(clearedDepth.chameleon_swt3_depth_cm, null, 'configured depth remains explicitly clearable');
  assert.equal(clearedDepth.latest_data.swt_1, cachedSwt, 'depth metadata edits retain cached readings');
  assert.deepEqual(await sensorAPI.getHistory(known.deveui, 'swt_1', 24), cachedHistory, 'depth metadata edits do not rewrite history');

  await lsn50API.setChameleonEnabled(unknown.deveui, false);
  sim.advanceTo(sim.now + 2000);
  await lsn50API.setChameleonEnabled(unknown.deveui, true);
  sim.advanceTo(sim.now + 2000);
  sim.advanceTo(sim.now + 30 * 60_000);
  const stillUnknown = (await devicesAPI.getAll()).find(device => device.deveui === unknown.deveui)!;
  assert.equal(stillUnknown.calibration_status, 'unknown');
  assert.equal(stillUnknown.latest_data.swt_1, null);

  const attached = [];
  for (const eui of ['000000000000CD01', '000000000000CE01']) {
    const added = await devicesAPI.add({deveui: eui, name: `Attached ${eui}`, type_id: 'DRAGINO_LSN50'});
    await lsn50API.setMode(added.deveui, 'MOD3');
    await lsn50API.setChameleonEnabled(added.deveui, true);
    sim.advanceTo(sim.now + 2000);
    sim.advanceTo(sim.now + 30 * 60_000);
    attached.push((await devicesAPI.getAll()).find(device => device.deveui === eui)!);
  }
  assert.equal(attached[0]!.calibration_status, 'calibrated');
  assert.notEqual(attached[0]!.latest_data.chameleon_array_id, attached[1]!.latest_data.chameleon_array_id);
  assert.notEqual(attached[0]!.latest_data.chameleon_array_id, known.latest_data.chameleon_array_id);

  const suffixKiwi = await devicesAPI.add({deveui: 'AABBCCDDEEFF00A1', name: 'Suffix collision Kiwi', type_id: 'KIWI_SENSOR'});
  assert.equal(suffixKiwi.latest_data.swt_3, undefined, 'reserved third-channel seed matches only the exact EUI');
});


test('SDI-12 depth saves use canonical Tensiomark channel metadata', async () => {
  const sim = new Simulator({mode: 'public'});
  bridge(sim);
  const before = (await devicesAPI.getAll()).find(device => device.deveui === '00000000000000F5')!;
  assert.equal(before.sdi12_value_count, 2, 'seeded manual Tensiomark does not inherit GENERIC_VWC count');
  await putSdi12Config(before.deveui, {probe_profile: 'TENSIOMARK', value_count: 2, depths: {1: 40}});
  const after = (await devicesAPI.getAll()).find(device => device.deveui === before.deveui)!;
  assert.deepEqual(after.soil_moisture_probe_depths_json, {swt_1: 40, soil_temp_1: 40});
  assert.equal(after.soil_moisture_probe_depths_configured, 1);
  await putSdi12Config(after.deveui, {probe_profile: 'TENSIOMARK', value_count: 2});
  const omitted = (await devicesAPI.getAll()).find(device => device.deveui === after.deveui)!;
  assert.deepEqual(omitted.soil_moisture_probe_depths_json, {swt_1: 40, soil_temp_1: 40}, 'omitted depths preserve the compatible installation');
  await postSdi12RecipeApply(after.deveui);
  sim.advanceTo(sim.now + 2000);
  await postSdi12RecipeApply(after.deveui);
  await putSdi12Config(after.deveui, {probe_profile: 'HYDRASCOUT', value_count: 6, depths: {1: 15, 2: 30}});
  const hydraDepths = (await devicesAPI.getAll()).find(device => device.deveui === after.deveui)!;
  assert.deepEqual(hydraDepths.soil_moisture_probe_depths_json, {vwc_1: 15, soil_temp_1: 15, soil_ec_1: 15,
    vwc_2: 30, soil_temp_2: 30, soil_ec_2: 30}, 'supported profile depths map to their native channels');
  const tensiomarkSeries = (await analysisAPI.getChannels()).channels.find(row => row.deviceName === after.name && row.channelKey === 'swt_1')!;
  const historyBounds = {mode: 'absolute' as const, label: 'custom', from: new Date(sim.now - 24 * 60 * 60_000).toISOString(),
    to: new Date(sim.now).toISOString()};
  const oldTensiomarkHistory = await analysisAPI.getSeries({selectors: [{seriesId: tensiomarkSeries.seriesId}], range: historyBounds, aggregation: 'raw'});
  const originalHistoryPoints = structuredClone(oldTensiomarkHistory.series[0]!.points);
  sim.advanceTo(sim.now + 30 * 60_000);
  const changed = (await devicesAPI.getAll()).find(device => device.deveui === after.deveui)!;
  assert.equal(changed.latest_data.swt_1, undefined, 'profile changes clear incompatible current channels');
  assert.equal(typeof changed.latest_data.vwc_1, 'number', 'a sampled HYDRASCOUT publishes its supported current channels');
  assert.deepEqual(changed.soil_moisture_probe_depths_json, {vwc_1: 15, soil_temp_1: 15, soil_ec_1: 15,
    vwc_2: 30, soil_temp_2: 30, soil_ec_2: 30});
  await postSdi12RecipeRollback(after.deveui);
  const rolledBack = (await devicesAPI.getAll()).find(device => device.deveui === after.deveui)!;
  assert.equal(rolledBack.sdi12_probe_profile, 'TENSIOMARK');
  assert.deepEqual(rolledBack.soil_moisture_probe_depths_json, {swt_1: 40, soil_temp_1: 40});
  assert.equal(rolledBack.soil_moisture_probe_depths_configured, 1);
  assert.equal(rolledBack.latest_data.vwc_1, undefined, 'rollback after a new-profile sample clears incompatible current channels immediately');
  assert.equal(rolledBack.latest_data.soil_ec_1, undefined);
  const retainedHistory = await analysisAPI.getSeries({selectors: [{seriesId: tensiomarkSeries.seriesId}], range: historyBounds, aggregation: 'raw'});
  assert.deepEqual(retainedHistory.series[0]?.points, originalHistoryPoints,
    'fixed-bound native analysis rows remain byte-for-byte unchanged across a sampled profile change and rollback');
});
