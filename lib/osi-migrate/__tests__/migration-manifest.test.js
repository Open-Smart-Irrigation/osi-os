'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {parseManifest}=require('../migration-manifest');
const {vectors}=require('./helpers/manifest-vectors');
for(const v of vectors) test(v.name,()=>{
  if(v.valid) assert.ok(parseManifest(v.raw).length);
  else assert.throws(()=>parseManifest(v.raw),{code:'ERR_MIGRATION_CORPUS'});
});
