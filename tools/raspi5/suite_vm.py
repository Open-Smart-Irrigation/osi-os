"""Disposable serial-controlled Pi 5 with an isolated browser forward."""
import base64
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


class Guest:
    def __init__(self, work, image, qemu, ram, upgrade=None):
        self.work = Path(work).resolve()
        self.work.mkdir(mode=0o700)
        self.qemu = Path(qemu).resolve()
        self.ram = ram
        self.upgrade = upgrade
        self.process = self.bridge = None
        self.boots = 0
        prepare(image, self.work, self.qemu.with_name('dtmerge'))
        with socket.socket() as port:
            port.bind(('127.0.0.1', 0))
            self.port = port.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'

    def start(self, *, before_console=None):
        self.boots += 1
        d = self.work
        self.buf = b''
        self.started = time.monotonic()
        a, b = socket.socketpair()
        with a,b,(d/'bridge.stderr').open('ab') as err:
            self.bridge = subprocess.Popen(['qemu-system-x86_64','-machine','none','-nodefaults','-display','none','-monitor','none','-serial','none',
                '-netdev',f'socket,id=wire,fd={a.fileno()}','-netdev',f'user,id=local,restrict=on,net=192.0.2.0/24,hostfwd=tcp:127.0.0.1:{self.port}-192.0.2.15:1880',
                '-netdev','hubport,id=a,hubid=0,netdev=wire','-netdev','hubport,id=b,hubid=0,netdev=local'],pass_fds=(a.fileno(),),stderr=err)
            args=[self.qemu,'-M','raspi5b','-m',f'{self.ram}G','-no-reboot','-display','none','-nic',f'socket,fd={b.fileno()}','-monitor','none','-serial','stdio',
                  '-kernel','kernel_2712.img','-dtb','bcm2712-rpi-5-b.dtb','-drive','if=sd,format=raw,file=sd.img','-bios',self.qemu.with_name('rpi5-bl31.bin'),
                  '-append',(d/'cmdline.txt').read_text().strip()+' console=ttyAMA10,115200 earlycon=pl011,mmio32,0x107d001000',
                  '-chardev','socket,id=wm1302-air,path=radio,server=on,wait=off']
            if self.upgrade:
                args.extend(['-drive',f'if=none,id=update,format=raw,readonly=on,file={self.upgrade}','-device','usb-storage,drive=update'])
            with (d/f'qemu-{self.boots}.stderr').open('wb') as stderr:
                self.process=subprocess.Popen(args,cwd=d,pass_fds=(b.fileno(),),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr)
        if before_console is not None:
            self.expect(before_console, 300)
            return
        self.expect(b'Please press Enter to activate this console',180)
        self.send(b'\n')
        self.expect(b':~#',40)
        self.send(b'stty -echo; dmesg -n 1\n')
        self.command('true')

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
            return None, ''
        return int(m['status']), bytes.fromhex(m['output'].decode()).decode(errors='replace').strip()

    def stop(self, cut=False):
        if self.process:
            if self.process.poll() is None:
                (self.process.kill if cut else self.process.terminate)()
            code=self.process.wait(timeout=15)
            (self.work/f'qemu-{self.boots}.exit').write_text(f'{code}\n')
            self.process.stdin.close()
            self.process.stdout.close()
            self.process=None
        if self.bridge:
            self.bridge.terminate()
            self.bridge.wait(timeout=10)
            self.bridge=None

    def upgrade_reboot(self, shell, *, before_console=None):
        self.send((shell+'\n').encode())
        self.process.wait(timeout=600)
        self.stop()
        with (self.work/'sd.img').open('rb') as disk:
            offset=struct.unpack_from('<I',disk.read(512),454)[0]*512
        with tempfile.TemporaryDirectory(dir=self.work) as tmp:
            boot_config.load(f'{self.work}/sd.img@@{offset}',Path(tmp),self.qemu.with_name('dtmerge'))
            for name in ('kernel_2712.img','bcm2712-rpi-5-b.dtb','cmdline.txt'):
                (Path(tmp)/name).replace(self.work/name)
        self.start(before_console=before_console)

    def reboot(self):
        self.upgrade_reboot('sync && reboot')
