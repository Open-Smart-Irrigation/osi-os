#!/usr/bin/env node
'use strict';

// GET /api/history/export.csv (all zones) and DELETE /api/analysis/views/:id:
// the helper behaviour (osi-history-helper) and the route handler
// (osi-history-router handlePortableHistoryRequest), both profiles.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb, makeAuthHeader } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['full_raspberrypi_bcm27xx_bcm2712', 'full_raspberrypi_bcm27xx_bcm2709'];
const SECRET = 'portable-history-test-secret';
const NOW_MS = Date.parse('2026-07-03T12:00:00.000Z');

function modulesRoot(profile) {
  return path.join(ROOT, 'conf', profile, 'files/usr/share/node-red');
}

function loadModules(profile) {
  const root = modulesRoot(profile);
  return {
    helper: require(path.join(root, 'osi-history-helper')),
    router: require(path.join(root, 'osi-history-router')),
    scope: require(path.join(root, 'osi-scope-helper')),
  };
}

function seedDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  raw.exec(`
    INSERT INTO users(id, username, password_hash, created_at, updated_at, user_uuid, role, sync_version) VALUES
      (1, 'owner-one', 'h', '2026-05-31', '2026-05-31', 'u-one', 'admin', 1),
      (2, 'owner-two', 'h', '2026-05-31', '2026-05-31', 'u-two', 'researcher', 1),
      (3, 'viewer-three', 'h', '2026-05-31', '2026-05-31', 'u-three', 'viewer', 1);
    INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, timezone, created_at, updated_at) VALUES
      (12, 'Zurich', 1, 'z-zurich', 'Europe/Zurich', '2026-05-31', '2026-05-31'),
      (13, 'Coast', 1, 'z-coast', 'UTC', '2026-05-31', '2026-05-31'),
      (14, 'Other owner', 2, 'z-other', 'UTC', '2026-05-31', '2026-05-31'),
      (15, 'Retired', 1, 'z-retired', 'UTC', '2026-05-31', '2026-05-31');
    UPDATE irrigation_zones SET deleted_at = '2026-06-01T00:00:00.000Z' WHERE id = 15;
    INSERT INTO devices(deveui, name, type_id, user_id, irrigation_zone_id, chameleon_enabled, created_at, updated_at) VALUES
      ('A840410000000001', 'Zurich sensor', 'DRAGINO_LSN50', 1, 12, 1, 'x', 'x'),
      ('A840410000000002', 'Coast sensor', 'DRAGINO_LSN50', 1, 13, 0, 'x', 'x'),
      ('A840410000000003', 'Other sensor', 'DRAGINO_LSN50', 2, 14, 1, 'x', 'x'),
      ('A840410000000004', 'Retired sensor', 'DRAGINO_LSN50', 1, 15, 1, 'x', 'x');
    INSERT INTO device_data(deveui, recorded_at, swt_1, swt_2, swt_3) VALUES
      ('A840410000000001', '2026-06-30T22:30:00.000Z', 10, 20, 30),
      ('A840410000000001', '2026-06-30T21:30:00.000Z', 99, 99, 99),
      ('A840410000000002', '2026-07-01T00:30:00.000Z', 40, 50, 60),
      ('A840410000000003', '2026-07-01T00:15:00.000Z', 70, 80, 90),
      ('A840410000000004', '2026-07-01T00:20:00.000Z', 15, 25, 35);
  `);
  return raw;
}

function parseCsv(text) {
  const lines = text.trimEnd().split('\n');
  const header = lines.shift().split(',');
  return lines.map((line) => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const ch = line[index];
      if (quoted) {
        if (ch === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
        else if (ch === '"') quoted = false;
        else current += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(current); current = ''; }
      else current += ch;
    }
    cells.push(current);
    return Object.fromEntries(header.map((name, index) => [name, cells[index]]));
  });
}

for (const profile of PROFILES) {
  const { helper, router, scope } = loadModules(profile);
  const label = profile.replace('full_raspberrypi_bcm27xx_', '');

  test(`${label}: all-zones export covers the listed zones with each zone's local day`, async () => {
    const raw = seedDb();
    try {
      const result = await helper.buildAllZonesExportCsv(facadeDb(raw), {
        zoneIds: [13, 12],
        from: '2026-07-01',
        to: '2026-07-01',
        granularity: 'raw',
        site: '0016C001F1000001',
        nowMs: NOW_MS,
      });
      assert.equal(result.zoneCount, 2);
      const rows = parseCsv(result.csv);
      assert.equal(result.rowCount, rows.length);
      assert.deepEqual(Object.keys(rows[0]), helper.RAW_CSV_COLUMNS);
      const swt1 = rows.filter((row) => row.channel_key === 'swt_1');
      // Zurich 2026-07-01 starts at 2026-06-30T22:00Z; 21:30Z belongs to the day before.
      assert.deepEqual(swt1.map((row) => [row.zone, row.timestamp, row.value, row.unit]), [
        ['Zurich', '2026-06-30T22:30:00.000Z', '10', 'kPa'],
        ['Coast', '2026-07-01T00:30:00.000Z', '40', 'kPa'],
      ]);
      assert.ok(rows.every((row) => row.site === '0016C001F1000001'));
      assert.ok(!rows.some((row) => row.zone === 'Other owner' || row.zone === 'Retired'));
    } finally {
      raw.close();
    }
  });

  test(`${label}: soil tension is exported in kPa with a pF row that is never below 0`, async () => {
    const raw = seedDb();
    try {
      raw.exec("UPDATE device_data SET swt_2 = 0 WHERE deveui = 'A840410000000002'");
      const result = await helper.buildAllZonesExportCsv(facadeDb(raw), {
        zoneIds: [13], from: '2026-07-01', to: '2026-07-01', granularity: 'raw', nowMs: NOW_MS,
      });
      const rows = parseCsv(result.csv);
      const byKey = Object.fromEntries(rows.map((row) => [row.channel_key, row]));
      assert.equal(byKey.swt_1.unit, 'kPa');
      assert.equal(byKey.swt_1_pf.unit, 'pF');
      assert.equal(Number(byKey.swt_1_pf.value), Number(Math.log10(40 * 10).toFixed(4)));
      assert.equal(byKey.swt_2.value, '0');
      assert.equal(byKey.swt_2_pf.value, '0', 'a saturated probe gets the pF floor of 0');
    } finally {
      raw.close();
    }
  });

  test(`${label}: each source keeps its own Chameleon flag in the export`, async () => {
    const raw = seedDb();
    try {
      // Coast sensor is a plain LSN50 (no Chameleon): SWT1/SWT2 only; the
      // Zurich sensor is a Chameleon source: its third channel is exported.
      const result = await helper.buildAllZonesExportCsv(facadeDb(raw), {
        zoneIds: [12, 13], from: '2026-07-01', to: '2026-07-01', granularity: 'raw', nowMs: NOW_MS,
      });
      const rows = parseCsv(result.csv).filter((row) => row.unit === 'kPa');
      const keysBy = (zone) => rows.filter((row) => row.zone === zone).map((row) => row.channel_key).sort();
      assert.deepEqual(keysBy('Zurich'), ['swt_1', 'swt_2', 'swt_3']);
      assert.deepEqual(keysBy('Coast'), ['swt_1', 'swt_2']);
    } finally {
      raw.close();
    }
  });

  test(`${label}: an unsettled WATERMARK reading is exported with its value, as the data view shows it`, async () => {
    const raw = seedDb();
    try {
      raw.exec(`
        UPDATE devices SET temp_enabled = 1, chameleon_enabled = 0 WHERE deveui = 'A840410000000002';
        INSERT INTO watermark_readings(deveui, recorded_at, payload_hex, frame_status, conversion_version, ch1_status, ch1_kpa, ch2_status, ch2_kpa)
        VALUES ('A840410000000002', '2026-07-01T00:30:00.000Z', 'aa', 'accepted', 'wm-lsn50-p3-v2', 'unsettled', 40, 'ok', 50);
      `);
      const result = await helper.buildAllZonesExportCsv(facadeDb(raw), {
        zoneIds: [13], from: '2026-07-01', to: '2026-07-01', granularity: 'raw', nowMs: NOW_MS,
      });
      const soil = parseCsv(result.csv).filter((row) => row.card_type === 'soil' && row.unit === 'kPa');
      assert.deepEqual(soil.map((row) => [row.channel_key, row.value]), [['swt_1', '40'], ['swt_2', '50']]);
    } finally {
      raw.close();
    }
  });

  test(`${label}: text cells that a spreadsheet would run as a formula are neutralised`, async () => {
    const raw = seedDb();
    try {
      raw.exec(`
        UPDATE irrigation_zones SET name = '=HYPERLINK("http://example.invalid","x")' WHERE id = 13;
        UPDATE devices SET name = '@SUM(1+1)' WHERE deveui = 'A840410000000002';
      `);
      const result = await helper.buildAllZonesExportCsv(facadeDb(raw), {
        zoneIds: [13], from: '2026-07-01', to: '2026-07-01', granularity: 'raw', nowMs: NOW_MS,
      });
      const rows = parseCsv(result.csv);
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(row.zone, `'=HYPERLINK("http://example.invalid","x")`);
        assert.match(row.series_label, /^'@SUM\(1\+1\)/);
        for (const value of Object.values(row)) assert.doesNotMatch(value, /^[=+\-@\t\r]/);
      }
      for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
        assert.equal(helper.toCsv(['a'], [{ a: `${lead}cmd` }]).split('\n')[1].replace(/^"|"$/g, '')[0], "'");
      }
      assert.equal(helper.toCsv(['a'], [{ a: -5 }]), 'a\n-5\n', 'a negative number stays a number');
    } finally {
      raw.close();
    }
  });

  test(`${label}: dates, granularity and range length are validated once for every zone`, async () => {
    const raw = seedDb();
    const db = facadeDb(raw);
    try {
      const base = { zoneIds: [12, 13], nowMs: NOW_MS };
      await assert.rejects(helper.buildAllZonesExportCsv(db, { ...base, from: '2026-7-1', to: '2026-07-01' }), { statusCode: 400 });
      await assert.rejects(helper.buildAllZonesExportCsv(db, { ...base, from: '2026-07-02', to: '2026-07-01' }), { statusCode: 400 });
      await assert.rejects(helper.buildAllZonesExportCsv(db, { ...base, from: '2026-07-01', to: '2026-07-01', granularity: 'weekly' }), { statusCode: 400 });
      await assert.rejects(helper.buildAllZonesExportCsv(db, { ...base, from: '2026-03-01', to: '2026-07-01', granularity: 'raw' }), { statusCode: 413, code: 'RANGE_TOO_LARGE' });
      await assert.rejects(helper.buildAllZonesExportCsv(db, { ...base, from: '2026-07-05', to: '2026-07-05' }), { statusCode: 400 });
      const empty = await helper.buildAllZonesExportCsv(db, { ...base, zoneIds: [], from: '2026-07-01', to: '2026-07-01' });
      assert.equal(empty.csv, helper.RAW_CSV_COLUMNS.join(',') + '\n');
      assert.equal(empty.rowCount, 0);
    } finally {
      raw.close();
    }
  });

  test(`${label}: "today" in the zone furthest ahead is not refused because another zone is still on the day before`, async () => {
    const raw = seedDb();
    try {
      // 22:30Z on 2026-07-02 is already 2026-07-03 in Zurich, still 2026-07-02 in UTC.
      raw.exec("INSERT INTO device_data(deveui, recorded_at, swt_1) VALUES ('A840410000000001', '2026-07-02T22:30:00.000Z', 12)");
      const result = await helper.buildAllZonesExportCsv(facadeDb(raw), {
        zoneIds: [12, 13], from: '2026-07-03', to: '2026-07-03', granularity: 'raw',
        nowMs: Date.parse('2026-07-02T22:45:00.000Z'),
      });
      const rows = parseCsv(result.csv).filter((row) => row.channel_key === 'swt_1');
      assert.deepEqual(rows.map((row) => [row.zone, row.value]), [['Zurich', '12']]);
    } finally {
      raw.close();
    }
  });

  test(`${label}: a large range stays within the row bound and refuses past it before building the rest`, async () => {
    const raw = seedDb();
    try {
      // Three zones, one sensor each with three soil channels every 15 minutes
      // for 92 days: 3 x 8832 uplinks x 6 rows (kPa + pF) = 158976 rows.
      raw.exec("DELETE FROM device_data; UPDATE devices SET irrigation_zone_id = 14, user_id = 1 WHERE deveui = 'A840410000000003';");
      for (const trigger of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'device_data'").all()) {
        raw.exec(`DROP TRIGGER "${trigger.name}"`);
      }
      const insert = raw.prepare('INSERT INTO device_data(deveui, recorded_at, swt_1, swt_2, swt_3) VALUES (?, ?, ?, ?, ?)');
      const startMs = Date.parse('2026-04-01T00:00:00.000Z');
      raw.exec('BEGIN');
      for (const deveui of ['A840410000000001', 'A840410000000002', 'A840410000000003']) {
        raw.exec(`UPDATE devices SET chameleon_enabled = 1 WHERE deveui = '${deveui}'`);
        for (let step = 0; step < 92 * 96; step += 1) {
          insert.run(deveui, new Date(startMs + step * 15 * 60 * 1000).toISOString(), 10 + (step % 50), 20, 30);
        }
      }
      raw.exec('COMMIT');
      const options = {
        zoneIds: [13, 14], from: '2026-04-01', to: '2026-07-01', granularity: 'raw', nowMs: NOW_MS,
      };
      // Zurich is on UTC+2 in summer, so its 92 local days begin 2 h before
      // the first uplink; the two UTC zones see every uplink of their days.
      const twoZones = await helper.buildAllZonesExportCsv(facadeDb(raw), options);
      assert.equal(twoZones.rowCount, 2 * 92 * 96 * 6);
      assert.ok(twoZones.rowCount <= helper.ALL_ZONES_EXPORT_MAX_ROWS);
      assert.equal(twoZones.csv.split('\n').length - 2, twoZones.rowCount);

      const facade = facadeDb(raw);
      const readParams = [];
      const recording = { ...facade, all(sql, params, callback) { readParams.push(...(params || [])); return facade.all(sql, params, callback); } };
      const limited = helper.buildAllZonesExportCsv(recording, {
        ...options, zoneIds: [12, 13, 14], maxRows: 100000,
      });
      await assert.rejects(limited, (error) => {
        assert.equal(error.statusCode, 413);
        assert.equal(error.code, 'EXPORT_TOO_LARGE');
        assert.match(error.suggestion, /granularity|shorter|channels/);
        return true;
      });
      // Zone 12 fits (about 53k rows), zone 13 crosses the bound and stops
      // there; the sensor of zone 14 is never read.
      assert.ok(readParams.includes('A840410000000002'));
      assert.ok(!readParams.includes('A840410000000003'));
    } finally {
      raw.close();
    }
  });

  test(`${label}: deleteAnalysisView removes only the caller's own view`, async () => {
    const raw = seedDb();
    try {
      raw.exec(`
        INSERT INTO analysis_views(id, user_id, owner_user_uuid, name, view_json) VALUES
          (1, 1, 'u-one', 'Mine', '{"schemaVersion":1,"selectors":[]}'),
          (2, 2, 'u-two', 'Theirs', '{"schemaVersion":1,"selectors":[]}');
      `);
      const db = facadeDb(raw);
      await assert.rejects(helper.deleteAnalysisView(db, { userId: 1 }, 2), { statusCode: 404 });
      await assert.rejects(helper.deleteAnalysisView(db, { userId: 1 }, 99), { statusCode: 404 });
      await assert.rejects(helper.deleteAnalysisView(db, { userId: 1 }, 'abc'), { statusCode: 400 });
      await assert.rejects(helper.deleteAnalysisView(db, { userId: 1 }, '1.5'), { statusCode: 400 });
      await helper.deleteAnalysisView(db, { userId: 1 }, '1');
      assert.deepEqual(raw.prepare('SELECT id FROM analysis_views ORDER BY id').all().map((row) => row.id), [2]);
    } finally {
      raw.close();
    }
  });

  // ---------------------------------------------------------------------
  // Route handler: authentication and scope as the neighbouring history
  // (zone export) and analysis (saved views) routes.

  function request(raw, overrides = {}) {
    const scoped = overrides.scopedMode === true;
    return {
      db: facadeDb(raw),
      history: helper,
      scope: scoped ? scope : null,
      scopedMode: scoped,
      authSecret: SECRET,
      fs: null,
      warn: () => {},
      site: '0016C001F1000001',
      nowMs: NOW_MS,
      ...overrides,
    };
  }

  function exportRequest(raw, userId, username, overrides = {}) {
    return request(raw, {
      method: 'GET',
      path: '/api/history/export.csv',
      authorization: makeAuthHeader({ userId, username, secret: SECRET }),
      query: { scope: 'allZones', from: '2026-07-01', to: '2026-07-01', granularity: 'raw' },
      ...overrides,
    });
  }

  function deleteRequest(raw, userId, username, id, overrides = {}) {
    return request(raw, {
      method: 'DELETE',
      path: `/api/analysis/views/${id}`,
      params: { id: String(id) },
      authorization: makeAuthHeader({ userId, username, secret: SECRET }),
      ...overrides,
    });
  }

  test(`${label}: route, flag off: the export holds only the caller's own zones`, async () => {
    const raw = seedDb();
    try {
      const response = await router.handlePortableHistoryRequest(exportRequest(raw, 2, 'owner-two'));
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['Content-Type'], 'text/csv; charset=utf-8');
      assert.match(response.headers['Content-Disposition'], /^attachment; filename="all-zones-2026-07-01_2026-07-01-raw\.csv"$/);
      const zones = new Set(parseCsv(response.payload).map((row) => row.zone));
      assert.deepEqual([...zones], ['Other owner']);

      const owner = await router.handlePortableHistoryRequest(exportRequest(raw, 1, 'owner-one'));
      assert.deepEqual([...new Set(parseCsv(owner.payload).map((row) => row.zone))], ['Zurich', 'Coast']);
    } finally {
      raw.close();
    }
  });

  test(`${label}: route, flag on: every enabled account exports every zone (W1); a disabled account is refused`, async () => {
    const raw = seedDb();
    try {
      for (const [userId, username] of [[1, 'owner-one'], [2, 'owner-two'], [3, 'viewer-three']]) {
        scope._resetForTests();
        const response = await router.handlePortableHistoryRequest(exportRequest(raw, userId, username, { scopedMode: true }));
        assert.equal(response.statusCode, 200, username);
        assert.deepEqual([...new Set(parseCsv(response.payload).map((row) => row.zone))].sort(),
          ['Coast', 'Other owner', 'Zurich'], username);
      }
      raw.exec("UPDATE users SET disabled_at = '2026-06-01T00:00:00.000Z' WHERE id = 3");
      scope._resetForTests();
      const refused = await router.handlePortableHistoryRequest(exportRequest(raw, 3, 'viewer-three', { scopedMode: true }));
      assert.equal(refused.statusCode, 403);
      assert.doesNotMatch(JSON.stringify(refused.payload), /Zurich|Coast/);

      // A token whose username no longer matches the account (immutable subject).
      scope._resetForTests();
      const renamed = await router.handlePortableHistoryRequest(exportRequest(raw, 2, 'someone-else', { scopedMode: true }));
      assert.equal(renamed.statusCode, 403);
    } finally {
      scope._resetForTests();
      raw.close();
    }
  });

  test(`${label}: route: no token is 401, a wrong export scope is 400, a too-large range answers 413 with a suggestion`, async () => {
    const raw = seedDb();
    try {
      const anonymous = await router.handlePortableHistoryRequest(exportRequest(raw, 1, 'owner-one', { authorization: undefined }));
      assert.equal(anonymous.statusCode, 401);
      const forged = await router.handlePortableHistoryRequest(exportRequest(raw, 1, 'owner-one', {
        authorization: makeAuthHeader({ userId: 1, username: 'owner-one', secret: 'another-secret' }),
      }));
      assert.equal(forged.statusCode, 401);
      const wrongScope = await router.handlePortableHistoryRequest(exportRequest(raw, 1, 'owner-one', { query: { from: '2026-07-01' } }));
      assert.equal(wrongScope.statusCode, 400);
      const tooLarge = await router.handlePortableHistoryRequest(exportRequest(raw, 1, 'owner-one', {
        query: { scope: 'allZones', from: '2026-01-01', to: '2026-07-01', granularity: 'raw' },
      }));
      assert.equal(tooLarge.statusCode, 413);
      assert.ok(tooLarge.payload.suggestion);
      const daily = await router.handlePortableHistoryRequest(exportRequest(raw, 1, 'owner-one', {
        query: { scope: 'allZones', from: '2026-07-01' },
      }));
      assert.equal(daily.statusCode, 200);
      assert.match(daily.headers['Content-Disposition'], /-daily\.csv"$/);
    } finally {
      raw.close();
    }
  });

  test(`${label}: route: a saved view is deleted only by its owner, in both modes`, async () => {
    for (const scopedMode of [false, true]) {
      const raw = seedDb();
      try {
        raw.exec(`
          INSERT INTO analysis_views(id, user_id, owner_user_uuid, name, view_json) VALUES
            (1, 2, 'u-two', 'Researcher view', '{"schemaVersion":1,"selectors":[]}'),
            (2, 3, 'u-three', 'Viewer view', '{"schemaVersion":1,"selectors":[]}');
        `);
        scope._resetForTests();
        const foreign = await router.handlePortableHistoryRequest(deleteRequest(raw, 3, 'viewer-three', 1, { scopedMode }));
        assert.equal(foreign.statusCode, 404, `scoped=${scopedMode}`);
        assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM analysis_views WHERE id = 1').get().n, 1);
        scope._resetForTests();
        const own = await router.handlePortableHistoryRequest(deleteRequest(raw, 3, 'viewer-three', 2, { scopedMode }));
        assert.equal(own.statusCode, 204, `scoped=${scopedMode}`);
        assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM analysis_views WHERE id = 2').get().n, 0);
        const anonymous = await router.handlePortableHistoryRequest(deleteRequest(raw, 2, 'owner-two', 1, { scopedMode, authorization: undefined }));
        assert.equal(anonymous.statusCode, 401);
        if (scopedMode) {
          raw.exec("UPDATE users SET disabled_at = '2026-06-01T00:00:00.000Z' WHERE id = 2");
          scope._resetForTests();
          const disabled = await router.handlePortableHistoryRequest(deleteRequest(raw, 2, 'owner-two', 1, { scopedMode }));
          assert.equal(disabled.statusCode, 403);
          assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM analysis_views WHERE id = 1').get().n, 1);
        }
      } finally {
        scope._resetForTests();
        raw.close();
      }
    }
  });

  test(`${label}: route: anything else is 404 and flag-off never uses the scope helper`, async () => {
    const raw = seedDb();
    try {
      const unknown = await router.handlePortableHistoryRequest(exportRequest(raw, 1, 'owner-one', { path: '/api/history/other.csv' }));
      assert.equal(unknown.statusCode, 404);
      const trap = new Proxy({}, { get() { throw new Error('scope helper used with the flag off'); } });
      const response = await router.handlePortableHistoryRequest(exportRequest(raw, 1, 'owner-one', { scope: trap }));
      assert.equal(response.statusCode, 200);
    } finally {
      raw.close();
    }
  });
}

test('both profiles carry byte-identical history modules', () => {
  for (const relative of ['osi-history-helper/index.js', 'osi-history-helper/analysis.js', 'osi-history-router/index.js']) {
    const hashes = PROFILES.map((profile) => crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(modulesRoot(profile), relative))).digest('hex'));
    assert.equal(hashes[0], hashes[1], relative);
  }
});
