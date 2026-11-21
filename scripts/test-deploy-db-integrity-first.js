'use strict';
// NEW-23 with #651's S7: deploy.sh checks the live database as it is, before
// it writes anything to it. check_live_db_readonly() runs in the preflight
// (before the first change on the gateway) and again at the start of
// checkpoint_live_db(), so a damaged database is refused without the
// checkpoint that would rewrite the file and remove its -wal. The fixture is
// a WAL database whose -wal holds committed rows, then damaged in its main
// file. After each refusal the file and its -wal are byte-identical. -shm is
// the WAL index (no data of its own); a read-only reader may create or
// rebuild it, so the comparison leaves it out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');

function fn(name) {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(DEPLOY);
  assert.ok(m, `deploy.sh is missing ${name}()`);
  return m[0];
}
const digest = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent');

// A WAL database whose -wal holds committed rows: copied while a writer with
// automatic checkpoints off still has it open.
function walDatabase(dir, damage) {
  const work = path.join(dir, 'work.db');
  const db = path.join(dir, 'farming.db');
  const sql = [
    'PRAGMA journal_mode=WAL;', 'PRAGMA wal_autocheckpoint=0;',
    'CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);',
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<400) INSERT INTO t(v) SELECT hex(randomblob(64)) FROM n;",
    'PRAGMA wal_checkpoint(PASSIVE);',
    "INSERT INTO t(v) VALUES ('in the wal');",
    `.shell cp ${work} ${db}`, `.shell cp ${work}-wal ${db}-wal`,
  ].join('\n');
  const run = spawnSync('sqlite3', [work], { input: `${sql}\n`, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.existsSync(`${db}-wal`), 'the fixture has a -wal');
  if (damage) {
    // Overwrite the second page (the table's b-tree) in the main file.
    const fd = fs.openSync(db, 'r+');
    try { fs.writeSync(fd, Buffer.alloc(512, 0x5a), 0, 512, 4096 + 16); } finally { fs.closeSync(fd); }
  }
  return db;
}

function run(db, body) {
  const script = `set -u
DB_PATH=${JSON.stringify(db)}
DAMAGED_DB_DOC="docs/operations/damaged-farm-database.md"
${fn('ensure_sqlite3_cli')}
${fn('check_live_db_readonly')}
${fn('checkpoint_live_db')}
${body}`;
  return spawnSync('sh', ['-c', script], { encoding: 'utf8' });
}

for (const [name, body] of [
  ['the preflight check', 'check_live_db_readonly'],
  ['the pre-migration checkpoint', 'checkpoint_live_db'],
]) {
  test(`${name} refuses a damaged database and leaves the file and its -wal byte-identical`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-db-first-'));
    try {
      const db = walDatabase(dir, true);
      const before = [digest(db), digest(`${db}-wal`)];
      const r = run(db, body);
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stderr, /Nothing was changed\. Copy the database with its -wal and -shm files before anything else, and follow docs\/operations\/damaged-farm-database\.md/);
      assert.deepEqual([digest(db), digest(`${db}-wal`)], before, 'farming.db and farming.db-wal unchanged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a healthy WAL database passes the check, and the checkpoint then folds its -wal in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-db-first-'));
  try {
    const db = walDatabase(dir, false);
    const before = [digest(db), digest(`${db}-wal`)];
    const check = run(db, 'check_live_db_readonly');
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual([digest(db), digest(`${db}-wal`)], before, 'the read-only check writes nothing');
    const cp = run(db, 'checkpoint_live_db');
    assert.equal(cp.status, 0, cp.stderr);
    const rows = spawnSync('sqlite3', [db, "SELECT count(*) FROM t WHERE v='in the wal'"], { encoding: 'utf8' });
    assert.equal(rows.stdout.trim(), '1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight check runs before the deploy\'s first change on the gateway', () => {
  const check = DEPLOY.indexOf('\ncheck_live_db_readonly || exit 1\n');
  const firstChange = DEPLOY.indexOf('publish_download "$TMP_DIR/osi-atomic-write.js" "/usr/share/node-red/osi-atomic-write.js"');
  assert.ok(check > 0 && check < firstChange);
});
