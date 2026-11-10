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
const { settingForField } = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-module-defaults',
));
const JOURNAL_MODULE_ENABLED_KEY = settingForField('journalModuleEnabled').key;
const golden = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/journal-v2-golden.json'),
  'utf8',
));
const SCHEMA_FINGERPRINT = require('node:crypto').createHash('sha256').update(
  fs.readFileSync(path.join(ROOT, 'docs/contracts/sync-schema/journal-v2.schema.json')),
).digest('hex');
const GATEWAY = 'AABBCCDDEEFF0003';

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
  // This suite exercises runReplicationTick's actual replication behavior,
  // which is gated on the journal module being on (osi-module-defaults). A
  // customer branch may ship that module off by default (an explicit,
  // supported product choice -- see osi-module-defaults/index.js); write the
  // row explicitly here so these tests keep proving the ON-path behavior
  // regardless of what a given branch's shipped default is, exactly as a
  // customer who flips the switch back on would see.
  database.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
    .run(JOURNAL_MODULE_ENABLED_KEY, 'true');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// #251 backoff tests use tiny real windows (the module reads these env vars
// live, not at module load) so the tests stay fast and deterministic without
// mocking Date.
function withTinyJournalBackoff(t, { initialMs = 20, capMs = 50 } = {}) {
  const previousInitial = process.env.JOURNAL_V2_BACKOFF_INITIAL_MS;
  const previousCap = process.env.JOURNAL_V2_BACKOFF_CAP_MS;
  process.env.JOURNAL_V2_BACKOFF_INITIAL_MS = String(initialMs);
  process.env.JOURNAL_V2_BACKOFF_CAP_MS = String(capMs);
  t.after(() => {
    if (previousInitial === undefined) delete process.env.JOURNAL_V2_BACKOFF_INITIAL_MS;
    else process.env.JOURNAL_V2_BACKOFF_INITIAL_MS = previousInitial;
    if (previousCap === undefined) delete process.env.JOURNAL_V2_BACKOFF_CAP_MS;
    else process.env.JOURNAL_V2_BACKOFF_CAP_MS = previousCap;
    replication._resetJournalV2BackoffForTests();
  });
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

test('JOURNAL_REPLICATION_DISABLE=1 makes the tick a quiet no-op before any validation or cloud call, even with a bogus media root', async (t) => {
  const { database } = fixture(t, 'runtime-disabled');
  t.after(() => database.close());
  const previous = process.env.JOURNAL_REPLICATION_DISABLE;
  process.env.JOURNAL_REPLICATION_DISABLE = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.JOURNAL_REPLICATION_DISABLE;
    else process.env.JOURNAL_REPLICATION_DISABLE = previous;
  });
  const calls = [];
  const http = fakeHttp(database, [], calls);

  // media_root is empty (what node-red.init exports on validation failure)
  // and would throw inside validateWorkerConfig()/resolveMediaRoot() if the
  // disable flag were not honored first.
  const result = await replication.runReplicationTick(facade(database), http, fs, config({ media_root: '' }));

  assert.deepEqual(result, {
    capability_state: 'disabled',
    sent_mutations: 0,
    applied_envelopes: 0,
    committed_sequence: null,
    photo_transfers: 0,
    evicted_media: 0,
  });
  assert.equal(calls.length, 0);
});

test('JOURNAL_REPLICATION_DISABLE unset or any value other than the literal "1" runs the tick normally', async (t) => {
  const { database } = fixture(t, 'runtime-not-disabled');
  t.after(() => database.close());
  const previous = process.env.JOURNAL_REPLICATION_DISABLE;
  t.after(() => {
    if (previous === undefined) delete process.env.JOURNAL_REPLICATION_DISABLE;
    else process.env.JOURNAL_REPLICATION_DISABLE = previous;
  });
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

  delete process.env.JOURNAL_REPLICATION_DISABLE;
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.ok(calls.length > 0);

  process.env.JOURNAL_REPLICATION_DISABLE = '0';
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.ok(calls.length > 1);
});

test('a 404 from /capabilities before any local link has ever existed is a quiet, retryable "not linked" skip', async (t) => {
  const { database } = fixture(t, 'capabilities-404-never-linked');
  t.after(() => database.close());
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 404, payload: { error: 'gateway_workspace_not_found' } }),
    },
  ], calls);

  let caught = null;
  try {
    await replication.runReplicationTick(facade(database), http, fs, config());
    assert.fail('expected runReplicationTick to reject');
  } catch (cause) {
    caught = cause;
  }
  assert.equal(caught.code, 'workspace_not_linked');
  assert.equal(caught.retryable, true);
  // Only the one capabilities probe happened -- no mutation/replication calls
  // were attempted, and nothing was persisted for the never-linked case.
  assert.equal(calls.length, 1);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM journal_gateway_v2_capability').get().count,
    0,
  );
});

test('a 404 from /capabilities after a prior successful link is a loud, non-retryable failure', async (t) => {
  const { database } = fixture(t, 'capabilities-404-link-lost');
  t.after(() => database.close());
  // journal_gateway_v2_capability only ever gains a row for this
  // gateway_device_eui after a *successful* (200) capabilities response, so
  // seeding it here simulates "this gateway had a working link before".
  database.prepare(
    'INSERT INTO journal_gateway_v2_capability(' +
      'gateway_device_eui,offered_fingerprint,accepted_fingerprint,capability_state,updated_at' +
    ') VALUES(?,?,?,?,?)',
  ).run(GATEWAY, SCHEMA_FINGERPRINT, SCHEMA_FINGERPRINT, 'accepted', '2026-08-01T00:00:00.000Z');
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 404, payload: { error: 'gateway_workspace_not_found' } }),
    },
  ], calls);

  let caught = null;
  try {
    await replication.runReplicationTick(facade(database), http, fs, config());
    assert.fail('expected runReplicationTick to reject');
  } catch (cause) {
    caught = cause;
  }
  assert.equal(caught.code, 'workspace_link_lost');
  assert.equal(Boolean(caught.retryable), false);
});

test('a 403 from /capabilities marks the cloud journal-unsupported and stops calling it within the backoff window (#251)', async (t) => {
  const { database } = fixture(t, 'capabilities-403-backoff');
  t.after(() => database.close());
  withTinyJournalBackoff(t, { initialMs: 200, capMs: 200 });
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 403, payload: { error: 'forbidden' } }),
    },
  ], calls);

  let first = null;
  try {
    await replication.runReplicationTick(facade(database), http, fs, config());
    assert.fail('expected runReplicationTick to reject');
  } catch (cause) {
    first = cause;
  }
  assert.equal(first.code, 'journal_unsupported');
  assert.equal(first.journalUnsupported, true);
  assert.equal(first.attempted, true);
  assert.equal(first.message, 'cloud rejected journal replication (HTTP 403)');
  assert.equal(calls.length, 1, 'the first 403 is one real capabilities attempt');
  // Nothing is persisted for an unsupported cloud -- there is no accepted
  // capability relationship to record.
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM journal_gateway_v2_capability').get().count,
    0,
  );

  // Immediately retrying, still well inside the backoff window, must not
  // make a second HTTP call at all -- this is the observed #251 symptom
  // (a warn/HTTP round trip every 30s against a cloud that will never
  // support Journal V2 until it is upgraded).
  let second = null;
  try {
    await replication.runReplicationTick(facade(database), http, fs, config());
    assert.fail('expected runReplicationTick to reject while backed off');
  } catch (cause) {
    second = cause;
  }
  assert.equal(second.code, 'journal_unsupported');
  assert.equal(second.attempted, false, 'a backed-off tick must not have attempted a cloud call');
  assert.equal(calls.length, 1, 'no additional HTTP call was made while backed off');
});

test('the journal-unsupported backoff clears on the first 2xx and a later 403 restarts at the initial window (#251)', async (t) => {
  const { database } = fixture(t, 'capabilities-403-then-2xx-then-403');
  t.after(() => database.close());
  withTinyJournalBackoff(t, { initialMs: 30, capMs: 10000 });
  let mode = 'reject';
  const calls = [];
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => (mode === 'reject'
        ? { statusCode: 403, payload: { error: 'forbidden' } }
        : { statusCode: 200, payload: acceptedCapability() }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [] }),
    },
  ], calls);

  await assert.rejects(
    () => replication.runReplicationTick(facade(database), http, fs, config()),
    (cause) => cause.code === 'journal_unsupported' && cause.attempted === true,
  );
  assert.equal(calls.length, 1);

  // Let the tiny backoff window elapse, then succeed -- this must clear the
  // backoff state for this link entirely.
  await sleep(60);
  mode = 'accept';
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(result.capability_state, 'accepted');
  assert.ok(calls.length > 1, 'the tick attempted the cloud again once the window elapsed');

  // A subsequent 403 must restart at the initial backoff window rather than
  // continuing any prior doubled state -- proven by immediately retrying
  // and observing a fresh backoff (attempted:false) without needing to wait
  // out a longer, previously-doubled interval.
  mode = 'reject';
  const callsBeforeThirdAttempt = calls.length;
  await assert.rejects(
    () => replication.runReplicationTick(facade(database), http, fs, config()),
    (cause) => cause.code === 'journal_unsupported' && cause.attempted === true && cause.backoffMs === 30,
  );
  assert.equal(calls.length, callsBeforeThirdAttempt + 1);
});

test('repeated 403s double the backoff window up to the configured cap (#251)', async (t) => {
  const { database } = fixture(t, 'capabilities-403-doubling');
  t.after(() => database.close());
  withTinyJournalBackoff(t, { initialMs: 20, capMs: 50 });
  const http = fakeHttp(database, [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 403, payload: { error: 'forbidden' } }),
    },
  ], []);

  const observedBackoffs = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await assert.rejects(
      () => replication.runReplicationTick(facade(database), http, fs, config()),
      (cause) => {
        if (cause.attempted) observedBackoffs.push(cause.backoffMs);
        return true;
      },
    );
    // Sleep past whatever the current backoff window is so the next
    // iteration always represents a fresh, real attempt.
    await sleep(60);
  }
  assert.deepEqual(observedBackoffs, [20, 40, 50, 50]);
});

function entryBatchRoutes(primary, batchResponses) {
  return [
    {
      match: (request) => request.url.endsWith('/capabilities') &&
        request.payload.release_id === 'journal_entry_batch_v1',
      respond: (request) => batchResponses(request),
    },
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 200, payload: primary }),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [] }),
    },
  ];
}

function batchCapabilityAnswer(request) {
  return {
    statusCode: 200,
    payload: acceptedCapability({
      release_id: 'journal_entry_batch_v1',
      edge_producer_ready: request.payload.edge_producer_ready,
    }),
  };
}

test('an accepted gateway advertises the journal entry batch release it can apply', async (t) => {
  const { database } = fixture(t, 'entry-batch-advertised');
  t.after(() => database.close());
  replication._resetJournalV2BackoffForTests();
  t.after(() => replication._resetJournalV2BackoffForTests());
  const calls = [];
  const http = fakeHttp(database, entryBatchRoutes(acceptedCapability(), batchCapabilityAnswer), calls);

  const result = await replication.runReplicationTick(facade(database), http, fs, config());

  const advertisements = calls.filter((request) => request.url.endsWith('/capabilities') &&
    request.payload.release_id === 'journal_entry_batch_v1');
  assert.equal(advertisements.length, 1);
  assert.equal(advertisements[0].method, 'POST');
  assert.equal(advertisements[0].payload.schema_fingerprint, SCHEMA_FINGERPRINT);
  assert.equal(advertisements[0].payload.edge_producer_ready, true);
  assert.match(advertisements[0].payload.advertised_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.entry_batch_capability, 'advertised');

  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(calls.filter((request) => request.payload &&
    request.payload.release_id === 'journal_entry_batch_v1').length, 1,
  'an unchanged advertisement is not repeated on every tick');
});

test('a rejected journal contract never advertises the entry batch release', async (t) => {
  const { database } = fixture(t, 'entry-batch-rejected-contract');
  t.after(() => database.close());
  replication._resetJournalV2BackoffForTests();
  t.after(() => replication._resetJournalV2BackoffForTests());
  const calls = [];
  const http = fakeHttp(database, entryBatchRoutes(acceptedCapability({
    schema_fingerprint: 'a'.repeat(64), schema_accepted: false, edge_producer_ready: false,
  }), batchCapabilityAnswer), calls);

  const result = await replication.runReplicationTick(facade(database), http, fs, config());

  assert.equal(calls.some((request) => request.payload &&
    request.payload.release_id === 'journal_entry_batch_v1'), false);
  assert.equal(result.entry_batch_capability, 'not_advertised');
});

test('a failed entry batch advertisement is reported, backed off and retried without stopping replication', async (t) => {
  const { database } = fixture(t, 'entry-batch-advertisement-failed');
  t.after(() => database.close());
  replication._resetJournalV2BackoffForTests();
  t.after(() => replication._resetJournalV2BackoffForTests());
  withTinyJournalBackoff(t, { initialMs: 40, capMs: 1000 });
  let answer = () => ({ statusCode: 500, payload: { error: 'unavailable' } });
  const calls = [];
  const http = fakeHttp(database, entryBatchRoutes(acceptedCapability(), (request) => answer(request)), calls);

  const failed = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(failed.capability_state, 'accepted');
  assert.equal(failed.entry_batch_capability, 'failed:transient_cloud_failure');
  assert.ok(calls.some((request) => request.url.includes('/replication?')), 'replication still ran');

  const batchPosts = () => calls.filter((request) => request.payload &&
    request.payload.release_id === 'journal_entry_batch_v1').length;
  const postsAfterFailure = batchPosts();
  const backedOff = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(backedOff.entry_batch_capability, 'backoff');
  assert.equal(batchPosts(), postsAfterFailure, 'no new advertisement inside the backoff window');

  await sleep(60);
  answer = batchCapabilityAnswer;
  const retried = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(retried.entry_batch_capability, 'advertised');
});

// ---------------------------------------------------------------------------
// #447: a mutation the cloud refuses with a 4xx must not block later ones.
// ---------------------------------------------------------------------------

const REJECTION_GOLDEN = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs/contracts/sync-schema/journal-mutation-rejection-v1-golden.json'),
  'utf8',
));
const REJECTED_UNTIL = '9999-12-31T23:59:59.999Z';
const HOLD_INITIAL_MS = 15 * 60 * 1000;

function goldenMutation(operation) {
  return structuredClone(golden.mutation_vectors.find(
    (vector) => vector.input.operation === operation,
  ).input);
}

function goldenResult(mutationUuid) {
  return structuredClone(golden.result_vectors.find(
    (vector) => vector.input.mutation_uuid === mutationUuid,
  ).input);
}

async function queueInOrder(database, mutations) {
  for (const [index, mutation] of mutations.entries()) {
    await replication.enqueueMutation(facade(database), mutation);
    database.prepare(
      'UPDATE journal_edge_mutations SET created_at=? WHERE mutation_uuid=?',
    ).run('2026-08-08T10:00:0' + index + '.000Z', mutation.mutation_uuid);
  }
}

function boundReceipt(mutation, overrides = {}) {
  return Object.assign({
    kind: 'JOURNAL_MUTATION_REJECTION',
    version: 1,
    mutation_uuid: mutation.mutation_uuid,
    workspace_uuid: mutation.workspace_uuid,
    operation: mutation.operation,
    resource_uuid: mutation.resource.entry_uuid,
    payload_sha256: mutation.payload_sha256,
    actor_type: 'gateway',
    actor_identifier: GATEWAY,
    disposition: 'not_applied',
    code: 'entry_plot_required_for_final',
    message: 'plot_uuid is required for non-farm-wide final entries',
    field_paths: ['/candidate/entry/plot_uuid'],
  }, overrides);
}

function refusalRoutes(mutationAnswer, capability = acceptedCapability()) {
  return [
    {
      match: (request) => request.url.endsWith('/capabilities'),
      respond: () => ({ statusCode: 200, payload: capability }),
    },
    {
      match: (request) => request.url.endsWith('/mutations'),
      respond: (request) => mutationAnswer(request),
    },
    {
      match: (request) => request.url.includes('/replication?'),
      respond: () => ({ statusCode: 200, payload: [] }),
    },
  ];
}

function queueRow(database, mutationUuid) {
  return database.prepare(
    'SELECT status,attempts,next_attempt_at,last_error FROM journal_edge_mutations WHERE mutation_uuid=?',
  ).get(mutationUuid);
}

function mutationPosts(calls) {
  return calls.filter((request) => request.url.endsWith('/mutations'))
    .map((request) => request.payload.mutation_uuid);
}

function refusalDetail(row) {
  const detail = JSON.parse(row.last_error);
  assert.match(detail.refused_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  delete detail.refused_at;
  return detail;
}

function assertHeldFor(row, delayMs, before, after) {
  const due = Date.parse(row.next_attempt_at);
  assert.ok(due >= before + delayMs && due <= after + delayMs,
    'next_attempt_at ' + row.next_attempt_at + ' is not now + ' + delayMs + ' ms');
}

function resetEach(t) {
  replication._resetJournalV2BackoffForTests();
  t.after(() => replication._resetJournalV2BackoffForTests());
}

test('a generic 400 on one mutation holds it and the next queued mutation is still sent (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'refusal-generic-400');
  t.after(() => database.close());
  const create = goldenMutation('ENTRY_CREATE');
  const product = goldenMutation('PRODUCT_UPSERT');
  await queueInOrder(database, [create, product]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes((request) => (
    request.payload.mutation_uuid === create.mutation_uuid
      ? { statusCode: 400, payload: { error: 'invalid_journal_v2_request' } }
      : { statusCode: 200, payload: goldenResult(product.mutation_uuid) }
  )), calls);
  const before = Date.now();
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  const after = Date.now();
  assert.deepEqual(mutationPosts(calls), [create.mutation_uuid, product.mutation_uuid]);
  assert.equal(queueRow(database, product.mutation_uuid).status, 'already-applied');
  const row = queueRow(database, create.mutation_uuid);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assertHeldFor(row, HOLD_INITIAL_MS, before, after);
  assert.deepEqual(refusalDetail(row), {
    state: 'held', http_status: 400, code: 'invalid_journal_v2_request',
    message: 'invalid_journal_v2_request', field_paths: [],
  });
  assert.equal(result.sent_mutations, 1);
  assert.equal(result.held_mutations, 1);
  assert.equal(result.rejected_mutations, 0);
  assert.deepEqual(result.mutation_queue, { queued: 0, held: 1, rejected: 0, blocked: 0 });
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(mutationPosts(calls).length, 2);
});

test('a held mutation is retried after its hold, the hold doubles, and a later success clears it (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'refusal-hold-retry');
  t.after(() => database.close());
  const create = goldenMutation('ENTRY_CREATE');
  await queueInOrder(database, [create]);
  let answer = () => ({
    statusCode: 404,
    payload: {
      timestamp: '2026-11-10T00:00:00.000Z',
      status: 404,
      error: 'Not Found',
      path: '/api/v2/journal/gateways/AABBCCDDEEFF0003/mutations',
    },
  });
  const calls = [];
  const http = fakeHttp(database, refusalRoutes((request) => answer(request)), calls);
  let before = Date.now();
  await replication.runReplicationTick(facade(database), http, fs, config());
  let after = Date.now();
  let row = queueRow(database, create.mutation_uuid);
  assert.equal(row.attempts, 1);
  assertHeldFor(row, HOLD_INITIAL_MS, before, after);
  assert.deepEqual(refusalDetail(row), {
    state: 'held', http_status: 404, code: 'http_404', message: 'Not Found', field_paths: [],
  });
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(mutationPosts(calls).length, 1);
  const moveDueToPast = () => database.prepare(
    "UPDATE journal_edge_mutations SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE mutation_uuid=?",
  ).run(create.mutation_uuid);
  moveDueToPast();
  before = Date.now();
  await replication.runReplicationTick(facade(database), http, fs, config());
  after = Date.now();
  row = queueRow(database, create.mutation_uuid);
  assert.equal(mutationPosts(calls).length, 2);
  assert.equal(row.attempts, 2);
  assertHeldFor(row, 2 * HOLD_INITIAL_MS, before, after);
  answer = () => ({ statusCode: 201, payload: goldenResult(create.mutation_uuid) });
  moveDueToPast();
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  row = queueRow(database, create.mutation_uuid);
  assert.equal(row.status, 'applied');
  assert.equal(row.last_error, null);
  assert.deepEqual(result.mutation_queue, { queued: 0, held: 0, rejected: 0, blocked: 0 });
});

test('a rejection receipt bound to the mutation marks it rejected with the cloud code, message and field paths (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'refusal-receipt');
  t.after(() => database.close());
  const create = goldenMutation('ENTRY_CREATE');
  const product = goldenMutation('PRODUCT_UPSERT');
  await queueInOrder(database, [create, product]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes((request) => (
    request.payload.mutation_uuid === create.mutation_uuid
      ? { statusCode: 400, payload: boundReceipt(create) }
      : { statusCode: 200, payload: goldenResult(product.mutation_uuid) }
  )), calls);
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [create.mutation_uuid, product.mutation_uuid]);
  assert.equal(queueRow(database, product.mutation_uuid).status, 'already-applied');
  const row = queueRow(database, create.mutation_uuid);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.next_attempt_at, REJECTED_UNTIL);
  assert.deepEqual(refusalDetail(row), {
    state: 'rejected', http_status: 400, code: 'entry_plot_required_for_final',
    message: 'plot_uuid is required for non-farm-wide final entries',
    field_paths: ['/candidate/entry/plot_uuid'],
  });
  assert.equal(result.rejected_mutations, 1);
  assert.equal(result.held_mutations, 0);
  assert.deepEqual(result.mutation_queue, { queued: 0, held: 0, rejected: 1, blocked: 0 });
  assert.deepEqual(
    await replication.mutationQueueHealth(facade(database)),
    { queued: 0, held: 0, rejected: 1, blocked: 0 },
  );
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.equal(mutationPosts(calls).length, 2);
  assert.deepEqual(await replication.nextMutations(facade(database), 10), []);
});

test('a receipt that does not bind to the mutation, or arrives on another status, is only a hold (#447)', async (t) => {
  resetEach(t);
  const create = goldenMutation('ENTRY_CREATE');
  const variants = [
    { statusCode: 400, payload: boundReceipt(create, { payload_sha256: 'b'.repeat(64) }) },
    { statusCode: 400, payload: boundReceipt(create, { actor_identifier: '0016C001F1000001' }) },
    { statusCode: 400, payload: boundReceipt(create, { mutation_uuid: '10000000-0000-4000-8000-000000000447' }) },
    { statusCode: 400, payload: boundReceipt(create, { code: 'dependency_unavailable' }) },
    { statusCode: 422, payload: boundReceipt(create) },
  ];
  for (const [index, variant] of variants.entries()) {
    const { database } = fixture(t, 'refusal-unbound-' + index);
    t.after(() => database.close());
    await queueInOrder(database, [goldenMutation('ENTRY_CREATE')]);
    const calls = [];
    const http = fakeHttp(database, refusalRoutes(() => variant), calls);
    await replication.runReplicationTick(facade(database), http, fs, config());
    const row = queueRow(database, create.mutation_uuid);
    assert.equal(row.attempts, 1);
    assert.equal(JSON.parse(row.last_error).state, 'held');
    assert.notEqual(row.next_attempt_at, REJECTED_UNTIL);
    assert.equal(JSON.parse(row.last_error).http_status, variant.statusCode);
  }
});

test('credential, timeout, rate-limit and server errors on a mutation still stop the tick and leave the row untouched (#447)', async (t) => {
  resetEach(t);
  for (const [status, expectedCode] of [
    [401, 'cloud_protocol_failure'],
    [403, 'cloud_protocol_failure'],
    [408, 'cloud_protocol_failure'],
    [429, 'transient_cloud_failure'],
    [500, 'transient_cloud_failure'],
    [503, 'transient_cloud_failure'],
  ]) {
    const { database } = fixture(t, 'refusal-guard-' + status);
    t.after(() => database.close());
    const create = goldenMutation('ENTRY_CREATE');
    const product = goldenMutation('PRODUCT_UPSERT');
    await queueInOrder(database, [create, product]);
    const calls = [];
    const http = fakeHttp(database, refusalRoutes((request) => (
      request.payload.mutation_uuid === create.mutation_uuid
        ? { statusCode: status, payload: { error: 'x' } }
        : { statusCode: 200, payload: goldenResult(product.mutation_uuid) }
    )), calls);
    await assert.rejects(
      () => replication.runReplicationTick(facade(database), http, fs, config()),
      (cause) => cause.code === expectedCode,
    );
    assert.deepEqual(mutationPosts(calls), [create.mutation_uuid]);
    const row = queueRow(database, create.mutation_uuid);
    assert.equal(row.attempts, 0);
    assert.equal(row.next_attempt_at, null);
    assert.equal(row.last_error, null);
    assert.equal(queueRow(database, product.mutation_uuid).status, 'pending');
  }
});

test('a refused barrier receipt still blocks later mutations (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'refusal-barrier');
  t.after(() => database.close());
  const barrier = goldenMutation('CUTOVER_BARRIER_RECEIPT');
  const product = goldenMutation('PRODUCT_UPSERT');
  await queueInOrder(database, [barrier, product]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes((request) => (
    request.payload.mutation_uuid === barrier.mutation_uuid
      ? { statusCode: 400, payload: { error: 'invalid_journal_v2_request' } }
      : { statusCode: 200, payload: goldenResult(product.mutation_uuid) }
  ), acceptedCapability({ cloud_issuer_enabled: true, prepare_ready: true })), calls);
  await assert.rejects(
    () => replication.runReplicationTick(facade(database), http, fs, config()),
    (cause) => cause.code === 'cloud_protocol_failure' && cause.status === 400,
  );
  assert.deepEqual(mutationPosts(calls), [barrier.mutation_uuid]);
  const row = queueRow(database, barrier.mutation_uuid);
  assert.equal(row.attempts, 0);
  assert.equal(row.next_attempt_at, null);
  assert.equal(row.last_error, null);
});

test('the rejection receipt check accepts every valid golden vector and refuses every invalid one (#447)', () => {
  assert.equal(REJECTION_GOLDEN.valid_vectors.length, 4);
  assert.equal(REJECTION_GOLDEN.invalid_vectors.length, 16);
  for (const vector of REJECTION_GOLDEN.valid_vectors) {
    assert.equal(replication.isMutationRejectionReceipt(vector.input), true, vector.name);
  }
  for (const vector of REJECTION_GOLDEN.invalid_vectors) {
    assert.equal(replication.isMutationRejectionReceipt(vector.input), false, vector.name);
  }
  for (const value of [null, 'text', []]) {
    assert.equal(replication.isMutationRejectionReceipt(value), false);
  }
});

// ---------------------------------------------------------------------------
// #447 amendment 1: a held or rejected mutation fences later mutations of the
// same workspace and resource; other resources keep flowing.
// ---------------------------------------------------------------------------

const replicationCanonicalizer = require(path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication/canonicalization',
));
const GENERIC_400 = { statusCode: 400, payload: { error: 'invalid_journal_v2_request' } };

function variantOf(mutation, mutationUuid, edit) {
  const next = structuredClone(mutation);
  next.mutation_uuid = mutationUuid;
  edit(next);
  next.payload_sha256 = replicationCanonicalizer.hashMutation(next);
  return next;
}

function appliedResult(mutation) {
  const resource = mutation.resource;
  if (mutation.operation.startsWith('ENTRY_')) {
    return {
      kind: 'ENTRY_MUTATION_RESULT',
      mutation_uuid: mutation.mutation_uuid,
      outcome: 'applied',
      head: { entry_uuid: resource.entry_uuid, version: resource.base_version + 1 },
      revision_uuid: '40000000-0000-4000-8000-00000000044' + String(resource.base_version + 1),
      conflict_uuid: null,
    };
  }
  if (mutation.operation === 'PLOT_SNAPSHOT') {
    return {
      kind: 'PLOT_SNAPSHOT_RESULT',
      mutation_uuid: mutation.mutation_uuid,
      outcome: 'applied',
      projection_version: resource.projection_version,
    };
  }
  return {
    kind: 'REFERENCE_MUTATION_RESULT',
    mutation_uuid: mutation.mutation_uuid,
    outcome: 'applied',
    resource_uuid: resource.product_uuid || resource.custom_field_uuid,
  };
}

// The cloud answers GENERIC_400 to every mutation UUID in `refused` and
// applies every other mutation.
function refuseOnly(refused) {
  return (request) => (refused.has(request.payload.mutation_uuid)
    ? GENERIC_400
    : { statusCode: 201, payload: appliedResult(request.payload) });
}

function assertUntouched(database, mutation) {
  const row = queueRow(database, mutation.mutation_uuid);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
  assert.equal(row.next_attempt_at, null);
  assert.equal(row.last_error, null);
}

test('a held mutation fences a later mutation of the same resource in the same tick, and other resources still go (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'fence-same-tick');
  t.after(() => database.close());
  const create = goldenMutation('ENTRY_CREATE');
  const correct = goldenMutation('ENTRY_CORRECT');
  const product = goldenMutation('PRODUCT_UPSERT');
  await queueInOrder(database, [create, correct, product]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes(refuseOnly(new Set([create.mutation_uuid]))), calls);
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [create.mutation_uuid, product.mutation_uuid]);
  assert.equal(JSON.parse(queueRow(database, create.mutation_uuid).last_error).state, 'held');
  assertUntouched(database, correct);
  assert.equal(queueRow(database, product.mutation_uuid).status, 'applied');
  assert.equal(result.sent_mutations, 1);
  assert.equal(result.held_mutations, 1);
  assert.deepEqual(result.mutation_queue, { queued: 0, held: 1, rejected: 0, blocked: 1 });
});

test('a successor queued while its head is held is not sent on a later tick (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'fence-later-tick');
  t.after(() => database.close());
  const create = goldenMutation('ENTRY_CREATE');
  const correct = goldenMutation('ENTRY_CORRECT');
  await queueInOrder(database, [create]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes(refuseOnly(new Set([create.mutation_uuid]))), calls);
  await replication.runReplicationTick(facade(database), http, fs, config());
  await replication.enqueueMutation(facade(database), correct);
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [create.mutation_uuid]);
  assertUntouched(database, correct);
  assert.deepEqual(
    (await replication.nextMutations(facade(database), 10)).map((mutation) => mutation.mutation_uuid),
    [correct.mutation_uuid],
  );
  assert.deepEqual(result.mutation_queue, { queued: 0, held: 1, rejected: 0, blocked: 1 });
});

test('reference updates and newer plot snapshots wait behind their held predecessor (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'fence-reference-plot');
  t.after(() => database.close());
  const product = goldenMutation('PRODUCT_UPSERT');
  const plot = goldenMutation('PLOT_SNAPSHOT');
  const productUpdate = variantOf(product, '10000000-0000-4000-8000-000000004471', (next) => {
    next.resource.base_version = 1;
    next.candidate.product.sync_version = 2;
  });
  const newerPlot = variantOf(plot, '10000000-0000-4000-8000-000000004472', (next) => {
    next.resource.projection_version += 1;
    next.candidate.plot.sync_version += 1;
  });
  const create = goldenMutation('ENTRY_CREATE');
  await queueInOrder(database, [product, plot, productUpdate, newerPlot, create]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes(refuseOnly(new Set([
    product.mutation_uuid, plot.mutation_uuid,
  ]))), calls);
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [
    product.mutation_uuid, plot.mutation_uuid, create.mutation_uuid,
  ]);
  assertUntouched(database, productUpdate);
  assertUntouched(database, newerPlot);
  assert.equal(queueRow(database, create.mutation_uuid).status, 'applied');
  assert.deepEqual(result.mutation_queue, { queued: 0, held: 2, rejected: 0, blocked: 2 });
});

test('a held head that later succeeds releases its successors in their original order in the same tick (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'fence-release');
  t.after(() => database.close());
  const create = goldenMutation('ENTRY_CREATE');
  const correct = goldenMutation('ENTRY_CORRECT');
  const voided = goldenMutation('ENTRY_VOID');
  await queueInOrder(database, [create, correct, voided]);
  let refused = new Set([create.mutation_uuid]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes((request) => refuseOnly(refused)(request)), calls);
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [create.mutation_uuid]);
  refused = new Set();
  database.prepare(
    "UPDATE journal_edge_mutations SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE mutation_uuid=?",
  ).run(create.mutation_uuid);
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [
    create.mutation_uuid, create.mutation_uuid, correct.mutation_uuid, voided.mutation_uuid,
  ]);
  for (const mutation of [create, correct, voided]) {
    assert.equal(queueRow(database, mutation.mutation_uuid).status, 'applied');
  }
  assert.equal(result.sent_mutations, 3);
  assert.deepEqual(result.mutation_queue, { queued: 0, held: 0, rejected: 0, blocked: 0 });
});

test('within one resource the lower base_version goes first even when its created_at is later (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'fence-base-order');
  t.after(() => database.close());
  const create = goldenMutation('ENTRY_CREATE');
  const correct = goldenMutation('ENTRY_CORRECT');
  await queueInOrder(database, [create, correct]);
  const setCreatedAt = database.prepare(
    'UPDATE journal_edge_mutations SET created_at=? WHERE mutation_uuid=?',
  );
  setCreatedAt.run('2026-08-08T10:00:05.000Z', create.mutation_uuid);
  setCreatedAt.run('2026-08-08T10:00:01.000Z', correct.mutation_uuid);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes(refuseOnly(new Set())), calls);
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [create.mutation_uuid, correct.mutation_uuid]);
  assert.equal(queueRow(database, create.mutation_uuid).status, 'applied');
  assert.equal(queueRow(database, correct.mutation_uuid).status, 'applied');
});

test('a rejected head keeps its successors queued and unsent, reported as blocked (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'fence-rejected');
  t.after(() => database.close());
  const create = goldenMutation('ENTRY_CREATE');
  const correct = goldenMutation('ENTRY_CORRECT');
  await queueInOrder(database, [create, correct]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes((request) => (
    request.payload.mutation_uuid === create.mutation_uuid
      ? { statusCode: 400, payload: boundReceipt(create) }
      : { statusCode: 201, payload: appliedResult(request.payload) }
  )), calls);
  await replication.runReplicationTick(facade(database), http, fs, config());
  await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [create.mutation_uuid]);
  assert.equal(queueRow(database, create.mutation_uuid).next_attempt_at, REJECTED_UNTIL);
  assertUntouched(database, correct);
  assert.deepEqual(JSON.parse(database.prepare(
    'SELECT payload_json FROM journal_edge_mutations WHERE mutation_uuid=?',
  ).get(correct.mutation_uuid).payload_json), correct);
  assert.deepEqual(
    await replication.mutationQueueHealth(facade(database)),
    { queued: 0, held: 0, rejected: 1, blocked: 1 },
  );
});

test('an entry that references a plot whose snapshot is held is still sent; the cloud refusal only holds it (#447)', async (t) => {
  resetEach(t);
  const { database } = fixture(t, 'cross-resource-plot');
  t.after(() => database.close());
  const plot = goldenMutation('PLOT_SNAPSHOT');
  const entryOnPlot = variantOf(goldenMutation('ENTRY_CREATE'), '10000000-0000-4000-8000-000000004473', (next) => {
    next.candidate.entry.gateway_device_eui = plot.resource.gateway_device_eui;
    next.candidate.entry.plot_uuid = plot.resource.plot_uuid;
  });
  await queueInOrder(database, [plot, entryOnPlot]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes(refuseOnly(new Set([
    plot.mutation_uuid, entryOnPlot.mutation_uuid,
  ]))), calls);
  const result = await replication.runReplicationTick(facade(database), http, fs, config());
  assert.deepEqual(mutationPosts(calls), [plot.mutation_uuid, entryOnPlot.mutation_uuid]);
  for (const mutation of [plot, entryOnPlot]) {
    const row = queueRow(database, mutation.mutation_uuid);
    assert.equal(row.attempts, 1);
    assert.equal(JSON.parse(row.last_error).state, 'held');
  }
  assert.equal(result.held_mutations, 2);
});

test('an oversized refusal body is checked and stored without allocating over its full length (#447)', async (t) => {
  resetEach(t);
  const arrayFrom = t.mock.method(Array, 'from');
  const longStringCalls = () => arrayFrom.mock.calls.filter((call) => (
    typeof call.arguments[0] === 'string' && call.arguments[0].length > 4096
  )).length;
  const create = goldenMutation('ENTRY_CREATE');
  const huge = 'x'.repeat(1 << 20);
  const seedling = '\u{1F331}';
  assert.equal(replication.isMutationRejectionReceipt(boundReceipt(create, { message: huge })), false);
  assert.equal(replication.isMutationRejectionReceipt(boundReceipt(create, { field_paths: ['/' + huge] })), false);
  assert.equal(replication.isMutationRejectionReceipt(boundReceipt(create, { message: seedling.repeat(512) })), true);
  assert.equal(replication.isMutationRejectionReceipt(boundReceipt(create, { message: seedling.repeat(513) })), false);
  const { database } = fixture(t, 'refusal-oversized');
  t.after(() => database.close());
  await queueInOrder(database, [create]);
  const calls = [];
  const http = fakeHttp(database, refusalRoutes(() => ({
    statusCode: 400,
    payload: { error: 'invalid_journal_v2_request', message: ' ' + seedling.repeat(1 << 18) },
  })), calls);
  await replication.runReplicationTick(facade(database), http, fs, config());
  const detail = JSON.parse(queueRow(database, create.mutation_uuid).last_error);
  assert.equal(detail.state, 'held');
  assert.equal(detail.message, seedling.repeat(512));
  assert.equal(longStringCalls(), 0);
});
