'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const originals = require('../fixtures/daily-scheduler/legacy-nodes.json');
const descriptors = require('../fixtures/daily-scheduler/adapters.json');
const preflight = require('../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-daily-scheduler/preflight');

// One authored preflight implementation lives in the module. Its exact source
// is projected ahead of the loader so outages cannot replace early replies.
function buildAdapters() {
  return descriptors.map(node => {
    const copy = structuredClone(node);
    const name = { decodeToken: 'prepareDecodeToken', verifyZoneOwnership: 'prepareZoneOwnership', buildUpsert: 'prepareUpsert' }[node.entry];
    if (!name) return copy;
    const deps = node.entry === 'decodeToken' ? 'env, node, osiLib, crypto, osiDb, global, Date' : 'env, node, osiLib, Date';
    copy.func = (node.entry === 'decodeToken' ? 'return (async () => {\n' : '') +
      preflight[name].toString() + '\nconst preflight = ' + name + '(msg, { ' + deps + ' });\n' +
      'if (Array.isArray(preflight)) return preflight;\n' +
      "const scheduler = osiLib.require('daily-scheduler');\n" +
      "if (!scheduler.ok) { node.warn('daily-scheduler unavailable: ' + scheduler.error); msg.statusCode = 503; msg.payload = { message: 'Daily scheduler unavailable' }; return [null, msg]; }\n" +
      'return scheduler.value.' + node.entry + '(msg, { ' + deps + ', preflight });\n' +
      (node.entry === 'decodeToken' ? '})();' : '');
    return copy;
  });
}
function flowState(flows) {
  const states = descriptors.map(adapter => {
    const node = flows.find(n => n.id === adapter.id);
    assert.ok(node, 'missing extraction node ' + adapter.id);
    if (node.func === adapter.func) return 'integrated';
    assert.equal(node.func, originals.find(n => n.id === adapter.id).func, 'unrecognized extraction source');
    return 'legacy';
  });
  assert.equal(new Set(states).size, 1, 'all six extraction nodes must have the same integration state');
  return states[0];
}
function restoreLegacy(flows) {
  const result = structuredClone(flows);
  for (const original of originals) {
    const node = result.find(n => n.id === original.id);
    node.func = original.func;
    node.libs = structuredClone(original.libs);
  }
  return result;
}
module.exports = { buildAdapters, flowState, restoreLegacy };
