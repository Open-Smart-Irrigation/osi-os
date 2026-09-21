'use strict';
// Co-located tests for osi-entity-name. The vector table below is the whole of
// section 4 of docs/superpowers/specs/2026-09-21-zone-device-rename-design.md;
// the TypeScript copy in the GUI and the Java class in osi-server carry the
// same sixteen rows.
const assert = require('node:assert/strict');
const test = require('node:test');

const entityName = require('./index');

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');

const GATEWAY = '0011223344556677';
const DEVICE = 'AABBCCDDEEFF0011';
const ZONE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-09-21T09:00:00.000Z';

const ACCEPTED = [
  ['North block', 'North block'],
  ['  North block \n', 'North block'],
  ['\u00a0Bloc nord\u00a0', 'Bloc nord'],
  ['\ufeffNorth', 'North'],
  ['\u2028North\u2029', 'North'],
  ['a'.repeat(100), 'a'.repeat(100)],
  ['\ud83c\udf31'.repeat(100), '\ud83c\udf31'.repeat(100)],
];

const REJECTED = [
  ['', 'name_empty'],
  ['   ', 'name_empty'],
  ['Row\t7', 'name_control_characters'],
  ['Row\u00007', 'name_control_characters'],
  ['A\u2028B', 'name_control_characters'],
  ['\u0085North', 'name_control_characters'],
  ['a'.repeat(101), 'name_too_long'],
  ['\ud83c', 'name_invalid_unicode'],
  ['\udf31x', 'name_invalid_unicode'],
];

test('the accepted vectors normalize to their stored form', () => {
  for (const [input, expected] of ACCEPTED) {
    assert.equal(
      entityName.normalizeEntityName(input),
      expected,
      'vector ' + JSON.stringify(input)
    );
  }
});

test('the rejected vectors fail with their reason code', () => {
  for (const [input, reason] of REJECTED) {
    assert.throws(
      () => entityName.normalizeEntityName(input),
      (error) => error.code === reason && error.statusCode === 400,
      'vector ' + JSON.stringify(input) + ' must fail with ' + reason
    );
  }
});

test('the limit counts code points, not UTF-16 units', () => {
  assert.equal(entityName.ENTITY_NAME_MAX, 100);
  const hundredSeedlings = '\ud83c\udf31'.repeat(100);
  assert.equal(hundredSeedlings.length, 200);
  assert.equal(Array.from(hundredSeedlings).length, 100);
  assert.equal(entityName.normalizeEntityName(hundredSeedlings), hundredSeedlings);
  assert.throws(
    () => entityName.normalizeEntityName('\ud83c\udf31'.repeat(101)),
    (error) => error.code === 'name_too_long'
  );
});

test('a missing name is name_empty and any other non-string is name_invalid_unicode', () => {
  for (const missing of [undefined, null]) {
    assert.throws(
      () => entityName.normalizeEntityName(missing),
      (error) => error.code === 'name_empty' && error.statusCode === 400,
      'a body without a name field must read as name_empty, not as broken Unicode'
    );
  }
  for (const wrongType of [42, {}, ['North'], true]) {
    assert.throws(
      () => entityName.normalizeEntityName(wrongType),
      (error) => error.code === 'name_invalid_unicode' && error.statusCode === 400,
      'vector ' + JSON.stringify(wrongType)
    );
  }
});

test('the surrogate scan does not depend on String.prototype.isWellFormed', () => {
  const source = require('node:fs').readFileSync(__dirname + '/index.js', 'utf8');
  // Call-shaped, so the comment in index.js that explains why the feature is
  // avoided does not trip its own guard.
  assert.equal(/\.(?:isWellFormed|toWellFormed)\s*\(/.test(source), false,
    'the gateway image ships a Node 20-era package; the scan must be hand-written');
});

// A fixture on the real schema: seed-blank.sql brings the two outbox triggers
// with it, so an assertion about sync_outbox is an assertion about what a
// gateway would really enqueue. sync_link_state decides whether they fire at
// all, which is why `linked` is a knob.
function fixture(t, options = {}) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec(SEED);
  raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) ' +
    "VALUES(1,'grower','hash',?,?,?,'admin')"
  ).run(NOW, NOW, ACTOR);
  if (options.linked !== false) {
    raw.prepare(
      'INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) ' +
      "VALUES('cloud',1,?,?)"
    ).run(GATEWAY, NOW);
  }
  raw.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) ' +
    'VALUES(1,?,1,?,?,3,?,?)'
  ).run('Old zone', ZONE_UUID, GATEWAY, NOW, NOW);
  raw.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) ' +
    "VALUES(?,?,'DRAGINO_LSN50',1,1,?,5,?,?)"
  ).run(DEVICE, 'Old device', GATEWAY, NOW, NOW);
  // The zone INSERT trigger enqueues its own ZONE_UPSERTED. Clear it so every
  // count below is about the rename under test.
  raw.exec('DELETE FROM sync_outbox');

  // Exactly the shape osi-db-helper's createTransactionScope hands a writer:
  // get / run / all / exec, and no transaction method.
  const scope = {
    get: async (sql, params = []) => raw.prepare(sql).get(...params),
    all: async (sql, params = []) => raw.prepare(sql).all(...params),
    run: async (sql, params = []) => { raw.prepare(sql).run(...params); },
    exec: async (sql) => { raw.exec(sql); },
  };
  const db = Object.assign({}, scope, {
    transaction: async (executor) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const value = await executor(scope);
        raw.exec('COMMIT');
        return value;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  });
  return { raw, db, scope };
}

function outbox(raw) {
  return raw.prepare(
    'SELECT aggregate_type, aggregate_key, op, payload_json, sync_version FROM sync_outbox ORDER BY rowid'
  ).all();
}

test('renaming a zone writes the row once and enqueues one ZONE_UPSERTED', async (t) => {
  const { raw, db } = fixture(t);
  const before = Date.now();
  const result = await entityName.renameZone(db, { zoneId: 1, name: 'North block' });
  assert.deepEqual(
    {
      changed: result.changed,
      id: result.id,
      zone_uuid: result.zone_uuid,
      name: result.name,
      sync_version: result.sync_version,
    },
    { changed: true, id: 1, zone_uuid: ZONE_UUID, name: 'North block', sync_version: 4 }
  );
  const row = raw.prepare('SELECT name, sync_version, updated_at FROM irrigation_zones WHERE id=1').get();
  assert.equal(row.name, 'North block');
  assert.equal(row.sync_version, 4);
  assert.ok(Date.parse(row.updated_at) >= before - 1000, 'updated_at must be refreshed');
  const events = outbox(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'ZONE_UPSERTED');
  assert.equal(events[0].aggregate_type, 'ZONE');
  assert.equal(events[0].aggregate_key, ZONE_UUID);
  assert.equal(events[0].sync_version, 4);
  assert.equal(JSON.parse(events[0].payload_json).name, 'North block');
});

test('renaming a zone by uuid reaches the same row', async (t) => {
  const { raw, db } = fixture(t);
  const result = await entityName.renameZone(db, { zoneUuid: ZONE_UUID.toUpperCase(), name: 'Bloc nord' });
  assert.equal(result.changed, true);
  assert.equal(result.id, 1);
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Bloc nord');
});

test('renaming a device writes the row once and enqueues one DEVICE_FLAGS_UPDATED', async (t) => {
  const { raw, db } = fixture(t);
  const result = await entityName.renameDevice(db, { deveui: DEVICE, name: 'Probe 7' });
  assert.deepEqual(result, { changed: true, deveui: DEVICE, name: 'Probe 7', sync_version: 6 });
  assert.equal(raw.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(DEVICE).sync_version, 6);
  const events = outbox(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'DEVICE_FLAGS_UPDATED');
  assert.equal(events[0].aggregate_type, 'DEVICE');
  assert.equal(events[0].aggregate_key, DEVICE);
  assert.equal(JSON.parse(events[0].payload_json).name, 'Probe 7');
});

test('an unchanged name writes nothing and enqueues nothing', async (t) => {
  const { raw, db } = fixture(t);
  const zone = await entityName.renameZone(db, { zoneId: 1, name: 'Old zone' });
  const device = await entityName.renameDevice(db, { deveui: DEVICE, name: 'Old device' });
  assert.equal(zone.changed, false);
  assert.equal(zone.sync_version, 3);
  assert.equal(device.changed, false);
  assert.equal(device.sync_version, 5);
  assert.equal(raw.prepare('SELECT sync_version FROM irrigation_zones WHERE id=1').get().sync_version, 3);
  assert.equal(raw.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(DEVICE).sync_version, 5);
  assert.equal(outbox(raw).length, 0);
});

test('an unlinked gateway writes the row and enqueues nothing', async (t) => {
  const { raw, db } = fixture(t, { linked: false });
  await entityName.renameZone(db, { zoneId: 1, name: 'North block' });
  await entityName.renameDevice(db, { deveui: DEVICE, name: 'Probe 7' });
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 7');
  assert.equal(outbox(raw).length, 0);
});

test('a missing row is a 404 not_found', async (t) => {
  const { db } = fixture(t);
  for (const call of [
    () => entityName.renameZone(db, { zoneId: 99, name: 'North block' }),
    () => entityName.renameZone(db, { zoneUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'North block' }),
    () => entityName.renameDevice(db, { deveui: 'AABBCCDDEEFF9999', name: 'Probe 7' }),
  ]) {
    await assert.rejects(call, (error) => error.code === 'not_found' && error.statusCode === 404);
  }
});

test('a deleted row is a 404 not_found', async (t) => {
  const { raw, db } = fixture(t);
  raw.prepare('UPDATE irrigation_zones SET deleted_at=? WHERE id=1').run(NOW);
  raw.prepare('UPDATE devices SET deleted_at=? WHERE deveui=?').run(NOW, DEVICE);
  raw.exec('DELETE FROM sync_outbox');
  await assert.rejects(
    () => entityName.renameZone(db, { zoneId: 1, name: 'North block' }),
    (error) => error.code === 'not_found'
  );
  await assert.rejects(
    () => entityName.renameDevice(db, { deveui: DEVICE, name: 'Probe 7' }),
    (error) => error.code === 'not_found'
  );
});

test('exactly one of zoneId and zoneUuid is required', async (t) => {
  const { db } = fixture(t);
  await assert.rejects(
    () => entityName.renameZone(db, { name: 'North block' }),
    /exactly one of zoneId/
  );
  await assert.rejects(
    () => entityName.renameZone(db, { zoneId: 1, zoneUuid: ZONE_UUID, name: 'North block' }),
    /exactly one of zoneId/
  );
});

test('the in-transaction writers run inside a caller transaction and commit together', async (t) => {
  const { raw, db } = fixture(t);
  const result = await db.transaction(async (tx) => {
    assert.equal(typeof tx.transaction, 'undefined',
      'a transaction scope has no transaction() of its own');
    const zone = await entityName.renameZoneInTransaction(tx, { zoneId: 1, name: 'North block' });
    const device = await entityName.renameDeviceInTransaction(tx, { deveui: DEVICE, name: 'Probe 7' });
    return { zone, device };
  });
  assert.equal(result.zone.sync_version, 4);
  assert.equal(result.device.sync_version, 6);
  const events = outbox(raw);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.op), ['ZONE_UPSERTED', 'DEVICE_FLAGS_UPDATED']);
});

test('a caller rollback undoes the rename and the outbox row', async (t) => {
  const { raw, db } = fixture(t);
  await assert.rejects(
    db.transaction(async (tx) => {
      await entityName.renameZoneInTransaction(tx, { zoneId: 1, name: 'North block' });
      throw new Error('caller changed its mind');
    }),
    /caller changed its mind/
  );
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Old zone');
  assert.equal(outbox(raw).length, 0);
});
