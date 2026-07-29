import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { build } from 'esbuild';

import {
  parseCanonicalBuilderImageReference,
  validateBuilderSource,
  validateBuiltBuilderImage,
  validationEvidenceSha256,
} from '../builder/validate-builder.js';
import { assertSupportedPackageParity } from '../builder/derive-dockerfile.js';
import {
  INSTALLED_BUILDER_LOCK_MODE,
  INSTALLED_BUILDER_LOCK_NAME,
} from '../domain/installed-layout.js';
import { loadManifest } from '../manifest/validate.js';
import {
  runVersionedInstaller,
  type InstallerFileSystem,
  type InstallerImageInspection,
  type VersionedInstallerDependencies,
} from './install.js';
import { runNativePrerequisiteProbes, type NativePrerequisiteResult } from './probes.js';

const execFile = promisify(execFileCallback);
const MAX_ERROR_BYTES = 1_024;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_UI_FILES = 10_000;
const MAX_UI_FILE_BYTES = 32 * 1024 * 1024;
const MAX_UI_TOTAL_BYTES = 256 * 1024 * 1024;
const INSTALL_LOCK_NAME = '.osi-image-builder-install.lock';
const DOCKER = '/usr/bin/docker';
const GCC = '/usr/bin/gcc';
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const IMAGE_ENV = Object.freeze([`PATH=${PATH}`]);
const FIXED_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
});

type ArtifactContents = string | Uint8Array;

export interface InstallerCoreCliDependencies {
  readonly install: () => Promise<Readonly<{
    readonly available: boolean;
    readonly packageVersion?: string;
    readonly reference?: string;
    readonly code?: string;
    readonly detail?: string;
  }>>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

interface DockerInspection {
  readonly Id: string;
  readonly RepoDigests: readonly string[];
  readonly Config: Readonly<{ readonly Env: readonly string[] }>;
}

interface PreparedPublisher {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly selfTest: VersionedInstallerDependencies['publisher'];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedError(error: unknown): string {
  const source = error instanceof Error && error.message.length > 0
    ? error.message
    : String(error);
  const singleLine = source.replace(/[\r\n\t]+/gu, ' ').trim() || 'unknown installer failure';
  const prefix = 'installer failed: ';
  const available = MAX_ERROR_BYTES - Buffer.byteLength(prefix, 'utf8') - 1;
  const detail = Buffer.from(singleLine, 'utf8').subarray(0, available).toString('utf8');
  return `${prefix}${detail}\n`;
}

function requiredHome(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  if (!candidate.startsWith('/') || candidate.includes('\0')) throw new Error('installer HOME is invalid');
  return resolve(candidate);
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !value.startsWith(sep));
}

async function command(
  executable: string,
  argv: readonly string[],
  options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string>>; timeout?: number }> = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFile(executable, [...argv], {
    cwd: options.cwd,
    env: options.env ?? FIXED_ENV,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: options.timeout ?? 30_000,
    windowsHide: true,
    shell: false,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function streamingCommand(
  executable: string,
  argv: readonly string[],
  options: Readonly<{ cwd: string; env: Readonly<Record<string, string>>; timeout: number }>,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, [...argv], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolvePromise();
      else reject(new Error(`command failed with code ${String(code)} signal ${String(signal)}`));
    });
  });
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) throw new Error(`fsync target is not a directory: ${path}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareInstallerFsHelper(
  packageRoot: string,
  scratchRoot: string,
): Promise<string> {
  const output = join(scratchRoot, 'installer-fs-helper');
  await command(GCC, [
    '-std=c17',
    '-D_GNU_SOURCE',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-o',
    output,
    join(packageRoot, 'installer', 'installer-fs-helper.c'),
  ], { timeout: 120_000 });
  await chmod(output, 0o555);
  return output;
}

export async function makeTreeImmutable(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error('versioned installation contains a symbolic link');
  if (stats.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('versioned installation contains a symbolic link');
      await makeTreeImmutable(join(path, entry.name));
    }
    await chmod(path, 0o555);
    await syncDirectory(path);
    return;
  }
  if (!stats.isFile()) throw new Error('versioned installation contains a non-regular file');
  const executable = dirname(path).endsWith(`${sep}bin`);
  await chmod(
    path,
    executable
      ? 0o555
      : basename(path) === INSTALLED_BUILDER_LOCK_NAME
        ? INSTALLED_BUILDER_LOCK_MODE
        : 0o444,
  );
  await syncFile(path);
}

function nodeInstallerFileSystem(helper: string): InstallerFileSystem {
  return Object.freeze({
    mkdir: async (path: string) => {
      if (basename(path).startsWith('.tmp-')) {
        await mkdir(path, { mode: 0o700 });
      } else {
        await mkdir(path, { recursive: true, mode: 0o700 });
      }
    },
    writeFile: async (path: string, contents: string | Uint8Array) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
    },
    readFile: (path: string) => readFile(path, 'utf8'),
    fsyncFile: syncFile,
    fsyncDirectory: syncDirectory,
    renameNoReplace: async (from: string, to: string) => {
      await command(helper, ['rename-noreplace', from, to]);
    },
    renameReplace: (from: string, to: string) => rename(from, to),
    makeTreeImmutable,
    remove: (path: string) => rm(path, { recursive: true, force: true }),
  });
}

async function inspectImage(reference: string): Promise<DockerInspection> {
  const result = await command(
    DOCKER,
    ['image', 'inspect', '--format', '{{json .}}', reference],
    { timeout: 10_000 },
  );
  const parsed = JSON.parse(result.stdout) as Partial<DockerInspection>;
  if (
    typeof parsed.Id !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(parsed.Id)
    || !Array.isArray(parsed.RepoDigests)
    || parsed.RepoDigests.some((value) => typeof value !== 'string')
    || !Array.isArray(parsed.Config?.Env)
    || parsed.Config.Env.some((value) => typeof value !== 'string')
  ) {
    throw new Error('Docker image inspection is invalid');
  }
  return parsed as DockerInspection;
}

function exactImageInspection(
  reference: string,
  inspected: DockerInspection,
): InstallerImageInspection {
  const canonical = parseCanonicalBuilderImageReference(reference);
  const prefix = `${canonical.imageRepository}@sha256:`;
  const matches = inspected.RepoDigests.filter((value) => value.startsWith(prefix));
  if (matches.length !== 1 || matches[0] !== reference) {
    throw new Error('Docker image has no unique matching RepoDigest');
  }
  if (JSON.stringify(inspected.Config.Env) !== JSON.stringify(IMAGE_ENV)) {
    throw new Error('Docker image Config.Env is not the exact runtime contract');
  }
  return Object.freeze({
    available: true,
    validated: true,
    reference,
    imageId: inspected.Id,
    imageDigest: canonical.imageDigest,
    repoDigests: Object.freeze([...inspected.RepoDigests]),
    configEnv: Object.freeze([...inspected.Config.Env]),
  });
}

export function buildxLoadArguments(
  tag: string,
  metadataPath: string,
): readonly string[] {
  return Object.freeze([
    'buildx',
    'build',
    '--platform=linux/amd64',
    '--load',
    '--provenance=false',
    '--metadata-file',
    metadataPath,
    '--tag',
    tag,
    '--file',
    'builder/Dockerfile',
    '.',
  ]);
}

export function canonicalLoadedBuildxImage(
  repository: string,
  metadataJson: string,
  inspected: DockerInspection,
): Readonly<{ readonly digest: string; readonly reference: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson) as unknown;
  } catch (error) {
    throw new Error('Buildx metadata JSON is malformed', { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Buildx metadata is not an object');
  }
  const digestValue = (parsed as Record<string, unknown>)['containerimage.digest'];
  if (typeof digestValue !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digestValue)) {
    throw new Error('Buildx metadata has no canonical container image digest');
  }
  const digest = digestValue.slice('sha256:'.length);
  const reference = `${repository}@${digestValue}`;
  const prefix = `${repository}@sha256:`;
  const matches = inspected.RepoDigests.filter((value) => value.startsWith(prefix));
  if (matches.length !== 1 || matches[0] !== reference) {
    throw new Error('loaded image repository digest does not match Buildx metadata');
  }
  return Object.freeze({ digest, reference });
}

async function preparePublisher(
  packageRoot: string,
  scratchRoot: string,
  packageVersion: string,
): Promise<PreparedPublisher> {
  const sourcePath = join(packageRoot, 'publisher', 'osi-image-publish.c');
  const source = await readFile(sourcePath);
  const sourceSha256 = sha256(source);
  const output = join(scratchRoot, 'osi-image-publish');
  await command(GCC, [
    '-std=c17',
    '-D_GNU_SOURCE',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    `-DPUBLISHER_VERSION="${packageVersion}"`,
    `-DPUBLISHER_SOURCE_SHA256="${sourceSha256}"`,
    '-o',
    output,
    sourcePath,
  ], { timeout: 120_000 });
  await chmod(output, 0o555);
  const version = JSON.parse((await command(output, ['--version'])).stdout) as Record<string, unknown>;
  if (
    version.available !== true
    || version.version !== packageVersion
    || version.sourceSha256 !== sourceSha256
  ) {
    throw new Error('native publisher version evidence is invalid');
  }
  await command(output, ['--self-test'], { timeout: 120_000 });
  const bytes = await readFile(output);
  const digest = sha256(bytes);
  return Object.freeze({
    bytes,
    sha256: digest,
    selfTest: Object.freeze({
      selfTest: async () => Object.freeze({
        available: true,
        passed: true,
        sha256: digest,
      }),
    }),
  });
}

async function bundleEntrypoint(path: string): Promise<Uint8Array> {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    sourcemap: false,
    legalComments: 'none',
    banner: { js: '#!/usr/bin/env node' },
  });
  if (result.outputFiles.length !== 1) throw new Error(`entrypoint bundle is incomplete: ${path}`);
  return result.outputFiles[0]!.contents;
}

async function collectFiles(
  sourceRoot: string,
  installedRoot: string,
  result: Record<string, ArtifactContents>,
): Promise<void> {
  const canonicalRoot = await realpath(sourceRoot);
  let count = 0;
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`runtime asset is a symbolic link: ${entry.name}`);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`runtime asset is not a regular file: ${entry.name}`);
      const canonical = await realpath(path);
      if (!contained(canonicalRoot, canonical)) throw new Error('runtime asset escaped its source root');
      const bytes = await readFile(canonical);
      count += 1;
      total += bytes.byteLength;
      if (count > MAX_UI_FILES || bytes.byteLength > MAX_UI_FILE_BYTES || total > MAX_UI_TOTAL_BYTES) {
        throw new Error('runtime asset tree exceeds installation bounds');
      }
      const relativePath = relative(canonicalRoot, canonical).split(sep).join('/');
      result[`${installedRoot}/${relativePath}`] = bytes;
    }
  };
  await visit(canonicalRoot);
}

async function collectRuntimeArtifacts(
  packageRoot: string,
): Promise<Readonly<Record<string, ArtifactContents>>> {
  const result: Record<string, ArtifactContents> = {};
  await collectFiles(join(packageRoot, 'dist'), 'ui', result);
  delete result['ui/index.html'];
  await collectFiles(join(packageRoot, 'api', 'migrations'), 'api/migrations', result);
  await collectFiles(join(packageRoot, 'systemd'), 'systemd', result);
  result['manifest/targets.json'] = await readFile(join(packageRoot, 'manifest', 'targets.json'));
  return Object.freeze(result);
}

async function prepareBuilder(
  packageRoot: string,
  repositoryRoot: string,
  packageVersion: string,
  scratchRoot: string,
): Promise<Readonly<{
  readonly source: VersionedInstallerDependencies['builderSource'];
  readonly buildAndValidateImage: VersionedInstallerDependencies['buildAndValidateImage'];
  readonly inspectAsServiceUser: VersionedInstallerDependencies['inspectAsServiceUser'];
  readonly validateProductionImage: VersionedInstallerDependencies['validateProductionImage'];
  readonly reference: string;
}>> {
  const dockerfile = join(packageRoot, 'builder', 'Dockerfile');
  const rootDockerfile = join(repositoryRoot, 'Dockerfile-devel');
  const executionDefinitionPath = join(packageRoot, 'builder', 'execution-definition.json');
  await assertSupportedPackageParity(rootDockerfile, dockerfile);
  const repository = 'osi-image-builder';
  const tag = `${repository}:${packageVersion.replace(/[^a-zA-Z0-9_.-]/gu, '-')}`;
  const buildMetadataPath = join(scratchRoot, 'builder-build-metadata.json');
  await streamingCommand(DOCKER, buildxLoadArguments(tag, buildMetadataPath), {
    cwd: packageRoot,
    env: Object.freeze({ ...FIXED_ENV, HOME: requiredHome() }),
    timeout: 2 * 60 * 60 * 1_000,
  });
  const buildMetadata = await readFile(buildMetadataPath);
  if (buildMetadata.byteLength > 64 * 1024) {
    throw new Error('Buildx metadata exceeds its size bound');
  }
  const tagged = await inspectImage(tag);
  const { reference } = canonicalLoadedBuildxImage(
    repository,
    buildMetadata.toString('utf8'),
    tagged,
  );
  parseCanonicalBuilderImageReference(reference);
  const validated = await validateBuiltBuilderImage(reference);
  const metadata = await validateBuilderSource({
    dockerfile,
    rootDockerfile,
    executionDefinitionPath,
    evidence: validated.evidence,
  });
  const source = Object.freeze({
    baseImage: metadata.baseImage,
    baseImageDigest: metadata.baseImageDigest,
    dockerfileSha256: metadata.dockerfileSha256,
    packageSet: metadata.packageSet,
    rustConfig: metadata.rustConfig,
    nodeVersion: metadata.nodeVersion,
  });
  const inspect = async (imageReference: string): Promise<InstallerImageInspection> => (
    exactImageInspection(imageReference, await inspectImage(imageReference))
  );
  const productionValidation = async (imageReference: string): Promise<InstallerImageInspection> => {
    const inspection = await inspect(imageReference);
    const rerun = await validateBuiltBuilderImage(imageReference);
    return Object.freeze({
      ...inspection,
      imageDigest: rerun.evidence.imageDigest,
      validationEvidenceSha256: validationEvidenceSha256(rerun.evidence),
    });
  };
  const builtInspection = Object.freeze({
    ...exactImageInspection(reference, await inspectImage(reference)),
    imageDigest: validated.evidence.imageDigest,
    validationEvidenceSha256: validationEvidenceSha256(validated.evidence),
  });
  return Object.freeze({
    source,
    reference,
    buildAndValidateImage: async () => builtInspection,
    inspectAsServiceUser: async (imageReference: string) => Object.freeze({
      available: true,
      inspection: await inspect(imageReference),
    }),
    validateProductionImage: productionValidation,
  });
}

export async function acquireInstallLock(
  helper: string,
  path: string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const child = spawn(helper, ['hold-lock', path], {
    env: FIXED_ENV,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (Buffer.byteLength(stderr, 'utf8') < MAX_ERROR_BYTES) {
      stderr = `${stderr}${chunk}`.slice(0, MAX_ERROR_BYTES);
    }
  });
  const completion = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
    (resolveCompletion, rejectCompletion) => {
      child.once('error', rejectCompletion);
      child.once('exit', (code, signal) => resolveCompletion({ code, signal }));
    },
  );
  let readiness = '';
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('install lock acquisition timed out')), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      readiness += chunk;
      if (Buffer.byteLength(readiness, 'utf8') > 64) {
        clearTimeout(timer);
        rejectReady(new Error('install lock readiness output exceeded its bound'));
      } else if (readiness.includes('\n')) {
        clearTimeout(timer);
        if (readiness === 'LOCKED\n') resolveReady();
        else rejectReady(new Error('install lock readiness output was invalid'));
      }
    });
    completion.then(({ code, signal }) => {
      clearTimeout(timer);
      rejectReady(new Error(
        `install lock helper exited before readiness: code=${String(code)} signal=${String(signal)} ${stderr.trim()}`,
      ));
    }, rejectReady);
  });
  try {
    await ready;
    await syncDirectory(dirname(path));
  } catch (error) {
    child.stdin.destroy();
    child.kill('SIGTERM');
    await completion.catch(() => undefined);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    child.stdin.end();
    const result = await completion;
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(
        `install lock helper failed: code=${String(result.code)} signal=${String(result.signal)} ${stderr.trim()}`,
      );
    }
  };
}

export async function installProductionVersion(): Promise<Readonly<{
  readonly available: boolean;
  readonly packageVersion?: string;
  readonly reference?: string;
  readonly code?: string;
  readonly detail?: string;
}>> {
  const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const repositoryRoot = resolve(packageRoot, '..', '..');
  const home = requiredHome();
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (typeof packageJson.version !== 'string') throw new Error('package version is missing');
  const packageVersion = packageJson.version;
  const installRoot = join(home, '.local', 'lib', 'osi-image-builder');
  const selectionPath = join(installRoot, 'selected.json');
  const prerequisite = await runNativePrerequisiteProbes({ scratchParent: home });
  if (!prerequisite.available) return prerequisite;

  const scratchRoot = await mkdtemp(join(tmpdir(), 'osi-image-builder-install-'));
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const manifest = loadManifest(join(packageRoot, 'manifest', 'targets.json'));
    const [publisher, fsHelper] = await Promise.all([
      preparePublisher(packageRoot, scratchRoot, packageVersion),
      prepareInstallerFsHelper(packageRoot, scratchRoot),
    ]);
    const builder = await prepareBuilder(
      packageRoot,
      repositoryRoot,
      packageVersion,
      scratchRoot,
    );
    const [api, runner, cleanupWorker, runtimeArtifacts, executionDefinition] = await Promise.all([
      bundleEntrypoint(join(packageRoot, 'api', 'src', 'cli.ts')),
      bundleEntrypoint(join(packageRoot, 'runner', 'src', 'cli.ts')),
      bundleEntrypoint(join(packageRoot, 'cleanup-worker', 'src', 'cli.ts')),
      collectRuntimeArtifacts(packageRoot),
      readFile(join(packageRoot, 'builder', 'execution-definition.json'), 'utf8'),
    ]);
    const executionDefinitionSha256 = sha256(executionDefinition);
    const fs = nodeInstallerFileSystem(fsHelper);
    releaseLock = await acquireInstallLock(
      fsHelper,
      join(dirname(installRoot), INSTALL_LOCK_NAME),
    );
    await fs.remove(join(installRoot, `.tmp-${packageVersion}`));
    await fs.remove(`${selectionPath}.tmp`);
    const dependencies: VersionedInstallerDependencies = {
      fs,
      probePrerequisites: async (): Promise<NativePrerequisiteResult> => prerequisite,
      buildAndValidateImage: builder.buildAndValidateImage,
      inspectAsServiceUser: builder.inspectAsServiceUser,
      validateProductionImage: builder.validateProductionImage,
      builderSource: builder.source,
      publisher: publisher.selfTest,
      artifacts: {
        api,
        runner,
        cleanupWorker,
        publisher: publisher.bytes,
        executionDefinition,
        ui: await readFile(join(packageRoot, 'dist', 'index.html'), 'utf8'),
      },
      additionalArtifacts: runtimeArtifacts,
      publisherSha256: publisher.sha256,
      executionDefinitionSha256,
      manifestSha256: manifest.sha256,
    };
    const result = await runVersionedInstaller({
      packageVersion,
      installRoot,
      selectionPath,
      dependencies,
    });
    if (!result.available) return result;
    return Object.freeze({
      available: true,
      packageVersion: result.packageVersion,
      reference: result.reference,
    });
  } finally {
    if (releaseLock !== undefined) await releaseLock().catch(() => undefined);
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

export async function runInstallerCoreCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: Partial<InstallerCoreCliDependencies> = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
  if (argv.length !== 1 || argv[0] !== '--core') {
    writeStderr('installer core requires exactly --core\n');
    return 2;
  }
  try {
    const result = await (dependencies.install ?? installProductionVersion)();
    if (!result.available) {
      writeStderr(boundedError(new Error(`${result.code ?? 'INSTALL_UNAVAILABLE'}: ${result.detail ?? 'installation is unavailable'}`)));
      return 1;
    }
    writeStdout(`${JSON.stringify({
      available: true,
      packageVersion: result.packageVersion,
      reference: result.reference,
    })}\n`);
    return 0;
  } catch (error) {
    writeStderr(boundedError(error));
    return 1;
  }
}
