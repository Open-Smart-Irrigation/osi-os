'use strict';

const { after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createTestScratch(prefix) {
  const roots = new Set();
  after(() => {
    const failures = [];
    for (const root of roots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'test scratch cleanup failed');
  });
  return function scratch() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      roots.add(root);
    } catch (error) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
      throw error;
    }
    return root;
  };
}

module.exports = { createTestScratch };
