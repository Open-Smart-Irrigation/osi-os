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
const os = require('node:os');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { createSqlite3Adapter } = require('./lib/sqlite3-node-adapter');

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

// The shipped seam now requires the queued helper's get/transaction API.
// Keep the original scenarios and expectations, but read their peer state from
// a second connection so they prove committed persistence, not mock mutation.
const peerFixtures = [];
test.after(() => {
  for (const fixture of peerFixtures) {
    fixture.control.close();
    for (const handle of fixture.handles) handle.native.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

class PeerDb {
  constructor(options = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-peer-convergence-'));
    this.filename = path.join(this.dir, 'farm.db');
    this.runs = [];
    this.handles = [];
    this.closed = false;
    const initial = {
      peer_node: 'cloud', linked: 1, ...CONTEXT,
      peer_capabilities_json: options.capabilities === undefined ? '[]' : JSON.stringify(options.capabilities),
      peer_capabilities_context_json: options.context === false ? null : JSON.stringify(options.context || CONTEXT),
      peer_capabilities_request_id: options.requestId || null,
      identity_installation_uuid: INSTALLATION,
      identity_gateway_device_eui: GATEWAY,
    };
    this.control = new DatabaseSync(this.filename);
    this.control.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;');
    this.control.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
    this.control.prepare(`INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,previous_gateway_device_euis_json,recovery_state,created_at,updated_at)
      VALUES(1,?,?, '[]','ACTIVE','2026-11-19','2026-11-19')`).run(INSTALLATION, GATEWAY);
    const columns = Object.keys(initial).filter((key) => !key.startsWith('identity_'));
    this.control.prepare('INSERT INTO sync_link_state (' + columns.join(',') + ',updated_at) VALUES (' + columns.map(() => '?').join(',') + ',?)')
      .run(...columns.map((key) => initial[key]), '2026-11-19');
    // Existing scenario setup remains synchronous. Reads after a mark see only
    // committed values through this separate observer connection.
    this.row = new Proxy(initial, {
      get: (target, key) => {
        if (!columns.includes(key)) return target[key];
        return this.control.prepare("SELECT * FROM sync_link_state WHERE peer_node='cloud'").get()[key];
      },
      set: (target, key, value) => {
        assert.ok(columns.includes(key), 'known fixture column');
        this.control.prepare('UPDATE sync_link_state SET ' + key + "=? WHERE peer_node='cloud'").run(value);
        return true;
      },
    });
    const helperPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js');
    const adapter = createSqlite3Adapter();
    const Base = adapter.Database;
    const fixture = this;
    adapter.Database = class extends Base {
      constructor(...args) { super(...args); fixture.handles.push(this); }
      run(sql, params, callback) {
        fixture.runs.push({ sql: String(sql), params: Array.isArray(params) ? params.slice() : [] });
        return super.run(sql, params, callback);
      }
    };
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'sqlite3' && parent && parent.filename === helperPath) return adapter;
      return original.call(this, request, parent, isMain);
    };
    let helper;
    try { delete require.cache[helperPath]; helper = require(helperPath); }
    finally { Module._load = original; }
    this.facade = new helper.Database(this.filename);
    peerFixtures.push(this);
  }

  all(...args) { return this.facade.all(...args); }
  get(...args) { return this.facade.get(...args); }
  run(...args) { return this.facade.run(...args); }
  transaction(fn) { return this.facade.transaction(fn); }
  close(callback) { this.closed = true; return this.facade.close(callback); }
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
