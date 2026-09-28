#!/usr/bin/env node
'use strict';
// Pins the shared LSN50 codec's FPort 11 branch (ChirpStack event view) to the
// edge parser in osi-watermark-helper: same raw fields for accepted frames,
// same reasons for rejected ones. FPort 2 (stock + Chameleon) is pinned by
// verify-lsn50-chameleon-codec.js and must stay untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NR = path.join(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(NR, 'codecs/dragino_lsn50_decoder.js'), 'utf8'), sandbox);
const { parseProfile3 } = require(path.join(NR, 'osi-watermark-helper/conversion.js'));

const GOLDEN = [...Buffer.from('A2030CE404E209290220080008000800080021FFFFFFFF08000800', 'hex')];
const w = (v) => [(v >> 8) & 255, v & 255];
const bench = (p1, p2, soil, status) => [0xA2, 3, ...w(3300), ...w(soil & 0xffff), ...w(2146), status,
  0x20, ...w(p1[0]), ...w(p1[0]), ...w(p1[1]), ...w(p1[1]),
  0x24, ...w(p2[0]), ...w(p2[0]), ...w(p2[1]), ...w(p2[1])];

const accepted = [GOLDEN, bench([276, 4095], [71, 4058], 1988, 2), bench([0, 3826], [4093, 2], -32768, 0x05)];
for (const bytes of accepted) {
  const out = sandbox.decodeUplink({ fPort: 11, bytes }).data;
  const p = parseProfile3(bytes).frame;
  assert.equal(out.Watermark_Profile, 3);
  assert.equal(out.Supply_mV, p.supply_mv);
  assert.equal(out.Soil_Temp_C, p.soil_temp_c === null ? 'NULL' : p.soil_temp_c);
  assert.equal(out.Soil_Temp_Source, p.soil_temp_source);
  assert.equal(out.DS18B20_Failed, p.ds18b20_failed ? 1 : 0);
  assert.equal(out.Die_Temp_C, p.die_temp_c === null ? 'NULL' : p.die_temp_c);
  assert.deepEqual({ ...out.Probe_1 }, p.probes[0]);
  assert.deepEqual({ ...out.Probe_2 }, p.probes[1]);
}

const rejected = [
  [GOLDEN.slice(0, 26), 'length'],
  [[0xA1, ...GOLDEN.slice(1)], 'tag'],
  [[0xA2, 2, ...GOLDEN.slice(2)], 'profile'],
  [GOLDEN.map((b, i) => (i === 8 ? b | 0x10 : b)), 'reserved_status_bits'],
  [GOLDEN.map((b, i) => (i === 8 ? 0x03 : b)), 'reserved_source'],
  [GOLDEN.map((b, i) => (i === 18 ? b | 0x80 : b)), 'reserved_flag_bits']
];
for (const [bytes, reason] of rejected) {
  assert.deepEqual({ ...sandbox.decodeUplink({ fPort: 11, bytes }).data }, { Watermark_Error: reason });
  assert.deepEqual(parseProfile3(bytes), { ok: false, reason });
}

// Profile 3 bytes on FPort 2 must still take the stock path (no WATERMARK fields).
const onPort2 = sandbox.decodeUplink({ fPort: 2, bytes: GOLDEN }).data || {};
assert.equal(onPort2.Watermark_Profile, undefined);

console.log('verify-lsn50-watermark-codec: OK (' + accepted.length + ' accepted, ' + rejected.length + ' rejected)');
