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
  const node = getNode('83bb4a452dd9ae37');
  node.func = replaceOnce(
    node.func,
    `if (!deveui) {
  return respond(400, { message: 'Missing valve deveui' });
}
`,
    `if (!deveui) {
  return respond(400, { message: 'Missing valve deveui' });
}
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1') {
  let scopeDb;
  try {
    const scopeLoad = osiLib.require('scope');
    if (!scopeLoad.ok) {
      node.error('valve boundary: scope module unavailable: ' + scopeLoad.error, msg);
      const error = new Error('scope resolver unavailable');
      error.statusCode = 500;
      throw error;
    }
    scopeDb = new osiDb.Database('/data/db/farming.db');
    const actor = await scopeDb.get(
      'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',
      [auth.userId, auth.username]
    );
    if (!actor || !actor.user_uuid) {
      const error = new Error('Unauthorized');
      error.statusCode = 401;
      throw error;
    }
    const actorScope = await scopeLoad.value.assertFreshDeviceAccess(
      scopeDb,
      actor.user_uuid,
      deveui,
      { scopedMode: true }
    );
    if (actorScope.role === 'viewer') {
      const error = new Error('insufficient role');
      error.statusCode = 403;
      throw error;
    }
    msg.actor_user_uuid = actor.user_uuid;
  } catch (error) {
    const status = Number(error && (error.statusCode || error.status) || 500) || 500;
    return respond(status, {
      message: status === 404 ? 'device not found' :
        (status === 403 ? 'Forbidden' : String(error && error.message || error))
    });
  } finally {
    if (scopeDb) {
      try {
        await new Promise(function(resolve) { scopeDb.close(function() { resolve(); }); });
      } catch (error) {
        node.warn('valve boundary scope close: ' + String(error && error.message ? error.message : error));
      }
    }
  }
}
`,
    'valve deveui validation'
  );
  node.func = node.func.replace(
    /catch \(_\) \{\}/g,
    "catch (error) { node.warn('valve auth secret: ' + String(error && error.message ? error.message : error)); }"
  );
  node.func = `return (async () => {
${node.func}
})();`;
  addLib(node, 'osiLib', 'osi-lib');
  addLib(node, 'osiDb', 'osi-db-helper');
}

{
  const node = getNode('dde8e1ef265e96d7');
  node.func = node.func.replace(
    `if (device.user_id !== null && Number(device.user_id) !== userId) {`,
    `if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1' &&
    device.user_id !== null && Number(device.user_id) !== userId) {`
  );
  node.func = replaceOnce(
    node.func,
    `const actuatorMsg = { payload: cmd, _stregaExpectationCommand: { zone_id: zoneId, command_id: commandId, device_eui: deveui, action, duration_minutes: durationMinutes } };`,
    `const actuatorMsg = {
  payload: cmd,
  actor_user_uuid: msg.actor_user_uuid || null,
  _actorUserUuid: msg.actor_user_uuid || null,
  _stregaExpectationCommand: {
    zone_id: zoneId,
    command_id: commandId,
    device_eui: deveui,
    action,
    duration_minutes: durationMinutes
  }
};`,
    'manual actuator message'
  );
}

{
  const node = getNode('cancel-strega-actuation-fn');
  node.func = replaceOnce(
    node.func,
    `    try {
        const device = await db.get(`,
    `    try {
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
            if (actorScope.role === 'viewer') {
                const error = new Error('insufficient role');
                error.statusCode = 403;
                throw error;
            }
            msg.actor_user_uuid = actor.user_uuid;
        }
        const device = await db.get(`,
    'cancel transaction start'
  );
  node.func = node.func.replace(
    `        if (device.user_id !== null && device.user_id !== undefined && Number(device.user_id) !== auth.userId) {`,
    `        if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1' &&
            device.user_id !== null && device.user_id !== undefined &&
            Number(device.user_id) !== auth.userId) {`
  );
  addLib(node, 'osiLib', 'osi-lib');
}

{
  const node = getNode('write-strega-expectation');
  node.func = replaceOnce(
    node.func,
    `const __close = () => new Promise((res) => db.close(() => res()));
try {
    // Defensive read:`,
    `const __close = () => new Promise((res) => db.close(() => res()));
try {
    const actorUuid = String(msg._actorUserUuid || msg.actor_user_uuid || '').trim() || null;
    if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1' && actorUuid) {
        const scopeLoad = osiLib.require('scope');
        if (!scopeLoad.ok) {
            throw new Error('scope module unavailable at enqueue: ' + scopeLoad.error);
        }
        await scopeLoad.value.assertFreshDeviceAccess(
            db,
            actorUuid,
            deviceEui,
            { scopedMode: true }
        );
    }
    // Defensive read:`,
    'expectation transaction start'
  );
  node.func = replaceOnce(
    node.func,
    `    msg.expectation = {
        expectation_id: expectationId,
        volume_source: volumeSource,
        estimated_gross_liters: estimatedLiters
    };`,
    `    if (actorUuid && commandId) {
        await db.run(
            'INSERT INTO applied_commands ' +
            '(command_id, device_eui, command_type, effect_key, applied_at, result, originator) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(command_id) DO UPDATE SET originator = excluded.originator',
            [
                commandId,
                deviceEui,
                commandType,
                raw.effect_key || raw.effectKey || null,
                commandedAt,
                'APPLIED',
                actorUuid
            ]
        );
    }
    msg.expectation = {
        expectation_id: expectationId,
        volume_source: volumeSource,
        estimated_gross_liters: estimatedLiters
    };`,
    'expectation response'
  );
  node.func = node.func.replace(
    `    return msg;
});`,
    `    return null;
});`
  );
  addLib(node, 'osiLib', 'osi-lib');
}

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
