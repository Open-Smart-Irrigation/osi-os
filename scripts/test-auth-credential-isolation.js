#!/usr/bin/env node
'use strict';

// Behavioral RED/GREEN harness for the auth chain credential-isolation fix.
//
// Extracts the real function-node bodies from the canonical flows.json
// (auth-register-func, auth-login-func, auth-process-result, auth-db-insert,
// auth-db-query) and runs them with vm against a real (temp-file) SQLite
// database via the actual osi-db-helper module. This proves three things
// end to end, against whatever code is currently checked in:
//
//   1. Two interleaved requests sharing one Node-RED tab's flow context must
//      not be able to read each other's username/password. Reproduced for
//      both the login path (attacker impersonation) and the register path
//      (wrong account gets created).
//   2. A same-username scoped-bootstrap race must not let the loser (whose
//      own INSERT ... WHERE NOT EXISTS affected zero rows) see success just
//      because the follow-up SELECT finds the winner's identically-named row.
//   3. In scoped mode, a disabled account must be rejected at login before a
//      token is issued; scoped-off login must stay unaffected.
//
// Run: node --test scripts/test-auth-credential-isolation.js

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
const bcryptjsPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/bcryptjs'
);

const bcryptjs = require(bcryptjsPath);
const cryptoModule = require('node:crypto');

// Real users table shape, copied from database/seed-blank.sql so the test
// exercises the actual production column set (SELECT * relies on it).
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
, role TEXT NOT NULL DEFAULT 'researcher' CHECK (role IN ('admin','researcher','viewer')), disabled_at TEXT, sync_version INTEGER NOT NULL DEFAULT 0)`;

function readFlows() {
  return JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
}

function findNode(flows, id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return node;
}

// --- Fake `sqlite3` driver over node:sqlite's DatabaseSync, adapted from
// scripts/test-osi-db-helper-read-snapshot.js's adapter. Every open is
// redirected to a fixed temp file regardless of the filename the node func
// requests (the real func hardcodes '/data/db/farming.db'), so the test
// never touches any real path.
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

// Seeds a fresh temp sqlite file with the real users table shape and returns
// { dbPath, helper, cleanup }. `helper` is a freshly-loaded osi-db-helper
// module instance (own singleton connection) pointed at dbPath.
function freshSeededDb(seedFn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-auth-harness-'));
  const dbPath = path.join(tempDir, 'farming.db');
  const native = new DatabaseSync(dbPath);
  native.exec('PRAGMA journal_mode=WAL;');
  native.exec(USERS_TABLE_SQL + ';');
  if (seedFn) seedFn(native);
  native.close();
  const helper = loadOsiDbHelperFresh(dbPath);
  return {
    dbPath,
    helper,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

// Runs one function-node's `func` body with a vm sandbox, node-RED-shaped
// (msg, node, flow, env, context, global, get, set) signature. `flowStore` is
// caller-supplied and persists across calls so tests can model a single
// Node-RED tab's shared, mutable flow context across "concurrent" requests.
async function executeFunctionNode(node, msg, { flowStore, env = {}, scope = {} } = {}) {
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
  const nodeApi = { error() {}, warn() {}, status() {} };
  return fn(msg, nodeApi, flowApi, envApi, noopStore, noopStore, () => undefined, () => {});
}

const AUTH_ENV = { AUTH_TOKEN_SECRET: 'harness-secret-value-not-a-real-secret' };

test('login credential isolation: attacker cannot ride a victim request\'s password across the shared flow context', async () => {
  const REAL_PASSWORD = 'CorrectHorseBatteryStaple1';
  const passwordHash = bcryptjs.hashSync(REAL_PASSWORD, 10);
  const { helper, cleanup } = freshSeededDb((native) => {
    native
      .prepare(
        'INSERT INTO users (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)'
      )
      .run('alice', passwordHash, new Date().toISOString(), 'researcher');
  });
  try {
    const flows = readFlows();
    const loginNode = findNode(flows, 'auth-login-func');
    const queryNode = findNode(flows, 'auth-db-query');
    const resultNode = findNode(flows, 'auth-process-result');
    const flowStore = new Map();
    const dbScope = { osiDb: helper };
    const resultScope = { bcrypt: bcryptjs, crypto: cryptoModule };

    // Step 1: attacker's request starts first, with the right username but a
    // wrong guessed password. Its login-func write lands first.
    const attackerAfterLogin = (
      await executeFunctionNode(loginNode, { payload: { username: 'alice', password: 'wrong-guess-1' } }, {
        flowStore,
        env: AUTH_ENV,
      })
    )[0];
    assert.ok(attackerAfterLogin, 'attacker login-func should continue to output 0');

    // Step 2: victim's real request interleaves before the attacker's
    // request reaches Process Result, overwriting the shared flow context
    // with the victim's real credentials.
    const victimAfterLogin = (
      await executeFunctionNode(loginNode, { payload: { username: 'alice', password: REAL_PASSWORD } }, {
        flowStore,
        env: AUTH_ENV,
      })
    )[0];
    assert.ok(victimAfterLogin, 'victim login-func should continue to output 0');

    // Step 3: attacker's own db-query (msg.lookup is msg-scoped already).
    const attackerAfterQuery = (
      await executeFunctionNode(queryNode, attackerAfterLogin, { flowStore, env: AUTH_ENV, scope: dbScope })
    )[0];
    assert.ok(attackerAfterQuery, 'attacker db-query should continue to output 0');

    // Step 4: attacker's Process Result. With the shared flow context this
    // must NOT succeed, even though the flow context currently holds the
    // victim's real password.
    const attackerResult = await executeFunctionNode(resultNode, attackerAfterQuery, {
      flowStore,
      env: AUTH_ENV,
      scope: resultScope,
    });
    // Login's Process Result always answers on output 1 (output 0 is only
    // used by the register path, to continue on to Insert User) -- so the
    // meaningful assertion is on the response's statusCode/payload shape,
    // not which output index carried it.
    const [, attackerRejection] = attackerResult;

    assert.ok(attackerRejection, 'attacker request should receive a response message');
    assert.equal(
      attackerRejection.statusCode,
      401,
      'CREDENTIAL CROSS-CONTAMINATION: attacker request must not receive a token by riding the ' +
        "victim's password through shared flow context"
    );
    assert.ok(
      !(attackerRejection.payload && attackerRejection.payload.token),
      'attacker request must not receive a token'
    );
  } finally {
    cleanup();
  }
});

test('register credential isolation: one request must not create an account under another interleaved request\'s identity', async () => {
  const { helper, cleanup } = freshSeededDb();
  try {
    const flows = readFlows();
    const registerNode = findNode(flows, 'auth-register-func');
    const queryNode = findNode(flows, 'auth-db-query');
    const resultNode = findNode(flows, 'auth-process-result');
    const flowStore = new Map();
    const dbScope = { osiDb: helper };
    const resultScope = { bcrypt: bcryptjs, crypto: cryptoModule };

    // Step 1: Alice's register request lands first.
    const aliceAfterRegister = (
      await executeFunctionNode(
        registerNode,
        { payload: { username: 'alice_reg', password: 'alicePassword1' } },
        { flowStore, env: AUTH_ENV }
      )
    )[0];
    assert.ok(aliceAfterRegister, 'alice register-func should continue to output 0');

    // Step 2: Bob's register request interleaves before Alice's reaches
    // Process Result, overwriting the shared flow context.
    const bobAfterRegister = (
      await executeFunctionNode(
        registerNode,
        { payload: { username: 'bob_reg', password: 'bobPassword1' } },
        { flowStore, env: AUTH_ENV }
      )
    )[0];
    assert.ok(bobAfterRegister, 'bob register-func should continue to output 0');

    // Step 3: Alice's own db-query (msg.lookup is msg-scoped already: looks
    // up 'alice_reg', finds nothing, continues).
    const aliceAfterQuery = (
      await executeFunctionNode(queryNode, aliceAfterRegister, { flowStore, env: AUTH_ENV, scope: dbScope })
    )[0];
    assert.ok(aliceAfterQuery, 'alice db-query should continue to output 0');

    // Step 4: Alice's Process Result must build an insert for ALICE's own
    // username/password, not Bob's (currently sitting in shared flow state).
    const aliceResult = await executeFunctionNode(resultNode, aliceAfterQuery, {
      flowStore,
      env: AUTH_ENV,
      scope: resultScope,
    });
    const [aliceContinue] = aliceResult;
    assert.ok(aliceContinue, 'alice process-result should continue to output 0 (insert path)');
    assert.equal(
      aliceContinue.userInsert && aliceContinue.userInsert.username,
      'alice_reg',
      "CREDENTIAL CROSS-CONTAMINATION: alice's registration must not create an account under " +
        "bob's interleaved username"
    );
  } finally {
    cleanup();
  }
});

test('scoped bootstrap race: a same-username loser whose own INSERT affected zero rows must not see success', async () => {
  const { helper, cleanup } = freshSeededDb();
  try {
    const flows = readFlows();
    const insertNode = findNode(flows, 'auth-db-insert');
    const scopedEnv = Object.assign({ OSI_SCOPED_ACCESS: '1' }, AUTH_ENV);
    const dbScope = { osiDb: helper };
    const now = new Date().toISOString();

    const winnerResult = await executeFunctionNode(
      insertNode,
      { userInsert: { username: 'admin', passwordHash: 'winner-hash', createdAt: now } },
      { flowStore: new Map(), env: scopedEnv, scope: dbScope }
    );
    assert.ok(winnerResult[0], 'first (winning) bootstrap insert should continue to output 0');
    assert.equal(winnerResult[1], null, 'winner should not receive a rejection');

    const loserResult = await executeFunctionNode(
      insertNode,
      { userInsert: { username: 'admin', passwordHash: 'loser-hash', createdAt: now } },
      { flowStore: new Map(), env: scopedEnv, scope: dbScope }
    );
    const [loserSuccess, loserRejection] = loserResult;

    assert.equal(
      loserSuccess,
      null,
      'BOOTSTRAP RACE: a same-username loser whose own INSERT affected zero rows must not be ' +
        "forwarded as success just because the winner's identically-named row exists"
    );
    assert.ok(loserRejection, 'loser should receive a rejection message');
    assert.equal(loserRejection.statusCode, 403);
    assert.equal(
      loserRejection.payload && loserRejection.payload.message,
      'Public registration is closed. Ask an admin to create your account.'
    );

    // Exactly one row must exist, and it must be the winner's, never
    // overwritten by the loser.
    const rows = helper
      ? await new Promise((resolve, reject) => {
          const db = new helper.Database('/data/db/farming.db');
          db.all('SELECT username, password_hash FROM users', [], (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
        })
      : [];
    assert.equal(rows.length, 1, 'exactly one users row must exist after the bootstrap race');
    assert.equal(rows[0].username, 'admin');
    assert.equal(rows[0].password_hash, 'winner-hash');
  } finally {
    cleanup();
  }
});

test('scoped-mode login rejects a disabled account before issuing a token; scoped-off login is unaffected', async () => {
  const PASSWORD = 'GaryValidPassword1';
  const passwordHash = bcryptjs.hashSync(PASSWORD, 10);
  const { helper, cleanup } = freshSeededDb((native) => {
    native
      .prepare(
        'INSERT INTO users (username, password_hash, created_at, role, disabled_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('gary', passwordHash, new Date().toISOString(), 'researcher', '2026-01-01T00:00:00.000Z');
  });
  try {
    const flows = readFlows();
    const loginNode = findNode(flows, 'auth-login-func');
    const queryNode = findNode(flows, 'auth-db-query');
    const resultNode = findNode(flows, 'auth-process-result');
    const dbScope = { osiDb: helper };
    const resultScope = { bcrypt: bcryptjs, crypto: cryptoModule };

    async function attemptLogin(env) {
      const flowStore = new Map();
      const afterLogin = (
        await executeFunctionNode(loginNode, { payload: { username: 'gary', password: PASSWORD } }, {
          flowStore,
          env,
        })
      )[0];
      assert.ok(afterLogin, 'login-func should continue to output 0');
      const afterQuery = (
        await executeFunctionNode(queryNode, afterLogin, { flowStore, env, scope: dbScope })
      )[0];
      assert.ok(afterQuery, 'db-query should continue to output 0');
      return executeFunctionNode(resultNode, afterQuery, { flowStore, env, scope: resultScope });
    }

    // Login's Process Result always answers on output 1; output 0 is only
    // used by the register path.
    const scopedResult = await attemptLogin(Object.assign({ OSI_SCOPED_ACCESS: '1' }, AUTH_ENV));
    const [, scopedRejection] = scopedResult;
    assert.ok(scopedRejection, 'disabled account should receive a response message in scoped mode');
    assert.notEqual(
      scopedRejection.statusCode,
      200,
      'DISABLED ACCOUNT LOGIN: a disabled account must not receive statusCode 200 in scoped mode'
    );
    assert.ok(
      !(scopedRejection.payload && scopedRejection.payload.token),
      'DISABLED ACCOUNT LOGIN: a disabled account must not receive a token in scoped mode'
    );
    assert.match(String(scopedRejection.payload && scopedRejection.payload.message), /disabled/i);

    const scopedOffResult = await attemptLogin(Object.assign({}, AUTH_ENV));
    const [, scopedOffRejection] = scopedOffResult;
    assert.ok(
      scopedOffRejection && scopedOffRejection.payload && scopedOffRejection.payload.token,
      'scoped-off login must stay unaffected: a disabled account can still log in when scoped access is off'
    );
    assert.equal(scopedOffRejection.statusCode, 200);
  } finally {
    cleanup();
  }
});
