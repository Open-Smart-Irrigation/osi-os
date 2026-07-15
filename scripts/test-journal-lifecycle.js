'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const repoRoot = path.resolve(__dirname, '..');
const profileRoot = path.join(
  repoRoot,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red'
);
const journal = require(path.join(profileRoot, 'osi-journal'));
const { buildAggregate } = journal;

const USER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRINCIPAL_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_USER_UUID = 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0';
const ZONE_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SEASON_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PRIOR_SEASON_UUID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_ZONE_UUID = '22222222-2222-4222-8222-222222222222';
const NO_SEASON_ZONE_UUID = '33333333-3333-4333-8333-333333333333';
const NULL_EUI_ZONE_UUID = '44444444-4444-4444-8444-444444444444';
const NULL_EUI_SEASON_UUID = '55555555-5555-4555-8555-555555555555';
const GATEWAY_EUI = '0016C001F11715E2';
const OWNED_DEVICE_EUI = '70B3D57ED0061234';
const FOREIGN_DEVICE_EUI = 'A84041ABCDEFFEDC';
const WEATHER_DEVICE_EUI = '2CF7F1C000000001';
const RAIN_DEVICE_EUI = '3CF7F1C000000002';
const SECOND_RAIN_DEVICE_EUI = '4CF7F1C000000003';
const VALVE_DEVICE_EUI = '70B3D57ED0065678';
const NULL_EUI_ZONE_DEVICE_EUI = '70B3D57ED0069999';
const ENTRY_UUID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const OWNED_EXPECTATION_ID = 'expectation-owned';
const FOREIGN_ZONE_EXPECTATION_ID = 'expectation-foreign-zone';
const FOREIGN_OWNER_EXPECTATION_ID = 'expectation-foreign-owner';
const CONTEXT_RAW_ROW_LIMIT = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLOT_NUMBERS = [2, 5, 6, 10, 12];
const CONTEXT_CHANNELS = [
  'swt_1',
  'swt_2',
  'swt_3',
  'rain_24h',
  'temperature',
  'relative_humidity',
  'wind_speed',
  'wind_direction',
  'wind_gust',
  'valve_state',
];
const CONTEXT_RECORD_FIELDS = [
  'value',
  'unit',
  'source_device',
  'source_key',
  'observed_at',
  'statistic',
  'window_start',
  'window_end',
  'sample_count',
  'coverage',
  'status',
  'quality',
  'freshness_threshold_s',
  'age_s',
  'reason',
];

function plotUuid(number) {
  return String(number).padStart(8, '0') + '-0000-4000-8000-' +
    String(number).padStart(12, '0');
}

function fixtureZoneUuid(number) {
  return '10000000-0000-4000-8000-' + String(number).padStart(12, '0');
}

function fixtureDeviceEui(number) {
  return 'BEEF' + String(number).padStart(12, '0');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-lifecycle-'));
const dbPath = path.join(tempRoot, 'farming.db');
const nativeConnections = [];

function bind(statement, method, parameters) {
  if (parameters === undefined) return statement[method]();
  if (Array.isArray(parameters)) return statement[method](...parameters);
  return statement[method](parameters);
}

function sqlite3Adapter() {
  class Database {
    constructor(filename, callback) {
      this.native = new DatabaseSync(filename);
      nativeConnections.push(this.native);
      queueMicrotask(() => {
        if (typeof callback === 'function') callback.call(this, null);
      });
    }

    all(sql, parameters, callback) {
      if (typeof parameters === 'function') {
        callback = parameters;
        parameters = undefined;
      }
      try {
        const rows = bind(this.native.prepare(sql), 'all', parameters);
        callback.call(this, null, rows);
      } catch (error) {
        callback.call(this, error);
      }
    }

    run(sql, parameters, callback) {
      if (typeof parameters === 'function') {
        callback = parameters;
        parameters = undefined;
      }
      try {
        const result = bind(this.native.prepare(sql), 'run', parameters);
        callback.call({
          changes: Number(result.changes),
          lastID: Number(result.lastInsertRowid),
        }, null);
      } catch (error) {
        callback.call(this, error);
      }
    }

    exec(sql, callback) {
      try {
        this.native.exec(sql);
        callback.call(this, null);
      } catch (error) {
        callback.call(this, error);
      }
    }
  }

  return {
    Database,
    OPEN_READONLY: 1,
    OPEN_READWRITE: 2,
    OPEN_CREATE: 4,
  };
}

function loadRealDbHelper() {
  const helperPath = path.join(profileRoot, 'osi-db-helper/index.js');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'sqlite3' && parent && parent.filename === helperPath) {
      return sqlite3Adapter();
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(helperPath)];
    return require(helperPath);
  } finally {
    Module._load = originalLoad;
  }
}

function seedDatabase() {
  const seedSql = fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8');
  const native = new DatabaseSync(dbPath);
  native.exec(seedSql);
  native.prepare(
    'INSERT INTO users(id, username, password_hash, created_at, user_uuid) VALUES (?,?,?,?,?)'
  ).run(1, 'journal-test', 'not-used', '2026-07-12T00:00:00.000Z', USER_UUID);
  native.prepare(
    'INSERT INTO users(id, username, password_hash, created_at, user_uuid) VALUES (?,?,?,?,?)'
  ).run(2, 'journal-other', 'not-used', '2026-07-12T00:00:00.000Z', OTHER_USER_UUID);
  native.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) ' +
    'VALUES (?,?,?,?,?,?)'
  ).run(1, 'Journal zone', 1, 'Europe/Zurich', ZONE_UUID, GATEWAY_EUI);
  native.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) ' +
    'VALUES (?,?,?,?,?,?)'
  ).run(2, 'Other owner zone', 2, 'Europe/Zurich', FOREIGN_ZONE_UUID, GATEWAY_EUI);
  native.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) ' +
    'VALUES (?,?,?,?,?,?)'
  ).run(3, 'No season zone', 1, 'Europe/Zurich', NO_SEASON_ZONE_UUID, GATEWAY_EUI);
  native.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) ' +
    'VALUES (?,?,?,?,?,?)'
  ).run(4, 'Legacy null-EUI zone', 1, 'Europe/Zurich', NULL_EUI_ZONE_UUID, null);
  // trg_sync_zones_defaults_ai backfills gateway_device_eui on INSERT (COALESCE to the
  // fleet default), so force it back to NULL via an UPDATE (no such backfill on UPDATE)
  // to reproduce a legacy zone whose gateway_device_eui was never populated.
  native.prepare(
    'UPDATE irrigation_zones SET gateway_device_eui=NULL WHERE id=?'
  ).run(4);
  native.prepare(
    'INSERT INTO zone_seasons(zone_id,season_uuid,name,starts_on,ends_on,crop_type,variety) ' +
    'VALUES (?,?,?,?,?,?,?)'
  ).run(1, SEASON_UUID, 'Barley 2026', '2026-01-01', '2026-12-31', 'barley', 'Golden');
  native.prepare(
    'INSERT INTO zone_seasons(zone_id,season_uuid,name,starts_on,ends_on,crop_type,variety) ' +
    'VALUES (?,?,?,?,?,?,?)'
  ).run(4, NULL_EUI_SEASON_UUID, 'Wheat 2026', '2026-01-01', '2026-12-31', 'wheat', 'Test');
  for (const number of PLOT_NUMBERS) {
    native.prepare(
      'INSERT INTO journal_plots(' +
        'plot_uuid,plot_code,name,zone_uuid,station_code,gateway_device_eui,owner_user_uuid' +
      ') VALUES (?,?,?,?,?,?,?)'
    ).run(
      plotUuid(number),
      'LYS-' + number,
      'Lysimeter ' + number,
      number === 2 ? ZONE_UUID : null,
      'LYS',
      GATEWAY_EUI,
      USER_UUID
    );
    native.prepare(
      'INSERT INTO journal_plot_settings(plot_uuid,layout_code,updated_at,updated_by_principal_uuid) ' +
      'VALUES (?,?,?,?)'
    ).run(plotUuid(number), 'open_field', '2026-07-12T00:00:00.000Z', PRINCIPAL_UUID);
  }
  for (const fixture of [
    { number: 20, code: 'FOREIGN-20', zoneUuid: FOREIGN_ZONE_UUID },
    { number: 21, code: 'NO-SEASON-21', zoneUuid: NO_SEASON_ZONE_UUID },
    { number: 22, code: 'SAME-ZONE-22', zoneUuid: ZONE_UUID },
    { number: 23, code: 'NULL-EUI-23', zoneUuid: NULL_EUI_ZONE_UUID },
  ]) {
    native.prepare(
      'INSERT INTO journal_plots(' +
        'plot_uuid,plot_code,name,zone_uuid,station_code,gateway_device_eui,owner_user_uuid' +
      ') VALUES (?,?,?,?,?,?,?)'
    ).run(
      plotUuid(fixture.number),
      fixture.code,
      fixture.code,
      fixture.zoneUuid,
      'TEST',
      GATEWAY_EUI,
      fixture.number === 20 ? OTHER_USER_UUID : USER_UUID
    );
    native.prepare(
      'INSERT INTO journal_plot_settings(plot_uuid,layout_code,updated_at,updated_by_principal_uuid) ' +
      'VALUES (?,?,?,?)'
    ).run(
      plotUuid(fixture.number),
      'open_field',
      '2026-07-12T00:00:00.000Z',
      PRINCIPAL_UUID
    );
  }
  native.prepare(
    'INSERT INTO devices(' +
      'deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,gateway_device_eui' +
    ') VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    FOREIGN_DEVICE_EUI,
    'Other owner sensor',
    'DRAGINO_LSN50',
    2,
    '2026-07-12T00:00:00.000Z',
    '2026-07-12T00:00:00.000Z',
    2,
    GATEWAY_EUI
  );
  native.prepare(
    'INSERT INTO devices(' +
      'deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,gateway_device_eui' +
    ') VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    OWNED_DEVICE_EUI,
    'Owned journal sensor',
    'DRAGINO_LSN50',
    1,
    '2026-07-12T00:00:00.000Z',
    '2026-07-12T00:00:00.000Z',
    1,
    GATEWAY_EUI
  );
  native.prepare(
    'INSERT INTO devices(' +
      'deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,gateway_device_eui' +
    ') VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    NULL_EUI_ZONE_DEVICE_EUI,
    'Legacy null-EUI zone sensor',
    'DRAGINO_LSN50',
    1,
    '2026-07-12T00:00:00.000Z',
    '2026-07-12T00:00:00.000Z',
    4,
    GATEWAY_EUI
  );
  for (const fixture of [
    {
      deveui: WEATHER_DEVICE_EUI,
      name: 'Shared weather station',
      typeId: 'SENSECAP_S2120',
      zoneId: null,
    },
    {
      deveui: RAIN_DEVICE_EUI,
      name: 'Zone rain gauge',
      typeId: 'AQUASCOPE_LORAIN',
      zoneId: 1,
    },
    {
      deveui: SECOND_RAIN_DEVICE_EUI,
      name: 'Second zone rain gauge',
      typeId: 'AQUASCOPE_LORAIN',
      zoneId: 1,
    },
    {
      deveui: VALVE_DEVICE_EUI,
      name: 'Zone valve',
      typeId: 'STREGA_VALVE',
      zoneId: null,
    },
  ]) {
    native.prepare(
      'INSERT INTO devices(' +
        'deveui,name,type_id,user_id,created_at,updated_at,irrigation_zone_id,gateway_device_eui' +
      ') VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      fixture.deveui,
      fixture.name,
      fixture.typeId,
      1,
      '2026-07-12T00:00:00.000Z',
      '2026-07-12T00:00:00.000Z',
      fixture.zoneId,
      GATEWAY_EUI
    );
  }
  native.close();
}

seedDatabase();
const osiDb = loadRealDbHelper();
const db = new osiDb.Database(dbPath);
let catalog;

function principal(overrides) {
  return Object.assign({
    user_id: 1,
    owner_user_uuid: USER_UUID,
    author_principal_uuid: PRINCIPAL_UUID,
    author_label: 'Journal tester',
    gateway_device_eui: GATEWAY_EUI,
    origin: 'edge-ui',
  }, overrides || {});
}

function validEntry(overrides) {
  return Object.assign({
    entry_uuid: ENTRY_UUID,
    base_sync_version: 0,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    plot_uuid: plotUuid(2),
    occurred_start_local: '2026-07-12T09:30',
    occurred_timezone: 'Europe/Zurich',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 12,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
    note: 'Morning irrigation',
  }, overrides || {});
}

function entryIdentity(row) {
  return [
    row.id,
    row.entry_uuid,
    row.created_at,
    row.recorded_at,
    row.author_principal_uuid,
  ];
}

async function resetMutations() {
  await db.run('DELETE FROM journal_entry_values');
  await db.run('DELETE FROM journal_entries');
  await db.run('DELETE FROM sync_outbox');
  await db.run('DELETE FROM command_ack_outbox');
  await db.run('DELETE FROM applied_commands');
  await db.run('DELETE FROM device_data');
  await db.run('DELETE FROM valve_actuation_expectations');
  await db.run('DELETE FROM zone_valve_assignments');
  await db.run('DELETE FROM weather_station_zones');
  await db.run(
    'UPDATE devices SET current_state=NULL,deleted_at=NULL,rain_gauge_enabled=0'
  );
}

async function storedContext(entryUuid) {
  const row = await db.get(
    'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
    [entryUuid || ENTRY_UUID]
  );
  return row && row.context_json != null ? JSON.parse(row.context_json) : null;
}

function isContextRead(sql) {
  const text = String(sql);
  return text.includes('FROM device_data') ||
    text.includes('FROM devices AS d LEFT JOIN weather_station_zones') ||
    text.includes('ORDER BY vae.commanded_at DESC,vae.expectation_id DESC LIMIT 1');
}

function observeTransactionContextReads() {
  const reads = [];
  return {
    reads,
    database: {
      transaction(executor) {
        return db.transaction((tx) => executor(Object.assign({}, tx, {
          all(sql, params) {
            if (isContextRead(sql)) reads.push({ sql: String(sql), params });
            return tx.all(sql, params);
          },
        })));
      },
    },
  };
}

function observeBuildContextReads() {
  const reads = [];
  return {
    reads,
    database: {
      all(sql, params) {
        if (isContextRead(sql)) reads.push({ sql: String(sql), params });
        return db.all(sql, params);
      },
    },
  };
}

async function count(table) {
  const row = await db.get('SELECT COUNT(*) AS count FROM ' + table);
  return Number(row.count);
}

async function assertNoJournalWrites() {
  assert.equal(await count('journal_entries'), 0);
  assert.equal(await count('journal_entry_values'), 0);
  assert.equal(await count('sync_outbox'), 0);
}

async function journalMutationState() {
  return {
    entries: await db.all('SELECT * FROM journal_entries ORDER BY entry_uuid'),
    values: await db.all(
      'SELECT * FROM journal_entry_values ORDER BY entry_uuid,group_index,attribute_code'
    ),
    outbox: await db.all('SELECT * FROM sync_outbox ORDER BY event_uuid'),
    appliedCommands: await db.all('SELECT * FROM applied_commands ORDER BY command_id'),
    commandAcks: await db.all('SELECT * FROM command_ack_outbox ORDER BY id'),
  };
}

async function seedActuationExpectations() {
  const now = '2026-07-12T07:00:00.000Z';
  const later = '2026-07-12T07:01:00.000Z';
  const insert =
    'INSERT INTO valve_actuation_expectations(' +
      'expectation_id,device_eui,zone_id,commanded_at,commanded_duration_seconds,' +
      'expected_close_at,volume_source,reconciliation_state,created_at' +
    ') VALUES (?,?,?,?,?,?,?,?,?)';
  await db.run(insert, [
    OWNED_EXPECTATION_ID, VALVE_DEVICE_EUI, 1, now, 60, later,
    'unknown', 'OBSERVED_RUNNING', now,
  ]);
  await db.run(insert, [
    FOREIGN_ZONE_EXPECTATION_ID, VALVE_DEVICE_EUI, 2, now, 60, later,
    'unknown', 'OBSERVED_RUNNING', now,
  ]);
  await db.run(insert, [
    FOREIGN_OWNER_EXPECTATION_ID, FOREIGN_DEVICE_EUI, 1, now, 60, later,
    'unknown', 'OBSERVED_RUNNING', now,
  ]);
}

function actuationValue(expectationId) {
  return {
    attribute_code: 'attr.actuation_expectation_id',
    group_index: 0,
    value: expectationId,
    value_status: 'observed',
  };
}

function actuationEntry(expectationId, overrides) {
  return validEntry(Object.assign({
    values: [actuationValue(expectationId)],
  }, overrides || {}));
}

async function rejectInvalidReference(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error && error.code, 'validation_failed');
    assert.ok(
      error.errors.some((detail) => detail && detail.code === 'invalid_reference'),
      JSON.stringify(error.errors)
    );
    return true;
  });
}

async function rejectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error && error.code, code);
    return true;
  });
}

test.before(async () => {
  catalog = await journal.loadCatalog(db);
});

test.beforeEach(resetMutations);

test.after(() => {
  for (const connection of nativeConnections) {
    try { connection.close(); } catch (_) {}
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('exports the complete lifecycle API from osi-journal', () => {
  for (const name of ['saveDraft', 'finalize', 'finalizeBatch', 'void_']) {
    assert.equal(typeof journal[name], 'function', name);
  }
});

test('zone finalization succeeds with explicit no-data context records', async () => {
  assert.equal(typeof journal.buildContext, 'function');
  const result = await journal.finalize(db, catalog, validEntry(), principal());
  const entry = await db.get(
    'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
    [result.entry_uuid]
  );
  const context = JSON.parse(entry.context_json);

  assert.equal(context.schema_version, 1);
  assert.equal(context.generator_name, 'osi-journal-context');
  assert.equal(context.generator_version, 1);
  assert.match(context.generator_contract_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(context.channels), CONTEXT_CHANNELS);
  for (const channel of CONTEXT_CHANNELS) {
    assert.deepEqual(Object.keys(context.channels[channel]), CONTEXT_RECORD_FIELDS, channel);
    assert.equal(context.channels[channel].value, null, channel);
    assert.equal(context.channels[channel].reason, 'no_data', channel);
  }
  const outbox = await db.get(
    'SELECT payload_json FROM sync_outbox WHERE aggregate_key=?',
    [result.entry_uuid]
  );
  const aggregate = JSON.parse(outbox.payload_json);
  assert.equal(aggregate.context_json, entry.context_json);
  assert.deepEqual(JSON.parse(aggregate.context_json), context);
  assert.equal(await count('sync_outbox'), 1);
});

test('a 15-day-old SWT point is stale at a 24-hour freshness threshold', async () => {
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
    [OWNED_DEVICE_EUI, '2026-06-27T07:30:00.000Z', 42]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const entry = await db.get(
    'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  const swt = JSON.parse(entry.context_json).channels.swt_1;

  assert.equal(swt.value, null);
  assert.equal(swt.reason, 'stale');
  assert.equal(swt.observed_at, '2026-06-27T07:30:00.000Z');
  assert.equal(swt.source_device, OWNED_DEVICE_EUI);
  assert.equal(swt.freshness_threshold_s, 24 * 60 * 60);
  assert.equal(swt.age_s, 15 * 24 * 60 * 60);
});

test('SWT point provenance identifies the canonical or legacy source column actually read', async () => {
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1,swt_wm1,swt_2,swt_wm2) ' +
    'VALUES (?,?,?,?,?,?)',
    [OWNED_DEVICE_EUI, '2026-07-12T07:20:00.000Z', 18, 99, null, 27]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const channels = (await storedContext()).channels;

  assert.deepEqual(
    [channels.swt_1.value, channels.swt_1.source_key],
    [18, 'swt_1']
  );
  assert.deepEqual(
    [channels.swt_2.value, channels.swt_2.source_key],
    [27, 'swt_wm2']
  );
});

test('SWT point provenance falls back from a nonnumeric canonical value', async () => {
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1,swt_wm1) VALUES (?,?,?,?)',
    [OWNED_DEVICE_EUI, '2026-07-12T07:20:00.000Z', '', 31]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const swt = (await storedContext()).channels.swt_1;

  assert.equal(swt.value, 31);
  assert.equal(swt.source_key, 'swt_wm1');
});

test('a rain window without valid samples is null rather than zero', async () => {
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,ambient_temperature) VALUES (?,?,?)',
    [OWNED_DEVICE_EUI, '2026-07-12T07:15:00.000Z', 18]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const entry = await db.get(
    'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  const rain = JSON.parse(entry.context_json).channels.rain_24h;

  assert.equal(rain.value, null);
  assert.equal(rain.reason, 'no_data');
  assert.notEqual(rain.value, 0);
  assert.equal(rain.sample_count, 0);
});

test('a backdated occurrence selects only historical telemetry at or before its instant', async () => {
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
    [OWNED_DEVICE_EUI, '2026-07-12T07:00:00.000Z', 35]
  );
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
    [OWNED_DEVICE_EUI, '2026-07-12T08:00:00.000Z', 99]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const entry = await db.get(
    'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  const swt = JSON.parse(entry.context_json).channels.swt_1;

  assert.equal(swt.value, 35);
  assert.equal(swt.reason, null);
  assert.equal(swt.observed_at, '2026-07-12T07:00:00.000Z');
  assert.equal(swt.age_s, 30 * 60);
});

test('soft-deleted devices cannot contribute historical context', async () => {
  await db.run(
    'UPDATE devices SET deleted_at=? WHERE deveui=?',
    ['2026-07-12T07:15:00.000Z', SECOND_RAIN_DEVICE_EUI]
  );
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
    [SECOND_RAIN_DEVICE_EUI, '2026-07-12T07:20:00.000Z', 99]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const swt = (await storedContext()).channels.swt_1;

  assert.equal(swt.value, null);
  assert.equal(swt.source_device, null);
  assert.equal(swt.reason, 'no_data');
});

test('a foreign-owned shared-weather mapping cannot contribute context', async () => {
  await db.run(
    'INSERT INTO weather_station_zones(deveui,zone_id,created_at) VALUES (?,?,?)',
    [FOREIGN_DEVICE_EUI, 1, '2026-07-12T00:00:00.000Z']
  );
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1,ambient_temperature) VALUES (?,?,?,?)',
    [FOREIGN_DEVICE_EUI, '2026-07-12T07:20:00.000Z', 99, 31]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const channels = (await storedContext()).channels;

  for (const channel of ['swt_1', 'temperature']) {
    assert.equal(channels[channel].value, null, channel);
    assert.equal(channels[channel].source_device, null, channel);
    assert.equal(channels[channel].reason, 'no_data', channel);
  }
});

test('weather_station_zones supplies shared temperature, humidity, and wind context', async () => {
  await db.run(
    'INSERT INTO weather_station_zones(deveui,zone_id,created_at) VALUES (?,?,?)',
    [WEATHER_DEVICE_EUI, 1, '2026-07-12T00:00:00.000Z']
  );
  await db.run(
    'INSERT INTO device_data(' +
      'deveui,recorded_at,ambient_temperature,relative_humidity,' +
      'wind_speed_mps,wind_direction_deg,wind_gust_mps' +
    ') VALUES (?,?,?,?,?,?,?)',
    [WEATHER_DEVICE_EUI, '2026-07-12T07:20:00.000Z', 18.5, 67, 4.5, 225, 7.25]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const channels = (await storedContext()).channels;

  assert.deepEqual(
    [channels.temperature.value, channels.temperature.source_device, channels.temperature.source_key],
    [18.5, WEATHER_DEVICE_EUI, 'ambient_temperature']
  );
  assert.deepEqual(
    [channels.relative_humidity.value, channels.relative_humidity.source_device],
    [67, WEATHER_DEVICE_EUI]
  );
  assert.deepEqual(
    [channels.wind_speed.value, channels.wind_direction.value, channels.wind_gust.value],
    [4.5, 225, 7.25]
  );
});

test('rain context selects one deterministic source and excludes invalid and duplicate deltas', async () => {
  await db.run(
    'INSERT INTO weather_station_zones(deveui,zone_id,created_at) VALUES (?,?,?)',
    [WEATHER_DEVICE_EUI, 1, '2026-07-12T00:00:00.000Z']
  );
  for (const sample of [
    [WEATHER_DEVICE_EUI, '2026-07-12T06:00:00.000Z', 2, 'ok'],
    [WEATHER_DEVICE_EUI, '2026-07-12T07:00:00.000Z', 3, 'ok'],
    [WEATHER_DEVICE_EUI, '2026-07-12T07:00:00.000Z', 3, 'ok'],
    [WEATHER_DEVICE_EUI, '2026-07-12T07:05:00.000Z', 100, 'duplicate_or_out_of_order'],
    [WEATHER_DEVICE_EUI, '2026-07-12T07:10:00.000Z', 200, 'invalid_rain_delta'],
    [RAIN_DEVICE_EUI, '2026-07-12T07:15:00.000Z', 7, 'ok'],
    [RAIN_DEVICE_EUI, '2026-07-12T07:15:00.000Z', 7, 'ok'],
    [RAIN_DEVICE_EUI, '2026-07-12T07:20:00.000Z', 100, 'duplicate_or_out_of_order'],
    [RAIN_DEVICE_EUI, '2026-07-12T07:25:00.000Z', 200, 'invalid_rain_delta'],
    [SECOND_RAIN_DEVICE_EUI, '2026-07-12T07:15:00.000Z', 9, 'ok'],
  ]) {
    await db.run(
      'INSERT INTO device_data(deveui,recorded_at,rain_mm_delta,rain_delta_status) ' +
      'VALUES (?,?,?,?)',
      sample
    );
  }

  await journal.finalize(db, catalog, validEntry(), principal());
  const rain = (await storedContext()).channels.rain_24h;

  assert.equal(rain.value, 7);
  assert.equal(rain.unit, 'mm');
  assert.equal(rain.source_device, RAIN_DEVICE_EUI);
  assert.equal(rain.source_key, 'rain_mm_delta');
  assert.equal(rain.observed_at, '2026-07-12T07:15:00.000Z');
  assert.equal(rain.statistic, 'sum');
  assert.equal(rain.window_start, '2026-07-11T07:30:00.000Z');
  assert.equal(rain.window_end, '2026-07-12T07:30:00.000Z');
  assert.equal(rain.sample_count, 1);
  assert.equal(rain.reason, null);
});

test('a selected subject rain device takes precedence over other direct gauges', async () => {
  await db.run(
    'UPDATE devices SET rain_gauge_enabled=1 WHERE deveui=?',
    [OWNED_DEVICE_EUI]
  );
  for (const sample of [
    [OWNED_DEVICE_EUI, '2026-07-12T07:10:00.000Z', 4, 'ok'],
    [RAIN_DEVICE_EUI, '2026-07-12T07:15:00.000Z', 7, 'ok'],
  ]) {
    await db.run(
      'INSERT INTO device_data(deveui,recorded_at,rain_mm_delta,rain_delta_status) ' +
      'VALUES (?,?,?,?)',
      sample
    );
  }

  await journal.finalize(db, catalog, validEntry({
    device_eui: OWNED_DEVICE_EUI,
  }), principal());
  const rain = (await storedContext()).channels.rain_24h;

  assert.equal(rain.value, 4);
  assert.equal(rain.source_device, OWNED_DEVICE_EUI);
  assert.equal(rain.sample_count, 1);
});

test('a valid zero rain delta remains an observed dry interval', async () => {
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,rain_mm_delta,rain_delta_status) ' +
    'VALUES (?,?,?,?)',
    [RAIN_DEVICE_EUI, '2026-07-12T07:15:00.000Z', 0, 'ok']
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const rain = (await storedContext()).channels.rain_24h;

  assert.equal(rain.value, 0);
  assert.equal(rain.sample_count, 1);
  assert.equal(rain.reason, null);
});

test('rain provenance becomes unavailable when a window exceeds 4096 raw rows', async () => {
  await db.run(
    'WITH RECURSIVE samples(n) AS (' +
      'VALUES(0) UNION ALL SELECT n+1 FROM samples WHERE n<?' +
    ') ' +
    'INSERT INTO device_data(deveui,recorded_at,rain_mm_delta,rain_delta_status) ' +
    "SELECT ?,strftime('%Y-%m-%dT%H:%M:%fZ','2026-07-12T06:00:00Z','+' || n || ' seconds')," +
      "1,'ok' FROM samples",
    [CONTEXT_RAW_ROW_LIMIT, RAIN_DEVICE_EUI]
  );

  const observed = observeTransactionContextReads();
  await journal.finalize(observed.database, catalog, validEntry(), principal());
  const rain = (await storedContext()).channels.rain_24h;

  assert.equal(rain.value, null);
  assert.equal(rain.status, 'unavailable');
  assert.equal(rain.reason, 'provenance_unavailable');
  assert.equal(rain.sample_count, 0);
  const rainRead = observed.reads.find((read) => read.sql.includes('rain_delta_status'));
  assert.ok(rainRead);
  assert.doesNotMatch(rainRead.sql, /ROW_NUMBER| OVER /);
  assert.match(rainRead.sql, /ORDER BY deveui,recorded_at,id LIMIT 4097/);
});

test('valve context ignores current_state and uses the historical actuation expectation', async () => {
  await db.run(
    'UPDATE devices SET current_state=? WHERE deveui=?',
    ['OPEN', VALVE_DEVICE_EUI]
  );
  await db.run(
    'INSERT INTO zone_valve_assignments(zone_id,deveui,valve_channel,created_at) VALUES (?,?,?,?)',
    [1, VALVE_DEVICE_EUI, 2, '2026-07-12T00:00:00.000Z']
  );
  await db.run(
    'INSERT INTO valve_actuation_expectations(' +
      'expectation_id,device_eui,zone_id,commanded_at,commanded_duration_seconds,' +
      'expected_close_at,volume_source,observed_open_at,observed_close_at,' +
      'reconciliation_state,created_at,valve_channel' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      'expectation-context-1',
      VALVE_DEVICE_EUI,
      null,
      '2026-07-12T06:00:00.000Z',
      600,
      '2026-07-12T06:10:00.000Z',
      'not_available',
      '2026-07-12T06:01:00.000Z',
      '2026-07-12T06:08:00.000Z',
      'OBSERVED_COMPLETE',
      '2026-07-12T06:00:00.000Z',
      2,
    ]
  );

  const observed = observeTransactionContextReads();
  await journal.finalize(observed.database, catalog, validEntry(), principal());
  const valve = (await storedContext()).channels.valve_state;

  assert.equal(valve.value, 'CLOSED');
  assert.equal(valve.source_device, VALVE_DEVICE_EUI);
  assert.equal(valve.source_key, 'valve_actuation_expectations:2');
  assert.equal(valve.observed_at, '2026-07-12T06:08:00.000Z');
  assert.equal(valve.quality, 'observed');
  assert.equal(valve.reason, null);
  const expectationRead = observed.reads.find((read) => {
    return read.sql.includes('ORDER BY vae.commanded_at DESC,vae.expectation_id DESC LIMIT 1');
  });
  assert.ok(expectationRead);
  assert.match(
    expectationRead.sql,
    /ORDER BY vae\.commanded_at DESC,vae\.expectation_id DESC LIMIT 1$/
  );
});

test('an unobserved valve command is labelled expected rather than observed', async () => {
  await db.run(
    'INSERT INTO zone_valve_assignments(zone_id,deveui,valve_channel,created_at) VALUES (?,?,?,?)',
    [1, VALVE_DEVICE_EUI, 2, '2026-07-12T00:00:00.000Z']
  );
  await db.run(
    'INSERT INTO valve_actuation_expectations(' +
      'expectation_id,device_eui,zone_id,commanded_at,commanded_duration_seconds,' +
      'expected_close_at,volume_source,reconciliation_state,created_at,valve_channel' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      'expectation-context-expected',
      VALVE_DEVICE_EUI,
      null,
      '2026-07-12T07:00:00.000Z',
      3600,
      '2026-07-12T08:00:00.000Z',
      'not_available',
      'PENDING_OBSERVATION',
      '2026-07-12T07:00:00.000Z',
      2,
    ]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const valve = (await storedContext()).channels.valve_state;

  assert.equal(valve.value, 'OPEN');
  assert.equal(valve.quality, 'expected');
  assert.equal(valve.observed_at, '2026-07-12T07:00:00.000Z');
});

test('an observed valve is open only inside its observed open-close interval', async () => {
  await db.run(
    'INSERT INTO zone_valve_assignments(zone_id,deveui,valve_channel,created_at) VALUES (?,?,?,?)',
    [1, VALVE_DEVICE_EUI, 2, '2026-07-12T00:00:00.000Z']
  );
  await db.run(
    'INSERT INTO valve_actuation_expectations(' +
      'expectation_id,device_eui,zone_id,commanded_at,commanded_duration_seconds,' +
      'expected_close_at,volume_source,observed_open_at,observed_close_at,' +
      'reconciliation_state,created_at,valve_channel' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      'expectation-context-observed-open',
      VALVE_DEVICE_EUI,
      null,
      '2026-07-12T07:00:00.000Z',
      3600,
      '2026-07-12T08:00:00.000Z',
      'not_available',
      '2026-07-12T07:10:00.000Z',
      '2026-07-12T07:40:00.000Z',
      'OBSERVED_COMPLETE',
      '2026-07-12T07:00:00.000Z',
      2,
    ]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const valve = (await storedContext()).channels.valve_state;

  assert.equal(valve.value, 'OPEN');
  assert.equal(valve.quality, 'observed');
  assert.equal(valve.observed_at, '2026-07-12T07:10:00.000Z');
});

test('a cancelled expectation without observations has unknown historical state', async () => {
  await db.run(
    'INSERT INTO zone_valve_assignments(zone_id,deveui,valve_channel,created_at) VALUES (?,?,?,?)',
    [1, VALVE_DEVICE_EUI, 2, '2026-07-12T00:00:00.000Z']
  );
  await db.run(
    'INSERT INTO valve_actuation_expectations(' +
      'expectation_id,device_eui,zone_id,commanded_at,commanded_duration_seconds,' +
      'expected_close_at,volume_source,reconciliation_state,created_at,valve_channel' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      'expectation-context-cancelled',
      VALVE_DEVICE_EUI,
      null,
      '2026-07-12T07:00:00.000Z',
      3600,
      '2026-07-12T08:00:00.000Z',
      'not_available',
      'CANCELLED',
      '2026-07-12T07:00:00.000Z',
      2,
    ]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const valve = (await storedContext()).channels.valve_state;

  assert.equal(valve.value, null);
  assert.equal(valve.quality, 'unknown');
  assert.equal(valve.reason, 'unknown');
});

test('expected_close_at alone never proves that a valve closed', async () => {
  await db.run(
    'INSERT INTO zone_valve_assignments(zone_id,deveui,valve_channel,created_at) VALUES (?,?,?,?)',
    [1, VALVE_DEVICE_EUI, 2, '2026-07-12T00:00:00.000Z']
  );
  await db.run(
    'INSERT INTO valve_actuation_expectations(' +
      'expectation_id,device_eui,zone_id,commanded_at,commanded_duration_seconds,' +
      'expected_close_at,volume_source,reconciliation_state,created_at,valve_channel' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      'expectation-context-past-expected-close',
      VALVE_DEVICE_EUI,
      null,
      '2026-07-12T07:00:00.000Z',
      600,
      '2026-07-12T07:10:00.000Z',
      'not_available',
      'PENDING_OBSERVATION',
      '2026-07-12T07:00:00.000Z',
      2,
    ]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const valve = (await storedContext()).channels.valve_state;

  assert.equal(valve.value, null);
  assert.equal(valve.quality, 'unknown');
  assert.equal(valve.reason, 'unknown');
});

test('a channel-less expectation with multiple zone assignments is ambiguous', async () => {
  for (const channel of [1, 2]) {
    await db.run(
      'INSERT INTO zone_valve_assignments(zone_id,deveui,valve_channel,created_at) VALUES (?,?,?,?)',
      [1, VALVE_DEVICE_EUI, channel, '2026-07-12T00:00:00.000Z']
    );
  }
  await db.run(
    'INSERT INTO valve_actuation_expectations(' +
      'expectation_id,device_eui,zone_id,commanded_at,commanded_duration_seconds,' +
      'expected_close_at,volume_source,reconciliation_state,created_at,valve_channel' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?)',
    [
      'expectation-context-ambiguous-channel',
      VALVE_DEVICE_EUI,
      null,
      '2026-07-12T07:00:00.000Z',
      3600,
      '2026-07-12T08:00:00.000Z',
      'not_available',
      'PENDING_OBSERVATION',
      '2026-07-12T07:00:00.000Z',
      null,
    ]
  );

  await journal.finalize(db, catalog, validEntry(), principal());
  const valve = (await storedContext()).channels.valve_state;

  assert.equal(valve.value, null);
  assert.equal(valve.source_key, 'valve_actuation_expectations');
  assert.equal(valve.reason, 'unknown');
});

test('multi-bucket duration uses a full-window mean and circular wind direction', async () => {
  for (const sample of [
    [OWNED_DEVICE_EUI, '2026-07-02T07:30:00.000Z', 10, 350],
    [OWNED_DEVICE_EUI, '2026-07-10T07:30:00.000Z', 30, 10],
  ]) {
    await db.run(
      'INSERT INTO device_data(deveui,recorded_at,swt_1,wind_direction_deg) ' +
      'VALUES (?,?,?,?)',
      sample
    );
  }

  await journal.finalize(db, catalog, validEntry({
    occurred_start_local: '2026-07-01T09:30',
    occurred_end_local: '2026-07-12T09:30',
  }), principal());
  const operation = (await storedContext()).duration.operation_window;

  assert.equal(operation.swt_1.value, 20);
  assert.equal(operation.swt_1.statistic, 'mean');
  assert.equal(operation.swt_1.sample_count, 2);
  assert.equal(operation.wind_direction.value, 0);
  assert.equal(operation.wind_direction.statistic, 'circular_mean');
});

test('duration SWT provenance aggregates the legacy column selected by the snapshot', async () => {
  for (const sample of [
    ['2026-07-12T07:00:00.000Z', 10],
    ['2026-07-12T07:20:00.000Z', 30],
  ]) {
    await db.run(
      'INSERT INTO device_data(deveui,recorded_at,swt_wm1) VALUES (?,?,?)',
      [OWNED_DEVICE_EUI].concat(sample)
    );
  }

  await journal.finalize(db, catalog, validEntry({
    occurred_start_local: '2026-07-12T09:00',
    occurred_end_local: '2026-07-12T09:30',
  }), principal());
  const swt = (await storedContext()).duration.operation_window.swt_1;

  assert.equal(swt.value, 20);
  assert.equal(swt.source_key, 'swt_wm1');
  assert.equal(swt.sample_count, 2);
});

test('an operation window over 4096 raw rows exposes no partial point provenance', async () => {
  await db.run(
    'WITH RECURSIVE samples(n) AS (' +
      'VALUES(0) UNION ALL SELECT n+1 FROM samples WHERE n<?' +
    ') ' +
    'INSERT INTO device_data(deveui,recorded_at,swt_1) ' +
    "SELECT ?,strftime('%Y-%m-%dT%H:%M:%fZ','2026-07-12T06:00:00Z','+' || n || ' seconds')," +
      'n+1 FROM samples',
    [CONTEXT_RAW_ROW_LIMIT, OWNED_DEVICE_EUI]
  );
  const observed = observeTransactionContextReads();

  await journal.finalize(observed.database, catalog, validEntry({
    occurred_start_local: '2026-07-12T08:00',
    occurred_end_local: '2026-07-12T09:30',
  }), principal());
  const operation = (await storedContext()).duration.operation_window;

  for (const channel of CONTEXT_CHANNELS.filter((key) => {
    return key !== 'rain_24h' && key !== 'valve_state';
  })) {
    assert.equal(operation[channel].value, null, channel);
    assert.equal(operation[channel].status, 'unavailable', channel);
    assert.equal(operation[channel].reason, 'provenance_unavailable', channel);
    assert.equal(operation[channel].sample_count, 0, channel);
  }
  const operationRead = observed.reads.find((read) => {
    return read.sql.includes('SELECT id,deveui,recorded_at,swt_1') &&
      read.sql.includes('recorded_at>=?');
  });
  assert.ok(operationRead);
  assert.match(operationRead.sql, /ORDER BY deveui,recorded_at,id LIMIT 4097/);
});

test('a linked duration context uses at most nine bounded database reads', async () => {
  for (const sample of [
    ['2026-07-12T07:00:00.000Z', 10, 350],
    ['2026-07-12T07:20:00.000Z', 30, 10],
  ]) {
    await db.run(
      'INSERT INTO device_data(deveui,recorded_at,swt_1,wind_direction_deg) ' +
      'VALUES (?,?,?,?)',
      [OWNED_DEVICE_EUI].concat(sample)
    );
  }
  const observed = observeTransactionContextReads();

  await journal.finalize(observed.database, catalog, validEntry({
    occurred_start_local: '2026-07-12T09:00',
    occurred_end_local: '2026-07-12T09:30',
  }), principal());

  assert.ok(observed.reads.length <= 9, 'context reads: ' + observed.reads.length);
  assert.equal(
    observed.reads.filter((read) => read.sql.includes('FROM device_data')).length,
    6
  );
});

test('a 100-plot same-context batch reuses nine reads and stamps each plot UUID', async () => {
  const plots = Array.from({ length: 100 }, (_, index) => plotUuid(1000 + index));
  for (let index = 0; index < plots.length; index += 1) {
    await db.run(
      'INSERT INTO journal_plots(' +
        'plot_uuid,plot_code,name,zone_uuid,station_code,gateway_device_eui,owner_user_uuid' +
      ') VALUES (?,?,?,?,?,?,?)',
      [plots[index], 'CACHE-' + index, 'Cache plot ' + index, ZONE_UUID, 'CACHE', GATEWAY_EUI, USER_UUID]
    );
  }
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
    [OWNED_DEVICE_EUI, '2026-07-12T07:15:00.000Z', 25]
  );
  const observed = observeTransactionContextReads();

  await journal.finalizeBatch(observed.database, catalog, validEntry({
    entry_uuid: undefined,
    plot_uuid: undefined,
    device_eui: OWNED_DEVICE_EUI,
    occurred_start_local: '2026-07-12T09:00',
    occurred_end_local: '2026-07-12T09:30',
  }), plots, principal());

  assert.ok(observed.reads.length <= 9, 'context reads: ' + observed.reads.length);
  const rows = await db.all(
    'SELECT je.plot_uuid,je.context_json,so.payload_json ' +
    'FROM journal_entries AS je ' +
    'JOIN sync_outbox AS so ON so.aggregate_key=je.entry_uuid ' +
    'ORDER BY je.plot_uuid'
  );
  assert.equal(rows.length, 100);
  for (const row of rows) {
    const context = JSON.parse(row.context_json);
    const aggregate = JSON.parse(row.payload_json);
    assert.equal(context.plot_uuid, row.plot_uuid);
    assert.equal(context.subject_device, OWNED_DEVICE_EUI);
    assert.equal(aggregate.context_json, row.context_json);
  }
});

test('a 100-zone duration batch keeps context reads bounded per distinct zone', async () => {
  const plots = [];
  for (let index = 0; index < 100; index += 1) {
    const zoneId = 2000 + index;
    const zoneUuid = fixtureZoneUuid(zoneId);
    const plot = plotUuid(3000 + index);
    const deviceEui = fixtureDeviceEui(index);
    plots.push(plot);
    await db.run(
      'INSERT INTO irrigation_zones(' +
        'id,name,user_id,timezone,zone_uuid,gateway_device_eui' +
      ') VALUES (?,?,?,?,?,?)',
      [zoneId, 'Fixture zone ' + index, 1, 'Europe/Zurich', zoneUuid, GATEWAY_EUI]
    );
    await db.run(
      'INSERT INTO journal_plots(' +
        'plot_uuid,plot_code,name,zone_uuid,station_code,gateway_device_eui,owner_user_uuid' +
      ') VALUES (?,?,?,?,?,?,?)',
      [plot, 'ZONE-' + index, 'Zone plot ' + index, zoneUuid, 'ZONE', GATEWAY_EUI, USER_UUID]
    );
    await db.run(
      'INSERT INTO devices(' +
        'deveui,name,type_id,user_id,created_at,updated_at,' +
        'irrigation_zone_id,gateway_device_eui' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      [
        deviceEui,
        'Zone device ' + index,
        'DRAGINO_LSN50',
        1,
        '2026-07-12T00:00:00.000Z',
        '2026-07-12T00:00:00.000Z',
        zoneId,
        GATEWAY_EUI,
      ]
    );
    await db.run(
      'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
      [deviceEui, '2026-07-12T07:15:00.000Z', index + 1]
    );
  }
  const observed = observeTransactionContextReads();

  await journal.finalizeBatch(observed.database, catalog, validEntry({
    entry_uuid: undefined,
    plot_uuid: undefined,
    occurred_start_local: '2026-07-12T09:00',
    occurred_end_local: '2026-07-12T09:30',
    season_crop: 'barley',
    season_variety: 'Fixture',
  }), plots, principal());

  assert.equal(observed.reads.length, 600);
  assert.ok(observed.reads.length <= 900);
  const rows = await db.all(
    'SELECT plot_uuid,zone_uuid,context_json FROM journal_entries ORDER BY plot_uuid'
  );
  assert.equal(rows.length, 100);
  for (const row of rows) {
    const context = JSON.parse(row.context_json);
    assert.equal(context.plot_uuid, row.plot_uuid);
    assert.equal(context.zone_uuid, row.zone_uuid);
  }
});

test('same-determinant correction preserves the frozen context byte for byte', async () => {
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
    [OWNED_DEVICE_EUI, '2026-07-12T07:00:00.000Z', 20]
  );
  await journal.finalize(db, catalog, validEntry(), principal());
  const before = await db.get(
    'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  await db.run(
    'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
    [OWNED_DEVICE_EUI, '2026-07-12T07:20:00.000Z', 40]
  );

  await journal.finalize(db, catalog, validEntry({
    base_sync_version: 1,
    note: 'Metadata-only correction',
  }), principal());
  const after = await db.get(
    'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );

  assert.equal(after.context_json, before.context_json);
  assert.equal(JSON.parse(after.context_json).channels.swt_1.value, 20);
});

for (const scenario of [
  {
    name: 'start',
    telemetryAt: '2026-07-12T08:00:00.000Z',
    overrides: { occurred_start_local: '2026-07-12T10:30' },
    assertChanged(context) {
      assert.equal(context.occurred_start, '2026-07-12T08:30:00.000Z');
      assert.equal(context.channels.swt_1.value, 40);
    },
  },
  {
    name: 'end',
    telemetryAt: '2026-07-12T07:40:00.000Z',
    overrides: { occurred_end_local: '2026-07-12T09:45' },
    assertChanged(context) {
      assert.equal(context.occurred_end, '2026-07-12T07:45:00.000Z');
      assert.equal(context.duration.end_channels.swt_1.value, 40);
      assert.equal(context.duration.operation_window.swt_1.value, 40);
      assert.equal(context.duration.operation_window.swt_1.statistic, 'mean');
    },
  },
  {
    name: 'plot',
    telemetryAt: '2026-07-12T07:20:00.000Z',
    overrides: { plot_uuid: plotUuid(22) },
    assertChanged(context) {
      assert.equal(context.plot_uuid, plotUuid(22));
      assert.equal(context.channels.swt_1.value, 40);
    },
  },
  {
    name: 'zone',
    telemetryAt: '2026-07-12T07:20:00.000Z',
    overrides: {
      plot_uuid: plotUuid(21),
      season_crop: 'maize',
      season_variety: 'Pioneer P9241',
    },
    assertChanged(context) {
      assert.equal(context.zone_uuid, NO_SEASON_ZONE_UUID);
      assert.equal(context.channels.swt_1.value, null);
      assert.equal(context.channels.swt_1.reason, 'no_data');
    },
  },
  {
    name: 'device',
    telemetryAt: '2026-07-12T07:20:00.000Z',
    overrides: { device_eui: OWNED_DEVICE_EUI },
    assertChanged(context) {
      assert.equal(context.subject_device, OWNED_DEVICE_EUI);
      assert.equal(context.channels.swt_1.value, 40);
    },
  },
]) {
  test('changing the context ' + scenario.name + ' determinant recomputes the snapshot', async () => {
    await db.run(
      'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
      [OWNED_DEVICE_EUI, '2026-07-12T07:00:00.000Z', 20]
    );
    await journal.finalize(db, catalog, validEntry(), principal());
    const before = await db.get(
      'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
      [ENTRY_UUID]
    );
    await db.run(
      'INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES (?,?,?)',
      [OWNED_DEVICE_EUI, scenario.telemetryAt, 40]
    );

    await journal.finalize(db, catalog, validEntry(Object.assign({
      base_sync_version: 1,
      note: 'Changed ' + scenario.name + ' determinant',
    }, scenario.overrides)), principal());
    const after = await db.get(
      'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
      [ENTRY_UUID]
    );
    const context = JSON.parse(after.context_json);

    assert.notEqual(after.context_json, before.context_json);
    scenario.assertChanged(context);
    assert.ok(Buffer.byteLength(after.context_json, 'utf8') <= 64 * 1024);
    const outbox = await db.get(
      'SELECT payload_json FROM sync_outbox WHERE aggregate_key=? ORDER BY sync_version DESC LIMIT 1',
      [ENTRY_UUID]
    );
    assert.ok(Buffer.byteLength(outbox.payload_json, 'utf8') <= 256 * 1024);
  });
}

test('a context query failure rolls back entry, values, and outbox', async () => {
  const injected = new Error('injected context query failure');
  const failingDb = {
    transaction(executor) {
      return db.transaction((tx) => executor(Object.assign({}, tx, {
        all(sql, params) {
          if (String(sql).includes('device_data')) throw injected;
          return tx.all(sql, params);
        },
      })));
    },
  };

  await assert.rejects(
    journal.finalize(failingDb, catalog, validEntry(), principal()),
    (error) => error === injected
  );
  await assertNoJournalWrites();
});

test('an oversized generated context fails inside the transaction and rolls back', async () => {
  const contextPath = path.join(profileRoot, 'osi-journal/context.js');
  const lifecyclePath = path.join(profileRoot, 'osi-journal/lifecycle.js');
  const journalPath = path.join(profileRoot, 'osi-journal/index.js');
  const contextModule = require(contextPath);
  const originalBuildContext = contextModule.buildContext;
  let transactionCalls = 0;
  const observedDb = {
    transaction(executor) {
      transactionCalls += 1;
      return db.transaction(executor);
    },
  };

  contextModule.buildContext = async function oversizedContext() {
    return { schema_version: 1, padding: 'x'.repeat(64 * 1024) };
  };
  delete require.cache[require.resolve(lifecyclePath)];
  delete require.cache[require.resolve(journalPath)];
  try {
    const reloadedJournal = require(journalPath);
    await rejectCode(
      reloadedJournal.finalize(observedDb, catalog, validEntry(), principal()),
      'limit_exceeded'
    );
  } finally {
    contextModule.buildContext = originalBuildContext;
    delete require.cache[require.resolve(lifecyclePath)];
    delete require.cache[require.resolve(journalPath)];
  }

  assert.equal(transactionCalls, 1);
  await assertNoJournalWrites();
});

test('saveDraft keeps an incomplete entry local at version zero without an outbox row', async () => {
  const result = await journal.saveDraft(db, catalog, validEntry({
    activity_code: 'fertilization',
    template_code: 'full_record',
    values: [],
  }), principal());

  assert.deepEqual(result, { entry_uuid: ENTRY_UUID, sync_version: 0 });
  const entry = await db.get(
    'SELECT status,sync_version,context_json FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.status, 'draft');
  assert.equal(entry.sync_version, 0);
  assert.equal(entry.context_json, null);
  assert.equal(await count('sync_outbox'), 0);
});

test('finalizeBatch fans five plots into independent version-one aggregates sharing a batch', async () => {
  const plots = PLOT_NUMBERS.map(plotUuid);
  const input = validEntry({
    entry_uuid: undefined,
    plot_uuid: undefined,
    season_crop: 'barley',
    season_variety: 'Golden',
  });
  const result = await journal.finalizeBatch(db, catalog, input, plots, principal());

  assert.match(result.batch_uuid, UUID_PATTERN);
  assert.equal(result.entries.length, plots.length);
  assert.deepEqual(result.entries.map((entry) => entry.plot_uuid), plots);
  assert.equal(new Set(result.entries.map((entry) => entry.entry_uuid)).size, plots.length);
  for (const entry of result.entries) {
    assert.match(entry.entry_uuid, UUID_PATTERN);
    assert.match(entry.outbox_event_uuid, UUID_PATTERN);
    assert.equal(entry.sync_version, 1);
  }
  const entries = await db.all(
    'SELECT entry_uuid,plot_uuid,batch_uuid,sync_version,status,context_json ' +
    'FROM journal_entries ORDER BY plot_uuid'
  );
  assert.equal(entries.length, 5);
  assert.equal(new Set(entries.map((entry) => entry.batch_uuid)).size, 1);
  assert.equal(entries[0].batch_uuid, result.batch_uuid);
  assert.ok(entries.every((entry) => entry.sync_version === 1 && entry.status === 'final'));
  assert.notEqual(entries.find((entry) => entry.plot_uuid === plotUuid(2)).context_json, null);
  assert.ok(entries
    .filter((entry) => entry.plot_uuid !== plotUuid(2))
    .every((entry) => entry.context_json === null));
  assert.equal(await count('sync_outbox'), 5);
});

test('finalizeBatch rolls back every sibling when entry four fails', async () => {
  const plots = PLOT_NUMBERS.map(plotUuid);
  const injected = new Error('injected entry-four failure');
  const batchPrincipal = principal({
    lifecycle_hooks: {
      afterValues(details) {
        if (details.entry_index === 3) throw injected;
      },
    },
  });

  await assert.rejects(
    journal.finalizeBatch(
      db,
      catalog,
      validEntry({
        entry_uuid: undefined,
        plot_uuid: undefined,
        season_crop: 'barley',
        season_variety: 'Golden',
      }),
      plots,
      batchPrincipal
    ),
    injected
  );
  assert.equal(await count('journal_entries'), 0);
  assert.equal(await count('journal_entry_values'), 0);
  assert.equal(await count('sync_outbox'), 0);
});

test('finalizeBatch rejects 101 plots without writing anything', async () => {
  await rejectCode(
    journal.finalizeBatch(
      db,
      catalog,
      validEntry({ entry_uuid: undefined, plot_uuid: undefined }),
      Array.from({ length: 101 }, () => plotUuid(2)),
      principal()
    ),
    'batch_too_large'
  );
  assert.equal(await count('journal_entries'), 0);
  assert.equal(await count('sync_outbox'), 0);
});

test('finalize atomically writes derived identity, ordered values, season, and exact aggregate outbox', async () => {
  const input = validEntry({
    owner_user_uuid: OTHER_UUID,
    user_id: 999,
    author_principal_uuid: OTHER_UUID,
    author_label: 'Untrusted request label',
    gateway_device_eui: 'FFFFFFFFFFFFFFFF',
    origin: 'cloud-ui',
    context_json: JSON.stringify({ supplied_by_request: true }),
    values: [
      {
        attribute_code: 'attr.operator',
        group_index: 1,
        value: 'Alice',
        value_status: 'observed',
      },
      {
        attribute_code: 'attr.irrigation_depth',
        group_index: 0,
        value: 12,
        unit_code: 'unit.mm_water',
        value_status: 'observed',
      },
    ],
  });
  const result = await journal.finalize(db, catalog, input, principal());

  assert.deepEqual(Object.keys(result).sort(), ['entry_uuid', 'outbox_event_uuid', 'sync_version']);
  assert.equal(result.entry_uuid, ENTRY_UUID);
  assert.equal(result.sync_version, 1);
  assert.match(result.outbox_event_uuid, UUID_PATTERN);

  const entry = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  assert.equal(entry.owner_user_uuid, USER_UUID);
  assert.equal(entry.user_id, 1);
  assert.equal(entry.author_principal_uuid, PRINCIPAL_UUID);
  assert.equal(entry.author_label, 'Journal tester');
  assert.equal(entry.gateway_device_eui, GATEWAY_EUI);
  assert.equal(entry.origin, 'edge-ui');
  assert.equal(entry.zone_id, 1);
  assert.equal(entry.zone_uuid, ZONE_UUID);
  assert.equal(entry.season_uuid, SEASON_UUID);
  assert.equal(entry.season_crop, 'barley');
  assert.equal(entry.season_variety, 'Golden');
  assert.notEqual(entry.context_json, null);
  const generatedContext = JSON.parse(entry.context_json);
  assert.equal(generatedContext.schema_version, 1);
  assert.equal(generatedContext.supplied_by_request, undefined);
  assert.equal(entry.occurred_start, '2026-07-12T07:30:00.000Z');
  assert.equal(entry.occurred_utc_offset_minutes, 120);
  assert.match(entry.recorded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const values = await db.all(
    'SELECT * FROM journal_entry_values WHERE entry_uuid=? ORDER BY group_index,attribute_code',
    [ENTRY_UUID]
  );
  assert.deepEqual(values.map((value) => [value.group_index, value.attribute_code]), [
    [0, 'attr.irrigation_depth'],
    [1, 'attr.operator'],
  ]);

  const outbox = await db.get('SELECT * FROM sync_outbox WHERE event_uuid=?', [result.outbox_event_uuid]);
  assert.equal(outbox.aggregate_type, 'JOURNAL_ENTRY');
  assert.equal(outbox.aggregate_key, ENTRY_UUID);
  assert.equal(outbox.op, 'JOURNAL_ENTRY_UPSERTED');
  assert.equal(outbox.sync_version, 1);
  assert.equal(outbox.gateway_device_eui, GATEWAY_EUI);
  const expectedAggregate = buildAggregate(Object.assign({ contract_version: 1 }, entry), values);
  assert.deepEqual(JSON.parse(outbox.payload_json), expectedAggregate);
});

test('stale correction rejects and writes nothing', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const beforeEntry = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  const beforeValues = await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]);
  const beforeOutbox = await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid');

  await rejectCode(
    journal.finalize(db, catalog, validEntry({ base_sync_version: 0, note: 'stale edit' }), principal()),
    'stale_version'
  );
  assert.deepEqual(await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]), beforeEntry);
  assert.deepEqual(await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]), beforeValues);
  assert.deepEqual(await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'), beforeOutbox);
});

test('correction increments the version and completely replaces the value set', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const result = await journal.finalize(db, catalog, validEntry({
    base_sync_version: 1,
    values: [{
      attribute_code: 'attr.operator',
      group_index: 0,
      value: 'Bob',
      value_status: 'observed',
    }],
    note: 'Corrected entry',
  }), principal());

  assert.equal(result.sync_version, 2);
  const entry = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  const values = await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]);
  assert.equal(entry.status, 'final');
  assert.equal(entry.sync_version, 2);
  assert.deepEqual(values.map((value) => value.attribute_code), ['attr.operator']);
  assert.equal(values[0].value_text, 'Bob');
  assert.equal(await count('sync_outbox'), 2);
  const outbox = await db.get('SELECT * FROM sync_outbox WHERE event_uuid=?', [result.outbox_event_uuid]);
  assert.deepEqual(
    JSON.parse(outbox.payload_json),
    buildAggregate(Object.assign({ contract_version: 1 }, entry), values)
  );
});

const actuationFinalizationScenarios = [
  {
    name: 'final create',
    expectedVersion: 1,
    async arrange() {},
    apply(expectationId) {
      return journal.finalize(db, catalog, actuationEntry(expectationId), principal());
    },
  },
  {
    name: 'draft promotion',
    expectedVersion: 1,
    async arrange() {
      await journal.saveDraft(db, catalog, validEntry({
        values: [{
          attribute_code: 'attr.operator',
          group_index: 0,
          value: 'Draft operator',
          value_status: 'observed',
        }],
      }), principal());
    },
    apply(expectationId) {
      return journal.finalize(db, catalog, actuationEntry(expectationId), principal());
    },
  },
  {
    name: 'correction',
    expectedVersion: 2,
    async arrange() {
      await journal.finalize(db, catalog, validEntry(), principal());
    },
    apply(expectationId) {
      return journal.finalize(db, catalog, actuationEntry(expectationId, {
        base_sync_version: 1,
      }), principal());
    },
  },
];

for (const scenario of actuationFinalizationScenarios) {
  test(scenario.name + ' accepts an owned same-zone actuation reference', async () => {
    await seedActuationExpectations();
    await scenario.arrange();

    const result = await scenario.apply(OWNED_EXPECTATION_ID);

    assert.equal(result.sync_version, scenario.expectedVersion);
    const stored = await db.get(
      'SELECT value_text FROM journal_entry_values ' +
        'WHERE entry_uuid=? AND attribute_code=?',
      [ENTRY_UUID, 'attr.actuation_expectation_id']
    );
    assert.equal(stored.value_text, OWNED_EXPECTATION_ID);
  });

  for (const invalidReference of [
    'expectation-missing',
    FOREIGN_ZONE_EXPECTATION_ID,
    FOREIGN_OWNER_EXPECTATION_ID,
  ]) {
    test(scenario.name + ' rejects and rolls back disallowed actuation reference ' +
        invalidReference, async () => {
      await seedActuationExpectations();
      await scenario.arrange();
      const before = await journalMutationState();

      await rejectInvalidReference(scenario.apply(invalidReference));

      assert.deepEqual(await journalMutationState(), before);
    });
  }
}

test('void preserves values and emits a complete JOURNAL_ENTRY_VOIDED aggregate', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const beforeEntry = await db.get(
    'SELECT context_json FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  const beforeValues = await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]);
  const result = await journal.void_(db, catalog, ENTRY_UUID, 1, 'Recorded twice', principal());

  assert.equal(result.sync_version, 2);
  assert.match(result.outbox_event_uuid, UUID_PATTERN);
  const entry = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  const afterValues = await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]);
  assert.equal(entry.status, 'voided');
  assert.equal(entry.voided_by_principal_uuid, PRINCIPAL_UUID);
  assert.equal(entry.void_reason, 'Recorded twice');
  assert.equal(entry.context_json, beforeEntry.context_json);
  assert.deepEqual(afterValues, beforeValues);
  const outbox = await db.get('SELECT * FROM sync_outbox WHERE event_uuid=?', [result.outbox_event_uuid]);
  assert.equal(outbox.op, 'JOURNAL_ENTRY_VOIDED');
  assert.deepEqual(
    JSON.parse(outbox.payload_json),
    buildAggregate(Object.assign({ contract_version: 1 }, entry), afterValues)
  );
});

test('failure after value writes but before the outbox insert rolls the entire finalize back', async () => {
  const injected = new Error('injected value-to-outbox crash');
  const crashPrincipal = principal({
    lifecycle_hooks: {
      afterValues() { throw injected; },
    },
  });

  await assert.rejects(journal.finalize(db, catalog, validEntry(), crashPrincipal), injected);
  assert.equal(await count('journal_entries'), 0);
  assert.equal(await count('journal_entry_values'), 0);
  assert.equal(await count('sync_outbox'), 0);
});

test('command-originated finalize records its terminal ledger and ACK in the same transaction', async () => {
  const commandPrincipal = principal({
    origin: 'cloud-ui',
    command_id: 'command-77',
    effect_key: 'journal_entry:' + ENTRY_UUID + ':0',
  });
  const result = await journal.finalize(db, catalog, validEntry(), commandPrincipal);

  const applied = await db.get('SELECT * FROM applied_commands WHERE command_id=?', ['command-77']);
  assert.equal(applied.device_eui, GATEWAY_EUI);
  assert.equal(applied.command_type, 'UPSERT_JOURNAL_ENTRY');
  assert.equal(applied.effect_key, 'journal_entry:' + ENTRY_UUID + ':0');
  assert.equal(applied.result, 'APPLIED');
  const ackRow = await db.get('SELECT * FROM command_ack_outbox WHERE command_id=?', ['command-77']);
  const ack = JSON.parse(ackRow.payload_json);
  assert.equal(ack.commandId, 'command-77');
  assert.equal(ack.status, 'ACKED');
  assert.equal(ack.result, 'APPLIED');
  assert.equal(ack.appliedSyncVersion, 1);
  assert.equal(ack.entryUuid, ENTRY_UUID);
  assert.equal(result.sync_version, 1);
});

test('command-originated create rejects a mismatched effect-key UUID and rolls back', async () => {
  await rejectCode(journal.finalize(db, catalog, validEntry(), principal({
    origin: 'cloud-ui',
    command_id: 'command-wrong-entry',
    effect_key: 'journal_entry:12345678-1234-4234-8234-123456789abc:0',
  })), 'invalid_effect_key');

  await assertNoJournalWrites();
  assert.equal(await count('applied_commands'), 0);
  assert.equal(await count('command_ack_outbox'), 0);
});

test('command-originated correction binds its effect-key base to applied version minus one', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const beforeEntry = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  const beforeValues = await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]);
  const beforeOutbox = await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid');

  await rejectCode(journal.finalize(db, catalog, validEntry({
    base_sync_version: 1,
    note: 'Must roll back',
  }), principal({
    origin: 'cloud-ui',
    command_id: 'command-wrong-base',
    effect_key: 'journal_entry:' + ENTRY_UUID + ':0',
  })), 'invalid_effect_key');

  assert.deepEqual(await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]), beforeEntry);
  assert.deepEqual(await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]), beforeValues);
  assert.deepEqual(await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'), beforeOutbox);
  assert.equal(await count('applied_commands'), 0);
  assert.equal(await count('command_ack_outbox'), 0);
});

test('command ledger and ACK roll back with the journal mutation on a late injected failure', async () => {
  const injected = new Error('injected after-command crash');
  const commandPrincipal = principal({
    origin: 'cloud-ui',
    command_id: 'command-rollback',
    effect_key: 'journal_entry:' + ENTRY_UUID + ':0',
    lifecycle_hooks: {
      afterCommand() { throw injected; },
    },
  });

  await assert.rejects(journal.finalize(db, catalog, validEntry(), commandPrincipal), injected);
  assert.equal(await count('journal_entries'), 0);
  assert.equal(await count('sync_outbox'), 0);
  assert.equal(await count('applied_commands'), 0);
  assert.equal(await count('command_ack_outbox'), 0);
});

test('rejects a nonexistent Europe/Zurich local time without partial writes', async () => {
  await rejectCode(journal.finalize(db, catalog, validEntry({
    occurred_start_local: '2026-03-29T02:30',
  }), principal()), 'nonexistent_local_time');

  assert.equal(await count('journal_entries'), 0);
  assert.equal(await count('journal_entry_values'), 0);
  assert.equal(await count('sync_outbox'), 0);
});

test('saveDraft updates an owned version-zero draft and fully replaces its values', async () => {
  await journal.saveDraft(db, catalog, validEntry(), principal());
  const before = await db.get(
    'SELECT id,entry_uuid,created_at,recorded_at,author_principal_uuid FROM journal_entries ' +
    'WHERE entry_uuid=?',
    [ENTRY_UUID]
  );

  const result = await journal.saveDraft(db, catalog, validEntry({
    note: 'Reworked while still a draft',
    values: [{
      attribute_code: 'attr.operator',
      group_index: 0,
      value: 'Alice',
      value_status: 'observed',
    }],
  }), principal());

  assert.deepEqual(result, { entry_uuid: ENTRY_UUID, sync_version: 0 });
  const after = await db.get(
    'SELECT id,entry_uuid,created_at,recorded_at,author_principal_uuid,status,sync_version,note,context_json ' +
    'FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.deepEqual(entryIdentity(after), entryIdentity(before));
  assert.equal(after.status, 'draft');
  assert.equal(after.sync_version, 0);
  assert.equal(after.note, 'Reworked while still a draft');
  const values = await db.all(
    'SELECT attribute_code,value_text FROM journal_entry_values WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.deepEqual(
    values.map((value) => [value.attribute_code, value.value_text]),
    [['attr.operator', 'Alice']]
  );
  assert.equal(await count('sync_outbox'), 0);
});

test('finalize promotes an owned draft in place to final version one', async () => {
  await journal.saveDraft(db, catalog, validEntry({
    values: [{
      attribute_code: 'attr.operator',
      group_index: 0,
      value: 'Draft operator',
      value_status: 'observed',
    }],
  }), principal());
  const draft = await db.get(
    'SELECT id,entry_uuid,created_at,recorded_at,author_principal_uuid FROM journal_entries ' +
    'WHERE entry_uuid=?',
    [ENTRY_UUID]
  );

  const result = await journal.finalize(db, catalog, validEntry({
    base_sync_version: 0,
    note: 'Finalized draft',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 18,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
  }), principal());

  assert.equal(result.entry_uuid, ENTRY_UUID);
  assert.equal(result.sync_version, 1);
  const finalized = await db.get(
    'SELECT id,entry_uuid,created_at,recorded_at,author_principal_uuid,status,sync_version,note,context_json ' +
    'FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.deepEqual(entryIdentity(finalized), entryIdentity(draft));
  assert.equal(finalized.status, 'final');
  assert.equal(finalized.sync_version, 1);
  assert.equal(finalized.note, 'Finalized draft');
  assert.notEqual(finalized.context_json, null);
  assert.equal(JSON.parse(finalized.context_json).schema_version, 1);
  const values = await db.all(
    'SELECT attribute_code,value_num FROM journal_entry_values WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.deepEqual(
    values.map((value) => [value.attribute_code, value.value_num]),
    [['attr.irrigation_depth', 18]]
  );
  assert.equal(await count('journal_entries'), 1);
  assert.equal(await count('sync_outbox'), 1);
});

test('rejects a same-gateway plot owned by another user', async () => {
  await rejectCode(journal.finalize(db, catalog, validEntry({
    plot_uuid: plotUuid(20),
  }), principal()), 'plot_not_found');

  await assertNoJournalWrites();
});

test('rejects a principal whose trusted user id and owner UUID do not match', async () => {
  await rejectCode(journal.finalize(
    db,
    catalog,
    validEntry(),
    principal({ user_id: 2, owner_user_uuid: USER_UUID })
  ), 'invalid_principal');

  await assertNoJournalWrites();
});

test('rejects an optional device owned by another user', async () => {
  await rejectCode(journal.finalize(db, catalog, validEntry({
    device_eui: FOREIGN_DEVICE_EUI,
  }), principal()), 'ownership');

  await assertNoJournalWrites();
});

test('rejects an occurrence end before its start', async () => {
  await rejectCode(journal.finalize(db, catalog, validEntry({
    occurred_end_local: '2026-07-12T09:29',
  }), principal()), 'invalid_time_range');

  await assertNoJournalWrites();
});

test('rejects an ambiguous Zurich local time without an explicit UTC offset', async () => {
  await rejectCode(journal.finalize(db, catalog, validEntry({
    occurred_start_local: '2026-10-25T02:30',
  }), principal()), 'ambiguous_local_time');

  await assertNoJournalWrites();
});

test('uses an explicit UTC offset to disambiguate a Zurich fallback time', async () => {
  const result = await journal.finalize(db, catalog, validEntry({
    occurred_start_local: '2026-10-25T02:30',
    occurred_utc_offset_minutes: 120,
  }), principal());

  assert.equal(result.sync_version, 1);
  const entry = await db.get(
    'SELECT occurred_start,occurred_utc_offset_minutes FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.occurred_start, '2026-10-25T00:30:00.000Z');
  assert.equal(entry.occurred_utc_offset_minutes, 120);
});

test('requires an explicit crop when a linked plot has no covering season', async () => {
  await rejectCode(journal.finalize(db, catalog, validEntry({
    plot_uuid: plotUuid(21),
  }), principal()), 'season_required');

  await assertNoJournalWrites();
});

test('freezes an explicit crop and variety when no covering season exists', async () => {
  const result = await journal.finalize(db, catalog, validEntry({
    plot_uuid: plotUuid(21),
    season_crop: 'maize',
    season_variety: 'Pioneer P9241',
  }), principal());

  assert.equal(result.sync_version, 1);
  const entry = await db.get(
    'SELECT zone_uuid,season_uuid,season_crop,season_variety FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.zone_uuid, NO_SEASON_ZONE_UUID);
  assert.equal(entry.season_uuid, null);
  assert.equal(entry.season_crop, 'maize');
  assert.equal(entry.season_variety, 'Pioneer P9241');
});

test('resolves a plot linked to a legacy zone with a NULL gateway_device_eui', async () => {
  const result = await journal.finalize(db, catalog, validEntry({
    plot_uuid: plotUuid(23),
  }), principal());

  assert.equal(result.sync_version, 1);
  const entry = await db.get(
    'SELECT zone_id,zone_uuid,season_uuid,season_crop,season_variety ' +
    'FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.zone_id, 4);
  assert.equal(entry.zone_uuid, NULL_EUI_ZONE_UUID);
  assert.equal(entry.season_uuid, NULL_EUI_SEASON_UUID);
  assert.equal(entry.season_crop, 'wheat');
  assert.equal(entry.season_variety, 'Test');
});

test('resolves a device linked to a legacy zone with a NULL gateway_device_eui', async () => {
  const result = await journal.finalize(db, catalog, validEntry({
    plot_uuid: plotUuid(23),
    device_eui: NULL_EUI_ZONE_DEVICE_EUI,
  }), principal());

  assert.equal(result.sync_version, 1);
  const entry = await db.get(
    'SELECT zone_id,zone_uuid,device_eui FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.zone_id, 4);
  assert.equal(entry.zone_uuid, NULL_EUI_ZONE_UUID);
  assert.equal(entry.device_eui, NULL_EUI_ZONE_DEVICE_EUI);
});

test('correction preserves the batch UUID of a batch-created entry when omitted', async () => {
  const batch = await journal.finalizeBatch(
    db,
    catalog,
    validEntry({ entry_uuid: undefined, plot_uuid: undefined }),
    [plotUuid(2)],
    principal()
  );
  const created = batch.entries[0];

  const correction = await journal.finalize(db, catalog, validEntry({
    entry_uuid: created.entry_uuid,
    plot_uuid: created.plot_uuid,
    base_sync_version: 1,
    note: 'Corrected batch member',
  }), principal());

  assert.equal(correction.sync_version, 2);
  const entry = await db.get(
    'SELECT batch_uuid FROM journal_entries WHERE entry_uuid=?',
    [created.entry_uuid]
  );
  assert.equal(entry.batch_uuid, batch.batch_uuid);
});

test('command-originated void writes an APPLIED VOID ledger and ACK at version two', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const commandPrincipal = principal({
    origin: 'cloud-ui',
    command_id: 'command-void-77',
    effect_key: 'journal_entry:' + ENTRY_UUID + ':1',
  });

  const result = await journal.void_(
    db,
    catalog,
    ENTRY_UUID,
    1,
    'Voided by cloud command',
    commandPrincipal
  );

  assert.equal(result.sync_version, 2);
  const applied = await db.get(
    'SELECT * FROM applied_commands WHERE command_id=?',
    ['command-void-77']
  );
  assert.equal(applied.device_eui, GATEWAY_EUI);
  assert.equal(applied.command_type, 'VOID_JOURNAL_ENTRY');
  assert.equal(applied.effect_key, 'journal_entry:' + ENTRY_UUID + ':1');
  assert.equal(applied.result, 'APPLIED');
  const ackRow = await db.get(
    'SELECT * FROM command_ack_outbox WHERE command_id=?',
    ['command-void-77']
  );
  const ack = JSON.parse(ackRow.payload_json);
  assert.equal(ack.commandId, 'command-void-77');
  assert.equal(ack.status, 'ACKED');
  assert.equal(ack.result, 'APPLIED');
  assert.equal(ack.appliedSyncVersion, 2);
  assert.equal(ack.entryUuid, ENTRY_UUID);
});

test('command-originated void rejects a mismatched effect-key base and rolls back', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const beforeEntry = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  const beforeValues = await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]);
  const beforeOutbox = await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid');

  await rejectCode(journal.void_(
    db,
    catalog,
    ENTRY_UUID,
    1,
    'Must roll back',
    principal({
      origin: 'cloud-ui',
      command_id: 'command-void-wrong-base',
      effect_key: 'journal_entry:' + ENTRY_UUID + ':0',
    })
  ), 'invalid_effect_key');

  assert.deepEqual(await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]), beforeEntry);
  assert.deepEqual(await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]), beforeValues);
  assert.deepEqual(await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'), beforeOutbox);
  assert.equal(await count('applied_commands'), 0);
  assert.equal(await count('command_ack_outbox'), 0);
});

test('late command failure rolls back void, outbox, ledger, and ACK', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const before = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  const injected = new Error('injected command-void rollback');
  const commandPrincipal = principal({
    origin: 'cloud-ui',
    command_id: 'command-void-rollback',
    effect_key: 'journal_entry:' + ENTRY_UUID + ':1',
    lifecycle_hooks: {
      afterCommand() { throw injected; },
    },
  });

  await assert.rejects(
    journal.void_(
      db,
      catalog,
      ENTRY_UUID,
      1,
      'This void must roll back',
      commandPrincipal
    ),
    (error) => error === injected
  );
  assert.deepEqual(
    await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]),
    before
  );
  assert.equal(await count('sync_outbox'), 1);
  assert.equal(await count('applied_commands'), 0);
  assert.equal(await count('command_ack_outbox'), 0);
});

test('saveDraft rejects a note over 4000 characters without writing rows', async () => {
  await rejectCode(journal.saveDraft(db, catalog, validEntry({
    note: 'x'.repeat(4001),
  }), principal()), 'limit_exceeded');

  await assertNoJournalWrites();
});

test('saveDraft rejects more than 128 values without writing rows', async () => {
  const values = Array.from({ length: 129 }, (_, groupIndex) => ({
    attribute_code: 'attr.irrigation_depth',
    group_index: groupIndex,
    value: 12,
    unit_code: 'unit.mm_water',
    value_status: 'observed',
  }));

  await rejectCode(journal.saveDraft(db, catalog, validEntry({ values }), principal()), 'limit_exceeded');

  await assertNoJournalWrites();
});

test('saveDraft rejects a JSON request over 256 KiB without writing rows', async () => {
  const oversized = validEntry({
    request_padding: 'x'.repeat(256 * 1024),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 256 * 1024);

  await rejectCode(journal.saveDraft(db, catalog, oversized, principal()), 'limit_exceeded');

  await assertNoJournalWrites();
});

test('saveDraft rejects an author label over 120 characters without writing rows', async () => {
  await rejectCode(journal.saveDraft(
    db,
    catalog,
    validEntry(),
    principal({ author_label: 'x'.repeat(121) })
  ), 'limit_exceeded');

  await assertNoJournalWrites();
});

test('saveDraft rejects more than 32 distinct value groups without writing rows', async () => {
  const values = Array.from({ length: 33 }, (_, groupIndex) => ({
    attribute_code: 'attr.irrigation_depth',
    group_index: groupIndex,
    value: 12,
    unit_code: 'unit.mm_water',
    value_status: 'observed',
  }));

  await rejectCode(journal.saveDraft(db, catalog, validEntry({ values }), principal()), 'limit_exceeded');

  await assertNoJournalWrites();
});

test('saveDraft rejects observed text over 4096 UTF-8 bytes without writing rows', async () => {
  const oversizedText = '\u00e9'.repeat(2049);
  assert.ok(Buffer.byteLength(oversizedText, 'utf8') > 4096);
  assert.ok(Array.from(oversizedText).length < 4096);

  await rejectCode(journal.saveDraft(db, catalog, validEntry({
    values: [{
      attribute_code: 'attr.operator',
      group_index: 0,
      value: oversizedText,
      value_status: 'observed',
    }],
  }), principal()), 'limit_exceeded');

  await assertNoJournalWrites();
});

test('saveDraft rejects duplicate group_index/attribute_code values without writing rows', async () => {
  await rejectCode(journal.saveDraft(db, catalog, validEntry({
    values: [
      {
        attribute_code: 'attr.irrigation_depth',
        group_index: 0,
        value: 12,
        unit_code: 'unit.mm_water',
        value_status: 'observed',
      },
      {
        attribute_code: 'attr.irrigation_depth',
        group_index: 0,
        value: 18,
        unit_code: 'unit.mm_water',
        value_status: 'observed',
      },
    ],
  }), principal()), 'duplicate_value');

  await assertNoJournalWrites();
});

test('failed correction after value replacement restores entry, values, and outbox exactly', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const beforeEntry = await db.get(
    'SELECT * FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  const beforeValues = await db.all(
    'SELECT * FROM journal_entry_values WHERE entry_uuid=? ORDER BY group_index,attribute_code',
    [ENTRY_UUID]
  );
  const beforeOutbox = await db.all(
    'SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'
  );
  const injected = new Error('injected correction replacement failure');

  await assert.rejects(journal.finalize(db, catalog, validEntry({
    base_sync_version: 1,
    note: 'This replacement must roll back',
    values: [{
      attribute_code: 'attr.operator',
      group_index: 0,
      value: 'Replacement operator',
      value_status: 'observed',
    }],
  }), principal({
    lifecycle_hooks: {
      afterValues() { throw injected; },
    },
  })), (error) => error === injected);

  assert.deepEqual(
    await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]),
    beforeEntry
  );
  assert.deepEqual(
    await db.all(
      'SELECT * FROM journal_entry_values WHERE entry_uuid=? ORDER BY group_index,attribute_code',
      [ENTRY_UUID]
    ),
    beforeValues
  );
  assert.deepEqual(
    await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'),
    beforeOutbox
  );
});

test('correction rejects a changed batch UUID and preserves entry and outbox', async () => {
  const batch = await journal.finalizeBatch(
    db,
    catalog,
    validEntry({ entry_uuid: undefined, plot_uuid: undefined }),
    [plotUuid(2)],
    principal()
  );
  const created = batch.entries[0];
  const beforeEntry = await db.get(
    'SELECT * FROM journal_entries WHERE entry_uuid=?',
    [created.entry_uuid]
  );
  const beforeOutbox = await db.all(
    'SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'
  );

  await rejectCode(journal.finalize(db, catalog, validEntry({
    entry_uuid: created.entry_uuid,
    plot_uuid: created.plot_uuid,
    base_sync_version: 1,
    batch_uuid: '44444444-4444-4444-8444-444444444444',
  }), principal()), 'immutable_batch_uuid');

  assert.deepEqual(
    await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [created.entry_uuid]),
    beforeEntry
  );
  assert.deepEqual(
    await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'),
    beforeOutbox
  );
});

test('rejects an explicit start offset that does not match the timezone', async () => {
  await rejectCode(journal.finalize(db, catalog, validEntry({
    occurred_utc_offset_minutes: 60,
  }), principal()), 'invalid_utc_offset');

  await assertNoJournalWrites();
});

test('uses an explicit end offset to disambiguate a Zurich fallback time', async () => {
  const input = validEntry({
    occurred_start_local: '2026-10-25T01:30',
    occurred_end_local: '2026-10-25T02:30',
  });
  await rejectCode(
    journal.finalize(db, catalog, input, principal()),
    'ambiguous_local_time'
  );
  await assertNoJournalWrites();

  const result = await journal.finalize(db, catalog, Object.assign({}, input, {
    occurred_end_utc_offset_minutes: 60,
  }), principal());

  assert.equal(result.sync_version, 1);
  const entry = await db.get(
    'SELECT occurred_end FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.occurred_end, '2026-10-25T01:30:00.000Z');
});

test('command void rejects a non-void command type and rolls back every side effect', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const beforeEntry = await db.get(
    'SELECT * FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  const beforeOutbox = await db.all(
    'SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'
  );

  await rejectCode(journal.void_(
    db,
    catalog,
    ENTRY_UUID,
    1,
    'Wrong command type must not void',
    principal({
      origin: 'cloud-ui',
      command_id: 'command-void-wrong-type',
      command_type: 'UPSERT_JOURNAL_ENTRY',
      effect_key: 'journal_entry:' + ENTRY_UUID + ':1',
    })
  ), 'invalid_command_type');

  assert.deepEqual(
    await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]),
    beforeEntry
  );
  assert.deepEqual(
    await db.all('SELECT * FROM sync_outbox ORDER BY occurred_at,event_uuid'),
    beforeOutbox
  );
  assert.equal(await count('applied_commands'), 0);
  assert.equal(await count('command_ack_outbox'), 0);
});

test('finalize creates an exact farm-level aggregate without plot, zone, or season', async () => {
  const result = await journal.finalize(db, catalog, validEntry({
    activity_code: 'general_observation',
    template_code: 'farmer_quick',
    plot_uuid: null,
    occurred_timezone: 'Europe/Zurich',
    values: [{
      attribute_code: 'attr.operator',
      group_index: 0,
      value: 'Farm observer',
      value_status: 'observed',
    }],
    note: 'Farm-level observation',
  }), principal());

  assert.equal(result.entry_uuid, ENTRY_UUID);
  assert.equal(result.sync_version, 1);
  const entry = await db.get(
    'SELECT * FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.owner_user_uuid, USER_UUID);
  assert.equal(entry.user_id, 1);
  assert.equal(entry.gateway_device_eui, GATEWAY_EUI);
  assert.equal(entry.plot_uuid, null);
  assert.equal(entry.zone_id, null);
  assert.equal(entry.zone_uuid, null);
  assert.equal(entry.season_uuid, null);
  assert.equal(entry.season_crop, null);
  assert.equal(entry.season_variety, null);
  assert.equal(entry.context_json, null);
  const values = await db.all(
    'SELECT * FROM journal_entry_values WHERE entry_uuid=? ORDER BY group_index,attribute_code',
    [ENTRY_UUID]
  );
  const outbox = await db.get(
    'SELECT * FROM sync_outbox WHERE event_uuid=?',
    [result.outbox_event_uuid]
  );
  assert.equal(outbox.aggregate_type, 'JOURNAL_ENTRY');
  assert.equal(outbox.aggregate_key, ENTRY_UUID);
  assert.equal(outbox.op, 'JOURNAL_ENTRY_UPSERTED');
  assert.equal(outbox.sync_version, 1);
  assert.equal(outbox.gateway_device_eui, GATEWAY_EUI);
  assert.deepEqual(
    JSON.parse(outbox.payload_json),
    buildAggregate(Object.assign({ contract_version: 1 }, entry), values)
  );
  assert.equal(await count('sync_outbox'), 1);
});

test('sensorless plot requires and then freezes an explicit crop and variety', async () => {
  const input = validEntry({ plot_uuid: plotUuid(5) });
  await rejectCode(
    journal.finalize(db, catalog, input, principal()),
    'season_required'
  );
  await assertNoJournalWrites();

  const result = await journal.finalize(db, catalog, Object.assign({}, input, {
    season_crop: 'barley',
    season_variety: 'Golden',
  }), principal());

  assert.equal(result.sync_version, 1);
  const entry = await db.get(
    'SELECT plot_uuid,zone_id,zone_uuid,season_uuid,season_crop,season_variety,context_json ' +
    'FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.plot_uuid, plotUuid(5));
  assert.equal(entry.zone_id, null);
  assert.equal(entry.zone_uuid, null);
  assert.equal(entry.season_uuid, null);
  assert.equal(entry.season_crop, 'barley');
  assert.equal(entry.season_variety, 'Golden');
  assert.equal(entry.context_json, null);
  assert.equal(await count('sync_outbox'), 1);
});

test('finalizeBatch rejects an empty plot selection without writing rows', async () => {
  await rejectCode(journal.finalizeBatch(
    db,
    catalog,
    validEntry({ entry_uuid: undefined, plot_uuid: undefined }),
    [],
    principal()
  ), 'invalid_batch');

  await assertNoJournalWrites();
});

test('finalizeBatch rejects duplicate plot UUIDs without writing rows', async () => {
  await rejectCode(journal.finalizeBatch(
    db,
    catalog,
    validEntry({ entry_uuid: undefined, plot_uuid: undefined }),
    [plotUuid(2), plotUuid(2)],
    principal()
  ), 'duplicate_plot');

  await assertNoJournalWrites();
});

test('oversize saveDraft rejects before opening a database transaction', async () => {
  let transactionCalls = 0;
  const fakeDb = {
    transaction() {
      transactionCalls += 1;
      throw new Error('database transaction must not be invoked');
    },
  };
  const oversized = validEntry({
    request_padding: 'x'.repeat(256 * 1024),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 256 * 1024);

  await rejectCode(
    journal.saveDraft(fakeDb, catalog, oversized, principal()),
    'limit_exceeded'
  );
  assert.equal(transactionCalls, 0);
});

test('correction keeps its originally frozen season after the covering season changes', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const original = await db.get(
    'SELECT season_uuid,season_crop,season_variety FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );

  let corrected;
  try {
    await db.run(
      'UPDATE zone_seasons SET crop_type=?,variety=? WHERE season_uuid=?',
      ['wheat', 'Changed after recording', SEASON_UUID]
    );
    await journal.finalize(db, catalog, validEntry({
      base_sync_version: 1,
      note: 'Correction after season metadata changed',
      values: [{
        attribute_code: 'attr.operator',
        group_index: 0,
        value: 'Correcting operator',
        value_status: 'observed',
      }],
    }), principal());
    corrected = await db.get(
      'SELECT season_uuid,season_crop,season_variety FROM journal_entries WHERE entry_uuid=?',
      [ENTRY_UUID]
    );
  } finally {
    await db.run(
      'UPDATE zone_seasons SET crop_type=?,variety=? WHERE season_uuid=?',
      ['barley', 'Golden', SEASON_UUID]
    );
  }

  assert.deepEqual(
    [corrected.season_uuid, corrected.season_crop, corrected.season_variety],
    [original.season_uuid, original.season_crop, original.season_variety]
  );
});

test('timezone-only correction selects the season covering the new local date', async () => {
  try {
    await db.run(
      'UPDATE zone_seasons SET starts_on=?,ends_on=? WHERE season_uuid=?',
      ['2026-07-12', '2026-12-31', SEASON_UUID]
    );
    await db.run(
      'INSERT INTO zone_seasons(' +
        'zone_id,season_uuid,name,starts_on,ends_on,crop_type,variety' +
      ') VALUES (?,?,?,?,?,?,?)',
      [1, PRIOR_SEASON_UUID, 'Prior crop', '2026-01-01', '2026-07-11', 'wheat', 'Prior']
    );
    await journal.finalize(db, catalog, validEntry({
      occurred_start_local: '2026-07-12T00:30',
      occurred_timezone: 'Europe/Zurich',
    }), principal());
    assert.equal(
      (await db.get('SELECT season_uuid FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]))
        .season_uuid,
      SEASON_UUID
    );

    await journal.finalize(db, catalog, validEntry({
      base_sync_version: 1,
      occurred_start_local: '2026-07-11T18:30',
      occurred_timezone: 'America/New_York',
      occurred_utc_offset_minutes: -240,
      note: 'Same instant, previous local date',
    }), principal());

    const corrected = await db.get(
      'SELECT occurred_start,occurred_timezone,season_uuid FROM journal_entries WHERE entry_uuid=?',
      [ENTRY_UUID]
    );
    assert.equal(corrected.occurred_start, '2026-07-11T22:30:00.000Z');
    assert.equal(corrected.occurred_timezone, 'America/New_York');
    assert.equal(corrected.season_uuid, PRIOR_SEASON_UUID);
  } finally {
    await db.run('DELETE FROM zone_seasons WHERE season_uuid=?', [PRIOR_SEASON_UUID]);
    await db.run(
      'UPDATE zone_seasons SET starts_on=?,ends_on=? WHERE season_uuid=?',
      ['2026-01-01', '2026-12-31', SEASON_UUID]
    );
  }
});

test('finalize rejects a stale loaded catalog without writing rows', async () => {
  assert.ok(Number.isInteger(catalog.version));
  assert.equal(typeof catalog.hash, 'string');
  try {
    await db.run(
      'UPDATE journal_catalog_state SET catalog_version=?,catalog_hash=?,updated_at=? WHERE id=?',
      [catalog.version + 1, 'f'.repeat(64), '2026-07-13T00:00:00.000Z', 1]
    );

    await rejectCode(
      journal.finalize(db, catalog, validEntry(), principal()),
      'stale_catalog'
    );
    await assertNoJournalWrites();
  } finally {
    await db.run(
      'UPDATE journal_catalog_state SET catalog_version=?,catalog_hash=?,updated_at=? WHERE id=?',
      [catalog.version, catalog.hash, '2026-07-12T00:00:00.000Z', 1]
    );
  }
});

test('finalize rejects a plot whose linked zone is soft-deleted', async () => {
  try {
    await db.run(
      'UPDATE irrigation_zones SET deleted_at=? WHERE id=?',
      ['2026-07-13T00:00:00.000Z', 1]
    );

    await rejectCode(
      journal.finalize(db, catalog, validEntry(), principal()),
      'zone_not_found'
    );
    await assertNoJournalWrites();
  } finally {
    await db.run('UPDATE irrigation_zones SET deleted_at=NULL WHERE id=?', [1]);
  }
});

test('finalize anchors an active owned device and rejects it after soft deletion', async () => {
  const active = await journal.finalize(db, catalog, validEntry({
    device_eui: OWNED_DEVICE_EUI,
  }), principal());
  assert.equal(active.sync_version, 1);
  const anchored = await db.get(
    'SELECT device_eui FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(anchored.device_eui, OWNED_DEVICE_EUI);
  await resetMutations();

  try {
    await db.run(
      'UPDATE devices SET deleted_at=? WHERE deveui=?',
      ['2026-07-13T00:00:00.000Z', OWNED_DEVICE_EUI]
    );

    await rejectCode(journal.finalize(db, catalog, validEntry({
      device_eui: OWNED_DEVICE_EUI,
    }), principal()), 'not_found');
    await assertNoJournalWrites();
  } finally {
    await db.run('UPDATE devices SET deleted_at=NULL WHERE deveui=?', [OWNED_DEVICE_EUI]);
  }
});

test('finalizeBatch rejects a null plot before opening a database transaction', async () => {
  let transactionCalls = 0;
  const fakeDb = {
    transaction() {
      transactionCalls += 1;
      const error = new Error('database transaction must not be invoked');
      error.code = 'db_transaction_invoked';
      throw error;
    },
  };

  await rejectCode(journal.finalizeBatch(
    fakeDb,
    catalog,
    validEntry({ entry_uuid: undefined, plot_uuid: undefined }),
    [plotUuid(2), null],
    principal()
  ), 'invalid_batch');
  assert.equal(transactionCalls, 0);
  await assertNoJournalWrites();
});

test('saveDraft rejects a malformed entry UUID without writing rows', async () => {
  await rejectCode(journal.saveDraft(db, catalog, validEntry({
    entry_uuid: 'not-a-uuid',
  }), principal()), 'invalid_uuid');

  await assertNoJournalWrites();
});

test('saveDraft canonicalizes a compact uppercase entry UUID before storing it', async () => {
  const compactUppercase = ENTRY_UUID.replace(/-/g, '').toUpperCase();
  const result = await journal.saveDraft(db, catalog, validEntry({
    entry_uuid: compactUppercase,
  }), principal());

  assert.equal(result.entry_uuid, ENTRY_UUID);
  assert.equal(result.sync_version, 0);
  const rows = await db.all('SELECT entry_uuid FROM journal_entries');
  assert.deepEqual(rows.map((row) => row.entry_uuid), [ENTRY_UUID]);
});

for (const identityField of ['campaign_uuid', 'pass_uuid', 'batch_uuid']) {
  test('saveDraft rejects a malformed ' + identityField + ' without writing rows', async () => {
    await rejectCode(journal.saveDraft(db, catalog, validEntry({
      [identityField]: 'not-a-uuid',
    }), principal()), 'invalid_uuid');

    await assertNoJournalWrites();
  });
}

test('oversize finalize rejects before opening a database transaction', async () => {
  let transactionCalls = 0;
  const fakeDb = {
    transaction() {
      transactionCalls += 1;
      const error = new Error('database transaction must not be invoked');
      error.code = 'db_transaction_invoked';
      throw error;
    },
  };
  const oversized = validEntry({
    request_padding: 'x'.repeat(256 * 1024),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 256 * 1024);

  await rejectCode(
    journal.finalize(fakeDb, catalog, oversized, principal()),
    'limit_exceeded'
  );
  assert.equal(transactionCalls, 0);
});

test('oversize finalizeBatch rejects before opening a database transaction', async () => {
  let transactionCalls = 0;
  const fakeDb = {
    transaction() {
      transactionCalls += 1;
      const error = new Error('database transaction must not be invoked');
      error.code = 'db_transaction_invoked';
      throw error;
    },
  };
  const oversized = validEntry({
    entry_uuid: undefined,
    plot_uuid: undefined,
    request_padding: 'x'.repeat(256 * 1024),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 256 * 1024);

  await rejectCode(journal.finalizeBatch(
    fakeDb,
    catalog,
    oversized,
    [plotUuid(2)],
    principal()
  ), 'limit_exceeded');
  assert.equal(transactionCalls, 0);
});

test('finalize rejects an active owned device whose linked zone is soft-deleted', async () => {
  try {
    await db.run(
      'UPDATE irrigation_zones SET deleted_at=? WHERE id=?',
      ['2026-07-13T00:00:00.000Z', 1]
    );

    await rejectCode(journal.finalize(db, catalog, validEntry({
      activity_code: 'general_observation',
      template_code: 'farmer_quick',
      plot_uuid: null,
      device_eui: OWNED_DEVICE_EUI,
      occurred_timezone: 'Europe/Zurich',
      values: [{
        attribute_code: 'attr.operator',
        group_index: 0,
        value: 'Farm observer',
        value_status: 'observed',
      }],
    }), principal()), 'not_found');
    await assertNoJournalWrites();
  } finally {
    await db.run('UPDATE irrigation_zones SET deleted_at=NULL WHERE id=?', [1]);
  }
});

test('oversize correction-shaped finalize rejects before opening a database transaction', async () => {
  let transactionCalls = 0;
  const fakeDb = {
    transaction() {
      transactionCalls += 1;
      const error = new Error('database transaction must not be invoked');
      error.code = 'db_transaction_invoked';
      throw error;
    },
  };
  const oversized = validEntry({
    base_sync_version: 1,
    request_padding: 'x'.repeat(256 * 1024),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 256 * 1024);

  await rejectCode(
    journal.finalize(fakeDb, catalog, oversized, principal()),
    'limit_exceeded'
  );
  assert.equal(transactionCalls, 0);
});
