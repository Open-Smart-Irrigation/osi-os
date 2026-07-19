'use strict';

/*
 * The factory provenance codec is deliberately small and dependency-free.
 * Every producer (image generator), verifier, and ROM consumer uses these
 * routines so an image cannot silently acquire a second schema authority.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROFILES = Object.freeze({
  bcm2712: Object.freeze({ profile: 'bcm2712', target: 'bcm27xx/bcm2712', device: 'rpi-5' }),
  bcm2709: Object.freeze({ profile: 'bcm2709', target: 'bcm27xx/bcm2709', device: 'rpi-2' }),
});

// The manifest is the single source of truth for the ROM trust boundary.  A
// producer, source verifier, built-image verifier, and ROM consumer all import
// these exact constants; none of them may maintain a private list.
const RC_LINKS = Object.freeze({
  S90osiDbIntegrity: '/etc/init.d/osi-db-integrity',
  S98osiIdentityd: '/etc/init.d/osi-identityd',
  K98osiIdentityd: '/etc/init.d/osi-identityd',
  S99nodeRed: '/etc/init.d/node-red',
  K99nodeRed: '/etc/init.d/node-red',
  S99osiBootstrap: '/etc/init.d/osi-bootstrap',
});
const UCI_DEFAULTS_ORDER = Object.freeze([
  '93_osi_deploy_guard_init', '94_osi_identityd_enable', '97_osi_db_seed',
]);

// Every resident executable that participates in image bootstrap is bound.
// protocolCapabilityHelperSha256 and protocolCapabilityCliSha256 intentionally
// point at the same helper in this checkpoint: the protocol helper/CLI split
// lands in the following sync slice, but both manifest fields remain explicit.
const BOUND = Object.freeze({
  initializerSha256: 'etc/uci-defaults/93_osi_deploy_guard_init',
  dbSeedInitializerSha256: 'etc/uci-defaults/97_osi_db_seed',
  factorySeedSha256: 'usr/share/db/farming.db',
  factorySeedLibrarySha256: 'usr/libexec/osi-factory-database-seed.js',
  factorySeedHelperSha256: 'usr/libexec/osi-factory-database-seed-cli.js',
  deploymentStateCliSha256: 'usr/libexec/osi-deployment-state-cli.js',
  commandStateAuditSha256: 'usr/libexec/osi-audit-command-ack-state.js',
  deploymentStateLibrarySha256: 'usr/libexec/osi-deployment-state.js',
  protocolCapabilityHelperSha256: 'usr/libexec/osi-sync-protocol-capability-cli.js',
  protocolCapabilityCliSha256: 'usr/libexec/osi-sync-protocol-capability-cli.js',
  provenanceLibrarySha256: 'usr/libexec/osi-factory-image-provenance.js',
  provenanceCliSha256: 'usr/libexec/osi-factory-image-provenance-cli.js',
});

const MANIFEST_FILE_KEYS = Object.freeze(Object.keys(BOUND));
const MANIFEST_FIELDS = Object.freeze(['format', 'profile', 'imageBuildId', 'rcLinks', 'uciDefaultsOrder', 'files']);

const FIELDS = Object.freeze([
  'format', 'imageBuildId', 'profile', 'imageGuardManifestSha256',
  'initializerSha256', 'factorySeedSha256', 'factorySeedHelperSha256',
  'dbSeedInitializerSha256',
  'factorySeedLibrarySha256', 'deploymentStateCliSha256',
  'commandStateAuditSha256', 'deploymentStateLibrarySha256', 'protocolCapabilityHelperSha256',
  'protocolCapabilityCliSha256', 'provenanceLibrarySha256', 'provenanceCliSha256',
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalBytes(value) {
  return Buffer.from(canonical(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function provenanceHash(value) {
  return sha256(canonicalBytes(validate(value)));
}

function profileInfo(profile) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`unsupported profile: ${profile}`);
  return PROFILES[profile];
}

function assertHash(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 hash`);
  }
}

function assertSafeBuildId(value) {
  if (typeof value !== 'string' || !/^\d{8}-factory-(bcm2712|bcm2709)$/.test(value)) {
    throw new Error('imageBuildId must match YYYYMMDD-factory-<profile>');
  }
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provenance must be an object');
  const keys = Object.keys(value).sort();
  const expected = [...FIELDS].sort();
  if (keys.join('\0') !== expected.join('\0')) {
    const unknown = keys.filter((key) => !FIELDS.includes(key));
    const missing = expected.filter((key) => !keys.includes(key));
    if (unknown.length) throw new Error(`unknown field: ${unknown[0]}`);
    throw new Error(`missing field: ${missing[0]}`);
  }
  if (value.format !== 2) throw new Error('format must be 2');
  assertSafeBuildId(value.imageBuildId);
  profileInfo(value.profile);
  for (const field of FIELDS.filter((key) => key.endsWith('Sha256'))) assertHash(value[field], field);
  return value;
}

function assertProfileRelation(value, expectedProfile) {
  validate(value);
  profileInfo(expectedProfile);
  if (value.profile !== expectedProfile) throw new Error(`profile mismatch: expected ${expectedProfile}, got ${value.profile}`);
  if (!/^\d{8}-factory-(bcm2712|bcm2709)$/.test(value.imageBuildId)
      || !value.imageBuildId.endsWith(`-factory-${expectedProfile}`)) {
    throw new Error(`imageBuildId/profile relation mismatch for ${expectedProfile}`);
  }
  return value;
}

function assertNoSymlinkAncestors(file, label = file) {
  assertAbsolutePath(file, label);
  const components = file.split(path.sep).filter(Boolean);
  let cursor = path.parse(file).root;
  for (const component of components) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`${label} path is unreadable: ${error.message}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} has a symlink ancestor: ${cursor}`);
  }
  return file;
}

function safeJoin(root, relative, label = relative) {
  assertAbsolutePath(root, 'root');
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\0')) {
    throw new Error(`${label} must be a relative path`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes root`);
  }
  assertNoSymlinkAncestors(resolved, label);
  return resolved;
}

function hashFile(file, label = file) {
  assertNoSymlinkAncestors(file, label);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { throw new Error(`${label} is missing: ${error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular nonsymlink file`);
  return sha256(fs.readFileSync(file));
}

function assertAbsolutePath(file, label = 'path') {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error(`${label} must be an absolute safe path`);
  return file;
}

function readJson(file, label = file) {
  assertAbsolutePath(file, label);
  assertNoSymlinkAncestors(file, label);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular nonsymlink file`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
}

function readCanonicalJson(file, label = file) {
  const value = readJson(file, label);
  const raw = fs.readFileSync(file);
  const expected = Buffer.from(`${canonical(value)}\n`);
  if (!raw.equals(expected)) throw new Error(`${label} is not canonical JSON bytes`);
  return value;
}

function validateManifest(manifest, expectedProfile) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('image-guard manifest must be an object');
  const keys = Object.keys(manifest).sort();
  if (keys.join('\0') !== [...MANIFEST_FIELDS].sort().join('\0')) throw new Error('image-guard manifest schema mismatch');
  if (manifest.format !== 1 || manifest.profile !== expectedProfile) throw new Error('image-guard manifest profile/format mismatch');
  assertProfileInfo(expectedProfile);
  assertSafeBuildId(manifest.imageBuildId);
  if (!manifest.imageBuildId.endsWith(`-factory-${expectedProfile}`)) throw new Error('image-guard manifest imageBuildId/profile relation mismatch');
  if (canonical(manifest.rcLinks) !== canonical(RC_LINKS)) throw new Error('image-guard manifest rc-link topology mismatch');
  if (canonical(manifest.uciDefaultsOrder) !== canonical(UCI_DEFAULTS_ORDER)) throw new Error('image-guard manifest UCI ordering mismatch');
  if (!manifest.files || Object.keys(manifest.files).sort().join('\0') !== [...MANIFEST_FILE_KEYS].sort().join('\0')) throw new Error('image-guard manifest file anchors mismatch');
  for (const key of MANIFEST_FILE_KEYS) assertHash(manifest.files[key], `image-guard manifest ${key}`);
  return manifest;
}

function assertProfileInfo(profile) { return profileInfo(profile); }

module.exports = {
  BOUND,
  RC_LINKS,
  UCI_DEFAULTS_ORDER,
  MANIFEST_FILE_KEYS,
  MANIFEST_FIELDS,
  FIELDS,
  PROFILES,
  canonical,
  canonicalBytes,
  sha256,
  provenanceHash,
  profileInfo,
  assertSafeBuildId,
  validate,
  assertProfileRelation,
  validateManifest,
  hashFile,
  assertAbsolutePath,
  assertNoSymlinkAncestors,
  safeJoin,
  readJson,
  readCanonicalJson,
};
