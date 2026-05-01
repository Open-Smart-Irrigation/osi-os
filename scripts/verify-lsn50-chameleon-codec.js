#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codecPath = path.join(
  __dirname,
  '..',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js'
);

const source = fs.readFileSync(codecPath, 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: codecPath });

assert.strictEqual(typeof sandbox.decodeUplink, 'function', 'decodeUplink is exported');

function decode(bytes) {
  return sandbox.decodeUplink({ fPort: 2, bytes }).data;
}

const stockMod3Frame = [
  0x03, 0xf2, // ADC CH0 = 1.010 V
  0x07, 0xe4, // ADC CH1 = 2.020 V
  0x0b, 0xd6, // ADC CH4 = 3.030 V
  0x08,       // mode code 2 => stock Work_mode "3ADC+IIC"
  0x12, 0x34, // BH1750 illumination = 0x1234
  0x00, 0x00, // no SHT sample present
  0x21        // stock battery = 3.3 V
];

const stock = decode(stockMod3Frame);
assert.strictEqual(stock.Work_mode, '3ADC+IIC');
assert.strictEqual(stock.BatV, 3.3);
assert.strictEqual(stock.ADC_CH0V, 1.01);
assert.strictEqual(stock.ADC_CH1V, 2.02);
assert.strictEqual(stock.ADC_CH4V, 3.03);
assert.strictEqual(stock.Illum, 0x1234);
assert.strictEqual(stock.Chameleon_Payload_Version, undefined);

const chameleonFrame = [
  0x03, 0xf2, // ADC PA0 = 1010 mV
  0x07, 0xe4, // ADC PA1 = 2020 mV
  0x0b, 0xd6, // ADC PA4 = 3030 mV
  0x08,       // stock status/mode byte, mode code 2
  0x21,       // battery / 100 = 3.3 V
  0x01,       // Chameleon payload version
  0x00,       // Chameleon status flags
  0x07, 0xc3, // soil temperature = 19.87 C
  0x00, 0x00, 0x04, 0x4c, // R1 compensated = 1100 ohm
  0x00, 0x00, 0x27, 0x74, // R2 compensated = 10100 ohm
  0x00, 0x01, 0x8b, 0x50, // R3 compensated = 101200 ohm
  0x00, 0x00, 0x04, 0xb0, // R1 raw = 1200 ohm
  0x00, 0x00, 0x27, 0xd8, // R2 raw = 10200 ohm
  0x00, 0x01, 0x8f, 0x38, // R3 raw = 102200 ohm
  0x28, 0x6d, 0x6a, 0xdb, 0x0f, 0x00, 0x00, 0xf1
];

const chameleon = decode(chameleonFrame);
assert.strictEqual(chameleon.Work_mode, '3ADC+IIC');
assert.strictEqual(chameleon.BatV, 3.3);
assert.strictEqual(chameleon.ADC_CH0V, 1.01);
assert.strictEqual(chameleon.ADC_CH1V, 2.02);
assert.strictEqual(chameleon.ADC_CH4V, 3.03);
assert.strictEqual(chameleon.Illum, undefined);
assert.strictEqual(chameleon.TempC_SHT, undefined);
assert.strictEqual(chameleon.Hum_SHT, undefined);
assert.strictEqual(chameleon.Chameleon_Payload_Version, 1);
assert.strictEqual(chameleon.Chameleon_Status_Flags, 0);
assert.strictEqual(chameleon.Chameleon_I2C_Missing, false);
assert.strictEqual(chameleon.Chameleon_Timeout, false);
assert.strictEqual(chameleon.Chameleon_Temp_Fault, false);
assert.strictEqual(chameleon.Chameleon_ID_Fault, false);
assert.strictEqual(chameleon.Chameleon_CH1_Open, false);
assert.strictEqual(chameleon.Chameleon_CH2_Open, false);
assert.strictEqual(chameleon.Chameleon_CH3_Open, false);
assert.strictEqual(chameleon.Chameleon_TempC, 19.87);
assert.strictEqual(chameleon.Chameleon_R1_Ohm_Comp, 1100);
assert.strictEqual(chameleon.Chameleon_R2_Ohm_Comp, 10100);
assert.strictEqual(chameleon.Chameleon_R3_Ohm_Comp, 101200);
assert.strictEqual(chameleon.Chameleon_R1_Ohm_Raw, 1200);
assert.strictEqual(chameleon.Chameleon_R2_Ohm_Raw, 10200);
assert.strictEqual(chameleon.Chameleon_R3_Ohm_Raw, 102200);
assert.strictEqual(chameleon.Chameleon_Array_ID, '286D6ADB0F0000F1');

const faultFrame = chameleonFrame.slice();
faultFrame[9] = 0x07; // I2C missing + timeout + temperature fault
for (let i = 10; i < faultFrame.length; i += 1) {
  faultFrame[i] = 0x00;
}

const fault = decode(faultFrame);
assert.strictEqual(fault.Chameleon_Status_Flags, 0x07);
assert.strictEqual(fault.Chameleon_I2C_Missing, true);
assert.strictEqual(fault.Chameleon_Timeout, true);
assert.strictEqual(fault.Chameleon_Temp_Fault, true);
assert.strictEqual(fault.Chameleon_TempC, 'NULL');
assert.strictEqual(fault.Chameleon_R1_Ohm_Comp, 'NULL');
assert.strictEqual(fault.Chameleon_R1_Ohm_Raw, 'NULL');
assert.strictEqual(fault.Chameleon_Array_ID, 'NULL');

const missingOnlyFrame = chameleonFrame.slice();
missingOnlyFrame[9] = 0x01; // I2C missing, no temperature fault bit
for (let i = 10; i < missingOnlyFrame.length; i += 1) {
  missingOnlyFrame[i] = 0x00;
}

const missingOnly = decode(missingOnlyFrame);
assert.strictEqual(missingOnly.Chameleon_Status_Flags, 0x01);
assert.strictEqual(missingOnly.Chameleon_Temp_Fault, false);
assert.strictEqual(missingOnly.Chameleon_TempC, 'NULL');
assert.strictEqual(missingOnly.Chameleon_R1_Ohm_Comp, 'NULL');
assert.strictEqual(missingOnly.Chameleon_R2_Ohm_Comp, 'NULL');
assert.strictEqual(missingOnly.Chameleon_R3_Ohm_Comp, 'NULL');
assert.strictEqual(missingOnly.Chameleon_R1_Ohm_Raw, 'NULL');
assert.strictEqual(missingOnly.Chameleon_R2_Ohm_Raw, 'NULL');
assert.strictEqual(missingOnly.Chameleon_R3_Ohm_Raw, 'NULL');
assert.strictEqual(missingOnly.Chameleon_Array_ID, 'NULL');

const openFrame = chameleonFrame.slice();
openFrame[9] = 0x10; // CH1 open
openFrame.splice(12, 4, 0x00, 0x98, 0x96, 0x80); // R1 compensated = 10000000 ohm

const open = decode(openFrame);
assert.strictEqual(open.Chameleon_CH1_Open, true);
assert.strictEqual(open.Chameleon_CH2_Open, false);
assert.strictEqual(open.Chameleon_R1_Ohm_Comp, 'NULL');
assert.strictEqual(open.Chameleon_R1_Ohm_Raw, 'NULL');
assert.strictEqual(open.Chameleon_R2_Ohm_Comp, 10100);
assert.strictEqual(open.Chameleon_R2_Ohm_Raw, 10200);

console.log('LSN50 Chameleon codec checks passed');
