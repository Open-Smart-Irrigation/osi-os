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
    if (!parseHHMM(s.start_time)) {
      // Malformed start_time from a DB row: report instead of letting windowFrom throw.
      errors.push({ code: 'invalid_start_time', weekday: null, conflicts: [s.schedule_uuid] });
      continue;
    }
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
  // Cross-midnight spillover (conflict detection only; encoding stays on the start weekday).
  // A window wrapping past midnight (endMin > 1440) also occupies [0, endMin-1440) on the
  // NEXT weekday. The boundary is exclusive: a spillover ending exactly at local midnight
  // (endMin === 1440, spillover width 0) does not conflict with a window starting at 00:00.
  for (let d = 0; d < 7; d += 1) {
    const prevDay = (d + 6) % 7;
    for (const sp of days[prevDay]) {
      if (sp.endMin <= 1440) continue;
      const spilloverEnd = sp.endMin - 1440;
      for (const w of days[d]) {
        if (w.startMin < spilloverEnd) {
          errors.push({ code: 'overlap', weekday: d, conflicts: [sp.scheduleUuid, w.scheduleUuid] });
        }
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

// Order-independent (sorts before hashing) so it is safe to use as a diff/grouping key across
// window lists built in different orders. It is only safe as a diff key here because
// compileWindows always sorts each day's windows by startMin before this is ever called —
// planHash itself does not distinguish overlapping-but-differently-ordered windows beyond that.
function planHash(windows) {
  return crypto.createHash('sha1').update(canonicalWindows(windows).join('|')).digest('hex');
}

function gen2Groups(days) {
  const byHash = new Map();
  days.forEach((w, d) => {
    const key = planHash(w);
    if (!byHash.has(key)) byHash.set(key, { daymask: 0, windows: w.slice() });
    byHash.get(key).daymask |= (1 << d);
  });
  const groups = [...byHash.values()];
  return groups.map((g) => (g.daymask === 0x7F ? { daymask: 0x80, windows: g.windows } : g));
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();
function buildFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
function formatter(timeZone) {
  if (!fmtCache.has(timeZone)) {
    let fmt;
    try {
      fmt = buildFormatter(timeZone);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      // Invalid/unrecognized IANA timezone (e.g. a bad DB row): fall back to UTC rather than
      // throwing out of localParts/nextRun, and cache the fallback so it doesn't re-throw
      // on every subsequent call for the same bad timezone string.
      fmt = formatter('UTC');
    }
    fmtCache.set(timeZone, fmt);
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

// Resolve the local wall-clock (y, mo, d, h, m) in timeZone to a concrete UTC instant.
// - Unambiguous times round-trip on the first or second offset guess.
// - Nonexistent times (spring-forward gap) snap forward minute-by-minute (bounded) to the
//   first real instant whose local wall clock is at or after the requested time.
// - Ambiguous times (fall-back repeat) resolve deterministically to one of the two real
//   occurrences (the one implied by the day's noon offset) — either is an acceptable answer.
function resolveLocalInstant(y, mo, d, h, m, timeZone) {
  const requestedMinutes = h * 60 + m;
  const roundTrips = (candidate) => {
    const check = localParts(candidate, timeZone);
    return check.year === y && check.month === mo && check.day === d && check.hour === h && check.minute === m;
  };
  const naiveUtc = Date.UTC(y, mo - 1, d, h, m);
  const noonGuess = new Date(Date.UTC(y, mo - 1, d, 12, 0));
  const off1 = offsetMinutes(noonGuess, timeZone);
  const candidate1 = new Date(naiveUtc - off1 * 60000);
  if (roundTrips(candidate1)) return candidate1;

  const off2 = offsetMinutes(candidate1, timeZone);
  const candidate2 = new Date(naiveUtc - off2 * 60000);
  if (roundTrips(candidate2)) return candidate2;

  // Nonexistent local time (spring-forward gap). Start scanning from whichever guess is
  // earlier (the larger subtracted offset yields the smaller/ earlier instant) so the scan
  // is guaranteed to begin at or before the gap, then step forward minute-by-minute.
  let probe = candidate1.getTime() <= candidate2.getTime() ? candidate1 : candidate2;
  for (let i = 0; i < 120; i += 1) {
    const pc = localParts(probe, timeZone);
    const sameOrLaterDay = pc.year > y || (pc.year === y && (pc.month > mo || (pc.month === mo && pc.day >= d)));
    const sameDayAtOrPastRequested = pc.year === y && pc.month === mo && pc.day === d && (pc.hour * 60 + pc.minute) >= requestedMinutes;
    if (sameDayAtOrPastRequested || (sameOrLaterDay && (pc.day !== d || pc.month !== mo || pc.year !== y))) return probe;
    probe = new Date(probe.getTime() + 60000);
  }
  return probe;
}

// First instant >= from at which local wall-clock in timeZone equals (weekday, HH:MM).
// Nonexistent times (spring-forward gap) resolve to the first valid minute after the gap.
// Iterates local CALENDAR days (not raw 24h steps), because a raw +24h step overshoots on a
// 23-hour (spring-forward) local day and can skip the target weekday entirely.
function nextLocalOccurrence(from, timeZone, weekday, h, m) {
  const p0 = localParts(from, timeZone);
  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const localDay = new Date(Date.UTC(p0.year, p0.month - 1, p0.day + dayOffset));
    const y = localDay.getUTCFullYear();
    const mo = localDay.getUTCMonth() + 1;
    const d = localDay.getUTCDate();
    if (localDay.getUTCDay() !== weekday) continue;
    const candidate = resolveLocalInstant(y, mo, d, h, m, timeZone);
    if (candidate && candidate.getTime() >= from.getTime()) return candidate;
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

const ISO_INSTANT_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

function validateScheduleInput(body) {
  const b = body || {};
  const fail = (status, error, details) => ({ ok: false, status, error, details: details || null });
  const kind = String(b.kind || '').toUpperCase();
  const duration = Number(b.duration_minutes);
  if (b.label !== undefined && b.label !== null && typeof b.label !== 'string') {
    return fail(422, 'invalid_label', 'label must be a string');
  }
  const label = b.label == null ? null : String(b.label).slice(0, 80);
  if (kind === 'WEEKLY') {
    const mask = Number(b.weekdays_mask);
    if (!Number.isInteger(mask) || mask < 1 || mask > 127) return fail(422, 'invalid_weekdays', 'weekdays_mask must be 1..127');
    if (typeof b.start_time !== 'string') return fail(422, 'invalid_start_time', 'start_time must be a string HH:MM');
    const hm = parseHHMM(b.start_time);
    if (!hm) return fail(422, 'invalid_start_time', 'start_time must be HH:MM');
    if (!Number.isInteger(duration) || duration < 1 || duration > 1439) return fail(422, 'invalid_duration', 'duration_minutes must be 1..1439');
    const normalizedStartTime = `${String(hm.h).padStart(2, '0')}:${String(hm.m).padStart(2, '0')}`;
    return { ok: true, value: { kind, weekdays_mask: mask, start_time: normalizedStartTime, fire_at: null, duration_minutes: duration, label, enabled: b.enabled === undefined ? 1 : (b.enabled ? 1 : 0) } };
  }
  if (kind === 'ONCE') {
    if (typeof b.fire_at !== 'string' || !ISO_INSTANT_PREFIX.test(b.fire_at)) return fail(422, 'invalid_fire_at', 'fire_at must be an ISO instant');
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
