#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const journal = require(
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal'
);

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-command-'));
const OWNER_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECOND_OWNER_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND_ACTOR_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LOGICAL_COMMAND_UUID = '11111111-1111-4111-8111-111111111111';
const ENTRY_UUID = '22222222-2222-4222-8222-222222222222';
const PLOT_UUID = '33333333-3333-4333-8333-333333333333';
const SECOND_PLOT_UUID = '66666666-6666-4666-8666-666666666666';
const VOCAB_UUID = '77777777-7777-4777-8777-777777777777';
const GROUP_UUID = '88888888-8888-4888-8888-888888888888';
const ZONE_UUID = '44444444-4444-4444-8444-444444444444';
const SEASON_UUID = '55555555-5555-4555-8555-555555555555';
const GATEWAY_EUI = '0016C001F11715E2';
const SECOND_GATEWAY_EUI = '0016C001F11715E3';
const MISSING_CUSTOM_CODE = 'custom.99999999-9999-4999-8999-999999999999';

class TestDb {
  constructor(name) {
    this.filename = path.join(TEMP_ROOT, name + '.db');
    this.native = new DatabaseSync(this.filename);
    this.native.exec(SEED);
    this.native.exec('PRAGMA journal_mode=WAL');
    this.snapshotParentHook = null;
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
    const native = new DatabaseSync(this.filename, { readOnly: true });
    native.exec('BEGIN');
    let parentHook = this.snapshotParentHook;
    const scope = {
      get: async (sql, params) => {
        const row = native.prepare(sql).get(...(params || []));
        if (parentHook && /FROM journal_(?:entries|vocab|plots|plot_groups)/.test(sql)) {
          const hook = parentHook;
          parentHook = null;
          this.snapshotParentHook = null;
          await hook();
        }
        return row;
      },
      all: async (sql, params) => native.prepare(sql).all(...(params || [])),
      run: async (sql, params) => native.prepare(sql).run(...(params || [])),
      exec: async (sql) => native.exec(sql),
    };
    try {
      const result = await executor(scope);
      native.exec('COMMIT');
      return result;
    } catch (error) {
      try { native.exec('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      native.close();
    }
  }

  close() {
    this.native.close();
  }
}

function fixtureDb(name) {
  const db = new TestDb(name);
  const now = '2026-07-12T00:00:00.000Z';
  db.native.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,user_uuid) VALUES (?,?,?,?,?)'
  ).run(1, 'journal-owner', 'unused', now, OWNER_UUID);
  db.native.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,timezone,zone_uuid,gateway_device_eui) ' +
      'VALUES (?,?,?,?,?,?)'
  ).run(1, 'North field', 1, 'Europe/Zurich', ZONE_UUID, GATEWAY_EUI);
  db.native.prepare(
    'INSERT INTO zone_seasons(zone_id,season_uuid,name,starts_on,ends_on,crop_type,variety) ' +
      'VALUES (?,?,?,?,?,?,?)'
  ).run(1, SEASON_UUID, 'Barley 2026', '2026-01-01', '2026-12-31', 'barley', 'Golden');
  db.native.prepare(
    'INSERT INTO journal_plots(' +
      'plot_uuid,plot_code,name,zone_uuid,gateway_device_eui,owner_user_uuid' +
      ') VALUES (?,?,?,?,?,?)'
  ).run(PLOT_UUID, 'north-field', 'North field', ZONE_UUID, GATEWAY_EUI, OWNER_UUID);
  db.native.prepare(
    'INSERT INTO journal_plot_settings(' +
      'plot_uuid,layout_code,updated_at,updated_by_principal_uuid' +
      ') VALUES (?,?,?,?)'
  ).run(PLOT_UUID, 'open_field', now, ACTOR_UUID);
  return db;
}

function entryAggregate(overrides) {
  return Object.assign({
    contract_version: 1,
    entry_uuid: ENTRY_UUID,
    base_sync_version: 0,
    owner_user_uuid: OWNER_UUID,
    author_principal_uuid: ACTOR_UUID,
    author_label: 'Cloud researcher',
    plot_uuid: PLOT_UUID,
    zone_uuid: ZONE_UUID,
    device_eui: null,
    season_uuid: SEASON_UUID,
    season_crop: 'barley',
    season_variety: 'Golden',
    campaign_uuid: null,
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    pass_uuid: null,
    batch_uuid: null,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    catalog_version: 1,
    occurred_start: '2026-07-12T07:30:00.000Z',
    occurred_end: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    recorded_at: '2000-01-01T00:00:00.000Z',
    origin: 'cloud-ui',
    status: 'final',
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: 'Morning irrigation',
    context_json: '{"untrusted":true}',
    sync_version: 99,
    gateway_device_eui: GATEWAY_EUI,
    created_at: '2000-01-01T00:00:00.000Z',
    updated_at: '2000-01-01T00:00:00.000Z',
    deleted_at: null,
    values: [{
      attribute_code: 'attr.irrigation_depth',
      group_index: 0,
      value_status: 'observed',
      value_num: 12,
      value_text: null,
      unit_code: 'unit.mm_water',
      entered_value_num: 12,
      entered_unit_code: 'unit.mm_water',
    }],
  }, overrides || {});
}

function commandEnvelope(overrides) {
  const payload = {
    command_id: LOGICAL_COMMAND_UUID,
    command_type: 'UPSERT_JOURNAL_ENTRY',
    owner_user_uuid: OWNER_UUID,
    author_principal_uuid: ACTOR_UUID,
    author_label: 'Cloud researcher',
    effect_key: 'journal_entry:' + ENTRY_UUID + ':0',
    entry: entryAggregate(),
  };
  return Object.assign({
    commandId: 101,
    commandType: 'UPSERT_JOURNAL_ENTRY',
    payload,
  }, overrides || {});
}

function trustedPayload(type, effectKey, body) {
  return Object.assign({
    command_id: LOGICAL_COMMAND_UUID,
    command_type: type,
    owner_user_uuid: OWNER_UUID,
    author_principal_uuid: ACTOR_UUID,
    author_label: 'Cloud researcher',
    effect_key: effectKey,
  }, body || {});
}

function pendingCommand(commandId, type, effectKey, body) {
  return {
    commandId,
    commandType: type,
    payload: trustedPayload(type, effectKey, body),
  };
}

function vocabAggregate() {
  return {
    contract_version: 1,
    base_sync_version: 0,
    code: 'custom.' + VOCAB_UUID,
    kind: 'activity',
    parent_code: null,
    value_type: null,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    labels_json: '{"en":"Canopy check"}',
    icon_key: null,
    constraints_json: null,
    agrovoc_uri: null,
    icasa_code: null,
    adapt_code: null,
    scope: 'custom',
    owner_user_uuid: OWNER_UUID,
    gateway_device_eui: GATEWAY_EUI,
    custom_field_uuid: VOCAB_UUID,
    active: 1,
    sort_order: 0,
    sync_version: 99,
    created_at: '2000-01-01T00:00:00.000Z',
    deleted_at: null,
    mappings: [],
  };
}

function plotAggregate() {
  return {
    contract_version: 1,
    plot_uuid: SECOND_PLOT_UUID,
    owner_user_uuid: OWNER_UUID,
    base_sync_version: 0,
    plot_code: 'south-field',
    name: 'South field',
    zone_uuid: null,
    station_code: null,
    crop_hint: 'barley',
    area_m2: 250,
    active: 1,
    sync_version: 99,
    gateway_device_eui: GATEWAY_EUI,
    created_at: '2000-01-01T00:00:00.000Z',
    updated_at: '2000-01-01T00:00:00.000Z',
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: '2000-01-01T00:00:00.000Z',
      updated_by_principal_uuid: ACTOR_UUID,
      sync_version: 99,
    },
  };
}

function groupAggregate() {
  return {
    contract_version: 1,
    group_uuid: GROUP_UUID,
    owner_user_uuid: OWNER_UUID,
    base_sync_version: 0,
    label: 'Research plots',
    gateway_device_eui: GATEWAY_EUI,
    created_by_principal_uuid: ACTOR_UUID,
    created_at: '2000-01-01T00:00:00.000Z',
    resolved_at: null,
    resolved_by_principal_uuid: null,
    sync_version: 99,
    deleted_at: null,
    members: [PLOT_UUID],
  };
}

function localPrincipal() {
  return {
    user_id: 1,
    owner_user_uuid: OWNER_UUID,
    author_principal_uuid: ACTOR_UUID,
    author_label: 'Edge farmer',
    gateway_device_eui: GATEWAY_EUI,
    origin: 'edge-ui',
  };
}

function localVocabInput(overrides) {
  const aggregate = Object.assign({}, vocabAggregate(), overrides || {});
  delete aggregate.owner_user_uuid;
  delete aggregate.gateway_device_eui;
  return aggregate;
}

function localPlotInput() {
  const aggregate = Object.assign({}, plotAggregate());
  aggregate.layout_code = aggregate.settings.layout_code;
  aggregate.layout_version = 1;
  delete aggregate.owner_user_uuid;
  delete aggregate.gateway_device_eui;
  delete aggregate.settings;
  return aggregate;
}

function localGroupInput() {
  const aggregate = Object.assign({}, groupAggregate(), { resolved: false });
  delete aggregate.owner_user_uuid;
  delete aggregate.gateway_device_eui;
  return aggregate;
}

function localEntryInput(overrides) {
  return Object.assign({
    entry_uuid: ENTRY_UUID,
    base_sync_version: 0,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    plot_uuid: PLOT_UUID,
    occurred_start_local: '2026-07-12T09:30:00.000',
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    values: entryAggregate().values,
    note: 'Edge canonical note',
  }, overrides || {});
}

test.after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

test('osi-journal exposes the pending-command application seam', () => {
  assert.equal(typeof journal.applyJournalCommand, 'function');
  assert.equal(typeof journal.deduplicatePendingCommand, 'function');
  assert.equal(typeof journal.queueCommandAck, 'function');
});

test('both pending-command producers keep payload command type outside the trusted envelope', () => {
  const flows = JSON.parse(fs.readFileSync(path.join(
    ROOT,
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
  ), 'utf8'));
  const replay = flows.find((node) => node.id === 'sync-pending-split');
  const force = flows.find((node) => node.id === 'sync-force-build');
  for (const producer of [replay, force]) {
    assert.ok(producer);
    assert.doesNotMatch(producer.func, /cmd\.command_type\s*\|\|\s*rawPayload\.command_type/);
  }
  const runReplay = new Function('msg', 'flow', 'node', replay.func);
  const output = runReplay({
    payload: {
      commands: [{
        commandId: 99,
        commandType: 'UPSERT_ZONE',
        payload: {
          commandType: 'UPSERT_JOURNAL_ENTRY',
          command_type: 'UPSERT_JOURNAL_ENTRY',
        },
      }],
    },
  }, {
    get() { return {}; },
    set() {},
  }, {
    warn() {},
  });
  const queued = output[0][0].payload;
  assert.equal(queued.commandType, 'UPSERT_ZONE');
  assert.equal(queued.command_type, 'UPSERT_ZONE');
  assert.equal(queued._pendingCommandEnvelope.commandType, 'UPSERT_ZONE');
  assert.equal(queued._pendingCommandEnvelope.payload.command_type, 'UPSERT_JOURNAL_ENTRY');
});

test('UPSERT_JOURNAL_ENTRY applies through lifecycle and atomically records numeric ACK facts', async () => {
  const db = fixtureDb('entry-applied');
  try {
    const result = await journal.applyJournalCommand(db, commandEnvelope(), {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(result.handled, true);
    assert.equal(result.ack.commandId, 101);
    assert.equal(typeof result.ack.commandId, 'number');
    assert.equal(result.ack.result, 'APPLIED');
    const entry = await db.get('SELECT * FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
    assert.equal(entry.sync_version, 1);
    assert.equal(entry.origin, 'cloud-ui');
    assert.notEqual(entry.recorded_at, '2000-01-01T00:00:00.000Z');
    assert.notEqual(entry.context_json, '{"untrusted":true}');
    const applied = await db.get('SELECT * FROM applied_commands WHERE command_id=?', ['101']);
    assert.equal(applied.command_type, 'UPSERT_JOURNAL_ENTRY');
    const facts = JSON.parse(applied.result_detail);
    assert.equal(facts.ownerUserUuid, OWNER_UUID);
    assert.equal(facts.gatewayDeviceEui, GATEWAY_EUI);
    const ackRow = await db.get('SELECT * FROM command_ack_outbox WHERE command_id=?', ['101']);
    const ack = JSON.parse(ackRow.payload_json);
    assert.equal(ack.commandId, 101);
    assert.equal(typeof ack.commandId, 'number');
    assert.equal(await db.get('SELECT COUNT(*) AS n FROM sync_outbox').then((row) => row.n), 1);
  } finally {
    db.close();
  }
});

test('journal entry success replaces pending retryable ACKs and preserves delivered history', async () => {
  const db = fixtureDb('entry-ack-replacement');
  try {
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      ['570', JSON.stringify({ commandId: 570, result: 'FAILED_RETRYABLE' }),
        '2026-07-12T09:00:00.000Z']
    );
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at,delivered_at) VALUES (?,?,?,?)',
      ['570', JSON.stringify({ commandId: 570, result: 'FAILED_RETRYABLE', historical: true }),
        '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:01.000Z']
    );
    const result = await journal.applyJournalCommand(
      db,
      commandEnvelope({ commandId: 570 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(result.ack.result, 'APPLIED');
    const pending = await db.all(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['570']
    );
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(pending[0].payload_json).result, 'APPLIED');
    const delivered = await db.get(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NOT NULL',
      ['570']
    );
    assert.equal(JSON.parse(delivered.payload_json).historical, true);
  } finally {
    db.close();
  }
});

test('terminal ACK replacement removes the target retryable beyond a 50-row delivery boundary', async () => {
  const db = fixtureDb('entry-ack-boundary');
  try {
    for (let index = 0; index < 50; index += 1) {
      const commandId = String(6000 + index);
      await db.run(
        'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
        [commandId, JSON.stringify({ commandId: Number(commandId), result: 'FAILED_RETRYABLE' }),
          '2026-07-12T08:00:' + String(index).padStart(2, '0') + '.000Z']
      );
    }
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      ['571', JSON.stringify({ commandId: 571, result: 'FAILED_RETRYABLE' }),
        '2026-07-12T09:00:00.000Z']
    );
    const firstBatch = await db.all(
      'SELECT command_id FROM command_ack_outbox WHERE delivered_at IS NULL ORDER BY id LIMIT 50'
    );
    assert.equal(firstBatch.length, 50);
    assert.equal(firstBatch.some((row) => row.command_id === '571'), false);

    const result = await journal.applyJournalCommand(
      db,
      commandEnvelope({ commandId: 571 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(result.ack.result, 'APPLIED');
    const targetRows = await db.all(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['571']
    );
    assert.equal(targetRows.length, 1);
    assert.equal(JSON.parse(targetRows[0].payload_json).result, 'APPLIED');
    assert.equal(
      (await db.all('SELECT payload_json FROM command_ack_outbox WHERE delivered_at IS NULL'))
        .filter((row) => {
          const payload = JSON.parse(row.payload_json);
          return payload.commandId === 571 && payload.result === 'FAILED_RETRYABLE';
        }).length,
      0
    );
  } finally {
    db.close();
  }
});

for (const fixture of [
  {
    name: 'UPSERT_JOURNAL_CUSTOM_VOCAB',
    deliveryId: 201,
    effectKey: 'journal_vocab:' + VOCAB_UUID + ':0',
    body: { custom_vocab: vocabAggregate() },
    table: 'journal_vocab',
    keyColumn: 'custom_field_uuid',
    key: VOCAB_UUID,
  },
  {
    name: 'UPSERT_JOURNAL_PLOT',
    deliveryId: 202,
    effectKey: 'journal_plot:' + SECOND_PLOT_UUID + ':0',
    body: { plot: plotAggregate() },
    table: 'journal_plots',
    keyColumn: 'plot_uuid',
    key: SECOND_PLOT_UUID,
  },
  {
    name: 'UPSERT_JOURNAL_PLOT_GROUP',
    deliveryId: 203,
    effectKey: 'journal_plot_group:' + GROUP_UUID + ':0',
    body: { plot_group: groupAggregate() },
    table: 'journal_plot_groups',
    keyColumn: 'group_uuid',
    key: GROUP_UUID,
  },
]) {
  test(fixture.name + ' applies through the shared resource API with numeric delivery ACK', async () => {
    const db = fixtureDb('resource-' + fixture.deliveryId);
    try {
      await db.run(
        'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
        [String(fixture.deliveryId), JSON.stringify({
          commandId: fixture.deliveryId,
          result: 'FAILED_RETRYABLE',
        }), '2026-07-12T09:00:00.000Z']
      );
      const result = await journal.applyJournalCommand(
        db,
        pendingCommand(fixture.deliveryId, fixture.name, fixture.effectKey, fixture.body),
        { gateway_device_eui: GATEWAY_EUI }
      );
      assert.equal(result.handled, true);
      assert.equal(result.ack.commandId, fixture.deliveryId);
      assert.equal(result.ack.result, 'APPLIED');
      const stored = await db.get(
        'SELECT sync_version FROM ' + fixture.table + ' WHERE ' + fixture.keyColumn + '=?',
        [fixture.key]
      );
      assert.equal(stored.sync_version, 1);
      const applied = await db.get('SELECT * FROM applied_commands WHERE command_id=?', [String(fixture.deliveryId)]);
      assert.equal(applied.command_type, fixture.name);
      const facts = JSON.parse(applied.result_detail);
      assert.equal(facts.ownerUserUuid, OWNER_UUID);
      assert.equal(facts.gatewayDeviceEui, GATEWAY_EUI);
      const pendingAcks = await db.all(
        'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
        [String(fixture.deliveryId)]
      );
      assert.equal(pendingAcks.length, 1);
      assert.equal(JSON.parse(pendingAcks[0].payload_json).commandId, fixture.deliveryId);
      assert.equal(JSON.parse(pendingAcks[0].payload_json).result, 'APPLIED');
    } finally {
      db.close();
    }
  });
}

test('VOID_JOURNAL_ENTRY applies through lifecycle and records its own terminal result', async () => {
  const db = fixtureDb('void-entry');
  try {
    await journal.applyJournalCommand(db, commandEnvelope({ commandId: 300 }), {
      gateway_device_eui: GATEWAY_EUI,
    });
    const result = await journal.applyJournalCommand(
      db,
      pendingCommand(301, 'VOID_JOURNAL_ENTRY', 'journal_entry:' + ENTRY_UUID + ':1', {
        entry_uuid: ENTRY_UUID,
        base_sync_version: 1,
        reason: 'Duplicate field note',
      }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(result.handled, true);
    assert.equal(result.ack.commandId, 301);
    assert.equal(result.ack.result, 'APPLIED');
    const entry = await db.get('SELECT status,sync_version FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
    assert.equal(entry.status, 'voided');
    assert.equal(entry.sync_version, 2);
    const applied = await db.get('SELECT command_type,result FROM applied_commands WHERE command_id=?', ['301']);
    assert.equal(applied.command_type, 'VOID_JOURNAL_ENTRY');
    assert.equal(applied.result, 'APPLIED');
  } finally {
    db.close();
  }
});

test('crash after terminal ledger insert rolls back atomically and does not poison the apply queue', async () => {
  const db = fixtureDb('entry-crash');
  try {
    await assert.rejects(
      journal.applyJournalCommand(db, commandEnvelope({ commandId: 401 }), {
        gateway_device_eui: GATEWAY_EUI,
        lifecycle_hooks: {
          afterCommandLedger() {
            throw new Error('injected crash after terminal ledger');
          },
        },
      }),
      /injected crash after terminal ledger/
    );
    for (const table of [
      'journal_entries',
      'journal_entry_values',
      'sync_outbox',
      'applied_commands',
      'command_ack_outbox',
    ]) {
      const count = await db.get('SELECT COUNT(*) AS n FROM ' + table);
      assert.equal(count.n, 0, table);
    }
    const recovered = await journal.applyJournalCommand(
      db,
      commandEnvelope({ commandId: 404 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(recovered.ack.result, 'APPLIED');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n, 1);
  } finally {
    db.close();
  }
});

test('stale entry command is not applied and durably reports current version and aggregate hash', async () => {
  const db = fixtureDb('entry-stale');
  try {
    const catalog = await journal.loadCatalog(db);
    await journal.finalize(db, catalog, localEntryInput(), localPrincipal());
    const event = await db.get(
      'SELECT payload_json FROM sync_outbox WHERE aggregate_type=? AND aggregate_key=?',
      ['JOURNAL_ENTRY', ENTRY_UUID]
    );
    const expectedCurrentHash = journal.aggregateHash(JSON.parse(event.payload_json));
    await db.run('DELETE FROM sync_outbox WHERE aggregate_type=? AND aggregate_key=?', [
      'JOURNAL_ENTRY',
      ENTRY_UUID,
    ]);
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      ['402', JSON.stringify({ commandId: 402, result: 'FAILED_RETRYABLE' }),
        '2026-07-12T09:00:00.000Z']
    );
    const result = await journal.applyJournalCommand(db, commandEnvelope({ commandId: 402 }), {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(result.handled, true);
    assert.equal(result.ack.commandId, 402);
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, 'stale_version');
    assert.equal(result.ack.currentSyncVersion, 1);
    assert.equal(result.ack.currentPayloadHash, expectedCurrentHash);
    const entry = await db.get('SELECT note,sync_version FROM journal_entries WHERE entry_uuid=?', [ENTRY_UUID]);
    assert.equal(entry.note, 'Edge canonical note');
    assert.equal(entry.sync_version, 1);
    const applied = await db.get('SELECT result,result_detail FROM applied_commands WHERE command_id=?', ['402']);
    assert.equal(applied.result, 'REJECTED_PERMANENT');
    const facts = JSON.parse(applied.result_detail);
    assert.equal(facts.currentPayloadHash, result.ack.currentPayloadHash);
    assert.equal(facts.ownerUserUuid, OWNER_UUID);
    assert.equal(facts.gatewayDeviceEui, GATEWAY_EUI);
    const pendingAcks = await db.all(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['402']
    );
    assert.equal(pendingAcks.length, 1);
    assert.equal(JSON.parse(pendingAcks[0].payload_json).result, 'REJECTED_PERMANENT');
  } finally {
    db.close();
  }
});

test('stale NACK version and hash come from one read snapshot during writer interleaving', async () => {
  const db = fixtureDb('entry-stale-snapshot');
  try {
    const catalog = await journal.loadCatalog(db);
    await journal.finalize(db, catalog, localEntryInput(), localPrincipal());
    const before = await journal.loadCurrentAggregate(
      db,
      'UPSERT_JOURNAL_ENTRY',
      ENTRY_UUID,
      localPrincipal()
    );
    const beforeHash = journal.aggregateHash(before);
    db.snapshotParentHook = async function() {
      db.native.exec('BEGIN IMMEDIATE');
      db.native.prepare(
        'UPDATE journal_entries SET note=?,sync_version=? WHERE entry_uuid=?'
      ).run('concurrent-new-parent', 2, ENTRY_UUID);
      db.native.prepare(
        'UPDATE journal_entry_values SET value_num=?,entered_value_num=? WHERE entry_uuid=?'
      ).run(99, 99, ENTRY_UUID);
      db.native.exec('COMMIT');
    };
    const result = await journal.applyJournalCommand(
      db,
      commandEnvelope({ commandId: 403 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.currentSyncVersion, 1);
    assert.equal(result.ack.currentPayloadHash, beforeHash);
    const after = await journal.loadCurrentAggregate(
      db,
      'UPSERT_JOURNAL_ENTRY',
      ENTRY_UUID,
      localPrincipal()
    );
    assert.equal(after.sync_version, 2);
    assert.equal(after.note, 'concurrent-new-parent');
    assert.notEqual(journal.aggregateHash(after), beforeHash);
  } finally {
    db.close();
  }
});

for (const fixture of [
  {
    name: 'custom vocabulary',
    commandType: 'UPSERT_JOURNAL_CUSTOM_VOCAB',
    staleId: 411,
    effectKey: 'journal_vocab:' + VOCAB_UUID + ':0',
    body: { custom_vocab: vocabAggregate() },
    aggregateType: 'JOURNAL_VOCAB',
    aggregateKey: VOCAB_UUID,
    create(db) {
      return journal.upsertCustomVocab(db, localVocabInput(), localPrincipal());
    },
  },
  {
    name: 'plot',
    commandType: 'UPSERT_JOURNAL_PLOT',
    staleId: 413,
    effectKey: 'journal_plot:' + SECOND_PLOT_UUID + ':0',
    body: { plot: plotAggregate() },
    aggregateType: 'JOURNAL_PLOT',
    aggregateKey: SECOND_PLOT_UUID,
    create(db) {
      return journal.upsertPlot(db, localPlotInput(), localPrincipal());
    },
  },
  {
    name: 'plot group',
    commandType: 'UPSERT_JOURNAL_PLOT_GROUP',
    staleId: 415,
    effectKey: 'journal_plot_group:' + GROUP_UUID + ':0',
    body: { plot_group: groupAggregate() },
    aggregateType: 'JOURNAL_PLOT_GROUP',
    aggregateKey: GROUP_UUID,
    create(db) {
      return journal.upsertPlotGroup(db, localGroupInput(), localPrincipal());
    },
  },
]) {
  test('stale ' + fixture.name + ' command reconstructs current hash after outbox pruning', async () => {
    const db = fixtureDb('stale-pruned-' + fixture.staleId);
    try {
      await fixture.create(db);
      const event = await db.get(
        'SELECT payload_json FROM sync_outbox WHERE aggregate_type=? AND aggregate_key=?',
        [fixture.aggregateType, fixture.aggregateKey]
      );
      const expectedCurrentHash = journal.aggregateHash(JSON.parse(event.payload_json));
      await db.run(
        'DELETE FROM sync_outbox WHERE aggregate_type=? AND aggregate_key=?',
        [fixture.aggregateType, fixture.aggregateKey]
      );
      const result = await journal.applyJournalCommand(
        db,
        pendingCommand(
          fixture.staleId,
          fixture.commandType,
          fixture.effectKey,
          fixture.body
        ),
        { gateway_device_eui: GATEWAY_EUI }
      );
      assert.equal(result.ack.result, 'REJECTED_PERMANENT');
      assert.equal(result.ack.reason, 'stale_version');
      assert.equal(result.ack.currentSyncVersion, 1);
      assert.equal(result.ack.currentPayloadHash, expectedCurrentHash);
    } finally {
      db.close();
    }
  });
}

test('missing custom-vocabulary parent is retryable and never creates a terminal ledger row', async () => {
  const db = fixtureDb('vocab-dependency');
  try {
    const missingParent = Object.assign({}, vocabAggregate(), {
      kind: 'choice',
      parent_code: 'custom.99999999-9999-4999-8999-999999999999',
      labels_json: '{"en":"Missing-parent choice"}',
    });
    const result = await journal.applyJournalCommand(
      db,
      pendingCommand(403, 'UPSERT_JOURNAL_CUSTOM_VOCAB', 'journal_vocab:' + VOCAB_UUID + ':0', {
        custom_vocab: missingParent,
      }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(result.handled, true);
    assert.equal(result.ack.result, 'FAILED_RETRYABLE');
    assert.equal(result.ack.reason, 'parent_not_found');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM journal_vocab WHERE custom_field_uuid=?', [VOCAB_UUID])).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['403'])).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['403'])).n, 1);
  } finally {
    db.close();
  }
});

test('missing custom-unit conversion target is retryable and never creates a terminal ledger row', async () => {
  const db = fixtureDb('unit-conversion-dependency');
  try {
    const missingTargetUnit = Object.assign({}, vocabAggregate(), {
      code: 'custom.' + VOCAB_UUID,
      kind: 'unit',
      value_type: null,
      quantity_kind: 'water_depth',
      basis: 'water',
      default_unit_code: null,
      constraints_json: JSON.stringify({
        dimension: 'water_depth',
        to_canonical: {
          unit_code: MISSING_CUSTOM_CODE,
          scale: 10,
          offset: 0,
        },
      }),
    });
    const result = await journal.applyJournalCommand(
      db,
      pendingCommand(404, 'UPSERT_JOURNAL_CUSTOM_VOCAB', 'journal_vocab:' + VOCAB_UUID + ':0', {
        custom_vocab: missingTargetUnit,
      }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(result.handled, true);
    assert.equal(result.ack.result, 'FAILED_RETRYABLE');
    assert.equal(result.ack.reason, 'missing_custom_dependency');
    assert.equal((await db.get(
      'SELECT COUNT(*) AS n FROM journal_vocab WHERE custom_field_uuid=?',
      [VOCAB_UUID]
    )).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['404'])).n, 0);
    assert.equal((await db.get(
      'SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['404']
    )).n, 1);
  } finally {
    db.close();
  }
});

for (const fixture of [
  {
    name: 'activity',
    mutate(entry) {
      entry.activity_code = MISSING_CUSTOM_CODE;
    },
  },
  {
    name: 'attribute',
    mutate(entry) {
      entry.values[0].attribute_code = MISSING_CUSTOM_CODE;
    },
  },
  {
    name: 'choice',
    mutate(entry) {
      entry.values = [{
        attribute_code: 'attr.crop',
        group_index: 0,
        value_status: 'observed',
        value_num: null,
        value_text: MISSING_CUSTOM_CODE,
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }];
    },
  },
  {
    name: 'canonical unit',
    mutate(entry) {
      entry.values[0].unit_code = MISSING_CUSTOM_CODE;
    },
  },
  {
    name: 'entered unit',
    mutate(entry) {
      entry.values[0].entered_unit_code = MISSING_CUSTOM_CODE;
    },
  },
]) {
  test('missing custom ' + fixture.name + ' dependency is structured and retryable', async () => {
    const db = fixtureDb('missing-custom-' + fixture.name.replace(/\s+/g, '-'));
    try {
      const envelope = commandEnvelope({ commandId: 600 + fixture.name.length });
      fixture.mutate(envelope.payload.entry);
      const result = await journal.applyJournalCommand(db, envelope, {
        gateway_device_eui: GATEWAY_EUI,
      });
      assert.equal(result.ack.result, 'FAILED_RETRYABLE');
      assert.equal(result.ack.reason, 'missing_custom_dependency');
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n, 0);
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands')).n, 0);
      assert.equal((await db.get(
        'SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
        [String(envelope.commandId)]
      )).n, 1);
    } finally {
      db.close();
    }
  });
}

test('malformed value shape remains permanent when it contains a missing custom unit', async () => {
  const db = fixtureDb('malformed-value-with-custom-unit');
  try {
    const envelope = commandEnvelope({ commandId: 608 });
    envelope.payload.entry.values = [{
      attribute_code: 'attr.crop',
      group_index: 0,
      value_status: 'observed',
      value_text: 'crop.barley',
      unit_code: MISSING_CUSTOM_CODE,
      entered_value_num: null,
      entered_unit_code: null,
    }];
    const result = await journal.applyJournalCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, 'validation_failed');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands')).n, 1);
  } finally {
    db.close();
  }
});

test('a malformed custom-looking code is a permanent validation error, not a dependency retry', async () => {
  const db = fixtureDb('malformed-custom-code');
  try {
    const envelope = commandEnvelope({ commandId: 609 });
    envelope.payload.entry.activity_code = 'custom.not-a-uuid';
    const result = await journal.applyJournalCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, 'validation_failed');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands')).n, 1);
  } finally {
    db.close();
  }
});

test('a retryable custom attribute command applies after its scoped dependency arrives', async () => {
  const db = fixtureDb('custom-dependency-arrival');
  try {
    const envelope = commandEnvelope({ commandId: 610 });
    envelope.payload.entry.values.push({
      attribute_code: MISSING_CUSTOM_CODE,
      group_index: 0,
      value_status: 'observed',
      value_num: null,
      value_text: 'Canopy still wet',
      unit_code: null,
      entered_value_num: null,
      entered_unit_code: null,
    });
    const missing = await journal.applyJournalCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(missing.ack.result, 'FAILED_RETRYABLE');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands')).n, 0);

    const dependencyUuid = MISSING_CUSTOM_CODE.slice('custom.'.length);
    await journal.upsertCustomVocab(
      db,
      localVocabInput({
        custom_field_uuid: dependencyUuid,
        code: MISSING_CUSTOM_CODE,
        kind: 'attribute',
        value_type: 'text',
        labels_json: '{"en":"Canopy condition"}',
      }),
      localPrincipal()
    );
    const applied = await journal.applyJournalCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(applied.ack.result, 'APPLIED');
    assert.equal((await db.get(
      'SELECT value_text FROM journal_entry_values WHERE entry_uuid=? AND attribute_code=?',
      [ENTRY_UUID, MISSING_CUSTOM_CODE]
    )).value_text, 'Canopy still wet');
    const pending = await db.all(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['610']
    );
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(pending[0].payload_json).result, 'APPLIED');
  } finally {
    db.close();
  }
});

test('an existing inactive custom activity remains a permanent validation failure', async () => {
  const db = fixtureDb('inactive-custom-activity');
  try {
    await journal.upsertCustomVocab(
      db,
      localVocabInput({ active: 0 }),
      localPrincipal()
    );
    const envelope = commandEnvelope({ commandId: 409 });
    envelope.payload.entry.activity_code = 'custom.' + VOCAB_UUID;
    const result = await journal.applyJournalCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, 'validation_failed');
    assert.equal(
      (await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['409'])).n,
      1
    );
  } finally {
    db.close();
  }
});

test('a deleted custom activity stays hidden and is a permanent validation failure', async () => {
  const db = fixtureDb('deleted-custom-activity');
  try {
    await journal.upsertCustomVocab(db, localVocabInput(), localPrincipal());
    await db.run(
      'UPDATE journal_vocab SET deleted_at=? WHERE code=?',
      ['2026-07-12T10:00:00.000Z', 'custom.' + VOCAB_UUID]
    );
    const scopedCatalog = await journal.loadScopedCatalog(db, localPrincipal());
    assert.equal(
      scopedCatalog.vocab.some((row) => row.code === 'custom.' + VOCAB_UUID),
      false
    );
    const envelope = commandEnvelope({ commandId: 611 });
    envelope.payload.entry.activity_code = 'custom.' + VOCAB_UUID;
    const result = await journal.applyJournalCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, 'validation_failed');
    assert.equal(
      (await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['611'])).n,
      1
    );
  } finally {
    db.close();
  }
});

test('exact command-ID replay preserves the stored rejection result and does not rewrite its ledger', async () => {
  const db = fixtureDb('dedupe-exact-rejection');
  const storedFacts = {
    effectKey: 'journal_entry:' + ENTRY_UUID + ':0',
    payloadHash: 'a'.repeat(64),
    currentSyncVersion: 7,
    currentPayloadHash: 'b'.repeat(64),
    reason: 'stale_version',
    diagnostic: 'stored-verbatim',
  };
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['501', GATEWAY_EUI, 'UPSERT_JOURNAL_ENTRY', storedFacts.effectKey,
        '2026-07-12T10:00:00.000Z', 'REJECTED_PERMANENT', JSON.stringify(storedFacts), 'edge']
    );
    const effectReplay = await journal.deduplicatePendingCommand(
      db,
      commandEnvelope({ commandId: 505 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(effectReplay.handled, false);
    const envelope = commandEnvelope({
      commandId: 501,
      payload: { malformed_retransmission: true },
    });
    const first = await journal.deduplicatePendingCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(first.handled, true);
    assert.equal(first.ack.commandId, 501);
    assert.equal(first.ack.result, 'REJECTED_PERMANENT');
    assert.equal(first.ack.status, 'NACKED');
    assert.equal(first.ack.duplicate, true);
    assert.equal(first.ack.diagnostic, 'stored-verbatim');
    assert.equal(first.ack.currentSyncVersion, 7);
    const ledger = await db.get('SELECT * FROM applied_commands WHERE command_id=?', ['501']);
    assert.equal(ledger.result, 'REJECTED_PERMANENT');
    assert.equal(ledger.result_detail, JSON.stringify(storedFacts));
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['501'])).n, 1);
    const second = await journal.deduplicatePendingCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(second.ack.result, 'REJECTED_PERMANENT');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['501'])).n, 1);
  } finally {
    db.close();
  }
});

test('exact replay replaces a leased stale ACK with a fresh pending row', async () => {
  const db = fixtureDb('dedupe-replay-leased-ack');
  const storedFacts = {
    effectKey: 'journal_entry:' + ENTRY_UUID + ':0',
    currentSyncVersion: 4,
    currentPayloadHash: 'e'.repeat(64),
    reason: 'stale_version',
  };
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['506', GATEWAY_EUI, 'UPSERT_JOURNAL_ENTRY', storedFacts.effectKey,
        '2026-07-12T10:00:00.000Z', 'REJECTED_PERMANENT', JSON.stringify(storedFacts), 'edge']
    );
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      ['506', JSON.stringify({ commandId: 506, result: 'FAILED_RETRYABLE' }),
        '2026-07-12T10:00:01.000Z']
    );
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at,delivered_at) VALUES (?,?,?,?)',
      ['506', JSON.stringify({ commandId: 506, result: 'FAILED_RETRYABLE', historical: true }),
        '2026-07-12T09:00:00.000Z', '2026-07-12T09:00:01.000Z']
    );
    const leased = await db.get(
      'SELECT id,payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['506']
    );
    assert.equal(JSON.parse(leased.payload_json).result, 'FAILED_RETRYABLE');

    const replay = await journal.deduplicatePendingCommand(
      db,
      commandEnvelope({ commandId: 506, payload: { malformed_retransmission: true } }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(replay.ack.result, 'REJECTED_PERMANENT');
    assert.equal(await db.get('SELECT id FROM command_ack_outbox WHERE id=?', [leased.id]), undefined);
    const fresh = await db.get(
      'SELECT id,payload_json,delivered_at FROM command_ack_outbox ' +
        'WHERE command_id=? AND delivered_at IS NULL',
      ['506']
    );
    assert.notEqual(fresh.id, leased.id);
    assert.deepEqual(JSON.parse(fresh.payload_json), replay.ack);

    await db.run(
      'UPDATE command_ack_outbox SET delivered_at=? WHERE id IN (?)',
      ['2026-07-12T10:00:02.000Z', leased.id]
    );
    const stillPending = await db.get(
      'SELECT id,payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['506']
    );
    assert.equal(stillPending.id, fresh.id);
    assert.deepEqual(JSON.parse(stillPending.payload_json), replay.ack);
    const delivered = await db.all(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NOT NULL',
      ['506']
    );
    assert.equal(delivered.length, 1);
    assert.equal(JSON.parse(delivered[0].payload_json).historical, true);
  } finally {
    db.close();
  }
});

test('exact command-ID replay preserves a non-journal terminal rejection', async () => {
  const db = fixtureDb('dedupe-exact-non-journal');
  const storedFacts = { reason: 'zone_conflict', currentSyncVersion: 4 };
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['503', GATEWAY_EUI, 'UPSERT_ZONE', 'zone:' + ZONE_UUID + ':3',
        '2026-07-12T10:00:00.000Z', 'REJECTED_PERMANENT', JSON.stringify(storedFacts), 'edge']
    );
    const replay = await journal.deduplicatePendingCommand(db, {
      commandId: 503,
      commandType: 'UPSERT_ZONE',
      payload: { changed_after_first_delivery: true },
    }, { gateway_device_eui: GATEWAY_EUI });
    assert.equal(replay.handled, true);
    assert.equal(replay.ack.commandId, 503);
    assert.equal(replay.ack.result, 'REJECTED_PERMANENT');
    assert.equal(replay.ack.reason, 'zone_conflict');
    assert.equal(replay.ack.duplicate, true);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands')).n, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['503'])).n, 1);
  } finally {
    db.close();
  }
});

test('exact replay corrects a wrong pending ACK from the stored terminal ledger result', async () => {
  const db = fixtureDb('dedupe-correct-pending-ack');
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['504', GATEWAY_EUI, 'UPSERT_ZONE', 'zone:' + ZONE_UUID + ':3',
        '2026-07-12T10:00:00.000Z', 'REJECTED_PERMANENT',
        JSON.stringify({ reason: 'zone_conflict' }), 'edge']
    );
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      ['504', JSON.stringify({ commandId: 504, result: 'APPLIED' }), '2026-07-12T10:00:01.000Z']
    );
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
      ['504', JSON.stringify({ commandId: 504, result: 'APPLIED' }), '2026-07-12T10:00:02.000Z']
    );
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at,delivered_at) VALUES (?,?,?,?)',
      ['504', JSON.stringify({ commandId: 504, result: 'APPLIED', historical: true }),
        '2026-07-12T09:00:00.000Z', '2026-07-12T09:00:01.000Z']
    );
    const replay = await journal.deduplicatePendingCommand(db, {
      commandId: 504,
      commandType: 'UPSERT_ZONE',
      payload: {},
    }, { gateway_device_eui: GATEWAY_EUI });
    assert.equal(replay.ack.result, 'REJECTED_PERMANENT');
    const pending = await db.all(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['504']
    );
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(pending[0].payload_json).result, 'REJECTED_PERMANENT');
    const delivered = await db.get(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NOT NULL',
      ['504']
    );
    assert.equal(JSON.parse(delivered.payload_json).historical, true);
    assert.equal(JSON.parse(delivered.payload_json).result, 'APPLIED');
    assert.equal((await db.get('SELECT result FROM applied_commands WHERE command_id=?', ['504'])).result,
      'REJECTED_PERMANENT');
  } finally {
    db.close();
  }
});

test('compatible effect replay uses the stored APPLIED result for the new numeric delivery ID', async () => {
  const db = fixtureDb('dedupe-compatible-effect');
  const submittedIntentHash = journal.aggregateHash({
    command_type: 'UPSERT_JOURNAL_ENTRY',
    owner_user_uuid: OWNER_UUID,
    author_principal_uuid: ACTOR_UUID,
    author_label: 'Cloud researcher',
    entry: commandEnvelope().payload.entry,
  });
  const storedFacts = {
    commandType: 'UPSERT_JOURNAL_ENTRY',
    aggregateKey: ENTRY_UUID,
    ownerUserUuid: OWNER_UUID,
    authorPrincipalUuid: ACTOR_UUID,
    authorLabel: 'Cloud researcher',
    appliedSyncVersion: 1,
    effectKey: 'journal_entry:' + ENTRY_UUID + ':0',
    payloadHash: 'c'.repeat(64),
    gatewayDeviceEui: GATEWAY_EUI,
    appliedAt: '2026-07-12T10:00:00.000Z',
    submittedIntentHash,
  };
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['500', GATEWAY_EUI, 'UPSERT_JOURNAL_ENTRY', storedFacts.effectKey,
        storedFacts.appliedAt, 'APPLIED', JSON.stringify(storedFacts), 'edge']
    );
    const replay = await journal.deduplicatePendingCommand(
      db,
      commandEnvelope({ commandId: 502 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(replay.handled, true);
    assert.equal(replay.ack.commandId, 502);
    assert.equal(replay.ack.result, 'APPLIED');
    assert.equal(replay.ack.status, 'ACKED');
    assert.equal(replay.ack.duplicate, true);
    assert.equal(replay.ack.payloadHash, storedFacts.payloadHash);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands')).n, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['502'])).n, 1);
  } finally {
    db.close();
  }
});

test('concurrent same-effect journal applies serialize and replay the winner', async () => {
  const db = fixtureDb('apply-same-effect-concurrency');
  const rawTransaction = db.transaction.bind(db);
  let transactionTail = Promise.resolve();
  db.transaction = function(executor) {
    const scheduled = transactionTail.then(
      function() { return rawTransaction(executor); },
      function() { return rawTransaction(executor); }
    );
    transactionTail = scheduled.then(function() {}, function() {});
    return scheduled;
  };
  const envelopes = [
    commandEnvelope({ commandId: 580 }),
    commandEnvelope({ commandId: 581 }),
  ];
  try {
    const outerMisses = await Promise.all(envelopes.map(function(envelope) {
      return journal.deduplicatePendingCommand(db, envelope, {
        gateway_device_eui: GATEWAY_EUI,
      });
    }));
    assert.deepEqual(outerMisses.map(function(result) { return result.handled; }), [false, false]);

    let release;
    const startTogether = new Promise(function(resolve) { release = resolve; });
    const pending = envelopes.map(async function(envelope) {
      await startTogether;
      return journal.applyJournalCommand(db, envelope, {
        gateway_device_eui: GATEWAY_EUI,
      });
    });
    release();
    const results = await Promise.all(pending);
    assert.deepEqual(
      results.map(function(result) { return result.ack.commandId; }).sort(),
      [580, 581]
    );
    assert.deepEqual(
      results.map(function(result) { return result.ack.result; }),
      ['APPLIED', 'APPLIED']
    );
    assert.equal(results.filter(function(result) { return result.ack.duplicate === true; }).length, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM sync_outbox')).n, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands')).n, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox')).n, 2);
  } finally {
    db.close();
  }
});

test('journal effect replay cannot cross owners on the same gateway', async () => {
  const db = fixtureDb('dedupe-cross-owner');
  const effectKey = 'journal_plot:' + SECOND_PLOT_UUID + ':0';
  try {
    await db.run(
      'INSERT INTO users(id,username,password_hash,created_at,user_uuid) VALUES (?,?,?,?,?)',
      [2, 'second-owner', 'unused', '2026-07-12T00:00:00.000Z', SECOND_OWNER_UUID]
    );
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['560', GATEWAY_EUI, 'UPSERT_JOURNAL_PLOT', effectKey,
        '2026-07-12T10:00:00.000Z', 'REJECTED_PERMANENT', JSON.stringify({
          ownerUserUuid: OWNER_UUID,
          gatewayDeviceEui: GATEWAY_EUI,
          reason: 'owner_a_rejection',
        }), 'edge']
    );
    const plot = Object.assign({}, plotAggregate(), {
      owner_user_uuid: SECOND_OWNER_UUID,
      settings: Object.assign({}, plotAggregate().settings, {
        updated_by_principal_uuid: SECOND_ACTOR_UUID,
      }),
    });
    const envelope = pendingCommand(561, 'UPSERT_JOURNAL_PLOT', effectKey, { plot });
    Object.assign(envelope.payload, {
      owner_user_uuid: SECOND_OWNER_UUID,
      author_principal_uuid: SECOND_ACTOR_UUID,
      author_label: 'Second cloud researcher',
    });
    const replay = await journal.deduplicatePendingCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(replay.handled, false);
    const applied = await journal.applyJournalCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(applied.ack.result, 'APPLIED');
    const stored = await db.get(
      'SELECT owner_user_uuid FROM journal_plots WHERE plot_uuid=?',
      [SECOND_PLOT_UUID]
    );
    assert.equal(stored.owner_user_uuid, SECOND_OWNER_UUID);
    const matchingReplay = await journal.deduplicatePendingCommand(
      db,
      Object.assign({}, envelope, { commandId: 564 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(matchingReplay.handled, true);
    assert.equal(matchingReplay.ack.commandId, 564);
    assert.equal(matchingReplay.ack.result, 'APPLIED');
  } finally {
    db.close();
  }
});

test('journal effect replay cannot cross gateways for the same owner', async () => {
  const db = fixtureDb('dedupe-cross-gateway');
  const effectKey = 'journal_plot:' + SECOND_PLOT_UUID + ':0';
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['562', GATEWAY_EUI, 'UPSERT_JOURNAL_PLOT', effectKey,
        '2026-07-12T10:00:00.000Z', 'REJECTED_PERMANENT', JSON.stringify({
          ownerUserUuid: OWNER_UUID,
          gatewayDeviceEui: GATEWAY_EUI,
          reason: 'first_gateway_rejection',
        }), 'edge']
    );
    const plot = Object.assign({}, plotAggregate(), {
      gateway_device_eui: SECOND_GATEWAY_EUI,
    });
    const envelope = pendingCommand(563, 'UPSERT_JOURNAL_PLOT', effectKey, { plot });
    const replay = await journal.deduplicatePendingCommand(db, envelope, {
      gateway_device_eui: SECOND_GATEWAY_EUI,
    });
    assert.equal(replay.handled, false);
  } finally {
    db.close();
  }
});

test('recognized non-journal config effect replays only for the same type and bound device', async () => {
  const db = fixtureDb('dedupe-non-journal-effect');
  const effectKey = 'config:' + GATEWAY_EUI + ':uplink_interval:3';
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['530', GATEWAY_EUI, 'SET_LSN50_INTERVAL', effectKey,
        '2026-07-12T10:00:00.000Z', 'APPLIED', JSON.stringify({ payloadHash: 'd'.repeat(64) }), 'edge']
    );
    const replay = await journal.deduplicatePendingCommand(db, {
      commandId: 531,
      commandType: 'SET_LSN50_INTERVAL',
      payload: { effect_key: effectKey, deviceEui: GATEWAY_EUI },
    }, {
      gateway_device_eui: GATEWAY_EUI,
      command_type_recognized: true,
    });
    assert.equal(replay.handled, true);
    assert.equal(replay.ack.commandId, 531);
    assert.equal(replay.ack.result, 'APPLIED');
    const wrongDevice = await journal.deduplicatePendingCommand(db, {
      commandId: 532,
      commandType: 'SET_LSN50_INTERVAL',
      payload: {
        effect_key: effectKey,
        deviceEui: 'FFFFFFFFFFFFFFFF',
      },
    }, {
      gateway_device_eui: GATEWAY_EUI,
      command_type_recognized: true,
    });
    assert.equal(wrongDevice.handled, false);
  } finally {
    db.close();
  }
});

test('invalid scheduler effect timestamp falls through dedupe without throwing', async () => {
  const db = fixtureDb('dedupe-invalid-scheduler-timestamp');
  try {
    const result = await journal.deduplicatePendingCommand(db, {
      commandId: 533,
      commandType: 'OPEN_FOR_DURATION',
      payload: {
        effect_key: 'irrigation:scheduler:1:2:2026-13-01T00:00:00.000Z',
        zone_id: 1,
      },
    }, {
      gateway_device_eui: GATEWAY_EUI,
      command_type_recognized: true,
    });
    assert.equal(result.handled, false);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox')).n, 0);
  } finally {
    db.close();
  }
});

test('effect replay is refused until journal type and resource binding are compatible', async () => {
  const db = fixtureDb('dedupe-effect-binding');
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['510', GATEWAY_EUI, 'UPSERT_JOURNAL_PLOT',
        'journal_entry:' + ENTRY_UUID + ':0', '2026-07-12T10:00:00.000Z',
        'APPLIED', '{}', 'edge']
    );
    const wrongType = await journal.deduplicatePendingCommand(
      db,
      commandEnvelope({ commandId: 511 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(wrongType.handled, false);
    const mismatchedPayload = commandEnvelope({ commandId: 512 });
    mismatchedPayload.payload.entry.entry_uuid = '99999999-9999-4999-8999-999999999999';
    const wrongBinding = await journal.deduplicatePendingCommand(
      db,
      mismatchedPayload,
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(wrongBinding.handled, false);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox')).n, 0);
  } finally {
    db.close();
  }
});

test('unsupported JOURNAL command is durably rejected instead of falling through dispatch', async () => {
  const db = fixtureDb('unsupported-journal');
  try {
    const result = await journal.applyJournalCommand(
      db,
      pendingCommand(520, 'UPSERT_JOURNAL_FUTURE', 'journal_future:' + ENTRY_UUID + ':0', {}),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(result.handled, true);
    assert.equal(result.ack.commandId, 520);
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, 'unsupported_command_type');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['520'])).n, 1);
  } finally {
    db.close();
  }
});

test('trusted envelope identity cannot be replaced by nested journal aggregate identity', async () => {
  const db = fixtureDb('identity-binding');
  try {
    const envelope = commandEnvelope({ commandId: 521 });
    envelope.payload.entry.owner_user_uuid = '99999999-9999-4999-8999-999999999999';
    const result = await journal.applyJournalCommand(db, envelope, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, 'invalid_identity');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM journal_entries')).n, 0);
  } finally {
    db.close();
  }
});

test('shared ACK queue rolls back a terminal ledger insert when the ACK insert phase crashes', async () => {
  const db = fixtureDb('ack-queue-crash');
  try {
    await assert.rejects(
      journal.queueCommandAck(db, {
        commandId: 540,
        commandType: 'UPSERT_ZONE',
        effectKey: 'zone:' + ZONE_UUID + ':0',
        deviceEui: GATEWAY_EUI,
        result: 'APPLIED',
      }, {
        lifecycle_hooks: {
          afterCommandLedger() {
            throw new Error('injected ACK queue crash');
          },
        },
      }),
      /injected ACK queue crash/
    );
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['540'])).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['540'])).n, 0);
  } finally {
    db.close();
  }
});

test('shared ACK queue never overwrites a stored rejection with a contradictory incoming success', async () => {
  const db = fixtureDb('ack-queue-conflict');
  try {
    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['541', GATEWAY_EUI, 'UPSERT_ZONE', 'zone:' + ZONE_UUID + ':0',
        '2026-07-12T10:00:00.000Z', 'REJECTED_PERMANENT',
        JSON.stringify({ reason: 'stored_zone_conflict', currentSyncVersion: 2 }), 'edge']
    );
    const queued = await journal.queueCommandAck(db, {
      commandId: 541,
      commandType: 'UPSERT_ZONE',
      effectKey: 'zone:' + ZONE_UUID + ':0',
      deviceEui: GATEWAY_EUI,
      result: 'APPLIED',
    });
    assert.equal(queued.result, 'REJECTED_PERMANENT');
    assert.equal(queued.reason, 'stored_zone_conflict');
    assert.equal((await db.get('SELECT result FROM applied_commands WHERE command_id=?', ['541'])).result,
      'REJECTED_PERMANENT');
    const ack = await db.get(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['541']
    );
    assert.equal(JSON.parse(ack.payload_json).result, 'REJECTED_PERMANENT');
  } finally {
    db.close();
  }
});

test('shared ACK queue treats an undefined transaction run result as a new non-duplicate terminal ACK', async () => {
  const db = fixtureDb('ack-queue-production-run-shape');
  const run = db.run.bind(db);
  db.run = async function(sql, params) {
    await run(sql, params);
    return undefined;
  };
  try {
    const queued = await journal.queueCommandAck(db, {
      commandId: 542,
      commandType: 'UPSERT_ZONE',
      effectKey: 'zone:' + ZONE_UUID + ':0',
      deviceEui: GATEWAY_EUI,
      result: 'APPLIED',
    });
    assert.equal(queued.result, 'APPLIED');
    assert.equal(queued.duplicate, false);
    assert.equal((await db.get('SELECT result FROM applied_commands WHERE command_id=?', ['542'])).result,
      'APPLIED');
    const ack = await db.get('SELECT payload_json FROM command_ack_outbox WHERE command_id=?', ['542']);
    assert.equal(JSON.parse(ack.payload_json).duplicate, false);
  } finally {
    db.close();
  }
});

test('shared ACK queue keeps one pending latest result and preserves delivered history', async () => {
  const db = fixtureDb('ack-queue-latest-only');
  try {
    await db.run(
      'INSERT INTO command_ack_outbox(command_id,payload_json,created_at,delivered_at) VALUES (?,?,?,?)',
      ['575', JSON.stringify({ commandId: 575, result: 'FAILED_RETRYABLE', historical: true }),
        '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:01.000Z']
    );
    await journal.queueCommandAck(db, {
      commandId: 575,
      commandType: 'UPSERT_ZONE',
      effectKey: 'zone:' + ZONE_UUID + ':0',
      deviceEui: GATEWAY_EUI,
      result: 'FAILED_RETRYABLE',
      reason: 'first_retry',
    });
    await journal.queueCommandAck(db, {
      commandId: 575,
      commandType: 'UPSERT_ZONE',
      effectKey: 'zone:' + ZONE_UUID + ':0',
      deviceEui: GATEWAY_EUI,
      result: 'FAILED_RETRYABLE',
      reason: 'latest_retry',
    });
    let pending = await db.all(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['575']
    );
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(pending[0].payload_json).reason, 'latest_retry');
    await journal.queueCommandAck(db, {
      commandId: 575,
      commandType: 'UPSERT_ZONE',
      effectKey: 'zone:' + ZONE_UUID + ':0',
      deviceEui: GATEWAY_EUI,
      result: 'APPLIED',
    });
    pending = await db.all(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
      ['575']
    );
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(pending[0].payload_json).result, 'APPLIED');
    const delivered = await db.get(
      'SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NOT NULL',
      ['575']
    );
    assert.equal(JSON.parse(delivered.payload_json).historical, true);
  } finally {
    db.close();
  }
});

test('lease expiry queues a retryable ACK without consuming the terminal command ledger', async () => {
  const db = fixtureDb('ack-queue-expired');
  try {
    const queued = await journal.queueCommandAck(db, {
      commandId: 543,
      commandType: 'UPSERT_ZONE',
      effectKey: 'zone:' + ZONE_UUID + ':0',
      deviceEui: GATEWAY_EUI,
      result: 'EXPIRED',
      reason: 'lease_expired',
    });
    assert.equal(queued.result, 'FAILED_RETRYABLE');
    assert.equal(queued.status, 'FAILED_RETRYABLE');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM applied_commands WHERE command_id=?', ['543'])).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE command_id=?', ['543'])).n, 1);
  } finally {
    db.close();
  }
});

test('exact delivery replay is byte-for-byte equivalent to the durable terminal ACK', async () => {
  const db = fixtureDb('exact-terminal-ack-replay');
  try {
    const applied = await journal.applyJournalCommand(
      db,
      commandEnvelope({ commandId: 700 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.match(applied.ack.submittedIntentHash, /^[0-9a-f]{64}$/);
    const ledger = await db.get(
      'SELECT result_detail FROM applied_commands WHERE command_id=?',
      ['700']
    );
    assert.deepEqual(JSON.parse(ledger.result_detail), applied.ack);
    const replay = await journal.deduplicatePendingCommand(db, {
      commandId: 700,
      commandType: 'UPSERT_JOURNAL_ENTRY',
      payload: { corrupt_redelivery_must_not_be_reparsed: true },
    }, { gateway_device_eui: GATEWAY_EUI });
    assert.deepEqual(replay.ack, applied.ack);
    assert.equal(replay.ack.duplicate, false);
  } finally {
    db.close();
  }
});

test('cross-delivery journal replay requires the same submitted intent and provenance', async () => {
  const db = fixtureDb('submitted-intent-replay-gate');
  try {
    const original = commandEnvelope({ commandId: 701 });
    const applied = await journal.applyJournalCommand(db, original, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.match(applied.ack.submittedIntentHash, /^[0-9a-f]{64}$/);

    const transportOnly = structuredClone(original);
    transportOnly.commandId = 702;
    transportOnly.payload.command_id = '12111111-1111-4111-8111-111111111111';
    transportOnly.payload.issued_at = '2026-07-12T10:00:00.000Z';
    transportOnly.payload.expires_at = '2026-07-12T11:00:00.000Z';
    const compatible = await journal.deduplicatePendingCommand(db, transportOnly, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(compatible.handled, true);
    assert.equal(compatible.ack.commandId, 702);
    assert.equal(compatible.ack.duplicate, true);
    assert.equal(compatible.ack.submittedIntentHash, applied.ack.submittedIntentHash);

    const changedNote = structuredClone(original);
    changedNote.commandId = 703;
    changedNote.payload.entry.note = 'A different logical mutation';
    assert.equal((await journal.deduplicatePendingCommand(db, changedNote, {
      gateway_device_eui: GATEWAY_EUI,
    })).handled, false);

    const changedAuthor = structuredClone(original);
    changedAuthor.commandId = 704;
    changedAuthor.payload.author_principal_uuid = SECOND_ACTOR_UUID;
    changedAuthor.payload.author_label = 'Different author';
    changedAuthor.payload.entry.author_principal_uuid = SECOND_ACTOR_UUID;
    changedAuthor.payload.entry.author_label = 'Different author';
    assert.equal((await journal.deduplicatePendingCommand(db, changedAuthor, {
      gateway_device_eui: GATEWAY_EUI,
    })).handled, false);

    const changedDuplicateAck = structuredClone(original);
    changedDuplicateAck.commandId = 705;
    changedDuplicateAck.payload.duplicate_guard_ack_entry_uuid =
      '99999999-9999-4999-8999-999999999999';
    assert.equal((await journal.deduplicatePendingCommand(db, changedDuplicateAck, {
      gateway_device_eui: GATEWAY_EUI,
    })).handled, false);

    await db.run(
      'INSERT INTO applied_commands (' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES (?,?,?,?,?,?,?,?)',
      ['706', GATEWAY_EUI, 'UPSERT_JOURNAL_ENTRY', original.payload.effect_key,
        '2026-07-12T12:00:00.000Z', 'APPLIED', JSON.stringify({
          ownerUserUuid: OWNER_UUID,
          authorPrincipalUuid: ACTOR_UUID,
          authorLabel: 'Cloud researcher',
          gatewayDeviceEui: GATEWAY_EUI,
        }), 'edge']
    );
    await db.run('DELETE FROM applied_commands WHERE command_id=?', ['701']);
    const legacy = structuredClone(original);
    legacy.commandId = 707;
    assert.equal((await journal.deduplicatePendingCommand(db, legacy, {
      gateway_device_eui: GATEWAY_EUI,
    })).handled, false, 'legacy terminal rows without submittedIntentHash never effect-match');
  } finally {
    db.close();
  }
});

test('rejected commands keep payloadHash null and expose only safe camelCase duplicate facts', async () => {
  const db = fixtureDb('rejection-fact-semantics');
  try {
    const catalog = await journal.loadCatalog(db);
    await journal.finalize(db, catalog, localEntryInput(), localPrincipal());
    const stale = await journal.applyJournalCommand(
      db,
      commandEnvelope({ commandId: 710 }),
      { gateway_device_eui: GATEWAY_EUI }
    );
    assert.equal(stale.ack.result, 'REJECTED_PERMANENT');
    assert.equal(stale.ack.reason, 'stale_version');
    assert.equal(stale.ack.payloadHash, null);
    assert.match(stale.ack.currentPayloadHash, /^[0-9a-f]{64}$/);
    assert.match(stale.ack.submittedIntentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      JSON.parse((await db.get(
        'SELECT result_detail FROM applied_commands WHERE command_id=?',
        ['710']
      )).result_detail),
      stale.ack
    );

    const duplicateUuid = '23222222-2222-4222-8222-222222222222';
    const duplicate = commandEnvelope({ commandId: 711 });
    duplicate.payload.effect_key = 'journal_entry:' + duplicateUuid + ':0';
    duplicate.payload.entry.entry_uuid = duplicateUuid;
    duplicate.payload.entry.occurred_start = '2026-07-12T08:00:00.000Z';
    const rejected = await journal.applyJournalCommand(db, duplicate, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(rejected.ack.reason, 'duplicate_candidate');
    assert.equal(rejected.ack.payloadHash, null);
    assert.deepEqual(rejected.ack.duplicateCandidate, {
      entryUuid: ENTRY_UUID,
      occurredStart: '2026-07-12T07:30:00.000Z',
      activityCode: 'irrigation',
      plotUuid: PLOT_UUID,
    });
    assert.deepEqual(Object.keys(rejected.ack.duplicateCandidate).sort(), [
      'activityCode', 'entryUuid', 'occurredStart', 'plotUuid',
    ]);
    assert.equal('details' in rejected.ack, false);
  } finally {
    db.close();
  }
});

test('entry duplicate acknowledgement is canonical top-level command control and is stripped before storage', async () => {
  const db = fixtureDb('command-duplicate-ack-control');
  try {
    const catalog = await journal.loadCatalog(db);
    await journal.finalize(db, catalog, localEntryInput(), localPrincipal());
    const separateUuid = '24222222-2222-4222-8222-222222222222';
    const accepted = commandEnvelope({ commandId: 720 });
    accepted.payload.effect_key = 'journal_entry:' + separateUuid + ':0';
    accepted.payload.entry.entry_uuid = separateUuid;
    accepted.payload.entry.occurred_start = '2026-07-12T08:00:00.000Z';
    accepted.payload.duplicate_guard_ack_entry_uuid = ENTRY_UUID;
    const result = await journal.applyJournalCommand(db, accepted, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(result.ack.result, 'APPLIED');
    const aggregate = JSON.parse((await db.get(
      "SELECT payload_json FROM sync_outbox WHERE aggregate_type='JOURNAL_ENTRY' AND aggregate_key=?",
      [separateUuid]
    )).payload_json);
    assert.equal('duplicate_guard_ack_entry_uuid' in aggregate, false);

    const malformedUuid = '25222222-2222-4222-8222-222222222222';
    const malformed = commandEnvelope({ commandId: 721 });
    malformed.payload.effect_key = 'journal_entry:' + malformedUuid + ':0';
    malformed.payload.entry.entry_uuid = malformedUuid;
    malformed.payload.entry.occurred_start = '2026-07-12T11:00:00.000Z';
    malformed.payload.duplicate_guard_ack_entry_uuid = 'NOT-A-UUID';
    const malformedResult = await journal.applyJournalCommand(db, malformed, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(malformedResult.ack.result, 'REJECTED_PERMANENT');
    assert.equal(malformedResult.ack.reason, 'malformed_command');
    assert.equal(await db.get('SELECT entry_uuid FROM journal_entries WHERE entry_uuid=?', [malformedUuid]), undefined);

    const plot = pendingCommand(
      722,
      'UPSERT_JOURNAL_PLOT',
      'journal_plot:' + SECOND_PLOT_UUID + ':0',
      { plot: plotAggregate() }
    );
    plot.payload.duplicate_guard_ack_entry_uuid = ENTRY_UUID;
    const wrongType = await journal.applyJournalCommand(db, plot, {
      gateway_device_eui: GATEWAY_EUI,
    });
    assert.equal(wrongType.ack.result, 'REJECTED_PERMANENT');
    assert.equal(wrongType.ack.reason, 'malformed_command');
    assert.equal(await db.get('SELECT plot_uuid FROM journal_plots WHERE plot_uuid=?', [SECOND_PLOT_UUID]), undefined);
  } finally {
    db.close();
  }
});
