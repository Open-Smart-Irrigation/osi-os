'use strict';
const { fixtureWrite, fixtureCopy } = require('./helpers/migration-fixture');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadMigrations } = require('../migrations-loader');

function dirWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-mig-'));
  for (const [name, body] of Object.entries(files)) fixtureWrite(path.join(d, name), body);
  return d;
}

test('loads, orders, classifies and checksums migrations', () => {
  const d = dirWith({
    '0002__add_col.sql': '-- risk: additive\nALTER TABLE t ADD COLUMN x INTEGER;\n',
    '0001__baseline.sql': '-- risk: additive\nCREATE TABLE t (id INTEGER);\n',
  });
  const m = loadMigrations(d);
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x) => x.version), [1, 2]);
  assert.equal(m[0].slug, 'baseline');
  assert.equal(m[1].risk, 'additive');
  assert.match(m[0].checksum, /^[0-9a-f]{64}$/);
});

test('rejects malformed filename', () => {
  const d = dirWith({ 'bad.sql': '-- risk: additive\n' });
  assert.throws(() => loadMigrations(d), /filename/i);
});

test('rejects duplicate version', () => {
  const d = dirWith({ '0001__a.sql': '-- risk: additive\n', '0001__b.sql': '-- risk: additive\n' });
  assert.throws(() => loadMigrations(d), /duplicate/i);
});

test('rejects missing risk header', () => {
  const d = dirWith({ '0001__a.sql': 'CREATE TABLE t (id INTEGER);\n' });
  assert.throws(() => loadMigrations(d), /risk/i);
});

test('checksums the raw migration bytes, not the decoded SQL text', () => {
  const raw = Buffer.concat([
    Buffer.from('-- risk: additive\n-- raw byte: '),
    Buffer.from([0xff]),
    Buffer.from('\nCREATE TABLE t (id INTEGER);\n'),
  ]);
  const d = dirWith({ '0001__raw.sql': raw });
  const [m] = loadMigrations(d);
  assert.equal(m.checksum, crypto.createHash('sha256').update(raw).digest('hex'));
});

test('rejects risk directives that are not in the file header', () => {
  const d = dirWith({
    '0001__late_risk.sql': 'CREATE TABLE t (id INTEGER);\n-- risk: additive\n',
  });
  assert.throws(() => loadMigrations(d), /risk/i);
});


test('corpus refuses symlinks, directories and FIFO without reading them', () => {
  const { execFileSync } = require('node:child_process');
  const { loadMigrationCorpus } = require('../migrations-loader');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi397-types-'));
  try {
    for (const kind of ['manifest-link', 'sql-link', 'directory', 'fifo', 'root-link']) {
      const dir = path.join(root, kind); fs.mkdirSync(dir);
      require('./helpers/migration-fixture').writeFixture(dir, { '0001__a.sql': '-- risk: additive\nCREATE TABLE a(id);\n' });
      let target = dir;
      if (kind === 'root-link') { target = dir + '-link'; fs.symlinkSync(dir, target); }
      else {
        const file = path.join(dir, kind === 'manifest-link' ? 'CHECKSUMS.json' : '0001__a.sql');
        if (kind.endsWith('-link')) { fs.renameSync(file, file + '.saved'); fs.symlinkSync(file + '.saved', file); }
        else { fs.unlinkSync(file); if (kind === 'directory') fs.mkdirSync(file); else execFileSync('mkfifo', [file]); }
      }
      execFileSync(process.execPath, ['-e', `const assert=require('node:assert/strict');assert.throws(()=>require(${JSON.stringify(require.resolve('../migrations-loader'))}).loadMigrationCorpus(${JSON.stringify(target)}),{code:'ERR_MIGRATION_CORPUS'});`], { timeout: 3000 });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
