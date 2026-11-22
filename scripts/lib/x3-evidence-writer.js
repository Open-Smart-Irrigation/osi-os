'use strict';
const fs = require('node:fs');
function assertNewEvidencePath(file) {
  if (!file) return;
  try { fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const error = new Error('Evidence destination already exists: ' + file);
  error.code = 'EEXIST';
  throw error;
}
function writeEvidence(file, value) {
  if (file) fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
module.exports = { assertNewEvidencePath, writeEvidence };
