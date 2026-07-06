const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

const flowProfiles = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

const expectedCatchNodes = {
  'record-error-catch-auth': 'auth-tab',
  'record-error-catch-device-api': 'device-api-tab',
  'record-error-catch-scheduler': 'c2b43a6c6e7d2c11',
  'record-error-catch-kiwi': '49e87447205bb849',
  'record-error-catch-strega': '8a18de184886c8a8',
  'record-error-catch-field-testing': 'a3f03829ad106e10',
  'record-error-catch-download': '7d4f3e45f4b0d111',
  'record-error-catch-cloud-sync': '93b1537a596e0e6d',
  'record-error-catch-lsn50': 'lsn50-tab',
  'record-error-catch-system-admin': 'sys-admin-tab',
  'record-error-catch-account-link': 'account-link-tab',
  'record-error-catch-dendro-analytics': 'dendro-analytics-tab',
  'record-error-catch-s2120': 's2120-tab',
  'record-error-catch-history-api': 'history-api-tab',
  'record-error-catch-lorain': 'lorain-tab',
};

function readFlow(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

for (const relativePath of flowProfiles) {
  test(`${relativePath} has shared error recording wired from DB/sync/decode catch nodes`, () => {
    const flow = readFlow(relativePath);
    const byId = new Map(flow.map((node) => [node.id, node]));
    const recordErrorNodes = flow.filter((node) => node.type === 'function' && node.name === 'Record Error');

    assert.strictEqual(recordErrorNodes.length, 1, 'expected exactly one Record Error function node');
    const recordError = recordErrorNodes[0];
    assert.strictEqual(recordError.id, 'record-error-fn');
    assert.deepStrictEqual(recordError.libs, []);
    assert.match(recordError.func, /global\.get\('error_counts'\)/);
    assert.match(recordError.func, /global\.set\('error_counts', counts\)/);
    assert.match(recordError.func, /flow\.get\('record_error_warned'\)/);
    assert.match(recordError.func, /node\.warn/);

    for (const [catchId, tabId] of Object.entries(expectedCatchNodes)) {
      const catchNode = byId.get(catchId);
      assert(catchNode, `${catchId} missing`);
      assert.strictEqual(catchNode.type, 'catch');
      assert.strictEqual(catchNode.z, tabId);
      assert.strictEqual(catchNode.scope, null);
      assert.deepStrictEqual(catchNode.wires, [['record-error-fn']]);
    }
  });
}
