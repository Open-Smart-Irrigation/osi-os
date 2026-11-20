'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const source = path.join(repo, 'feeds/chirpstack-openwrt-feed/apps/osi-rootfs-flush/src/osi-rootfs-flush.c');
const find = name => (process.env.PATH || '').split(path.delimiter).map(d => path.join(d, name)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
});
const busybox = find('busybox');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function ok(r) { assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const fail of [false, true]) test(`kernel writeback ${fail ? 'EIO blocks and latches' : 'success permits'} the shipped reboot gate`, async t => {
  assert.ok(busybox, 'BusyBox is required');
  assert.ok(fs.existsSync('/dev/fuse'), 'real /dev/fuse is required; CI must not skip this test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-wb-'));
  const p = f => path.join(root, f);
  for (const d of ['mnt', 'bin', 'etc', 'var/run', 'usr/libexec', 'lib/functions']) fs.mkdirSync(p(d), { recursive: true });
  const put = (f, text) => fs.writeFileSync(p(f), text);
  const cc = spawnSync('cc', ['-std=c99', '-Wall', '-Wextra', '-Werror', source, '-o', p('flush')], { encoding: 'utf8' }); ok(cc);
  const flags = spawnSync('pkg-config', ['--cflags', '--libs', 'fuse3'], { encoding: 'utf8' }); ok(flags);
  ok(spawnSync('cc', ['-std=gnu99', '-Wall', '-Wextra', '-Werror', path.join(repo, 'scripts/fixtures/image-boot-growth/writeback-fuse.c'), '-o', p('fuse'), ...flags.stdout.trim().split(/\s+/)], { encoding: 'utf8' }));
  const socket = p('var/run/flush.sock');
  const call = command => spawnSync(p('flush'), [command, p('mnt'), socket], { encoding: 'utf8', timeout: 10000 });
  let daemon, mounted = false;
  t.after(async () => {
    if (fs.existsSync(socket)) call('stop');
    if (mounted || fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => line.split(' ')[4] === p('mnt'))) ok(spawnSync('fusermount3', ['-u', p('mnt')], { encoding: 'utf8' }));
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await Promise.race([new Promise(resolve => daemon.once('close', resolve)), delay(1000)]);
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let errors = '';
  daemon = spawn(p('fuse'), [p('mnt'), p('writeback-receipt'), fail ? '1' : '0']);
  daemon.stderr.on('data', b => { errors += b; });
  for (let n = 0; n < 200; n++) {
    if (fs.existsSync(p('mnt/.fs_state'))) break;
    // existsSync follows symlinks; the READY target deliberately does not exist.
    try { if (fs.readlinkSync(p('mnt/.fs_state')) === '2') break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    assert.equal(daemon.exitCode, null, errors); await delay(10);
  }
  assert.equal(fs.readlinkSync(p('mnt/.fs_state')), '2', errors); mounted = true;
  ok(call('arm')); ok(call('arm')); ok(call('check'));
  const fd = fs.openSync(p('mnt/fault'), 'r+');
  try {
    assert.equal(fs.writeSync(fd, Buffer.alloc(4096, 42)), 4096, 'write(2) acknowledges the dirty cached page');
    // Deliberately reproduce S95's unchecked flush before S96. The held
    // descriptor must still observe its error after sync() returned success.
    ok(spawnSync(busybox, ['sync'], { encoding: 'utf8', timeout: 15000 }));
    const receipt = fs.readFileSync(p('writeback-receipt'), 'utf8');
    assert.match(receipt, fail ? /writeback EIO/ : /writeback OK/);
    t.diagnostic(`cached write acknowledged 4096 bytes; bare BusyBox sync exited 0; ${receipt.trim()}`);
    put('etc/osi-rootfs-grow-needs-resize', 'pending');
    put('var/run/osi-rootfs-grow-reboot', 'queued');
    const helperPath = p('usr/libexec/osi-rootfs-flush'); fs.symlinkSync(p('flush'), helperPath);
    // This test isolates the flush boundary; target-selection/dispatch are
    // exercised by the ash/dash image suite. Reboot is always a harmless stub.
    put('selection.sh', `osi_rootfs_target() { ROOT_FSTYPE=ext4; ROOT_MOUNT=${quote(p('mnt'))}; return 0; }\n`);
    const service = fs.readFileSync(path.join(repo, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-rootfs-grow-reboot'), 'utf8')
      .replace('/usr/libexec/osi-rootfs-grow.sh', p('selection.sh'))
      .replaceAll('/usr/libexec/osi-rootfs-flush', helperPath)
      .replaceAll('/var/run/osi-rootfs-grow-flush.sock', socket)
      .replaceAll('/var/run/osi-rootfs-grow-reboot', p('var/run/osi-rootfs-grow-reboot'))
      .replaceAll('/etc/osi-rootfs-grow-needs-resize', p('etc/osi-rootfs-grow-needs-resize'))
      .replaceAll('/overlay', p('mnt'));
    put('service', service);
    for (const cmd of ['readlink', 'rm', 'sync']) fs.symlinkSync(busybox, p(`bin/${cmd}`));
    for (const [name, body] of [['logger', ':'], ['reboot', `echo reboot >> ${quote(p('reboots'))}`]]) {
      put(`bin/${name}`, `#!${busybox} ash\n${body}\n`); fs.chmodSync(p(`bin/${name}`), 0o755);
    }
    const run = () => spawnSync(busybox, ['ash', '-c', '. "$1"; start', 'service', p('service')], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: p('bin') } });
    const result = run();
    if (fail) {
      assert.notEqual(result.status, 0, 'writeback EIO must block the shipped reboot gate');
      assert.match(result.stderr, /Input\/output error/);
      assert.ok(!fs.existsSync(p('reboots')));
      assert.ok(fs.existsSync(p('etc/osi-rootfs-grow-needs-resize')));
      assert.ok(fs.existsSync(p('var/run/osi-rootfs-grow-reboot')));
      assert.notEqual(call('flush').status, 0, 'error remains latched after the kernel cursor advanced');
      assert.notEqual(call('arm').status, 0, 're-arming cannot replace a poisoned cursor');
      assert.notEqual(call('check').status, 0);
      assert.notEqual(run().status, 0, 'a same-boot retry cannot forget the failed initialization writes');
    } else {
      ok(result); assert.equal(fs.readFileSync(p('reboots'), 'utf8').trim(), 'reboot');
      assert.ok(fs.existsSync(p('etc/osi-rootfs-grow-needs-resize')));
      assert.ok(!fs.existsSync(p('var/run/osi-rootfs-grow-reboot')));
    }
  } finally { fs.closeSync(fd); }
});
