'use strict';
const fs=require('node:fs'),path=require('node:path');
const started=Date.now();
const watchdog=setTimeout(()=>{console.error('SMOKE infrastructure timeout');process.exit(2);},8*60*1000);
(async()=>{
  const h=await require('./runtime').start();
  try {
    const cases=await require('./cases').run(h);
    fs.writeFileSync(path.join(h.RUN,'results.json'),JSON.stringify({cases,logs:h.state.logs,radio:h.state.cs.calls,mqtt:h.state.mqtt,seconds:(Date.now()-started)/1000,maxRSSKiB:process.resourceUsage().maxRSS},null,2)+'\n');
  } finally {await h.stop();clearTimeout(watchdog);}
  process.exit(0);
})().catch(e=>{console.error('SMOKE infrastructure failure',e.stack);process.exit(2);});
