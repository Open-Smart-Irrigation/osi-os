'use strict';
// Disposable verification tree. The checkout holding the flows reservation is never written.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const handoff=require('./valve-ingress-x2-handoff');
function stagedTree({applyHandoff=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'valve-x2-stage-'));
 const git=(args,root=handoff.ROOT)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']});
 try{
  git(['clone','--shared','--no-checkout','--quiet',handoff.ROOT,dir]);
  git(['checkout','--detach','--quiet','HEAD'],dir);
  // Include the working files for local characterization; CI checks the exact committed head.
  for(const rel of git(['ls-files','-co','--exclude-standard','-z']).split('\0').filter(Boolean)){
   const from=path.join(handoff.ROOT,rel),to=path.join(dir,rel);
   if(!fs.existsSync(from)){fs.rmSync(to,{force:true,recursive:true});continue;}
   const stat=fs.lstatSync(from);fs.mkdirSync(path.dirname(to),{recursive:true});
   if(stat.isSymbolicLink()){fs.rmSync(to,{force:true});fs.symlinkSync(fs.readlinkSync(from),to);}
   else if(stat.isFile())fs.copyFileSync(from,to);
  }
  git(['update-ref','refs/remotes/origin/main',git(['rev-parse','origin/main']).trim()],dir);
  if(applyHandoff){
  const {state,files}=handoff.verifyHandoff(dir);
  const patch=path.join(handoff.ROOT,handoff.PATCH);
  // A later handoff owns the current bytes; the raw patch controls run from
  // the legacy source bytes in test-valve-ingress-x2-handoff.js instead.
  if(state!=='superseded'){
  if(state==='legacy')handoff.writeHandoff(dir);
  for(const file of files)assert.equal(fs.readFileSync(path.join(dir,file.rel),'utf8'),file.after,'actual applied content: '+file.rel);
  handoff.applyReceiptPatch(dir,files,{patch,reverse:true});
  for(const file of files)assert.equal(fs.readFileSync(path.join(dir,file.rel),'utf8'),file.before,'actual reversed content: '+file.rel);
  handoff.writeHandoff(dir);
  for(const file of files)assert.equal(fs.readFileSync(path.join(dir,file.rel),'utf8'),file.after,'actual reapplied content: '+file.rel);
  }
  }
  git(['add','-A'],dir);
  return {dir,close(){fs.rmSync(dir,{recursive:true,force:true});}};
 }catch(error){fs.rmSync(dir,{recursive:true,force:true});throw error;}
}
module.exports={stagedTree};
