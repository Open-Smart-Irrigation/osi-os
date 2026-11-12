'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {runtimeConfig}=require('../../lib/release-smoke-runtimes');
const config=runtimeConfig(process.env.OSI_SMOKE_RUNTIME||'image');
const firmware=Module.createRequire(path.join(config.fixture,'package.json'));
const user=Module.createRequire(path.join(process.env.OSI_SMOKE_RUN,'package.json'));
const load=config.name==='stock'?user:firmware;
function packageVersion(name) {
  try{return load(name+'/package.json').version;}
  catch(error){if(error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error;}
  // bcryptjs exports its entry but hides package.json. Read the manifest
  // above that resolved entry, without substituting a lockfile's claim.
  let dir=path.dirname(load.resolve(name));
  while(dir!==path.dirname(dir)) {
    const file=path.join(dir,'package.json');
    if(fs.existsSync(file)) {
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if(data.name===name)return data.version;
    }
    dir=path.dirname(dir);
  }
  throw new Error('resolved package manifest missing '+name);
}
function evidence() {
  const sqliteModule=Object.keys(require.cache).find(file=>file.endsWith('/node-red-node-sqlite/sqlite.js'));
  if(!sqliteModule)throw new Error('SQLite node was not loaded');
  const sqliteRequire=Module.createRequire(sqliteModule);
  if(sqliteRequire('sqlite3')!==load('sqlite3'))throw new Error('helpers and SQLite node use different drivers');
  const nativePaths=process.report.getReport().sharedObjects.filter(file=>file.endsWith('/node_sqlite3.node'));
  if(nativePaths.length!==1)throw new Error('expected one mapped SQLite addon, found '+nativePaths.length);
  if(config.name==='stock') {
    if(!nativePaths[0].startsWith(process.env.OSI_SMOKE_RUN+path.sep))throw new Error('stock SQLite loaded outside user directory');
    try {firmware.resolve('sqlite3');throw new Error('stock firmware contains SQLite');}
    catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
  }
  const packages={};
  for(const name of ['node-red-node-sqlite','sqlite3','@chirpstack/chirpstack-api','@grpc/grpc-js','bcryptjs','google-protobuf','protobufjs','@grpc/proto-loader'])packages[name]=packageVersion(name);
  return {runtime:config.name,node:process.versions.node,nodeRed:firmware('node-red/package.json').version,packages,sqliteModule,driver:sqliteRequire.resolve('sqlite3'),nativePaths};
}
module.exports={config,firmware,load,evidence};
