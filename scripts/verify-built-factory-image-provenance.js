#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const codec = require('./lib/factory-image-provenance');
const generator = require('./generate-factory-image-provenance');
const cli = require('./factory-image-provenance-cli');

function verify({ rootfs, profile }) {
  if (!rootfs || !path.isAbsolute(rootfs)) throw new Error('rootfs must be absolute');
  codec.profileInfo(profile);
  if (fs.existsSync(path.join(rootfs, 'rom'))) throw new Error('nested /rom packaging is not allowed');
  const manifestPath = path.join(rootfs, 'usr/share/osi-deploy/image-guard-manifest.json');
  const provenancePath = path.join(rootfs, 'usr/share/osi-deploy/factory-image-provenance.json');
  const manifest = codec.readJson(manifestPath, 'built image-guard manifest');
  const provenance = codec.readJson(provenancePath, 'built factory provenance');
  cli.verifyManifest(manifest, profile);
  codec.assertProfileRelation(provenance, profile);
  if (provenance.imageGuardManifestSha256 !== codec.hashFile(manifestPath)) throw new Error('built image-guard manifest hash mismatch');
  for (const [key, relative] of Object.entries(generator.BOUND)) {
    const file = path.join(rootfs, relative);
    const digest = codec.hashFile(file, `${key} built candidate`);
    if (digest !== manifest.files[key] || digest !== provenance[key]) throw new Error(`${key} hash mismatch`);
  }
  // The lower root is the trust boundary: both runtime copies must be exact
  // source bytes, never an overlay-only replacement.
  for (const [source, relative] of [['scripts/lib/factory-image-provenance.js', 'usr/libexec/osi-factory-image-provenance.js'], ['scripts/factory-image-provenance-cli.js', 'usr/libexec/osi-factory-image-provenance-cli.js']]) {
    const sourcePath = path.resolve(__dirname, '..', source);
    if (codec.hashFile(path.join(rootfs, relative)) !== codec.hashFile(sourcePath)) throw new Error(`built resident ${relative} drift`);
  }
  return { ok: true, profile };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2); const values = {};
    for (let i = 0; i < args.length; i += 1) {
      const key = args[i];
      if (key !== '--rootfs' && key !== '--profile') throw new Error(`unknown flag: ${key}`);
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
      values[key.slice(2)] = value;
    }
    if (!values.rootfs || !values.profile) throw new Error('missing --rootfs or --profile');
    process.stdout.write(`${JSON.stringify(verify(values))}\n`);
  } catch (error) { process.stderr.write(`[verify-built-factory-image-provenance] ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { verify };
