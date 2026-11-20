'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {adaptFlows}=require('./valve-ingress-x2-renderer');
const {countSilentCatchesInFlow}=require('../verify-no-new-silent-catch');
const {countMarkers,textSourcesFromContent}=require('../verify-no-stray-ddl');
const ROOT=path.resolve(__dirname,'../..');
const SOURCE='3825a5763e6b7a6805e728e5c2654501984030b5';
const FLOW_PATHS=['bcm2712','bcm2709'].map(p=>`conf/full_raspberrypi_bcm27xx_${p}/files/usr/share/flows.json`);
const SILENT='scripts/fixtures/silent-catch-baseline.json',DDL='scripts/verify-no-stray-ddl-baseline.json';
const PATCH='scripts/fixtures/valve-ingress-x2/handoff.patch', RECEIPT='scripts/fixtures/valve-ingress-x2/handoff.json';
const sha=s=>createHash('sha256').update(s).digest('hex');
const source=rel=>execFileSync('git',['show',SOURCE+':'+rel],{cwd:ROOT,encoding:'utf8',maxBuffer:8*1024*1024});
function canonicalHandoff(){
 const files=FLOW_PATHS.map(rel=>{
  const before=source(rel),flow=JSON.parse(before);
  assert.equal(JSON.stringify(flow,null,2)+'\n',before,'source flow roundtrip');
  return {rel,before,after:JSON.stringify(adaptFlows(flow),null,2)+'\n'};
 });
 assert.equal(files[0].after,files[1].after,'rendered profiles differ');
 const beforeSilent=source(SILENT),silent=JSON.parse(beforeSilent);
 for(const [profile,entry]of Object.entries(silent.profiles)){
  const rendered=files.find(f=>f.rel===entry.path);
  const measured=countSilentCatchesInFlow(JSON.parse(rendered.after)).silentCatchCount;
  assert.equal(entry.silentCatchCount-measured,6,'X2 removes exactly six inline silent catches: '+profile);
  entry.silentCatchCount=measured;
 }
 files.push({rel:SILENT,before:beforeSilent,after:JSON.stringify(silent,null,2)+'\n'});
 const beforeDdl=source(DDL),ddl=JSON.parse(beforeDdl);let total=0;
 for(const rel of Object.keys(ddl.files)){
  const text=files.find(f=>f.rel===rel)?.after||fs.readFileSync(path.join(ROOT,rel),'utf8');
  ddl.files[rel]=countMarkers(textSourcesFromContent(rel,text));total+=ddl.files[rel].total;
 }
 ddl.total=total;
 files.push({rel:DDL,before:beforeDdl,after:JSON.stringify(ddl,null,2)+'\n'});
 return files;
}
function canonicalPatch(files){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'x2-patch-'));
 try{
  // Binary hunks avoid reproducing legacy comment identities in a new text artifact.
  // The human-readable func/libs manifest is checked independently by the renderer.
  fs.writeFileSync(path.join(tmp,'attributes'),'*.json -diff\n');
  for(const side of ['a','b'])for(const f of files){const target=path.join(tmp,side,f.rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,side==='a'?f.before:f.after);}
  const result=spawnSync('git',['-c','core.attributesFile='+path.join(tmp,'attributes'),'diff','--no-index','--binary','--no-color','a','b'],{cwd:tmp,encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(result.status,1,result.stderr);
  return result.stdout.replace(/^diff --git a\/a\/(.+) b\/b\/(.+)$/gm,'diff --git a/$1 b/$2').replace(/^--- a\/a\//gm,'--- a/').replace(/^\+\+\+ b\/b\//gm,'+++ b/').trimEnd()+'\n';
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
function receipt(files){return {source:SOURCE,files:files.map(f=>({path:f.rel,beforeSha256:sha(f.before),afterSha256:sha(f.after)})),silentCatchCounts:{bcm2712:59,bcm2709:59},ddlTotal:694};}
function verifyHandoff(root=ROOT){
 const files=canonicalHandoff();
 assert.equal(fs.readFileSync(path.join(ROOT,PATCH),'utf8'),canonicalPatch(files),'checked-in patch differs from canonical renderer');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT,RECEIPT))),receipt(files),'handoff recount receipt differs');
 const states=new Set();
 for(const f of files){
  const actual=fs.readFileSync(path.join(root,f.rel),'utf8');
  if(f.before===f.after){assert.equal(actual,f.before,'unchanged baseline drift: '+f.rel);continue;}
  assert.ok(actual===f.before||actual===f.after,'unreviewed handoff source/result bytes: '+f.rel);
  states.add(actual===f.before?'legacy':'rendered');
 }
 assert.equal(states.size,1,'partial handoff application');
 return {files,state:[...states][0]};
}
function writeHandoff(root){const {files,state}=verifyHandoff(root);if(state==='rendered')return;for(const f of files)fs.writeFileSync(path.join(root,f.rel),f.after);}
module.exports={ROOT,PATCH,RECEIPT,FLOW_PATHS,canonicalHandoff,canonicalPatch,receipt,verifyHandoff,writeHandoff};
