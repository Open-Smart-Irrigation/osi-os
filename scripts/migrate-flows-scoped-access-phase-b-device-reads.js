#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const flowPaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];

const bearerHelpers = String.raw`function scopedReadAuthSecret() {
  const configured = String(env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET') || '').trim();
  if (configured) return configured;
  const error = new Error('AUTH token secret is not configured');
  error.statusCode = 500;
  throw error;
}
function scopedReadBase64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function scopedReadVerifyBearer(header) {
  if (!header || !header.startsWith('Bearer ')) {
    const error = new Error('Unauthorized');
    error.statusCode = 401;
    throw error;
  }
  const parts = header.substring(7).trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const error = new Error('Invalid token');
    error.statusCode = 401;
    throw error;
  }
  const expected = scopedReadBase64Url(
    crypto.createHmac('sha256', scopedReadAuthSecret()).update(parts[0]).digest()
  );
  if (parts[1].length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) {
    const error = new Error('Invalid token');
    error.statusCode = 401;
    throw error;
  }
  let payload;
  try {
    let encoded = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    while (encoded.length % 4) encoded += '=';
    payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    const invalid = new Error('Invalid token');
    invalid.statusCode = 401;
    throw invalid;
  }
  const userId = Number(payload.userId);
  const username = String(payload.username || '').trim();
  if (!Number.isFinite(userId) || !username ||
      (payload.exp && Date.now() > Number(payload.exp))) {
    const error = new Error(payload.exp && Date.now() > Number(payload.exp)
      ? 'Token expired'
      : 'Invalid token');
    error.statusCode = 401;
    throw error;
  }
  return { userId, username };
}`;

function deviceAssertion({ dbName, userLookup, deveuiExpression, label }) {
  return String.raw`const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
if (scopedOn) {
  const scopeLoad = osiLib.require('scope');
  if (!scopeLoad.ok) {
    const error = new Error('scope resolver unavailable');
    error.statusCode = 500;
    node.error('${label}: scope module unavailable: ' + scopeLoad.error, msg);
    throw error;
  }
  const scopeUser = await ${dbName}.get(${userLookup.sql}, [${userLookup.param}]);
  await scopeLoad.value.assertDeviceAccess(
    ${dbName},
    scopeUser && scopeUser.user_uuid,
    ${deveuiExpression},
    { scopedMode: true }
  );
}`;
}

const historyAssertion = deviceAssertion({
  dbName: 'db',
  userLookup: {
    sql: "'SELECT user_uuid FROM users WHERE username = ?'",
    param: 'auth.username',
  },
  deveuiExpression: 'deveui',
  label: 'device-history',
});

const inlineAssertion = deviceAssertion({
  dbName: '_db',
  userLookup: {
    sql: "'SELECT user_uuid FROM users WHERE username = ?'",
    param: 'auth.username',
  },
  deveuiExpression: 'deveui',
  label: 'device-read',
});

const weatherAssignmentAssertion = deviceAssertion({
  dbName: 'db',
  userLookup: {
    sql: "'SELECT user_uuid FROM users WHERE id = ?'",
    param: 'auth.userId',
  },
  deveuiExpression: 'deveui',
  label: 'weather-zone-assignments',
});

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

function exposeTouchedCatches(node) {
  node.func = node.func.replace(
    /catch \(_\) \{\}/g,
    `catch (error) { node.warn('${node.id}: ' + (error && error.message ? error.message : error)); }`
  );
}

function migrateLegacyHistory(node) {
  node.func = replaceOnce(
    node.func,
    "    db = new osiDb.Database('/data/db/farming.db');",
    "    db = new osiDb.Database('/data/db/farming.db');\n" +
      historyAssertion.split('\n').map((line) => `    ${line}`).join('\n') +
      '\n    const historyUserId = scopedOn ? null : auth.userId;',
    `${node.id} scope assertion`
  );
  node.func = replaceOnce(
    node.func,
    'userId: auth.userId,',
    'userId: historyUserId,',
    `${node.id} owner filter`
  );
  addLib(node, { var: 'osiLib', module: 'osi-lib' });
  exposeTouchedCatches(node);
}

function todayLitersSource() {
  return String.raw`return (async () => {
${bearerHelpers}
  const deveui = String((msg.req && msg.req.params && msg.req.params.deveui) || '').trim().toUpperCase();
  if (!deveui) {
    msg.statusCode = 400;
    msg.payload = { message: 'deveui required' };
    return msg;
  }
  const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  const auth = scopedOn
    ? scopedReadVerifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization)
    : null;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise((resolve) => db.close(() => resolve()));
  try {
    if (scopedOn) {
      const scopeLoad = osiLib.require('scope');
      if (!scopeLoad.ok) {
        const error = new Error('scope resolver unavailable');
        error.statusCode = 500;
        node.error('today-liters: scope module unavailable: ' + scopeLoad.error, msg);
        throw error;
      }
      const user = await db.get(
        'SELECT user_uuid FROM users WHERE username = ?',
        [auth.username]
      );
      await scopeLoad.value.assertDeviceAccess(
        db,
        user && user.user_uuid,
        deveui,
        { scopedMode: true }
      );
    }
    const row = await db.get(
      ${'`'}SELECT
          SUM(estimated_gross_liters) AS total_liters,
          volume_source
       FROM valve_actuation_expectations
       WHERE UPPER(device_eui) = ?
         AND commanded_at >= ?
         AND reconciliation_state NOT IN ('CANCELLED')
       GROUP BY volume_source
       ORDER BY SUM(estimated_gross_liters) DESC
       LIMIT 1${'`'},
      [deveui, todayIso]
    );
    const liters = row && Number.isFinite(Number(row.total_liters))
      ? Math.round(Number(row.total_liters) * 10) / 10
      : null;
    msg.statusCode = 200;
    msg.payload = {
      liters,
      source: row ? String(row.volume_source || 'unknown') : 'none',
    };
    return msg;
  } finally {
    try {
      await close();
    } catch (error) {
      node.warn('today-liters db close failed: ' +
        (error && error.message ? error.message : error));
    }
  }
})().catch((error) => {
  const statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  if (statusCode >= 500) {
    node.error('today-liters query failed: ' +
      String(error && error.message ? error.message : error), msg);
  }
  msg.statusCode = statusCode;
  msg.payload = {
    message: statusCode >= 500
      ? 'Internal error'
      : String(error && error.message ? error.message : 'Request denied'),
  };
  return msg;
});`;
}

function sensorExportSource(original) {
  let source = `return (async () => {\n${bearerHelpers}\n${original}`;
  source = replaceOnce(
    source,
    'LEFT JOIN devices d\n  ON dd.deveui = d.deveui',
    'LEFT JOIN devices d\n  ON dd.deveui = d.deveui\nLEFT JOIN irrigation_zones iz\n  ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL',
    'sensor export zone join'
  );
  source = replaceOnce(
    source,
    'const params = [];\n',
    String.raw`const params = [];
const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
if (scopedOn) {
  const auth = scopedReadVerifyBearer(
    msg.req && msg.req.headers && msg.req.headers.authorization
  );
  const scopeLoad = osiLib.require('scope');
  if (!scopeLoad.ok) {
    const error = new Error('scope resolver unavailable');
    error.statusCode = 500;
    node.error('sensor-export: scope module unavailable: ' + scopeLoad.error, msg);
    throw error;
  }
  const db = new osiDb.Database('/data/db/farming.db');
  try {
    const user = await db.get(
      'SELECT user_uuid FROM users WHERE username = ?',
      [auth.username]
    );
    const scope = await scopeLoad.value.resolveScope(
      db,
      user && user.user_uuid,
      { scopedMode: true }
    );
    if (scope.disabled) {
      const error = new Error('account disabled');
      error.statusCode = 403;
      throw error;
    }
    const zoneUuids = Array.from(scope.zoneUuids || []);
    const placeholders = zoneUuids.map(() => '?').join(',');
    sql += placeholders
      ? " AND (iz.zone_uuid IN (" + placeholders +
        ") OR d.type_id IN ('SENSECAP_S2120','AQUASCOPE_LORAIN'))"
      : " AND d.type_id IN ('SENSECAP_S2120','AQUASCOPE_LORAIN')";
    params.push(...zoneUuids);
  } finally {
    try {
      await new Promise((resolve) => db.close(() => resolve()));
    } catch (error) {
      node.warn('sensor-export db close failed: ' +
        (error && error.message ? error.message : error));
    }
  }
}
`,
    'sensor export scope predicate'
  );
  source = replaceOnce(
    source,
    'return msg;',
    String.raw`return [msg, null];
})().catch((error) => {
  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;
  msg.headers = { 'Content-Type': 'application/json; charset=utf-8' };
  msg.payload = {
    message: msg.statusCode >= 500
      ? 'Unable to export sensor data'
      : String(error && error.message ? error.message : 'Request denied'),
  };
  return [null, msg];
});`,
    'sensor export async return'
  );
  return source;
}

function migrate(source) {
  const flows = JSON.parse(source);
  const byId = new Map(flows.map((node) => [node.id, node]));

  for (const id of ['dendro-history-fn', 'sensor-history-fn', 'rain-history-fn']) {
    const node = byId.get(id);
    if (!node || node.type !== 'function') throw new Error(`missing ${id}`);
    migrateLegacyHistory(node);
  }

  const daily = byId.get('dendro-daily-fn');
  daily.func = replaceOnce(
    daily.func,
    "const days=Math.min(Math.max(parseInt(msg.req.query.days)||7,1),90);",
    "const days=Math.min(Math.max(parseInt(msg.req.query.days)||7,1),90);\n" +
      inlineAssertion,
    'dendro-daily-fn scope assertion'
  );
  daily.func = replaceOnce(
    daily.func,
    '"WHERE d.deveui=\'"+deveui+"\' AND dv.user_id="+auth.userId+" ORDER BY d.date DESC LIMIT "+days',
    '"WHERE d.deveui=\'"+deveui+"\'"+(scopedOn ? "" : " AND dv.user_id="+auth.userId)+" ORDER BY d.date DESC LIMIT "+days',
    'dendro-daily-fn owner filter'
  );
  addLib(daily, { var: 'osiLib', module: 'osi-lib' });
  exposeTouchedCatches(daily);

  const raw = byId.get('dendro-raw-fn');
  raw.func = replaceOnce(
    raw.func,
    "const to = String((msg.req && msg.req.query && msg.req.query.to) || new Date().toISOString()).replace(/'/g, \"''\");",
    "const to = String((msg.req && msg.req.query && msg.req.query.to) || new Date().toISOString()).replace(/'/g, \"''\");\n" +
      inlineAssertion,
    'dendro-raw-fn scope assertion'
  );
  const ownerNeedle = "'    AND d.user_id=' + auth.userId,";
  const ownerReplacement = "(scopedOn ? '' : '    AND d.user_id=' + auth.userId),";
  if (raw.func.split(ownerNeedle).length - 1 !== 2) {
    throw new Error('dendro-raw-fn: expected exactly two reviewed owner filters');
  }
  raw.func = raw.func.split(ownerNeedle).join(ownerReplacement);
  addLib(raw, { var: 'osiLib', module: 'osi-lib' });
  exposeTouchedCatches(raw);

  const assignments = byId.get('s2120-zones-get-fn');
  assignments.func = replaceOnce(
    assignments.func,
    "  db = new osiDb.Database('/data/db/farming.db');",
    "  db = new osiDb.Database('/data/db/farming.db');\n" +
      weatherAssignmentAssertion.split('\n').map((line) => `  ${line}`).join('\n'),
    's2120-zones-get-fn scope assertion'
  );
  assignments.func = replaceOnce(
    assignments.func,
    "const dev = await q('SELECT deveui FROM devices WHERE deveui = ? AND user_id = ? AND deleted_at IS NULL', [deveui, auth.userId]);",
    "const dev = await q(\n" +
      "    scopedOn\n" +
      "      ? 'SELECT deveui FROM devices WHERE deveui = ? AND deleted_at IS NULL'\n" +
      "      : 'SELECT deveui FROM devices WHERE deveui = ? AND user_id = ? AND deleted_at IS NULL',\n" +
      "    scopedOn ? [deveui] : [deveui, auth.userId]\n" +
      '  );',
    's2120-zones-get-fn owner filter'
  );
  addLib(assignments, { var: 'osiLib', module: 'osi-lib' });
  exposeTouchedCatches(assignments);

  const today = byId.get('strega-today-liters-fn');
  today.func = todayLitersSource();
  addLib(today, { var: 'crypto', module: 'crypto' });
  addLib(today, { var: 'osiLib', module: 'osi-lib' });

  const sensorExport = byId.get('fn_build_sensor_sql_params');
  sensorExport.func = sensorExportSource(sensorExport.func);
  sensorExport.outputs = 2;
  sensorExport.wires = [['sqlite_query_sensordata'], ['httpresp_download_sensordata']];
  sensorExport.libs = [
    { var: 'crypto', module: 'crypto' },
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiLib', module: 'osi-lib' },
  ];

  const errorResponse = byId.get('device-api-http500');
  errorResponse.func = replaceOnce(
    errorResponse.func,
    "  'assign-device-auth',\n  'cancel-strega-actuation-fn',",
    "  'api-me-auth',\n  'assign-device-auth',\n  'cancel-strega-actuation-fn',",
    'device API auth source allowlist'
  );

  return JSON.stringify(flows, null, 2) + '\n';
}

const originals = flowPaths.map((flowPath) => fs.readFileSync(flowPath, 'utf8'));
if (originals[0] !== originals[1]) throw new Error('maintained flow profiles differ before migration');
const migrated = migrate(originals[0]);
for (const flowPath of flowPaths) fs.writeFileSync(flowPath, migrated);
console.log('Scoped device reads migrated in both maintained profiles.');
