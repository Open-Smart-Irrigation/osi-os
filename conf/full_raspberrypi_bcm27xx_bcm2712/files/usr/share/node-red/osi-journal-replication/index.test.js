'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../../../../../../..');
const helper = require('./index');
const lifecycle = require('../osi-journal/lifecycle');
const golden = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/journal-v2-golden.json'), 'utf8'
));

function facade(database) {
  const db = {
    get(sql, params = []) { return Promise.resolve(database.prepare(sql).get(...params)); },
    all(sql, params = []) { return Promise.resolve(database.prepare(sql).all(...params)); },
    run(sql, params = []) { return Promise.resolve(database.prepare(sql).run(...params)); },
    exec(sql) { database.exec(sql); return Promise.resolve(); },
  };
  db.transaction = async function transaction(callback) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(db);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  return db;
}

function fixture(t) {
  const database = new DatabaseSync(':memory:');
  database.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  t.after(() => database.close());
  return { database, db: facade(database) };
}

function customSource(gatewayDeviceEui) {
  const aggregate = JSON.parse(JSON.stringify(golden.mutation_vectors.find(function(vector) {
    return vector.input.operation === 'CUSTOM_VOCAB_UPSERT';
  }).input.candidate.custom_vocab));
  aggregate.contract_version = 1;
  aggregate.gateway_device_eui = gatewayDeviceEui;
  return {
    aggregate,
    aggregate_type: 'JOURNAL_VOCAB',
    aggregate_key: aggregate.custom_field_uuid,
    sync_version: aggregate.sync_version,
    occurred_at: '2026-08-08T10:11:12.123Z',
    gateway_device_eui: gatewayDeviceEui,
  };
}

test('exports the pure durable Journal V2 surface', () => {
  for (const name of [
    'enqueueMutation', 'applyEnvelope', 'nextMutations', 'recordOutcome',
    'bindPendingAttachments', 'enforcePhotoCache',
  ]) {
    assert.equal(typeof helper[name], 'function', name);
  }
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|axios|https?\.request)\b/);
});

test('legacy authority preserves the V1 journal outbox path', async (t) => {
  const { database, db } = fixture(t);
  const source = customSource('0016C001F11715E2');
  const result = await lifecycle.emitJournalOutbox(db, source, 'JOURNAL_VOCAB_UPSERTED');
  assert.equal(result.replication_mode, 'v1');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_edge_mutations').get().count, 0);
});

test('barrier-recorded authority queues one V2 mutation and emits no V1 event', async (t) => {
  const { database, db } = fixture(t);
  const workspaceUuid = '20000000-0000-4000-8000-000000000001';
  const gatewayDeviceEui = '0016C001F11715E2';
  database.prepare(
    'INSERT INTO journal_authority_state(' +
      'workspace_uuid,gateway_device_eui,authority_state,state,updated_at' +
    ') VALUES(?,?,\'legacy\',\'BARRIER_RECORDED\',?)'
  ).run(workspaceUuid, gatewayDeviceEui, '2026-08-08T10:11:12.123Z');

  const result = await lifecycle.emitJournalOutbox(
    db, customSource(gatewayDeviceEui), 'JOURNAL_VOCAB_UPSERTED'
  );
  assert.equal(result.replication_mode, 'v2');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get().count, 0);
  const row = database.prepare(
    'SELECT workspace_uuid,operation,payload_json FROM journal_edge_mutations'
  ).get();
  assert.equal(row.workspace_uuid, workspaceUuid);
  assert.equal(row.operation, 'CUSTOM_VOCAB_UPSERT');
  assert.equal(JSON.parse(row.payload_json).candidate.custom_vocab.contract_version, 2);
});

test('blocked authority remains on the V1 path until a barrier is recorded', async (t) => {
  const { database, db } = fixture(t);
  const workspaceUuid = '20000000-0000-4000-8000-000000000002';
  const gatewayDeviceEui = '0016C001F11715E2';
  database.prepare(
    'INSERT INTO journal_authority_state(' +
      'workspace_uuid,gateway_device_eui,authority_state,state,updated_at' +
    ') VALUES(?,?,\'legacy\',\'BLOCKED\',?)'
  ).run(workspaceUuid, gatewayDeviceEui, '2026-08-08T10:11:12.123Z');

  const result = await lifecycle.emitJournalOutbox(
    db, customSource(gatewayDeviceEui), 'JOURNAL_VOCAB_UPSERTED'
  );
  assert.equal(result.replication_mode, 'v1');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_edge_mutations').get().count, 0);
});

test('blocked authority stays on V2 when its barrier was already recorded', async (t) => {
  const { database, db } = fixture(t);
  const workspaceUuid = '20000000-0000-4000-8000-000000000004';
  const gatewayDeviceEui = '0016C001F11715E2';
  database.prepare(
    'INSERT INTO journal_authority_state(' +
      'workspace_uuid,gateway_device_eui,authority_state,state,barrier_uuid,updated_at' +
    ') VALUES(?,?,\'legacy\',\'BLOCKED\',?,?)'
  ).run(
    workspaceUuid,
    gatewayDeviceEui,
    '90000000-0000-4000-8000-000000000004',
    '2026-08-08T10:11:12.123Z'
  );

  const result = await lifecycle.emitJournalOutbox(
    db, customSource(gatewayDeviceEui), 'JOURNAL_VOCAB_UPSERTED'
  );
  assert.equal(result.replication_mode, 'v2');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_edge_mutations').get().count, 1);
});

test('barrier-recorded local entry queues a validated V2 create without a V1 event', async (t) => {
  const { database, db } = fixture(t);
  const workspaceUuid = '20000000-0000-4000-8000-000000000001';
  const gatewayDeviceEui = '0016C001F11715E2';
  const sourceEntry = JSON.parse(JSON.stringify(golden.mutation_vectors.find(function(vector) {
    return vector.input.operation === 'ENTRY_CREATE';
  }).input.candidate.entry));
  sourceEntry.origin = 'edge-ui';
  sourceEntry.gateway_device_eui = gatewayDeviceEui;
  delete sourceEntry.contract_version;
  delete sourceEntry.values;
  sourceEntry.user_id = 1;
  sourceEntry.zone_id = null;
  database.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,user_uuid) VALUES(1,?,?,?,?)'
  ).run('field-operator', 'test-only', sourceEntry.created_at, sourceEntry.owner_user_uuid);
  const availableColumns = new Set(database.prepare('PRAGMA table_info(journal_entries)').all()
    .map(function(column) { return column.name; }));
  const columns = Object.keys(sourceEntry).filter(function(column) {
    return availableColumns.has(column);
  });
  database.prepare(
    'INSERT INTO journal_entries(' + columns.join(',') + ') VALUES(' +
      columns.map(function() { return '?'; }).join(',') + ')'
  ).run(...columns.map(function(column) { return sourceEntry[column]; }));
  database.prepare(
    'INSERT INTO journal_authority_state(' +
      'workspace_uuid,gateway_device_eui,authority_state,state,updated_at' +
    ') VALUES(?,?,\'legacy\',\'BARRIER_RECORDED\',?)'
  ).run(workspaceUuid, gatewayDeviceEui, sourceEntry.updated_at);

  const result = await lifecycle.emitJournalOutbox(
    db, sourceEntry.entry_uuid, 'JOURNAL_ENTRY_UPSERTED'
  );
  assert.equal(result.replication_mode, 'v2');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sync_outbox').get().count, 0);
  const row = database.prepare(
    'SELECT operation,payload_json FROM journal_edge_mutations'
  ).get();
  const payload = JSON.parse(row.payload_json);
  assert.equal(row.operation, 'ENTRY_CREATE');
  assert.equal(payload.candidate.entry.contract_version, 2);
  assert.equal(payload.candidate.entry.gateway_device_eui, gatewayDeviceEui);
});

test('barrier-recorded correction preserves a cloud-origin entry origin in V2', async (t) => {
  const { database, db } = fixture(t);
  const workspaceUuid = '20000000-0000-4000-8000-000000000003';
  const gatewayDeviceEui = '0016C001F11715E2';
  const sourceEntry = JSON.parse(JSON.stringify(golden.mutation_vectors.find(function(vector) {
    return vector.input.operation === 'ENTRY_CORRECT';
  }).input.candidate.entry));
  sourceEntry.gateway_device_eui = gatewayDeviceEui;
  delete sourceEntry.contract_version;
  delete sourceEntry.values;
  sourceEntry.user_id = 1;
  sourceEntry.plot_uuid = null;
  sourceEntry.zone_id = null;
  database.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,user_uuid) VALUES(1,?,?,?,?)'
  ).run('cloud-origin-operator', 'test-only', sourceEntry.created_at, sourceEntry.owner_user_uuid);
  const availableColumns = new Set(database.prepare('PRAGMA table_info(journal_entries)').all()
    .map(function(column) { return column.name; }));
  const columns = Object.keys(sourceEntry).filter(function(column) {
    return availableColumns.has(column);
  });
  database.prepare(
    'INSERT INTO journal_entries(' + columns.join(',') + ') VALUES(' +
      columns.map(function() { return '?'; }).join(',') + ')'
  ).run(...columns.map(function(column) { return sourceEntry[column]; }));
  database.prepare(
    'INSERT INTO journal_authority_state(' +
      'workspace_uuid,gateway_device_eui,authority_state,state,updated_at' +
    ') VALUES(?,?,\'legacy\',\'BARRIER_RECORDED\',?)'
  ).run(workspaceUuid, gatewayDeviceEui, sourceEntry.updated_at);

  const result = await lifecycle.emitJournalOutbox(
    db, sourceEntry.entry_uuid, 'JOURNAL_ENTRY_UPSERTED'
  );
  const payload = JSON.parse(database.prepare(
    'SELECT payload_json FROM journal_edge_mutations WHERE mutation_uuid=?'
  ).get(result.mutation_uuid).payload_json);
  assert.equal(payload.operation, 'ENTRY_CORRECT');
  assert.equal(payload.origin, 'cloud-ui');
  assert.equal(payload.candidate.entry.origin, 'cloud-ui');
});

// ---------------------------------------------------------------------------
// Journal module gate (owner decision 2026-09-17)
// ---------------------------------------------------------------------------
// Switching the Field Journal module off must stop this worker dead: no HTTP to
// the cloud, no retries, and none of the "Journal cloud request returned HTTP
// 403" noise every 30 s. The gate reads the same gateway-level app_settings row
// the GUI writes through PUT /api/system/settings, and sits ahead of every
// network call -- ahead of config validation too, so a gateway with the module
// off never even has to have a valid worker config.

function countingHttpApi() {
  const calls = [];
  return {
    calls,
    requestJsonIpv4(request) {
      calls.push(request);
      return Promise.resolve({ statusCode: 200, body: {} });
    },
  };
}

// resolveMediaRoot insists on a real, canonical, non-symlink directory, so the
// config a "module on" control test needs has to point at one that exists.
function workerConfig(t) {
  const mediaRoot = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'osi-journal-media-')));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));
  return {
    gateway_device_eui: '0016C001F11715E2',
    server_url: 'https://cloud.example.org',
    sync_token: 'token-abc',
    release_id: '0.7.0',
    schema_fingerprint: 'a'.repeat(64),
    photo_cache_bytes: 1024 * 1024,
    min_free_bytes: 1024 * 1024,
    media_root: mediaRoot,
  };
}

async function setJournalModule(db, value) {
  await db.run(
    "INSERT INTO app_settings(key,value,updated_at) VALUES('journal_module_enabled',?,?) " +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    [value, '2026-09-17T00:00:00.000Z'],
  );
}

test('journalModuleEnabled defaults to true when the setting has never been written', async (t) => {
  const { db } = fixture(t);
  assert.equal(await helper.journalModuleEnabled(db), true);
});

test('journalModuleEnabled reads the gateway-level app_settings row', async (t) => {
  const { db } = fixture(t);
  for (const [stored, expected] of [['0', false], ['1', true], ['false', false], ['true', true]]) {
    await setJournalModule(db, stored);
    assert.equal(await helper.journalModuleEnabled(db), expected, 'stored ' + stored);
  }
});

// Fail open: a gateway whose DB predates the app_settings table (deploys are
// staged) must keep replicating exactly as it does today, not silently stop.
test('journalModuleEnabled fails open when app_settings cannot be read', async () => {
  const brokenDb = {
    get() { return Promise.reject(new Error('SQLITE_ERROR: no such table: app_settings')); },
  };
  assert.equal(await helper.journalModuleEnabled(brokenDb), true);
});

test('runReplicationTick makes zero cloud requests while the journal module is off', async (t) => {
  const { db } = fixture(t);
  await setJournalModule(db, '0');
  const httpApi = countingHttpApi();

  const result = await helper.runReplicationTick(db, httpApi, fs, workerConfig(t));

  assert.deepEqual(httpApi.calls, [], 'the worker must not touch the cloud while the module is off');
  assert.equal(result.capability_state, 'disabled');
  assert.equal(result.sent_mutations, 0);
  assert.equal(result.applied_envelopes, 0);
});

// The gate must sit ahead of validateWorkerConfig: a gateway with the module
// off should go quiet rather than throw an invalid-config error every tick.
test('runReplicationTick with the module off skips config validation instead of throwing', async (t) => {
  const { db } = fixture(t);
  await setJournalModule(db, '0');
  const httpApi = countingHttpApi();

  const result = await helper.runReplicationTick(db, httpApi, fs, { gateway_device_eui: 'nonsense' });

  assert.equal(result.capability_state, 'disabled');
  assert.deepEqual(httpApi.calls, []);
});

// Control: with the module on, the worker still reaches the cloud. Without
// this, the test above would pass just as well against a worker that never
// runs at all.
test('runReplicationTick still probes the cloud while the journal module is on', async (t) => {
  const { db } = fixture(t);
  await setJournalModule(db, '1');
  const httpApi = countingHttpApi();

  helper._resetJournalV2BackoffForTests();
  await helper.runReplicationTick(db, httpApi, fs, workerConfig(t)).catch(() => {});

  assert.ok(httpApi.calls.length > 0, 'the capabilities probe must still be attempted');
  assert.match(String(httpApi.calls[0].url), /\/capabilities$/);
});
