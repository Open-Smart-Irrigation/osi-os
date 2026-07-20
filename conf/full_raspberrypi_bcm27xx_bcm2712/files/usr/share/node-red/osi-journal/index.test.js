'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { loadCatalog } = require('./catalog');
const {
  allowedUnits,
  assertJournalEntryEffectKey,
  convertToCanonical,
  listPlots,
  saveEntry,
  upsertPlot,
  validateEntry,
} = require('./index');
const { numericAttributePreflight } = require('./units');
const { usableUnitPath } = require('./unit-family');

const repoRoot = path.resolve(__dirname, '../../../../../../..');
const seedSql = fs.readFileSync(path.join(repoRoot, 'database/seed-blank.sql'), 'utf8');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-test-'));
const databases = [];
const JOURNAL_TEST_OWNER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOURNAL_TEST_GATEWAY_EUI = '0016C001F1000001';

test.after(() => {
  for (const db of databases) db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function createTestDb(name) {
  const db = new DatabaseSync(path.join(tempRoot, name + '.db'));
  db.exec(seedSql);
  databases.push(db);
  return db;
}

function createJournalDb(name) {
  const raw = createTestDb(name);
  const db = {
    prepare: raw.prepare.bind(raw),
    get(sql, params) {
      return raw.prepare(sql).get(...(params || []));
    },
    all(sql, params) {
      return raw.prepare(sql).all(...(params || []));
    },
    run(sql, params) {
      return raw.prepare(sql).run(...(params || []));
    },
    exec: raw.exec.bind(raw),
    async transaction(executor) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await executor(db);
        raw.exec('COMMIT');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return db;
}

function seedJournalTestIdentity(db) {
  db.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,user_uuid) VALUES (?,?,?,?,?)'
  ).run(1, 'journal-test-user', 'unused', '2026-07-19T00:00:00.000Z', JOURNAL_TEST_OWNER_UUID);
}

function journalTestPrincipal() {
  return {
    user_id: 1,
    owner_user_uuid: JOURNAL_TEST_OWNER_UUID,
    author_principal_uuid: JOURNAL_TEST_OWNER_UUID,
    author_label: 'journal-test-user',
    gateway_device_eui: JOURNAL_TEST_GATEWAY_EUI,
    origin: 'edge-ui',
  };
}

async function loadedFixture(name) {
  const catalog = await loadCatalog(createTestDb(name));
  return {
    catalog,
    farmerQuick: catalog.templates.get('farmer_quick').get(1),
    fullRecord: catalog.templates.get('full_record').get(1),
    openField: catalog.layouts.get('open_field').get(1),
  };
}

function validIrrigation(overrides) {
  return Object.assign({
    entry_uuid: '11111111-1111-4111-8111-111111111111',
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    layout_code: 'open_field',
    occurred_start_local: '2026-07-12T09:30:00',
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

test('upsertPlot persists and round-trips context_json, and clears it when omitted (Slice BC R1 Part 2)', async () => {
  const db = createJournalDb('plot-context-json');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plotUuid = '99990000-0000-4000-8000-000000000001';
  const contextJson = JSON.stringify({ 'attr.block_bed_row': 'B-12' });
  const created = await upsertPlot(db, {
    plot_uuid: plotUuid,
    base_sync_version: 0,
    plot_code: 'context-json-plot',
    name: 'Context JSON plot',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
    context_json: contextJson,
  }, principal);
  assert.equal(created.plot.settings.context_json, contextJson);
  assert.equal(
    db.prepare('SELECT context_json FROM journal_plot_settings WHERE plot_uuid=?').get(plotUuid).context_json,
    contextJson,
  );

  const updated = await upsertPlot(db, {
    plot_uuid: plotUuid,
    base_sync_version: created.plot.sync_version,
    plot_code: 'context-json-plot',
    name: 'Context JSON plot',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
    context_json: null,
  }, principal);
  assert.equal(updated.plot.settings.context_json, null);
});

test('listPlots round-trips context_json (Slice BC R1 Part 2 — read path)', async () => {
  const db = createJournalDb('plot-context-json-list');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plotUuid = '99990000-0000-4000-8000-000000000002';
  const contextJson = JSON.stringify({ 'attr.block_bed_row': 'B-19' });
  await upsertPlot(db, {
    plot_uuid: plotUuid,
    base_sync_version: 0,
    plot_code: 'context-json-list-plot',
    name: 'Context JSON list plot',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
    context_json: contextJson,
  }, principal);

  // listPlots is the GUI's plot-fetch path; it must project context_json or the
  // read-only display + entry snapshot no-op after reload and the next edit wipes it.
  const { plots } = await listPlots(db, principal);
  assert.equal(plots.length, 1, 'exactly the one seeded plot is listed');
  assert.equal(plots[0].settings.context_json, contextJson);
});

test('upsertPlot rejects malformed context_json', async () => {
  const db = createJournalDb('plot-context-json-invalid');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  await assert.rejects(
    upsertPlot(db, {
      plot_uuid: '99990000-0000-4000-8000-000000000002',
      base_sync_version: 0,
      plot_code: 'context-json-invalid',
      name: 'Invalid',
      zone_uuid: null,
      station_code: null,
      crop_hint: null,
      area_m2: null,
      active: 1,
      layout_code: 'open_field',
      layout_version: 1,
      context_json: '{not-json',
    }, principal),
    (error) => error && error.code === 'invalid_json' && error.statusCode === 422,
  );
});

test('saveEntry batch retry returns original receipts without entry or outbox writes', async () => {
  const db = createJournalDb('batch-retry-noop');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const members = [
    { plot_uuid: '11110000-0000-4000-8000-000000000001', entry_uuid: '22220000-0000-4000-8000-000000000001' },
    { plot_uuid: '11110000-0000-4000-8000-000000000002', entry_uuid: '22220000-0000-4000-8000-000000000002' },
  ];
  for (const [index, member] of members.entries()) {
    await upsertPlot(db, {
      plot_uuid: member.plot_uuid,
      base_sync_version: 0,
      plot_code: 'retry-' + index,
      name: 'Retry ' + index,
      zone_uuid: null,
      station_code: null,
      crop_hint: 'barley',
      area_m2: 100,
      active: 1,
      layout_code: 'open_field',
      layout_version: 1,
    }, principal);
  }
  const batch = {
    status: 'final',
    base_sync_version: 0,
    members,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-19T08:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 12,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
  };

  const first = await saveEntry(db, batch, principal, { mode: 'create' });
  const entriesBeforeRetry = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  const outboxBeforeRetry = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  const retry = await saveEntry(db, batch, principal, { mode: 'create' });

  assert.equal(retry.batch_uuid, first.batch_uuid);
  assert.deepEqual(retry.entries, first.entries);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entriesBeforeRetry);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, outboxBeforeRetry);
});

test('saveEntry rejects changed content for the same batch member UUID without writes', async () => {
  const db = createJournalDb('batch-retry-content-conflict');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const member = {
    plot_uuid: '11130000-0000-4000-8000-000000000001',
    entry_uuid: '22240000-0000-4000-8000-000000000001',
  };
  await upsertPlot(db, {
    plot_uuid: member.plot_uuid,
    base_sync_version: 0,
    plot_code: 'content-conflict',
    name: 'Content conflict',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  }, principal);
  const batch = {
    status: 'final',
    base_sync_version: 0,
    members: [member],
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-19T10:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 12,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }, {
      attribute_code: 'attr.observation_text',
      group_index: 0,
      value: 'same intent',
      value_status: 'observed',
    }],
  };
  const first = await saveEntry(db, batch, principal, { mode: 'create' });
  const reordered = await saveEntry(db, Object.assign({}, batch, {
    values: [batch.values[1], batch.values[0]],
  }), principal, { mode: 'create' });
  assert.deepEqual(reordered, first);
  const before = JSON.stringify({
    entries: db.prepare('SELECT * FROM journal_entries').all(),
    values: db.prepare('SELECT * FROM journal_entry_values').all(),
    outbox: db.prepare('SELECT * FROM sync_outbox').all(),
  });

  await assert.rejects(
    saveEntry(db, Object.assign({}, batch, {
      values: [Object.assign({}, batch.values[0], { value: 13 })],
    }), principal, { mode: 'create' }),
    (error) => error && error.code === 'idempotency_conflict' && error.statusCode === 409
  );
  assert.equal(JSON.stringify({
    entries: db.prepare('SELECT * FROM journal_entries').all(),
    values: db.prepare('SELECT * FROM journal_entry_values').all(),
    outbox: db.prepare('SELECT * FROM sync_outbox').all(),
  }), before);
});

test('saveEntry exact batch retry remains a no-op after plot deactivation', async () => {
  const db = createJournalDb('batch-retry-inactive-plot');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const member = {
    plot_uuid: '11140000-0000-4000-8000-000000000001',
    entry_uuid: '22250000-0000-4000-8000-000000000001',
  };
  await upsertPlot(db, {
    plot_uuid: member.plot_uuid,
    base_sync_version: 0,
    plot_code: 'inactive-retry',
    name: 'Inactive retry',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  }, principal);
  const batch = {
    status: 'final',
    base_sync_version: 0,
    members: [member],
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-19T11:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 12,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
  };
  const first = await saveEntry(db, batch, principal, { mode: 'create' });
  await upsertPlot(db, Object.assign({}, {
    plot_uuid: member.plot_uuid,
    base_sync_version: 1,
    plot_code: 'inactive-retry',
    name: 'Inactive retry',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 100,
    active: 0,
    layout_code: 'open_field',
    layout_version: 1,
  }), principal, member.plot_uuid);
  const before = JSON.stringify({
    entries: db.prepare('SELECT * FROM journal_entries').all(),
    values: db.prepare('SELECT * FROM journal_entry_values').all(),
    outbox: db.prepare('SELECT * FROM sync_outbox').all(),
  });
  const retry = await saveEntry(db, batch, principal, { mode: 'create' });
  assert.deepEqual(retry, first);
  assert.equal(JSON.stringify({
    entries: db.prepare('SELECT * FROM journal_entries').all(),
    values: db.prepare('SELECT * FROM journal_entry_values').all(),
    outbox: db.prepare('SELECT * FROM sync_outbox').all(),
  }), before);
});

test('saveEntry rejects a tombstoned batch member UUID with a controlled conflict and no writes', async () => {
  const db = createJournalDb('batch-retry-tombstoned-entry');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const member = {
    plot_uuid: '11150000-0000-4000-8000-000000000001',
    entry_uuid: '22260000-0000-4000-8000-000000000001',
  };
  await upsertPlot(db, {
    plot_uuid: member.plot_uuid,
    base_sync_version: 0,
    plot_code: 'tombstoned-entry',
    name: 'Tombstoned entry',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  }, principal);
  const batch = {
    status: 'final',
    base_sync_version: 0,
    members: [member],
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-19T11:30:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 12,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
  };
  await saveEntry(db, batch, principal, { mode: 'create' });
  db.prepare('UPDATE journal_entries SET deleted_at=? WHERE entry_uuid=?').run(
    '2026-07-19T12:00:00.000Z', member.entry_uuid
  );
  const before = JSON.stringify({
    entries: db.prepare('SELECT * FROM journal_entries').all(),
    values: db.prepare('SELECT * FROM journal_entry_values').all(),
    outbox: db.prepare('SELECT * FROM sync_outbox').all(),
  });

  await assert.rejects(
    saveEntry(db, batch, principal, { mode: 'create' }),
    (error) => error && error.code === 'idempotency_conflict' && error.statusCode === 409
  );
  assert.equal(JSON.stringify({
    entries: db.prepare('SELECT * FROM journal_entries').all(),
    values: db.prepare('SELECT * FROM journal_entry_values').all(),
    outbox: db.prepare('SELECT * FROM sync_outbox').all(),
  }), before);
});

test('saveEntry rejects a same-UUID retry after one member is corrected to version two', async () => {
  const db = createJournalDb('batch-retry-after-correction');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const members = [
    { plot_uuid: '11120000-0000-4000-8000-000000000001', entry_uuid: '22230000-0000-4000-8000-000000000001' },
    { plot_uuid: '11120000-0000-4000-8000-000000000002', entry_uuid: '22230000-0000-4000-8000-000000000002' },
  ];
  for (const [index, member] of members.entries()) {
    await upsertPlot(db, {
      plot_uuid: member.plot_uuid,
      base_sync_version: 0,
      plot_code: 'corrected-retry-' + index,
      name: 'Corrected retry ' + index,
      zone_uuid: null,
      station_code: null,
      crop_hint: 'barley',
      area_m2: 100,
      active: 1,
      layout_code: 'open_field',
      layout_version: 1,
    }, principal);
  }
  const batch = {
    status: 'final',
    base_sync_version: 0,
    members,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-19T09:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 12,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
  };

  await saveEntry(db, batch, principal, { mode: 'create' });
  const corrected = Object.assign({}, batch, {
    entry_uuid: members[0].entry_uuid,
    plot_uuid: members[0].plot_uuid,
    base_sync_version: 1,
  });
  delete corrected.members;
  await saveEntry(db, corrected, principal, {
    mode: 'update',
    entryUuid: members[0].entry_uuid,
  });
  const entriesBeforeRetry = db.prepare('SELECT * FROM journal_entries ORDER BY entry_uuid').all();
  const outboxBeforeRetry = db.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all();

  await assert.rejects(
    saveEntry(db, batch, principal, { mode: 'create' }),
    (error) => error && error.code === 'idempotency_conflict' && error.statusCode === 409
  );
  assert.deepEqual(db.prepare('SELECT * FROM journal_entries ORDER BY entry_uuid').all(), entriesBeforeRetry);
  assert.deepEqual(db.prepare('SELECT * FROM sync_outbox ORDER BY rowid').all(), outboxBeforeRetry);
});

test('saveEntry rejects a same-UUID retry when a write-bearing batch field changes', async () => {
  const changes = [
    ['activity', (payload) => Object.assign({}, payload, { activity_code: 'fertilization' })],
    ['occurrence', (payload) => Object.assign({}, payload, { occurred_start_local: '2026-07-19T08:01:00' })],
    ['value', (payload) => Object.assign({}, payload, {
      values: [Object.assign({}, payload.values[0], { value: 13 })],
    })],
  ];
  for (const [label, change] of changes) {
    const db = createJournalDb('batch-retry-intent-' + label);
    seedJournalTestIdentity(db);
    const principal = journalTestPrincipal();
    const member = {
      plot_uuid: '11130000-0000-4000-8000-000000000001',
      entry_uuid: '22240000-0000-4000-8000-000000000001',
    };
    await upsertPlot(db, {
      plot_uuid: member.plot_uuid,
      base_sync_version: 0,
      plot_code: 'intent-' + label,
      name: 'Intent ' + label,
      zone_uuid: null,
      station_code: null,
      crop_hint: 'barley',
      area_m2: 100,
      active: 1,
      layout_code: 'open_field',
      layout_version: 1,
    }, principal);
    const batch = {
      status: 'final',
      base_sync_version: 0,
      members: [member],
      activity_code: 'irrigation',
      template_code: 'farmer_quick',
      template_version: 1,
      layout_code: 'open_field',
      layout_version: 1,
      occurred_start_local: '2026-07-19T10:00:00',
      occurred_timezone: 'Europe/Zurich',
      season_crop: 'barley',
      values: [{
        attribute_code: 'attr.irrigation_depth',
        group_index: 0,
        value: 12,
        unit_code: 'unit.mm_water',
        value_status: 'observed',
      }],
    };
    const first = await saveEntry(db, batch, principal, { mode: 'create' });
    const outboxCount = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
    await assert.rejects(
      saveEntry(db, change(batch), principal, { mode: 'create' }),
      (error) => error && error.code === 'idempotency_conflict' && error.statusCode === 409,
      label + ' retry must not replay a different write intent'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 1, label);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, outboxCount, label);
    assert.equal(first.entries.length, 1);
  }
});

test('saveEntry returns the original batch receipts after the plot is inactive or soft-deleted', async () => {
  for (const [label, mutate] of [
    ['inactive', (db, plotUuid) => db.prepare(
      'UPDATE journal_plots SET active=0 WHERE plot_uuid=?'
    ).run(plotUuid)],
    ['soft-deleted', (db, plotUuid) => db.prepare(
      'UPDATE journal_plots SET deleted_at=? WHERE plot_uuid=?'
    ).run('2026-07-19T12:00:00.000Z', plotUuid)],
  ]) {
    const db = createJournalDb('batch-retry-plot-' + label);
    seedJournalTestIdentity(db);
    const principal = journalTestPrincipal();
    const member = {
      plot_uuid: '11140000-0000-4000-8000-000000000001',
      entry_uuid: '22250000-0000-4000-8000-000000000001',
    };
    await upsertPlot(db, {
      plot_uuid: member.plot_uuid,
      base_sync_version: 0,
      plot_code: 'plot-retry-' + label,
      name: 'Plot retry ' + label,
      zone_uuid: null,
      station_code: null,
      crop_hint: 'barley',
      area_m2: 100,
      active: 1,
      layout_code: 'open_field',
      layout_version: 1,
    }, principal);
    const batch = {
      status: 'final',
      base_sync_version: 0,
      members: [member],
      activity_code: 'irrigation',
      template_code: 'farmer_quick',
      template_version: 1,
      layout_code: 'open_field',
      layout_version: 1,
      occurred_start_local: '2026-07-19T11:00:00',
      occurred_timezone: 'Europe/Zurich',
      season_crop: 'barley',
      values: [{
        attribute_code: 'attr.irrigation_depth',
        group_index: 0,
        value: 12,
        unit_code: 'unit.mm_water',
        value_status: 'observed',
      }],
    };
    const first = await saveEntry(db, batch, principal, { mode: 'create' });
    mutate(db, member.plot_uuid);
    const retry = await saveEntry(db, batch, principal, { mode: 'create' });
    assert.deepEqual(retry, first, label + ' retry must preserve the original receipt');
  }
});

test('assertJournalEntryEffectKey binds UUID and prior version exactly', () => {
  const entryUuid = '12345678-1234-4234-8234-123456789abc';
  assert.doesNotThrow(() => assertJournalEntryEffectKey(
    'journal_entry:' + entryUuid + ':1',
    entryUuid,
    2
  ));
  assert.throws(
    () => assertJournalEntryEffectKey('journal_entry:' + entryUuid + ':0', entryUuid, 2),
    (error) => error && error.code === 'invalid_effect_key'
  );
  assert.throws(
    () => assertJournalEntryEffectKey(
      'journal_entry:' + entryUuid.toUpperCase() + ':1',
      entryUuid.toUpperCase(),
      2
    ),
    (error) => error && error.code === 'invalid_effect_key'
  );
});

test('loadCatalog reads the seeded catalog into code-indexed maps', async () => {
  const catalog = await loadCatalog(createTestDb('load'));

  // Slice BC: the seeded catalog is now at v3 (farmer_quick@3 quick_fields +
  // layout v3 static/reading split).
  assert.equal(catalog.version, 3);
  assert.match(catalog.hash, /^[a-f0-9]{64}$/);
  assert.equal(catalog.vocabByCode.get('irrigation').kind, 'activity');
  assert.equal(catalog.templates.get('farmer_quick').get(1).definition.max_primary_fields, 5);
  assert.ok(catalog.layouts.get('open_field').has(1));
  assert.equal(catalog.products.size, 10);
});

test('loadCatalog caches data queries until catalog state changes', async () => {
  const rawDb = createTestDb('cache');
  const counts = new Map();
  const db = {
    prepare(sql) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      counts.set(table, (counts.get(table) || 0) + 1);
      return rawDb.prepare(sql);
    },
  };

  const first = await loadCatalog(db);
  const second = await loadCatalog(db);
  assert.strictEqual(second, first);
  assert.equal(counts.get('journal_catalog_state'), 3);
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    assert.equal(counts.get(table), 1, table);
  }

  rawDb.exec("UPDATE journal_catalog_state SET catalog_version=2, catalog_hash='" + 'f'.repeat(64) + "' WHERE id=1");
  const third = await loadCatalog(db);
  assert.notStrictEqual(third, first);
  assert.equal(third.version, 2);
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    assert.equal(counts.get(table), 2, table);
  }
});

test('loadCatalog safely marks malformed catalog JSON without throwing', async () => {
  const db = createTestDb('malformed-catalog');
  db.exec("UPDATE journal_vocab SET constraints_json='{bad' WHERE code='attr.ph'");
  db.exec("UPDATE journal_catalog_state SET catalog_version=2, catalog_hash='" + 'e'.repeat(64) + "' WHERE id=1");

  const catalog = await loadCatalog(db);

  assert.deepEqual(catalog.vocabByCode.get('attr.ph').constraints, {});
  assert.deepEqual(catalog.vocabByCode.get('attr.ph').catalog_errors, ['constraints_json']);
});

test('loadCatalog supports the callback sqlite API used by Node-RED', async () => {
  const rawDb = createTestDb('callback-db');
  const callbackDb = {
    get(sql, _parameters, callback) {
      try { callback(null, rawDb.prepare(sql).get()); } catch (error) { callback(error); }
    },
    all(sql, _parameters, callback) {
      try { callback(null, rawDb.prepare(sql).all()); } catch (error) { callback(error); }
    },
  };

  const catalog = await loadCatalog(callbackDb);

  assert.equal(catalog.version, 3);
  assert.equal(catalog.vocabByCode.get('irrigation').kind, 'activity');
});

test('loadCatalog retries when catalog state changes during table reads', async () => {
  const rawDb = createTestDb('state-race');
  const counts = new Map();
  let changed = false;
  const db = {
    prepare(sql) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      counts.set(table, (counts.get(table) || 0) + 1);
      const statement = rawDb.prepare(sql);
      if (table === 'journal_products' && !changed) {
        changed = true;
        rawDb.exec(
          "UPDATE journal_catalog_state SET catalog_version=2, catalog_hash='" +
          'd'.repeat(64) + "' WHERE id=1"
        );
      }
      return statement;
    },
  };

  const catalog = await loadCatalog(db);

  assert.equal(catalog.version, 2);
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    assert.equal(counts.get(table), 2, table);
  }
});

test('loadCatalog de-duplicates concurrent table reads for the same state', async () => {
  const rawDb = createTestDb('concurrent-load');
  const counts = new Map();
  const db = {
    get(sql, _parameters, callback) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      counts.set(table, (counts.get(table) || 0) + 1);
      setTimeout(() => callback(null, rawDb.prepare(sql).get()), 2);
    },
    all(sql, _parameters, callback) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      counts.set(table, (counts.get(table) || 0) + 1);
      setTimeout(() => callback(null, rawDb.prepare(sql).all()), 2);
    },
  };

  const [first, second] = await Promise.all([loadCatalog(db), loadCatalog(db)]);

  assert.strictEqual(second, first);
  for (const table of ['journal_vocab', 'journal_templates', 'journal_layouts', 'journal_products']) {
    assert.equal(counts.get(table), 1, table);
  }
});

test('loadCatalog fails visibly after bounded catalog churn', async () => {
  const rawDb = createTestDb('catalog-churn');
  let version = 1;
  let productReads = 0;
  const db = {
    prepare(sql) {
      const table = (sql.match(/FROM\s+(\w+)/i) || [])[1] || 'other';
      const statement = rawDb.prepare(sql);
      if (table === 'journal_products') {
        productReads += 1;
        version += 1;
        rawDb.exec(
          'UPDATE journal_catalog_state SET catalog_version=' + version +
          ", catalog_hash='" + String(version).padStart(64, '0') + "' WHERE id=1"
        );
      }
      return statement;
    },
  };

  await assert.rejects(loadCatalog(db), /changed during load/);
  assert.equal(productReads, 3);
});

test('validateEntry rejects an unknown activity code', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('unknown-activity');
  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'unknown_activity' })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'activity_code' && error.code === 'unknown_code'));
});

test('validateEntry rejects a choice outside its attribute vocabulary', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('invalid-choice');
  const input = validIrrigation({
    values: [{
      attribute_code: 'attr.denominator',
      group_index: 0,
      value: 'choice.denominator.not_real',
      value_status: 'observed',
    }],
  });

  const result = validateEntry(catalog, openField, farmerQuick, input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'values[0].value' && error.code === 'invalid_choice'));
});

test('validateEntry enforces activity requirements from the template definition', async () => {
  const { catalog, fullRecord, openField } = await loadedFixture('template-required');
  const input = validIrrigation({
    activity_code: 'fertilization',
    template_code: 'full_record',
    values: [],
  });

  const result = validateEntry(catalog, openField, fullRecord, input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.treated_area' && error.code === 'required'));
  assert.ok(result.errors.some((error) =>
    error.field.includes('attr.product_uuid') && error.code === 'required'));
});

test('validateEntry enforces numeric min and max catalog constraints', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('numeric-range');
  const base = validIrrigation({
    activity_code: 'general_observation',
    values: [{
      attribute_code: 'attr.ph',
      group_index: 0,
      value: -0.1,
      unit_code: 'unit.ph',
      value_status: 'observed',
    }],
  });

  const below = validateEntry(catalog, openField, farmerQuick, base);
  const above = validateEntry(catalog, openField, farmerQuick, Object.assign({}, base, {
    values: [Object.assign({}, base.values[0], { value: 14.1 })],
  }));

  assert.equal(below.ok, false);
  assert.equal(above.ok, false);
  assert.ok(below.errors.some((error) => error.code === 'below_minimum'));
  assert.ok(above.errors.some((error) => error.code === 'above_maximum'));
});

test('validateEntry rejects notes longer than 4000 characters', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('note-limit');

  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ note: 'n'.repeat(4001) })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'note' && error.code === 'limit_exceeded'));
});

test('validateEntry rejects more than 32 distinct value groups', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('group-limit');
  const values = Array.from({ length: 33 }, (_, groupIndex) => ({
    attribute_code: 'attr.irrigation_depth',
    group_index: groupIndex,
    value: 1,
    unit_code: 'unit.mm_water',
    value_status: 'observed',
  }));

  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ values })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'values' && error.code === 'limit_exceeded'));
});

test('validateEntry normalizes a valid farmer_quick irrigation entry', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('valid-irrigation');
  const input = validIrrigation({
    values: [{
      attribute_code: 'attr.irrigation_depth',
      value: 12,
      unit_code: 'unit.mm_water',
    }],
  });

  const result = validateEntry(catalog, openField, farmerQuick, input);

  assert.equal(result.ok, true);
  assert.equal(result.normalized.activity_code, 'irrigation');
  assert.deepEqual(result.normalized.values, [{
    attribute_code: 'attr.irrigation_depth',
    group_index: 0,
    value: 12,
    value_num: 12,
    unit_code: 'unit.mm_water',
    entered_value_num: 12,
    entered_unit_code: 'unit.mm_water',
    value_status: 'observed',
  }]);
});

test('validateEntry enforces the pinned layout and template compatibility', async () => {
  const { catalog, farmerQuick } = await loadedFixture('compatibility');
  const agroscope = catalog.layouts.get('agroscope_open_field').get(1);
  const input = validIrrigation({
    activity_code: 'equipment_maintenance',
    layout_code: 'agroscope_open_field',
    values: [],
  });

  const result = validateEntry(catalog, agroscope, farmerQuick, input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'activity_code' && error.code === 'not_supported'));
  assert.ok(result.errors.some((error) =>
    error.field === 'template_code' && error.code === 'not_supported'));
});

test('validateEntry enforces catalog value types without coercion', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('value-types');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const cases = [
    ['attr.machine', 42],
    ['attr.recirculation', 'true'],
    ['attr.test_date', 20260712],
    ['attr.crop', 1],
  ];

  for (const [attributeCode, value] of cases) {
    const result = validateEntry(catalog, openField, farmerQuick, validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: attributeCode, group_index: 0, value }],
    }));
    assert.equal(result.ok, false, attributeCode);
    assert.ok(result.errors.some((error) => error.code === 'invalid_type'), attributeCode);
  }
});

test('validateEntry enforces catalog maxlength and step constraints', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('other-constraints');
  const longText = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    activity_code: 'general_observation',
    values: [{ attribute_code: 'attr.replicate', value: 'r'.repeat(81) }],
  }));
  const offStep = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    activity_code: 'general_observation',
    values: [{ attribute_code: 'attr.agroscope.combination_group', value: 1.5 }],
  }));

  assert.equal(longText.ok, false);
  assert.ok(longText.errors.some((error) => error.code === 'limit_exceeded'));
  assert.equal(offStep.ok, false);
  assert.ok(offStep.errors.some((error) => error.code === 'step_mismatch'));
});

test('validateEntry rejects duplicate attributes inside one group', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('duplicate-value');
  const duplicate = {
    attribute_code: 'attr.irrigation_depth',
    group_index: 0,
    value: 12,
    unit_code: 'unit.mm_water',
  };

  const result = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    values: [duplicate, Object.assign({}, duplicate, { value: 13 })],
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'duplicate_value'));
});

test('validateEntry evaluates deterministic required_if and visible_if predicates', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('predicates');
  const template = Object.assign({}, farmerQuick, {
    definition: {
      sections: [{
        code: 'conditional',
        fields: [
          {
            code: 'attr.target',
            required_if: { field: 'activity_code', op: 'eq', value: 'general_observation' },
          },
          {
            code: 'attr.method',
            visible_if: {
              field: 'attr.denominator',
              op: 'in',
              value: ['choice.denominator.row', 'choice.denominator.plant'],
            },
          },
        ],
      }],
    },
  });
  const input = validIrrigation({
    activity_code: 'general_observation',
    values: [
      { attribute_code: 'attr.denominator', value: 'choice.denominator.area' },
      { attribute_code: 'attr.method', value: 'hoe' },
    ],
  });

  const result = validateEntry(catalog, openField, template, input);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.target' && error.code === 'required'));
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.method' && error.code === 'not_visible'));
});

test('validateEntry enforces SEC-3 request, author, text, value, and context limits', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('sec-limits');
  catalog.vocabByCode.set('attr.test_unbounded_text', {
    code: 'attr.test_unbounded_text', kind: 'attribute', value_type: 'text', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const validate = (overrides) => validateEntry(
    catalog, openField, farmerQuick, validIrrigation(overrides)
  );
  const author = validate({ author_label: 'a'.repeat(121) });
  const textBytes = validate({
    values: [{ attribute_code: 'attr.test_unbounded_text', value: 'é'.repeat(2049) }],
  });
  const valueCount = validate({ values: Array.from({ length: 129 }, () => ({
    attribute_code: 'attr.irrigation_depth', value: 1,
  })) });
  const context = validate({ context: { sample: 'c'.repeat(64 * 1024) } });
  const request = validate({ padding: 'p'.repeat(256 * 1024) });

  for (const [result, field] of [
    [author, 'author_label'],
    [textBytes, 'values[0].value'],
    [valueCount, 'values'],
    [context, 'context'],
    [request, 'entry'],
  ]) {
    assert.equal(result.ok, false, field);
    assert.ok(result.errors.some((error) =>
      error.field === field && error.code === 'limit_exceeded'), field);
  }
});

test('validateEntry returns structured errors for non-JSON input and invalid catalog JSON', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('bad-json');
  const circular = validIrrigation();
  circular.self = circular;
  const circularResult = validateEntry(catalog, openField, farmerQuick, circular);
  const contextResult = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    context_json: '{not-json',
  }));
  const ph = catalog.vocabByCode.get('attr.ph');
  catalog.vocabByCode.set('attr.ph', Object.assign({}, ph, {
    constraints: {}, catalog_errors: ['constraints_json'],
  }));
  const catalogResult = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    activity_code: 'general_observation',
    values: [{ attribute_code: 'attr.ph', value: 7, unit_code: 'unit.ph' }],
  }));

  assert.equal(circularResult.ok, false);
  assert.ok(circularResult.errors.some((error) => error.code === 'invalid_json'));
  assert.equal(contextResult.ok, false);
  assert.ok(contextResult.errors.some((error) => error.field === 'context_json'));
  assert.equal(catalogResult.ok, false);
  assert.ok(catalogResult.errors.some((error) => error.code === 'invalid_catalog'));
});

test('validateEntry measures the raw context_json payload against 64 KiB', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('raw-context-limit');
  const result = validateEntry(catalog, openField, farmerQuick, validIrrigation({
    context_json: ' '.repeat(64 * 1024) + '{}',
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'context_json' && error.code === 'limit_exceeded'));
});

test('template field requirements recognize present top-level entry fields', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('top-level-required');
  const template = Object.assign({}, farmerQuick, {
    definition: {
      sections: [{ code: 'notes', fields: [{ code: 'note', required: true }] }],
    },
  });

  const result = validateEntry(catalog, openField, template, validIrrigation({ note: 'present' }));

  assert.equal(result.ok, true);
});

test('validateEntry applies deterministic field rules supplied by a layout', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('layout-rules');
  const layout = Object.assign({}, openField, {
    definition: Object.assign({}, openField.definition, {
      fields: [{
        code: 'attr.equipment',
        required_if: { field: 'activity_code', op: 'eq', value: 'irrigation' },
      }],
    }),
  });

  const result = validateEntry(catalog, layout, farmerQuick, validIrrigation());

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.equipment' && error.code === 'required'));
});

test('validateEntry enforces the seeded full_record irrigation conditional group', async () => {
  const { catalog, fullRecord, openField } = await loadedFixture('irrigation-group');
  const missing = validateEntry(catalog, openField, fullRecord, validIrrigation({
    template_code: 'full_record',
  }));
  const complete = validateEntry(catalog, openField, fullRecord, validIrrigation({
    template_code: 'full_record',
    values: [
      { attribute_code: 'attr.irrigation_amount_kind', value: 'choice.irrigation_amount.measured' },
      { attribute_code: 'attr.measurement_source', value: 'choice.measurement.manual' },
      { attribute_code: 'attr.denominator', value: 'choice.denominator.area' },
      { attribute_code: 'attr.irrigation_depth', value: 12, unit_code: 'unit.mm_water' },
    ],
  }));

  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.field === 'attr.irrigation_amount_kind'));
  assert.equal(complete.ok, true);
});

test('validateEntry rejects unsupported predicate operators as catalog errors', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('bad-predicate');
  const template = Object.assign({}, farmerQuick, {
    definition: {
      sections: [{ fields: [{
        code: 'attr.target',
        required_if: { field: 'activity_code', op: 'exec', value: 'irrigation' },
      }] }],
    },
  });

  const result = validateEntry(catalog, openField, template, validIrrigation());

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
});

test('validateEntry rejects mismatched pinned template and layout versions', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('mismatched-versions');
  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ template_version: 2, layout_version: 3 })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'layout_version' && error.code === 'definition_mismatch'));
  assert.ok(result.errors.some((error) =>
    error.field === 'template_version' && error.code === 'definition_mismatch'));
});

test('inactive definitions and terms fail create but exact correction rows remain valid', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('inactive-correction');
  const input = validIrrigation({
    template_version: 1,
    layout_version: 1,
    values: [
      {
        attribute_code: 'attr.irrigation_depth', group_index: 0, value: 12,
        unit_code: 'unit.mm_water', value_status: 'observed',
      },
      {
        attribute_code: 'attr.denominator', group_index: 0,
        value: 'choice.denominator.area', value_status: 'observed',
      },
    ],
  });
  for (const code of [
    'irrigation', 'attr.irrigation_depth', 'unit.mm_water', 'choice.denominator.area',
  ]) {
    catalog.vocabByCode.set(code, Object.assign({}, catalog.vocabByCode.get(code), { active: 0 }));
  }
  const inactiveTemplate = Object.assign({}, farmerQuick, { active: 0 });
  const inactiveLayout = Object.assign({}, openField, { active: 0 });
  const originalEntry = {
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    values: input.values.map((value) => ({
      attribute_code: value.attribute_code,
      group_index: value.group_index,
      value_num: typeof value.value === 'number' ? value.value : null,
      value_text: typeof value.value === 'string' ? value.value : null,
      value_status: value.value_status,
      unit_code: value.unit_code || null,
    })),
  };

  const create = validateEntry(catalog, inactiveLayout, inactiveTemplate, input);
  const definitionCreate = validateEntry(
    catalog,
    inactiveLayout,
    inactiveTemplate,
    validIrrigation({ activity_code: 'general_observation', values: [] })
  );
  const missingOriginal = validateEntry(
    catalog, inactiveLayout, inactiveTemplate, input, { mode: 'correction' }
  );
  const exactCorrection = validateEntry(
    catalog, inactiveLayout, inactiveTemplate, input,
    { mode: 'correction', originalEntry }
  );
  const changedCorrection = validateEntry(
    catalog,
    inactiveLayout,
    inactiveTemplate,
    Object.assign({}, input, {
      values: input.values.map((value, index) =>
        index === 0 ? Object.assign({}, value, { value: 13 }) : value),
    }),
    { mode: 'correction', originalEntry }
  );
  const changedPins = validateEntry(
    catalog,
    inactiveLayout,
    inactiveTemplate,
    Object.assign({}, input, { activity_code: 'general_observation' }),
    { mode: 'correction', originalEntry }
  );

  assert.equal(create.ok, false);
  assert.ok(create.errors.some((error) => error.code === 'inactive_term'));
  assert.equal(definitionCreate.ok, false);
  assert.ok(definitionCreate.errors.some((error) => error.code === 'inactive_definition'));
  assert.equal(missingOriginal.ok, false);
  assert.ok(missingOriginal.errors.some((error) => error.code === 'correction_context_required'));
  assert.equal(exactCorrection.ok, true);
  assert.equal(changedCorrection.ok, false);
  assert.ok(changedCorrection.errors.some((error) => error.code === 'inactive_value_changed'));
  assert.equal(changedPins.ok, false);
  assert.ok(changedPins.errors.some((error) => error.code === 'correction_pin_mismatch'));
});

test('inactive correction comparison decodes DB rows by attribute value type', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('inactive-db-types');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 0,
    constraints: {}, catalog_errors: [],
  });
  for (const code of ['attr.machine', 'attr.denominator', 'attr.recirculation']) {
    catalog.vocabByCode.set(code, Object.assign({}, catalog.vocabByCode.get(code), { active: 0 }));
  }
  const values = [
    { attribute_code: 'attr.machine', value: 'hoe' },
    { attribute_code: 'attr.denominator', value: 'choice.denominator.area' },
    { attribute_code: 'attr.test_date', value: '2026-07-12' },
    { attribute_code: 'attr.recirculation', value: true },
  ];
  const originalEntry = {
    activity_code: 'general_observation',
    template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1,
    values: [
      { attribute_code: 'attr.machine', group_index: 0, value_text: 'hoe', value_status: 'observed' },
      {
        attribute_code: 'attr.denominator', group_index: 0,
        value_text: 'choice.denominator.area', value_status: 'observed',
      },
      {
        attribute_code: 'attr.test_date', group_index: 0,
        value_text: '2026-07-12', value_status: 'observed',
      },
      {
        attribute_code: 'attr.recirculation', group_index: 0,
        value_num: 1, value_status: 'observed',
      },
    ],
  };

  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values }),
    { mode: 'correction', originalEntry }
  );

  assert.equal(result.ok, true, JSON.stringify(result));
});

test('inactive correction preserves canonical and entered numeric audit fields bidirectionally', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('inactive-audit-fields');
  for (const code of ['attr.amount_mass_area_product', 'unit.t_per_ha_product']) {
    catalog.vocabByCode.set(code, Object.assign({}, catalog.vocabByCode.get(code), { active: 0 }));
  }
  const normalizedValue = {
    attribute_code: 'attr.amount_mass_area_product', group_index: 0,
    value: 1000, value_num: 1000, unit_code: 'unit.kg_per_ha_product',
    entered_value_num: 1, entered_unit_code: 'unit.t_per_ha_product',
    value_status: 'observed',
  };
  const originalEntry = {
    activity_code: 'general_observation',
    template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1,
    values: [{
      attribute_code: 'attr.amount_mass_area_product', group_index: 0,
      value_num: 1000, value_text: null, unit_code: 'unit.kg_per_ha_product',
      entered_value_num: 1, entered_unit_code: 'unit.t_per_ha_product',
      value_status: 'observed',
    }],
  };
  const validateValues = (values) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values }),
    { mode: 'correction', originalEntry }
  );

  const exact = validateValues([normalizedValue]);
  const auditMutation = validateValues([
    Object.assign({}, normalizedValue, {
      entered_value_num: 999,
      entered_unit_code: 'unit.g_per_ha_product',
    }),
  ]);
  const omission = validateValues([]);

  assert.equal(exact.ok, true, JSON.stringify(exact));
  assert.deepEqual(exact.normalized.values[0], normalizedValue);
  assert.equal(auditMutation.ok, false);
  assert.ok(auditMutation.errors.some((error) => error.code === 'inactive_value_changed'));
  assert.equal(omission.ok, false);
  assert.ok(omission.errors.some((error) => error.code === 'inactive_value_omitted'));

  catalog.vocabByCode.set(
    'attr.amount_mass_area_product',
    Object.assign({}, catalog.vocabByCode.get('attr.amount_mass_area_product'), { active: 1 })
  );
  const createWithRetiredEnteredUnit = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [normalizedValue] })
  );
  assert.equal(createWithRetiredEnteredUnit.ok, false);
  assert.ok(createWithRetiredEnteredUnit.errors.some((error) =>
    error.field === 'values[0].entered_unit_code' && error.code === 'inactive_term'));
});

test('value rows reject contradictory generic and typed representations', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('typed-value-shapes');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const validateValue = (value) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [value] })
  );
  const contradictoryRows = [
    { attribute_code: 'attr.ph', value: 7, value_num: 8 },
    { attribute_code: 'attr.recirculation', value: true, value_num: 0 },
    { attribute_code: 'attr.machine', value: 'hoe', value_text: 'tractor' },
    {
      attribute_code: 'attr.denominator',
      value: 'choice.denominator.area', value_text: 'choice.denominator.plant',
    },
    { attribute_code: 'attr.test_date', value: '2026-07-12', value_text: '2026-07-13' },
    { attribute_code: 'attr.ph', value: 7, value_text: '7' },
    { attribute_code: 'attr.machine', value: 'hoe', value_num: 1 },
    {
      attribute_code: 'attr.machine', value_status: 'not_observed',
      value_text: 'hidden observation',
    },
    {
      attribute_code: 'attr.machine', value_status: 'not_applicable',
      value: 'hidden generic value',
    },
  ];

  for (const row of contradictoryRows) {
    const result = validateValue(row);
    assert.equal(result.ok, false, JSON.stringify(row));
    assert.ok(
      result.errors.some((error) => error.code === 'invalid_value_shape'),
      JSON.stringify(row)
    );
  }

  for (const row of [
    {
      attribute_code: 'attr.ph', value: 7, value_num: 7,
      entered_value_num: 7, entered_unit_code: 'unit.ph', unit_code: 'unit.ph',
    },
    { attribute_code: 'attr.recirculation', value: true, value_num: 1 },
    { attribute_code: 'attr.machine', value: 'hoe', value_text: 'hoe' },
    {
      attribute_code: 'attr.denominator',
      value: 'choice.denominator.area', value_text: 'choice.denominator.area',
    },
    {
      attribute_code: 'attr.test_date',
      value: '2026-07-12', value_text: '2026-07-12',
    },
  ]) {
    const result = validateValue(row);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.normalized.values[0].value, row.value);
  }
});

test('date attributes accept only real YYYY-MM-DD calendar dates', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('strict-dates');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const validateDate = (value) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: 'attr.test_date', value }],
    })
  );

  assert.equal(validateDate('2024-02-29').ok, true);
  for (const value of ['2023-02-29', '2026-02-30', '03/04/2026', '2026-1-1', '2026-01-01T00:00:00Z']) {
    const result = validateDate(value);
    assert.equal(result.ok, false, value);
    assert.ok(result.errors.some((error) => error.code === 'invalid_date'), value);
  }
});

test('reference constraints resolve products and fail closed for external tables', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('references');
  const productUuid = catalog.products.keys().next().value;
  const validateValue = (attributeCode, value, validationContext) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: attributeCode, value }],
    }),
    validationContext
  );

  assert.equal(validateValue('attr.product_uuid', productUuid).ok, true);
  const missingProduct = validateValue('attr.product_uuid', 'missing-product');
  assert.equal(missingProduct.ok, false);
  assert.ok(missingProduct.errors.some((error) => error.code === 'invalid_reference'));

  const unresolvedActuation = validateValue('attr.actuation_expectation_id', 'expectation-1');
  assert.equal(unresolvedActuation.ok, false);
  assert.ok(unresolvedActuation.errors.some((error) => error.code === 'reference_unresolved'));

  const mapResolved = validateValue(
    'attr.actuation_expectation_id',
    'expectation-1',
    {
      referenceValues: new Map([
        ['valve_actuation_expectations.expectation_id', new Set(['expectation-1'])],
      ]),
    }
  );
  const objectResolved = validateValue(
    'attr.actuation_expectation_id',
    'expectation-2',
    {
      referenceValues: {
        'valve_actuation_expectations.expectation_id': ['expectation-2'],
      },
    }
  );
  assert.equal(mapResolved.ok, true);
  assert.equal(objectResolved.ok, true);

  const product = catalog.products.get(productUuid);
  catalog.products.set(productUuid, Object.assign({}, product, { active: 0 }));
  assert.equal(validateValue('attr.product_uuid', productUuid).ok, false);
});

test('correction preserves retired product and external reference rows exactly', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('retired-references');
  const productUuids = Array.from(catalog.products.keys());
  const retiredProductUuid = productUuids[0];
  const replacementProductUuid = productUuids[1];
  catalog.products.set(
    retiredProductUuid,
    Object.assign({}, catalog.products.get(retiredProductUuid), {
      active: 0,
      deleted_at: '2026-07-12T12:00:00.000Z',
    })
  );
  const baseOriginal = {
    activity_code: 'general_observation',
    template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1,
  };
  const validateCorrection = (originalEntry, values, referenceValues) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values }),
    { mode: 'correction', originalEntry, referenceValues }
  );
  const productOriginal = Object.assign({}, baseOriginal, {
    values: [{
      attribute_code: 'attr.product_uuid', group_index: 0,
      value_text: retiredProductUuid, value_status: 'observed',
    }],
  });
  const productValue = {
    attribute_code: 'attr.product_uuid', group_index: 0,
    value: retiredProductUuid, value_status: 'observed',
  };

  const exactProduct = validateCorrection(productOriginal, [productValue]);
  const omittedProduct = validateCorrection(productOriginal, []);
  const changedProduct = validateCorrection(productOriginal, [
    Object.assign({}, productValue, { value: replacementProductUuid }),
  ]);

  assert.equal(exactProduct.ok, true, JSON.stringify(exactProduct));
  assert.equal(omittedProduct.ok, false);
  assert.ok(omittedProduct.errors.some((error) => error.code === 'inactive_value_omitted'));
  assert.equal(changedProduct.ok, false);

  const referenceKey = 'valve_actuation_expectations.expectation_id';
  const referenceOriginal = Object.assign({}, baseOriginal, {
    values: [{
      attribute_code: 'attr.actuation_expectation_id', group_index: 0,
      value_text: 'retired-expectation', value_status: 'observed',
    }],
  });
  const referenceValue = {
    attribute_code: 'attr.actuation_expectation_id', group_index: 0,
    value: 'retired-expectation', value_status: 'observed',
  };
  const emptyReferenceSet = new Map([[referenceKey, new Set()]]);

  const exactReference = validateCorrection(
    referenceOriginal,
    [referenceValue],
    emptyReferenceSet
  );
  const omittedReference = validateCorrection(referenceOriginal, [], emptyReferenceSet);
  const changedReference = validateCorrection(
    referenceOriginal,
    [Object.assign({}, referenceValue, { value: 'new-dangling-expectation' })],
    emptyReferenceSet
  );

  assert.equal(exactReference.ok, true, JSON.stringify(exactReference));
  assert.equal(omittedReference.ok, false);
  assert.ok(omittedReference.errors.some((error) => error.code === 'inactive_value_omitted'));
  assert.equal(changedReference.ok, false);
});

test('reverse correction preservation keeps context and catalog error provenance distinct', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('preservation-provenance');
  const originalBase = {
    activity_code: 'general_observation',
    template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1,
  };
  const validateOmission = (originalEntry, referenceValues) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [] }),
    { mode: 'correction', originalEntry, referenceValues }
  );
  const referenceKey = 'valve_actuation_expectations.expectation_id';
  const referenceOriginal = Object.assign({}, originalBase, {
    values: [{
      attribute_code: 'attr.actuation_expectation_id', group_index: 0,
      value_text: 'expectation-1', value_status: 'observed',
    }],
  });

  const malformedContext = validateOmission(referenceOriginal, {
    [referenceKey]: 'not-a-set-or-array',
  });

  assert.equal(malformedContext.ok, false);
  assert.ok(malformedContext.errors.some((error) => error.code === 'invalid_context'));
  assert.ok(!malformedContext.errors.some((error) => error.code === 'invalid_catalog'));

  const missingVocabOriginal = Object.assign({}, originalBase, {
    values: [{
      attribute_code: 'attr.machine', group_index: 0,
      value_text: 'hoe', value_status: 'observed',
    }],
  });
  catalog.vocabByCode.delete('attr.machine');
  const missingCatalog = validateOmission(missingVocabOriginal);

  assert.equal(missingCatalog.ok, false);
  assert.ok(missingCatalog.errors.some((error) => error.code === 'invalid_catalog'));
});

test('required_any families pair semantically present product and dose in each repeat group', async () => {
  const { catalog, fullRecord, openField } = await loadedFixture('required-groups');
  const treatedArea = {
    attribute_code: 'attr.treated_area', group_index: 0, value: 100,
    unit_code: 'unit.m2_area',
  };
  const product = { attribute_code: 'attr.product', group_index: 0, value: 'NPK 15-15-15' };
  const dose = {
    attribute_code: 'attr.amount_mass_area_product', group_index: 0, value: 25,
    unit_code: 'unit.kg_per_ha_product',
  };
  const validateValues = (values) => validateEntry(
    catalog,
    openField,
    fullRecord,
    validIrrigation({
      activity_code: 'fertilization', template_code: 'full_record', values,
    })
  );

  const paired = validateValues([treatedArea, product, dose]);
  const crossGroup = validateValues([
    treatedArea,
    product,
    Object.assign({}, dose, { group_index: 1 }),
  ]);
  const blankProduct = validateValues([
    treatedArea,
    Object.assign({}, product, { value: '   ' }),
    dose,
  ]);
  const nonObservedProduct = validateValues([
    treatedArea,
    { attribute_code: 'attr.product', group_index: 0, value_status: 'not_observed' },
    dose,
  ]);

  assert.equal(paired.ok, true);
  assert.equal(crossGroup.ok, false);
  assert.ok(crossGroup.errors.some((error) => error.code === 'required_in_group'));
  assert.equal(blankProduct.ok, false);
  assert.equal(nonObservedProduct.ok, false);
});

test('malformed nested definitions and unknown rule references fail without throwing', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('malformed-definitions');
  const templateCases = [
    { sections: {} },
    { sections: [{ fields: {} }] },
    { activity_requirements: [] },
    { activity_requirements: { irrigation: { required: {}, required_any: [] } } },
    { activity_requirements: { irrigation: { required: [], required_any: ['attr.product'] } } },
    { conditional_groups: {} },
    { conditional_groups: [{ activity_codes: {}, required: [], required_any: [] }] },
    { sections: [{ fields: [{ code: 'attr.typo', required: true }] }] },
    { sections: [{ fields: [{
      code: 'attr.target',
      required_if: { field: 'attr.typo', op: 'eq', value: 'x' },
    }] }] },
  ];
  const layoutCases = [
    Object.assign({}, openField.definition, { supported_templates: {} }),
    Object.assign({}, openField.definition, { activity_codes: {} }),
    Object.assign({}, openField.definition, { fields: {} }),
  ];

  for (const definition of templateCases) {
    let result;
    assert.doesNotThrow(() => {
      result = validateEntry(
        catalog,
        openField,
        Object.assign({}, farmerQuick, { definition }),
        validIrrigation()
      );
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }
  for (const definition of layoutCases) {
    let result;
    assert.doesNotThrow(() => {
      result = validateEntry(
        catalog,
        Object.assign({}, openField, { definition }),
        farmerQuick,
        validIrrigation()
      );
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }
});

test('definition preflight rejects unknown predicate values in finite code domains', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('predicate-code-domains');
  const predicates = [
    { field: 'attr.denominator', op: 'eq', value: 'choice.denominator.typo' },
    {
      field: 'attr.denominator', op: 'in',
      value: ['choice.denominator.area', 'choice.denominator.typo'],
    },
    { field: 'activity_code', op: 'eq', value: 'irrigtion_typo' },
    { field: 'template_code', op: 'eq', value: 'farmer_quik' },
    { field: 'layout_code', op: 'eq', value: 'open_feld' },
  ];

  for (const predicate of predicates) {
    const template = Object.assign({}, farmerQuick, {
      definition: {
        sections: [{
          fields: [{ code: 'attr.target', required_if: predicate }],
        }],
      },
    });
    const result = validateEntry(catalog, openField, template, validIrrigation());
    assert.equal(result.ok, false, JSON.stringify(predicate));
    assert.ok(
      result.errors.some((error) => error.code === 'invalid_catalog'),
      JSON.stringify(predicate)
    );
  }
});

test('definition preflight type-checks scalar predicate domains and leaves text open', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('predicate-scalar-domains');
  catalog.vocabByCode.set('attr.test_date', {
    code: 'attr.test_date', kind: 'attribute', value_type: 'date', active: 1,
    constraints: {}, catalog_errors: [],
  });
  const resultFor = (predicate) => validateEntry(
    catalog,
    openField,
    Object.assign({}, farmerQuick, {
      definition: {
        sections: [{ fields: [{ code: 'attr.target', required_if: predicate }] }],
      },
    }),
    validIrrigation()
  );
  const invalidPredicates = [
    { field: 'attr.recirculation', op: 'eq', value: 'true' },
    { field: 'attr.ph', op: 'eq', value: '7' },
    { field: 'attr.ph', op: 'in', value: [7, '8'] },
    { field: 'attr.test_date', op: 'eq', value: 20260712 },
    { field: 'attr.test_date', op: 'in', value: ['2024-02-29', '2023-02-29'] },
    { field: 'attr.machine', op: 'eq', value: 42 },
  ];

  for (const predicate of invalidPredicates) {
    const result = resultFor(predicate);
    assert.equal(result.ok, false, JSON.stringify(predicate));
    assert.ok(
      result.errors.some((error) => error.code === 'invalid_catalog'),
      JSON.stringify(predicate)
    );
  }

  for (const predicate of [
    { field: 'attr.recirculation', op: 'eq', value: true },
    { field: 'attr.ph', op: 'eq', value: 7 },
    { field: 'attr.test_date', op: 'eq', value: '2024-02-29' },
    { field: 'attr.machine', op: 'eq', value: 'farmer-defined mower' },
  ]) {
    assert.equal(resultFor(predicate).ok, true, JSON.stringify(predicate));
  }
});

function syntheticUnit(code, quantityKind, basis, dimension, canonicalCode, scale, offset) {
  return {
    code,
    kind: 'unit',
    value_type: null,
    quantity_kind: quantityKind,
    basis,
    active: 1,
    deleted_at: null,
    constraints: {
      dimension,
      to_canonical: { unit_code: canonicalCode, scale, offset },
    },
    catalog_errors: [],
  };
}

function syntheticNumberAttribute(code, quantityKind, basis, defaultUnitCode, constraints) {
  return {
    code,
    kind: 'attribute',
    value_type: 'number',
    quantity_kind: quantityKind,
    basis,
    default_unit_code: defaultUnitCode,
    active: 1,
    deleted_at: null,
    constraints: constraints || {},
    catalog_errors: [],
  };
}

test('usableUnitPath requires an active self-canonical target in the same family', () => {
  const identity = syntheticUnit(
    'unit.test_identity', 'test_quantity', 'test_basis', 'test_dimension',
    'unit.test_identity', 1, 0
  );
  const derived = syntheticUnit(
    'unit.test_derived', 'test_quantity', 'test_basis', 'test_dimension',
    identity.code, 10, 0
  );
  const terms = new Map([[identity.code, identity], [derived.code, derived]]);
  const usable = usableUnitPath(terms, derived.code);
  assert.equal(usable.ok, true);
  assert.equal(usable.target.code, identity.code);

  identity.active = 0;
  assert.deepEqual(usableUnitPath(terms, derived.code), { ok: false, code: 'inactive_unit' });
  identity.active = 1;
  identity.constraints.dimension = 'wrong_dimension';
  assert.deepEqual(usableUnitPath(terms, derived.code), { ok: false, code: 'invalid_catalog' });
  terms.delete(identity.code);
  assert.deepEqual(usableUnitPath(terms, derived.code), { ok: false, code: 'invalid_catalog' });
});

test('convertToCanonical scales product t/ha to canonical kg/ha', async () => {
  const { catalog } = await loadedFixture('unit-scale-product');

  assert.deepEqual(
    convertToCanonical(
      catalog,
      'attr.amount_mass_area_product',
      1.25,
      'unit.t_per_ha_product'
    ),
    { ok: true, value_num: 1250, unit_code: 'unit.kg_per_ha_product' }
  );
});

test('convertToCanonical rejects cross-basis before generic incompatibility', async () => {
  const { catalog } = await loadedFixture('unit-cross-basis');

  assert.deepEqual(
    convertToCanonical(
      catalog,
      'attr.amount_nutrient_rate',
      20,
      'unit.kg_per_ha_product'
    ),
    { ok: false, code: 'cross_basis_forbidden' }
  );
  const wrongDimension = convertToCanonical(
    catalog,
    'attr.amount_operation_depth',
    5,
    'unit.l_per_ha_product'
  );
  assert.equal(wrongDimension.ok, false);
});

test('convertToCanonical applies scale and offset and rejects nonfinite input or result', async () => {
  const { catalog } = await loadedFixture('unit-offset');
  catalog.vocabByCode.set(
    'attr.air_temperature',
    syntheticNumberAttribute(
      'attr.air_temperature', 'temperature', 'air', 'unit.k_air', {}
    )
  );
  catalog.vocabByCode.set(
    'unit.k_air',
    syntheticUnit('unit.k_air', 'temperature', 'air', 'temperature_air', 'unit.k_air', 1, 0)
  );
  catalog.vocabByCode.set(
    'unit.c_air',
    syntheticUnit('unit.c_air', 'temperature', 'air', 'temperature_air', 'unit.k_air', 1, 273.15)
  );
  catalog.vocabByCode.set(
    'unit.overflow_air',
    syntheticUnit(
      'unit.overflow_air', 'temperature', 'air', 'temperature_air', 'unit.k_air', 2, 0
    )
  );

  assert.deepEqual(
    convertToCanonical(catalog, 'attr.air_temperature', 20, 'unit.c_air'),
    { ok: true, value_num: 293.15, unit_code: 'unit.k_air' }
  );
  assert.deepEqual(
    convertToCanonical(catalog, 'attr.air_temperature', Infinity, 'unit.c_air'),
    { ok: false, code: 'invalid_number' }
  );
  assert.deepEqual(
    convertToCanonical(catalog, 'attr.air_temperature', Number.MAX_VALUE, 'unit.overflow_air'),
    { ok: false, code: 'invalid_number' }
  );
});

test('convertToCanonical fails closed for unknown, inactive, and malformed unit definitions', async () => {
  const { catalog } = await loadedFixture('unit-fail-closed');
  const attributeCode = 'attr.amount_mass_area_product';

  assert.deepEqual(
    convertToCanonical(catalog, attributeCode, 1, 'unit.not_real'),
    { ok: false, code: 'unknown_unit' }
  );

  const tonne = catalog.vocabByCode.get('unit.t_per_ha_product');
  catalog.vocabByCode.set(tonne.code, Object.assign({}, tonne, { active: 0 }));
  assert.deepEqual(
    convertToCanonical(catalog, attributeCode, 1, tonne.code),
    { ok: false, code: 'inactive_unit' }
  );
  catalog.vocabByCode.set(tonne.code, tonne);

  const malformedCases = [
    { constraints: {} },
    { constraints: { dimension: 'mass_product_per_area', to_canonical: null } },
    {
      constraints: {
        dimension: 'mass_product_per_area',
        to_canonical: {
          unit_code: 'unit.kg_per_ha_product', scale: '1000', offset: 0,
        },
      },
    },
  ];
  for (const replacement of malformedCases) {
    catalog.vocabByCode.set(tonne.code, Object.assign({}, tonne, replacement));
    assert.deepEqual(
      convertToCanonical(catalog, attributeCode, 1, tonne.code),
      { ok: false, code: 'invalid_catalog' }
    );
  }
  catalog.vocabByCode.set(tonne.code, tonne);

  const kilogram = catalog.vocabByCode.get('unit.kg_per_ha_product');
  catalog.vocabByCode.set(kilogram.code, Object.assign({}, kilogram, { active: 0 }));
  assert.deepEqual(
    convertToCanonical(catalog, attributeCode, 1, tonne.code),
    { ok: false, code: 'inactive_unit' }
  );

  catalog.vocabByCode.set(kilogram.code, Object.assign({}, kilogram, {
    constraints: Object.assign({}, kilogram.constraints, {
      to_canonical: {
        unit_code: kilogram.code,
        scale: 2,
        offset: 0,
      },
    }),
  }));
  assert.deepEqual(
    convertToCanonical(catalog, attributeCode, 1, tonne.code),
    { ok: false, code: 'invalid_catalog' }
  );

  catalog.vocabByCode.delete(kilogram.code);
  assert.deepEqual(
    convertToCanonical(catalog, attributeCode, 1, tonne.code),
    { ok: false, code: 'invalid_catalog' }
  );
});

test('allowedUnits returns only the deterministic active quantity-kind/basis family', async () => {
  const { catalog, openField } = await loadedFixture('allowed-unit-family');
  catalog.vocabByCode.set(
    'unit.fake_mass_other_dimension',
    syntheticUnit(
      'unit.fake_mass_other_dimension',
      'mass_area',
      'product',
      'mass_product_per_row',
      'unit.fake_mass_other_dimension',
      1,
      0
    )
  );

  assert.deepEqual(
    allowedUnits(
      catalog,
      'attr.amount_mass_area_product',
      openField.definition,
      new Map()
    ),
    [
      'unit.g_per_ha_product',
      'unit.kg_per_ha_product',
      'unit.t_per_ha_product',
    ]
  );

  const nutrientUnits = allowedUnits(
    catalog,
    'attr.amount_nutrient_rate',
    openField.definition,
    {}
  );
  assert.equal(nutrientUnits.length, 10);
  assert.ok(nutrientUnits.includes('unit.kg_n_per_ha_nutrient'));
  assert.ok(nutrientUnits.includes('unit.kg_p2o5_per_ha_nutrient'));
  for (const code of nutrientUnits) {
    const unit = catalog.vocabByCode.get(code);
    assert.equal(unit.constraints.to_canonical.unit_code, code);
  }
});

test('validateEntry stores entered numeric values beside canonical values', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('unit-normalization');
  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{
        attribute_code: 'attr.amount_mass_area_product',
        value: 1.25,
        unit_code: 'unit.t_per_ha_product',
      }],
    })
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.normalized.values[0], {
    attribute_code: 'attr.amount_mass_area_product',
    group_index: 0,
    value: 1250,
    value_num: 1250,
    unit_code: 'unit.kg_per_ha_product',
    entered_value_num: 1.25,
    entered_unit_code: 'unit.t_per_ha_product',
    value_status: 'observed',
  });
});

test('validateEntry verifies an existing canonical/entered audit row and rejects contradictions', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('unit-audit-shape');
  const validateValue = (value) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [value] })
  );
  const consistent = {
    attribute_code: 'attr.amount_mass_area_product',
    value: 1250,
    value_num: 1250,
    unit_code: 'unit.kg_per_ha_product',
    entered_value_num: 1.25,
    entered_unit_code: 'unit.t_per_ha_product',
  };

  const result = validateValue(consistent);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.normalized.values[0].value_num, 1250);
  assert.equal(result.normalized.values[0].entered_value_num, 1.25);

  for (const contradictory of [
    Object.assign({}, consistent, { value: 1200, value_num: 1200 }),
    Object.assign({}, consistent, { unit_code: 'unit.t_per_ha_product' }),
    {
      attribute_code: consistent.attribute_code,
      value: 1250,
      value_num: 1250,
      unit_code: 'unit.kg_per_ha_product',
      entered_value_num: 1.25,
    },
  ]) {
    const invalid = validateValue(contradictory);
    assert.equal(invalid.ok, false, JSON.stringify(contradictory));
    assert.ok(invalid.errors.some((error) => error.code === 'invalid_value_shape'));
  }
});

test('validateEntry applies defaults only when allowed and never defaults a nutrient species', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('unit-defaults');
  const validateValue = (value) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [value] })
  );

  const defaulted = validateValue({ attribute_code: 'attr.ph', value: 7 });
  assert.equal(defaulted.ok, true, JSON.stringify(defaulted));
  assert.equal(defaulted.normalized.values[0].unit_code, 'unit.ph');
  assert.equal(defaulted.normalized.values[0].entered_unit_code, 'unit.ph');

  const nutrient = validateValue({ attribute_code: 'attr.amount_nutrient_rate', value: 20 });
  assert.equal(nutrient.ok, false);
  assert.ok(nutrient.errors.some((error) => error.code === 'unit_required'));

  const massAttribute = catalog.vocabByCode.get('attr.amount_mass_area_product');
  catalog.vocabByCode.set(massAttribute.code, Object.assign({}, massAttribute, {
    constraints: Object.assign({}, massAttribute.constraints, { allow_default_unit: false }),
  }));
  const noDefault = validateValue({ attribute_code: massAttribute.code, value: 20 });
  assert.equal(noDefault.ok, false);
  assert.ok(noDefault.errors.some((error) => error.code === 'unit_required'));

  const phAttribute = catalog.vocabByCode.get('attr.ph');
  catalog.vocabByCode.set(phAttribute.code, Object.assign({}, phAttribute, {
    constraints: Object.assign({}, phAttribute.constraints, { requires_explicit_unit: true }),
  }));
  const explicitRequired = validateValue({ attribute_code: phAttribute.code, value: 7 });
  assert.equal(explicitRequired.ok, false);
  assert.ok(explicitRequired.errors.some((error) => error.code === 'unit_required'));
});

test('validateEntry enforces numeric min/max/step after canonical conversion', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('canonical-constraints');
  const attribute = catalog.vocabByCode.get('attr.amount_mass_area_product');
  const validateTonnes = (value) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{
        attribute_code: attribute.code,
        value,
        unit_code: 'unit.t_per_ha_product',
      }],
    })
  );

  catalog.vocabByCode.set(attribute.code, Object.assign({}, attribute, {
    constraints: { min: 0, max: 999 },
  }));
  const above = validateTonnes(1);
  assert.equal(above.ok, false);
  assert.ok(above.errors.some((error) => error.code === 'above_maximum'));

  catalog.vocabByCode.set(attribute.code, Object.assign({}, attribute, {
    constraints: { min: 0, step: 500 },
  }));
  assert.equal(validateTonnes(1.5).ok, true);
  const offStep = validateTonnes(1.2);
  assert.equal(offStep.ok, false);
  assert.ok(offStep.errors.some((error) => error.code === 'step_mismatch'));
});

test('validateEntry leaves nonnumeric and non-observed value semantics unchanged', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('unit-nonnumeric');
  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [
        { attribute_code: 'attr.machine', value: 'hoe' },
        { attribute_code: 'attr.ph', group_index: 1, value_status: 'not_observed' },
      ],
    })
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.normalized.values, [
    {
      attribute_code: 'attr.machine', value: 'hoe', group_index: 0,
      value_status: 'observed',
    },
    { attribute_code: 'attr.ph', group_index: 1, value_status: 'not_observed' },
  ]);
});

test('unit scales must be finite and strictly positive across every public path', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('unit-positive-scale');
  const attributeCode = 'attr.amount_mass_area_product';
  const tonne = catalog.vocabByCode.get('unit.t_per_ha_product');
  const validate = () => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: attributeCode, value: 1, unit_code: tonne.code }],
    })
  );

  for (const scale of [0, -1, Infinity]) {
    catalog.vocabByCode.set(tonne.code, Object.assign({}, tonne, {
      constraints: Object.assign({}, tonne.constraints, {
        to_canonical: Object.assign({}, tonne.constraints.to_canonical, { scale }),
      }),
    }));
    assert.deepEqual(
      convertToCanonical(catalog, attributeCode, 1, tonne.code),
      { ok: false, code: 'invalid_catalog' }
    );
    assert.ok(!allowedUnits(catalog, attributeCode, openField.definition, {}).includes(tonne.code));
    const result = validate();
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }
});

test('malformed unit facts beat cross-basis classification', async () => {
  const { catalog } = await loadedFixture('unit-malformed-precedence');
  const productUnit = catalog.vocabByCode.get('unit.kg_per_ha_product');
  catalog.vocabByCode.set(productUnit.code, Object.assign({}, productUnit, {
    constraints: Object.assign({}, productUnit.constraints, {
      to_canonical: Object.assign({}, productUnit.constraints.to_canonical, { scale: 'bad' }),
    }),
  }));

  assert.deepEqual(
    convertToCanonical(catalog, 'attr.amount_nutrient_rate', 20, productUnit.code),
    { ok: false, code: 'invalid_catalog' }
  );
});

test('direct unit APIs reject inactive or deleted numeric attributes', async () => {
  const { catalog, openField } = await loadedFixture('inactive-attribute-api');
  const code = 'attr.amount_mass_area_product';
  const attribute = catalog.vocabByCode.get(code);

  for (const mutation of [{ active: 0 }, { deleted_at: '2026-07-12T12:00:00.000Z' }]) {
    catalog.vocabByCode.set(code, Object.assign({}, attribute, mutation));
    assert.deepEqual(
      convertToCanonical(catalog, code, 1, 'unit.t_per_ha_product'),
      { ok: false, code: 'inactive_attribute' }
    );
    assert.deepEqual(allowedUnits(catalog, code, openField.definition, {}), []);
  }
});

test('numeric catalog constraint preflight is shared by conversion, lookup, and validation', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('numeric-preflight');
  const code = 'attr.amount_mass_area_product';
  const attribute = catalog.vocabByCode.get(code);
  const malformedConstraints = [
    Object.assign({}, attribute.constraints, { min: '0' }),
    Object.assign({}, attribute.constraints, { min: Infinity }),
    Object.assign({}, attribute.constraints, { max: null }),
    Object.assign({}, attribute.constraints, { min: 2, max: 1 }),
    Object.assign({}, attribute.constraints, { step: 0 }),
    Object.assign({}, attribute.constraints, { step: -1 }),
    Object.assign({}, attribute.constraints, { step: '1' }),
    Object.assign({}, attribute.constraints, { requires_explicit_unit: 'yes' }),
    Object.assign({}, attribute.constraints, { allow_default_unit: 0 }),
  ];
  const validate = () => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: code, value: 1, unit_code: 'unit.kg_per_ha_product' }],
    })
  );

  for (const constraints of malformedConstraints) {
    catalog.vocabByCode.set(code, Object.assign({}, attribute, { constraints }));
    assert.deepEqual(
      convertToCanonical(catalog, code, 1, 'unit.kg_per_ha_product'),
      { ok: false, code: 'invalid_catalog' },
      JSON.stringify(constraints)
    );
    assert.deepEqual(
      allowedUnits(catalog, code, openField.definition, {}),
      [],
      JSON.stringify(constraints)
    );
    const result = validate();
    assert.equal(result.ok, false, JSON.stringify(constraints));
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }

  for (const constraints of [
    { requires_explicit_unit: true, allow_default_unit: false },
    {
      requires_explicit_unit: false,
      allow_default_unit: false,
      semantic_discriminator: 'unit_code',
    },
    {
      requires_explicit_unit: true,
      allow_default_unit: true,
      semantic_discriminator: 'unit_code',
    },
    {
      requires_explicit_unit: true,
      allow_default_unit: false,
      semantic_discriminator: 'nutrient',
    },
  ]) {
    catalog.vocabByCode.set(code, Object.assign({}, attribute, {
      default_unit_code: null,
      constraints,
    }));
    assert.deepEqual(
      convertToCanonical(catalog, code, 1, 'unit.kg_per_ha_product'),
      { ok: false, code: 'invalid_catalog' },
      JSON.stringify(constraints)
    );
    assert.deepEqual(allowedUnits(catalog, code, openField.definition, {}), []);
    const result = validate();
    assert.equal(result.ok, false, JSON.stringify(constraints));
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }
});

test('observed nonnumeric rows reject every quantity and unit audit field', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('nonnumeric-audit-matrix');
  const validate = (row) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [row] })
  );
  const cases = [
    { attribute_code: 'attr.machine', value: 'hoe', unit_code: 'unit.kg_mass' },
    {
      attribute_code: 'attr.machine', value: 'hoe',
      entered_value_num: 1, entered_unit_code: 'unit.kg_mass',
    },
    { attribute_code: 'attr.machine', value: 'hoe', entered_unit_code: 'unit.kg_mass' },
  ];

  for (const row of cases) {
    const result = validate(row);
    assert.equal(result.ok, false, JSON.stringify(row));
    assert.ok(result.errors.some((error) => error.code === 'invalid_value_shape'));
  }
});

test('non-observed rows reject all values and entered numeric audit values', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('missing-value-matrix');
  const validate = (row) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [row] })
  );
  const cases = [
    { attribute_code: 'attr.ph', value_status: 'not_observed', value: 7 },
    { attribute_code: 'attr.ph', value_status: 'not_applicable', value_num: 7 },
    {
      attribute_code: 'attr.ph', value_status: 'below_detection',
      entered_value_num: 7, entered_unit_code: 'unit.ph',
    },
    { attribute_code: 'attr.machine', value_status: 'not_observed', value_text: 'hoe' },
  ];

  for (const row of cases) {
    const result = validate(row);
    assert.equal(result.ok, false, JSON.stringify(row));
    assert.ok(result.errors.some((error) => error.code === 'invalid_value_shape'));
  }
});

test('numeric unit-only missingness normalizes an unambiguous compatible unit pair', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('missing-unit-pairs');
  const validate = (row) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [row] })
  );
  const missing = (extra) => Object.assign({
    attribute_code: 'attr.amount_mass_area_product',
    value_status: 'not_observed',
  }, extra || {});

  const neither = validate(missing());
  assert.equal(neither.ok, true, JSON.stringify(neither));
  assert.deepEqual(neither.normalized.values[0], missing({ group_index: 0 }));
  assert.ok(!Object.prototype.hasOwnProperty.call(neither.normalized.values[0], 'value'));
  assert.ok(!Object.prototype.hasOwnProperty.call(neither.normalized.values[0], 'value_num'));

  const enteredOnly = validate(missing({ entered_unit_code: 'unit.t_per_ha_product' }));
  assert.equal(enteredOnly.ok, true, JSON.stringify(enteredOnly));
  assert.equal(enteredOnly.normalized.values[0].unit_code, 'unit.kg_per_ha_product');
  assert.equal(enteredOnly.normalized.values[0].entered_unit_code, 'unit.t_per_ha_product');

  const canonicalOnly = validate(missing({ unit_code: 'unit.kg_per_ha_product' }));
  assert.equal(canonicalOnly.ok, true, JSON.stringify(canonicalOnly));
  assert.equal(canonicalOnly.normalized.values[0].unit_code, 'unit.kg_per_ha_product');
  assert.ok(!Object.prototype.hasOwnProperty.call(
    canonicalOnly.normalized.values[0], 'entered_unit_code'
  ));

  const both = validate(missing({
    unit_code: 'unit.kg_per_ha_product',
    entered_unit_code: 'unit.t_per_ha_product',
  }));
  assert.equal(both.ok, true, JSON.stringify(both));

  for (const row of [
    missing({ unit_code: 'unit.t_per_ha_product' }),
    missing({
      unit_code: 'unit.t_per_ha_product',
      entered_unit_code: 'unit.t_per_ha_product',
    }),
  ]) {
    const result = validate(row);
    assert.equal(result.ok, false, JSON.stringify(row));
    assert.ok(result.errors.some((error) => error.code === 'invalid_value_shape'));
  }

  const crossBasis = validate(Object.assign(missing({
    entered_unit_code: 'unit.kg_per_ha_product',
  }), { attribute_code: 'attr.amount_nutrient_rate' }));
  assert.equal(crossBasis.ok, false);
  assert.ok(crossBasis.errors.some((error) => error.code === 'cross_basis_forbidden'));

  const incompatible = validate({
    attribute_code: 'attr.irrigation_volume_area',
    value_status: 'not_observed',
    entered_unit_code: 'unit.mm_water',
  });
  assert.equal(incompatible.ok, false);
  assert.ok(incompatible.errors.some((error) => error.code === 'unit_incompatible'));

  const unidentifiedNutrient = validate({
    attribute_code: 'attr.amount_nutrient_rate', value_status: 'not_observed',
  });
  assert.equal(unidentifiedNutrient.ok, false);
  assert.ok(unidentifiedNutrient.errors.some((error) => error.code === 'unit_required'));

  const massAttribute = catalog.vocabByCode.get('attr.amount_mass_area_product');
  catalog.vocabByCode.set(massAttribute.code, Object.assign({}, massAttribute, {
    constraints: Object.assign({}, massAttribute.constraints, { requires_explicit_unit: true }),
  }));
  const explicitMissingUnit = validate(missing());
  assert.equal(explicitMissingUnit.ok, false);
  assert.ok(explicitMissingUnit.errors.some((error) => error.code === 'unit_required'));
});

test('large-magnitude step checks use ULP-scale tolerance', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('step-ulp');
  const code = 'attr.amount_mass_area_product';
  const attribute = catalog.vocabByCode.get(code);
  catalog.vocabByCode.set(code, Object.assign({}, attribute, {
    constraints: { min: 0, step: 1 },
  }));
  const validate = (value) => validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: code, value, unit_code: 'unit.kg_per_ha_product' }],
    })
  );

  assert.equal(validate(1e12).ok, true);
  const fractional = validate(1e12 + 0.25);
  assert.equal(fractional.ok, false);
  assert.ok(fractional.errors.some((error) => error.code === 'step_mismatch'));
});

test('exact retired numeric correction bypass rejects corrupt unit metadata', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('retired-corrupt-unit');
  const attributeCode = 'attr.amount_mass_area_product';
  const enteredUnitCode = 'unit.t_per_ha_product';
  catalog.vocabByCode.set(attributeCode, Object.assign(
    {}, catalog.vocabByCode.get(attributeCode), { active: 0 }
  ));
  const enteredUnit = catalog.vocabByCode.get(enteredUnitCode);
  catalog.vocabByCode.set(enteredUnitCode, Object.assign({}, enteredUnit, {
    active: 0,
    constraints: Object.assign({}, enteredUnit.constraints, {
      to_canonical: Object.assign({}, enteredUnit.constraints.to_canonical, { scale: 0 }),
    }),
  }));
  const value = {
    attribute_code: attributeCode, group_index: 0,
    value: 1000, value_num: 1000, unit_code: 'unit.kg_per_ha_product',
    entered_value_num: 1, entered_unit_code: enteredUnitCode,
    value_status: 'observed',
  };
  const originalEntry = {
    activity_code: 'general_observation',
    template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1,
    values: [{
      attribute_code: attributeCode, group_index: 0,
      value_num: 1000, unit_code: 'unit.kg_per_ha_product',
      entered_value_num: 1, entered_unit_code: enteredUnitCode,
      value_status: 'observed',
    }],
  };

  const result = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({ activity_code: 'general_observation', values: [value] }),
    { mode: 'correction', originalEntry }
  );

  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
});

test('a numeric attribute default must itself be the canonical unit row', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('noncanonical-default');
  const code = 'attr.amount_mass_area_product';
  const attribute = catalog.vocabByCode.get(code);
  catalog.vocabByCode.set(code, Object.assign({}, attribute, {
    default_unit_code: 'unit.t_per_ha_product',
  }));

  assert.deepEqual(
    numericAttributePreflight(catalog, code),
    { ok: false, code: 'invalid_catalog' }
  );
  assert.deepEqual(allowedUnits(catalog, code, openField.definition, {}), []);
  assert.deepEqual(
    convertToCanonical(catalog, code, 1, 'unit.t_per_ha_product'),
    { ok: false, code: 'invalid_catalog' }
  );
  const missing = validateEntry(
    catalog,
    openField,
    farmerQuick,
    validIrrigation({
      activity_code: 'general_observation',
      values: [{ attribute_code: code, value_status: 'not_observed' }],
    })
  );
  assert.equal(missing.ok, false, JSON.stringify(missing));
  assert.ok(missing.errors.some((error) => error.code === 'invalid_catalog'));
});

test('a frozen canonical slot must remain self-canonical even without an entered unit', async () => {
  const runCorrection = async (name, unitCode) => {
    const { catalog, farmerQuick, openField } = await loadedFixture(name);
    const unit = catalog.vocabByCode.get(unitCode);
    catalog.vocabByCode.set(unitCode, Object.assign({}, unit, { active: 0 }));
    const value = {
      attribute_code: 'attr.amount_mass_area_product', group_index: 0,
      value: 1000, value_num: 1000, unit_code: unitCode,
      value_status: 'observed',
    };
    const originalEntry = {
      activity_code: 'general_observation',
      template_code: 'farmer_quick', template_version: 1,
      layout_code: 'open_field', layout_version: 1,
      values: [{
        attribute_code: value.attribute_code, group_index: 0,
        value_num: 1000, unit_code: unitCode, value_status: 'observed',
      }],
    };
    return validateEntry(
      catalog,
      openField,
      farmerQuick,
      validIrrigation({ activity_code: 'general_observation', values: [value] }),
      { mode: 'correction', originalEntry }
    );
  };

  const noncanonical = await runCorrection(
    'frozen-noncanonical-slot', 'unit.t_per_ha_product'
  );
  assert.equal(noncanonical.ok, false, JSON.stringify(noncanonical));
  assert.ok(noncanonical.errors.some((error) => error.code === 'invalid_value_shape'));

  const legitimate = await runCorrection(
    'frozen-canonical-slot', 'unit.kg_per_ha_product'
  );
  assert.equal(legitimate.ok, true, JSON.stringify(legitimate));
  assert.equal(legitimate.normalized.values[0].unit_code, 'unit.kg_per_ha_product');
  assert.ok(!Object.prototype.hasOwnProperty.call(
    legitimate.normalized.values[0], 'entered_unit_code'
  ));
});

function cascadeApi() {
  return require('./cascade');
}

function agroscopeFixture(catalog) {
  return {
    layout: catalog.layouts.get('agroscope_open_field').get(1),
    template: catalog.templates.get('research_observation').get(1),
  };
}

function selected(attributeCode, value, extra) {
  return Object.assign({ attribute_code: attributeCode, value }, extra || {});
}

test('resolveOptions follows the seeded activity to operation to device cascade', async () => {
  const { resolveOptions } = cascadeApi();
  const { catalog } = await loadedFixture('cascade-seeded-choices');
  const { layout } = agroscopeFixture(catalog);
  const options = resolveOptions(layout.definition, {
    activity_code: 'fertilization',
    'attr.agroscope.operation': 'agroscope.operation.mineral_fertilization',
  });

  assert.deepEqual(options['attr.agroscope.operation'].choices, [
    'agroscope.operation.organic_fertilization',
    'agroscope.operation.mineral_fertilization',
    'agroscope.operation.other_fertilization',
  ]);
  assert.deepEqual(options['attr.agroscope.device'].choices, [
    'agroscope.device.solid_broadcast',
    'agroscope.device.solid_band',
    'agroscope.device.solid_undersown_placement',
    'agroscope.device.liquid_injection',
    'agroscope.device.liquid_spraying',
    'agroscope.device.liquid_fertigation',
  ]);
});

test('resolveOptions exposes exactly the ten seeded solid-broadcast nutrient units', async () => {
  const { resolveOptions } = cascadeApi();
  const { catalog } = await loadedFixture('cascade-seeded-units');
  const { layout } = agroscopeFixture(catalog);
  const options = resolveOptions(layout.definition, {
    activity_code: 'fertilization',
    'attr.agroscope.operation': 'agroscope.operation.mineral_fertilization',
    'attr.agroscope.device': 'agroscope.device.solid_broadcast',
  });

  assert.deepEqual(options['attr.amount_nutrient_rate'].units, [
    'unit.kg_n_per_ha_nutrient',
    'unit.kg_p2o5_per_ha_nutrient',
    'unit.kg_k2o_per_ha_nutrient',
    'unit.kg_mg_per_ha_nutrient',
    'unit.kg_s_per_ha_nutrient',
    'unit.kg_ca_per_ha_nutrient',
    'unit.kg_b_per_ha_nutrient',
    'unit.kg_na_per_ha_nutrient',
    'unit.kg_mn_per_ha_nutrient',
    'unit.kg_cao_per_ha_nutrient',
  ]);
});

test('validateSelections rejects every invalid repeated dependent choice precisely', async () => {
  const { validateSelections } = cascadeApi();
  const { catalog } = await loadedFixture('cascade-invalid-repeated-choice');
  const { layout } = agroscopeFixture(catalog);
  const result = validateSelections(layout.definition, [
    selected('activity_code', 'fertilization'),
    selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'),
    selected('attr.agroscope.device', 'agroscope.device.solid_broadcast', { group_index: 0 }),
    selected('attr.agroscope.device', 'agroscope.device.plough', { group_index: 1 }),
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{
    field: 'values[3].value',
    code: 'invalid_under_dependency',
  }]);
});

test('no device unit rule means optional omission, never unrestricted amount acceptance', async () => {
  const { validateSelections } = cascadeApi();
  const { catalog } = await loadedFixture('cascade-empty-leaf');
  const { layout, template } = agroscopeFixture(catalog);
  const baseValues = [
    selected('attr.agroscope.operation', 'agroscope.operation.harvest_main_crop'),
    selected('attr.agroscope.device', 'agroscope.device.combine_harvester'),
  ];
  const selectionValues = [selected('activity_code', 'harvest'), ...baseValues];

  assert.deepEqual(validateSelections(layout.definition, selectionValues), { ok: true });
  const invalidAmount = validateSelections(layout.definition, [
    ...selectionValues,
    selected('attr.amount_mass_area_product', 20, {
      unit_code: 'unit.kg_per_ha_product',
    }),
  ]);
  assert.equal(invalidAmount.ok, false);
  assert.deepEqual(invalidAmount.errors, [{
    field: 'values[3].unit_code',
    code: 'invalid_under_dependency',
  }]);

  const omitted = validateEntry(catalog, layout, template, validIrrigation({
    activity_code: 'harvest',
    template_code: 'research_observation',
    layout_code: 'agroscope_open_field',
    values: baseValues,
  }));
  assert.equal(omitted.ok, true, JSON.stringify(omitted));
  const submittedAmount = validateEntry(catalog, layout, template, validIrrigation({
    activity_code: 'harvest',
    template_code: 'research_observation',
    layout_code: 'agroscope_open_field',
    values: [
      ...baseValues,
      selected('attr.amount_mass_area_product', 20, {
        unit_code: 'unit.kg_per_ha_product',
      }),
    ],
  }));
  assert.equal(submittedAmount.ok, false);
  assert.ok(submittedAmount.errors.some((error) =>
    error.field === 'values[2].entered_unit_code' &&
    error.code === 'invalid_under_dependency'));
});

test('validateEntry enforces choice and entered-unit dependencies after normalization', async () => {
  const { catalog } = await loadedFixture('cascade-entry-wiring');
  const { layout, template } = agroscopeFixture(catalog);
  const entry = (values) => validIrrigation({
    activity_code: 'fertilization',
    template_code: 'research_observation',
    layout_code: 'agroscope_open_field',
    values,
  });
  const validOrganic = validateEntry(catalog, layout, template, entry([
    selected('attr.agroscope.operation', 'agroscope.operation.organic_fertilization'),
    selected('attr.agroscope.device', 'agroscope.device.manure_broadcast'),
    selected('attr.amount_mass_area_product', 1, {
      unit_code: 'unit.t_per_ha_product',
    }),
  ]));
  assert.equal(validOrganic.ok, true, JSON.stringify(validOrganic));
  assert.equal(validOrganic.normalized.values[2].unit_code, 'unit.kg_per_ha_product');
  assert.equal(validOrganic.normalized.values[2].entered_unit_code, 'unit.t_per_ha_product');

  const wrongDevice = validateEntry(catalog, layout, template, entry([
    selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'),
    selected('attr.agroscope.device', 'agroscope.device.plough'),
  ]));
  assert.equal(wrongDevice.ok, false);
  assert.ok(wrongDevice.errors.some((error) =>
    error.field === 'values[1].value' && error.code === 'invalid_under_dependency'));
});

test('allowedUnits intersects valid restrictions and fails closed on bad dependency units', async () => {
  const { catalog, openField } = await loadedFixture('cascade-allowed-units');
  const { layout } = agroscopeFixture(catalog);
  const selections = {
    activity_code: 'fertilization',
    'attr.agroscope.operation': 'agroscope.operation.mineral_fertilization',
    'attr.agroscope.device': 'agroscope.device.solid_broadcast',
  };
  const seeded = allowedUnits(
    catalog, 'attr.amount_nutrient_rate', layout.definition, selections
  );
  assert.equal(seeded.length, 10);
  assert.deepEqual(
    allowedUnits(catalog, 'attr.amount_nutrient_rate', layout.definition, {
      activity_code: 'harvest',
      'attr.agroscope.operation': 'agroscope.operation.harvest_main_crop',
      'attr.agroscope.device': 'agroscope.device.combine_harvester',
    }),
    []
  );
  assert.equal(
    allowedUnits(catalog, 'attr.amount_nutrient_rate', openField.definition, {}).length,
    10
  );

  const inactiveCode = 'unit.kg_n_per_ha_nutrient';
  catalog.vocabByCode.set(inactiveCode, Object.assign(
    {}, catalog.vocabByCode.get(inactiveCode), { active: 0 }
  ));
  const widenedDefinition = Object.assign({}, layout.definition, {
    option_dependencies: layout.definition.option_dependencies.map((rule) => {
      if (rule.when.equals !== 'agroscope.device.solid_broadcast') return rule;
      return Object.assign({}, rule, {
        restrict: Object.assign({}, rule.restrict, {
          units: [...rule.restrict.units, 'unit.kg_per_ha_product'],
        }),
      });
    }),
  });
  const narrowed = allowedUnits(
    catalog, 'attr.amount_nutrient_rate', widenedDefinition, selections
  );
  assert.deepEqual(narrowed, []);
});

test('dependency structure fails closed while allowing top-level source metadata', async () => {
  const { resolveOptions, validateSelections } = cascadeApi();
  const validRule = {
    source_category: 'irrigation',
    when: { attribute_code: 'activity_code', equals: 'irrigation' },
    restrict: {
      attribute_code: 'attr.agroscope.operation',
      choices: ['agroscope.operation.watering'],
    },
  };
  const malformedDefinitions = [
    { option_dependencies: {} },
    { option_dependencies: [null] },
    { option_dependencies: [{ restrict: validRule.restrict }] },
    { option_dependencies: [{ when: validRule.when }] },
    { option_dependencies: [{
      when: { attribute_code: '', equals: 'irrigation' }, restrict: validRule.restrict,
    }] },
    { option_dependencies: [{
      when: validRule.when,
      restrict: { attribute_code: 'attr.agroscope.operation' },
    }] },
    { option_dependencies: [{
      when: validRule.when,
      restrict: { attribute_code: 'attr.agroscope.operation', choices: [], units: ['unit.ph'] },
    }] },
    { option_dependencies: [{
      when: validRule.when,
      restrict: { attribute_code: 'attr.agroscope.operation', choices: [] },
    }] },
    { option_dependencies: [{
      when: validRule.when,
      restrict: {
        attribute_code: 'attr.agroscope.operation', choices: ['x', 'x'],
      },
    }] },
    { option_dependencies: [validRule, Object.assign({}, validRule, {
      restrict: Object.assign({}, validRule.restrict, {
        choices: ['agroscope.operation.note'],
      }),
    })] },
    { option_dependencies: [Object.assign({}, validRule, { unexpected_behavior: true })] },
    { option_dependencies: [Object.assign({}, validRule, { source_category: 42 })] },
    { option_dependencies: [Object.assign({}, validRule, { source_category: '   ' })] },
  ];

  for (const definition of malformedDefinitions) {
    const validated = validateSelections(definition, []);
    assert.equal(validated.ok, false, JSON.stringify(definition));
    assert.ok(validated.errors.some((error) => error.code === 'invalid_catalog'));
    const resolved = resolveOptions(definition, {});
    assert.equal(resolved.ok, false, JSON.stringify(definition));
    assert.ok(resolved.errors.some((error) => error.code === 'invalid_catalog'));
  }
  assert.deepEqual(
    resolveOptions({ option_dependencies: [validRule] }, { activity_code: 'irrigation' }),
    { 'attr.agroscope.operation': { choices: ['agroscope.operation.watering'], units: [] } }
  );
});

test('validateEntry catalog-preflights every dependency reference and target type', async () => {
  const { catalog, farmerQuick, openField } = await loadedFixture('cascade-catalog-preflight');
  const validWhen = { attribute_code: 'activity_code', equals: 'irrigation' };
  const validChoiceRestrict = {
    attribute_code: 'attr.agroscope.operation',
    choices: ['agroscope.operation.watering'],
  };
  const invalidRules = [
    { when: { attribute_code: 'attr.not_real', equals: 'x' }, restrict: validChoiceRestrict },
    { when: { attribute_code: 'activity_code', equals: 'not_an_activity' }, restrict: validChoiceRestrict },
    {
      when: { attribute_code: 'attr.agroscope.operation', equals: 'choice.denominator.area' },
      restrict: validChoiceRestrict,
    },
    { when: validWhen, restrict: { attribute_code: 'attr.not_real', choices: ['x'] } },
    { when: validWhen, restrict: {
      attribute_code: 'attr.agroscope.operation', choices: ['choice.denominator.area'],
    } },
    { when: validWhen, restrict: {
      attribute_code: 'attr.amount_nutrient_rate', choices: ['agroscope.operation.watering'],
    } },
    { when: validWhen, restrict: {
      attribute_code: 'attr.amount_nutrient_rate', units: ['unit.not_real'],
    } },
    { when: validWhen, restrict: {
      attribute_code: 'attr.agroscope.operation', units: ['unit.ph'],
    } },
  ];

  for (const rule of invalidRules) {
    const layout = Object.assign({}, openField, {
      definition: Object.assign({}, openField.definition, { option_dependencies: [rule] }),
    });
    const result = validateEntry(catalog, layout, farmerQuick, validIrrigation());
    assert.equal(result.ok, false, JSON.stringify(rule));
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }

  const metadataLayout = Object.assign({}, openField, {
    definition: Object.assign({}, openField.definition, {
      option_dependencies: [{
        source_category: 'irrigation',
        when: validWhen,
        restrict: validChoiceRestrict,
      }],
    }),
  });
  assert.equal(
    validateEntry(catalog, metadataLayout, farmerQuick, validIrrigation()).ok,
    true
  );
});

test('exact retired dependency selections remain valid on the unchanged pinned path', async () => {
  const { catalog } = await loadedFixture('cascade-retired-correction');
  const { layout, template } = agroscopeFixture(catalog);
  const deviceCode = 'agroscope.device.solid_broadcast';
  catalog.vocabByCode.set(deviceCode, Object.assign(
    {}, catalog.vocabByCode.get(deviceCode), { active: 0 }
  ));
  const values = [
    selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'),
    selected('attr.agroscope.device', deviceCode),
  ];
  const originalEntry = {
    activity_code: 'fertilization',
    template_code: 'research_observation', template_version: 1,
    layout_code: 'agroscope_open_field', layout_version: 1,
    values: values.map((value) => ({
      attribute_code: value.attribute_code,
      group_index: 0,
      value_text: value.value,
      value_status: 'observed',
    })),
  };
  const result = validateEntry(
    catalog,
    layout,
    template,
    validIrrigation({
      activity_code: 'fertilization',
      template_code: 'research_observation',
      template_version: 1,
      layout_code: 'agroscope_open_field',
      layout_version: 1,
      values,
    }),
    { mode: 'correction', originalEntry }
  );

  assert.equal(result.ok, true, JSON.stringify(result));
});

test('a preserved retired choice cannot bypass a changed active dependency path', async () => {
  const { catalog } = await loadedFixture('cascade-retired-path-change');
  const { layout, template } = agroscopeFixture(catalog);
  const deviceCode = 'agroscope.device.solid_broadcast';
  catalog.vocabByCode.set(deviceCode, Object.assign(
    {}, catalog.vocabByCode.get(deviceCode), { active: 0 }
  ));
  const originalEntry = {
    activity_code: 'fertilization',
    template_code: 'research_observation', template_version: 1,
    layout_code: 'agroscope_open_field', layout_version: 1,
    values: [
      {
        attribute_code: 'attr.agroscope.operation', group_index: 0,
        value_text: 'agroscope.operation.mineral_fertilization', value_status: 'observed',
      },
      {
        attribute_code: 'attr.agroscope.device', group_index: 0,
        value_text: deviceCode, value_status: 'observed',
      },
    ],
  };
  const input = (operation, note) => validIrrigation({
    activity_code: 'fertilization',
    template_code: 'research_observation', template_version: 1,
    layout_code: 'agroscope_open_field', layout_version: 1,
    note,
    values: [
      selected('attr.agroscope.operation', operation),
      selected('attr.agroscope.device', deviceCode),
    ],
  });
  const correction = (operation, note) => validateEntry(
    catalog,
    layout,
    template,
    input(operation, note),
    { mode: 'correction', originalEntry }
  );

  const noteOnly = correction('agroscope.operation.mineral_fertilization', 'corrected note');
  assert.equal(noteOnly.ok, true, JSON.stringify(noteOnly));

  const changedPath = correction('agroscope.operation.organic_fertilization', 'changed path');
  assert.equal(changedPath.ok, false, JSON.stringify(changedPath));
  assert.ok(changedPath.errors.some((error) =>
    error.field === 'values[1].value' && error.code === 'invalid_under_dependency'));
});

test('dependency catalog preflight requires an active compatible Task-4 unit family', async () => {
  const { dependencyCatalogErrors } = cascadeApi();
  const { catalog } = await loadedFixture('cascade-unit-family-preflight');
  const { layout, template } = agroscopeFixture(catalog);
  const entry = validIrrigation({
    activity_code: 'fertilization',
    template_code: 'research_observation',
    layout_code: 'agroscope_open_field',
    values: [
      selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'),
      selected('attr.agroscope.device', 'agroscope.device.solid_broadcast'),
    ],
  });
  const expectInvalidDefinition = (definition, label) => {
    const direct = dependencyCatalogErrors(catalog, definition);
    assert.ok(
      direct.some((error) => error.code === 'invalid_catalog'),
      label + ': ' + JSON.stringify(direct)
    );
    const result = validateEntry(
      catalog,
      Object.assign({}, layout, { definition }),
      template,
      entry
    );
    assert.equal(result.ok, false, label + ': ' + JSON.stringify(result));
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'), label);
  };
  const widenSolidBroadcast = (unitCode) => Object.assign({}, layout.definition, {
    option_dependencies: layout.definition.option_dependencies.map((rule) => {
      if (rule.when.equals !== 'agroscope.device.solid_broadcast') return rule;
      return Object.assign({}, rule, {
        restrict: Object.assign({}, rule.restrict, {
          units: [...rule.restrict.units, unitCode],
        }),
      });
    }),
  });

  expectInvalidDefinition(
    widenSolidBroadcast('unit.kg_per_ha_product'),
    'incompatible quantity/basis family'
  );

  const nutrientUnitCode = 'unit.kg_n_per_ha_nutrient';
  const nutrientUnit = catalog.vocabByCode.get(nutrientUnitCode);
  for (const [label, mutation] of [
    ['inactive unit', { active: 0 }],
    ['deleted unit', { deleted_at: '2026-07-12T12:00:00.000Z' }],
    ['malformed unit metadata', {
      constraints: Object.assign({}, nutrientUnit.constraints, {
        to_canonical: Object.assign({}, nutrientUnit.constraints.to_canonical, { scale: 0 }),
      }),
    }],
  ]) {
    catalog.vocabByCode.set(nutrientUnitCode, Object.assign({}, nutrientUnit, mutation));
    expectInvalidDefinition(layout.definition, label);
    catalog.vocabByCode.set(nutrientUnitCode, nutrientUnit);
  }

  const nutrientAttributeCode = 'attr.amount_nutrient_rate';
  const nutrientAttribute = catalog.vocabByCode.get(nutrientAttributeCode);
  for (const [label, mutation] of [
    ['malformed target quantity metadata', { quantity_kind: null }],
    ['malformed target constraints', { constraints: {} }],
  ]) {
    catalog.vocabByCode.set(
      nutrientAttributeCode,
      Object.assign({}, nutrientAttribute, mutation)
    );
    expectInvalidDefinition(layout.definition, label);
    catalog.vocabByCode.set(nutrientAttributeCode, nutrientAttribute);
  }
});

test('cascade choice selectors are singleton while numeric dependency targets may repeat', async () => {
  const { validateSelections } = cascadeApi();
  const { catalog } = await loadedFixture('cascade-singleton-selectors');
  const { layout, template } = agroscopeFixture(catalog);
  const flattened = [
    selected('activity_code', 'fertilization'),
    selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization', {
      group_index: 0,
    }),
    selected('attr.agroscope.operation', 'agroscope.operation.organic_fertilization', {
      group_index: 1,
    }),
    selected('attr.agroscope.device', 'agroscope.device.solid_broadcast', {
      group_index: 1,
    }),
  ];

  const direct = validateSelections(layout.definition, flattened);
  assert.equal(direct.ok, false, JSON.stringify(direct));
  assert.deepEqual(direct.errors, [{
    field: 'values[2].value', code: 'invalid_under_dependency',
  }]);

  const invalidEntry = validateEntry(catalog, layout, template, validIrrigation({
    activity_code: 'fertilization',
    template_code: 'research_observation',
    layout_code: 'agroscope_open_field',
    values: flattened.slice(1),
  }));
  assert.equal(invalidEntry.ok, false, JSON.stringify(invalidEntry));
  assert.ok(invalidEntry.errors.some((error) =>
    error.field === 'values[1].value' && error.code === 'invalid_under_dependency'));

  const sameGroupEntry = validateEntry(catalog, layout, template, validIrrigation({
    activity_code: 'fertilization',
    template_code: 'research_observation',
    layout_code: 'agroscope_open_field',
    values: [
      selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'),
      selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'),
    ],
  }));
  assert.equal(sameGroupEntry.ok, false, JSON.stringify(sameGroupEntry));
  assert.ok(sameGroupEntry.errors.some((error) =>
    error.field === 'values[1].attribute_code' && error.code === 'duplicate_value'));

  const repeatedDevice = validateSelections(layout.definition, [
    selected('activity_code', 'fertilization'),
    selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'),
    selected('attr.agroscope.device', 'agroscope.device.solid_broadcast', { group_index: 0 }),
    selected('attr.agroscope.device', 'agroscope.device.solid_broadcast', { group_index: 1 }),
  ]);
  assert.equal(repeatedDevice.ok, false, JSON.stringify(repeatedDevice));
  assert.deepEqual(repeatedDevice.errors, [{
    field: 'values[3].value', code: 'invalid_under_dependency',
  }]);

  const repeatedAmounts = [
    selected('attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'),
    selected('attr.agroscope.device', 'agroscope.device.solid_broadcast'),
    selected('attr.amount_nutrient_rate', 80, {
      group_index: 0, unit_code: 'unit.kg_n_per_ha_nutrient',
    }),
    selected('attr.amount_nutrient_rate', 30, {
      group_index: 1, unit_code: 'unit.kg_p2o5_per_ha_nutrient',
    }),
  ];
  assert.deepEqual(validateSelections(layout.definition, [
    selected('activity_code', 'fertilization'), ...repeatedAmounts,
  ]), { ok: true });
  const validEntry = validateEntry(catalog, layout, template, validIrrigation({
    activity_code: 'fertilization',
    template_code: 'research_observation',
    layout_code: 'agroscope_open_field',
    values: repeatedAmounts,
  }));
  assert.equal(validEntry.ok, true, JSON.stringify(validEntry));
});

test('cascade definitions reject self-edges and choice dependency cycles', async () => {
  const { resolveOptions, validateSelections } = cascadeApi();
  const { catalog, farmerQuick, openField } = await loadedFixture('cascade-cycle-preflight');
  const anchor = {
    when: { attribute_code: 'activity_code', equals: 'irrigation' },
    restrict: {
      attribute_code: 'attr.agroscope.operation',
      choices: ['agroscope.operation.watering'],
    },
  };
  const operationToDevice = {
    when: {
      attribute_code: 'attr.agroscope.operation', equals: 'agroscope.operation.watering',
    },
    restrict: {
      attribute_code: 'attr.agroscope.device',
      choices: ['agroscope.device.sprinkler_irrigation'],
    },
  };
  const deviceToOperation = {
    when: {
      attribute_code: 'attr.agroscope.device', equals: 'agroscope.device.sprinkler_irrigation',
    },
    restrict: {
      attribute_code: 'attr.agroscope.operation',
      choices: ['agroscope.operation.watering'],
    },
  };
  const selfEdge = {
    when: {
      attribute_code: 'attr.agroscope.operation', equals: 'agroscope.operation.watering',
    },
    restrict: {
      attribute_code: 'attr.agroscope.operation',
      choices: ['agroscope.operation.watering'],
    },
  };
  const definitions = [
    Object.assign({}, openField.definition, {
      option_dependencies: [anchor, operationToDevice, deviceToOperation],
    }),
    Object.assign({}, openField.definition, {
      option_dependencies: [anchor, selfEdge],
    }),
  ];

  for (const definition of definitions) {
    const resolved = resolveOptions(definition, {
      activity_code: 'irrigation',
      'attr.agroscope.operation': 'agroscope.operation.watering',
      'attr.agroscope.device': 'agroscope.device.sprinkler_irrigation',
    });
    assert.equal(resolved.ok, false, JSON.stringify(resolved));
    assert.ok(resolved.errors.some((error) => error.code === 'invalid_catalog'));
    const direct = validateSelections(definition, []);
    assert.equal(direct.ok, false, JSON.stringify(direct));
    assert.ok(direct.errors.some((error) => error.code === 'invalid_catalog'));
    const result = validateEntry(
      catalog,
      Object.assign({}, openField, { definition }),
      farmerQuick,
      validIrrigation()
    );
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.ok(result.errors.some((error) => error.code === 'invalid_catalog'));
  }
});

test('package main re-exports the public cascade APIs', () => {
  const packageApi = require('./index');
  const directApi = cascadeApi();

  assert.equal(typeof packageApi.resolveOptions, 'function');
  assert.equal(typeof packageApi.validateSelections, 'function');
  assert.strictEqual(packageApi.resolveOptions, directApi.resolveOptions);
  assert.strictEqual(packageApi.validateSelections, directApi.validateSelections);
});

test('note-only correction preserves exact retired numeric cascade rows', async () => {
  const { catalog } = await loadedFixture('cascade-retired-numeric-correction');
  const { layout, template } = agroscopeFixture(catalog);
  const attributeCode = 'attr.amount_nutrient_rate';
  const unitCode = 'unit.kg_n_per_ha_nutrient';
  const operationValue = selected(
    'attr.agroscope.operation', 'agroscope.operation.mineral_fertilization'
  );
  const deviceValue = selected(
    'attr.agroscope.device', 'agroscope.device.solid_broadcast'
  );
  const numericValue = {
    attribute_code: attributeCode, group_index: 0,
    value: 80, value_num: 80, unit_code: unitCode,
    entered_value_num: 80, entered_unit_code: unitCode,
    value_status: 'observed',
  };
  const originalEntry = {
    activity_code: 'fertilization',
    template_code: 'research_observation', template_version: 1,
    layout_code: 'agroscope_open_field', layout_version: 1,
    values: [
      {
        attribute_code: operationValue.attribute_code, group_index: 0,
        value_text: operationValue.value, value_status: 'observed',
      },
      {
        attribute_code: deviceValue.attribute_code, group_index: 0,
        value_text: deviceValue.value, value_status: 'observed',
      },
      {
        attribute_code: attributeCode, group_index: 0,
        value_num: 80, unit_code: unitCode,
        entered_value_num: 80, entered_unit_code: unitCode,
        value_status: 'observed',
      },
    ],
  };
  const input = (value, note) => validIrrigation({
    activity_code: 'fertilization',
    template_code: 'research_observation', template_version: 1,
    layout_code: 'agroscope_open_field', layout_version: 1,
    note,
    values: [operationValue, deviceValue, value],
  });
  const correction = (value, note) => validateEntry(
    catalog,
    layout,
    template,
    input(value, note),
    { mode: 'correction', originalEntry }
  );

  const unit = catalog.vocabByCode.get(unitCode);
  catalog.vocabByCode.set(unitCode, Object.assign({}, unit, { active: 0 }));
  const noteOnlyRetiredUnit = correction(numericValue, 'note-only correction');
  assert.equal(noteOnlyRetiredUnit.ok, true, JSON.stringify(noteOnlyRetiredUnit));

  const changedRetiredUnit = correction(Object.assign({}, numericValue, {
    value: 81, value_num: 81, entered_value_num: 81,
  }), 'changed value');
  assert.equal(changedRetiredUnit.ok, false, JSON.stringify(changedRetiredUnit));
  assert.ok(changedRetiredUnit.errors.some((error) =>
    error.code === 'inactive_value_changed'));

  const createWithRetiredUnit = validateEntry(
    catalog, layout, template, input(numericValue, 'new entry')
  );
  assert.equal(createWithRetiredUnit.ok, false, JSON.stringify(createWithRetiredUnit));
  assert.ok(createWithRetiredUnit.errors.some((error) => error.code === 'invalid_catalog'));

  catalog.vocabByCode.set(unitCode, Object.assign({}, unit, {
    active: 0,
    constraints: Object.assign({}, unit.constraints, {
      to_canonical: Object.assign({}, unit.constraints.to_canonical, { scale: 0 }),
    }),
  }));
  const corruptRetiredUnit = correction(numericValue, 'corrupt unit metadata');
  assert.equal(corruptRetiredUnit.ok, false, JSON.stringify(corruptRetiredUnit));
  assert.ok(corruptRetiredUnit.errors.some((error) => error.code === 'invalid_catalog'));

  catalog.vocabByCode.set(unitCode, unit);
  const attribute = catalog.vocabByCode.get(attributeCode);
  catalog.vocabByCode.set(attributeCode, Object.assign({}, attribute, { active: 0 }));
  const noteOnlyRetiredAttribute = correction(numericValue, 'retired attribute note');
  assert.equal(
    noteOnlyRetiredAttribute.ok,
    true,
    JSON.stringify(noteOnlyRetiredAttribute)
  );
  const changedRetiredAttribute = correction(Object.assign({}, numericValue, {
    value: 81, value_num: 81, entered_value_num: 81,
  }), 'retired attribute changed');
  assert.equal(changedRetiredAttribute.ok, false, JSON.stringify(changedRetiredAttribute));
  assert.ok(changedRetiredAttribute.errors.some((error) =>
    error.code === 'inactive_value_changed'));
});

function aggregateApi() {
  return require('./aggregate');
}

function aggregateEntry(overrides) {
  return Object.assign({
    id: 71,
    entry_uuid: '11111111-1111-4111-8111-111111111111',
    activity_code: 'irrigation',
    occurred_start: '2026-07-12T07:30:00.000Z',
    sync_version: 1,
  }, overrides || {});
}

function aggregateValues() {
  return [
    {
      id: 3,
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      attribute_code: 'attr.note', group_index: 1,
      value_status: 'observed', value_text: 'second',
    },
    {
      id: 2,
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      attribute_code: 'attr.irrigation_depth', group_index: 0,
      value_status: 'observed', value_num: 12, unit_code: 'unit.mm_water',
    },
  ];
}

test('aggregate value order and hash are independent of SQLite insertion order', () => {
  const { aggregateHash, buildAggregate } = aggregateApi();
  const values = aggregateValues();
  const forward = buildAggregate(aggregateEntry(), values);
  const reverse = buildAggregate(aggregateEntry(), values.slice().reverse());

  assert.deepEqual(forward, reverse);
  assert.deepEqual(
    forward.values.map((row) => [row.group_index, row.attribute_code]),
    [[0, 'attr.irrigation_depth'], [1, 'attr.note']]
  );
  assert.equal(aggregateHash(forward), aggregateHash(reverse));
});

test('aggregate hash changes when one logical value changes', () => {
  const { aggregateHash, buildAggregate } = aggregateApi();
  const original = buildAggregate(aggregateEntry(), aggregateValues());
  const changedValues = aggregateValues();
  changedValues[1] = Object.assign({}, changedValues[1], { value_num: 13 });
  const changed = buildAggregate(aggregateEntry(), changedValues);

  assert.notEqual(aggregateHash(original), aggregateHash(changed));
});

test('every aggregate public path rejects payloads over 256 KiB', () => {
  const { aggregateHash, buildAggregate } = aggregateApi();
  const oversized = 'x'.repeat(256 * 1024);
  const hasStableCode = (error) => error && error.code === 'aggregate_too_large';

  assert.throws(() => aggregateHash({ note: oversized }), hasStableCode);
  assert.throws(
    () => buildAggregate(aggregateEntry({ note: oversized }), []),
    hasStableCode
  );
});

test('built aggregate is detached JSON-safe data that round-trips unchanged', () => {
  const { buildAggregate } = aggregateApi();
  const entry = aggregateEntry({ extension: { nested: ['kept', null, true] } });
  const values = aggregateValues();
  const aggregate = buildAggregate(entry, values);

  assert.deepEqual(JSON.parse(JSON.stringify(aggregate)), aggregate);
  entry.extension.nested[0] = 'mutated';
  values[0].value_text = 'mutated';
  assert.equal(aggregate.extension.nested[0], 'kept');
  assert.equal(aggregate.values[1].value_text, 'second');
});

test('aggregateHash pins all eight normative canonicalization hashes', () => {
  const { aggregateHash } = aggregateApi();
  const utf16KeyOrder = {};
  utf16KeyOrder['\uE000'] = 2;
  utf16KeyOrder['\u{10000}'] = 1;
  const vectors = [
    [{}, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'],
    [{ b: 1, a: 2 }, 'd3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772'],
    [{ recorded_at: '2026-05-03T12:00:00.123456789Z' }, 'b2433460d6039d8b8bb640cb46d854e5fcdc6c511a4152ba0f9add660ceea9cc'],
    [{ flow_rate_lpm: 8.5e0 }, '890beb02858df19a0d452b7a3bac58118a180b2e61d41e810d10768c18acb727'],
    [{ a: null, b: null }, '052c4bd5e6ded53bd884485af8b1667a7b70ba3a8573b54bd878f6d2c705c2df'],
    [{ device_eui: '0016c001f11715e2', event_uuid: 'D4FE4B8F-2C58-4D1C-A8C3-9DCE37E6EC90' }, '5a6af3263b6ee1803f572b1011b72f2e1e5ba72e4c45f0ca46095fc6f477d8e5'],
    [{ device_eui: '0016c001f117' }, '7af6b7cc1190a447fddaf87749fdb4418938585b205738b20c32de051b173741'],
    [utf16KeyOrder, '4045c21a23c8ae8f8d9add81f54bd506bee65885099876fb4afb378b1f2c3516'],
  ];

  for (const [input, expected] of vectors) assert.equal(aggregateHash(input), expected);
});

test('package main re-exports aggregate construction and hashing', () => {
  const packageApi = require('./index');
  assert.equal(typeof packageApi.buildAggregate, 'function');
  assert.equal(typeof packageApi.aggregateHash, 'function');
});

function hashCanonicalText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function invalidAggregateCode(error) {
  return error && error.code === 'invalid_aggregate';
}

test('aggregate size cap accepts exactly 256 KiB and rejects the next UTF-8 byte', () => {
  const { aggregateHash } = aggregateApi();
  const jsonEnvelopeBytes = Buffer.byteLength('{"payload":""}', 'utf8');
  const exact = { payload: 'x'.repeat(256 * 1024 - jsonEnvelopeBytes) };
  const over = { payload: exact.payload + 'x' };

  assert.match(aggregateHash(exact), /^[0-9a-f]{64}$/);
  assert.throws(
    () => aggregateHash(over),
    (error) => error && error.code === 'aggregate_too_large'
  );
});

test('aggregate projection drops local IDs but retains unknown logical columns and nulls', () => {
  const { aggregateHash, buildAggregate } = aggregateApi();
  const values = aggregateValues();
  const first = buildAggregate(aggregateEntry({
    id: 1, user_id: 2, zone_id: 3,
    context_json: '{"schema_version":1,"recorded_at":"raw"}',
    forward_logical_field: { enabled: true },
    nullable_extension: null,
  }), values);
  const second = buildAggregate(aggregateEntry({
    id: 9001, user_id: 9002, zone_id: 9003,
    context_json: '{"schema_version":1,"recorded_at":"raw"}',
    forward_logical_field: { enabled: true },
    nullable_extension: null,
  }), values.map((row, index) => Object.assign({}, row, { id: 8000 + index })));

  for (const field of ['id', 'rowid', 'user_id', 'zone_id']) {
    assert.equal(Object.hasOwn(first, field), false, field);
  }
  assert.equal(Object.hasOwn(first.values[0], 'id'), false);
  assert.equal(Object.hasOwn(first.values[0], 'entry_uuid'), false);
  assert.equal(first.context_json, '{"schema_version":1,"recorded_at":"raw"}');
  assert.deepEqual(first.forward_logical_field, { enabled: true });
  assert.equal(first.nullable_extension, null);
  assert.equal(aggregateHash(first), aggregateHash(second));
});

test('aggregate cells reject duplicates and invalid coordinates deterministically', () => {
  const { buildAggregate } = aggregateApi();
  const base = aggregateValues()[0];
  const invalidSets = [
    [base, Object.assign({}, base, { id: 99 })],
    [Object.assign({}, base, { group_index: -1 })],
    [Object.assign({}, base, { group_index: 1.5 })],
    [Object.assign({}, base, { group_index: Number.MAX_SAFE_INTEGER + 1 })],
    [Object.assign({}, base, { attribute_code: '   ' })],
  ];

  for (const rows of invalidSets) {
    assert.throws(() => buildAggregate(aggregateEntry(), rows), invalidAggregateCode);
  }
});

test('aggregate rejects mismatched or malformed redundant child identities', () => {
  const { buildAggregate } = aggregateApi();
  const base = aggregateValues()[0];
  const wrong = Object.assign({}, base, {
    entry_uuid: '22222222-2222-4222-8222-222222222222',
  });
  const malformed = Object.assign({}, base, { entry_uuid: 7 });

  assert.throws(() => buildAggregate(aggregateEntry(), [wrong]), invalidAggregateCode);
  assert.throws(() => buildAggregate(aggregateEntry(), [malformed]), invalidAggregateCode);
});

test('canonical strings normalize recursively by content like the Java sync runtime', () => {
  const { aggregateHash } = aggregateApi();
  const input = {
    z: [
      'D4FE4B8F2C584D1CA8C39DCE37E6EC90',
      { stamp: '2026-05-03T14:00:00.123456+0200' },
    ],
    note: '2026-05-03T14:00:00.123456+02:00',
    local: '2026-05-03T14:00:00',
    idish: '0016c001f117',
  };
  const expected = '{"idish":"0016C0FFFE01F117","local":"2026-05-03T14:00:00",' +
    '"note":"2026-05-03T12:00:00.123Z","z":[' +
    '"d4fe4b8f-2c58-4d1c-a8c3-9dce37e6ec90",' +
    '{"stamp":"2026-05-03T12:00:00.123Z"}]}';

  assert.equal(aggregateHash(input), hashCanonicalText(expected));
});

test('canonical serialization matches Java UTF-16 key order and JSON escapes', () => {
  const { aggregateHash } = aggregateApi();
  const astralKey = '\u{10000}';
  const bmpKey = '\uE000';
  const input = { control: '\u000b\u001f' };
  input[bmpKey] = 2;
  input[astralKey] = 1;
  const expected = '{"control":"\\u000B\\u001F","' + astralKey + '":1,"' + bmpKey + '":2}';

  assert.equal(aggregateHash(input), hashCanonicalText(expected));
});

test('finite doubles serialize fixed-point without exponent, rounding cap, or negative zero', () => {
  const { aggregateHash } = aggregateApi();
  const smallestJavaDouble = '0.' + '0'.repeat(323) + '49';
  const largestPower = '1' + '0'.repeat(23);
  const expected = '{"large":' + largestPower + ',"negative_zero":0,"small":' +
    smallestJavaDouble + '}';

  assert.equal(
    aggregateHash({ small: Number.MIN_VALUE, large: 1e23, negative_zero: -0 }),
    hashCanonicalText(expected)
  );
});

test('finite number formatting matches production Java 21/Jackson decimal reference cases', () => {
  const { aggregateHash } = aggregateApi();
  const cases = [
    [5e-324, '0.' + '0'.repeat(323) + '49'],
    [1e-323, '0.' + '0'.repeat(323) + '99'],
    [1.5e-323, '0.' + '0'.repeat(322) + '15'],
    [2e-323, '0.' + '0'.repeat(322) + '2'],
    [1e-320, '0.' + '0'.repeat(319) + '1'],
    [1e-7, '0.0000001'],
    [1e21, '1' + '0'.repeat(21)],
    [1e23, '1' + '0'.repeat(23)],
    [5e20, '5' + '0'.repeat(20)],
    [1.2345678901234567e20, '123456789012345670000'],
  ];

  for (const [value, expected] of cases) {
    assert.equal(
      aggregateHash({ value }),
      hashCanonicalText('{"value":' + expected + '}'),
      String(value)
    );
  }
});

test('aggregate canonicalization omits object undefined and rejects non-JSON state', () => {
  const { aggregateHash } = aggregateApi();
  assert.equal(aggregateHash({ kept: null, absent: undefined }), aggregateHash({ kept: null }));

  const cyclic = {};
  cyclic.self = cyclic;
  const withSymbolKey = { okay: true };
  withSymbolKey[Symbol('hidden')] = true;
  const sparse = [];
  sparse.length = 1;
  const invalidValues = [
    cyclic,
    { value: 1n },
    { value: function nope() {} },
    { value: Symbol('nope') },
    { value: new Date() },
    withSymbolKey,
    { value: sparse },
    { value: [undefined] },
    { value: NaN },
    { value: Infinity },
    { value: '\uD800' },
  ];
  for (const value of invalidValues) {
    assert.throws(() => aggregateHash(value), invalidAggregateCode);
  }
});

test('timestamp-shaped arbitrary text beyond Java precision fails recursively', () => {
  const { aggregateHash } = aggregateApi();
  const overprecise = '2026-05-03T12:00:00.1234567890Z';
  const invalidValues = [
    { note: overprecise },
    { values: [{ value_text: overprecise }] },
  ];

  for (const value of invalidValues) {
    assert.throws(() => aggregateHash(value), invalidAggregateCode);
  }
});

test('nine-digit timestamp-shaped arbitrary text still truncates to milliseconds', () => {
  const { aggregateHash } = aggregateApi();
  const precise = '2026-05-03T12:00:00.123456789Z';
  const milliseconds = '2026-05-03T12:00:00.123Z';

  assert.equal(aggregateHash({ note: precise }), aggregateHash({ note: milliseconds }));
  assert.equal(
    aggregateHash({ values: [{ value_text: precise }] }),
    aggregateHash({ values: [{ value_text: milliseconds }] })
  );
});

test('aggregate canonicalization rejects array accessors without invoking them', () => {
  const { aggregateHash } = aggregateApi();
  let getterCalls = 0;
  const values = [];
  Object.defineProperty(values, 0, {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'must-not-run';
    },
  });

  assert.throws(() => aggregateHash({ values }), invalidAggregateCode);
  assert.equal(getterCalls, 0);
});

test('semantic UUID, EUI, and timestamp fields reject malformed values', () => {
  const { aggregateHash } = aggregateApi();
  const invalidValues = [
    { entry_uuid: 'not-a-uuid' },
    { gateway_device_eui: '00:16:C0:01:F1:17:15:E2' },
    { recorded_at: '2026-02-30T12:00:00Z' },
    { note: '2026-02-30T12:00:00Z' },
  ];
  for (const value of invalidValues) {
    assert.throws(() => aggregateHash(value), invalidAggregateCode);
  }
});

test('value rows use code-point ordering after numeric group ordering', () => {
  const { buildAggregate } = aggregateApi();
  const bmpCode = 'attr.' + '\uE000';
  const astralCode = 'attr.' + '\u{10000}';
  const aggregate = buildAggregate(aggregateEntry(), [
    { attribute_code: astralCode, group_index: 0, value_status: 'observed', value_num: 1 },
    { attribute_code: bmpCode, group_index: 0, value_status: 'observed', value_num: 2 },
    { attribute_code: 'attr.first', group_index: 1, value_status: 'observed', value_num: 3 },
  ]);

  assert.deepEqual(
    aggregate.values.map((row) => row.attribute_code),
    [bmpCode, astralCode, 'attr.first']
  );
});

test('projection ignores local scaffolding before validation and safely retains proto-named data', () => {
  const { aggregateHash, buildAggregate } = aggregateApi();
  const entry = aggregateEntry({ id: 1n, user_id: Symbol('local'), zone_id: function local() {} });
  Object.defineProperty(entry, '__proto__', {
    value: { retained: true }, enumerable: true, configurable: true, writable: true,
  });
  const row = Object.assign({}, aggregateValues()[0], { id: 2n });
  const aggregate = buildAggregate(entry, [row]);
  const parsedProtoKey = JSON.parse('{"__proto__":{"retained":true},"a":1}');

  assert.equal(Object.getPrototypeOf(aggregate), Object.prototype);
  assert.equal(Object.hasOwn(aggregate, '__proto__'), true);
  assert.deepEqual(aggregate.__proto__, { retained: true });
  assert.equal(
    aggregateHash(parsedProtoKey),
    hashCanonicalText('{"__proto__":{"retained":true},"a":1}')
  );
});

test('timestamp canonicalization rejects precision the Java runtime cannot parse', () => {
  const { aggregateHash } = aggregateApi();
  assert.throws(
    () => aggregateHash({ recorded_at: '2026-05-03T12:00:00.1234567890Z' }),
    invalidAggregateCode
  );
});
