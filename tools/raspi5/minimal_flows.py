"""Test-only instrumentation for the release line's atomic flows writer."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import signal

from suite_vm import external_path

INIT = Path('feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init')
ATOMIC_PUBLISH = r"if (flowsChanged) writeAtomic(flowFile, JSON.stringify(flows, null, 2) + '\n');"
INIT_PIN = re.compile(r'^NODE_RED_INIT_SHA256="([0-9a-f]{64})"$', re.M)
CUT_RECEIPT = (
    rb'minimal-flows-cut phase=(committed|before-dir-sync) old=([0-9a-f]{64}) '
    rb'new=([0-9a-f]{64}) stamp=([A-Za-z0-9_-]+)\r?\n'
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
      function stopAtCut() {
        if (old === fresh || digest(fs.readFileSync(flowFile)) !== fresh) {
          throw new Error('emulator probe expected changed and complete flows');
        }
        fs.writeFileSync('/dev/console', `minimal-flows-cut phase=${phase} old=${old} new=${fresh} stamp=${stamp}\n`);
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


def verify_disk(vm, receipt, *, phase, factory, shipped_old, old_stamp=None):
    vm.stop(cut=True)
    seen_phase, old, new, stamp = receipt
    if seen_phase != phase.encode() or old == new or (stamp == b'image') != factory or stamp == old_stamp:
        raise RuntimeError('minimal cut marker has the wrong phase, digest or payload stamp')
    if old != shipped_old:
        layout = 'factory' if factory else 'upgrade'
        raise RuntimeError(f'minimal {layout} marker old digest differs from the shipped flows')
    if (vm.receipts/f'qemu-{vm.boots}.exit').read_text().strip() != str(-signal.SIGKILL):
        raise RuntimeError('QEMU did not exit from the hard power cut')
    layout = 'factory' if factory else 'upgrade'
    vm.verify_cut_disk(f'minimal {layout} {phase}', (new, stamp), alternatives=((old, stamp),))
    return new, stamp


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release', type=Path)
    parser.add_argument('output', type=Path, help='new disposable source export outside Git and /tmp')
    args = parser.parse_args()
    try:
        parent = external_path(args.output.parent, off_tmp=True)
        print(prepare_probe_release(args.release.resolve(strict=True), parent/args.output.name))
    except (OSError, ValueError, RuntimeError) as error:
        parser.error(str(error))
