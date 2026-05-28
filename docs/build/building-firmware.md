# OSI OS — Firmware Build Guide

For release images, use the full workflow in
[`rpi5-full-osi-image.md`](rpi5-full-osi-image.md). Despite the historical file
name, that workflow covers both current release targets:

- Raspberry Pi 5: `bcm27xx/bcm2712`, device `rpi-5`.
- Raspberry Pi 4 / 400 / 3 / 2: `bcm27xx/bcm2709`, device `rpi-2`.

This page is the shorter orientation guide for the OpenWrt build environment.

## Prerequisites

- OpenWrt submodule initialized under `openwrt/`.
- Build dependencies available on the host or inside the Docker devshell.
- `quilt` available on `PATH` for `make switch-env`.
- Node/npm available for `web/react-gui`.
- At least 20 GB free disk space; more is better for dual-target builds.
- At least 8 GB RAM recommended.
- Stable internet connection for first-time package/feed downloads.

If `quilt` is not installed globally and `sudo` is unavailable, build it from
the OpenWrt download cache and use the local binary:

```bash
tar -xzf openwrt/dl/quilt-0.68.tar.gz -C /tmp
cd /tmp/quilt-0.68
./configure --prefix="$HOME/.local"
make -j2
make install
cd /home/phil/Repos/osi-os
export PATH="$HOME/.local/bin:$PATH"
```

## Initialize The Build Tree

First-time setup:

```bash
make init
```

This initializes the OpenWrt submodule, copies the feed config, sets the initial
symlinks, updates feeds, installs feed packages, and initializes quilt.

If using the Docker devshell:

```bash
make devshell
```

The successful 2026-05-22 release builds were run directly on the host with
`PATH="$HOME/.local/bin:$PATH"` so local `quilt` was available. Either host or
devshell is acceptable as long as the same verifiers and post-build checks pass.

## Pre-Build Checks

Run from repo root before every release build:

```bash
git status --short --branch
git fetch --all --prune

node scripts/verify-profile-parity.js
node scripts/verify-chameleon-calibration.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-sync-flow.js
node scripts/verify-strega-gen1.js
node scripts/verify-communication-contract.js
scripts/check-mqtt-topics.sh
```

Do not build release images if any verifier fails.

If the GUI changed:

```bash
cd web/react-gui
npm run test:unit
npm run build
cd ../..
rm -rf feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
mkdir -p feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
cp -a web/react-gui/build/. feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
```

## Build Commands

### Raspberry Pi 5

```bash
export PATH="$HOME/.local/bin:$PATH"
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2712

mkdir -p tmp
cd openwrt
CARGO_BUILD_JOBS=2 make -j4 > ../tmp/build-pi5-full-image.log 2>&1
cd ..
```

Output directory:

```text
openwrt/bin/targets/bcm27xx/bcm2712/
```

Factory image pattern:

```text
chirpstack-gateway-os-4.9.0-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz
```

### Raspberry Pi 4 / 400 / 3 / 2

```bash
export PATH="$HOME/.local/bin:$PATH"
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709

cd openwrt
CARGO_BUILD_JOBS=2 make -j4 > ../tmp/build-pi4-full-image.log 2>&1
cd ..
```

Output directory:

```text
openwrt/bin/targets/bcm27xx/bcm2709/
```

Factory image pattern:

```text
chirpstack-gateway-os-4.9.0-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz
```

The bcm2709 image is a universal 32-bit ARMv7 image for Pi 2 / 3 / 4 / 400.

## Monitoring

Low CPU during package install, package index, and image generation stages is
normal. Check progress with:

```bash
tail -n 80 tmp/build-pi5-full-image.log
tail -n 80 tmp/build-pi4-full-image.log
pgrep -af 'make -j4|make\[|mksquashfs|mkfs|gen_rpi|gzip|opkg|ipkg'
```

## Post-Build Verification

Run checksum verification in each target output directory:

```bash
cd openwrt/bin/targets/bcm27xx/bcm2712
sha256sum -c sha256sums

cd ../bcm2709
sha256sum -c sha256sums
```

Then inspect the generated rootfs. Paths differ by target:

```bash
# Pi 5
ROOT=/home/phil/Repos/osi-os/openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx

# Pi 4 / 400 / 3 / 2
ROOT=/home/phil/Repos/osi-os/openwrt/build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx
```

For each target:

```bash
test -f "$ROOT/etc/uci-defaults/98_osi_node_red_seed"
test -f "$ROOT/usr/share/flows.json"
test -f "$ROOT/usr/share/db/farming.db"
test -f "$ROOT/usr/share/node-red/node_modules/@grpc/grpc-js/package.json"
test -f "$ROOT/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json"
test -f "$ROOT/usr/share/node-red/node_modules/google-protobuf/package.json"
grep -E 'location /(gui|auth|api|download)/' "$ROOT/etc/nginx/conf.d/node-red.locations"
sqlite3 "$ROOT/usr/share/db/farming.db" 'SELECT COUNT(*) FROM chameleon_calibrations;'
```

An image is not release-ready until checksum verification and rootfs inspection
both pass.

## Troubleshooting

### `quilt: command not found`

Install `quilt` system-wide or build it locally from `openwrt/dl/quilt-0.68.tar.gz`
as shown above, then rerun with `PATH="$HOME/.local/bin:$PATH"`.

### `image-with-padded-rootfs.patch can be reverse-applied`

This can happen when the OpenWrt tree already contains the rootfs padding logic.
Proceed only after confirming:

```bash
grep -n 'ROOTFSPADDING' openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh
```

and after the remaining target patches are applied.

### Build fails with missing packages

Run `make update` only when intentionally refreshing feeds for the current
checkout, then retry. If the feed state is corrupted:

```bash
make clean
make init
```

### Rust compilation OOM

Keep `CARGO_BUILD_JOBS=2` unless the build host has enough RAM for more.

### No space left on device

Free disk space. If Docker is used:

```bash
docker system prune -a
```
