'use strict';

// Metadata only. The field tester's existing ten-byte GPS format is decoded
// exclusively behind the configured tester profile gate; payload bytes never persist.
function decodeTesterGps(data, time) {
  if (typeof data !== 'string' || data.length > 4096) return null;
  const b = Buffer.from(data, 'base64');
  if (b.length < 10) return null;
  const hdop = b[8] / 10;
  const satellites = b[9];
  // Quality gate, thresholds taken verbatim from RAK's own reference server
  // (field-tester-server/server/server.js, ftdProcess(): `has_gps = (hdop <=
  // 2) && (sats >= 5)`). Without this gate an all-zero ten-byte frame (no fix
  // yet, e.g. a cold GPS start) decodes to a valid-looking point off the
  // African coast (~5.3e-6 lat, ~1.07e-5 lon) instead of no position at all.
  if (hdop > 2 || satellites < 5) return null;
  const lat = (((b[0] & 63) << 17) + (b[1] << 9) + (b[2] << 1) + (b[3] >> 7));
  const lon = ((b[3] & 127) << 16) + (b[4] << 8) + b[5];
  const latitude = ((b[0] & 64) ? -1 : 1) * (lat * 108 + 53) / 1e7;
  const longitude = ((b[0] & 128) ? -1 : 1) * (lon * 215 + 107) / 1e7;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {latitude, longitude, altitude_m: ((b[6] << 8) + b[7]) - 1000,
    accuracy_m: (hdop * 5 + 5) / 10, hdop, satellites, fix_time: time || null,
    source: 'field_tester'};
}

function receiverPosition(row, time) {
  if (!row || row.latitude == null || row.longitude == null) return null;
  // A static position is operator-asserted and does not move, so the gpsd
  // freshness window does not apply to it here. This function only reflects
  // whatever row is currently stored -- it does not itself decide precedence.
  // gpsd's precedence over a static assertion (2026-09-10 review, blocker B3:
  // no new manual writer competes with gpsd) is enforced at write time, by
  // PUT /api/gateway/location's guard (osi-network-api/index.js), which
  // refuses a static write while gpsd's own fix is still live.
  if (row.source === 'static') {
    return {latitude: row.latitude, longitude: row.longitude, altitude_m: row.altitude_m ?? null,
      accuracy_m: row.accuracy_m ?? null, fix_time: row.last_good_fix_at || row.updated_at || null,
      source: 'static', sync_version: row.sync_version ?? null};
  }
  const fixTime = row.last_good_fix_at || row.last_fix_at;
  const delta = Date.parse(time) - Date.parse(fixTime);
  // A future GPS fix cannot substantiate a delayed packet's receiver position.
  if (!Number.isFinite(delta) || delta < 0 || delta > 300000) return null;
  return {latitude: row.latitude, longitude: row.longitude, altitude_m: row.altitude_m ?? null,
    accuracy_m: row.accuracy_m ?? null, fix_time: new Date(fixTime).toISOString(),
    source: row.source || 'gpsd', sync_version: row.sync_version ?? null};
}

function fromChirpStack(input, context = {}) {
  let event = input;
  if (Buffer.isBuffer(event)) event = event.toString('utf8');
  if (typeof event === 'string') event = JSON.parse(event);
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid uplink envelope');
  const device = event.deviceInfo || {};
  const tx = event.txInfo || {};
  const lora = tx.modulation && tx.modulation.lora || {};
  const time = event.time || null;
  const positions = context.gatewayPositions || {};
  const candidateIds = (context.testerProfileIds || [context.testerProfileId])
    .filter(Boolean).map(id => String(id).trim().toLowerCase());
  const namePattern = String(context.testerProfileNamePattern || context.testerProfileName || '').trim().toLowerCase();
  const profileId = String(device.deviceProfileId || '').trim().toLowerCase();
  const profileName = String(device.deviceProfileName || '').trim().toLowerCase();
  const isTester = (profileId && candidateIds.includes(profileId))
    || (namePattern && profileName.includes(namePattern));
  return {
    deveui: String(device.devEui || event.devEui || '').trim().toUpperCase(),
    recorded_at: time, deduplication_id: event.deduplicationId || event.deduplication_id || null,
    metadata: {
      radio: {frequency_hz: tx.frequency ?? null, spreading_factor: lora.spreadingFactor ?? null,
        bandwidth_hz: lora.bandwidth ?? null, coding_rate: lora.codeRate ?? null,
        f_cnt: event.fCnt ?? null, adr: event.adr ?? null, f_port: event.fPort ?? null},
      reported_position: isTester && event.fPort === 1 ? decodeTesterGps(event.data, time) : null,
      device_location: context.deviceLocation || null,
      receivers: (Array.isArray(event.rxInfo) ? event.rxInfo : []).map(rx => {
        const gateway = String(rx.gatewayId || '').trim().toUpperCase();
        return {gateway_id: gateway, uplink_id_num: rx.uplinkId ?? null,
          rssi_dbm: rx.rssi ?? null, snr_db: rx.snr ?? null, channel: rx.channel ?? null,
          crc_status: rx.crcStatus ?? null, position: receiverPosition(positions[gateway], time)};
      })
    }
  };
}
module.exports = {fromChirpStack};
