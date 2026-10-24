'use strict';

const { getProfile, PROFILES, validateSentekLayout } = require('../osi-sdi12-normalize');
const { parseInstant } = require('./timestamps');
const { occurrencesBetween, localParts } = require('./occurrences');

const SWT_CHANNELS = new Set(['swt_1', 'swt_2', 'swt_3']);
const VWC_CHANNELS = new Set(Array.from({ length: 10 }, (_, i) => `vwc_${i + 1}`));
const SWT_ALIASES = new Map([['swt_wm1', 'swt_1'], ['swt_wm2', 'swt_2']]);
const STRESS_RANK = Object.freeze({ none: 0, mild: 1, moderate: 2, significant: 3, severe: 4 });
const ACTION_MULTIPLIERS = Object.freeze({
  decrease_20: 0.8,
  decrease_10: 0.9,
  maintain: 1,
  increase_10: 1.1,
  increase_20: 1.2,
  emergency_irrigate: 1.5,
});

function fail(error, details) {
  return { ok: false, status: 422, error, details: details || null };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeChannel(value) {
  const channel = String(value == null ? '' : value).trim().toLowerCase();
  return SWT_ALIASES.get(channel) || channel;
}

function normalizeSource(source, index, kind) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return fail('invalid_source', `sources[${index}] must be an object`);
  }
  const deviceEui = String(source.device_eui == null ? '' : source.device_eui).trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(deviceEui)) return fail('invalid_source_device', `sources[${index}].device_eui is invalid`);
  const channel = normalizeChannel(source.channel);
  const allowed = kind === 'SWT' ? SWT_CHANNELS : VWC_CHANNELS;
  if (!allowed.has(channel)) return fail('invalid_source_channel', `sources[${index}].channel is not allowed for ${kind}`);
  return { ok: true, value: { device_eui: deviceEui, channel } };
}

function validateCondition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_condition');
  const kind = String(input.kind || '').toUpperCase();
  if (!['SWT', 'VWC', 'DENDRO'].includes(kind)) return fail('invalid_condition_kind');

  if (kind === 'SWT' || kind === 'VWC') {
    const field = kind === 'SWT' ? 'threshold_kpa' : 'threshold_percent';
    const threshold = input[field];
    const maximum = kind === 'SWT' ? 300 : 100;
    const minimum = kind === 'SWT' ? 0 : 0;
    if (!finiteNumber(threshold) || threshold <= minimum || (kind === 'VWC' && threshold < minimum) || threshold > maximum) {
      if (kind === 'VWC' && finiteNumber(threshold) && threshold === 0) {
        // Zero is valid for VWC thresholds; a zero reading is also valid evidence.
      } else {
        return fail('invalid_threshold');
      }
    }
    if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 32) return fail('invalid_sources');
    const sources = [];
    const seen = new Set();
    for (let i = 0; i < input.sources.length; i += 1) {
      const result = normalizeSource(input.sources[i], i, kind);
      if (!result.ok) return result;
      const key = `${result.value.device_eui}:${result.value.channel}`;
      if (seen.has(key)) return fail('duplicate_source', key);
      seen.add(key);
      sources.push(result.value);
    }
    return { ok: true, value: kind === 'SWT'
      ? { kind, threshold_kpa: threshold, sources }
      : { kind, threshold_percent: threshold, sources } };
  }

  const minimumStress = String(input.minimum_stress || '').toLowerCase();
  const responseMode = String(input.response_mode || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(input, 'sources')) return fail('unexpected_sources');
  if (!Object.prototype.hasOwnProperty.call(STRESS_RANK, minimumStress) || minimumStress === 'none') return fail('invalid_minimum_stress');
  if (!['fixed', 'proportional'].includes(responseMode)) return fail('invalid_response_mode');
  return { ok: true, value: { kind, minimum_stress: minimumStress, response_mode: responseMode } };
}

function validatePolicyInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_policy');
  const condition = validateCondition(input.condition);
  if (!condition.ok) return condition;
  const rawWindow = input.observation_window_minutes == null ? 60 : input.observation_window_minutes;
  if (!Number.isInteger(rawWindow) || rawWindow < 1 || rawWindow > 1440) return fail('invalid_observation_window');
  let timezone;
  try {
    timezone = String(input.timezone == null ? '' : input.timezone).trim();
    if (!timezone) throw new RangeError('missing timezone');
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch (_) { return fail('invalid_timezone'); }
  let deliverySettings = {};
  if (input.delivery_settings !== undefined) {
    if (!input.delivery_settings || typeof input.delivery_settings !== 'object' || Array.isArray(input.delivery_settings)) return fail('invalid_delivery_settings');
    for (const [rawKey, rawValue] of Object.entries(input.delivery_settings)) {
      const key = String(rawKey).trim().toUpperCase();
      if (!/^[0-9A-F]{16}$/.test(key)) return fail('invalid_delivery_settings_key');
      if (deliverySettings[key]) return fail('duplicate_delivery_settings_key');
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue) || Object.keys(rawValue).some((k) => k !== 'delivery_interval_minutes')) return fail('invalid_delivery_settings_value');
      const interval = rawValue.delivery_interval_minutes;
      if (!Number.isInteger(interval) || interval < 1 || interval > 60) return fail('invalid_delivery_interval');
      deliverySettings[key] = { delivery_interval_minutes: interval };
    }
  }
  const value = { ...input, condition: condition.value, observation_window_minutes: rawWindow, timezone, delivery_settings: deliverySettings };
  return { ok: true, value };
}

function validTimezone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: String(value) }).format(); return true; } catch (_) { return false; }
}

function localDaysForInterval(startAt, endAt, timezone) {
  if (!(endAt > startAt)) return [];
  const start = localParts(new Date(startAt), timezone);
  const end = localParts(new Date(endAt - 1), timezone); // [start,end): midnight end belongs to the prior day.
  const days = [];
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const last = Date.UTC(end.year, end.month - 1, end.day);
  while (cursor.getTime() <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

// Returns observed watering minutes assigned to each local calendar day.
// The interval is bounded by one command duration and uses the same timezone
// conversion as occurrence bounds, including DST transitions.
function minutesByLocalDay(startAt, endAt, timezone) {
  if (!(endAt > startAt) || !validTimezone(timezone)) return {};
  const result = {};
  const localDayAt = (instant) => {
    const parts = localParts(new Date(instant), timezone);
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  };
  let cursor = startAt;
  while (cursor < endAt) {
    const next = Math.min(endAt, cursor + 60000);
    const day = localDayAt(cursor);
    const endDay = localDayAt(next - 1);
    let boundary = next;
    if (endDay !== day) {
      let low = cursor;
      let high = next;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (localDayAt(middle) === day) low = middle + 1;
        else high = middle;
      }
      boundary = low;
    }
    result[day] = (result[day] || 0) + (boundary - cursor) / 60000;
    cursor = boundary;
  }
  return Object.fromEntries(Object.entries(result).map(([day, minutes]) => [day, Number(minutes.toFixed(6))]));
}

function validationReference(policy, options) {
  const raw = options && options.referenceAt !== undefined ? options.referenceAt : policy && policy.validation_reference_at;
  if (raw == null) return null;
  const parsed = parseInstant(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function instantNumber(value) {
  const parsed = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : parseInstant(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validationBounds(reference, horizonDays, paddingDays) {
  if (!Number.isFinite(reference)) return null;
  return {
    reference_at: new Date(reference).toISOString(),
    from: new Date(reference - paddingDays * 86400000).toISOString(),
    to: new Date(reference + (horizonDays + paddingDays) * 86400000).toISOString(),
    horizon_days: horizonDays,
    padding_days: paddingDays,
  };
}

// Cheap runtime seam shared with the save-time validator. The returned local_days
// are the calendar dates touched by the half-open reservation [dueAt,endAt).
function computeOccurrenceBounds(input = {}) {
  const due = instantNumber(input.dueAt);
  const nextDue = input.nextDueAt == null ? null : instantNumber(input.nextDueAt);
  const maxDuration = Number(input.maxDurationMinutes ?? input.max_duration_minutes);
  const gap = Number(input.gapMinutes ?? input.minimumGapMinutes ?? input.gap_minutes ?? input.minimum_gap_minutes);
  const interval = Number(input.deliveryIntervalMinutes ?? input.delivery_interval_minutes);
  const qualificationMarginSeconds = Number(input.qualificationMarginSeconds ?? input.qualification_margin_seconds ?? 0);
  const timezone = String(input.timezone || '');
  const requestedStart = input.reservationStartAt ?? input.reservation_start_at ?? input.earliestStartAt ?? input.earliest_start_at;
  const invalid = [];
  if (due == null) invalid.push('invalid_due_at');
  if (input.nextDueAt != null && nextDue == null) invalid.push('invalid_next_due_at');
  if (nextDue != null && due != null && nextDue <= due) invalid.push('next_due_not_after_due');
  if (!Number.isInteger(maxDuration) || maxDuration < 1 || maxDuration > 240) invalid.push('invalid_max_duration');
  if (!Number.isInteger(gap) || gap < 0 || gap > 1440) invalid.push('invalid_minimum_gap');
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) invalid.push('invalid_delivery_interval');
  if (!Number.isInteger(qualificationMarginSeconds) || qualificationMarginSeconds < 0 || qualificationMarginSeconds > 3600) invalid.push('invalid_qualification_margin');
  if (!validTimezone(timezone)) invalid.push('invalid_timezone');
  if (invalid.length) return { ok: false, status: 422, error: 'invalid_occurrence_bounds', details: { reasons: invalid } };

  const reservationStart = requestedStart == null ? due : instantNumber(requestedStart);
  if (reservationStart == null || reservationStart < due) {
    return { ok: false, status: 422, error: 'invalid_occurrence_bounds', details: { reasons: ['invalid_reservation_start_at'] } };
  }

  const allowance = 10 + 2 * interval + 1;
  const minimumGap = maxDuration + gap;
  const failures = [];
  const delta = nextDue == null ? null : nextDue - due;
  if (delta != null && delta < minimumGap * 60000) failures.push('minimum_gap');
  if (delta != null && delta < (minimumGap + allowance) * 60000) failures.push('delivery_allowance');
  const latestPhysicalStart = nextDue == null ? due + allowance * 60000 : Math.min(due + allowance * 60000, nextDue - minimumGap * 60000);
  const queueExpiry = latestPhysicalStart - qualificationMarginSeconds * 1000;
  const expiry = queueExpiry;
  const reservationEnd = latestPhysicalStart + maxDuration * 60000;
  const value = {
    dueAt: new Date(due).toISOString(),
    next_dueAt: nextDue == null ? null : new Date(nextDue).toISOString(),
    next_due_at: nextDue == null ? null : new Date(nextDue).toISOString(),
    expiryAt: new Date(expiry).toISOString(),
    queue_expires_at: new Date(expiry).toISOString(),
    latest_physical_start_at: new Date(latestPhysicalStart).toISOString(),
    future_effect_end: new Date(reservationEnd).toISOString(),
    delivery_allowance_minutes: allowance,
    max_duration_minutes: maxDuration,
    minimum_gap_minutes: gap,
    reservation_start_at: new Date(reservationStart).toISOString(),
    reservation_end_at: new Date(reservationEnd).toISOString(),
    local_days: localDaysForInterval(reservationStart, reservationEnd, timezone),
  };
  if (failures.length) return { ok: false, status: 422, error: failures[0], details: { reasons: failures, allowance_minutes: allowance, minimum_gap_minutes: gap }, value };
  return { ok: true, value };
}

function dedupeReasons(errors) {
  const seen = new Set();
  return errors.filter((reason) => {
    const ids = [...new Set(reason.schedule_ids || [])].sort().join(',');
    const key = [reason.code, ids, reason.allowance_minutes, reason.budget_minutes, reason.device_eui].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateScheduleSet(policy, schedules, options = {}) {
  const p = policy || {};
  const errors = [];
  const rows = (schedules || []).filter((s) => s && s.kind === 'WEEKLY' && Number(s.enabled) && !s.deleted_at);
  const ids = new Set();
  for (const s of schedules || []) {
    if (!s || !s.schedule_uuid) continue;
    if (ids.has(s.schedule_uuid)) errors.push({ code: 'duplicate_schedule', schedule_ids: [s.schedule_uuid] });
    ids.add(s.schedule_uuid);
  }
  const timezoneValid = validTimezone(p.timezone);
  if (!timezoneValid) errors.push({ code: 'invalid_timezone', schedule_ids: rows.map((s) => s.schedule_uuid) });
  const budget = p.max_daily_minutes == null ? 240 : p.max_daily_minutes;
  const gap = p.min_interval_minutes == null ? 60 : p.min_interval_minutes;
  if (!Number.isInteger(budget) || budget < 1 || budget > 1440) errors.push({ code: 'invalid_daily_budget', schedule_ids: rows.map((s) => s.schedule_uuid) });
  if (!Number.isInteger(gap) || gap < 0 || gap > 1440) errors.push({ code: 'invalid_minimum_gap', schedule_ids: rows.map((s) => s.schedule_uuid) });
  const settings = p.delivery_settings || {};
  const valves = new Set(rows.map((s) => String(s.device_eui || '').toUpperCase()));
  for (const key of Object.keys(settings)) if (!valves.has(String(key).toUpperCase())) errors.push({ code: 'unknown_delivery_valve', schedule_ids: rows.map((s) => s.schedule_uuid), device_eui: key });
  const byValve = new Map();
  for (const s of rows) {
    const id = s.schedule_uuid;
    const hm = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(s.start_time || '')) ? String(s.start_time).split(':').map(Number) : null;
    const duration = Number(s.duration_minutes);
    if (!hm) { errors.push({ code: 'invalid_start_time', schedule_ids: [id] }); continue; }
    if (!Number.isInteger(duration) || duration < 1 || duration > 240) { errors.push({ code: 'invalid_duration', schedule_ids: [id] }); continue; }
    if (String(s.timezone || '') !== String(p.timezone || '')) { errors.push({ code: 'timezone_mismatch', schedule_ids: [id] }); continue; }
    if (!Number.isInteger(Number(s.weekdays_mask)) || Number(s.weekdays_mask) < 1 || Number(s.weekdays_mask) > 127) { errors.push({ code: 'invalid_weekdays', schedule_ids: [id] }); continue; }
    const eui = String(s.device_eui || '').toUpperCase();
    if (!byValve.has(eui)) byValve.set(eui, []);
    const maxDuration = p.condition && String(p.condition.kind).toUpperCase() === 'DENDRO' && p.condition.response_mode === 'proportional' ? Math.ceil(duration * 1.5) : duration;
    if (maxDuration > 240) errors.push({ code: 'maximum_duration', schedule_ids: [id] });
    for (let day = 0; day < 7; day += 1) if ((Number(s.weekdays_mask) >> day) & 1) byValve.get(eui).push({ id, schedule: s, day, minute: hm[0] * 60 + hm[1], duration, maxDuration });
  }
  const reference = validationReference(p, options);
  if (reference == null) errors.push({ code: 'invalid_reference_at', schedule_ids: rows.map((s) => s.schedule_uuid) });
  const horizonDays = 400;
  const paddingDays = 8;
  const bounds = validationBounds(reference, horizonDays, paddingDays);
  const resolvedByValve = new Map();
  const resolvedBounds = [];
  if (reference != null && timezoneValid) {
    for (const [eui, entries] of byValve) {
      const resolved = [];
      const uniqueSchedules = [...new Map(entries.map((entry) => [entry.id, entry.schedule])).entries()];
      for (const [scheduleId, schedule] of uniqueSchedules) {
        const template = { ...schedule, effective_from: null };
        for (const occurrence of occurrencesBetween(template, bounds.from, bounds.to)) {
          const entry = entries.find((candidate) => candidate.id === scheduleId);
          resolved.push({ ...occurrence, max_duration_minutes: entry.maxDuration, schedule_uuid: scheduleId });
        }
      }
      resolved.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.schedule_uuid.localeCompare(b.schedule_uuid));
      resolvedByValve.set(eui, resolved);
    }
  }
  for (const [eui, entries] of byValve) {
    const intervalSetting = settings[eui] || settings[String(eui).toUpperCase()];
    const interval = intervalSetting && intervalSetting.delivery_interval_minutes || 10;
    const weeklyDays = Array.from({ length: 7 }, () => []);
    for (const entry of entries) weeklyDays[entry.day].push(entry);
    for (const dayEntries of weeklyDays) {
      if (dayEntries.length > 4) errors.push({ code: 'starts_per_day', schedule_ids: dayEntries.map((entry) => entry.id) });
      const seenMinutes = new Map();
      for (const entry of dayEntries) {
        if (seenMinutes.has(entry.minute)) errors.push({ code: 'duplicate_schedule', schedule_ids: [seenMinutes.get(entry.minute), entry.id] });
        seenMinutes.set(entry.minute, entry.id);
      }
    }
    const resolved = resolvedByValve.get(eui) || [];
    const byLocalDay = new Map();
    for (let i = 0; i < resolved.length; i += 1) {
      const current = resolved[i];
      const next = resolved[i + 1] || null;
      const result = computeOccurrenceBounds({ dueAt: current.dueAt, nextDueAt: next && next.dueAt, maxDurationMinutes: current.max_duration_minutes, gapMinutes: gap, deliveryIntervalMinutes: interval, timezone: p.timezone });
      const scheduleIds = [current.schedule_uuid, next && next.schedule_uuid].filter(Boolean);
      const due = Date.parse(current.dueAt);
      const nextDue = next ? Date.parse(next.dueAt) : null;
      const allowance = 10 + 2 * interval + 1;
      if (next && nextDue - due < (current.max_duration_minutes + gap) * 60000) errors.push({ code: 'minimum_gap', schedule_ids: scheduleIds });
      if (next && nextDue - due < (current.max_duration_minutes + gap + allowance) * 60000) errors.push({ code: 'delivery_allowance', schedule_ids: scheduleIds, allowance_minutes: allowance });
      let value = result.value;
      if (!value && current.max_duration_minutes > 240) {
        value = computeOccurrenceBounds({ dueAt: current.dueAt, nextDueAt: next && next.dueAt, maxDurationMinutes: 240, gapMinutes: gap, deliveryIntervalMinutes: interval, timezone: p.timezone }).value;
      }
      if (!value) {
        errors.push({ code: result.error, schedule_ids: scheduleIds, ...(result.details || {}) });
        continue;
      }
      for (const day of value.local_days) {
        const entry = byLocalDay.get(day) || { minutes: 0, schedule_ids: [] };
        entry.minutes += current.max_duration_minutes;
        entry.schedule_ids.push(current.schedule_uuid);
        byLocalDay.set(day, entry);
      }
      if (result.value) resolvedBounds.push({ ...result.value, schedule_uuid: current.schedule_uuid, device_eui: eui });
    }
    for (const [day, entry] of byLocalDay) {
      if (entry.minutes > budget) errors.push({ code: 'daily_budget', schedule_ids: [...new Set(entry.schedule_ids)], budget_minutes: budget, local_date: day });
    }
  }
  const reasons = dedupeReasons(errors);
  if (reasons.length) {
    const affected = [...new Set(reasons.flatMap((e) => e.schedule_ids || []))];
    const details = { affected_schedule_ids: affected, reasons };
    if (bounds) details.validation_bounds = bounds;
    return { ok: false, status: 422, error: 'schedule_infeasible', details };
  }
  return { ok: true, value: {
    schedules: rows, timezone: p.timezone,
    delivery_settings: Object.fromEntries([...valves].map((eui) => [eui, settings[eui] || { delivery_interval_minutes: 10 }])),
    resolved_bounds: resolvedBounds,
    validation_bounds: bounds,
  } };
}

function durationFor(condition, baseMinutes, action) {
  if (!Number.isInteger(baseMinutes) || baseMinutes < 1 || baseMinutes > 240) throw new RangeError('base duration must be an integer from 1 to 240 minutes');
  const kind = String(condition && condition.kind || '').toUpperCase();
  const mode = kind === 'DENDRO' ? condition.response_mode : 'fixed';
  if (mode !== 'fixed' && mode !== 'proportional') throw new RangeError('response mode is invalid');
  if (kind === 'SWT' || kind === 'VWC') return baseMinutes;
  if (!Object.prototype.hasOwnProperty.call(ACTION_MULTIPLIERS, action)) throw new RangeError(`unknown action: ${action}`);
  const maximum = mode === 'proportional' ? baseMinutes * 1.5 : baseMinutes;
  if (maximum > 240) throw new RangeError('maximum possible duration exceeds 240 minutes');
  const raw = mode === 'proportional' ? baseMinutes * ACTION_MULTIPLIERS[action] : baseMinutes;
  return Math.max(1, Math.round(raw));
}

function commissionedChannels(device) {
  if (!device || device.type_id !== 'DRAGINO_SDI12') return [];
  if (!['identified', 'manual'].includes(String(device.sdi12_probe_status || '').toLowerCase())) return [];
  const profile = getProfile(device.sdi12_probe_profile);
  if (!profile) return [];
  const learnedCount = Number.isInteger(device.sdi12_value_count) ? device.sdi12_value_count : null;
  if (profile.id === 'GENERIC_VWC') {
    // The generic profile is an explicit manual escape hatch, not a broad
    // DRAGINO_SDI12 guess. Its saved value count is its commissioning proof.
    if (learnedCount == null || learnedCount < 1 || learnedCount > profile.values.length) return [];
    return profile.values
      .filter((entry) => entry.channel.startsWith('vwc_') && entry.index < learnedCount)
      .map((entry) => entry.channel);
  }
  // Named provisional mappings remain unavailable until a future qualification
  // seam records bench-backed identity/layout evidence.
  if (profile.provisional) return [];
  if (profile.id === 'SENTEK_ENVIROSCAN') {
    const layout = validateSentekLayout(device.sdi12_channel_layout_json);
    if (!layout.ok) return [];
    return layout.layout.sensors.map((sensor) => `vwc_${sensor.channel}`);
  }
  const values = profile.values || [];
  return values
    .filter((entry) => entry.channel.startsWith('vwc_') && (learnedCount == null || entry.index < learnedCount))
    .map((entry) => entry.channel);
}

module.exports = {
  SWT_CHANNELS,
  VWC_CHANNELS,
  SWT_ALIASES,
  STRESS_RANK,
  ACTION_MULTIPLIERS,
  normalizeChannel,
  validateCondition,
  validatePolicyInput,
  validateScheduleSet,
  computeOccurrenceBounds,
  actualOccurrenceBounds: computeOccurrenceBounds,
  localDaysForInterval,
  minutesByLocalDay,
  validTimezone,
  durationFor,
  commissionedChannels,
  PROFILES,
};
