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
  'dendro-analytics': 'osi-dendro-analytics',
  'zone-env': 'osi-zone-env',
  'device-writer': 'osi-device-writer',
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
