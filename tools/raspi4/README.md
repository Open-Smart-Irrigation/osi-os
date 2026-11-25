# Boot the OSI Raspberry Pi 4 image in QEMU

The Pi 4 gate boots the shipped 32-bit ARMv7 bcm2709 image on the BCM2711
`raspi4b` machine. The launcher reads the factory FAT partition, applies the
Pi 4 device-tree overlays with Raspberry Pi's `dtmerge`, and starts Linux on
four Cortex-A72 cores with the AArch32 GIC armstub.

The model connects the removable card to eMMC2, implements the firmware GPIO
expander commands used by the SD regulators and maps the PCIe window used by
the kernel. The guest exercises GENET and a PCIe xHCI controller with INTx.
The HAT uses GPIO8 for SPI chip select, GPIO17 for reset and I²C1 for the
STTS751 temperature sensor. The shared SX1302 model exchanges simulated
packets over a Unix socket. The BCM2835 SPI driver uses programmed I/O.

The model's Ethernet port carries the fixed address 52:54:00:27:11:04. The
launcher writes it into the device tree as `local-mac-address`, because the
bcmgenet driver reads eth0's address only there on a device-tree boot, and
passes it to QEMU on `-nic`. The Pi 5 model keeps QEMU's default,
52:54:00:12:34:56. The gateway derives its provisional EUI from the address,
so it stays the same on every boot. The runbook lists what each run records.

## Build on Linux

Install the compiler and QEMU prerequisites on the build host. For Ubuntu
24.04, use the packages below. Set `BUILD_ROOT` to an existing directory
outside Git trees and `/tmp`, for example `$HOME/builds`.

```sh
sudo apt-get install build-essential curl ninja-build python3-venv python3-pip python3-setuptools python3-wheel pkg-config libglib2.0-dev libpixman-1-dev libfdt-dev flex bison device-tree-compiler gcc-arm-linux-gnueabihf
osi-heavy wait --contain --need-gib 8 -- tools/raspi4/build.sh "$BUILD_ROOT/pi4-qemu"
```

Point `--qemu` at `$BUILD_ROOT/pi4-qemu/qemu/build/qemu-system-aarch64`.
Keep the generated `dtmerge` and `armstub8-32-gic.bin` beside that binary.
Install `fdtput` from the host device-tree tools.

### Source pins and licences

| Input | Commit | Licence in the fetched source |
| --- | --- | --- |
| QEMU, including its bundled Python wheels | `206c72c719c6542bfefed2a7122c14a7ef5541ce` | GPL-2.0 as a whole. See QEMU's `LICENSE` and component notices. |
| keycodemapdb | `f5772a62ec52591ff6870b7e8ef32482371f22c6` | BSD-3-Clause or GPLv2. See `LICENSE.BSD` and `LICENSE.GPL2`. |
| Berkeley SoftFloat | `b64af41c3276f97f0e181920400ee056b9c88037` | BSD-3-Clause, `COPYING.txt` |
| Berkeley TestFloat | `e7af9751d9f9fd3b47911f51a5cfd08af256a9ab` | BSD-3-Clause, `COPYING.txt` |
| Raspberry Pi utils, for `dtmerge` | `5e9e2da862917107d5819be4a8903d9560595b9e` | BSD-3-Clause, `LICENCE` |
| Raspberry Pi tools, for `armstub7.S` | `439b6198a9b340de5998dd14a26a0d9d38a6bcac` | BSD-3-Clause notice in the assembly source |

[build.sh](build.sh) verifies the SHA-256 of each download before use and
disables QEMU's dependency downloads. The Pi 4 QEMU model files carry
GPL-2.0-or-later notices and build into the separate host QEMU executable.
See [COPYING](COPYING). The OSI test driver is MIT-licensed.

## Run release acceptance

The [Pi 4 runbook](../../docs/build/raspi4-emulator-acceptance.md) lists the
candidate and upgrade inputs, the invocation and the receipts to retain.
The emulator starts at the Arm stub. Early firmware, including EEPROM and
VideoCore execution, VL805 firmware, USB timing, RF and antenna behavior,
physical SD power loss and valve movement require hardware coverage. The
software checks exercise simulated radio packets and valve state changes.
