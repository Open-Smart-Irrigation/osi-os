'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const provenance = require('./factory-image-provenance');

const HASH = 'a'.repeat(64);

function valid() {
  return {
    format: 2,
    imageBuildId: '20260719-factory-bcm2712',
    profile: 'bcm2712',
    imageGuardManifestSha256: HASH,
    initializerSha256: HASH,
    factorySeedSha256: HASH,
    factorySeedHelperSha256: HASH,
    factorySeedLibrarySha256: HASH,
    deploymentStateCliSha256: HASH,
    deploymentStateLibrarySha256: HASH,
    dbSeedInitializerSha256: HASH,
    commandStateAuditSha256: HASH,
    protocolCapabilityHelperSha256: HASH,
    protocolCapabilityCliSha256: HASH,
    provenanceLibrarySha256: HASH,
    provenanceCliSha256: HASH,
  };
}

test('canonical bytes are deterministic and reject unknown fields', () => {
  const value = valid();
  const shuffled = { ...value, profile: value.profile };
  assert.equal(provenance.canonicalBytes(value).toString(), provenance.canonicalBytes(shuffled).toString());
  assert.deepEqual(provenance.validate(value), value);
  assert.throws(() => provenance.validate({ ...value, extra: true }), /unknown field/);
});

test('profiles are closed and image IDs are safe', () => {
  assert.equal(provenance.profileInfo('bcm2712').target, 'bcm27xx/bcm2712');
  assert.equal(provenance.profileInfo('bcm2709').target, 'bcm27xx/bcm2709');
  assert.throws(() => provenance.validate({ ...valid(), profile: 'bcm2709', imageBuildId: 'bad/id' }), /imageBuildId/);
  assert.throws(() => provenance.validate({ ...valid(), profile: 'unknown' }), /profile/);
});

test('hash helpers use SHA-256 and compare profile relation', () => {
  const digest = provenance.sha256(Buffer.from('hello'));
  assert.equal(digest, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  const value = valid();
  assert.equal(provenance.provenanceHash(value), provenance.sha256(provenance.canonicalBytes(value)));
  assert.equal(provenance.assertProfileRelation(value, 'bcm2712').profile, 'bcm2712');
  assert.throws(() => provenance.assertProfileRelation(value, 'bcm2709'), /profile mismatch/);
});
