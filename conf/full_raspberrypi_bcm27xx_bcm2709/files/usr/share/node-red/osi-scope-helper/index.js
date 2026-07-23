'use strict';
// osi-scope-helper — scoped multi-user access resolution (AgroLink).
// Spec: docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md §4/§8.
// Scope = owned (integer users.id bindings) UNION granted (user_uuid rows).
// Read paths use a 30 s per-user cache; physical-effect paths use assertFresh*.
const CACHE_TTL_MS = 30000;
const cache = new Map(); // userUuid -> { at, scope }

function isScopedMode(envValue) {
  return String(envValue !== undefined ? envValue : process.env.OSI_SCOPED_ACCESS || '') === '1';
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function loadUser(db, userUuid) {
  if (!userUuid) throw httpError(500, 'resolveScope called without user_uuid');
  const row = await db.get(
    'SELECT id, username, role, disabled_at, user_uuid FROM users WHERE user_uuid = ?',
    [userUuid]
  );
  if (!row) throw httpError(403, 'unknown user');
  // Note: no separate row.user_uuid null-check here. The query is
  // `WHERE user_uuid = ?` bound to the already-validated non-null userUuid
  // argument above; SQLite's `NULL = 'x'` is never true, so any row this
  // query returns is guaranteed to already carry that matching user_uuid.
  // The "null user_uuid is a hard error" requirement is fully covered by
  // the argument-level guard, not by re-inspecting the returned row.
  return row;
}

async function loadScope(db, userUuid) {
  const user = await loadUser(db, userUuid);
  const scope = {
    role: user.role,
    username: user.username,
    disabled: !!user.disabled_at,
    wildcard: false,
    zoneUuids: new Set(),
    plotUuids: new Set(),
  };
  if (user.disabled_at) return scope; // disabled: scope stays empty, role still reported
  const ownedZones = await db.all(
    'SELECT zone_uuid FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL AND zone_uuid IS NOT NULL',
    [user.id]
  );
  for (const r of ownedZones) scope.zoneUuids.add(r.zone_uuid);
  const grantedZones = await db.all(
    'SELECT zone_uuid FROM user_zone_assignments WHERE user_uuid = ? AND deleted_at IS NULL',
    [userUuid]
  );
  for (const r of grantedZones) scope.zoneUuids.add(r.zone_uuid);
  const ownedPlots = await db.all(
    'SELECT plot_uuid FROM journal_plots WHERE owner_user_uuid = ? AND deleted_at IS NULL',
    [userUuid]
  );
  for (const r of ownedPlots) scope.plotUuids.add(r.plot_uuid);
  const grantedPlots = await db.all(
    'SELECT plot_uuid FROM user_plot_assignments WHERE user_uuid = ? AND deleted_at IS NULL',
    [userUuid]
  );
  for (const r of grantedPlots) scope.plotUuids.add(r.plot_uuid);
  return scope;
}

async function resolveScope(db, userUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) {
    return { role: 'admin', disabled: false, wildcard: true, zoneUuids: null, plotUuids: null };
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
  const set = kind === 'zone' ? scope.zoneUuids : scope.plotUuids;
  return set.has(uuid);
}

async function assertZoneAccess(db, userUuid, zoneUuid, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (!scopeAllows(scope, 'zone', zoneUuid)) throw httpError(404, 'zone not found');
  return scope;
}

async function assertPlotAccess(db, userUuid, plotUuid, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (!scopeAllows(scope, 'plot', plotUuid)) throw httpError(404, 'plot not found');
  return scope;
}

async function assertFreshZoneAccess(db, userUuid, zoneUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) return { role: 'admin', wildcard: true };
  const scope = await loadScope(db, userUuid); // no cache
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scopeAllows(scope, 'zone', zoneUuid)) throw httpError(404, 'zone not found');
  return scope;
}

async function assertFreshPlotAccess(db, userUuid, plotUuid, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) return { role: 'admin', wildcard: true };
  const scope = await loadScope(db, userUuid);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scopeAllows(scope, 'plot', plotUuid)) throw httpError(404, 'plot not found');
  return scope;
}

// Cached: resolveScope() may serve a role that is up to CACHE_TTL_MS (30s)
// stale, so a just-demoted admin keeps privileged access until the cache
// entry expires or is explicitly invalidated. Reads that can tolerate that
// staleness may keep using this. Privilege/system/account paths (e.g. a
// database download or any other admin-only action with an immediate
// real-world effect) must use assertFreshRole instead.
async function assertRole(db, userUuid, role, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scope.wildcard && scope.role !== role) throw httpError(403, 'insufficient role');
  return scope;
}

// Uncached variant of assertRole for privilege checks that must observe a
// demotion/disable immediately (mirrors assertFreshZoneAccess/assertFreshPlotAccess).
async function assertFreshRole(db, userUuid, role, { scopedMode } = {}) {
  if (!isScopedMode() && scopedMode !== true) return { role: 'admin', wildcard: true };
  const scope = await loadScope(db, userUuid); // no cache
  if (scope.disabled) throw httpError(403, 'account disabled');
  if (!scope.wildcard && scope.role !== role) throw httpError(403, 'insufficient role');
  return scope;
}

async function isAdmin(db, userUuid, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  return !scope.disabled && (scope.wildcard || scope.role === 'admin');
}

async function filterZoneUuids(db, userUuid, zoneUuids, opts) {
  const scope = await resolveScope(db, userUuid, opts);
  if (scope.wildcard) return zoneUuids;
  if (scope.disabled) return [];
  return zoneUuids.filter((z) => scope.zoneUuids.has(z));
}

function _resetForTests() { cache.clear(); }

module.exports = {
  isScopedMode, resolveScope, invalidateScope,
  assertZoneAccess, assertPlotAccess, assertFreshZoneAccess, assertFreshPlotAccess,
  assertRole, assertFreshRole, isAdmin, filterZoneUuids, _resetForTests,
};
