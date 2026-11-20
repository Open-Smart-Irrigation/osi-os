'use strict';
// X3: preserve the legacy handler bodies, including compatibility SQL, cache
// policy, and caught failures. Behavioral changes belong to their later packages.
// All request state and runtime services are injected per invocation.
function todayLiters(msg, { osiDb, osiLib, crypto, env, node, global, Date = globalThis.Date }) {
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
          node.warn('strega-today-liters-fn auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fsMod.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        node.warn('strega-today-liters-fn auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));
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
    msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: 'strega-today-liters-fn' }; throw err;
  }
  const token = authHeader.substring(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'strega-today-liters-fn' }; throw err;
  }
  const payloadB64 = parts[0];
  const sig = parts[1];
  const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'strega-today-liters-fn' }; throw err;
  }
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
  } catch (_) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'strega-today-liters-fn' }; throw err;
  }
  const userId = Number(payload.userId);
  const username = String(payload.username || '').trim();
  const exp = Number(payload.exp || 0);
  if (!Number.isFinite(userId) || !username) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: 'strega-today-liters-fn' }; throw err;
  }
  if (exp && Date.now() > exp) {
    const err = new Error('Token expired');
    err.statusCode = 401;
    msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: 'strega-today-liters-fn' }; throw err;
  }
  return { userId, username };
}
  // A signed-in session is required in both flag states, as on the device
  // history routes; scoped mode adds the enabled-account check below.
  const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);
  const deveui = String((msg.req && msg.req.params && msg.req.params.deveui) || '').trim().toUpperCase();
  if (!deveui) {
    msg.statusCode = 400;
    msg.payload = { message: 'deveui required' };
    return msg;
  }
  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  try {
    if (scopedOn) {
      const scopeLoad = osiLib.require('scope');
      if (!scopeLoad.ok) {
        const error = new Error('scope resolver unavailable');
        error.statusCode = 500;
        node.error('today-liters: scope module unavailable: ' + scopeLoad.error, msg);
        throw error;
      }
      const user = await db.get(
        'SELECT user_uuid FROM users WHERE id = ? AND username = ?',
        [auth.userId, auth.username]
      );
      if (!user || !user.user_uuid) {
        const error = new Error('forbidden');
        error.statusCode = 403;
        throw error;
      }
      // Write-only scoping (W1/P5): device reads are account-wide, including
      // devices with no zone. The enabled-account check is the only gate (P1).
      await scopeLoad.value.assertEnabledAccount(
        db,
        user.user_uuid,
        { scopedMode: true }
      );
    }
    const valveLoad = osiLib.require('osi-valve-control');
    if (!valveLoad.ok || typeof valveLoad.value.isReportOnlyExpectation !== 'function') {
      const error = new Error('Valve projection unavailable');
      error.statusCode = 503;
      throw error;
    }
    const expectationRows = await db.all(
      `SELECT estimated_gross_liters, volume_source, command_id, transport_json
       FROM valve_actuation_expectations
       WHERE UPPER(device_eui) = ?
         AND commanded_at >= ?
         AND reconciliation_state NOT IN ('CANCELLED','STALE_NO_OBSERVATION')`,
      [deveui, todayIso]
    );
    const totals = new Map();
    for (const expectation of expectationRows) {
      if (valveLoad.value.isReportOnlyExpectation(expectation)) continue;
      if (expectation.estimated_gross_liters == null || !Number.isFinite(Number(expectation.estimated_gross_liters))) continue;
      const source = String(expectation.volume_source || 'unknown');
      totals.set(source, Number(totals.get(source) || 0) + Number(expectation.estimated_gross_liters));
    }
    const row = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
    const liters = row ? Math.round(row[1] * 10) / 10 : null;
    msg.statusCode = 200;
    msg.payload = {
      liters,
      source: row ? String(row[0] || 'unknown') : 'none',
    };
    return msg;
  } finally {
    try {
      await close();
    } catch (error) {
      node.warn('today-liters db close failed: ' +
        (error && error.message ? error.message : error));
    }
  }
})().catch((error) => {
  const statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  if (statusCode >= 500) {
    node.error('today-liters query failed: ' +
      String(error && error.message ? error.message : error), msg);
  }
  msg.statusCode = statusCode;
  msg.payload = {
    message: statusCode >= 500
      ? 'Internal error'
      : String(error && error.message ? error.message : 'Request denied'),
  };
  return msg;
});
}

function queryActuations(msg, { osiDb, osiLib, env, node, Date = globalThis.Date }) {
return (async()=>{
  if (!msg.payload || msg.payload.length === 0) {
    msg.statusCode = 401;
    msg.payload = { message: "User not found" };
    return [null, msg];
  }
  const userId = msg.payload[0].id;
  const _db = new osiDb.Database('/data/db/farming.db');
  const exec = (sql, params) => new Promise((res,rej) => _db.run(sql, params || [], e => e ? rej(e) : res()));
  const query = (sql, params) => new Promise((res,rej) => _db.all(sql, params || [], (e,r) => e ? rej(e) : res(r || [])));
  try {
    await exec(`CREATE TABLE IF NOT EXISTS valve_actuation_expectations (
  expectation_id             TEXT PRIMARY KEY,
  device_eui                 TEXT NOT NULL,
  zone_id                    INTEGER,
  command_id                 TEXT,
  effect_key                 TEXT,
  commanded_at               TEXT NOT NULL,
  commanded_duration_seconds INTEGER NOT NULL,
  expected_close_at          TEXT NOT NULL,
  flow_rate_lpm              REAL,
  flow_rate_source           TEXT,
  estimated_gross_liters     REAL,
  volume_source              TEXT NOT NULL DEFAULT 'unknown',
  observed_open_at           TEXT,
  observed_close_at          TEXT,
  reconciliation_state       TEXT NOT NULL DEFAULT 'PENDING_OBSERVATION',
  cancel_reason              TEXT,
  trigger                    TEXT,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);

    const scopedMode = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
    let zoneUuids = null;
    if (scopedMode) {
      const scopeLoad = osiLib.require('scope');
      if (!scopeLoad.ok) {
        node.error('recent actuations: scope module unavailable: ' + scopeLoad.error, msg);
        const error = new Error('scope resolver unavailable');
        error.statusCode = 500;
        throw error;
      }
      const users = await query(
        'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
        [userId, msg.authUsername]
      );
      if (!users.length || !users[0].user_uuid) {
        const error = new Error('Unauthorized');
        error.statusCode = 401;
        throw error;
      }
      await scopeLoad.value.assertEnabledAccount(
        _db,
        users[0].user_uuid,
        { scopedMode: true }
      );
      // Write-only scoping (W1): recent actuations are account-wide; the
      // enabled-account check above is the only gate (P1).
      zoneUuids = [];
    }

    const select = `
      SELECT
        vae.expectation_id,
        vae.device_eui,
        vae.zone_id,
        vae.command_id,
        vae.commanded_at,
        vae.commanded_duration_seconds,
        vae.expected_close_at,
        vae.flow_rate_lpm,
        vae.estimated_gross_liters,
        vae.observed_open_at,
        vae.observed_close_at,
        vae.reconciliation_state,
        vae.cancel_reason,
        vae.trigger,
        vae.transport_json,
        d.name AS device_name,
        iz.name AS zone_name,
        ac.result AS command_result,
        ac.result_detail AS command_result_detail,
        ac.applied_at AS command_applied_at
      FROM valve_actuation_expectations vae
      JOIN devices d ON d.deveui = vae.device_eui
      LEFT JOIN irrigation_zones iz ON iz.id = vae.zone_id
      LEFT JOIN applied_commands ac ON ac.command_id = vae.command_id
    `;
    let where;
    let params;
    if (zoneUuids !== null) {
      where = 'WHERE 1 = 1';
      params = [];
    } else {
      where = 'WHERE d.user_id = ?';
      params = [userId];
    }
    const rows = await query(
      select + where + ' ORDER BY vae.commanded_at DESC',
      params
    );
    const valveLoad = osiLib.require('osi-valve-control');
    if (!valveLoad.ok || typeof valveLoad.value.isReportOnlyExpectation !== 'function') {
      node.warn('recent actuations: report-only projection helper unavailable: ' + String(valveLoad.error || 'missing predicate'));
      msg.statusCode = 503;
      msg.payload = { message: 'Valve projection unavailable' };
      return [null, msg];
    }
    // Filter the full candidate set before limiting so report-only rows cannot crowd
    // valid command owners out of the recent command projection.
    msg.payload = rows.filter((row) => !valveLoad.value.isReportOnlyExpectation(row)).slice(0, 50);
    return [msg, null];
  } catch (error) {
    node.warn('recent actuations query: ' + String(error && error.message ? error.message : error));
    msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.payload = { message: msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error) };
    return [null, msg];
  } finally {
    try {
      await new Promise(function(resolve) { _db.close(function() { resolve(); }); });
    } catch (error) {
      node.warn('recent actuations close: ' + String(error && error.message ? error.message : error));
    }
  }
})();
}

function formatActuations(msg, { Date = globalThis.Date } = {}) {
// Compute derived per-row status for the irrigation outcomes panel.
// Status taxonomy (read-only display, no lifecycle):
//   CANCELLED         - operator cancelled the actuation
//   COMMAND_FAILED    - applied_commands.result is set and not 'APPLIED'
//   COMPLETED         - opened and closed within the expected window
//   RUNNING           - opened, not yet past expected_close_at + grace
//   CLOSE_TIMEOUT     - opened but no observed_close_at past expected_close_at + grace
//   PENDING_OPEN      - command issued, not yet observed open, within grace
//   OPEN_TIMEOUT      - command issued, never observed open past expected_close_at + grace
//   UNKNOWN           - any state the matrix does not cover (defensive)
// Mirrors strega-reconciliation-monitor's RECONCILIATION_GRACE_SEC (1800s) - a Class-A uplink
// cycle each leg - so a healthy run isn't badged timed-out before the reconciler would.
const GRACE_MS = 1800 * 1000;
const now = Date.now();
function deriveStatus(r) {
  if (r.reconciliation_state === 'CANCELLED') return 'CANCELLED';
  if (r.command_result && String(r.command_result).toUpperCase() !== 'APPLIED') return 'COMMAND_FAILED';
  const expectedCloseMs = Date.parse(r.expected_close_at);
  const hasOpen = !!r.observed_open_at;
  const hasClose = !!r.observed_close_at;
  if (hasOpen && hasClose) return 'COMPLETED';
  if (hasOpen && !hasClose) {
    return (Number.isFinite(expectedCloseMs) && now > expectedCloseMs + GRACE_MS) ? 'CLOSE_TIMEOUT' : 'RUNNING';
  }
  if (!hasOpen) {
    return (Number.isFinite(expectedCloseMs) && now > expectedCloseMs + GRACE_MS) ? 'OPEN_TIMEOUT' : 'PENDING_OPEN';
  }
  return 'UNKNOWN';
}
const rows = msg.payload || [];
msg.statusCode = 200;
msg.payload = {
  generatedAt: new Date().toISOString(),
  actuations: rows.map(r => ({
    expectationId: r.expectation_id,
    deviceEui: r.device_eui,
    deviceName: r.device_name || null,
    zoneId: r.zone_id,
    zoneName: r.zone_name || null,
    commandId: r.command_id || null,
    commandedAt: r.commanded_at,
    commandedDurationSeconds: Number(r.commanded_duration_seconds || 0),
    expectedCloseAt: r.expected_close_at,
    observedOpenAt: r.observed_open_at || null,
    observedCloseAt: r.observed_close_at || null,
    estimatedGrossLiters: r.estimated_gross_liters != null ? Number(r.estimated_gross_liters) : null,
    flowRateLpm: r.flow_rate_lpm != null ? Number(r.flow_rate_lpm) : null,
    reconciliationState: r.reconciliation_state,
    cancelReason: r.cancel_reason || null,
    trigger: r.trigger || null,
    commandResult: r.command_result || null,
    commandResultDetail: r.command_result_detail || null,
    commandAppliedAt: r.command_applied_at || null,
    status: deriveStatus(r)
  }))
};
return msg;

}

async function loadEstimatedIrrigationByLocalDate(zone, startIso, endIso, { osiLib, node, q, ZE, s, Date = globalThis.Date }) {
  const valveLoad = osiLib.require('osi-valve-control');
  if (!valveLoad.ok || typeof valveLoad.value.isReportOnlyExpectation !== 'function') {
    node.warn('zone environment: report-only projection helper unavailable: ' + String(valveLoad.error || 'missing predicate'));
    return {};
  }
  const windowStartIso = ZE.addUtcDays(startIso, -1) || startIso;
  const windowEndIso = ZE.addUtcDays(endIso, 2) || endIso;
  const rows = await q(
    'SELECT commanded_at,estimated_gross_liters,command_id,transport_json FROM valve_actuation_expectations ' +
    'WHERE zone_id=' + Number(zone.id) + ' AND estimated_gross_liters IS NOT NULL ' +
    "AND COALESCE(reconciliation_state,'') NOT IN ('CANCELLED','STALE_NO_OBSERVATION') " +
    'AND commanded_at >= ' + s(windowStartIso + 'T00:00:00.000Z') + ' AND commanded_at < ' + s(windowEndIso + 'T00:00:00.000Z')
  );
  const estimatedByDate = {};
  for (const row of rows || []) {
    if (valveLoad.value.isReportOnlyExpectation(row)) continue;
    const localDate = ZE.localDateIso(row.commanded_at, zone && zone.timezone, Date.now());
    if (!localDate || localDate < startIso || localDate > endIso) continue;
    const liters = ZE.toFiniteNumber(row.estimated_gross_liters);
    if (liters == null) continue;
    estimatedByDate[localDate] = ZE.round((estimatedByDate[localDate] || 0) + liters, 2);
  }
  return estimatedByDate;
}

module.exports = { todayLiters, queryActuations, formatActuations, loadEstimatedIrrigationByLocalDate };
