'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { mock } = require('node:test');
const { Writable } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');

const { loadCatalog } = require('./catalog');
const {
  allowedUnits,
  assertJournalEntryEffectKey,
  convertToCanonical,
  exportJson,
  exportResearchPackage,
  exportWideCsv,
  finalize,
  finalizeBatch,
  listEntries,
  listPlots,
  loadCurrentAggregate,
  saveEntry,
  upsertPlot,
  validateEntry,
  void_,
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

// --- Slice D Phase 2 (crop-cycle lifecycle) test helpers -----------------
// Fixtures below deliberately use their own dedicated UUID/zone-id namespace
// ("cc..." prefixes / zone ids 900+) so these tests never collide with plot,
// zone, or entry fixtures created elsewhere in this file.

function cropCyclePlotUuid(number) {
  return 'cc000000-0000-4000-8000-' + String(number).padStart(12, '0');
}

function cropCycleEntryUuid(number) {
  return 'cc100000-0000-4000-8000-' + String(number).padStart(12, '0');
}

function cropCycleZoneUuid(number) {
  return 'cc200000-0000-4000-8000-' + String(number).padStart(12, '0');
}

async function makeCropCyclePlot(db, principal, plotUuid, overrides) {
  return upsertPlot(db, Object.assign({
    plot_uuid: plotUuid,
    base_sync_version: 0,
    plot_code: 'plot-' + plotUuid.slice(-8),
    name: 'Plot ' + plotUuid.slice(-8),
    zone_uuid: null,
    station_code: null,
    crop_hint: null,
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 3,
    context_json: null,
  }, overrides || {}), principal);
}

// Direct SQL: zone + a single zone_seasons row, mirroring the live-gateway
// shape confirmed in the brief (scripts/repair-pi-schema.js backfills a
// NULL-crop default season per zone). cropType null reproduces exactly that.
function makeZoneWithSeason(db, zoneId, zoneUuid, seasonUuid, cropType, variety) {
  db.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) VALUES (?,?,?,?,?,?)'
  ).run(zoneId, 'Crop cycle zone ' + zoneId, 1, 'Europe/Zurich', zoneUuid, JOURNAL_TEST_GATEWAY_EUI);
  db.prepare(
    'INSERT INTO zone_seasons(zone_id,season_uuid,name,starts_on,ends_on,crop_type,variety) ' +
    'VALUES (?,?,?,?,?,?,?)'
  ).run(zoneId, seasonUuid, 'Season ' + zoneId, '2026-01-01', '2026-12-31', cropType, variety || null);
}

function seedingInput(overrides) {
  return Object.assign({
    status: 'final',
    base_sync_version: 0,
    activity_code: 'seeding',
    template_code: 'farmer_quick',
    template_version: 3,
    layout_code: 'open_field',
    layout_version: 3,
    occurred_timezone: 'Europe/Zurich',
    values: [
      { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.wheat_winter', value_status: 'observed' },
      { attribute_code: 'attr.variety', group_index: 0, value: 'Runal', value_status: 'observed' },
    ],
    note: 'Seeded',
  }, overrides || {});
}

function harvestInput(overrides) {
  return Object.assign({
    status: 'final',
    base_sync_version: 0,
    activity_code: 'harvest',
    template_code: 'farmer_quick',
    template_version: 3,
    layout_code: 'open_field',
    layout_version: 3,
    occurred_timezone: 'Europe/Zurich',
    values: [],
    note: 'Harvest',
  }, overrides || {});
}

function tillageInput(overrides) {
  return Object.assign({
    status: 'final',
    base_sync_version: 0,
    activity_code: 'tillage_soil_work',
    template_code: 'farmer_quick',
    template_version: 3,
    layout_code: 'open_field',
    layout_version: 3,
    occurred_timezone: 'Europe/Zurich',
    values: [],
    note: 'Tillage',
  }, overrides || {});
}

function irrigationInput(overrides) {
  return Object.assign({
    status: 'final',
    base_sync_version: 0,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 3,
    layout_code: 'open_field',
    layout_version: 3,
    occurred_timezone: 'Europe/Zurich',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 5,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
    note: 'Irrigated',
  }, overrides || {});
}

function readJournalEntryRow(db, entryUuid) {
  return db.prepare(
    'SELECT entry_uuid,plot_uuid,season_uuid,season_crop,season_variety,sync_version,occurred_start ' +
    'FROM journal_entries WHERE entry_uuid=?'
  ).get(entryUuid);
}

function readCycleMemberships(db, plotUuid) {
  return db.prepare(
    'SELECT ccp.plot_uuid,ccp.ends_on,ccp.close_reason,ccp.closed_by_entry_uuid,' +
      'cc.cycle_uuid,cc.crop_code,cc.variety,cc.starts_on,cc.deleted_at AS cycle_deleted_at ' +
    'FROM journal_crop_cycle_plots AS ccp JOIN journal_crop_cycles AS cc ON cc.cycle_uuid=ccp.cycle_uuid ' +
    'WHERE ccp.plot_uuid=? ORDER BY cc.starts_on,cc.cycle_uuid'
  ).all(plotUuid);
}

function currentSyncVersion(db, entryUuid) {
  return db.prepare('SELECT sync_version FROM journal_entries WHERE entry_uuid=?').get(entryUuid).sync_version;
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

// Slice F (B1/B2 fix): tank-mix pass batch — a single-plot, multi-product
// pass finalized as ONE atomic saveEntry call sharing one pass_uuid, using
// the generalized multi-plot batch mechanism (finalizeBatch/
// normalizeBatchMembers/canonicalBatchMembers now accept a pass batch whose
// members all share ONE plot, each carrying its own per-member `values`).
function sprayValues(product) {
  return [
    { attribute_code: 'attr.product', group_index: 0, value: product, value_status: 'observed' },
    {
      attribute_code: 'attr.treated_area', group_index: 0, value: 1000,
      unit_code: 'unit.m2_area', value_status: 'observed',
    },
    {
      attribute_code: 'attr.amount_volume_area_product', group_index: 0, value: 2,
      unit_code: 'unit.l_per_ha_product', value_status: 'observed',
    },
  ];
}

test('saveEntry (pass batch) persists a 3-product tank-mix pass atomically, immune to the entry_uuid tie-break bug', async () => {
  const db = createJournalDb('pass-batch-atomic');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plotUuid = '31000000-0000-4000-8000-000000000001';
  await upsertPlot(db, {
    plot_uuid: plotUuid,
    base_sync_version: 0,
    plot_code: 'pass-batch-atomic',
    name: 'Pass batch atomic',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 1000,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  }, principal);
  const passUuid = '32000000-0000-4000-8000-000000000001';
  // Ascending entry_uuids matching insertion order is the exact shape that
  // defeated the OLD chained duplicate_guard_ack_entry_uuid mechanism: its
  // tie-break (ORDER BY ABS(diff),entry_uuid) always resolves to the LOWEST
  // uuid seen so far (the primary, index 0) once two or more final entries
  // tie on time-diff, while the old chain always acknowledged "the
  // immediately preceding member" (index i-1) — a mismatch for the third
  // product onward. The new pass_uuid exclusion in findDuplicateCandidate
  // sidesteps the tie-break question entirely, so this must succeed
  // regardless of how the member UUIDs sort.
  const primaryUuid = '33000000-0000-4000-8000-000000000001';
  const member2Uuid = '33000000-0000-4000-8000-000000000002';
  const member3Uuid = '33000000-0000-4000-8000-000000000003';
  const batch = {
    status: 'final',
    base_sync_version: 0,
    pass_uuid: passUuid,
    activity_code: 'plant_protection_application',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-20T08:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: [],
    members: [
      { plot_uuid: plotUuid, entry_uuid: primaryUuid, values: sprayValues('Herbicide X') },
      { plot_uuid: plotUuid, entry_uuid: member2Uuid, values: sprayValues('Adjuvant Y') },
      { plot_uuid: plotUuid, entry_uuid: member3Uuid, values: sprayValues('Fungicide Z') },
    ],
  };

  const receipt = await saveEntry(db, batch, principal, { mode: 'create' });
  assert.equal(receipt.entries.length, 3);
  assert.ok(receipt.batch_uuid);

  const rows = db.prepare(
    'SELECT entry_uuid,status,pass_uuid,batch_uuid,sync_version FROM journal_entries ' +
      'WHERE entry_uuid IN (?,?,?) ORDER BY entry_uuid'
  ).all(primaryUuid, member2Uuid, member3Uuid);
  assert.equal(rows.length, 3, 'all three products persisted');
  for (const row of rows) {
    assert.equal(row.status, 'final');
    assert.equal(row.pass_uuid, passUuid);
    assert.equal(row.batch_uuid, receipt.batch_uuid);
    assert.equal(row.sync_version, 1);
  }
  const productValues = db.prepare(
    "SELECT entry_uuid,value_text FROM journal_entry_values WHERE attribute_code='attr.product' " +
      'AND entry_uuid IN (?,?,?)'
  ).all(primaryUuid, member2Uuid, member3Uuid);
  const productByEntry = new Map(productValues.map((row) => [row.entry_uuid, row.value_text]));
  assert.equal(productByEntry.get(primaryUuid), 'Herbicide X');
  assert.equal(productByEntry.get(member2Uuid), 'Adjuvant Y');
  assert.equal(productByEntry.get(member3Uuid), 'Fungicide Z');
});

test('saveEntry (pass batch) rolls back the WHOLE pass when one member fails validation -- no partial write', async () => {
  const db = createJournalDb('pass-batch-rollback');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plotUuid = '31000000-0000-4000-8000-000000000002';
  await upsertPlot(db, {
    plot_uuid: plotUuid,
    base_sync_version: 0,
    plot_code: 'pass-batch-rollback',
    name: 'Pass batch rollback',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 1000,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  }, principal);
  const passUuid = '32000000-0000-4000-8000-000000000002';
  const primaryUuid = '34000000-0000-4000-8000-000000000001';
  const member2Uuid = '34000000-0000-4000-8000-000000000002';
  const member3Uuid = '34000000-0000-4000-8000-000000000003';
  const batch = {
    status: 'final',
    base_sync_version: 0,
    pass_uuid: passUuid,
    activity_code: 'plant_protection_application',
    // full_record@1 (not farmer_quick) so the missing required_any group on
    // member 3 below actually gets enforced -- farmer_quick's quick_fields
    // mechanism does not declare per-activity activity_requirements.
    template_code: 'full_record',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-20T09:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: [],
    members: [
      { plot_uuid: plotUuid, entry_uuid: primaryUuid, values: sprayValues('Herbicide X') },
      { plot_uuid: plotUuid, entry_uuid: member2Uuid, values: sprayValues('Adjuvant Y') },
      // Missing every required_any group (no product identity, no dose, no
      // treated_area) -- forces validateEntry to fail on the third member,
      // deep inside the atomic transaction, after the first two members'
      // rows would already have been written if this were non-atomic.
      { plot_uuid: plotUuid, entry_uuid: member3Uuid, values: [] },
    ],
  };
  const before = {
    entries: db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n,
    values: db.prepare('SELECT COUNT(*) AS n FROM journal_entry_values').get().n,
    outbox: db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n,
  };

  await assert.rejects(
    saveEntry(db, batch, principal, { mode: 'create' }),
    (error) => error && error.code === 'validation_failed'
  );

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, before.entries,
    'no entry from the failed pass may persist, including the earlier members'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM journal_entry_values').get().n, before.values,
    'no values from the failed pass may persist'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, before.outbox,
    'no outbox event from the failed pass may persist'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE entry_uuid IN (?,?,?)')
      .get(primaryUuid, member2Uuid, member3Uuid).n,
    0,
    'not even the earlier, individually-valid members may survive the rollback'
  );
});

test('saveEntry (pass batch) promotes an already-autosaved draft primary alongside brand-new members, atomically', async () => {
  const db = createJournalDb('pass-batch-draft-primary');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plotUuid = '31000000-0000-4000-8000-000000000003';
  await upsertPlot(db, {
    plot_uuid: plotUuid,
    base_sync_version: 0,
    plot_code: 'pass-batch-draft-primary',
    name: 'Pass batch draft primary',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 1000,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  }, principal);
  const passUuid = '32000000-0000-4000-8000-000000000003';
  const primaryUuid = '35000000-0000-4000-8000-000000000001';
  const member2Uuid = '35000000-0000-4000-8000-000000000002';

  // Simulates the GUI's continuous draft autosave already having persisted
  // the primary/currently-edited product as a version-zero draft before the
  // pass is ever finalized.
  await saveEntry(db, {
    entry_uuid: primaryUuid,
    base_sync_version: 0,
    status: 'draft',
    plot_uuid: plotUuid,
    activity_code: 'plant_protection_application',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-20T10:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: sprayValues('Herbicide X (draft)'),
  }, principal, { mode: 'create' });
  assert.equal(
    db.prepare('SELECT status,sync_version FROM journal_entries WHERE entry_uuid=?').get(primaryUuid).status,
    'draft'
  );

  const batch = {
    status: 'final',
    base_sync_version: 0,
    pass_uuid: passUuid,
    activity_code: 'plant_protection_application',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-20T10:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    values: [],
    members: [
      { plot_uuid: plotUuid, entry_uuid: primaryUuid, values: sprayValues('Herbicide X') },
      { plot_uuid: plotUuid, entry_uuid: member2Uuid, values: sprayValues('Adjuvant Y') },
    ],
  };
  const receipt = await saveEntry(db, batch, principal, { mode: 'create' });
  assert.equal(receipt.entries.length, 2);

  const rows = db.prepare(
    'SELECT entry_uuid,status,pass_uuid,batch_uuid,sync_version FROM journal_entries ' +
      'WHERE entry_uuid IN (?,?) ORDER BY entry_uuid'
  ).all(primaryUuid, member2Uuid);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'final');
    assert.equal(row.pass_uuid, passUuid);
    assert.equal(row.batch_uuid, receipt.batch_uuid);
    assert.equal(row.sync_version, 1);
  }
  const primaryProduct = db.prepare(
    "SELECT value_text FROM journal_entry_values WHERE entry_uuid=? AND attribute_code='attr.product'"
  ).get(primaryUuid);
  assert.equal(primaryProduct.value_text, 'Herbicide X', 'the draft was promoted with the finalize-time values, not the stale draft values');
});

test('saveEntry (pass batch, F-1 fix) promotes a draft primary through an ACKNOWLEDGED prior duplicate instead of dead-ending the whole pass', async () => {
  const db = createJournalDb('pass-batch-draft-ack-dup');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plotUuid = '31000000-0000-4000-8000-00000000000a';
  await upsertPlot(db, {
    plot_uuid: plotUuid, base_sync_version: 0, plot_code: 'pass-draft-ack', name: 'Pass draft ack',
    zone_uuid: null, station_code: null, crop_hint: 'barley', area_m2: 1000, active: 1,
    layout_code: 'open_field', layout_version: 1,
  }, principal);
  const priorUuid = '34000000-0000-4000-8000-00000000000a';
  const passUuid = '32000000-0000-4000-8000-00000000000a';
  const primaryUuid = '35000000-0000-4000-8000-00000000000a';
  const member2Uuid = '35000000-0000-4000-8000-00000000000b';

  // A prior FINAL plant-protection entry on the plot within +/-1h — the legitimate
  // duplicate the farmer will acknowledge.
  await saveEntry(db, {
    entry_uuid: priorUuid, base_sync_version: 0, status: 'final', plot_uuid: plotUuid,
    activity_code: 'plant_protection_application', template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1, occurred_start_local: '2026-07-20T10:00:00',
    occurred_timezone: 'Europe/Zurich', season_crop: 'barley', values: sprayValues('Earlier spray'),
  }, principal, { mode: 'create' });
  // The GUI's autosave has already persisted the primary product as a version-zero draft.
  await saveEntry(db, {
    entry_uuid: primaryUuid, base_sync_version: 0, status: 'draft', plot_uuid: plotUuid,
    activity_code: 'plant_protection_application', template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1, occurred_start_local: '2026-07-20T10:00:00',
    occurred_timezone: 'Europe/Zurich', season_crop: 'barley', values: sprayValues('Herbicide X (draft)'),
  }, principal, { mode: 'create' });

  // Finalize the pass, ACKNOWLEDGING the prior duplicate. Before the F-1 fix, the
  // draft-promotion path did not receive the acknowledgement set, re-detected
  // priorUuid, and rolled back the WHOLE pass -> unsaveable forever.
  const batch = {
    status: 'final', base_sync_version: 0, pass_uuid: passUuid,
    activity_code: 'plant_protection_application', template_code: 'farmer_quick', template_version: 1,
    layout_code: 'open_field', layout_version: 1, occurred_start_local: '2026-07-20T10:00:00',
    occurred_timezone: 'Europe/Zurich', season_crop: 'barley', values: [],
    duplicate_guard_ack_entry_uuids: [priorUuid],
    members: [
      { plot_uuid: plotUuid, entry_uuid: primaryUuid, values: sprayValues('Herbicide X') },
      { plot_uuid: plotUuid, entry_uuid: member2Uuid, values: sprayValues('Adjuvant Y') },
    ],
  };
  const receipt = await saveEntry(db, batch, principal, { mode: 'create' });
  assert.equal(receipt.entries.length, 2, 'both pass members persist despite the acknowledged prior duplicate');
  const rows = db.prepare(
    'SELECT status,pass_uuid FROM journal_entries WHERE entry_uuid IN (?,?)'
  ).all(primaryUuid, member2Uuid);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'final');
    assert.equal(row.pass_uuid, passUuid);
  }
});

test('findDuplicateCandidate still guards against a genuinely different pass on the same plot/activity/time', async () => {
  const db = createJournalDb('pass-batch-cross-pass-duplicate');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plotUuid = '31000000-0000-4000-8000-000000000004';
  await upsertPlot(db, {
    plot_uuid: plotUuid,
    base_sync_version: 0,
    plot_code: 'pass-batch-cross-pass',
    name: 'Pass batch cross pass',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 1000,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  }, principal);
  const firstPassUuid = '32000000-0000-4000-8000-000000000004';
  const secondPassUuid = '32000000-0000-4000-8000-000000000005';
  const firstEntryUuid = '36000000-0000-4000-8000-000000000001';
  const secondEntryUuid = '36000000-0000-4000-8000-000000000002';

  await saveEntry(db, {
    entry_uuid: firstEntryUuid,
    base_sync_version: 0,
    status: 'final',
    plot_uuid: plotUuid,
    activity_code: 'plant_protection_application',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: '2026-07-20T11:00:00',
    occurred_timezone: 'Europe/Zurich',
    season_crop: 'barley',
    pass_uuid: firstPassUuid,
    values: sprayValues('Herbicide X'),
  }, principal, { mode: 'create' });

  // A second, UNRELATED pass (different pass_uuid) at the same plot/
  // activity/time must still be flagged -- the pass_uuid exclusion is
  // scoped to entries sharing the SAME pass_uuid, not every entry at this
  // plot/activity/time.
  await assert.rejects(
    saveEntry(db, {
      entry_uuid: secondEntryUuid,
      base_sync_version: 0,
      status: 'final',
      plot_uuid: plotUuid,
      activity_code: 'plant_protection_application',
      template_code: 'farmer_quick',
      template_version: 1,
      layout_code: 'open_field',
      layout_version: 1,
      occurred_start_local: '2026-07-20T11:00:00',
      occurred_timezone: 'Europe/Zurich',
      season_crop: 'barley',
      pass_uuid: secondPassUuid,
      values: sprayValues('Fungicide Z'),
    }, principal, { mode: 'create' }),
    (error) => error && error.code === 'duplicate_candidate' && error.statusCode === 409
  );
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

  // operation-level field/requirement/product scoping plan: the seeded
  // catalog is now at v10 (full_record@10 adds operation_fields_by_operation/
  // operation_requirements/operation_product_kinds + restores attr.equipment
  // for the 9 Agroscope-uncovered activities, 0032).
  assert.equal(catalog.version, 10);
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

  assert.equal(catalog.version, 10);
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

// journal capture-followups Slice 1 (Task 1.4): full_record@7 relaxes the
// irrigation_details conditional group — attr.measurement_source and
// attr.denominator move from required to optional (W1), while
// attr.irrigation_amount_kind stays required alongside required_any (the
// amount: one of depth/volume/per-plant). The edge validator only enforces
// conditional_groups/activity_requirements (never layout minimum_fields — see
// docs/superpowers/plans/2026-07-21-journal-capture-followups-plan.md), so a
// full_record@7 irrigation entry with just amount + amount_kind must already
// be savable with no edge-side change.
test('validateEntry: full_record@7 irrigation is savable without measurement_source/denominator', async () => {
  const { catalog, openField } = await loadedFixture('irrigation-group-v7');
  const fullRecordV7 = catalog.templates.get('full_record').get(7);
  assert.ok(fullRecordV7, 'catalog must publish full_record@7');

  const minimal = validateEntry(catalog, openField, fullRecordV7, validIrrigation({
    template_code: 'full_record',
    values: [
      { attribute_code: 'attr.irrigation_amount_kind', value: 'choice.irrigation_amount.measured' },
      { attribute_code: 'attr.irrigation_depth', value: 12, unit_code: 'unit.mm_water' },
    ],
  }));

  assert.equal(minimal.ok, true, JSON.stringify(minimal.errors));

  const missingAmountKind = validateEntry(catalog, openField, fullRecordV7, validIrrigation({
    template_code: 'full_record',
    values: [
      { attribute_code: 'attr.irrigation_depth', value: 12, unit_code: 'unit.mm_water' },
    ],
  }));

  assert.equal(missingAmountKind.ok, false);
  assert.ok(missingAmountKind.errors.some((error) => error.field === 'attr.irrigation_amount_kind'));
});

// treated-area-optional plan (2026-07-22, maintainer-confirmed): full_record@8
// drops attr.treated_area from activity_requirements.required for the 5
// dosing activities (fertilization/fertigation/plant_protection_application/
// seeding/planting_transplanting) — nothing computes a rate from it today,
// and the GUI now prefills it from the plot's own area for the common
// full-plot case. A full_record@8 fertilization/seeding entry with the rest
// of its required fields present, but no treated_area, must validate as
// savable; the other required_any/required fields are unchanged.
test('validateEntry: full_record@8 fertilization/seeding are savable without treated_area', async () => {
  const { catalog, openField } = await loadedFixture('treated-area-optional-v8');
  const fullRecordV8 = catalog.templates.get('full_record').get(8);
  assert.ok(fullRecordV8, 'catalog must publish full_record@8');

  const fertilization = validateEntry(catalog, openField, fullRecordV8, validIrrigation({
    activity_code: 'fertilization',
    template_code: 'full_record',
    values: [
      { attribute_code: 'attr.product', group_index: 0, value: 'NPK 15-15-15' },
      {
        attribute_code: 'attr.amount_mass_area_product', group_index: 0, value: 25,
        unit_code: 'unit.kg_per_ha_product',
      },
    ],
  }));
  assert.equal(fertilization.ok, true, JSON.stringify(fertilization.errors));

  const seeding = validateEntry(catalog, openField, fullRecordV8, validIrrigation({
    activity_code: 'seeding',
    template_code: 'full_record',
    values: [
      { attribute_code: 'attr.crop', group_index: 0, value: 'choice.crop.carrot', value_status: 'observed' },
      {
        attribute_code: 'attr.amount_count_area', group_index: 0, value: 100000,
        unit_code: 'unit.plants_per_ha',
      },
    ],
  }));
  assert.equal(seeding.ok, true, JSON.stringify(seeding.errors));

  // Other required fields on these activities are unchanged: dropping the
  // product/amount entirely must still fail, and must never blame
  // treated_area (it is no longer required).
  const missingProduct = validateEntry(catalog, openField, fullRecordV8, validIrrigation({
    activity_code: 'fertilization', template_code: 'full_record', values: [],
  }));
  assert.equal(missingProduct.ok, false);
  assert.ok(missingProduct.errors.some((error) =>
    error.field.includes('attr.product_uuid') || error.field.includes('attr.product')));
  assert.ok(!missingProduct.errors.some((error) => error.field === 'attr.treated_area'));
});

// Version-pinned control: an entry pinned to the frozen full_record@7 keeps
// its original requiredness — only NEW entries created against @8 get the
// relaxed behavior above.
test('validateEntry: full_record@7 fertilization still requires treated_area (version-pinned)', async () => {
  const { catalog, openField } = await loadedFixture('treated-area-required-v7');
  const fullRecordV7 = catalog.templates.get('full_record').get(7);
  assert.ok(fullRecordV7, 'catalog must publish full_record@7');

  const result = validateEntry(catalog, openField, fullRecordV7, validIrrigation({
    activity_code: 'fertilization',
    template_code: 'full_record',
    values: [
      { attribute_code: 'attr.product', group_index: 0, value: 'NPK 15-15-15' },
      {
        attribute_code: 'attr.amount_mass_area_product', group_index: 0, value: 25,
        unit_code: 'unit.kg_per_ha_product',
      },
    ],
  }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.treated_area' && error.code === 'required'));
});

// Detailed activity vocabulary plan (2026-07-22, maintainer-confirmed):
// full_record@9 exposes the Agroscope controlled operation/device pair
// (attr.agroscope.operation / attr.agroscope.device) via open_field@9's
// activity->operation->device option_dependencies, and requires BOTH for
// tillage_soil_work/seeding/plant_protection_application only (decision 2 —
// the vocabulary genuinely covers those three end-to-end). A tillage entry
// with neither must fail required on both fields; one with a real,
// dependency-valid operation+device pair must validate.
test('validateEntry: full_record@9 tillage_soil_work requires attr.agroscope.device + attr.agroscope.operation', async () => {
  const { catalog } = await loadedFixture('agroscope-vocabulary-v9');
  const fullRecordV9 = catalog.templates.get('full_record').get(9);
  const openFieldV9 = catalog.layouts.get('open_field').get(9);
  assert.ok(fullRecordV9, 'catalog must publish full_record@9');
  assert.ok(openFieldV9, 'catalog must publish open_field@9');

  const missingDevice = validateEntry(catalog, openFieldV9, fullRecordV9, validIrrigation({
    activity_code: 'tillage_soil_work',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [],
  }));
  assert.equal(missingDevice.ok, false);
  assert.ok(missingDevice.errors.some((error) =>
    error.field === 'attr.agroscope.device' && error.code === 'required'));
  assert.ok(missingDevice.errors.some((error) =>
    error.field === 'attr.agroscope.operation' && error.code === 'required'));

  const withDevice = validateEntry(catalog, openFieldV9, fullRecordV9, validIrrigation({
    activity_code: 'tillage_soil_work',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [
      {
        attribute_code: 'attr.agroscope.operation', group_index: 0,
        value: 'agroscope.operation.primary_tillage', value_status: 'observed',
      },
      {
        attribute_code: 'attr.agroscope.device', group_index: 0,
        value: 'agroscope.device.plough', value_status: 'observed',
      },
    ],
  }));
  assert.equal(withDevice.ok, true, JSON.stringify(withDevice.errors));

  // A device outside the selected operation's dependency-restricted set must
  // still be rejected by the cascade (unaffected by the requiredness change).
  const wrongDevice = validateEntry(catalog, openFieldV9, fullRecordV9, validIrrigation({
    activity_code: 'tillage_soil_work',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [
      {
        attribute_code: 'attr.agroscope.operation', group_index: 0,
        value: 'agroscope.operation.primary_tillage', value_status: 'observed',
      },
      {
        attribute_code: 'attr.agroscope.device', group_index: 0,
        // Belongs to a different Agroscope operation, not primary_tillage.
        value: 'agroscope.device.mower', value_status: 'observed',
      },
    ],
  }));
  assert.equal(wrongDevice.ok, false);
  assert.ok(wrongDevice.errors.some((error) => error.code === 'invalid_under_dependency'));
});

// fertilization is Agroscope-covered (operation/device are visible, per
// full_record@9's operation_fields_by_activity) but NOT one of the 3
// required-device activities (decision 2) — an entry with no device/operation
// at all must still validate as savable.
test('validateEntry: full_record@9 fertilization validates without attr.agroscope.device (optional)', async () => {
  const { catalog } = await loadedFixture('agroscope-vocabulary-fertilization-v9');
  const fullRecordV9 = catalog.templates.get('full_record').get(9);
  const openFieldV9 = catalog.layouts.get('open_field').get(9);
  assert.ok(fullRecordV9, 'catalog must publish full_record@9');
  assert.ok(openFieldV9, 'catalog must publish open_field@9');

  const result = validateEntry(catalog, openFieldV9, fullRecordV9, validIrrigation({
    activity_code: 'fertilization',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [
      { attribute_code: 'attr.product', group_index: 0, value: 'NPK 15-15-15' },
      {
        attribute_code: 'attr.amount_mass_area_product', group_index: 0, value: 25,
        unit_code: 'unit.kg_per_ha_product',
      },
    ],
  }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(!result.errors?.some?.((error) => error.field === 'attr.agroscope.device'));
});

// Version-pinned control: an entry pinned to the frozen full_record@8 (and
// open_field@8, which carries no option_dependencies at all) never sees or
// requires the Agroscope operation/device pair — only NEW entries created
// against @9 get the detailed activity vocabulary.
test('validateEntry: full_record@8 tillage_soil_work has no device/operation requirement (version-pinned)', async () => {
  const { catalog } = await loadedFixture('agroscope-vocabulary-pinned-v8');
  const fullRecordV8 = catalog.templates.get('full_record').get(8);
  const openFieldV8 = catalog.layouts.get('open_field').get(8);
  assert.ok(fullRecordV8, 'catalog must publish full_record@8');
  assert.ok(openFieldV8, 'catalog must publish open_field@8');
  assert.deepEqual(JSON.parse(JSON.stringify(openFieldV8.definition.option_dependencies)), []);

  const result = validateEntry(catalog, openFieldV8, fullRecordV8, validIrrigation({
    activity_code: 'tillage_soil_work',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [],
  }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// Operation-level field/requirement/product scoping plan (2026-07-23, catalog
// v10, spec §0.7/§7): full_record@10's operation_requirements REPLACES
// activity_requirements[activity] once a semantically-present
// attr.agroscope.operation value resolves to an entry there.
// weed_mechanical's entry is deliberately empty ({required:[],required_any:[]}
// — maintainer decision, mechanical weeding has no meaningful product/dose)
// — an entry naming only the operation (no device, no product, no dose) must
// still validate, where the OLD activity-wide plant_protection_application
// requirement (device+operation required, product-or-dose required_any) would
// have rejected it.
test('validateEntry: full_record@10 weed_mechanical validates without product/dose (operation-level scoping)', async () => {
  const { catalog } = await loadedFixture('operation-scoping-weed-mechanical-v10');
  const fullRecordV10 = catalog.templates.get('full_record').get(10);
  const openFieldV9 = catalog.layouts.get('open_field').get(9);
  assert.ok(fullRecordV10, 'catalog must publish full_record@10');
  assert.ok(openFieldV9, 'catalog must publish open_field@9');
  assert.deepEqual(
    fullRecordV10.definition.operation_requirements['agroscope.operation.weed_mechanical'],
    { required: [], required_any: [] },
  );

  const result = validateEntry(catalog, openFieldV9, fullRecordV10, validIrrigation({
    activity_code: 'plant_protection_application',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [
      {
        attribute_code: 'attr.agroscope.operation', group_index: 0,
        value: 'agroscope.operation.weed_mechanical', value_status: 'observed',
      },
    ],
  }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// cleaning_cut's entry is also deliberately empty — no yield field exists for
// it at all (biomass stays on the field), so an entry naming only the
// operation must validate where the OLD activity-wide harvest requirement
// (crop + harvest_area + harvest_yield_area) would have rejected it for a
// missing yield.
test('validateEntry: full_record@10 cleaning_cut validates without a yield (operation-level scoping)', async () => {
  const { catalog } = await loadedFixture('operation-scoping-cleaning-cut-v10');
  const fullRecordV10 = catalog.templates.get('full_record').get(10);
  const openFieldV9 = catalog.layouts.get('open_field').get(9);
  assert.ok(fullRecordV10, 'catalog must publish full_record@10');
  assert.deepEqual(
    fullRecordV10.definition.operation_requirements['agroscope.operation.cleaning_cut'],
    { required: [], required_any: [] },
  );

  const result = validateEntry(catalog, openFieldV9, fullRecordV10, validIrrigation({
    activity_code: 'harvest',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [
      {
        attribute_code: 'attr.agroscope.operation', group_index: 0,
        value: 'agroscope.operation.cleaning_cut', value_status: 'observed',
      },
      {
        attribute_code: 'attr.agroscope.device', group_index: 0,
        value: 'agroscope.device.mower', value_status: 'observed',
      },
    ],
  }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// weed_herbicide (a chemical spray) keeps the strict requirement: device +
// operation required, plus a product-or-unregistered-product family and a
// mass-or-volume dose family — an entry with a valid operation+device pair
// but no product/dose must still be rejected exactly as full_record@9's
// activity-wide requirement rejected it.
test('validateEntry: full_record@10 weed_herbicide still rejects missing product+dose (operation-level scoping)', async () => {
  const { catalog } = await loadedFixture('operation-scoping-weed-herbicide-v10');
  const fullRecordV10 = catalog.templates.get('full_record').get(10);
  const openFieldV9 = catalog.layouts.get('open_field').get(9);
  assert.ok(fullRecordV10, 'catalog must publish full_record@10');

  const result = validateEntry(catalog, openFieldV9, fullRecordV10, validIrrigation({
    activity_code: 'plant_protection_application',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [
      {
        attribute_code: 'attr.agroscope.operation', group_index: 0,
        value: 'agroscope.operation.weed_herbicide', value_status: 'observed',
      },
      {
        attribute_code: 'attr.agroscope.device', group_index: 0,
        value: 'agroscope.device.sprayer_broadcast', value_status: 'observed',
      },
    ],
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'attr.product_uuid|attr.product'));
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.amount_mass_area_product|attr.amount_volume_area_product'));
});

// No attr.agroscope.operation value present at all -> operation_requirements
// is never consulted; full_record@10 must fall back to
// activity_requirements.fertilization UNCHANGED from @9 (product-or-
// unregistered-product family + a mass/volume/nutrient-rate dose family still
// enforced).
test('validateEntry: full_record@10 fertilization with no operation falls back to activity_requirements', async () => {
  const { catalog } = await loadedFixture('operation-scoping-fertilization-fallback-v10');
  const fullRecordV10 = catalog.templates.get('full_record').get(10);
  const openFieldV9 = catalog.layouts.get('open_field').get(9);
  assert.ok(fullRecordV10, 'catalog must publish full_record@10');

  const missingDose = validateEntry(catalog, openFieldV9, fullRecordV10, validIrrigation({
    activity_code: 'fertilization',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [],
  }));
  assert.equal(missingDose.ok, false);
  assert.ok(missingDose.errors.some((error) => error.field === 'attr.product_uuid|attr.product'));
  assert.ok(missingDose.errors.some((error) =>
    error.field === 'attr.amount_mass_area_product|attr.amount_volume_area_product|attr.amount_nutrient_rate'));

  const withDose = validateEntry(catalog, openFieldV9, fullRecordV10, validIrrigation({
    activity_code: 'fertilization',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [
      { attribute_code: 'attr.product', group_index: 0, value: 'NPK 15-15-15', value_status: 'observed' },
      {
        attribute_code: 'attr.amount_mass_area_product', group_index: 0, value: 25,
        unit_code: 'unit.kg_per_ha_product', value_status: 'observed',
      },
    ],
  }));
  assert.equal(withDose.ok, true, JSON.stringify(withDose.errors));
});

// Version-pinned control: an entry pinned to the frozen full_record@9 keeps
// v9's activity-wide harvest requirement (crop + harvest_area +
// harvest_yield_area) — only NEW entries created against @10 get
// per-operation scoping (e.g. cleaning_cut's empty requirement above).
test('validateEntry: full_record@9 harvest still requires a yield (version-pinned)', async () => {
  const { catalog } = await loadedFixture('operation-scoping-pinned-v9');
  const fullRecordV9 = catalog.templates.get('full_record').get(9);
  const openFieldV9 = catalog.layouts.get('open_field').get(9);
  assert.ok(fullRecordV9, 'catalog must publish full_record@9');
  assert.ok(!('operation_requirements' in fullRecordV9.definition),
    'frozen full_record@9 must not declare operation_requirements at all');

  const result = validateEntry(catalog, openFieldV9, fullRecordV9, validIrrigation({
    activity_code: 'harvest',
    template_code: 'full_record',
    layout_code: 'open_field',
    values: [
      { attribute_code: 'attr.crop', group_index: 0, value: 'choice.crop.other', value_status: 'observed' },
    ],
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) =>
    error.field === 'attr.harvest_yield_area' && error.code === 'required'));
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

// ===========================================================================
// Slice D Phase 2 — crop-cycle lifecycle + resolution (D0.1, D2.1, D2.2)
// ===========================================================================

// --- D0.1: precedence + the no-cycle / NULL-crop-zone_season invariant ---

test('(D0.1 invariant a) a real-crop covering zone_seasons row resolves a final entry exactly as before, with no crop cycle involved', async () => {
  const db = createJournalDb('cc-invariant-real-crop-season');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  makeZoneWithSeason(db, 901, cropCycleZoneUuid(1), '30000000-0000-4000-8000-000000000001', 'maize', 'Pioneer P9241');
  const plot = cropCyclePlotUuid(1);
  await makeCropCyclePlot(db, principal, plot, { zone_uuid: cropCycleZoneUuid(1) });

  const result = await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(1),
    plot_uuid: plot,
    occurred_start_local: '2026-07-05T09:00:00',
  }), principal, { mode: 'create' });
  assert.equal(result.sync_version, 1);

  const entry = readJournalEntryRow(db, cropCycleEntryUuid(1));
  assert.equal(entry.season_uuid, '30000000-0000-4000-8000-000000000001');
  assert.equal(entry.season_crop, 'maize');
  assert.equal(entry.season_variety, 'Pioneer P9241');
});

test('(D0.1 invariant b, part 1) a NULL-crop covering zone_seasons row no longer shadows an explicit input crop', async () => {
  const db = createJournalDb('cc-invariant-null-season-explicit');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  makeZoneWithSeason(db, 902, cropCycleZoneUuid(2), '30000000-0000-4000-8000-000000000002', null, null);
  const plot = cropCyclePlotUuid(2);
  await makeCropCyclePlot(db, principal, plot, { zone_uuid: cropCycleZoneUuid(2) });

  const result = await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(2),
    plot_uuid: plot,
    occurred_start_local: '2026-07-05T09:00:00',
    season_crop: 'ExplicitCrop',
    season_variety: 'ExplicitVariety',
  }), principal, { mode: 'create' });
  assert.equal(result.sync_version, 1);

  const entry = readJournalEntryRow(db, cropCycleEntryUuid(2));
  assert.equal(entry.season_uuid, null, 'the NULL-crop season no longer attaches once an explicit crop is given');
  assert.equal(entry.season_crop, 'ExplicitCrop');
  assert.equal(entry.season_variety, 'ExplicitVariety');
});

test('(D0.1 invariant b, part 2) a NULL-crop covering zone_seasons row no longer shadows an open crop cycle', async () => {
  const db = createJournalDb('cc-invariant-null-season-cycle');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  makeZoneWithSeason(db, 903, cropCycleZoneUuid(3), '30000000-0000-4000-8000-000000000003', null, null);
  const plot = cropCyclePlotUuid(3);
  await makeCropCyclePlot(db, principal, plot, { zone_uuid: cropCycleZoneUuid(3) });

  const result = await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(3),
    plot_uuid: plot,
    occurred_start_local: '2026-07-06T09:00:00',
  }), principal, { mode: 'create' });
  assert.equal(result.sync_version, 1);

  // Deferred at write time (an open cycle covers, so season_crop is NOT
  // stamped from the NULL-crop season -- it used to be, unconditionally).
  const stored = readJournalEntryRow(db, cropCycleEntryUuid(3));
  assert.equal(stored.season_uuid, null);
  assert.equal(stored.season_crop, null);

  // Live read confirms the cycle -- not the NULL season -- is authoritative.
  const listed = await listEntries(db, { plot_uuid: plot, status: 'final' }, principal);
  const liveEntry = listed.entries.find((entry) => entry.entry_uuid === cropCycleEntryUuid(3));
  assert.equal(liveEntry.season_crop, 'agroscope.crop.wheat_winter');
  assert.equal(liveEntry.season_variety, 'Runal');
});

test('(D0.1, legacy parity) a NULL-crop covering zone_seasons row still attaches season_uuid when nothing else resolves a crop', async () => {
  const db = createJournalDb('cc-null-season-legacy-attach');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  makeZoneWithSeason(db, 904, cropCycleZoneUuid(4), '30000000-0000-4000-8000-000000000004', null, null);
  const plot = cropCyclePlotUuid(4);
  await makeCropCyclePlot(db, principal, plot, { zone_uuid: cropCycleZoneUuid(4) });

  const result = await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(4),
    plot_uuid: plot,
    occurred_start_local: '2026-07-05T09:00:00',
  }), principal, { mode: 'create' });
  assert.equal(result.sync_version, 1);

  const entry = readJournalEntryRow(db, cropCycleEntryUuid(4));
  assert.equal(entry.season_uuid, '30000000-0000-4000-8000-000000000004', 'season_uuid attachment preserved exactly as before');
  assert.equal(entry.season_crop, null);
  assert.equal(entry.season_variety, null);
});

test('(D0.1, tier 4) journal_plots.crop_hint resolves a season when no zone, cycle, or explicit crop is available', async () => {
  const db = createJournalDb('cc-crop-hint-tier');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(5);
  await makeCropCyclePlot(db, principal, plot, { crop_hint: 'HintedCrop' });

  const result = await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(5),
    plot_uuid: plot,
    occurred_start_local: '2026-07-05T09:00:00',
  }), principal, { mode: 'create' });
  assert.equal(result.sync_version, 1);

  const entry = readJournalEntryRow(db, cropCycleEntryUuid(5));
  assert.equal(entry.season_uuid, null);
  assert.equal(entry.season_crop, 'HintedCrop');
  assert.equal(entry.season_variety, null);
});

// --- D2.1: seeding opens/continues/reseeds a cycle -----------------------

test('a final seeding entry opens a crop cycle and defers its own season_crop/variety', async () => {
  const db = createJournalDb('cc-seeding-opens-cycle');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(10);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(10),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });

  const memberships = readCycleMemberships(db, plot);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].crop_code, 'agroscope.crop.wheat_winter');
  assert.equal(memberships[0].variety, 'Runal');
  assert.equal(memberships[0].ends_on, null);
  assert.equal(readJournalEntryRow(db, cropCycleEntryUuid(10)).season_crop, null, 'deferred, not stamped');
});

test('a second same-crop-and-variety seeding with no cycle_action defaults to continuing the open cycle', async () => {
  const db = createJournalDb('cc-seeding-default-continue');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(11);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(11),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  const openCycleUuid = readCycleMemberships(db, plot)[0].cycle_uuid;

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(12),
    plot_uuid: plot,
    occurred_start_local: '2026-04-15T09:00:00',
  }), principal, { mode: 'create' });

  const memberships = readCycleMemberships(db, plot);
  assert.equal(memberships.length, 1, 'no second cycle was opened');
  assert.equal(memberships[0].cycle_uuid, openCycleUuid, 'the same cycle continues');
  assert.equal(memberships[0].ends_on, null);
});

test('cycle_action=new opens a fresh cycle even when the seeded crop and variety match the open one', async () => {
  const db = createJournalDb('cc-seeding-cycle-action-new');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(13);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(13),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  const priorCycleUuid = readCycleMemberships(db, plot)[0].cycle_uuid;

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(14),
    plot_uuid: plot,
    occurred_start_local: '2026-04-20T09:00:00',
    cycle_action: 'new',
  }), principal, { mode: 'create' });

  const memberships = readCycleMemberships(db, plot);
  assert.equal(memberships.length, 2);
  const prior = memberships.find((row) => row.cycle_uuid === priorCycleUuid);
  const fresh = memberships.find((row) => row.cycle_uuid !== priorCycleUuid);
  assert.equal(prior.ends_on, '2026-04-20');
  assert.equal(prior.close_reason, 'reseed');
  assert.equal(fresh.ends_on, null, 'the explicit new cycle is open');
});

test('a differing-crop seeding auto-closes the prior open cycle as a reseed and opens a new one', async () => {
  const db = createJournalDb('cc-seeding-reseed-differing-crop');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(15);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(15),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(16),
    plot_uuid: plot,
    occurred_start_local: '2026-06-01T09:00:00',
    values: [
      { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.soybean', value_status: 'observed' },
      { attribute_code: 'attr.variety', group_index: 0, value: 'Asgrow', value_status: 'observed' },
    ],
  }), principal, { mode: 'create' });

  const memberships = readCycleMemberships(db, plot);
  assert.equal(memberships.length, 2);
  const wheat = memberships.find((row) => row.crop_code === 'agroscope.crop.wheat_winter');
  const soy = memberships.find((row) => row.crop_code === 'agroscope.crop.soybean');
  assert.equal(wheat.ends_on, '2026-06-01');
  assert.equal(wheat.close_reason, 'reseed');
  assert.equal(soy.ends_on, null);
});

// --- D2.1/D10/R7: harvest closes only the covering (or named) cycle -----

test('harvest closes only the covering cycle and freezes every deferred entry in its span', async () => {
  const db = createJournalDb('cc-harvest-closes-and-freezes');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(20);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(20),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(21),
    plot_uuid: plot,
    occurred_start_local: '2026-05-01T09:00:00',
  }), principal, { mode: 'create' });
  assert.equal(readJournalEntryRow(db, cropCycleEntryUuid(21)).season_crop, null, 'deferred while open');

  const beforeVersion = currentSyncVersion(db, cropCycleEntryUuid(21));
  await saveEntry(db, harvestInput({
    entry_uuid: cropCycleEntryUuid(22),
    plot_uuid: plot,
    occurred_start_local: '2026-08-01T09:00:00',
  }), principal, { mode: 'create' });

  const membership = readCycleMemberships(db, plot)[0];
  assert.equal(membership.ends_on, '2026-08-01');
  assert.equal(membership.close_reason, 'harvest');
  assert.equal(membership.closed_by_entry_uuid, cropCycleEntryUuid(22));

  const irrigation = readJournalEntryRow(db, cropCycleEntryUuid(21));
  assert.equal(irrigation.season_crop, 'agroscope.crop.wheat_winter', 'frozen at harvest close');
  assert.equal(irrigation.season_variety, 'Runal');
  assert.ok(irrigation.sync_version > beforeVersion, 'freezing bumps sync_version so the frozen value syncs');

  const seeding = readJournalEntryRow(db, cropCycleEntryUuid(20));
  assert.equal(seeding.season_crop, 'agroscope.crop.wheat_winter', 'the seeding entry itself is frozen too');
});

test('harvest on a plot with no open cycle is a no-op, not an error', async () => {
  const db = createJournalDb('cc-harvest-no-cycle');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(23);
  await makeCropCyclePlot(db, principal, plot, { crop_hint: 'PerennialGrassland' });

  const result = await saveEntry(db, harvestInput({
    entry_uuid: cropCycleEntryUuid(23),
    plot_uuid: plot,
    occurred_start_local: '2026-08-01T09:00:00',
  }), principal, { mode: 'create' });
  assert.equal(result.sync_version, 1);
  assert.equal(readCycleMemberships(db, plot).length, 0);
});

test('harvest on an intercropped plot requires cycle_uuid to disambiguate, and names one to close', async () => {
  const db = createJournalDb('cc-harvest-intercrop-disambiguation');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(24);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(24),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  // Simulate a genuinely intercropped plot: a second concurrently open cycle
  // covering the same plot, inserted directly (normal seeding always closes
  // a differing-crop cycle, so this schema state can't arise via seeding
  // alone -- but the schema explicitly allows it, per spec D12).
  const secondCycleUuid = '80000000-0000-4000-8000-000000000001';
  db.prepare(
    'INSERT INTO journal_crop_cycles(cycle_uuid,crop_code,variety,group_uuid,opened_by_entry_uuid,starts_on,' +
      'gateway_device_eui,created_by_principal_uuid,sync_version,created_at,updated_at,deleted_at) ' +
    'VALUES (?,?,?,NULL,?,?,?,?,0,?,?,NULL)'
  ).run(
    secondCycleUuid, 'agroscope.crop.soybean', 'Asgrow', cropCycleEntryUuid(24), '2026-04-01',
    JOURNAL_TEST_GATEWAY_EUI, JOURNAL_TEST_OWNER_UUID, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'
  );
  db.prepare(
    'INSERT INTO journal_crop_cycle_plots(cycle_uuid,plot_uuid,ends_on,closed_by_entry_uuid,close_reason) ' +
    'VALUES (?,?,NULL,NULL,NULL)'
  ).run(secondCycleUuid, plot);

  await assert.rejects(
    saveEntry(db, harvestInput({
      entry_uuid: cropCycleEntryUuid(25),
      plot_uuid: plot,
      occurred_start_local: '2026-08-01T09:00:00',
    }), principal, { mode: 'create' }),
    (error) => error && error.code === 'cycle_uuid_required'
  );
  assert.equal(readCycleMemberships(db, plot).filter((row) => row.ends_on == null).length, 2, 'nothing closed');

  await saveEntry(db, harvestInput({
    entry_uuid: cropCycleEntryUuid(26),
    plot_uuid: plot,
    occurred_start_local: '2026-08-01T09:00:00',
    cycle_uuid: secondCycleUuid,
  }), principal, { mode: 'create' });

  const memberships = readCycleMemberships(db, plot);
  const closed = memberships.find((row) => row.cycle_uuid === secondCycleUuid);
  const stillOpen = memberships.find((row) => row.cycle_uuid !== secondCycleUuid);
  assert.equal(closed.ends_on, '2026-08-01');
  assert.equal(closed.close_reason, 'harvest');
  assert.equal(stillOpen.ends_on, null, 'the un-named cycle stays open');
});

// --- R3: manual close -----------------------------------------------------

test('a tillage_soil_work entry with ends_crop_cycle:true closes the covering cycle', async () => {
  const db = createJournalDb('cc-manual-close');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(30);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(30),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });

  await saveEntry(db, tillageInput({
    entry_uuid: cropCycleEntryUuid(31),
    plot_uuid: plot,
    occurred_start_local: '2026-05-15T09:00:00',
    ends_crop_cycle: true,
  }), principal, { mode: 'create' });

  const membership = readCycleMemberships(db, plot)[0];
  assert.equal(membership.ends_on, '2026-05-15');
  assert.equal(membership.close_reason, 'manual');
  assert.equal(membership.closed_by_entry_uuid, cropCycleEntryUuid(31));
});

test('ends_crop_cycle:true throws a clear error when no open crop cycle covers the plot', async () => {
  const db = createJournalDb('cc-manual-close-no-cycle');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(32);
  await makeCropCyclePlot(db, principal, plot, { crop_hint: 'CoverCrop' });

  await assert.rejects(
    saveEntry(db, tillageInput({
      entry_uuid: cropCycleEntryUuid(32),
      plot_uuid: plot,
      occurred_start_local: '2026-05-15T09:00:00',
      ends_crop_cycle: true,
    }), principal, { mode: 'create' }),
    (error) => error && error.code === 'no_open_cycle'
  );
});

// --- D2.2: live-vs-frozen resolution --------------------------------------

test('a backdated seeding retroactively covers an earlier entry in the live read path', async () => {
  const db = createJournalDb('cc-backdated-seeding-retroactive');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(40);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(40),
    plot_uuid: plot,
    occurred_start_local: '2026-07-15T09:00:00',
    season_crop: 'OldCropFallback',
  }), principal, { mode: 'create' });
  assert.equal(readJournalEntryRow(db, cropCycleEntryUuid(40)).season_crop, 'OldCropFallback');

  // Backdated: starts_on precedes the already-logged irrigation entry above.
  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(41),
    plot_uuid: plot,
    occurred_start_local: '2026-07-01T09:00:00',
  }), principal, { mode: 'create' });

  assert.equal(
    readJournalEntryRow(db, cropCycleEntryUuid(40)).season_crop,
    'OldCropFallback',
    'the stored column is untouched -- retroactivity is a read-time effect, not a rewrite'
  );

  const listed = await listEntries(db, { plot_uuid: plot, status: 'final' }, principal);
  const liveEarlier = listed.entries.find((entry) => entry.entry_uuid === cropCycleEntryUuid(40));
  assert.equal(liveEarlier.season_crop, 'agroscope.crop.wheat_winter', 'now resolves live from the backdated cycle');
  assert.equal(liveEarlier.season_variety, 'Runal');
});

test('correcting a seeding crop/variety updates the open cycle and propagates live with no per-entry rewrite', async () => {
  const db = createJournalDb('cc-correction-propagates');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(42);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(42),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(43),
    plot_uuid: plot,
    occurred_start_local: '2026-04-10T09:00:00',
  }), principal, { mode: 'create' });

  await saveEntry(db, seedingInput({
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
    base_sync_version: 1,
    values: [
      { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.rye_winter', value_status: 'observed' },
      { attribute_code: 'attr.variety', group_index: 0, value: 'Corrected', value_status: 'observed' },
    ],
  }), principal, { mode: 'update', entryUuid: cropCycleEntryUuid(42) });

  const membership = readCycleMemberships(db, plot)[0];
  assert.equal(membership.crop_code, 'agroscope.crop.rye_winter');
  assert.equal(membership.variety, 'Corrected');

  const listed = await listEntries(db, { plot_uuid: plot, status: 'final' }, principal);
  const liveIrrigation = listed.entries.find((entry) => entry.entry_uuid === cropCycleEntryUuid(43));
  assert.equal(liveIrrigation.season_crop, 'agroscope.crop.rye_winter');
  assert.equal(liveIrrigation.season_variety, 'Corrected');
});

// --- D13/R7: void cascades -------------------------------------------------

test('voiding a seeding with dependent entries requires cascade_ack, then soft-deletes the cycle', async () => {
  const db = createJournalDb('cc-void-seeding-dependents');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(50);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(50),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(51),
    plot_uuid: plot,
    occurred_start_local: '2026-04-10T09:00:00',
  }), principal, { mode: 'create' });

  await assert.rejects(
    void_(db, null, cropCycleEntryUuid(50), 1, 'testing void without ack', principal),
    (error) => error && error.code === 'cycle_has_dependents' &&
      error.details.dependentEntryUuids.includes(cropCycleEntryUuid(51))
  );
  assert.equal(readCycleMemberships(db, plot)[0].cycle_deleted_at, null, 'nothing changed on the rejected attempt');

  await void_(db, null, cropCycleEntryUuid(50), 1, 'testing void with ack', principal, { cascade_ack: true });
  assert.ok(readCycleMemberships(db, plot)[0].cycle_deleted_at, 'cycle soft-deleted once acknowledged');
});

test('voidEntry (api.js) passes cascade_ack through to the void cascade', async () => {
  const db = createJournalDb('cc-void-entry-api-cascade-ack');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(52);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(52),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(53),
    plot_uuid: plot,
    occurred_start_local: '2026-04-10T09:00:00',
  }), principal, { mode: 'create' });

  const { voidEntry } = require('./index');
  await assert.rejects(
    voidEntry(db, cropCycleEntryUuid(52), { base_sync_version: 1, reason: 'no ack' }, principal),
    (error) => error && error.code === 'cycle_has_dependents'
  );
  await voidEntry(
    db, cropCycleEntryUuid(52), { base_sync_version: 1, reason: 'with ack', cascade_ack: true }, principal
  );
  assert.ok(readCycleMemberships(db, plot)[0].cycle_deleted_at);
});

test('voiding a harvest reopens the cycle and un-freezes the entries it froze', async () => {
  const db = createJournalDb('cc-void-harvest-reopens');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(60);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(60),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, irrigationInput({
    entry_uuid: cropCycleEntryUuid(61),
    plot_uuid: plot,
    occurred_start_local: '2026-04-10T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, harvestInput({
    entry_uuid: cropCycleEntryUuid(62),
    plot_uuid: plot,
    occurred_start_local: '2026-07-01T09:00:00',
  }), principal, { mode: 'create' });
  assert.equal(readJournalEntryRow(db, cropCycleEntryUuid(61)).season_crop, 'agroscope.crop.wheat_winter');

  const harvestVersion = currentSyncVersion(db, cropCycleEntryUuid(62));
  await void_(db, null, cropCycleEntryUuid(62), harvestVersion, 'undo the harvest', principal);

  const membership = readCycleMemberships(db, plot)[0];
  assert.equal(membership.ends_on, null, 'reopened');
  assert.equal(membership.close_reason, null);
  assert.equal(membership.closed_by_entry_uuid, null);
  assert.equal(readJournalEntryRow(db, cropCycleEntryUuid(61)).season_crop, null, 'un-frozen back to deferred/live');
});

test('voiding a harvest refuses with a clear error when a reseed already opened a new cycle on the plot', async () => {
  const db = createJournalDb('cc-void-harvest-collision');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(63);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(63),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, harvestInput({
    entry_uuid: cropCycleEntryUuid(64),
    plot_uuid: plot,
    occurred_start_local: '2026-07-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(65),
    plot_uuid: plot,
    occurred_start_local: '2026-07-05T09:00:00',
    values: [
      { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.barley_spring', value_status: 'observed' },
      { attribute_code: 'attr.variety', group_index: 0, value: 'Golden', value_status: 'observed' },
    ],
  }), principal, { mode: 'create' });

  const harvestVersion = currentSyncVersion(db, cropCycleEntryUuid(64));
  await assert.rejects(
    void_(db, null, cropCycleEntryUuid(64), harvestVersion, 'undo after reseed', principal),
    (error) => error && error.code === 'reopen_collision'
  );
  assert.equal(readCycleMemberships(db, plot).find((row) => row.close_reason === 'harvest').ends_on, '2026-07-01');
});

// --- Review fixes (B1/B2/S1/S2) -------------------------------------------
//
// B1: the entry that closes/opens a cycle (harvest, manual-close, or a
// reseeding seeding) must never be frozen behind its own back by its own
// cascade -- freezeClosedSpan now excludes that triggering entry_uuid
// unconditionally (see closeCycleMembership), and createFinalInTransaction/
// promoteDraftInTransaction/void_ all re-read sync_version after the
// cascade runs so the returned/ACK'd version always matches the DB.

test(
  'a cycle-closing harvest returns the entry\'s true post-cascade sync_version and emits one coherent outbox event',
  async () => {
    const db = createJournalDb('cc-b1-harvest-self-freeze-fix');
    seedJournalTestIdentity(db);
    const principal = journalTestPrincipal();
    const plot = cropCyclePlotUuid(100);
    await makeCropCyclePlot(db, principal, plot);

    await saveEntry(db, seedingInput({
      entry_uuid: cropCycleEntryUuid(100),
      plot_uuid: plot,
      occurred_start_local: '2026-04-01T09:00:00',
    }), principal, { mode: 'create' });

    const harvestUuid = cropCycleEntryUuid(101);
    const result = await saveEntry(db, harvestInput({
      entry_uuid: harvestUuid,
      plot_uuid: plot,
      occurred_start_local: '2026-08-01T09:00:00',
    }), principal, { mode: 'create' });

    assert.equal(
      result.sync_version,
      currentSyncVersion(db, harvestUuid),
      'the returned version must match the DB after the close cascade ran'
    );
    assert.equal(result.sync_version, 1, 'closing its own covering cycle must not bump the harvest entry\'s own version');

    const outboxRows = db.prepare(
      "SELECT sync_version FROM sync_outbox WHERE aggregate_key=? AND op='JOURNAL_ENTRY_UPSERTED'"
    ).all(harvestUuid);
    assert.equal(outboxRows.length, 1, 'exactly one outbox event for the harvest entry itself (no missing-v1/duplicate-v2 pair)');
    assert.equal(outboxRows[0].sync_version, 1);

    const membership = readCycleMemberships(db, plot)[0];
    assert.equal(membership.ends_on, '2026-08-01');
    assert.equal(membership.close_reason, 'harvest');
  }
);

test('a batch harvest that closes cycles is idempotently retryable (B1)', async () => {
  const db = createJournalDb('cc-b1-batch-harvest-retry');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plotA = cropCyclePlotUuid(102);
  const plotB = cropCyclePlotUuid(103);
  await makeCropCyclePlot(db, principal, plotA);
  await makeCropCyclePlot(db, principal, plotB);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(102),
    plot_uuid: plotA,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(103),
    plot_uuid: plotB,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });

  const batch = {
    status: 'final',
    base_sync_version: 0,
    members: [
      { plot_uuid: plotA, entry_uuid: cropCycleEntryUuid(104) },
      { plot_uuid: plotB, entry_uuid: cropCycleEntryUuid(105) },
    ],
    activity_code: 'harvest',
    template_code: 'farmer_quick',
    template_version: 3,
    layout_code: 'open_field',
    layout_version: 3,
    occurred_start_local: '2026-08-01T09:00:00',
    occurred_timezone: 'Europe/Zurich',
    values: [],
  };

  const first = await saveEntry(db, batch, principal, { mode: 'create' });
  assert.ok(
    first.entries.every((entry) => entry.sync_version === 1),
    'each closing entry keeps its own version 1 (existingBatchRetry requires exactly this)'
  );

  const entriesBeforeRetry = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  const outboxBeforeRetry = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  const retry = await saveEntry(db, batch, principal, { mode: 'create' });

  assert.deepEqual(retry.entries, first.entries, 'the retry returns the original receipts unchanged');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entriesBeforeRetry, 'no new entry rows');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, outboxBeforeRetry, 'no new outbox rows');

  assert.equal(readCycleMemberships(db, plotA)[0].ends_on, '2026-08-01');
  assert.equal(readCycleMemberships(db, plotB)[0].ends_on, '2026-08-01');
});

test(
  'a differing-crop reseed leaves the new seeding entry\'s stored season_crop NULL, not the old crop (B1)',
  async () => {
    const db = createJournalDb('cc-b1-reseed-no-mis-stamp');
    seedJournalTestIdentity(db);
    const principal = journalTestPrincipal();
    const plot = cropCyclePlotUuid(106);
    await makeCropCyclePlot(db, principal, plot);

    await saveEntry(db, seedingInput({
      entry_uuid: cropCycleEntryUuid(106),
      plot_uuid: plot,
      occurred_start_local: '2026-04-01T09:00:00',
    }), principal, { mode: 'create' });

    const reseedUuid = cropCycleEntryUuid(107);
    const result = await saveEntry(db, seedingInput({
      entry_uuid: reseedUuid,
      plot_uuid: plot,
      occurred_start_local: '2026-06-01T09:00:00',
      values: [
        { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.soybean', value_status: 'observed' },
        { attribute_code: 'attr.variety', group_index: 0, value: 'Asgrow', value_status: 'observed' },
      ],
    }), principal, { mode: 'create' });

    assert.equal(result.sync_version, 1, 'the reseeding entry keeps its own version 1');
    const reseedRow = readJournalEntryRow(db, reseedUuid);
    assert.equal(reseedRow.season_crop, null, 'deferred -- NOT mis-stamped with the closing (old) crop');
    assert.equal(reseedRow.season_variety, null);

    const memberships = readCycleMemberships(db, plot);
    const wheat = memberships.find((row) => row.crop_code === 'agroscope.crop.wheat_winter');
    const soy = memberships.find((row) => row.crop_code === 'agroscope.crop.soybean');
    assert.equal(wheat.ends_on, '2026-06-01');
    assert.equal(wheat.close_reason, 'reseed');
    assert.equal(soy.ends_on, null);
  }
);

// B2: an intercropped plot (>1 open cycle) must never have a seeding/reseed
// blanket-close every open cycle, or (for a same-crop continue) close
// whichever OTHER co-cropped cycle also covers the plot -- it must demand an
// explicit cycle_uuid, exactly like harvest/manual-close.

test(
  'a seeding on an intercropped plot requires cycle_uuid, and closes only the named cycle (B2)',
  async () => {
    const db = createJournalDb('cc-b2-seeding-intercrop-disambiguation');
    seedJournalTestIdentity(db);
    const principal = journalTestPrincipal();
    const plot = cropCyclePlotUuid(110);
    await makeCropCyclePlot(db, principal, plot);

    await saveEntry(db, seedingInput({
      entry_uuid: cropCycleEntryUuid(110),
      plot_uuid: plot,
      occurred_start_local: '2026-04-01T09:00:00',
    }), principal, { mode: 'create' });
    // Simulate a genuinely intercropped plot the same way the harvest
    // disambiguation test does: direct-insert a second concurrently open
    // cycle (normal seeding always collapses to a single membership, so
    // this state can't arise via seeding alone -- but the schema allows it).
    const secondCycleUuid = '80000000-0000-4000-8000-000000000010';
    db.prepare(
      'INSERT INTO journal_crop_cycles(cycle_uuid,crop_code,variety,group_uuid,opened_by_entry_uuid,starts_on,' +
        'gateway_device_eui,created_by_principal_uuid,sync_version,created_at,updated_at,deleted_at) ' +
      'VALUES (?,?,?,NULL,?,?,?,?,0,?,?,NULL)'
    ).run(
      secondCycleUuid, 'agroscope.crop.soybean', 'Asgrow', cropCycleEntryUuid(110), '2026-04-01',
      JOURNAL_TEST_GATEWAY_EUI, JOURNAL_TEST_OWNER_UUID, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'
    );
    db.prepare(
      'INSERT INTO journal_crop_cycle_plots(cycle_uuid,plot_uuid,ends_on,closed_by_entry_uuid,close_reason) ' +
      'VALUES (?,?,NULL,NULL,NULL)'
    ).run(secondCycleUuid, plot);

    await assert.rejects(
      saveEntry(db, seedingInput({
        entry_uuid: cropCycleEntryUuid(111),
        plot_uuid: plot,
        occurred_start_local: '2026-06-01T09:00:00',
        values: [
          { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.maize_grain', value_status: 'observed' },
          { attribute_code: 'attr.variety', group_index: 0, value: 'Pioneer', value_status: 'observed' },
        ],
      }), principal, { mode: 'create' }),
      (error) => error && error.code === 'cycle_uuid_required'
    );
    assert.equal(
      readCycleMemberships(db, plot).filter((row) => row.ends_on == null).length,
      2,
      'nothing closed -- no blanket-close'
    );

    await saveEntry(db, seedingInput({
      entry_uuid: cropCycleEntryUuid(112),
      plot_uuid: plot,
      occurred_start_local: '2026-06-01T09:00:00',
      cycle_uuid: secondCycleUuid,
      values: [
        { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.maize_grain', value_status: 'observed' },
        { attribute_code: 'attr.variety', group_index: 0, value: 'Pioneer', value_status: 'observed' },
      ],
    }), principal, { mode: 'create' });

    const memberships = readCycleMemberships(db, plot);
    const closed = memberships.find((row) => row.cycle_uuid === secondCycleUuid);
    const untouchedWheat = memberships.find((row) => row.crop_code === 'agroscope.crop.wheat_winter');
    const maize = memberships.find((row) => row.crop_code === 'agroscope.crop.maize_grain');
    assert.equal(closed.ends_on, '2026-06-01');
    assert.equal(closed.close_reason, 'reseed');
    assert.equal(untouchedWheat.ends_on, null, 'the un-named wheat cycle stays open, untouched');
    assert.ok(maize && maize.ends_on == null, 'the new maize cycle opened');
  }
);

// S1: the single-entry aggregate load must live-resolve a deferred crop just
// like the list path does, instead of returning the stored (blank) columns.

test('a single-entry aggregate fetch live-resolves a deferred crop (S1)', async () => {
  const db = createJournalDb('cc-s1-single-fetch-live-crop');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(120);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(120),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  const irrigationUuid = cropCycleEntryUuid(121);
  await saveEntry(db, irrigationInput({
    entry_uuid: irrigationUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-05-01T09:00:00',
  }), principal, { mode: 'create' });

  assert.equal(readJournalEntryRow(db, irrigationUuid).season_crop, null, 'deferred in storage');

  const aggregate = await loadCurrentAggregate(db, 'UPSERT_JOURNAL_ENTRY', irrigationUuid, principal);
  assert.equal(aggregate.season_crop, 'agroscope.crop.wheat_winter', 'single fetch live-resolves the deferred crop');
  assert.equal(aggregate.season_variety, 'Runal');
});

// S2: correcting an entry that opened or closed a crop cycle must be
// rejected outright when it would leave cycle state inconsistent, rather
// than silently desyncing journal_crop_cycle(_plots).

test('correcting a harvest\'s occurred date is rejected when it closed a cycle (S2)', async () => {
  const db = createJournalDb('cc-s2-harvest-date-desync');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(130);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(130),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  const harvestUuid = cropCycleEntryUuid(131);
  await saveEntry(db, harvestInput({
    entry_uuid: harvestUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-08-01T09:00:00',
  }), principal, { mode: 'create' });

  await assert.rejects(
    saveEntry(db, harvestInput({
      plot_uuid: plot,
      occurred_start_local: '2026-08-05T09:00:00',
      base_sync_version: currentSyncVersion(db, harvestUuid),
    }), principal, { mode: 'update', entryUuid: harvestUuid }),
    (error) => error && error.code === 'correction_would_desync_cycle'
  );
  assert.equal(readCycleMemberships(db, plot)[0].ends_on, '2026-08-01', 'ends_on is untouched');
  assert.equal(currentSyncVersion(db, harvestUuid), 1, 'the rejected correction did not write anything');
});

test('correcting a seeding\'s occurred date is rejected because it would move starts_on (S2)', async () => {
  const db = createJournalDb('cc-s2-seeding-date-desync');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(132);
  await makeCropCyclePlot(db, principal, plot);

  const seedUuid = cropCycleEntryUuid(132);
  await saveEntry(db, seedingInput({
    entry_uuid: seedUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });

  await assert.rejects(
    saveEntry(db, seedingInput({
      plot_uuid: plot,
      occurred_start_local: '2026-04-05T09:00:00',
      base_sync_version: currentSyncVersion(db, seedUuid),
    }), principal, { mode: 'update', entryUuid: seedUuid }),
    (error) => error && error.code === 'correction_would_desync_cycle'
  );
  assert.equal(readCycleMemberships(db, plot)[0].starts_on, '2026-04-01', 'starts_on is untouched');
});

test(
  'correcting a seeding\'s crop after its cycle already closed is rejected (S2, split-brain guard)',
  async () => {
    const db = createJournalDb('cc-s2-seeding-crop-after-close');
    seedJournalTestIdentity(db);
    const principal = journalTestPrincipal();
    const plot = cropCyclePlotUuid(134);
    await makeCropCyclePlot(db, principal, plot);

    const seedUuid = cropCycleEntryUuid(134);
    await saveEntry(db, seedingInput({
      entry_uuid: seedUuid,
      plot_uuid: plot,
      occurred_start_local: '2026-04-01T09:00:00',
    }), principal, { mode: 'create' });
    await saveEntry(db, harvestInput({
      entry_uuid: cropCycleEntryUuid(135),
      plot_uuid: plot,
      occurred_start_local: '2026-08-01T09:00:00',
    }), principal, { mode: 'create' });

    await assert.rejects(
      saveEntry(db, seedingInput({
        plot_uuid: plot,
        occurred_start_local: '2026-04-01T09:00:00',
        base_sync_version: currentSyncVersion(db, seedUuid),
        values: [
          { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.rye_winter', value_status: 'observed' },
          { attribute_code: 'attr.variety', group_index: 0, value: 'Corrected', value_status: 'observed' },
        ],
      }), principal, { mode: 'update', entryUuid: seedUuid }),
      (error) => error && error.code === 'correction_would_desync_cycle'
    );
    const membership = readCycleMemberships(db, plot)[0];
    assert.equal(
      membership.crop_code,
      'agroscope.crop.wheat_winter',
      'the closed cycle keeps its original crop -- the rejected correction never wrote anything'
    );
  }
);

test('correcting a seeding\'s crop/variety while its cycle is STILL open remains allowed (S2 scope check)', async () => {
  const db = createJournalDb('cc-s2-still-open-allowed');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(136);
  await makeCropCyclePlot(db, principal, plot);

  const seedUuid = cropCycleEntryUuid(136);
  await saveEntry(db, seedingInput({
    entry_uuid: seedUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });

  await saveEntry(db, seedingInput({
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
    base_sync_version: currentSyncVersion(db, seedUuid),
    values: [
      { attribute_code: 'attr.crop', group_index: 0, value: 'agroscope.crop.rye_winter', value_status: 'observed' },
      { attribute_code: 'attr.variety', group_index: 0, value: 'Corrected', value_status: 'observed' },
    ],
  }), principal, { mode: 'update', entryUuid: seedUuid });

  const membership = readCycleMemberships(db, plot)[0];
  assert.equal(membership.crop_code, 'agroscope.crop.rye_winter');
  assert.equal(membership.variety, 'Corrected');
});

// --- Slice D hardening (P1-a/P1-b/P2-b): authoritative active-crop-cycle
// read on the plot payload, and closed-crop display on the closing entry ---
//
// Root cause (2026-07-19 live UX test): the GUI had no authoritative "what
// is this plot's OPEN crop cycle as-of a date" read, so it inferred crop
// from past entries' season_crop -- date-agnostic and open/closed-agnostic.
// listPlots/upsertPlot now project active_crop_cycles (0, 1, or >1 open
// journal_crop_cycle_plots memberships covering the plot as of today), and
// the entry read path resolves a closing entry's display crop from the
// cycle it closed. See osi-journal/lifecycle.js activeCropCyclesForPlot /
// resolveClosedCropCycleOverrides.

test('listPlots active_crop_cycles is empty for a plot with no seeding yet', async () => {
  const db = createJournalDb('cc-hardening-active-crop-none');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(400);
  await makeCropCyclePlot(db, principal, plot);

  const { plots } = await listPlots(db, principal);
  const found = plots.find((row) => row.plot_uuid === plot);
  assert.deepEqual(found.active_crop_cycles, []);
});

test('listPlots active_crop_cycles reports the single open cycle after seeding, with the fields the GUI needs', async () => {
  const db = createJournalDb('cc-hardening-active-crop-one');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(401);
  await makeCropCyclePlot(db, principal, plot);
  const seedUuid = cropCycleEntryUuid(401);

  await saveEntry(db, seedingInput({
    entry_uuid: seedUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });

  const { plots } = await listPlots(db, principal);
  const found = plots.find((row) => row.plot_uuid === plot);
  assert.equal(found.active_crop_cycles.length, 1);
  const [cycle] = found.active_crop_cycles;
  assert.equal(cycle.crop_code, 'agroscope.crop.wheat_winter');
  assert.equal(cycle.variety, 'Runal');
  assert.equal(cycle.seeded_on, '2026-04-01');
  assert.equal(cycle.opened_by_entry_uuid, seedUuid);
  assert.equal(typeof cycle.cycle_uuid, 'string');
});

test('listPlots active_crop_cycles reverts to empty once the cycle is harvested (closed)', async () => {
  const db = createJournalDb('cc-hardening-active-crop-closed');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(402);
  await makeCropCyclePlot(db, principal, plot);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(402),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, harvestInput({
    entry_uuid: cropCycleEntryUuid(403),
    plot_uuid: plot,
    occurred_start_local: '2026-08-01T09:00:00',
  }), principal, { mode: 'create' });

  const { plots } = await listPlots(db, principal);
  const found = plots.find((row) => row.plot_uuid === plot);
  assert.deepEqual(
    found.active_crop_cycles, [],
    'a closed cycle must never show as this plot\'s active crop (P1-b)'
  );
});

test('listPlots active_crop_cycles reports both cycles on a genuinely intercropped plot (>1 open)', async () => {
  const db = createJournalDb('cc-hardening-active-crop-intercrop');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(404);
  await makeCropCyclePlot(db, principal, plot);
  const seedUuid = cropCycleEntryUuid(404);

  await saveEntry(db, seedingInput({
    entry_uuid: seedUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  // Simulate a genuinely intercropped plot exactly like the harvest
  // disambiguation test above: a second concurrently open cycle covering the
  // same plot, inserted directly (normal seeding always closes a
  // differing-crop cycle, so this state can't arise via seeding alone).
  const secondCycleUuid = '80000000-0000-4000-8000-000000000404';
  db.prepare(
    'INSERT INTO journal_crop_cycles(cycle_uuid,crop_code,variety,group_uuid,opened_by_entry_uuid,starts_on,' +
      'gateway_device_eui,created_by_principal_uuid,sync_version,created_at,updated_at,deleted_at) ' +
    'VALUES (?,?,?,NULL,?,?,?,?,0,?,?,NULL)'
  ).run(
    secondCycleUuid, 'agroscope.crop.soybean', 'Asgrow', seedUuid, '2026-04-01',
    JOURNAL_TEST_GATEWAY_EUI, JOURNAL_TEST_OWNER_UUID, '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'
  );
  db.prepare(
    'INSERT INTO journal_crop_cycle_plots(cycle_uuid,plot_uuid,ends_on,closed_by_entry_uuid,close_reason) ' +
    'VALUES (?,?,NULL,NULL,NULL)'
  ).run(secondCycleUuid, plot);

  const { plots } = await listPlots(db, principal);
  const found = plots.find((row) => row.plot_uuid === plot);
  assert.equal(found.active_crop_cycles.length, 2);
  const crops = found.active_crop_cycles.map((row) => row.crop_code).sort();
  assert.deepEqual(crops, ['agroscope.crop.soybean', 'agroscope.crop.wheat_winter']);
});

test('upsertPlot also projects active_crop_cycles on its create/update response, not only listPlots', async () => {
  const db = createJournalDb('cc-hardening-active-crop-upsert-response');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(405);
  const created = await makeCropCyclePlot(db, principal, plot);
  assert.deepEqual(created.plot.active_crop_cycles, []);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(405),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });

  const updated = await upsertPlot(db, {
    plot_uuid: plot,
    base_sync_version: created.plot.sync_version,
    plot_code: created.plot.plot_code,
    name: 'Renamed plot',
    zone_uuid: null,
    station_code: null,
    crop_hint: null,
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 3,
    context_json: null,
  }, principal);
  assert.equal(updated.plot.active_crop_cycles.length, 1);
  assert.equal(updated.plot.active_crop_cycles[0].crop_code, 'agroscope.crop.wheat_winter');
});

test('a harvest entry has no season_crop of its own but resolves closed_crop_code/variety from the cycle it closed (P2-b)', async () => {
  const db = createJournalDb('cc-hardening-closed-crop-display');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(406);
  await makeCropCyclePlot(db, principal, plot);
  const harvestUuid = cropCycleEntryUuid(407);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(406),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, harvestInput({
    entry_uuid: harvestUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-08-01T09:00:00',
  }), principal, { mode: 'create' });

  assert.equal(readJournalEntryRow(db, harvestUuid).season_crop, null, 'own season_crop stays deferred/NULL');

  const { entries } = await listEntries(db, { entry_uuid: harvestUuid, status: 'all' }, principal);
  const harvestEntry = entries.find((entry) => entry.entry_uuid === harvestUuid);
  assert.equal(harvestEntry.season_crop, null, 'the stored/displayed season_crop column is untouched');
  assert.equal(harvestEntry.closed_crop_code, 'agroscope.crop.wheat_winter');
  assert.equal(harvestEntry.closed_crop_variety, 'Runal');

  const single = await loadCurrentAggregate(db, 'UPSERT_JOURNAL_ENTRY', harvestUuid, principal);
  assert.equal(single.closed_crop_code, 'agroscope.crop.wheat_winter', 'single-entry fetch resolves it too (S1 parity)');
  assert.equal(single.closed_crop_variety, 'Runal');
});

test('a non-closing entry (still-open cycle) has no closed_crop_code', async () => {
  const db = createJournalDb('cc-hardening-closed-crop-not-set');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(408);
  await makeCropCyclePlot(db, principal, plot);
  const irrigationUuid = cropCycleEntryUuid(409);

  await saveEntry(db, seedingInput({
    entry_uuid: cropCycleEntryUuid(408),
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, irrigationInput({
    entry_uuid: irrigationUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-05-01T09:00:00',
  }), principal, { mode: 'create' });

  const { entries } = await listEntries(db, { entry_uuid: irrigationUuid, status: 'all' }, principal);
  const irrigationEntry = entries.find((entry) => entry.entry_uuid === irrigationUuid);
  assert.equal(irrigationEntry.closed_crop_code, undefined);
  assert.equal(irrigationEntry.closed_crop_variety, undefined);
  assert.equal(irrigationEntry.season_crop, 'agroscope.crop.wheat_winter', 'still live-resolved from the open cycle');
});

// --- Pre-deploy review follow-ups (C1/C2) ----------------------------------

test('C1: "today" for active_crop_cycles is the GATEWAY-configured local date, not UTC (local-date boundary)', async () => {
  const originalTz = process.env.TZ;
  mock.timers.enable({ apis: ['Date'] });
  // 2026-01-01T23:30:00Z: still 2026-01-01 in UTC, but a gateway configured
  // 14h ahead of UTC (Pacific/Kiritimati) has already rolled over to
  // 2026-01-02 locally at this exact instant -- the boundary this test pins.
  mock.timers.setTime(Date.UTC(2026, 0, 1, 23, 30, 0));
  try {
    const db = createJournalDb('c1-today-local-date-boundary');
    seedJournalTestIdentity(db);
    const principal = journalTestPrincipal();
    const plot = cropCyclePlotUuid(900);
    await makeCropCyclePlot(db, principal, plot);

    // The cycle's own starts_on (2026-01-02) comes from the seeding entry's
    // OWN occurred_start_local/timezone -- unrelated to the "now" being
    // mocked above -- exactly like a real seeding entry logged for a date
    // that is, from the gateway's perspective, "today".
    await saveEntry(db, seedingInput({
      entry_uuid: cropCycleEntryUuid(900),
      plot_uuid: plot,
      occurred_start_local: '2026-01-02T09:00:00',
      occurred_timezone: 'Pacific/Kiritimati',
    }), principal, { mode: 'create' });

    process.env.TZ = 'UTC';
    const asOfUtc = await listPlots(db, principal);
    assert.deepEqual(
      asOfUtc.plots.find((row) => row.plot_uuid === plot).active_crop_cycles, [],
      'a UTC-configured gateway has not yet reached 2026-01-02 at this instant, so the cycle does not cover "today" yet'
    );

    process.env.TZ = 'Pacific/Kiritimati';
    const asOfGateway = await listPlots(db, principal);
    const found = asOfGateway.plots.find((row) => row.plot_uuid === plot);
    assert.equal(
      found.active_crop_cycles.length, 1,
      'a gateway configured 14h ahead of UTC has already reached 2026-01-02 locally at this same instant, ' +
        'so the cycle now covers "today" (todayLocalDate must follow the gateway-configured offset, not UTC)'
    );
    assert.equal(found.active_crop_cycles[0].crop_code, 'agroscope.crop.wheat_winter');
  } finally {
    mock.timers.reset();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('C2: a voided crop cycle no longer resurfaces its crop as closed_crop_code/variety on the entry that closed it', async () => {
  const db = createJournalDb('cc-hardening-closed-crop-voided-cycle');
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  const plot = cropCyclePlotUuid(410);
  await makeCropCyclePlot(db, principal, plot);
  const seedUuid = cropCycleEntryUuid(410);
  const harvestUuid = cropCycleEntryUuid(411);

  await saveEntry(db, seedingInput({
    entry_uuid: seedUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-04-01T09:00:00',
  }), principal, { mode: 'create' });
  await saveEntry(db, harvestInput({
    entry_uuid: harvestUuid,
    plot_uuid: plot,
    occurred_start_local: '2026-08-01T09:00:00',
  }), principal, { mode: 'create' });

  // Sanity (pre-existing P2-b behavior): before voiding, the harvest resolves
  // the crop it closed.
  const before = await listEntries(db, { entry_uuid: harvestUuid, status: 'all' }, principal);
  assert.equal(
    before.entries.find((entry) => entry.entry_uuid === harvestUuid).closed_crop_code,
    'agroscope.crop.wheat_winter'
  );

  // Void the seeding entry that opened the cycle. No other final entry
  // depends on it live or frozen (the harvest itself is excluded from
  // freezing by design -- see freezeClosedSpan's excludeEntryUuid), so this
  // succeeds without cascade_ack.
  await void_(db, null, seedUuid, currentSyncVersion(db, seedUuid), 'voiding the seeding', principal);
  const membership = readCycleMemberships(db, plot)[0];
  assert.ok(membership.cycle_deleted_at, 'the cycle itself is now soft-deleted');
  assert.equal(
    membership.closed_by_entry_uuid, harvestUuid,
    'the harvest membership row is untouched by the void -- it still names the harvest as the closer'
  );

  const after = await listEntries(db, { entry_uuid: harvestUuid, status: 'all' }, principal);
  const harvestEntry = after.entries.find((entry) => entry.entry_uuid === harvestUuid);
  assert.equal(
    harvestEntry.closed_crop_code, undefined,
    'C2: a voided (soft-deleted) cycle must not resurface its crop on the entry that closed it'
  );
  assert.equal(harvestEntry.closed_crop_variety, undefined);

  const single = await loadCurrentAggregate(db, 'UPSERT_JOURNAL_ENTRY', harvestUuid, principal);
  assert.equal(single.closed_crop_code, undefined, 'single-entry fetch parity (S1)');
  assert.equal(single.closed_crop_variety, undefined);
});

// ===========================================================================
// Field export silent-hang regression (2026-07-21)
//
// Root cause: exportJson/exportResearchPackage batched an entire (up to
// 50-entry) page into a single write() call, while exportWideCsv writes one
// row at a time. Once a page's combined JSON crossed the response's
// highWaterMark, write() returned false and writeChunk awaited 'drain' with
// no upper bound -- if the client/transport never actually drains, that
// await never resolves: a genuinely silent hang (no headers, no body, no
// error, no server log), reproduced on a live gateway with only 26 journal
// entries via GET /api/journal/export.json (and /export.package).
//
// The fix has two parts: (1) writeChunk now bounds the drain wait with
// EXPORT_WRITE_STALL_MS, so a stalled writable fails loudly (504/
// 'export_stream_stalled') instead of hanging forever; (2) exportJson (and
// every zip member write inside exportResearchPackage) now writes through
// writeBoundedChunk one entry/row at a time, the same granularity
// exportWideCsv already used, so realistic exports are far less likely to
// ever trip backpressure in the first place.
// ===========================================================================

const EXPORT_HANG_OWNER_PLOT = 'ee000000-0000-4000-8000-000000000001';

async function seedExportHangDataset(name, entryCount) {
  const db = createJournalDb(name);
  seedJournalTestIdentity(db);
  const principal = journalTestPrincipal();
  await makeCropCyclePlot(db, principal, EXPORT_HANG_OWNER_PLOT);
  for (let i = 1; i <= entryCount; i += 1) {
    const day = String((i % 27) + 1).padStart(2, '0');
    const month = i <= 27 ? '05' : (i <= 54 ? '06' : '07');
    await saveEntry(db, irrigationInput({
      entry_uuid: 'ee100000-0000-4000-8000-' + String(i).padStart(12, '0'),
      plot_uuid: EXPORT_HANG_OWNER_PLOT,
      occurred_start_local: '2026-' + month + '-' + day + 'T09:00:00',
      season_crop: 'ExplicitCrop',
      season_variety: 'ExplicitVariety',
      note: 'Irrigated field row ' + i,
    }), principal, { mode: 'create' });
  }
  return { db, principal };
}

// A real stream.Writable (genuine internal buffering/backpressure, not a
// synthetic mock) whose _write we fully control:
//  - mode 'stall': the callback is NEVER invoked -- the consumer has
//    genuinely stopped reading, exactly like a real stuck client/socket.
//  - mode 'slow-drain': the callback fires on the next real macrotask, so
//    the stream drains for real (a legitimate, if unhurried, consumer).
function exportHangSink(mode, highWaterMark) {
  const chunks = [];
  const sink = new Writable({
    highWaterMark,
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      if (mode === 'stall') return; // never call back
      setImmediate(callback);
    },
  });
  sink.setHeader = function() {};
  sink.getChunks = function() { return chunks; };
  return sink;
}

// Advances past the several real (unmocked) DB round-trips exportJson/
// exportResearchPackage/exportWideCsv make before their first write(), then
// waits for writeChunk to actually register its 'drain' listener -- only
// then is it safe to fast-forward the (mocked) stall timer.
async function waitForDrainListener(sink) {
  for (let i = 0; i < 2000 && sink.listenerCount('drain') === 0; i += 1) {
    await new Promise(function(resolve) { setImmediate(resolve); });
  }
  assert.equal(sink.listenerCount('drain'), 1, 'writeChunk must be waiting on drain by now');
}

test(
  'export.json no longer hangs forever against a stalled client -- it fails loudly instead (silent-hang regression)',
  { timeout: 10_000 },
  async () => {
    const { db, principal } = await seedExportHangDataset('export-hang-json-stall', 30);
    const sink = exportHangSink('stall', 16 * 1024);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const promise = exportJson(db, { status: 'final' }, principal, sink, {});
      await waitForDrainListener(sink);
      mock.timers.tick(30_000); // EXPORT_WRITE_STALL_MS
      await assert.rejects(promise, function(error) {
        assert.equal(error.code, 'export_stream_stalled');
        assert.equal(error.statusCode, 504);
        return true;
      });
    } finally {
      mock.timers.reset();
    }
  }
);

test(
  'export.package no longer hangs forever against a stalled client -- it fails loudly instead (silent-hang regression)',
  { timeout: 10_000 },
  async () => {
    const { db, principal } = await seedExportHangDataset('export-hang-package-stall', 30);
    const sink = exportHangSink('stall', 16 * 1024);
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const promise = exportResearchPackage(db, { status: 'final' }, principal, sink, {});
      await waitForDrainListener(sink);
      mock.timers.tick(30_000); // EXPORT_WRITE_STALL_MS
      await assert.rejects(promise, function(error) {
        assert.equal(error.code, 'export_stream_stalled');
        assert.equal(error.statusCode, 504);
        return true;
      });
    } finally {
      mock.timers.reset();
    }
  }
);

test(
  'export.csv is unaffected by the silent-hang fix: it still completes against the same stalled client/dataset',
  { timeout: 10_000 },
  async () => {
    const { db, principal } = await seedExportHangDataset('export-hang-csv-unaffected', 30);
    const sink = exportHangSink('stall', 16 * 1024);
    const result = await exportWideCsv(db, { status: 'final' }, principal, sink);
    assert.equal(result, null);
    assert.match(Buffer.concat(sink.getChunks()).toString('utf8'), /entry_uuid/);
  }
);

test(
  'export.json writes one entry at a time and produces complete, valid JSON for a dataset that exceeds the single-write budget',
  { timeout: 10_000 },
  async () => {
    const ENTRY_COUNT = 30;
    const { db, principal } = await seedExportHangDataset('export-hang-json-valid', ENTRY_COUNT);
    const reference = JSON.parse(await exportJson(db, { status: 'final' }, principal, null, {}));
    assert.equal(reference.record_counts.entries, ENTRY_COUNT);

    const sink = exportHangSink('slow-drain', 16 * 1024);
    const finished = new Promise(function(resolve) { sink.once('finish', resolve); });
    await exportJson(db, { status: 'final' }, principal, sink, {});
    await finished;
    assert.ok(
      sink.getChunks().length > ENTRY_COUNT,
      'expected more than one write() per entry (prefix + one per entry + trailer), not one giant per-page write'
    );
    const parsed = JSON.parse(Buffer.concat(sink.getChunks()).toString('utf8'));
    assert.equal(parsed.record_counts.entries, ENTRY_COUNT);
    assert.equal(parsed.entries.length, ENTRY_COUNT);
    // entries_sha256/values_sha256 are deterministic (content-only); compare
    // across the two independent exportJson calls. research_metadata_sha256
    // is not (research_metadata carries a fresh dataset_uuid/export_uuid/
    // generated_at per call), so check it is internally self-consistent
    // instead of equal to the other call's value.
    assert.equal(parsed.checksums.entries_sha256, reference.checksums.entries_sha256);
    assert.equal(parsed.checksums.values_sha256, reference.checksums.values_sha256);
    assert.equal(
      parsed.checksums.research_metadata_sha256,
      crypto.createHash('sha256').update(JSON.stringify(parsed.research_metadata)).digest('hex')
    );
  }
);

test('loadCatalog resolves against a promise-only read-snapshot scope (catalog.js arity guard)', async () => {
  // Live osi-db-helper hands exports a createTransactionScope: 2-arg all/get that
  // return a promise, NO prepare, NO callback support. Before the fix, catalog.js's
  // queryOne/queryAll fell to the 3-arg db.get(sql, params, callback) form, which
  // this scope never invokes -> the Promise never settled -> export.json/.package
  // hung forever before writing a byte. Test harnesses masked it because their
  // snapshot scope exposes prepare (synchronous branch). This reproduces the live
  // scope shape and asserts loadCatalog completes.
  const raw = createTestDb('catalog-promise-scope');
  const scope = {
    all(sql, params) { return Promise.resolve(raw.prepare(sql).all(...(params || []))); },
    get(sql, params) { return Promise.resolve(raw.prepare(sql).get(...(params || []))); },
    run(sql, params) { raw.prepare(sql).run(...(params || [])); return Promise.resolve(); },
    exec(sql) { raw.exec(sql); return Promise.resolve(); },
  };
  const outcome = await Promise.race([
    loadCatalog(scope).then(function(cat) { return cat ? 'ok' : 'empty'; }),
    new Promise(function(resolve) { setTimeout(function() { resolve('TIMEOUT'); }, 3000); }),
  ]);
  assert.equal(outcome, 'ok', 'loadCatalog must not hang on a promise-only scope');
});
