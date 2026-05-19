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
  'files/etc/uci-defaults/98_osi_node_red_seed',
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
