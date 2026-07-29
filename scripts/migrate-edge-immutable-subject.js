#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const canonicalPath = path.join(
  repoRoot,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const mirrorPath = path.join(
  repoRoot,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one reviewed anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

const original = fs.readFileSync(canonicalPath, 'utf8');
const flows = JSON.parse(original);
if (JSON.stringify(flows, null, 2) + '\n' !== original) {
  throw new Error('flows.json no-op parse/stringify changed bytes');
}
const byId = new Map(flows.map((node) => [node.id, node]));

const apiAuth = byId.get('api-me-auth');
const apiMe = byId.get('api-me-fn');
if (!apiAuth || !apiMe) throw new Error('/api/me nodes are missing');
if (apiAuth.func.includes('msg.username = auth.username;')) {
  apiAuth.func = replaceOnce(
    apiAuth.func,
    'msg.username = auth.username;',
    'msg.authUserId = auth.userId;\nmsg.authUsername = auth.username;',
    'api-me-auth subject preservation'
  );
}
if (apiMe.func.includes('const username = msg.username;')) {
  apiMe.func = replaceOnce(
    apiMe.func,
    "const username = msg.username;\nif (!username) { msg.statusCode = 401; msg.payload = { message: 'Unauthorized' }; return msg; }",
    "const userId = Number(msg.authUserId);\nconst username = String(msg.authUsername || '').trim();\nif (!Number.isSafeInteger(userId) || userId <= 0 || !username) { msg.statusCode = 401; msg.payload = { message: 'Unauthorized' }; return msg; }",
    'api-me-fn subject input'
  );
  apiMe.func = replaceOnce(
    apiMe.func,
    "'SELECT username, user_uuid, role, disabled_at FROM users WHERE username = ?', [username]",
    "'SELECT username, user_uuid, role, disabled_at FROM users WHERE id = ? AND username = ?', [userId, username]",
    'api-me-fn subject lookup'
  );
}

for (const id of [
  'fn_build_sensor_sql_params',
  'dendro-history-fn',
  'sensor-history-fn',
  'rain-history-fn',
  'dendro-daily-fn',
  'dendro-zone-rec-fn',
  'dendro-raw-fn',
  'zone-env-fn',
  'strega-today-liters-fn',
]) {
  const node = byId.get(id);
  if (!node) throw new Error(`${id} is missing`);
  if (node.func.includes('SELECT user_uuid FROM users WHERE username = ?')) {
    node.func = replaceOnce(
      node.func,
      'SELECT user_uuid FROM users WHERE username = ?',
      'SELECT user_uuid FROM users WHERE id = ? AND username = ?',
      `${id} subject lookup`
    );
    node.func = replaceOnce(
      node.func,
      '[auth.username]',
      '[auth.userId, auth.username]',
      `${id} subject parameters`
    );
  }
  if (node.func.includes(
    'SELECT user_uuid FROM users WHERE id = ? AND username = ?'
  ) && !node.func.includes("new Error('forbidden')")) {
    const lookupPattern = /const (scopeUser|user) = await ([A-Za-z_][A-Za-z0-9_]*)\.get\(\s*'SELECT user_uuid FROM users WHERE id = \? AND username = \?',\s*\[auth\.userId, auth\.username\]\s*\);/;
    const match = lookupPattern.exec(node.func);
    if (!match) throw new Error(`${id} subject guard anchor is missing`);
    const variable = match[1];
    node.func = node.func.replace(
      lookupPattern,
      match[0] + `\n  if (!${variable} || !${variable}.user_uuid) {\n` +
        "    const error = new Error('forbidden');\n" +
        '    error.statusCode = 403;\n' +
        '    throw error;\n' +
        '  }'
    );
    node.func = node.func.replace(
      `${variable} && ${variable}.user_uuid`,
      `${variable}.user_uuid`
    );
  }
}

const history = byId.get('history-api-router-fn');
if (!history) throw new Error('history-api-router-fn is missing');
if (history.func.includes(
  'SELECT user_uuid, disabled_at FROM users WHERE username = ?'
)) {
  history.func = replaceOnce(
    history.func,
    'SELECT user_uuid, disabled_at FROM users WHERE username = ?',
    'SELECT user_uuid, disabled_at FROM users WHERE id = ? AND username = ?',
    'history subject lookup'
  );
  history.func = replaceOnce(
    history.func,
    '[principal.username]',
    '[principal.userId, principal.username]',
    'history subject parameters'
  );
  history.func = replaceOnce(
    history.func,
    '{ username: auth.username, scoped: scopedOn }',
    '{ userId: auth.userId, username: auth.username, scoped: scopedOn }',
    'history principal'
  );
}

if (!apiAuth.func.includes('msg.authUserId = auth.userId;') ||
    !apiMe.func.includes('WHERE id = ? AND username = ?') ||
    [...byId.values()].some((node) =>
      typeof node.func === 'string' &&
      node.func.includes('SELECT user_uuid FROM users WHERE username = ?')) ||
    history.func.includes(
      'SELECT user_uuid, disabled_at FROM users WHERE username = ?'
    )) {
  throw new Error('immutable-subject migration did not reach the guarded shape');
}

const updated = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, updated);
fs.writeFileSync(mirrorPath, updated);
console.log('edge immutable-subject migration: OK');
