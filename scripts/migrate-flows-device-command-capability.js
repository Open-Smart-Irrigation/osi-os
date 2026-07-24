#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const flowPaths = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((entry) => path.join(repo, entry));
const sourceId = 'irrigation-config-command-apply-fn';
const targetId = 'device-command-apply-fn';
const legacyId = '934bf2bc19a8ce22';
const ackId = '9d5e3035c3d069c4';
const contracts = {
  [sourceId]: 'b1cdcf9212026ea7f1e00729bbf9ec560fc400a2387a790541b0d11887ca90ab',
  'al-link-build-req': '2d65911fb8a5dde5d890b41f382baee65b34ce3a95b37c48eef3d4ef342edfb3',
  'sync-bootstrap-build': 'fd510d8483e69ef371dce372073390a849f3111c34c6f3e31f4d4468261fd8b0',
  'sync-force-build': '3f0f337a2ff566eb04c12ebe8b849bbb265a0db967a831086a874aee139ec289',
  'put-dendro-auth-fn': '02ed4a419565a8fa3ad2d7a26e05e5462d937bd29de498d30f12f074e18ca432',
  'put-dendro-format': '286f32615d9da767a44747d9079587c7497ca9795b83dca439b71eac69f0f377',
  'put-temp-auth-fn': 'de09c3530c6a99b32920c6f243615533abcb1bfcab519b3f1cf5917a3bef1356',
  'put-temp-format': '0ee64db2a10f8c7ceea1b638c04f586f0b8712127c3cd5471d60360b3cf59179',
  'dendro-ref-tree-fn': '514ec322b2b2f5f200e9eb447b0ded22aeaa2be907c1be1f8cfb5852e5abd6da',
  'put-rain-gauge-auth-fn': 'e010a43e05d68464a70183e136f6c29693c5a9857fb56832cec500b5406b5a0b',
  'put-rain-gauge-resp-fn': 'dfcb8034fba4efd2b5f4c3ef31b82098813e3ea1aa058df957c016f0864cc4c2',
  'put-flow-meter-auth-fn': '160acdfcf1bbce657d4a9dd8ef777ab82e9d04226e16f27bbcc6e6dfc728e74a',
  'put-flow-meter-resp-fn': 'e0fbd662b19379a9d1867e9a2cc8e56fbfe6819516264bb222001706a22266e1',
  'put-chameleon-enabled-auth-fn': 'a62747a076ad71f5db8e552352e04166b99110df7c61cbe9efeb2329afec8616',
  'bf93cd55db0eb57f': '59eefc2eee0bfa4a0dbd6fc69a3c2486435a707bf8756c49263a5fc61a85a66c',
};
const capabilityBefore =
  "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1'];";
const capabilityAfter =
  "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1', 'device_desired_state_v1'];";

const functionSource = `return (async () => {
  let cmd;
  try {
    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});
  } catch (parseError) {
    node.error('Device command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);
    return [null, null];
  }
  const envelope = cmd._pendingCommandEnvelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    node.error('Device command has no protected delivery envelope', msg);
    return [null, null];
  }
  const commandType = String(envelope.commandType || '').trim().toUpperCase();
  const protectedTypes = new Set(['UPSERT_DEVICE', 'UNCLAIM_DEVICE']);
  const payload = envelope.payload && typeof envelope.payload === 'object'
    ? envelope.payload
    : {};
  const protectedShape = payload.effect_key != null
    || payload.effectKey != null
    || payload.base_sync_version != null
    || payload.baseSyncVersion != null
    || payload.device != null;
  if (!protectedTypes.has(commandType) || !protectedShape) return [msg, null];
  const dbLoad = osiLib.require('osi-db-helper');
  const helper = osiLib.require('device-commands');
  const scopeLoad = osiLib.require('scope');
  if (!dbLoad.ok || !helper.ok || !scopeLoad.ok) {
    const detail = [dbLoad, helper, scopeLoad]
      .filter(function(load) { return !load.ok; })
      .map(function(load) { return load.error; })
      .join('; ');
    node.error('Device command helpers unavailable: ' + detail, msg);
    return [null, null];
  }
  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();
  const db = new dbLoad.value.Database('/data/db/farming.db');
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  try {
    const result = await helper.value.applyDeviceCommand(db, envelope, {
      gateway_device_eui: gatewayEui,
      command_type_recognized: msg._commandTypeRecognized === true
    });
    if (!result.handled) return [msg, null];
    if (result.ack && result.ack.result === 'APPLIED' &&
        typeof scopeLoad.value.invalidateScope === 'function') {
      scopeLoad.value.invalidateScope();
    }
    return [null, {
      topic: 'devices/' + gatewayEui + '/command_ack',
      payload: JSON.stringify(result.ack),
      qos: 1
    }];
  } catch (error) {
    node.error('Device command apply failed closed: ' + String(error && error.message ? error.message : error), msg);
    return [null, null];
  } finally {
    try {
      await close();
    } catch (closeError) {
      node.warn('Device command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})();`;

function digest(node) {
  return crypto.createHash('sha256').update(JSON.stringify(node)).digest('hex');
}

function serialize(flows, trailingNewline) {
  return JSON.stringify(flows, null, 2) + (trailingNewline ? '\n' : '');
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${label}: seam missing`);
  assert.equal(
    source.indexOf(before, first + before.length),
    -1,
    `${label}: seam is ambiguous`
  );
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceFirst(source, before, after, label) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${label}: seam missing`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function cleanSecretCatches(source, label) {
  const seam = '      } catch (_) {}\n';
  source = replaceFirst(
    source,
    seam,
    `      } catch (error) {\n        node.warn('${label} auth secret read failed: ' + String(error && error.message ? error.message : error));\n      }\n`,
    `${label} secret read`
  );
  return replaceOnce(
    source,
    seam,
    `      } catch (error) {\n        node.warn('${label} auth secret write failed: ' + String(error && error.message ? error.message : error));\n      }\n`,
    `${label} secret write`
  );
}

function desiredNode(source) {
  return {
    id: targetId,
    type: 'function',
    z: source.z,
    name: 'Apply Device Command',
    func: functionSource,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [{ var: 'osiLib', module: 'osi-lib' }],
    x: 2400,
    y: 1100,
    wires: [[legacyId], [ackId]],
  };
}

function assertCurrent(byId, source, label) {
  assert.deepEqual(byId.get(targetId), desiredNode(source), `${label}: target drifted`);
  assert.deepEqual(source.wires, [[targetId], [ackId]], `${label}: source wiring drifted`);
  for (const id of ['al-link-build-req', 'sync-bootstrap-build', 'sync-force-build']) {
    assert.ok(
      byId.get(id).func.includes(capabilityAfter),
      `${label}: ${id} capability drifted`
    );
  }
  for (const id of [
    'put-dendro-format',
    'put-temp-format',
    'dendro-ref-tree-fn',
    'put-rain-gauge-resp-fn',
    'put-flow-meter-resp-fn',
    'put-chameleon-enabled-auth-fn',
    'bf93cd55db0eb57f',
  ]) {
    assert.ok(
      byId.get(id).func.includes('sync_version:'),
      `${label}: ${id} version response drifted`
    );
  }
}

function transform(raw, label) {
  const trailingNewline = raw.endsWith('\n');
  const flows = JSON.parse(raw);
  assert.equal(serialize(flows, trailingNewline), raw, `${label}: unstable JSON`);
  const byId = new Map(flows.map((node) => [node.id, node]));
  const source = byId.get(sourceId);
  assert.ok(source, `${label}: source node missing`);
  if (byId.has(targetId)) {
    assertCurrent(byId, source, label);
    return raw;
  }
  for (const [id, expected] of Object.entries(contracts)) {
    assert.equal(digest(byId.get(id)), expected, `${label}: ${id} preimage drifted`);
  }
  assert.deepEqual(source.wires, [[legacyId], [ackId]], `${label}: source wiring preimage drifted`);

  source.wires = [[targetId], [ackId]];
  const target = desiredNode(source);
  flows.splice(flows.indexOf(source) + 1, 0, target);
  byId.set(targetId, target);

  for (const id of ['al-link-build-req', 'sync-bootstrap-build', 'sync-force-build']) {
    const node = byId.get(id);
    node.func = replaceOnce(node.func, capabilityBefore, capabilityAfter, `${id} capability`);
  }

  for (const [authId, formatId, field, labelText] of [
    ['put-dendro-auth-fn', 'put-dendro-format', 'dendro_enabled', 'Dendrometer flag'],
    ['put-temp-auth-fn', 'put-temp-format', 'temp_enabled', 'Temperature flag'],
    ['put-rain-gauge-auth-fn', 'put-rain-gauge-resp-fn', 'rain_gauge_enabled', 'Rain-gauge flag'],
    ['put-flow-meter-auth-fn', 'put-flow-meter-resp-fn', 'flow_meter_enabled', 'Flow-meter flag'],
  ]) {
    const auth = byId.get(authId);
    auth.func = replaceOnce(
      auth.func,
      `AND user_id = \${auth.userId}\`;`,
      `AND user_id = \${auth.userId} RETURNING sync_version\`;`,
      `${authId} returning version`
    );
    auth.func = cleanSecretCatches(auth.func, labelText);
    const format = byId.get(formatId);
    format.func = replaceOnce(
      format.func,
      `msg.payload = { ${field}: msg._${field} };`,
      `const updated = Array.isArray(msg.payload) && msg.payload.length ? msg.payload[0] : {};\nmsg.payload = { ${field}: msg._${field}, sync_version: Number(updated.sync_version || 0) };`,
      `${formatId} version response`
    );
  }

  const reference = byId.get('dendro-ref-tree-fn');
  reference.func = replaceOnce(
    reference.func,
    `await exec("UPDATE devices SET is_reference_tree="+isRef+", sync_version = COALESCE(sync_version, 0) + 1 WHERE deveui='"+eui+"'");\nawait close(); return respond({success:true,deveui,is_reference_tree:isRef});`,
    `await exec("UPDATE devices SET is_reference_tree="+isRef+", sync_version = COALESCE(sync_version, 0) + 1 WHERE deveui='"+eui+"'");\nconst updated=await q("SELECT sync_version FROM devices WHERE deveui='"+eui+"' LIMIT 1");\nawait close(); return respond({success:true,deveui,is_reference_tree:isRef,sync_version:Number((updated[0]||{}).sync_version||0)});`,
    'reference-tree version response'
  );
  reference.func = replaceOnce(
    reference.func,
    `}catch(e){try{await close();}catch(_){} return respond({error:e.message},500);}`,
    `}catch(e){try{await close();}catch(closeError){node.warn('Reference-tree DB close failed: '+String(closeError&&closeError.message?closeError.message:closeError));} return respond({error:e.message},500);}`,
    'reference-tree close warning'
  );

  const chameleon = byId.get('put-chameleon-enabled-auth-fn');
  chameleon.func = cleanSecretCatches(chameleon.func, 'Chameleon flag');
  chameleon.func = replaceOnce(
    chameleon.func,
    `  const run = (sql) => new Promise((resolve, reject) => db.run(sql, function(error) { return error ? reject(error) : resolve(this && Number(this.changes || 0)); }));`,
    `  const run = (sql) => new Promise((resolve, reject) => db.run(sql, function(error) { return error ? reject(error) : resolve(this && Number(this.changes || 0)); }));\n  const q = (sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows || [])));`,
    'Chameleon flag query helper'
  );
  chameleon.func = replaceOnce(
    chameleon.func,
    `  await close();\n  if (!changes) return respond(404, { message: 'Device not found' });\n  return respond(200, { deveui, chameleon_enabled: enabled });`,
    `  if (!changes) { await close(); return respond(404, { message: 'Device not found' }); }\n  const updated = await q('SELECT sync_version FROM devices WHERE deveui = ' + s(deveui) + ' LIMIT 1');\n  await close();\n  return respond(200, { deveui, chameleon_enabled: enabled, sync_version: Number((updated[0] || {}).sync_version || 0) });`,
    'Chameleon flag version response'
  );
  chameleon.func = replaceOnce(
    chameleon.func,
    `  try { await close(); } catch (_) {}`,
    `  try { await close(); } catch (closeError) { node.warn('Chameleon flag DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError)); }`,
    'Chameleon flag close warning'
  );

  const depths = byId.get('bf93cd55db0eb57f');
  depths.func = replaceOnce(
    depths.func,
    `  const close = () => new Promise(res => db.close(() => res()));`,
    `  const q = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (error, rows) => error ? rej(error) : res(rows || [])));\n  const close = () => new Promise(res => db.close(() => res()));`,
    'Chameleon depth query helper'
  );
  depths.func = replaceOnce(
    depths.func,
    `    await run('COMMIT');\n    msg.payload = { ok: true };`,
    `    const updated = await q('SELECT sync_version FROM devices WHERE UPPER(deveui) = ? LIMIT 1', [deveui]);\n    await run('COMMIT');\n    msg.payload = { ok: true, sync_version: Number((updated[0] || {}).sync_version || 0) };`,
    'Chameleon depth version response'
  );
  depths.func = replaceOnce(
    depths.func,
    `    try { await run('ROLLBACK'); } catch (_) {}\n    try { await close(); } catch (_) {}`,
    `    try { await run('ROLLBACK'); } catch (rollbackError) { node.warn('Chameleon depth rollback failed: ' + String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError)); }\n    try { await close(); } catch (closeError) { node.warn('Chameleon depth DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError)); }`,
    'Chameleon depth cleanup warnings'
  );

  assertCurrent(byId, source, label);
  const next = serialize(flows, trailingNewline);
  assert.equal(transform(next, label), next, `${label}: not idempotent`);
  return next;
}

const before = flowPaths.map((file) => fs.readFileSync(file, 'utf8'));
assert.equal(before[0], before[1], 'maintained profiles differ before edit');
const after = flowPaths.map((file, index) =>
  transform(before[index], path.relative(repo, file))
);
assert.equal(after[0], after[1], 'maintained profiles differ after edit');
for (let index = 0; index < flowPaths.length; index += 1) {
  if (after[index] !== before[index]) fs.writeFileSync(flowPaths[index], after[index]);
}
process.stdout.write('migrate-flows-device-command-capability: OK\n');
