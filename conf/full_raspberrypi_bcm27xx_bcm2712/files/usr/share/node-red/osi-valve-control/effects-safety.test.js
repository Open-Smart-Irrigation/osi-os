'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const effects = require('./effects');
const { runtimeClockStatus } = require('../osi-irrigation-policy/clock');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const frame = { fPort: 2, data: b64([0x41, 1]), confirmed: false, encrypted: false,
  provenance: { source: 'local_encoder', encoder: 'strega-v1', build: 'fixture-1' } };
const provider = () => ({ qualified: true, identity: 'fixture/gen1', margin_seconds: 5 });
const clockOptions = { fs: { readFileSync(path) {
  if (path.endsWith('.rejected.json') || path.includes('rejection') || path.includes('fallback')) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
  throw new Error(`unexpected read ${path}`);
} }, bootId: 'boot-a', uptime: 6050000, now: Date.parse('2026-10-18T10:40:00.000Z'),
marker: { boot_id: 'boot-a', epoch_ms: Date.parse('2026-10-18T09:00:00.000Z'), uptime_ms: 50000, stratum: 2 },
markerPath: '/tmp/effects-safety-marker', rejectionPath: '/tmp/effects-safety-rejection', fallbackPath: '/tmp/effects-safety-fallback' };

function matchingClockOptions(runtimeIso, markerIso, uptime, runtimeUptime, suffix = 'matching') {
  return { fs: clockOptions.fs, bootId: `boot-${suffix}`, uptime: runtimeUptime, now: Date.parse(runtimeIso),
    marker: { boot_id: `boot-${suffix}`, epoch_ms: Date.parse(markerIso), uptime_ms: uptime, stratum: 2 },
    markerPath: `/tmp/effects-safety-${suffix}-marker`, rejectionPath: `/tmp/effects-safety-${suffix}-rejection`,
    fallbackPath: `/tmp/effects-safety-${suffix}-fallback` };
}

test('a snapshot includes provenance, device context, and equations before release', () => {
  const snapshot = effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T10:00:00.000Z', device_eui: '0016C001F1000001',
    qualificationProvider: provider, minimum_gap_minutes: 2 });
  assert.deepEqual(snapshot.provenance, frame.provenance);
  assert.equal(snapshot.device_eui, '0016C001F1000001');
  assert.equal(snapshot.qualification_context.device_eui, '0016C001F1000001');
  assert.throws(() => effects.assertSnapshotMatchesFrame({ ...snapshot, future_effect_end: '2026-10-18T10:31:00.000Z' }, frame), /snapshot/);
  assert.throws(() => effects.assertSnapshotMatchesFrame(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'data')), frame), /snapshot/);
});

test('caller trusted clock hooks and close-only evidence cannot release a timed open', () => {
  const snapshot = effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T10:00:00.000Z', device_eui: '0016C001F1000001', qualificationProvider: provider });
  const now = '2026-10-18T10:31:00.000Z';
  const earlyClock = matchingClockOptions(now, '2026-10-18T09:00:00.000Z', 50000, 5510000, 'early');
  assert.equal(effects.canReleaseByHorizon(snapshot, { now, clock: () => ({ trusted: true }), clockOptions: earlyClock, qualificationProvider: provider }), false);
  assert.equal(effects.canReleaseByHorizon(snapshot, { now: '2026-10-18T10:40:00.000Z', clock: () => ({ trusted: true }), clockOptions: earlyClock, qualificationProvider: provider }), false);
  assert.equal(effects.canReleaseByHorizon(snapshot, { now: '2026-10-18T10:40:00.000Z', clock: () => ({ trusted: false }), clockOptions, qualificationProvider: provider }), true);
  assert.equal(effects.observationState(snapshot, { now, attempt_at: snapshot.anchor_at,
    observed_close_at: '2026-10-18T10:01:00.000Z', clockOptions: earlyClock, qualificationProvider: provider }).blocks, true);
});

test('malformed captured frames remain opaque and cannot qualify', () => {
  const snapshot = effects.buildEffectSnapshot({ frame: { fPort: 2, data: 'not-base64', confirmed: true, encrypted: true }, anchor_at: '2026-10-18T10:00:00.000Z' });
  assert.equal(snapshot.effect_class, effects.EFFECTS.OPAQUE);
  assert.doesNotThrow(() => effects.validateEffectSnapshot(snapshot));
  assert.equal(effects.effectBlocks(snapshot, { now: '2026-10-18T12:00:00.000Z' }), true);
});

test('only an owner-specific OPEN then CLOSE pair settles before horizon', () => {
  const snapshot = effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T10:00:00.000Z', qualificationProvider: provider });
  const common = { now: '2026-10-18T10:05:00.000Z', attempt_at: '2026-10-18T10:01:00.000Z', qualificationProvider: provider,
    clockOptions: matchingClockOptions('2026-10-18T10:05:00.000Z', '2026-10-18T09:00:00.000Z', 50000, 3950000, 'observation') };
  assert.equal(effects.observationState(snapshot, { ...common, observed_close_at: '2026-10-18T10:02:00.000Z' }).blocks, true);
  assert.equal(effects.observationState(snapshot, { ...common, observed_open_at: '2026-10-18T10:00:30.000Z', observed_close_at: '2026-10-18T10:02:00.000Z' }).blocks, true);
  assert.equal(effects.observationState(snapshot, { ...common, observed_open_at: '2026-10-18T10:01:00.000Z', observed_close_at: '2026-10-18T10:02:00.000Z' }).blocks, false);
  assert.equal(effects.observationState(snapshot, { ...common, current_state: 'OPEN', observed_open_at: '2026-10-18T10:01:00.000Z', observed_close_at: '2026-10-18T10:02:00.000Z' }).blocks, true);
});

test('reclassification and direct observation use fail-closed validation', () => {
  const snapshot = effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T10:00:00.000Z' });
  const relabeled = { ...snapshot, effect_class: effects.EFFECTS.NON_ACTUATING, encoded_duration_seconds: null,
    future_effect_end: snapshot.latest_physical_start_at, exclusion_end_at: snapshot.latest_physical_start_at,
    reservation_end_at: snapshot.latest_physical_start_at };
  assert.throws(() => effects.validateEffectSnapshot(relabeled), /snapshot/);
  assert.equal(effects.effectBlocks(relabeled, {}), true);
  assert.equal(effects.observationState({ effect_class: effects.EFFECTS.NON_ACTUATING }, {}).blocks, true);
});

test('clock lower bounds retain immutable evidence and reject reboot, jump, and persistence failure', () => {
  const snapshot = effects.buildEffectSnapshot({ frame, anchor_at: '2026-10-18T10:00:00.000Z', qualificationProvider: provider });
  const lower = matchingClockOptions('2026-10-18T09:01:00.000Z', '2026-10-18T09:00:00.000Z', 50000, 110000, 'lower');
  assert.equal(effects.canReleaseByHorizon(snapshot, { now: '2026-10-18T10:40:00.000Z', clockOptions: lower, qualificationProvider: provider }), false);
  const reboot = { ...lower, bootId: 'boot-other', marker: { ...lower.marker, boot_id: 'boot-lower' } };
  assert.equal(effects.canReleaseByHorizon(snapshot, { now: '2026-10-18T10:40:00.000Z', clockOptions: reboot, qualificationProvider: provider }), false);
  const jump = matchingClockOptions('2026-10-18T10:01:00.000Z', '2026-10-18T09:00:00.000Z', 50000, 200000, 'jump');
  assert.equal(effects.canReleaseByHorizon(snapshot, { now: '2026-10-18T10:40:00.000Z', clockOptions: jump, qualificationProvider: provider }), false);
});

test('runtime clock persists a failure and trusts only after durable resynchronization', () => {
  const files = new Map();
  const fs = {
    failWrites: true,
    readFileSync(file) {
      if (files.has(file)) return files.get(file);
      const error = new Error('missing'); error.code = 'ENOENT'; throw error;
    },
    mkdirSync() {},
    writeFileSync(file, data) { if (this.failWrites) throw new Error('read-only'); files.set(file, data); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync(file) { if (!files.delete(file)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } },
  };
  const markerPath = '/tmp/effects-clock-round3-marker';
  const rejectionPath = '/tmp/effects-clock-round3-rejection';
  const fallbackPath = '/tmp/effects-clock-round3-fallback';
  const invalidMarker = { boot_id: 'boot-round3', epoch_ms: Date.parse('2026-10-18T10:00:00.000Z'), uptime_ms: 50000, stratum: 2 };
  const invalid = runtimeClockStatus({ fs, bootId: 'boot-round3', uptime: 49000, now: Date.parse('2026-10-18T09:59:00.000Z'), marker: invalidMarker, markerPath, rejectionPath, fallbackPath });
  assert.equal(invalid.trusted, false);
  assert.equal(invalid.reason, 'clock_untrusted_persistence');
  fs.failWrites = false;
  const resynced = runtimeClockStatus({ fs, bootId: 'boot-round3', uptime: 2390000, now: Date.parse('2026-10-18T10:40:00.000Z'),
    marker: { ...invalidMarker, epoch_ms: Date.parse('2026-10-18T10:01:00.000Z') }, markerPath, rejectionPath, fallbackPath });
  assert.equal(resynced.trusted, true);
  assert.equal(resynced.reason, 'trusted');
});

test('qualified CLOSE releases at its exact deadline only with current qualification', () => {
  const close = effects.buildEffectSnapshot({ frame: { fPort: 1, data: b64([0x30]), confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder' } }, anchor_at: '2026-10-18T10:00:00.000Z', qualificationProvider: provider });
  const runtimeAt = (at, suffix) => ({ now: at, clockOptions: matchingClockOptions(at, '2026-10-18T09:00:00.000Z', 50000,
    50000 + Date.parse(at) - Date.parse('2026-10-18T09:00:00.000Z'), suffix), qualificationProvider: provider });
  const before = new Date(Date.parse(close.exclusion_end_at) - 1).toISOString();
  const exact = close.exclusion_end_at;
  const after = new Date(Date.parse(close.exclusion_end_at) + 1).toISOString();
  assert.equal(effects.canReleaseByHorizon(close, runtimeAt(before, 'close-before')), false);
  assert.equal(effects.canReleaseByHorizon(close, runtimeAt(exact, 'close-exact')), true);
  assert.equal(effects.canReleaseByHorizon(close, runtimeAt(after, 'close-after')), true);
  const options = runtimeAt(exact, 'close-current');
  assert.equal(effects.canReleaseByHorizon(close, { ...options, qualificationProvider: () => ({ qualified: false }) }), false);
  assert.equal(effects.canReleaseByHorizon(close, { ...options, qualificationProvider: () => ({ qualified: true, identity: 'fixture/gen1', margin_seconds: 4 }) }), true);
  assert.equal(effects.canReleaseByHorizon(close, { ...options, qualificationProvider: () => ({ qualified: true, identity: 'other', margin_seconds: 5 }) }), false);
  assert.equal(effects.canReleaseByHorizon(close, { ...options, qualificationProvider: () => ({ qualified: true, identity: 'fixture/gen1', margin_seconds: 6 }) }), false);
});
