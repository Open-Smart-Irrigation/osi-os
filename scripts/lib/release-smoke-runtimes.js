'use strict';
const fs=require('node:fs'),path=require('node:path');
const {parseYaml,workflowVersionPins}=require('../verify-test-inventory');
const ROOT=path.resolve(__dirname,'../..');
const names=['image','stock'];
function parseVersions(text) {
  const doc=parseYaml(text,'release-smoke.yml');
  const pins=workflowVersionPins(text,doc.env);
  const keys=['OSI_SMOKE_NODE_VERSION','OSI_SMOKE_IMAGE_NODE_RED_VERSION','OSI_SMOKE_STOCK_NODE_RED_VERSION'];
  for(const key of keys)if(!pins[key])throw new Error('missing quoted patch version '+key);
  return {node:pins[keys[0]],image:pins[keys[1]],stock:pins[keys[2]]};
}
function runtimeConfig(name='image',root=ROOT) {
  if(!names.includes(name))throw new Error('unknown runtime '+name);
  const versions=parseVersions(fs.readFileSync(path.join(root,'.github/workflows/release-smoke.yml'),'utf8'));
  const fixture=path.join(root,'scripts/fixtures/release-smoke');
  return {name,node:versions.node,nodeRed:versions[name],fixture:name==='stock'?path.join(root,'scripts/fixtures/release-smoke-stock'):fixture,
    knownFile:path.join(root,'scripts/fixtures',name==='stock'?'release-smoke-stock':'release-smoke','known-failures.json')};
}
function combineKnown(lists) {
  return names.flatMap(runtime=>{
    if(!Array.isArray(lists[runtime]))throw new Error('missing failure list for '+runtime);
    return lists[runtime].map(entry=>({...entry,runtime}));
  });
}
function knownFailures(root=ROOT) {
  return combineKnown(Object.fromEntries(names.map(name=>[name,JSON.parse(fs.readFileSync(runtimeConfig(name,root).knownFile,'utf8'))])));
}
function checkRuntime(config) {
  if(process.versions.node!==config.node)throw new Error(`smoke requires Node ${config.node}; running ${process.versions.node}`);
  for(const file of ['package.json','package-lock.json']) {
    const data=JSON.parse(fs.readFileSync(path.join(config.fixture,file),'utf8'));
    const actual=file==='package.json'?data.dependencies['node-red']:data.packages['node_modules/node-red'].version;
    if(actual!==config.nodeRed)throw new Error(`${config.name} ${file} Node-RED ${actual} differs from workflow ${config.nodeRed}`);
  }
  const actual=require(path.join(config.fixture,'node_modules/node-red/package.json')).version;
  if(actual!==config.nodeRed)throw new Error(`${config.name} installed Node-RED ${actual} differs from workflow ${config.nodeRed}`);
}
module.exports={runtimeConfig,parseVersions,combineKnown,knownFailures,checkRuntime,names};
