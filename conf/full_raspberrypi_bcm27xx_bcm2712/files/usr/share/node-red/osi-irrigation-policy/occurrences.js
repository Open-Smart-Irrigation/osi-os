'use strict';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatterCache = new Map();

function formatter(timezone) {
  if (!formatterCache.has(timezone)) {
    const value = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', weekday: 'short', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatterCache.set(timezone, value);
  }
  return formatterCache.get(timezone);
}

function localParts(date, timezone) {
  const parts = {};
  for (const part of formatter(timezone).formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

function offsetMinutes(date, timezone) {
  const p = localParts(date, timezone);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime()) / 60000);
}

function validLocalDate(date, time) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function asDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(NaN);
  return new Date(value);
}

function resolveLocalDateTime(localDate, localTime, timezone) {
  if (!validLocalDate(localDate, localTime)) return null;
  let y; let mo; let d;
  try {
    [y, mo, d] = localDate.split('-').map(Number);
    const [h, m] = localTime.split(':').map(Number);
    const checkDate = new Date(Date.UTC(y, mo - 1, d));
    if (checkDate.getUTCFullYear() !== y || checkDate.getUTCMonth() + 1 !== mo || checkDate.getUTCDate() !== d) return null;
    const naive = Date.UTC(y, mo - 1, d, h, m, 0);
    const offsets = new Set();
    for (const delta of [0, -180, 180, -720, 720, -1440, 1440, -2880, 2880, -10080, 10080]) {
      offsets.add(offsetMinutes(new Date(naive + delta * 60000), timezone));
    }
    const candidates = [];
    for (const offset of offsets) {
      const candidate = new Date(naive - offset * 60000);
      const p = localParts(candidate, timezone);
      if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === m && p.second === 0) candidates.push(candidate);
    }
    if (!candidates.length) return null; // spring-forward gap: skip the slot
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0]; // first fold instant, deterministically
  } catch (_) {
    return null; // invalid IANA zone or malformed date: fail closed
  }
}

function isoDateAtUtcDay(day) {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString().slice(0, 10);
}

function occurrencesBetween(schedule, from, to) {
  const s = schedule || {};
  if (s.kind !== 'WEEKLY' || !Number(s.enabled) || s.deleted_at) return [];
  if (!s.timezone) return [];
  const fromDate = asDate(from); const toDate = asDate(to);
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime()) || fromDate > toDate) return [];
  const hm = /^(\d{2}):(\d{2})$/.exec(String(s.start_time || ''));
  if (!hm) return [];
  const startParts = localParts(fromDate, s.timezone);
  const localStart = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day));
  const endParts = localParts(toDate, s.timezone);
  const localEnd = new Date(Date.UTC(endParts.year, endParts.month - 1, endParts.day));
  const effective = s.effective_from == null ? null : asDate(s.effective_from);
  if (effective && !Number.isFinite(effective.getTime())) return [];
  const rows = [];
  for (let day = new Date(localStart); day <= localEnd; day.setUTCDate(day.getUTCDate() + 1)) {
    const weekday = day.getUTCDay();
    if (!((Number(s.weekdays_mask) >> weekday) & 1)) continue;
    const localDate = isoDateAtUtcDay(day);
    const localTime = `${hm[1]}:${hm[2]}`;
    const due = resolveLocalDateTime(localDate, localTime, s.timezone);
    if (!due || due < fromDate || due > toDate || (effective && due <= effective)) continue;
    rows.push({
      schedule_uuid: s.schedule_uuid,
      device_eui: s.device_eui,
      local_date: localDate,
      local_time: localTime,
      dueAt: due.toISOString(),
      duration_minutes: Number(s.duration_minutes),
      timezone: s.timezone,
    });
  }
  return rows;
}

function decisionWindow(dueAt, now) {
  const due = asDate(dueAt); const current = asDate(now);
  if (!Number.isFinite(due.getTime()) || !Number.isFinite(current.getTime())) return { eligible: false, reason: 'clock_untrusted' };
  const elapsed = current.getTime() - due.getTime();
  return elapsed >= 0 && elapsed <= 10 * 60 * 1000
    ? { eligible: true, reason: null }
    : { eligible: false, reason: elapsed > 10 * 60 * 1000 ? 'missed_start' : 'not_due' };
}

function missedAuditBounds(lastTrustedTick, now) {
  if (lastTrustedTick == null) return null;
  const from = new Date(lastTrustedTick); const to = new Date(now);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to < from) return null;
  const cap = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  const effectiveFrom = from > cap ? from : cap;
  return { from: effectiveFrom.toISOString(), to: to.toISOString() };
}

module.exports = { occurrencesBetween, resolveLocalDateTime, localParts, offsetMinutes, decisionWindow, missedAuditBounds };
