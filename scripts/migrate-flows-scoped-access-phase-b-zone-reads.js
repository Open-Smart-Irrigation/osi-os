#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const flowPaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];

const scopeAssertion = String.raw`const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
if (scopedOn) {
  const scopeLoad = osiLib.require('scope');
  if (!scopeLoad.ok) {
    const error = new Error('scope resolver unavailable');
    error.statusCode = 500;
    node.error('zone-read: scope module unavailable: ' + scopeLoad.error, msg);
    throw error;
  }
  const user = await _db.get(
    'SELECT user_uuid FROM users WHERE username = ?',
    [auth.username]
  );
  const zoneUuid = await scopeLoad.value.resolveZoneUuidById(_db, zoneId);
  if (!zoneUuid) {
    const error = new Error('zone not found');
    error.statusCode = 404;
    throw error;
  }
  await scopeLoad.value.assertZoneAccess(
    _db,
    user && user.user_uuid,
    zoneUuid,
    { scopedMode: true }
  );
}`;

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first === -1 || source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`${label}: expected exactly one reviewed anchor`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function addLib(node, entry) {
  node.libs = node.libs || [];
  if (!node.libs.some((candidate) => candidate.var === entry.var)) node.libs.push(entry);
}

function migrate(source) {
  const flows = JSON.parse(source);
  const environment = flows.find((node) => node.id === 'zone-env-fn');
  const recommendations = flows.find((node) => node.id === 'dendro-zone-rec-fn');
  if (!environment || environment.type !== 'function' ||
      !recommendations || recommendations.type !== 'function') {
    throw new Error('reviewed zone read nodes are missing');
  }

  environment.func = replaceOnce(
    environment.func,
    "  await ensureSchema();",
    `  ${scopeAssertion.split('\n').join('\n  ')}\n\n  await ensureSchema();`,
    'zone-env-fn scope assertion'
  );
  environment.func = replaceOnce(
    environment.func,
    "'WHERE iz.id=' + zoneId + ' AND iz.user_id=' + auth.userId + ' AND iz.deleted_at IS NULL LIMIT 1'",
    "'WHERE iz.id=' + zoneId + (scopedOn ? '' : ' AND iz.user_id=' + auth.userId) + ' AND iz.deleted_at IS NULL LIMIT 1'",
    'zone-env-fn zone query'
  );
  environment.func = replaceOnce(
    environment.func,
    "'WHERE d.irrigation_zone_id=' + zoneId + ' AND d.user_id=' + auth.userId + ' AND d.deleted_at IS NULL ' +",
    "'WHERE d.irrigation_zone_id=' + zoneId + (scopedOn ? '' : ' AND d.user_id=' + auth.userId) + ' AND d.deleted_at IS NULL ' +",
    'zone-env-fn device query'
  );

  recommendations.func = replaceOnce(
    recommendations.func,
    "if(!Number.isFinite(zoneId)) return respond({error:'Invalid zone ID'},400);\nconst rows=await q(",
    "if(!Number.isFinite(zoneId)) return respond({error:'Invalid zone ID'},400);\n" +
      scopeAssertion + "\n" +
      'const rows=await q(',
    'dendro-zone-rec-fn scope assertion'
  );
  recommendations.func = replaceOnce(
    recommendations.func,
    "'WHERE zdr.zone_id='+zoneId+' AND iz.user_id='+auth.userId+' ORDER BY zdr.date DESC LIMIT '+days",
    "'WHERE zdr.zone_id='+zoneId+(scopedOn ? '' : ' AND iz.user_id='+auth.userId)+' ORDER BY zdr.date DESC LIMIT '+days",
    'dendro-zone-rec-fn zone query'
  );
  addLib(recommendations, { var: 'osiLib', module: 'osi-lib' });

  return JSON.stringify(flows, null, 2) + '\n';
}

const originals = flowPaths.map((flowPath) => fs.readFileSync(flowPath, 'utf8'));
if (originals[0] !== originals[1]) throw new Error('maintained flow profiles differ before migration');
const migrated = migrate(originals[0]);
for (const flowPath of flowPaths) fs.writeFileSync(flowPath, migrated);
console.log('Scoped zone-path reads migrated in both maintained profiles.');
