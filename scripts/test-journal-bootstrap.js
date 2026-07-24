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
const HISTORY_AUTH_SECRET = 'fixture-history-auth-secret';
const EXPECTED_CAPABILITIES = [
  'linked_auth_sync_v1',
  'force_edge_sync_v1',
  'zone_desired_state_v1',
  'field_journal_v1',
];
const JOURNAL_FIELDS = [
  'journal_catalog_version',
  'journal_catalog_hash',
  'journal_manifest',
];
const JOURNAL_READINESS_TABLES = [
  'journal_catalog_state',
  'journal_entries',
  'journal_entry_values',
  'journal_vocab',
  'journal_vocab_mappings',
  'journal_plots',
  'journal_plot_settings',
  'journal_plot_groups',
  'journal_plot_group_members',
  'journal_templates',
  'journal_layouts',
  'journal_products',
];
const RESOURCE_HASH_SCOPE = 'sorted aggregate_type\\0aggregate_key\\0sync_version tuples';
const RESOURCE_IDS = {
  draftEntry: '10000000-0000-4000-8000-000000000001',
  finalEntry: '10000000-0000-4000-8000-000000000002',
  voidedEntry: '10000000-0000-4000-8000-000000000003',
  tombstonedEntry: '10000000-0000-4000-8000-000000000004',
  tombstonedDraft: '10000000-0000-4000-8000-000000000005',
  customVocab: '20000000-0000-4000-8000-000000000001',
  tombstonedVocab: '20000000-0000-4000-8000-000000000002',
  plot: '30000000-0000-4000-8000-000000000001',
  tombstonedPlot: '30000000-0000-4000-8000-000000000002',
  group: '40000000-0000-4000-8000-000000000001',
  tombstonedGroup: '40000000-0000-4000-8000-000000000002',
};

function resourceVersions(options) {
  const settings = options || {};
  return Object.assign({
    finalEntry: 2,
    voidedEntry: 3,
    tombstonedEntry: 5,
    customVocab: 4,
    tombstonedVocab: 6,
    plot: 8,
    tombstonedPlot: 9,
    group: 10,
    tombstonedGroup: 11,
  }, settings.resourceVersions || {}, settings.manifestSyncVersion === undefined
    ? {}
    : { finalEntry: settings.manifestSyncVersion });
}

function watermarkTuples(options) {
  const versions = resourceVersions(options);
  return [
    ['JOURNAL_ENTRY', RESOURCE_IDS.finalEntry, versions.finalEntry],
    ['JOURNAL_ENTRY', RESOURCE_IDS.voidedEntry, versions.voidedEntry],
    ['JOURNAL_ENTRY', RESOURCE_IDS.tombstonedEntry, versions.tombstonedEntry],
    ['JOURNAL_VOCAB', RESOURCE_IDS.customVocab, versions.customVocab],
    ['JOURNAL_VOCAB', RESOURCE_IDS.tombstonedVocab, versions.tombstonedVocab],
    ['JOURNAL_PLOT', RESOURCE_IDS.plot, versions.plot],
    ['JOURNAL_PLOT', RESOURCE_IDS.tombstonedPlot, versions.tombstonedPlot],
    ['JOURNAL_PLOT_GROUP', RESOURCE_IDS.group, versions.group],
    ['JOURNAL_PLOT_GROUP', RESOURCE_IDS.tombstonedGroup, versions.tombstonedGroup],
  ];
}

function expectedResourceWatermarkHash(options) {
  const serialized = watermarkTuples(options).map((tuple) => tuple.join('\0'));
  serialized.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  const hash = crypto.createHash('sha256');
  for (const tuple of serialized) hash.update(tuple, 'utf8');
  return hash.digest('hex');
}

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
    this.userQueryError = settings.userQueryError || null;
    this.closeError = settings.closeError || null;
    if (settings.tables !== false) {
      const tableSql = {
        journal_catalog_state: 'CREATE TABLE journal_catalog_state(id INTEGER PRIMARY KEY, catalog_version, catalog_hash TEXT)',
        journal_entries: 'CREATE TABLE journal_entries(entry_uuid TEXT, status TEXT, sync_version, deleted_at TEXT)',
        journal_entry_values: 'CREATE TABLE journal_entry_values(entry_uuid TEXT)',
        journal_vocab: 'CREATE TABLE journal_vocab(code TEXT, custom_field_uuid TEXT, scope TEXT, sync_version, deleted_at TEXT)',
        journal_vocab_mappings: 'CREATE TABLE journal_vocab_mappings(vocab_code TEXT)',
        journal_plots: 'CREATE TABLE journal_plots(plot_uuid TEXT, sync_version, deleted_at TEXT)',
        journal_plot_settings: 'CREATE TABLE journal_plot_settings(plot_uuid TEXT)',
        journal_plot_groups: 'CREATE TABLE journal_plot_groups(group_uuid TEXT, sync_version, deleted_at TEXT)',
        journal_plot_group_members: 'CREATE TABLE journal_plot_group_members(group_uuid TEXT)',
        journal_templates: 'CREATE TABLE journal_templates(code TEXT)',
        journal_layouts: 'CREATE TABLE journal_layouts(code TEXT)',
        journal_products: 'CREATE TABLE journal_products(product_uuid TEXT)',
      };
      for (const table of JOURNAL_READINESS_TABLES) {
        if (table !== settings.omitTable) this.native.exec(tableSql[table]);
      }
      if (settings.omitTable !== 'journal_catalog_state' && settings.stateRow !== false) {
        this.native.prepare(
          'INSERT INTO journal_catalog_state(id,catalog_version,catalog_hash) VALUES (1,?,?)'
        ).run(
          settings.catalogVersion === undefined ? 7 : settings.catalogVersion,
          settings.catalogHash === undefined ? CATALOG_HASH : settings.catalogHash
        );
      }
      const versions = resourceVersions(settings);
      if (settings.omitTable !== 'journal_entries') {
        const insertEntry = this.native.prepare(
          'INSERT INTO journal_entries(entry_uuid,status,sync_version,deleted_at) VALUES (?,?,?,?)'
        );
        insertEntry.run(RESOURCE_IDS.draftEntry, 'draft', 100, null);
        insertEntry.run(RESOURCE_IDS.finalEntry, 'final', versions.finalEntry, null);
        insertEntry.run(RESOURCE_IDS.voidedEntry, 'voided', versions.voidedEntry, null);
        insertEntry.run(
          RESOURCE_IDS.tombstonedEntry,
          'final',
          versions.tombstonedEntry,
          '2026-07-12T09:00:00.000Z'
        );
        insertEntry.run(
          RESOURCE_IDS.tombstonedDraft,
          'draft',
          7,
          '2026-07-12T09:01:00.000Z'
        );
      }
      if (settings.omitTable !== 'journal_vocab') {
        const insertVocab = this.native.prepare(
          'INSERT INTO journal_vocab(code,custom_field_uuid,scope,sync_version,deleted_at) VALUES (?,?,?,?,?)'
        );
        insertVocab.run('activity.irrigation', null, 'core', 100, null);
        insertVocab.run(
          'custom.' + RESOURCE_IDS.customVocab,
          RESOURCE_IDS.customVocab,
          'custom',
          versions.customVocab,
          null
        );
        insertVocab.run(
          'custom.' + RESOURCE_IDS.tombstonedVocab,
          RESOURCE_IDS.tombstonedVocab,
          'custom',
          versions.tombstonedVocab,
          '2026-07-12T09:02:00.000Z'
        );
      }
      if (settings.omitTable !== 'journal_plots') {
        const insertPlot = this.native.prepare(
          'INSERT INTO journal_plots(plot_uuid,sync_version,deleted_at) VALUES (?,?,?)'
        );
        insertPlot.run(RESOURCE_IDS.plot, versions.plot, null);
        insertPlot.run(
          RESOURCE_IDS.tombstonedPlot,
          versions.tombstonedPlot,
          '2026-07-12T09:03:00.000Z'
        );
      }
      if (settings.omitTable !== 'journal_plot_groups') {
        const insertGroup = this.native.prepare(
          'INSERT INTO journal_plot_groups(group_uuid,sync_version,deleted_at) VALUES (?,?,?)'
        );
        insertGroup.run(RESOURCE_IDS.group, versions.group, null);
        insertGroup.run(
          RESOURCE_IDS.tombstonedGroup,
          versions.tombstonedGroup,
          '2026-07-12T09:04:00.000Z'
        );
      }
    }
  }

  all(sql, params, callback) {
    try {
      let rows;
      if (/FROM users WHERE server_url IS NOT NULL/.test(sql) && this.userQueryError) {
        throw this.userQueryError;
      } else if (/FROM users WHERE id = \? AND auth_mode = 'server'/.test(sql)) {
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
      } else if (/sqlite_master|journal_/.test(sql)) {
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
    setImmediate(() => callback(this.closeError));
  }

  destroy() {
    this.native.close();
  }
}

function runtime(db, options) {
  const state = new Map();
  if (options && options.initialSyncState) state.set('sync_state', options.initialSyncState);
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
          AUTH_TOKEN_SECRET: HISTORY_AUTH_SECRET,
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

function identityGlobal(options) {
  const restartState = String((options && options.identityRestartState) || 'missing');
  const restartPath = '/var/run/osi-identity-restart.json';
  const fsGlobal = {
    existsSync(filePath) {
      return filePath === restartPath && restartState !== 'missing';
    },
    readFileSync(filePath, encoding) {
      assert.equal(filePath, restartPath);
      assert.equal(encoding, 'utf8');
      if (restartState === 'missing') {
        const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
        error.code = 'ENOENT';
        throw error;
      }
      if (restartState === 'malformed') return '{';
      return '{"phase":"restart_pending"}';
    },
  };
  return {
    get(key) {
      return key === 'fs' ? fsGlobal : null;
    },
  };
}

async function runNormalBootstrap(node, options) {
  const db = new JournalFixtureDb(options);
  const context = runtime(db, options);
  try {
    const execute = new Function('msg', 'flow', 'global', 'env', 'node', 'crypto', 'osiDb', node.func);
    const result = await execute({}, context.flow, identityGlobal(options), context.env, context.node, crypto, context.osiDb);
    return { payload: result && result.payload, syncState: context.flow.get('sync_state') || {}, warnings: context.warnings, errors: context.errors };
  } finally {
    db.destroy();
  }
}

async function runForcedBootstrap(node, options) {
  const db = new JournalFixtureDb(options);
  const context = runtime(db, options);
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
    }, context.flow, identityGlobal(options), context.env, context.node,
    crypto, context.osiDb, osiCloudHttp);
    return { payload: bootstrapPayload, syncState: context.flow.get('sync_state') || {}, warnings: context.warnings, errors: context.errors };
  } finally {
    db.destroy();
  }
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function historyBearerToken() {
  const payload = toBase64Url(JSON.stringify({
    userId: 1,
    username: 'fixture-user',
    exp: Date.now() + 60000,
  }));
  const signature = toBase64Url(
    crypto.createHmac('sha256', HISTORY_AUTH_SECRET).update(payload).digest()
  );
  return payload + '.' + signature;
}

async function runHistoryCloseRoute(node, options) {
  const db = new JournalFixtureDb(options);
  const context = runtime(db);
  const globalState = new Map([
    ['historySchemaGuardVersion', '2026-06-07-history-loading-v1'],
  ]);
  const globalContext = {
    get(key) { return globalState.get(key); },
    set(key, value) { globalState.set(key, value); },
  };
  const historyRuntime = {
    httpError(statusCode, message, detail) {
      const error = new Error(message);
      error.statusCode = statusCode;
      if (detail !== undefined) error.detail = detail;
      throw error;
    },
    phaseSummary() { return ''; },
  };
  try {
    const execute = new Function(
      'msg', 'global', 'env', 'node', 'osiDb', 'osiHistory', 'crypto', 'HR',
      node.func
    );
    const result = await execute({
      req: {
        method: 'GET',
        path: '/api/history/fixture-not-found',
        headers: { authorization: 'Bearer ' + historyBearerToken() },
        params: {},
        query: {},
      },
    }, globalContext, context.env, context.node, context.osiDb, {}, crypto, historyRuntime);
    return { result, warnings: context.warnings, errors: context.errors };
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
    version: 1,
    entries_count: 3,
    custom_vocab_count: 2,
    plots_count: 2,
    plot_groups_count: 2,
    resource_watermark_hash: expectedResourceWatermarkHash(),
    hash_scope: RESOURCE_HASH_SCOPE,
  });
  assert.deepEqual(payload.gatewayIdentity.previousGatewayDeviceEuis, []);
  assert.equal(payload.gatewayIdentity.edgeBuildVersion, '2026.07-test');
}

function assertSuppressedAdvertisement(payload) {
  assert.ok(payload, 'ordinary core bootstrap must continue');
  assert.deepEqual(payload.gatewayIdentity.syncCapabilities, EXPECTED_CAPABILITIES.slice(0, 3));
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

  for (const [label, options] of [
    ['present', { identityRestartState: 'present' }],
    ['malformed', { identityRestartState: 'malformed' }],
  ]) {
    test(profile + ' normal bootstrap fails closed for ' + label + ' identity restart state', async () => {
      const result = await runNormalBootstrap(normal, options);
      assert.equal(result.payload, null);
      assert.equal(result.syncState.lastError && result.syncState.lastError.source, 'gateway-identity');
      if (label === 'malformed') {
        assert.ok(result.warnings.some((warning) => /Gateway identity restart state is unreadable/.test(warning)));
      }
    });
    test(profile + ' forced bootstrap fails closed for ' + label + ' identity restart state', async () => {
      const result = await runForcedBootstrap(forced, options);
      assert.equal(result.payload, null);
      assert.equal(result.syncState.lastError && result.syncState.lastError.source, 'gateway-identity');
      if (label === 'malformed') {
        assert.ok(result.warnings.some((warning) => /Gateway identity restart state is unreadable/.test(warning)));
      }
    });
  }
}

test('normal bootstrap does not inherit a stale gateway-identity source for an unrelated failure', async () => {
  const normal = canonical.find((node) => node.id === 'sync-bootstrap-build');
  const result = await runNormalBootstrap(normal, {
    initialSyncState: { lastError: { source: 'gateway-identity', message: 'stale' } },
    userQueryError: new Error('unrelated users query failure'),
  });
  assert.equal(result.payload, null);
  assert.equal(result.syncState.lastError && result.syncState.lastError.source, 'bootstrap');
});

const canonical = loadFlows('bcm2712');
const bootstrapKinds = [
  ['normal', canonical.find((node) => node.id === 'sync-bootstrap-build'), runNormalBootstrap],
  ['forced', canonical.find((node) => node.id === 'sync-force-build'), runForcedBootstrap],
];

for (const [kind, node, execute] of bootstrapKinds) {
  test(kind + ' bootstrap keeps its core payload when journal tables are absent', async () => {
    assertSuppressedAdvertisement((await execute(node, { tables: false })).payload);
  });

  for (const table of JOURNAL_READINESS_TABLES) {
    test(kind + ' bootstrap suppresses journal advertisement when ' + table + ' is absent', async () => {
      assertSuppressedAdvertisement((await execute(node, { omitTable: table })).payload);
    });
  }

  for (const invalid of [
    { label: 'uppercase catalog hash', catalogHash: 'A'.repeat(64) },
    { label: 'zero catalog version', catalogVersion: 0 },
    { label: 'fractional catalog version', catalogVersion: 1.5 },
    { label: 'missing catalog state', stateRow: false },
    { label: 'fractional resource sync version', manifestSyncVersion: 1.5 },
    { label: 'negative resource sync version', manifestSyncVersion: -100 },
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

  test(kind + ' bootstrap resource hash changes when a tombstoned aggregate advances', async () => {
    const baseline = (await execute(node)).payload.gatewayIdentity.journal_manifest;
    const options = { resourceVersions: { tombstonedPlot: 12 } };
    const advanced = (await execute(node, options)).payload.gatewayIdentity.journal_manifest;
    assert.equal(advanced.resource_watermark_hash, expectedResourceWatermarkHash(options));
    assert.notEqual(advanced.resource_watermark_hash, baseline.resource_watermark_hash);
    assert.deepEqual(
      Object.assign({}, advanced, { resource_watermark_hash: baseline.resource_watermark_hash }),
      baseline
    );
  });

  test(kind + ' bootstrap resource hash distinguishes states with the same version sum', async () => {
    const baseline = (await execute(node)).payload.gatewayIdentity.journal_manifest;
    const options = { resourceVersions: { finalEntry: 3, plot: 7 } };
    const redistributed = (await execute(node, options)).payload.gatewayIdentity.journal_manifest;
    const sum = (tuples) => tuples.reduce((total, tuple) => total + tuple[2], 0);
    assert.equal(sum(watermarkTuples()), sum(watermarkTuples(options)));
    assert.equal(redistributed.resource_watermark_hash, expectedResourceWatermarkHash(options));
    assert.notEqual(redistributed.resource_watermark_hash, baseline.resource_watermark_hash);
  });
}

test('normal bootstrap warns when SQLite close reports an asynchronous error', async () => {
  const closeError = new Error('fixture asynchronous close failure');
  const result = await runNormalBootstrap(bootstrapKinds[0][1], { closeError });
  assert.ok(result.warnings.some((warning) =>
    warning === 'Bootstrap DB close failed after error: ' + closeError.message
  ), 'normal bootstrap must surface the close callback error');
});

test('forced bootstrap warns when SQLite close reports an asynchronous error', async () => {
  const closeError = new Error('fixture asynchronous close failure');
  const result = await runForcedBootstrap(bootstrapKinds[1][1], { closeError });
  assert.ok(result.warnings.some((warning) =>
    warning === 'Force-sync optional operation failed: ' + closeError.message
  ), 'forced bootstrap must surface the close callback error');
});

test('history router warns when SQLite close reports an asynchronous error', async () => {
  const closeError = new Error('fixture asynchronous close failure');
  const history = canonical.find((node) => node.id === 'history-api-router-fn');
  const result = await runHistoryCloseRoute(history, { closeError });
  assert.equal(result.result.statusCode, 404);
  assert.ok(result.warnings.some((warning) =>
    warning === 'History API DB close failed: ' + closeError.message
  ), 'history router must surface the close callback error');
});

for (const profile of PROFILES) {
  test(profile + ' feature response preserves history flags and exposes scoped access', async () => {
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
      scoped_access: false,
    });
    const scopedResult = await execute(
      { req: { method: 'GET', path: '/api/system/features' } },
      { get() { return null; } },
      { get(key) { return key === 'OSI_SCOPED_ACCESS' ? '1' : null; } },
      { warn() {}, error() {}, log() {} },
      { Database: class { constructor() { throw new Error('feature route opened DB'); } } },
      {},
      crypto,
      {}
    );
    assert.equal(scopedResult.statusCode, 200);
    assert.equal(scopedResult.payload.features.scoped_access, true);
    const occurrences = flows.filter((node) =>
      node.type === 'function' && String(node.func || '').includes('fieldJournalUxEnabled')
    );
    assert.deepEqual(occurrences.map((node) => node.id), ['history-api-router-fn']);
  });
}
