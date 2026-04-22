#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codecPath = path.resolve(
  __dirname,
  '..',
  'conf',
  'full_raspberrypi_bcm27xx_bcm2712',
  'files',
  'usr',
  'share',
  'node-red',
  'codecs',
  'strega_gen1_decoder.js',
);
const fixturePath = path.resolve(__dirname, 'fixtures', 'strega-gen1', 'valve-white-fport4-sample.json');
const flowPath = path.resolve(
  __dirname,
  '..',
  'conf',
  'full_raspberrypi_bcm27xx_bcm2712',
  'files',
  'usr',
  'share',
  'flows.json',
);

function loadJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function runScript(source, sandbox, filename) {
  const script = new vm.Script(source, { filename });
  return script.runInNewContext(sandbox, { timeout: 1000 });
}

function loadCodec() {
  const source = fs.readFileSync(codecPath, 'utf8');
  const sandbox = { Buffer, console };
  runScript(source, sandbox, codecPath);
  assert.equal(typeof sandbox.decodeUplink, 'function', 'managed STREGA codec must export decodeUplink(input)');
  return sandbox.decodeUplink;
}

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildBearerToken(secret, claims) {
  const payload = toBase64Url(JSON.stringify(claims));
  const signature = toBase64Url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `Bearer ${payload}.${signature}`;
}

function getFunctionNode(flows, name) {
  const node = flows.find((entry) => entry.name === name);
  assert.ok(node, `missing Node-RED function node ${name}`);
  assert.equal(typeof node.func, 'string', `${name} must include executable source`);
  return node;
}

function runFunctionNode(node, payload, secret, deviceEui) {
  const msg = {
    req: {
      headers: {
        authorization: buildBearerToken(secret, {
          userId: 7,
          username: 'uganda-operator',
          exp: Date.now() + 3600_000,
        }),
      },
      params: {
        deveui: deviceEui,
      },
    },
    payload,
  };
  const sandbox = {
    Buffer,
    console,
    crypto,
    msg,
    env: {
      get(name) {
        if (name === 'AUTH_TOKEN_SECRET' || name === 'JWT_SECRET') return secret;
        return '';
      },
    },
    global: {
      get(name) {
        if (name === 'fs') return fs;
        return undefined;
      },
    },
  };
  const result = runScript(`(() => { ${node.func} })()`, sandbox, `${node.name}.vm.js`);
  assert.ok(Array.isArray(result), `${node.name} must return a Node-RED output array`);
  assert.ok(result[0], `${node.name} should emit the parsed command on output 1`);
  return result[0];
}

function verifyDecodeContract(decodeUplink, fixture) {
  const bytes = Array.from(Buffer.from(fixture.base64, 'base64'));
  const decoded = decodeUplink({ fPort: fixture.fPort, bytes });

  assert.ok(decoded, 'decodeUplink must return a result object');
  assert.ok(decoded.data, 'decodeUplink must return a data object');
  assert.ok(Object.prototype.hasOwnProperty.call(decoded.data, 'Battery'), 'decodeUplink must expose Battery for the sample');
  assert.equal(Number(decoded.data.Battery), fixture.expected.Battery, 'fixture should preserve the captured raw battery value');
  assert.equal(String(decoded.data.Valve), fixture.expected.Valve, 'fixture should preserve the captured raw valve bit');
  assert.ok(Object.prototype.hasOwnProperty.call(decoded.data, 'Temperature'), 'decodeUplink must expose Temperature for the sample');
  assert.ok(Object.prototype.hasOwnProperty.call(decoded.data, 'Hygrometry'), 'decodeUplink must expose Hygrometry for the sample');
  assert.equal(decoded.data.Temperature, null, 'fixture should normalize the sentinel temperature to null');
  assert.equal(decoded.data.Hygrometry, null, 'fixture should normalize the sentinel hygrometry to null');
  console.log('OK managed STREGA codec decodes the Uganda Gen1 fixture with null environmental telemetry');
  return decoded;
}

async function verifyStregaNormalizationContract(flows, fixture, object, label) {
  const node = getFunctionNode(flows, 'Process STREGA');
  const sandbox = {
    Buffer,
    console,
    crypto,
    msg: {
      payload: {
        deviceInfo: {
          devEui: fixture.deviceEui,
          deviceProfileName: 'STREGA',
          deviceProfileId: 'strega-profile',
        },
        object,
        fPort: fixture.fPort,
        time: '2026-04-22T00:00:00.000Z',
      },
    },
    env: {
      get(name) {
        if (name === 'AUTH_TOKEN_SECRET' || name === 'JWT_SECRET' || name === 'CHIRPSTACK_PROFILE_STREGA') return '';
        return '';
      },
    },
    global: {
      get(name) {
        if (name === 'fs') return fs;
        return undefined;
      },
    },
    osiDb: {
      Database: class {
        all(_sql, callback) {
          callback(null, [{ type_id: 'STREGA_VALVE' }]);
        }

        close(callback) {
          callback();
        }
      },
    },
    node: {
      status() {},
      error() {},
    },
  };
  const result = runScript(`(() => { ${node.func} })()`, sandbox, `${node.name}.vm.js`);
  const resolved = result && typeof result.then === 'function' ? await result : result;

  assert.ok(resolved, `${node.name} must return a result for ${label}`);
  assert.ok(resolved.formattedData, `${node.name} must attach formattedData for ${label}`);
  assert.equal(resolved.formattedData.ambientTemperature, null, `${label} should drop the sentinel env reading`);
  assert.equal(resolved.formattedData.relativeHumidity, null, `${label} should drop the sentinel env reading`);
  assert.equal(resolved.formattedData.batPct, 100, `${label} should preserve the numeric battery percent`);
  assert.equal(resolved.formattedData.batteryRaw, 100, `${label} should preserve the raw battery value`);
  assert.equal(resolved.formattedData.currentState, 'CLOSED', `${label} should preserve the valve state`);
}

function verifyCommandMatrix(flows, fixture) {
  const secret = 'strega-gen1-test-secret';
  const cases = [
    {
      name: 'Auth + Parse STREGA Interval',
      payload: { closedMinutes: 5, openedMinutes: 2, tamperDisabled: true },
      expectedHex: '01050002',
      expectedPort: 11,
    },
    {
      name: 'Auth + Parse STREGA Timed Action',
      payload: { action: 'OPEN', unit: 'minutes', amount: 3 },
      expectedHex: '4103',
      expectedPort: 2,
    },
    {
      name: 'Auth + Parse STREGA Magnet',
      payload: { enabled: true },
      expectedHex: '31',
      expectedPort: 22,
    },
    {
      name: 'Auth + Parse STREGA Partial Opening',
      payload: { action: 'OPEN', percentage: 35 },
      expectedHex: '3123',
      expectedPort: 27,
    },
    {
      name: 'Auth + Parse STREGA Flushing',
      payload: { returnPosition: 'CLOSE', percentage: 40 },
      expectedHex: '3028',
      expectedPort: 28,
    },
  ];

  for (const testCase of cases) {
    const node = getFunctionNode(flows, testCase.name);
    const parsed = runFunctionNode(node, testCase.payload, secret, fixture.deviceEui);
    assert.equal(parsed._strega_payload_hex, testCase.expectedHex, `${testCase.name} should build ${testCase.expectedHex}`);
    assert.equal(parsed._strega_fport, testCase.expectedPort, `${testCase.name} should target fPort ${testCase.expectedPort}`);
    console.log(`OK ${testCase.name} builds ${testCase.expectedHex} on fPort ${testCase.expectedPort}`);
  }
}

async function main() {
  const fixture = loadJson(fixturePath);
  const flows = loadJson(flowPath);
  const decodeUplink = loadCodec();

  const decoded = verifyDecodeContract(decodeUplink, fixture);
  const managedCodecObject = { ...decoded.data };
  delete managedCodecObject.Temperature;
  delete managedCodecObject.Hygrometry;
  await verifyStregaNormalizationContract(flows, fixture, managedCodecObject, 'codec handoff');
  await verifyStregaNormalizationContract(
    flows,
    fixture,
    {
      ...decoded.data,
      Temperature: 125,
      Hygrometry: 100,
    },
    'legacy sentinel object',
  );
  verifyCommandMatrix(flows, fixture);
  console.log('OK Strega Gen1 smoke checks passed');
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
