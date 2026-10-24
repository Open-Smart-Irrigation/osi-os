'use strict';

// Task 5b3 history compatibility matrix and the shipped flow's SQLite path.
// The classifier matrix compares the JS and SQL v1 population decisions. The
// flow test exercises dirty CAS completion, the durable valve batch, manifest
// filtering, and the valve ACK cursor boundary on both image profiles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PROFILES, createHarness, loadProfile } = require('./history-sync-flow-harness');

const root = path.resolve(__dirname, '..');
const GATEWAY = '0016C001F1000001';
const VALVE = 'A840410000000001';
const DAY = '2026-10-05';

function seed(db) {
  db.exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  db.prepare("INSERT INTO users(id,username,password_hash,user_uuid,server_url,server_sync_token,created_at) VALUES(1,'fixture','x','fixture-user','https://cloud.invalid','fixture-token','2026-10-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO irrigation_zones(id,user_id,name,zone_uuid,gateway_device_eui,sync_version) VALUES(1,1,'History Zone','zone-history',?,1)").run(GATEWAY);
  db.prepare("INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at,gateway_device_eui) VALUES(?,?,?,?,?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z',?)").run(VALVE, 'Valve', 'STREGA_VALVE', 1, 1, GATEWAY);
  db.prepare("INSERT INTO sync_link_state(peer_node,linked,server_url,gateway_device_eui,updated_at) VALUES('cloud',1,'https://cloud.invalid',?,'2026-10-01T00:00:00.000Z')").run(GATEWAY);
  const cursor = db.prepare("INSERT INTO sync_history_cursors(peer_node,table_name,state,shadow_completed_at,durable_enabled_at,backfill_completed_at,snapshot_high_key,last_acked_key) VALUES('cloud',?,'tail','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','',?)");
  for (const table of ['radio_uplinks', 'device_data', 'chameleon_readings', 'dendrometer_readings', 'dendrometer_daily', 'zone_daily_environment', 'zone_daily_recommendations', 'irrigation_events']) {
    cursor.run(table, '');
  }
  cursor.run('valve_actuation_expectations', '');
}

function transport(marker, compatibility) {
  return JSON.stringify({ physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null, ...(compatibility ? { legacy_v1_compatibility: compatibility } : {}) } });
}

function matrixExpectation(id, overrides = {}) {
  return Object.assign({
    expectation_id: id,
    device_eui: VALVE,
    zone_id: 1,
    command_id: null,
    trigger: 'on_valve_schedule',
    commanded_at: '2026-10-05T08:00:00.000Z',
    commanded_duration_seconds: 900,
    expected_close_at: '2026-10-05T08:15:00.000Z',
    transport_json: null,
    reconciliation_state: 'PENDING_OBSERVATION',
  }, overrides);
}

function compatibilityFor(row, overrides = {}) {
  return compatibilityTransport(row, {}, overrides);
}

function legacy(id, overrides = {}) {
  const row = {
    expectation_id: id,
    device_eui: VALVE,
    zone_id: 1,
    command_id: null,
    trigger: 'on_valve_schedule',
    commanded_at: '2026-10-05T08:00:00.000Z',
    commanded_duration_seconds: 900,
    expected_close_at: '2026-10-05T08:15:00.000Z',
    transport_json: null,
    reconciliation_state: 'PENDING_OBSERVATION',
  };
  row.transport_json = transport(null, {
    version: 1,
    source: 'preexisting_on_valve_schedule',
    expectation_id: id,
    commanded_at: row.commanded_at,
    commanded_duration_seconds: row.commanded_duration_seconds,
    expected_close_at: row.expected_close_at,
  });
  return Object.assign(row, overrides);
}

function compatibilityTransport(row, physical = {}, compatibility = {}) {
  return JSON.stringify({ physical_run: {
    version: 1,
    source: 'explicit_report',
    earliest_possible_start_at: null,
    latest_possible_end_at: null,
    ...physical,
    legacy_v1_compatibility: {
      version: 1,
      source: 'preexisting_on_valve_schedule',
      expectation_id: row.expectation_id,
      commanded_at: row.commanded_at,
      commanded_duration_seconds: row.commanded_duration_seconds,
      expected_close_at: row.expected_close_at,
      ...compatibility
    }
  } });
}

function insertExpectation(db, row) {
  db.prepare(`INSERT INTO valve_actuation_expectations(
    expectation_id,device_eui,zone_id,command_id,commanded_at,
    commanded_duration_seconds,expected_close_at,volume_source,
    reconciliation_state,created_at,trigger,transport_json
  ) VALUES(?,?,?,?,?,?,?,'none',?,'2026-10-05T08:00:00.000Z',?,?)`).run(
    row.expectation_id, row.device_eui, row.zone_id, row.command_id,
    row.commanded_at, row.commanded_duration_seconds, row.expected_close_at,
    row.reconciliation_state, row.trigger || null, row.transport_json
  );
}

function dirty(db, key, changedAt, attempts = 7) {
  db.prepare("INSERT INTO sync_history_dirty_keys(peer_node,table_name,row_key,change_kind,changed_at,status,attempts) VALUES('cloud','valve_actuation_expectations',?,'upsert',?,'pending',?)").run(key, changedAt, attempts);
}

function freshValveCursor(db) {
  db.prepare("UPDATE sync_history_cursors SET state='shadow', shadow_completed_at=NULL, durable_enabled_at=NULL, backfill_started_at=NULL, backfill_completed_at=NULL, snapshot_high_key=NULL, last_shadow_acked_key=NULL, last_acked_key=NULL, last_error=NULL, retry_count=0, next_attempt_at=NULL WHERE table_name='valve_actuation_expectations'").run();
}

function clearDirtyForRows(db, rows) {
  const keys = rows.map((row) => `VALVE_ACTUATION|${GATEWAY}|${row.expectation_id}`);
  if (!keys.length) return;
  db.prepare(`DELETE FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations' AND row_key IN (${keys.map(() => '?').join(',')})`).run(...keys);
}

function commandRow(id, overrides = {}) {
  return Object.assign(legacy(id), { command_id: `cmd-${id}`, trigger: 'manual', transport_json: null }, overrides);
}

function localRow(id, overrides = {}) {
  return Object.assign(legacy(id), { commanded_duration_seconds: -1, expected_close_at: '', trigger: null, transport_json: null }, overrides);
}

function cursorState(db, state, lastAckedKey, snapshotHighKey = null) {
  const now = '2026-10-01T00:00:00.000Z';
  db.prepare("UPDATE sync_history_cursors SET state=?, shadow_completed_at=?, durable_enabled_at=?, backfill_completed_at=?, snapshot_high_key=?, last_shadow_acked_key=?, last_acked_key=?, last_error=NULL, retry_count=0, next_attempt_at=NULL WHERE table_name='valve_actuation_expectations'").run(
    state,
    state === 'shadow' ? null : now,
    state === 'shadow' ? null : now,
    state === 'tail' ? now : null,
    snapshotHighKey,
    state === 'shadow' ? lastAckedKey : null,
    state === 'shadow' ? null : lastAckedKey
  );
  db.prepare("DELETE FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations'").run();
}

function ack(tableName, phase, value) {
  return {
    statusCode: 200,
    payload: {
      batchId: `task5b3-${phase}`,
      tableName,
      phase,
      durableMirrorConfirmed: true,
      results: [],
      ackedThroughId: null,
      ackedThroughKey: value
    },
    _historyBatch: { batchId: `task5b3-${phase}`, tableName, phase, dirtyKeys: [], dirtyRowKeysByHistoryKey: {} }
  };
}

for (const profile of PROFILES) {
  test(`${profile}: JS classifier and SQL population predicate agree on strict compatibility fixtures`, (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    seed(db);
    const { helper } = loadProfile(profile);
    const valve = require(path.join(root, 'conf', profile, 'files/usr/share/node-red/osi-valve-control'));
    const validMarker = transport();
    const fixtures = [
      ['command-marker', matrixExpectation('command-marker', { command_id: 'cmd-marker', trigger: 'manual', transport_json: validMarker }), false],
      ['command-malformed', matrixExpectation('command-malformed', { command_id: 'cmd-malformed', trigger: 'manual', transport_json: '{' }), false],
      ['command-false-marker', matrixExpectation('command-false-marker', { command_id: 'cmd-false', trigger: 'manual', transport_json: JSON.stringify({ physical_run: false }) }), false],
      ['command-sentinels', matrixExpectation('command-sentinels', { command_id: 'cmd-sentinel', trigger: 'manual', commanded_duration_seconds: -1, expected_close_at: '', transport_json: null }), false],
      ['legacy-sql-null', matrixExpectation('legacy-sql-null'), false],
      ['legacy-empty', matrixExpectation('legacy-empty', { transport_json: '' }), false],
      ['legacy-object', matrixExpectation('legacy-object', { transport_json: '{}' }), false],
      ['legacy-null-marker', matrixExpectation('legacy-null-marker', { transport_json: '{"physical_run":null}' }), false],
      ['root-json-null', matrixExpectation('root-json-null', { transport_json: 'null' }), true],
      ['root-string-null', matrixExpectation('root-string-null', { transport_json: '"null"' }), true],
      ['root-scalar', matrixExpectation('root-scalar', { transport_json: '7' }), true],
      ['root-array', matrixExpectation('root-array', { transport_json: '[]' }), true],
      ['invalid-json', matrixExpectation('invalid-json', { transport_json: '{' }), true],
      ['false-marker', matrixExpectation('false-marker', { transport_json: JSON.stringify({ physical_run: false }) }), true],
      ['zero-marker', matrixExpectation('zero-marker', { transport_json: JSON.stringify({ physical_run: 0 }) }), true],
      ['string-marker', matrixExpectation('string-marker', { transport_json: JSON.stringify({ physical_run: 'x' }) }), true],
      ['string-version', matrixExpectation('string-version', { transport_json: JSON.stringify({ physical_run: { version: '1', source: 'explicit_report', earliest_possible_start_at: null, latest_possible_end_at: null } }) }), true],
      ['numeric-v1-marker', matrixExpectation('numeric-v1-marker', { transport_json: validMarker }), true],
      ['missing-marker-sentinel', matrixExpectation('missing-marker-sentinel', { commanded_duration_seconds: -1, expected_close_at: '', transport_json: null }), true],
      ['empty-transport-sentinel', matrixExpectation('empty-transport-sentinel', { commanded_duration_seconds: -1, expected_close_at: '', transport_json: '' }), true],
      ['unrelated-object-sentinel', matrixExpectation('unrelated-object-sentinel', { commanded_duration_seconds: -1, expected_close_at: '', transport_json: '{}' }), true],
      ['null-marker-sentinel', matrixExpectation('null-marker-sentinel', { commanded_duration_seconds: -1, expected_close_at: '', transport_json: '{"physical_run":null}' }), true],
    ].map(([name, row, local]) => ({ name, row, local }));
    const strictRows = [];
    const open = matrixExpectation('strict-open');
    open.transport_json = compatibilityFor(open);
    strictRows.push({ name: 'strict-open', row: open, local: false });
    const closed = matrixExpectation('strict-closed', { reconciliation_state: 'OBSERVED_CLOSED' });
    closed.transport_json = compatibilityFor(closed, { latest_possible_end_at: closed.expected_close_at });
    strictRows.push({ name: 'strict-closed', row: closed, local: false });
    const wrongTrigger = matrixExpectation('wrong-trigger', { trigger: 'manual' });
    wrongTrigger.transport_json = compatibilityFor(wrongTrigger);
    strictRows.push({ name: 'wrong-trigger', row: wrongTrigger, local: true });
    const forgedSentinel = matrixExpectation('forged-sentinel', { commanded_duration_seconds: -1, expected_close_at: '' });
    forgedSentinel.transport_json = compatibilityFor(forgedSentinel);
    strictRows.push({ name: 'forged-sentinel', row: forgedSentinel, local: true });
    for (const [name, compatibility] of [
      ['copied-id-type', { expectation_id: 1 }],
      ['copied-commanded-at-type', { commanded_at: 1 }],
      ['copied-duration-type', { commanded_duration_seconds: '900' }],
      ['copied-close-type', { expected_close_at: 1 }],
      ['copied-id-equality', { expectation_id: 'other' }],
      ['copied-commanded-at-equality', { commanded_at: '2026-10-05T08:00:00.001Z' }],
      ['copied-duration-equality', { commanded_duration_seconds: 901 }],
      ['copied-close-equality', { expected_close_at: '2026-10-05T08:15:00.001Z' }],
    ]) {
      const row = matrixExpectation(name);
      row.transport_json = compatibilityFor(row, compatibility);
      strictRows.push({ name, row, local: true });
    }
    for (const [name, physical] of [
      ['marker-version-type', { version: '1' }],
      ['marker-source-type', { source: 1 }],
      ['compat-version-type', { version: '1' }],
      ['compat-source-type', { source: 1 }],
      ['missing-earliest-bound', { earliest_possible_start_at: undefined }],
      ['invalid-latest-bound', { latest_possible_end_at: '2026-02-29T08:15:00Z' }],
    ]) {
      const row = matrixExpectation(name);
      row.transport_json = name.startsWith('compat-')
        ? compatibilityFor(row, physical)
        : compatibilityTransport(row, physical);
      const fixture = { name, row, local: true };
      strictRows.push(fixture);
      if (!name.startsWith('compat-')) {
        const restoredName = `${name}-restored`;
        const restored = matrixExpectation(restoredName);
        restored.transport_json = compatibilityFor(restored);
        strictRows.push({ name: restoredName, row: restored, local: false });
      }
    }
    for (const [name, duration] of [['compat-duration-zero', 0], ['compat-duration-fractional', 1.5]]) {
      const row = matrixExpectation(name, { commanded_duration_seconds: duration });
      row.transport_json = compatibilityFor(row);
      strictRows.push({ name, row, local: true });
    }
    for (const [name, instant, local] of [
      ['compat-seconds', '2026-10-05T08:00:00Z', false],
      ['compat-fraction-1', '2026-10-05T08:00:00.1Z', false],
      ['compat-fraction-6', '2026-10-05T08:00:00.123456Z', false],
      ['compat-fraction-9', '2026-10-05T08:00:00.123456789Z', false],
      ['compat-offset', '2026-10-05T08:00:00+01:00', true],
      ['compat-lowercase-z', '2026-10-05T08:00:00.000z', true],
      ['compat-space', '2026-10-05 08:00:00Z', true],
      ['compat-invalid-calendar', '2026-02-29T08:00:00.000Z', true],
      ['compat-fraction-10', '2026-10-05T08:00:00.1234567890Z', true],
    ]) {
      const row = matrixExpectation(name, { commanded_at: instant });
      row.transport_json = compatibilityFor(row);
      strictRows.push({ name, row, local });
    }
    fixtures.push(...strictRows);
    fixtures.forEach((fixture) => insertExpectation(db, fixture.row));
    const rows = db.prepare('SELECT * FROM valve_actuation_expectations ORDER BY expectation_id').all();
    const expectedLocal = new Set(rows.filter((row) => valve.isV1LocalOnlyExpectation(row)).map((row) => row.expectation_id));
    const replicated = new Set(db.prepare(`SELECT vae.expectation_id FROM valve_actuation_expectations vae WHERE ${helper.v1ReplicationPredicate('vae')}`).all().map((row) => row.expectation_id));
    assert.deepEqual([...replicated].sort(), rows.filter((row) => !expectedLocal.has(row.expectation_id)).map((row) => row.expectation_id).sort());
    for (const fixture of fixtures) {
      assert.equal(expectedLocal.has(fixture.name), fixture.local, `${fixture.name} JS local decision`);
    }
    for (const name of ['marker-version-type', 'marker-source-type', 'missing-earliest-bound', 'invalid-latest-bound']) {
      const restoredName = `${name}-restored`;
      assert.equal(expectedLocal.has(name), true, `${name} JS local decision`);
      assert.equal(replicated.has(name), false, `${name} SQL local decision`);
      assert.equal(replicated.has(restoredName), true, `${restoredName} SQL replication after restoring physical field`);
      assert.equal(expectedLocal.has(restoredName), false, `${restoredName} JS replication after restoring physical field`);
    }
    const maxSafe = Object.assign(legacy('max-safe'), { commanded_duration_seconds: Number.MAX_SAFE_INTEGER });
    maxSafe.transport_json = compatibilityTransport(maxSafe);
    const beyondSafe = Object.assign(legacy('beyond-safe'), { commanded_duration_seconds: Number.MAX_SAFE_INTEGER + 1 });
    beyondSafe.transport_json = compatibilityTransport(beyondSafe);
    insertExpectation(db, maxSafe);
    insertExpectation(db, beyondSafe);
    const boundaryRows = db.prepare(`SELECT expectation_id FROM valve_actuation_expectations vae WHERE ${helper.v1ReplicationPredicate('vae')}`).all();
    assert.equal(valve.isV1LocalOnlyExpectation(maxSafe), false);
    assert.equal(valve.isV1LocalOnlyExpectation(beyondSafe), true);
    assert.equal(boundaryRows.some((row) => row.expectation_id === 'max-safe'), true);
    assert.equal(boundaryRows.some((row) => row.expectation_id === 'beyond-safe'), false);
    const oldOrdinary = commandRow('old-ordinary', { commanded_at: '2026-10-01T08:00:00.000Z', expected_close_at: '2026-10-01T08:15:00.000Z' });
    insertExpectation(db, oldOrdinary);
    for (let i = 0; i < 220; i += 1) {
      const crowded = Object.assign(legacy(`crowd-${String(i).padStart(3, '0')}`, { commanded_at: '2026-10-05T08:00:00.000Z' }), { commanded_duration_seconds: Number.MAX_SAFE_INTEGER + 1 });
      crowded.transport_json = compatibilityTransport(crowded);
      insertExpectation(db, crowded);
    }
    const limited = db.prepare(`SELECT vae.expectation_id FROM valve_actuation_expectations vae WHERE ${helper.v1ReplicationPredicate('vae')} ORDER BY vae.commanded_at DESC LIMIT 200`).all();
    assert.equal(limited.some((row) => row.expectation_id === 'old-ordinary'), true, 'ineligible crowd cannot consume the population limit');
    assert.equal(limited.some((row) => String(row.expectation_id).startsWith('crowd-')), false);
    const wireCases = [
      ['seconds', '2026-10-05T08:00:00Z', true],
      ['fraction-1', '2026-10-05T08:00:00.1Z', true],
      ['fraction-6', '2026-10-05T08:00:00.123456Z', true],
      ['fraction-9', '2026-10-05T08:00:00.123456789Z', true],
      ['fraction-10', '2026-10-05T08:00:00.1234567890Z', false],
      ['leap-day', '2024-02-29T23:59:59Z', true],
      ['non-leap-day', '2026-02-29T23:59:59Z', false],
      ['month-zero', '2026-00-05T08:00:00Z', false],
      ['month-13', '2026-13-05T08:00:00Z', false],
      ['day-zero', '2026-10-00T08:00:00Z', false],
      ['day-32', '2026-10-32T08:00:00Z', false],
      ['hour-24', '2026-10-05T24:00:00Z', false],
      ['minute-60', '2026-10-05T08:60:00Z', false],
      ['second-60', '2026-10-05T08:00:60Z', false],
      ['lowercase-z', '2026-10-05T08:00:00z', false],
      ['offset', '2026-10-05T08:00:00+01:00', false],
      ['space', '2026-10-05 08:00:00Z', false],
      ['date-only', '2026-10-05', false],
      ['non-text', 0, false]
    ];
    assert.deepEqual(wireCases.map(([, value]) => valve.isEdgeV1WireInstant(value)), wireCases.map(([, , expected]) => expected));
  });

  test(`${profile}: shipped history flow filters local rows before batch and manifest limits, then CAS-completes dirty locals`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    seed(db);
    const command = legacy('command-backed');
    command.command_id = 'cmd-1';
    command.trigger = 'manual';
    command.transport_json = null;
    const local = legacy('local-sentinel', { commanded_duration_seconds: -1, expected_close_at: '', trigger: null, transport_json: null });
    const report = legacy('local-report', { trigger: null, transport_json: JSON.stringify({ physical_run: { version: 1, source: 'explicit_report', earliest_possible_start_at: '2026-10-05T08:00:00Z', latest_possible_end_at: '2026-10-05T08:15:00Z' } }) });
    [command, local, report].forEach((row) => insertExpectation(db, row));
    db.prepare("DELETE FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations'").run();
    const commandKey = `VALVE_ACTUATION|${GATEWAY}|command-backed`;
    const localKey = `VALVE_ACTUATION|${GATEWAY}|local-sentinel`;
    const reportKey = `VALVE_ACTUATION|${GATEWAY}|local-report`;
    dirty(db, commandKey, '2026-10-05T09:00:00.000Z');
    dirty(db, localKey, '2026-10-05T09:00:01.000Z');
    dirty(db, reportKey, '2026-10-05T09:00:02.000Z');
    const h = createHarness({ db, profile, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
    await h.tick();
    const batches = h.cloud.batches.filter((batch) => batch.tableName === 'valve_actuation_expectations');
    assert.deepEqual(batches.map((batch) => batch.keys), [[commandKey]]);
    const dirtyRows = db.prepare("SELECT row_key,status,attempts,last_error,next_attempt_at FROM sync_history_dirty_keys ORDER BY row_key").all().map((row) => ({ ...row }));
    assert.deepEqual(dirtyRows, [commandKey, localKey, reportKey].sort().map((row_key) => ({ row_key, status: 'done', attempts: 7, last_error: null, next_attempt_at: null })));
    const manifest = await h.invoke('sync-history-manifest-build', {});
    assert.ok(manifest && manifest.payload.segments.length > 0);
    const manifestAnswer = await h.invoke('sync-history-manifest-http', manifest);
    await h.invoke('sync-history-manifest-mark', manifestAnswer);
    assert.deepEqual(h.cloud.manifests.at(-1), [], 'manifest matched after local rows were excluded');

    const segmentKey = `${VALVE}|${DAY}`;
    h.cloud.seed('valve_actuation_expectations', commandKey, segmentKey, 'deliberately-wrong-hash');
    const repairManifest = await h.invoke('sync-history-manifest-build', {});
    const repairAnswer = await h.invoke('sync-history-manifest-http', repairManifest);
    await h.invoke('sync-history-manifest-mark', repairAnswer);
    assert.ok(h.cloud.manifests.at(-1).includes(`valve_actuation_expectations|${segmentKey}`));
    const repair = db.prepare("SELECT status,change_kind FROM sync_history_dirty_keys WHERE row_key=?").get(commandKey);
    assert.deepEqual({ ...repair }, { status: 'pending', change_kind: 'repair' });
    h.memory.set('history_sync_last_table', 'irrigation_events');
    await h.tick();
    assert.deepEqual({ ...db.prepare("SELECT status,change_kind FROM sync_history_dirty_keys WHERE row_key=?").get(commandKey) }, { status: 'done', change_kind: 'repair' });
    const stableManifest = await h.invoke('sync-history-manifest-build', {});
    const stableAnswer = await h.invoke('sync-history-manifest-http', stableManifest);
    await h.invoke('sync-history-manifest-mark', stableAnswer);
    assert.deepEqual(h.cloud.manifests.at(-1), [], 'repair ACK leaves the following manifest stable');

    await h.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', `VALVE_ACTUATION|${GATEWAY}|command-backed`));
    assert.equal(db.prepare("SELECT last_acked_key FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().last_acked_key, 'command-backed');
    await h.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', `VALVE_ACTUATION|${GATEWAY}|command-a`));
    assert.equal(db.prepare("SELECT last_acked_key FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().last_acked_key, 'command-backed');
    await h.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', 'VALVE_ACTUATION|0016C001F1000002|other'));
    const cursor = db.prepare("SELECT last_acked_key,last_error FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get();
    assert.equal(cursor.last_acked_key, 'command-backed');
    assert.equal(cursor.last_error, 'invalid ACK boundary');
  });

  test(`${profile}: all-local queues drain without a cloud batch and mixed digit/alpha queues drain in multiple batches`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    seed(db);
    const localRows = [];
    for (let i = 0; i < 120; i += 1) {
      localRows.push(legacy(`local-${String(i).padStart(3, '0')}`, { commanded_duration_seconds: -1, expected_close_at: '', trigger: null, transport_json: null }));
    }
    localRows.forEach((row) => insertExpectation(db, row));
    freshValveCursor(db);
    const allLocal = createHarness({ db, profile, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
    for (let i = 0; i < 5 && Number(db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE status='pending'").get().n); i += 1) {
      allLocal.memory.set('history_sync_last_table', 'irrigation_events');
      await allLocal.tick();
    }
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE status='pending'").get().n), 0);
    assert.equal(allLocal.cloud.batches.filter((batch) => batch.keys.length).length, 0, 'all local rows are completed without a cloud row batch');
    assert.deepEqual(db.prepare("SELECT DISTINCT attempts,last_error,next_attempt_at FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations'").all().map((row) => ({ ...row })), [{ attempts: 0, last_error: null, next_attempt_at: null }]);

    const mixedDb = new DatabaseSync(':memory:');
    t.after(() => mixedDb.close());
    seed(mixedDb);
    const commandRows = [
      Object.assign(legacy('1-command'), { command_id: 'cmd-1-command', trigger: 'manual', transport_json: null }),
      Object.assign(legacy('9-command'), { command_id: 'cmd-9-command', trigger: 'manual', transport_json: null }),
      Object.assign(legacy('a-command'), { command_id: 'cmd-a-command', trigger: 'manual', transport_json: null }),
    ];
    commandRows.concat(localRows).forEach((row) => insertExpectation(mixedDb, row));
    mixedDb.prepare("DELETE FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations'").run();
    commandRows.concat(localRows).forEach((row, i) => dirty(mixedDb, `VALVE_ACTUATION|${GATEWAY}|${row.expectation_id}`, `2026-10-05T10:${String(i).padStart(2, '0')}:00.000Z`));
    const mixed = createHarness({ db: mixedDb, profile, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
    for (let i = 0; i < 10 && Number(mixedDb.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE status='pending'").get().n); i += 1) {
      mixed.memory.set('history_sync_last_table', 'irrigation_events');
      await mixed.tick();
    }
    assert.equal(Number(mixedDb.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE status='pending'").get().n), 0);
    const derivedBatches = mixed.cloud.batches.filter((batch) => batch.phase === 'derived');
    const submitted = derivedBatches.flatMap((batch) => batch.keys);
    assert.deepEqual(submitted, ['1-command', '9-command', 'a-command'].map((id) => `VALVE_ACTUATION|${GATEWAY}|${id}`));
    assert.equal(derivedBatches.length, 1, 'one mixed command pass is enough for this small queue');
  });

  test(`${profile}: fresh all-local valve history advances shadow, backfill and tail`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    seed(db);
    const rows = Array.from({ length: 14 }, (_, i) => localRow(`local-fresh-${String(i).padStart(3, '0')}`));
    rows.forEach((row) => insertExpectation(db, row));
    freshValveCursor(db);
    const h = createHarness({ db, profile, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
    for (let i = 0; i < 10; i += 1) {
      h.memory.set('history_sync_last_table', 'irrigation_events');
      await h.tick();
      const state = db.prepare("SELECT state FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().state;
      const pending = Number(db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations' AND status='pending'").get().n);
      if (state === 'tail' && pending === 0) break;
    }
    const cursor = db.prepare("SELECT state,snapshot_high_key,last_shadow_acked_key,last_acked_key,retry_count,next_attempt_at FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get();
    assert.deepEqual({ ...cursor }, { state: 'tail', snapshot_high_key: '', last_shadow_acked_key: null, last_acked_key: null, retry_count: 0, next_attempt_at: null });
    assert.equal(h.cloud.batches.filter((batch) => batch.tableName === 'valve_actuation_expectations' && batch.keys.length).length, 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations' AND status='pending'").get().n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sync_history_quarantine WHERE table_name='valve_actuation_expectations'").get().n), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM sync_history_segments WHERE table_name='valve_actuation_expectations'").get().n), 0);
  });

  test(`${profile}: fresh mixed valve history sends every command row once in shadow and backfill`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    seed(db);
    const commands = [];
    for (let i = 0; i < 120; i += 1) commands.push(commandRow(`1${String(i).padStart(7, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`));
    for (let i = 0; i < 120; i += 1) commands.push(commandRow(`a${String(i).padStart(7, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`));
    for (let i = 0; i < 20; i += 1) commands.push(commandRow(`z${String(i).padStart(7, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`));
    const locals = [
      ...Array.from({ length: 12 }, (_, i) => localRow(`0-local-${String(i).padStart(3, '0')}`)),
      ...Array.from({ length: 12 }, (_, i) => localRow(`5-local-${String(i).padStart(3, '0')}`)),
      ...Array.from({ length: 12 }, (_, i) => localRow(`y-local-${String(i).padStart(3, '0')}`)),
    ];
    commands.concat(locals).forEach((row) => insertExpectation(db, row));
    clearDirtyForRows(db, commands);
    freshValveCursor(db);
    const h = createHarness({ db, profile, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
    for (let i = 0; i < 12; i += 1) {
      h.memory.set('history_sync_last_table', 'irrigation_events');
      await h.tick();
      const state = db.prepare("SELECT state FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().state;
      const pending = Number(db.prepare("SELECT COUNT(*) AS n FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations' AND status='pending'").get().n);
      if (state === 'tail' && pending === 0) break;
    }
    const batches = h.cloud.batches.filter((batch) => batch.tableName === 'valve_actuation_expectations' && batch.keys.length);
    const expected = commands.map((row) => `VALVE_ACTUATION|${GATEWAY}|${row.expectation_id}`).sort();
    for (const phase of ['shadow', 'backfill']) {
      const phaseKeys = batches.filter((batch) => batch.phase === phase).flatMap((batch) => batch.keys);
      assert.deepEqual([...phaseKeys].sort(), expected, `${phase} exact once`);
      assert.equal(new Set(phaseKeys).size, expected.length, `${phase} has no replay`);
    }
    assert.equal(batches.filter((batch) => batch.phase === 'tail' && batch.keys.length).length, 0);
    assert.equal(h.cloud.index.size, commands.length);
    assert.equal(db.prepare("SELECT state,snapshot_high_key,last_shadow_acked_key,last_acked_key FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().state, 'tail');
    const cursor = db.prepare("SELECT snapshot_high_key,last_shadow_acked_key,last_acked_key FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get();
    assert.equal(cursor.snapshot_high_key, commands.at(-1).expectation_id);
    assert.equal(cursor.last_shadow_acked_key, commands.at(-1).expectation_id);
    assert.equal(cursor.last_acked_key, commands.at(-1).expectation_id);
    assert.equal(batches.some((batch) => batch.keys.some((key) => /\|(?:0|5|y)-local-/.test(key))), false);
    assert.deepEqual(db.prepare("SELECT DISTINCT status,attempts,last_error,next_attempt_at FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations'").all().map((row) => ({ ...row })), [{ status: 'done', attempts: 0, last_error: null, next_attempt_at: null }]);
  });

  test(`${profile}: loaded valve cursors normalize current prefixes and reject foreign or malformed prefixes in shadow/backfill/tail`, async (t) => {
    const cases = [
      ['shadow', '10000000-0000-0000-0000-000000000000', null],
      ['backfill', '10000000-0000-0000-0000-000000000000', null],
      ['tail', '10000000-0000-0000-0000-000000000000', null],
      ['tail', '10000000-0000-0000-0000-000000000000', 'VALVE_ACTUATION|0016C001F1000002|foreign'],
      ['tail', '10000000-0000-0000-0000-000000000000', 'VALVE_ACTUATION|0016C001F1000001|'],
      ['tail', '10000000-0000-0000-0000-000000000000', 'VALVE_ACTUATION|malformed'],
      ['tail', '10000000-0000-0000-0000-000000000000', 'VALVE_ACTUATION|0016c001f1000001|hidden']
    ];
    for (const [state, oldSuffix, stored] of cases) {
      const db = new DatabaseSync(':memory:');
      t.after(() => db.close());
      seed(db);
      const nextId = state === 'shadow'
        ? '10000000-0000-0000-0000-000000000001'
        : state === 'backfill'
          ? '10000000-0000-0000-0000-000000000002'
          : '10000000-0000-0000-0000-000000000003';
      insertExpectation(db, commandRow(nextId));
      const full = stored || `VALVE_ACTUATION|${GATEWAY}|${oldSuffix}`;
      const high = state === 'shadow' ? null : nextId;
      cursorState(db, state, full, high);
      const h = createHarness({ db, profile, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
      h.memory.set('history_sync_last_table', 'irrigation_events');
      await h.tick();
      const rows = h.cloud.batches.filter((batch) => batch.tableName === 'valve_actuation_expectations' && batch.keys.length);
      assert.equal(rows.length, 1, `${state} submits one row for ${full}`);
      assert.deepEqual(rows[0].keys, [`VALVE_ACTUATION|${GATEWAY}|${nextId}`]);
      const cursor = db.prepare("SELECT last_shadow_acked_key,last_acked_key FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get();
      if (state === 'shadow') assert.equal(cursor.last_shadow_acked_key, nextId);
      else assert.equal(cursor.last_acked_key, nextId);
    }
  });

  test(`${profile}: valve ACK cursor CAS canonicalizes equal/older full prefixes, accepts newer raw/full, and records invalid boundaries`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    seed(db);
    const currentPrefix = `VALVE_ACTUATION|${GATEWAY}|`;
    cursorState(db, 'tail', `${currentPrefix}10000000-0000-0000-0000-000000000002`, '10000000-0000-0000-0000-000000000002');
    const h = createHarness({ db, profile, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
    await h.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', `${currentPrefix}10000000-0000-0000-0000-000000000002`));
    assert.equal(db.prepare("SELECT last_acked_key,last_error FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().last_acked_key, '10000000-0000-0000-0000-000000000002');
    await h.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', `${currentPrefix}10000000-0000-0000-0000-000000000001`));
    assert.equal(db.prepare("SELECT last_acked_key,last_error FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().last_acked_key, '10000000-0000-0000-0000-000000000002');
    await h.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', `${currentPrefix}10000000-0000-0000-0000-000000000003`));
    assert.equal(db.prepare("SELECT last_acked_key FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().last_acked_key, '10000000-0000-0000-0000-000000000003');
    await h.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', '10000000-0000-0000-0000-000000000004'));
    assert.equal(db.prepare("SELECT last_acked_key FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().last_acked_key, '10000000-0000-0000-0000-000000000004');
    for (const invalid of [
      'VALVE_ACTUATION|0016c001f1000001|10000000-0000-0000-0000-000000000999',
      'VALVE_ACTUATION|0016C001F1000002|foreign',
      'VALVE_ACTUATION|0016C001F1000001|',
      'VALVE_ACTUATION|malformed',
    ]) {
      await h.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', invalid));
      const cursor = db.prepare("SELECT last_acked_key,last_error FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get();
      assert.equal(cursor.last_acked_key, '10000000-0000-0000-0000-000000000004');
      assert.equal(cursor.last_error, 'invalid ACK boundary');
    }
    for (const concurrent of ['raw', 'full']) {
      const raceDb = new DatabaseSync(':memory:');
      t.after(() => raceDb.close());
      seed(raceDb);
      cursorState(raceDb, 'tail', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001');
      let raced = false;
      const raceHarness = createHarness({
        db: raceDb,
        profile,
        lastTable: 'irrigation_events',
        env: { DEVICE_EUI: GATEWAY },
        afterAll: (sql, _params, _rows, raw) => {
          if (raced || !sql.includes('FROM sync_history_cursors')) return;
          raced = true;
          raw.prepare("UPDATE sync_history_cursors SET last_acked_key=? WHERE table_name='valve_actuation_expectations'").run(
            concurrent === 'raw' ? '10000000-0000-0000-0000-000000000003' : `${currentPrefix}10000000-0000-0000-0000-000000000003`
          );
        }
      });
      await raceHarness.invoke('sync-history-mark', ack('valve_actuation_expectations', 'tail', `${currentPrefix}10000000-0000-0000-0000-000000000002`));
      const racedCursor = raceDb.prepare("SELECT last_acked_key,last_error FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get();
      assert.equal(raced, true, `${concurrent} newer cursor hook ran`);
      assert.deepEqual({ ...racedCursor }, { last_acked_key: '10000000-0000-0000-0000-000000000003', last_error: null });
    }
  });

  test(`${profile}: dirty local completion remains pending when classifier or changed_at changes between read and CAS`, async (t) => {
    for (const race of ['classifier', 'changed_at']) {
      const db = new DatabaseSync(':memory:');
      t.after(() => db.close());
      seed(db);
      const row = localRow(`race-${race}`);
      insertExpectation(db, row);
      db.prepare("DELETE FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations'").run();
      const rowKey = `VALVE_ACTUATION|${GATEWAY}|${row.expectation_id}`;
      const changedAt = `2026-10-05T09:00:0${race === 'classifier' ? '1' : '2'}.000Z`;
      dirty(db, rowKey, changedAt);
      let raced = false;
      const h = createHarness({
        db,
        profile,
        lastTable: 'irrigation_events',
        env: { DEVICE_EUI: GATEWAY },
        afterAll: (sql, _params, _rows, raw) => {
          if (raced || !sql.includes('FROM valve_actuation_expectations') || !sql.includes('LIMIT 1')) return;
          raced = true;
          if (race === 'classifier') {
            raw.prepare("UPDATE valve_actuation_expectations SET command_id='race-command', trigger='manual', transport_json=NULL WHERE expectation_id=?").run(row.expectation_id);
            raw.prepare("UPDATE sync_history_dirty_keys SET changed_at=? WHERE table_name='valve_actuation_expectations' AND row_key=?").run(changedAt, rowKey);
          }
          else raw.prepare("UPDATE sync_history_dirty_keys SET changed_at=? WHERE table_name='valve_actuation_expectations' AND row_key=?").run('2026-10-05T09:01:00.000Z', rowKey);
        }
      });
      h.memory.set('history_sync_last_table', 'irrigation_events');
      await h.tick();
      const state = db.prepare("SELECT status,changed_at FROM sync_history_dirty_keys WHERE row_key=?").get(rowKey);
      assert.equal(raced, true, `${race} hook ran`);
      assert.equal(state.status, 'pending', `${race} race does not falsely complete`);
      assert.equal(state.status, 'pending', `${race} remains pending for the next classification`);
      if (race === 'classifier') assert.equal(db.prepare("SELECT command_id FROM valve_actuation_expectations WHERE expectation_id=?").get(row.expectation_id).command_id, 'race-command');
    }
  });

  test(`${profile}: grandfathered legacy history stays duplicate-safe on adoption and updates on CLOSED`, async (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    seed(db);
    const row = matrixExpectation('0-grandfathered');
    row.trigger = 'on_valve_schedule';
    const emptyRow = matrixExpectation('m-grandfathered', { transport_json: '' });
    const unrelatedRow = matrixExpectation('z-grandfathered', { transport_json: '{}' });
    [row, emptyRow, unrelatedRow].forEach((value) => insertExpectation(db, value));
    db.prepare("DELETE FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations'").run();
    freshValveCursor(db);
    const { helper } = loadProfile(profile);
    const source = db.prepare(`SELECT vae.*, COALESCE(iz.zone_uuid, 'zone-id:' || vae.zone_id) AS zone_uuid FROM valve_actuation_expectations vae LEFT JOIN irrigation_zones iz ON iz.id = vae.zone_id AND iz.deleted_at IS NULL WHERE ${helper.v1ReplicationPredicate('vae')} AND vae.expectation_id=?`).get(row.expectation_id);
    const prepared = helper.prepareRow('valve_actuation_expectations', GATEWAY, source);
    const historyKeyValue = prepared.historyKey;
    const segment = helper.segmentKey('valve_actuation_expectations', source);
    const h = createHarness({ db, profile, lastTable: 'irrigation_events', env: { DEVICE_EUI: GATEWAY } });
    const preAdoptionHash = prepared.payloadHash;
    for (let i = 0; i < 8; i += 1) {
      h.memory.set('history_sync_last_table', 'irrigation_events');
      await h.tick();
      const state = db.prepare("SELECT state FROM sync_history_cursors WHERE table_name='valve_actuation_expectations'").get().state;
      if (state === 'tail') break;
    }
    const freshKeys = h.cloud.batches.filter((batch) => batch.tableName === 'valve_actuation_expectations' && batch.keys.length && ['shadow', 'backfill'].includes(batch.phase)).flatMap((batch) => batch.keys);
    assert.equal(new Set(freshKeys).size, 3, 'all unmarked null/empty/unrelated rows remain in fresh shadow/backfill');
    assert.equal(h.cloud.index.size, 3);
    assert.equal(h.cloud.index.get(`valve_actuation_expectations\0${historyKeyValue}`), preAdoptionHash);
    h.cloud.seed('valve_actuation_expectations', historyKeyValue, segment, preAdoptionHash);

    const adoptedTransport = compatibilityFor(row);
    db.prepare("UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?").run(adoptedTransport, row.expectation_id);
    h.memory.set('history_sync_last_table', 'irrigation_events');
    await h.tick();
    const adoptionBatch = h.cloud.batches.filter((batch) => batch.keys.includes(historyKeyValue)).at(-1);
    assert.equal(adoptionBatch.results[0].status, 'DUPLICATE');
    assert.equal(adoptionBatch.results[0].historyKey, historyKeyValue);
    assert.equal(h.cloud.index.size, 3);
    const afterAdoption = db.prepare("SELECT status FROM sync_history_dirty_keys WHERE row_key=?").get(historyKeyValue);
    assert.equal(afterAdoption.status, 'done');

    const closedTransport = compatibilityFor(row, { latest_possible_end_at: row.expected_close_at });
    db.prepare("UPDATE valve_actuation_expectations SET observed_close_at=?, reconciliation_state='OBSERVED_CLOSED', transport_json=? WHERE expectation_id=?").run('2026-10-05T08:15:00.000Z', closedTransport, row.expectation_id);
    h.memory.set('history_sync_last_table', 'irrigation_events');
    await h.tick();
    const closedBatch = h.cloud.batches.filter((batch) => batch.keys.includes(historyKeyValue)).at(-1);
    assert.equal(closedBatch.results[0].status, 'UPDATED');
    assert.equal(h.cloud.index.size, 3);
    assert.equal([...h.cloud.index.keys()][0].split('\0')[1], historyKeyValue);
    const finalSource = db.prepare(`SELECT vae.*, COALESCE(iz.zone_uuid, 'zone-id:' || vae.zone_id) AS zone_uuid FROM valve_actuation_expectations vae LEFT JOIN irrigation_zones iz ON iz.id = vae.zone_id AND iz.deleted_at IS NULL WHERE ${helper.v1ReplicationPredicate('vae')} AND vae.expectation_id=?`).get(row.expectation_id);
    const finalPrepared = helper.prepareRow('valve_actuation_expectations', GATEWAY, finalSource);
    assert.notEqual(finalPrepared.payloadHash, preAdoptionHash);
    assert.equal(h.cloud.index.get(`valve_actuation_expectations\0${historyKeyValue}`), finalPrepared.payloadHash);
    h.cloud.seed('valve_actuation_expectations', historyKeyValue, segment, 'forced-grandfathered-mismatch');
    const mismatchManifest = await h.invoke('sync-history-manifest-build', {});
    const mismatchAnswer = await h.invoke('sync-history-manifest-http', mismatchManifest);
    await h.invoke('sync-history-manifest-mark', mismatchAnswer);
    assert.ok(h.cloud.manifests.at(-1).includes(`valve_actuation_expectations|${segment}`));
    const repair = db.prepare("SELECT row_key,status,change_kind FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations' AND row_key=?").get(historyKeyValue);
    assert.deepEqual({ ...repair }, { row_key: historyKeyValue, status: 'pending', change_kind: 'repair' });
    h.memory.set('history_sync_last_table', 'irrigation_events');
    await h.tick();
    const repaired = db.prepare("SELECT row_key,status,change_kind,last_error,next_attempt_at FROM sync_history_dirty_keys WHERE table_name='valve_actuation_expectations' AND row_key=?").get(historyKeyValue);
    assert.deepEqual({ ...repaired }, { row_key: historyKeyValue, status: 'done', change_kind: 'repair', last_error: null, next_attempt_at: null });
    const stableManifest = await h.invoke('sync-history-manifest-build', {});
    const stableAnswer = await h.invoke('sync-history-manifest-http', stableManifest);
    await h.invoke('sync-history-manifest-mark', stableAnswer);
    assert.deepEqual(h.cloud.manifests.at(-1), []);
  });
}
