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
const { flowState } = require('./lib/daily-scheduler-adapters');
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
  const state = { ports: [], caught: [], responses: [], complete: [], diagnostics: [], statuses: [], schedulerLogs: [], recorded: [] };
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
  const find = id => { const n=shipped.find(n=>n.id===id);assert.ok(n,'missing shipped topology '+id);return structuredClone(n); };
  const schedulerTab = find('a0a61f4b7dca1c2e').z;
  const boundaryIds = {
    zones: ['d7ad7b3d0c9e0b8a'], mean: ['f4f8af0d3a4f3e5c'],
    decide: ['b64b9e8c1a0e2c77','2cb3b5c1a3d0e5f7','3a0d9d0f1a1b2c3d'],
    decode: ['697f8cfd92ccf539','device-response'],
    validate: ['bda5f35469bb5fc6','device-response'],
    upsert: ['899ec5378779ad86','device-response'],
  };
  const entryById = Object.fromEntries(baseCases().map(c=>[c.id,c.entry]));
  const flow = [find('device-api-tab'),find(schedulerTab),find('93b1537a596e0e6d')];
  const sqlIds = new Set();
  for (const original of legacy) {
    const node = source.find(n => n.id === original.id);
    let body = node.func;
    if (variant === 'adapter' && ['extra-port','duplicate'].includes(negative) && node.id === '70fcbea336401bd1') {
      body = (negative === 'extra-port' ? 'node.send([null, { payload: "extra-port" }]);\n' : 'node.send(msg);\n') + body;
    }
    const wrapped = 'return (function(env, global, Date) {\n' + body + '\n})(global.get("x1io").active.deps.env, global.get("x1io").active.deps.global, global.get("x1io").active.deps.Date);';
    const targets=boundaryIds[entryById[node.id]];
    flow.push({ ...node, func: wrapped,
      wires: Array.from({ length: node.outputs }, (_, port) => ['port-' + node.id + '-' + port,targets[port]]) });
    for (let port = 0; port < node.outputs; port++) {
      flow.push({ id: 'port-' + node.id + '-' + port, type: 'x1-sink', z: node.z, x: 600, y: 100, kind: 'port', source: node.id, port, wires: [] });
      const id=targets[port];
      if(id==='device-response')continue;
      if(!sqlIds.has(id)) {sqlIds.add(id);flow.push({...find(id),type:find(id).type==='sqlite'?'x1-sqlite':'x1-actuator',boundaryType:find(id).type,wires:[]});}
    }
  }
  for(const tab of ['device-api-tab',schedulerTab]) {
    const scoped=[...ids].filter(id=>find(id).z===tab);
    flow.push({ id: 'x1-complete-'+tab, type: 'complete', z: tab, x: 600, y: 300, scope: scoped, wires: [['complete-sink-'+tab]] });
    flow.push({ id: 'complete-sink-'+tab, type: 'x1-sink', z: tab, x: 800, y: 300, kind: 'complete', wires: [] });
  }
  // Keep shipped Catch scopes and links. Only their logger/recorder IO ends
  // are doubled. A collector cannot manufacture a SQL error source ID.
  for(const id of ['device-api-catch','record-error-catch-device-api','f7-scheduler-write-catch','record-error-catch-scheduler']) {
    const n=find(id);
    if(variant==='adapter'&&negative==='scheduler-catch-wire'&&id==='f7-scheduler-write-catch')n.wires=[[]];
    n.wires[0].push('tap-'+id);flow.push(n);
    flow.push({id:'tap-'+id,type:'x1-sink',z:n.z,x:900,y:500,kind:'caught',source:id,wires:[]});
  }
  for(const id of ['record-error-link-out-device-api','record-error-link-out-scheduler','record-error-link-in'])flow.push(find(id));
  flow.push({...find('f7-scheduler-write-log'),type:'x1-sink',kind:'schedulerLogs'});
  flow.push({...find('record-error-fn'),type:'x1-sink',kind:'recorded'});
  flow.push(formatter);
  flow.push({...find('device-response'),type:'x1-sink',kind:'responses'});
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
      if (config.kind === 'port') state.ports.push({ port: config.port, message: clean(msg) });
      else if(config.kind==='caught') state.caught.push({catchId:config.source,message:clean(msg)});
      else state[config.kind].push(clean(msg));
      if (['complete', 'caught'].includes(config.kind)) done();
      complete();
    });
  });
  RED.nodes.registerType('x1-sqlite', function(config) {
    RED.nodes.createNode(this, config);
    this.type = config.boundaryType; // retain real SQLite source metadata on the IO double
    this.on('input',(msg,send,complete)=>{
      const c=active.c, fault=c.boundaryFault;
      if(fault && boundaryIds[c.entry][fault.port]===config.id)complete(new Error('synthetic SQL '+fault.label));
      else complete();
    });
  });
  RED.nodes.registerType('x1-actuator', function(config) { RED.nodes.createNode(this,config); this.on('input',(msg,send,complete)=>complete()); });
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
      for(let drain=0;drain<8;drain++)await immediate();
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
  const capture = process.argv.includes('--capture-topology');
  const oracleFile = path.join(__dirname, 'fixtures/daily-scheduler/native-topology-expected-' + version + '.json');
  const { verifyFrozen, createExclusive } = require('./lib/daily-scheduler-oracles');
  verifyFrozen(); if(capture) assert.ok(!fs.existsSync(oracleFile), 'native oracle is write-once');
  const oracle = capture ? {} : JSON.parse(fs.readFileSync(oracleFile));
  const priorPorts = JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/daily-scheduler/native-expected-'+version+'.json')));
  const negative = process.argv.includes('--negative-extra-port') ? 'extra-port' : process.argv.includes('--negative-duplicate-send') ? 'duplicate' : process.argv.includes('--negative-scheduler-catch-wire') ? 'scheduler-catch-wire' : '';
  const profileStates=PROFILES.map(p=>flowState(JSON.parse(fs.readFileSync(path.join(ROOT,'conf',p,'files/usr/share/flows.json')))));
  assert.equal(new Set(profileStates).size,1,'profiles must share integration state');
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
        if(priorPorts[profile][c.name]) {
          assert.deepStrictEqual(observations.legacy[c.name].ports,priorPorts[profile][c.name].ports,c.name+' original native port oracle retained');
          assert.deepStrictEqual(observations.legacy[c.name].trace,priorPorts[profile][c.name].trace,c.name+' original native IO oracle retained');
        }
        const missing = c.loaderOutage && ['auth-valid','validate-save','upsert-version-4-enabled-1'].some(seed=>c.name.endsWith('-'+seed));
        for(const variant of ['adapter','shipped']) {
        const extracted=variant==='adapter'||profileStates[0]==='integrated';
        if(missing && extracted) {
          const after=observations[variant][c.name];
          assert.equal(after.ports.length,1,c.name+' one response');assert.equal(after.ports[0].port,1);assert.equal(after.ports[0].message.statusCode,503);
          assert.equal(after.caught.length,0,'503 is a reply, not a duplicate Catch response');
          assert.ok(after.diagnostics.some(d=>d.message.includes('daily-scheduler unavailable')));
        } else {
          try { assert.deepStrictEqual(observations[variant][c.name], observations.legacy[c.name], profile + '/'+variant+'/' + c.name); }
          catch(error) { throw new Error('NATIVE_PORT_PARITY_MISMATCH '+profile+'/'+variant+'/'+c.name+' ports '+observations[variant][c.name].ports.length+' vs '+observations.legacy[c.name].ports.length, { cause: error }); }
        }
        }
        if(c.scopeReadFailure) {const out=observations.adapter[c.name];assert.equal(out.ports[0].message.statusCode,500);assert.equal(out.trace.filter(t=>t[0]==='real-scope-sql').length,c.scopeReadFailure,'real scope failure boundary reached');}
        if(c.name==='native-spring-jump') assert.ok(observations.legacy[c.name].ports.find(p=>p.port===1).message.topic.includes('clock_jump_backward_suppressed'),'spring jump keeps UTC window');
        if(c.boundaryFault) {
          const out=observations.adapter[c.name], scheduler=['zones','mean','decide'].includes(c.entry);
          const expected={zones:'d7ad7b3d0c9e0b8a',mean:'f4f8af0d3a4f3e5c',decode:'697f8cfd92ccf539',validate:'bda5f35469bb5fc6',upsert:'899ec5378779ad86',decide:c.boundaryFault.port===1?'2cb3b5c1a3d0e5f7':'3a0d9d0f1a1b2c3d'}[c.entry];
          assert.ok(out.caught.some(m=>m.message.error.source.id===expected),c.name+' correct SQLite source');
          assert.equal(out.recorded.length,1,c.name+' error recorder delivery');
          assert.equal(out.schedulerLogs.length,c.entry==='decide'?1:0,c.name+' scheduler write logger delivery');
          assert.equal(out.responses.length,scheduler?0:1,c.name+' API disposition separate from scheduler errors');
          if(!scheduler)assert.equal(out.responses[0].statusCode,500);
        }
        if(c.name.startsWith('native-scoped-invalid-zone-')&&!c.name.endsWith('scope-load-first')) {
          const out=observations.adapter[c.name];assert.equal(out.responses[0].statusCode,400);assert.equal(out.responses[0].payload.message,'Invalid zone ID');assert.ok(!out.trace.some(t=>t[0]==='db-open'));
        }
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
