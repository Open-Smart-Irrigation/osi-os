'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const payload = path.join(repo, 'conf/full_raspberrypi_bcm27xx_bcm2712/files');
const find = name => (process.env.PATH || '').split(path.delimiter).map(d => path.join(d, name)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
});
const shells = [];
if (find('busybox')) shells.push([find('busybox'), ['ash']]);
if (find('dash')) shells.push([find('dash'), []]);
assert.ok(shells.length, 'install BusyBox ash or dash');
if (process.env.CI) assert.equal(shells.length, 2, 'CI must exercise BusyBox ash and dash');
const q = s => "'" + s.replaceAll("'", "'\\''") + "'";
for (const [shell, args] of shells) {
  function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-image-grow-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const p = f => path.join(root, f);
    fs.mkdirSync(p('bin'));
    const put = (f, data = '') => { fs.mkdirSync(path.dirname(p(f)), { recursive: true }); fs.writeFileSync(p(f), data); };
    const exe = (name, body) => { put(`bin/${name}`, `#!${shell}${args.length ? ' ' + args[0] : ''}\n${body}\n`); fs.chmodSync(p(`bin/${name}`), 0o755); };
    // Rewrite absolute target paths into a disposable tree. Never run block tools
    // or reboot on the workstation. Dispatch remains the vendored rc.common.
    const rewrite = source => source.replace(/\/(etc|usr|data|srv|proc|sys|dev)\//g, `${root}/$1/`);
    for (const f of ['etc/init.d/osi-rootfs-resize', 'etc/uci-defaults/90_osi_rootfs_grow', 'usr/libexec/osi-rootfs-grow.sh']) {
      if (fs.existsSync(path.join(payload, f))) put(f, rewrite(fs.readFileSync(path.join(payload, f), 'utf8')));
    }
    put('rc.common', fs.readFileSync(path.join(repo, 'openwrt/package/base-files/files/etc/rc.common'), 'utf8'));
    put('lib/functions.sh', 'list_contains() { case " $(eval "echo \\$$1") " in *" $2 "*) return 0;; *) return 1;; esac; }\n');
    put('lib/functions/service.sh');
    put('lib/functions/procd.sh', 'procd_open_service() { :; }; procd_close_service() { :; }\n');
    for (const cmd of ['awk', 'cat', 'readlink']) fs.symlinkSync(find('busybox') || find(cmd), p(`bin/${cmd}`));
    exe('sync', 'echo sync >> "$FIXTURE/calls"\n[ "${FAIL_COMMAND:-}" != sync ]');
    for (const cmd of ['touch', 'rm']) {
      exe(cmd, `echo ${cmd} "$@" >> "$FIXTURE/calls"\n[ "\${FAIL_COMMAND:-}" != ${cmd} ] || exit 1\nexec ${q(find(cmd))} "$@"`);
    }
    exe('logger', 'echo "log $*" >> "$FIXTURE/calls"');
    exe('findmnt', 'echo "$FIXTURE/dev/mmcblk0p2"');
    exe('partprobe', ':');
    exe('parted', 'echo "parted $*" >> "$FIXTURE/calls"\ninput=$(cat); echo "$input" >> "$FIXTURE/calls"\n# Model GNU Parted refusing the mounted-partition question in script mode.\ncase " $* " in *" -s "*) exit 1;; esac\n[ "$input" = yes ] || exit 1\n[ "${PARTED_FAIL:-0}" = 0 ] || exit 1\necho grown > "$FIXTURE/partition-grown"\n[ "${CUT_AFTER_PARTED:-0}" = 0 ] || kill -KILL "$PPID"');
    exe('resize2fs', 'echo "resize2fs $*" >> "$FIXTURE/calls"\n[ "${RESIZE_FAIL:-0}" = 0 ] || exit 1\n[ "${CUT_AFTER_RESIZE:-0}" = 0 ] || kill -KILL "$PPID"');
    exe('reboot', 'echo reboot >> "$FIXTURE/calls"\n[ "${REBOOT_FAIL:-0}" = 0 ]');
    function mounts(source = '/dev/mmcblk0p2', type = 'ext4', point = '/overlay', opts = 'rw,relatime') {
      put('proc/mounts', rewrite(`${source} ${point} ${type} ${opts} 0 0\n/dev/mmcblk0p2 /rom squashfs ro 0 0\n`));
      put('proc/self/mountinfo', rewrite('1 0 179:2 / /rom ro - squashfs /dev/root ro\n'));
    }
    mounts();
    put('dev/mmcblk0p2');
    put('sys/class/block/mmcblk0p2/dev', '179:2\n');
    put('sys/class/block/mmcblk0p2/start', '2048\n');
    put('sys/class/block/mmcblk0p2/size', '37952\n');
    put('sys/class/block/mmcblk0/size', '40000\n');
    const run = (kind = 'boot', extra = {}) => {
      // A new boot rereads the on-disk partition table; a same-boot start does not.
      if (kind === 'boot' && fs.existsSync(p('partition-grown'))) put('sys/class/block/mmcblk0p2/size', '37952\n');
      return spawnSync(shell, [...args, ...(kind === 'defaults'
        ? ['-c', '. "$1"', 'uci-defaults', p('etc/uci-defaults/90_osi_rootfs_grow')]
        : [p('rc.common'), p('etc/init.d/osi-rootfs-resize'), kind])], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: p('bin'), FIXTURE: root, IPKG_INSTROOT: root, ...extra },
      });
    };
    return { root, p, put, mounts, run, calls: () => fs.existsSync(p('calls')) ? fs.readFileSync(p('calls'), 'utf8') : '',
      pending: () => fs.existsSync(p('etc/osi-rootfs-grow-needs-resize')),
      stamped: () => fs.existsSync(p('etc/osi-rootfs-grow.partitioned')) };
  }
  function ok(r) { assert.ifError(r.error); assert.equal(r.status, 0, r.stdout + r.stderr); }
  for (const action of ['start', 'boot']) test(`${path.basename(shell)} ${action} reaches filesystem growth through rc.common`, t => {
    const g = fixture(t); g.put('etc/osi-rootfs-grow-needs-resize'); ok(g.run(action));
    assert.match(g.calls(), /resize2fs .*\/dev\/mmcblk0p2/); assert.ok(g.stamped()); assert.ok(!g.pending());
    ok(g.run(action)); assert.equal(g.calls().match(/resize2fs /g).length, 1);
  });
  test(`${path.basename(shell)} sourced uci-defaults dispatches partition growth and next boot completes`, t => {
    const g = fixture(t); g.put('sys/class/block/mmcblk0p2/size', '10000\n'); ok(g.run('defaults')); assert.match(g.calls(), /parted /); assert.ok(g.pending());
    assert.match(g.calls(), /resizepart 2 100%/); assert.match(g.calls(), /^yes$/m); assert.match(g.calls(), /reboot/);
    ok(g.run('defaults')); assert.equal(g.calls().match(/parted /g).length, 1);
    ok(g.run()); assert.ok(g.stamped()); assert.ok(!g.pending());
  });
  test(`${path.basename(shell)} recognizes the shipped ext4 loop overlay without findmnt`, t => {
    const g = fixture(t); fs.unlinkSync(g.p('bin/findmnt')); g.mounts('/dev/loop0');
    g.put('sys/class/block/loop0/loop/backing_file', g.p('dev/mmcblk0p2') + '\n');
    g.put('sys/class/block/loop0/loop/offset', '65536\n');
    g.put('sys/class/block/loop0/loop/sizelimit', '0\n');
    g.put('sys/class/block/loop0/size', '37824\n');
    g.put('etc/osi-rootfs-grow-needs-resize'); ok(g.run());
    assert.match(g.calls(), /resize2fs .*\/dev\/loop0/); assert.ok(g.stamped());
  });
  for (const failure of ['parted', 'touch', 'sync', 'reboot']) test(`${path.basename(shell)} ${failure} failure retains first-boot retry`, t => {
    const g = fixture(t); g.put('sys/class/block/mmcblk0p2/size', '10000\n'); const env = failure === 'parted' ? { PARTED_FAIL: '1' } : failure === 'reboot' ? { REBOOT_FAIL: '1' } : { FAIL_COMMAND: failure };
    const r = g.run('defaults', env); assert.notEqual(r.status, 0); assert.ok(!g.stamped());
    if (failure !== 'reboot') assert.doesNotMatch(g.calls(), /^reboot$/m);
    ok(g.run('defaults')); assert.ok(g.pending()); ok(g.run()); assert.ok(g.stamped());
  });
  for (const failure of ['resize2fs', 'touch', 'sync', 'rm']) test(`${path.basename(shell)} ${failure} failure keeps resize recoverable`, t => {
    const g = fixture(t); g.put('etc/osi-rootfs-grow-needs-resize');
    g.run('boot', failure === 'resize2fs' ? { RESIZE_FAIL: '1' } : { FAIL_COMMAND: failure });
    assert.ok(g.pending()); ok(g.run()); assert.ok(g.stamped()); assert.ok(!g.pending());
  });
  for (const cut of ['CUT_AFTER_PARTED', 'CUT_AFTER_RESIZE']) test(`${path.basename(shell)} restart after ${cut}`, t => {
    const g = fixture(t); g.put('sys/class/block/mmcblk0p2/size', '10000\n'); if (cut === 'CUT_AFTER_RESIZE') { g.put('etc/osi-rootfs-grow-needs-resize'); g.put('sys/class/block/mmcblk0p2/size', '37952\n'); }
    const r = g.run(cut === 'CUT_AFTER_PARTED' ? 'defaults' : 'boot', { [cut]: '1' }); assert.equal(r.signal, 'SIGKILL');
    assert.ok(!g.stamped()); ok(g.run('defaults')); ok(g.run()); assert.ok(g.stamped());
  });
  for (const name of ['farming.db', 'farming.db-wal', 'farming.db-shm', 'farming.db-journal']) test(`${path.basename(shell)} refuses partition changes on provisioned media: ${name}`, t => {
    const g = fixture(t); g.put(`data/db/${name}`, 'history-canary'); ok(g.run('defaults'));
    assert.doesNotMatch(g.calls(), /parted |reboot|resize2fs /); assert.equal(fs.readFileSync(g.p(`data/db/${name}`), 'utf8'), 'history-canary');
  });
  test(`${path.basename(shell)} pending online ext4 growth preserves provisioned database and sidecars`, t => {
    const g = fixture(t); for (const n of ['farming.db', 'farming.db-wal', 'farming.db-shm', 'farming.db-journal']) g.put(`data/db/${n}`, n);
    g.put('etc/osi-rootfs-grow-needs-resize'); ok(g.run()); assert.ok(g.stamped());
    for (const n of ['farming.db', 'farming.db-wal', 'farming.db-shm', 'farming.db-journal']) assert.equal(fs.readFileSync(g.p(`data/db/${n}`), 'utf8'), n);
    assert.doesNotMatch(g.calls(), /parted |reboot|data\/db/);
  });
  for (const [source, type, opts] of [['/dev/sda2', 'ext4', 'rw'], ['/dev/mmcblk0p2', 'f2fs', 'rw'], ['/dev/mmcblk0p2', 'ext4', 'ro']]) test(`${path.basename(shell)} refuses unsupported mount ${source} ${type} ${opts}`, t => {
    const g = fixture(t); g.mounts(source, type, '/overlay', opts); g.put('etc/osi-rootfs-grow-needs-resize');
    g.run(); assert.ok(g.pending()); assert.ok(!g.stamped()); assert.doesNotMatch(g.calls(), /resize2fs /);
    g.run('defaults'); assert.doesNotMatch(g.calls(), /^(?:parted |reboot$)/m);
  });
  test(`${path.basename(shell)} already completed card never repartitions or reboots`, t => {
    const g = fixture(t); g.put('etc/osi-rootfs-grow.partitioned'); ok(g.run('defaults')); ok(g.run());
    assert.doesNotMatch(g.calls(), /parted |reboot|resize2fs /);
  });
  test(`${path.basename(shell)} an already full partition only queues the filesystem pass`, t => {
    const g = fixture(t); ok(g.run('defaults')); assert.ok(g.pending());
    assert.doesNotMatch(g.calls(), /parted /); ok(g.run()); assert.ok(g.stamped());
  });
  test(`${path.basename(shell)} a same-boot start cannot stamp stale kernel geometry`, t => {
    const g = fixture(t); g.put('sys/class/block/mmcblk0p2/size', '10000\n'); ok(g.run('defaults'));
    assert.notEqual(g.run('start').status, 0); assert.ok(g.pending()); assert.ok(!g.stamped());
    ok(g.run()); assert.ok(g.stamped());
  });
  test(`${path.basename(shell)} an extra partition prevents automatic repartition`, t => {
    const g = fixture(t); g.put('sys/class/block/mmcblk0/mmcblk0p3');
    assert.notEqual(g.run('defaults').status, 0); assert.doesNotMatch(g.calls(), /^(?:parted |reboot$)/m);
  });
  for (const change of ['backing', 'offset', 'sizelimit', 'capacity', 'root-alias-mismatch', 'missing-device-number']) test(`${path.basename(shell)} refuses unverified loop ${change}`, t => {
    const g = fixture(t); g.mounts('/dev/loop0'); g.put('etc/osi-rootfs-grow-needs-resize');
    g.put('sys/class/block/loop0/loop/backing_file', g.p('dev/mmcblk0p2') + '\n');
    g.put('sys/class/block/loop0/loop/offset', '65536\n');
    g.put('sys/class/block/loop0/loop/sizelimit', '0\n');
    g.put('sys/class/block/loop0/size', '37824\n');
    if (change === 'backing') g.put('sys/class/block/loop0/loop/backing_file', g.p('dev/sda2') + '\n');
    if (change === 'offset') g.put('sys/class/block/loop0/loop/offset', '1\n');
    if (change === 'sizelimit') g.put('sys/class/block/loop0/loop/sizelimit', '10000\n');
    if (change === 'capacity') g.put('sys/class/block/loop0/size', '9000\n');
    if (change.includes('device-number') || change.includes('alias')) {
      g.put('dev/root'); g.put('sys/class/block/loop0/loop/backing_file', g.p('dev/root') + '\n');
      g.put('proc/self/mountinfo', '1 0 8:1 / /rom ro - squashfs /dev/root ro\n');
      if (change === 'missing-device-number') { g.put('proc/self/mountinfo'); g.put('sys/class/block/mmcblk0p2/dev'); }
    }
    assert.notEqual(g.run().status, 0); assert.ok(g.pending()); assert.ok(!g.stamped());
    assert.doesNotMatch(g.calls(), /resize2fs /);
  });
  test(`${path.basename(shell)} verifies the root alias by mounted device number`, t => {
    const g = fixture(t); g.mounts('/dev/loop0'); g.put('dev/root');
    g.put('sys/class/block/loop0/loop/backing_file', g.p('dev/root') + '\n');
    g.put('sys/class/block/loop0/loop/offset', '65536\n');
    g.put('sys/class/block/loop0/loop/sizelimit', '0\n');
    g.put('sys/class/block/loop0/size', '37824\n');
    g.put('etc/osi-rootfs-grow-needs-resize'); ok(g.run()); assert.ok(g.stamped());
  });
  for (const command of ['parted', 'resize2fs']) test(`${path.basename(shell)} missing ${command} retains defaults`, t => {
    const g = fixture(t); fs.unlinkSync(g.p(`bin/${command}`));
    assert.notEqual(g.run('defaults').status, 0); assert.ok(!g.pending()); assert.ok(!g.stamped());
    assert.doesNotMatch(g.calls(), /^(?:parted |reboot$)/m);
  });

  test(`${path.basename(shell)} existing F2FS is a logged no-op with its media and pending state intact`, t => {
    const g = fixture(t); g.mounts('/dev/loop0', 'f2fs'); g.put('data/db/farming.db', 'existing-history');
    ok(g.run('defaults')); assert.match(g.calls(), /f2fs/);
    g.put('etc/osi-rootfs-grow-needs-resize'); ok(g.run());
    assert.ok(g.pending()); assert.ok(!g.stamped()); assert.match(g.calls(), /f2fs/);
    assert.doesNotMatch(g.calls(), /parted |resize2fs |reboot|^rm /m);
    assert.equal(fs.readFileSync(g.p('data/db/farming.db'), 'utf8'), 'existing-history');
  });

}
// rc.common enables procd for *any* nonempty value. Keep the unsafe legacy
// doctor inert until IM2 replaces it; enabling that script is not a dispatch fix.
test('image init scripts have matching rc.common entry points, with NEW-16 reserved for IM2', () => {
  for (const profile of ['bcm2712', 'bcm2709']) {
    const dir = path.join(repo, `conf/full_raspberrypi_bcm27xx_${profile}/files/etc/init.d`);
    for (const name of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      if (!source.startsWith('#!/bin/sh /etc/rc.common')) continue;
      if (name === 'osi-db-integrity') continue;
      assert.doesNotMatch(source, /^USE_PROCD=0$/m, name);
      if (/^USE_PROCD=1$/m.test(source)) assert.match(source, /^start_service\(\)/m, name);
      else assert.match(source, /^start\(\)/m, name);
    }
  }
});
test('both full images explicitly pin blank-media ext4 formatting without enabling the F2FS module', () => {
  for (const profile of ['bcm2712', 'bcm2709']) {
    const config = fs.readFileSync(path.join(repo, `conf/full_raspberrypi_bcm27xx_${profile}/.config`), 'utf8');
    assert.ok(/^CONFIG_FSTOOLS_ROOTDISK_EXT4=y$/m.test(config), profile + ' explicitly selects ext4');
    assert.ok(/^# CONFIG_PACKAGE_kmod-fs-f2fs is not set$/m.test(config), profile + ' keeps the F2FS module disabled');
  }
  const makefile = fs.readFileSync(path.join(repo, 'openwrt/package/system/fstools/Makefile'), 'utf8');
  assert.match(makefile, /PKG_CONFIG_DEPENDS[^\n]*CONFIG_FSTOOLS_ROOTDISK_EXT4/);
  assert.match(makefile, /TARGET_CFLAGS \+= \$\(if \$\(CONFIG_FSTOOLS_ROOTDISK_EXT4\),-DOSI_ROOTDISK_EXT4\)/);
});

test('pinned fstools formats only blank overlays as ext4 and preserves existing F2FS/ext4', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-fstools-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'libfstools'));
  const upstream = fs.readFileSync(path.join(repo, 'scripts/fixtures/image-boot-growth/common.c'), 'utf8');
  fs.writeFileSync(path.join(root, 'libfstools/common.c'), upstream);
  const policyPatch = path.join(repo, 'openwrt/package/system/fstools/patches/100-osi-rootdisk-ext4.patch');
  // Without the production patch, compile upstream unchanged: the ext4
  // expectation must fail on its actual F2FS choice, rather than on ENOENT.
  if (fs.existsSync(policyPatch)) {
    const patched = spawnSync('git', ['apply', policyPatch], { cwd: root, encoding: 'utf8' });
    assert.equal(patched.status, 0, patched.stdout + patched.stderr);
  }
  const source = fs.readFileSync(path.join(root, 'libfstools/common.c'), 'utf8');
  // Compile the real policy and formatting functions with fake I/O. No block
  // device, filesystem formatter or mount is used by this test.
  const functions = source.slice(source.indexOf('static bool use_f2fs'));
  const harness = `
#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
typedef uint32_t __u32;
#define F2FS_MINSIZE (100ULL * 1024 * 1024)
#define BLKGETSIZE64 1
#define cpu_to_be32(x) (x)
#define cpu_to_le32(x) (x)
#define ULOG_INFO(...) ((void)0)
#define ULOG_ERR(...) ((void)0)
enum { FS_NONE, FS_DEADCODE, FS_TARGZ, FS_EXT4, FS_F2FS };
struct volume { const char *blk; };
static int existing_fs = FS_NONE, formats = 0;
static char command[256];
static int volume_identify(struct volume *v) { (void)v; return existing_fs; }
static int fake_open(const char *p, int f) { (void)p; (void)f; return 3; }
static int fake_close(int fd) { (void)fd; return 0; }
static int fake_ioctl(int fd, int req, uint64_t *size) { (void)fd; (void)req; *size = 14ULL * 1024 * 1024 * 1024; return 0; }
static off_t fake_lseek(int fd, off_t off, int whence) { (void)fd; (void)whence; return off; }
static ssize_t fake_read(int fd, void *data, size_t n) { (void)fd; memset(data, 0, n); return n; }
static int fake_system(const char *s) { ++formats; snprintf(command, sizeof(command), "%s", s); return 0; }
#define open fake_open
#define close fake_close
#define ioctl fake_ioctl
#define lseek fake_lseek
#define read fake_read
#define system fake_system
${functions}
int main(void) {
  struct volume v = { "/dev/test-overlay" };
  for (int fs = FS_NONE; fs <= FS_DEADCODE; ++fs) {
    existing_fs = fs; formats = 0;
    assert(block_volume_format(&v, 65536, "/dev/test-partition") == 0);
    assert(formats == 1);
#ifdef OSI_ROOTDISK_EXT4
    assert(strstr(command, "mkfs.ext4 ") == command);
#else
    assert(strstr(command, "mkfs.f2fs ") == command);
#endif
  }
  for (int fs = FS_EXT4; fs <= FS_F2FS; ++fs) {
    existing_fs = fs; formats = 0;
    assert(block_volume_format(&v, 65536, "/dev/test-partition") == 0);
    assert(formats == 0);
  }
  return 0;
}
`;
  fs.writeFileSync(path.join(root, 'policy.c'), harness);
  for (const flags of [[], ['-DOSI_ROOTDISK_EXT4']]) {
    const build = spawnSync('cc', [...flags, '-o', path.join(root, 'policy'), path.join(root, 'policy.c')], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const result = spawnSync(path.join(root, 'policy'), [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
