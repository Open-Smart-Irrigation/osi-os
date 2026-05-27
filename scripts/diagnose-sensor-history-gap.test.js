const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { compareHistories } = require('./diagnose-sensor-history-gap');

const fixtures = path.join(__dirname, 'fixtures', 'sensor-history-diagnostic');

test('flags rows present on edge but missing on cloud', () => {
  const result = compareHistories({
    edgePath: path.join(fixtures, 'edge.json'),
    cloudPath: path.join(fixtures, 'cloud.json'),
    rangeStart: '2026-05-27T08:00:00.000Z',
    rangeEnd: '2026-05-27T12:00:00.000Z'
  });

  assert.equal(result.edgeCount, 3);
  assert.equal(result.cloudCount, 2);
  assert.equal(result.missingOnCloud.length, 1);
  assert.equal(result.missingOnCloud[0].deveui, 'A84041FFFF000001');
  assert.equal(result.missingOnCloud[0].recordedAt, '2026-05-27T09:00:00.000Z');
});
