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

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-api-'));
const nativeDatabases = [];
const OWNER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_OWNER_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ZONE_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN_ZONE_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GATEWAY_EUI = '0016C001F1000001';

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
    nativeDatabases.push(this.native);
  }

  prepare(sql) {
    return this.native.prepare(sql);
  }

  get(sql, params) {
    return Promise.resolve(this.native.prepare(sql).get(...(params || [])));
  }

  all(sql, params) {
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
      return await executor(this);
    } finally {
      this.snapshotClosed += 1;
    }
  }

  close(callback) {
    this.closeCalls += 1;
    if (callback) queueMicrotask(callback);
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
      error.details.entry_uuid === firstUuid && error.statusCode === 409
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
    await journal.upsertPlot(db, plotInput(plotUuid, 'page-' + index), principal());
    await journal.saveEntry(
      db,
      entryInput(entryUuids[index], plotUuid, '2026-07-13T09:00:00', {
        season_crop: 'barley',
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
}

test('research exports are loss-aware, formula-safe, incremental, and ZIP-manifest complete', async () => {
  const { db } = await createPagedEntries('exports', '=SUM(1,2)', 101);
  const csv = await journal.exportWideCsv(db, { status: 'final' }, principal());
  assert.match(csv, /\r\n/);
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.ok(!/(^|[^\r])\n/.test(csv.replace(/\r\n/g, '')), 'CSV has RFC4180 CRLF only');

  const jsonText = await journal.exportJson(db, { status: 'final' }, principal());
  const json = JSON.parse(jsonText);
  assert.equal(json.record_counts.entries, 101);
  assert.equal(json.provenance.author_identity_included, false);
  assert.equal(json.provenance.owner_identity_included, false);
  assert.ok(json.entries.every((entry) => !('author_label' in entry) &&
    !('author_principal_uuid' in entry) && !('owner_user_uuid' in entry)));

  const zip = await journal.exportResearchPackage(db, { status: 'final' }, principal());
  const members = parseStoredZip(zip);
  assert.deepEqual(members.map((member) => member.name), [
    'entries.csv', 'values.csv', 'vocab_mappings.csv', 'manifest.json',
  ]);
  const manifest = JSON.parse(members[3].data.toString('utf8'));
  assert.equal(manifest.members.length, 3);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(manifest.members[index].name, members[index].name);
    assert.equal(manifest.members[index].size_bytes, members[index].data.length);
    assert.equal(manifest.members[index].sha256, crypto.createHash('sha256').update(members[index].data).digest('hex'));
  }
  assert.doesNotMatch(members[0].data.toString('utf8').split('\r\n')[0], /author|owner_user_uuid/);

  const sink = new BackpressureSink('drain');
  const result = await journal.exportJson(db, { status: 'final' }, principal(), sink);
  assert.equal(result, null);
  assert.ok(sink.writes >= 4, 'export writes incrementally');
  assert.equal(sink.maxDrainListeners, 1);
  assert.equal(sink.listenerCount('drain'), 0);
  assert.equal(sink.listenerCount('close'), 0);
  assert.equal(sink.listenerCount('error'), 0);
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
  assert.equal(db.closeCalls, 4);
});
