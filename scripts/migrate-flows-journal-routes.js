#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const flowPaths = [
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
];

const legacyThinRouterSource = String.raw`return osiJournal.handleHttpRequest({
  msg: msg,
  Database: osiDb.Database,
  environment: {
    authTokenSecret: env.get('AUTH_TOKEN_SECRET'),
    jwtSecret: env.get('JWT_SECRET'),
    deviceEui: env.get('DEVICE_EUI'),
    deviceEuiConfidence: env.get('DEVICE_EUI_CONFIDENCE'),
    deviceEuiSource: env.get('DEVICE_EUI_SOURCE')
  },
  warn: function(message) { node.warn(message); }
});`;

const thinRouterSource = String.raw`return osiJournal.handleHttpRequest({
  msg: msg,
  Database: osiDb.Database,
  environment: {
    authTokenSecret: env.get('AUTH_TOKEN_SECRET'),
    jwtSecret: env.get('JWT_SECRET'),
    deviceEui: env.get('DEVICE_EUI'),
    deviceEuiConfidence: env.get('DEVICE_EUI_CONFIDENCE'),
    deviceEuiSource: env.get('DEVICE_EUI_SOURCE'),
    edgeBuildVersion: env.get('FIRMWARE_VERSION'),
    edgeBuildCommit: env.get('FIRMWARE_COMMIT')
  },
  warn: function(message) { node.warn(message); }
});`;

const routeDefinitions = [
  ['journal-catalog-get-http', 'get', '/api/journal/catalog'],
  ['journal-entries-get-http', 'get', '/api/journal/entries'],
  ['journal-entries-post-http', 'post', '/api/journal/entries'],
  ['journal-entry-put-http', 'put', '/api/journal/entries/:uuid'],
  ['journal-entry-void-post-http', 'post', '/api/journal/entries/:uuid/void'],
  ['journal-custom-vocab-post-http', 'post', '/api/journal/custom-vocab'],
  ['journal-custom-vocab-put-http', 'put', '/api/journal/custom-vocab/:uuid'],
  ['journal-plots-get-http', 'get', '/api/journal/plots'],
  ['journal-plots-post-http', 'post', '/api/journal/plots'],
  ['journal-plot-put-http', 'put', '/api/journal/plots/:uuid'],
  ['journal-plot-groups-get-http', 'get', '/api/journal/plot-groups'],
  ['journal-plot-groups-post-http', 'post', '/api/journal/plot-groups'],
  ['journal-plot-group-put-http', 'put', '/api/journal/plot-groups/:uuid'],
  ['journal-export-csv-get-http', 'get', '/api/journal/export.csv'],
  ['journal-export-package-get-http', 'get', '/api/journal/export.package'],
  ['journal-export-json-get-http', 'get', '/api/journal/export.json'],
  ['journal-export-adapt-get-http', 'get', '/api/journal/export.adapt.json'],
];

function intendedNodes() {
  const nodes = [{
    id: 'journal-api-tab',
    type: 'tab',
    label: 'Field Journal API',
    disabled: false,
    info: 'Authenticated edge-canonical Field Journal REST and research export routes',
    env: [],
  }];
  let y = 80;
  for (const [id, method, url] of routeDefinitions) {
    nodes.push({
      id,
      type: 'http in',
      z: 'journal-api-tab',
      name: method.toUpperCase() + ' ' + url,
      url,
      method,
      upload: false,
      swaggerDoc: '',
      x: 210,
      y,
      wires: [['journal-api-router-fn']],
    });
    y += 40;
  }
  nodes.push({
    id: 'journal-api-router-fn',
    type: 'function',
    z: 'journal-api-tab',
    name: 'Journal API Router',
    func: thinRouterSource,
    outputs: 1,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [
      { var: 'osiDb', module: 'osi-db-helper' },
      { var: 'osiJournal', module: 'osi-journal' },
    ],
    x: 590,
    y: 400,
    wires: [['journal-api-response']],
  }, {
    id: 'journal-api-response',
    type: 'http response',
    z: 'journal-api-tab',
    name: 'Journal API Response',
    statusCode: '',
    headers: {},
    x: 860,
    y: 400,
    wires: [],
  }, {
    id: 'record-error-catch-journal-api',
    type: 'catch',
    z: 'journal-api-tab',
    name: 'Catch unhandled errors',
    scope: null,
    uncaught: false,
    x: 590,
    y: 800,
    wires: [['record-error-link-out-journal-api']],
  }, {
    id: 'record-error-link-out-journal-api',
    type: 'link out',
    z: 'journal-api-tab',
    name: 'Record Error (link)',
    mode: 'link',
    links: ['record-error-link-in'],
    x: 800,
    y: 800,
    wires: [],
  });
  return nodes;
}

function stable(value) {
  return JSON.stringify(value);
}

function isExactLegacyRouter(existing, intended) {
  if (!existing || existing.id !== 'journal-api-router-fn' ||
      existing.func !== legacyThinRouterSource) return false;
  return stable(Object.assign({}, existing, { func: thinRouterSource })) === stable(intended);
}

function assertUnique(flows) {
  const ids = new Set();
  const routes = new Set();
  for (const node of flows) {
    if (node.id) {
      if (ids.has(node.id)) throw new Error('Duplicate flow node id: ' + node.id);
      ids.add(node.id);
    }
    if (node.type === 'http in') {
      const key = String(node.method).toLowerCase() + ' ' + node.url;
      if (routes.has(key)) throw new Error('Duplicate HTTP route: ' + key);
      routes.add(key);
    }
  }
}

function migrate(buffer) {
  const flows = JSON.parse(buffer.toString('utf8'));
  assertUnique(flows);
  const intended = intendedNodes();
  const byId = new Map(flows.filter((node) => node.id).map((node) => [node.id, node]));
  let legacyRouter = null;
  for (const node of intended) {
    const existing = byId.get(node.id);
    if (existing && stable(existing) !== stable(node)) {
      if (isExactLegacyRouter(existing, node)) legacyRouter = existing;
      else throw new Error('Refusing non-exact journal node collision: ' + node.id);
    }
  }
  const routeKeys = new Set(routeDefinitions.map((route) => route[1] + ' ' + route[2]));
  for (const node of flows) {
    if (node.type !== 'http in' || intended.some((candidate) => candidate.id === node.id)) continue;
    const key = String(node.method).toLowerCase() + ' ' + node.url;
    if (routeKeys.has(key)) throw new Error('Refusing journal route collision: ' + key);
  }
  const missing = intended.filter((node) => !byId.has(node.id));
  const linkIn = byId.get('record-error-link-in');
  if (!linkIn || linkIn.type !== 'link in' || !Array.isArray(linkIn.links)) {
    throw new Error('record-error-link-in is missing or malformed');
  }
  let changed = false;
  if (legacyRouter) {
    legacyRouter.func = thinRouterSource;
    changed = true;
  }
  if (!linkIn.links.includes('record-error-link-out-journal-api')) {
    linkIn.links.push('record-error-link-out-journal-api');
    changed = true;
  }
  if (missing.length) {
    flows.push(...missing);
    changed = true;
  }
  assertUnique(flows);
  return changed ? Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8') : buffer;
}

const before = flowPaths.map((file) => fs.readFileSync(file));
if (!before[0].equals(before[1])) throw new Error('Maintained flows are not byte-identical before migration');
for (let index = 0; index < before.length; index += 1) {
  const roundTripBefore = Buffer.from(
    JSON.stringify(JSON.parse(before[index].toString('utf8')), null, 2) + '\n',
    'utf8'
  );
  if (!before[index].equals(roundTripBefore)) {
    throw new Error('Maintained flow input is not a byte-stable JSON round-trip: ' + flowPaths[index]);
  }
}
const after = migrate(before[0]);
const secondPass = migrate(after);
if (!after.equals(secondPass)) throw new Error('Journal route migration is not idempotent');
const roundTrip = Buffer.from(JSON.stringify(JSON.parse(after.toString('utf8')), null, 2) + '\n');
if (!after.equals(roundTrip)) throw new Error('Journal route migration is not stable after JSON round-trip');
if (after.equals(before[0])) {
  process.stdout.write('migrate-flows-journal-routes: already current\n');
  process.exit(0);
}
for (const file of flowPaths) fs.writeFileSync(file, after);
if (!fs.readFileSync(flowPaths[0]).equals(fs.readFileSync(flowPaths[1]))) {
  throw new Error('Maintained flows lost byte parity after migration');
}
process.stdout.write('migrate-flows-journal-routes: applied exact Task 10 routes\n');
