#!/usr/bin/env node
'use strict';

// Run only from the clean, P-aligned osi-os implementation checkout after the
// test-first RED has been captured. This file is a review artifact until then.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const canonicalPath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const mirrorPath = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
const ids = ['sync-bootstrap-build', 'sync-force-build'];
const oldExpression = 'archived_at: r.observed_close_at || r.expected_close_at || r.commanded_at,';
const newExpression = 'archived_at: r.observed_close_at || r.commanded_at,';
const oldComment = '  // buildActuationPayload) -- same field list, same archived_at fallback chain. Keep';
const newComment = '  // buildActuationPayload) -- same fields, observed close else command time. Keep';

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function loadWithNoopRoundtrip(file) {
  const bytes = fs.readFileSync(file);
  const flows = JSON.parse(bytes.toString('utf8'));
  assert.equal(Buffer.compare(serialize(flows), bytes), 0, `pre-edit no-op roundtrip: ${file}`);
  assert.ok(Array.isArray(flows), `flow array: ${file}`);
  return { bytes, flows };
}

function exactNode(flows, id, file) {
  const matches = flows.filter((node) => node.id === id);
  assert.equal(matches.length, 1, `exactly one ${id}: ${file}`);
  assert.equal(typeof matches[0].func, 'string', `${id} func: ${file}`);
  return matches[0];
}

const canonical = loadWithNoopRoundtrip(canonicalPath);
const mirror = loadWithNoopRoundtrip(mirrorPath);
assert.equal(Buffer.compare(canonical.bytes, mirror.bytes), 0, 'pre-edit full-profile byte parity');

for (const [file, flows] of [[canonicalPath, canonical.flows], [mirrorPath, mirror.flows]]) {
  for (const id of ids) {
    const node = exactNode(flows, id, file);
    assert.equal(count(node.func, oldExpression), 1, `one old expression in ${id}: ${file}`);
    assert.equal(count(node.func, oldComment), 1, `one old comment in ${id}: ${file}`);
    assert.equal(count(node.func, newExpression), 0, `no new expression before edit in ${id}: ${file}`);
    assert.equal(count(node.func, newComment), 0, `no new comment before edit in ${id}: ${file}`);
  }
}

for (const id of ids) {
  const node = exactNode(canonical.flows, id, canonicalPath);
  node.func = node.func.replace(oldExpression, newExpression).replace(oldComment, newComment);
  assert.equal(count(node.func, oldExpression), 0, `old expression removed: ${id}`);
  assert.equal(count(node.func, oldComment), 0, `old comment removed: ${id}`);
  assert.equal(count(node.func, newExpression), 1, `new expression present once: ${id}`);
  assert.equal(count(node.func, newComment), 1, `new comment present once: ${id}`);
}

const output = serialize(canonical.flows);
fs.writeFileSync(canonicalPath, output);
fs.writeFileSync(mirrorPath, output);

const writtenCanonical = loadWithNoopRoundtrip(canonicalPath);
const writtenMirror = loadWithNoopRoundtrip(mirrorPath);
assert.equal(Buffer.compare(writtenCanonical.bytes, output), 0, 'canonical write equals serialized output');
assert.equal(Buffer.compare(writtenMirror.bytes, output), 0, 'mirror copy equals serialized output');
assert.equal(Buffer.compare(writtenCanonical.bytes, writtenMirror.bytes), 0, 'post-edit full-profile byte parity');
for (const [file, flows] of [[canonicalPath, writtenCanonical.flows], [mirrorPath, writtenMirror.flows]]) {
  for (const id of ids) {
    const node = exactNode(flows, id, file);
    assert.equal(count(node.func, oldExpression), 0, `old expression absent after write: ${id}: ${file}`);
    assert.equal(count(node.func, oldComment), 0, `old comment absent after write: ${id}: ${file}`);
    assert.equal(count(node.func, newExpression), 1, `new expression after write: ${id}: ${file}`);
    assert.equal(count(node.func, newComment), 1, `new comment after write: ${id}: ${file}`);
  }
}
console.log('issue-331 snapshot editor: two nodes changed; both profiles roundtrip and match byte-for-byte');
