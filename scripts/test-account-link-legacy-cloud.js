#!/usr/bin/env node
'use strict';

// Behavioral RED/GREEN harness proving the account-link chain tolerates a
// cloud that predates installation identity.
//
// Root cause (verified 2026-09-17 on bovey-rp4-01): 'Handle server auth
// response' (al-link-handle-auth) unconditionally called
// installation.assertMatchingInstallation(local, remote), which throws when
// the remote value is empty, and separately required
// offlineVerifierVersion >= 2. A cloud that predates installation identity
// (osi-server customer/bovey: LocalSyncResponse has no installationUuid,
// offlineVerifierVersion 1) was rejected outright with "Server
// authentication returned an installation identity mismatch", so a gateway
// whose sync token expired could never re-link. 'Finalize linked account
// state' (al-link-finalize) carried the same offlineVerifierVersion >= 2 /
// installationUuid-mandatory assumption, so even a patched 'Handle server
// auth response' would still fail one step later.
//
// This harness extracts the real function-node bodies from the canonical
// flows.json and runs them with vm, exactly like
// scripts/test-auth-credential-isolation.js, so it proves behavior against
// whatever code is currently checked in -- not a paraphrase of it.
//
// Run: node --test scripts/test-account-link-legacy-cloud.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const gatewayIo = new WeakMap();
function fixtureIo(store) {
  if (gatewayIo.has(store)) return gatewayIo.get(store);
  const files = new Map(); const config = new Map(); const descriptors = new Map(); let nextFd=1;
  const fakeFs = {
    existsSync(p) { return p === '/data/db/osi-account-link-config.json' ? files.has(p) : fs.existsSync(p); },
    readFileSync(p,enc) { return files.has(p) ? files.get(p) : fs.readFileSync(p,enc); },
    openSync(p,flags) { const fd=nextFd++; descriptors.set(fd,p); if(flags==='wx') files.set(p,''); return fd; },
    writeFileSync(p,data) { files.set(typeof p==='number'?descriptors.get(p):p,String(data)); },
    closeSync(fd) { descriptors.delete(fd); }, fsyncSync() {},
    renameSync(a,b) { files.set(b,files.get(a)); files.delete(a); },
    unlinkSync(p) { if(!files.delete(p)) throw Object.assign(new Error('missing fixture file'),{code:'ENOENT'}); },
    mkdirSync() {},
  };
  const cp = { execFileSync(command,args) {
    assert.equal(command,'uci');
    if(args.includes('get')) { const k=args.at(-1); if(!config.has(k)) throw Object.assign(new Error('missing'),{status:1}); return config.get(k); }
    if(args[0]==='set') { const at=args[1].indexOf('='); config.set(args[1].slice(0,at),args[1].slice(at+1)); }
    if(args.includes('delete')) config.delete(args.at(-1));
    return '';
  }};
  const io={fs:fakeFs,cp,files,config}; gatewayIo.set(store,io); return io;
}

const root = path.resolve(__dirname, '..');
const flowsPath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const helperPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js'
);
const installationHelperPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper/index.js'
);
const replicationHelperPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/replication.js'
);
const bcryptjsPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/bcryptjs'
);

const bcryptjs = require(bcryptjsPath);
const installationHelper = require(installationHelperPath);
const replicationHelper = require(replicationHelperPath);
const osiLib = {
  require(name) {
    if (name === 'installation') return { ok: true, value: installationHelper };
    if (name === 'osi-irrigation-policy') return { ok: true, value: replicationHelper };
    return { ok: false, error: `unexpected helper ${name}` };
  },
};

// Real table shapes, copied from database/seed-blank.sql (same source
// scripts/test-auth-credential-isolation.js uses) so the harness exercises
// the actual production column set.
const USERS_TABLE_SQL = `CREATE TABLE users (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  username                        TEXT UNIQUE NOT NULL,
  password_hash                   TEXT NOT NULL,
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT DEFAULT CURRENT_TIMESTAMP,
  auth_mode                       TEXT NOT NULL DEFAULT 'local',
  server_username                 TEXT,
  server_password_hash            TEXT,
  server_linked_at                TEXT,
  user_uuid                       TEXT,
  cloud_user_id                   INTEGER,
  server_url                      TEXT,
  server_sync_token               TEXT,
  server_sync_token_expires_at    INTEGER,
  server_offline_verifier         TEXT,
  edge_originated                 INTEGER DEFAULT 0,
  server_offline_verifier_version INTEGER DEFAULT 0,
  last_auth_sync_at               TEXT,
  last_auth_sync_status           TEXT,
  last_auth_sync_error            TEXT
, role TEXT NOT NULL DEFAULT 'researcher' CHECK (role IN ('admin','researcher','viewer')), disabled_at TEXT, sync_version INTEGER NOT NULL DEFAULT 1)`;
const INSTALLATION_TABLE_SQL = `CREATE TABLE installation_identity (
  singleton_id INTEGER PRIMARY KEY,
  installation_uuid TEXT NOT NULL,
  current_gateway_device_eui TEXT,
  previous_gateway_device_euis_json TEXT DEFAULT '[]',
  recovery_state TEXT DEFAULT 'ACTIVE',
  recovery_operation_uuid TEXT,
  created_at TEXT,
  updated_at TEXT
)`;
const SYNC_LINK_STATE_SQL = `CREATE TABLE sync_link_state (
  peer_node TEXT PRIMARY KEY,
  linked INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  cloud_user_id TEXT,
  gateway_device_eui TEXT,
  updated_at TEXT NOT NULL,
  installation_uuid TEXT,
  peer_capabilities_json TEXT,
  peer_capabilities_context_json TEXT,
  peer_capabilities_request_id TEXT,
  link_attempt_json TEXT
)`;
const IRRIGATION_POLICIES_TABLE_SQL = `CREATE TABLE irrigation_policies (
  id INTEGER PRIMARY KEY,
  deleted_at TEXT
)`;
// The finalizer backfills the gateway identity on these two tables inside the
// same transaction as the account/link writes.  Keep only the columns touched
// by that production node; this harness deliberately does not duplicate the
// full seed schema.
const IDENTITY_BACKFILL_TABLES_SQL = `CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  deveui TEXT,
  user_id INTEGER,
  gateway_device_eui TEXT
);
CREATE TABLE irrigation_zones (
  id INTEGER PRIMARY KEY,
  gateway_device_eui TEXT
);
CREATE TABLE irrigation_events (
  id INTEGER PRIMARY KEY,
  irrigation_zone_id INTEGER,
  event_uuid TEXT
)`;

function readFlows(profile = 'bcm2712') {
  const file = profile === 'bcm2712'
    ? flowsPath
    : path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function findNode(flows, id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return node;
}

// --- Fake `sqlite3` driver over node:sqlite's DatabaseSync, copied from
// scripts/test-auth-credential-isolation.js. Every open is redirected to a
// fixed temp file regardless of the filename the node func requests (the
// real func hardcodes '/data/db/farming.db').
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

// Seeds a fresh temp sqlite file with the real users/installation_identity/
// sync_link_state table shapes and returns { helper, cleanup }.
function freshSeededDb(seedFn, installationUuid) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-account-link-harness-'));
  const dbPath = path.join(tempDir, 'farming.db');
  const native = new DatabaseSync(dbPath);
  native.exec('PRAGMA journal_mode=WAL;');
  native.exec(USERS_TABLE_SQL + ';');
  native.exec(INSTALLATION_TABLE_SQL + ';');
  native.exec(SYNC_LINK_STATE_SQL + ';');
  native.exec(IRRIGATION_POLICIES_TABLE_SQL + ';');
  native.exec(IDENTITY_BACKFILL_TABLES_SQL + ';');
  native
    .prepare('INSERT INTO installation_identity(singleton_id, installation_uuid) VALUES(1, ?)')
    .run(installationUuid || '123e4567-e89b-42d3-a456-426614174000');
  if (seedFn) seedFn(native);
  native.close();
  const helper = loadOsiDbHelperFresh(dbPath);
  return {
    dbPath,
    helper,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

// Runs one function-node's `func` body with a vm sandbox, Node-RED-shaped
// (msg, node, flow, env, context, global, get, set) signature, matching
// scripts/test-auth-credential-isolation.js. `warnings` (optional) captures
// every node.warn(...) call so tests can assert on it.
async function executeFunctionNode(node, msg, { flowStore, env = {}, scope = {}, warnings } = {}) {
  // Match Node-RED: only declared libs enter the function sandbox. Otherwise
  // a missing binding can pass here and fail on the gateway.
  const boundScope = Object.fromEntries((node.libs || []).map(lib => [lib.var, scope[lib.var]]));
  const fn = new vm.Script(
    `(async function(msg,node,flow,env,context,global,get,set){${node.func}\n})`
  ).runInNewContext(
    Object.assign(
      {
        Buffer,
        console,
        require,
        process,
        setTimeout,
        clearTimeout,
        URL,
      },
      boundScope
    )
  );
  const flowApi = {
    get(key) {
      return flowStore.get(key);
    },
    set(key, value) {
      if (value === undefined) flowStore.delete(key);
      else flowStore.set(key, value);
    },
  };
  const envApi = {
    get(key) {
      return env[key];
    },
  };
  const noopStore = {
    get() {
      return undefined;
    },
    set() {},
  };
  const globalApi = {
    get(key) {
      if (key === 'fs') return fixtureIo(flowStore).fs;
      if (key === 'cp') return fixtureIo(flowStore).cp;
      return undefined;
    },
    set() {},
  };
  const nodeApi = {
    error() {},
    log() {},
    warn(message) {
      if (warnings) warnings.push(message);
    },
    status() {},
  };
  return fn(msg, nodeApi, flowApi, envApi, noopStore, globalApi, () => undefined, () => {});
}

async function buildLinkAttempt(flows, flowStore, helper, expectedRoute = 'legacy') {
  const buildNode = findNode(flows, 'al-link-build-req');
  const [continueMsg, rejectMsg] = await executeFunctionNode(buildNode, {
    authUserId: 1,
    authUsername: flowStore.get('al_local_username'),
  }, {
    flowStore,
    scope: { osiDb: helper, osiLib },
  });
  assert.equal(rejectMsg, null, `link build must succeed: ${JSON.stringify(rejectMsg && rejectMsg.payload)}`);
  assert.ok(continueMsg, 'link build must produce the cloud request');
  const expectedPath = expectedRoute === 'conditional'
    ? '/auth/local-sync/conditional-irrigation-v1'
    : '/auth/local-sync';
  assert.equal(continueMsg.url, `${flowStore.get('al_server_url')}${expectedPath}`);
  return continueMsg;
}

test('legacy cloud (no installationUuid) is tolerated: link succeeds, warns once, keeps the local installation identity, and stores offlineVerifierVersion as returned', async () => {
  const flows = readFlows();
  const handleAuthNode = findNode(flows, 'al-link-handle-auth');
  const localInstallationUuid = installationHelper.newInstallationUuid();
  const flowStore = new Map();
  flowStore.set('al_installation_uuid', localInstallationUuid);
  flowStore.set('al_local_username', 'edgeuser');
  flowStore.set('al_server_url', 'https://legacy-cloud.example.org');
  flowStore.set('al_action', 'link');
  flowStore.set('al_server_username', 'edgeuser');
  flowStore.set('al_server_email', 'edgeuser@example.org');
  flowStore.set('al_server_password', 'password');
  flowStore.set('al_gateway_device_eui', 'AABBCCDDEEFF0011');
  flowStore.set('al_gateway_device_eui_confidence', 'authoritative');

  const warnings = [];
  // Exact shape of osi-server customer/bovey's pre-installation-identity
  // LocalSyncResponse: no installationUuid / installation_uuid field at all.
  const legacyResponseMsg = {
    statusCode: 200,
    payload: {
      username: 'edgeuser',
      token: 'sync-jwt-token-value',
      offlineVerifier: 'legacy-offline-verifier-hash',
      offlineVerifierVersion: 1,
      syncTokenExpiresAt: Date.now() + 3600000,
      mqttPassword: 'mqtt-secret',
      mqttBrokerUrl: 'mqtts://legacy-cloud.example.org:8883',
      userId: 77,
      claimed: [],
      skipped: [],
    },
  };

  const flowsForAttempt = flows;
  const { helper, cleanup } = freshSeededDb((native) => {
    native
      .prepare('INSERT INTO users (username, password_hash, created_at, user_uuid, role) VALUES (?, ?, ?, ?, ?)')
      .run('edgeuser', 'irrelevant-local-hash', new Date().toISOString(), '123e4567-e89b-42d3-a456-426614174111', 'admin');
  }, localInstallationUuid);
  try {
    const requestMsg = await buildLinkAttempt(flowsForAttempt, flowStore, helper);
    const responseMsg = Object.assign(requestMsg, legacyResponseMsg);
    const [continueMsg, rejectMsg] = await executeFunctionNode(handleAuthNode, responseMsg, {
      flowStore,
      scope: { osiDb: helper, osiLib },
      warnings,
    });

    assert.equal(
      rejectMsg,
      null,
      'legacy cloud response must not be rejected: ' + JSON.stringify(rejectMsg && rejectMsg.payload)
    );
    assert.ok(continueMsg, 'legacy cloud response must continue to the success output');
    assert.equal(
      warnings.length,
      1,
      'exactly one node.warn should fire for a legacy cloud (got: ' + JSON.stringify(warnings) + ')'
    );
    assert.match(warnings[0], /legacy cloud/i);
    assert.match(warnings[0], /installation identity/i);

    assert.equal(
      flowStore.get('al_installation_uuid'),
      localInstallationUuid,
      'no remote installation identity must be persisted for a legacy cloud; the local uuid must be kept'
    );
    assert.equal(
      continueMsg._alState.al_offline_verifier_version,
      1,
      'offlineVerifierVersion must be stored as returned by the cloud (1), not forced/rejected'
    );

    // --- 'Finalize linked account state' must also accept this v1 / no-remote-identity state ---
    const finalizeNode = findNode(flows, 'al-link-finalize');
    const [finalizeContinue, finalizeReject] = await executeFunctionNode(finalizeNode, continueMsg, {
      flowStore,
      scope: { osiDb: helper, osiLib },
      env: { DEVICE_EUI: 'AABBCCDDEEFF0011' },
    });
    assert.equal(
      finalizeReject,
      null,
      'finalize must not reject a legacy-cloud v1 link: ' + JSON.stringify(finalizeReject && finalizeReject.payload)
    );
    assert.ok(finalizeContinue, 'finalize must continue to the success output');

    const db = new helper.Database('/data/db/farming.db');
    const userRow = await new Promise((resolve, reject) => {
      db.all(
        'SELECT server_offline_verifier_version, server_username, auth_mode FROM users WHERE username = ?',
        ['edgeuser'],
        (error, rows) => (error ? reject(error) : resolve(rows[0]))
      );
    });
    assert.ok(userRow, 'finalize must persist the linked user row');
    assert.equal(userRow.server_offline_verifier_version, 1);
    assert.equal(userRow.server_username, 'edgeuser');
    assert.equal(userRow.auth_mode, 'server');

    const linkRow = await new Promise((resolve, reject) => {
      db.all(
        'SELECT linked, installation_uuid FROM sync_link_state WHERE peer_node = ?',
        ['cloud'],
        (error, rows) => (error ? reject(error) : resolve(rows[0]))
      );
    });
    assert.ok(linkRow, 'finalize must persist sync_link_state');
    assert.equal(linkRow.linked, 1);
    assert.equal(
      linkRow.installation_uuid,
      localInstallationUuid,
      'sync_link_state must record the LOCAL installation identity even though the cloud reported none'
    );
    await new Promise((resolve) => db.close(() => resolve()));
  } finally {
    cleanup();
  }
});

test('a cloud-reported installationUuid that differs from the local one is still rejected as a mismatch', async () => {
  const flows = readFlows();
  const handleAuthNode = findNode(flows, 'al-link-handle-auth');
  const localInstallationUuid = installationHelper.newInstallationUuid();
  const differentRemoteInstallationUuid = installationHelper.newInstallationUuid();
  assert.notEqual(localInstallationUuid, differentRemoteInstallationUuid);

  const flowStore = new Map();
  flowStore.set('al_installation_uuid', localInstallationUuid);
  flowStore.set('al_local_username', 'edgeuser');
  flowStore.set('al_server_url', 'https://modern-cloud.example.org');
  flowStore.set('al_action', 'link');
  flowStore.set('al_server_username', 'edgeuser');
  flowStore.set('al_server_email', 'edgeuser@example.org');
  flowStore.set('al_server_password', 'password');
  flowStore.set('al_gateway_device_eui', 'AABBCCDDEEFF0011');
  flowStore.set('al_gateway_device_eui_confidence', 'authoritative');

  const warnings = [];
  const mismatchedResponseMsg = {
    statusCode: 200,
    payload: {
      username: 'edgeuser',
      token: 'sync-jwt-token-value',
      offlineVerifier: 'modern-offline-verifier-hash',
      offlineVerifierVersion: 2,
      installationUuid: differentRemoteInstallationUuid,
      syncTokenExpiresAt: Date.now() + 3600000,
      mqttPassword: 'mqtt-secret',
      mqttBrokerUrl: 'mqtts://modern-cloud.example.org:8883',
      userId: 78,
      claimed: [],
      skipped: [],
    },
  };

  const { helper, cleanup } = freshSeededDb((native) => {
    native
      .prepare('INSERT INTO users (username, password_hash, created_at, user_uuid, role) VALUES (?, ?, ?, ?, ?)')
      .run('edgeuser', 'irrelevant-local-hash', new Date().toISOString(), '123e4567-e89b-42d3-a456-426614174112', 'admin');
  }, localInstallationUuid);
  try {
    const requestMsg = await buildLinkAttempt(flows, flowStore, helper);
    const responseMsg = Object.assign(requestMsg, mismatchedResponseMsg);
    const [continueMsg, rejectMsg] = await executeFunctionNode(handleAuthNode, responseMsg, {
      flowStore,
      scope: { osiDb: helper, osiLib },
      warnings,
    });

    assert.equal(continueMsg, null, 'a real installation identity mismatch must still be rejected');
    assert.ok(rejectMsg, 'mismatch must produce a rejection response');
    assert.equal(rejectMsg.statusCode, 502);
    assert.equal(rejectMsg.payload.message, 'Server authentication returned an installation identity mismatch');
    assert.equal(warnings.length, 0, 'a real mismatch is a rejection, not a legacy-cloud warning');
    assert.equal(
      flowStore.get('al_installation_uuid'),
      localInstallationUuid,
      'a rejected mismatch must not overwrite the local installation identity'
    );
  } finally {
    cleanup();
  }
});

test('verifier v1 offline login still works end to end (Login User -> Lookup Auth User -> Process Result)', async () => {
  const PASSWORD = 'LegacyLinkedPassword1';
  const gatewayDeviceEui = 'AABBCCDDEEFF0011';
  // The v1 verifier subject a legacy cloud would have computed at link time:
  // password + '::' + gatewayDeviceEui (no installation identity involved).
  const offlineVerifierSubject = installationHelper.verifierSubject(PASSWORD, 1, undefined, gatewayDeviceEui);
  const offlineVerifierHash = bcryptjs.hashSync(offlineVerifierSubject, 10);

  const { helper, cleanup } = freshSeededDb((native) => {
    native
      .prepare(
        `INSERT INTO users (
           username, password_hash, created_at, role, auth_mode,
           server_username, server_offline_verifier, server_offline_verifier_version,
           server_password_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'edge-linked-legacy',
        'unused-local-hash',
        new Date().toISOString(),
        'researcher',
        'server',
        'linked-legacy',
        offlineVerifierHash,
        1,
        // No server_password_hash fallback available: if the v1 verifier
        // subject path is broken, this login must fail rather than silently
        // succeeding through the password-hash fallback.
        null
      );
  });
  try {
    const flows = readFlows();
    const loginNode = findNode(flows, 'auth-login-func');
    const queryNode = findNode(flows, 'auth-db-query');
    const resultNode = findNode(flows, 'auth-process-result');
    const flowStore = new Map();
    const env = { AUTH_TOKEN_SECRET: 'harness-secret-value-not-a-real-secret', DEVICE_EUI: gatewayDeviceEui };

    const afterLogin = (
      await executeFunctionNode(loginNode, { payload: { username: 'linked-legacy', password: PASSWORD } }, {
        flowStore,
        env,
      })
    )[0];
    assert.ok(afterLogin, 'login-func should continue to output 0');

    const afterQuery = (
      await executeFunctionNode(queryNode, afterLogin, { flowStore, env, scope: { osiDb: helper } })
    )[0];
    assert.ok(afterQuery, 'db-query should continue to output 0');

    const [, response] = await executeFunctionNode(resultNode, afterQuery, {
      flowStore,
      env,
      scope: { bcrypt: bcryptjs, crypto: require('node:crypto'), osiLib },
    });

    assert.ok(response, 'v1 offline login should produce an HTTP response');
    assert.equal(
      response.statusCode,
      200,
      'v1 offline login must succeed via the real verifier-subject comparison: ' + JSON.stringify(response.payload)
    );
    assert.ok(response.payload && response.payload.token, 'v1 offline login must issue a token');
  } finally {
    cleanup();
  }
});

for (const profile of ['bcm2712', 'bcm2709']) {
  for (const statusCode of [404, 503]) {
    test(`${profile}: guarded link ${statusCode} makes one request and clears the current attempt without fallback`, async () => {
      const flows = readFlows(profile);
      const buildNode = findNode(flows, 'al-link-build-req');
      const serverAuthNode = findNode(flows, 'al-link-server-auth');
      const handleAuthNode = findNode(flows, 'al-link-handle-auth');
      const clearStateNode = findNode(flows, 'al-link-clear-state');
      const localInstallationUuid = installationHelper.newInstallationUuid();
      const flowStore = new Map([
        ['al_local_username', 'edgeuser'],
        ['al_server_url', 'https://guarded-cloud.example.org'],
        ['al_action', 'link'],
        ['al_server_username', 'edgeuser'],
        ['al_server_email', 'edgeuser@example.org'],
        ['al_server_password', 'password'],
        ['al_gateway_device_eui', 'AABBCCDDEEFF0011'],
        ['al_gateway_device_eui_confidence', 'authoritative'],
        ['al_local_user_id', 1],
        ['al_installation_uuid', localInstallationUuid],
      ]);
      const { helper, cleanup } = freshSeededDb((native) => {
        native.prepare('INSERT INTO users (id, username, password_hash, created_at, user_uuid, role) VALUES (?, ?, ?, ?, ?, ?)')
          .run(1, 'edgeuser', 'local-hash', new Date().toISOString(), '123e4567-e89b-42d3-a456-426614174111', 'admin');
        native.prepare('INSERT INTO irrigation_policies(id, deleted_at) VALUES (?, NULL)').run(1);
        // Seed a previously accepted capability for the same gateway context.
        // A guarded link failure must revoke this support when its own current
        // attempt fails; otherwise the next outbox tick would keep sending
        // conditional rows to a cloud that just rejected the route.
        const context = {
          server_url: 'https://guarded-cloud.example.org',
          cloud_user_id: '77',
          gateway_device_eui: 'AABBCCDDEEFF0011',
          installation_uuid: localInstallationUuid,
        };
        native.prepare(`
          INSERT INTO sync_link_state(
            peer_node, linked, server_url, cloud_user_id, gateway_device_eui,
            updated_at, installation_uuid, peer_capabilities_json,
            peer_capabilities_context_json, peer_capabilities_request_id
          ) VALUES ('cloud', 1, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.server_url,
          context.cloud_user_id,
          context.gateway_device_eui,
          new Date().toISOString(),
          context.installation_uuid,
          JSON.stringify(['conditional_irrigation_v1']),
          JSON.stringify(context),
          'prior-support-request'
        );
      }, localInstallationUuid);
      try {
        const requestMsg = await buildLinkAttempt(flows, flowStore, helper, 'conditional');
        const requestLog = [];
        const afterHttp = await executeFunctionNode(serverAuthNode, requestMsg, {
          flowStore,
          env: { OSI_CLOUD_REST_TIMEOUT_MS: '1000' },
          scope: {
            osiCloudHttp: {
              async requestJsonIpv4(request) {
                requestLog.push(request);
                return { statusCode, payload: { code: 'CONDITIONAL_IRRIGATION_UNSUPPORTED' } };
              },
            },
          },
        });
        assert.equal(requestLog.length, 1);
        assert.match(requestLog[0].url, /\/auth\/local-sync\/conditional-irrigation-v1$/);
        assert.doesNotMatch(requestLog[0].url, /\/auth\/local-sync$/);
        assert.equal(afterHttp.statusCode, statusCode);
        const [continued, rejected] = await executeFunctionNode(handleAuthNode, afterHttp, {
          flowStore,
          scope: { osiDb: helper, osiLib },
        });
        assert.equal(continued, null);
        assert.ok(rejected);
        const afterFailure = await readLinkState(helper);
        assert.equal(afterFailure.linked, 1, 'guarded failure does not unlink the basic peer context');
        assert.deepEqual(JSON.parse(afterFailure.peer_capabilities_json), ['conditional_irrigation_v1'], 'support remains until current failure cleanup');
        assert.ok(afterFailure.link_attempt_json, 'the attempt remains fenced until the failure cleanup node');
        await executeFunctionNode(clearStateNode, rejected, {
          flowStore,
          scope: { osiDb: helper, osiLib },
        });
        const afterClear = await readLinkState(helper);
        assert.equal(afterClear.link_attempt_json, null);
        assert.equal(afterClear.peer_capabilities_json, null, 'current guarded failure invalidates prior support');
        assert.equal(afterClear.peer_capabilities_context_json, null, 'current guarded failure clears support context');
        assert.equal(afterClear.peer_capabilities_request_id, null);
      } finally {
        cleanup();
      }
    });
  }

  for (const statusCode of [404, 503]) {
    test(`${profile}: stale guarded link ${statusCode} cannot clear a newer same-context linked attempt`, async () => {
      const flows = readFlows(profile);
      const serverAuthNode = findNode(flows, 'al-link-server-auth');
      const handleAuthNode = findNode(flows, 'al-link-handle-auth');
      const clearStateNode = findNode(flows, 'al-link-clear-state');
      const localInstallationUuid = installationHelper.newInstallationUuid();
      const flowStore = new Map([
        ['al_local_username', 'edgeuser'],
        ['al_server_url', 'https://guarded-cloud.example.org'],
        ['al_action', 'link'],
        ['al_server_username', 'edgeuser'],
        ['al_server_email', 'edgeuser@example.org'],
        ['al_server_password', 'password'],
        ['al_gateway_device_eui', 'AABBCCDDEEFF0011'],
        ['al_gateway_device_eui_confidence', 'authoritative'],
        ['al_local_user_id', 1],
        ['al_installation_uuid', localInstallationUuid],
      ]);
      const { helper, cleanup } = freshSeededDb((native) => {
        native.prepare('INSERT INTO users (id, username, password_hash, created_at, user_uuid, role) VALUES (?, ?, ?, ?, ?, ?)')
          .run(1, 'edgeuser', 'local-hash', new Date().toISOString(), '123e4567-e89b-42d3-a456-426614174111', 'admin');
        native.prepare('INSERT INTO irrigation_policies(id, deleted_at) VALUES (?, NULL)').run(1);
        native.prepare('UPDATE installation_identity SET current_gateway_device_eui=? WHERE singleton_id=1')
          .run('AABBCCDDEEFF0011');
        const context = {
          server_url: 'https://guarded-cloud.example.org',
          cloud_user_id: '77',
          gateway_device_eui: 'AABBCCDDEEFF0011',
          installation_uuid: localInstallationUuid,
        };
        native.prepare(`
          INSERT INTO sync_link_state(
            peer_node, linked, server_url, cloud_user_id, gateway_device_eui,
            updated_at, installation_uuid, peer_capabilities_json,
            peer_capabilities_context_json, peer_capabilities_request_id
          ) VALUES ('cloud', 1, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          context.server_url,
          context.cloud_user_id,
          context.gateway_device_eui,
          new Date().toISOString(),
          context.installation_uuid,
          JSON.stringify(['conditional_irrigation_v1']),
          JSON.stringify(context),
          'prior-support-request'
        );
      }, localInstallationUuid);
      try {
        const requestMsg = await buildLinkAttempt(flows, flowStore, helper, 'conditional');
        const newerDb = new helper.Database('/data/db/farming.db');
        const newer = await replicationHelper.beginLinkAttempt({
          db: newerDb,
          context: {
            server_url: 'https://guarded-cloud.example.org',
            gateway_device_eui: 'AABBCCDDEEFF0011',
            installation_uuid: localInstallationUuid,
          },
          nonce: 'newer-link-attempt',
          supersede: true,
        });
        await new Promise((resolve) => newerDb.close(() => resolve()));
        assert.notEqual(newer.nonce, requestMsg._alLinkAttemptNonce);
        const requestLog = [];
        const afterHttp = await executeFunctionNode(serverAuthNode, requestMsg, {
          flowStore,
          scope: {
            osiCloudHttp: {
              async requestJsonIpv4(request) {
                requestLog.push(request);
                return { statusCode, payload: { code: 'CONDITIONAL_IRRIGATION_UNSUPPORTED' } };
              },
            },
          },
        });
        assert.equal(requestLog.length, 1);
        assert.match(requestLog[0].url, /\/auth\/local-sync\/conditional-irrigation-v1$/);
        const [, rejected] = await executeFunctionNode(handleAuthNode, afterHttp, {
          flowStore,
          scope: { osiDb: helper, osiLib },
        });
        await executeFunctionNode(clearStateNode, rejected, {
          flowStore,
          scope: { osiDb: helper, osiLib },
        });
        const afterClear = await readLinkState(helper);
        assert.match(afterClear.link_attempt_json, /newer-link-attempt/);
        assert.deepEqual(JSON.parse(afterClear.peer_capabilities_json), ['conditional_irrigation_v1']);
        assert.equal(afterClear.peer_capabilities_request_id, 'prior-support-request');
      } finally {
        cleanup();
      }
    });
  }
}

async function readLinkState(helper) {
  const db = new helper.Database('/data/db/farming.db');
  try {
    return await new Promise((resolve, reject) => db.all(
      'SELECT linked, peer_capabilities_json, peer_capabilities_context_json, peer_capabilities_request_id, link_attempt_json FROM sync_link_state WHERE peer_node=?',
      ['cloud'],
      (error, rows) => error ? reject(error) : resolve(rows[0] || {})
    ));
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

// F4 (owner decision 2026-10-22): account linking must not depend on the conditional
// irrigation helper. Without it the gateway links on the legacy route and simply does not
// advertise conditional_irrigation_v1; with it, it advertises the capability as before.
const osiLibWithoutConditional = {
  require(name) {
    if (name === 'installation') return { ok: true, value: installationHelper };
    return { ok: false, error: `module not installed: ${name}` };
  },
};

async function linkEndToEnd(profile, lib) {
  const flows = readFlows(profile);
  const localInstallationUuid = installationHelper.newInstallationUuid();
  const flowStore = new Map([
    ['al_installation_uuid', localInstallationUuid], ['al_local_username', 'edgeuser'],
    ['al_server_url', 'https://cloud.example.org'], ['al_action', 'link'], ['al_server_username', 'edgeuser'],
    ['al_server_email', 'edgeuser@example.org'], ['al_server_password', 'password'],
    ['al_gateway_device_eui', 'AABBCCDDEEFF0011'], ['al_gateway_device_eui_confidence', 'authoritative'],
  ]);
  const { helper, cleanup } = freshSeededDb((native) => {
    native.prepare('INSERT INTO users (username, password_hash, created_at, user_uuid, role) VALUES (?, ?, ?, ?, ?)')
      .run('edgeuser', 'irrelevant-local-hash', new Date().toISOString(), '123e4567-e89b-42d3-a456-426614174111', 'admin');
  }, localInstallationUuid);
  const scope = { osiDb: helper, osiLib: lib };
  const warnings = [];
  const [requestMsg, buildReject] = await executeFunctionNode(findNode(flows, 'al-link-build-req'), {
    authUserId: 1, authUsername: 'edgeuser',
  }, { flowStore, scope, warnings });
  assert.equal(buildReject, null, 'link build must succeed: ' + JSON.stringify(buildReject && buildReject.payload));
  const request = { url: requestMsg.url, capabilities: requestMsg.payload.syncCapabilities.slice() };
  Object.assign(requestMsg, {
    statusCode: 200,
    payload: {
      username: 'edgeuser', token: 'sync-jwt-token-value', offlineVerifier: 'offline-verifier-hash', offlineVerifierVersion: 2,
      syncTokenExpiresAt: Date.now() + 3600000, mqttPassword: 'mqtt-secret', mqttBrokerUrl: 'mqtts://cloud.example.org:8883',
      userId: 77, claimed: [], skipped: [], installationUuid: localInstallationUuid,
      supportedSyncCapabilities: request.capabilities,
    },
  });
  const [handled, handleReject] = await executeFunctionNode(findNode(flows, 'al-link-handle-auth'), requestMsg, { flowStore, scope, warnings });
  assert.equal(handleReject, null, 'the auth response must be accepted: ' + JSON.stringify(handleReject && handleReject.payload));
  const [finalized, finalizeReject] = await executeFunctionNode(findNode(flows, 'al-link-finalize'), handled, {
    flowStore, scope, env: { DEVICE_EUI: 'AABBCCDDEEFF0011' },
  });
  assert.equal(finalizeReject, null, 'finalize must succeed: ' + JSON.stringify(finalizeReject && finalizeReject.payload));
  assert.ok(finalized);
  const db = new helper.Database('/data/db/farming.db');
  const rows = (sql) => new Promise((resolve, reject) => db.all(sql, [], (error, result) => (error ? reject(error) : resolve(result))));
  const link = (await rows("SELECT linked, server_url, cloud_user_id, gateway_device_eui, installation_uuid FROM sync_link_state WHERE peer_node='cloud'"))[0];
  const user = (await rows("SELECT auth_mode, server_url, cloud_user_id FROM users WHERE username='edgeuser'"))[0];
  await new Promise((resolve) => db.close(() => resolve()));
  cleanup();
  return { request, link, user, localInstallationUuid, warnings };
}

for (const profile of ['bcm2712', 'bcm2709']) {
  test(`${profile}: linking succeeds without the conditional irrigation helper and does not advertise conditional_irrigation_v1`, async () => {
    const out = await linkEndToEnd(profile, osiLibWithoutConditional);
    assert.equal(out.request.url, 'https://cloud.example.org/auth/local-sync');
    assert.equal(out.request.capabilities.includes('conditional_irrigation_v1'), false);
    assert.ok(out.request.capabilities.includes('linked_auth_sync_v1'));
    assert.ok(out.request.capabilities.includes('device_soil_depth_commands_v1'));
    assert.equal(out.link.linked, 1);
    assert.equal(out.link.server_url, 'https://cloud.example.org');
    assert.equal(String(out.link.cloud_user_id), '77');
    assert.equal(out.link.gateway_device_eui, 'AABBCCDDEEFF0011');
    assert.equal(out.link.installation_uuid, out.localInstallationUuid);
    assert.equal(out.user.auth_mode, 'server');
    assert.equal(Number(out.user.cloud_user_id), 77);
    assert.ok(out.warnings.some((message) => /conditional irrigation/i.test(message)), 'the missing helper is logged');
  });

  test(`${profile}: linking with the conditional irrigation helper advertises conditional_irrigation_v1`, async () => {
    const out = await linkEndToEnd(profile, osiLib);
    assert.ok(out.request.capabilities.includes('conditional_irrigation_v1'));
    assert.equal(out.link.linked, 1);
    assert.equal(out.link.gateway_device_eui, 'AABBCCDDEEFF0011');
  });
}

// #667: the remote commit can precede every local credential write. A retry
// must accept the authenticated response account rather than pinning the old ID.
for (const profile of ['bcm2712', 'bcm2709']) {
  test(`${profile}: relink after remote commit accepts the new account and retry converges`, async () => {
    const flows = readFlows(profile);
    const installationUuid = installationHelper.newInstallationUuid();
    const fixture = freshSeededDb((db) => {
      db.prepare("INSERT INTO users(id,username,password_hash,created_at,user_uuid,auth_mode,cloud_user_id,server_url) VALUES(1,'local','local-hash','now','local-uuid','server',11,'https://cloud.example.org')").run();
      db.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,'https://cloud.example.org','11','AABBCCDDEEFF0011',?,'now')").run(installationUuid);
      db.prepare('UPDATE installation_identity SET current_gateway_device_eui=?').run('AABBCCDDEEFF0011');
    }, installationUuid);
    const flowStore = new Map([
      ['al_local_username','local'], ['al_local_user_id',1],
      ['al_server_url','https://cloud.example.org'], ['al_action','link'],
      ['al_server_username','target'], ['al_server_password','fixture-password'],
      ['al_gateway_device_eui','AABBCCDDEEFF0011'], ['al_gateway_device_eui_confidence','authoritative'],
    ]);
    try {
      // First request reached the cloud and committed, but its reply was lost.
      const lost = await buildLinkAttempt(flows, flowStore, fixture.helper);
      await executeFunctionNode(findNode(flows,'al-link-clear-state'), lost, { flowStore, scope:{osiDb:fixture.helper,osiLib} });
      for (let retry=0; retry<2; retry++) {
        // Re-submit the same authenticated target. The server can reissue tokens.
        flowStore.set('al_local_username','local'); flowStore.set('al_local_user_id',1);
        flowStore.set('al_server_url','https://cloud.example.org'); flowStore.set('al_action','link');
        flowStore.set('al_server_username','target'); flowStore.set('al_server_password','fixture-password');
        flowStore.set('al_gateway_device_eui','AABBCCDDEEFF0011');
        const msg = await buildLinkAttempt(flows, flowStore, fixture.helper);
        msg.statusCode=200;
        msg.payload={ username:'target', userId:77, token:'fixture-token-'+retry,
          offlineVerifier:'fixture-verifier', offlineVerifierVersion:2, syncTokenExpiresAt:1900000000000,
          mqttPassword:'fixture-mqtt', mqttBrokerUrl:'wss://cloud.example.org/mqtt', installationUuid };
        const [accepted,rejected] = await executeFunctionNode(findNode(flows,'al-link-handle-auth'),msg,{flowStore,scope:{osiDb:fixture.helper,osiLib}});
        assert.equal(rejected,null,'a remotely committed account must pass: '+JSON.stringify(rejected?.payload));
        const [finalized,failed] = await executeFunctionNode(findNode(flows,'al-link-finalize'),accepted,{flowStore,scope:{osiDb:fixture.helper,osiLib}});
        assert.equal(failed,null,'relink must finalize: '+JSON.stringify(failed?.payload));
        assert.ok(finalized);
        const native = new DatabaseSync(fixture.dbPath);
        assert.equal(native.prepare('SELECT cloud_user_id FROM users WHERE id=1').get().cloud_user_id,77);
        assert.equal(native.prepare("SELECT cloud_user_id FROM sync_link_state WHERE peer_node='cloud'").get().cloud_user_id,'77');
        assert.equal(native.prepare('SELECT password_hash FROM users WHERE id=1').get().password_hash,'local-hash');
        native.close();
        await executeFunctionNode(findNode(flows,'al-link-clear-state'),finalized,{flowStore,scope:{osiDb:fixture.helper,osiLib}});
      }
    } finally { fixture.cleanup(); }
  });
}


function linkedConsistencyFixture() {
  const installationUuid = installationHelper.newInstallationUuid();
  const fixture = freshSeededDb(db => {
    db.prepare("INSERT INTO users(id,username,password_hash,created_at,user_uuid,auth_mode,cloud_user_id,server_url,server_sync_token) VALUES(1,'local','local-hash','now','local-uuid','server',11,'https://cloud.example.org','old-token')").run();
    db.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,updated_at) VALUES('cloud',1,'https://cloud.example.org','11','AABBCCDDEEFF0011',?,'now')").run(installationUuid);
    db.prepare('UPDATE installation_identity SET current_gateway_device_eui=?').run('AABBCCDDEEFF0011');
    db.exec("CREATE TABLE sync_history_dirty_keys(peer_node TEXT, row_key TEXT); INSERT INTO sync_history_dirty_keys VALUES('cloud','retained-history-key')");
  }, installationUuid);
  const flowStore = new Map([
    ['al_local_username','local'],['al_local_user_id',1],['al_action','link'],
    ['al_server_url','https://cloud.example.org'],['al_server_username','target'],
    ['al_server_password','fixture-password'],['al_gateway_device_eui','AABBCCDDEEFF0011'],
    ['al_gateway_device_eui_confidence','authoritative'],
  ]);
  const io = fixtureIo(flowStore);
  for (const key of ['server_host','mqtt_password','mqtt_broker_url','link_gateway_device_eui']) io.config.set('osi-server.cloud.'+key,'old-'+key);
  return {...fixture, installationUuid, flowStore, io, scope:{osiDb:fixture.helper,osiLib}};
}
function localSnapshot(f) {
  const db = new DatabaseSync(f.dbPath);
  try { return {
    user: {...db.prepare('SELECT * FROM users WHERE id=1').get()},
    peer: {...db.prepare("SELECT * FROM sync_link_state WHERE peer_node='cloud'").get()},
    dirty: db.prepare('SELECT * FROM sync_history_dirty_keys').all().map(row=>({...row})),
    config: Object.fromEntries(f.io.config),
  }; } finally { db.close(); }
}
async function acceptTarget(f,flows,msg) {
  msg.statusCode=200;
  msg.payload={username:'target',userId:77,token:'new-token',offlineVerifier:'fixture-verifier',offlineVerifierVersion:2,
    syncTokenExpiresAt:1900000000000,mqttPassword:'new-mqtt',mqttBrokerUrl:'wss://cloud.example.org/mqtt',installationUuid:f.installationUuid};
  const [accepted,rejected]=await executeFunctionNode(findNode(flows,'al-link-handle-auth'),msg,f);
  assert.equal(rejected,null,JSON.stringify(rejected?.payload));
  return accepted;
}

for (const profile of ['bcm2712','bcm2709']) {
  test(`${profile}: disconnect SQL failure leaves user, peer, dirty keys and MQTT unchanged`, async()=>{
    const f=linkedConsistencyFixture(); const flows=readFlows(profile);
    const before=localSnapshot(f);
    const db=new DatabaseSync(f.dbPath);
    db.exec("CREATE TRIGGER injected_disconnect_failure BEFORE UPDATE OF linked ON sync_link_state WHEN NEW.linked=0 BEGIN SELECT RAISE(ABORT,'injected disconnect failure'); END"); db.close();
    const msg={_unlinkAuth:{userId:1,username:'local'}};
    try {
      await executeFunctionNode(findNode(flows,'al-unlink-clear-mqtt'),msg,f);
      const [success,failure]=await executeFunctionNode(findNode(flows,'al-unlink-db'),msg,f);
      assert.equal(success,null); assert.ok(failure);
      assert.deepEqual(localSnapshot(f),before,'disconnect must roll back all local effects');
      assert.equal(f.io.files.has('/data/db/osi-account-link-config.json'),false);
    } finally { f.cleanup(); }
  });

  test(`${profile}: partial UCI failure rolls back SQL, restores credentials and permits a retry`, async()=>{
    const f=linkedConsistencyFixture(); const flows=readFlows(profile);
    const before=localSnapshot(f);
    const original=f.io.cp.execFileSync; let fail=true;
    f.io.cp.execFileSync=(command,args)=>{
      if(fail && args[0]==='commit') { fail=false; throw new Error('injected commit failure with secret argv'); }
      return original(command,args);
    };
    try {
      const msg=await acceptTarget(f,flows,await buildLinkAttempt(flows,f.flowStore,f.helper));
      const [success,failure]=await executeFunctionNode(findNode(flows,'al-link-finalize'),msg,f);
      assert.equal(success,null); assert.ok(failure);
      assert.doesNotMatch(JSON.stringify(failure.payload),/secret argv|new-mqtt/);
      await executeFunctionNode(findNode(flows,'al-link-clear-state'),msg,f);
      // Timestamp/attempt cleanup can change; account state and credentials cannot.
      const after=localSnapshot(f);
      assert.deepEqual(after.user,before.user); assert.deepEqual(after.config,before.config);
      assert.equal(after.peer.cloud_user_id,before.peer.cloud_user_id);
      assert.deepEqual(after.dirty,before.dirty);
      assert.equal(f.io.files.has('/data/db/osi-account-link-config.json'),false);
      const retry=await acceptTarget(f,flows,await buildLinkAttempt(flows,f.flowStore,f.helper));
      const [done,reject]=await executeFunctionNode(findNode(flows,'al-link-finalize'),retry,f);
      assert.equal(reject,null); assert.ok(done);
      assert.equal(localSnapshot(f).user.cloud_user_id,77);
    } finally { f.cleanup(); }
  });

  test(`${profile}: an active link blocks disconnect and a late response cannot overwrite disconnect`, async()=>{
    const f=linkedConsistencyFixture(); const flows=readFlows(profile);
    try {
      const msg=await buildLinkAttempt(flows,f.flowStore,f.helper);
      const before=localSnapshot(f);
      const [done,rejected]=await executeFunctionNode(findNode(flows,'al-unlink-db'),{_unlinkAuth:{userId:1,username:'local'}},f);
      assert.equal(done,null); assert.equal(rejected.statusCode,409);
      assert.deepEqual(localSnapshot(f),before);
      await executeFunctionNode(findNode(flows,'al-link-clear-state'),msg,f);
      const [unlinked,error]=await executeFunctionNode(findNode(flows,'al-unlink-db'),{_unlinkAuth:{userId:1,username:'local'}},f);
      assert.equal(error,null); assert.ok(unlinked);
      // Even a successful remote response from the abandoned request is stale.
      msg.statusCode=200; msg.payload={username:'target',userId:77};
      const [late,lateError]=await executeFunctionNode(findNode(flows,'al-link-handle-auth'),msg,f);
      assert.equal(late,null); assert.equal(lateError.payload.reason,'stale_link_attempt');
      const after=localSnapshot(f);
      assert.equal(after.user.auth_mode,'local'); assert.equal(after.peer.linked,0);
      assert.equal(after.user.password_hash,'local-hash'); assert.equal(after.dirty.length,0);
    } finally { f.cleanup(); }
  });

  test(`${profile}: request snapshots survive a second validation and shared-state cleanup`,async()=>{
    const f=linkedConsistencyFixture(); const flows=readFlows(profile);
    const crypto=require('node:crypto'); const secret='fixture-auth-secret';
    const payload=Buffer.from(JSON.stringify({userId:1,username:'local',exp:Date.now()+60000})).toString('base64url');
    const token=payload+'.'+crypto.createHmac('sha256',secret).update(payload).digest('base64url');
    const request=username=>({req:{headers:{authorization:'Bearer '+token}},payload:{serverUrl:'https://cloud.example.org',action:'link',username,password:username+'-password'}});
    const options={...f,env:{AUTH_TOKEN_SECRET:secret,DEVICE_EUI:'AABBCCDDEEFF0011',DEVICE_EUI_CONFIDENCE:'authoritative'},scope:{...f.scope,crypto,net:require('node:net'),urlLib:require('node:url')}};
    try {
      const [first]=await executeFunctionNode(findNode(flows,'al-link-validate'),request('first'),options);
      const [second]=await executeFunctionNode(findNode(flows,'al-link-validate'),request('second'),options);
      const [built,failed]=await executeFunctionNode(findNode(flows,'al-link-build-req'),first,options);
      assert.equal(failed,null); assert.equal(built.payload.username,'first'); assert.equal(built.payload.password,'first-password');
      assert.equal(second._alState.al_server_username,'second');
      await executeFunctionNode(findNode(flows,'al-link-clear-state'),second,options);
      assert.equal(built._alState.al_server_username,'first');
      const accepted=await acceptTarget(f,flows,built);
      f.flowStore.clear();
      const [done,error]=await executeFunctionNode(findNode(flows,'al-link-finalize'),accepted,options);
      assert.equal(error,null); assert.ok(done); assert.equal(localSnapshot(f).user.cloud_user_id,77);
    } finally { f.cleanup(); }
  });
}

test('interrupted config journals restore before commit and finish after commit; sync fails closed until recovery',async()=>{
  for(const committed of [false,true]) {
    const f=linkedConsistencyFixture(); const db=new f.helper.Database('/data/db/farming.db');
    const before=Object.fromEntries([...f.io.config].map(([k,v])=>[k.split('.').at(-1),v]));
    const after={server_host:'new-host',mqtt_password:'new-pass',mqtt_broker_url:'wss://cloud.example.org/mqtt',link_gateway_device_eui:'AABBCCDDEEFF0011'};
    const context={server_url:'https://cloud.example.org',cloud_user_id:'77',gateway_device_eui:'AABBCCDDEEFF0011',installation_uuid:f.installationUuid};
    const journal={version:1,before,after,marker:{kind:'link',username:'local',token:'new-token',context}};
    f.io.files.set('/data/db/osi-account-link-config.json',JSON.stringify(journal));
    // Simulate a power cut after UCI was committed and either side of DB COMMIT.
    for(const [key,value] of Object.entries(after)) f.io.config.set('osi-server.cloud.'+key,value);
    if(committed) await db.transaction(async tx=>{
      await tx.run("UPDATE users SET cloud_user_id=77,server_sync_token='new-token' WHERE id=1");
      await tx.run("UPDATE sync_link_state SET cloud_user_id='77' WHERE peer_node='cloud'");
    });
    try {
      assert.equal(installationHelper.gatewayWorkBlocked({fs:f.io.fs,warn(){}}),true);
      const result=await installationHelper.recoverAccountConfig(db,f.io);
      assert.equal(result.committed,committed);
      assert.deepEqual(Object.fromEntries([...f.io.config].map(([k,v])=>[k.split('.').at(-1),v])),committed?after:before);
      assert.equal(f.io.files.has('/data/db/osi-account-link-config.json'),false);
      assert.equal(installationHelper.gatewayWorkBlocked({fs:f.io.fs,warn(){}}),false);
    } finally { await db.close(); f.cleanup(); }
  }
});

test('failed config restoration retains the journal and blocks further remote work until recovery',async()=>{
  const f=linkedConsistencyFixture(); const flows=readFlows(); const original=f.io.cp.execFileSync;
  let failing=true;
  f.io.cp.execFileSync=(command,args)=>{if(failing && args[0]==='commit')throw new Error('unavailable');return original(command,args);};
  try {
    const msg=await acceptTarget(f,flows,await buildLinkAttempt(flows,f.flowStore,f.helper));
    const [done,failed]=await executeFunctionNode(findNode(flows,'al-link-finalize'),msg,f);
    assert.equal(done,null); assert.equal(failed.statusCode,503);
    assert.equal(f.io.files.has('/data/db/osi-account-link-config.json'),true);
    assert.equal(installationHelper.gatewayWorkBlocked({fs:f.io.fs,warn(){}}),true);
    const [remote,blocked]=await executeFunctionNode(findNode(flows,'al-link-build-req'),{authUserId:1,authUsername:'local'},f);
    assert.equal(remote,null); assert.ok(blocked);
    failing=false;
    const retry=await acceptTarget(f,flows,await buildLinkAttempt(flows,f.flowStore,f.helper));
    const [linked,error]=await executeFunctionNode(findNode(flows,'al-link-finalize'),retry,f);
    assert.equal(error,null); assert.ok(linked);
  } finally { f.cleanup(); }
});

test('identity sentinel appearing after the request blocks local finalization without adopting a candidate identity',async()=>{
  const f=linkedConsistencyFixture(); const flows=readFlows();
  try {
    const msg=await acceptTarget(f,flows,await buildLinkAttempt(flows,f.flowStore,f.helper));
    const before=localSnapshot(f); const exists=f.io.fs.existsSync;
    f.io.fs.existsSync=p=>p==='/var/run/osi-identity-restart.json'||exists(p);
    const [done,blocked]=await executeFunctionNode(findNode(flows,'al-link-finalize'),msg,f);
    assert.equal(done,null); assert.equal(blocked.statusCode,503);
    assert.deepEqual(localSnapshot(f),before);
    await executeFunctionNode(findNode(flows,'al-link-clear-state'),msg,f);
  } finally { f.cleanup(); }
});


test('a token refresh response captured before relink cannot replace the new account token',async()=>{
  const f=linkedConsistencyFixture(); const flows=readFlows();
  try {
    const [request]=[await executeFunctionNode(findNode(flows,'sync-refresh-build'),{},f)];
    assert.ok(request,'an expired or unbounded fixture token needs refresh');
    const link=await acceptTarget(f,flows,await buildLinkAttempt(flows,f.flowStore,f.helper));
    const [done,error]=await executeFunctionNode(findNode(flows,'al-link-finalize'),link,f);
    assert.equal(error,null); assert.ok(done);
    request.statusCode=200; request.payload={token:'late-old-account-token',syncTokenExpiresAt:1900000000000};
    await executeFunctionNode(findNode(flows,'sync-refresh-mark'),request,f);
    assert.equal(localSnapshot(f).user.server_sync_token,'new-token');
  } finally {f.cleanup();}
});


test('a new process can replace an abandoned durable attempt and reject its old nonce',async()=>{
  const f=linkedConsistencyFixture(); const flows=readFlows(); const db=new f.helper.Database('/data/db/farming.db');
  try {
    const old=await replicationHelper.beginLinkAttempt(db,{nonce:'abandoned-nonce',context:{server_url:'https://cloud.example.org',cloud_user_id:null,gateway_device_eui:'AABBCCDDEEFF0011',installation_uuid:f.installationUuid}});
    const request=await buildLinkAttempt(flows,f.flowStore,f.helper);
    assert.notEqual(request._alLinkAttemptNonce,old.nonce);
    const stale=await replicationHelper.validateLinkAttempt(db,{nonce:old.nonce,context:{...old.context,cloud_user_id:'77'}});
    assert.equal(stale.valid,false); assert.equal(stale.reason,'stale_link_attempt');
    await executeFunctionNode(findNode(flows,'al-link-clear-state'),request,f);
  } finally {await db.close();f.cleanup();}
});

test('configuration unavailable at preflight is refused before building a remote request',async()=>{
  const f=linkedConsistencyFixture(); const flows=readFlows();
  f.io.cp.execFileSync=()=>{throw Object.assign(new Error('missing configuration tool'),{code:'ENOENT'});};
  try {
    const [request,rejected]=await executeFunctionNode(findNode(flows,'al-link-build-req'),{authUserId:1,authUsername:'local'},f);
    assert.equal(request,null); assert.ok(rejected);
    assert.equal(localSnapshot(f).user.cloud_user_id,11);
    assert.equal(localSnapshot(f).peer.link_attempt_json,null);
  } finally {f.cleanup();}
});

test('boot recovery retains its journal when restart publication fails and retries it',async()=>{
  const f=linkedConsistencyFixture();
  const before=Object.fromEntries([...f.io.config].map(([k,v])=>[k.split('.').at(-1),v]));
  f.io.files.set('/data/db/osi-account-link-config.json',JSON.stringify({version:1,before,after:before,marker:{kind:'link',username:'local',token:'uncommitted-token',context:{}}}));
  const rename=f.io.fs.renameSync;let fail=true;const warnings=[];
  f.io.fs.renameSync=(a,b)=>{if(fail && b.startsWith('/var/run/'))throw new Error('restart directory unavailable');rename(a,b);};
  try {
    await installationHelper.recoverAccountConfigOnStart({osiDb:f.helper,...f.io,warn:text=>warnings.push(text)});
    assert.equal(f.io.files.has('/data/db/osi-account-link-config.json'),true);
    assert.equal(warnings.length,1);
    fail=false;
    await installationHelper.recoverAccountConfigOnStart({osiDb:f.helper,...f.io,warn:text=>warnings.push(text)});
    assert.equal(f.io.files.has('/data/db/osi-account-link-config.json'),false);
    const request=JSON.parse(f.io.files.get('/var/run/osi-node-red-restart-requests/account_link-recovery.json'));
    assert.equal(request.reason,'account_link');assert.equal(request.delaySeconds,10);
  } finally {f.cleanup();}
});

console.log('account-link legacy-cloud tolerance behavioral tests defined; run with `node --test` to execute.');
