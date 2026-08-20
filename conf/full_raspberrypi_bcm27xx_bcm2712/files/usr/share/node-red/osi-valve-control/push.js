'use strict';
const crypto = require('node:crypto');
const P = require('./plan');
const store = require('./store');

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
async function queuePushes({ db, deviceEui, appId, pushes, flushQueue, warn }) {
  if (!pushes.length) return { rows: [], messages: [], flushed: false };
  let flushed = false;
  const pending = await store.hasPendingObservation(db, deviceEui);
  if (!pending && typeof flushQueue === 'function') {
    try { await flushQueue(deviceEui); flushed = true; } catch (e) { warn && warn('[valve-control] queue flush failed ' + deviceEui + ': ' + (e && e.message ? e.message : e)); }
  }
  const rows = pushes.map((p) => toRow(deviceEui, p));
  await db.transaction(async (tx) => {
    for (const p of pushes) await store.supersedeQueued(tx, deviceEui, p.purpose, p.weekday == null ? (p.daymask == null ? null : p.daymask) : p.weekday);
    await store.insertPushes(tx, rows);
  });
  const messages = rows.map((r) => buildDownlinkMessage({ appId, deviceEui, fport: r.fport, payloadHex: r.payload_hex }));
  return { rows, messages, flushed };
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
  const queued = await queuePushes({ db, deviceEui, appId, pushes, flushQueue, warn });
  // MINOR 8 (review round 1): deliberately outside the transaction that queuePushes ran —
  // worst case on a crash between the two is a redundant clock sync queued next time, which
  // is harmless, versus coupling an unrelated settings write into the push-insert transaction.
  if (needsClock) await store.upsertSettings(db, deviceEui, { last_clock_sync_queued_at: (now || new Date()).toISOString() });
  return Object.assign({ compiled }, queued);
}

module.exports = { buildPlanPushes, buildDownlinkMessage, buildStatusPush, buildClockPush, queuePushes, compileAndQueue };
