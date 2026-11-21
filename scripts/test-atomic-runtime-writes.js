'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-atomic-write.js');
const helperRuntimePath = '/usr/share/node-red/osi-atomic-write.js';
const init = fs.readFileSync(path.join(root, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init'), 'utf8');
const deploy = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-atomic-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function watchWrites(t, fail, failOn = 1) {
  const events = [];
  const open = fs.openSync;
  const sync = fs.fsyncSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (flags === 'wx') events.push(['stage', path.dirname(file)]);
    return open(file, flags, ...args);
  });
  t.mock.method(fs, 'fsyncSync', fd => {
    const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
    events.push([kind]);
    if (fail === kind && --failOn === 0) throw new Error('injected fsync failure');
    return sync(fd);
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    events.push(['rename', to]);
    return rename(from, to);
  });
  return events;
}

test('the writer syncs and renames in the real directory and skips unchanged data', t => {
  const dir = fixture(t);
  const payload = path.join(dir, 'payload');
  fs.mkdirSync(payload);
  const target = path.join(payload, 'flows.json');
  const link = path.join(dir, 'flows.json');
  fs.writeFileSync(target, 'old', { mode: 0o640 });
  fs.symlinkSync('payload/flows.json', link);
  const events = watchWrites(t);
  const { writeAtomic } = require(helper);

  assert.equal(writeAtomic(link, 'new'), true);
  assert.deepEqual(events, [['stage', payload], ['file'], ['rename', target], ['directory']]);
  assert.equal(fs.readlinkSync(link), 'payload/flows.json');
  assert.equal(fs.readFileSync(link, 'utf8'), 'new');
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(payload), ['flows.json']);

  events.length = 0;
  assert.equal(writeAtomic(link, 'new'), false);
  assert.deepEqual(events, []);
});

for (const fail of ['file', 'directory']) {
  test(`a ${fail} fsync failure preserves old bytes and mode`, t => {
    const dir = fixture(t);
    const file = path.join(dir, 'target');
    fs.writeFileSync(file, 'old', { mode: 0o640 });
    watchWrites(t, fail);
    assert.throws(() => require(helper).writeAtomic(file, 'new', { mode: 0o600 }), /injected fsync failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(dir), ['target']);
  });
}

function runInitPatch(flow, cred) {
  const match = init.match(/node <<'NODE'\n(const fs = require\('fs'\);[\s\S]*?)\nNODE\n    fi/);
  assert.ok(match, 'MQTT patch heredoc is present in node-red.init');
  const errors = [];
  vm.runInNewContext(match[1], {
    require: name => require(name === helperRuntimePath ? helper : name),
    process: {
      env: {
        FLOW_FILE: flow, CRED_FILE: cred, CLOUD_BROKER_NODE_ID: 'cloud',
        DEVICE_EUI_VALUE: '0016C001F1000001', DEVICE_MQTT_PASSWORD_VALUE: 'fixture-password',
      },
    },
    console: { error: (...parts) => errors.push(parts.join(' ')) },
  });
  return errors;
}

for (const [fail, failOn] of [[undefined, 0], ['file', 1], ['directory', 1], ['file', 2], ['directory', 2]]) {
  test(`node-red.init writes both files atomically (${fail ? `sync failure on ${fail} ${failOn}` : 'success'})`, t => {
    const dir = fixture(t);
    const payload = path.join(dir, 'payload');
    fs.mkdirSync(payload);
    const target = path.join(payload, 'flows.json');
    const flow = path.join(dir, 'flows.json');
    const cred = path.join(dir, 'flows_cred.json');
    const oldFlows = '[{"id":"cloud","clientid":"old"}]\n';
    fs.writeFileSync(target, oldFlows, { mode: 0o640 });
    fs.symlinkSync('payload/flows.json', flow);
    fs.writeFileSync(cred, '{}', { mode: 0o644 });
    const events = watchWrites(t, fail, failOn);

    const errors = runInitPatch(flow, cred);
    assert.equal(fs.readlinkSync(flow), 'payload/flows.json');
    if (fail) {
      assert.match(errors.join('\n'), /injected fsync failure/);
      assert.equal(fs.readFileSync(flow, 'utf8'), oldFlows);
      if (failOn === 1) {
        assert.equal(fs.readFileSync(cred, 'utf8'), '{}');
        assert.equal(fs.statSync(cred).mode & 0o777, 0o644);
      } else {
        assert.equal(JSON.parse(fs.readFileSync(cred)).cloud.password, 'fixture-password');
        assert.equal(fs.statSync(cred).mode & 0o777, 0o600);
      }
      return;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(events, [
      ['stage', dir], ['file'], ['rename', cred], ['directory'],
      ['stage', payload], ['file'], ['rename', target], ['directory'],
    ]);
    assert.equal(JSON.parse(fs.readFileSync(flow))[0].clientid, 'device_0016C001F1000001');
    assert.equal(JSON.parse(fs.readFileSync(cred)).cloud.password, 'fixture-password');
    assert.equal(fs.statSync(flow).mode & 0o777, 0o640);
    assert.equal(fs.statSync(cred).mode & 0o777, 0o600);
    events.length = 0;
    assert.deepEqual(runInitPatch(flow, cred), []);
    assert.deepEqual(events, []);

    const sameCredentials = fs.readFileSync(cred);
    fs.chmodSync(cred, 0o644);
    assert.deepEqual(runInitPatch(flow, cred), []);
    assert.deepEqual(fs.readFileSync(cred), sameCredentials);
    assert.equal(fs.statSync(cred).mode & 0o777, 0o600);
    assert.deepEqual(events, [['stage', dir], ['file'], ['rename', cred], ['directory']]);
  });
}

const settingsPatch = fs.readFileSync(path.join(root, 'scripts/chirpstack-bootstrap.js'), 'utf8')
  .match(/function patchSettingsJs\(\) \{[\s\S]*?\n\}(?=\n\nfunction validatePortableFlows)/)[0];

test('bootstrap patches settings once and preserves its mode and previous bytes on sync failure', t => {
  const dir = fixture(t);
  const real = path.join(dir, 'settings-real.js');
  const file = path.join(dir, 'settings.js');
  const old = "'use strict';\nmodule.exports = {};\n";
  fs.writeFileSync(real, old, { mode: 0o640 });
  fs.symlinkSync('settings-real.js', file);
  const events = watchWrites(t, 'directory');
  const patch = () => vm.runInNewContext(settingsPatch + '\npatchSettingsJs()', {
    require: name => require(name === helperRuntimePath ? helper : name), fs, path,
    __dirname: path.join(root, 'scripts'), ENV_LOADER_MARKER: '// test loader',
    CFG: { settingsJs: file, envFile: path.join(dir, 'env') }, console: { log() {} },
  });
  assert.throws(patch, /injected fsync failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  patch();
  const patched = fs.readFileSync(file, 'utf8');
  assert.match(patched, /\/\/ test loader/);
  assert.equal(fs.readlinkSync(file), 'settings-real.js');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  events.length = 0;
  patch();
  assert.deepEqual(events, []);
});

function shellFunction(name) {
  const start = deploy.indexOf(`${name}() {\n`);
  assert.notEqual(start, -1, name);
  return deploy.slice(start, deploy.indexOf('\n}\n', start) + 3);
}

const calls = [...deploy.matchAll(/fetch_required "([^"]+)" \\\n\s+"([^"]+)" \\\n\s+"(\/(?:srv|etc|usr)\/[^"]+|\$IRRIGATION_CLOCK_HOOK)"(?: (\d+))?(?: "\$([A-Z0-9_]+_SHA256)")?/g)];
assert.equal(calls.length, 21, 'discovered the direct live deploy download sites');

function downloadPin(name) {
  if (!name) return '';
  const match = new RegExp(`^${name}="([0-9a-f]{64})"$`, 'm').exec(deploy);
  assert.ok(match, `missing deploy pin ${name}`);
  return match[1];
}
const stagedCalls = [
  ['payload swap helper', 'scripts/deploy-payload-swap.js', '$SWAP_JS', '/srv/node-red/.payload-swap.js'],
  ['atomic writer', path.relative(root, helper), '$TMP_DIR/osi-atomic-write.js', helperRuntimePath],
];
for (const [label, source, stage, dest] of stagedCalls) {
  assert.ok(deploy.includes(`fetch "${source}" "${stage}"`), `${label} download site`);
  assert.ok(deploy.includes(`publish_download "${stage}" "${dest}" 644`), `${label} publication site`);
  calls.push([null, label, source, dest, '644', undefined, stage]);
}

for (const [, label, source, dest, mode, pinName, stage] of calls) {
  test(`a cut during the ${label} download leaves the old file intact`, t => {
    const dir = fixture(t);
    const target = path.join(dir, 'live', path.basename(dest));
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'old complete bytes', { mode: 0o640 });
    fs.copyFileSync(helper, path.join(dir, 'osi-atomic-write.js'));
    const inode = fs.statSync(target).ino;
    const functions = ['fetch', 'publish_download', 'fetch_required'].map(shellFunction).join('\n');

    const command = stage
      ? `SWAP_JS="$TMP_DIR/deploy-payload-swap.js"
fetch "$2" "${stage}"
publish_download "${stage}" "$3" 644`
      : `fetch_required "$1" "$2" "$3" ${mode} "${downloadPin(pinName)}"`;
    const run = cut => spawnSync('sh', ['-c', `
set -eu
${functions}
curl() {
    if [ "$CUT" = 1 ]; then
        printf 'partial bytes' > "$2"
        kill -KILL "$$"
    fi
    cp "$SOURCE" "$2"
}
BASE=http://fixture.invalid
${command}
`, 'sh', label, source, target], {
      encoding: 'utf8',
      env: { ...process.env, CUT: cut, TMP_DIR: dir, SOURCE: path.resolve(root, source) },
    });

    const cut = run('1');
    assert.equal(cut.signal, 'SIGKILL', cut.stderr);
    assert.equal(fs.statSync(target).ino, inode);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old complete bytes');
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);

    const full = run('0');
    assert.equal(full.status, 0, full.stderr);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.resolve(root, source)));
    assert.equal(fs.statSync(target).mode & 0o777, mode === '755' ? 0o755 : 0o640);
    const published = fs.statSync(target).ino;
    assert.notEqual(published, inode);
    assert.equal(run('0').status, 0);
    assert.equal(fs.statSync(target).ino, published);
  });
}


const invalidBodies = [
  ['package.json', '{"dependencies":', 'invalid JSON'],
  ['package-lock.json', '{"lockfileVersion":3,"packages":', 'invalid JSON'],
  ['edge-channels.json', '[{"key":', 'invalid JSON'],
  ['edge-channels.json', '{}', 'unexpected JSON shape'],
  ['settings.js', '<!doctype html><h1>Bad response</h1>', 'expected settings entry point'],
  ['settings.js', 'module.exports = {\n  flowFile: "flows.json",\n', 'invalid JavaScript syntax'],
  ['chirpstack-bootstrap.js', '/* a complete JS comment, with no executable code */\n', 'expected bootstrap entry point'],
  ['strega_gen1_decoder.js', 'const unrelated = 1;\n', 'expected codec entry point'],
  ['agroscope_uplink_transform.js', 'function decodeUplink(input) { return input; }\n', 'expected Agroscope transform entry point'],
  ['node-red', 'echo "missing shebang"\n', 'expected a shell shebang and script body'],
  ['node-red', init.split('\n').slice(0, 7).join('\n') + '\n', 'SHA-256 pin mismatch'],
  ['osi-bootstrap', '#!/bin/sh /etc/rc.common\nif then\n', 'invalid shell syntax'],
];

for (const [name, badBody, message] of invalidBodies) {
  test(`a successful HTTP response with invalid ${name} is refused (${message})`, t => {
    const dir = fixture(t);
    const file = path.join(dir, 'live', name);
    fs.mkdirSync(path.dirname(file));
    const response = path.join(dir, 'body');
    const restart = path.join(dir, 'restart-marker');
    const old = name === 'node-red' ? init : 'old complete file';
    fs.writeFileSync(file, old, { mode: 0o640 });
    fs.writeFileSync(response, badBody);
    fs.copyFileSync(helper, path.join(dir, 'osi-atomic-write.js'));
    const inode = fs.statSync(file).ino;
    const functions = ['fetch', 'publish_download', 'fetch_required'].map(shellFunction).join('\n');
    const call = calls.find(([, , , target]) => path.basename(target) === name);
    assert.ok(call, `no download for ${name}`);
    const [, label, source, , mode, pinName] = call;
    const result = spawnSync('sh', ['-c', `
set -eu
${functions}
BASE=http://fixture.invalid
curl() { cp "$RESPONSE" "$2"; }
fetch_required "$1" "$2" "$3" "$4" "$5" || exit 1
: > "$RESTART"
`, 'sh', label, source, file, mode, downloadPin(pinName)], {
      encoding: 'utf8', env: { ...process.env, TMP_DIR: dir, RESPONSE: response, RESTART: restart },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(fs.existsSync(restart), false, 'restart marker must remain untouched');
    assert.equal(fs.statSync(file).ino, inode);
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  });
}

const helperStageStart = deploy.indexOf('echo "--- Deploy payload swap helper ---"');
const helperStageEnd = deploy.indexOf('# legacy capture preflight begin', helperStageStart);
assert.ok(helperStageStart !== -1 && helperStageEnd > helperStageStart);

for (const [file, body] of [
  ['osi-atomic-write.js', ''],
  ['osi-atomic-write.js', "'use strict';\nconst fs = require('node:fs');\n"],
  ['deploy-payload-swap.js', "'use strict';\nmodule.exports = {};\n"],
]) {
  test(`an invalid ${file} is rejected before helper execution (${body.length} bytes)`, t => {
    const dir = fixture(t);
    const liveWriter = path.join(dir, 'writer-live.js');
    const liveSwap = path.join(dir, 'swap-live.js');
    fs.writeFileSync(liveWriter, 'old writer');
    fs.writeFileSync(liveSwap, 'old swap');
    fs.writeFileSync(path.join(dir, 'bad-helper'), body);
    const trace = path.join(dir, 'trace');
    const functions = ['fetch', 'file_sha256', 'publish_download'].map(shellFunction);
    if (deploy.includes('verify_download_pin() {')) functions.push(shellFunction('verify_download_pin'));
    const pins = deploy.match(/^(?:ATOMIC_WRITER|PAYLOAD_SWAP)_SHA256="[0-9a-f]{64}"$/gm) ?? [];
    const stage = deploy.slice(helperStageStart, helperStageEnd)
      .replace(`"${helperRuntimePath}"`, JSON.stringify(liveWriter))
      .replace('"/srv/node-red/.payload-swap.js"', JSON.stringify(liveSwap));
    const result = spawnSync('sh', ['-c', `
set -eu
${functions.join('\n')}
${pins.join('\n')}
BASE=http://fixture.invalid
SWAP_JS="$TMP_DIR/deploy-payload-swap.js"
PAYLOADS_ROOT="$TMP_DIR"
same_fs_or_die() { :; }
check_live_db_readonly() { :; }
gateway_state_preflight() { printf 'preflight\n' >> "$TRACE"; }
curl() {
    case "$3" in
        */"$BAD_NAME") cp "$TMP_DIR/bad-helper" "$2" ;;
        */osi-atomic-write.js) cp "$WRITER_SRC" "$2" ;;
        */deploy-payload-swap.js) cp "$SWAP_SRC" "$2" ;;
        *) return 1 ;;
    esac
}
node() {
    case "$1" in
        "$TMP_DIR/osi-atomic-write.js") printf 'invoke writer\n' >> "$TRACE" ;;
    esac
    command node "$@"
}
${stage}
printf 'would proceed\n'
`], {
      encoding: 'utf8',
      env: {
        ...process.env, TMP_DIR: dir, TRACE: trace, BAD_NAME: file, WRITER_SRC: helper,
        SWAP_SRC: path.join(root, 'scripts/deploy-payload-swap.js'),
      },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes('SHA-256'), result.stderr);
    assert.ok(result.stderr.includes(file), result.stderr);
    assert.doesNotMatch(result.stdout, /would proceed/);
    const events = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
    assert.doesNotMatch(events, /invoke writer/);
    if (file === 'deploy-payload-swap.js') assert.equal(events, '', 'pin is checked before swap-aware preflight');
    assert.equal(fs.readFileSync(liveWriter, 'utf8'), 'old writer');
    assert.equal(fs.readFileSync(liveSwap, 'utf8'), 'old swap');
  });
}
