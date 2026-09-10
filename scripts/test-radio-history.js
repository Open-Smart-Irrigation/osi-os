'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper');
const row = {id: 1, installation_uuid: 'ddc5e1d9-cac9-48a2-bba1-b8fe236f7a42', deveui: 'A84041CAFECAFE01', recorded_at: '2026-09-10T10:00:00.000Z', deduplication_id: 'native-1', metadata_json: {version:1, receivers:[]}};
test('radio table uses parent key, segment and independent raw source queries', () => {
 assert.ok(helper.tableNames({includeRadio:true}).includes('radio_uplinks'));
 assert.equal(helper.historyKey('radio_uplinks', '0016c001f11715e2', row),'RADIO_UPLINK|0016C001F11715E2|1');
 assert.equal(helper.naturalKey('radio_uplinks', row),row.installation_uuid+'|native-1');
 assert.equal(helper.segmentKey('radio_uplinks', row),row.deveui+'|2026-09-10');
 assert.deepEqual(helper.rowByHistoryKeyQuery('radio_uplinks','RADIO_UPLINK|0016C001F11715E2|1').params,['1']);
 assert.match(helper.segmentQuery('radio_uplinks',row.deveui+'|2026-09-10').sql,/radio_uplinks/);
 assert.equal(helper.buildCanonicalColumns('radio_uplinks',row).length,6);
});
test('radio correction reuses key but changes payload hash; JSON object key order does not', () => {
 const initial=helper.prepareRow('radio_uplinks','0016C001F11715E2',row);
 const reordered=helper.prepareRow('radio_uplinks','0016C001F11715E2',{...row,metadata_json:{receivers:[],version:1}});
 assert.equal(initial.payloadHash,reordered.payloadHash);
 const correction=helper.prepareRow('radio_uplinks','0016C001F11715E2',{...row,metadata_json:{version:1,receivers:[{gateway_id:'0016C001F11715E2',uplink_id_num:null}]}});
 assert.equal(initial.historyKey,correction.historyKey);
 assert.notEqual(initial.payloadHash,correction.payloadHash);
});

test('radio disabled by default preserves the original source database registry',()=>{ assert.equal(helper.tableNames().includes('radio_uplinks'),false); assert.equal(helper.tableNames().length,8); });

test('radio golden vector matches canonical columns and history hash',()=>{
 const fixture=require('../docs/contracts/radio-observations/fixtures/uplink-v1.json');
 assert.deepEqual(helper.prepareRow(fixture.tableName,fixture.gatewayDeviceEui,fixture.row),fixture.expected);
 assert.deepEqual(helper.buildCanonicalColumns(fixture.tableName,fixture.row),fixture.canonicalColumns);
});
