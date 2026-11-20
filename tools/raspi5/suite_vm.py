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


def external_path(path):
    resolved = path.resolve(strict=True)
    for spelling in (path.absolute(), resolved):
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


class Guest:
    def __init__(self, work, image, qemu, ram, upgrade=None, *, receipts=None, private=False):
        self.work = Path(work).resolve()
        self.work.mkdir(mode=0o700)
        self.qemu = Path(qemu).resolve()
        self.ram = ram
        self.upgrade = upgrade
        self.receipts = receipts if receipts is not None else self.work
        self.receipts.mkdir(mode=0o700, exist_ok=True)
        self.private = private
        self.process = self.bridge = None
        self.boots = 0
        prepare(image, self.work, self.qemu.with_name('dtmerge'), quiet=private)
        with socket.socket() as port:
            port.bind(('127.0.0.1', 0))
            self.port = port.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'

    def start(self, *, before_console=None):
        if self.process is not None or self.bridge is not None:
            raise RuntimeError('previous guest or bridge has not been reaped')
        self.boots += 1
        d = self.work
        self.buf = b''
        self.started = time.monotonic()
        a, b = socket.socketpair()
        with a,b,self.stderr('bridge.stderr', 'ab') as err:
            self.bridge = subprocess.Popen(['qemu-system-x86_64','-machine','none','-nodefaults','-display','none','-monitor','none','-serial','none',
                '-netdev',f'socket,id=wire,fd={a.fileno()}','-netdev',f'user,id=local,restrict=on,net=192.0.2.0/24,hostfwd=tcp:127.0.0.1:{self.port}-192.0.2.15:1880',
                '-netdev','hubport,id=a,hubid=0,netdev=wire','-netdev','hubport,id=b,hubid=0,netdev=local'],pass_fds=(a.fileno(),),stdout=subprocess.DEVNULL,stderr=err)
            args=[self.qemu,'-M','raspi5b','-m',f'{self.ram}G','-no-reboot','-display','none','-nic',f'socket,fd={b.fileno()}','-monitor','none','-serial','stdio',
                  '-kernel','kernel_2712.img','-dtb','bcm2712-rpi-5-b.dtb','-drive','if=sd,format=raw,file=sd.img','-bios',self.qemu.with_name('rpi5-bl31.bin'),
                  '-append',(d/'cmdline.txt').read_text().strip()+' console=ttyAMA10,115200 earlycon=pl011,mmio32,0x107d001000',
                  '-chardev','socket,id=wm1302-air,path=radio,server=on,wait=off']
            if self.upgrade:
                media = str(self.upgrade).replace(',', ',,')
                args.extend(['-drive',f'if=none,id=update,format=raw,readonly=on,file={media}','-device','usb-storage,drive=update'])
            with self.stderr(f'qemu-{self.boots}.stderr', 'wb') as stderr:
                self.process=subprocess.Popen(args,cwd=d,pass_fds=(b.fileno(),),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr)
        if before_console is not None:
            return self.expect(before_console, 300).group('digest', 'stamp')
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
            return None, m.group('digest', 'stamp')
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

    def reboot(self):
        self.upgrade_reboot('sync && reboot')
