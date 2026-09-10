'use strict';
const scope = require('../osi-scope-helper');
const TYPES = {UPSERT_DEVICE_INSTALLATION_LOCATION:'saveLocation',UPSERT_DEVICE_RADIO_CONFIGURATION:'saveRadioConfiguration'};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(message) { const error = new Error(message); error.code='invalid_revision_command'; return error; }
async function queueAck(tx, ack) {
  await tx.run('DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',[String(ack.commandId)]);
  await tx.run('INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES(?,?,?)',[String(ack.commandId),JSON.stringify(ack),ack.appliedAt]);
}
async function applyCommand(db,envelope,runtime={}) {
  const type=String(envelope && envelope.commandType || '');
  if(!TYPES[type])return {handled:false};
  const id=envelope.commandId,p=envelope.payload;
  if(!Number.isSafeInteger(id)||id<1||!p||typeof p!=='object'||Array.isArray(p))throw invalid('invalid protected delivery envelope');
  return db.transaction(async tx=>{
    const previous=await tx.get('SELECT result_detail FROM applied_commands WHERE command_id=?',[String(id)]);
    if(previous){const ack=JSON.parse(previous.result_detail);await queueAck(tx,ack);return {handled:true,ack};}
    let result='APPLIED',reason=null,revision;
    try {
      if(p.command_type!==type||!UUID.test(p.command_id||'')||!UUID.test(p.revision_uuid||'')||!UUID.test(p.installation_uuid||''))throw invalid('invalid revision command identity');
      if(!/^[0-9A-F]{16}$/.test(p.device_eui||'')||!UUID.test(p.actor_user_uuid||''))throw invalid('invalid device or actor identity');
      if(p.base_revision_uuid!==null&&!UUID.test(p.base_revision_uuid||''))throw invalid('base_revision_uuid must be present');
      const prefix=type==='UPSERT_DEVICE_INSTALLATION_LOCATION'?'device_installation_location':'device_radio_configuration';
      if(p.effect_key!==prefix+':'+p.revision_uuid+':'+(p.base_revision_uuid||'initial'))throw invalid('revision effect binding mismatch');
      if(!p.values||typeof p.values!=='object'||Array.isArray(p.values))throw invalid('revision values required');
      const actor=await tx.get('SELECT disabled_at FROM users WHERE user_uuid=?',[p.actor_user_uuid]);
      if(!actor||actor.disabled_at)throw invalid('actor account disabled or missing');
      const access=await scope.assertFreshDeviceAccess(tx,p.actor_user_uuid,p.device_eui,{scopedMode:runtime.scopedMode===true});
      if(!scope.canMutate(access.role))throw invalid('actor cannot change installation');
      const helper=require('./index');
      // The outer transaction owns revision, outbox event, command ledger and ACK.
      const transactional={get:tx.get.bind(tx),run:tx.run.bind(tx),transaction:fn=>fn(tx)};
      revision=await helper[TYPES[type]](transactional,{deviceEui:p.device_eui,installationUuid:p.installation_uuid,gatewayEui:runtime.gateway_device_eui,actorUserUuid:p.actor_user_uuid,revisionUuid:p.revision_uuid,baseRevisionUuid:p.base_revision_uuid,values:p.values});
    } catch(error) {
      if(error.code && /SQLITE/.test(error.code))throw error;
      if(error.code==='invalid_revision_command'||[403,404].includes(Number(error.statusCode||error.status))||/must be|invalid|required|stale|mismatch|does not exist|supersed|correction|identity/.test(error.message||'')) {
        result=/stale base|payload mismatch|base revision/.test(error.message||'')?'CONFLICT':'REJECTED_PERMANENT';reason=error.message;
      } else throw error;
    }
    const ack={commandId:id,commandType:type,effectKey:p.effect_key||null,gatewayDeviceEui:runtime.gateway_device_eui,status:result==='APPLIED'?'ACKED':result==='CONFLICT'?'CONFLICT':'NACKED',result,reason,duplicate:!!(revision&&revision.replayed),appliedSyncVersion:revision?(revision.revisionNo||revision.sync_version):null,appliedAt:new Date().toISOString()};
    await tx.run('INSERT INTO applied_commands(command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator) VALUES(?,?,?,?,?,?,?,?)',[String(id),runtime.gateway_device_eui,type,p.effect_key||null,ack.appliedAt,result,JSON.stringify(ack),'cloud']);
    await queueAck(tx,ack);
    return {handled:true,ack};
  });
}
module.exports={applyCommand};
