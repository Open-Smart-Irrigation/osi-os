#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CANONICAL = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const MIRROR = path.join(
  ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);

function fail(message) {
  throw new Error(`patch-sdi12-recipe-deployment: ${message}`);
}

function serialize(flows) {
  return Buffer.from(`${JSON.stringify(flows, null, 2)}\n`, 'utf8');
}

function loadCanonical(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (!Array.isArray(parsed)) fail(`${filePath} is not a flow array`);
  if (!original.equals(serialize(parsed))) {
    fail(`${filePath} is not JSON.stringify(parsed, null, 2) plus final newline`);
  }
  return { original, parsed };
}

function one(flows, id, type) {
  const matches = flows.filter((node) => node.id === id);
  if (matches.length !== 1) fail(`expected exactly one node ${id}, found ${matches.length}`);
  const node = matches[0];
  if (type && node.type !== type) fail(`${id} must be ${type}, found ${node.type}`);
  return node;
}

function same(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} drifted: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) fail(`${label}: expected source marker is missing`);
  if (source.indexOf(before, first + before.length) >= 0) {
    fail(`${label}: expected source marker is duplicated`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function preservePrefix(node, marker, replacement, label) {
  const first = node.func.indexOf(marker);
  if (first < 0 || node.func.indexOf(marker, first + marker.length) >= 0) {
    fail(`${label}: async-body marker drifted`);
  }
  node.func = node.func.slice(0, first) + replacement;
}

function tagVerifyBearer(node, sourceId) {
  if (node.func.includes('_osiAuthFailure')) {
    fail(`${sourceId}: auth failure tags already exist`);
  }
  const header = node.func.match(/function\s+verifyBearer\s*\([^)]*\)\s*\{/);
  if (!header) fail(`${sourceId}: verifyBearer function is missing`);
  const bodyStart = header.index + header[0].length;
  let bodyEnd = bodyStart;
  let depth = 1;
  for (; bodyEnd < node.func.length && depth > 0; bodyEnd += 1) {
    if (node.func[bodyEnd] === '{') depth += 1;
    else if (node.func[bodyEnd] === '}') depth -= 1;
  }
  if (depth !== 0) fail(`${sourceId}: verifyBearer braces are unbalanced`);
  const closingBrace = bodyEnd - 1;
  let body = node.func.slice(bodyStart, closingBrace);
  const codes = new Map([
    ['Unauthorized', 'MISSING_BEARER'],
    ['Invalid token', 'INVALID_TOKEN'],
    ['Token expired', 'TOKEN_EXPIRED'],
  ]);
  let tagged = 0;
  for (const [message, code] of codes) {
    const escaped = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `((?:var|const)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*new Error\\('${escaped}'\\);\\s*\\2\\.statusCode\\s*=\\s*401\\s*;\\s*)(throw\\s+\\2\\s*;)`,
      'g'
    );
    body = body.replace(pattern, (_whole, before, _variable, throwStatement) => {
      tagged += 1;
      return `${before}msg._osiAuthFailure = { format: 1, code: '${code}', sourceId: '${sourceId}' }; ${throwStatement}`;
    });
  }
  if (tagged !== 6) fail(`${sourceId}: expected six auth throw tags, found ${tagged}`);
  body = ` delete msg._osiAuthFailure;${body}`;
  node.func = node.func.slice(0, bodyStart) + body + node.func.slice(closingBrace);
}

function functionNode({ id, z, name, func, outputs, x, y, wires }) {
  return {
    id,
    type: 'function',
    z,
    name,
    func,
    outputs,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [
      { var: 'osiDb', module: 'osi-db-helper' },
      { var: 'osiLib', module: 'osi-lib' },
    ],
    x,
    y,
    wires,
  };
}

function deploymentAction(methodName, label) {
  return [
    'function boundedStatus(error) {',
    '  var status = Number(error && (error.statusCode || error.status) || 500) || 500;',
    '  return [400, 401, 403, 404, 409, 500].indexOf(status) >= 0 ? status : 500;',
    '}',
    'function boundedCode(error) {',
    "  var code = String(error && error.code || 'deployment_failed');",
    "  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'deployment_failed';",
    '}',
    'return (async () => {',
    '  var db = null;',
    '  var client = null;',
    '  try {',
    "    var commissioningLoad = osiLib.require('sdi12-commissioning');",
    "    var chirpstackLoad = osiLib.require('chirpstack');",
    '    if (!commissioningLoad.ok || !chirpstackLoad.ok) {',
    `      node.warn('${label}: required helper unavailable');`,
    "      throw Object.assign(new Error('deployment unavailable'), { statusCode: 500, code: 'deployment_unavailable' });",
    '    }',
    "    var deveui = String(msg.deviceRow && msg.deviceRow.deveui || '').trim().toUpperCase();",
    "    db = new osiDb.Database('/data/db/farming.db');",
    '    client = chirpstackLoad.value.createProvisioningClientFromEnv(env);',
    `    var result = await commissioningLoad.value.${methodName}(`,
    '      db, client, deveui, { now: new Date().toISOString() }',
    '    );',
    '    msg.statusCode = 202;',
    '    msg.payload = result && result.deployment ? result.deployment : null;',
    '    return msg;',
    '  } catch (error) {',
    '    msg.statusCode = boundedStatus(error);',
    "    msg.payload = { message: 'SDI-12 recipe deployment failed', code: boundedCode(error) };",
    '    return msg;',
    '  } finally {',
    '    if (client) {',
    '      try {',
    '        var closeErrors = client.close();',
    `        if (Array.isArray(closeErrors) && closeErrors.length) node.warn('${label}: ChirpStack close failed');`,
    '      } catch (closeError) {',
    `        node.warn('${label}: ChirpStack close failed');`,
    '      }',
    '    }',
    '    if (db) {',
    '      try {',
    '        await db.close();',
    '      } catch (closeError) {',
    `        node.warn('${label}: DB close failed');`,
    '      }',
    '    }',
    '  }',
    '})();',
  ].join('\n');
}

const canonical = loadCanonical(CANONICAL);
const mirror = loadCanonical(MIRROR);
if (!canonical.original.equals(mirror.original)) {
  fail('maintained flow profiles differ before mutation');
}
const flows = canonical.parsed;

const NEW_IDS = [
  'sdi12-recipe-apply-http',
  'sdi12-recipe-rollback-http',
  'sdi12-recipe-apply-action-fn',
  'sdi12-recipe-rollback-action-fn',
  'sdi12-recipe-poll-inject',
  'sdi12-recipe-poll-fn',
];
const JOURNAL_V2_TAIL_IDS = [
  'journal-v2-replication-tab',
  'journal-v2-replication-tick',
  'journal-v2-replication-worker',
  'journal-v2-replication-success-status',
  'journal-v2-replication-error-catch',
  'journal-v2-replication-error-status',
];
for (const id of NEW_IDS) {
  if (flows.some((node) => node.id === id)) {
    fail(`new node ${id} already exists; this one-shot patch has already been applied`);
  }
}
for (const url of [
  '/api/devices/:deveui/sdi12/recipe/apply',
  '/api/devices/:deveui/sdi12/recipe/rollback',
]) {
  if (flows.some((node) => node.type === 'http in' && node.url === url)) {
    fail(`route ${url} already exists`);
  }
}

const guard = one(flows, 'scoped-device-config-guard', 'function');
const configAuth = one(flows, 'sdi12-config-auth-fn', 'function');
const configAction = one(flows, 'sdi12-config-action-fn', 'function');
const identifyAction = one(flows, 'sdi12-identify-action-fn', 'function');
const identifyTrigger = one(flows, 'sdi12-identify-trigger-fn', 'function');
const identifyResponse = one(flows, 'sdi12-identify-fn', 'function');
const configQuery = one(flows, 'sdi12-config-query-fn', 'function');
const configSqlite = one(flows, 'sdi12-config-sqlite', 'sqlite');
const writer = one(flows, 'sdi12-write-fn', 'function');
const getDevices = one(flows, 'get-devices-query', 'function');
const mergeDevices = one(flows, 'merge-device-data', 'function');
const profilesScope = one(flows, 'sdi12-profiles-scope-fn', 'function');
const deviceApiHttp500 = one(flows, 'device-api-http500', 'function');

if (guard.outputs !== 26) fail('scoped-device-config-guard outputs must start at 26');
same(guard.wires.slice(23), [
  ['sdi12-identify-action-fn'],
  ['sdi12-config-auth-fn'],
  ['device-response'],
], 'scoped-device-config-guard tail wires');
if (configAuth.outputs !== 2) fail('sdi12-config-auth-fn outputs must start at 2');
same(configAuth.wires, [['sdi12-config-action-fn'], ['device-response']], 'sdi12 config auth wires');
same(configAction.wires, [['device-response']], 'sdi12 config action wires');
same(identifyAction.wires, [['sdi12-identify-trigger-link-out-http'], ['device-response']], 'identify action wires');
same(identifyTrigger.wires, [
  ['sdi12-identify-mqtt-adapter', 'sdi12-identify-http-success'],
  ['sdi12-identify-http-error'],
], 'identify trigger wires');
same(identifyResponse.wires, [['sdi12-debug']], 'identify response wires');
same(configQuery.wires, [['sdi12-config-sqlite']], 'config query wires');
same(configSqlite.wires, [['sdi12-write-fn']], 'config sqlite wires');
same(writer.wires, [['sdi12-debug'], ['sdi12-firstjoin-link-out']], 'writer wires');
same(getDevices.wires, [['get-devices-db'], ['device-response']], 'device-list query wires');
same(mergeDevices.wires, [['device-response']], 'device-list merge wires');
same(profilesScope.wires, [['sdi12-profiles-fn'], ['device-response']], 'profile-list auth wires');
same(deviceApiHttp500.wires, [['device-response']], 'device API error responder wires');
if (!identifyTrigger.func.includes('0x30, 0x49, 0x21')) {
  fail('identify trigger no longer has the expected pre-patch hardcoded frame');
}
if (!configAction.func.includes("UPDATE devices SET sdi12_probe_profile=?")) {
  fail('sdi12 config action pre-patch save body drifted');
}
if (configSqlite.sqlquery !== 'prepared'
  || configSqlite.sql !== 'SELECT sdi12_probe_profile, sdi12_probe_status, soil_moisture_probe_depths_json, chirpstack_app_id, sdi12_value_count, sdi12_channel_layout_json FROM devices WHERE deveui = $deveui') {
  fail('sdi12 config SQLite query drifted');
}
if (!profilesScope.func.includes("scope.verifyBearer(")
  || !profilesScope.func.includes("if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') return [msg, null];")) {
  fail('SDI-12 profile auth source drifted');
}
if (identifyAction.func.includes('_osiAuthFailure')
  || configAuth.func.includes('_osiAuthFailure')
  || profilesScope.func.includes('_osiAuthFailure')) {
  fail('SDI-12 auth sources unexpectedly already contain auth failure tags');
}
const authPrefixMarker = 'return (async () => {';
const authPrefixEnd = identifyAction.func.indexOf(authPrefixMarker);
if (authPrefixEnd < 0 || identifyAction.func.indexOf(authPrefixMarker, authPrefixEnd + 1) >= 0) {
  fail('SDI-12 Identify auth prefix marker drifted');
}
const authPrefix = identifyAction.func.slice(0, authPrefixEnd);

const oldRouteTable = 'const routeTable = [{"method":"PUT","suffix":"/dendro","index":0},{"method":"PUT","suffix":"/temp","index":1},{"method":"PUT","suffix":"/reference-tree","index":2},{"method":"PUT","suffix":"/lsn50/mode","index":3},{"method":"PUT","suffix":"/lsn50/interval","index":4},{"method":"PUT","suffix":"/kiwi/interval","index":5},{"method":"POST","suffix":"/kiwi/temperature-humidity/enable","index":6},{"method":"PUT","suffix":"/strega/interval","index":7},{"method":"PUT","suffix":"/lsn50/interrupt-mode","index":8},{"method":"PUT","suffix":"/lsn50/5v-warmup","index":9},{"method":"PUT","suffix":"/strega/model","index":10},{"method":"PUT","suffix":"/strega/timed-action","index":11},{"method":"PUT","suffix":"/strega/magnet","index":12},{"method":"PUT","suffix":"/strega/partial-opening","index":13},{"method":"PUT","suffix":"/strega/flushing","index":14},{"method":"PUT","suffix":"/rain-gauge","index":15},{"method":"PUT","suffix":"/flow-meter","index":16},{"method":"PUT","suffix":"/soil-moisture-depths","index":17},{"method":"PUT","suffix":"/chameleon","index":18},{"method":"PUT","suffix":"/dendro-config","index":19},{"method":"POST","suffix":"/dendro-baseline/reset","index":20},{"method":"POST","suffix":"/chameleon/refresh-calibration","index":21},{"method":"PUT","suffix":"/chameleon/depth","index":22},{"method":"POST","suffix":"/sdi12/identify","index":23},{"method":"PUT","suffix":"/sdi12/config","index":24}];';
const newRouteTable = 'const routeTable = [{"method":"PUT","suffix":"/dendro","index":0},{"method":"PUT","suffix":"/temp","index":1},{"method":"PUT","suffix":"/reference-tree","index":2},{"method":"PUT","suffix":"/lsn50/mode","index":3},{"method":"PUT","suffix":"/lsn50/interval","index":4},{"method":"PUT","suffix":"/kiwi/interval","index":5},{"method":"POST","suffix":"/kiwi/temperature-humidity/enable","index":6},{"method":"PUT","suffix":"/strega/interval","index":7},{"method":"PUT","suffix":"/lsn50/interrupt-mode","index":8},{"method":"PUT","suffix":"/lsn50/5v-warmup","index":9},{"method":"PUT","suffix":"/strega/model","index":10},{"method":"PUT","suffix":"/strega/timed-action","index":11},{"method":"PUT","suffix":"/strega/magnet","index":12},{"method":"PUT","suffix":"/strega/partial-opening","index":13},{"method":"PUT","suffix":"/strega/flushing","index":14},{"method":"PUT","suffix":"/rain-gauge","index":15},{"method":"PUT","suffix":"/flow-meter","index":16},{"method":"PUT","suffix":"/soil-moisture-depths","index":17},{"method":"PUT","suffix":"/chameleon","index":18},{"method":"PUT","suffix":"/dendro-config","index":19},{"method":"POST","suffix":"/dendro-baseline/reset","index":20},{"method":"POST","suffix":"/chameleon/refresh-calibration","index":21},{"method":"PUT","suffix":"/chameleon/depth","index":22},{"method":"POST","suffix":"/sdi12/identify","index":23},{"method":"PUT","suffix":"/sdi12/config","index":24},{"method":"POST","suffix":"/sdi12/recipe/apply","index":25},{"method":"POST","suffix":"/sdi12/recipe/rollback","index":26}];';
guard.func = replaceOnce(guard.func, oldRouteTable, newRouteTable, 'device config route table');
guard.func = replaceOnce(
  guard.func,
  "    node.error('device config scope: module unavailable: ' + scopeLoad.error, msg);",
  "    node.warn('device config scope: module unavailable');",
  'device config handled helper warning'
);
guard.outputs = 28;
guard.wires = [
  ...guard.wires.slice(0, 25),
  ['sdi12-config-auth-fn'],
  ['sdi12-config-auth-fn'],
  guard.wires[25],
];
deviceApiHttp500.func = replaceOnce(
  deviceApiHttp500.func,
  "  's2120-zones-put-auth-fn',\n  'sensor-history-fn',",
  [
    "  's2120-zones-put-auth-fn',",
    "  'sdi12-config-auth-fn',",
    "  'sdi12-identify-action-fn',",
    "  'sdi12-profiles-scope-fn',",
    "  'sensor-history-fn',",
  ].join('\n'),
  'device API SDI-12 auth allowlist'
);

preservePrefix(configAuth, 'return (async () => {', [
  'return (async () => {',
  '  var db = null;',
  "  var scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';",
  '  try {',
  '    var userId = null;',
  '    if (!scopedOn) {',
  '      var auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);',
  '      userId = auth.userId;',
  '    }',
  "    var deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();",
  '    if (!/^[0-9A-F]{16}$/.test(deveui)) {',
  '      msg.statusCode = 400;',
  "      msg.payload = { message: 'Invalid deveui' };",
  '      return [null, null, null, msg];',
  '    }',
  "    var method = String(msg.req && msg.req.method || '').toUpperCase();",
  "    var requestPath = String(msg.req && (msg.req.path || msg.req.url) || '').split('?')[0];",
  "    var routePrefix = '/api/devices/' + String(msg.req && msg.req.params && msg.req.params.deveui || '');",
  "    var suffix = requestPath.indexOf(routePrefix) === 0 ? requestPath.slice(routePrefix.length) : '';",
  '    var actionIndex = method === \'PUT\' && suffix === \'/sdi12/config\' ? 0 :',
  "      (method === 'POST' && suffix === '/sdi12/recipe/apply' ? 1 :",
  "        (method === 'POST' && suffix === '/sdi12/recipe/rollback' ? 2 : -1));",
  '    if (actionIndex < 0) {',
  '      msg.statusCode = 404;',
  "      msg.payload = { message: 'SDI-12 config route not found' };",
  '      return [null, null, null, msg];',
  '    }',
  '    var body = msg.req && msg.req.body;',
  '    var plainBody = body && typeof body === \'object\' && !Array.isArray(body);',
  '    var emptyBody = body == null || (plainBody && Object.keys(body).length === 0);',
  '    if ((actionIndex === 0 && (!plainBody || emptyBody)) || (actionIndex !== 0 && !emptyBody)) {',
  '      msg.statusCode = 400;',
  "      msg.payload = { message: actionIndex === 0 ? 'SDI-12 config body is required' : 'Apply and Rollback require an empty body' };",
  '      return [null, null, null, msg];',
  '    }',
  "    db = new osiDb.Database('/data/db/farming.db');",
  '    var row = userId === null',
  '      ? await db.get(',
  "        'SELECT deveui, type_id FROM devices WHERE deveui = ? AND deleted_at IS NULL LIMIT 1',",
  '        [deveui])',
  '      : await db.get(',
  "        'SELECT deveui, type_id FROM devices WHERE deveui = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1',",
  '        [deveui, userId]);',
  '    if (!row) {',
  '      msg.statusCode = 404;',
  "      msg.payload = { message: 'Device not found' };",
  '      return [null, null, null, msg];',
  '    }',
  "    if (String(row.type_id || '') !== 'DRAGINO_SDI12') {",
  '      msg.statusCode = 409;',
  "      msg.payload = { message: 'Device is not a DRAGINO_SDI12 soil node' };",
  '      return [null, null, null, msg];',
  '    }',
  "    msg.deviceRow = { deveui: String(row.deveui || '').toUpperCase() };",
  '    var outputs = [null, null, null, null];',
  '    outputs[actionIndex] = msg;',
  '    return outputs;',
  '  } catch (error) {',
  '    var rawStatus = Number(error && (error.statusCode || error.status) || 500) || 500;',
  '    msg.statusCode = [400, 401, 403, 404, 409, 500].indexOf(rawStatus) >= 0 ? rawStatus : 500;',
  "    msg.payload = { message: msg.statusCode >= 500 ? 'Unable to authorize SDI-12 request' : String(error && error.message ? error.message : error) };",
  '    return [null, null, null, msg];',
  '  } finally {',
  '    if (db) {',
  '      try {',
  '        await db.close();',
  '      } catch (closeError) {',
  "        node.warn('SDI12 config auth DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));",
  '      }',
  '    }',
  '  }',
  '})();',
].join('\n'), 'sdi12 config auth');
configAuth.outputs = 4;
configAuth.wires = [
  ['sdi12-config-action-fn'],
  ['sdi12-recipe-apply-action-fn'],
  ['sdi12-recipe-rollback-action-fn'],
  ['device-response'],
];

configAction.func = [
  'var body = msg.req.body || {};',
  "var normRes = osiLib.require('sdi12-normalize');",
  "if (!normRes.ok) { msg.statusCode = 500; msg.payload = { message: 'profile registry unavailable' }; return msg; }",
  "var profileId = String(body.probe_profile || '').trim();",
  'var profile = normRes.value.getProfile(profileId);',
  "if (!profile) { msg.statusCode = 400; msg.payload = { message: 'Unknown probe_profile' }; return msg; }",
  "var hasSensors = Object.prototype.hasOwnProperty.call(body, 'sensors');",
  "var hasAddress = Object.prototype.hasOwnProperty.call(body, 'address');",
  "var hasLegacyDepths = Object.prototype.hasOwnProperty.call(body, 'depths');",
  "var hasLegacyCount = Object.prototype.hasOwnProperty.call(body, 'value_count');",
  'if ((hasSensors || hasAddress) && (hasLegacyDepths || hasLegacyCount)) {',
  "  msg.statusCode = 400; msg.payload = { message: 'sensors/address cannot be combined with depths/value_count' }; return msg;",
  '}',
  "if ((hasSensors || hasAddress) && profileId !== 'SENTEK_ENVIROSCAN') {",
  "  msg.statusCode = 400; msg.payload = { message: 'channel layout is only supported for SENTEK_ENVIROSCAN' }; return msg;",
  '}',
  'var sentekLayout = null;',
  'if (hasSensors || hasAddress) {',
  "  if (!hasSensors || !hasAddress) { msg.statusCode = 400; msg.payload = { message: 'address and sensors are required together' }; return msg; }",
  '  sentekLayout = normRes.value.validateSentekLayout({ version: 1, address: body.address, sensors: body.sensors });',
  "  if (!sentekLayout.ok) { msg.statusCode = 400; msg.payload = { message: 'invalid Sentek layout: ' + sentekLayout.error }; return msg; }",
  '}',
  'var slotDepths = body.depths;',
  'var depthsByChannel = null;',
  'if (slotDepths !== undefined) {',
  "  if (typeof slotDepths !== 'object' || slotDepths === null || Array.isArray(slotDepths)) {",
  "    msg.statusCode = 400; msg.payload = { message: 'depths must be an object of depthSlot->cm' }; return msg;",
  '  }',
  '  var validSlots = {};',
  '  profile.values.forEach(function (v) { if (v.depthSlot) validSlots[v.depthSlot] = true; });',
  '  depthsByChannel = {};',
  '  for (var slot in slotDepths) {',
  '    if (!Object.prototype.hasOwnProperty.call(slotDepths, slot)) continue;',
  '    var cm = slotDepths[slot];',
  '    if (!validSlots[Number(slot)] || !Number.isFinite(cm) || cm < 0 || cm > 500) {',
  "      msg.statusCode = 400; msg.payload = { message: 'invalid depth entry for slot ' + slot }; return msg;",
  '    }',
  '    profile.values.forEach(function (v) { if (v.depthSlot === Number(slot)) depthsByChannel[v.channel] = cm; });',
  '  }',
  '}',
  'var valueCountInput = body.value_count;',
  'if (hasLegacyCount && valueCountInput !== null && (!Number.isInteger(valueCountInput) || valueCountInput < 1 || valueCountInput > 8)) {',
  "  msg.statusCode = 400; msg.payload = { message: 'value_count must be an integer between 1 and 8, or null' }; return msg;",
  '}',
  "var deveui = String(msg.deviceRow.deveui || '').toUpperCase();",
  'return (async () => {',
  "  var db = new osiDb.Database('/data/db/farming.db');",
  '  var transactionStarted = false;',
  '  try {',
  '    if (sentekLayout) {',
  "      var commissioningLoad = osiLib.require('sdi12-commissioning');",
  '      if (!commissioningLoad.ok) {',
  "        node.warn('sdi12 config: commissioning helper unavailable');",
  "        msg.statusCode = 500; msg.payload = { message: 'commissioning helper unavailable' }; return msg;",
  '      }',
  '      try {',
  '        var saved = await commissioningLoad.value.saveSentekLayout(db, {',
  '          deveui: deveui, profileId: profileId, layout: sentekLayout.layout, depths: sentekLayout.depths',
  '        });',
  '        msg.payload = {',
  '          probe_profile: saved.profileId, status: saved.status, layout: saved.layout, depths: saved.depths,',
  "          value_count: saved.valueCount, layout_status: 'configured', deployment_status: 'not_applied',",
  "          message: 'Layout saved; acquisition configuration not applied.'",
  '        };',
  '        return msg;',
  '      } catch (error) {',
  '        var helperStatus = Number(error && (error.statusCode || error.status) || 500) || 500;',
  '        msg.statusCode = [400, 404, 409, 500].indexOf(helperStatus) >= 0 ? helperStatus : 500;',
  "        var helperCode = String(error && error.code || 'layout_save_failed');",
  "        msg.payload = { message: 'Unable to save SDI-12 layout', code: /^[a-z0-9_]{1,64}$/.test(helperCode) ? helperCode : 'layout_save_failed' };",
  '        return msg;',
  '      }',
  '    }',
  "    await db.run('BEGIN IMMEDIATE');",
  '    transactionStarted = true;',
  '    var profileIsFixedShape = profile.expectedValues != null;',
  '    var resolvedValueCount;',
  '    if (profileIsFixedShape) resolvedValueCount = null;',
  '    else if (hasLegacyCount) resolvedValueCount = valueCountInput;',
  '    else {',
  "      var existingCount = await db.get('SELECT sdi12_value_count FROM devices WHERE deveui=?', [deveui]);",
  '      resolvedValueCount = existingCount ? existingCount.sdi12_value_count : null;',
  '    }',
  '    var existingDepths = {};',
  '    if (depthsByChannel === null) {',
  "      var existingDepthRow = await db.get('SELECT soil_moisture_probe_depths_json FROM devices WHERE deveui=?', [deveui]);",
  '      if (existingDepthRow && existingDepthRow.soil_moisture_probe_depths_json) {',
  '        try {',
  '          var parsedDepths = JSON.parse(existingDepthRow.soil_moisture_probe_depths_json);',
  "          if (parsedDepths && typeof parsedDepths === 'object' && !Array.isArray(parsedDepths)) existingDepths = parsedDepths;",
  "        } catch (error) { node.warn('sdi12 config: invalid stored depth map: ' + String(error && error.message ? error.message : error)); }",
  '      }',
  '      depthsByChannel = {};',
  '      profile.values.forEach(function (v) {',
  '        if (Object.prototype.hasOwnProperty.call(existingDepths, v.channel)) depthsByChannel[v.channel] = existingDepths[v.channel];',
  '      });',
  '    }',
  '    await db.run(',
  '      "UPDATE devices SET sdi12_probe_profile=?, sdi12_probe_status=\'manual\', sdi12_channel_layout_json=NULL, " +',
  '      "soil_moisture_probe_depths_json=?, soil_moisture_probe_depths_configured=?, sdi12_value_count=?, " +',
  '      "sync_version=COALESCE(sync_version,0)+1, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE deveui=?",',
  '      [profileId, JSON.stringify(depthsByChannel), Object.keys(depthsByChannel).length ? 1 : 0, resolvedValueCount, deveui]);',
  "    await db.run('COMMIT');",
  '    transactionStarted = false;',
  '    msg.payload = { probe_profile: profileId, status: \'manual\', depths: depthsByChannel, value_count: resolvedValueCount,',
  "      layout_status: profileId === 'SENTEK_ENVIROSCAN' ? 'legacy_count' : null };",
  '    return msg;',
  '  } catch (error) {',
  '    if (transactionStarted) {',
  "      try { await db.run('ROLLBACK'); } catch (rollbackError) { node.warn('sdi12 config rollback failed'); }",
  '    }',
  '    msg.statusCode = 500;',
  "    msg.payload = { message: 'Unable to save SDI-12 config' };",
  '    return msg;',
  '  } finally {',
  '    try { await db.close(); } catch (closeError) { node.warn(\'sdi12 config DB close failed: \' + String(closeError && closeError.message ? closeError.message : closeError)); }',
  '  }',
  '})();',
].join('\n');

preservePrefix(identifyAction, 'return (async () => {', [
  'return (async () => {',
  '  var db = null;',
  "  var scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';",
  '  try {',
  '    var userId = null;',
  '    if (!scopedOn) {',
  '      var auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);',
  '      userId = auth.userId;',
  '    }',
  "    var deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();",
  '    if (!/^[0-9A-F]{16}$/.test(deveui)) {',
  '      msg.statusCode = 400;',
  "      msg.payload = { message: 'Invalid deveui' };",
  '      return [null, msg];',
  '    }',
  "    db = new osiDb.Database('/data/db/farming.db');",
  '    var row = userId === null',
  '      ? await db.get(',
  "        'SELECT deveui, type_id, chirpstack_app_id, sdi12_channel_layout_json FROM devices WHERE deveui = ? AND deleted_at IS NULL LIMIT 1',",
  '        [deveui])',
  '      : await db.get(',
  "        'SELECT deveui, type_id, chirpstack_app_id, sdi12_channel_layout_json FROM devices WHERE deveui = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1',",
  '        [deveui, userId]);',
  '    if (!row) {',
  '      msg.statusCode = 404;',
  "      msg.payload = { message: 'Device not found' };",
  '      return [null, msg];',
  '    }',
  "    if (String(row.type_id || '') !== 'DRAGINO_SDI12') {",
  '      msg.statusCode = 409;',
  "      msg.payload = { message: 'Device is not a DRAGINO_SDI12 soil node' };",
  '      return [null, msg];',
  '    }',
  "    var chirpstackAppId = String(row.chirpstack_app_id || '').trim();",
  '    if (!chirpstackAppId) {',
  "      var fallbackAppId = String(env.get('CHIRPSTACK_APP_SENSORS') || '').trim();",
  '      if (fallbackAppId) {',
  "        await db.run('UPDATE devices SET chirpstack_app_id = ? WHERE deveui = ?', [fallbackAppId, deveui]);",
  '        chirpstackAppId = fallbackAppId;',
  '      }',
  '    }',
  "    var rawLayout = row.sdi12_channel_layout_json == null ? '' : String(row.sdi12_channel_layout_json);",
  '    var identifyPlan;',
  '    if (!rawLayout.trim()) {',
  "      identifyPlan = { stage: 'discovering', command: '?!', discoveredAddress: null, preserveAttempt: false };",
  '    } else {',
  "      var normalizeLoad = osiLib.require('sdi12-normalize');",
  '      if (!normalizeLoad.ok) {',
  "        node.warn('SDI12 identify: normalizer unavailable');",
  "        throw Object.assign(new Error('identify unavailable'), { statusCode: 500 });",
  '      }',
  '      var validated = normalizeLoad.value.validateSentekLayout(rawLayout);',
  '      if (!validated.ok) {',
  "        msg.statusCode = 409; msg.payload = { message: 'Saved SDI-12 layout is malformed' }; return [null, msg];",
  '      }',
  "      identifyPlan = { stage: 'identifying', command: validated.layout.address + 'I!', discoveredAddress: null, preserveAttempt: false };",
  '    }',
  '    msg.deviceRow = {',
  "      deveui: String(row.deveui || '').toUpperCase(),",
  '      chirpstack_app_id: chirpstackAppId',
  '    };',
  '    msg.sdi12Identify = identifyPlan;',
  '    msg._sdi12_identify_http = true;',
  '    return [msg, null];',
  '  } catch (error) {',
  '    var rawStatus = Number(error && (error.statusCode || error.status) || 500) || 500;',
  '    msg.statusCode = [400, 401, 403, 404, 409, 500].indexOf(rawStatus) >= 0 ? rawStatus : 500;',
  "    msg.payload = { message: msg.statusCode >= 500 ? 'Unable to start SDI-12 Identify' : String(error && error.message ? error.message : error) };",
  '    return [null, msg];',
  '  } finally {',
  '    if (db) {',
  '      try {',
  '        await db.close();',
  '      } catch (closeError) {',
  "        node.warn('SDI12 identify auth DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));",
  '      }',
  '    }',
  '  }',
  '})();',
].join('\n'), 'sdi12 identify action');

profilesScope.func = authPrefix + [
  'return (async () => {',
  '  var db = null;',
  '  try {',
  '    var auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);',
  "    var scopeLoad = osiLib.require('scope');",
  '    if (!scopeLoad.ok) {',
  "      node.warn('sdi12 profiles: scope module unavailable');",
  "      throw Object.assign(new Error('scope resolver unavailable'), { statusCode: 500 });",
  '    }',
  "    db = new osiDb.Database('/data/db/farming.db');",
  '    var user = await db.get(',
  "      'SELECT user_uuid FROM users WHERE id = ? AND username = ? LIMIT 1',",
  '      [auth.userId, auth.username]',
  '    );',
  '    if (!user || !user.user_uuid) {',
  "      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });",
  '    }',
  '    await scopeLoad.value.assertEnabledAccount(db, user.user_uuid, { scopedMode: true });',
  '    return [msg, null];',
  '  } catch (error) {',
  '    var rawStatus = Number(error && (error.statusCode || error.status) || 500) || 500;',
  '    msg.statusCode = [401, 403, 500].indexOf(rawStatus) >= 0 ? rawStatus : 500;',
  "    msg.payload = { message: msg.statusCode >= 500 ? 'Unable to authorize SDI-12 profiles' : (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message ? error.message : error)) };",
  '    return [null, msg];',
  '  } finally {',
  '    if (db) {',
  '      try {',
  '        await db.close();',
  '      } catch (closeError) {',
  "        node.warn('sdi12 profiles DB close failed');",
  '      }',
  '    }',
  '  }',
  '})();',
].join('\n');
profilesScope.libs = [
  { var: 'crypto', module: 'crypto' },
  { var: 'osiLib', module: 'osi-lib' },
  { var: 'osiDb', module: 'osi-db-helper' },
];

tagVerifyBearer(configAuth, 'sdi12-config-auth-fn');
tagVerifyBearer(identifyAction, 'sdi12-identify-action-fn');
tagVerifyBearer(profilesScope, 'sdi12-profiles-scope-fn');

identifyTrigger.func = [
  'var inputRow = msg.deviceRow || {};',
  "var inputDevEui = String(inputRow.deveui || '').trim().toUpperCase();",
  'return (async () => {',
  '  var db = null;',
  '  try {',
  '    if (!/^[0-9A-F]{16}$/.test(inputDevEui)) {',
  "      throw Object.assign(new Error('invalid device identity'), { statusCode: 409 });",
  '    }',
  "    var normalizeLoad = osiLib.require('sdi12-normalize');",
  "    var recipeLoad = osiLib.require('sdi12-recipe');",
  '    if (!normalizeLoad.ok || !recipeLoad.ok) {',
  "      node.error('SDI12 identify trigger: helper unavailable', msg);",
  "      throw Object.assign(new Error('identify unavailable'), { statusCode: 500 });",
  '    }',
  "    db = new osiDb.Database('/data/db/farming.db');",
  '    var stored = await db.get(',
  "      'SELECT type_id, chirpstack_app_id, sdi12_channel_layout_json FROM devices WHERE deveui = ? AND deleted_at IS NULL LIMIT 1',",
  '      [inputDevEui]',
  '    );',
  "    if (!stored || stored.type_id !== 'DRAGINO_SDI12') {",
  "      throw Object.assign(new Error('device is not available for Identify'), { statusCode: 409 });",
  '    }',
  "    var appId = String(stored.chirpstack_app_id || inputRow.chirpstack_app_id || '').trim();",
  '    if (!appId) {',
  "      throw Object.assign(new Error('device is missing ChirpStack registration data; cannot identify'), { statusCode: 409 });",
  '    }',
  '    var plan = msg.sdi12Identify || null;',
  "    var rawLayout = stored.sdi12_channel_layout_json == null ? '' : String(stored.sdi12_channel_layout_json);",
  '    if (!plan) {',
  '      if (!rawLayout.trim()) {',
  "        plan = { stage: 'discovering', command: '?!', discoveredAddress: null, preserveAttempt: false };",
  '      } else {',
  '        var automaticLayout = normalizeLoad.value.validateSentekLayout(rawLayout);',
  '        if (!automaticLayout.ok) {',
  "          throw Object.assign(new Error('Saved SDI-12 layout is malformed'), { statusCode: 409 });",
  '        }',
  "        plan = { stage: 'identifying', command: automaticLayout.layout.address + 'I!', discoveredAddress: null, preserveAttempt: false };",
  '      }',
  '    }',
  "    var discoveredAddress = plan.discoveredAddress == null ? null : String(plan.discoveredAddress);",
  "    if ((plan.stage !== 'discovering' && plan.stage !== 'identifying')",
  "      || (plan.stage === 'discovering' && (plan.command !== '?!' || discoveredAddress !== null))",
  "      || (plan.stage === 'identifying' && !/^[0-9A-Za-z]I!$/.test(String(plan.command || '')))",
  '      || (discoveredAddress !== null && !/^[0-9A-Za-z]$/.test(discoveredAddress))) {',
  "      throw Object.assign(new Error('invalid Identify plan'), { statusCode: 409 });",
  '    }',
  '    if (plan.stage === \'discovering\' && rawLayout.trim()) {',
  "      throw Object.assign(new Error('saved layout changed before discovery'), { statusCode: 409 });",
  '    }',
  '    if (plan.stage === \'identifying\' && discoveredAddress === null) {',
  '      var currentLayout = normalizeLoad.value.validateSentekLayout(rawLayout);',
  "      if (!currentLayout.ok || plan.command !== currentLayout.layout.address + 'I!') {",
  "        throw Object.assign(new Error('saved layout changed before Identify'), { statusCode: 409 });",
  '      }',
  '    }',
  '    if (plan.preserveAttempt) {',
  '      var attempt = await db.get(',
  "        'SELECT stage, discovered_address FROM sdi12_identify_attempts WHERE deveui = ?',",
  '        [inputDevEui]',
  '      );',
  '      if (!attempt || attempt.stage !== \'identifying\' || attempt.discovered_address !== discoveredAddress) {',
  "        throw Object.assign(new Error('Identify attempt changed before downlink'), { statusCode: 409 });",
  '      }',
  '    }',
  '    var rawBytes;',
  '    try {',
  '      rawBytes = recipeLoad.value.encodeIdentifyFrame(String(plan.command || \'\'));',
  '    } catch (error) {',
  "      throw Object.assign(new Error('invalid Identify command'), { statusCode: 409 });",
  '    }',
  '    var now = new Date().toISOString();',
  '    await db.transaction(async function(tx) {',
  '      if (!plan.preserveAttempt) {',
  '        await tx.run(',
  "          'INSERT INTO sdi12_identify_attempts (deveui, stage, discovered_address, requested_at, updated_at) ' +",
  "            'VALUES (?, ?, ?, ?, ?) ON CONFLICT(deveui) DO UPDATE SET stage = excluded.stage, ' +",
  "            'discovered_address = excluded.discovered_address, requested_at = excluded.requested_at, updated_at = excluded.updated_at',",
  '          [inputDevEui, plan.stage, discoveredAddress, now, now]',
  '        );',
  '      }',
  '      await tx.run(',
  "        'UPDATE devices SET sdi12_probe_status = ?, updated_at = ? WHERE deveui = ?',",
  "        ['pending_identify', now, inputDevEui]",
  '      );',
  '    });',
  '    msg.sdi12Identify = plan;',
  '    msg.downlink = {',
  "      topic: 'application/' + appId + '/device/' + inputDevEui.toLowerCase() + '/command/down',",
  '      payload: {',
  '        devEui: inputDevEui.toLowerCase(), confirmed: false, fPort: 2, data: rawBytes.toString(\'base64\')',
  '      }',
  '    };',
  '    return [msg, null];',
  '  } catch (error) {',
  '    var rawStatus = Number(error && (error.statusCode || error.status) || 500) || 500;',
  '    msg.statusCode = [400, 404, 409, 500].indexOf(rawStatus) >= 0 ? rawStatus : 500;',
  "    msg.payload = { message: msg.statusCode >= 500 ? 'Unable to enqueue SDI-12 Identify' : String(error && error.message ? error.message : error) };",
  '    return [null, msg];',
  '  } finally {',
  '    if (db) {',
  "      try { await db.close(); } catch (closeError) { node.warn('SDI12 identify trigger DB close failed'); }",
  '    }',
  '  }',
  '})();',
].join('\n');

identifyResponse.func = [
  'var info = msg.sdi12;',
  'if (!info) return [null, null];',
  "var normalizeLoad = osiLib.require('sdi12-normalize');",
  "if (!normalizeLoad.ok) { node.error('SDI12 identify response: normalizer unavailable', msg); return [null, null]; }",
  "var response = String((info.decoded && info.decoded.datas_sum) || '').trim();",
  'return (async () => {',
  "  var db = new osiDb.Database('/data/db/farming.db');",
  '  try {',
  '    var row = await db.get(',
  "      'SELECT ia.stage, ia.discovered_address, d.chirpstack_app_id, d.sdi12_channel_layout_json ' +",
  "        'FROM sdi12_identify_attempts ia INNER JOIN devices d ON d.deveui = ia.deveui WHERE ia.deveui = ?',",
  "      [String(info.deveui || '').trim().toUpperCase()]",
  '    );',
  '    if (!row) {',
  "      node.warn('sdi12 identify: response without a current attempt');",
  '      return [msg, null];',
  '    }',
  "    var observedAt = new Date(info.recordedAt || Date.now()).toISOString();",
  "    var deveui = String(info.deveui || '').trim().toUpperCase();",
  "    if (row.stage === 'discovering') {",
  '      if (!/^[0-9A-Za-z]$/.test(response)) {',
  "        node.warn('sdi12 discovery: expected exactly one address for ' + deveui);",
  "        node.status({ fill: 'yellow', shape: 'ring', text: deveui + ' discovery rejected' });",
  '        return [msg, null];',
  '      }',
  '      var advanced = await db.transaction(async function(tx) {',
  '        var current = await tx.get(',
  "          'SELECT ia.stage, d.sdi12_channel_layout_json FROM sdi12_identify_attempts ia ' +",
  "            'INNER JOIN devices d ON d.deveui = ia.deveui WHERE ia.deveui = ?',",
  '          [deveui]',
  '        );',
  "        if (!current || current.stage !== 'discovering' || (current.sdi12_channel_layout_json != null && String(current.sdi12_channel_layout_json).trim())) return false;",
  '        await tx.run(',
  "          'UPDATE sdi12_identify_attempts SET stage = ?, discovered_address = ?, updated_at = ? WHERE deveui = ? AND stage = ?',",
  "          ['identifying', response, observedAt, deveui, 'discovering']",
  '        );',
  "        var changed = await tx.get('SELECT changes() AS count', []);",
  '        return Number(changed && changed.count || 0) === 1;',
  '      });',
  '      if (!advanced) {',
  "        node.warn('sdi12 discovery: attempt changed before address persistence for ' + deveui);",
  '        return [msg, null];',
  '      }',
  "      msg.deviceRow = { deveui: deveui, chirpstack_app_id: String(row.chirpstack_app_id || '').trim() };",
  '      msg.sdi12Identify = {',
  "        stage: 'identifying', command: response + 'I!', discoveredAddress: response, preserveAttempt: true",
  '      };',
  "      node.status({ fill: 'blue', shape: 'dot', text: deveui + ' address ' + response });",
  '      return [null, msg];',
  '    }',
  '    var hit = normalizeLoad.value.matchProfile(response);',
  '    await db.transaction(async function(tx) {',
  '      if (hit) {',
  '        await tx.run(',
  "          'UPDATE devices SET sdi12_probe_profile = ?, sdi12_probe_status = ?, sdi12_identity = ?, ' +",
  "            'sync_version = COALESCE(sync_version, ?) + ?, updated_at = ? WHERE deveui = ? AND sdi12_probe_status = ?',",
  "          [hit.profileId, 'identified', response, 0, 1, observedAt, deveui, 'pending_identify']",
  '        );',
  '      } else {',
  '        await tx.run(',
  "          'UPDATE devices SET sdi12_probe_status = ?, sdi12_identity = ?, updated_at = ? ' +",
  "            'WHERE deveui = ? AND sdi12_probe_status = ?',",
  "          ['unmatched', response, observedAt, deveui, 'pending_identify']",
  '        );',
  '      }',
  "      await tx.run('UPDATE sdi12_identify_attempts SET updated_at = ? WHERE deveui = ? AND stage = ?', [observedAt, deveui, 'identifying']);",
  '    });',
  '    if (hit) {',
  "      node.status({ fill: 'green', shape: 'dot', text: deveui + ' -> ' + hit.profileId });",
  '    } else {',
  "      node.warn('sdi12 identify: no profile match for ' + deveui);",
  "      node.status({ fill: 'yellow', shape: 'dot', text: deveui + ' unmatched' });",
  '    }',
  '    return [msg, null];',
  '  } catch (error) {',
  "    node.error('SDI12 identify response failed: ' + String(error && error.message ? error.message : error), msg);",
  '    return [null, null];',
  '  } finally {',
  "    try { await db.close(); } catch (closeError) { node.warn('SDI12 identify response DB close failed'); }",
  '  }',
  '})();',
].join('\n');
identifyResponse.outputs = 2;
identifyResponse.wires = [['sdi12-debug'], ['sdi12-identify-trigger-fn']];

configQuery.func = [
  "msg.params = { $deveui: String(msg.sdi12.deveui || '').toUpperCase() };",
  'return msg;',
].join('\n');
configSqlite.sql = [
  'SELECT d.sdi12_probe_profile, d.sdi12_probe_status, d.soil_moisture_probe_depths_json,',
  '  d.chirpstack_app_id, d.sdi12_value_count, d.sdi12_channel_layout_json,',
  '  r.status AS sdi12_deployment_status,',
  '  r.queue_drained_at AS sdi12_deployment_queue_drained_at,',
  '  r.last_observed_at AS sdi12_deployment_last_observed_at',
  'FROM devices d',
  'LEFT JOIN sdi12_recipe_deployments r ON r.deveui = d.deveui',
  'WHERE d.deveui = $deveui',
].join('\n');

writer.func = [
  'var info = msg.sdi12;',
  'if (!info) return null;',
  'var row = Array.isArray(msg.payload) && msg.payload.length ? msg.payload[0] : {};',
  '',
  'function reportFailure(stage) {',
  '  var codes = {',
  "    normalizer_load: 'NORMALIZER_LOAD_FAILED', writer_load: 'WRITER_LOAD_FAILED',",
  "    manifest_load: 'MANIFEST_LOAD_FAILED', normalize_run: 'NORMALIZE_RUN_FAILED',",
  "    db_open: 'DB_OPEN_FAILED', writer_run: 'WRITER_RUN_FAILED', db_close: 'DB_CLOSE_FAILED'",
  '  };',
  '  if (!Object.prototype.hasOwnProperty.call(codes, stage)) throw new Error(\'sdi12 write: unknown failure stage \' + stage);',
  "  node.error('SDI12 write failed [' + stage + '] code=' + codes[stage], msg);",
  "  node.status({ fill: 'red', shape: 'dot', text: 'SDI12 ' + codes[stage] });",
  '  return [null, null];',
  '}',
  'function shouldObserve() {',
  "  return (row.sdi12_deployment_status === 'queued' || row.sdi12_deployment_status === 'observed_once')",
  '    && Boolean(row.sdi12_deployment_queue_drained_at);',
  '}',
  'function boundedObservationCode(error) {',
  "  var code = String(error && error.code || 'unknown');",
  "  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unknown';",
  '}',
  'return (async () => {',
  "  var normRes = osiLib.require('sdi12-normalize');",
  "  if (!normRes.ok) return reportFailure('normalizer_load');",
  "  var writerRes = osiLib.require('device-writer');",
  "  if (!writerRes.ok) return reportFailure('writer_load');",
  "  var commissioningRes = osiLib.require('sdi12-commissioning');",
  '  async function observeBestEffort(db, normalization, outcome, observedAt) {',
  '    if (!shouldObserve()) return;',
  '    if (!commissioningRes.ok) {',
  "      node.warn('SDI12 recipe observation failed code=helper_unavailable');",
  '      return;',
  '    }',
  '    try {',
  '      await commissioningRes.value.observeAcquisition(db, {',
  '        deveui: info.deveui, observedAt: observedAt, profileId: row.sdi12_probe_profile || null,',
  '        layout: row.sdi12_channel_layout_json, normalization: normalization, outcome: outcome',
  '      });',
  '    } catch (error) {',
  "      node.warn('SDI12 recipe observation failed code=' + boundedObservationCode(error));",
  '    }',
  '  }',
  '  if (info.quarantineOnly) {',
  '    var qdb = null;',
  '    var quarantineWritten = false;',
  '    var quarantineNow = Date.now();',
  '    var quarantineObservedAt = info.recordedAt || new Date(quarantineNow).toISOString();',
  '    if (typeof writerRes.value.clampRecordedAt === \'function\') {',
  '      quarantineObservedAt = writerRes.value.clampRecordedAt(info.recordedAt, quarantineNow).recordedAt;',
  '    }',
  '    try {',
  "      qdb = new osiDb.Database('/data/db/farming.db');",
  '      await writerRes.value.quarantineOnly(qdb, info.deveui, info.quarantineOnly.channel, info.quarantineOnly.raw);',
  '      quarantineWritten = true;',
  "      node.status({ fill: 'yellow', shape: 'ring', text: 'SDI12 segments incomplete ' + info.deveui });",
  '    } catch (error) {',
  "      reportFailure(qdb ? 'writer_run' : 'db_open');",
  '    } finally {',
  '      if (qdb) {',
  '        await observeBestEffort(qdb, null, {',
  '          inserted: false,',
  "          deadLettered: quarantineWritten ? [{ channel: info.quarantineOnly.channel, reason: 'unknown_channel' }] : null,",
  '          quarantined: true, writeFailed: !quarantineWritten',
  '        }, quarantineObservedAt);',
  "        try { await qdb.close(); } catch (closeError) { reportFailure('db_close'); }",
  '      }',
  '    }',
  '    return [null, null];',
  '  }',
  "  var fs = global.get('fs');",
  '  var edgeManifest;',
  '  try {',
  "    edgeManifest = JSON.parse(fs.readFileSync('/srv/node-red/edge-channels.json', 'utf8'));",
  '  } catch (error) {',
  "    return reportFailure('manifest_load');",
  '  }',
  '  var result;',
  '  try {',
  '    result = normRes.value.normalize(',
  '      info.decoded,',
  '      { probeProfile: row.sdi12_probe_profile || null, sdi12ValueCount: row.sdi12_value_count, sdi12ChannelLayout: row.sdi12_channel_layout_json },',
  '      { recordedAt: info.recordedAt }',
  '    );',
  '  } catch (error) {',
  "    return reportFailure('normalize_run');",
  '  }',
  '  if (result.noResponse) node.warn(\'sdi12 \' + info.deveui + \': probe returned NULL (no response)\');',
  '  var db = null;',
  '  try {',
  "    db = new osiDb.Database('/data/db/farming.db');",
  '  } catch (error) {',
  "    return reportFailure('db_open');",
  '  }',
  '  var writerFailed = false;',
  '  var writeResult = null;',
  '  var writeNow = Date.now();',
  '  var observedAt = result.recordedAt || info.recordedAt || new Date(writeNow).toISOString();',
  '  if (typeof writerRes.value.clampRecordedAt === \'function\') {',
  '    observedAt = writerRes.value.clampRecordedAt(result.recordedAt || info.recordedAt, writeNow).recordedAt;',
  '  }',
  '  try {',
  '    writeResult = await writerRes.value.writeDeviceData(',
  '      db, edgeManifest, result, { deveui: info.deveui }, { node: node, msg: msg, nowMs: writeNow });',
  '    if (writeResult.deadLettered.length > 0) {',
  "      var warnDevice = String(info.deveui || '').trim().toUpperCase() || 'UNKNOWN';",
  "      var warnKey = 'sdi12-dead-letter-warn:' + warnDevice;",
  '      var nowMs = Date.now();',
  '      var lastWarnAt = Number(context.get(warnKey) || 0);',
  '      if (!Number.isFinite(lastWarnAt) || lastWarnAt <= 0 || nowMs - lastWarnAt >= 10 * 60 * 1000) {',
  '        context.set(warnKey, nowMs);',
  "        node.warn('sdi12 dead-lettered ' + writeResult.deadLettered.length + ' channels for ' + info.deveui);",
  '      }',
  "      node.status({ fill: 'yellow', shape: 'dot', text: info.deveui + ' cols=' + writeResult.columns.length + ' dead=' + writeResult.deadLettered.length });",
  '    } else {',
  "      node.status({ fill: 'green', shape: 'dot', text: info.deveui + ' cols=' + writeResult.columns.length });",
  '    }',
  '    msg.payload = writeResult;',
  '  } catch (error) {',
  '    writerFailed = true;',
  "    reportFailure('writer_run');",
  '  }',
  '  await observeBestEffort(db, result, {',
  '    inserted: Boolean(writeResult && writeResult.inserted === true),',
  '    deadLettered: writeResult ? writeResult.deadLettered : null,',
  '    quarantined: writeResult ? writeResult.deadLettered.length > 0 : Object.keys(result.unknown || {}).length > 0,',
  '    writeFailed: writerFailed',
  '  }, observedAt);',
  '  try {',
  '    await db.close();',
  '  } catch (closeError) {',
  "    reportFailure('db_close');",
  '  }',
  '  var firstJoinMsg = null;',
  '  if (!writerFailed && !row.sdi12_probe_status) {',
  "    var firstJoinAppId = String(row.chirpstack_app_id || '').trim();",
  '    if (firstJoinAppId) {',
  "      firstJoinMsg = { deviceRow: { deveui: String(info.deveui || '').toUpperCase(), chirpstack_app_id: firstJoinAppId } };",
  '    }',
  '  }',
  '  return writerFailed ? [null, null] : [msg, firstJoinMsg];',
  '})();',
].join('\n');

getDevices.func = replaceOnce(
  getDevices.func,
  "  let whereClause = 'd.user_id = ' + userId;",
  "  let whereClause = 'd.user_id = $userId';\n  let queryParams = [userId];",
  'device-list owner predicate'
);
getDevices.func = replaceOnce(
  getDevices.func,
  "      whereClause = '(d.user_id IS NOT NULL OR d.irrigation_zone_id IS NOT NULL)';",
  "      whereClause = '(d.user_id IS NOT NULL OR d.irrigation_zone_id IS NOT NULL)';\n      queryParams = [];",
  'device-list scoped predicate'
);
getDevices.func = replaceOnce(
  getDevices.func,
  '    "  (SELECT vae.expected_close_at FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN (\'PENDING_OBSERVATION\',\'OBSERVED_RUNNING\') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_expected_close_at",',
  [
    '    "  (SELECT vae.expected_close_at FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) = UPPER(d.deveui) AND vae.reconciliation_state IN (\'PENDING_OBSERVATION\',\'OBSERVED_RUNNING\') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_valve_expected_close_at,",',
    "    '  rd.desired_version AS sdi12_deployment_desired_version,',",
    "    '  rd.desired_layout_hash AS sdi12_deployment_desired_layout_hash,',",
    "    '  rd.desired_recipe_json AS sdi12_deployment_desired_recipe_json,',",
    "    '  rd.status AS sdi12_deployment_status,',",
    "    '  rd.queued_at AS sdi12_deployment_queued_at,',",
    "    '  rd.queue_drained_at AS sdi12_deployment_queue_drained_at,',",
    "    '  rd.commissioning_deadline_at AS sdi12_deployment_commissioning_deadline_at,',",
    "    '  rd.last_observed_at AS sdi12_deployment_last_observed_at,',",
    "    '  rd.last_error_code AS sdi12_deployment_last_error_code,',",
    "    '  rd.compatible_recipe_json AS sdi12_deployment_compatible_recipe_json,',",
    "    '  rd.compatible_layout_json AS sdi12_deployment_compatible_layout_json,',",
    "    '  rd.compatible_at AS sdi12_deployment_compatible_at,',",
    "    '  rd.updated_at AS sdi12_deployment_updated_at,',",
    "    '  ia.discovered_address AS sdi12_identify_discovered_address',",
  ].join('\n'),
  'device-list deployment select'
);
getDevices.func = replaceOnce(
  getDevices.func,
  "    'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL',",
  [
    "    'LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL',",
    "    'LEFT JOIN sdi12_recipe_deployments rd ON rd.deveui = d.deveui',",
    "    'LEFT JOIN sdi12_identify_attempts ia ON ia.deveui = d.deveui',",
  ].join('\n'),
  'device-list deployment joins'
);
getDevices.func = replaceOnce(
  getDevices.func,
  "  return [msg, null];\n})();",
  "  msg.payload = queryParams;\n  return [msg, null];\n})();",
  'device-list bound params'
);

if (!(mergeDevices.libs || []).some((lib) => lib.var === 'osiDb' && lib.module === 'osi-db-helper')) {
  fail('merge-device-data lost its osiDb binding');
}
if ((mergeDevices.libs || []).some((lib) => lib.var === 'osiLib')) {
  fail('merge-device-data unexpectedly already binds osiLib');
}
mergeDevices.libs.push({ var: 'osiLib', module: 'osi-lib' });
mergeDevices.func = replaceOnce(
  mergeDevices.func,
  'const sensorData = msg.payload || [];',
  [
    'const sensorData = msg.payload || [];',
    "const deploymentLoad = osiLib.require('sdi12-commissioning');",
    "if (!deploymentLoad.ok) node.warn('merge-device-data: commissioning projection unavailable');",
  ].join('\n'),
  'device-list commissioning helper'
);
mergeDevices.func = replaceOnce(
  mergeDevices.func,
  "  } catch (_) {\n    return null;\n  }",
  "  } catch (error) {\n    node.warn('merge-device-data: invalid stored JSON object');\n    return null;\n  }",
  'device-list JSON parse warning'
);
mergeDevices.func = replaceOnce(
  mergeDevices.func,
  '  return {\n    deveui: devEui,',
  '  const device = {\n    deveui: devEui,',
  'device-list response object'
);
mergeDevices.func = replaceOnce(
  mergeDevices.func,
  "    deleted_at: d.deleted_at || null\n  };\n});",
  [
    "    deleted_at: d.deleted_at || null",
    '  };',
    "  if (device.type_id === 'DRAGINO_SDI12') {",
    '    const deploymentRow = d.sdi12_deployment_status == null ? null : {',
    '      desired_version: d.sdi12_deployment_desired_version,',
    '      desired_layout_hash: d.sdi12_deployment_desired_layout_hash,',
    '      desired_recipe_json: d.sdi12_deployment_desired_recipe_json,',
    '      status: d.sdi12_deployment_status,',
    '      queued_at: d.sdi12_deployment_queued_at,',
    '      queue_drained_at: d.sdi12_deployment_queue_drained_at,',
    '      commissioning_deadline_at: d.sdi12_deployment_commissioning_deadline_at,',
    '      last_observed_at: d.sdi12_deployment_last_observed_at,',
    '      last_error_code: d.sdi12_deployment_last_error_code,',
    '      compatible_recipe_json: d.sdi12_deployment_compatible_recipe_json,',
    '      compatible_layout_json: d.sdi12_deployment_compatible_layout_json,',
    '      compatible_at: d.sdi12_deployment_compatible_at,',
    '      updated_at: d.sdi12_deployment_updated_at',
    '    };',
    '    device.sdi12_recipe_deployment = deploymentLoad.ok',
    '      ? deploymentLoad.value.projectDeployment(deploymentRow)',
    '      : null;',
    "    const discovered = String(d.sdi12_identify_discovered_address || '');",
    '    device.sdi12_discovered_address = /^[0-9A-Za-z]$/.test(discovered) ? discovered : null;',
    '  }',
    '  return device;',
    '});',
  ].join('\n'),
  'device-list bounded recipe projection'
);
mergeDevices.func = replaceOnce(
  mergeDevices.func,
  '    try { await new Promise(res => _dbS2120.close(() => res())); } catch(_) {}',
  "    try { await new Promise(res => _dbS2120.close(() => res())); } catch (closeError) { node.warn('merge-device-data: S2120 DB close failed'); }",
  'device-list S2120 close warning'
);

const applyHttp = {
  id: 'sdi12-recipe-apply-http',
  type: 'http in',
  z: 'device-api-tab',
  name: 'POST /api/devices/:deveui/sdi12/recipe/apply',
  url: '/api/devices/:deveui/sdi12/recipe/apply',
  method: 'post',
  upload: false,
  swaggerDoc: '',
  x: 170,
  y: 2400,
  wires: [['scoped-device-config-guard']],
};
const rollbackHttp = {
  id: 'sdi12-recipe-rollback-http',
  type: 'http in',
  z: 'device-api-tab',
  name: 'POST /api/devices/:deveui/sdi12/recipe/rollback',
  url: '/api/devices/:deveui/sdi12/recipe/rollback',
  method: 'post',
  upload: false,
  swaggerDoc: '',
  x: 180,
  y: 2480,
  wires: [['scoped-device-config-guard']],
};
const applyAction = functionNode({
  id: 'sdi12-recipe-apply-action-fn',
  z: 'device-api-tab',
  name: 'Apply SDI-12 Recipe',
  func: deploymentAction('applyDesiredRecipe', 'SDI12 recipe apply'),
  outputs: 1,
  x: 960,
  y: 2400,
  wires: [['device-response']],
});
const rollbackAction = functionNode({
  id: 'sdi12-recipe-rollback-action-fn',
  z: 'device-api-tab',
  name: 'Rollback SDI-12 Recipe',
  func: deploymentAction('rollbackCompatibleRecipe', 'SDI12 recipe rollback'),
  outputs: 1,
  x: 970,
  y: 2480,
  wires: [['device-response']],
});
const pollInject = {
  id: 'sdi12-recipe-poll-inject',
  type: 'inject',
  z: 'sdi12-tab',
  name: 'SDI-12 Recipe Poll (60s)',
  props: [{ p: 'payload' }],
  repeat: '60',
  crontab: '',
  once: true,
  onceDelay: 15,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 190,
  y: 400,
  wires: [['sdi12-recipe-poll-fn']],
};
const pollFunction = functionNode({
  id: 'sdi12-recipe-poll-fn',
  z: 'sdi12-tab',
  name: 'Poll SDI-12 Recipe Deployments',
  outputs: 1,
  x: 470,
  y: 400,
  wires: [[]],
  func: [
    'return (async () => {',
    '  var db = null;',
    '  var client = null;',
    '  try {',
    "    var commissioningLoad = osiLib.require('sdi12-commissioning');",
    "    var chirpstackLoad = osiLib.require('chirpstack');",
    '    if (!commissioningLoad.ok || !chirpstackLoad.ok) {',
    "      node.warn('SDI12 recipe poll failed code=helper_unavailable');",
    '      return null;',
    '    }',
    "    db = new osiDb.Database('/data/db/farming.db');",
    '    client = chirpstackLoad.value.createProvisioningClientFromEnv(env);',
    '    await commissioningLoad.value.pollDeployments(db, client, { now: new Date().toISOString() });',
    '  } catch (error) {',
    "    var code = String(error && error.code || 'unknown');",
    "    node.warn('SDI12 recipe poll failed code=' + (/^[a-z0-9_]{1,64}$/.test(code) ? code : 'unknown'));",
    '  } finally {',
    '    if (client) {',
    '      try {',
    '        var closeErrors = client.close();',
    "        if (Array.isArray(closeErrors) && closeErrors.length) node.warn('SDI12 recipe poll client close failed');",
    '      } catch (closeError) {',
    "        node.warn('SDI12 recipe poll client close failed');",
    '      }',
    '    }',
    '    if (db) {',
    "      try { await db.close(); } catch (closeError) { node.warn('SDI12 recipe poll DB close failed'); }",
    '    }',
    '  }',
    '  return null;',
    '})();',
  ].join('\n'),
});

const insertAt = flows.indexOf(configAction) + 1;
if (insertAt <= 0) fail('could not locate SDI-12 config action insertion point');
flows.splice(insertAt, 0, applyHttp, rollbackHttp, applyAction, rollbackAction);
const journalTailIndex = flows.length - JOURNAL_V2_TAIL_IDS.length;
same(
  flows.slice(journalTailIndex).map((node) => node.id),
  JOURNAL_V2_TAIL_IDS,
  'Journal V2 tail before poll insertion'
);
flows.splice(journalTailIndex, 0, pollInject, pollFunction);

for (const id of NEW_IDS) one(flows, id);
const serialized = serialize(flows);
const reparsed = JSON.parse(serialized.toString('utf8'));
if (!Array.isArray(reparsed) || reparsed.length !== flows.length) fail('post-mutation reparse failed');
if (!serialized.equals(serialize(reparsed))) fail('post-mutation serialization is unstable');

fs.writeFileSync(CANONICAL, serialized);
fs.writeFileSync(MIRROR, serialized);
const finalCanonical = loadCanonical(CANONICAL);
const finalMirror = loadCanonical(MIRROR);
if (!finalCanonical.original.equals(finalMirror.original)) fail('maintained profiles differ after mutation');

console.log(`patch-sdi12-recipe-deployment: OK (${flows.length} nodes, ${serialized.length} bytes)`);
