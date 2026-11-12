'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { executeFunction, profilePaths } = require('./lib/scoped-access-harness');
const { cloneMessage } = require('./lib/node-red-send-emulation');

// Follow the shipped wires, catch scopes and link pairs. Function-node throws
// enter Catch the way Node-RED 3.1.15 does: the original Error becomes _error,
// and error contains the public log message plus source metadata.
async function noTokenReply(flows, start, modules) {
  const nodes = new Map(flows.map((n) => [n.id, n]));
  const queue = [{ id: start, msg: { req: { headers: {} }, res: {}, payload: {} } }];
  const replies = [];
  const db = { prepare() { assert.fail('an unauthenticated request must not reach SQLite'); } };
  const flowStore = new Map();
  while (queue.length) {
    const { id, msg } = queue.shift();
    const n = nodes.get(id);
    assert.ok(n, id);
    let outputs;
    if (n.type === 'http response') { replies.push({ status: msg.statusCode, body: msg.payload }); continue; }
    if (n.type === 'link out') {
      // Error telemetry is a separate existing lane, with no HTTP reply.
      if (n.links.includes('record-error-link-in')) continue;
      for (const target of n.links) queue.push({ id: target, msg });
      continue;
    }
    if (n.type === 'function') {
      try {
        const run = await executeFunction(n, { msg, db, flowStore, nodeRedModules: modules,
          env: { OSI_SCOPED_ACCESS: '0', AUTH_TOKEN_SECRET: 'auth-error-wiring-fixture' } });
        assert.deepEqual(run.errors, []);
        outputs = Array.isArray(run.result) ? run.result : [run.result];
      } catch (error) {
        for (const catcher of flows.filter((c) => c.type === 'catch' && c.z === n.z &&
          (!Array.isArray(c.scope) || c.scope.includes(n.id)))) {
          const caught = cloneMessage({ ...msg, error });
          caught._error = caught.error;
          caught.error = { message: String(error), source: { id: n.id, type: n.type, name: n.name } };
          for (const target of (catcher.wires || []).flat()) queue.push({ id: target, msg: caught });
        }
        continue;
      }
    } else if (n.type === 'switch') {
      assert.equal(n.property, 'res'); assert.deepEqual(n.rules, [{ t: 'nnull' }]);
      outputs = msg.res != null ? [msg] : [];
    } else if (n.type === 'change') {
      for (const rule of n.rules) {
        assert.equal(rule.t, 'move'); assert.equal(rule.pt, 'msg'); assert.equal(rule.tot, 'msg');
        msg[rule.to] = msg[rule.p]; delete msg[rule.p];
      }
      outputs = [msg];
    } else if (n.type === 'http in' || n.type === 'link in') outputs = [msg];
    else assert.fail('unexpected node on HTTP error path: ' + n.id + ' (' + n.type + ')');
    for (let port = 0; port < (n.wires || []).length; port++) {
      if (outputs[port] == null) continue;
      for (const target of n.wires[port]) queue.push({ id: target, msg: outputs[port] });
    }
  }
  return replies;
}

for (const profile of ['bcm2712', 'bcm2709']) {
  const paths = profilePaths(profile);
  const flows = JSON.parse(fs.readFileSync(paths.flowsPath));
  for (const [route, start] of [['POST /api/account-link', 'al-link-in'], ['POST /api/sync/force', 'sync-force-http']]) {
    test(`${profile}: no-token:${route} answers once with 401`, async () => {
      const replies = await noTokenReply(flows, start, paths.nodeRedModules);
      assert.equal(replies.length, 1, 'one HTTP answer must reach the caller');
      assert.equal(replies[0].status, 401);
    });
  }
  test(`${profile}: startup-node-errors has no unconfigured SQLite node`, () => {
    const invalid = flows.filter((n) => n.type === 'sqlite' && !n.mydb).map((n) => n.id);
    assert.deepEqual(invalid, [], 'node-red-node-sqlite logs "Sqlite database not configured" for these nodes at startup');
    for (const n of flows) assert.ok(!(n.wires || []).flat().includes('dendro-readings-sqlite'), n.id + ' still targets the removed node');
  });
}
