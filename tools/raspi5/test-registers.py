#!/usr/bin/env python3
"""Exercise Pi 5 register behavior on QEMU's virtual clock."""
import argparse
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
for name in ('qemu', 'kernel', 'dtb'):
    parser.add_argument('--' + name, required=True)
args = parser.parse_args()
config = tempfile.NamedTemporaryFile()
contents = b"[all]\nBOOT_ORDER=0xf461\n"
config.write(contents)
config.flush()
flash = tempfile.NamedTemporaryFile()
flash.write(b'\xff' * (2 << 20))
flash.flush()
command = [args.qemu, '-machine', f'raspi5b,accel=qtest,bootloader-config={config.name}', '-m', '1G',
           '-drive', f'if=mtd,file={flash.name},format=raw',
           '-kernel', args.kernel, '-dtb', args.dtb, '-display', 'none',
           '-serial', 'none', '-monitor', 'none', '-qtest', 'stdio',
           '-qtest-log', '/dev/null']
with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                      text=True) as qemu:
    def request(message):
        qemu.stdin.write(message + '\n')
        qemu.stdin.flush()
        fields = qemu.stdout.readline().split()
        if not fields or fields[0] != 'OK':
            raise RuntimeError(f'{message} returned {fields}')
        return int(fields[1], 0) if len(fields) > 1 else None

    def write(address, value):
        request(f'writel {address:#x} {value:#x}')

    def read(address):
        return request(f'readl {address:#x}')

    try:
        for off in range(0, len(contents), 4):
            assert read(0x38000 + off) == int.from_bytes(contents[off:off + 4], 'little')
        gpio = 0x107d508500
        spi = 0x107d004000
        write(gpio + 4, 2)
        write(gpio + 8, 0xfffffffd)

        def flash_transfer(data):
            write(gpio + 4, 0)
            write(spi, 0xb0)  # clear FIFOs, transfer active
            reply = []
            for byte in data:
                write(spi + 4, byte)
                reply.append(read(spi + 4) & 255)
            write(spi, 0)
            write(gpio + 4, 2)
            return bytes(reply)

        assert flash_transfer([0x9f, 0, 0, 0])[1:] == bytes.fromhex('c22015')
        flash_transfer([6])  # write enable, then program a byte
        flash_transfer([2, 0, 1, 0, 0x5a])
        assert flash_transfer([3, 0, 1, 0, 0])[-1] == 0x5a
        flash_transfer([6])
        flash_transfer([0x20, 0, 0, 0])  # erase the containing sector
        assert flash_transfer([3, 0, 1, 0, 0])[-1] == 0xff

        pm = 0x107d200000
        write(pm + 0x24, 0x10000)
        assert read(pm + 0x24) == 0, 'watchdog accepted an unkeyed write'
        write(pm + 0x24, 0x5a010000)
        write(pm + 0x1c, 0x5a000020)
        request('clock_step 500000000')
        assert read(pm + 0x24) == 32768, 'watchdog countdown'
        write(pm + 0x1c, 0x5a000102)
        request('clock_step 1000000000')
        assert read(pm + 0x20) & 0x40 == 0, 'disabled watchdog fired'
        write(pm + 0x1c, 0x5a000020)
        request('clock_step 1000000000')
        assert read(pm + 0x20) & 0x40, 'watchdog expiry'

        bank = 0x1001504318
        write(bank, 0x1234)
        write(bank + 4, 0x30)
        assert read(bank + 8) == 0x1204, 'reset bank set/clear'
        rng = 0x107d208000
        write(rng, 1)
        request('clock_step 64000')
        assert read(rng + 0x24) == 2, 'RNG FIFO fill rate'
        read(rng + 0x20)
        assert read(rng + 0x24) == 1, 'RNG FIFO consume'
        write(rng, 0)
        assert read(rng + 0x24) == 0, 'RNG disabled'
        systimer = 0x107c003000
        counter = read(systimer + 4)
        write(systimer + 0x10, (counter + 1000) & 0xffffffff)
        request('clock_step 1000000')
        assert read(systimer) & 2, 'system timer comparator'
        write(systimer, 2)
        assert read(systimer) & 2 == 0, 'system timer acknowledgement'

        host = 0x1000120000
        cfg = host + 0x8000
        write(host + 0x9000, 1 << 20)
        assert read(cfg) == 0x00011de4
        write(cfg + 0x10, 0x410000)
        write(cfg + 0x14, 0)
        write(cfg + 4, 2)
        table = 0x1f00410000
        write(table, 0xfffff000)
        write(table + 4, 0xff)
        write(table + 8, 0)
        write(cfg + 0x50, 0xc0000000)
        write(0x1f00108008, 3)  # RP1 vector zero enable + test
        assert read(table + 0x1000) == 1, 'function mask did not pend MSI-X'
        write(cfg + 0x50, 0x80000000)
        assert read(table + 0x1000) == 0, 'function unmask did not replay MSI-X'
        print('EEPROM memory, watchdog, timers, RNG, reset bank and MSI-X checks passed')
    finally:
        qemu.terminate()
        config.close()
        flash.close()
