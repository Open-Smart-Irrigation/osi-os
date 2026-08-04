import { createHash } from 'node:crypto';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BUILDER_LOCK_OPTIONAL_KEYS,
  BUILDER_LOCK_REQUIRED_KEYS,
  validateBuilderLock,
  type BuilderLock,
} from '../domain/builder-lock.js';
import type { NativePrerequisiteResult } from './probes.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const DOCKER_ID = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_REFERENCE = /^(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:(?<digest>[0-9a-f]{64})$/u;
const RUNTIME_ENV = Object.freeze(['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']);
const ARTIFACT_PATHS: Readonly<Record<InstallerArtifactName, string>> = {
  api: 'bin/osi-image-builder-api',
  runner: 'bin/osi-image-builder-runner',
  cleanupWorker: 'bin/osi-image-builder-cleanup',
  publisher: 'bin/osi-image-publish',
  executionDefinition: 'execution-definition.json',
  dependencyEgressProxy: 'operations/osi-dependency-egress-proxy.cjs',
  ui: 'ui/index.html',
};

export type InstallerErrorCode =
  | 'APPROVED_ROOT_REQUIRED'
  | 'BUILDER_DIGEST_MISMATCH'
  | 'BUILDER_EXECUTION_DEFINITION_MISMATCH'
  | 'BUILDER_IMAGE_DIGEST_INVALID'
  | 'BUILDER_LOCK_INVALID'
  | 'BUILDER_RUNTIME_ENV_INVALID'
  | 'BUILDER_VALIDATION_EVIDENCE_INVALID'
  | 'DOCKER_EXECUTION_DEFINITION_MISMATCH'
  | 'DOCKER_UNAVAILABLE'
  | 'INSTALL_PATH_INVALID'
  | 'INSTALL_VERSION_EXISTS'
  | 'PUBLISHER_SELF_TEST_MISSING'
  | 'INSTALL_FAILED';

export class InstallerError extends Error {
  readonly code: InstallerErrorCode | string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: InstallerErrorCode | string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
    this.details = details;
  }
}

export interface InstallerImageInspection {
  readonly reference?: string;
  readonly imageId?: string;
  readonly imageDigest?: string;
  readonly repoDigests?: readonly unknown[];
  readonly configEnv?: readonly unknown[];
  readonly available?: boolean;
  readonly validated?: boolean;
  readonly validationEvidenceSha256?: string;
  readonly code?: string;
  readonly detail?: string;
}

export interface InstallerServiceUserInspectionResult {
  readonly available: boolean;
  readonly inspection?: InstallerImageInspection;
  readonly code?: string;
  readonly detail?: string;
}

export interface InstallerPublisher {
  readonly selfTest: () => Promise<Readonly<{ available: boolean; passed?: boolean; sha256?: string; code?: string; detail?: string }>>;
}

export interface InstallerSourceMetadata {
  readonly dockerfile?: string;
  readonly rootDockerfile?: string;
  readonly executionDefinition?: string;
  readonly dockerfileSha256: string;
  readonly baseImageDigest: string;
  readonly executionDefinitionSha256: string;
  readonly validationEvidenceSha256: string;
  readonly baseImage?: string;
  readonly packageSet?: readonly string[];
  readonly rustConfig?: Readonly<Record<string, unknown>>;
  readonly nodeVersion?: string;
}

export interface InstallerSelectionDependencies {
  readonly installedVersion?: string;
  readonly source?: InstallerSourceMetadata;
  readonly builderImage?: InstallerImageInspection;
  readonly serviceUser?: Readonly<{ inspect: (reference: string) => Promise<InstallerServiceUserInspectionResult | InstallerImageInspection> }>;
  readonly productionImageValidation?: (reference: string) => Promise<InstallerImageInspection>;
  readonly publisher?: InstallerPublisher;
  readonly hostProbes?: () => Promise<NativePrerequisiteResult>;
  readonly probePrerequisites?: () => Promise<Readonly<{ available: true }> | NativePrerequisiteResult>;
}

export interface InstallerFileSystem {
  readonly mkdir: (path: string) => Promise<void>;
  readonly writeFile: (path: string, contents: string | Uint8Array) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly fsyncFile: (path: string) => Promise<void>;
  readonly fsyncDirectory: (path: string) => Promise<void>;
  readonly renameNoReplace: (from: string, to: string) => Promise<void>;
  readonly renameReplace: (from: string, to: string) => Promise<void>;
  readonly makeTreeImmutable: (path: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

export type InstallerArtifactName = 'api' | 'runner' | 'cleanupWorker' | 'publisher' | 'executionDefinition' | 'dependencyEgressProxy' | 'ui';

export interface VersionedInstallerDependencies extends InstallerSelectionDependencies {
  readonly fs: InstallerFileSystem;
  readonly probePrerequisites: () => Promise<Readonly<{ available: true }> | NativePrerequisiteResult>;
  readonly buildAndValidateImage: () => Promise<InstallerImageInspection>;
  readonly inspectAsServiceUser: (reference: string) => Promise<InstallerServiceUserInspectionResult | InstallerImageInspection>;
  readonly validateProductionImage: (reference: string) => Promise<InstallerImageInspection>;
  readonly builderSource: Readonly<{
    readonly baseImage: string;
    readonly baseImageDigest: string;
    readonly dockerfileSha256: string;
    readonly packageSet: readonly string[];
    readonly rustConfig: Readonly<Record<string, unknown>>;
    readonly nodeVersion: string;
  }>;
  readonly artifacts: Readonly<Record<InstallerArtifactName, string | Uint8Array>>;
  readonly additionalArtifacts?: Readonly<Record<string, string | Uint8Array>>;
  readonly publisherSha256: string;
  readonly executionDefinitionSha256: string;
  readonly manifestSha256: string;
}

export interface VersionedInstallerInput {
  readonly packageVersion: string;
  readonly installRoot: string;
  readonly selectionPath: string;
  readonly systemdConfigPath?: string;
  readonly approvedOutputRoot?: string;
  readonly dependencies: VersionedInstallerDependencies;
  readonly hooks?: Readonly<{
    readonly beforeVersionCommit?: () => Promise<void>;
    readonly afterVersionCommit?: () => Promise<void>;
  }>;
}

export interface InstallerSelection {
  readonly packageVersion: string;
  readonly manifestSha256: string;
  readonly lockSha256: string;
  readonly publisherSha256: string;
  readonly executionDefinitionSha256: string;
}

export interface VersionedInstallerSuccess {
  readonly available: true;
  readonly packageVersion: string;
  readonly reference: string;
  readonly selection: InstallerSelection;
  readonly lock: BuilderLock;
}

type Unavailable = Readonly<{ available: false; code: string; detail: string; mutation: 'none' | 'unknown' }>;

function fail(code: InstallerErrorCode | string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new InstallerError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSha(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value) || /^0+$/u.test(value)) fail('BUILDER_LOCK_INVALID', `${name} is not a valid digest`);
}

function canonicalReference(reference: unknown): { readonly reference: string; readonly repository: string; readonly digest: string } {
  if (typeof reference !== 'string') fail('BUILDER_IMAGE_DIGEST_INVALID', 'builder image reference is missing');
  const match = CANONICAL_REFERENCE.exec(reference);
  if (match?.groups?.repository === undefined || match.groups.digest === undefined) {
    fail('BUILDER_IMAGE_DIGEST_INVALID', 'builder image reference must be digest-qualified');
  }
  return { reference, repository: match.groups.repository, digest: match.groups.digest };
}

function exactRuntimeEnv(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === RUNTIME_ENV[0];
}

function canonicalRepoDigest(reference: string, repoDigests: unknown): void {
  const { repository } = canonicalReference(reference);
  const prefix = `${repository}@sha256:`;
  const matches = Array.isArray(repoDigests)
    ? repoDigests.filter((value): value is string => (
      typeof value === 'string'
      && value.startsWith(prefix)
      && SHA256.test(value.slice(prefix.length))
    ))
    : [];
  if (matches.length !== 1 || matches[0] !== reference) {
    fail('BUILDER_IMAGE_DIGEST_INVALID', 'builder image must have exactly one matching canonical RepoDigest');
  }
}

function inspectionOf(value: InstallerServiceUserInspectionResult | InstallerImageInspection): InstallerImageInspection {
  if (isRecord(value) && value.available === false) {
    fail(typeof value.code === 'string' ? value.code : 'DOCKER_UNAVAILABLE', typeof value.detail === 'string' ? value.detail : 'builder image inspection is unavailable');
  }
  if (isRecord(value) && isRecord(value.inspection)) return value.inspection as InstallerImageInspection;
  return value as InstallerImageInspection;
}

function assertImageInspection(
  value: InstallerImageInspection,
  expectedReference: string,
  expectedDigest: string,
  expectedImageId?: string,
  expectedEvidence?: string,
): void {
  const inspected = inspectionOf(value);
  if (inspected.reference !== undefined && inspected.reference !== expectedReference) {
    fail('BUILDER_IMAGE_DIGEST_INVALID', 'image inspection used a non-canonical reference');
  }
  if (typeof inspected.imageId !== 'string' || !DOCKER_ID.test(inspected.imageId)) {
    fail('BUILDER_IMAGE_DIGEST_INVALID', 'Docker image ID is invalid');
  }
  canonicalRepoDigest(expectedReference, inspected.repoDigests);
  if (!exactRuntimeEnv(inspected.configEnv)) fail('BUILDER_RUNTIME_ENV_INVALID', 'Docker image Config.Env is not the locked runtime contract');
  if (inspected.imageDigest !== undefined && inspected.imageDigest !== expectedDigest) {
    fail('BUILDER_IMAGE_DIGEST_INVALID', 'Docker image digest does not match the lock');
  }
  if (expectedImageId !== undefined && inspected.imageId !== `sha256:${expectedImageId}`) {
    fail('BUILDER_IMAGE_DIGEST_INVALID', 'Docker image ID does not match the lock');
  }
  if (expectedEvidence !== undefined && inspected.validationEvidenceSha256 !== undefined
    && inspected.validationEvidenceSha256 !== expectedEvidence) {
    fail('BUILDER_VALIDATION_EVIDENCE_INVALID', 'production validation evidence does not match the lock');
  }
}

function assertSourceMatches(lock: BuilderLock, source: InstallerSourceMetadata | undefined): void {
  if (source === undefined) fail('BUILDER_SOURCE_DRIFT', 'validated builder source metadata is missing');
  if (source.dockerfileSha256 !== lock.dockerfileSha256 || source.baseImageDigest !== lock.baseImageDigest) {
    fail('BUILDER_DIGEST_MISMATCH', 'builder source digest does not match the lock');
  }
  if (source.executionDefinitionSha256 !== lock.executionDefinitionSha256) {
    fail('DOCKER_EXECUTION_DEFINITION_MISMATCH', 'execution definition digest does not match the lock');
  }
  if (source.validationEvidenceSha256 !== lock.validationEvidenceSha256) {
    fail('BUILDER_DIGEST_MISMATCH', 'validation evidence digest does not match the lock');
  }
}

async function checkHostPrerequisites(dependencies: InstallerSelectionDependencies): Promise<void> {
  if (dependencies.hostProbes === undefined && dependencies.probePrerequisites === undefined) {
    fail('HOST_PREREQUISITES_MISSING', 'native host prerequisite evidence is missing');
  }
  const probe = dependencies.hostProbes !== undefined
    ? await dependencies.hostProbes()
    : dependencies.probePrerequisites === undefined ? undefined : await dependencies.probePrerequisites();
  if (probe !== undefined && probe.available === false) fail(probe.code, probe.detail);
}

export function createProductionBuilderLock(input: Readonly<Record<string, unknown>>): BuilderLock {
  if (!isRecord(input)) fail('BUILDER_LOCK_INVALID', 'production lock input must be an object');
  const allowed = new Set<string>([...BUILDER_LOCK_REQUIRED_KEYS, ...BUILDER_LOCK_OPTIONAL_KEYS]);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail('BUILDER_LOCK_INVALID', 'unexpected production lock key');
  if (Object.prototype.hasOwnProperty.call(input, 'installable') && input.installable !== true) {
    fail('BUILDER_LOCK_INVALID', 'production lock must be installable');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'schemaVersion') && input.schemaVersion !== 1) {
    fail('BUILDER_LOCK_INVALID', 'production lock schemaVersion must be integer 1');
  }
  const lock = { ...input, schemaVersion: 1, installable: true } as Record<string, unknown>;
  const packageVersion = lock.packageVersion;
  if (typeof packageVersion !== 'string') fail('BUILDER_LOCK_INVALID', 'production lock package version is missing');
  const validation = validateBuilderLock(lock, packageVersion);
  if (!validation.ok) fail('BUILDER_LOCK_INVALID', validation.reason);
  return validation.lock;
}

export async function validateInstallerSelection(
  candidate: Readonly<Record<string, unknown>>,
  dependencies: InstallerSelectionDependencies | Readonly<Record<string, unknown>>,
): Promise<{ readonly reference: string; readonly lock: BuilderLock }> {
  const deps = dependencies as InstallerSelectionDependencies;
  const installedVersion = deps.installedVersion ?? (typeof candidate.packageVersion === 'string' ? candidate.packageVersion : '');
  if (typeof candidate.imageRepository === 'string' && /:[^/]+$/u.test(candidate.imageRepository)) {
    fail('BUILDER_IMAGE_DIGEST_INVALID', 'builder image repository must not contain a mutable tag');
  }
  const validation = validateBuilderLock(candidate, installedVersion);
  if (!validation.ok) fail('BUILDER_LOCK_INVALID', validation.reason);
  const lock = validation.lock;
  assertSourceMatches(lock, deps.source);
  const reference = canonicalReference(`${lock.imageRepository}@sha256:${lock.imageDigest}`);
  const image = deps.builderImage;
  if (image === undefined || image.available === false || image.validated === false) fail('DOCKER_UNAVAILABLE', 'validated builder image is unavailable');
  if (image.reference !== undefined && image.reference !== reference.reference) fail('BUILDER_IMAGE_DIGEST_INVALID', 'builder image reference is not canonical');
  if (Array.isArray(image.repoDigests) && image.repoDigests.length === 1 && image.repoDigests[0] !== reference.reference) {
    fail('BUILDER_DIGEST_MISMATCH', 'builder image RepoDigest does not match the lock');
  }
  assertImageInspection(image, reference.reference, lock.imageDigest, lock.imageId);

  if (deps.serviceUser === undefined) fail('DOCKER_UNAVAILABLE', 'service-user image inspection boundary is missing');
  const serviceInspection = await deps.serviceUser.inspect(reference.reference);
  if (isRecord(serviceInspection) && serviceInspection.available === false) fail('DOCKER_UNAVAILABLE', typeof serviceInspection.detail === 'string' ? serviceInspection.detail : 'service-user image inspection failed', { sourceCode: serviceInspection.code });
  assertImageInspection(inspectionOf(serviceInspection), reference.reference, lock.imageDigest, lock.imageId);

  if (deps.productionImageValidation === undefined) fail('BUILDER_VALIDATION_EVIDENCE_INVALID', 'production image validation boundary is missing');
  const productionInspection = await deps.productionImageValidation(reference.reference);
  assertImageInspection(productionInspection, reference.reference, lock.imageDigest, lock.imageId, lock.validationEvidenceSha256);
  if (productionInspection.validationEvidenceSha256 !== lock.validationEvidenceSha256) fail('BUILDER_VALIDATION_EVIDENCE_INVALID', 'production validation evidence does not match the lock');

  if (deps.publisher === undefined) fail('PUBLISHER_SELF_TEST_MISSING', 'native publisher self-test boundary is missing');
  const publisher = await deps.publisher.selfTest();
  if (!publisher.available || publisher.passed !== true) {
    fail(publisher.code ?? 'PUBLISHER_SELF_TEST_MISSING', publisher.detail ?? 'native publisher self-test failed');
  }
  if (lock.publisherSha256 !== undefined && publisher.sha256 !== lock.publisherSha256) {
    fail('PUBLISHER_SELF_TEST_MISSING', 'native publisher digest does not match the lock');
  }
  await checkHostPrerequisites(deps);
  return { reference: reference.reference, lock };
}

function validateInstallPath(path: string, name: string): void {
  if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/') || path.includes('\0')) {
    fail('INSTALL_PATH_INVALID', `${name} must be an absolute path`);
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashArtifact(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function relativeArtifactPath(name: InstallerArtifactName): string { return ARTIFACT_PATHS[name]; }

function artifactEntries(
  dependencies: VersionedInstallerDependencies,
): readonly (readonly [string, string | Uint8Array])[] {
  const entries: Array<readonly [string, string | Uint8Array]> = [];
  for (const name of Object.keys(ARTIFACT_PATHS) as InstallerArtifactName[]) {
    const contents = dependencies.artifacts[name];
    if (typeof contents !== 'string' && !(contents instanceof Uint8Array)) {
      fail('INSTALL_FAILED', `artifact ${name} is missing`);
    }
    entries.push([relativeArtifactPath(name), contents]);
  }
  for (const [path, contents] of Object.entries(dependencies.additionalArtifacts ?? {})) {
    if (
      (typeof contents !== 'string' && !(contents instanceof Uint8Array))
      || path.length === 0
      || path.startsWith('/')
      || path.includes('\\')
      || path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
      || Object.values(ARTIFACT_PATHS).includes(path)
    ) {
      fail('INSTALL_FAILED', 'additional artifact is invalid or duplicates a required artifact');
    }
    entries.push([path, contents]);
  }
  return entries;
}

function joinPath(root: string, child: string): string {
  const result = posix.normalize(posix.join(root, child));
  if (result !== root && !result.startsWith(`${root}/`)) fail('INSTALL_PATH_INVALID', 'artifact escaped the version directory');
  return result;
}

export async function runVersionedInstaller(input: VersionedInstallerInput): Promise<VersionedInstallerSuccess | Unavailable> {
  validateInstallPath(input.installRoot, 'installRoot');
  validateInstallPath(input.selectionPath, 'selectionPath');
  const { dependencies } = input;
  const hooks = input.hooks;

  const prerequisite = await dependencies.probePrerequisites();
  if (prerequisite.available === false) return prerequisite;

  const built = await dependencies.buildAndValidateImage();
  const builtReference = canonicalReference(built.reference);
  assertSha(builtReference.digest, 'builder image digest');
  if (built.imageDigest !== undefined && built.imageDigest !== builtReference.digest) fail('BUILDER_IMAGE_DIGEST_INVALID', 'built image digest does not match its reference');
  if (builtReference.repository.length === 0) fail('BUILDER_IMAGE_DIGEST_INVALID', 'built image repository is missing');
  assertImageInspection(built, builtReference.reference, builtReference.digest);
  if (builtReference.digest === '0'.repeat(64)) fail('BUILDER_IMAGE_DIGEST_INVALID', 'built image digest is empty');

  const productionInspection = await dependencies.validateProductionImage(builtReference.reference);
  const dependencyEgressProxy = dependencies.artifacts.dependencyEgressProxy;
  if (typeof dependencyEgressProxy !== 'string' && !(dependencyEgressProxy instanceof Uint8Array)) {
    fail('INSTALL_FAILED', 'artifact dependencyEgressProxy is missing');
  }
  const lock = createProductionBuilderLock({
    packageVersion: input.packageVersion,
    imageRepository: builtReference.repository,
    imageDigest: builtReference.digest,
    ...dependencies.builderSource,
    executionDefinitionSha256: dependencies.executionDefinitionSha256,
    dependencyEgressProxySha256: hashArtifact(dependencyEgressProxy),
    validationEvidenceSha256: productionInspection.validationEvidenceSha256 ?? built.validationEvidenceSha256 ?? '',
    publisherSha256: dependencies.publisherSha256,
    imageId: built.imageId?.slice('sha256:'.length),
  });
  if (lock.validationEvidenceSha256 === '') fail('BUILDER_VALIDATION_EVIDENCE_INVALID', 'builder validation evidence is missing');

  const selectionDependencies: InstallerSelectionDependencies = {
    installedVersion: input.packageVersion,
    source: {
      ...dependencies.builderSource,
      executionDefinitionSha256: dependencies.executionDefinitionSha256,
      validationEvidenceSha256: lock.validationEvidenceSha256,
    },
    builderImage: built,
    serviceUser: { inspect: dependencies.inspectAsServiceUser },
    productionImageValidation: dependencies.validateProductionImage,
    publisher: dependencies.publisher,
    hostProbes: async () => ({ available: true, code: 'HOST_PREREQUISITES_AVAILABLE', detail: 'host prerequisites were already checked', mutation: 'none' }),
  };
  await validateInstallerSelection(lock as unknown as Record<string, unknown>, selectionDependencies);

  const versionRoot = joinPath(input.installRoot, input.packageVersion);
  const temporaryRoot = joinPath(input.installRoot, `.tmp-${input.packageVersion}`);
  const selectionTemp = `${input.selectionPath}.tmp`;
  let versionCommitted = false;
  let selectionCommitted = false;
  try {
    await dependencies.fs.mkdir(input.installRoot);
    await dependencies.fs.mkdir(temporaryRoot);
    const lockText = `${JSON.stringify(lock)}\n`;
    const artifacts = artifactEntries(dependencies);
    await dependencies.fs.writeFile(joinPath(temporaryRoot, 'builder.lock.json'), lockText);
    for (const [path, contents] of artifacts) {
      await dependencies.fs.writeFile(joinPath(temporaryRoot, path), contents);
    }
    await dependencies.fs.fsyncFile(joinPath(temporaryRoot, 'builder.lock.json'));
    for (const [path] of artifacts) {
      await dependencies.fs.fsyncFile(joinPath(temporaryRoot, path));
    }
    const artifactDirectories = new Set<string>([
      temporaryRoot,
      ...artifacts.map(([path]) => posix.dirname(joinPath(temporaryRoot, path))),
    ]);
    for (const directory of [...artifactDirectories].sort((left, right) => right.length - left.length)) {
      await dependencies.fs.fsyncDirectory(directory);
    }
    if (hooks?.beforeVersionCommit !== undefined) await hooks.beforeVersionCommit();
    await dependencies.fs.renameNoReplace(temporaryRoot, versionRoot);
    versionCommitted = true;
    await dependencies.fs.makeTreeImmutable(versionRoot);
    await dependencies.fs.fsyncDirectory(versionRoot);
    await dependencies.fs.fsyncDirectory(input.installRoot);
    if (hooks?.afterVersionCommit !== undefined) await hooks.afterVersionCommit();

    const selection: InstallerSelection = {
      packageVersion: input.packageVersion,
      manifestSha256: dependencies.manifestSha256,
      lockSha256: hashText(lockText),
      publisherSha256: dependencies.publisherSha256,
      executionDefinitionSha256: dependencies.executionDefinitionSha256,
    };
    await dependencies.fs.writeFile(selectionTemp, `${JSON.stringify(selection)}\n`);
    await dependencies.fs.fsyncFile(selectionTemp);
    await dependencies.fs.renameReplace(selectionTemp, input.selectionPath);
    selectionCommitted = true;
    await dependencies.fs.fsyncDirectory(posix.dirname(input.selectionPath));
    return { available: true, packageVersion: input.packageVersion, reference: builtReference.reference, selection, lock };
  } finally {
    if (!versionCommitted) await dependencies.fs.remove(temporaryRoot).catch(() => undefined);
    if (!selectionCommitted) await dependencies.fs.remove(selectionTemp).catch(() => undefined);
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  void import('./production.js').then(({ runInstallerCoreCli }) => runInstallerCoreCli())
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`installer failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
