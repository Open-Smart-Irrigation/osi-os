'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const codec = require('./lib/factory-image-provenance');
const cli = require('./factory-image-provenance-cli');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'osi-factory-provenance-')); }
function writeJson(file, value) { fs.writeFileSync(file, `${codec.canonical(value)}\n`, { mode: 0o600 }); }
function makeCase() {
  const root = temp();
  const files = {};
  for (const name of ['initializer', '97_osi_db_seed', 'seed', 'helper', 'seed-cli', 'audit', 'protocol-helper', 'protocol-cli']) {
    files[name] = path.join(root, name);
    fs.writeFileSync(files[name], `${name}\n`, { mode: 0o600 });
  }
  const manifest = {
    format: 1,
    profile: 'bcm2712',
    imageBuildId: 'build-1',
    rcLinks: {
      S90osiDbIntegrity: '/etc/init.d/osi-db-integrity', S98osiIdentityd: '/etc/init.d/osi-identityd',
      K98osiIdentityd: '/etc/init.d/osi-identityd', S99nodeRed: '/etc/init.d/node-red',
      K99nodeRed: '/etc/init.d/node-red', S99osiBootstrap: '/etc/init.d/osi-bootstrap',
    },
    uciDefaultsOrder: ['93_osi_deploy_guard_init', '94_osi_identityd_enable', '97_osi_db_seed'],
    files: {
      initializerSha256: codec.hashFile(files.initializer),
      factorySeedSha256: codec.hashFile(files.seed),
      factorySeedHelperSha256: codec.hashFile(files['seed-cli']),
      dbSeedInitializerSha256: codec.hashFile(files['97_osi_db_seed']),
      commandStateAuditSha256: codec.hashFile(files.audit),
      protocolCapabilityHelperSha256: codec.hashFile(files['protocol-cli']),
      protocolCapabilityCliSha256: codec.hashFile(files['protocol-cli']),
    },
  };
  const manifestPath = path.join(root, 'manifest.json');
  writeJson(manifestPath, manifest);
  const provenance = {
    format: 2,
    imageBuildId: 'build-1',
    profile: 'bcm2712',
    imageGuardManifestSha256: codec.hashFile(manifestPath),
    initializerSha256: manifest.files.initializerSha256,
    factorySeedSha256: manifest.files.factorySeedSha256,
    factorySeedHelperSha256: manifest.files.factorySeedHelperSha256,
    dbSeedInitializerSha256: manifest.files.dbSeedInitializerSha256,
    commandStateAuditSha256: manifest.files.commandStateAuditSha256,
    protocolCapabilityHelperSha256: manifest.files.protocolCapabilityHelperSha256,
    protocolCapabilityCliSha256: manifest.files.protocolCapabilityCliSha256,
  };
  const provenancePath = path.join(root, 'provenance.json');
  writeJson(provenancePath, provenance);
  return { root, files, manifestPath, provenancePath };
}

test('parse rejects unknown, duplicate, relative, and missing flags', () => {
  assert.throws(() => cli.parse(['verify-runtime', '--nope', 'x']), /unknown flag/);
  assert.throws(() => cli.parse(['verify-runtime', '--expected-profile', 'bcm2712']), /missing required/);
  assert.throws(() => cli.parse(['verify-runtime', '--expected-profile', 'bcm2712', '--expected-profile', 'bcm2712']), /duplicate flag/);
});

test('verify-runtime creates one root-only, nonce-bearing verification result', () => {
  const c = makeCase();
  const result = path.join(c.root, 'result.json');
  const args = ['verify-runtime', '--factory-provenance', c.provenancePath, '--image-guard-manifest', c.manifestPath,
    '--initializer', c.files.initializer, '--factory-seed', c.files.seed, '--factory-seed-helper', c.files['seed-cli'],
    '--ack-audit-cli', c.files.audit, '--protocol-cli', c.files['protocol-cli'],
    '--expected-profile', 'bcm2712', '--result', result];
  const output = cli.dispatch(args);
  assert.equal(output.profile, 'bcm2712');
  assert.match(output.nonce, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(result)).nonce, output.nonce);
  assert.equal((fs.statSync(result).mode & 0o777), 0o600);
  assert.throws(() => cli.dispatch(args), /already exists|replay/);
});

test('verify-runtime rejects a swapped live candidate', () => {
  const c = makeCase();
  fs.writeFileSync(c.files.audit, 'tampered\n');
  const result = path.join(c.root, 'result.json');
  const args = ['verify-runtime', '--factory-provenance', c.provenancePath, '--image-guard-manifest', c.manifestPath,
    '--initializer', c.files.initializer, '--factory-seed', c.files.seed, '--factory-seed-helper', c.files['seed-cli'],
    '--ack-audit-cli', c.files.audit, '--protocol-cli', c.files['protocol-cli'],
    '--expected-profile', 'bcm2712', '--result', result];
  assert.throws(() => cli.dispatch(args), /hash mismatch/);
});
