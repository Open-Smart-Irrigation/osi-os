#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const helper = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http');

function withEnv(patch, fn) {
  const previous = {};
  Object.keys(patch).forEach((key) => {
    previous[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.keys(patch).forEach((key) => {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      });
    });
}

function installRequestStub() {
  const originalHttp = http.request;
  const originalHttps = https.request;
  const calls = [];
  function stubRequest(options, callback) {
    calls.push(options);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 204;
      res.headers = {};
      res.complete = true;
      process.nextTick(() => {
        callback(res);
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  }
  http.request = stubRequest;
  https.request = stubRequest;
  return {
    calls,
    restore() {
      http.request = originalHttp;
      https.request = originalHttps;
    }
  };
}

async function expectRejectsClosed(input, expectedReason) {
  const stub = installRequestStub();
  try {
    await assert.rejects(
      () => helper.requestJsonIpv4(Object.assign({
        method: 'GET',
        url: 'https://example.invalid/api'
      }, input || {})),
      (error) => {
        assert.strictEqual(error.code, 'OSI_LOWPOWER_WINDOW_CLOSED');
        assert.strictEqual(error.statusCode, 425);
        assert.match(error.message, /low-power cloud window is closed/);
        assert.match(error.message, /window\.env/);
        return true;
      }
    );
    assert.strictEqual(stub.calls.length, 0, expectedReason);
  } finally {
    stub.restore();
  }
}

(async () => {
  assert.deepStrictEqual(
    helper.lowPowerWindowStatus({
      env: {},
      fs
    }),
    {
      enabled: false,
      stateFile: '/var/run/osi-lowpower/window.env',
      state: 'disabled',
      open: true,
      reason: 'low-power disabled',
      values: {}
    }
  );

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-lowpower-'));
  const stateFile = path.join(stateDir, 'window.env');

  await withEnv({
    OSI_LOWPOWER_WINDOWED_SYNC: undefined,
    OSI_LOWPOWER_STATE_FILE: stateFile
  }, async () => {
    const stub = installRequestStub();
    try {
      const result = await helper.requestJsonIpv4({
        method: 'GET',
        url: 'https://example.invalid/api',
        lowPowerBypass: true
      });
      assert.strictEqual(result.statusCode, 204);
      assert.strictEqual(stub.calls.length, 1);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(stub.calls[0], 'lowPowerBypass'), false);
    } finally {
      stub.restore();
    }
  });

  await withEnv({
    OSI_LOWPOWER_WINDOWED_SYNC: '1',
    OSI_LOWPOWER_STATE_FILE: stateFile
  }, async () => {
    await expectRejectsClosed({}, 'missing state file must reject before network I/O');

    fs.writeFileSync(stateFile, [
      'OSI_LOWPOWER_ENABLED=1',
      'OSI_LOWPOWER_WINDOW_STATE=closed',
      'OSI_LOWPOWER_REASON=scheduled'
    ].join('\n') + '\n');
    assert.deepStrictEqual(
      helper.lowPowerWindowStatus({ env: process.env, fs }).open,
      false
    );
    await expectRejectsClosed({}, 'closed state must reject before network I/O');

    fs.writeFileSync(stateFile, [
      'OSI_LOWPOWER_ENABLED=1',
      'OSI_LOWPOWER_WINDOW_STATE=open',
      'OSI_LOWPOWER_REASON=scheduled'
    ].join('\n') + '\n');
    const status = helper.lowPowerWindowStatus({ env: process.env, fs });
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.open, true);
    assert.strictEqual(status.state, 'open');
    assert.strictEqual(status.reason, 'scheduled');

    const stub = installRequestStub();
    try {
      const result = await helper.requestJsonIpv4({
        method: 'POST',
        url: 'https://example.invalid/api',
        payload: { ok: true }
      });
      assert.strictEqual(result.statusCode, 204);
      assert.strictEqual(stub.calls.length, 1);
    } finally {
      stub.restore();
    }

    fs.writeFileSync(stateFile, 'OSI_LOWPOWER_WINDOW_STATE=closed\n');
    const bypassStub = installRequestStub();
    try {
      const result = await helper.requestJsonIpv4({
        method: 'GET',
        url: 'https://example.invalid/api',
        lowPowerBypass: true
      });
      assert.strictEqual(result.statusCode, 204);
      assert.strictEqual(bypassStub.calls.length, 1);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(bypassStub.calls[0], 'lowPowerBypass'), false);
    } finally {
      bypassStub.restore();
    }
  });

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('Low-power cloud HTTP tests passed.');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
