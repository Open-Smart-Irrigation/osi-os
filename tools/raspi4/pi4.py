"""Run shared candidate checks on the ARMv7 BCM2711 guest."""
from pathlib import Path
import os
import select
import shutil
import signal
import struct
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'raspi5'))
import acceptance
import boot_config
from suite_vm import Guest
from upgrade_suite import checked

DTB = 'bcm2711-rpi-4-b.dtb'
FDT_ADDRESS = 0x3000000


class Pi4(Guest):
    usb_storage = 'usb-storage,bus=xhci.0,drive=update'
    boot_files = ('kernel.img', DTB, 'cmdline.txt', 'armstub.bin')
    console_args = 'console=ttyAMA0,115200 earlycon=pl011,mmio32,0xfe201000'

    @staticmethod
    def load_boot(volume, work, dtmerge, *, quiet=False):
        boot_config.load(volume, work, dtmerge, board='pi4', quiet=quiet)
        dtb = work / DTB
        put = shutil.which('fdtput') or dtmerge.with_name('fdtput')

        def prop(kind, node, name, *values):
            subprocess.run([put, '-t', kind, dtb, node, name, *values], check=True)

        subprocess.run([put, '-p', '-t', 'x', dtb, '/system', 'linux,revision', 'b03115'], check=True)
        # BCM2711 with 2 GiB, 64 MiB reserved for VideoCore below 1 GiB.
        prop('x', '/memory@0', 'reg', '0', '0', '3c000000', '0', '40000000', '40000000')
        prop('s', '/soc/serial@7e201000', 'status', 'okay')
        # Upstream BCM2835 SPI exposes the FIFO and IRQ, but no DMA requests.
        for name in ('dmas', 'dma-names'):
            subprocess.run([put, '-d', dtb, '/soc/spi@7e204000', name], check=True)
        # C0 stepping exposes the native DMA window on eMMC2.
        prop('x', '/emmc2bus', 'dma-ranges', '0', '0', '0', '0', '80000000')
        source = work/'armstub.bin'
        if not source.exists():
            source = dtmerge.with_name('armstub8-32-gic.bin')
        stub = bytearray(source.read_bytes())
        if len(stub) < 0x100 or struct.unpack_from('<I', stub, 0xf0)[0] != 0x5afe570b:
            raise ValueError('invalid Pi 4 AArch32 GIC armstub')
        struct.pack_into('<IIII', stub, 0xf0, 0, 0, FDT_ADDRESS, 0x8000)
        (work/'armstub.bin').write_bytes(stub)

    def wait_for_reboot(self):
        # A full stdout pipe can block the virtual UART before watchdog reset.
        deadline = time.monotonic() + 600
        while self.process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise TimeoutError('guest did not reboot')
            if not os.read(self.process.stdout.fileno(), 65536):
                break
        code = self.process.wait(timeout=max(0.1, deadline - time.monotonic()))
        if code:
            raise RuntimeError(f'QEMU exited with status {code} during guest reboot')

    def qemu_args(self, wire_fd, disk, cmdline, inspection):
        # AArch32 starts through the raw loader, so Linux takes bootargs from
        # the DTB. Use a separate DTB for the inspection-only PID 1.
        if len(cmdline.encode()) >= 1024:
            raise ValueError('Pi 4 bootargs exceed the ARM kernel command-line limit')
        dtb = self.work / DTB
        if inspection:
            dtb = Path(shutil.copyfile(dtb, self.work/'inspect.dtb'))
        put = shutil.which('fdtput') or self.qemu.with_name('fdtput')
        subprocess.run([put, '-t', 's', dtb, '/chosen', 'bootargs', cmdline], check=True)
        return [self.qemu, '-M', 'raspi4b', '-m', f'{self.ram}G',
                '-global', 'cortex-a72-arm-cpu.aarch64=off',
                '-global', 'cortex-a72-arm-cpu.cntfrq=54000000',
                '-global', 'arm_gic.has-security-extensions=on',
                '-no-reboot', '-display', 'none', '-monitor', 'none', '-serial', 'stdio',
                '-nic', f'socket,fd={wire_fd}',
                '-drive', disk,
                '-device', 'nec-usb-xhci,id=xhci,bus=pcie.1,addr=0,msi=off,msix=off',
                '-chardev', 'socket,id=wm1302-air,path=radio,server=on,wait=off',
                '-device', 'loader,file=armstub.bin,addr=0,force-raw=on,cpu-num=0',
                '-device', 'loader,file=kernel.img,addr=0x8000,force-raw=on',
                '-device', f'loader,file={dtb.name},addr={FDT_ADDRESS},force-raw=on']


def verify(vm):
    checked(vm, """test "$(uname -m)" = armv7l &&
grep -q 'Raspberry Pi 4 Model B' /proc/device-tree/model &&
test "$(grep -c '^processor' /proc/cpuinfo)" = 4 &&
test "$(basename "$(readlink -f /sys/class/net/eth0/device/driver)")" = bcmgenet &&
grep -qi xhci /sys/bus/usb/devices/usb*/product""")


def terminate(_signum, _frame):
    # Let the shared runner reap QEMU and remove managed scratch on timeout.
    raise SystemExit(124)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, terminate)
    raise SystemExit(acceptance.main(board='pi4', guest_class=Pi4, memory=(2,), verify_board=verify))
