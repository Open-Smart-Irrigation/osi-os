'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
// The four switchable modules -- their app_settings keys, the field names this
// route reports, and the value a gateway ships with -- are declared once in
// osi-module-defaults and read from there by this route, by the journal
// replication worker, and (via the moduleDefaults object below) by the GUI.
const { MODULE_SETTINGS, MODULE_DEFAULTS, interpretStoredValue } = require('../osi-module-defaults');

// --- copied verbatim from osi-valve-control/api.js (apiError, unauthorized, verifyBearer, resolveAuthSecret, requestBody, closeFacade) ---

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
      warn('[sys-settings] auth secret file was empty path=' + secretPath);
    } catch (error) {
      warn('[sys-settings] auth secret read failed path=' + secretPath +
        ' code=' + String(error && error.code || 'unknown'));
    }
  }
  throw apiError(503, 'auth_unavailable', 'System settings authentication is unavailable');
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
    warn('[sys-settings] database close failed code=' + String(error && error.code || 'unknown'));
  }
}

// --- end verbatim copy ---

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };

// F31 (2026-09-17 Silvan harness, run-full2/ST1.md checks #17-18): shared
// timezone validator, extracted so every route that accepts a timezone
// string enforces the same rule PUT /api/system/settings always has --
// PUT /api/irrigation-zones/:id/timezone (osi-system-settings-consumer:
// dendro-tz-fn in flows.json) used to persist ANY string unvalidated
// ("Not/AZone" -> 200, stored verbatim), so everything downstream that does
// wall-clock math for that zone (valve plan compiler, daily rollups,
// schedule next_run) then worked from an unresolvable zone. Throws an
// apiError(422, 'invalid_timezone', <message>) exactly like the inline
// check this replaced; callers that need a different statusCode/response
// shape still just inspect error.statusCode/error.code/error.message.
function validateTimezone(rawValue, fieldName) {
  const label = fieldName || 'timezone';
  const value = String(rawValue || '').trim();
  if (!value) throw apiError(422, 'invalid_timezone', label + ' is required');
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
  } catch (error) {
    throw apiError(422, 'invalid_timezone', label + ' must be a valid IANA time zone');
  }
  return value;
}

// Table-missing-safe: a pre-migration DB (deploys are staged) has no app_settings table yet.
// Never throws; an absent key or absent table both resolve to the 'UTC' floor.
async function readGatewayTimezone(db, warn) {
  try {
    const row = await db.get("SELECT value FROM app_settings WHERE key = 'gateway_timezone'");
    return (row && row.value) || 'UTC';
  } catch (error) {
    const detail = String(error && error.message ? error.message : error);
    if (!/no such table:\s*app_settings\b/i.test(detail)) {
      warn('[sys-settings] gateway_timezone read failed: ' + detail);
    }
    return 'UTC';
  }
}

// Owner decision 2026-09-17: the Data view, Network, Gateway hub and Field
// Journal are switchable modules, and all four are GATEWAY settings rather than
// per-browser preferences -- every user of a gateway sees the same surface, and
// the choice survives a browser change. The Field Journal additionally has to be
// readable by the Node-RED journal-v2 replication worker, which no browser-local
// value could ever be. All four ride the same gateway-level app_settings store
// as gateway_timezone: no new route, no schema migration.
//
// The table itself lives in osi-module-defaults (see the require above): adding
// a module, or changing what a gateway ships with, is an edit there and nothing
// here. GET, PUT validation and the response shape are all driven off it.

// Table-missing-safe, same contract as readGatewayTimezone: a pre-migration DB
// and an absent key both resolve to the module's shipped default, so a gateway
// mid-deploy behaves like a fresh gateway on the same firmware rather than
// showing a view its own settings page says is off.
async function readModuleSettings(db, warn) {
  const settings = {};
  for (const module of MODULE_SETTINGS) {
    let row = null;
    try {
      row = await db.get('SELECT value FROM app_settings WHERE key = ?', [module.key]);
    } catch (error) {
      const detail = String(error && error.message ? error.message : error);
      if (!/no such table:\s*app_settings\b/i.test(detail)) {
        warn('[sys-settings] ' + module.key + ' read failed: ' + detail);
      }
      settings[module.field] = interpretStoredValue(module.key, null);
      continue;
    }
    settings[module.field] = interpretStoredValue(module.key, row ? row.value : null);
  }
  return settings;
}

// Strict boolean only. Accepting 'false'/0 would make a typo read as "on"
// (every non-empty string is truthy), which is exactly the failure these
// switches exist to prevent -- most sharply for the journal module, where "on"
// means the replication worker keeps calling the cloud.
function validateModuleEnabled(rawValue, fieldName) {
  if (rawValue !== true && rawValue !== false) {
    throw apiError(422, 'invalid_request', fieldName + ' must be a boolean');
  }
  return rawValue;
}

// Collects every module field present on the body, validating all of them
// before any write happens: one bad field rejects the whole request rather than
// leaving the gateway half-updated into a state the caller never asked for.
function collectModuleWrites(body) {
  const writes = [];
  if (body === null || typeof body !== 'object') return writes;
  for (const module of MODULE_SETTINGS) {
    if (!Object.prototype.hasOwnProperty.call(body, module.field)) continue;
    writes.push({
      key: module.key,
      field: module.field,
      value: validateModuleEnabled(body[module.field], module.field),
    });
  }
  return writes;
}

async function handleHttpRequest(options) {
  const { msg, Database } = options;
  const environment = options.environment || {};
  const scopedMode = options.scopedMode === true;
  const warn = typeof options.warn === 'function' ? options.warn : function () {};
  const respond = (statusCode, payload) => { msg.statusCode = statusCode; msg.payload = payload; msg.headers = HEADERS; return msg; };
  const method = String(msg.req && msg.req.method || '').toUpperCase();
  let db = null;
  try {
    const secret = resolveAuthSecret(environment, warn);
    const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization, secret);
    db = new Database(environment.dbPath || '/data/db/farming.db');

    // PR-N (Fable consult Q5/Q7): scoped-mode role guard on the WRITE path
    // only -- GET stays open, mirroring main's read-vs-write split elsewhere.
    // Flag-gated exactly like the #201 hermetic rule: the scope helper is
    // require()'d only on this branch, so a lost/corrupt osi-scope-helper
    // file cannot 500 this route when OSI_SCOPED_ACCESS is off.
    if (method === 'PUT' && scopedMode) {
      let scope = options.scope;
      if (!scope) {
        try {
          // eslint-disable-next-line global-require
          scope = require('../osi-scope-helper');
        } catch (error) {
          warn('[sys-settings] scope helper unavailable: ' + String(error && error.message ? error.message : error));
          throw apiError(500, 'scope_unavailable', 'System write authorization is unavailable');
        }
      }
      await scope.assertAuthenticatedRole(db, auth, 'admin', { scopedMode: true });
    }

    if (method === 'GET') {
      const gatewayTimezone = await readGatewayTimezone(db, warn);
      const modules = await readModuleSettings(db, warn);
      // moduleDefaults alongside the effective values: the GUI keeps no copy of
      // them, so this is how a browser learns what THIS gateway ships with --
      // which is what it falls back to when a later poll fails, and what tells
      // "switched off here" apart from "shipped off".
      return respond(200, Object.assign({ gatewayTimezone, moduleDefaults: MODULE_DEFAULTS }, modules));
    }

    if (method === 'PUT') {
      const body = requestBody(msg);
      const moduleWrites = collectModuleWrites(body);
      const hasTimezone = body !== null && typeof body === 'object' &&
        Object.prototype.hasOwnProperty.call(body, 'gatewayTimezone');
      // The timezone contract is unchanged: a PUT that carries no module flag
      // still requires a valid gatewayTimezone, and a timezone sent alongside a
      // module flag is still validated. Only a module-only PUT may omit it.
      const gatewayTimezone = (moduleWrites.length > 0 && !hasTimezone)
        ? await readGatewayTimezone(db, warn)
        : validateTimezone(body.gatewayTimezone, 'gatewayTimezone');
      const writeTimezone = hasTimezone || moduleWrites.length === 0;
      const applyToAllZones = body.applyToAllZones === true;
      const now = new Date().toISOString();
      try {
        if (writeTimezone) {
          await db.run(
            "INSERT INTO app_settings(key, value, updated_at) VALUES ('gateway_timezone', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            [gatewayTimezone, now]
          );
        }
        for (const write of moduleWrites) {
          await db.run(
            'INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
            [write.key, write.value ? '1' : '0', now]
          );
        }
      } catch (error) {
        const detail = String(error && error.message ? error.message : error);
        if (/no such table:\s*app_settings\b/i.test(detail)) {
          return respond(503, { error: 'schema_pending', message: 'Gateway settings are not available yet; run the pending migration' });
        }
        throw error;
      }
      // Own-zones-only, deleted_at IS NULL, sync_version/updated_at bump: the exact
      // predicate + write shape zone-config-fn uses for every other zone mutation (FW-T5
      // review R1, M1-M3). Scoping by auth.userId keeps this PUT from reaching another
      // user's zones (verifyBearer only proves *some* valid session, not ownership);
      // deleted_at IS NULL keeps a soft-deleted zone from being resurrected into the sync
      // outbox as a spurious ZONE_DELETED re-emission and from inflating the reported
      // count; the sync_version bump matches every sibling writer so a cloud-side zone
      // whose version has moved ahead of the edge's does not silently drop this change
      // (the trigger only emits an op the cloud accepts, no sync-table writes here).
      // Count-then-update runs inside one transaction so a concurrent zone edit between
      // the two statements cannot desync the reported count from what was actually written.
      let zonesUpdated = 0;
      if (applyToAllZones) {
        zonesUpdated = await db.transaction(async (tx) => {
          const countRow = await tx.get(
            'SELECT COUNT(*) AS c FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL AND timezone <> ?',
            [auth.userId, gatewayTimezone]
          );
          const count = Number(countRow && countRow.c) || 0;
          if (count > 0) {
            await tx.run(
              'UPDATE irrigation_zones SET timezone = ?, updated_at = ?, sync_version = COALESCE(sync_version,0)+1 WHERE user_id = ? AND deleted_at IS NULL AND timezone <> ?',
              [gatewayTimezone, now, auth.userId, gatewayTimezone]
            );
          }
          return count;
        });
      }
      // Read back rather than echo: the response then reflects what is actually
      // stored, including modules this request did not touch.
      const modules = await readModuleSettings(db, warn);
      // Same shape as GET, defaults included, so the GUI can fold this response
      // straight into its settings cache without dropping them.
      return respond(200, Object.assign({ gatewayTimezone, zonesUpdated, moduleDefaults: MODULE_DEFAULTS }, modules));
    }

    return respond(404, { error: 'not_found', message: 'Unknown system-settings route' });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    if (status === 500) warn('[sys-settings] ' + method + ' failed: ' + (error && error.stack || error));
    return respond(status, { error: status === 500 ? 'internal_error' : (error.code || 'error'), message: status === 500 ? 'System settings request failed' : String(error.message || '') });
  } finally {
    await closeFacade(db, warn);
  }
}

// MODULE_SETTINGS is re-exported, not redefined: callers (and the cross-module
// key test) keep reading it from here while osi-module-defaults owns it.
module.exports = { handleHttpRequest, validateTimezone, validateModuleEnabled, MODULE_SETTINGS, MODULE_DEFAULTS };
