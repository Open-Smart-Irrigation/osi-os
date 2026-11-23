#!/usr/bin/env node
'use strict';

// zone_apply_versioned_v1: the edge reports the version-checked legacy zone
// apply (osi-zone-commands applyLegacyZoneCommand) only while that module is
// loadable, following the conditional_irrigation_v1 drop rule. Pins the shared
// builder (osi-installation-helper reportedSyncCapabilities), the real
// account-link build stage that sends the link request, and the shipped
// sync-bootstrap-build / sync-force-build bodies, on both profiles.
//
// Run: node --test scripts/test-zone-apply-versioned-capability.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { installationOsiLib, accountGatewayIo } = require('./lib/installation-osi-lib');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const NOW = '2026-11-23T09:00:00.000Z';
const OWNER = '22222222-2222-4222-8222-222222222222';
const INSTALLATION = '44444444-4444-4444-8444-444444444444';

const CAPABILITY_BASE = [
  'linked_auth_sync_v1',
  'force_edge_sync_v1',
  'installation_recovery_v1',
  'installation_locations_v1',
  'entity_name_commands_v1',
  'zone_config_weather_source_v1',
  'zone_config_stage_started_on_v1',
  'watermark_v1',
  'chameleon_config_commands_v1',
  'device_soil_depth_commands_v1',
];

function profileShare(profile) {
  const share = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
  return {
    installation: require(path.join(share, 'node-red/osi-installation-helper/index.js')),
    replication: require(path.join(share, 'node-red/osi-irrigation-policy/replication.js')),
    zoneCommands: require(path.join(share, 'node-red/osi-zone-commands/index.js')),
    flows: () => JSON.parse(fs.readFileSync(path.join(share, 'flows.json'), 'utf8')),
  };
}

// --- Real osi-db-helper over a redirected sqlite3, as in
// scripts/test-account-link-legacy-cloud.js, so beginLinkAttempt gets the
// transaction API the shared driver provides.
const helperPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js');

function sqlite3Adapter(redirectPath) {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') {
        callback = mode;
        mode = undefined;
      }
      this.native = new DatabaseSync(redirectPath, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }

    all(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const rows = this.native.prepare(sql).all(...(params || []));
        callback.call(this, null, rows);
      } catch (error) {
        callback.call(this, error);
      }
    }

    run(sql, params, callback) {
      if (typeof params === 'function') {
        callback = params;
        params = [];
      }
      try {
        const result = this.native.prepare(sql).run(...(params || []));
        callback.call({ changes: Number(result.changes) }, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    exec(sql, callback) {
      try {
        this.native.exec(sql);
        callback && callback.call(this, null);
      } catch (error) {
        callback && callback.call(this, error);
      }
    }

    close(callback) {
      try {
        callback && callback.call(this, null);
      } catch (error) {
        callback && callback.call(this, error);
      }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}

function loadOsiDbHelperFresh(redirectPath) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) return sqlite3Adapter(redirectPath);
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(helperPath)];
    return require(helperPath);
  } finally {
    Module._load = original;
  }
}

// The table set the build stage and beginLinkAttempt touch.
function freshSeededDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-zone-capability-'));
  const dbPath = path.join(tempDir, 'farming.db');
  const native = new DatabaseSync(dbPath);
  native.exec('PRAGMA journal_mode=WAL;');
  native.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT, auth_mode TEXT NOT NULL DEFAULT 'local', server_username TEXT,
    server_password_hash TEXT, server_linked_at TEXT, user_uuid TEXT, cloud_user_id INTEGER, server_url TEXT,
    server_sync_token TEXT, server_sync_token_expires_at INTEGER, server_offline_verifier TEXT,
    edge_originated INTEGER DEFAULT 0, server_offline_verifier_version INTEGER DEFAULT 0,
    last_auth_sync_at TEXT, last_auth_sync_status TEXT, last_auth_sync_error TEXT,
    role TEXT NOT NULL DEFAULT 'researcher', disabled_at TEXT, sync_version INTEGER NOT NULL DEFAULT 1);`);
  native.exec(`CREATE TABLE installation_identity (
    singleton_id INTEGER PRIMARY KEY, installation_uuid TEXT NOT NULL, current_gateway_device_eui TEXT,
    previous_gateway_device_euis_json TEXT DEFAULT '[]', recovery_state TEXT DEFAULT 'ACTIVE',
    recovery_operation_uuid TEXT, created_at TEXT, updated_at TEXT);`);
  native.exec(`CREATE TABLE sync_link_state (
    peer_node TEXT PRIMARY KEY, linked INTEGER NOT NULL DEFAULT 0, server_url TEXT, cloud_user_id TEXT,
    gateway_device_eui TEXT, updated_at TEXT NOT NULL, installation_uuid TEXT, peer_capabilities_json TEXT,
    peer_capabilities_context_json TEXT, peer_capabilities_request_id TEXT, link_attempt_json TEXT,
    identity_gateway_device_eui TEXT, identity_installation_uuid TEXT);`);
  native.exec('CREATE TABLE irrigation_policies (id INTEGER PRIMARY KEY, deleted_at TEXT);');
  native.exec('CREATE TABLE devices (id INTEGER PRIMARY KEY, deveui TEXT, user_id INTEGER, gateway_device_eui TEXT);');
  native.prepare("INSERT INTO installation_identity(singleton_id, installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, created_at, updated_at) VALUES(1, ?, 'AABBCCDDEEFF0011', '[]', 'ACTIVE', ?, ?)").run(INSTALLATION, NOW, NOW);
  native.prepare("INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role,auth_mode) VALUES(1,'edgeuser','hash',?,?,?,'admin','local')").run(NOW, NOW, OWNER);
  native.close();
  return {
    helper: loadOsiDbHelperFresh(dbPath),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

// One msg per profile: a successful build keeps the operation claimed in the
// helper module (release happens at finalize/clear), so consecutive builds in
// one process must reuse the claimed message.
const sharedBuildMsg = new Map();

async function runLinkBuild(profile, modules) {
  const share = profileShare(profile);
  const db = freshSeededDb();
  const warnings = [];
  const flowState = new Map([
    ['al_local_username', 'edgeuser'],
    ['al_local_user_id', 1],
    ['al_server_url', 'https://cloud.example.org'],
    ['al_action', 'link'],
    ['al_server_username', 'edgeuser'],
    ['al_server_email', 'edgeuser@example.org'],
    ['al_server_password', 'password'],
    ['al_gateway_device_eui', 'AABBCCDDEEFF0011'],
    ['al_gateway_device_eui_confidence', 'authoritative'],
  ]);
  const msg = sharedBuildMsg.get(profile) || {};
  sharedBuildMsg.set(profile, msg);
  msg.authUserId = 1;
  msg.authUsername = 'edgeuser';
  // The clear stage that releases the operation between runs also nulls the
  // al_* keys it snapshotted onto this message; drop the snapshot so each
  // build re-reads the fresh flow state above.
  delete msg._alState;
  try {
    const request = await share.installation.accountLinkStage('build', {
      msg,
      node: { warn: (text) => warnings.push(String(text)), error: (text) => warnings.push(String(text)), status: () => {}, log: () => {} },
      flow: { get: (key) => flowState.get(key), set: (key, value) => flowState.set(key, value) },
      env: { get: (key) => (key === 'FIRMWARE_VERSION' ? 'test-build' : '') },
      global: { get: (key) => (key === 'fs' || key === 'cp' ? accountGatewayIo()[key] : undefined) },
      osiDb: db.helper,
      osiLib: installationOsiLib(profile, modules),
    });
    assert.ok(Array.isArray(request) && request[0], 'the build stage must produce the link request: ' + JSON.stringify(request && request[1] && request[1].payload));
    assert.equal(request[1], null);
    return { payload: request[0].payload, url: request[0].url, warnings };
  } finally {
    // A successful build keeps the account operation claimed in the helper
    // module (release happens at clear/finalize); gatewayWorkBlocked refuses
    // the sync nodes while a claim is live, so release it through the shipped
    // clear stage before the flows-side tests run in this process.
    await share.installation.accountLinkStage('clear', {
      msg,
      node: { warn: () => {}, error: () => {}, status: () => {}, log: () => {} },
      flow: { get: (key) => flowState.get(key), set: (key, value) => flowState.set(key, value) },
      env: { get: () => '' },
      global: { get: (key) => (key === 'fs' || key === 'cp' ? accountGatewayIo()[key] : undefined) },
      osiDb: db.helper,
      osiLib: installationOsiLib(profile, modules),
    });
    db.cleanup();
  }
}

for (const profile of PROFILES) {
  test(`${profile}: reportedSyncCapabilities includes zone_apply_versioned_v1 only while the version-checked zone apply is loadable`, () => {
    const { installation, zoneCommands } = profileShare(profile);
    assert.deepEqual(
      installation.reportedSyncCapabilities({ conditionalIrrigation: { ok: true, value: {} }, zoneCommands: { ok: true, value: zoneCommands } }),
      CAPABILITY_BASE.concat(['conditional_irrigation_v1', 'zone_apply_versioned_v1']),
      'every module loadable: full list'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities({ conditionalIrrigation: { ok: true, value: {} } }),
      CAPABILITY_BASE.concat(['conditional_irrigation_v1']),
      'zone-commands result missing: the capability is dropped'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities({ conditionalIrrigation: { ok: true, value: {} }, zoneCommands: { ok: false, error: 'module not installed: zone-commands' } }),
      CAPABILITY_BASE.concat(['conditional_irrigation_v1']),
      'a failed zone-commands load result drops the capability'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities({ conditionalIrrigation: { ok: true, value: {} }, zoneCommands: { ok: true, value: { other: true } } }),
      CAPABILITY_BASE.concat(['conditional_irrigation_v1']),
      'a zone-commands module without applyLegacyZoneCommand is not enough'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities({ zoneCommands: { ok: true, value: zoneCommands } }),
      CAPABILITY_BASE.concat(['zone_apply_versioned_v1']),
      'conditional irrigation keeps its own drop rule'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities({ conditionalIrrigation: { ok: false, error: 'module not installed' }, zoneCommands: { ok: true, value: zoneCommands } }),
      CAPABILITY_BASE.concat(['zone_apply_versioned_v1']),
      'a failed conditional irrigation load result drops only its own token'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities(),
      CAPABILITY_BASE,
      'no load results at all: the unconditional base remains'
    );
  });

  test(`${profile}: the link request reports zone_apply_versioned_v1 when osi-zone-commands loads`, async () => {
    const { replication, zoneCommands } = profileShare(profile);
    const out = await runLinkBuild(profile, { 'osi-irrigation-policy': replication, 'zone-commands': zoneCommands });
    assert.deepEqual(
      out.payload.syncCapabilities,
      CAPABILITY_BASE.concat(['conditional_irrigation_v1', 'zone_apply_versioned_v1']),
      'the link request carries the capability'
    );
  });

  test(`${profile}: the link request omits zone_apply_versioned_v1 when osi-zone-commands cannot load`, async () => {
    const { replication } = profileShare(profile);
    const out = await runLinkBuild(profile, { 'osi-irrigation-policy': replication });
    assert.deepEqual(
      out.payload.syncCapabilities,
      CAPABILITY_BASE.concat(['conditional_irrigation_v1']),
      'the link request drops the capability with the module'
    );
  });

  test(`${profile}: both flows builders build the list through the shared builder`, () => {
    const { flows } = profileShare(profile);
    for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
      const node = flows().find((candidate) => candidate.id === id);
      assert.ok(node, `${profile}: ${id} exists`);
      assert.match(
        node.func,
        /const syncCapabilities = installation\.reportedSyncCapabilities\(\{ conditionalIrrigation: osiLib\.require\('osi-irrigation-policy'\), zoneCommands: osiLib\.require\('zone-commands'\) \}\);/,
        `${profile}: ${id} delegates to reportedSyncCapabilities`
      );
      assert.match(node.func, /if \(journalAdvertisement\) syncCapabilities\.push\('field_journal_v1'\);/, `${profile}: ${id} keeps the journal-only capability push`);
    }
  });
}

// --- Flows side: the shipped sync-bootstrap-build and sync-force-build bodies
// (executed as in scripts/test-sync-without-conditional-helper.js against a
// seeded SQLite fixture) report the capability with the module and drop it
// without.
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = 'AABBCCDDEEFF0042';

function flowsFixture() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SEED);
  raw.prepare("INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role,auth_mode,server_url,server_sync_token,cloud_user_id) VALUES(1,'owner','hash',?,?,?,'admin','server','https://cloud.test.invalid','sync-token',7)").run(NOW, NOW, OWNER);
  raw.prepare("INSERT OR REPLACE INTO installation_identity(singleton_id, installation_uuid, current_gateway_device_eui, previous_gateway_device_euis_json, recovery_state, created_at, updated_at) VALUES(1, ?, ?, '[]', 'ACTIVE', ?, ?)").run(INSTALLATION, GATEWAY, NOW, NOW);
  raw.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,'https://cloud.test.invalid',7,?,?,?)").run(GATEWAY, INSTALLATION, NOW);
  return { Database: require('./lib/queued-db-fixture').osiDbFor(raw).Database };
}

function flowsRuntime(helpers) {
  const warnings = [];
  const errors = [];
  const flowState = {};
  return {
    warnings,
    errors,
    flowState,
    node: { warn: (text) => warnings.push(String(text)), error: (text) => errors.push(String(text)), status: () => {}, log: () => {} },
    flow: { get: (key) => flowState[key], set: (key, value) => { flowState[key] = value; } },
    env: { get: (key) => ({ DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'test', DEVICE_EUI_CONFIDENCE: 'active', FIRMWARE_VERSION: 'test-build', OSI_SCOPED_ACCESS: '0' }[key] || '') },
    global: { get: (key) => (key === 'fs' ? { existsSync: () => false, readdirSync: () => [] } : undefined) },
    osiLib: {
      require(name) {
        if (Object.prototype.hasOwnProperty.call(helpers, name)) return { ok: true, value: helpers[name] };
        return { ok: false, error: 'module not installed: ' + name };
      },
    },
  };
}

function flowHelpers(profile, withZoneCommands) {
  const share = profileShare(profile);
  const nodeRed = (dir) => require(path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red/${dir}/index.js`));
  const helpers = {
    installation: share.installation,
    'osi-irrigation-policy': share.replication,
    'history-sync': nodeRed('osi-history-sync-helper'),
    'osi-valve-control': nodeRed('osi-valve-control'),
    scope: nodeRed('osi-scope-helper'),
    'rejection-recovery': nodeRed('osi-rejection-recovery'),
  };
  if (withZoneCommands) helpers['zone-commands'] = share.zoneCommands;
  return helpers;
}

function fakeCloud(calls) {
  return { requestJsonIpv4: async (request) => {
    calls.push(request);
    if (request.url.endsWith('/auth/refresh-sync')) return { statusCode: 200, payload: { token: 'sync-token' } };
    if (/\/api\/v1\/sync\/edge\/bootstrap/.test(request.url)) return { statusCode: 200, payload: { success: true, applied: 1, skipped: 0 } };
    if (/\/api\/v1\/sync\/edge\/events/.test(request.url)) return { statusCode: 200, payload: { results: [] } };
    if (request.url.includes('/pending-commands')) return { statusCode: 200, payload: { commands: [] } };
    throw new Error('unexpected request ' + request.url);
  } };
}

async function runFlowNode(profile, id, rt, msg, cloud) {
  const node = profileShare(profile).flows().find((candidate) => candidate.id === id);
  assert.ok(node, `${profile}: ${id} exists`);
  const names = ['msg', 'node', 'flow', 'env', 'global', ...node.libs.map((lib) => lib.var)];
  const values = [msg, rt.node, rt.flow, rt.env, rt.global, ...node.libs.map((lib) => (lib.var === 'osiCloudHttp' ? cloud : { crypto, osiDb: { Database: flowsFixture().Database }, osiLib: rt.osiLib }[lib.var]))];
  return new Function(...names, node.func)(...values);
}

async function bootstrapCapabilities(profile, withZoneCommands) {
  const rt = flowsRuntime(flowHelpers(profile, withZoneCommands));
  const built = await runFlowNode(profile, 'sync-bootstrap-build', rt, {});
  assert.ok(built && built.payload, 'the bootstrap builds a request: ' + JSON.stringify({ warnings: rt.warnings, errors: rt.errors }));
  assert.match(built.url, /\/api\/v1\/sync\/edge\/bootstrap$/);
  return { capabilities: built.payload.gatewayIdentity.syncCapabilities, rt };
}

async function forceSyncBootstrapCapabilities(profile, withZoneCommands) {
  const rt = flowsRuntime(flowHelpers(profile, withZoneCommands));
  const calls = [];
  const forced = await runFlowNode(profile, 'sync-force-build', rt, { _forceSyncInternal: true, _forceSyncUserId: 1, _forceSyncUsername: 'owner' }, fakeCloud(calls));
  assert.ok(Array.isArray(forced), 'force sync answers: ' + JSON.stringify({ warnings: rt.warnings, errors: rt.errors }));
  assert.equal(rt.errors.length, 0, rt.errors.join('\n'));
  const bootstraps = calls.filter((request) => /\/api\/v1\/sync\/edge\/bootstrap$/.test(request.url));
  assert.ok(bootstraps.length > 0, 'force sync bootstraps');
  return { capabilities: bootstraps[0].payload.gatewayIdentity.syncCapabilities, rt };
}

for (const profile of PROFILES) {
  test(`${profile}: the bootstrap report includes zone_apply_versioned_v1 when osi-zone-commands loads`, async () => {
    const out = await bootstrapCapabilities(profile, true);
    assert.deepEqual(out.capabilities, CAPABILITY_BASE.concat(['conditional_irrigation_v1', 'zone_apply_versioned_v1']));
  });

  test(`${profile}: the bootstrap report omits zone_apply_versioned_v1 when osi-zone-commands cannot load`, async () => {
    const out = await bootstrapCapabilities(profile, false);
    assert.deepEqual(out.capabilities, CAPABILITY_BASE.concat(['conditional_irrigation_v1']));
  });

  test(`${profile}: the force-sync bootstrap report includes zone_apply_versioned_v1 when osi-zone-commands loads`, async () => {
    const out = await forceSyncBootstrapCapabilities(profile, true);
    assert.deepEqual(out.capabilities, CAPABILITY_BASE.concat(['conditional_irrigation_v1', 'zone_apply_versioned_v1']));
  });

  test(`${profile}: the force-sync bootstrap report omits zone_apply_versioned_v1 when osi-zone-commands cannot load`, async () => {
    const out = await forceSyncBootstrapCapabilities(profile, false);
    assert.deepEqual(out.capabilities, CAPABILITY_BASE.concat(['conditional_irrigation_v1']));
  });
}
