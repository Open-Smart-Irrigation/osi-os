#!/usr/bin/env node
'use strict';

// zone_apply_versioned_v1: the edge reports the version-checked legacy zone
// apply (osi-zone-commands applyLegacyZoneCommand) only while that module is
// loadable, following the conditional_irrigation_v1 drop rule. Pins the shared
// builder (osi-installation-helper reportedSyncCapabilities), the real
// account-link build stage that sends the link request, and the handoff state
// of the two flows.json builders (sync-bootstrap-build, sync-force-build),
// on both profiles.
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

function loader(modules) {
  return (name) => (Object.prototype.hasOwnProperty.call(modules, name)
    ? { ok: true, value: modules[name] }
    : { ok: false, error: 'module not installed: ' + name });
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
    db.cleanup();
  }
}

for (const profile of PROFILES) {
  test(`${profile}: reportedSyncCapabilities includes zone_apply_versioned_v1 only while the version-checked zone apply is loadable`, () => {
    const { installation, zoneCommands } = profileShare(profile);
    assert.deepEqual(
      installation.reportedSyncCapabilities(loader({ 'osi-irrigation-policy': {}, 'zone-commands': zoneCommands })),
      CAPABILITY_BASE.concat(['conditional_irrigation_v1', 'zone_apply_versioned_v1']),
      'every module loadable: full list'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities(loader({ 'osi-irrigation-policy': {} })),
      CAPABILITY_BASE.concat(['conditional_irrigation_v1']),
      'zone-commands missing: the capability is dropped'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities(loader({ 'osi-irrigation-policy': {}, 'zone-commands': { other: true } })),
      CAPABILITY_BASE.concat(['conditional_irrigation_v1']),
      'a zone-commands module without applyLegacyZoneCommand is not enough'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities(loader({ 'zone-commands': zoneCommands })),
      CAPABILITY_BASE.concat(['zone_apply_versioned_v1']),
      'conditional irrigation keeps its own drop rule'
    );
    assert.deepEqual(
      installation.reportedSyncCapabilities(loader({})),
      CAPABILITY_BASE,
      'no conditional module loadable: the unconditional base remains'
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

  test(`${profile}: the shared builder differs from the flows builders only by the pending zone wiring`, () => {
    const { installation, zoneCommands, flows } = profileShare(profile);
    const shared = installation.reportedSyncCapabilities(loader({ 'osi-irrigation-policy': {}, 'zone-commands': zoneCommands }));
    for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
      const node = flows().find((candidate) => candidate.id === id);
      assert.ok(node, `${profile}: ${id} exists`);
      const match = String(node.func).match(/const syncCapabilities = \[([^\]]*)\];/);
      assert.ok(match, `${profile}: ${id} still builds its inline capability base`);
      const inline = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
      assert.deepEqual(
        shared.filter((capability) => capability !== 'zone_apply_versioned_v1'),
        inline,
        `${profile}: ${id} and the shared builder agree apart from zone_apply_versioned_v1`
      );
    }
  });
}
