'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
function expectedEntry(dir, name, checksum) {
  const file = path.join(dir, 'CHECKSUMS.json');
  const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  manifest[name] = checksum;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}
// Test-only: expected values come from explicit declared buffers, never a disk scan.
function fixtureWrite(file, body, ...options) {
  fs.writeFileSync(file, body, ...options);
  if (typeof file === 'string' && file.endsWith('.sql')) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, typeof options[0] === 'string' ? options[0] : 'utf8');
    expectedEntry(path.dirname(file), path.basename(file), crypto.createHash('sha256').update(raw).digest('hex'));
  }
}
function writeFixture(dir, files) {
  for (const [name, bytes] of Object.entries(files)) fixtureWrite(path.join(dir, name), bytes);
  return dir;
}
function fixtureCopy(source, dest, ...options) {
  if (typeof source !== 'string' || typeof dest !== 'string' || !source.endsWith('.sql') || !dest.endsWith('.sql')) return fs.copyFileSync(source, dest, ...options);
  const { loadMigrationCorpus, materializeMigrations } = require('../../migrations-loader');
  const corpus = loadMigrationCorpus(path.dirname(source));
  const entry = corpus.migrations.find((m) => m.name === path.basename(source));
  if (!entry) throw new Error('fixture source absent');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-fixture-select-'));
  try {
    const selected = path.join(root, 'selected');
    materializeMigrations(selected, [{ corpus, name: entry.name, asName: path.basename(dest) }]);
    fs.copyFileSync(path.join(selected, path.basename(dest)), dest, ...options);
    expectedEntry(path.dirname(dest), path.basename(dest), entry.checksum);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { writeFixture, fixtureWrite, fixtureCopy };
