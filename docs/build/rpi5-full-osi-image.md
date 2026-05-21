# Raspberry Pi 5 Full OSI OS Image Build

This is the release workflow for a fresh Raspberry Pi 5 OSI OS image. The only expected manual runtime step after flashing is concentratord hardware configuration and enabling, because the LoRa concentrator model/region depends on the installed HAT.

## Current Build Gate

As of 2026-05-20 this workflow is prepared for a clean release image. Chameleon calibration rows are allowed to be absent from the OSI OS seed database because the authoritative calibration source and admin token live on OSI Server. A complete OSI OS image must include the Chameleon schema, helper, GUI controls, refresh endpoint, sync worker, and runtime OSI Server calibration lookup path.

## Build Inputs

- Active OpenWrt target: `bcm27xx/bcm2712`, device `rpi-5`.
- Active symlinks must point at the Pi 5 profile:
  - `conf/.config -> full_raspberrypi_bcm27xx_bcm2712/.config`
  - `conf/files -> full_raspberrypi_bcm27xx_bcm2712/files`
  - `conf/patches -> full_raspberrypi_bcm27xx_bcm2712/patches`
  - `openwrt/.config -> ../conf/.config`
  - `openwrt/files -> ../conf/files`
  - `openwrt/patches -> ../conf/patches`
- Root filesystem partition size is `CONFIG_TARGET_ROOTFS_PARTSIZE=14336`, leaving room for 16GB-class SD cards while avoiding the edge of nominal card capacity.
- `node-red-node-sqlite` must be built into the image. The native `sqlite3` module comes from this OpenWrt package, not from bundled npm modules.
- `/srv/node-red` is the Node-RED runtime directory. Do not use `/var/lib/node-red/.node-red`; `/var` is tmp-backed in this image family.
- `/etc/uci-defaults/98_osi_node_red_seed` seeds `/srv/node-red` on first boot from `/usr/share/flows.json`, `/usr/share/node-red`, and `/usr/share/node-red/codecs`.
- The image must include pure Node runtime dependencies under `/usr/share/node-red/node_modules`, especially:
  - `@grpc/grpc-js`
  - `@chirpstack/chirpstack-api`
  - `google-protobuf`
  - `protobufjs`
  - local OSI helper modules copied into `/srv/node-red/node_modules` by the seed script
- The image must include nginx reverse proxy locations for `/gui/`, `/auth/`, `/api/`, and `/download/`.
- The default AP seed config uses 2.4GHz channel 6, country `CH`, HT20. Avoid the previous forced 5GHz channel 36 default.

## Chameleon Calibration Seed

Chameleon calibration is offline-first but not invented locally. If a local admin-token calibration dump is available, it can be bundled before a release build:

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

`scripts/apply-chameleon-calibration-seed.js` accepts zero bundled rows by default and records that the image will rely on runtime OSI Server calibration sync. Use `--require-rows` only for an explicit audit build where a local calibration dump is expected.

## Pre-Build Verification

Run from repo root:

```bash
node scripts/verify-profile-parity.js
node scripts/verify-chameleon-calibration.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-sync-flow.js
node scripts/verify-strega-gen1.js
node scripts/verify-communication-contract.js
scripts/check-mqtt-topics.sh
```

If the React GUI changed, rebuild it and copy the build output into the feed before the OpenWrt build:

```bash
cd web/react-gui
npm run test:unit
npm run build
cd ../..
rm -rf feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
mkdir -p feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
cp -a web/react-gui/build/. feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
```

Do not proceed if any verifier fails. The Pi 5 profile is the canonical runtime payload; bcm2709 mirrors it byte-for-byte for OSI payload files.

Before starting OpenWrt, confirm these release-critical local changes are present:

```bash
grep -q '^CONFIG_TARGET_ROOTFS_PARTSIZE=14336$' conf/full_raspberrypi_bcm27xx_bcm2712/.config
grep -q '^CONFIG_PACKAGE_node-red-node-sqlite=y$' conf/full_raspberrypi_bcm27xx_bcm2712/.config
test -f conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed
test -f conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/google-protobuf/package.json
test -f conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/@chirpstack/chirpstack-api/package.json
grep -q 'userDir: "/srv/node-red"' feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js
grep -q 'location /gui/' feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.nginx
```

## Build

Run from repo root:

```bash
cd openwrt
CARGO_BUILD_JOBS=2 make -j4 > ../tmp/build-pi5-full-image.log 2>&1
```

Low CPU during package/install/image phases is normal. Check progress with:

```bash
tail -n 50 ../tmp/build-pi5-full-image.log
pstree -ap $(pgrep -n -f 'make -j4')
```

## Post-Build Verification

Run from `openwrt/bin/targets/bcm27xx/bcm2712`:

```bash
sha256sum -c sha256sums
```

Inspect the generated root filesystem before flashing:

```bash
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
```

The calibration row count may be `0` when the image is configured to fetch calibrations from OSI Server at runtime.

The generated factory image is:

```text
openwrt/bin/targets/bcm27xx/bcm2712/chirpstack-gateway-os-4.9.0-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz
```

## First Boot Acceptance

After flashing and booting with a known-good Raspberry Pi 5 PSU:

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
- `osi-bootstrap` creates ChirpStack apps/profiles and writes `/srv/node-red/.chirpstack.env`.
- `/download/database` returns `403`, proving the disabled database download endpoint is active.
- `chirpstack-concentratord` may show no active instance until the operator manually configures and enables the installed concentrator hardware.
- No undervoltage events appear. If they do, fix PSU/cable before debugging software symptoms.

## Pitfalls From 2026-05-19

- A reachable LuCI/ChirpStack base image is not enough. Verify Node-RED actually loaded `/srv/node-red/flows.json`; the first image booted without OSI flows.
- Missing pure Node dependencies make `osi-bootstrap` fail even when Node-RED itself starts. Verify module resolution from `/srv/node-red`.
- Do not bundle native npm `sqlite3`; use OpenWrt `node-red-node-sqlite` and link its native module into `/srv/node-red/node_modules/sqlite3`.
- Do not rely on `/var/lib/node-red/.node-red`; it is not durable in this image.
- HTTPS `/gui/` needs nginx proxy locations, not only Node-RED on port `1880`.
- A solid red LED / disappearing LAN can be power-related. The live Pi logged repeated `Undervoltage detected!`; use a known-good Pi 5 PSU before chasing app-level causes.
- IP addresses can change after Wi-Fi reconnect. Confirm by MAC and `/etc/openwrt_release`, not by stale IP.
- A build artifact is not complete until `sha256sum -c sha256sums` passes and the rootfs inspection confirms flows, DB, seed script, Node deps, nginx locations, and Chameleon runtime calibration sync support.
