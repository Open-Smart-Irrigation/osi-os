'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('./deploy-local-server.js');

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-local-server-test-'));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('binds only to 127.0.0.1', async () => {
  const root = mkTempRoot();
  const server = createServer(root);
  const addr = await listen(server);
  assert.equal(addr.address, '127.0.0.1');
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('serves a text file with correct status, Content-Length, and body', async () => {
  const root = mkTempRoot();
  fs.writeFileSync(path.join(root, 'deploy.sh'), '#!/bin/sh\necho hi\n');
  const server = createServer(root);
  const addr = await listen(server);
  const res = await get(addr.port, '/deploy.sh');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], String(Buffer.byteLength('#!/bin/sh\necho hi\n')));
  assert.equal(res.body.toString('utf8'), '#!/bin/sh\necho hi\n');
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('serves nested paths', async () => {
  const root = mkTempRoot();
  fs.mkdirSync(path.join(root, 'database', 'migrations', 'ordered'), { recursive: true });
  fs.writeFileSync(path.join(root, 'database', 'migrations', 'ordered', 'CHECKSUMS.json'), '{}');
  const server = createServer(root);
  const addr = await listen(server);
  const res = await get(addr.port, '/database/migrations/ordered/CHECKSUMS.json');
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), '{}');
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('serves binary files byte-for-byte', async () => {
  const root = mkTempRoot();
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 10, 0, 128]);
  fs.writeFileSync(path.join(root, 'react_gui.tar.gz'), bytes);
  const server = createServer(root);
  const addr = await listen(server);
  const res = await get(addr.port, '/react_gui.tar.gz');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-length'], String(bytes.length));
  assert.ok(res.body.equals(bytes));
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('returns 404 for a missing file', async () => {
  const root = mkTempRoot();
  const server = createServer(root);
  const addr = await listen(server);
  const res = await get(addr.port, '/nope.txt');
  assert.equal(res.status, 404);
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('returns 404 (not 500) for a directory request', async () => {
  const root = mkTempRoot();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'x.js'), 'x');
  const server = createServer(root);
  const addr = await listen(server);
  const res = await get(addr.port, '/scripts');
  assert.equal(res.status, 404);
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects path traversal outside the served root', async () => {
  const root = mkTempRoot();
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-local-server-secret-'));
  fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'top secret');
  const server = createServer(root);
  const addr = await listen(server);
  const relTraversal = path.relative(root, path.join(secretDir, 'secret.txt'));
  const res = await get(addr.port, '/' + relTraversal.split(path.sep).join('/'));
  assert.notEqual(res.status, 200);
  assert.ok([400, 403, 404].includes(res.status), `expected a rejection status, got ${res.status}`);
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(secretDir, { recursive: true, force: true });
});

test('rejects encoded path traversal (%2e%2e)', async () => {
  const root = mkTempRoot();
  fs.writeFileSync(path.join(root, 'safe.txt'), 'safe');
  const server = createServer(root);
  const addr = await listen(server);
  const res = await get(addr.port, '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd');
  assert.ok([400, 403, 404].includes(res.status), `expected a rejection status, got ${res.status}`);
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects null-byte path tricks', async () => {
  const root = mkTempRoot();
  const server = createServer(root);
  const addr = await listen(server);
  const res = await get(addr.port, '/deploy.sh%00.txt');
  assert.ok([400, 403, 404].includes(res.status), `expected a rejection status, got ${res.status}`);
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects non-GET/HEAD methods', async () => {
  const root = mkTempRoot();
  fs.writeFileSync(path.join(root, 'deploy.sh'), 'x');
  const server = createServer(root);
  const addr = await listen(server);
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/deploy.sh', method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.ok([405, 501].includes(result), `expected method rejection, got ${result}`);
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});

test('HEAD returns headers with no body', async () => {
  const root = mkTempRoot();
  fs.writeFileSync(path.join(root, 'deploy.sh'), 'hello');
  const server = createServer(root);
  const addr = await listen(server);
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addr.port, path: '/deploy.sh', method: 'HEAD' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-length'], '5');
  assert.equal(result.body.length, 0);
  await close(server);
  fs.rmSync(root, { recursive: true, force: true });
});
