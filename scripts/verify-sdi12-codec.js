'use strict';
// Verifies codecs/dragino_sdi12_decoder.js decodes the three FPorts.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const codecPath = path.join(__dirname, '..',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_sdi12_decoder.js');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(codecPath, 'utf8'), ctx, { filename: codecPath });
assert.strictEqual(typeof ctx.decodeUplink, 'function', 'decodeUplink missing');

function ascii(s) { return Array.from(s).map((c) => c.charCodeAt(0)); }

// FPort 2: 3.300 V battery, payver 1, Tensiomark-shaped "+2.48+21.5".
const f2 = ctx.decodeUplink({ fPort: 2, bytes: [0x0C, 0xE4, 0x01].concat(ascii('+2.48+21.5')) }).data;
assert.strictEqual(f2.BatV, 3.3);
assert.strictEqual(f2.EXTI_Trigger, 'FALSE');
assert.strictEqual(f2.Payver, 1);
assert.strictEqual(f2.data_sum, '+2.48+21.5');
assert.strictEqual(f2.Node_type, 'SDI12');

// EXTI bit set: 0x8CE4 -> flag TRUE, same voltage.
const f2i = ctx.decodeUplink({ fPort: 2, bytes: [0x8C, 0xE4, 0x01].concat(ascii('+1')) }).data;
assert.strictEqual(f2i.BatV, 3.3);
assert.strictEqual(f2i.EXTI_Trigger, 'TRUE');

// FPort 5 status: model 0x17, fw 1.0.0, EU868, no sub-band, 3.005 V.
const f5 = ctx.decodeUplink({ fPort: 5, bytes: [0x17, 0x01, 0x00, 0x01, 0xFF, 0x0B, 0xBD] }).data;
assert.strictEqual(f5.SENSOR_MODEL, 'SDI12-LB/LS');
assert.strictEqual(f5.FIRMWARE_VERSION, '1.0.0');
assert.strictEqual(f5.FREQUENCY_BAND, 'EU868');
assert.strictEqual(f5.SUB_BAND, null);
assert.strictEqual(f5.BAT, 3.005);

// FPort 100 debug echo, including the vendor NULL marker.
const f100 = ctx.decodeUplink({ fPort: 100, bytes: ascii('013SENTEK  ES2   101') }).data;
assert.strictEqual(f100.datas_sum, '013SENTEK  ES2   101');
const fnull = ctx.decodeUplink({ fPort: 100, bytes: [0x4E, 0x55, 0x4C, 0x4C] }).data;
assert.strictEqual(fnull.datas_sum, 'NULL');

// Unsupported ports (incl. FPort 3 datalog) must be rejected, not decoded.
const f3 = ctx.decodeUplink({ fPort: 3, bytes: [0x66, 0x9F, 0x01, 0x02, 0x03] }).data;
assert.strictEqual(f3.unsupported_fport, 3);
assert.strictEqual(f3.data_sum, undefined);
const f7 = ctx.decodeUplink({ fPort: 7, bytes: ascii('+1.0') }).data;
assert.strictEqual(f7.unsupported_fport, 7);

// A control byte >= 0xF0 skips itself AND the following (printable) byte.
const fctl = ctx.decodeUplink({ fPort: 2, bytes: [0x0C, 0xE4, 0x01, 0xF4, 0x31].concat(ascii('+2.5')) }).data;
assert.strictEqual(fctl.data_sum, '+2.5');   // the '1' (0x31) after 0xF4 must not leak into the data

// Short/garbage frames must not throw.
ctx.decodeUplink({ fPort: 2, bytes: [] });
ctx.decodeUplink({ fPort: 2, bytes: [0x01] });
console.log('verify-sdi12-codec: PASS');
