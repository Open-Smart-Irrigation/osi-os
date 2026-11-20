'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..');
const baseline=require('../fixtures/valve-ingress-x2/baseline.json');
function pinnedSource(){
 for(const [file,expected] of Object.entries(require('../fixtures/valve-ingress-x2/oracle-sha256.json'))){
  const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex');
  assert.equal(actual,expected,'frozen oracle content digest changed: '+file);
 }
 for(const profile of ['bcm2712','bcm2709']){
  const flows=JSON.parse(execFileSync('git',['show',baseline.source+':conf/full_raspberrypi_bcm27xx_'+profile+'/files/usr/share/flows.json'],{cwd:ROOT,encoding:'utf8',maxBuffer:8*1024*1024}));
  for(const node of baseline.nodes)assert.equal(crypto.createHash('sha256').update(flows.find(n=>n.id===node.id).func).digest('hex'),node.originalFuncSha256,'pinned legacy source hash');
 }
}
module.exports={pinnedSource};
