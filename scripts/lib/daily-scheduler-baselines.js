'use strict';
const fs=require('node:fs'),path=require('node:path');
const {ROOT,PROFILES}=require('./daily-scheduler-harness');
const {adaptFlows}=require('../prepare-daily-scheduler-adapters');
const {countSilentCatchesInFlow}=require('../verify-no-new-silent-catch');
const {countMarkers,textSourcesFromContent}=require('../verify-no-stray-ddl');
function stagedBaselines() {
 const profiles={};let modulesEmptyCatches=0;
 for(const profile of PROFILES) {
  const relative='conf/'+profile+'/files/usr/share/flows.json';
  const rendered=JSON.stringify(adaptFlows(JSON.parse(fs.readFileSync(path.join(ROOT,relative)))),null,2)+'\n';
  const moduleRoot=path.join(ROOT,'conf',profile,'files/usr/share/node-red/osi-daily-scheduler');
  const sources=fs.readdirSync(moduleRoot).filter(f=>f.endsWith('.js')).map(f=>({type:'function',func:fs.readFileSync(path.join(moduleRoot,f),'utf8')}));
  modulesEmptyCatches+=countSilentCatchesInFlow(sources).silentCatchCount;
  profiles[profile]={silentCatch:countSilentCatchesInFlow(JSON.parse(rendered)),ddl:countMarkers(textSourcesFromContent(relative,rendered))};
 }
 return {profiles,modulesEmptyCatches};
}
module.exports={stagedBaselines};
