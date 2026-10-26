'use strict';
// Subprocess-only resolver: never inspects host runtime module directories.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const cli=path.resolve(process.argv[1]);
const dir=path.dirname(cli);
const control=JSON.parse(fs.readFileSync(path.join(dir,'driver-control.json'),'utf8'));
const original=Module._resolveFilename;
Module._resolveFilename=function(name,parent,isMain,options) {
  if (parent && parent.filename===cli && ['sqlite3','bcryptjs'].includes(name)) {
    assert.deepEqual(options.paths,[dir,'/srv/node-red','/usr/share/node-red']);
    fs.appendFileSync(path.join(dir,'driver-trace.jsonl'),JSON.stringify({event:'resolve',name})+'\n');
    if ((name==='sqlite3' && control.sqliteMissing) || (name==='bcryptjs' && control.bcryptMissing)) throw new Error(control.privateMarker);
    return original.call(this,name,parent,isMain,{paths:[dir]});
  }
  return original.call(this,name,parent,isMain,options);
};
