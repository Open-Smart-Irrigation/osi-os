'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validatePolicyInput, validateScheduleSet, computeOccurrenceBounds, durationFor, commissionedChannels, minutesByLocalDay } = require('./model');

const source = { device_eui: '0016C001F1000002', channel: 'vwc_1' };

test('policy validation normalizes the default observation window and typed condition', () => {
  const result = validatePolicyInput({
    condition: { kind: 'VWC', threshold_percent: 22, sources: [source] },
    timezone: 'Europe/Zurich',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.observation_window_minutes, 60);
  assert.deepEqual(result.value.condition, { kind: 'VWC', threshold_percent: 22, sources: [source] });
});

test('policy validation requires a valid explicit IANA timezone and normalizes delivery settings', () => {
  const base = { condition: { kind: 'VWC', threshold_percent: 22, sources: [source] } };
  assert.equal(validatePolicyInput(base).ok, false);
  assert.equal(validatePolicyInput({ ...base, timezone: 'Not/AZone' }).ok, false);
  const result = validatePolicyInput({ ...base, timezone: 'Europe/Zurich', delivery_settings: {
    a840410000000001: { delivery_interval_minutes: 15 },
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.delivery_settings, {
    A840410000000001: { delivery_interval_minutes: 15 },
  });
  assert.equal(validatePolicyInput({ ...base, timezone: 'UTC', delivery_settings: {
    A840410000000001: { delivery_interval_minutes: 0 },
  } }).ok, false);
  assert.equal(validatePolicyInput({ ...base, timezone: 'UTC', delivery_settings: {
    A840410000000001: { delivery_interval_minutes: 10, extra: true },
  } }).ok, false);
});

const weekly = (overrides = {}) => ({
  schedule_uuid: 's-1', device_eui: 'A840410000000001', kind: 'WEEKLY',
  start_time: '06:00', weekdays_mask: 127, duration_minutes: 30,
  timezone: 'Europe/Zurich', enabled: 1, deleted_at: null,
  effective_from: '2026-01-01T00:00:00Z', ...overrides,
});

test('schedule validation requires an explicit deterministic reference', () => {
  const result = validateScheduleSet({ timezone: 'UTC', max_daily_minutes: 240, min_interval_minutes: 60, condition: { kind: 'SWT', threshold_kpa: 30, sources: [source] } }, [weekly({ timezone: 'UTC' })]);
  assert.equal(result.ok, false);
  assert.equal(result.details.reasons[0].code, 'invalid_reference_at');
});

test('actual occurrence bounds are cheap, typed, and half-open at exact midnight', () => {
  const exact = computeOccurrenceBounds({
    dueAt: '2026-01-04T23:00:00.000Z', nextDueAt: '2026-01-05T00:30:00.000Z',
    maxDurationMinutes: 29, gapMinutes: 0, deliveryIntervalMinutes: 10, timezone: 'UTC',
  });
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.value.local_days, ['2026-01-04']);
  assert.equal(computeOccurrenceBounds({ dueAt: 'bad', maxDurationMinutes: 30, timezone: 'UTC' }).ok, false);
  assert.equal(computeOccurrenceBounds({ dueAt: '2026-01-04T23:20:00Z', nextDueAt: '2026-01-05T00:00:00Z', maxDurationMinutes: 30, gapMinutes: 0, deliveryIntervalMinutes: 10, timezone: 'UTC' }).error, 'delivery_allowance');
});

test('actual occurrence bounds use a late dispatch start for local-day charging without extending expiry', () => {
  const result = computeOccurrenceBounds({
    dueAt: '2026-01-04T23:50:00Z', nextDueAt: '2026-01-06T23:50:00Z',
    reservationStartAt: '2026-01-05T00:10:00Z', maxDurationMinutes: 30,
    gapMinutes: 0, deliveryIntervalMinutes: 10, timezone: 'UTC',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.expiryAt, '2026-01-05T00:21:00.000Z');
  assert.equal(result.value.reservation_start_at, '2026-01-05T00:10:00.000Z');
  assert.deepEqual(result.value.local_days, ['2026-01-05']);
});

test('qualified occurrence bounds keep physical deadline separate from queue cutoff', () => {
  const result = computeOccurrenceBounds({
    dueAt: '2026-10-18T10:00:00.000Z', nextDueAt: '2026-10-19T10:00:00.000Z',
    maxDurationMinutes: 5, gapMinutes: 2, deliveryIntervalMinutes: 10,
    qualificationMarginSeconds: 5, timezone: 'UTC',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.latest_physical_start_at, '2026-10-18T10:31:00.000Z');
  assert.equal(result.value.queue_expires_at, '2026-10-18T10:30:55.000Z');
  assert.equal(result.value.future_effect_end, '2026-10-18T10:36:00.000Z');
  assert.equal(result.value.reservation_end_at, '2026-10-18T10:36:00.000Z');
});

test('observed accounting splits second-bearing midnight spans by local calendar day', () => {
  assert.deepEqual(minutesByLocalDay(Date.parse('2026-10-17T23:59:30.000Z'), Date.parse('2026-10-18T00:00:30.000Z'), 'UTC'), {
    '2026-10-17': 0.5,
    '2026-10-18': 0.5,
  });
  assert.deepEqual(minutesByLocalDay(Date.parse('2026-10-18T06:59:30.000Z'), Date.parse('2026-10-18T07:00:30.000Z'), 'America/Los_Angeles'), {
    '2026-10-17': 0.5,
    '2026-10-18': 0.5,
  });
});

test('invalid IANA schedule timezone returns 422 with validation bounds', () => {
  const result = validateScheduleSet({ timezone: 'Not/AZone', max_daily_minutes: 240, min_interval_minutes: 0, validation_reference_at: '2026-01-01T00:00:00Z', condition: { kind: 'SWT', threshold_kpa: 30, sources: [source] } }, [weekly({ timezone: 'Not/AZone' })]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.details.reasons[0].code, 'invalid_timezone');
  assert.equal(result.details.validation_bounds.horizon_days, 400);
});

test('schedule validation checks whole weekly sets, timezone, gap, budget, and adaptive maximum', () => {
  const policy = {
    timezone: 'Europe/Zurich', max_daily_minutes: 240, min_interval_minutes: 60,
    condition: { kind: 'DENDRO', response_mode: 'proportional', minimum_stress: 'mild' },
    validation_reference_at: '2026-01-01T00:00:00Z',
    delivery_settings: { A840410000000001: { delivery_interval_minutes: 10 } },
  };
  const result = validateScheduleSet(policy, [
    weekly({ schedule_uuid: 's-1', start_time: '06:00', duration_minutes: 180 }),
    weekly({ schedule_uuid: 's-2', start_time: '10:00', duration_minutes: 180 }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.deepEqual(result.details.affected_schedule_ids.sort(), ['s-1', 's-2']);
  assert.ok(result.details.reasons.some((entry) => entry.code === 'daily_budget'));
  assert.ok(result.details.reasons.some((entry) => entry.code === 'minimum_gap'));
  assert.ok(result.details.reasons.some((entry) => entry.code === 'maximum_duration'));
  assert.equal(validateScheduleSet({ ...policy, timezone: 'UTC' }, [weekly()]).details.reasons[0].code, 'timezone_mismatch');
  assert.equal(validateScheduleSet({ ...policy, max_daily_minutes: 1440, min_interval_minutes: 0 }, [
    weekly({ start_time: '23:30', duration_minutes: 30 }),
  ]).ok, true);
  assert.equal(validateScheduleSet(policy, [weekly({ schedule_uuid: 's-1' }), weekly({ schedule_uuid: 's-1' })]).details.reasons[0].code, 'duplicate_schedule');
});

test('schedule feasibility resolves DST instants and reserves delivery allowance into the next local day', () => {
  const base = {
    timezone: 'Europe/Zurich', max_daily_minutes: 240, min_interval_minutes: 60,
    condition: { kind: 'SWT', threshold_kpa: 30, sources: [source] }, delivery_settings: {},
  };
  const dst = validateScheduleSet(base, [
    weekly({ schedule_uuid: 'dst-1', start_time: '01:30', weekdays_mask: 1, duration_minutes: 30 }),
    weekly({ schedule_uuid: 'dst-2', start_time: '04:00', weekdays_mask: 1, duration_minutes: 30 }),
  ], { referenceAt: '2026-03-01T00:00:00Z' });
  assert.equal(dst.ok, false);
  assert.ok(dst.details.reasons.some((reason) => reason.code === 'delivery_allowance'));

  const midnight = validateScheduleSet({ ...base, timezone: 'UTC', max_daily_minutes: 60, min_interval_minutes: 0 }, [
    weekly({ schedule_uuid: 'midnight-1', start_time: '23:20', weekdays_mask: 1, duration_minutes: 30, timezone: 'UTC' }),
    weekly({ schedule_uuid: 'midnight-2', start_time: '01:00', weekdays_mask: 2, duration_minutes: 40, timezone: 'UTC' }),
  ], { referenceAt: '2026-01-01T00:00:00Z' });
  assert.equal(midnight.ok, false);
  assert.ok(midnight.details.reasons.some((reason) => reason.code === 'daily_budget'));
  assert.equal(midnight.details.validation_bounds.horizon_days, 400);

  const exactMidnight = validateScheduleSet({ ...base, timezone: 'UTC', max_daily_minutes: 50, min_interval_minutes: 0 }, [
    weekly({ schedule_uuid: 'exact-1', start_time: '23:00', weekdays_mask: 1, duration_minutes: 29, timezone: 'UTC' }),
    weekly({ schedule_uuid: 'exact-2', start_time: '00:30', weekdays_mask: 2, duration_minutes: 30, timezone: 'UTC' }),
  ], { referenceAt: '2026-01-01T00:00:00Z' });
  assert.equal(exactMidnight.ok, true);
});

test('schedule feasibility exposes deterministic bounds and accepts exact resolved limits', () => {
  const result = validateScheduleSet({
    timezone: 'UTC', max_daily_minutes: 240, min_interval_minutes: 60,
    condition: { kind: 'SWT', threshold_kpa: 30, sources: [source] }, delivery_settings: {},
  }, [
    weekly({ schedule_uuid: 'limit-1', start_time: '06:00', weekdays_mask: 1, duration_minutes: 30, timezone: 'UTC' }),
    weekly({ schedule_uuid: 'limit-2', start_time: '08:01', weekdays_mask: 1, duration_minutes: 30, timezone: 'UTC' }),
  ], { referenceAt: '2026-01-01T00:00:00Z' });
  assert.equal(result.ok, true);
  assert.equal(result.value.validation_bounds.horizon_days, 400);
  assert.equal(result.value.validation_bounds.reference_at, '2026-01-01T00:00:00.000Z');
  assert.ok(result.value.resolved_bounds.some((bound) => bound.delivery_allowance_minutes === 31));
});

test('policy validation rejects duplicate, malformed, and out-of-range conditions', () => {
  for (const condition of [
    { kind: 'SWT', threshold_kpa: 0, sources: [source] },
    { kind: 'SWT', threshold_kpa: 301, sources: [source] },
    { kind: 'VWC', threshold_percent: Number.NaN, sources: [source] },
    { kind: 'VWC', threshold_percent: 22, sources: [source, source] },
    { kind: 'DENDRO', minimum_stress: 'none', response_mode: 'fixed', sources: [] },
  ]) assert.equal(validatePolicyInput({ condition }).ok, false);
  assert.equal(validatePolicyInput({ condition: { kind: 'VWC', threshold_percent: 22, sources: [source] }, observation_window_minutes: 1441 }).ok, false);
});

test('durationFor applies fixed and proportional actions, rounds once, and caps possible output', () => {
  const fixed = { kind: 'DENDRO', minimum_stress: 'mild', response_mode: 'fixed' };
  const proportional = { ...fixed, response_mode: 'proportional' };
  assert.equal(durationFor(fixed, 10, 'increase_20'), 10);
  assert.equal(durationFor({ kind: 'SWT', threshold_kpa: 30, sources: [] }, 15), 15);
  assert.equal(durationFor({ kind: 'VWC', threshold_percent: 22, sources: [] }, 15), 15);
  assert.equal(durationFor(proportional, 11, 'increase_20'), 13);
  assert.equal(durationFor(proportional, 1, 'decrease_20'), 1);
  assert.throws(() => durationFor(proportional, 0, 'maintain'), /1 to 240/);
  assert.throws(() => durationFor(proportional, 241, 'maintain'), /1 to 240/);
  assert.throws(() => durationFor(proportional, 10.5, 'maintain'), /1 to 240/);
  assert.throws(() => durationFor(proportional, 161, 'maintain'), /240/);
  assert.throws(() => durationFor(proportional, 10, 'unknown'), /action/);
});

test('commissionedChannels requires the explicit resolver proof for each SDI12 profile', () => {
  const generic = { type_id: 'DRAGINO_SDI12', sdi12_probe_profile: 'GENERIC_VWC', sdi12_probe_status: 'manual', sdi12_value_count: 2 };
  assert.deepEqual(commissionedChannels(generic), ['vwc_1', 'vwc_2']);
  assert.deepEqual(commissionedChannels({ ...generic, sdi12_value_count: null }), []);
  assert.deepEqual(commissionedChannels({ ...generic, sdi12_value_count: 9 }), []);
  assert.deepEqual(commissionedChannels({ ...generic, sdi12_probe_status: 'pending_identify' }), []);
  assert.deepEqual(commissionedChannels({ ...generic, sdi12_probe_profile: 'IMKO_PICO64' }), []);
  const sentek = {
    type_id: 'DRAGINO_SDI12', sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_probe_status: 'manual',
    sdi12_channel_layout_json: JSON.stringify({ version: 1, address: '0', sensors: [
      { channel: 2, depth_cm: 30, response_position: 1, type: 'ENVIROSCAN' },
    ] }),
  };
  assert.deepEqual(commissionedChannels(sentek), ['vwc_2']);
  assert.deepEqual(commissionedChannels({ ...sentek, sdi12_channel_layout_json: null }), []);
});
