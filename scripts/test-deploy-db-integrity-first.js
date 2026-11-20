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
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n(?=\\n|$)`, 'm').exec(DEPLOY);
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
  const firstChange = DEPLOY.indexOf('publish_boot_file "$swap_stage" /srv/node-red/.payload-swap.js 644');
  assert.ok(check > 0 && check < firstChange);
});

test('the hold consumers are installed before the recovery writer becomes callable', () => {
  const writer = DEPLOY.indexOf('fetch_required "Boot database integrity check"');
  assert.ok(writer > 0);
  for (const name of ['Node-RED init script', 'Outstanding first-boot database seed guard',
    'Outstanding first-boot runtime seed guard']) {
    const guard = DEPLOY.indexOf('fetch_required "' + name + '"');
    assert.ok(guard > 0 && guard < writer, name);
  }
});

for (const fail of ['download', 'integrity', 'file fsync', 'directory fsync', 'concurrent create', 'ok']) {
  test(`database seed publication handles ${fail} under a conditional call`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-seed-publish-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const existing = path.join(dir, 'existing.db');
    const source = path.join(dir, 'source.db');
    const db = path.join(dir, 'live', 'farming.db');
    assert.equal(spawnSync('sqlite3', [source, 'CREATE TABLE seed (n);']).status, 0);
    assert.equal(spawnSync('sqlite3', [existing, 'CREATE TABLE existing (n);']).status, 0);
    const injection = path.join(dir, 'inject-sync.cjs');
    const trace = path.join(dir, 'trace');
    fs.writeFileSync(injection, `
const fs = require('node:fs');
const sync = fs.fsyncSync;
let failed = false;
fs.fsyncSync = fd => {
  const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
  fs.appendFileSync(process.env.SEED_TRACE, kind + '\\n');
  if (!failed && process.env.SEED_FAULT === kind + ' fsync') {
    failed = true;
    throw new Error('injected ' + kind + ' failure');
  }
  return sync(fd);
};`);
    const run = spawnSync('sh', ['-c', `set -eu
DB_PATH="$1"
DB_DIR="$(dirname "$DB_PATH")"
SEED_DB_REL=release/seed.db
${fn('seed_db_if_missing')}
fetch() {
  case "$SEED_FAULT" in
    download) printf 'SQLite format 3' > "$2"; return 18 ;;
    integrity) printf 'SQLite format 3' > "$2"; return 0 ;;
    'concurrent create') cp "$PREVIOUS_DB" "$DB_PATH" ;;
  esac
  cp "$SEED_SOURCE" "$2"
}
seed_db_if_missing || exit 1
`, 'fixture', db], {
      encoding: 'utf8',
      env: { ...process.env, SEED_FAULT: fail, SEED_SOURCE: source, PREVIOUS_DB: existing,
        SEED_TRACE: trace, NODE_OPTIONS: '--require=' + injection },
    });
    const success = fail === 'ok' || fail === 'concurrent create';
    assert.equal(run.status, success ? 0 : 1, run.stdout + run.stderr);
    assert.equal(fs.existsSync(db), success);
    assert.deepEqual(fs.readdirSync(path.dirname(db)), success ? ['farming.db'] : []);
    if (fail === 'ok') {
      assert.equal(digest(db), digest(source));
      assert.equal(fs.readFileSync(trace, 'utf8'), 'file\ndirectory\n');
    } else if (fail === 'concurrent create') {
      assert.equal(digest(db), digest(existing));
    } else {
      assert.doesNotMatch(run.stdout, /OK: seeded/);
      assert.match(run.stderr, /could not fetch|failed integrity_check|could not publish/);
    }
  });
}

for (const [name, good, partial] of [
  ['package.json', '{"name":"before"}', '{"name":'],
  ['package-lock.json', '{"lockfileVersion":3}', '{"packages":'],
  ['edge-channels.json', '{"channels":[]}', '{"channels":'],
  ['codec.js', 'function decodeUplink() {}', 'function decodeUplink('],
]) {
  test(`an interrupted or invalid ${name} never touches the live file`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-runtime-publish-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const live = path.join(dir, name);
    fs.writeFileSync(live, good);
    for (const rc of [18, 0]) {
      const forbidden = spawnSync('sh', ['-c', `
${fn('publish_boot_file')}
${fn('fetch_required')}
fetch() { printf '%s' "$PARTIAL" > "$2"; return "$FAIL_STATUS"; }
fetch_required 'runtime' 'source/runtime' "$1" 644 || exit $?
`, 'fixture', live], {
        encoding: 'utf8', env: { ...process.env, PARTIAL: partial, FAIL_STATUS: String(rc) },
      });
      assert.notEqual(forbidden.status, 0);
      assert.match(forbidden.stderr, rc ? /could not fetch source\/runtime/ : /could not install source\/runtime/);
      assert.equal(fs.readFileSync(live, 'utf8'), good);
      assert.deepEqual(fs.readdirSync(dir), [name]);
    }
    const target = name === 'codec.js' ? '/srv/node-red/codecs/strega_gen1_decoder.js' : '/srv/node-red/' + name;
    assert.ok(DEPLOY.includes('"' + target + '" 644 || exit 1'), target);
  });
}
