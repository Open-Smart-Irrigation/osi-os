#!/usr/bin/env node
'use strict';
// Native function-node bindings, send, completion and Catch lifecycle. Only DB,
// provider transport, filesystem, environment and clock are test boundaries.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execute,LEGACY,PROFILES,FIXTURES,share}=require('./lib/x3-zone-env-harness');
const {cases:extra,assertCase}=require('./lib/x3-zone-env-extra-cases');
const {compare,assertOriginalBlobs}=require('./lib/x3-parity-contract');
const {adaptNode}=require('./x3-zone-env-adapters');
function plain(value) { return JSON.parse(JSON.stringify(value, (key,v)=>key==='stack'?undefined:v&&typeof v==='object'&&typeof v.message==='string'&&typeof v.name==='string'?{name:v.name,message:v.message}:v)); }
async function main() {
 assertOriginalBlobs();
 const runtimeDir=process.env.X3_NODE_RED_DIR;
 assert.ok(runtimeDir,'X3_NODE_RED_DIR required');
 const version=require(path.join(runtimeDir,'package.json')).version;
 assert.ok(['3.1.15','4.0.9'].includes(version)); assert.equal(process.versions.node,'20.18.3');
 const RED=require(runtimeDir),userDir=fs.mkdtempSync(path.join(os.tmpdir(),'x3-native-'));
 // Retain the exact libs declarations. Node-RED imports these installed IO
 // doubles through its normal external-module loader, including builtin libs.
 for(const [name,source] of Object.entries({
  'osi-lib':"module.exports={require(name){return globalThis.__x3IO.osiLib.require(name)}};",
  'osi-db-helper':"module.exports={Database:class {constructor(...args){return new globalThis.__x3IO.osiDb.Database(...args)}}};",
 })) {
  const dir=path.join(userDir,'node_modules',name);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',main:'index.js'}));fs.writeFileSync(path.join(dir,'index.js'),source);
 }
 fs.writeFileSync(path.join(userDir,'package.json'),JSON.stringify({private:true,dependencies:{'osi-lib':'1.0.0','osi-db-helper':'1.0.0'}}));
 let pending,lastNative,deployed;
 const setupErrors=[];
 RED.init(null,{userDir,httpAdminRoot:false,httpNodeRoot:false,disableEditor:true,functionExternalModules:true,
  externalModules:{autoInstall:false,modules:{allowInstall:false}},functionGlobalContext:{x3:{deps:null}},
  logging:{console:{level:'off'}},editorTheme:{projects:{enabled:false}}});
 RED.log.addHandler({emit(entry){if(entry.level===RED.log.ERROR) setupErrors.push(entry.msg);}});
 RED.nodes.registerType('x3-capture',function(config){
  RED.nodes.createNode(this,config);this.on('input',msg=>{if(pending) { if(config.role==='catch') pending.caught.push(plain(msg)); else pending.outputs[Number(config.port)].push(plain(msg)); }});
 });
 RED.hooks.add('onComplete.x3',event=>{
  if(!pending||event.node.id!=='x3-function')return;
  pending.completionError=event.error;
  // Delivery is asynchronous. Drain deliveries queued by send/handleError;
  // collect every message rather than settling on the first output.
  const turn=pending;
  setImmediate(()=>setImmediate(()=>{if(pending===turn)turn.finish();}));
 });
 function started(){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{RED.events.removeListener('flows:started',ready);reject(new Error('flows did not start: '+setupErrors.join('; ')));},10000);function ready(){clearTimeout(timer);resolve();}RED.events.once('flows:started',ready);});}
 const initial=started();await RED.start();await initial;
 const realCrypto=require('node:crypto'),http=require('node:http'),https=require('node:https');
 const originals={randomBytes:realCrypto.randomBytes,timingSafeEqual:realCrypto.timingSafeEqual,http:http.request,https:https.request};
 async function executor(source,msg,deps) {
  globalThis.__x3IO=deps;
  realCrypto.randomBytes=deps.crypto.randomBytes;realCrypto.timingSafeEqual=deps.crypto.timingSafeEqual;http.request=deps.httpLib.request;https.request=deps.httpsLib.request;
  const func="const __deps=global.get('x3').deps; const env=__deps.env; const Date=__deps.Date;\n"+source.func;
  if(deployed!==func) {
   const flows=[{id:'x3-tab',type:'tab'}, {...source,id:'x3-function',z:'x3-tab',func,wires:Array.from({length:Number(source.outputs)},(_,i)=>['x3-out-'+i])},
    ...Array.from({length:Number(source.outputs)},(_,i)=>({id:'x3-out-'+i,type:'x3-capture',z:'x3-tab',port:i,wires:[]})),
    {id:'x3-catch',type:'catch',z:'x3-tab',scope:['x3-function'],uncaught:false,wires:[['x3-caught']]},
    {id:'x3-caught',type:'x3-capture',z:'x3-tab',role:'catch',wires:[]}];
   const ready=started();await RED.nodes.setFlows(flows,null,'full',false,true);await ready;deployed=func;
  }
  const node=RED.nodes.getNode('x3-function');assert.ok(node,'native function node loaded');
  node.context().global.set('x3',{deps});node.context().global.set('fs',deps.global.get('fs'));
  // Observe error arguments and retain the original Node implementation, which
  // is responsible for logging and routing to Catch. Send is never replaced.
  if(!node._x3Observed) {
   for(const kind of ['error','warn','log','status']) {
    const native=node[kind];node[kind]=function(value,message){
     if(pending) {
      if(kind==='error')pending.errors.push(plain({value,message}));
      if(!(kind==='error'&&pending.completionError===value))globalThis.__x3IO.node[kind](value,message);
     }
     return native.apply(this,arguments);
    };
   }
   node._x3Observed=true;
  }
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending=null;reject(new Error('native completion timed out: '+setupErrors.join('; ')));},10000);
   pending={outputs:Array.from({length:Number(source.outputs)},()=>[]),caught:[],errors:[],finish(){
    clearTimeout(timer);const turn=pending;pending=null;
    lastNative={outputs:turn.outputs,caught:turn.caught,errorCalls:turn.errors};
    if(turn.completionError){const e=new Error(turn.completionError.message||String(turn.completionError));e.name=turn.completionError.name||'Error';reject(e);return;}
    resolve(Number(source.outputs)===1?turn.outputs[0][0]:turn.outputs.map(messages=>messages[0]||null));
   }};
   node.receive(msg);
  });
 }
 function cardinality(observation,wanted,label) {
  const returned=Array.isArray(wanted.result)?wanted.result:[wanted.result];
  const ports=observation.outputs.map((_,index)=>returned[index]);
  assert.ok(returned.slice(ports.length).every(message=>!message),label+' unexpected reference output');
  assert.deepEqual(observation.outputs.map(messages=>messages.length),ports.map(message=>message?1:0),label+' native output cardinality');
  const explicit=wanted.diagnostics.filter(d=>d.kind==='error').length;
  assert.equal(observation.caught.length,explicit+(wanted.thrown?1:0),label+' native Catch count');
  assert.equal(observation.errorCalls.length,explicit+(wanted.thrown?1:0),label+' native error calls');
 }
 let count=0;
 try {
  const originalCases=JSON.parse(fs.readFileSync(path.join(FIXTURES,'cases.json')));
  const frozen=JSON.parse(fs.readFileSync(path.join(FIXTURES,'expected.json')));
  const allCases=[...originalCases,...extra].sort((a,b)=>a.node.localeCompare(b.node));
  for(const profile of PROFILES) {
   const captured=new Map();
   for(const mode of ['legacy','adapter']) for(const c of allCases) {
    const legacy=LEGACY.find(n=>n.id===c.node);
    const actual=await execute(profile,mode==='legacy'?legacy:adaptNode(legacy),c,executor),native=lastNative;
    delete actual.msg;
    if(mode==='legacy') {
     const reference=c.extended||process.env.TZ!=='UTC'?await execute(profile,legacy,c):frozen[c.name];
     const expected={...reference};delete expected.msg;
     assert.deepEqual(actual,expected,profile+' '+c.name+' native legacy');cardinality(native,reference,c.name);
     if(c.extended)assertCase(c,actual,false);
     captured.set(c.name,{actual,native,reference});
    } else {
     const before=captured.get(c.name);
     if(c.extended)assertCase(c,actual,true);
     if(!c.loaderChange) {
      compare(before.actual,actual,profile+' '+c.name+' native adapter');cardinality(native,before.reference,c.name);
      assert.deepEqual(native,before.native,c.name+' native outputs, Catch messages and error arguments');
     } else { assert.equal(native.outputs.flat().length,1);assert.equal(native.caught.length,1); }
    }
    count++;
   }
  }
  // Negative controls exercise the native leg itself, independently of Node's
  // new-Function oracle and without changing runtime send/error behavior.
  for(const [id,mutate] of [['get-actuations-query',text=>text.replace('return [msg, null];','return [msg, msg];')],['get-actuations-response',text=>'node.send(msg);\n'+text]]) {
   const legacy=LEGACY.find(n=>n.id===id),changed={...legacy,func:mutate(legacy.func)};
   assert.notEqual(changed.func,legacy.func);
   const c={node:id},baseline=await execute(PROFILES[0],legacy,c);
   await execute(PROFILES[0],changed,c,executor);
   assert.throws(()=>cardinality(lastNative,baseline,'mutation'),/cardinality/,'native duplicate/two-port control must fail');
  }
  console.log(`X3 native Node-RED ${version} / Node ${process.versions.node}: ${count} traces, both profiles and native cardinality/Catch controls; TZ=${process.env.TZ}`);
 } finally {
  realCrypto.randomBytes=originals.randomBytes;realCrypto.timingSafeEqual=originals.timingSafeEqual;http.request=originals.http;https.request=originals.https;
  await RED.stop();delete globalThis.__x3IO;fs.rmSync(userDir,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
