'use strict';
// Persistence and its continuations are separate from decision evaluation.
const { prepareDecodeToken, prepareZoneOwnership, prepareUpsert } = require('./preflight');
function decodeToken(msg, { preflight, ...deps } = {}) {
return (async () => {
  const prepared = preflight || prepareDecodeToken(msg, deps);
  if (Array.isArray(prepared)) return prepared;
  const { auth, scopeLoad, zoneId } = prepared;
  const { env, node, osiLib, crypto, osiDb, global, Date = globalThis.Date } = deps;
  if (prepared.scoped) {
    let scopeDb;
    try {
    scopeDb = new osiDb.Database('/data/db/farming.db');
    const actor = await scopeDb.get(
      'SELECT user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
      [auth.userId, auth.username]
    );
    if (!actor || !actor.user_uuid) {
      const error = new Error('Unauthorized');
      error.statusCode = 401;
      throw error;
    }
    const zoneUuid = await scopeLoad.value.resolveZoneUuidById(scopeDb, zoneId);
    if (!zoneUuid) {
      const error = new Error('zone not found');
      error.statusCode = 404;
      throw error;
    }
    const actorScope = await scopeLoad.value.assertFreshZoneAccess(
      scopeDb,
      actor.user_uuid,
      zoneUuid,
      { scopedMode: true }
    );
    if (!scopeLoad.value.canMutate(actorScope.role)) {
      const error = new Error('insufficient role');
      error.statusCode = 403;
      throw error;
    }
    msg.actor_user_uuid = actor.user_uuid;
  } catch (error) {
    msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.payload = {
      message: msg.statusCode === 404 ? 'zone not found' :
        (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))
    };
    return [null, msg];
  } finally {
    if (scopeDb) {
      try {
        await new Promise(function(resolve) { scopeDb.close(function() { resolve(); }); });
      } catch (error) {
        node.warn('schedule mutation scope close: ' + String(error && error.message ? error.message : error));
      }
    }
  }
}
msg.topic = `SELECT id FROM users WHERE id = ${auth.userId} AND username = '${auth.username.replace(/'/g, "''")}'`;
return [msg, null];

})();
}

function verifyZoneOwnership(msg, { preflight, ...deps } = {}) {
  const prepared = preflight || prepareZoneOwnership(msg);
  if (Array.isArray(prepared)) return prepared;
  const { userId, zoneId } = prepared;
  const { env } = deps;
  try {
  msg.topic = `SELECT iz.id, iz.zone_uuid, iz.gateway_device_eui,
                       s.sync_version AS schedule_sync_version,
                       s.last_applied_at,
                       s.deleted_at AS schedule_deleted_at
                FROM irrigation_zones iz
                LEFT JOIN irrigation_schedules s ON s.irrigation_zone_id = iz.id
                WHERE iz.id = ${zoneId}
                  ${String(env.get('OSI_SCOPED_ACCESS') || '') === '1'
                    ? ''
                    : 'AND iz.user_id = ' + userId}
                  AND iz.deleted_at IS NULL
                LIMIT 1`;
  return [msg, null];
} catch (err) {
  msg.statusCode = 500;
  msg.payload = { message: 'Schedule validation failed', error: String(err?.message || err) };
  return [null, msg];
}

}

function buildUpsert(msg, { preflight, ...deps } = {}) {

const prepared = preflight || prepareUpsert(msg);
if (Array.isArray(prepared)) return prepared;
const { zone, request } = prepared;
const { env, Date = globalThis.Date } = deps;
const patch = request.validatedPatch;
const zoneId = Number(request.zoneId);
const trigger_metric = String(patch.trigger_metric || '');
const threshold_kpa = Number(patch.threshold_kpa);
const duration_minutes = Number(patch.duration_minutes);
const enabledInt = Number(patch.enabled);
const responseMode = String(patch.response_mode || 'proportional');
const now = new Date().toISOString();
const nextScheduleSyncVersion = Number(zone.schedule_sync_version || 0) + 1;

msg.osi.applied = {
  zone_uuid: zone.zone_uuid || null,
  gateway_device_eui: zone.gateway_device_eui || String(env.get('DEVICE_EUI') || 'UNKNOWN').toUpperCase(),
  sync_version: nextScheduleSyncVersion,
  last_applied_at: zone.last_applied_at || null
};

msg.topic = `INSERT INTO irrigation_schedules
  (irrigation_zone_id, trigger_metric, threshold_kpa, duration_minutes, enabled, response_mode, sync_version, deleted_at, created_at, updated_at)
VALUES
  (${zoneId}, '${trigger_metric}', ${threshold_kpa}, ${duration_minutes}, ${enabledInt}, '${responseMode}', ${nextScheduleSyncVersion}, NULL, '${now}', '${now}')
ON CONFLICT(irrigation_zone_id) DO UPDATE SET
  trigger_metric = excluded.trigger_metric,
  threshold_kpa = excluded.threshold_kpa,
  duration_minutes = excluded.duration_minutes,
  enabled = excluded.enabled,
  response_mode = excluded.response_mode,
  deleted_at = NULL,
  sync_version = ${nextScheduleSyncVersion},
  updated_at = excluded.updated_at`;

msg.syncAck = Object.assign({}, msg.syncAck || {}, {
  aggregateType: 'SCHEDULE',
  aggregateKey: zone.zone_uuid || null,
  appliedSyncVersion: nextScheduleSyncVersion,
  result: 'SUCCESS'
});
return [msg, null];

}

module.exports = { decodeToken, verifyZoneOwnership, buildUpsert, prepareDecodeToken, prepareZoneOwnership, prepareUpsert };
