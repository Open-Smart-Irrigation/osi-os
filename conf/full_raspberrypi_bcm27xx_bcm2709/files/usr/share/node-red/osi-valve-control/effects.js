'use strict';

// Effect semantics are deliberately kept beside the transport ledger.  The
// transport phase answers whether a downlink was accepted; this module answers
// whether that downlink can still affect watering.  The two facts must never be
// collapsed into one ACK or action label.

const { openClockStatus } = require('../osi-irrigation-policy/clock');
const { parseInstant } = require('../osi-irrigation-policy/timestamps');

const EFFECTS = Object.freeze({
  NON_ACTUATING: 'NON_ACTUATING',
  CLOSE_ONLY: 'CLOSE_ONLY',
  SELF_CLOSING_OPEN: 'SELF_CLOSING_OPEN',
  MAY_END_OPEN: 'MAY_END_OPEN',
  OPAQUE: 'OPAQUE',
});

const DEFAULT_INTERVAL_MINUTES = 10;
const SNAPSHOT_VERSION = 1;
const UNBOUNDED_SAFE_CLOSE_V1 = 'UNBOUNDED_SAFE_CLOSE_V1';
const EFFECT_SET = new Set(Object.values(EFFECTS));

function errorWithCode(code, message) { return Object.assign(new Error(message || code), { code }); }
function ms(value) {
  const n = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : parseInstant(value);
  return Number.isFinite(n) ? n : null;
}
function iso(value) {
  const n = ms(value);
  if (n == null) throw errorWithCode('invalid_timestamp', 'effect timestamp is invalid');
  return new Date(n).toISOString();
}
function canonicalIso(value) {
  return typeof value === 'string' && ms(value) != null && new Date(ms(value)).toISOString() === value;
}
function exactBase64(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  let bytes;
  try { bytes = Buffer.from(value, 'base64'); } catch (_) { return null; }
  if (!bytes.length || bytes.toString('base64') !== value) return null;
  return bytes;
}
function frameBytes(frame) { return exactBase64(frame && (frame.data == null ? frame.payload : frame.data)); }
function internalProvenance(frame) {
  const p = frame && frame.provenance;
  return p && typeof p === 'object' && !Array.isArray(p) && p.source === 'local_encoder';
}
function plainObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function cloneJson(value) {
  if (value == null) return value;
  if (!plainObject(value)) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
}
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
function flagsAreSafe(frame) {
  // Missing flags are ambiguous.  A captured queue row is therefore opaque even
  // when its bytes happen to look like one of the local encodings.
  return frame && frame.confirmed === false && frame.encrypted === false && frame.isEncrypted !== true;
}
function classifyEffect(frame = {}) {
  const bytes = frameBytes(frame);
  const fPort = Number(frame.fPort == null ? frame.fport : frame.fPort);
  const data = frame.data == null ? frame.payload : frame.data;
  const base = { version: SNAPSHOT_VERSION, fPort: Number.isInteger(fPort) ? fPort : null,
    data: typeof data === 'string' ? data : null, bytes_hex: bytes ? bytes.toString('hex').toUpperCase() : null,
    confirmed: typeof frame.confirmed === 'boolean' ? frame.confirmed : null,
    encrypted: typeof frame.encrypted === 'boolean' ? frame.encrypted : (typeof frame.isEncrypted === 'boolean' ? frame.isEncrypted : null),
    provenance: cloneJson(frame.provenance),
    encoded_duration_seconds: null, effect_class: EFFECTS.OPAQUE };
  if (!bytes || !Number.isInteger(fPort) || !internalProvenance(frame) || !flagsAreSafe(frame)) return base;
  if (fPort === 1 && bytes.length === 1 && bytes[0] === 0x30) return { ...base, effect_class: EFFECTS.CLOSE_ONLY };
  if (fPort === 1 && bytes.length === 1 && bytes[0] === 0x31) return { ...base, effect_class: EFFECTS.MAY_END_OPEN };
  if (fPort === 2 && bytes.length === 2) {
    const opcode = bytes[0]; const amount = bytes[1];
    if (amount >= 1 && amount <= 255 && [0x21, 0x41, 0x81].includes(opcode)) {
      const factor = opcode === 0x21 ? 1 : opcode === 0x41 ? 60 : 3600;
      return { ...base, effect_class: EFFECTS.SELF_CLOSING_OPEN, encoded_duration_seconds: amount * factor };
    }
    if (amount >= 1 && amount <= 255 && [0x20, 0x40, 0x80].includes(opcode)) {
      return { ...base, effect_class: EFFECTS.MAY_END_OPEN, encoded_duration_seconds: amount * (opcode === 0x20 ? 1 : opcode === 0x40 ? 60 : 3600) };
    }
  }
  if (fPort === 9 && bytes.length === 1 && bytes[0] >= 0 && bytes[0] <= 3) return { ...base, effect_class: EFFECTS.NON_ACTUATING };
  if (fPort === 10 && bytes.length === 1) return { ...base, effect_class: EFFECTS.NON_ACTUATING };
  if (fPort === 11 && bytes.length === 2 && (bytes[0] === 0x00 || bytes[0] === 0x80)
      && bytes[1] >= 1 && bytes[1] <= 255) return { ...base, effect_class: EFFECTS.NON_ACTUATING };
  if (fPort === 11 && bytes.length === 4 && (bytes[0] === 0x00 || bytes[0] === 0x01)
      && bytes[1] >= 1 && bytes[1] <= 255 && bytes[2] === 0x00 && bytes[3] >= 1 && bytes[3] <= 255) return { ...base, effect_class: EFFECTS.NON_ACTUATING };
  if (fPort === 22 && bytes.length === 1 && (bytes[0] === 0x30 || bytes[0] === 0x31)) return { ...base, effect_class: EFFECTS.NON_ACTUATING };
  if (fPort === 21 && bytes.length === 1 && (bytes[0] === 0x30 || bytes[0] === 0x31)) return { ...base, effect_class: EFFECTS.NON_ACTUATING };
  if (fPort === 12 && bytes.length === 14 && bytes.every((byte) => byte >= 0x00 && byte <= 0x09)) return { ...base, effect_class: EFFECTS.NON_ACTUATING };
  if (fPort === 13 && bytes.length === 1 && bytes[0] === 0x01) return { ...base, effect_class: EFFECTS.NON_ACTUATING };
  if (fPort === 27 && bytes.length === 2 && (bytes[0] === 0x30 || bytes[0] === 0x31) && bytes[1] >= 1 && bytes[1] <= 100) return { ...base, effect_class: EFFECTS.MAY_END_OPEN };
  if (fPort === 28 && bytes.length === 2 && bytes[0] === 0x31 && bytes[1] >= 1 && bytes[1] <= 100) return { ...base, effect_class: EFFECTS.MAY_END_OPEN };
  return base;
}

function resolveDeliveryInterval({ policy, delivery_settings, device_eui, interval_minutes, interval_source } = {}) {
  const eui = String(device_eui || '').trim().toUpperCase();
  let settings = delivery_settings;
  if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch (_) { settings = null; } }
  if (!settings && policy) settings = policy.delivery_settings || policy.delivery_settings_json;
  if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch (_) { settings = null; } }
  const candidate = settings && settings[eui] && settings[eui].delivery_interval_minutes;
  if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 60) return { interval_minutes: candidate, interval_source: 'policy' };
  // A caller cannot turn an arbitrary interval into qualification.  The explicit
  // value is accepted only as a test/read seam when its source says policy.
  if (interval_source === 'policy' && Number.isInteger(interval_minutes) && interval_minutes >= 1 && interval_minutes <= 60) return { interval_minutes, interval_source: 'policy' };
  return { interval_minutes: DEFAULT_INTERVAL_MINUTES, interval_source: 'documented_default' };
}

function qualificationResult(provider, context) {
  let value = { qualified: false, identity: null, margin_seconds: null, reason: 'qualification_unavailable' };
  if (typeof provider === 'function') {
    try {
      const raw = provider(context);
      if (raw && raw.qualified === true && typeof raw.identity === 'string' && raw.identity.trim()
          && Number.isInteger(raw.margin_seconds) && raw.margin_seconds >= 0) {
        value = { qualified: true, identity: raw.identity.trim(), margin_seconds: raw.margin_seconds };
      } else if (raw && raw.reason) value.reason = String(raw.reason);
    } catch (error) { value.reason = 'qualification_error'; }
  }
  return value;
}
function defaultQualificationProvider() { return { qualified: false, identity: null, margin_seconds: null, reason: 'qualification_unavailable' }; }

function normalizeQualification(value) {
  if (!plainObject(value)) return defaultQualificationProvider();
  if (value.qualified === true && typeof value.identity === 'string' && value.identity.trim()
      && Number.isInteger(value.margin_seconds) && value.margin_seconds >= 0) {
    return { qualified: true, identity: value.identity.trim(), margin_seconds: value.margin_seconds };
  }
  return { qualified: false, identity: null, margin_seconds: null, reason: value.reason || 'qualification_unavailable' };
}

function buildEffectSnapshot({ frame, anchor_at, anchorAt, interval_minutes, interval_source, policy, delivery_settings,
  device_eui, minimum_gap_minutes, qualificationProvider, qualificationContext, capturedQualification, explicit_expiry_at } = {}) {
  const classification = classifyEffect(frame || {});
  const anchor = iso(anchor_at == null ? anchorAt : anchor_at);
  const eui = device_eui == null ? null : String(device_eui).trim().toUpperCase();
  const interval = resolveDeliveryInterval({ policy, delivery_settings, device_eui, interval_minutes, interval_source });
  const allowance = 10 + 2 * interval.interval_minutes + 1;
  const duration = Number.isInteger(classification.encoded_duration_seconds) ? classification.encoded_duration_seconds : 0;
  const qualification = capturedQualification ? normalizeQualification(capturedQualification)
    : qualificationResult(qualificationProvider, qualificationContext || { frame, device_eui, effect: classification });
  const start = ms(anchor) + allowance * 60000;
  const margin = qualification.qualified ? qualification.margin_seconds : 0;
  const latest = new Date(start).toISOString();
  const calculatedQueueExpiry = new Date(start - margin * 1000).toISOString();
  const explicitExpiry = explicit_expiry_at == null ? null : iso(explicit_expiry_at);
  const queueExpiry = explicitExpiry == null || ms(explicitExpiry) > ms(calculatedQueueExpiry) ? calculatedQueueExpiry : explicitExpiry;
  const futureEnd = new Date(start + duration * 1000).toISOString();
  const gap = classification.effect_class === EFFECTS.CLOSE_ONLY ? 0
    : (Number.isInteger(minimum_gap_minutes) && minimum_gap_minutes >= 0 ? minimum_gap_minutes : 0);
  const exclusionEnd = new Date(ms(futureEnd) + gap * 60000).toISOString();
  return freezeDeep({ ...classification, snapshot_version: SNAPSHOT_VERSION, anchor_at: anchor, device_eui: eui,
    interval_minutes: interval.interval_minutes, interval_source: interval.interval_source,
    allowance_minutes: allowance, latest_physical_start_at: latest, calculated_queue_expires_at: calculatedQueueExpiry,
    explicit_expiry_at: explicitExpiry, queue_expires_at: queueExpiry,
    future_effect_end: futureEnd, exclusion_end_at: exclusionEnd, minimum_gap_minutes: gap,
    qualification: { ...qualification },
    qualification_context: { device_eui: eui, identity: qualification.identity || null },
    // These fields are aliases used by the occurrence evidence contract.
    reservation_end_at: futureEnd, expires_at: queueExpiry });
}

// A permanent CLOSE remains available while the gateway wall clock is not yet
// trusted.  This is deliberately a separate, exact contract: it cannot be
// created by a request payload and it can never acquire a finite horizon later.
function buildUnboundedSafeCloseSnapshot({ frame, device_eui, reservation_receipt } = {}) {
  const classified = classifyEffect(frame || {});
  const device = device_eui == null ? null : String(device_eui).trim().toUpperCase();
  if (classified.effect_class !== EFFECTS.CLOSE_ONLY || classified.fPort !== 1 || classified.data !== 'MA=='
      || !plainObject(frame && frame.provenance) || frame.provenance.source !== 'local_encoder'
      || frame.confirmed !== false || frame.encrypted !== false || !device
      || !plainObject(reservation_receipt) || typeof reservation_receipt.boot_id !== 'string'
      || !reservation_receipt.boot_id.trim() || !Number.isInteger(reservation_receipt.uptime_ms)
      || reservation_receipt.uptime_ms < 0) {
    throw errorWithCode('unbounded_safe_close_invalid', 'UNBOUNDED_SAFE_CLOSE_V1 requires the exact local permanent-CLOSE frame and internal receipt');
  }
  return freezeDeep({
    version: SNAPSHOT_VERSION, snapshot_version: SNAPSHOT_VERSION,
    timing_contract: UNBOUNDED_SAFE_CLOSE_V1, effect_class: EFFECTS.CLOSE_ONLY,
    fPort: 1, data: 'MA==', bytes_hex: '30', confirmed: false, encrypted: false,
    provenance: { source: 'local_encoder' }, encoded_duration_seconds: 0,
    device_eui: device, finite_release: false,
    interval_minutes: null, interval_source: 'not_applicable', allowance_minutes: null,
    anchor_at: null, latest_physical_start_at: null, calculated_queue_expires_at: null,
    explicit_expiry_at: null, queue_expires_at: null,
    future_effect_end: null, exclusion_end_at: null, reservation_end_at: null,
    expires_at: null, minimum_gap_minutes: 0,
    qualification: { qualified: false, identity: null, margin_seconds: null, reason: 'clock_untrusted_safe_close' },
    qualification_context: { device_eui: device, identity: null },
    reservation_receipt: { boot_id: reservation_receipt.boot_id.trim(), uptime_ms: reservation_receipt.uptime_ms },
  });
}

function computeEffectBounds({ anchor_at, anchorAt, encoded_duration_seconds = 0, interval_minutes,
  interval_source, policy, delivery_settings, device_eui, qualification, minimum_gap_minutes = 0 } = {}) {
  const anchor = iso(anchor_at == null ? anchorAt : anchor_at);
  const interval = resolveDeliveryInterval({ policy, delivery_settings, device_eui, interval_minutes, interval_source });
  const allowance = 10 + 2 * interval.interval_minutes + 1;
  const duration = Number(encoded_duration_seconds);
  if (!Number.isInteger(duration) || duration < 0) throw errorWithCode('invalid_duration', 'encoded duration must be a non-negative integer');
  const margin = qualification && qualification.qualified === true && Number.isInteger(qualification.margin_seconds) && qualification.margin_seconds >= 0
    ? qualification.margin_seconds : 0;
  const latest = ms(anchor) + allowance * 60000;
  const end = latest + duration * 1000;
  const gap = Number.isInteger(minimum_gap_minutes) && minimum_gap_minutes >= 0 ? minimum_gap_minutes : 0;
  return { anchor_at: anchor, interval_minutes: interval.interval_minutes, interval_source: interval.interval_source,
    allowance_minutes: allowance, latest_physical_start_at: new Date(latest).toISOString(),
    queue_expires_at: new Date(latest - margin * 1000).toISOString(), future_effect_end: new Date(end).toISOString(),
    exclusion_end_at: new Date(end + gap * 60000).toISOString(), minimum_gap_minutes: gap };
}

function currentQualification(snapshot, provider) {
  if (!snapshot || !snapshot.qualification || snapshot.qualification.qualified !== true) return false;
  const captured = snapshot.qualification;
  const current = qualificationResult(provider, { captured, device_eui: snapshot.device_eui, qualification_context: snapshot.qualification_context });
  return current.qualified === true && current.identity === captured.identity && current.margin_seconds <= captured.margin_seconds;
}

function runtimeClockOptions(snapshot, options = {}) {
  const supplied = options.clockOptions && typeof options.clockOptions === 'object' ? { ...options.clockOptions } : {};
  delete supplied.lastDue;
  delete supplied.latestSample;
  const runtimeNow = Number.isFinite(supplied.now) ? supplied.now : Date.now();
  supplied.now = runtimeNow;
  const evidence = [snapshot.anchor_at, options.attempt_at, options.observed_open_at, options.observed_close_at,
    options.current_state_at || options.currentStateAt].map(ms).filter((value) => value != null);
  const samples = [options.observed_open_at, options.observed_close_at, options.current_state_at || options.currentStateAt]
    .map(ms).filter((value) => value != null);
  return { ...supplied, lastDue: evidence.length ? new Date(Math.max(...evidence)).toISOString() : undefined,
    latestSample: samples.length ? new Date(Math.max(...samples)).toISOString() : undefined };
}
function trustedClock(snapshot, options) {
  const clockOptions = runtimeClockOptions(snapshot, options);
  // Owner decision 2026-10-24: no NTP-since-boot requirement; only a clock behind the given bounds is refused.
  try { return { trusted: openClockStatus(clockOptions).trusted === true, now: clockOptions.now }; } catch (_) { return { trusted: false, now: clockOptions.now }; }
}

function canReleaseByHorizon(snapshot, { now, clockOptions, qualificationProvider, attempt_at, observed_open_at, observed_close_at, current_state_at, currentStateAt } = {}) {
  if (snapshot && snapshot.timing_contract === UNBOUNDED_SAFE_CLOSE_V1) return false;
  if (!snapshot || snapshot.effect_class !== EFFECTS.SELF_CLOSING_OPEN && snapshot.effect_class !== EFFECTS.CLOSE_ONLY) return false;
  try { validateEffectSnapshot(snapshot); } catch (_) { return false; }
  const clock = trustedClock(snapshot, { clockOptions, attempt_at, observed_open_at, observed_close_at, current_state_at, currentStateAt });
  if (!clock.trusted || !currentQualification(snapshot, qualificationProvider)) return false;
  const horizon = ms(snapshot.exclusion_end_at || snapshot.future_effect_end);
  const current = ms(clock.now);
  return horizon != null && current != null && current >= horizon;
}

function observationState(snapshot, { now, observed_open_at, observed_close_at, current_state, currentState, current_state_at, currentStateAt, attempt_at, clock, clockOptions, qualificationProvider } = {}) {
  try { validateEffectSnapshot(snapshot); } catch (_) { return { blocks: true, reason: 'invalid_snapshot' }; }
  const open = ms(observed_open_at); const close = ms(observed_close_at); const attempt = ms(attempt_at || snapshot && snapshot.anchor_at);
  const stateAt = ms(current_state_at || currentStateAt);
  const hasOpen = observed_open_at != null;
  const hasClose = observed_close_at != null;
  const validClose = close != null && (!hasOpen || (open != null && close >= open));
  const current = String(current_state == null ? currentState == null ? '' : currentState : current_state).toUpperCase();
  if (snapshot.effect_class === EFFECTS.NON_ACTUATING) return { blocks: false, reason: 'non_actuating' };
  if (snapshot.effect_class === EFFECTS.OPAQUE || snapshot.effect_class === EFFECTS.MAY_END_OPEN) return { blocks: true, reason: 'opaque_or_open_ending' };
  if (current === 'OPEN' || (hasOpen && !validClose)) return { blocks: true, reason: 'open_unresolved' };
  if (snapshot.effect_class === EFFECTS.CLOSE_ONLY) {
    const freshCurrentClosed = current === 'CLOSED' && stateAt != null && attempt != null && stateAt >= attempt;
    if ((freshCurrentClosed || (validClose && !hasOpen)) && attempt != null && (close == null || close >= attempt)) return { blocks: false, reason: 'fresh_closed' };
    return { blocks: canReleaseByHorizon(snapshot, { now, clockOptions, qualificationProvider, attempt_at, observed_open_at, observed_close_at, current_state_at, currentStateAt }) ? false : true, reason: 'close_requires_evidence' };
  }
  const complete = hasOpen && validClose && attempt != null && open != null && open >= attempt;
  if (complete) return { blocks: false, reason: 'closed_observation' };
  return { blocks: canReleaseByHorizon(snapshot, { now, clockOptions, qualificationProvider, attempt_at, observed_open_at, observed_close_at, current_state_at, currentStateAt }) ? false : true, reason: 'horizon_or_observation' };
}

function effectBlocks(snapshot, options) {
  try { validateEffectSnapshot(snapshot); } catch (_) { return true; }
  return observationState(snapshot, options).blocks;
}
function conflictBlocks(snapshot, options = {}) {
  if (!snapshot) return true;
  const candidate = options.candidate_effect_class;
  if (candidate === EFFECTS.NON_ACTUATING || candidate === EFFECTS.CLOSE_ONLY) return false;
  return effectBlocks(snapshot, options);
}

function assertSnapshotMatchesFrame(snapshot, frame) {
  if (!snapshot || typeof snapshot !== 'object') throw errorWithCode('effect_snapshot_required', 'effect snapshot is required');
  validateEffectSnapshot(snapshot);
  const actual = classifyEffect(frame || {});
  if (snapshot.effect_class !== actual.effect_class || snapshot.fPort !== actual.fPort
      || snapshot.data !== actual.data || snapshot.bytes_hex !== actual.bytes_hex || snapshot.confirmed !== actual.confirmed
      || snapshot.encrypted !== actual.encrypted
      || JSON.stringify(snapshot.provenance) !== JSON.stringify(actual.provenance)
      || Number(snapshot.encoded_duration_seconds || 0) !== Number(actual.encoded_duration_seconds || 0)) {
    throw errorWithCode('effect_snapshot_mismatch', 'effect snapshot does not match the exact encoded frame');
  }
  return snapshot;
}

function validateEffectSnapshot(snapshot, { device_eui } = {}) {
  if (!plainObject(snapshot) || snapshot.version !== SNAPSHOT_VERSION || snapshot.snapshot_version !== SNAPSHOT_VERSION) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot version is invalid');
  const opaque = snapshot.effect_class === EFFECTS.OPAQUE;
  const bytes = typeof snapshot.data === 'string' ? exactBase64(snapshot.data) : null;
  const frameValid = opaque
    ? (snapshot.data == null ? snapshot.bytes_hex == null : (bytes ? snapshot.bytes_hex === bytes.toString('hex').toUpperCase() : snapshot.bytes_hex == null))
    : (Number.isInteger(snapshot.fPort) && typeof snapshot.data === 'string' && bytes
      && snapshot.bytes_hex === bytes.toString('hex').toUpperCase()
      && typeof snapshot.confirmed === 'boolean' && typeof snapshot.encrypted === 'boolean');
  if (!frameValid || !Object.prototype.hasOwnProperty.call(snapshot, 'provenance')) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot frame provenance is incomplete');
  if (snapshot.effect_class !== EFFECTS.OPAQUE
      && (!plainObject(snapshot.provenance) || snapshot.provenance.source !== 'local_encoder'
        || snapshot.confirmed !== false || snapshot.encrypted !== false)) {
    throw errorWithCode('effect_snapshot_invalid', 'effect snapshot frame provenance is incomplete');
  }
  const classified = classifyEffect({ fPort: snapshot.fPort, data: snapshot.data, confirmed: snapshot.confirmed,
    encrypted: snapshot.encrypted, provenance: snapshot.provenance });
  if (classified.effect_class !== snapshot.effect_class
      || Number(classified.encoded_duration_seconds || 0) !== Number(snapshot.encoded_duration_seconds || 0)) {
    throw errorWithCode('effect_snapshot_invalid', 'effect snapshot classification does not match persisted frame');
  }
  if (snapshot.timing_contract === UNBOUNDED_SAFE_CLOSE_V1) {
    if (snapshot.effect_class !== EFFECTS.CLOSE_ONLY || snapshot.fPort !== 1 || snapshot.data !== 'MA=='
        || snapshot.bytes_hex !== '30' || snapshot.confirmed !== false || snapshot.encrypted !== false
        || !plainObject(snapshot.provenance) || JSON.stringify(snapshot.provenance) !== JSON.stringify({ source: 'local_encoder' })
        || snapshot.encoded_duration_seconds !== 0 || snapshot.finite_release !== false
        || snapshot.interval_minutes !== null || snapshot.interval_source !== 'not_applicable'
        || snapshot.allowance_minutes !== null || snapshot.anchor_at !== null
        || snapshot.latest_physical_start_at !== null || snapshot.calculated_queue_expires_at !== null
        || snapshot.explicit_expiry_at !== null || snapshot.queue_expires_at !== null
        || snapshot.future_effect_end !== null || snapshot.exclusion_end_at !== null
        || snapshot.reservation_end_at !== null || snapshot.expires_at !== null
        || snapshot.minimum_gap_minutes !== 0
        || JSON.stringify(snapshot.qualification) !== JSON.stringify({ qualified: false, identity: null, margin_seconds: null, reason: 'clock_untrusted_safe_close' })
        || !plainObject(snapshot.reservation_receipt) || typeof snapshot.reservation_receipt.boot_id !== 'string'
        || !snapshot.reservation_receipt.boot_id.trim() || !Number.isInteger(snapshot.reservation_receipt.uptime_ms)
        || snapshot.reservation_receipt.uptime_ms < 0) {
      throw errorWithCode('effect_snapshot_invalid', 'UNBOUNDED_SAFE_CLOSE_V1 shape is invalid');
    }
    if (snapshot.qualification_context && (snapshot.qualification_context.device_eui !== snapshot.device_eui
        || snapshot.qualification_context.identity !== null)) {
      throw errorWithCode('effect_snapshot_invalid', 'UNBOUNDED_SAFE_CLOSE_V1 qualification context is invalid');
    }
    return snapshot;
  }
  if (!EFFECT_SET.has(snapshot.effect_class) || !Number.isInteger(snapshot.interval_minutes) || snapshot.interval_minutes < 1 || snapshot.interval_minutes > 60
      || !['policy', 'documented_default'].includes(snapshot.interval_source) || snapshot.allowance_minutes !== 10 + 2 * snapshot.interval_minutes + 1) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot classification is incomplete');
  if (device_eui != null && snapshot.device_eui !== String(device_eui).trim().toUpperCase()) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot device context does not match');
  if (snapshot.device_eui != null && !/^[0-9A-F]{16}$/.test(snapshot.device_eui)) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot device context is invalid');
  if (!plainObject(snapshot.qualification) || !plainObject(snapshot.qualification_context)
      || snapshot.qualification_context.device_eui !== snapshot.device_eui
      || snapshot.qualification_context.identity !== (snapshot.qualification.identity || null)) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot qualification context is incomplete');
  const qualification = normalizeQualification(snapshot.qualification);
  if (JSON.stringify(qualification) !== JSON.stringify(snapshot.qualification)) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot qualification is invalid');
  const hasCalculatedQueue = Object.prototype.hasOwnProperty.call(snapshot, 'calculated_queue_expires_at');
  const hasExplicitExpiry = Object.prototype.hasOwnProperty.call(snapshot, 'explicit_expiry_at');
  if (!hasCalculatedQueue || !hasExplicitExpiry || !canonicalIso(snapshot.calculated_queue_expires_at)
      || (snapshot.explicit_expiry_at !== null && !canonicalIso(snapshot.explicit_expiry_at))) {
    throw errorWithCode('effect_snapshot_invalid', 'effect snapshot expiry shape is incomplete');
  }
  const anchor = ms(snapshot.anchor_at); const latest = ms(snapshot.latest_physical_start_at); const queue = ms(snapshot.queue_expires_at);
  const calculatedQueue = ms(snapshot.calculated_queue_expires_at);
  const explicitExpiry = snapshot.explicit_expiry_at === null ? null : ms(snapshot.explicit_expiry_at);
  const end = ms(snapshot.future_effect_end); const exclusion = ms(snapshot.exclusion_end_at);
  if (![anchor, latest, queue, end, exclusion].every((value) => value != null)) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot timing is incomplete');
  const margin = qualification.qualified ? qualification.margin_seconds : 0;
  const duration = Number.isInteger(snapshot.encoded_duration_seconds) ? snapshot.encoded_duration_seconds : 0;
  const gap = snapshot.effect_class === EFFECTS.CLOSE_ONLY ? 0 : snapshot.minimum_gap_minutes;
  if (!Number.isInteger(snapshot.minimum_gap_minutes) || snapshot.minimum_gap_minutes < 0
      || (snapshot.effect_class === EFFECTS.CLOSE_ONLY && snapshot.minimum_gap_minutes !== 0)
      || latest !== anchor + snapshot.allowance_minutes * 60000 || calculatedQueue !== latest - margin * 1000
      || queue !== Math.min(calculatedQueue, explicitExpiry == null ? calculatedQueue : explicitExpiry)
      || end !== latest + duration * 1000 || exclusion !== end + gap * 60000
      || snapshot.reservation_end_at !== snapshot.future_effect_end || snapshot.expires_at !== snapshot.queue_expires_at) throw errorWithCode('effect_snapshot_invalid', 'effect snapshot timing equations do not match');
  if (snapshot.effect_class === EFFECTS.SELF_CLOSING_OPEN && (!Number.isInteger(snapshot.encoded_duration_seconds) || snapshot.encoded_duration_seconds < 1)) throw errorWithCode('effect_snapshot_invalid', 'timed open duration is invalid');
  if (snapshot.effect_class === EFFECTS.NON_ACTUATING && snapshot.encoded_duration_seconds !== null) throw errorWithCode('effect_snapshot_invalid', 'non-actuating duration is invalid');
  return snapshot;
}

module.exports = { EFFECTS, SNAPSHOT_VERSION, DEFAULT_INTERVAL_MINUTES, UNBOUNDED_SAFE_CLOSE_V1, classifyEffect,
  resolveDeliveryInterval, buildEffectSnapshot, computeEffectBounds, qualificationResult, defaultQualificationProvider, currentQualification,
  buildUnboundedSafeCloseSnapshot, canReleaseByHorizon, observationState, effectBlocks, conflictBlocks, assertSnapshotMatchesFrame, validateEffectSnapshot };
