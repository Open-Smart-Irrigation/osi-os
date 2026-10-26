'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeFixture } = require('../lib/osi-migrate/__tests__/helpers/migration-fixture');
const { collectCorpusIdentities, computeFetchList } = require('./deploy-fetch-list');
const { vectors } = require('../lib/osi-migrate/__tests__/helpers/manifest-vectors');
const repo = path.resolve(__dirname, '..'),
  deploy = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
const sql = (t) => `-- risk: additive\nCREATE TABLE ${t}(id);\n`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi397-stage-'));
  fs.writeFileSync(path.join(root, 'deploy.sh'), deploy);
  for (const dir of [
    'database/migrations/ordered',
    'scripts/fixtures/lineages/agrolink',
    'scripts/fixtures/lineages/bovey',
  ]) {
    const p = path.join(root, dir);
    fs.mkdirSync(p, { recursive: true });
    writeFixture(p, { '0001__a.sql': sql('a'), '0003__c.sql': sql('c') });
  }
  fs.mkdirSync(path.join(root, 'lib/osi-migrate'), { recursive: true });
  for (const name of ['migration-manifest.js', 'migrations-loader.js'])
    fs.copyFileSync(path.join(repo, 'lib/osi-migrate', name), path.join(root, 'lib/osi-migrate', name));
  return root;
}
const guard = deploy.slice(
  deploy.indexOf('check_fetched_manifest() {'),
  deploy.indexOf('\n# Fails, naming the file')
);

test('deploy manifest mode shares parser vectors before returning names', () => {
  const root = fixture();
  try {
    const dir = path.join(root, 'database/migrations/ordered');
    for (const v of vectors) {
      fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), v.raw);
      const p = spawnSync(
        'sh',
        ['-c', guard + '\ncheck_fetched_manifest manifest "$1" test-label', 'sh', dir],
        { env: { ...process.env, TMP_DIR: root }, encoding: 'utf8' }
      );
      assert.equal(p.status, v.valid ? 0 : 1, v.name + ': ' + p.stderr);
      if (!v.valid) assert.equal(p.stdout, '');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source exact set and staged identity reject omitted and coherent replacements', () => {
  const root = fixture(),
    stage = path.join(root, 'stage');
  try {
    const original = collectCorpusIdentities(root);
    assert.ok(computeFetchList(root).includes('lib/osi-migrate/migration-manifest.js'));
    const dir = path.join(root, 'database/migrations/ordered');
    fs.writeFileSync(path.join(dir, '0004__extra.sql'), sql('extra'));
    assert.throws(() => computeFetchList(root), { code: 'ERR_MIGRATION_CORPUS' });
    fs.unlinkSync(path.join(dir, '0004__extra.sql'));
    fs.mkdirSync(stage);
    for (const p of ['deploy.sh', 'database', 'scripts', 'lib'])
      fs.cpSync(path.join(root, p), path.join(stage, p), { recursive: true });
    const expected = path.join(root, 'expected.json');
    fs.writeFileSync(expected, JSON.stringify(original));
    const cli = path.join(__dirname, 'deploy-fetch-list.js');
    let p = spawnSync(process.execPath, [cli, stage, '--verify-corpus-identities', expected], {
      encoding: 'utf8',
    });
    assert.equal(p.status, 0, p.stderr);
    writeFixture(path.join(stage, 'database/migrations/ordered'), { '0001__a.sql': sql('coherent_changed') });
    p = spawnSync(process.execPath, [cli, stage, '--verify-corpus-identities', expected], {
      encoding: 'utf8',
    });
    assert.equal(p.status, 1);
    assert.match(p.stderr, /differs from accepted source/);
    assert.equal(p.stdout, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
