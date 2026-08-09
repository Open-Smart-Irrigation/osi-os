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
