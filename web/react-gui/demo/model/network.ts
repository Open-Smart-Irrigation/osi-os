import type {Device} from '../../src/types/farming';
import type {ReadingLedger} from './readings';
import {DemoError} from '../errors';
import {iso} from '../fixtures';

export type NetworkState = {locations: Map<string, Array<Record<string, unknown>>>; radios: Map<string, Array<Record<string, unknown>>>;
  observationIds: Map<string, number>; nextObservationId: number};
export function createNetworkState(): NetworkState { return {locations: new Map(), radios: new Map(), observationIds: new Map(), nextObservationId: 1}; }
const EUI = /^[0-9A-F]{16}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status: number, message: string): never => { throw new DemoError(status, message, {error: message}); };
function canonicalEui(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return fail(400, 'invalid device EUI'); }
  const eui = decoded.trim().toUpperCase(); return EUI.test(eui) ? eui : fail(400, 'invalid device EUI');
}
function timestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) return fail(400, `${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}
function nullableNumber(value: unknown, name: string, valid: (n: number) => boolean = () => true): number | null {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'string' && value.trim() === '') return fail(400, `${name} is invalid`);
  const n = Number(value);
  return Number.isFinite(n) && valid(n) ? n : fail(400, `${name} is invalid`);
}
function revisionHead(rows: Array<Record<string, unknown>>) {
  return rows.filter(row => !rows.some(candidate => candidate.supersedesRevisionUuid === row.revisionUuid))
    .sort((a, b) => Number(b.revisionNo) - Number(a.revisionNo))[0];
}
function readRevision(rows: Array<Record<string, unknown>>, now: number) {
  return rows.filter(row => Date.parse(String(row.effectiveFrom)) <= now
    && !rows.some(candidate => candidate.supersedesRevisionUuid === row.revisionUuid))
    .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)) || Number(b.revisionNo) - Number(a.revisionNo))[0] ?? null;
}
function saveRevision(rows: Array<Record<string, unknown>>, globalRows: Array<Record<string, unknown>>,
  eui: string, kind: 'location' | 'radio', body: Record<string, unknown>, now: number) {
  const values = body.values && typeof body.values === 'object' ? body.values as Record<string, unknown> : {};
  const uuid = String(body.revision_uuid ?? '').toLowerCase();
  if (!UUID4.test(uuid)) return fail(400, 'revisionUuid must be a canonical UUID v4');
  const effectiveFrom = timestamp(values.effectiveFrom, 'effectiveFrom');
  const base = body.base_revision_uuid == null || String(body.base_revision_uuid).trim() === '' ? null : String(body.base_revision_uuid).toLowerCase();
  if (base !== null && !UUID4.test(base)) return fail(400, 'baseRevisionUuid must be a canonical UUID v4');
  const supersedes = values.supersedesRevisionUuid == null || String(values.supersedesRevisionUuid).trim() === ''
    ? null : String(values.supersedesRevisionUuid).toLowerCase();
  if (supersedes !== null && !UUID4.test(supersedes)) return fail(400, 'supersedesRevisionUuid must be a canonical UUID v4');
  const existing = globalRows.find(row => row.revisionUuid === uuid);
  const head = revisionHead(rows);
  const revisionNo = rows.reduce((max, row) => Math.max(max, Number(row.revisionNo) || 0), 0) + 1;
  const common = {revisionUuid: uuid, deviceEui: eui, installationUuid: '00000000-0000-4000-8000-000000000001',
    gatewayEui: '0000000000000001', baseRevisionUuid: base, revisionNo,
    effectiveFrom, recordedAt: timestamp(values.recordedAt ?? (existing?.recordedAt ?? iso(now)), 'recordedAt'), syncVersion: revisionNo,
    actorUserUuid: '00000000-0000-4000-8000-000000000002', supersedesRevisionUuid: supersedes};
  const row: Record<string, unknown> = kind === 'location' ? {...common, latitude: nullableNumber(values.latitude, 'latitude', n => n >= -90 && n <= 90),
    longitude: nullableNumber(values.longitude, 'longitude', n => n >= -180 && n <= 180), altitudeM: nullableNumber(values.altitudeM, 'altitudeM'),
    verticalReference: values.verticalReference == null ? null : String(values.verticalReference),
    accuracyM: nullableNumber(values.accuracyM, 'accuracyM', n => n >= 0), antennaHeightAglM: nullableNumber(values.antennaHeightAglM, 'antennaHeightAglM', n => n >= 0),
    coordinateSource: String(values.coordinateSource || 'manual')} : {...common,
    txPowerDbm: nullableNumber(values.txPowerDbm, 'txPowerDbm'), antennaGainDbi: nullableNumber(values.antennaGainDbi, 'antennaGainDbi', n => n >= 0 && n <= 13),
    feederLossDb: nullableNumber(values.feederLossDb, 'feederLossDb', n => n >= 0), configurationSource: String(values.configurationSource || 'unknown')};
  if (kind === 'location' && (row.latitude == null || row.longitude == null)) return fail(400, 'latitude and longitude are required');
  if (existing) {
    const comparable = kind === 'location'
      ? ['deviceEui','installationUuid','gatewayEui','baseRevisionUuid','latitude','longitude','altitudeM','verticalReference','accuracyM','antennaHeightAglM','coordinateSource','effectiveFrom','recordedAt','actorUserUuid','supersedesRevisionUuid']
      : ['deviceEui','installationUuid','gatewayEui','baseRevisionUuid','txPowerDbm','antennaGainDbi','feederLossDb','configurationSource','effectiveFrom','recordedAt','actorUserUuid','supersedesRevisionUuid'];
    if (comparable.some(key => (existing as Record<string, unknown>)[key] !== row[key])) return fail(409, 'revision UUID payload mismatch');
    return {...structuredClone(existing), replayed: true};
  }
  if (head ? base !== head.revisionUuid : base !== null) return fail(409, head ? 'stale base revision' : 'base revision does not exist');
  if (supersedes === uuid) return fail(409, 'revision cannot supersede itself');
  if (supersedes) {
    const prior = rows.find(candidate => candidate.revisionUuid === supersedes);
    if (!prior || prior.deviceEui !== eui || prior.installationUuid !== common.installationUuid) return fail(409, 'superseded revision belongs to another device or installation');
    if (prior.effectiveFrom !== effectiveFrom) return fail(409, 'correction must retain effective time');
  }
  rows.push(row);
  return structuredClone(row);
}

type NetworkPort = {devices: Device[]; ledger: ReadingLedger; now: number; state: NetworkState};
export function handleNetworkRoute(port: NetworkPort, method: string, url: URL, body: Record<string, unknown>): {handled: boolean; value?: unknown; status?: number} {
  const path = url.pathname;
  const match = path.match(/^\/api\/devices\/([^/]+)\/(installation-location|radio-configuration)(\/revisions)?$/);
  if (match) {
    const eui = canonicalEui(match[1]!);
    if (!port.devices.some(device => device.deveui === eui)) return fail(404, 'device not found');
    const kind = match[2] === 'installation-location' ? 'location' : 'radio';
    const rows = (kind === 'location' ? port.state.locations : port.state.radios).get(eui) ?? [];
    if (method === 'GET' && match[3]) return {handled: true, value: structuredClone(rows).sort((a,b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)) || Number(b.revisionNo) - Number(a.revisionNo)).slice(0, 200)};
    if (method === 'GET') return {handled: true, value: readRevision(rows, port.now) ?? {device_eui: eui, source: 'unknown'}};
    if (method !== 'PUT' || match[3]) return fail(405, 'method not allowed');
    const globalRows = [...(kind === 'location' ? port.state.locations : port.state.radios).values()].flat();
    const saved = saveRevision(rows, globalRows, eui, kind, body, port.now);
    (kind === 'location' ? port.state.locations : port.state.radios).set(eui, rows);
    return {handled: true, value: saved, status: saved.replayed ? 200 : 201};
  }
  if (path === '/api/network/observations' && method === 'GET') {
    const hoursRaw = url.searchParams.get('hours');
    const hours = Math.min(720, Math.max(1, Number(hoursRaw || 24) || 24));
    const fromRaw = url.searchParams.get('from'), toRaw = url.searchParams.get('to');
    const start = fromRaw == null ? port.now - hours * 3600000 : Date.parse(fromRaw);
    const end = toRaw == null ? port.now : Date.parse(toRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 30 * 86400000) return fail(400, 'invalid observation window');
    const from = iso(start), to = iso(end);
    const requested = [...url.searchParams.getAll('deviceEuis'), ...url.searchParams.getAll('deviceEuis[]')].map(canonicalEui);
    const devices = requested.length ? port.devices.filter(device => requested.includes(device.deveui)) : port.devices;
    if (requested.some(eui => !port.devices.some(device => device.deveui === eui))) return fail(404, 'device not found');
    const rows = devices.flatMap(device => port.ledger.forDevice(device.deveui).filter(sample => sample.at >= start && sample.at <= end).map(sample => {
      const position = fictionalPosition(device);
      const index = Math.floor(sample.at / 900000);
      const rssi = -52 - Math.abs(index % 58);
      const snr = Number((7 - (index % 12) * 0.5).toFixed(1));
      const identity = `${device.deveui}|${sample.at}`;
      let id = port.state.observationIds.get(identity);
      if (id === undefined) { id = port.state.nextObservationId++; port.state.observationIds.set(identity, id); }
      return {id, installation_uuid: '00000000-0000-4000-8000-000000000001', deveui: device.deveui, recorded_at: iso(sample.at),
        deduplication_id: `SIM-${device.deveui}-${sample.at}`, dirty_generation: 0,
        metadata_json: JSON.stringify({simulation: 'illustrative', reported_position: position,
          receivers: [{gateway_id: 'SIM-GATEWAY-1', rssi_dbm: rssi, snr_db: snr, position: {latitude: 0.3476, longitude: 32.5825}}]})};
    })).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at) || Number(b.id) - Number(a.id));
    const limit = Math.floor(Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 500) || 500)));
    const offset = Math.floor(Math.min(100000, Math.max(0, Number(url.searchParams.get('offset') || 0) || 0)));
    const selected = rows.slice(offset, offset + limit + 1), truncated = selected.length > limit;
    return {handled: true, value: {rows: selected.slice(0, limit), truncated, nextOffset: truncated ? offset + limit : null, from, to}};
  }
  return {handled: false};
}

function fictionalPosition(device: Device) {
  const offset = Number.parseInt(device.deveui.slice(-2), 16) || 0;
  return {latitude: Number((0.3476 + (offset % 11) * 0.00004).toFixed(6)), longitude: Number((32.5825 + (offset % 13) * 0.00004).toFixed(6))};
}
