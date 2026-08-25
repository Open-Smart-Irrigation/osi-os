'use strict';
// Cancel STREGA Actuation - the shared core behind two entry points: the REST route
// POST /api/v1/valves/:deveui/cancel (flows.json node "Cancel STREGA Actuation") and the
// cloud->edge CANCEL_VALVE_ACTUATION command applier in cloud-commands.js. One code path,
// two entry points - the same pattern documented at the top of cloud-commands.js.
//
// Cancellation is a ChirpStack downlink-queue flush plus marking the newest active
// valve_actuation_expectations row CANCELLED. It NEVER sends a downlink to the valve - a
// bare CLOSE must never be sent to a STREGA valve (see feedback_strega_valve_operation).
//
// Behavior note: when there is no active expectation to cancel, this matches the REST
// route's existing behavior exactly rather than the alternative "flush anyway, succeed
// idempotently" shape - the REST route returns 404 without touching ChirpStack's queue at
// all when it finds nothing PENDING_OBSERVATION/OBSERVED_RUNNING, so this does the same
// (no flushQueue call, ok:false) to keep both entry points identical rather than widening
// the REST route's contract as a side effect of adding the cloud path.

const runtime = require('./runtime');

const ACTIVE_STATES = "('PENDING_OBSERVATION','OBSERVED_RUNNING')";

function normalizeReason(reason) {
  // Contract types `reason` as ["string","null"] - an explicit null must be treated the
  // same as absence, not as the literal string "null".
  const trimmed = String(reason === null || reason === undefined ? '' : reason).trim();
  return trimmed || 'operator_cancel';
}

async function cancelActuation({ db, deviceEui, reason, flushQueue, now, warn }) {
  // Fail closed BEFORE any write. The cloud CANCEL_VALVE_ACTUATION path (Valve Cloud
  // Command Bridge) builds flushQueue inside its own try/catch and passes null when
  // createProvisioningClientFromEnv throws - without this guard, a broken ChirpStack
  // client would silently skip the flush (the `typeof flushQueue === 'function'` check
  // below) while still marking the expectation CANCELLED and closing target_state, so a
  // queued OPEN_FOR_DURATION could still reach the valve while both sides believe it was
  // cancelled. The REST route never hits this: its flushQueue is a lazily-constructed
  // closure that is always a function (see cancel-strega-actuation-fn), so a broken
  // ChirpStack client there throws INSIDE the flush call below instead, before the
  // transaction runs - same fail-closed outcome, different failure point.
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

  const active = await db.get(
    'SELECT expectation_id, reconciliation_state FROM valve_actuation_expectations ' +
    'WHERE UPPER(device_eui) = UPPER(?) AND reconciliation_state IN ' + ACTIVE_STATES +
    ' ORDER BY commanded_at DESC LIMIT 1',
    [eui]
  );
  if (!active) return { ok: false, error: 'no_active_actuation', downlinks: [] };

  const cancelReason = normalizeReason(reason);
  const nowIso = (now || new Date()).toISOString();

  // Flush BEFORE the write, and let a flush failure propagate uncaught: if the queue
  // can't be flushed, the expectation must not be marked CANCELLED either (fail closed,
  // nothing mutated). flushQueue is guaranteed to be a function past the guard above.
  const queueFlush = await flushQueue(eui);

  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE valve_actuation_expectations SET reconciliation_state='CANCELLED', cancel_reason=? " +
      'WHERE expectation_id = (SELECT expectation_id FROM valve_actuation_expectations ' +
      'WHERE UPPER(device_eui) = UPPER(?) AND reconciliation_state IN ' + ACTIVE_STATES +
      ' ORDER BY commanded_at DESC LIMIT 1)',
      [cancelReason, eui]
    );
    await tx.run(
      "UPDATE devices SET target_state='CLOSED', updated_at=? WHERE UPPER(deveui)=UPPER(?)",
      [nowIso, eui]
    );
  });

  // P3-E1 review fix (IMPORTANT 4): best-effort. An emit failure here must not turn a
  // successful cancel (expectation CANCELLED, queue already flushed) into a reported failure --
  // a retry after that would find no_active_actuation and report a false error on an operation
  // that already fully succeeded.
  try { await runtime.emitRuntimeChanged(db, eui, warn); }
  catch (e) { warn && warn('[valve-control] cancelActuation: runtime emit failed: ' + (e && e.message ? e.message : e)); }

  // Bovey cloud full-parity Task P4-E1: CANCELLED is one of the terminal reconciliation_states
  // -- same best-effort rationale as the runtime emit immediately above.
  try { await runtime.emitActuationArchived(db, eui, active.expectation_id, warn); }
  catch (e) { warn && warn('[valve-control] cancelActuation: actuation-archive emit failed: ' + (e && e.message ? e.message : e)); }

  return {
    ok: true,
    downlinks: [],
    expectationId: active.expectation_id,
    previousState: active.reconciliation_state,
    reason: cancelReason,
    chirpstackQueueStatus: queueFlush && queueFlush.statusCode,
    timestamp: nowIso,
  };
}

module.exports = { cancelActuation };
