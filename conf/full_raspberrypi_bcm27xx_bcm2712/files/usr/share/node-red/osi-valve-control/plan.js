'use strict';
const crypto = require('node:crypto');

const WEEKDAY_FPORT_BASE = 14; // 14=Sun .. 20=Sat (STREGA Gen1)
const GEN2_SCHEDULER_FPORT = 25;
const STATUS_FPORT = 21;
const CLOCK_FPORT = 12;
const CLOCK_REQ_FPORT = 13;
const MAX_WINDOWS_PER_DAY = 4;

function bcd(n) { return ((Math.floor(n / 10) & 0x0F) << 4) | (n % 10); }

function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

function windowFrom(startTime, durationMinutes, extra) {
  const t = parseHHMM(startTime);
  const startMin = t.h * 60 + t.m;
  const endMin = (startMin + durationMinutes) % 1440;
  return Object.assign({
    onH: t.h, onM: t.m, offH: Math.floor(endMin / 60), offM: endMin % 60,
    startMin, endMin: startMin + durationMinutes,
  }, extra || {});
}

function compileWindows(schedules) {
  const days = Array.from({ length: 7 }, () => []);
  const errors = [];
  for (const s of schedules || []) {
    if (!s || s.kind !== 'WEEKLY' || !Number(s.enabled) || s.deleted_at) continue;
    for (let d = 0; d < 7; d += 1) {
      if (!((Number(s.weekdays_mask) >> d) & 1)) continue;
      days[d].push(windowFrom(s.start_time, Number(s.duration_minutes), { scheduleUuid: s.schedule_uuid, label: s.label || null }));
    }
  }
  for (let d = 0; d < 7; d += 1) {
    days[d].sort((a, b) => a.startMin - b.startMin);
    if (days[d].length > MAX_WINDOWS_PER_DAY) {
      errors.push({ code: 'too_many_windows', weekday: d, count: days[d].length, conflicts: days[d].map((w) => w.scheduleUuid) });
    }
    for (let i = 1; i < days[d].length; i += 1) {
      if (days[d][i].startMin < days[d][i - 1].endMin) {
        errors.push({ code: 'overlap', weekday: d, conflicts: [days[d][i - 1].scheduleUuid, days[d][i].scheduleUuid] });
      }
    }
  }
  return { days, errors };
}

function encodeGen1Day(windows) {
  const buf = Buffer.alloc(24, 0xFF);
  (windows || []).slice(0, MAX_WINDOWS_PER_DAY).forEach((w, i) => {
    const o = i * 6;
    buf[o] = 0xFF; buf[o + 1] = 0x80 | bcd(w.onH); buf[o + 2] = bcd(w.onM);
    buf[o + 3] = 0xFF; buf[o + 4] = bcd(w.offH); buf[o + 5] = bcd(w.offM);
  });
  return buf;
}

function encodeGen2(daymask, windows) {
  const ws = (windows || []).slice(0, MAX_WINDOWS_PER_DAY);
  const buf = Buffer.alloc(1 + ws.length * 4);
  buf[0] = daymask & 0xFF;
  ws.forEach((w, i) => {
    const o = 1 + i * 4;
    buf[o] = 0x80 | bcd(w.onH); buf[o + 1] = bcd(w.onM); buf[o + 2] = bcd(w.offH); buf[o + 3] = bcd(w.offM);
  });
  return buf;
}

function canonicalWindows(windows) {
  return (windows || []).map((w) => [w.onH, w.onM, w.offH, w.offM].join(':')).sort();
}

function planHash(windows) {
  return crypto.createHash('sha1').update(canonicalWindows(windows).join('|')).digest('hex');
}

function gen2Groups(days) {
  const byHash = new Map();
  days.forEach((w, d) => {
    const key = planHash(w);
    if (!byHash.has(key)) byHash.set(key, { daymask: 0, windows: w });
    byHash.get(key).daymask |= (1 << d);
  });
  const groups = [...byHash.values()];
  return groups.map((g) => (g.daymask === 0x7F ? { daymask: 0x80, windows: g.windows } : g));
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();
function formatter(timeZone) {
  if (!fmtCache.has(timeZone)) {
    fmtCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(timeZone);
}

function localParts(date, timeZone) {
  const parts = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

function weekdayLocal(date, timeZone) { return localParts(date, timeZone).weekday; }

function gen1ClockPayload(date, timeZone) {
  const p = localParts(date, timeZone);
  const digits = [p.hour, p.minute, p.second, p.weekday, p.day, p.month, p.year % 100]
    .map((n, i) => (i === 3 ? '0' + n : String(n).padStart(2, '0'))).join('');
  return Buffer.from(digits.split('').map((c) => Number(c)));
}

function offsetMinutes(date, timeZone) {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function isDstTransitionWithin(timeZone, fromMs, toMs) {
  return offsetMinutes(new Date(fromMs), timeZone) !== offsetMinutes(new Date(toMs), timeZone);
}

// First instant >= from at which local wall-clock in timeZone equals (weekday, HH:MM).
// Nonexistent times (spring-forward gap) resolve to the first valid minute after the gap.
function nextLocalOccurrence(from, timeZone, weekday, h, m) {
  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const probe = new Date(from.getTime() + dayOffset * 86400000);
    const p = localParts(probe, timeZone);
    if (p.weekday !== weekday) continue;
    const off = offsetMinutes(probe, timeZone);
    let candidate = new Date(Date.UTC(p.year, p.month - 1, p.day, h, m) - off * 60000);
    const check = localParts(candidate, timeZone);
    if (check.hour !== h || check.minute !== m) {
      // offset changed between probe and candidate (DST); recompute with the candidate's own offset
      const off2 = offsetMinutes(candidate, timeZone);
      candidate = new Date(Date.UTC(p.year, p.month - 1, p.day, h, m) - off2 * 60000);
    }
    if (candidate.getTime() >= from.getTime() && localParts(candidate, timeZone).weekday === weekday) return candidate;
  }
  return null;
}

function nextRun(schedules, now, timeZoneFallback) {
  let best = null;
  for (const s of schedules || []) {
    if (!s || !Number(s.enabled) || s.deleted_at) continue;
    const tz = s.timezone || timeZoneFallback || 'UTC';
    let at = null;
    if (s.kind === 'ONCE') {
      if (s.once_state !== 'PENDING') continue;
      const t = Date.parse(s.fire_at);
      if (Number.isFinite(t) && t >= now.getTime()) at = new Date(t);
    } else if (s.kind === 'WEEKLY') {
      const hm = parseHHMM(s.start_time);
      if (!hm) continue;
      for (let d = 0; d < 7; d += 1) {
        if (!((Number(s.weekdays_mask) >> d) & 1)) continue;
        const c = nextLocalOccurrence(now, tz, d, hm.h, hm.m);
        if (c && (!at || c < at)) at = c;
      }
    }
    if (at && (!best || at < best.atDate)) best = { atDate: at, at: at.toISOString(), kind: s.kind, minutes: Number(s.duration_minutes), scheduleUuid: s.schedule_uuid };
  }
  if (!best) return null;
  const { atDate, ...rest } = best;
  return rest;
}

function validateScheduleInput(body) {
  const b = body || {};
  const fail = (status, error, details) => ({ ok: false, status, error, details: details || null });
  const kind = String(b.kind || '').toUpperCase();
  const duration = Number(b.duration_minutes);
  const label = b.label == null ? null : String(b.label).slice(0, 80);
  if (kind === 'WEEKLY') {
    const mask = Number(b.weekdays_mask);
    if (!Number.isInteger(mask) || mask < 1 || mask > 127) return fail(422, 'invalid_weekdays', 'weekdays_mask must be 1..127');
    if (!parseHHMM(b.start_time)) return fail(422, 'invalid_start_time', 'start_time must be HH:MM');
    if (!Number.isInteger(duration) || duration < 1 || duration > 1439) return fail(422, 'invalid_duration', 'duration_minutes must be 1..1439');
    return { ok: true, value: { kind, weekdays_mask: mask, start_time: b.start_time, fire_at: null, duration_minutes: duration, label, enabled: b.enabled === undefined ? 1 : (b.enabled ? 1 : 0) } };
  }
  if (kind === 'ONCE') {
    const t = Date.parse(b.fire_at);
    if (!Number.isFinite(t)) return fail(422, 'invalid_fire_at', 'fire_at must be an ISO instant');
    if (!Number.isInteger(duration) || duration < 1 || duration > 255) return fail(422, 'invalid_duration', 'duration_minutes must be 1..255 for one-time opens');
    return { ok: true, value: { kind, weekdays_mask: null, start_time: null, fire_at: new Date(t).toISOString(), duration_minutes: duration, label, enabled: b.enabled === undefined ? 1 : (b.enabled ? 1 : 0) } };
  }
  return fail(422, 'invalid_kind', 'kind must be WEEKLY or ONCE');
}

module.exports = {
  WEEKDAY_FPORT_BASE, GEN2_SCHEDULER_FPORT, STATUS_FPORT, CLOCK_FPORT, CLOCK_REQ_FPORT, MAX_WINDOWS_PER_DAY,
  compileWindows, encodeGen1Day, encodeGen2, gen2Groups, planHash, gen1ClockPayload,
  localParts, weekdayLocal, offsetMinutes, isDstTransitionWithin, nextLocalOccurrence, nextRun,
  validateScheduleInput, parseHHMM,
};
