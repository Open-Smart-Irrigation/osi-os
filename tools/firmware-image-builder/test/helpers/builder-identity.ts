export function createTestBuilderIdentity(targetManifestSha256 = 'b'.repeat(64)) {
  return Object.freeze({
    packageVersion: '0.1.24',
    packageRoot: '/home/builder/.local/lib/osi-image-builder/0.1.24',
    lockSha256: '5'.repeat(64),
    executionDefinitionSha256: '6'.repeat(64),
    targetManifestSha256,
    runnerSha256: 'c'.repeat(64),
    cleanupWorkerSha256: 'd'.repeat(64),
    dependencyEgressProxySha256: 'e'.repeat(64),
    imageReference: `registry.example.invalid/osi-image-builder@sha256:${'8'.repeat(64)}`,
    imageId: `sha256:${'9'.repeat(64)}`,
    imageDigest: '8'.repeat(64),
  });
}

export const TEST_BUILDER_IDENTITY = createTestBuilderIdentity();

export const TEST_BUILDER_IDENTITY_COLUMNS = Object.freeze([
  'builder_identity_status',
  'builder_package_version',
  'builder_package_root',
  'builder_lock_sha256',
  'builder_execution_definition_sha256',
  'builder_target_manifest_sha256',
  'builder_runner_sha256',
  'builder_cleanup_worker_sha256',
  'builder_dependency_egress_proxy_sha256',
  'builder_image_reference',
  'builder_image_id',
  'builder_image_digest',
] as const);

export function testBuilderIdentityValues(identity = TEST_BUILDER_IDENTITY): readonly string[] {
  return [
    'admitted',
    identity.packageVersion,
    identity.packageRoot,
    identity.lockSha256,
    identity.executionDefinitionSha256,
    identity.targetManifestSha256,
    identity.runnerSha256,
    identity.cleanupWorkerSha256,
    identity.dependencyEgressProxySha256,
    identity.imageReference,
    identity.imageId,
    identity.imageDigest,
  ];
}
