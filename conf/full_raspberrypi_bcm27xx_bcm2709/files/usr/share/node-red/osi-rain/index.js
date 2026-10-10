'use strict';
// osi-rain: rainfall measurement rules for the edge (rain correctness programme).
//
// Contract: docs/contracts/rainfall/lorain.md (truth table T1..T16). Fixtures:
// scripts/fixtures/lorain-rain. Every database call goes through the caller's
// transaction scope `t` (osi-db-helper Database.transaction: run/get/all on one
// operationQueue slot). This module never opens a database and has no
// dependencies beyond Node built-ins.
//
// rain_observations.config_json (migration 0071) holds, per observation:
//   frame: what the frame itself carried (port, tips, rain blocks, alarm,
//          configuration reply, build date) so a later recomputation can
//          re-assess the frame without the raw uplink;
//   state: the recorded reporting configuration after the frame
//          ({ confInterval, confHeartbeatWakes, fPort, buildDate, stale });
//   query: set on the observation that triggered the one authorised
//          configuration query ({ requestedAt, buildDate }).
const crypto = require('crypto');

const RAIN_POLICY_VERSION = 1;
const LORAIN_MM_PER_TIP = 0.5;
const LORAIN_TYPE_ID = 'AQUASCOPE_LORAIN';
const LORAIN_RAIN_SOURCE = 'aquascope_lorain';
// Wake grid (contract, "Wake grid"): spacing tolerance, and the reference
// interval used for the grid while no 0x04 reply has been recorded.
const GRID_TOLERANCE_S = 60;
const REFERENCE_INTERVAL_S = 900;
// Same devAddr + fCnt within this window is the same frame slot (T5).
const REPLAY_WINDOW_MS = 3600000;
// Recomputation after a new frame: frames up to this far before it can change
// (same-slot partner, an earlier off-grid frame), and frames up to the forward
// bound after it (gap closure, overlap carry, configuration transition).
// Context for the chain reaches CONTEXT_LOOKBACK_MS before the apply range.
const RECOMPUTE_BACK_MS = 2 * 3600000;
const RECOMPUTE_FORWARD_MS = 24 * 3600000;
const CONTEXT_LOOKBACK_MS = 24 * 3600000;
// Same plausibility clamp as osi-device-writer.clampRecordedAt (unit-tested
// against it); re-implemented so this module has no dependency.
const TIMESTAMP_FLOOR_MS = Date.parse('2024-01-01T00:00:00Z');
const TIMESTAMP_SKEW_MS = 3600000;
const ZONELESS_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

// Port/build pairs whose counter logic is accepted under D9 (contract,
// promotion condition 3): { fPort, buildDate: 'yymmdd' }. An entry is added
// only after the owner confirms that build as stock firmware covered by a
// pinned source. Empty: no installed gauge is promoted today, so every LoRain
// interval stays 'unknown' and no rate is derived (D8).
const PINNED_LORAIN_BUILDS = Object.freeze([]);

// The one authorised read-only configuration query (contract, "Configuration
// query"): ten filler bytes, 04 02, 04 04, 04 03, 0A, trailing 00. Derived from
// the pinned FPort-2 source, NOT bench-verified. The FPort-10 build has no
// documented form, so nothing is ever built for it.
const LORAIN_CONFIG_QUERY_HEX = Object.freeze({ 2: '000000000000000000000402040404030a00' });

// Block lengths after the command byte, as the codec reads them.
const BLOCK_LEN = { 0x03: 3, 0x04: 3, 0x06: 3, 0x0a: 4, 0x0b: 4, 0x12: 3 };

// The reason an observation carries first (fixtures' `reason`).
const REASON_ORDER = ['duplicate', 'identity_conflict', 'invalid_tips', 'alarm_event', 'build_unpinned',
  'session_reset', 'frame_gap', 'multi_block', 'overlap_unqualified', 'config_change', 'config_mismatch', 'received_only'];
const SPAN_REASON_ORDER = ['build_unpinned', 'multi_block', 'config_change', 'config_mismatch', 'received_only'];

const DELTA_STATUS = {
  accepted: 'ok',
  ambiguous_identity: 'ambiguous_identity',
  rejected_invalid: 'invalid_rain_delta',
  not_additive: 'no_rain_sensor',
  overlap_unqualified: 'overlap_unqualified',
};

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function parseTimestampMs(raw) {
  const text = String(raw).trim();
  const zoneless = ZONELESS_TIMESTAMP.exec(text);
  return Date.parse(zoneless ? zoneless[1] + 'T' + zoneless[2] + 'Z' : text);
}

function clampReceivedAt(raw, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (raw === undefined || raw === null || raw === '') return new Date(now).toISOString();
  const ms = parseTimestampMs(raw);
  if (!Number.isFinite(ms) || ms < TIMESTAMP_FLOOR_MS || ms > now + TIMESTAMP_SKEW_MS) return new Date(now).toISOString();
  return new Date(ms).toISOString();
}

const FORMATTERS = new Map();
function formatterFor(timezone) {
  const raw = String(timezone || 'UTC').trim() || 'UTC';
  if (FORMATTERS.has(raw)) return FORMATTERS.get(raw);
  const make = (tz) => ({
    timezone: tz,
    date: new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }),
    dateTime: new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }),
  });
  let entry;
  try { entry = make(raw); } catch (_invalidZone) { entry = make('UTC'); }
  FORMATTERS.set(raw, entry);
  return entry;
}

function partsAt(formatter, ms) {
  const acc = {};
  for (const part of formatter.formatToParts(new Date(ms))) if (part.type !== 'literal') acc[part.type] = part.value;
  return acc;
}

function dayNumberAt(f, ms) {
  const p = partsAt(f.date, ms);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
}

// First instant of the local date that contains `ms` (same algorithm as
// osi-history-helper.startOfLocalDayMs, cross-checked by a unit test).
function startOfLocalDayMs(ms, timezone) {
  const f = formatterFor(timezone);
  const targetDay = dayNumberAt(f, ms);
  const offsetAt = (at) => {
    const q = partsAt(f.dateTime, at);
    return Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour) % 24, Number(q.minute), Number(q.second))
      - Math.floor(at / 1000) * 1000;
  };
  const guess = targetDay - offsetAt(targetDay);
  const candidate = targetDay - offsetAt(guess);
  if (dayNumberAt(f, candidate) === targetDay && dayNumberAt(f, candidate - 1000) < targetDay) return candidate;
  let lowSec = Math.floor((targetDay - 15 * 3600000) / 1000);
  let highSec = Math.floor(ms / 1000);
  while (highSec - lowSec > 1) {
    const midSec = lowSec + Math.floor((highSec - lowSec) / 2);
    if (dayNumberAt(f, midSec * 1000) >= targetDay) highSec = midSec;
    else lowSec = midSec;
  }
  return highSec * 1000;
}

function localDateKey(ms, timezone) {
  const p = partsAt(formatterFor(timezone).date, ms);
  return p.year + '-' + p.month + '-' + p.day;
}

// The one timezone resolver for rain on the gateway (zone-day projection
// contract; osi-history-helper delegates its classification here). Takes the
// stored value, or a zone row with a `timezone` column. basis:
//   'zone'               a region name (or UTC) that Intl accepts;
//   'abbreviation'       Intl accepts it but it is not a region name (CET):
//                        kept, certifiable, flagged so the operator can pick a
//                        region (owner decision D6);
//   'invalid'            not a timezone: answered in UTC and never certified;
//   'unassigned_default' empty or missing: UTC.
function resolveTimezone(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw.timezone : raw;
  const tz = String(value === null || value === undefined ? '' : value).trim();
  if (!tz) return { timezone: 'UTC', basis: 'unassigned_default' };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (_invalidZone) {
    return { timezone: 'UTC', basis: 'invalid' };
  }
  const upper = tz.toUpperCase();
  if (upper === 'UTC' || upper === 'ETC/UTC' || tz.includes('/')) return { timezone: tz, basis: 'zone' };
  return { timezone: tz, basis: 'abbreviation' };
}

// The zone-local day that contains `tsIso`: date and [startIso, endIso).
// A day is 23 to 25 hours long, so 26 hours after its start always lies in
// the next day. An invalid timezone reads as UTC (as osi-history-helper does).
function zoneDayWindow(tsIso, timezone) {
  const ms = typeof tsIso === 'number' ? tsIso : Date.parse(tsIso);
  if (!Number.isFinite(ms)) throw new Error('zoneDayWindow requires a valid instant');
  const startMs = startOfLocalDayMs(ms, timezone);
  const endMs = startOfLocalDayMs(startMs + 26 * 3600000, timezone);
  return { date: localDateKey(ms, timezone), startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}

// The window of a zone-local date 'YYYY-MM-DD'.
function zoneDateWindow(dayIso, timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayIso || ''));
  if (!m) throw new Error('zoneDateWindow requires YYYY-MM-DD');
  let probe = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  for (let i = 0; i < 3 && localDateKey(probe, timezone) !== dayIso; i += 1) {
    probe += localDateKey(probe, timezone) < dayIso ? 12 * 3600000 : -12 * 3600000;
  }
  return zoneDayWindow(probe, timezone);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function payloadDigest({ fPort, data, object } = {}) {
  const basis = (data !== undefined && data !== null && data !== '')
    ? String(fPort) + ':' + String(data)
    : String(fPort) + ':' + canonicalJson(object || {});
  return crypto.createHash('sha256').update(basis).digest('hex');
}

function toIntOrNull(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isInteger(n) ? n : null;
}

function observationIdentity(uplink, { nowMs } = {}) {
  const u = uplink || {};
  const info = u.deviceInfo || {};
  const deveui = String(u.deveui || u.devEui || info.devEui || '').trim().toUpperCase();
  const eventId = u.eventId || u.deduplicationId || null;
  const devAddr = u.devAddr ? String(u.devAddr).trim().toLowerCase() : null;
  return {
    deveui,
    eventId: eventId ? String(eventId) : null,
    devAddr: devAddr || null,
    fCnt: toIntOrNull(u.fCnt),
    receivedAt: clampReceivedAt(u.time, nowMs),
    digest: payloadDigest({ fPort: u.fPort, data: u.data, object: u.object }),
  };
}

// ---------------------------------------------------------------------------
// Frame facts and single-frame classification
// ---------------------------------------------------------------------------

// Every `06 81` rain block in a base64 payload; null when the payload is
// absent or has a layout this reader does not know (the codec then decides).
function payloadRainBlocks(data) {
  if (data === undefined || data === null || data === '') return null;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'base64');
  const blocks = [];
  for (let i = 0; i < bytes.length;) {
    const len = BLOCK_LEN[bytes[i]];
    if (!len || i + 1 + len > bytes.length) return null;
    if (bytes[i] === 0x06 && bytes[i + 1] === 0x81) blocks.push(bytes.readUInt16BE(i + 2));
    i += 1 + len;
  }
  return blocks;
}

function positiveIntOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function buildDateOf(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? String(value).padStart(6, '0') : null;
}

// What one frame carries, from the decoded object and (for T16) the payload's
// own rain blocks.
function loRainFrameFacts(object, rainBlocks) {
  const o = object || {};
  const has = (key) => Object.prototype.hasOwnProperty.call(o, key);
  const blocks = Array.isArray(rainBlocks) ? rainBlocks : null;
  const multiBlock = !!(blocks && blocks.length > 1);
  let tipsRaw = null;
  if (multiBlock) tipsRaw = blocks.reduce((a, b) => a + b, 0);
  else if (has('rain_tips_delta') && o.rain_tips_delta !== null && o.rain_tips_delta !== undefined) tipsRaw = o.rain_tips_delta;
  else if (has('rainlevel')) tipsRaw = o.rainlevel === undefined ? null : o.rainlevel;
  else if (has('rain_tips_delta')) tipsRaw = null;
  else if (blocks && blocks.length === 1) tipsRaw = blocks[0];
  return {
    hasRain: has('rain_tips_delta') || has('rainlevel') || !!(blocks && blocks.length),
    tipsRaw: typeof tipsRaw === 'number' && !Number.isFinite(tipsRaw) ? String(tipsRaw) : tipsRaw,
    multiBlock,
    rainBlocks: blocks,
    alarm: has('alarm_status'),
    hasConfig: has('conf_interval') || has('conf_heartbeat') || has('conf_heavyrain') || has('conf_temperature_calibration'),
    confInterval: positiveIntOrNull(o.conf_interval),
    confHeartbeatWakes: positiveIntOrNull(o.conf_heartbeat),
    buildDate: buildDateOf(o.fw_version),
  };
}

function isValidTips(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function intrinsicClassification(facts) {
  if (facts.hasRain) {
    const n = facts.tipsRaw;
    if (!isValidTips(n)) {
      return { frameKind: 'ordinary', tips: n === undefined ? null : n, additive: false, valid: false, status: 'rejected_invalid', reasons: ['invalid_tips'] };
    }
    return {
      frameKind: n === 0 && !facts.alarm ? 'heartbeat_zero' : 'ordinary',
      tips: n, additive: true, valid: true, status: 'accepted', reasons: facts.multiBlock ? ['multi_block'] : [],
    };
  }
  if (facts.alarm) return { frameKind: 'alarm', tips: null, additive: false, valid: false, status: 'not_additive', reasons: ['alarm_event'] };
  return { frameKind: facts.hasConfig ? 'config' : 'status', tips: null, additive: false, valid: false, status: 'not_additive', reasons: [] };
}

function amountOf(tips) {
  return Math.round(tips * LORAIN_MM_PER_TIP * 10) / 10;
}

function normalizeConfig(config) {
  const c = config || {};
  return {
    confInterval: positiveIntOrNull(c.confInterval),
    confHeartbeatWakes: positiveIntOrNull(c.confHeartbeatWakes),
    fPort: toIntOrNull(c.fPort),
    buildDate: c.buildDate === null || c.buildDate === undefined || c.buildDate === '' ? null : String(c.buildDate),
    stale: !!c.stale,
  };
}

// One frame on its own (truth table rows that need no neighbour): amount,
// kind, validity. A single frame never proves continuity, so its interval
// basis is always 'unknown'; assessLoRainChain decides promotion, button
// frames and same-slot pairs. The second argument is the recorded
// configuration { confInterval, confHeartbeatWakes, fPort, buildDate }, or
// just the frame's FPort.
function classifyLoRainFrame(object, configOrFPort, options = {}) {
  const config = typeof configOrFPort === 'object' && configOrFPort !== null
    ? normalizeConfig(configOrFPort) : normalizeConfig({ fPort: configOrFPort });
  const facts = loRainFrameFacts(object, options.rainBlocks);
  const intr = intrinsicClassification(facts);
  const reasons = intr.reasons.slice();
  if (config.confInterval === null || config.confHeartbeatWakes === null) reasons.push('received_only');
  return {
    frameKind: intr.frameKind,
    tips: intr.tips,
    amountMm: intr.additive ? amountOf(intr.tips) : null,
    status: intr.status,
    intervalBasis: 'unknown',
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Chain assessment (continuity, wake grid, promotion)
// ---------------------------------------------------------------------------

// A frame for assessLoRainChain from an uplink-shaped input.
function loRainChainFrame(uplink) {
  const id = observationIdentity(uplink, { nowMs: Date.parse(uplink.time) || Date.now() });
  return {
    eventId: id.eventId,
    devAddr: id.devAddr,
    fCnt: id.fCnt,
    timeMs: Date.parse(id.receivedAt),
    fPort: toIntOrNull(uplink.fPort),
    digest: id.digest,
    facts: loRainFrameFacts(uplink.object, payloadRainBlocks(uplink.data)),
  };
}

function isPinned(pinnedBuilds, fPort, buildDate) {
  if (fPort === null || buildDate === null) return false;
  return (pinnedBuilds || []).some((p) => Number(p.fPort) === fPort && String(p.buildDate) === buildDate);
}

function offGrid(deltaS, intervalS) {
  return Math.abs(deltaS - Math.round(deltaS / intervalS) * intervalS);
}

function firstReason(reasons, order) {
  for (const r of order) if (reasons.has(r)) return r;
  return null;
}

// Assess a device's frames together. `frames` in arrival order; results come
// back in the same order. Options: config (recorded before the first frame),
// pinnedBuilds (default PINNED_LORAIN_BUILDS), firstFrameContinuous (the first
// frame directly follows a received frame of its session; the fixtures assume
// it, ingestion does not).
function assessLoRainChain(frames, options = {}) {
  const pinnedBuilds = options.pinnedBuilds || PINNED_LORAIN_BUILDS;
  const firstContinuous = !!options.firstFrameContinuous;
  const work = frames.map((f) => {
    const intr = intrinsicClassification(f.facts);
    return { frame: f, intr, kind: intr.frameKind, additive: intr.additive, nonAdditive: null, reasons: new Set(intr.reasons), state: null, interval: null };
  });

  // Identity: a repeated event, or the same session slot within the replay
  // window, is a duplicate (equal payload) or a conflict (different payload).
  const firstByEvent = new Map();
  const firstBySlot = new Map();
  const repeatOf = new Map();
  const primary = [];
  frames.forEach((f, i) => {
    if (f.eventId && firstByEvent.has(f.eventId)) { repeatOf.set(i, { of: firstByEvent.get(f.eventId), reason: 'duplicate' }); return; }
    const slot = f.devAddr && f.fCnt !== null ? f.devAddr + '/' + f.fCnt : null;
    const prior = slot && firstBySlot.has(slot) ? firstBySlot.get(slot) : null;
    if (prior !== null && Math.abs(frames[prior].timeMs - f.timeMs) < REPLAY_WINDOW_MS) {
      repeatOf.set(i, { of: prior, reason: frames[prior].digest === f.digest ? 'duplicate' : 'identity_conflict' });
      return;
    }
    if (f.eventId) firstByEvent.set(f.eventId, i);
    if (slot) firstBySlot.set(slot, i);
    primary.push(i);
  });

  const ordered = primary.slice().sort((a, b) => frames[a].timeMs - frames[b].timeMs || a - b);
  const state = normalizeConfig(options.config);
  let sessionBuild = state.buildDate;
  let prev = null;
  let anchor = null;
  let lastOffGrid = null;
  let overlapPending = false;
  let transition = null;
  const spans = [];

  for (const k of ordered) {
    const w = work[k];
    const f = w.frame;
    const facts = f.facts;
    const newSession = prev
      ? (f.devAddr !== prev.frame.devAddr || (f.fCnt !== null && prev.frame.fCnt !== null && f.fCnt < prev.frame.fCnt))
      : !firstContinuous;
    const gap = !!prev && !newSession && f.fCnt !== null && prev.frame.fCnt !== null && f.fCnt > prev.frame.fCnt + 1;
    if (newSession) {
      w.reasons.add('session_reset');
      if (prev) sessionBuild = null;
      anchor = null;
      lastOffGrid = null;
      overlapPending = false;
    }
    if (gap) w.reasons.add('frame_gap');

    // Silence longer than the recorded heartbeat bound contradicts the configuration.
    const configKnownBefore = state.confInterval !== null && state.confHeartbeatWakes !== null && !state.stale;
    if (prev && !newSession && !gap && configKnownBefore
      && (f.timeMs - prev.frame.timeMs) / 1000 > state.confHeartbeatWakes * state.confInterval + GRID_TOLERANCE_S) {
      w.reasons.add('config_mismatch');
    }

    // Wake grid: button frames, same-slot pairs, zero reports (T2/T3, T10).
    const gridInterval = state.confInterval || REFERENCE_INTERVAL_S;
    if (facts.hasRain && w.intr.valid) {
      if (!anchor) {
        anchor = w;
      } else {
        const delta = (f.timeMs - anchor.frame.timeMs) / 1000;
        if (offGrid(delta, gridInterval) > GRID_TOLERANCE_S) {
          if (lastOffGrid) {
            // Two consecutive off-grid frames: not a button, the grid itself is in doubt.
            for (const x of [lastOffGrid, w]) {
              x.nonAdditive = null;
              x.kind = x.intr.frameKind;
              x.reasons.delete('overlap_unqualified');
              x.reasons.add('config_mismatch');
            }
            overlapPending = false;
            anchor = w;
            lastOffGrid = null;
          } else {
            w.kind = 'button';
            w.nonAdditive = 'overlap_unqualified';
            w.reasons.add('overlap_unqualified');
            overlapPending = true;
            lastOffGrid = w;
          }
        } else if (delta < gridInterval - GRID_TOLERANCE_S) {
          for (const x of [anchor, w]) {
            x.nonAdditive = 'overlap_unqualified';
            x.reasons.add('overlap_unqualified');
          }
          overlapPending = true;
          lastOffGrid = null;
        } else {
          if (overlapPending) { w.reasons.add('overlap_unqualified'); overlapPending = false; }
          if (w.intr.tips === 0 && !facts.alarm) w.kind = Math.round(delta / gridInterval) === 1 ? 'ordinary' : 'heartbeat_zero';
          if (transition && !facts.hasConfig) {
            if (delta <= (state.confHeartbeatWakes || 0) * gridInterval + GRID_TOLERANCE_S) transition.observed += 1;
            else transition.observed = 0;
          }
          anchor = w;
          lastOffGrid = null;
        }
      }
    }

    // Build and port (promotion condition 3).
    if (facts.buildDate !== null) {
      if (state.buildDate !== null && facts.buildDate !== state.buildDate) state.stale = true;
      state.buildDate = facts.buildDate;
      sessionBuild = facts.buildDate;
    }
    if (f.fPort !== null) {
      if (state.fPort !== null && f.fPort !== state.fPort) state.stale = true;
      state.fPort = f.fPort;
    }
    if (!isPinned(pinnedBuilds, f.fPort, sessionBuild)) w.reasons.add('build_unpinned');

    // Configuration reply (promotion condition 1, T11).
    if (facts.confInterval !== null || facts.confHeartbeatWakes !== null) {
      const changed = (facts.confInterval !== null && state.confInterval !== null && facts.confInterval !== state.confInterval)
        || (facts.confHeartbeatWakes !== null && state.confHeartbeatWakes !== null && facts.confHeartbeatWakes !== state.confHeartbeatWakes);
      if (facts.confInterval !== null) state.confInterval = facts.confInterval;
      if (facts.confHeartbeatWakes !== null) state.confHeartbeatWakes = facts.confHeartbeatWakes;
      state.stale = false;
      if (changed) transition = { observed: 0 };
    }
    if (transition) {
      if (transition.observed >= 2) transition = null;
      else w.reasons.add('config_change');
    }
    if (state.confInterval === null || state.confHeartbeatWakes === null || state.stale) w.reasons.add('received_only');

    w.state = { ...state };
    w.interval = state.confInterval;

    if (prev) {
      const spanReasons = new Set([...w.reasons].filter((r) => SPAN_REASON_ORDER.includes(r)));
      let reason = null;
      if (newSession) reason = 'session_reset';
      else if (gap) reason = 'frame_gap';
      else reason = firstReason(spanReasons, SPAN_REASON_ORDER);
      spans.push({ fromIndex: frames.indexOf(prev.frame), toIndex: k, state: reason ? 'unknown' : 'dry', reason });
    }
    prev = w;
  }

  const observations = work.map((w, i) => {
    const repeat = repeatOf.get(i);
    if (repeat) {
      if (repeat.reason === 'duplicate') {
        const first = finalize(work[repeat.of]);
        return { ...first, counted: false, amountMm: null, status: 'not_additive', reason: 'duplicate', reasons: ['duplicate'] };
      }
      const own = finalize({ ...w, reasons: new Set() });
      return { ...own, counted: false, amountMm: null, status: 'not_additive', intervalBasis: 'unknown',
        measuredStart: null, measuredEnd: null, reason: 'identity_conflict', reasons: ['identity_conflict'] };
    }
    return finalize(w);
  });
  return { observations, spans };
}

function finalize(w) {
  const counted = w.additive && !w.nonAdditive;
  const status = w.intr.status === 'accepted' ? (w.nonAdditive || 'accepted') : w.intr.status;
  const reasons = REASON_ORDER.filter((r) => w.reasons.has(r));
  const verified = counted && reasons.length === 0 && w.interval !== null;
  const endMs = w.frame.timeMs;
  return {
    frameKind: w.kind,
    tips: w.intr.tips,
    amountMm: counted ? amountOf(w.intr.tips) : null,
    counted,
    status,
    intervalBasis: verified ? 'protocol_verified' : 'unknown',
    measuredStart: verified ? new Date(endMs - w.interval * 1000).toISOString() : null,
    measuredEnd: verified ? new Date(endMs).toISOString() : null,
    intervalSeconds: verified ? w.interval : null,
    reason: reasons.length ? reasons[0] : null,
    reasons,
    state: w.state,
  };
}

// ---------------------------------------------------------------------------
// Instrument days: coverage of one farm day of one instrument
// ---------------------------------------------------------------------------
// Contract: docs/contracts/rainfall/zone-day-projection.md ("Instrument days")
// and the coverage rule of lorain.md. Reason codes are the instrument's own
// (lorain.md table, the S2120 and LSN50 counter statuses) plus the coverage
// codes below; a code this module does not know blocks certification.
const COVERAGE_ORDER = ['received_only', 'build_unpinned', 'frame_gap', 'session_reset', 'counter_reset', 'late_counter_frame',
  'boundary_allocation', 'config_change', 'config_mismatch', 'overlap_unqualified', 'multi_block', 'invalid_tips', 'ambiguous_identity'];
const ZONE_REASON_ORDER = ['gauge_ambiguous', 'no_gauge', 'zone_reassigned', 'timezone_invalid', 'timezone_abbreviation'];
// A known part of the period is uncovered, but what was covered is usable.
const PARTIAL_REASONS = new Set(['frame_gap', 'session_reset', 'counter_reset', 'first_sample', 'cumulative_baseline',
  'missing_previous_count', 'zone_reassigned']);
// Frame facts that do not affect a day's coverage.
const NON_BLOCKING_REASONS = new Set(['alarm_event', 'duplicate', 'identity_conflict', 'no_rain_sensor', 'ongoing',
  'timezone_abbreviation']);

function orderReasons(set) {
  const known = COVERAGE_ORDER.filter((r) => set.has(r));
  const zone = ZONE_REASON_ORDER.filter((r) => set.has(r));
  const other = [...set].filter((r) => !COVERAGE_ORDER.includes(r) && !ZONE_REASON_ORDER.includes(r) && r !== 'ongoing').sort();
  return known.concat(other, set.has('ongoing') ? ['ongoing'] : [], zone);
}

function coverageOf(reasons, ongoing) {
  let partial = false;
  for (const r of reasons) {
    if (NON_BLOCKING_REASONS.has(r)) continue;
    if (PARTIAL_REASONS.has(r)) partial = true;
    else return 'unknown';
  }
  if (partial) return 'partial';
  return ongoing ? 'complete_so_far' : 'complete';
}

function frameMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Date.parse(value);
}

// One farm day of one instrument, pure. frames: the instrument's frames in
// arrival order, including at least the last frame before and the first frame
// after the window when they exist: { receivedAt, tips, amountMm, deltaMm,
// cumulativeMm, status, frameKind, intervalBasis, measuredStart, measuredEnd,
// devAddr, fCnt, reasons }. kind 'interval' (LoRain: continuity by fCnt and
// devAddr) or 'cumulative' (a counter register: the delta covers the time
// since the previous reading). cutoffIso: the latest accepted frame of a day
// that has not ended (today), else null. promoted (interval only): false
// marks the device received-only; undefined leaves it to the frames.
// timezoneBasis: the zone timezone's basis, when the caller wants its flag here.
// A day is complete only when one unbroken chain bounds it on both sides, every
// frame of it is verified, and no non-zero interval crosses either boundary;
// its amount is the sum of the verified intervals wholly inside the day.
function assessInstrumentDay({ kind = 'interval', frames = [], window, cutoffIso = null, promoted, timezoneBasis } = {}) {
  const startMs = Date.parse(window.startIso);
  const endMs = Date.parse(window.endIso);
  const sorted = frames.filter((f) => Number.isFinite(frameMs(f.receivedAt)))
    .map((f, i) => ({ f, i, t: frameMs(f.receivedAt) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  let before = null;
  let after = null;
  const inWin = [];
  for (const x of sorted) {
    if (x.t < startMs) before = x;
    else if (x.t < endMs) inWin.push(x);
    else if (!after) after = x;
  }
  const cutoffMs = frameMs(cutoffIso);
  const ongoing = Number.isFinite(cutoffMs) && cutoffMs < endMs;
  const reasons = new Set();
  const accepted = inWin.filter((x) => x.f.status === 'accepted' && x.f.amountMm !== null && x.f.amountMm !== undefined);
  const receivedMm = accepted.length ? roundTo(accepted.reduce((a, x) => a + Number(x.f.amountMm), 0), 3) : null;
  const observedCutoff = accepted.length ? new Date(accepted[accepted.length - 1].t).toISOString() : null;
  const tail = after && !ongoing ? [after] : [];

  if (!inWin.length && !(before && after)) {
    reasons.add('frame_gap');
    if (ongoing) reasons.add('ongoing');
    return { amountMm: null, receivedMm, coverage: 'unknown', reasons: orderReasons(reasons), acceptedCount: 0, observedCutoff };
  }

  // Bounds: a frame before the day starts the chain; a frame at or after its
  // end (or the cutoff of today) closes it.
  if (!before) reasons.add('frame_gap');
  if (!after && !ongoing) reasons.add('frame_gap');

  // Continuity across the chain that covers the day.
  const chain = (before ? [before] : []).concat(inWin, tail);
  if (kind === 'interval') {
    for (let k = 1; k < chain.length; k += 1) {
      const p = chain[k - 1].f;
      const c = chain[k].f;
      if (p.devAddr && c.devAddr && String(p.devAddr) !== String(c.devAddr)) reasons.add('session_reset');
      else if (Number.isInteger(p.fCnt) && Number.isInteger(c.fCnt)) {
        if (c.fCnt < p.fCnt) reasons.add('session_reset');
        else if (c.fCnt > p.fCnt + 1) reasons.add('frame_gap');
      }
    }
    if (promoted === false) reasons.add('received_only');
  }

  // What each frame of the day (and the frame that closes it) says itself.
  for (const x of inWin.concat(tail)) {
    for (const r of Array.isArray(x.f.reasons) ? x.f.reasons : []) reasons.add(String(r));
    if (x.f.status === 'ambiguous_identity' && kind === 'interval') reasons.add('ambiguous_identity');
  }

  // Allocation: verified intervals wholly inside the day count; a non-zero
  // interval across a boundary (or a non-zero edge frame without verified
  // bounds) cannot be split.
  let amount = 0;
  const firstRain = inWin.find((x) => x.f.amountMm !== null && x.f.amountMm !== undefined);
  for (const x of inWin.concat(tail)) {
    const mm = x.f.amountMm;
    if (mm === null || mm === undefined || x.f.status !== 'accepted') continue;
    const value = Number(mm);
    if (value === 0) continue;
    const ms = frameMs(x.f.measuredStart);
    const me = frameMs(x.f.measuredEnd);
    const verified = x.f.intervalBasis === 'protocol_verified' && Number.isFinite(ms) && Number.isFinite(me);
    if (!verified) {
      if (x === firstRain || x === after) reasons.add('boundary_allocation');
      continue;
    }
    if ((ms < startMs && me > startMs) || (ms < endMs && me > endMs)) reasons.add('boundary_allocation');
    else if (ms >= startMs && me <= endMs) amount += value;
  }

  if (timezoneBasis === 'invalid') reasons.add('timezone_invalid');
  if (timezoneBasis === 'abbreviation') reasons.add('timezone_abbreviation');
  if (ongoing) reasons.add('ongoing');
  const coverage = coverageOf(reasons, ongoing);
  return {
    amountMm: coverage === 'complete' || coverage === 'complete_so_far' ? roundTo(amount, 3) : null,
    receivedMm,
    coverage,
    reasons: orderReasons(reasons),
    acceptedCount: accepted.length,
    observedCutoff,
  };
}

// ---------------------------------------------------------------------------
// Configuration query (authorised, NOT bench-verified; sender flag defaults off)
// ---------------------------------------------------------------------------

function loRainConfigQueryBytes(fPort) {
  const hex = LORAIN_CONFIG_QUERY_HEX[Number(fPort)];
  return hex ? Buffer.from(hex, 'hex') : null;
}

function buildLoRainConfigQueryDownlink({ applicationId, deveui, fPort } = {}) {
  const bytes = loRainConfigQueryBytes(fPort);
  const app = String(applicationId || '').trim();
  const eui = String(deveui || '').trim().toLowerCase();
  if (!bytes || !app || !/^[0-9a-f]{16}$/.test(eui)) return null;
  return {
    topic: 'application/' + app + '/device/' + eui + '/command/down',
    payload: { devEui: eui, confirmed: false, fPort: Number(fPort), data: bytes.toString('base64') },
  };
}

// ---------------------------------------------------------------------------
// SenseCAP S2120: measurement parsing and counter derivation
// ---------------------------------------------------------------------------
// Moved verbatim from the s2120-process-fn node of the S2120 rain contract fix.
// Rain contract (SenseCAP S2120 user guide 10.2, 10.3.1, 13.3):
// 4113 = rainfall intensity in mm/h (six times the rain of the past ten
// minutes); 4213 = cumulative rainfall in mm (frame 4C, firmware v2.0+).
// 4213 is differenced as a counter; 4113 is stored as the rain rate and is
// never a counter. Without 4213 (firmware before v2.0), intensity / 6 is the
// interval amount only when the time since the previous rain uplink is the
// vendor's ten-minute window within S2120_LEGACY_TOLERANCE_S; any other interval
// leaves the amount unknown (intensity_only). Once a device has a counter
// baseline it never integrates intensity, so no rain is counted twice.
// The first 4213 row of a device is marked cumulative_baseline; rows before
// it may hold 4113 values from older ingest and are never a counter baseline.
const S2120_TYPE_ID = 'SENSECAP_S2120';
const S2120_RAIN_SOURCE = 'sensecap_s2120';
const S2120_LEGACY_WINDOW_S = 600;
const S2120_LEGACY_TOLERANCE_S = 60;
const S2120_COUNTER_BASELINE = 'cumulative_baseline';

function normalizePressureHpa(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 2000 ? n / 100 : n;
}

function roundTo(value, digits) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = Math.pow(10, digits || 0);
  return Math.round(numeric * factor) / factor;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Flatten decoded message groups by measurementId. ChirpStack codec versions
// have used both shapes (object.messages and object.data.messages).
function parseS2120Measurements(object) {
  const measurements = {};
  const messageSources = [
    object?.messages,
    object?.data?.messages,
  ].filter(Array.isArray);
  const messages = [];
  for (const source of messageSources) {
    for (const group of source) {
      messages.push(Array.isArray(group) ? group : [group]);
    }
  }
  for (const group of messages) {
    for (const m of group) {
      if (m && m.measurementId != null) {
        measurements[String(m.measurementId)] = m.measurementValue;
      }
      if (m && typeof m['Battery(%)'] === 'number') {
        measurements.bat_pct = m['Battery(%)'];
      }
    }
  }
  return {
    measurements,
    ambientTemperature: measurements['4097'] ?? null,
    relativeHumidity: measurements['4098'] ?? null,
    lightLux: measurements['4099'] ?? null,
    barometricPressureHpa: normalizePressureHpa(measurements['4101']),
    windDirectionDeg: measurements['4104'] ?? null,
    windSpeedMps: measurements['4105'] ?? null,
    windGustMps: measurements['4191'] ?? null,
    uvIndex: measurements['4190'] ?? null,
    rainGaugeCumulativeMm: finiteOrNull(measurements['4213']),
    rainMmPerHour: finiteOrNull(measurements['4113']),
    batPct: measurements['4103'] ?? measurements.bat_pct ?? null,
  };
}

// The 4213 counter step: previous counter value (from the device's counter
// baseline on) against the current one. hasBaseline=false means the device has
// no cumulative_baseline row yet, so this row becomes it; intervalSeconds, when
// given, must be a positive number of seconds since the previous counter row.
function deriveS2120Counter(prevMm, currentMm, { hasBaseline = true, intervalSeconds } = {}) {
  if (currentMm == null) return { deltaMm: null, status: 'no_rain_sensor' };
  if (!hasBaseline) return { deltaMm: null, status: S2120_COUNTER_BASELINE };
  if (prevMm == null) return { deltaMm: null, status: 'first_sample' };
  if (intervalSeconds !== undefined && intervalSeconds == null) return { deltaMm: null, status: 'invalid_interval' };
  if (currentMm < prevMm) return { deltaMm: null, status: 'counter_reset' };
  return { deltaMm: roundTo(currentMm - prevMm, 3), status: 'ok' };
}

// Firmware without 4213: the reported intensity covers the vendor's ten-minute
// window, so it is an interval amount only when the uplink interval is that
// window (within the tolerance). A device with a counter baseline never
// integrates intensity.
function deriveS2120Legacy(intensityMmH, { hasBaseline = false, hasPrevious = false, intervalSeconds } = {}) {
  if (hasBaseline) return { deltaMm: null, status: 'intensity_only' };
  if (!hasPrevious) return { deltaMm: null, status: 'first_sample' };
  if (intervalSeconds == null) return { deltaMm: null, status: 'invalid_interval' };
  if (Math.abs(intervalSeconds - S2120_LEGACY_WINDOW_S) <= S2120_LEGACY_TOLERANCE_S) {
    return { deltaMm: roundTo((intensityMmH * S2120_LEGACY_WINDOW_S) / 3600, 3), status: 'ok' };
  }
  return { deltaMm: null, status: 'intensity_only' };
}

// ---------------------------------------------------------------------------
// Ingestion (inside the caller's transaction)
// ---------------------------------------------------------------------------

const DEVICE_SQL = "SELECT d.deveui, d.type_id, d.irrigation_zone_id AS zone_id, iz.zone_uuid, COALESCE(iz.timezone, 'UTC') AS timezone "
  + 'FROM devices d LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL '
  + 'WHERE d.deveui = ? AND d.deleted_at IS NULL';

function parseJson(text) {
  if (!text) return {};
  try { return JSON.parse(text) || {}; } catch (_badJson) { return {}; }
}

function rowFrame(row) {
  const cfg = parseJson(row.config_json);
  const frame = cfg.frame || {};
  return {
    rowId: row.id,
    eventId: row.event_id || null,
    devAddr: row.dev_addr || null,
    fCnt: row.f_cnt === null || row.f_cnt === undefined ? null : Number(row.f_cnt),
    timeMs: Date.parse(row.received_at),
    fPort: toIntOrNull(frame.fPort),
    digest: row.payload_digest,
    facts: {
      hasRain: !!frame.hasRain,
      tipsRaw: frame.tipsRaw === undefined ? null : frame.tipsRaw,
      multiBlock: !!frame.multiBlock,
      rainBlocks: Array.isArray(frame.rainBlocks) ? frame.rainBlocks : null,
      alarm: !!frame.alarm,
      hasConfig: !!frame.hasConfig,
      confInterval: positiveIntOrNull(frame.confInterval),
      confHeartbeatWakes: positiveIntOrNull(frame.confHeartbeatWakes),
      buildDate: frame.buildDate ? String(frame.buildDate) : null,
    },
  };
}

function frameJson(fPort, facts) {
  return {
    fPort, hasRain: facts.hasRain, tipsRaw: facts.tipsRaw, multiBlock: facts.multiBlock, rainBlocks: facts.rainBlocks,
    alarm: facts.alarm, hasConfig: facts.hasConfig, confInterval: facts.confInterval,
    confHeartbeatWakes: facts.confHeartbeatWakes, buildDate: facts.buildDate,
  };
}

// Stored fields of an observation from its chain result.
function storedFields(row, result) {
  const status = !row.event_id && result.status === 'accepted' ? 'ambiguous_identity' : result.status;
  const cfg = parseJson(row.config_json);
  const config = { frame: cfg.frame, state: result.state };
  if (cfg.query) config.query = cfg.query;
  if (cfg.zones) config.zones = cfg.zones;
  return {
    status,
    frame_kind: result.frameKind,
    tips: isValidTips(result.tips) ? result.tips : null,
    amount_mm: result.counted ? result.amountMm : null,
    interval_basis: result.intervalBasis,
    measured_start: result.measuredStart,
    measured_end: result.measuredEnd,
    quality_reasons: JSON.stringify(result.reasons),
    config_json: JSON.stringify(config),
    intervalSeconds: result.intervalSeconds,
  };
}

const STORED_KEYS = ['status', 'frame_kind', 'tips', 'amount_mm', 'interval_basis', 'measured_start', 'measured_end', 'quality_reasons', 'config_json'];

function deviceDataRainFields(fields) {
  const ok = fields.status === 'accepted';
  const verified = ok && fields.interval_basis === 'protocol_verified' && fields.intervalSeconds;
  return {
    rain_tips_delta: ok ? fields.tips : null,
    rain_mm_delta: ok ? fields.amount_mm : null,
    rain_mm_per_hour: verified ? Math.round((fields.amount_mm / fields.intervalSeconds) * 3600 * 1000) / 1000 : null,
    counter_interval_seconds: verified ? fields.intervalSeconds : null,
    rain_delta_status: DELTA_STATUS[fields.status] || null,
  };
}

async function lastInsertId(t) {
  const row = await t.get('SELECT last_insert_rowid() AS id');
  return row ? Number(row.id) : null;
}

// Re-assess the device's LoRain observations received in [fromIso, toIso)
// with context before it; update the rows (and their device_data rows) that
// changed. Only AQUASCOPE_LORAIN rows: the LoRain chain never runs on another
// instrument's observations. Returns the zone days whose totals may have changed.
async function reassessLoRain(t, deveui, fromIso, toIso, { pinnedBuilds, newObservationId } = {}) {
  const contextIso = new Date(Date.parse(fromIso) - CONTEXT_LOOKBACK_MS).toISOString();
  const before = await t.get(
    'SELECT * FROM rain_observations WHERE deveui = ? AND instrument_type = ? AND received_at < ? ORDER BY received_at DESC, id DESC LIMIT 1',
    [deveui, LORAIN_TYPE_ID, contextIso]);
  const rows = await t.all(
    'SELECT * FROM rain_observations WHERE deveui = ? AND instrument_type = ? AND received_at >= ? AND received_at < ? ORDER BY received_at, id',
    [deveui, LORAIN_TYPE_ID, contextIso, toIso]);
  const all = before ? [before].concat(rows) : rows;
  if (!all.length) return { changedDays: [] };
  const priorState = before ? parseJson(before.config_json).state : null;
  const { observations } = assessLoRainChain(all.map(rowFrame), { config: priorState, pinnedBuilds, firstFrameContinuous: false });
  const changedDays = [];
  for (let i = 0; i < all.length; i += 1) {
    const row = all[i];
    if (row.received_at < fromIso) continue;
    const fields = storedFields(row, observations[i]);
    const changed = STORED_KEYS.filter((key) => fields[key] !== (row[key] === undefined ? null : row[key]));
    if (!changed.length) continue;
    await t.run('UPDATE rain_observations SET ' + changed.map((key) => key + ' = ?').join(', ') + ' WHERE id = ?',
      changed.map((key) => fields[key]).concat([row.id]));
    const before2 = deviceDataRainFields({ ...row, intervalSeconds: row.measured_start && row.measured_end
      ? Math.round((Date.parse(row.measured_end) - Date.parse(row.measured_start)) / 1000) : null });
    const after = deviceDataRainFields(fields);
    const ddKeys = Object.keys(after).filter((key) => after[key] !== before2[key]);
    if (row.device_data_id && ddKeys.length) {
      await t.run('UPDATE device_data SET ' + ddKeys.map((key) => key + ' = ?').join(', ') + ' WHERE id = ?',
        ddKeys.map((key) => after[key]).concat([row.device_data_id]));
    }
    // Any change of a stored field can change the coverage of the day the
    // frame belongs to (a closed gap, a withdrawn amount); the new
    // observation's own day is recomputed by the caller.
    if (row.id !== newObservationId) {
      changedDays.push({ zones: observationZones(row), receivedAt: row.received_at });
    }
  }
  return { changedDays };
}

// The device's received amount in its zone-local day: accepted observations
// plus legacy device_data rows written before observations existed.
async function loRainDayTotal(t, deveui, zoneId, startIso, endIso, upToIso) {
  const until = upToIso || endIso;
  const inclusive = !!upToIso;
  const obs = await t.get(
    'SELECT COALESCE(SUM(amount_mm), 0) AS mm FROM rain_observations WHERE deveui = ? AND zone_id IS ? AND status = \'accepted\' '
    + 'AND amount_mm IS NOT NULL AND received_at >= ? AND received_at ' + (inclusive ? '<=' : '<') + ' ? AND received_at < ?',
    [deveui, zoneId, startIso, until, endIso]);
  const legacy = await t.get(
    'SELECT COALESCE(SUM(dd.rain_mm_delta), 0) AS mm FROM device_data dd WHERE dd.deveui = ? AND dd.rain_delta_status = \'ok\' '
    + 'AND dd.rain_mm_delta IS NOT NULL AND dd.recorded_at >= ? AND dd.recorded_at ' + (inclusive ? '<=' : '<') + ' ? AND dd.recorded_at < ? '
    + 'AND NOT EXISTS (SELECT 1 FROM rain_observations o WHERE o.device_data_id = dd.id)',
    [deveui, startIso, until, endIso]);
  return Math.round(((Number(obs && obs.mm) || 0) + (Number(legacy && legacy.mm) || 0)) * 10) / 10;
}

// One query at commissioning and one after a firmware upgrade, never an
// automatic resend (contract, "Configuration query"). The latest recorded
// query covers its build date; a query recorded before any 0x0A frame was
// seen covers the first build date observed after it. A further query is
// planned only when a known build date differs from the covered one (an
// upgrade). A missing reply is never a reason to send again.
async function planConfigQuery(t, deveui, fPort, state, nowMs) {
  if (!loRainConfigQueryBytes(fPort)) return null;
  if (state && state.confInterval && state.confHeartbeatWakes && !state.stale) return null;
  const buildDate = state && state.buildDate ? String(state.buildDate) : '';
  const last = await t.get(
    "SELECT id, received_at, json_extract(config_json, '$.query.buildDate') AS build FROM rain_observations "
    + "WHERE deveui = ? AND json_extract(config_json, '$.query.requestedAt') IS NOT NULL ORDER BY received_at DESC, id DESC LIMIT 1",
    [deveui]);
  if (last) {
    let covered = last.build ? String(last.build) : '';
    if (!covered) {
      const first = await t.get(
        "SELECT json_extract(config_json, '$.frame.buildDate') AS build FROM rain_observations WHERE deveui = ? "
        + "AND (received_at > ? OR (received_at = ? AND id >= ?)) AND json_extract(config_json, '$.frame.buildDate') IS NOT NULL "
        + 'ORDER BY received_at, id LIMIT 1', [deveui, last.received_at, last.received_at, last.id]);
      covered = first && first.build ? String(first.build) : '';
    }
    if (!covered || !buildDate || buildDate === covered) return null;
  }
  return { requestedAt: new Date(nowMs).toISOString(), buildDate };
}

// Ingest one LoRain uplink inside the caller's transaction: claim the
// observation identity, re-assess the affected frames, persist the telemetry
// row, link it, and update the zone days. Any throw rolls all of it back.
// uplink = { deveui, eventId, devAddr, fCnt, time, fPort, data, object,
// applicationId }; opts = { nowMs, pinnedBuilds, configQueryEnabled }.
async function ingestLoRainUplink(t, uplink, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const pinnedBuilds = opts.pinnedBuilds || PINNED_LORAIN_BUILDS;
  const none = (outcome, observationId) => ({ outcome, status: null, observationId: observationId || null, deviceDataId: null, zoneDays: [], configQuery: null });
  const id = observationIdentity(uplink, { nowMs });
  if (!id.deveui) return none('ignored');
  const device = await t.get(DEVICE_SQL, [id.deveui]);
  if (!device || device.type_id !== LORAIN_TYPE_ID) return none('ignored');

  const claim = await claimObservationIdentity(t, id);
  if (claim) return none(claim.outcome, claim.observationId);

  const fPort = toIntOrNull(uplink.fPort);
  const facts = loRainFrameFacts(uplink.object, payloadRainBlocks(uplink.data));
  const intr = intrinsicClassification(facts);
  const timezone = formatterFor(device.timezone).timezone;
  const zoneIds = (await gaugeZones(t, id.deveui)).map((z) => Number(z.zone_id));
  await t.run(
    'INSERT INTO rain_observations (deveui, instrument_type, event_id, dev_addr, f_cnt, payload_digest, received_at, interval_basis, '
    + 'frame_kind, tips, amount_mm, status, quality_reasons, config_json, zone_id, zone_uuid, timezone, source_policy_version) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, \'unknown\', ?, ?, NULL, ?, \'[]\', ?, ?, ?, ?, ?)',
    [id.deveui, LORAIN_TYPE_ID, id.eventId, id.devAddr, id.fCnt, id.digest, id.receivedAt, intr.frameKind,
      isValidTips(intr.tips) ? intr.tips : null, intr.status, JSON.stringify({ frame: frameJson(fPort, facts), state: null, zones: zoneIds }),
      device.zone_id, device.zone_uuid, timezone, RAIN_POLICY_VERSION]);
  const observationId = await lastInsertId(t);

  const receivedMs = Date.parse(id.receivedAt);
  const { changedDays } = await reassessLoRain(t, id.deveui,
    new Date(receivedMs - RECOMPUTE_BACK_MS).toISOString(), new Date(receivedMs + RECOMPUTE_FORWARD_MS).toISOString(), { pinnedBuilds, newObservationId: observationId });
  const obs = await t.get('SELECT * FROM rain_observations WHERE id = ?', [observationId]);
  const intervalSeconds = obs.measured_start && obs.measured_end
    ? Math.round((Date.parse(obs.measured_end) - Date.parse(obs.measured_start)) / 1000) : null;
  const rain = deviceDataRainFields({ ...obs, intervalSeconds });
  let rainToday = null;
  if (rain.rain_delta_status === 'ok') {
    const win = zoneDayWindow(id.receivedAt, timezone);
    rainToday = await loRainDayTotal(t, id.deveui, device.zone_id === undefined ? null : device.zone_id, win.startIso, win.endIso, id.receivedAt);
  }
  const o = uplink.object || {};
  const temperature = Number.isFinite(o.ambient_temperature) ? o.ambient_temperature
    : (Number.isFinite(o.temperature_C) ? o.temperature_C : null);
  await t.run(
    'INSERT INTO device_data (deveui, recorded_at, ambient_temperature, bat_v, rain_tips_delta, rain_mm_delta, rain_mm_per_hour, '
    + 'rain_mm_per_10min, rain_mm_today, counter_interval_seconds, rain_delta_status) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
    [id.deveui, id.receivedAt, temperature, Number.isFinite(o.bat_v) ? o.bat_v : null, rain.rain_tips_delta, rain.rain_mm_delta,
      rain.rain_mm_per_hour, rainToday, rain.counter_interval_seconds, rain.rain_delta_status]);
  const deviceDataId = await lastInsertId(t);
  await t.run('UPDATE rain_observations SET device_data_id = ? WHERE id = ?', [deviceDataId, observationId]);

  let configQuery = null;
  if (opts.configQueryEnabled) {
    const state = parseJson(obs.config_json).state || null;
    const query = await planConfigQuery(t, id.deveui, fPort, state, nowMs);
    if (query) {
      const cfg = parseJson(obs.config_json);
      cfg.query = query;
      await t.run('UPDATE rain_observations SET config_json = ? WHERE id = ?', [JSON.stringify(cfg), observationId]);
      configQuery = buildLoRainConfigQueryDownlink({ applicationId: uplink.applicationId, deveui: id.deveui, fPort });
    }
  }

  // Instrument and zone days: the frame's own day, the day of the frame before
  // it in the zones that frame was received under (this frame may close it),
  // and every day a re-assessment changed.
  const items = changedDays.map((d) => ({ ...d, trigger: 'reassessed' }));
  items.push({ receivedAt: id.receivedAt, zones: zoneIds, trigger: obs.status === 'accepted' ? 'accepted' : 'reassessed',
    amountMm: obs.amount_mm === null ? null : Number(obs.amount_mm) });
  const previous = await t.get('SELECT received_at, zone_id, config_json FROM rain_observations WHERE deveui = ? AND instrument_type = ? AND received_at < ? '
    + 'ORDER BY received_at DESC, id DESC LIMIT 1', [id.deveui, LORAIN_TYPE_ID, id.receivedAt]);
  if (previous) items.push({ receivedAt: previous.received_at, zones: observationZones(previous), trigger: 'reassessed' });
  const zoneDays = await recomputeRainDays(t, id.deveui, items, { nowMs });
  return { outcome: 'accepted', status: obs.status, observationId, deviceDataId, zoneDays, configQuery };
}

// The durable identity check both writers run first: the same deduplicationId
// with the same payload is a duplicate, with another payload a quarantined
// conflict; the same devAddr + fCnt within REPLAY_WINDOW_MS likewise (a
// confirmed-uplink retransmission carries a new deduplicationId). Returns null
// when the uplink is new.
async function claimObservationIdentity(t, id) {
  if (id.eventId) {
    const existing = await t.get('SELECT id, payload_digest FROM rain_observations WHERE deveui = ? AND event_id = ?', [id.deveui, id.eventId]);
    if (existing) {
      if (existing.payload_digest === id.digest) return { outcome: 'duplicate', observationId: existing.id };
      await quarantineConflict(t, id);
      return { outcome: 'conflict', observationId: existing.id };
    }
  }
  if (id.devAddr && id.fCnt !== null) {
    const slot = await t.all(
      'SELECT id, payload_digest FROM rain_observations WHERE deveui = ? AND dev_addr = ? AND f_cnt = ? '
      + 'AND ABS(julianday(received_at) - julianday(?)) < (1.0 / 24) ORDER BY id', [id.deveui, id.devAddr, id.fCnt, id.receivedAt]);
    const same = slot.find((r) => r.payload_digest === id.digest);
    if (same) return { outcome: 'duplicate', observationId: same.id };
    if (slot.length) {
      await quarantineConflict(t, id);
      return { outcome: 'conflict', observationId: slot[0].id };
    }
  }
  return null;
}

async function quarantineConflict(t, id) {
  await t.run("INSERT INTO ingest_quarantine (deveui, channel, reason, raw_value) VALUES (?, 'rain_observation', 'identity_conflict', ?)",
    [id.deveui, JSON.stringify({ eventId: id.eventId, devAddr: id.devAddr, fCnt: id.fCnt, digest: id.digest, receivedAt: id.receivedAt })]);
}

// ---------------------------------------------------------------------------
// SenseCAP S2120 ingestion (inside the caller's transaction)
// ---------------------------------------------------------------------------
// One writer per uplink: identity claim, counter read, derivation, device_data
// row, observation row and zone days in the caller's transaction. Because the
// osiDb operation queue runs one transaction at a time, two uplinks of one
// device can no longer both read the same previous counter value.
//
// rain_observations for S2120 (one row per uplink with an identity):
//   frame_kind  'counter' (4213 present), 'ordinary' (4113 only, firmware
//               before v2.0), 'status' (no rain measurement);
//   status      'accepted' for a counted increment (amount_mm = the increment,
//               a measured zero included), 'ambiguous_identity' without a
//               deduplicationId, otherwise 'not_additive';
//   interval    a 4213 difference covers [previous counter row, this row]:
//               'protocol_verified'; a legacy intensity window tiles the
//               interval only within the tolerance: 'reception_gap';
//   reasons     the device_data rain_delta_status of a row that is not counted;
//               a frame older than the device's latest rain row also carries
//               'late_counter_frame' (counter frames) and is never counted.
//               Its difference against its own predecessor is kept in
//               config_json.counter.differenceMm; the following row's
//               increment is not rewritten.
const S2120_DEVICE_SQL = 'SELECT d.deveui, d.type_id, d.irrigation_zone_id AS zone_id, iz.zone_uuid, iz.timezone AS zone_timezone, '
  + '(SELECT iz2.timezone FROM weather_station_zones w JOIN irrigation_zones iz2 ON iz2.id = w.zone_id AND iz2.deleted_at IS NULL '
  + 'WHERE w.deveui = d.deveui ORDER BY w.zone_id LIMIT 1) AS station_timezone '
  + 'FROM devices d LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL '
  + 'WHERE d.deveui = ? AND d.deleted_at IS NULL';
// Zones an S2120 reports rain to: its weather-station assignments, else the
// zone it is installed in (as the zone aggregation always did).
const S2120_STATION_ZONES_SQL = "SELECT wsz.zone_id, iz.zone_uuid, COALESCE(iz.timezone, 'UTC') AS timezone FROM weather_station_zones wsz "
  + 'LEFT JOIN irrigation_zones iz ON iz.id = wsz.zone_id WHERE wsz.deveui = ? ORDER BY wsz.zone_id';
const S2120_DEVICE_ZONE_SQL = "SELECT d.irrigation_zone_id AS zone_id, iz.zone_uuid, COALESCE(iz.timezone, 'UTC') AS timezone FROM devices d "
  + 'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id WHERE d.deveui = ? AND d.irrigation_zone_id IS NOT NULL AND d.deleted_at IS NULL';
// A rain row of the device: a stored counter or rate whose identity is known.
const S2120_RAIN_ROW = "(rain_gauge_cumulative_mm IS NOT NULL OR rain_mm_per_hour IS NOT NULL) AND rain_delta_status IS NOT 'ambiguous_identity'";

function s2120Seconds(fromIso, toIso) {
  const fromMs = fromIso ? Date.parse(fromIso) : NaN;
  const toMs = Date.parse(toIso);
  const seconds = Number.isFinite(fromMs) && Number.isFinite(toMs) ? Math.round((toMs - fromMs) / 1000) : null;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function numericOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Counter-baseline marker: the device's first cumulative_baseline row. The
// lookup scans the device's history, so its result (time or null) is cached
// per DevEUI by the caller (markerCache { get(eui), set(eui, value) }, node
// context in the flow); this writer is its only producer. A cached marker
// with no counter row behind it (rows deleted) is looked up again.
async function loadS2120RainContext(t, deveui, receivedAt, markerCache) {
  const findMarker = () => t.get(
    "SELECT recorded_at FROM device_data WHERE deveui = ? AND rain_delta_status = 'cumulative_baseline' ORDER BY recorded_at ASC LIMIT 1",
    [deveui]);
  const findCounter = (m) => (m ? t.get(
    'SELECT recorded_at, rain_gauge_cumulative_mm FROM device_data WHERE deveui = ? AND recorded_at < ? AND rain_gauge_cumulative_mm IS NOT NULL '
    + "AND recorded_at >= ? AND rain_delta_status IS NOT 'ambiguous_identity' ORDER BY recorded_at DESC LIMIT 1",
    [deveui, receivedAt, m.recorded_at]) : Promise.resolve(undefined));
  const cached = markerCache ? markerCache.get(deveui) : undefined;
  let marker = cached === undefined ? await findMarker() : (cached ? { recorded_at: cached } : null);
  const future = await t.get('SELECT recorded_at FROM device_data WHERE deveui = ? AND recorded_at >= ? AND ' + S2120_RAIN_ROW
    + ' ORDER BY recorded_at ASC LIMIT 1', [deveui, receivedAt]);
  const previous = await t.get('SELECT recorded_at FROM device_data WHERE deveui = ? AND recorded_at < ? AND ' + S2120_RAIN_ROW
    + ' ORDER BY recorded_at DESC LIMIT 1', [deveui, receivedAt]);
  let counter = await findCounter(marker);
  let lookedUp = cached === undefined;
  if (cached && !counter && !future) {
    marker = await findMarker();
    counter = await findCounter(marker);
    lookedUp = true;
  }
  if (lookedUp && markerCache) markerCache.set(deveui, (marker && marker.recorded_at) || null);
  return { marker: marker || null, future: future || null, previous: previous || null, counter: counter || null };
}

// Rain fields of one S2120 uplink (R-S2120 rules, unchanged): a frame at or
// before the device's latest rain row is a duplicate timestamp or out of
// order and is never counted; otherwise 4213 is differenced from the counter
// baseline on, and without 4213 the legacy window rule applies.
async function deriveS2120Rain(t, deveui, receivedAt, m, markerCache) {
  const cumulative = m.rainGaugeCumulativeMm;
  const rate = m.rainMmPerHour;
  const out = { status: 'no_rain_sensor', deltaMm: null, per10Mm: null, intervalSeconds: null, late: false, previousAt: null, previousMm: null, differenceMm: null };
  if (cumulative == null && rate == null) return out;
  const ctx = await loadS2120RainContext(t, deveui, receivedAt, markerCache);
  if (ctx.future) {
    out.status = ctx.future.recorded_at === receivedAt ? 'duplicate_timestamp' : 'out_of_order';
    out.late = true;
    if (cumulative != null && ctx.counter) {
      out.previousAt = ctx.counter.recorded_at;
      out.previousMm = Number(ctx.counter.rain_gauge_cumulative_mm);
      out.differenceMm = deriveS2120Counter(out.previousMm, cumulative).deltaMm;
    }
    return out;
  }
  if (cumulative != null) {
    const previousMm = ctx.counter ? Number(ctx.counter.rain_gauge_cumulative_mm) : null;
    out.intervalSeconds = s2120Seconds(ctx.counter && ctx.counter.recorded_at, receivedAt);
    out.previousAt = ctx.counter ? ctx.counter.recorded_at : null;
    out.previousMm = previousMm;
    const d = deriveS2120Counter(previousMm, cumulative, { hasBaseline: !!ctx.marker, intervalSeconds: out.intervalSeconds });
    out.status = d.status;
    out.deltaMm = d.deltaMm;
    if (d.status === S2120_COUNTER_BASELINE && markerCache) markerCache.set(deveui, receivedAt);
    if (d.status === 'ok') out.per10Mm = roundTo((d.deltaMm / out.intervalSeconds) * 600, 3);
    return out;
  }
  const intervalSeconds = ctx.marker || !ctx.previous ? null : s2120Seconds(ctx.previous.recorded_at, receivedAt);
  const d = deriveS2120Legacy(rate, { hasBaseline: !!ctx.marker, hasPrevious: !!ctx.previous, intervalSeconds });
  out.intervalSeconds = intervalSeconds;
  out.previousAt = ctx.previous ? ctx.previous.recorded_at : null;
  out.status = d.status;
  out.deltaMm = d.deltaMm;
  if (d.status === 'ok') out.per10Mm = d.deltaMm;
  return out;
}

// The device's received S2120 rain in [startIso, until): counted increments.
async function s2120DayTotal(t, deveui, startIso, until, inclusive) {
  const row = await t.get(
    "SELECT COALESCE(SUM(rain_mm_delta), 0) AS mm FROM device_data WHERE deveui = ? AND rain_delta_status = 'ok' AND rain_mm_delta IS NOT NULL "
    + 'AND recorded_at >= ? AND recorded_at ' + (inclusive ? '<=' : '<') + ' ?', [deveui, startIso, until]);
  return roundTo(Number(row && row.mm) || 0, 3);
}

// Ingest one S2120 uplink inside the caller's transaction. uplink = { deveui,
// eventId, devAddr, fCnt, time, fPort, data, object }; opts = { nowMs,
// markerCache }. Same return shape as ingestLoRainUplink, plus the stored
// rain fields (rainDeltaStatus, rainMmDelta) for the node status.
async function ingestS2120Uplink(t, uplink, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const none = (outcome, observationId) => ({ outcome, status: null, observationId: observationId || null, deviceDataId: null, zoneDays: [], configQuery: null });
  const id = observationIdentity(uplink, { nowMs });
  if (!id.deveui) return none('ignored');
  const device = await t.get(S2120_DEVICE_SQL, [id.deveui]);
  if (!device || device.type_id !== S2120_TYPE_ID) return none('ignored');
  const claim = await claimObservationIdentity(t, id);
  if (claim) return none(claim.outcome, claim.observationId);

  const m = parseS2120Measurements(uplink.object);
  const hasRain = m.rainGaugeCumulativeMm != null || m.rainMmPerHour != null;
  let rain;
  if (hasRain && !id.eventId) {
    rain = { status: 'ambiguous_identity', deltaMm: null, per10Mm: null, intervalSeconds: null, late: false, previousAt: null, previousMm: null, differenceMm: null };
  } else {
    rain = await deriveS2120Rain(t, id.deveui, id.receivedAt, m, opts.markerCache);
  }
  const counted = rain.status === 'ok' && rain.deltaMm !== null;
  // The device's farm day: its zone, else its first weather-station zone, else UTC.
  const timezone = formatterFor(device.zone_timezone || device.station_timezone || 'UTC').timezone;
  let rainToday = null;
  if (hasRain && rain.status !== 'ambiguous_identity') {
    const win = zoneDayWindow(id.receivedAt, timezone);
    rainToday = roundTo((await s2120DayTotal(t, id.deveui, win.startIso, id.receivedAt, false)) + (counted ? rain.deltaMm : 0), 3);
  }

  let zones = await t.all(S2120_STATION_ZONES_SQL, [id.deveui]);
  if (!zones.length) zones = await t.all(S2120_DEVICE_ZONE_SQL, [id.deveui]);
  const snapshot = zones[0] || null;
  const zoneIds = (await gaugeZones(t, id.deveui)).map((z) => Number(z.zone_id));
  const frameKind = m.rainGaugeCumulativeMm != null ? 'counter' : (m.rainMmPerHour != null ? 'ordinary' : 'status');
  let status = counted ? 'accepted' : 'not_additive';
  if (!id.eventId) status = 'ambiguous_identity';
  const reasons = [];
  if (rain.late && frameKind === 'counter') reasons.push('late_counter_frame');
  if (!counted) reasons.push(rain.status);
  else if (frameKind === 'ordinary') reasons.push('legacy_intensity_window');
  let intervalBasis = 'unknown';
  let measuredStart = null;
  let measuredEnd = null;
  if (counted && frameKind === 'counter') {
    intervalBasis = 'protocol_verified';
    measuredStart = rain.previousAt;
    measuredEnd = id.receivedAt;
  } else if (counted) {
    intervalBasis = 'reception_gap';
    measuredStart = new Date(Date.parse(id.receivedAt) - S2120_LEGACY_WINDOW_S * 1000).toISOString();
    measuredEnd = id.receivedAt;
  }
  const config = {
    frame: { fPort: toIntOrNull(uplink.fPort), cumulativeMm: m.rainGaugeCumulativeMm, intensityMmH: m.rainMmPerHour },
    counter: { previousAt: rain.previousAt, previousMm: rain.previousMm, differenceMm: rain.differenceMm },
    zones: zoneIds,
  };
  await t.run(
    'INSERT INTO rain_observations (deveui, instrument_type, event_id, dev_addr, f_cnt, payload_digest, received_at, measured_start, measured_end, '
    + 'interval_basis, frame_kind, tips, amount_mm, status, quality_reasons, config_json, zone_id, zone_uuid, timezone, source_policy_version) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id.deveui, S2120_TYPE_ID, id.eventId, id.devAddr, id.fCnt, id.digest, id.receivedAt, measuredStart, measuredEnd,
      intervalBasis, frameKind, counted ? rain.deltaMm : null, status, JSON.stringify(reasons), JSON.stringify(config),
      snapshot ? snapshot.zone_id : null, snapshot ? snapshot.zone_uuid || null : null,
      formatterFor(snapshot ? snapshot.timezone : timezone).timezone, RAIN_POLICY_VERSION]);
  const observationId = await lastInsertId(t);

  await t.run(
    'INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity, light_lux, barometric_pressure_hpa, wind_speed_mps, '
    + 'wind_direction_deg, wind_gust_mps, uv_index, rain_gauge_cumulative_mm, rain_mm_delta, rain_mm_per_hour, rain_mm_per_10min, rain_mm_today, '
    + 'counter_interval_seconds, rain_delta_status, bat_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id.deveui, id.receivedAt, numericOrNull(m.ambientTemperature), numericOrNull(m.relativeHumidity), numericOrNull(m.lightLux),
      numericOrNull(m.barometricPressureHpa), numericOrNull(m.windSpeedMps), numericOrNull(m.windDirectionDeg), numericOrNull(m.windGustMps),
      numericOrNull(m.uvIndex), m.rainGaugeCumulativeMm, counted ? rain.deltaMm : null, m.rainMmPerHour, rain.per10Mm, rainToday,
      rain.intervalSeconds, rain.status, numericOrNull(m.batPct)]);
  const deviceDataId = await lastInsertId(t);
  await t.run('UPDATE rain_observations SET device_data_id = ? WHERE id = ?', [deviceDataId, observationId]);

  // Instrument and zone days of a rain frame: its own day and the day of the
  // rain frame before it (this frame may close it). Weather-only frames carry
  // no rain evidence.
  let zoneDays = [];
  if (frameKind !== 'status') {
    const items = [{ receivedAt: id.receivedAt, zones: zoneIds, trigger: counted ? 'accepted' : 'reassessed', amountMm: counted ? rain.deltaMm : null }];
    const previous = await t.get("SELECT received_at, zone_id, config_json FROM rain_observations WHERE deveui = ? AND instrument_type = ? AND frame_kind IN ('counter','ordinary') "
      + 'AND received_at < ? ORDER BY received_at DESC, id DESC LIMIT 1', [id.deveui, S2120_TYPE_ID, id.receivedAt]);
    if (previous) items.push({ receivedAt: previous.received_at, zones: observationZones(previous), trigger: 'reassessed' });
    zoneDays = await recomputeRainDays(t, id.deveui, items, { nowMs });
  }
  return { outcome: 'accepted', status, observationId, deviceDataId, zoneDays, configQuery: null, rainDeltaStatus: rain.status, rainMmDelta: counted ? rain.deltaMm : null };
}

// ---------------------------------------------------------------------------
// Instrument days, zone gauge selection and the zone-day projection
// ---------------------------------------------------------------------------
// Contract: docs/contracts/rainfall/zone-day-projection.md. Every function
// runs inside the caller's transaction scope `t`.
//
// An instrument day (rain_instrument_days, migration 0072) is recomputed from
// the instrument's frames, never incremented: LoRain and S2120 frames are
// their rain_observations rows (dispatched by instrument_type, so LoRain rules
// never run on S2120 rows); a local gauge (LSN50 tip counter) reads its
// device_data counter rows. A zone uses at most one gauge per day (owner
// decision D1): the operator's selection while it is a candidate, else the
// only candidate; two or more candidates without a selection are ambiguous
// and never added. zone_daily_environment.rainfall_mm carries the selected
// instrument's amount only when its day is complete.
const LSN50_TYPE_ID = 'DRAGINO_LSN50';
const LOCAL_GAUGE_SOURCE = 'local_gauge';
const RAIN_TYPE_PRIORITY = { [LORAIN_TYPE_ID]: 0, [S2120_TYPE_ID]: 1 };
const PROJECTED_FIELDS = ['rainfall_mm', 'flow_liters', 'rain_source', 'rain_coverage', 'rain_selected_deveui',
  'rain_policy_version', 'rain_quality_reasons', 'rain_received_mm'];
// Triggers of a zone-day recomputation: an accepted rain observation (or an
// LSN50 rain delta), a flow-meter write, an earlier observation re-assessed
// or a day closed by the next frame, and an operator's gauge selection. Only
// the first two create a row or re-project a legacy row (NULL rain_coverage).
const CREATING_TRIGGERS = new Set(['accepted', 'flow']);

function instrumentOf(typeId) {
  const type = String(typeId || '').toUpperCase();
  if (type === LORAIN_TYPE_ID) return { typeId: type, kind: 'interval', source: LORAIN_RAIN_SOURCE, store: 'observations' };
  if (type === S2120_TYPE_ID) return { typeId: type, kind: 'cumulative', source: S2120_RAIN_SOURCE, store: 'observations' };
  return { typeId: type || LSN50_TYPE_ID, kind: 'cumulative', source: LOCAL_GAUGE_SOURCE, store: 'device_data' };
}

function normalizeEui(value) {
  return String(value || '').trim().toUpperCase();
}

function parseReasons(text) {
  if (Array.isArray(text)) return text.map(String);
  try {
    const parsed = JSON.parse(text || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_badReasons) {
    return ['quality_reasons_unreadable'];
  }
}

// The zones an observation was received under (snapshot): the list recorded at
// ingestion, else its zone_id.
function observationZones(row) {
  const zones = parseJson(row.config_json).zones;
  if (Array.isArray(zones)) return zones.map(Number).filter(Number.isInteger);
  return row.zone_id === null || row.zone_id === undefined ? [] : [Number(row.zone_id)];
}

function observationFrame(row) {
  const accepted = row.status === 'accepted';
  return {
    receivedAt: row.received_at,
    tips: row.tips === null || row.tips === undefined ? null : Number(row.tips),
    amountMm: accepted && row.amount_mm !== null && row.amount_mm !== undefined ? Number(row.amount_mm) : null,
    deltaMm: null,
    cumulativeMm: null,
    status: row.status,
    frameKind: row.frame_kind,
    intervalBasis: row.interval_basis,
    measuredStart: row.measured_start || null,
    measuredEnd: row.measured_end || null,
    devAddr: row.dev_addr || null,
    fCnt: row.f_cnt === null || row.f_cnt === undefined ? null : Number(row.f_cnt),
    reasons: parseReasons(row.quality_reasons),
    zones: observationZones(row),
  };
}

// device_data rain rows written before observations existed (no linked
// observation): what arrived, never promoted, so never a complete day.
function legacyFrame(row) {
  return {
    receivedAt: row.recorded_at, tips: null, amountMm: Number(row.rain_mm_delta), deltaMm: Number(row.rain_mm_delta), cumulativeMm: null,
    status: 'accepted', frameKind: 'ordinary', intervalBasis: 'unknown', measuredStart: null, measuredEnd: null,
    devAddr: null, fCnt: null, reasons: ['received_only'], zones: null,
  };
}

// An LSN50 tip-counter row: the delta covers the time since the previous count.
function counterRowFrame(row) {
  const status = String(row.rain_delta_status || '');
  const ok = status === 'ok' && row.rain_mm_delta !== null && row.rain_mm_delta !== undefined;
  const seconds = Number(row.counter_interval_seconds);
  const endMs = frameMs(row.recorded_at);
  const verified = ok && Number.isFinite(seconds) && seconds > 0 && Number.isFinite(endMs);
  const reasons = ok ? [] : [status || 'unknown_status'];
  if (status === 'out_of_order' || status === 'duplicate_timestamp') reasons.unshift('late_counter_frame');
  return {
    receivedAt: row.recorded_at, tips: null, amountMm: ok ? Number(row.rain_mm_delta) : null, deltaMm: ok ? Number(row.rain_mm_delta) : null,
    cumulativeMm: null, status: ok ? 'accepted' : 'not_additive', frameKind: 'counter',
    intervalBasis: verified ? 'protocol_verified' : 'unknown',
    measuredStart: verified ? new Date(endMs - seconds * 1000).toISOString() : null,
    measuredEnd: verified ? new Date(endMs).toISOString() : null,
    devAddr: null, fCnt: null, reasons, zones: null,
  };
}

// The instrument's frames for one window: the last frame before it, every
// frame in it and the first frame after it.
async function loadInstrumentFrames(t, deveui, instrument, win) {
  if (instrument.store === 'device_data') {
    const cols = 'recorded_at, rain_mm_delta, rain_delta_status, counter_interval_seconds';
    const base = 'FROM device_data WHERE deveui = ? AND rain_count_cumulative IS NOT NULL';
    const before = await t.get(`SELECT ${cols} ${base} AND recorded_at < ? ORDER BY recorded_at DESC LIMIT 1`, [deveui, win.startIso]);
    const inside = await t.all(`SELECT ${cols} ${base} AND recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at`, [deveui, win.startIso, win.endIso]);
    const after = await t.get(`SELECT ${cols} ${base} AND recorded_at >= ? ORDER BY recorded_at LIMIT 1`, [deveui, win.endIso]);
    return (before ? [before] : []).concat(inside, after ? [after] : []).map(counterRowFrame);
  }
  // S2120 weather-only frames carry no rain; an S2120 frame without identity is
  // never a counter predecessor, so the next identified frame counts its rise.
  const filter = instrument.typeId === S2120_TYPE_ID
    ? " AND frame_kind IN ('counter','ordinary') AND status <> 'ambiguous_identity'" : '';
  const base = 'FROM rain_observations WHERE deveui = ? AND instrument_type = ?' + filter;
  const args = [deveui, instrument.typeId];
  const before = await t.get(`SELECT * ${base} AND received_at < ? ORDER BY received_at DESC, id DESC LIMIT 1`, args.concat([win.startIso]));
  const inside = await t.all(`SELECT * ${base} AND received_at >= ? AND received_at < ? ORDER BY received_at, id`, args.concat([win.startIso, win.endIso]));
  const after = await t.get(`SELECT * ${base} AND received_at >= ? ORDER BY received_at, id LIMIT 1`, args.concat([win.endIso]));
  const legacy = await t.all(
    "SELECT dd.recorded_at, dd.rain_mm_delta FROM device_data dd WHERE dd.deveui = ? AND dd.rain_delta_status = 'ok' "
    + 'AND dd.rain_mm_delta IS NOT NULL AND dd.recorded_at >= ? AND dd.recorded_at < ? '
    + 'AND NOT EXISTS (SELECT 1 FROM rain_observations o WHERE o.device_data_id = dd.id) ORDER BY dd.recorded_at',
    [deveui, win.startIso, win.endIso]);
  return (before ? [before] : []).concat(inside, after ? [after] : []).map(observationFrame).concat(legacy.map(legacyFrame));
}

async function deviceInstrument(t, deveui) {
  const device = await t.get('SELECT type_id FROM devices WHERE deveui = ? ORDER BY deleted_at IS NOT NULL LIMIT 1', [deveui]);
  if (device) return instrumentOf(device.type_id);
  const observed = await t.get('SELECT instrument_type FROM rain_observations WHERE deveui = ? ORDER BY id DESC LIMIT 1', [deveui]);
  return instrumentOf(observed ? observed.instrument_type : null);
}

// Assess one instrument day; the frames in the window come back for the
// zone's snapshot check. A day that has not ended is assessed against its
// latest accepted frame (or its start when nothing arrived yet).
async function computeInstrumentDay(t, deveui, dayIso, timezone, opts = {}) {
  const eui = normalizeEui(deveui);
  const tz = formatterFor(timezone).timezone;
  const cacheKey = eui + '|' + dayIso + '|' + tz;
  if (opts.cache && opts.cache.has(cacheKey)) return opts.cache.get(cacheKey);
  const win = zoneDateWindow(dayIso, tz);
  const instrument = opts.instrument || await deviceInstrument(t, eui);
  const frames = await loadInstrumentFrames(t, eui, instrument, win);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const startMs = Date.parse(win.startIso);
  const endMs = Date.parse(win.endIso);
  let cutoffIso = null;
  if (nowMs < endMs) {
    const acceptedTimes = frames.filter((f) => f.status === 'accepted' && f.amountMm !== null)
      .map((f) => frameMs(f.receivedAt)).filter((ms) => ms >= startMs && ms < endMs);
    cutoffIso = new Date(acceptedTimes.length ? Math.max(...acceptedTimes) : startMs).toISOString();
  }
  const assessment = assessInstrumentDay({ kind: instrument.kind, frames, window: win, cutoffIso });
  const inWindow = frames.filter((f) => {
    const ms = frameMs(f.receivedAt);
    return ms >= startMs && ms < endMs;
  });
  const result = { deveui: eui, date: dayIso, timezone: tz, instrument, window: win, assessment, inWindow };
  if (opts.persist !== false) await storeInstrumentDay(t, result, nowMs);
  if (opts.cache) opts.cache.set(cacheKey, result);
  return result;
}

async function storeInstrumentDay(t, day, nowMs) {
  const a = day.assessment;
  const reasons = JSON.stringify(a.reasons);
  await t.run(
    'INSERT INTO rain_instrument_days (deveui, date, timezone, amount_mm, received_mm, coverage, reasons, accepted_count, observed_cutoff, policy_version, computed_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(deveui, date, timezone) DO UPDATE SET '
    + 'amount_mm = excluded.amount_mm, received_mm = excluded.received_mm, coverage = excluded.coverage, reasons = excluded.reasons, '
    + 'accepted_count = excluded.accepted_count, observed_cutoff = excluded.observed_cutoff, policy_version = excluded.policy_version, '
    + 'computed_at = excluded.computed_at WHERE rain_instrument_days.amount_mm IS NOT excluded.amount_mm '
    + 'OR rain_instrument_days.received_mm IS NOT excluded.received_mm OR rain_instrument_days.coverage IS NOT excluded.coverage '
    + 'OR rain_instrument_days.reasons IS NOT excluded.reasons OR rain_instrument_days.accepted_count IS NOT excluded.accepted_count '
    + 'OR rain_instrument_days.observed_cutoff IS NOT excluded.observed_cutoff OR rain_instrument_days.policy_version IS NOT excluded.policy_version',
    [day.deveui, day.date, day.timezone, a.amountMm, a.receivedMm, a.coverage, reasons, a.acceptedCount, a.observedCutoff,
      RAIN_POLICY_VERSION, new Date(nowMs).toISOString()]);
}

// Recompute one instrument day from its frames and store it. opts: nowMs,
// reassess (LoRain: re-assess the day's observations first, as a late
// correction does; the ingest writers already re-assess around each frame),
// pinnedBuilds. Returns the day, plus the zone days a re-assessment touched.
async function recomputeInstrumentDay(t, deveui, dayIso, timezone, opts = {}) {
  const eui = normalizeEui(deveui);
  const tz = formatterFor(timezone).timezone;
  const instrument = await deviceInstrument(t, eui);
  let changedDays = [];
  if (opts.reassess && instrument.typeId === LORAIN_TYPE_ID) {
    const win = zoneDateWindow(dayIso, tz);
    changedDays = (await reassessLoRain(t, eui, win.startIso, win.endIso, { pinnedBuilds: opts.pinnedBuilds })).changedDays;
  }
  const day = await computeInstrumentDay(t, eui, dayIso, tz, { ...opts, instrument, cache: null });
  return { deveui: eui, date: dayIso, timezone: tz, instrumentType: instrument.typeId, ...day.assessment, changedDays };
}

async function loadZone(t, zoneId) {
  const zone = await t.get('SELECT id, timezone, deleted_at FROM irrigation_zones WHERE id = ?', [zoneId]);
  return zone && !zone.deleted_at ? zone : null;
}

// Candidates: the zone's rain-measuring devices (LoRain, S2120, or a device
// with rain_gauge_enabled), its weather_station_zones gauges, and for a given
// day the gauges whose accepted observations of that day were received under
// this zone (a device moved away keeps its earlier days here).
async function zoneCandidates(t, zoneId, win) {
  const rows = await t.all(
    'SELECT d.deveui, d.type_id, CASE WHEN d.irrigation_zone_id = ? THEN 1 ELSE 0 END AS direct '
    + 'FROM devices d WHERE d.deleted_at IS NULL '
    + 'AND (d.irrigation_zone_id = ? OR EXISTS (SELECT 1 FROM weather_station_zones w WHERE w.deveui = d.deveui AND w.zone_id = ?)) '
    + "AND (d.type_id IN ('" + LORAIN_TYPE_ID + "','" + S2120_TYPE_ID + "') OR d.rain_gauge_enabled = 1)",
    [zoneId, zoneId, zoneId]);
  const byEui = new Map();
  for (const r of rows) byEui.set(normalizeEui(r.deveui), { deveui: normalizeEui(r.deveui), typeId: String(r.type_id || '').toUpperCase(), tier: Number(r.direct) === 1 ? 0 : 1 });
  if (win) {
    const snap = await t.all(
      'SELECT DISTINCT o.deveui, d.type_id FROM rain_observations o JOIN devices d ON d.deveui = o.deveui AND d.deleted_at IS NULL '
      + "WHERE o.status = 'accepted' AND o.received_at >= ? AND o.received_at < ? "
      + "AND (o.zone_id = ? OR EXISTS (SELECT 1 FROM json_each(o.config_json, '$.zones') j WHERE j.value = ?))",
      [win.startIso, win.endIso, zoneId, zoneId]);
    for (const r of snap) {
      const eui = normalizeEui(r.deveui);
      if (!byEui.has(eui)) byEui.set(eui, { deveui: eui, typeId: String(r.type_id || '').toUpperCase(), tier: 2 });
    }
  }
  return [...byEui.values()];
}

// The journal v1 rain source order (osi-journal/context.js): direct zone gauge,
// then a shared weather-station gauge; LoRain, then S2120, then others; DevEUI.
function suggestionOrder(a, b) {
  const pa = Object.prototype.hasOwnProperty.call(RAIN_TYPE_PRIORITY, a.typeId) ? RAIN_TYPE_PRIORITY[a.typeId] : 2;
  const pb = Object.prototype.hasOwnProperty.call(RAIN_TYPE_PRIORITY, b.typeId) ? RAIN_TYPE_PRIORITY[b.typeId] : 2;
  return a.tier - b.tier || pa - pb || a.deveui.localeCompare(b.deveui);
}

// One selected gauge per zone (D1). dayIso (optional) adds the gauges that
// reported under this zone on that day.
async function selectZoneGauge(t, zoneId, dayIso, opts = {}) {
  const zid = Number(zoneId);
  const zone = opts.zone || await loadZone(t, zid);
  const none = { state: 'none', deveui: null, basis: null, candidates: [], suggestedDeveui: null, instrumentType: null };
  if (!zone) return none;
  const win = dayIso ? zoneDateWindow(dayIso, resolveTimezone(zone).timezone) : null;
  const candidates = (await zoneCandidates(t, zid, win)).sort(suggestionOrder);
  const list = candidates.map((c) => c.deveui);
  const explicitRow = await t.get('SELECT selected_deveui FROM zone_rain_source WHERE zone_id = ?', [zid]);
  const explicit = explicitRow ? normalizeEui(explicitRow.selected_deveui) : '';
  const pick = (c, basis) => ({ state: 'selected', deveui: c.deveui, basis, candidates: list, suggestedDeveui: null, instrumentType: c.typeId });
  const chosen = explicit ? candidates.find((c) => c.deveui === explicit) : null;
  if (chosen) return pick(chosen, 'explicit');
  if (candidates.length === 1) return pick(candidates[0], 'only_candidate');
  if (!candidates.length) return none;
  return { state: 'ambiguous', deveui: null, basis: null, candidates: list, suggestedDeveui: candidates[0].deveui, instrumentType: null };
}

// The zone's rain for one farm day under policy RAIN_POLICY_VERSION: the
// selected instrument's day, restricted to the observations received under
// this zone, with the zone's own reasons after the instrument's.
async function projectZoneDay(t, zoneId, dayIso, opts = {}) {
  const zid = Number(zoneId);
  const zone = await loadZone(t, zid);
  if (!zone) return null;
  const tz = resolveTimezone(zone);
  const zoneReasons = new Set();
  if (tz.basis === 'invalid') zoneReasons.add('timezone_invalid');
  if (tz.basis === 'abbreviation') zoneReasons.add('timezone_abbreviation');
  const selection = await selectZoneGauge(t, zid, dayIso, { zone });
  const base = { zoneId: zid, date: dayIso, timezone: tz.timezone, timezoneBasis: tz.basis, selection, policyVersion: RAIN_POLICY_VERSION };
  if (selection.state !== 'selected') {
    zoneReasons.add(selection.state === 'ambiguous' ? 'gauge_ambiguous' : 'no_gauge');
    return { ...base, amountMm: null, receivedMm: null, coverage: 'unknown', source: 'none', deveui: null, reasons: orderReasons(zoneReasons) };
  }
  const instrument = instrumentOf(selection.instrumentType);
  const day = await computeInstrumentDay(t, selection.deveui, dayIso, tz.timezone, { ...opts, instrument });
  const a = day.assessment;
  let coverage = a.coverage;
  let amountMm = a.amountMm;
  let receivedMm = a.receivedMm;
  const reasons = new Set(a.reasons);
  if (instrument.store === 'observations') {
    // Move day: count only what was received under this zone; certify neither zone.
    const accepted = day.inWindow.filter((f) => f.status === 'accepted' && f.amountMm !== null);
    const own = accepted.filter((f) => !Array.isArray(f.zones) || f.zones.includes(zid));
    if (own.length < accepted.length) {
      zoneReasons.add('zone_reassigned');
      receivedMm = own.length ? roundTo(own.reduce((s, f) => s + f.amountMm, 0), 3) : null;
      amountMm = null;
      if (!own.length) coverage = 'unknown';
      else if (coverage === 'complete' || coverage === 'complete_so_far') coverage = 'partial';
    }
  }
  if (tz.basis === 'invalid') {
    coverage = 'unknown';
    amountMm = null;
  }
  for (const r of zoneReasons) reasons.add(r);
  return {
    ...base,
    amountMm: coverage === 'complete' ? amountMm : null,
    receivedMm,
    coverage,
    source: instrument.source,
    deveui: selection.deveui,
    reasons: orderReasons(reasons),
  };
}

// Read-only: the zone's rain for one farm day as it would be projected now.
async function resolveZoneRain(t, zoneId, dayIso, opts = {}) {
  const p = await projectZoneDay(t, zoneId, dayIso, { ...opts, persist: false });
  if (!p) return null;
  return { amountMm: p.amountMm, receivedMm: p.receivedMm, coverage: p.coverage, source: p.source, deveui: p.deveui, reasons: p.reasons, policyVersion: p.policyVersion };
}

function laterIso(nowMs, previousIso) {
  const prev = frameMs(previousIso);
  return new Date(Number.isFinite(prev) && prev >= nowMs ? prev + 1 : nowMs).toISOString();
}

// Recompute and write one zone day. Every write that changes a projected
// field increments sync_version once and writes a new computed_at in the same
// statement; a recomputation that changes nothing writes nothing. opts:
//   trigger         'accepted' (default) | 'flow' | 'reassessed' | 'selection';
//   amountMm        the triggering accepted amount (R-DRY: a zero never takes
//                   over a legacy row another gauge source owns);
//   flowLitersDelta flow added by the same write (lsn50-zone-agg-fn);
//   nowMs, pinnedBuilds, cache.
async function recomputeZoneDay(t, zoneId, dayIso, opts = {}) {
  const trigger = opts.trigger || 'accepted';
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const p = await projectZoneDay(t, zoneId, dayIso, { ...opts, nowMs });
  if (!p) return null;
  const flowDelta = Number.isFinite(opts.flowLitersDelta) ? opts.flowLitersDelta : 0;
  const projected = {
    rainfall_mm: p.amountMm,
    rain_source: p.source,
    rain_coverage: p.coverage,
    rain_selected_deveui: p.deveui,
    rain_policy_version: p.policyVersion,
    rain_quality_reasons: JSON.stringify(p.reasons),
    rain_received_mm: p.receivedMm,
  };
  const row = await t.get('SELECT * FROM zone_daily_environment WHERE zone_id = ? AND date = ?', [p.zoneId, dayIso]);
  if (!row) {
    if (!CREATING_TRIGGERS.has(trigger)) return { zoneId: p.zoneId, date: dayIso, written: false, projection: p };
    await t.run(
      'INSERT INTO zone_daily_environment (zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at, rain_coverage, '
      + 'rain_selected_deveui, rain_policy_version, rain_quality_reasons, rain_received_mm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [p.zoneId, dayIso, projected.rainfall_mm, flowDelta, projected.rain_source, new Date(nowMs).toISOString(), projected.rain_coverage,
        projected.rain_selected_deveui, projected.rain_policy_version, projected.rain_quality_reasons, projected.rain_received_mm]);
    return { zoneId: p.zoneId, date: dayIso, written: 'inserted', projection: p };
  }
  let applyRain = true;
  if (row.rain_coverage === null || row.rain_coverage === undefined) {
    // A legacy row is re-projected only by an accepted observation of its own
    // date (or a flow write, which must not leave a policy-1 row unlabelled),
    // and a zero never takes over a day another gauge source owns.
    if (!CREATING_TRIGGERS.has(trigger)) applyRain = false;
    else if (trigger === 'accepted' && row.rain_source && row.rain_source !== 'none' && row.rain_source !== p.source
      && !(Number(opts.amountMm) > 0)) applyRain = false;
  }
  const next = { ...row };
  if (applyRain) Object.assign(next, projected);
  if (flowDelta) next.flow_liters = roundTo((Number(row.flow_liters) || 0) + flowDelta, 3);
  const changed = PROJECTED_FIELDS.filter((key) => !sameValue(next[key], row[key]));
  if (!changed.length) return { zoneId: p.zoneId, date: dayIso, written: false, projection: p };
  await t.run(
    'UPDATE zone_daily_environment SET ' + PROJECTED_FIELDS.map((key) => key + ' = ?').join(', ')
    + ', computed_at = ?, sync_version = sync_version + 1 WHERE zone_id = ? AND date = ?',
    PROJECTED_FIELDS.map((key) => (next[key] === undefined ? null : next[key])).concat([laterIso(nowMs, row.computed_at), p.zoneId, dayIso]));
  return { zoneId: p.zoneId, date: dayIso, written: 'updated', changed, projection: p };
}

function sameValue(a, b) {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  if (typeof na === 'number' || typeof nb === 'number') return Number(na) === Number(nb);
  return String(na) === String(nb);
}

// The live zones a gauge serves now: its own zone and its weather-station
// zones, with their timezones. Recorded on each observation as its snapshot.
async function gaugeZones(t, deveui) {
  return t.all(
    'SELECT iz.id AS zone_id, iz.zone_uuid, iz.timezone FROM irrigation_zones iz WHERE iz.deleted_at IS NULL AND ('
    + 'iz.id = (SELECT d.irrigation_zone_id FROM devices d WHERE d.deveui = ? AND d.deleted_at IS NULL) '
    + 'OR iz.id IN (SELECT w.zone_id FROM weather_station_zones w WHERE w.deveui = ?)) ORDER BY iz.id',
    [deveui, deveui]);
}

// After a writer stored a frame: recompute the instrument days and zone days
// it touched. items: [{ receivedAt, zones: [zoneId], trigger, amountMm }].
// The device's own day is kept for zones it serves; a gauge without a zone
// gets its UTC day (the device timezone of osi-history-helper).
async function recomputeRainDays(t, deveui, items, opts = {}) {
  const eui = normalizeEui(deveui);
  const cache = new Map();
  const instrument = await deviceInstrument(t, eui);
  const zoneRows = new Map();
  const zoneTz = async (zoneId) => {
    if (!zoneRows.has(zoneId)) zoneRows.set(zoneId, await loadZone(t, zoneId));
    const zone = zoneRows.get(zoneId);
    return zone ? resolveTimezone(zone).timezone : null;
  };
  const rank = { accepted: 3, flow: 2, reassessed: 1, selection: 0 };
  const zoneDays = new Map();
  const instrumentDays = new Map();
  for (const item of items) {
    const zones = (item.zones || []).map(Number).filter(Number.isInteger);
    if (!zones.length) {
      const date = zoneDayWindow(item.receivedAt, 'UTC').date;
      instrumentDays.set(date + '|UTC', { date, tz: 'UTC' });
    }
    for (const zoneId of zones) {
      const tz = await zoneTz(zoneId);
      if (!tz) continue;
      const date = zoneDayWindow(item.receivedAt, tz).date;
      instrumentDays.set(date + '|' + tz, { date, tz });
      const key = zoneId + '|' + date;
      const prior = zoneDays.get(key);
      const trigger = item.trigger || 'reassessed';
      if (!prior || rank[trigger] > rank[prior.trigger] || (trigger === prior.trigger && Number(item.amountMm) > Number(prior.amountMm || 0))) {
        zoneDays.set(key, { zoneId, date, trigger, amountMm: item.amountMm });
      }
    }
  }
  for (const d of instrumentDays.values()) {
    await computeInstrumentDay(t, eui, d.date, d.tz, { nowMs: opts.nowMs, instrument, cache });
  }
  const written = [];
  for (const z of zoneDays.values()) {
    const out = await recomputeZoneDay(t, z.zoneId, z.date, { trigger: z.trigger, amountMm: z.amountMm, nowMs: opts.nowMs, cache });
    if (out) written.push({ zoneId: z.zoneId, date: z.date });
  }
  return written;
}

module.exports = {
  RAIN_POLICY_VERSION,
  LORAIN_MM_PER_TIP,
  PINNED_LORAIN_BUILDS,
  LORAIN_CONFIG_QUERY_HEX,
  payloadDigest,
  observationIdentity,
  clampReceivedAt,
  payloadRainBlocks,
  loRainFrameFacts,
  classifyLoRainFrame,
  loRainChainFrame,
  assessLoRainChain,
  assessInstrumentDay,
  resolveTimezone,
  zoneDayWindow,
  zoneDateWindow,
  ingestLoRainUplink,
  recomputeInstrumentDay,
  loRainConfigQueryBytes,
  buildLoRainConfigQueryDownlink,
  S2120_RAIN_SOURCE,
  parseS2120Measurements,
  deriveS2120Counter,
  deriveS2120Legacy,
  ingestS2120Uplink,
  selectZoneGauge,
  recomputeZoneDay,
  resolveZoneRain,
  recomputeRainDays,
};
