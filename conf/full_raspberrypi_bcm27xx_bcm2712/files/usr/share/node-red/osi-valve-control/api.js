'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const P = require('./plan');
const store = require('./store');
const push = require('./push');

// --- copied verbatim from osi-journal/api.js (apiError, unauthorized, verifyBearer, resolveAuthSecret, requestBody, closeFacade) ---

const MAX_BODY_BYTES = 256 * 1024;

function apiError(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function unauthorized() {
  return apiError(401, 'unauthorized', 'Unauthorized');
}

function verifyBearer(authorization, secret, nowMs) {
  try {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw unauthorized();
    if (typeof secret !== 'string' || !secret) throw unauthorized();
    const token = authorization.slice(7).trim();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw unauthorized();
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
    const actualBytes = Buffer.from(parts[1], 'utf8');
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (actualBytes.length !== expectedBytes.length ||
        !crypto.timingSafeEqual(actualBytes, expectedBytes)) throw unauthorized();
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const userId = Number(payload.userId);
    const username = String(payload.username || '').trim();
    const exp = Number(payload.exp || 0);
    const clock = nowMs == null ? Date.now() : Number(nowMs);
    if (!Number.isInteger(userId) || userId <= 0 || !username || username.length > 120 ||
        !Number.isFinite(exp) || exp <= 0 || clock > exp) throw unauthorized();
    return { userId, username, exp };
  } catch (error) {
    if (error && error.code === 'unauthorized') throw error;
    throw unauthorized();
  }
}

function resolveAuthSecret(environment, warn) {
  const configured = String(environment.authTokenSecret || environment.jwtSecret || '').trim();
  if (configured) return configured;
  for (const secretPath of [
    '/data/db/osi_auth_token_secret',
    '/var/lib/node-red/.node-red/osi_auth_token_secret',
  ]) {
    try {
      const readFile = typeof environment.readFile === 'function' ? environment.readFile : fs.readFileSync;
      const value = String(readFile(secretPath, 'utf8') || '').trim();
      if (value) return value;
      warn('[valve-api] auth secret file was empty path=' + secretPath);
    } catch (error) {
      warn('[valve-api] auth secret read failed path=' + secretPath +
        ' code=' + String(error && error.code || 'unknown'));
    }
  }
  throw apiError(503, 'auth_unavailable', 'Valve authentication is unavailable');
}

function requestBody(msg) {
  const contentLength = Number(msg.req && msg.req.headers && msg.req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw apiError(413, 'body_too_large', 'Request body exceeds 256 KiB');
  }
  return msg.req && msg.req.body !== undefined ? msg.req.body : (msg.payload || {});
}

async function closeFacade(db, warn) {
  if (!db) return;
  try {
    await new Promise(function (resolve, reject) {
      db.close(function (error) {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    warn('[valve-api] database close failed code=' + String(error && error.code || 'unknown'));
  }
}

// --- end verbatim copy ---

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };
const EUI_RE = /^[0-9A-F]{16}$/;

// Enrich compileWindows()-style error entries with a `labels` array parallel to `conflicts`,
// so the GUI can name the schedules involved in a plan_conflict instead of just showing UUIDs.
function labelizeDetails(details, scheduleList) {
  const byUuid = new Map((scheduleList || []).map((s) => [s.schedule_uuid, s.label != null ? s.label : null]));
  return (details || []).map((d) => Object.assign({}, d, {
    labels: (d.conflicts || []).map((uuid) => (byUuid.has(uuid) ? byUuid.get(uuid) : null)),
  }));
}

function shapeValve(row, schedules, now, tzFallback, pushes) {
  const flowRate = row.flow_rate_lpm != null ? Number(row.flow_rate_lpm) : (row.zone_flow_rate_lpm != null ? Number(row.zone_flow_rate_lpm) : null);
  return {
    device_eui: row.deveui, name: row.name, zone_id: row.irrigation_zone_id, zone_name: row.zone_name || null, zone_uuid: row.zone_uuid || null,
    timezone: row.zone_timezone || tzFallback, current_state: row.current_state || null, target_state: row.target_state || null,
    strega_generation: row.strega_generation || 'GEN1',
    flow_rate_lpm: flowRate, flow_rate_source: row.flow_rate_lpm != null ? (row.flow_rate_source || 'estimated') : (row.zone_flow_rate_lpm != null ? 'zone' : null),
    default_open_minutes: row.default_open_minutes != null ? Number(row.default_open_minutes) : null,
    scheduler_status: row.scheduler_status || 'ACTIVE', skip_today_date: row.skip_today_date || null,
    last_uplink_at: row.last_uplink_at || null,
    active_actuation: row.active_expectation_id ? { expectation_id: row.active_expectation_id, reconciliation_state: row.active_reconciliation_state, commanded_at: row.active_commanded_at, expected_close_at: row.active_expected_close_at, duration_seconds: row.active_duration_seconds, trigger: row.active_trigger || null } : null,
    recent_stale_state: row.recent_stale_state || null,
    next_run: P.nextRun(schedules, now, row.zone_timezone || tzFallback),
    schedule_count: schedules.length,
    push_state: { queued: Number(pushes.queued || 0), acked: Number(pushes.acked || 0), failed: Number(pushes.failed || 0), last_plan_queued_at: pushes.last_plan_queued_at || null, last_plan_acked_at: pushes.last_plan_acked_at || null },
    last_clock_sync_acked_at: row.last_clock_sync_acked_at || null,
  };
}

async function ownedValve(db, eui, userId) {
  if (!EUI_RE.test(eui)) throw apiError(400, 'invalid_eui', 'device EUI must be 16 hex chars');
  const row = await db.get("SELECT deveui, user_id, type_id, irrigation_zone_id, (SELECT timezone FROM irrigation_zones WHERE id = devices.irrigation_zone_id) AS zone_timezone FROM devices WHERE UPPER(deveui)=? AND deleted_at IS NULL", [eui]);
  if (!row) throw apiError(404, 'not_found', 'Valve not found');
  if (row.type_id !== 'STREGA_VALVE') throw apiError(409, 'not_a_valve', 'Device is not a STREGA valve');
  if (row.user_id != null && Number(row.user_id) !== Number(userId)) throw apiError(403, 'forbidden', 'Valve is claimed by another user');
  return row;
}

async function handleHttpRequest(options) {
  const { msg, Database } = options;
  const environment = options.environment || {};
  const warn = typeof options.warn === 'function' ? options.warn : function () {};
  const now = options.now || new Date();
  const tzFallback = environment.gatewayTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const respond = (statusCode, payload) => { msg.statusCode = statusCode; msg.payload = payload; msg.headers = HEADERS; return msg; };
  const method = String(msg.req && msg.req.method || '').toUpperCase();
  const requestPath = String((msg.req && (msg.req.path || msg.req.originalUrl || msg.req.url)) || '').split('?')[0]; // journal-api precedent: req.path first
  let db = null;
  let currentEui = null; // set once a route resolves its target valve, so the catch block can enrich a thrown plan_conflict with labels.
  try {
    const secret = resolveAuthSecret(environment, warn);
    const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization, secret);
    db = new Database(environment.dbPath || '/data/db/farming.db');
    const m = (re) => re.exec(requestPath);
    let match;

    if (method === 'GET' && requestPath === '/api/valves') {
      const rows = await store.listValvesForUser(db, auth.userId);
      const valves = [];
      for (const row of rows) {
        const schedules = await store.listSchedules(db, row.deveui);
        const pushes = await store.pushSummary(db, row.deveui);
        valves.push(shapeValve(row, schedules, now, tzFallback, pushes));
      }
      return respond(200, { generatedAt: now.toISOString(), valves });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/schedules$/)) && (method === 'GET' || method === 'POST')) {
      const eui = match[1].toUpperCase();
      currentEui = eui;
      const device = await ownedValve(db, eui, auth.userId);
      if (method === 'GET') {
        const schedules = await store.listSchedules(db, eui);
        const compiled = P.compileWindows(schedules);
        return respond(200, { schedules, compiled: { days: compiled.days, errors: compiled.errors }, push_state: await store.weekdayPushStates(db, eui), settings: await store.getSettings(db, eui) });
      }
      const v = P.validateScheduleInput(requestBody(msg));
      if (!v.ok) return respond(v.status, { error: v.error, message: v.details });
      const row = Object.assign({ schedule_uuid: crypto.randomUUID(), device_eui: eui, timezone: device.zone_timezone || tzFallback }, v.value);
      // Validate the compiled plan BEFORE persisting so a rejected schedule never reaches the DB.
      if (row.kind === 'WEEKLY') {
        const existing = await store.listSchedules(db, eui);
        const trialSchedules = existing.concat([Object.assign({ enabled: 1 }, row)]);
        const trial = P.compileWindows(trialSchedules);
        if (trial.errors.length) return respond(422, { error: 'plan_conflict', details: labelizeDetails(trial.errors, trialSchedules) });
      }
      await store.insertSchedule(db, row);
      const q = row.kind === 'WEEKLY' ? await push.compileAndQueue({ db, deviceEui: eui, appId: options.appId, force: false, now, flushQueue: options.flushQueue, warn, timeZoneFallback: tzFallback }) : { rows: [], messages: [] };
      msg.valvePushMessages = q.messages;
      return respond(201, { schedule: row, pushes_queued: q.rows.length });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/schedules\/([0-9a-fA-F-]{36})$/)) && (method === 'PUT' || method === 'DELETE')) {
      const eui = match[1].toUpperCase(); const uuid = match[2];
      currentEui = eui;
      await ownedValve(db, eui, auth.userId);
      const existing = await store.listSchedules(db, eui);
      const current = existing.find((s) => s.schedule_uuid === uuid);
      if (!current) return respond(404, { error: 'not_found', message: 'Schedule not found' });
      if (method === 'DELETE') {
        await store.softDeleteSchedule(db, uuid);
      } else {
        const body = requestBody(msg);
        const v = P.validateScheduleInput(Object.assign({}, current, body, { kind: current.kind }));
        if (!v.ok) return respond(v.status, { error: v.error, message: v.details });
        const trialSchedules = existing.map((s) => (s.schedule_uuid === uuid ? Object.assign({}, s, v.value) : s));
        const trial = P.compileWindows(trialSchedules);
        if (trial.errors.length) return respond(422, { error: 'plan_conflict', details: labelizeDetails(trial.errors, trialSchedules) });
        await store.updateSchedule(db, uuid, v.value);
      }
      const q = await push.compileAndQueue({ db, deviceEui: eui, appId: options.appId, force: false, now, flushQueue: options.flushQueue, warn, timeZoneFallback: tzFallback });
      msg.valvePushMessages = q.messages;
      return respond(200, { ok: true, pushes_queued: q.rows.length });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/plan\/resend$/)) && method === 'POST') {
      const eui = match[1].toUpperCase();
      currentEui = eui;
      await ownedValve(db, eui, auth.userId);
      const q = await push.compileAndQueue({ db, deviceEui: eui, appId: options.appId, force: true, now, flushQueue: options.flushQueue, warn, timeZoneFallback: tzFallback });
      msg.valvePushMessages = q.messages;
      return respond(202, { ok: true, pushes_queued: q.rows.length });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/scheduler-status$/)) && method === 'POST') {
      const eui = match[1].toUpperCase();
      currentEui = eui;
      const device = await ownedValve(db, eui, auth.userId);
      const status = String((requestBody(msg) || {}).status || '').toUpperCase();
      const code = { ACTIVE: '0', SKIP_TODAY: '1', DEACTIVATED: '2' }[status];
      if (!code) return respond(422, { error: 'invalid_status', message: 'status must be ACTIVE, SKIP_TODAY or DEACTIVATED' });
      const q = await push.queuePushes({ db, deviceEui: eui, appId: options.appId, pushes: [push.buildStatusPush(code)], flushQueue: options.flushQueue, warn });
      const tz = device.zone_timezone || tzFallback;
      const lp = P.localParts(now, tz);
      await store.upsertSettings(db, eui, { scheduler_status: status, skip_today_date: status === 'SKIP_TODAY' ? `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}` : null });
      msg.valvePushMessages = q.messages;
      return respond(202, { ok: true, status });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/settings$/)) && method === 'PUT') {
      const eui = match[1].toUpperCase();
      currentEui = eui;
      await ownedValve(db, eui, auth.userId);
      const b = requestBody(msg) || {};
      const patch = {};
      if (b.strega_generation !== undefined) { if (!['GEN1', 'GEN2'].includes(b.strega_generation)) return respond(422, { error: 'invalid_generation' }); patch.strega_generation = b.strega_generation; }
      if (b.flow_rate_lpm !== undefined) {
        if (b.flow_rate_lpm === null) { patch.flow_rate_lpm = null; patch.flow_rate_source = null; patch.flow_rate_updated_at = null; }
        else { const n = Number(b.flow_rate_lpm); if (!Number.isFinite(n) || n <= 0 || n > 10000) return respond(422, { error: 'invalid_flow_rate' }); patch.flow_rate_lpm = n; patch.flow_rate_source = b.flow_rate_source === 'measured' ? 'measured' : 'estimated'; patch.flow_rate_updated_at = now.toISOString(); }
      }
      if (b.default_open_minutes !== undefined) { const n = Number(b.default_open_minutes); if (!Number.isInteger(n) || n < 1 || n > 255) return respond(422, { error: 'invalid_default_open_minutes' }); patch.default_open_minutes = n; }
      await store.upsertSettings(db, eui, patch);
      return respond(200, { ok: true, settings: await store.getSettings(db, eui) });
    }

    return respond(404, { error: 'not_found', message: 'Unknown valve-control route' });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    if (status === 500) warn('[valve-api] ' + method + ' ' + requestPath + ' failed: ' + (error && error.stack || error));
    let details = status === 500 ? undefined : (error.details || undefined);
    if (status === 422 && error.code === 'plan_conflict' && Array.isArray(details) && currentEui) {
      // push.compileAndQueue() throws plan_conflict without labels (it only sees compiled windows,
      // not the schedule rows); re-fetch the schedule list here so the GUI still gets names.
      try { details = labelizeDetails(details, await store.listSchedules(db, currentEui)); } catch (_) { /* best-effort */ }
    }
    return respond(status, { error: status === 500 ? 'internal_error' : (error.code || 'error'), message: status === 500 ? 'Valve request failed' : String(error.message || ''), details });
  } finally {
    await closeFacade(db, warn);
  }
}

module.exports = { handleHttpRequest };
