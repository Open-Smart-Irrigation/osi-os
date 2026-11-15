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
    const r = runPrefix(g, AFTER_SETTINGS, 'stage_command_ledger_dependency\nrun_schema_migration || echo "MIGRATION_RC=$?"\necho RAN', { MIGRATE_MIN_FREE_MARGIN_MB: '40' });
    const out = r.stdout + r.stderr;
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
