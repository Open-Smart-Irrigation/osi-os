'use strict';
// Observe Node-RED delivery/completion; never change messages, errors or wiring.
exports.observe = function(RED,state) {
  const pending=new Map();
  let lastActivity=Date.now();
  const touch=()=>{lastActivity=Date.now();};
  RED.hooks.add('onReceive.releaseSmoke',event=>{
    touch();
    const node=event.destination.node,msg=event.msg;
    state.received.push(node.id);
    if(node.type==='function') {
      const key=node.id+':'+msg?._msgid;
      pending.set(key,(pending.get(key)||0)+1);
    }
    if(node.type==='catch')state.caught.push({
      caseId:state.caseId||'boot',catchId:node.id,sourceId:msg?.error?.source?.id,
      sourceType:msg?.error?.source?.type,message:msg?.error?.message
    });
  });
  RED.hooks.add('onComplete.releaseSmoke',event=>{
    touch();
    if(event.node.node.type==='function') {
      const key=event.node.id+':'+event.msg?._msgid,count=pending.get(key)||0;
      if(count<=1)pending.delete(key);else pending.set(key,count-1);
    }
  });
  RED.hooks.add('onSend.releaseSmoke',event=>{touch();});
  return {
    touch,
    async settle(sleep,timeout=15000) {
      const end=Date.now()+timeout;
      do {
        await sleep(25);
        if(!pending.size&&!state.sqlitePending&&Date.now()-lastActivity>=250)return;
      }while(Date.now()<end);
      throw new Error('flows did not settle: '+JSON.stringify({functions:[...pending],sqlite:state.sqlitePending}));
    }
  };
};
exports.enabledInjects = flows => {
  const disabled=new Set(flows.filter(n=>n.type==='tab'&&n.disabled).map(n=>n.id));
  return flows.filter(n=>n.type==='inject'&&!n.d&&!n.disabled&&!disabled.has(n.z));
};
exports.pauseInjectTimers = function(RED,flows) {
  for(const config of exports.enabledInjects(flows)) {
    const node=RED.nodes.getNode(config.id);
    if(!node)throw new Error('enabled inject not loaded: '+config.id);
    clearTimeout(node.onceTimeout);clearInterval(node.interval_id);
    if(node.cronjob)node.cronjob.stop();
  }
};
exports.isExpectedRefusal = (error,expected) => expected.some(entry =>
  ['caseId','sourceId','sourceType','message'].every(key=>entry[key]===error[key]));
