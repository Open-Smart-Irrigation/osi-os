'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// node:sqlite-backed stand-in for the native `sqlite3` addon (#392): lets this
// test run where the addon is not built. Scoped via Module._load to
// osi-db-helper's own require('sqlite3') only.
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
function sqlite3Adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      callback = callback || (() => {});
      try { callback.call(this, null, this.native.prepare(sql).all(...(params || []))); } catch (error) { callback.call(this, error); }
    }
    get(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      callback = callback || (() => {});
      try { callback.call(this, null, this.native.prepare(sql).get(...(params || []))); } catch (error) { callback.call(this, error); }
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      callback = callback || (() => {});
      try { const result = this.native.prepare(sql).run(...(params || [])); callback.call({ changes: Number(result.changes) }, null); } catch (error) { callback.call(this, error); }
    }
    exec(sql, callback) {
      callback = callback || (() => {});
      try { this.native.exec(sql); callback.call(this, null); } catch (error) { callback.call(this, error); }
    }
    close(callback) {
      callback = callback || (() => {});
      try { this.native.close(); callback.call(this, null); } catch (error) { callback.call(this, error); }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}
const RADIO_HELPER_DIR = __dirname;
const DB_HELPER_PATH = require.resolve('osi-db-helper', { paths: [RADIO_HELPER_DIR] });
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) return sqlite3Adapter();
  return originalLoad.call(this, request, parent, isMain);
};
const { normalizeUplink, fromChirpStack } = require('./index');
const uuid = '00000000-0000-4000-8000-000000000000';
test('normalizes and bounds receiver metadata', () => {
  const row = normalizeUplink({ deveui: '0011223344556677', recorded_at: '2026-09-10T00:00:00Z', metadata: { receivers: [{ gateway_id: '000000000000000B', uplink_id_num: 2 }, { gateway_id: '000000000000000A', uplink_id_num: null }] } }, { installationUuid: uuid });
  assert.equal(row.deveui, '0011223344556677');
  assert.deepEqual(JSON.parse(row.metadata_json).receivers.map(r => r.gateway_id), ['000000000000000A', '000000000000000B']);
});
test('rejects invalid identity, coordinates, and receiver conflicts', () => {
  assert.throws(() => normalizeUplink({ deveui: 'bad' }, { installationUuid: 'bad' }), /UUID/);
  assert.throws(() => normalizeUplink({ deveui: '0011223344556677', metadata: { reported_position: { latitude: 91, longitude: 0 } } }, { installationUuid: uuid }), /WGS84/);
  assert.throws(() => normalizeUplink({ deveui: '0011223344556677', metadata: { receivers: [{ gateway_id: '000000000000000A', uplink_id_num: 1, snr_db: 1 }, { gateway_id: '000000000000000A', uplink_id_num: 1, snr_db: 2 }] } }, { installationUuid: uuid }), /conflicting/);
});

test('uses strict numeric types and canonical bounded identities', () => {
  assert.throws(() => normalizeUplink({ deveui: '0011223344556677', metadata: { radio: { f_cnt: '12' } } }, { installationUuid: uuid }), /numeric/);
  assert.throws(() => normalizeUplink({ deveui: '001122334455667Z' }, { installationUuid: uuid }), /DevEUI/);
  assert.throws(() => normalizeUplink({ deveui: '0011223344556677', deduplication_id: '   ' }, { installationUuid: uuid }), /deduplication/);
  assert.throws(() => normalizeUplink({ deveui: '0011223344556677', metadata: { receivers: [{ gateway_id: '0000000000000001', uplink_id_num: -1 }] } }, { installationUuid: uuid }), /numeric/);
});

test('preserves GPS and confirmed location provenance while dropping unknown fields', () => {
  const row = normalizeUplink({ deveui: '0011223344556677', deduplication_id: 'golden-1', metadata: {
    reported_position: { latitude: 46, longitude: 6, hdop: 1.2, satellites: 8, fix_time: '2026-09-10T00:00:00Z', source: 'tester', ignored: 'drop' },
    receivers: [{ gateway_id: '0000000000000001', position: { latitude: 46, longitude: 6, sync_version: 3, ignored: true } }],
    device_location: { revision_uuid: 'rev-1', latitude: 46, longitude: 6, altitude_m: 500, accuracy_m: 2, antenna_height_agl_m: 4, effective_from: '2026-09-09T00:00:00Z', coordinate_source: 'confirmed', installation_uuid: uuid, sync_version: 2, ignored: 'drop' },
    ignored: 'drop'
  } }, { installationUuid: uuid, ingestedAt: '2026-09-10T00:00:00Z', deduplicationUncertain: true });
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(metadata.deduplication_uncertain, true); assert.equal(metadata.reported_position.hdop, 1.2); assert.equal(metadata.receivers[0].position.sync_version, 3); assert.equal(metadata.device_location.coordinate_source, 'confirmed');
  assert.equal(Object.hasOwn(metadata, 'ignored'), false); assert.equal(Object.hasOwn(metadata.reported_position, 'ignored'), false);
});

test('decodes the tester position from a gateway-realistic environment', () => {
  const frame = {
    time: '2026-09-22T15:36:28.199Z',
    deviceInfo: { devEui: 'ac1f09fffe000001', deviceProfileId: '9b7c33dd-9d24-47a3-b13e-8b050e0ee6de',
      deviceProfileName: 'OSI RAK Field Tester', applicationId: 'app-field-tester' },
    fPort: 1, fCnt: 4, data: 'INlJhJz1BdwMCA==',
    rxInfo: [{ gatewayId: '0016C001F1000002', rssi: -93, snr: 7.75 }],
    txInfo: { frequency: 868100000, modulation: { lora: { spreadingFactor: 12, bandwidth: 125000, codeRate: 'CR_4_5' } } }
  };
  // Identity is the OSI device type decided by the caller, never the ChirpStack profile.
  const typed = fromChirpStack(frame, { gatewayPositions: {}, isFieldTester: true });
  assert.equal(typed.metadata.reported_position.latitude, 46.4999993);
  assert.equal(typed.metadata.reported_position.longitude, 6.4999982);
  assert.equal(typed.metadata.reported_position.satellites, 8);

  // A device that is not typed as a tester decodes nothing, even on the tester profile.
  const other = fromChirpStack(frame, { gatewayPositions: {}, isFieldTester: false });
  assert.equal(other.metadata.reported_position, null);
});

test('a genuine all-zero ten-byte frame (no GPS fix yet) decodes to no position, not the Gulf of Guinea', () => {
  // Cold GPS start: every byte zero, including hdop (byte 8) and satellites
  // (byte 9). Without the quality gate this decodes to a valid-looking point
  // (~5.3e-6 lat, ~1.07e-5 lon) instead of null -- see chirpstack.js
  // decodeTesterGps for RAK's own has_gps = (hdop <= 2) && (sats >= 5) gate.
  const zeroFrame = {
    time: '2026-09-22T15:36:28.199Z',
    deviceInfo: { devEui: 'ac1f09fffe000001', deviceProfileId: '9b7c33dd-9d24-47a3-b13e-8b050e0ee6de',
      deviceProfileName: 'OSI RAK Field Tester', applicationId: 'app-field-tester' },
    fPort: 1, fCnt: 1, data: Buffer.alloc(10).toString('base64'),
    rxInfo: [{ gatewayId: '0016C001F1000002', rssi: -93, snr: 7.75 }],
    txInfo: { frequency: 868100000, modulation: { lora: { spreadingFactor: 12, bandwidth: 125000, codeRate: 'CR_4_5' } } }
  };
  const row = fromChirpStack(zeroFrame, { gatewayPositions: {}, isFieldTester: true });
  assert.equal(row.metadata.reported_position, null);
  // RSSI and receivers must still be captured -- only the position is dropped,
  // exactly as for any non-tester uplink.
  assert.equal(row.metadata.receivers.length, 1);
  assert.equal(row.metadata.receivers[0].rssi_dbm, -93);
  assert.equal(row.metadata.receivers[0].gateway_id, '0016C001F1000002');
});

test('a static gateway position is not subject to the gpsd freshness window', () => {
  const frame = { time: '2026-09-22T15:36:28.199Z', deviceInfo: { devEui: 'ac1f09fffe000001' }, fPort: 1,
    data: 'INlJhJz1BdwMCA==', rxInfo: [{ gatewayId: '0016C001F1000002', rssi: -93, snr: 7.75 }], txInfo: {} };
  const positions = { '0016C001F1000002': { latitude: 46.5, longitude: 6.5, altitude_m: null,
    source: 'static', last_good_fix_at: '2026-01-01T00:00:00.000Z' } };
  const row = fromChirpStack(frame, { gatewayPositions: positions });
  assert.equal(row.metadata.receivers[0].position.source, 'static');
  assert.equal(row.metadata.receivers[0].position.latitude, 46.5);
});
