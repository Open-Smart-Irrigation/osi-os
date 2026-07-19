#!/usr/bin/env node
'use strict';
// test-sync-delivery-fail-closed - executable fail-closed regression harness
// for the OSI OS sync delivery consumers (Train A stop-loss plan,
// docs/superpowers/plans/2026-07-15-sync-delivery-stop-loss.md).
//
// Compiles the SHIPPED `func` text of specific Node-RED function nodes
// straight out of the canonical flows.json and runs it against a fake
// callback-style osiDb.Database (all/run/close; throws on .prepare access)
// plus minimal flow/env/node/global facades matching the real Node-RED
// function-node sandbox scope (msg, node, flow, global, env, context, plus
// any npm-module `libs` the node declares).
//
// Usage:
//   node scripts/test-sync-delivery-fail-closed.js [--section delivery|ack|commands|all]
//
// Sections:
//   delivery  sync-outbox-mark + sync-bootstrap-mark (Task 2 scope; GREEN after the fix)
//   ack       command-ack-mark-delivered + command-ack-build-batch dedup (later slice; RED by design)
//   commands  sync-pending-split + reject-indefinite-open + work-request-status-apply (later slice; RED by design)
//   all       everything (default)
//
// Exit 0 only when every case in the requested section(s) passes. Prints a
// per-case PASS/FAIL line and a final summary; non-zero exit on any failure.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const CANONICAL_FLOWS = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

const SECTIONS = ['delivery', 'ack', 'commands'];

// ---------------------------------------------------------------------------
// Node compilation
// ---------------------------------------------------------------------------

function loadFlows() {
  const raw = fs.readFileSync(CANONICAL_FLOWS, 'utf8');
  const flows = JSON.parse(raw);
  assert.ok(Array.isArray(flows), 'canonical flows.json is not an array');
  return flows;
}

const FLOWS = loadFlows();

// The real Node-RED function-node sandbox scope, plus whatever npm-module
// `libs` vars the node declares (see scripts/osi-flows-json-editing skill).
const SANDBOX_NAMES = ['msg', 'node', 'flow', 'global', 'env', 'context'];

function compile(nodeId) {
  const node = FLOWS.find((candidate) => candidate && candidate.id === nodeId);
  assert.ok(node && node.type === 'function', 'missing function node ' + nodeId);
  const libVars = (node.libs || []).map((entry) => entry.var);
  const names = SANDBOX_NAMES.concat(libVars);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, node.func);
  return { fn, node, libVars };
}

// ---------------------------------------------------------------------------
// Fake osiDb.Database - callback-style all/run/close, throws on .prepare
// access so a test cannot drift toward assuming a different runtime contract
// than the shipped osi-db-helper facade.
// ---------------------------------------------------------------------------

function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let cur = '';
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (inStr) {
      cur += c;
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; strCh = c; cur += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter((s) => s.length);
}

class FakeDatabase {
  constructor(seed = {}) {
    this.tables = {};
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = new Map(
        Object.entries(rows).map(([key, row]) => [String(key), Object.assign({}, row)]),
      );
    }
    this.calls = [];
    this.closedCount = 0;
  }

  get prepare() {
    throw new Error('FakeDatabase.prepare accessed: shipped flow code must use callback-style run/all/close only');
  }

  _table(name) {
    if (!this.tables[name]) this.tables[name] = new Map();
    return this.tables[name];
  }

  all(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    this.calls.push({ op: 'all', sql, params: params || [] });
    let rows;
    try {
      rows = this._select(sql, params || []);
    } catch (e) {
      cb(e);
      return;
    }
    cb(null, rows);
  }

  run(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    this.calls.push({ op: 'run', sql, params: params || [] });
    let info;
    try {
      info = this._mutate(sql, params || []) || {};
    } catch (e) {
      cb(e);
      return;
    }
    // Real sqlite3 binds `this` on the callback to the statement/run result
    // (e.g. `this.changes`); some shipped nodes (work-request-status-apply)
    // depend on that binding, so reproduce it here.
    cb.call({ changes: info.changes || 0, lastID: info.lastID || 0 }, null);
  }

  close(cb) {
    this.closedCount += 1;
    if (cb) cb();
  }

  // -- SELECT dispatch (only the specific templates these nodes issue) ------
  _select(sql) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM users WHERE server_url')) {
      const rows = Array.from(this._table('users').values())
        .filter((r) => r.server_url)
        .sort((a, b) => {
          const la = String(a.server_linked_at || '');
          const lb = String(b.server_linked_at || '');
          if (la !== lb) return la > lb ? -1 : 1;
          return Number(b.id || 0) - Number(a.id || 0);
        });
      return rows.slice(0, 1).map((r) => ({ server_url: r.server_url, server_sync_token: r.server_sync_token }));
    }
    if (s.includes('FROM command_ack_outbox WHERE delivered_at IS NULL')) {
      const rows = Array.from(this._table('command_ack_outbox').values())
        .filter((r) => !r.delivered_at)
        .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
      return rows.slice(0, 50).map((r) => ({ id: r.id, payload_json: r.payload_json }));
    }
    throw new Error('FakeDatabase: unrecognized SELECT: ' + sql);
  }

  // -- mutation dispatch: generic-enough UPDATE/INSERT interpreter for the
  // small set of statement shapes these consumer nodes issue (SET col=expr,...
  // WHERE col IN (...) | col = val; single hardcoded sync_cursor upsert). ----
  _mutate(sql, params) {
    const s = sql.trim();
    let pi = 0;
    const nextParam = () => params[pi++];

    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { changes: 0 };

    if (/^INSERT INTO sync_cursor/i.test(s)) {
      const value = nextParam();
      const table = this._table('sync_cursor');
      const row = table.get('cloud') || { peer_node: 'cloud' };
      row.last_full_backfill_at = value;
      table.set('cloud', row);
      return { changes: 1 };
    }

    const m = /^UPDATE\s+(\w+)\s+SET\s+(.*?)\s+WHERE\s+(.*)$/is.exec(s);
    if (!m) throw new Error('FakeDatabase: unrecognized mutation: ' + sql);
    const [, tableName, setClause, whereClause] = m;
    const table = this._table(tableName);

    // Resolve SET assignments first - placeholders are consumed in textual
    // left-to-right order, and SET always precedes WHERE in these queries.
    const assignments = splitTopLevel(setClause, ',').map((part) => {
      const eq = part.indexOf('=');
      const col = part.slice(0, eq).trim();
      const rawVal = part.slice(eq + 1).trim();
      const incMatch = /^([\w.]+)\s*\+\s*(\d+)$/.exec(rawVal);
      if (incMatch && incMatch[1].toLowerCase() === col.toLowerCase()) {
        return { col, op: 'increment', amount: Number(incMatch[2]) };
      }
      if (/^NULL$/i.test(rawVal)) return { col, op: 'set', value: null };
      if (rawVal === '?') return { col, op: 'set', value: nextParam() };
      if (/^'.*'$/.test(rawVal)) return { col, op: 'set', value: rawVal.slice(1, -1).replace(/''/g, "'") };
      return { col, op: 'set', value: rawVal };
    });

    const where = whereClause.trim();
    const whereIn = /^([\w.]+)\s+IN\s*\(([^)]*)\)$/i.exec(where);
    const whereEq = /^([\w.]+)\s*=\s*(.+)$/i.exec(where);
    let matchKeys;
    if (whereIn) {
      matchKeys = splitTopLevel(whereIn[2], ',').map((tok) => {
        tok = tok.trim();
        if (tok === '?') return String(nextParam());
        if (/^'.*'$/.test(tok)) return tok.slice(1, -1).replace(/''/g, "'");
        return tok;
      });
    } else if (whereEq) {
      let tok = whereEq[2].trim();
      let val;
      if (tok === '?') val = nextParam();
      else if (/^'.*'$/.test(tok)) val = tok.slice(1, -1).replace(/''/g, "'");
      else val = tok;
      matchKeys = [String(val)];
    } else {
      throw new Error('FakeDatabase: unrecognized WHERE clause: ' + whereClause);
    }

    let changes = 0;
    for (const key of matchKeys) {
      const row = table.get(String(key));
      if (!row) continue; // matches real SQL: UPDATE affects 0 rows for an absent key
      changes += 1;
      for (const assignment of assignments) {
        if (assignment.op === 'increment') {
          row[assignment.col] = (Number(row[assignment.col]) || 0) + assignment.amount;
        } else {
          row[assignment.col] = assignment.value;
        }
      }
      table.set(String(key), row);
    }
    return { changes };
  }
}

// ---------------------------------------------------------------------------
// Facades
// ---------------------------------------------------------------------------

function makeFlowFacade(initialState) {
  const store = new Map(Object.entries(initialState || {}));
  return {
    get(key) { return store.has(key) ? store.get(key) : undefined; },
    set(key, value) { store.set(key, value); },
    dump() { return Object.fromEntries(store.entries()); },
  };
}

function makeEnvFacade(vars) {
  const v = vars || {};
  return { get(key) { return Object.prototype.hasOwnProperty.call(v, key) ? v[key] : undefined; } };
}

function makeNodeFacade() {
  const warnings = [];
  const errors = [];
  return {
    warn(m) { warnings.push(m); },
    error(m) { errors.push(m); },
    log() { /* no-op */ },
    _warnings: warnings,
    _errors: errors,
  };
}

function makeGlobalFacade(overrides) {
  const fsFacade = (overrides && overrides.fs) || {
    existsSync: () => false,
    readFileSync: () => { throw new Error('fake fs: no file'); },
  };
  const store = { fs: fsFacade, os: (overrides && overrides.os) || {}, cp: (overrides && overrides.cp) || {} };
  return { get(key) { return store[key]; } };
}

// ---------------------------------------------------------------------------
// executeFlowFunction(nodeId, msg, options) -> Promise<{ result, sql, flowState, errors }>
// ---------------------------------------------------------------------------

async function executeFlowFunction(nodeId, msg, options = {}) {
  const { fn, node, libVars } = compile(nodeId);
  const db = options.db || new FakeDatabase(options.seed || {});
  const flowFacade = makeFlowFacade(options.flowState);
  const envFacade = makeEnvFacade(options.env);
  const nodeFacade = makeNodeFacade();
  const globalFacade = makeGlobalFacade(options.global);
  const contextFacade = { get() { return undefined; }, set() {} };

  const libFacades = {
    osiDb: { Database: function osiDbDatabase() { return db; } },
    osiCloudHttp: {
      requestJsonIpv4: async () => {
        throw new Error('osiCloudHttp.requestJsonIpv4 is not exercised by this harness');
      },
    },
  };

  const args = [msg, nodeFacade, flowFacade, globalFacade, envFacade, contextFacade];
  for (const v of libVars) args.push(libFacades[v]);

  const result = await fn(...args);

  return {
    result,
    sql: db.calls,
    db,
    flowState: flowFacade.dump(),
    warnings: nodeFacade._warnings,
    errors: nodeFacade._errors,
    node,
  };
}

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------

const registry = { delivery: [], ack: [], commands: [] };

function test(section, name, fn) {
  registry[section].push({ name, fn });
}

async function runSection(section) {
  const cases = registry[section];
  let pass = 0;
  const failures = [];
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log('  PASS [' + section + '] ' + c.name);
    } catch (e) {
      failures.push({ name: c.name, error: e });
      console.log('  FAIL [' + section + '] ' + c.name);
      console.log('        ' + (e && e.message ? e.message : e));
    }
  }
  return { total: cases.length, pass, failures };
}

module.exports = { executeFlowFunction, FakeDatabase, test, registry };

// ---------------------------------------------------------------------------
// Section: delivery - sync-outbox-mark + sync-bootstrap-mark (Task 2 scope)
// ---------------------------------------------------------------------------

function registerDeliveryTests() {
  test('delivery', 'outbox: statusCode=0 transport failure keeps events pending, no delivered_at, timestamp unchanged', async () => {
    const seed = {
      sync_outbox: {
        'event-a': { event_uuid: 'event-a', delivered_at: null, retry_count: 0 },
        'event-b': { event_uuid: 'event-b', delivered_at: null, retry_count: 0 },
      },
    };
    const flowState = { sync_state: { lastOutboxDeliverySuccessAt: '2020-01-01T00:00:00.000Z' } };
    const msg = {
      statusCode: 0,
      error: { message: 'ETIMEDOUT', code: 'ETIMEDOUT', cloudRestIpv4: null },
      payload: { error: 'Cloud REST IPv4 request failed', detail: 'ETIMEDOUT', code: 'ETIMEDOUT' },
      _syncEventIds: ['event-a', 'event-b'],
    };
    const { sql, flowState: outState, db } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState });
    assert.ok(!sql.some((c) => /SET delivered_at/.test(c.sql)), 'no SQL may set delivered_at on transport failure');
    assert.strictEqual(db.tables.sync_outbox.get('event-a').delivered_at, null, 'event-a stays pending');
    assert.strictEqual(db.tables.sync_outbox.get('event-b').delivered_at, null, 'event-b stays pending');
    assert.strictEqual(
      outState.sync_state.lastOutboxDeliverySuccessAt,
      '2020-01-01T00:00:00.000Z',
      'success timestamp unchanged on transport failure',
    );
  });

  function bootstrapFlowStateFixture() {
    return {
      sync_state: {
        gatewayMigrationPendingBootstrap: true,
        gatewayMigrationPaused: true,
        gatewayMigrationPreviousGatewayDeviceEuis: ['0011223344556677'],
        gatewayMigrationLastTo: 'AABBCCDDEEFF0011',
      },
    };
  }

  const bootstrapFailureCases = [
    ['statusCode=0 (transport failure)', { statusCode: 0, payload: { error: 'Cloud REST IPv4 request failed', detail: 'ETIMEDOUT', code: 'ETIMEDOUT' } }],
    ['missing statusCode', { payload: {} }],
    ['HTTP 500', { statusCode: 500, payload: { message: 'internal error' } }],
    ['HTTP 200 with success:false', { statusCode: 200, payload: { success: false, error: 'validation_failed' } }],
  ];
  for (const [label, msgFixture] of bootstrapFailureCases) {
    test('delivery', 'bootstrap: ' + label + ' must not advance cursor/migration state', async () => {
      const seed = { sync_cursor: {}, users: {} };
      const flowState = bootstrapFlowStateFixture();
      const msg = Object.assign({ _syncLinkedUserId: 0 }, msgFixture);
      const { flowState: outState, sql } = await executeFlowFunction('sync-bootstrap-mark', msg, { seed, flowState });
      assert.ok(!sql.some((c) => /INSERT INTO sync_cursor/i.test(c.sql)), label + ': must not write sync_cursor');
      assert.strictEqual(outState.sync_state.gatewayMigrationPendingBootstrap, true, label + ': migration-pending flag must remain true');
      assert.strictEqual(outState.sync_state.gatewayMigrationPaused, true, label + ': migration-paused flag must remain true');
      assert.strictEqual(outState.sync_state.lastBootstrapSuccessAt, undefined, label + ': lastBootstrapSuccessAt must not be recorded');
      assert.notStrictEqual(
        (outState.sync_state.gatewayMigrationLastResult || {}).status,
        'bootstrapped',
        label + ': must not record a bootstrapped migration result',
      );
    });
  }

  test('delivery', 'bootstrap: HTTP 200 + success:true advances cursor, token, and migration state', async () => {
    const seed = { sync_cursor: {}, users: { 7: { id: 7, server_url: 'https://cloud.example', server_sync_token: null } } };
    const flowState = bootstrapFlowStateFixture();
    const msg = {
      statusCode: 200,
      _syncLinkedUserId: 7,
      payload: {
        success: true,
        applied: 3,
        skipped: 0,
        token: 'aaa.bbb.ccc',
        gatewayMigration: {
          migrated: true,
          currentGatewayDeviceEui: 'AABBCCDDEEFF0011',
          previousGatewayDeviceEuis: ['0011223344556677'],
        },
      },
    };
    const { db, flowState: outState } = await executeFlowFunction('sync-bootstrap-mark', msg, {
      seed,
      flowState,
      env: { DEVICE_EUI: 'AABBCCDDEEFF0011' },
    });
    assert.ok(db.tables.sync_cursor.get('cloud').last_full_backfill_at, 'success writes the sync cursor');
    assert.ok(outState.sync_state.lastBootstrapSuccessAt, 'lastBootstrapSuccessAt recorded');
    assert.strictEqual(outState.sync_state.gatewayMigrationPendingBootstrap, false, 'migration-pending flag clears');
    assert.strictEqual(outState.sync_state.gatewayMigrationPaused, false, 'migration-paused flag clears');
  });

  test('delivery', 'outbox: mixed APPLIED/RETRYABLE_ERROR/unknown only advances the applied event', async () => {
    const seed = {
      sync_outbox: {
        'ev-applied': { event_uuid: 'ev-applied', delivered_at: null, retry_count: 0 },
        'ev-retryable': { event_uuid: 'ev-retryable', delivered_at: null, retry_count: 0 },
        'ev-unknown': { event_uuid: 'ev-unknown', delivered_at: null, retry_count: 0 },
      },
    };
    const msg = {
      statusCode: 200,
      _syncEventIds: ['ev-applied', 'ev-retryable', 'ev-unknown'],
      payload: {
        results: [
          { eventUuid: 'ev-applied', status: 'APPLIED' },
          { eventUuid: 'ev-retryable', status: 'RETRYABLE_ERROR' },
          { eventUuid: 'ev-unknown', status: 'SOMETHING_WEIRD' },
        ],
      },
    };
    const { db, flowState } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.ok(db.tables.sync_outbox.get('ev-applied').delivered_at, 'applied event gets delivered_at');
    assert.ok(!db.tables.sync_outbox.get('ev-retryable').delivered_at, 'retryable event stays pending');
    assert.ok(!db.tables.sync_outbox.get('ev-unknown').delivered_at, 'unknown-status event stays pending');
    assert.strictEqual(db.tables.sync_outbox.get('ev-retryable').retry_count, 1, 'retryable event gets a retry bump');
    assert.strictEqual(db.tables.sync_outbox.get('ev-unknown').retry_count, 1, 'unknown-status event gets retry metadata too');
    assert.ok(flowState.sync_state.lastOutboxDeliverySuccessAt, 'success timestamp advances: at least one terminal result landed');
  });

  test('delivery', 'outbox: duplicate-identical result for one event stays pending with bounded protocol error', async () => {
    const seed = { sync_outbox: { 'ev-dup': { event_uuid: 'ev-dup', delivered_at: null, retry_count: 0 } } };
    const msg = {
      statusCode: 200,
      _syncEventIds: ['ev-dup'],
      payload: { results: [{ eventUuid: 'ev-dup', status: 'APPLIED' }, { eventUuid: 'ev-dup', status: 'APPLIED' }] },
    };
    const { db, flowState } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.ok(!db.tables.sync_outbox.get('ev-dup').delivered_at, 'duplicate-identical result must not deliver the event');
    assert.ok(flowState.sync_state.lastError, 'a bounded protocol error must be recorded');
    assert.ok(
      /protocol_response_duplicate_result:ev-dup/.test(flowState.sync_state.lastError.message),
      'error names the duplicate event id',
    );
  });

  test('delivery', 'outbox: duplicate-conflicting result for one event stays pending with bounded protocol error', async () => {
    const seed = { sync_outbox: { 'ev-dup2': { event_uuid: 'ev-dup2', delivered_at: null, retry_count: 0 } } };
    const msg = {
      statusCode: 200,
      _syncEventIds: ['ev-dup2'],
      payload: {
        results: [
          { eventUuid: 'ev-dup2', status: 'APPLIED' },
          { eventUuid: 'ev-dup2', status: 'REJECTED', reason: 'conflict' },
        ],
      },
    };
    const { db, flowState } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.ok(!db.tables.sync_outbox.get('ev-dup2').delivered_at, 'conflicting duplicate must not deliver');
    assert.ok(!db.tables.sync_outbox.get('ev-dup2').rejected_at, 'conflicting duplicate must not reject either');
    assert.ok(/protocol_response_duplicate_result:ev-dup2/.test(flowState.sync_state.lastError.message));
  });

  test('delivery', 'outbox: unrequested result identity is a protocol error and touches no row', async () => {
    const seed = {
      sync_outbox: {
        'ev-real': { event_uuid: 'ev-real', delivered_at: null, retry_count: 0 },
        'ev-other': { event_uuid: 'ev-other', delivered_at: null, retry_count: 0 },
      },
    };
    const msg = {
      statusCode: 200,
      _syncEventIds: ['ev-real'],
      payload: {
        results: [
          { eventUuid: 'ev-real', status: 'APPLIED' },
          { eventUuid: 'ev-other', status: 'APPLIED' },
        ],
      },
    };
    const { db, flowState } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.ok(db.tables.sync_outbox.get('ev-real').delivered_at, 'the actually-requested event still delivers');
    assert.strictEqual(db.tables.sync_outbox.get('ev-other').delivered_at, null, 'unrequested identity must not be touched');
    assert.ok(flowState.sync_state.lastError, 'unrequested identity is recorded as a protocol error');
    assert.ok(/protocol_response_unrequested_result:ev-other/.test(flowState.sync_state.lastError.message));
  });

  test('delivery', 'outbox: all requested events terminal (APPLIED) clears any prior protocol error', async () => {
    const seed = { sync_outbox: { ev1: { event_uuid: 'ev1', delivered_at: null, retry_count: 0 } } };
    const flowState = { sync_state: { lastError: { source: 'outbox', message: 'stale', statusCode: null } } };
    const msg = { statusCode: 200, _syncEventIds: ['ev1'], payload: { results: [{ eventUuid: 'ev1', status: 'APPLIED' }] } };
    const { flowState: outState, db } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState });
    assert.ok(db.tables.sync_outbox.get('ev1').delivered_at);
    assert.strictEqual(outState.sync_state.lastError, null, 'fully-accounted terminal batch clears the prior outbox protocol error');
  });

  test('delivery', 'outbox: malformed-only response retains a bounded protocol error and does not advance the success timestamp', async () => {
    const seed = { sync_outbox: { 'ev-mal': { event_uuid: 'ev-mal', delivered_at: null, retry_count: 0 } } };
    const msg = { statusCode: 200, _syncEventIds: ['ev-mal'], payload: { results: [{ eventUuid: 'ev-mal' }] } };
    const { flowState, db } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.strictEqual(db.tables.sync_outbox.get('ev-mal').delivered_at, null);
    assert.strictEqual(flowState.sync_state.lastOutboxDeliverySuccessAt, undefined, 'malformed-only batch does not advance success timestamp');
    assert.ok(/protocol_response_malformed_result:ev-mal/.test(flowState.sync_state.lastError.message));
  });

  test('delivery', 'outbox: retryable-only response retains pending state without a success-timestamp advance', async () => {
    const seed = { sync_outbox: { 'ev-retry': { event_uuid: 'ev-retry', delivered_at: null, retry_count: 0 } } };
    const msg = { statusCode: 200, _syncEventIds: ['ev-retry'], payload: { results: [{ eventUuid: 'ev-retry', status: 'RETRYABLE_ERROR' }] } };
    const { flowState, db } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.strictEqual(db.tables.sync_outbox.get('ev-retry').delivered_at, null);
    assert.strictEqual(db.tables.sync_outbox.get('ev-retry').retry_count, 1);
    assert.strictEqual(flowState.sync_state.lastOutboxDeliverySuccessAt, undefined);
  });

  test('delivery', 'outbox: mixed terminal + protocol-error response advances the timestamp but keeps a bounded protocol error', async () => {
    const seed = {
      sync_outbox: {
        'ev-ok': { event_uuid: 'ev-ok', delivered_at: null, retry_count: 0 },
        'ev-missing': { event_uuid: 'ev-missing', delivered_at: null, retry_count: 0 },
      },
    };
    const msg = { statusCode: 200, _syncEventIds: ['ev-ok', 'ev-missing'], payload: { results: [{ eventUuid: 'ev-ok', status: 'APPLIED' }] } };
    const { flowState, db } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.ok(db.tables.sync_outbox.get('ev-ok').delivered_at, 'terminal event still delivers');
    assert.strictEqual(db.tables.sync_outbox.get('ev-missing').delivered_at, null, 'missing-result event stays pending');
    assert.ok(flowState.sync_state.lastOutboxDeliverySuccessAt, 'at least one terminal result advances the timestamp');
    assert.ok(
      /protocol_response_missing_result:ev-missing/.test((flowState.sync_state.lastError || {}).message || ''),
      'the missing result is still reported in a bounded sync_state.lastError',
    );
  });

  test('delivery', 'outbox: absent results array with a nonempty batch classifies every event retryable (no whole-batch fallback)', async () => {
    const seed = {
      sync_outbox: {
        'ev-a': { event_uuid: 'ev-a', delivered_at: null, retry_count: 0 },
        'ev-b': { event_uuid: 'ev-b', delivered_at: null, retry_count: 0 },
      },
    };
    const msg = { statusCode: 200, _syncEventIds: ['ev-a', 'ev-b'], payload: {} };
    const { flowState, db } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.strictEqual(db.tables.sync_outbox.get('ev-a').delivered_at, null, 'ev-a must NOT be marked delivered by a whole-batch fallback');
    assert.strictEqual(db.tables.sync_outbox.get('ev-b').delivered_at, null, 'ev-b must NOT be marked delivered by a whole-batch fallback');
    assert.strictEqual(flowState.sync_state.lastOutboxDeliverySuccessAt, undefined);
    assert.ok(/protocol_response_missing_results/.test(flowState.sync_state.lastError.message));
  });

  test('delivery', 'outbox: present-but-empty results array reports one batch-level missing-results error', async () => {
    const seed = {
      sync_outbox: {
        'ev-empty-a': { event_uuid: 'ev-empty-a', delivered_at: null, retry_count: 0 },
        'ev-empty-b': { event_uuid: 'ev-empty-b', delivered_at: null, retry_count: 0 },
      },
    };
    const msg = { statusCode: 200, _syncEventIds: ['ev-empty-a', 'ev-empty-b'], payload: { results: [] } };
    const { flowState, db } = await executeFlowFunction('sync-outbox-mark', msg, { seed, flowState: {} });
    assert.strictEqual(db.tables.sync_outbox.get('ev-empty-a').delivered_at, null);
    assert.strictEqual(db.tables.sync_outbox.get('ev-empty-b').delivered_at, null);
    assert.strictEqual(db.tables.sync_outbox.get('ev-empty-a').retry_count, 1);
    assert.strictEqual(db.tables.sync_outbox.get('ev-empty-b').retry_count, 1);
    assert.strictEqual(flowState.sync_state.lastError.message, 'protocol_response_missing_results');
  });
}

// ---------------------------------------------------------------------------
// Section: ack - command-ack-mark-delivered + command-ack-build-batch dedup
// (later slice; RED by design per the plan - Task 2 does not touch these)
// ---------------------------------------------------------------------------

function registerAckTests() {
  test('ack', 'command-ack-mark-delivered: per-entry results - only ACKED entry delivers, LEASE_MISMATCH retries', async () => {
    const seed = {
      command_ack_outbox: {
        701: { id: 701, command_id: 'cmd-701', delivered_at: null, retry_count: 0, last_error: null },
        702: { id: 702, command_id: 'cmd-702', delivered_at: null, retry_count: 0, last_error: null },
      },
    };
    const msg = {
      statusCode: 200,
      _commandAckIds: [701, 702],
      payload: {
        results: [
          { commandId: 701, status: 'ACKED', accepted: true, terminal: true },
          { commandId: 702, status: 'LEASE_MISMATCH', accepted: false, terminal: false },
        ],
      },
    };
    const { db } = await executeFlowFunction('command-ack-mark-delivered', msg, { seed });
    assert.ok(db.tables.command_ack_outbox.get('701').delivered_at, 'command 701 (ACKED) must be marked delivered');
    assert.strictEqual(db.tables.command_ack_outbox.get('702').delivered_at, null, 'command 702 (LEASE_MISMATCH) must remain pending');
    assert.strictEqual(db.tables.command_ack_outbox.get('702').retry_count, 1, 'command 702 must retry');
    assert.ok(db.tables.command_ack_outbox.get('702').last_error, 'command 702 must carry a bounded last_error');
  });

  const ackUnresolvedCases = [
    ['missing result entry', { statusCode: 200, payload: { results: [] } }],
    ['duplicate result for the same id', { statusCode: 200, payload: { results: [{ commandId: 701, status: 'ACKED' }, { commandId: 701, status: 'LEASE_MISMATCH' }] } }],
    ['malformed body (not an object)', { statusCode: 200, payload: 'not-json' }],
    ['statusCode=0 transport failure', { statusCode: 0, payload: { error: 'Cloud REST IPv4 request failed' } }],
    ['HTTP 500', { statusCode: 500, payload: { message: 'server error' } }],
  ];
  for (const [label, msgFixture] of ackUnresolvedCases) {
    test('ack', 'command-ack-mark-delivered: ' + label + ' leaves the entry pending', async () => {
      const seed = { command_ack_outbox: { 701: { id: 701, command_id: 'cmd-701', delivered_at: null, retry_count: 0 } } };
      const msg = Object.assign({ _commandAckIds: [701] }, msgFixture);
      const { db } = await executeFlowFunction('command-ack-mark-delivered', msg, { seed });
      assert.strictEqual(
        db.tables.command_ack_outbox.get('701').delivered_at,
        null,
        label + ': command 701 has no unique accepted result and must remain pending',
      );
    });
  }

  test('ack', 'command-ack-mark-delivered: resolves the business commandId to outbox row ids via _localAckCorrelation (chained regression - the fixed join)', async () => {
    const seed = {
      command_ack_outbox: {
        801: { id: 801, command_id: 'cmd-900', delivered_at: null, retry_count: 0, last_error: null },
        802: { id: 802, command_id: 'cmd-900', delivered_at: null, retry_count: 0, last_error: null },
      },
    };
    const msg = {
      statusCode: 200,
      _commandAckIds: [801, 802],
      _localAckCorrelation: { 'cmd-900': [801, 802] },
      payload: { results: [{ commandId: 'cmd-900', status: 'ACKED', accepted: true, terminal: true }] },
    };
    const { db } = await executeFlowFunction('command-ack-mark-delivered', msg, { seed });
    assert.ok(
      db.tables.command_ack_outbox.get('801').delivered_at,
      'row 801 must be marked delivered via the commandId->rowId correlation join (Number(commandId) would be NaN for cmd-900)',
    );
    assert.ok(
      db.tables.command_ack_outbox.get('802').delivered_at,
      'row 802 must be marked delivered via the commandId->rowId correlation join',
    );
  });

  test('ack', 'command-ack-mark-delivered: LEASE_MISMATCH on the correlated commandId leaves both correlated rows pending with a retry bump (negative companion)', async () => {
    const seed = {
      command_ack_outbox: {
        801: { id: 801, command_id: 'cmd-900', delivered_at: null, retry_count: 0, last_error: null },
        802: { id: 802, command_id: 'cmd-900', delivered_at: null, retry_count: 0, last_error: null },
      },
    };
    const msg = {
      statusCode: 200,
      _commandAckIds: [801, 802],
      _localAckCorrelation: { 'cmd-900': [801, 802] },
      payload: { results: [{ commandId: 'cmd-900', status: 'LEASE_MISMATCH', accepted: false, terminal: false }] },
    };
    const { db } = await executeFlowFunction('command-ack-mark-delivered', msg, { seed });
    assert.strictEqual(db.tables.command_ack_outbox.get('801').delivered_at, null, 'row 801 must remain pending');
    assert.strictEqual(db.tables.command_ack_outbox.get('802').delivered_at, null, 'row 802 must remain pending');
    assert.strictEqual(db.tables.command_ack_outbox.get('801').retry_count, 1, 'row 801 must retry');
    assert.strictEqual(db.tables.command_ack_outbox.get('802').retry_count, 1, 'row 802 must retry');
  });

  test('ack', 'command-ack-build-batch: identical duplicate local ACK rows are NOT deduped into one outgoing ACK (unimplemented correlation)', async () => {
    const payload = JSON.stringify({ commandId: 'cmd-900', leaseToken: 'lease-xyz', status: 'ACKED', result: 'ACKED' });
    const seed = {
      users: { 1: { id: 1, server_url: 'https://cloud.example', server_sync_token: 'tok', server_linked_at: '2026-01-01T00:00:00.000Z' } },
      command_ack_outbox: {
        801: { id: 801, command_id: 'cmd-900', payload_json: payload, delivered_at: null, created_at: '2026-01-01T00:00:00.000Z' },
        802: { id: 802, command_id: 'cmd-900', payload_json: payload, delivered_at: null, created_at: '2026-01-01T00:00:01.000Z' },
      },
    };
    const env = { DEVICE_EUI: 'AABBCCDDEEFF0011', DEVICE_EUI_CONFIDENCE: 'confirmed' };
    const flowState = { sync_state: {} };
    const { result } = await executeFlowFunction('command-ack-build-batch', {}, { seed, env, flowState });
    assert.ok(result, 'batch builder should produce an outgoing message');
    assert.strictEqual(
      result.payload.acks.length,
      1,
      'two canonically-identical local rows for the same commandId must collapse into one outgoing ACK object',
    );
    assert.deepStrictEqual(
      (result._localAckCorrelation || {})['cmd-900'],
      [801, 802],
      'the outgoing ACK must carry correlation metadata naming both local outbox ids',
    );
  });

  test('ack', 'command-ack-build-batch: conflicting local rows for the same commandId must not merge into one ACK', async () => {
    const seed = {
      users: { 1: { id: 1, server_url: 'https://cloud.example', server_sync_token: 'tok', server_linked_at: '2026-01-01T00:00:00.000Z' } },
      command_ack_outbox: {
        901: { id: 901, command_id: 'cmd-901', payload_json: JSON.stringify({ commandId: 'cmd-901', leaseToken: 'lease-A', status: 'ACKED' }), delivered_at: null, created_at: '2026-01-01T00:00:00.000Z' },
        902: { id: 902, command_id: 'cmd-901', payload_json: JSON.stringify({ commandId: 'cmd-901', leaseToken: 'lease-B', status: 'REJECTED' }), delivered_at: null, created_at: '2026-01-01T00:00:01.000Z' },
      },
    };
    const env = { DEVICE_EUI: 'AABBCCDDEEFF0011', DEVICE_EUI_CONFIDENCE: 'confirmed' };
    const flowState = { sync_state: {} };
    const { result, warnings } = await executeFlowFunction('command-ack-build-batch', {}, { seed, env, flowState });
    const acksForCmd = ((result && result.payload && result.payload.acks) || []).filter((a) => a.commandId === 'cmd-901');
    assert.strictEqual(acksForCmd.length, 0, 'conflicting local rows for one commandId must not produce any outgoing ACK for that identity');
    const warningText = warnings.join(' ');
    assert.ok(!/lease-A|lease-B/.test(warningText), 'a conflict warning must not leak lease tokens');
  });
}

// ---------------------------------------------------------------------------
// Section: commands - sync-pending-split, reject-indefinite-open,
// work-request-status-apply (later slice; RED by design per the plan)
// ---------------------------------------------------------------------------

function registerCommandsTests() {
  test('commands', 'work-request-status-apply: replaying the same command id after a terminal ACK must not mutate again', async () => {
    const seed = { improvement_requests: { 'req-1': { request_uuid: 'req-1', cloud_status: null, updated_at: null } } };
    const db = new FakeDatabase(seed);
    const firstMsg = { payload: { commandId: '801', command_id: '801', request_id: 'req-1', requestId: 'req-1', status: 'ACCEPTED' } };
    const first = await executeFlowFunction('work-request-status-apply', firstMsg, { db });
    assert.strictEqual(db.tables.improvement_requests.get('req-1').cloud_status, 'ACCEPTED');

    const replayMsg = { payload: { commandId: '801', command_id: '801', request_id: 'req-1', requestId: 'req-1', status: 'REJECTED' } };
    const replay = await executeFlowFunction('work-request-status-apply', replayMsg, { db });
    assert.strictEqual(
      db.tables.improvement_requests.get('req-1').cloud_status,
      'ACCEPTED',
      'replay of the already-applied command id must not mutate the request a second time',
    );
    assert.deepStrictEqual(replay.result, first.result, 'replaying command 801 must reproduce the exact first terminal ACK, not process the new payload');
  });

  const pendingStatusCases = [
    ['statusCode=0', { statusCode: 0, payload: { commands: [] } }, false],
    ['missing statusCode', { payload: { commands: [] } }, false],
    ["string '200'", { statusCode: '200', payload: { commands: [] } }, false],
    ['HTTP 500', { statusCode: 500, payload: { commands: [] } }, false],
    ['integer HTTP 200 (positive control)', { statusCode: 200, payload: { commands: [] } }, true],
  ];
  for (const [label, msgFixture, expectSuccess] of pendingStatusCases) {
    test('commands', 'sync-pending-split: ' + label + ' success-timestamp gating', async () => {
      const flowState = { sync_state: {} };
      const { flowState: outState } = await executeFlowFunction('sync-pending-split', msgFixture, { flowState });
      const advanced = Boolean(outState.sync_state.lastPendingCommandPollSuccessAt);
      assert.strictEqual(advanced, expectSuccess, label + ': lastPendingCommandPollSuccessAt advance must match the fail-closed contract');
    });
  }

  const rejectionCases = [
    ['OPEN (indefinite open forbidden)', { command_type: 'OPEN', command_id: 'cmd-open-1', device_eui: 'AABBCCDDEEFF0011' }],
    ['unknown command type', { command_type: 'NOT_A_REAL_COMMAND', command_id: 'cmd-unknown-1' }],
    ['OPEN_FOR_DURATION without a duration', { command_type: 'OPEN_FOR_DURATION', command_id: 'cmd-dur-1' }],
  ];
  for (const [label, cmdPayload] of rejectionCases) {
    test('commands', 'reject-indefinite-open: ' + label + ' must not silently drop the command (needs a durable REJECTED_PERMANENT ack)', async () => {
      const msg = { payload: Object.assign({}, cmdPayload) };
      const { result } = await executeFlowFunction('reject-indefinite-open', msg, {});
      assert.notStrictEqual(
        result,
        null,
        label + ': a permanently-invalid command must still produce a durable rejection ack, not a silent null drop',
      );
    });
  }
}

registerDeliveryTests();
registerAckTests();
registerCommandsTests();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let section = 'all';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--section') {
      section = argv[++i];
    } else {
      throw new Error('unknown argument: ' + argv[i]);
    }
  }
  if (section !== 'all' && !SECTIONS.includes(section)) {
    throw new Error('unknown --section value: ' + section + ' (expected one of ' + SECTIONS.concat('all').join('|') + ')');
  }
  return { section };
}

async function main() {
  const { section } = parseArgs(process.argv.slice(2));
  const sectionsToRun = section === 'all' ? SECTIONS : [section];

  let overallPass = 0;
  let overallTotal = 0;
  let anyFail = false;
  for (const sec of sectionsToRun) {
    console.log('=== section: ' + sec + ' ===');
    const res = await runSection(sec);
    overallPass += res.pass;
    overallTotal += res.total;
    if (res.failures.length) anyFail = true;
    console.log(sec + ': ' + res.pass + '/' + res.total + ' passed');
  }
  console.log('TOTAL: ' + overallPass + '/' + overallTotal + ' passed across [' + sectionsToRun.join(', ') + ']');
  process.exit(anyFail ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('test-sync-delivery-fail-closed: FATAL - ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  });
}
