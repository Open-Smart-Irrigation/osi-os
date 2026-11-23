'use strict';
const fs=require('node:fs'),path=require('node:path');
const started=Date.now();
const watchdog=setTimeout(()=>{console.error('SMOKE infrastructure timeout');process.exit(2);},8*60*1000);
(async()=>{
  const h=await require('./runtime').start();
  try {
    fs.writeFileSync(path.join(h.RUN,'runtime.json'),JSON.stringify(h.metadata,null,2)+'\n');
    console.log('RUNTIME STARTED',JSON.stringify(h.metadata));
    const cases=await require('./cases').run(h);
    fs.writeFileSync(path.join(h.RUN,'results.json'),JSON.stringify({cases,metadata:h.metadata,logs:h.state.logs,radio:h.state.cs.calls,mqtt:h.state.mqtt,caught:h.state.caught,sweep:h.state.sweep,seconds:(Date.now()-started)/1000,maxRSSKiB:process.resourceUsage().maxRSS},null,2)+'\n');
  } finally {await h.stop();clearTimeout(watchdog);}
  process.exit(0);
})().catch(e=>{console.error('SMOKE infrastructure failure',e.stack);console.error('STARTUP OBSERVATIONS',JSON.stringify(require('./runtime').state.logs));process.exit(2);});
