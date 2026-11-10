#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { executeFunction, facadeDb, loadNode, seedTestDb } = require('./lib/flow-node-harness');
// The archive runs inside the SDI-12 write handler (node sdi12-write-fn). Every
// test below drives that real node; statfs is patched so the free-disk floor
// does not depend on the machine running the suite.
const realStatfs = fs.statfsSync;
const AMPLE_DISK = () => ({ bavail: 1e9, bsize: 4096 });
fs.statfsSync = AMPLE_DISK;
test.after(() => { fs.statfsSync = realStatfs; });
const ROOT = path.resolve(__dirname, '..');
const NR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const codec = {};
vm.runInNewContext(fs.readFileSync(path.join(NR, 'codecs/dragino_sdi12_decoder.js'), 'utf8'), codec);
const manifest = fs.readFileSync(path.join(NR, 'edge-channels.json'), 'utf8');
const EUI = 'A840410000000001';
const TENSIOMARK_EUI = 'A840410000000099';
const TENSIOMARK_LAYOUT = JSON.stringify({
  version: 1,
  kind: 'tensiomark',
  source_unit: 'pF',
  field_order: 'temperature_pf',
  qualification: 'bench_observed',
  sensors: [
    { address: '1', channel: 1, identity: '111TENSIOMARK_2Vh_10A00001', depth_cm: null, calibration_range: 'unverified' },
    { address: '4', channel: 2, identity: '411TENSIOMARK_2Vh_10A00002', depth_cm: null, calibration_range: 'unverified' }
  ]
});
const RAW = '+0.732840+28.27938+37.45271+41.05683+0.969157+46.21098+38.87460+44.38053+1615.877+4237.622';
const layout = JSON.stringify({ version: 1, address: '0', sensors: [10,20,30,40,50,60,80,100].map((depth, i) => ({channel: i+1, response_position: i+1, depth_cm: depth, type: i === 0 || i === 4 ? 'TRISCAN' : 'ENVIROSCAN'})) });
const config = { sdi12_probe_profile: 'SENTEK_ENVIROSCAN', sdi12_probe_status: 'manual', sdi12_identity: '012SENTEK  XEPI  139EXAMPLE00000', sdi12_channel_layout_json: layout, sdi12_value_count: 8, soil_moisture_probe_depths_json: '{"vwc_1":10,"vwc_5":50}', soil_moisture_probe_depths_configured:1 };
function event(ascii, {index, count, time = '2026-10-28T10:00:00.123456Z', fCnt = 1, data = true} = {}) {
  const bytes = [0x0d, 0x50, count == null ? 1 : 2, ...(count == null ? [] : [count, index]), ...Buffer.from(ascii)];
  const e = {deviceInfo: {devEui:EUI, deviceProfileId:'test-sdi12-profile'}, fPort:2, fCnt, deduplicationId:`test-${fCnt}`, time, object:JSON.parse(JSON.stringify(codec.decodeUplink({fPort:2, bytes}).data)), rxInfo:[{rssi:-78, snr:7.25}]};
  if (data) e.data = Buffer.from(bytes).toString('base64');
  return e;
}
function tensiomarkEvent({payver = 1, raw = '1+16.11+0.000\r\n4+18.25+5.359\r\n', fCnt = 101} = {}) {
  const responses = raw.match(/[^\r\n]+\r\n/g) || [];
  const wrapped = [0x0e,0x16,payver];
  if (payver === 1) {
    if (responses.join('') !== raw) throw new Error('Tensiomark fixture response must contain complete records');
    responses.forEach((response,index) => {
      const bytes = Buffer.from(response,'latin1');
      wrapped.push(0xf1+index,bytes.length,...bytes);
    });
  }
  const bytes = Buffer.from(wrapped);
  return {
    deviceInfo: {devEui:TENSIOMARK_EUI, deviceProfileId:'test-sdi12-profile'},
    fPort:2,
    fCnt,
    deduplicationId:`tensiomark-${fCnt}`,
    time:'2026-10-28T11:00:00.123456Z',
    object:JSON.parse(JSON.stringify(codec.decodeUplink({fPort:2, bytes}).data)),
    rxInfo:[{rssi:-78,snr:7.25}],
    data:bytes.toString('base64')
  };
}
function fixture() {
  const db = seedTestDb();
  db.exec('PRAGMA foreign_keys=ON');
  db.prepare("INSERT INTO devices(deveui,type_id,name,user_id,created_at,updated_at) VALUES(?,'DRAGINO_SDI12','Calibration probe',1,'2026-10-28','2026-10-28')").run(EUI);
  for (const [key, value] of Object.entries(config)) db.prepare(`UPDATE devices SET ${key}=? WHERE deveui=?`).run(value,EUI);
  return db;
}
function tensiomarkFixture() {
  const db = fixture();
  db.prepare(`INSERT INTO devices(
    deveui,type_id,name,user_id,created_at,updated_at,sdi12_probe_profile,
    sdi12_probe_status,sdi12_channel_layout_json,soil_moisture_probe_depths_configured
  ) VALUES(?,'DRAGINO_SDI12','Tensiomark calibration probe',1,'2026-10-28','2026-10-28',
    'TENSIOMARK','manual',?,1)`).run(TENSIOMARK_EUI,TENSIOMARK_LAYOUT);
  return db;
}
function records(db) { return db.prepare('SELECT * FROM sdi12_transmissions ORDER BY id').all(); }
async function gate(db, e, flowState) {
  return executeFunction(loadNode('sdi12-gate-fn'), {db, msg:{payload:e}, env:{CHIRPSTACK_PROFILE_SDI12:'test-sdi12-profile'}, flowState});
}
function osiDbFor(db) {
  return {Database: function Database() { return facadeDb(db); }, isolatedFarmingTransaction: fn => fn(facadeDb(db))};
}
// Runs the real config query, then the write node: archive and canonical write in one call.
async function archive(db, msg, overrides = {}) {
  msg.payload = db.prepare(loadNode('sdi12-config-sqlite').sql).all({$deveui:msg.sdi12.deveui});
  require(path.join(NR, 'osi-device-writer')).resetColumnCache();
  const res = await executeFunction(loadNode('sdi12-write-fn'), {
    db, msg, globals:{fs:{readFileSync:()=>manifest}}, ...overrides,
    libOverrides:{osiDb:osiDbFor(db), ...(overrides.libOverrides || {})}
  });
  return res;
}
const archiveWarnings = res => res.warnings.filter(w => /layout classification|archive|decoded payload/i.test(w));

test('config query feeds the write node and includes identity and deployment provenance', () => {
  assert.deepEqual(loadNode('sdi12-config-sqlite').wires, [['sdi12-write-fn']]);
  assert.throws(() => loadNode('sdi12-archive-fn'), /node not found/);
  assert.match(loadNode('sdi12-config-sqlite').sql, /d\.sdi12_identity/);
  assert.match(loadNode('sdi12-config-sqlite').sql, /d\.soil_moisture_probe_depths_configured/);
  for (const field of ['desired_version', 'desired_layout_hash', 'compatible_layout_json', 'compatible_recipe_json', 'compatible_at']) {
    assert.match(loadNode('sdi12-config-sqlite').sql, new RegExp(`r\\.${field} AS sdi12_deployment_`));
  }
});

test('write handler stores the archive row before it loads the normalizer or the writer', async () => {
  const db = fixture();
  try {
    const g = await gate(db, event(RAW));
    const rowsAtLoad = [];
    const osiLib = {require(name) {
      if (name === 'sdi12-normalize') rowsAtLoad.push(records(db).length);
      return {ok:true, value:require(path.join(NR, 'osi-' + name))};
    }};
    const a = await archive(db, g.result[0], {libOverrides:{osiLib}});
    assert.deepEqual(a.errors, []);
    assert.equal(rowsAtLoad[0], 0, 'archive classification loads the normalizer inside the archive transaction, before its INSERT');
    assert.equal(rowsAtLoad.at(-1), 1, 'the handler loads the normalizer only after the archive row exists');
    assert.equal(records(db).length, 1);
  } finally { db.close(); }
});

test('config SELECT snapshots deployment provenance with zero and null semantics', async () => {
  const db = fixture();
  try {
    db.prepare("INSERT INTO sdi12_recipe_deployments(deveui,status,updated_at) VALUES(?,'not_applied','2026-10-28T10:00:00Z')").run(EUI);
    let selected = db.prepare(loadNode('sdi12-config-sqlite').sql).get({$deveui:EUI});
    assert.equal(selected.sdi12_deployment_desired_version, 0);
    for (const key of ['sdi12_deployment_desired_layout_hash','sdi12_deployment_compatible_layout_json','sdi12_deployment_compatible_recipe_json','sdi12_deployment_compatible_at']) assert.equal(selected[key], null);
    const e = event(RAW); const g = await gate(db,e); const a = await archive(db,g.result[0]);
    let original = records(db)[0].context_json;
    let context = JSON.parse(original);
    assert.equal(context.deploymentDesiredVersion,0);
    assert.equal(context.deploymentDesiredLayoutHash,null);
    assert.equal(context.compatibleLayout,null);
    assert.equal(context.compatibleRecipe,null);
    assert.equal(context.compatibleAt,null);
    const layoutJson = '{ "sensors" : [ { "channel": 1 } ] }';
    const recipeJson = '{"frames":[{"value":"01"}]}';
    db.prepare("UPDATE sdi12_recipe_deployments SET desired_version=7,desired_layout_hash='layout-hash',compatible_layout_json=?,compatible_recipe_json=?,compatible_at='2026-10-27T10:00:00Z',status='observed_compatible' WHERE deveui=?").run(layoutJson,recipeJson,EUI);
    db.prepare('UPDATE devices SET sdi12_identity=NULL WHERE deveui=?').run(EUI);
    const second = await archive(db,g.result[0]);
    original = records(db)[0].context_json;
    context = JSON.parse(records(db)[1].context_json);
    assert.equal(context.deploymentDesiredVersion,7);
    assert.equal(context.deploymentDesiredLayoutHash,'layout-hash');
    assert.equal(context.compatibleLayout,layoutJson);
    assert.equal(context.compatibleRecipe,recipeJson);
    assert.equal(context.compatibleAt,'2026-10-27T10:00:00Z');
    assert.equal(records(db)[0].context_json,original);
    db.prepare('DELETE FROM devices WHERE deveui=?').run(EUI);
    assert.equal(records(db)[1].context_json,JSON.stringify(context));
    const otherEui='A840410000000002';
    db.prepare("INSERT INTO devices(deveui,type_id,name,user_id,created_at,updated_at) VALUES(?,'DRAGINO_SDI12','Second probe',1,'2026-10-28','2026-10-28')").run(otherEui);
    const absent=db.prepare(loadNode('sdi12-config-sqlite').sql).get({$deveui:otherEui});
    for (const key of ['sdi12_deployment_desired_version','sdi12_deployment_desired_layout_hash','sdi12_deployment_compatible_layout_json','sdi12_deployment_compatible_recipe_json','sdi12_deployment_compatible_at']) assert.equal(absent[key],null);
    assert.ok(a.result && second.result);
  } finally { db.close(); }
});

test('mixed-layout eligibility is validated, optional failures warn, and every complete row survives', async t => {
  const db=fixture();
  const normalizer=require(path.join(NR,'osi-sdi12-normalize'));
  const cases=[
    ['mixed layout',config.sdi12_channel_layout_json,normalizer, 'sentek_mixed_v1','sentek_v1'],
    ['pure EnviroSCAN',JSON.stringify({...JSON.parse(layout),sensors:JSON.parse(layout).sensors.map(s=>({...s,type:'ENVIROSCAN'}))}),normalizer,null,'sentek_v1'],
    ['null layout',null,normalizer,null,'sentek_v1'],
    ['invalid layout', '{',normalizer,null,'sentek_v1'],
    ['non-Sentek profile',layout,normalizer,null,null],
    ['missing validator',layout,{validateSentekLayout:undefined},null,'sentek_v1'],
    ['loader failure',layout,'loader-failure',null,'sentek_v1'],
    ['validator exception',layout,{validateSentekLayout(){throw Error('validator failed');}},null,'sentek_v1']
  ];
  try {
    for (const [name,layoutValue,moduleValue,expected,family] of cases) await t.test(name,async()=>{
      db.prepare('UPDATE devices SET sdi12_channel_layout_json=?,sdi12_probe_profile=? WHERE deveui=?').run(layoutValue,name==='non-Sentek profile'?'DRAGINO_SDI12':'SENTEK_ENVIROSCAN',EUI);
      const g=await gate(db,event(name==='mixed layout'?'+0.732840+28.27938+37.45271+41.05683+0.969157+46.21098':RAW,{fCnt:100+records(db).length}));
      let normalizerLoads=0;
      const osiLib={require(moduleName){
        if(moduleName==='sdi12-normalize'){
          normalizerLoads++;
          // Only the archive's classification load fails; the write handler loads the real normalizer.
          if(moduleValue==='loader-failure'&&normalizerLoads===1)return {ok:false,error:'injected loader failure'};
          if(moduleValue==='loader-failure')return {ok:true,value:normalizer};
          return {ok:true,value:{...normalizer,...moduleValue}};
        }
        return {ok:true,value:require(path.join(NR,'osi-'+moduleName))};
      }};
      const a=await archive(db,g.result[0],{libOverrides:{osiLib}});
      assert.deepEqual(a.errors,[]);
      const row=records(db).at(-1);
      const context=JSON.parse(row.context_json);
      assert.equal(context.normalization,expected);
      assert.equal(context.profileFamily,family);
      assert.ok(row.raw_ascii,'complete archive row commits for classification cases');
      if(name==='missing validator'||name==='loader failure'||name==='validator exception')assert.ok(a.warnings.some(x=>/layout classification failed/i.test(x)));
      else assert.deepEqual(archiveWarnings(a),[]);
      // The archive loads the normalizer only to classify a Sentek layout; the write handler always loads it once.
      assert.equal(normalizerLoads,name==='non-Sentek profile'?1:2);
      if(name==='mixed layout')assert.equal(row.raw_ascii,'+0.732840+28.27938+37.45271+41.05683+0.969157+46.21098');
      if(name==='mixed layout'){
        const canonical=db.prepare('SELECT vwc_1,soil_vic_1 FROM device_data WHERE deveui=? ORDER BY id DESC LIMIT 1').get(EUI);
        assert.equal(canonical.vwc_1,null);
        assert.equal(canonical.soil_vic_1,null);
      }
    });
  } finally {db.close();}
});

test('PAYVER 1 archives exact text, application bytes and context while canonical readings stay rounded', async () => {
  const db = fixture();
  try {
    const e = event(RAW);
    const g = await gate(db, e);
    const a = await archive(db, g.result[0]);
    assert.deepEqual(a.errors, []);
    const r = records(db)[0];
    assert.equal(r.raw_ascii, RAW);
    assert.equal(r.deveui, EUI);
    assert.equal(r.recorded_at, e.time);
    assert.equal(r.payload_version, 1);
    assert.ok(Number.isFinite(Date.parse(r.received_at)));
    const frames = JSON.parse(r.frames_json);
    assert.deepEqual(frames[0].event, e);
    assert.ok(Number.isFinite(Date.parse(frames[0].receivedAt)));
    const context = JSON.parse(r.context_json);
    assert.equal(context.channelLayout, layout);
    assert.equal(context.probeIdentity, config.sdi12_identity);
    assert.equal(context.probeProfile, 'SENTEK_ENVIROSCAN');
    assert.equal(context.normalization, 'sentek_mixed_v1');
    assert.equal(context.profileFamily,'sentek_v1');
    assert.equal(context.valueCount, 8);
    assert.ok(a.statuses.some(x => x.fill === 'green' && x.text === 'SDI12 transmission archived'));
    const canonical = db.prepare('SELECT vwc_1,vwc_2,vwc_5,soil_vic_1 FROM device_data WHERE deveui=?').get(EUI);
    assert.deepEqual({...canonical}, {vwc_1:23.81,vwc_2:28.28,vwc_5:48.72,soil_vic_1:1615.88});
    assert.equal(records(db).length, 1);
  } finally { db.close(); }
});

test('configured Tensiomark uplinks archive original frames and keep the Tensiomark writer independent', async () => {
  const raw = '1+16.11+0.000\r\n4+18.25+5.359\r\n';
  const db = tensiomarkFixture();
  try {
    const e = tensiomarkEvent({raw});
    const g = await gate(db,e);
    assert.equal(g.result[0].sdi12.payloadBase64,e.data);
    assert.equal(g.result[0].sdi12.decoded.data_sum,raw);
    const a = await archive(db,g.result[0]);
    assert.deepEqual(a.errors,[]);
    const archived = records(db)[0];
    assert.equal(archived.raw_ascii,raw);
    assert.equal(archived.deveui,TENSIOMARK_EUI);
    const frames = JSON.parse(archived.frames_json);
    assert.equal(frames.length,1);
    assert.equal(frames[0].event.data,e.data);
    assert.deepEqual(frames[0].event, e);
    const context = JSON.parse(archived.context_json);
    assert.equal(context.probeProfile,'TENSIOMARK');
    assert.equal(context.normalization,null);
    const observation = db.prepare('SELECT * FROM tensiomark_observations WHERE deveui=?').get(TENSIOMARK_EUI);
    assert.equal(observation.raw_response,raw);
    assert.equal(observation.payload_base64,e.data);
    assert.equal(observation.disposition,'accepted');
    const normalized = JSON.parse(observation.normalized_json);
    assert.deepEqual(normalized.native_pf,{swt_1:'+0.000',swt_2:'+5.359'});
    const canonical = db.prepare('SELECT * FROM device_data WHERE deveui=?').get(TENSIOMARK_EUI);
    assert.equal(canonical.id,observation.device_data_id);
    assert.equal(canonical.bat_v,3.606);
    assert.equal(canonical.swt_1,0.1);
    assert.equal(canonical.soil_temp_1,16.11);
    assert.equal(canonical.swt_2,Math.pow(10,5.359-1));
    assert.equal(canonical.soil_temp_2,18.25);
  } finally { db.close(); }

  const unavailable = tensiomarkFixture();
  try {
    const e = tensiomarkEvent({fCnt:102});
    const g = await gate(unavailable,e);
    unavailable.exec('DROP TABLE sdi12_transmissions');
    const a = await archive(unavailable,g.result[0]);
    assert.match(a.errors.join(' '),/SDI12 archive failed/);
    assert.ok(a.result);
    assert.equal(unavailable.prepare('SELECT count(*) AS n FROM tensiomark_observations WHERE deveui=?').get(TENSIOMARK_EUI).n,1);
    assert.equal(unavailable.prepare('SELECT count(*) AS n FROM device_data WHERE deveui=?').get(TENSIOMARK_EUI).n,1);
  } finally { unavailable.close(); }

  const quarantine = tensiomarkFixture();
  try {
    const e = tensiomarkEvent({payver:2,fCnt:103});
    const g = await gate(quarantine,e);
    assert.ok(g.result[0].sdi12.quarantineOnly);
    assert.equal(g.result[0].sdi12.payloadBase64,e.data);
    const a = await archive(quarantine,g.result[0]);
    assert.equal(records(quarantine).length,0);
    const observation = quarantine.prepare('SELECT * FROM tensiomark_observations WHERE deveui=?').get(TENSIOMARK_EUI);
    assert.equal(observation.disposition,'rejected_framing');
    assert.equal(quarantine.prepare('SELECT count(*) AS n FROM ingest_quarantine').get().n,0);
  } finally { quarantine.close(); }
});

test('PAYVER 2 preserves frames and split numeric tokens in index order despite out-of-order reception', async () => {
  const db = fixture();
  try {
    const chunks = [RAW.slice(0,19), RAW.slice(19,61), RAW.slice(61)];
    const events = chunks.map((chunk,index) => event(chunk,{index,count:3,fCnt:index+10,time:`2026-10-28T10:00:0${index}.000Z`}));
    let state = {};
    let complete;
    for (const i of [2,0,1]) {
      const g = await gate(db, events[i], state);
      state = g.flowState;
      if (g.result) complete = g.result[0];
      else assert.equal(records(db).length,0);
    }
    const a = await archive(db, complete);
    assert.deepEqual(a.errors, []);
    const r = records(db)[0];
    assert.equal(r.raw_ascii, RAW);
    assert.equal(r.payload_version, 2);
    assert.equal(r.recorded_at,events[2].time);
    assert.deepEqual(JSON.parse(r.frames_json).map(f=>f.event), events);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM device_data WHERE deveui=?').get(EUI).n,1);
  } finally { db.close(); }
});

test('PAYVER 2 count-one frame is archived with its original header', async () => {
  const db = fixture();
  try {
    const e = event(RAW,{count:1,index:0});
    const g = await gate(db,e);
    await archive(db,g.result[0]);
    assert.deepEqual(JSON.parse(records(db)[0].frames_json)[0].event,e);
  } finally { db.close(); }
});

test('decoded-only inputs preserve absent bytes, whitespace, trailing zeros and NULL', async () => {
  const db = fixture();
  try {
    for (const [i,text] of [' \r\n+000.120000+0.000000\r\n','NULL',''].entries()) {
      const e=event('',{data:false,fCnt:30+i}); e.object.data_sum=text;
      const g=await gate(db,e);
      const a=await archive(db,g.result[0]);
      assert.deepEqual(a.errors,[]);
      const r=records(db)[i];
      assert.equal(r.raw_ascii,text);
      assert.equal(Object.hasOwn(JSON.parse(r.frames_json)[0].event,'data'),false);
    }
  } finally { db.close(); }
});

test('complete malformed response is retained before normalization rejects it', async () => {
  const db = fixture();
  try {
    const g=await gate(db,event('not-a-number'));
    await archive(db,g.result[0]);
    assert.equal(records(db)[0].raw_ascii,'not-a-number');
    assert.ok(db.prepare('SELECT COUNT(*) n FROM ingest_quarantine').get().n>0);
    assert.equal(db.prepare('SELECT vwc_1 FROM device_data WHERE deveui=?').get(EUI).vwc_1,null);
  } finally { db.close(); }
});

test('archive survives a subsequent normalizer failure and device deletion', async () => {
  const db = fixture();
  try {
    const g=await gate(db,event(RAW));
    const w=await archive(db,g.result[0],{osiLibModules:{'sdi12-normalize':{normalize(){throw Error('test failure');}}}});
    assert.match(w.errors.join(' '),/NORMALIZE_RUN_FAILED/);
    assert.equal(records(db).length,1);
    db.prepare('DELETE FROM device_data WHERE deveui=?').run(EUI);
    db.prepare('DELETE FROM devices WHERE deveui=?').run(EUI);
    assert.equal(records(db).length,1);
  } finally { db.close(); }
});

test('incomplete and reset sequences never become complete archive rows; other ports are excluded', async () => {
  const db = fixture();
  try {
    const g=await gate(db,event('+0.7',{count:3,index:0,fCnt:50}));
    assert.equal(g.result,null);
    const reset=await gate(db,event('+0.8',{count:3,index:0,fCnt:51}),g.flowState);
    assert.ok(reset.result[0].sdi12.quarantineOnly);
    await archive(db,reset.result[0]);
    assert.equal(records(db).length,0);
    for (const fPort of [3,5,100]) {
      const e=event(RAW,{fCnt:60+fPort}); e.fPort=fPort;
      const dropped=await gate(db,e);
      assert.ok(!dropped.result || !dropped.result[0]);
    }
  } finally { db.close(); }
});

test('repeated identical values at different times remain separate transmissions', async () => {
  const db = fixture();
  try {
    for (let i=0;i<2;i++) {
      const g=await gate(db,event(RAW,{fCnt:80+i,time:`2026-10-28T10:${i===0?'00':'20'}:00Z`}));
      await archive(db,g.result[0]);
    }
    assert.equal(records(db).length,2);
  } finally { db.close(); }
});

test('archive SQL failure is visible and preserves existing canonical telemetry', async () => {
  const db = fixture();
  try {
    db.exec('DROP TABLE sdi12_transmissions');
    const g=await gate(db,event(RAW));
    const a=await archive(db,g.result[0]);
    assert.match(a.errors.join(' '),/SDI12 archive failed/);
    assert.ok(a.result);
    assert.equal(db.prepare('SELECT vwc_2 FROM device_data WHERE deveui=?').get(EUI).vwc_2,28.28);
  } finally { db.close(); }
});

test('decoded payload without data_sum warns through the real gate and creates no archive row',async()=>{
  const db=fixture();
  try {
    const withBytes=event(RAW,{fCnt:71});withBytes.object={};
    const g=await gate(db,withBytes);
    const warned=await archive(db,g.result[0]);
    assert.equal(records(db).length,0);
    assert.ok(warned.statuses.some(x=>x.fill==='yellow'&&x.text==='SDI12 decoded payload missing data_sum'));
    assert.ok(warned.warnings.includes('SDI12 decoded payload missing data_sum'));

    const withoutBytes=event(RAW,{fCnt:72,data:false});withoutBytes.object={};
    const g2=await gate(db,withoutBytes);
    const skipped=await archive(db,g2.result[0]);
    assert.equal(records(db).length,0);
    assert.ok(skipped.statuses.some(x=>x.fill==='grey'&&x.text==='SDI12 no transmission'));

    const unsupported=event(RAW,{fCnt:73});unsupported.object={unsupported_payload:'unknown-frame'};
    const quarantined=await gate(db,unsupported);
    assert.ok(quarantined.result[0].sdi12.quarantineOnly);
    await archive(db,quarantined.result[0]);
    const wrongPort=event(RAW,{fCnt:74});wrongPort.fPort=5;
    assert.equal((await gate(db,wrongPort)).result,null);
    assert.equal(records(db).length,0);
  } finally {db.close();}
});

test('ordered migration upgrades the previous schema without changing stored canonical data', () => {
  const db=fixture();
  try {
    db.exec('DROP TABLE sdi12_transmissions');
    db.prepare('INSERT INTO device_data(deveui, recorded_at, vwc_1) VALUES(?,?,?)').run(EUI,'2026-10-28T09:00:00Z',23.81);
    const migration=fs.readFileSync(path.join(ROOT,'database/migrations/ordered/0080__sdi12_transmissions.sql'),'utf8');
    db.exec(migration); db.exec(migration);
    assert.equal(db.prepare('SELECT vwc_1 FROM device_data WHERE deveui=?').get(EUI).vwc_1,23.81);
    assert.equal(records(db).length,0);
  } finally { db.close(); }
});

test('successful archive remains when each downstream stage fails', async t => {
  const cases = [
    ['normalizer load', {libOverrides:{osiLib:{require(name){ if(name==='sdi12-normalize') return {ok:false,error:'injected load failure'};return {ok:true,value:require(path.join(NR,'osi-'+name))};}}}}],
    ['manifest read', {globals:{fs:{readFileSync(){throw Error('injected manifest read failure');}}}}],
    ['normalization', {osiLibModules:{'sdi12-normalize':{normalize(){throw Error('injected normalize failure');}}}}],
    ['canonical write', {osiLibModules:{'device-writer':{writeDeviceData(){throw Error('injected writer failure');}}}}],
  ];
  for (const [name,overrides] of cases) await t.test(name,async()=>{
    const db=fixture();
    try {
      const g=await gate(db,event(RAW));
      const w=await archive(db,g.result[0],overrides);
      assert.ok(w.errors.length>0);
      assert.equal(records(db)[0].raw_ascii,RAW);
    } finally {db.close();}
  });
});

test('legacy depth map and configured flag survive later device edits and deletion',async()=>{
  const db=fixture();
  try {
    db.prepare('UPDATE devices SET sdi12_channel_layout_json=NULL WHERE deveui=?').run(EUI);
    const g=await gate(db,event('+12.340000'));
    await archive(db,g.result[0]);
    db.prepare('UPDATE devices SET soil_moisture_probe_depths_json=? WHERE deveui=?').run('{"vwc_1":99}',EUI);
    db.prepare('DELETE FROM devices WHERE deveui=?').run(EUI);
    const c=JSON.parse(records(db)[0].context_json);
    assert.equal(c.channelLayout,null);
    assert.equal(c.depths,config.soil_moisture_probe_depths_json);
    assert.equal(c.depthsConfigured,1);
  } finally {db.close();}
});

test('source timestamps remain unchanged while canonical implausible timestamps are clamped',async()=>{
  const db=fixture();
  try {
    const sources=[undefined,'bad-time','2000-01-01T00:00:00Z','2999-01-01T00:00:00Z'];
    for (const [i,time] of sources.entries()) {
      const e=event(RAW,{fCnt:90+i}); if(time===undefined) delete e.time; else e.time=time;
      const g=await gate(db,e); await archive(db,g.result[0]);
      assert.equal(records(db)[i].recorded_at,time??null);
      const c=db.prepare('SELECT recorded_at FROM device_data WHERE deveui=? ORDER BY id DESC LIMIT 1').get(EUI);
      assert.ok(Math.abs(Date.parse(c.recorded_at)-Date.now())<5000);
    }
  } finally {db.close();}
});

test('missing highest-index network time retains every frame and completing-event fallback',async()=>{
  const db=fixture();
  try {
    const events=[event('+1',{index:0,count:3,fCnt:100}),event('+2',{index:1,count:3,fCnt:101}),event('+3',{index:2,count:3,fCnt:102})];
    delete events[2].time;
    let state={},complete;
    for(const i of [2,0,1]){const g=await gate(db,events[i],state);state=g.flowState;if(g.result)complete=g.result[0];}
    await archive(db,complete);
    assert.equal(records(db)[0].recorded_at,events[1].time);
    assert.equal(Object.hasOwn(JSON.parse(records(db)[0].frames_json)[2].event,'time'),false);
  } finally {db.close();}
});

test('archive bounds use UTF-8 bytes and reject oversized input without rounding',async()=>{
  const {record}=require(path.join(NR,'osi-sdi12-archive'));
  const db=fixture();
  try {
    const info={deveui:EUI,fPort:2,decoded:{data_sum:'x'.repeat(1500)},frames:[]};
    await record(facadeDb(db),info,{},Date.now());
    await assert.rejects(record(facadeDb(db),{...info,decoded:{data_sum:'x'.repeat(1501)}},{},Date.now()),/1500/);
    const emptyBytes=Buffer.byteLength(JSON.stringify([{text:''}]));
    const exact={...info,frames:[{text:'x'.repeat(256*1024-emptyBytes)}]};
    await record(facadeDb(db),exact,{},Date.now());
    await assert.rejects(record(facadeDb(db),{...exact,frames:[{text:exact.frames[0].text+'x'}]},{},Date.now()),/256 KiB/);
    await assert.rejects(record(facadeDb(db),{...info,frames:[{text:'é'.repeat(140000)}]},{},Date.now()),/256 KiB/);
    await assert.rejects(record(facadeDb(db),info,{sdi12_deployment_compatible_recipe_json:'x'.repeat(256*1024)},Date.now()),/256 KiB/);
    assert.equal(records(db).length,2);
  } finally {db.close();}
});

test('a failing classification warning callback cannot prevent the archive commit',async()=>{
  const {record}=require(path.join(NR,'osi-sdi12-archive'));
  const db=fixture();
  try {
    const info={deveui:EUI,fPort:2,decoded:{data_sum:RAW},frames:[]};
    const saved=await record(facadeDb(db),info,config,Date.now(),()=>({ok:false,error:'loader failed'}),()=>{throw Error('warning channel unavailable');});
    assert.equal(saved,true);
    assert.equal(records(db).length,1);
    assert.equal(JSON.parse(records(db)[0].context_json).normalization,null);
  } finally {db.close();}
});

// Exercise the production connection/transaction lifecycle using a callback
// sqlite3 adapter backed by real, independent node:sqlite file connections.
// SQLITE_BUSY retries emulate sqlite3's asynchronous busy wait without blocking
// the test event loop that releases the competing transaction.
test('independent archive commits survive shared rollback, initialization failures and concurrent writes',async t=>{
  const Module=require('node:module');
  const os=require('node:os');
  const {DatabaseSync}=require('node:sqlite');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'sdi12-archive-durability-'));
  const filename=path.join(scratch,'farming.db');
  const native=new DatabaseSync(filename);
  native.exec('PRAGMA journal_mode=WAL; CREATE TABLE config_marker(value TEXT);');
  native.exec(fs.readFileSync(path.join(ROOT,'database/migrations/ordered/0080__sdi12_transmissions.sql'),'utf8'));
  const connections=[];
  const statementLog=[];
  let openFailure=null,pragmaFailure=null,commitFailure=null,closeFailure=null;
  function attempt(operation,callback){
    const started=Date.now();
    function run(){
      try { const value=operation();callback(null,value); }
      catch(e){if(/locked|busy/i.test(e.message)&&Date.now()-started<2000)setTimeout(run,5);else callback(e);}
    }
    queueMicrotask(run);
  }
  class CallbackDatabase {
    constructor(file,mode,callback){
      if(typeof mode==='function'){callback=mode;mode=undefined;}
      if(openFailure){const e=openFailure;openFailure=null;queueMicrotask(()=>callback(e));return;}
      this.native=new DatabaseSync(file==='/data/db/farming.db'?filename:file);
      this.closed=false;connections.push(this);queueMicrotask(()=>callback(null));
    }
    all(sql,params,callback){
      if(typeof params==='function'){callback=params;params=[];}
      statementLog.push({connection:this,method:'all',sql});
      attempt(()=>{
        if(pragmaFailure){const e=pragmaFailure;pragmaFailure=null;throw e;}
        if(/PRAGMA busy_timeout/i.test(sql))sql='PRAGMA busy_timeout=0';
        return this.native.prepare(sql).all(...(params||[]));
      },callback);
    }
    run(sql,params,callback){
      if(typeof params==='function'){callback=params;params=[];}
      statementLog.push({connection:this,method:'run',sql});
      attempt(()=>this.native.prepare(sql).run(...(params||[])),(e,result)=>callback.call(result||this,e));
    }
    exec(sql,callback){statementLog.push({connection:this,method:'exec',sql});attempt(()=>{
      if(/^COMMIT/i.test(sql)&&commitFailure){const e=commitFailure;commitFailure=null;throw e;}
      return this.native.exec(sql);
    },callback);}
    close(callback){
      this.native.close();this.closed=true;
      const e=closeFailure;closeFailure=null;queueMicrotask(()=>callback(e));
    }
  }
  const helperPath=path.join(NR,'osi-db-helper/index.js');
  const original=Module._load;
  let api;
  try {
    Module._load=function(name,parent,isMain){
      if(name==='sqlite3'&&parent?.filename===helperPath)return {Database:CallbackDatabase};
      return original.call(this,name,parent,isMain);
    };
    delete require.cache[helperPath];api=require(helperPath);
  } finally {Module._load=original;}
  const archiveModule=require(path.join(NR,'osi-sdi12-archive'));
  const info={deveui:EUI,fPort:2,decoded:{Payver:1,data_sum:'+12.340000'},frames:[]};
  try {
    await t.test('shared rollback cannot erase an acknowledged archive',async()=>{
      const connectionStart=connections.length;
      const shared=new api.Database(filename);
      await shared.exec('BEGIN IMMEDIATE; INSERT INTO config_marker VALUES (\'pending\');');
      const sharedHandle=connections[connectionStart];
      let acknowledged=false;
      const saved=archiveModule.store(api,info,config,Date.now()).then(v=>{acknowledged=true;return v;});
      await new Promise(resolve=>setTimeout(resolve,30));
      assert.equal(acknowledged,false,'archive must await its own write lock and commit');
      await shared.exec('ROLLBACK;');
      assert.equal(await saved,true);
      const isolatedHandle=connections[connectionStart+1];
      const isolatedSql=statementLog.filter(x=>x.connection===isolatedHandle).map(x=>x.sql);
      assert.deepEqual(isolatedSql.slice(0,8),[
        'PRAGMA journal_mode=WAL','PRAGMA synchronous=NORMAL','PRAGMA foreign_keys=ON',
        'PRAGMA busy_timeout=5000','PRAGMA wal_autocheckpoint=1000','PRAGMA busy_timeout=15000',
        'PRAGMA synchronous=FULL','BEGIN IMMEDIATE;'
      ]);
      assert.ok(statementLog.some(x=>x.connection===sharedHandle&&x.sql==='PRAGMA busy_timeout=5000'), 'shared Database facade retains 5000 ms timeout');
      assert.equal(native.prepare('SELECT count(*) n FROM config_marker').get().n,0);
      assert.equal(native.prepare('SELECT count(*) n FROM sdi12_transmissions').get().n,1);
    });
    await t.test('open and PRAGMA failures do not poison the next request or leak an opened handle',async()=>{
      openFailure=Error('injected open failure');
      await assert.rejects(archiveModule.store(api,info,config,Date.now()),/injected open failure/);
      pragmaFailure=Error('injected pragma failure');
      const before=connections.length;
      await assert.rejects(archiveModule.store(api,info,config,Date.now()),/injected pragma failure/);
      assert.ok(connections[before].closed);
      assert.equal(await archiveModule.store(api,info,config,Date.now()),true);
    });
    await t.test('concurrent requests use separate physically closed connections',async()=>{
      const before=connections.length;
      assert.deepEqual(await Promise.all([1,2,3].map(()=>archiveModule.store(api,info,config,Date.now()))),[true,true,true]);
      assert.equal(connections.length-before,3);
      assert.ok(connections.slice(before).every(c=>c.closed));
    });
    await t.test('executor and commit failures roll back and release the handle',async()=>{
      const count=native.prepare('SELECT count(*) n FROM sdi12_transmissions').get().n;
      const originalError=Error('injected executor failure');
      closeFailure=Error('injected cleanup failure');
      await assert.rejects(api.isolatedFarmingTransaction(async tx=>{
        await archiveModule.record(tx,info,config,Date.now());throw originalError;
      }),e=>e===originalError&&e.closeError?.message==='injected cleanup failure');
      assert.equal(native.prepare('SELECT count(*) n FROM sdi12_transmissions').get().n,count);
      commitFailure=Error('injected commit failure');
      await assert.rejects(archiveModule.store(api,info,config,Date.now()),/injected commit failure/);
      assert.equal(native.prepare('SELECT count(*) n FROM sdi12_transmissions').get().n,count);
      assert.equal(await archiveModule.store(api,info,config,Date.now()),true);
      const frozen=Object.freeze(Error('frozen executor failure'));
      closeFailure=Error('cleanup after frozen error');
      await assert.rejects(api.isolatedFarmingTransaction(()=>{throw frozen;}),e=>e===frozen);
    });
  } finally {
    native.close();
    for(const c of connections)if(!c.closed){c.native.close();c.closed=true;}
    delete require.cache[helperPath];fs.rmSync(scratch,{recursive:true,force:true});
  }
});

test('skipped records report no transmission and archive errors retain red status',async()=>{
  const db=fixture();
  try {
    const skipped=await archive(db,{sdi12:{deveui:EUI,fPort:5,decoded:{data_sum:'+1'}}});
    assert.ok(skipped.statuses.some(x=>x.text==='SDI12 no transmission'));
    assert.equal(records(db).length,0);
    const g=await gate(db,event(RAW));
    db.exec('DROP TABLE sdi12_transmissions');
    const failed=await archive(db,g.result[0]);
    assert.match(failed.errors.join(' '),/SDI12 archive failed/);
    assert.ok(failed.statuses.some(x=>x.fill==='red'&&x.text==='SDI12 ARCHIVE_FAILED'));
  } finally {db.close();}
});

test('archive status reporting tolerates malformed frame containers after commit',()=>{
  const {report}=require(path.join(NR,'osi-sdi12-archive'));
  for(const frames of [undefined,null,{},[null,{}, {event:null}],['bad-frame']]){
    const statuses=[];const warnings=[];
    assert.doesNotThrow(()=>report({status:value=>statuses.push(value),warn:value=>warnings.push(value)},{fPort:2,decoded:{},frames},false));
    assert.equal(statuses.at(-1).fill,'grey');
    assert.deepEqual(warnings,[]);
  }
  assert.doesNotThrow(()=>report({status(){throw Error('status unavailable');},warn(){throw Error('warning unavailable');}},{fPort:2,decoded:{},frames:[{event:{data:'base64'}}]},false));
});

test('native sqlite3 isolated archive transaction waits through a 6.5 second writer lock',async t=>{
  let sqlite3;
  try {sqlite3=require('sqlite3');} catch(error) {t.skip('native sqlite3 package unavailable: '+String(error.message||error));return;}
  const Module=require('node:module');
  const os=require('node:os');
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'sdi12-native-lock-'));
  const filename=path.join(scratch,'farming.db');
  const open=()=>new Promise((resolve,reject)=>{const db=new sqlite3.Database(filename,error=>error?reject(error):resolve(db));});
  const run=(db,sql,params=[])=>new Promise((resolve,reject)=>db.run(sql,params,error=>error?reject(error):resolve()));
  const get=(db,sql,params=[])=>new Promise((resolve,reject)=>db.get(sql,params,(error,row)=>error?reject(error):resolve(row)));
  const close=db=>new Promise((resolve,reject)=>db.close(error=>error?reject(error):resolve()));
  const helperPath=path.join(NR,'osi-db-helper/index.js');
  const helperSource=fs.readFileSync(helperPath,'utf8').replace("const DB_PATH = '/data/db/farming.db';",`const DB_PATH = ${JSON.stringify(filename)};`);
  assert.notEqual(helperSource,fs.readFileSync(helperPath,'utf8'),'test must substitute DB_PATH only in memory');
  const helper=new Module(helperPath,module);helper.filename=helperPath;helper.paths=Module._nodeModulePaths(path.dirname(helperPath));helper._compile(helperSource,helperPath);
  const api=helper.exports;
  let holder;let releaseTimer;let releasePromise;let operation;
  try {
    holder=await open();
    await run(holder,'PRAGMA journal_mode=WAL');
    await run(holder,'CREATE TABLE lock_probe(value INTEGER)');
    await run(holder,'BEGIN IMMEDIATE');
    releasePromise=new Promise((resolve,reject)=>{
      releaseTimer=setTimeout(()=>run(holder,'COMMIT').then(resolve,reject),6500);
    });
    const started=Date.now();
    operation=api.isolatedFarmingTransaction(tx=>tx.run('INSERT INTO lock_probe(value) VALUES(1)'));
    await operation;
    await releasePromise;
    const elapsed=Date.now()-started;
    assert.ok(elapsed>=6000,`lock wait should exceed shared 5 s timeout, got ${elapsed} ms`);
    assert.ok(elapsed<15000,`lock wait should remain within isolated 15 s timeout, got ${elapsed} ms`);
    assert.equal((await get(holder,'SELECT COUNT(*) AS count FROM lock_probe')).count,1);
  } finally {
    if(releaseTimer){await releasePromise?.catch(()=>{});}
    if(operation)await operation.catch(()=>{});
    if(holder)await close(holder);
    fs.rmSync(scratch,{recursive:true,force:true});
  }
});

// Free-disk floor: the archive has no retention rule yet, so it stops inserting
// below ARCHIVE_MIN_FREE_BYTES and never lets the probe itself stop a write.
const MIB = 1024 * 1024;
const freeBytes = bytes => () => ({bavail: bytes / 4096, bsize: 4096});
const lowDiskInfo = {deveui:EUI,fPort:2,decoded:{Payver:1,data_sum:RAW},frames:[]};

test('free space at or above the floor writes the archive row', async () => {
  const archiveModule = require(path.join(NR, 'osi-sdi12-archive'));
  assert.equal(archiveModule.ARCHIVE_MIN_FREE_BYTES, 1073741824);
  archiveModule.resetDiskWarnings();
  const db = fixture();
  try {
    const warnings = [];
    for (const bytes of [archiveModule.ARCHIVE_MIN_FREE_BYTES, 8 * 1024 * MIB]) {
      const saved = await archiveModule.record(facadeDb(db), lowDiskInfo, config, 1000, null, m => warnings.push(m), {statfs: freeBytes(bytes)});
      assert.equal(saved, true);
    }
    assert.equal(records(db).length, 2);
    assert.deepEqual(warnings, []);
  } finally { db.close(); }
});

test('below the floor no row is written, the result says low_disk and the reading write still succeeds', async () => {
  const archiveModule = require(path.join(NR, 'osi-sdi12-archive'));
  archiveModule.resetDiskWarnings();
  const db = fixture();
  try {
    const warnings = [];
    const saved = await archiveModule.record(facadeDb(db), lowDiskInfo, config, 1000, null, m => warnings.push(m),
      {statfs: freeBytes(archiveModule.ARCHIVE_MIN_FREE_BYTES - 4096)});
    assert.deepEqual(saved, {archived: false, reason: 'low_disk'});
    assert.equal(records(db).length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SDI12 archive skipped: free disk/);
    const statuses = [];
    archiveModule.report({status: v => statuses.push(v)}, lowDiskInfo, saved);
    assert.equal(statuses.at(-1).text, 'SDI12 archive skipped: low disk');

    // Through the real write node: the canonical reading is written, nothing fails.
    archiveModule.resetDiskWarnings();
    fs.statfsSync = freeBytes(100 * MIB);
    try {
      const g = await gate(db, event(RAW));
      const a = await archive(db, g.result[0]);
      assert.deepEqual(a.errors, []);
      assert.equal(records(db).length, 0);
      assert.ok(a.warnings.some(w => /SDI12 archive skipped: free disk/.test(w)));
      const canonical = db.prepare('SELECT vwc_2 FROM device_data WHERE deveui=?').get(EUI);
      assert.equal(canonical.vwc_2, 28.28);
    } finally { fs.statfsSync = AMPLE_DISK; }
  } finally { db.close(); }
});

test('a failing or unusable statfs still writes the archive row and warns', async () => {
  const archiveModule = require(path.join(NR, 'osi-sdi12-archive'));
  const db = fixture();
  try {
    const cases = [
      ['throws', () => { throw Error('statfs unavailable'); }, /disk probe failed: statfs unavailable/],
      ['no fields', () => ({}), /disk probe failed/],
      ['negative', () => ({bavail: -1, bsize: 4096}), /disk probe failed/],
      ['fs.statfsSync missing', 'missing', /disk probe failed/]
    ];
    for (const [name, statfs, expected] of cases) {
      archiveModule.resetDiskWarnings();
      const warnings = [];
      const before = records(db).length;
      let saved;
      if (statfs === 'missing') fs.statfsSync = undefined; // Node without fs.statfsSync
      try {
        saved = await archiveModule.record(facadeDb(db), lowDiskInfo, config, 1000, null, m => warnings.push(m),
          statfs === 'missing' ? undefined : {statfs});
      } finally { fs.statfsSync = AMPLE_DISK; }
      assert.equal(saved, true, name);
      assert.equal(records(db).length, before + 1, name);
      assert.equal(warnings.length, 1, name);
      assert.match(warnings[0], expected, name);
    }
    // A throwing warn callback must not stop the archive either.
    archiveModule.resetDiskWarnings();
    assert.equal(await archiveModule.record(facadeDb(db), lowDiskInfo, config, 1000, null, () => { throw Error('warn down'); },
      {statfs: () => { throw Error('x'); }}), true);

    // Through the real write node with a failing probe: row and canonical reading are both written.
    archiveModule.resetDiskWarnings();
    fs.statfsSync = () => { throw Error('statfs unavailable'); };
    try {
      const g = await gate(db, event(RAW, {fCnt: 500}));
      const before = records(db).length;
      const a = await archive(db, g.result[0]);
      assert.deepEqual(a.errors, []);
      assert.equal(records(db).length, before + 1);
      assert.ok(db.prepare('SELECT 1 FROM device_data WHERE deveui=?').get(EUI));
    } finally { fs.statfsSync = AMPLE_DISK; }
  } finally { db.close(); }
});

test('repeated low-disk calls within an hour warn once, and again after the hour', async () => {
  const archiveModule = require(path.join(NR, 'osi-sdi12-archive'));
  archiveModule.resetDiskWarnings();
  const db = fixture();
  try {
    const warnings = [];
    const low = {statfs: freeBytes(10 * MIB)};
    const T = Date.parse('2026-11-10T10:00:00Z');
    for (const at of [T, T + 60 * 1000, T + 59 * 60 * 1000]) {
      assert.deepEqual(await archiveModule.record(facadeDb(db), lowDiskInfo, config, at, null, m => warnings.push(m), low),
        {archived: false, reason: 'low_disk'});
    }
    assert.equal(warnings.length, 1);
    await archiveModule.record(facadeDb(db), lowDiskInfo, config, T + 61 * 60 * 1000, null, m => warnings.push(m), low);
    assert.equal(warnings.length, 2);
    // Probe failures use their own hourly window.
    const failing = {statfs: () => { throw Error('statfs unavailable'); }};
    await archiveModule.record(facadeDb(db), lowDiskInfo, config, T + 62 * 60 * 1000, null, m => warnings.push(m), failing);
    await archiveModule.record(facadeDb(db), lowDiskInfo, config, T + 63 * 60 * 1000, null, m => warnings.push(m), failing);
    assert.equal(warnings.length, 3);
    assert.equal(records(db).length, 2);
  } finally { db.close(); }
});
