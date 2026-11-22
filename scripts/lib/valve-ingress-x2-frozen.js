'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const baseline=require('../fixtures/valve-ingress-x2/baseline.json');
const ADDITIVE='scripts/fixtures/valve-ingress-x2/additive-hashes.json';
function assertOracleContent(file,bytes){
 const expected=require('../fixtures/valve-ingress-x2/oracle-sha256.json')[file];
 assert.ok(expected,'unknown frozen oracle path: '+file);
 const actual=crypto.createHash('sha256').update(bytes).digest('hex');
 assert.equal(actual,expected,'frozen oracle content digest changed: '+file);
}
function pinnedSource({allowMissingAdditive=false}={}){
 for(const file of Object.keys(require('../fixtures/valve-ingress-x2/oracle-sha256.json'))){
  if(allowMissingAdditive&&file===ADDITIVE&&!fs.existsSync(path.join(ROOT,file)))continue;
  assertOracleContent(file,fs.readFileSync(path.join(ROOT,file)));
 }
 for(const profile of ['bcm2712','bcm2709']){
  const flows=JSON.parse(execFileSync('git',['show',baseline.source+':conf/full_raspberrypi_bcm27xx_'+profile+'/files/usr/share/flows.json'],{cwd:ROOT,encoding:'utf8',maxBuffer:8*1024*1024}));
  for(const node of baseline.nodes)assert.equal(crypto.createHash('sha256').update(flows.find(n=>n.id===node.id).func).digest('hex'),node.originalFuncSha256,'pinned legacy source hash');
 }
}
module.exports={pinnedSource,assertOracleContent,ADDITIVE};
