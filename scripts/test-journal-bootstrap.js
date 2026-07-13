#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY_EUI = '0016C001F11715E2';
const CATALOG_HASH = 'a'.repeat(64);
const EXPECTED_CAPABILITIES = [
  'linked_auth_sync_v1',
  'force_edge_sync_v1',
  'field_journal_v1',
];
const JOURNAL_FIELDS = [
  'journal_catalog_version',
  'journal_catalog_hash',
  'journal_manifest',
];

function loadFlows(profile) {
  return JSON.parse(fs.readFileSync(path.join(
    ROOT,
    'conf/full_raspberrypi_bcm27xx_' + profile + '/files/usr/share/flows.json'
  ), 'utf8'));
}

class JournalFixtureDb {
  constructor(options) {
    const settings = options || {};
    this.native = new DatabaseSync(':memory:');
    this.closed = false;
    this.catalogQueryError = settings.catalogQueryError || null;
    if (settings.tables !== false) {
      this.native.exec([
        'CREATE TABLE journal_catalog_state(id INTEGER PRIMARY KEY, catalog_version, catalog_hash TEXT)',
        'CREATE TABLE journal_entries(status TEXT, sync_version, deleted_at TEXT)',
        'CREATE TABLE journal_vocab(scope TEXT, sync_version, deleted_at TEXT)',
      ].join(';'));
      if (settings.stateRow !== false) {
        this.native.prepare(
          'INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash) VALUES (1,?,?)'
        ).run(
          settings.catalogVersion === undefined ? 7 : settings.catalogVersion,
          settings.catalogHash === undefined ? CATALOG_HASH : settings.catalogHash
        );
      }
      const insertEntry = this.native.prepare(
        'INSERT INTO journal_entries(status,sync_version,deleted_at) VALUES (?,?,?)'
      );
      insertEntry.run('draft', 100, null);
      insertEntry.run(
        'final',
        settings.manifestSyncVersion === undefined ? 2 : settings.manifestSyncVersion,
        null
      );
      insertEntry.run('voided', 3, null);
      insertEntry.run('final', 5, '2026-07-12T09:00:00.000Z');
      insertEntry.run('draft', 7, '2026-07-12T09:01:00.000Z');
      const insertVocab = this.native.prepare(
        'INSERT INTO journal_vocab(scope,sync_version,deleted_at) VALUES (?,?,?)'
      );
      insertVocab.run('core', 100, null);
      insertVocab.run('custom', 4, null);
      insertVocab.run('custom', 6, '2026-07-12T09:02:00.000Z');
    }
  }

  all(sql, params, callback) {
    try {
      let rows;
      if (/FROM users WHERE id = \? AND auth_mode = 'server'/.test(sql)) {
        rows = [{
          id: 1,
          server_url: 'https://cloud.invalid',
          server_sync_token: 'fixture-sync-token',
          server_sync_token_expires_at: null,
        }];
      } else if (/FROM users WHERE server_url IS NOT NULL/.test(sql)) {
        rows = [{
          id: 1,
          server_url: 'https://cloud.invalid',
          server_sync_token: 'fixture-sync-token',
        }];
      } else if (/journal_catalog_state/.test(sql) && !/sqlite_master/.test(sql) && this.catalogQueryError) {
        throw this.catalogQueryError;
      } else if (/sqlite_master|journal_catalog_state|journal_entries|journal_vocab/.test(sql)) {
        rows = this.native.prepare(sql).all(...(params || []));
      } else {
        rows = [];
      }
      callback(null, rows);
    } catch (error) {
      callback(error);
    }
  }

  run(_sql, _params, callback) {
    callback.call({ changes: 0 }, null);
  }

  close(callback) {
    this.closed = true;
    callback();
  }

  destroy() {
    this.native.close();
  }
}

function runtime(db) {
  const state = new Map();
  const warnings = [];
  const errors = [];
  return {
    flow: {
      get(key) { return state.get(key); },
      set(key, value) { state.set(key, value); },
    },
    env: {
      get(key) {
        return ({
          DEVICE_EUI: GATEWAY_EUI,
          DEVICE_EUI_SOURCE: 'fixture',
          DEVICE_EUI_CONFIDENCE: 'authoritative',
          DEVICE_EUI_LAST_VERIFIED_AT: '2026-07-12T08:00:00.000Z',
          FIRMWARE_VERSION: '2026.07-test',
        })[key];
      },
    },
    node: {
      warn(value) { warnings.push(String(value)); },
      error(value) { errors.push(String(value)); },
      log() {},
      status() {},
    },
    osiDb: {
      Database: class {
        constructor() { return db; }
      },
    },
    warnings,
    errors,
  };
}

async function runNormalBootstrap(node, options) {
  const db = new JournalFixtureDb(options);
  const context = runtime(db);
  try {
    const execute = new Function('msg', 'flow', 'env', 'node', 'osiDb', node.func);
    const result = await execute({}, context.flow, context.env, context.node, context.osiDb);
    return { payload: result && result.payload, warnings: context.warnings, errors: context.errors };
  } finally {
    db.destroy();
  }
}

async function runForcedBootstrap(node, options) {
  const db = new JournalFixtureDb(options);
  const context = runtime(db);
  let bootstrapPayload = null;
  const osiCloudHttp = {
    async requestJsonIpv4(request) {
      if (/\/auth\/refresh-sync$/.test(request.url)) {
        return { statusCode: 200, payload: { token: 'refreshed-fixture-token' } };
      }
      if (/\/api\/v1\/sync\/edge\/bootstrap$/.test(request.url)) {
        bootstrapPayload = request.payload;
        return { statusCode: 200, payload: { applied: 0, skipped: 0 } };
      }
      if (/\/pending-commands\?limit=50$/.test(request.url)) {
        return { statusCode: 200, payload: { commands: [] } };
      }
      throw new Error('Unexpected fixture request: ' + request.method + ' ' + request.url);
    },
  };
  try {
    const execute = new Function(
      'msg', 'flow', 'global', 'env', 'node', 'crypto', 'osiDb', 'osiCloudHttp',
      node.func
    );
    await execute({
      _forceSyncInternal: true,
      _forceSyncUserId: 1,
      _forceSyncUsername: 'fixture-user',
    }, context.flow, { get() { return null; } }, context.env, context.node,
    crypto, context.osiDb, osiCloudHttp);
    return { payload: bootstrapPayload, warnings: context.warnings, errors: context.errors };
  } finally {
    db.destroy();
  }
}

function assertReadyAdvertisement(payload) {
  assert.ok(payload, 'core bootstrap payload must be produced');
  assert.deepEqual(payload.gatewayIdentity.syncCapabilities, EXPECTED_CAPABILITIES);
  assert.equal(payload.gatewayIdentity.journal_catalog_version, 7);
  assert.equal(payload.gatewayIdentity.journal_catalog_hash, CATALOG_HASH);
  assert.deepEqual(payload.gatewayIdentity.journal_manifest, {
    entries_count: 3,
    custom_vocab_count: 2,
    high_water_mark: 20,
  });
  assert.deepEqual(payload.gatewayIdentity.previousGatewayDeviceEuis, []);
  assert.equal(payload.gatewayIdentity.edgeBuildVersion, '2026.07-test');
}

function assertSuppressedAdvertisement(payload) {
  assert.ok(payload, 'ordinary core bootstrap must continue');
  assert.deepEqual(payload.gatewayIdentity.syncCapabilities, EXPECTED_CAPABILITIES.slice(0, 2));
  for (const field of JOURNAL_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload.gatewayIdentity, field), false, field);
  }
  assert.deepEqual(payload.gatewayIdentity.previousGatewayDeviceEuis, []);
  assert.equal(payload.gatewayIdentity.edgeBuildVersion, '2026.07-test');
}

for (const profile of PROFILES) {
  const flows = loadFlows(profile);
  const normal = flows.find((node) => node.id === 'sync-bootstrap-build');
  const forced = flows.find((node) => node.id === 'sync-force-build');

  test(profile + ' normal bootstrap advertises the ready journal catalog and exact manifest', async () => {
    assert.equal(normal && normal.name, 'Build Cloud Bootstrap');
    assertReadyAdvertisement((await runNormalBootstrap(normal)).payload);
  });

  test(profile + ' forced bootstrap advertises the same ready journal contract', async () => {
    assert.equal(forced && forced.name, 'Run Force Sync');
    assertReadyAdvertisement((await runForcedBootstrap(forced)).payload);
  });
}

const canonical = loadFlows('bcm2712');
const bootstrapKinds = [
  ['normal', canonical.find((node) => node.id === 'sync-bootstrap-build'), runNormalBootstrap],
  ['forced', canonical.find((node) => node.id === 'sync-force-build'), runForcedBootstrap],
];

for (const [kind, node, execute] of bootstrapKinds) {
  test(kind + ' bootstrap keeps its core payload when journal tables are absent', async () => {
    assertSuppressedAdvertisement((await execute(node, { tables: false })).payload);
  });

  for (const invalid of [
    { label: 'uppercase catalog hash', catalogHash: 'A'.repeat(64) },
    { label: 'zero catalog version', catalogVersion: 0 },
    { label: 'fractional catalog version', catalogVersion: 1.5 },
    { label: 'missing catalog state', stateRow: false },
    { label: 'fractional manifest revision', manifestSyncVersion: 1.5 },
    { label: 'negative high-water mark', manifestSyncVersion: -100 },
  ]) {
    test(kind + ' bootstrap suppresses every journal field for ' + invalid.label, async () => {
      assertSuppressedAdvertisement((await execute(node, invalid)).payload);
    });
  }

  test(kind + ' bootstrap bounds catalog query warnings and continues core sync', async () => {
    const error = new Error('fixture journal query failed ' + 'x'.repeat(1000));
    const result = await execute(node, { catalogQueryError: error });
    assertSuppressedAdvertisement(result.payload);
    const warning = result.warnings.find((value) => /Journal bootstrap advertisement unavailable/.test(value));
    assert.ok(warning, 'caught journal DB error must emit a contextual warning');
    assert.ok(warning.length <= 256, 'journal warning must be bounded, got ' + warning.length);
  });
}

for (const profile of PROFILES) {
  test(profile + ' feature response adds the UI-only journal flag and preserves history flags', async () => {
    const flows = loadFlows(profile);
    const history = flows.find((node) => node.id === 'history-api-router-fn');
    assert.equal(history && history.name, 'History API Router');
    assert.match(history.func, /\.code !== 'ENOENT'/, 'expected missing auth-secret files stay quiet');
    const execute = new Function(
      'msg', 'global', 'env', 'node', 'osiDb', 'osiHistory', 'crypto', 'HR',
      history.func
    );
    const msg = { req: { method: 'GET', path: '/api/system/features' } };
    const result = await execute(
      msg,
      { get() { return null; } },
      { get() { return null; } },
      { warn() {}, error() {}, log() {} },
      { Database: class { constructor() { throw new Error('feature route opened DB'); } } },
      {},
      crypto,
      {}
    );
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload.features, {
      historyUxEnabled: true,
      historyComparisonEnabled: false,
      historyWorkspacesEnabled: false,
      historyAdvancedOverlaysEnabled: false,
      historyCloudAiEnabled: false,
      fieldJournalUxEnabled: false,
    });
    const occurrences = flows.filter((node) =>
      node.type === 'function' && String(node.func || '').includes('fieldJournalUxEnabled')
    );
    assert.deepEqual(occurrences.map((node) => node.id), ['history-api-router-fn']);
  });
}
