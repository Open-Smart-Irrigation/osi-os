'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const helper = require('./index');

function openDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osi-location-')), 'farming.db');
  return new Promise((resolve, reject) => new sqlite3.Database(file, error => {
    if (error) return reject(error);
    const raw = new sqlite3.Database(file);
    const db = {
      run(sql, params = []) { return new Promise((res, rej) => raw.run(sql, params, e => e ? rej(e) : res())); },
      get(sql, params = []) { return new Promise((res, rej) => raw.get(sql, params, (e, row) => e ? rej(e) : res(row))); },
      exec(sql) { return new Promise((res, rej) => raw.exec(sql, e => e ? rej(e) : res())); },
      transaction(fn) { return this.exec('BEGIN IMMEDIATE').then(() => fn(this).then(result => this.exec('COMMIT').then(() => result), e => this.exec('ROLLBACK').then(() => { throw e; }))); },
      close() { return new Promise(res => raw.close(res)); }
    };
    db.exec(fs.readFileSync(path.join(__dirname, '../../../../../../../database/migrations/ordered/0054__installation_location_revisions.sql'), 'utf8') + "CREATE TABLE devices(deveui TEXT PRIMARY KEY, gateway_device_eui TEXT, deleted_at TEXT); CREATE TABLE installation_identity(singleton_id INTEGER PRIMARY KEY, installation_uuid TEXT, recovery_state TEXT);").then(() => db.run('INSERT INTO devices VALUES (?,?,NULL)', ['0016C001F1000001', '0016C001F1000002'])).then(() => db.run('INSERT INTO installation_identity VALUES (1,?,?)', ['11111111-1111-4111-8111-111111111111', 'ACTIVE'])).then(() => resolve(db), reject);
  }));
}
const base = { deviceEui: '0016C001F1000001', installationUuid: '11111111-1111-4111-8111-111111111111', gatewayEui: '0016C001F1000002', actorUserUuid: '22222222-2222-4222-8222-222222222222', now: '2026-09-10T10:00:00+02:00' };
const loc = values => Object.assign({ latitude: 47, longitude: 8, effectiveFrom: '2026-09-10T09:00:00+02:00', coordinateSource: 'manual' }, values);

test('location CAS, replay, correction and historical/future resolution', async () => {
  const db = await openDb();
  const first = await helper.saveLocation(db, Object.assign({}, base, { revisionUuid: '33333333-3333-4333-8333-333333333333', values: loc({}) }));
  const replay = await helper.saveLocation(db, Object.assign({}, base, { revisionUuid: first.revisionUuid, values: loc({}) }));
  assert.equal(replay.replayed, true);
  await assert.rejects(() => helper.saveLocation(db, Object.assign({}, base, { revisionUuid: '44444444-4444-4444-8444-444444444444', values: loc({ longitude: 9 }) })), /base revision/);
  await helper.saveLocation(db, Object.assign({}, base, { baseRevisionUuid: first.revisionUuid, revisionUuid: '44444444-4444-4444-8444-444444444444', values: loc({ longitude: 9, supersedesRevisionUuid: first.revisionUuid }), now: '2026-09-10T11:00:00Z' }));
  assert.equal((await helper.resolveLocation(db, base.deviceEui, '2026-09-10T09:00:00Z')).longitude, 9);
  await helper.saveLocation(db, Object.assign({}, base, { baseRevisionUuid: '44444444-4444-4444-8444-444444444444', revisionUuid: '55555555-5555-4555-8555-555555555555', values: loc({ latitude: 48, effectiveFrom: '2027-01-01T00:00:00Z' }), now: '2026-09-10T12:00:00Z' }));
  assert.equal((await helper.resolveLocation(db, base.deviceEui, '2026-12-01T00:00:00Z')).longitude, 9);
  assert.equal((await helper.resolveLocation(db, base.deviceEui, '2027-02-01T00:00:00Z')).latitude, 48);
  await db.close();
});

test('radio validation, cross-device supersession and rollback', async () => {
  const db = await openDb();
  const radio = await helper.saveRadioConfiguration(db, Object.assign({}, base, { revisionUuid: '66666666-6666-4666-8666-666666666666', values: { effectiveFrom: base.now, configurationSource: 'unknown' } }));
  assert.equal((await helper.resolveRadioConfiguration(db, base.deviceEui)).tx_power_dbm, null);
  await db.run('INSERT INTO devices VALUES (?,NULL,NULL)', ['0016C001F1000003']);
  const other = await helper.saveRadioConfiguration(db, Object.assign({}, base, { deviceEui: '0016C001F1000003', revisionUuid: '99999999-9999-4999-8999-999999999999', values: { effectiveFrom: base.now, configurationSource: 'manual' } }));
  await assert.rejects(() => helper.saveRadioConfiguration(db, Object.assign({}, base, { baseRevisionUuid: radio.revisionUuid, revisionUuid: '77777777-7777-4777-8777-777777777777', values: { effectiveFrom: base.now, antennaGainDbi: 14, configurationSource: 'manual' } })), /antennaGainDbi/);
  await assert.rejects(() => helper.saveRadioConfiguration(db, Object.assign({}, base, { baseRevisionUuid: radio.revisionUuid, revisionUuid: '88888888-8888-4888-8888-888888888888', values: { effectiveFrom: base.now, supersedesRevisionUuid: other.revisionUuid, configurationSource: 'manual' } })), /another device or installation/);
  assert.equal(await db.get('SELECT COUNT(*) AS count FROM device_radio_configuration_revisions').then(row => row.count), 2);
  await db.close();
});


test('a new installation cannot read or use the previous installation revision head', async () => {
  const db=await openDb();
  await helper.saveLocation(db,{...base,revisionUuid:'33333333-3333-4333-8333-333333333333',values:loc({})});
  const next='77777777-7777-4777-8777-777777777777';
  await db.run('UPDATE installation_identity SET installation_uuid=?',[next]);
  assert.equal(await helper.resolveLocation(db,base.deviceEui,'2026-09-11T00:00:00Z'),null);
  const row=await helper.saveLocation(db,{...base,installationUuid:next,revisionUuid:'44444444-4444-4444-8444-444444444444',baseRevisionUuid:null,values:loc({latitude:48})});
  assert.equal(row.revisionNo,2);
  assert.equal((await helper.resolveLocation(db,base.deviceEui,'2026-09-11T00:00:00Z')).installationUuid,next);
  await db.close();
});
