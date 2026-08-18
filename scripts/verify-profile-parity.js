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
  'files/etc/init.d/osi-rootfs-resize',
  'files/etc/init.d/osi-bootstrap',
  'files/etc/init.d/osi-identityd',
  'files/etc/nginx',
  'files/etc/redis.conf',
  'files/etc/sysupgrade.conf',
  'files/etc/uci-defaults/90_osi_rootfs_grow',
  'files/etc/uci-defaults/94_osi_identityd_enable',
  'files/etc/uci-defaults/95_osi_bootstrap_enable',
  'files/etc/uci-defaults/96_osi_server_config',
  'files/etc/uci-defaults/97_osi_db_seed',
  'files/etc/uci-defaults/98_osi_node_red_seed',
  'files/etc/uci-defaults/99_config_chirpstack_ap',
  'files/etc/uci-defaults/99_set_hostname',
  'files/etc/uci-defaults/99_set_sx1301_gateway_id',
  'files/etc/uci-defaults/99_tailscale_init',
  'files/usr/libexec/osi-gateway-identity.sh',
  'files/usr/libexec/osi-identityd.sh',
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

function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// A symlink is only ever compared by its own raw target text (see hashPath below) - its
// target is never opened, read through, or followed. As a defensive floor, the target must
// lexically resolve inside `root`, every intermediate component must lstat as a directory,
// and its immediate directory entry must exist, so neither an escaping nor a broken link
// can pass parity on target text alone.
function assertSymlinkTargetWithinRoot(linkPath, target, root) {
  const resolved = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(path.dirname(linkPath), target);
  const relFromRoot = path.relative(root, resolved);
  const escapes = path.isAbsolute(relFromRoot) || relFromRoot === '..' || relFromRoot.startsWith('..' + path.sep);
  if (escapes) {
    throw new Error(`${path.relative(root, linkPath)}: symlink target escapes the repository root (-> ${target})`);
  }
  const parts = relFromRoot.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const st = lstatSafe(current);
    if (!st) {
      throw new Error(`${path.relative(root, linkPath)}: symlink target is missing (-> ${target})`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(`${path.relative(root, linkPath)}: symlink target traverses intermediate symlink ${path.relative(root, current)} (-> ${target})`);
    }
    if (!st.isDirectory()) {
      throw new Error(`${path.relative(root, linkPath)}: symlink target has a non-directory intermediate component ${path.relative(root, current)} (-> ${target})`);
    }
  }
  return resolved;
}

// Hash a file, directory (recursively), or symlink. Returns hex string, or null if the path
// does not exist. Uses lstat (never stat) so a symlink is never transparently followed: its
// entry type and, for a symlink, its raw (unresolved) target text are folded into the hash
// alongside the content hash for files / recursive hash for directories. This means a
// symlink can never be mistaken for a regular file or directory with matching resolved
// content. The immediate target is lstat-validated without reading through it and must be
// a regular file or directory, so broken links, symlink chains, and special targets are
// rejected even when both profiles contain identical raw target text.
function hashPath(p, root) {
  const st = lstatSafe(p);
  if (!st) return null;
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(p);
    const resolvedTarget = assertSymlinkTargetWithinRoot(p, target, root);
    const targetStat = lstatSafe(resolvedTarget);
    if (!targetStat) {
      throw new Error(`${path.relative(root, p)}: symlink target is missing (-> ${target})`);
    }
    if (!targetStat.isFile() && !targetStat.isDirectory()) {
      if (targetStat.isSymbolicLink()) {
        throw new Error(`${path.relative(root, p)}: final target is a symlink; symlink chains are forbidden (-> ${target})`);
      }
      throw new Error(`${path.relative(root, p)}: unsupported final target type; expected regular file or directory (-> ${target})`);
    }
    return 'symlink:' + crypto.createHash('sha256').update(target).digest('hex');
  }
  if (st.isFile()) {
    return 'file:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  if (st.isDirectory()) {
    const entries = fs.readdirSync(p).sort();
    const h = crypto.createHash('sha256');
    h.update('dir:');
    for (const e of entries) {
      h.update(e);
      h.update('\0');
      const sub = hashPath(path.join(p, e), root);
      h.update(sub === null ? 'MISSING' : sub);
      h.update('\0');
    }
    return h.digest('hex');
  }
  return null;
}

function hashPathOrFail(rel, p, root, label) {
  try {
    return hashPath(p, root);
  } catch (error) {
    fail(`${rel}: ${error.message}`);
    return undefined;
  }
}

function run() {
  for (const mirror of MIRROR_PROFILES) {
    console.log('\n=== ' + mirror + ' ===');
    for (const rel of CANONICAL_PAYLOAD) {
      const src = path.join(REPO_ROOT, SOURCE_PROFILE, rel);
      const dst = path.join(REPO_ROOT, mirror, rel);
      const sh = hashPathOrFail(rel, src, REPO_ROOT, SOURCE_PROFILE);
      if (sh === undefined) continue;
      const dh = hashPathOrFail(rel, dst, REPO_ROOT, mirror);
      if (dh === undefined) continue;
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
}

if (require.main === module) {
  run();
}

module.exports = { hashPath, run };
