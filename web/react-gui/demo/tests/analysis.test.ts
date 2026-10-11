import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {analysisAPI, api, devicesAPI, environmentAPI, historyAPI, systemAPI} from '../../src/services/api';
import {toTidyCsv} from '../../src/analysis/csv';
import {createDemoAdapter} from '../adapter';
import {describeDeviceSource} from '../model/device-sources';
import {channelAggregationStatistic} from '../model/aggregation';
import {Simulator} from '../model';
const require = createRequire(import.meta.url);
const edgeAnalysis = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js') as {DEVICE_CHANNEL_AGGREGATION: Record<string, string>};
const edgeSources = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/device-sources.js') as {describeDeviceSource: (device: unknown) => {families: Array<{cardType: string; channelKeys: string[]}>}};

function install(sim: Simulator): void { api.defaults.adapter = createDemoAdapter(sim); }

test('AN01 catalogue follows device assignment and the finite channel manifest', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const before = await analysisAPI.getChannels();
  assert.ok(before.channels.some(row => row.channelKey === 'swt_1' && row.availability === 'available'));
  const kiwi = before.sources?.find(row => row.typeId === 'KIWI_SENSOR' && row.zoneId === 1)!;
  const kiwiChannels = before.channels.filter(row => row.deviceSourceId === kiwi.id && row.cardType === 'soil');
  assert.ok(kiwiChannels.every(row => row.channelKey === 'swt_1' || row.channelKey === 'swt_2'));
  const added = await devicesAPI.add({deveui: '00000000000000B0', name: 'Added soil probe', type_id: 'KIWI_SENSOR'});
  const assigned = await api.put(`/api/irrigation-zones/2/devices/${added.deveui}`, {});
  assert.ok(assigned);
  const after = await analysisAPI.getChannels();
  assert.ok(after.channels.some(row => row.zoneId === 2 && row.deviceName === 'Added soil probe' && row.channelKey === 'swt_1'));
});

test('EN02 and AN01-02 expose the illustrative zone weather source to analysis with the environment timeline values', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  sim.advanceTo(sim.now + 12 * 60 * 60_000);
  const summary = await environmentAPI.getSummary(1);
  const pastDay = summary.water.daily.find(day => day.date < summary.water.todayDate!)!;
  const from = new Date(sim.now - 8 * 86400000).toISOString();
  const to = new Date(sim.now + 1).toISOString();
  const catalog = await analysisAPI.getChannels();
  const et0 = catalog.channels.find(row => row.zoneId === 1 && row.sourceKind === 'zone_daily_agronomy' && row.channelKey === 'et0_mm');
  assert.ok(et0, 'illustrative ET0 source is selectable');
  const etc = catalog.channels.find(row => row.zoneId === 1 && row.sourceKind === 'zone_daily_agronomy' && row.channelKey === 'etc_mm');
  assert.ok(etc, 'illustrative crop demand source is selectable');
  const series = await analysisAPI.getSeries({selectors: [{seriesId: et0.seriesId}, {seriesId: etc.seriesId}],
    range: {mode: 'absolute', label: 'custom', from, to}, aggregation: 'raw'});
  assert.ok(series.series.some(row => row.resolved.channelKey === 'et0_mm' && row.points.some(point => point.value === pastDay.et0Mm)));
  assert.ok(series.series.some(row => row.resolved.channelKey === 'etc_mm' && row.points.some(point => point.value === pastDay.demandMm)));
  const card = (await historyAPI.getZoneCards(1)).cards.find(row => row.cardType === 'environment')!;
  assert.ok(card.sourceDevices?.some(source => source.sourceKey === 'agronomy-src-zone' && source.name === 'Illustrative simulator'),
    'shared weather history source is offered by the native selector');
  const history = await historyAPI.getZoneCardData(1, card.cardId, {view: 'line-chart', range: {label: 'custom', from, to, timezone: 'Africa/Kampala'},
    aggregation: 'raw', overlays: [], sourceKey: 'agronomy-src-zone'});
  assert.ok(history.series.some(row => row.id === 'et0_mm' && row.points.some(point => point.value === pastDay.et0Mm)));
  assert.ok(history.series.some(row => row.id === 'etc_mm' && row.points.some(point => point.value === pastDay.demandMm)));
});

test('AN02 series resolves the selected catalog channel from the shared ledger and preserves missing values', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const catalog = await analysisAPI.getChannels();
  const selected = catalog.channels.find(row => row.channelKey === 'swt_1' && row.availability === 'available')!;
  const response = await analysisAPI.getSeries({selectors: [{seriesId: selected.seriesId}],
    range: {mode: 'absolute', label: 'custom', from: new Date(sim.now - 60 * 60_000).toISOString(), to: new Date(sim.now).toISOString()}, aggregation: 'raw'});
  const series = response.series[0]!;
  assert.equal(series.resolved.channelKey, 'swt_1');
  assert.equal(series.points.length, 2);
  assert.ok(series.points.every(point => typeof point.value === 'number'));
  assert.equal(response.range.to, new Date(sim.now).toISOString());
  const zero = (await analysisAPI.getChannels()).channels.find(row => row.channelKey === 'rain_mm_delta' && row.availability === 'available')!;
  const rain = await analysisAPI.getSeries({selectors: [{seriesId: zero.seriesId}],
    range: {mode: 'absolute', label: 'custom', from: new Date(sim.now - 60 * 60_000).toISOString(), to: new Date(sim.now).toISOString()}, aggregation: 'raw'});
  assert.ok(rain.series[0]!.points.some(point => point.value === 0));
});

test('AN03-05 saved analysis views round-trip flattened fields and delete only the selected view', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const channel = (await analysisAPI.getChannels()).channels.find(row => row.availability === 'available')!;
  const first = await analysisAPI.saveView({name: 'Primary view', isDefault: true, viewJson: {
    schemaVersion: 1, selectors: [{seriesId: channel.seriesId}], range: {mode: 'relative', label: '7d', from: null, to: null},
    mode: 'correlation', layout: 'small-multiples', toggles: {normalize: true},
    labelOverrides: {[channel.seriesId]: 'My label'}, axisLabelOverrides: {left: 'Depth'},
  }});
  const second = await analysisAPI.saveView({name: 'Other view', isDefault: false, viewJson: {
    schemaVersion: 1, selectors: [], range: {mode: 'relative', label: '24h', from: null, to: null}, mode: 'timeline',
  }});
  assert.ok(first.id > 0);
  assert.equal(first.viewJson.labelOverrides?.[channel.seriesId], 'My label');
  assert.equal(first.viewJson.axisLabelOverrides?.left, 'Depth');
  assert.deepEqual((await analysisAPI.listViews()).map(row => row.name).sort(), ['Other view', 'Primary view']);
  await analysisAPI.deleteView(first.id);
  assert.deepEqual((await analysisAPI.listViews()).map(row => row.id), [second.id]);
  await assert.rejects(analysisAPI.deleteView(first.id));
  assert.deepEqual((await analysisAPI.listViews()).map(row => row.id), [second.id]);
  assert.equal((await systemAPI.getStats()).fan_value, sim.state.system.fanValue);
});

test('AN06 tidy export contains actual selected series data and quoted labels', () => {
  const csv = toTidyCsv([{seriesId: 's', resolved: {hubEui: null, zoneId: 2, cardType: 'soil', sourceKey: 'sensor,one', channelKey: 'swt_1'},
    label: 'Probe "A"', unit: 'kPa', coveragePct: 100, points: [{t: '2026-10-10T00:00:00.000Z', value: 0, count: 1, quality: null}], truncated: false,
    cadence: 'hourly', timezone: 'Africa/Kampala'}], new Map([['s', {seriesId: 's', hubEui: null, zoneId: 2, zoneName: 'Tomato plot', cardType: 'soil',
      sourceKey: 'sensor,one', channelKey: 'swt_1', displayName: 'Probe "A"', unit: 'kPa', availability: 'available', deviceName: 'Probe "A"', depthCm: null, sourceKind: 'device'}]]));
  assert.match(csv, /"Probe ""A"""/);
  assert.match(csv, /,kPa,0,$/);
  assert.match(csv, /"sensor,one"/);
});

test('I4-I5 analysis catalogue preserves source-specific history/depth/support with full-EUI separation', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const before = await analysisAPI.getChannels();
  const a1 = before.channels.find(row => row.deviceName === 'Tomato soil probe' && row.channelKey === 'swt_1')!;
  const a1Depth2 = before.channels.find(row => row.deviceName === 'Tomato soil probe' && row.channelKey === 'swt_2')!;
  assert.equal(a1.depthCm, 20);
  assert.equal(a1Depth2.depthCm, 40);
  const valve = before.sources?.find(row => row.typeId === 'STREGA_VALVE')!;
  assert.ok(valve.channelIds.length > 0);
  const network = before.sources?.find(row => row.typeId === 'RAK10701_FIELD_TESTER');
  assert.equal(network?.presentation, 'specialized');
  assert.equal(network?.destination, 'network');
  const sdi = before.sources?.find(row => row.typeId === 'DRAGINO_SDI12')!;
  assert.ok(before.channels.some(row => row.deviceSourceId === sdi.id && row.channelKey === 'vwc_2'));

  const historicalVwc = before.channels.find(row => row.deviceSourceId === sdi.id && row.channelKey === 'vwc_2')!;
  const sdiDevice = sim.devices.find(row => row.deveui === '00000000000000F5')!;
  Object.assign(sdiDevice, {sdi12_probe_profile: 'TENSIOMARK', sdi12_value_count: 1});
  const afterModeChange = await analysisAPI.getChannels();
  const preserved = afterModeChange.channels.find(row => row.seriesId === historicalVwc.seriesId)!;
  assert.equal(preserved.configurationState, 'other_supported');
  const history = await analysisAPI.getSeries({selectors: [{seriesId: preserved.seriesId}],
    range: {mode: 'absolute', label: 'custom', from: new Date(sim.now - 60 * 60_000).toISOString(), to: new Date(sim.now).toISOString()}, aggregation: 'raw'});
  assert.ok(history.series[0]?.points.length);

  const colliding = await devicesAPI.add({deveui: '12340000000000A1', name: 'Different physical probe', type_id: 'KIWI_SENSOR', zone_id: 1});
  sim.readings.append(colliding.deveui, sim.now - 10 * 60_000, {swt_1: 11});
  const afterCollision = await analysisAPI.getChannels();
  const newChannel = afterCollision.channels.find(row => row.deviceName === colliding.name && row.channelKey === 'swt_1')!;
  const originalChannel = afterCollision.channels.find(row => row.deviceName === 'Tomato soil probe' && row.channelKey === 'swt_1')!;
  assert.notEqual(newChannel.deviceSourceId, originalChannel.deviceSourceId);
  assert.notEqual(newChannel.sourceKey, originalChannel.sourceKey);
  assert.notEqual(newChannel.seriesId, originalChannel.seriesId);
  const [original, added] = await Promise.all([originalChannel, newChannel].map(channel => analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}],
    range: {mode: 'absolute', label: 'custom', from: new Date(sim.now - 60 * 60_000).toISOString(), to: new Date(sim.now).toISOString()}, aggregation: 'raw'})));
  assert.equal(original.series[0]?.label, 'Tomato soil probe - Soil tension 1');
  assert.equal(added.series[0]?.label, 'Different physical probe - Soil tension 1');
  assert.notDeepEqual(original.series[0]?.points.map(point => point.value), added.series[0]?.points.map(point => point.value));
});

test('R2 analysis uses native cumulative statistics and returns a typed invalid-aggregation error', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const source = sim.devices.find(device => device.deveui.endsWith('E1'))!;
  sim.readings.clear();
  const start = sim.now - 60 * 60_000;
  sim.readings.append(source.deveui, start, {rain_gauge_cumulative_mm: 10});
  sim.readings.append(source.deveui, start + 30 * 60_000, {rain_gauge_cumulative_mm: 20});
  const catalog = await analysisAPI.getChannels();
  const channel = catalog.channels.find(row => row.deviceName === source.name && row.channelKey === 'rain_gauge_cumulative_mm')!;
  const request = {selectors: [{seriesId: channel.seriesId}], range: {mode: 'absolute' as const, label: 'custom', from: new Date(start).toISOString(), to: new Date(start + 60 * 60_000).toISOString()}, aggregation: 'hourly'};
  const response = await analysisAPI.getSeries(request);
  assert.equal(edgeAnalysis.DEVICE_CHANNEL_AGGREGATION.rain_gauge_cumulative_mm, 'latest');
  for (const [channelKey, statistic] of Object.entries(edgeAnalysis.DEVICE_CHANNEL_AGGREGATION)) assert.equal(channelAggregationStatistic(channelKey), statistic);
  assert.equal(channelAggregationStatistic('valve_1_pulse'), 'latest');
  assert.equal(channelAggregationStatistic('valve_2_pulse'), 'latest');
  assert.equal(response.series[0]?.points[0]?.value, 20);
  await assert.rejects(analysisAPI.getSeries({...request, aggregation: 'bad-level'}), (error: any) => {
    assert.equal(error.response?.status, 422);
    assert.equal(error.response?.data?.error, 'invalid');
    return true;
  });
});

test('R3 LSN50 analysis families match native policy and retain flow ledger history', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const source = sim.devices.find(device => device.deveui.endsWith('E1'))!;
  const native = edgeSources.describeDeviceSource(source).families.map(row => [row.cardType, [...row.channelKeys].sort()]).sort((a, b) => a[0].localeCompare(b[0]));
  const browserSafe = Object.entries(describeDeviceSource(source).families).map(([family, channels]) => [family, [...channels].sort()]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(browserSafe, native);
  const channel = (await analysisAPI.getChannels()).channels.find(row => row.deviceName === source.name && row.channelKey === 'flow_liters_delta')!;
  assert.equal(channel.availability, 'available');
  sim.readings.append(source.deveui, sim.now, {flow_liters_delta: 3.25});
  const result = await analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}], range: {mode: 'absolute', label: 'custom',
    from: new Date(sim.now).toISOString(), to: new Date(sim.now + 1).toISOString()}, aggregation: 'raw'});
  assert.equal(result.series[0]?.points[0]?.value, 3.25);
});

test('I6 default views preserve unrelated rows and unknown positive IDs reject without mutation', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const viewJson = {schemaVersion: 1, selectors: [], range: {mode: 'relative', label: '24h', from: null, to: null}, mode: 'timeline'};
  const first = await analysisAPI.saveView({name: 'First default', viewJson, isDefault: true});
  const second = await analysisAPI.saveView({name: 'Second default', viewJson, isDefault: true});
  assert.ok(first.id > 0 && second.id > 0);
  const before = await analysisAPI.listViews();
  assert.deepEqual(before.map(row => row.id).sort(), [first.id, second.id].sort());
  await assert.rejects(api.post('/api/analysis/views', {...viewJson, id: 999, name: 'Unknown update', isDefault: false}));
  const after = await analysisAPI.listViews();
  assert.deepEqual(after.map(row => [row.id, row.name, row.isDefault]).sort(), before.map(row => [row.id, row.name, row.isDefault]).sort());
});
