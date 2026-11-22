// Preserve the legacy Function bodies directive mode.
// Extracted from the frozen X2 baseline; preserve error and refusal semantics.

function parseStregaTimedRequest(msg, { env, global, node, Date, Buffer, setTimeout, crypto, osiLib, osiDb }) {
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
          node.warn('put-strega-timed-auth-fn auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fsMod.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        node.warn('put-strega-timed-auth-fn auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
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
    msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: 'put-strega-timed-auth-fn' }; throw err;
  }
  const token = authHeader.substring(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'put-strega-timed-auth-fn' }; throw err;
  }
  const payloadB64 = parts[0];
  const sig = parts[1];
  const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'put-strega-timed-auth-fn' }; throw err;
  }
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  } catch (_) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'put-strega-timed-auth-fn' }; throw err;
  }
  const userId = Number(payload.userId);
  const username = String(payload.username || '').trim();
  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(userId) || !username) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'put-strega-timed-auth-fn' }; throw err;
  }
  if (exp && Date.now() > exp) {
    const err = new Error('Token expired');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: 'put-strega-timed-auth-fn' }; throw err;
  }
  return { userId, username };
}
function normalizeAction(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'OPEN' || normalized === 'CLOSE' ? normalized : null;
}
function normalizeUnit(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'second' || normalized === 'seconds') return 'SECONDS';
  if (normalized === 'minute' || normalized === 'minutes') return 'MINUTES';
  if (normalized === 'hour' || normalized === 'hours') return 'HOURS';
  return null;
}
function parseTimedAction(body) {
  const action = normalizeAction(body && body.action);
  const unit = normalizeUnit(body && body.unit);
  const amount = Number(body && body.amount);
  if (!action || !unit || !Number.isInteger(amount) || amount < 1 || amount > 255) return null;
  const opcode = unit === 'SECONDS' ? (action === 'OPEN' ? 0x21 : 0x20) : (unit === 'MINUTES' ? (action === 'OPEN' ? 0x41 : 0x40) : (action === 'OPEN' ? 0x81 : 0x80));
  return {
    action,
    unit,
    amount,
    payloadHex: opcode.toString(16).padStart(2, '0').toUpperCase() + amount.toString(16).padStart(2, '0').toUpperCase(),
    fPort: 2
  };
}
const auth = verifyBearer(msg.req?.headers?.authorization);
const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();
if (!deveui) {
  msg.statusCode = 400;
  msg.payload = { message: 'Missing deveui' };
  return [null, msg];
}
const parsed = parseTimedAction(msg.payload && typeof msg.payload === 'object' ? msg.payload : {});
if (!parsed) {
  msg.statusCode = 400;
  msg.payload = { message: 'Timed action requires OPEN or CLOSE, seconds/minutes/hours, and an amount between 1 and 255' };
  return [null, msg];
}
msg._strega_local_action = 'TIMED_ACTION';
msg._strega_timed_action = parsed.action;
msg._strega_timed_unit = parsed.unit;
msg._strega_timed_amount = parsed.amount;
msg._strega_payload_hex = parsed.payloadHex;
msg._strega_fport = parsed.fPort;
msg._strega_deveui = deveui;
msg._strega_user_id = auth.userId;
msg.topic = "SELECT deveui, type_id, name, strega_model FROM devices WHERE deveui = '" + deveui.replace(/'/g, "''") + "' AND user_id = " + auth.userId + " AND deleted_at IS NULL LIMIT 1";

// Customer review X2: TIMED_ACTION OPEN is a PHYSICAL command (write-strega-expectation's
// isTimedOpen gate: data.action === 'TIMED_ACTION' && valveAction === 'OPEN'). This chain
// previously did bearer auth only -- no scope check, no actor -- so under
// OSI_SCOPED_ACCESS=1 the command reached write-strega-expectation with no actor and was
// rejected scope_actor_required there, while this node's own HTTP response (a separate
// wire) already reported success. Give it the same treatment
// s2120-zones-put-auth-fn/83bb4a452dd9ae37 give the primary manual valve path: resolve the
// bearer-verified user's own user_uuid from the users table (never from the request body --
// auth.userId/auth.username come only from the HMAC-verified bearer token), run a fresh
// device scope + role check, fail closed on the HTTP response, and carry the actor forward
// on msg.actor_user_uuid for the fanout to copy onto the constructed actuator command.
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  let scopeDb;
  try {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('strega timed action: scope module unavailable: ' + scopeLoad.error, msg);
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
    msg.statusCode = status;
    msg.payload = {
      message: status === 404 ? 'device not found' :
        (status === 403 ? 'Forbidden' : String(error && error.message || error))
    };
    return [null, msg];
  } finally {
    if (scopeDb) {
      try {
        await new Promise(function(resolve) { scopeDb.close(function() { resolve(); }); });
      } catch (closeError) {
        node.warn('strega timed action scope close: ' + String(closeError && closeError.message ? closeError.message : closeError));
      }
    }
  }
}
return [msg, null];
})();
}

module.exports = { parseStregaTimedRequest };
