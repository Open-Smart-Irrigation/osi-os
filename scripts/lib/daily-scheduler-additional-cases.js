'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { cases, NOW } = require('./daily-scheduler-cases');
function bearer(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return 'Bearer ' + data + '.' + crypto.createHmac('sha256', secret).update(data).digest('base64url');
}
function additionalCases() {
  const all = [], base = cases();
  function add(name, seed, change, branch) { const c = structuredClone(base.find(c => c.name === seed)); assert.ok(c); c.name = 'extra-' + name; change(c); c.branch = branch; all.push(c); }
  for (const fallback of ['display', 'generated']) add('server-' + fallback, 'dendro-server_preferred-bundle-age-0', c => {
    const b = JSON.parse(c.msg.zone.shared_environment_json); c.msg.zone.shared_environment_received_at = null;
    if (fallback === 'display') b.display.lastReceivedAt = new Date(NOW).toISOString(); else b.generatedAt = new Date(NOW).toISOString();
    delete b.drift; delete b.display.sharedGeneratedAt;
    c.msg.zone.shared_environment_json = JSON.stringify(b);
  }, 'server-fallback-stale');
  add('fraction-round-zero','dendro-action-decrease_20', c => { c.msg.zone.duration_minutes = 0.1; }, 'duration-ten');
  for (const seed of ['swt-no-rows','dendro-absent','dendro-age-129600001']) add('missing-valve-' + seed, seed, c => { c.msg.zone.valve_deveui = null; }, seed === 'swt-no-rows' ? 'no_data_last_hour' : seed === 'dendro-absent' ? 'no_dendro_recommendation' : 'stale_dendro_recommendation');
  add('jwt-secret','auth-valid', c => { c.env = { AUTH_TOKEN_SECRET: '', JWT_SECRET: 'synthetic-x1-secret' }; }, 'jwt-secret');
  add('no-expiry','auth-valid', c => { c.msg.req.headers.authorization = bearer({userId:1, username:"actor's name"}, 'synthetic-x1-secret'); }, 'auth-success');
  for (const failure of ['fs-empty-first','fs-empty','first-write']) add(failure,'auth-valid', c => {
    c.env = { AUTH_TOKEN_SECRET: '' }; c.failure = failure;
    if (failure !== 'fs-empty-first') c.msg.req.headers.authorization = bearer({userId:1, username:"actor's name",exp:NOW+1000}, Buffer.alloc(48,3).toString('hex'));
  }, failure === 'fs-empty-first' ? 'second-read' : failure === 'first-write' ? 'second-write' : 'generated-secret');
  add('scope-warning','auth-scoped-none', c => { c.failure = 'scope-warning'; }, 'scope-warning');
  add('callback-close','auth-scoped-none', c => { c.failure = 'db-close-callback'; }, 'auth-success');
  add('falsy-enabled-response','validate-save', c => { c.msg.req_body.enabled = ''; c.msg.req_body.response_mode = ''; }, 'falsy-validation');
  add('wrong-kind','upsert-version-4-enabled-1', c => { c.msg.osi.request.kind = 'wrong'; }, 'context-error');
  add('null-uuid-unknown-gateway','upsert-version-4-enabled-1', c => { c.msg.payload[0].zone_uuid = null; delete c.msg.syncAck; c.env={DEVICE_EUI:''}; c.msg.osi.request.validatedPatch.response_mode=''; }, 'upsert-fallback');
  for (const [name, now] of Object.entries({fold1:'2026-10-25T00:30:00Z',fold2:'2026-10-25T01:30:00Z',spring:'2026-03-29T01:30:00Z',localMidnight:'2026-10-24T22:01:00Z',utcRollover:'2026-10-25T00:01:00Z'})) add(name,'swt-mean-30',c=>{ c.now=Date.parse(now); c.msg.zone.last_triggered_at=name==='utcRollover'?'2026-10-24T23:59:00Z':name==='localMidnight'?'2026-10-24T01:00:00Z':'2026-10-25T00:00:00Z'; },name==='fold1'||name==='fold2'||name==='localMidnight'?'clock_jump_backward_suppressed':'fires');
  return all;
}
function assertBranch(c, out) {
  const result=out.result, trace=out.trace;
  if (['no_data_last_hour','no_dendro_recommendation','stale_dendro_recommendation','clock_jump_backward_suppressed'].includes(c.branch)) return assert.ok(result[1].topic.includes("'"+c.branch+"'"), c.name);
  if(c.branch==='server-fallback-stale') { assert.match(result[1].topic,/server_shared_bundle/); assert.match(result[1].topic,/stale_dendro_recommendation/); }
  else if(c.branch==='duration-ten') assert.equal(result[0].payload.data.duration_minutes,10);
  else if(c.branch==='fires') assert.equal(result[0].payload.data.action,'OPEN_FOR_DURATION');
  else if(c.branch==='context-error') assert.match(out.error.message,/context mismatch/);
  else if(c.branch==='falsy-validation') {assert.equal(out.msg.osi.request.validatedPatch.enabled,0);assert.equal(out.msg.osi.request.validatedPatch.response_mode,'proportional');}
  else if(c.branch==='upsert-fallback') {assert.equal(out.msg.osi.applied.zone_uuid,null);assert.equal(out.msg.osi.applied.gateway_device_eui,'UNKNOWN');assert.equal(out.msg.syncAck.aggregateType,'SCHEDULE');assert.match(out.msg.topic,/'proportional'/);}
  else { assert.ok(result[0],c.name+' authorized');
    if(c.branch==='jwt-secret') assert.ok(!trace.some(t=>t[0]==='global-get'),'JWT fallback avoids secret files');
    if(c.branch==='second-read') assert.equal(trace.filter(t=>t[0]==='read').length,2);
    if(c.branch==='second-write') assert.equal(trace.filter(t=>t[0]==='write').length,2);
    if(c.branch==='generated-secret') assert.ok(trace.some(t=>t[0]==='random-bytes'));
    if(c.branch==='scope-warning') assert.ok(trace.some(t=>t[0]==='warn'&&t[1]==='synthetic scope warning'));
  }
}
module.exports={additionalCases,assertBranch};

function nativeBoundaryCases() {
 const all=[],base=cases();
 for(const [label,seed,port] of [['zone-list-select','zones',0],['swt-evidence-select','query-SWT_1',0],['dendro-evidence-select','query-DENDRO',0],['event-insert','swt-mean-30',1],['last-trigger-update','swt-mean-30',2],['user-lookup','auth-valid',0],['ownership-version-select','validate-save',0],['schedule-upsert','upsert-version-4-enabled-1',0],['outbox-trigger','upsert-version-4-enabled-1',0]]) {
  const c=structuredClone(base.find(c=>c.name===seed));c.name='native-SQL-'+label;c.boundaryFault={port,label};all.push(c);
 }
 for(const seed of ['auth-missing-request','validate-user-[]','validate-save','auth-valid','upsert-missing-zone','upsert-version-4-enabled-1','query-invalid-zone']) for(const failure of ['daily-load','daily-quarantined']) {
  const c=structuredClone(base.find(c=>c.name===seed));c.name='native-'+failure+'-'+seed;c.failure=failure;c.loaderOutage=true;all.push(c);
 }
 for(let read=1;read<=7;read++) {const c=structuredClone(base.find(c=>c.name==='auth-scoped-none'));c.name='native-real-scope-read-'+read;c.failure=undefined;c.scopeReadFailure=read;all.push(c);}
 const spring=structuredClone(base.find(c=>c.name==='swt-mean-30'));spring.name='native-spring-jump';spring.now=Date.parse('2026-03-29T01:30:00Z');spring.msg.zone.last_triggered_at='2026-03-29T00:30:00Z';all.push(spring);
 for(const failure of ['daily-load','daily-quarantined']) {
  const c=structuredClone(base.find(c=>c.name==='auth-scoped-none'));c.name='native-scoped-invalid-zone-'+failure;c.msg.req.params.id='1.5';c.failure=failure;c.loaderOutage=true;all.push(c);
 }
 const scopeFirst=structuredClone(base.find(c=>c.name==='auth-scoped-none'));scopeFirst.name='native-scoped-invalid-zone-scope-load-first';scopeFirst.msg.req.params.id='1.5';scopeFirst.failure='scope-load-second';all.push(scopeFirst);
 return all;
}
module.exports.nativeBoundaryCases=nativeBoundaryCases;
