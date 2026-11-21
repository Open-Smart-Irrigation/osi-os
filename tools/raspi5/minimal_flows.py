"""Test-only instrumentation for the release line's atomic flows writer."""
import hashlib
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import tempfile

from run import expand_image

INIT = Path('feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init')
ATOMIC_PUBLISH = r"if (flowsChanged) writeAtomic(flowFile, JSON.stringify(flows, null, 2) + '\n');"
INIT_PIN = re.compile(r'^NODE_RED_INIT_SHA256="([0-9a-f]{64})"$', re.M)
CUT_RECEIPT = (
    rb'minimal-flows-cut phase=(committed|before-dir-sync) old=([0-9a-f]{64}) '
    rb'new=([0-9a-f]{64}) stamp=([A-Za-z0-9_-]+) '
    rb'init=([0-9a-f]{64}) writer=([0-9a-f]{64})\r?\n'
)
PROBE = r"""if (flowsChanged) {
    const next = JSON.stringify(flows, null, 2) + '\n';
    const phase = fs.readFileSync('/proc/cmdline', 'utf8')
      .match(/(?:^|\s)osi_flows_cut=(committed|before-dir-sync)(?=\s|$)/)?.[1];
    if (!phase) {
      writeAtomic(flowFile, next);
    } else {
      const { createHash } = require('node:crypto');
      const digest = bytes => createHash('sha256').update(bytes).digest('hex');
      const target = fs.realpathSync(flowFile);
      const stamp = target.match(/\/payloads\/([^/]+)\/flows\.json$/)?.[1] || 'image';
      const old = digest(fs.readFileSync(target));
      const fresh = digest(next);
      const init = digest(fs.readFileSync('/etc/init.d/node-red'));
      const writer = digest(fs.readFileSync(require.resolve('/usr/share/node-red/osi-atomic-write.js')));
      function stopAtCut() {
        if (old === fresh || digest(fs.readFileSync(flowFile)) !== fresh) {
          throw new Error('emulator probe expected changed and complete flows');
        }
        fs.writeFileSync('/dev/console', `minimal-flows-cut phase=${phase} old=${old} new=${fresh} stamp=${stamp} init=${init} writer=${writer}\n`);
        process.kill(process.pid, 'SIGSTOP');
      }
      if (phase === 'before-dir-sync') {
        const original = fs.fsyncSync;
        fs.fsyncSync = fd => {
          // The writer syncs the file, renames it, then syncs the directory.
          if (fs.fstatSync(fd).isDirectory()) stopAtCut();
          return original(fd);
        };
        try {
          writeAtomic(flowFile, next);
        } finally {
          fs.fsyncSync = original;
        }
      } else if (writeAtomic(flowFile, next)) {
        stopAtCut();
      }
    }
  }"""


def has_atomic_publish(init):
    return ATOMIC_PUBLISH in (line.strip() for line in init.splitlines())


def probe_init(source):
    if not has_atomic_publish(source) or source.count(ATOMIC_PUBLISH) != 1:
        raise ValueError('expected one minimal atomic flows publication in Node-RED init')
    return source.replace(ATOMIC_PUBLISH, PROBE, 1).encode()


def prepare_probe_release(release, output):
    if output.is_relative_to(release):
        raise ValueError('probe output must be outside the source tree')
    original = (release/INIT).read_bytes()
    instrumented = probe_init(original.decode())
    deploy = (release/'deploy.sh').read_text()
    pins = INIT_PIN.findall(deploy)
    if pins != [hashlib.sha256(original).hexdigest()]:
        raise ValueError('offline installer does not pin the original minimal init')
    digest = hashlib.sha256(instrumented).hexdigest()
    deploy = INIT_PIN.sub(f'NODE_RED_INIT_SHA256="{digest}"', deploy)
    shutil.copytree(release, output, symlinks=True, ignore=shutil.ignore_patterns('.git'))
    for filename, data in ((INIT, instrumented), (Path('deploy.sh'), deploy.encode())):
        target = output/filename
        if target.resolve() != target or not target.is_file():
            raise ValueError('probe files must be regular files within the disposable release tree')
        target.write_bytes(data)
    return digest


REPACK = r'''
bin=$1 image=$2 offset=$3 tree=$4 original=$5 instrumented=$6 packed=$7 block=$8 timestamp=$9
shift 9
"$bin/unsquashfs4" -strict-errors -processors 2 -offset "$offset" -d "$tree" "$image"
init="$tree/etc/init.d/node-red"
test -f "$init" && test "$(readlink -f "$init")" = "$init"
test "$(stat -c %h "$init")" -eq 1
cmp "$original" "$init"
mtime=$(stat -c %y "$init")
cat "$instrumented" > "$init"
touch -d "$mtime" "$init"
"$bin/mksquashfs4" "$tree" "$packed" -nopad -noappend -comp xz -b "$block"   -mkfs-time "$timestamp" -Xpreset 9 -Xe -Xlc 0 -Xlp 2 -Xpb 2 -processors 2 -mem 256M "$@"
'''


def derive_probe_image(candidate, release, probe_release, output, host_tools):
    # Expand the private, verified archive. Retain its partition table and
    # boot partition byte for byte and replace only the SquashFS extent.
    size = expand_image(candidate, output)
    with output.open('rb') as disk:
        mbr = disk.read(512)
        if mbr[510:] != b'\x55\xaa':
            raise ValueError('minimal factory probe requires an MBR image')
        boot_start, boot_size, root_start, root_size = (
            *struct.unpack_from('<II', mbr, 454), *struct.unpack_from('<II', mbr, 470))
        offset = root_start * 512
        if (not boot_start or not boot_size or not root_size or boot_start + boot_size > root_start
                or any(mbr[478:510]) or not offset + 96 <= size <= (root_start + root_size) * 512):
            raise ValueError('unsupported minimal factory partition layout')
        disk.seek(offset)
        header = disk.read(96)
        timestamp, block = struct.unpack_from('<II', header, 8)
        compression, _, flags, _, major, _ = struct.unpack_from('<6H', header, 20)
        used = struct.unpack_from('<Q', header, 40)[0]
        if (header[:4] != b'hsqs' or major != 4 or compression != 4
                or not 96 <= used <= size - offset):
            raise ValueError('minimal factory probe requires a SquashFS 4 xz root')
        # The OpenWrt ARMv7 profile stores the ARM BCJ filter option in the
        # superblock's option record. ARM64 has no filter.
        xz_options = []
        if flags & 0x400:
            option_size, dictionary, filters = struct.unpack('<HII', disk.read(10))
            if (option_size, dictionary, filters) != (0x8008, block, 8):
                raise ValueError('unsupported factory SquashFS xz options')
            xz_options = ['-Xbcj', 'arm']
        disk.seek(offset + used)
        if any(chunk.count(0) != len(chunk) for chunk in iter(lambda: disk.read(1024 * 1024), b'')):
            raise ValueError('minimal factory probe requires zero padding after SquashFS')

    with tempfile.TemporaryDirectory(prefix='probe-repack-', dir=output.parent) as directory:
        work = Path(directory)
        packed = work/'root.squashfs'
        binaries = host_tools/'bin'
        env = dict(os.environ, STAGING_DIR_HOST=str(host_tools), TMPDIR=str(work))
        env.pop('SOURCE_DATE_EPOCH', None)
        subprocess.run([binaries/'fakeroot', '--', 'sh', '-ec', REPACK, 'probe-repack',
                        binaries, output, str(offset), work/'tree', release/INIT, probe_release/INIT,
                        packed, str(block), str(timestamp), *xz_options],
                       cwd=work, env=env, check=True, stdout=subprocess.DEVNULL)
        if packed.stat().st_size > size - offset:
            raise ValueError('instrumented SquashFS does not fit the factory image')
        installed = subprocess.check_output([binaries/'unsquashfs4', '-cat', packed, 'etc/init.d/node-red'])
        if installed != (probe_release/INIT).read_bytes():
            raise ValueError('repacked probe init differs from the instrumented source')
        with output.open('r+b') as disk, packed.open('rb') as rootfs:
            disk.truncate(offset)
            disk.seek(offset)
            shutil.copyfileobj(rootfs, disk)
            disk.truncate(size)
    output.chmod(0o400)
    with output.open('rb') as disk:
        return hashlib.file_digest(disk, 'sha256').hexdigest()


def verify_disk(vm, receipt, *, phase, factory, shipped_old, shipped_init, shipped_writer, old_stamp=None):
    vm.stop(cut=True)
    seen_phase, old, new, stamp, live_init, live_writer = receipt
    if seen_phase != phase.encode() or old == new or (stamp == b'image') != factory or stamp == old_stamp:
        raise RuntimeError('minimal cut marker has the wrong phase, digest or payload stamp')
    if old != shipped_old:
        layout = 'factory' if factory else 'upgrade'
        raise RuntimeError(f'minimal {layout} marker old digest differs from the shipped flows')
    if (live_init, live_writer) != (shipped_init, shipped_writer):
        raise RuntimeError('minimal cut used a different running init or atomic writer')
    if (vm.receipts/f'qemu-{vm.boots}.exit').read_text().strip() != str(-signal.SIGKILL):
        raise RuntimeError('QEMU did not exit from the hard power cut')
    layout = 'factory' if factory else 'upgrade'
    vm.verify_cut_disk(f'minimal {layout} {phase}', (new, stamp), alternatives=((old, stamp),))
    return new, stamp
