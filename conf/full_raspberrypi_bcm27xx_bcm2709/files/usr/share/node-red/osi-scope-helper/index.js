'use strict';

const crypto = require('crypto');
const CACHE_TTL_MS = 30000;
const cache = new Map();
const WEATHER_TYPE_IDS = new Set(['SENSECAP_S2120', 'AQUASCOPE_LORAIN']);

function isScopedMode(envValue) {
  return String(
    envValue !== undefined ? envValue : process.env.OSI_SCOPED_ACCESS || ''
  ) === '1';
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  return error;
}

function resolveAuthSecret(options = {}) {
  const configured = String(options.configuredSecret || '').trim();
  if (configured) return configured;
  const fs = options.fs;
  const warn = typeof options.warn === 'function' ? options.warn : function() {};
  const secretPaths = [
    '/data/db/osi_auth_token_secret',
    '/var/lib/node-red/.node-red/osi_auth_token_secret',
  ];
  if (fs) {
    for (const secretPath of secretPaths) {
      try {
        const existing = String(fs.readFileSync(secretPath, 'utf8') || '').trim();
        if (existing) return existing;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          warn('scope auth secret read failed for ' + secretPath + ': ' +
            String(error && error.message ? error.message : error));
        }
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    for (const secretPath of secretPaths) {
      try {
        fs.writeFileSync(secretPath, generated + '\n', { mode: 0o600 });
        return generated;
      } catch (error) {
        warn('scope auth secret write failed for ' + secretPath + ': ' +
          String(error && error.message ? error.message : error));
      }
    }
  }
  throw httpError(500, 'AUTH_TOKEN_SECRET or JWT_SECRET must be configured');
}

function verifyBearer(authHeader, options) {
  if (!authHeader || !String(authHeader).startsWith('Bearer ')) {
    throw httpError(401, 'Unauthorized');
  }
  const token = String(authHeader).slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw httpError(401, 'Invalid token');
  }
  const secret = resolveAuthSecret(options);
  const expected = crypto.createHmac('sha256', secret)
    .update(parts[0])
    .digest('base64url');
  const actualBuffer = Buffer.from(parts[1], 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw httpError(401, 'Invalid token');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (error) {
    throw httpError(401, 'Invalid token');
  }
  const userId = Number(payload && payload.userId);
  const username = String(payload && payload.username || '').trim();
  const expiresAt = Number(payload && payload.exp || 0);
  if (!Number.isFinite(userId) || !username) throw httpError(401, 'Invalid token');
  if (expiresAt && Date.now() > expiresAt) throw httpError(401, 'Token expired');
  return { userId, username };
}

async function loadUser(db, userUuid) {
  if (!userUuid) throw httpError(500, 'resolveScope called without user_uuid');
  const row = await db.get(
    'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE user_uuid = ?',
    [userUuid]
  );
  if (!row) throw httpError(403, 'unknown user');
  return row;
}

async function loadScope(db, userUuid) {
  const user = await loadUser(db, userUuid);
  const scope = {
    role: user.role,
    username: user.username,
    disabled: Boolean(user.disabled_at),
    wildcard: false,
    zoneUuids: new Set(),
    plotUuids: new Set(),
  };
  if (scope.disabled) return scope;

  const ownedZones = await db.all(
    `SELECT zone_uuid
       FROM irrigation_zones
      WHERE user_id = ? AND deleted_at IS NULL AND zone_uuid IS NOT NULL`,
    [user.id]
  );
  for (const row of ownedZones) scope.zoneUuids.add(row.zone_uuid);

  const grantedZones = await db.all(
    `SELECT zone_uuid
       FROM user_zone_assignments
      WHERE user_uuid = ? AND deleted_at IS NULL`,
    [userUuid]
  );
  for (const row of grantedZones) scope.zoneUuids.add(row.zone_uuid);

  const ownedPlots = await db.all(
    `SELECT plot_uuid
       FROM journal_plots
      WHERE owner_user_uuid = ? AND deleted_at IS NULL`,
    [userUuid]
  );
  for (const row of ownedPlots) scope.plotUuids.add(row.plot_uuid);

  const grantedPlots = await db.all(
    `SELECT plot_uuid
       FROM user_plot_assignments
      WHERE user_uuid = ? AND deleted_at IS NULL`,
    [userUuid]
  );
  for (const row of grantedPlots) scope.plotUuids.add(row.plot_uuid);
  return scope;
}

async function resolveScope(db, userUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) {
    return {
      role: 'admin',
      disabled: false,
      wildcard: true,
      zoneUuids: null,
      plotUuids: null,
    };
  }
  const hit = cache.get(userUuid);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scope;
  const scope = await loadScope(db, userUuid);
  cache.set(userUuid, { at: Date.now(), scope });
  return scope;
}

function invalidateScope(userUuid) {
  if (userUuid) cache.delete(userUuid);
  else cache.clear();
}

function scopeAllows(scope, kind, uuid) {
  if (scope.wildcard) return true;
  if (scope.disabled) return false;
  const values = kind === 'zone' ? scope.zoneUuids : scope.plotUuids;
  return values.has(uuid);
}

async function assertZoneAccess(db, userUuid, zoneUuid, options) {
  const scope = await resolveScope(db, userUuid, options);
  if (!scopeAllows(scope, 'zone', zoneUuid)) throw httpError(404, 'zone not found');
  return scope;
}

async function assertPlotAccess(db, userUuid, plotUuid, options) {
  const scope = await resolveScope(db, userUuid, options);
  if (!scopeAllows(scope, 'plot', plotUuid)) throw httpError(404, 'plot not found');
  return scope;
}

async function freshScope(db, userUuid, scopedMode) {
  if (!isScopedMode() && scopedMode !== true) {
    return { role: 'admin', disabled: false, wildcard: true };
  }
  return loadScope(db, userUuid);
}

async function assertFreshZoneAccess(db, userUuid, zoneUuid, { scopedMode } = {}) {
  const scope = await freshScope(db, userUuid, scopedMode);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scopeAllows(scope, 'zone', zoneUuid)) throw httpError(404, 'zone not found');
  return scope;
}

async function assertFreshPlotAccess(db, userUuid, plotUuid, { scopedMode } = {}) {
  const scope = await freshScope(db, userUuid, scopedMode);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scopeAllows(scope, 'plot', plotUuid)) throw httpError(404, 'plot not found');
  return scope;
}

async function assertRole(db, userUuid, role, options) {
  const scope = await resolveScope(db, userUuid, options);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scope.wildcard && scope.role !== role) {
    throw httpError(403, 'insufficient role');
  }
  return scope;
}

async function assertAuthenticatedRole(db, auth, role, options) {
  if (!auth || !Number.isFinite(Number(auth.userId)) || !String(auth.username || '').trim()) {
    throw httpError(401, 'Unauthorized');
  }
  const user = await db.get(
    'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
    [Number(auth.userId), String(auth.username).trim()]
  );
  if (!user || !user.user_uuid) throw httpError(401, 'Unauthorized');
  return assertRole(db, user.user_uuid, role, options);
}

async function authorizeAdminRead(options = {}) {
  if (typeof options.Database !== 'function') {
    throw httpError(500, 'database helper unavailable');
  }
  const auth = verifyBearer(options.authorization, {
    configuredSecret: options.configuredSecret,
    fs: options.fs,
    warn: options.warn,
  });
  const db = new options.Database('/data/db/farming.db');
  try {
    return await assertAuthenticatedRole(db, auth, 'admin', { scopedMode: true });
  } finally {
    try {
      await new Promise((resolve, reject) => {
        db.close((error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      if (typeof options.warn === 'function') {
        options.warn('admin-read scope database close failed: ' +
          String(error && error.message ? error.message : error));
      }
    }
  }
}

async function assertFreshRole(db, userUuid, role, { scopedMode } = {}) {
  const scope = await freshScope(db, userUuid, scopedMode);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scope.wildcard && scope.role !== role) {
    throw httpError(403, 'insufficient role');
  }
  return scope;
}

async function isAdmin(db, userUuid, options) {
  const scope = await resolveScope(db, userUuid, options);
  return !scope.disabled && (scope.wildcard || scope.role === 'admin');
}

async function filterZoneUuids(db, userUuid, zoneUuids, options) {
  const scope = await resolveScope(db, userUuid, options);
  if (scope.wildcard) return zoneUuids;
  if (scope.disabled) return [];
  return zoneUuids.filter((zoneUuid) => scope.zoneUuids.has(zoneUuid));
}

async function resolveZoneUuidById(db, zoneId) {
  const row = await db.get(
    'SELECT zone_uuid FROM irrigation_zones WHERE id = ? AND deleted_at IS NULL',
    [zoneId]
  );
  return row && row.zone_uuid ? row.zone_uuid : null;
}

async function assertDeviceAccess(db, userUuid, deveui, options) {
  const device = await db.get(
    `SELECT d.deveui, d.type_id, iz.zone_uuid
       FROM devices d LEFT JOIN irrigation_zones iz
         ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
      WHERE d.deveui = ? AND d.deleted_at IS NULL`,
    [deveui]
  );
  if (!device) throw httpError(404, 'device not found');
  if (WEATHER_TYPE_IDS.has(device.type_id)) {
    const scope = await resolveScope(db, userUuid, options);
    if (scope.disabled) throw httpError(403, 'account disabled');
    return scope;
  }
  if (!device.zone_uuid) throw httpError(404, 'device not found');
  return assertZoneAccess(db, userUuid, device.zone_uuid, options);
}

async function listScopeZoneUuids(db, userUuid, options) {
  const scope = await resolveScope(db, userUuid, options);
  if (scope.wildcard) return null;
  return [...scope.zoneUuids];
}

function _resetForTests() {
  cache.clear();
}

module.exports = {
  isScopedMode,
  verifyBearer,
  resolveScope,
  invalidateScope,
  assertZoneAccess,
  assertPlotAccess,
  assertFreshZoneAccess,
  assertFreshPlotAccess,
  assertRole,
  assertAuthenticatedRole,
  authorizeAdminRead,
  assertFreshRole,
  isAdmin,
  filterZoneUuids,
  resolveZoneUuidById,
  assertDeviceAccess,
  listScopeZoneUuids,
  _resetForTests,
};
