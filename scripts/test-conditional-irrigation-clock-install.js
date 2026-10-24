'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const deploy = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
const sourceStart = deploy.indexOf('IRRIGATION_CLOCK_HOOK=');
const sourceEnd = deploy.indexOf('\n# The command ledger', sourceStart);
assert.ok(sourceStart >= 0 && sourceEnd > sourceStart, 'clock installer was not found in deploy.sh');
const installerSource = deploy.slice(sourceStart, sourceEnd);

function makeFixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-irrigation-clock-install-'));
  const hook = path.join(dir, 'etc/hotplug.d/ntp/70-osi-irrigation-clock');
  const service = options.service === false ? path.join(dir, 'missing/sysntpd') : path.join(dir, 'etc/init.d/sysntpd');
  const adapter = options.adapter === false ? path.join(dir, 'missing/ntpd-hotplug') : path.join(dir, 'usr/sbin/ntpd-hotplug');
  const uci = path.join(dir, 'bin/uci');
  const serviceLog = path.join(dir, 'service.log');
  const uciLog = path.join(dir, 'uci.log');
  const marker = path.join(dir, 'clock-marker.json');
  fs.mkdirSync(path.dirname(uci), { recursive: true });
  fs.writeFileSync(uci, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$UCI_LOG"\nif [ "$1" = "-q" ] && [ "$2" = "get" ]; then printf \'%s\\n\' "$UCI_VALUE"; exit 0; fi\nexit 99\n');
  fs.chmodSync(uci, 0o755);
  if (options.service !== false) {
    fs.mkdirSync(path.dirname(service), { recursive: true });
    fs.writeFileSync(service, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SERVICE_LOG"\ncase "$1" in\n  enabled) [ "$SERVICE_ENABLED" = "1" ] ;;\n  restart)\n    [ -f "$IRRIGATION_CLOCK_HOOK" ] || exit 21\n    [ "$(stat -c %a "$IRRIGATION_CLOCK_HOOK")" = "755" ] || exit 22\n    [ "$RESTART_OK" = "1" ] ;;\n  enable) exit 99 ;;\n  *) exit 98 ;;\nesac\n');
    fs.chmodSync(service, 0o755);
  }
  if (options.adapter !== false) {
    fs.mkdirSync(path.dirname(adapter), { recursive: true });
    fs.writeFileSync(adapter, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(adapter, 0o755);
  }
  if (options.hookMode != null) {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.copyFileSync(path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/hotplug.d/ntp/70-osi-irrigation-clock'), hook);
    fs.chmodSync(hook, options.hookMode);
  }
  if (options.marker != null) fs.writeFileSync(marker, options.marker);
  return { dir, hook, service, adapter, uci, serviceLog, uciLog, marker };
}

function runFixture(fixture, options = {}) {
  const script = `
set +e
eval "$INSTALLER_SOURCE"
fetch_required() {
  # The deploy function's destination is the real target path.  The harness
  # redirects that copy into its isolated target while retaining the literal
  # production call-site in deploy.sh.
  cp "$HOOK_SOURCE" "$IRRIGATION_CLOCK_HOOK"
}
install_irrigation_clock_hook >"$INSTALL_STDOUT" 2>"$INSTALL_STDERR"
printf '%s' "$?" >"$INSTALL_STATUS"
`;
  const statusFile = path.join(fixture.dir, 'status');
  const stdoutFile = path.join(fixture.dir, 'stdout');
  const stderrFile = path.join(fixture.dir, 'stderr');
  const env = {
    ...process.env,
    INSTALLER_SOURCE: installerSource,
    HOOK_SOURCE: path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/hotplug.d/ntp/70-osi-irrigation-clock'),
    IRRIGATION_CLOCK_HOOK: fixture.hook,
    IRRIGATION_SYSNTPD_INIT: fixture.service,
    IRRIGATION_NTPD_HOTPLUG: fixture.adapter,
    IRRIGATION_UCI: fixture.uci,
    SERVICE_LOG: fixture.serviceLog,
    UCI_LOG: fixture.uciLog,
    SERVICE_ENABLED: options.serviceEnabled === false ? '0' : '1',
    RESTART_OK: options.restartOk === false ? '0' : '1',
    UCI_VALUE: options.uciValue == null ? '1' : String(options.uciValue),
    INSTALL_STDOUT: stdoutFile,
    INSTALL_STDERR: stderrFile,
    INSTALL_STATUS: statusFile,
  };
  const child = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
  assert.equal(child.error, undefined, child.error && child.error.message);
  const status = Number(fs.readFileSync(statusFile, 'utf8'));
  return {
    status,
    stdout: fs.readFileSync(stdoutFile, 'utf8'),
    stderr: fs.readFileSync(stderrFile, 'utf8'),
    serviceLog: fs.existsSync(fixture.serviceLog) ? fs.readFileSync(fixture.serviceLog, 'utf8') : '',
    uciLog: fs.existsSync(fixture.uciLog) ? fs.readFileSync(fixture.uciLog, 'utf8') : '',
  };
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

test('first activation installs before one real sysntpd restart', () => {
  const fixture = makeFixture();
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 0);
    assert.equal(mode(fixture.hook), 0o755);
    assert.match(result.serviceLog, /enabled/);
    assert.match(result.serviceLog, /restart/);
    assert.equal(fs.existsSync(fixture.marker), false, 'install must not manufacture a clock marker');
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('an already executable hook is refreshed without a restart', () => {
  const fixture = makeFixture({ hookMode: 0o755, service: false, adapter: false });
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 0);
    assert.equal(mode(fixture.hook), 0o755);
    assert.equal(result.serviceLog, '');
    assert.equal(result.uciLog, '');
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('successful activation leaves an existing marker byte-identical', () => {
  const marker = '{"boot_id":"keep","marker":7}\n';
  const fixture = makeFixture({ marker });
  try {
    const result = runFixture(fixture);
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(fixture.marker, 'utf8'), marker);
  } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
});

test('restart failure restores inactive state and a later run retries', () => {
  const absent = makeFixture();
  const nonExecutable = makeFixture({ hookMode: 0o644 });
  try {
    assert.notEqual(runFixture(absent, { restartOk: false }).status, 0);
    assert.equal(fs.existsSync(absent.hook), false);
    assert.notEqual(runFixture(nonExecutable, { restartOk: false }).status, 0);
    assert.equal(mode(nonExecutable.hook), 0o644);
    const retry = runFixture(absent, { restartOk: true });
    assert.equal(retry.status, 0);
    assert.equal(mode(absent.hook), 0o755);
  } finally {
    fs.rmSync(absent.dir, { recursive: true, force: true });
    fs.rmSync(nonExecutable.dir, { recursive: true, force: true });
  }
});

test('missing or disabled NTP prerequisites fail closed without enable or UCI edits', () => {
  const cases = [
    [{ service: false }, 'requires executable', 'sysntpd'],
    [{ adapter: false }, 'requires executable', 'ntpd-hotplug'],
    [{ serviceEnabled: false }, 'not enabled', null],
    [{ uciValue: '0' }, 'explicitly false', null],
  ];
  for (const [options, message, pathPart] of cases) {
    const fixture = makeFixture(options);
    try {
      const result = runFixture(fixture, options);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(message));
      if (pathPart) assert.match(result.stderr, new RegExp(pathPart));
      assert.equal(fs.existsSync(fixture.hook), false);
      assert.doesNotMatch(result.serviceLog, /^enable$/m);
      assert.doesNotMatch(result.uciLog, /set/);
    } finally { fs.rmSync(fixture.dir, { recursive: true, force: true }); }
  }
});

console.log('OK (conditional irrigation clock installer harness)');
