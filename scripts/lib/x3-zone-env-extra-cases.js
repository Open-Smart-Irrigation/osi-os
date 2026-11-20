'use strict';
const assert = require('node:assert/strict');
const NOW = '2026-10-25T01:30:00.000Z';
const s = value => value == null ? 'NULL' : "'" + String(value).replace(/'/g, "''") + "'";
const ENV = 'zone-env-fn', TODAY = 'strega-today-liters-fn', QUERY = 'get-actuations-query', FORMAT = 'get-actuations-response';
const fullBundle = { zoneId: 0, zoneName: 'Shared detail', generatedAt: '2026-10-25T01:00:00Z',
  display: { sharedGeneratedAt: '2026-10-25T01:01:00Z', sharedObservedAt: '2026-10-25T01:02:00Z', lastReceivedAt: '2026-10-25T01:03:00Z', fallbackReason: 'fixture shared display' },
  location: { latitude: 12, longitude: 34, timezone: 'Europe/Zurich', source: 'server' },
  online: { available: true, source: 'fixture_shared', current: { airTemperatureC: 0 } },
  agronomic: { current: { etcMmDay: 0 } }, forecast: { available: true, source: 'fixture_shared', rainFocus: { totalNext24hMm: 0 } },
  water: { available: true, observedAt: '2026-10-25T01:04:00Z', rainTodayMm: 0, waterNeededTodayMm: 0, daily: [{ date: '2026-10-25', rainMm: 0 }] } };
function seedExtra(db, c, bundle) {
  db.exec("UPDATE users SET user_uuid='11111111-1111-4111-8111-111111111111';");
  if (c.bundle) Object.assign(bundle, c.bundle);
  if (c.gatewayCoordinates) db.exec("UPDATE irrigation_zones SET latitude=NULL,longitude=NULL; INSERT INTO gateway_locations(gateway_device_eui,latitude,longitude,updated_at) VALUES('0016C001F1000001',12,34,'2026-10-25T01:30:00.000Z');");
  if (c.legacyCache) db.exec(`INSERT INTO zone_weather_cache(zone_id,cache_key,payload_json,fetched_at,expires_at) VALUES(1,'online_current','{"airTemperatureC":99}','${NOW}','2027-01-01'),(1,'forecast','{"source":"legacy"}','${NOW}','2027-01-01');`);
  if (c.noRuns || c.runRows) db.exec('DELETE FROM valve_actuation_expectations;');
  for (const [i, row] of (c.runRows || []).entries()) db.exec(`INSERT INTO valve_actuation_expectations(expectation_id,device_eui,zone_id,command_id,commanded_at,commanded_duration_seconds,expected_close_at,estimated_gross_liters,volume_source,reconciliation_state,transport_json,created_at) VALUES(${s('extra-'+i)},'A840410000000001',1,${s(row.report ? null : 'extra-cmd-'+i)},${s(row.at)},120,${s(row.at)},${s(row.liters)},'calibrated','OBSERVED_COMPLETE',${s(row.transport || '{}')},${s(row.at)});`);
  if (c.badVolume) db.exec("UPDATE valve_actuation_expectations SET estimated_gross_liters='not-a-number';");
  if (c.populatedReads) db.exec(`INSERT INTO zone_daily_recommendations(zone_id,date,irrigation_action,action_reasoning,computed_at) VALUES(1,'2026-10-25','irrigate_today','Fixture recommendation','${NOW}'); INSERT INTO zone_daily_agronomy(zone_id,date,et0_mm,et0_station_id,hours_present,expected_hours,computed_at) VALUES(1,'2026-10-24',2,'A840410000000001',24,24,'${NOW}');`);
  if (c.legacySchema) {
    // Local-only upgrade fixture: retain child history, remove only the old
    // compatibility columns/tables. No migration or production seed is edited.
    db.exec('PRAGMA foreign_keys=OFF;');
    for (const row of db.rows("SELECT name FROM sqlite_master WHERE type='trigger'", [])) db.exec('DROP TRIGGER "' + row.name + '";');
    const zone = db.rows('SELECT id,name,user_id,zone_uuid,stage_started_on,crop_type FROM irrigation_zones', [])[0];
    db.exec('DROP TABLE irrigation_zones; CREATE TABLE irrigation_zones(id INTEGER PRIMARY KEY,name TEXT,user_id INTEGER,zone_uuid TEXT,stage_started_on TEXT,crop_type TEXT);');
    db.exec('INSERT INTO irrigation_zones VALUES(' + Object.values(zone).map(s).join(',') + ');');
    const device = db.rows('SELECT deveui,name,type_id,user_id,irrigation_zone_id,created_at,rain_gauge_enabled,flow_meter_enabled FROM devices', [])[0];
    db.exec('DROP TABLE devices; CREATE TABLE devices(deveui TEXT PRIMARY KEY,name TEXT,type_id TEXT,user_id INTEGER,irrigation_zone_id INTEGER,created_at TEXT,rain_gauge_enabled INTEGER,flow_meter_enabled INTEGER);');
    db.exec('INSERT INTO devices VALUES(' + Object.values(device).map(s).join(',') + ');');
    for (const table of ['zone_weather_cache','zone_shared_environment','gateway_locations']) db.exec('DROP TABLE ' + table + ';');
    db.exec('PRAGMA foreign_keys=ON;');
  }
}
function schemaState(db) {
  const tables = ['irrigation_zones','devices','zone_weather_cache','zone_shared_environment','gateway_locations','valve_actuation_expectations'];
  return { columns: Object.fromEntries(tables.map(table => [table, db.rows('PRAGMA table_info(' + table + ')', []).map(r => ({ name:r.name,type:r.type,notnull:r.notnull,pk:r.pk }))])),
    recommendations: db.rows('SELECT zone_id,date,irrigation_action,action_reasoning FROM zone_daily_recommendations ORDER BY zone_id,date', []),
    agronomy: db.rows('SELECT zone_id,date,et0_mm,et0_station_id FROM zone_daily_agronomy ORDER BY zone_id,date', []) };
}
const cases = [];
function add(name, node, options = {}, expect = {}) { cases.push({ name: 'extra/' + name, node, extended: true, ...options, expect }); }
add('openagri-token-outage', ENV, { openagri:true,httpFaults:[{match:'/auth/token',failure:'status'}] }, { status:200, online:'open_meteo', forecast:'open_meteo', http:['/auth/token','current=','/auth/token','hourly='], diagnostic:['OpenAgri current','OpenAgri forecast'] });
add('openagri-current-outage', ENV, {openagri:true,httpFaults:[{match:'/weather/',failure:'timeout'}]}, {status:200,online:'open_meteo',forecast:'openagri',diagnostic:['OpenAgri current'],http:['/weather/','current=']});
add('openagri-current-missing-main',ENV,{openagri:true,httpReplies:{'/weather/':{data:{wind:{speed:0}}}}},{status:200,online:'open_meteo',http:['/weather/','current=']});
add('openagri-forecast-outage',ENV,{openagri:true,httpFaults:[{match:'/forecast5/',failure:'malformed'}]},{status:200,forecast:'open_meteo',diagnostic:['OpenAgri forecast']});
add('meteo-supplement-outage',ENV,{openagri:true,httpFaults:[{match:'hourly=',failure:'network'}]},{status:200,forecast:'openagri',diagnostic:['Open-Meteo forecast']});
add('http-transport',ENV,{openagri:true,providerUrl:'http://provider.example.test'},{status:200,transports:['http','https'],online:'openagri'});
for (const node of [ENV,TODAY]) {
  for (const authCase of ['wrong-signature','malformed-json','missing-user','missing-name']) add(node+'/'+authCase,node,{authCase},{status:401,sqlAbsent:['SELECT iz.','SELECT estimated_gross_liters']});
  add(node+'/jwt-secret',node,{env:{AUTH_TOKEN_SECRET:'',JWT_SECRET:'x3-local-fixture-secret'}},{status:200});
  add(node+'/valve-predicate-missing',node,{missingPredicate:true},{status:node===TODAY?503:200});
  add(node+'/callback-close-error',node,{closeCallbackError:true},{status:200,closeCallbacks:1});
}
for (const authStorage of ['existing','read-error','write-error','generate']) add('today-file-'+authStorage,TODAY,{authStorage,signGenerated:authStorage==='generate'||authStorage==='read-error',env:{AUTH_TOKEN_SECRET:''}},{status:authStorage==='write-error'?500:200,fsRead:true});
add('scope-real-zone-query',ENV,{scoped:true,realScope:true},{status:200,sql:['SELECT zone_uuid FROM irrigation_zones']});
add('scope-resolution-failure',ENV,{scoped:true,scopeResolveError:true},{status:500,error:'fixture zone resolution failure'});
add('bundle-first-nonmatching',ENV,{linked:true,sharedEntries:[{zoneUuid:'other-fixture',summary:fullBundle}]},{status:200,display:'shared_server',zoneName:'Shared detail'});
add('bundle-no-summary',ENV,{linked:true,sharedEntries:[{zoneUuid:'zone-fixture'}]},{status:200,display:'local_fallback'});
add('bundle-populated-precedence',ENV,{linked:true,bundle:fullBundle},{status:200,display:'shared_server',online:'fixture_shared',sharedGeneratedAt:fullBundle.display.sharedGeneratedAt,sharedObservedAt:fullBundle.display.sharedObservedAt});
add('gateway-location',ENV,{gatewayCoordinates:true},{status:200,location:'gateway'});
add('legacy-cache-keys',ENV,{legacyCache:true},{status:200,online:'open_meteo',http:['current=','hourly=']});
add('asymmetric-expired-current',ENV,{cached:true,currentOnly:true,expired:true,httpFaults:[{match:'current=',failure:'timeout'}]},{status:200,cache:'stale',forecast:'open_meteo',diagnostic:['Open-Meteo current']});
add('compatibility-fresh',ENV,{legacySchema:true},{status:200,compatFresh:true});
add('populated-recommendation-station',ENV,{populatedReads:true},{status:200,populated:true});
const marker = JSON.stringify({physical_run:{version:1,source:'explicit_report',earliest_possible_start_at:null,latest_possible_end_at:null}});
for(const node of [ENV,TODAY,QUERY]) add(node+'/report-markers',node,{runRows:[{at:'2026-10-25T00:00:00Z',liters:90,report:true,transport:marker},{at:'2026-10-25T00:10:00Z',liters:80,report:true,transport:'{'},{at:'2026-10-25T00:20:00Z',liters:3}]},{status:node===QUERY?undefined:200,liters:node===TODAY?3:undefined,estimated:node===ENV?3:undefined,runCount:node===QUERY?1:undefined});
add('nonfinite-today',TODAY,{badVolume:true},{status:200,liters:null});
add('nonfinite-zone',ENV,{badVolume:true},{status:200,estimated:0});
add('empty-history',QUERY,{noRuns:true},{runCount:0});
add('empty-formatter',FORMAT,{payload:null},{status:200,formattedCount:0});
for(const [label,now,dates] of [
 ['spring','2026-03-29T01:30:00Z',['2026-03-28T22:59:59Z','2026-03-28T23:00:00Z','2026-03-29T00:59:59Z','2026-03-29T01:00:00Z','2026-03-29T22:00:00Z']],
 ['fall','2026-10-25T00:30:00Z',['2026-10-24T21:59:59Z','2026-10-24T22:00:00Z','2026-10-25T00:59:59Z','2026-10-25T01:00:00Z','2026-10-25T23:00:00Z']],
 ['midnight','2026-10-26T00:00:00Z',['2026-10-25T22:59:59Z','2026-10-25T23:00:00Z','2026-10-26T00:59:59Z','2026-10-26T01:00:00Z','2026-10-26T23:00:00Z']],
]) for(const node of [ENV,TODAY]) add(label+'/'+node,node,{now,timezone:'Europe/Zurich',runRows:dates.map((at,i)=>({at,liters:(i+1)*10}))},{status:200,estimated:node===ENV?90:undefined,liters:node===TODAY?(process.env.TZ==='Europe/Zurich'?140:120):undefined,dateBoundary:true});
for(const quarantined of [false,true]) {
 for(const node of [TODAY,QUERY,FORMAT]) add('loader-'+quarantined+'/'+node,node,{missingModule:'zone-env',quarantined,loaderChange:true},{legacyStatus:node===QUERY?undefined:200,status:503});
 add('loader-missing-bearer-'+quarantined,TODAY,{missingModule:'zone-env',quarantined,auth:'missing'},{status:401,authCode:'MISSING_BEARER',noFacade:true});
 add('loader-empty-user-'+quarantined,QUERY,{missingModule:'zone-env',quarantined,noUser:true},{status:401,noFacade:true});
 for(const authCase of ['wrong-signature','malformed-json','missing-user','missing-name']) add('loader-early-'+authCase+'-'+quarantined,TODAY,{missingModule:'zone-env',quarantined,authCase},{status:401,noFacade:true});
 add('loader-invalid-device-'+quarantined,TODAY,{missingModule:'zone-env',quarantined,invalidId:true},{status:400,noFacade:true});
}
function reply(result) { return Array.isArray(result.result) ? result.result.find(Boolean) : result.result; }
function assertCase(c, result, after=false) {
 const e=c.expect,m=reply(result),p=m&&m.payload,tag=c.name;
 const status=c.loaderChange&&!after?e.legacyStatus:e.status;
 if(status!==undefined) assert.equal(m?.statusCode,status,tag+' status');
 if(c.loaderChange&&after) { assert.deepEqual(p,{message:'Internal error'},tag); assert.equal(result.diagnostics.filter(d=>d.kind==='error').length,1,tag+' diagnostic'); return; }
 for(const [field,path] of [['online',['online','source']],['forecast',['forecast','source']],['display',['display','mode']],['location',['location','source']],['sharedGeneratedAt',['display','sharedGeneratedAt']],['sharedObservedAt',['display','sharedObservedAt']]]) if(e[field]!==undefined) assert.equal(path.reduce((v,k)=>v?.[k],p),e[field],tag+' '+field);
 if(e.zoneName) assert.equal(p.zoneName,e.zoneName,tag);
 if(e.error) assert.equal(p.error,e.error,tag);
 if(e.cache) assert.equal(p.online.cacheStatus,e.cache,tag);
 if(e.dateBoundary && c.node === TODAY) assert.equal(p.liters,process.env.TZ === 'Europe/Zurich' ? 140 : 120,tag+' process midnight');
 else if(Object.hasOwn(e,'liters')&&e.liters!==undefined) assert.equal(p.liters,e.liters,tag);
 if(e.estimated!==undefined) assert.equal(p.water.irrigationTodayEstimatedLiters,e.estimated,tag);
 if(e.runCount!==undefined) assert.equal(p.length,e.runCount,tag);
 if(e.formattedCount!==undefined) assert.equal(p.actuations.length,e.formattedCount,tag);
 for(const needle of e.sql||[]) assert.ok(result.trace.some(t=>t.sql?.includes(needle)),tag+' missing SQL '+needle);
 for(const needle of e.sqlAbsent||[]) assert.ok(!result.trace.some(t=>t.sql?.includes(needle)),tag+' unexpected SQL '+needle);
 for(const needle of e.http||[]) assert.ok(result.trace.some(t=>t.kind==='http'&&t.url.includes(needle)),tag+' HTTP '+needle);
 for(const request of result.trace.filter(t=>t.kind==='http')) assert.equal(request.transport,new URL(request.url).protocol.slice(0,-1),tag+' transport chosen by URL');
 for(const transport of e.transports||[]) assert.ok(result.trace.some(t=>t.transport===transport),tag+' transport '+transport);
 if(after) for(const context of e.diagnostic||[]) assert.ok(result.diagnostics.some(d=>d.kind==='warn'&&String(d.value).includes('zone-env '+context+' failed:')),tag+' diagnostic '+context);
 if(c.authCase) assert.deepEqual(result.branches.signatureChecks,[c.authCase!=='wrong-signature'],tag+' reaches the intended signature/claim path');
 if(e.fsRead) { assert.equal(result.trace.filter(t=>t.kind==='fs-read').length,c.authStorage==='existing'?1:2,tag+' file reads'); assert.equal(result.trace.filter(t=>t.kind==='fs-write').length,c.authStorage==='existing'?0:c.authStorage==='write-error'?2:1,tag+' file writes'); }
 if(e.authCode) assert.equal(m._osiAuthFailure.code,e.authCode,tag);
 if(e.noFacade) assert.ok(!result.branches.loads.includes('zone-env'),tag+' early reply must precede facade load');
 if(e.closeCallbacks) assert.equal(result.branches.closeCallbacks,e.closeCallbacks,tag);
 if(e.compatFresh) { assert.ok(result.schema.columns.irrigation_zones.some(x=>x.name==='timezone'),tag); assert.ok(result.schema.columns.zone_weather_cache.length>0,tag); assert.ok(!result.branches.sqlErrors.some(x=>x.sql.startsWith('ALTER TABLE')),tag+' first ALTER must succeed'); }
 if(e.populated) { assert.equal(result.schema.recommendations.length,1,tag); assert.equal(result.schema.agronomy.length,1,tag); assert.ok(result.trace.some(t=>t.sql?.startsWith('SELECT deveui,name FROM devices WHERE deveui IN')),tag+' station names'); }
}
module.exports={cases,seedExtra,schemaState,assertCase,reply};
