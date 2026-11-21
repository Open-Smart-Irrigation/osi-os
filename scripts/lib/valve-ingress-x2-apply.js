'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync,spawnSync}=require('node:child_process');
function applyReceiptPatch(root,files,{patch,reverse=false,cached=false}={}){
 assert.ok(patch,'handoff patch path is required');
 const before=reverse?'after':'before',after=reverse?'before':'after';
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'x2-apply-index-'));
 const env={...process.env,GIT_INDEX_FILE:path.join(temporary,'index')};
 const query=(args,environment=process.env)=>execFileSync('git',args,{cwd:root,env:environment,maxBuffer:8*1024*1024});
 const checkContent=(side,index,environment=process.env)=>{
  for(const file of files){
   const actual=index?query(['show',':'+file.rel],environment):fs.readFileSync(path.join(root,file.rel));
   assert.ok(actual.equals(Buffer.from(file[side])),'handoff receipt mismatch ('+side+'): '+file.rel);
  }
 };
 const apply=(index,check,environment)=>{
  const args=['apply',...(index?['--cached']:[]),...(reverse?['--reverse']:[]),...(check?['--check']:[]),patch];
  const result=spawnSync('git',args,{cwd:root,env:environment,encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(result.status,0,'handoff Git apply failed: '+result.stderr);
  // Some Git versions report a corrupt binary hunk but still exit zero.
  assert.equal(result.stderr,'','handoff Git apply diagnostic: '+result.stderr);
  assert.equal(result.stdout,'','unexpected handoff Git apply output: '+result.stdout);
 };
 try{
  checkContent(before,cached);
  const indexPath=path.resolve(root,query(['rev-parse','--git-path','index']).toString().trim());
  fs.copyFileSync(indexPath,env.GIT_INDEX_FILE);
  if(!cached)query(['add','--',...files.map(file=>file.rel)],env);
  apply(true,true,env);apply(true,false,env);
  // Verify every file, including an unchanged DDL baseline and the catch baseline,
  // before changing either the real index or any working file.
  checkContent(after,true,env);
  apply(cached,true,process.env);apply(cached,false,process.env);
  checkContent(after,cached);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={applyReceiptPatch};
