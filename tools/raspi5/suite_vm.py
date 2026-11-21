"""Disposable serial-controlled Pi 5 with an isolated browser forward."""
import os
from pathlib import Path
import re
import secrets
import select
import socket
import struct
import subprocess
import tempfile
import time

import boot_config
from run import prepare


FLOWS_COMMITTED = rb'node-red\.init: committed flows\.json digest=(?P<digest>[0-9a-f]{64}) stamp=(?P<stamp>[A-Za-z0-9_-]+)\r?\n'


def external_path(path, *, off_tmp=False):
    resolved = path.resolve(strict=True)
    for spelling in (path.absolute(), resolved):
        if off_tmp and spelling.is_relative_to("/tmp"):
            raise ValueError("path is under /tmp")
        for directory in (spelling, *spelling.parents):
            marker = directory/'.git'
            if marker.exists() or marker.is_symlink() or all(
                (directory/name).exists() for name in ('HEAD', 'objects', 'refs')
            ):
                raise ValueError('path is inside a Git tree')
    return resolved


def reap(process, cut=False):
    if process.poll() is None:
        try:
            (process.kill if cut else process.terminate)()
        except ProcessLookupError:
            pass
    try:
        return process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if not cut:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        return process.wait(timeout=5)


# PID 1 runs only the shell and the setup needed by mount_root. OpenWrt
# normally creates block nodes through procd, which must stay stopped here.
INSPECTION_INIT = (
    'export PATH=/usr/sbin:/usr/bin:/sbin:/bin; '
    'mount -t proc proc /proc; '
    'mount -t sysfs sysfs /sys; '
    'if ! test -b /dev/mmcblk0; then mount -t tmpfs tmpfs /dev; '
    'mknod /dev/null c 1 3; mknod /dev/zero c 1 5; mknod /dev/urandom c 1 9; '
    'mknod /dev/console c 5 1; mknod /dev/tty c 5 0; fi; '
    'mount -t tmpfs tmpfs /tmp; '
    '[ ! -d /etc/modules-boot.d ] || /sbin/kmodloader /etc/modules-boot.d; '
    'for entry in /sys/class/block/*; do if [ -r $entry/dev ]; then '
    'name=${entry##*/}; if ! test -b /dev/$name; then '
    'IFS=: read major minor < $entry/dev; mknod /dev/$name b $major $minor; fi; fi; done; '
    "if PREINIT=1 /sbin/mount_root start && grep -q ' / overlay ' /proc/mounts "
    "&& grep -Eq '^/dev/[^ ]+ /overlay (f2fs|ext4) ' /proc/mounts; then "
    "printf 'OSI_INSPECT_%s\\n' READY; "
    "else printf 'OSI_INSPECT_%s\\n' FAILED; fi; "
    'cd /; exec /bin/sh -i'
)


class Guest:
    def __init__(self, work, image, qemu, ram, upgrade=None, *, receipts=None, private=False,
                 direct_io=False):
        self.work = Path(work).resolve()
        self.work.mkdir(mode=0o700)
        self.qemu = Path(qemu).resolve()
        self.ram = ram
        self.upgrade = upgrade
        self.receipts = receipts if receipts is not None else self.work
        self.receipts.mkdir(mode=0o700, exist_ok=True)
        self.private = private
        self.direct_io = direct_io
        self.process = self.bridge = None
        self.boots = 0
        prepare(image, self.work, self.qemu.with_name('dtmerge'), quiet=private)
        with socket.socket() as port:
            port.bind(('127.0.0.1', 0))
            self.port = port.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'

    def start(self, *, before_console=None, inspection=False, flow_cut=None):
        if self.process is not None or self.bridge is not None:
            raise RuntimeError('previous guest or bridge has not been reaped')
        self.boots += 1
        d = self.work
        self.buf = b''
        self.started = time.monotonic()
        disk = 'inspect.img' if inspection else 'sd.img'
        cache = ',cache=none' if self.direct_io else ''
        cmdline = (d/'cmdline.txt').read_text().strip() + ' console=ttyAMA10,115200 earlycon=pl011,mmio32,0x107d001000'
        if flow_cut is not None:
            if inspection or flow_cut not in ('committed', 'before-dir-sync'):
                raise ValueError('invalid minimal flows cut boot')
            cmdline += f' osi_flows_cut={flow_cut}'
        if inspection:
            cmdline += f' init=/bin/sh loglevel=7 -- -c "{INSPECTION_INIT}"'
        a, b = socket.socketpair()
        with a,b,self.stderr('bridge.stderr', 'ab') as err:
            self.bridge = subprocess.Popen(['qemu-system-x86_64','-machine','none','-nodefaults','-display','none','-monitor','none','-serial','none',
                '-netdev',f'socket,id=wire,fd={a.fileno()}','-netdev',f'user,id=local,restrict=on,net=192.0.2.0/24,hostfwd=tcp:127.0.0.1:{self.port}-192.0.2.15:1880',
                '-netdev','hubport,id=a,hubid=0,netdev=wire','-netdev','hubport,id=b,hubid=0,netdev=local'],pass_fds=(a.fileno(),),stdout=subprocess.DEVNULL,stderr=err)
            args=[self.qemu,'-M','raspi5b','-m',f'{self.ram}G','-no-reboot','-display','none','-nic',f'socket,fd={b.fileno()}','-monitor','none','-serial','stdio',
                  '-kernel','kernel_2712.img','-dtb','bcm2712-rpi-5-b.dtb','-drive',f'if=sd,format=raw,file={disk}{cache}','-bios',self.qemu.with_name('rpi5-bl31.bin'),
                  '-append',cmdline,
                  '-chardev','socket,id=wm1302-air,path=radio,server=on,wait=off']
            if self.upgrade and not inspection:
                media = str(self.upgrade).replace(',', ',,')
                args.extend(['-drive',f'if=none,id=update,format=raw,readonly=on,file={media}','-device','usb-storage,drive=update'])
            with self.stderr(f'qemu-{self.boots}.stderr', 'wb') as stderr:
                self.process=subprocess.Popen(args,cwd=d,pass_fds=(b.fileno(),),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr)
        if inspection:
            report = self.expect(rb'\r?\nOSI_INSPECT_(READY|FAILED)\r?\n', 180)
            if report.group(1) != b'READY':
                raise RuntimeError('inspection shell could not mount the persistent overlay')
            self.send(b'stty -echo\n')
            return
        if before_console is not None:
            return self.expect(before_console, 300).groups()
        self.expect(b'Please press Enter to activate this console',180)
        self.send(b'\n')
        self.expect(b':~#',40)
        self.send(b'stty -echo; dmesg -n 1\n')
        self.command('true')

    def stderr(self, filename, mode):
        return open(os.devnull, mode) if self.private else (self.work/filename).open(mode)

    def send(self, data):
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def expect(self, pattern, timeout):
        limit=time.monotonic()+timeout
        while True:
            match=re.search(pattern,self.buf,re.S)
            if match:
                self.buf=self.buf[match.end():]
                return match
            wait=limit-time.monotonic()
            if wait<=0 or not select.select([self.process.stdout],[],[],wait)[0]:
                raise TimeoutError('guest serial timed out')
            chunk=os.read(self.process.stdout.fileno(),65536)
            if not chunk:
                raise RuntimeError('guest serial closed')
            self.buf=(self.buf+chunk)[-2_000_000:]

    def command(self, shell, timeout=90, *, until=None):
        tag=secrets.token_hex(8)
        raw = shell.encode()
        lines = []
        for i in range(0, len(raw), 96):
            octal = ''.join('\\%03o' % byte for byte in raw[i:i+96])
            lines.append("printf '%b' '" + octal + "' >>/tmp/osi-test-command")
        script = ": >/tmp/osi-test-command\n" + "\n".join(lines) + "\n"
        script += f"sh /tmp/osi-test-command >/tmp/osi-test-out 2>/dev/null; rc=$?; printf '\\nBEGIN{tag}\\n'; hexdump -v -e '1/1 \"%02x\"' /tmp/osi-test-out; printf '\\nEND{tag} %d\\n' \"$rc\"; rm -f /tmp/osi-test-command /tmp/osi-test-out\n"
        self.send(script.encode())
        complete = fr'BEGIN{tag}\r?\n(?P<output>[0-9a-f]*)\r?\nEND{tag} (?P<status>\d+)\r?\n'.encode()
        pattern = complete if until is None else b'(?P<marker>' + until + b')|' + complete
        m = self.expect(pattern, timeout)
        if until is not None and m['marker'] is not None:
            # Captures inside the marker, excluding its wrapper and command status.
            return None, m.groups()[1:-2]
        return int(m['status']), bytes.fromhex(m['output'].decode()).decode(errors='replace').strip()

    def stop(self, cut=False):
        exits = {}
        errors = []
        for attr in ('process', 'bridge'):
            process = getattr(self, attr)
            if process is None:
                continue
            try:
                exits[attr] = reap(process, cut=cut and attr == 'process')
                setattr(self, attr, None)
            except Exception as exc:
                errors.append(exc)
            for pipe in (process.stdin, process.stdout):
                if pipe is not None:
                    try:
                        pipe.close()
                    except OSError as exc:
                        errors.append(exc)
        for attr, code in exits.items():
            label = 'qemu' if attr == 'process' else 'bridge'
            try:
                (self.receipts/f'{label}-{self.boots}.exit').write_text(f'{code}\n')
            except OSError as exc:
                errors.append(exc)
        if errors:
            raise ExceptionGroup('guest cleanup or exit receipt failed', errors)

    def upgrade_reboot(self, shell, *, before_console=None):
        self.send((shell+'\n').encode())
        self.process.wait(timeout=600)
        self.stop()
        with (self.work/'sd.img').open('rb') as disk:
            offset=struct.unpack_from('<I',disk.read(512),454)[0]*512
        with tempfile.TemporaryDirectory(dir=self.work) as tmp:
            boot_config.load(f'{self.work}/sd.img@@{offset}',Path(tmp),self.qemu.with_name('dtmerge'), quiet=self.private)
            for name in ('kernel_2712.img','bcm2712-rpi-5-b.dtb','cmdline.txt'):
                (Path(tmp)/name).replace(self.work/name)
        return self.start(before_console=before_console)

    def flows_receipt(self):
        code, output = self.command("""set -e
target=$(readlink -f /srv/node-red/flows.json)
digest=$(sha256sum "$target")
case "$target" in
    /srv/node-red/flows.json)
        test ! -L /srv/node-red/payloads/active
        stamp=image
        ;;
    /srv/node-red/payloads/*/flows.json)
        active=$(readlink -f /srv/node-red/payloads/active)
        test "$active" = "${target%/flows.json}"
        stamp=${active##*/}
        ;;
    *) exit 1 ;;
esac
printf '%s %s\n' "${digest%% *}" "$stamp"
""")
        if code or not re.fullmatch(r'[0-9a-f]{64} [A-Za-z0-9_-]+', output):
            raise RuntimeError('could not read committed flow digest and payload stamp')
        return tuple(field.encode() for field in output.split())

    def verify_flows_receipt(self, expected):
        observed = self.flows_receipt()
        with (self.receipts/'flows-cut.log').open('a') as log:
            for label, receipt in [('committed', expected), ('recovered', observed)]:
                print(label, *(field.decode() for field in receipt), file=log)
        if observed != expected:
            raise RuntimeError('recovered flows digest or active payload stamp differs from commit')

    def verify_cut_disk(self, label, expected, *, inspect=None, alternatives=()):
        if self.process is not None or self.bridge is not None or not self.direct_io:
            raise RuntimeError('disk inspection requires a reaped direct-I/O guest')
        clone = self.work/'inspect.img'
        audit = self.receipts/'flows-cut.log'
        with audit.open('a') as log:
            print(label, 'expected', *(part.decode() for part in expected), file=log)
            for alternative in alternatives:
                print(label, 'alternative', *(part.decode() for part in alternative), file=log)
        try:
            subprocess.run(['cp', '--reflink=auto', '--sparse=always', self.work/'sd.img', clone],
                           check=True)
            self.start(inspection=True)
            observed = self.flows_receipt()
            with audit.open('a') as log:
                print(label, 'disk', *(part.decode() for part in observed), file=log)
            if observed not in (expected, *alternatives):
                raise RuntimeError('on-disk flows digest or payload stamp differs before recovery')
            if inspect is not None:
                inspect(self)
        finally:
            self.stop(cut=True)
            clone.unlink(missing_ok=True)

    def reboot(self):
        self.upgrade_reboot('sync && reboot')
