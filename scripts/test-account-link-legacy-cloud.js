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
const bcryptjsPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/bcryptjs'
);

const bcryptjs = require(bcryptjsPath);
const installationHelper = require(installationHelperPath);
const osiLib = {
  require(name) {
    if (name === 'installation') return { ok: true, value: installationHelper };
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
  installation_uuid TEXT NOT NULL
)`;
const SYNC_LINK_STATE_SQL = `CREATE TABLE sync_link_state (
  peer_node TEXT PRIMARY KEY,
  linked INTEGER NOT NULL DEFAULT 0,
  server_url TEXT,
  cloud_user_id TEXT,
  gateway_device_eui TEXT,
  updated_at TEXT NOT NULL,
  installation_uuid TEXT
)`;
// The finalizer backfills the gateway identity on these two tables inside the
// same transaction as the account/link writes.  Keep only the columns touched
// by that production node; this harness deliberately does not duplicate the
// full seed schema.
const IDENTITY_BACKFILL_TABLES_SQL = `CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
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

function readFlows() {
  return JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
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
      scope
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
      if (key === 'fs') return fs;
      return undefined;
    },
    set() {},
  };
  const nodeApi = {
    error() {},
    warn(message) {
      if (warnings) warnings.push(message);
    },
    status() {},
  };
  return fn(msg, nodeApi, flowApi, envApi, noopStore, globalApi, () => undefined, () => {});
}

test('legacy cloud (no installationUuid) is tolerated: link succeeds, warns once, keeps the local installation identity, and stores offlineVerifierVersion as returned', async () => {
  const flows = readFlows();
  const handleAuthNode = findNode(flows, 'al-link-handle-auth');
  const localInstallationUuid = installationHelper.newInstallationUuid();
  const flowStore = new Map();
  flowStore.set('al_installation_uuid', localInstallationUuid);
  flowStore.set('al_local_username', 'edgeuser');
  flowStore.set('al_server_url', 'https://legacy-cloud.example.org');

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

  const [continueMsg, rejectMsg] = await executeFunctionNode(handleAuthNode, legacyResponseMsg, {
    flowStore,
    scope: { osiLib },
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
    flowStore.get('al_offline_verifier_version'),
    1,
    'offlineVerifierVersion must be stored as returned by the cloud (1), not forced/rejected'
  );

  // --- 'Finalize linked account state' must also accept this v1 / no-remote-identity state ---
  const finalizeNode = findNode(flows, 'al-link-finalize');
  flowStore.set('al_gateway_device_eui', 'AABBCCDDEEFF0011');
  const { helper, cleanup } = freshSeededDb((native) => {
    native
      .prepare('INSERT INTO users (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)')
      .run('edgeuser', 'irrelevant-local-hash', new Date().toISOString(), 'admin');
  }, localInstallationUuid);
  try {
    const [finalizeContinue, finalizeReject] = await executeFunctionNode(finalizeNode, {}, {
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

  const [continueMsg, rejectMsg] = await executeFunctionNode(handleAuthNode, mismatchedResponseMsg, {
    flowStore,
    scope: { osiLib },
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

console.log('account-link legacy-cloud tolerance behavioral tests defined; run with `node --test` to execute.');
