#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const codec = require('./lib/factory-image-provenance');

const REPO_ROOT = path.resolve(__dirname, '..');
const BOUND = Object.freeze({
  initializerSha256: 'etc/uci-defaults/93_osi_deploy_guard_init',
  factorySeedSha256: 'usr/share/db/farming.db',
  factorySeedHelperSha256: 'usr/libexec/osi-factory-database-seed-cli.js',
  dbSeedInitializerSha256: 'etc/uci-defaults/97_osi_db_seed',
  commandStateAuditSha256: 'usr/libexec/osi-audit-command-ack-state.js',
  // The factory-only protocol CLI is the sole ROM authority in this
  // checkpoint; the later sync slice may split its helper without changing
  // the format-2 field or first-boot argv.
  protocolCapabilityHelperSha256: 'usr/libexec/osi-sync-protocol-capability-cli.js',
  protocolCapabilityCliSha256: 'usr/libexec/osi-sync-protocol-capability-cli.js',
});
const RC_LINKS = Object.freeze({
  S90osiDbIntegrity: '/etc/init.d/osi-db-integrity',
  S98osiIdentityd: '/etc/init.d/osi-identityd',
  K98osiIdentityd: '/etc/init.d/osi-identityd',
  S99nodeRed: '/etc/init.d/node-red',
  K99nodeRed: '/etc/init.d/node-red',
  S99osiBootstrap: '/etc/init.d/osi-bootstrap',
});
const UCI_ORDER = Object.freeze(['93_osi_deploy_guard_init', '94_osi_identityd_enable', '97_osi_db_seed']);

function profileRoot(root, profile) {
  codec.profileInfo(profile);
  return path.join(root, 'conf', `full_raspberrypi_bcm27xx_${profile}`, 'files');
}

function paths(root, profile) {
  const filesRoot = profileRoot(root, profile);
  const manifest = path.join(filesRoot, 'usr/share/osi-deploy/image-guard-manifest.json');
  const provenance = path.join(filesRoot, 'usr/share/osi-deploy/factory-image-provenance.json');
  return { filesRoot, manifest, provenance };
}

function readExistingBuildId(file) {
  try {
    const value = codec.readJson(file, 'factory provenance');
    return value.imageBuildId;
  } catch (_) { return null; }
}

function makeArtifacts(options) {
  const p = paths(options.root, options.profile);
  const files = {};
  for (const [key, relative] of Object.entries(BOUND)) files[key] = codec.hashFile(path.join(p.filesRoot, relative), relative);
  const profile = options.profile;
  const imageBuildId = options.imageBuildId || readExistingBuildId(p.provenance);
  if (!imageBuildId) throw new Error('imageBuildId is required for a new provenance record');
  const manifest = {
    format: 1,
    profile,
    imageBuildId,
    rcLinks: RC_LINKS,
    uciDefaultsOrder: UCI_ORDER,
    files,
  };
  const manifestBytes = codec.canonicalBytes(manifest);
  const provenance = {
    format: 2,
    imageBuildId,
    profile,
    imageGuardManifestSha256: codec.sha256(Buffer.from(`${manifestBytes.toString()}\n`)),
    ...files,
  };
  codec.validate(provenance);
  return { ...p, manifestPath: p.manifest, provenancePath: p.provenance, manifest, provenance, manifestBytes, provenanceBytes: codec.canonicalBytes(provenance) };
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeJson(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, 'wx', 0o644);
  try {
    fs.writeFileSync(fd, `${bytes.toString()}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
}

function generate(options) {
  const artifacts = makeArtifacts({ ...options, root: options.root || REPO_ROOT });
  if (options.check) return check(options);
  writeJson(artifacts.manifestPath, artifacts.manifestBytes);
  writeJson(artifacts.provenancePath, artifacts.provenanceBytes);
  return artifacts.provenance;
}

function check(options) {
  const root = options.root || REPO_ROOT;
  const profiles = options.profile ? [options.profile] : Object.keys(codec.PROFILES);
  for (const profile of profiles) {
    const p = paths(root, profile);
    const artifacts = makeArtifacts({ root, profile, imageBuildId: options.imageBuildId || readExistingBuildId(p.provenance) });
    const manifest = codec.readJson(p.manifest, 'image-guard manifest');
    const provenance = codec.readJson(p.provenance, 'factory provenance');
    if (codec.canonical(manifest) !== codec.canonical(artifacts.manifest)) throw new Error(`${profile} image-guard manifest hash mismatch`);
    if (codec.canonical(provenance) !== codec.canonical(artifacts.provenance)) throw new Error(`${profile} factory provenance hash mismatch`);
  }
  return { ok: true, profiles };
}

function parse(argv) {
  const options = { root: REPO_ROOT, write: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--refresh-bound-hashes') options.refreshBoundHashes = true;
    else if (arg === '--preserve-image-build-id') options.preserveImageBuildId = true;
    else if (arg.startsWith('--') && ['--root', '--profile', '--image-build-id'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      const key = arg === '--image-build-id' ? 'imageBuildId' : arg.slice(2);
      options[key] = value;
    } else throw new Error(`unknown flag: ${arg}`);
  }
  if (options.write === options.check) throw new Error('choose exactly one of --write or --check');
  if (options.profile) codec.profileInfo(options.profile);
  if (!options.profile && options.write) throw new Error('--profile is required with --write');
  if (options.root.includes('\0') || !path.isAbsolute(options.root)) throw new Error('--root must be absolute');
  if (options.refreshBoundHashes && !options.preserveImageBuildId) throw new Error('--refresh-bound-hashes requires --preserve-image-build-id');
  return options;
}

if (require.main === module) {
  try {
    const options = parse(process.argv.slice(2));
    const result = options.check ? check(options) : generate(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`[factory-image-provenance-generator] ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { BOUND, RC_LINKS, UCI_ORDER, paths, makeArtifacts, generate, check, parse };
