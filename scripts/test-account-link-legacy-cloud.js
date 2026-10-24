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
      flowStore.get('al_offline_verifier_version'),
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

console.log('account-link legacy-cloud tolerance behavioral tests defined; run with `node --test` to execute.');
