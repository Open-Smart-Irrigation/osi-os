#!/bin/sh
set -eu

environment="$1"
test -f "conf/$environment/.config"
test -f "conf/$environment/patches/series"
test -f "conf/$environment/approved-rootfs.sh"

rm -rf openwrt/.pc
mkdir -p openwrt/.pc openwrt/target/linux/bcm27xx/image
cp "conf/$environment/patches/series" openwrt/.pc/series
cp "conf/$environment/patches/series" openwrt/.pc/applied-patches
cp "conf/$environment/approved-rootfs.sh" openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh
rm -f conf/.config openwrt/.config
ln -s "$environment/.config" conf/.config
ln -s ../conf/.config openwrt/.config
printf 'switch-env:%s\n' "$environment" >> "$OSI_FIXTURE_LOG"
