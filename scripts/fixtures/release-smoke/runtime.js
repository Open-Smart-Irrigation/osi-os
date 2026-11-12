'use strict';
// Derived from the v0.8.2 review's full-flow harness. Ordinary runs keep all
// function source, wiring, timer configuration, helpers and sandbox bindings.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const os = require('node:os'), net = require('node:net'), dns = require('node:dns');
const Module = require('node:module');
const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files');
const RUN = process.env.OSI_SMOKE_RUN;
if (!RUN || !path.isAbsolute(RUN)) throw new Error('OSI_SMOKE_RUN must name an isolated absolute scratch directory');
const DBFILE = path.join(RUN, 'data/db/farming.db');
const MARKER_PATH = '/var/run/osi-irrigation-clock.json';
const state = { marker: true, markerOverride: null, cs: { queue: {}, calls: [] }, mqtt: [], logs: [], exec: [], caught: [], received: [], sweep: [], sqlitePending: 0 };
fs.mkdirSync(path.dirname(DBFILE), {recursive:true});
fs.mkdirSync(path.join(RUN, 'var/run'), {recursive:true});
const nr = path.join(SRC, 'usr/share/node-red');
const dependencies = {};
for (const e of fs.readdirSync(nr, {withFileTypes:true})) {
  if (e.isDirectory() && (e.name.startsWith('osi-') || e.name === 'codecs')) {
    fs.cpSync(path.join(nr,e.name), path.join(RUN,e.name), {recursive:true});
    if (e.name !== 'codecs') dependencies[e.name] = 'file:' + e.name;
  }
}
fs.mkdirSync(path.join(RUN,'node_modules'), {recursive:true});
for (const name of Object.keys(dependencies)) fs.symlinkSync(path.join(RUN,name),path.join(RUN,'node_modules',name));
for (const name of fs.readdirSync(path.join(__dirname,'node_modules'))) {
  if (!fs.existsSync(path.join(RUN,'node_modules',name))) fs.symlinkSync(path.join(__dirname,'node_modules',name),path.join(RUN,'node_modules',name));
}
fs.copyFileSync(path.join(nr,'edge-channels.json'),path.join(RUN,'edge-channels.json'));
for (const name of ['bcryptjs','sqlite3']) dependencies[name] = require('./package.json').dependencies[name];
fs.writeFileSync(path.join(RUN,'package.json'),JSON.stringify({private:true,dependencies}));
fs.copyFileSync(path.join(SRC,'usr/share/flows.json'),path.join(RUN,'flows.json'));
// Negative controls alter only this disposable copy, never either image profile.
const controls={late:'valve-observe-fn',caught:'sync-outbox-build'};
const control=process.env.OSI_SMOKE_CONTROL;
if(control) {
  if(!controls[control])throw new Error('invalid smoke negative control');
  const flows=JSON.parse(fs.readFileSync(path.join(RUN,'flows.json'),'utf8'));
  flows.find(n=>n.id===controls[control]).func='smokeNegativeControlIdentifier;\n'+flows.find(n=>n.id===controls[control]).func;
  fs.writeFileSync(path.join(RUN,'flows.json'),JSON.stringify(flows));
}
Object.assign(process.env, {
  OSI_LIB_BASE: RUN, AUTH_TOKEN_SECRET: 'synthetic-smoke-secret', OSI_SCOPED_ACCESS:'0', TZ:'UTC',
  CHIRPSTACK_APP_ACTUATORS:'synthetic-actuators-app', CHIRPSTACK_APP_SENSORS:'synthetic-sensors-app',
  CHIRPSTACK_API_KEY:'synthetic', CHIRPSTACK_TENANT_ID:'synthetic-tenant',
  DEVICE_EUI:'0016C001F1000001', LINK_GATEWAY_DEVICE_EUI:'0016C001F1000001',
  OSI_CLOUD_BROKER_URL:'mqtt://127.0.0.1:1883', DEVICE_MQTT_PASSWORD:'synthetic',
});
let mqttPort;
// ---------- safety belts ----------
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const connectArgs = Array.isArray(a[0]) ? a[0] : a;
  const o = typeof connectArgs[0] === 'object' ? connectArgs[0] : { port: connectArgs[0], host: connectArgs[1] };
  const host = o.host || 'localhost';
  if (Number(o.port) === 1883 && ['127.0.0.1', 'localhost', '::1'].includes(host)) {
    if (typeof connectArgs[0] === 'object') o.port = mqttPort; else connectArgs[0] = mqttPort;
  }
  if (!o.path && ['127.0.0.1', 'localhost', '::1'].includes(host)) return realConnect.apply(this, a);
  state.logs.push({ t: Date.now(), level: 'NET_REFUSED', msg: host + ':' + o.port });

  process.nextTick(() => this.destroy(Object.assign(new Error('harness: outbound network refused ' + host), { code: 'ECONNREFUSED' })));
  return this;
};
const realLookup = dns.lookup;
dns.lookup = function (hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (['localhost', '127.0.0.1'].includes(hostname)) return realLookup.call(dns, hostname, options, cb);
  state.logs.push({t:Date.now(),level:'NET_REFUSED',msg:'dns:'+hostname});
  process.nextTick(() => cb(Object.assign(new Error('harness: dns refused ' + hostname), { code: 'ENOTFOUND' })));
};
function refuseExec(name) {
  return function (...a) {
    const cmd = [a[0], Array.isArray(a[1]) ? a[1].join(' ') : ''].join(' ').slice(0, 200);
    state.exec.push({ fn: name, cmd });
    const err = Object.assign(new Error('harness: exec refused: ' + cmd), { code: 'ENOENT' });
    const cb = a.find((x) => typeof x === 'function');
    if (name.endsWith('Sync')) { if (name === 'spawnSync') return { status: 127, error: err, stdout: '', stderr: '' }; throw err; }
    const ee = new (require('events').EventEmitter)(); ee.stdout = new (require('events').EventEmitter)(); ee.stderr = new (require('events').EventEmitter)(); ee.kill = () => {}; ee.stdin = { write() {}, end() {} };
    process.nextTick(() => { if (cb) cb(err, '', ''); if (ee.listenerCount('error')) ee.emit('error', err); ee.emit('close', 127); ee.emit('exit', 127); });
    return ee;
  };
}
const fakeCp = {}; for (const k of ['exec', 'execFile', 'spawn', 'execSync', 'execFileSync', 'spawnSync', 'fork']) fakeCp[k] = refuseExec(k);
// path remap for the function nodes' fs (functionGlobalContext.fs) and for the clock marker
function remap(p) {
  if (typeof p !== 'string' || p === RUN || p.startsWith(RUN + '/')) return p;
  if (p === MARKER_PATH || p.startsWith(MARKER_PATH)) return path.join(RUN, 'var/run', path.basename(p));
  if (p.startsWith('/data/') || p.startsWith('/srv/node-red') || p.startsWith('/var/run/') || p.startsWith('/var/lib/node-red') || p.startsWith('/etc/') || p.startsWith('/tmp/osi') || p.startsWith('/usr/share/') || p.startsWith('/usr/lib/node-red')) {
    if (p.startsWith('/srv/node-red')) return path.join(RUN, p.slice('/srv/node-red'.length));
    return path.join(RUN, p);
  }
  return p;
}
function mappedFs(target, prop) {
  const value=target[prop];
  if(typeof value!=='function')return value;
  return function(p,...rest) {
    // Preserve marker presence/absence even when a flow passes fs into a helper.
    const mapped=prop==='readFileSync'&&p===MARKER_PATH?p:remap(p);
    if(['rename','renameSync','copyFile','copyFileSync','cp','cpSync','link','linkSync','symlink','symlinkSync'].includes(prop))rest[0]=remap(rest[0]);
    return value.call(target,mapped,...rest);
  };
}
const fakeFs = new Proxy(fs, {get(target, prop) {
  if(prop==='promises')return new Proxy(target.promises,{get:(t,p)=>mappedFs(t,p)});
  return mappedFs(target,prop);
}});
// modules' own fs reads of the clock marker (osi-irrigation-policy/clock.js uses node:fs directly)
const realReadFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...r) {
  if (p === MARKER_PATH) {
    if (state.markerOverride !== null) { if (state.markerOverride === false) throw Object.assign(new Error('ENOENT marker'), { code: 'ENOENT' }); return JSON.stringify(state.markerOverride); }
    if (!state.marker) throw Object.assign(new Error('ENOENT marker'), { code: 'ENOENT' });
    return JSON.stringify(state.markerValue);
  }
  if (typeof p === 'string' && (p.startsWith('/var/run/osi-irrigation-clock') || p.startsWith('/data/') || p.startsWith('/srv/node-red/'))) return realReadFileSync.call(fs, remap(p), ...r);
  return realReadFileSync.call(fs, p, ...r);
};
for (const fn of ['writeFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'existsSync', 'statSync', 'readdirSync', 'appendFileSync', 'openSync', 'chmodSync', 'copyFileSync', 'rmSync', 'accessSync', 'lstatSync']) {
  const real = fs[fn];
  fs[fn] = function (p, ...r) {
    if (typeof p === 'string' && (p.startsWith('/var/run/osi-') || p.startsWith('/data/') || p.startsWith('/srv/node-red'))) {
      const q = remap(p); if (['renameSync', 'copyFileSync'].includes(fn) && typeof r[0] === 'string') r[0] = remap(r[0]);
      return real.call(fs, q, ...r);
    }
    return real.call(fs, p, ...r);
  };
}
// a marker as BusyBox ntpd's hook would have written it shortly after boot on this machine
(function makeMarker() {
  const bootId = realReadFileSync.call(fs, '/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const up = Number(realReadFileSync.call(fs, '/proc/uptime', 'utf8').trim().split(/\s+/)[0]);
  state.markerValue = { boot_id: bootId, epoch_ms: Date.now() - 60000, uptime_ms: Math.round(up * 1000) - 60000, stratum: 3 };
})();


// Keep the actual sqlite3 binding. Only absolute image paths are relocated.
const nativeSqlite = require('sqlite3');
const NativeDatabase = nativeSqlite.Database;
let observation;
// Observe completion of native operations that already have callbacks. Keep
// the product's binding, arguments, lock policy and callback result unchanged.
for(const method of ['all','get','run','exec','close']) {
  const original=NativeDatabase.prototype[method];
  NativeDatabase.prototype[method]=function(...args) {
    const index=args.length-1,callback=args[index];
    if(typeof callback!=='function')return original.apply(this,args);
    state.sqlitePending++;
    args[index]=function(...values) {
      state.sqlitePending--;observation?.touch();
      return callback.apply(this,values);
    };
    try{return original.apply(this,args);}catch(error){state.sqlitePending--;throw error;}
  };
}
class RelocatedDatabase extends NativeDatabase {
  constructor(filename, ...args) { super(remap(filename), ...args); }
}
nativeSqlite.Database = RelocatedDatabase;
const originalLoad = Module._load;
Module._load = function(request,parent,isMain) {
  if(parent?.filename?.startsWith(RUN)) {
    if(request==='child_process'||request==='node:child_process')return fakeCp;
    if(request==='fs'||request==='node:fs')return fakeFs;
  }
  return originalLoad.call(this,request,parent,isMain);
};

async function start() {
  // Prove both arguments of image-path renames stay inside this scratch root.
  fakeFs.writeFileSync('/data/smoke-fs-check.tmp','isolated');
  fakeFs.renameSync('/data/smoke-fs-check.tmp','/data/smoke-fs-check.txt');
  if(fs.readFileSync(path.join(RUN,'data/smoke-fs-check.txt'),'utf8')!=='isolated')throw new Error('filesystem path mapping failed');
  fakeFs.unlinkSync('/data/smoke-fs-check.txt');
  const broker = require('aedes')();
  const mqttServer = net.createServer(broker.handle);
  await new Promise(r=>mqttServer.listen(0,'127.0.0.1',r));
  mqttPort=mqttServer.address().port;
  broker.on('publish',(packet,client)=>{if(client) state.mqtt.push({topic:packet.topic,payload:packet.payload.toString()});});
  const weather=http.createServer((req,res)=>{
    state.weatherRequests=(state.weatherRequests||0)+1;
    if(req.method!=='POST'||req.url!=='/api/v1/history/hourly/') {res.writeHead(404);res.end();return;}
    req.resume();
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({data:Array.from({length:24},()=>({values:{temperature_2m:25,relative_humidity_2m:50,precipitation:0.225}}))}));
  });
  await new Promise(r=>weather.listen(0,'127.0.0.1',r));
  process.env.OPENAGRI_WEATHER_URL='http://127.0.0.1:'+weather.address().port;
  process.env.OPENAGRI_WEATHER_BEARER_TOKEN='synthetic-weather';
  const radio = await require('./radio').start(state);
  process.env.CHIRPSTACK_API_URL=radio.url;
  const RED=require('node-red'), express=require('express');
  const app=express(), server=http.createServer(app);
  // Use the image settings, including exactly os/fs/cp in global context.
  const settings=require(path.join(ROOT,'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js'));
  RED.init(server,{...settings,functionGlobalContext:{...settings.functionGlobalContext,fs:fakeFs,cp:fakeCp},userDir:RUN,flowFile:path.join(RUN,'flows.json'),httpStatic:undefined,
    externalModules:{modules:{allowInstall:false}},credentialSecret:false,
    logging:{console:{level:'off',metrics:false,audit:false}}});
  app.use('/',RED.httpNode);
  const emitter=new (require('node:events').EventEmitter)();
  emitter.on('log',e=>{if(e.level<=40) state.logs.push({t:Date.now(),level:e.level<=20?'error':e.level===30?'warn':'info',id:e.id,name:e.name,type:e.type,msg:typeof e.msg==='string'?e.msg:e.msg?.message||JSON.stringify(e.msg)});});
  RED.log.addHandler(emitter);
  // These third-party adapters are the outer LoRaWAN event boundary, not product logic.
  RED.nodes.registerType('osi-smoke','device event',function(n){RED.nodes.createNode(this,n);this.on('input',(msg,send,done)=>{send(msg);done();});});
  RED.nodes.registerType('osi-smoke','field_tester_service',function(n){RED.nodes.createNode(this,n);this.on('input',(msg,send,done)=>done());});
  observation=require('./observation').observe(RED,state);
  await RED.start();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  await sleep(2500);
  const flows=JSON.parse(fs.readFileSync(path.join(RUN,'flows.json'),'utf8'));
  // Initialization keeps its normal first 2.5 seconds. Later ticks are driven
  // explicitly, independent of host speed; no schedule or flow bytes change.
  require('./observation').pauseInjectTimers(RED,flows);
  await observation.settle(sleep);
  const client=require('mqtt').connect('mqtt://127.0.0.1:'+mqttPort);
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  const h={RED,state,RUN,DBFILE,sleep,
    flows,
    settle:()=>observation.settle(sleep),
    async sweepInjects(before=async()=>{},after=async()=>{}) {
      for(const config of require('./observation').enabledInjects(flows)) {
        await before(config);
        const index=state.received.length;
        h.inject(config.id,{});
        await observation.settle(sleep);
        const received=state.received.slice(index);
        const targets=config.wires.flat().filter(id=>RED.nodes.getNode(id));
        if(!targets.every(id=>received.includes(id)))throw new Error('inject did not reach targets: '+config.id);
        state.sweep.push({id:config.id,targets,received:[...new Set(received)]});
        await after(config);
      }
    },
    async writerLock() {
      const db=await new Promise((resolve,reject)=>{const d=new nativeSqlite.Database(DBFILE,e=>e?reject(e):resolve(d));});
      await new Promise((resolve,reject)=>db.run('BEGIN IMMEDIATE',e=>e?reject(e):resolve()));
      return async()=>{
        await new Promise((resolve,reject)=>db.run('ROLLBACK',e=>e?reject(e):resolve()));
        await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
      };
    },
    async sql(q,...params) {
      // One SQLite library owns every connection in this process. Mixing the
      // Node builtin and sqlite3 gives them separate in-process lock registries.
      let db;
      db=await new Promise((resolve,reject)=>{const d=new nativeSqlite.Database(DBFILE,e=>e?reject(e):resolve(d));});
      db.configure('busyTimeout',4000);
      try {
        return await new Promise((resolve,reject)=>{
          if(/^\s*(select|pragma|with)/i.test(q))db.all(q,params,(e,rows)=>e?reject(e):resolve(rows));
          else db.run(q,params,function(e){if(e)reject(e);else resolve({changes:this.changes,lastID:this.lastID});});
        });
      } finally {await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));}
    },
    inject(id,msg={payload:Date.now()}) {const n=RED.nodes.getNode(id);if(!n)throw new Error('missing node '+id);n.receive(msg);},
    setMarker(v){state.markerOverride=v;},
    async uplink(eui,bit){const payload={deduplicationId:require('node:crypto').randomUUID(),time:new Date().toISOString(),fCnt:++h.fcnt,fPort:4,deviceInfo:{devEui:eui.toLowerCase(),deviceProfileName:'OSI STREGA Valve',applicationId:'synthetic-actuators-app'},object:{Valve:String(bit),Battery:90,Temperature:21,Hygrometry:40}};await new Promise((resolve,reject)=>client.publish('application/synthetic-actuators-app/device/'+eui.toLowerCase()+'/event/up',JSON.stringify(payload),{qos:1},e=>e?reject(e):resolve()));await sleep(200);},fcnt:100,
    http(method,url,body,token,timeout=1200){return new Promise(resolve=>{
      let finished=false;const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);resolve(result);};
      const data=body===undefined?undefined:JSON.stringify(body),headers={};
      if(token) headers.authorization='Bearer '+token;
      if(data){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(data);}
      const request=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},response=>{let text='';response.on('data',c=>text+=c);response.on('end',()=>{let json;try{json=JSON.parse(text);}catch{json=null;}finish({status:response.statusCode,json,text});});});
      const timer=setTimeout(()=>{finish({timeout:true});request.destroy();},timeout);
      request.on('error',e=>finish({error:e.message}));request.end(data);
    });},
    async stop(){await new Promise(r=>client.end(true,r));await RED.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await radio.stop();await new Promise(r=>weather.close(r));await new Promise(r=>broker.close(r));await new Promise(r=>mqttServer.close(r));}
  };
  return h;
}
module.exports={start};
