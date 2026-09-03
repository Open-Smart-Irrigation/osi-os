'use strict';
/*
 * Test harness for executing a flows.json function node in-process against a
 * real in-memory SQLite database.
 *
 * Ported from the source branch's scripts/lib/scoped-access-harness.js and adapted to
 * this branch: there is no scoped-access schema here (no users.role, no
 * user_zone_assignments, no journal_plots), so the fixture seeds only what
 * this branch's seed-blank.sql actually defines. Renamed accordingly -- the
 * "scoped access" name would be actively misleading on this line.
 *
 * The `libs` a node declares are bound lazily: only the modules a node under
 * test actually asks for are resolved, so a helper that is absent here never
 * breaks an unrelated test at import time.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_FLOWS = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const NODE_RED_MODULES = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red'
);

function loadNode(nodeId, flowsPath = DEFAULT_FLOWS) {
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const node = flows.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`node not found: ${nodeId}`);
  return node;
}

function normalizeDbArgs(params, callback) {
  if (typeof params === 'function') return { params: [], callback: params };
  return { params: params || [], callback };
}

// Mirrors the production osiDb.Database facade: node-style callbacks when a
// callback is supplied, promises otherwise, over one shared DatabaseSync.
function facadeDb(db) {
  const settle = (run) => (sql, params, callback) => {
    const args = normalizeDbArgs(params, callback);
    try {
      const value = run(sql, args.params);
      if (args.callback) {
        args.callback.call(value, null, value);
        return undefined;
      }
      return Promise.resolve(value);
    } catch (error) {
      if (args.callback) {
        args.callback(error);
        return undefined;
      }
      return Promise.reject(error);
    }
  };
  const facade = {
    all: settle((sql, params) => db.prepare(sql).all(...params)),
    get: settle((sql, params) => db.prepare(sql).get(...params)),
    run: settle((sql, params) => db.prepare(sql).run(...params)),
    close(callback) {
      // Each function node opens its own handle on a real gateway. The harness
      // shares one, so per-node close is a no-op; the test closes the backing
      // DatabaseSync itself.
      if (callback) callback();
      return Promise.resolve();
    },
    async transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(facade);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return facade;
}

function moduleByName(name) {
  const directory = {
    journal: 'osi-journal',
    'osi-db-helper': 'osi-db-helper',
    'osi-command-ledger': 'osi-command-ledger',
    'history-sync': 'osi-history-sync-helper',
    'history-router': 'osi-history-router',
    'dendro-analytics': 'osi-dendro-analytics',
    'zone-commands': 'osi-zone-commands',
    'zone-env': 'osi-zone-env',
    'device-writer': 'osi-device-writer',
    'uc512-normalize': 'osi-uc512-normalize',
    'lsn50-normalize': 'osi-lsn50-normalize',
    'sdi12-normalize': 'osi-sdi12-normalize',
    'sdi12-reassemble': 'osi-sdi12-reassemble',
    'sdi12-recipe': 'osi-sdi12-recipe',
    'sdi12-commissioning': 'osi-sdi12-commissioning',
    'osi-valve-control': 'osi-valve-control',
    'osi-system-settings': 'osi-system-settings',
  }[name] || `osi-${name}`;
  const modulePath = path.join(NODE_RED_MODULES, directory, 'index.js');
  if (!fs.existsSync(modulePath)) return null;
  return require(modulePath); // eslint-disable-line global-require
}

async function executeFunction(node, options) {
  const {
    msg,
    env = {},
    flowState = {},
    globals = {},
    db,
    osiLibModules = {},
    libOverrides = {},
  } = options;
  const errors = [];
  const warnings = [];
  const flowStore = new Map(Object.entries(flowState));
  const globalStore = new Map();
  const databaseFacade = facadeDb(db);
  const builtinGlobals = {
    fs,
    os: require('node:os'),
    cp: require('node:child_process'),
  };
  const sandbox = {
    msg,
    node: {
      error: (message) => errors.push(String(message)),
      warn: (message) => warnings.push(String(message)),
      log: () => {},
      status: () => {},
    },
    flow: {
      get: (key) => flowStore.get(key),
      set: (key, value) => flowStore.set(key, value),
    },
    global: {
      get: (key) => {
        if (globalStore.has(key)) return globalStore.get(key);
        if (Object.prototype.hasOwnProperty.call(globals, key)) return globals[key];
        return builtinGlobals[key];
      },
      set: (key, value) => globalStore.set(key, value),
    },
    env: { get: (key) => env[key] },
    context: { get: () => undefined, set: () => {} },
  };
  // Lazy: only the libs a node under test declares are ever resolved.
  const lazyLibs = {
    osiDb: () => ({ Database: function Database() { return databaseFacade; } }),
    osiLib: () => ({
      require(name) {
        const value = osiLibModules[name]
          || (name === 'osi-db-helper'
            ? { Database: function Database() { return databaseFacade; } }
            : moduleByName(name));
        return value ? { ok: true, value } : { ok: false, error: `unregistered in harness: ${name}` };
      },
    }),
    crypto: () => crypto,
    httpLib: () => require('node:http'),
    httpsLib: () => require('node:https'),
    chirpstack: () => moduleByName('chirpstack-helper'),
    chameleon: () => moduleByName('chameleon-helper'),
    dendro: () => moduleByName('dendro-helper'),
    osiCloudHttp: () => moduleByName('cloud-http'),
    osiHistory: () => moduleByName('history-helper'),
    HR: () => moduleByName('history-router'),
  };
  const names = Object.keys(sandbox);
  const values = Object.values(sandbox);
  for (const lib of node.libs || []) {
    names.push(lib.var);
    if (Object.prototype.hasOwnProperty.call(libOverrides, lib.var)) {
      values.push(libOverrides[lib.var]);
    } else if (lazyLibs[lib.var]) {
      values.push(lazyLibs[lib.var]());
    } else {
      values.push(moduleByName(lib.module.replace(/^osi-/, '')));
    }
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, node.func);
  const result = await fn(...values);
  return {
    result,
    errors,
    warnings,
    flowState: Object.fromEntries(flowStore),
  };
}

// Builds the Bearer token shape this edge's auth nodes verify: a base64url
// payload of { userId, username, exp } plus an HMAC-SHA256 signature over it.
function makeAuthHeader({
  userId,
  username,
  secret = 'scoped-access-test-secret',
  expiresAt = Date.now() + 60000,
}) {
  const payload = Buffer.from(JSON.stringify({ userId, username, exp: expiresAt })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `Bearer ${payload}.${signature}`;
}

// A fresh in-memory database on this branch's seed, with the minimum fixture
// rows the flow nodes under test expect (a user id 1 to own devices, and two
// zones). Deliberately does NOT seed scoped-access or journal-plot tables:
// this branch's seed-blank.sql does not define them.
function seedTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  db.exec(`
    INSERT INTO users (username, password_hash, created_at, user_uuid) VALUES
      ('admin1', 'h', '2026-01-01', 'u-admin'),
      ('res1',   'h', '2026-01-01', 'u-res1'),
      ('view1',  'h', '2026-01-01', 'u-view1');

    INSERT INTO irrigation_zones (name, user_id, zone_uuid, timezone, scheduling_mode) VALUES
      ('Z One', 2, 'z-1', 'UTC', 'local'),
      ('Z Two', 1, 'z-2', 'UTC', 'local');

    INSERT INTO devices (deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at) VALUES
      ('DENDRO1', 'Tree 1', 'DRAGINO_LSN50',  2, 1, '2026-01-01', '2026-01-01'),
      ('WX1',     'Weather', 'SENSECAP_S2120', 1, 2, '2026-01-01', '2026-01-01'),
      ('VALVE1',  'Valve',   'STREGA_VALVE',   2, 1, '2026-01-01', '2026-01-01'),
      ('DENDRO2', 'Tree 2', 'DRAGINO_LSN50',  1, 2, '2026-01-01', '2026-01-01');
  `);
  return db;
}

module.exports = {
  executeFunction,
  facadeDb,
  loadNode,
  makeAuthHeader,
  seedTestDb,
};
