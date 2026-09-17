#!/usr/bin/env node
'use strict';

// Behavioral RED/GREEN harness for the F130 sync-token refresh window fix
// (2026-08-31 outage: a gateway offline for the last 24h of its cloud sync
// token's life never refreshed it, and lost its cloud link once the token
// expired).
//
// Old behavior ('Build Sync Token Refresh' / sync-refresh-build): refresh
// only when the stored expiry is within a fixed 24h. A token issued with a
// long lifetime (e.g. 30 days) that goes unrefreshed for 29 days still has
// >24h left and is skipped right up to the wire -- one more day offline and
// the gateway loses its link.
//
// New behavior: refresh when less than half of the token's own lifetime
// remains, computed from users.server_sync_token_expires_at and the token's
// own 'iat' claim (decoded locally, no signature check -- this only gates a
// local refresh-or-skip decision). When iat can't be decoded, fall back to
// refreshing inside 3.5 days of expiry.
//
// This harness extracts the real function-node bodies from the canonical
// flows.json and runs them with vm, matching the pattern established in
// scripts/test-account-link-legacy-cloud.js and
// scripts/test-auth-credential-isolation.js, so it proves behavior against
// whatever code is currently checked in -- not a paraphrase of it.
//
// Run: node --test scripts/test-sync-token-refresh-window.js

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

// Real users table shape, copied from database/seed-blank.sql (same source
// scripts/test-account-link-legacy-cloud.js and
// scripts/test-auth-credential-isolation.js use).
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

function readFlows() {
  return JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
}

function findNode(flows, id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`missing node ${id}`);
  return node;
}

// base64url-encode a JS object as a JWT-shaped middle segment (no signature
// needed: the node under test never verifies one, only decodes the payload).
function base64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeToken(payload) {
  return 'header.' + base64url(payload) + '.signature';
}

// --- Fake `sqlite3` driver over node:sqlite's DatabaseSync, copied from
// scripts/test-account-link-legacy-cloud.js. Every open is redirected to a
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

// Seeds a fresh temp sqlite file with the real users table shape, containing
// exactly one auth_mode='server' row, and returns { helper, cleanup }.
function freshSeededDb({ serverUrl, syncToken, syncTokenExpiresAt }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sync-token-refresh-harness-'));
  const dbPath = path.join(tempDir, 'farming.db');
  const native = new DatabaseSync(dbPath);
  native.exec('PRAGMA journal_mode=WAL;');
  native.exec(USERS_TABLE_SQL + ';');
  native
    .prepare(
      `INSERT INTO users (
         username, password_hash, created_at, role, auth_mode,
         server_url, server_sync_token, server_sync_token_expires_at
       ) VALUES (?, ?, ?, ?, 'server', ?, ?, ?)`
    )
    .run(
      'edgeuser',
      'unused-local-hash',
      new Date().toISOString(),
      'admin',
      serverUrl,
      syncToken,
      syncTokenExpiresAt
    );
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
// scripts/test-account-link-legacy-cloud.js. Both nodes under test declare
// outputs:1, so the resolved value IS the single output message (or null),
// not an array to unwrap.
async function executeFunctionNode(node, msg, { flowStore, env = {}, scope = {}, warnings, logs } = {}) {
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
    get() {
      return undefined;
    },
    set() {},
  };
  const nodeApi = {
    error() {},
    warn(message) {
      if (warnings) warnings.push(message);
    },
    log(message) {
      if (logs) logs.push(message);
    },
    status() {},
  };
  return fn(msg, nodeApi, flowApi, envApi, noopStore, globalApi, () => undefined, () => {});
}

const DAY_MS = 24 * 60 * 60 * 1000;

test('more than half the token lifetime remains: skip (no refresh request built)', async () => {
  const flows = readFlows();
  const buildNode = findNode(flows, 'sync-refresh-build');
  const now = Date.now();
  // 10-day token, issued 1 day ago -> 9 days (90%) remaining, well over half.
  const iatMs = now - 1 * DAY_MS;
  const expiresAt = iatMs + 10 * DAY_MS;
  const token = makeToken({ sub: 'edgeuser', iat: Math.floor(iatMs / 1000) });

  const { helper, cleanup } = freshSeededDb({
    serverUrl: 'https://cloud.example.org',
    syncToken: token,
    syncTokenExpiresAt: expiresAt,
  });
  try {
    const result = await executeFunctionNode(
      buildNode,
      {},
      { flowStore: new Map(), scope: { osiDb: helper } }
    );
    assert.equal(result, null, 'more than half the lifetime remaining must skip the refresh');
  } finally {
    cleanup();
  }
});

test('less than half the token lifetime remains: refresh is built (F130 fix)', async () => {
  const flows = readFlows();
  const buildNode = findNode(flows, 'sync-refresh-build');
  const now = Date.now();
  // 10-day token, issued 8 days ago -> 2 days (20%) remaining: under 24h
  // fixed threshold this is skipped (the F130 bug); under the half-lifetime
  // rule (5 days) it must refresh.
  const iatMs = now - 8 * DAY_MS;
  const expiresAt = iatMs + 10 * DAY_MS;
  const token = makeToken({ sub: 'edgeuser', iat: Math.floor(iatMs / 1000) });

  const { helper, cleanup } = freshSeededDb({
    serverUrl: 'https://cloud.example.org',
    syncToken: token,
    syncTokenExpiresAt: expiresAt,
  });
  try {
    const result = await executeFunctionNode(
      buildNode,
      {},
      { flowStore: new Map(), scope: { osiDb: helper } }
    );
    assert.ok(result, 'less than half the lifetime remaining must build a refresh request');
    assert.equal(result.url, 'https://cloud.example.org/auth/refresh-sync');
    assert.equal(result.method, 'POST');
    assert.equal(result.headers.Authorization, 'Bearer ' + token);
  } finally {
    cleanup();
  }
});

test('unknown iat (undecodable token): falls back to the 3.5-day-before-expiry rule', async () => {
  const flows = readFlows();
  const buildNode = findNode(flows, 'sync-refresh-build');
  const now = Date.now();
  const opaqueToken = 'opaque-static-sync-token-no-jwt-structure';

  // 4 days left, no iat available -> still outside the 3.5-day fallback window: skip.
  {
    const { helper, cleanup } = freshSeededDb({
      serverUrl: 'https://cloud.example.org',
      syncToken: opaqueToken,
      syncTokenExpiresAt: now + 4 * DAY_MS,
    });
    try {
      const result = await executeFunctionNode(
        buildNode,
        {},
        { flowStore: new Map(), scope: { osiDb: helper } }
      );
      assert.equal(result, null, '4 days left with unknown iat must still skip (outside the 3.5-day fallback)');
    } finally {
      cleanup();
    }
  }

  // 3 days left, no iat available -> inside the 3.5-day fallback window: refresh.
  {
    const { helper, cleanup } = freshSeededDb({
      serverUrl: 'https://cloud.example.org',
      syncToken: opaqueToken,
      syncTokenExpiresAt: now + 3 * DAY_MS,
    });
    try {
      const result = await executeFunctionNode(
        buildNode,
        {},
        { flowStore: new Map(), scope: { osiDb: helper } }
      );
      assert.ok(result, '3 days left with unknown iat must refresh via the 3.5-day fallback rule');
      assert.equal(result.url, 'https://cloud.example.org/auth/refresh-sync');
    } finally {
      cleanup();
    }
  }
});

test('Store Refreshed Sync Token logs the new expiry (ISO) on a successful refresh', async () => {
  const flows = readFlows();
  const markNode = findNode(flows, 'sync-refresh-mark');
  const { helper, cleanup } = freshSeededDb({
    serverUrl: 'https://cloud.example.org',
    syncToken: 'old-token',
    syncTokenExpiresAt: Date.now() - DAY_MS,
  });
  try {
    const newExpiresAt = Date.now() + 30 * DAY_MS;
    const logs = [];
    const responseMsg = {
      statusCode: 200,
      payload: { token: 'new-token-value', syncTokenExpiresAt: newExpiresAt },
      _refreshServerUrl: 'https://cloud.example.org',
    };
    const result = await executeFunctionNode(markNode, responseMsg, {
      flowStore: new Map(),
      scope: { osiDb: helper },
      logs,
    });
    assert.equal(result, null, 'Store Refreshed Sync Token has no wired output');
    assert.equal(logs.length, 1, 'exactly one node.log line expected on a successful refresh (got: ' + JSON.stringify(logs) + ')');
    assert.match(logs[0], /new expiry/i);
    assert.equal(logs[0], 'Sync token refreshed; new expiry ' + new Date(newExpiresAt).toISOString());
  } finally {
    cleanup();
  }
});

console.log('sync-token refresh window (F130) behavioral tests defined; run with `node --test` to execute.');
