'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const find = name => process.env.PATH.split(path.delimiter).map(d => path.join(d, name)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
});
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

test('recovery fixtures fall back when BusyBox has no flock applet', t => {
  const busybox = find('busybox'); assert.ok(busybox, 'CI installs BusyBox');
  assert.ok(find('flock'), 'CI installs util-linux flock');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-cs-no-flock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const listed = spawnSync(busybox, ['--list'], { encoding: 'utf8' }); assert.equal(listed.status, 0);
  const applets = listed.stdout.trim().split('\n').filter(a => a !== 'flock').join('\n');
  fs.writeFileSync(path.join(root, 'busybox'), `#!/bin/sh
case "$1" in
  flock) echo 'flock: applet not found' >&2; exit 127 ;;
  --list) printf '%s\\n' ${quote(applets)} ;;
  *) exec ${quote(busybox)} "$@" ;;
esac
`, { mode: 0o755 });
  const childEnv = { ...process.env, CI: '1', PATH: root + path.delimiter + process.env.PATH };
  delete childEnv.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=recovery restart failure retains',
    path.join(repo, 'scripts/test-chirpstack-backup-restore.js')], {
    env: childEnv,
    encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /# pass 2/);
});

const { collectCommands, configValues, busyboxDefaults, missingCommands, auditRepo } = require('./chirpstack-helper-tools');
test('every helper external command is provided by both shipped images', t => {
  const audit = auditRepo(repo);
  t.diagnostic('external commands: ' + audit.commands.join(', '));
  assert.deepEqual(audit.missing, { bcm2712: [], bcm2709: [] });
  for (const required of ['flock', 'pidof', 'pgrep', 'sha256sum', 'mktemp', 'service', 'sqlite3']) assert.ok(audit.commands.includes(required));
});
test('command guard covers pipelines, substitutions, dynamic probes and emitted recovery', () => {
  const source = `PROBE=pidof
f() { "$PROBE" chirpstack; }
x=$(sha256sum file)
f | sync
command -p new_missing_applet file
log 'BEGIN RECOVERY COMMANDS'
log '('
cat <<'RECOVERY'
flock -n 9
RECOVERY
log 'new_missing_applet file'
log ')'
log 'END RECOVERY COMMANDS'
`;
  const commands = collectCommands(source);
  for (const name of ['pidof', 'sha256sum', 'sync', 'flock', 'new_missing_applet']) assert.ok(commands.has(name), name);
  const config = configValues('CONFIG_PACKAGE_busybox=y\nCONFIG_BUSYBOX_DEFAULT_SYNC=y\n');
  assert.ok(missingCommands(commands, config, new Map()).includes('new_missing_applet'));
  assert.throws(() => collectCommands('"$UNRESOLVED_COMMAND" file'), /unresolved dynamic/);
  assert.throws(() => collectCommands('env new_missing_applet file'), /execution wrapper/);
});
test('command guard honors disabled applets, CUSTOM and selected packages', () => {
  const defaults = busyboxDefaults('config BUSYBOX_DEFAULT_FLOCK\n bool\n default y\n');
  const base = 'CONFIG_PACKAGE_busybox=y\n# CONFIG_BUSYBOX_CUSTOM is not set\n';
  assert.deepEqual(missingCommands(new Set(['flock']), configValues(base), defaults), []);
  assert.deepEqual(missingCommands(new Set(['flock']), configValues(base + '# CONFIG_BUSYBOX_DEFAULT_FLOCK is not set\n'), defaults), ['flock']);
  assert.deepEqual(missingCommands(new Set(['flock']), configValues(base + 'CONFIG_BUSYBOX_CUSTOM=y\n'), defaults), ['flock']);
  assert.deepEqual(missingCommands(new Set(['service', 'sqlite3']), configValues('CONFIG_PACKAGE_procd=y\nCONFIG_PACKAGE_sqlite3-cli=y\n'), defaults), []);
  assert.deepEqual(missingCommands(new Set(['service']), configValues(''), defaults), ['service']);
});
