'use strict';
// Clearing a valve's on-valve plan when its device row is unclaimed.
//
// "Deleting" a device on the edge is an unclaim (F33): DELETE /api/devices/:deveui sets
// devices.user_id = NULL, it does not tombstone the row. Until this module existed that
// route left valve_schedules alone, so a STREGA valve kept running the weekly plan stored
// in its own firmware -- the plan executes inside the valve, there is no read-back FPort,
// and the GUI no longer listed the device or the schedule to remove it from. Exploratory
// finding X-04 / FINDINGS F104 counted 15 such orphan schedules on Silvan, every one
// enabled, on devices with user_id IS NULL: unattended irrigation with no operator surface.
//
// The mechanism that clears a valve already existed on the explicit schedule-delete route
// (DELETE /api/valves/:eui/schedules/:uuid in api.js): soft-delete the row, then let
// push.compileAndQueue() recompile the now-empty plan and queue the all-FF weekday plans
// that overwrite it inside the valve. This module reuses that pair verbatim instead of
// restating it, so the downlinks a device delete produces are the downlinks a schedule
// delete produces -- unclaim.test.js asserts that equality directly rather than trusting it.
//
// Nothing here sends a CLOSE. A STREGA is opened for a duration and closes itself
// (feedback_strega_valve_operation), so an in-flight actuation is retired through
// cancelActuation({ all: true }) -- every active actuation CANCELLED and the whole ChirpStack
// queue flushed, through the same core the operator
// cancel button uses. That path writes devices.target_state (the commanded intent) and
// never current_state (what the valve last reported), so the commanded-vs-observed split
// F19/F25 restored stays intact: an open the valve already received still reads as open
// until the valve itself says otherwise.

const store = require('./store');
const push = require('./push');
const { cancelActuation } = require('./cancel');

const EUI_RE = /^[0-9A-F]{16}$/;

function skipped(eui, reason, typeId) {
  return { applicable: false, reason, device_eui: eui || null, type_id: typeId || null, schedules_cleared: 0, pushes_queued: 0, messages: [], cancelled: null };
}

async function clearValveOnUnclaim(options) {
  const o = options || {};
  const db = o.db;
  const warn = typeof o.warn === 'function' ? o.warn : function () {};
  const now = o.now || new Date();
  const eui = String(o.deviceEui || '').trim().toUpperCase();
  if (!EUI_RE.test(eui)) return skipped(null, 'invalid_eui');

  const device = await db.get(
    'SELECT deveui, type_id, user_id FROM devices WHERE UPPER(deveui) = UPPER(?) AND deleted_at IS NULL LIMIT 1',
    [eui]
  );
  if (!device) return skipped(eui, 'not_found');
  // Refuse a device that is still claimed. This only ever runs behind a completed unclaim,
  // so a claimed device means the detach did not apply (a replayed cloud command older than
  // a re-claim, fenced on sync_version) or the caller is wired to something other than the
  // device delete -- and wiping a working farm's irrigation plan is not a recoverable
  // mistake. Checked before the type so a caller can tell "not detached" for any device.
  if (device.user_id != null) return skipped(eui, 'still_claimed', device.type_id);
  if (String(device.type_id || '') !== 'STREGA_VALVE') return skipped(eui, 'not_a_valve', device.type_id);

  try {
    return await clearUnclaimedValve(db, eui, o, now, warn);
  } catch (error) {
    // Past this point the device is a known, unclaimed valve: a failure may have left its
    // schedules tombstoned and its plan in the valve. runUnclaimCleanup reports that.
    if (error && typeof error === 'object') error.valveApplicable = true;
    throw error;
  }
}

async function clearUnclaimedValve(db, eui, o, now, warn) {
  let cancelled = null;
  try {
    cancelled = await cancelActuation({ db, deviceEui: eui, all: true, reason: 'device_unclaimed', flushQueue: o.flushQueue, now, warn });
  } catch (error) {
    // cancelActuation fails closed on a flush failure: nothing is marked CANCELLED if the
    // queued downlink could not be withdrawn. Keep that honesty -- but do not let it stop
    // the clearing, because the programmed plan is the standing risk and a queued open is
    // a single one. The expectation row stays as it was, so no surface claims a cancel
    // that did not happen.
    cancelled = { ok: false, error: String((error && error.message) || error) };
    warn('[valve-control] unclaim: could not cancel the in-flight actuation on ' + eui + ': ' + cancelled.error);
  }

  const live = await store.listSchedules(db, eui);
  for (const schedule of live) await store.softDeleteSchedule(db, schedule.schedule_uuid, eui); // (F144) scoped to the valve being unclaimed

  // Only WEEKLY rows are compiled into the on-valve plan, so only a WEEKLY tombstone needs
  // a clearing push -- the same gate api.js applies on the explicit schedule delete, for
  // the same reason: compiling unconditionally would push an empty plan to a valve this
  // gateway never programmed and silently wipe a Bluetooth-configured schedule. It is also
  // what makes a repeated unclaim a no-op on the wire.
  const hadWeekly = live.some((schedule) => String(schedule.kind) === 'WEEKLY');
  // A throw here (after the tombstones, before the queue) leaves the schedules gone and the
  // plan still in the valve, and a retry would find nothing WEEKLY left to trigger on. The
  // realistic causes are DB failures that would already have failed the tombstones above;
  // the caller logs the error rather than swallowing it, and POST /plan/resend re-derives
  // the push if a valve is ever re-claimed.
  const queued = hadWeekly
    ? await push.compileAndQueue({ db, deviceEui: eui, appId: o.appId, force: false, now, flushQueue: o.flushQueue, warn, timeZoneFallback: o.timeZoneFallback })
    : { rows: [], messages: [] };

  return {
    applicable: true,
    reason: null,
    device_eui: eui,
    schedules_cleared: live.length,
    pushes_queued: queued.rows.length,
    messages: Array.isArray(queued.messages) ? queued.messages : [],
    cancelled,
    // CMD-04 PR0 (design C): the clearing snapshot is not handed to ChirpStack here; the valve
    // tick sends it once the debounce window has passed (30-90 s later).
    clearing_deferred: !!queued.deferred,
    // Both flushes drop every downlink queued for this device, not only the unclaim's own
    // (owner decision D19(a)): the caller reports that collateral instead of hiding it.
    whole_queue_flushed: !!((cancelled && cancelled.ok && cancelled.queueScope === 'full_flush') || queued.flushed),
  };
}

// AUTH-09 PR A: the one cleanup outcome both unclaim origins report -- the local DELETE
// route in its response body, the cloud UNCLAIM_DEVICE in its ACK. It says what the cleanup
// did and never that the plan is gone: the valve has no read-back FPort, so a clearing plan
// handed to ChirpStack is evidence pending (the push ledger records the valve's ACK later),
// not proof. may_still_hold_plan is true, false, or null for "unknown".
function cleanupOutcome(fields) {
  return Object.assign({
    outcome: null,
    reason: null,
    attempted: false,
    device_eui: null,
    schedules_cleared: null,
    clearing_downlinks_sent: 0,
    in_flight_cancel: null,
    in_flight_cancel_error: null,
    whole_queue_flushed: null,
    may_still_hold_plan: null,
    plan_clear_confirmed: false,
  }, fields);
}

function unclaimCleanupUnavailable(detail, deviceEui) {
  return cleanupOutcome({ outcome: 'not_attempted', reason: 'helpers_unavailable: ' + String(detail || 'unknown'), device_eui: deviceEui || null });
}

// A cleanup that threw, or could not start (the flow nodes use this when the database cannot
// be opened). may_still_hold_plan is true once the device was known to be an unclaimed valve.
function unclaimCleanupFailed(deviceEui, error) {
  return cleanupOutcome({
    outcome: 'failed',
    reason: 'error: ' + String((error && error.message) || error),
    attempted: true,
    device_eui: String(deviceEui || '').trim().toUpperCase() || null,
    may_still_hold_plan: error && error.valveApplicable ? true : null,
  });
}

function inFlightCancelOf(cancelled) {
  if (!cancelled) return { state: null, error: null };
  if (cancelled.ok) return { state: 'cancelled', error: null };
  if (cancelled.error === 'no_active_actuation') return { state: 'none_active', error: null };
  return { state: 'failed', error: String(cancelled.error || 'unknown') };
}

async function runUnclaimCleanup(options) {
  const o = options || {};
  const appId = String(o.appId || '').trim();
  let result;
  try {
    result = await clearValveOnUnclaim(Object.assign({}, o, { appId }));
  } catch (error) {
    return { cleanup: unclaimCleanupFailed(o.deviceEui, error), downlinks: [] };
  }
  if (!result.applicable) {
    const stillClaimed = result.reason === 'still_claimed';
    const isValve = String(result.type_id || '') === 'STREGA_VALVE';
    return {
      cleanup: cleanupOutcome({
        outcome: stillClaimed ? 'not_attempted' : 'not_applicable',
        reason: result.reason,
        device_eui: result.device_eui,
        may_still_hold_plan: result.reason === 'not_found' || result.reason === 'invalid_eui' ? null : isValve,
      }),
      downlinks: [],
    };
  }
  const downlinks = appId ? result.messages.map((m) => ({ topic: m.topic, payload: m.payload })) : [];
  const cancel = inFlightCancelOf(result.cancelled);
  let outcome = 'no_plan_to_clear';
  let reason = null;
  if (result.pushes_queued > 0 && !appId) { outcome = 'clearing_not_sent'; reason = 'actuator_application_unset'; }
  // Rehearsal merge W1+W9: after PR0 the clearing leaves with the valve tick, so the outcome
  // must not say "sent" while clearing_downlinks_sent is 0.
  else if (result.pushes_queued > 0) outcome = result.clearing_deferred ? 'clearing_scheduled' : 'clearing_sent';
  if (cancel.state === 'failed') reason = (reason ? reason + '; ' : '') + 'in_flight_cancel_failed: ' + cancel.error;
  return {
    cleanup: cleanupOutcome({
      outcome,
      reason,
      attempted: true,
      device_eui: result.device_eui,
      schedules_cleared: result.schedules_cleared,
      clearing_downlinks_sent: downlinks.length,
      in_flight_cancel: cancel.state,
      in_flight_cancel_error: cancel.error,
      whole_queue_flushed: result.whole_queue_flushed,
      // Sent or not, nothing here proves the valve dropped its plan. With nothing to clear,
      // a plan set another way (Bluetooth) cannot be ruled out either.
      may_still_hold_plan: outcome === 'no_plan_to_clear' ? null : true,
    }),
    downlinks,
  };
}

module.exports = { clearValveOnUnclaim, runUnclaimCleanup, unclaimCleanupUnavailable, unclaimCleanupFailed };
