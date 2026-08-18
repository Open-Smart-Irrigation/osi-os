#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const codec = require('./lib/factory-image-provenance');
const cli = require('./factory-image-provenance-cli');

function verify({ rootfs, profile }) {
  if (!rootfs || !path.isAbsolute(rootfs)) throw new Error('rootfs must be absolute');
  codec.assertNoSymlinkAncestors(rootfs, 'rootfs');
  const rootStat = fs.lstatSync(rootfs);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('rootfs must be a regular directory');
  codec.profileInfo(profile);
  const romPath = codec.safeJoin(rootfs, 'rom', 'nested /rom packaging');
  try { fs.lstatSync(romPath); throw new Error('nested /rom packaging is not allowed'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const manifestPath = codec.safeJoin(rootfs, 'usr/share/osi-deploy/image-guard-manifest.json', 'built image-guard manifest');
  const provenancePath = codec.safeJoin(rootfs, 'usr/share/osi-deploy/factory-image-provenance.json', 'built factory provenance');
  const requireAnchorMode = (file, label) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o644) throw new Error(`${label} must be mode 644`);
  };
  requireAnchorMode(manifestPath, 'built image-guard manifest');
  requireAnchorMode(provenancePath, 'built factory provenance');
  const manifest = codec.readCanonicalJson(manifestPath, 'built image-guard manifest');
  const provenance = codec.readCanonicalJson(provenancePath, 'built factory provenance');
  cli.verifyManifest(manifest, profile);
  codec.assertProfileRelation(provenance, profile);
  if (provenance.imageBuildId !== manifest.imageBuildId) throw new Error('built imageBuildId mismatch');
  if (provenance.imageGuardManifestSha256 !== codec.hashFile(manifestPath)) throw new Error('built image-guard manifest hash mismatch');
  const requireMode = (file, mode, label) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular nonsymlink file`);
    if ((stat.mode & 0o7777) !== mode) throw new Error(`${label} must be mode ${mode.toString(8)}`);
  };
  for (const [key, relative] of Object.entries(codec.BOUND)) {
    const file = codec.safeJoin(rootfs, relative, `${key} built candidate`);
    const digest = codec.hashFile(file, `${key} built candidate`);
    if (digest !== manifest.files[key] || digest !== provenance[key]) throw new Error(`${key} hash mismatch`);
    const executable = new Set([
      'etc/uci-defaults/93_osi_deploy_guard_init', 'etc/uci-defaults/97_osi_db_seed',
      'usr/libexec/osi-factory-database-seed-cli.js', 'usr/libexec/osi-deployment-state-cli.js',
      'usr/libexec/osi-audit-command-ack-state.js', 'usr/libexec/osi-sync-protocol-capability-cli.js',
    ]);
    const expectedMode = executable.has(relative) ? 0o755 : 0o644;
    requireMode(file, expectedMode, `${key} built candidate`);
  }
  for (const [label, manifestTarget] of Object.entries(codec.RC_LINKS)) {
    const name = codec.RC_LINK_PATHS[label];
    const target = codec.RC_LINK_TARGETS[label];
    if (!name || !target || manifestTarget !== '/etc/init.d/' + target.split('/').pop()) throw new Error(`${label} rc topology mapping mismatch`);
    const link = path.join(rootfs, 'etc/rc.d', name);
    codec.assertNoSymlinkAncestors(path.dirname(link), `${name} rc directory`);
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error(`${name} must be a symlink`);
    if (fs.readlinkSync(link) !== target) throw new Error(`${name} target mismatch`);
    const targetPath = codec.safeJoin(rootfs, path.join('etc/rc.d', target), `${name} init target`);
    const targetStat = fs.lstatSync(targetPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || (targetStat.mode & 0o7777) !== 0o755) throw new Error(`${name} init target must be mode 755`);
  }
  // The lower root is the trust boundary: both runtime copies must be exact
  // source bytes, never an overlay-only replacement.
  for (const [source, relative] of [
    ['scripts/lib/factory-image-provenance.js', 'usr/libexec/osi-factory-image-provenance.js'],
    ['scripts/lib/deployment-state.js', 'usr/libexec/osi-deployment-state.js'],
    ['scripts/factory-image-provenance-cli.js', 'usr/libexec/osi-factory-image-provenance-cli.js'],
  ]) {
    const sourcePath = path.resolve(__dirname, '..', source);
    if (codec.hashFile(codec.safeJoin(rootfs, relative, `built resident ${relative}`)) !== codec.hashFile(sourcePath)) throw new Error(`built resident ${relative} drift`);
  }
  return { ok: true, profile };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2); const values = {};
    const seen = new Set();
    for (let i = 0; i < args.length; i += 1) {
      const key = args[i];
      if (key !== '--rootfs' && key !== '--profile') throw new Error(`unknown flag: ${key}`);
      if (seen.has(key)) throw new Error(`duplicate flag: ${key}`);
      seen.add(key);
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`);
      values[key.slice(2)] = value;
    }
    if (!values.rootfs || !values.profile) throw new Error('missing --rootfs or --profile');
    process.stdout.write(`${JSON.stringify(verify(values))}\n`);
  } catch (error) { process.stderr.write(`[verify-built-factory-image-provenance] ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { verify };
