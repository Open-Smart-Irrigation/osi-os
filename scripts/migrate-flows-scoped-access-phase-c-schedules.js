#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);
const flows = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

function getNode(id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

function addLib(node, variable, moduleName) {
  node.libs = Array.isArray(node.libs) ? node.libs : [];
  if (!node.libs.some((lib) => lib.var === variable)) {
    node.libs.push({ var: variable, module: moduleName });
  }
}

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`missing ${label} anchor`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`ambiguous ${label} anchor`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

{
  const node = getNode('70fcbea336401bd1');
  node.func = replaceOnce(
    node.func,
    `msg.authUserId = auth.userId;
msg.authUsername = auth.username;
msg.topic =`,
    `msg.authUserId = auth.userId;
msg.authUsername = auth.username;
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  let scopeDb;
  try {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('schedule mutation: scope module unavailable: ' + scopeLoad.error, msg);
      const error = new Error('scope resolver unavailable');
      error.statusCode = 500;
      throw error;
    }
    const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);
    if (!Number.isInteger(zoneId)) {
      const error = new Error('Invalid zone ID');
      error.statusCode = 400;
      throw error;
    }
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
    if (actorScope.role === 'viewer') {
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
msg.topic =`,
    'schedule authenticated identity'
  );
  node.func = node.func.replace(
    /catch \(_\) \{\}/g,
    "catch (error) { node.warn('schedule auth secret: ' + String(error && error.message ? error.message : error)); }"
  );
  node.func = `return (async () => {
${node.func}
})();`;
  addLib(node, 'osiLib', 'osi-lib');
  addLib(node, 'osiDb', 'osi-db-helper');
}

{
  const node = getNode('22cc64fa2a899cea');
  node.func = node.func.replace(
    `                  AND iz.user_id = \${userId}
                  AND iz.deleted_at IS NULL`,
    `                  \${String(env.get('OSI_SCOPED_ACCESS') || '') === '1'
                    ? ''
                    : 'AND iz.user_id = ' + userId}
                  AND iz.deleted_at IS NULL`
  );
}

{
  const node = getNode('settings-disable-schedules-fn');
  addLib(node, 'osiLib', 'osi-lib');
  node.func = replaceOnce(
    node.func,
    `    db = new osiDb.Database('/data/db/farming.db');
    const disabledSchedules = await run(
      'UPDATE irrigation_schedules ' +
      'SET enabled = 0, sync_version = COALESCE(sync_version, 0) + 1, updated_at = ? ' +
      'WHERE COALESCE(enabled, 0) = 1 ' +
      'AND irrigation_zone_id IN (SELECT id FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL)',
      [now, auth.userId]
    );`,
    `    db = new osiDb.Database('/data/db/farming.db');
    let updateSql =
      'UPDATE irrigation_schedules ' +
      'SET enabled = 0, sync_version = COALESCE(sync_version, 0) + 1, updated_at = ? ' +
      'WHERE COALESCE(enabled, 0) = 1 ';
    let updateParams = [now];
    if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
      const scopeLoad = osiLib.require('scope');
      if (!scopeLoad.ok) {
        node.error('disable schedules: scope module unavailable: ' + scopeLoad.error, msg);
        const error = new Error('scope resolver unavailable');
        error.statusCode = 500;
        throw error;
      }
      const actor = await db.get(
        'SELECT user_uuid, role FROM users WHERE id = ? AND username = ? LIMIT 1',
        [auth.userId, auth.username]
      );
      if (!actor || !actor.user_uuid) {
        const error = new Error('Unauthorized');
        error.statusCode = 401;
        throw error;
      }
      const actorScope = await scopeLoad.value.assertFreshRole(
        db,
        actor.user_uuid,
        actor.role,
        { scopedMode: true }
      );
      if (actorScope.role === 'viewer') {
        const error = new Error('insufficient role');
        error.statusCode = 403;
        throw error;
      }
      if (actorScope.role !== 'admin') {
        const zoneUuids = Array.from(actorScope.zoneUuids);
        if (!zoneUuids.length) {
          updateSql += 'AND 1 = 0';
        } else {
          updateSql +=
            'AND irrigation_zone_id IN (' +
            'SELECT id FROM irrigation_zones WHERE deleted_at IS NULL ' +
            'AND zone_uuid IN (' + zoneUuids.map(function() { return '?'; }).join(',') + '))';
          updateParams = updateParams.concat(zoneUuids);
        }
      }
    } else {
      updateSql +=
        'AND irrigation_zone_id IN (' +
        'SELECT id FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL)';
      updateParams.push(auth.userId);
    }
    const disabledSchedules = await run(updateSql, updateParams);`,
    'disable schedules update'
  );
  node.func = node.func.replace(
    `    msg.statusCode = error && error.statusCode ? error.statusCode : 500;
    msg.payload = { message: error && error.message ? error.message : 'Failed to disable irrigation schedules' };`,
    `    msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
    msg.payload = {
      message: msg.statusCode === 403
        ? 'Forbidden'
        : (error && error.message ? error.message : 'Failed to disable irrigation schedules')
    };`
  );
  node.func = node.func.replace(
    /catch \(_\) \{/g,
    'catch (parseError) { node.warn(\'disable schedules token parse: \' + String(parseError && parseError.message ? parseError.message : parseError));'
  );
}

{
  const node = getNode('a0a61f4b7dca1c2e');
  node.func = replaceOnce(
    node.func,
    `    s.last_triggered_at,

    (`,
    `    s.last_triggered_at,
    (
      SELECT COUNT(DISTINCT u.id)
      FROM users u
      WHERE u.disabled_at IS NULL
        AND (
          u.id = iz.user_id
          OR u.user_uuid IN (
            SELECT uza.user_uuid
            FROM user_zone_assignments uza
            WHERE uza.zone_uuid = iz.zone_uuid
              AND uza.deleted_at IS NULL
          )
        )
    ) AS enabled_scope_holders,

    (`,
    'scheduler scope-holder projection'
  );
}

{
  const node = getNode('5f0d2b7e9b9b1b3a');
  node.func = replaceOnce(
    node.func,
    `if (!Number.isFinite(userId) || !Number.isFinite(zoneId)) {
  return null;
}
`,
    `if (!Number.isFinite(userId) || !Number.isFinite(zoneId)) {
  return null;
}
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1' &&
    Number(zone.enabled_scope_holders || 0) < 1) {
  node.warn('scheduler: zone ' + zoneId +
    ' lost all enabled scope holders; schedule disabled pending admin review');
  return [
    null,
    null,
    {
      topic:
        'UPDATE irrigation_schedules ' +
        'SET enabled = 0, sync_version = COALESCE(sync_version, 0) + 1, ' +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
        'WHERE irrigation_zone_id = ' + zoneId
    }
  ];
}
`,
    'scheduler identity validation'
  );
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
