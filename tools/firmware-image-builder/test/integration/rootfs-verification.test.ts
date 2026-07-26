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
import { openBuilderDatabase } from '../../api/src/store-schema.js';
import { OwnershipStore } from '../../api/src/ownership.js';
import {
  handleApiFreshnessSignal,
} from '../../api/src/freshness-protocol.js';
import { loadManifest } from '../../manifest/validate.js';
import type { TargetManifest } from '../../manifest/schema.js';
import {
  verifyFirmwareArtifact,
  type RootfsNodeResolutionRequest,
  type VerificationInput,
  type WorkspaceAuthority,
} from '../../runner/src/verification.js';
import {
  createApiFreshnessSocketClient,
  requestPersistedFreshness,
} from '../../runner/src/freshness.js';

const SHA40 = '0123456789abcdef0123456789abcdef01234567';
const ADVANCED_SHA40 = 'fedcba9876543210fedcba9876543210fedcba98';
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
SRC=/usr/share/node-red
DST=/srv/node-red
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
`;
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
  readonly statePath: string;
  readonly sourcePath: string;
  readonly artifactDirectory: string;
  readonly artifactPath: string;
  readonly artifactName: string;
  readonly rootfsPath: string;
  readonly target: TargetManifest;
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
    await writeFile(
      join(targetSetupEvidence, `${profile.id}.source.config`),
      configFor(profile),
    );
    const profileConfigPath = join(sourcePath, 'conf', profile.environment, '.config');
    await mkdir(join(profileConfigPath, '..'), { recursive: true });
    await writeFile(profileConfigPath, resolvedConfigs[profile.id]);
  }

  const sourceProfileRoot = join(sourcePath, 'conf', target.environment, 'files');
  const sourceFlows = join(sourceProfileRoot, 'usr/share/flows.json');
  const sourceDatabase = join(sourceProfileRoot, 'usr/share/db/farming.db');
  const feedGui = join(sourcePath, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui');
  await mkdir(join(sourceFlows, '..'), { recursive: true });
  await mkdir(join(sourceDatabase, '..'), { recursive: true });
  await mkdir(feedGui, { recursive: true });
  await writeFile(sourceFlows, '{"flow":true}\n');
  const sourceDb = new DatabaseSync(sourceDatabase);
  sourceDb.exec('CREATE TABLE chameleon_calibrations (array_id TEXT PRIMARY KEY)');
  sourceDb.close();
  await writeFile(join(feedGui, 'index.html'), '<html><head><title>OSI Gateway</title></head><body>gui</body></html>\n');

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
  await writeRootfs('etc/nginx/conf.d/osi.conf', [
    'location /gui/ {}',
    'location /auth/ {}',
    'location /api/ {}',
    'location /download/ {}',
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
      resolvedSha256: sha256(resolvedConfigs[profile.id]),
    }];
  })) as VerificationInput['config']['profiles'];
  await writeFile(
    join(targetSetupEvidence, '..', '04-target-setup.json'),
    JSON.stringify({
      schemaVersion: 1,
      jobId: authority.workspace.jobId,
      stage: 'target-setup',
      outcome: 'passed',
      observations: {
        config: { profiles },
      },
    }),
  );
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
    config: {
      selectedTarget: target.openwrtTarget,
      profile: target.profile,
      rootfsPartSize: target.rootfsPartSize,
      bothProfilesChecked: true,
      profiles,
    },
    pinnedSha: SHA40,
    branch: 'main',
    nodeVerifier: {
      resolve: async (request: RootfsNodeResolutionRequest) => {
        const nodeRed = join(rootfsPath, 'usr/share/node-red');
        const require = createRequire(join(nodeRed, '__osi_verification__.cjs'));
        return {
          targetId: request.targetId,
          modules: request.modules.map(({ packageName, specifier }) => {
            const resolved = require.resolve(specifier);
            const loaded = require(resolved) as unknown;
            return {
              packageName,
              resolvedRelativePath: relative(nodeRed, resolved).replaceAll('\\', '/'),
              exportType: typeof loaded === 'function'
                ? 'function' as const
                : loaded !== null && typeof loaded === 'object'
                  ? 'object' as const
                  : 'incompatible' as const,
            };
          }),
        };
      },
    },
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
    const result = await verifyFirmwareArtifact(fixture.input);

    expect(result.artifact.path).toBe(`openwrt/bin/targets/${fixture.target.openwrtTarget}/${fixture.artifactName}`);
    expect(result.rootfs.helpers.relativeSymlinks).toEqual(RELATIVE_HELPERS);
    expect(result.rootfs.helpers.directUntilFirstBoot).toEqual(DIRECT_HELPERS);
    expect(result.rootfs.helpers.firstBootSeedVerified).toBe(true);
    expect(result.rootfs.nodeResolution.protobufjs).toBe(true);
    expect(result.rootfs.database).toEqual({ integrityCheck: 'ok', chameleonCalibrationRows: 0 });
    expect(result.config.profiles['rpi-5'].sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.config.profiles['rpi-2'].resolvedSha256).toMatch(/^[0-9a-f]{64}$/u);
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
      await writeFile(
        join(sourceTamper.statePath, 'jobs/job-verify/evidence/04-target-setup.json'),
        JSON.stringify({
          schemaVersion: 1,
          jobId: 'job-verify',
          stage: 'target-setup',
          outcome: 'passed',
          observations: { config: { profiles: sourceProfiles } },
        }),
      );
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
      await writeFile(
        join(resolvedTamper.statePath, 'jobs/job-verify/evidence/04-target-setup.json'),
        JSON.stringify({
          schemaVersion: 1,
          jobId: 'job-verify',
          stage: 'target-setup',
          outcome: 'passed',
          observations: { config: { profiles: resolvedProfiles } },
        }),
      );
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

    const incompatible = await createRootfsFixture('rpi-2');
    await writeFile(
      join(incompatible.rootfsPath, 'usr/share/node-red/osi-command-ledger/index.js'),
      'module.exports = 7;\n',
    );
    await expect(verifyFirmwareArtifact(incompatible.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });
  }, 30_000);

  it('requires active exact nginx locations and exact first-boot source/destination actions', async () => {
    const commentedNginx = await createRootfsFixture('rpi-5');
    await writeFile(
      join(commentedNginx.rootfsPath, 'etc/nginx/conf.d/osi.conf'),
      [
        '# location /gui/ {}',
        'location /auth/ {}',
        'location /api/ {}',
        'location /download/ {}',
      ].join('\n'),
    );
    await expect(verifyFirmwareArtifact(commentedNginx.input)).rejects.toMatchObject({
      code: 'ROOTFS_CONTENT_FAILED',
    });

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
        targetId: 'rpi-5',
        rootId: 'images',
        targetManifestSha256: 'e'.repeat(64),
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
});
