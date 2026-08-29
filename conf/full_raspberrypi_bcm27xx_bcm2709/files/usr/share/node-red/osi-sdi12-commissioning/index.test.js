'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const commissioning = require('./index.js');
const recipeCompiler = require('../osi-sdi12-recipe');

const DEVEUI = 'A8404101FD5ECF41';
const NOW = '2026-08-29T08:00:00.000Z';

const DEPLOYMENT_COLUMNS = [
  'deveui', 'desired_version', 'desired_layout_hash', 'desired_recipe_json',
  'status', 'queue_item_ids_json', 'queued_at', 'queue_drained_at',
  'commissioning_deadline_at', 'observed_count', 'failed_observation_count',
  'last_observed_at', 'last_error_code', 'compatible_recipe_json',
  'compatible_layout_json', 'compatible_at', 'updated_at',
];

function values(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function createDb(options = {}) {
  const native = new DatabaseSync(':memory:');
  native.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE devices (
      deveui TEXT PRIMARY KEY,
      type_id TEXT NOT NULL,
      sdi12_probe_profile TEXT,
      sdi12_probe_status TEXT,
      sdi12_value_count INTEGER,
      sdi12_channel_layout_json TEXT,
      soil_moisture_probe_depths_json TEXT,
      soil_moisture_probe_depths_configured INTEGER NOT NULL DEFAULT 0,
      sync_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE sdi12_recipe_deployments (
      deveui TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
      desired_version INTEGER NOT NULL DEFAULT 0,
      desired_layout_hash TEXT,
      desired_recipe_json TEXT,
      status TEXT NOT NULL CHECK(status IN (
        'not_applied','queueing','queued','observed_once',
        'observed_compatible','degraded'
      )),
      queue_item_ids_json TEXT,
      queued_at TEXT,
      queue_drained_at TEXT,
      commissioning_deadline_at TEXT,
      observed_count INTEGER NOT NULL DEFAULT 0,
      failed_observation_count INTEGER NOT NULL DEFAULT 0,
      last_observed_at TEXT,
      last_error_code TEXT,
      compatible_recipe_json TEXT,
      compatible_layout_json TEXT,
      compatible_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sdi12_identify_attempts (
      deveui TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      discovered_address TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE device_data (
      id INTEGER PRIMARY KEY,
      deveui TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      vwc_1 REAL,
      soil_vic_1 REAL
    );
  `);

  let operationQueue = Promise.resolve();
  function prepared(method, sql, params) {
    if (options.failSql && options.failSql.test(sql)) throw new Error('injected_sql_failure');
    const statement = native.prepare(sql);
    const args = Array.isArray(params) ? params : [];
    return statement[method](...args);
  }
  function enqueue(work) {
    const current = operationQueue.then(work, work);
    operationQueue = current.then(() => undefined, () => undefined);
    return current;
  }
  function scope() {
    return {
      async run(sql, params) { prepared('run', sql, params); },
      async get(sql, params) { return prepared('get', sql, params); },
      async all(sql, params) { return prepared('all', sql, params); },
    };
  }
  const db = {
    native,
    async run(sql, params) { return enqueue(() => scope().run(sql, params)); },
    async get(sql, params) { return enqueue(() => scope().get(sql, params)); },
    async all(sql, params) { return enqueue(() => scope().all(sql, params)); },
    transaction(executor) {
      return enqueue(async () => {
        native.exec('BEGIN IMMEDIATE');
        try {
          const result = await executor(scope());
          native.exec('COMMIT');
          return result;
        } catch (error) {
          native.exec('ROLLBACK');
          throw error;
        }
      });
    },
  };
  return db;
}

function sentekLayout(overrides = {}) {
  return {
    version: 1,
    address: '0',
    sensors: [
      { channel: 2, response_position: 2, depth_cm: 30, type: 'ENVIROSCAN' },
      { channel: 1, response_position: 1, depth_cm: 10, type: 'TRISCAN' },
    ],
    ...overrides,
  };
}

function canonical(layout = sentekLayout()) {
  const compiled = recipeCompiler.compileSentekRecipe(layout);
  assert.equal(compiled.ok, true, JSON.stringify(compiled));
  const normalized = {
    version: 1,
    address: compiled.recipe.address,
    sensors: layout.sensors.slice().sort((a, b) => a.response_position - b.response_position),
  };
  return {
    layout: normalized,
    depths: { vwc_1: 10, soil_vic_1: 10, vwc_2: 30 },
    recipe: compiled.recipe,
  };
}

function seedDevice(db, overrides = {}) {
  const row = {
    deveui: DEVEUI,
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
    sdi12_probe_status: 'identified',
    sdi12_value_count: 4,
    sdi12_channel_layout_json: null,
    soil_moisture_probe_depths_json: '{"legacy":20}',
    soil_moisture_probe_depths_configured: 1,
    sync_version: 7,
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
  db.native.prepare(`INSERT INTO devices (${Object.keys(row).join(', ')}) VALUES (${values(Object.keys(row).length)})`).run(...Object.values(row));
  return row;
}

function seedDeployment(db, overrides = {}) {
  const old = canonical();
  const row = {
    deveui: DEVEUI,
    desired_version: 4,
    desired_layout_hash: old.recipe.layoutHash,
    desired_recipe_json: JSON.stringify(old.recipe),
    status: 'observed_compatible',
    queue_item_ids_json: JSON.stringify(['old-queue-id']),
    queued_at: '2026-08-27T01:00:00.000Z',
    queue_drained_at: '2026-08-27T02:00:00.000Z',
    commissioning_deadline_at: '2026-08-27T13:00:00.000Z',
    observed_count: 2,
    failed_observation_count: 0,
    last_observed_at: '2026-08-27T02:40:00.000Z',
    last_error_code: null,
    compatible_recipe_json: JSON.stringify(old.recipe),
    compatible_layout_json: JSON.stringify(old.layout),
    compatible_at: '2026-08-27T02:40:00.000Z',
    updated_at: '2026-08-27T02:40:00.000Z',
    ...overrides,
  };
  db.native.prepare(`INSERT INTO sdi12_recipe_deployments (${DEPLOYMENT_COLUMNS.join(', ')}) VALUES (${values(DEPLOYMENT_COLUMNS.length)})`).run(...DEPLOYMENT_COLUMNS.map((column) => row[column]));
  return row;
}

function readDevice(db) {
  return db.native.prepare('SELECT * FROM devices WHERE deveui = ?').get(DEVEUI);
}

function readDeployment(db) {
  return db.native.prepare('SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?').get(DEVEUI);
}

function seedReadyDeployment(db, deploymentOverrides = {}, deviceOverrides = {}) {
  const ready = canonical();
  seedDevice(db, {
    sdi12_value_count: null,
    sdi12_channel_layout_json: JSON.stringify(ready.layout),
    soil_moisture_probe_depths_json: JSON.stringify(ready.depths),
    ...deviceOverrides,
  });
  seedDeployment(db, {
    desired_layout_hash: ready.recipe.layoutHash,
    desired_recipe_json: JSON.stringify(ready.recipe),
    status: 'not_applied',
    queue_item_ids_json: null,
    queued_at: null,
    queue_drained_at: null,
    commissioning_deadline_at: null,
    observed_count: 0,
    failed_observation_count: 0,
    last_observed_at: null,
    last_error_code: null,
    ...deploymentOverrides,
  });
  return ready;
}

function seedRollbackReady(db, deploymentOverrides = {}, deviceOverrides = {}) {
  const desired = canonical(sentekLayout({ address: 'C' }));
  const compatible = canonical();
  seedDevice(db, {
    sdi12_value_count: null,
    sdi12_channel_layout_json: JSON.stringify(desired.layout),
    soil_moisture_probe_depths_json: JSON.stringify(desired.depths),
    ...deviceOverrides,
  });
  seedDeployment(db, {
    desired_layout_hash: desired.recipe.layoutHash,
    desired_recipe_json: JSON.stringify(desired.recipe),
    status: 'observed_once',
    queue_item_ids_json: JSON.stringify(['delivered-current']),
    queued_at: '2026-08-28T01:00:00.000Z',
    queue_drained_at: '2026-08-28T02:00:00.000Z',
    commissioning_deadline_at: '2026-08-28T13:00:00.000Z',
    observed_count: 1,
    compatible_recipe_json: JSON.stringify(compatible.recipe),
    compatible_layout_json: JSON.stringify(compatible.layout),
    compatible_at: '2026-08-27T02:40:00.000Z',
    ...deploymentOverrides,
  });
  return { desired, compatible };
}

function makeClient(options = {}) {
  const calls = { list: [], enqueue: [], flush: [] };
  let enqueueIndex = 0;
  const client = {
    calls,
    async listDeviceQueue(deveui) {
      calls.list.push(deveui);
      if (options.listDeviceQueue) return options.listDeviceQueue(deveui, calls.list.length - 1);
      return options.queue || [];
    },
    async enqueueDeviceDownlink(input) {
      calls.enqueue.push(input);
      const index = enqueueIndex++;
      if (options.enqueueDeviceDownlink) return options.enqueueDeviceDownlink(input, index);
      return { id: 'queue-' + (index + 1) };
    },
    async flushDeviceQueue(deveui) {
      calls.flush.push(deveui);
      throw new Error('commissioning must never flush the device queue');
    },
  };
  return client;
}

function successfulObservation(overrides = {}) {
  return {
    deveui: DEVEUI,
    profileId: 'SENTEK_ENVIROSCAN',
    layout: sentekLayout(),
    normalization: {
      channels: { bat_v: 3.6, vwc_1: 22.5, vwc_2: 23.5, soil_vic_1: 0.4 },
      unknown: {},
      noResponse: false,
    },
    outcome: { inserted: true, deadLettered: [] },
    observedAt: '2026-08-29T08:20:00.000Z',
    ...overrides,
  };
}

test('saveSentekLayout atomically stores canonical layout and recipe while preserving the compatible pair', async () => {
  const db = createDb();
  seedDevice(db);
  const before = seedDeployment(db);
  db.native.prepare('INSERT INTO sdi12_identify_attempts VALUES (?, ?, ?, ?, ?)').run(
    DEVEUI, 'identifying', '0', '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z'
  );
  const next = canonical();

  await commissioning.saveSentekLayout(db, {
    deveui: DEVEUI.toLowerCase(),
    profileId: 'SENTEK_ENVIROSCAN',
    layout: sentekLayout(),
    depths: next.depths,
  });

  const device = readDevice(db);
  assert.equal(device.sdi12_probe_profile, 'SENTEK_ENVIROSCAN');
  assert.equal(device.sdi12_probe_status, 'manual');
  assert.deepEqual(JSON.parse(device.sdi12_channel_layout_json), next.layout);
  assert.deepEqual(JSON.parse(device.soil_moisture_probe_depths_json), next.depths);
  assert.equal(device.soil_moisture_probe_depths_configured, 1);
  assert.equal(device.sdi12_value_count, null);
  assert.equal(device.sync_version, 8);

  const deployment = readDeployment(db);
  assert.equal(deployment.desired_version, 5);
  assert.equal(deployment.desired_layout_hash, next.recipe.layoutHash);
  assert.deepEqual(JSON.parse(deployment.desired_recipe_json), next.recipe);
  assert.equal(deployment.status, 'not_applied');
  assert.equal(deployment.queue_item_ids_json, null);
  assert.equal(deployment.queued_at, null);
  assert.equal(deployment.queue_drained_at, null);
  assert.equal(deployment.commissioning_deadline_at, null);
  assert.equal(deployment.observed_count, 0);
  assert.equal(deployment.failed_observation_count, 0);
  assert.equal(deployment.last_observed_at, null);
  assert.equal(deployment.last_error_code, null);
  assert.equal(deployment.compatible_recipe_json, before.compatible_recipe_json);
  assert.equal(deployment.compatible_layout_json, before.compatible_layout_json);
  assert.equal(deployment.compatible_at, before.compatible_at);
  assert.equal(db.native.prepare('SELECT count(*) AS count FROM sdi12_identify_attempts').get().count, 0);
});

test('saveSentekLayout rolls back every table when the final identify-attempt delete fails', async () => {
  const db = createDb({ failSql: /DELETE FROM sdi12_identify_attempts/ });
  seedDevice(db);
  seedDeployment(db);
  db.native.prepare('INSERT INTO sdi12_identify_attempts VALUES (?, ?, ?, ?, ?)').run(
    DEVEUI, 'identifying', '0', NOW, NOW
  );
  const deviceBefore = readDevice(db);
  const deploymentBefore = readDeployment(db);

  await assert.rejects(() => commissioning.saveSentekLayout(db, {
    deveui: DEVEUI,
    profileId: 'SENTEK_ENVIROSCAN',
    layout: sentekLayout(),
    depths: canonical().depths,
  }), /injected_sql_failure/);

  assert.deepEqual(readDevice(db), deviceBefore);
  assert.deepEqual(readDeployment(db), deploymentBefore);
  assert.equal(db.native.prepare('SELECT count(*) AS count FROM sdi12_identify_attempts').get().count, 1);
});

test('saveSentekLayout returns 409 without mutating devices or deployments while physical queueing is active', async () => {
  for (const status of ['queueing', 'queued']) {
    const db = createDb();
    seedDevice(db);
    seedDeployment(db, { status });
    const deviceBefore = readDevice(db);
    const deploymentBefore = readDeployment(db);

    await assert.rejects(() => commissioning.saveSentekLayout(db, {
      deveui: DEVEUI,
      profileId: 'SENTEK_ENVIROSCAN',
      layout: sentekLayout({ address: 'C' }),
      depths: canonical().depths,
    }), (error) => error.statusCode === 409 && error.code === 'deployment_in_progress');

    assert.deepEqual(readDevice(db), deviceBefore);
    assert.deepEqual(readDeployment(db), deploymentBefore);
  }
});

test('applyDesiredRecipe refuses absent or malformed layouts and wrong device/profile before ChirpStack effects', async () => {
  const cases = [
    { device: { sdi12_channel_layout_json: null }, code: 'invalid_layout', statusCode: 400 },
    { device: { sdi12_channel_layout_json: '{broken' }, code: 'invalid_layout', statusCode: 400 },
    { device: { sdi12_probe_profile: 'METER_TEROS12' }, code: 'wrong_probe_profile', statusCode: 409 },
    { device: { type_id: 'DRAGINO_LSN50' }, code: 'wrong_device_type', statusCode: 409 },
  ];
  for (const scenario of cases) {
    const db = createDb();
    seedReadyDeployment(db, {}, scenario.device);
    const before = readDeployment(db);
    const client = makeClient();

    await assert.rejects(
      () => commissioning.applyDesiredRecipe(db, client, DEVEUI, { now: NOW }),
      (error) => error.statusCode === scenario.statusCode && error.code === scenario.code
    );

    assert.deepEqual(readDeployment(db), before);
    assert.deepEqual(client.calls, { list: [], enqueue: [], flush: [] });
  }
});

test('applyDesiredRecipe claims once, preflights an empty queue, and enqueues every compiler frame sequentially', async () => {
  const db = createDb();
  const ready = seedReadyDeployment(db);
  const client = makeClient();

  const result = await commissioning.applyDesiredRecipe(db, client, DEVEUI.toLowerCase(), { now: NOW });

  assert.equal(client.calls.list.length, 1);
  assert.equal(client.calls.list[0], DEVEUI);
  assert.equal(client.calls.enqueue.length, ready.recipe.frames.length);
  assert.deepEqual(client.calls.enqueue.map((input) => ({
    devEui: input.devEui,
    fPort: input.fPort,
    confirmed: input.confirmed,
    base64: input.data.toString('base64'),
  })), ready.recipe.frames.map((frame) => ({
    devEui: DEVEUI,
    fPort: 2,
    confirmed: false,
    base64: frame.base64,
  })));
  assert.deepEqual(client.calls.flush, []);

  const deployment = readDeployment(db);
  assert.equal(deployment.status, 'queued');
  assert.deepEqual(JSON.parse(deployment.queue_item_ids_json), ready.recipe.frames.map((_, index) => 'queue-' + (index + 1)));
  assert.equal(deployment.queued_at, NOW);
  assert.equal(deployment.commissioning_deadline_at, '2026-08-29T20:00:00.000Z');
  assert.equal(deployment.queue_drained_at, null);
  assert.equal(deployment.last_error_code, null);
  assert.equal(result.statusCode, 202);
  assert.equal(result.deployment.status, 'queued');
  assert.equal(result.deployment.frame_count, ready.recipe.frames.length);
});

test('applyDesiredRecipe restores not_applied with a bounded 409 when the whole-device queue is non-empty', async () => {
  const db = createDb();
  seedReadyDeployment(db);
  const client = makeClient({ queue: [{ id: 'unrelated-command' }] });

  await assert.rejects(
    () => commissioning.applyDesiredRecipe(db, client, DEVEUI, { now: NOW }),
    (error) => error.statusCode === 409 && error.code === 'device_queue_not_empty'
  );

  const deployment = readDeployment(db);
  assert.equal(deployment.status, 'not_applied');
  assert.equal(deployment.queue_item_ids_json, null);
  assert.equal(deployment.commissioning_deadline_at, null);
  assert.equal(deployment.last_error_code, 'device_queue_not_empty');
  assert.equal(client.calls.enqueue.length, 0);
  assert.deepEqual(client.calls.flush, []);
});

test('two concurrent apply requests cannot both pass the compare-and-set queueing claim', async () => {
  const db = createDb();
  const ready = seedReadyDeployment(db);
  let releaseList;
  let announceList;
  const listStarted = new Promise((resolve) => { announceList = resolve; });
  const heldList = new Promise((resolve) => { releaseList = resolve; });
  const client = makeClient({
    async listDeviceQueue() {
      announceList();
      await heldList;
      return [];
    },
  });

  const first = commissioning.applyDesiredRecipe(db, client, DEVEUI, { now: NOW });
  await listStarted;
  await assert.rejects(
    () => commissioning.applyDesiredRecipe(db, client, DEVEUI, { now: NOW }),
    (error) => error.statusCode === 409 && error.code === 'deployment_in_progress'
  );
  releaseList();
  await first;

  assert.equal(client.calls.list.length, 1);
  assert.equal(client.calls.enqueue.length, ready.recipe.frames.length);
  assert.equal(readDeployment(db).status, 'queued');
});

test('applyDesiredRecipe restores not_applied when enqueue accepts zero frames and never leaks client error text', async () => {
  const db = createDb();
  seedReadyDeployment(db);
  const client = makeClient({
    async enqueueDeviceDownlink() {
      throw Object.assign(new Error('secret grpc detail'), { code: 'UNAVAILABLE', step: 'enqueueDeviceDownlink' });
    },
  });

  await assert.rejects(
    () => commissioning.applyDesiredRecipe(db, client, DEVEUI, { now: NOW }),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, 'chirpstack_unavailable');
      assert.equal(error.message, 'sdi12_commissioning_error');
      assert.equal(JSON.stringify(error).includes('secret grpc detail'), false);
      return true;
    }
  );

  const deployment = readDeployment(db);
  assert.equal(deployment.status, 'not_applied');
  assert.equal(deployment.queue_item_ids_json, null);
  assert.equal(deployment.commissioning_deadline_at, null);
  assert.equal(deployment.last_error_code, 'chirpstack_unavailable');
  assert.deepEqual(client.calls.flush, []);
});

test('partial enqueue retains accepted IDs, degrades, and permits a same-version retry', async () => {
  const db = createDb();
  const ready = seedReadyDeployment(db);
  const partialClient = makeClient({
    async enqueueDeviceDownlink(input, index) {
      if (index === 1) throw Object.assign(new Error('network'), { code: 'DEADLINE_EXCEEDED' });
      return { id: 'accepted-' + index };
    },
  });

  await assert.rejects(
    () => commissioning.applyDesiredRecipe(db, partialClient, DEVEUI, { now: NOW }),
    (error) => error.statusCode === 502 && error.code === 'chirpstack_deadline_exceeded'
  );
  const degraded = readDeployment(db);
  assert.equal(degraded.status, 'degraded');
  assert.deepEqual(JSON.parse(degraded.queue_item_ids_json), ['accepted-0']);
  assert.equal(degraded.desired_version, 4);
  assert.equal(degraded.last_error_code, 'chirpstack_deadline_exceeded');
  assert.deepEqual(partialClient.calls.flush, []);

  const retryClient = makeClient();
  const retry = await commissioning.applyDesiredRecipe(db, retryClient, DEVEUI, {
    now: '2026-08-29T09:00:00.000Z',
  });
  assert.equal(retry.statusCode, 202);
  assert.equal(readDeployment(db).desired_version, 4);
  assert.equal(readDeployment(db).status, 'queued');
  assert.equal(retryClient.calls.enqueue.length, ready.recipe.frames.length);
});

test('rollbackCompatibleRecipe validates the compatible pair, restores canonical device state, and queues a new desired version', async () => {
  const db = createDb();
  const state = seedRollbackReady(db);
  const client = makeClient();

  const result = await commissioning.rollbackCompatibleRecipe(db, client, DEVEUI, { now: NOW });

  const device = readDevice(db);
  assert.equal(device.sdi12_probe_profile, 'SENTEK_ENVIROSCAN');
  assert.equal(device.sdi12_probe_status, 'manual');
  assert.deepEqual(JSON.parse(device.sdi12_channel_layout_json), state.compatible.layout);
  assert.deepEqual(JSON.parse(device.soil_moisture_probe_depths_json), state.compatible.depths);
  assert.equal(device.sdi12_value_count, null);
  assert.equal(device.sync_version, 8);

  const deployment = readDeployment(db);
  assert.equal(deployment.desired_version, 5);
  assert.equal(deployment.desired_layout_hash, state.compatible.recipe.layoutHash);
  assert.deepEqual(JSON.parse(deployment.desired_recipe_json), state.compatible.recipe);
  assert.equal(deployment.status, 'queued');
  assert.deepEqual(JSON.parse(deployment.queue_item_ids_json), state.compatible.recipe.frames.map((_, index) => 'queue-' + (index + 1)));
  assert.equal(deployment.queued_at, NOW);
  assert.equal(deployment.commissioning_deadline_at, '2026-08-29T20:00:00.000Z');
  assert.equal(deployment.compatible_recipe_json, JSON.stringify(state.compatible.recipe));
  assert.equal(deployment.compatible_layout_json, JSON.stringify(state.compatible.layout));
  assert.equal(deployment.compatible_at, '2026-08-27T02:40:00.000Z');
  assert.equal(result.statusCode, 202);
  assert.equal(result.deployment.desired_version, 5);
  assert.deepEqual(client.calls.enqueue.map((input) => input.data.toString('base64')), state.compatible.recipe.frames.map((frame) => frame.base64));
  assert.deepEqual(client.calls.flush, []);
});

test('rollbackCompatibleRecipe rejects absent, malformed, or mismatched compatible layout/recipe pairs before mutation', async () => {
  const cases = [
    { override: { compatible_recipe_json: null }, code: 'compatible_recipe_unavailable' },
    { override: { compatible_layout_json: '{broken' }, code: 'compatible_pair_mismatch' },
    { override: { compatible_recipe_json: JSON.stringify(canonical(sentekLayout({ address: 'C' })).recipe) }, code: 'compatible_pair_mismatch' },
  ];
  for (const scenario of cases) {
    const db = createDb();
    seedRollbackReady(db, scenario.override);
    const deviceBefore = readDevice(db);
    const deploymentBefore = readDeployment(db);
    const client = makeClient();

    await assert.rejects(
      () => commissioning.rollbackCompatibleRecipe(db, client, DEVEUI, { now: NOW }),
      (error) => error.statusCode === 409 && error.code === scenario.code
    );

    assert.deepEqual(readDevice(db), deviceBefore);
    assert.deepEqual(readDeployment(db), deploymentBefore);
    assert.deepEqual(client.calls, { list: [], enqueue: [], flush: [] });
  }
});

test('rollbackCompatibleRecipe compensates the complete pre-rollback pair when queue preflight rejects', async () => {
  const db = createDb();
  seedRollbackReady(db);
  const deviceBefore = readDevice(db);
  const deploymentBefore = readDeployment(db);
  const client = makeClient({ queue: [{ id: 'operator-command' }] });

  await assert.rejects(
    () => commissioning.rollbackCompatibleRecipe(db, client, DEVEUI, { now: NOW }),
    (error) => error.statusCode === 409 && error.code === 'device_queue_not_empty'
  );

  assert.deepEqual(readDevice(db), deviceBefore);
  assert.deepEqual(readDeployment(db), deploymentBefore);
  assert.equal(client.calls.enqueue.length, 0);
  assert.deepEqual(client.calls.flush, []);
});

test('rollbackCompatibleRecipe also compensates the complete pair when the first enqueue is rejected', async () => {
  const db = createDb();
  seedRollbackReady(db);
  const deviceBefore = readDevice(db);
  const deploymentBefore = readDeployment(db);
  const client = makeClient({
    async enqueueDeviceDownlink() {
      throw Object.assign(new Error('transport'), { code: 'UNAVAILABLE' });
    },
  });

  await assert.rejects(
    () => commissioning.rollbackCompatibleRecipe(db, client, DEVEUI, { now: NOW }),
    (error) => error.statusCode === 502 && error.code === 'chirpstack_unavailable'
  );

  assert.deepEqual(readDevice(db), deviceBefore);
  assert.deepEqual(readDeployment(db), deploymentBefore);
  assert.deepEqual(client.calls.flush, []);
});

test('rollbackCompatibleRecipe keeps the compatible layout desired and degrades after partial enqueue', async () => {
  const db = createDb();
  const state = seedRollbackReady(db);
  const client = makeClient({
    async enqueueDeviceDownlink(input, index) {
      if (index === 1) throw Object.assign(new Error('transport'), { code: 'UNAVAILABLE' });
      return { id: 'rollback-accepted-' + index };
    },
  });

  await assert.rejects(
    () => commissioning.rollbackCompatibleRecipe(db, client, DEVEUI, { now: NOW }),
    (error) => error.statusCode === 502 && error.code === 'chirpstack_unavailable'
  );

  const device = readDevice(db);
  const deployment = readDeployment(db);
  assert.deepEqual(JSON.parse(device.sdi12_channel_layout_json), state.compatible.layout);
  assert.deepEqual(JSON.parse(device.soil_moisture_probe_depths_json), state.compatible.depths);
  assert.equal(deployment.desired_version, 5);
  assert.equal(deployment.desired_layout_hash, state.compatible.recipe.layoutHash);
  assert.equal(deployment.status, 'degraded');
  assert.deepEqual(JSON.parse(deployment.queue_item_ids_json), ['rollback-accepted-0']);
  assert.equal(deployment.last_error_code, 'chirpstack_unavailable');
  assert.deepEqual(client.calls.flush, []);
});

test('pollDeployments waits for every stored ID, then records drain despite unrelated later queue items', async () => {
  const db = createDb();
  seedReadyDeployment(db, {
    status: 'queued',
    queue_item_ids_json: JSON.stringify(['recipe-1', 'recipe-2']),
    queued_at: '2026-08-29T07:00:00.000Z',
    commissioning_deadline_at: '2026-08-29T20:00:00.000Z',
  });
  const client = makeClient({
    listDeviceQueue(deveui, index) {
      if (index === 0) return [{ id: 'recipe-2' }, { id: 'later-unrelated' }];
      return [{ id: 'later-unrelated' }];
    },
  });

  await commissioning.pollDeployments(db, client, { now: NOW });
  assert.equal(readDeployment(db).queue_drained_at, null);
  assert.equal(readDeployment(db).status, 'queued');

  const drainedAt = '2026-08-29T08:01:00.000Z';
  await commissioning.pollDeployments(db, client, { now: drainedAt });
  assert.equal(readDeployment(db).queue_drained_at, drainedAt);
  assert.equal(readDeployment(db).status, 'queued');
  assert.equal(readDeployment(db).last_error_code, null);
  assert.deepEqual(client.calls.list, [DEVEUI, DEVEUI]);
});

test('pollDeployments degrades queued IDs still present at the twelve-hour deadline', async () => {
  const db = createDb();
  seedReadyDeployment(db, {
    status: 'queued',
    queue_item_ids_json: JSON.stringify(['recipe-1']),
    queued_at: '2026-08-28T20:00:00.000Z',
    commissioning_deadline_at: NOW,
  });
  const client = makeClient({ queue: [{ id: 'recipe-1' }, { id: 'unrelated' }] });

  await commissioning.pollDeployments(db, client, { now: NOW });

  const deployment = readDeployment(db);
  assert.equal(deployment.status, 'degraded');
  assert.equal(deployment.queue_drained_at, null);
  assert.equal(deployment.last_error_code, 'queue_delivery_timeout');
});

test('pollDeployments degrades an interrupted queueing claim with no stored IDs only after its deadline', async () => {
  const db = createDb();
  seedReadyDeployment(db, {
    status: 'queueing',
    queue_item_ids_json: null,
    commissioning_deadline_at: '2026-08-29T08:00:01.000Z',
  });
  const client = makeClient();

  await commissioning.pollDeployments(db, client, { now: NOW });
  assert.equal(readDeployment(db).status, 'queueing');
  await commissioning.pollDeployments(db, client, { now: '2026-08-29T08:00:01.000Z' });

  const deployment = readDeployment(db);
  assert.equal(deployment.status, 'degraded');
  assert.equal(deployment.last_error_code, 'queueing_interrupted');
  assert.deepEqual(client.calls.list, []);
});

test('pollDeployments surfaces a bounded queue-list failure without mutating deployment state', async () => {
  const db = createDb();
  seedReadyDeployment(db, {
    status: 'queued',
    queue_item_ids_json: JSON.stringify(['recipe-1']),
    commissioning_deadline_at: '2026-08-29T20:00:00.000Z',
  });
  const before = readDeployment(db);
  const client = makeClient({
    async listDeviceQueue() {
      throw Object.assign(new Error('credential secret'), { code: 'UNAVAILABLE' });
    },
  });

  await assert.rejects(
    () => commissioning.pollDeployments(db, client, { now: NOW }),
    (error) => error.statusCode === 502
      && error.code === 'chirpstack_unavailable'
      && error.message === 'sdi12_commissioning_error'
  );
  assert.deepEqual(readDeployment(db), before);
});

test('observeAcquisition ignores matching telemetry until the stored recipe queue has drained', async () => {
  const db = createDb();
  seedReadyDeployment(db, {
    status: 'queued',
    queue_item_ids_json: JSON.stringify(['recipe-1']),
    queue_drained_at: null,
  });
  const before = readDeployment(db);

  const result = await commissioning.observeAcquisition(db, successfulObservation());

  assert.equal(result, null);
  assert.deepEqual(readDeployment(db), before);
});

test('two consecutive exact finite observations activate compatibility and copy recipe plus current canonical layout', async () => {
  const db = createDb();
  const priorCompatible = canonical(sentekLayout({ address: 'C' }));
  const ready = seedReadyDeployment(db, {
    status: 'queued',
    queue_item_ids_json: JSON.stringify(['recipe-1']),
    queue_drained_at: '2026-08-29T08:10:00.000Z',
    compatible_recipe_json: JSON.stringify(priorCompatible.recipe),
    compatible_layout_json: JSON.stringify(priorCompatible.layout),
  });
  db.native.prepare('INSERT INTO device_data (deveui, recorded_at, vwc_1, soil_vic_1) VALUES (?, ?, ?, ?)').run(
    DEVEUI, '2026-08-28T00:00:00.000Z', 19.5, 0.2
  );
  const telemetryBefore = db.native.prepare('SELECT * FROM device_data ORDER BY id').all();

  const first = await commissioning.observeAcquisition(db, successfulObservation());
  let deployment = readDeployment(db);
  assert.equal(first.status, 'observed_once');
  assert.equal(deployment.status, 'observed_once');
  assert.equal(deployment.observed_count, 1);
  assert.equal(deployment.failed_observation_count, 0);
  assert.notEqual(deployment.compatible_recipe_json, deployment.desired_recipe_json);

  const secondAt = '2026-08-29T08:40:00.000Z';
  const second = await commissioning.observeAcquisition(db, successfulObservation({ observedAt: secondAt }));
  deployment = readDeployment(db);
  assert.equal(second.status, 'observed_compatible');
  assert.equal(deployment.status, 'observed_compatible');
  assert.equal(deployment.observed_count, 2);
  assert.equal(deployment.failed_observation_count, 0);
  assert.equal(deployment.compatible_recipe_json, deployment.desired_recipe_json);
  assert.deepEqual(JSON.parse(deployment.compatible_layout_json), ready.layout);
  assert.equal(deployment.compatible_at, secondAt);
  assert.equal(deployment.last_observed_at, secondAt);
  assert.deepEqual(db.native.prepare('SELECT * FROM device_data ORDER BY id').all(), telemetryBefore);
});

test('observeAcquisition rejects every non-matching, quarantined, non-finite, or unwritten acquisition shape', async () => {
  const cases = [
    { name: 'wrong profile', patch: { profileId: 'METER_TEROS12' } },
    { name: 'wrong layout hash', patch: { layout: sentekLayout({ address: 'C' }) } },
    { name: 'no response', patch: { normalization: { channels: {}, unknown: {}, noResponse: true } } },
    { name: 'normalizer quarantine', patch: { normalization: { channels: { vwc_1: 1, vwc_2: 2, soil_vic_1: 3 }, unknown: { bad: 'raw' }, noResponse: false } } },
    { name: 'writer dead letter', patch: { outcome: { inserted: true, deadLettered: [{ channel: 'bad' }] } } },
    { name: 'writer failure', patch: { outcome: { inserted: false, deadLettered: [] } } },
    { name: 'missing VWC', patch: { normalization: { channels: { vwc_1: 1, soil_vic_1: 3 }, unknown: {}, noResponse: false } } },
    { name: 'extra VWC', patch: { normalization: { channels: { vwc_1: 1, vwc_2: 2, vwc_3: 3, soil_vic_1: 4 }, unknown: {}, noResponse: false } } },
    { name: 'missing VIC', patch: { normalization: { channels: { vwc_1: 1, vwc_2: 2 }, unknown: {}, noResponse: false } } },
    { name: 'non-finite VWC', patch: { normalization: { channels: { vwc_1: Infinity, vwc_2: 2, soil_vic_1: 3 }, unknown: {}, noResponse: false } } },
  ];
  for (const scenario of cases) {
    const db = createDb();
    seedReadyDeployment(db, {
      status: 'observed_once',
      queue_item_ids_json: JSON.stringify(['recipe-1']),
      queue_drained_at: '2026-08-29T08:10:00.000Z',
      observed_count: 1,
    });

    const input = successfulObservation(scenario.patch);
    const result = await commissioning.observeAcquisition(db, input);

    const deployment = readDeployment(db);
    assert.equal(result.status, 'queued', scenario.name);
    assert.equal(deployment.status, 'queued', scenario.name);
    assert.equal(deployment.observed_count, 0, scenario.name);
    assert.equal(deployment.failed_observation_count, 1, scenario.name);
  }
});

test('failed observations reset success streaks, successes reset failures, and three consecutive failures degrade', async () => {
  const db = createDb();
  seedReadyDeployment(db, {
    status: 'queued',
    queue_item_ids_json: JSON.stringify(['recipe-1']),
    queue_drained_at: '2026-08-29T08:10:00.000Z',
  });
  const failed = successfulObservation({
    normalization: { channels: {}, unknown: {}, noResponse: true },
  });

  await commissioning.observeAcquisition(db, failed);
  await commissioning.observeAcquisition(db, successfulObservation({ observedAt: '2026-08-29T08:21:00.000Z' }));
  let deployment = readDeployment(db);
  assert.equal(deployment.status, 'observed_once');
  assert.equal(deployment.observed_count, 1);
  assert.equal(deployment.failed_observation_count, 0);

  for (const observedAt of [
    '2026-08-29T08:22:00.000Z',
    '2026-08-29T08:23:00.000Z',
    '2026-08-29T08:24:00.000Z',
  ]) {
    await commissioning.observeAcquisition(db, { ...failed, observedAt });
  }
  deployment = readDeployment(db);
  assert.equal(deployment.status, 'degraded');
  assert.equal(deployment.observed_count, 0);
  assert.equal(deployment.failed_observation_count, 3);
  assert.equal(deployment.last_error_code, 'acquisition_observation_failed');
  assert.equal(deployment.last_observed_at, '2026-08-29T08:24:00.000Z');
});

test('projectDeployment exposes only bounded operational state and never recipe JSON or queue IDs', () => {
  const row = {
    desired_version: 12,
    desired_layout_hash: 'layout-hash-12',
    desired_recipe_json: JSON.stringify({ frames: [{ base64: 'RECIPE-SECRET-12' }, { base64: 'SECOND' }] }),
    status: 'degraded',
    queue_item_ids_json: JSON.stringify(['QUEUE-SECRET-12']),
    queued_at: '2026-08-29T01:00:00.000Z',
    queue_drained_at: '2026-08-29T02:00:00.000Z',
    commissioning_deadline_at: '2026-08-29T13:00:00.000Z',
    last_observed_at: '2026-08-29T02:20:00.000Z',
    compatible_recipe_json: '{"secret":true}',
    compatible_layout_json: '{"version":1}',
    compatible_at: '2026-08-28T12:00:00.000Z',
    updated_at: '2026-08-29T13:00:00.000Z',
    last_error_code: 'raw upstream secret text',
  };

  const projected = commissioning.projectDeployment(row);

  assert.deepEqual(projected, {
    desired_version: 12,
    desired_layout_hash: 'layout-hash-12',
    status: 'degraded',
    queued_at: '2026-08-29T01:00:00.000Z',
    queue_drained_at: '2026-08-29T02:00:00.000Z',
    commissioning_deadline_at: '2026-08-29T13:00:00.000Z',
    last_observed_at: '2026-08-29T02:20:00.000Z',
    compatible_at: '2026-08-28T12:00:00.000Z',
    updated_at: '2026-08-29T13:00:00.000Z',
    frame_count: 2,
    compatible_available: true,
    last_error_code: 'chirpstack_unknown',
  });
  assert.equal(JSON.stringify(projected).includes('RECIPE-SECRET-12'), false);
  assert.equal(JSON.stringify(projected).includes('QUEUE-SECRET-12'), false);
  assert.equal(Object.keys(projected).some((key) => key.includes('recipe_json') || key.includes('queue_item_ids')), false);
});
