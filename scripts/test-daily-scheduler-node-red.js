#!/usr/bin/env node
'use strict';
// Native Function ports, completion and device-API Catch routing. Only IO,
// configuration and clock are doubled; node.send/error/done stay Node-RED's.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { cases: baseCases } = require('./lib/daily-scheduler-cases');
const { additionalCases, nativeBoundaryCases } = require('./lib/daily-scheduler-additional-cases');
const cases = () => [...baseCases(), ...additionalCases(), ...nativeBoundaryCases()];
const { PROFILES, ROOT, dependencies, normalize } = require('./lib/daily-scheduler-harness');
const { runtimeConfig } = require('./lib/release-smoke-runtimes');
const legacy = require('./fixtures/daily-scheduler/legacy-nodes.json');
const adapters = require('./fixtures/daily-scheduler/adapters.json');
const { createExclusive } = require('./lib/daily-scheduler-oracles');
const immediate = () => new Promise(resolve => setImmediate(resolve));
function clean(value) {
  if (value instanceof Error || (value && value.message && value.stack)) {
    const out = { message: value.message, ...value }; delete out.stack; return clean(out);
  }
  if (Array.isArray(value)) return Array.from(value, clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(k => k !== 'stack').map(k => [k, clean(value[k])]));
  return value;
}
async function child(profile, variant, output, negative) {
  const RED = require(process.env.OSI_X1_NODE_RED);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-native-'));
  const source = variant === 'legacy' ? legacy : variant === 'adapter' ? adapters : JSON.parse(fs.readFileSync(path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json')));
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json')));
  const formatter = shipped.find(n => n.id === 'device-api-http500');
  let active, done, timeout;
  const state = { ports: [], caught: [], responses: [], complete: [], diagnostics: [], statuses: [] };
  const ids = new Set(legacy.map(n => n.id));
  global.__x1NativeIO = { get active() { return active; } };
  const realRandom = crypto.randomBytes;
  crypto.randomBytes = function(n, ...args) { return active && n === 48 && !args.length ? active.deps.crypto.randomBytes(n) : realRandom.call(this, n, ...args); };
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  const deps = {};
  for (const [name, code] of Object.entries({
    'osi-lib': 'module.exports = { require(name) { return global.__x1NativeIO.active.deps.osiLib.require(name); } };',
    'osi-db-helper': 'module.exports = { Database: function(...args) { return new global.__x1NativeIO.active.deps.osiDb.Database(...args); } };',
  })) {
    const pkg = path.join(dir, name); fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), code);
    fs.symlinkSync(pkg, path.join(dir, 'node_modules', name)); deps[name] = 'file:' + name;
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: deps }));
  const flow = [{ id: 'device-api-tab', type: 'tab', label: 'X1 native parity' }];
  for (const original of legacy) {
    const node = source.find(n => n.id === original.id);
    let body = node.func;
    if (variant === 'adapter' && negative && node.id === '70fcbea336401bd1') {
      body = (negative === 'extra-port' ? 'node.send([null, { payload: "extra-port" }]);\n' : 'node.send(msg);\n') + body;
    }
    const wrapped = 'return (function(env, global, Date) {\n' + body + '\n})(global.get("x1io").active.deps.env, global.get("x1io").active.deps.global, global.get("x1io").active.deps.Date);';
    flow.push({ ...node, z: 'device-api-tab', func: wrapped, outputs: node.outputs,
      wires: Array.from({ length: node.outputs }, (_, port) => ['port-' + node.id + '-' + port]) });
    for (let port = 0; port < node.outputs; port++) {
      flow.push({ id: 'port-' + node.id + '-' + port, type: 'x1-sink', z: 'device-api-tab', x: 600, y: 100, kind: 'port', source: node.id, port, wires: [] });
    }
  }
  flow.push({ id: 'x1-complete', type: 'complete', z: 'device-api-tab', x: 600, y: 300, scope: [...ids], wires: [['complete-sink']] });
  flow.push({ id: 'complete-sink', type: 'x1-sink', z: 'device-api-tab', x: 800, y: 300, kind: 'complete', wires: [] });
  flow.push({ id: 'x1-catch', type: 'catch', z: 'device-api-tab', x: 600, y: 400, scope: [...ids, ...flow.filter(n=>n.type==='x1-sink'&&n.kind==='port').map(n=>n.id)], uncaught: false, wires: [['catch-sink', formatter.id]] });
  flow.push({ id: 'catch-sink', type: 'x1-sink', z: 'device-api-tab', x: 800, y: 400, kind: 'caught', wires: [] });
  flow.push({ ...formatter, wires: [['response-sink']] });
  flow.push({ id: 'response-sink', type: 'x1-sink', z: 'device-api-tab', x: 1000, y: 400, kind: 'responses', wires: [] });
  fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flow));
  const server = http.createServer();
  RED.init(server, { userDir: dir, flowFile: 'flows.json', httpAdminRoot: false, httpNodeRoot: false,
    functionExternalModules: true, functionGlobalContext: { x1io: global.__x1NativeIO },
    externalModules: { autoInstall: false, modules: { allowInstall: false } },
    logging: { console: { level: 'off' }, x1: { level: 'trace', handler() { return event => {
      if (active && (ids.has(event.id) || event.id === formatter.id || String(event.id).startsWith('port-')) && event.level <= 30) state.diagnostics.push({ id: event.id, level: event.level, message: typeof event.msg === 'object' ? event.msg.message : String(event.msg) });
    }; } } }, credentialSecret: 'synthetic-x1-native' });
  RED.events.on('node-status', event => { if(active && ids.has(event.id)) state.statuses.push(clean(event)); });
  RED.nodes.registerType('x1-sink', function(config) {
    RED.nodes.createNode(this, config);
    this.on('input', (msg, send, complete) => {
      if (!active) throw new Error('late message outside active case');
      if (config.kind === 'port') {
        state.ports.push({ port: config.port, message: clean(msg) });
        if (active.c.boundaryFault && active.c.boundaryFault.port === config.port) { complete(new Error('synthetic SQL ' + active.c.boundaryFault.label)); return; }
      }
      else state[config.kind].push(clean(msg));
      if (['complete', 'caught'].includes(config.kind)) done();
      complete();
    });
  });
  const started = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('native flows startup timeout')), 15000);
    RED.events.once('flows:started', () => { clearTimeout(timeout); resolve(); });
  });
  const results = {};
  try {
    await RED.start(); await started;
    for (const c of cases()) {
      for (const list of Object.values(state)) list.length = 0;
      active = { c, deps: dependencies(c, profile) };
      if(c.scopeReadFailure) {
        const dbfile=path.join(dir,'scope.db');if(fs.existsSync(dbfile))fs.unlinkSync(dbfile);
        execFileSync('sqlite3',[dbfile],{input:fs.readFileSync(path.join(ROOT,'database/seed-blank.sql'),'utf8')+"\nINSERT INTO users(id,username,password_hash,user_uuid,created_at,role) VALUES(1,'actor''s name','h','synthetic-actor','2026-01-01','researcher'); INSERT INTO irrigation_zones(id,name,user_id,zone_uuid) VALUES(2,'Synthetic',1,'synthetic-zone');"});
        const scope=require(path.join(ROOT,'conf',profile,'files/usr/share/node-red/osi-scope-helper'));scope._resetForTests();
        const previous=active.deps.osiLib;let reads=0;
        active.deps.osiLib={require(name){if(name==='scope'){active.deps.trace.push(['require',name]);return {ok:true,value:scope};}return previous.require(name);}};
        active.deps.osiDb={Database:class {
          async query(sql,params,all) {
            reads++;active.deps.trace.push(['real-scope-sql',reads,sql,params]);if(reads===c.scopeReadFailure)throw new Error('synthetic scope SQL '+reads);
            let i=0;const bound=sql.replace(/\?/g,()=>{const v=params[i++];return typeof v==='number'?String(v):"'"+String(v).replace(/'/g,"''")+"'";});
            const text=execFileSync('sqlite3',['-json',dbfile,bound],{encoding:'utf8'}).trim();const rows=text?JSON.parse(text):[];return all?rows:rows[0];
          }
          get(sql,params){return this.query(sql,params,false);}
          all(sql,params){return this.query(sql,params,true);}
          close(cb){active.deps.trace.push(['real-scope-close']);cb();}
        }};
      }
      const input = structuredClone(c.msg); input._msgid ||= 'x1-native';
      if (['decode', 'validate', 'upsert'].includes(c.entry)) input.res = {};
      const settled = new Promise((resolve, reject) => { done = resolve; timeout = setTimeout(() => reject(new Error('native completion timeout: ' + c.name)), 3000); });
      RED.nodes.getNode(c.id).receive(input);
      await settled; clearTimeout(timeout);
      // Native send dispatch, Catch, formatter and collector completion drain
      // through the event loop before any observations are compared.
      await immediate(); await immediate(); await immediate();
      const trace = active.deps.trace.filter(t => !(t[0] === 'require' && t[1] === 'daily-scheduler'));
      results[c.name] = normalize(clean({ ...state, trace }));
    }
    createExclusive(output, results);
  } finally {
    active = null; clearTimeout(timeout); await RED.stop(); server.close();
    crypto.randomBytes = realRandom; delete global.__x1NativeIO;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function main() {
  const image = runtimeConfig('image'), stock = runtimeConfig('stock');
  assert.equal(process.versions.node, image.node);
  const pkg = process.env.OSI_X1_NODE_RED; assert.ok(pkg && path.isAbsolute(pkg));
  const version = require(path.join(pkg, 'package.json')).version; assert.ok([image.nodeRed, stock.nodeRed].includes(version));
  if (process.argv[2] === '--child') return child(...process.argv.slice(3));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-native-results-'));
  const capture = process.argv.includes('--capture-native');
  const oracleFile = path.join(__dirname, 'fixtures/daily-scheduler/native-expected-' + version + '.json');
  const { verifyFrozen, createExclusive } = require('./lib/daily-scheduler-oracles');
  verifyFrozen(); if(capture) assert.ok(!fs.existsSync(oracleFile), 'native oracle is write-once');
  const oracle = capture ? {} : JSON.parse(fs.readFileSync(oracleFile));
  const negative = process.argv.includes('--negative-extra-port') ? 'extra-port' : process.argv.includes('--negative-duplicate-send') ? 'duplicate' : '';
  let count = 0, catches = 0;
  try {
    for (const profile of PROFILES) {
      const observations = {};
      for (const variant of ['legacy', 'shipped', 'adapter']) {
        const output = path.join(dir, profile + '-' + variant + '.json');
        const run = spawnSync(process.execPath, [__filename, '--child', profile, variant, output, negative], { env: process.env, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
        assert.ifError(run.error); assert.equal(run.status, 0, run.stdout + run.stderr);
        observations[variant] = JSON.parse(fs.readFileSync(output));
      }
      if(capture) oracle[profile]=observations.legacy;
      else assert.deepStrictEqual(observations.legacy,oracle[profile],profile+' frozen native oracle');
      for (const c of cases()) {
        assert.deepStrictEqual(observations.shipped[c.name], observations.legacy[c.name], profile+'/shipped/'+c.name);
        const missing = c.loaderOutage && ['auth-valid','validate-save','upsert-version-4-enabled-1'].some(seed=>c.name.endsWith('-'+seed));
        if(missing) {
          const after=observations.adapter[c.name];
          assert.equal(after.ports.length,1,c.name+' one response');assert.equal(after.ports[0].port,1);assert.equal(after.ports[0].message.statusCode,503);
          assert.equal(after.caught.length,0,'503 is a reply, not a duplicate Catch response');
          assert.ok(after.diagnostics.some(d=>d.message.includes('daily-scheduler unavailable')));
        } else {
          try { assert.deepStrictEqual(observations.adapter[c.name], observations.legacy[c.name], profile + '/adapter/' + c.name); }
          catch(error) { throw new Error('NATIVE_PORT_PARITY_MISMATCH '+profile+'/'+c.name+' ports '+observations.adapter[c.name].ports.length+' vs '+observations.legacy[c.name].ports.length, { cause: error }); }
        }
        if(c.scopeReadFailure) {const out=observations.adapter[c.name];assert.equal(out.ports[0].message.statusCode,500);assert.equal(out.trace.filter(t=>t[0]==='real-scope-sql').length,c.scopeReadFailure,'real scope failure boundary reached');}
        if(c.name==='native-spring-jump') assert.ok(observations.legacy[c.name].ports.find(p=>p.port===1).message.topic.includes('clock_jump_backward_suppressed'),'spring jump keeps UTC window');
        if(c.boundaryFault) assert.ok(observations.adapter[c.name].caught.some(m=>m.error.message.includes(c.boundaryFault.label)),c.name+' native SQL Catch');
        catches += observations.legacy[c.name].caught.length;
        count++;
      }
      assert.ok(observations.legacy['auth-missing-request'].caught.length, 'rejected Promise reached native Catch');
      assert.equal(observations.adapter['auth-missing-request'].responses[0].statusCode, 401, 'native device-API Catch retains bearer classification');
    }
    assert.ok(catches > 0);
    if(capture) createExclusive(oracleFile,oracle);
    console.log(`daily-scheduler native Node-RED parity: OK (Node ${process.versions.node}, Node-RED ${version}, ${count} cases, ${catches} Catch deliveries, both profiles)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
