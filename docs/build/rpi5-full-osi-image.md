# Raspberry Pi Full OSI OS Image Build

This is the release workflow for fresh OSI OS Raspberry Pi factory images. It
builds:

- Raspberry Pi 5: `bcm27xx/bcm2712`, device `rpi-5`, aarch64.
- Raspberry Pi 4 / 400 / 3 / 2: `bcm27xx/bcm2709`, device `rpi-2`, 32-bit ARMv7 universal image.

The only expected manual runtime step after flashing is concentratord hardware
configuration and enabling, because the LoRa concentrator model/region depends
on the installed HAT.

The file name still says `rpi5` for compatibility with existing links. The
workflow now covers both release images.

## Current Build Gate

As of 2026-05-22 this workflow is prepared for a clean release image.
Chameleon calibration rows are allowed to be absent from the OSI OS seed
database because the authoritative calibration source and admin token live on
OSI Server. A complete OSI OS image must include the Chameleon schema, helper,
GUI controls, refresh endpoint, sync worker, and runtime OSI Server calibration
lookup path.

The Pi 5 profile is the canonical runtime payload; bcm2709 mirrors it
byte-for-byte for OSI payload files. `scripts/verify-profile-parity.js` enforces
that invariant and is also chained from `scripts/verify-sync-flow.js`.

## Build Inputs

- Repos must be on current `main` and clean except for expected build symlinks
  and generated GUI feed output.
- Root filesystem partition size must be `CONFIG_TARGET_ROOTFS_PARTSIZE=14336`
  for both Pi 5 and Pi 4 profiles, leaving room for 16GB-class SD cards while
  avoiding the edge of nominal card capacity.
- `node-red-node-sqlite` must be built into both images. The native `sqlite3`
  module comes from this OpenWrt package, not from bundled npm modules.
- `/srv/node-red` is the Node-RED runtime directory. Do not use
  `/var/lib/node-red/.node-red`; `/var` is tmp-backed in this image family.
- `/etc/uci-defaults/98_osi_node_red_seed` seeds `/srv/node-red` on first boot
  from `/usr/share/flows.json`, `/usr/share/node-red`, package manifests, local
  helper modules, and `/usr/share/node-red/codecs`.
- The image must include pure Node runtime dependencies under
  `/usr/share/node-red/node_modules`, especially:
  - `@grpc/grpc-js`
  - `@chirpstack/chirpstack-api`
  - `google-protobuf`
  - `protobufjs`
  - local OSI helper modules copied into `/srv/node-red/node_modules` by the seed script
- The image must include nginx reverse proxy locations for `/gui/`, `/auth/`,
  `/api/`, and `/download/`.
- The default AP seed config uses 2.4GHz channel 6, country `CH`, HT20. Avoid
  the previous forced 5GHz channel 36 default.

## Host Tooling

`make switch-env` requires `quilt`. On systems where `quilt` is not installed
globally and `sudo` is unavailable, install it into the user prefix and include
that prefix on `PATH`:

```bash
tar -xzf openwrt/dl/quilt-0.68.tar.gz -C /tmp
cd /tmp/quilt-0.68
./configure --prefix="$HOME/.local"
make -j2
make install
cd /home/phil/Repos/osi-os
export PATH="$HOME/.local/bin:$PATH"
```

Use the same `PATH` for `make switch-env` and OpenWrt builds.

## Chameleon Calibration Seed

Chameleon calibration is offline-first but not invented locally. If a local
admin-token calibration dump is available, it can be bundled before a release
build:

```bash
OSI_ADMIN_TOKEN=<token> node scripts/refresh-chameleon-calibrations.js
node scripts/apply-chameleon-calibration-seed.js
```

Then review:

```bash
git diff -- database/seeds/chameleon-calibrations.sql \
  database/farming.db \
  web/react-gui/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
```

`scripts/apply-chameleon-calibration-seed.js` accepts zero bundled rows by
default and records that the image will rely on runtime OSI Server calibration
sync. Use `--require-rows` only for an explicit audit build where a local
calibration dump is expected.

## Pre-Build Verification

Run from repo root:

```bash
git status --short --branch
git -C ../osi-server status --short --branch
git fetch --all --prune
git -C ../osi-server fetch --all --prune

node scripts/verify-profile-parity.js
node scripts/verify-chameleon-calibration.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-sync-flow.js
node scripts/verify-strega-gen1.js
node scripts/verify-communication-contract.js
scripts/check-mqtt-topics.sh
```

Do not proceed if any verifier fails.

## Factory image guard inputs

Generate the read-only provenance anchor before OpenWrt consumes the profile
files. The generator hashes the six boot links, the UCI order, the seed, and
the ROM helpers; `--check` is read-only and must pass in CI.

```bash
BUILD_DATE="$(date -u +%Y%m%d)"
IMAGE_BUILD_ID="${BUILD_DATE}-factory-bcm2712"
node scripts/generate-factory-image-provenance.js --write \
  --profile bcm2712 --image-build-id "$IMAGE_BUILD_ID"
node scripts/generate-factory-image-provenance.js --write \
  --profile bcm2709 --image-build-id "${BUILD_DATE}-factory-bcm2709"
node scripts/generate-factory-image-provenance.js --check
node scripts/verify-factory-image-provenance.js
sh scripts/test-image-guard-bootstrap.sh
```

Do not build from a commit that has not passed these checks. The initializer
creates no authority on a previously provisioned `/data` tree; the first boot
fixture must fail closed while the later image-baseline verb is absent.

If the React GUI changed, rebuild it and copy the build output into the feed
before the OpenWrt build:

```bash
cd web/react-gui
npm run test:unit
npm run build
cd ../..
rm -rf feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
mkdir -p feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
cp -a web/react-gui/build/. feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
```

Before starting OpenWrt, confirm release-critical inputs for both profiles:

```bash
for env in full_raspberrypi_bcm27xx_bcm2712 full_raspberrypi_bcm27xx_bcm2709; do
  grep -q '^CONFIG_TARGET_ROOTFS_PARTSIZE=14336$' "conf/$env/.config"
  grep -q '^CONFIG_PACKAGE_node-red-node-sqlite=y$' "conf/$env/.config"
  test -f "conf/$env/files/etc/uci-defaults/98_osi_node_red_seed"
  test -f "conf/$env/files/usr/share/node-red/node_modules/google-protobuf/package.json"
  test -f "conf/$env/files/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json"
done

grep -q 'userDir: "/srv/node-red"' feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js
grep -q 'location /gui/' feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.nginx
```

## Build Pi 5

Run from repo root:

```bash
export PATH="$HOME/.local/bin:$PATH"
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2712

mkdir -p tmp
cd openwrt
CARGO_BUILD_JOBS=2 make -j4 > ../tmp/build-pi5-full-image.log 2>&1
cd ..
```

Low CPU during package/install/image phases is normal. Check progress with:

```bash
tail -n 80 tmp/build-pi5-full-image.log
pgrep -af 'make -j4|make\[|mksquashfs|mkfs|gen_rpi|gzip|opkg|ipkg'
```

Verify Pi 5 output:

```bash
cd openwrt/bin/targets/bcm27xx/bcm2712
sha256sum -c sha256sums
cd /home/phil/Repos/osi-os/openwrt

ROOT=build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx
test -f "$ROOT/etc/uci-defaults/98_osi_node_red_seed"
test -f "$ROOT/usr/share/flows.json"
test -f "$ROOT/usr/share/db/farming.db"
test -f "$ROOT/usr/share/node-red/node_modules/@grpc/grpc-js/package.json"
test -f "$ROOT/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json"
test -f "$ROOT/usr/share/node-red/node_modules/google-protobuf/package.json"
grep -E 'location /(gui|auth|api|download)/' "$ROOT/etc/nginx/conf.d/node-red.locations"
sqlite3 "$ROOT/usr/share/db/farming.db" 'SELECT COUNT(*) FROM chameleon_calibrations;'
cd /home/phil/Repos/osi-os
```

Generated factory image:

```text
openwrt/bin/targets/bcm27xx/bcm2712/chirpstack-gateway-os-4.9.0-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz
```

After extracting the generated rootfs, verify the lower-layer anchors. The
verifier rejects a nested `<rootfs>/rom`; `/rom` is a runtime alias, not an
image directory.

```bash
node scripts/verify-built-factory-image-provenance.js \
  --rootfs openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx \
  --profile bcm2712
```

## Build Pi 4 / 400 / 3 / 2

Run only after the Pi 5 image has built and verified:

```bash
export PATH="$HOME/.local/bin:$PATH"
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709

cd openwrt
CARGO_BUILD_JOBS=2 make -j4 > ../tmp/build-pi4-full-image.log 2>&1
cd ..
```

Confirm the active config if needed:

```bash
grep -E 'CONFIG_TARGET_bcm27xx_bcm2709|CONFIG_TARGET_PROFILE|CONFIG_TARGET_ROOTFS_PARTSIZE|CONFIG_PACKAGE_node-red-node-sqlite' openwrt/.config
```

Expected target lines include `CONFIG_TARGET_bcm27xx_bcm2709=y`,
`CONFIG_TARGET_PROFILE="DEVICE_rpi-2"`, `CONFIG_TARGET_ROOTFS_PARTSIZE=14336`,
and `CONFIG_PACKAGE_node-red-node-sqlite=y`.

Verify Pi 4 output:

```bash
cd openwrt/bin/targets/bcm27xx/bcm2709
sha256sum -c sha256sums
cd /home/phil/Repos/osi-os/openwrt

ROOT=build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx
test -f "$ROOT/etc/uci-defaults/98_osi_node_red_seed"
test -f "$ROOT/usr/share/flows.json"
test -f "$ROOT/usr/share/db/farming.db"
test -f "$ROOT/usr/share/node-red/node_modules/@grpc/grpc-js/package.json"
test -f "$ROOT/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json"
test -f "$ROOT/usr/share/node-red/node_modules/google-protobuf/package.json"
grep -E 'location /(gui|auth|api|download)/' "$ROOT/etc/nginx/conf.d/node-red.locations"
sqlite3 "$ROOT/usr/share/db/farming.db" 'SELECT COUNT(*) FROM chameleon_calibrations;'
cd /home/phil/Repos/osi-os
```

Generated factory image:

```text
openwrt/bin/targets/bcm27xx/bcm2709/chirpstack-gateway-os-4.9.0-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz
```

Verify the Pi 4/2 rootfs with the same lower-layer check before publishing the
image.

```bash
node scripts/verify-built-factory-image-provenance.js \
  --rootfs openwrt/build_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi/root-bcm27xx \
  --profile bcm2709
```

The calibration row count may be `0` when the image is configured to fetch
calibrations from OSI Server at runtime. For the 2026-05-22 build the bundled
seed contained 7 known calibration rows.

## Release Asset Naming

When publishing release assets, copy the factory images to a staging directory
and rename them without mutating the OpenWrt output:

```bash
mkdir -p tmp/release-assets/osi-os_0.65
cp openwrt/bin/targets/bcm27xx/bcm2712/*rpi-5*squashfs-factory.img.gz \
  tmp/release-assets/osi-os_0.65/osi-os_0.65-rpi5-factory.img.gz
cp openwrt/bin/targets/bcm27xx/bcm2709/*rpi-2*squashfs-factory.img.gz \
  tmp/release-assets/osi-os_0.65/osi-os_0.65-rpi4-factory.img.gz
sha256sum tmp/release-assets/osi-os_0.65/*.img.gz
```

## First Boot Acceptance

After flashing and booting with a known-good Raspberry Pi PSU:

```bash
ping -c 30 <pi-ip>
curl -k -I https://<pi-ip>/gui/
curl -k -sS https://<pi-ip>/gui/ | grep '/gui/assets/'
ssh root@<pi-ip> 'for s in node-red chirpstack chirpstack-mqtt-forwarder mosquitto nginx dnsmasq network firewall; do /etc/init.d/$s status; done'
ssh root@<pi-ip> 'logread | grep -iE "undervoltage|under-voltage|node-red|osi-bootstrap|missing|failed|error" | tail -n 120'
ssh root@<pi-ip> 'cd /srv/node-red && node -e "for (const m of [\"@grpc/grpc-js\",\"@chirpstack/chirpstack-api/api/device_grpc_pb\",\"google-protobuf\",\"sqlite3\",\"osi-chirpstack-helper\",\"osi-db-helper\"]) console.log(m, require.resolve(m))"'
curl -sS http://<pi-ip>:1880/flows -o /tmp/osi-flows.json
node -e 'const f=require("/tmp/osi-flows.json"); console.log(f.length, f.filter(n=>n.type==="unknown").length)'
```

Expected:

- HTTPS GUI returns `200` and assets load.
- Node-RED loads the full flow set with zero unknown nodes.
- `osi-bootstrap` creates ChirpStack apps/profiles and writes
  `/srv/node-red/.chirpstack.env`.
- `/download/database` returns `403`, proving the disabled database download
  endpoint is active.
- `chirpstack-concentratord` may show no active instance until the operator
  manually configures and enables the installed concentrator hardware.
- No undervoltage events appear. If they do, fix PSU/cable before debugging
  software symptoms.

## Pitfalls From 2026-05 Builds

- A reachable LuCI/ChirpStack base image is not enough. Verify Node-RED
  actually loaded `/srv/node-red/flows.json`; one early image booted without
  OSI flows.
- Missing pure Node dependencies make `osi-bootstrap` fail even when Node-RED
  itself starts. Verify module resolution from `/srv/node-red`.
- Do not bundle native npm `sqlite3`; use OpenWrt `node-red-node-sqlite` and
  link its native module into `/srv/node-red/node_modules/sqlite3`.
- Do not rely on `/var/lib/node-red/.node-red`; it is not durable in this image.
- HTTPS `/gui/` needs nginx proxy locations, not only Node-RED on port `1880`.
- A solid red LED / disappearing LAN can be power-related. The live Pi logged
  repeated `Undervoltage detected!`; use a known-good Pi PSU before chasing
  app-level causes.
- IP addresses can change after Wi-Fi reconnect. Confirm by MAC and
  `/etc/openwrt_release`, not by stale IP.
- `image-with-padded-rootfs.patch` may report that it can be reverse-applied if
  the OpenWrt tree already carries the padding logic. Proceed only after
  confirming `target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh` contains the
  rootfs padding block and the remaining target patches are applied.
- A build artifact is not complete until `sha256sum -c sha256sums` passes and
  the rootfs inspection confirms flows, DB, seed script, Node dependencies,
  nginx locations, and Chameleon runtime calibration sync support.
