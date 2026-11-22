'use strict';
// Test-only preload: substitute parsed adapters on reads of the two shipped
// profiles, without writing either reserved file. Other reads are unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, PROFILES } = require('./daily-scheduler-harness');
const { adaptFlows } = require('../prepare-daily-scheduler-adapters');
const readFileSync = fs.readFileSync;
const prepared = new Map(PROFILES.map(profile => {
  const file = path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json');
  const source = readFileSync(file, 'utf8');
  if (JSON.stringify(JSON.parse(source), null, 2) + '\n' !== source) throw new Error('flow roundtrip drift: ' + file);
  return [file, Buffer.from(JSON.stringify(adaptFlows(JSON.parse(source)), null, 2) + '\n')];
}));
fs.readFileSync = function(file, options) {
  const resolved = typeof file === 'string' ? path.resolve(file) : file;
  if (!prepared.has(resolved)) return readFileSync.apply(this, arguments);
  const bytes = prepared.get(resolved);
  const encoding = typeof options === 'string' ? options : options && options.encoding;
  return encoding ? bytes.toString(encoding) : Buffer.from(bytes);
};
