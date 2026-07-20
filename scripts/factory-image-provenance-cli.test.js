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
  for (const name of ['initializer', '97_osi_db_seed', 'seed', 'helper', 'seed-cli', 'seed-library', 'state-cli', 'osi-deployment-state.js', 'audit', 'protocol-helper', 'protocol-cli', 'provenance-library', 'provenance-cli']) {
    files[name] = path.join(root, name);
    fs.writeFileSync(files[name], `${name}\n`, { mode: 0o600 });
  }
  for (const [alias, source] of [['osi-factory-database-seed.js', 'seed-library'], ['osi-deployment-state-cli.js', 'state-cli'],
    ['osi-factory-image-provenance.js', 'provenance-library'], ['osi-factory-image-provenance-cli.js', 'provenance-cli']]) {
    fs.writeFileSync(path.join(root, alias), `${source}\n`, { mode: 0o600 });
  }
  const manifest = {
    format: 1,
    profile: 'bcm2712',
    imageBuildId: '20260719-factory-bcm2712',
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
      factorySeedLibrarySha256: codec.hashFile(files['seed-library']),
      deploymentStateCliSha256: codec.hashFile(files['state-cli']),
      deploymentStateLibrarySha256: codec.hashFile(files['osi-deployment-state.js']),
      dbSeedInitializerSha256: codec.hashFile(files['97_osi_db_seed']),
      commandStateAuditSha256: codec.hashFile(files.audit),
      protocolCapabilityHelperSha256: codec.hashFile(files['protocol-cli']),
      protocolCapabilityCliSha256: codec.hashFile(files['protocol-cli']),
      provenanceLibrarySha256: codec.hashFile(files['provenance-library']),
      provenanceCliSha256: codec.hashFile(files['provenance-cli']),
    },
  };
  const manifestPath = path.join(root, 'manifest.json');
  writeJson(manifestPath, manifest);
  const provenance = {
    format: 2,
    imageBuildId: '20260719-factory-bcm2712',
    profile: 'bcm2712',
    imageGuardManifestSha256: codec.hashFile(manifestPath),
    initializerSha256: manifest.files.initializerSha256,
    factorySeedSha256: manifest.files.factorySeedSha256,
    factorySeedHelperSha256: manifest.files.factorySeedHelperSha256,
    factorySeedLibrarySha256: manifest.files.factorySeedLibrarySha256,
    deploymentStateCliSha256: manifest.files.deploymentStateCliSha256,
    deploymentStateLibrarySha256: manifest.files.deploymentStateLibrarySha256,
    dbSeedInitializerSha256: manifest.files.dbSeedInitializerSha256,
    commandStateAuditSha256: manifest.files.commandStateAuditSha256,
    protocolCapabilityHelperSha256: manifest.files.protocolCapabilityHelperSha256,
    protocolCapabilityCliSha256: manifest.files.protocolCapabilityCliSha256,
    provenanceLibrarySha256: manifest.files.provenanceLibrarySha256,
    provenanceCliSha256: manifest.files.provenanceCliSha256,
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
    '--initializer', c.files.initializer, '--factory-seed', c.files.seed, '--factory-seed-library', c.files['seed-library'], '--factory-seed-helper', c.files['seed-cli'], '--deployment-state-cli', c.files['state-cli'],
    '--ack-audit-cli', c.files.audit, '--protocol-cli', c.files['protocol-cli'],
    '--provenance-library', c.files['provenance-library'], '--provenance-cli', c.files['provenance-cli'], '--expected-profile', 'bcm2712', '--result', result];
  const output = cli.dispatch(args);
  assert.equal(output.profile, 'bcm2712');
  assert.equal(Object.hasOwn(output, 'factoryVerification'), false, 'provenance-only verification cannot claim factory-zero eligibility');
  assert.match(output.nonce, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(result)).nonce, output.nonce);
  assert.equal((fs.statSync(result).mode & 0o777), 0o600);
  const retry = cli.dispatch(args);
  assert.equal(retry.nonce, output.nonce, 'same-boot retry must reuse the exact unconsumed result');
});

test('verify-runtime accepts the exact first-boot argv without derived-path flags', () => {
  const c = makeCase();
  const result = path.join(c.root, 'exact-result.json');
  const args = ['verify-runtime', '--factory-provenance', c.provenancePath, '--image-guard-manifest', c.manifestPath,
    '--initializer', c.files.initializer, '--factory-seed', c.files.seed, '--factory-seed-helper', c.files['seed-cli'],
    '--ack-audit-cli', c.files.audit, '--protocol-cli', c.files['protocol-cli'], '--expected-profile', 'bcm2712', '--result', result];
  assert.equal(cli.dispatch(args).profile, 'bcm2712');
});

test('check-runtime revalidates the exact ROM candidates without creating a result', () => {
  const c = makeCase();
  const args = ['check-runtime', '--factory-provenance', c.provenancePath, '--image-guard-manifest', c.manifestPath,
    '--initializer', c.files.initializer, '--factory-seed', c.files.seed, '--factory-seed-helper', c.files['seed-cli'],
    '--ack-audit-cli', c.files.audit, '--protocol-cli', c.files['protocol-cli'], '--expected-profile', 'bcm2712'];
  const output = cli.dispatch(args);
  assert.equal(output.profile, 'bcm2712');
  assert.equal(fs.readdirSync(c.root).some((name) => name.includes('verification-result')), false);
});

test('verify-runtime rejects a swapped live candidate', () => {
  const c = makeCase();
  fs.writeFileSync(c.files.audit, 'tampered\n');
  const result = path.join(c.root, 'result.json');
  const args = ['verify-runtime', '--factory-provenance', c.provenancePath, '--image-guard-manifest', c.manifestPath,
    '--initializer', c.files.initializer, '--factory-seed', c.files.seed, '--factory-seed-library', c.files['seed-library'], '--factory-seed-helper', c.files['seed-cli'], '--deployment-state-cli', c.files['state-cli'],
    '--ack-audit-cli', c.files.audit, '--protocol-cli', c.files['protocol-cli'],
    '--provenance-library', c.files['provenance-library'], '--provenance-cli', c.files['provenance-cli'], '--expected-profile', 'bcm2712', '--result', result];
  assert.throws(() => cli.dispatch(args), /hash mismatch/);
});

test('verify-runtime rejects provenance and candidates under a symlink ancestor', () => {
  const c = makeCase();
  const real = `${c.root}.real`;
  fs.renameSync(c.root, real);
  fs.symlinkSync(real, c.root);
  const result = path.join(c.root, 'result.json');
  const args = ['verify-runtime', '--factory-provenance', c.provenancePath, '--image-guard-manifest', c.manifestPath,
    '--initializer', c.files.initializer, '--factory-seed', c.files.seed, '--factory-seed-library', c.files['seed-library'],
    '--factory-seed-helper', c.files['seed-cli'], '--deployment-state-cli', c.files['state-cli'], '--ack-audit-cli', c.files.audit,
    '--protocol-cli', c.files['protocol-cli'], '--provenance-library', c.files['provenance-library'], '--provenance-cli', c.files['provenance-cli'],
    '--expected-profile', 'bcm2712', '--result', result];
  try { assert.throws(() => cli.dispatch(args), /symlink ancestor/); }
  finally { fs.unlinkSync(c.root); fs.renameSync(real, c.root); }
});

test('verify-runtime rejects a result path whose existing parent is below a symlink ancestor', () => {
  const c = makeCase();
  const real = path.join(c.root, 'real');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  fs.symlinkSync(real, path.join(c.root, 'linked'));
  const result = path.join(c.root, 'linked', 'sub', 'result.json');
  const args = ['verify-runtime', '--factory-provenance', c.provenancePath, '--image-guard-manifest', c.manifestPath,
    '--initializer', c.files.initializer, '--factory-seed', c.files.seed, '--factory-seed-library', c.files['seed-library'], '--factory-seed-helper', c.files['seed-cli'], '--deployment-state-cli', c.files['state-cli'],
    '--ack-audit-cli', c.files.audit, '--protocol-cli', c.files['protocol-cli'], '--provenance-library', c.files['provenance-library'], '--provenance-cli', c.files['provenance-cli'], '--expected-profile', 'bcm2712', '--result', result];
  assert.throws(() => cli.dispatch(args), /symlink ancestor|verification result parent/);
});
