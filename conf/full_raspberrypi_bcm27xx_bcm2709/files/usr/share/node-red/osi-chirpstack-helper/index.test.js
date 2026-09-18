'use strict';
// Co-located tests for osi-chirpstack-helper (strega-gen2-device-profile, task 2,
// fix round R1). Stubs only client.deviceClient's gRPC method surface
// (get/create/getKeys/createKeys/updateKeys/delete/update). The client itself is
// real, so request building runs through the actual vendored ChirpStack 4.12.1
// protobuf bindings unmodified -- fixtures and captures are real `proto.api.Device`
// / `proto.api.DeviceKeys` messages, read back via their own `.toObject()`.
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

// Fully-populated Device covering EVERY field the vendored 4.12.1 Device
// message has (scalars, the two map fields, and the ones that are easy to
// forget precisely because ensureDeviceProvisioned's own fixtures never set
// them: joinEui, isDisabled, skipFcntCheck, tagsMap, variablesMap).
function buildDeviceMessage(fields) {
  const f = Object.assign({
    devEui: '00dec0de00000001',
    name: 'Vanne 1',
    description: 'zone 3',
    applicationId: 'app-1',
    deviceProfileId: 'prof-gen1',
    joinEui: '0000000000000042',
    isDisabled: true,
    skipFcntCheck: true,
    tags: { manufacturer: 'STREGA', generation: 'gen1', site: 'silvan' },
    variables: { serial: 'SN-4711', install_note: 'buried 40cm' }
  }, fields || {});
  const device = new devicePb.Device();
  device.setDevEui(f.devEui);
  device.setName(f.name);
  device.setDescription(f.description);
  device.setApplicationId(f.applicationId);
  device.setDeviceProfileId(f.deviceProfileId);
  device.setJoinEui(f.joinEui);
  device.setIsDisabled(f.isDisabled);
  device.setSkipFcntCheck(f.skipFcntCheck);
  for (const [k, v] of Object.entries(f.tags)) device.getTagsMap().set(k, v);
  for (const [k, v] of Object.entries(f.variables)) device.getVariablesMap().set(k, v);
  return device;
}

// A minimal device, used by tests that only care about a couple of fields and
// deliberately leave the rest at jspb defaults (empty/false).
function buildMinimalDeviceMessage(fields) {
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

// `fixtures.device` may be a single Device message/plain-fields object (served
// on every `get` call), or `fixtures.getSeq` may be an array of
// Device-message-or-null values consumed one per `get` call (last entry
// sticks) -- used to simulate the device changing between two getDevice
// round-trips inside one ensureDeviceProvisioned run (MINOR-1 regression).
function stubClient(captured, fixtures) {
  const client = createClient({ apiUrl: 'http://localhost:8080', apiKey: 'test-key' });
  const singleDevice = fixtures.device
    ? (fixtures.device instanceof devicePb.Device ? fixtures.device : buildMinimalDeviceMessage(fixtures.device))
    : null;
  const getSeq = Array.isArray(fixtures.getSeq) ? fixtures.getSeq.slice() : null;
  const keysMessage = fixtures.keys ? buildKeysMessage(fixtures.keys) : null;
  const calls = [];
  let getCount = 0;

  const nextDevice = () => {
    if (!getSeq) return singleDevice;
    const value = getSeq[Math.min(getCount, getSeq.length - 1)];
    getCount += 1;
    return value;
  };

  client.deviceClient = {
    get: (request, metadata, options, callback) => {
      calls.push('get');
      const device = nextDevice();
      if (!device) return callback(notFoundError());
      callback(null, { getDevice: () => device });
    },
    create: (request, metadata, options, callback) => {
      calls.push('create');
      captured.create = { device: request.getDevice().toObject() };
      callback(null, {});
    },
    getKeys: (request, metadata, options, callback) => {
      calls.push('getKeys');
      if (!keysMessage) return callback(notFoundError());
      callback(null, { getDeviceKeys: () => keysMessage });
    },
    createKeys: (request, metadata, options, callback) => {
      calls.push('createKeys');
      captured.createKeys = request.getDeviceKeys().toObject();
      callback(null, {});
    },
    updateKeys: (request, metadata, options, callback) => {
      calls.push('updateKeys');
      captured.updateKeys = request.getDeviceKeys().toObject();
      callback(null, {});
    },
    delete: (request, metadata, options, callback) => {
      calls.push('delete');
      captured.delete = true;
      callback(null, {});
    },
    update: (request, metadata, options, callback) => {
      calls.push('update');
      captured.update = { device: request.getDevice().toObject() };
      callback(null, {});
    }
  };
  client.__calls = calls;
  return client;
}

test('setDeviceProfile preserves EVERY Device field (all 10 scalars/maps), not just name/description', async () => {
  const dev = buildDeviceMessage();
  const before = dev.toObject();
  const captured = {};
  const client = stubClient(captured, { device: dev });

  assert.equal(await client.setDeviceProfile('00DEC0DE00000001', 'prof-gen2'), true);

  const expected = JSON.parse(JSON.stringify(before));
  expected.deviceProfileId = 'prof-gen2';
  assert.deepEqual(captured.update.device, expected, 'update payload must differ from the original ONLY in deviceProfileId');

  // Explicit per-field assertions too: a deepEqual regression on a 10-field
  // object is easy to misread from the diff alone.
  const u = captured.update.device;
  assert.equal(u.devEui, '00dec0de00000001');
  assert.equal(u.name, 'Vanne 1');
  assert.equal(u.description, 'zone 3');
  assert.equal(u.applicationId, 'app-1');
  assert.equal(u.joinEui, '0000000000000042');
  assert.equal(u.isDisabled, true);
  assert.equal(u.skipFcntCheck, true);
  assert.deepEqual(new Map(u.tagsMap), new Map([['manufacturer', 'STREGA'], ['generation', 'gen1'], ['site', 'silvan']]));
  assert.deepEqual(new Map(u.variablesMap), new Map([['serial', 'SN-4711'], ['install_note', 'buried 40cm']]));
  assert.deepEqual(client.__calls, ['get', 'update']);
});

test('the Device field set asserted above IS the complete field surface of the vendored bindings', () => {
  // Fails loudly if a future ChirpStack API bump adds/removes a Device field,
  // so the preservation test above stays honest instead of silently
  // under-covering a newly added field.
  const setters = Object.keys(devicePb.Device.prototype).filter((k) => /^set[A-Z]/.test(k));
  const maps = Object.keys(devicePb.Device.prototype).filter((k) => /^get.*Map$/.test(k));
  assert.deepEqual(setters.sort(), [
    'setApplicationId', 'setDescription', 'setDevEui', 'setDeviceProfileId',
    'setIsDisabled', 'setJoinEui', 'setName', 'setSkipFcntCheck'
  ].sort(), 'proto.api.Device gained/lost a scalar field -- update buildDeviceMessage() and the preservation test');
  assert.deepEqual(maps.sort(), ['getTagsMap', 'getVariablesMap'].sort(),
    'proto.api.Device gained/lost a map field -- update buildDeviceMessage() and the preservation test');
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

test('ensureDeviceProvisioned does not claim profileAction "repointed" when no update RPC was issued (MINOR-1)', async () => {
  // The device is present on ensureDeviceProvisioned's own getDevice() read
  // (profile differs, so it decides to re-point) but has vanished by the time
  // setDeviceProfile issues its own getDevice() read -- e.g. deleted or
  // reassigned by a concurrent actor between the two round-trips.
  const captured = {};
  const client = stubClient(captured, {
    getSeq: [
      buildMinimalDeviceMessage({ devEui: '00dec0de00000001', deviceProfileId: 'prof-gen1' }),
      null
    ],
    keys: { nwkKey: 'A'.repeat(32) }
  });
  const result = await client.ensureDeviceProvisioned({ devEui: '00DEC0DE00000001', appKey: 'A'.repeat(32), applicationId: 'app-1', deviceProfileId: 'prof-gen2', name: 'Vanne 1' });
  assert.equal(client.__calls.includes('update'), false, 'no update RPC was actually issued');
  assert.equal(result.profileAction, 'unchanged', 'profileAction must not claim a re-point that never happened');
});

// F110: a ChirpStack that accepts the connection and never answers (mid-restart) used to
// leave the caller's promise pending for ever, and with it the HTTP route that awaited it:
// the valve cancel, the valve API router and the device delete clean-up.
test('every gRPC call carries a deadline', async () => {
  const seen = [];
  const client = createClient({ apiUrl: 'http://localhost:8080', apiKey: 'test-key' });
  client.deviceClient = {
    flushQueue: (request, metadata, options, callback) => {
      seen.push(options);
      callback(null, {});
    }
  };
  const before = Date.now();
  await client.flushDeviceQueue('00dec0de00000001');
  assert.equal(seen.length, 1);
  assert.ok(seen[0] && seen[0].deadline instanceof Date, 'options.deadline must be a Date');
  const budgetMs = seen[0].deadline.getTime() - before;
  assert.ok(budgetMs > 1000 && budgetMs <= 60000, `deadline budget out of range: ${budgetMs} ms`);
});

test('a server that accepts the connection and never answers ends in DEADLINE_EXCEEDED, not in a hang', async (t) => {
  const net = require('node:net');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    // Hold the connection open and say nothing.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const port = server.address().port;

  const previous = process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
  process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = '400';
  t.after(() => {
    if (previous === undefined) delete process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
    else process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = previous;
  });

  const client = createClient({ apiUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' });
  const started = Date.now();
  const outcome = await Promise.race([
    client.flushDeviceQueue('00dec0de00000001').then(() => 'resolved', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('still pending after 5 s'), 5000))
  ]);
  if (client.deviceClient && typeof client.deviceClient.close === 'function') client.deviceClient.close();

  assert.ok(outcome instanceof Error, `expected a rejection, got: ${outcome}`);
  assert.equal(outcome.grpcStatus, 'DEADLINE_EXCEEDED');
  assert.equal(outcome.step, 'flushDeviceQueue');
  assert.ok(Date.now() - started < 4000, 'must give up close to the deadline');
});

test('a bad deadline setting falls back to the default instead of disabling the deadline', async () => {
  const previous = process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
  const seen = [];
  try {
    for (const bad of ['0', '-5', 'abc', '']) {
      process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = bad;
      const client = createClient({ apiUrl: 'http://localhost:8080', apiKey: 'test-key' });
      client.deviceClient = {
        flushQueue: (request, metadata, options, callback) => {
          seen.push(options.deadline.getTime() - Date.now());
          callback(null, {});
        }
      };
      await client.flushDeviceQueue('00dec0de00000001');
    }
  } finally {
    if (previous === undefined) delete process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
    else process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = previous;
  }
  assert.equal(seen.length, 4);
  for (const budgetMs of seen) assert.ok(budgetMs > 15000 && budgetMs <= 20000, `fallback budget was ${budgetMs} ms`);
});
