'use strict';

const location = require('../osi-installation-location-helper');
const defaultScope = require('../osi-scope-helper');

function error(status, message) { const e = new Error(message); e.statusCode = status; return e; }
function eui(value) { const v = String(value || '').trim().toUpperCase(); if (!/^[0-9A-F]{16}$/.test(v)) throw error(400, 'invalid device EUI'); return v; }
function bodyOf(request) { return request.body && typeof request.body === 'object' ? request.body : {}; }
function response(statusCode, payload) { return { statusCode, payload }; }

async function actor(db, auth, scoped) {
  const row = await db.get('SELECT user_uuid, role, disabled_at FROM users WHERE id=? AND username=? LIMIT 1', [auth.userId, auth.username]);
  if (!row || row.disabled_at) throw error(403, 'account disabled');
  if (!scoped) return { userUuid: row.user_uuid, role: 'admin' };
  return { userUuid: row.user_uuid, role: row.role };
}

async function activeInstallation(db) {
  const identity = await db.get("SELECT installation_uuid,current_gateway_device_eui FROM installation_identity WHERE singleton_id=1 AND recovery_state='ACTIVE'");
  if (!identity || !identity.current_gateway_device_eui) throw error(503, 'active installation unavailable');
  return identity;
}

async function authorize(db, scope, auth, deviceEui, scoped, write, identity) {
  const user = await actor(db, auth, scoped);
  identity = identity || await activeInstallation(db);
  const device = await db.get('SELECT gateway_device_eui FROM devices WHERE deveui=? AND deleted_at IS NULL', [deviceEui]);
  if (!device) throw error(404, 'device not found');
  const gateway = String(device.gateway_device_eui || '').toUpperCase();
  if (gateway && gateway !== String(identity.current_gateway_device_eui).toUpperCase()) throw error(403, 'device belongs to another gateway');
  let granted;
  try { granted = await scope.assertFreshDeviceAccess(db, user.userUuid, deviceEui, { scopedMode: scoped }); }
  catch (e) { if (scoped && Number(e.statusCode || e.status) === 404) throw error(403, 'forbidden'); throw e; }
  const role = granted.role || user.role;
  if (write && !scope.canMutate(role)) throw error(403, 'insufficient role');
  return { user, role, identity };
}

function revisionRows(db, table, deviceEui, limit, installationUuid) {
  return db.all('SELECT * FROM ' + table + ' WHERE device_eui=? AND installation_uuid=? ORDER BY effective_from DESC, revision_no DESC LIMIT ?', [deviceEui, installationUuid, Math.min(200, limit)]);
}

async function handleRequest(request = {}) {
  const db = request.db;
  const scope = request.scope || defaultScope;
  const scoped = request.scopedMode === true;
  if (!db) throw error(500, 'network API dependencies are incomplete');
  if (!request.authorization) return response(401, { error: 'Unauthorized' });
  try {
    const auth = scope.verifyBearer(request.authorization, { configuredSecret: request.authSecret, fs: request.fs, warn: request.warn });
    const method = String(request.method || 'GET').toUpperCase();
    const path = String(request.path || '').split('?')[0];
    const match = /^\/api\/devices\/([^/]+)\/(installation-location|radio-configuration)(\/revisions)?$/.exec(path);
    if (match) {
      const deviceEui = eui(decodeURIComponent(match[1]));
      const kind = match[2];
      const table = kind === 'installation-location' ? 'device_installation_location_revisions' : 'device_radio_configuration_revisions';
      const access = await authorize(db, scope, auth, deviceEui, scoped, method === 'PUT');
      if (method === 'GET') {
        if (match[3]) return response(200, await revisionRows(db, table, deviceEui, 200, access.identity.installation_uuid));
        const resolved = kind === 'installation-location' ? await location.resolveLocation(db, deviceEui, request.at) : await location.resolveRadioConfiguration(db, deviceEui, request.at);
        return response(200, resolved || { device_eui: deviceEui, source: 'unknown' });
      }
      if (method !== 'PUT' || match[3]) throw error(405, 'method not allowed');
      const input = bodyOf(request);
      const identity = await db.get('SELECT installation_uuid,current_gateway_device_eui FROM installation_identity WHERE singleton_id=1 AND recovery_state=\'ACTIVE\' LIMIT 1');
      const device = await db.get('SELECT gateway_device_eui FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1', [deviceEui]);
      if (!identity || !device) throw error(404, 'device or installation not found');
      const options = { db, deviceEui, installationUuid: identity.installation_uuid, gatewayEui: device.gateway_device_eui || identity.current_gateway_device_eui, actorUserUuid: access.user.userUuid, baseRevisionUuid: input.base_revision_uuid || input.baseRevisionUuid, revisionUuid: input.revision_uuid || input.revisionUuid, values: input.values || input, now: request.now || new Date().toISOString() };
      let saved;
      try { saved = kind === 'installation-location' ? await location.saveLocation(db, options) : await location.saveRadioConfiguration(db, options); }
      catch (saveError) { throw error(/stale|mismatch|supersed|base revision/i.test(String(saveError.message)) ? 409 : 400, saveError.message); }
      return response(saved.replayed ? 200 : 201, saved);
    }
    if (method === 'GET' && path === '/api/network/observations') {
      await actor(db, auth, scoped);
      const identity = await activeInstallation(db);
      const query = request.query || {};
      const now = new Date(request.now || Date.now());
      const hours = Math.min(24 * 30, Math.max(1, Number(query.hours || 24) || 24));
      const start = query.from == null ? new Date(now.getTime() - hours * 3600000) : new Date(query.from);
      const end = query.to == null ? now : new Date(query.to);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end || end - start > 30 * 86400000) throw error(400, 'invalid observation window');
      const from = start.toISOString();
      const to = end.toISOString();
      const requested = Array.isArray(query.deviceEuis) ? query.deviceEuis.map(eui) : [];
      const devices = requested.length ? requested : (await db.all('SELECT deveui FROM devices WHERE deleted_at IS NULL ORDER BY deveui')).map(row => row.deveui);
      const visible = [];
      for (const deviceEui of devices) { try { await authorize(db, scope, auth, deviceEui, scoped, false, identity); visible.push(deviceEui); } catch (visibilityError) { if (!requested.length && [403,404].includes(Number(visibilityError.statusCode || visibilityError.status))) continue; throw visibilityError; } }
      if (!visible.length) return response(200, {rows:[],truncated:false,nextOffset:null,from,to});
      const limit = Math.floor(Math.min(500, Math.max(1, Number(query.limit || 500) || 500)));
      const placeholders = visible.map(() => '?').join(',');
      if (!request.radioDb) throw error(503, 'radio observations unavailable');
      const offset = Math.floor(Math.min(100000, Math.max(0, Number(query.offset || 0) || 0)));
      const rows = await request.radioDb.all('SELECT * FROM radio_uplinks WHERE deveui IN (' + placeholders + ') AND installation_uuid=? AND recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at DESC,id DESC LIMIT ? OFFSET ?', visible.concat(identity.installation_uuid, from, to, limit + 1, offset));
      const truncated = rows.length > limit;
      return response(200, {rows:rows.slice(0,limit),truncated,nextOffset:truncated?offset+limit:null,from,to});
    }
    throw error(404, 'network API route not found');
  } catch (e) { return response(Number(e.statusCode || 500), { error: String(e.message || e) }); }
}

module.exports = { handleRequest };
