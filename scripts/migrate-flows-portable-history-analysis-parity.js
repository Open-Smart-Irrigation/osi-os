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

function requiredNode(id) {
  const node = flows.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`${id} not found`);
  return node;
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing ${label} anchor`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`ambiguous ${label} anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function addHttpNode(node) {
  if (flows.some((candidate) => candidate.id === node.id)) {
    throw new Error(`${node.id} already exists`);
  }
  flows.push(node);
}

const historyRouter = requiredNode('history-api-router-fn');
historyRouter.func = replaceOnce(
  historyRouter.func,
  `function scopeRouteForRequest(method, requestPath, params) {
  if (method === 'GET' && /^\\/api\\/history\\/zones\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'zone', zoneId: HR.parseZoneId(params && params.zoneId) };
  }
  if (method === 'GET' && /^\\/api\\/history\\/gateways\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'gateway' };
  }
  if (/^\\/api\\/history\\/workspaces(?:\\/[^/]+)?$/.test(requestPath)) {
    return { kind: 'workspace' };
  }
  return null;
}

async function getOwnedZoneContext(q, auth, zoneId) {`,
  `function scopeRouteForRequest(method, requestPath, params) {
  if (method === 'GET' && /^\\/api\\/history\\/zones\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'zone', zoneId: HR.parseZoneId(params && params.zoneId) };
  }
  if (method === 'GET' && /^\\/api\\/history\\/gateways\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'gateway' };
  }
  if (/^\\/api\\/history\\/workspaces(?:\\/[^/]+)?$/.test(requestPath)) {
    return { kind: 'workspace' };
  }
  return null;
}

async function visibleZoneIdsForExport(q, scope, auth) {
  if (!scopedOn) {
    const owned = await q(
      'SELECT id FROM irrigation_zones WHERE user_id = ? AND deleted_at IS NULL ORDER BY id ASC',
      [auth.userId]
    );
    return owned.map(function(zone) { return Number(zone.id); });
  }
  const users = await q(
    'SELECT user_uuid, disabled_at FROM users WHERE id = ? LIMIT 1',
    [auth.userId]
  );
  const user = users[0];
  if (!user || user.disabled_at) HR.httpError(403, 'forbidden');
  const zoneUuids = await scope.listScopeZoneUuids(
    db,
    user.user_uuid,
    { scopedMode: true }
  );
  const allowed = new Set((zoneUuids || []).map(String));
  const zones = await q(
    'SELECT id, zone_uuid FROM irrigation_zones WHERE deleted_at IS NULL ORDER BY id ASC',
    []
  );
  return zones
    .filter(function(zone) { return allowed.has(String(zone.zone_uuid || '')); })
    .map(function(zone) { return Number(zone.id); });
}

async function getOwnedZoneContext(q, auth, zoneId) {`,
  'account-wide export scope'
);

historyRouter.func = replaceOnce(
  historyRouter.func,
  `  if (requestMethod === 'GET' && new RegExp('^/api/history/zones/[^/]+/export\\\\.csv$').test(requestPath)) {`,
  `  if (requestMethod === 'GET' && requestPath === '/api/history/export.csv') {
    phaseStartedAt = Date.now();
    const query = msg.req.query || {};
    if (query.scope !== 'allZones') {
      HR.httpError(400, 'Unsupported export scope', 'Use scope=allZones');
    }
    const zoneIds = await visibleZoneIdsForExport(q, scope, auth);
    markPhase('context', phaseStartedAt);
    phaseStartedAt = Date.now();
    const granularity = String(query.granularity || 'daily').trim().toLowerCase() || 'daily';
    const from = String(query.from || '').trim();
    const to = String(query.to || query.from || '').trim();
    const result = await osiHistory.buildAllZonesExportCsv(db, {
      zoneIds: zoneIds,
      from: from,
      to: to,
      granularity: granularity,
      site: String(env.get('DEVICE_EUI') || env.get('GATEWAY_DEVICE_EUI') || 'UNKNOWN').trim().toUpperCase(),
      nowMs: Date.now()
    });
    markPhase('export', phaseStartedAt);
    logLabel = 'history all zones export csv';
    logAggregation = granularity;
    logSource = 'all-zones-export';
    const filename = 'all-zones-' + HR.safeFilenamePart(from, 'from') + '_' + HR.safeFilenamePart(to, 'to') + '-' + HR.safeFilenamePart(granularity, 'daily') + '.csv';
    return respondCsv(200, filename, osiHistory.toCsv(result.columns, result.rows));
  }

  if (requestMethod === 'GET' && new RegExp('^/api/history/zones/[^/]+/export\\\\.csv$').test(requestPath)) {`,
  'account-wide export route'
);

const analysisRouter = requiredNode('analysis-api-router-fn');
analysisRouter.func = replaceOnce(
  analysisRouter.func,
  `'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',`,
  `'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',`,
  'analysis CORS methods'
);
analysisRouter.func = replaceOnce(
  analysisRouter.func,
  `  if (requestMethod === 'POST' && requestPath === '/api/analysis/views') {
    await run(osiHistory.ANALYSIS_VIEWS_SCHEMA, []);
    const body = msg.req && msg.req.body || msg.payload || {};
    phaseStartedAt = Date.now();
    const view = await osiHistory.saveAnalysisView(db, { userId: auth.userId, ownerUserUuid: ownerUuid }, body.view || body);
    markPhase(phases, 'saveView', phaseStartedAt);
    logLabel = 'analysis views save';
    return respond(200, { view: view });
  }

  const err = new Error('Analysis endpoint not found');`,
  `  if (requestMethod === 'POST' && requestPath === '/api/analysis/views') {
    await run(osiHistory.ANALYSIS_VIEWS_SCHEMA, []);
    const body = msg.req && msg.req.body || msg.payload || {};
    phaseStartedAt = Date.now();
    const view = await osiHistory.saveAnalysisView(db, { userId: auth.userId, ownerUserUuid: ownerUuid }, body.view || body);
    markPhase(phases, 'saveView', phaseStartedAt);
    logLabel = 'analysis views save';
    return respond(200, { view: view });
  }

  if (requestMethod === 'DELETE' && /^\\/api\\/analysis\\/views\\/[^/]+$/.test(requestPath)) {
    await run(osiHistory.ANALYSIS_VIEWS_SCHEMA, []);
    phaseStartedAt = Date.now();
    await osiHistory.deleteAnalysisView(db, { userId: auth.userId }, msg.req.params && msg.req.params.id);
    markPhase(phases, 'deleteView', phaseStartedAt);
    logLabel = 'analysis views delete';
    return respond(204, null);
  }

  const err = new Error('Analysis endpoint not found');`,
  'analysis view delete route'
);

addHttpNode({
  id: 'history-all-zones-export-csv-http',
  type: 'http in',
  z: 'history-api-tab',
  name: 'GET /api/history/export.csv',
  url: '/api/history/export.csv',
  method: 'get',
  upload: false,
  swaggerDoc: '',
  x: 210,
  y: 1020,
  wires: [['history-api-router-fn']],
});
addHttpNode({
  id: 'analysis-views-delete-http',
  type: 'http in',
  z: 'history-api-tab',
  name: 'DELETE /api/analysis/views/:id',
  url: '/api/analysis/views/:id',
  method: 'delete',
  upload: false,
  swaggerDoc: '',
  x: 180,
  y: 920,
  wires: [['analysis-api-router-fn']],
});

const serialized = JSON.stringify(flows, null, 2) + '\n';
fs.writeFileSync(canonicalPath, serialized);
fs.writeFileSync(mirrorPath, serialized);
