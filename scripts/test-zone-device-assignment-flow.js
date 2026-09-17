#!/usr/bin/env node
'use strict';

// Behavioral regression test for the Assign Device HTTP chain
// (F28, 2026-09-17 Silvan harness evidence run-full2/Z2.md checks #18-19):
// PUT /api/irrigation-zones/:id/devices/:deveui for a DevEUI that is not
// registered to the caller must answer 404, not hang forever.
//
// Root cause: 'assign-device-update' declared outputs:1 but returned
// [null, msg] on its not-found path. Node-RED's Function node sends
// returned-array element i to this.wires[i]; with only one wire, index 1
// (the 404 message) had nowhere to go and was silently dropped -- the HTTP
// request never got a response (client-side hang/timeout, not a fast
// failure). Fixed by wiring a second output straight to 'device-response',
// matching every sibling node in this chain (assign-device-verify-zone,
// assign-device-verify-device, delete-device-unlink).
//
// This harness runs the REAL function-node bodies from the canonical
// flows.json with vm, and the REAL "sqlite" node msg.topic execution model
// (db.all(msg.topic) -> msg.payload = rows, which also executes and
// side-effects non-SELECT statements -- verified empirically against
// node:sqlite), against a throwaway copy of the real bundled farming.db.
// Same technique as scripts/test-account-link-legacy-cloud.js and
// scripts/test-auth-credential-isolation.js.
//
// Run: node --test scripts/test-zone-device-assignment-flow.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const flowsPath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const bundledDbPath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db');

function readFlows() {
  return JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
}

function findNode(flows, id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return node;
}

// --- token signing, mirrors verifyBearer()/toBase64Url() inlined in every
// assign-device-* auth function node ---
function toBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function signToken(secret, payload) {
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const sig = toBase64Url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  return payloadB64 + '.' + sig;
}

// Runs one function-node's `func` body with a vm sandbox, Node-RED-shaped
// (msg, node, flow, env, context, global, get, set) signature -- copied from
// scripts/test-account-link-legacy-cloud.js / test-auth-credential-isolation.js.
async function executeFunctionNode(node, msg, { flowStore, env = {}, scope = {}, warnings } = {}) {
  const fn = new vm.Script(
    `(async function(msg,node,flow,env,context,global,get,set){${node.func}\n})`
  ).runInNewContext(
    Object.assign({ Buffer, console, require, process, setTimeout, clearTimeout, URL }, scope)
  );
  const flowApi = {
    get(key) { return flowStore.get(key); },
    set(key, value) { if (value === undefined) flowStore.delete(key); else flowStore.set(key, value); },
  };
  const envApi = { get(key) { return env[key]; } };
  const globalApi = { get(key) { return key === 'fs' ? fs : undefined; }, set() {} };
  const nodeApi = {
    error() {},
    warn(message) { if (warnings) warnings.push(message); },
    status() {},
  };
  return fn(msg, nodeApi, flowApi, envApi, {}, globalApi, () => undefined, () => {});
}

// Node-RED's Function node accepts EITHER an array of per-output messages OR
// a single bare message object (routed to output 0 only) as a return value.
// assign-device-update's success path returns a bare `msg` (only its
// not-found path returns an array).
//
// Critically, this also reproduces the ACTUAL runtime bug (F28): Node-RED's
// Node.send() only has wire arrays for `node.wires.length` outputs, so any
// returned-array element at an index >= wires.length is silently dropped --
// no error, no warning, nothing lands anywhere. Truncating to
// `node.wires.length` here is what makes this harness RED before the fix
// (assign-device-update declared outputs:1 / wires.length===1, so index 1 --
// the 404 message -- gets truncated away exactly as it was on the live
// gateway) and GREEN after (wires.length===2).
function routeOutputs(node, returned) {
  const arr = Array.isArray(returned) ? returned : [returned];
  const wiresLen = Array.isArray(node.wires) ? node.wires.length : 0;
  return arr.slice(0, wiresLen);
}

// Simulates a Node-RED "sqlite" node configured with sqlquery: "msg.topic":
// executes msg.topic and assigns the resulting rows to msg.payload. Verified
// empirically (node:sqlite) that .all() on a non-SELECT statement still
// executes it as a side effect and returns an empty row array, matching the
// real node-red-node-sqlite/sqlite3 execution model this flow relies on.
function execSqliteTopicNode(native, msg) {
  msg.payload = native.prepare(msg.topic).all();
  return msg;
}

function freshDbCopy() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-assign-device-harness-'));
  const dbPath = path.join(tempDir, 'farming.db');
  fs.copyFileSync(bundledDbPath, dbPath);
  const native = new DatabaseSync(dbPath);
  return {
    native,
    cleanup: () => { native.close(); fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

const AUTH_SECRET = 'zone-device-assignment-harness-secret';

// Drives the full PUT /api/irrigation-zones/:id/devices/:deveui chain:
// assign-device-auth -> assign-device-lookup(sqlite) -> assign-device-verify-zone
// -> assign-device-verify-zone-db(sqlite) -> assign-device-verify-device
// -> assign-device-verify-device-db(sqlite) -> assign-device-update
// -> [not-found: stop here] | [found: assign-device-update-db(sqlite) -> assign-device-response]
async function runAssignDeviceChain(flows, native, { userId, username, zoneId, deveui }) {
  const flowStore = new Map();
  const env = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
  const token = signToken(AUTH_SECRET, { userId, username, exp: Date.now() + 3600000 });
  const msg = {
    req: {
      headers: { authorization: 'Bearer ' + token },
      params: { id: String(zoneId), deveui },
    },
  };

  const authNode = findNode(flows, 'assign-device-auth');
  const authOut = routeOutputs(authNode, await executeFunctionNode(authNode, msg, { flowStore, env, scope: { crypto } }));
  if (authOut[1]) return { stage: 'auth', msg: authOut[1] };
  const afterAuth = authOut[0];

  execSqliteTopicNode(native, afterAuth); // assign-device-lookup

  const verifyZoneNode = findNode(flows, 'assign-device-verify-zone');
  const zoneOut = routeOutputs(verifyZoneNode, await executeFunctionNode(verifyZoneNode, afterAuth, { flowStore, env }));
  if (zoneOut[1]) return { stage: 'verify-zone', msg: zoneOut[1] };
  const afterZone = zoneOut[0];

  execSqliteTopicNode(native, afterZone); // assign-device-verify-zone-db

  const verifyDeviceNode = findNode(flows, 'assign-device-verify-device');
  const deviceOut = routeOutputs(verifyDeviceNode, await executeFunctionNode(verifyDeviceNode, afterZone, { flowStore, env }));
  if (deviceOut[1]) return { stage: 'verify-device', msg: deviceOut[1] };
  const afterDevice = deviceOut[0];

  execSqliteTopicNode(native, afterDevice); // assign-device-verify-device-db

  const updateNode = findNode(flows, 'assign-device-update');
  const updateOut = routeOutputs(updateNode, await executeFunctionNode(updateNode, afterDevice, { flowStore, env }));
  if (updateOut[1]) return { stage: 'update', msg: updateOut[1] };
  const afterUpdate = updateOut[0];

  execSqliteTopicNode(native, afterUpdate); // assign-device-update-db

  const responseNode = findNode(flows, 'assign-device-response');
  // assign-device-response returns a bare msg, not an [out0, out1] array.
  const finalMsg = await executeFunctionNode(responseNode, afterUpdate, { flowStore, env });
  return { stage: 'success', msg: finalMsg };
}

function seedUserAndZone(native) {
  const now = new Date().toISOString();
  native.prepare(
    "INSERT INTO users(id, username, password_hash, created_at, role) VALUES (1, 'harnessuser', 'x', ?, 'admin')"
  ).run(now);
  native.prepare(
    "INSERT INTO irrigation_zones(id, name, user_id, created_at, updated_at, zone_uuid, sync_version) " +
    "VALUES (1, 'Test Zone', 1, ?, ?, 'zone-uuid-1', 1)"
  ).run(now, now);
}

test('PUT .../devices/:deveui for a DevEUI never registered to the caller answers 404, not a hang -- F28', async () => {
  const flows = readFlows();
  const { native, cleanup } = freshDbCopy();
  try {
    seedUserAndZone(native);
    // Deliberately no row in `devices` for this deveui.

    const result = await runAssignDeviceChain(flows, native, {
      userId: 1, username: 'harnessuser', zoneId: 1, deveui: '70B3D57ED0069999',
    });

    assert.equal(
      result.stage, 'update',
      'the not-found decision must be made by assign-device-update, not an earlier stage: ' + JSON.stringify(result)
    );
    assert.ok(
      result.msg,
      'assign-device-update must produce a message on its not-found output -- ' +
      'this is exactly F28 (outputs:1 silently dropped it before the fix)'
    );
    assert.equal(result.msg.statusCode, 404);
    assert.equal(result.msg.payload.message, 'Device not found or access denied');
  } finally {
    cleanup();
  }
});

test('PUT .../devices/:deveui for a real DevEUI owned by the caller succeeds (200) -- wiring regression guard', async () => {
  const flows = readFlows();
  const { native, cleanup } = freshDbCopy();
  try {
    seedUserAndZone(native);
    const now = new Date().toISOString();
    native.prepare(
      "INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, sync_version) " +
      "VALUES ('70B3D57ED0069999', 'Sim Sensor', 'KIWI_SENSOR', 1, ?, ?, 1)"
    ).run(now, now);

    const result = await runAssignDeviceChain(flows, native, {
      userId: 1, username: 'harnessuser', zoneId: 1, deveui: '70B3D57ED0069999',
    });

    assert.equal(result.stage, 'success', JSON.stringify(result));
    assert.equal(result.msg.statusCode, 200);
    assert.equal(result.msg.payload.message, 'Device assigned to zone successfully');
    assert.equal(result.msg.payload.irrigation_zone_id, 1);

    const row = native.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui = '70B3D57ED0069999'").get();
    assert.equal(row.irrigation_zone_id, 1, 'the device row must actually be updated, not just the response faked');
  } finally {
    cleanup();
  }
});

console.log('zone/device assignment flow behavioral tests defined; run with `node --test` to execute.');
