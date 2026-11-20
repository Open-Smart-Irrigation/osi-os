#!/usr/bin/env node
'use strict';
// Run the same frozen cases inside the real Node-RED Function node runtime.
// OSI_X1_NODE_RED points to an installed, version-pinned node-red package directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { cases } = require('./lib/daily-scheduler-cases');
const { PROFILES, ROOT, execute } = require('./lib/daily-scheduler-harness');
const { runtimeConfig } = require('./lib/release-smoke-runtimes');
const legacy = require('./fixtures/daily-scheduler/legacy-nodes.json');
const expected = require('./fixtures/daily-scheduler/expected.json');
async function main() {
  const image = runtimeConfig('image'), stock = runtimeConfig('stock');
  assert.equal(process.versions.node, image.node, 'run on the Release Runtime Smoke Node pin');
  const packageDir = process.env.OSI_X1_NODE_RED;
  assert.ok(packageDir && path.isAbsolute(packageDir), 'OSI_X1_NODE_RED must be absolute');
  const version = require(path.join(packageDir, 'package.json')).version;
  assert.ok([image.nodeRed, stock.nodeRed].includes(version));
  const RED = require(packageDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-runtime-'));
  const server = http.createServer();
  let resolveAnswer, rejectAnswer, timer;
  const bridge = {
    async invoke(entry, c, profile) {
      // Function execution is delegated back through the sandbox callback so
      // all dependency stubs and return/error normalization match the VM run.
      return execute('', c, profile, entry);
    },
    answer(value) { clearTimeout(timer); resolveAnswer(value); },
    failed(err) { clearTimeout(timer); rejectAnswer(err); },
  };
  const flow = [{ id: 'x1-tab', type: 'tab', label: 'isolated X1 parity' }];
  const sources = new Map();
  let id = 0;
  for (const profile of PROFILES) {
    const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json')));
    const adapters = require('./fixtures/daily-scheduler/adapters.json');
    for (const [variant, nodes] of [['legacy', legacy], ['shipped', shipped], ['adapter', adapters]]) {
      for (const original of legacy) {
        const source = nodes.find(n => n.id === original.id).func;
        const nodeId = 'x1-' + (++id);
        sources.set(profile + '/' + variant + '/' + original.id, nodeId);
        flow.push({ id: nodeId, type: 'function', z: 'x1-tab', x: 200, y: 100, name: nodeId, outputs: 1, wires: [[]], libs: [],
          func: `const bridge = global.get('x1bridge');\nreturn bridge.invoke(async (msg, deps) => {\nconst { env, node, osiLib, osiDb, crypto, global, Date, Buffer } = deps;\nreturn (async () => {\n${source}\n})();\n}, msg.x1case, ${JSON.stringify(profile)}).then(bridge.answer, bridge.failed);` });
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flow));
  RED.init(server, { userDir: dir, flowFile: 'flows.json', uiPort: 0, httpAdminRoot: false, httpNodeRoot: false,
    functionExternalModules: false, functionGlobalContext: { x1bridge: bridge },
    logging: { console: { level: 'off' } }, credentialSecret: 'synthetic-x1-runtime' });
  let startTimer;
  const started = new Promise((resolve, reject) => {
    startTimer = setTimeout(() => reject(new Error('Node-RED flows did not start')), 10000);
    RED.events.once('flows:started', () => { clearTimeout(startTimer); resolve(); });
  });
  try {
    await RED.start();
    await started;
    let count = 0;
    for (const profile of PROFILES) for (const c of cases()) for (const variant of ['legacy', 'shipped', 'adapter']) {
      const answer = new Promise((resolve, reject) => {
        resolveAnswer = resolve; rejectAnswer = reject;
        timer = setTimeout(() => reject(new Error('function-node timeout: ' + c.name)), 3000);
      });
      RED.nodes.getNode(sources.get(profile + '/' + variant + '/' + c.id)).receive({ x1case: c });
      assert.deepStrictEqual(await answer, expected[c.name], profile + '/' + variant + '/' + c.name);
      count++;
    }
    console.log(`daily-scheduler Node-RED parity: OK (Node ${process.versions.node}, Node-RED ${version}, ${count} comparisons, both profiles)`);
  } finally {
    clearTimeout(timer);
    clearTimeout(startTimer);
    await RED.stop();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
