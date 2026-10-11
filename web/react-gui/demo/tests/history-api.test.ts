import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {analysisAPI, api, devicesAPI, historyAPI, historyExportAPI, HistoryExportError, sensorAPI, zoneExportAPI} from '../../src/services/api';
import {createDemoAdapter} from '../adapter';
import {localDateKey, localMidnight} from '../model/aggregation';
import {Simulator} from '../model';
const require = createRequire(import.meta.url);
const edgeHistory = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js') as Record<string, any>;

function install(sim: Simulator): void { api.defaults.adapter = createDemoAdapter(sim); }
const workspace = {schemaVersion: 1 as const, farmId: null, hubId: null, zoneId: 1, zoneUuid: null, selectedCards: ['soil'],
  panelOrder: ['soil'], collapsedPanels: [], dateRange: {mode: 'relative' as const, label: '7d' as const, from: null, to: null}, aggregation: 'auto' as const,
  viewModesByCard: {soil: 'line-chart' as const}, enabledOverlays: {soil: ['rain-events' as const]}, advancedOverlaySettings: {},
  limits: {maxPanels: 4, platform: 'edge' as const}, inspector: {selectedTimestamp: null, open: false}, pinnedCards: [], layout: 'stacked' as const};

test('HI01-04 cards derive source availability and preferences persist with opened history', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const first = await historyAPI.getZoneCards(1);
  const soil = first.cards.find(row => row.cardType === 'soil')!;
  assert.ok(soil);
  assert.equal(soil.availability.available, true);
  assert.ok((soil.sourceDeviceCount ?? 0) > 0);
  const changed = await historyAPI.setZoneCardPreference(1, soil.cardId, {pinned: true, manualOrder: 3, hidden: true, lastViewMode: 'line-chart'});
  assert.equal(changed.pinned, true);
  assert.equal(changed.hidden, true);
  assert.equal(changed.manualOrder, 3);
  assert.equal(changed.lastViewMode, 'line-chart');
  const opened = await historyAPI.markZoneCardOpened(1, soil.cardId, {lastViewMode: 'soil-profile'});
  assert.equal(opened.openCount, 1);
  assert.equal(opened.lastViewMode, 'soil-profile');
  assert.equal(opened.pinned, true);
  assert.equal(opened.hidden, true);
  assert.equal(opened.manualOrder, 3);
  const reopened = await historyAPI.markZoneCardOpened(1, soil.cardId, {lastViewMode: 'soil-profile'});
  assert.equal(reopened.openCount, 2);
  assert.ok(Date.parse(reopened.lastOpenedAt!) >= Date.parse(opened.lastOpenedAt!));
  const reopenedCards = await historyAPI.getZoneCards(1);
  assert.equal(reopenedCards.cards.find(row => row.cardId === soil.cardId)?.ordering.pinned, true);
  const beforeCount = (await historyAPI.getZoneCards(2)).cards.find(row => row.cardType === 'soil')?.sourceDeviceCount ?? 0;
  const added = await devicesAPI.add({deveui: '00000000000000B1', name: 'History source', type_id: 'KIWI_SENSOR'});
  await api.put(`/api/irrigation-zones/2/devices/${added.deveui}`, {});
  assert.equal((await historyAPI.getZoneCards(2)).cards.find(row => row.cardType === 'soil')?.sourceDeviceCount, beforeCount + 1);
});

test('HI02 gateway hub history uses fictional status samples from the shared simulation clock', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const gateway = await historyAPI.getGatewayCards('00000000000000D0');
  const card = gateway.cards[0]!;
  const response = await historyAPI.getGatewayCardData('00000000000000D0', card.cardId, {
    view: 'status-overview', range: {label: '24h', from: new Date(sim.now - 3600000).toISOString(), to: new Date(sim.now + 1).toISOString(), timezone: 'Africa/Kampala'},
    aggregation: 'raw', overlays: ['data-gaps'],
  });
  assert.ok(response.series.some(row => row.id === 'cpu_temp_c' && row.points.some(point => typeof point.value === 'number')));
  assert.equal(response.freshness.dataAsOf, new Date(sim.now).toISOString());
});

test('I10 gateway current status is absent from past and future requested ranges', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const card = (await historyAPI.getGatewayCards('00000000000000D0')).cards[0]!;
  for (const [from, to] of [[sim.now - 2 * 86400000, sim.now - 86400000], [sim.now + 86400000, sim.now + 2 * 86400000]]) {
    const response = await historyAPI.getGatewayCardData('00000000000000D0', card.cardId, {view: 'status-overview',
      range: {label: 'custom', from: new Date(from).toISOString(), to: new Date(to).toISOString(), timezone: 'Africa/Kampala'}, aggregation: 'raw', overlays: []});
    assert.ok(response.series.every(row => row.points.length === 0));
    assert.equal(response.freshness.dataAsOf, null);
    assert.equal(response.aggregation.coveragePct, null);
  }
});

test('HI05-06 history detail and advanced response use selected source readings and reject invalid range/view', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const soil = (await historyAPI.getZoneCards(1)).cards.find(row => row.cardType === 'soil')!;
  const request = {view: 'line-chart' as const, range: {label: '24h' as const, from: new Date(sim.now - 3600000).toISOString(), to: new Date(sim.now).toISOString(), timezone: 'Africa/Kampala'},
    aggregation: 'raw' as const, overlays: ['data-gaps' as const], sourceKey: soil.sourceDevices?.[0]?.sourceKey ?? undefined};
  const detail = await historyAPI.getZoneCardData(1, soil.cardId, request);
  assert.equal(detail.cardType, 'soil');
  assert.ok(detail.series.some(row => row.points.some(point => typeof point.value === 'number')));
  const advanced = await historyAPI.getZoneCardAdvanced(1, soil.cardId, {...request, view: 'advanced'});
  assert.equal(advanced.cardId, soil.cardId);
  assert.equal(advanced.placeholder.placeholder, true);
  await assert.rejects(historyAPI.getZoneCardData(1, soil.cardId, {...request, range: {...request.range, label: 'custom', from: null, to: null}}));
});

test('I1-I2 soil detail derives profiles, calendar and diagnostics while aggregation changes ledger values', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const soil = (await historyAPI.getZoneCards(1)).cards.find(row => row.cardType === 'soil')!;
  const sourceName = sim.devices.find(device => device.deveui.endsWith('A1'))!.name;
  const source = soil.sourceDevices?.find(row => row.name === sourceName)!;
  const base = {range: {label: 'custom' as const, from: new Date(sim.now - 60 * 60_000).toISOString(), to: new Date(sim.now).toISOString(), timezone: 'Africa/Kampala'},
    aggregation: 'raw' as const, overlays: [] as const, sourceKey: source.sourceKey!};
  const profile = await historyAPI.getZoneCardData(1, soil.cardId, {...base, view: 'soil-profile'});
  const [shallowHistory, deepHistory] = await Promise.all([
    sensorAPI.getHistory('00000000000000A1', 'swt_1', 1), sensorAPI.getHistory('00000000000000A1', 'swt_2', 1),
  ]);
  const batteryHistory = await sensorAPI.getHistory('00000000000000A1', 'bat_pct', 1);
  const priorValue = (rows: typeof shallowHistory) => rows.filter(row => Date.parse(row.t) < sim.now).at(-1)?.value;
  assert.deepEqual(profile.profiles.map(row => [row.depthCm, row.value]), [[20, priorValue(shallowHistory)], [40, priorValue(deepHistory)]]);
  const calendar = await historyAPI.getZoneCardData(1, soil.cardId, {...base, view: 'calendar'});
  const nativeCalendar = edgeHistory.buildCalendar({cardType: 'soil', timezone: 'Africa/Kampala',
    range: {from: base.range.from, to: base.range.to}, generatedAt: new Date(sim.now).toISOString(),
    rows: sim.readings.forDevice(sim.devices.find(device => device.name === sourceName)!.deveui).filter(row => row.at >= sim.now - 60 * 60_000 && row.at < sim.now)
      .map(row => ({swt_1: row.values.swt_1, swt_2: row.values.swt_2, recorded_at: new Date(row.at).toISOString()}))});
  assert.equal(calendar.calendar?.days.find(row => row.date === '2026-10-10')?.state, nativeCalendar.days.find((row: {date: string}) => row.date === '2026-10-10')?.state);
  assert.equal(calendar.calendar?.days.find(row => row.date === '2026-10-10')?.state, 'optimal');
  assert.equal(calendar.calendar?.days.find(row => row.date === '2026-10-10')?.metrics?.sampleCount, 2);
  const advanced = await historyAPI.getZoneCardAdvanced(1, soil.cardId, {...base, view: 'advanced'});
  assert.equal(advanced.advancedFields.batteryPct?.value, priorValue(batteryHistory));
  assert.equal(advanced.advancedFields.batteryPct?.availability, 'collected');
  assert.equal(advanced.advancedFields.primaryDeveui?.value, '00000000000000A1');

  const channel = (await analysisAPI.getChannels()).channels.find(row => row.deviceName === sourceName && row.channelKey === 'swt_1')!;
  const analysisRange = {mode: 'absolute', label: 'custom', from: new Date(sim.now - 3 * 60 * 60_000).toISOString(), to: base.range.to};
  const raw = await analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}], range: analysisRange, aggregation: 'raw'});
  const hourly = await analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}], range: analysisRange, aggregation: 'hourly'});
  const daily = await analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}], range: analysisRange, aggregation: 'daily'});
  const automatic = await analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}], range: analysisRange, aggregation: 'auto'});
  assert.equal(raw.aggregation.applied, 'raw');
  assert.equal(raw.series[0]?.points.length, 6);
  assert.equal(hourly.aggregation.applied, 'hourly');
  assert.ok(hourly.series[0]!.points.length < raw.series[0]!.points.length);
  const mergedHour = hourly.series[0]!.points.find(point => point.count === 2)!;
  assert.ok(mergedHour);
  const hourStart = Date.parse(mergedHour.t), sourceRows = raw.series[0]!.points.filter(point => Date.parse(point.t) >= hourStart && Date.parse(point.t) < hourStart + 3600000);
  assert.equal(mergedHour.value, Number((sourceRows.reduce((sum, point) => sum + Number(point.value), 0) / sourceRows.length).toFixed(3)));
  assert.equal(daily.aggregation.applied, 'daily');
  assert.equal(daily.series[0]?.points.length, 1);
  assert.equal(automatic.aggregation.applied, 'raw');
  const cardData = await historyAPI.getZoneCardData(1, soil.cardId, {...base, view: 'line-chart', aggregation: 'hourly'});
  assert.equal(cardData.aggregation.level, 'hourly');
  assert.ok(cardData.aggregation.bucketSizeSeconds);
  assert.equal(cardData.series.find(row => row.id.endsWith(':swt_1'))?.points.reduce((sum, point) => sum + (point.count ?? 0), 0), 2);
  await assert.rejects(analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}], range: analysisRange, aggregation: 'invalid' as never}));
  await assert.rejects(historyAPI.getZoneCardData(1, soil.cardId, {...base, view: 'definitely-invalid' as never}));
});

test('R1 calendars, profiles and interpretations follow native classifiers over half-open source samples', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const from = sim.now - 60 * 60_000, to = sim.now + 1;
  for (const [zoneId, suffix, type, expected] of [[2, 'F2', 'environment', 'normal'], [2, 'E3', 'dendro', 'incomplete_night_recovery']] as const) {
    const device = sim.devices.find(row => row.deveui.endsWith(suffix))!;
    const card = (await historyAPI.getZoneCards(zoneId)).cards.find(row => row.cardType === type)!;
    const source = card.sourceDevices?.find(row => row.name === device.name)!;
    const rows = sim.readings.forDevice(device.deveui).filter(row => row.at >= from && row.at < to);
    const native = edgeHistory.buildCalendar({cardType: type, timezone: 'Africa/Kampala', range: {from: new Date(from).toISOString(), to: new Date(to).toISOString()},
      generatedAt: new Date(sim.now).toISOString(), rows: rows.map(row => ({...row.values, recorded_at: new Date(row.at).toISOString()}))});
    const response = await historyAPI.getZoneCardData(zoneId, card.cardId, {view: 'calendar', range: {label: 'custom', from: new Date(from).toISOString(),
      to: new Date(to).toISOString(), timezone: 'Africa/Kampala'}, aggregation: 'raw', overlays: [], sourceKey: source.sourceKey});
    const expectedDay = native.days.find((row: {date: string}) => row.date === '2026-10-10');
    const actualDay = response.calendar?.days.find(row => row.date === '2026-10-10');
    assert.equal(actualDay?.state, expected);
    assert.equal(actualDay?.state, expectedDay?.state);
    assert.equal(actualDay?.metrics?.sampleCount, rows.length);
    if (suffix === 'E3') {
      const nativeInterpretation = edgeHistory.buildLocalInterpretations({cardType: 'dendro', status: expected, dendroStatus: expected,
        generatedAt: new Date(sim.now).toISOString(), coverageConfidence: response.aggregation.coverageConfidence,
        coveragePct: response.aggregation.coveragePct, rangeFrom: new Date(from).toISOString(),
        recoveryRatio: rows[rows.length - 1]?.values.dendro_ratio}).find((item: any) => item.ruleId === 'incomplete-night-recovery');
      const actualInterpretation = response.interpretations.find((item: any) => item.ruleId === 'incomplete-night-recovery');
      assert.deepEqual(actualInterpretation && {ruleId: actualInterpretation.ruleId, severity: actualInterpretation.severity,
        titleKey: actualInterpretation.titleKey, bodyKey: actualInterpretation.bodyKey, params: actualInterpretation.params,
        evidence: actualInterpretation.evidence, source: actualInterpretation.source}, nativeInterpretation);
    }
  }

  const irrigation = (await historyAPI.getZoneCards(1)).cards.find(row => row.cardType === 'irrigation')!;
  const valve = sim.devices.find(row => row.type_id === 'STREGA_VALVE' && row.irrigation_zone_id === 1)!;
  await devicesAPI.controlValve(valve.deveui, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  const outcome = sim.outcomes[0]!;
  const irrigationRange = {label: 'custom' as const, from: new Date(Date.parse(outcome.commandedAt) - 1000).toISOString(),
    to: new Date(sim.now + 1).toISOString(), timezone: 'Africa/Kampala'};
  const irrigationDetail = await historyAPI.getZoneCardData(1, irrigation.cardId, {view: 'calendar', range: irrigationRange, aggregation: 'raw', overlays: []});
  const nativeIrrigation = edgeHistory.buildCalendar({cardType: 'irrigation', timezone: irrigationRange.timezone,
    range: {from: irrigationRange.from, to: irrigationRange.to}, generatedAt: new Date(sim.now).toISOString(),
    events: [{t: outcome.observedOpenAt ?? outcome.commandedAt, type: outcome.trigger}]});
  assert.equal(irrigationDetail.calendar?.days[0]?.state, nativeIrrigation.days[0]?.state);
  assert.equal(irrigationDetail.calendar?.days[0]?.state, 'manual_override');

  const gatewayCard = (await historyAPI.getGatewayCards('00000000000000D0')).cards[0]!;
  const gatewayRange = {label: 'custom' as const, from: new Date(sim.now - 60 * 60_000).toISOString(),
    to: new Date(sim.now + 1).toISOString(), timezone: 'Africa/Kampala'};
  const gatewayDetail = await historyAPI.getGatewayCardData('00000000000000D0', gatewayCard.cardId,
    {view: 'status-overview', range: gatewayRange, aggregation: 'raw', overlays: []});
  const nativeGateway = edgeHistory.buildCalendar({cardType: 'gateway', timezone: gatewayRange.timezone,
    range: {from: gatewayRange.from, to: gatewayRange.to}, generatedAt: new Date(sim.now).toISOString(),
    rows: [{recorded_at: new Date(sim.now).toISOString(), lastSeenAt: new Date(sim.now).toISOString()}]});
  assert.equal(gatewayDetail.calendar?.days[0]?.state, nativeGateway.days[0]?.state);

  const a1 = sim.devices.find(row => row.deveui.endsWith('A1'))!;
  const mutable = a1 as typeof a1 & {chameleon_swt1_depth_cm?: number; soil_moisture_probe_depths_json?: Record<string, number> | null};
  mutable.soil_moisture_probe_depths_json = null;
  mutable.chameleon_swt1_depth_cm = 25;
  sim.readings.append(a1.deveui, sim.now, {swt_1: 48, swt_2: 48});
  const soil = (await historyAPI.getZoneCards(1)).cards.find(row => row.cardType === 'soil')!;
  const source = soil.sourceDevices?.find(row => row.name === a1.name)!;
  const exactRange = {label: 'custom' as const, from: new Date(sim.now).toISOString(), to: new Date(to).toISOString(), timezone: 'Africa/Kampala'};
  const profile = await historyAPI.getZoneCardData(1, soil.cardId, {view: 'soil-profile', range: exactRange, aggregation: 'raw', overlays: [], sourceKey: source.sourceKey});
  assert.deepEqual(profile.profiles.map(row => [row.id.slice(row.id.lastIndexOf(':') + 1), row.depthCm, row.value]), [['swt_1', 25, 48], ['swt_2', null, 48]]);
  assert.equal(edgeHistory.soilDepthCm(mutable, 'swt_1'), profile.profiles[0]?.depthCm);
  const rows = [{swt_1: 48, swt_2: 48, recorded_at: new Date(sim.now).toISOString()}];
  const native = edgeHistory.buildCalendar({cardType: 'soil', timezone: 'Africa/Kampala', range: exactRange, rows});
  const calendar = await historyAPI.getZoneCardData(1, soil.cardId, {view: 'calendar', range: exactRange, aggregation: 'raw', overlays: [], sourceKey: source.sourceKey});
  assert.equal(calendar.calendar?.days[0]?.state, edgeHistory.classifySoilStatus({swt_1: 48, swt_2: 48}).status);
  assert.equal(calendar.calendar?.days[0]?.state, native.days[0]?.state);
  assert.notEqual(calendar.calendar?.days[0]?.state, 'dry_stress');
  const broadRange = {label: '7d' as const, from: new Date(sim.now - 7 * 86400000).toISOString(), to: new Date(to).toISOString(), timezone: 'Africa/Kampala'};
  const latestInterpretations = await historyAPI.getZoneCardData(1, soil.cardId, {view: 'advanced', range: broadRange, aggregation: 'daily', overlays: [], sourceKey: source.sourceKey});
  assert.ok(!latestInterpretations.interpretations.some(row => row.ruleId === 'root-zone-dry'));
});

test('R1 environment null measurements match native no-data classification', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const device = sim.devices.find(row => row.deveui.endsWith('F2'))!;
  const timestamp = sim.now - 1000;
  const values = {ambient_temperature: null, relative_humidity: null, rain_mm_today: null, rain_mm_delta: null, rain_mm_per_hour: null};
  sim.readings.append(device.deveui, timestamp, values);
  const card = (await historyAPI.getZoneCards(2)).cards.find(row => row.cardType === 'environment')!;
  const source = card.sourceDevices?.find(row => row.name === device.name)!;
  const range = {label: 'custom' as const, from: new Date(sim.now - 2000).toISOString(), to: new Date(sim.now).toISOString(), timezone: 'Africa/Kampala'};
  const response = await historyAPI.getZoneCardData(2, card.cardId, {view: 'calendar', range, aggregation: 'raw', overlays: [], sourceKey: source.sourceKey});
  const native = edgeHistory.buildCalendar({cardType: 'environment', timezone: range.timezone, range: {from: range.from, to: range.to},
    generatedAt: new Date(sim.now).toISOString(), rows: [{...values, recorded_at: new Date(timestamp).toISOString()}]});
  assert.equal(response.calendar?.days[0]?.state, native.days[0]?.state);
  assert.equal(response.calendar?.days[0]?.state, 'no_data');
});

test('R1 ratio-only dendro readings use native healthy-evidence fallback', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const device = sim.devices.find(row => row.deveui.endsWith('E3'))!;
  const timestamp = sim.now - 1000;
  const values = {dendro_ratio: 0.6, dendro_stem_change_um: null};
  sim.readings.append(device.deveui, timestamp, values);
  const card = (await historyAPI.getZoneCards(2)).cards.find(row => row.cardType === 'dendro')!;
  const source = card.sourceDevices?.find(row => row.name === device.name)!;
  const range = {label: 'custom' as const, from: new Date(sim.now - 2000).toISOString(), to: new Date(sim.now).toISOString(), timezone: 'Africa/Kampala'};
  const response = await historyAPI.getZoneCardData(2, card.cardId, {view: 'calendar', range, aggregation: 'raw', overlays: [], sourceKey: source.sourceKey});
  const native = edgeHistory.buildCalendar({cardType: 'dendro', timezone: range.timezone, range: {from: range.from, to: range.to},
    generatedAt: new Date(sim.now).toISOString(), rows: [{...values, recorded_at: new Date(timestamp).toISOString()}]});
  assert.equal(response.calendar?.days[0]?.state, native.days[0]?.state);
  assert.equal(response.calendar?.days[0]?.state, 'normal_growth');
});

test('R2 buckets, coverage, date boundaries, truncation and aggregation errors match native ranges', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const added = await devicesAPI.add({deveui: '00000000000000C1', name: 'Sparse history probe', type_id: 'KIWI_SENSOR'});
  await api.put(`/api/irrigation-zones/1/devices/${added.deveui}`, {});
  sim.readings.clear();
  const start = sim.now - 3 * 3600000 + 15 * 60000;
  sim.readings.append(added.deveui, start, {swt_1: 1, swt_2: 1});
  sim.readings.append(added.deveui, start + 30 * 60000, {swt_1: 2, swt_2: 2});
  const card = (await historyAPI.getZoneCards(1)).cards.find(row => row.cardType === 'soil')!;
  const source = card.sourceDevices?.find(row => row.name === 'Sparse history probe')!;
  const request = {view: 'line-chart' as const, range: {label: 'custom' as const, from: new Date(start).toISOString(), to: new Date(start + 2 * 3600000).toISOString(), timezone: 'Africa/Kampala'},
    aggregation: 'hourly' as const, overlays: [] as const, sourceKey: source.sourceKey!};
  const result = await historyAPI.getZoneCardData(1, card.cardId, request);
  const rows = sim.readings.forDevice(added.deveui).map(row => ({deviceEui: row.deviceEui, recorded_at: new Date(row.at).toISOString(), ...row.values}));
  const native = edgeHistory.aggregateRows(rows, {aggregation: 'hourly', start: request.range.from, end: request.range.to, timezone: 'Africa/Kampala', nowMs: sim.now,
    channels: [{id: 'swt_1', field: 'swt_1', unit: 'kPa'}, {id: 'swt_2', field: 'swt_2', unit: 'kPa'}]});
  const series = result.series.find(row => row.label.startsWith('Sparse history probe - Soil tension 1'))!;
  assert.equal(result.aggregation.coveragePct, native.coveragePct);
  assert.deepEqual(series.points.map(point => [point.t, point.bucketEnd, point.count, point.coveragePct]),
    native.buckets.map((bucket: any) => [bucket.bucketStart, bucket.bucketEnd, bucket.series.swt_1.sampleCount, bucket.coveragePct]));
  assert.equal(result.aggregation.coveragePct, 50);
  const oneBucket = await historyAPI.getZoneCardData(1, card.cardId, {...request,
    range: {...request.range, to: new Date(start + 3600000).toISOString()}});
  const first = oneBucket.series.find(row => row.id === `${added.deveui}:swt_1`)!;
  assert.equal(first.points.length, 1);
  assert.equal(first.points[0]?.t, new Date(start).toISOString());

  const timezone = 'America/Santiago', date = '2026-09-06';
  const nativeBoundary = edgeHistory.startOfLocalDayMs(Date.parse(`${date}T12:00:00.000Z`), timezone);
  const boundary = localMidnight(date, timezone);
  assert.equal(boundary, nativeBoundary);
  assert.equal(localDateKey(boundary, timezone), date);
  assert.ok(localMidnight('2026-09-07', timezone) > boundary);

  const seeded = new Simulator({mode: 'public'}); install(seeded);
  const seededCard = (await historyAPI.getZoneCards(1)).cards.find(row => row.cardType === 'soil')!;
  const longRange = {label: 'custom' as const, from: new Date(seeded.now - 90 * 86400000).toISOString(), to: new Date(seeded.now + 1).toISOString(), timezone: 'Africa/Kampala'};
  const truncated = await historyAPI.getZoneCardData(1, seededCard.cardId, {view: 'line-chart', range: longRange, aggregation: 'raw', overlays: []});
  assert.ok(truncated.series.some(row => row.truncated));
  assert.equal(truncated.limits.truncated, true);
  await assert.rejects(historyAPI.getZoneCardData(1, seededCard.cardId, {...request, aggregation: 'invalid' as never}), (error: any) => {
    assert.equal(error.response?.status, 400);
    assert.equal(error.response?.data?.error, 'invalid_aggregation');
    return true;
  });
});

test('R3 LSN50 flow export contains real selected flow readings', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const source = sim.devices.find(device => device.deveui.endsWith('E1'))!;
  sim.readings.append(source.deveui, sim.now, {flow_liters_delta: 3.25});
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalDocument = globalThis.document;
  const blobs: Blob[] = [];
  URL.createObjectURL = ((blob: Blob) => { blobs.push(blob); return `blob:flow-${blobs.length}`; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  const anchor = {href: '', download: '', click() {}, remove() {}};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => anchor, body: {appendChild() {}}}});
  try {
    await zoneExportAPI.download(1, {from: '2026-10-10', to: '2026-10-10', granularity: 'raw', channels: ['flow_liters_delta']});
    const csv = await blobs[0]!.text();
    const row = csv.split('\r\n').find(line => line.includes('flow_liters_delta') && line.split(',')[10] === '3.25')!;
    assert.ok(row);
    assert.equal(row.split(',')[10], '3.25');
  } finally {
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    Object.defineProperty(globalThis, 'document', {configurable: true, value: originalDocument});
  }
});

test('R4 SWT exports include native raw and aggregated pF companion rows', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const a1 = sim.devices.find(device => device.deveui.endsWith('A1'))!;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalDocument = globalThis.document;
  const blobs: Blob[] = [];
  URL.createObjectURL = ((blob: Blob) => { blobs.push(blob); return `blob:pf-${blobs.length}`; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  const anchor = {href: '', download: '', click() {}, remove() {}};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => anchor, body: {appendChild() {}}}});
  try {
    sim.readings.clear();
    sim.readings.append(a1.deveui, sim.now - 10000, {swt_1: 48, swt_2: 0});
    sim.readings.append(a1.deveui, sim.now, {swt_1: 0, swt_2: null});
    await zoneExportAPI.download(1, {from: '2026-10-10', to: '2026-10-10', granularity: 'raw', channels: ['swt_1', 'swt_2', 'swt_3']});
    const rawRows = (await blobs[0]!.text()).split('\r\n').slice(1).filter(Boolean).map(line => line.split(','));
    const rawPf = rawRows.filter(row => row[6]?.endsWith('_pf'));
    assert.deepEqual(rawPf.filter(row => row[6] === 'swt_1_pf').map(row => Number(row[10])), [2.6812, 0]);
    assert.deepEqual(rawPf.filter(row => row[6] === 'swt_2_pf').map(row => Number(row[10])), [0]);
    assert.ok(!rawPf.some(row => row[6] === 'swt_3_pf'));

    sim.readings.clear();
    sim.readings.append(a1.deveui, sim.now, {swt_1: 48, swt_2: 0, swt_3: null});
    await zoneExportAPI.download(1, {from: '2026-10-10', to: '2026-10-10', granularity: 'daily', channels: ['swt_1', 'swt_2', 'swt_3']});
    const dailyRows = (await blobs[1]!.text()).split('\r\n').slice(1).filter(Boolean).map(line => line.split(','));
    const dailyPf = dailyRows.filter(row => row[6]?.endsWith('_pf'));
    assert.equal(Number(dailyPf.find(row => row[6] === 'swt_1_pf')?.[10]), Number(edgeHistory.kpaToPf(48).toFixed(4)));
    assert.equal(Number(dailyPf.find(row => row[6] === 'swt_2_pf')?.[10]), 0);
    assert.ok(!dailyPf.some(row => row[6] === 'swt_3_pf'));
  } finally {
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    Object.defineProperty(globalThis, 'document', {configurable: true, value: originalDocument});
  }
});

test('I3 completed valve command becomes a bounded irrigation event with actuation identity and lifecycle timestamps', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const valve = sim.devices.find(device => device.type_id === 'STREGA_VALVE' && device.irrigation_zone_id === 1)!;
  await devicesAPI.controlValve(valve.deveui, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  const command = sim.outcomes[0]!;
  assert.equal(command.status, 'PENDING_OPEN');
  sim.advanceTo(sim.now + 62_000);
  const completed = sim.outcomes.find(row => row.expectationId === command.expectationId)!;
  assert.equal(completed.status, 'COMPLETED');
  assert.ok(completed.observedOpenAt);
  assert.ok(completed.observedCloseAt);
  const card = (await historyAPI.getZoneCards(1)).cards.find(row => row.cardType === 'irrigation')!;
  const detail = await historyAPI.getZoneCardData(1, card.cardId, {view: 'event-timeline',
    range: {label: 'custom', from: new Date(Date.parse(command.commandedAt) - 1000).toISOString(), to: new Date(sim.now).toISOString(), timezone: 'Africa/Kampala'},
    aggregation: 'raw', overlays: ['irrigation-events'], sourceKey: card.sourceDevices?.[0]?.sourceKey});
  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0]?.id, completed.expectationId);
  assert.equal(detail.events[0]?.t, completed.observedOpenAt);
  assert.equal(detail.events[0]?.end, completed.observedCloseAt);
  assert.equal(detail.events[0]?.metadata.status, 'COMPLETED');
  assert.equal(detail.events[0]?.metadata.estimatedGrossLiters, completed.estimatedGrossLiters);
  assert.equal(detail.events[0]?.metadata.deviceEui, valve.deveui);
});

test('I7 rejected preference/open writes are atomic and recent ranks follow actual open time', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const cards = (await historyAPI.getZoneCards(1)).cards;
  const soil = cards.find(row => row.cardType === 'soil')!, environment = cards.find(row => row.cardType === 'environment')!;
  const initial = await historyAPI.setZoneCardPreference(1, soil.cardId, {pinned: false});
  assert.equal(initial.pinned, false);
  await assert.rejects(historyAPI.setZoneCardPreference(1, soil.cardId, {pinned: true, manualOrder: -1}));
  assert.equal((await historyAPI.getZoneCards(1)).cards.find(row => row.cardId === soil.cardId)?.ordering.pinned, false);
  await assert.rejects(historyAPI.markZoneCardOpened(1, soil.cardId, {lastViewMode: 'not-a-view' as never}));
  const firstOpen = await historyAPI.markZoneCardOpened(1, soil.cardId, {lastViewMode: 'soil-profile'});
  assert.equal(firstOpen.openCount, 1);
  sim.advanceTo(sim.now + 60_000);
  const secondOpen = await historyAPI.markZoneCardOpened(1, environment.cardId, {lastViewMode: 'line-chart'});
  assert.equal(secondOpen.openCount, 1);
  const reopenedCards = (await historyAPI.getZoneCards(1)).cards;
  assert.equal(reopenedCards.find(row => row.cardId === environment.cardId)?.ordering.recentRank, 1);
  assert.equal(reopenedCards.find(row => row.cardId === soil.cardId)?.ordering.recentRank, 2);
});

test('I9 zone CSV uses local calendar days, channel metadata and rainfall delta sums', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, originalDocument = globalThis.document;
  const blobs: Blob[] = [];
  URL.createObjectURL = ((blob: Blob) => { blobs.push(blob); return `blob:local-day-${blobs.length}`; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  const anchor = {href: '', download: '', click() {}, remove() {}};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => anchor, body: {appendChild() {}}}});
  try {
    await zoneExportAPI.download(1, {from: '2026-10-10', to: '2026-10-10', granularity: 'raw', channels: ['swt_1']});
    const rawLines = (await blobs[0]!.text()).split('\r\n');
    const depthRow = rawLines.find(line => line.includes('Tomato soil probe') && line.includes(',swt_1,'))!;
    assert.match(depthRow, /^2026-10-09T21:/);
    assert.equal(depthRow.split(',')[7], '20');

    const rainSource = sim.devices.find(device => device.deveui === '00000000000000F3')!;
    const localToday = '2026-10-10';
    const rangeStart = Date.parse('2026-10-09T21:00:00.000Z'), rangeEnd = Date.parse('2026-10-10T21:00:00.000Z');
    const localSamples = sim.readings.forDevice(rainSource.deveui).filter(sample => sample.at >= rangeStart && sample.at < rangeEnd);
    for (const sample of localSamples) sim.readings.append(rainSource.deveui, sample.at, {rain_mm_delta: 0});
    sim.readings.append(rainSource.deveui, localSamples[localSamples.length - 3]!.at, {rain_mm_delta: 0.4});
    sim.readings.append(rainSource.deveui, localSamples[localSamples.length - 2]!.at, {rain_mm_delta: 0.6});
    await zoneExportAPI.download(1, {from: localToday, to: localToday, granularity: 'daily', channels: ['rain_mm_delta']});
    const rainLines = (await blobs[1]!.text()).split('\r\n');
    const rainRow = rainLines.find(line => line.includes('LoRain gauge') && line.includes(',rain_mm_delta,'))!;
    assert.equal(rainRow.split(',')[10], '1');
    assert.ok(!rainLines.some(line => line.includes('lsn50_mode_label')));
  } finally {
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    Object.defineProperty(globalThis, 'document', {configurable: true, value: originalDocument});
  }
});

test('HI07-10 workspaces create, update defaults, read back, and delete a dependent row', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const created = await historyAPI.createWorkspace({name: 'Field view', zoneId: 1, workspace, isDefault: true});
  assert.ok(created.id > 0);
  assert.equal(created.isDefault, true);
  const beforeInvalidZone = (await historyAPI.getWorkspaces()).workspaces;
  await assert.rejects(historyAPI.createWorkspace({name: 'Invalid zone', zoneId: 999, workspace, isDefault: true}));
  assert.deepEqual((await historyAPI.getWorkspaces()).workspaces.map(row => row.id), beforeInvalidZone.map(row => row.id));
  const fallback = await historyAPI.createWorkspace({name: 'Zone two fallback', zoneId: 2, workspace: {...workspace, zoneId: 2}, isDefault: false});
  const other = await historyAPI.createWorkspace({name: 'Other view', zoneId: 2, workspace: {...workspace, zoneId: 2}, isDefault: true});
  let records = (await historyAPI.getWorkspaces()).workspaces;
  assert.equal(records.find(row => row.id === created.id)?.isDefault, true);
  assert.equal(records.find(row => row.id === other.id)?.isDefault, true);
  const updated = await historyAPI.updateWorkspace(created.id, {name: 'Updated view', isDefault: true,
    workspace: {...workspace, selectedCards: ['soil', 'environment'], panelOrder: ['environment', 'soil']}});
  assert.equal(updated.name, 'Updated view');
  records = (await historyAPI.getWorkspaces()).workspaces;
  assert.deepEqual(records.find(row => row.id === created.id)?.workspace.panelOrder, ['environment', 'soil']);
  await historyAPI.deleteWorkspace(other.id);
  records = (await historyAPI.getWorkspaces()).workspaces;
  assert.deepEqual(records.map(row => row.id).sort(), [created.id, fallback.id].sort());
  assert.equal(records.find(row => row.id === created.id)?.isDefault, true);
  assert.equal(records.find(row => row.id === fallback.id)?.isDefault, true);
  await historyAPI.deleteWorkspace(fallback.id);
  await historyAPI.deleteWorkspace(created.id);
  assert.equal((await historyAPI.getWorkspaces()).workspaces.length, 0);
});

test('HI11-12 exports produce CSV bytes from ledger and preserve typed JSON error bodies', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalDocument = globalThis.document;
  const blobs: Blob[] = [];
  URL.createObjectURL = ((blob: Blob) => { blobs.push(blob); return `blob:history-${blobs.length}`; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  const anchor = {href: '', download: '', click() {}, remove() {}};
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => anchor, body: {appendChild() {}}}});
  try {
    const from = new Date(sim.now).toISOString().slice(0, 10), to = from;
    await zoneExportAPI.download(1, {from, to, granularity: 'raw', channels: ['swt_1']});
    await historyExportAPI.downloadAllZones({from, to, granularity: 'raw'});
    assert.equal(blobs.length, 2);
    assert.match(await blobs[0]!.text(), /swt_1/);
    assert.match(await blobs[0]!.text(), /45|46/);
    assert.match(await blobs[1]!.text(), /zone/);
    await assert.rejects(historyExportAPI.downloadAllZones({from: 'bad', to, granularity: 'raw'}), error => {
      assert.ok(error instanceof HistoryExportError);
      assert.equal(error.status, 400);
      assert.match(error.suggestion ?? '', /valid/);
      return true;
    });
    await assert.rejects(zoneExportAPI.download(999, {from, to, granularity: 'raw'}));
  } finally {
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    Object.defineProperty(globalThis, 'document', {configurable: true, value: originalDocument});
  }
});
