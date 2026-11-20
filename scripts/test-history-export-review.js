'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { facadeDb, makeAuthHeader } = require('./lib/scoped-access-harness');
const seed = fs.readFileSync(path.resolve(__dirname, '../database/seed-blank.sql'), 'utf8');
const first = 'A840410000000001';
const second = 'A840410000000002';
const opts = { zoneId: 1, zoneIds: [1], from: '2026-04-01', to: '2026-04-01', channels: 'swt_1', nowMs: Date.parse('2026-11-02') };
function database() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(seed);
  raw.exec(`INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(1,'export-review','h','x','x');
    INSERT INTO irrigation_zones(id,user_id,name,zone_uuid,timezone,created_at,updated_at) VALUES
      (1,1,'Zone','zone-one','UTC','x','x'),(2,1,'Second','zone-two','UTC','x','x');
    INSERT INTO devices(deveui,user_id,irrigation_zone_id,name,type_id,chameleon_enabled,created_at,updated_at) VALUES
      ('${first}',1,1,'Sensor','DRAGINO_LSN50',1,'x','x'),('${second}',1,2,'Second sensor','DRAGINO_LSN50',1,'x','x');`);
  return raw;
}
function samples(raw, eui, count, value = 10) {
  const insert = raw.prepare('INSERT INTO device_data(deveui,recorded_at,swt_1,swt_2) VALUES(?,?,?,?)');
  raw.exec('BEGIN');
  for (let i = 0; i < count; i++) insert.run(eui, new Date(Date.parse('2026-04-01') + i * 60000).toISOString(), value, value);
  raw.exec('COMMIT');
}
function recording(raw) {
  const queries = [];
  const db = facadeDb(raw);
  return { queries, db: { ...db, all(sql, params, cb) {
    if (/FROM device_data/.test(sql)) {
      const rows = raw.prepare(sql).all(...params);
      const plan = raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(r => r.detail).join('\n');
      queries.push({ sql, params, count: rows.length, plan });
    }
    return db.all(sql, params, cb);
  } } };
}
function boundedQueries(queries, ceiling) {
  assert.ok(queries.length);
  for (const query of queries) {
    assert.match(query.sql, /WHERE deveui = \?.*ORDER BY recorded_at ASC, id ASC LIMIT \d+$/s);
    const limit = Number(/LIMIT (\d+)$/.exec(query.sql)[1]);
    assert.ok(limit <= ceiling + 1);
    assert.ok(query.count <= limit);
    assert.match(query.plan, /USING INDEX idx_device_data_deveui_recorded_at/);
    assert.doesNotMatch(query.plan, /USE TEMP B-TREE/);
  }
}
for (const profile of ['bcm2712', 'bcm2709']) {
  const root = path.resolve(__dirname, `../conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/node-red`);
  const helper = require(path.join(root, 'osi-history-helper'));
  const router = require(path.join(root, 'osi-history-router'));
  for (const granularity of ['raw', 'daily']) {
    for (const value of [10, null]) {
      test(`${profile}: ${granularity} SQL input sentinel bounds dense ${value === null ? 'null' : 'valued'} history`, async () => {
        const raw = database();
        try {
          samples(raw, first, 1000, value);
          const { db, queries } = recording(raw);
          await assert.rejects(helper.buildZoneExportCsv(db, { ...opts, granularity, maxInputRows: 7 }), { statusCode: 413, code: 'EXPORT_INPUT_TOO_LARGE' });
          boundedQueries(queries, 7);
          assert.equal(queries[0].count, 8, 'only the sentinel is materialized');
        } finally { raw.close(); }
      });
    }
    test(`${profile}: ${granularity} input work is cumulative across zones and sources`, async () => {
      const raw = database();
      try {
        samples(raw, first, 4, null); samples(raw, second, 4, null);
        const { db, queries } = recording(raw);
        await assert.rejects(helper.buildAllZonesExportCsv(db, { ...opts, zoneIds: [1,2], granularity, maxInputRows: 6 }), { statusCode: 413, code: 'EXPORT_INPUT_TOO_LARGE' });
        boundedQueries(queries, 6);
        assert.equal(queries.length, 2);
        assert.equal(queries[1].count, 3);
        assert.match(queries[1].sql, /LIMIT 3$/);
      } finally { raw.close(); }
    });
  }
  test(`${profile}: input cell width limits the SQL sentinel independently of row count`, async () => {
    const raw = database();
    try {
      samples(raw, first, 1000, null);
      for (const granularity of ['raw', 'daily']) {
        const { db, queries } = recording(raw);
        await assert.rejects(helper.buildZoneExportCsv(db, { ...opts, granularity, channels: 'swt_1,swt_2', maxInputCells: 10 }), { code: 'EXPORT_INPUT_TOO_LARGE' });
        boundedQueries(queries, 5);
        const selected = queries[0].sql.slice(queries[0].sql.indexOf('recorded_at, ') + 13).split(' FROM ')[0].split(', ').length;
        assert.equal(queries[0].count, Math.floor(10 / selected) + 1);
      }
    } finally { raw.close(); }
  });
  test(`${profile}: all-zone aggregate preflight rejects before the first measurement query`, async () => {
    const raw = database();
    try {
      samples(raw, first, 1000);
      const { db, queries } = recording(raw);
      await assert.rejects(helper.buildAllZonesExportCsv(db, { ...opts, zoneIds: [1,2], granularity: 'daily', maxRows: 3 }), { code: 'EXPORT_TOO_LARGE' });
      assert.deepEqual(queries, []);
    } finally { raw.close(); }
  });
  test(`${profile}: hourly cell preflight sums month windows across half-hour DST shifts`, async () => {
    const raw = database();
    try {
      raw.exec("UPDATE irrigation_zones SET timezone='Australia/Lord_Howe'; UPDATE devices SET irrigation_zone_id=1");
      const range = { ...opts, from: '2026-04-01', to: '2026-10-31', granularity: 'hourly' };
      const { db, queries } = recording(raw);
      await assert.rejects(helper.buildZoneExportCsv(db, { ...range, maxRows: 20547 }), { code: 'EXPORT_TOO_LARGE' });
      assert.deepEqual(queries, []);
      const accepted = await helper.buildZoneExportCsv(db, { ...range, maxRows: 20548 });
      assert.deepEqual(accepted.rows, []);
    } finally { raw.close(); }
  });
  test(`${profile}: skipped civil dates are empty intervals and spanning ranges never borrow an earlier day`, async () => {
    const raw = database();
    try {
      raw.exec("UPDATE irrigation_zones SET timezone='Pacific/Apia';");
      raw.exec(`INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES('${first}','2011-12-29T12:00:00Z',29),('${first}','2011-12-30T12:00:00Z',31)`);
      for (const build of [helper.buildZoneExportCsv, helper.buildAllZonesExportCsv]) {
        for (const granularity of ['raw','hourly','daily']) {
          const { db, queries } = recording(raw);
          const empty = await build(db, { ...opts, from: '2011-12-30', to: '2011-12-30', granularity });
          if (empty.rows) assert.deepEqual(empty.rows, []);
          else assert.equal(empty.rowCount, 0);
          assert.deepEqual(queries, []);
        }
      }
      const span = await helper.buildZoneExportCsv(facadeDb(raw), { ...opts, from: '2011-12-29', to: '2011-12-31', granularity: 'daily' });
      assert.deepEqual(span.rows.filter(r => r.channel_key === 'swt_1').map(r => [r.timestamp,r.value]), [['2011-12-29T10:00:00.000Z',29],['2011-12-30T10:00:00.000Z',31]]);
    } finally { raw.close(); }
  });
  test(`${profile}: byte budgets include BOM and escaped UTF-8 text and are cumulative across zones`, async () => {
    const raw = database();
    try {
      const label = '😀'.repeat(100) + '",\n';
      raw.prepare('UPDATE irrigation_zones SET name=?').run(label);
      raw.prepare('UPDATE devices SET name=?').run(label);
      samples(raw, first, 1); samples(raw, second, 1);
      const one = await router.buildZoneExportCsv(facadeDb(raw), { ...opts, granularity: 'raw' });
      const bytes = Buffer.byteLength(one.csv);
      assert.ok(bytes > 1600);
      await helper.buildZoneExportCsv(facadeDb(raw), { ...opts, granularity: 'raw', maxBytes: bytes });
      await assert.rejects(helper.buildZoneExportCsv(facadeDb(raw), { ...opts, granularity: 'raw', maxBytes: bytes-1 }), { code: 'EXPORT_BYTES_TOO_LARGE' });
      assert.equal(Buffer.byteLength(helper.toCsv(one.columns, one.rows, { maxBytes: bytes })), bytes);
      assert.throws(() => helper.toCsv(one.columns, one.rows, { maxBytes: bytes-1 }), { code: 'EXPORT_BYTES_TOO_LARGE' });
      await assert.rejects(helper.buildAllZonesExportCsv(facadeDb(raw), { ...opts, zoneIds: [1,2], granularity: 'raw', maxBytes: bytes }), { code: 'EXPORT_BYTES_TOO_LARGE' });
    } finally { raw.close(); }
  });
  test(`${profile}: accepted maximum-width CSV approaches the byte ceiling under a gateway-sized heap`, async () => {
    const raw = database();
    try {
      const label = '😀'.repeat(100);
      raw.prepare('UPDATE irrigation_zones SET name=?').run(label);
      raw.prepare('UPDATE devices SET name=?').run(label);
      samples(raw,first,1);
      const range = { ...opts,to:'2026-04-08',granularity:'raw' };
      const probe = await router.buildZoneExportCsv(facadeDb(raw),range);
      const header = helper.toCsv(probe.columns,[]);
      const pairBytes = Buffer.byteLength(probe.csv)-Buffer.byteLength(header);
      const ceiling = 8*1024*1024;
      const count = Math.floor((ceiling-Buffer.byteLength(header))/pairBytes);
      raw.exec('DELETE FROM device_data');
      samples(raw,first,count);
      const accepted = await helper.buildAllZonesExportCsv(facadeDb(raw),range);
      assert.equal(accepted.rowCount,count*2);
      assert.ok(Buffer.byteLength(accepted.csv)<=ceiling);
      assert.ok(Buffer.byteLength(accepted.csv)>ceiling-pairBytes);
      console.log(JSON.stringify({profile,acceptedRows:accepted.rowCount,csvBytes:Buffer.byteLength(accepted.csv),csvCeiling:ceiling,maxRssKiB:process.resourceUsage().maxRSS}));
      raw.prepare('INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES(?,?,10)').run(first,new Date(Date.parse('2026-04-01')+count*60000).toISOString());
      await assert.rejects(helper.buildAllZonesExportCsv(facadeDb(raw),range),{code:'EXPORT_BYTES_TOO_LARGE',statusCode:413});
    } finally { raw.close(); }
  });
  test(`${profile}: stable refusal codes survive response formatting and the all-zones adapter`, async () => {
    assert.equal(typeof router.historyExportErrorResponse, 'function');
    const raw = database();
    try {
      const request = { db: facadeDb(raw), method: 'GET', path: '/api/history/export.csv', authSecret: 'csv-review-secret', authorization: makeAuthHeader({userId:1,username:'export-review',secret:'csv-review-secret'}), query: { ...opts, from: '1900-01-01', scope:'allZones', granularity:'daily' }, nowMs: opts.nowMs };
      const refused = await router.handlePortableHistoryRequest(request);
      assert.equal(refused.statusCode, 413); assert.equal(refused.payload.code, 'RANGE_TOO_LARGE');
      assert.equal(refused.headers['Content-Disposition'], undefined);
      assert.equal(refused.headers['Content-Type'], 'application/json');
      await router.withHistoryExportSlot(async () => {
        const busy = await router.handlePortableHistoryRequest({...request,query:{...opts,scope:'allZones',granularity:'daily'}});
        assert.equal(busy.statusCode,429);assert.equal(busy.payload.code,'EXPORT_BUSY');assert.equal(busy.headers['Retry-After'],'30');
        await assert.rejects(router.buildZoneExportCsv(facadeDb(raw),opts), error => {
          const response = router.historyExportErrorResponse(error);
          assert.equal(response.payload.code,'EXPORT_BUSY');assert.equal(response.headers['Retry-After'],'30');
          return true;
        });
      });
    } finally { raw.close(); }
  });
  test(`${profile}: real HTTP JSON refusals preserve codes and Retry-After without CSV attachments`, async () => {
    const raw = database();
    let mode = 'rows';
    const server = http.createServer(async (req,res) => {
      let response;
      const options = { ...opts, granularity:'raw', ...(mode === 'rows' ? {maxRows:1} : mode === 'bytes' ? {maxBytes:100} : {maxInputRows:1}) };
      try {
        if (req.url === '/zone/export.csv') {
          const built = await router.buildZoneExportCsv(facadeDb(raw),options);
          response = {statusCode:200,headers:{'Content-Type':'text/csv','Content-Disposition':'attachment'},payload:built.csv};
        } else {
          response = await router.handlePortableHistoryRequest({db:facadeDb(raw),method:'GET',path:'/api/history/export.csv',authSecret:'wire-secret',authorization:makeAuthHeader({userId:1,username:'export-review',secret:'wire-secret'}),nowMs:opts.nowMs,query:{...opts,scope:'allZones',granularity:'raw'},history:{...helper,buildAllZonesExportCsv:(db,query)=>helper.buildAllZonesExportCsv(db,{...query,...options})}});
        }
      } catch(error) { response = router.historyExportErrorResponse(error); }
      res.writeHead(response.statusCode,response.headers);
      res.end(typeof response.payload === 'string' ? response.payload : JSON.stringify(response.payload));
    });
    function request(route) {
      return new Promise((resolve,reject) => {
        http.get({host:'127.0.0.1',port:server.address().port,path:route},res=>{
          const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));res.on('error',reject);
        }).on('error',reject);
      });
    }
    try {
      samples(raw,first,2);
      server.listen(0,'127.0.0.1');await once(server,'listening');
      for (const route of ['/zone/export.csv','/all/export.csv']) {
        for (const [kind,code] of [['rows','EXPORT_TOO_LARGE'],['input','EXPORT_INPUT_TOO_LARGE'],['bytes','EXPORT_BYTES_TOO_LARGE']]) {
          mode=kind;
          const refused = await request(route);
          assert.equal(refused.status,413);assert.equal(refused.body.code,code);
          assert.equal(refused.headers['content-type'],'application/json');assert.equal(refused.headers['content-disposition'],undefined);
        }
        await router.withHistoryExportSlot(async()=>{
          const busy=await request(route);
          assert.equal(busy.status,429);assert.equal(busy.body.code,'EXPORT_BUSY');assert.equal(busy.headers['retry-after'],'30');assert.equal(busy.headers['content-disposition'],undefined);
        });
      }
    } finally { await new Promise(resolve=>server.close(resolve));raw.close(); }
  });
  test(`${profile}: daily rewrites preserve complete BOM-less multiline records and use the local date`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-records-'));
    try {
      const zone = { zone_uuid:'rewrite',name:'Zone',timezone:'Europe/Zurich' };
      const old = { timestamp:'2026-03-27T23:00:00.000Z',series_label:'first\nsecond "old"',value:-2 };
      const current = { timestamp:'2026-03-28T23:00:00.000Z',series_label:'first\nsecond "new"',value:10 };
      fs.mkdirSync(path.join(dir,'rewrite'),{recursive:true});
      const daily = path.join(dir,'rewrite/daily.csv');
      fs.writeFileSync(daily,helper.toCsv(helper.AGG_CSV_COLUMNS,[old,current]).replace(/^\uFEFF/,''));
      for (let i=0;i<2;i++) await helper.writeZoneCsv({exportDir:dir,zone,day:'2026-03-29',dailyRows:[current]});
      const csv = fs.readFileSync(daily);
      const parsed = JSON.parse(execFileSync('python3',['-c',"import csv,io,json,sys; print(json.dumps(list(csv.DictReader(io.StringIO(sys.stdin.buffer.read().decode('utf-8-sig'))))))"],{input:csv,encoding:'utf8'}));
      assert.deepEqual(parsed.map(r=>[r.timestamp,r.series_label,r.value]),[[old.timestamp,old.series_label,'-2'],[current.timestamp,current.series_label,'10']]);
      assert.equal(csv.toString('utf8').indexOf('\uFEFF',1),-1);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
}
