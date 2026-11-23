'use strict';
const fs=require('node:fs');
// Reserve the chosen path before running a harness. The descriptor is never
// reopened by path, so a path replacement cannot redirect the eventual write.
function createEvidenceWriter(envName,env=process.env){
 const file=env[envName];if(!file)return()=>{};
 const fd=fs.openSync(file,'wx');let closed=false;
 const close=()=>{if(!closed){closed=true;fs.closeSync(fd);}};
 process.once('exit',close);
 return value=>{
  if(closed)throw new Error('Evidence already written: '+file);
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');}
  finally{close();process.removeListener('exit',close);}
 };
}
module.exports={createEvidenceWriter};
