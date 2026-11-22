'use strict';
// Canonical preflight source. Adapters embed these exported functions verbatim
// so legacy early replies precede the scheduler load during an outage.
function prepareDecodeToken(msg, { env, node, osiLib, crypto, global, Date = globalThis.Date } = {}) {
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
const auth = verifyBearer(msg.req?.headers?.authorization);
msg.authUserId = auth.userId;
msg.authUsername = auth.username;
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
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
    return { auth, scoped: true, scopeLoad, zoneId };
  } catch (error) {
    msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.payload = { message: String(error && error.message || error) };
    return [null, msg];
  }
}
return { auth, scoped: false };
}

function prepareZoneOwnership(msg) {
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

  return { userId, zoneId };
} catch (err) {
  msg.statusCode = 500;
  msg.payload = { message: 'Schedule validation failed', error: String(err?.message || err) };
  return [null, msg];
}

}

function prepareUpsert(msg) {
if (!Array.isArray(msg.payload) || msg.payload.length === 0) {
  msg.statusCode = 404;
  msg.payload = { message: 'Zone not found or access denied' };
  return [null, msg];
}

const zone = msg.payload[0];
const request = (msg.osi || {}).request;
if (!request || request.kind !== 'zone_schedule_put' || Number(zone.id) !== request.zoneId) throw new Error('schedule request context mismatch');
return { zone, request };
}

module.exports = { prepareDecodeToken, prepareZoneOwnership, prepareUpsert };
