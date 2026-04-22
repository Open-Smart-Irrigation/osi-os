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
  assert.equal(Number(decoded.data.Battery), 101, 'fixture should preserve the captured raw battery value');
  assert.equal(String(decoded.data.Valve), '0', 'fixture should preserve the captured raw valve bit');
  assert.equal(String(decoded.data.Tamper), '1', 'fixture should preserve the captured raw tamper bit');
  console.log('OK managed STREGA codec decodes the Uganda Gen1 fixture');
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

function main() {
  const fixture = loadJson(fixturePath);
  const flows = loadJson(flowPath);
  const decodeUplink = loadCodec();

  verifyDecodeContract(decodeUplink, fixture);
  verifyCommandMatrix(flows, fixture);
  console.log('OK Strega Gen1 smoke checks passed');
}

try {
  main();
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
