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

// Re-assess the device's observations received in [fromIso, toIso) with
// context before it; update the rows (and their device_data rows) that
// changed. Returns the zone days whose totals may have changed.
async function reassessLoRain(t, deveui, fromIso, toIso, { pinnedBuilds, newObservationId } = {}) {
  const contextIso = new Date(Date.parse(fromIso) - CONTEXT_LOOKBACK_MS).toISOString();
  const before = await t.get(
    'SELECT * FROM rain_observations WHERE deveui = ? AND received_at < ? ORDER BY received_at DESC, id DESC LIMIT 1',
    [deveui, contextIso]);
  const rows = await t.all(
    'SELECT * FROM rain_observations WHERE deveui = ? AND received_at >= ? AND received_at < ? ORDER BY received_at, id',
    [deveui, contextIso, toIso]);
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
    // A zone day changes only when what the frame contributes to it changes;
    // the new observation's own day is written by the caller.
    if (row.id !== newObservationId && row.zone_id !== null && row.zone_id !== undefined
      && contribution(row) !== contribution(fields)) {
      changedDays.push({ zoneId: Number(row.zone_id), timezone: row.timezone, receivedAt: row.received_at });
    }
  }
  return { changedDays };
}

function contribution(row) {
  return row.status === 'accepted' && row.amount_mm !== null && row.amount_mm !== undefined ? Number(row.amount_mm) : null;
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

// The zone row for one LoRain zone day (R-DRY semantics): the gauge's day
// total; sync_version moves only when the synced values change; computed_at
// records the latest evidence; a row another source owns is taken over only
// by a positive accepted report (pinned until R-ZONE settles multi-source days).
async function writeLoRainZoneDay(t, { deveui, zoneId, timezone, receivedAt, allowTakeover, computedAt }) {
  const win = zoneDayWindow(receivedAt, timezone);
  const total = await loRainDayTotal(t, deveui, zoneId, win.startIso, win.endIso, null);
  await t.run(
    'INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at) VALUES (?, ?, ?, 0, ?, ?) '
    + 'ON CONFLICT(zone_id, date) DO UPDATE SET '
    + 'sync_version = CASE WHEN ? IS NOT zone_daily_environment.rainfall_mm OR zone_daily_environment.rain_source IS NOT ? '
    + 'THEN zone_daily_environment.sync_version + 1 ELSE zone_daily_environment.sync_version END, '
    + 'rainfall_mm = ?, rain_source = ?, computed_at = ? '
    + 'WHERE ? = 1 OR zone_daily_environment.rain_source = ?',
    [zoneId, win.date, total, LORAIN_RAIN_SOURCE, computedAt,
      total, LORAIN_RAIN_SOURCE,
      total, LORAIN_RAIN_SOURCE, computedAt,
      allowTakeover ? 1 : 0, LORAIN_RAIN_SOURCE]);
  return { zoneId, date: win.date };
}

async function writeZoneDays(t, deveui, days, computedAt) {
  const seen = new Map();
  for (const day of days) {
    const key = day.zoneId + '|' + zoneDayWindow(day.receivedAt, day.timezone).date;
    const prior = seen.get(key);
    if (!prior || (day.allowTakeover && !prior.allowTakeover)) seen.set(key, day);
  }
  const written = [];
  for (const day of seen.values()) {
    written.push(await writeLoRainZoneDay(t, { deveui, zoneId: day.zoneId, timezone: day.timezone, receivedAt: day.receivedAt,
      allowTakeover: !!day.allowTakeover, computedAt }));
  }
  return written;
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

  if (id.eventId) {
    const existing = await t.get('SELECT id, payload_digest FROM rain_observations WHERE deveui = ? AND event_id = ?', [id.deveui, id.eventId]);
    if (existing) {
      if (existing.payload_digest === id.digest) return none('duplicate', existing.id);
      await quarantineConflict(t, id);
      return none('conflict', existing.id);
    }
  }
  if (id.devAddr && id.fCnt !== null) {
    const slot = await t.all(
      'SELECT id, payload_digest FROM rain_observations WHERE deveui = ? AND dev_addr = ? AND f_cnt = ? '
      + 'AND ABS(julianday(received_at) - julianday(?)) < (1.0 / 24) ORDER BY id', [id.deveui, id.devAddr, id.fCnt, id.receivedAt]);
    const same = slot.find((r) => r.payload_digest === id.digest);
    if (same) return none('duplicate', same.id);
    if (slot.length) {
      await quarantineConflict(t, id);
      return none('conflict', slot[0].id);
    }
  }

  const fPort = toIntOrNull(uplink.fPort);
  const facts = loRainFrameFacts(uplink.object, payloadRainBlocks(uplink.data));
  const intr = intrinsicClassification(facts);
  const timezone = formatterFor(device.timezone).timezone;
  await t.run(
    'INSERT INTO rain_observations (deveui, instrument_type, event_id, dev_addr, f_cnt, payload_digest, received_at, interval_basis, '
    + 'frame_kind, tips, amount_mm, status, quality_reasons, config_json, zone_id, zone_uuid, timezone, source_policy_version) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, \'unknown\', ?, ?, NULL, ?, \'[]\', ?, ?, ?, ?, ?)',
    [id.deveui, LORAIN_TYPE_ID, id.eventId, id.devAddr, id.fCnt, id.digest, id.receivedAt, intr.frameKind,
      isValidTips(intr.tips) ? intr.tips : null, intr.status, JSON.stringify({ frame: frameJson(fPort, facts), state: null }),
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

  const days = changedDays.map((d) => ({ ...d, allowTakeover: false }));
  if (obs.status === 'accepted' && device.zone_id !== null && device.zone_id !== undefined) {
    days.push({ zoneId: Number(device.zone_id), timezone, receivedAt: id.receivedAt, allowTakeover: Number(obs.amount_mm) > 0 });
  }
  const zoneDays = await writeZoneDays(t, id.deveui, days, new Date(nowMs).toISOString());
  return { outcome: 'accepted', status: obs.status, observationId, deviceDataId, zoneDays, configQuery };
}

async function quarantineConflict(t, id) {
  await t.run("INSERT INTO ingest_quarantine (deveui, channel, reason, raw_value) VALUES (?, 'rain_observation', 'identity_conflict', ?)",
    [id.deveui, JSON.stringify({ eventId: id.eventId, devAddr: id.devAddr, fCnt: id.fCnt, digest: id.digest, receivedAt: id.receivedAt })]);
}

// Re-assess one gauge's observations of a zone-local day and rewrite the
// zone rows they belong to. For recomputation after a late correction
// (R-HIST, R-ZONE). Runs inside the caller's transaction.
async function recomputeInstrumentDay(t, deveui, dayIso, timezone, opts = {}) {
  const eui = String(deveui || '').trim().toUpperCase();
  const win = zoneDateWindow(dayIso, timezone);
  const { changedDays } = await reassessLoRain(t, eui, win.startIso, win.endIso, { pinnedBuilds: opts.pinnedBuilds });
  const zones = await t.all(
    'SELECT DISTINCT zone_id, timezone FROM rain_observations WHERE deveui = ? AND zone_id IS NOT NULL AND received_at >= ? AND received_at < ?',
    [eui, win.startIso, win.endIso]);
  const days = changedDays.map((d) => ({ ...d, allowTakeover: false }))
    .concat(zones.map((z) => ({ zoneId: Number(z.zone_id), timezone: z.timezone, receivedAt: win.startIso, allowTakeover: false })));
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  return { zoneDays: await writeZoneDays(t, eui, days, new Date(nowMs).toISOString()) };
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
};
