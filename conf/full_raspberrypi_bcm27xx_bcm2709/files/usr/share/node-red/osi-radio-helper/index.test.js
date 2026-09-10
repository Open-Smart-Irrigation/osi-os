'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUplink } = require('./index');
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
