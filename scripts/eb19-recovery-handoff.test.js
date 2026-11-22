'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const profile = '../conf/full_raspberrypi_bcm27xx_bcm2712/files';
const deploy = fs.readFileSync(path.join(__dirname, '../deploy.sh'), 'utf8');
const factorySeed = fs.readFileSync(path.join(__dirname, profile, 'etc/uci-defaults/97_osi_db_seed'), 'utf8');
const { runBootIntegrityCheck } = require(profile + '/usr/share/node-red/osi-db-integrity');

const markers = ['.legacy-device-fk-repair.lock', '.legacy-device-fk-writer-hold', '.osi-recovery'];
const sidecars = ['-wal', '-shm', '-journal'];
const receipt = {
  kind: 'legacy-device-fk',
  phase: 'disabled',
  services: [{ name: 'osi-identityd', enabled: true }, { name: 'node-red', enabled: true }],
};

function fn(name) {
  const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n(?=\\n|$)`, 'm').exec(deploy);
  assert.ok(match, `deploy.sh is missing ${name}()`);
  return match[0];
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-eb19-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbDir = path.join(dir, 'data', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  return { dir, dbDir, db: path.join(dbDir, 'farming.db'), seed: path.join(dir, 'seed.db') };
}

function shell(script, env) {
  const run = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  return run;
}

function deployEntry(f, name, extra = '', env = {}) {
  return shell(`set -eu
${['ensure_sqlite3_cli', 'check_live_db_readonly', name].map(fn).join('\n')}
${extra}
${name} || exit $?
`, { DB_PATH: f.db, DB_DIR: f.dbDir, SEED_DB_REL: 'fixture/seed.db', ...env });
}

function sqlite(db, input, cwd) {
  const result = spawnSync('sqlite3', ['-batch', '-bail', db], { input, cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function evidence(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { inode: stat.ino, link: fs.readlinkSync(file) };
  if (stat.isDirectory()) {
    return { inode: stat.ino, entries: Object.fromEntries(fs.readdirSync(file).sort().map(name =>
      [name, evidence(path.join(file, name))])) };
  }
  return { inode: stat.ino, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

function orphanWal(f) {
  // Copy the live WAL before the writer closes and automatically checkpoints.
  assert.equal(sqlite('writer.db', `
PRAGMA journal_mode=WAL;
PRAGMA wal_autocheckpoint=0;
CREATE TABLE witness (value TEXT);
PRAGMA wal_checkpoint(TRUNCATE);
INSERT INTO witness VALUES ('committed in WAL');
.shell cp writer.db probe.db
.shell cp writer.db-wal probe.db-wal
.shell cp writer.db-wal data/db/farming.db-wal
.shell cp writer.db-shm data/db/farming.db-shm
`, f.dir).split('\n')[0], 'wal');
  assert.equal(sqlite(path.join(f.dir, 'probe.db'), 'SELECT value FROM witness;'), 'committed in WAL');
}

for (const entry of ['run_schema_migration', 'schema_compatibility_metadata']) {
  test(`${entry} preserves an absent main and committed orphan WAL`, t => {
    const f = fixture(t);
    orphanWal(f);
    const before = evidence(f.dbDir);
    const run = deployEntry(f, entry);
    assert.doesNotMatch(run.stderr, /not found|parameter not set/);
    assert.deepEqual(evidence(f.dbDir), before, 'main stays absent and WAL/SHM stay byte-identical');
    if (entry === 'run_schema_migration') {
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, /sidecar|recovery evidence/i);
    }
  });
}

test('schema compatibility metadata accepts a present migration ledger', t => {
  const f = fixture(t);
  sqlite(f.db, `CREATE TABLE schema_migrations (version INTEGER, checksum TEXT, status TEXT);
INSERT INTO schema_migrations VALUES (1, 'abc', 'applied'), (2, 'def', 'applied');`);
  const run = deployEntry(f, 'schema_compatibility_metadata');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '2|1:abc,2:def');
});

for (const suffix of markers) {
  for (const dangling of [false, true]) {
    test(`boot integrity holds corrupt main and passing backup with ${dangling ? 'dangling' : 'physical'} ${suffix}`, async t => {
      const f = fixture(t);
      const backup = f.db + '.bak-2026-01-01T00-00-00-000Z';
      sqlite(backup, 'CREATE TABLE witness (value TEXT); INSERT INTO witness VALUES (1);');
      assert.equal(sqlite(backup, 'PRAGMA quick_check;'), 'ok');
      fs.writeFileSync(f.db, Buffer.alloc(8192, 0xff));
      const marker = f.db + suffix;
      if (dangling) fs.symlinkSync('missing-receipt', marker);
      else if (suffix === '.osi-recovery') {
        fs.mkdirSync(marker);
        fs.writeFileSync(path.join(marker, 'receipt.json'), JSON.stringify(receipt));
      } else fs.writeFileSync(marker, JSON.stringify(receipt));

      const before = evidence(f.dbDir);
      const result = await runBootIntegrityCheck(f.db);
      assert.equal(result.status, 'held');
      assert.deepEqual(evidence(f.dbDir), before);
    });
  }
}

function seedDuringStaging(f, entry, suffix, mode) {
  sqlite(f.seed, 'CREATE TABLE seed (value TEXT); INSERT INTO seed VALUES (1);');
  const injection = path.join(f.dir, 'stage.cjs');
  const witness = path.join(f.dir, 'staging-reached');
  // Insert evidence after syncing the staged file, before exclusive publication.
  fs.writeFileSync(injection, `
const fs = require('node:fs');
const path = require('node:path');
const sync = fs.fsyncSync;
fs.fsyncSync = function (fd) {
  sync(fd);
  if (!fs.fstatSync(fd).isFile() || fs.existsSync(process.env.STAGING_WITNESS)) return;
  const target = process.env.TARGET_DB;
  const stage = fs.readlinkSync('/proc/self/fd/' + fd);
  if (path.dirname(stage) !== path.dirname(target) || stage === target ||
      fs.lstatSync(target, { throwIfNoEntry: false }) ||
      !fs.readFileSync(stage).equals(fs.readFileSync(process.env.SEED_SOURCE))) {
    throw new Error('fixture did not reach a complete same-directory staging file with an absent target');
  }
  const file = target + process.env.EVIDENCE_SUFFIX;
  if (process.env.INJECT_MODE === 'dangling') fs.symlinkSync('missing-evidence', file);
  else if (process.env.EVIDENCE_SUFFIX === '.osi-recovery') {
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'receipt.json'), ${JSON.stringify(JSON.stringify(receipt))});
  } else fs.writeFileSync(file, 'staged evidence');
  fs.writeFileSync(process.env.STAGING_WITNESS, String(fs.lstatSync(file).ino));
};
`);
  const env = {
    NODE_OPTIONS: '--require=' + injection,
    STAGING_WITNESS: witness,
    SEED_SOURCE: f.seed,
    TARGET_DB: f.db,
    EVIDENCE_SUFFIX: suffix,
    INJECT_MODE: mode,
  };
  const relocatedFactorySeed = factorySeed
    .replace(/^SEED_SRC="\/usr\/share\/db\/farming\.db"$/m, 'SEED_SRC="$SEED_SOURCE"')
    .replace(/^DATA_DIR="\/data\/db"$/m, 'DATA_DIR="$FIXTURE_DB_DIR"');
  assert.match(relocatedFactorySeed, /^SEED_SRC="\$SEED_SOURCE"$/m);
  assert.match(relocatedFactorySeed, /^DATA_DIR="\$FIXTURE_DB_DIR"$/m);
  const run = entry === 'deploy'
    ? deployEntry(f, 'seed_db_if_missing', 'fetch() { cp "$SEED_SOURCE" "$2"; }', env)
    : shell(relocatedFactorySeed, { ...env, FIXTURE_DB_DIR: f.dbDir });
  assert.ok(fs.existsSync(witness), run.stdout + run.stderr);
  const file = f.db + suffix;
  assert.equal(String(fs.lstatSync(file).ino), fs.readFileSync(witness, 'utf8'));
  return run;
}

for (const entry of ['deploy', 'factory']) {
  for (const suffix of [...markers, ...sidecars]) {
    for (const mode of ['physical', 'dangling']) {
      test(`${entry} seed refuses a ${mode} ${suffix} appearing during staging`, t => {
        const f = fixture(t);
        const run = seedDuringStaging(f, entry, suffix, mode);
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.deepEqual(fs.readdirSync(f.dbDir), ['farming.db' + suffix]);
        const file = f.db + suffix;
        if (mode === 'dangling') assert.equal(fs.readlinkSync(file), 'missing-evidence');
        else if (suffix === '.osi-recovery') {
          assert.deepEqual(JSON.parse(fs.readFileSync(path.join(file, 'receipt.json'), 'utf8')), receipt);
        } else assert.equal(fs.readFileSync(file, 'utf8'), 'staged evidence');
      });
    }
  }

  test(`${entry} seed preserves an exclusive concurrent publication`, t => {
    const f = fixture(t);
    seedDuringStaging(f, entry, '', 'physical');
    assert.deepEqual(fs.readdirSync(f.dbDir), ['farming.db']);
    assert.equal(fs.readFileSync(f.db, 'utf8'), 'staged evidence');
  });
}

for (const suffix of markers) {
  test(`boot recovery defers when ${suffix} appears during restore staging`, async t => {
    const f = fixture(t);
    sqlite(f.db + '.bak-2026-01-01', 'CREATE TABLE retained(value); INSERT INTO retained VALUES(1);');
    fs.writeFileSync(f.db, Buffer.alloc(8192,0xff));
    const before = evidence(f.db);
    const copy = fs.copyFileSync;
    let injected = false;
    fs.copyFileSync = function(source,target,...rest) {
      const value = copy.call(this,source,target,...rest);
      if (String(target).includes('.integrity-restore-')) {
        const marker = f.db + suffix;
        if (suffix === '.osi-recovery') fs.unlinkSync(marker);
        fs.mkdirSync(marker);
        injected = true;
      }
      return value;
    };
    let result;
    try { result = await runBootIntegrityCheck(f.db); }
    finally { fs.copyFileSync = copy; }
    assert.equal(injected,true);
    assert.equal(result.status,'held');
    assert.deepEqual(evidence(f.db),before);
    assert.ok(fs.lstatSync(f.db+suffix).isDirectory());
    assert.equal(fs.readdirSync(f.dbDir).some(n=>n.includes('.corrupt-')),false);
  });
}
