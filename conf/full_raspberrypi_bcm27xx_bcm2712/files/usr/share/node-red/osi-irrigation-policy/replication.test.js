'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const replication = require('./replication');
const policyApi = require('./api');
const worker = require('./worker');

const ROOT = path.resolve(__dirname, '../../../../../../../');
const SEED = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db');
const MIGRATION = path.join(ROOT, 'database/migrations/ordered/0077__conditional_irrigation_sync.sql');
const GATEWAY = '0011223344556677';
const VALVE_EUI = '0011223344556688';
const SENSOR_EUI = 'A840410000000001';
const INSTALLATION = '123e4567-e89b-42d3-a456-426614174000';
const USER_UUID = 'user-replication-test';
const ZONE_UUID = '22345678-1234-4234-8234-123456789abc';
const POLICY_UUID = '12345678-1234-4234-8234-123456789abd';
const SCHEDULE_UUID = '12345678-1234-4234-8234-123456789abe';
const NOW = '2026-10-20T08:00:00.000Z';
const Ajv = require(path.join(ROOT, 'scripts/node_modules/ajv'));
const addFormats = require(path.join(ROOT, 'scripts/node_modules/ajv-formats'));
const CONTRACT_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/sync-schema/conditional-irrigation-v1.schema.json'), 'utf8'));

function contractCheck(name) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(CONTRACT_SCHEMA, CONTRACT_SCHEMA.$id);
  return ajv.compile({ $ref: `${CONTRACT_SCHEMA.$id}#/definitions/${name}` });
}

function facade(native) {
  const adapt = (value) => value === undefined ? null : value;
  return {
    async run(sql, params = []) { native.prepare(sql).run(...params.map(adapt)); },
    async get(sql, params = []) { return native.prepare(sql).get(...params.map(adapt)) || null; },
    async all(sql, params = []) { return native.prepare(sql).all(...params.map(adapt)); },
    async exec(sql) { native.exec(sql); },
    async transaction(fn) {
      native.exec('BEGIN IMMEDIATE');
      const tx = {
        run: async (sql, params = []) => { native.prepare(sql).run(...params.map(adapt)); },
        get: async (sql, params = []) => native.prepare(sql).get(...params.map(adapt)) || null,
        all: async (sql, params = []) => native.prepare(sql).all(...params.map(adapt)),
        exec: async (sql) => { native.exec(sql); },
      };
      try {
        const result = await fn(tx);
        native.exec('COMMIT');
        return result;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function fixture({ linked = true, supported = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conditional-replication-'));
  const file = path.join(dir, 'farming.db');
  fs.copyFileSync(SEED, file);
  const native = new DatabaseSync(file);
  native.exec(fs.readFileSync(MIGRATION, 'utf8'));
  native.exec('PRAGMA foreign_keys=ON');
  const db = facade(native);
  const now = NOW;
  native.prepare("INSERT INTO users(id,username,password_hash,created_at,updated_at,role,user_uuid) VALUES (?,?,?,?,?,?,?)").run(101, 'replication-test', 'hash', now, now, 'researcher', USER_UUID);
  native.prepare("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid,gateway_device_eui,sync_version) VALUES (?,?,?,?,?,?,?,?,?)").run(101, 'Replication zone', 101, now, now, 'Europe/Zurich', ZONE_UUID, GATEWAY, 1);
  native.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,gateway_device_eui) VALUES (?,?,?,?,?,?,?,?)").run(VALVE_EUI, 'Replication valve', 'STREGA_VALVE', 101, now, now, 101, GATEWAY);
  native.prepare("INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,gateway_device_eui) VALUES (?,?,?,?,?,?,?,?)").run(SENSOR_EUI, 'Replication sensor', 'KIWI_SENSOR', 101, now, now, 101, GATEWAY);
  native.prepare("INSERT OR IGNORE INTO valve_settings(device_eui,conditional_control_json) VALUES (?,?)").run(VALVE_EUI, JSON.stringify({ desired_revision: 'revision-1', required_push_ids: ['push-1'], generation: 'GEN1', incident: { incident_id: 'incident-1', physical_run_reference: 'run-1', ended: true, state: 'RECONCILED', ended_at: NOW, reconciled_at: NOW, retry_revision: 'revision-2' } }));
  native.prepare("INSERT OR IGNORE INTO valve_schedule_pushes(push_id,device_eui,purpose,fport,payload_hex,state,queued_at,acked_at) VALUES (?,?,?, ?,?,?,?,?)").run('push-1', VALVE_EUI, 'WEEKDAY_PLAN', 14, 'AA', 'ACKED', NOW, NOW);
  native.prepare("INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,previous_gateway_device_euis_json,recovery_state,created_at,updated_at) VALUES (1,?,?,?,'ACTIVE',?,?)").run(INSTALLATION, GATEWAY, '[]', now, now);
  const context = { server_url: 'https://cloud.test', cloud_user_id: USER_UUID, gateway_device_eui: GATEWAY, installation_uuid: INSTALLATION };
  native.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,cloud_user_id,gateway_device_eui,updated_at,installation_uuid) VALUES ('cloud',0,?,?,?,?,?)").run(context.server_url, context.cloud_user_id, context.gateway_device_eui, now, context.installation_uuid);
  native.prepare("UPDATE sync_link_state SET linked=?,server_url=?,cloud_user_id=?,gateway_device_eui=?,updated_at=?,installation_uuid=?,peer_capabilities_json=?,peer_capabilities_context_json=?,peer_capabilities_request_id=? WHERE peer_node='cloud'").run(linked ? 1 : 0, context.server_url, context.cloud_user_id, context.gateway_device_eui, now, context.installation_uuid, supported ? JSON.stringify(['conditional_irrigation_v1']) : JSON.stringify([]), supported ? JSON.stringify(context) : null, supported ? 'request-1' : null);
  native.prepare("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,min_interval_minutes,max_daily_minutes,delivery_settings_json,effective_from,sync_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(POLICY_UUID, ZONE_UUID, JSON.stringify({ kind: 'SWT', threshold_kpa: 40, sources: [{ device_eui: SENSOR_EUI, channel: 'swt_1' }] }), 'Europe/Zurich', 1, 60, 60, 240, '{}', '2026-10-19T00:00:00.000Z', 1, NOW, NOW);
  native.prepare("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,label,weekdays_mask,start_time,fire_at,duration_minutes,timezone,enabled,once_state,sync_version,condition_policy_uuid,effective_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(SCHEDULE_UUID, VALVE_EUI, 'WEEKLY', 'Conditional', 127, '10:00', null, 10, 'Europe/Zurich', 1, null, 1, POLICY_UUID, '2026-10-19T00:00:00.000Z');
  return { dir, file, native, db, context };
}

function closeFixture(f) {
  try { f.native.close(); } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
}

test('replication module exposes the 7b1 public services', () => {
  for (const name of [
    'readPeerContext', 'peerSupportsConditional', 'beginLinkAttempt',
    'beginPeerRequest', 'capturePeerRequest', 'acceptPeerCapabilities', 'invalidatePeerRequest',
    'validateLinkAttempt', 'finalizePeerContext', 'clearLinkAttempt', 'invalidatePeerContext',
    'publishProjection', 'reconcileProjections', 'notifyProjectionKeys', 'readProjection', 'processTimezone',
  ]) assert.equal(typeof replication[name], 'function', name);
});

test('validateLinkAttempt authorizes a response without changing durable context', async () => {
  const f = fixture({ linked: false, supported: false });
  try {
    f.native.prepare("UPDATE sync_link_state SET linked=0,server_url=NULL,cloud_user_id=NULL,gateway_device_eui=NULL,installation_uuid=NULL,peer_capabilities_json=NULL,peer_capabilities_context_json=NULL,peer_capabilities_request_id=NULL WHERE peer_node='cloud'").run();
    const attempt = await replication.beginLinkAttempt(f.db, {
      context: f.context,
      requestId: 'link-request',
      nonce: 'link-nonce',
      now: NOW,
    });
    const valid = await replication.validateLinkAttempt(f.db, {
      requestId: 'link-request',
      nonce: attempt.nonce,
      context: f.context,
      capabilities: ['conditional_irrigation_v1'],
    });
    assert.equal(valid.valid, true);
    assert.equal(valid.route, 'conditional');
    const row = f.native.prepare("SELECT server_url,cloud_user_id,link_attempt_json FROM sync_link_state WHERE peer_node='cloud'").get();
    assert.equal(row.server_url, null);
    assert.equal(row.cloud_user_id, null);
    assert.ok(row.link_attempt_json);

    const stale = await replication.validateLinkAttempt(f.db, {
      requestId: 'other-request',
      nonce: attempt.nonce,
      context: f.context,
      capabilities: ['conditional_irrigation_v1'],
    });
    assert.deepEqual(stale, { valid: false, reason: 'stale_link_attempt' });
  } finally { closeFixture(f); }
});

test('first-link validation accepts the cloud identity learned from the guarded response', async () => {
  const f = fixture({ linked: false, supported: false });
  try {
    f.native.prepare("UPDATE sync_link_state SET linked=0,server_url=NULL,cloud_user_id=NULL,gateway_device_eui=NULL,installation_uuid=NULL,peer_capabilities_json=NULL,peer_capabilities_context_json=NULL,peer_capabilities_request_id=NULL WHERE peer_node='cloud'").run();
    const attempt = await replication.beginLinkAttempt(f.db, {
      context: { server_url: f.context.server_url, gateway_device_eui: f.context.gateway_device_eui, installation_uuid: f.context.installation_uuid },
      requestId: 'first-link-cloud-id',
      nonce: 'first-link-cloud-id-nonce',
      now: NOW,
    });
    const valid = await replication.validateLinkAttempt(f.db, {
      requestId: 'first-link-cloud-id',
      nonce: attempt.nonce,
      context: f.context,
      capabilities: ['conditional_irrigation_v1'],
    });
    assert.equal(valid.valid, true);
    assert.equal(f.native.prepare("SELECT cloud_user_id FROM sync_link_state WHERE peer_node='cloud'").get().cloud_user_id, null);
  } finally { closeFixture(f); }
});

test('0077 creates the projection table and owns all four guarded triggers', () => {
  const f = fixture();
  try {
    const names = f.native.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_sync_%_outbox_%' ORDER BY name").all().map((row) => row.name);
    assert.ok(names.includes('trg_sync_irrigation_policies_outbox_ai'));
    assert.ok(names.includes('trg_sync_irrigation_policies_outbox_au'));
    assert.ok(names.includes('trg_sync_valve_schedules_outbox_ai'));
    assert.ok(names.includes('trg_sync_valve_schedules_outbox_au'));
    assert.ok(f.native.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conditional_irrigation_sync_projections'").get());
    assert.equal(f.native.prepare('PRAGMA foreign_key_list(conditional_irrigation_sync_projections)').all().length, 0);
  } finally { closeFixture(f); }
});

test('conditional SQL events require current durable peer support and carry condition fields', () => {
  const f = fixture({ supported: false });
  try {
    for (const capabilities of ['{"x":"conditional_irrigation_v1"}', '"conditional_irrigation_v1"']) {
      f.native.prepare("UPDATE sync_link_state SET peer_capabilities_json=?,peer_capabilities_context_json=?,peer_capabilities_request_id=? WHERE peer_node='cloud'").run(capabilities, JSON.stringify(f.context), 'request-invalid');
      f.native.prepare("UPDATE irrigation_policies SET sync_version=sync_version+1,updated_at=? WHERE policy_uuid=?").run(NOW, POLICY_UUID);
      assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE op='IRRIGATION_POLICY_UPSERTED'").get().n, 0, capabilities);
    }
    for (const [malformedIndex, [capabilities, context]] of [
      ['{malformed', JSON.stringify(f.context)],
      [JSON.stringify(['conditional_irrigation_v1']), '{malformed'],
      ['{malformed', '{malformed'],
    ].entries()) {
      const malformedPolicyUuid = `32345678-1234-4234-8234-123456789ab${malformedIndex + 1}`;
      const malformedScheduleUuid = `42345678-1234-4234-8234-123456789ab${malformedIndex + 1}`;
      f.native.prepare("UPDATE sync_link_state SET peer_capabilities_json=?,peer_capabilities_context_json=?,peer_capabilities_request_id=? WHERE peer_node='cloud'").run(capabilities, context, 'request-malformed');
      assert.doesNotThrow(() => f.native.prepare("UPDATE irrigation_policies SET sync_version=sync_version+1,updated_at=? WHERE policy_uuid=?").run(NOW, POLICY_UUID));
      assert.doesNotThrow(() => f.native.prepare("INSERT INTO irrigation_policies(policy_uuid,zone_uuid,condition_json,timezone,enabled,observation_window_minutes,min_interval_minutes,max_daily_minutes,delivery_settings_json,effective_from,sync_version,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(malformedPolicyUuid, ZONE_UUID, JSON.stringify({ kind: 'SWT', threshold_kpa: 40, sources: [{ device_eui: SENSOR_EUI, channel: 'swt_1' }] }), 'Europe/Zurich', 1, 60, 60, 240, '{}', NOW, 1, NOW, NOW, NOW));
      assert.doesNotThrow(() => f.native.prepare("UPDATE valve_schedules SET sync_version=sync_version+1,effective_from=? WHERE schedule_uuid=?").run(NOW, SCHEDULE_UUID));
      assert.doesNotThrow(() => f.native.prepare("INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,weekdays_mask,start_time,duration_minutes,timezone,enabled,sync_version,condition_policy_uuid,effective_from) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(malformedScheduleUuid, VALVE_EUI, 'WEEKLY', 127, '10:00', 10, 'Europe/Zurich', 1, 1, POLICY_UUID, NOW));
      assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE op IN ('IRRIGATION_POLICY_UPSERTED','VALVE_SCHEDULE_UPSERTED')").get().n, 0, `${capabilities}/${context}`);
    }
    f.native.prepare("UPDATE sync_link_state SET peer_capabilities_json=?,peer_capabilities_context_json=?,peer_capabilities_request_id=? WHERE peer_node='cloud'").run(JSON.stringify(['conditional_irrigation_v1']), JSON.stringify(f.context), 'request-2');
    f.native.prepare("UPDATE irrigation_policies SET sync_version=4,updated_at=? WHERE policy_uuid=?").run(NOW, POLICY_UUID);
    const event = f.native.prepare("SELECT * FROM sync_outbox WHERE op='IRRIGATION_POLICY_UPSERTED' ORDER BY rowid DESC LIMIT 1").get();
    assert.ok(event);
    const policyPayload = JSON.parse(event.payload_json);
    assert.equal(policyPayload.policy_uuid, POLICY_UUID);
    assert.equal(Object.hasOwn(policyPayload, 'gateway_device_eui'), false);
    const policyCheck = contractCheck('Policy');
    assert.equal(policyCheck(policyPayload), true, JSON.stringify(policyCheck.errors));
    f.native.prepare("UPDATE valve_schedules SET sync_version=2,effective_from=? WHERE schedule_uuid=?").run(NOW, SCHEDULE_UUID);
    const scheduleEvent = f.native.prepare("SELECT payload_json FROM sync_outbox WHERE op='VALVE_SCHEDULE_UPSERTED' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(JSON.parse(scheduleEvent.payload_json).condition_policy_uuid, POLICY_UUID);
  } finally { closeFixture(f); }
});

test('peer context requires exact identity and nonce, and link attempts fence mutations', async () => {
  const f = fixture();
  try {
    assert.equal(await replication.peerSupportsConditional(f.db), true);
    f.native.prepare("UPDATE sync_link_state SET server_url='https://other.test' WHERE peer_node='cloud'").run();
    assert.equal(await replication.peerSupportsConditional(f.db), false);
    f.native.prepare("UPDATE sync_link_state SET server_url=? WHERE peer_node='cloud'").run(f.context.server_url);
    for (const [column, changed] of [['cloud_user_id', 'other-account'], ['gateway_device_eui', '8899aabbccddeeff'], ['installation_uuid', '22345678-1234-4234-8234-123456789abc']]) {
      f.native.prepare(`UPDATE sync_link_state SET ${column}=? WHERE peer_node='cloud'`).run(changed);
      assert.equal(await replication.peerSupportsConditional(f.db), false, column);
      f.native.prepare(`UPDATE sync_link_state SET ${column}=? WHERE peer_node='cloud'`).run(f.context[column]);
    }
    f.native.prepare("UPDATE installation_identity SET current_gateway_device_eui='8899aabbccddeeff' WHERE singleton_id=1").run();
    assert.equal(await replication.peerSupportsConditional(f.db), false, 'installation gateway');
    f.native.prepare("UPDATE installation_identity SET current_gateway_device_eui=? WHERE singleton_id=1").run(GATEWAY);
    f.native.prepare("UPDATE installation_identity SET installation_uuid='22345678-1234-4234-8234-123456789abc' WHERE singleton_id=1").run();
    assert.equal(await replication.peerSupportsConditional(f.db), false, 'installation UUID');
    f.native.prepare("UPDATE installation_identity SET installation_uuid=? WHERE singleton_id=1").run(INSTALLATION);
    const attempt = await replication.beginLinkAttempt(f.db, { route: 'legacy', context: f.context, policySnapshot: { live: true }, requestId: 'request-a' });
    assert.ok(attempt.nonce);
    assert.equal(attempt.route, 'conditional');
    assert.equal(attempt.policy_snapshot.live, true);
    await assert.rejects(policyApi.applyPolicyEdit({ db: f.db, actor: { user_id: 101 }, request: { zone_uuid: ZONE_UUID, enabled: false }, now: NOW }), (error) => error.code === 'link_in_progress');
    await assert.rejects(policyApi.pausePolicy({ db: f.db, actor: { user_id: 101 }, request: { zone_uuid: ZONE_UUID, expected_policy_version: 1 }, now: NOW, cancelActuation: async () => ({}) }), (error) => error.code === 'link_in_progress');
    await assert.rejects(policyApi.retryValve({ db: f.db, actor: { user_id: 101 }, request: { zone_uuid: ZONE_UUID, device_eui: VALVE_EUI }, now: NOW }), (error) => error.code === 'link_in_progress');
    const stale = await replication.finalizePeerContext(f.db, { requestId: 'request-old', nonce: attempt.nonce, context: f.context, capabilities: ['conditional_irrigation_v1'] });
    assert.equal(stale.finalized, false);
    const current = await replication.finalizePeerContext(f.db, { requestId: 'request-a', nonce: attempt.nonce, context: f.context, capabilities: ['conditional_irrigation_v1'] });
    assert.equal(current.finalized, true);
    await replication.clearLinkAttempt(f.db, { nonce: attempt.nonce });
    assert.equal(f.native.prepare("SELECT link_attempt_json FROM sync_link_state WHERE peer_node='cloud'").get().link_attempt_json, null);
  } finally { closeFixture(f); }
});

test('background peer responses use a separate durable nonce/context seam', async () => {
  const f = fixture();
  try {
    f.native.prepare("UPDATE sync_link_state SET link_attempt_json=? WHERE peer_node='cloud'").run(JSON.stringify({ nonce: 'link-attempt' }));
    const first = await replication.beginPeerRequest(f.db, { context: f.context, requestId: 'background-a', now: NOW });
    assert.equal(first.captured, true);
    assert.equal(f.native.prepare("SELECT link_attempt_json FROM sync_link_state WHERE peer_node='cloud'").get().link_attempt_json, JSON.stringify({ nonce: 'link-attempt' }));
    const second = await replication.beginPeerRequest(f.db, { context: f.context, requestId: 'background-b', now: NOW });
    assert.equal(second.captured, true);
    const stale = await replication.acceptPeerCapabilities(f.db, {
      context: f.context, requestId: first.request_id,
      response: { supportedSyncCapabilities: [] }, now: NOW,
    });
    assert.deepEqual(stale, { accepted: false, reason: 'stale_peer_request' });
    assert.equal(await replication.peerSupportsConditional(f.db), true);
    const accepted = await replication.acceptPeerCapabilities(f.db, {
      context: f.context, requestId: second.request_id,
      response: { supportedSyncCapabilities: [] }, now: NOW,
    });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.supported, false);
    assert.equal(await replication.peerSupportsConditional(f.db), false);
    const third = await replication.beginPeerRequest(f.db, { context: f.context, requestId: 'background-c', now: NOW });
    assert.equal(third.captured, true);
    f.native.prepare("UPDATE sync_link_state SET server_url='https://raced.test' WHERE peer_node='cloud'").run();
    const raced = await replication.acceptPeerCapabilities(f.db, {
      context: f.context, requestId: third.request_id,
      response: { supportedSyncCapabilities: ['conditional_irrigation_v1'] }, now: NOW,
    });
    assert.deepEqual(raced, { accepted: false, reason: 'stale_peer_request' });
    assert.equal(f.native.prepare("SELECT peer_capabilities_json FROM sync_link_state WHERE peer_node='cloud'").get().peer_capabilities_json, '[]');
    f.native.prepare("UPDATE sync_link_state SET server_url=? WHERE peer_node='cloud'").run(f.context.server_url);
    const fourth = await replication.beginPeerRequest(f.db, { context: f.context, requestId: 'background-d', now: NOW });
    const invalidated = await replication.invalidatePeerRequest(f.db, { context: f.context, requestId: fourth.request_id, now: NOW });
    assert.equal(invalidated.invalidated, true);
    assert.equal(f.native.prepare("SELECT link_attempt_json FROM sync_link_state WHERE peer_node='cloud'").get().link_attempt_json, JSON.stringify({ nonce: 'link-attempt' }));
  } finally { closeFixture(f); }
});

test('background capture rejects changed server/account/installation before response acceptance', async () => {
  for (const [column, changed] of [
    ['server_url', 'https://changed.test'],
    ['cloud_user_id', 'changed-account'],
    ['installation_uuid', '32345678-1234-4234-8234-123456789abc'],
  ]) {
    const f = fixture();
    try {
      const captured = await replication.beginPeerRequest(f.db, { context: f.context, requestId: `background-${column}`, now: NOW });
      f.native.prepare(`UPDATE sync_link_state SET ${column}=? WHERE peer_node='cloud'`).run(changed);
      assert.equal(await replication.peerSupportsConditional(f.db), false, column);
      const stale = await replication.acceptPeerCapabilities(f.db, {
        context: f.context, requestId: captured.request_id,
        response: { supportedSyncCapabilities: ['conditional_irrigation_v1'] }, now: NOW,
      });
      assert.equal(stale.accepted, false, column);
      assert.equal(await replication.peerSupportsConditional(f.db), false, `${column} after response`);
      const changedContext = { ...f.context, [column]: changed };
      const recaptured = await replication.beginPeerRequest(f.db, { context: changedContext, requestId: `recapture-${column}`, now: NOW });
      assert.equal(recaptured.captured, true, `${column} recapture`);
      assert.equal(f.native.prepare("SELECT peer_capabilities_json FROM sync_link_state WHERE peer_node='cloud'").get().peer_capabilities_json, null, `${column} clears old support`);
    } finally { closeFixture(f); }
  }
  const identity = fixture();
  try {
    const captured = await replication.beginPeerRequest(identity.db, { context: identity.context, requestId: 'background-identity', now: NOW });
    identity.native.prepare("UPDATE installation_identity SET current_gateway_device_eui='8899AABBCCDDEEFF' WHERE singleton_id=1").run();
    assert.equal(await replication.peerSupportsConditional(identity.db), false, 'installation identity');
    const stale = await replication.acceptPeerCapabilities(identity.db, {
      context: identity.context, requestId: captured.request_id,
      response: { supportedSyncCapabilities: ['conditional_irrigation_v1'] }, now: NOW,
    });
    assert.equal(stale.accepted, false, 'installation identity response');
    const recaptured = await replication.beginPeerRequest(identity.db, { context: identity.context, requestId: 'background-identity-recapture', now: NOW });
    assert.equal(recaptured.captured, true);
    assert.equal(identity.native.prepare("SELECT peer_capabilities_json FROM sync_link_state WHERE peer_node='cloud'").get().peer_capabilities_json, null);
  } finally { closeFixture(identity); }
  const refresh = fixture();
  try {
    const captured = await replication.beginPeerRequest(refresh.db, { context: refresh.context, requestId: 'background-refresh', now: NOW });
    assert.equal(captured.captured, true);
    assert.equal(await replication.peerSupportsConditional(refresh.db), true, 'same-context refresh preserves support');
  } finally { closeFixture(refresh); }
});

test('finalization accepts first-link and relink targets only from the captured baseline', async () => {
  const f = fixture({ linked: false, supported: false });
  try {
    f.native.prepare("UPDATE sync_link_state SET linked=0,server_url=NULL,cloud_user_id=NULL,gateway_device_eui=NULL,installation_uuid=NULL,peer_capabilities_json=NULL,peer_capabilities_context_json=NULL,peer_capabilities_request_id=NULL WHERE peer_node='cloud'").run();
    const attempt = await replication.beginLinkAttempt(f.db, { context: f.context, requestId: 'first-link', nonce: 'first-nonce', now: NOW });
    assert.equal(attempt.route, 'conditional');
    const finalized = await replication.finalizePeerContext(f.db, { context: f.context, requestId: 'first-link', nonce: 'first-nonce', capabilities: ['conditional_irrigation_v1'], now: NOW });
    assert.equal(finalized.finalized, true);
    const linked = f.native.prepare("SELECT linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid FROM sync_link_state WHERE peer_node='cloud'").get();
    assert.deepEqual({ ...linked }, { linked: 1, server_url: f.context.server_url, cloud_user_id: f.context.cloud_user_id, gateway_device_eui: f.context.gateway_device_eui, installation_uuid: f.context.installation_uuid });

    const relink = await replication.beginLinkAttempt(f.db, { context: { ...f.context, server_url: 'https://new-cloud.test', cloud_user_id: 'new-account' }, requestId: 'relink', nonce: 'relink-nonce', now: NOW });
    f.native.prepare("UPDATE sync_link_state SET server_url='https://raced.test' WHERE peer_node='cloud'").run();
    const stale = await replication.finalizePeerContext(f.db, { context: { ...f.context, server_url: 'https://new-cloud.test', cloud_user_id: 'new-account' }, requestId: 'relink', nonce: relink.nonce, capabilities: ['conditional_irrigation_v1'], now: NOW });
    assert.equal(stale.finalized, false);
    assert.equal(stale.reason, 'stale_peer_context');
    assert.equal(f.native.prepare("SELECT link_attempt_json FROM sync_link_state WHERE peer_node='cloud'").get().link_attempt_json != null, true);
    assert.equal(f.native.prepare("SELECT cloud_user_id FROM sync_link_state WHERE peer_node='cloud'").get().cloud_user_id, USER_UUID);
  } finally { closeFixture(f); }
});

test('unsupported guarded response consumes only the attempt and never links first-link state', async () => {
  const f = fixture({ linked: false, supported: false });
  try {
    f.native.prepare("UPDATE sync_link_state SET linked=0,server_url=NULL,cloud_user_id=NULL,gateway_device_eui=NULL,installation_uuid=NULL,peer_capabilities_json=NULL,peer_capabilities_context_json=NULL,peer_capabilities_request_id=NULL WHERE peer_node='cloud'").run();
    const attempt = await replication.beginLinkAttempt(f.db, { context: f.context, requestId: 'unsupported', nonce: 'unsupported-nonce', now: NOW });
    const result = await replication.finalizePeerContext(f.db, { context: f.context, requestId: 'unsupported', nonce: attempt.nonce, capabilities: [], now: NOW });
    assert.equal(result.finalized, false);
    assert.equal(result.reason, 'conditional_capability_missing');
    const row = f.native.prepare("SELECT linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,link_attempt_json FROM sync_link_state WHERE peer_node='cloud'").get();
    assert.deepEqual({ ...row }, { linked: 0, server_url: null, cloud_user_id: null, gateway_device_eui: null, installation_uuid: null, link_attempt_json: null });
  } finally { closeFixture(f); }
});

test('policy-free legacy link finalizes basic context without inventing conditional support', async () => {
  const f = fixture({ linked: false, supported: false });
  try {
    f.native.prepare('DELETE FROM valve_schedules WHERE schedule_uuid=?').run(SCHEDULE_UUID);
    f.native.prepare('DELETE FROM irrigation_policies WHERE policy_uuid=?').run(POLICY_UUID);
    f.native.prepare("UPDATE sync_link_state SET linked=0,server_url=NULL,cloud_user_id=NULL,gateway_device_eui=NULL,installation_uuid=NULL,peer_capabilities_json=NULL,peer_capabilities_context_json=NULL,peer_capabilities_request_id=NULL WHERE peer_node='cloud'").run();
    const attempt = await replication.beginLinkAttempt(f.db, { context: f.context, route: 'conditional', policySnapshot: { live: true }, requestId: 'legacy', nonce: 'legacy-nonce', now: NOW });
    assert.equal(attempt.route, 'legacy');
    const result = await replication.finalizePeerContext(f.db, { context: f.context, requestId: 'legacy', nonce: attempt.nonce, capabilities: [], now: NOW });
    assert.equal(result.finalized, true);
    assert.equal(await replication.peerSupportsConditional(f.db), false);
    const row = f.native.prepare("SELECT linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,peer_capabilities_json FROM sync_link_state WHERE peer_node='cloud'").get();
    assert.deepEqual({ ...row }, { linked: 1, server_url: f.context.server_url, cloud_user_id: f.context.cloud_user_id, gateway_device_eui: f.context.gateway_device_eui, installation_uuid: f.context.installation_uuid, peer_capabilities_json: null });
    const advertised = await replication.beginLinkAttempt(f.db, { context: f.context, requestId: 'legacy-advertised', nonce: 'legacy-advertised-nonce', now: NOW });
    assert.equal(advertised.route, 'legacy');
    const advertisedResult = await replication.finalizePeerContext(f.db, { context: f.context, requestId: 'legacy-advertised', nonce: advertised.nonce, capabilities: ['conditional_irrigation_v1'], now: NOW });
    assert.equal(advertisedResult.finalized, true);
    assert.equal(await replication.peerSupportsConditional(f.db), true);
  } finally { closeFixture(f); }
});

test('legacy link retains an advertised capability when only the captured nonce is present', async () => {
  const f = fixture({ linked: false, supported: false });
  try {
    f.native.prepare('DELETE FROM valve_schedules WHERE schedule_uuid=?').run(SCHEDULE_UUID);
    f.native.prepare('DELETE FROM irrigation_policies WHERE policy_uuid=?').run(POLICY_UUID);
    f.native.prepare("UPDATE sync_link_state SET linked=0,server_url=NULL,cloud_user_id=NULL,gateway_device_eui=NULL,installation_uuid=NULL,peer_capabilities_json=NULL,peer_capabilities_context_json=NULL,peer_capabilities_request_id=NULL WHERE peer_node='cloud'").run();
    const attempt = await replication.beginLinkAttempt(f.db, { context: f.context, nonce: 'legacy-capability-nonce', now: NOW });
    assert.equal(attempt.route, 'legacy');
    const result = await replication.finalizePeerContext(f.db, {
      context: f.context, nonce: attempt.nonce, capabilities: ['conditional_irrigation_v1'], now: NOW,
    });
    assert.equal(result.finalized, true);
    assert.equal(await replication.peerSupportsConditional(f.db), true);
    assert.equal(f.native.prepare("SELECT peer_capabilities_request_id FROM sync_link_state WHERE peer_node='cloud'").get().peer_capabilities_request_id, attempt.nonce);
  } finally { closeFixture(f); }
});

test('same-context guarded relink clears stale support when the response omits capability', async () => {
  const f = fixture();
  try {
    const attempt = await replication.beginLinkAttempt(f.db, { context: f.context, requestId: 'relink-missing-support', nonce: 'relink-missing-support-nonce', now: NOW });
    assert.equal(attempt.route, 'conditional');
    const result = await replication.finalizePeerContext(f.db, {
      context: f.context, requestId: 'relink-missing-support', nonce: attempt.nonce, capabilities: [], now: NOW,
    });
    assert.equal(result.finalized, false);
    assert.equal(result.reason, 'conditional_capability_missing');
    const row = f.native.prepare("SELECT linked,server_url,cloud_user_id,gateway_device_eui,installation_uuid,peer_capabilities_json,peer_capabilities_context_json,peer_capabilities_request_id,link_attempt_json FROM sync_link_state WHERE peer_node='cloud'").get();
    assert.deepEqual({ ...row }, {
      linked: 1, server_url: f.context.server_url, cloud_user_id: f.context.cloud_user_id,
      gateway_device_eui: f.context.gateway_device_eui, installation_uuid: f.context.installation_uuid,
      peer_capabilities_json: null, peer_capabilities_context_json: null,
      peer_capabilities_request_id: null, link_attempt_json: null,
    });
    assert.equal(await replication.peerSupportsConditional(f.db), false);
  } finally { closeFixture(f); }
});

test('projection publication stores canonical fresh state and coalesces unchanged scans', async () => {
  const f = fixture();
  try {
    f.native.prepare("UPDATE valve_schedules SET start_time='11:00' WHERE schedule_uuid=?").run(SCHEDULE_UUID);
    const first = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: NOW, clockStatus: { trusted: true, reason: null } });
    assert.equal(first.changed, true);
    assert.equal(first.projection.projection_revision, 1);
    assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_RUNTIME'").get().n, 1);
    const json = JSON.parse(first.projection.payload_json);
    assert.equal(json.zone_uuid, ZONE_UUID);
    assert.equal(json.legacy_process_timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(Object.hasOwn(json, 'identity'), false);
    const second = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:02:00.000Z', clockStatus: { trusted: true, reason: null } });
    assert.equal(second.changed, false);
    assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_RUNTIME'").get().n, 1);
    f.native.prepare("INSERT INTO irrigation_occurrences(schedule_uuid,local_date,local_time,policy_uuid,zone_uuid,device_eui,due_at,state) VALUES (?,?,?,?,?,?,?,'PENDING')").run('schedule-next', '2026-10-20', '09:00', POLICY_UUID, ZONE_UUID, VALVE_EUI, '2026-10-20T07:00:00.000Z');
    const third = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:03:00.000Z', clockStatus: { trusted: true, reason: null } });
    assert.equal(third.projection.projection_revision, 2);
    assert.equal((await replication.readProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID })).projection_revision, 2);
  } finally { closeFixture(f); }
});

test('runtime projection previews a strict next check without creating an occurrence', async () => {
  const f = fixture();
  try {
    f.native.prepare("UPDATE valve_schedules SET start_time='11:00' WHERE schedule_uuid=?").run(SCHEDULE_UUID);
    assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM irrigation_occurrences WHERE policy_uuid=?").get(POLICY_UUID).n, 0);
    const result = await replication.publishProjection(f.db, {
      kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: NOW, clockStatus: { trusted: true, reason: null },
    });
    const payload = JSON.parse(result.projection.payload_json);
    assert.equal(payload.next_check, '2026-10-20T09:00:00.000Z');
    assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM irrigation_occurrences WHERE policy_uuid=?").get(POLICY_UUID).n, 0);
  } finally { closeFixture(f); }
});

test('key-only notifications publish source rereads and coalesce repeated keys', async () => {
  const f = fixture();
  try {
    const first = await replication.notifyProjectionKeys(f.db, {
      zone_uuid: ZONE_UUID,
      valve_euis: [VALVE_EUI],
      clockStatus: { trusted: true, reason: null },
      now: NOW,
    });
    assert.equal(first.length, 2);
    assert.ok(first.every((item) => item.changed === true));
    const second = await replication.notifyProjectionKeys(f.db, {
      policyKeys: [ZONE_UUID],
      valveKeys: [VALVE_EUI],
      clockStatus: { trusted: true, reason: null },
      now: NOW,
    });
    assert.equal(second.length, 2);
    assert.ok(second.every((item) => item.changed === false));
  } finally { closeFixture(f); }
});

test('retained unchanged projections do not recreate an outbox event after delivery pruning', async () => {
  const f = fixture();
  try {
    const first = await replication.publishProjection(f.db, { kind: 'DECISION', key: `${ZONE_UUID}|${SCHEDULE_UUID}|2026-10-20|10:00`, now: NOW, clockStatus: { trusted: true, reason: null } });
    assert.equal(first.changed, true);
    f.native.prepare("DELETE FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_DECISION' AND aggregate_key=?").run(`${ZONE_UUID}|${SCHEDULE_UUID}|2026-10-20|10:00`);
    const second = await replication.publishProjection(f.db, { kind: 'DECISION', key: `${ZONE_UUID}|${SCHEDULE_UUID}|2026-10-20|10:00`, now: '2026-10-20T08:01:00.000Z', clockStatus: { trusted: true, reason: null } });
    assert.equal(second.changed, false);
    assert.equal(second.emitted, false);
    assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_DECISION'").get().n, 0);
  } finally { closeFixture(f); }
});

test('projection and outbox writes roll back together when the event insert fails', async () => {
  const f = fixture();
  try {
    const failingDb = {
      ...f.db,
      transaction: (fn) => f.db.transaction((tx) => fn({
        ...tx,
        run: async (sql, params = []) => {
          if (/INSERT INTO sync_outbox/i.test(sql)) throw new Error('injected outbox failure');
          return tx.run(sql, params);
        },
      })),
    };
    await assert.rejects(
      replication.publishProjection(failingDb, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: NOW, clockStatus: { trusted: true, reason: null } }),
      /injected outbox failure/,
    );
    assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM conditional_irrigation_sync_projections WHERE projection_kind='POLICY_RUNTIME'").get().n, 0);
    assert.equal(f.native.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_RUNTIME'").get().n, 0);
  } finally { closeFixture(f); }
});

test('projection publication rejects a stale cached source payload after a policy source change', async () => {
  const f = fixture();
  try {
    const first = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: NOW, clockStatus: { trusted: true, reason: null } });
    const firstPayload = JSON.parse(first.projection.payload_json);
    f.native.prepare("UPDATE irrigation_policies SET condition_json=?,sync_version=sync_version+1,updated_at=? WHERE policy_uuid=?").run(JSON.stringify({ kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' }), '2026-10-20T08:00:30.000Z', POLICY_UUID);
    const second = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:01:00.000Z', clockStatus: { trusted: true, reason: null } });
    const secondPayload = JSON.parse(second.projection.payload_json);
    assert.equal(second.projection.projection_revision, first.projection.projection_revision + 1);
    assert.notDeepEqual(secondPayload.eligible_sources, firstPayload.eligible_sources);
    assert.equal(secondPayload.eligible_sources.length, 0);
  } finally { closeFixture(f); }
});

test('zone runtime carries only the accepted qualification result from the internal provider seam', async () => {
  const f = fixture();
  try {
    const qualified = await replication.publishProjection(f.db, {
      kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: NOW,
      clockStatus: { trusted: true, reason: null },
      qualificationProvider: ({ device_eui, policy }) => ({
        qualified: true, identity: `internal:${device_eui}:${policy.policy_uuid}`, margin_seconds: 30,
      }),
    });
    assert.deepEqual(JSON.parse(qualified.projection.payload_json).qualification, { qualified: true, reason: null });
    const unqualified = await replication.publishProjection(f.db, {
      kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:01:00.000Z',
      clockStatus: { trusted: true, reason: null },
      qualificationProvider: () => ({ qualified: false, reason: 'qualification_revoked' }),
    });
    assert.equal(unqualified.projection.projection_revision, qualified.projection.projection_revision + 1);
    assert.deepEqual(JSON.parse(unqualified.projection.payload_json).qualification, { qualified: false, reason: 'qualification_revoked' });
    assert.equal(Object.hasOwn(JSON.parse(unqualified.projection.payload_json), 'identity'), false);
  } finally { closeFixture(f); }
});

test('produced runtime and decision DTOs validate against the accepted schemas and keep the four-part key', async () => {
  const f = fixture();
  try {
    const runtime = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: NOW, clockStatus: { trusted: true, reason: null } });
    const valve = await replication.publishProjection(f.db, { kind: 'VALVE_RUNTIME', key: VALVE_EUI, now: NOW, clockStatus: { trusted: true, reason: null } });
    const evidence = {
      timezone: 'Europe/Zurich', reason: 'clock_untrusted', selected_at: NOW,
      requested_duration_minutes: 60, condition: { kind: 'SWT', threshold_kpa: 40, sources: [{ device_eui: SENSOR_EUI, channel: 'swt_1' }] },
      evaluation: { status: 'SKIPPED', reason: 'clock_untrusted', value: null, unit: null, sources: [] },
      observation: { reason: 'clock_untrusted', sources: [] }, readiness: null, qualification: null,
    };
    const summary = await worker.runDue({ db: f.db, now: NOW, clock: async () => ({ trusted: true, reason: 'trusted' }), qualificationProvider: () => ({ qualified: true }) });
    assert.equal(summary.errors.length, 0, JSON.stringify(summary));
    const occurrence = f.native.prepare('SELECT * FROM irrigation_occurrences WHERE schedule_uuid=? AND decision_at IS NOT NULL ORDER BY local_date DESC, local_time DESC LIMIT 1').get(SCHEDULE_UUID);
    assert.ok(occurrence, `worker must persist a terminal decision before projection: ${JSON.stringify(summary)}`);
    const decisionKey = `${ZONE_UUID}|${SCHEDULE_UUID}|${occurrence.local_date}|${occurrence.local_time}`;
    const decision = await replication.publishProjection(f.db, { kind: 'DECISION', key: decisionKey, now: NOW, clockStatus: { trusted: true, reason: null } });
    const runtimeCheck = contractCheck('Runtime');
    const valveCheck = contractCheck('ValveRuntime');
    const decisionCheck = contractCheck('Decision');
    assert.equal(runtimeCheck(JSON.parse(runtime.projection.payload_json)), true, JSON.stringify(runtimeCheck.errors));
    assert.equal(valveCheck(JSON.parse(valve.projection.payload_json)), true, JSON.stringify(valveCheck.errors));
    assert.ok(JSON.parse(runtime.projection.payload_json).source_choices.SWT.length > 0);
    const decisionPayload = JSON.parse(decision.projection.payload_json);
    assert.equal(decisionPayload.decision_key, decisionKey);
    assert.equal(Object.hasOwn(decisionPayload, 'clock'), false);
    assert.equal(Object.hasOwn(decisionPayload, 'as_of'), false);
    assert.equal(Object.hasOwn(decisionPayload, 'valid_until'), false);
    assert.equal(decisionPayload.evidence.reason, occurrence.decision_reason);
    assert.equal(decisionPayload.evidence.observation != null, true, JSON.stringify({ occurrence, decisionPayload, summary }));
    assert.equal(decisionCheck(decisionPayload), true, JSON.stringify(decisionCheck.errors));
    const repeat = await replication.publishProjection(f.db, { kind: 'DECISION', key: decisionKey, now: '2026-10-20T08:08:00.000Z', clockStatus: { trusted: false, reason: 'clock_untrusted' } });
    assert.equal(repeat.changed, false);
    assert.equal(repeat.projection.projection_revision, decision.projection.projection_revision);
    f.native.close();
    f.native = new DatabaseSync(f.file);
    f.db = facade(f.native);
    const restartRead = await replication.readProjection(f.db, { kind: 'DECISION', key: decisionKey });
    assert.equal(restartRead.projection_revision, decision.projection.projection_revision);
  } finally { closeFixture(f); }
});

test('worker-produced SWT, VWC, and DENDRO evidence is normalized to the accepted Decision schema', async () => {
  const cases = [
    {
      label: 'SWT samples',
      condition: { kind: 'SWT', threshold_kpa: 40, sources: [{ device_eui: SENSOR_EUI, channel: 'swt_1' }] },
      evidence: {
        sources: [{ device_eui: SENSOR_EUI, channel: 'swt_1', eligible: true, samples: [
          { at: '2026-10-20T07:55:00.000Z', value: 20 },
          { at: '2026-10-20T08:00:00.000Z', value: 30 },
        ] }],
        due_at: NOW, observation_window_minutes: 60,
      },
      assertEvidence: (evidence) => {
        assert.equal(evidence.evaluation.status, 'NOT_MET');
        assert.equal(evidence.evaluation.sources[0].kind, 'SWT');
        assert.equal(evidence.evaluation.sources[0].sample_count, 2);
        assert.equal(evidence.evaluation.sources[0].first_sample_at, '2026-10-20T07:55:00.000Z');
        assert.equal(evidence.evaluation.sources[0].last_sample_at, '2026-10-20T08:00:00.000Z');
        assert.equal(evidence.observation.sources[0].device_eui, SENSOR_EUI);
      },
    },
    {
      label: 'VWC samples',
      condition: { kind: 'VWC', threshold_percent: 20, sources: [{ device_eui: SENSOR_EUI, channel: 'vwc_1' }] },
      evidence: {
        sources: [{ device_eui: SENSOR_EUI, channel: 'vwc_1', eligible: true, samples: [
          { at: '2026-10-20T07:55:00.000Z', value: 30 },
          { at: '2026-10-20T08:00:00.000Z', value: 40 },
        ] }],
        due_at: NOW, observation_window_minutes: 60,
      },
      assertEvidence: (evidence) => {
        assert.equal(evidence.evaluation.status, 'NOT_MET');
        assert.equal(evidence.evaluation.sources[0].kind, 'VWC');
        assert.equal(evidence.evaluation.sources[0].sample_count, 2);
        assert.equal(evidence.evaluation.sources[0].threshold, 20);
        assert.equal(evidence.observation.sources[0].channel, 'vwc_1');
      },
    },
    {
      label: 'DENDRO hold',
      condition: { kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' },
      evidence: {
        analysis: {
          computed_at: NOW, stress: 'moderate', action: 'maintain_recovery_hold', usable_tree_count: 2,
        },
        sources: [{ kind: 'DENDRO', computed_at: NOW }],
      },
      assertEvidence: (evidence) => {
        assert.equal(evidence.evaluation.status, 'NOT_MET');
        assert.equal(evidence.evaluation.value, null);
        assert.equal(evidence.evaluation.sources[0].kind, 'DENDRO');
        assert.equal(evidence.evaluation.sources[0].stress, 'moderate');
        assert.equal(evidence.evaluation.sources[0].action, 'maintain_recovery_hold');
        assert.equal(evidence.evaluation.sources[0].usable_tree_count, 2);
        assert.equal(evidence.observation.sources[0].kind, 'DENDRO');
        assert.equal(evidence.observation.sources[0].device_eui, null);
        assert.equal(evidence.observation.sources[0].channel, null);
      },
    },
  ];
  for (const entry of cases) {
    const f = fixture();
    // R17-M1: the VWC case runs with the edge VWC gate on (default off).
    await f.db.run("INSERT INTO app_settings(key, value, updated_at) VALUES ('conditional_irrigation_vwc_enabled', '1', datetime('now'))");
    try {
      f.native.prepare('UPDATE irrigation_policies SET condition_json=?,sync_version=sync_version+1,updated_at=? WHERE policy_uuid=?')
        .run(JSON.stringify(entry.condition), NOW, POLICY_UUID);
      const summary = await worker.runDue({
        db: f.db, now: NOW, clock: async () => ({ trusted: true, reason: 'trusted' }),
        qualificationProvider: () => ({ qualified: true, identity: 'fixture-qualification' }),
        readEvidence: async () => entry.evidence,
      });
      assert.equal(summary.errors.length, 0, `${entry.label}: ${JSON.stringify(summary)}`);
      assert.ok(summary.skipped >= 1, `${entry.label}: ${JSON.stringify(summary)}`);
      const occurrence = f.native.prepare('SELECT * FROM irrigation_occurrences WHERE schedule_uuid=? AND decision_at IS NOT NULL ORDER BY local_date DESC, local_time DESC LIMIT 1').get(SCHEDULE_UUID);
      assert.ok(occurrence, entry.label);
      const decisionKey = `${ZONE_UUID}|${SCHEDULE_UUID}|${occurrence.local_date}|${occurrence.local_time}`;
      const decision = await replication.publishProjection(f.db, { kind: 'DECISION', key: decisionKey, now: NOW, clockStatus: { trusted: true, reason: null } });
      const payload = JSON.parse(decision.projection.payload_json);
      const decisionCheck = contractCheck('Decision');
      assert.equal(decisionCheck(payload), true, `${entry.label}: ${JSON.stringify(decisionCheck.errors)}`);
      entry.assertEvidence(payload.evidence);
    } finally { closeFixture(f); }
  }
});

test('readPolicy reports process timezone and never accepts a caller timezone override', async () => {
  const f = fixture();
  try {
    const result = await policyApi.readPolicy({ db: f.db, zone: ZONE_UUID, now: NOW, processTimezone: 'Europe/Zurich' });
    assert.equal(result.legacy_process_timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(replication.processTimezone('Europe/Zurich'), 'Europe/Zurich');
    assert.equal(replication.processTimezone('not/a-timezone'), null);
  } finally { closeFixture(f); }
});

test('missing source scans retain typed tombstones and do not churn revisions before refresh', async () => {
  const f = fixture();
  try {
    const live = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: NOW, clockStatus: { trusted: true, reason: null } });
    f.native.prepare('UPDATE irrigation_zones SET deleted_at=? WHERE zone_uuid=?').run('2026-10-20T08:03:00.000Z', ZONE_UUID);
    const deleted = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:03:00.000Z', clockStatus: { trusted: true, reason: null } });
    assert.equal(deleted.projection.projection_revision, live.projection.projection_revision + 1);
    const deletedPayload = JSON.parse(deleted.projection.payload_json);
    assert.equal(deletedPayload.policy_uuid, POLICY_UUID);
    assert.equal(deletedPayload.deleted_at, '2026-10-20T08:03:00.000Z');
    const unchanged = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:04:00.000Z', clockStatus: { trusted: true, reason: null } });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.projection.projection_revision, deleted.projection.projection_revision);
    const refreshed = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:09:00.000Z', clockStatus: { trusted: true, reason: null } });
    assert.equal(refreshed.projection.projection_revision, deleted.projection.projection_revision + 1);
    assert.equal(JSON.parse(refreshed.projection.payload_json).deleted_at, deletedPayload.deleted_at);
    const event = f.native.prepare("SELECT gateway_device_eui FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_RUNTIME' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(event.gateway_device_eui, GATEWAY);
  } finally { closeFixture(f); }
});

test('policy-only deletion tombstones the zone runtime while the zone remains live', async () => {
  const f = fixture();
  try {
    const live = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: NOW, clockStatus: { trusted: true, reason: null } });
    f.native.prepare('UPDATE irrigation_policies SET deleted_at=?,updated_at=? WHERE policy_uuid=?').run('2026-10-20T08:03:00.000Z', '2026-10-20T08:03:00.000Z', POLICY_UUID);
    const deleted = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:03:00.000Z', clockStatus: { trusted: true, reason: null } });
    const payload = JSON.parse(deleted.projection.payload_json);
    assert.equal(deleted.projection.projection_revision, live.projection.projection_revision + 1);
    assert.equal(payload.deleted_at, '2026-10-20T08:03:00.000Z');
    assert.equal(payload.policy_uuid, POLICY_UUID);
    const unchanged = await replication.publishProjection(f.db, { kind: 'POLICY_RUNTIME', key: ZONE_UUID, now: '2026-10-20T08:04:00.000Z', clockStatus: { trusted: true, reason: null } });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.projection.projection_revision, deleted.projection.projection_revision);
  } finally { closeFixture(f); }
});

test('valve tombstones use the durable gateway envelope scope after device removal', async () => {
  const f = fixture();
  try {
    await replication.publishProjection(f.db, { kind: 'VALVE_RUNTIME', key: VALVE_EUI, now: NOW, clockStatus: { trusted: true, reason: null } });
    f.native.prepare('UPDATE valve_schedules SET deleted_at=? WHERE schedule_uuid=?').run('2026-10-20T08:03:00.000Z', SCHEDULE_UUID);
    const deleted = await replication.publishProjection(f.db, { kind: 'VALVE_RUNTIME', key: VALVE_EUI, now: '2026-10-20T08:03:00.000Z', clockStatus: { trusted: true, reason: null } });
    const payload = JSON.parse(deleted.projection.payload_json);
    assert.equal(payload.device_eui, VALVE_EUI);
    assert.equal(payload.deleted_at, '2026-10-20T08:03:00.000Z');
    f.native.prepare('UPDATE devices SET deleted_at=? WHERE UPPER(deveui)=UPPER(?)').run('2026-10-20T08:04:00.000Z', VALVE_EUI);
    await replication.publishProjection(f.db, { kind: 'VALVE_RUNTIME', key: VALVE_EUI, now: '2026-10-20T08:04:00.000Z', clockStatus: { trusted: true, reason: null } });
    const event = f.native.prepare("SELECT gateway_device_eui FROM sync_outbox WHERE aggregate_type='IRRIGATION_POLICY_VALVE_RUNTIME' ORDER BY rowid DESC LIMIT 1").get();
    assert.equal(event.gateway_device_eui, GATEWAY);
  } finally { closeFixture(f); }
});

test('valve reassignment retires the old policy binding instead of publishing a live mixed-zone runtime', async () => {
  const f = fixture();
  try {
    const live = await replication.publishProjection(f.db, { kind: 'VALVE_RUNTIME', key: VALVE_EUI, now: NOW, clockStatus: { trusted: true, reason: null } });
    const movedZone = '32345678-1234-4234-8234-123456789abc';
    f.native.prepare("INSERT INTO irrigation_zones(id,name,user_id,created_at,updated_at,timezone,zone_uuid,gateway_device_eui,sync_version) VALUES (?,?,?,?,?,?,?,?,?)").run(102, 'Moved zone', 101, NOW, NOW, 'Europe/Zurich', movedZone, GATEWAY, 1);
    f.native.prepare('UPDATE devices SET irrigation_zone_id=?,updated_at=? WHERE UPPER(deveui)=UPPER(?)').run(102, '2026-10-20T08:03:00.000Z', VALVE_EUI);
    const retired = await replication.publishProjection(f.db, { kind: 'VALVE_RUNTIME', key: VALVE_EUI, now: '2026-10-20T08:03:00.000Z', clockStatus: { trusted: true, reason: null } });
    const payload = JSON.parse(retired.projection.payload_json);
    assert.equal(retired.projection.projection_revision, live.projection.projection_revision + 1);
    assert.equal(payload.deleted_at, '2026-10-20T08:03:00.000Z');
    assert.equal(payload.policy_uuid, POLICY_UUID);
    assert.equal(payload.zone_uuid, ZONE_UUID);
  } finally { closeFixture(f); }
});
