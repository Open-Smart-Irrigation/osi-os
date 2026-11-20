'use strict';
// Run the same source through an actual Node-RED Function node. No gateway
// flows are deployed: only the 13 isolated functions and a capture sink exist.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execute, environment, snapshot, normalize } = require('./valve-ingress-x2-harness');
const { baseline, allCases, ROOT } = require('../test-valve-ingress-x2-parity');
const { adaptFlows } = require('./valve-ingress-x2-adapters');
async function main() {
  const runtimePath = process.env.X2_NODE_RED;
  if (!runtimePath || !path.isAbsolute(runtimePath)) throw new Error('X2_NODE_RED must be an absolute node-red package path');
  const pins = require('./release-smoke-runtimes').parseVersions(fs.readFileSync(path.join(ROOT, '.github/workflows/release-smoke.yml'), 'utf8'));
  assert.equal(process.versions.node, pins.node, 'use the release Node pin');
  const version = require(path.join(runtimePath, 'package.json')).version;
  assert.ok([pins.image, pins.stock].includes(version), 'use an image or stock Node-RED pin');
  const RED = require(runtimePath);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-x2-runtime-'));
  const context = { pending: null };
  const server = http.createServer();
  const logs = [];
  RED.init(server, {
    userDir: runDir, flowFile: 'flows.json', httpAdminRoot: false, httpNodeRoot: false,
    functionExternalModules: false, functionGlobalContext: { x2: context },
    logging: { console: { level: 'off' }, capture: { level: 'warn', handler: () => entry => logs.push(entry) } },
  });
  const evidence = [];
  const watchdog = setTimeout(() => { console.error('X2 Function runtime timed out'); process.exit(1); }, 60000);
  try {
    const initialStart = once(RED.events, 'flows:started');
    await RED.start();
    await initialStart;
    RED.nodes.registerType('x2-capture', function(config) {
      RED.nodes.createNode(this, config);
      this.on('input', (msg, send, done) => { context.pending.ports.push({ port: config.port, receiver: config.receiver, msg }); if (done) done(); });
    });
    for (const profile of ['bcm2712', 'bcm2709']) {
      const root = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
      const moduleRoot = path.join(root, 'node-red/osi-valve-control');
      const flows = JSON.parse(fs.readFileSync(path.join(root, 'flows.json')));
      const adapters = adaptFlows(flows);
      const vc = require(moduleRoot);
      const nodes = [{ id: 'x2-tab', type: 'tab', label: 'X2 isolated parity' }];
      for (const phase of ['before', 'after']) for (const original of baseline.nodes) {
        const source = phase === 'before' ? original : adapters.find(n => n.id === original.id);
        const names = ['env','global','node','flow','context','crypto','osiDb','osiLib','chirpstack','Date','Buffer','setTimeout'];
        const args = names.map(name => 'p.deps.' + name);
        // The wrapper observes returns/errors without changing their shape.
        // The normal Function send path then clones and emits every port.
        const body = `const p = global.get('x2').pending;\nif (!p.hadId) delete msg._msgid;\ntry {\nconst result = await (function(msg,${names.join(',')}) {\n${source.func}\n})(msg,${args.join(',')});\np.value = result; p.capture(result, null); p.complete(); return result;\n} catch (error) { p.error = error; p.capture(undefined, error); p.complete(); return null; }`;
        nodes.push({ ...source, id: phase + '-' + source.id, z: 'x2-tab', libs: [], func: body,
          wires: Array.from({ length: source.outputs }, (_, port) => ['sink-' + port, 'mirror-' + port]) });
      }
      for (let port = 0; port < 7; port++) for (const receiver of ['sink','mirror']) nodes.push({ id: receiver + '-' + port, type: 'x2-capture', z: 'x2-tab', port, receiver, wires: [] });
      // setFlows resolves after saving, before its asynchronous start completes.
      const deployed = once(RED.events, 'flows:started');
      await RED.nodes.setFlows(nodes);
      await deployed;
      for (const tc of allCases) {
        const results = {};
        // V8's native parse/TypeError wording can differ between Node 20 and
        // Node 22. Freeze comparisons against the original body on THIS runtime.
        const oracle = await execute(baseline.nodes.find(node => node.id === tc.id), tc, moduleRoot);
        for (const phase of ['before', 'after']) {
          const state = environment(tc, moduleRoot);
          if (phase === 'after') {
            state.deps.osiLib = require('./valve-ingress-x2-adapters').entryBridge(vc, state.deps.osiLib);
          }
          let finish;
          const completed = new Promise(resolve => { finish = resolve; });
          context.pending = { deps: state.deps, ports: [], complete: finish, value: undefined, error: null, hadId: Object.hasOwn(state.msg, '_msgid'), capture(value, error) { this.outputs = Array.isArray(value) ? Array.from(value) : value == null ? [] : [value]; this.result = snapshot(state, value, error); } };
          RED.nodes.getNode(phase + '-' + tc.id).receive(state.msg);
          await completed;
          // Function.sendResults runs after the wrapper promise resolves.
          // Two turns drain its routing queue without timing sleeps.
          await new Promise(setImmediate);
          await new Promise(setImmediate);
          const pending = context.pending;
          const result = pending.result;
          assert.deepEqual(result, oracle, `${profile}/${tc.name}/${phase}: original body on release Node`);
          const outputs = pending.outputs; // sendResults mutates its returned array into per-port message lists.
          const expected = outputs.flatMap((msg, port) => msg == null ? [] : ['sink','mirror'].map(receiver => ({ port, receiver, msg })));
          assert.deepEqual(normalize(pending.ports, state), normalize(expected, state), `${tc.name}/${phase}: actual runtime emitted ports and identities`);
          results[phase] = result;
        }
        assert.deepEqual(results.after, results.before, profile + '/' + tc.name);
        evidence.push({ profile, case: tc.name, ...results });
      }
    }
    if (process.env.X2_EVIDENCE) fs.writeFileSync(process.env.X2_EVIDENCE, JSON.stringify({ node: process.version, nodeRed: version, cases: evidence, runtimeWarnings: logs }, null, 2) + '\n');
    console.log(`X2 actual Function runtime: ${allCases.length} cases x 2 profiles x before/after, Node ${process.versions.node}, Node-RED ${version}: identical`);
  } finally {
    await RED.stop();
    clearTimeout(watchdog);
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}
if (require.main === module) main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
module.exports = { main };
