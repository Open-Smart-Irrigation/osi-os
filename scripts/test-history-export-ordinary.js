'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb } = require('./lib/scoped-access-harness');
const seed = fs.readFileSync(path.resolve(__dirname, '../database/seed-blank.sql'), 'utf8');
const DAY = 86400000;
const eui = n => 'A84041000000' + String(n).padStart(4,'0');
function fixture(count=1,type='DRAGINO_LSN50',chameleon=0) {
  const db = new DatabaseSync(':memory:');db.exec(seed);
  db.exec("INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'ordinary-export','h','x','x'); INSERT INTO irrigation_zones(id,user_id,name,zone_uuid,timezone,created_at,updated_at) VALUES(1,1,'First','z-first','UTC','x','x'),(2,1,'Second','z-second','UTC','x','x');");
  const insert=db.prepare("INSERT INTO devices(deveui,user_id,irrigation_zone_id,name,type_id,chameleon_enabled,created_at,updated_at) VALUES(?,1,?,'Sensor',?,?,'x','x')");
  for(let n=1;n<=count;n++) insert.run(eui(n),n%2+1,type,chameleon);
  return db;
}
function populate(db,count,days,minutes,chameleon=false,from='2025-01-01') {
  const start=Date.parse(from);
  const stmt=db.prepare('INSERT INTO device_data(deveui,recorded_at,swt_1,swt_2,swt_3) VALUES(?,?,?,?,?)');
  db.exec('BEGIN');
  for(let n=1;n<=count;n++)for(let t=start;t<start+days*DAY;t+=minutes*60000) stmt.run(eui(n),new Date(t).toISOString(),20,30,chameleon?40:null);
  db.exec('COMMIT');
}
function traced(db) {
  const queries=[];const facade=facadeDb(db);
  return {queries,db:{...facade,all(sql,params,cb){
    if(/FROM device_data/.test(sql)) {
      const rows=db.prepare(sql).all(...params);
      const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...params).map(r=>r.detail).join('\n');
      queries.push({sql,params,rows,plan});
    }
    return facade.all(sql,params,cb);
  }}};
}
const range=(days,from='2025-01-01')=>({from,to:new Date(Date.parse(from)+(days-1)*DAY).toISOString().slice(0,10),granularity:'daily',nowMs:Date.parse('2026-11-01')});
for(const profile of ['bcm2712','bcm2709']) {
  const helper=require(path.resolve(__dirname,`../conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red/osi-history-helper`));
  const scenarios=[
    {name:'Analysis default: four sensors over 14 days',count:4,days:14,minutes:15,all:true,from:'2025-06-01'},
    {name:'four sensors over 92 days, all channels',count:4,days:92,minutes:15,all:true,from:'2025-06-01'},
    {name:'three-sensor season per zone, all channels',count:3,days:183,minutes:15,from:'2025-04-01'},
    {name:'one year for one sensor, all channels',count:1,days:365,minutes:15},
    {name:'four months for a five-minute Chameleon',count:1,days:123,minutes:5,chameleon:true,from:'2025-05-01'},
  ];
  for(const scenario of scenarios) test(`${profile}: ordinarily accepted ${scenario.name}`,async()=>{
    const db=fixture(scenario.count,'DRAGINO_LSN50',scenario.chameleon?1:0);
    try {
      populate(db,scenario.count,scenario.days,scenario.minutes,scenario.chameleon,scenario.from);
      if(!scenario.all) db.exec('UPDATE devices SET irrigation_zone_id=1');
      const start=performance.now();
      const result=scenario.all?await helper.buildAllZonesExportCsv(facadeDb(db),{...range(scenario.days,scenario.from),zoneIds:[1,2]}):await helper.buildZoneExportCsv(facadeDb(db),{...range(scenario.days,scenario.from),zoneId:1});
      const expected=scenario.count*scenario.days*(scenario.chameleon?6:4);
      assert.equal(result.rowCount??result.rows.length,expected);
      console.log(JSON.stringify({profile,scenario:scenario.name,samples:scenario.count*scenario.days*1440/scenario.minutes,ms:Math.round(performance.now()-start)}));
    }finally{db.close();}
  });
  test(`${profile}: LSN50 day matches measured main rows; blanks are only for an empty day`,async()=>{
    const db=fixture(1,'DRAGINO_LSN50',1);
    try {
      populate(db,1,1,15);
      const result=await helper.buildZoneExportCsv(facadeDb(db),{...range(2),zoneId:2});
      const measured=result.rows.filter(r=>r.timestamp.startsWith('2025-01-01'));
      assert.deepEqual(measured.map(r=>r.channel_key).sort(),['swt_1','swt_1_pf','swt_2','swt_2_pf']);
      assert.ok(measured.every(r=>r.value!==null));
      const missing=result.rows.filter(r=>r.timestamp.startsWith('2025-01-02'));
      assert.deepEqual(missing.map(r=>r.channel_key),['swt_1','swt_2','swt_3']);
      assert.ok(missing.every(r=>r.value===null));
    }finally{db.close();}
  });
  test(`${profile}: device projection excludes impossible fields and falls back without a named index`,async()=>{
    for(const type of ['DRAGINO_LSN50','KIWI_SENSOR','SENSECAP_S2120','TEKTELIC_CLOVER','DRAGINO_SDI12']) {
      const db=fixture(1,type);
      try {
        populate(db,1,1,15);
        const normal=traced(db);
        const result=await helper.buildZoneExportCsv(normal.db,{...range(1),zoneId:2});
        const permitted=type==='DRAGINO_SDI12'?26:type==='DRAGINO_LSN50'||type==='KIWI_SENSOR'?2:0;
        for(const query of normal.queries) {
          assert.doesNotMatch(query.sql,/INDEXED BY/);
          assert.match(query.plan,/USING INDEX idx_device_data_deveui_recorded_at/);
          assert.doesNotMatch(query.plan,/USE TEMP B-TREE/);
          if(type==='DRAGINO_LSN50'||type==='KIWI_SENSOR') assert.doesNotMatch(query.sql,/vwc_|soil_(?:vic|temp|ec)_|swt_3/);
          if(type==='SENSECAP_S2120'||type==='TEKTELIC_CLOVER') assert.doesNotMatch(query.sql,/swt_|vwc_|soil_/);
        }
        assert.ok(result.rows.every(r=>!/^soil$/.test(r.card_type)||permitted>0));
        db.exec('DROP INDEX idx_device_data_deveui_recorded_at');
        const fallback=await helper.buildZoneExportCsv(facadeDb(db),{...range(1),zoneId:2});
        assert.deepEqual(fallback.rows,result.rows);
      }finally{db.close();}
    }
  });
  test(`${profile}: adjacent windows fetch and charge each margin row only once`,async()=>{
    const db=fixture();
    try {
      populate(db,1,65,15);
      const trace=traced(db);
      await helper.buildZoneExportCsv(trace.db,{...range(65),zoneId:2,channels:'swt_1',maxWorkRows:65*96});
      const ids=trace.queries.flatMap(q=>q.rows.map(r=>r.id));
      assert.equal(ids.length,65*96);
      assert.equal(new Set(ids).size,ids.length);
      assert.ok(trace.queries.length>=3);
    }finally{db.close();}
  });
  test(`${profile}: request work has its own larger bound and stable refusal`,async()=>{
    const db=fixture();
    try {
      populate(db,1,65,15);
      await assert.rejects(helper.buildZoneExportCsv(facadeDb(db),{...range(65),zoneId:2,channels:'swt_1',maxWorkRows:65*96-1}),{statusCode:413,code:'EXPORT_INPUT_TOO_LARGE'});
    }finally{db.close();}
  });
  test(`${profile}: nightly raw and hourly files survive a malformed daily file`,async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightly-independent-'));
    try {
      const zone={zone_uuid:'nightly',timezone:'UTC'};
      const daily=path.join(dir,'nightly/daily.csv');fs.mkdirSync(path.dirname(daily),{recursive:true});
      const invalid='timestamp,series_label\n2024-12-31T00:00:00Z,"unterminated\n';
      fs.writeFileSync(daily,invalid);
      const row={timestamp:'2025-01-01T00:00:00.000Z',value:1};
      await assert.rejects(helper.writeZoneCsv({exportDir:dir,zone,day:'2025-01-01',rawRows:[row],hourlyRows:[row],dailyRows:[row]}),/unterminated quoted field/);
      assert.equal(fs.readFileSync(daily,'utf8'),invalid);
      for(const kind of ['raw','hourly']) assert.ok(fs.readFileSync(path.join(dir,`nightly/${kind}/2025-01-01.csv`),'utf8').startsWith('\uFEFFtimestamp,'));
      assert.deepEqual(fs.readdirSync(path.dirname(daily)).sort(),['daily.csv','hourly','raw']);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
  test(`${profile}: nightly writers ignore request limits and rewrite daily history beyond 8 MiB and 200k rows`,async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightly-unlimited-'));
    try {
      const zone={zone_uuid:'nightly',timezone:'UTC',name:'Nightly'};
      const daily=path.join(dir,'nightly/daily.csv');fs.mkdirSync(path.dirname(daily),{recursive:true});
      const header=helper.toCsv(helper.AGG_CSV_COLUMNS,[]);
      const old=helper.toCsv(helper.AGG_CSV_COLUMNS,[{timestamp:'2024-12-31T00:00:00.000Z',series_label:'first\nsecond "kept"',value:-2}]).slice(header.length);
      const fd=fs.openSync(daily,'w');fs.writeSync(fd,header.replace(/^\uFEFF/,''));
      const block=old.repeat(1000);for(let n=0;n<201;n++)fs.writeSync(fd,block);fs.closeSync(fd);
      assert.ok(fs.statSync(daily).size>8*1024*1024);
      const row={timestamp:'2025-01-01T00:00:00.000Z',series_label:'new',value:1};
      await helper.writeZoneCsv({exportDir:dir,zone,day:'2025-01-01',rawRows:[row],hourlyRows:[row],dailyRows:[row]});
      const count=execFileSync('python3',['-c',"import csv,sys; n=0\nwith open(sys.argv[1],encoding='utf-8-sig',newline='') as f:\n for row in csv.DictReader(f):\n  assert None not in row; n+=1\nprint(n)",daily],{encoding:'utf8'}).trim();
      assert.equal(Number(count),201001);
      assert.ok(fs.readFileSync(path.join(dir,'nightly/raw/2025-01-01.csv'),'utf8').startsWith('\uFEFFtimestamp,'));
      assert.ok(fs.readFileSync(path.join(dir,'nightly/hourly/2025-01-01.csv'),'utf8').startsWith('\uFEFFtimestamp,'));
      const wide={...row,series_label:'é'.repeat(2048)};
      const many=Array(2100).fill(wide);
      await helper.writeZoneCsv({exportDir:dir,zone,day:'2025-01-01',rawRows:many,hourlyRows:many,dailyRows:[row],maxRows:1,maxBytes:1});
      assert.ok(fs.statSync(path.join(dir,'nightly/raw/2025-01-01.csv')).size>8*1024*1024);
      assert.ok(fs.statSync(path.join(dir,'nightly/hourly/2025-01-01.csv')).size>8*1024*1024);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
}
