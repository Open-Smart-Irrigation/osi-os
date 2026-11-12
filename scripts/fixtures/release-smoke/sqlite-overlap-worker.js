'use strict';
// NEW-15 overlap round. Started by scripts/test-release-sqlite-overlap.js from a
// synthetic firmware entry, inside the dependency layout that test prepared.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const started=Date.now();
const watchdog=setTimeout(()=>{console.error('overlap runtime timeout');process.exit(2);},180000);
const addons=()=>[...new Set(fs.readFileSync('/proc/self/maps','utf8').split('\n')
  .filter(line=>line.includes('node_sqlite3.node')).map(line=>line.trim().split(/\s+/).at(-1)))].sort();
(async()=>{
  const h=await require('./runtime').start();
  const payload=Buffer.from(JSON.stringify({userId:1,username:'overlap',exp:Date.now()+600000})).toString('base64url');
  const token=payload+'.'+crypto.createHmac('sha256','synthetic-smoke-secret').update(payload).digest('base64url');
  const valves=Array.from({length:8},(_,i)=>'A8404100000000'+String(i+1).padStart(2,'0'));
  const replies=[],reports=[];
  let report;
  // No harness SQL call is permitted after start: all stimuli are HTTP, MQTT,
  // and the shipped one-time inject. The parent inspects the file after exit.
  // The network server answers an enqueue after 3 s, so commands overlap.
  h.state.cs.latencyMs=3000;
  // Every OPEN frame, manual or scheduled, is reported open and then closed.
  let seen=0;
  const radio=setInterval(()=>{
    for(const call of h.state.cs.calls.slice(seen)) {
      if(call.fn!=='enqueue'||call.port!==2||call.hex!=='4101')continue;
      h.state.cs.queue[call.eui]=[];
      reports.push((async()=>{await h.sleep(3500);await h.uplink(call.eui,1);await h.sleep(5000);await h.uplink(call.eui,0);})());
    }
    seen=h.state.cs.calls.length;
  },100);
  const open=async eui=>{
    const response=await h.http('POST','/api/valve/'+eui,{action:'OPEN_FOR_DURATION',duration_seconds:60},token,15000);
    replies.push({kind:'open',eui,response});
  };
  const schedule=async(eui,fireAt)=>{
    const response=await h.http('POST','/api/valves/'+eui+'/schedules',{
      kind:'ONCE',fire_at:fireAt,duration_minutes:1,timezone:'UTC',enabled:true,
    },token,15000);
    replies.push({kind:'schedule',eui,response});
  };
  const timer=setInterval(()=>h.inject('valve-once-tick'),1000);
  try {
    for(const [round,gap] of [[1,1500],[2,700]]) {
      const fireAt=new Date(Date.now()+18000).toISOString();
      const jobs=[...valves.slice(0,round===1?5:8).map(eui=>()=>open(eui)),
        ...valves.slice(round===1?5:0,round===1?8:3).map(eui=>()=>schedule(eui,fireAt))];
      await Promise.all(jobs.map(async(job,index)=>{await h.sleep(index*gap);await job();}));
      console.log('overlap round',round,JSON.stringify(replies.map(r=>({kind:r.kind,eui:r.eui,status:r.response.status}))));
      await h.sleep(20000);
      for(const eui of valves)await h.uplink(eui,0);
    }
    await Promise.all(reports);
    await h.sleep(3000);
  } finally {
    clearInterval(timer);clearInterval(radio);
    const files=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{return [fs.readlinkSync('/proc/self/fd/'+fd)];}catch(error){if(error.code==='ENOENT')return [];throw error;}}).filter(file=>/farming\.db|radio\.db|activity\.sqlite/.test(file));
    report={replies,addons:addons(),openDatabaseFiles:files,logs:h.state.logs,caught:h.state.caught,radio:h.state.cs.calls,
      node:process.version,seconds:(Date.now()-started)/1000,maxRSSKiB:process.resourceUsage().maxRSS};
    fs.writeFileSync(path.join(h.RUN,'overlap.json'),JSON.stringify(report,null,2)+'\n');
    await h.stop();clearTimeout(watchdog);
  }
  console.log('overlap stopped',JSON.stringify({addons:report.addons,seconds:report.seconds}));
  process.exit(0);
})().catch(error=>{console.error(error.stack);process.exit(2);});
