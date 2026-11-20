'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanFunctionNodes } = require('./flows-bare-require-scan');

const root = path.join(__dirname, '..');
const profiles = ['bcm2712', 'bcm2709', 'bcm2708'];
const flowPaths = profiles.map(profile =>
  `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
const patch = path.join(__dirname, 'fixtures/sdi12-archive-retention-flows.patch');
const serialize = flows => JSON.stringify(flows, null, 2) + '\n';

function overlay(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sdi12-flows-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // Copy flow inputs and the guards that find them relative to __dirname.
  // Link shared inputs that the guards only read.
  for (const relative of flowPaths) {
    const target = path.join(scratch, relative);
    const share = path.dirname(target);
    fs.mkdirSync(share, { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
    fs.symlinkSync(path.join(root, path.dirname(relative), 'node-red'), path.join(share, 'node-red'));
  }
  fs.mkdirSync(path.join(scratch, 'scripts'));
  for (const filename of [
    'verify-no-new-silent-catch.js', 'test-flows-wiring.js', 'test-sdi12-recipe-flow.js',
    'test-journal-bootstrap.js', 'test-strega-gen2-reconcile.js',
  ]) {
    fs.copyFileSync(path.join(__dirname, filename), path.join(scratch, 'scripts', filename));
  }
  for (const relative of [
    'database', 'deploy.sh', 'scripts/fixtures', 'scripts/lib', 'scripts/osi-lib-binding-audit.js',
  ]) {
    fs.symlinkSync(path.join(root, relative), path.join(scratch, relative));
  }
  execFileSync('git', ['apply', patch], { cwd: scratch });
  return scratch;
}

test('the staged patch is mirrored and taps only the independent SDI-12 timer', async t => {
  const scratch = overlay(t);
  const [pi5, pi2] = flowPaths.map(relative => fs.readFileSync(path.join(scratch, relative), 'utf8'));
  assert.equal(pi5, pi2);
  const flows = JSON.parse(pi5);
  assert.equal(serialize(flows), pi5);
  const original = JSON.parse(fs.readFileSync(path.join(root, flowPaths[0]), 'utf8'));
  const handlerId = 'sdi12-archive-retention-fn';
  const timerId = 'sdi12-archive-retention-tick';
  const pollId = 'sdi12-recipe-poll-fn';
  assert.deepEqual(flows.filter(n => ![handlerId, timerId, pollId].includes(n.id)),
    original.filter(n => n.id !== pollId), 'boot DDL, uplink wiring and all other nodes stay byte-for-byte');
  const timer = flows.find(n => n.id === timerId);
  const handler = flows.find(n => n.id === handlerId);
  assert.equal(timer.type, 'inject');
  assert.equal(timer.repeat, '60');
  assert.equal(timer.once, true);
  assert.deepEqual(timer.wires, [[handlerId]]);
  assert.equal(handler.z, timer.z);
  assert.equal(handler.type, 'function');
  assert.equal(handler.outputs, 0);
  assert.deepEqual(handler.libs, [{ var: 'osiLib', module: 'osi-lib' }]);
  assert.deepEqual(handler.wires, []);
  assert.deepEqual(scanFunctionNodes(flows), []);

  const run = new Function('msg', 'node', 'osiLib', handler.func);
  const msg = {};
  const errors = [];
  let runs = 0;
  const node = { error(message) { errors.push(message); } };
  const loader = {
    require(name) {
      assert.equal(name, 'sdi12-archive');
      return { ok: true, value: { liveMaintain(scope) {
        assert.deepEqual(scope, { node, osiLib: loader });
        runs++;
        return Promise.resolve(null);
      } } };
    },
  };
  assert.equal(await run(msg, node, loader), null);
  assert.equal(runs, 1);
  assert.equal(run(msg, node, { require: () => ({ ok: false, error: 'unavailable' }) }), null);
  assert.match(errors[0], /retention unavailable/);

  function check(script, ...args) {
    const env = { ...process.env };
    // Child tests should write text, even when this test runs in node --test.
    delete env.NODE_TEST_CONTEXT;
    const result = execFileSync(process.execPath, [script, ...args], { cwd: scratch, encoding: 'utf8', env });
    t.diagnostic(result.trim().split('\n').at(-1));
  }
  check(path.join(root, 'scripts/verify-flows-size-ratchet.js'), '--root', scratch, '--git-root', root);
  check(path.join(root, 'scripts/verify-no-stray-ddl.js'), '--root', scratch, '--git-root', root);
  check(path.join(root, 'scripts/verify-flows-fn-parse.js'),
    ...flowPaths.flatMap(relative => ['--flows', relative]));
  check('scripts/verify-no-new-silent-catch.js');
  check('scripts/test-flows-wiring.js');
  check('--test-name-pattern=recipe poller', 'scripts/test-sdi12-recipe-flow.js');
});
