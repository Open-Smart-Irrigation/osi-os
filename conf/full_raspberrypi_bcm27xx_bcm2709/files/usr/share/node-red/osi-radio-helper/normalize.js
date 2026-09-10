'use strict';
const crypto = require('crypto');
const MAX_RECEIVERS = 64, MAX_METADATA_BYTES = 64 * 1024;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function number(value, integer, nonnegative = false) { if (value == null) return null; if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || (nonnegative && value < 0)) throw new Error('invalid numeric metadata'); return value; }
function time(value) { const d = new Date(value); if (!Number.isFinite(d.getTime())) throw new Error('invalid timestamp'); return d.toISOString(); }
function position(value) {
  if (value == null) return null;
  const latitude = number(value.latitude), longitude = number(value.longitude);
  if (latitude == null || longitude == null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('invalid WGS84 position');
  return { latitude, longitude, altitude_m: number(value.altitude_m), accuracy_m: number(value.accuracy_m), hdop: number(value.hdop), satellites: number(value.satellites, true), fix_time: value.fix_time == null ? null : time(value.fix_time), source: value.source == null ? null : String(value.source), sync_version: number(value.sync_version, true) };
}
function radio(value) {
  if (value == null) return null;
  let adr = null;
  if (value.adr != null) { if (value.adr !== true && value.adr !== false && value.adr !== 0 && value.adr !== 1) throw new Error('invalid boolean metadata'); adr = Boolean(value.adr); }
  if (value.coding_rate != null && typeof value.coding_rate !== 'string') throw new Error('invalid radio metadata');
  return { frequency_hz: number(value.frequency_hz, true, true), spreading_factor: number(value.spreading_factor, true, true), bandwidth_hz: number(value.bandwidth_hz, true, true), coding_rate: value.coding_rate == null ? null : value.coding_rate, f_cnt: number(value.f_cnt, true, true), adr, f_port: number(value.f_port, true, true) };
}
function deviceLocation(value, installation_uuid) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid device location');
  const out = { revision_uuid: value.revision_uuid == null ? null : String(value.revision_uuid), latitude: number(value.latitude), longitude: number(value.longitude), altitude_m: number(value.altitude_m), accuracy_m: number(value.accuracy_m), antenna_height_agl_m: number(value.antenna_height_agl_m), effective_from: value.effective_from == null ? null : time(value.effective_from), coordinate_source: value.coordinate_source == null ? null : String(value.coordinate_source), installation_uuid: value.installation_uuid == null ? null : String(value.installation_uuid).toLowerCase(), sync_version: number(value.sync_version, true, true) };
  if (out.latitude == null || out.longitude == null || out.latitude < -90 || out.latitude > 90 || out.longitude < -180 || out.longitude > 180 || !out.revision_uuid || !out.effective_from || !out.coordinate_source || out.installation_uuid !== installation_uuid) throw new Error('invalid device location');
  if (out.accuracy_m != null && out.accuracy_m < 0 || out.antenna_height_agl_m != null && out.antenna_height_agl_m < 0) throw new Error('invalid device location');
  return out;
}
function normalizeUplink(event, context = {}) {
  const installation_uuid = String(context.installationUuid || '').trim().toLowerCase();
  if (!UUID4.test(installation_uuid)) throw new Error('validated installation UUID required');
  const deveui = String(event && event.deveui || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(deveui)) throw new Error('valid DevEUI required');
  const input = event.metadata && typeof event.metadata === 'object' ? event.metadata : {}, receivers = new Map();
  for (const item of Array.isArray(input.receivers) ? input.receivers : []) {
    if (typeof item.gateway_id !== 'string' || !/^[0-9A-Fa-f]{16}$/.test(item.gateway_id.trim())) throw new Error('receiver gateway_id required');
    if (item.crc_status != null && typeof item.crc_status !== 'string') throw new Error('invalid receiver metadata');
    const value = { gateway_id: item.gateway_id.trim().toUpperCase(), uplink_id_num: number(item.uplink_id_num, true, true), rssi_dbm: number(item.rssi_dbm), snr_db: number(item.snr_db), channel: number(item.channel, true, true), crc_status: item.crc_status == null ? null : item.crc_status, position: position(item.position) };
    const key = value.gateway_id + '|' + (value.uplink_id_num == null ? 'null' : value.uplink_id_num), old = receivers.get(key);
    if (old && JSON.stringify(old) !== JSON.stringify(value)) throw new Error('conflicting receiver metadata');
    receivers.set(key, value);
  }
  if (receivers.size > MAX_RECEIVERS) throw new Error('receiver fan-out exceeds 64');
  const metadata = { version: 1, ingested_at: time(context.ingestedAt || new Date()), timestamp_source: context.timestampSource === 'network' ? 'network' : 'ingest', deduplication_uncertain: Boolean(context.deduplicationUncertain), radio: radio(input.radio), reported_position: position(input.reported_position), receivers: [...receivers.values()].sort((a, b) => a.gateway_id.localeCompare(b.gateway_id) || (a.uplink_id_num == null ? -1 : b.uplink_id_num == null ? 1 : a.uplink_id_num - b.uplink_id_num)), device_location: deviceLocation(input.device_location, installation_uuid) };
  const metadata_json = JSON.stringify(metadata); if (Buffer.byteLength(metadata_json) > MAX_METADATA_BYTES) throw new Error('radio metadata exceeds 64 KiB');
  const deduplication_id = event.deduplication_id == null ? crypto.randomUUID() : event.deduplication_id;
  if (typeof deduplication_id !== 'string' || deduplication_id.trim().length === 0 || deduplication_id.length > 256) throw new Error('invalid deduplication id');
  return { installation_uuid, deveui, recorded_at: time(event.recorded_at || context.ingestedAt || new Date()), deduplication_id: deduplication_id.trim(), metadata_json };
}
module.exports = { normalizeUplink, position };
