'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

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

async function handleHttpRequest(options) {
  const { msg, Database } = options;
  const environment = options.environment || {};
  const warn = typeof options.warn === 'function' ? options.warn : function () {};
  const respond = (statusCode, payload) => { msg.statusCode = statusCode; msg.payload = payload; msg.headers = HEADERS; return msg; };
  const method = String(msg.req && msg.req.method || '').toUpperCase();
  let db = null;
  try {
    const secret = resolveAuthSecret(environment, warn);
    const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization, secret);
    db = new Database(environment.dbPath || '/data/db/farming.db');

    if (method === 'GET') {
      const gatewayTimezone = await readGatewayTimezone(db, warn);
      return respond(200, { gatewayTimezone });
    }

    if (method === 'PUT') {
      const body = requestBody(msg);
      const gatewayTimezone = String(body.gatewayTimezone || '').trim();
      if (!gatewayTimezone) throw apiError(422, 'invalid_timezone', 'gatewayTimezone is required');
      try {
        Intl.DateTimeFormat(undefined, { timeZone: gatewayTimezone });
      } catch (error) {
        throw apiError(422, 'invalid_timezone', 'gatewayTimezone must be a valid IANA time zone');
      }
      const applyToAllZones = body.applyToAllZones === true;
      const now = new Date().toISOString();
      try {
        await db.run(
          "INSERT INTO app_settings(key, value, updated_at) VALUES ('gateway_timezone', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
          [gatewayTimezone, now]
        );
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
      return respond(200, { gatewayTimezone, zonesUpdated });
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

module.exports = { handleHttpRequest };
