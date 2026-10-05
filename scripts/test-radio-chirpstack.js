'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {fromChirpStack}=require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper/chirpstack');
const event={deviceInfo:{devEui:'a84041cafecafe01'},deduplicationId:'abc',time:'2026-09-10T10:00:00Z',data:'AAAAAAAAAAAAAA==',fPort:1,txInfo:{frequency:868100000,modulation:{lora:{spreadingFactor:12,bandwidth:125000}}},rxInfo:[{gatewayId:'0016c001f11715e2',rssi:-91,snr:4}]};
const testerFrame={deviceInfo:{devEui:'a840410000000001',deviceProfileId:'9b7c33dd-9d24-47a3-b13e-8b050e0ee6de',deviceProfileName:'OSI RAK Field Tester',applicationId:'app-field-tester'},time:'2026-09-22T15:36:28.199Z',fPort:1,fCnt:4,data:'INlJhJz1BdwMCA==',rxInfo:[{gatewayId:'0016C001F1000002',rssi:-93,snr:7.75}],txInfo:{frequency:868100000,modulation:{lora:{spreadingFactor:12,bandwidth:125000,codeRate:'CR_4_5'}}}};
test('extracts common rxInfo without decoding arbitrary sensor payload as GPS',()=>{const row=fromChirpStack(event);assert.equal(row.deveui,'A84041CAFECAFE01');assert.equal(row.metadata.reported_position,null);assert.equal(row.metadata.receivers[0].rssi_dbm,-91);assert.equal(row.metadata.radio.bandwidth_hz,125000);assert.equal(JSON.stringify(row).includes(event.data),false);});
test('known tester uses existing GPS codec only at supported port',()=>{
 // GPS decoding is decided by the caller (isFieldTester, from the device type),
 // not by port or profile. The event's own filler data ('AAAAAAAAAAAAAA==') is an
 // all-zero frame the quality gate treats as no fix, so use a fixture with
 // hdop<=2 and sats>=5 to exercise the decode-succeeds branch.
 const row=fromChirpStack({...event,data:testerFrame.data},{isFieldTester:true});
 assert.ok(row.metadata.reported_position);
 assert.equal(fromChirpStack({...event,fPort:2},{isFieldTester:false}).metadata.reported_position,null);
});
test('gateway snapshot cannot attach a future/current fix to delayed uplink',()=>{const gateway={latitude:46,longitude:6,last_good_fix_at:'2026-09-10T12:00:00Z',status:'fixed',sync_version:2};assert.equal(fromChirpStack(event,{gatewayPositions:{'0016C001F11715E2':gateway}}).metadata.receivers[0].position,null);});
// Consultant Finding 3: a genuine all-zero ten-byte frame (cold GPS, hdop=0
// satellites=0) must decode to no position, not the ~5.3e-6/1.07e-5 point off
// the African coast the un-gated arithmetic would otherwise produce. RAK's own
// reference server gates on has_gps=(hdop<=2)&&(sats>=5); a prior fake test
// case (`reportedPosition: null` in scripts/test-radio-flow.js) never actually
// exercised this real decoder path, only the encoder given a null position.
test('a genuine all-zero ten-byte GPS frame decodes to no position, with RSSI/receivers intact',()=>{const zeroFrame={...testerFrame,data:Buffer.alloc(10).toString('base64')};const row=fromChirpStack(zeroFrame,{isFieldTester:true});assert.equal(row.metadata.reported_position,null);assert.equal(row.metadata.receivers.length,1);assert.equal(row.metadata.receivers[0].rssi_dbm,-93);});

const envelope=({fPort,data,deviceProfileId='p',deviceProfileName=''})=>({deviceInfo:{devEui:'a840410000000001',deviceProfileId,deviceProfileName},fPort,data,time:'2026-10-05T10:00:00Z',rxInfo:[{gatewayId:'0016c001f1000001',rssi:-90,snr:5}],txInfo:{frequency:868100000,modulation:{lora:{spreadingFactor:9,bandwidth:125000}}}});
const VALID_FIX_B64=Buffer.from([0x00,0x5A,0x00,0x00,0x00,0x40,0x03,0xE8,0x0A,0x08]).toString('base64');
test('GPS is decoded only when the caller says the device is a field tester',()=>{
  const event=envelope({fPort:1,data:VALID_FIX_B64,deviceProfileId:'shared-profile',deviceProfileName:'OSI RAK Field Tester'});
  assert.equal(fromChirpStack(event,{isFieldTester:false}).metadata.reported_position,null);
  assert.notEqual(fromChirpStack(event,{isFieldTester:true}).metadata.reported_position,null);
});
test('a sensor on the shared tester profile is not decoded as GPS',()=>{
  const event=envelope({fPort:1,data:VALID_FIX_B64,deviceProfileId:'shared-profile'});
  assert.equal(fromChirpStack(event,{isFieldTester:false,testerProfileIds:['shared-profile']}).metadata.reported_position,null);
});
test('a frame with a good quality byte but zero coordinate bits is no position',()=>{
  const data=Buffer.from([0,0,0,0,0,0,0x03,0xE8,0x0A,0x08]).toString('base64'); // HDOP 1.0, 8 sats, lat/lon bits 0
  const event=envelope({fPort:1,data});
  assert.equal(fromChirpStack(event,{isFieldTester:true}).metadata.reported_position,null);
});
