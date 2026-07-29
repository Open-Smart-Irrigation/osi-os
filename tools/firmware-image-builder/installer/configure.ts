import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { deriveSystemdBusEnvironment } from '../api/src/preflight.js';
import { resolveConfigDirectories } from '../config/defaults.js';
import { validateBuilderLock } from '../domain/builder-lock.js';
import { loadManifest } from '../manifest/validate.js';
import { InstallerError, type InstallerFileSystem } from './install.js';

const execFile = promisify(execFileCallback);
const MAX_ERROR_BYTES = 1_024;
const VERSION = /^(?:v?\d+\.\d+\.\d+|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)$/u;
const UNIT_NAMES = Object.freeze([
  'osi-image-builder.service',
  'osi-image-builder-runner@.service',
  'osi-image-builder-cleanup@.service',
] as const);

export interface ConfigureInstallerInput {
  readonly fs: Pick<
    InstallerFileSystem,
    'writeFile' | 'fsyncFile' | 'fsyncDirectory' | 'renameReplace' | 'remove'
  >;
  readonly approvedRoot?: string;
  readonly installRoot: string;
  readonly selectionPath: string;
  readonly systemdConfigPath: string;
  readonly output: (line: string) => void;
  readonly canonicalize?: (path: string) => string | Promise<string>;
}

async function canonicalPath(
  value: string | undefined,
  name: string,
  canonicalize: (path: string) => string | Promise<string>,
): Promise<string> {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/') || value.includes('\0')) {
    throw new InstallerError(name === 'approvedOutputRoot' ? 'APPROVED_ROOT_REQUIRED' : 'INSTALL_PATH_INVALID', `${name} must be an explicit absolute path`);
  }
  const canonical = await canonicalize(posix.normalize(value));
  if (typeof canonical !== 'string' || !canonical.startsWith('/') || canonical.includes('\0')) {
    throw new InstallerError('INSTALL_PATH_INVALID', `${name} did not resolve to a canonical absolute path`);
  }
  return posix.normalize(canonical);
}

export async function configureInstaller(input: ConfigureInstallerInput): Promise<Readonly<{
  readonly approvedOutputRoot: string;
  readonly installRoot: string;
  readonly selectionPath: string;
  readonly systemdConfigPath: string;
}>> {
  const canonicalize = input.canonicalize ?? ((path: string) => path);
  const approvedOutputRoot = await canonicalPath(input.approvedRoot, 'approvedOutputRoot', canonicalize);
  const installRoot = await canonicalPath(input.installRoot, 'installRoot', canonicalize);
  const selectionPath = await canonicalPath(input.selectionPath, 'selectionPath', canonicalize);
  const systemdConfigPath = await canonicalPath(input.systemdConfigPath, 'systemdConfigPath', canonicalize);
  const paths = Object.freeze({ approvedOutputRoot, installRoot, selectionPath, systemdConfigPath });

  input.output(`approvedOutputRoot=${paths.approvedOutputRoot}`);
  input.output(`installRoot=${paths.installRoot}`);
  input.output(`selectionPath=${paths.selectionPath}`);
  input.output(`systemdConfigPath=${paths.systemdConfigPath}`);

  const temporaryPath = `${paths.systemdConfigPath}.tmp`;
  let committed = false;
  try {
    await input.fs.writeFile(temporaryPath, [
      `APPROVED_OUTPUT_ROOT=${paths.approvedOutputRoot}`,
      `INSTALL_ROOT=${paths.installRoot}`,
      `SELECTION_PATH=${paths.selectionPath}`,
      '',
    ].join('\n'));
    await input.fs.fsyncFile(temporaryPath);
    await input.fs.renameReplace(temporaryPath, paths.systemdConfigPath);
    committed = true;
    await input.fs.fsyncDirectory(posix.dirname(paths.systemdConfigPath));
  } finally {
    if (!committed) await input.fs.remove(temporaryPath).catch(() => undefined);
  }
  return paths;
}

export interface ProductionConfigureInput {
  readonly approvedRoot: string;
  readonly repositoryPath: string;
}

export interface ProductionConfigureResult {
  readonly approvedOutputRoot: string;
  readonly repositoryPath: string;
  readonly configPath: string;
  readonly versionRoot: string;
}

export interface SelectedInstallation {
  readonly versionRoot: string;
  readonly lockPath: string;
}

export interface ConfigureCliDependencies {
  readonly configure: (input: ProductionConfigureInput) => Promise<ProductionConfigureResult>;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

function requiredHome(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  if (!value.startsWith('/') || value.includes('\0')) throw new Error('configuration HOME is invalid');
  return resolve(value);
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  const parent = dirname(path);
  const temporary = `${path}.tmp`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rm(temporary, { force: true });
  await writeFile(temporary, contents, { flag: 'wx', mode });
  await syncPath(temporary);
  await rename(temporary, path);
  await chmod(path, mode);
  await syncPath(parent);
}

async function canonicalDirectory(path: string, name: string, writable: boolean): Promise<string> {
  if (!path.startsWith('/') || path.includes('\0')) throw new Error(`${name} must be absolute`);
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${name} must be a non-symlink directory`);
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error(`${name} must already be canonical`);
  if (writable) await access(canonical, fsConstants.W_OK);
  return canonical;
}

function systemdPath(path: string): string {
  if (/[\u0000-\u001f\u007f\r\n]/u.test(path)) throw new Error('systemd path contains control characters');
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function renderUnit(
  name: (typeof UNIT_NAMES)[number],
  source: string,
  values: Readonly<{
    versionRoot: string;
    configRoot: string;
    stateRoot: string;
    repositoryPath: string;
    approvedRoot: string;
    configHome: string;
    stateHome: string;
  }>,
): string {
  const apiExecutable = systemdPath(join(values.versionRoot, 'bin', 'osi-image-builder-api'));
  const runnerExecutable = systemdPath(join(values.versionRoot, 'bin', 'osi-image-builder-runner'));
  const cleanupExecutable = systemdPath(join(values.versionRoot, 'bin', 'osi-image-builder-cleanup'));
  const publisherExecutable = systemdPath(join(values.versionRoot, 'bin', 'osi-image-publish'));
  let result = source
    .replaceAll(
      '%h/.local/lib/osi-image-builder/selected/bin/osi-image-builder-api',
      apiExecutable,
    )
    .replaceAll(
      '%h/.local/lib/osi-image-builder/selected/bin/osi-image-builder-runner',
      runnerExecutable,
    )
    .replaceAll(
      '@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@/bin/osi-image-builder-cleanup',
      cleanupExecutable,
    )
    .replaceAll(
      '@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@/bin/osi-image-publish',
      publisherExecutable,
    )
    .replaceAll('@OSI_IMAGE_BUILDER_VERSIONED_INSTALL_ROOT@', systemdPath(values.versionRoot))
    .replaceAll('@OSI_IMAGE_BUILDER_XDG_CONFIG_HOME@', systemdPath(values.configHome))
    .replaceAll('@OSI_IMAGE_BUILDER_XDG_STATE_HOME@', systemdPath(values.stateHome))
    .replaceAll('@OSI_IMAGE_BUILDER_STATE_ROOT@', systemdPath(values.stateRoot))
    .replaceAll('@OSI_IMAGE_BUILDER_CONFIG_ROOT@', systemdPath(values.configRoot))
    .replaceAll('@OSI_IMAGE_BUILDER_REPOSITORY_PATH@', systemdPath(values.repositoryPath))
    .replaceAll('@OSI_IMAGE_BUILDER_OUTPUT_ROOT_PATHS@', systemdPath(values.approvedRoot))
    .replaceAll(
      '@OSI_IMAGE_BUILDER_OUTPUT_WORK_ROOT_PATHS@',
      systemdPath(join(values.approvedRoot, '.osi-image-builder')),
    );
  if (
    result.includes('@OSI_IMAGE_BUILDER_')
    || result.includes('/osi-image-builder/selected/')
    || result.includes('%h/.local/lib/osi-image-builder/selected')
  ) {
    throw new Error(`systemd unit ${name} contains an unresolved installation placeholder`);
  }
  if (!result.endsWith('\n')) result += '\n';
  return result;
}

async function validateGitRepository(path: string): Promise<void> {
  const result = await execFile('/usr/bin/git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    },
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
    shell: false,
  });
  if (String(result.stdout).trim() !== 'true') throw new Error('repository is not a Git worktree');
}

export async function loadSelectedInstallation(
  installRoot: string,
  selectionPath: string,
): Promise<SelectedInstallation> {
  const selectionText = await readFile(selectionPath, 'utf8');
  const selection = JSON.parse(selectionText) as Record<string, unknown>;
  const selectionKeys = [
    'executionDefinitionSha256',
    'lockSha256',
    'manifestSha256',
    'packageVersion',
    'publisherSha256',
  ];
  const selectionHashKeys = [
    'executionDefinitionSha256',
    'lockSha256',
    'manifestSha256',
    'publisherSha256',
  ];
  if (
    Object.keys(selection).sort().join(',') !== [...selectionKeys].sort().join(',')
    || typeof selection.packageVersion !== 'string'
    || !VERSION.test(selection.packageVersion)
    || selectionHashKeys.some((key) => (
      typeof selection[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(selection[key])
    ))
  ) {
    throw new Error('selected installation version is invalid');
  }
  const versionRoot = join(installRoot, selection.packageVersion);
  const lockPath = join(versionRoot, 'builder.lock.json');
  const lockText = await readFile(lockPath, 'utf8');
  const lock = JSON.parse(lockText) as unknown;
  const lockValidation = validateBuilderLock(lock, selection.packageVersion);
  if (!lockValidation.ok) throw new Error(`selected builder lock is invalid: ${lockValidation.reason}`);
  if (
    createHash('sha256').update(lockText).digest('hex') !== selection.lockSha256
    || lockValidation.lock.publisherSha256 !== selection.publisherSha256
    || lockValidation.lock.executionDefinitionSha256 !== selection.executionDefinitionSha256
    || loadManifest(join(versionRoot, 'manifest', 'targets.json')).sha256 !== selection.manifestSha256
  ) {
    throw new Error('selected installation evidence does not match the immutable version');
  }
  return Object.freeze({ versionRoot, lockPath });
}

export async function configureProductionInstaller(
  input: ProductionConfigureInput,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    output?: (line: string) => void;
    runSystemctl?: (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<void>;
  }> = {},
): Promise<ProductionConfigureResult> {
  const home = requiredHome(options.env);
  const approvedOutputRoot = await canonicalDirectory(input.approvedRoot, 'approved output root', true);
  const repositoryPath = await canonicalDirectory(input.repositoryPath, 'repository', false);
  await validateGitRepository(repositoryPath);
  const installRoot = join(home, '.local', 'lib', 'osi-image-builder');
  const selectionPath = join(installRoot, 'selected.json');
  const { versionRoot, lockPath } = await loadSelectedInstallation(installRoot, selectionPath);
  const directories = resolveConfigDirectories(options.env);
  const configPath = join(directories.configRoot, 'config.json');
  const configHome = dirname(directories.configRoot);
  const stateHome = dirname(directories.stateRoot);
  const userUnitRoot = join(configHome, 'systemd', 'user');
  const output = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  for (const line of [
    `approvedOutputRoot=${approvedOutputRoot}`,
    `repositoryPath=${repositoryPath}`,
    `configPath=${configPath}`,
    `versionRoot=${versionRoot}`,
    `stateRoot=${directories.stateRoot}`,
    `userUnitRoot=${userUnitRoot}`,
  ]) output(line);

  await mkdir(directories.stateRoot, { recursive: true, mode: 0o700 });
  await atomicWrite(configPath, `${JSON.stringify({
    repositoryPath,
    approvedOutputRoots: [{
      id: 'release',
      label: 'Firmware images',
      path: approvedOutputRoot,
    }],
    builderLockPath: lockPath,
  })}\n`, 0o600);
  for (const name of UNIT_NAMES) {
    const source = await readFile(join(versionRoot, 'systemd', name), 'utf8');
    const rendered = renderUnit(name, source, {
      versionRoot,
      configRoot: directories.configRoot,
      stateRoot: directories.stateRoot,
      repositoryPath,
      approvedRoot: approvedOutputRoot,
      configHome,
      stateHome,
    });
    await atomicWrite(join(userUnitRoot, name), rendered, 0o600);
  }
  const bus = await deriveSystemdBusEnvironment();
  const systemdEnv = Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    ...bus,
  });
  const runSystemctl = options.runSystemctl ?? (async (argv, env) => {
    await execFile('/usr/bin/systemctl', [...argv], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    });
  });
  await runSystemctl(['--user', 'daemon-reload'], systemdEnv);
  await runSystemctl(['--user', 'enable', '--now', 'osi-image-builder.service'], systemdEnv);
  return Object.freeze({ approvedOutputRoot, repositoryPath, configPath, versionRoot });
}

function parseConfigureArguments(argv: readonly string[]): ProductionConfigureInput | null {
  if (
    argv.length !== 4
    || argv[0] !== '--approved-root'
    || argv[2] !== '--repository'
    || !argv[1]?.startsWith('/')
    || !argv[3]?.startsWith('/')
  ) {
    return null;
  }
  return Object.freeze({ approvedRoot: argv[1], repositoryPath: argv[3] });
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  const singleLine = raw.replace(/[\r\n\t]+/gu, ' ').trim() || 'unknown configuration failure';
  const prefix = 'configuration failed: ';
  const available = MAX_ERROR_BYTES - Buffer.byteLength(prefix, 'utf8') - 1;
  return `${prefix}${Buffer.from(singleLine, 'utf8').subarray(0, available).toString('utf8')}\n`;
}

export async function runConfigureCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: Partial<ConfigureCliDependencies> = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));
  const input = parseConfigureArguments(argv);
  if (input === null) {
    writeStderr('configuration requires --approved-root <absolute> --repository <absolute>\n');
    return 2;
  }
  try {
    const result = await (dependencies.configure ?? configureProductionInstaller)(input);
    writeStdout(`${JSON.stringify({ available: true, ...result })}\n`);
    return 0;
  } catch (error) {
    writeStderr(boundedError(error));
    return 1;
  }
}

const invokedAsScript = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  void runConfigureCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    process.stderr.write(boundedError(error));
    process.exitCode = 1;
  });
}
