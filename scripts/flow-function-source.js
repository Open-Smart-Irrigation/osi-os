'use strict';
// Source guards follow X1's delegated entry point. This reads the actual
// exported function, so moving a check out of flows cannot waive its assertion.
const assert = require('node:assert/strict');
const path = require('node:path');
function delegated(node, nodeRedRoot) {
  if (!String(node.func || '').includes("osiLib.require('daily-scheduler')")) return null;
  const call = node.func.match(/return scheduler\.value\.(\w+)\(msg, (\{[^\n;]+\})\);/);
  assert.ok(call, 'unrecognized daily-scheduler adapter: ' + node.id);
  const fn = require(path.join(nodeRedRoot, 'osi-daily-scheduler'))[call[1]];
  assert.equal(typeof fn, 'function', 'missing daily-scheduler entry: ' + call[1]);
  const api = require(path.join(nodeRedRoot, 'osi-daily-scheduler'));
  const preflight = { decodeToken: api.prepareDecodeToken, verifyZoneOwnership: api.prepareZoneOwnership, buildUpsert: api.prepareUpsert }[call[1]];
  return { fn, args: call[2].replace(', preflight', ''), source: [preflight && preflight.toString(), fn.toString()].filter(Boolean).join('\n') };
}
function functionSource(node, nodeRedRoot) {
  const entry = delegated(node, nodeRedRoot);
  return entry ? entry.source : String(node.func || '');
}
function inlineForMutation(node, nodeRedRoot) {
  const entry = delegated(node, nodeRedRoot);
  return entry ? { ...node, func: entry.source + '\nreturn ' + entry.fn.name + '(msg, ' + entry.args + ');' } : node;
}
module.exports = { functionSource, inlineForMutation };
