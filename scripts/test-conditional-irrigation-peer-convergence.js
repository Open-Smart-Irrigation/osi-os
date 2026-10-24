#!/usr/bin/env node
'use strict';

// Exercises the shipped bootstrap builder/mark seam with a durable peer row.
// The first response is legacy-route (capture without guard), then a guarded
// failure invalidates support and the later legacy response re-advertises the
// server capability. A mismatched request must not advance the cursor.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = 'AABBCCDDEEFF0021';
const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const CONTEXT = {
  server_url: 'https://cloud.invalid',
  cloud_user_id: 'cloud-user-1',
  gateway_device_eui: GATEWAY,
  installation_uuid: INSTALLATION,
};
const CAPABILITY = 'conditional_irrigation_v1';
const replication = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.js'
));

function loadNode(profile, id) {
  const flow = JSON.parse(fs.readFileSync(path.join(
    ROOT,
    `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`
  ), 'utf8'));
  const node = flow.find((candidate) => candidate.id === id);
  assert.ok(node, `${profile}: missing ${id}`);
  return node;
}

class PeerDb {
  constructor(options = {}) {
    this.row = {
      peer_node: 'cloud',
      linked: 1,
      ...CONTEXT,
      peer_capabilities_json: options.capabilities === undefined ? '[]' : JSON.stringify(options.capabilities),
      peer_capabilities_context_json: options.context === false ? null : JSON.stringify(options.context || CONTEXT),
      peer_capabilities_request_id: options.requestId || null,
      identity_installation_uuid: INSTALLATION,
      identity_gateway_device_eui: GATEWAY,
    };
    this.runs = [];
    this.closed = false;
  }

  all(sql, params, callback) {
    if (/FROM sync_link_state/.test(sql)) {
      callback(null, [this.row]);
      return;
    }
    callback(null, []);
  }

  run(sql, params, callback) {
    this.runs.push({ sql: String(sql), params: Array.isArray(params) ? params.slice() : [] });
    if (/SET peer_capabilities_json=NULL, peer_capabilities_context_json=NULL/.test(sql)) {
      this.row.peer_capabilities_json = null;
      this.row.peer_capabilities_context_json = null;
      this.row.peer_capabilities_request_id = null;
    } else if (/SET peer_capabilities_json=\?, peer_capabilities_context_json=\?/.test(sql)) {
      this.row.peer_capabilities_json = params[0];
      this.row.peer_capabilities_context_json = params[1];
      this.row.peer_capabilities_request_id = params[2];
    } else if (/SET peer_capabilities_json='\[\]'/ .test(sql)) {
      this.row.peer_capabilities_json = '[]';
    }
    callback.call({ changes: 1 }, null);
  }

  close(callback) {
    this.closed = true;
    callback(null);
  }
}

function runtime(db) {
  const state = new Map();
  const warnings = [];
  const env = { get(key) { return key === 'DEVICE_EUI' ? GATEWAY : null; } };
  const node = { warn(value) { warnings.push(String(value)); }, error() {}, log() {}, status() {} };
  const osiDb = { Database: class { constructor() { return db; } } };
  const osiLib = { require(name) {
    return name === 'osi-irrigation-policy' ? { ok: true, value: replication } : { ok: false, error: name };
  } };
  return { flow: { get(key) { return state.get(key); }, set(key, value) { state.set(key, value); } }, env, node, osiDb, osiLib, warnings };
}

async function executeMark(profile, db, message) {
  return executeNode(profile, 'sync-bootstrap-mark', db, message);
}

async function executeNode(profile, id, db, message) {
  const context = runtime(db);
  const execute = new Function('msg', 'flow', 'env', 'node', 'osiDb', 'osiLib', loadNode(profile, id).func);
  const result = await execute(message, context.flow, context.env, context.node, context.osiDb, context.osiLib);
  return { result, state: context.flow.get('sync_state') || {}, warnings: context.warnings };
}

for (const profile of ['bcm2712', 'bcm2709']) {
  test(`${profile}: legacy bootstrap response upgrades a captured peer`, async () => {
    const db = new PeerDb();
    const message = {
      statusCode: 200,
      payload: { success: true, supportedSyncCapabilities: [CAPABILITY] },
      _syncConditionalRequestId: 'legacy-capture-1',
      _syncConditionalPeerContext: CONTEXT,
      _syncConditionalGuarded: false,
      _syncLinkedUserId: null,
    };
    db.row.peer_capabilities_request_id = message._syncConditionalRequestId;
    db.row.peer_capabilities_context_json = JSON.stringify(CONTEXT);
    const outcome = await executeMark(profile, db, message);
    assert.equal(outcome.result, null);
    assert.deepEqual(JSON.parse(db.row.peer_capabilities_json), [CAPABILITY]);
    assert.ok(db.runs.some((entry) => /INSERT INTO sync_cursor/.test(entry.sql)), 'successful response advances the cursor');
    const acceptanceIndex = db.runs.findIndex((entry) => /SET peer_capabilities_json=\?, peer_capabilities_context_json=\?/.test(entry.sql));
    const cursorIndex = db.runs.findIndex((entry) => /INSERT INTO sync_cursor/.test(entry.sql));
    assert.ok(acceptanceIndex >= 0 && acceptanceIndex < cursorIndex, 'capability acceptance precedes cursor success state');
  });

  test(`${profile}: successful bootstrap without capabilities clears prior support`, async () => {
    const db = new PeerDb({ capabilities: [CAPABILITY], requestId: 'bootstrap-missing-capabilities' });
    const outcome = await executeMark(profile, db, {
      statusCode: 200,
      // A 2xx response without a capability list is an explicit legacy peer.
      // The shipped mark node must consume that response before recording the
      // cursor success, so the next payload omits conditional resources.
      payload: { success: true },
      _syncConditionalRequestId: 'bootstrap-missing-capabilities',
      _syncConditionalPeerContext: CONTEXT,
      _syncConditionalGuarded: true,
      _syncLinkedUserId: null,
    });
    assert.equal(outcome.result, null);
    assert.deepEqual(JSON.parse(db.row.peer_capabilities_json), []);
    assert.ok(db.runs.some((entry) => /SET peer_capabilities_json='\[\]'/.test(entry.sql)));
    assert.ok(db.runs.some((entry) => /INSERT INTO sync_cursor/.test(entry.sql)));
  });

  test(`${profile}: stale response leaves cursor untouched`, async () => {
    const db = new PeerDb({ requestId: 'newer-request' });
    const message = {
      statusCode: 200,
      payload: { success: true, supportedSyncCapabilities: [CAPABILITY] },
      _syncConditionalRequestId: 'stale-request',
      _syncConditionalPeerContext: CONTEXT,
      _syncConditionalGuarded: false,
      _syncLinkedUserId: null,
    };
    const outcome = await executeMark(profile, db, message);
    assert.equal(outcome.result, null);
    assert.equal(db.runs.some((entry) => /INSERT INTO sync_cursor/.test(entry.sql)), false);
    assert.equal(outcome.state.lastError && outcome.state.lastError.message, 'Bootstrap response context is stale');
  });

  test(`${profile}: guarded failure then later legacy response converges again`, async () => {
    const db = new PeerDb({ capabilities: [CAPABILITY], requestId: 'guarded-1' });
    const failure = await executeMark(profile, db, {
      statusCode: 404,
      payload: { error: 'CONDITIONAL_IRRIGATION_UNSUPPORTED' },
      _syncConditionalRequestId: 'guarded-1',
      _syncConditionalPeerContext: CONTEXT,
      _syncConditionalGuarded: true,
    });
    assert.equal(failure.result, null);
    assert.equal(db.row.peer_capabilities_json, null, 'guarded 404 invalidates accepted support');
    assert.equal(db.row.peer_capabilities_request_id, null);

    db.row.peer_capabilities_request_id = 'recovery-2';
    db.row.peer_capabilities_context_json = JSON.stringify(CONTEXT);
    db.row.peer_capabilities_json = '[]';
    const recovery = await executeMark(profile, db, {
      statusCode: 200,
      payload: { success: true, supportedSyncCapabilities: [CAPABILITY] },
      _syncConditionalRequestId: 'recovery-2',
      _syncConditionalPeerContext: CONTEXT,
      _syncConditionalGuarded: false,
      _syncLinkedUserId: null,
    });
    assert.equal(recovery.result, null);
    assert.deepEqual(JSON.parse(db.row.peer_capabilities_json), [CAPABILITY]);
    assert.equal(recovery.state.lastBootstrapSuccessAt !== undefined, true);
  });

  for (const statusCode of [404, 503]) {
    test(`${profile}: normal guarded bootstrap ${statusCode} invalidates current support without cursor success`, async () => {
      const db = new PeerDb({ capabilities: [CAPABILITY], requestId: 'bootstrap-current' });
      const outcome = await executeNode(profile, 'sync-bootstrap-mark', db, {
        statusCode,
        payload: { code: 'CONDITIONAL_IRRIGATION_UNSUPPORTED' },
        _syncConditionalRequestId: 'bootstrap-current',
        _syncConditionalPeerContext: CONTEXT,
        _syncConditionalGuarded: true,
      });
      assert.equal(outcome.result, null);
      assert.equal(db.row.peer_capabilities_json, null);
      assert.equal(db.runs.some((entry) => /INSERT INTO sync_cursor/.test(entry.sql)), false);
    });

    test(`${profile}: normal guarded bootstrap ${statusCode} preserves newer support on stale context`, async () => {
      const db = new PeerDb({ capabilities: [CAPABILITY], requestId: 'bootstrap-stale' });
      db.row.gateway_device_eui = 'AABBCCDDEEFF00FF';
      const outcome = await executeNode(profile, 'sync-bootstrap-mark', db, {
        statusCode,
        payload: { code: 'CONDITIONAL_IRRIGATION_UNSUPPORTED' },
        _syncConditionalRequestId: 'bootstrap-stale',
        _syncConditionalPeerContext: CONTEXT,
        _syncConditionalGuarded: true,
      });
      assert.equal(outcome.result, null);
      assert.deepEqual(JSON.parse(db.row.peer_capabilities_json), [CAPABILITY]);
      assert.equal(db.runs.some((entry) => /INSERT INTO sync_cursor/.test(entry.sql)), false);
    });
  }

  test(`${profile}: successful outbox response without capabilities clears prior support`, async () => {
    const db = new PeerDb({ capabilities: [CAPABILITY], requestId: 'outbox-missing-capabilities' });
    const outcome = await executeNode(profile, 'sync-outbox-mark', db, {
      statusCode: 200,
      payload: { results: [{ eventUuid: 'outbox-event-1', status: 'APPLIED' }] },
      _syncConditionalRequestId: 'outbox-missing-capabilities',
      _syncConditionalPeerContext: CONTEXT,
      _syncConditionalGuarded: true,
      _syncEventIds: ['outbox-event-1'],
    });
    assert.equal(outcome.result, null);
    assert.deepEqual(JSON.parse(db.row.peer_capabilities_json), []);
    assert.ok(db.runs.some((entry) => /SET peer_capabilities_json='\[\]'/.test(entry.sql)));
    assert.ok(db.runs.some((entry) => /UPDATE sync_outbox SET delivered_at/.test(entry.sql)));
  });

  for (const statusCode of [404, 503]) {
    test(`${profile}: ordinary guarded outbox ${statusCode} invalidates current support without mutating events`, async () => {
      const db = new PeerDb({ capabilities: [CAPABILITY], requestId: 'outbox-current' });
      const outcome = await executeNode(profile, 'sync-outbox-mark', db, {
        statusCode,
        payload: { code: 'CONDITIONAL_IRRIGATION_UNSUPPORTED' },
        _syncConditionalRequestId: 'outbox-current',
        _syncConditionalPeerContext: CONTEXT,
        _syncConditionalGuarded: true,
        _syncEventIds: ['outbox-event-1'],
      });
      assert.equal(outcome.result, null);
      assert.equal(db.row.peer_capabilities_json, null);
      assert.equal(db.runs.some((entry) => /UPDATE sync_outbox/.test(entry.sql)), false);
    });

    test(`${profile}: ordinary guarded outbox ${statusCode} preserves newer support on stale context`, async () => {
      const db = new PeerDb({ capabilities: [CAPABILITY], requestId: 'outbox-stale' });
      db.row.gateway_device_eui = 'AABBCCDDEEFF00FF';
      const outcome = await executeNode(profile, 'sync-outbox-mark', db, {
        statusCode,
        payload: { code: 'CONDITIONAL_IRRIGATION_UNSUPPORTED' },
        _syncConditionalRequestId: 'outbox-stale',
        _syncConditionalPeerContext: CONTEXT,
        _syncConditionalGuarded: true,
        _syncEventIds: ['outbox-event-1'],
      });
      assert.equal(outcome.result, null);
      assert.deepEqual(JSON.parse(db.row.peer_capabilities_json), [CAPABILITY]);
      assert.equal(db.runs.some((entry) => /UPDATE sync_outbox/.test(entry.sql)), false);
    });
  }
}
