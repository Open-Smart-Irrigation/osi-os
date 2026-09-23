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
  'network-api': 'osi-network-api',
  'radio': 'osi-radio-helper',
  'installation-location': 'osi-installation-location-helper',
  'installation': 'osi-installation-helper',
  'history-router': 'osi-history-router',
  'osi-db-helper': 'osi-db-helper',
  'osi-command-ledger': 'osi-command-ledger',
  'scoped-access-commands': 'osi-scoped-access-commands',
  'zone-commands': 'osi-zone-commands',
  'device-commands': 'osi-device-commands',
  'osi-journal': 'osi-journal',
'journal-replication': 'osi-journal-replication',
  // #252 root cause: this name was referenced by sdi12-recipe-poll-fn
  // (osiLib.require('chirpstack')) but was never registered here, so the
  // load always failed with "unknown osi-lib module: chirpstack" on every
  // gateway -- not only ones without an SDI-12 profile. The package itself
  // (osi-chirpstack-helper) was already fully wired into package.json,
  // package-lock.json, the seed module-copy loop, and deploy.sh; only this
  // registry entry was missing.
  'chirpstack': 'osi-chirpstack-helper',
  // Authorization cache must have one module instance. Flow consumers load it
  // only through osiLib.require('scope'), never with a bare/relative require.
  'scope': 'osi-scope-helper',
  'rejection-recovery': 'osi-rejection-recovery',
  'dendro-analytics': 'osi-dendro-analytics',
  'zone-env': 'osi-zone-env',
  'device-writer': 'osi-device-writer',
  // Zone and device rename: the name rule, the two writers and the receiver
  // for UPSERT_DEVICE_NAME / UPSERT_ZONE_NAME live in one module.
  'entity-name': 'osi-entity-name',
  'uc512-normalize': 'osi-uc512-normalize',
  'lsn50-normalize': 'osi-lsn50-normalize',
  'sdi12-normalize': 'osi-sdi12-normalize',
  'sdi12-recipe': 'osi-sdi12-recipe',
  'sdi12-commissioning': 'osi-sdi12-commissioning',
  'sdi12-reassemble': 'osi-sdi12-reassemble',
  'osi-valve-control': 'osi-valve-control',
  'osi-system-settings': 'osi-system-settings',
  'agroscope-uplink-transform': 'codecs/agroscope_uplink_transform',
  // F83 (2026-09-17 overnight): bounded in-memory idempotency guard shared by
  // every device_data-writing decode function, so a redelivered/retried
  // ChirpStack uplink is dropped exactly once instead of double-inserted.
  'uplink-dedup': 'osi-uplink-dedup-guard',
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
