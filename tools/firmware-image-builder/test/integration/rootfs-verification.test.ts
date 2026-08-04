import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import {
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type PathAuthorityDependencies } from '../../config/load.js';
import type { FreshnessInput, JobRecord } from '../../api/src/store.js';
import { BuilderStore } from '../../api/src/store.js';
import { TEST_BUILDER_IDENTITY } from '../helpers/builder-identity.js';
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import {
  handleApiFreshnessSignal,
} from '../../api/src/freshness-protocol.js';
import { loadManifest } from '../../manifest/validate.js';
import type { TargetManifest } from '../../manifest/schema.js';
import {
  verifyFirmwareArtifact,
  type VerificationInput,
  type WorkspaceAuthority,
} from '../../runner/src/verification.js';
import { createNodeVerifier } from '../../runner/src/main.js';
import type { PipelineOperationExecution } from '../../runner/src/pipeline.js';
import {
  createApiFreshnessSocketClient,
  requestPersistedFreshness,
} from '../../runner/src/freshness.js';
import { createEvidenceWriter } from '../../runner/src/evidence.js';
import {
  createTargetSetupConfigObservations,
  createTargetSetupSourceObservations,
} from '../../runner/src/target-setup.js';

const SHA40 = '0123456789abcdef0123456789abcdef01234567';
const ADVANCED_SHA40 = 'fedcba9876543210fedcba9876543210fedcba98';
const operationToolPath = new URL(
  '../../builder/operations/osi-image-builder-tool.js',
  import.meta.url,
).pathname;
const temporaryDirectories: string[] = [];
const cleanupFunctions: Array<() => Promise<void> | void> = [];
const manifest = loadManifest(new URL('../../manifest/targets.json', import.meta.url).pathname).manifest;
const targets = manifest.targets;
const RELATIVE_HELPERS = [
  'osi-chameleon-helper',
  'osi-chirpstack-helper',
  'osi-cloud-http',
  'osi-db-helper',
  'osi-dendro-helper',
  'osi-health-helper',
  'osi-history-helper',
  'osi-history-sync-helper',
  'osi-lib',
] as const;
const DIRECT_HELPERS = [
  'osi-command-ledger',
  'osi-dendro-analytics',
  'osi-zone-env',
  'osi-history-router',
  'osi-journal',
  'osi-device-writer',
  'osi-uc512-normalize',
  'osi-lsn50-normalize',
] as const;
const SEED_HELPERS = [
  'osi-chameleon-helper',
  'osi-chirpstack-helper',
  'osi-cloud-http',
  'osi-command-ledger',
  'osi-db-helper',
  'osi-dendro-helper',
  'osi-dendro-analytics',
  'osi-zone-env',
  'osi-history-helper',
  'osi-history-sync-helper',
  'osi-history-router',
  'osi-health-helper',
  'osi-lib',
  'osi-journal',
  'osi-device-writer',
  'osi-uc512-normalize',
  'osi-lsn50-normalize',
] as const;
const THIRD_PARTY_PACKAGES = [
  '@grpc/grpc-js',
  '@chirpstack/chirpstack-api',
  'google-protobuf',
  'protobufjs',
] as const;

afterEach(async () => {
  for (const cleanup of cleanupFunctions.splice(0).reverse()) {
    await cleanup();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function sha256(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function offlineFeedPreparation(jobId: string) {
  const recursiveSubmoduleStatusSha256 = sha256('');
  const feed = (
    name: string,
    location: string,
    commit: string,
  ) => Object.freeze({
    name,
    location,
    commit,
    detached: true as const,
    clean: true as const,
    recursiveSubmodulesPrepared: true as const,
    recursiveSubmodules: Object.freeze([]),
    recursiveSubmoduleStatusSha256,
    treeSha256: 'e'.repeat(64),
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    boundary: 'api-prepared-pinned-feeds-v1' as const,
    networkPolicy: 'runner-offline' as const,
    jobId,
    sourceSha: SHA40,
    preparedAt: '2026-07-26T10:00:00.000Z',
    feeds: Object.freeze([
      feed('packages', 'https://git.openwrt.org/feed/packages.git', 'd8cd30f4e281d6853b3de134c4f147a807583e43'),
      feed('luci', 'https://git.openwrt.org/project/luci.git', '2ac26e56cc55102cb10e7b0867c2b78e0f6d5fd8'),
      feed('routing', 'https://git.openwrt.org/feed/routing.git', 'c9b636698881059a3c981032770968f5a98ff201'),
    ]),
  });
}

function configFor(target: TargetManifest): string {
  return `${target.configSymbols.map((symbol) => {
    if (symbol.type === 'bool') return `${symbol.name}=${symbol.value ? 'y' : 'n'}`;
    if (symbol.type === 'string') return `${symbol.name}="${symbol.value}"`;
    return `${symbol.name}=${symbol.value}`;
  }).join('\n')}\n`;
}

function firstBootSeed(): string {
  const modules = SEED_HELPERS.join(' ');
  return `#!/bin/sh
set -eu

SRC=/usr/share/node-red
DST=/srv/node-red

mkdir -p "$DST" "$DST/node_modules"
chown node-red:node-red "$DST" "$DST/node_modules" 2>/dev/null || true

if [ -f /usr/share/flows.json ] && [ ! -f "$DST/flows.json" ]; then
    cp /usr/share/flows.json "$DST/flows.json"
fi

if [ -f "$SRC/settings.js" ] && [ ! -f "$DST/settings.js" ]; then
    cp "$SRC/settings.js" "$DST/settings.js"
fi

if [ -f "$SRC/package.json" ] && [ ! -f "$DST/package.json" ]; then
    cp "$SRC/package.json" "$DST/package.json"
fi

if [ -f "$SRC/package-lock.json" ] && [ ! -f "$DST/package-lock.json" ]; then
    cp "$SRC/package-lock.json" "$DST/package-lock.json"
fi

if [ -f "$SRC/edge-channels.json" ]; then
    cp "$SRC/edge-channels.json" "$DST/edge-channels.json"
fi

if [ -d "$SRC/codecs" ]; then
    mkdir -p "$DST/codecs"
    cp -a "$SRC/codecs/." "$DST/codecs/"
fi

if [ -d "$SRC/node_modules" ]; then
    cp -a "$SRC/node_modules/." "$DST/node_modules/"
fi

# Native sqlite must come from the OpenWrt package built for the target CPU.
rm -rf "$DST/node_modules/sqlite3" "$DST/node_modules/node-red-node-sqlite"

for module in ${modules}; do
  if [ -d "$SRC/$module" ]; then
    rm -rf "$DST/$module" "$DST/node_modules/$module"
    cp -a "$SRC/$module" "$DST/$module"
    cp -a "$SRC/$module" "$DST/node_modules/$module"
  fi
done

SQLITE_SRC=/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3
if [ -d "$SQLITE_SRC" ]; then
    ln -s "$SQLITE_SRC" "$DST/node_modules/sqlite3"
fi

chown -R node-red:node-red "$DST" 2>/dev/null || true

exit 0
`;
}

function trustedNodeVerificationExecution(
  target: TargetManifest,
  rootfsPath: string,
): PipelineOperationExecution {
  const nodeRed = join(rootfsPath, 'usr/share/node-red');
  const require = createRequire(join(nodeRed, '__osi_verification__.cjs'));
  const modules = [
    ...THIRD_PARTY_PACKAGES.map((packageName) => ({
      packageName,
      specifier: packageName,
    })),
    ...RELATIVE_HELPERS.map((packageName) => ({
      packageName,
      specifier: packageName,
    })),
    ...DIRECT_HELPERS.map((packageName) => ({
      packageName,
      specifier: `./${packageName}`,
    })),
  ];
  const nodeResolution = modules.map(({ packageName, specifier }, index) => {
    const resolved = require.resolve(specifier);
    const loaded = require(resolved) as unknown;
    const actualRelativePath = relative(nodeRed, resolved).replaceAll('\\', '/');
    const directRoot = `${packageName}/`;
    const nodeModulesRoot = `node_modules/${packageName}/`;
    const resolvedRelativePath = index >= THIRD_PARTY_PACKAGES.length
      && index < THIRD_PARTY_PACKAGES.length + RELATIVE_HELPERS.length
      && actualRelativePath.startsWith(directRoot)
      ? `${nodeModulesRoot}${actualRelativePath.slice(directRoot.length)}`
      : actualRelativePath;
    return {
      packageName,
      specifier,
      resolvedRelativePath,
      exportType: typeof loaded === 'function'
        ? 'function' as const
        : loaded !== null && typeof loaded === 'object'
          ? 'object' as const
          : 'incompatible' as const,
    };
  });
  return trustedNodeOperationExecution({
    operation: 'verify-image',
    targetId: target.id,
    relativePath: `openwrt/bin/targets/${target.openwrtTarget}/${
      target.id === 'rpi-5'
        ? 'chirpstack-gateway-os-test-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz'
        : 'chirpstack-gateway-os-test-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz'
    }`,
    size: target.minimumArtifactBytes,
    sha256: 'a'.repeat(64),
    nodeResolution,
  });
}

function trustedNodeOperationExecution(result: unknown): PipelineOperationExecution {
  return Object.freeze({
    operationId: 'verify-image',
    attempt: 1,
    outcome: 'passed',
    command: Object.freeze({
      argv: Object.freeze(['node', '/usr/libexec/osi-image-builder-tool', 'verify-image']),
      startedAt: '2026-07-26T10:04:00.000Z',
      finishedAt: '2026-07-26T10:05:00.000Z',
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputLimit: false,
    }),
    observations: Object.freeze({
      stdout: `${JSON.stringify(result)}\n`,
    }),
  });
}

async function authorityFixture(pathAuthorityDependencies?: Partial<PathAuthorityDependencies>) {
  const base = await mkdtemp(join(tmpdir(), 'osi-verification-authority-'));
  temporaryDirectories.push(base);
  const configHome = join(base, 'config');
  const repositoryPath = join(base, 'repository');
  const imagesPath = join(base, 'images');
  await mkdir(configHome, { recursive: true });
  await mkdir(repositoryPath, { recursive: true });
  await mkdir(imagesPath, { recursive: true });
  await chmod(repositoryPath, 0o700);
  await chmod(imagesPath, 0o700);
  const configPath = join(configHome, 'config.json');
  await writeFile(configPath, JSON.stringify({
    repositoryPath,
    approvedOutputRoots: [{ id: 'images', label: 'images', path: imagesPath }],
    builderLockPath: '/opt/osi-image-builder/2026.07.22.1/builder.lock.json',
    maxQueueLength: 50,
    diskFreeMinimumBytes: 20 * 1024 ** 3,
  }));
  const loaded = await loadConfig({
    configPath,
    env: {
      HOME: base,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: join(base, 'state-home'),
    },
    git: {
      getOriginPolicy: async () => ({
        url: 'git@github.com:Open-Smart-Irrigation/osi-os.git',
        fetchRefspec: '+refs/heads/*:refs/remotes/origin/*',
      }),
    },
    rootFs: { statfs: async () => ({ bavail: 30, bsize: 1024 ** 3 }) },
    pathAuthorityDependencies,
  });
  return {
    base,
    statePath: loaded.stateRoot,
    workspace: {
      stateRoot: loaded.pathAuthorities.stateRoot,
      jobId: 'job-verify',
    } satisfies WorkspaceAuthority,
  };
}

export interface RootfsFixture {
  readonly input: VerificationInput;
  readonly authorityBase: string;
  readonly statePath: string;
  readonly sourcePath: string;
  readonly artifactDirectory: string;
  readonly artifactPath: string;
  readonly artifactName: string;
  readonly rootfsPath: string;
  readonly target: TargetManifest;
}

type ConfigEvidenceStage = 'target-setup' | 'config';

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

function configEvidencePath(fixture: RootfsFixture, stage: ConfigEvidenceStage): string {
  return join(
    fixture.statePath,
    'jobs/job-verify/evidence',
    stage === 'target-setup' ? '04-target-setup.json' : '06-config.json',
  );
}

async function readConfigEvidence(
  fixture: RootfsFixture,
  stage: ConfigEvidenceStage,
): Promise<Record<string, unknown>> {
  return objectRecord(
    JSON.parse(await readFile(configEvidencePath(fixture, stage), 'utf8')) as unknown,
    `${stage} evidence`,
  );
}

function configEvidenceProfiles(
  evidence: Record<string, unknown>,
  stage: ConfigEvidenceStage,
): Record<string, unknown> {
  const observations = objectRecord(evidence.observations, `${stage} observations`);
  if (stage === 'target-setup') {
    return objectRecord(observations.profiles, 'target-setup profiles');
  }
  const config = objectRecord(observations.config, 'config observations');
  return objectRecord(config.profiles, 'config profiles');
}

async function overwriteConfigEvidence(
  fixture: RootfsFixture,
  stage: ConfigEvidenceStage,
  evidence: Record<string, unknown>,
): Promise<void> {
  await writeFile(configEvidencePath(fixture, stage), `${JSON.stringify(evidence)}\n`);
}

export async function createRootfsFixture(
  targetId: TargetManifest['id'],
  pathAuthorityDependencies?: Partial<PathAuthorityDependencies>,
): Promise<RootfsFixture> {
  const authority = await authorityFixture(pathAuthorityDependencies);
  const target = targets.find((candidate) => candidate.id === targetId)!;
  const sourcePath = join(authority.statePath, 'jobs', authority.workspace.jobId, 'workspace', 'source');
  await mkdir(sourcePath, { recursive: true });

  const resolvedConfigs = Object.fromEntries(targets.map((profile) => [
    profile.id,
    `${configFor(profile)}# resolved by defconfig for ${profile.id}\n`,
  ])) as Readonly<Record<TargetManifest['id'], string>>;
  const targetSetupEvidence = join(
    authority.statePath,
    'jobs',
    authority.workspace.jobId,
    'evidence/target-setup',
  );
  await mkdir(targetSetupEvidence, { recursive: true });
  const task15EvidenceWriter = createEvidenceWriter({
    stateRoot: authority.workspace.stateRoot,
  });
  await writeFile(
    join(targetSetupEvidence, '..', '01-source.json'),
    JSON.stringify({
      schemaVersion: 1,
      jobId: authority.workspace.jobId,
      stage: 'source',
      outcome: 'passed',
      observations: {
        targetOutputAbsent: true,
        checkedTargetOutputPath: `openwrt/bin/targets/${target.openwrtTarget}/`,
      },
    }),
  );
  for (const profile of targets) {
    await task15EvidenceWriter.writeTargetSetupSourceConfig({
      jobId: authority.workspace.jobId,
      targetId: profile.id,
      contents: Buffer.from(configFor(profile), 'utf8'),
    });
    const profileConfigPath = join(sourcePath, 'conf', profile.environment, '.config');
    await mkdir(join(profileConfigPath, '..'), { recursive: true });
    await writeFile(profileConfigPath, resolvedConfigs[profile.id]);
  }

  const sourceProfileRoot = join(sourcePath, 'conf', target.environment, 'files');
  const sourceFlows = join(sourceProfileRoot, 'usr/share/flows.json');
  const sourceDatabase = join(sourceProfileRoot, 'usr/share/db/farming.db');
  const sourceGui = join(sourcePath, 'web/react-gui/build');
  const feedGui = join(sourcePath, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
  await mkdir(join(sourceFlows, '..'), { recursive: true });
  await mkdir(join(sourceDatabase, '..'), { recursive: true });
  await mkdir(sourceGui, { recursive: true });
  await mkdir(feedGui, { recursive: true });
  await writeFile(sourceFlows, '{"flow":true}\n');
  const sourceDb = new DatabaseSync(sourceDatabase);
  sourceDb.exec('CREATE TABLE chameleon_calibrations (array_id TEXT PRIMARY KEY)');
  sourceDb.close();
  const guiIndex = '<html><head><title>OSI Gateway</title></head><body>gui</body></html>\n';
  await writeFile(join(sourceGui, 'index.html'), guiIndex);
  await writeFile(join(feedGui, 'index.html'), guiIndex);

  const rootfsPath = join(sourcePath, 'openwrt', target.rootfs);
  const writeRootfs = async (path: string, contents: Buffer | string): Promise<void> => {
    const absolute = join(rootfsPath, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents);
  };
  await writeRootfs('etc/uci-defaults/98_osi_node_red_seed', firstBootSeed());
  await writeRootfs('usr/share/flows.json', await readFile(sourceFlows));
  await mkdir(join(rootfsPath, 'usr/share/db'), { recursive: true });
  await copyFile(sourceDatabase, join(rootfsPath, 'usr/share/db/farming.db'));
  await writeRootfs('etc/init.d/node-red', '#!/bin/sh\n');
  await writeRootfs('usr/lib/node-red/gui/index.html', await readFile(join(feedGui, 'index.html')));
  await writeRootfs('etc/nginx/conf.d/node-red.locations', [
    'location /gui/ {',
    '}',
    'location /auth/ {',
    '}',
    'location /api/ {',
    '}',
    'location /download/ {',
    '}',
  ].join('\n'));

  for (const packageName of THIRD_PARTY_PACKAGES) {
    await writeRootfs(
      `usr/share/node-red/node_modules/${packageName}/package.json`,
      JSON.stringify({ name: packageName, main: 'index.js' }),
    );
    await writeRootfs(`usr/share/node-red/node_modules/${packageName}/index.js`, 'module.exports = {};\n');
  }
  for (const helper of [...RELATIVE_HELPERS, ...DIRECT_HELPERS]) {
    await writeRootfs(
      `usr/share/node-red/${helper}/package.json`,
      JSON.stringify({ name: helper, main: 'index.js' }),
    );
    await writeRootfs(`usr/share/node-red/${helper}/index.js`, 'module.exports = {};\n');
  }
  for (const helper of RELATIVE_HELPERS) {
    const link = join(rootfsPath, 'usr/share/node-red/node_modules', helper);
    await mkdir(join(link, '..'), { recursive: true });
    await symlink(`../${helper}`, link);
  }

  const artifactDirectory = join(sourcePath, 'openwrt/bin/targets', target.openwrtTarget);
  await mkdir(artifactDirectory, { recursive: true });
  const artifactName = target.id === 'rpi-5'
    ? 'chirpstack-gateway-os-test-full-bcm27xx-bcm2712-rpi-5-squashfs-factory.img.gz'
    : 'chirpstack-gateway-os-test-full-bcm27xx-bcm2709-rpi-2-squashfs-factory.img.gz';
  const artifactPath = join(artifactDirectory, artifactName);
  await writeFile(
    artifactPath,
    gzipSync(Buffer.alloc(target.minimumArtifactBytes, target.id === 'rpi-5' ? 0x35 : 0x32), { level: 0 }),
  );
  const artifactHash = sha256(await readFile(artifactPath));
  await writeFile(join(artifactDirectory, 'profiles.json'), '{}\n');
  await writeFile(join(artifactDirectory, 'sha256sums'), [
    `${artifactHash}  ${artifactName}`,
    `${sha256('{}\n')}  profiles.json`,
    '',
  ].join('\n'));

  const profiles = Object.fromEntries(targets.map((profile) => {
    const sourceConfig = configFor(profile);
    return [profile.id, {
      target: profile.id,
      environment: profile.environment,
      selectedTarget: profile.openwrtTarget,
      profile: profile.profile,
      rootfsPartSize: profile.rootfsPartSize,
      sourceSha256: sha256(sourceConfig),
      sourceConfigEvidencePath: `evidence/target-setup/${profile.id}.source.config`,
      resolvedSha256: sha256(resolvedConfigs[profile.id]),
    }];
  })) as VerificationInput['config']['profiles'];
  const producerProfiles = Object.freeze({
    'rpi-5': Object.freeze({
      ...profiles['rpi-5'],
      patchDecision: 'applied' as const,
    }),
    'rpi-2': Object.freeze({
      ...profiles['rpi-2'],
      patchDecision: 'applied' as const,
    }),
  });
  const config = {
    selectedTarget: target.openwrtTarget,
    profile: target.profile,
    rootfsPartSize: target.rootfsPartSize,
    bothProfilesChecked: true as const,
    profiles,
  };
  const sourceObservations = createTargetSetupSourceObservations(Object.freeze({
    phase: 'target-setup' as const,
    workspacePath: sourcePath,
    target: target.id,
    patchDecision: 'applied' as const,
    profiles: producerProfiles,
  }));
  const configObservations = createTargetSetupConfigObservations(Object.freeze({
    phase: 'config' as const,
    workspacePath: sourcePath,
    target: target.id,
    config: Object.freeze({
      selectedTarget: config.selectedTarget,
      profile: config.profile,
      rootfsPartSize: config.rootfsPartSize,
      sourceSha256: profiles[target.id].sourceSha256,
      resolvedSha256: profiles[target.id].resolvedSha256,
      bothProfilesChecked: true as const,
      profiles: producerProfiles,
    }),
  }));
  await task15EvidenceWriter.write({
    jobId: authority.workspace.jobId,
    stage: 'target-setup',
    startedAt: '2026-07-26T10:00:00.000Z',
    finishedAt: '2026-07-26T10:01:00.000Z',
    outcome: 'passed',
    operationId: 'activate-target',
    commands: [],
    inputs: {
      targetId: target.id,
      rootId: 'images',
      branch: 'main',
      pinnedSha: SHA40,
    },
    observations: sourceObservations,
    error: null,
  });
  await task15EvidenceWriter.write({
    jobId: authority.workspace.jobId,
    stage: 'config',
    startedAt: '2026-07-26T10:02:00.000Z',
    finishedAt: '2026-07-26T10:03:00.000Z',
    outcome: 'passed',
    operationId: 'resolve-config',
    commands: [],
    inputs: {
      targetId: target.id,
      rootId: 'images',
      branch: 'main',
      pinnedSha: SHA40,
    },
    observations: configObservations,
    error: null,
  });
  const input: VerificationInput = {
    workspace: authority.workspace,
    target,
    targets,
    buildStartedAt: '2020-01-01T00:00:00.000Z',
    sourceEvidence: {
      targetId: target.id,
      openwrtTarget: target.openwrtTarget,
      targetOutputAbsent: true,
      checkedTargetOutputPath: `openwrt/bin/targets/${target.openwrtTarget}/`,
    },
    config,
    pinnedSha: SHA40,
    branch: 'main',
    nodeVerifier: createNodeVerifier(
      target,
      () => trustedNodeVerificationExecution(target, rootfsPath),
    ),
    freshness: {
      client: {
        signal: async () => undefined,
      },
      store: {
        getJob: () => freshnessJob({
          status: 'fresh',
          pinnedSha: SHA40,
          observedSha: SHA40,
          newerSourceAvailable: false,
          checkedAt: '2026-07-26T11:00:00.000Z',
        }),
      },
    },
  };
  return {
    input,
    authorityBase: authority.base,
    statePath: authority.statePath,
    sourcePath,
    artifactDirectory,
    artifactPath,
    artifactName,
    rootfsPath,
    target,
  };
}

async function writeOriginalChecksums(fixture: RootfsFixture): Promise<void> {
  const image = await readFile(fixture.artifactPath);
  await writeFile(join(fixture.artifactDirectory, 'sha256sums'), [
    `${sha256(image)}  ${fixture.artifactName}`,
    `${sha256('{}\n')}  profiles.json`,
    '',
  ].join('\n'));
}

function freshnessJob(value: unknown): JobRecord {
  const candidate = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const status = candidate.status;
  return {
    pinnedSha: candidate.pinnedSha ?? SHA40,
    freshnessRequestedAt: '2026-07-26T10:59:00.000Z',
    freshnessStatus: status ?? 'malformed',
    freshnessObservedSha: candidate.observedSha ?? null,
    newerSourceAvailable: candidate.newerSourceAvailable ?? false,
    freshnessCheckedAt: candidate.checkedAt ?? '2026-07-26T11:00:00.000Z',
    freshnessErrorCode: candidate.errorCode
      ?? (status === 'unknown' ? 'FRESHNESS_UNKNOWN' : null),
    freshnessError: candidate.error
      ?? (status === 'unknown' ? { reason: 'API resolver failed' } : null),
    freshnessErrorEvidencePath: candidate.errorEvidencePath
      ?? (status === 'unknown' ? 'jobs/job-verify/evidence/freshness-error.json' : null),
    freshnessErrorEvidenceSha256: candidate.errorEvidenceSha256
      ?? (status === 'unknown' ? 'a'.repeat(64) : null),
  } as unknown as JobRecord;
}

function withFreshness(
  input: VerificationInput,
  resolve: (request: {
    readonly jobId: string;
    readonly branch: string;
    readonly pinnedSha: string;
  }) => Promise<unknown>,
): VerificationInput {
  let persisted: unknown;
  return {
    ...input,
    freshness: {
      timeoutMs: 50,
      pollIntervalMs: 5,
      client: {
        signal: async (jobId) => {
          persisted = await resolve({
            jobId,
            branch: input.branch,
            pinnedSha: input.pinnedSha,
          });
        },
      },
      store: {
        getJob: () => persisted === undefined
          ? ({
              pinnedSha: input.pinnedSha,
              freshnessStatus: null,
            } as unknown as JobRecord)
          : freshnessJob(persisted),
      },
    },
  };
}

describe('real rootfs verification contract', () => {
  it('joins resolved-only stage06 evidence to the strict verifier and actual locked loader', async () => {
    const fixture = await createRootfsFixture('rpi-5');
    await symlink(
      `${fixture.target.environment}/.config`,
      join(fixture.sourcePath, 'conf/.config'),
    );
    await symlink('../conf/.config', join(fixture.sourcePath, 'openwrt/.config'));
    const rootfsNodeRed = join(fixture.rootfsPath, 'usr/share/node-red');
    const shippedNodeRed = join(
      process.cwd(),
      '../../conf',
      fixture.target.environment,
      'files/usr/share/node-red',
    );
    await rm(join(rootfsNodeRed, 'node_modules'), { recursive: true, force: true });
    await cp(
      join(shippedNodeRed, 'node_modules'),
      join(rootfsNodeRed, 'node_modules'),
      { recursive: true },
    );
    for (const helper of [...RELATIVE_HELPERS, ...DIRECT_HELPERS]) {
      await rm(join(rootfsNodeRed, helper), { recursive: true, force: true });
      await cp(
        join(shippedNodeRed, helper),
        join(rootfsNodeRed, helper),
        { recursive: true },
      );
    }
    for (const helper of RELATIVE_HELPERS) {
      const link = join(rootfsNodeRed, 'node_modules', helper);
      await rm(link, { recursive: true, force: true });
      await symlink(`../${helper}`, link);
    }
    const operationTool = await import(operationToolPath) as {
      createOperationHandlersForTesting(rootPath: string): {
        verifyImage(): Promise<unknown>;
      };
    };
    const trustedResult = await operationTool
      .createOperationHandlersForTesting(fixture.sourcePath)
      .verifyImage();
    const input: VerificationInput = {
      ...fixture.input,
      nodeVerifier: createNodeVerifier(
        fixture.target,
        () => trustedNodeOperationExecution(trustedResult),
      ),
    };

    const configEvidence = JSON.parse(await readFile(
      join(fixture.statePath, 'jobs/job-verify/evidence/06-config.json'),
      'utf8',
    )) as {
      observations: {
        config: {
          profiles: Record<string, Record<string, unknown>>;
        };
      };
    };
    expect(Object.keys(configEvidence.observations.config.profiles['rpi-5']!).sort())
      .toEqual([
        'environment',
        'profile',
        'resolvedSha256',
        'rootfsPartSize',
        'selectedTarget',
        'target',
      ]);
    await expect(verifyFirmwareArtifact(input)).resolves.toMatchObject({
      config: {
        profiles: {
          'rpi-5': {
            resolvedSha256: fixture.input.config.profiles['rpi-5'].resolvedSha256,
          },
        },
      },
      rootfs: {
        nodeResolution: {
          'osi-db-helper': true,
        },
      },
    });
  }, 30_000);

  it('joins production stage 04 source identity with stage 06 resolved hashes', async () => {
    const fixture = await createRootfsFixture('rpi-5');
    const targetSetupEvidence = JSON.parse(await readFile(
      join(fixture.statePath, 'jobs/job-verify/evidence/04-target-setup.json'),
      'utf8',
    )) as Record<string, unknown>;
    const configEvidence = JSON.parse(await readFile(
      join(fixture.statePath, 'jobs/job-verify/evidence/06-config.json'),
      'utf8',
    )) as Record<string, unknown>;

    expect(targetSetupEvidence).toMatchObject({
      stage: 'target-setup',
      observations: {
        profiles: {
          'rpi-5': {
            target: 'rpi-5',
            sourceSha256: fixture.input.config.profiles['rpi-5'].sourceSha256,
          },
          'rpi-2': {
            target: 'rpi-2',
            sourceSha256: fixture.input.config.profiles['rpi-2'].sourceSha256,
          },
        },
      },
    });
    expect(targetSetupEvidence).not.toHaveProperty('observations.config');
    expect(targetSetupEvidence).not.toHaveProperty(
      'observations.profiles.rpi-5.resolvedSha256',
    );
    expect(configEvidence).toMatchObject({
      stage: 'config',
      observations: {
        config: {
          bothProfilesChecked: true,
          profiles: {
            'rpi-5': {
              resolvedSha256: fixture.input.config.profiles['rpi-5'].resolvedSha256,
            },
            'rpi-2': {
              resolvedSha256: fixture.input.config.profiles['rpi-2'].resolvedSha256,
            },
          },
        },
      },
    });
    expect(configEvidence).not.toHaveProperty(
      'observations.config.profiles.rpi-5.sourceSha256',
    );
    expect(configEvidence).not.toHaveProperty(
      'observations.config.profiles.rpi-5.sourceConfigEvidencePath',
    );

    const result = await verifyFirmwareArtifact(fixture.input);
    expect(result.config.profiles['rpi-5'].resolvedSha256).toBe(
      fixture.input.config.profiles['rpi-5'].resolvedSha256,
    );
    expect(result.config.profiles['rpi-2'].resolvedSha256).toBe(
      fixture.input.config.profiles['rpi-2'].resolvedSha256,
    );
  }, 30_000);

  it.each(targets)(
    'matches the checked-in $id helper deployment contract',
    async (target) => {
      const nodeRed = join(
        process.cwd(),
        '../../conf',
        target.environment,
        'files/usr/share/node-red',
      );
      for (const helper of RELATIVE_HELPERS) {
        const link = join(nodeRed, 'node_modules', helper);
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readlink(link)).toBe(`../${helper}`);
        expect((await lstat(join(nodeRed, helper, 'package.json'))).isFile()).toBe(true);
      }
      for (const helper of DIRECT_HELPERS) {
        expect((await lstat(join(nodeRed, helper, 'package.json'))).isFile()).toBe(true);
        await expect(lstat(join(nodeRed, 'node_modules', helper))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      const seed = await readFile(join(
        process.cwd(),
        '../../conf',
        target.environment,
        'files/etc/uci-defaults/98_osi_node_red_seed',
      ), 'utf8');
      const moduleLoop = /for module in\s+([^;\r\n]+);\s*do/u.exec(seed);
      expect(moduleLoop).not.toBeNull();
      const modules = moduleLoop![1]!.trim().split(/\s+/u);
      expect(modules).toHaveLength(SEED_HELPERS.length);
      expect([...modules].sort()).toEqual([...SEED_HELPERS].sort());
      expect(seed).toContain('cp -a "$SRC/$module" "$DST/node_modules/$module"');
    },
  );

  it.each(['rpi-5', 'rpi-2'] as const)('accepts the shipped %s helper and payload layout', async (targetId) => {
    const fixture = await createRootfsFixture(targetId);
    await copyFile(
      join(
        process.cwd(),
        '../../conf',
        fixture.target.environment,
        'files/etc/uci-defaults/98_osi_node_red_seed',
      ),
      join(fixture.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
    );
    const result = await verifyFirmwareArtifact(fixture.input);

    expect(result.artifact.path).toBe(`openwrt/bin/targets/${fixture.target.openwrtTarget}/${fixture.artifactName}`);
    expect(result.rootfs.helpers.relativeSymlinks).toEqual(RELATIVE_HELPERS);
    expect(result.rootfs.helpers.directUntilFirstBoot).toEqual(DIRECT_HELPERS);
    expect(result.rootfs.helpers.firstBootSeedVerified).toBe(true);
    expect(result.rootfs.nodeResolution.protobufjs).toBe(true);
    expect(result.rootfs.database).toEqual({ integrityCheck: 'ok', chameleonCalibrationRows: 0 });
    expect(result.rootfs.gui).toMatchObject({
      title: 'OSI Gateway',
      sourceGuiTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      feedGuiTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      rootfsGuiTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(new Set([
      result.rootfs.gui.sourceGuiTreeSha256,
      result.rootfs.gui.feedGuiTreeSha256,
      result.rootfs.gui.rootfsGuiTreeSha256,
    ]).size).toBe(1);
    expect(result.rootfs.criticalHashes.gui).toEqual({
      sourceGuiTreeSha256: result.rootfs.gui.sourceGuiTreeSha256,
      feedGuiTreeSha256: result.rootfs.gui.feedGuiTreeSha256,
      rootfsGuiTreeSha256: result.rootfs.gui.rootfsGuiTreeSha256,
      matched: true,
    });
    expect(result.evidence.json).toMatchObject({
      rootfs: {
        gui: result.rootfs.gui,
        criticalHashes: { gui: result.rootfs.criticalHashes.gui },
      },
      observations: {
        rootfs: {
          gui: result.rootfs.gui,
          criticalHashes: { gui: result.rootfs.criticalHashes.gui },
        },
      },
    });
    expect(result.config.profiles['rpi-5'].sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.config.profiles['rpi-2'].resolvedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.config.profiles['rpi-5'].sourceConfigEvidencePath).toBe(
      'evidence/target-setup/rpi-5.source.config',
    );
    expect(result.config.profiles['rpi-2'].sourceConfigEvidencePath).toBe(
      'evidence/target-setup/rpi-2.source.config',
    );
    expect(result.checks.generatedSha256sums.contents).toBe(
      `${result.artifact.sha256}  ${fixture.artifactName}\n`,
    );
    expect(result.checks.generatedSha256sums.filenames).toEqual([fixture.artifactName]);
    expect(result.evidence.json).toMatchObject({
      checks: {
        generatedSha256sums: {
          contents: result.checks.generatedSha256sums.contents,
          sha256: result.checks.generatedSha256sums.sha256,
          verified: true,
        },
      },
      observations: {
        targetOutputAbsent: true,
        checkedTargetOutputPath: `openwrt/bin/targets/${fixture.target.openwrtTarget}/`,
        artifact: result.artifact,
        checks: result.checks,
        config: result.config,
        rootfs: result.rootfs,
        freshnessStatus: 'fresh',
        newerSourceAvailable: false,
        pinnedSha: SHA40,
        observedSha: SHA40,
        freshnessCheckedAt: '2026-07-26T11:00:00.000Z',
        freshnessError: null,
      },
    });
    expect(result.evidence.bytes).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(result.evidence.json)).not.toContain(fixture.statePath);
  }, 20_000);

  it.each(['rpi-5', 'rpi-2'] as const)(
    'rejects stale, small, missing, and differently named duplicate %s artifacts',
    async (targetId) => {
      const stale = await createRootfsFixture(targetId);
      await utimes(stale.artifactPath, new Date(0), new Date(0));
      await expect(verifyFirmwareArtifact(stale.input)).rejects.toMatchObject({ code: 'ARTIFACT_STALE' });

      const small = await createRootfsFixture(targetId);
      await writeFile(small.artifactPath, gzipSync(Buffer.from('small')));
      await expect(verifyFirmwareArtifact(small.input)).rejects.toMatchObject({ code: 'ARTIFACT_TOO_SMALL' });

      const missing = await createRootfsFixture(targetId);
      await rm(missing.artifactPath);
      await expect(verifyFirmwareArtifact(missing.input)).rejects.toMatchObject({ code: 'ARTIFACT_MISSING' });

      const duplicate = await createRootfsFixture(targetId);
      await writeFile(
        join(duplicate.artifactDirectory, `unrelated-${targetId}-factory.img.gz`),
        gzipSync(Buffer.from('second factory image')),
      );
      await expect(verifyFirmwareArtifact(duplicate.input)).rejects.toMatchObject({
        code: 'BUILD_OUTPUT_COLLISION',
        details: { count: 2 },
      });
    },
    30_000,
  );

  it('separates original OpenWrt checksum evidence, generated checksum, and gzip integrity', async () => {
    const originalMismatch = await createRootfsFixture('rpi-5');
    await writeFile(
      join(originalMismatch.artifactDirectory, 'sha256sums'),
      `${'0'.repeat(64)}  ${originalMismatch.artifactName}\n`,
    );
    await expect(verifyFirmwareArtifact(originalMismatch.input)).rejects.toMatchObject({
      code: 'CHECKSUM_FAILED',
    });

    const traversal = await createRootfsFixture('rpi-5');
    await writeFile(
      join(traversal.artifactDirectory, 'sha256sums'),
      `${'0'.repeat(64)}  ../outside\n`,
    );
    await expect(verifyFirmwareArtifact(traversal.input)).rejects.toMatchObject({
      code: 'CHECKSUM_FAILED',
    });

    const corruptGzip = await createRootfsFixture('rpi-5');
    await writeFile(corruptGzip.artifactPath, Buffer.from('not gzip'));
    await truncate(corruptGzip.artifactPath, corruptGzip.target.minimumArtifactBytes);
    await writeOriginalChecksums(corruptGzip);
    await expect(verifyFirmwareArtifact(corruptGzip.input)).rejects.toMatchObject({
      code: 'GZIP_FAILED',
    });
  }, 30_000);

  it('requires and validates both Task 15 source and resolved config hash records', async () => {
    const fixture = await createRootfsFixture('rpi-5');
    const missingProfiles = {
      'rpi-5': fixture.input.config.profiles['rpi-5'],
    } as unknown as VerificationInput['config']['profiles'];
    await expect(verifyFirmwareArtifact({
      ...fixture.input,
      config: {
        ...fixture.input.config,
        profiles: missingProfiles,
      },
    })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });

    for (const targetId of ['rpi-5', 'rpi-2'] as const) {
      for (const hashField of ['sourceSha256', 'resolvedSha256'] as const) {
        const profile = fixture.input.config.profiles[targetId];
        await expect(verifyFirmwareArtifact({
          ...fixture.input,
          config: {
            ...fixture.input.config,
            profiles: {
              ...fixture.input.config.profiles,
              [targetId]: { ...profile, [hashField]: 'not-a-sha256' },
            },
          },
        })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
      }

      const profile = fixture.input.config.profiles[targetId];
      await expect(verifyFirmwareArtifact({
        ...fixture.input,
        config: {
          ...fixture.input.config,
          profiles: {
            ...fixture.input.config.profiles,
            [targetId]: { ...profile, resolvedSha256: '0'.repeat(64) },
          },
        },
      })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });

      await expect(verifyFirmwareArtifact({
        ...fixture.input,
        config: {
          ...fixture.input.config,
          profiles: {
            ...fixture.input.config.profiles,
            [targetId]: { ...profile, sourceSha256: 'f'.repeat(64) },
          },
        },
      })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });

      await expect(verifyFirmwareArtifact({
        ...fixture.input,
        config: {
          ...fixture.input.config,
          profiles: {
            ...fixture.input.config.profiles,
            [targetId]: {
              ...profile,
              sourceConfigEvidencePath: `evidence/target-setup/${targetId}.forged.config`,
            },
          },
        },
      })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    }

    const result = await verifyFirmwareArtifact(fixture.input);
    expect(result.evidence.json).toMatchObject({
      config: {
        profiles: {
          'rpi-5': {
            sourceSha256: fixture.input.config.profiles['rpi-5'].sourceSha256,
            resolvedSha256: fixture.input.config.profiles['rpi-5'].resolvedSha256,
          },
          'rpi-2': {
            sourceSha256: fixture.input.config.profiles['rpi-2'].sourceSha256,
            resolvedSha256: fixture.input.config.profiles['rpi-2'].resolvedSha256,
          },
        },
      },
    });
  }, 30_000);

  it('rejects missing, duplicate, or mismatched profiles across stage 04 and stage 06', async () => {
    for (const stage of ['target-setup', 'config'] as const) {
      const missing = await createRootfsFixture('rpi-5');
      const missingEvidence = await readConfigEvidence(missing, stage);
      delete configEvidenceProfiles(missingEvidence, stage)['rpi-2'];
      await overwriteConfigEvidence(missing, stage, missingEvidence);
      await expect(verifyFirmwareArtifact(missing.input)).rejects.toMatchObject({
        code: 'TARGET_CONFIG_MISMATCH',
      });

      const duplicate = await createRootfsFixture('rpi-2');
      const duplicateEvidence = await readConfigEvidence(duplicate, stage);
      const duplicateProfiles = configEvidenceProfiles(duplicateEvidence, stage);
      duplicateProfiles['rpi-2'] = {
        ...objectRecord(duplicateProfiles['rpi-5'], `${stage} rpi-5 profile`),
      };
      await overwriteConfigEvidence(duplicate, stage, duplicateEvidence);
      await expect(verifyFirmwareArtifact(duplicate.input)).rejects.toMatchObject({
        code: 'TARGET_CONFIG_MISMATCH',
      });
    }

    const mismatch = await createRootfsFixture('rpi-5');
    const mismatchEvidence = await readConfigEvidence(mismatch, 'config');
    const mismatchProfiles = configEvidenceProfiles(mismatchEvidence, 'config');
    mismatchProfiles['rpi-2'] = {
      ...objectRecord(mismatchProfiles['rpi-2'], 'config rpi-2 profile'),
      environment: 'forged-environment',
    };
    await overwriteConfigEvidence(mismatch, 'config', mismatchEvidence);
    await expect(verifyFirmwareArtifact(mismatch.input)).rejects.toMatchObject({
      code: 'TARGET_CONFIG_MISMATCH',
    });

    const missingFile = await createRootfsFixture('rpi-2');
    await unlink(configEvidencePath(missingFile, 'config'));
    await expect(verifyFirmwareArtifact(missingFile.input)).rejects.toMatchObject({
      name: 'VerificationError',
    });
  }, 30_000);

  it('rejects non-production target-setup and config evidence shapes', async () => {
    const unknownEnvelope = await createRootfsFixture('rpi-5');
    const unknownEnvelopeEvidence = await readConfigEvidence(unknownEnvelope, 'target-setup');
    unknownEnvelopeEvidence.fabricated = true;
    await overwriteConfigEvidence(unknownEnvelope, 'target-setup', unknownEnvelopeEvidence);
    await expect(verifyFirmwareArtifact(unknownEnvelope.input)).rejects.toMatchObject({
      code: 'TARGET_CONFIG_MISMATCH',
    });

    const missingEnvelope = await createRootfsFixture('rpi-2');
    const missingEnvelopeEvidence = await readConfigEvidence(missingEnvelope, 'config');
    delete missingEnvelopeEvidence.startedAt;
    await overwriteConfigEvidence(missingEnvelope, 'config', missingEnvelopeEvidence);
    await expect(verifyFirmwareArtifact(missingEnvelope.input)).rejects.toMatchObject({
      code: 'TARGET_CONFIG_MISMATCH',
    });

    for (const stage of ['target-setup', 'config'] as const) {
      const operation = await createRootfsFixture('rpi-5');
      const operationEvidence = await readConfigEvidence(operation, stage);
      operationEvidence.operationId = stage === 'target-setup'
        ? 'resolve-config'
        : 'activate-target';
      await overwriteConfigEvidence(operation, stage, operationEvidence);
      await expect(verifyFirmwareArtifact(operation.input)).rejects.toMatchObject({
        code: 'TARGET_CONFIG_MISMATCH',
      });

      const unknownObservation = await createRootfsFixture('rpi-2');
      const unknownObservationEvidence = await readConfigEvidence(unknownObservation, stage);
      objectRecord(
        unknownObservationEvidence.observations,
        `${stage} observations`,
      ).fabricated = true;
      await overwriteConfigEvidence(unknownObservation, stage, unknownObservationEvidence);
      await expect(verifyFirmwareArtifact(unknownObservation.input)).rejects.toMatchObject({
        code: 'TARGET_CONFIG_MISMATCH',
      });
    }

    const missingObservation = await createRootfsFixture('rpi-5');
    const missingObservationEvidence = await readConfigEvidence(
      missingObservation,
      'target-setup',
    );
    delete objectRecord(
      missingObservationEvidence.observations,
      'target-setup observations',
    ).patchDecision;
    await overwriteConfigEvidence(
      missingObservation,
      'target-setup',
      missingObservationEvidence,
    );
    await expect(verifyFirmwareArtifact(missingObservation.input)).rejects.toMatchObject({
      code: 'TARGET_CONFIG_MISMATCH',
    });

    const missingProfileField = await createRootfsFixture('rpi-2');
    const missingProfileFieldEvidence = await readConfigEvidence(
      missingProfileField,
      'config',
    );
    const missingFieldProfiles = configEvidenceProfiles(
      missingProfileFieldEvidence,
      'config',
    );
    delete objectRecord(
      missingFieldProfiles['rpi-2'],
      'config rpi-2 profile',
    ).resolvedSha256;
    await overwriteConfigEvidence(
      missingProfileField,
      'config',
      missingProfileFieldEvidence,
    );
    await expect(verifyFirmwareArtifact(missingProfileField.input)).rejects.toMatchObject({
      code: 'TARGET_CONFIG_MISMATCH',
    });

    const stage04Resolved = await createRootfsFixture('rpi-5');
    const stage04ResolvedEvidence = await readConfigEvidence(stage04Resolved, 'target-setup');
    const stage04ResolvedProfiles = configEvidenceProfiles(
      stage04ResolvedEvidence,
      'target-setup',
    );
    stage04ResolvedProfiles['rpi-5'] = {
      ...objectRecord(stage04ResolvedProfiles['rpi-5'], 'target-setup rpi-5 profile'),
      resolvedSha256: 'a'.repeat(64),
    };
    await overwriteConfigEvidence(stage04Resolved, 'target-setup', stage04ResolvedEvidence);
    await expect(verifyFirmwareArtifact(stage04Resolved.input)).rejects.toMatchObject({
      code: 'TARGET_CONFIG_MISMATCH',
    });

    const stage06Source = await createRootfsFixture('rpi-2');
    const stage06SourceEvidence = await readConfigEvidence(stage06Source, 'config');
    const stage06SourceProfiles = configEvidenceProfiles(stage06SourceEvidence, 'config');
    stage06SourceProfiles['rpi-2'] = {
      ...objectRecord(stage06SourceProfiles['rpi-2'], 'config rpi-2 profile'),
      sourceSha256: stage06Source.input.config.profiles['rpi-2'].sourceSha256,
      sourceConfigEvidencePath:
        stage06Source.input.config.profiles['rpi-2'].sourceConfigEvidencePath,
    };
    await overwriteConfigEvidence(stage06Source, 'config', stage06SourceEvidence);
    await expect(verifyFirmwareArtifact(stage06Source.input)).rejects.toMatchObject({
      code: 'TARGET_CONFIG_MISMATCH',
    });

    const wrongProfileKey = await createRootfsFixture('rpi-5');
    const wrongProfileKeyEvidence = await readConfigEvidence(wrongProfileKey, 'config');
    const wrongProfileKeyProfiles = configEvidenceProfiles(wrongProfileKeyEvidence, 'config');
    wrongProfileKeyProfiles['rpi-five'] = wrongProfileKeyProfiles['rpi-5'];
    delete wrongProfileKeyProfiles['rpi-5'];
    await overwriteConfigEvidence(wrongProfileKey, 'config', wrongProfileKeyEvidence);
    await expect(verifyFirmwareArtifact(wrongProfileKey.input)).rejects.toMatchObject({
      code: 'TARGET_CONFIG_MISMATCH',
    });
  }, 30_000);

  it.each(['rpi-5', 'rpi-2'] as const)(
    'rejects source or resolved %s symbol tampering even when the supplied hash is well formed',
    async (targetId) => {
      const sourceTamper = await createRootfsFixture('rpi-5');
      const sourcePath = join(
        sourceTamper.statePath,
        'jobs/job-verify/evidence/target-setup',
        `${targetId}.source.config`,
      );
      const sourceBytes = (await readFile(sourcePath, 'utf8')).replace(
        /CONFIG_TARGET_ROOTFS_PARTSIZE=14336/u,
        'CONFIG_TARGET_ROOTFS_PARTSIZE=4096',
      );
      await writeFile(sourcePath, sourceBytes);
      const sourceProfiles = {
        ...sourceTamper.input.config.profiles,
        [targetId]: {
          ...sourceTamper.input.config.profiles[targetId],
          sourceSha256: sha256(sourceBytes),
        },
      };
      const sourceEvidence = await readConfigEvidence(sourceTamper, 'target-setup');
      const persistedSourceProfiles = configEvidenceProfiles(sourceEvidence, 'target-setup');
      persistedSourceProfiles[targetId] = {
        ...objectRecord(persistedSourceProfiles[targetId], `target-setup ${targetId} profile`),
        sourceSha256: sha256(sourceBytes),
      };
      await overwriteConfigEvidence(sourceTamper, 'target-setup', sourceEvidence);
      await expect(verifyFirmwareArtifact({
        ...sourceTamper.input,
        config: {
          ...sourceTamper.input.config,
          profiles: sourceProfiles,
        },
      })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });

      const resolvedTamper = await createRootfsFixture('rpi-2');
      const target = targets.find((candidate) => candidate.id === targetId)!;
      const resolvedPath = join(
        resolvedTamper.sourcePath,
        'conf',
        target.environment,
        '.config',
      );
      const resolvedBytes = (await readFile(resolvedPath, 'utf8')).replace(
        /CONFIG_TARGET_ROOTFS_PARTSIZE=14336/u,
        'CONFIG_TARGET_ROOTFS_PARTSIZE=4096',
      );
      await writeFile(resolvedPath, resolvedBytes);
      const resolvedProfiles = {
        ...resolvedTamper.input.config.profiles,
        [targetId]: {
          ...resolvedTamper.input.config.profiles[targetId],
          resolvedSha256: sha256(resolvedBytes),
        },
      };
      const resolvedEvidence = await readConfigEvidence(resolvedTamper, 'config');
      const persistedResolvedProfiles = configEvidenceProfiles(resolvedEvidence, 'config');
      persistedResolvedProfiles[targetId] = {
        ...objectRecord(persistedResolvedProfiles[targetId], `config ${targetId} profile`),
        resolvedSha256: sha256(resolvedBytes),
      };
      await overwriteConfigEvidence(resolvedTamper, 'config', resolvedEvidence);
      await expect(verifyFirmwareArtifact({
        ...resolvedTamper.input,
        config: {
          ...resolvedTamper.input.config,
          profiles: resolvedProfiles,
        },
      })).rejects.toMatchObject({ code: 'TARGET_CONFIG_MISMATCH' });
    },
    30_000,
  );

  it('binds source-stage absence to the exact selected target output', async () => {
    const fixture = await createRootfsFixture('rpi-2');
    const wrong = {
      ...fixture.input.sourceEvidence,
      checkedTargetOutputPath: 'openwrt/bin/targets/bcm27xx/bcm2712/',
    };
    await expect(verifyFirmwareArtifact({
      ...fixture.input,
      sourceEvidence: wrong,
    })).rejects.toMatchObject({ code: 'BUILD_OUTPUT_COLLISION' });

    const forged = await createRootfsFixture('rpi-5');
    await writeFile(
      join(forged.statePath, 'jobs/job-verify/evidence/01-source.json'),
      JSON.stringify({
        schemaVersion: 1,
        jobId: 'job-verify',
        stage: 'source',
        outcome: 'passed',
        observations: {
          targetOutputAbsent: true,
          checkedTargetOutputPath: 'openwrt/bin/targets/bcm27xx/bcm2709/',
        },
      }),
    );
    await expect(verifyFirmwareArtifact(forged.input)).rejects.toMatchObject({
      code: 'BUILD_OUTPUT_COLLISION',
    });
  });

  it('rejects helper escapes and enforces the nine-symlink/eight-direct first-boot contract', async () => {
    const escaped = await createRootfsFixture('rpi-5');
    const escapedLink = join(
      escaped.rootfsPath,
      'usr/share/node-red/node_modules/osi-chameleon-helper',
    );
    await unlink(escapedLink);
    await symlink('../../outside', escapedLink);
    await expect(verifyFirmwareArtifact(escaped.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const earlyDirect = await createRootfsFixture('rpi-2');
    await mkdir(
      join(earlyDirect.rootfsPath, 'usr/share/node-red/node_modules/osi-command-ledger'),
      { recursive: true },
    );
    await expect(verifyFirmwareArtifact(earlyDirect.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const missingDirect = await createRootfsFixture('rpi-5');
    await rm(
      join(missingDirect.rootfsPath, 'usr/share/node-red/osi-command-ledger'),
      { recursive: true },
    );
    await expect(verifyFirmwareArtifact(missingDirect.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
  }, 30_000);

  it('requires confined Node resolution for protobufjs and every local helper entrypoint', async () => {
    const missingProtobuf = await createRootfsFixture('rpi-5');
    await rm(join(
      missingProtobuf.rootfsPath,
      'usr/share/node-red/node_modules/protobufjs/index.js',
    ));
    await expect(verifyFirmwareArtifact(missingProtobuf.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const missingHelper = await createRootfsFixture('rpi-2');
    await rm(join(
      missingHelper.rootfsPath,
      'usr/share/node-red/osi-command-ledger/index.js',
    ));
    await expect(verifyFirmwareArtifact(missingHelper.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const exportsPackage = await createRootfsFixture('rpi-5');
    const protobufRoot = join(
      exportsPackage.rootfsPath,
      'usr/share/node-red/node_modules/protobufjs',
    );
    await writeFile(join(protobufRoot, 'package.json'), JSON.stringify({
      name: 'protobufjs',
      exports: './dist/runtime.cjs',
    }));
    await rm(join(protobufRoot, 'index.js'));
    await mkdir(join(protobufRoot, 'dist'), { recursive: true });
    await writeFile(join(protobufRoot, 'dist/runtime.cjs'), 'module.exports = { verified: true };\n');
    await expect(verifyFirmwareArtifact(exportsPackage.input)).resolves.toMatchObject({
      rootfs: { nodeResolution: { protobufjs: true } },
    });

    const callable = await createRootfsFixture('rpi-5');
    await writeFile(
      join(callable.rootfsPath, 'usr/share/node-red/osi-command-ledger/index.js'),
      'module.exports = function verifiedHelper() {};\n',
    );
    await expect(verifyFirmwareArtifact(callable.input)).resolves.toMatchObject({
      rootfs: { nodeResolution: { 'osi-command-ledger': true } },
    });

    const incompatible = await createRootfsFixture('rpi-2');
    await writeFile(
      join(incompatible.rootfsPath, 'usr/share/node-red/osi-command-ledger/index.js'),
      'module.exports = 7;\n',
    );
    await expect(verifyFirmwareArtifact(incompatible.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
  }, 30_000);

  it('requires active routes in only the exact node-red.locations nginx include', async () => {
    const commentedNginx = await createRootfsFixture('rpi-5');
    await writeFile(
      join(commentedNginx.rootfsPath, 'etc/nginx/conf.d/node-red.locations'),
      [
        '# location /gui/ {',
        'location /auth/ {',
        'location /api/ {',
        'location /download/ {',
      ].join('\n'),
    );
    await expect(verifyFirmwareArtifact(commentedNginx.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const disabledNginx = await createRootfsFixture('rpi-2');
    const activePath = join(disabledNginx.rootfsPath, 'etc/nginx/conf.d/node-red.locations');
    await rename(activePath, `${activePath}.disabled`);
    await expect(verifyFirmwareArtifact(disabledNginx.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const arbitraryNginx = await createRootfsFixture('rpi-5');
    const requiredPath = join(arbitraryNginx.rootfsPath, 'etc/nginx/conf.d/node-red.locations');
    await rename(requiredPath, join(arbitraryNginx.rootfsPath, 'etc/nginx/routes.conf'));
    await expect(verifyFirmwareArtifact(arbitraryNginx.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
  }, 30_000);

  it('requires exact reachable first-boot helper and SQLite actions', async () => {
    const wrongAssignment = await createRootfsFixture('rpi-2');
    await writeFile(
      join(wrongAssignment.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        'SRC=/usr/share/node-red',
        '# SRC=/usr/share/node-red\nSRC=/tmp/node-red',
      ),
    );
    await expect(verifyFirmwareArtifact(wrongAssignment.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const commentedCopy = await createRootfsFixture('rpi-5');
    await writeFile(
      join(commentedCopy.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        'cp -a "$SRC/$module" "$DST/node_modules/$module"',
        '# cp -a "$SRC/$module" "$DST/node_modules/$module"',
      ),
    );
    await expect(verifyFirmwareArtifact(commentedCopy.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const falseBranch = await createRootfsFixture('rpi-2');
    await writeFile(
      join(falseBranch.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed()
        .replace('for module in ', 'if false; then\nfor module in ')
        .replace('\ndone\nSQLITE_SRC=', '\ndone\nfi\nSQLITE_SRC='),
    );
    await expect(verifyFirmwareArtifact(falseBranch.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const uncalledFunction = await createRootfsFixture('rpi-5');
    await writeFile(
      join(uncalledFunction.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed()
        .replace('for module in ', 'seed_helpers() {\nfor module in ')
        .replace('\ndone\nSQLITE_SRC=', '\ndone\n}\nSQLITE_SRC='),
    );
    await expect(verifyFirmwareArtifact(uncalledFunction.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const heredoc = await createRootfsFixture('rpi-2');
    await writeFile(
      join(heredoc.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        '    cp -a "$SRC/$module" "$DST/node_modules/$module"',
        [
          '    cat <<\'UNREACHABLE\'',
          '    cp -a "$SRC/$module" "$DST/node_modules/$module"',
          'UNREACHABLE',
        ].join('\n'),
      ),
    );
    await expect(verifyFirmwareArtifact(heredoc.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const earlyExit = await createRootfsFixture('rpi-5');
    await writeFile(
      join(earlyExit.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        'for module in ',
        'exit 0\nfor module in ',
      ),
    );
    await expect(verifyFirmwareArtifact(earlyExit.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const wrongBranch = await createRootfsFixture('rpi-2');
    await writeFile(
      join(wrongBranch.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        '    cp -a "$SRC/$module" "$DST/node_modules/$module"',
        [
          '    if false; then',
          '      :',
          '    else',
          '      cp -a "$SRC/$module" "$DST/node_modules/$module"',
          '    fi',
        ].join('\n'),
      ),
    );
    await expect(verifyFirmwareArtifact(wrongBranch.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const unreachableSqliteCleanup = await createRootfsFixture('rpi-5');
    await writeFile(
      join(unreachableSqliteCleanup.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        'rm -rf "$DST/node_modules/sqlite3" "$DST/node_modules/node-red-node-sqlite"',
        [
          'if false; then',
          '  rm -rf "$DST/node_modules/sqlite3" "$DST/node_modules/node-red-node-sqlite"',
          'fi',
        ].join('\n'),
      ),
    );
    await expect(verifyFirmwareArtifact(unreachableSqliteCleanup.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const quotedAction = await createRootfsFixture('rpi-2');
    await writeFile(
      join(quotedAction.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        '    cp -a "$SRC/$module" "$DST/$module"',
        '    echo \'cp -a "$SRC/$module" "$DST/$module"\'',
      ),
    );
    await expect(verifyFirmwareArtifact(quotedAction.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const multilineQuotedAction = await createRootfsFixture('rpi-5');
    await writeFile(
      join(multilineQuotedAction.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        '    cp -a "$SRC/$module" "$DST/$module"',
        [
          '    echo \'',
          '    cp -a "$SRC/$module" "$DST/$module"',
          '    \'',
        ].join('\n'),
      ),
    );
    await expect(verifyFirmwareArtifact(multilineQuotedAction.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
  }, 30_000);

  it('rejects terminating, unknown, substituted, and reordered first-boot commands', async () => {
    const topLevelFalse = await createRootfsFixture('rpi-5');
    await writeFile(
      join(topLevelFalse.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace('set -eu', 'set -eu\nfalse'),
    );
    await expect(verifyFirmwareArtifact(topLevelFalse.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const earlyReturn = await createRootfsFixture('rpi-2');
    await writeFile(
      join(earlyReturn.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace('set -eu', 'set -eu\nreturn 0'),
    );
    await expect(verifyFirmwareArtifact(earlyReturn.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const unknownCommand = await createRootfsFixture('rpi-5');
    await writeFile(
      join(unknownCommand.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace('set -eu', 'set -eu\nmystery-command'),
    );
    await expect(verifyFirmwareArtifact(unknownCommand.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const commandSubstitution = await createRootfsFixture('rpi-2');
    await writeFile(
      join(commandSubstitution.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace('set -eu', 'set -eu\n$(false)'),
    );
    await expect(verifyFirmwareArtifact(commandSubstitution.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const reorderedCopies = await createRootfsFixture('rpi-5');
    await writeFile(
      join(reorderedCopies.rootfsPath, 'etc/uci-defaults/98_osi_node_red_seed'),
      firstBootSeed().replace(
        [
          '    cp -a "$SRC/$module" "$DST/$module"',
          '    cp -a "$SRC/$module" "$DST/node_modules/$module"',
        ].join('\n'),
        [
          '    cp -a "$SRC/$module" "$DST/node_modules/$module"',
          '    cp -a "$SRC/$module" "$DST/$module"',
        ].join('\n'),
      ),
    );
    await expect(verifyFirmwareArtifact(reorderedCopies.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
  }, 30_000);

  it('rejects a source GUI mismatch even when feed and rootfs GUI trees match', async () => {
    const fixture = await createRootfsFixture('rpi-5');
    await writeFile(
      join(fixture.sourcePath, 'web/react-gui/build/index.html'),
      '<html><head><title>OSI Gateway</title></head><body>different source bytes</body></html>\n',
    );
    await expect(verifyFirmwareArtifact(fixture.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
  }, 30_000);

  it('checks SQLite integrity and records zero or populated Chameleon observations', async () => {
    const corrupt = await createRootfsFixture('rpi-5');
    const corruptSourceDb = join(
      corrupt.sourcePath,
      'conf',
      corrupt.target.environment,
      'files/usr/share/db/farming.db',
    );
    const corruptRootfsDb = join(corrupt.rootfsPath, 'usr/share/db/farming.db');
    await writeFile(corruptSourceDb, 'not sqlite');
    await copyFile(corruptSourceDb, corruptRootfsDb);
    await expect(verifyFirmwareArtifact(corrupt.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

    const populated = await createRootfsFixture('rpi-2');
    const populatedSourceDb = join(
      populated.sourcePath,
      'conf',
      populated.target.environment,
      'files/usr/share/db/farming.db',
    );
    const database = new DatabaseSync(populatedSourceDb);
    database.exec("INSERT INTO chameleon_calibrations (array_id) VALUES ('A')");
    database.close();
    await copyFile(populatedSourceDb, join(populated.rootfsPath, 'usr/share/db/farming.db'));
    await expect(verifyFirmwareArtifact(populated.input)).resolves.toMatchObject({
      rootfs: {
        database: { integrityCheck: 'ok', chameleonCalibrationRows: 1 },
      },
    });
  }, 30_000);

  it('uses the API-owned freshness request and enforces exact fresh and advanced invariants', async () => {
    const fixture = await createRootfsFixture('rpi-5');
    const requests: unknown[] = [];
    const fresh = await verifyFirmwareArtifact(withFreshness(fixture.input, async (request) => {
      requests.push(request);
      return {
        status: 'fresh',
        pinnedSha: request.pinnedSha,
        observedSha: request.pinnedSha,
        newerSourceAvailable: false,
      };
    }));
    expect(requests).toEqual([{ jobId: 'job-verify', branch: 'main', pinnedSha: SHA40 }]);
    expect(fresh.freshness).toEqual({
      status: 'fresh',
      pinnedSha: SHA40,
      observedSha: SHA40,
      newerSourceAvailable: false,
      checkedAt: '2026-07-26T11:00:00.000Z',
    });

    const advanced = await verifyFirmwareArtifact(withFreshness(fixture.input, async () => ({
      status: 'advanced',
      pinnedSha: SHA40,
      observedSha: ADVANCED_SHA40,
      newerSourceAvailable: true,
    })));
    expect(advanced.freshness).toEqual({
      status: 'advanced',
      pinnedSha: SHA40,
      observedSha: ADVANCED_SHA40,
      newerSourceAvailable: true,
      checkedAt: '2026-07-26T11:00:00.000Z',
    });
  }, 30_000);

  it('signals the mode-0600 API socket, persists the request/result, and reads advanced freshness from SQLite', async () => {
    const authority = await authorityFixture();
    const database = openBuilderDatabase(join(authority.statePath, 'jobs.sqlite'));
    const store = new BuilderStore(database);
    const ownership = new OwnershipStore(database);
    cleanupFunctions.push(() => store.close());
    const enqueued = ownership.apiWrite({
      kind: 'enqueue',
      input: {
        jobId: 'job-verify',
        requestId: 'request-job-verify',
        request: { branch: 'main', target: 'rpi-5' },
        sourceRemote: 'git@example.com:osi-os.git',
        sourceRef: 'refs/remotes/origin/main',
        sourceBranch: 'main',
        branch: 'main',
        expectedSha: SHA40,
        pinnedSha: SHA40,
        sourcePreparation: {
          schemaVersion: 1,
          sourceSha: SHA40,
          gitmodulesBlobSha: 'b'.repeat(40),
          preparedAt: '2026-07-26T10:00:00.000Z',
          components: [
            {
              path: 'feeds/chirpstack-openwrt-feed',
              mode: '040000',
              type: 'tree',
              objectId: 'c'.repeat(40),
              provenanceUrl: 'https://github.com/chirpstack/chirpstack-openwrt-feed.git',
            },
            {
              path: 'openwrt',
              mode: '040000',
              type: 'tree',
              objectId: 'd'.repeat(40),
              provenanceUrl: 'https://github.com/openwrt/openwrt.git',
            },
          ],
        },
        offlineFeedPreparation: offlineFeedPreparation('job-verify'),
        targetId: 'rpi-5',
        rootId: 'images',
        targetManifestSha256: 'e'.repeat(64),
        builderIdentity: { ...TEST_BUILDER_IDENTITY, targetManifestSha256: 'e'.repeat(64) },
        sourceCommitTime: '2026-07-26T09:59:00.000Z',
        sourceAuthor: 'Builder Test',
        sourceSubject: 'freshness protocol',
        acceptedAt: '2026-07-26T10:00:00.000Z',
      },
    });
    expect(enqueued.ok).toBe(true);

    const protocolStore = {
      getJob: (jobId: string) => store.getJob(jobId),
      request: (jobId: string, at: string) => ownership.apiWrite({
        kind: 'freshness-request',
        jobId,
        at,
      }),
      result: (
        jobId: string,
        input: FreshnessInput,
        at: string,
      ) => ownership.apiWrite({
        kind: 'freshness-result',
        jobId,
        input,
        at,
      }),
    };
    const times = [
      '2026-07-26T10:01:00.000Z',
      '2026-07-26T10:03:00.000Z',
    ];
    const socketPath = join(authority.statePath, 'api.sock');
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => {
        void handleApiFreshnessSignal(Buffer.concat(chunks), {
          store: protocolStore,
          resolver: {
            resolve: async () => ({
              status: 'advanced',
              observedSha: ADVANCED_SHA40,
              checkedAt: '2026-07-26T10:02:00.000Z',
            }),
          },
          errorEvidence: {
            write: async () => {
              throw new Error('must not write error evidence for valid advanced result');
            },
          },
          now: () => times.shift()!,
        }).then((ack) => socket.end(ack), (error) => socket.destroy(error));
      });
    });
    await listen(server, socketPath);
    await chmod(socketPath, 0o600);
    cleanupFunctions.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const result = await requestPersistedFreshness({
      boundary: {
        client: createApiFreshnessSocketClient(authority.workspace.stateRoot),
        store,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      },
      jobId: 'job-verify',
      pinnedSha: SHA40,
    });
    expect(result).toEqual({
      status: 'advanced',
      pinnedSha: SHA40,
      observedSha: ADVANCED_SHA40,
      newerSourceAvailable: true,
      checkedAt: '2026-07-26T10:02:00.000Z',
    });
    expect(store.getJob('job-verify')).toMatchObject({
      freshnessRequestedAt: '2026-07-26T10:01:00.000Z',
      freshnessStatus: 'advanced',
      freshnessObservedSha: ADVANCED_SHA40,
      freshnessCheckedAt: '2026-07-26T10:02:00.000Z',
    });
    await chmod(socketPath, 0o644);
    await expect(requestPersistedFreshness({
      boundary: {
        client: createApiFreshnessSocketClient(authority.workspace.stateRoot),
        store,
        timeoutMs: 100,
        pollIntervalMs: 5,
      },
      jobId: 'job-verify',
      pinnedSha: SHA40,
    })).resolves.toEqual(result);
  }, 30_000);

  it('turns unavailable, malformed, and contradictory freshness responses into informational unknown', async () => {
    const fixture = await createRootfsFixture('rpi-2');
    const responses: readonly unknown[] = [
      null,
      { status: 'fresh', pinnedSha: SHA40, observedSha: ADVANCED_SHA40, newerSourceAvailable: false },
      { status: 'fresh', pinnedSha: SHA40, observedSha: SHA40, newerSourceAvailable: true },
      { status: 'advanced', pinnedSha: SHA40, observedSha: SHA40, newerSourceAvailable: true },
      { status: 'advanced', pinnedSha: SHA40, observedSha: ADVANCED_SHA40, newerSourceAvailable: false },
      { status: 'advanced', pinnedSha: ADVANCED_SHA40, observedSha: SHA40, newerSourceAvailable: true },
      {
        status: 'unknown',
        pinnedSha: SHA40,
        observedSha: ADVANCED_SHA40,
        newerSourceAvailable: false,
        errorCode: 'FRESHNESS_UNKNOWN',
      },
    ];
    for (const response of responses) {
      const result = await verifyFirmwareArtifact(withFreshness(fixture.input, async () => response));
      expect(result.freshness).toMatchObject({
        status: 'unknown',
        pinnedSha: SHA40,
        observedSha: null,
        newerSourceAvailable: false,
        error: {
          code: 'FRESHNESS_UNKNOWN',
          reason: 'malformed-result',
        },
      });
      expect([null, '2026-07-26T11:00:00.000Z']).toContain(
        result.freshness.checkedAt,
      );
    }
    const unavailable = await verifyFirmwareArtifact(withFreshness(fixture.input, async () => {
      throw new Error('API socket unavailable');
    }));
    expect(unavailable.freshness).toMatchObject({
      status: 'unknown',
      checkedAt: null,
      error: { code: 'FRESHNESS_UNKNOWN', reason: 'socket-unavailable' },
    });

    const timeout = await verifyFirmwareArtifact({
      ...fixture.input,
      freshness: {
        timeoutMs: 20,
        pollIntervalMs: 5,
        client: { signal: async () => undefined },
        store: {
          getJob: () => ({
            pinnedSha: SHA40,
            freshnessStatus: null,
          } as unknown as JobRecord),
        },
      },
    });
    expect(timeout.freshness).toMatchObject({
      status: 'unknown',
      checkedAt: null,
      error: { code: 'FRESHNESS_UNKNOWN', reason: 'timeout' },
    });
  }, 60_000);

  it('classifies non-canonical or unbounded verification evidence', async () => {
    const fixture = await createRootfsFixture('rpi-5');
    const cyclicConfig = { ...fixture.input.config } as VerificationInput['config'] & {
      cycle?: unknown;
    };
    cyclicConfig.cycle = cyclicConfig;
    await expect(verifyFirmwareArtifact({
      ...fixture.input,
      config: cyclicConfig,
    })).rejects.toMatchObject({ code: 'VERIFICATION_EVIDENCE_INVALID' });
  }, 30_000);

  it.each([
    ['state root', '/osi-image-builder', null],
    ['jobs', '/osi-image-builder', 'jobs'],
    ['job', '/osi-image-builder/jobs', 'job-verify'],
    ['workspace', '/jobs/job-verify', 'workspace'],
    ['source', '/jobs/job-verify/workspace', 'source'],
  ] as const)('rejects a %s ancestor replacement without reading outside authority', async (
    _label,
    heldSuffix,
    child,
  ) => {
    const outside = await mkdtemp(join(tmpdir(), 'osi-verification-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'marker'), 'must not be read');
    let armed = false;
    let raced = false;
    let outsideReads = 0;
    const fixture = await createRootfsFixture('rpi-5', {
      beforeDirectoryAccess: async (handle) => {
        if (!armed || raced) return;
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!heldPath.endsWith(heldSuffix)) return;
        raced = true;
        const victim = child === null ? heldPath : join(heldPath, child);
        await rename(victim, `${victim}.held`);
        await symlink(outside, victim);
      },
      beforeRead: async (handle) => {
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (heldPath.startsWith(outside)) outsideReads += 1;
      },
    });
    armed = true;
    await expect(verifyFirmwareArtifact(fixture.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
    expect(raced).toBe(true);
    expect(outsideReads).toBe(0);
  }, 30_000);

  it('rejects an identical regular-file replacement after the artifact descriptor is held', async () => {
    let armed = false;
    let raced = false;
    let replacementPath = '';
    const fixture = await createRootfsFixture('rpi-2', {
      beforeRead: async (handle) => {
        if (!armed || raced) return;
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!heldPath.endsWith('-factory.img.gz')) return;
        raced = true;
        await rename(heldPath, `${heldPath}.held`);
        await rename(replacementPath, heldPath);
      },
    });
    replacementPath = join(fixture.sourcePath, 'replacement.img.gz');
    await copyFile(fixture.artifactPath, replacementPath);
    armed = true;

    await expect(verifyFirmwareArtifact(fixture.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
    expect(raced).toBe(true);
  }, 30_000);

  it('rejects a final artifact basename replacement after the last content read', async () => {
    let armed = false;
    let artifactRead = false;
    let raced = false;
    let replacementPath = '';
    let artifactDirectory = '';
    let artifactPath = '';
    const fixture = await createRootfsFixture('rpi-5', {
      beforeRead: async (handle) => {
        if (!armed) return;
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (heldPath.endsWith('-factory.img.gz')) artifactRead = true;
      },
      beforeDirectoryAccess: async (handle) => {
        if (!armed || !artifactRead || raced) return;
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (heldPath !== artifactDirectory) return;
        raced = true;
        await rename(artifactPath, `${artifactPath}.held`);
        await rename(replacementPath, artifactPath);
      },
    });
    artifactDirectory = fixture.artifactDirectory;
    artifactPath = fixture.artifactPath;
    replacementPath = join(fixture.sourcePath, 'replacement-after-read.img.gz');
    await copyFile(fixture.artifactPath, replacementPath);
    armed = true;
    await expect(verifyFirmwareArtifact(fixture.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
    expect(raced).toBe(true);
  }, 30_000);

  it('rejects a same-shaped directory replacement between tree listing and child reads', async () => {
    let armed = false;
    let guiChecks = 0;
    let raced = false;
    const fixture = await createRootfsFixture('rpi-2', {
      beforeDirectoryAccess: async (handle) => {
        if (!armed || raced) return;
        const heldPath = await readlink(`/proc/self/fd/${handle.fd}`);
        if (!heldPath.endsWith('feeds/chirpstack-openwrt-feed/apps/node-red/files/gui')) return;
        guiChecks += 1;
        if (guiChecks !== 5) return;
        raced = true;
        const held = `${heldPath}.held`;
        await rename(heldPath, held);
        await cp(held, heldPath, { recursive: true, preserveTimestamps: true });
      },
    });
    armed = true;
    await expect(verifyFirmwareArtifact(fixture.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
    expect(raced).toBe(true);
  }, 30_000);

  it.each([
    ['state-root parent', (fixture: RootfsFixture) => join(fixture.statePath, '..')],
    ['configured-state ancestor', (fixture: RootfsFixture) => fixture.authorityBase],
  ] as const)(
    'rejects a same-inode %s rename followed by a symlink at the original name',
    async (_label, selectAncestor) => {
      let armed = false;
      let raced = false;
      let ancestor = '';
      let held = '';
      let statePath = '';
      let expectedStateDevice = 0;
      let expectedStateInode = 0;
      let stateRootIdentityUnchanged = false;
      const fixture = await createRootfsFixture('rpi-5', {
        beforeDirectoryAccess: async () => {
          if (!armed || raced) return;
          raced = true;
          held = `${ancestor}.held`;
          await rename(ancestor, held);
          await symlink(held, ancestor);
          const observedState = await lstat(statePath);
          stateRootIdentityUnchanged = observedState.dev === expectedStateDevice
            && observedState.ino === expectedStateInode;
        },
      });
      ancestor = selectAncestor(fixture);
      statePath = fixture.statePath;
      const expectedState = await lstat(statePath);
      expectedStateDevice = expectedState.dev;
      expectedStateInode = expectedState.ino;
      armed = true;
      try {
        await expect(verifyFirmwareArtifact(fixture.input)).rejects.toMatchObject({
          code: 'ROOTFS_CONTENT_FAILED',
        });
        expect(raced).toBe(true);
        expect(stateRootIdentityUnchanged).toBe(true);
      } finally {
        if (raced) {
          await unlink(ancestor);
          await rename(held, ancestor);
        }
      }
    },
    30_000,
  );

  it('rejects a same-inode absolute ancestor swap at the freshness socket boundary', async () => {
    let armed = false;
    let raced = false;
    let ancestor = '';
    let held = '';
    let statePath = '';
    let expectedStateDevice = 0;
    let expectedStateInode = 0;
    let stateRootIdentityUnchanged = false;
    const authority = await authorityFixture({
      beforeDirectoryAccess: async () => {
        if (!armed || raced) return;
        raced = true;
        held = `${ancestor}.held`;
        await rename(ancestor, held);
        await symlink(held, ancestor);
        const observedState = await lstat(statePath);
        stateRootIdentityUnchanged = observedState.dev === expectedStateDevice
          && observedState.ino === expectedStateInode;
      },
    });
    const socketPath = join(authority.statePath, 'api.sock');
    const server = createServer((socket) => {
      socket.resume();
      socket.once('end', () => {
        socket.end('{"schemaVersion":1,"accepted":true}\n');
      });
    });
    await listen(server, socketPath);
    await chmod(socketPath, 0o600);
    cleanupFunctions.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    ancestor = join(authority.statePath, '..');
    statePath = authority.statePath;
    const expectedState = await lstat(statePath);
    expectedStateDevice = expectedState.dev;
    expectedStateInode = expectedState.ino;
    armed = true;
    try {
      await expect(
        createApiFreshnessSocketClient(authority.workspace.stateRoot).signal('job-verify'),
      ).rejects.toThrow(/binding|ancestor/u);
      expect(raced).toBe(true);
      expect(stateRootIdentityUnchanged).toBe(true);
    } finally {
      if (raced) {
        await unlink(ancestor);
        await rename(held, ancestor);
      }
    }
  }, 30_000);
});
