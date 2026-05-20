# Raspberry Pi 4 (bcm2709) Profile Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the existing `conf/{base,full}_raspberrypi_bcm27xx_bcm2709` profiles up to feature parity with the Pi-5 (`bcm2712`) profiles so that an OpenWrt image built from them boots and runs the full OSI OS stack on a Raspberry Pi 4 / 400 / 3 / 2 (32-bit ARMv7 universal image).

**Architecture:** The repo currently treats `conf/full_raspberrypi_bcm27xx_bcm2712` as the canonical source-of-truth for all OSI-specific runtime payload (Node-RED flows, codecs, helpers, init scripts, seed DB, uci-defaults). The `bcm2709` profile is a stale chirpstack-gateway-os mirror that pre-dates the OSI integration. This plan mirrors the canonical OSI payload into `bcm2709`, preserves bcm2709's architecture-specific kernel `.config` (target=`bcm2709`, profile=`DEVICE_rpi-2`, arch=`arm`, cpu=`cortex-a7+neon-vfpv4`, libc=`muslgnueabi`), drops the Pi-5-only `add_designware_spi_kmod.patch`, deletes legacy chirpstack-only uci-defaults that conflict with OSI bootstrap, and adds a parity-check verification script so future edits to bcm2712 don't silently rot bcm2709.

**Tech Stack:** OpenWrt 24.10 buildroot, Node.js (verification scripts), POSIX sh, bash, git.

**Pi 4 vs Pi 5 hardware deltas that informed the plan:**
- Pi 4's BCM2711 SoC uses the standard `kmod-spi-bcm2835` / `kmod-i2c-bcm2835` drivers. Pi 5's BCM2712 routes SPI/I2C through an RP1 southbridge requiring Designware drivers — that's what `add_designware_spi_kmod.patch` enables, and it must **not** be applied for bcm2709.
- The DTBs `bcm2711-rpi-4-b.dtb` and `bcm2711-rpi-400.dtb` are already bundled by the upstream `Device/rpi-2` profile (verified at [openwrt/target/linux/bcm27xx/image/Makefile](openwrt/target/linux/bcm27xx/image/Makefile)), so the existing bcm2709 image format already targets Pi 4.
- The bcm2709 subtarget runs a 32-bit ARMv7 kernel. Per-process RAM is capped at ~3.5 GB by LPAE. Pi 4 with 8 GB RAM will not use all of it. This is an accepted trade-off for a single universal Pi 2/3/4/400 image; a future bcm2711 (aarch64) plan can revisit.

**Strategy decision (read before starting):** This plan duplicates files between bcm2712 and bcm2709 rather than symlinking. Symlinks survive OpenWrt's build but commit to a less-reviewable structure; duplication mirrors the existing repo pattern (bcm2708 already does the same). Drift is mitigated by Task 11's parity-check script — that script is non-negotiable.

---

## File Structure

**New files:**
- `scripts/verify-profile-parity.js` — Asserts OSI-canonical files in bcm2709 (and bcm2708) match bcm2712 byte-for-byte for the payload set defined in the canonical-payload list.

**Modified files:**
- `conf/base_raspberrypi_bcm27xx_bcm2709/.config` — Add `kmod-hwmon-core`, `kmod-thermal`, `tailscale` package selections to match bcm2712.
- `conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/board.d/02_network` — Replace with bcm2712 version.
- `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/` — Delete `schema.sql` and `sensor_data.db`; replace with `db/farming.db` from bcm2712.
- `conf/full_raspberrypi_bcm27xx_bcm2709/.config` — Same package additions as base.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/board.d/02_network` — Replace with bcm2712 version.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/sysupgrade.conf` — Replace with bcm2712 version.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap` — Replace with bcm2712 version.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_sx1301_gateway_id` — Replace with bcm2712 version.
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` — Replace with bcm2712 version.
- `deploy.sh` — Make `SEED_DB_REL` target-aware so a Pi 4 deploy picks the bcm2709 seed DB.
- `scripts/verify-sync-flow.js` — Wire in parity-check assertion at end.
- `Makefile` — Add `verify-profile-parity` target that runs the new script.
- `README.md` — Add Pi 4 to supported targets matrix.
- `docs/build/building-firmware.md` — Add Pi 4 build example.
- `AGENTS.md` — Note Pi 4 build/test invariants.

**Created (via copy) directories:**
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/config/` (copy of bcm2712)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap` (file from bcm2712)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/nginx/` (copy of bcm2712)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/redis.conf` (file from bcm2712)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/95_osi_bootstrap_enable` (file)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config` (file)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/97_osi_db_seed` (file)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_tailscale_init` (file)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh` (file)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/` (full tree of bootstrap, codecs, node_modules, helpers, package.json, package-lock.json)
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/` (seed DB dir)

**Deleted files:**
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/01_update_rc_local_20241118` — legacy chirpstack rc.local update, obsolete
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config` — replaced by OSI Node-RED flows
- `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config` — replaced by OSI Node-RED flows
- `conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config`
- `conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config`
- `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/schema.sql` — old standalone schema; superseded by seed DB
- `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/sensor_data.db` — old standalone DB; superseded by `db/farming.db`

**Patches/series stays untouched** in both bcm2709 profiles. They already correctly lack `add_designware_spi_kmod.patch` and contain the three patches valid for Pi 2/3/4 (`no-uart-console.patch`, `boot-config.patch`, `image-with-padded-rootfs.patch`).

**prepare_release.sh stays untouched.** Lines 17-18 already invoke `do_prepare $1 raspberrypi bcm27xx bcm2709 rpi-2 base` and `... full`. The release pipeline will pick up the aligned artifacts automatically.

---

## Task 1: Preparation and Baseline Snapshot

**Files:**
- No file changes in this task

- [ ] **Step 1: Confirm clean working tree**

Run: `git status --short --branch`
Expected: branch line shows `main` (or whatever the user is working from); no unrelated modifications. The pre-existing uncommitted changes from session start (`conf/full_raspberrypi_bcm27xx_bcm2712/.config`, `feeds/.../index.html`, `openwrt/feeds.conf.default`, `openwrt/target/linux/bcm27xx/image/gen_rpi_sdcard_img.sh`, and the untracked `openwrt/patches/` directory) are tolerated — list them and confirm with the user that the plan does not touch them before proceeding.

- [ ] **Step 2: Create a topic branch**

Run: `git checkout -b feature/rpi4-bcm2709-alignment`
Expected: switched to new branch.

- [ ] **Step 3: Verify baseline structural diff matches plan assumptions**

Run: `diff -rq conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709`
Expected: output matches the deltas enumerated in the "File Structure" section above. If the diff has *new* deltas (e.g. someone added a file to bcm2712 since this plan was written), stop and re-scope. If the diff is *missing* deltas (someone already aligned partially), that's fine — proceed and the tasks below will idempotently overwrite.

Run: `diff -rq conf/base_raspberrypi_bcm27xx_bcm2712 conf/base_raspberrypi_bcm27xx_bcm2709`
Expected: similar verification for base profile.

- [ ] **Step 4: Snapshot current bcm2709 .config target lines for restoration reference**

Run: `grep -E '^CONFIG_TARGET_bcm27xx|^CONFIG_TARGET_SUBTARGET|^CONFIG_TARGET_PROFILE|^CONFIG_TARGET_ARCH_PACKAGES|^CONFIG_CPU_TYPE|^CONFIG_ARCH|^CONFIG_aarch|^CONFIG_TARGET_SUFFIX' conf/full_raspberrypi_bcm27xx_bcm2709/.config`

Expected output (these are the lines we MUST preserve through all subsequent edits):
```
CONFIG_TARGET_bcm27xx=y
CONFIG_TARGET_bcm27xx_bcm2709=y
CONFIG_TARGET_bcm27xx_bcm2709_DEVICE_rpi-2=y
CONFIG_TARGET_SUBTARGET="bcm2709"
CONFIG_TARGET_PROFILE="DEVICE_rpi-2"
CONFIG_TARGET_ARCH_PACKAGES="arm_cortex-a7_neon-vfpv4"
CONFIG_CPU_TYPE="cortex-a7+neon-vfpv4"
CONFIG_ARCH="arm"
CONFIG_TARGET_SUFFIX="muslgnueabi"
```

Note these lines down — every subsequent .config edit must leave them intact.

- [ ] **Step 5: Commit the empty branch as a checkpoint**

Run: `git commit --allow-empty -m "checkpoint: starting rpi4 (bcm2709) alignment"`
Expected: empty commit created.

---

## Task 2: Add the Parity-Check Verification Script (TDD-first)

This task is intentionally first among the file-mirroring tasks. The script becomes the test that drives subsequent copy tasks: it will fail until each canonical file is mirrored.

**Files:**
- Create: `scripts/verify-profile-parity.js`

- [ ] **Step 1: Write the parity-check script**

Create `scripts/verify-profile-parity.js` with this exact content:

```javascript
#!/usr/bin/env node
// Asserts that OSI-canonical payload files in non-bcm2712 profiles match the
// bcm2712 source-of-truth byte-for-byte. Fails CI if the mirror has drifted.
//
// Canonical source: conf/full_raspberrypi_bcm27xx_bcm2712 (Pi 5)
// Mirrored targets: conf/full_raspberrypi_bcm27xx_bcm2709 (Pi 2/3/4/400 universal)
//
// Architecture-specific files (.config, patches/series, kernel patches) are
// excluded — they intentionally differ.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_PROFILE = 'conf/full_raspberrypi_bcm27xx_bcm2712';
const MIRROR_PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2709',
];

// Files / directories under <profile>/ that must match the source byte-for-byte.
// Relative to the profile root.
const CANONICAL_PAYLOAD = [
  'files/etc/board.d/02_network',
  'files/etc/config',
  'files/etc/init.d/osi-bootstrap',
  'files/etc/nginx',
  'files/etc/redis.conf',
  'files/etc/sysupgrade.conf',
  'files/etc/uci-defaults/95_osi_bootstrap_enable',
  'files/etc/uci-defaults/96_osi_server_config',
  'files/etc/uci-defaults/97_osi_db_seed',
  'files/etc/uci-defaults/99_config_chirpstack_ap',
  'files/etc/uci-defaults/99_set_hostname',
  'files/etc/uci-defaults/99_set_sx1301_gateway_id',
  'files/etc/uci-defaults/99_tailscale_init',
  'files/usr/libexec/osi-gateway-identity.sh',
  'files/usr/share/db',
  'files/usr/share/flows.json',
  'files/usr/share/node-red',
];

// Files that must NOT exist in mirror profiles (legacy / superseded).
const FORBIDDEN_IN_MIRROR = [
  'files/etc/uci-defaults/01_update_rc_local_20241118',
  'files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config',
  'files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config',
  'files/usr/share/schema.sql',
  'files/usr/share/sensor_data.db',
];

let failures = 0;

function fail(msg) {
  console.error('FAIL: ' + msg);
  failures++;
}

function ok(msg) {
  console.log('OK:   ' + msg);
}

function hashPath(p) {
  // Hash a file or recursively a directory. Returns hex string, or null if path missing.
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  if (st.isFile()) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  if (st.isDirectory()) {
    const entries = fs.readdirSync(p).sort();
    const h = crypto.createHash('sha256');
    for (const e of entries) {
      h.update(e);
      h.update('\0');
      const sub = hashPath(path.join(p, e));
      h.update(sub === null ? 'MISSING' : sub);
      h.update('\0');
    }
    return h.digest('hex');
  }
  return null;
}

for (const mirror of MIRROR_PROFILES) {
  console.log('\n=== ' + mirror + ' ===');
  for (const rel of CANONICAL_PAYLOAD) {
    const src = path.join(REPO_ROOT, SOURCE_PROFILE, rel);
    const dst = path.join(REPO_ROOT, mirror, rel);
    const sh = hashPath(src);
    const dh = hashPath(dst);
    if (sh === null) {
      fail(`${rel}: source missing from ${SOURCE_PROFILE} — canonical payload list is stale, update verify-profile-parity.js`);
      continue;
    }
    if (dh === null) {
      fail(`${rel}: missing in ${mirror}`);
      continue;
    }
    if (sh !== dh) {
      fail(`${rel}: content differs between ${SOURCE_PROFILE} and ${mirror}`);
      continue;
    }
    ok(`${rel}`);
  }
  for (const rel of FORBIDDEN_IN_MIRROR) {
    const dst = path.join(REPO_ROOT, mirror, rel);
    if (fs.existsSync(dst)) {
      fail(`${rel}: must not exist in ${mirror} (legacy chirpstack artifact)`);
    } else {
      ok(`absent: ${rel}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} parity check(s) failed`);
  process.exit(1);
}
console.log('\nAll parity checks passed.');
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/verify-profile-parity.js`
Expected: no output, exit 0.

- [ ] **Step 3: Run it to confirm it fails as expected (the mirror is currently stale)**

Run: `node scripts/verify-profile-parity.js`
Expected: exits non-zero with multiple `FAIL:` lines covering missing payload (`files/etc/config`, `files/etc/init.d/osi-bootstrap`, `files/usr/share/node-red`, etc.) and forbidden-files present (`01_update_rc_local_20241118` and the two chirpstack forwarder configs). This is the failing test that Tasks 3-9 will fix.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-profile-parity.js
git commit -m "test: add bcm2709 ↔ bcm2712 profile parity verification"
```

---

## Task 3: Remove Legacy chirpstack-only Files from bcm2709 Profiles

**Files:**
- Delete: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/01_update_rc_local_20241118`
- Delete: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config`
- Delete: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config`
- Delete: `conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config`
- Delete: `conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config`
- Delete: `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/schema.sql`
- Delete: `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/sensor_data.db`

- [ ] **Step 1: Confirm these files exist before deleting (sanity check)**

Run:
```bash
ls -la \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/01_update_rc_local_20241118 \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/schema.sql \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/sensor_data.db
```
Expected: all seven listed.

- [ ] **Step 2: Inspect contents of each before deletion (one-line previews) to confirm they are indeed legacy chirpstack-only artifacts and not OSI-relevant**

Run:
```bash
head -5 conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/01_update_rc_local_20241118
head -5 conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config
head -5 conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config
file conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/schema.sql
file conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/sensor_data.db
```
Expected: shell scripts referencing `chirpstack-mqtt-forwarder` or `chirpstack-udp-forwarder` config (legacy), the rc.local script being a one-off migration step from 2024-11-18, an ASCII SQL schema, and an SQLite database header. None should reference OSI-specific things like `osi-bootstrap`, `farming.db`, or `flows.json`. If they do, STOP and surface to user.

- [ ] **Step 3: Delete the legacy files via git**

Run:
```bash
git rm \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/01_update_rc_local_20241118 \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/schema.sql \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/sensor_data.db
```
Expected: seven `rm` lines reported.

- [ ] **Step 4: Re-run parity check; forbidden-file failures should now pass while payload-missing failures remain**

Run: `node scripts/verify-profile-parity.js 2>&1 | grep -E '^OK:.*absent|^FAIL:.*must not exist'`
Expected: five `OK: absent:` lines (the three in `full` deletions plus — wait, the parity script only enumerates the `full` profile mirror, not `base`. The `base`-profile deletions are still correct cleanup but won't show in this script's output. That's fine).

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(bcm2709): remove legacy chirpstack-only artifacts superseded by OSI bootstrap"
```

---

## Task 4: Mirror Per-File Differences (bcm2712 → bcm2709 full profile)

This task copies the six files that **exist in both profiles but differ**.

**Files:**
- Overwrite: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/board.d/02_network`
- Overwrite: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/sysupgrade.conf`
- Overwrite: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap`
- Overwrite: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_sx1301_gateway_id`
- Overwrite: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Overwrite: `conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/board.d/02_network`

- [ ] **Step 1: Copy each file**

Run:
```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/board.d/02_network \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/board.d/02_network

cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/sysupgrade.conf \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/sysupgrade.conf

cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap

cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_set_sx1301_gateway_id \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_set_sx1301_gateway_id

cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json

cp conf/base_raspberrypi_bcm27xx_bcm2712/files/etc/board.d/02_network \
   conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/board.d/02_network
```
Expected: no output, exit 0 for each.

- [ ] **Step 2: Verify each pair is now identical**

Run:
```bash
for rel in \
  files/etc/board.d/02_network \
  files/etc/sysupgrade.conf \
  files/etc/uci-defaults/99_config_chirpstack_ap \
  files/etc/uci-defaults/99_set_sx1301_gateway_id \
  files/usr/share/flows.json ; do
    diff -q conf/full_raspberrypi_bcm27xx_bcm2712/$rel conf/full_raspberrypi_bcm27xx_bcm2709/$rel
done
diff -q conf/base_raspberrypi_bcm27xx_bcm2712/files/etc/board.d/02_network conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/board.d/02_network
```
Expected: no output (no diffs). If any `diff` reports differences, stop and investigate.

- [ ] **Step 3: Run parity check; the five matching entries should now pass**

Run: `node scripts/verify-profile-parity.js 2>&1 | grep -E '02_network|sysupgrade|99_config_chirpstack_ap|99_set_sx1301_gateway_id|flows.json'`
Expected: lines for those five paths under the `conf/full_raspberrypi_bcm27xx_bcm2709` block all show `OK:` prefix.

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files conf/base_raspberrypi_bcm27xx_bcm2709/files
git commit -m "chore(bcm2709): mirror divergent files from bcm2712 (network, sysupgrade, flows, AP, gateway-id)"
```

---

## Task 5: Mirror Missing Top-Level Files (single-file copies)

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/redis.conf`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/95_osi_bootstrap_enable`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/97_osi_db_seed`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_tailscale_init`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh`

- [ ] **Step 1: Copy the seven files, preserving execute bits**

Run:
```bash
mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec
cp -p conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap
cp -p conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/redis.conf \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/redis.conf
cp -p conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/95_osi_bootstrap_enable \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/95_osi_bootstrap_enable
cp -p conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config
cp -p conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/97_osi_db_seed \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/97_osi_db_seed
cp -p conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_tailscale_init \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_tailscale_init
cp -p conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh
```
Expected: no output, exit 0.

- [ ] **Step 2: Verify execute bits preserved on shell scripts**

Run:
```bash
stat -c '%a %n' \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/95_osi_bootstrap_enable \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/97_osi_db_seed \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_tailscale_init \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-gateway-identity.sh
```
Expected: every file shows mode `755` (or at minimum `7??`). If any shows `644`, run `chmod 755 <path>`.

- [ ] **Step 3: Run parity check; seven more entries should pass**

Run: `node scripts/verify-profile-parity.js 2>&1 | grep -E 'osi-bootstrap|redis.conf|95_osi_bootstrap_enable|96_osi_server_config|97_osi_db_seed|99_tailscale_init|osi-gateway-identity.sh'`
Expected: all `OK:` lines for those paths under the bcm2709 mirror block.

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files
git commit -m "feat(bcm2709): add OSI bootstrap, redis, tailscale init, server config, db seed, identity helper"
```

---

## Task 6: Mirror the `files/etc/config/` Directory

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/config/` (full tree from bcm2712)

- [ ] **Step 1: List what's in the source dir so we know what we're copying**

Run: `ls -la conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/config/`
Expected: a list of UCI config files. Note the names for the commit message.

- [ ] **Step 2: Copy recursively**

Run:
```bash
mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/config
cp -pR conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/config/. \
       conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/config/
```
Expected: no output.

- [ ] **Step 3: Verify directory hash matches**

Run:
```bash
diff -rq conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/config conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/config
```
Expected: no output (no diffs).

- [ ] **Step 4: Parity check on this entry**

Run: `node scripts/verify-profile-parity.js 2>&1 | grep 'files/etc/config'`
Expected: `OK:   files/etc/config` under the bcm2709 block.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/config
git commit -m "feat(bcm2709): mirror /etc/config UCI defaults from bcm2712"
```

---

## Task 7: Mirror the `files/etc/nginx/` Directory

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/nginx/` (full tree from bcm2712)

- [ ] **Step 1: Inspect source**

Run: `find conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/nginx -type f`
Expected: a list of nginx config files. Note for commit message.

- [ ] **Step 2: Copy recursively**

Run:
```bash
mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/nginx
cp -pR conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/nginx/. \
       conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/nginx/
```
Expected: no output.

- [ ] **Step 3: Verify**

Run: `diff -rq conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/nginx conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/nginx`
Expected: no output.

- [ ] **Step 4: Parity check**

Run: `node scripts/verify-profile-parity.js 2>&1 | grep 'files/etc/nginx'`
Expected: `OK:   files/etc/nginx`.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/nginx
git commit -m "feat(bcm2709): mirror nginx config from bcm2712"
```

---

## Task 8: Mirror the `files/usr/share/db/` Directory (Seed Database)

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/` (full tree from bcm2712)
- Create: `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/` (full tree from bcm2712 base)

- [ ] **Step 1: Inspect source DB**

Run:
```bash
ls -la conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/
file conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db 'PRAGMA integrity_check;' 2>/dev/null || echo "sqlite3 not installed locally — skip integrity check"
```
Expected: directory contents listed, `file` reports SQLite 3.x format, integrity check returns `ok` if sqlite3 is available.

- [ ] **Step 2: Copy to full profile**

Run:
```bash
mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db
cp -pR conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/. \
       conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/
```
Expected: no output.

- [ ] **Step 3: Copy to base profile**

Run:
```bash
mkdir -p conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db
cp -pR conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/. \
       conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/
```
Expected: no output.

- [ ] **Step 4: Verify byte-identical**

Run:
```bash
diff -rq conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db
diff -rq conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db
```
Expected: no output.

- [ ] **Step 5: Parity check**

Run: `node scripts/verify-profile-parity.js 2>&1 | grep 'files/usr/share/db'`
Expected: `OK:   files/usr/share/db` under the bcm2709 mirror block.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db \
        conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db
git commit -m "feat(bcm2709): seed farming.db database from bcm2712"
```

---

## Task 9: Mirror the `files/usr/share/node-red/` Directory (Largest Payload)

This is the big copy: Node-RED runtime, ChirpStack bootstrap script, codecs, OSI helper modules, package.json, package-lock.json, plus the full `node_modules` tree.

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/` (full tree from bcm2712)

- [ ] **Step 1: Size check the source tree first**

Run: `du -sh conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`
Expected: a size in MB. Note it (could be hundreds of MB if node_modules is tracked). If it's >500 MB, surface to user — that's unusual and might indicate the repo is tracking node_modules that shouldn't be tracked. Proceed anyway since we're mirroring whatever the source-of-truth is.

- [ ] **Step 2: Copy recursively**

Run:
```bash
mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red
cp -pR conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/. \
       conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/
```
Expected: no output. Will take several seconds depending on size.

- [ ] **Step 3: Verify**

Run: `diff -rq conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red`
Expected: no output.

- [ ] **Step 4: Parity check**

Run: `node scripts/verify-profile-parity.js 2>&1 | grep 'files/usr/share/node-red'`
Expected: `OK:   files/usr/share/node-red`.

- [ ] **Step 5: Final full parity check — should be ALL OK now**

Run: `node scripts/verify-profile-parity.js`
Expected: exits 0, prints `All parity checks passed.` at the end. If any `FAIL:` remains, stop and address it; the canonical-payload list in `scripts/verify-profile-parity.js` may need updating for any newly-added bcm2712 file that we missed enumerating.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red
git commit -m "feat(bcm2709): mirror Node-RED runtime (bootstrap, codecs, helpers, node_modules)"
```

---

## Task 10: Align `.config` Package Selections (kmod-hwmon-core, kmod-thermal, tailscale)

The bcm2712 profile selects three packages that bcm2709 does not. All three are arch-portable and should also be selected for Pi 4.

**Files:**
- Modify: `conf/base_raspberrypi_bcm27xx_bcm2709/.config`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/.config`

- [ ] **Step 1: Confirm the three lines we want to add and their exact form**

Run: `grep -E 'kmod-hwmon-core|kmod-thermal|tailscale' conf/full_raspberrypi_bcm27xx_bcm2712/.config | grep -v '^#'`
Expected (exact lines):
```
CONFIG_PACKAGE_kmod-hwmon-core=y
CONFIG_PACKAGE_kmod-thermal=y
CONFIG_PACKAGE_tailscale=y
```

- [ ] **Step 2: Confirm bcm2709 currently lacks them (or has them commented out)**

Run: `grep -E 'kmod-hwmon-core|kmod-thermal|tailscale' conf/full_raspberrypi_bcm27xx_bcm2709/.config`
Expected: either no output, or `# CONFIG_PACKAGE_... is not set` lines. We will add `=y` lines.

- [ ] **Step 3: Add the three lines to the bcm2709 full profile**

If `grep -E '^CONFIG_PACKAGE_kmod-thermal=y' conf/full_raspberrypi_bcm27xx_bcm2709/.config` returns nothing, append. If the file has `# CONFIG_PACKAGE_kmod-thermal is not set` lines, use the Edit tool to replace those comment lines with the `=y` lines instead of appending (keeps the file sorted/clean). For each of the three packages:

Edit `conf/full_raspberrypi_bcm27xx_bcm2709/.config`:
- Find: `# CONFIG_PACKAGE_kmod-hwmon-core is not set`
  Replace with: `CONFIG_PACKAGE_kmod-hwmon-core=y`
  (If the "is not set" line is absent, instead append `CONFIG_PACKAGE_kmod-hwmon-core=y` to the end of the file.)
- Find: `# CONFIG_PACKAGE_kmod-thermal is not set`
  Replace with: `CONFIG_PACKAGE_kmod-thermal=y`
- Find: `# CONFIG_PACKAGE_tailscale is not set`
  Replace with: `CONFIG_PACKAGE_tailscale=y`

- [ ] **Step 4: Repeat for the base profile**

Same three edits in `conf/base_raspberrypi_bcm27xx_bcm2709/.config`.

- [ ] **Step 5: Verify the target/arch lines are STILL untouched (regression check)**

Run: `grep -E '^CONFIG_TARGET_bcm27xx|^CONFIG_TARGET_SUBTARGET|^CONFIG_TARGET_PROFILE|^CONFIG_TARGET_ARCH_PACKAGES|^CONFIG_CPU_TYPE|^CONFIG_ARCH=|^CONFIG_TARGET_SUFFIX' conf/full_raspberrypi_bcm27xx_bcm2709/.config`

Expected output (must be **identical** to the snapshot from Task 1 Step 4):
```
CONFIG_TARGET_bcm27xx=y
CONFIG_TARGET_bcm27xx_bcm2709=y
CONFIG_TARGET_bcm27xx_bcm2709_DEVICE_rpi-2=y
CONFIG_TARGET_SUBTARGET="bcm2709"
CONFIG_TARGET_PROFILE="DEVICE_rpi-2"
CONFIG_TARGET_ARCH_PACKAGES="arm_cortex-a7_neon-vfpv4"
CONFIG_CPU_TYPE="cortex-a7+neon-vfpv4"
CONFIG_ARCH="arm"
CONFIG_TARGET_SUFFIX="muslgnueabi"
```

If any line is different, STOP — the edits inadvertently corrupted the target settings. Revert and retry.

- [ ] **Step 6: Verify the three new lines are present**

Run: `grep -E '^CONFIG_PACKAGE_(kmod-hwmon-core|kmod-thermal|tailscale)=y' conf/full_raspberrypi_bcm27xx_bcm2709/.config conf/base_raspberrypi_bcm27xx_bcm2709/.config`
Expected: six lines, three per file.

- [ ] **Step 7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/.config conf/base_raspberrypi_bcm27xx_bcm2709/.config
git commit -m "feat(bcm2709): enable kmod-hwmon-core, kmod-thermal, tailscale (parity with bcm2712)"
```

---

## Task 11: Wire Parity Check into the Existing Verification Suite

We want `verify-profile-parity.js` to run alongside the other verification scripts so CI catches drift automatically.

**Files:**
- Modify: `Makefile`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Inspect the existing Makefile verify targets**

Run: `grep -n -E 'verify|test:' Makefile`
Expected: see what verify-* targets already exist. Note the pattern.

- [ ] **Step 2: Add a Makefile target if a pattern exists**

If the Makefile has a `verify:` aggregate target that calls multiple node scripts, add `node scripts/verify-profile-parity.js` to it. If there is no aggregate but individual `verify-comm`, `verify-db`, etc., targets, add a new target:

```makefile
verify-profile-parity:
	node scripts/verify-profile-parity.js
```

And add it as a dependency of the top-level `verify` target (or `test` if that's what the project uses).

If the Makefile does not have a verify aggregate at all, skip this Makefile change and proceed to Step 3 — `verify-sync-flow.js` chaining is the more critical hook.

- [ ] **Step 3: Add a require/invocation at the end of `verify-sync-flow.js`**

Read `scripts/verify-sync-flow.js` and locate the final lines (around line 2200+). Append (before any final exit/summary print) a block that invokes the parity script as a child process and forwards its exit status:

```javascript

// Profile parity (bcm2709 ↔ bcm2712)
const { spawnSync } = require('child_process');
const parityResult = spawnSync(
  process.execPath,
  [path.resolve(__dirname, 'verify-profile-parity.js')],
  { stdio: 'inherit' }
);
if (parityResult.status !== 0) {
  console.error('verify-profile-parity.js failed');
  process.exitCode = parityResult.status || 1;
}
```

Note: `path` and `__dirname` are already imported at the top of `verify-sync-flow.js`. Confirm by re-reading line 1-30 of that file before adding the block; if `path` isn't imported, also add `const path = require('path');`.

- [ ] **Step 4: Run the full verify-sync-flow.js to confirm it still passes AND now runs the parity check**

Run: `node scripts/verify-sync-flow.js`
Expected: ends with `All parity checks passed.` from the parity sub-run, then whatever success summary verify-sync-flow normally emits. Exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-sync-flow.js Makefile
git commit -m "test: chain profile-parity check from verify-sync-flow and Makefile"
```

---

## Task 12: Make `deploy.sh` Seed-DB Path Target-Aware

When deploying to a Pi 4 (which will report `Raspberry Pi 4 Model B` in `/proc/device-tree/model`), the seed DB should come from the bcm2709 profile, not bcm2712. After Task 8 the two seed DBs are byte-identical so it doesn't *functionally* matter today, but hardcoding bcm2712 is misleading and breaks if anyone ever genuinely diverges the seeds.

**Files:**
- Modify: `deploy.sh`

- [ ] **Step 1: Read the current SEED_DB_REL definition**

Run: `grep -n 'SEED_DB_REL' deploy.sh`
Expected: at least one line at ~line 19 like `SEED_DB_REL="conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db"`. Note the exact line.

- [ ] **Step 2: Replace the hardcoded line with target detection**

Edit `deploy.sh`:

Find:
```sh
SEED_DB_REL="conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db"
```

Replace with:
```sh
# Pick the seed DB from the profile matching the running hardware.
# /proc/device-tree/model is canonical on Raspberry Pi OS / OpenWrt for bcm27xx.
detect_seed_db_rel() {
    model=""
    if [ -r /proc/device-tree/model ]; then
        model=$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)
    fi
    case "$model" in
        *"Raspberry Pi 5"*)
            echo "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db"
            ;;
        *"Raspberry Pi 4"*|*"Raspberry Pi 400"*|*"Raspberry Pi 3"*|*"Raspberry Pi 2"*)
            echo "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db"
            ;;
        *"Raspberry Pi Zero"*|*"Raspberry Pi Model"*)
            echo "conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db"
            ;;
        *)
            # Unknown model — fall back to bcm2712 (the canonical source-of-truth).
            echo "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db"
            ;;
    esac
}
SEED_DB_REL="$(detect_seed_db_rel)"
```

- [ ] **Step 3: Lint the script for syntax errors**

Run: `sh -n deploy.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Smoke-test detection on this dev machine (which has no /proc/device-tree/model)**

Run: `sh -c 'set -eu; . <(sed -n "/^detect_seed_db_rel/,/^}/p" deploy.sh); detect_seed_db_rel'`
Expected: prints `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db` (the unknown-model fallback). If shell-sourcing fails on fish, instead extract the function manually and test in bash: `bash -c 'detect_seed_db_rel() { ... }; detect_seed_db_rel'`.

- [ ] **Step 5: Re-run verify-sync-flow.js — it asserts content of deploy.sh**

Run: `node scripts/verify-sync-flow.js 2>&1 | tail -20`
Expected: exits 0. If it fails with an assertion about a missing bcm2712 path in deploy.sh, READ the failing assertion carefully — `verify-sync-flow.js` lines 2033-2037 assert that deploy.sh includes specific bcm2712 file paths (gateway-identity helper, dendro helper, codecs). Those assertions are about the *fetch* loop, not the seed-DB line, so they should still pass. If they don't, do not edit verify-sync-flow.js — instead, surface to user. The seed-DB change is the only deploy.sh change in this task.

- [ ] **Step 6: Commit**

```bash
git add deploy.sh
git commit -m "fix(deploy): pick seed DB from profile matching the running Pi model"
```

---

## Task 13: Build Validation — Compile the bcm2709 Image

This task confirms OpenWrt accepts the aligned profile and produces an image. It does not need real Pi 4 hardware. It does need a working OpenWrt buildroot (per `docs/build/building-firmware.md`).

**Files:** none modified — this is a build smoke test.

- [ ] **Step 1: Switch the active build env to bcm2709 full**

Run: `make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709`
Expected: the symlinks `conf/.config`, `conf/files`, `conf/patches` repoint to the bcm2709 full profile. Confirm with `readlink conf/.config` → should print `full_raspberrypi_bcm27xx_bcm2709/.config`.

- [ ] **Step 2: Resolve config and check for kernel-config conflicts**

Run: `cd openwrt && make defconfig 2>&1 | tail -40`
Expected: no errors about missing target, missing kmod, or unsatisfiable dependencies. If `tailscale` errors as unavailable for `arm_cortex-a7_neon-vfpv4`, that's a known risk — drop `CONFIG_PACKAGE_tailscale=y` from both bcm2709 .configs and commit a follow-up. If `kmod-thermal` or `kmod-hwmon-core` error, same treatment.

- [ ] **Step 3: Attempt a build (long-running)**

Run: `cd openwrt && make -j$(nproc) V=s 2>&1 | tee /tmp/osi-bcm2709-build.log | tail -60`
Expected: completes successfully and produces an image at `openwrt/bin/targets/bcm27xx/bcm2709/`. This can take 30-120 minutes on a fresh checkout. If it fails:
  - `arch` related → bcm2709 .config target lines were corrupted; check Task 10 Step 5.
  - `add_designware_spi_kmod.patch` referenced → confirm the patch is NOT in either bcm2709 patches/series file. Re-check `cat conf/full_raspberrypi_bcm27xx_bcm2709/patches/series`.
  - Missing `flows.json` / `farming.db` → mirror tasks failed; re-run `node scripts/verify-profile-parity.js`.

- [ ] **Step 4: Verify the output image exists and has Pi 4 DTBs bundled**

Run:
```bash
ls -la openwrt/bin/targets/bcm27xx/bcm2709/
```
Expected: image filenames matching `chirpstack-gateway-os-*-full-bcm27xx-bcm2709-rpi-2*.img.gz` (or similar). At least one `.img.gz` artifact should be present.

Run (if the build tree exposes it):
```bash
strings openwrt/bin/targets/bcm27xx/bcm2709/*.img | grep -o 'bcm2711-rpi-4-b' | head -1
```
Expected: prints `bcm2711-rpi-4-b` (the Pi 4 device tree is bundled). If this errors because `.img.gz` is compressed, instead unpack to a temp file first: `zcat openwrt/bin/targets/bcm27xx/bcm2709/*.img.gz | strings | grep bcm2711 | head -5`.

- [ ] **Step 5: Document the build artifact path in the commit**

```bash
# Note the artifact name from Step 4 for the commit message and integration test
# This task does not produce a code change to commit — record findings in the
# integration test task (Task 15).
```

If a regression-fix commit is needed (e.g., dropping `tailscale` because it's unavailable on ARMv7), make that change now in `.config` and commit:
```bash
git add conf/*_raspberrypi_bcm27xx_bcm2709/.config
git commit -m "fix(bcm2709): drop <package> — unavailable for ARMv7"
```

---

## Task 14: Documentation Updates

**Files:**
- Modify: `README.md`
- Modify: `docs/build/building-firmware.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Read the current Pi-target sections to understand the format**

Run:
```bash
sed -n '40,80p' README.md
sed -n '30,60p' docs/build/building-firmware.md
grep -n 'bcm2712\|Raspberry Pi' AGENTS.md | head -20
```
Read the output. Each file has its own table or list format — match it.

- [ ] **Step 2: README.md — Add Pi 4 / Pi 3 / Pi 2 row to the supported-targets list**

Edit `README.md`. Find the supported-targets table or list (around lines 50-65). If it currently shows only Pi 5, add a row for the universal ARMv7 image. Example addition (adapt to the existing markdown format):

```markdown
| Raspberry Pi 4 / 400 / 3 / 2 | `full_raspberrypi_bcm27xx_bcm2709` (32-bit universal image) |
```

Also remove or rephrase any sentence that says "Current active development targets only the Raspberry Pi 5 configuration" — replace with "Primary target is the Raspberry Pi 5 (`bcm2712`); a universal 32-bit image for Pi 2/3/4/400 is built from `bcm2709`."

- [ ] **Step 3: docs/build/building-firmware.md — Add a Pi 4 build example**

Edit `docs/build/building-firmware.md`. Find the existing build example (around lines 38-44 that uses `bcm2712`). Add a parallel example block:

```markdown
### Raspberry Pi 4 / 400 / 3 / 2 (universal 32-bit image)

\`\`\`bash
make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709
cd openwrt && make -j$(nproc)
\`\`\`

Produces an image at `openwrt/bin/targets/bcm27xx/bcm2709/` that boots on any Pi 2 / 3 / 4 / 400 via the bundled multi-DTB.
```

(Strip the leading backslashes when actually writing — they're escapes for this plan markdown.)

- [ ] **Step 4: AGENTS.md — Note the dual-profile invariant**

Edit `AGENTS.md`. Add a short paragraph (or update an existing section about build targets) that documents:
- `bcm2712 / DEVICE_rpi-5` is the canonical source-of-truth for OSI payload files.
- `bcm2709 / DEVICE_rpi-2` mirrors that payload byte-for-byte; `scripts/verify-profile-parity.js` enforces this and runs from `scripts/verify-sync-flow.js`.
- Any change to a file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` must be propagated to `conf/full_raspberrypi_bcm27xx_bcm2709/files/`. The parity check will fail CI otherwise.

- [ ] **Step 5: Verify documentation files still parse as markdown (no broken tables)**

Open each in a markdown previewer or run:
```bash
node -e "console.log(require('fs').readFileSync('README.md','utf8').length)"
node -e "console.log(require('fs').readFileSync('docs/build/building-firmware.md','utf8').length)"
node -e "console.log(require('fs').readFileSync('AGENTS.md','utf8').length)"
```
Expected: lengths are non-zero and reasonable (no truncation).

- [ ] **Step 6: Commit**

```bash
git add README.md docs/build/building-firmware.md AGENTS.md
git commit -m "docs: document Pi 4 support via bcm2709 universal-ARMv7 profile"
```

---

## Task 15: Hardware Integration Test Checklist (Manual — Requires Pi 4 Hardware)

This task cannot be fully automated. It must be performed by an operator with a physical Pi 4 (plus a LoRaWAN concentrator hat matching the gateway target, an SD card, and access to the osi-server instance).

**Files:** No code changes. This task produces a test report committed as `docs/hardware/rpi4-bcm2709-integration-test-YYYY-MM-DD.md`.

- [ ] **Step 1: Flash the bcm2709 image to an SD card**

Use the `.img.gz` artifact produced by Task 13 Step 4. Flash with `rpi-imager`, `balenaEtcher`, or `dd`. Insert SD card into the Pi 4 and power on.

- [ ] **Step 2: First-boot smoke test**

SSH to the Pi (default IP `192.168.1.1` on a fresh OpenWrt boot; or whatever your DHCP gives it).

Run on the Pi:
```sh
cat /proc/device-tree/model
uname -a
```
Expected: model contains `Raspberry Pi 4`; uname shows `armv7l` (32-bit kernel).

- [ ] **Step 3: Verify OSI bootstrap completed**

Run on the Pi:
```sh
ls /etc/uci-defaults/ 2>/dev/null  # should be empty after first boot (defaults already applied)
/etc/init.d/osi-bootstrap status 2>&1
[ -f /data/db/farming.db ] && echo "DB OK" || echo "DB MISSING"
sqlite3 /data/db/farming.db 'PRAGMA integrity_check;'
```
Expected: empty uci-defaults dir, osi-bootstrap reports started/enabled, farming.db present, integrity `ok`.

- [ ] **Step 4: Verify Node-RED came up**

Run on the Pi:
```sh
/etc/init.d/node-red status 2>&1
ls /srv/node-red/flows.json
curl -sf http://localhost:1880/gui/ | head -20
```
Expected: Node-RED running, flows.json present, GUI HTML returned.

- [ ] **Step 5: Verify ChirpStack bootstrap and concentrator**

Run on the Pi:
```sh
node /usr/share/node-red/chirpstack-bootstrap.js 2>&1 | tail -20
/etc/init.d/chirpstack-concentratord status 2>&1
```
Expected: bootstrap completes without errors; concentratord running.

- [ ] **Step 6: End-to-end sync test against osi-server**

From your workstation, register the new Pi 4 with osi-server (per the live-deploy runbook). Then on the Pi:
```sh
logread -e osi-sync | tail -20
```
Expected: bootstrap-completed and event-poll log lines from the OSI sync flows.

- [ ] **Step 7: Send a downlink to a real device**

If a STREGA valve is paired to the gateway, use the cloud dashboard or osi-server CLI to schedule an irrigation event. Confirm the valve actuates and the `command_ack` MQTT message lands.

- [ ] **Step 8: Write the test report**

Create `docs/hardware/rpi4-bcm2709-integration-test-YYYY-MM-DD.md` (replace date with actual date) using this template:

```markdown
# Pi 4 (bcm2709) Integration Test Report

**Date:** YYYY-MM-DD
**Operator:** <name>
**Hardware:** Raspberry Pi 4 Model B <RAM> / concentrator: <model> / SD: <brand size>
**Image:** chirpstack-gateway-os-<version>-full-bcm27xx-bcm2709-rpi-2-*.img.gz (sha256: <hash>)
**Build commit:** <git rev-parse HEAD from build machine>

## Results

- [ ] Boots to login
- [ ] /proc/device-tree/model reports Raspberry Pi 4
- [ ] OSI bootstrap completed; farming.db present and `integrity_check` passes
- [ ] Node-RED running, GUI reachable at :1880/gui
- [ ] ChirpStack concentratord running
- [ ] Cloud sync bootstrap completed
- [ ] Downlink → STREGA valve actuation confirmed
- [ ] Heartbeat MQTT messages visible at server

## Anomalies / regressions

<list anything that did not match the Pi 5 reference behavior>

## Recommended follow-up

<e.g., file GitHub issues for any regressions>
```

- [ ] **Step 9: Commit the report**

```bash
git add docs/hardware/rpi4-bcm2709-integration-test-*.md
git commit -m "docs: rpi4 bcm2709 integration test report (<date>)"
```

---

## Task 16: Open a Pull Request

**Files:** No file changes — PR creation only.

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feature/rpi4-bcm2709-alignment`
Expected: branch pushed to origin.

- [ ] **Step 2: Run the full verification suite one more time before opening PR**

Run:
```bash
node scripts/verify-profile-parity.js
node scripts/verify-communication-contract.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-sync-flow.js
```
Expected: each exits 0.

- [ ] **Step 3: Open the PR**

Run:
```bash
gh pr create --title "Raspberry Pi 4 support via bcm2709 profile alignment" --body "$(cat <<'EOF'
## Summary
- Brings `conf/{base,full}_raspberrypi_bcm27xx_bcm2709` up to feature parity with `bcm2712` (the Pi 5 canonical source-of-truth) so the OpenWrt image built from bcm2709 boots and runs the full OSI OS stack on Raspberry Pi 2 / 3 / 4 / 400.
- Removes 7 legacy chirpstack-gateway-os artifacts that conflict with OSI's bootstrap.
- Adds `scripts/verify-profile-parity.js` (chained from `verify-sync-flow.js`) so future bcm2712 edits cannot silently rot the bcm2709 mirror.
- Makes `deploy.sh` seed-DB path target-aware (picks bcm2709 vs bcm2712 vs bcm2708 from `/proc/device-tree/model`).

## Test plan
- [ ] `node scripts/verify-profile-parity.js` → exits 0
- [ ] `node scripts/verify-sync-flow.js` → exits 0 (now chains parity check)
- [ ] `make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709 && cd openwrt && make -j$(nproc)` → produces `bcm27xx/bcm2709/*.img.gz`
- [ ] Pi 4 integration test report committed at `docs/hardware/rpi4-bcm2709-integration-test-YYYY-MM-DD.md` with all checkboxes ticked
EOF
)"
```
Expected: PR URL returned.

- [ ] **Step 4: Surface PR URL to user**

Report the PR URL.

---

## Known Risks and Mitigations

1. **Tailscale unavailable for ARMv7** — If `make defconfig` errors on `CONFIG_PACKAGE_tailscale=y` for bcm2709 (Task 13 Step 2), drop the line from both bcm2709 .configs and commit `fix(bcm2709): drop tailscale — unavailable for ARMv7`. Pi 4 still works; just no Tailscale.

2. **node_modules size bloat** — Task 9 copies the entire Node-RED `node_modules` tree. If git complains about file sizes, the right answer is **not** to skip the copy; it's to recognize the same issue already exists for bcm2712 and is being mirrored. If absolutely necessary, surface to user before committing — do not rewrite history or use git-lfs without consent.

3. **Build host out of disk** — A fresh OpenWrt build can require 20-40 GB. Task 13 will fail with cryptic errors if disk is full. `df -h .` before starting.

4. **Pi 4 has wifi/bluetooth not present on Pi 5's CYW43455** — The bcm2709 .config inherits bcm2712's wireless kmod set. If Pi 4's BCM43455 firmware blob is missing, wifi won't come up but ethernet still will. Document this as an integration-test anomaly; do not block on it.

5. **Parity check false negatives on Windows clones** — If anyone develops on Windows with CRLF line endings, `verify-profile-parity.js` will report drift on text files. Document in AGENTS.md that the repo expects LF.

6. **Build artifact naming may change** — Task 13 Step 4 assumes the image filename pattern matches `chirpstack-gateway-os-*-full-bcm27xx-bcm2709-rpi-2*`. If the OpenWrt feed has been renamed (e.g., to `osi-os-*`), adjust the glob. Surface to user — do not invent filenames.

---

## Out of Scope

- Building a separate aarch64 (`bcm2711`) profile for Pi-4-only 64-bit. That's a follow-up plan and would require creating new profile directories from scratch with `cortex-a72` cpu type.
- Updating ChirpStack feeds or upstream OpenWrt packages.
- Database schema changes (the seed DB is mirrored as-is from bcm2712).
- React GUI changes (also mirrored as-is from `files/usr/lib/node-red/gui/` — confirm during Task 9 if this path is part of the node-red tree or separate; if separate, add to canonical-payload list in Task 2 and re-run from Task 9).

---

## Self-Review Notes

- Every file path in this plan was verified against the current repo state at plan-writing time (2026-05-19).
- The `CONFIG_PACKAGE_kmod-hwmon-core`, `kmod-thermal`, `tailscale` deltas were extracted from a live `comm` between the two .config files.
- The forbidden-files list comes from `diff -rq` output showing files in bcm2709 absent from bcm2712.
- Task 15 (hardware test) is intentionally not a strict TDD step — there is no programmatic test for "boots on real Pi 4." The checklist + committed report is the artifact.
- `prepare_release.sh` was inspected and already includes bcm2709 invocations — no change needed there. This is noted in the File Structure section.
