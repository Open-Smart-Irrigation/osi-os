// Preserve the legacy Function bodies directive mode.
// Extracted from the frozen X2 baseline; preserve error and refusal semantics.

function authenticateValveCommand(msg, { env, global, node, Date, Buffer, setTimeout, crypto, osiLib, osiDb }) {
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
          node.warn('83bb4a452dd9ae37 auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fsMod.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        node.warn('83bb4a452dd9ae37 auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
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
    msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: '83bb4a452dd9ae37' }; throw err;
  }
  const token = authHeader.substring(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '83bb4a452dd9ae37' }; throw err;
  }
  const payloadB64 = parts[0];
  const sig = parts[1];
  const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '83bb4a452dd9ae37' }; throw err;
  }
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  } catch (_) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '83bb4a452dd9ae37' }; throw err;
  }
  const userId = Number(payload.userId);
  const username = String(payload.username || '').trim();
  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(userId) || !username) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '83bb4a452dd9ae37' }; throw err;
  }
  if (exp && Date.now() > exp) {
    const err = new Error('Token expired');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: '83bb4a452dd9ae37' }; throw err;
  }
  return { userId, username };
}
function respond(statusCode, payload) {
  msg.statusCode = statusCode;
  msg.payload = payload;
  return [null, msg];
}
function rawPresent(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}
const auth = verifyBearer(msg.req?.headers?.authorization);
const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();
if (!deveui) {
  return respond(400, { message: 'Missing valve deveui' });
}
const requestId = String(msg._msgid || '').trim();
if (!requestId) return respond(500, { message: 'Missing request id' });
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  let scopeDb;
  try {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('valve boundary: scope module unavailable: ' + scopeLoad.error, msg);
      const error = new Error('scope resolver unavailable');
      error.statusCode = 500;
      throw error;
    }
    scopeDb = new osiDb.Database('/data/db/farming.db');
    const actor = await scopeDb.get(
      'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
      [auth.userId, auth.username]
    );
    if (!actor || !actor.user_uuid) {
      const error = new Error('Unauthorized');
      error.statusCode = 401;
      throw error;
    }
    const actorScope = await scopeLoad.value.assertFreshDeviceAccess(
      scopeDb,
      actor.user_uuid,
      deveui,
      { scopedMode: true }
    );
    if (!scopeLoad.value.canMutate(actorScope.role)) {
      const error = new Error('insufficient role');
      error.statusCode = 403;
      throw error;
    }
    msg.actor_user_uuid = actor.user_uuid;
  } catch (error) {
    const status = Number(error && (error.statusCode || error.status) || 500) || 500;
    return respond(status, {
      message: status === 404 ? 'device not found' :
        (status === 403 ? 'Forbidden' : String(error && error.message || error))
    });
  } finally {
    if (scopeDb) {
      try {
        await new Promise(function(resolve) { scopeDb.close(function() { resolve(); }); });
      } catch (error) {
        node.warn('valve boundary scope close: ' + String(error && error.message ? error.message : error));
      }
    }
  }
}
const body = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
const qs = msg.req.query || {};
let action = body.action ?? qs.action;
const durationMinutesRaw = body.duration_minutes ?? body.durationMinutes ?? body.duration ?? qs.duration_minutes ?? qs.durationMinutes ?? qs.duration;
const durationSecondsRaw = body.duration_seconds ?? body.durationSeconds ?? qs.duration_seconds ?? qs.durationSeconds;
action = (action === undefined || action === null) ? '' : String(action).trim();
const actionNorm = action.toUpperCase();
let finalAction = actionNorm;
if (finalAction === 'OPENVALVE' || finalAction === 'OPEN_VALVE') finalAction = 'OPEN';
if (finalAction === 'CLOSEVALVE' || finalAction === 'CLOSE_VALVE') finalAction = 'CLOSE';
if (finalAction === 'OPEN_FOR_DURATION' || finalAction === 'OPENFOR' || finalAction === 'OPEN_FOR') finalAction = 'OPEN_FOR_DURATION';
if (finalAction === 'CLOSE_FOR_DURATION' || finalAction === 'CLOSEFOR' || finalAction === 'CLOSE_FOR') finalAction = 'CLOSE_FOR_DURATION';
if (!finalAction) {
  return respond(400, { message: 'Missing action (CLOSE or OPEN_FOR_DURATION)' });
}
if (finalAction === 'OPEN') {
  if (rawPresent(durationSecondsRaw) || rawPresent(durationMinutesRaw)) {
    finalAction = 'OPEN_FOR_DURATION';
  } else {
    return respond(400, { message: 'Indefinite OPEN is not permitted; provide duration_seconds or use OPEN_FOR_DURATION' });
  }
}
if (!['CLOSE','OPEN_FOR_DURATION','CLOSE_FOR_DURATION'].includes(finalAction)) {
  return respond(400, { message: 'Invalid action: ' + finalAction });
}
let durationMinutes = null;
if (finalAction.includes('DURATION')) {
  let seconds = null;
  if (rawPresent(durationSecondsRaw)) {
    seconds = Number(durationSecondsRaw);
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds % 60 !== 0) {
      return respond(400, { message: 'duration_seconds must be a positive whole-minute duration' });
    }
    durationMinutes = seconds / 60;
  } else {
    durationMinutes = Number(durationMinutesRaw);
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      return respond(400, { message: 'duration_minutes must be a positive integer' });
    }
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 255) {
    return respond(400, { message: 'duration_minutes must be between 1 and 255' });
  }
}
// #377: per-request state rides on msg; shared flow context crossed concurrent requests.
msg.osi = { request: { v: 1, kind: 'valve_command', requestId, actorId: auth.userId, targetEui: deveui, action: finalAction, durationMinutes } };
msg.topic = 'SELECT id FROM users WHERE id = ' + auth.userId + ' AND username = ' + "'" + String(auth.username).replace(/'/g, "''") + "'";
return [msg, null];
})();
}

function checkValveOwnership(msg, { env, global, node, Date, Buffer, setTimeout }) {
if (!msg.payload || msg.payload.length === 0) {
  msg.statusCode = 401;
  msg.payload = { message: 'User not found' };
  return [null, msg];
}

const request = (msg.osi || {}).request;
if (!request || request.kind !== 'valve_command') throw new Error('valve request context missing');
const deveui = String(request.targetEui || '').trim().toUpperCase();

msg.topic = `
  SELECT deveui, type_id, user_id, irrigation_zone_id
  FROM devices
  WHERE deveui = '${deveui.replace(/'/g, "''")}';
`.trim();

return [msg, null];

}

function buildValveCommand(msg, { env, global, node, Date, Buffer, setTimeout, crypto }) {
const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.payload = { message: 'Valve not found in devices table' };
  return [null, null, msg];
}

const device = rows[0];
const deveui = String(device.deveui).toUpperCase();
const typeId = String(device.type_id || '');
const deviceUserId = device.user_id;
const zoneId = device.irrigation_zone_id ?? null;
const commandId = crypto.randomUUID();

const request = (msg.osi || {}).request;
if (!request || request.kind !== 'valve_command' || request.targetEui !== deveui) throw new Error('valve request context mismatch');
const userId = Number(request.actorId);
const action = String(request.action);
const durationMinutes = request.durationMinutes;

if (typeId !== 'STREGA_VALVE') {
  msg.statusCode = 409;
  msg.payload = { message: `Device ${deveui} is not a STREGA_VALVE` };
  return [null, null, msg];
}

// Enforce ownership (adjust if you want shared access)
if (deviceUserId !== null && deviceUserId !== undefined && Number(deviceUserId) !== userId) {
  msg.statusCode = 403;
  msg.payload = { message: 'Valve is claimed by another user' };
  return [null, null, msg];
}

const nowIso = new Date().toISOString();

// actuator_command that your Actuator_STREGA flow already understands.
// zone_id + command_id added so Write STREGA Expectation persists them on
// valve_actuation_expectations (operator-trigger path was leaving them NULL —
// see plan F2). zone_id comes from the device's current zone assignment;
// command_id is a UUID generated at request-handling time and surfaced in
// the http response so the dashboard can correlate.
const cmd = {
  type: 'actuator_command',
  device: { devEui: deveui },
  data: {
    action,
    duration_minutes: durationMinutes ?? undefined,
    reason: 'manual_gui',
    timestamp: nowIso,
    zone_id: zoneId,
    command_id: commandId,
    commandId: commandId
  }
};

// The encoder records the log and target state only after the shared transport
// gate accepts the command. Keeping this builder side-effect free prevents a busy
// or uncertain queue from looking like a successful manual open.
const httpOk = {
  status: 'queued',
  deveui,
  action,
  duration_minutes: durationMinutes ?? null,
  timestamp: nowIso,
  command_id: commandId,
  zone_id: zoneId
};
// Write STREGA Expectation reads _stregaExpectationCommand. req/res on top:
// Node-RED clones keep only those. The encoder answers after transport.
const { req, res, ...httpMsg } = msg;
const actuatorMsg = {
  payload: cmd,
  req, res,
  actor_user_uuid: msg.actor_user_uuid || null,
  _actorUserUuid: msg.actor_user_uuid || null,
  _stregaHttpResponse: Object.assign(httpMsg, { statusCode: 202, payload: httpOk, _stregaDeferredSuccess: true }),
  _stregaExpectationCommand: {
    zone_id: zoneId,
    command_id: commandId,
    device_eui: deveui,
    action,
    duration_minutes: durationMinutes
  }
};
return [ actuatorMsg, null, null ];

}

module.exports = { authenticateValveCommand, checkValveOwnership, buildValveCommand };
