#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const codec = require('./lib/factory-image-provenance');

const REPO_ROOT = path.resolve(__dirname, '..');
const BOUND = codec.BOUND;
const RC_LINKS = codec.RC_LINKS;
const UCI_ORDER = codec.UCI_DEFAULTS_ORDER;

function profileRoot(root, profile) {
  codec.profileInfo(profile);
  return codec.safeJoin(root, path.join('conf', `full_raspberrypi_bcm27xx_${profile}`, 'files'), `${profile} profile root`);
}

function paths(root, profile) {
  const filesRoot = profileRoot(root, profile);
  const manifest = codec.safeJoin(filesRoot, 'usr/share/osi-deploy/image-guard-manifest.json', `${profile} manifest`);
  const provenance = codec.safeJoin(filesRoot, 'usr/share/osi-deploy/factory-image-provenance.json', `${profile} provenance`);
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
  codec.assertSafeBuildId(imageBuildId);
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
  codec.validateManifest(manifest, profile);
  codec.validate(provenance);
  return { ...p, manifestPath: p.manifest, provenancePath: p.provenance, manifest, provenance, manifestBytes, provenanceBytes: codec.canonicalBytes(provenance) };
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeJson(file, bytes) {
  codec.assertNoSymlinkAncestors(file, 'provenance output');
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
  if (options.refreshBoundHashes) {
    const artifacts = refreshArtifacts(options);
    if (options.check) return check({ ...options, refreshBoundHashes: false, preserveImageBuildId: false });
    // All candidates are built and validated before the first replacement.
    // Manifests land before their dependent provenance records.
    for (const artifact of artifacts) writeJson(artifact.manifestPath, artifact.manifestBytes);
    for (const artifact of artifacts) writeJson(artifact.provenancePath, artifact.provenanceBytes);
    return { ok: true, profiles: artifacts.map((item) => item.provenance.profile) };
  }
  const artifacts = makeArtifacts({ ...options, root: options.root || REPO_ROOT });
  if (options.check) return check(options);
  writeJson(artifacts.manifestPath, artifacts.manifestBytes);
  writeJson(artifacts.provenancePath, artifacts.provenanceBytes);
  return artifacts.provenance;
}

function refreshArtifacts(options) {
  const root = options.root || REPO_ROOT;
  const profiles = options.profile ? [options.profile] : Object.keys(codec.PROFILES);
  const artifacts = profiles.map((profile) => {
    const p = paths(root, profile);
    const existing = codec.readCanonicalJson(p.provenance, `${profile} factory provenance`);
    codec.assertProfileRelation(existing, profile);
    if (options.preserveImageBuildId && !existing.imageBuildId) throw new Error(`${profile} provenance has no imageBuildId to preserve`);
    return makeArtifacts({ root, profile, imageBuildId: existing.imageBuildId });
  });
  const ids = new Set(artifacts.map((item) => item.provenance.imageBuildId));
  if (ids.size !== artifacts.length) throw new Error('refresh profiles must have distinct imageBuildId values');
  return artifacts;
}

function check(options) {
  const root = options.root || REPO_ROOT;
  const profiles = options.profile ? [options.profile] : Object.keys(codec.PROFILES);
  for (const profile of profiles) {
    const p = paths(root, profile);
    const artifacts = makeArtifacts({ root, profile, imageBuildId: options.imageBuildId || readExistingBuildId(p.provenance) });
    const manifest = codec.readCanonicalJson(p.manifest, 'image-guard manifest');
    const provenance = codec.readCanonicalJson(p.provenance, 'factory provenance');
    codec.validateManifest(manifest, profile);
    codec.validate(provenance);
    if (Buffer.from(`${codec.canonical(artifacts.manifest)}\n`).equals(Buffer.from(`${codec.canonical(manifest)}\n`)) === false) throw new Error(`${profile} image-guard manifest hash mismatch`);
    if (Buffer.from(`${codec.canonical(artifacts.provenance)}\n`).equals(Buffer.from(`${codec.canonical(provenance)}\n`)) === false) throw new Error(`${profile} factory provenance hash mismatch`);
  }
  return { ok: true, profiles };
}

function parse(argv) {
  const options = { root: REPO_ROOT, write: false, check: false, refreshBoundHashes: false, preserveImageBuildId: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`duplicate flag: ${arg}`);
    seen.add(arg);
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
  if (options.preserveImageBuildId && !options.refreshBoundHashes) throw new Error('--preserve-image-build-id requires --refresh-bound-hashes');
  if (options.refreshBoundHashes && !options.preserveImageBuildId) throw new Error('--refresh-bound-hashes requires --preserve-image-build-id');
  if (options.refreshBoundHashes && options.imageBuildId) throw new Error('--image-build-id cannot be combined with --refresh-bound-hashes');
  if (options.refreshBoundHashes && options.profile) throw new Error('--refresh-bound-hashes always covers both profiles');
  if (options.profile) codec.profileInfo(options.profile);
  if (!options.profile && options.write && !options.refreshBoundHashes) throw new Error('--profile is required with --write');
  if (options.root.includes('\0') || !path.isAbsolute(options.root)) throw new Error('--root must be absolute');
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
