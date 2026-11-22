// Preserve the legacy Function bodies directive mode.
// Extracted from the frozen X2 baseline; preserve error and refusal semantics.

function parseStregaModelRequest(msg, { env, global, node, Date, Buffer, setTimeout, crypto, osiLib }) {
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
          node.warn('put-strega-model-auth-fn auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fsMod.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        node.warn('put-strega-model-auth-fn auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
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
    msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: 'put-strega-model-auth-fn' }; throw err;
  }
  const token = authHeader.substring(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'put-strega-model-auth-fn' }; throw err;
  }
  const payloadB64 = parts[0];
  const sig = parts[1];
  const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'put-strega-model-auth-fn' }; throw err;
  }
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  } catch (_) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'put-strega-model-auth-fn' }; throw err;
  }
  const userId = Number(payload.userId);
  const username = String(payload.username || '').trim();
  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(userId) || !username) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'put-strega-model-auth-fn' }; throw err;
  }
  if (exp && Date.now() > exp) {
    const err = new Error('Token expired');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: 'put-strega-model-auth-fn' }; throw err;
  }
  return { userId, username };
}
function parseModel(body) {
  const model = String(body && body.model || '').trim().toUpperCase();
  if (!(model === 'STANDARD' || model === 'MOTORIZED')) return null;
  return { model };
}
const auth = verifyBearer(msg.req?.headers?.authorization);
const deveui = String(msg.req.params.deveui || '').trim().toUpperCase();
if (!deveui) {
  msg.statusCode = 400;
  msg.payload = { message: 'Missing deveui' };
  return [null, msg];
}
const parsed = parseModel(msg.payload && typeof msg.payload === 'object' ? msg.payload : {});
if (!parsed) {
  msg.statusCode = 400;
  msg.payload = { message: 'Model must be STANDARD or MOTORIZED' };
  return [null, msg];
}
msg._strega_local_action = 'MODEL';
msg._strega_model = parsed.model;
msg._strega_deveui = deveui;
msg._strega_user_id = auth.userId;
msg.topic = "SELECT deveui, type_id, name, strega_model FROM devices WHERE deveui = '" + deveui.replace(/'/g, "''") + "' AND user_id = " + auth.userId + " AND deleted_at IS NULL LIMIT 1";
return [msg, null];
}

module.exports = { parseStregaModelRequest };
