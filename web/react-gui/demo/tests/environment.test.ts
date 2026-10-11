import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {analysisAPI, api, environmentAPI, historyAPI, irrigationZonesAPI} from '../../src/services/api';
import {createDemoAdapter} from '../adapter';
import {Simulator} from '../model';
import {buildForecast, seedCompletedEnvironmentRecords, selectedWeatherProvider} from '../model/environment';
import {DAILY_AGRONOMY_SOURCE_KEY} from '../../src/analysis/types';

const require = createRequire(import.meta.url);
const nativeWeatherProvider = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-weather-provider/index.js') as {
  resolveProvider: (source: string | null, deploymentDefault: string | null) => string | null;
};
const nativeEnvironment = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js') as {
  buildForecastSection: (...args: any[]) => any;
  buildWaterDaily: (input: Record<string, unknown>) => Array<Record<string, unknown>>;
  resolveWaterAction: (...args: any[]) => Record<string, unknown>;
};
const nativeAgronomy = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js') as {
  localDayWindow: (date: string, timezone: string, memo: Map<string, unknown>) => {hourStarts: string[]};
  resolveDay: (input: Record<string, unknown>) => Record<string, unknown>;
};
function nativeForecastFor(sim: Simulator, zoneId: number, summary: Awaited<ReturnType<typeof environmentAPI.getSummary>>) {
  const zone = sim.zones.find(row => row.id === zoneId)!;
  const provider = selectedWeatherProvider(zone);
  const full = buildForecast(zone, summary.water.todayDate!, sim.now, zone.timezone ?? sim.state.settings.gatewayTimezone,
    provider, sim.state.environmentRecords)!;
  return nativeEnvironment.buildForecastSection({source: summary.forecast.source,
    observedAt: summary.forecast.observedAt, days: full.daily, hours: full.hourly},
  summary.forecast.cacheStatus, summary.forecast.expiresAt, null, summary.generatedAt);
}

function install(sim: Simulator): void { api.defaults.adapter = createDemoAdapter(sim); }

test('provider selection matches the native weather-provider resolver for the finite source policy', () => {
  for (const [source, fallback] of [['meteoswiss', 'open_meteo'], ['auto', 'meteoswiss'], ['auto', null],
    [null, 'invalid'], ['openagri', 'meteoswiss'], ['local', 'open_meteo'], [' Open_Meteo ', 'meteoswiss']] as const) {
    const zone = {weather_source: source, weather_source_default: fallback} as any;
    assert.equal(selectedWeatherProvider(zone), nativeWeatherProvider.resolveProvider(source, fallback));
  }
});

test('EN01 environment summary derives local climate and water from the shared timeline', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const summary = await environmentAPI.getSummary(1);
  assert.equal(summary.generatedAt, new Date(sim.now).toISOString());
  assert.ok(summary.local.metrics.some(metric => metric.key === 'ambient_temperature'));
  assert.ok(summary.local.metrics.some(metric => metric.key === 'relative_humidity'));
  assert.equal(summary.water.rainTodayMm, 0);
  assert.ok(summary.water.daily.some(day => day.rainMm === 0));
  const todayRow = summary.water.daily.find(day => day.date === summary.water.todayDate)!;
  assert.equal(todayRow.et0Source, null);
  assert.equal(todayRow.et0Tier, null);
  assert.equal(todayRow.hoursPresent, null);
  assert.equal(todayRow.expectedHours, null);
  assert.equal(todayRow.sourceProvider, 'open_meteo');
  assert.equal(todayRow.sourceCapturedAt, new Date(sim.now).toISOString());
  assert.equal(todayRow.coveragePct, null);
  assert.equal(todayRow.locationKey, 'open_meteo:0.35:32.58');
  assert.equal(todayRow.nullReason, null);
  assert.equal(summary.forecast.available, true);
  assert.equal(summary.online.cacheStatus, 'live');
  assert.equal(summary.forecast.cacheStatus, 'live');
  assert.equal(summary.online.expiresAt, new Date(sim.now + 15 * 60_000).toISOString());
  const today = summary.water.todayDate;
  assert.equal(summary.forecast.rainFocus?.daily.find(day => day.date === today)?.et0MmDay,
    summary.water.daily.find(day => day.date === today)?.et0Mm);
});

test('EN02 area, efficiency, stage, crop and weather source change dependent synthetic demand', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const before = await environmentAPI.getSummary(1);
  await api.put('/api/irrigation-zones/1/config', {areaM2: 200, irrigationEfficiencyPct: 50,
    cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-10-01', weatherSource: 'meteoswiss'});
  const after = await environmentAPI.getSummary(1);
  assert.equal(after.water.areaM2, 200);
  assert.equal(after.water.irrigationEfficiencyPct, 50);
  assert.notEqual(after.water.daily.at(-1)?.demandMm, before.water.daily.at(-1)?.demandMm);
  assert.notEqual(after.water.daily.at(-1)?.kc, before.water.daily.at(-1)?.kc);
  assert.equal(after.water.daily.at(-1)?.cropType, 'maize');
  assert.equal(after.water.daily.at(-1)?.phenologicalStage, 'development');
  assert.equal(after.water.daily.at(-1)?.kcSource, 'fao56_curve');
  assert.match(after.display?.sourceLabel ?? '', /meteoswiss/);
});

test('measured water remains nullable when source is removed while seeded measured zero stays zero', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const measuredZero = await environmentAPI.getSummary(1);
  assert.equal(measuredZero.water.rainTodayMm, 0);
  assert.equal(measuredZero.water.daily.find(day => day.date === measuredZero.water.todayDate)?.rainMm, 0);
  await irrigationZonesAPI.removeDevice(1, '00000000000000E1');
  const missing = await environmentAPI.getSummary(1);
  assert.equal(missing.water.rainTodayMm, null);
  assert.equal(missing.water.daily.find(day => day.date === missing.water.todayDate)?.rainMm, null);
  assert.ok(missing.forecast.rainFocus?.daily[0]?.rainMm !== undefined);
  assert.equal(missing.water.daily.find(day => day.date === missing.water.todayDate)?.estimatedTotalWaterMm, null);
});

test('forecast hourly response uses native next24 window while totals derive from the full horizon', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const summary = await environmentAPI.getSummary(1);
  const focus = summary.forecast.rainFocus!;
  const today = summary.water.todayDate!;
  assert.equal(focus.daily.length, 3);
  assert.deepEqual(focus.daily.map(row => row.date), [today,
    new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10),
    new Date(Date.parse(`${today}T00:00:00Z`) + 172800000).toISOString().slice(0, 10)]);
  const native = nativeForecastFor(sim, 1, summary);
  assert.equal(focus.hourly.length, 24);
  assert.deepEqual(focus.hourly.map(({time, rainMm, rainProbabilityPct, tempC}) => ({time, rainMm, rainProbabilityPct, tempC})),
    native.rainFocus.hourly.map(({time, rainMm, rainProbabilityPct, tempC}: any) => ({time, rainMm, rainProbabilityPct, tempC})));
  assert.equal(focus.totalNext72hMm, native.rainFocus.totalNext72hMm);
  assert.equal(focus.totalNext24hMm, native.rainFocus.totalNext24hMm);
  assert.equal(focus.nextRainEta, native.rainFocus.nextRainEta);
  assert.equal(focus.maxHourlyRainMm, native.rainFocus.maxHourlyRainMm);
  assert.equal(focus.maxHourlyRainAt, native.rainFocus.maxHourlyRainAt);
  assert.equal(focus.rainHoursNext24h, native.rainFocus.rainHoursNext24h);
  assert.ok(focus.daily.every(row => row.et0MmDay !== null && row.etcMmDay !== null));
});

test('R2 next-rain searches the full forecast horizon while hourly response is native next-24 window', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  await sim.advanceTo(Date.parse('2026-10-12T02:59:50.000Z'));
  const summary = await environmentAPI.getSummary(1), focus = summary.forecast.rainFocus!;
  const native = nativeForecastFor(sim, 1, summary);
  assert.equal(focus.hourly.length, 24);
  assert.equal(focus.nextRainEta, '2026-10-14T04:00:00.000Z');
  assert.equal(focus.nextRainEta, native.rainFocus.nextRainEta);
  assert.deepEqual(focus.hourly.map(({time, rainMm, rainProbabilityPct, tempC}) => ({time, rainMm, rainProbabilityPct, tempC})),
    native.rainFocus.hourly.map(({time, rainMm, rainProbabilityPct, tempC}: any) => ({time, rainMm, rainProbabilityPct, tempC})));
  assert.equal(focus.totalNext72hMm, native.rainFocus.totalNext72hMm);
});

test('R2 rolling 72-hour total excludes the exact now plus 72-hour endpoint', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  await sim.advanceTo(Date.parse('2026-10-11T04:00:00.000Z'));
  const summary = await environmentAPI.getSummary(1), focus = summary.forecast.rainFocus!;
  const zone = sim.zones.find(row => row.id === 1)!;
  const full = buildForecast(zone, summary.water.todayDate!, sim.now, zone.timezone ?? sim.state.settings.gatewayTimezone,
    selectedWeatherProvider(zone), sim.state.environmentRecords)!;
  const native = nativeForecastFor(sim, 1, summary);
  assert.equal(full.hourly.at(-1)?.time, '2026-10-14T04:00:00.000Z');
  assert.equal(full.hourly.at(-1)?.rainMm, 0.4);
  assert.equal(focus.totalNext72hMm, native.rainFocus.totalNext72hMm);
  assert.equal(focus.nextRainEta, native.rainFocus.nextRainEta);
  assert.equal(native.rainFocus.totalNext72hMm, 0);
});

test('completed agronomy facts stay fixed across clock advance and later crop configuration', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const day = '2026-10-07', from = `${day}T00:00:00.000Z`, to = `${day}T23:59:59.999Z`;
  const catalog = await analysisAPI.getChannels();
  const channel = catalog.channels.find(row => row.zoneId === 1 && row.channelKey === 'etc_mm' && row.sourceKind === 'zone_daily_agronomy')!;
  const query = () => analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}], range: {label: 'custom', from, to}, aggregation: 'daily'});
  const before = await query();
  await sim.advanceTo(sim.now + 24 * 3600000);
  await api.put('/api/irrigation-zones/1/config', {cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-10-10'});
  const after = await query();
  assert.deepEqual(after.series[0]?.points, before.series[0]?.points);
  const history = await historyAPI.getZoneCards(1);
  assert.ok(history.cards.some(card => card.cardType === 'environment' && card.sourceDevices.some(source => source.typeId === 'zone_daily_agronomy')));
});

test('R3 retained analysis samples keep their original instant when zone timezone changes', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const day = '2026-10-07', from = `${day}T00:00:00.000Z`, to = `${day}T23:59:59.999Z`;
  const channels = await analysisAPI.getChannels();
  const channel = channels.channels.find(row => row.zoneId === 1 && row.channelKey === 'et0_mm' && row.sourceKind === 'zone_daily_agronomy')!;
  const query = () => analysisAPI.getSeries({selectors: [{seriesId: channel.seriesId}], range: {label: 'custom', from, to}, aggregation: 'raw'});
  const before = await query();
  await api.put('/api/irrigation-zones/1/config', {timezone: 'Europe/Zurich'});
  const after = await query();
  assert.deepEqual(after.series[0]?.points.map(point => point.t), before.series[0]?.points.map(point => point.t));
});

test('R3 a never-read Auckland day is retained using its own completed-date horizon before crop edits', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  sim.zones.find(zone => zone.id === 1)!.timezone = 'Pacific/Auckland';
  await sim.advanceTo(Date.parse('2026-10-10T13:00:00.000Z'));
  await api.put('/api/irrigation-zones/1/config', {cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-10-10'});
  const summary = await environmentAPI.getSummary(1);
  const day = summary.water.daily.find(row => row.date === '2026-10-10')!;
  assert.equal(day.cropType, 'Tomato');
  assert.equal(day.phenologicalStage, null);
});

test('R3 unavailable completed rows can backfill when fictional provider inputs later become available', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const zone = await irrigationZonesAPI.create({name: 'Initially unavailable', cropType: 'tomato'});
  const before = await environmentAPI.getSummary(zone.id);
  assert.equal(before.water.daily.at(-2)?.et0Mm, null);
  await api.put(`/api/irrigation-zones/${zone.id}/config`, {cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-10-09'});
  await api.put(`/api/irrigation-zones/${zone.id}/location`, {latitude: 0.3476, longitude: 32.5825});
  const after = await environmentAPI.getSummary(zone.id);
  assert.ok((after.water.daily.at(-2)?.et0Mm ?? null) !== null);
  assert.equal(after.water.daily.at(-2)?.cropType, 'maize');
  assert.equal(after.water.daily.at(-2)?.phenologicalStage, 'development');
});

test('R4 current forecast-day metadata and action balance match native null policy', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const available = await environmentAPI.getSummary(1);
  const today = available.water.daily.find(day => day.date === available.water.todayDate)!;
  const nativeDaily = nativeEnvironment.buildWaterDaily({envRows: [], estimatedByDate: {}, agronomyRows: [], zone: sim.zones[0],
    todayIso: available.water.todayDate, waterNeededTodayMm: available.water.waterNeededTodayMm,
    kcSourceToday: available.agronomic.current?.cropCoefficientSource,
    todayAgronomic: {referenceEt0MmDay: available.agronomic.current?.referenceEt0MmDay,
      cropCoefficientKc: available.agronomic.current?.cropCoefficientKc, cropId: sim.zones[0]?.crop_type}, stationNames: {}})
    .find(row => row.date === available.water.todayDate)!;
  for (const field of ['et0Source', 'et0Tier', 'hoursPresent', 'expectedHours'] as const) assert.equal(today[field], nativeDaily[field]);
  assert.equal(today.demandSource, nativeDaily.demandSource);
  await api.put('/api/irrigation-zones/1/config', {weatherSource: 'local'});
  const unavailable = await environmentAPI.getSummary(1);
  assert.equal(unavailable.water.waterNeededTodayMm, null);
  assert.equal(unavailable.water.balanceTodayMm, null);
  assert.equal(unavailable.water.daily.find(day => day.date === unavailable.water.todayDate)?.demandSource, null);
});

test('R4 completed provider coverage uses actual zone-day hour counts through DST', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  sim.zones.find(zone => zone.id === 1)!.timezone = 'Europe/Zurich';
  await sim.advanceTo(Date.parse('2026-10-26T12:00:00.000Z'));
  const summary = await environmentAPI.getSummary(1);
  const row = summary.water.daily.find(day => day.date === '2026-10-25')!;
  const window = nativeAgronomy.localDayWindow(row.date, 'Europe/Zurich', new Map());
  const retained = sim.state.environmentRecords.get(`1|${row.date}|${DAILY_AGRONOMY_SOURCE_KEY}`)!;
  const native = nativeAgronomy.resolveDay({date: row.date, hourStarts: window.hourStarts, latitude: sim.zones[0]?.latitude,
    longitude: sim.zones[0]?.longitude, provider: 'open_meteo', locationKey: row.locationKey,
    stations: [], stationHours: new Map(), stationPriorHours: new Map(),
    providerRows: retained.hourly.map(hour => ({hour_start: new Date(hour.at).toISOString().replace('.000Z', 'Z'), et0_mm: hour.et0Mm, station_id: null})),
    gatewayAltitudeM: null, nowMs: sim.now});
  assert.equal(window.hourStarts.length, 25);
  assert.equal(row.expectedHours, native.expectedHours);
  assert.equal(row.hoursPresent, native.hoursPresent);
  assert.equal(row.et0Mm, native.et0Mm);
});

test('R4 completed provider coverage retains 23 actual synthetic hours on spring DST day', () => {
  const sim = new Simulator({mode: 'public'});
  const zone = sim.zones.find(item => item.id === 1)!; zone.timezone = 'Europe/Zurich';
  seedCompletedEnvironmentRecords([zone], Date.parse('2026-03-30T12:00:00.000Z'), 'Europe/Zurich', sim.state.environmentRecords, 1);
  const row = sim.state.environmentRecords.get(`1|2026-03-29|${DAILY_AGRONOMY_SOURCE_KEY}`)!;
  const window = nativeAgronomy.localDayWindow(row.date, 'Europe/Zurich', new Map());
  const native = nativeAgronomy.resolveDay({date: row.date, hourStarts: window.hourStarts, latitude: zone.latitude,
    longitude: zone.longitude, provider: 'open_meteo', locationKey: row.values.location_key,
    stations: [], stationHours: new Map(), stationPriorHours: new Map(),
    providerRows: row.hourly.map(hour => ({hour_start: new Date(hour.at).toISOString().replace('.000Z', 'Z'), et0_mm: hour.et0Mm, station_id: null})),
    gatewayAltitudeM: null, nowMs: Date.parse('2026-03-30T12:00:00.000Z')});
  assert.equal(window.hourStarts.length, 23);
  assert.equal(row.values.hours_present, native.hoursPresent);
  assert.equal(row.values.expected_hours, native.expectedHours);
  assert.equal(row.values.et0_mm, native.et0Mm);
});

test('R4 provider rows retain UTC-aligned instants for fractional-offset Kathmandu days', () => {
  const sim = new Simulator({mode: 'public'});
  const zone = sim.zones.find(item => item.id === 1)!; zone.timezone = 'Asia/Kathmandu';
  sim.state.environmentRecords.clear();
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  seedCompletedEnvironmentRecords([zone], now, 'Asia/Kathmandu', sim.state.environmentRecords, 1);
  const row = sim.state.environmentRecords.get(`1|2026-10-09|${DAILY_AGRONOMY_SOURCE_KEY}`)!;
  const window = nativeAgronomy.localDayWindow(row.date, 'Asia/Kathmandu', new Map());
  const native = nativeAgronomy.resolveDay({date: row.date, hourStarts: window.hourStarts, latitude: zone.latitude,
    longitude: zone.longitude, provider: 'open_meteo', locationKey: row.values.location_key,
    stations: [], stationHours: new Map(), stationPriorHours: new Map(),
    providerRows: row.hourly.map(hour => ({hour_start: new Date(hour.at).toISOString().replace('.000Z', 'Z'), et0_mm: hour.et0Mm, station_id: null})),
    gatewayAltitudeM: null, nowMs: now});
  assert.equal(new Date(row.hourly[0]!.at).toISOString().replace('.000Z', 'Z'), window.hourStarts[0]);
  assert.equal(row.values.expected_hours, native.expectedHours);
  assert.equal(row.values.hours_present, native.hoursPresent);
  assert.equal(row.values.et0_mm, native.et0Mm);
});

test('R4 provider row count follows Lord Howe half-hour DST local-day coverage', () => {
  const sim = new Simulator({mode: 'public'});
  const zone = sim.zones.find(item => item.id === 1)!; zone.timezone = 'Australia/Lord_Howe';
  sim.state.environmentRecords.clear();
  const now = Date.parse('2026-10-05T12:00:00.000Z');
  seedCompletedEnvironmentRecords([zone], now, 'Australia/Lord_Howe', sim.state.environmentRecords, 1);
  const row = sim.state.environmentRecords.get(`1|2026-10-04|${DAILY_AGRONOMY_SOURCE_KEY}`)!;
  const window = nativeAgronomy.localDayWindow(row.date, 'Australia/Lord_Howe', new Map());
  const native = nativeAgronomy.resolveDay({date: row.date, hourStarts: window.hourStarts, latitude: zone.latitude,
    longitude: zone.longitude, provider: 'open_meteo', locationKey: row.values.location_key,
    stations: [], stationHours: new Map(), stationPriorHours: new Map(),
    providerRows: row.hourly.map(hour => ({hour_start: new Date(hour.at).toISOString().replace('.000Z', 'Z'), et0_mm: hour.et0Mm, station_id: null})),
    gatewayAltitudeM: null, nowMs: now});
  assert.equal(window.hourStarts.length, 23);
  assert.equal(row.values.expected_hours, native.expectedHours);
  assert.equal(row.values.hours_present, native.hoursPresent);
  assert.equal(row.values.et0_mm, native.et0Mm);
});

test('unrequested completed days retain their seeded configuration provenance after a later edit', async () => {
  const day = '2026-10-07', from = `${day}T00:00:00.000Z`, to = `${day}T23:59:59.999Z`;
  const first = new Simulator({mode: 'public'}); install(first);
  const catalog = await analysisAPI.getChannels();
  const seriesId = catalog.channels.find(row => row.zoneId === 1 && row.channelKey === 'etc_mm' && row.sourceKind === 'zone_daily_agronomy')!.seriesId;
  const request = () => analysisAPI.getSeries({selectors: [{seriesId}], range: {label: 'custom', from, to}, aggregation: 'daily'});
  const expected = await request();
  const edited = new Simulator({mode: 'public'}); install(edited);
  const editedCatalog = await analysisAPI.getChannels();
  const editedSeriesId = editedCatalog.channels.find(row => row.zoneId === 1 && row.channelKey === 'etc_mm' && row.sourceKind === 'zone_daily_agronomy')!.seriesId;
  await api.put('/api/irrigation-zones/1/config', {cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-10-10'});
  const actual = await analysisAPI.getSeries({selectors: [{seriesId: editedSeriesId}], range: {label: 'custom', from, to}, aggregation: 'daily'});
  assert.deepEqual(actual.series[0]?.points, expected.series[0]?.points);
});

test('local provider policy stays unavailable for forecast without radiation inputs', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  await api.put('/api/irrigation-zones/1/config', {weatherSource: 'local'});
  const summary = await environmentAPI.getSummary(1);
  assert.equal(summary.online.available, false);
  assert.equal(summary.forecast.available, false);
  assert.equal(summary.forecast.source, 'unavailable');
  assert.equal(summary.water.daily.at(-1)?.et0Mm, null);
  assert.equal(summary.water.daily.at(-1)?.nullReason, 'demand_unknown');
  const analysis = await analysisAPI.getChannels();
  assert.equal(analysis.channels.some(row => row.zoneId === 1 && row.sourceKind === 'zone_daily_agronomy'), false);
  const history = await historyAPI.getZoneCards(1);
  const environment = history.cards.find(card => card.cardType === 'environment');
  assert.equal(environment?.sourceDevices.some(source => source.typeId === 'zone_daily_agronomy'), false);
});

test('missing zone location disables fictional provider data consistently across summary and source catalogs', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  sim.zones.find(zone => zone.id === 1)!.latitude = null;
  sim.zones.find(zone => zone.id === 1)!.longitude = null;
  const summary = await environmentAPI.getSummary(1);
  assert.equal(summary.location.source, 'unavailable');
  assert.equal(summary.online.available, false);
  assert.equal(summary.forecast.available, false);
  assert.equal(summary.water.daily.at(-1)?.nullReason, 'demand_unknown');
  assert.equal((await analysisAPI.getChannels()).channels.some(row => row.zoneId === 1 && row.sourceKind === 'zone_daily_agronomy'), false);
  const environment = (await historyAPI.getZoneCards(1)).cards.find(card => card.cardType === 'environment');
  assert.equal(environment?.sourceDevices.some(source => source.typeId === 'zone_daily_agronomy'), false);
});

test('R5 public water action matches native DENDRO and evidence-backed heuristic selection', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const withoutCohort = await environmentAPI.getSummary(1);
  const fallback = nativeEnvironment.resolveWaterAction(withoutCohort.water.todayDate, null,
    withoutCohort.water.balanceTodayMm, withoutCohort.water.next24hRainMm, withoutCohort.water.waterNeededTodayMm);
  assert.deepEqual(withoutCohort.water.action, {code: fallback.code, source: fallback.source,
    reasonCode: fallback.reasonCode, recommendationDate: fallback.recommendationDate});
  assert.equal(withoutCohort.water.action?.code, 'irrigate_today');
  const withCohort = await environmentAPI.getSummary(2);
  assert.ok(withCohort.water.action);
  const recommendations = await api.get<Array<{date: string; irrigation_action: string; action_reasoning: string}>>(
    '/api/irrigation-zones/2/recommendations?days=14');
  const current = recommendations.data.at(-1)!;
  const dendro = nativeEnvironment.resolveWaterAction(withCohort.water.todayDate,
    {date: current.date, irrigation_action: current.irrigation_action, action_reasoning: current.action_reasoning},
    withCohort.water.balanceTodayMm, withCohort.water.next24hRainMm, withCohort.water.waterNeededTodayMm);
  assert.deepEqual(withCohort.water.action, {code: dendro.code, source: dendro.source, reasonCode: dendro.reasonCode,
    reasoning: dendro.reasoning, recommendationDate: dendro.recommendationDate});
  await api.put('/api/irrigation-zones/1/config', {weatherSource: 'local'});
  const unavailable = await environmentAPI.getSummary(1);
  const insufficient = nativeEnvironment.resolveWaterAction(unavailable.water.todayDate, null,
    unavailable.water.balanceTodayMm, unavailable.water.next24hRainMm, unavailable.water.waterNeededTodayMm);
  assert.deepEqual(unavailable.water.action, {code: insufficient.code, source: insufficient.source,
    reasonCode: insufficient.reasonCode, recommendationDate: insufficient.recommendationDate});
  assert.equal(unavailable.water.action?.source, 'insufficient_data');
});

test('weather-only empty zone remains selectable in the history catalog', async () => {
  const sim = new Simulator({mode: 'public'}); install(sim);
  const empty = await irrigationZonesAPI.create({name: 'Weather only', cropType: 'kiwi'});
  await api.put(`/api/irrigation-zones/${empty.id}/location`, {latitude: 0.3476, longitude: 32.5825});
  const cards = await historyAPI.getZoneCards(empty.id);
  const environment = cards.cards.find(card => card.cardType === 'environment');
  assert.ok(environment);
  assert.ok(environment.sourceDevices.some(source => source.typeId === 'zone_daily_agronomy'));
});
