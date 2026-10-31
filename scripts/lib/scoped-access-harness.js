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

function profilePaths(profile = 'bcm2712') {
  const name = String(profile).trim();
  if (!['bcm2712', 'bcm2709'].includes(name)) throw new Error(`unsupported profile: ${name}`);
  const filesRoot = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${name}/files/usr/share`);
  return {
    flowsPath: path.join(filesRoot, 'flows.json'),
    nodeRedModules: path.join(filesRoot, 'node-red'),
  };
}

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

function captureDbOutcome(db, method, sql, params, decision) {
  if (decision.kind === 'synthetic_busy') {
    const error = new Error('SQLITE_BUSY: database is locked');
    error.code = 'SQLITE_BUSY';
    return {
      kind: 'synthetic_busy', operationCount: 0, value: undefined,
      error,
    };
  }
  if (decision.kind !== 'execute') throw new Error('unknown DB gate outcome');
  try {
    return {
      kind: 'completed_operation', operationCount: 1,
      value: db.prepare(sql)[method](...params), error: null,
    };
  } catch (error) {
    return { kind: 'completed_operation', operationCount: 1, value: undefined, error };
  }
}

function facadeDb(db, dbCallGate) {
  function invoke(method, sql, params, callback) {
    const decision = dbCallGate
      ? dbCallGate.select({ method, sql, params })
      : { kind: 'execute', hold: false };
    if (dbCallGate && dbCallGate.rawStart) dbCallGate.rawStart(decision);
    const capture = () => captureDbOutcome(db, method, sql, params, decision);
    const outcome = dbCallGate && dbCallGate.withCallScope
      ? dbCallGate.withCallScope(decision.callId, capture)
      : capture();
    const delivery = dbCallGate && dbCallGate.deliver
      ? dbCallGate.deliver(decision, outcome, { method, sql, params })
      : Promise.resolve(outcome);
    if (callback) {
      delivery.then((captured) => {
        if (captured.error) {
          if (dbCallGate && dbCallGate.errorDelivered) dbCallGate.errorDelivered(decision, captured.error, 'facade_callback');
          callback(captured.error);
        }
        else if (method === 'run') callback.call(captured.value, null);
        else callback(null, captured.value);
      }, (error) => {
        if (dbCallGate && dbCallGate.errorDelivered) dbCallGate.errorDelivered(decision, error, 'facade_callback_rejection');
        callback(error);
      });
      return undefined;
    }
    return delivery.then((captured) => {
      if (captured.error) {
        if (dbCallGate && dbCallGate.errorDelivered) dbCallGate.errorDelivered(decision, captured.error, 'facade_promise_rejection');
        throw captured.error;
      }
      return captured.value;
    }, (error) => {
      if (dbCallGate && dbCallGate.errorDelivered) dbCallGate.errorDelivered(decision, error, 'facade_promise_rejection');
      throw error;
    });
  }
  return {
    all(sql, params, callback) {
      const args = normalizeDbArgs(params, callback);
      return invoke('all', sql, args.params, args.callback);
    },
    get(sql, params, callback) {
      const args = normalizeDbArgs(params, callback);
      return invoke('get', sql, args.params, args.callback);
    },
    run(sql, params, callback) {
      const args = normalizeDbArgs(params, callback);
      return invoke('run', sql, args.params, args.callback);
    },
    close(callback) {
      // Every function-node `new Database()` is a separate live handle on the
      // Pi. The in-memory harness shares one handle, so per-node close is a
      // no-op and the test closes the backing DatabaseSync explicitly.
      const decision = dbCallGate
        ? dbCallGate.select({ method: 'close', sql: '', params: [] })
        : { kind: 'execute', hold: false };
      if (decision.kind !== 'execute') throw new Error('close gate must be success-only');
      const outcome = { kind: 'completed_operation', operationCount: 0, value: undefined, error: null };
      if (dbCallGate && dbCallGate.rawStart) dbCallGate.rawStart(decision);
      const delivery = dbCallGate && dbCallGate.deliver
        ? dbCallGate.deliver(decision, outcome, { method: 'close', sql: '', params: [] })
        : Promise.resolve(outcome);
      if (callback) {
        delivery.then(() => callback(), callback);
        return undefined;
      }
      return delivery.then(() => undefined);
    },
    async transaction(fn) {
      // Matches the production osiDb.Database facade's promise-based
      // db.transaction(async (tx) => {...}) used by osi-command-ledger,
      // osi-device-commands, and the STREGA cancel/dedupe paths.
      db.exec('BEGIN IMMEDIATE');
      if (dbCallGate && dbCallGate.transactionEvent) dbCallGate.transactionEvent('begin');
      try {
        const result = await fn(this);
        db.exec('COMMIT');
        if (dbCallGate && dbCallGate.transactionEvent) dbCallGate.transactionEvent('commit');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        if (dbCallGate && dbCallGate.transactionEvent) dbCallGate.transactionEvent('rollback', error);
        throw error;
      }
    },
  };
}

// osi-lib's own registry (NAME_TO_PATH) is the source of truth for the names a function node
// may osiLib.require(), e.g. 'history-sync' -> osi-history-sync-helper; the short table keeps the
// harness-only aliases.
function osiLibRegistry(nodeRedModules) {
  try { return require(path.join(nodeRedModules, 'osi-lib', 'index.js')).NAME_TO_PATH || {}; }
  catch (_) { return {}; }
}

function moduleByName(name, nodeRedModules = NODE_RED_MODULES) {
  const directory = {
    scope: 'osi-scope-helper',
    journal: 'osi-journal',
    'osi-db-helper': 'osi-db-helper',
    'osi-command-ledger': 'osi-command-ledger',
    'osi-valve-control': 'osi-valve-control',
    'osi-irrigation-policy': 'osi-irrigation-policy',
  }[name] || osiLibRegistry(nodeRedModules)[name] || `osi-${name}`;
  const modulePath = path.join(nodeRedModules, directory, 'index.js');
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
    flowStore: suppliedFlowStore,
    globals = {},
    db,
    dbCallGate,
    osiLibModules = {},
    libOverrides = {},
    nodeRedModules = NODE_RED_MODULES,
  } = options;
  const errors = [];
  const warnings = [];
  const flowStore = suppliedFlowStore === undefined
    ? new Map(Object.entries(flowState))
    : suppliedFlowStore;
  if (!(flowStore instanceof Map)) throw new TypeError('flowStore must be a Map');
  const globalStore = new Map();
  const databaseFacade = facadeDb(db, dbCallGate);
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
            : moduleByName(name, nodeRedModules));
        return value
          ? { ok: true, value }
          : { ok: false, error: `unregistered in harness: ${name}` };
      },
    },
    crypto,
    bcrypt: require(path.join(nodeRedModules, 'node_modules/bcryptjs')),
    httpLib: http,
    httpsLib: https,
    osiHistory: require(path.join(nodeRedModules, 'osi-history-helper', 'index.js')),
    HR: require(path.join(nodeRedModules, 'osi-history-router', 'index.js')),
  };
  Object.assign(providedLibs, libOverrides);
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

function seedScopedDb(valveEui = 'VALVE1') {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  const fixtureValveEui = String(valveEui).replace(/'/g, "''");
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
      ('${fixtureValveEui}', 'Valve', 'STREGA_VALVE', 2, 1, '2026-01-01', '2026-01-01'),
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
  captureDbOutcome,
  facadeDb,
  loadNode,
  makeAuthHeader,
  moduleByName,
  profilePaths,
  seedScopedDb,
};
