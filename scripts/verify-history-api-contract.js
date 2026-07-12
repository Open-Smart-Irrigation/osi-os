#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DEFAULT_FLOW_PATH = path.resolve(
  __dirname,
  '..',
  'conf',
  'full_raspberrypi_bcm27xx_bcm2712',
  'files',
  'usr',
  'share',
  'flows.json'
);

const REQUIRED_ENDPOINTS = [
  ['GET', '/api/history/zones/:zoneId/cards'],
  ['GET', '/api/history/zones/:zoneId/export.csv'],
  ['GET', '/api/history/zones/:zoneId/cards/:cardId/data'],
  ['GET', '/api/history/zones/:zoneId/cards/:cardId/advanced'],
  ['GET', '/api/history/gateways/:gatewayEui/cards'],
  ['GET', '/api/history/gateways/:gatewayEui/cards/:cardId/data'],
  ['GET', '/api/history/gateways/:gatewayEui/cards/:cardId/advanced'],
  ['GET', '/api/history/workspaces'],
  ['POST', '/api/history/workspaces'],
  ['PUT', '/api/history/workspaces/:id'],
  ['DELETE', '/api/history/workspaces/:id'],
  ['PUT', '/api/history/zones/:zoneId/cards/:cardId/preferences'],
  ['POST', '/api/history/zones/:zoneId/cards/:cardId/opened'],
  ['PUT', '/api/history/gateways/:gatewayEui/cards/:cardId/preferences'],
  ['POST', '/api/history/gateways/:gatewayEui/cards/:cardId/opened'],
  ['POST', '/api/history/rollups/run'],
  ['GET', '/api/system/features'],
  ['GET', '/api/analysis/channels'],
  ['POST', '/api/analysis/series'],
  ['GET', '/api/analysis/views'],
  ['POST', '/api/analysis/views']
].map(([method, url]) => ({ method, url }));

const REQUIRED_ENDPOINT_KEYS = new Set(REQUIRED_ENDPOINTS.map(endpointKey));

function parseArgs(argv) {
  const options = {
    allowMissingHistory: false,
    flowPath: DEFAULT_FLOW_PATH
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allow-missing-history') {
      options.allowMissingHistory = true;
    } else if (arg === '--flows') {
      const next = argv[i + 1];
      if (!next) throw new Error('--flows requires a path');
      options.flowPath = path.resolve(process.cwd(), next);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function endpointKey(endpoint) {
  return `${endpoint.method.toUpperCase()} ${endpoint.url}`;
}

function isHistoryContractRoute(node) {
  const url = String(node.url || '').trim();
  return url === '/api/system/features' || url.startsWith('/api/history') || url.startsWith('/api/analysis');
}

function normalizeMethod(method) {
  return String(method || '').trim().toUpperCase();
}

function flattenWires(wires) {
  if (!Array.isArray(wires)) return [];
  return wires.flatMap((output) => Array.isArray(output) ? output : []);
}

function getReachableFunctionNodes(startNode, nodesById) {
  const queue = flattenWires(startNode.wires);
  const visited = new Set([startNode.id]);
  const reachable = [];

  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    const node = nodesById.get(id);
    if (!node) continue;
    if (node.type === 'function') reachable.push(node);

    for (const nextId of flattenWires(node.wires)) {
      if (!visited.has(nextId)) queue.push(nextId);
    }
  }

  return reachable;
}

function hasHistoryHelperLib(node) {
  return Array.isArray(node.libs) && node.libs.some((lib) =>
    String(lib && lib.module || '').trim() === 'osi-history-helper' &&
    String(lib && lib.var || '').trim().length > 0
  );
}

function hasHistoryRouterLib(node) {
  return Array.isArray(node.libs) && node.libs.some((lib) =>
    String(lib && lib.var || '').trim() === 'HR' &&
    String(lib && lib.module || '').trim() === 'osi-history-router'
  );
}

function findHistoryRouter(flows) {
  return flows.find((node) =>
    node.type === 'function' &&
    String(node.name || '').trim() === 'History API Router'
  ) || null;
}

function findAnalysisRouter(flows) {
  return flows.find((node) =>
    node.type === 'function' &&
    String(node.name || '').trim() === 'Analysis API Router'
  ) || null;
}

function assertContains(failures, source, needle, description) {
  if (!source.includes(needle)) {
    failures.push(`history router missing ${description}`);
  }
}

function assertNotContains(failures, source, needle, description) {
  if (source.includes(needle)) {
    failures.push(`history router still contains ${description}`);
  }
}

function readHistoryRouterModule(flowPath, failures) {
  const modulePath = path.join(
    path.dirname(flowPath),
    'node-red',
    'osi-history-router',
    'index.js'
  );
  try {
    return fs.readFileSync(modulePath, 'utf8');
  } catch (error) {
    const state = error && error.code === 'ENOENT' ? 'missing' : 'unreadable';
    failures.push(`History API Router module ${state}: ${modulePath} (${error.message})`);
    return '';
  }
}

function verifyHistoryRouterImplementation(flows, failures, extractedModuleSource) {
  const router = findHistoryRouter(flows);
  if (!router) {
    failures.push('missing History API Router function node');
    return;
  }

  const adapterSource = String(router.func || '');
  const moduleSource = String(extractedModuleSource || '');
  const contractSource = adapterSource + '\n' + moduleSource;
  if (!hasHistoryRouterLib(router)) {
    failures.push("History API Router must declare libs binding { var: 'HR', module: 'osi-history-router' }");
  }

  assertContains(failures, adapterSource, 'verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization)', 'bearer auth gate');
  assertContains(failures, adapterSource, "httpError(404, 'Zone not found or access denied')", 'owned-zone 404 branch');
  assertContains(failures, adapterSource, "httpError(404, 'History card not found')", 'missing-card 404 branch');
  assertContains(failures, adapterSource, 'if (!deveuis.length)', 'empty known-card response branch');
  assertContains(failures, adapterSource, "typeof device === 'string'", 'latest-row DevEUI string handling');
  assertContains(failures, adapterSource, 'HR.supportedRangesForCard(config, scopeContext)', 'date-range availability gating');
  assertContains(failures, adapterSource, 'getActiveZoneSeason', 'active season lookup');
  assertContains(failures, adapterSource, 'zone_seasons', 'zone_seasons-backed season range');
  assertContains(failures, adapterSource, "INSERT INTO zone_seasons(zone_id, name, starts_on, ends_on, is_active, is_default", 'runtime default season backfill');
  assertContains(failures, adapterSource, "'Current season'", 'display-safe generated season name');
  assertContains(failures, moduleSource, 'Season range is unavailable for this zone', 'season-unavailable 400 contract');
  assertContains(failures, moduleSource, 'Season range uses zone season boundaries; use custom for explicit from/to', 'season explicit-from/to rejection');
  assertContains(failures, adapterSource, 'HR.shouldUseHistoryRollups(scopeContext, range.label, aggregationRequested)', 'long-range rollup gate');
  assertContains(failures, adapterSource, 'soilRowsHaveWarning(latestRows)', 'merged soil summary warning classifier');
  assertContains(failures, adapterSource, 'sourceDeviceCount: summarySourceDevices.length', 'display-safe source count in card summaries');
  assertContains(failures, adapterSource, 'sourceLabels: HR.displaySourceLabels(summarySourceDevices)', 'display-safe source labels in card summaries');
  assertContains(failures, adapterSource, 'sourceKey: displaySafeSourceKey(role, device)', 'display-safe source keys in card summaries');
  assertContains(failures, adapterSource, 'function sourceDevicesForQuery', 'sourceKey query filtering helper');
  assertContains(failures, adapterSource, "httpError(400, 'Unknown history source')", 'invalid sourceKey 400 contract');
  assertContains(failures, adapterSource, 'const sourceDevices = sourceDevicesForQuery(scopeContext, card, query, allSourceDevices)', 'sourceKey-filtered source devices for card data');
  assertContains(failures, adapterSource, 'environmentRowsHaveWarning(latestRows)', 'merged environment summary warning classifier');
  assertContains(failures, adapterSource, 'osiHistory.buildCalendar', 'helper-owned calendar classification');
  assertContains(failures, adapterSource, 'osiHistory.buildLocalInterpretations', 'helper-owned local interpretations');
  assertContains(failures, adapterSource, 'osiHistory.buildAdvancedDiagnostics', 'helper-owned advanced diagnostic availability');
  assertContains(failures, adapterSource, 'osiHistory.buildZoneExportCsv', 'helper-owned zone CSV export');
  assertContains(failures, adapterSource, 'channels', 'zone CSV export forwards channels query param');
  assertContains(failures, adapterSource, 'site:', 'zone CSV export forwards gateway site id');
  assertContains(failures, adapterSource, 'respondCsv(200, filename, osiHistory.toCsv(result.columns, result.rows))', 'CSV download response');
  assertContains(failures, adapterSource, 'payload.suggestion = error.suggestion', 'structured CSV export suggestions');
  assertContains(failures, adapterSource, '.find(HR.rowHasSoilProfileValue)', 'soil profile latest row skips rows without SWT values');
  assertContains(failures, adapterSource, 'buildSoilProfiles(latestRows, sourceDevices, series)', 'soil profile builder receives series fallback data');
  assertContains(failures, moduleSource, 'const CARD_CONFIG = {', 'extracted card configuration');
  assertContains(failures, moduleSource, 'function rowHasSoilProfileValue', 'soil profile latest row predicate');
  assertContains(failures, moduleSource, 'function latestSeriesPoint', 'soil profile fallback to latest visible series point');
  assertContains(
    failures,
    moduleSource,
    "{ id: 'ext_temperature_c', field: 'ext_temperature_c', label: 'External Temperature', unit: 'C' }",
    'external temperature environment channel'
  );
  assertContains(
    failures,
    moduleSource,
    "views: ['line-chart', 'daily-min-max', 'calendar', 'advanced']",
    'frontend-supported environment view list'
  );
  assertContains(
    failures,
    moduleSource,
    "views: ['event-timeline', 'calendar', 'advanced']",
    'frontend-supported irrigation view list'
  );
  assertContains(
    failures,
    moduleSource,
    "views: ['status-overview', 'advanced']",
    'frontend-supported gateway view list'
  );

  const seasonBranchIndex = moduleSource.indexOf("if (rawLabel === 'season')");
  const explicitRangeIndex = moduleSource.indexOf('if (fromRaw || toRaw)');
  if (seasonBranchIndex === -1 || explicitRangeIndex === -1 || seasonBranchIndex > explicitRangeIndex) {
    failures.push('history router must resolve/reject season before accepting explicit from/to ranges');
  }

  assertNotContains(failures, contractSource, "season: 120 * 24 * 60 * 60 * 1000", 'synthetic trailing season range');
  assertNotContains(failures, contractSource, "useRollups: scopeContext.scope === 'zone'", 'unconditional zone rollup reads');
  assertNotContains(failures, contractSource, 'supportedRanges: config.supportedRanges.slice()', 'ungated supportedRanges copy');
  assertNotContains(failures, contractSource, 'latestRows[0]', 'single-row merged summary classification');
  assertNotContains(failures, contractSource, 'normalizeCardType(', 'undefined normalizeCardType runtime reference in router');
  assertNotContains(failures, contractSource, 'sync_outbox', 'edge sync outbox mutation from local-only history preferences/workspaces');
  assertNotContains(failures, contractSource, 'local-storage-sync', 'unsupported gateway local storage view');
  assertNotContains(failures, contractSource, 'power-state', 'unsupported gateway power state view');
  assertNotContains(failures, contractSource, "views: ['line-chart', 'daily-min-max', 'calendar', 'stress-events', 'advanced']", 'unsupported environment stress-events view');
  assertNotContains(failures, contractSource, "views: ['event-timeline', 'calendar', 'irrigation-response', 'advanced']", 'unsupported irrigation response view');
  assertNotContains(failures, contractSource, "views: ['status-overview', 'connectivity-timeline', 'advanced']", 'unsupported gateway connectivity timeline view');
}

function verifyAnalysisRouterImplementation(flows, failures) {
  const router = findAnalysisRouter(flows);
  if (!router) {
    failures.push('missing Analysis API Router function node');
    return;
  }

  const source = String(router.func || '');
  assertContains(failures, source, 'verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization)', 'analysis bearer auth gate');
  assertContains(failures, source, 'osiHistory.buildAnalysisCatalog', 'analysis /channels calls buildAnalysisCatalog');
  assertContains(failures, source, 'buildAnalysisCatalog(db, { deviceEui: deviceEui, userId: auth.userId })', 'analysis /channels scopes catalog to authenticated user');
  assertContains(failures, source, 'osiHistory.resolveAnalysisSeries', 'analysis /series calls resolveAnalysisSeries');
  assertContains(failures, source, 'userId: auth.userId', 'analysis /series scopes resolver to authenticated user');
  assertContains(failures, source, 'osiHistory.listAnalysisViews', 'analysis /views calls listAnalysisViews');
  assertContains(failures, source, 'osiHistory.saveAnalysisView', 'analysis /views POST calls saveAnalysisView');
  assertContains(failures, source, 'payload.suggestion = error.suggestion', 'structured analysis suggestions');
  assertNotContains(failures, source, 'sync_outbox', 'edge sync outbox mutation from local-only analysis views');
}

function readFlows(flowPath) {
  const source = fs.readFileSync(flowPath, 'utf8');
  const parsed = JSON.parse(source);
  if (!Array.isArray(parsed)) {
    throw new Error(`${flowPath} did not parse to a Node-RED flow array`);
  }
  return parsed;
}

function verify(options) {
  const failures = [];
  const pending = [];
  const flows = readFlows(options.flowPath);
  const nodesById = new Map(flows.map((node) => [node.id, node]));
  const httpNodesByEndpoint = new Map();

  for (const node of flows) {
    if (node.type !== 'http in') continue;
    const key = endpointKey({ method: normalizeMethod(node.method), url: node.url });
    if (isHistoryContractRoute(node) && !REQUIRED_ENDPOINT_KEYS.has(key)) {
      failures.push(`unexpected history endpoint node: ${key} (${node.id})`);
    }
    const entries = httpNodesByEndpoint.get(key) || [];
    entries.push(node);
    httpNodesByEndpoint.set(key, entries);
  }

  const requiredEndpointsPresent = REQUIRED_ENDPOINTS.filter((endpoint) =>
    (httpNodesByEndpoint.get(endpointKey(endpoint)) || []).length > 0
  );
  const allowPendingMissing = options.allowMissingHistory && requiredEndpointsPresent.length === 0;

  for (const endpoint of REQUIRED_ENDPOINTS) {
    const key = endpointKey(endpoint);
    const matches = httpNodesByEndpoint.get(key) || [];

    if (matches.length === 0) {
      if (allowPendingMissing) {
        pending.push(`${key} is not wired yet`);
      } else {
        failures.push(`missing history endpoint: ${key}`);
      }
      continue;
    }

    if (matches.length > 1) {
      failures.push(`duplicate history endpoint nodes for ${key}: ${matches.map((node) => node.id).join(', ')}`);
      continue;
    }

    const reachableFunctions = getReachableFunctionNodes(matches[0], nodesById);
    const helperNodes = reachableFunctions.filter(hasHistoryHelperLib);
    if (helperNodes.length === 0) {
      failures.push(`${key} does not reach a function node with an osi-history-helper libs alias`);
      continue;
    }

    console.log(`OK ${key} uses osi-history-helper via ${helperNodes.map((node) => JSON.stringify(node.name || node.id)).join(', ')}`);
  }

  for (const item of pending) {
    console.log(`PENDING ${item}`);
  }

  const moduleSource = findHistoryRouter(flows)
    ? readHistoryRouterModule(options.flowPath, failures)
    : '';

  if (!allowPendingMissing) {
    verifyHistoryRouterImplementation(flows, failures, moduleSource);
    verifyAnalysisRouterImplementation(flows, failures);
  }

  if (failures.length) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  if (pending.length) {
    console.log(
      `verify-history-api-contract: ${pending.length} pending history endpoint(s) allowed because no required history endpoints are wired yet`
    );
  } else {
    console.log('verify-history-api-contract: OK');
  }
}

try {
  verify(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`FAIL verify-history-api-contract: ${error.message}`);
  process.exitCode = 1;
}
