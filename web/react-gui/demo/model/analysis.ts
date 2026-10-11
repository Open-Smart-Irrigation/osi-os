import type {Device, IrrigationZone} from '../../src/types/farming';
import type {AnalysisCatalogEntry, AnalysisSeriesRequest, AnalysisViewJson} from '../../src/analysis/types';
import {DAILY_AGRONOMY_SOURCE_KEY} from '../../src/analysis/types';
import type {ReadingLedger} from './readings';
import {aggregateChannel, resolveAggregation} from './aggregation';
import {analysisSeriesId, describeDeviceSource, deviceSourceId, soilDepthCm, sourceKey} from './device-sources';
import {iso} from '../fixtures';
import {DemoError} from '../errors';
import {hasIllustrativeWeatherSource, syntheticEnvironmentTimeline} from './environment';
import type {RetainedEnvironmentRecord} from './state';
import channelManifestJson from '../../src/channels/channels.json';

export type AnalysisViewRecord = {id: number; name: string; selectors: Array<{seriesId: string}>; range: AnalysisViewJson['range'];
  mode: string; schemaVersion: number; layout: AnalysisViewJson['layout']; toggles: AnalysisViewJson['toggles'];
  labelOverrides: AnalysisViewJson['labelOverrides']; axisLabelOverrides: AnalysisViewJson['axisLabelOverrides'];
  isDefault: boolean; updatedAt: string};
export type AnalysisState = {views: AnalysisViewRecord[]; nextViewId: number};
export function createAnalysisState(): AnalysisState { return {views: [], nextViewId: 1}; }
type AnalysisPort = {devices: Device[]; zones: IrrigationZone[];
  ledger: ReadingLedger; now: number; gatewayTimezone: string; environmentRecords?: Map<string, RetainedEnvironmentRecord>};
const fail = (status: number, code: string, message = code): never => { throw new DemoError(status, code, {error: code, message}); };
function resolveAnalysisAggregation(value: string, label: string, from: number, to: number) {
  try { return resolveAggregation(value, label, from, to); }
  catch (error) { if ((error as {code?: string}).code === 'invalid_aggregation') fail(422, 'invalid', 'Unsupported aggregation'); throw error; }
}
const channelManifest = channelManifestJson as Array<{
  key: string; unit: string | null; label: string; cardType: string; edgeField?: string | null; exportable?: boolean; deprecated?: boolean;
}>;

function devicesForZone(port: AnalysisPort, zoneId: number | null): Device[] {
  return port.devices.filter(device => device.irrigation_zone_id === zoneId)
    .slice().sort((a, b) => a.deveui.localeCompare(b.deveui));
}
export function buildAnalysisCatalog(port: AnalysisPort) {
  const sources: Array<Record<string, unknown>> = [];
  const channels: AnalysisCatalogEntry[] = [];
  const zones: Array<{id: number | null; name: string | null}> = [...port.zones.map(zone => ({id: zone.id, name: zone.name})), {id: null, name: null}];
  for (const zone of zones) for (const device of devicesForZone(port, zone.id)) {
    const description = describeDeviceSource(device), sourceId = deviceSourceId(device);
    const source = {id: sourceId, hubEui: null, zoneId: zone.id, zoneName: zone.name, name: device.name,
      typeId: device.type_id, channelIds: [] as string[], presentation: description.presentation,
      destination: description.destination, limitation: description.limitation};
    for (const [cardType, sourceChannels] of Object.entries(description.families)) {
      const candidates = channelManifest.filter(channel => sourceChannels.includes(channel.key) && channel.deprecated !== true);
      for (const channel of candidates) {
        const logicalKey = sourceKeyForDevice(cardType, device);
        const id = analysisSeriesId(zone.id, cardType, logicalKey, channel.key);
        channels.push({seriesId: id, hubEui: null, zoneId: zone.id, zoneName: zone.name, cardType, sourceKey: logicalKey, channelKey: channel.key,
          displayName: `${device.name} - ${channel.label}`, unit: channel.unit,
          availability: channel.edgeField ? 'available' : 'unsupported', deviceName: device.name,
          depthCm: cardType === 'soil' ? soilDepthCm(device, channel.key) : null,
          depthReference: cardType === 'soil' && soilDepthCm(device, channel.key) !== null ? 'current_layout' : null,
          sourceKind: 'device', deviceSourceId: sourceId, configurationState: description.current.includes(channel.key) ? 'current' : 'other_supported'});
        source.channelIds.push(id);
      }
    }
    sources.push(source);
  }
  for (const zone of port.zones.filter(hasIllustrativeWeatherSource)) {
    const sourceId = `zone_daily_agronomy:${zone.id}`;
    const source = {id: sourceId, hubEui: null, zoneId: zone.id, zoneName: zone.name, name: 'Illustrative simulator',
      typeId: 'zone_daily_agronomy', channelIds: [] as string[], presentation: 'timeseries' as const, destination: null, limitation: null};
    for (const channelKey of ['et0_mm', 'etc_mm']) {
      const channel = channelManifest.find(row => row.key === channelKey)!;
      const id = analysisSeriesId(zone.id, 'environment', DAILY_AGRONOMY_SOURCE_KEY, channelKey);
      channels.push({seriesId: id, hubEui: null, zoneId: zone.id, zoneName: zone.name, cardType: 'environment',
        sourceKey: DAILY_AGRONOMY_SOURCE_KEY, channelKey, displayName: `Illustrative simulator - ${channel.label}`,
        unit: channel.unit, availability: 'available', deviceName: 'Illustrative simulator', depthCm: null,
        sourceKind: 'zone_daily_agronomy', deviceSourceId: null, configurationState: 'current'});
      source.channelIds.push(id);
    }
    sources.push(source);
  }
  return {generatedAt: iso(port.now), sources, channels};
}
function sourceKeyForDevice(cardType: string, device: Device) { return sourceKey(cardType, device); }
function parseRange(request: AnalysisSeriesRequest, timezone: string) {
  const from = Date.parse(request.range?.from ?? ''); const to = Date.parse(request.range?.to ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) fail(400, 'invalid_range', 'Invalid from/to range');
  return {from: new Date(from).toISOString(), to: new Date(to).toISOString(), label: request.range.label || 'custom', timezone};
}
export function resolveAnalysisSeries(port: AnalysisPort, request: AnalysisSeriesRequest) {
  if (!request || !Array.isArray(request.selectors)) fail(400, 'invalid_request');
  if (request.selectors.length > 12) fail(413, 'too_many_series');
  const range = parseRange(request, port.gatewayTimezone);
  const start = Date.parse(range.from), end = Date.parse(range.to);
  const aggregation = resolveAnalysisAggregation(request.aggregation || 'auto', range.label, start, end);
  const catalog = buildAnalysisCatalog(port);
  const byId = new Map(catalog.channels.map(entry => [entry.seriesId, entry]));
  const series = [], dropped: Array<{seriesId: string | null; reason: string}> = [];
  for (const selector of request.selectors) {
    const entry = byId.get(selector.seriesId);
    if (!entry) { dropped.push({seriesId: selector.seriesId || null, reason: 'unknown'}); continue; }
    if (entry.availability !== 'available') { dropped.push({seriesId: entry.seriesId, reason: 'unsupported'}); continue; }
    const agronomy = entry.sourceKind === 'zone_daily_agronomy';
    const zone = port.zones.find(item => item.id === entry.zoneId);
    const device = agronomy ? undefined : port.devices.find(item => deviceSourceId(item) === entry.deviceSourceId);
    if (agronomy && !zone || !agronomy && !device) { dropped.push({seriesId: entry.seriesId, reason: 'unknown'}); continue; }
    const timeZone = agronomy ? zone!.timezone ?? port.gatewayTimezone : port.zones.find(item => item.id === device!.irrigation_zone_id)?.timezone ?? port.gatewayTimezone;
    const samples = agronomy ? syntheticEnvironmentTimeline(zone!, start, end, timeZone, port.now, port.environmentRecords)
      : port.ledger.forDevice(device!.deveui);
    const aggregate = aggregateChannel(samples, entry.channelKey, start, end, aggregation.applied, timeZone, port.now);
    const points = aggregate.points.slice(0, 2000);
    series.push({seriesId: entry.seriesId, resolved: {hubEui: null, zoneId: entry.zoneId, cardType: entry.cardType,
      sourceKey: entry.sourceKey, channelKey: entry.channelKey, deviceSourceId: entry.deviceSourceId}, label: entry.displayName,
      unit: entry.unit, coveragePct: aggregate.coveragePct, points, truncated: aggregate.truncated || aggregate.points.length > 2000,
      cadence: aggregation.applied === 'daily' || aggregation.applied === 'weekly' ? 'daily' as const : 'hourly' as const, timezone: timeZone});
  }
  return {generatedAt: iso(port.now), range, aggregation: {requested: aggregation.requested, applied: aggregation.applied,
    ...(aggregation.bucketSizeSeconds === null ? {} : {bucketSizeSeconds: aggregation.bucketSizeSeconds})}, series, dropped};
}
function normalizedView(body: Record<string, unknown>): Omit<AnalysisViewRecord, 'id' | 'updatedAt'> {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) fail(400, 'invalid_view', 'Analysis view name is required');
  if (!Array.isArray(body.selectors) || !body.range || typeof body.range !== 'object') fail(400, 'invalid_view', 'Invalid analysis view');
  const selectors = (body.selectors as Array<{seriesId?: unknown}>).filter(row => typeof row?.seriesId === 'string').map(row => ({seriesId: String(row.seriesId)}));
  const range = body.range as AnalysisViewJson['range'];
  if (!['relative', 'absolute'].includes(range.mode) || typeof range.label !== 'string') fail(400, 'invalid_view', 'Invalid analysis range');
  return {name, selectors, range: structuredClone(range), mode: typeof body.mode === 'string' ? body.mode : 'timeline',
    schemaVersion: Number(body.schemaVersion ?? 1), layout: body.layout === 'overlaid' || body.layout === 'small-multiples' ? body.layout : 'stacked',
    toggles: structuredClone((body.toggles ?? {}) as AnalysisViewJson['toggles']),
    labelOverrides: structuredClone((body.labelOverrides ?? {}) as AnalysisViewJson['labelOverrides']),
    axisLabelOverrides: structuredClone((body.axisLabelOverrides ?? {}) as AnalysisViewJson['axisLabelOverrides']),
    isDefault: body.isDefault === true || body.is_default === true};
}
export function handleAnalysisRoute(state: AnalysisState, port: AnalysisPort, method: string, path: string, body: Record<string, unknown>): {handled: boolean; value?: unknown; status?: number} {
  if (path === '/api/analysis/channels' && method === 'GET') return {handled: true, value: buildAnalysisCatalog(port)};
  if (path === '/api/analysis/series' && method === 'POST') return {handled: true, value: resolveAnalysisSeries(port, body as unknown as AnalysisSeriesRequest)};
  if (path === '/api/analysis/views' && method === 'GET') {
    const ids = new Set(buildAnalysisCatalog(port).channels.map(channel => channel.seriesId));
    return {handled: true, value: {views: state.views.map(view => ({...structuredClone(view),
      selectors: view.selectors.filter(row => ids.has(row.seriesId)),
      droppedSeriesIds: view.selectors.filter(row => !ids.has(row.seriesId)).map(row => row.seriesId)}))}};
  }
  if (path === '/api/analysis/views' && method === 'POST') {
    const view = normalizedView(body);
    const suppliedId = body.id === undefined || body.id === null || body.id === '' ? null : Number(body.id);
    if (suppliedId !== null && (!Number.isSafeInteger(suppliedId) || suppliedId <= 0)) fail(400, 'invalid_view_id');
    if (suppliedId !== null && !state.views.some(row => row.id === suppliedId)) fail(404, 'view_not_found');
    const id = suppliedId ?? state.nextViewId++;
    const record = {...view, id, updatedAt: iso(port.now)};
    state.views = suppliedId === null ? [...state.views, record] : state.views.map(row => row.id === id ? record : row);
    return {handled: true, value: record, status: 201};
  }
  const viewMatch = path.match(/^\/api\/analysis\/views\/([^/]+)$/);
  if (viewMatch && method === 'DELETE') {
    const id = Number(viewMatch[1]); if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'invalid_view_id');
    const index = state.views.findIndex(row => row.id === id); if (index < 0) fail(404, 'view_not_found');
    const [removed] = state.views.splice(index, 1);
    if (removed?.isDefault && state.views[0]) state.views[0].isDefault = true;
    return {handled: true, value: {}};
  }
  return {handled: false};
}
