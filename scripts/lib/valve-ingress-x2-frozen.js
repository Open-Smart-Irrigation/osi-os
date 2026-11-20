'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..'),REVIEW='3825a5763e6b7a6805e728e5c2654501984030b5';
const baseline=require('../fixtures/valve-ingress-x2/baseline.json');
function pinnedSource(){
 for(const file of ['scripts/fixtures/valve-ingress-x2/baseline.json','scripts/fixtures/valve-ingress-x2/hashes.json','scripts/lib/valve-ingress-x2-cases.js']){
  const pinned=execFileSync('git',['show',REVIEW+':'+file],{cwd:ROOT,encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(fs.readFileSync(path.join(ROOT,file),'utf8'),pinned,'frozen oracle differs from reviewed source: '+file);
 }
 for(const profile of ['bcm2712','bcm2709']){
  const flows=JSON.parse(execFileSync('git',['show',baseline.source+':conf/full_raspberrypi_bcm27xx_'+profile+'/files/usr/share/flows.json'],{cwd:ROOT,encoding:'utf8',maxBuffer:8*1024*1024}));
  for(const node of baseline.nodes)assert.equal(crypto.createHash('sha256').update(flows.find(n=>n.id===node.id).func).digest('hex'),node.originalFuncSha256,'pinned legacy source hash');
 }
}
module.exports={pinnedSource};
