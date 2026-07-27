#!/bin/sh
set -eu

environment="$1"
test -f "conf/$environment/.config"
test -f "conf/$environment/patches/series"
test -f "conf/$environment/approved-rootfs.sh"

printf '%s\n' \
  'Cleaning patch state' \
  'cd openwrt && quilt pop -af || true'
if test -f openwrt/.pc/applied-patches; then
  if grep -Fxq 'image-with-padded-rootfs.patch' openwrt/.pc/applied-patches; then
    printf '%s\n' \
      'Removing patch patches/image-with-padded-rootfs.patch' \
      'Restoring target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh' \
      ''
  fi
  if grep -Fxq 'boot-config.patch' openwrt/.pc/applied-patches; then
    printf '%s\n' \
      'Removing patch patches/boot-config.patch' \
      'Restoring target/linux/bcm27xx/image/config.txt' \
      ''
  fi
  printf '%s\n' 'No patches applied'
else
  printf '%s\n' 'No series file found' >&2
fi
printf '%s\n' \
  'Restoring clean source tree' \
  'cd openwrt && git checkout -- . || true' \
  'cd openwrt && git clean -fd || true' \
  'rm -rf openwrt/.pc' \
  'Switching configuration' \
  'rm -f conf/files conf/patches conf/.config' \
  "ln -s $environment/files conf/files" \
  "ln -s $environment/patches conf/patches" \
  "ln -s $environment/.config conf/.config" \
  'Recreating openwrt symlinks' \
  'rm -f openwrt/.config openwrt/files openwrt/patches' \
  'ln -s ../conf/.config openwrt/.config' \
  'ln -s ../conf/files openwrt/files' \
  'ln -s ../conf/patches openwrt/patches' \
  'Initializing quilt' \
  'mkdir -p openwrt/.pc' \
  'echo "patches" > openwrt/.pc/.quilt_patches' \
  'cd openwrt && quilt upgrade || true' \
  'Converting meta-data to version 2' \
  'Applying patches' \
  'cd openwrt && quilt push -a || [ $? -eq 2 ]'
if test "$environment" = 'full_raspberrypi_bcm27xx_bcm2712'; then
  printf '%s\n' \
    'Applying patch patches/boot-config.patch' \
    'patching file target/linux/bcm27xx/image/config.txt' \
    ''
fi
printf '%s\n' \
  'Applying patch patches/image-with-padded-rootfs.patch' \
  'patching file target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh' \
  '' \
  'Now at patch patches/image-with-padded-rootfs.patch'

rm -rf openwrt/.pc
mkdir -p openwrt/.pc openwrt/target/linux/bcm27xx/image
cp "conf/$environment/patches/series" openwrt/.pc/series
cp "conf/$environment/patches/series" openwrt/.pc/applied-patches
cp "conf/$environment/approved-rootfs.sh" openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh
rm -f conf/.config openwrt/.config
ln -s "$environment/.config" conf/.config
ln -s ../conf/.config openwrt/.config
printf 'switch-env:%s\n' "$environment" >> "$OSI_FIXTURE_LOG"
