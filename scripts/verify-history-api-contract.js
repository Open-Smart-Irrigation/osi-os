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
  ['GET', '/api/system/features']
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
  return url === '/api/system/features' || url.startsWith('/api/history');
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
