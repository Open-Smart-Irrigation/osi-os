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
const FOREIGN_ZONE_UUID = '22222222-2222-4222-8222-222222222222';
const NO_SEASON_ZONE_UUID = '33333333-3333-4333-8333-333333333333';
const GATEWAY_EUI = '0016C001F11715E2';
const OWNED_DEVICE_EUI = '70B3D57ED0061234';
const FOREIGN_DEVICE_EUI = 'A84041ABCDEFFEDC';
const ENTRY_UUID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLOT_NUMBERS = [2, 5, 6, 10, 12];

function plotUuid(number) {
  return String(number).padStart(8, '0') + '-0000-4000-8000-' +
    String(number).padStart(12, '0');
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
    'INSERT INTO zone_seasons(zone_id,season_uuid,name,starts_on,ends_on,crop_type,variety) ' +
    'VALUES (?,?,?,?,?,?,?)'
  ).run(1, SEASON_UUID, 'Barley 2026', '2026-01-01', '2026-12-31', 'barley', 'Golden');
  for (const number of PLOT_NUMBERS) {
    native.prepare(
      'INSERT INTO journal_plots(plot_uuid,plot_code,name,zone_uuid,station_code,gateway_device_eui) ' +
      'VALUES (?,?,?,?,?,?)'
    ).run(
      plotUuid(number),
      'LYS-' + number,
      'Lysimeter ' + number,
      number === 2 ? ZONE_UUID : null,
      'LYS',
      GATEWAY_EUI
    );
    native.prepare(
      'INSERT INTO journal_plot_settings(plot_uuid,layout_code,updated_at,updated_by_principal_uuid) ' +
      'VALUES (?,?,?,?)'
    ).run(plotUuid(number), 'open_field', '2026-07-12T00:00:00.000Z', PRINCIPAL_UUID);
  }
  for (const fixture of [
    { number: 20, code: 'FOREIGN-20', zoneUuid: FOREIGN_ZONE_UUID },
    { number: 21, code: 'NO-SEASON-21', zoneUuid: NO_SEASON_ZONE_UUID },
  ]) {
    native.prepare(
      'INSERT INTO journal_plots(plot_uuid,plot_code,name,zone_uuid,station_code,gateway_device_eui) ' +
      'VALUES (?,?,?,?,?,?)'
    ).run(
      plotUuid(fixture.number),
      fixture.code,
      fixture.code,
      fixture.zoneUuid,
      'TEST',
      GATEWAY_EUI
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

test('saveDraft keeps an incomplete entry local at version zero without an outbox row', async () => {
  const result = await journal.saveDraft(db, catalog, validEntry({
    activity_code: 'fertilization',
    template_code: 'full_record',
    values: [],
  }), principal());

  assert.deepEqual(result, { entry_uuid: ENTRY_UUID, sync_version: 0 });
  const entry = await db.get('SELECT status,sync_version FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  assert.equal(entry.status, 'draft');
  assert.equal(entry.sync_version, 0);
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
    'SELECT entry_uuid,plot_uuid,batch_uuid,sync_version,status FROM journal_entries ORDER BY plot_uuid'
  );
  assert.equal(entries.length, 5);
  assert.equal(new Set(entries.map((entry) => entry.batch_uuid)).size, 1);
  assert.equal(entries[0].batch_uuid, result.batch_uuid);
  assert.ok(entries.every((entry) => entry.sync_version === 1 && entry.status === 'final'));
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
  assert.equal(entry.context_json, null);
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

test('void preserves values and emits a complete JOURNAL_ENTRY_VOIDED aggregate', async () => {
  await journal.finalize(db, catalog, validEntry(), principal());
  const beforeValues = await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]);
  const result = await journal.void_(db, catalog, ENTRY_UUID, 1, 'Recorded twice', principal());

  assert.equal(result.sync_version, 2);
  assert.match(result.outbox_event_uuid, UUID_PATTERN);
  const entry = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
  const afterValues = await db.all('SELECT * FROM journal_entry_values WHERE entry_uuid=?', [ENTRY_UUID]);
  assert.equal(entry.status, 'voided');
  assert.equal(entry.voided_by_principal_uuid, PRINCIPAL_UUID);
  assert.equal(entry.void_reason, 'Recorded twice');
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
    'SELECT id,entry_uuid,created_at,recorded_at,author_principal_uuid,status,sync_version,note ' +
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
    'SELECT id,entry_uuid,created_at,recorded_at,author_principal_uuid,status,sync_version,note ' +
    'FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.deepEqual(entryIdentity(finalized), entryIdentity(draft));
  assert.equal(finalized.status, 'final');
  assert.equal(finalized.sync_version, 1);
  assert.equal(finalized.note, 'Finalized draft');
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
  }), principal()), 'ownership');

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
    'SELECT plot_uuid,zone_id,zone_uuid,season_uuid,season_crop,season_variety ' +
    'FROM journal_entries WHERE entry_uuid=?',
    [ENTRY_UUID]
  );
  assert.equal(entry.plot_uuid, plotUuid(5));
  assert.equal(entry.zone_id, null);
  assert.equal(entry.zone_uuid, null);
  assert.equal(entry.season_uuid, null);
  assert.equal(entry.season_crop, 'barley');
  assert.equal(entry.season_variety, 'Golden');
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
