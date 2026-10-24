'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const effects = require('./effects');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('classifies only exact locally-proven STREGA frames and keeps captures immutable', () => {
  const frame = { fPort: 2, data: b64([0x41, 7]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
  const classified = effects.classifyEffect(frame);
  assert.equal(classified.effect_class, effects.EFFECTS.SELF_CLOSING_OPEN);
  assert.equal(classified.encoded_duration_seconds, 420);
  frame.data = b64([0x41, 1]);
  frame.confirmed = true;
  assert.equal(classified.encoded_duration_seconds, 420);
  assert.equal(effects.classifyEffect({ ...frame, provenance: { source: 'queue_capture' } }).effect_class, effects.EFFECTS.OPAQUE);
  assert.equal(effects.classifyEffect({ ...frame, encrypted: true }).effect_class, effects.EFFECTS.OPAQUE);
  assert.equal(effects.classifyEffect({ fPort: 1, data: b64([0x31]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder' } }).effect_class, effects.EFFECTS.MAY_END_OPEN);
  assert.equal(effects.classifyEffect({ fPort: 27, data: b64([0x31, 50]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder' } }).effect_class, effects.EFFECTS.MAY_END_OPEN);
  assert.equal(effects.classifyEffect({ fPort: 11, data: b64([0x80, 15]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder' } }).effect_class, effects.EFFECTS.NON_ACTUATING);
});

test('captures the delivery allowance and physical bounds without trusting caller qualification', () => {
  const snapshot = effects.buildEffectSnapshot({
    frame: { fPort: 2, data: b64([0x41, 1]), confirmed: false, encrypted: false,
      provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    anchor_at: '2026-10-18T10:00:00.000Z', interval_minutes: 10,
    qualificationProvider: () => ({ qualified: true, identity: 'fixture/gen1', margin_seconds: 5 }),
    minimum_gap_minutes: 3,
  });
  assert.equal(snapshot.interval_minutes, 10);
  assert.equal(snapshot.interval_source, 'documented_default');
  assert.equal(snapshot.queue_expires_at, '2026-10-18T10:30:55.000Z');
  assert.equal(snapshot.latest_physical_start_at, '2026-10-18T10:31:00.000Z');
  assert.equal(snapshot.future_effect_end, '2026-10-18T10:32:00.000Z');
  assert.equal(snapshot.exclusion_end_at, '2026-10-18T10:35:00.000Z');
  assert.equal(snapshot.qualification.identity, 'fixture/gen1');
});

test('requires the strict immutable expiry shape for bounded and unbounded snapshots', () => {
  const open = effects.buildEffectSnapshot({
    frame: { fPort: 2, data: b64([0x41, 1]), confirmed: false, encrypted: false,
      provenance: { source: 'local_encoder', encoder: 'strega-v1' } },
    anchor_at: '2026-10-18T10:00:00.000Z', explicit_expiry_at: '2026-10-18T10:10:00.000Z',
  });
  assert.doesNotThrow(() => effects.validateEffectSnapshot(open));
  const missingCalculated = { ...open };
  delete missingCalculated.calculated_queue_expires_at;
  assert.throws(() => effects.validateEffectSnapshot(missingCalculated), /effect snapshot/);
  const missingExplicit = { ...open };
  delete missingExplicit.explicit_expiry_at;
  assert.throws(() => effects.validateEffectSnapshot(missingExplicit), /effect snapshot/);
  const safe = effects.buildUnboundedSafeCloseSnapshot({
    frame: { fPort: 1, data: b64([0x30]), confirmed: false, encrypted: false,
      provenance: { source: 'local_encoder' } }, device_eui: '0016C001F1000001',
    reservation_receipt: { boot_id: 'shape-boot', uptime_ms: 10 },
  });
  assert.doesNotThrow(() => effects.validateEffectSnapshot(safe));
  assert.throws(() => effects.validateEffectSnapshot({ ...safe, explicit_expiry_at: '2026-10-18T10:10:00.000Z' }));
  const missingSafeCalculated = { ...safe };
  delete missingSafeCalculated.calculated_queue_expires_at;
  assert.throws(() => effects.validateEffectSnapshot(missingSafeCalculated));
  const missingSafeExplicit = { ...safe };
  delete missingSafeExplicit.explicit_expiry_at;
  assert.throws(() => effects.validateEffectSnapshot(missingSafeExplicit));
});

test('production qualification defaults false and release requires current validation', () => {
  const frame = { fPort: 2, data: b64([0x41, 1]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
  const input = effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T10:00:00.000Z' });
  const marker = { boot_id: 'boot-a', epoch_ms: Date.parse('2026-10-18T09:00:00.000Z'), uptime_ms: 50000, stratum: 2 };
  const fs = { readFileSync(path) { if (path.endsWith('.rejected.json') || path.includes('rejection')) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } throw new Error(`unexpected read ${path}`); } };
  const clockOptions = { fs, bootId: 'boot-a', uptime: 6050000, now: Date.parse('2026-10-18T10:40:00.000Z'), marker,
    markerPath: '/tmp/effects-clock-marker', rejectionPath: '/tmp/effects-clock-rejection', fallbackPath: '/tmp/effects-clock-rejection-fallback' };
  assert.equal(effects.canReleaseByHorizon(input, { now: '2026-10-18T10:32:00.000Z', clockOptions }), false);
  const qualified = effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T10:00:00.000Z',
    qualificationProvider: () => ({ qualified: true, identity: 'x', margin_seconds: 5 }) });
  const provider = () => ({ qualified: true, identity: 'x', margin_seconds: 5 });
  assert.equal(effects.canReleaseByHorizon(qualified, { now: '2026-10-18T10:32:00.000Z', clockOptions, qualificationProvider: provider }), true);
  assert.equal(effects.canReleaseByHorizon(qualified, { now: '2026-10-18T10:32:00.000Z', clockOptions: { ...clockOptions, bootId: 'boot-b' }, qualificationProvider: provider }), false);
  assert.equal(effects.canReleaseByHorizon(qualified, { now: '2026-10-18T10:32:00.000Z', clockOptions, qualificationProvider: () => ({ qualified: true, identity: 'other', margin_seconds: 5 }) }), false);
});

test('effect matrix keeps observation uncertainty and CLOSE ownership scoped', () => {
  const timed = effects.buildEffectSnapshot({ frame: { fPort: 2, data: b64([0x41, 1]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder', encoder: 'strega-v1' } }, anchor_at: '2026-10-18T10:00:00.000Z' });
  assert.equal(effects.effectBlocks(timed, { now: '2026-10-18T10:40:00.000Z', current_state: 'OPEN' }), true);
  assert.equal(effects.effectBlocks(timed, { now: '2026-10-18T10:40:00.000Z' }), true);
  assert.equal(effects.observationState({ effect_class: effects.EFFECTS.MAY_END_OPEN }).reason, 'invalid_snapshot');
  assert.equal(effects.effectBlocks(effects.buildEffectSnapshot({ frame: { fPort: 9, data: b64([0x01]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder' } }, anchor_at: '2026-10-18T10:00:00.000Z' }), {}), false);
  const close = effects.buildEffectSnapshot({ frame: { fPort: 1, data: b64([0x30]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder' } }, anchor_at: '2026-10-18T10:00:00.000Z' });
  assert.equal(effects.observationState(close, {
    current_state: 'CLOSED', current_state_at: '2026-10-18T10:01:00.000Z', attempt_at: '2026-10-18T10:00:00.000Z', observed_close_at: '2026-10-18T10:01:00.000Z' }).blocks, false);
  assert.equal(effects.observationState(close, {
    current_state: 'CLOSED', current_state_at: '2026-10-18T09:59:00.000Z', attempt_at: '2026-10-18T10:00:00.000Z', observed_close_at: '2026-10-18T09:59:00.000Z' }).blocks, true);
});

test('interval policy and exact encoded seconds survive anchor and frame changes', () => {
  const frame = { fPort: 2, data: b64([0x21, 7]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder', encoder: 'strega-v1' } };
  const snapshot = effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T23:30:00.000Z', device_eui: 'A',
    policy: { delivery_settings: { A: { delivery_interval_minutes: 15 } } }, minimum_gap_minutes: 2 });
  assert.equal(snapshot.interval_minutes, 15);
  assert.equal(snapshot.interval_source, 'policy');
  assert.equal(snapshot.encoded_duration_seconds, 7);
  assert.equal(snapshot.latest_physical_start_at, '2026-10-19T00:11:00.000Z');
  assert.equal(snapshot.future_effect_end, '2026-10-19T00:11:07.000Z');
  assert.throws(() => effects.assertSnapshotMatchesFrame(snapshot, { ...frame, data: b64([0x21, 8]) }), /effect snapshot/);
  assert.equal(effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T23:30:00.000Z', interval_minutes: 1 }).interval_source, 'documented_default');
  const close = effects.buildEffectSnapshot({ frame: { fPort: 1, data: b64([0x30]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder' } }, anchor_at: '2026-10-18T23:30:00.000Z', minimum_gap_minutes: 9 });
  assert.equal(close.minimum_gap_minutes, 0);
  assert.equal(close.exclusion_end_at, close.future_effect_end);
});
