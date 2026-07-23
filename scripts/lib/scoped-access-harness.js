'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
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

function facadeDb(db) {
  return {
    all(sql, params, callback) {
      const args = normalizeDbArgs(params, callback);
      try {
        const rows = db.prepare(sql).all(...args.params);
        if (args.callback) {
          args.callback(null, rows);
          return undefined;
        }
        return Promise.resolve(rows);
      } catch (error) {
        if (args.callback) {
          args.callback(error);
          return undefined;
        }
        return Promise.reject(error);
      }
    },
    get(sql, params, callback) {
      const args = normalizeDbArgs(params, callback);
      try {
        const row = db.prepare(sql).get(...args.params);
        if (args.callback) {
          args.callback(null, row);
          return undefined;
        }
        return Promise.resolve(row);
      } catch (error) {
        if (args.callback) {
          args.callback(error);
          return undefined;
        }
        return Promise.reject(error);
      }
    },
    run(sql, params, callback) {
      const args = normalizeDbArgs(params, callback);
      try {
        const result = db.prepare(sql).run(...args.params);
        if (args.callback) {
          args.callback.call(result, null);
          return undefined;
        }
        return Promise.resolve(result);
      } catch (error) {
        if (args.callback) {
          args.callback(error);
          return undefined;
        }
        return Promise.reject(error);
      }
    },
    close(callback) {
      // Every function-node `new Database()` is a separate live handle on the
      // Pi. The in-memory harness shares one handle, so per-node close is a
      // no-op and the test closes the backing DatabaseSync explicitly.
      if (callback) callback();
      return Promise.resolve();
    },
  };
}

function moduleByName(name) {
  const directory = {
    scope: 'osi-scope-helper',
    journal: 'osi-journal',
    'osi-db-helper': 'osi-db-helper',
  }[name] || `osi-${name}`;
  const modulePath = path.join(NODE_RED_MODULES, directory, 'index.js');
  if (!fs.existsSync(modulePath)) return null;
  return require(modulePath);
}

function makeAuthHeader({
  userId,
  username,
  secret = 'scoped-access-test-secret',
  expiresAt = Date.now() + 60000,
}) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    username,
    exp: expiresAt,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `Bearer ${payload}.${signature}`;
}

async function executeFunction(node, options) {
  const {
    msg,
    env = {},
    flowState = {},
    globals = {},
    db,
    osiLibModules = {},
  } = options;
  const errors = [];
  const warnings = [];
  const flowStore = new Map(Object.entries(flowState));
  const globalStore = new Map();
  const databaseFacade = facadeDb(db);
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
      get: (key) => globalStore.has(key) ? globalStore.get(key) :
        (Object.prototype.hasOwnProperty.call(globals, key) ? globals[key] : ({
        fs,
        os: require('node:os'),
        cp: require('node:child_process'),
      })[key]),
      set: (key, value) => globalStore.set(key, value),
    },
    env: { get: (key) => env[key] },
    context: { get: () => undefined, set: () => {} },
  };
  const providedLibs = {
    osiDb: { Database: function Database() { return databaseFacade; } },
    osiLib: {
      require(name) {
        const value = osiLibModules[name] ||
          (name === 'osi-db-helper'
            ? { Database: function Database() { return databaseFacade; } }
            : moduleByName(name));
        return value
          ? { ok: true, value }
          : { ok: false, error: `unregistered in harness: ${name}` };
      },
    },
    crypto,
    httpLib: http,
    httpsLib: https,
    osiHistory: require(path.join(NODE_RED_MODULES, 'osi-history-helper', 'index.js')),
    HR: require(path.join(NODE_RED_MODULES, 'osi-history-router', 'index.js')),
  };
  const names = Object.keys(sandbox);
  const values = Object.values(sandbox);
  for (const lib of node.libs || []) {
    names.push(lib.var);
    values.push(providedLibs[lib.var]);
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

function seedScopedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  db.exec(`
    INSERT INTO users (
      username, password_hash, created_at, user_uuid, role, sync_version
    ) VALUES
      ('admin1', 'h', '2026-01-01', 'u-admin', 'admin', 1),
      ('res1', 'h', '2026-01-01', 'u-res1', 'researcher', 1),
      ('view1', 'h', '2026-01-01', 'u-view1', 'viewer', 1);

    INSERT INTO irrigation_zones (
      name, user_id, zone_uuid, timezone, scheduling_mode
    ) VALUES
      ('Z One', 2, 'z-1', 'UTC', 'local'),
      ('Z Two', 1, 'z-2', 'UTC', 'local');

    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('DENDRO1', 'Tree 1', 'DRAGINO_LSN50', 2, 1, '2026-01-01', '2026-01-01'),
      ('WX1', 'Weather', 'SENSECAP_S2120', 1, 2, '2026-01-01', '2026-01-01'),
      ('VALVE1', 'Valve', 'STREGA_VALVE', 2, 1, '2026-01-01', '2026-01-01'),
      ('DENDRO2', 'Tree 2', 'DRAGINO_LSN50', 1, 2, '2026-01-01', '2026-01-01');

    INSERT INTO journal_plots (
      plot_uuid, plot_code, name, zone_uuid, owner_user_uuid
    ) VALUES
      ('p-1', 'P1', 'Plot 1', 'z-1', 'u-res1'),
      ('p-2', 'P2', 'Plot 2', 'z-2', 'u-admin');

    INSERT INTO user_zone_assignments (
      assignment_uuid, user_uuid, zone_uuid, created_at
    ) VALUES
      ('g-1', 'u-res1', 'z-1', '2026-01-01'),
      ('g-2', 'u-view1', 'z-1', '2026-01-01'),
      ('g-3', 'u-res1', 'z-2', '2026-01-01');

    INSERT INTO zone_daily_recommendations (
      zone_id, date, irrigation_action, action_reasoning, computed_at
    ) VALUES (
      2, '2026-01-02', 'maintain', 'fixture', '2026-01-02T12:00:00Z'
    );
  `);
  return db;
}

module.exports = {
  executeFunction,
  facadeDb,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
};
