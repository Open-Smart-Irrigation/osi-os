'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FLOWS = path.resolve(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');

function loadSameWindowFromNode() {
  const node = JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === '5f0d2b7e9b9b1b3a');
  assert.ok(node, 'node 5f0d2b7e9b9b1b3a (Decide + build actuator cmd) must exist');
  const m = node.func.match(/function sameLogicalWindow[\s\S]*?\n}/);
  assert.ok(m, 'decision node must define sameLogicalWindow (the backward-jump debounce)');
  return new Function(`${m[0]}; return sameLogicalWindow;`)();
}

const WINDOW = Date.parse('2026-05-10T06:05:00Z');
const DAY = 24 * 3600 * 1000;

test('a last_triggered_at earlier today is the SAME logical window (backward-jump debounce fires)', () => {
  const same = loadSameWindowFromNode();
  assert.equal(same(WINDOW, '2026-05-10T06:00:30Z'), true);
});

test('a last_triggered_at yesterday is a DIFFERENT window (normal daily fire preserved)', () => {
  const same = loadSameWindowFromNode();
  assert.equal(same(WINDOW, new Date(WINDOW - DAY).toISOString()), false);
});

test('a null/absent last_triggered_at is not the same window (first-ever fire allowed)', () => {
  const same = loadSameWindowFromNode();
  assert.equal(same(WINDOW, null), false);
  assert.equal(same(WINDOW, ''), false);
});

test('the guard string clock_jump_backward_suppressed is present in the node (skip+log path exists)', () => {
  const node = JSON.parse(fs.readFileSync(FLOWS, 'utf8')).find((n) => n.id === '5f0d2b7e9b9b1b3a');
  assert.match(node.func, /clock_jump_backward_suppressed/);
});
