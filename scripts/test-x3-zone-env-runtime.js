#!/usr/bin/env node
'use strict';
// Run the SAME characterization cases in a real Node-RED function-node VM.
// SQL/HTTP boundaries stay local and recorded, exactly as in the Node harness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execute, LEGACY, PROFILES, FIXTURES, share } = require('./lib/x3-zone-env-harness');
async function main() {
  const runtimeDir = process.env.X3_NODE_RED_DIR;
  assert.ok(runtimeDir, 'X3_NODE_RED_DIR must name the installed node-red package');
  const runtime = require(path.join(runtimeDir, 'package.json'));
  assert.ok(['3.1.15', '4.0.9'].includes(runtime.version));
  assert.equal(process.versions.node, '20.18.3');
  const RED = require(runtimeDir);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-nodered-'));
  const globalContext = { x3: { deps: null } };
  let pending;
  RED.init(null, { userDir, httpAdminRoot: false, httpNodeRoot: false, disableEditor: true,
    functionExternalModules: false, functionGlobalContext: globalContext,
    logging: { console: { level: 'off' } }, editorTheme: { projects: { enabled: false } } });
  RED.nodes.registerType('x3-capture', function(config) {
    RED.nodes.createNode(this, config);
    this.on('input', msg => pending?.capture(config.port, msg));
  });
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected.json')));
  const cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cases.json')));
  let count = 0;
  let deployedFunction = null;
  await RED.start();
  async function executor(source, msg, deps) {
    // Bind only the libraries actually declared by the selected node. This
    // avoids npm installation in Node-RED and keeps host IO under the harness.
    globalContext.x3.deps = deps;
    const bind = (source.libs || []).map(lib => `const ${lib.var} = __deps.${lib.var};`).join('\n');
    const func = `const __deps = global.get('x3').deps;\nglobal.set('fs', __deps.global.get('fs'));\nconst Date = __deps.Date;\nconst env = __deps.env;\nfor (const key of ['warn','error','log','status','send']) node[key] = __deps.node[key];\n${bind}\nreturn (async () => { try { return await (async () => { ${source.func} })(); } catch (error) { return { _x3Thrown: { name: error.name, message: error.message } }; } })();`;
    const functionNode = { ...source, id: 'x3-function', z: 'x3-tab', libs: [], func,
      wires: Array.from({ length: Number(source.outputs) }, (_, i) => ['x3-output-' + i]) };
    const flows = [{ id: 'x3-tab', type: 'tab', label: 'X3 parity' }, functionNode,
      ...Array.from({ length: Number(source.outputs) }, (_, i) => ({ id: 'x3-output-' + i, type: 'x3-capture', z: 'x3-tab', port: i, wires: [] }))];
    if (deployedFunction !== func) {
      await RED.nodes.setFlows(flows);
      deployedFunction = func;
    }
    RED.nodes.getNode('x3-function').context().global.set('x3', { deps });
    return new Promise((resolve, reject) => {
      const outputs = Array(Number(source.outputs)).fill(null);
      let timer;
      pending = { capture(port, value) {
        outputs[Number(port)] = value;
        clearTimeout(timer);
        pending = null;
        if (value._x3Thrown) { const e = new Error(value._x3Thrown.message); e.name = value._x3Thrown.name; reject(e); return; }
        resolve(Number(source.outputs) === 1 ? value : outputs);
      } };
      timer = setTimeout(() => { pending = null; reject(new Error('Node-RED did not emit an output')); }, 10000);
      RED.nodes.getNode('x3-function').receive(msg);
    });
  }
  try {
    for (const profile of PROFILES) {
      const current = JSON.parse(fs.readFileSync(path.join(share(profile), 'flows.json')));
      for (const mode of ['legacy', 'adapter']) {
        for (const c of cases) {
          const source = mode === 'legacy' ? LEGACY.find(n => n.id === c.node) : require('./x3-zone-env-adapters').adaptNode(current.find(n => n.id === c.node));
          const result = await execute(profile, source, c, executor);
          // Node-RED copies its outgoing message. Verify every output port and
          // all side effects, then the input object separately in the Node test.
          delete result.msg;
          const wanted = { ...expected[c.name] }; delete wanted.msg;
          assert.deepEqual(result, wanted, `${runtime.version} ${profile} ${mode} ${c.name}`);
          count++;
        }
      }
    }
    console.log(`X3 Node-RED ${runtime.version} / Node ${process.versions.node}: ${count} exact traces, before and after x both profiles; TZ=${process.env.TZ}`);
  } finally { await RED.stop(); fs.rmSync(userDir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
