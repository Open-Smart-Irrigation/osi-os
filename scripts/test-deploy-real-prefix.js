'use strict';
// #659 round 1: two defects the extracted-function harnesses could not show,
// because they reimplement the deploy's sequence. These tests run deploy.sh's
// own main sequence from its first line (scripts/lib/deploy-real-prefix.js).
// The kill matrix cannot show either: it reimplements the payload decisions
// and skips the preflight and the migration's compatibility branch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gateway, runPrefix } = require('./lib/deploy-real-prefix');

const CONFIG_REACHED = '# osi-server configuration end';
const AFTER_SETTINGS = 'fetch_required "Node-RED init script"';
const MB = 1024;

function backups(g, count, mb) {
  fs.mkdirSync(g.backups, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(g.backups, `farming.db.premigrate-2026110${i}T000000Z`), Buffer.alloc(mb * 1024 * 1024, i + 1));
  }
}

// B1: the early disk check credited every pre-migration copy, also the ones
// the prune keeps; it now credits only what the prune removes, and runs after
// staging, before the first configuration change.
test('B1: exactly the retained copies: refused before any change, the tree byte-identical', () => {
  const g = gateway({ layout: 'linked' });
  try {
    backups(g, 3, 20);
    g.setCapacityKb(g.usedKb() + 30 * MB);
    const before = g.manifest();
    const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED', { MIGRATE_MIN_FREE_MARGIN_MB: '40' });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /CONFIGURATION_REACHED/);
    assert.match(r.stderr, /insufficient disk for a safe schema migration .* plus 0KB in pre-migration copies the prune removes; refusing before any configuration is changed/);
    assert.deepEqual(g.manifest(), before, 'the gateway-side tree is byte-identical');
  } finally { g.cleanup(); }
});

test('B1: copies beyond the retained three supply the space: passes, and the late gate passes after the prune', () => {
  const g = gateway({ layout: 'linked' });
  try {
    backups(g, 5, 20);
    g.setCapacityKb(g.usedKb() + 30 * MB);
    const r = runPrefix(g, AFTER_SETTINGS, 'stage_command_ledger_dependency\nrun_schema_migration || exit $?\necho RAN', { MIGRATE_MIN_FREE_MARGIN_MB: '40' });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.match(out, /RAN/, out);
    assert.doesNotMatch(out, /insufficient disk/);
    assert.match(out, /--- Stop Node-RED for schema migration ---/);
    assert.equal(fs.readdirSync(g.backups).filter((f) => f.startsWith('farming.db.premigrate-2026110')).length, 3, 'the prune kept the newest three');
  } finally { g.cleanup(); }
});

test('B1: a retry whose stale stage holds the space reaches the cleanup and passes', () => {
  const g = gateway({ layout: 'linked' });
  try {
    const swap = require('./deploy-payload-swap');
    const src = path.join(g.root, 'stale-src');
    fs.mkdirSync(path.join(src, 'gui'), { recursive: true });
    fs.writeFileSync(path.join(src, 'flows.json'), Buffer.alloc(40 * 1024 * 1024, 7));
    fs.writeFileSync(path.join(src, 'gui/index.html'), 'stale\n');
    swap.stagePayload(g.srv, '20261110T000000Z', path.join(src, 'flows.json'), path.join(src, 'gui'), 'staged');
    fs.rmSync(src, { recursive: true, force: true });
    g.setCapacityKb(g.usedKb() + 30 * MB);
    const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED', { MIGRATE_MIN_FREE_MARGIN_MB: '40' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /CONFIGURATION_REACHED/);
    assert.ok(!fs.existsSync(path.join(g.srv, 'payloads/20261110T000000Z')), 'the stale stage was removed');
  } finally { g.cleanup(); }
});

// B2: on a gateway serving a regular flows.json and GUI directory the legacy
// capture was published before settings.js was fetched, and its schema record
// written only at the migration. A failed download left a capture the retry
// reused without a record, refusing after settings.js, every time.
function retryEndsInActivation(g) {
  const r = runPrefix(g, AFTER_SETTINGS, 'stage_command_ledger_dependency\nrun_schema_migration || exit $?\necho ACTIVATED $(swap_call currentStamp)');
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.doesNotMatch(out, /has no immutable schema compatibility metadata/);
  const active = /ACTIVATED (\S+)/.exec(out);
  assert.ok(active && !active[1].endsWith('-previous'), `the new payload is active: ${out.slice(-2000)}`);
  return out;
}

test('B2: a failed settings.js download, then the retry: the capture keeps its record and the retry activates', () => {
  const g = gateway({ layout: 'image' });
  try {
    const first = runPrefix(g, AFTER_SETTINGS, 'echo PREFIX_DONE', { FAIL_DEST: '/srv/node-red/settings.js' });
    assert.notEqual(first.status, 0);
    const capture = fs.readdirSync(path.join(g.srv, 'payloads')).find((p) => p.endsWith('-previous'));
    assert.ok(capture, 'the first attempt captured the served flows and GUI');
    assert.ok(fs.existsSync(path.join(g.srv, 'payloads', capture, 'compatibility.json')), 'with its schema record');
    assert.equal(fs.readFileSync(path.join(g.srv, 'settings.js'), 'utf8'), '// settings before the deploy\n');
    retryEndsInActivation(g);
  } finally { g.cleanup(); }
});

// A cut (SIGKILL) skips the exit handler: the stage and the module links
// into it stay, and the retry relinks them to its own stage.
const BEFORE_SETTINGS = 'fetch_required "Node-RED settings.js"';

test('B2: a cut just before the settings.js fetch, then the retry: it activates', () => {
  const g = gateway({ layout: 'image' });
  try {
    const first = runPrefix(g, BEFORE_SETTINGS, 'kill -9 $$');
    assert.equal(first.signal, 'SIGKILL');
    retryEndsInActivation(g);
  } finally { g.cleanup(); }
});

test('B2: the same cut, with the capture left without its record (an older deploy, or a cut before the record): completed, and the retry activates', () => {
  const g = gateway({ layout: 'image' });
  try {
    const first = runPrefix(g, BEFORE_SETTINGS, 'kill -9 $$');
    assert.equal(first.signal, 'SIGKILL');
    const capture = fs.readdirSync(path.join(g.srv, 'payloads')).find((p) => p.endsWith('-previous'));
    fs.rmSync(path.join(g.srv, 'payloads', capture, 'compatibility.json'), { force: true });
    const r = retryEndsInActivation(g);
    assert.match(r, /completing the schema record of the legacy capture/);
  } finally { g.cleanup(); }
});

test('B2: a capture without its record while a migration attempt is recorded: refused before anything is configured', () => {
  const g = gateway({ layout: 'image' });
  try {
    runPrefix(g, AFTER_SETTINGS, 'echo PREFIX_DONE', { FAIL_DEST: '/srv/node-red/settings.js' });
    const capture = fs.readdirSync(path.join(g.srv, 'payloads')).find((p) => p.endsWith('-previous'));
    fs.rmSync(path.join(g.srv, 'payloads', capture, 'compatibility.json'), { force: true });
    fs.writeFileSync(path.join(g.srv, 'payloads', capture, 'pending-switch.json'), '{"format":2}\n');
    const before = fs.readFileSync(path.join(g.srv, 'settings.js'), 'utf8');
    const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED');
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /has no schema record and a migration attempt is recorded; refusing before anything is changed/);
    assert.equal(fs.readFileSync(path.join(g.srv, 'settings.js'), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(g.srv, 'payloads', capture, 'compatibility.json')), 'an old capture is not blessed');
  } finally { g.cleanup(); }
});

// Round 2 (CTO ruling): the schema record is published durably, an invalid
// one counts as missing, and a capture without its record while a migration
// attempt is recorded is refused with the remedy in plain words.
function ledger(g) {
  return require('node:child_process').spawnSync('sqlite3', [g.db, "SELECT group_concat(version || ':' || checksum, ',') FROM (SELECT version, checksum FROM schema_migrations WHERE status='applied' ORDER BY version)"], { encoding: 'utf8' }).stdout.trim();
}

function orphanedCapture(g, fromLedger) {
  runPrefix(g, AFTER_SETTINGS, 'echo PREFIX_DONE', { FAIL_DEST: '/srv/node-red/settings.js' });
  const capture = fs.readdirSync(path.join(g.srv, 'payloads')).find((p) => p.endsWith('-previous'));
  fs.rmSync(path.join(g.srv, 'payloads', capture, 'compatibility.json'), { force: true });
  const pending = path.join(g.srv, 'payloads/20261115T000009Z/pending-switch.json');
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, `${JSON.stringify({ format: 2, payload_stamp: '20261115T000009Z', from_ledger: fromLedger })}\n`);
  return { capture, pending };
}

const REMEDY = /If that record's from_ledger equals the database's ledger \(sqlite3 -readonly \S+farming\.db "SELECT group_concat\(version \|\| ':' \|\| checksum, ','\) FROM \(SELECT version, checksum FROM schema_migrations WHERE status='applied' ORDER BY version\)"\), the database is untouched: remove that pending-switch\.json and run the deploy again, the same way\. If they differ, the database was migrated: keep the file and escalate\./;

for (const [when, migrated] of [['before the first migration commit', false], ['after a migration commit', true]]) {
  test(`round 2: a capture without its record and a pending record ${when}: refused with the remedy, the tree unchanged`, () => {
    const g = gateway({ layout: 'image' });
    try {
      const { pending } = orphanedCapture(g, migrated ? '1:not-this-database' : ledger(g));
      const before = g.manifest();
      const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED');
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.doesNotMatch(r.stdout, /CONFIGURATION_REACHED/);
      assert.ok(r.stderr.includes(`a migration attempt is recorded; refusing before anything is changed. The attempt's record: ${pending}.`), r.stderr);
      assert.match(r.stderr, REMEDY);
      assert.deepEqual(g.manifest(), before, 'the gateway-side tree is unchanged');
    } finally { g.cleanup(); }
  });
}

test('round 2: an empty schema record counts as missing: completed, and the retry activates', () => {
  const g = gateway({ layout: 'image' });
  try {
    const first = runPrefix(g, BEFORE_SETTINGS, 'kill -9 $$');
    assert.equal(first.signal, 'SIGKILL');
    const capture = fs.readdirSync(path.join(g.srv, 'payloads')).find((p) => p.endsWith('-previous'));
    const record = path.join(g.srv, 'payloads', capture, 'compatibility.json');
    fs.writeFileSync(record, '');
    const out = retryEndsInActivation(g);
    assert.match(out, /completing the schema record of the legacy capture/);
    assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).payload_stamp, capture);
  } finally { g.cleanup(); }
});

test('round 2: a stock gateway without a database reaches the configuration with no unset-variable line', () => {
  const g = gateway({ layout: 'stock', database: false });
  try {
    const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /CONFIGURATION_REACHED/);
    assert.doesNotMatch(r.stdout + r.stderr, /parameter not set|unbound variable/);
  } finally { g.cleanup(); }
});

// CodeRabbit r4577406811: a failed commit of the new osi-server configuration
// stops the deploy before settings.js. The tree is compared without
// etc/config/osi-server: the image's defaults script pre-creates that file
// before its uci batch (CGOS cannot create a package from scratch), and this
// uci stand-in writes each set at once, where uci stages it until the commit.
test('a failed commit of the osi-server configuration refuses before settings.js, the rest of the tree unchanged', () => {
  const g = gateway({ layout: 'linked', osiServer: false });
  try {
    const without = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'etc/config/osi-server'));
    const before = without(g.manifest());
    const r = runPrefix(g, AFTER_SETTINGS, 'echo SETTINGS_REACHED', { UCI_FAIL_COMMIT: '1' });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /SETTINGS_REACHED/);
    assert.match(r.stderr, /could not commit the osi-server configuration; refusing before settings\.js is replaced/);
    assert.equal(fs.readFileSync(path.join(g.srv, 'settings.js'), 'utf8'), '// settings before the deploy\n');
    assert.deepEqual(without(g.manifest()), before, 'the gateway-side tree is unchanged');
  } finally { g.cleanup(); }
});

// The migration runner's postflight foreign_key_check is global: one orphan
// anywhere fails it after the first committed migration, and the deploy
// restores the pre-migration copy and refuses, on every attempt. The
// preflight now runs the same check read-only, before the first change.
const sqlite = (db, sql) => require('node:child_process').spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });

test('foreign-key orphans: refused before any change, the tables and counts named, the tree byte-identical', () => {
  const g = gateway({ layout: 'linked' });
  try {
    const r0 = sqlite(g.db, "PRAGMA foreign_keys=OFF; INSERT INTO device_data(deveui, recorded_at) VALUES ('A840410000000001', '2026-01-01 00:00:00'), ('A840410000000001', '2026-01-01 00:10:00'); INSERT INTO dendro_baselines(deveui) VALUES ('A840410000000001');");
    assert.equal(r0.status, 0, r0.stderr);
    const before = g.manifest();
    const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED');
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /CONFIGURATION_REACHED/);
    assert.match(r.stderr, /ERROR: the farm database has foreign-key orphans in dendro_baselines \(1 row\), device_data \(2 rows\); the gateway is unchanged and keeps running its current release; do not retry; contact support with this line/);
    assert.doesNotMatch(r.stderr, /A840410000000001/, 'no row values');
    assert.deepEqual(g.manifest(), before, 'the gateway-side tree is byte-identical');
  } finally { g.cleanup(); }
});

test('foreign keys: a clean database passes the check', () => {
  const g = gateway({ layout: 'linked' });
  try {
    const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK: no foreign-key orphans in the farm database/);
    assert.match(r.stdout, /CONFIGURATION_REACHED/);
  } finally { g.cleanup(); }
});

test('foreign keys: a database without the tables that carry them passes', () => {
  const g = gateway({ layout: 'linked' });
  try {
    fs.rmSync(g.db);
    assert.equal(sqlite(g.db, 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES (1);').status, 0);
    const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK: no foreign-key orphans in the farm database/);
  } finally { g.cleanup(); }
});

test('foreign keys: a lock held for about a second while the check reads: it waits and passes', () => {
  const g = gateway({ layout: 'linked' });
  try {
    // A WAL reader is never made busy by a writer; with a rollback journal
    // another process's BEGIN EXCLUSIVE is.
    assert.equal(sqlite(g.db, 'PRAGMA journal_mode=DELETE;').stdout.trim(), 'delete');
    const real = require('node:child_process').spawnSync('sh', ['-c', 'command -v sqlite3'], { encoding: 'utf8' }).stdout.trim();
    const marker = path.join(g.root, 'fk.locked');
    const done = path.join(g.root, 'fk.done');
    fs.writeFileSync(path.join(g.bin, 'sqlite3'), `#!/bin/sh
case "$*" in *foreign_key_check*)
  if [ ! -e ${JSON.stringify(marker)} ]; then
    ( { echo 'BEGIN EXCLUSIVE;'; echo ".shell touch '${marker}'"; sleep 1; echo 'COMMIT;'; } | ${JSON.stringify(real)} ${JSON.stringify(g.db)}; touch ${JSON.stringify(done)} ) >/dev/null 2>&1 &
    while [ ! -e ${JSON.stringify(marker)} ]; do sleep 0.05; done
    date +%s%N > ${JSON.stringify(path.join(g.root, 'fk.start'))}
  fi ;;
esac
${JSON.stringify(real)} "$@"; rc=$?
case "$*" in *foreign_key_check*) date +%s%N > ${JSON.stringify(path.join(g.root, 'fk.end'))} ;; esac
exit $rc
`, { mode: 0o755 });
    const r = runPrefix(g, CONFIG_REACHED, 'echo CONFIGURATION_REACHED');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK: no foreign-key orphans in the farm database/);
    const waitedMs = (Number(fs.readFileSync(path.join(g.root, 'fk.end'), 'utf8')) - Number(fs.readFileSync(path.join(g.root, 'fk.start'), 'utf8'))) / 1e6;
    assert.ok(waitedMs >= 500, `the check waited for the lock (${waitedMs} ms)`);
  } finally { g.cleanup(); }
});
