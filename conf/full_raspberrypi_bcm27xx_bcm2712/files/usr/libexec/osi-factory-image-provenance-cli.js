#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const codec = require(fs.existsSync(path.join(__dirname, 'lib/factory-image-provenance.js'))
  ? path.join(__dirname, 'lib/factory-image-provenance.js')
  : path.join(__dirname, 'osi-factory-image-provenance.js'));

const SPEC = Object.freeze({
  'verify-runtime': [
    'factory-provenance', 'image-guard-manifest', 'initializer', 'factory-seed',
    'factory-seed-library', 'factory-seed-helper', 'deployment-state-cli',
    'ack-audit-cli', 'protocol-cli', 'provenance-library', 'provenance-cli',
    'expected-profile', 'result',
  ],
});

function parse(argv) {
  const verb = argv[0];
  const required = SPEC[verb];
  if (!required) throw new Error(`unknown verb: ${verb || '<missing>'}`);
  const values = {};
  for (let i = 1; i < argv.length; i += 2) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) throw new Error('invalid argv');
    const key = token.slice(2);
    if (!required.includes(key)) throw new Error(`unknown flag: --${key}`);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate flag: --${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    values[key] = value;
  }
  for (const key of required) if (!Object.hasOwn(values, key)) throw new Error(`missing required flag: --${key}`);
  for (const key of required.filter((item) => item !== 'expected-profile')) {
    if (!path.isAbsolute(values[key]) || values[key].includes('\0')) throw new Error(`--${key} must be an absolute safe path`);
  }
  codec.profileInfo(values['expected-profile']);
  return { verb, values };
}

function requireRegular(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular nonsymlink file`);
  return stat;
}

function readJson(file, label) {
  return codec.readCanonicalJson(file, label);
}

function bootId() {
  try {
    const value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(value)) return value;
  } catch (_) { /* hermetic test hosts may not expose proc; use a process-bound value. */ }
  return `test-${process.pid}-${Date.now()}`;
}

function writeExclusive(file, value) {
  const parent = path.dirname(file);
  const missing = [];
  let cursor = parent;
  while (cursor !== path.dirname(cursor)) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('verification result parent is unsafe');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(cursor);
      cursor = path.dirname(cursor);
    }
  }
  for (const directory of missing.reverse()) fs.mkdirSync(directory, { mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${codec.canonical(value)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const dirFd = fs.openSync(parent, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function verifyManifest(manifest, expectedProfile) {
  return codec.validateManifest(manifest, expectedProfile);
}

function verifyRuntime(values) {
  const expectedProfile = values['expected-profile'];
  const provenance = readJson(values['factory-provenance'], 'factory provenance');
  const manifest = verifyManifest(readJson(values['image-guard-manifest'], 'image-guard manifest'), expectedProfile);
  codec.assertProfileRelation(provenance, expectedProfile);
  if (provenance.imageBuildId !== manifest.imageBuildId) throw new Error('imageBuildId mismatch');
  if (provenance.imageGuardManifestSha256 !== codec.hashFile(values['image-guard-manifest'])) throw new Error('image-guard manifest hash mismatch');
  const candidates = {
    initializerSha256: values.initializer,
    factorySeedSha256: values['factory-seed'],
    factorySeedLibrarySha256: values['factory-seed-library'],
    factorySeedHelperSha256: values['factory-seed-helper'],
    deploymentStateCliSha256: values['deployment-state-cli'],
    // The UCI seed runner is a fixed sibling of the trusted 93 initializer;
    // keeping this derivation in the codec preserves the exact ROM argv while
    // still comparing the live 97 bytes.
    dbSeedInitializerSha256: path.join(path.dirname(values.initializer), '97_osi_db_seed'),
    commandStateAuditSha256: values['ack-audit-cli'],
    protocolCapabilityHelperSha256: values['protocol-cli'],
    protocolCapabilityCliSha256: values['protocol-cli'],
    provenanceLibrarySha256: values['provenance-library'],
    provenanceCliSha256: values['provenance-cli'],
  };
  const candidateHashes = {};
  for (const [key, file] of Object.entries(candidates)) if (file) candidateHashes[key] = codec.hashFile(file, key);
  for (const key of Object.keys(candidateHashes)) {
    if (candidateHashes[key] !== manifest.files[key]) throw new Error(`${key} hash mismatch`);
    if (candidateHashes[key] !== provenance[key]) throw new Error(`${key} provenance hash mismatch`);
  }
  if (provenance.dbSeedInitializerSha256 !== manifest.files.dbSeedInitializerSha256
      || provenance.protocolCapabilityHelperSha256 !== manifest.files.protocolCapabilityHelperSha256) {
    throw new Error('provenance anchor hash mismatch');
  }
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const result = {
    format: 1,
    kind: 'factory-verification',
    nonce,
    bootId: bootId(),
    profile: expectedProfile,
    imageBuildId: provenance.imageBuildId,
    manifestSha256: codec.hashFile(values['image-guard-manifest']),
    provenanceSha256: codec.provenanceHash(provenance),
    trusted: { ...candidateHashes },
    candidates: { ...candidateHashes },
    factoryVerification: { factorySeedEligible: true },
    expiresAt,
  };
  writeExclusive(values.result, result);
  return result;
}

function dispatch(argv) {
  const parsed = parse(argv);
  if (parsed.verb === 'verify-runtime') return verifyRuntime(parsed.values);
  throw new Error(`unsupported verb: ${parsed.verb}`);
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(dispatch(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`[factory-image-provenance] ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parse, dispatch, verifyManifest, verifyRuntime };
