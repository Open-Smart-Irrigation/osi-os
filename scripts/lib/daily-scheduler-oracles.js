'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const fixture = path.resolve(__dirname, '../fixtures/daily-scheduler');
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function verifyFrozen(sourceOnly = false) {
  const pins = require('../fixtures/daily-scheduler/oracle-pins.json');
  for (const [name, expected] of Object.entries(pins).filter(([name]) => !sourceOnly || name === 'legacy-nodes.json')) assert.equal(sha(fs.readFileSync(path.join(fixture, name))), expected, 'frozen oracle/source changed: ' + name);
  return pins;
}
function createExclusive(file, value) {
  verifyFrozen();
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
module.exports = { verifyFrozen, createExclusive, sha, fixture };
