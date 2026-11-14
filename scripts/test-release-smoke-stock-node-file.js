#!/usr/bin/env node
'use strict';
// #656's three-layout test needs one directory containing the runtime and
// SQLite packages. Assemble that disposable input without putting SQLite in
// the stock firmware fixture used by the full smoke run.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {runtimeConfig,checkRuntime}=require('./lib/release-smoke-runtimes');
const image=runtimeConfig('image'),stock=runtimeConfig('stock');
checkRuntime(image);checkRuntime(stock);
const run=fs.mkdtempSync(path.join(os.tmpdir(),'osi-stock-node-file-'));
try {
  const modules=path.join(run,'node_modules');
  fs.cpSync(fs.realpathSync(path.join(stock.fixture,'node_modules')),modules,{recursive:true});
  for(const name of ['node-red-node-sqlite','sqlite3','bindings','file-uri-to-path']) {
    fs.cpSync(fs.realpathSync(path.join(image.fixture,'node_modules',name)),path.join(modules,name),{recursive:true,dereference:true});
  }
  const result=spawnSync(process.execPath,['--test','--test-concurrency=2',path.join(__dirname,'test-sqlite-serialize-node-file.js')],{
    env:{...process.env,OSI_NODE_RED_EXTRA_ROOTS:modules},stdio:'inherit',timeout:3*60*1000
  });
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
} finally {fs.rmSync(run,{recursive:true,force:true});}
