'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOWS = path.resolve(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

function loadClampFromNode() {
  const node = JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === '9b3afb405207302e');
  assert.ok(node, 'node 9b3afb405207302e (Build SQL INSERT) must exist');
  const m = node.func.match(/function clampRecordedAt[\s\S]*?\n}/);
  assert.ok(m, 'Build SQL INSERT must define clampRecordedAt (the ingest clamp)');
  return new Function(`${m[0]}; return clampRecordedAt;`)();
}

const NOW = Date.parse('2026-06-01T12:00:00Z');

test('a plausible device timestamp passes through unchanged', () => {
  const clamp = loadClampFromNode();
  const iso = '2026-05-30T09:00:00Z';
  const r = clamp(iso, NOW);
  assert.equal(r.clamped, false);
  assert.equal(r.recordedAt, iso);
});

test('a 1970/epoch timestamp is clamped to now and flagged', () => {
  const clamp = loadClampFromNode();
  const r = clamp('1970-01-01T00:00:00Z', NOW);
  assert.equal(r.clamped, true);
  assert.equal(r.recordedAt, new Date(NOW).toISOString());
});

test('a 2099 far-future timestamp (beyond now+1h) is clamped to now', () => {
  const clamp = loadClampFromNode();
  const r = clamp('2099-01-01T00:00:00Z', NOW);
  assert.equal(r.clamped, true);
  assert.equal(r.recordedAt, new Date(NOW).toISOString());
});

test('a timestamp just below the 2024-01-01 FLOOR is clamped', () => {
  const clamp = loadClampFromNode();
  const r = clamp('2023-12-31T23:59:59Z', NOW);
  assert.equal(r.clamped, true);
});

test('the FLOOR boundary (2024-01-01T00:00:00Z) is accepted', () => {
  const clamp = loadClampFromNode();
  const r = clamp('2024-01-01T00:00:00Z', NOW);
  assert.equal(r.clamped, false);
});

test('a timestamp within +1h skew is accepted; beyond +1h is clamped', () => {
  const clamp = loadClampFromNode();
  assert.equal(clamp(new Date(NOW + 59 * 60 * 1000).toISOString(), NOW).clamped, false);
  assert.equal(clamp(new Date(NOW + 61 * 60 * 1000).toISOString(), NOW).clamped, true);
});

test('an empty/missing timestamp falls back to now (not clamped, no crash)', () => {
  const clamp = loadClampFromNode();
  const r = clamp('', NOW);
  assert.equal(r.recordedAt, new Date(NOW).toISOString());
});

test('a garbage/unparseable timestamp is clamped to now', () => {
  const clamp = loadClampFromNode();
  const r = clamp('not-a-date', NOW);
  assert.equal(r.clamped, true);
  assert.equal(r.recordedAt, new Date(NOW).toISOString());
});
