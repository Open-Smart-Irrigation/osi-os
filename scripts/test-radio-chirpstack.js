'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {fromChirpStack}=require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/chirpstack');
const event={deviceInfo:{devEui:'a84041cafecafe01'},deduplicationId:'abc',time:'2026-09-10T10:00:00Z',data:'AAAAAAAAAAAAAA==',fPort:1,txInfo:{frequency:868100000,modulation:{lora:{spreadingFactor:12,bandwidth:125000}}},rxInfo:[{gatewayId:'0016c001f11715e2',rssi:-91,snr:4}]};
const testerFrame={deviceInfo:{devEui:'ac1f09fffe000001',deviceProfileId:'9b7c33dd-9d24-47a3-b13e-8b050e0ee6de',deviceProfileName:'OSI RAK Field Tester',applicationId:'app-field-tester'},time:'2026-09-22T15:36:28.199Z',fPort:1,fCnt:4,data:'INlJhJz1BdwMCA==',rxInfo:[{gatewayId:'0016C001F1000002',rssi:-93,snr:7.75}],txInfo:{frequency:868100000,modulation:{lora:{spreadingFactor:12,bandwidth:125000,codeRate:'CR_4_5'}}}};
test('extracts common rxInfo without decoding arbitrary sensor payload as GPS',()=>{const row=fromChirpStack(event);assert.equal(row.deveui,'A84041CAFECAFE01');assert.equal(row.metadata.reported_position,null);assert.equal(row.metadata.receivers[0].rssi_dbm,-91);assert.equal(row.metadata.radio.bandwidth_hz,125000);assert.equal(JSON.stringify(row).includes(event.data),false);});
test('known tester uses existing GPS codec only at supported port',()=>{
 // event's own filler data ('AAAAAAAAAAAAAA==') is an all-zero ten-byte frame,
 // which the Finding 3 quality gate now (correctly) treats as no fix -- so this
 // port/profile-matching test needs a fixture with hdop<=2 and sats>=5 to still
 // exercise the decode-succeeds branch instead of the gate itself.
 const row=fromChirpStack({...event,data:testerFrame.data,deviceInfo:{...event.deviceInfo,deviceProfileName:'Field Tester'}},{testerProfileName:'Field Tester'});
 assert.ok(row.metadata.reported_position);
 assert.equal(fromChirpStack({...event,fPort:2},{testerProfileName:'other'}).metadata.reported_position,null);
});
test('gateway snapshot cannot attach a future/current fix to delayed uplink',()=>{const gateway={latitude:46,longitude:6,last_good_fix_at:'2026-09-10T12:00:00Z',status:'fixed',sync_version:2};assert.equal(fromChirpStack(event,{gatewayPositions:{'0016C001F11715E2':gateway}}).metadata.receivers[0].position,null);});
test('field tester gate matches the real provisioned profile id and name, not the literal Field Tester',()=>{const byId=fromChirpStack(testerFrame,{testerProfileIds:['9b7c33dd-9d24-47a3-b13e-8b050e0ee6de']});assert.equal(byId.metadata.reported_position.latitude,46.4999993);const byName=fromChirpStack(testerFrame,{testerProfileNamePattern:'field tester'});assert.ok(byName.metadata.reported_position);const other=fromChirpStack({...testerFrame,deviceInfo:{...testerFrame.deviceInfo,deviceProfileId:'other',deviceProfileName:'OSI KIWI Sensor'}},{testerProfileIds:['9b7c33dd-9d24-47a3-b13e-8b050e0ee6de']});assert.equal(other.metadata.reported_position,null);});
// Consultant Finding 3: a genuine all-zero ten-byte frame (cold GPS, hdop=0
// satellites=0) must decode to no position, not the ~5.3e-6/1.07e-5 point off
// the African coast the un-gated arithmetic would otherwise produce. RAK's own
// reference server gates on has_gps=(hdop<=2)&&(sats>=5); a prior fake test
// case (`reportedPosition: null` in scripts/test-radio-flow.js) never actually
// exercised this real decoder path, only the encoder given a null position.
test('a genuine all-zero ten-byte GPS frame decodes to no position, with RSSI/receivers intact',()=>{const zeroFrame={...testerFrame,data:Buffer.alloc(10).toString('base64')};const row=fromChirpStack(zeroFrame,{testerProfileIds:['9b7c33dd-9d24-47a3-b13e-8b050e0ee6de']});assert.equal(row.metadata.reported_position,null);assert.equal(row.metadata.receivers.length,1);assert.equal(row.metadata.receivers[0].rssi_dbm,-93);});
