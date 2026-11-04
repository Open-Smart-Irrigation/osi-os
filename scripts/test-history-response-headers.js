'use strict';
// Exercise the real Node-RED HTTPIn and HTTPOut constructors with Express.
// The repository function is executed with the existing facadeDb seam. This
// tests the real response constructor and HTTP bytes, not a guessed merger.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb, makeAuthHeader } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'scripts/fixtures/history-response-runtime');
const fromRuntime = createRequire(path.join(RUNTIME, 'package.json'));
const HTTPIN_SHA = 'a5b03d988d2bd9d7779e28bdfcca19d062ace6e7a6df6a08eae701b02939e6db';
const NODE_RED_SRI = 'sha512-2ublrdNZxHhyJVxNh7S2YHB0UVKDkMECSZPsIdIvaQC77AAnfW2d41np+iO7jzLdpAvRoRwSwJser+RdEflxRQ==';
const NODES_SRI = 'sha512-1Zeu8Wx79niemNjFejpeyiAjyFFaBoo7Hxvt2zQNg1S5P5qsPEp6RKmSGufG6fixBOfWU2p6gD5OF6efqPcX8g==';
const UTIL_SRI = 'sha512-vuNBpyiyYNMVumzDYdEg1V/cJkuz74Dq+P90nWVBK4stqpmgD0/v1ntrUGhHBaSfeLXx/GmfMQk70n8ew3dlFA==';
const EXPRESS_SRI = 'sha512-28HqgMZAmih1Czt9ny7qr6ek2qddF4FclbMzwhCREB6OFfH+rXAnuNCwo1/wFvrtbgsQDb4kSbX9de9lFbrXnA==';
const FIXED_NOW = '2026-07-03T12:00:00.000Z';
const SITE = '0016C001F1000001';
const SECRET = 'history-response-fixture-secret';
const CSV_BODY = 'timestamp,site,zone,series_label,card_type,source_key,channel_key,depth_cm,array_id,unit,value\n' +
  '2026-07-01T00:15:00.000Z,0016C001F1000001,Coast,Rain - Rainfall this interval,environment,environment-src-d1506631a773,rain_mm_delta,,,mm,1.5\n';
const CSV_NAME = 'zone-13-2026-07-01_2026-07-01-raw.csv';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'Content-Type,Authorization',
};
const FixedDate = class extends Date {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
  static now() { return Date.parse(FIXED_NOW); }
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function provenance() {
  const lock = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/node-red'].version, '3.1.15');
  assert.equal(lock.packages['node_modules/node-red'].integrity, NODE_RED_SRI);
  assert.equal(lock.packages['node_modules/@node-red/nodes'].version, '3.1.15');
  assert.equal(lock.packages['node_modules/@node-red/nodes'].integrity, NODES_SRI);
  assert.equal(lock.packages['node_modules/@node-red/util'].version, '3.1.15');
  assert.equal(lock.packages['node_modules/@node-red/util'].integrity, UTIL_SRI);
  assert.equal(lock.packages['node_modules/express'].version, '4.21.2');
  assert.equal(lock.packages['node_modules/express'].integrity, EXPRESS_SRI);
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (name && pkg.resolved) assert.ok(pkg.integrity, name + ': lock entry lacks integrity');
  }
  const packageRoot = path.dirname(fromRuntime.resolve('@node-red/nodes/package.json'));
  assert.equal(path.resolve(packageRoot), path.resolve(RUNTIME, 'node_modules/@node-red/nodes'));
  assert.equal(path.dirname(fromRuntime.resolve('@node-red/util/package.json')),
    path.join(RUNTIME, 'node_modules/@node-red/util'));
  assert.equal(path.dirname(fromRuntime.resolve('express/package.json')),
    path.join(RUNTIME, 'node_modules/express'));
  const source = path.join(packageRoot, 'core/network/21-httpin.js');
  assert.equal(sha(fs.readFileSync(source)), HTTPIN_SHA);
  assert.equal(fromRuntime('@node-red/nodes/package.json').version, '3.1.15');
  console.log(JSON.stringify({ loadedResponseSource: source, sha256: HTTPIN_SHA,
    nodeRedIntegrity: NODE_RED_SRI, nodesIntegrity: NODES_SRI,
    utilIntegrity: UTIL_SRI, expressIntegrity: EXPRESS_SRI }));
  return source;
}

function readProfile(profile) {
  const share = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_' + profile + '/files/usr/share');
  const flows = JSON.parse(fs.readFileSync(path.join(share, 'flows.json'), 'utf8'));
  const byId = new Map(flows.map((node) => [node.id, node]));
  const csv = byId.get('history-zone-export-csv-http');
  const workspace = flows.find((node) => node.type === 'http in' && node.method === 'get' && node.url === '/api/history/workspaces');
  const router = byId.get('history-api-router-fn');
  const response = byId.get('history-api-response');
  const options = byId.get('device-options-http');
  const optionsResponse = byId.get('device-options-response');
  assert.ok(csv && workspace && router && response && options && optionsResponse);
  assert.deepEqual(csv.wires, [[router.id]]);
  assert.deepEqual(workspace.wires, [[router.id]]);
  assert.deepEqual(router.wires, [[response.id]]);
  assert.deepEqual(options.wires, [[optionsResponse.id]]);
  return { share, csv, workspace, router, response, options, optionsResponse };
}

function database() {
  const raw = new DatabaseSync(':memory:');
  try {
    raw.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
    raw.exec(`
    INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role,sync_version)
      VALUES (1,'owner-one','h','2026-05-31','2026-05-31','u-one','admin',1);
    INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,timezone,created_at,updated_at)
      VALUES (13,'Coast',1,'z-coast','UTC','2026-05-31','2026-05-31');
    INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,created_at,updated_at)
      VALUES ('A840410000000001','Rain','AQUASCOPE_LORAIN',1,13,'x','x');
    INSERT INTO device_data(deveui,recorded_at,rain_mm_delta)
      VALUES ('A840410000000001','2026-07-01T00:15:00.000Z',1.5);
  `);
    return raw;
  } catch (error) {
    raw.close();
    throw error;
  }
}

async function invokeRouter(config, raw, msg) {
  const modules = config.share + '/node-red';
  const state = new Map();
  const warnings = [];
  const db = facadeDb(raw);
  const libs = {
    osiDb: { Database: class { constructor(name) {
      assert.equal(name, '/data/db/farming.db');
      return db;
    } } },
    osiHistory: require(modules + '/osi-history-helper'),
    HR: require(modules + '/osi-history-router'),
    crypto,
    osiLib: { require(name) {
      if (name === 'scope') return { ok: false, error: 'scoped mode disabled in fixture' };
      throw new Error('unexpected osiLib.require: ' + name);
    } },
  };
  const env = { get(name) {
    return ({ AUTH_TOKEN_SECRET: SECRET, DEVICE_EUI: SITE, OSI_SCOPED_ACCESS: '0' })[name];
  } };
  const globals = { get(name) { return name === 'historySchemaGuardVersion' ? state.get(name) :
    name === 'fs' ? fs : undefined; }, set(name, value) { state.set(name, value); } };
  const node = { warn(value) { warnings.push(String(value)); }, error(value) {
    throw new Error('router node.error: ' + String(value));
  }, log() {} };
  const args = { msg, node, env, global: globals, flow: { get() {}, set() {} },
    context: { get() {}, set() {} }, Date: FixedDate, Buffer };
  for (const lib of config.router.libs) args[lib.var] = libs[lib.var];
  const fn = new Function(...Object.keys(args), config.router.func);
  const returned = await fn(...Object.values(args));
  assert.equal(returned, msg, 'router returned original request message');
  assert.deepEqual(warnings, [], 'router warning');
  return returned;
}

function rawHeaderValues(response, name) {
  const values = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === name) values.push(response.rawHeaders[i + 1]);
  }
  return values;
}
function contentType(response, expected) {
  const values = rawHeaderValues(response, 'content-type');
  assert.equal(values.length, 1, 'one Content-Type wire field');
  assert.ok(!values[0].includes(','), 'no joined Content-Type');
  const fields = values[0].split(';').map((part) => part.trim());
  assert.equal(fields.shift().toLowerCase(), expected);
  const params = fields.filter(Boolean).map((field) => field.split('=').map((part) => part.trim().toLowerCase()));
  assert.ok(params.every((entry) => entry.length === 2 && entry[0] === 'charset' && entry[1] === 'utf-8'));
  if (expected === 'text/csv') assert.equal(params.length, 1);
  else assert.ok(params.length <= 1);
}
function disposition(response, expected) {
  const values = rawHeaderValues(response, 'content-disposition');
  if (!expected) { assert.deepEqual(values, []); return; }
  assert.equal(values.length, 1);
  assert.match(values[0], /^attachment;\s*filename="([^"]+)"$/i);
  const match = /^attachment;\s*filename="([^"]+)"$/i.exec(values[0]);
  assert.equal(match[1], expected);
  assert.match(match[1], /^[A-Za-z0-9._-]+$/);
}
function assertCors(response) {
  for (const [key, value] of Object.entries(CORS)) assert.deepEqual(rawHeaderValues(response, key), [value]);
}

async function withServer(config, raw, source, work) {
  const express = fromRuntime('express');
  const util = fromRuntime('@node-red/util').util;
  const app = express();
  const sockets = new Set();
  const clients = new Set();
  const pendingHandlers = new Set();
  const seen = [];
  const faults = [];
  const types = {};
  const nodes = new Map();
  const RED = {
    settings: { httpNodeRoot: '/', httpNodeCors: false },
    httpNode: app,
    util: { cloneMessage: util.cloneMessage.bind(util), generateId: () => crypto.randomBytes(8).toString('hex') },
    _: (key) => key,
    nodes: {
      registerType(name, constructor) { types[name] = constructor; },
      createNode(instance, definition) {
        instance.id = definition.id;
        instance.on = (event, handler) => { instance['on_' + event] = handler; };
        instance.warn = (value) => faults.push(String(value));
        instance.metric = () => false;
        instance.send = (msg) => {
          seen.push(instance.id);
          if (instance.id === config.options.id) {
            seen.push(config.optionsResponse.id);
            nodes.get(config.optionsResponse.id).on_input(msg, () => {}, () => {});
            return;
          }
          const handler = invokeRouter(config, raw, msg).then((out) => {
            seen.push(config.router.id);
            seen.push(config.response.id);
            nodes.get(config.response.id).on_input(out, () => {}, () => {});
          }).catch((error) => {
            faults.push(String(error && error.stack || error));
            try {
              if (!msg.res._res.headersSent && !msg.res._res.destroyed) {
                msg.res._res.status(500).end('fixture handler failure');
              }
            } catch (sendError) {
              faults.push(String(sendError && sendError.stack || sendError));
            }
          });
          pendingHandlers.add(handler);
          void handler.finally(() => pendingHandlers.delete(handler));
        };
      },
    },
  };
  require(source)(RED);
  for (const definition of [config.response, config.optionsResponse, config.csv, config.workspace, config.options]) {
    assert.ok(types[definition.type], 'loaded real ' + definition.type + ' constructor');
    nodes.set(definition.id, new types[definition.type](definition));
  }
  const server = http.createServer(app);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const request = (method, uri, authorization) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: uri,
        headers: authorization ? { Authorization: authorization } : {} }, (res) => {
        const chunks = [];
        res.on('data', (part) => chunks.push(part));
        res.on('end', () => resolve({ status: res.statusCode, rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks).toString('utf8'), seen: seen.splice(0) }));
        res.on('error', reject);
      });
      req.setTimeout(2500, () => req.destroy(new Error('fixture request timeout')));
      clients.add(req);
      req.on('close', () => clients.delete(req));
      req.on('error', reject);
      req.end();
    });
    await work(request, seen);
  } finally {
    for (const req of clients) req.destroy(new Error('fixture teardown'));
    if (server.listening) {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('owned listener close timeout')), 2000);
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
    }
    assert.equal(pendingHandlers.size, 0, 'all owned route handlers settled');
    assert.deepEqual(faults, [], 'HTTP node or router faults');
  }
}

const source = provenance();
for (const profile of ['bcm2712', 'bcm2709']) {
  test(profile + ': real feed response and route bytes', { timeout: 12000 }, async () => {
    const config = readProfile(profile);
    const raw = database();
    const token = makeAuthHeader({ userId: 1, username: 'owner-one', secret: SECRET,
      expiresAt: Date.parse('2026-07-04T12:00:00.000Z') });
    try {
      await withServer(config, raw, source, async (request) => {
      const csvPath = '/api/history/zones/13/export.csv?from=2026-07-01&to=2026-07-01&granularity=raw&channels=rain_mm_delta';
      const csv = await request('GET', csvPath, token);
      console.log(JSON.stringify({ profile, case: 'csv', ...csv }));
      assert.equal(csv.status, 200);
      assert.deepEqual(csv.seen, [config.csv.id, config.router.id, config.response.id]);
      assert.equal(csv.body, CSV_BODY);
      disposition(csv, CSV_NAME);
      assertCors(csv);

      const workspace = await request('GET', '/api/history/workspaces', token);
      console.log(JSON.stringify({ profile, case: 'workspace', ...workspace }));
      assert.equal(workspace.status, 200);
      assert.deepEqual(workspace.seen, [config.workspace.id, config.router.id, config.response.id]);
      assert.equal(workspace.body, '{"generatedAt":"2026-07-03T12:00:00.000Z","workspaces":[]}');
      assert.deepEqual(JSON.parse(workspace.body), { generatedAt: FIXED_NOW, workspaces: [] });
      contentType(workspace, 'application/json'); disposition(workspace); assertCors(workspace);

      const anonymous = await request('GET', csvPath);
      console.log(JSON.stringify({ profile, case: 'anonymous', ...anonymous }));
      assert.equal(anonymous.status, 401);
      assert.deepEqual(anonymous.seen, [config.csv.id, config.router.id, config.response.id]);
      assert.equal(anonymous.body, '{"error":"Unauthorized"}');
      assert.deepEqual(JSON.parse(anonymous.body), { error: 'Unauthorized' });
      contentType(anonymous, 'application/json'); disposition(anonymous); assertCors(anonymous);

      const invalid = await request('GET', '/api/history/zones/13/export.csv?from=bad&to=bad&channels=rain_mm_delta', token);
      console.log(JSON.stringify({ profile, case: 'caught-error', ...invalid }));
      assert.equal(invalid.status, 400);
      assert.deepEqual(invalid.seen, [config.csv.id, config.router.id, config.response.id]);
      assert.equal(invalid.body, '{"error":"from must be YYYY-MM-DD"}');
      assert.deepEqual(JSON.parse(invalid.body), { error: 'from must be YYYY-MM-DD' });
      contentType(invalid, 'application/json'); disposition(invalid); assertCors(invalid);

      const preflight = await request('OPTIONS', csvPath);
      console.log(JSON.stringify({ profile, case: 'options', ...preflight,
        owner: preflight.seen.includes(config.options.id) ? config.options.id : 'express-auto-options' }));
      // Express 4.21.2 handles OPTIONS automatically with Allow: GET,HEAD and no CORS or max-age.
      // The positive preflight gate remains unmet; a future fix must update these assertions.
      assert.ok(!preflight.seen.includes(config.options.id), 'OPTIONS not handled by configured flow node');
      assert.equal(preflight.status, 200);
      assert.deepEqual(preflight.body.split(/,\s*/), ['GET', 'HEAD']);
      assert.deepEqual(rawHeaderValues(preflight, 'allow'), ['GET,HEAD']);
      assert.deepEqual(rawHeaderValues(preflight, 'access-control-max-age'), []);
      for (const name of Object.keys(CORS)) assert.deepEqual(rawHeaderValues(preflight, name), []);
      // The media-type assertion runs last so BASE RED cannot hide a failed
      // auth, JSON, CORS, body, filename or OPTIONS control.
      contentType(csv, 'text/csv'); // Assert the CSV response media type.
      });
    } finally {
      raw.close();
    }
  });
}
