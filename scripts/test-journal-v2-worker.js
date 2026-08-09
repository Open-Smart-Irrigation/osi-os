#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const replication = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication',
));
const golden = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/journal-v2-golden.json'),
  'utf8',
));
const SCHEMA_FINGERPRINT = require('node:crypto').createHash('sha256').update(
  fs.readFileSync(path.join(ROOT, 'docs/contracts/sync-schema/journal-v2.schema.json')),
).digest('hex');
const GATEWAY = '0016C001F11715E2';

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

function config(overrides = {}) {
  return Object.assign({
    gateway_device_eui: GATEWAY,
    server_url: 'https://cloud.example.test',
    sync_token: 'test-sync-token',
    release_id: 'journal-v2-test',
    schema_fingerprint: SCHEMA_FINGERPRINT,
    photo_cache_bytes: 4294967296,
    min_free_bytes: 4294967296,
    media_root: '/tmp',
  }, overrides);
}

function acceptedCapability(overrides = {}) {
  return Object.assign({
    gateway_eui: GATEWAY,
    release_id: 'journal-v2-test',
    schema_fingerprint: SCHEMA_FINGERPRINT,
    schema_accepted: true,
    edge_producer_ready: true,
    cloud_issuer_enabled: false,
    prepare_ready: false,
  }, overrides);
}

function fixture(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-worker-' + name + '-'));
  const databasePath = path.join(directory, 'farming.db');
  const database = new DatabaseSync(databasePath);
  database.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, databasePath, database };
}

function fakeHttp(database, routes, calls) {
  return {
    async requestJsonIpv4(request) {
      calls.push(request);
      for (const route of routes) {
        if (route.match(request)) return route.respond(request, database);
      }
      throw new Error('unexpected request: ' + request.method + ' ' + request.url);
    },
  };
}

test('worker rejects the all-01 provisional gateway identity before any cloud request', async (t) => {
  const { database } = fixture(t, 'invalid-gateway-identity');
  t.after(() => database.close());
  const calls = [];
  const http = fakeHttp(database, [], calls);

  await assert.rejects(
    () => replication.runReplicationTick(
      facade(database), http, fs, config({ gateway_device_eui: '0101010101010101' }),
    ),
    /gateway_device_eui|EUI64/i,
  );
  assert.equal(calls.length, 0);
});

test('accepted capability survives a process restart', async (t) => {
  const { databasePath, database } = fixture(t, 'restart');
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 200, payload: acceptedCapability() }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [] }),
    },
  ], calls);

  await replication.runReplicationTick(facade(database), http, fs, config());
  database.close();

  const reopened = new DatabaseSync(databasePath);
  t.after(() => reopened.close());
  const persisted = reopened.prepare(
    'SELECT offered_fingerprint,accepted_fingerprint,capability_state ' +
      'FROM journal_gateway_v2_capability WHERE gateway_device_eui=?',
  ).get(GATEWAY);
  assert.equal(persisted.offered_fingerprint, SCHEMA_FINGERPRINT);
  assert.equal(persisted.accepted_fingerprint, SCHEMA_FINGERPRINT);
  assert.equal(persisted.capability_state, 'accepted');
});

test('mismatched fingerprint is persisted as rejected and blocks queued producers', async (t) => {
  const { database } = fixture(t, 'mismatch');
  t.after(() => database.close());
  const candidate = structuredClone(golden.mutation_vectors[0].input);
  await replication.enqueueMutation(facade(database), candidate);
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({
        statusCode: 200,
        payload: acceptedCapability({
          schema_fingerprint: 'a'.repeat(64),
          schema_accepted: false,
          edge_producer_ready: false,
        }),
      }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [] }),
    },
  ], calls);

  await replication.runReplicationTick(facade(database), http, fs, config());

  assert.equal(calls.some((request) => request.url.endsWith('/mutations')), false);
  assert.equal(calls.some((request) => request.url.includes('/replication?')), false);
  assert.equal(database.prepare(
    'SELECT capability_state FROM journal_gateway_v2_capability WHERE gateway_device_eui=?',
  ).get(GATEWAY).capability_state, 'rejected');
  assert.equal(database.prepare(
    'SELECT status FROM journal_edge_mutations WHERE mutation_uuid=?',
  ).get(candidate.mutation_uuid).status, 'pending');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_replication_cursor').get().count, 0);
});

test('authority-changing proposals wait for the persisted cloud issuer axis', async (t) => {
  const { database } = fixture(t, 'authority-axis');
  t.after(() => database.close());
  const receipt = structuredClone(golden.mutation_vectors.find(
    (vector) => vector.input.operation === 'CUTOVER_BARRIER_RECEIPT',
  ).input);
  await replication.enqueueMutation(facade(database), receipt);
  const calls = [];
  let issuerEnabled = false;
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({
        statusCode: 200,
        payload: acceptedCapability({
          cloud_issuer_enabled: issuerEnabled,
          prepare_ready: issuerEnabled,
        }),
      }),
    },
    {
      match: (request) => request.url.endsWith('/mutations'),
      respond: (request) => ({
        statusCode: 200,
        payload: structuredClone(golden.result_vectors.find(
          (vector) => vector.input.mutation_uuid === request.payload.mutation_uuid,
        ).input),
      }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [] }),
    },
  ], calls);

  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(calls.filter((request) => request.url.endsWith('/mutations')).length, 0);
  assert.equal(database.prepare('SELECT status FROM journal_edge_mutations').get().status, 'pending');

  issuerEnabled = true;
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(calls.filter((request) => request.url.endsWith('/mutations')).length, 1);
  assert.equal(database.prepare('SELECT status FROM journal_edge_mutations').get().status, 'applied');
});

test('prepare readiness cannot bypass a disabled cloud issuer axis', async (t) => {
  const { database } = fixture(t, 'inconsistent-authority-axes');
  t.after(() => database.close());
  const receipt = structuredClone(golden.mutation_vectors.find(
    (vector) => vector.input.operation === 'CUTOVER_BARRIER_RECEIPT',
  ).input);
  await replication.enqueueMutation(facade(database), receipt);
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({
        statusCode: 200,
        payload: acceptedCapability({
          cloud_issuer_enabled: false,
          prepare_ready: true,
        }),
      }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [] }),
    },
  ], calls);

  await replication.runReplicationTick(facade(database), http, fs, config());

  assert.equal(calls.filter((request) => request.url.endsWith('/mutations')).length, 0);
  assert.equal(database.prepare('SELECT status FROM journal_edge_mutations').get().status, 'pending');
});

test('a gated barrier receipt blocks later queued mutations from overtaking it', async (t) => {
  const { database } = fixture(t, 'barrier-order');
  t.after(() => database.close());
  const receipt = structuredClone(golden.mutation_vectors.find(
    (vector) => vector.input.operation === 'CUTOVER_BARRIER_RECEIPT',
  ).input);
  const later = structuredClone(golden.mutation_vectors.find(
    (vector) => vector.input.operation === 'PRODUCT_UPSERT',
  ).input);
  await replication.enqueueMutation(facade(database), receipt);
  await replication.enqueueMutation(facade(database), later);
  database.prepare(
    'UPDATE journal_edge_mutations SET created_at=? WHERE mutation_uuid=?',
  ).run('2026-08-08T10:00:00.000Z', receipt.mutation_uuid);
  database.prepare(
    'UPDATE journal_edge_mutations SET created_at=? WHERE mutation_uuid=?',
  ).run('2026-08-08T10:00:01.000Z', later.mutation_uuid);
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 200, payload: acceptedCapability() }),
    },
    {
      match: (request) => request.url.endsWith('/mutations'),
      respond: () => ({
        statusCode: 200,
        payload: structuredClone(golden.result_vectors.find(
          (vector) => vector.input.mutation_uuid === later.mutation_uuid,
        ).input),
      }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [] }),
    },
  ], calls);

  await replication.runReplicationTick(facade(database), http, fs, config());

  assert.equal(calls.filter((request) => request.url.endsWith('/mutations')).length, 0);
  assert.deepEqual(database.prepare(
    'SELECT status FROM journal_edge_mutations ORDER BY created_at',
  ).all().map((row) => row.status), ['pending', 'pending']);
});

test('authority envelopes remain uncommitted until the cloud issuer axis is enabled', async (t) => {
  const { database } = fixture(t, 'authority-envelope-axis');
  t.after(() => database.close());
  const authority = structuredClone(golden.replication_vectors.find(
    (vector) => vector.input.kind === 'AUTHORITY_STATE',
  ).input);
  authority.sequence = '1';
  let issuerEnabled = false;
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({
        statusCode: 200,
        payload: acceptedCapability({
          cloud_issuer_enabled: issuerEnabled,
          prepare_ready: issuerEnabled,
        }),
      }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [authority] }),
    },
    {
      match: (request) => request.url.endsWith('/replication/ack'),
      respond: (request) => ({
        statusCode: 200,
        payload: { committed_sequence: request.payload.committed_sequence },
      }),
    },
  ], calls);

  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_authority_state').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_replication_cursor').get().count, 0);
  assert.equal(calls.filter((request) => request.url.endsWith('/replication/ack')).length, 0);

  issuerEnabled = true;
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(database.prepare('SELECT state FROM journal_authority_state').get().state, 'PREPARE_REQUESTED');
  assert.equal(database.prepare('SELECT sequence FROM journal_replication_cursor').get().sequence, '1');
  assert.equal(calls.filter((request) => request.url.endsWith('/replication/ack')).length, 1);
});

test('a malformed authority envelope fails closed even while the issuer axis is disabled', async (t) => {
  const { database } = fixture(t, 'malformed-authority-envelope');
  t.after(() => database.close());
  const malformed = {
    kind: 'AUTHORITY_STATE',
    sequence: '1',
  };
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 200, payload: acceptedCapability() }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [malformed] }),
    },
  ], calls);

  await assert.rejects(
    () => replication.runReplicationTick(facade(database), http, fs, config()),
    /replication envelope|workspace_uuid|keys/i,
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM journal_replication_cursor').get().count, 0);
});

test('replication ACK is sent only after the envelope and cursor commit', async (t) => {
  const { database } = fixture(t, 'ack-order');
  t.after(() => database.close());
  const head = structuredClone(golden.replication_vectors[0].input);
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 200, payload: acceptedCapability() }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [head] }),
    },
    {
      match: (request) => request.url.endsWith('/replication/ack'),
      respond: (request, liveDatabase) => {
        assert.equal(liveDatabase.prepare(
          'SELECT sequence FROM journal_replication_cursor WHERE workspace_uuid=?',
        ).get(head.workspace_uuid).sequence, head.sequence);
        assert.equal(request.payload.committed_sequence, head.sequence);
        return { statusCode: 200, payload: { committed_sequence: head.sequence } };
      },
    },
  ], calls);

  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(calls.filter((request) => request.url.endsWith('/replication/ack')).length, 1);
});

test('a lost ACK is retried from the durable cursor when the next page is empty', async (t) => {
  const { database } = fixture(t, 'ack-retry');
  t.after(() => database.close());
  const head = structuredClone(golden.replication_vectors[0].input);
  let pageCount = 0;
  let ackCount = 0;
  let serverAck = '0';
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 200, payload: acceptedCapability() }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: (request) => {
        const after = new URL(request.url).searchParams.get('after');
        if (after !== serverAck) {
          return { statusCode: 400, payload: { error: 'cursor_ack_mismatch' } };
        }
        return { statusCode: 200, payload: pageCount++ === 0 ? [head] : [] };
      },
    },
    {
      match: (request) => request.url.endsWith('/replication/ack'),
      respond: (request) => {
        ackCount += 1;
        assert.equal(request.payload.committed_sequence, '1');
        if (ackCount === 1) throw new Error('injected ACK loss');
        serverAck = request.payload.committed_sequence;
        return { statusCode: 200, payload: { committed_sequence: '1' } };
      },
    },
  ], calls);

  await assert.rejects(
    () => replication.runReplicationTick(facade(database), http, fs, config()),
    /injected ACK loss/,
  );
  assert.equal(database.prepare('SELECT sequence FROM journal_replication_cursor').get().sequence, '1');

  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(ackCount, 2);
  assert.equal(serverAck, '1');
});
