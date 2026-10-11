import type {Device, IrrigationZone} from '../../src/types/farming';
import type {IrrigationActuation} from '../../src/services/api';
import {historyCardDefinitionsByType} from '../../src/history/cardDefinitions';
import type {HistoryCardSourceDevice, HistoryCardType, HistoryViewMode} from '../../src/history/types';
import {cardChannelsForSource, channelLabel, channelUnit} from '../../src/channels/registry';
import type {ReadingLedger} from './readings';
import {aggregateChannel, localDateKey, localMidnight, resolveAggregation, shiftDate, type AggregatedPoint} from './aggregation';
import {describeDeviceSource, soilDepthCm, sourceKey as sourceKeyForDevice} from './device-sources';
import {iso} from '../fixtures';
import {DemoError} from '../errors';
import {DAILY_AGRONOMY_SOURCE_KEY} from '../../src/analysis/types';
import {hasIllustrativeWeatherSource, syntheticEnvironmentTimeline} from './environment';
import type {RetainedEnvironmentRecord} from './state';
import channelManifestJson from '../../src/channels/channels.json';

type WorkspaceRecord = {id: number; userId: number; ownerUserUuid: string | null; zoneId: number | null; name: string; isDefault: boolean;
  workspace: Record<string, unknown>; createdAt: string; updatedAt: string};
type CardPreference = {cardId: string; scope: 'zone' | 'gateway'; pinned: boolean; manualOrder: number | null; openCount: number;
  lastOpenedAt: string | null; lastViewMode: HistoryViewMode | null; hidden: boolean; updatedAt: string};
export type HistoryState = {preferences: Map<string, CardPreference>; workspaces: WorkspaceRecord[]; nextWorkspaceId: number};
export function createHistoryState(): HistoryState { return {preferences: new Map(), workspaces: [], nextWorkspaceId: 1}; }
type HistoryPort = {zones: IrrigationZone[]; devices: Device[]; ledger: ReadingLedger; outcomes: IrrigationActuation[];
  now: number; gatewayTimezone: string; environmentRecords?: Map<string, RetainedEnvironmentRecord>; gatewayStats?: Record<string, unknown>};
const fail = (status: number, code: string, message = code, extra: Record<string, unknown> = {}): never => { throw new DemoError(status, code, {error: code, message, ...extra}); };
function resolveHistoryAggregation(value: string, label: string, from: number, to: number) {
  try { return resolveAggregation(value, label, from, to); }
  catch (error) { if ((error as {code?: string}).code === 'invalid_aggregation') fail(400, 'invalid_aggregation', 'Unsupported aggregation'); throw error; }
}
const cardOrder: HistoryCardType[] = ['soil', 'dendro', 'environment', 'irrigation'];
const channelManifest = channelManifestJson as Array<{key: string; unit: string | null; label: string; edgeField?: string | null; exportable?: boolean; deprecated?: boolean}>;
const titles: Record<HistoryCardType, [string, string]> = {
  soil: ['Soil Moisture', 'Root-zone tension'], dendro: ['Dendro - Growth Timeline', 'Stem movement and recovery'],
  environment: ['Environment - Microclimate', 'Temperature, humidity, and rain context'],
  irrigation: ['Irrigation - Events', 'Valve actions and irrigation outcomes'], gateway: ['Gateway - Hub Status', 'Local gateway connectivity'],
};
function sourceDevices(zone: IrrigationZone, type: HistoryCardType, devices: Device[]): Device[] {
  return devices.filter(device => {
    if (device.irrigation_zone_id !== zone.id) return false;
    const description = describeDeviceSource(device);
    if (type === 'soil') {
      if (!description.families.soil?.length) return false;
      if (device.type_id === 'DRAGINO_LSN50') return description.current.some(key => /^swt_\d+$/.test(key));
      return true;
    }
    if (type === 'dendro') return Boolean(description.families.dendro?.length) && description.current.some(key => description.families.dendro!.includes(key));
    if (type === 'environment') return Boolean(description.families.environment?.length)
      && description.current.some(key => description.families.environment!.includes(key));
    if (type === 'irrigation') return device.type_id === 'STREGA_VALVE';
    return false;
  }).sort((a, b) => a.deveui.localeCompare(b.deveui));
}
function sourceKey(type: HistoryCardType, device: Device): string | null {
  if (type === 'dendro' || type === 'soil' || type === 'environment' || type === 'irrigation') return sourceKeyForDevice(type, device);
  return null;
}
function cardId(zone: IrrigationZone, type: HistoryCardType, devices: Device[]): string {
  const logical = type === 'dendro' ? sourceKey(type, devices[0]!) : ({soil: 'root-zone', environment: 'microclimate', irrigation: 'zone-valves'} as const)[type as 'soil' | 'environment' | 'irrigation'];
  return `${zone.zone_uuid}:${type}:${logical}`;
}
function cardFor(zone: IrrigationZone, type: HistoryCardType, port: HistoryPort, state: HistoryState) {
  const sources = sourceDevices(zone, type, port.devices);
  const hasIllustrativeWeather = type === 'environment' && hasIllustrativeWeatherSource(zone);
  if (!sources.length && type !== 'irrigation' && !hasIllustrativeWeather) return null;
  if (!sources.length && !hasIllustrativeWeather && !port.outcomes.some(row => row.zoneId === zone.id)) return null;
  const definition = historyCardDefinitionsByType[type];
  const id = cardId(zone, type, sources);
  const pref = state.preferences.get(`zone:${zone.id}:${id}`);
  const recent = sources.flatMap(device => port.ledger.forDevice(device.deveui)).filter(sample => sample.at <= port.now);
  const latest = recent[recent.length - 1];
  const battery = sources.map(device => device.latest_data.bat_pct ?? device.latest_data.bat_v).find(value => typeof value === 'number') ?? null;
  const sourceRows: HistoryCardSourceDevice[] = sources.map(device => ({name: device.name, typeId: device.type_id, role: type, sourceKey: sourceKey(type, device),
    ...(device.type_id === 'DRAGINO_LSN50' ? {chameleonEnabled: device.chameleon_enabled === 1} : {})}));
  if (hasIllustrativeWeather) sourceRows.push({name: 'Illustrative simulator', typeId: 'zone_daily_agronomy', role: type,
    sourceKey: DAILY_AGRONOMY_SOURCE_KEY});
  const recentRank = pref?.lastOpenedAt ? [...state.preferences.entries()].filter(([key, item]) => key.startsWith(`zone:${zone.id}:`)
    && item.lastOpenedAt && item.lastOpenedAt > pref.lastOpenedAt!).length + 1 : null;
  const dataAvailable = type === 'irrigation' ? port.outcomes.some(row => row.zoneId === zone.id) : sources.length > 0 || hasIllustrativeWeather;
  return {cardId: id, cardType: type, scope: 'zone', title: titles[type][0], subtitle: titles[type][1], defaultView: definition.defaultView,
    views: [...definition.views], supportedRanges: [...definition.supportedRanges].filter(range => range !== 'season'), defaultRange: definition.defaultRange,
    sourceDeviceCount: sourceRows.length, sourceLabel: sourceRows.map(row => row.name).join(', ') || null, sourceLabels: sourceRows.map(row => row.name), sourceDevices: sourceRows,
    metadata: {lastSeenAt: latest ? iso(latest.at) : null,
      ...(battery === null ? {} : {battery: {status: 'available', latest: battery, unit: 'bat_pct'}}),
      coveragePct: latest ? 100 : null, coverageConfidence: latest ? 'configured' : 'unknown', syncState: 'local'},
    availability: {available: dataAvailable, reasons: dataAvailable ? [] : ['no_source']},
    ordering: {pinned: pref?.pinned ?? false, score: pref?.manualOrder ?? 0, recentRank,
      manualOrder: pref?.manualOrder ?? null}};
}
function cardsForZone(zone: IrrigationZone, port: HistoryPort, state: HistoryState) {
  return cardOrder.map(type => cardFor(zone, type, port, state)).filter(Boolean);
}
function preferenceKey(zoneId: number, cardIdValue: string) { return `zone:${zoneId}:${cardIdValue}`; }
function readPreference(state: HistoryState, zoneId: number, cardIdValue: string, now: number): CardPreference {
  return state.preferences.get(preferenceKey(zoneId, cardIdValue)) ?? {cardId: cardIdValue, scope: 'zone', pinned: false,
    manualOrder: null, openCount: 0, lastOpenedAt: null, lastViewMode: null, hidden: false, updatedAt: iso(now)};
}
function parseCardRequest(url: URL, zone: IrrigationZone, now: number, fallbackTimezone: string, cardType: HistoryCardType) {
  const params = url.searchParams;
  const range = params.get('range') ?? '24h';
  const allowedRanges = ['12h', '24h', '7d', '30d', 'season', 'custom'];
  if (!allowedRanges.includes(range)) fail(400, 'invalid_range', 'Unsupported range');
  const supported = params.get('view') ?? 'line-chart';
  const possible = historyCardDefinitionsByType[cardType]?.views;
  if (!possible?.includes(supported as never)) fail(400, 'invalid_view', 'Unsupported view');
  const fromRaw = params.get('from'), toRaw = params.get('to');
  if ((fromRaw && !toRaw) || (!fromRaw && toRaw)) fail(400, 'invalid_range', 'Both from and to are required');
  let to = toRaw ? Date.parse(toRaw) : now;
  let from = fromRaw ? Date.parse(fromRaw) : to - ({'12h': 12, '24h': 24, '7d': 168, '30d': 720}[range] ?? 24) * 3600000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || (range === 'custom' && (!fromRaw || !toRaw))) fail(400, 'invalid_range', 'Invalid from/to range');
  if (range === 'season') fail(400, 'invalid_range', 'Season range is unavailable for this zone');
  const timezone = params.get('timezone') || zone.timezone || fallbackTimezone;
  try { new Intl.DateTimeFormat('en', {timeZone: timezone}); } catch { fail(400, 'invalid_timezone', 'Invalid timezone'); }
  const aggregation = resolveHistoryAggregation(params.get('aggregation') ?? 'auto', range, from, to);
  return {label: range, from: iso(from), to: iso(to), timezone, fromMs: from, toMs: to, view: supported, ...aggregation};
}
function channelsForDevice(cardType: HistoryCardType, device: Device): string[] {
  if (cardType === 'dendro') return device.dendro_enabled === 1 ? ['dendro_stem_change_um', 'dendro_delta_mm', 'dendro_ratio', 'dendro_position_mm'] : [];
  if (cardType === 'irrigation') return [];
  const declared = describeDeviceSource(device).families[cardType] ?? [];
  const cardAllowed = cardChannelsForSource(cardType, {deviceType: device.type_id, chameleonEnabled: device.chameleon_enabled === 1, tempEnabled: device.temp_enabled === 1});
  return declared.filter(key => cardAllowed.includes(key));
}
function buildCalendar(type: HistoryCardType, devices: Device[], port: HistoryPort, from: number, to: number, timezone: string,
  events: Array<Record<string, unknown>>, extraRows: Array<Record<string, unknown>> = []) {
  const calendarRows: Array<Record<string, unknown>> = [...devices.flatMap(device => {
    const channels = new Set(channelsForDevice(type, device));
    return port.ledger.forDevice(device.deveui).filter(sample => sample.at >= from && sample.at < to)
      .map(sample => ({...Object.fromEntries(Object.entries(sample.values).filter(([key]) => channels.has(key))), recorded_at: iso(sample.at)}));
  }), ...extraRows.filter(row => { const at = Date.parse(String(row.recorded_at ?? '')); return at >= from && at < to; })];
  const first = localDateKey(from, timezone), last = localDateKey(Math.max(from, to - 1), timezone);
  const days: Array<Record<string, unknown>> = [];
  for (let date = first; date <= last; date = shiftDate(date, 1)) {
    const rows = calendarRows.filter(row => localDateKey(Date.parse(String(row.recorded_at ?? '')), timezone) === date);
    const dayEvents = events.filter(event => localDateKey(Date.parse(String(event.t ?? '')), timezone) === date);
    const priority = (values: Array<string | null | undefined>, order: string[], fallback = 'no_data') => {
      const present = new Set(values.filter((value): value is string => Boolean(value) && value !== 'no_data'));
      return order.find(value => present.has(value)) ?? (present.values().next().value as string | undefined) ?? fallback;
    };
    const soilStatus = (row: Record<string, unknown>) => {
      const values = ['swt_1','swt_2','swt_3','swt_wm1','swt_wm2'].map(key => row[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (!values.length) return 'no_data';
      const value = values.reduce((sum, current) => sum + current, 0) / values.length;
      return value > 50 ? 'dry_stress' : value < 22 ? 'wet_excess' : 'optimal';
    };
    const finite = (...values: unknown[]): number | null => {
      const candidate = values.find(value => typeof value === 'number' && Number.isFinite(value));
      return typeof candidate === 'number' ? candidate : null;
    };
    const dendroStatus = (row: Record<string, unknown>) => {
      const ratio = finite(row.recoveryRatio, row.recovery_ratio, row.dendro_ratio);
      const shrinkage = finite(row.mdsUm, row.mds_um, row.dendro_mds_um, row.twdUm, row.twd_um, row.dendro_twd_um);
      const growth = finite(row.growthUm, row.growth_um, row.tgrUm, row.tgr_um, row.dendro_stem_change_um);
      if (ratio !== null && ratio < 0.5) return 'incomplete_night_recovery';
      if (shrinkage !== null && shrinkage >= 400) return 'high_shrinkage_stress';
      if (growth !== null && growth <= 0) return 'reduced_growth';
      if (ratio === null && shrinkage === null && growth === null) return 'no_data';
      return 'normal_growth';
    };
    const environmentStatus = (row: Record<string, unknown>) => {
      const temperature = finite(row.ambientTemperature, row.ambient_temperature, row.ext_temperature_c, row.temperatureC, row.value);
      const humidity = finite(row.relativeHumidity, row.relative_humidity);
      const rain = finite(row.rainMm, row.rain_mm_today, row.rain_mm_delta, row.rain_mm_per_hour);
      if (temperature !== null && temperature >= 35) return 'heat_stress';
      if (temperature !== null && temperature <= 5) return 'cold_stress';
      if (humidity !== null && humidity >= 90) return 'high_humidity';
      if (rain !== null && rain >= 1) return 'rain_day';
      if (temperature === null && humidity === null && rain === null) return 'no_data';
      return 'normal';
    };
    const gatewayStatus = (row: Record<string, unknown>) => {
      const seen = Date.parse(String(row.lastSeenAt ?? row.recorded_at ?? ''));
      return Number.isFinite(seen) ? (port.now - seen > 600000 ? 'offline' : 'normal') : 'no_data';
    };
    const states = rows.map(row => type === 'soil' ? soilStatus(row) : type === 'environment' ? environmentStatus(row) :
      type === 'dendro' ? dendroStatus(row) : type === 'gateway' ? gatewayStatus(row) : 'no_data');
    let state = type === 'soil' ? (() => {
      const values = rows.map(row => {
        const measured = ['swt_1','swt_2','swt_3','swt_wm1','swt_wm2'].map(key => row[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
      }).filter((value): value is number => value !== null);
      if (!values.length) return 'no_data';
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return mean > 50 ? 'dry_stress' : mean < 22 ? 'wet_excess' : 'optimal';
    })() : type === 'environment' ? priority(states, ['heat_stress','cold_stress','high_humidity','rain_day','normal'])
      : type === 'dendro' ? priority(states, ['incomplete_night_recovery','high_shrinkage_stress','reduced_growth','normal_growth'])
        : type === 'irrigation' ? (dayEvents.some(event => event.manualOverride === true || event.manual_override === true || /manual|override/i.test(String(event.type ?? event.action ?? event.reason ?? '')))
          ? 'manual_override'
          : dayEvents.some(event => event.possibleIneffectiveIrrigation === true || event.possible_ineffective_irrigation === true || /ineffective/i.test(String(event.type ?? event.action ?? event.reason ?? '')))
            ? 'possible_ineffective_irrigation' : dayEvents.length >= 3 ? 'high_irrigation_frequency' : dayEvents.length ? 'irrigation_event' : 'no_irrigation')
          : type === 'gateway' ? priority(states, ['offline','normal']) : 'no_data';
    const sampleCount = rows.length, eventCount = dayEvents.length;
    const markerStates = type === 'dendro' ? [...new Set(states.filter(status => status !== 'no_data'))]
      : type === 'environment' ? [...new Set(states.filter(status => status !== 'no_data'))] : state === 'no_data' ? [] : [state];
    const warnings = new Set(['dry_stress','wet_excess','high_shrinkage_stress','incomplete_night_recovery','heat_stress','cold_stress','high_irrigation_frequency','possible_ineffective_irrigation','offline']);
    days.push({date, state, coveragePct: null, coverageConfidence: 'unknown', summary: {key: `history.calendar.summary.${type}.${state}`, params: {sampleCount, eventCount}},
      metrics: {sampleCount, eventCount}, markers: markerStates.map(marker => ({type: 'state', severity: warnings.has(marker) ? 'warning' : 'info',
        labelKey: `history.calendar.marker.${type}.${marker}`, params: {sampleCount, eventCount}}))});
  }
  return {timezone, days};
}
function latestInRange(port: HistoryPort, device: Device, from: number, to: number) {
  const rows = port.ledger.forDevice(device.deveui).filter(sample => sample.at >= from && sample.at < to);
  return rows[rows.length - 1];
}
function buildAdvanced(card: NonNullable<ReturnType<typeof cardFor>>, devices: Device[], port: HistoryPort, pointCount: number, from: number, to: number) {
  const device = devices[0], latest: Record<string, unknown> = device ? (latestInRange(port, device, from, to)?.values ?? {}) as Record<string, unknown> : {};
  const makeField = (field: string, value: unknown, unit: string | null = null, supported = true) => ({field,
    value: value === undefined ? null : value as string | number | boolean | null, unit,
    availability: !supported ? 'unsupported' : value === undefined || value === null ? (device ? 'not_collected_at_time' : 'unknown_now') : 'collected'});
  const rangedSamples = devices.flatMap(item => port.ledger.forDevice(item.deveui).filter(sample => sample.at >= from && sample.at < to));
  const availableFields = [...new Set(rangedSamples.flatMap(sample => Object.entries(sample.values)
    .filter(([, value]) => value !== undefined && value !== null).map(([key]) => key)))].sort();
  const sourceDevices = devices.map(item => ({deveui: item.deveui.toUpperCase(), typeId: item.type_id, name: item.name, firmwareVersion: null}));
  const fields = {sourceDeviceCount: makeField('sourceDeviceCount', devices.length), logicalSourceKey: makeField('logicalSourceKey', device ? sourceKey(card.cardType as HistoryCardType, device) : null),
    primaryDeveui: makeField('primaryDeveui', device?.deveui.toUpperCase() ?? null), gatewayEui: makeField('gatewayEui', null, null, false),
    rawRowCount: makeField('rawRowCount', rangedSamples.length), rssi: makeField('rssi', latest.rssi, 'dBm'), snr: makeField('snr', latest.snr, 'dB'),
    batteryVoltage: makeField('batteryVoltage', latest.bat_v, 'V'), batteryPct: makeField('batteryPct', latest.bat_pct, '%'),
    firmwareVersion: makeField('firmwareVersion', null), rawPayload: makeField('rawPayload', latest.raw_payload, null),
    pendingCommands: makeField('pendingCommands', null, null, false), calibrationStatus: makeField('calibrationStatus', null, null, card.cardType === 'soil'),
    sourceCount: makeField('sourceCount', devices.length), pointCount: makeField('pointCount', pointCount)};
  const placeholder = {schemaVersion: 1, cardType: card.cardType, placeholder: true, generatedAt: iso(port.now), availableFields, sourceDevices,
    sections: [{id: 'source-devices', status: sourceDevices.length ? 'available' : 'not_available', itemCount: sourceDevices.length},
      {id: 'radio-diagnostics', status: availableFields.some(field => field === 'rssi' || field === 'snr') ? 'partial' : 'not_available'},
      {id: 'raw-payloads', status: availableFields.includes('raw_payload') ? 'partial' : 'not_available'}]};
  return {fields, placeholder};
}
function cardData(card: NonNullable<ReturnType<typeof cardFor>>, zone: IrrigationZone, port: HistoryPort, url: URL) {
  const req = parseCardRequest(url, zone, port.now, port.gatewayTimezone, card.cardType as HistoryCardType);
  const type = card.cardType as HistoryCardType;
  const sources = sourceDevices(zone, type, port.devices);
  const selectedSource = url.searchParams.get('sourceKey');
  const devices = selectedSource ? sources.filter(device => sourceKey(type, device) === selectedSource) : sources;
  const selectedAgronomy = type === 'environment' && selectedSource === DAILY_AGRONOMY_SOURCE_KEY;
  if (selectedSource && !devices.length && !selectedAgronomy) fail(400, 'invalid_source', 'Unsupported source');
  let coverageObserved = 0, coverageExpected = 0, coverageKnown = false, coverageDerived = false;
  const series: Array<{id: string; label: string; unit: string | null; depthCm: number | null; points: AggregatedPoint[]; truncated: boolean; coveragePct: number | null}> = devices.flatMap(device => channelsForDevice(type, device).map(channel => {
    const aggregate = aggregateChannel(port.ledger.forDevice(device.deveui), channel, req.fromMs, req.toMs, req.applied, req.timezone, port.now);
    coverageObserved += aggregate.observedCount;
    if (aggregate.expectedCount !== null) { coverageExpected += aggregate.expectedCount; coverageKnown = true; }
    if (aggregate.coverageConfidence === 'derived') coverageDerived = true;
    return {id: `${device.deveui}:${channel}`, label: `${device.name} - ${channelLabel(channel)}`, unit: channelUnit(channel),
      depthCm: type === 'soil' ? soilDepthCm(device, channel) : null, points: aggregate.points.slice(0, 2000), truncated: aggregate.truncated || aggregate.points.length > 2000,
      coveragePct: aggregate.coveragePct};
  }));
  if (type === 'environment' && (!selectedSource || selectedAgronomy)) {
    const timeline = syntheticEnvironmentTimeline(zone, req.fromMs, req.toMs, req.timezone, port.now, port.environmentRecords);
    for (const channel of ['et0_mm', 'etc_mm']) {
      const aggregate = aggregateChannel(timeline, channel, req.fromMs, req.toMs, req.applied, req.timezone, port.now);
      series.push({id: channel, label: `Illustrative simulator - ${channel === 'et0_mm' ? 'Reference ET (ET0)' : 'Crop water demand (ETc)'}`,
        unit: 'mm', depthCm: null, points: aggregate.points.slice(0, 2000),
        truncated: aggregate.truncated || aggregate.points.length > 2000, coveragePct: aggregate.coveragePct});
      coverageObserved += aggregate.observedCount;
      if (aggregate.expectedCount !== null) { coverageExpected += aggregate.expectedCount; coverageKnown = true; }
      if (aggregate.coverageConfidence === 'derived') coverageDerived = true;
    }
  }
  const events = type === 'irrigation' ? port.outcomes.filter(row => row.zoneId === zone.id && Date.parse(row.commandedAt) >= req.fromMs && Date.parse(row.commandedAt) < req.toMs
    && (!selectedSource || port.devices.some(device => device.deveui === row.deviceEui && sourceKey(type, device) === selectedSource)))
    .map(row => ({id: row.expectationId, type: row.trigger ?? 'irrigation', t: row.observedOpenAt ?? row.commandedAt, end: row.observedCloseAt,
      label: row.status, severity: row.status === 'COMPLETED' ? 'success' as const : row.status === 'CANCELLED' ? 'info' as const : 'warning' as const,
      metadata: {expectationId: row.expectationId, deviceEui: row.deviceEui, commandedAt: row.commandedAt, observedOpenAt: row.observedOpenAt,
        observedCloseAt: row.observedCloseAt, expectedCloseAt: row.expectedCloseAt, estimatedGrossLiters: row.estimatedGrossLiters,
        status: row.status, trigger: row.trigger}})) : [];
  const pointCount = series.reduce((sum, row) => sum + row.points.length, 0);
  const range = {label: req.label, from: req.from, to: req.to, timezone: req.timezone};
  const truncated = series.some(row => row.truncated);
  const aggregation = {level: req.applied, bucketSizeSeconds: req.bucketSizeSeconds,
    coveragePct: coverageKnown ? Math.min(100, Math.round(coverageObserved / coverageExpected * 100)) : null,
    coverageConfidence: coverageKnown ? coverageDerived ? 'derived' : 'configured' : coverageDerived ? 'derived' : 'unknown', pointCount, source: 'shared-ledger', dominantStatusMethod: `${type}-status-priority`};
  const freshness = {dataAsOf: pointCount ? iso(Math.min(port.now, req.toMs)) : null, syncState: 'local'};
  const diagnostic = buildAdvanced(card, devices, port, pointCount, req.fromMs, req.toMs);
  const advancedFields = diagnostic.fields;
  const profiles = type === 'soil' ? devices.flatMap(device => {
    const latest = (latestInRange(port, device, req.fromMs, req.toMs)?.values ?? {}) as Record<string, unknown>;
    return channelsForDevice(type, device).flatMap(channel => typeof latest[channel] === 'number'
      ? [{id: `${device.deveui}:${channel}`, label: `${device.name} - ${channelLabel(channel)}`, depthCm: soilDepthCm(device, channel), value: latest[channel] as number,
        unit: channelUnit(channel), status: /^swt_/.test(channel) ? (latest[channel] as number) > 50 ? 'dry_stress' : (latest[channel] as number) < 22 ? 'wet_excess' : 'optimal' : null}] : []);
  }) : [];
    const forecastRows = type === 'environment' && (!selectedSource || selectedAgronomy)
      ? syntheticEnvironmentTimeline(zone, req.fromMs, req.toMs, req.timezone, port.now, port.environmentRecords).map(sample => ({...sample.values,
        ambientTemperature: sample.values.air_temperature_c, relativeHumidity: sample.values.relative_humidity_pct,
        rainMm: sample.values.forecast_rain_mm, sourceLabel: 'Illustrative simulator', recorded_at: iso(sample.at)}))
      : [];
    const calendar = buildCalendar(type, devices, port, req.fromMs, req.toMs, req.timezone, events, forecastRows);
  const latestDay = calendar ? calendar.days[calendar.days.length - 1] : undefined;
  const dryDay = latestDay?.state === 'dry_stress' ? latestDay : undefined;
  const interpretations: Array<Record<string, unknown>> = [];
  if (dryDay) interpretations.push({id: `${card.cardId}:root-zone-dry`, ruleId: 'root-zone-dry', source: 'local-rule', severity: 'warning',
    titleKey: 'history.interpretation.rootZoneDry.title', bodyKey: 'history.interpretation.rootZoneDry.body',
    params: {hoursDry: Math.max(0, Math.round((port.now - Date.parse(`${dryDay.date}T00:00:00Z`)) / 3600000))},
    evidence: [{type: 'status', status: 'dry_stress', since: dryDay.date}]});
  if (type === 'dendro' && latestDay?.state === 'incomplete_night_recovery') {
    const dendroRows = devices.flatMap(device => port.ledger.forDevice(device.deveui)
      .filter(sample => sample.at >= req.fromMs && sample.at < req.toMs).map(sample => sample.values));
    const latestDendro = dendroRows[dendroRows.length - 1] as Record<string, unknown> | undefined;
    const recoveryRatio = typeof latestDendro?.dendro_ratio === 'number' && Number.isFinite(latestDendro.dendro_ratio) ? latestDendro.dendro_ratio : null;
    interpretations.push({id: `${card.cardId}:incomplete-night-recovery`, ruleId: 'incomplete-night-recovery', source: 'local-rule', severity: 'warning',
      titleKey: 'history.interpretation.incompleteNightRecovery.title', bodyKey: 'history.interpretation.incompleteNightRecovery.body',
      params: {recoveryRatio}, evidence: [{type: 'dendro_status', status: 'incomplete_night_recovery'}]});
  }
  const fullyFuture = req.fromMs >= port.now;
  if (!fullyFuture && (aggregation.coverageConfidence === 'unknown' || (aggregation.coveragePct !== null && aggregation.coveragePct < 80))) {
    interpretations.push({id: `${card.cardId}:data-coverage-gap`, ruleId: 'data-coverage-gap', source: 'local-rule',
      severity: aggregation.coverageConfidence === 'unknown' ? 'info' : 'warning', titleKey: 'history.interpretation.dataCoverageGap.title',
      bodyKey: 'history.interpretation.dataCoverageGap.body', params: {coveragePct: aggregation.coveragePct, coverageConfidence: aggregation.coverageConfidence},
      evidence: [{type: 'coverage', coveragePct: aggregation.coveragePct, coverageConfidence: aggregation.coverageConfidence}]});
  }
  return {cardId: card.cardId, cardType: type, view: req.view, range, aggregation,
    limits: {maxPointsPerSeries: 2000, maxEvents: 200, maxInterpretations: 20, truncated}, series: series.map(row => ({...row, points: row.points.slice(0, 2000)})),
    profiles, events, calendar, interpretations, freshness, advancedFields,
    advanced: {generatedAt: iso(port.now), cardId: card.cardId, cardType: type, range, freshness, aggregation,
      placeholder: diagnostic.placeholder, advancedFields}};
}
function csvCell(value: unknown): string { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function kpaToPf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0.1) return 0;
  return Math.round(Math.log10(value * 10) * 10000) / 10000;
}
function validDateOnly(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
function exportCsv(port: HistoryPort, zones: IrrigationZone[], url: URL) {
  const fromText = url.searchParams.get('from'), toText = url.searchParams.get('to'), granularity = url.searchParams.get('granularity') ?? 'daily';
  if (!validDateOnly(fromText) || !validDateOnly(toText) || fromText > toText) fail(400, 'invalid_range', 'Invalid export range', {suggestion: 'Choose a valid start and end date.'});
  const fromDate = fromText!, toDate = toText!;
  if (!['raw', 'hourly', 'daily'].includes(granularity)) fail(400, 'invalid_granularity', 'Invalid granularity');
  const onlyZone = url.pathname.match(/^\/api\/history\/zones\/(\d+)\/export\.csv$/)?.[1];
  const zone = onlyZone ? zones.find(item => item.id === Number(onlyZone)) : null;
  if (onlyZone && !zone) fail(404, 'zone_not_found', 'Zone not found', {suggestion: 'Choose an available zone.'});
  const selectedZones = zone ? [zone] : zones;
  if (!zone && url.searchParams.get('scope') !== 'allZones') fail(400, 'invalid_scope', 'scope must be allZones');
  const channelsFilter = url.searchParams.get('channels')?.split(',').filter(Boolean);
  const lines = [['timestamp', 'site', 'zone', 'series_label', 'card_type', 'source_key', 'channel_key', 'depth_cm', 'array_id', 'unit', 'value'].join(',')];
  for (const row of selectedZones) {
    const timezone = row.timezone || port.gatewayTimezone, from = localMidnight(fromDate, timezone), to = localMidnight(shiftDate(fromDate, dayDistance(fromDate, toDate) + 1), timezone);
    if (fromDate > localDateKey(port.now, timezone) || toDate > localDateKey(port.now, timezone)) fail(400, 'invalid_range', 'Future export dates are unavailable', {suggestion: 'Choose completed local dates.'});
    for (const device of port.devices.filter(item => item.irrigation_zone_id === row.id)) {
      const description = describeDeviceSource(device);
      for (const [cardType, sourceChannels] of Object.entries(description.families)) {
        if (cardType === 'device_health') continue;
        const channels = channelManifest.filter(meta => sourceChannels.includes(meta.key) && meta.edgeField && meta.exportable !== false && meta.deprecated !== true
          && (!channelsFilter?.length || channelsFilter.includes(meta.key)));
        for (const meta of channels) {
          const level = granularity === 'raw' ? 'raw' : granularity as 'hourly' | 'daily';
          const result = aggregateChannel(port.ledger.forDevice(device.deveui), meta.key, from, to, level, timezone, port.now);
          for (const point of result.points) {
            if (point.value === null || point.value === undefined) continue;
            const depth = cardType === 'soil' ? soilDepthCm(device, meta.key) : '';
            const arrayId = (device as Device & {chameleon_array_id?: string}).chameleon_array_id ?? '';
            const identity = sourceKeyForDevice(cardType, device);
            lines.push([point.t, '00000000000000D0', row.name, `${device.name} - ${meta.label}`, cardType, identity, meta.key, depth, arrayId, meta.unit, point.value].map(csvCell).join(','));
            if (meta.unit === 'kPa' && /^swt_/.test(meta.key)) {
              const pf = kpaToPf(point.value);
              if (pf !== null) lines.push([point.t, '00000000000000D0', row.name, `${device.name} - ${meta.label} (pF)`, cardType, identity,
                `${meta.key}_pf`, depth, arrayId, 'pF', pf].map(csvCell).join(','));
            }
          }
        }
      }
    }
  }
  if (!selectedZones.length) fail(404, 'export_unavailable', 'No zones are available', {suggestion: 'Add a zone and try again.'});
  return lines.join('\r\n');
}
function dayDistance(from: string, to: string): number { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000); }
function workspaceInput(payload: Record<string, unknown>, zones: IrrigationZone[], current?: WorkspaceRecord) {
  const name = typeof payload.name === 'string' ? payload.name.trim() : current?.name ?? '';
  const zoneId = payload.zoneId === undefined ? current?.zoneId ?? null : payload.zoneId === null ? null : Number(payload.zoneId);
  const workspace = payload.workspace === undefined ? current?.workspace : payload.workspace;
  if (!name || name.length > 100 || !workspace || typeof workspace !== 'object' || Array.isArray(workspace)
    || (zoneId !== null && (!Number.isInteger(zoneId) || !zones.some(zone => zone.id === zoneId)))) fail(400, 'invalid_workspace');
  return {name, zoneId, workspace: structuredClone(workspace as Record<string, unknown>), isDefault: payload.isDefault === undefined ? current?.isDefault ?? false : payload.isDefault === true};
}
function clearDefaultInScope(state: HistoryState, zoneId: number | null) {
  state.workspaces.forEach(row => { if (row.zoneId === zoneId) row.isDefault = false; });
}
export function handleHistoryRoute(state: HistoryState, port: HistoryPort, method: string, url: URL, body: Record<string, unknown>) {
  const path = url.pathname;
  const zoneCardsMatch = path.match(/^\/api\/history\/zones\/(\d+)\/cards(?:\/([^/]+)(?:\/(preferences|opened|data|advanced))?)?$/);
  if (zoneCardsMatch) {
    const zone = port.zones.find(item => item.id === Number(zoneCardsMatch[1])); if (!zone) return fail(404, 'zone_not_found');
    const card = zoneCardsMatch[2] ? cardsForZone(zone, port, state).find(row => row?.cardId === decodeURIComponent(zoneCardsMatch[2]!)) : null;
    if (zoneCardsMatch[2] && !card) fail(404, 'card_not_found');
    const action = zoneCardsMatch[3];
    if (method === 'GET' && !action) return {handled: true, value: {zoneId: zone.id, zoneUuid: zone.zone_uuid, generatedAt: iso(port.now), cards: cardsForZone(zone, port, state)}};
    if (method === 'PUT' && action === 'preferences') {
      const pref = structuredClone(readPreference(state, zone.id, card!.cardId, port.now));
      if (body.pinned !== undefined) { if (typeof body.pinned !== 'boolean') fail(400, 'invalid_preference'); pref.pinned = body.pinned === true; }
      if (body.hidden !== undefined) { if (typeof body.hidden !== 'boolean') fail(400, 'invalid_preference'); pref.hidden = body.hidden === true; }
      if (body.manualOrder !== undefined) { if (body.manualOrder !== null && (!Number.isInteger(body.manualOrder) || Number(body.manualOrder) < 0)) fail(400, 'invalid_preference'); pref.manualOrder = body.manualOrder as number | null; }
      if (body.lastViewMode !== undefined) { if (!(historyCardDefinitionsByType[card!.cardType as HistoryCardType].views as readonly string[]).includes(String(body.lastViewMode))) fail(400, 'invalid_preference'); pref.lastViewMode = String(body.lastViewMode) as HistoryViewMode; }
      pref.updatedAt = iso(port.now); state.preferences.set(preferenceKey(zone.id, card!.cardId), pref); return {handled: true, value: pref};
    }
    if (method === 'POST' && action === 'opened') {
      const pref = structuredClone(readPreference(state, zone.id, card!.cardId, port.now));
      if (body.lastViewMode !== undefined) { if (!(historyCardDefinitionsByType[card!.cardType as HistoryCardType].views as readonly string[]).includes(String(body.lastViewMode))) fail(400, 'invalid_preference'); pref.lastViewMode = String(body.lastViewMode) as HistoryViewMode; }
      pref.openCount++; pref.lastOpenedAt = iso(port.now); pref.updatedAt = iso(port.now);
      state.preferences.set(preferenceKey(zone.id, card!.cardId), pref); return {handled: true, value: pref};
    }
    if (method === 'GET' && (action === 'data' || action === 'advanced')) {
      const result = cardData(card!, zone, port, url); return {handled: true, value: action === 'advanced' ? result.advanced : result};
    }
  }
  const gatewayCardsMatch = path.match(/^\/api\/history\/gateways\/([^/]+)\/cards(?:\/([^/]+)\/(data|advanced))?$/);
  if (gatewayCardsMatch && method === 'GET') {
    const gatewayEui = decodeURIComponent(gatewayCardsMatch[1]!).toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(gatewayEui)) fail(400, 'invalid_gateway');
    const id = `${gatewayEui}:gateway:hub`;
    if (!gatewayCardsMatch[2]) return {handled: true, value: {gatewayEui, generatedAt: iso(port.now), cards: [{cardId: id, cardType: 'gateway', scope: 'gateway',
      title: titles.gateway[0], subtitle: titles.gateway[1], defaultView: 'status-overview', views: [...historyCardDefinitionsByType.gateway.views],
      supportedRanges: ['12h', '24h', '7d', '30d'], defaultRange: '24h', sourceDeviceCount: 1, sourceDevices: [], metadata: {lastSeenAt: iso(port.now),
        coveragePct: 100, coverageConfidence: 'configured', syncState: 'local'}, availability: {available: true, reasons: []}, ordering: {pinned: false, score: 0, recentRank: null}}]}};
    if (decodeURIComponent(gatewayCardsMatch[2]) !== id) fail(404, 'card_not_found');
    const params = url.searchParams, label = params.get('range') ?? '24h';
    if (!['12h', '24h', '7d', '30d', 'custom'].includes(label)) fail(400, 'invalid_range', 'Unsupported range');
    const fromRaw = params.get('from'), toRaw = params.get('to');
    if ((fromRaw && !toRaw) || (!fromRaw && toRaw)) fail(400, 'invalid_range', 'Both from and to are required');
    const from = fromRaw ? Date.parse(fromRaw) : port.now - ({'12h': 12, '24h': 24, '7d': 168, '30d': 720}[label] ?? 24) * 3600000;
    const to = toRaw ? Date.parse(toRaw) : port.now + 1;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || (label === 'custom' && (!params.get('from') || !params.get('to')))) fail(400, 'invalid_range', 'Invalid from/to range');
    const timezone = params.get('timezone') || port.gatewayTimezone;
    try { new Intl.DateTimeFormat('en', {timeZone: timezone}); } catch { fail(400, 'invalid_timezone', 'Invalid timezone'); }
    const view = params.get('view') ?? 'status-overview';
    if (!(historyCardDefinitionsByType.gateway.views as readonly string[]).includes(view)) fail(400, 'invalid_view', 'Unsupported view');
    const aggregationInfo = resolveHistoryAggregation(params.get('aggregation') ?? 'auto', label, from, to), hasCurrent = port.now >= from && port.now < to;
    const t = hasCurrent ? iso(port.now) : null, stats = hasCurrent ? port.gatewayStats ?? {} : {};
    const metrics: Array<[string, string, string, unknown]> = [
      ['cpu_temp_c', 'CPU temperature', 'C', stats.cpu_temp_c], ['mem_used_mb', 'Memory used', 'MB', stats.mem_used_mb],
      ['mem_percent', 'Memory used', '%', stats.mem_percent], ['load_1', 'Load average (1 minute)', null as unknown as string, stats.load_1],
      ['fan_value', 'Fan value', null as unknown as string, stats.fan_value],
    ];
    const series = metrics.filter(([, , , value]) => typeof value === 'number').map(([key, labelText, unit, value]) => ({id: key, label: labelText, unit,
      points: hasCurrent ? [{t: t!, value: value as number, min: value as number, max: value as number, mean: value as number, median: value as number,
        latest: value as number, coverageConfidence: 'unknown' as const, count: 1, quality: 'ok' as const}] : []}));
    const range = {label, from: iso(from), to: iso(to), timezone};
    const pointCount = series.filter(row => row.points.length).length;
    const aggregation = {level: aggregationInfo.applied, bucketSizeSeconds: aggregationInfo.bucketSizeSeconds, coveragePct: null, coverageConfidence: 'unknown',
      pointCount, dominantStatusMethod: 'gateway-status-priority'};
    const freshness = {dataAsOf: t, syncState: 'local'};
    const advancedFields = {cpuTemperature: {field: 'cpuTemperature', value: stats.cpu_temp_c ?? null, unit: 'C', availability: hasCurrent ? 'collected' : 'not_collected_at_time'},
      memoryUsed: {field: 'memoryUsed', value: stats.mem_used_mb ?? null, unit: 'MB', availability: hasCurrent ? 'collected' : 'not_collected_at_time'}};
    const calendar = buildCalendar('gateway', [], port, from, to, timezone, [], t ? [{recorded_at: t, lastSeenAt: t}] : []);
    const data = {cardId: id, cardType: 'gateway', view, range, aggregation,
      limits: {maxPointsPerSeries: 2000, maxEvents: 200, maxInterpretations: 20, truncated: false}, series, profiles: [], events: [], calendar,
      interpretations: [], freshness, advancedFields};
    const advanced = {generatedAt: iso(port.now), cardId: id, cardType: 'gateway', range, freshness, aggregation,
      placeholder: {schemaVersion: 1, cardType: 'gateway', placeholder: true, generatedAt: iso(port.now), availableFields: hasCurrent ? metrics.filter(row => typeof row[3] === 'number').map(row => row[0]) : [],
        sourceDevices: [], sections: []}, advancedFields};
    return {handled: true, value: gatewayCardsMatch[3] === 'advanced' ? advanced : data};
  }
  if (path === '/api/history/workspaces' && method === 'GET') return {handled: true, value: {generatedAt: iso(port.now), workspaces: state.workspaces}};
  if (path === '/api/history/workspaces' && method === 'POST') {
    const input = workspaceInput(body, port.zones); if (input.isDefault) clearDefaultInScope(state, input.zoneId);
    const record = {id: state.nextWorkspaceId++, userId: 1, ownerUserUuid: null, ...input, createdAt: iso(port.now), updatedAt: iso(port.now)};
    state.workspaces.unshift(record); return {handled: true, value: record, status: 201};
  }
  const workspaceMatch = path.match(/^\/api\/history\/workspaces\/(\d+)$/);
  if (workspaceMatch) {
    const index = state.workspaces.findIndex(row => row.id === Number(workspaceMatch[1])); if (index < 0) fail(404, 'workspace_not_found');
    if (method === 'PUT') {
      const current = state.workspaces[index]!; const input = workspaceInput(body, port.zones, current); if (input.isDefault) clearDefaultInScope(state, input.zoneId);
      const updated = {...current, ...input, updatedAt: iso(port.now)}; state.workspaces[index] = updated; return {handled: true, value: updated};
    }
    if (method === 'DELETE') {
      const [deleted] = state.workspaces.splice(index, 1);
      if (deleted?.isDefault) {
        const replacement = state.workspaces.find(row => row.zoneId === deleted.zoneId);
        if (replacement) replacement.isDefault = true;
      }
      return {handled: true, value: {}};
    }
  }
  if ((path === '/api/history/export.csv' || /^\/api\/history\/zones\/\d+\/export\.csv$/.test(path)) && method === 'GET') {
    const csv = exportCsv(port, port.zones, url);
    return {handled: true, value: csv, contentType: 'text/csv; charset=utf-8', filename: path.includes('/zones/') ? 'zone-history.csv' : 'all-zones-history.csv'};
  }
  return {handled: false};
}
