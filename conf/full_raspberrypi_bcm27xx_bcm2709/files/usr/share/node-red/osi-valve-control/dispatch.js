'use strict';

// Shared reservation and transport boundary for STREGA timed opens.  This module
// deliberately does not own a Node-RED node or a transaction across a network
// call: the caller reserves in SQLite, then calls enqueueValveCommand under the
// same per-device writer as flushValveQueue.

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const policyStore = require('../osi-irrigation-policy/store');
const { parseInstant } = require('../osi-irrigation-policy/timestamps');
const { runtimeClockStatus, readRuntimeClock } = require('../osi-irrigation-policy/clock');
const irrigationModel = require('../osi-irrigation-policy/model');
const effects = require('./effects');
const store = require('./store');

const writerQueues = new Map();
const writerContext = new AsyncLocalStorage();

function errorWithCode(code, message, extra) {
  return Object.assign(new Error(message || code), { code, ...(extra || {}) });
}

function instantMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return parseInstant(value);
}

function nowIso(value) {
  const ms = value == null ? Date.now() : instantMs(value);
  if (!Number.isFinite(ms)) throw errorWithCode('invalid_timestamp', 'now must be a valid timestamp');
  return new Date(ms).toISOString();
}

function runtimeAttemptContext(trustedContext, now) {
  const supplied = trustedContext && typeof trustedContext === 'object' ? trustedContext : {};
  const runtimeNow = typeof supplied.runtimeNow === 'function' ? supplied.runtimeNow() : Date.now();
  const checkedNow = Number.isFinite(instantMs(runtimeNow)) ? instantMs(runtimeNow) : instantMs(now);
  const options = supplied.clockOptions && typeof supplied.clockOptions === 'object'
    ? { ...supplied.clockOptions, now: checkedNow }
    : { now: checkedNow };
  let clock;
  try { clock = runtimeClockStatus(options); } catch (_) { clock = { trusted: false, reason: 'clock_untrusted_runtime' }; }
  let receipt = null;
  let runtime = null;
  try {
    runtime = readRuntimeClock(supplied.clockOptions || {});
    if (runtime.bootId && Number.isInteger(runtime.uptime)) receipt = { boot_id: runtime.bootId, uptime_ms: runtime.uptime };
  } catch (_) { /* missing runtime receipt is fail-closed below */ }
  if (runtime && runtime.marker && !clock.marker) clock = { ...clock, marker: runtime.marker };
  return { clock: clock || { trusted: false, reason: 'clock_untrusted_runtime' }, receipt, now: checkedNow };
}

function normalizeDevice(value) {
  const device = String(value == null ? '' : value).trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(device)) throw errorWithCode('invalid_device_eui', 'device_eui must be a 16-character hexadecimal EUI');
  return device;
}

function commandValue(command, ...names) {
  for (const name of names) if (command && command[name] !== undefined) return command[name];
  return undefined;
}

function normalizeAction(value) {
  const action = String(value == null ? 'OPEN_FOR_DURATION' : value).trim().toUpperCase();
  if (action === 'OPEN' || action === 'OPEN_FOR_MINUTES' || action === 'TIMED_OPEN') return 'OPEN_FOR_DURATION';
  return action;
}

function commandId(command) {
  const value = String(commandValue(command, 'command_id', 'commandId') || '').trim();
  if (!value) throw errorWithCode('command_id_required', 'command_id is required');
  return value;
}

function durationMinutes(command) {
  const value = Number(commandValue(command, 'duration_minutes', 'durationMinutes'));
  if (!Number.isInteger(value) || value < 1 || value > 255) throw errorWithCode('invalid_duration', 'duration_minutes must be an integer from 1 to 255');
  return value;
}

function durationSeconds(command) {
  const value = Number(commandValue(command, 'duration_seconds', 'durationSeconds'));
  if (!Number.isInteger(value) || value < 1 || value > 255 * 3600) throw errorWithCode('invalid_duration', 'duration_seconds must be an integer from 1 to 918000');
  return value;
}

function parsePersistedJson(value, code, fallback = {}) {
  if (value == null || value === '') return fallback;
  try {
    const parsed = typeof value === 'object' ? value : JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
    return parsed;
  } catch (_) {
    throw errorWithCode(code, 'persisted safety JSON is malformed');
  }
}

function parseInputJson(value, code, fallback = {}) {
  if (value == null || value === '') return fallback;
  let parsed;
  try { parsed = typeof value === 'object' ? value : JSON.parse(value); } catch (_) { throw errorWithCode(code, 'JSON object required'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw errorWithCode(code, 'JSON object required');
  return parsed;
}

const parseControlJson = store.parseControl;

function json(value) {
  return JSON.stringify(value);
}

function hasCompleteObservation(row) {
  if (!row || row.observed_open_at == null || row.observed_close_at == null) return false;
  const open = instantMs(row.observed_open_at);
  const close = instantMs(row.observed_close_at);
  return Number.isFinite(open) && Number.isFinite(close) && close >= open;
}

// R13 R1: a cancel that proved its open never reached ChirpStack settles the expectation:
// cancel.js stamps cancelled_unsent_at / cancelled_before_send_at only on that proof, never on a
// queue snapshot (fail closed, owner decision 2026-10-24). A handed_off open carries neither stamp and keeps fencing until its evidence says so.
function cancelledUnsent(row, transport) {
  return Boolean(row && row.reconciliation_state === 'CANCELLED' && transport
    && (transport.cancelled_unsent_at || transport.cancelled_before_send_at));
}

function positiveOwnerSettlement(transport, row, type) {
  // ackPush persists the device's positive ACK as ACKED/acked_at, but the
  // enqueue response may have been lost before a queue ID was returned.  The
  // durable device ACK is therefore the settlement evidence for pushes; it
  // must not depend on the earlier RPC's queue ID.
  if (type === 'push') return Boolean(row && row.state === 'ACKED');
  if (type === 'expectation') return hasCompleteObservation(row);
  return false;
}

// The occurrence is the immutable decision record for a conditional owner.
// Every relation field is checked from persisted evidence before an observation
// can credit that owner.  Callers cannot replace one bound with a current
// schedule value or a caller supplied snapshot.
function validatePersistedOwnerRelation(row, occurrence, snapshot, deviceEui, { initialCapture = false } = {}) {
  if (!occurrence) return;
  effects.validateEffectSnapshot(snapshot, { device_eui: deviceEui });
  if (!row || !row.command_id || occurrence.command_id !== row.command_id
      || String(occurrence.device_eui || '').toUpperCase() !== String(deviceEui || '').toUpperCase()
      || (!initialCapture && !['ATTEMPTED', 'SENT', 'UNKNOWN'].includes(occurrence.state))
      || (initialCapture && !['RESERVED', 'ATTEMPTED', 'SENT', 'UNKNOWN'].includes(occurrence.state))) {
    throw errorWithCode('occurrence_relation', 'persisted occurrence relation is invalid');
  }
  const evidence = parsePersistedJson(occurrence.decision_evidence_json, 'decision_evidence_malformed', null);
  const bounds = evidence && evidence.effect_bounds;
  if (!evidence || !bounds) {
    throw errorWithCode('occurrence_relation', 'persisted occurrence snapshot is not immutable');
  }
  const boundNames = ['queue_expires_at', 'latest_physical_start_at', 'future_effect_end', 'exclusion_end_at'];
  for (const name of boundNames) {
    if (bounds[name] !== snapshot[name]) throw errorWithCode('occurrence_relation', 'persisted occurrence effect bound changed');
  }
  if (instantMs(occurrence.expires_at) !== instantMs(snapshot.queue_expires_at)
      || instantMs(occurrence.reservation_end_at) !== instantMs(snapshot.future_effect_end)) {
    throw errorWithCode('occurrence_relation', 'persisted occurrence horizon changed');
  }
  if (initialCapture && occurrence.state === 'RESERVED' && evidence.effect_snapshot == null) return;
  if (JSON.stringify(evidence.effect_snapshot) !== JSON.stringify(snapshot)) {
    throw errorWithCode('occurrence_relation', 'persisted occurrence snapshot is not immutable');
  }
}

// Observation attribution uses the same persisted snapshot contract as the
// dispatch path.  This helper deliberately accepts only rows read from the
// database; callers cannot provide a substitute snapshot or trusted flag.
function observationOwnerEligibility(row, occurrence, deviceEui, observedAt) {
  try {
    if (!row || String(row.device_eui || '').toUpperCase() !== String(deviceEui || '').toUpperCase() || !row.command_id) return { eligible: false, reason: 'owner_shape' };
    if (row.observed_open_at != null || row.reconciliation_state === 'OBSERVED_COMPLETE') return { eligible: false, reason: 'already_observed' };
    if (row.state === 'FAILED' && ['negative_ack', 'malformed_ack', 'ack_protocol_unverified'].includes(String(row.error || ''))) return { eligible: false, reason: 'terminal_ack' };
    const transport = parsePersistedJson(row.transport_json, 'transport_state_malformed', null);
    if (!transport || !['ATTEMPTED', 'UNKNOWN', 'ACCEPTED'].includes(transport.phase)) return { eligible: false, reason: 'transport_phase' };
    if (!transport.attempted_at && !transport.attempt_trusted_at && !transport.attempt_receipt) return { eligible: false, reason: 'attempt_missing' };
    const snapshot = transport.effect_snapshot;
    effects.validateEffectSnapshot(snapshot, { device_eui: deviceEui });
    if (snapshot.effect_class !== effects.EFFECTS.SELF_CLOSING_OPEN) return { eligible: false, reason: 'effect_class' };
    const reportMs = instantMs(observedAt);
    const attemptMs = instantMs(transport.attempt_trusted_at || transport.attempted_at);
    const endMs = instantMs(snapshot.future_effect_end);
    if (!Number.isFinite(reportMs) || !Number.isFinite(attemptMs) || !Number.isFinite(endMs) || reportMs < attemptMs || reportMs > endMs) return { eligible: false, reason: 'effect_window' };
    validatePersistedOwnerRelation(row, occurrence, snapshot, deviceEui);
    return { eligible: true, snapshot, transport, attempt_at: new Date(attemptMs).toISOString() };
  } catch (error) {
    return { eligible: false, reason: error && error.code === 'occurrence_relation' ? 'occurrence_relation' : 'snapshot_invalid' };
  }
}

// Report-only expectations are local physical-run records.  The current v1
// ValveActuation projection omits them; the marker and bounds stay available to
// local accounting and recovery through the raw expectation row.
function projectObservationExpectation(row) {
  const value = { ...(row || {}) };
  if (isV1LocalOnlyExpectation(value)) return null;
  return value;
}

function parsePhysicalRun(row) {
  if (!row || row.command_id != null) return { report_only: false, marker: null, malformed: false };
  let transport;
  try { transport = parsePersistedJson(row.transport_json, 'transport_state_malformed', {}); }
  catch (_) { return { report_only: true, marker: null, malformed: true, reason: 'transport_state_malformed' }; }
  const marker = transport.physical_run;
  if (marker == null) return { report_only: false, marker: null, malformed: false };
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
      || marker.version !== 1 || marker.source !== 'explicit_report'
      || !Object.prototype.hasOwnProperty.call(marker, 'earliest_possible_start_at')
      || !Object.prototype.hasOwnProperty.call(marker, 'latest_possible_end_at')) {
    return { report_only: true, marker: null, malformed: true, reason: 'physical_run_malformed' };
  }
  const validBound = (value) => value == null || Number.isFinite(instantMs(value));
  if (!validBound(marker.earliest_possible_start_at) || !validBound(marker.latest_possible_end_at)) {
    return { report_only: true, marker: null, malformed: true, reason: 'physical_run_malformed' };
  }
  return { report_only: true, marker: {
    version: 1, source: 'explicit_report',
    earliest_possible_start_at: marker.earliest_possible_start_at || null,
    latest_possible_end_at: marker.latest_possible_end_at || null,
  }, malformed: false };
}

function isReportOnlyExpectation(row) {
  return parsePhysicalRun(row).report_only;
}

// ValveActuation v1 has no removal operation. A row adopted from an already
// replicated on-valve schedule therefore keeps its old wire membership through
// the physical-run marker. This validator is deliberately narrower than the
// safety parser: it accepts only the exact edge timestamp grammar and copied
// fields written by the legacy adoption transaction.
const EDGE_V1_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function isEdgeV1WireInstant(value) {
  if (typeof value !== 'string') return false;
  const match = EDGE_V1_INSTANT.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month]
    && hour <= 23 && minute <= 59 && second <= 59;
}

function isLegacyV1CompatibilityExpectation(row) {
  if (!row || row.command_id != null || row.trigger !== 'on_valve_schedule') return false;
  if (!Number.isSafeInteger(row.commanded_duration_seconds) || row.commanded_duration_seconds <= 0
      || !isEdgeV1WireInstant(row.commanded_at) || !isEdgeV1WireInstant(row.expected_close_at)) return false;
  let transport;
  try {
    transport = parsePersistedJson(row.transport_json, 'transport_state_malformed', {});
  } catch (_) {
    return false;
  }
  const marker = transport && transport.physical_run;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
      || marker.version !== 1 || marker.source !== 'explicit_report'
      || !Object.prototype.hasOwnProperty.call(marker, 'earliest_possible_start_at')
      || !Object.prototype.hasOwnProperty.call(marker, 'latest_possible_end_at')) return false;
  if (![marker.earliest_possible_start_at, marker.latest_possible_end_at]
    .every((value) => value == null || isEdgeV1WireInstant(value))) return false;
  const compatibility = marker.legacy_v1_compatibility;
  if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)
      || compatibility.version !== 1 || compatibility.source !== 'preexisting_on_valve_schedule'
      || typeof compatibility.expectation_id !== 'string'
      || typeof compatibility.commanded_at !== 'string'
      || !Number.isSafeInteger(compatibility.commanded_duration_seconds)
      || typeof compatibility.expected_close_at !== 'string') return false;
  return compatibility.expectation_id === row.expectation_id
    && compatibility.commanded_at === row.commanded_at
    && compatibility.commanded_duration_seconds === row.commanded_duration_seconds
    && compatibility.expected_close_at === row.expected_close_at;
}

function isV1LocalOnlyExpectation(row) {
  if (!row || row.command_id != null) return false;
  const sentinelDuration = row.commanded_duration_seconds === -1
    || row.commanded_duration_seconds === '-1';
  if (sentinelDuration && row.expected_close_at === '') return true;
  if (isLegacyV1CompatibilityExpectation(row)) return false;
  return parsePhysicalRun(row).report_only;
}

async function hasBlockingObservation(db, deviceEui) {
  const rows = await db.all("SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) AND reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING')", [deviceEui]);
  return rows.some((row) => row.reconciliation_state === 'PENDING_OBSERVATION' || isReportOnlyExpectation(row));
}

function transportBlocks(transport, row, type, nowMs, effectContext = {}) {
  if (type === 'expectation' && cancelledUnsent(row, transport)) return false;
  if (!transport) return false;
  if (transport.effect_snapshot) {
    return effects.effectBlocks(transport.effect_snapshot, {
      now: nowMs == null ? new Date().toISOString() : new Date(nowMs).toISOString(),
      observed_open_at: row && row.observed_open_at,
      observed_close_at: row && row.observed_close_at,
      current_state: effectContext.current_state,
      current_state_at: effectContext.current_state_at,
      attempt_at: transport.attempted_at || transport.intent_at,
      clock: effectContext.clock, clockOptions: effectContext.clockOptions,
      qualificationProvider: effectContext.qualificationProvider,
    });
  }
  if (positiveOwnerSettlement(transport, row, type)) return false;
  if (['INTENT', 'ATTEMPTED', 'UNKNOWN'].includes(transport.phase)) return true;
  if (transport.phase === 'ACCEPTED' && !transport.queue_id) return true;
  if (transport.phase !== 'ACCEPTED' || !transport.queue_id) return false;
  if (type === 'push') return !row || row.state !== 'ACKED';
  if (type === 'expectation') return !hasCompleteObservation(row);
  return true;
}

function expectationId() {
  return crypto.randomUUID();
}

function activeReservation(row, nowMs, effectContext = {}) {
  if (!row) return false;
  const physicalRun = parsePhysicalRun(row);
  if (physicalRun.report_only) {
    const end = physicalRun.marker && physicalRun.marker.latest_possible_end_at;
    return end == null || instantMs(end) > nowMs;
  }
  const transport = parsePersistedJson(row.transport_json, 'transport_state_malformed', null);
  if (cancelledUnsent(row, transport)) return false;
  if (transport && transport.effect_snapshot) return effects.effectBlocks(transport.effect_snapshot, {
    now: new Date(nowMs).toISOString(), observed_open_at: row.observed_open_at,
    observed_close_at: row.observed_close_at, current_state: effectContext.current_state,
    current_state_at: effectContext.current_state_at,
    attempt_at: transport.attempted_at || transport.intent_at,
    clock: effectContext.clock, clockOptions: effectContext.clockOptions,
    qualificationProvider: effectContext.qualificationProvider,
  });
  if (positiveOwnerSettlement(transport, row, 'expectation')) return false;
  if (row.reconciliation_state === 'PENDING_OBSERVATION' || row.reconciliation_state === 'OBSERVED_RUNNING') return true;
  if (transportBlocks(transport, row, 'expectation')) return true;
  const end = row.reservation_end_at || row.expected_close_at;
  const endMs = end == null ? Infinity : instantMs(end);
  return !Number.isFinite(endMs) || endMs > nowMs;
}

function finiteConditionalHorizon(occurrence, expectation, nowMs) {
  if (!occurrence || !occurrence.expires_at || !occurrence.reservation_end_at) return null;
  const evidence = parsePersistedJson(occurrence.decision_evidence_json, 'decision_evidence_malformed', null);
  if (!evidence || !Number.isInteger(evidence.minimum_gap_minutes) || evidence.minimum_gap_minutes < 0 || evidence.minimum_gap_minutes > 1440) return null;
  const reservationEnd = instantMs(occurrence.reservation_end_at);
  const exclusionEnd = instantMs(evidence.exclusion_end_at);
  if (!Number.isFinite(reservationEnd) || !Number.isFinite(exclusionEnd) || exclusionEnd !== reservationEnd + evidence.minimum_gap_minutes * 60000) return null;
  const open = expectation && expectation.observed_open_at == null ? null : instantMs(expectation.observed_open_at);
  const close = expectation && expectation.observed_close_at == null ? null : instantMs(expectation.observed_close_at);
  if (expectation && (expectation.observed_open_at != null || expectation.observed_close_at != null)) {
    if (!Number.isFinite(open) || !Number.isFinite(close) || close < open) return null;
    return nowMs < close + evidence.minimum_gap_minutes * 60000;
  }
  return nowMs < exclusionEnd;
}

async function findByCommand(tx, id, deviceEui) {
  const expectation = await tx.get('SELECT * FROM valve_actuation_expectations WHERE command_id=? AND UPPER(device_eui)=UPPER(?) ORDER BY rowid DESC LIMIT 1', [id, deviceEui]);
  const occurrence = await tx.get('SELECT * FROM irrigation_occurrences WHERE command_id=? AND UPPER(device_eui)=UPPER(?) LIMIT 1', [id, deviceEui]);
  if (!expectation && !occurrence) return null;
  if (expectation && occurrence && String(expectation.device_eui).toUpperCase() !== String(occurrence.device_eui).toUpperCase()) {
    throw errorWithCode('command_owner_mismatch', 'linked expectation and occurrence devices disagree');
  }
  return { expectation, occurrence };
}

async function findConflict(tx, deviceEui, id, nowMs, effectContext = {}) {
  const expectations = await tx.all('SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) ORDER BY rowid DESC', [deviceEui]);
  const occurrenceRows = await tx.all("SELECT * FROM irrigation_occurrences WHERE UPPER(device_eui)=UPPER(?) AND command_id IS NOT NULL", [deviceEui]);
  const occurrences = new Map(occurrenceRows.map((row) => [row.command_id, row]));
  const linkedIds = new Set(expectations.map((row) => row.command_id).filter(Boolean));
  for (const row of expectations) {
    if (row.command_id === id) continue;
    const occurrence = occurrences.get(row.command_id);
    if (occurrence) {
      if (!['RESERVED', 'ATTEMPTED', 'SENT', 'UNKNOWN'].includes(occurrence.state)) continue;
      const finite = row.transport_json ? (() => {
        const state = parsePersistedJson(row.transport_json, 'transport_state_malformed', null);
        if (state && state.effect_snapshot) return effects.effectBlocks(state.effect_snapshot, {
          now: new Date(nowMs).toISOString(), observed_open_at: row.observed_open_at,
          observed_close_at: row.observed_close_at, current_state: effectContext.current_state,
          current_state_at: effectContext.current_state_at,
          attempt_at: state.attempted_at || state.intent_at,
          clock: effectContext.clock, clockOptions: effectContext.clockOptions,
          qualificationProvider: effectContext.qualificationProvider,
        });
        return finiteConditionalHorizon(occurrence, row, nowMs);
      })() : finiteConditionalHorizon(occurrence, row, nowMs);
      if (finite === false) continue;
      if (finite === true || finite === null) return { ...row, occurrence_state: occurrence.state };
    } else if (activeReservation(row, nowMs, effectContext)) return row;
  }
  for (const row of occurrenceRows) {
    if (!linkedIds.has(row.command_id) && row.command_id !== id && ['RESERVED', 'ATTEMPTED', 'SENT', 'UNKNOWN'].includes(row.state)) {
      // An active occurrence without its expectation is incomplete linkage. It
      // remains blocking rather than falling back to reservation_end_at.
      return row;
    }
  }
  // B-4 (W8 proposal, R11): plan, status and clock push owners are configuration, not water.
  // They stay owners for flush capture (ownerRecords), readiness and surfacing, but they never
  // refuse an open as valve_busy: an unacknowledged, superseded, flushed, failed or LOST plan or
  // clock row used to fence every manual, ONCE and cloud open for good. A conditional open
  // depends on its clear only through readiness (conditional_not_ready, reserveValveCommandTx
  // and the policy worker). (R13-m4) The push rows are therefore not read here any more, and the
  // reconciled-predecessor set the push loop used is gone; effectContext.reconciledPushIds is
  // accepted and ignored. A malformed push transport_json no longer refuses an open.
  const settings = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [deviceEui]);
  const control = parseControlJson(settings && settings.conditional_control_json);
  const opaque = control.opaque;
  for (const row of Array.isArray(opaque) ? opaque : []) {
    if (!opaqueMovesWater(row)) continue;
    if (transportBlocks(row, row, 'opaque', nowMs, effectContext)) return { command_id: row.queue_id, transport_phase: row.phase };
  }
  return null;
}

// B-4: an opaque queue owner (an item captured from the ChirpStack queue, or written by another
// writer) fences opens only when it can move water: an FPort 2 open, an FPort 27 frame whose
// first byte is 0x31, or FPort 28. An item whose port is unknown fails closed (it fences).
function opaqueMovesWater(row) {
  const port = row && (row.fPort == null ? row.fport : row.fPort);
  if (port == null || !Number.isFinite(Number(port))) return true;
  const fport = Number(port);
  if (fport === 2 || fport === 28) return true;
  if (fport !== 27) return false;
  const data = row.data || row.payload;
  if (data == null) return true;
  try { return Buffer.from(String(data), 'base64')[0] === 0x31; } catch (_) { return true; }
}

async function ensureConditionalReservation(tx, command, id, now, expiresAt, duration, explicitExpiresAt, effectContext = {}) {
  const key = command.occurrence || command.occurrence_key || command.occurrenceKey;
  if (!key) return null;
  let occurrence = await policyStore.getOccurrenceTx(tx, key);
  if (!occurrence) throw errorWithCode('occurrence_not_found', 'conditional occurrence does not exist');
  if (occurrence.command_id && occurrence.command_id !== id) throw errorWithCode('command_id_conflict', 'occurrence is already bound to another command');
  if (occurrence.state === 'PENDING') {
    await policyStore.claimOccurrenceTx(tx, key, { now });
    occurrence = await policyStore.getOccurrenceTx(tx, key);
  }
  if (occurrence.state !== 'CLAIMED' && occurrence.state !== 'RESERVED') {
    if (occurrence.command_id === id) return occurrence;
    throw errorWithCode('occurrence_not_runnable', `occurrence state ${occurrence.state} cannot be reserved`);
  }
  if (occurrence.state === 'CLAIMED') {
    const persistedExpiryMs = instantMs(occurrence.expires_at);
    if (!Number.isFinite(persistedExpiryMs)) throw errorWithCode('conditional_expiry_missing', 'conditional occurrence has no valid persisted expiry');
    if (explicitExpiresAt != null && instantMs(explicitExpiresAt) !== persistedExpiryMs) {
      throw errorWithCode('conditional_expiry_mismatch', 'caller expiry does not match the immutable occurrence expiry');
    }
    expiresAt = occurrence.expires_at;
    const expiresAtMs = persistedExpiryMs;
    const effectiveDuration = command.effective_duration_minutes == null ? duration : Number(command.effective_duration_minutes);
    if (!Number.isInteger(effectiveDuration) || effectiveDuration < 1 || effectiveDuration > 240) throw errorWithCode('invalid_effective_duration', 'effective_duration_minutes must be an integer from 1 to 240');
    if (command.reserved_minutes != null && Number(command.reserved_minutes) !== effectiveDuration) throw errorWithCode('invalid_reserved_minutes', 'reserved_minutes must equal effective_duration_minutes');
    const qualification = effects.qualificationResult(effectContext.qualificationProvider, { device_eui: occurrence.device_eui, occurrence, command });
    const marginSeconds = qualification.qualified ? qualification.margin_seconds : 0;
    const delivery = effects.resolveDeliveryInterval({ policy: effectContext.policy, delivery_settings: effectContext.delivery_settings,
      device_eui: occurrence.device_eui, interval_source: effectContext.interval_source, interval_minutes: effectContext.interval_minutes });
    const latestPhysicalStart = new Date(expiresAtMs + marginSeconds * 1000).toISOString();
    const expectedReservationEnd = new Date(instantMs(latestPhysicalStart) + effectiveDuration * 60000).toISOString();
    const reservationEnd = command.reservation_end_at || expectedReservationEnd;
    if (!reservationEnd || !Number.isFinite(instantMs(reservationEnd))) throw errorWithCode('invalid_reservation_horizon', 'reservation_end_at must be a valid timestamp');
    if (instantMs(reservationEnd) !== instantMs(expectedReservationEnd)) throw errorWithCode('invalid_reservation_horizon', 'reservation_end_at must equal expiry plus effective duration');
    const gap = Number(command.minimum_gap_minutes ?? command.minimumGapMinutes ?? 0);
    if (!Number.isInteger(gap) || gap < 0 || gap > 1440) throw errorWithCode('invalid_minimum_gap', 'minimum_gap_minutes must be a non-negative integer');
    const evidence = parseInputJson(command.decision_evidence_json, 'invalid_decision_evidence', {});
    const reservationEndMs = instantMs(reservationEnd);
    const exclusionEndAt = command.exclusion_end_at || new Date(reservationEndMs + gap * 60000).toISOString();
    const capturedEvidence = { ...evidence, minimum_gap_minutes: gap, exclusion_end_at: exclusionEndAt,
      qualification: qualification.qualified ? qualification : { qualified: false, identity: null, margin_seconds: null, reason: qualification.reason },
      qualification_context: { device_eui: occurrence.device_eui, identity: qualification.identity || null },
      effect_bounds: { anchor_at: occurrence.due_at, interval_minutes: delivery.interval_minutes, interval_source: delivery.interval_source,
        allowance_minutes: 10 + 2 * delivery.interval_minutes + 1, latest_physical_start_at: latestPhysicalStart,
        queue_expires_at: expiresAt, future_effect_end: reservationEnd, exclusion_end_at: exclusionEndAt } };
    if (!Number.isFinite(reservationEndMs) || instantMs(capturedEvidence.exclusion_end_at) !== reservationEndMs + gap * 60000) throw errorWithCode('invalid_exclusion_horizon', 'exclusion_end_at must equal reservation_end_at plus minimum_gap_minutes');
    const reservationStart = command.reservation_start_at || occurrence.due_at;
    const timezone = String(command.timezone || (evidence.accounting && evidence.accounting.timezone) || evidence.timezone || '').trim();
    if (!timezone) throw errorWithCode('accounting_timezone_required', 'conditional reservation timezone is required');
    let localDays;
    try { localDays = irrigationModel.localDaysForInterval(instantMs(reservationStart), reservationEndMs, timezone); } catch (_) { localDays = []; }
    if (!localDays.length) throw errorWithCode('accounting_bounds_invalid', 'conditional reservation accounting bounds are invalid');
    const requestedDays = command.local_days || (evidence.accounting && evidence.accounting.local_days);
    if (requestedDays && JSON.stringify(requestedDays) !== JSON.stringify(localDays)) throw errorWithCode('accounting_days_mismatch', 'caller accounting days do not match shared bounds');
    capturedEvidence.accounting = { ...(evidence.accounting || {}), timezone, local_days: localDays };
    await policyStore.transitionOccurrenceTx(tx, occurrence, {
      state: 'RESERVED',
      decision: command.decision || 'RESERVED',
      decision_reason: command.decision_reason || null,
      decision_evidence_json: json(capturedEvidence),
      decision_at: command.decision_at || now,
      command_id: id,
      expires_at: expiresAt,
      requested_duration_minutes: duration,
      effective_duration_minutes: effectiveDuration,
      reservation_start_at: reservationStart,
      reservation_end_at: reservationEnd,
      reserved_minutes: effectiveDuration,
    }, { now });
    occurrence = await policyStore.getOccurrenceTx(tx, occurrence);
  }
  return occurrence;
}

async function reserveValveCommandTx(tx, commandInput, nowInput, effectContext = {}) {
  const command = commandInput || {};
  const deviceEui = normalizeDevice(commandValue(command, 'device_eui', 'deviceEui'));
  const id = commandId(command);
  const now = nowIso(nowInput);
  const nowMs = instantMs(now);
  const action = normalizeAction(commandValue(command, 'action', 'command_type', 'commandType'));
  if (!['OPEN_FOR_DURATION', 'OPEN_FOR_DURATION_CONDITIONAL', 'CLOSE'].includes(action)) throw errorWithCode('unsupported_command', `unsupported valve action ${action}`);
  const explicitSeconds = action === 'CLOSE' ? null : (commandValue(command, 'duration_seconds', 'durationSeconds') == null ? null : durationSeconds(command));
  const duration = action === 'CLOSE' ? 0 : (explicitSeconds == null ? durationMinutes(command) : Math.ceil(explicitSeconds / 60));
  const existing = await findByCommand(tx, id, deviceEui);
  if (existing) {
    return { expectation: existing.expectation, occurrence: existing.occurrence, replayed: true, send: false, device_eui: deviceEui, command_id: id };
  }
  // A permanent CLOSE is a serialized safety action. It gets its own owner and
  // is allowed to coexist with an earlier hazard so fresh CLOSED evidence can
  // settle that exact owner later.
  const isClose = action === 'CLOSE';
  if (!isClose) {
    const conflict = await findConflict(tx, deviceEui, id, nowMs, effectContext);
    if (conflict) throw errorWithCode('valve_busy', 'valve has an active or unresolved command', { device_eui: deviceEui, conflicting_command_id: conflict.command_id || null });
  }

  const expiresAtInput = command.expires_at || command.expiresAt;
  const delivery = effects.resolveDeliveryInterval({
    policy: effectContext.policy,
    delivery_settings: effectContext.delivery_settings,
    device_eui: deviceEui,
  });
  const allowanceMinutes = 10 + 2 * delivery.interval_minutes + 1;
  const expiresAt = isClose && expiresAtInput == null ? null : (expiresAtInput == null
    ? new Date(nowMs + allowanceMinutes * 60000).toISOString()
    : nowIso(expiresAtInput));
  if (expiresAt != null && instantMs(expiresAt) <= nowMs) throw errorWithCode('command_expired', 'command expiry must be after now');
  const occurrence = isClose ? null : await ensureConditionalReservation(tx, command, id, now, expiresAt, duration, expiresAtInput, effectContext);
  if (occurrence && occurrence.command_id === id) {
    // B-4: a conditional open depends on the valve's conditional clear through readiness only.
    // While conditional mode has a current revision that is not READY, the valve may still hold a
    // resident plan, so the open is refused here as well as in the policy worker.
    const controlRow = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
    const control = parseControlJson(controlRow && controlRow.conditional_control_json);
    if (control.mode === 'CONDITIONAL' && control.desired_revision && !(control.readiness && control.readiness.state === 'READY' && control.readiness.revision === control.desired_revision)) {
      throw errorWithCode('conditional_not_ready', 'the conditional clear of this valve is not confirmed', { device_eui: deviceEui, readiness: control.readiness || null });
    }
  }
  const effectiveDuration = occurrence && occurrence.effective_duration_minutes != null
    ? Number(occurrence.effective_duration_minutes)
    : duration;
  const commandedAt = command.commanded_at || now;
  const persistedDurationSeconds = occurrence ? effectiveDuration * 60 : (explicitSeconds == null ? effectiveDuration * 60 : explicitSeconds);
  const calculatedExpectedClose = new Date(instantMs(commandedAt) + (isClose ? 0 : persistedDurationSeconds * 1000)).toISOString();
  const suppliedExpectedClose = command.expected_close_at || command.expectedCloseAt;
  if (occurrence && suppliedExpectedClose != null && instantMs(suppliedExpectedClose) !== instantMs(calculatedExpectedClose)) throw errorWithCode('invalid_expected_close', 'expected_close_at must equal commanded_at plus effective duration');
  const expectedCloseAt = occurrence ? calculatedExpectedClose : (suppliedExpectedClose || calculatedExpectedClose);
  const requestedExpiry = expiresAtInput == null ? null : nowIso(expiresAtInput);
  const expectation = {
    expectation_id: String(command.expectation_id || command.expectationId || expectationId()),
    device_eui: deviceEui,
    zone_id: command.zone_id == null ? null : command.zone_id,
    command_id: id,
    effect_key: command.effect_key || command.effectKey || null,
    commanded_at: commandedAt,
    commanded_duration_seconds: isClose ? 0 : persistedDurationSeconds,
    expected_close_at: expectedCloseAt,
    flow_rate_lpm: command.flow_rate_lpm == null ? null : command.flow_rate_lpm,
    flow_rate_source: command.flow_rate_source || null,
    estimated_gross_liters: command.estimated_gross_liters == null ? null : command.estimated_gross_liters,
    volume_source: command.volume_source || 'unknown',
    reconciliation_state: 'PENDING_OBSERVATION',
    cancel_reason: null,
    created_at: now,
    trigger: command.trigger || (command.conditional ? 'conditional' : 'manual'),
    transport_json: requestedExpiry == null ? null : json({ explicit_expiry_at: requestedExpiry }),
  };
  const columns = Object.keys(expectation);
  await tx.run(`INSERT INTO valve_actuation_expectations(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map((column) => expectation[column]));
  const stored = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [expectation.expectation_id]);
  return { expectation: stored, occurrence: occurrence ? await policyStore.getOccurrenceTx(tx, occurrence) : null, replayed: false, send: true, device_eui: deviceEui, command_id: id };
}

// Internal composition seam for the writer/worker layer.  The context contains
// callable dependencies supplied by trusted code; request JSON is never read as
// clock or qualification evidence.
async function findValveConflictTx(tx, deviceEui, commandIdValue, now, effectContext) {
  const device = normalizeDevice(deviceEui);
  const id = String(commandIdValue || '').trim();
  if (!id) throw errorWithCode('command_id_required', 'command_id is required');
  const at = nowIso(now);
  return findConflict(tx, device, id, instantMs(at), effectContext || {});
}

async function reserveValveCommand({ db, tx, command, now, effectContext } = {}) {
  if (!db && !tx) throw new TypeError('reserveValveCommand requires db');
  if (tx) return reserveValveCommandTx(tx, command, now, effectContext);
  return db.transaction((scope) => reserveValveCommandTx(scope, command, now, effectContext));
}

function heldWriterContext(keys) {
  return { deviceEui: keys.length === 1 ? keys[0] : null, heldSet: new Set(keys) };
}

function queueWriter(key, callback) {
  const previous = writerQueues.get(key) || Promise.resolve();
  const scheduled = previous.then(callback);
  const settled = scheduled.then(() => undefined, () => undefined);
  writerQueues.set(key, settled);
  settled.then(() => { if (writerQueues.get(key) === settled) writerQueues.delete(key); });
  return scheduled;
}

function withValveWriters(deviceEuis, fn) {
  if (!Array.isArray(deviceEuis)) return Promise.reject(new TypeError('withValveWriters requires an array of device EUIs'));
  if (typeof fn !== 'function') return Promise.reject(new TypeError('withValveWriters requires a function'));
  let keys;
  try {
    keys = [...new Set(deviceEuis.map(normalizeDevice))].sort();
  } catch (error) {
    return Promise.reject(error);
  }
  const current = writerContext.getStore();
  if (current && current.heldSet) {
    if (keys.some((key) => !current.heldSet.has(key))) {
      return Promise.reject(errorWithCode('valve_writer_expansion', 'cannot expand a held valve writer set'));
    }
    return Promise.resolve().then(fn);
  }
  const acquire = (index) => {
    if (index >= keys.length) return writerContext.run(heldWriterContext(keys), fn);
    return queueWriter(keys[index], () => acquire(index + 1));
  };
  return acquire(0);
}

function withValveWriter(deviceEui, fn) {
  const key = normalizeDevice(deviceEui);
  if (typeof fn !== 'function') return Promise.reject(new TypeError('withValveWriter requires a function'));
  const current = writerContext.getStore();
  if (current && current.heldSet) {
    if (current.heldSet.has(key)) return Promise.resolve().then(fn);
    return Promise.reject(errorWithCode('valve_writer_expansion', 'cannot expand a held valve writer set'));
  }
  return withValveWriters([key], fn);
}

async function transaction(db, callback) {
  return db.transaction(callback);
}

async function updateOwnerTransportTx(tx, owner, patch) {
  if (!owner || !owner.type) throw errorWithCode('transport_owner_required', 'transport owner is required');
  if (owner.type === 'expectation') {
    const row = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
    if (!row) throw errorWithCode('transport_owner_not_found', 'expectation owner was not found');
    const next = mergeTransport(parsePersistedJson(row.transport_json, 'transport_state_malformed', {}), patch);
    await tx.run('UPDATE valve_actuation_expectations SET transport_json=? WHERE expectation_id=?', [json(next), owner.id]);
    return next;
  }
  if (owner.type === 'push') {
    const row = await tx.get('SELECT * FROM valve_schedule_pushes WHERE push_id=?', [owner.id]);
    if (!row) throw errorWithCode('transport_owner_not_found', 'push owner was not found');
    const next = mergeTransport(parsePersistedJson(row.transport_json, 'transport_state_malformed', {}), patch);
    await tx.run('UPDATE valve_schedule_pushes SET transport_json=? WHERE push_id=?', [json(next), owner.id]);
    return next;
  }
  if (owner.type === 'opaque') {
    const row = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [owner.device_eui]);
    const control = parseControlJson(row && row.conditional_control_json);
    const entries = Array.isArray(control.opaque) ? control.opaque : [];
    const index = entries.findIndex((entry) => entry.owner_id === owner.id || entry.queue_id === owner.id);
    const existing = index >= 0 ? entries[index] : { owner_id: owner.id, queue_id: null, device_eui: owner.device_eui };
    const nextEntry = mergeTransport(existing, patch);
    if (index >= 0) entries[index] = nextEntry; else entries.push(nextEntry);
    control.opaque = entries;
    if (row) await tx.run('UPDATE valve_settings SET conditional_control_json=? WHERE device_eui=?', [json(control), owner.device_eui]);
    else await tx.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', [owner.device_eui, json(control)]);
    return nextEntry;
  }
  throw errorWithCode('transport_owner_type', `unsupported transport owner ${owner.type}`);
}

const TRANSPORT_PHASES = new Set(['INTENT', 'ATTEMPTED', 'ACCEPTED', 'UNKNOWN', 'enqueue_failed_before_acceptance', 'enqueue_rejected']);
const TERMINAL_TRANSPORT_PHASES = new Set(['UNKNOWN', 'enqueue_failed_before_acceptance', 'enqueue_rejected']);

function mergeTransport(current, patch) {
  const next = { ...current, ...patch };
  // R3-B1 (night run): the first flush's unsent proof is evidence for ACK correlation and
  // cancel; a later merge never replaces it.
  if (current.first_invalidated_by_flush != null) {
    next.first_invalidated_by_flush = current.first_invalidated_by_flush;
    next.unsent_in_snapshot = current.unsent_in_snapshot;
  }
  if (patch.phase !== undefined && !TRANSPORT_PHASES.has(patch.phase)) throw errorWithCode('transport_phase_invalid', 'unsupported transport phase');
  if (current.queue_id != null && patch.queue_id != null && patch.queue_id !== current.queue_id) throw errorWithCode('transport_queue_id_immutable', 'accepted queue ID cannot change');
  if (current.queue_id != null && patch.queue_id === null) throw errorWithCode('transport_queue_id_immutable', 'accepted queue ID cannot be cleared');
  if (current.phase === 'ACCEPTED' && ['INTENT', 'ATTEMPTED'].includes(patch.phase)) throw errorWithCode('transport_phase_regression', 'accepted transport cannot regress');
  if (TERMINAL_TRANSPORT_PHASES.has(current.phase) && ['INTENT', 'ATTEMPTED', 'ACCEPTED'].includes(patch.phase)) throw errorWithCode('transport_phase_regression', 'terminal transport cannot be retried');
  if (current.effect_snapshot && patch.effect_snapshot
      && JSON.stringify(current.effect_snapshot) !== JSON.stringify(patch.effect_snapshot)) {
    throw errorWithCode('effect_snapshot_immutable', 'effect snapshot cannot be replaced');
  }
  return next;
}

async function setFlushIntentTx(tx, deviceEui, intent) {
  const row = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [deviceEui]);
  const control = parseControlJson(row && row.conditional_control_json);
  const flushes = Array.isArray(control.flushes) ? control.flushes : [];
  const index = flushes.findIndex((entry) => entry && entry.flush_id === intent.flush_id);
  if (index >= 0) flushes[index] = { ...flushes[index], ...intent };
  else flushes.push(intent);
  control.flushes = flushes.slice(-20);
  if (row) await tx.run('UPDATE valve_settings SET conditional_control_json=? WHERE device_eui=?', [json(control), deviceEui]);
  else await tx.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', [deviceEui, json(control)]);
}

function ownerFromRow(type, row) {
  return type === 'expectation' ? { type, id: row.expectation_id } : { type, id: row.push_id };
}

// R3-B1/M3 (night run): an owner an earlier COMPLETED flush invalidated holds no queue item, so a
// later flush does not capture it again (its proof stays, and the owner list stays bounded).
// R3-M5: an owner a flush that did not complete invalidated carries no proof and is captured
// again, so the next completed flush stamps the real one.
function invalidatedByEarlierFlush(transport) {
  return Boolean(transport && transport.phase === 'UNKNOWN' && transport.invalidated_by_flush
    && transport.first_invalidated_by_flush != null);
}

async function ownerRecords(db, deviceEui) {
  return db.transaction(async (tx) => {
    const expectations = await tx.all('SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
    const pushes = await tx.all('SELECT * FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
    const owners = [];
    for (const row of expectations) {
      const transport = parsePersistedJson(row.transport_json, 'transport_state_malformed', null);
      if (transportBlocks(transport, row, 'expectation') && !invalidatedByEarlierFlush(transport)) owners.push({ owner: ownerFromRow('expectation', row), row, transport });
    }
    for (const row of pushes) {
      const transport = parsePersistedJson(row.transport_json, 'transport_state_malformed', null);
      if (transportBlocks(transport, row, 'push') && !invalidatedByEarlierFlush(transport)) owners.push({ owner: ownerFromRow('push', row), row, transport });
    }
    const settings = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [deviceEui]);
    const control = parseControlJson(settings && settings.conditional_control_json);
    const opaque = control.opaque;
    let opaqueIdentityChanged = false;
    for (const [index, item] of (Array.isArray(opaque) ? opaque : []).entries()) {
      if (!transportBlocks(item, item, 'opaque') || invalidatedByEarlierFlush(item)) continue;
      // Legacy rows may have only a queue id (or neither id). Persist the
      // synthetic identity before capture so a later recovery updates this
      // exact row instead of appending a duplicate opaque owner.
      const id = item.owner_id || item.queue_id || `opaque:${deviceEui}:${index}`;
      if (!item.owner_id && !item.queue_id) { item.owner_id = id; opaqueIdentityChanged = true; }
      if (!item.device_eui) { item.device_eui = deviceEui; opaqueIdentityChanged = true; }
      owners.push({ owner: { type: 'opaque', id, device_eui: deviceEui }, row: item, transport: item });
    }
    if (opaqueIdentityChanged && settings) await tx.run('UPDATE valve_settings SET conditional_control_json=? WHERE device_eui=?', [json(control), deviceEui]);
    return owners;
  });
}

function transportMethod(transport, names) {
  for (const name of names) if (transport && typeof transport[name] === 'function') return transport[name].bind(transport);
  throw errorWithCode('transport_method_missing', `transport method ${names[0]} is required`);
}

function classifyEnqueueError(error) {
  if (error && (error.code === 'enqueue_failed_before_acceptance' || error.classification === 'enqueue_failed_before_acceptance') && error.provenance === 'local_preflight' && error.step === 'enqueueDownlink') return 'enqueue_failed_before_acceptance';
  const grpcCode = Number(error && error.grpcCode);
  if (error && error.provenance === 'chirpstack_enqueue_preacceptance' && (grpcCode === 3 || grpcCode === 16) && (error.step === 'enqueueDownlink' || error.step === 'enqueue')) return 'enqueue_rejected';
  return 'UNKNOWN';
}

async function persistAttempt(db, owner, phase, patch) {
  return transaction(db, (tx) => updateOwnerTransportTx(tx, owner, { phase, ...patch }));
}

async function ownerStateTx(tx, owner, deviceEui) {
  if (!owner || !owner.type) throw errorWithCode('transport_owner_required', 'transport owner is required');
  let row;
  if (owner.type === 'expectation') row = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
  else if (owner.type === 'push') row = await tx.get('SELECT * FROM valve_schedule_pushes WHERE push_id=?', [owner.id]);
  else if (owner.type === 'opaque') {
    const settings = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [owner.device_eui]);
    const control = parseControlJson(settings && settings.conditional_control_json);
    row = (Array.isArray(control.opaque) ? control.opaque : []).find((entry) => entry.owner_id === owner.id || entry.queue_id === owner.id);
  } else throw errorWithCode('transport_owner_type', `unsupported transport owner ${owner.type}`);
  if (!row) throw errorWithCode('transport_owner_not_found', 'transport owner was not found');
  const ownerDevice = normalizeDevice(row.device_eui || owner.device_eui);
  if (ownerDevice !== deviceEui) throw errorWithCode('transport_owner_device_mismatch', 'transport owner belongs to a different device');
  const transport = parsePersistedJson(row.transport_json || row, 'transport_state_malformed', {});
  let occurrence = null;
  if (owner.type === 'expectation' && row.command_id) occurrence = await tx.get('SELECT * FROM irrigation_occurrences WHERE command_id=?', [row.command_id]);
  let onceSchedule = null;
  if (owner.type === 'expectation' && row.command_id) {
    onceSchedule = await tx.get('SELECT vs.schedule_uuid, vs.fire_at FROM valve_once_dispatch_intents i JOIN valve_schedules vs ON vs.schedule_uuid=i.schedule_uuid WHERE i.command_id=? LIMIT 1', [row.command_id]);
  }
  if (occurrence && normalizeDevice(occurrence.device_eui) !== deviceEui) throw errorWithCode('transport_owner_device_mismatch', 'linked occurrence belongs to a different device');
  return { row, transport, occurrence, onceSchedule };
}

function opaqueMetadata(item) {
  return {
    original_payload: item && (item.original_payload || item.data || item.payload || null),
    payload: item && (item.data || item.payload || null),
    data: item && (item.data || item.payload || null),
    fPort: item && (item.fPort == null ? item.fport : item.fPort),
    confirmed: Boolean(item && item.confirmed),
    encrypted: item && (item.encrypted === false || item.isEncrypted === false) ? false : Boolean(item && (item.encrypted || item.isEncrypted)),
    provenance: item && item.provenance ? item.provenance : null,
    expiresAt: item && (item.expiresAt == null ? (item.expires_at == null ? null : item.expires_at) : item.expiresAt),
  };
}

async function captureEffectSnapshotTx(tx, owner, frame, options = {}) {
  if (!frame || typeof frame !== 'object') throw new TypeError('captureEffectSnapshot requires an exact frame');
  if (options && options.effect_snapshot) throw errorWithCode('effect_snapshot_forbidden', 'caller snapshots are never accepted');
  const device = normalizeDevice(options.device_eui || options.deviceEui || owner.device_eui);
  const state = await ownerStateTx(tx, owner, device);
  const occurrence = state.occurrence;
  if (options.timing_contract === effects.UNBOUNDED_SAFE_CLOSE_V1) {
    const captured = effects.buildUnboundedSafeCloseSnapshot({ frame, device_eui: device, reservation_receipt: options.reservation_receipt });
    effects.validateEffectSnapshot(captured, { device_eui: device });
    await updateOwnerTransportTx(tx, owner, { effect_snapshot: captured });
    return { ...captured, owner: state.row };
  }
  let anchor = state.row.created_at || state.transport.intent_at || state.transport.attempted_at;
  let capturedQualification;
  let context = options.qualificationContext || {};
  if (occurrence) {
    const evidence = parsePersistedJson(occurrence.decision_evidence_json, 'decision_evidence_malformed', {});
    if (!evidence.effect_bounds || !evidence.qualification) throw errorWithCode('effect_bounds_missing', 'conditional owner has no immutable effect bounds');
    anchor = occurrence.due_at;
    capturedQualification = evidence.qualification;
    context = { ...context, ...evidence.qualification_context, occurrence_key: `${occurrence.schedule_uuid}:${occurrence.local_date}:${occurrence.local_time}` };
    if (evidence.effect_bounds.interval_minutes != null) {
      options.interval_minutes = evidence.effect_bounds.interval_minutes;
      options.interval_source = evidence.effect_bounds.interval_source;
    }
  } else if (state.onceSchedule && state.onceSchedule.fire_at) {
    anchor = state.onceSchedule.fire_at;
    context = { ...context, schedule_uuid: state.onceSchedule.schedule_uuid };
  }
  if (!anchor || !Number.isFinite(instantMs(anchor))) throw errorWithCode('effect_anchor_missing', 'transport owner has no immutable anchor');
  const captured = effects.buildEffectSnapshot({ frame, anchor_at: anchor, device_eui: device,
    policy: options.policy, delivery_settings: options.delivery_settings,
    interval_source: options.interval_source, interval_minutes: options.interval_minutes,
    minimum_gap_minutes: options.minimum_gap_minutes,
    qualificationProvider: options.qualificationProvider, qualificationContext: context,
    explicit_expiry_at: state.transport.explicit_expiry_at || (occurrence && occurrence.expires_at) || null,
    capturedQualification });
  const ownerExpiry = state.transport.explicit_expiry_at || (occurrence && occurrence.expires_at) || null;
  const ownerExpiryMs = ownerExpiry == null ? null : instantMs(ownerExpiry);
  const snapshotExpiryMs = captured.explicit_expiry_at === null ? null : instantMs(captured.explicit_expiry_at);
  if ((ownerExpiryMs == null) !== (snapshotExpiryMs == null) || (ownerExpiryMs != null && ownerExpiryMs !== snapshotExpiryMs)) {
    throw errorWithCode('effect_snapshot_owner_mismatch', 'owner expiry does not match immutable snapshot expiry');
  }
  effects.validateEffectSnapshot(captured, { device_eui: device });
  if (occurrence) {
    try { validatePersistedOwnerRelation(state.row, occurrence, captured, device, { initialCapture: true }); }
    catch (error) { if (error && error.code === 'occurrence_relation') error.code = 'effect_bounds_mismatch'; throw error; }
  }
  const next = mergeTransport(state.transport, { effect_snapshot: captured });
  await updateOwnerTransportTx(tx, owner, { effect_snapshot: captured });
  if (occurrence) {
    const evidence = parsePersistedJson(occurrence.decision_evidence_json, 'decision_evidence_malformed', {});
    if (evidence.effect_snapshot && JSON.stringify(evidence.effect_snapshot) !== JSON.stringify(captured)) throw errorWithCode('effect_snapshot_mismatch', 'occurrence effect snapshot cannot be replaced');
    if (!evidence.effect_snapshot) await tx.run('UPDATE irrigation_occurrences SET decision_evidence_json=?, updated_at=? WHERE command_id=?', [json({ ...evidence, effect_snapshot: captured }), nowIso() , occurrence.command_id]);
  }
  return { ...captured, owner: state.row };
}

async function captureEffectSnapshot({ db, deviceEui, owner, frame, snapshot, now, policy, delivery_settings,
  device_eui, interval_source, interval_minutes, minimum_gap_minutes, qualificationProvider, qualificationContext } = {}) {
  const device = normalizeDevice(deviceEui || device_eui || (owner && owner.device_eui));
  if (!db || !owner || !frame) throw new TypeError('captureEffectSnapshot requires db, owner and frame');
  if (snapshot) throw errorWithCode('effect_snapshot_forbidden', 'caller snapshots are never accepted');
  return transaction(db, async (tx) => {
    await ensureOpaqueOwnerTx(tx, owner, device, frame);
    return captureEffectSnapshotTx(tx, owner, frame, { device_eui: device, policy, delivery_settings,
      interval_source, interval_minutes, minimum_gap_minutes, qualificationProvider, qualificationContext });
  });
}

async function claimOwnerAttemptTx(tx, owner, deviceEui, now, item, effectContext = {}) {
  await ensureOpaqueOwnerTx(tx, owner, deviceEui, item);
  const state = await ownerStateTx(tx, owner, deviceEui);
  const { transport, occurrence } = state;
  if (transport.phase) return { send: false, replayed: true, transport, occurrence, row: state.row };
  if (occurrence && occurrence.state !== 'RESERVED') return { send: false, replayed: true, transport, occurrence, row: state.row };
  const snapshot = transport.effect_snapshot;
  if (snapshot) {
    effects.validateEffectSnapshot(snapshot, { device_eui: deviceEui });
    effects.assertSnapshotMatchesFrame(snapshot, item);
    if (snapshot.timing_contract === effects.UNBOUNDED_SAFE_CLOSE_V1) {
      const receipt = effectContext.receipt;
      if (!receipt || receipt.boot_id !== snapshot.reservation_receipt.boot_id
          || !Number.isInteger(receipt.uptime_ms) || receipt.uptime_ms < snapshot.reservation_receipt.uptime_ms) {
        throw errorWithCode('close_receipt_unproven', 'safe CLOSE attempt receipt is missing or out of order');
      }
    } else {
      const cutoff = instantMs(snapshot.queue_expires_at);
      if (cutoff != null && instantMs(now) >= cutoff) throw errorWithCode('command_expired', 'immutable queue cutoff has elapsed');
      if (snapshot.qualification && snapshot.qualification.qualified === true) {
        const current = effectContext.currentQualification;
        if (!current || current.qualified !== true || current.identity !== snapshot.qualification.identity
            || !Number.isInteger(current.margin_seconds) || current.margin_seconds > snapshot.qualification.margin_seconds) {
          throw errorWithCode('qualification_revoked', 'captured qualification is no longer valid');
        }
      }
    }
  }
  await updateOwnerTransportTx(tx, owner, { phase: 'INTENT', intent_at: now });
  if (occurrence) {
    if (!occurrence.expires_at || !Number.isFinite(instantMs(occurrence.expires_at))) throw errorWithCode('conditional_expiry_missing', 'linked conditional occurrence has no valid expiry');
    if (occurrence.state !== 'RESERVED') throw errorWithCode('occurrence_not_reserved', `occurrence state ${occurrence.state} cannot be attempted`);
    await policyStore.transitionOccurrenceTx(tx, occurrence, { state: 'ATTEMPTED', attempted_at: now }, { now });
  }
  const attemptPatch = { phase: 'ATTEMPTED', attempted_at: now };
  if (snapshot && effectContext.receipt) attemptPatch.attempt_receipt = {
    boot_id: effectContext.receipt.boot_id,
    uptime_ms: effectContext.receipt.uptime_ms,
  };
  if (snapshot && effectContext.clock && effectContext.clock.trusted === true) {
    attemptPatch.attempt_trusted_at = nowIso(effectContext.clock.now == null ? now : effectContext.clock.now);
  }
  const attempted = await updateOwnerTransportTx(tx, owner, attemptPatch);
  return { send: true, replayed: false, transport: attempted, occurrence: occurrence ? await tx.get('SELECT * FROM irrigation_occurrences WHERE command_id=?', [occurrence.command_id]) : null, row: state.row };
}

async function ensureOpaqueOwnerTx(tx, owner, deviceEui, item) {
  if (owner.type !== 'opaque') return;
  const settings = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [deviceEui]);
  const control = parseControlJson(settings && settings.conditional_control_json);
  const entries = Array.isArray(control.opaque) ? control.opaque : [];
  const existingIndex = entries.findIndex((entry) => (owner.id && entry.owner_id === owner.id) || (owner.id && entry.queue_id === owner.id));
  if (existingIndex < 0) {
    entries.push({ owner_id: owner.id, queue_id: null, device_eui: deviceEui, ...opaqueMetadata(item) });
    control.opaque = entries;
    if (settings) await tx.run('UPDATE valve_settings SET conditional_control_json=? WHERE device_eui=?', [json(control), deviceEui]);
    else await tx.run('INSERT INTO valve_settings(device_eui, conditional_control_json) VALUES (?,?)', [deviceEui, json(control)]);
  } else if (!entries[existingIndex].phase && item) {
    entries[existingIndex] = { ...entries[existingIndex], ...opaqueMetadata(item) };
    control.opaque = entries;
    await tx.run('UPDATE valve_settings SET conditional_control_json=? WHERE device_eui=?', [json(control), deviceEui]);
  }
}

async function claimOwnerAttempt(db, owner, deviceEui, now, item, effectContext) {
  return transaction(db, (tx) => claimOwnerAttemptTx(tx, owner, deviceEui, now, item, effectContext));
}

async function occurrenceForOwner(db, owner) {
  if (!owner || owner.type !== 'expectation') return null;
  return db.transaction(async (tx) => {
    const expectation = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
    if (!expectation || !expectation.command_id) return null;
    return tx.get('SELECT * FROM irrigation_occurrences WHERE command_id=?', [expectation.command_id]);
  });
}

async function markOccurrenceSent(db, owner, queueId, now) {
  const occurrence = await occurrenceForOwner(db, owner);
  if (!occurrence || occurrence.state !== 'ATTEMPTED') return;
  await transaction(db, (tx) => policyStore.transitionOccurrenceTx(tx, occurrence, { state: 'SENT', queue_id: queueId, sent_at: nowIso(now) }, { now: nowIso(now) }));
}

async function enqueueValveCommand({ db, deviceEui, owner, item, transport, now, trustedContext } = {}) {
  const device = normalizeDevice(deviceEui || (item && item.devEui));
  if (!db || !owner || !item || !transport) throw new TypeError('enqueueValveCommand requires db, owner, item and transport');
  if (item.effect_snapshot) throw errorWithCode('effect_snapshot_forbidden', 'capture the immutable effect snapshot before enqueue');
  return withValveWriter(device, async () => {
    const claimContext = runtimeAttemptContext(trustedContext, now);
    const startedAt = nowIso(claimContext.now);
    const beforeClaim = await transaction(db, async (tx) => {
      await ensureOpaqueOwnerTx(tx, owner, device, item);
      return ownerStateTx(tx, owner, device);
    });
    if (!beforeClaim.transport.phase && beforeClaim.occurrence && beforeClaim.occurrence.state === 'RESERVED') {
      const expiresAt = beforeClaim.occurrence.expires_at;
      if (!Number.isFinite(instantMs(expiresAt))) throw errorWithCode('conditional_expiry_missing', 'linked conditional occurrence has no valid expiry');
      if (item.expiresAt != null && instantMs(item.expiresAt) !== instantMs(expiresAt)) throw errorWithCode('conditional_expiry_mismatch', 'caller expiry does not match the immutable occurrence expiry');
    }
    const stateContext = beforeClaim.transport && beforeClaim.transport.effect_snapshot
      ? { ...(trustedContext || {}), clock: claimContext.clock, receipt: claimContext.receipt } : {};
    const attempt = await claimOwnerAttempt(db, owner, device, startedAt, item, stateContext);
    if (!attempt.send) {
      return {
        accepted: attempt.transport.phase === 'ACCEPTED',
        phase: attempt.transport.phase || 'UNKNOWN',
        queue_id: attempt.transport.queue_id || attempt.occurrence && attempt.occurrence.queue_id || null,
        replayed: true,
      };
    }
    const occurrence = attempt.occurrence;
    const conditionalOccurrence = occurrence && occurrence.command_id;
    let expiresAt;
    if (conditionalOccurrence) {
      expiresAt = occurrence.expires_at;
      if (!Number.isFinite(instantMs(expiresAt))) throw errorWithCode('conditional_expiry_missing', 'linked conditional occurrence has no valid expiry');
    } else if (beforeClaim.transport && beforeClaim.transport.effect_snapshot) {
      expiresAt = beforeClaim.transport.effect_snapshot.queue_expires_at || undefined;
    }
    try {
      const enqueue = transport.enqueueDownlink || transport.enqueue;
      if (typeof enqueue !== 'function') throw errorWithCode('transport_method_missing', 'transport enqueue method is required');
      const result = await enqueue.call(transport, { ...item, devEui: device, expiresAt });
      const queueId = result && (result.id || result.queue_id || result.queueId);
      if (typeof queueId !== 'string' || !queueId.trim()) throw errorWithCode('enqueue_unknown', 'enqueue returned no queue id');
      await persistAttempt(db, owner, 'ACCEPTED', { queue_id: queueId, accepted_at: nowIso(claimContext.now) });
      await markOccurrenceSent(db, owner, queueId, claimContext.now);
      return { accepted: true, phase: 'ACCEPTED', queue_id: queueId };
    } catch (error) {
      const classification = classifyEnqueueError(error);
      if (classification === 'enqueue_failed_before_acceptance' || classification === 'enqueue_rejected') {
        await persistAttempt(db, owner, classification, { failure_code: classification, failed_at: nowIso() });
        await markOccurrencePreAcceptanceExpired(db, owner, classification, now);
        return { accepted: false, phase: classification, queue_id: null, error };
      }
      await persistAttempt(db, owner, 'UNKNOWN', { error: String(error && error.message || error), unknown_at: nowIso() });
      return { accepted: false, phase: 'UNKNOWN', queue_id: null, error };
    }
  });
}

function frameForComposition(frame, effectClass) {
  const source = frame && typeof frame === 'object' ? frame : {};
  const normalized = {
    fPort: Number(source.fPort == null ? source.fport : source.fPort),
    data: source.data == null ? source.payload : source.data,
    confirmed: source.confirmed === false ? false : source.confirmed,
    encrypted: source.encrypted === false ? false : source.encrypted,
    provenance: source.provenance && typeof source.provenance === 'object' ? { ...source.provenance } : null,
  };
  if (effectClass === effects.EFFECTS.CLOSE_ONLY) normalized.provenance = { source: 'local_encoder' };
  return normalized;
}

function compositionCommand(command, device, effectClass) {
  const input = command && typeof command === 'object' ? { ...command } : {};
  const id = commandId(input);
  if (effectClass === effects.EFFECTS.CLOSE_ONLY) {
    return { ...input, device_eui: device, command_id: id, action: 'CLOSE', duration_seconds: undefined, duration_minutes: undefined };
  }
  if (effectClass !== effects.EFFECTS.SELF_CLOSING_OPEN) throw errorWithCode('unsupported_effect', 'only timed OPEN and permanent CLOSE may use executeValveAttempt');
  return { ...input, device_eui: device, command_id: id, action: normalizeAction(commandValue(input, 'action', 'command_type', 'commandType')) };
}

// The live command composition seam.  All physical timed OPEN and permanent
// CLOSE writers enter here so conflict, snapshot capture, final checks, claim,
// and one enqueue share one reentrant per-device writer owner.
async function executeValveAttempt({ db, deviceEui, command, frame, transport, now, trustedContext, policy, delivery_settings,
  interval_source, interval_minutes, minimum_gap_minutes, qualificationProvider, qualificationContext, current_state, current_state_at,
  onceScheduleUuid } = {}) {
  const device = normalizeDevice(deviceEui || (command && (command.device_eui || command.deviceEui)));
  if (!db || !transport || !frame) throw new TypeError('executeValveAttempt requires db, frame and transport');
  const classified = effects.classifyEffect(frame);
  const normalizedFrame = frameForComposition(frame, classified.effect_class);
  const effectClass = effects.classifyEffect(normalizedFrame).effect_class;
  if (![effects.EFFECTS.SELF_CLOSING_OPEN, effects.EFFECTS.CLOSE_ONLY].includes(effectClass)) {
    throw errorWithCode('unsupported_effect', 'executeValveAttempt accepts only exact timed OPEN or permanent CLOSE frames');
  }
  let normalizedCommand = compositionCommand(command, device, effectClass);
  return withValveWriter(device, async () => {
    const firstContext = runtimeAttemptContext(trustedContext, now);
    const reservationNow = firstContext.now;
    const explicitExpiry = normalizedCommand.expires_at != null || normalizedCommand.expiresAt != null;
    const unboundedClose = effectClass === effects.EFFECTS.CLOSE_ONLY && !explicitExpiry && firstContext.clock.trusted !== true;
    // Owner decision 2026-10-24: a timed OPEN no longer requires an NTP sync since boot; the
    // runtime clock status stays diagnostic (attempt_trusted_at) and decides only the CLOSE variant.
    if (effectClass === effects.EFFECTS.CLOSE_ONLY && unboundedClose && !firstContext.receipt) {
      throw errorWithCode('clock_untrusted', 'safe CLOSE requires an internal runtime receipt');
    }
    const prepared = await transaction(db, async (tx) => {
      if (onceScheduleUuid) {
        const once = await tx.get("SELECT i.state, i.command_id, vs.schedule_uuid, vs.device_eui, vs.duration_minutes, vs.fire_at, d.irrigation_zone_id, d.user_id FROM valve_once_dispatch_intents i JOIN valve_schedules vs ON vs.schedule_uuid=i.schedule_uuid JOIN devices d ON d.deveui=vs.device_eui WHERE i.schedule_uuid=? AND i.state IN ('PENDING','UNKNOWN','ATTEMPTED','SENT') AND vs.kind='ONCE' AND vs.once_state='PENDING' AND vs.enabled=1 AND vs.deleted_at IS NULL AND d.deleted_at IS NULL", [onceScheduleUuid]);
        if (!once) return { owner: null, expectation: null, transport: { phase: 'UNKNOWN' }, replayed: true, send: false, once: null };
        normalizedCommand = { ...normalizedCommand, device_eui: device, command_id: once.command_id,
          duration_minutes: Number(once.duration_minutes), commanded_at: once.fire_at,
          trigger: 'one_time', zone_id: once.irrigation_zone_id };
        await tx.run("UPDATE valve_once_dispatch_intents SET state='ATTEMPTED', attempted_at=COALESCE(attempted_at, ?), updated_at=datetime('now') WHERE schedule_uuid=? AND state IN ('PENDING','UNKNOWN')", [nowIso(reservationNow), once.schedule_uuid]);
      }
      // Read the canonical device observation inside the reservation
      // transaction.  A caller supplied state is only a fallback for the
      // narrow fixture/legacy case where the device row is absent.
      const liveDevice = await tx.get('SELECT current_state, updated_at FROM devices WHERE UPPER(deveui)=UPPER(?)', [device]);
      const liveState = liveDevice && liveDevice.current_state != null ? liveDevice.current_state : current_state;
      const liveStateAt = liveDevice && liveDevice.updated_at != null ? liveDevice.updated_at : current_state_at;
      const reserved = await reserveValveCommandTx(tx, normalizedCommand, reservationNow, {
        policy, delivery_settings, interval_source, interval_minutes, minimum_gap_minutes,
        qualificationProvider, qualificationContext, current_state: liveState, current_state_at: liveStateAt,
      });
      const expectation = reserved.expectation;
      if (!expectation) throw errorWithCode('reservation_required', 'valve reservation did not create an expectation');
      const owner = { type: 'expectation', id: expectation.expectation_id };
      const currentTransport = expectation.transport_json ? parsePersistedJson(expectation.transport_json, 'transport_state_malformed', {}) : {};
      if (reserved.replayed) {
        if (!currentTransport.effect_snapshot) throw errorWithCode('effect_snapshot_missing', 'replayed owner has no immutable effect snapshot');
        effects.assertSnapshotMatchesFrame(currentTransport.effect_snapshot, normalizedFrame);
        const ownerExpiryRaw = Object.prototype.hasOwnProperty.call(currentTransport, 'explicit_expiry_at')
          ? currentTransport.explicit_expiry_at : null;
        const ownerExpiry = ownerExpiryRaw == null ? null : instantMs(ownerExpiryRaw);
        const snapshotExpiryRaw = currentTransport.effect_snapshot.explicit_expiry_at;
        const snapshotExpiry = snapshotExpiryRaw === null ? null : instantMs(snapshotExpiryRaw);
        if ((ownerExpiryRaw != null && ownerExpiry == null)
            || (snapshotExpiryRaw != null && snapshotExpiry == null)
            || (ownerExpiry == null) !== (snapshotExpiry == null)
            || (ownerExpiry != null && ownerExpiry !== snapshotExpiry)) {
          throw errorWithCode('effect_snapshot_owner_mismatch', 'owner expiry does not match immutable snapshot expiry');
        }
        const requestedExpiry = normalizedCommand.expires_at || normalizedCommand.expiresAt || null;
        const persistedExpiry = currentTransport.explicit_expiry_at || currentTransport.effect_snapshot.explicit_expiry_at || null;
        if (requestedExpiry != null && (persistedExpiry == null || instantMs(requestedExpiry) !== instantMs(persistedExpiry))) {
          throw errorWithCode('command_expiry_mismatch', 'replay expiry does not match the immutable owner expiry');
        }
        const resumable = !currentTransport.phase && !currentTransport.attempted_at && !currentTransport.attempt_receipt;
        return { owner, expectation, transport: currentTransport, replayed: !resumable, send: resumable, once: onceScheduleUuid || null };
      }
      await captureEffectSnapshotTx(tx, owner, normalizedFrame, {
        device_eui: device, policy, delivery_settings, interval_source, interval_minutes,
        minimum_gap_minutes, qualificationProvider, qualificationContext,
        timing_contract: unboundedClose ? effects.UNBOUNDED_SAFE_CLOSE_V1 : undefined,
        reservation_receipt: unboundedClose ? firstContext.receipt : undefined,
      });
      const ledger = normalizedCommand.ledger;
      if (ledger && ledger.command_id && ledger.originator) {
        await tx.run(
          'INSERT INTO applied_commands (command_id, device_eui, command_type, effect_key, applied_at, result, result_detail, originator) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(command_id) DO UPDATE SET originator=excluded.originator',
          [String(ledger.command_id), device, ledger.command_type || 'OPEN_FOR_DURATION', ledger.effect_key || null,
            nowIso(reservationNow), 'IN_PROGRESS', JSON.stringify({ commandId: String(ledger.command_id), commandType: ledger.command_type || 'OPEN_FOR_DURATION', status: 'PENDING', result: 'IN_PROGRESS', duplicate: false, reason: 'transport_pending' }), String(ledger.originator)]
        );
      }
      const stored = await tx.get('SELECT * FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
      return { owner, expectation: stored, transport: parsePersistedJson(stored.transport_json, 'transport_state_malformed', {}), replayed: false, send: true, once: onceScheduleUuid || null };
    });
    if (prepared.replayed) {
      return { accepted: prepared.transport.phase === 'ACCEPTED', phase: prepared.transport.phase || 'UNKNOWN',
        queue_id: prepared.transport.queue_id || null, replayed: true, owner: prepared.owner,
        snapshot: prepared.transport.effect_snapshot, once: prepared.once };
    }
    // Recheck clock and qualification after the snapshot commit, still under the
    // same writer. Provider I/O happens here, never with SQLite open.
    const finalContext = runtimeAttemptContext(trustedContext, now);
    const snapshot = prepared.transport.effect_snapshot;
    let currentQualification = null;
    if (snapshot.qualification && snapshot.qualification.qualified === true) {
      currentQualification = effects.qualificationResult(qualificationProvider, {
        device_eui: device, qualification_context: snapshot.qualification_context,
      });
    }
    const result = await enqueueValveCommand({
      db, deviceEui: device, owner: prepared.owner,
      item: { fPort: normalizedFrame.fPort, data: normalizedFrame.data, confirmed: false, encrypted: false, provenance: normalizedFrame.provenance },
      transport, now: finalContext.now,
      trustedContext: { ...(trustedContext || {}), currentQualification },
    });
    return { ...result, owner: prepared.owner, snapshot, once: prepared.once };
  });
}

async function recoverValveCommand({ db, deviceEui, owner, now } = {}) {
  const device = normalizeDevice(deviceEui);
  if (!db || !owner) throw new TypeError('recoverValveCommand requires db and owner');
  return withValveWriter(device, async () => {
    const at = nowIso(now);
    return transaction(db, async (tx) => {
      const state = await ownerStateTx(tx, owner, device);
      if (state.transport.phase === 'ACCEPTED' && state.transport.queue_id && state.occurrence && state.occurrence.state === 'ATTEMPTED') {
        const acceptedAt = Number.isFinite(instantMs(state.transport.accepted_at)) ? nowIso(state.transport.accepted_at) : at;
        await policyStore.transitionOccurrenceTx(tx, state.occurrence, {
          state: 'SENT', queue_id: state.transport.queue_id, sent_at: acceptedAt, updated_at: at,
        }, { now: at });
        return { recovered: true, replayed: false, phase: 'ACCEPTED', queue_id: state.transport.queue_id };
      }
      if (!['INTENT', 'ATTEMPTED'].includes(state.transport.phase)) return { recovered: false, replayed: true, phase: state.transport.phase || null, queue_id: state.transport.queue_id || null };
      await updateOwnerTransportTx(tx, owner, { phase: 'UNKNOWN', recovered_at: at });
      if (state.occurrence && ['ATTEMPTED', 'SENT'].includes(state.occurrence.state)) {
        await policyStore.transitionOccurrenceTx(tx, state.occurrence, { state: 'UNKNOWN', updated_at: at }, { now: at });
      }
      return { recovered: true, replayed: false, phase: 'UNKNOWN', queue_id: state.transport.queue_id || null };
    });
  });
}

// Persist explicit, profile-gated CLOSED evidence after the ingest transaction
// has committed. The writer is acquired before this short transaction, and the
// event is checked independently against every exact CLOSE owner.
async function observeClosedEvidence({ db, deviceEui, observedState, observedAt, event_identity, runtimeContext } = {}) {
  const device = normalizeDevice(deviceEui);
  if (String(observedState || '').trim().toUpperCase() !== 'CLOSED') return { observed: false, quiesced: [] };
  const eventMs = instantMs(observedAt);
  if (!Number.isFinite(eventMs)) throw errorWithCode('closed_evidence_invalid', 'CLOSED evidence timestamp is invalid');
  return withValveWriter(device, async () => {
    const checked = runtimeAttemptContext(runtimeContext, observedAt);
    const status = checked.clock;
    const runtimeReceipt = checked.receipt;
    if (status.trusted !== true || !Number.isFinite(checked.now)) throw errorWithCode('closed_evidence_untrusted_clock', 'CLOSED evidence requires a trusted runtime clock');
    if (eventMs > checked.now) throw errorWithCode('closed_evidence_future', 'CLOSED evidence is later than the checked runtime instant');
    if (!runtimeReceipt || typeof runtimeReceipt.boot_id !== 'string' || !runtimeReceipt.boot_id.trim() || !Number.isInteger(runtimeReceipt.uptime_ms) || runtimeReceipt.uptime_ms < 0) {
      throw errorWithCode('closed_evidence_receipt_missing', 'CLOSED evidence receipt is missing');
    }
    return transaction(db, async (tx) => {
    const rows = await tx.all('SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) ORDER BY rowid', [device]);
    const quiesced = [];
    for (const row of rows) {
      const transport = parsePersistedJson(row.transport_json, 'transport_state_malformed', {});
      const snapshot = transport.effect_snapshot;
      if (!snapshot || snapshot.effect_class !== effects.EFFECTS.CLOSE_ONLY) continue;
      let valid = false;
      const attemptReceipt = transport.attempt_receipt;
      if (snapshot.timing_contract === effects.UNBOUNDED_SAFE_CLOSE_V1) {
        if (!attemptReceipt || attemptReceipt.boot_id !== runtimeReceipt.boot_id || runtimeReceipt.uptime_ms < attemptReceipt.uptime_ms) continue;
        const marker = status.marker;
        if (transport.attempt_trusted_at) {
          const trustedAt = instantMs(transport.attempt_trusted_at);
          if (!Number.isFinite(trustedAt) || eventMs < trustedAt) continue;
        } else if (!marker || marker.boot_id !== runtimeReceipt.boot_id || !Number.isInteger(marker.epoch_ms) || !Number.isInteger(marker.uptime_ms)
            || marker.uptime_ms < attemptReceipt.uptime_ms || eventMs < marker.epoch_ms) continue;
        valid = true;
      } else {
        // A CLOSED uplink before this particular CLOSE reached its sole claim
        // is not evidence for that owner.  commanded_at is the reservation
        // anchor and must never manufacture an attempt boundary.
        if (!transport.attempted_at && !transport.attempt_trusted_at && !attemptReceipt) continue;
        const attemptAt = instantMs(transport.attempt_trusted_at || transport.attempted_at || row.commanded_at);
        if (attemptReceipt && (attemptReceipt.boot_id !== runtimeReceipt.boot_id || runtimeReceipt.uptime_ms < attemptReceipt.uptime_ms)) continue;
        if (!Number.isFinite(attemptAt) || eventMs < attemptAt) continue;
        valid = true;
      }
      if (!valid) continue;
      const evidence = { observed_state: 'CLOSED', observed_at: new Date(eventMs).toISOString(), receipt: { boot_id: runtimeReceipt.boot_id, uptime_ms: runtimeReceipt.uptime_ms }, event_identity: event_identity || null };
      const nextTransport = mergeTransport(transport, { closed_observation: evidence });
      await tx.run('UPDATE valve_actuation_expectations SET observed_close_at=?, reconciliation_state=?, transport_json=? WHERE expectation_id=?', [evidence.observed_at, 'OBSERVED_CLOSED', json(nextTransport), row.expectation_id]);
      quiesced.push({ expectation_id: row.expectation_id, observation: evidence });
    }
    return { observed: true, quiesced };
    });
  });
}

async function markOccurrenceUnknown(db, owner, now) {
  if (!owner || owner.type !== 'expectation') return;
  await transaction(db, async (tx) => {
    const expectation = await tx.get('SELECT command_id FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
    if (!expectation || !expectation.command_id) return;
    const occurrence = await tx.get('SELECT * FROM irrigation_occurrences WHERE command_id=?', [expectation.command_id]);
    if (!occurrence || !['ATTEMPTED', 'SENT'].includes(occurrence.state)) return;
    await policyStore.transitionOccurrenceTx(tx, occurrence, { state: 'UNKNOWN', updated_at: nowIso(now) }, { now: nowIso(now) });
  });
}

async function markOccurrencePreAcceptanceExpired(db, owner, failureCode, now) {
  if (!owner || owner.type !== 'expectation') return;
  await transaction(db, async (tx) => {
    const expectation = await tx.get('SELECT command_id FROM valve_actuation_expectations WHERE expectation_id=?', [owner.id]);
    if (!expectation || !expectation.command_id) return;
    const occurrence = await tx.get('SELECT * FROM irrigation_occurrences WHERE command_id=?', [expectation.command_id]);
    if (!occurrence || occurrence.state !== 'ATTEMPTED' || occurrence.queue_id != null || occurrence.sent_at != null) return;
    await policyStore.transitionOccurrenceTx(tx, occurrence, { state: 'EXPIRED', decision_reason: 'command_expired', updated_at: nowIso(now) }, {
      now: nowIso(now),
      authorization: policyStore.PRE_ACCEPTANCE_FAILURE_AUTHORIZATION,
      preAcceptanceFailure: { command_id: occurrence.command_id, phase: 'pre_acceptance', failure_code: failureCode, accepted: false, queue_id: null },
    });
  });
}

function accountingForOccurrence(occurrence, expectation, timezone) {
  const evidence = parsePersistedJson(occurrence.decision_evidence_json, 'decision_evidence_malformed', {});
  const accounting = evidence.accounting || {};
  const capturedTimezone = String(accounting.timezone || evidence.timezone || '').trim() || null;
  const capturedLocalDays = Array.isArray(accounting.local_days) ? accounting.local_days : (Array.isArray(evidence.local_days) ? evidence.local_days : []);
  const audit = {
    captured_timezone: capturedTimezone,
    captured_local_days: capturedLocalDays,
    captured_exclusion_end_at: evidence.exclusion_end_at || null,
    reservation_start_at: occurrence.reservation_start_at || null,
    reservation_end_at: occurrence.reservation_end_at || null,
  };
  const transport = expectation ? parsePersistedJson(expectation.transport_json, 'transport_state_malformed', {}) : {};
  const snapshot = transport && transport.effect_snapshot;
  if (snapshot) {
    try { effects.validateEffectSnapshot(snapshot, { device_eui: occurrence.device_eui }); } catch (_) {
      return { source: 'unknown_duration', days: {}, duration_minutes: null, ...audit };
    }
  }
  if (snapshot && snapshot.effect_class === effects.EFFECTS.SELF_CLOSING_OPEN) {
    const encodedSeconds = Number(snapshot.encoded_duration_seconds);
    const start = instantMs(snapshot.latest_physical_start_at);
    const end = instantMs(snapshot.future_effect_end);
    const anchor = instantMs(snapshot.anchor_at);
    const queueExpiry = instantMs(snapshot.queue_expires_at);
    const occurrenceExpiry = instantMs(occurrence.expires_at);
    const occurrenceEnd = instantMs(occurrence.reservation_end_at);
    if (!Number.isInteger(encodedSeconds) || encodedSeconds < 1 || !Number.isFinite(start) || !Number.isFinite(end)
        || !Number.isFinite(queueExpiry) || !Number.isFinite(anchor) || !Number.isFinite(occurrenceExpiry) || !Number.isFinite(occurrenceEnd)
        || end !== start + encodedSeconds * 1000 || occurrenceExpiry !== queueExpiry || occurrenceEnd !== end) {
      return { source: 'unknown_duration', days: {}, duration_minutes: null, ...audit };
    }
    const localDays = irrigationModel.localDaysForInterval(anchor, end, timezone);
    if (!localDays.length) return { source: 'unknown_duration', days: {}, duration_minutes: null, ...audit };
    const minutes = encodedSeconds / 60;
    return { source: 'conservative', days: Object.fromEntries(localDays.map((day) => [day, minutes])), duration_minutes: minutes, ...audit };
  }
  if (expectation && (expectation.observed_open_at != null || expectation.observed_close_at != null)) {
    if (expectation.observed_open_at != null && expectation.observed_close_at != null) {
      const open = instantMs(expectation.observed_open_at);
      const close = instantMs(expectation.observed_close_at);
      if (Number.isFinite(open) && Number.isFinite(close) && close >= open) {
        const days = irrigationModel.minutesByLocalDay(open, close, timezone);
        return { source: 'observed', days, duration_minutes: (close - open) / 60000, ...audit };
      }
    }
    return { source: 'unknown_duration', days: {}, duration_minutes: null, ...audit };
  }
  const minutes = Number(occurrence.reserved_minutes);
  const start = instantMs(occurrence.reservation_start_at);
  const end = instantMs(occurrence.reservation_end_at);
  if (!Number.isFinite(minutes) || minutes < 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { source: 'unknown_duration', days: {}, duration_minutes: null, ...audit };
  }
  const localDays = irrigationModel.localDaysForInterval(start, end, timezone);
  if (!localDays.length) return { source: 'unknown_duration', days: {}, duration_minutes: null, ...audit };
  return { source: 'conservative', days: Object.fromEntries(localDays.map((day) => [day, minutes])), duration_minutes: minutes, ...audit };
}

async function getDailyAccountingTx(tx, { deviceEui, timezone, currentTimezone } = {}) {
  const device = normalizeDevice(deviceEui);
  const budgetTimezone = String(timezone == null ? currentTimezone == null ? '' : currentTimezone : timezone).trim();
  if (!budgetTimezone) throw errorWithCode('accounting_timezone_required', 'current policy timezone is required');
  if (!irrigationModel.validTimezone(budgetTimezone)) throw errorWithCode('invalid_timezone', 'current policy timezone is invalid');
  const occurrences = await tx.all('SELECT * FROM irrigation_occurrences WHERE UPPER(device_eui)=UPPER(?) AND command_id IS NOT NULL', [device]);
  const expectations = await tx.all('SELECT * FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?)', [device]);
  const expectationByCommand = new Map(expectations.map((row) => [row.command_id, row]));
  const runs = [];
  const days = {};
  const seen = new Set();
  const unknownDuration = new Set();
  const unknownPhysicalRuns = new Set();
  const unknownIntervals = [];
  const seenPhysicalRuns = new Set();
  const addRun = (run) => {
    runs.push(run);
    for (const [day, minutes] of Object.entries(run.days)) days[day] = Number(((days[day] || 0) + minutes).toFixed(6));
  };
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.command_id)) continue;
    seen.add(occurrence.command_id);
    if (['PENDING', 'CLAIMED', 'SKIPPED', 'EXPIRED'].includes(occurrence.state)) continue;
    const accounting = accountingForOccurrence(occurrence, expectationByCommand.get(occurrence.command_id), budgetTimezone);
    addRun({ command_id: occurrence.command_id, source: accounting.source, days: accounting.days, captured_timezone: accounting.captured_timezone, captured_local_days: accounting.captured_local_days, captured_exclusion_end_at: accounting.captured_exclusion_end_at, reservation_start_at: accounting.reservation_start_at, reservation_end_at: accounting.reservation_end_at });
    if (accounting.source === 'unknown_duration') unknownDuration.add(occurrence.command_id);
  }
  for (const expectation of expectations) {
    if (expectation.command_id && seen.has(expectation.command_id)) continue;
    if (!expectation.command_id) {
      const physicalRunId = expectation.expectation_id;
      if (seenPhysicalRuns.has(physicalRunId)) continue;
      seenPhysicalRuns.add(physicalRunId);
      const physicalRun = parsePhysicalRun(expectation);
      if (physicalRun.report_only) {
        const possibleEndAt = physicalRun.marker && physicalRun.marker.latest_possible_end_at;
        const possibleStartAt = physicalRun.marker && physicalRun.marker.earliest_possible_start_at;
        const affectedLocalDays = Number.isFinite(instantMs(possibleEndAt)) && Number.isFinite(instantMs(possibleStartAt))
          ? irrigationModel.localDaysForInterval(instantMs(possibleStartAt), instantMs(possibleEndAt), budgetTimezone) : [];
        const interval = { physical_run_id: physicalRunId, possible_start_at: possibleStartAt, possible_end_at: possibleEndAt,
          possible_start_unbounded: possibleStartAt == null, possible_end_unbounded: possibleEndAt == null,
          affected_local_days: affectedLocalDays };
        unknownIntervals.push(interval);
        unknownPhysicalRuns.add(physicalRunId);
        addRun({ command_id: null, physical_run_id: physicalRunId, source: 'unknown_duration', unknown_duration: true, days: {}, duration_minutes: null, unknown_interval: interval, captured_timezone: null, captured_local_days: affectedLocalDays, captured_exclusion_end_at: null, reservation_start_at: null, reservation_end_at: null });
        continue;
      }
    }
    if (expectation.command_id) seen.add(expectation.command_id);
    const transport = parsePersistedJson(expectation.transport_json, 'transport_state_malformed', {});
    const snapshot = transport && transport.effect_snapshot;
    if (snapshot) {
      try { effects.validateEffectSnapshot(snapshot, { device_eui: expectation.device_eui }); } catch (_) {
        addRun({ command_id: expectation.command_id || null, physical_run_id: expectation.command_id ? null : expectation.expectation_id, source: 'unknown_duration', days: {}, captured_timezone: null, captured_local_days: [], captured_exclusion_end_at: null, reservation_start_at: expectation.commanded_at || null, reservation_end_at: expectation.expected_close_at || null });
        if (expectation.command_id) unknownDuration.add(expectation.command_id);
        else unknownPhysicalRuns.add(expectation.expectation_id);
        continue;
      }
    }
    if (snapshot && snapshot.effect_class === effects.EFFECTS.SELF_CLOSING_OPEN) {
      const seconds = Number(snapshot.encoded_duration_seconds);
      const start = instantMs(snapshot.latest_physical_start_at);
      const end = instantMs(snapshot.future_effect_end);
      const anchor = instantMs(snapshot.anchor_at);
      if (Number.isInteger(seconds) && seconds > 0 && Number.isFinite(start) && Number.isFinite(anchor) && Number.isFinite(end)
          && end === start + seconds * 1000) {
      const touched = irrigationModel.localDaysForInterval(anchor, end, budgetTimezone);
        if (touched.length) {
          const minutes = seconds / 60;
          addRun({ command_id: expectation.command_id || null, physical_run_id: expectation.command_id ? null : expectation.expectation_id, source: 'conservative', unknown_duration: !expectation.command_id, days: Object.fromEntries(touched.map((day) => [day, minutes])), captured_timezone: null, captured_local_days: [], captured_exclusion_end_at: snapshot.exclusion_end_at || null, reservation_start_at: snapshot.anchor_at || expectation.commanded_at || null, reservation_end_at: snapshot.future_effect_end || expectation.expected_close_at || null });
          if (!expectation.command_id) unknownPhysicalRuns.add(expectation.expectation_id);
          continue;
        }
      }
    }
    if (expectation.observed_open_at != null && expectation.observed_close_at != null) {
      const open = instantMs(expectation.observed_open_at); const close = instantMs(expectation.observed_close_at);
      if (Number.isFinite(open) && Number.isFinite(close) && close >= open) {
        addRun({ command_id: expectation.command_id || null, physical_run_id: expectation.command_id ? null : expectation.expectation_id, source: 'observed', unknown_duration: !expectation.command_id, days: irrigationModel.minutesByLocalDay(open, close, budgetTimezone), captured_timezone: null, captured_local_days: [], captured_exclusion_end_at: null, reservation_start_at: expectation.commanded_at || null, reservation_end_at: expectation.expected_close_at || null });
        continue;
      }
    }
    addRun({ command_id: expectation.command_id || null, physical_run_id: expectation.command_id ? null : expectation.expectation_id, source: 'unknown_duration', unknown_duration: true, days: {}, captured_timezone: null, captured_local_days: [], captured_exclusion_end_at: null, reservation_start_at: expectation.commanded_at || null, reservation_end_at: expectation.expected_close_at || null });
    if (expectation.command_id) unknownDuration.add(expectation.command_id);
    else unknownPhysicalRuns.add(expectation.expectation_id);
  }
  return { days, runs, unknown_duration_command_ids: [...unknownDuration].sort(), unknown_duration_physical_run_ids: [...unknownPhysicalRuns].sort(), unknown_intervals: unknownIntervals };
}

async function getDailyAccounting({ db, tx, deviceEui, timezone, currentTimezone } = {}) {
  if (tx) return getDailyAccountingTx(tx, { deviceEui, timezone, currentTimezone });
  if (!db) throw new TypeError('getDailyAccounting requires db');
  return db.transaction((scope) => getDailyAccountingTx(scope, { deviceEui, timezone, currentTimezone }));
}

function queueEntryId(entry) {
  return entry && (entry.id || entry.queue_id || entry.queueId);
}

function opaqueFromQueueEntry(entry, deviceEui, flushId) {
  const queueId = queueEntryId(entry);
  return {
    owner_id: queueId,
    queue_id: queueId,
    device_eui: deviceEui,
    phase: 'ACCEPTED',
    payload: entry.data || entry.payload || null,
    data: entry.data || entry.payload || null,
    fPort: entry.fPort == null ? entry.fport : entry.fPort,
    confirmed: Boolean(entry.confirmed),
    expiresAt: entry.expiresAt || entry.expires_at || null,
    isPending: entry.isPending == null ? entry.is_pending : Boolean(entry.isPending),
    captured_by_flush: flushId,
  };
}

async function captureRemoteQueueOwners(db, deviceEui, owners, snapshot, intent, capturedAt) {
  const known = new Set(owners.map((entry) => entry.transport && entry.transport.queue_id).filter(Boolean));
  const remote = [];
  const capturedSnapshot = Array.isArray(snapshot) ? snapshot : [];
  for (const item of capturedSnapshot) {
    const id = queueEntryId(item);
    if (!id || known.has(id)) continue;
    const opaque = opaqueFromQueueEntry(item, deviceEui, intent.flush_id);
    remote.push({ owner: { type: 'opaque', id, device_eui: deviceEui }, row: opaque, transport: opaque });
    known.add(id);
  }
  await transaction(db, async (tx) => {
    const settings = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [deviceEui]);
    const control = parseControlJson(settings && settings.conditional_control_json);
    const opaque = Array.isArray(control.opaque) ? control.opaque : [];
    for (const entry of remote) {
      if (!opaque.some((item) => item.owner_id === entry.owner.id || item.queue_id === entry.owner.id)) opaque.push(entry.row);
    }
    control.opaque = opaque;
    await tx.run('UPDATE valve_settings SET conditional_control_json=? WHERE device_eui=?', [json(control), deviceEui]);
    const captured = [...owners, ...remote].map(({ owner, transport: state }) => ({ ...owner, queue_id: state.queue_id || null, phase: state.phase || null }));
    await setFlushIntentTx(tx, deviceEui, {
      flush_id: intent.flush_id,
      owners: captured,
      captured_snapshot: capturedSnapshot,
      captured_at: capturedAt || nowIso(),
      capture_status: 'COMPLETE',
    });
  });
  return [...owners, ...remote];
}

async function loadFlushIntent(db, deviceEui, flushId) {
  return db.transaction(async (tx) => {
    const row = await tx.get('SELECT conditional_control_json FROM valve_settings WHERE device_eui=?', [deviceEui]);
    const control = parseControlJson(row && row.conditional_control_json);
    const intent = (Array.isArray(control.flushes) ? control.flushes : []).find((entry) => entry.flush_id === flushId);
    if (!intent) throw errorWithCode('flush_not_found', 'flush intent was not found');
    return intent;
  });
}

// completedSnapshot is passed only after the flush RPC completed: an item the snapshot held unsent
// was most likely removed before delivery (R3-B1, persisted once on the row). This is ACK
// correlation evidence only (store.provenUndelivered). It never proves a cancel: ChirpStack may
// deliver the item between the pre-flush read and the flush (owner decision 2026-10-24, fail
// closed; Codex P1 on PR #515), so cancel.js answers handed_off for a flushed open.
async function reconcileFlushOwners(db, deviceEui, owners, flushId, now, completedSnapshot) {
  const invalidated = [];
  for (const entry of owners) {
    const queueId = entry.transport && entry.transport.queue_id;
    // R3-M5: a flush that did not complete leaves no proof at all.
    const proof = Array.isArray(completedSnapshot) ? { first_invalidated_by_flush: flushId, unsent_in_snapshot: Boolean(queueId
      && completedSnapshot.some((item) => item && queueEntryId(item) === queueId && !(item.isPending || item.is_pending))) } : {};
    await persistAttempt(db, entry.owner, 'UNKNOWN', { ...(queueId ? { queue_id: queueId } : {}), invalidated_by_flush: flushId, invalidated_at: nowIso(now), ...proof });
    await markOccurrenceUnknown(db, entry.owner, now);
    if (queueId) invalidated.push(queueId);
  }
  return invalidated;
}

function ownersFromFlushIntent(intent, device) {
  return (Array.isArray(intent.owners) ? intent.owners : []).map((entry) => {
    const owner = { ...entry };
    if (owner.type === 'opaque' && !owner.device_eui) owner.device_eui = device;
    return { owner, transport: entry, row: entry };
  });
}

async function executeFlushIntent({ db, device, transport, flushId, snapshot, now, recovery = false } = {}) {
  const intent = await loadFlushIntent(db, device, flushId);
  const owners = ownersFromFlushIntent(intent, device);
  const replayed = Boolean(recovery);
  if (intent.result_status === 'COMPLETE' || intent.status === 'COMPLETE') {
    return { ok: true, phase: 'UNKNOWN', flush_id: flushId, snapshot: intent.captured_snapshot || snapshot || null, invalidated_queue_ids: intent.invalidated_queue_ids || [], replayed: true };
  }
  if (intent.attempt_status && intent.attempt_status !== 'NOT_STARTED') {
    const invalidated = await reconcileFlushOwners(db, device, owners, flushId, now);
    const queueIds = [...new Set([...(intent.invalidated_queue_ids || []), ...invalidated])];
    await transaction(db, (tx) => setFlushIntentTx(tx, device, {
      flush_id: flushId, status: 'UNKNOWN', attempt_status: 'UNKNOWN', result_status: 'UNKNOWN',
      invalidated_queue_ids: queueIds, reconciled_at: nowIso(now),
    }));
    return { ok: false, phase: 'UNKNOWN', flush_id: flushId, snapshot: intent.captured_snapshot || snapshot || null, invalidated_queue_ids: queueIds, replayed };
  }
  await transaction(db, (tx) => setFlushIntentTx(tx, device, {
    flush_id: flushId, attempt_status: 'STARTED', attempt_started_at: nowIso(now),
  }));
  try {
    const flush = transportMethod(transport, ['flushDeviceQueue', 'flushQueue', 'flush']);
    await flush(device);
  } catch (error) {
    const invalidated = await reconcileFlushOwners(db, device, owners, flushId, now);
    await transaction(db, (tx) => setFlushIntentTx(tx, device, {
      flush_id: flushId, status: 'UNKNOWN', attempt_status: 'UNKNOWN', result_status: 'UNKNOWN',
      error: String(error && error.message || error), failed_at: nowIso(), invalidated_queue_ids: invalidated,
    }));
    return { ok: false, phase: 'UNKNOWN', flush_id: flushId, error, invalidated_queue_ids: invalidated, replayed };
  }
  const invalidated = await reconcileFlushOwners(db, device, owners, intent.flush_id, now, intent.captured_snapshot);
  await transaction(db, (tx) => setFlushIntentTx(tx, device, {
    flush_id: flushId, status: 'COMPLETE', attempt_status: 'COMPLETE', result_status: 'COMPLETE',
    completed_at: nowIso(), invalidated_queue_ids: invalidated,
  }));
  return { ok: true, phase: 'UNKNOWN', flush_id: flushId, snapshot: intent.captured_snapshot || snapshot || null, invalidated_queue_ids: invalidated, replayed };
}

async function flushValveQueue({ db, deviceEui, reason, transport, now } = {}) {
  const device = normalizeDevice(deviceEui);
  if (!db || !transport) throw new TypeError('flushValveQueue requires db and transport');
  return withValveWriter(device, async () => {
    const at = nowIso(now);
    const owners = await ownerRecords(db, device);
    const intent = {
      flush_id: crypto.randomUUID(), reason: reason || 'unspecified', started_at: at, status: 'PENDING',
      capture_status: 'PENDING', attempt_status: 'NOT_STARTED', result_status: 'PENDING',
      owners: owners.map(({ owner, transport: state }) => ({ ...owner, queue_id: state.queue_id || null, phase: state.phase || null })),
    };
    await transaction(db, (tx) => setFlushIntentTx(tx, device, intent));
    const getQueue = transportMethod(transport, ['getDeviceQueue', 'getQueue']);
    let snapshot;
    try {
      snapshot = await getQueue(device);
      await captureRemoteQueueOwners(db, device, owners, snapshot, intent, at);
      return executeFlushIntent({ db, device, transport, flushId: intent.flush_id, snapshot, now });
    } catch (error) {
      await transaction(db, (tx) => setFlushIntentTx(tx, device, {
        flush_id: intent.flush_id, status: 'UNKNOWN', capture_status: 'UNKNOWN', result_status: 'UNKNOWN',
        error: String(error && error.message || error), failed_at: nowIso(),
      }));
      return { ok: false, phase: 'UNKNOWN', flush_id: intent.flush_id, error };
    }
  });
}

async function recoverValveFlush({ db, deviceEui, flushId, transport, now } = {}) {
  const device = normalizeDevice(deviceEui);
  if (!flushId) throw errorWithCode('flush_id_required', 'flushId is required for recovery');
  if (!db || !transport) throw new TypeError('recoverValveFlush requires db and transport');
  return withValveWriter(device, async () => {
    const intent = await loadFlushIntent(db, device, flushId);
    if (intent.result_status === 'COMPLETE' || intent.status === 'COMPLETE') return { ok: true, phase: 'UNKNOWN', flush_id: flushId, replayed: true, invalidated_queue_ids: intent.invalidated_queue_ids || [] };
    if (intent.attempt_status && intent.attempt_status !== 'NOT_STARTED') {
      return executeFlushIntent({ db, device, transport, flushId, snapshot: null, now, recovery: true });
    }
    if (intent.capture_status !== 'COMPLETE') {
      const owners = await ownerRecords(db, device);
      const getQueue = transportMethod(transport, ['getDeviceQueue', 'getQueue']);
      try {
        const snapshot = await getQueue(device);
        await captureRemoteQueueOwners(db, device, owners, snapshot, intent, nowIso(now));
      } catch (error) {
        await transaction(db, (tx) => setFlushIntentTx(tx, device, {
          flush_id: flushId, status: 'UNKNOWN', capture_status: 'UNKNOWN', result_status: 'UNKNOWN',
          error: String(error && error.message || error), failed_at: nowIso(),
        }));
        return { ok: false, phase: 'UNKNOWN', flush_id: flushId, error, replayed: true };
      }
    }
    return executeFlushIntent({ db, device, transport, flushId, snapshot: null, now, recovery: true });
  });
}

module.exports = {
  reserveValveCommand,
  reserveValveCommandTx,
  findValveConflictTx,
  withValveWriter, withValveWriters, runtimeAttemptContext, observationOwnerEligibility, parsePhysicalRun, isReportOnlyExpectation,
  isEdgeV1WireInstant, isLegacyV1CompatibilityExpectation, isV1LocalOnlyExpectation,
  projectObservationExpectation, hasBlockingObservation,
  validatePersistedOwnerRelation,
  executeValveAttempt,
  enqueueValveCommand,
  recoverValveCommand,
  observeClosedEvidence,
  flushValveQueue,
  recoverValveFlush,
  getDailyAccounting,
  getDailyAccountingTx,
  updateOwnerTransportTx,
  captureEffectSnapshot,
  captureEffectSnapshotTx,
  effects,
  PRE_ACCEPTANCE_FAILURE_AUTHORIZATION: policyStore.PRE_ACCEPTANCE_FAILURE_AUTHORIZATION,
};
