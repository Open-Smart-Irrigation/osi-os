'use strict';
const crypto = require('node:crypto');
const P = require('./plan');
const store = require('./store');

function hexOf(buf) { return Buffer.from(buf).toString('hex').toUpperCase(); }

function buildPlanPushes({ generation, days, lastHashes, force }) {
  const out = [];
  const last = lastHashes || {};
  if (generation === 'GEN2') {
    for (const g of P.gen2Groups(days)) {
      const h = P.planHash(g.windows);
      const key = 'DAYMASK_PLAN:' + g.daymask;
      if (!force && last[key] === h) continue;
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
  const tz = (schedules.find((s) => s.timezone) || {}).timezone || timeZoneFallback || 'UTC';
  const needsClock = force || !settings.last_clock_sync_queued_at;
  if (needsClock) pushes.push(buildClockPush(settings.strega_generation, now || new Date(), tz));
  const queued = await queuePushes({ db, deviceEui, appId, pushes, flushQueue, warn });
  if (needsClock) await store.upsertSettings(db, deviceEui, { last_clock_sync_queued_at: (now || new Date()).toISOString() });
  return Object.assign({ compiled }, queued);
}

module.exports = { buildPlanPushes, buildDownlinkMessage, buildStatusPush, buildClockPush, queuePushes, compileAndQueue };
