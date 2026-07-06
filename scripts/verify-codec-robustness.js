#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const codecDir = path.join(
  __dirname,
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs'
);

const codecs = {
  strega: {
    file: 'strega_gen1_decoder.js',
    fPort: 2,
    representativeFrame: [
      0x32, 0x30, 0x30, 0x30, 0x33, 0x23, 0x7f, 0xff, 0xff, 0xff, 0x43,
      0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x56, 0x30, 0x30, 0x30, 0x30,
    ],
    expected: {
      empty: {
        data: {
          Port: 2,
          Status: undefined,
          Battery: undefined,
          Valve: undefined,
          Tamper: undefined,
          Cable: undefined,
          DI_0: undefined,
          DI_1: undefined,
          Leakage: undefined,
          Fraud: undefined,
          Class: undefined,
          Power: undefined,
          Process: 'true',
        },
      },
      oneByte: {
        data: {
          Port: 2,
          Status: '00000-11',
          Battery: -125,
          Valve: '1',
          Tamper: '1',
          Cable: '-',
          DI_0: '0',
          DI_1: '0',
          Leakage: '0',
          Fraud: '0',
          Class: '0',
          Power: '0',
          Process: 'true',
        },
      },
      truncated: {
        data: {
          Port: 2,
          Status: '00000011',
          Battery: 0,
          Valve: '1',
          Tamper: '1',
          Cable: '0',
          DI_0: '0',
          DI_1: '0',
          Leakage: '0',
          Fraud: '0',
          Class: '0',
          Power: '0',
          Process: 'true',
        },
      },
      unknownFPort: {
        data: {
          Port: 99,
          Status: '00000011',
          Battery: 0,
          Valve: '1',
          Tamper: '1',
          Cable: '0',
          DI_0: '0',
          DI_1: '0',
          Leakage: '0',
          Fraud: '0',
          Class: '0',
          Power: '0',
          Process: 'true',
          Counter: 1,
          Analog_value: 0,
          Temperature: 42.5,
          Hygrometry: 100,
        },
      },
    },
  },
  lsn50: {
    file: 'dragino_lsn50_decoder.js',
    fPort: 2,
    representativeFrame: [
      0x03, 0xf2, 0x07, 0xe4, 0x0b, 0xd6, 0x08, 0x12, 0x34, 0x00, 0x00, 0x21,
    ],
    expected: {
      empty: {
        data: {
          Digital_IStatus: 'L',
          BatV: 0,
          TempC1: 0,
          ADC_CH0V: 0,
          EXTI_Trigger: 'FALSE',
          Door_status: 'OPEN',
          Work_mode: 'IIC',
          Illum: 0,
          Node_type: 'LSN50',
        },
      },
      oneByte: {
        data: undefined,
      },
      truncated: {
        data: {
          Digital_IStatus: 'L',
          BatV: 1.01,
          TempC1: 202,
          ADC_CH0V: 2.816,
          EXTI_Trigger: 'FALSE',
          Door_status: 'OPEN',
          Work_mode: 'IIC',
          Illum: 0,
          Node_type: 'LSN50',
        },
      },
      unknownFPort: {
        data: undefined,
      },
    },
  },
  lorain: {
    file: 'aquascope_lorain_decoder.js',
    fPort: 10,
    representativeFrame: [
      0x06, 0x81, 0x00, 0x03, 0x06, 0x01, 0x00, 0xcd, 0x12, 0x21, 0x00, 0x0a,
    ],
    expected: {
      empty: {
        data: {},
        warnings: [],
        errors: [],
      },
      oneByte: {
        data: {},
        warnings: ['Truncated LoRain sensor block'],
        errors: [],
      },
      truncated: {
        data: {
          rainlevel: 3,
          rain_tips_delta: 3,
          rain_mm_delta: 1.5,
        },
        warnings: ['Truncated LoRain sensor block'],
        errors: [],
      },
      unknownFPort: {
        data: {},
        warnings: [],
        errors: ['LoRain uplinks are expected on FPort 10 or legacy FPort 2'],
      },
    },
  },
  s2120: {
    file: 'sensecap_s2120_decoder.js',
    fPort: 2,
    representativeFrame: [
      0x01, 0x00, 0xb6, 0x42, 0x00, 0x00, 0x04, 0xd2, 0x1b, 0x00, 0x20,
      0x02, 0x00, 0xb6, 0x00, 0x00, 0x30, 0x70, 0x27, 0x67,
      0x03, 0x54,
      0x4c, 0x00, 0x4c, 0x00, 0x00, 0x30, 0x70,
    ],
    expected: {
      empty: {
        data: {
          err: 0,
          payload: '',
          valid: true,
          messages: [],
        },
      },
      oneByte: {
        data: {
          err: 0,
          payload: '01',
          valid: true,
          messages: [],
        },
      },
      truncated: {
        data: {
          err: 0,
          payload: '0100B64200',
          valid: true,
          messages: [[
            { measurementValue: 18.2, measurementId: '4097', type: 'Air Temperature' },
            { measurementValue: 66, measurementId: '4098', type: 'Air Humidity' },
            { measurementValue: 0, measurementId: '4099', type: 'Light Intensity' },
            { measurementValue: NaN, measurementId: '4190', type: 'UV Index' },
            { measurementValue: NaN, measurementId: '4105', type: 'Wind Speed' },
          ]],
        },
      },
      unknownFPort: {
        data: {
          err: 0,
          payload: '0100B642000004D21B00200200B600003070276703544C004C00003070',
          valid: true,
          messages: [
            [
              { measurementValue: 18.2, measurementId: '4097', type: 'Air Temperature' },
              { measurementValue: 66, measurementId: '4098', type: 'Air Humidity' },
              { measurementValue: 1234, measurementId: '4099', type: 'Light Intensity' },
              { measurementValue: 2.7, measurementId: '4190', type: 'UV Index' },
              { measurementValue: 3.2, measurementId: '4105', type: 'Wind Speed' },
            ],
            [
              { measurementValue: 182, measurementId: '4104', type: 'Wind Direction Sensor' },
              { measurementValue: 12.4, measurementId: '4113', type: 'Rain Gauge' },
              { measurementValue: 100870, measurementId: '4101', type: 'Barometric Pressure' },
            ],
            [
              { 'Battery(%)': 84 },
            ],
            [
              { measurementValue: 7.6, measurementId: '4191', type: ' Peak Wind Gust' },
              { measurementValue: 12.4, measurementId: '4213', type: 'Rain Accumulation' },
            ],
          ],
        },
      },
    },
  },
};

function loadCodec(name, file) {
  const filename = path.join(codecDir, file);
  const source = fs.readFileSync(filename, 'utf8');
  const sandbox = {
    Buffer,
    console: {
      log() {},
      warn() {},
      error() {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename });
  assert.equal(typeof sandbox.decodeUplink, 'function', `${name} decodeUplink is exported`);
  return sandbox.decodeUplink;
}

function runNoThrow(decodeUplink, input, label) {
  let decoded;
  assert.doesNotThrow(() => {
    decoded = decodeUplink(input);
  }, `${label} should not throw`);
  return decoded;
}

function toPlainObject(value) {
  if (Array.isArray(value)) {
    return Array.from(value, toPlainObject);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toPlainObject(entry)])
    );
  }
  return value;
}

function main() {
  for (const [name, codec] of Object.entries(codecs)) {
    const decodeUplink = loadCodec(name, codec.file);
    const cases = {
      empty: { fPort: codec.fPort, bytes: [] },
      oneByte: { fPort: codec.fPort, bytes: [codec.representativeFrame[0]] },
      truncated: { fPort: codec.fPort, bytes: codec.representativeFrame.slice(0, 5) },
      unknownFPort: { fPort: 99, bytes: codec.representativeFrame },
    };

    for (const [caseName, input] of Object.entries(cases)) {
      const actual = runNoThrow(decodeUplink, input, `${name} ${caseName}`);
      assert.deepStrictEqual(
        toPlainObject(actual),
        codec.expected[caseName],
        `${name} ${caseName} snapshot`
      );
    }
  }

  console.log('Codec robustness verification passed');
}

main();
