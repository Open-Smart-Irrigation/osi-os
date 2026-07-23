'use strict';
// osi-lib — single-choke-point loader for extracted seam modules with
// fail-visible quarantine (refactor-program item 1.A1, DD2; retires #99).
// Spec: docs/superpowers/specs/2026-07-07-osi-lib-loader-design.md (§B, §C).
// Pure Node, zero runtime deps: this module must never itself fail to load.
const path = require('path');

const BASE = process.env.OSI_LIB_BASE || '/srv/node-red'; // test override; Pi default
const COOLDOWN_MS = Number(process.env.OSI_LIB_COOLDOWN_MS || 30000); // test override

// Registered seam modules. Helper-module entries (no 'codecs/' prefix) need the
// three-surface registration checked by scripts/verify-helper-registration.js;
// codec entries ride the wholesale codecs copy/fetch.
const NAME_TO_PATH = {
  'history-sync': 'osi-history-sync-helper',
  'history-router': 'osi-history-router',
  'osi-db-helper': 'osi-db-helper',
  'osi-command-ledger': 'osi-command-ledger',
  'osi-journal': 'osi-journal',
  // osi-scope-helper caches per-user authorization decisions (30s TTL) in a
  // module-local Map. The on-device seed copies this helper to BOTH
  // /srv/node-red/osi-scope-helper (fetched directly) AND
  // /srv/node-red/node_modules/osi-scope-helper (fetched separately for npm
  // resolution) — two distinct files on disk, not a symlink, so Node's
  // require cache treats them as two independent module instances with two
  // independent caches. If one consumer resolves the helper through this
  // loader while another reaches it via a bare/relative require that
  // resolves to the node_modules copy, invalidateScope() on one instance
  // leaves the other instance serving stale ALLOWs for up to 30s — a real
  // authorization-staleness hazard, not a cosmetic one.
  // MUST be loaded only via osiLib.require('scope'). Never
  // require('osi-scope-helper') or a relative path to it from a flow.
  'scope': 'osi-scope-helper',
  'dendro-analytics': 'osi-dendro-analytics',
  'zone-env': 'osi-zone-env',
  'device-writer': 'osi-device-writer',
  'uc512-normalize': 'osi-uc512-normalize',
  'lsn50-normalize': 'osi-lsn50-normalize',
  'agroscope-uplink-transform': 'codecs/agroscope_uplink_transform',
};

const cache = new Map();         // name -> loaded module (success only)
const cooldownUntil = new Map(); // name -> epoch ms of next retry attempt

function osiRequire(name) {
  if (cache.has(name)) return { ok: true, value: cache.get(name) };
  const now = Date.now();
  if (now < (cooldownUntil.get(name) || 0)) {
    return { ok: false, error: 'quarantined, retry after cooldown', quarantined: true };
  }
  const rel = NAME_TO_PATH[name];
  if (!rel) return { ok: false, error: 'unknown osi-lib module: ' + name };
  try {
    const mod = require(path.join(BASE, rel)); // eslint-disable-line global-require
    cache.set(name, mod);
    cooldownUntil.delete(name);
    return { ok: true, value: mod };
  } catch (err) {
    cooldownUntil.set(name, now + COOLDOWN_MS);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { require: osiRequire, NAME_TO_PATH };
