'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { facadeDb, makeAuthHeader } = require('./lib/scoped-access-harness');

for (const profile of ['bcm2712', 'bcm2709']) {
  const root = path.resolve(__dirname, `../conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red`);
  const helper = require(path.join(root, 'osi-history-helper'));
  const router = require(path.join(root, 'osi-history-router'));
  const base = { zoneId: 1, zoneIds: [1], from: '2026-03-29', to: '2026-03-30', granularity: 'daily', channels: 'swt_2', nowMs: Date.parse('2026-07-03T12:00:00Z') };
  function database() {
    const raw = new DatabaseSync(':memory:');
    raw.exec(fs.readFileSync(path.resolve(__dirname, '../database/seed-blank.sql'), 'utf8'));
    raw.exec(`INSERT INTO users(id, username, password_hash, created_at, updated_at) VALUES (1, 'export-test', 'h', 'x', 'x');
      INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone, created_at, updated_at) VALUES (1, 'Zürich é', 1, 'export-zone', 'Europe/Zurich', 'x', 'x');
      INSERT INTO devices(deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES ('A840410000000001', 'Sonde ü', 'DRAGINO_LSN50', 1, 1, 1, 'x', 'x');
      INSERT INTO device_data(deveui, recorded_at, swt_1, swt_2) VALUES ('A840410000000001', '2026-03-28T23:30:00Z', 99, 0);`);
    return raw;
  }

  test(`${profile}: per-zone and all-zones builders enforce the same range and row bounds`, async () => {
    const raw = database();
    try {
      const db = facadeDb(raw);
      for (const build of [helper.buildZoneExportCsv, helper.buildAllZonesExportCsv]) {
        await assert.rejects(build(db, { ...base, from: '1900-01-01' }), { statusCode: 413, code: 'RANGE_TOO_LARGE' });
        await assert.rejects(build(db, { ...base, granularity: 'raw', channels: 'swt_1,swt_2', maxRows: 1 }), { statusCode: 413, code: 'EXPORT_TOO_LARGE' });
        let reads = 0;
        const recording = { ...db, all(sql, params, cb) { if (/FROM device_data/.test(sql)) reads++; return db.all(sql, params, cb); } };
        await assert.rejects(build(recording, { ...base, from: '2026-01-01', maxRows: 2 }), { statusCode: 413, code: 'EXPORT_TOO_LARGE' });
        assert.equal(reads, 0, 'empty bucket cost is checked before reading history');
      }
    } finally { raw.close(); }
  });

  test(`${profile}: inclusive range edges, aggregate budget across zones, and hard ceiling`, async () => {
    const raw = database();
    try {
      const db = facadeDb(raw);
      raw.exec("INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone, created_at, updated_at) VALUES (2, 'Second', 1, 'second', 'UTC', 'x', 'x');");
      const insert = raw.prepare("INSERT INTO devices(deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES (?, 'Empty sensor', 'DRAGINO_LSN50', 1, ?, 1, 'x', 'x')");
      insert.run('A840410000000002', 2);
      await assert.rejects(helper.buildAllZonesExportCsv(db, { ...base, zoneIds: [1, 2], maxRows: 6 }), { statusCode: 413, code: 'EXPORT_TOO_LARGE' });
      for (let i = 3; i <= 11; i++) insert.run('A8404100000000' + i.toString(16).padStart(2, '0').toUpperCase(), 1);
      for (const build of [helper.buildZoneExportCsv, helper.buildAllZonesExportCsv]) {
        await assert.rejects(build(db, { ...base, from: '2016-07-02', to: '2026-07-01', channels: 'swt_1,swt_2,swt_3', maxRows: 999999 }), { statusCode: 413, code: 'EXPORT_TOO_LARGE' });
      }
      raw.exec('DELETE FROM devices');
      for (const [granularity, days] of [['raw', 92], ['hourly', 730], ['daily', 3660]]) {
        const to = '2026-07-01';
        const date = offset => new Date(Date.parse(to) - offset * 86400000).toISOString().slice(0, 10);
        for (const build of [helper.buildZoneExportCsv, helper.buildAllZonesExportCsv]) {
          await build(db, { ...base, granularity, from: date(days - 1), to });
          await assert.rejects(build(db, { ...base, granularity, from: date(days), to }), { statusCode: 413, code: 'RANGE_TOO_LARGE' });
        }
      }
    } finally { raw.close(); }
  });

  test(`${profile}: daily missing depth stays blank and measured zero stays zero across local DST days`, async () => {
    const raw = database();
    try {
      const result = await helper.buildZoneExportCsv(facadeDb(raw), base);
      assert.deepEqual(result.rows.map(row => [row.timestamp, row.channel_key, row.value]), [
        ['2026-03-28T23:00:00.000Z', 'swt_2', 0],
        ['2026-03-29T22:00:00.000Z', 'swt_2', null],
      ]);
      assert.ok(result.rows.every(row => row.channel_key !== 'swt_1' && row.value !== 99));
    } finally { raw.close(); }
  });

  test(`${profile}: shared slot refuses concurrent zone/all-zone work and releases on every exit`, async () => {
    assert.equal(typeof router.withHistoryExportSlot, 'function');
    const raw = database();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      const db = facadeDb(raw);
      const slow = { ...db, all(sql, params, cb) {
        if (/FROM device_data/.test(sql)) { entered(); gate.then(() => db.all(sql, params, cb)); }
        else return db.all(sql, params, cb);
      } };
      const first = router.buildZoneExportCsv(slow, { ...base, granularity: 'raw' });
      await started;
      const busy = { statusCode: 429, headers: { 'Retry-After': '30' } };
      await assert.rejects(router.buildZoneExportCsv(db, base), busy);
      await assert.rejects(router.withHistoryExportSlot(() => helper.buildAllZonesExportCsv(db, base)), busy);
      const response = await router.handlePortableHistoryRequest({
        db, method: 'GET', path: '/api/history/export.csv',
        authSecret: 'export-fixture-secret',
        authorization: makeAuthHeader({ userId: 1, username: 'export-test', secret: 'export-fixture-secret' }),
        query: { ...base, scope: 'allZones' }, nowMs: base.nowMs,
      });
      assert.equal(response.statusCode, 429);
      assert.equal(response.headers['Retry-After'], '30');
      release();
      assert.ok((await first).csv.startsWith('\uFEFFtimestamp,'));
      for (const error of [new Error('read failed'), Object.assign(new Error('too large'), { statusCode: 413 })]) {
        await assert.rejects(router.withHistoryExportSlot(() => { throw error; }), error);
        assert.equal(await router.withHistoryExportSlot(() => 42), 42);
      }
      await router.withHistoryExportSlot(async () => {
        await assert.rejects(router.buildZoneExportCsv(db, base), busy);
      });
    } finally { release(); raw.close(); }
  });

  test(`${profile}: UTF-8 fixture, blob download bytes, and daily file rewrites keep one BOM`, async () => {
    const columns = ['timestamp', 'zone', 'series_label', 'value'];
    const rows = [
      { timestamp: '2026-03-28T23:00:00.000Z', zone: 'Zürich é', series_label: 'Sonde "ü", µm', value: 0 },
      { timestamp: '2026-03-29T22:00:00.000Z', zone: '=formule', series_label: 'missing', value: null },
    ];
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/history-export-utf8.csv'));
    const csv = helper.toCsv(columns, rows);
    assert.deepEqual(Buffer.from(csv), fixture);
    const machineRows = JSON.parse(execFileSync('python3', ['-c', "import csv,io,json,sys; print(json.dumps(list(csv.DictReader(io.StringIO(sys.stdin.buffer.read().decode('utf-8-sig'))))))"], { input: fixture, encoding: 'utf8' }));
    assert.equal(machineRows[0].timestamp, rows[0].timestamp);
    assert.equal(machineRows[0].zone, 'Zürich é');
    assert.equal(machineRows[1].value, '');
    assert.deepEqual(Buffer.from(await new Blob([csv], { type: 'text/csv;charset=utf-8' }).arrayBuffer()), fixture);
    const raw = database();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-bom-'));
    try {
      const all = await helper.buildAllZonesExportCsv(facadeDb(raw), { ...base, granularity: 'raw' });
      assert.equal(all.csv.charCodeAt(0), 0xfeff);
      assert.equal(all.csv.indexOf('\uFEFF', 1), -1);
      const zone = { zone_uuid: 'export-zone', name: 'Zürich é' };
      fs.mkdirSync(path.join(dir, zone.zone_uuid), { recursive: true });
      const daily = path.join(dir, zone.zone_uuid, 'daily.csv');
      fs.writeFileSync(daily, helper.RAW_CSV_COLUMNS.join(',') + '\n2026-03-28,old,,,,,,,,,1\n');
      for (let run = 0; run < 2; run++) {
        await helper.writeZoneCsv({ exportDir: dir, zone, day: '2026-03-29', rawRows: [], hourlyRows: [], dailyRows: [{ timestamp: '2026-03-29', value: null }] });
        for (const file of [daily, path.join(dir, zone.zone_uuid, 'raw/2026-03-29.csv'), path.join(dir, zone.zone_uuid, 'hourly/2026-03-29.csv')]) {
          const bytes = fs.readFileSync(file);
          assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
          assert.equal(bytes.toString('utf8').indexOf('\uFEFF', 1), -1);
        }
      }
      assert.equal(fs.readFileSync(daily, 'utf8').split('\n').filter(line => line.startsWith('2026-03-29')).length, 1);
    } finally { raw.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
