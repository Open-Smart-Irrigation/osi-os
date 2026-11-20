#!/usr/bin/env python3
"""Boot a BCM2712 factory .img or .img.gz on the OSI raspi5b QEMU machine."""
import argparse
import gzip
import hashlib
import os
import selectors
import socket
import sys
import time
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

import boot_config
import ethernet_test


def prepare(source, work, dtmerge, radio_probe=None, concentratord=False):
    # QEMU SD cards require power-of-two capacity. Keep zero padding sparse.
    disk = work / 'sd.img'
    with source.open('rb') as raw:
        compressed = raw.read(2) == b'\x1f\x8b'
        raw.seek(0)
        stream = gzip.GzipFile(fileobj=raw) if compressed else raw
        with disk.open('wb') as out:
            while block := stream.read(1024 * 1024):
                if block.count(0) == len(block):
                    out.seek(len(block), 1)
                else:
                    out.write(block)
            size = out.tell()
            out.truncate(size)
    with disk.open('rb') as f:
        mbr = f.read(512)
    if mbr[510:] != b'\x55\xaa':
        raise ValueError('expected a partitioned factory SD image')
    offset, sectors = struct.unpack_from('<II', mbr, 454)
    if not offset or not sectors or (offset + sectors) * 512 > size:
        raise ValueError('invalid factory boot partition')
    # Factory images omit unused sectors after the SquashFS payload.
    end = size
    for i in range(4):
        start, count = struct.unpack_from('<II', mbr, 454 + 16 * i)
        if count:
            end = max(end, (start + count) * 512)
    with disk.open('r+b') as f:
        f.truncate(1 << (end - 1).bit_length())
    boot_config.load(f'{disk}@@{offset * 512}', work, dtmerge)

    if concentratord:
        check = Path(__file__).with_name('check-concentratord.sh').resolve()
        subprocess.run(['mcopy', '-i', f'{disk}@@{offset * 512}', check, '::osi-test.sh'],
                       check=True)
    if radio_probe:
        subprocess.run(['mcopy', '-i', f'{disk}@@{offset * 512}', radio_probe,
                        '::osi-probe'], check=True)


def rf_frame(payload, frequency, bandwidth=0):
    return struct.pack('>BBBIB', len(payload), 255, 7, frequency, bandwidth) + payload


def smoke(command, work, args, packet_socket, ethernet_socket, pass_fds):
    """Wait for OpenWrt and prove a guest shell can use the mounted root."""
    checks = [
        b'smp: Brought up 1 node, 4 CPUs',
        b'VFS: Mounted root (squashfs filesystem)',
        b'Please press Enter to activate this console.',
    ]
    if '-bios' in command:
        checks = [b'NOTICE:  BL31:', b'PSCIv1.1 detected in firmware'] + checks
    revision = 0xa04171 + ((args.ram_gib.bit_length() - 1) << 20)
    flash_hash = hashlib.sha256()
    if args.eeprom:
        with (work / 'eeprom.bin').open('rb') as flash:
            for offset in (0, 0x80000, 0x1fff00):
                flash.seek(offset)
                flash_hash.update(flash.read(256))
    config = (work / 'bootconf.txt').read_bytes() if args.eeprom else b''
    options = {
        'flash_hash': flash_hash.hexdigest(),
        'bootconf_size': len(config),
        'bootconf_hash': hashlib.sha256(config).hexdigest() if config else '',
        'ram_kib': args.ram_gib * 1024 * 1024,
        'revision': f'{revision:08x}',
        'probe': int(bool(args.radio_probe)),
        'packets': int(args.packet_test),
        'concentratord': int(args.wm1302),
        'ethernet': int(args.ethernet_test),
        'usb': int(args.usb_test),
        'services': int(args.osi_test),
        'rebooted': int(args.reboot_test),
    }
    settings = ''.join(f'{key}={value}\n' for key, value in options.items()).encode()
    script = Path(__file__).with_name('check-guest.sh').read_bytes()
    deadline = time.monotonic() + (600 if args.osi_test or args.reboot_test else 180)
    with subprocess.Popen(command, cwd=work, pass_fds=pass_fds, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as guest:
        try:
            seen = b''
            with selectors.DefaultSelector() as selector:
                selector.register(guest.stdout, selectors.EVENT_READ)
                reboot_pending = args.reboot_test
                markers = checks + [b':~#']
                if reboot_pending:
                    markers += [b'OSI_REBOOT_ARMED'] + checks + [b':~#']
                if packet_socket:
                    markers.append(b'WM1302_READY_FOR_UPLINK')
                    if args.wm1302:
                        markers.append(b'WM1302_SERVICE_LISTENING')
                if ethernet_socket:
                    markers.append(b'OSI_ETHERNET_READY')
                for marker in markers + [b'OSI_BOOT_VERIFIED']:
                    while marker not in seen:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(remaining):
                            raise RuntimeError(f'timeout waiting for {marker!r}')
                        chunk = os.read(guest.stdout.fileno(), 4096)
                        if not chunk:
                            raise RuntimeError(f'guest exited waiting for {marker!r}')
                        sys.stdout.buffer.write(chunk)
                        sys.stdout.buffer.flush()
                        seen = seen[-65536:] + chunk
                        if b'OSI_PROBE_FAILED' in seen:
                            raise RuntimeError('guest verification failed')
                        if b'Kernel panic' in seen:
                            raise RuntimeError('guest kernel panicked')
                    seen = seen.split(marker, 1)[1]
                    if marker == checks[-1]:
                        guest.stdin.write(b'\n')
                        guest.stdin.flush()
                    elif marker == b'WM1302_SERVICE_LISTENING':
                        payload = bytes.fromhex('400403020100010001aabb00000000')
                        with socket.socket(socket.AF_UNIX) as medium:
                            medium.connect(str(packet_socket))
                            medium.sendall(rf_frame(payload, 902300000))
                            medium.settimeout(25)
                            expected = bytes([12, 0, 7]) + b'OSI downlink'
                            if medium.recv(len(expected), socket.MSG_WAITALL) != expected:
                                raise RuntimeError('factory MQTT downlink did not reach the radio socket')
                    elif marker == b'OSI_ETHERNET_READY':
                        ethernet_test.verify(ethernet_socket)
                    elif marker == b'WM1302_READY_FOR_UPLINK':
                        with socket.socket(socket.AF_UNIX) as medium:
                            medium.settimeout(12)
                            medium.connect(str(packet_socket))
                            # Disabled IF and SF must never reach the guest RX FIFO.
                            medium.sendall(bytes([3, 1, 7]) + b'IF!' + bytes([3, 0, 8]) + b'SF!')
                            medium.sendall(rf_frame(b'bad frequency', 905300000))
                            medium.sendall(rf_frame(b'bad bandwidth', 904300000, 2))
                            medium.sendall(rf_frame(b'OSI uplink', 904300000))
                            expected = bytes([12, 0, 7]) + b'OSI downlink'
                            got = medium.recv(len(expected), socket.MSG_WAITALL)
                            if got != expected:
                                raise RuntimeError(f'unexpected WM1302 downlink {got!r}')
                            scheduled = bytes([12, 0, 7]) + b'TSI downlink'
                            if medium.recv(len(scheduled), socket.MSG_WAITALL) != scheduled:
                                raise RuntimeError('missing timestamped downlink')
                            print('WM1302 immediate and timestamped packet tests passed', flush=True)
                    elif marker == b':~#' and reboot_pending:
                        guest.stdin.write(b"while [ \"$(readlink /overlay/.fs_state)\" != 2 ]; "
                                          b"do sleep 1; done; echo persisted > /etc/osi-reboot-test "
                                          b"&& sync && echo OSI_REBOOT_''ARMED && reboot\n")
                        guest.stdin.flush()
                        reboot_pending = False
                    elif marker == b':~#':
                        # Keep lines below the guest's interactive console line limit.
                        guest.stdin.write(b"sh <<'OSI_CHECK' && echo OSI_BOOT_''VERIFIED || "
                                          b"echo OSI_PROBE_''FAILED\n" + settings + script
                                          + b"OSI_CHECK\n")
                        guest.stdin.flush()
            return 0
        finally:
            guest.terminate()
            try:
                guest.wait(timeout=5)
            except subprocess.TimeoutExpired:
                guest.kill()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path)
    parser.add_argument('--eeprom', type=Path, help='consult BOOT_ORDER and expose bootconf.txt from a Pi 5 EEPROM image')
    parser.add_argument('--armstub', type=Path, help='Pi 5 Trusted Firmware-A bl31.bin (defaults to the build alongside QEMU)')
    parser.add_argument('--qemu', default='qemu-system-aarch64')
    parser.add_argument('--ram-gib', type=int, choices=(1, 2, 4, 8, 16), default=2)
    parser.add_argument('--smoke', action='store_true', help='test a fresh boot and exit')
    parser.add_argument('--radio-probe', type=Path, help='stage the ARM64 WM1302 probe on the disposable boot partition')
    parser.add_argument('--wm1302', action='store_true', help='verify the factory Concentratord service with the Seeed US915 profile')
    parser.add_argument('--radio-socket', type=Path, help='serve the packet test medium over a local Unix socket')
    parser.add_argument('--packet-test', action='store_true', help='verify uplink and downlink through the guest HAL (requires --radio-probe)')
    net = parser.add_mutually_exclusive_group()
    net.add_argument('--ethernet-test', action='store_true', help='ping an isolated local Ethernet peer')
    net.add_argument('--nic', help='QEMU NIC backend for eth0, e.g. user,restrict=on (requires libslirp)')
    parser.add_argument('--usb-test', action='store_true', help='read a fixture disk through the guest USB mass-storage driver')
    parser.add_argument('--osi-test', action='store_true', help='wait for the Node-RED GUI and check the gateway SQLite database')
    parser.add_argument('--reboot-test', action='store_true', help='restart the guest kernel and verify overlay persistence')
    args = parser.parse_args()
    if args.packet_test and (not args.radio_probe or args.radio_socket):
        parser.error('--packet-test requires --radio-probe and creates its own radio socket')
    qemu = shutil.which(args.qemu)
    if not qemu or not shutil.which('mcopy'):
        parser.error('raspi5b QEMU and mtools are required')
    with tempfile.TemporaryDirectory(prefix='osi-raspi5-') as tmp:
        work = Path(tmp)
        merger = Path(qemu).resolve().with_name('dtmerge')
        if not merger.is_file():
            merger = shutil.which('dtmerge')
        if not merger:
            parser.error('build.sh supplies the required Raspberry Pi dtmerge alongside QEMU')
        machine = 'raspi5b'
        if args.eeprom:
            extractor = Path(qemu).resolve().with_name('rpi-eeprom-config')
            if not extractor.is_file():
                parser.error('build.sh supplies rpi-eeprom-config alongside QEMU')
            shutil.copyfile(args.eeprom, work / 'eeprom.bin')
            boot_config.read_eeprom(work / 'eeprom.bin', extractor, work)
            machine += ',bootloader-config=bootconf.txt'
        prepare(args.image, work, merger, args.radio_probe, args.wm1302)
        cmdline = (work / 'cmdline.txt').read_text().strip()
        ethernet_socket, guest_socket = socket.socketpair() if args.ethernet_test else (None, None)
        backend = args.nic or 'none'
        if ethernet_socket:
            backend = f'socket,fd={guest_socket.fileno()}'
        command = [
            str(Path(qemu).resolve()), '-M', machine, '-m', f'{args.ram_gib}G', '-nographic', '-nic', backend,
            '-kernel', 'kernel_2712.img', '-dtb', 'bcm2712-rpi-5-b.dtb',
            '-drive', 'if=sd,format=raw,file=sd.img',
            '-append', cmdline + ' console=ttyAMA10,115200 earlycon=pl011,mmio32,0x107d001000',
        ]
        if args.eeprom:
            command.extend(['-drive', 'if=mtd,format=raw,file=eeprom.bin'])
        armstub = args.armstub or work / 'armstub.bin'
        if not args.armstub and not armstub.exists():
            armstub = Path(qemu).resolve().with_name('rpi5-bl31.bin')
        if args.armstub or armstub.is_file():
            command.extend(['-bios', str(armstub.resolve(strict=True))])
        packet_socket = work / 'wm1302.sock' if args.packet_test else None
        if packet_socket:
            args.radio_socket = packet_socket
        if args.usb_test:
            with (work / 'usb.img').open('wb') as fixture:
                fixture.write(b'OSI-USB-LOOPBACK')
                fixture.truncate(1024 * 1024)
            command.extend(['-drive', 'if=none,id=stick,format=raw,file=usb.img,readonly=on',
                            '-device', 'usb-storage,drive=stick'])
        if args.radio_socket:
            sock = str(args.radio_socket.absolute()).replace(',', ',,')
            if args.radio_socket.exists():
                parser.error('radio socket path already exists')
            command.extend(['-chardev', f'socket,id=wm1302-air,path={sock},server=on,wait=off'])
        if args.smoke or args.wm1302 or args.packet_test or args.ethernet_test or args.usb_test or args.osi_test or args.reboot_test:
            return smoke(command, work, args, packet_socket, ethernet_socket,
                         (guest_socket.fileno(),) if guest_socket else ())
        return subprocess.call(command, cwd=work)


if __name__ == '__main__':
    raise SystemExit(main())
