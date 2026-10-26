'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { loadMigrationCorpus, materializeMigrations } = require('../../lib/osi-migrate/migrations-loader');
const repo = path.resolve(__dirname, '../..');
const oldDefault = 'chameleon_enabled                     INTEGER DEFAULT 0,',
  changedDefault = 'chameleon_enabled                     INTEGER DEFAULT 1,';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi397-generator-'));
  fs.cpSync(path.join(repo, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/ops'), { recursive: true });
  for (const name of ['semantic-schema-compare.js'])
    fs.copyFileSync(path.join(repo, 'scripts', name), path.join(root, 'scripts', name));
  fs.copyFileSync(
    path.join(__dirname, 'generate-uganda-schema-rebuild-20260911.js'),
    path.join(root, 'scripts/ops/generate-uganda-schema-rebuild-20260911.js')
  );
  const dir = path.join(root, 'database/migrations/ordered');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const parent = loadMigrationCorpus(path.join(repo, 'database/migrations/ordered'));
  materializeMigrations(dir, [{ corpus: parent, name: '0001__baseline.sql' }]);
  const file = path.join(dir, '0001__baseline.sql'),
    raw = fs.readFileSync(file);
  assert.ok(raw.toString().includes(oldDefault));
  const G = require(path.join(root, 'scripts/ops/generate-uganda-schema-rebuild-20260911'));
  const L = require(path.join(root, 'lib/osi-migrate/migrations-loader'));
  return { root, dir, file, raw, G, L };
}

test('generator rejects prevalidation bytes even if a legacy path-read hook restores source', async () => {
  const { root, file, raw, G, L, dir } = fixture();
  const read = fs.readFileSync;
  try {
    await G.generate();
    const stable = fs.readFileSync(G.ARTIFACT_PATH);
    assert.ok(stable.toString().includes(oldDefault));
    fs.writeFileSync(file, raw.toString().replace(oldDefault, changedDefault));
    assert.throws(() => L.loadMigrationCorpus(dir), { code: 'ERR_MIGRATION_CORPUS' });
    let hooked = false;
    fs.readFileSync = function (...args) {
      const bytes = read.apply(this, args);
      if (args[0] === file && args[1] === 'utf8') {
        hooked = true;
        fs.writeFileSync(file, raw);
      }
      return bytes;
    };
    await assert.rejects(() => G.generate(), { code: 'ERR_MIGRATION_CORPUS' });
    assert.equal(hooked, false, 'extraction must never reopen SOURCE_MIGRATION');
    assert.deepEqual(read(G.ARTIFACT_PATH), stable);
  } finally {
    fs.readFileSync = read;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generate and repeated verification references retain the accepted source', async () => {
  const { root, file, raw, G, L, dir } = fixture();
  const mk = fs.mkdtempSync;
  try {
    let changed = false;
    fs.mkdtempSync = function (...args) {
      const p = mk.apply(this, args);
      if (!changed && String(args[0]).includes('uganda-rebuild-gen-')) {
        changed = true;
        fs.writeFileSync(file, raw.toString().replace(oldDefault, changedDefault));
      }
      return p;
    };
    await G.generate();
    assert.equal(changed, true);
    assert.ok(fs.readFileSync(G.ARTIFACT_PATH, 'utf8').includes(oldDefault));
    assert.throws(() => L.loadMigrationCorpus(dir), { code: 'ERR_MIGRATION_CORPUS' });
    fs.mkdtempSync = mk;
    fs.writeFileSync(file, raw);
    const corpus = L.loadMigrationCorpus(dir),
      db = path.join(root, 'valid.db');
    await require(path.join(root, 'lib/osi-migrate')).bootstrapFresh(
      require(path.join(root, 'lib/osi-migrate/runner-iface')).cliRunner(db),
      { migrationsDir: dir, corpus, appVersion: 'generator-test' }
    );
    let switched = false;
    fs.mkdtempSync = function (...args) {
      const p = mk.apply(this, args);
      if (!switched && String(args[0]).includes('uganda-rebuild-cmp-')) {
        switched = true;
        fs.writeFileSync(file, raw.toString().replace(oldDefault, changedDefault));
      }
      return p;
    };
    assert.equal(await G.verify(db, () => {}), true);
    assert.equal(switched, true);
    fs.mkdtempSync = mk;
    fs.writeFileSync(file, raw);
    assert.deepEqual((await G.preflightDriftSignature(db, () => {})).scoped, []);
    await G.dryRun(db, () => {});
    assert.deepEqual(await G.apply(db, () => {}), { ran: [] });
  } finally {
    fs.mkdtempSync = mk;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
