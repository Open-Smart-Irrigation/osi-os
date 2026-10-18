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

// Queue a list of built pushes: supersede older QUEUED of the same key, insert rows, build MQTT messages.
// MINOR 7 (review round 1): the ChirpStack flush runs before the insert transaction below, so
// a transaction failure after a successful flush would drop the previously-queued payloads
// that were just flushed out. Accepted as a low-probability edge case rather than widening the
// transaction to cover an external network call.
async function queuePushes({ db, deviceEui, appId, pushes, generation, flushQueue, warn }) {
  const purposes = new Set(pushes.map((p) => p.purpose));
  // MAJOR-A fix (review round 2): the per-push supersede below only ever touches rows of
  // the SAME purpose as what was just compiled. A Gen1->Gen2 self-correction compiles
  // DAYMASK_PLAN pushes, so the 7 pre-switch WEEKDAY_PLAN rows are a different purpose and
  // are never touched -- they stay QUEUED forever, and pushSummary buckets GEN1/GEN2 rows
  // under separate keyspaces (WEEKDAY_PLAN:<d> vs GEN2DAY:<d>), so the abandoned rows are
  // counted *in addition to* the new ones instead of being replaced by them. The farmer's
  // GUI badge then reports a permanent phantom "queued", followed by "failed" 24h later, for
  // a plan the valve already abandoned. Whenever this compile produced a push of one
  // generation's purpose, also supersede any leftover QUEUED rows of the other generation's
  // plan purpose for this device -- reusing the same supersedeQueued() helper the per-push
  // loop below already calls, once per weekday (WEEKDAY_PLAN has no single "all weekdays"
  // token) or once with the full 7-day mask (DAYMASK_PLAN intersects on mask overlap).
  //
  // M1 fix (post-deploy review): the flags above are also derived straight from the caller's
  // `generation`, not only from the purposes actually compiled. compileAndQueue always knows
  // the device's CURRENT (post-switch) generation, even on a compile that produces zero
  // pushes -- e.g. a GEN2->GEN1 demotion whose GEN1 hashes still match the ACKED rows from
  // before the promotion. Without this, `if (!pushes.length) return` below would exit before
  // ever reaching this supersede, leaving the abandoned generation's plan row QUEUED forever
  // (the same phantom-failure badge MAJOR-A fixed, mirrored in the demotion direction). A
  // caller that doesn't know/pass `generation` (e.g. a bare SCHEDULER_STATUS or CLOCK_SYNC
  // push queued outside a compile) leaves these exactly as purpose-derived, unchanged.
  const supersedeWeekday = purposes.has('DAYMASK_PLAN') || generation === 'GEN2';
  const supersedeDaymask = purposes.has('WEEKDAY_PLAN') || (generation != null && generation !== 'GEN2');
  if (!pushes.length && !supersedeWeekday && !supersedeDaymask) return { rows: [], messages: [], flushed: false, lost: 0 };
  let flushed = false;
  if (pushes.length) {
    const pending = await store.hasPendingObservation(db, deviceEui);
    if (!pending && typeof flushQueue === 'function') {
      try { await flushQueue(deviceEui); flushed = true; } catch (e) { warn && warn('[valve-control] queue flush failed ' + deviceEui + ': ' + (e && e.message ? e.message : e)); }
    }
  }
  const rows = pushes.map((p) => toRow(deviceEui, p));
  // CMD-04 PR0 (owner decision Q02 = (c): no automatic configuration re-send; a lost plan is
  // surfaced, never silently expired). The flush above removed every downlink ChirpStack still
  // held for this device. Rows an earlier compile left QUEUED that this batch does not replace
  // lost their downlink with it (live case: three compiles inside 12 s on a bench Gen2 valve
  // left a DAYMASK_PLAN for days 1+4 QUEUED and undelivered). This code used to re-emit them
  // from their stored bytes, which also replayed stale CLOCK_SYNC wall-clock payloads and
  // re-sent plans the valve may already have applied. They are now marked LOST instead
  // (classifyCarried) and surfaced through push_state; only an explicit operator "Resend plan"
  // sends them again. A lost CLOCK_SYNC is not replayed either: last_clock_sync_queued_at is
  // cleared so the next clock tick computes a fresh one from the time at that tick.
  let lostRows = [];
  if (flushed) {
    try {
      lostRows = classifyCarried(await store.listQueued(db, deviceEui), pushes, { supersedeWeekday, supersedeDaymask });
    } catch (e) {
      warn && warn('[valve-control] could not list outstanding pushes after a flush for ' + deviceEui + ': ' + (e && e.message ? e.message : e));
    }
  }
  const lostPlan = lostRows.some((r) => r.purpose === 'WEEKDAY_PLAN' || r.purpose === 'DAYMASK_PLAN');
  const lostClock = lostRows.some((r) => r.purpose === 'CLOCK_SYNC');
  // ValveRuntime.push_state (queued/acked/failed/lost/weekday_states) only reflects WEEKDAY_PLAN/
  // DAYMASK_PLAN rows plus the newest SCHEDULER_STATUS row's loss flag -- a queuePushes call that
  // only carries a SCHEDULER_STATUS or CLOCK_SYNC push (no plan purpose, no cross-generation
  // supersede, nothing lost) leaves that resource unchanged.
  const affectsPushState = supersedeWeekday || supersedeDaymask || purposes.has('WEEKDAY_PLAN') || purposes.has('DAYMASK_PLAN') || lostRows.length > 0;
  await db.transaction(async (tx) => {
    // Before the supersede below: supersedeQueuedGen2 supersedes on any mask overlap, which
    // would hide the days of a partly-replaced DAYMASK_PLAN row that this batch does not cover.
    if (lostRows.length) await store.markPushesLost(tx, lostRows.map((r) => r.push_id), store.LOST_NOT_RESENT);
    if (lostClock) await store.upsertSettings(tx, deviceEui, { last_clock_sync_queued_at: null });
    for (const p of pushes) await store.supersedeQueued(tx, deviceEui, p.purpose, p.weekday == null ? (p.daymask == null ? null : p.daymask) : p.weekday);
    if (supersedeWeekday) {
      for (let d = 0; d < 7; d += 1) await store.supersedeQueued(tx, deviceEui, 'WEEKDAY_PLAN', d);
    } else if (supersedeDaymask) {
      await store.supersedeQueued(tx, deviceEui, 'DAYMASK_PLAN', 0x7F);
    }
    if (rows.length) await store.insertPushes(tx, rows);
    // P3-E1 review fix (IMPORTANT 4): best-effort -- an emit failure here must not roll back the
    // push-ledger writes this same transaction just made (matches the flows.json seams' shape).
    if (affectsPushState) {
      try { await runtime.emitRuntimeChanged(tx, deviceEui, warn); }
      catch (e) { warn && warn('[valve-control] queuePushes: runtime emit failed: ' + (e && e.message ? e.message : e)); }
    }
  });
  if (lostRows.length && warn) {
    warn('[valve-control] ' + deviceEui + ': ' + lostRows.length + ' queued push(es) dropped by the queue flush and not re-sent (Q02c): '
      + lostRows.map((r) => r.purpose + (r.weekday != null ? ':' + r.weekday : '')).join(', ')
      + (lostPlan ? '; device may not hold this plan' : ''));
  }
  const messages = rows.map((r) => buildDownlinkMessage({ appId, deviceEui, fport: r.fport, payloadHex: r.payload_hex }));
  return { rows, messages, flushed, lost: lostRows.length };
}

// Which outstanding (QUEUED) rows a flush dropped without this batch replacing them. A row is
// replaced when the batch carries the same thing again: the same GEN1 weekday, a set of
// DAYMASK_PLAN pushes whose masks together cover every day of the old row's mask, or the same
// SCHEDULER_STATUS/CLOCK_SYNC purpose; or when it belongs to the other generation's plan, which
// a generation switch abandons anyway (the supersedeWeekday/supersedeDaymask flags). The rest
// are LOST. Pure: no I/O.
function classifyCarried(queuedRows, pushes, flags) {
  const f = flags || {};
  const weekdays = new Set();
  const purposes = new Set();
  let maskUnion = 0;
  for (const p of pushes) {
    purposes.add(p.purpose);
    if (p.purpose === 'WEEKDAY_PLAN') weekdays.add(Number(p.weekday));
    if (p.purpose === 'DAYMASK_PLAN') maskUnion |= (p.daymask === 0x80 ? 0x7F : Number(p.daymask));
  }
  return (queuedRows || []).filter((r) => {
    if (r.purpose === 'WEEKDAY_PLAN') return !(f.supersedeWeekday || weekdays.has(Number(r.weekday)));
    if (r.purpose === 'DAYMASK_PLAN') {
      if (f.supersedeDaymask) return false;
      const mask = store.daymaskOf(r.payload_hex);
      return (mask & maskUnion) !== mask;
    }
    return !purposes.has(r.purpose);
  });
}

async function compileAndQueue({ db, deviceEui, appId, force, now, flushQueue, warn, timeZoneFallback }) {
  const schedules = await store.listSchedules(db, deviceEui);
  const settings = await store.getSettings(db, deviceEui);
  const compiled = P.compileWindows(schedules);
  if (compiled.errors.length) {
    const err = new Error('plan_conflict'); err.statusCode = 422; err.code = 'plan_conflict'; err.details = compiled.errors; throw err;
  }
  const lastHashes = await store.lastPushHashes(db, deviceEui);
  const pushes = buildPlanPushes({ generation: settings.strega_generation, days: compiled.days, lastHashes, force: !!force });
  // MINOR 5 (review round 1): prefer the timezone of the first ENABLED WEEKLY schedule, since
  // that's the timezone the compiled plan (compileWindows only reads WEEKLY rows) actually
  // used. `listSchedules` orders by kind before start_time, and 'ONCE' < 'WEEKLY'
  // lexicographically, so a plain `schedules.find(s => s.timezone)` could silently pick an
  // unrelated ONCE schedule's timezone for the clock-sync payload.
  const tzSchedule = schedules.find((s) => s.kind === 'WEEKLY' && Number(s.enabled) && s.timezone) || schedules.find((s) => s.timezone);
  const tz = (tzSchedule && tzSchedule.timezone) || timeZoneFallback || 'UTC';
  const needsClock = force || !settings.last_clock_sync_queued_at;
  if (needsClock) pushes.push(buildClockPush(settings.strega_generation, now || new Date(), tz));
  const queued = await queuePushes({ db, deviceEui, appId, pushes, generation: settings.strega_generation, flushQueue, warn });
  // MINOR 8 (review round 1): deliberately outside the transaction that queuePushes ran —
  // worst case on a crash between the two is a redundant clock sync queued next time, which
  // is harmless, versus coupling an unrelated settings write into the push-insert transaction.
  if (needsClock) await store.upsertSettings(db, deviceEui, { last_clock_sync_queued_at: (now || new Date()).toISOString() });
  return Object.assign({ compiled }, queued);
}

module.exports = { buildPlanPushes, buildDownlinkMessage, buildStatusPush, buildClockPush, queuePushes, compileAndQueue, classifyCarried };
