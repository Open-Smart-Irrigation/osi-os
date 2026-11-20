'use strict';
// Schedule persistence is separate from runtime decision evaluation.
function decodeToken(msg, { env, node, osiLib, crypto, osiDb, global, Date = globalThis.Date, verifiedAuth = null } = {}) {
return (async () => {
function getAuthSecret() {
  // Recomputed locally (not closing over an outer scopedOn) -- keeps this
  // fix mechanically uniform across every flag-gated auth node and avoids
  // any TDZ risk in nodes that declare their own scopedOn later, for a
  // separate scope check (see zone-env-fn precedent, PR #200 follow-up).
  const scopedForSecret = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  if (scopedForSecret) {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      const error = new Error('Authentication scope helper unavailable');
      error.statusCode = 500;
      throw error;
    }
    return scopeLoad.value.resolveAuthSecret({
      configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),
      fs: global.get('fs'),
      warn: (message) => node.warn(message),
    });
  }
  // Flag-off: pure passthrough, zero new dependencies -- this path must never
  // touch osiLib/the scope helper (design contract: byte-equivalent to the
  // pre-port route). Inlines the same secret-resolution logic
  // resolveAuthSecret() implements, for the flag-off case only.
  const configured = String(env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET') || '').trim();
  if (configured) return configured;
  const fsMod = global.get('fs');
  const secretPaths = ['/data/db/osi_auth_token_secret', '/var/lib/node-red/.node-red/osi_auth_token_secret'];
  if (fsMod) {
    for (const secretPath of secretPaths) {
      try {
        const existing = String(fsMod.readFileSync(secretPath, 'utf8') || '').trim();
        if (existing) return existing;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          node.warn('70fcbea336401bd1 auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fsMod.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        node.warn('70fcbea336401bd1 auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
      }
    }
  }
  const err = new Error('AUTH_TOKEN_SECRET or JWT_SECRET must be configured');
  err.statusCode = 500;
  throw err;
}function toBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(input) {
  let value = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  while (value.length % 4) value += '=';
  return Buffer.from(value, 'base64');
}
function verifyBearer(authHeader) { delete msg._osiAuthFailure;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: '70fcbea336401bd1' }; throw err;
  }
  const token = authHeader.substring(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '70fcbea336401bd1' }; throw err;
  }
  const payloadB64 = parts[0];
  const sig = parts[1];
  const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '70fcbea336401bd1' }; throw err;
  }
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  } catch (_) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '70fcbea336401bd1' }; throw err;
  }
  const userId = Number(payload.userId);
  const username = String(payload.username || '').trim();
  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(userId) || !username) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '70fcbea336401bd1' }; throw err;
  }
  if (exp && Date.now() > exp) {
    const err = new Error('Token expired');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: '70fcbea336401bd1' }; throw err;
  }
  return { userId, username };
}
msg.req_body = msg.payload;
const auth = verifiedAuth || verifyBearer(msg.req?.headers?.authorization);
msg.authUserId = auth.userId;
msg.authUsername = auth.username;
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  let scopeDb;
  try {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('schedule mutation: scope module unavailable: ' + scopeLoad.error, msg);
      const error = new Error('scope resolver unavailable');
      error.statusCode = 500;
      throw error;
    }
    const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);
    if (!Number.isInteger(zoneId)) {
      const error = new Error('Invalid zone ID');
      error.statusCode = 400;
      throw error;
    }
    scopeDb = new osiDb.Database('/data/db/farming.db');
    const actor = await scopeDb.get(
      'SELECT user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
      [auth.userId, auth.username]
    );
    if (!actor || !actor.user_uuid) {
      const error = new Error('Unauthorized');
      error.statusCode = 401;
      throw error;
    }
    const zoneUuid = await scopeLoad.value.resolveZoneUuidById(scopeDb, zoneId);
    if (!zoneUuid) {
      const error = new Error('zone not found');
      error.statusCode = 404;
      throw error;
    }
    const actorScope = await scopeLoad.value.assertFreshZoneAccess(
      scopeDb,
      actor.user_uuid,
      zoneUuid,
      { scopedMode: true }
    );
    if (!scopeLoad.value.canMutate(actorScope.role)) {
      const error = new Error('insufficient role');
      error.statusCode = 403;
      throw error;
    }
    msg.actor_user_uuid = actor.user_uuid;
  } catch (error) {
    msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.payload = {
      message: msg.statusCode === 404 ? 'zone not found' :
        (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
    };
    return [null, msg];
  } finally {
    if (scopeDb) {
      try {
        await new Promise(function(resolve) { scopeDb.close(function() { resolve(); }); });
      } catch (error) {
        node.warn('schedule mutation scope close: ' + String(error && error.message ? error.message : error));
      }
    }
  }
}
msg.topic = `SELECT id FROM users WHERE id = ${auth.userId} AND username = '${auth.username.replace(/'/g, "''")}'`;
return [msg, null];
})();
}

function verifyZoneOwnership(msg, { env, node, osiLib, crypto, osiDb, global, Date = globalThis.Date } = {}) {

try {
  if (!Array.isArray(msg.payload) || msg.payload.length === 0 || msg.payload[0]?.id === undefined) {
    msg.statusCode = 401;
    msg.payload = { message: 'User not found' };
    return [null, msg];
  }

  const userId = Number(msg.payload[0].id);
  const zoneId = parseInt(msg.req?.params?.id, 10);
  if (!Number.isFinite(userId)) {
    msg.statusCode = 401;
    msg.payload = { message: 'Invalid user ID' };
    return [null, msg];
  }
  if (!Number.isFinite(zoneId)) {
    msg.statusCode = 400;
    msg.payload = { message: 'Invalid zone ID' };
    return [null, msg];
  }

  let body = msg.req_body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const trigger_metric = body.trigger_metric ?? body.triggerMetric ?? body.metric ?? body.metric_id;
  const threshold_kpa = body.threshold_kpa ?? body.thresholdKpa ?? body.threshold ?? body.kpa;
  const duration_raw = body.duration_minutes ?? body.durationMinutes ?? body.duration ?? body.minutes;
  const enabledRaw = body.enabled ?? body.is_enabled ?? body.isEnabled;
  const responseModeRaw = body.response_mode ?? body.responseMode ?? 'proportional';

  const allowed = ['SWT_WM1', 'SWT_WM2', 'SWT_AVG', 'SWT_1', 'SWT_2', 'SWT_3', 'DENDRO'];
  const trig = String(trigger_metric || '').toUpperCase();
  if (!allowed.includes(trig)) {
    msg.statusCode = 400;
    msg.payload = { message: 'Invalid trigger_metric. Allowed: ' + allowed.join(', ') };
    return [null, msg];
  }

  const th = Number(threshold_kpa);
  if (trig === 'DENDRO') {
    const thInt = Number.parseInt(String(threshold_kpa), 10);
    if (!Number.isInteger(th) || String(th) !== String(thInt) || ![1,2,3,4].includes(thInt)) {
      msg.statusCode = 400;
      msg.payload = { message: 'Invalid DENDRO threshold_kpa (allowed encoded levels: 1=mild, 2=moderate, 3=significant, 4=severe)' };
      return [null, msg];
    }
  } else if (!Number.isFinite(th) || th <= 0 || th > 300) {
    msg.statusCode = 400;
    msg.payload = { message: 'Invalid threshold_kpa (0 < x ≤ 300)' };
    return [null, msg];
  }

  let durationMin = duration_raw === undefined || duration_raw === null ? 20 : Number(duration_raw);
  if (!Number.isFinite(durationMin) || durationMin <= 0 || durationMin > 240) {
    msg.statusCode = 400;
    msg.payload = { message: 'Invalid duration_minutes (0 < x ≤ 240)' };
    return [null, msg];
  }
  durationMin = Math.round(durationMin);

  const responseMode = String(responseModeRaw || 'proportional').trim().toLowerCase();
  const allowedResponseModes = ['proportional', 'fixed', 'aggressive'];
  if (!allowedResponseModes.includes(responseMode)) {
    msg.statusCode = 400;
    msg.payload = { message: 'Invalid response_mode. Allowed: ' + allowedResponseModes.join(', ') };
    return [null, msg];
  }

  function normalizeEnabled(value) {
    if (value === undefined || value === null) return 1;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const raw = String(value).trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(raw)) return 0;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return 1;
    return value ? 1 : 0;
  }
  const enabledInt = normalizeEnabled(enabledRaw);

  const requestId = String(msg._msgid || '').trim();
  if (!requestId) {
    msg.statusCode = 500;
    msg.payload = { message: 'Missing request id' };
    return [null, msg];
  }
  // #377: per-request state rides on msg; shared flow context crossed concurrent requests.
  msg.osi = { request: { v: 1, kind: 'zone_schedule_put', requestId, actorId: userId, zoneId, validatedPatch: { trigger_metric: trig, threshold_kpa: th, duration_minutes: durationMin, enabled: enabledInt, response_mode: responseMode } } };

  msg.topic = `SELECT iz.id, iz.zone_uuid, iz.gateway_device_eui,
                       s.sync_version AS schedule_sync_version,
                       s.last_applied_at,
                       s.deleted_at AS schedule_deleted_at
                FROM irrigation_zones iz
                LEFT JOIN irrigation_schedules s ON s.irrigation_zone_id = iz.id
                WHERE iz.id = ${zoneId}
                  ${String(env.get('OSI_SCOPED_ACCESS') || '') === '1'
                    ? ''
                    : 'AND iz.user_id = ' + userId}
                  AND iz.deleted_at IS NULL
                LIMIT 1`;
  return [msg, null];
} catch (err) {
  msg.statusCode = 500;
  msg.payload = { message: 'Schedule validation failed', error: String(err?.message || err) };
  return [null, msg];
}

}

function buildUpsert(msg, { env, node, osiLib, crypto, osiDb, global, Date = globalThis.Date } = {}) {

if (!Array.isArray(msg.payload) || msg.payload.length === 0) {
  msg.statusCode = 404;
  msg.payload = { message: 'Zone not found or access denied' };
  return [null, msg];
}

const zone = msg.payload[0];
const request = (msg.osi || {}).request;
if (!request || request.kind !== 'zone_schedule_put' || Number(zone.id) !== request.zoneId) throw new Error('schedule request context mismatch');
const patch = request.validatedPatch;
const zoneId = Number(request.zoneId);
const trigger_metric = String(patch.trigger_metric || '');
const threshold_kpa = Number(patch.threshold_kpa);
const duration_minutes = Number(patch.duration_minutes);
const enabledInt = Number(patch.enabled);
const responseMode = String(patch.response_mode || 'proportional');
const now = new Date().toISOString();
const nextScheduleSyncVersion = Number(zone.schedule_sync_version || 0) + 1;

msg.osi.applied = {
  zone_uuid: zone.zone_uuid || null,
  gateway_device_eui: zone.gateway_device_eui || String(env.get('DEVICE_EUI') || 'UNKNOWN').toUpperCase(),
  sync_version: nextScheduleSyncVersion,
  last_applied_at: zone.last_applied_at || null
};

msg.topic = `INSERT INTO irrigation_schedules
  (irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version, deleted_at, created_at, updated_at)
VALUES
  (${zoneId}, '${trigger_metric}', ${threshold_kpa}, ${duration_minutes}, ${enabledInt}, '${responseMode}', ${nextScheduleSyncVersion}, NULL, '${now}', '${now}')
ON CONFLICT(irrigation_zone_id) DO UPDATE SET
  trigger_metric = excluded.trigger_metric,
  threshold_kpa = excluded.threshold_kpa,
  duration_minutes = excluded.duration_minutes,
  enabled = excluded.enabled,
  response_mode = excluded.response_mode,
  deleted_at = NULL,
  sync_version = ${nextScheduleSyncVersion},
  updated_at = excluded.updated_at`;

msg.syncAck = Object.assign({}, msg.syncAck || {}, {
  aggregateType: 'SCHEDULE',
  aggregateKey: zone.zone_uuid || null,
  appliedSyncVersion: nextScheduleSyncVersion,
  result: 'SUCCESS'
});
return [msg, null];

}

module.exports = { decodeToken, verifyZoneOwnership, buildUpsert };
