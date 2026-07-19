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

const FIELDS = Object.freeze([
  'format', 'imageBuildId', 'profile', 'imageGuardManifestSha256',
  'initializerSha256', 'factorySeedSha256', 'factorySeedHelperSha256',
  'dbSeedInitializerSha256',
  'commandStateAuditSha256', 'protocolCapabilityHelperSha256',
  'protocolCapabilityCliSha256',
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
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('imageBuildId must be a bounded path-safe identifier');
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
  return value;
}

function hashFile(file, label = file) {
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
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular nonsymlink file`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
}

module.exports = {
  FIELDS,
  PROFILES,
  canonical,
  canonicalBytes,
  sha256,
  provenanceHash,
  profileInfo,
  validate,
  assertProfileRelation,
  hashFile,
  assertAbsolutePath,
  readJson,
};
