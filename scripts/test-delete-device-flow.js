#!/usr/bin/env node
'use strict';

// Behavioral regression test for the DELETE /api/devices/:deveui flag-off
// (default OSI_SCOPED_ACCESS) chain: delete-device-auth -> delete-device-lookup
// (sqlite) -> delete-device-unlink -> delete-device-db (sqlite) ->
// delete-device-response.
//
// F33 (2026-09-17 Silvan harness, run-full2/Z2.md check #28): the route
// answered 200 for a DevEUI that was never registered (or not owned by the
// caller) because delete-device-unlink ran a bare UPDATE and
// delete-device-response never inspected whether any row actually changed --
// a typo'd DevEUI looked exactly like a successful delete. The generic
// Node-RED "sqlite" node (msg.topic / .all() mode) this chain uses cannot
// see sqlite3's `this.changes` for a bare UPDATE, so the fix adds a
// RETURNING clause (same technique already used by unassign-device-update)
// and checks the returned row count downstream.
//
// Unclaim semantics are intentionally UNCHANGED here (still an UPDATE that
// clears user_id/irrigation_zone_id, not a tombstone) -- see PR body for
// that open question. This test only pins the 404-vs-200 reporting.
//
// This harness runs the REAL function-node bodies + the REAL "sqlite" node
// msg.topic execution model from the canonical flows.json against a fresh
// copy of the bundled farming.db, matching
// scripts/test-zone-device-assignment-flow.js and
// scripts/test-account-link-legacy-cloud.js.
//
// Run: node --test scripts/test-delete-device-flow.js

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

function toBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function signToken(secret, payload) {
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const sig = toBase64Url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
  return payloadB64 + '.' + sig;
}

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

// Same wires.length truncation as scripts/test-zone-device-assignment-flow.js
// (see that file for the full rationale): Node-RED drops any returned-array
// element at an index >= the node's real wire count.
function routeOutputs(node, returned) {
  const arr = Array.isArray(returned) ? returned : [returned];
  const wiresLen = Array.isArray(node.wires) ? node.wires.length : 0;
  return arr.slice(0, wiresLen);
}

function execSqliteTopicNode(native, msg) {
  msg.payload = native.prepare(msg.topic).all();
  return msg;
}

function freshDbCopy() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-delete-device-harness-'));
  const dbPath = path.join(tempDir, 'farming.db');
  fs.copyFileSync(bundledDbPath, dbPath);
  const native = new DatabaseSync(dbPath);
  return {
    native,
    cleanup: () => { native.close(); fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

const AUTH_SECRET = 'delete-device-harness-secret';

// Drives the full flag-off DELETE /api/devices/:deveui chain:
// delete-device-auth -> delete-device-lookup(sqlite) -> delete-device-unlink
// -> delete-device-db(sqlite) -> delete-device-response.
async function runDeleteDeviceChain(flows, native, { userId, username, deveui }) {
  const flowStore = new Map();
  const env = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
  const token = signToken(AUTH_SECRET, { userId, username, exp: Date.now() + 3600000 });
  const msg = {
    req: {
      headers: { authorization: 'Bearer ' + token },
      params: { deveui },
    },
  };

  const authNode = findNode(flows, 'delete-device-auth');
  const authOut = routeOutputs(authNode, await executeFunctionNode(authNode, msg, { flowStore, env, scope: { crypto } }));
  if (authOut[1]) return { stage: 'auth', msg: authOut[1] };
  const afterAuth = authOut[0];

  execSqliteTopicNode(native, afterAuth); // delete-device-lookup

  const unlinkNode = findNode(flows, 'delete-device-unlink');
  const unlinkOut = routeOutputs(unlinkNode, await executeFunctionNode(unlinkNode, afterAuth, { flowStore, env }));
  if (unlinkOut[1]) return { stage: 'unlink', msg: unlinkOut[1] };
  const afterUnlink = unlinkOut[0];

  execSqliteTopicNode(native, afterUnlink); // delete-device-db

  const responseNode = findNode(flows, 'delete-device-response');
  // delete-device-response returns a bare msg, not an [out0, out1] array.
  const finalMsg = await executeFunctionNode(responseNode, afterUnlink, { flowStore, env });
  return { stage: 'response', msg: finalMsg };
}

function seedUser(native) {
  const now = new Date().toISOString();
  native.prepare(
    "INSERT INTO users(id, username, password_hash, created_at, role) VALUES (1, 'harnessuser', 'x', ?, 'admin')"
  ).run(now);
}

test('F33: DELETE /api/devices/:deveui for a DevEUI never registered answers 404, not a fabricated 200', async () => {
  const flows = readFlows();
  const { native, cleanup } = freshDbCopy();
  try {
    seedUser(native);
    // Deliberately no row in `devices` for this deveui.

    const result = await runDeleteDeviceChain(flows, native, {
      userId: 1, username: 'harnessuser', deveui: '70B3D57ED0099999',
    });

    assert.equal(result.stage, 'response', JSON.stringify(result));
    assert.equal(result.msg.statusCode, 404, JSON.stringify(result.msg.payload));
    assert.equal(result.msg.payload.message, 'Device not found or access denied');
  } finally {
    cleanup();
  }
});

test('F33: DELETE /api/devices/:deveui for a device owned by someone else answers 404, not a leaked unclaim', async () => {
  const flows = readFlows();
  const { native, cleanup } = freshDbCopy();
  try {
    const now = new Date().toISOString();
    seedUser(native);
    native.prepare(
      "INSERT INTO users(id, username, password_hash, created_at, role) VALUES (2, 'otheruser', 'x', ?, 'admin')"
    ).run(now);
    native.prepare(
      "INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, sync_version) " +
      "VALUES ('70B3D57ED0099999', 'Sim Sensor', 'KIWI_SENSOR', 2, ?, ?, 1)"
    ).run(now, now);

    const result = await runDeleteDeviceChain(flows, native, {
      userId: 1, username: 'harnessuser', deveui: '70B3D57ED0099999',
    });

    assert.equal(result.stage, 'response', JSON.stringify(result));
    assert.equal(result.msg.statusCode, 404, JSON.stringify(result.msg.payload));

    const row = native.prepare("SELECT user_id FROM devices WHERE deveui = '70B3D57ED0099999'").get();
    assert.equal(row.user_id, 2, 'a device owned by a different user must not be unclaimed');
  } finally {
    cleanup();
  }
});

test('F33: DELETE /api/devices/:deveui for a real, owned device still succeeds (200) and actually unclaims it', async () => {
  const flows = readFlows();
  const { native, cleanup } = freshDbCopy();
  try {
    seedUser(native);
    const now = new Date().toISOString();
    native.prepare(
      "INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, sync_version) " +
      "VALUES ('70B3D57ED0099999', 'Sim Sensor', 'KIWI_SENSOR', 1, ?, ?, 1)"
    ).run(now, now);

    const result = await runDeleteDeviceChain(flows, native, {
      userId: 1, username: 'harnessuser', deveui: '70B3D57ED0099999',
    });

    assert.equal(result.stage, 'response', JSON.stringify(result));
    assert.equal(result.msg.statusCode, 200, JSON.stringify(result.msg.payload));
    assert.equal(result.msg.payload.message, 'Device removed successfully');
    assert.equal(result.msg.payload.device_eui, '70B3D57ED0099999');

    const row = native.prepare("SELECT user_id, irrigation_zone_id FROM devices WHERE deveui = '70B3D57ED0099999'").get();
    assert.equal(row.user_id, null, 'the device must actually be unclaimed (user_id cleared)');
    assert.equal(row.irrigation_zone_id, null);
  } finally {
    cleanup();
  }
});

console.log('delete-device flow (F33) behavioral tests defined; run with `node --test` to execute.');
