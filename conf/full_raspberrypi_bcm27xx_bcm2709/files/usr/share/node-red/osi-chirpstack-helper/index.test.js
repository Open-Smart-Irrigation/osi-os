'use strict';
// Co-located tests for osi-chirpstack-helper (strega-gen2-device-profile, task 2).
// Stubs only client.deviceClient's gRPC method surface (get/create/getKeys/
// createKeys/updateKeys/delete/update). The client itself is real, so request
// building runs through the actual vendored ChirpStack 4.12.1 protobuf
// bindings unmodified -- fixtures and captures are real `proto.api.Device` /
// `proto.api.DeviceKeys` messages, read back via their own `.toObject()`.
const test = require('node:test');
const assert = require('node:assert/strict');
const grpc = require('@grpc/grpc-js');
const devicePb = require('@chirpstack/chirpstack-api/api/device_pb');

const { createClient } = require('./index');

function notFoundError() {
  const error = new Error('not found');
  error.code = grpc.status.NOT_FOUND;
  return error;
}

function buildDeviceMessage(fields) {
  const device = new devicePb.Device();
  if (fields.devEui !== undefined) device.setDevEui(fields.devEui);
  if (fields.name !== undefined) device.setName(fields.name);
  if (fields.description !== undefined) device.setDescription(fields.description);
  if (fields.applicationId !== undefined) device.setApplicationId(fields.applicationId);
  if (fields.deviceProfileId !== undefined) device.setDeviceProfileId(fields.deviceProfileId);
  if (fields.joinEui !== undefined) device.setJoinEui(fields.joinEui);
  return device;
}

function buildKeysMessage(fields) {
  const keys = new devicePb.DeviceKeys();
  if (fields.devEui !== undefined) keys.setDevEui(fields.devEui);
  if (fields.nwkKey !== undefined) keys.setNwkKey(fields.nwkKey);
  if (fields.appKey !== undefined) keys.setAppKey(fields.appKey);
  return keys;
}

function stubClient(captured, fixtures) {
  const client = createClient({ apiUrl: 'http://localhost:8080', apiKey: 'test-key' });
  const deviceMessage = fixtures.device ? buildDeviceMessage(fixtures.device) : null;
  const keysMessage = fixtures.keys ? buildKeysMessage(fixtures.keys) : null;

  client.deviceClient = {
    get: (request, metadata, callback) => {
      if (!deviceMessage) return callback(notFoundError());
      callback(null, { getDevice: () => deviceMessage });
    },
    create: (request, metadata, callback) => {
      captured.create = { device: request.getDevice().toObject() };
      callback(null, {});
    },
    getKeys: (request, metadata, callback) => {
      if (!keysMessage) return callback(notFoundError());
      callback(null, { getDeviceKeys: () => keysMessage });
    },
    createKeys: (request, metadata, callback) => {
      captured.createKeys = request.getDeviceKeys().toObject();
      callback(null, {});
    },
    updateKeys: (request, metadata, callback) => {
      captured.updateKeys = request.getDeviceKeys().toObject();
      callback(null, {});
    },
    delete: (request, metadata, callback) => {
      captured.delete = true;
      callback(null, {});
    },
    update: (request, metadata, callback) => {
      captured.update = { device: request.getDevice().toObject() };
      callback(null, {});
    }
  };
  return client;
}

test('setDeviceProfile swaps only the profile and preserves the rest of the device', async () => {
  const captured = {};
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', name: 'Vanne 1', applicationId: 'app-1', deviceProfileId: 'prof-gen1', description: 'zone 3' } });
  assert.equal(await client.setDeviceProfile('00DEC0DE00000001', 'prof-gen2'), true);
  assert.equal(captured.update.device.deviceProfileId, 'prof-gen2');
  assert.equal(captured.update.device.name, 'Vanne 1');
  assert.equal(captured.update.device.description, 'zone 3');
});

test('setDeviceProfile is a no-op when the profile already matches', async () => {
  const captured = {};
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', deviceProfileId: 'prof-gen2' } });
  assert.equal(await client.setDeviceProfile('00DEC0DE00000001', 'prof-gen2'), false);
  assert.equal(captured.update, undefined);
});

test('setDeviceProfile returns false for an unknown device', async () => {
  const client = stubClient({}, { device: null });
  assert.equal(await client.setDeviceProfile('00DEC0DE00000009', 'prof-gen2'), false);
});

test('ensureDeviceProvisioned re-points an existing device whose profile differs', async () => {
  const captured = {};
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', deviceProfileId: 'prof-gen1' }, keys: { nwkKey: 'A'.repeat(32) } });
  const result = await client.ensureDeviceProvisioned({ devEui: '00DEC0DE00000001', appKey: 'A'.repeat(32), applicationId: 'app-1', deviceProfileId: 'prof-gen2', name: 'Vanne 1' });
  assert.equal(result.profileAction, 'repointed');
  assert.equal(captured.update.device.deviceProfileId, 'prof-gen2');
});

test('ensureDeviceProvisioned reports unchanged when the profile already matches', async () => {
  const captured = {};
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', deviceProfileId: 'prof-gen2' }, keys: { nwkKey: 'A'.repeat(32) } });
  const result = await client.ensureDeviceProvisioned({ devEui: '00DEC0DE00000001', appKey: 'A'.repeat(32), applicationId: 'app-1', deviceProfileId: 'prof-gen2', name: 'Vanne 1' });
  assert.equal(result.profileAction, 'unchanged');
  assert.equal(captured.update, undefined);
});
