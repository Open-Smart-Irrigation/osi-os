#!/usr/bin/env node
'use strict';
// The sign-in step gate in the shipped settings.js (httpNodeMiddleware). A
// token carrying the claim mustChangePassword reaches only GET /api/me and
// POST /auth/login; every other HTTP-in route answers 403
// password_change_required. Tokens without the claim, malformed tokens and
// requests without a token pass to the route unchanged.
//
// The release smoke (scripts/fixtures/release-smoke/cases.js,
// sign-in-step-gate) runs the same gate through Node-RED 3.1.15 and 4.0.9.
//
// Run: node --test scripts/test-sign-in-step-gate.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const SETTINGS_PATH = path.resolve(__dirname, '..', 'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js');
const LOCAL = require(path.resolve(__dirname, '..',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-local-password-reset'));

function loadSettings() {
  // settings.js reports its gateway-only start-up check on this host; keep
  // that one known line out of the test output.
  const original = console.error;
  console.error = (line, ...rest) => {
    if (!String(line).startsWith('[osi-db-startup]')) original(line, ...rest);
  };
  try {
    delete require.cache[SETTINGS_PATH];
    return require(SETTINGS_PATH);
  } finally {
    console.error = original;
  }
}

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function token(payload) {
  const body = b64url(JSON.stringify(payload));
  return body + '.' + b64url(crypto.createHmac('sha256', 'test-signing-value').update(body).digest());
}

const NOW = Date.now();
const ORDINARY = token({ userId: 1, username: 'first-owner', iat: NOW, exp: NOW + 60000 });
const PENDING = token({ userId: 1, username: 'first-owner', iat: NOW, exp: NOW + 60000, [LOCAL.TOKEN_CLAIM]: true });

function call(gate, { method = 'GET', path: reqPath = '/api/devices', authorization } = {}) {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nexted = 0;
  const headers = authorization === undefined ? {} : { authorization };
  gate({ method, path: reqPath, headers }, res, () => { nexted += 1; });
  return { nexted, status: res.statusCode, body: res.body };
}

const REFUSED = { code: 'password_change_required', message: 'Set a new password to continue.' };

test('settings.js installs the gate as httpNodeMiddleware and uses the module claim name', () => {
  const settings = loadSettings();
  assert.equal(typeof settings.httpNodeMiddleware, 'function');
  assert.equal(LOCAL.TOKEN_CLAIM, 'mustChangePassword');
  // The other settings this repo pins stay as they were.
  assert.equal(settings.httpAdminRoot, false);
  assert.equal(settings.httpStaticRoot, '/gui');
});

test('a token marked for the password step is refused on protected routes', () => {
  const gate = loadSettings().httpNodeMiddleware;
  for (const [method, reqPath] of [
    ['GET', '/api/devices'], ['POST', '/api/valve/A840410000000001'], ['PUT', '/api/irrigation-zones/1'],
    ['DELETE', '/api/devices/A840410000000001'], ['GET', '/api/users'], ['POST', '/api/me'],
    ['GET', '/auth/login'], ['POST', '/api/account-link'], ['GET', '/api/me/extra'],
  ]) {
    const out = call(gate, { method, path: reqPath, authorization: 'Bearer ' + PENDING });
    assert.equal(out.nexted, 0, method + ' ' + reqPath);
    assert.equal(out.status, 403, method + ' ' + reqPath);
    assert.deepEqual(out.body, REFUSED);
  }
});

test('the marked token still reaches GET /api/me and POST /auth/login', () => {
  const gate = loadSettings().httpNodeMiddleware;
  for (const [method, reqPath] of [['GET', '/api/me'], ['GET', '/api/me/'], ['get', '/api/me'], ['POST', '/auth/login']]) {
    const out = call(gate, { method, path: reqPath, authorization: 'Bearer ' + PENDING });
    assert.equal(out.nexted, 1, method + ' ' + reqPath);
    assert.equal(out.status, null);
  }
});

test('ordinary, malformed and missing tokens pass to the route unchanged', () => {
  const gate = loadSettings().httpNodeMiddleware;
  const cases = [
    'Bearer ' + ORDINARY,
    'Bearer ' + token({ userId: 1, username: 'first-owner', [LOCAL.TOKEN_CLAIM]: 'true' }),
    'Bearer ' + token({ userId: 1, username: 'first-owner', [LOCAL.TOKEN_CLAIM]: false }),
    'Bearer not-base64-json.sig', 'Bearer .sig', 'Bearer ', 'Basic abc', '', undefined,
    'Bearer ' + b64url('[1,2]') + '.sig', 'Bearer ' + b64url('null') + '.sig',
  ];
  for (const authorization of cases) {
    const out = call(gate, { authorization });
    assert.equal(out.nexted, 1, String(authorization));
    assert.equal(out.status, null);
  }
  // A request object without headers never throws.
  let nexted = 0;
  loadSettings().httpNodeMiddleware({ method: 'GET', path: '/api/devices' }, {}, () => { nexted += 1; });
  assert.equal(nexted, 1);
});
