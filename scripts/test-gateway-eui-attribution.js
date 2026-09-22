#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { verifyFlows } = require('./verify-trigger-body-parity.js');
const { executeFunction, facadeDb, loadNode } = require('./lib/flow-node-harness.js');

const seedPath = path.join(__dirname, '..', 'database', 'seed-blank.sql');
const seed = fs.readFileSync(seedPath, 'utf8');
const LINK_EUI = 'AABBCCDDEEFF0011';
const RELINK_EUI = '1122334455667788';
const INSTALLATION_UUID = '00000000-0000-4000-8000-000000000099';
const FINALIZE_NODE = loadNode('al-link-finalize');
const installation = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(seed);
  db.prepare("INSERT INTO users(username, password_hash, created_at, user_uuid) VALUES ('identity-test', 'hash', '2026-01-01T00:00:00Z', '00000000-0000-4000-8000-000000000001')").run();
  db.prepare("INSERT INTO sync_link_state(peer_node, linked, updated_at) VALUES ('cloud', 0, '2026-01-01T00:00:00Z')").run();
  return db;
}

function insertBlankRows(db, suffix) {
  db.prepare("INSERT INTO irrigation_zones(name, user_id, zone_uuid, gateway_device_eui) VALUES (?, 1, ?, NULL)").run(`zone-${suffix}`, `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`);
  db.prepare("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui) VALUES (?, ?, 'KIWI_SENSOR', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)").run(`00112233445566${suffix}`, `device-${suffix}`);
}

function setLink(db, linked, eui) {
  db.prepare("UPDATE sync_link_state SET linked = ?, gateway_device_eui = ?, updated_at = '2026-01-02T00:00:00Z' WHERE peer_node = 'cloud'").run(linked, eui);
}

async function executeFinalize(db, eui, { failAfterWrites = false } = {}) {
  const base = facadeDb(db);
  const failAfter = typeof failAfterWrites === 'number' ? failAfterWrites : (failAfterWrites ? 4 : 0);
  const database = {
    Database: function Database() {
      return {
        ...base,
        async transaction(callback) {
          return base.transaction(async (tx) => {
            let writes = 0;
            const injectedTx = {
              ...tx,
              async run(...args) {
                const result = await tx.run(...args);
                writes += 1;
                if (failAfter && writes === failAfter) throw new Error('injected finalize failure');
                return result;
              },
            };
            return callback(injectedTx);
          });
        },
      };
    },
  };
  return executeFunction(FINALIZE_NODE, {
    db,
    msg: {},
    env: { DEVICE_EUI: 'FFEEDDCCBBAA0099' },
    flowState: {
      al_local_username: 'identity-test',
      al_verified_server_username: 'server-user',
      al_offline_verifier: 'offline-verifier',
      al_offline_verifier_version: 2,
      al_server_url: 'https://sync.example.test',
      al_server_sync_token: 'sync-token',
      al_server_sync_token_expires_at: Date.now() + 3600000,
      al_cloud_user_id: 42,
      al_installation_uuid: INSTALLATION_UUID,
      al_gateway_device_eui: eui,
    },
    libOverrides: {
      osiDb: database,
      osiLib: {
        require(name) {
          return name === 'installation'
            ? { ok: true, value: installation }
            : { ok: false, error: `unregistered test helper: ${name}` };
        },
      },
    },
  });
}

test('pre-link blank device and zone are attributed during finalization with one zone event', async () => {
  const db = freshDb();
  try {
    insertBlankRows(db, '01');
    assert.equal(db.prepare('SELECT gateway_device_eui FROM devices').get().gateway_device_eui, null);
    assert.equal(db.prepare('SELECT gateway_device_eui FROM irrigation_zones').get().gateway_device_eui, null);
    const execution = await executeFinalize(db, LINK_EUI);
    assert.deepEqual(execution.result, [{}, null]);
    assert.equal(execution.flowState.account_linked, true);
    assert.equal(db.prepare('SELECT gateway_device_eui FROM devices').get().gateway_device_eui, LINK_EUI);
    assert.equal(db.prepare('SELECT gateway_device_eui FROM irrigation_zones').get().gateway_device_eui, LINK_EUI);
    const zoneEvents = db.prepare("SELECT gateway_device_eui, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE' AND op = 'ZONE_UPSERTED'").all();
    assert.equal(zoneEvents.length, 1);
    assert.equal(zoneEvents[0].gateway_device_eui, LINK_EUI);
    assert.equal(JSON.parse(zoneEvents[0].payload_json).gateway_device_eui, LINK_EUI);
  } finally { db.close(); }
});

test('unlinked irrigation events receive identity and outbox delivery during finalization', async () => {
  const db = freshDb();
  try {
    insertBlankRows(db, '06');
    const zone = db.prepare('SELECT id FROM irrigation_zones').get();
    db.prepare("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, payload_json) VALUES (?, ?, 'IRRIGATE', 'pre_link', '{}')").run(1, zone.id);
    const before = db.prepare('SELECT event_uuid FROM irrigation_events').get();
    assert.equal(before.event_uuid, null, 'an unlinked event on an unassigned zone has no key at insert');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sync_outbox WHERE aggregate_type = 'IRRIGATION_EVENT'").get().n, 0);

    const execution = await executeFinalize(db, LINK_EUI);
    assert.deepEqual(execution.result, [{}, null]);
    const repeat = await executeFinalize(db, LINK_EUI);
    assert.deepEqual(repeat.result, [{}, null], 'repeated finalization must succeed');
    const after = db.prepare('SELECT event_uuid FROM irrigation_events').get();
    assert.match(after.event_uuid, new RegExp(`^irrig-${LINK_EUI}-\\d+$`), 'finalization must mint the canonical key');
    const outbox = db.prepare("SELECT aggregate_key, gateway_device_eui FROM sync_outbox WHERE aggregate_type = 'IRRIGATION_EVENT'").all();
    assert.equal(outbox.length, 1, 'finalization must make the event deliverable');
    assert.equal(outbox[0].aggregate_key, after.event_uuid);
    assert.equal(outbox[0].gateway_device_eui, LINK_EUI);
  } finally { db.close(); }
});

test('finalization preserves existing keys and leaves another gateway untouched', async () => {
  const db = freshDb();
  try {
    insertBlankRows(db, '07');
    const ownZone = db.prepare('SELECT id FROM irrigation_zones').get();
    db.prepare("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, payload_json, event_uuid) VALUES (?, ?, 'IRRIGATE', 'custom', '{}', 'custom-pre-link-key')").run(1, ownZone.id);
    db.prepare("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, payload_json, event_uuid) VALUES (?, ?, 'IRRIGATE', 'whitespace', '{}', ' ')").run(1, ownZone.id);
    db.prepare("INSERT INTO irrigation_zones(name, user_id, zone_uuid, gateway_device_eui) VALUES ('other-gateway', 1, '00000000-0000-4000-8000-000000000008', '1122334455667788')").run();
    const otherZone = db.prepare("SELECT id FROM irrigation_zones WHERE gateway_device_eui = '1122334455667788'").get();
    db.prepare("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, payload_json) VALUES (?, ?, 'IRRIGATE', 'other-gateway', '{}')").run(1, otherZone.id);
    db.prepare("UPDATE irrigation_events SET event_uuid = NULL WHERE reason = 'other-gateway'").run();
    const otherEventBefore = db.prepare("SELECT event_uuid FROM irrigation_events WHERE reason = 'other-gateway'").get().event_uuid;

    await executeFinalize(db, LINK_EUI);
    assert.equal(db.prepare("SELECT event_uuid FROM irrigation_events WHERE reason = 'custom'").get().event_uuid, 'custom-pre-link-key');
    assert.equal(db.prepare("SELECT event_uuid FROM irrigation_events WHERE reason = 'whitespace'").get().event_uuid, ' ');
    assert.equal(db.prepare("SELECT event_uuid FROM irrigation_events WHERE reason = 'other-gateway'").get().event_uuid, otherEventBefore);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sync_outbox WHERE aggregate_type = 'IRRIGATION_EVENT'").get().n, 0);
  } finally { db.close(); }
});

test('linked inserts use sync_link_state identity even when the process environment differs', () => {
  const db = freshDb();
  const priorEnvEui = process.env.DEVICE_EUI;
  try {
    process.env.DEVICE_EUI = 'FFEEDDCCBBAA0099';
    setLink(db, 1, LINK_EUI);
    insertBlankRows(db, '02');
    assert.equal(db.prepare('SELECT gateway_device_eui FROM devices').get().gateway_device_eui, LINK_EUI);
    assert.equal(db.prepare('SELECT gateway_device_eui FROM irrigation_zones').get().gateway_device_eui, LINK_EUI);
  } finally {
    if (priorEnvEui === undefined) delete process.env.DEVICE_EUI;
    else process.env.DEVICE_EUI = priorEnvEui;
    db.close();
  }
});

test('unlink, insert, and relink before reboot attributes the new link identity', async () => {
  const db = freshDb();
  try {
    setLink(db, 1, LINK_EUI);
    setLink(db, 0, null);
    insertBlankRows(db, '03');
    assert.equal(db.prepare("SELECT count(*) AS n FROM devices WHERE gateway_device_eui IS NULL").get().n, 1);
    const execution = await executeFinalize(db, RELINK_EUI);
    assert.deepEqual(execution.result, [{}, null]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM devices WHERE gateway_device_eui = ?").get(RELINK_EUI).n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM irrigation_zones WHERE gateway_device_eui = ?").get(RELINK_EUI).n, 1);
  } finally { db.close(); }
});

test('finalization backfill preserves existing nonblank identities', async () => {
  const db = freshDb();
  try {
    db.prepare("INSERT INTO irrigation_zones(name, user_id, zone_uuid, gateway_device_eui) VALUES ('zone-kept', 1, '00000000-0000-4000-8000-000000000004', 'OLDZONE000000001')").run();
    db.prepare("INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at, gateway_device_eui) VALUES ('0011223344556604', 'device-kept', 'KIWI_SENSOR', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'OLDDEVICE0000001')").run();
    const execution = await executeFinalize(db, LINK_EUI);
    assert.deepEqual(execution.result, [{}, null]);
    assert.equal(db.prepare("SELECT gateway_device_eui FROM devices WHERE deveui = '0011223344556604'").get().gateway_device_eui, 'OLDDEVICE0000001');
    assert.equal(db.prepare("SELECT gateway_device_eui FROM irrigation_zones WHERE name = 'zone-kept'").get().gateway_device_eui, 'OLDZONE000000001');
  } finally { db.close(); }
});

test('failure after all finalizer writes but before commit rolls back state, identities, and zone events', async () => {
  const db = freshDb();
  try {
    insertBlankRows(db, '05');
    const zone = db.prepare('SELECT id FROM irrigation_zones').get();
    db.prepare("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, payload_json) VALUES (?, ?, 'IRRIGATE', 'pre_link', '{}')").run(1, zone.id);
    const execution = await executeFinalize(db, LINK_EUI, { failAfterWrites: 5 });
    assert.equal(execution.result[0], null, 'failure must not reach the success output');
    assert.equal(execution.result[1].statusCode, 500);
    assert.match(execution.result[1].payload.detail, /injected finalize failure/);
    assert.equal(execution.flowState.account_linked, undefined);
    assert.equal(db.prepare("SELECT linked FROM sync_link_state WHERE peer_node = 'cloud'").get().linked, 0);
    assert.equal(db.prepare('SELECT gateway_device_eui FROM devices').get().gateway_device_eui, null);
    assert.equal(db.prepare('SELECT gateway_device_eui FROM irrigation_zones').get().gateway_device_eui, null);
    assert.equal(db.prepare('SELECT event_uuid FROM irrigation_events').get().event_uuid, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sync_outbox').get().n, 0);
  } finally { db.close(); }
});

test('finalization source uses one transaction for link state and identity backfills', () => {
  const profiles = [
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
    'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
  ];
  for (const file of profiles) {
    const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    const node = flow.find((item) => item.name === 'Finalize linked account state');
    assert.ok(node);
    assert.match(node.func, /await db\.transaction\(async \(tx\) => \{/);
    assert.match(node.func, /UPDATE devices SET gateway_device_eui = \?/);
    assert.match(node.func, /UPDATE irrigation_zones SET gateway_device_eui = \?/);
    assert.match(node.func, /await tx\.run\(/g);
  }
});

test('removing the sync_link_state fallback makes trigger-body parity fail', () => {
  const sourcePath = path.join(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
  const flow = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const init = flow.find((item) => item.name === 'Sync Init Schema + Triggers');
  assert.ok(init);
  const fallback = "NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')";
  assert.ok(init.func.includes(fallback));
  init.func = init.func.replace(fallback, 'NULL');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-eui-mutation-'));
  const mutatedPath = path.join(dir, 'flows.json');
  fs.writeFileSync(mutatedPath, JSON.stringify(flow));
  const failures = verifyFlows(mutatedPath, seedPath);
  assert.ok(failures.some((failure) => failure.includes('trg_')), 'mutation must be visible as trigger drift');
});
