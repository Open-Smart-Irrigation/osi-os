'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { verifyMirror } = require('./verify-dendro-contract-mirror.js');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeTrees() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dendro-contract-mirror-'));
  const source = path.join(root, 'source');
  const server = path.join(root, 'server');
  const mirror = path.join(server, 'backend/src/test/resources/contracts/dendro');
  write(path.join(source, 'MANIFEST.json'), '{"schemaVersion":1,"cases":["case-a"]}\n');
  write(path.join(source, 'cases/case-a.input.json'), '{"points":[]}\n');
  write(path.join(source, 'cases/case-a.expected.json'), '{"results":[]}\n');
  write(path.join(mirror, 'MANIFEST.json'), '{"schemaVersion":1,"cases":["case-a"]}\n');
  write(path.join(mirror, 'cases/case-a.input.json'), '{"points":[]}\n');
  write(path.join(mirror, 'cases/case-a.expected.json'), '{"results":[]}\n');
  return { source, server, mirror };
}

test('passes when source and osi-server mirror are byte-identical', () => {
  const { source, server } = makeTrees();
  assert.deepEqual(verifyMirror({ sourceRoot: source, serverRoot: server }), []);
});

test('fails when a mirrored file diverges byte-for-byte', () => {
  const { source, server, mirror } = makeTrees();
  write(path.join(mirror, 'cases/case-a.expected.json'), '{"results":[1]}\n');
  const failures = verifyMirror({ sourceRoot: source, serverRoot: server });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /byte mismatch: cases\/case-a\.expected\.json/);
});

test('fails when a mirrored file is missing', () => {
  const { source, server, mirror } = makeTrees();
  fs.unlinkSync(path.join(mirror, 'cases/case-a.input.json'));
  const failures = verifyMirror({ sourceRoot: source, serverRoot: server });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /missing mirror: cases\/case-a\.input\.json/);
});

test('fails when the mirror has an extra contract file', () => {
  const { source, server, mirror } = makeTrees();
  write(path.join(mirror, 'cases/extra.input.json'), '{}\n');
  const failures = verifyMirror({ sourceRoot: source, serverRoot: server });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /extra mirror: cases\/extra\.input\.json/);
});
