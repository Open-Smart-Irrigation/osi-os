'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const initPath = path.resolve(__dirname,
  '../feeds/chirpstack-openwrt-feed/chirpstack/chirpstack/files/chirpstack.init');
const source = fs.readFileSync(initPath, 'utf8');

test('ChirpStack captures both streams inside its procd instance', () => {
  const start = source.match(/^start_service\(\) \{\n([\s\S]*?)^\}/m);
  assert.ok(start, 'start_service exists');
  const instance = start[1].match(/^\s*procd_open_instance\s*\n([\s\S]*?)^\s*procd_close_instance\s*$/m);
  assert.ok(instance, 'start_service opens and closes its procd instance');
  for (const stream of ['stdout', 'stderr']) {
    assert.match(instance[1], new RegExp(`^\\s*procd_set_param ${stream} 1\\s*$`, 'm'));
  }
});

test('generated configuration keeps warnings and errors, with capture active at start', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chirpstack-log-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = path.join(root, 'chirpstack.init');
  // Redirect only filesystem paths; execute the shipped functions and heredocs.
  // This does not run ChirpStack or prove delivery through a live procd/logd.
  fs.writeFileSync(init, source.replace(/\/(var\/etc|srv|etc)\//g, `${root}/$1/`));
  fs.mkdirSync(path.join(root, 'etc/chirpstack'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/chirpstack/region_eu868.toml'), '# region fixture\n');
  const result = spawnSync('/bin/sh', ['-eu', '-c', `
    config_load() { [ "$1" = chirpstack ]; }
    config_foreach() { "$1" network; }
    config_get() { net_id=000000; }
    config_list_foreach() { "$3" eu868; }
    procd_open_instance() { instance_open=1; }
    procd_set_param() {
      [ "$instance_open" = 1 ]
      printf 'param %s\\n' "$*"
    }
    procd_close_instance() { instance_open=0; }
    . "$1"
    start_service
    [ "$instance_open" = 0 ]
  `, 'test', init], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const params = result.stdout.trim().split('\n');
  assert.ok(params.includes('param stdout 1'), result.stdout);
  assert.ok(params.includes('param stderr 1'), result.stdout);
  assert.ok(params.includes(`param command /usr/bin/chirpstack -c ${root}/var/etc/chirpstack`));
  assert.ok(params.includes('param respawn 3600 5 -1'));
  const toml = fs.readFileSync(path.join(root, 'var/etc/chirpstack/chirpstack.toml'), 'utf8');
  const logging = toml.split(/(?=^\[)/m).find((section) => section.startsWith('[logging]\n'));
  assert.ok(logging, 'generated TOML declares logging');
  assert.match(logging, /^level="warn"\s*$/m);
  assert.match(toml, /^enabled_regions=\["eu868",\]$/m);
  assert.equal(fs.readFileSync(path.join(root, 'var/etc/chirpstack/region_eu868.toml'), 'utf8'),
    '# region fixture\n');
});
