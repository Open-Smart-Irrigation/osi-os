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
// cancelActuation() -- the same ChirpStack queue flush + mark-CANCELLED path the operator
// cancel button uses. That path writes devices.target_state (the commanded intent) and
// never current_state (what the valve last reported), so the commanded-vs-observed split
// F19/F25 restored stays intact: an open the valve already received still reads as open
// until the valve itself says otherwise.

const store = require('./store');
const push = require('./push');
const { cancelActuation } = require('./cancel');

const EUI_RE = /^[0-9A-F]{16}$/;

function skipped(eui, reason) {
  return { applicable: false, reason, device_eui: eui || null, schedules_cleared: 0, pushes_queued: 0, messages: [], cancelled: null };
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
  if (String(device.type_id || '') !== 'STREGA_VALVE') return skipped(eui, 'not_a_valve');
  // Refuse a valve that is still claimed. This only ever runs behind a completed unclaim,
  // so a claimed valve means the caller is wired to something other than the device delete
  // -- and wiping a working farm's irrigation plan is not a recoverable mistake. Checking
  // the state we depend on is cheaper than trusting the wiring to stay correct forever.
  if (device.user_id != null) return skipped(eui, 'still_claimed');

  let cancelled = null;
  try {
    cancelled = await cancelActuation({ db, deviceEui: eui, reason: 'device_unclaimed', flushQueue: o.flushQueue, now, warn });
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
  for (const schedule of live) await store.softDeleteSchedule(db, schedule.schedule_uuid);

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
  };
}

module.exports = { clearValveOnUnclaim };
