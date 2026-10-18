'use strict';
const crypto = require('node:crypto');
const P = require('./plan');
const store = require('./store');
const runtime = require('./runtime');

function hexOf(buf) { return Buffer.from(buf).toString('hex').toUpperCase(); }

function buildPlanPushes({ generation, days, lastHashes, force }) {
  const out = [];
  const last = lastHashes || {};
  if (generation === 'GEN2') {
    // Diff per weekday (CRITICAL 2, review round 1), not per group: a group's daymask is
    // just how the current compile happens to bucket identical days together, and that
    // bucketing can legitimately differ from compile to compile (e.g. a day changes then
    // reverts) even though a given weekday's own window did or didn't change. Pushing the
    // group whenever ANY of its weekdays is stale (or missing a hash — never pushed / only
    // superseded rows on record for it) keeps every weekday's actually-applied plan in sync
    // with what's compiled now, regardless of how it was grouped last time.
    for (const g of P.gen2Groups(days)) {
      const h = P.planHash(g.windows);
      const groupDays = g.daymask === 0x80 ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6].filter((d) => (g.daymask >> d) & 1);
      const stale = force || groupDays.some((d) => last['GEN2DAY:' + d] !== h);
      if (!stale) continue;
      out.push({ purpose: 'DAYMASK_PLAN', weekday: null, daymask: g.daymask, fport: P.GEN2_SCHEDULER_FPORT, payloadHex: hexOf(P.encodeGen2(g.daymask, g.windows)), planHash: h });
    }
    return out;
  }
  for (let d = 0; d < 7; d += 1) {
    const h = P.planHash(days[d]);
    if (!force && last['WEEKDAY_PLAN:' + d] === h) continue;
    out.push({ purpose: 'WEEKDAY_PLAN', weekday: d, daymask: null, fport: P.WEEKDAY_FPORT_BASE + d, payloadHex: hexOf(P.encodeGen1Day(days[d])), planHash: h });
  }
  return out;
}

function buildDownlinkMessage({ appId, deviceEui, fport, payloadHex }) {
  const eui = String(deviceEui).toUpperCase();
  return {
    topic: 'application/' + appId + '/device/' + eui + '/command/down',
    payload: { devEui: eui, confirmed: false, fPort: fport, data: Buffer.from(payloadHex, 'hex').toString('base64') },
  };
}

function buildStatusPush(code) {
  if (!['0', '1', '2'].includes(String(code))) throw new Error('scheduler status code must be 0, 1 or 2');
  return { purpose: 'SCHEDULER_STATUS', weekday: null, fport: P.STATUS_FPORT, payloadHex: hexOf(Buffer.from(String(code), 'ascii')), planHash: null };
}

function buildClockPush(generation, now, timeZone) {
  if (generation === 'GEN2') return { purpose: 'CLOCK_SYNC', weekday: null, fport: P.CLOCK_REQ_FPORT, payloadHex: '01', planHash: null };
  return { purpose: 'CLOCK_SYNC', weekday: null, fport: P.CLOCK_FPORT, payloadHex: hexOf(P.gen1ClockPayload(now, timeZone)), planHash: null };
}

function toRow(deviceEui, p) {
  return { push_id: crypto.randomUUID(), device_eui: deviceEui, purpose: p.purpose, weekday: p.weekday, fport: p.fport, payload_hex: p.payloadHex, plan_hash: p.planHash || null };
}

// Queue standalone pushes without touching the device queue: the clock tick's CLOCK_SYNC
// (workers.runClockTick). Supersedes older QUEUED rows of the same purpose and returns the MQTT
// messages to send now. Plan and scheduler-status changes never come through here: they are
// whole-state snapshots (compileAndQueue / queueSnapshot below).
async function queuePushes({ db, deviceEui, appId, pushes, warn }) {
  const rows = pushes.map((p) => toRow(deviceEui, p));
  if (!rows.length) return { rows, messages: [] };
  await db.transaction(async (tx) => {
    for (const purpose of new Set(pushes.map((p) => p.purpose))) await store.supersedeOutstanding(tx, deviceEui, [purpose]);
    await store.insertPushes(tx, rows);
  });
  if (warn && pushes.some((p) => SNAPSHOT_PURPOSES.includes(p.purpose))) {
    warn('[valve-control] queuePushes carried a plan/status push for ' + deviceEui + '; those belong in a snapshot');
  }
  return { rows, messages: rows.map((r) => buildDownlinkMessage({ appId, deviceEui, fport: r.fport, payloadHex: r.payload_hex })) };
}

// ---------------------------------------------------------------------------------------------
// CMD-04 PR0, design (C): snapshot compile (owner decision Q02 = (c): no automatic configuration
// re-send; a lost plan is surfaced, never silently expired).
//
// Every compile is a new intent and writes the COMPLETE desired state of every slot the valve
// can hold, read fresh from the DB:
//   GEN1  7 WEEKDAY_PLAN rows (FPort 14..20; an empty day is the all-FF plan) + SCHEDULER_STATUS.
//   GEN2  DAYMASK_PLAN rows (FPort 25) whose masks together cover all 7 days: plan.gen2Groups
//         puts every weekday into exactly one group, and the days without windows form a
//         zero-window frame, the GEN2 clear primitive (one byte, the day bits; '80' clears
//         every day). Whether STREGA SV2 firmware accepts that frame as a clear is hardware
//         gate 4 of the valve-control design, still open; the conditional-scheduling branch
//         relies on the same frame ('80').  + SCHEDULER_STATUS.
//   CLOCK_SYNC is never part of a snapshot: the valve tick computes it fresh at send time.
// The compile flushes the device queue (unless an open is still awaiting observation), marks
// every outstanding plan/status row SUPERSEDED -- the new snapshot overwrites every slot they
// covered -- and a flushed, unconfirmed CLOCK_SYNC too (clearing last_clock_sync_queued_at so
// the next tick sends a fresh one). Nothing previously emitted is ever replayed.
//
// The snapshot is not sent by the edit itself. It stays pending (app_settings key
// 'valve_snapshot_pending:<EUI>') and emitPendingSnapshots, run by the valve tick, sends it once
// SNAPSHOT_DEBOUNCE_MS has passed since the last edit, so N edits in a short window cost the
// airtime of one snapshot. The pending marker survives a Node-RED restart.
//
// A valve this gateway never programmed (no WEEKLY schedule and no plan push on record) gets a
// status-only snapshot from a scheduler-status change, so a plan written over Bluetooth is not
// wiped by a pause (the same guard api.js and unclaim.js apply to schedule deletes).
// ---------------------------------------------------------------------------------------------
const SNAPSHOT_PURPOSES = ['WEEKDAY_PLAN', 'DAYMASK_PLAN', 'SCHEDULER_STATUS'];
const SNAPSHOT_DEBOUNCE_MS = 30 * 1000;
// (R5 L3) Upper bound on the debounce: a snapshot is sent at the latest this long after the
// first edit it carries, however often the plan keeps being edited.
const SNAPSHOT_MAX_DELAY_MS = 5 * 60 * 1000;
// (R5 G1) Interim GEN2 option, app_settings key, default off. When set ('1'/'true'/'yes'/'on'),
// a GEN2 snapshot is: status, the whole-plan clear '80', then only the day groups that carry
// windows -- instead of gen2Groups' zero-window frame for the empty days. Failure modes until
// hardware gate 4 says which frames SV2 firmware accepts: without the prefix, an ignored
// zero-window frame leaves a deleted day watering (fail-wet); with it, an accepted '80' plus
// ignored plan frames leaves the valve without a plan (fail-dry).
const GEN2_CLEAR_PREFIX_KEY = 'valve_gen2_snapshot_clear_prefix';
const STATUS_CODES = { ACTIVE: '0', SKIP_TODAY: '1', DEACTIVATED: '2' };

function statusCodeFor(status) {
  const code = STATUS_CODES[String(status == null ? 'ACTIVE' : status).toUpperCase()];
  if (!code) {
    const err = new Error('invalid_status'); err.statusCode = 422; err.code = 'invalid_status'; throw err;
  }
  return code;
}

function planConflictError(details) {
  const err = new Error('plan_conflict'); err.statusCode = 422; err.code = 'plan_conflict'; err.details = details; return err;
}

// (R5 M1) The scheduler status goes FIRST: a pause or skip reaches the valve on the next uplink,
// not after seven plan writes. On a status change the plan rows equal what the valve already
// holds (every earlier edit sent its own snapshot), so the status never runs ahead of an
// unknown plan.
function buildSnapshotPushes({ generation, days, schedulerStatus, includePlan, gen2ClearPrefix }) {
  const status = buildStatusPush(statusCodeFor(schedulerStatus));
  if (!includePlan) return [status];
  if (generation === 'GEN2' && gen2ClearPrefix) {
    const clear = { purpose: 'DAYMASK_PLAN', weekday: null, daymask: 0x80, fport: P.GEN2_SCHEDULER_FPORT, payloadHex: hexOf(P.encodeGen2(0x80, [])), planHash: P.planHash([]) };
    const groups = P.gen2Groups(days).filter((g) => g.windows.length > 0)
      .map((g) => ({ purpose: 'DAYMASK_PLAN', weekday: null, daymask: g.daymask, fport: P.GEN2_SCHEDULER_FPORT, payloadHex: hexOf(P.encodeGen2(g.daymask, g.windows)), planHash: P.planHash(g.windows) }));
    return [status, clear].concat(groups);
  }
  return [status].concat(buildPlanPushes({ generation, days, lastHashes: {}, force: true }));
}

// Write one snapshot: flush, supersede, insert, and either leave it pending for the debounced
// emitter (default) or return its messages now (emitNow: the decommission sweep, which already
// runs inside the valve tick). The pushes come either ready-made (`pushes`) or from
// `build(tx)`, which runs inside the write transaction (R5 M2: a compile reads the schedules
// as they are when it writes, so a concurrent compile on another DB handle cannot leave an
// older snapshot as the pending truth).
async function queueSnapshot({ db, deviceEui, appId, pushes, build, flushQueue, warn, now, emitNow }) {
  const eui = String(deviceEui).toUpperCase();
  const nowDate = now || new Date();
  let flushed = false;
  const pending = await store.hasPendingObservation(db, eui);
  if (!pending && typeof flushQueue === 'function') {
    try { await flushQueue(eui); flushed = true; } catch (e) { warn && warn('[valve-control] queue flush failed ' + eui + ': ' + (e && e.message ? e.message : e)); }
  }
  let rows = [];
  let superseded = 0;
  await db.transaction(async (tx) => {
    const built = typeof build === 'function' ? await build(tx) : pushes;
    rows = built.map((p) => toRow(eui, p));
    superseded = await store.supersedeOutstanding(tx, eui, SNAPSHOT_PURPOSES);
    if (flushed && await store.supersedeOutstanding(tx, eui, ['CLOCK_SYNC'])) {
      await store.upsertSettings(tx, eui, { last_clock_sync_queued_at: null });
    }
    await store.insertPushes(tx, rows);
    if (emitNow) {
      await store.clearSnapshotPending(tx, eui);
    } else {
      // (R5 L3) keep the first edit's time across re-edits, for the max-delay bound.
      const previous = await store.getSnapshotPending(tx, eui);
      const firstEditedAt = (previous && (previous.first_edited_at || previous.edited_at)) || nowDate.toISOString();
      await store.setSnapshotPending(tx, eui, { edited_at: nowDate.toISOString(), first_edited_at: firstEditedAt, push_ids: rows.map((r) => r.push_id) });
    }
    // P3-E1 review fix (IMPORTANT 4): best-effort -- an emit failure here must not roll back the
    // push-ledger writes this same transaction just made (matches the flows.json seams' shape).
    try { await runtime.emitRuntimeChanged(tx, eui, warn); }
    catch (e) { warn && warn('[valve-control] queueSnapshot: runtime emit failed: ' + (e && e.message ? e.message : e)); }
  });
  const messages = emitNow ? rows.map((r) => buildDownlinkMessage({ appId, deviceEui: eui, fport: r.fport, payloadHex: r.payload_hex })) : [];
  return { rows, messages, flushed, superseded, deferred: !emitNow };
}

// Run by the valve tick. Sends each pending snapshot exactly once -- the marker is deleted in
// the same transaction that reads the rows, before the messages are handed to the flow -- when
// its last edit is at least debounceMs old, when its first edit is SNAPSHOT_MAX_DELAY_MS old
// (R5 L3), or when the gateway clock stepped back past it. Only rows still QUEUED are sent.
// (R5 M5) While an open awaits observation the compile could not flush, so the snapshot is
// held: edit bursts during one unobserved open then append one snapshot behind the radio
// queue, not one per burst.
async function emitPendingSnapshots({ db, now, appId, warn, debounceMs }) {
  const windowMs = debounceMs == null ? SNAPSHOT_DEBOUNCE_MS : debounceMs;
  const nowMs = (now || new Date()).getTime();
  const out = { messages: [], emitted: 0 };
  let pending = [];
  try { pending = await store.listSnapshotPending(db); }
  catch (e) { warn && warn('[valve-control] pending snapshots unreadable: ' + (e && e.message ? e.message : e)); return out; }
  for (const p of pending) {
    const editedMs = Date.parse(p.edited_at);
    const firstMs = Date.parse(p.first_edited_at || p.edited_at);
    const capReached = Number.isFinite(firstMs) && nowMs - firstMs >= SNAPSHOT_MAX_DELAY_MS;
    const due = capReached || !Number.isFinite(editedMs) || nowMs - editedMs >= windowMs || editedMs - nowMs > windowMs;
    if (!due) continue;
    // (R5 re-review N1) The M5 hold never outlasts the 5-minute cap: a delete compiled during
    // an unobserved open must not wait for the open (plus the 30-min reconciliation grace) to
    // end. At the cap the snapshot is appended behind the unflushed queue, so the queue grows
    // by at most one snapshot per 5 minutes per unobserved open. No separate bypass for
    // snapshots that carry clears: the cap already bounds every snapshot, clears included, and
    // telling "carries a clear" apart would need the previous snapshot's content.
    if (!capReached && await store.hasPendingObservation(db, p.device_eui)) continue;
    let rows = [];
    await db.transaction(async (tx) => {
      const current = await store.getSnapshotPending(tx, p.device_eui);
      if (!current || current.raw !== p.raw) return; // re-edited since the read: the next tick decides
      await store.clearSnapshotPending(tx, p.device_eui);
      rows = await store.queuedPushesById(tx, p.device_eui, current.push_ids);
      // (R5 re-review N3/N4) A cancel compares this marker's raw value before and after its
      // flush to tell rows emitted during the flush (still on the air) from rows it removed.
      if (rows.length) await store.setSnapshotEmitted(tx, p.device_eui, { emitted_at: new Date().toISOString(), push_ids: rows.map((r) => r.push_id) });
    });
    if (!rows.length) continue;
    out.emitted += 1;
    for (const r of rows) out.messages.push(buildDownlinkMessage({ appId, deviceEui: p.device_eui, fport: r.fport, payloadHex: r.payload_hex }));
  }
  return out;
}

// `force` is accepted for the callers' sake ("Resend plan", the GEN2 profile swap) but no longer
// changes anything: every compile is a full snapshot. `schedulerStatus` is the status a
// scheduler-status route is about to store (it writes valve_settings after this succeeds);
// otherwise the stored status is used. `statusOnlyOnConflict` (R5 M3, the status routes): a
// stored plan that compileWindows rejects must not block pause/skip/resume, so the snapshot
// falls back to the status alone. timeZoneFallback is unused since CLOCK_SYNC left the
// compile; it stays in the signature for the callers.
async function compileAndQueue({ db, deviceEui, appId, now, flushQueue, warn, schedulerStatus, statusOnlyOnConflict, settingsPatch }) {
  const eui = String(deviceEui).toUpperCase();
  const prefixSetting = await store.getGatewaySetting(db, GEN2_CLEAR_PREFIX_KEY, warn);
  const gen2ClearPrefix = ['1', 'true', 'yes', 'on'].includes(String(prefixSetting == null ? '' : prefixSetting).trim().toLowerCase());
  // (R5 re-review N2) `settingsPatch` (the status routes: scheduler_status, skip_today_date) is
  // written inside the snapshot transaction, before the snapshot is built from the settings,
  // so the stored status and the newest snapshot agree by construction: a compile from another
  // origin that commits afterwards reads the new status. The pre-flush validation build uses
  // the patch's status as an override, since nothing is written yet.
  const patchedStatus = settingsPatch && settingsPatch.scheduler_status != null ? settingsPatch.scheduler_status : null;
  const statusOverride = schedulerStatus != null ? schedulerStatus : patchedStatus;
  const build = async (q, override) => {
    const schedules = await store.listSchedules(q, eui);
    const settings = await store.getSettings(q, eui);
    const compiled = P.compileWindows(schedules);
    // (R5 L1) Any WEEKLY row, tombstones included, is the intent to program the valve: a delete
    // on a valve whose push history is missing (restored DB, replacement gateway) still clears.
    let includePlan = (await store.hasWeeklyEver(q, eui)) || (await store.hasPlanHistory(q, eui));
    if (compiled.errors.length) {
      if (!statusOnlyOnConflict) throw planConflictError(compiled.errors);
      includePlan = false;
    }
    const status = override != null ? override : settings.scheduler_status;
    const pushes = buildSnapshotPushes({ generation: settings.strega_generation, days: compiled.days, schedulerStatus: status, includePlan, gen2ClearPrefix });
    return { compiled, pushes };
  };
  // Validate before the flush: a refused compile must not touch the radio queue.
  let built = await build(db, statusOverride);
  if (built.compiled.errors.length && warn) warn('[valve-control] ' + eui + ': plan_conflict in the stored schedules; sending the scheduler status alone');
  const queued = await queueSnapshot({ db, deviceEui: eui, appId, flushQueue, warn, now, build: async (tx) => {
    if (settingsPatch) await store.upsertSettings(tx, eui, settingsPatch);
    built = await build(tx, schedulerStatus);
    return built.pushes;
  } });
  return Object.assign({ compiled: built.compiled }, queued);
}

module.exports = { buildPlanPushes, buildDownlinkMessage, buildStatusPush, buildClockPush, buildSnapshotPushes, statusCodeFor, queuePushes, queueSnapshot, emitPendingSnapshots, compileAndQueue, SNAPSHOT_DEBOUNCE_MS, SNAPSHOT_MAX_DELAY_MS, SNAPSHOT_PURPOSES, GEN2_CLEAR_PREFIX_KEY };
