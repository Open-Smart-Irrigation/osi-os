'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
const dispatch = require('./dispatch');

const EUI = '0016C001F1000001';

function controlledRuntime(sequence, { markerTrusted = () => true, onRuntimeNow = () => {} } = {}) {
  let index = 0;
  let active = sequence[0];
  const bootId = 'test-runtime-boot';
  const fs = {
    readFileSync(file) {
      if (file === '/proc/sys/kernel/random/boot_id') return bootId + '\n';
      if (file === '/proc/uptime') return `${(active - Date.parse('2026-10-18T10:00:00.000Z')) / 1000} 0\n`;
      if (file === '/var/run/osi-irrigation-clock.json') {
        if (!markerTrusted()) throw Object.assign(new Error('marker unavailable'), { code: 'ENOENT' });
        return JSON.stringify({ boot_id: bootId, epoch_ms: Date.parse('2026-10-18T10:00:00.000Z'), uptime_ms: 0, stratum: 1 });
      }
      throw Object.assign(new Error('fixture path unavailable'), { code: 'ENOENT' });
    },
  };
  return {
    clockOptions: { fs, bootPath: '/proc/sys/kernel/random/boot_id', uptimePath: '/proc/uptime', markerPath: '/var/run/osi-irrigation-clock.json', rejectionPath: '/tmp/task4c2-test-rejection.json', fallbackPath: '/tmp/task4c2-test-rejection-fallback.json' },
    runtimeNow() {
      active = sequence[Math.min(index++, sequence.length - 1)];
      onRuntimeNow(index, active);
      return active;
    },
  };
}

test('executeValveAttempt composes reservation, immutable snapshot, sole claim, and enqueue under one writer', async () => {
  const fixture = await tempDb();
  const events = [];
  const transport = {
    async enqueueDownlink(item) {
      events.push({ kind: 'rpc', item });
      return { id: 'composition-queue-1' };
    },
  };
  const result = await dispatch.executeValveAttempt({
    db: fixture.db,
    deviceEui: EUI,
    command: {
      device_eui: EUI,
      command_id: 'composition-open-1',
      action: 'OPEN_FOR_DURATION',
      duration_minutes: 2,
      provenance: { source: 'local_encoder', encoder: 'strega-v1' },
    },
    frame: { fPort: 2, data: Buffer.from([0x41, 2]).toString('base64'), confirmed: false, encrypted: false,
      provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    transport,
    now: '2026-10-18T10:00:00.000Z',
    trustedContext: controlledRuntime([Date.parse('2026-10-18T10:00:00.000Z')]),
  });
  assert.equal(result.phase, 'ACCEPTED');
  assert.equal(events.length, 1);
  assert.deepEqual([...Buffer.from(events[0].item.data, 'base64')], [0x41, 2]);
  const row = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', ['composition-open-1']);
  const transportState = JSON.parse(row.transport_json);
  assert.equal(transportState.phase, 'ACCEPTED');
  assert.equal(transportState.effect_snapshot.effect_class, 'SELF_CLOSING_OPEN');
  assert.equal(transportState.effect_snapshot.queue_expires_at, events[0].item.expiresAt);
  fixture.cleanup();
});

test('executeValveAttempt exact replay returns persisted transport without another RPC', async () => {
  const fixture = await tempDb();
  let calls = 0;
  const command = { device_eui: EUI, command_id: 'composition-replay-1', action: 'OPEN_FOR_DURATION', duration_minutes: 2 };
  const frame = { fPort: 2, data: Buffer.from([0x41, 2]).toString('base64'), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
  const transport = { async enqueueDownlink() { calls += 1; return { id: 'replay-queue-1' }; } };
  const first = await dispatch.executeValveAttempt({ db: fixture.db, deviceEui: EUI, command, frame, transport, now: '2026-10-18T10:00:00.000Z', trustedContext: controlledRuntime([Date.parse('2026-10-18T10:00:00.000Z')]) });
  const second = await dispatch.executeValveAttempt({ db: fixture.db, deviceEui: EUI, command, frame, transport, now: '2026-10-18T10:00:01.000Z', trustedContext: controlledRuntime([Date.parse('2026-10-18T10:00:01.000Z')]) });
  assert.equal(first.phase, 'ACCEPTED');
  assert.equal(second.phase, 'ACCEPTED');
  assert.equal(second.replayed, true);
  assert.equal(calls, 1);
  fixture.cleanup();
});

test('replay rejects an owner expiry that differs from its immutable snapshot copy', async () => {
  const fixture = await tempDb();
  const command = { device_eui: EUI, command_id: 'owner-expiry-shape', action: 'OPEN_FOR_DURATION', duration_minutes: 2, expires_at: '2026-10-18T10:10:00.000Z' };
  const frame = { fPort: 2, data: Buffer.from([0x41, 2]).toString('base64'), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
  await dispatch.executeValveAttempt({ db: fixture.db, deviceEui: EUI, command, frame,
    transport: { async enqueueDownlink() { return { id: 'owner-expiry-q1' }; } }, now: '2026-10-18T10:00:00.000Z',
    trustedContext: controlledRuntime([Date.parse('2026-10-18T10:00:00.000Z')]) });
  const row = await fixture.db.get('SELECT expectation_id, transport_json FROM valve_actuation_expectations WHERE command_id=?', [command.command_id]);
  const state = JSON.parse(row.transport_json);
  state.effect_snapshot.explicit_expiry_at = '2026-10-18T10:09:00.000Z';
  state.effect_snapshot.queue_expires_at = '2026-10-18T10:09:00.000Z';
  state.effect_snapshot.expires_at = '2026-10-18T10:09:00.000Z';
  await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [JSON.stringify(state), row.expectation_id]);
  await assert.rejects(dispatch.executeValveAttempt({ db: fixture.db, deviceEui: EUI, command, frame,
    transport: { async enqueueDownlink() { throw new Error('mismatched owner must not enqueue'); } }, now: '2026-10-18T10:00:01.000Z',
    trustedContext: controlledRuntime([Date.parse('2026-10-18T10:00:01.000Z')]) }), /expiry|snapshot/i);
  fixture.cleanup();
});

test('final timed OPEN check uses a fresh runtime instant after the writer wait', async () => {
  const fixture = await tempDb();
  const start = Date.parse('2026-10-18T10:00:00.000Z');
  await assert.rejects(dispatch.executeValveAttempt({
    db: fixture.db, deviceEui: EUI,
    command: { device_eui: EUI, command_id: 'fresh-runtime-cutoff', action: 'OPEN_FOR_DURATION', duration_minutes: 2, expires_at: '2026-10-18T10:00:01.000Z' },
    frame: { fPort: 2, data: Buffer.from([0x41, 2]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    transport: { async enqueueDownlink() { throw new Error('expired command must not enqueue'); } },
    now: new Date(start), trustedContext: controlledRuntime([start, start + 2000]),
  }), (error) => error && error.code === 'command_expired');
  assert.equal((await fixture.db.get('SELECT COUNT(*) AS count FROM valve_actuation_expectations WHERE command_id=?', ['fresh-runtime-cutoff'])).count, 1);
  fixture.cleanup();
});

// Owner decision 2026-10-24: gateway-originated opens no longer require an NTP sync since boot.
// The marker-based clock status is diagnostic only; neither the reservation nor the final
// check before the RPC refuses a timed OPEN on it.
test('a timed open proceeds without an NTP marker at reservation and at the final check', async () => {
  const fixture = await tempDb();
  const start = Date.parse('2026-10-18T10:00:00.000Z');
  const runtime = controlledRuntime([start, start + 1000, start + 2000, start + 3000], { markerTrusted: () => false });
  const command = { device_eui: EUI, command_id: 'no-ntp-open', action: 'OPEN_FOR_DURATION', duration_minutes: 2, expires_at: '2026-10-18T10:10:00.000Z' };
  const frame = { fPort: 2, data: Buffer.from([0x41, 2]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
  let sent = 0;
  const out = await dispatch.executeValveAttempt({ db: fixture.db, deviceEui: EUI, command, frame, transport: { async enqueueDownlink() { sent += 1; return { id: 'no-ntp-q1' }; } }, now: new Date(start), trustedContext: runtime });
  assert.equal(out.phase, 'ACCEPTED', JSON.stringify(out));
  assert.equal(sent, 1);
  fixture.cleanup();
});

test('untrusted-clock permanent CLOSE uses the strict unbounded safety variant and fresh CLOSED evidence quiesces it', async () => {
  const fixture = await tempDb();
  const context = controlledRuntime([Date.parse('2026-10-18T10:00:00.000Z')], { markerTrusted: () => false });
  const frame = { fPort: 1, data: Buffer.from([0x30]).toString('base64'), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder', encoder: 'ignored-for-safe-close' } };
  const out = await dispatch.executeValveAttempt({
    db: fixture.db, deviceEui: EUI,
    command: { device_eui: EUI, command_id: 'safe-close-1', action: 'CLOSE' }, frame,
    transport: { async enqueueDownlink(item) { assert.equal(item.expiresAt, undefined); return { id: 'safe-close-q1' }; } },
    now: '2026-10-18T10:00:00.000Z', trustedContext: context,
  });
  assert.equal(out.phase, 'ACCEPTED');
  const row = await fixture.db.get('SELECT * FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-1']);
  const state = JSON.parse(row.transport_json);
  assert.equal(state.effect_snapshot.timing_contract, 'UNBOUNDED_SAFE_CLOSE_V1');
  assert.equal(state.effect_snapshot.queue_expires_at, null);
  const settled = await dispatch.observeClosedEvidence({
    db: fixture.db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:01:00.000Z',
    runtimeContext: controlledRuntime([Date.parse('2026-10-18T10:02:00.000Z')]),
    event_identity: { fPort: 10, fCnt: 3 },
  });
  assert.equal(settled.quiesced.length, 1);
  const after = await fixture.db.get('SELECT observed_close_at, reconciliation_state FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-1']);
  assert.equal(after.observed_close_at, '2026-10-18T10:01:00.000Z');
  assert.equal(after.reconciliation_state, 'OBSERVED_CLOSED');
  fixture.cleanup();
});

test('unbounded CLOSED evidence requires the owner attempt receipt', async () => {
  const fixture = await tempDb();
  const context = controlledRuntime([Date.parse('2026-10-18T10:00:00.000Z')], { markerTrusted: () => false });
  await dispatch.executeValveAttempt({
    db: fixture.db, deviceEui: EUI, command: { device_eui: EUI, command_id: 'safe-close-no-attempt', action: 'CLOSE' },
    frame: { fPort: 1, data: Buffer.from([0x30]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder' } },
    transport: { async enqueueDownlink() { return { id: 'safe-close-no-attempt-q' }; } }, now: '2026-10-18T10:00:00.000Z', trustedContext: context,
  });
  const row = await fixture.db.get('SELECT expectation_id, transport_json FROM valve_actuation_expectations WHERE command_id=?', ['safe-close-no-attempt']);
  const state = JSON.parse(row.transport_json); delete state.phase; delete state.attempted_at; delete state.attempt_receipt; delete state.attempt_trusted_at; delete state.queue_id;
  await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=?, reconciliation_state=? WHERE expectation_id=?', [JSON.stringify(state), 'PENDING_OBSERVATION', row.expectation_id]);
  const observed = await dispatch.observeClosedEvidence({ db: fixture.db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:01:00.000Z', runtimeContext: controlledRuntime([Date.parse('2026-10-18T10:02:00.000Z')]) });
  assert.equal(observed.quiesced.length, 0);
  fixture.cleanup();
});

test('CLOSED evidence before the bounded CLOSE claim does not settle that owner', async () => {
  const fixture = await tempDb();
  await dispatch.executeValveAttempt({
    db: fixture.db, deviceEui: EUI,
    command: { device_eui: EUI, command_id: 'bounded-close-before-claim', action: 'CLOSE', expires_at: '2026-10-18T10:10:00.000Z' },
    frame: { fPort: 1, data: Buffer.from([0x30]).toString('base64'), confirmed: false, encrypted: false, provenance: { source: 'local_encoder' } },
    transport: { async enqueueDownlink() { return { id: 'bounded-close-q1' }; } },
    now: '2026-10-18T10:00:00.000Z', trustedContext: controlledRuntime([Date.parse('2026-10-18T10:00:00.000Z')]),
  });
  const boundedCall = await fixture.db.get('SELECT transport_json FROM valve_actuation_expectations WHERE command_id=?', ['bounded-close-before-claim']);
  const boundedState = JSON.parse(boundedCall.transport_json);
  assert.equal(boundedState.explicit_expiry_at, '2026-10-18T10:10:00.000Z');
  assert.equal(boundedState.effect_snapshot.queue_expires_at, '2026-10-18T10:10:00.000Z');
  assert.equal(boundedState.effect_snapshot.expires_at, boundedState.effect_snapshot.queue_expires_at);
  const row = await fixture.db.get('SELECT expectation_id, transport_json FROM valve_actuation_expectations WHERE command_id=?', ['bounded-close-before-claim']);
  const transport = JSON.parse(row.transport_json);
  delete transport.attempted_at;
  delete transport.attempt_trusted_at;
  delete transport.attempt_receipt;
  await fixture.db.run('UPDATE valve_actuation_expectations SET transport_json=?, reconciliation_state=? WHERE expectation_id=?', [JSON.stringify(transport), 'PENDING_OBSERVATION', row.expectation_id]);
  const observed = await dispatch.observeClosedEvidence({
    db: fixture.db, deviceEui: EUI, observedState: 'CLOSED', observedAt: '2026-10-18T10:01:00.000Z',
    runtimeContext: controlledRuntime([Date.parse('2026-10-18T10:02:00.000Z')]),
  });
  assert.equal(observed.quiesced.length, 0);
  const after = await fixture.db.get('SELECT observed_close_at, reconciliation_state FROM valve_actuation_expectations WHERE expectation_id=?', [row.expectation_id]);
  assert.equal(after.observed_close_at, null);
  assert.equal(after.reconciliation_state, 'PENDING_OBSERVATION');
  fixture.cleanup();
});
