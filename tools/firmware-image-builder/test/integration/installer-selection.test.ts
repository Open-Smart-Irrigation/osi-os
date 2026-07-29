import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configureInstaller } from '../../installer/configure.js';
import { runVersionedInstaller } from '../../installer/install.js';

type Entry = Readonly<{ kind: 'file' | 'directory'; contents?: string | Uint8Array; immutable?: boolean }>;
type Unavailable = Readonly<{ available: false; code: string; detail: string; mutation: 'none' }>;
type ArtifactName = 'api' | 'runner' | 'cleanupWorker' | 'publisher' | 'executionDefinition' | 'ui';

type InstallerFileSystem = Readonly<{
  mkdir(path: string): Promise<void>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<string>;
  fsyncFile(path: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
  renameNoReplace(from: string, to: string): Promise<void>;
  renameReplace(from: string, to: string): Promise<void>;
  makeTreeImmutable(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): boolean;
  isImmutable(path: string): boolean;
  snapshot(): Readonly<Record<string, Entry>>;
  events: readonly string[];
}>;

type ImageInspection = Readonly<{
  reference: string;
  imageId: string;
  repoDigests: readonly string[];
  configEnv: readonly string[];
}>;

type InstallerDependencies = Readonly<{
  fs: InstallerFileSystem;
  probePrerequisites: () => Promise<Readonly<{ available: true }> | Unavailable>;
  buildAndValidateImage: () => Promise<ImageInspection & { imageDigest: string }>;
  inspectAsServiceUser: (reference: string) => Promise<Readonly<{ available: true; inspection: ImageInspection }> | Unavailable>;
  validateProductionImage: (reference: string) => Promise<ImageInspection & { imageDigest: string; validationEvidenceSha256: string }>;
  publisher: Readonly<{
    selfTest: () => Promise<Readonly<{ available: boolean; passed?: boolean; sha256?: string; code?: string; detail?: string }>>;
  }>;
  builderSource: Readonly<{
    baseImage: string;
    baseImageDigest: string;
    dockerfileSha256: string;
    packageSet: readonly string[];
    rustConfig: Readonly<{ llvmConfig: string; channel: string; version: string; llvmMajor: number }>;
    nodeVersion: string;
  }>;
  artifacts: Readonly<Record<ArtifactName, string>>;
  additionalArtifacts: Readonly<Record<string, string>>;
  publisherSha256: string;
  executionDefinitionSha256: string;
  manifestSha256: string;
}>;

type InstallerInput = Readonly<{
  packageVersion: string;
  installRoot: string;
  selectionPath: string;
  systemdConfigPath: string;
  approvedOutputRoot: string;
  dependencies: InstallerDependencies;
  hooks?: Readonly<{ beforeVersionCommit?: () => Promise<void>; afterVersionCommit?: () => Promise<void> }>;
}>;

type CompleteSelection = Readonly<{
  packageVersion: string;
  manifestSha256: string;
  lockSha256: string;
  publisherSha256: string;
  executionDefinitionSha256: string;
}>;

const VERSION = '2026.07.29.1';
const OLD_VERSION = '2026.07.28.1';
const INSTALL_ROOT = '/home/test/.local/lib/osi-image-builder';
const SELECTION_PATH = `${INSTALL_ROOT}/selected.json`;
const SYSTEMD_CONFIG_PATH = '/home/test/.config/systemd/user/osi-image-builder.env';
const APPROVED_OUTPUT_ROOT = '/home/test/osi-images';
const IMAGE_REPOSITORY = 'registry.example.invalid/osi-image-builder';
const HASHES = Object.freeze({
  manifest: 'a'.repeat(64),
  publisher: 'b'.repeat(64),
  executionDefinition: 'c'.repeat(64),
  image: 'd'.repeat(64),
  imageId: 'e'.repeat(64),
  evidence: 'f'.repeat(64),
});
const CANONICAL_IMAGE = `${IMAGE_REPOSITORY}@sha256:${HASHES.image}`;
const DOCKER_IMAGE_ID = `sha256:${HASHES.imageId}`;
const RUNTIME_ENV = Object.freeze(['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']);
const BUILDER_SOURCE = Object.freeze({
  baseImage: `docker.io/library/debian@sha256:${'6'.repeat(64)}`,
  baseImageDigest: '6'.repeat(64),
  dockerfileSha256: '7'.repeat(64),
  packageSet: Object.freeze(['gcc-14', 'nodejs', 'npm', 'openwrt-build-tools', 'llvm-dev', 'libpolly-19-dev', 'libzstd-dev']),
  rustConfig: Object.freeze({ llvmConfig: '/usr/bin/llvm-config', channel: 'stable', version: '1.85.0', llvmMajor: 19 }),
  nodeVersion: '22.14.0',
});

const ARTIFACTS: Readonly<Record<ArtifactName, string>> = Object.freeze({
  api: 'api-entrypoint\n',
  runner: 'runner-entrypoint\n',
  cleanupWorker: 'cleanup-worker-entrypoint\n',
  publisher: 'native-publisher\n',
  executionDefinition: '{"name":"osi-image-build"}\n',
  ui: '<!doctype html><title>OSI Image Builder</title>\n',
});

const ARTIFACT_PATHS: Readonly<Record<ArtifactName, string>> = Object.freeze({
  api: 'bin/osi-image-builder-api',
  runner: 'bin/osi-image-builder-runner',
  cleanupWorker: 'bin/osi-image-builder-cleanup',
  publisher: 'bin/osi-image-publish',
  executionDefinition: 'execution-definition.json',
  ui: 'ui/index.html',
});

function normalize(path: string): string { return posix.normalize(path); }

function parentPaths(path: string): readonly string[] {
  const parents: string[] = [];
  let current = normalize(path);
  while (current !== '/') {
    current = posix.dirname(current);
    parents.push(current);
  }
  return parents.reverse();
}

class MemoryFileSystem implements InstallerFileSystem {
  readonly entries = new Map<string, Entry>([['/', { kind: 'directory' }]]);
  readonly events: string[] = [];

  constructor(initial: Readonly<Record<string, string>> = {}) {
    for (const [path, contents] of Object.entries(initial)) this.seedFile(path, contents);
  }

  private seedFile(path: string, contents: string): void {
    for (const parent of parentPaths(path)) this.entries.set(parent, { kind: 'directory' });
    this.entries.set(normalize(path), { kind: 'file', contents });
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalize(path);
    for (const parent of parentPaths(normalized)) this.entries.set(parent, { kind: 'directory' });
    this.entries.set(normalized, { kind: 'directory' });
    this.events.push(`mkdir:${normalized}`);
  }

  async writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    const normalized = normalize(path);
    if (this.isImmutable(normalized)) throw new Error(`immutable path: ${normalized}`);
    await this.mkdir(posix.dirname(normalized));
    this.entries.set(normalized, { kind: 'file', contents });
    this.events.push(`write:${normalized}`);
  }

  async readFile(path: string): Promise<string> {
    const entry = this.entries.get(normalize(path));
    if (entry?.kind !== 'file') throw new Error(`file not found: ${path}`);
    if (typeof entry.contents !== 'string') throw new Error(`file is not text: ${path}`);
    return entry.contents;
  }

  async fsyncFile(path: string): Promise<void> { this.events.push(`fsync:file:${normalize(path)}`); }
  async fsyncDirectory(path: string): Promise<void> { this.events.push(`fsync:dir:${normalize(path)}`); }

  async renameNoReplace(from: string, to: string): Promise<void> {
    const source = normalize(from);
    const destination = normalize(to);
    if (!this.entries.has(source)) throw new Error(`rename source not found: ${source}`);
    if (this.entries.has(destination)) throw new Error(`rename destination exists: ${destination}`);
    await this.mkdir(posix.dirname(destination));
    const moved = [...this.entries.entries()]
      .filter(([path]) => path === source || path.startsWith(`${source}/`))
      .map(([path, entry]) => [path === source ? destination : `${destination}${path.slice(source.length)}`, entry] as const);
    for (const [path] of moved) this.entries.delete(path === destination ? source : `${source}${path.slice(destination.length)}`);
    for (const [path, entry] of moved) this.entries.set(path, entry);
    this.events.push(`rename:${source}->${destination}`);
  }

  async renameReplace(from: string, to: string): Promise<void> {
    const source = normalize(from);
    const destination = normalize(to);
    if (!this.entries.has(source)) throw new Error(`rename source not found: ${source}`);
    for (const entryPath of [...this.entries.keys()]) {
      if (entryPath === destination || entryPath.startsWith(`${destination}/`)) this.entries.delete(entryPath);
    }
    await this.mkdir(posix.dirname(destination));
    const moved = [...this.entries.entries()]
      .filter(([path]) => path === source || path.startsWith(`${source}/`))
      .map(([path, entry]) => [path === source ? destination : `${destination}${path.slice(source.length)}`, entry] as const);
    for (const [path] of moved) this.entries.delete(path === destination ? source : `${source}${path.slice(destination.length)}`);
    for (const [path, entry] of moved) this.entries.set(path, entry);
    this.events.push(`rename:${source}->${destination}`);
  }

  async makeTreeImmutable(path: string): Promise<void> {
    const normalized = normalize(path);
    for (const [entryPath, entry] of this.entries) {
      if (entryPath === normalized || entryPath.startsWith(`${normalized}/`)) this.entries.set(entryPath, { ...entry, immutable: true });
    }
    this.events.push(`immutable:${normalized}`);
  }

  async remove(path: string): Promise<void> {
    const normalized = normalize(path);
    for (const entryPath of [...this.entries.keys()]) {
      if (entryPath === normalized || entryPath.startsWith(`${normalized}/`)) this.entries.delete(entryPath);
    }
    this.events.push(`remove:${normalized}`);
  }

  exists(path: string): boolean { return this.entries.has(normalize(path)); }

  isImmutable(path: string): boolean {
    const normalized = normalize(path);
    return [...this.entries.entries()].some(([entryPath, entry]) =>
      (entryPath === normalized || normalized.startsWith(`${entryPath}/`)) && entry.immutable === true);
  }

  snapshot(): Readonly<Record<string, Entry>> {
    return Object.fromEntries([...this.entries.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
}

const oldSelection: CompleteSelection = Object.freeze({
  packageVersion: OLD_VERSION,
  manifestSha256: '1'.repeat(64),
  lockSha256: '2'.repeat(64),
  publisherSha256: '3'.repeat(64),
  executionDefinitionSha256: '4'.repeat(64),
});

function selectionJson(selection: CompleteSelection): string { return `${JSON.stringify(selection)}\n`; }
function hash(contents: string): string { return createHash('sha256').update(contents).digest('hex'); }

function createFixture(): { readonly fs: MemoryFileSystem; readonly input: InstallerInput } {
  const fs = new MemoryFileSystem({
    [SELECTION_PATH]: selectionJson(oldSelection),
    [SYSTEMD_CONFIG_PATH]: `INSTALL_ROOT=${INSTALL_ROOT}/${OLD_VERSION}\n`,
    [`${APPROVED_OUTPUT_ROOT}/existing.img`]: 'existing release\n',
    [`${INSTALL_ROOT}/${OLD_VERSION}/builder.lock.json`]: '{"packageVersion":"old"}\n',
  });
  return {
    fs,
    input: {
      packageVersion: VERSION,
      installRoot: INSTALL_ROOT,
      selectionPath: SELECTION_PATH,
      systemdConfigPath: SYSTEMD_CONFIG_PATH,
      approvedOutputRoot: APPROVED_OUTPUT_ROOT,
      dependencies: {
        fs,
        probePrerequisites: async () => ({ available: true, code: 'HOST_PREREQUISITES_AVAILABLE', detail: 'available', mutation: 'none' }),
        buildAndValidateImage: async () => ({ reference: CANONICAL_IMAGE, imageDigest: HASHES.image, imageId: DOCKER_IMAGE_ID, repoDigests: [CANONICAL_IMAGE], configEnv: RUNTIME_ENV }),
        inspectAsServiceUser: async (reference: string) => ({ available: true, inspection: { reference, imageId: DOCKER_IMAGE_ID, repoDigests: [CANONICAL_IMAGE], configEnv: RUNTIME_ENV } }),
        validateProductionImage: async (reference: string) => ({ reference, imageDigest: HASHES.image, imageId: DOCKER_IMAGE_ID, repoDigests: [CANONICAL_IMAGE], configEnv: RUNTIME_ENV, validationEvidenceSha256: HASHES.evidence }),
        publisher: { selfTest: async () => ({ available: true, passed: true, sha256: HASHES.publisher }) },
        builderSource: BUILDER_SOURCE,
        artifacts: ARTIFACTS,
        additionalArtifacts: { 'ui/assets/index.js': 'production-ui\n' },
        publisherSha256: HASHES.publisher,
        executionDefinitionSha256: HASHES.executionDefinition,
        manifestSha256: HASHES.manifest,
      },
    },
  };
}

async function run(
  fixture: ReturnType<typeof createFixture>,
  overrides: Partial<InstallerDependencies> = {},
  inputOverrides: Partial<Omit<InstallerInput, 'dependencies'>> = {},
): Promise<unknown> {
  return runVersionedInstaller({
    ...fixture.input,
    ...inputOverrides,
    dependencies: { ...fixture.input.dependencies, ...overrides },
  });
}

describe('versioned installer transaction', () => {
  it('returns typed unavailable and performs zero filesystem mutation when a prerequisite is missing', async () => {
    const fixture = createFixture();
    const before = fixture.fs.snapshot();
    const result = await run(fixture, { probePrerequisites: async () => ({ available: false, code: 'GCC_MISSING', detail: 'required compiler /usr/bin/gcc is unavailable', mutation: 'none' }) });

    expect(result).toEqual({ available: false, code: 'GCC_MISSING', detail: 'required compiler /usr/bin/gcc is unavailable', mutation: 'none' });
    expect(fixture.fs.snapshot()).toEqual(before);
    expect(fixture.fs.events).toEqual([]);
  });

  it('validates through service-user and production boundaries, then installs one complete immutable version', async () => {
    const fixture = createFixture();
    const result = await run(fixture);
    const versionRoot = `${INSTALL_ROOT}/${VERSION}`;
    const selection = JSON.parse(await fixture.fs.readFile(SELECTION_PATH)) as CompleteSelection;

    expect(result).toMatchObject({ available: true, packageVersion: VERSION });
    expect(fixture.fs.events.indexOf('immutable:' + versionRoot)).toBeGreaterThan(-1);
    for (const artifact of Object.values(ARTIFACT_PATHS)) expect(fixture.fs.exists(`${versionRoot}/${artifact}`)).toBe(true);
    expect(fixture.fs.exists(`${versionRoot}/ui/assets/index.js`)).toBe(true);
    expect(fixture.fs.isImmutable(versionRoot)).toBe(true);
    expect(selection).toMatchObject({ packageVersion: VERSION, manifestSha256: HASHES.manifest, publisherSha256: HASHES.publisher, executionDefinitionSha256: HASHES.executionDefinition });
    expect(selection.lockSha256).toBe(hash(await fixture.fs.readFile(`${versionRoot}/builder.lock.json`)));
    expect(JSON.parse(await fixture.fs.readFile(`${versionRoot}/builder.lock.json`))).toEqual({
      schemaVersion: 1,
      packageVersion: VERSION,
      imageRepository: IMAGE_REPOSITORY,
      imageDigest: HASHES.image,
      ...BUILDER_SOURCE,
      executionDefinitionSha256: HASHES.executionDefinition,
      validationEvidenceSha256: HASHES.evidence,
      installable: true,
      publisherSha256: HASHES.publisher,
      imageId: HASHES.imageId,
    });
  });

  it('proves every rename follows fsync and selection changes only after version commit', async () => {
    const fixture = createFixture();
    await run(fixture);
    const events = fixture.fs.events;
    const renames = events.flatMap((event, index) => event.startsWith('rename:') ? [{ event, index }] : []);
    expect(renames.length).toBe(2);
    for (const { event, index } of renames) {
      const source = event.slice('rename:'.length).split('->')[0]!;
      expect(events.slice(0, index)).toContain(`fsync:${source.includes('selected.json') ? 'file' : 'dir'}:${source}`);
    }
    expect(renames[0]!.event).toContain(`.tmp-${VERSION}->${INSTALL_ROOT}/${VERSION}`);
    expect(renames[1]!.event).toContain(`${SELECTION_PATH}.tmp->${SELECTION_PATH}`);
    expect(renames[1]!.index).toBeGreaterThan(events.findIndex((event) => event === `fsync:dir:${INSTALL_ROOT}`));
    expect(events.slice(renames[1]!.index + 1)).toContain(`fsync:dir:${INSTALL_ROOT}`);
  });

  it('preserves the old selection and removes an incomplete temporary tree on pre-commit crash', async () => {
    const fixture = createFixture();
    await expect(run(fixture, {}, {
      hooks: { beforeVersionCommit: async () => { throw new Error('crash before version rename'); } },
    })).rejects.toThrow('crash before version rename');
    expect(JSON.parse(await fixture.fs.readFile(SELECTION_PATH))).toEqual(oldSelection);
    expect(fixture.fs.exists(`${INSTALL_ROOT}/${VERSION}`)).toBe(false);
    expect([...Object.keys(fixture.fs.snapshot())].some((path) => path.includes(`.tmp-${VERSION}`))).toBe(false);
  });

  it('preserves the old selection if the complete version commits before selection rename', async () => {
    const fixture = createFixture();
    await expect(run(fixture, {}, {
      hooks: { afterVersionCommit: async () => { throw new Error('crash before selection rename'); } },
    })).rejects.toThrow('crash before selection rename');
    expect(JSON.parse(await fixture.fs.readFile(SELECTION_PATH))).toEqual(oldSelection);
    expect(fixture.fs.exists(`${INSTALL_ROOT}/${VERSION}`)).toBe(true);
    expect(fixture.fs.isImmutable(`${INSTALL_ROOT}/${VERSION}`)).toBe(true);
  });

  it('rejects duplicate RepoDigest, invalid Config.Env, service-user denial, and production validation failure before mutation', async () => {
    const failures: readonly Partial<InstallerDependencies>[] = [
      { buildAndValidateImage: async () => ({ reference: CANONICAL_IMAGE, imageDigest: HASHES.image, imageId: DOCKER_IMAGE_ID, repoDigests: [CANONICAL_IMAGE, CANONICAL_IMAGE], configEnv: RUNTIME_ENV }) },
      { buildAndValidateImage: async () => ({ reference: CANONICAL_IMAGE, imageDigest: HASHES.image, imageId: DOCKER_IMAGE_ID, repoDigests: [CANONICAL_IMAGE], configEnv: ['PATH=/bin'] }) },
      { inspectAsServiceUser: async () => ({ available: false as const, code: 'SERVICE_USER_INSPECT_DENIED', detail: 'service user cannot inspect digest-qualified image', mutation: 'none' as const }) },
      { validateProductionImage: async () => { throw Object.assign(new Error('production image validation failed'), { code: 'BUILDER_VALIDATION_EVIDENCE_INVALID' }); } },
      { publisher: { selfTest: async () => ({ available: false, code: 'PUBLISHER_SELF_TEST_MISSING' }) } },
    ];
    for (const overrides of failures) {
      const fixture = createFixture();
      const before = fixture.fs.snapshot();
      await expect(run(fixture, overrides)).rejects.toBeDefined();
      expect(fixture.fs.snapshot()).toEqual(before);
    }
  });
});

describe('installer configuration command', () => {
  it('requires an explicit approved root, prints canonical paths, and writes only after output', async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const before = fixture.fs.snapshot();

    await expect(configureInstaller({
      fs: fixture.fs,
      output: (line: string) => { output.push(line); fixture.fs.events.push(`stdout:${line}`); },
      installRoot: INSTALL_ROOT,
      selectionPath: SELECTION_PATH,
      systemdConfigPath: SYSTEMD_CONFIG_PATH,
    })).rejects.toMatchObject({ code: 'APPROVED_ROOT_REQUIRED' });
    expect(fixture.fs.snapshot()).toEqual(before);
    expect(output).toEqual([]);

    await configureInstaller({
      fs: fixture.fs,
      approvedRoot: APPROVED_OUTPUT_ROOT,
      output: (line: string) => { output.push(line); fixture.fs.events.push(`stdout:${line}`); },
      installRoot: INSTALL_ROOT,
      selectionPath: SELECTION_PATH,
      systemdConfigPath: SYSTEMD_CONFIG_PATH,
    });
    expect(output).toEqual([
      `approvedOutputRoot=${APPROVED_OUTPUT_ROOT}`,
      `installRoot=${INSTALL_ROOT}`,
      `selectionPath=${SELECTION_PATH}`,
      `systemdConfigPath=${SYSTEMD_CONFIG_PATH}`,
    ]);
    const firstWrite = fixture.fs.events.findIndex((event) => event.startsWith('write:'));
    expect(firstWrite).toBeGreaterThan(-1);
    expect(output.every((line) => fixture.fs.events.indexOf(`stdout:${line}`) < firstWrite)).toBe(true);
    expect(fixture.fs.events).toContain(`fsync:file:${SYSTEMD_CONFIG_PATH}.tmp`);
    expect(fixture.fs.events).toContain(`rename:${SYSTEMD_CONFIG_PATH}.tmp->${SYSTEMD_CONFIG_PATH}`);
    expect(fixture.fs.events.at(-1)).toBe(`fsync:dir:${posix.dirname(SYSTEMD_CONFIG_PATH)}`);
  });
});
