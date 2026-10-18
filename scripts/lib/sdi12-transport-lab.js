'use strict';

// Offline evidence replay only. It compares the shipped permissive assembler
// with a deliberately conservative synthetic policy; neither result authorizes
// acquisition or proves a sensor cycle.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WINDOW_MS = 600000;
const MAX_FCNT = 0xffffffff;
const MAX_EVENTS = 1000;
const MAX_TEXT = 128;
const NR_ROOT = path.resolve(__dirname, '../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const reassembler = require(path.join(NR_ROOT, 'osi-sdi12-reassemble'));

let decoder;

function failure(code) {
  return { ok: false, code, hardware_verified: false, acquisition_available: false, eligible: false };
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function boundedText(value) { return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT; }
function validAt(value) { return Number.isSafeInteger(value) && value >= 0; }
function deviceId(value) { return typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value); }
function detached(value) { return JSON.parse(JSON.stringify(value)); }

function bytesFromBase64(value) {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 255 || bytes.toString('base64') !== value) return null;
  return bytes;
}

function validateDeviceEvent(event) {
  return isObject(event) && isObject(event.deviceInfo) && deviceId(event.deviceInfo.devEui);
}

function validateScenario(scenario) {
  if (!isObject(scenario) || !boundedText(scenario.name)
    || !['synthetic', 'installed_capture'].includes(scenario.evidence_kind)
    || !Array.isArray(scenario.events) || scenario.events.length > MAX_EVENTS) return 'invalid_scenario';
  let previousAt = -1;
  for (const item of scenario.events) {
    if (!isObject(item) || !validAt(item.at_ms) || item.at_ms < previousAt) return 'invalid_event';
    previousAt = item.at_ms;
    if (item.type === 'up') {
      if (!validateDeviceEvent(item.event) || !Number.isInteger(item.event.fCnt)
        || item.event.fCnt < 0 || item.event.fCnt > MAX_FCNT
        || !Number.isInteger(item.event.fPort) || item.event.fPort < 1 || item.event.fPort > 223
        || !bytesFromBase64(item.event.data)
        || !(item.session_epoch === undefined || item.session_epoch === null || boundedText(item.session_epoch))) return 'invalid_uplink';
    } else if (item.type === 'ack' || item.type === 'txack') {
      if (!validateDeviceEvent(item.event) || !boundedText(item.event.queueItemId)
        || (item.type === 'ack' && typeof item.event.acknowledged !== 'boolean')) return 'invalid_ack';
    } else if (item.type !== 'restart') {
      return 'invalid_event';
    }
    try { detached(item); } catch (error) { return 'invalid_event'; }
  }
  return null;
}

function codec() {
  if (decoder) return decoder;
  const source = fs.readFileSync(path.join(NR_ROOT, 'codecs/dragino_sdi12_decoder.js'), 'utf8');
  const sandbox = { Buffer };
  new vm.Script(source, { filename: 'dragino_sdi12_decoder.js' }).runInNewContext(sandbox, { timeout: 1000 });
  decoder = sandbox.decodeUplink;
  return decoder;
}

function assembly(action, code, ascii, extra) {
  const result = Object.assign({ action, code }, extra || {});
  if (action === 'complete') result.ascii = ascii;
  return result;
}

function legacyUplink(state, normalizedId, item, bytes, decoded, codecError) {
  if (codecError) return assembly('rejected', 'codec_error');
  if (item.event.fPort !== 2) return assembly('rejected', 'unsupported_fport');
  if (!decoded || decoded.unsupported_payload !== undefined || (decoded.Payver !== 1 && decoded.Payver !== 2)) {
    return assembly('rejected', 'unsupported_payver');
  }
  if (decoded.Payver === 1) return assembly('complete', 'complete', String(decoded.data_sum || ''));
  try {
    const outcome = reassembler.step(state, normalizedId, {
      count: decoded.SegCount,
      index: decoded.SegIndex,
      ascii: String(decoded.data_sum || ''),
      batV: decoded.BatV,
      extiTrigger: decoded.EXTI_Trigger,
      nowMs: item.at_ms,
    });
    if (outcome.action === 'buffered') return assembly('buffered', 'buffered', null, { status: outcome.status });
    if (outcome.action === 'reset') return assembly('reset', 'reset', null, {
      status: outcome.status,
      quarantine: detached(outcome.quarantine),
    });
    if (outcome.action === 'complete' || outcome.action === 'passthrough') {
      return assembly('complete', 'complete', outcome.message.data_sum, { status: outcome.status });
    }
    return assembly('rejected', 'legacy_unknown');
  } catch (error) {
    return assembly('rejected', 'legacy_validation');
  }
}

function clearBuffer(context) { context.buffer = null; }
function expectedNext(value) { return value + 1; }
function replayedCounter(context, fCnt) {
  if (context.maxSeen === null) return false;
  return fCnt <= context.maxSeen;
}
function bodyAscii(bytes, start) {
  let out = '';
  for (let i = start; i < bytes.length; i++) {
    const value = bytes[i];
    if (!((value >= 0x20 && value <= 0x7e) || value === 0x0d || value === 0x0a)) return null;
    out += String.fromCharCode(value);
  }
  return out;
}

function candidateContext(contexts, normalizedId) {
  if (!contexts[normalizedId]) {
    contexts[normalizedId] = { epoch: null, retired: new Set(), maxSeen: null, buffer: null };
  }
  return contexts[normalizedId];
}

function candidateUplink(contexts, unavailable, normalizedId, item, bytes) {
  const context = candidateContext(contexts, normalizedId);
  if (unavailable.value) return assembly('rejected', 'restart_context_unavailable');
  const epoch = item.session_epoch === undefined ? null : item.session_epoch;
  if (epoch === null) {
    clearBuffer(context);
    return assembly('rejected', 'missing_epoch');
  }
  if (context.retired.has(epoch)) {
    clearBuffer(context);
    return assembly('rejected', 'retired_epoch');
  }
  if (context.epoch !== null && context.epoch !== epoch) {
    context.retired.add(context.epoch);
    context.epoch = epoch;
    context.maxSeen = null;
    clearBuffer(context);
  }
  if (context.epoch === null) context.epoch = epoch;
  if (replayedCounter(context, item.event.fCnt)) {
    clearBuffer(context);
    return assembly('rejected', 'replayed_counter');
  }
  context.maxSeen = item.event.fCnt;
  if (item.event.fPort !== 2) {
    clearBuffer(context);
    return assembly('rejected', 'unsupported_fport');
  }
  const payver = bytes.length >= 3 ? bytes[2] : null;
  if (payver !== 1 && payver !== 2) {
    clearBuffer(context);
    return assembly('rejected', 'unsupported_payver');
  }
  if (payver === 1) {
    const ascii = bodyAscii(bytes, 3);
    if (ascii === null) {
      clearBuffer(context);
      return assembly('rejected', 'lossy_ascii');
    }
    clearBuffer(context);
    return assembly('complete', 'complete', ascii);
  }
  if (bytes.length < 5 || bytes[3] < 1 || bytes[3] > 15 || bytes[4] >= bytes[3]) {
    clearBuffer(context);
    return assembly('rejected', 'invalid_segment');
  }
  const count = bytes[3];
  const index = bytes[4];
  const ascii = bodyAscii(bytes, 5);
  if (ascii === null) {
    clearBuffer(context);
    return assembly('rejected', 'lossy_ascii');
  }
  if (!context.buffer) {
    if (index !== 0) return assembly('rejected', 'unexpected_index');
    if (count === 1) return assembly('complete', 'complete', ascii);
    context.buffer = { count, firstAt: item.at_ms, lastFCnt: item.event.fCnt, ascii };
    return assembly('buffered', 'buffered');
  }
  const buffer = context.buffer;
  if (count !== buffer.count) {
    clearBuffer(context);
    return assembly('rejected', 'count_mismatch');
  }
  if (item.at_ms - buffer.firstAt > WINDOW_MS) {
    clearBuffer(context);
    return assembly('rejected', 'window_expired');
  }
  const expectedIndex = buffer.nextIndex === undefined ? 1 : buffer.nextIndex;
  if (index !== expectedIndex) {
    clearBuffer(context);
    return assembly('rejected', 'unexpected_index');
  }
  if (item.event.fCnt !== expectedNext(buffer.lastFCnt)) {
    clearBuffer(context);
    return assembly('rejected', 'counter_gap');
  }
  const combined = buffer.ascii + ascii;
  if (index === count - 1) {
    clearBuffer(context);
    return assembly('complete', 'complete', combined);
  }
  buffer.ascii = combined;
  buffer.lastFCnt = item.event.fCnt;
  buffer.nextIndex = index + 1;
  return assembly('buffered', 'buffered');
}

function evidenceResult(item) {
  return {
    type: item.type,
    at_ms: item.at_ms,
    event: detached(item.event),
    legacy: assembly('evidence_only', 'evidence_only'),
    candidate: assembly('evidence_only', 'evidence_only'),
  };
}

function replay(scenario) {
  try {
    const validation = validateScenario(scenario);
    if (validation) return failure(validation);
    const legacyState = {};
    const contexts = {};
    const unavailable = { value: false };
    const results = [];
    for (const item of scenario.events) {
      if (item.type === 'ack' || item.type === 'txack') {
        results.push(evidenceResult(item));
        continue;
      }
      if (item.type === 'restart') {
        for (const key of Object.keys(legacyState)) delete legacyState[key];
        for (const context of Object.values(contexts)) clearBuffer(context);
        unavailable.value = true;
        results.push({ type: 'restart', at_ms: item.at_ms,
          legacy: assembly('reset', 'restart'), candidate: assembly('reset', 'restart') });
        continue;
      }
      const normalizedId = item.event.deviceInfo.devEui.toUpperCase();
      const bytes = bytesFromBase64(item.event.data);
      let decoded = null;
      let codecError = false;
      try { decoded = codec()({ fPort: item.event.fPort, bytes: [...bytes] }).data; }
      catch (error) { codecError = true; }
      results.push({
        type: 'up',
        at_ms: item.at_ms,
        raw_bytes: [...bytes],
        decoded: decoded === null ? null : detached(decoded),
        event: detached(item.event),
        session_epoch: item.session_epoch === undefined ? null : item.session_epoch,
        legacy: legacyUplink(legacyState, normalizedId, item, bytes, decoded, codecError),
        candidate: candidateUplink(contexts, unavailable, normalizedId, item, bytes),
      });
    }
    return {
      ok: true,
      name: scenario.name,
      evidence_kind: scenario.evidence_kind,
      hardware_verified: false,
      acquisition_available: false,
      eligible: false,
      assumptions: [
        'Trusted epoch ordering and lifetime are required: synthetic session annotations alone cannot identify an unseen older epoch.',
        'Counter continuity rejects selected mixed fragments but does not prove one measurement cycle or fresh sensor data.',
        'ACK and TXACK events are retained as evidence only and do not prove converter command application.',
        'This offline replay never makes an observation eligible for acquisition or a revision interpretation.',
      ],
      results,
    };
  } catch (error) {
    return failure('replay_failed');
  }
}

module.exports = { replay };
