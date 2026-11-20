// Preserve the legacy Function bodies directive mode.
// Extracted from the frozen X2 baseline; preserve error and refusal semantics.

function cancelValveRequest(msg, { env, global, node, Date, Buffer, setTimeout, osiDb, crypto, chirpstack, osiLib }) {
// Cancel STREGA Actuation
// Operator cancel: a whole-queue flush; the actuation is marked cancelled only when proven (cancel.js).
// body.expectation_id names the actuation; without it, only a single active actuation is cancelled.
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
          node.warn('cancel-strega-actuation-fn auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fsMod.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        node.warn('cancel-strega-actuation-fn auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
      }
    }
  }
  const err = new Error('AUTH_TOKEN_SECRET or JWT_SECRET must be configured');
  err.statusCode = 500;
  throw err;
}    function toBase64Url(input) {
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
            msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: 'cancel-strega-actuation-fn' }; throw err;
        }
        const token = authHeader.substring(7).trim();
        const parts = token.split('.');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            const err = new Error('Invalid token');
            err.statusCode = 401;
            msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'cancel-strega-actuation-fn' }; throw err;
        }
        const payloadB64 = parts[0];
        const sig = parts[1];
        const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());
        const sigBuf = Buffer.from(sig, 'utf8');
        const expectedBuf = Buffer.from(expectedSig, 'utf8');
        if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
            const err = new Error('Invalid token');
            err.statusCode = 401;
            msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'cancel-strega-actuation-fn' }; throw err;
        }
        let payload;
        try {
            payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
        } catch (_) {
            const err = new Error('Invalid token');
            err.statusCode = 401;
            msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'cancel-strega-actuation-fn' }; throw err;
        }
        const userId = Number(payload.userId);
        const username = String(payload.username || '').trim();
        const exp = Number(payload.exp || 0);
        if (!Number.isFinite(userId) || !username) {
            const err = new Error('Invalid token');
            err.statusCode = 401;
            msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'cancel-strega-actuation-fn' }; throw err;
        }
        if (exp && Date.now() > exp) {
            const err = new Error('Token expired');
            err.statusCode = 401;
            msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: 'cancel-strega-actuation-fn' }; throw err;
        }
        return { userId, username };
    }
    function respond(statusCode, payload) {
        msg.statusCode = statusCode;
        msg.payload = payload;
        return msg;
    }

    const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);
    const deveui = String((msg.req && msg.req.params && msg.req.params.deveui) || '').trim().toUpperCase();
    if (!deveui) return respond(400, { message: 'Missing valve deveui' });

    const body = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
    const reason = String(body.reason || 'operator_cancel').trim() || 'operator_cancel';
    const now = new Date().toISOString();
    const db = new osiDb.Database('/data/db/farming.db');
    const close = () => new Promise((res) => db.close(() => res()));
    try {
        if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
            const scopeLoad = osiLib.require('scope');
            if (!scopeLoad.ok) {
                node.error('valve cancel: scope module unavailable: ' + scopeLoad.error, msg);
                const error = new Error('scope resolver unavailable');
                error.statusCode = 500;
                throw error;
            }
            const actor = await db.get(
                'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
                [auth.userId, auth.username]
            );
            if (!actor || !actor.user_uuid) {
                const error = new Error('Unauthorized');
                error.statusCode = 401;
                throw error;
            }
            const actorScope = await scopeLoad.value.assertFreshDeviceAccess(
                db,
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
        }

        const device = await db.get(
            'SELECT deveui, type_id, user_id FROM devices WHERE UPPER(deveui) = UPPER(?) AND deleted_at IS NULL LIMIT 1',
            [deveui]
        );
        if (!device) return respond(404, { message: 'Valve not found in devices table' });
        if (String(device.type_id || '') !== 'STREGA_VALVE') {
            return respond(409, { message: 'Device ' + deveui + ' is not a STREGA_VALVE' });
        }
        if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1' &&
            device.user_id !== null && device.user_id !== undefined &&
            Number(device.user_id) !== auth.userId) {
            return respond(403, { message: 'Valve is claimed by another user' });
        }

        const vcLoad = osiLib.require('osi-valve-control');
        if (!vcLoad.ok) {
            const err = new Error('valve control module unavailable: ' + vcLoad.error);
            err.statusCode = 500;
            throw err;
        }
        const VC = vcLoad.value;
        let csClient = null;
        const cs = function () { return csClient || (csClient = chirpstack.createProvisioningClientFromEnv(env)); };
        const result = await VC.cancelActuation({
            db: db,
            deviceEui: deveui,
            expectationId: body.expectation_id,
            reason: reason,
            now: new Date(now),
            warn: node.warn,
            flushQueue: function (deveui) { return cs().flushDeviceQueue(deveui); },
            transport: cs(),
            readQueue: function (deveui) { return cs().getDeviceQueue(deveui); },
            enqueue: function (item) { return cs().enqueueDownlink(item); }
        });

        // Outcome contract (cancelled / handed_off / already_running / uncertain) and the
        // flush collateral: osi-valve-control cancel.js cancelHttpResponse.
        const shaped = VC.cancelHttpResponse(result, deveui);
        return respond(shaped.statusCode, shaped.payload);
    } finally {
        try { await close(); } catch (_) {}
    }
})().catch((error) => {
    msg.statusCode = error && error.statusCode ? error.statusCode : 500;
    msg.payload = { message: error && error.message ? error.message : 'Unable to cancel STREGA actuation' };
    return msg;
});
}

module.exports = { cancelValveRequest };
