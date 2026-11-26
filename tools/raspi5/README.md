# Boot an OSI Raspberry Pi 5 image in QEMU

The `raspi5b` machine boots the kernel and SquashFS shipped in the OSI BCM2712 factory image. It reports a revision 1.1 Pi 5 with the board revision code for the selected 1, 2, 4, 8 or 16 GiB RAM size. The radio model targets Seeed's WM1302 SPI US915-M (SKU 114992969), on Seeed's WM1302 Raspberry Pi HAT (SKU 113100022). [Seeed module specification](https://files.seeedstudio.com/Bazaar/product_pdf/114992969.pdf)

The HAT v1.0 schematic connects SX1302 chip select to GPIO8 and reset to GPIO17. The regulator enable is pulled up to 5 V. GPIO18 carries the auxiliary radio's BUSY signal. The shipped ChirpStack profile drives GPIO18 during startup. The HAL probe verifies that the SX1302 still answers with GPIO18 low. The HAT also carries an L76KB GNSS receiver and an ATECC608B secure element. [Seeed carrier](https://www.seeedstudio.com/WM1302-Pi-Hat-p-4897.html) · [HAT v1.0 schematic](https://files.seeedstudio.com/products/113100022/WM1302%20Pi%20Hat%20v1.0.pdf)

## Build on Linux

On Ubuntu 24.04, install the host dependencies, build QEMU and the Pi 5 EL3 firmware, and cross-compile the optional guest radio probe. Each script takes a new output directory. The build downloads source from the pins below and checks SHA-256 before extraction or execution. QEMU configuration runs with downloads disabled.

```sh
sudo apt-get install build-essential curl xz-utils ninja-build python3-venv pkg-config libglib2.0-dev libpixman-1-dev libfdt-dev flex bison mtools gcc-aarch64-linux-gnu libc6-dev-arm64-cross
osi-heavy wait --contain --need-gib 8 -- tools/raspi5/build.sh ~/osi-pi5-build
osi-heavy wait --contain --need-gib 2 -- tools/raspi5/build-probe.sh ~/osi-radio-build
```

### Source pins and licences

| Input | Pin | Licence in the fetched source |
| --- | --- | --- |
| QEMU source release and its bundled build dependencies | 10.1.0, commit `f8b2f64e2336a28bf0d50b6ef8a7d8c013e9bcf3` | GPL-2.0 as a whole. See `LICENSE` and component notices. The Pi 5 model sources in this directory carry GPL-2.0-or-later tags. |
| Raspberry Pi utils, for `dtmerge` | `5e9e2da862917107d5819be4a8903d9560595b9e` | BSD-3-Clause, `LICENCE` |
| Raspberry Pi Trusted Firmware-A, for BL31 | `96922f8b04da6d00f84cc6e92cab1aecdfa5d781` | BSD-3-Clause, `license.rst` and component notices |
| Raspberry Pi EEPROM config tool | `439fc2e934737cb6b718b837ec0870ac85bf7409` | BSD-3-Clause for the extractor, `rpi-eeprom.LICENSE` |
| Semtech SX1302 HAL, for the optional guest probe | `587f4c28ecab91a96e65ac3b2686101a2b768727` | BSD-3-Clause, `LICENSE.TXT` |

The hashes live next to the download URLs in `build.sh` and `build-probe.sh`.
The workstation supplies the host libraries, compiler and build tools.
Build outputs, factory images and the optional EEPROM image stay outside the checkout.

The files tagged `GPL-2.0-or-later` build into the separate host QEMU executable.
The repo's MIT licence covers the OSI code, and the model stays outside the
firmware payload. The model's licence text is in [COPYING](COPYING).

## Run the image

```sh
tools/raspi5/run.py --qemu ~/osi-pi5-build/qemu/build/qemu-system-aarch64 \
    --ram-gib 8 --smoke path/to/rpi5-factory.img.gz
```

Omit `--smoke` for an interactive serial console. Press Ctrl-A then X to quit. Raw and gzip-compressed factory SD images are accepted. The launcher reads the OSI config.txt includes and Pi model sections, selects the kernel, DTB and command line from FAT, applies dtparam and dtoverlay with Raspberry Pi’s dtmerge, and pads a disposable sparse copy to the partitioned card capacity. Guest writes go to the copy. Set `TMPDIR` to a filesystem with room for image extraction and first-boot overlay writes.

The smoke test waits for four CPUs, a mounted SquashFS root and a working shell. It checks the reported memory size, SD root partition, ubus board response, CPU temperature readout and PWM fan tachometer response. To exercise the radio, Ethernet and USB mass storage in the same guest, use the combined test command.

```sh
tools/raspi5/run.py --qemu ~/osi-pi5-build/qemu/build/qemu-system-aarch64 \
    --ram-gib 8 --wm1302 --radio-probe ~/osi-radio-build/probe-wm1302 \
    --packet-test --ethernet-test --usb-test path/to/rpi5-factory.img.gz
```

The build installs Raspberry Pi’s BCM2712 Trusted Firmware-A beside QEMU as `rpi5-bl31.bin`. The launcher starts all four A76 cores at the firmware reset vector. BL31 initializes the interrupt controller, runs PSCI at EL3, releases the secondary cores and enters the image’s Linux kernel. The serial console shows the BL31 banner before Linux. A boot partition can supply its own BCM2712 stub through `armstub=` in config.txt. An explicit host-side armstub override requires `--armstub PATH --armstub-sha256 SHA256`. If the default kernel_2712.img is missing, the launcher searches for kernel8.img. [Raspberry Pi BCM2712 platform source](https://github.com/raspberrypi/arm-trusted-firmware/tree/96922f8b04da6d00f84cc6e92cab1aecdfa5d781/plat/rpi/rpi5)

Pass `--eeprom pieeprom.bin --eeprom-sha256 SHA256` to test the SD boot selection of a 2 MiB BCM2712 EEPROM image. The launcher reads its configuration using Raspberry Pi’s extractor, follows the boot-order nibbles to the attached SD card, and copies the configuration into the guest’s reserved bootloader-config memory. The guest’s SPI10 controller also exposes a disposable copy of the EEPROM through `/dev/spidev10.0`. GPIO1 drives chip select on a representative 2 MiB MX25L1606E NOR model. The radio probe reads the JEDEC ID and checks three flash pages against the supplied file. EEPROM settings are read once per launcher invocation. The OSI 0.8.2 kernel exposes this reservation in the device tree and lacks the reserved-memory nvmem driver. The launcher reports an error for signed-boot configurations and boot orders that stop or restart before reaching SD. [Raspberry Pi EEPROM distribution](https://github.com/raspberrypi/rpi-eeprom)

Use `--reboot-test` to restart the guest and check that a marker on the writable overlay survives the second boot.

The optional tests stage the probe and service-check script on the disposable boot partition. The probe checks RMC and GGA sentences on the carrier UART and the ATECC608B wake and revision responses on I²C. It pulses reset on GPIO17 and uses the Semtech HAL to read the SX1302 OTP and PPS counter, tune both SX1250s and read the STTS751 temperature fixture. The packet check injects an uplink on IF channel 0, verifies the HAL's payload and CRC status, and receives immediate and timestamped downlinks. The service check starts the image's ChirpStack Concentratord with its Seeed US915 configuration and reads the synthetic gateway ID over its command socket. With both radio tests enabled, the factory MQTT forwarder publishes an injected frame at 902.3 MHz to a guest-local broker. The test submits a 923.3 MHz downlink, verifies the concentrator acknowledgement and compares the transmitted bytes at the host radio socket. The Ethernet test exchanges ARP and ICMP with a local peer. The USB test reads a marker from a virtual flash drive. Add `--osi-test` to wait for Node-RED to serve `/gui/` and run a read-only SQLite quick check against the gateway database.

For interactive packet injection, pass `--radio-socket /tmp/wm1302.sock` and configure the guest concentrator. Each Unix stream frame starts with three bytes (payload length, multi-SF IF channel, spreading factor), followed by the raw LoRa PHYPayload. For a frequency-addressed uplink, set the channel byte to 255 and insert a four-byte big-endian frequency in Hz and a bandwidth byte before the payload. Bandwidth code 0 selects 125 kHz. The model uses the HAL-programmed SX1250 center frequency, signed IF offset, channel mask and spreading-factor mask to select a receiver. It accepts carriers within one IF tuning step of nominal and drops other bandwidths on the multi-SF channels. To request a delivery receipt, use channel 254 and put an eight-byte request ID between the bandwidth byte and the PHYPayload. The length byte still counts only the PHYPayload. The model sends `[13, 254, 0]` followed by the request ID, a one-byte count and the four-byte big-endian SX1302 timestamp (32 MHz ticks) it stamped on the frame. The count is 1 when the frame enters the HAL RX FIFO and 0 when it is rejected. The HAL derives the frame's `count_us` from that timestamp. Downlinks use the three-byte format with the RF chain in the second byte. A client that stops draining the socket may be disconnected. The launcher disconnects guest Ethernet by default. Use `--nic` to supply a QEMU network backend.

For the optional EEPROM probe, fetch the May 26, 2026 BCM2712 default image
from raspberrypi/rpi-eeprom commit `439fc2e934737cb6b718b837ec0870ac85bf7409`.

```sh
tools/raspi5/fetch-eeprom.sh "$HOME/pi5-eeprom-fixture"
```

The fetch verifies SHA-256
`fee8bee6a738a1a61004f0770f15534de7a48a2a199dc4c7af7ed73ab04f18dd` for the image
and also checks the upstream `LICENSE` copied beside it. The firmware carries
Raspberry Pi's custom terms for `firmware-2712/*`. Use the digest in
`SHA256SUMS` with `--eeprom-sha256`. The candidate gate uses the pinned BL31
build and verified factory image. [Pinned firmware terms](https://github.com/raspberrypi/rpi-eeprom/blob/439fc2e934737cb6b718b837ec0870ac85bf7409/LICENSE).

## Hardware coverage

The machine implements four Cortex-A76s, PSCI, GIC-400, architectural timers, the BCM2712 debug UART and an SDHCI slot at 3.3 V. Linux uses the RP1 pinctrl, DesignWare SPI and I²C drivers, Cadence GEM Ethernet and two DWC3 host controllers. The kernel enumerates the internal BCM2712 root port and RP1 endpoint, assigns the three PCI BARs and binds its RP1 driver. The driver reads the chip ID through BAR1 and allocates 61 MSI-X vectors. The GIC implements 320 interrupt IDs. The modeled RP1 peripherals use their child nodes on that bus. Interrupts pass through the RP1 interrupt configuration, guest-programmed MSI-X table and BCM2712 MIP destination. The factory reset drivers exercise the BCM2712 software reset and PCIe calibration registers. The second SDHCI controller exposes both CYW43455 SDIO functions with Broadcom device ID 02d0:a9bf. PCIe timing, error recovery, hotplug and external expansion are unmodeled.

The host implements the SD selection, FAT reads, firmware device-tree changes and Arm release that precede BL31. The first guest firmware instructions belong to BL31. The immutable SoC ROM, execution of the EEPROM bootloader, firmware settings beyond the implemented config.txt subset, VideoCore, CYW43455 firmware loading and wireless networking, Bluetooth and the full power controller require additional models. The PM watchdog uses the guest clock for expiry and resets. The RNG200 supplies guest randomness through its FIFO. The SD clock and power registers retain writes. The concentrator temperature sensor returns 25 °C. The CPU temperature register supplies a fixed sample and fan speed follows PWM duty on a linear 0–5000 RPM curve. The SX1302 acknowledges known guest-uploaded firmware through a behavioral mailbox model. Packet tests operate on decoded bytes and simulated timestamps. The GNSS fixture emits RMC and GGA from a fixed synthetic position and drives the concentrator PPS input. The ATECC608B model implements wake, idle, sleep and silicon revision discovery. Cryptographic commands, satellite acquisition, GNSS receiver configuration and auxiliary radio operation require additional models. RF sensitivity, interference, spectral scanning, precise radio timing and board-level electrical behavior require hardware validation.


A published Pi 5 hardware console trace shows the EEPROM reading FAT and selecting the board DTB before BL31, the Cortex-A76 r4p1 ID and RP1’s 61 MSI-X interrupts. These markers provide comparison points across operating systems. The emulator’s boot times, DDR training and RF performance have no corresponding physical measurements. [QNX Raspberry Pi 5 board bring-up](https://www.qnx.com/developers/docs/BSP8.0/com.qnx.doc.bsp_raspberrypi.bcm2712.rpi5_8.0/topic/bsp_boot_board.html)

## OSI release-candidate acceptance

The default candidate suite runs on the build workstation through `osi-heavy`.
The release runbook lists the input artifacts, fixture selection and evidence to retain.
[Run the acceptance gate](../../docs/build/raspi5-emulator-acceptance.md).
Use `--tailscale-boot-only` for the tailscale boot cases; the same page
describes them. `OSI_HEAVY_LABEL` sets the slot label of a focused run.

Every boot wait notes its elapsed time against its budget, in the case
directory's `harness-events.log` and at the end of the case's results line:
`api ready after 512.3 s (budget 900 s)`. The API wait after a start allows
420 s; the Pi 4 runner gives it 900 s (`tools/raspi4/pi4.py`). An API wait
longer than 600 s also keeps `boot-timing-N.syslog` and `boot-timing-N.txt` in
the case directory: the boot's phase lines from the guest's persistent syslog,
and their timing. The read goes by that file's inode, so a log logd rotated
since the console answered is still read. The boot begins in the log where the
guest clock last went backwards; a phase whose start lies before that says so.
`python3 tools/raspi5/boot_timing.py SYSLOG` gives the same timing for a kept
syslog. `--api-answer` takes the guest clock the API wait printed at the first
401.

The customer-line 0.7.0 fixture is **PROVISIONAL** and off by default. Release
evidence requires a successful owner-only qualification receipt for the exact
factory archive and 0.8.1 overlay. The receipt records that the factory ROM GUI
differs from the recorded field installation.
