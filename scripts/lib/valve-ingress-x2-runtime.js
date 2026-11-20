'use strict';
// Native Function nodes, declared libraries, native completion and Catch routing.
// Only filesystem, database and RPC bindings are doubles. No Function API is replaced.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { environment, normalize, FixedDate } = require('./valve-ingress-x2-harness');
const { baseline, allCases, ROOT } = require('../test-valve-ingress-x2-parity');
const nativeCases=[...allCases,...require('./valve-ingress-x2-additive-cases').cases()];
const { adaptFlows, entryBridge, DIAGNOSTICS, comparable } = require('./valve-ingress-x2-adapters');
const turns = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
async function main() {
  require('./valve-ingress-x2-frozen').pinnedSource();
  const runtimePath = process.env.X2_NODE_RED;
  assert.ok(runtimePath && path.isAbsolute(runtimePath), 'X2_NODE_RED must be an absolute package path');
  const pins = require('./release-smoke-runtimes').parseVersions(fs.readFileSync(path.join(ROOT, '.github/workflows/release-smoke.yml'), 'utf8'));
  assert.equal(process.versions.node, pins.node, 'release Node pin');
  const version = require(path.join(runtimePath, 'package.json')).version;
  assert.ok([pins.image, pins.stock].includes(version), 'release Node-RED pin');
  const control = process.argv.find(a => a.startsWith('--control='))?.split('=')[1];
  assert.ok(!control || ['extra-port', 'returned-auth'].includes(control), 'unknown native control');
  const RED = require(runtimePath);
  const generateId = RED.util.generateId;
  RED.util.generateId = (...args) => active ? 'native-generated-' + (++active.idCounter) : generateId(...args);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valve-x2-native-'));
  fs.writeFileSync(path.join(runDir,'flows.json'), JSON.stringify([{id:'x2-tab',type:'tab',label:'X2 initial'}]));
  const bridgeFile = path.join(runDir, 'bridge.cjs');
  fs.writeFileSync(bridgeFile, 'module.exports = {};\n');
  const bridge = require(bridgeFile);
  let active;
  // These packages are imported by Node-RED from the unchanged declared libs.
  for (const [name, binding] of [['osi-lib','osiLib'], ['osi-db-helper','osiDb'], ['osi-chirpstack-helper','chirpstack']]) {
    const dir = path.join(runDir, 'node_modules', name);
    fs.mkdirSync(dir, {recursive:true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version:'1.0.0', main:'index.js'}));
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = require(${JSON.stringify(bridgeFile)}).${binding};\n`);
  }
  bridge.osiLib = {require: name => active.state.deps.osiLib.require(name)};
  bridge.osiDb = {Database: function(...args) {return new active.state.deps.osiDb.Database(...args);}};
  bridge.chirpstack = {createProvisioningClientFromEnv: (...args) => active.state.deps.chirpstack.createProvisioningClientFromEnv(...args)};
  fs.writeFileSync(path.join(runDir, 'package.json'), JSON.stringify({name:'x2-native-fixture',version:'1.0.0',dependencies:{'osi-lib':'1.0.0','osi-db-helper':'1.0.0','osi-chirpstack-helper':'1.0.0'}}));
  const native = {Date, setTimeout, clearTimeout, uuid:crypto.randomUUID, bytes:crypto.randomBytes};
  const watchdog = native.setTimeout(() => { console.error('X2 native runtime timeout'); process.exit(1); }, 60000);
  global.Date = FixedDate;
  crypto.randomUUID = (...args) => active ? active.state.deps.crypto.randomUUID(...args) : native.uuid(...args);
  crypto.randomBytes = (...args) => active ? active.state.deps.crypto.randomBytes(...args) : native.bytes(...args);
  global.setTimeout = (callback, ms, ...args) => {
    if (!active || ms !== 3000) return native.setTimeout(callback, ms, ...args);
    active.state.effects.push(['timer', ms]);
    if (active.tc.options?.timerError) throw new Error('fixture timer failed');
    const handle = native.setTimeout(() => {}, 2147480000);
    active.timers.push({handle, fire: () => callback(...args)});
    return handle;
  };
  const server = http.createServer();
  const evidence = [];
  RED.init(server, {
    userDir:runDir, flowFile:'flows.json', httpAdminRoot:false, httpNodeRoot:false, credentialSecret:false,
    functionExternalModules:true, externalModules:{autoInstall:false, modules:{allowInstall:false}},
    functionGlobalContext:{},
    logging:{console:{level:'off'}, capture:{level:'warn', handler:() => entry => {
      if (!active && entry.level <= 20) console.error('native bootstrap',entry.msg);
      if (active && entry.id === active.nodeId) active.diagnostics.push({level:entry.level,msg:entry.msg});
    }}},
  });
  RED.hooks.add('onComplete.x2', event => {
    if (active && event.node.id === active.nodeId) {
      active.events.push(['complete', event.error ? {name:event.error.name,message:event.error.message,statusCode:event.error.statusCode} : null]);
      active.complete();
    }
  });
  RED.hooks.add('onReceive.x2', event => {
    if (active && event.destination.id === active.nodeId && !Object.hasOwn(active.tc.msg, '_msgid')) delete event.msg._msgid;
  });
  try {
    const started = once(RED.events, 'flows:started');
    await RED.start(); await started;
    console.log('native runtime started');
    RED.nodes.registerType('x2-capture', function(config) {
      RED.nodes.createNode(this, config);
      this.on('input', (msg, send, done) => {
        assert.ok(active, 'unexpected delivery outside request');
        active.events.push([config.kind || 'output', config.port, config.receiver, msg]);
        if (done) done();
      });
    });
    for (const profile of ['bcm2712','bcm2709']) {
      const share = path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
      const moduleRoot = path.join(share, 'node-red/osi-valve-control');
      const ingress = require(path.join(share, 'node-red/osi-command-ingress'));
      const adapters = adaptFlows(JSON.parse(fs.readFileSync(path.join(share,'flows.json'))));
      const nodes = [{id:'x2-tab',type:'tab',label:'X2 native isolation'}];
      const functions = [];
      for (const phase of ['before','after']) for (const original of baseline.nodes) {
        const source = phase === 'before' ? original : adapters.find(n => n.id === original.id);
        let func = source.func;
        if (phase === 'after' && control === 'extra-port' && original.id === '934bf2bc19a8ce22') func = 'node.send([null, {payload:"unexpected-port"}]);\n' + func;
        if (phase === 'after' && control === 'returned-auth' && original.id === '83bb4a452dd9ae37') func = 'try { return await (async () => {\n' + func + '\n})(); } catch(error) { msg.statusCode=error.statusCode; return [null,null,msg]; }';
        const id = phase + '-' + source.id; functions.push(id);
        nodes.push({...source,id,z:'x2-tab',func,wires:Array.from({length:source.outputs},(_v,port)=>['sink-'+port,'mirror-'+port])});
      }
      for (let port=0;port<7;port++) for (const receiver of ['sink','mirror']) nodes.push({id:receiver+'-'+port,type:'x2-capture',z:'x2-tab',port,receiver,wires:[]});
      nodes.push({id:'native-catch',type:'catch',z:'x2-tab',scope:functions,uncaught:false,wires:[['catch-sink']]});
      nodes.push({id:'catch-sink',type:'x2-capture',z:'x2-tab',kind:'catch',receiver:'catch',wires:[]});
      const deployed = once(RED.events,'flows:started'); await RED.nodes.setFlows(nodes); await deployed;
      console.log('native functions deployed', profile);
      for (const tc of nativeCases) {
        if (control && tc.name !== (control === 'extra-port' ? 'route/open' : 'manual/missing-bearer')) continue;
        const results={};
        for (const phase of ['before','after']) {
          const state=environment(tc,moduleRoot);
          if (phase==='after') state.deps.osiLib=entryBridge(ingress,state.deps.osiLib);
          let complete;const completed=new Promise(resolve=>{complete=resolve;});
          active={tc,state,idCounter:0,events:[],diagnostics:[],timers:[],nodeId:phase+'-'+tc.id,complete};
          for(const key of ['AUTH_TOKEN_SECRET','JWT_SECRET','DEVICE_EUI','OSI_SCOPED_ACCESS']) {
            const value=state.deps.env.get(key);if(value===undefined)delete process.env[key];else process.env[key]=value;
          }
          const runtimeNode=RED.nodes.getNode(active.nodeId);
          runtimeNode.context().global.set('fs',state.deps.global.get('fs'));
          runtimeNode.context().global.set('cp',state.deps.global.get('cp'));
          runtimeNode.receive(state.msg);
          await completed; await turns();
          for (const timer of active.timers) {
            assert.ok(active.events.some(event=>event[0]==='output' && event[1]===2 && JSON.parse(event[3].payload).result==='SUCCESS'), 'reboot ACK observed before callback');
            active.events.push(['timer.fire-after-ACK']);native.clearTimeout(timer.handle);timer.fire();await turns();
          }
          // Node-RED supplies source ids and stacks. Keep the error message and
          // source identity, removing only phase labels and incidental stack frames.
          const scrub = value => {
            if (typeof value==='string') return functions.includes(value) ? value.replace(/^(?:before|after)-/,'') : value;
            if (!value || typeof value!=='object') return value;
            if (Array.isArray(value)) return value.map(scrub);
            return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='stack').map(([key,v])=>[key,scrub(v)]));
          };
          const diagnostic=entry=> typeof entry.msg==='string' && DIAGNOSTICS.test(entry.msg);
          results[phase]=scrub(normalize({events:active.events,diagnostics:active.diagnostics.filter(entry=>!diagnostic(entry)),effects:state.effects.filter(e=>e[0]!=='require'||e[1]!=='command-ingress')},state));
          const outputs=active.events.filter(event=>event[0]==='output');
          for (const event of outputs.filter(e=>e[2]==='sink')) assert.deepEqual(outputs.find(e=>e[1]===event[1] && e[2]==='mirror')?.[3],event[3],'both native receivers see same output');
          if ((!control || phase==='before') && (tc.name==='route/malformed-json'||tc.name==='manual/missing-bearer')) assert.equal(active.events.filter(e=>e[0]==='catch').length,1,'native thrown error reaches Catch exactly once');
          active=null;
        }
        assert.deepEqual(comparable(results.after),comparable(results.before),`X2 native differential ${profile}/${tc.name}${control?' control='+control:''}`);
        evidence.push({profile,case:tc.name,...results});
      }
    }
    if (process.env.X2_EVIDENCE) fs.writeFileSync(process.env.X2_EVIDENCE,JSON.stringify({node:process.version,nodeRed:version,cases:evidence},null,2)+'\n');
    console.log(`X2 native Function/Catch: ${nativeCases.length} cases x 2 profiles, Node ${process.versions.node}, Node-RED ${version}: identical`);
  } finally {
    active=null;await RED.stop();RED.util.generateId=generateId;native.clearTimeout(watchdog);
    global.Date=native.Date;global.setTimeout=native.setTimeout;crypto.randomUUID=native.uuid;crypto.randomBytes=native.bytes;
    fs.rmSync(runDir,{recursive:true,force:true});
  }
}
if (require.main===module) main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
module.exports={main};
