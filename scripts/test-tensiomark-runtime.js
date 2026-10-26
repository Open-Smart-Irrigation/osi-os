'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { seedTestDb, facadeDb, loadNode, executeFunction, makeAuthHeader } = require('./lib/flow-node-harness');
const modules = '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/';
const commissioning = require(modules + 'osi-sdi12-commissioning');
const normalizer = require(modules + 'osi-sdi12-normalize');
const writer = require(modules + 'osi-device-writer');
const manifest = require(modules + 'edge-channels.json');
const eui = 'A840410000000101';
const ENV = {OSI_SCOPED_ACCESS:'1',DEVICE_EUI:'0016C001F1000001',CHIRPSTACK_APP_SENSORS:'app-sensors-uuid',CHIRPSTACK_PROFILE_SDI12:'profile-sdi12-uuid'};
const layout = () => ({version:1,kind:'tensiomark',source_unit:'pF',field_order:'temperature_pf',qualification:'bench_observed',sensors:[
  {address:'1',channel:1,identity:'111TENSIOMARK_2Vh_10A00001',depth_cm:null,calibration_range:'unverified'},
  {address:'4',channel:2,identity:'411TENSIOMARK_2Vh_10A00002',depth_cm:30,calibration_range:'unverified'}
]});
function database() {
  const db=seedTestDb();
  db.prepare("INSERT INTO devices (deveui,name,type_id,user_id,chirpstack_app_id,created_at,updated_at) VALUES (?,'Tensiomark','DRAGINO_SDI12',1,'app-sensors-uuid','2026-10-15','2026-10-15')").run(eui);
  writer.resetColumnCache(); return db;
}
function count(db,table) { return db.prepare('SELECT count(*) AS n FROM '+table).get().n; }
function normalization(raw='1+16.11+0.000\r\n4+18.25+5.359\r\n') {
  return normalizer.normalize({BatV:3.606,data_sum:raw},{probeProfile:'TENSIOMARK',sdi12ChannelLayout:layout()},{recordedAt:'2026-10-15T13:54:04.426Z'});
}
const codec = {};
vm.createContext(codec);
vm.runInContext(fs.readFileSync(path.join(__dirname, modules, 'codecs/dragino_sdi12_decoder.js'), 'utf8'), codec);
const firstReply = '1+16.11+0.000\r\n';
const secondReply = '4+18.25+5.359\r\n';
function wrappedPayload(replies = [firstReply, secondReply]) {
  return Buffer.concat([Buffer.from([0x0e, 0x16, 1]), ...replies.map((raw, index) => {
    const body = Buffer.from(raw, 'latin1');
    return Buffer.concat([Buffer.from([0xf1 + index, body.length]), body]);
  })]);
}
async function wireGate(db, payload, options = {}) {
  const object = codec.Decode(2, [...payload]);
  if (options.decodedBattery !== undefined) object.BatV = options.decodedBattery;
  return executeFunction(loadNode('sdi12-gate-fn'), {db, env: ENV, flowState: options.flowState,
    msg: {payload: {deviceInfo: {devEui: eui, deviceProfileId: ENV.CHIRPSTACK_PROFILE_SDI12},
      fPort: 2, data: payload.toString('base64'), object, time: '2026-10-16T00:00:00Z'}}});
}
async function writeGated(db, gated) {
  gated.payload = [db.prepare('SELECT * FROM devices WHERE deveui=?').get(eui)];
  const response = await executeFunction(loadNode('sdi12-write-fn'), {db, env: ENV,
    globals: {fs: {readFileSync: () => JSON.stringify(manifest)}}, msg: gated});
  assert.deepEqual(response.errors, []);
  return response;
}
async function configuredDatabase() {
  const db = database();
  await commissioning.saveTensiomarkLayout(facadeDb(db), {deveui: eui, layout: layout()});
  return db;
}
function assertWireRejected(db, payload, expectedRaw) {
  const observation = db.prepare('SELECT * FROM tensiomark_observations ORDER BY id DESC LIMIT 1').get();
  assert.ok(observation, 'refusal must retain durable observation');
  assert.equal(observation.disposition, 'rejected_framing');
  assert.equal(observation.payload_base64, payload);
  if (expectedRaw !== undefined) {
    // node:sqlite's TEXT getter truncates at NUL. SQL hex verifies every stored
    // byte, including the suffix that this test harness cannot read as TEXT.
    const stored = db.prepare('SELECT hex(CAST(raw_response AS BLOB)) AS raw_hex FROM tensiomark_observations WHERE id=?').get(observation.id);
    assert.equal(stored.raw_hex, Buffer.from(expectedRaw, 'utf8').toString('hex').toUpperCase());
  }
  const row = db.prepare('SELECT * FROM device_data WHERE id=?').get(observation.device_data_id);
  for (const channel of ['swt_1', 'swt_2', 'soil_temp_1', 'soil_temp_2']) assert.equal(row[channel], null);
  assert.equal(count(db, 'ingest_quarantine'), 0);
}

test('complete wrapped wire reply is accepted and actual header owns battery', async () => {
  const db = await configuredDatabase();
  try {
    const gated = await wireGate(db, wrappedPayload(), {decodedBattery: 4.2});
    await writeGated(db, gated.result[0]);
    const row = db.prepare('SELECT * FROM device_data').get();
    assert.equal(row.bat_v, 3.606);
    assert.equal(row.swt_1, 0.1);
    assert.equal(row.swt_2, Math.pow(10, 5.359 - 1));
    assert.equal(row.soil_temp_1, 16.11);
    assert.equal(row.soil_temp_2, 18.25);
    assert.equal(db.prepare('SELECT raw_response FROM tensiomark_observations').get().raw_response, firstReply + secondReply);
  } finally { db.close(); }
});

for (const byte of ['\t', '\0', '\b', '\xb1', '\xf1']) {
  test('wire control/high-bit byte ' + byte.charCodeAt(0) + ' is retained and rejects soil readings', async () => {
    const db = await configuredDatabase();
    try {
      const raw = firstReply.replace('16.11', '16.' + byte + '11');
      const payload = wrappedPayload([raw, secondReply]);
      const gated = await wireGate(db, payload);
      await writeGated(db, gated.result[0]);
      assertWireRejected(db, payload.toString('base64'), raw + secondReply);
    } finally { db.close(); }
  });
}

for (const kind of ['short length', 'long length', 'duplicate slot', 'dangling marker', 'trailing byte']) {
  test('malformed envelope ' + kind + ' cannot become valid text', async () => {
    const db = await configuredDatabase();
    try {
      let payload = wrappedPayload();
      if (kind === 'short length') payload[4]--;
      if (kind === 'long length') payload[4] = 255;
      if (kind === 'duplicate slot') payload[5 + Buffer.byteLength(firstReply)] = 0xf1;
      if (kind === 'dangling marker') payload = Buffer.concat([payload, Buffer.from([0xf3])]);
      if (kind === 'trailing byte') payload = Buffer.concat([payload, Buffer.from([0])]);
      const gated = await wireGate(db, payload);
      await writeGated(db, gated.result[0]);
      assertWireRejected(db, payload.toString('base64'));
    } finally { db.close(); }
  });
}

for (const replies of [[firstReply.slice(0, 8), firstReply.slice(8), secondReply], [firstReply, '', secondReply], [firstReply + secondReply]]) {
  test('each command envelope must contain one complete addressed reply: ' + JSON.stringify(replies), async () => {
    const db = await configuredDatabase();
    try {
      const payload = wrappedPayload(replies);
      const gated = await wireGate(db, payload);
      await writeGated(db, gated.result[0]);
      assertWireRejected(db, payload.toString('base64'), replies.join(''));
    } finally { db.close(); }
  });
}

for (const encoded of [null, 'not-base64', 'AAEC\n']) test('invalid original bytes ' + JSON.stringify(encoded) + ' reject plausible decoded values', async () => {
  const db = await configuredDatabase();
  try {
    const gated = await wireGate(db, wrappedPayload());
    gated.result[0].sdi12.payloadBase64 = encoded;
    await writeGated(db, gated.result[0]);
    assertWireRejected(db, encoded);
  } finally { db.close(); }
});

test('bare whole-response bytes preserve the same address mapping', async () => {
  const db = await configuredDatabase();
  try {
    const payload = Buffer.concat([Buffer.from([0x0e, 0x16, 1]), Buffer.from(secondReply + firstReply)]);
    const gated = await wireGate(db, payload);
    await writeGated(db, gated.result[0]);
    const row = db.prepare('SELECT * FROM device_data').get();
    assert.equal(row.swt_1, 0.1);
    assert.equal(row.swt_2, Math.pow(10, 5.359 - 1));
    assert.equal(db.prepare('SELECT disposition FROM tensiomark_observations').get().disposition, 'accepted');
  } finally { db.close(); }
});

for (const payload of [Buffer.from([0x0e, 0x16, 3]), Buffer.from([0x0e, 0x16, 2, 2]), Buffer.from([0x0e, 0x16, 2, 2, 2])]) {
  test('transport refusal ' + payload.toString('hex') + ' bypasses capped quarantine for configured Tensiomark', async () => {
    const db = await configuredDatabase();
    try {
      const gated = await wireGate(db, payload);
      assert.ok(gated.result[0].sdi12.quarantineOnly);
      await writeGated(db, gated.result[0]);
      assertWireRejected(db, payload.toString('base64'));
    } finally { db.close(); }
  });
}

test('completed PAYVER 2 acquisition is refused because only final fragment bytes survive', async () => {
  const db = await configuredDatabase();
  try {
    const first = Buffer.concat([Buffer.from([0x0e, 0x16, 2, 2, 0]), Buffer.from(firstReply)]);
    const last = Buffer.concat([Buffer.from([0x0e, 0x16, 2, 2, 1]), Buffer.from(secondReply)]);
    const buffered = await wireGate(db, first);
    assert.equal(buffered.result, null);
    const complete = await wireGate(db, last, {flowState: buffered.flowState});
    assert.equal(complete.result[0].sdi12.decoded.data_sum, firstReply + secondReply);
    await writeGated(db, complete.result[0]);
    assertWireRejected(db, last.toString('base64'));
  } finally { db.close(); }
});
test('explicit Tensiomark config saves without a recipe or downlink and resave is idempotent',async()=>{
  const db=database();
  try {
    const response=await executeFunction(loadNode('sdi12-config-action-fn'),{db,env:ENV,msg:{req:{body:{probe_profile:'TENSIOMARK',tensiomark_layout:layout()}},deviceRow:{deveui:eui}}});
    assert.equal(response.result.statusCode || 200,200);
    assert.deepEqual(response.result.payload.layout,layout());
    const row=db.prepare('SELECT * FROM devices WHERE deveui=?').get(eui);
    assert.equal(row.sdi12_probe_profile,'TENSIOMARK');
    assert.deepEqual(JSON.parse(row.soil_moisture_probe_depths_json),{swt_2:30,soil_temp_2:30});
    assert.equal(count(db,'sdi12_recipe_deployments'),0);
    const saved=await commissioning.saveTensiomarkLayout(facadeDb(db),{deveui:eui,layout:layout()});
    assert.equal(saved.changed,false);
    assert.equal(db.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(eui).sync_version,row.sync_version);
  } finally { db.close(); }
});

test('raw observation is linked atomically to the exact canonical row',async()=>{
  const db=database();
  try {
    assert.equal(typeof commissioning.writeTensiomarkObservation,'function');
    const result=normalization();
    const written=await commissioning.writeTensiomarkObservation(facadeDb(db),manifest,result,{deveui:eui,payloadBase64:wrappedPayload().toString('base64')},{});
    const observed=db.prepare('SELECT * FROM tensiomark_observations').get();
    const row=db.prepare('SELECT * FROM device_data WHERE id=?').get(observed.device_data_id);
    assert.equal(observed.device_data_id,written.deviceDataId);
    assert.equal(row.recorded_at,observed.recorded_at);
    assert.equal(row.swt_1,0.1); assert.equal(row.soil_temp_1,16.11);
    assert.ok(row.swt_2>300); assert.equal(row.soil_temp_2,18.25); assert.equal(row.bat_v,3.606);
    assert.equal(observed.raw_response,'1+16.11+0.000\r\n4+18.25+5.359\r\n');
    assert.equal(observed.payload_base64,wrappedPayload().toString('base64'));
    assert.equal(observed.disposition,'accepted');
    assert.equal(count(db,'ingest_quarantine'),0);
  } finally { db.close(); }
});

test('live ingest writes evidence and passes original uplink bytes',async()=>{
  const db=database();
  try {
    await commissioning.saveTensiomarkLayout(facadeDb(db),{deveui:eui,layout:layout()});
    const row=db.prepare('SELECT * FROM devices WHERE deveui=?').get(eui);
    const payload=wrappedPayload();
    const response=await executeFunction(loadNode('sdi12-write-fn'),{db,env:ENV,globals:{fs:{readFileSync:()=>JSON.stringify(manifest)}},msg:{payload:[row],sdi12:{deveui:eui,fPort:2,recordedAt:'2026-10-15T13:54:04.426Z',payloadBase64:payload.toString('base64'),decoded:codec.Decode(2,[...payload])}}});
    assert.equal(response.errors.length,0);
    assert.equal(count(db,'tensiomark_observations'),1);
    assert.equal(db.prepare('SELECT payload_base64 FROM tensiomark_observations').get().payload_base64,payload.toString('base64'));
    assert.equal(db.prepare('SELECT disposition FROM tensiomark_observations').get().disposition,'accepted');
    assert.equal(response.result[1],null,'configured Tensiomark must never auto-identify');
  } finally { db.close(); }
});

test('registration sends no wildcard discovery before configuration can be saved',async()=>{
  const db=database();
  try {
    const result=await executeFunction(loadNode('sdi12-post-reg-hook-fn'),{db,env:ENV,msg:{deviceRegistration:{devEui:eui,deviceType:'DRAGINO_SDI12',applicationId:'app-sensors-uuid'}}});
    assert.equal(result.result,null);
  } finally { db.close(); }
});
test('configured multi-address layout refuses manual identify and stale trigger',async()=>{
  const db=database();
  try {
    await commissioning.saveTensiomarkLayout(facadeDb(db),{deveui:eui,layout:layout()});
    for (const nodeId of ['sdi12-identify-action-fn','sdi12-identify-trigger-fn']) {
      const result=await executeFunction(loadNode(nodeId),{db,env:ENV,msg:{req:{params:{deveui:eui},headers:{}},deviceRow:{deveui:eui,chirpstack_app_id:'app-sensors-uuid'},sdi12Identify:{stage:'discovering',command:'?!',discoveredAddress:null,preserveAttempt:false}}});
      assert.equal(result.result[0],null);
      assert.equal(result.result[1].statusCode,409);
      assert.equal(result.result[1].payload.code,'tensiomark_layout_configured');
    }
    assert.equal(count(db,'sdi12_identify_attempts'),0);
  } finally { db.close(); }
});
test('late identity response cannot alter a newly saved Tensiomark layout',async()=>{
  const db=database();
  try {
    await commissioning.saveTensiomarkLayout(facadeDb(db),{deveui:eui,layout:layout()});
    db.prepare("INSERT INTO sdi12_identify_attempts VALUES (?,'identifying','1','2026-10-15','2026-10-15')").run(eui);
    db.prepare("UPDATE devices SET sdi12_probe_status='pending_identify' WHERE deveui=?").run(eui);
    const before=db.prepare('SELECT * FROM devices WHERE deveui=?').get(eui);
    const response=await executeFunction(loadNode('sdi12-identify-fn'),{db,env:ENV,msg:{sdi12:{deveui:eui,decoded:{datas_sum:'111TENSIOMARK_2Vh_10A00001'},recordedAt:'2026-10-15T13:54:04.426Z'}}});
    assert.equal(response.result[1],null);
    assert.deepEqual(db.prepare('SELECT * FROM devices WHERE deveui=?').get(eui),before);
    assert.equal(count(db,'sdi12_identify_attempts'),0);
  } finally { db.close(); }
});

for (const [table,message] of [['tensiomark_observations','evidence failure'],['device_data','canonical failure']]) {
  test(message+' rolls back both canonical data and observation',async()=>{
    const db=database();
    try {
      db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON "+table+" BEGIN SELECT RAISE(ABORT,'test insert failure'); END;");
      await assert.rejects(commissioning.writeTensiomarkObservation(facadeDb(db),manifest,normalization(),{deveui:eui},{}),/test insert failure/);
      assert.equal(count(db,'device_data'),0); assert.equal(count(db,'tensiomark_observations'),0);
    } finally { db.close(); }
  });
}
test('rejected addressed batch retains battery and evidence outside quarantine',async()=>{
  const db=database();
  try {
    const raw='1+16.11+0.000\r\n';
    await commissioning.writeTensiomarkObservation(facadeDb(db),manifest,normalization(raw),{deveui:eui},{});
    const row=db.prepare('SELECT * FROM device_data').get();
    assert.equal(row.bat_v,3.606); assert.equal(row.swt_1,null); assert.equal(row.soil_temp_1,null);
    const observation=db.prepare('SELECT * FROM tensiomark_observations').get();
    assert.equal(observation.disposition,'rejected_addresses');
    assert.equal(observation.device_data_id,row.id); assert.equal(observation.raw_response,raw);
    assert.equal(count(db,'ingest_quarantine'),0);
    for(let i=0;i<1001;i++) writer.quarantineOnly(db,eui,'unknown','test');
    assert.equal(count(db,'ingest_quarantine'),1000);
    assert.equal(count(db,'tensiomark_observations'),1);
  } finally { db.close(); }
});
test('configuration refuses mixed fields and does not alter stored interpretation',async()=>{
  const db=database();
  try {
    for(const extra of [{depths:{1:20}},{value_count:2},{address:'1'},{sensors:[]},{unexpected:true}]) {
      const response=await executeFunction(loadNode('sdi12-config-action-fn'),{db,env:ENV,msg:{req:{body:{probe_profile:'TENSIOMARK',tensiomark_layout:layout(),...extra}},deviceRow:{deveui:eui}}});
      assert.equal(response.result.statusCode,400);
    }
    assert.equal(db.prepare('SELECT sdi12_channel_layout_json FROM devices WHERE deveui=?').get(eui).sdi12_channel_layout_json,null);
  } finally { db.close(); }
});
test('legacy config body cannot select Tensiomark without its layout',async()=>{
  const db=await configuredDatabase();
  try {
    const before=db.prepare('SELECT sdi12_probe_profile,sdi12_channel_layout_json,soil_moisture_probe_depths_json,sync_version FROM devices WHERE deveui=?').get(eui);
    assert.ok(before.sdi12_channel_layout_json);
    for(const body of [{probe_profile:'TENSIOMARK'},{probe_profile:'TENSIOMARK',depths:{1:20}},{probe_profile:'TENSIOMARK',value_count:2}]) {
      const response=await executeFunction(loadNode('sdi12-config-action-fn'),{db,env:ENV,msg:{req:{body},deviceRow:{deveui:eui}}});
      assert.equal(response.result.statusCode,400,JSON.stringify(body));
      assert.equal(response.result.payload.code,'tensiomark_layout_required');
    }
    assert.deepEqual(db.prepare('SELECT sdi12_probe_profile,sdi12_channel_layout_json,soil_moisture_probe_depths_json,sync_version FROM devices WHERE deveui=?').get(eui),before);
    const away=await executeFunction(loadNode('sdi12-config-action-fn'),{db,env:ENV,msg:{req:{body:{probe_profile:'GENERIC_VWC'}},deviceRow:{deveui:eui}}});
    assert.equal(away.result.statusCode || 200,200);
    assert.equal(db.prepare('SELECT sdi12_probe_profile FROM devices WHERE deveui=?').get(eui).sdi12_probe_profile,'GENERIC_VWC');
  } finally { db.close(); }
});
test('Tensiomark save failure exposes only a safe error code',async()=>{
  const db=database();
  const tensiomarkModule=require(modules+'osi-sdi12-commissioning/tensiomark.js');
  const original=tensiomarkModule.saveTensiomarkLayout;
  tensiomarkModule.saveTensiomarkLayout=async()=>{ const error=new Error('database is locked'); error.code='SQLITE_BUSY'; throw error; };
  try {
    const response=await executeFunction(loadNode('sdi12-config-action-fn'),{db,env:ENV,msg:{req:{body:{probe_profile:'TENSIOMARK',tensiomark_layout:layout()}},deviceRow:{deveui:eui}}});
    assert.equal(response.result.statusCode,500);
    assert.equal(response.result.payload.code,'layout_save_failed');
  } finally { tensiomarkModule.saveTensiomarkLayout=original; db.close(); }
});
test('in-flight Sentek recipe blocks changing interpretation',async()=>{
  const db=database();
  try {
    db.prepare("INSERT INTO sdi12_recipe_deployments (deveui,desired_version,desired_layout_hash,desired_recipe_json,status,updated_at) VALUES (?,1,'hash','{}','queued','2026-10-15')").run(eui);
    await assert.rejects(commissioning.saveTensiomarkLayout(facadeDb(db),{deveui:eui,layout:layout()}),e=>e.code==='deployment_in_progress');
    assert.equal(db.prepare('SELECT sdi12_channel_layout_json FROM devices WHERE deveui=?').get(eui).sdi12_channel_layout_json,null);
  } finally { db.close(); }
});
test('gate carries original base64 bytes through the PAYVER1 path',async()=>{
  const db=database();
  try {
    const payload=wrappedPayload();
    const response=await wireGate(db,payload);
    assert.equal(response.result[0].sdi12.payloadBase64,payload.toString('base64'));
  } finally { db.close(); }
});
