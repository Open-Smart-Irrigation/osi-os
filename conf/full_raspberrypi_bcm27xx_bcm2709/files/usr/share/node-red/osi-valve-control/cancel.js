'use strict';
// Cancel STREGA Actuation - the shared core behind two entry points: the REST route
// POST /api/v1/valves/:deveui/cancel (flows.json node "Cancel STREGA Actuation") and the
// cloud->edge CANCEL_VALVE_ACTUATION command applier in cloud-commands.js. One code path,
// two entry points - the same pattern documented at the top of cloud-commands.js.
//
// Cancellation stops ONE actuation: it takes that actuation's open downlink out of the
// ChirpStack device queue and marks its valve_actuation_expectations row CANCELLED. It
// NEVER sends a downlink to the valve - a bare CLOSE must never be sent to a STREGA valve.
//
// Which actuation (#428): the caller names it (expectationId); a cancel that names none is
// accepted only while exactly one actuation is active, and refused as ambiguous_actuation
// otherwise -- it never picks the newest. A named actuation that has already ended is
// refused as actuation_not_active. Both refusals are permanent and change nothing.
//
// Which queue items (#428): the device queue is read, the cancelled actuation's open
// downlink is taken out and every other item (plan pushes, configuration, other
// actuations' opens) is put back in its order. A stop must not fail on a queue that cannot
// be read: then the whole queue is flushed, as before this change, and the result says so.
//
// Behavior note: when there is no active expectation to cancel, this matches the REST
// route's existing behavior exactly rather than the alternative "flush anyway, succeed
// idempotently" shape - the REST route returns 404 without touching ChirpStack's queue at
// all when it finds nothing PENDING_OBSERVATION/OBSERVED_RUNNING, so this does the same
// (no flushQueue call, ok:false) to keep both entry points identical rather than widening
// the REST route's contract as a side effect of adding the cloud path.

const runtime = require('./runtime');

const ACTIVE_STATES = "('PENDING_OBSERVATION','OBSERVED_RUNNING')";

// F96: valve_actuation_expectations.cancel_reason (SQLite TEXT, unbounded) is shipped
// VERBATIM as ValveActuation.cancel_reason by sync-bootstrap-build/sync-force-build's
// `vae.cancel_reason` column read, and the cloud's mirror column is varchar(255) -- an
// oversized reason (e.g. a cloud CANCEL_VALVE_ACTUATION command forwarding free text
// from a user-facing field) would 500 the whole cloud bootstrap the same way F96's
// result_detail overflow did. Capped here at the writer (defense in depth alongside the
// sync-bootstrap-build/sync-force-build payload boundary, which also caps this field).
const CANCEL_REASON_MAX_LENGTH = 255;
const TRUNCATION_MARKER = '…[truncated]';

function truncateWithMarker(value, maxLength) {
  if (typeof value !== 'string' || value.length <= maxLength) return value;
  if (maxLength <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, maxLength);
  return value.slice(0, maxLength - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function normalizeReason(reason) {
  // Contract types `reason` as ["string","null"] - an explicit null must be treated the
  // same as absence, not as the literal string "null".
  const trimmed = String(reason === null || reason === undefined ? '' : reason).trim();
  return trimmed || 'operator_cancel';
}

// The downlinks a timed open of this many seconds can have been sent as (flows.json
// "Build STREGA downlink": OPEN_FOR_DURATION is [0x41, minutes]; a TIMED_ACTION open is
// [0x21, seconds], [0x41, minutes] or [0x81, hours]), all on fPort 2, as hex strings.
const OPEN_FPORT = 2;
function openSignatures(durationSeconds) {
  const seconds = Number(durationSeconds);
  const out = new Set();
  if (!Number.isFinite(seconds) || seconds <= 0) return out;
  const hex = (bytes) => Buffer.from(bytes).toString('hex');
  out.add(hex([0x41, Math.min(255, Math.max(1, Math.ceil(seconds / 60)))]));
  if (Number.isInteger(seconds) && seconds <= 255) out.add(hex([0x21, seconds]));
  if (seconds % 3600 === 0 && seconds / 3600 <= 255) out.add(hex([0x81, seconds / 3600]));
  return out;
}

function itemSignature(item) {
  if (!item || Number(item.fPort) !== OPEN_FPORT || item.isPending || item.isEncrypted) return null;
  try { return Buffer.from(String(item.data || ''), 'base64').toString('hex'); }
  catch (_) { return null; }
}

// Index (into items) of the target's open downlink, or -1 when it is no longer queued.
// ChirpStack sends a device's queue first in, first out, so among the active actuations
// whose open looks like the target's, the newest k still have their open queued, where k
// is the number of matching queue items: the target's item is found by its rank.
function targetQueueIndex(items, active, target) {
  const signatures = openSignatures(target.commanded_duration_seconds);
  const matching = [];
  items.forEach((item, index) => { if (signatures.has(itemSignature(item))) matching.push(index); });
  const peers = active.filter((row) => {
    for (const signature of openSignatures(row.commanded_duration_seconds)) {
      if (signatures.has(signature)) return true;
    }
    return false;
  });
  const rank = peers.findIndex((row) => row.expectation_id === target.expectation_id);
  if (rank < 0) return -1;
  const position = matching.length - (peers.length - rank);
  return position >= 0 ? matching[position] : -1;
}

async function resolveTarget(db, eui, expectationId) {
  const active = await db.all(
    'SELECT expectation_id, reconciliation_state, commanded_duration_seconds FROM valve_actuation_expectations ' +
    'WHERE UPPER(device_eui) = UPPER(?) AND reconciliation_state IN ' + ACTIVE_STATES +
    ' ORDER BY commanded_at ASC, rowid ASC',
    [eui]
  );
  if (expectationId) {
    const named = await db.get(
      'SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations ' +
      'WHERE expectation_id = ? AND UPPER(device_eui) = UPPER(?) LIMIT 1',
      [expectationId, eui]
    );
    // Not known (yet): the same answer as a cancel with nothing to cancel.
    if (!named) return { error: 'no_active_actuation' };
    const target = active.find((row) => row.expectation_id === named.expectation_id);
    if (!target) return { error: 'actuation_not_active', permanent: true };
    return { target, active };
  }
  if (active.length === 0) return { error: 'no_active_actuation' };
  if (active.length > 1) return { error: 'ambiguous_actuation', permanent: true, active };
  return { target: active[0], active };
}

// Takes the target's open out of the device queue and puts every other item back.
async function removeTargetDownlink({ eui, target, active, flushQueue, readQueue, enqueue, warn }) {
  let items = null;
  if (typeof readQueue === 'function' && typeof enqueue === 'function') {
    try {
      items = await readQueue(eui);
      if (!Array.isArray(items)) throw new Error('device queue is not a list');
    } catch (e) {
      items = null;
      warn && warn('[valve-control] cancelActuation: device queue unreadable, flushing all of it for ' + eui + ': ' + (e && e.message ? e.message : e));
    }
  }
  if (!items) {
    const flushed = await flushQueue(eui);
    return { scope: 'full_flush', flushed, kept: 0, lost: 0 };
  }
  const index = targetQueueIndex(items, active, target);
  // The target's open has already been sent (or was never queued): nothing to take out.
  if (index < 0) return { scope: 'not_queued', flushed: null, kept: items.length, lost: 0 };
  const keep = items.filter((item, i) => i !== index && !item.isPending);
  const flushed = await flushQueue(eui);
  let kept = 0;
  let lost = 0;
  for (const item of keep) {
    if (item.isEncrypted) {
      lost += 1;
      warn && warn('[valve-control] cancelActuation: an encrypted queue item for ' + eui + ' cannot be queued again and was dropped');
      continue;
    }
    try {
      await enqueue({ devEui: eui, fPort: Number(item.fPort), data: item.data, confirmed: !!item.confirmed });
      kept += 1;
    } catch (e) {
      lost += 1;
      warn && warn('[valve-control] cancelActuation: could not queue an item again for ' + eui + ': ' + (e && e.message ? e.message : e));
    }
  }
  return { scope: 'target_only', flushed, kept, lost };
}

// all: true is for a valve leaving this gateway (unclaim.js): every active actuation is
// cancelled and the whole device queue flushed, since nothing queued for it stays wanted.
async function cancelActuation({ db, deviceEui, expectationId, all, reason, flushQueue, readQueue, enqueue, now, warn }) {
  // Fail closed BEFORE any write. The cloud CANCEL_VALVE_ACTUATION path (Valve Cloud
  // Command Bridge) builds flushQueue inside its own try/catch and passes null when
  // createProvisioningClientFromEnv throws - without this guard, a broken ChirpStack
  // client would silently skip the flush while still marking the expectation CANCELLED and
  // closing target_state, so a queued OPEN_FOR_DURATION could still reach the valve while
  // both sides believe it was cancelled. The REST route's flushQueue is a lazily-constructed
  // closure that is always a function, so a broken ChirpStack client there throws INSIDE the
  // queue handling below instead, before the transaction runs - same fail-closed outcome.
  if (typeof flushQueue !== 'function') {
    return { ok: false, error: 'chirpstack_unavailable', downlinks: [] };
  }

  const eui = String(deviceEui || '').trim().toUpperCase();
  if (!eui) return { ok: false, error: 'device_eui is required', downlinks: [] };

  const device = await db.get(
    'SELECT deveui, type_id FROM devices WHERE UPPER(deveui) = UPPER(?) AND deleted_at IS NULL LIMIT 1',
    [eui]
  );
  if (!device) return { ok: false, error: 'not_found', downlinks: [] };
  if (String(device.type_id || '') !== 'STREGA_VALVE') return { ok: false, error: 'not_a_valve', downlinks: [] };

  const named = expectationId === undefined || expectationId === null ? '' : String(expectationId).trim();
  const resolved = all === true ? await resolveTarget(db, eui, '') : await resolveTarget(db, eui, named);
  if (resolved.error && !(all === true && resolved.error === 'ambiguous_actuation')) {
    return { ok: false, error: resolved.error, permanent: !!resolved.permanent, downlinks: [] };
  }
  const targets = all === true ? resolved.active : [resolved.target];
  const active = targets[targets.length - 1];

  const normalizedReason = normalizeReason(reason);
  const cancelReason = truncateWithMarker(normalizedReason, CANCEL_REASON_MAX_LENGTH);
  if (cancelReason !== normalizedReason && typeof warn === 'function') {
    warn(
      '[valve-control] cancelActuation: cancel_reason truncated to ' + CANCEL_REASON_MAX_LENGTH +
      ' chars for ' + eui + ' (full text): ' + normalizedReason
    );
  }
  const nowIso = (now || new Date()).toISOString();

  // Queue work BEFORE the write, and let a flush failure propagate uncaught: if the queue
  // can't be flushed, the expectation must not be marked CANCELLED either (fail closed,
  // nothing mutated).
  const queue = all === true
    ? { scope: 'full_flush', flushed: await flushQueue(eui), kept: 0, lost: 0 }
    : await removeTargetDownlink({ eui, target: active, active: resolved.active, flushQueue, readQueue, enqueue, warn });

  await db.transaction(async (tx) => {
    for (const target of targets) {
      await tx.run(
        "UPDATE valve_actuation_expectations SET reconciliation_state='CANCELLED', cancel_reason=? " +
        'WHERE expectation_id = ? AND reconciliation_state IN ' + ACTIVE_STATES,
        [cancelReason, target.expectation_id]
      );
    }
    // Another actuation still running keeps the valve's target state.
    await tx.run(
      "UPDATE devices SET target_state='CLOSED', updated_at=? WHERE UPPER(deveui)=UPPER(?) " +
      'AND NOT EXISTS (SELECT 1 FROM valve_actuation_expectations WHERE UPPER(device_eui) = UPPER(?) ' +
      'AND reconciliation_state IN ' + ACTIVE_STATES + ')',
      [nowIso, eui, eui]
    );
  });

  // P3-E1 review fix (IMPORTANT 4): best-effort. An emit failure here must not turn a
  // successful cancel (expectation CANCELLED, queue already handled) into a reported failure --
  // a retry after that would find no_active_actuation and report a false error on an operation
  // that already fully succeeded.
  try { await runtime.emitRuntimeChanged(db, eui, warn); }
  catch (e) { warn && warn('[valve-control] cancelActuation: runtime emit failed: ' + (e && e.message ? e.message : e)); }

  // cloud full-parity Task P4-E1: CANCELLED is one of the terminal reconciliation_states
  // -- same best-effort rationale as the runtime emit immediately above.
  for (const target of targets) {
    try { await runtime.emitActuationArchived(db, eui, target.expectation_id, warn); }
    catch (e) { warn && warn('[valve-control] cancelActuation: actuation-archive emit failed: ' + (e && e.message ? e.message : e)); }
  }

  return {
    ok: true,
    downlinks: [],
    expectationId: active.expectation_id,
    previousState: active.reconciliation_state,
    reason: cancelReason,
    queueScope: queue.scope,
    queueItemsKept: queue.kept,
    queueItemsLost: queue.lost,
    chirpstackQueueStatus: queue.flushed && queue.flushed.statusCode,
    timestamp: nowIso,
  };
}

module.exports = { cancelActuation };
