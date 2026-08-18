'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./lib/deployment-state');

const HASH = 'a'.repeat(64);

function envelope(overrides = {}) {
  return {
    format: 2,
    parentDeployment: {
      deploymentId: 'factory-baseline-bcm2712',
      phase: 'image-baseline-initializing',
      generation: 2,
      imageBaselinePrefix: 'baseline-completing',
      factoryProvenanceSha256: HASH,
      databaseLineage: { status: 'valid', databaseLineageSha256: HASH, seedReceiptSha256: HASH },
      ...overrides.parentDeployment,
    },
    activeSubOperation: overrides.activeSubOperation === undefined ? null : overrides.activeSubOperation,
  };
}

test('factory baseline validator accepts the closed format-2 envelope', () => {
  assert.deepEqual(lib.validateFactoryBaselineEnvelope(envelope(), {
    expectedDeploymentId: 'factory-baseline-bcm2712',
    expectedSeedReceiptSha256: HASH,
    expectedDatabaseLineageSha256: HASH,
  }), envelope());
});

test('factory baseline validator rejects forged envelope, parent, and active-operation fields', () => {
  const unknownTopLevel = envelope();
  unknownTopLevel.extra = true;
  assert.throws(() => lib.validateFactoryBaselineEnvelope(unknownTopLevel), /unknown field/);

  const unknownParent = envelope();
  unknownParent.parentDeployment.forged = true;
  assert.throws(() => lib.validateFactoryBaselineEnvelope(unknownParent), /unknown field/);

  assert.throws(() => lib.validateFactoryBaselineEnvelope(envelope({ activeSubOperation: {} })), /activeSubOperation must be null/);
  assert.throws(() => lib.validateFactoryBaselineEnvelope(envelope({ parentDeployment: { factoryZeroAuthority: null } })), /plain object/);
  assert.throws(() => lib.validateFactoryBaselineEnvelope(envelope({ parentDeployment: { deploymentId: 'wrong-id' } }), {
    expectedDeploymentId: 'factory-baseline-bcm2712',
  }), /deployment id/);
});

test('factory baseline validator cross-binds optional factory-zero authority hashes', () => {
  const authority = {
    factoryProvenanceSha256: HASH,
    factorySeedReceiptSha256: HASH,
    databaseLineageSha256: HASH,
    databaseIdentitySha256: HASH,
    protocolRoots: {
      root: '/tmp/capability',
      witnessRoot: '/tmp/witness',
      activityWitnessRoot: '/tmp/activity',
      activityHeadWitnessRoot: '/tmp/activity-head',
    },
    bootId: 'boot-1',
    stoppedRoleEvidence: { path: '/tmp/stopped.json', sha256: HASH },
    linkGenerationEvidence: { path: '/tmp/links.json', sha256: HASH },
  };
  const state = envelope({ parentDeployment: { factoryZeroAuthority: authority } });
  assert.doesNotThrow(() => lib.validateFactoryBaselineEnvelope(state, {
    expectedFactoryProvenanceSha256: HASH,
    expectedSeedReceiptSha256: HASH,
    expectedDatabaseLineageSha256: HASH,
  }));
  assert.throws(() => lib.validateFactoryBaselineEnvelope(state, {
    expectedFactoryProvenanceSha256: 'b'.repeat(64),
  }), /authority.*does not match/);
});
