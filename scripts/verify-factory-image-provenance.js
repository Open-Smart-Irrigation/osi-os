#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const codec = require('./lib/factory-image-provenance');
const generator = require('./generate-factory-image-provenance');
const cli = require('./factory-image-provenance-cli');

function verifyProfile(root, profile) {
  const artifacts = generator.makeArtifacts({ root, profile, imageBuildId: undefined });
  const manifest = codec.readCanonicalJson(artifacts.manifestPath, `${profile} image-guard manifest`);
  const provenance = codec.readCanonicalJson(artifacts.provenancePath, `${profile} factory provenance`);
  cli.verifyManifest(manifest, profile);
  codec.assertProfileRelation(provenance, profile);
  if (!Buffer.from(`${codec.canonical(artifacts.manifest)}\n`).equals(fs.readFileSync(artifacts.manifestPath))) throw new Error(`${profile} image-guard manifest hash mismatch`);
  if (!Buffer.from(`${codec.canonical(artifacts.provenance)}\n`).equals(fs.readFileSync(artifacts.provenancePath))) throw new Error(`${profile} factory provenance hash mismatch`);
  for (const [key, relative] of Object.entries(codec.BOUND)) {
    const file = codec.safeJoin(artifacts.filesRoot, relative, `${profile} ${key}`);
    if (codec.hashFile(file, `${profile} ${key}`) !== manifest.files[key]) throw new Error(`${profile} ${key} hash mismatch`);
  }
  const sourceLib = path.join(root, 'scripts/lib/factory-image-provenance.js');
  const sourceCli = path.join(root, 'scripts/factory-image-provenance-cli.js');
  const residentLib = codec.safeJoin(artifacts.filesRoot, 'usr/libexec/osi-factory-image-provenance.js', `${profile} resident provenance library`);
  const residentCli = codec.safeJoin(artifacts.filesRoot, 'usr/libexec/osi-factory-image-provenance-cli.js', `${profile} resident provenance CLI`);
  if (!Buffer.from(fs.readFileSync(sourceLib)).equals(Buffer.from(fs.readFileSync(residentLib)))) throw new Error(`${profile} resident provenance library drift`);
  if (!Buffer.from(fs.readFileSync(sourceCli)).equals(Buffer.from(fs.readFileSync(residentCli)))) throw new Error(`${profile} resident provenance CLI drift`);
  return provenance;
}

function verify(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const profiles = options.profile ? [options.profile] : Object.keys(codec.PROFILES);
  const values = profiles.map((profile) => verifyProfile(root, profile));
  if (values.length > 1) {
    const shared = codec.MANIFEST_FILE_KEYS;
    for (const key of shared) if (new Set(values.map((value) => value[key])).size !== 1) throw new Error(`shared provenance anchor drift: ${key}`);
  }
  return { ok: true, profiles };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const options = { root: path.resolve(__dirname, '..') };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--root' || arg === '--profile') options[arg.slice(2)] = args[++i];
      else throw new Error(`unknown flag: ${arg}`);
    }
    if (!path.isAbsolute(options.root)) throw new Error('--root must be absolute');
    process.stdout.write(`${JSON.stringify(verify(options))}\n`);
  } catch (error) { process.stderr.write(`[verify-factory-image-provenance] ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { verify, verifyProfile };
