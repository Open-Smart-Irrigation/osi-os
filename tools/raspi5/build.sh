#!/usr/bin/env bash
# Build the board into QEMU without changing a system installation.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=tools/raspi5/fetch-source.sh
source "$here/fetch-source.sh"
build_dir=${1:?usage: build.sh NEW_BUILD_DIRECTORY}
mkdir "$build_dir"
cd "$build_dir"
# QEMU 10.1.0 (commit f8b2f64e2336a28bf0d50b6ef8a7d8c013e9bcf3).
# Its release archive includes the locked Meson inputs and Python wheels.
fetch_tree https://download.qemu.org/qemu-10.1.0.tar.xz \
    e0517349b50ca73ebec2fa85b06050d5c463ca65c738833bd8fc1f15f180be51 qemu
cd qemu
install -m 644 "$here/bcm2712-watchdog.h" hw/arm/bcm2712-watchdog.h
install -m 644 "$here/bcm2712-rng.h" hw/arm/bcm2712-rng.h
install -m 644 "$here/bcm2712-pcie.h" hw/arm/bcm2712-pcie.h
install -m 644 "$here/raspi5b.c" hw/arm/raspi5b.c
install -m 644 "$here/wm1302-spi.h" hw/arm/wm1302-spi.h
install -m 644 "$here/hat-atecc.h" hw/arm/hat-atecc.h
install -m 644 "$here/hat-gnss.h" hw/arm/hat-gnss.h
install -m 644 "$here/rp1-fan.h" hw/arm/rp1-fan.h
install -m 644 "$here/rp1-gpio.h" hw/arm/rp1-gpio.h
install -m 644 "$here/wm1302-i2c.h" hw/arm/wm1302-i2c.h
install -m 644 "$here/pi5-wifi.c" hw/sd/pi5-wifi.c
echo '#include "pi5-wifi.c"' >> hw/sd/sd.c
sed -i "s/'raspi4b.c'/'raspi4b.c', 'raspi5b.c'/" hw/arm/meson.build
./configure --target-list=aarch64-softmmu --disable-docs --disable-debug-info --disable-download --enable-fdt=system
ninja -C build -j "${JOBS:-4}" qemu-system-aarch64
build/qemu-system-aarch64 -machine help | grep '^raspi5b '

# Use Raspberry Pi's own parameter/overlay merger on the factory FAT files.
cd ..
fetch_tree https://codeload.github.com/raspberrypi/utils/tar.gz/5e9e2da862917107d5819be4a8903d9560595b9e \
    2ccde1fa1b62abdc1c852a3e1abc317cdf3671bb26e981f7dd8fc8577b89763c pi-utils
cc -O2 pi-utils/dtmerge/dtmerge.c pi-utils/dtmerge/dtoverlay.c -lfdt -o qemu/build/dtmerge

# Build Raspberry Pi's Arm EL3 runtime for the BCM2712.
fetch_tree https://codeload.github.com/raspberrypi/arm-trusted-firmware/tar.gz/96922f8b04da6d00f84cc6e92cab1aecdfa5d781 \
    af8cb85ff4572072c4ba57bab9de06312d9b2bfe23ce9d674b394a2d730725bd tfa
make -C tfa -j "${JOBS:-4}" PLAT=rpi5 CROSS_COMPILE="${CROSS_COMPILE:-aarch64-linux-gnu-}" bl31
install -m 644 tfa/build/rpi5/release/bl31.bin qemu/build/rpi5-bl31.bin

eeprom=https://raw.githubusercontent.com/raspberrypi/rpi-eeprom/439fc2e934737cb6b718b837ec0870ac85bf7409
fetch_verified "$eeprom/rpi-eeprom-config" \
    1374a5ac161fca898b1010a882c71e10153ac2723258c3b9d2e34d5cc1a7ee74 qemu/build/rpi-eeprom-config
fetch_verified "$eeprom/LICENSE" \
    594b7565fd3ccf8acd4711a2ec1b199181aafbc3426d0bacaa50ef40edbf7c4a qemu/build/rpi-eeprom.LICENSE
chmod +x qemu/build/rpi-eeprom-config
