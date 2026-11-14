'use strict';
// A stock base has no firmware SQLite. Reproduce deploy.sh's user install,
// including its shipped lock and local helper packages, before network fencing.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createRequire}=require('node:module');
function install(root,run) {
  if(!path.isAbsolute(run))throw new Error('absolute scratch directory required');
  const source=path.join(root,'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
  for(const name of ['package.json','package-lock.json','edge-channels.json'])fs.copyFileSync(path.join(source,name),path.join(run,name));
  for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
    if(entry.isDirectory()&&(entry.name.startsWith('osi-')||entry.name==='codecs'))fs.cpSync(path.join(source,entry.name),path.join(run,entry.name),{recursive:true});
  }
  const npm=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
  if(!fs.existsSync(npm))throw new Error('npm CLI beside pinned Node is missing');
  const result=spawnSync(process.execPath,[npm,'install','--omit=dev','--no-fund','--no-audit'],{
    cwd:run,encoding:'utf8',timeout:5*60*1000,maxBuffer:16*1024*1024,
    env:{...process.env,HOME:run,TMPDIR:run,npm_config_cache:path.join(run,'npm-cache'),npm_config_jobs:'1',NODE_OPTIONS:'--max-old-space-size=1024'}
  });
  const log=(result.stdout||'')+(result.stderr||'');fs.writeFileSync(path.join(run,'install.log'),log);
  if(result.error||result.status!==0||/Disk quota exceeded|EDQUOT|ENOSPC/i.test(log))throw new Error('stock npm install failed: '+(result.error?.message||log));
  // npm can exit zero after "Exit handler never called!" with no packages.
  // Resolve from this fresh user tree and load SQLite's native binding now.
  try {
    const load=createRequire(path.join(run,'package.json'));
    for(const name of ['sqlite3','node-red-node-sqlite']) {
      if(!load.resolve(name+'/package.json').startsWith(path.join(run,'node_modules')+path.sep))throw new Error(name+' resolved outside the user install');
      load(name+'/package.json');
    }
    load('sqlite3');
  } catch(error) {throw new Error('stock npm install failed: '+error.message);}
  const before=JSON.parse(fs.readFileSync(path.join(source,'package-lock.json'),'utf8')).packages;
  const after=JSON.parse(fs.readFileSync(path.join(run,'package-lock.json'),'utf8')).packages;
  for(const [name,entry] of Object.entries(before)) {
    if(entry.version!==after[name]?.version)throw new Error('stock npm changed locked version '+name);
  }
  for(const name of Object.keys(after))if(!Object.hasOwn(before,name))throw new Error('stock npm added unlocked package '+name);
}
module.exports={install};
