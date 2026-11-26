'use strict';
// Volatile-value normalisation for T1. It keeps the *form* of each volatile
// value, so a different timestamp text form, a missing field, null versus
// absent, or a number versus a string still compares unequal.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SQLTS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;
const HEX32 = /^[0-9a-f]{32}$/;
const BCRYPT = /^\$(2[abxy]?)\$(\d{2})\$[./A-Za-z0-9]{53}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{43}$/;
const EPOCH_MS = [1.5e12, 2.5e12];
const EPOCH_S = [1.5e9, 2.5e9];
const DAY_MS = 86400000;
// Calendar-relative day window: a date-only string this close to a side's
// anchor day means "N days from the run"; anything farther is an absolute
// date and must stay literal.
const DAY_WINDOW = 30;
const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_SLASH = /(\d{4})\/(\d{2})\/(\d{2})/g;
const DATE_DASH_TIME = /(\d{4})-(\d{2})-(\d{2})(?= \d{2}:\d{2})/g;
// The legacy scheduler stamp with dashes ("YYYY-MM-DD hh:mm:ss GMT", as
// Date.parse reads it) is the whole value; scenarios write it from a date
// token, so the date is the run's day on each side.
const DASH_GMT = /^(\d{4})-(\d{2})-(\d{2})( \d{2}:\d{2}:\d{2} GMT)$/;

// The UTC day a cassette side ran on: explicit meta.anchorDay, else the UTC
// date of meta.recordedAt. Null when neither is present (no day normalisation).
function anchorDayOf(cassette) {
  const m = cassette && cassette.meta;
  if (!m) return null;
  if (typeof m.anchorDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.anchorDay)) return m.anchorDay;
  if (typeof m.recordedAt === 'string') { const d = new Date(m.recordedAt); if (Number.isNaN(d.getTime())) return null; return d.toISOString().slice(0, 10); }
  return null;
}

// The instant a cassette side ran: meta.anchorMs, else meta.recordedAt.
function anchorInstantOf(cassette) {
  const m = cassette && cassette.meta;
  if (!m) return null;
  if (Number.isFinite(m.anchorMs)) return m.anchorMs;
  const t = typeof m.recordedAt === 'string' ? Date.parse(m.recordedAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

// The local calendar day at an instant in an IANA or offset time zone, for
// steps whose backend computes "today" in a zone's own time (anchorTimeZone).
function localDay(instant, timeZone) {
  if (instant === null) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(instant));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function make(anchorDay) {
  let anchor = anchorDay ? Date.parse(anchorDay + 'T00:00:00Z') : null;
  const defaultAnchor = anchor;
  const ids = new Map();
  const id = (kind, v) => { const k = kind + ':' + v; if (!ids.has(k)) ids.set(k, ids.size + 1); return `<${kind}#${ids.get(k)}>`; };
  const dayRel = (y, mo, d) => {
    if (anchor === null || !Number.isFinite(anchor)) return null;
    const t = Date.parse(`${y}-${mo}-${d}T00:00:00Z`);
    if (!Number.isFinite(t)) return null;
    const n = Math.round((t - anchor) / DAY_MS);
    return Math.abs(n) <= DAY_WINDOW ? `<day${n >= 0 ? '+' : ''}${n}>` : null;
  };
  // Calendar-relative dates near the anchor become <day±N>. Dash dates only
  // as the whole value (a bare YYYY-MM-DD field); slash dates also embedded
  // in longer text, because the scheduler stores backend-computed legacy
  // "YYYY/MM/DD 00:00:00 GMT" stamps. A dash date that opens a date-time
  // stamp ("2026-11-25 00:00:00 GMT") is a calendar day only in a step marked
  // anchorTimeZone, whose dates are the run's own day. Elsewhere an embedded
  // dash date (an echo of a scenario literal inside a longer string, e.g.
  // "eui|YYYY-MM-DDTHH:MMZ" or an uplink's "2026-11-20 00:00:00 UTC") stays
  // absolute: both sides echo the same text. JSON-looking text is left for
  // the json-text branch.
  let stampDays = false;
  const daySub = (s) => {
    if (anchor === null || s.startsWith('{') || s.startsWith('[')) return s;
    if (DAY_ONLY.test(s)) { const r = dayRel(...DAY_ONLY.exec(s).slice(1)); if (r) return r; return s; }
    const g = DASH_GMT.exec(s);
    if (g) { const r = dayRel(g[1], g[2], g[3]); return r ? r + g[4] : s; }
    const slashed = s.replace(DATE_SLASH, (whole, y, mo, d) => dayRel(y, mo, d) || whole);
    return stampDays ? slashed.replace(DATE_DASH_TIME, (whole, y, mo, d) => dayRel(y, mo, d) || whole) : slashed;
  };
  function str(s, key) {
    if (key === 'reason' && s.startsWith('one_time_open:')) {
      const [, schedule, at] = /^one_time_open:([^:]+):(.+)$/.exec(s) || [];
      if (UUID.test(schedule) && ISO.test(at)) return 'one_time_open:' + str(schedule) + ':' + str(at);
    }
    if (UUID.test(s)) return id('uuid', s.toLowerCase()) + (s === s.toLowerCase() ? '' : ':upper');
    if (HEX32.test(s)) return id('hex32', s);
    let m = ISO.exec(s);
    if (m) return `<ts:iso${m[3] ? ':frac' + (m[3].length - 1) : ''}:${m[4] === 'Z' ? 'Z' : 'offset'}>`;
    if (SQLTS.test(s)) return `<ts:sql${s.includes('.') ? ':frac' : ''}>`;
    m = BCRYPT.exec(s);
    if (m) return `<bcrypt:${m[1]}:${m[2]}>`;
    if (TOKEN.test(s)) return '<token>';
    const d = daySub(s);
    return d === s ? s : d;
  }
  function num(n, key) {
    // Monotonic uptime (clock-derived, differs per boot and run); keeps the integer type.
    if (Number.isInteger(n) && /(^|_)uptime_ms$|uptimeMs$/.test(key || '')) return '<uptime-ms>';
    if (Number.isInteger(n) && n >= EPOCH_MS[0] && n <= EPOCH_MS[1]) return '<epoch-ms>';
    if (Number.isInteger(n) && n >= EPOCH_S[0] && n <= EPOCH_S[1] && /(_at|At|time|Time|ts|epoch|expires|iat|exp)$/.test(key || '')) return '<epoch-s>';
    return n;
  }
  function value(v, key) {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      const s = str(v, key);
      if (s !== v) return s;
      // JSON text inside a string column or field: normalise inside, keep the marker.
      if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
        try { return { '<json-text>': value(JSON.parse(v), key) }; } catch { /* plain text */ }
      }
      return v;
    }
    if (typeof v === 'number') return num(v, key);
    if (Array.isArray(v)) return v.map((x) => value(x, key));
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = value(v[k], k);
      return out;
    }
    return v;
  }
  // Normalise one step against another day (a zone-local "today"), reading
  // its date-time stamps as calendar days, and keeping the identifier
  // numbering shared with every other step.
  function withAnchorDay(day, fn) {
    anchor = day ? Date.parse(day + 'T00:00:00Z') : defaultAnchor;
    stampDays = true;
    try { return fn(); } finally { anchor = defaultAnchor; stampDays = false; }
  }
  return { value, withAnchorDay };
}

// A Gen1 FPort 12 frame contains one byte per local clock digit (HHMMSS0wDDMMYY).
// Preserve its local offset and leave malformed frames or frames that disagree
// with the push's recorded intent time outside the clock normalisation.
// The intent time is transport_json.intent_at. A row whose transport_json is
// NULL never reached the dispatcher's claim (push.js queuePushes inserts the
// row, then enqueueValveCommand refuses it), so its only time is queued_at,
// SQLite's datetime('now') in UTC: that is the reference for such a row only.
function clockPayload(hex, transport, queuedAt) {
  if (typeof hex !== 'string' || !/^(?:0[0-9]){14}$/.test(hex)) return hex;
  let intent;
  if (transport == null) {
    if (typeof queuedAt !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(queuedAt)) return hex;
    intent = Date.parse(queuedAt.replace(' ', 'T') + 'Z');
  } else {
    try { intent = Date.parse(JSON.parse(transport).intent_at); } catch { return hex; }
  }
  const [hour, minute, second, weekday, day, month, year] =
    hex.match(/0[0-9]0[0-9]/g).map((pair) => Number(pair[1] + pair[3]));
  const local = new Date(Date.UTC(2000 + year, month - 1, day, hour, minute, second));
  if (local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day ||
      local.getUTCHours() !== hour || local.getUTCMinutes() !== minute ||
      local.getUTCSeconds() !== second || local.getUTCDay() !== weekday) return hex;
  const delta = local.getTime() - intent;
  const offset = Math.round(delta / 60000);
  if (!Number.isFinite(delta) || Math.abs(offset) > 14 * 60 || Math.abs(delta - offset * 60000) > 5000) return hex;
  return `<gen1-clock-offset-minutes:${offset}>`;
}
module.exports = { make, clockPayload, anchorDayOf, anchorInstantOf, localDay };
