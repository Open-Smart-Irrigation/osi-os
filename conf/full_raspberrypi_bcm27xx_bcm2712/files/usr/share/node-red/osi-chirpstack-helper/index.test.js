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

const { createClient, updateDeviceName, NAME_UPDATE_DEADLINE_MS } = require('./index');

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
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', name: 'Vanne 1', deviceProfileId: 'prof-gen2' }, keys: { nwkKey: 'A'.repeat(32) } });
  const result = await client.ensureDeviceProvisioned({ devEui: '00DEC0DE00000001', appKey: 'A'.repeat(32), applicationId: 'app-1', deviceProfileId: 'prof-gen2', name: 'Vanne 1' });
  assert.equal(result.profileAction, 'unchanged');
  assert.equal(result.nameAction, 'unchanged');
  assert.equal(captured.update, undefined);
});

test('ensureDeviceProvisioned treats a zero-filled unset AppKey as unchanged', async () => {
  const captured = {};
  const client = stubClient(captured, {
    device: {
      devEui: '00dec0de00000001',
      name: 'Vanne 1',
      applicationId: 'app-1',
      deviceProfileId: 'prof-gen2'
    },
    keys: {
      nwkKey: 'A'.repeat(32),
      appKey: '0'.repeat(32)
    }
  });
  const result = await client.ensureDeviceProvisioned({
    devEui: '00DEC0DE00000001',
    appKey: 'A'.repeat(32),
    applicationId: 'app-1',
    deviceProfileId: 'prof-gen2',
    name: 'Vanne 1'
  });
  assert.equal(result.keysAction, 'unchanged');
  assert.equal(captured.updateKeys, undefined);
});

test('ensureDeviceProvisioned refuses an all-zero AppKey, which reads back as unset', async () => {
  const captured = {};
  const client = stubClient(captured, {
    device: {
      devEui: '00dec0de00000001',
      name: 'Vanne 1',
      applicationId: 'app-1',
      deviceProfileId: 'prof-gen2'
    },
    keys: {
      nwkKey: '',
      appKey: ''
    }
  });
  await assert.rejects(
    client.ensureDeviceProvisioned({
      devEui: '00DEC0DE00000001',
      appKey: '0'.repeat(32),
      applicationId: 'app-1',
      deviceProfileId: 'prof-gen2',
      name: 'Vanne 1'
    }),
    (error) => error.step === 'validate' && /all zeros/.test(error.message)
  );
  assert.equal(captured.updateKeys, undefined);
  assert.equal(captured.createKeys, undefined);
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

// grpc-js treats a deadline more than 2^31-1 ms away as "no deadline" and arms no timer, so
// an oversized setting would bring the hang back through the front door.
test('an oversized deadline setting is clamped instead of switching the deadline off', async () => {
  const previous = process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
  const seen = [];
  try {
    for (const huge of ['2147483648', '999999999999', '1e300']) {
      process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = huge;
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
  assert.equal(seen.length, 3);
  for (const budgetMs of seen) assert.ok(budgetMs > 100000 && budgetMs <= 120000, `clamped budget was ${budgetMs} ms`);
});

// updateDeviceName keeps one promise chain per DevEUI in module state, so each
// test below uses its own DevEUI and no test can inherit another's queue.
function nameStubClient(captured, fixtures) {
  const client = createClient({ apiUrl: 'http://localhost:8080', apiKey: 'test-key' });
  const device = fixtures.device === null
    ? null
    : buildMinimalDeviceMessage(fixtures.device || { devEui: '00dec0de00000001', name: 'Old' });
  captured.updates = [];
  captured.reads = [];
  captured.deadlines = [];
  client.deviceClient = {
    get: (request, metadata, options, callback) => {
      captured.reads.push('get');
      captured.deadlines.push(options.deadline.getTime() - Date.now());
      if (!device) return callback(notFoundError());
      callback(null, { getDevice: () => device });
    },
    update: (request, metadata, options, callback) => {
      const name = request.getDevice().getName();
      captured.updates.push(name);
      captured.deadlines.push(options.deadline.getTime() - Date.now());
      if (fixtures.updateFails) return callback(Object.assign(new Error('boom'), { code: 13 }));
      const delay = fixtures.updateDelayMs ? fixtures.updateDelayMs(name) : 0;
      setTimeout(() => callback(null, {}), delay);
    },
  };
  return client;
}

test('updateDeviceName sends the database name when ChirpStack disagrees', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000101', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000101', async () => 'Probe 7'), 'updated');
  assert.deepEqual(captured.updates, ['Probe 7']);
});

test('updateDeviceName sends nothing when the names already match', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000102', name: 'Probe 7' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000102', async () => 'Probe 7'), 'unchanged');
  assert.deepEqual(captured.updates, []);
});

test('updateDeviceName skips when the database has no name to send', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000103', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000103', async () => null), 'skipped');
  assert.deepEqual(captured.reads, [], 'a null name must not cost a gRPC round trip');
  assert.deepEqual(captured.updates, []);
});

test('updateDeviceName skips a device ChirpStack does not have', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: null });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000104', async () => 'Probe 7'), 'skipped');
  assert.deepEqual(captured.updates, []);
});

test('updateDeviceName rejects on a gRPC failure so the caller can report "failed"', async () => {
  const captured = {};
  const client = nameStubClient(captured, {
    device: { devEui: '00dec0de00000105', name: 'Old' },
    updateFails: true,
  });
  await assert.rejects(
    updateDeviceName(client, '00DEC0DE00000105', async () => 'Probe 7'),
    (error) => error.step === 'updateDeviceName'
  );
});

test('two renames whose gRPC calls finish in reverse order end on the newer name', async () => {
  const captured = {};
  const client = nameStubClient(captured, {
    device: { devEui: '00dec0de00000106', name: 'Old' },
    // The first update is the slow one. Without per-DevEUI serialization the
    // second would land first and the first would overwrite it.
    updateDelayMs: (name) => (name === 'Probe 7' ? 60 : 0),
  });
  const reads = [];
  const first = updateDeviceName(client, '00DEC0DE00000106', async () => {
    reads.push('first');
    return 'Probe 7';
  });
  const second = updateDeviceName(client, '00DEC0DE00000106', async () => {
    reads.push('second');
    return 'Probe 8';
  });
  assert.deepEqual(await Promise.all([first, second]), ['updated', 'updated']);
  assert.deepEqual(captured.updates, ['Probe 7', 'Probe 8'], 'the newer name must be sent last');
  assert.deepEqual(reads, ['first', 'second'], 'the second read happens after the first call settles');
});

test('a failed rename does not block the next rename of the same device', async () => {
  const captured = {};
  const failing = nameStubClient(captured, {
    device: { devEui: '00dec0de00000107', name: 'Old' },
    updateFails: true,
  });
  await assert.rejects(updateDeviceName(failing, '00DEC0DE00000107', async () => 'Probe 7'));
  const recovered = {};
  const client = nameStubClient(recovered, { device: { devEui: '00dec0de00000107', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000107', async () => 'Probe 8'), 'updated');
  assert.deepEqual(recovered.updates, ['Probe 8']);
});

// F110 bounded the whole client at 20 s. A rename waits behind this call, so
// both of its RPCs carry the shorter name-update budget instead.
test('both name-update RPCs carry the five-second budget, not the twenty-second default', async () => {
  assert.equal(NAME_UPDATE_DEADLINE_MS, 5000);
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000110', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000110', async () => 'Probe 7'), 'updated');
  assert.equal(captured.deadlines.length, 2, 'the read and the update each carry a deadline');
  for (const budgetMs of captured.deadlines) {
    assert.ok(budgetMs > 4000 && budgetMs <= 5000, `name-update budget was ${budgetMs} ms`);
  }
});

test('a longer operator deadline does not lengthen the name update', async () => {
  const previous = process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
  process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = '60000';
  try {
    const captured = {};
    const client = nameStubClient(captured, { device: { devEui: '00dec0de00000111', name: 'Old' } });
    await updateDeviceName(client, '00DEC0DE00000111', async () => 'Probe 7');
    for (const budgetMs of captured.deadlines) {
      assert.ok(budgetMs > 4000 && budgetMs <= 5000, `name-update budget was ${budgetMs} ms`);
    }
  } finally {
    if (previous === undefined) delete process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
    else process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = previous;
  }
});

// The budget is injected through the existing setting so this test finishes in
// under a second while driving the same code path a five-second wait would.
// The fixture is the one the F110 deadline test uses: a socket that accepts the
// connection and says nothing.
test('a ChirpStack that never answers ends the name update at its deadline, not in a hang', async (t) => {
  const net = require('node:net');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
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
    updateDeviceName(client, '00DEC0DE00000112', async () => 'Probe 7').then(() => 'resolved', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('still pending after 5 s'), 5000))
  ]);
  if (client.deviceClient && typeof client.deviceClient.close === 'function') client.deviceClient.close();

  assert.ok(outcome instanceof Error, `expected a rejection, got: ${outcome}`);
  assert.equal(outcome.grpcStatus, 'DEADLINE_EXCEEDED');
  assert.ok(Date.now() - started < 4000, 'must give up close to the injected deadline');
});

test('ensureDeviceProvisioned reconciles an existing device name from the value it is given', async () => {
  const captured = {};
  const client = stubClient(captured, {
    device: { devEui: '00dec0de00000108', name: 'Stale label', deviceProfileId: 'prof-gen2' },
    keys: { nwkKey: 'A'.repeat(32) },
  });
  const result = await client.ensureDeviceProvisioned({
    devEui: '00DEC0DE00000108',
    appKey: 'A'.repeat(32),
    applicationId: 'app-1',
    deviceProfileId: 'prof-gen2',
    name: 'Probe 7',
  });
  assert.equal(result.nameAction, 'updated');
  assert.equal(result.profileAction, 'unchanged');
  assert.equal(captured.update.device.name, 'Probe 7');
});

test('ensureDeviceProvisioned leaves a created device alone: createDevice already set its name', async () => {
  const captured = {};
  const client = stubClient(captured, { device: null, keys: null });
  const result = await client.ensureDeviceProvisioned({
    devEui: '00DEC0DE00000109',
    appKey: 'A'.repeat(32),
    applicationId: 'app-1',
    deviceProfileId: 'prof-gen2',
    name: 'Probe 7',
  });
  assert.equal(result.deviceCreated, true);
  assert.equal(result.nameAction, 'unchanged');
  assert.equal(captured.create.device.name, 'Probe 7');
  assert.equal(captured.update, undefined);
});

// Fix round 1 / Finding I1: `input.name || devEui` is the createDevice fallback
// only. Reconciling an EXISTING device's name must use what the caller actually
// supplied, never the DevEUI fallback, or an omitted/blank name silently
// overwrites a good ChirpStack label with the DevEUI.
test('ensureDeviceProvisioned leaves the ChirpStack name untouched when no name is supplied', async () => {
  const captured = {};
  const client = stubClient(captured, {
    device: { devEui: '00dec0de00000115', name: 'Probe 7', deviceProfileId: 'prof-gen2' },
    keys: { nwkKey: 'A'.repeat(32) },
  });
  const result = await client.ensureDeviceProvisioned({
    devEui: '00DEC0DE00000115',
    appKey: 'A'.repeat(32),
    applicationId: 'app-1',
    deviceProfileId: 'prof-gen2',
  });
  assert.equal(result.nameAction, 'unchanged');
  assert.equal(captured.update, undefined, 'an omitted name must not invent the DevEUI as the ChirpStack label');
});

test('ensureDeviceProvisioned leaves the ChirpStack name untouched when the supplied name is blank', async () => {
  for (const blank of ['', '   ']) {
    const captured = {};
    const client = stubClient(captured, {
      device: { devEui: '00dec0de00000116', name: 'Probe 7', deviceProfileId: 'prof-gen2' },
      keys: { nwkKey: 'A'.repeat(32) },
    });
    const result = await client.ensureDeviceProvisioned({
      devEui: '00DEC0DE00000116',
      appKey: 'A'.repeat(32),
      applicationId: 'app-1',
      deviceProfileId: 'prof-gen2',
      name: blank,
    });
    assert.equal(result.nameAction, 'unchanged');
    assert.equal(captured.update, undefined, `a blank name (${JSON.stringify(blank)}) must not invent the DevEUI as the ChirpStack label`);
  }
});

// Fix round 1 / Finding I1, folded ruling T4-M3: a name that already matches
// must cost no extra device round trip and must not be able to fail before
// the key reconciliation that follows.
test('ensureDeviceProvisioned costs no extra device read when the supplied name already matches', async () => {
  const captured = {};
  const client = stubClient(captured, {
    device: { devEui: '00dec0de00000117', name: 'Probe 7', deviceProfileId: 'prof-gen2' },
    keys: { nwkKey: 'A'.repeat(32) },
  });
  const result = await client.ensureDeviceProvisioned({
    devEui: '00DEC0DE00000117',
    appKey: 'A'.repeat(32),
    applicationId: 'app-1',
    deviceProfileId: 'prof-gen2',
    name: 'Probe 7',
  });
  assert.equal(result.nameAction, 'unchanged');
  assert.deepEqual(client.__calls, ['get', 'getKeys'], 'a matching name must not cost an extra getDevice round trip');
});

// Fix round 1 / Finding I2, controller ruling T4-I2: setDeviceName is now the
// one place that trims and compares. updateDeviceName must not push an
// untrimmed label -- the divergence the reviewer found let the two callers of
// the old duplicated logic flip a device's ChirpStack name back and forth.
test('updateDeviceName trims a stored name with surrounding white space, and a later call with the same value resolves unchanged', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000118', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000118', async () => '  Probe 7  '), 'updated');
  assert.deepEqual(captured.updates, ['Probe 7'], 'the label sent to ChirpStack must be trimmed');

  assert.equal(await updateDeviceName(client, '00DEC0DE00000118', async () => '  Probe 7  '), 'unchanged');
  assert.deepEqual(captured.updates, ['Probe 7'], 'a repeat call with the same (untrimmed) stored value must send nothing new');
});

test('updateDeviceName treats a blank or whitespace-only stored name as skipped without a gRPC read', async () => {
  for (const blank of ['', '   ']) {
    const captured = {};
    const client = nameStubClient(captured, { device: { devEui: '00dec0de00000119', name: 'Old' } });
    assert.equal(await updateDeviceName(client, '00DEC0DE00000119', async () => blank), 'skipped');
    assert.deepEqual(captured.reads, [], `a blank stored name (${JSON.stringify(blank)}) must not cost a gRPC round trip`);
    assert.deepEqual(captured.updates, []);
  }
});
