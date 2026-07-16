#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const journal = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal');
const { aggregateHash } = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/aggregate'
);

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-api-'));
const nativeDatabases = [];
const OWNER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_OWNER_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VOID_ACTOR_UUID = '99999999-9999-4999-8999-999999999999';
const ZONE_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN_ZONE_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GATEWAY_EUI = '0016C001F1000001';
const RESEARCH_PACKAGE_MEMBERS = [
  'entries.csv',
  'values.csv',
  'vocab_mappings.csv',
  'records.ndjson',
  'manifest.json',
];
const RESEARCH_SCHEMA_DESCRIPTOR = {
  name: 'osi-journal-research',
  version: 1,
  entry_shape: 'journal_entry_aggregate_without_author_or_owner_identity',
  value_shape: 'typed_long_form_with_entered_and_canonical_units',
  missing_value_field: 'value_status',
  package_members: RESEARCH_PACKAGE_MEMBERS,
  csv_string_safety: 'formula-prefix apostrophe; exact source strings are in records.ndjson',
  lossless_member: 'records.ndjson',
};

test.after(() => {
  for (const db of nativeDatabases) {
    try { db.close(); } catch (_) {}
  }
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

class TestDb {
  constructor(name) {
    this.native = new DatabaseSync(path.join(TEMP_ROOT, name + '.db'));
    this.native.exec(SEED);
    this.closeCalls = 0;
    this.snapshotClosed = 0;
    this.valueBatchSizes = [];
    this.wideCellQueries = [];
    this.closeError = null;
    nativeDatabases.push(this.native);
  }

  prepare(sql) {
    const statement = this.native.prepare(sql);
    const tracksValueBatch = /FROM journal_entry_values WHERE entry_uuid IN/.test(sql);
    const tracksWideCells = /SELECT DISTINCT v\.group_index,v\.attribute_code/.test(sql);
    if (!tracksValueBatch && !tracksWideCells) return statement;
    const testDb = this;
    return {
      all(...params) {
        if (tracksValueBatch) testDb.valueBatchSizes.push(params.length);
        if (tracksWideCells) testDb.wideCellQueries.push({ sql, params: params.slice() });
        return statement.all(...params);
      },
      get(...params) {
        return statement.get(...params);
      },
      run(...params) {
        return statement.run(...params);
      },
    };
  }

  get(sql, params) {
    return Promise.resolve(this.native.prepare(sql).get(...(params || [])));
  }

  all(sql, params) {
    if (/FROM journal_entry_values WHERE entry_uuid IN/.test(sql)) {
      this.valueBatchSizes.push((params || []).length);
    }
    if (/SELECT DISTINCT v\.group_index,v\.attribute_code/.test(sql)) {
      this.wideCellQueries.push({ sql, params: (params || []).slice() });
    }
    return Promise.resolve(this.native.prepare(sql).all(...(params || [])));
  }

  run(sql, params) {
    return Promise.resolve(this.native.prepare(sql).run(...(params || [])));
  }

  exec(sql) {
    return this.native.exec(sql);
  }

  async transaction(executor) {
    this.native.exec('BEGIN IMMEDIATE');
    try {
      const result = await executor(this);
      this.native.exec('COMMIT');
      return result;
    } catch (error) {
      this.native.exec('ROLLBACK');
      throw error;
    }
  }

  async readSnapshot(executor) {
    try {
      return await executor({
        prepare: this.prepare.bind(this),
        get: this.get.bind(this),
        all: this.all.bind(this),
        run: this.run.bind(this),
        exec: this.exec.bind(this),
      });
    } finally {
      this.snapshotClosed += 1;
    }
  }

  close(callback) {
    this.closeCalls += 1;
    if (callback) queueMicrotask(() => callback(this.closeError));
  }
}

function seedIdentity(db) {
  const now = '2026-07-13T00:00:00.000Z';
  db.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,user_uuid) VALUES (?,?,?,?,?)'
  ).run(1, 'field-user', 'unused', now, OWNER_UUID);
  db.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,user_uuid) VALUES (?,?,?,?,?)'
  ).run(2, 'other-user', 'unused', now, OTHER_OWNER_UUID);
  db.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) VALUES (?,?,?,?,?,?)'
  ).run(1, 'North Field', 1, 'Europe/Zurich', ZONE_UUID, GATEWAY_EUI);
  db.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) VALUES (?,?,?,?,?,?)'
  ).run(2, 'Foreign Field', 2, 'Europe/Zurich', FOREIGN_ZONE_UUID, GATEWAY_EUI);
  db.prepare(
    'INSERT INTO zone_seasons(zone_id,season_uuid,name,starts_on,ends_on,crop_type,variety) VALUES (?,?,?,?,?,?,?)'
  ).run(1, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Season', '2026-01-01', '2026-12-31', 'barley', 'Golden');
}

function principal(overrides) {
  return Object.assign({
    user_id: 1,
    owner_user_uuid: OWNER_UUID,
    author_principal_uuid: OWNER_UUID,
    author_label: 'field-user',
    gateway_device_eui: GATEWAY_EUI,
    origin: 'edge-ui',
  }, overrides || {});
}

function customVocabInput(uuid, overrides) {
  return Object.assign({
    custom_field_uuid: uuid,
    base_sync_version: 0,
    kind: 'activity',
    parent_code: null,
    value_type: null,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    labels: { en: 'Custom term ' + uuid },
    icon_key: null,
    constraints: {},
    active: 1,
    sort_order: 0,
    mappings: [],
  }, overrides || {});
}

function plotInput(uuid, code, overrides) {
  return Object.assign({
    plot_uuid: uuid,
    base_sync_version: 0,
    plot_code: code,
    name: code,
    zone_uuid: null,
    station_code: null,
    crop_hint: null,
    area_m2: 100,
    active: 1,
    layout_code: 'open_field',
    layout_version: 1,
  }, overrides || {});
}

function entryInput(uuid, plotUuid, localTime, overrides) {
  return Object.assign({
    entry_uuid: uuid,
    base_sync_version: 0,
    status: 'final',
    plot_uuid: plotUuid,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    occurred_start_local: localTime,
    occurred_timezone: 'Europe/Zurich',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 12,
      unit_code: 'unit.mm_water',
      value_status: 'observed',
    }],
    note: 'Irrigation',
  }, overrides || {});
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function token(secret, payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + signature;
}

test('journal package exposes the complete Task 10 API surface', () => {
  for (const name of [
    'verifyBearer',
    'resolvePrincipal',
    'loadScopedCatalog',
    'listEntries',
    'saveEntry',
    'voidEntry',
    'upsertCustomVocab',
    'listPlots',
    'upsertPlot',
    'listPlotGroups',
    'loadCurrentAggregate',
    'upsertPlotGroup',
    'exportWideCsv',
    'exportResearchPackage',
    'exportJson',
  ]) {
    assert.equal(typeof journal[name], 'function', name + ' must be exported');
  }
});

test('verifyBearer accepts the existing two-part millisecond-expiry HMAC token', () => {
  const secret = 'journal-test-secret';
  const now = Date.parse('2026-07-13T10:00:00.000Z');
  const bearer = token(secret, { userId: 7, username: 'field-user', exp: now + 60_000 });
  assert.deepEqual(
    journal.verifyBearer('Bearer ' + bearer, secret, now),
    { userId: 7, username: 'field-user', exp: now + 60_000 }
  );
});

test('verifyBearer rejects expired, malformed, and forged tokens without leaking details', () => {
  const now = Date.parse('2026-07-13T10:00:00.000Z');
  for (const authorization of [
    null,
    'Basic nope',
    'Bearer one.part.extra',
    'Bearer ' + token('wrong', { userId: 7, username: 'field-user', exp: now + 60_000 }),
    'Bearer ' + token('secret', { userId: 7, username: 'field-user', exp: now - 1 }),
  ]) {
    assert.throws(
      () => journal.verifyBearer(authorization, 'secret', now),
      (error) => error && error.code === 'unauthorized' && error.statusCode === 401
    );
  }
});

test('resolvePrincipal fails closed unless gateway confidence is explicit and trusted', async () => {
  const db = {
    get() {
      throw new Error('identity gate must run before the user query');
    },
  };
  const tokenPrincipal = { userId: 7, username: 'field-user' };
  for (const identity of [
    '0016C001F1000001',
    { deviceEui: '0016C001F1000001' },
    { deviceEui: '0016C001F1000001', confidence: 'unknown' },
    { deviceEui: '0016C001F1000001', confidence: 'provisional' },
  ]) {
    await assert.rejects(
      journal.resolvePrincipal(db, tokenPrincipal, identity),
      (error) => error && error.code === 'gateway_identity_unavailable' && error.statusCode === 503
    );
  }
});

test('resolvePrincipal binds both token id and username and derives immutable identity', async () => {
  const db = new TestDb('principal');
  seedIdentity(db);
  const resolved = await journal.resolvePrincipal(
    db,
    { userId: 1, username: 'field-user' },
    { deviceEui: GATEWAY_EUI.toLowerCase(), confidence: 'persisted' }
  );
  assert.deepEqual(resolved, principal());
  await assert.rejects(
    journal.resolvePrincipal(
      db,
      { userId: 1, username: 'other-user' },
      { deviceEui: GATEWAY_EUI, confidence: 'authoritative' }
    ),
    (error) => error && error.code === 'unauthorized'
  );
});

test('plot upsert is atomic, zone-owner scoped, versioned, and command-ledger ready', async () => {
  const db = new TestDb('plot');
  seedIdentity(db);
  const uuid = '10000000-0000-4000-8000-000000000001';
  const commandPrincipal = principal({
    command_id: 'command-plot-1',
    command_type: 'UPSERT_JOURNAL_PLOT',
    effect_key: 'journal_plot:' + uuid + ':0',
    payload_hash: 'cloud-must-not-control-this-hash',
  });
  const result = await journal.upsertPlot(
    db,
    plotInput(uuid, 'north', { zone_uuid: ZONE_UUID }),
    commandPrincipal
  );
  assert.equal(result.plot.sync_version, 1);
  assert.equal(result.plot.owner_user_uuid, OWNER_UUID);
  assert.equal(
    db.prepare('SELECT owner_user_uuid FROM journal_plots WHERE plot_uuid=?').get(uuid).owner_user_uuid,
    OWNER_UUID
  );
  assert.equal(result.plot.settings.sync_version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 1);
  const applied = db.prepare('SELECT * FROM applied_commands WHERE command_id=?').get('command-plot-1');
  const facts = JSON.parse(applied.result_detail);
  assert.notEqual(facts.payloadHash, commandPrincipal.payload_hash);
  assert.match(facts.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);

  await assert.rejects(
    journal.upsertPlot(
      db,
      plotInput('10000000-0000-4000-8000-000000000002', 'foreign', { zone_uuid: FOREIGN_ZONE_UUID }),
      principal()
    ),
    (error) => error && error.statusCode === 404
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_plots WHERE plot_code='foreign'").get().n, 0);
});

test('plot detach succeeds after the linked zone is soft-deleted', async () => {
  const db = new TestDb('plot-zone-soft-delete-detach');
  seedIdentity(db);
  const plotUuid = '10000000-0000-4000-8000-000000000021';
  await journal.upsertPlot(db, plotInput(plotUuid, 'zone-detach', { zone_uuid: ZONE_UUID }), principal());
  db.prepare('UPDATE irrigation_zones SET deleted_at=? WHERE zone_uuid=?')
    .run('2026-07-13T00:00:00.000Z', ZONE_UUID);

  // Detaching a plot from its now-soft-deleted zone must succeed, not 404.
  const result = await journal.upsertPlot(
    db,
    plotInput(plotUuid, 'zone-detach', { base_sync_version: 1, zone_uuid: null }),
    principal(),
    plotUuid
  );
  assert.equal(result.plot.zone_uuid, null);
  assert.equal(result.plot.sync_version, 2);
});

test('plot field edit succeeds after the linked zone is soft-deleted', async () => {
  const db = new TestDb('plot-zone-soft-delete-edit');
  seedIdentity(db);
  const plotUuid = '10000000-0000-4000-8000-000000000022';
  await journal.upsertPlot(db, plotInput(plotUuid, 'zone-edit', { zone_uuid: ZONE_UUID }), principal());
  db.prepare('UPDATE irrigation_zones SET deleted_at=? WHERE zone_uuid=?')
    .run('2026-07-13T00:00:00.000Z', ZONE_UUID);

  // An unrelated field edit (that does not name the dead zone) must also succeed.
  const result = await journal.upsertPlot(
    db,
    plotInput(plotUuid, 'zone-edit', { base_sync_version: 1, active: 0 }),
    principal(),
    plotUuid
  );
  assert.equal(result.plot.active, 0);
  assert.equal(result.plot.sync_version, 2);
});

test('plot edits after zone soft-delete still enforce zone ownership masking', async () => {
  const db = new TestDb('plot-zone-soft-delete-masking');
  seedIdentity(db);
  const plotUuid = '10000000-0000-4000-8000-000000000023';
  await journal.upsertPlot(db, plotInput(plotUuid, 'zone-masking', { zone_uuid: ZONE_UUID }), principal());
  db.prepare('UPDATE irrigation_zones SET deleted_at=? WHERE zone_uuid=?')
    .run('2026-07-13T00:00:00.000Z', ZONE_UUID);

  // Regression guard: still cannot link the plot to another user's zone.
  await assert.rejects(
    journal.upsertPlot(
      db,
      plotInput(plotUuid, 'zone-masking', { base_sync_version: 1, zone_uuid: FOREIGN_ZONE_UUID }),
      principal(),
      plotUuid
    ),
    (error) => error && error.statusCode === 404
  );

  // Regression guard: still cannot re-link the plot to the soft-deleted zone itself.
  await assert.rejects(
    journal.upsertPlot(
      db,
      plotInput(plotUuid, 'zone-masking', { base_sync_version: 1, zone_uuid: ZONE_UUID }),
      principal(),
      plotUuid
    ),
    (error) => error && error.statusCode === 404
  );
  assert.equal(
    db.prepare('SELECT zone_uuid FROM journal_plots WHERE plot_uuid=?').get(plotUuid).zone_uuid,
    ZONE_UUID
  );
});

test('plot constraints prevent a second active zone plot and unresolved-group deactivation', async () => {
  const db = new TestDb('plot-invariants');
  seedIdentity(db);
  const first = '10000000-0000-4000-8000-000000000011';
  const second = '10000000-0000-4000-8000-000000000012';
  await journal.upsertPlot(db, plotInput(first, 'zone-one', { zone_uuid: ZONE_UUID }), principal());
  await assert.rejects(
    journal.upsertPlot(db, plotInput(second, 'zone-two', { zone_uuid: ZONE_UUID }), principal()),
    (error) => error && error.code === 'zone_plot_conflict'
  );
  await journal.upsertPlot(db, plotInput(second, 'sensorless'), principal());
  const groupUuid = '20000000-0000-4000-8000-000000000001';
  await journal.upsertPlotGroup(db, {
    group_uuid: groupUuid,
    base_sync_version: 0,
    label: 'Active cohort',
    resolved: false,
    members: [first, second],
  }, principal());
  await assert.rejects(
    journal.upsertPlot(db, plotInput(second, 'sensorless', {
      base_sync_version: 1,
      active: 0,
    }), principal(), second),
    (error) => error && error.code === 'plot_in_unresolved_group'
  );
});

test('plot and group lists hide same-gateway resources owned by another user', async () => {
  const db = new TestDb('private-resource-lists');
  seedIdentity(db);
  const plotUuid = '22000000-0000-4000-8000-000000000001';
  const groupUuid = '22000000-0000-4000-8000-000000000002';
  await journal.upsertPlot(db, plotInput(plotUuid, 'private-sensorless'), principal());
  await journal.upsertPlotGroup(db, {
    group_uuid: groupUuid,
    base_sync_version: 0,
    label: 'Private group',
    resolved: false,
    members: [plotUuid],
  }, principal());
  const other = principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  });
  const foreignPlotUuid = '22000000-0000-4000-8000-000000000003';
  await journal.upsertPlot(db, plotInput(foreignPlotUuid, 'other-private'), other);
  db.prepare(
    'INSERT INTO journal_plot_group_members (group_uuid,plot_uuid) VALUES (?,?)'
  ).run(groupUuid, foreignPlotUuid);

  assert.deepEqual(
    (await journal.listPlots(db, other)).plots.map(function(plot) { return plot.plot_uuid; }),
    [foreignPlotUuid]
  );
  assert.deepEqual((await journal.listPlotGroups(db, other)).plot_groups, []);
  assert.deepEqual((await journal.listPlotGroups(db, principal())).plot_groups[0].members, [plotUuid]);
});

test('plot and group updates return 404 for another owner on the same gateway', async () => {
  const db = new TestDb('private-resource-updates');
  seedIdentity(db);
  const plotUuid = '23000000-0000-4000-8000-000000000001';
  const groupUuid = '23000000-0000-4000-8000-000000000002';
  await journal.upsertPlot(db, plotInput(plotUuid, 'private-update'), principal());
  await journal.upsertPlotGroup(db, {
    group_uuid: groupUuid,
    base_sync_version: 0,
    label: 'Private update group',
    resolved: false,
    members: [plotUuid],
  }, principal());
  const other = principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  });

  await assert.rejects(
    journal.upsertPlot(db, plotInput(plotUuid, 'foreign-update', {
      base_sync_version: 1,
    }), other, plotUuid),
    (error) => error && error.statusCode === 404
  );
  await assert.rejects(
    journal.upsertPlotGroup(db, {
      group_uuid: groupUuid,
      base_sync_version: 1,
      label: 'Foreign update',
      resolved: false,
      members: [plotUuid],
    }, other, groupUuid),
    (error) => error && error.statusCode === 404
  );
});

test('plot and group create UUID collisions fail closed across same-gateway owners', async () => {
  const db = new TestDb('private-resource-create-collisions');
  seedIdentity(db);
  const plotUuid = '23500000-0000-4000-8000-000000000001';
  const groupUuid = '23500000-0000-4000-8000-000000000002';
  await journal.upsertPlot(db, plotInput(plotUuid, 'private-collision'), principal());
  await journal.upsertPlotGroup(db, {
    group_uuid: groupUuid,
    base_sync_version: 0,
    label: 'Private collision group',
    resolved: false,
    members: [plotUuid],
  }, principal());
  const other = principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  });
  const otherPlotUuid = '23500000-0000-4000-8000-000000000003';
  await journal.upsertPlot(db, plotInput(otherPlotUuid, 'other-collision-member'), other);

  await assert.rejects(
    journal.upsertPlot(db, plotInput(plotUuid, 'foreign-collision'), other),
    (error) => error && error.statusCode === 404
  );
  await assert.rejects(
    journal.upsertPlotGroup(db, {
      group_uuid: groupUuid,
      base_sync_version: 0,
      label: 'Foreign collision group',
      resolved: false,
      members: [otherPlotUuid],
    }, other),
    (error) => error && error.statusCode === 404
  );
  assert.equal(
    db.prepare('SELECT owner_user_uuid FROM journal_plots WHERE plot_uuid=?').get(plotUuid).owner_user_uuid,
    OWNER_UUID
  );
  assert.equal(
    db.prepare('SELECT owner_user_uuid FROM journal_plot_groups WHERE group_uuid=?').get(groupUuid).owner_user_uuid,
    OWNER_UUID
  );
});

test('plot groups reject same-gateway plots owned by another user', async () => {
  const db = new TestDb('private-group-membership');
  seedIdentity(db);
  const plotUuid = '24000000-0000-4000-8000-000000000001';
  await journal.upsertPlot(db, plotInput(plotUuid, 'private-member'), principal());
  const other = principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  });

  await assert.rejects(
    journal.upsertPlotGroup(db, {
      group_uuid: '24000000-0000-4000-8000-000000000002',
      base_sync_version: 0,
      label: 'Foreign membership',
      resolved: false,
      members: [plotUuid],
    }, other),
    (error) => error && error.statusCode === 404
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_plot_groups').get().n, 0);
});

test('entry creation rejects a same-gateway plot owned by another user', async () => {
  const db = new TestDb('private-entry-plot');
  seedIdentity(db);
  const plotUuid = '25000000-0000-4000-8000-000000000001';
  await journal.upsertPlot(db, plotInput(plotUuid, 'private-entry'), principal());
  const other = principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  });

  await assert.rejects(
    journal.saveEntry(
      db,
      entryInput('25000000-0000-4000-8000-000000000002', plotUuid, '2026-07-13T09:00:00', {
        season_crop: 'barley',
      }),
      other,
      { mode: 'create' }
    ),
    (error) => error && error.statusCode === 404
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 0);
});

test('entry POST/PUT semantics and duplicate acknowledgement are transactional', async () => {
  const db = new TestDb('entries');
  seedIdentity(db);
  const plotUuid = '30000000-0000-4000-8000-000000000001';
  await journal.upsertPlot(db, plotInput(plotUuid, 'entry-plot', { zone_uuid: ZONE_UUID }), principal());
  const firstUuid = '31000000-0000-4000-8000-000000000001';
  const first = await journal.saveEntry(
    db,
    entryInput(firstUuid, plotUuid, '2026-07-13T10:00:00'),
    principal(),
    { mode: 'create' }
  );
  assert.equal(first.sync_version, 1);
  const outboxBefore = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  const duplicateUuid = '31000000-0000-4000-8000-000000000002';
  await assert.rejects(
    journal.saveEntry(
      db,
      entryInput(duplicateUuid, plotUuid, '2026-07-13T10:30:00'),
      principal(),
      { mode: 'create' }
    ),
    (error) => error && error.code === 'duplicate_candidate' &&
      error.details.duplicateCandidate.entryUuid === firstUuid && error.statusCode === 409
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, outboxBefore);
  await journal.saveEntry(
    db,
    entryInput(duplicateUuid, plotUuid, '2026-07-13T10:30:00', {
      duplicate_guard_ack_entry_uuid: firstUuid,
    }),
    principal(),
    { mode: 'create' }
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 2);
  await assert.rejects(
    journal.saveEntry(
      db,
      entryInput(firstUuid, plotUuid, '2026-07-13T12:30:00'),
      principal(),
      { mode: 'create' }
    ),
    (error) => error && error.code === 'already_exists'
  );
  await assert.rejects(
    journal.saveEntry(
      db,
      Object.assign(entryInput('31000000-0000-4000-8000-000000000003', plotUuid, '2026-07-13T13:30:00'), {
        owner_user_uuid: OTHER_OWNER_UUID,
      }),
      principal(),
      { mode: 'create' }
    ),
    (error) => error && error.code === 'identity_field_forbidden'
  );
});

test('zone-only entry provisioning is idempotent, explicit-layout, and commits before entry validation', async () => {
  const db = new TestDb('zone-provision');
  seedIdentity(db);
  const first = entryInput('32000000-0000-4000-8000-000000000001', null, '2026-07-13T08:00:00', {
    zone_uuid: ZONE_UUID,
    plot_uuid: null,
  });
  delete first.layout_code;
  await assert.rejects(
    journal.saveEntry(db, first, principal(), { mode: 'create' }),
    (error) => error && error.code === 'layout_required'
  );
  const invalid = entryInput('32000000-0000-4000-8000-000000000002', null, '2026-07-13T08:00:00', {
    zone_uuid: ZONE_UUID,
    plot_uuid: null,
    activity_code: 'does.not.exist',
  });
  await assert.rejects(journal.saveEntry(db, invalid, principal(), { mode: 'create' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_plots WHERE zone_uuid=?').get(ZONE_UUID).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 0);
  assert.match(
    db.prepare('SELECT plot_code FROM journal_plots WHERE zone_uuid=?').get(ZONE_UUID).plot_code,
    /^north-field(?:-|$)/
  );
});

test('zone-based entry creation skips an inactive plot and provisions a new active one', async () => {
  const db = new TestDb('zone-provision-skip-inactive');
  seedIdentity(db);
  const firstEntryUuid = '33000000-0000-4000-8000-000000000001';
  await journal.saveEntry(
    db,
    entryInput(firstEntryUuid, null, '2026-07-13T08:00:00', { zone_uuid: ZONE_UUID, plot_uuid: null }),
    principal(),
    { mode: 'create' }
  );
  const original = db.prepare('SELECT plot_uuid,plot_code FROM journal_plots WHERE zone_uuid=?').get(ZONE_UUID);
  assert.ok(original, 'zone-provisioned plot must exist after the first entry');

  // Deactivate the auto-created plot, mirroring PUT /api/journal/plots/:plot_uuid { active: 0 }.
  await journal.upsertPlot(
    db,
    plotInput(original.plot_uuid, original.plot_code, {
      base_sync_version: 1,
      zone_uuid: ZONE_UUID,
      active: 0,
    }),
    principal(),
    original.plot_uuid
  );
  assert.equal(
    db.prepare('SELECT active FROM journal_plots WHERE plot_uuid=?').get(original.plot_uuid).active,
    0
  );

  const secondEntryUuid = '33000000-0000-4000-8000-000000000002';
  await journal.saveEntry(
    db,
    entryInput(secondEntryUuid, null, '2026-07-13T09:00:00', { zone_uuid: ZONE_UUID, plot_uuid: null }),
    principal(),
    { mode: 'create' }
  );

  const createdPlotUuid = db.prepare('SELECT plot_uuid FROM journal_entries WHERE entry_uuid=?')
    .get(secondEntryUuid).plot_uuid;
  assert.ok(createdPlotUuid, 'second entry must be linked to a plot');
  assert.notEqual(createdPlotUuid, original.plot_uuid);
  assert.equal(
    db.prepare('SELECT active FROM journal_plots WHERE plot_uuid=?').get(createdPlotUuid).active,
    1
  );
});

test('custom vocabulary is scoped, mapping-complete, frozen after voided use, and rollback-safe', async () => {
  const db = new TestDb('custom-vocab');
  seedIdentity(db);
  const uuid = '40000000-0000-4000-8000-000000000001';
  const body = {
    custom_field_uuid: uuid,
    base_sync_version: 0,
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    labels: { de: 'Feldnotiz', en: 'Field note' },
    icon_key: null,
    constraints: {},
    agrovoc_uri: null,
    icasa_code: null,
    adapt_code: null,
    active: 1,
    sort_order: 10,
    mappings: [{
      scheme_uri: 'https://example.test/scheme',
      scheme_version: '1',
      mapping_role: 'variable',
      external_id: 'field-note',
      external_parent_id: null,
      mapping_relation: 'close',
      source_uri: 'https://example.test/source',
      active: 1,
    }],
  };
  const created = await journal.upsertCustomVocab(db, body, principal());
  assert.equal(created.custom_vocab.code, 'custom.' + uuid);
  assert.deepEqual(Object.keys(created.custom_vocab.mappings[0]).sort(), [
    'active', 'external_id', 'external_parent_id', 'mapping_relation', 'mapping_role',
    'scheme_uri', 'scheme_version', 'source_uri',
  ]);
  const otherUuid = '40000000-0000-4000-8000-000000000002';
  await journal.upsertCustomVocab(db, Object.assign({}, body, {
    custom_field_uuid: otherUuid,
  }), principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  }));
  const scoped = await journal.loadScopedCatalog(db, principal());
  assert.ok(scoped.vocab.some((row) => row.code === 'custom.' + uuid));
  assert.ok(!scoped.vocab.some((row) => row.code === 'custom.' + otherUuid));

  const plotUuid = '41000000-0000-4000-8000-000000000001';
  const entryUuid = '42000000-0000-4000-8000-000000000001';
  await journal.upsertPlot(db, plotInput(plotUuid, 'vocab-use', { zone_uuid: ZONE_UUID }), principal());
  await journal.saveEntry(
    db,
    entryInput(entryUuid, plotUuid, '2026-07-13T06:00:00'),
    principal(),
    { mode: 'create' }
  );
  db.prepare(
    'INSERT INTO journal_entry_values(entry_uuid,attribute_code,group_index,value_status,value_text) VALUES (?,?,?,?,?)'
  ).run(entryUuid, 'custom.' + uuid, 1, 'observed', 'used');
  db.prepare("UPDATE journal_entries SET status='voided' WHERE entry_uuid=?").run(entryUuid);
  await assert.rejects(
    journal.upsertCustomVocab(db, Object.assign({}, body, {
      base_sync_version: 1,
      value_type: 'date',
    }), principal(), uuid),
    (error) => error && error.code === 'semantic_fields_frozen'
  );

  await assert.rejects(
    journal.upsertCustomVocab(db, Object.assign({}, body, {
      custom_field_uuid: '40000000-0000-4000-8000-000000000003',
      kind: 'choice',
      value_type: null,
      parent_code: 'irrigation',
    }), principal()),
    (error) => error && error.code === 'invalid_parent'
  );
  await assert.rejects(
    journal.upsertCustomVocab(db, Object.assign({}, body, {
      custom_field_uuid: '40000000-0000-4000-8000-000000000004',
      value_type: 'number',
      quantity_kind: 'unknown_quantity',
      basis: 'unknown_basis',
      default_unit_code: null,
      constraints: {},
    }), principal()),
    (error) => error && error.code === 'invalid_numeric_contract'
  );

  const rollbackUuid = '40000000-0000-4000-8000-000000000005';
  await assert.rejects(
    journal.upsertCustomVocab(db, Object.assign({}, body, {
      custom_field_uuid: rollbackUuid,
    }), principal({
      command_id: 'command-vocab-rollback',
      command_type: 'UPSERT_JOURNAL_CUSTOM_VOCAB',
      effect_key: 'journal_vocab:' + rollbackUuid + ':0',
      lifecycle_hooks: { afterCommand() { throw new Error('injected command hook failure'); } },
    })),
    /injected command hook failure/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_vocab WHERE custom_field_uuid=?').get(rollbackUuid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?').get('command-vocab-rollback').n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?').get('command-vocab-rollback').n, 0);
});

test('custom vocabulary freeze detection respects tenant scope and value semantics', async () => {
  const db = new TestDb('custom-vocab-freeze-scope');
  seedIdentity(db);
  const actor = principal();
  const otherActor = principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  });
  const otherGatewayActor = principal({ gateway_device_eui: '0016C001F1000002' });
  const codeFor = (uuid) => 'custom.' + uuid;
  const updated = (body, overrides) => Object.assign({}, body, {
    base_sync_version: 1,
  }, overrides || {});
  const expectFrozen = async (body, overrides) => {
    await assert.rejects(
      journal.upsertCustomVocab(db, updated(body, overrides), actor, body.custom_field_uuid),
      (error) => error && error.code === 'semantic_fields_frozen'
    );
  };

  const activity = customVocabInput('40400000-0000-4000-8000-000000000001');
  const attribute = customVocabInput('40400000-0000-4000-8000-000000000002', {
    kind: 'attribute', value_type: 'text',
  });
  const choiceParent = customVocabInput('40400000-0000-4000-8000-000000000003', {
    kind: 'attribute', value_type: 'choice',
  });
  const choice = customVocabInput('40400000-0000-4000-8000-000000000004', {
    kind: 'choice', parent_code: codeFor(choiceParent.custom_field_uuid),
  });
  const unit = customVocabInput('40400000-0000-4000-8000-000000000005', {
    kind: 'unit',
    quantity_kind: 'water_depth',
    basis: 'water',
    constraints: {
      dimension: 'water_depth',
      to_canonical: { unit_code: 'unit.mm_water', scale: 10, offset: 0 },
    },
  });
  const enteredUnit = customVocabInput('40400000-0000-4000-8000-000000000006', {
    kind: 'unit',
    quantity_kind: 'water_depth',
    basis: 'water',
    constraints: {
      dimension: 'water_depth',
      to_canonical: { unit_code: 'unit.mm_water', scale: 100, offset: 0 },
    },
  });
  const arbitraryText = customVocabInput('40400000-0000-4000-8000-000000000007', {
    kind: 'attribute', value_type: 'text',
  });
  const unused = customVocabInput('40400000-0000-4000-8000-000000000008', {
    kind: 'attribute', value_type: 'text',
  });
  const crossOwner = customVocabInput('40400000-0000-4000-8000-000000000009');
  const crossGateway = customVocabInput('40400000-0000-4000-8000-000000000010');
  for (const body of [
    activity,
    attribute,
    choiceParent,
    choice,
    unit,
    enteredUnit,
    arbitraryText,
    unused,
    crossOwner,
    crossGateway,
  ]) {
    await journal.upsertCustomVocab(db, body, actor);
  }

  const plotUuid = '40500000-0000-4000-8000-000000000001';
  const entryUuid = '40600000-0000-4000-8000-000000000001';
  await journal.upsertPlot(db, plotInput(plotUuid, 'freeze-scope-local'), actor);
  await journal.saveEntry(
    db,
    entryInput(entryUuid, plotUuid, '2026-07-13T06:00:00', { season_crop: 'barley' }),
    actor,
    { mode: 'create' }
  );
  db.prepare('DELETE FROM journal_entry_values WHERE entry_uuid=?').run(entryUuid);
  db.prepare('UPDATE journal_entries SET activity_code=? WHERE entry_uuid=?')
    .run(codeFor(activity.custom_field_uuid), entryUuid);
  const insertValue = db.prepare(
    'INSERT INTO journal_entry_values (' +
      'entry_uuid,attribute_code,group_index,value_status,value_num,value_text,' +
      'unit_code,entered_value_num,entered_unit_code' +
    ') VALUES (?,?,?,?,?,?,?,?,?)'
  );
  insertValue.run(
    entryUuid, codeFor(attribute.custom_field_uuid), 0, 'observed', null, 'direct attribute',
    null, null, null
  );
  insertValue.run(
    entryUuid, codeFor(choiceParent.custom_field_uuid), 0, 'observed', null,
    codeFor(choice.custom_field_uuid), null, null, null
  );
  insertValue.run(
    entryUuid, 'attr.observation_text', 0, 'observed', null,
    codeFor(arbitraryText.custom_field_uuid), null, null, null
  );
  insertValue.run(
    entryUuid, 'attr.irrigation_depth', 0, 'observed', 1, null,
    codeFor(unit.custom_field_uuid), 1, 'unit.mm_water'
  );
  insertValue.run(
    entryUuid, 'attr.irrigation_depth', 1, 'observed', 1, null,
    'unit.mm_water', 0.01, codeFor(enteredUnit.custom_field_uuid)
  );

  const unusedResult = await journal.upsertCustomVocab(
    db,
    updated(unused, { value_type: 'date' }),
    actor,
    unused.custom_field_uuid
  );
  assert.equal(unusedResult.custom_vocab.sync_version, 2);
  const arbitraryResult = await journal.upsertCustomVocab(
    db,
    updated(arbitraryText, { value_type: 'date' }),
    actor,
    arbitraryText.custom_field_uuid
  );
  assert.equal(arbitraryResult.custom_vocab.sync_version, 2);

  await expectFrozen(activity, { kind: 'attribute', value_type: 'text' });
  await expectFrozen(attribute, { value_type: 'date' });
  await expectFrozen(choice, { kind: 'activity', parent_code: null });
  await expectFrozen(unit, {
    constraints: {
      dimension: 'water_depth',
      to_canonical: { unit_code: 'unit.mm_water', scale: 11, offset: 0 },
    },
  });
  await expectFrozen(enteredUnit, {
    constraints: {
      dimension: 'water_depth',
      to_canonical: { unit_code: 'unit.mm_water', scale: 101, offset: 0 },
    },
  });

  const crossOwnerPlot = '40500000-0000-4000-8000-000000000002';
  const crossOwnerEntry = '40600000-0000-4000-8000-000000000002';
  await journal.upsertPlot(db, plotInput(crossOwnerPlot, 'freeze-scope-owner'), otherActor);
  await journal.saveEntry(
    db,
    entryInput(crossOwnerEntry, crossOwnerPlot, '2026-07-13T07:00:00', { season_crop: 'barley' }),
    otherActor,
    { mode: 'create' }
  );
  db.prepare('UPDATE journal_entries SET activity_code=? WHERE entry_uuid=?')
    .run(codeFor(crossOwner.custom_field_uuid), crossOwnerEntry);
  const crossOwnerResult = await journal.upsertCustomVocab(
    db,
    updated(crossOwner, { kind: 'attribute', value_type: 'text' }),
    actor,
    crossOwner.custom_field_uuid
  );
  assert.equal(crossOwnerResult.custom_vocab.sync_version, 2);

  const crossGatewayPlot = '40500000-0000-4000-8000-000000000003';
  const crossGatewayEntry = '40600000-0000-4000-8000-000000000003';
  await journal.upsertPlot(db, plotInput(crossGatewayPlot, 'freeze-scope-gateway'), otherGatewayActor);
  await journal.saveEntry(
    db,
    entryInput(crossGatewayEntry, crossGatewayPlot, '2026-07-13T08:00:00', { season_crop: 'barley' }),
    otherGatewayActor,
    { mode: 'create' }
  );
  db.prepare('UPDATE journal_entries SET activity_code=? WHERE entry_uuid=?')
    .run(codeFor(crossGateway.custom_field_uuid), crossGatewayEntry);
  const crossGatewayResult = await journal.upsertCustomVocab(
    db,
    updated(crossGateway, { kind: 'attribute', value_type: 'text' }),
    actor,
    crossGateway.custom_field_uuid
  );
  assert.equal(crossGatewayResult.custom_vocab.sync_version, 2);

  await assert.rejects(
    journal.upsertCustomVocab(
      db,
      updated(arbitraryText, { base_sync_version: 2, value_type: 'text' }),
      otherActor,
      arbitraryText.custom_field_uuid
    ),
    (error) => error && error.code === 'not_found' && error.statusCode === 404
  );
});

test('custom choices require a visible active choice attribute parent', async () => {
  const db = new TestDb('custom-choice-parent-contract');
  seedIdentity(db);
  const choiceUuid = '40100000-0000-4000-8000-000000000001';
  const missingParentCode = 'custom.40100000-0000-4000-8000-000000000099';
  const choice = customVocabInput(choiceUuid, {
    kind: 'choice',
    parent_code: missingParentCode,
  });
  const beforeMissing = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  await assert.rejects(
    journal.upsertCustomVocab(db, choice, principal()),
    (error) => error && error.code === 'missing_custom_dependency' &&
      error.details[0].dependency_code === missingParentCode &&
      error.details[0].field === 'parent_code'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_vocab WHERE custom_field_uuid=?')
    .get(choiceUuid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeMissing);

  const validParentUuid = '40100000-0000-4000-8000-000000000002';
  const validParentCode = 'custom.' + validParentUuid;
  await journal.upsertCustomVocab(db, customVocabInput(validParentUuid, {
    kind: 'attribute', value_type: 'choice',
  }), principal());
  const created = await journal.upsertCustomVocab(db, Object.assign({}, choice, {
    parent_code: validParentCode,
  }), principal());
  assert.equal(created.custom_vocab.parent_code, validParentCode);
  const catalog = await journal.loadCatalog(db, principal());
  assert.equal(catalog.vocabByCode.get('custom.' + choiceUuid).parent_code, validParentCode);

  const invalidParents = [
    customVocabInput('40100000-0000-4000-8000-000000000003', {
      kind: 'attribute', value_type: 'text',
    }),
    customVocabInput('40100000-0000-4000-8000-000000000004', {
      kind: 'attribute', value_type: 'choice', active: 0,
    }),
    customVocabInput('40100000-0000-4000-8000-000000000005'),
  ];
  for (const parent of invalidParents) {
    await journal.upsertCustomVocab(db, parent, principal());
    const rejectedUuid = parent.custom_field_uuid.replace(/.$/, '6');
    const beforeVocab = db.prepare('SELECT COUNT(*) AS n FROM journal_vocab').get().n;
    const beforeOutbox = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
    await assert.rejects(
      journal.upsertCustomVocab(db, customVocabInput(rejectedUuid, {
        kind: 'choice', parent_code: 'custom.' + parent.custom_field_uuid,
      }), principal()),
      (error) => error && error.code === 'invalid_parent'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_vocab').get().n, beforeVocab);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeOutbox);
  }

  const deletedParentUuid = '40100000-0000-4000-8000-000000000007';
  await journal.upsertCustomVocab(db, customVocabInput(deletedParentUuid, {
    kind: 'attribute', value_type: 'choice',
  }), principal());
  db.prepare('UPDATE journal_vocab SET deleted_at=? WHERE custom_field_uuid=?')
    .run('2026-07-14T00:00:00.000Z', deletedParentUuid);
  await assert.rejects(
    journal.upsertCustomVocab(db, customVocabInput('40100000-0000-4000-8000-000000000008', {
      kind: 'choice', parent_code: 'custom.' + deletedParentUuid,
    }), principal()),
    (error) => error && error.code === 'invalid_parent'
  );

  const foreignParentUuid = '40100000-0000-4000-8000-000000000009';
  await journal.upsertCustomVocab(db, customVocabInput(foreignParentUuid, {
    kind: 'attribute', value_type: 'choice',
  }), principal({
    user_id: 2,
    owner_user_uuid: OTHER_OWNER_UUID,
    author_principal_uuid: OTHER_OWNER_UUID,
    author_label: 'other-user',
  }));
  const beforeForeign = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  await assert.rejects(
    journal.upsertCustomVocab(db, customVocabInput('40100000-0000-4000-8000-000000000010', {
      kind: 'choice', parent_code: 'custom.' + foreignParentUuid,
    }), principal()),
    (error) => error && error.code === 'not_found' && error.statusCode === 404
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeForeign);
});

test('custom attribute constraints use a closed value-type grammar', async () => {
  const db = new TestDb('custom-attribute-constraint-grammar');
  seedIdentity(db);
  const choiceParentUuid = '40200000-0000-4000-8000-000000000000';
  await journal.upsertCustomVocab(db, customVocabInput(choiceParentUuid, {
    kind: 'attribute', value_type: 'choice',
  }), principal());
  const validNumeric = {
    requires_explicit_unit: true,
    allow_default_unit: false,
    semantic_discriminator: 'unit_code',
  };
  const cases = [
    customVocabInput('40200000-0000-4000-8000-000000000001', {
      constraints: { reference: { table: 'devices' } },
    }),
    customVocabInput('40200000-0000-4000-8000-000000000002', {
      kind: 'attribute', value_type: 'number', quantity_kind: 'water_depth', basis: 'water',
      constraints: Object.assign({}, validNumeric, { repeatable: true }),
    }),
    customVocabInput('40200000-0000-4000-8000-000000000003', {
      kind: 'attribute', value_type: 'text', constraints: { maxlength: -1 },
    }),
    customVocabInput('40200000-0000-4000-8000-000000000004', {
      kind: 'attribute', value_type: 'text', constraints: { maxlength: 1.5 },
    }),
    customVocabInput('40200000-0000-4000-8000-000000000005', {
      kind: 'attribute', value_type: 'text', constraints: { maxlength: 4097 },
    }),
    customVocabInput('40200000-0000-4000-8000-000000000006', {
      kind: 'attribute', value_type: 'choice', constraints: { maxlength: 5 },
    }),
    customVocabInput('40200000-0000-4000-8000-000000000007', {
      kind: 'attribute', value_type: 'date', constraints: { unknown: true },
    }),
    customVocabInput('40200000-0000-4000-8000-000000000008', {
      kind: 'attribute', value_type: 'boolean', constraints: { min: 0 },
    }),
    customVocabInput('40200000-0000-4000-8000-000000000010', {
      kind: 'choice', parent_code: 'custom.' + choiceParentUuid, constraints: { unknown: true },
    }),
  ];
  for (const body of cases) {
    const beforeVocab = db.prepare('SELECT COUNT(*) AS n FROM journal_vocab').get().n;
    const beforeOutbox = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
    await assert.rejects(
      journal.upsertCustomVocab(db, body, principal()),
      (error) => error && ['invalid_constraints', 'invalid_irrelevant_field'].includes(error.code),
      body.custom_field_uuid
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_vocab').get().n, beforeVocab);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeOutbox);
  }
  await journal.upsertCustomVocab(db, customVocabInput(
    '40200000-0000-4000-8000-000000000009',
    { kind: 'attribute', value_type: 'text', constraints: { maxlength: 4096 } }
  ), principal());
});

test('custom unit constraints reject unknown root and conversion keys', async () => {
  const db = new TestDb('custom-unit-constraint-grammar');
  seedIdentity(db);
  const base = {
    kind: 'unit', quantity_kind: 'water_depth', basis: 'water',
  };
  for (const constraints of [
    {
      dimension: 'water_depth',
      to_canonical: { unit_code: 'unit.mm_water', scale: 1, offset: 0 },
      repeatable: true,
    },
    {
      dimension: 'water_depth',
      to_canonical: { unit_code: 'unit.mm_water', scale: 1, offset: 0, precision: 2 },
    },
  ]) {
    const uuid = constraints.repeatable
      ? '40300000-0000-4000-8000-000000000001'
      : '40300000-0000-4000-8000-000000000002';
    await assert.rejects(
      journal.upsertCustomVocab(db, customVocabInput(uuid, Object.assign({}, base, { constraints })), principal()),
      (error) => error && error.code === 'invalid_constraints'
    );
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal_vocab WHERE code LIKE 'custom.403%'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type='JOURNAL_VOCAB'").get().n, 0);

  const wrongTargetUuid = '40300000-0000-4000-8000-000000000003';
  await journal.upsertCustomVocab(db, customVocabInput(wrongTargetUuid), principal());
  const beforeWrongTarget = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  await assert.rejects(
    journal.upsertCustomVocab(db, customVocabInput('40300000-0000-4000-8000-000000000004', {
      kind: 'unit', quantity_kind: 'water_depth', basis: 'water',
      constraints: {
        dimension: 'water_depth',
        to_canonical: { unit_code: 'custom.' + wrongTargetUuid, scale: 10, offset: 0 },
      },
    }), principal()),
    (error) => error && error.code === 'invalid_unit_contract'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeWrongTarget);

  const incompatibleTargetUuid = '40300000-0000-4000-8000-000000000005';
  await journal.upsertCustomVocab(db, customVocabInput(incompatibleTargetUuid, {
    kind: 'unit', quantity_kind: 'other_depth', basis: 'water',
    constraints: {
      dimension: 'other_depth',
      to_canonical: {
        unit_code: 'custom.' + incompatibleTargetUuid, scale: 1, offset: 0,
      },
    },
  }), principal());
  const beforeIncompatible = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  await assert.rejects(
    journal.upsertCustomVocab(db, customVocabInput('40300000-0000-4000-8000-000000000006', {
      kind: 'unit', quantity_kind: 'water_depth', basis: 'water',
      constraints: {
        dimension: 'water_depth',
        to_canonical: {
          unit_code: 'custom.' + incompatibleTargetUuid, scale: 10, offset: 0,
        },
      },
    }), principal()),
    (error) => error && error.code === 'invalid_unit_contract'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeIncompatible);
});

test('explicit-unit attributes require a reachable canonical unit path', async () => {
  const db = new TestDb('custom-explicit-unit-reachability');
  seedIdentity(db);
  const identityUuid = '40400000-0000-4000-8000-000000000001';
  const identityCode = 'custom.' + identityUuid;
  const derivedUuid = '40400000-0000-4000-8000-000000000002';
  const derivedCode = 'custom.' + derivedUuid;
  const attributeUuid = '40400000-0000-4000-8000-000000000003';
  const attributeCode = 'custom.' + attributeUuid;
  await journal.upsertCustomVocab(db, customVocabInput(identityUuid, {
    kind: 'unit', quantity_kind: 'review_depth', basis: 'water',
    constraints: {
      dimension: 'review_depth',
      to_canonical: { unit_code: identityCode, scale: 1, offset: 0 },
    },
  }), principal());
  await journal.upsertCustomVocab(db, customVocabInput(derivedUuid, {
    kind: 'unit', quantity_kind: 'review_depth', basis: 'water',
    constraints: {
      dimension: 'review_depth',
      to_canonical: { unit_code: identityCode, scale: 10, offset: 0 },
    },
  }), principal());
  const explicitAttribute = customVocabInput(attributeUuid, {
    kind: 'attribute', value_type: 'number', quantity_kind: 'review_depth', basis: 'water',
    constraints: {
      requires_explicit_unit: true,
      allow_default_unit: false,
      semantic_discriminator: 'unit_code',
    },
  });
  await journal.upsertCustomVocab(db, explicitAttribute, principal());
  let catalog = await journal.loadCatalog(db, principal());
  assert.deepEqual(
    journal.convertToCanonical(catalog, attributeCode, 2, derivedCode),
    { ok: true, value_num: 20, unit_code: identityCode }
  );

  await journal.upsertCustomVocab(db, customVocabInput(identityUuid, {
    base_sync_version: 1,
    kind: 'unit', quantity_kind: 'review_depth', basis: 'water', active: 0,
    constraints: {
      dimension: 'review_depth',
      to_canonical: { unit_code: identityCode, scale: 1, offset: 0 },
    },
  }), principal(), identityUuid);
  const rejectedUuid = '40400000-0000-4000-8000-000000000004';
  const beforeOutbox = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  await assert.rejects(
    journal.upsertCustomVocab(db, Object.assign({}, explicitAttribute, {
      custom_field_uuid: rejectedUuid,
    }), principal()),
    (error) => error && error.code === 'invalid_numeric_contract'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_vocab WHERE custom_field_uuid=?')
    .get(rejectedUuid).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeOutbox);
  catalog = await journal.loadCatalog(db, principal());
  assert.deepEqual(
    journal.convertToCanonical(catalog, 'custom.' + rejectedUuid, 2, derivedCode),
    { ok: false, code: 'invalid_catalog' }
  );
});

test('plot groups enforce homogeneous active membership and preserve resolved provenance', async () => {
  const db = new TestDb('groups');
  seedIdentity(db);
  const first = '50000000-0000-4000-8000-000000000001';
  const second = '50000000-0000-4000-8000-000000000002';
  const greenhouse = '50000000-0000-4000-8000-000000000003';
  await journal.upsertPlot(db, plotInput(first, 'group-1'), principal());
  await journal.upsertPlot(db, plotInput(second, 'group-2'), principal());
  await journal.upsertPlot(db, plotInput(greenhouse, 'group-gh', {
    layout_code: 'greenhouse',
  }), principal());
  const groupUuid = '51000000-0000-4000-8000-000000000001';
  await assert.rejects(
    journal.upsertPlotGroup(db, {
      group_uuid: groupUuid,
      base_sync_version: 0,
      label: 'Empty',
      resolved: false,
      members: [],
    }, principal()),
    (error) => error && error.code === 'empty_active_group'
  );
  await assert.rejects(
    journal.upsertPlotGroup(db, {
      group_uuid: groupUuid,
      base_sync_version: 0,
      label: 'Mixed',
      resolved: false,
      members: [first, greenhouse],
    }, principal()),
    (error) => error && error.code === 'heterogeneous_group'
  );
  const created = await journal.upsertPlotGroup(db, {
    group_uuid: groupUuid,
    base_sync_version: 0,
    label: 'Cohort',
    resolved: false,
    members: [second, first],
  }, principal());
  assert.equal(created.plot_group.owner_user_uuid, OWNER_UUID);
  assert.equal(
    db.prepare('SELECT owner_user_uuid FROM journal_plot_groups WHERE group_uuid=?').get(groupUuid).owner_user_uuid,
    OWNER_UUID
  );
  await journal.upsertPlotGroup(db, {
    group_uuid: groupUuid,
    base_sync_version: 1,
    label: 'Cohort',
    resolved: true,
    members: [first, second],
  }, principal(), groupUuid);
  await assert.rejects(
    journal.upsertPlotGroup(db, {
      group_uuid: groupUuid,
      base_sync_version: 2,
      label: 'Cohort',
      resolved: true,
      members: [first],
    }, principal(), groupUuid),
    (error) => error && error.code === 'resolved_group_members_frozen'
  );
  await journal.upsertPlot(db, plotInput(second, 'group-2', {
    base_sync_version: 1,
    active: 0,
  }), principal(), second);
  const listed = await journal.listPlotGroups(db, principal());
  assert.deepEqual(listed.plot_groups[0].members, [first, second]);
  assert.ok(listed.plot_groups[0].resolved_at);
});

async function createPagedEntries(name, note, count) {
  const db = new TestDb(name);
  seedIdentity(db);
  const entryUuids = Array.from({ length: count || 3 }, (_, index) =>
    '60000000-0000-4000-8000-' + String(index + 1).padStart(12, '0')
  );
  for (let index = 0; index < entryUuids.length; index += 1) {
    const plotUuid = '61000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
    await journal.upsertPlot(db, plotInput(plotUuid, 'page-' + index, {
      zone_uuid: index === 0 ? ZONE_UUID : null,
    }), principal());
    await journal.saveEntry(
      db,
      entryInput(entryUuids[index], plotUuid, '2026-07-13T09:00:00', {
        season_crop: 'barley',
        occurred_end_local: index === 0 ? '2026-07-13T09:30:00' : null,
        note: index === 0 && note ? note : 'Page ' + index,
      }),
      principal(),
      { mode: 'create' }
    );
  }
  return { db, entryUuids };
}

test('entry keyset pagination is stable for equal timestamps and rejects cursor filter reuse', async () => {
  const { db, entryUuids } = await createPagedEntries('pagination');
  const seen = [];
  let cursor = null;
  do {
    const page = await journal.listEntries(db, { status: 'final', limit: 1, cursor }, principal());
    seen.push(...page.entries.map((entry) => entry.entry_uuid));
    cursor = page.next_cursor;
    if (seen.length === 1) {
      await assert.rejects(
        journal.listEntries(db, { status: 'final', activity_code: 'irrigation', limit: 1, cursor }, principal()),
        (error) => error && error.code === 'invalid_cursor'
      );
    }
  } while (cursor);
  assert.deepEqual(seen, entryUuids);
});

function parseStoredZip(buffer) {
  const endSignature = Buffer.from([0x50, 0x4B, 0x05, 0x06]);
  const endOffset = buffer.lastIndexOf(endSignature);
  assert.notEqual(endOffset, -1, 'ZIP end record missing');
  const count = buffer.readUInt16LE(endOffset + 10);
  let offset = buffer.readUInt32LE(endOffset + 16);
  const members = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014B50);
    assert.equal(buffer.readUInt16LE(offset + 10), 0, 'member must use stored compression');
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034B50);
    assert.equal(buffer.readUInt16LE(localOffset + 6) & 0x08, 0x08, 'member uses data descriptor');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    members.push({ name, data: buffer.subarray(dataStart, dataStart + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

class BackpressureSink extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode || 'drain';
    this.destroyed = false;
    this.writableEnded = false;
    this.writes = 0;
    this.chunks = [];
    this.maxDrainListeners = 0;
    this.headers = {};
  }

  write(chunk) {
    this.writes += 1;
    this.chunks.push(Buffer.from(chunk));
    setImmediate(() => {
      this.maxDrainListeners = Math.max(this.maxDrainListeners, this.listenerCount('drain'));
      if (this.mode === 'error') this.emit('error', new Error('injected sink error'));
      else this.emit(this.mode);
    });
    return false;
  }

  end() {
    this.writableEnded = true;
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }
}

function wideCustomUuid(index) {
  return '71000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
}

function insertWideVocab(db, codes) {
  const insert = db.prepare(
    'INSERT INTO journal_vocab(' +
      'code,kind,value_type,labels_json,scope,owner_user_uuid,gateway_device_eui,' +
      'custom_field_uuid,active,sort_order,sync_version,created_at' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    const customUuid = /^custom\.[0-9a-f-]{36}$/.test(code) ? code.slice(7) : null;
    insert.run(
      code,
      'attribute',
      'text',
      JSON.stringify({ en: 'Wide field ' + index }),
      customUuid ? 'custom' : 'core',
      customUuid ? OWNER_UUID : null,
      customUuid ? GATEWAY_EUI : null,
      customUuid,
      1,
      index,
      1,
      '2026-07-14T00:00:00.000Z'
    );
  }
}

function insertWideEntries(db, cells, options) {
  const settings = Object.assign({ valuesPerEntry: 128, text: 'x' }, options || {});
  const insertEntry = db.prepare(
    'INSERT INTO journal_entries(' +
      'entry_uuid,owner_user_uuid,user_id,author_principal_uuid,activity_code,' +
      'template_code,template_version,layout_code,layout_version,catalog_version,' +
      'occurred_start,occurred_timezone,occurred_utc_offset_minutes,recorded_at,' +
      'origin,status,sync_version,gateway_device_eui,created_at,updated_at' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  const insertValue = db.prepare(
    'INSERT INTO journal_entry_values(' +
      'entry_uuid,attribute_code,group_index,value_status,value_text' +
    ') VALUES (?,?,?,?,?)'
  );
  for (let offset = 0, entryIndex = 0; offset < cells.length;
    offset += settings.valuesPerEntry, entryIndex += 1) {
    const entryUuid = '72000000-0000-4000-8000-' + entryIndex.toString(16).padStart(12, '0');
    const recordedAt = new Date(Date.parse('2026-07-14T00:00:00.000Z') + entryIndex * 60_000)
      .toISOString();
    insertEntry.run(
      entryUuid,
      OWNER_UUID,
      1,
      OWNER_UUID,
      'irrigation',
      'farmer_quick',
      1,
      'open_field',
      1,
      1,
      recordedAt,
      'UTC',
      0,
      recordedAt,
      'edge-ui',
      'final',
      1,
      GATEWAY_EUI,
      recordedAt,
      recordedAt
    );
    for (const cell of cells.slice(offset, offset + settings.valuesPerEntry)) {
      insertValue.run(
        entryUuid,
        cell.attribute_code,
        cell.group_index,
        'observed',
        settings.text
      );
    }
  }
}

function customWideCells(count) {
  return Array.from({ length: count }, function(_, index) {
    return {
      attribute_code: 'custom.' + wideCustomUuid(index + 1),
      group_index: index % 32,
    };
  });
}

test('wide CSV accepts 256 pivot cells, sorts in JavaScript, and bounds exact reconstructed writes', async () => {
  const db = new TestDb('wide-csv-limit-accepted');
  seedIdentity(db);
  const cells = customWideCells(256);
  insertWideVocab(db, cells.map(function(cell) { return cell.attribute_code; }).reverse());
  insertWideEntries(db, cells.slice().reverse(), { text: '\u00e9'.repeat(400) });

  const expected = await journal.exportWideCsv(db, { status: 'final' }, principal());
  const sink = new BackpressureSink('drain');
  const result = await journal.exportWideCsv(db, { status: 'final' }, principal(), sink);
  assert.equal(result, null);
  assert.ok(sink.writableEnded);
  assert.equal(Buffer.concat(sink.chunks).toString('utf8'), expected);
  const logicalLines = expected.split('\r\n').filter(Boolean);
  assert.ok(
    logicalLines.some(function(line) { return Buffer.byteLength(line + '\r\n', 'utf8') > 64 * 1024; }),
    'fixture must contain a logical row larger than one sink write'
  );
  assert.ok(sink.chunks.length > 4, 'rows larger than one chunk must be split');
  assert.ok(
    sink.chunks.every(function(chunk) { return chunk.length <= 64 * 1024; }),
    'every wide CSV sink write must be at most 64 KiB'
  );

  const header = parseCsvRecords(expected)[0].map(function(cell) { return cell.value; });
  const headerEnd = expected.indexOf('\r\n') + 2;
  assert.ok(Buffer.byteLength(expected.slice(0, headerEnd), 'utf8') <= 64 * 1024);
  const actualDynamicStatus = header.filter(function(column) {
    return column.startsWith('value.') && column.endsWith('.status');
  });
  const expectedDynamicStatus = cells.slice().sort(function(left, right) {
    return left.group_index - right.group_index ||
      (left.attribute_code < right.attribute_code ? -1 : (left.attribute_code > right.attribute_code ? 1 : 0));
  }).map(function(cell) {
    return 'value.' + cell.group_index + '.' + cell.attribute_code + '.status';
  });
  assert.deepEqual(actualDynamicStatus, expectedDynamicStatus);
  assert.equal(db.wideCellQueries.length, 2);
  for (const query of db.wideCellQueries) {
    assert.match(query.sql, /LIMIT \?/);
    assert.doesNotMatch(query.sql, /ORDER BY/);
    assert.equal(query.params.at(-1), 257);
  }
});

test('wide CSV rejects a 257th pivot cell before any sink write', async () => {
  const db = new TestDb('wide-csv-limit-rejected');
  seedIdentity(db);
  const cells = customWideCells(257);
  insertWideVocab(db, cells.map(function(cell) { return cell.attribute_code; }));
  insertWideEntries(db, cells);
  const sink = new BackpressureSink('drain');

  await assert.rejects(
    journal.exportWideCsv(db, { status: 'final' }, principal(), sink),
    function(error) {
      assert.equal(error && error.statusCode, 413);
      assert.equal(error && error.code, 'wide_export_too_wide');
      assert.deepEqual(error && error.details, {
        reason: 'pivot_cells',
        max_pivot_cells: 256,
        observed_pivot_cells: 257,
        max_header_bytes: 64 * 1024,
        fallback_export: '/api/journal/export.package',
      });
      return true;
    }
  );
  assert.equal(sink.writes, 0);
  assert.equal(sink.writableEnded, false);
});

test('wide CSV rejects a computed header over 64 KiB before any sink write', async () => {
  const db = new TestDb('wide-csv-header-rejected');
  seedIdentity(db);
  const codes = Array.from({ length: 256 }, function(_, index) {
    return 'attr.wide_' + String(index).padStart(3, '0') + '_' + 'x'.repeat(300);
  });
  const cells = codes.map(function(attributeCode, index) {
    return { attribute_code: attributeCode, group_index: index % 32 };
  });
  insertWideVocab(db, codes);
  insertWideEntries(db, cells);
  const sink = new BackpressureSink('drain');

  await assert.rejects(
    journal.exportWideCsv(db, { status: 'final' }, principal(), sink),
    function(error) {
      assert.equal(error && error.statusCode, 413);
      assert.equal(error && error.code, 'wide_export_too_wide');
      assert.equal(error && error.details && error.details.reason, 'header_bytes');
      assert.ok(error && error.details && error.details.header_bytes > 64 * 1024);
      assert.equal(error && error.details && error.details.max_header_bytes, 64 * 1024);
      assert.equal(
        error && error.details && error.details.fallback_export,
        '/api/journal/export.package'
      );
      return true;
    }
  );
  assert.equal(sink.writes, 0);
  assert.equal(sink.writableEnded, false);
});

test('HTTP export.csv rejects an oversized header before preparing the stream', async () => {
  const db = new TestDb('wide-csv-header-route-rejected');
  seedIdentity(db);
  const codes = Array.from({ length: 256 }, function(_, index) {
    return 'attr.wide_http_' + String(index).padStart(3, '0') + '_' + 'x'.repeat(300);
  });
  const cells = codes.map(function(attributeCode, index) {
    return { attribute_code: attributeCode, group_index: index % 32 };
  });
  insertWideVocab(db, codes);
  insertWideEntries(db, cells);
  const secret = 'wide-csv-header-route-secret';
  const authorization = 'Bearer ' + token(secret, {
    userId: 1,
    username: 'field-user',
    exp: Date.now() + 60_000,
  });
  const sink = new BackpressureSink('drain');

  const response = await journal.handleHttpRequest({
    msg: {
      req: {
        method: 'GET',
        path: '/api/journal/export.csv',
        headers: { authorization },
        query: { status: 'final' },
        params: {},
      },
      res: sink,
    },
    Database: class { constructor() { return db; } },
    environment: {
      authTokenSecret: secret,
      deviceEui: GATEWAY_EUI,
      deviceEuiConfidence: 'authoritative',
    },
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.payload.error, 'wide_export_too_wide');
  assert.equal(response.payload.details.reason, 'header_bytes');
  assert.ok(response.payload.details.header_bytes > 64 * 1024);
  assert.equal(response.payload.details.max_header_bytes, 64 * 1024);
  assert.equal(response.payload.details.fallback_export, '/api/journal/export.package');
  assert.deepEqual(sink.headers, {});
  assert.equal(sink.writes, 0);
  assert.equal(sink.writableEnded, false);
  assert.equal(db.closeCalls, 1);
  assert.equal(db.snapshotClosed, 1);
});

test('HTTP export.csv returns 413 before preparing or writing the CSV stream', async () => {
  const db = new TestDb('wide-csv-route-rejected');
  seedIdentity(db);
  const cells = customWideCells(257);
  insertWideVocab(db, cells.map(function(cell) { return cell.attribute_code; }));
  insertWideEntries(db, cells);
  const secret = 'wide-csv-route-secret';
  const authorization = 'Bearer ' + token(secret, {
    userId: 1,
    username: 'field-user',
    exp: Date.now() + 60_000,
  });
  const sink = new BackpressureSink('drain');

  const response = await journal.handleHttpRequest({
    msg: {
      req: {
        method: 'GET',
        path: '/api/journal/export.csv',
        headers: { authorization },
        query: { status: 'final' },
        params: {},
      },
      res: sink,
    },
    Database: class { constructor() { return db; } },
    environment: {
      authTokenSecret: secret,
      deviceEui: GATEWAY_EUI,
      deviceEuiConfidence: 'authoritative',
    },
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.payload.error, 'wide_export_too_wide');
  assert.equal(response.payload.details.fallback_export, '/api/journal/export.package');
  assert.equal(sink.writes, 0);
  assert.equal(sink.writableEnded, false);
  assert.deepEqual(sink.headers, {});
  assert.equal(db.closeCalls, 1);
});

test('research exports are loss-aware, formula-safe, incremental, and ZIP-manifest complete', async () => {
  const { db } = await createPagedEntries('exports', '=SUM(1,2)', 101);
  db.prepare('UPDATE journal_entries SET context_json=? WHERE entry_uuid=?').run(
    '{"schema_version":1,"channels":{}}',
    '60000000-0000-4000-8000-000000000002'
  );
  db.prepare(
    'UPDATE journal_entry_values SET entered_value_num=?,entered_unit_code=?,value_num=?,unit_code=? ' +
      'WHERE entry_uuid=? AND attribute_code=?'
  ).run(
    1,
    'unit.hour_duration',
    60,
    'unit.min_duration',
    '60000000-0000-4000-8000-000000000002',
    'attr.irrigation_depth'
  );
  db.valueBatchSizes = [];
  const csv = await journal.exportWideCsv(db, { status: 'final' }, principal());
  assert.match(csv, /\r\n/);
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.ok(!/(^|[^\r])\n/.test(csv.replace(/\r\n/g, '')), 'CSV has RFC4180 CRLF only');

  const exportSelection = { status: 'final', limit: 'n/a', cursor: 'ignored-export-cursor' };
  const build = {
    edgeBuildVersion: '2026.07-test',
    edgeBuildCommit: '0123456789abcdef0123456789abcdef01234567',
  };
  const jsonText = await journal.exportJson(db, exportSelection, principal(), null, build);
  const json = JSON.parse(jsonText);
  assert.equal(json.record_counts.entries, 101);
  const metadata = json.research_metadata;
  assert.match(metadata.dataset_uuid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.match(metadata.export_uuid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok(Number.isFinite(Date.parse(metadata.generated_at)));
  assert.deepEqual(metadata.selection, { status: 'final' });
  assert.equal(metadata.source.authority, 'edge-canonical');
  assert.equal(metadata.source.gateway_device_eui, GATEWAY_EUI);
  assert.deepEqual(metadata.source.farm_identifier, {
    value: null,
    reason: 'farm_identifier_not_recorded',
  });
  assert.deepEqual(metadata.source.zone_uuids, [ZONE_UUID]);
  assert.equal(metadata.source.plot_uuids.length, 101);
  const effectiveEnds = json.entries.map((entry) => entry.occurred_end || entry.occurred_start).sort();
  assert.equal(metadata.coverage.occurred_end_from, effectiveEnds[0]);
  assert.equal(metadata.coverage.occurred_end_to, effectiveEnds[effectiveEnds.length - 1]);
  assert.equal(
    metadata.coverage.occurred_end_semantics,
    'occurred_end_or_occurred_start_for_instantaneous_entries'
  );
  assert.ok(metadata.coverage.recorded_from);
  assert.ok(metadata.coverage.recorded_to);
  assert.deepEqual(metadata.exporter.version, { value: '1.0.0', reason: null });
  assert.deepEqual(metadata.exporter.edge_build_version, {
    value: build.edgeBuildVersion,
    reason: null,
  });
  assert.deepEqual(metadata.exporter.commit, {
    value: build.edgeBuildCommit,
    reason: null,
  });
  assert.equal(metadata.schema.version, 1);
  assert.equal(metadata.schema.hash_scope, 'logical_research_schema_descriptor_v1');
  assert.equal(metadata.schema.hash_sha256, aggregateHash(RESEARCH_SCHEMA_DESCRIPTOR));
  assert.deepEqual(metadata.schema.package_members, RESEARCH_PACKAGE_MEMBERS);
  assert.equal(metadata.schema.csv_string_safety, RESEARCH_SCHEMA_DESCRIPTOR.csv_string_safety);
  assert.equal(metadata.schema.lossless_member, 'records.ndjson');
  assert.deepEqual(metadata.catalog, {
    hash_scope: 'core_catalog_state',
    core_version: 1,
    core_hash: metadata.catalog.core_hash,
    scoped_effective_hash: {
      value: null,
      reason: 'scoped_catalog_hash_not_materialized',
    },
  });
  assert.match(metadata.catalog.core_hash, /^[a-f0-9]{64}$/);
  assert.equal(metadata.context_generator.hash_scope, 'frozen_context_json_generator_contract');
  assert.equal(metadata.context_generator.pinned.length, 1);
  assert.equal(metadata.context_generator.pinned[0].generator_name, 'osi-journal-context');
  assert.equal(metadata.context_generator.pinned[0].generator_version, 1);
  assert.match(metadata.context_generator.pinned[0].generator_contract_sha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.context_generator.pinned[0].entry_count, 1);
  assert.deepEqual(metadata.context_generator.per_capture_binary_hash, {
    value: null,
    reason: 'context_generator_binary_hash_not_recorded_at_capture',
  });
  assert.deepEqual(metadata.context_generator.unpinned_entries, {
    count: 1,
    reason: 'context_generator_pin_not_recorded',
  });
  assert.deepEqual(metadata.context_generator.no_context_entries, {
    count: 99,
    reason: 'context_snapshot_not_recorded',
  });
  assert.deepEqual(metadata.record_counts, {
    entries: 101,
    values: 101,
    vocab_mappings: 7,
  });
  const template = metadata.definitions.templates.find((item) =>
    item.code === 'farmer_quick' && item.version === 1
  );
  const templateRaw = db.prepare(
    'SELECT definition_json FROM journal_templates WHERE code=? AND version=?'
  ).get('farmer_quick', 1).definition_json;
  assert.equal(template.hash_scope, 'raw_definition_json_utf8');
  assert.equal(template.definition_sha256, crypto.createHash('sha256').update(templateRaw).digest('hex'));
  const layout = metadata.definitions.layouts.find((item) =>
    item.code === 'open_field' && item.version === 1
  );
  const layoutRaw = db.prepare(
    'SELECT definition_json FROM journal_layouts WHERE code=? AND version=?'
  ).get('open_field', 1).definition_json;
  assert.equal(layout.hash_scope, 'raw_definition_json_utf8');
  assert.equal(layout.definition_sha256, crypto.createHash('sha256').update(layoutRaw).digest('hex'));
  const adaptSource = metadata.mapping_sources.find((source) =>
    source.scheme_uri === 'https://github.com/ADAPT/Standard'
  );
  assert.equal(adaptSource.source_uri.value,
    'https://github.com/ADAPT/Standard/blob/1.0.0/adapt-data-type-definitions.json');
  assert.deepEqual(adaptSource.license, {
    value: null,
    reason: 'mapping_license_not_recorded',
  });
  const millimeter = metadata.unit_transformations.find((unit) => unit.unit_code === 'unit.mm_water');
  assert.equal(millimeter.transformation.to_canonical.unit_code, 'unit.mm_water');
  assert.equal(millimeter.transformation.to_canonical.scale, 1);
  assert.equal(millimeter.hash_scope, 'raw_constraints_json_utf8');
  assert.match(millimeter.definition_sha256, /^[a-f0-9]{64}$/);
  const hour = metadata.unit_transformations.find((unit) => unit.unit_code === 'unit.hour_duration');
  const hourRaw = db.prepare('SELECT constraints_json FROM journal_vocab WHERE code=?')
    .get('unit.hour_duration').constraints_json;
  assert.equal(hour.transformation.to_canonical.unit_code, 'unit.min_duration');
  assert.equal(hour.transformation.to_canonical.scale, 60);
  assert.equal(hour.transformation.to_canonical.offset, 0);
  assert.equal(hour.transformation.formula, 'canonical_value = entered_value * scale + offset');
  assert.equal(hour.definition_sha256, crypto.createHash('sha256').update(hourRaw).digest('hex'));
  assert.equal(metadata.provenance.author_identity_included, false);
  assert.equal(metadata.provenance.owner_identity_included, false);
  assert.equal(
    json.checksums.research_metadata_sha256,
    crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex')
  );
  assert.match(json.checksums.entries_sha256, /^[a-f0-9]{64}$/);
  assert.match(json.checksums.values_sha256, /^[a-f0-9]{64}$/);
  assert.ok(json.entries.every((entry) => !('author_label' in entry) &&
    !('author_principal_uuid' in entry) && !('owner_user_uuid' in entry) &&
    !('voided_by_principal_uuid' in entry)));

  const zip = await journal.exportResearchPackage(db, exportSelection, principal(), null, build);
  const members = parseStoredZip(zip);
  assert.deepEqual(members.map((member) => member.name), RESEARCH_PACKAGE_MEMBERS);
  const manifest = JSON.parse(members[4].data.toString('utf8'));
  assert.deepEqual(
    Object.keys(manifest.research_metadata).sort(),
    Object.keys(metadata).sort()
  );
  assert.match(
    manifest.research_metadata.dataset_uuid,
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
  );
  assert.match(
    manifest.research_metadata.export_uuid,
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
  );
  assert.ok(Number.isFinite(Date.parse(manifest.research_metadata.generated_at)));
  assert.deepEqual(manifest.research_metadata.metadata_contract, metadata.metadata_contract);
  assert.deepEqual(manifest.research_metadata.coverage, metadata.coverage);
  assert.deepEqual(manifest.research_metadata.selection, metadata.selection);
  assert.deepEqual(manifest.research_metadata.source, metadata.source);
  assert.deepEqual(manifest.research_metadata.exporter, metadata.exporter);
  assert.deepEqual(manifest.research_metadata.schema, metadata.schema);
  assert.deepEqual(manifest.research_metadata.context_generator, metadata.context_generator);
  assert.deepEqual(manifest.research_metadata.catalog, metadata.catalog);
  assert.deepEqual(manifest.research_metadata.definitions, metadata.definitions);
  assert.deepEqual(manifest.research_metadata.mapping_sources, metadata.mapping_sources);
  assert.deepEqual(manifest.research_metadata.unit_transformations, metadata.unit_transformations);
  assert.deepEqual(manifest.research_metadata.record_counts, metadata.record_counts);
  assert.deepEqual(manifest.research_metadata.provenance, metadata.provenance);
  assert.equal(
    manifest.checksums.research_metadata_sha256,
    crypto.createHash('sha256').update(JSON.stringify(manifest.research_metadata)).digest('hex')
  );
  assert.equal(manifest.members.length, 4);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(manifest.members[index].name, members[index].name);
    assert.equal(manifest.members[index].size_bytes, members[index].data.length);
    assert.equal(manifest.members[index].sha256, crypto.createHash('sha256').update(members[index].data).digest('hex'));
  }
  const recordsDescriptor = manifest.members.find((member) => member.name === 'records.ndjson');
  const recordsMember = members.find((member) => member.name === 'records.ndjson');
  assert.equal(recordsDescriptor.size_bytes, recordsMember.data.length);
  assert.equal(
    recordsDescriptor.sha256,
    crypto.createHash('sha256').update(recordsMember.data).digest('hex')
  );
  assert.doesNotMatch(members[0].data.toString('utf8').split('\r\n')[0], /author|owner_user_uuid/);

  const unavailable = JSON.parse(await journal.exportJson(
    db,
    { entry_uuid: '60000000-0000-4000-8000-000000000001' },
    principal()
  )).research_metadata.exporter;
  assert.deepEqual(unavailable.edge_build_version, {
    value: null,
    reason: 'edge_build_version_unavailable',
  });
  assert.deepEqual(unavailable.commit, {
    value: null,
    reason: 'edge_build_commit_unavailable',
  });
  assert.ok(db.valueBatchSizes.length > 0);
  assert.ok(db.valueBatchSizes.every((size) => size <= 50), 'value lookups stay within 50-entry pages');
  assert.ok(db.valueBatchSizes.includes(50), 'export crossed a full 50-entry value page');

  const sink = new BackpressureSink('drain');
  const result = await journal.exportJson(db, { status: 'final' }, principal(), sink);
  assert.equal(result, null);
  assert.ok(sink.writes >= 4, 'export writes incrementally');
  assert.equal(sink.maxDrainListeners, 1);
  assert.equal(sink.listenerCount('drain'), 0);
  assert.equal(sink.listenerCount('close'), 0);
  assert.equal(sink.listenerCount('error'), 0);
});

test('research JSON excludes the void actor and all author or owner identity', async () => {
  const { db, entryUuids } = await createPagedEntries('export-void-identity', null, 1);
  await journal.voidEntry(db, entryUuids[0], {
    base_sync_version: 1,
    reason: 'Duplicate field record',
  }, principal({
    author_principal_uuid: VOID_ACTOR_UUID,
    author_label: 'void-reviewer',
  }));

  const json = JSON.parse(await journal.exportJson(db, { status: 'voided' }, principal()));
  assert.equal(json.entries.length, 1);
  const entry = json.entries[0];
  assert.equal(entry.status, 'voided');
  assert.equal(entry.void_reason, 'Duplicate field record');
  assert.ok(entry.voided_at);
  for (const field of [
    'owner_user_uuid',
    'author_principal_uuid',
    'author_label',
    'voided_by_principal_uuid',
  ]) {
    assert.equal(field in entry, false, field);
  }
  assert.equal(json.research_metadata.provenance.author_identity_included, false);
  assert.equal(json.research_metadata.provenance.owner_identity_included, false);
  const publicSurface = JSON.stringify(json);
  for (const privateValue of [OWNER_UUID, VOID_ACTOR_UUID, 'field-user', 'void-reviewer']) {
    assert.equal(publicSurface.includes(privateValue), false, privateValue);
  }
});

test('stream abort rejects and releases the read snapshot without leaked listeners', async () => {
  const { db } = await createPagedEntries('export-abort');
  const sink = new BackpressureSink('close');
  await assert.rejects(
    journal.exportWideCsv(db, { status: 'final' }, principal(), sink),
    (error) => error && error.code === 'client_aborted'
  );
  assert.equal(db.snapshotClosed, 1);
  assert.equal(sink.listenerCount('drain'), 0);
  assert.equal(sink.listenerCount('close'), 0);
  assert.equal(sink.listenerCount('error'), 0);

  const errorSink = new BackpressureSink('error');
  await assert.rejects(
    journal.exportWideCsv(db, { status: 'final' }, principal(), errorSink),
    /injected sink error/
  );
  assert.equal(db.snapshotClosed, 2);
  assert.equal(errorSink.listenerCount('drain'), 0);
  assert.equal(errorSink.listenerCount('close'), 0);
  assert.equal(errorSink.listenerCount('error'), 0);
});

test('HTTP handler returns 401 before secret lookup, 503 for missing secret, and closes DB on 501', async () => {
  let secretReads = 0;
  class MustNotOpen {
    constructor() {
      throw new Error('database must not open');
    }
  }
  for (const authorization of [undefined, 'Basic x', 'Bearer malformed']) {
    const msg = { req: { method: 'GET', path: '/api/journal/catalog', headers: { authorization } } };
    const response = await journal.handleHttpRequest({
      msg,
      Database: MustNotOpen,
      environment: { readFile() { secretReads += 1; } },
    });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(secretReads, 0);

  const syntactic = 'Bearer ' + base64url('{}') + '.signature';
  const missingSecret = await journal.handleHttpRequest({
    msg: { req: { method: 'GET', path: '/api/journal/catalog', headers: { authorization: syntactic } } },
    Database: MustNotOpen,
    environment: {
      readFile() {
        secretReads += 1;
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
    },
  });
  assert.equal(missingSecret.statusCode, 503);
  assert.equal(secretReads, 2);

  const db = new TestDb('router');
  seedIdentity(db);
  const secret = 'router-secret';
  const authorization = 'Bearer ' + token(secret, {
    userId: 1,
    username: 'field-user',
    exp: Date.now() + 60_000,
  });
  class ExistingDb {
    constructor() {
      return db;
    }
  }
  const adapt = await journal.handleHttpRequest({
    msg: {
      req: {
        method: 'GET',
        path: '/api/journal/export.adapt.json',
        headers: { authorization },
        query: {},
        params: {},
      },
    },
    Database: ExistingDb,
    environment: {
      authTokenSecret: secret,
      deviceEui: GATEWAY_EUI,
      deviceEuiConfidence: 'authoritative',
    },
  });
  assert.equal(adapt.statusCode, 501);
  assert.equal(adapt.payload.error, 'not_implemented');
  assert.equal(db.closeCalls, 1);
});

test('HTTP handler enforces ownership and limits, then round-trips a created entry', async () => {
  const db = new TestDb('router-roundtrip');
  seedIdentity(db);
  const plotUuid = '70000000-0000-4000-8000-000000000001';
  await journal.upsertPlot(
    db,
    plotInput(plotUuid, 'router-plot', { zone_uuid: ZONE_UUID }),
    principal()
  );
  const secret = 'router-roundtrip-secret';
  const authorization = 'Bearer ' + token(secret, {
    userId: 1,
    username: 'field-user',
    exp: Date.now() + 60_000,
  });
  class ExistingDb {
    constructor() {
      return db;
    }
  }
  const environment = {
    authTokenSecret: secret,
    deviceEui: GATEWAY_EUI,
    deviceEuiConfidence: 'authoritative',
  };
  async function request(method, requestPath, options) {
    const requestOptions = options || {};
    return journal.handleHttpRequest({
      msg: {
        req: {
          method,
          path: requestPath,
          headers: Object.assign({ authorization }, requestOptions.headers || {}),
          body: requestOptions.body,
          query: requestOptions.query || {},
          params: requestOptions.params || {},
        },
      },
      Database: ExistingDb,
      environment,
    });
  }

  const foreign = await request('POST', '/api/journal/plots', {
    body: plotInput('70000000-0000-4000-8000-000000000002', 'foreign-router', {
      zone_uuid: FOREIGN_ZONE_UUID,
    }),
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.payload.error, 'not_found');

  const oversized = await request('POST', '/api/journal/entries', {
    headers: { 'content-length': String(256 * 1024 + 1) },
    body: {},
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.payload.error, 'body_too_large');

  const entryUuid = '71000000-0000-4000-8000-000000000001';
  const missingDependency = await request('POST', '/api/journal/entries', {
    body: entryInput(
      '71000000-0000-4000-8000-000000000002',
      plotUuid,
      '2026-07-13T13:00:00',
      { activity_code: 'custom.99999999-9999-4999-8999-999999999999' }
    ),
  });
  assert.equal(missingDependency.statusCode, 422);
  assert.equal(missingDependency.payload.error, 'missing_custom_dependency');
  assert.equal(missingDependency.payload.details[0].dependency_code,
    'custom.99999999-9999-4999-8999-999999999999');

  const created = await request('POST', '/api/journal/entries', {
    body: entryInput(entryUuid, plotUuid, '2026-07-13T14:00:00'),
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.payload.entry_uuid, entryUuid);

  const listed = await request('GET', '/api/journal/entries', {
    query: { status: 'final' },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.payload.entries.map((entry) => entry.entry_uuid), [entryUuid]);
  assert.equal(db.closeCalls, 5);
});

test('batch duplicate preflight returns every candidate and accepts only the exact acknowledgement set', async () => {
  const db = new TestDb('batch-duplicate-preflight');
  seedIdentity(db);
  const plots = [
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000002',
  ];
  const candidates = [
    '82000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000002',
  ];
  for (let index = 0; index < plots.length; index += 1) {
    await journal.upsertPlot(db, plotInput(plots[index], 'batch-duplicate-' + index), principal());
    await journal.saveEntry(
      db,
      entryInput(candidates[index], plots[index], '2026-07-13T08:00:00', { season_crop: 'barley' }),
      principal(),
      { mode: 'create' }
    );
  }
  const beforeEntries = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  const beforeOutbox = db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n;
  const batch = entryInput(null, null, '2026-07-13T08:30:00', {
    entry_uuid: null,
    plot_uuid: null,
    plot_uuids: plots,
    season_crop: 'barley',
  });

  await assert.rejects(
    journal.saveEntry(db, batch, principal(), { mode: 'create' }),
    (error) => {
      assert.equal(error.code, 'duplicate_candidates');
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.details.duplicateCandidates, [
        {
          entryUuid: candidates[0],
          occurredStart: '2026-07-13T06:00:00.000Z',
          activityCode: 'irrigation',
          plotUuid: plots[0],
        },
        {
          entryUuid: candidates[1],
          occurredStart: '2026-07-13T06:00:00.000Z',
          activityCode: 'irrigation',
          plotUuid: plots[1],
        },
      ]);
      assert.deepEqual(
        Object.keys(error.details.duplicateCandidates[0]).sort(),
        ['activityCode', 'entryUuid', 'occurredStart', 'plotUuid']
      );
      return true;
    }
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, beforeEntries);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeOutbox);

  await assert.rejects(
    journal.saveEntry(db, Object.assign({}, batch, {
      duplicate_guard_ack_entry_uuids: [candidates[0]],
    }), principal(), { mode: 'create' }),
    (error) => error && error.code === 'duplicate_candidates' &&
      error.details.duplicateCandidates.length === 1 &&
      error.details.duplicateCandidates[0].entryUuid === candidates[1]
  );
  for (const invalid of [
    [candidates[0], candidates[0]],
    ['not-a-uuid'],
    ['83000000-0000-4000-8000-000000000001'],
    Array.from({ length: 101 }, (_, index) =>
      '84' + String(index).padStart(6, '0') + '-0000-4000-8000-000000000001'),
  ]) {
    await assert.rejects(
      journal.saveEntry(db, Object.assign({}, batch, {
        duplicate_guard_ack_entry_uuids: invalid,
      }), principal(), { mode: 'create' }),
      (error) => error && ['invalid_duplicate_ack', 'duplicate_duplicate_ack', 'too_many_duplicate_acks']
        .includes(error.code)
    );
  }
  await assert.rejects(
    journal.saveEntry(db, Object.assign(
      entryInput('85000000-0000-4000-8000-000000000001', plots[0], '2026-07-13T12:00:00', {
        season_crop: 'barley',
      }),
      { duplicate_guard_ack_entry_uuids: [] }
    ), principal(), { mode: 'create' }),
    (error) => error && error.code === 'invalid_batch_control'
  );

  const accepted = await journal.saveEntry(db, Object.assign({}, batch, {
    duplicate_guard_ack_entry_uuids: candidates,
  }), principal(), { mode: 'create' });
  assert.equal(accepted.entries.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, beforeEntries + 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, beforeOutbox + 2);
  for (const entry of accepted.entries) {
    const aggregate = JSON.parse(db.prepare(
      "SELECT payload_json FROM sync_outbox WHERE aggregate_type='JOURNAL_ENTRY' AND aggregate_key=?"
    ).get(entry.entry_uuid).payload_json);
    assert.equal('duplicate_guard_ack_entry_uuids' in aggregate, false);
    assert.equal('duplicate_guard_ack_entry_uuid' in aggregate, false);
  }
});

test('code-only plot layout binding rolls forward to the latest active version without rewriting history', async () => {
  const db = new TestDb('layout-rollover');
  seedIdentity(db);
  const historicalPlot = '86000000-0000-4000-8000-000000000001';
  const historicalEntry = '86000000-0000-4000-8000-000000000002';
  await journal.upsertPlot(db, plotInput(historicalPlot, 'layout-v1-history'), principal());
  await journal.saveEntry(
    db,
    entryInput(historicalEntry, historicalPlot, '2026-07-13T05:00:00', { season_crop: 'barley' }),
    principal(),
    { mode: 'create' }
  );
  db.prepare(
    'INSERT INTO journal_layouts(code,version,labels_json,definition_json,active) ' +
      'SELECT code,2,labels_json,definition_json,1 FROM journal_layouts WHERE code=? AND version=1'
  ).run('open_field');
  db.prepare('UPDATE journal_layouts SET active=0 WHERE code=? AND version=1').run('open_field');

  const latestPlot = '86000000-0000-4000-8000-000000000003';
  const codeOnly = plotInput(latestPlot, 'layout-latest');
  delete codeOnly.layout_version;
  const created = await journal.upsertPlot(db, codeOnly, principal());
  assert.equal(created.plot.settings.layout_code, 'open_field');
  assert.equal('layout_version' in created.plot.settings, false);
  const latestEntry = '86000000-0000-4000-8000-000000000004';
  await journal.saveEntry(
    db,
    entryInput(latestEntry, latestPlot, '2026-07-13T08:00:00', {
      layout_version: 2,
      season_crop: 'barley',
    }),
    principal(),
    { mode: 'create' }
  );
  assert.equal(db.prepare('SELECT layout_version FROM journal_entries WHERE entry_uuid=?')
    .get(latestEntry).layout_version, 2);
  assert.equal(db.prepare('SELECT layout_version FROM journal_entries WHERE entry_uuid=?')
    .get(historicalEntry).layout_version, 1);

  await assert.rejects(
    journal.upsertPlot(db, plotInput(
      '86000000-0000-4000-8000-000000000005',
      'layout-explicit-inactive',
      { layout_version: 1 }
    ), principal()),
    (error) => error && error.code === 'invalid_layout'
  );
});

function parseCsvRecords(text) {
  const records = [];
  let record = [];
  let index = 0;
  while (index < text.length) {
    let quoted = false;
    let value = '';
    if (text[index] === '"') {
      quoted = true;
      index += 1;
      while (index < text.length) {
        if (text[index] === '"' && text[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (text[index] === '"') {
          index += 1;
          break;
        } else {
          value += text[index];
          index += 1;
        }
      }
    } else {
      while (index < text.length && text[index] !== ',' && text[index] !== '\r' && text[index] !== '\n') {
        value += text[index];
        index += 1;
      }
    }
    record.push({ value, quoted });
    if (text[index] === ',') {
      index += 1;
      continue;
    }
    if (text[index] === '\r' && text[index + 1] === '\n') index += 2;
    else if (text[index] === '\n') index += 1;
    records.push(record);
    record = [];
  }
  return records;
}

test('research package CSV is formula-safe and records.ndjson preserves typed source rows', async () => {
  const dangerous = [
    '=1',
    '+1',
    '-1',
    '@cmd',
    '\tcmd',
    '\rcmd',
    '  =1',
    '\u00a0=1',
    ' \u00a0\tcmd',
    '\u00a0 \rcmd',
    "'literal",
  ];
  const { db, entryUuids } = await createPagedEntries('typed-csv', null, dangerous.length);
  for (let index = 0; index < dangerous.length; index += 1) {
    db.prepare('UPDATE journal_entries SET note=? WHERE entry_uuid=?').run(dangerous[index], entryUuids[index]);
  }
  db.prepare(
    'UPDATE journal_entry_values SET value_num=?,entered_value_num=? WHERE entry_uuid=?'
  ).run(-5, -5, entryUuids[0]);

  const wideRows = parseCsvRecords(await journal.exportWideCsv(db, { status: 'final' }, principal()));
  const wideHeader = wideRows[0].map((cell) => cell.value);
  const noteIndex = wideHeader.indexOf('note');
  const valueIndex = wideHeader.indexOf('value.0.attr.irrigation_depth.value');
  const byEntry = new Map(wideRows.slice(1).map((row) => [
    row[wideHeader.indexOf('entry_uuid')].value,
    row,
  ]));
  const expectedSafe = [
    "'=1",
    "'+1",
    "'-1",
    "'@cmd",
    "'\tcmd",
    "'\rcmd",
    "'  =1",
    "'\u00a0=1",
    "' \u00a0\tcmd",
    "'\u00a0 \rcmd",
    "'literal",
  ];
  for (let index = 0; index < entryUuids.length; index += 1) {
    assert.equal(byEntry.get(entryUuids[index])[noteIndex].value, expectedSafe[index]);
  }
  assert.deepEqual(byEntry.get(entryUuids[0])[valueIndex], { value: '-5', quoted: false });

  const members = parseStoredZip(await journal.exportResearchPackage(
    db,
    { status: 'final' },
    principal()
  ));
  const entriesRows = parseCsvRecords(members.find((member) => member.name === 'entries.csv').data.toString('utf8'));
  const entriesHeader = entriesRows[0].map((cell) => cell.value);
  const packageByEntry = new Map(entriesRows.slice(1).map((row) => [
    row[entriesHeader.indexOf('entry_uuid')].value,
    row,
  ]));
  for (let index = 0; index < entryUuids.length; index += 1) {
    assert.equal(
      packageByEntry.get(entryUuids[index])[entriesHeader.indexOf('note')].value,
      expectedSafe[index]
    );
  }
  const valuesRows = parseCsvRecords(members.find((member) => member.name === 'values.csv').data.toString('utf8'));
  const valuesHeader = valuesRows[0].map((cell) => cell.value);
  const negative = valuesRows.find((row) => row[valuesHeader.indexOf('entry_uuid')].value === entryUuids[0]);
  assert.deepEqual(negative[valuesHeader.indexOf('entered_value_num')], { value: '-5', quoted: false });
  assert.deepEqual(negative[valuesHeader.indexOf('value_num')], { value: '-5', quoted: false });

  const listed = await journal.listEntries(
    db,
    { status: 'final', limit: dangerous.length },
    principal()
  );
  const expectedEntries = listed.entries.map((entry) => {
    const row = Object.assign({}, entry);
    delete row.values;
    delete row.owner_user_uuid;
    delete row.author_principal_uuid;
    delete row.author_label;
    delete row.voided_by_principal_uuid;
    return { record_type: 'entry', data: row };
  });
  const expectedValues = listed.entries.flatMap((entry) => entry.values.map((value) => ({
    record_type: 'value',
    data: {
      entry_uuid: entry.entry_uuid,
      attribute_code: value.attribute_code,
      group_index: value.group_index,
      value_status: value.value_status,
      entered_value_num: value.entered_value_num,
      entered_unit_code: value.entered_unit_code,
      value_num: value.value_num,
      value_text: value.value_text,
      unit_code: value.unit_code,
    },
  })));
  const expectedMappings = db.prepare(
    'SELECT term_code,scheme_uri,scheme_version,mapping_role,external_id,' +
      'external_parent_id,mapping_relation,source_uri,active FROM journal_vocab_mappings ' +
      'ORDER BY term_code,scheme_uri,mapping_role,external_id'
  ).all().map((mapping) => ({
    record_type: 'vocab_mapping',
    data: Object.assign({}, mapping),
  }));
  const ndjsonMember = members.find((member) => member.name === 'records.ndjson');
  assert.ok(ndjsonMember.data.toString('utf8').endsWith('\n'));
  const records = ndjsonMember.data.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(records, expectedEntries.concat(expectedValues, expectedMappings));
  assert.deepEqual(
    records.filter((record) => record.record_type === 'entry').map((record) => record.data.note),
    dangerous
  );
  assert.equal(
    records.find((record) =>
      record.record_type === 'value' && record.data.entry_uuid === entryUuids[0]
    ).data.value_num,
    -5
  );
});

test('research package bounds every ZIP payload write without changing an oversized UTF-8 row', async () => {
  const { db, entryUuids } = await createPagedEntries('bounded-package-writes', null, 1);
  const sourceContext = JSON.stringify({
    schema_version: 1,
    source: '\u00e9'.repeat(32_600),
  });
  assert.ok(Buffer.byteLength(sourceContext, 'utf8') > 64 * 1024 - 512);
  assert.ok(Buffer.byteLength(sourceContext, 'utf8') < 64 * 1024);
  db.prepare('UPDATE journal_entries SET note=?,context_json=? WHERE entry_uuid=?').run(
    '=1',
    sourceContext,
    entryUuids[0]
  );

  const sink = new BackpressureSink('drain');
  const result = await journal.exportResearchPackage(
    db,
    { status: 'final' },
    principal(),
    sink
  );
  assert.equal(result, null);
  assert.ok(sink.writableEnded);
  assert.ok(sink.chunks.length > 0);
  assert.ok(
    sink.chunks.every((chunk) => chunk.length <= 64 * 1024),
    'every ZIP header, descriptor, and member payload write must be at most 64 KiB'
  );

  const members = parseStoredZip(Buffer.concat(sink.chunks));
  assert.deepEqual(members.map((member) => member.name), RESEARCH_PACKAGE_MEMBERS);
  const entryRecords = parseCsvRecords(
    members.find((member) => member.name === 'entries.csv').data.toString('utf8')
  );
  const entryHeader = entryRecords[0].map((cell) => cell.value);
  assert.equal(entryRecords[1][entryHeader.indexOf('note')].value, "'=1");
  assert.equal(entryRecords[1][entryHeader.indexOf('context_json')].value, sourceContext);

  const ndjson = members.find((member) => member.name === 'records.ndjson').data.toString('utf8');
  const entryRecord = ndjson.trimEnd().split('\n').map(JSON.parse)
    .find((record) => record.record_type === 'entry');
  assert.equal(entryRecord.data.note, '=1');
  assert.equal(entryRecord.data.context_json, sourceContext);
});

test('custom vocabulary applies shared unit-family rules and freezes normalized conversions after use', async () => {
  const db = new TestDb('custom-vocab-unit-rules');
  seedIdentity(db);
  const unitUuid = '87000000-0000-4000-8000-000000000001';
  const unitCode = 'custom.' + unitUuid;
  const unitBody = {
    custom_field_uuid: unitUuid,
    base_sync_version: 0,
    kind: 'unit',
    parent_code: null,
    value_type: null,
    quantity_kind: 'water_depth',
    basis: 'water',
    default_unit_code: null,
    labels: { en: 'Centimetre water' },
    icon_key: null,
    constraints: {
      dimension: 'water_depth',
      to_canonical: { unit_code: 'unit.mm_water', scale: 10, offset: 0 },
    },
    active: 1,
    sort_order: 0,
    mappings: [],
  };
  await journal.upsertCustomVocab(db, unitBody, principal());

  const invalidBodies = [
    Object.assign({}, unitBody, {
      custom_field_uuid: '87000000-0000-4000-8000-000000000002',
      kind: 'activity',
      quantity_kind: 'water_depth',
      basis: 'water',
      constraints: {},
    }),
    Object.assign({}, unitBody, {
      custom_field_uuid: '87000000-0000-4000-8000-000000000003',
      constraints: {},
    }),
    Object.assign({}, unitBody, {
      custom_field_uuid: '87000000-0000-4000-8000-000000000004',
      kind: 'attribute',
      value_type: 'text',
      quantity_kind: 'water_depth',
      basis: 'water',
      constraints: { min: 0 },
    }),
    Object.assign({}, unitBody, {
      custom_field_uuid: '87000000-0000-4000-8000-000000000008',
      constraints: Object.assign({}, unitBody.constraints, { min: 0 }),
    }),
    Object.assign({}, unitBody, {
      custom_field_uuid: '87000000-0000-4000-8000-000000000009',
      kind: 'attribute',
      value_type: 'number',
      default_unit_code: 'unit.mm_water',
      constraints: {
        min: 0,
        dimension: 'water_depth',
        to_canonical: { unit_code: 'unit.mm_water', scale: 1, offset: 0 },
      },
    }),
  ];
  for (const invalid of invalidBodies) {
    await assert.rejects(
      journal.upsertCustomVocab(db, invalid, principal()),
      (error) => error && [
        'invalid_constraints', 'invalid_irrelevant_field', 'invalid_unit_contract',
      ].includes(error.code)
    );
  }
  await assert.rejects(
    journal.upsertCustomVocab(db, Object.assign({}, unitBody, {
      custom_field_uuid: '87000000-0000-4000-8000-000000000005',
      constraints: {
        dimension: 'water_depth',
        to_canonical: {
          unit_code: 'custom.87000000-0000-4000-8000-000000000099',
          scale: 10,
          offset: 0,
        },
      },
    }), principal()),
    (error) => error && error.code === 'missing_custom_dependency'
  );

  const plotUuid = '87000000-0000-4000-8000-000000000006';
  const entryUuid = '87000000-0000-4000-8000-000000000007';
  await journal.upsertPlot(db, plotInput(plotUuid, 'unit-freeze'), principal());
  await journal.saveEntry(db, entryInput(entryUuid, plotUuid, '2026-07-13T09:00:00', {
    season_crop: 'barley',
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value: 2,
      unit_code: unitCode,
      value_status: 'observed',
    }],
  }), principal(), { mode: 'create' });
  db.prepare("UPDATE journal_entries SET status='voided',deleted_at=? WHERE entry_uuid=?")
    .run('2026-07-13T10:00:00.000Z', entryUuid);
  await assert.rejects(
    journal.upsertCustomVocab(db, Object.assign({}, unitBody, {
      base_sync_version: 1,
      constraints: {
        dimension: 'water_depth',
        to_canonical: { unit_code: 'unit.mm_water', scale: 20, offset: 0 },
      },
    }), principal(), unitUuid),
    (error) => error && error.code === 'semantic_fields_frozen' &&
      error.details.field === 'conversion'
  );
});

test('multi-query read APIs assemble one old or new generation through readSnapshot', async () => {
  async function generation(name, note, secondMember) {
    const db = new TestDb(name);
    seedIdentity(db);
    const firstPlot = '88000000-0000-4000-8000-000000000001';
    const secondPlot = '88000000-0000-4000-8000-000000000002';
    const entryUuid = '88000000-0000-4000-8000-000000000003';
    const groupUuid = '88000000-0000-4000-8000-000000000004';
    await journal.upsertPlot(db, plotInput(firstPlot, 'snapshot-one'), principal());
    await journal.upsertPlot(db, plotInput(secondPlot, 'snapshot-two'), principal());
    await journal.saveEntry(db, entryInput(entryUuid, firstPlot, '2026-07-13T11:00:00', {
      note,
      season_crop: 'barley',
    }), principal(), { mode: 'create' });
    await journal.upsertPlotGroup(db, {
      group_uuid: groupUuid,
      base_sync_version: 0,
      label: note,
      resolved: false,
      members: secondMember ? [firstPlot, secondPlot] : [firstPlot],
    }, principal());
    if (secondMember) {
      db.prepare('UPDATE journal_entries SET sync_version=2,note=? WHERE entry_uuid=?').run(note, entryUuid);
      db.prepare(
        'INSERT INTO journal_entry_values(entry_uuid,attribute_code,group_index,value_status,value_text) ' +
          'VALUES (?,?,?,?,?)'
      ).run(entryUuid, 'attr.observation_text', 1, 'observed', 'new-child');
    }
    return { db, entryUuid, groupUuid };
  }
  const old = await generation('snapshot-old-generation', 'old-parent', false);
  const fresh = await generation('snapshot-new-generation', 'new-parent', true);
  const facade = {
    selected: old.db,
    snapshots: 0,
    async readSnapshot(executor) {
      this.snapshots += 1;
      const pinned = this.selected;
      return executor({
        prepare: pinned.prepare.bind(pinned),
        get: pinned.get.bind(pinned),
        all: pinned.all.bind(pinned),
      });
    },
    get() { throw new Error('multi-query read escaped snapshot'); },
    all() { throw new Error('multi-query read escaped snapshot'); },
  };
  async function readGeneration(expectedNote, expectedValues, expectedMembers) {
    const listed = await journal.listEntries(facade, { status: 'final' }, principal());
    assert.equal(listed.entries[0].note, expectedNote);
    assert.equal(listed.entries[0].values.length, expectedValues);
    const aggregate = await journal.loadCurrentAggregate(
      facade,
      'UPSERT_JOURNAL_ENTRY',
      old.entryUuid,
      principal()
    );
    assert.equal(aggregate.note, expectedNote);
    assert.equal(aggregate.values.length, expectedValues);
    const groups = await journal.listPlotGroups(facade, principal());
    assert.equal(groups.plot_groups[0].label, expectedNote);
    assert.equal(groups.plot_groups[0].members.length, expectedMembers);
  }
  await readGeneration('old-parent', 1, 1);
  facade.selected = fresh.db;
  await readGeneration('new-parent', 2, 2);
  assert.equal(facade.snapshots, 6);
});

test('HTTP close callback errors are bounded and visible', async () => {
  const db = new TestDb('router-close-error');
  seedIdentity(db);
  db.closeError = new Error('injected async close failure');
  const secret = 'router-close-error-secret';
  const authorization = 'Bearer ' + token(secret, {
    userId: 1,
    username: 'field-user',
    exp: Date.now() + 60_000,
  });
  const warnings = [];
  const response = await journal.handleHttpRequest({
    msg: {
      req: {
        method: 'GET',
        path: '/api/journal/export.adapt.json',
        headers: { authorization },
        query: {},
        params: {},
      },
    },
    Database: class { constructor() { return db; } },
    environment: {
      authTokenSecret: secret,
      deviceEui: GATEWAY_EUI,
      deviceEuiConfidence: 'authoritative',
    },
    warn(value) { warnings.push(String(value)); },
  });
  assert.equal(response.statusCode, 501);
  assert.deepEqual(warnings, ['[journal-api] database close failed code=unknown']);
  assert.ok(warnings[0].length < 120);
});

test('export.csv streams through a Node-RED msg.res wrapper (msg.res._res)', async () => {
  const { db } = await createPagedEntries('export-stream-wrapper', null, 1);
  const secret = 'export-stream-wrapper-secret';
  const authorization = 'Bearer ' + token(secret, {
    userId: 1,
    username: 'field-user',
    exp: Date.now() + 60_000,
  });
  class ExistingDb {
    constructor() {
      return db;
    }
  }
  const sink = new BackpressureSink('drain');
  // Shaped like Node-RED 3.1.15's http-in createResponseWrapper(): only `_res`
  // plus wrapped Express methods are present. There is no `write`.
  const wrapper = {
    _res: sink,
    status() { return wrapper; },
    set() { return wrapper; },
    send() { return wrapper; },
    type() { return wrapper; },
  };
  const response = await journal.handleHttpRequest({
    msg: {
      req: {
        method: 'GET',
        path: '/api/journal/export.csv',
        headers: { authorization },
        query: { status: 'final' },
        params: {},
      },
      res: wrapper,
    },
    Database: ExistingDb,
    environment: {
      authTokenSecret: secret,
      deviceEui: GATEWAY_EUI,
      deviceEuiConfidence: 'authoritative',
    },
  });
  assert.equal(response, null, 'streaming responses do not fall back to msg.payload');
  assert.equal(sink.statusCode, 200);
  assert.equal(sink.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.ok(sink.writes > 0, 'CSV bytes were streamed to the unwrapped sink, not lost in the wrapper');
  assert.ok(sink.writableEnded);
  const csvText = Buffer.concat(sink.chunks).toString('utf8');
  assert.match(csvText, /"entry_uuid"/);
});

test('catalog delivers parsed definitions under include=definitions and stays light by default', async () => {
  const db = new TestDb('catalog-definitions');
  const light = await journal.loadScopedCatalog(db, principal());
  assert.ok(light.vocab.length > 0);
  assert.ok(light.templates.length > 0);
  for (const row of light.vocab) {
    assert.ok(!Object.hasOwn(row, 'labels'));
    assert.ok(!Object.hasOwn(row, 'labels_json'));
  }
  for (const row of light.templates) {
    assert.ok(!Object.hasOwn(row, 'labels'));
    assert.ok(!Object.hasOwn(row, 'labels_json'));
    assert.ok(!Object.hasOwn(row, 'definition'));
    assert.ok(!Object.hasOwn(row, 'definition_json'));
  }

  const full = await journal.loadScopedCatalog(db, principal(), { includeDefinitions: true });
  const template = full.templates[0];
  const layout = full.layouts[0];
  const vocab = full.vocab[0];
  assert.ok(template.definition && typeof template.definition === 'object');
  assert.ok(Object.keys(template.definition).length > 0, 'template definition must not be empty');
  assert.ok(template.labels && typeof template.labels === 'object');
  assert.ok(typeof template.labels.en === 'string' && template.labels.en.trim().length > 0,
    'template must expose a non-empty English label');
  assert.ok(layout.definition && typeof layout.definition === 'object');
  assert.ok(vocab.labels && typeof vocab.labels === 'object');
  assert.ok(Object.hasOwn(vocab, 'constraints'));
  if (full.products.length > 0) {
    assert.ok(full.products[0].composition && typeof full.products[0].composition === 'object');
  }

  function assertNoRawJsonKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!key.endsWith('_json'), 'raw JSON key leaked: ' + key);
      assertNoRawJsonKeys(nested);
    }
  }
  assertNoRawJsonKeys(light);
  assertNoRawJsonKeys(full);
});
