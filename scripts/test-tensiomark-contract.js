'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {contractValidationErrors}=require('./test-contract-schemas');
const schema=require('../docs/contracts/sync-schema/resources.schema.json');
const layout={version:1,kind:'tensiomark',source_unit:'pF',field_order:'temperature_pf',qualification:'bench_observed',sensors:[{address:'1',channel:1,identity:'111TENSIOMARK_2Vh_10A00001',depth_cm:null,calibration_range:'unverified'},{address:'4',channel:2,identity:'411TENSIOMARK_2Vh_10A00002',depth_cm:30,calibration_range:'unverified'}]};
function errors(value){return contractValidationErrors(schema.definitions.Device,{deveui:'A840410000000101',type_id:'DRAGINO_SDI12',sdi12_channel_layout_json:value},schema);}
test('sync device accepts exact Tensiomark layout while retaining Sentek and null',()=>{
 assert.deepEqual(errors(layout),[]);
 assert.deepEqual(errors(null),[]);
 assert.deepEqual(errors({version:1,address:'0',sensors:[{channel:1,response_position:1,depth_cm:20,type:'ENVIROSCAN'}]}),[]);
});
test('sync layout refuses unqualified or mixed interpretation',()=>{
 for(const invalid of [{...layout,source_unit:'kPa'},{...layout,extra:true},{...layout,qualification:null},{...layout,sensors:[]},{...layout,sensors:[{...layout.sensors[0],depth_cm:0}]}])assert.ok(errors(invalid).length);
});
