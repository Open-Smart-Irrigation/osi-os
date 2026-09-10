'use strict';

// Metadata only. The field tester's existing ten-byte GPS format is decoded
// exclusively behind the configured tester profile gate; payload bytes never persist.
function decodeTesterGps(data, time) {
  if (typeof data !== 'string' || data.length > 4096) return null;
  const b = Buffer.from(data, 'base64');
  if (b.length < 10) return null;
  const lat = (((b[0] & 63) << 17) + (b[1] << 9) + (b[2] << 1) + (b[3] >> 7));
  const lon = ((b[3] & 127) << 16) + (b[4] << 8) + b[5];
  const latitude = ((b[0] & 64) ? -1 : 1) * (lat * 108 + 53) / 1e7;
  const longitude = ((b[0] & 128) ? -1 : 1) * (lon * 215 + 107) / 1e7;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const hdop = b[8] / 10;
  return {latitude, longitude, altitude_m: ((b[6] << 8) + b[7]) - 1000,
    accuracy_m: (hdop * 5 + 5) / 10, hdop, satellites: b[9], fix_time: time || null,
    source: 'field_tester'};
}

function receiverPosition(row, time) {
  if (!row || row.latitude == null || row.longitude == null) return null;
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
  const isTester = (context.testerProfileId && device.deviceProfileId === context.testerProfileId)
    || (context.testerProfileName && device.deviceProfileName === context.testerProfileName);
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
