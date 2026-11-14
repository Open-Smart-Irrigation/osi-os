#!/usr/bin/env node
'use strict';
// Starts one actual Node-RED process. No per-function harness and no injected globals.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {isDeepStrictEqual}=require('node:util');
const ROOT=path.resolve(__dirname,'..'),fixture=path.join(__dirname,'fixtures/release-smoke');

// Reduce observations to stable failure symptoms; timestamps, UUIDs and generated
// queue ids do not define a defect. HTTP status/error and actual radio bytes do.
function signature(failure) {
  const value=failure.actual;
  if(value?.timeout)return {code:failure.code,symptom:'http-timeout'};
  if(value?.status)return {code:failure.code,status:value.status,error:value.json?.error||null,missingCrypto:/crypto is not defined/.test(value.json?.message||'')};
  if(Array.isArray(value)&&value.every(v=>v&&typeof v==='object'&&v.fn))return {code:failure.code,frames:value.map(v=>({fn:v.fn,port:v.port,hex:v.hex,hasExpiry:!!v.expiresAt}))};
  return {code:failure.code,actual:value};
}
function classify(cases,known) {
  const passed=[],failed=[],knownToFail=[],seen=new Set();
  const byId=new Map();
  for(const entry of known) {
    if(!entry.id||!entry.finding||!Array.isArray(entry.failures)||!entry.failures.length||byId.has(entry.id))throw new Error('invalid/duplicate known failure '+JSON.stringify(entry));
    if(!/^(?:[FAS]-[1-9]\d*|NEW-[1-9]\d*|known defect 1)$/.test(entry.finding))throw new Error('known failure needs exactly one finding: '+entry.id);
    byId.set(entry.id,entry);
  }
  for(const result of cases) {
    if(seen.has(result.id))throw new Error('duplicate case '+result.id);
    seen.add(result.id);
    const entry=byId.get(result.id);
    const actual=result.failures.map(signature).sort((a,b)=>a.code.localeCompare(b.code));
    if(entry&&isDeepStrictEqual(actual,[...entry.failures].sort((a,b)=>a.code.localeCompare(b.code))))knownToFail.push({...result,finding:entry.finding});
    else if(entry)failed.push({...result,reason:actual.length?'failure signature changed':'known case passed: remove its entry'});
    else if(actual.length)failed.push(result);
    else passed.push(result);
  }
  for(const entry of known)if(!seen.has(entry.id))failed.push({id:entry.id,reason:'known case was not executed',failures:[]});
  return {passed,failed,knownToFail};
}
function parity() {
  const a=path.join(ROOT,'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share');
  const b=path.join(ROOT,'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share');
  let count=0;
  function compare(rel) {
    const x=path.join(a,rel),y=path.join(b,rel);
    if(fs.statSync(x).isDirectory()) {
      const names=fs.readdirSync(x).sort();
      if(!isDeepStrictEqual(names,fs.readdirSync(y).sort()))throw new Error('profile file list differs '+rel);
      for(const name of names)compare(path.join(rel,name));
    }else{if(!fs.readFileSync(x).equals(fs.readFileSync(y)))throw new Error('profile bytes differ '+rel);count++;}
  }
  compare('flows.json');compare('node-red');
  console.log('PROFILE PARITY:',count,'flow/helper files byte-identical');
}
function main(argv,options={}) {
  if(argv.some(a=>!['--release','--strict'].includes(a)))throw new Error('usage: node scripts/test-release-smoke.js [--release|--strict]');
  parity();
  // The workflow's setup-node pin is the one place the image's Node version is written.
  const pinned=(/^\s*node-version:\s*'(\d+\.\d+\.\d+)'\s*$/m.exec(fs.readFileSync(path.join(ROOT,'.github/workflows/release-smoke.yml'),'utf8'))||[])[1];
  if(!pinned||process.version!=='v'+pinned)throw new Error(`release smoke runs under the image's Node ${pinned} (.github/workflows/release-smoke.yml); this is ${process.version}`);
  const expected=/PKG_VERSION:=(\S+)/.exec(fs.readFileSync(path.join(ROOT,'feeds/chirpstack-openwrt-feed/apps/node-red/Makefile'),'utf8'))[1];
  const actual=require(path.join(fixture,'node_modules/node-red/package.json')).version;
  if(expected!==actual)throw new Error(`image Node-RED ${expected} differs from smoke runtime ${actual}; update the lockfile`);
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'osi-release-smoke-'));
  console.log('EVIDENCE:',run);
  function command(cmd,args,extra={}) {
    const r=spawnSync(cmd,args,{cwd:ROOT,encoding:'utf8',timeout:9*60*1000,maxBuffer:16*1024*1024,...extra});
    if(r.error)throw r.error;
    return r;
  }
  const seed=command(process.execPath,['scripts/build-seed-db.js','--out',path.join(run,'data/db/farming.db')]);
  fs.writeFileSync(path.join(run,'seed.log'),seed.stdout+seed.stderr);
  if(seed.status!==0)throw new Error('seed build failed: '+seed.stderr);
  const runtimeLog=path.join(run,'runtime.log');
  const fd=fs.openSync(runtimeLog,'w');
  let child;
  try {child=command(process.execPath,['--max-old-space-size=1536',path.join(fixture,'worker.js')],{env:{PATH:process.env.PATH,HOME:run,LANG:'C.UTF-8',TZ:'UTC',OSI_SMOKE_RUN:run,OSI_SMOKE_CONTROL:options.control||''},stdio:['ignore',fd,fd]});}
  finally {fs.closeSync(fd);}
  if(child.status!==0)throw new Error('runtime failed: '+fs.readFileSync(runtimeLog,'utf8'));
  const evidence=JSON.parse(fs.readFileSync(path.join(run,'results.json'),'utf8'));
  if(evidence.maxRSSKiB>=4*1024*1024)throw new Error('runtime exceeded 4 GiB RSS');
  if(evidence.seconds>=10*60)throw new Error('runtime exceeded 10 minutes');
  // NEW-15: overlapping valve commands in the gateway's dependency layouts,
  // each in its own Node-RED process (scripts/test-release-sqlite-overlap.js).
  // The negative controls exercise only the runtime suite.
  if(!options.control) {
    const sqliteCases=require('./test-release-sqlite-overlap');
    for(const layout of ['dual','npm','stock'])evidence.cases.push(sqliteCases.run({layout}));
    // Start-up state: healthy, damaged file, two native addons.
    for(const fault of ['none','damaged','conflict','damaged_late'])evidence.cases.push(sqliteCases.startupCase({fault}));
    // The field layout (stock base, only the user copy): one addon, no fault.
    evidence.cases.push(sqliteCases.startupCase({fault:'none',layout:'stock'}));
  }
  const known=JSON.parse(fs.readFileSync(path.join(fixture,'known-failures.json'),'utf8'));
  return report(evidence,known,run,argv,options);
}
function report(evidence,known,run,argv=[],options={}) {
  const summary=classify(evidence.cases,known);
  for(const c of summary.passed)console.log('PASS',c.id);
  for(const c of summary.knownToFail)console.log('KNOWN TO FAIL',c.finding,c.id,JSON.stringify(c.failures.map(signature)));
  for(const c of summary.failed)console.error('FAIL',c.id,c.reason||'',JSON.stringify(c.failures.map(signature)));
  console.log(`RESULT passed=${summary.passed.length} failed=${summary.failed.length} known-to-fail=${summary.knownToFail.length}; ${evidence.seconds.toFixed(1)}s; peak RSS ${(evidence.maxRSSKiB/1024).toFixed(0)} MiB`);
  fs.writeFileSync(path.join(run,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  options.onSummary?.(summary,evidence,run);
  if(summary.failed.length)return 1;
  if((argv.includes('--release')||argv.includes('--strict'))&&known.length){console.error('RELEASE REFUSED:',known.length,'known failing cases remain');return 1;}
  return 0;
}
if(require.main===module){try{process.exitCode=main(process.argv.slice(2));}catch(e){console.error(e.stack);process.exitCode=2;}}
module.exports={classify,signature,parity,main,report};
