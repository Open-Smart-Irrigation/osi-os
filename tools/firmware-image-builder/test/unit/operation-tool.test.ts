import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TargetManifest } from '../../manifest/schema.js';
import { createNodeVerifier } from '../../runner/src/main.js';
import type { PipelineOperationExecution } from '../../runner/src/pipeline.js';

const operationToolPath = new URL(
  '../../builder/operations/osi-image-builder-tool.js',
  import.meta.url,
).pathname;
const thirdPartyPackages = [
  '@grpc/grpc-js',
  '@chirpstack/chirpstack-api',
  'google-protobuf',
  'protobufjs',
] as const;
const relativeHelpers = [
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
const packages = [...thirdPartyPackages, ...relativeHelpers] as const;
const direct = [
  'osi-command-ledger',
  'osi-dendro-analytics',
  'osi-zone-env',
  'osi-history-router',
  'osi-journal',
  'osi-device-writer',
  'osi-uc512-normalize',
  'osi-lsn50-normalize',
] as const;
const shippedNodeRedPath = new URL(
  '../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/',
  import.meta.url,
).pathname;
const temporaryRoots: string[] = [];

type OperationResult = Readonly<{
  operation: 'verify-image';
  targetId: 'rpi-5';
  relativePath: string;
  size: number;
  sha256: string;
  nodeResolution: readonly Readonly<{
    packageName: string;
    specifier: string;
    resolvedRelativePath: string;
    exportType: 'function' | 'object' | 'incompatible';
  }>[];
}>;

async function runOperation(
  overrides: Readonly<Record<string, string>> = {},
): Promise<OperationResult> {
  const root = await mkdtemp(join(tmpdir(), 'osi-operation-tool-modules-'));
  temporaryRoots.push(root);
  const nodeRed = join(
    root,
    'openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx/usr/share/node-red',
  );
  const image = join(root, 'openwrt/bin/targets/bcm27xx/bcm2712/image.img.gz');
  await mkdir(join(root, 'openwrt/bin/targets/bcm27xx/bcm2712'), { recursive: true });
  await mkdir(join(nodeRed, 'node_modules'), { recursive: true });
  await writeFile(
    join(root, 'openwrt/.config'),
    'CONFIG_TARGET_PROFILE="DEVICE_rpi-5"\n',
  );
  await writeFile(image, '');
  await truncate(image, 64 * 1024 * 1024);
  for (const [index, packageName] of [...packages, ...direct].entries()) {
    const packageRoot = packages.includes(packageName as typeof packages[number])
      ? join(nodeRed, 'node_modules', packageName)
      : join(nodeRed, packageName);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: packageName, main: 'index.js' }),
    );
    await writeFile(
      join(packageRoot, 'index.js'),
      overrides[packageName]
        ?? (index % 2 === 0
          ? 'module.exports = { compatible: true };\n'
          : 'module.exports = function compatible() {};\n'),
    );
  }
  const chirpstackEntrypoint = join(
    nodeRed,
    'node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js',
  );
  await mkdir(join(chirpstackEntrypoint, '..'), { recursive: true });
  await writeFile(
    chirpstackEntrypoint,
    overrides['@chirpstack/chirpstack-api']
      ?? 'module.exports = function compatible() {};\n',
  );
  const module = await import(operationToolPath) as {
    createOperationHandlersForTesting(rootPath: string): {
      verifyImage(): Promise<OperationResult>;
    };
  };
  return module.createOperationHandlersForTesting(root).verifyImage();
}

async function runProbeWithFakeChildren(
  fakeChild: (binary: string, args: string[], options: Record<string, unknown>) => unknown,
) {
  const module = await import(operationToolPath) as {
    runModuleProbeForTesting(
      rootfs: string,
      dependencies: { nodeBinary: string; probeProgram: string },
      spawn: typeof fakeChild,
    ): readonly Readonly<Record<string, unknown>>[];
  };
  return module.runModuleProbeForTesting(
    '/rootfs/usr/share/node-red',
    { nodeBinary: '/usr/local/bin/node', probeProgram: '/probe.js' },
    fakeChild,
  );
}

async function runShippedOperation(options: Readonly<{
  dbHelperPrefix?: string;
  hostDependency?: string;
  productionThirdParty?: boolean;
}> = {}): Promise<Readonly<{
  nodeRed: string;
  result: OperationResult;
}>> {
  const base = await mkdtemp(join(tmpdir(), 'osi-operation-tool-shipped-'));
  temporaryRoots.push(base);
  const root = join(base, 'workspace');
  const nodeRed = join(
    root,
    'openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx/usr/share/node-red',
  );
  const image = join(root, 'openwrt/bin/targets/bcm27xx/bcm2712/image.img.gz');
  await mkdir(join(root, 'openwrt/bin/targets/bcm27xx/bcm2712'), { recursive: true });
  await mkdir(join(nodeRed, 'node_modules'), { recursive: true });
  await writeFile(
    join(root, 'openwrt/.config'),
    'CONFIG_TARGET_PROFILE="DEVICE_rpi-5"\n',
  );
  await writeFile(image, '');
  await truncate(image, 64 * 1024 * 1024);

  if (options.productionThirdParty) {
    await cp(
      join(shippedNodeRedPath, 'node_modules'),
      join(nodeRed, 'node_modules'),
      { recursive: true },
    );
    for (const helper of relativeHelpers) {
      await rm(join(nodeRed, 'node_modules', helper), { force: true, recursive: true });
    }
  } else {
    for (const [index, packageName] of thirdPartyPackages.entries()) {
      const packageRoot = join(nodeRed, 'node_modules', packageName);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({ name: packageName, main: 'index.js' }),
      );
      await writeFile(
        join(packageRoot, 'index.js'),
        index % 2 === 0
          ? 'module.exports = { compatible: true };\n'
          : 'module.exports = function compatible() {};\n',
      );
    }
    for (const path of [
      'api/application_grpc_pb',
      'api/application_pb',
      'api/device_grpc_pb',
      'api/device_pb',
      'api/device_profile_grpc_pb',
      'api/device_profile_pb',
      'api/gateway_grpc_pb',
      'api/gateway_pb',
      'api/tenant_grpc_pb',
      'api/tenant_pb',
      'common/common_pb',
    ]) {
      const file = join(nodeRed, 'node_modules/@chirpstack/chirpstack-api', `${path}.js`);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'module.exports = {};\n');
    }
  }
  for (const helper of [...relativeHelpers, ...direct]) {
    await cp(join(shippedNodeRedPath, helper), join(nodeRed, helper), { recursive: true });
  }
  for (const helper of relativeHelpers) {
    await symlink(`../${helper}`, join(nodeRed, 'node_modules', helper));
  }
  if (options.dbHelperPrefix !== undefined) {
    const dbHelper = join(nodeRed, 'osi-db-helper/index.js');
    await writeFile(
      dbHelper,
      `${options.dbHelperPrefix}\n${await readFile(dbHelper, 'utf8')}`,
    );
  }
  if (options.hostDependency !== undefined) {
    const hostPackage = join(base, 'node_modules', options.hostDependency);
    await mkdir(hostPackage, { recursive: true });
    await writeFile(
      join(hostPackage, 'package.json'),
      JSON.stringify({ name: options.hostDependency, main: 'index.js' }),
    );
    await writeFile(join(hostPackage, 'index.js'), 'module.exports = { host: true };\n');
  }

  const module = await import(operationToolPath) as {
    createOperationHandlersForTesting(rootPath: string): {
      verifyImage(): Promise<OperationResult>;
    };
  };
  return {
    nodeRed,
    result: await module.createOperationHandlersForTesting(root).verifyImage(),
  };
}

function trustedExecution(result: unknown): PipelineOperationExecution {
  return {
    operationId: 'verify-image',
    attempt: 1,
    outcome: 'passed',
    command: {
      argv: ['node', '/opt/osi-image-builder/operations/osi-image-builder-tool.js', 'verify-image'],
      startedAt: '2026-07-27T00:00:00.000Z',
      finishedAt: '2026-07-27T00:00:01.000Z',
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputLimit: false,
    },
    observations: {
      stdout: `${JSON.stringify(result)}\n`,
      stderr: '',
    },
  };
}

const target = { id: 'rpi-5' } as TargetManifest;
const request = {
  targetId: 'rpi-5' as const,
  modules: [
    ...packages.map((packageName) => ({ packageName, specifier: packageName })),
    ...direct.map((packageName) => ({ packageName, specifier: `./${packageName}` })),
  ],
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('trusted verify-image Node compatibility record', () => {
  it('loads the exact shipped third-party versions and actual helper entrypoints', async () => {
    const { nodeRed, result } = await runShippedOperation({
      productionThirdParty: true,
    });
    const expectedVersions = new Map([
      ['@grpc/grpc-js', '1.14.3'],
      ['@chirpstack/chirpstack-api', '4.12.1'],
      ['google-protobuf', '3.21.4'],
      ['protobufjs', '7.5.4'],
    ]);
    for (const [packageName, version] of expectedVersions) {
      const manifest = JSON.parse(await readFile(
        join(nodeRed, 'node_modules', packageName, 'package.json'),
        'utf8',
      )) as { version?: unknown };
      expect(manifest.version).toBe(version);
      expect(result.nodeResolution.find((record) => record.packageName === packageName))
        .toMatchObject({ packageName, exportType: 'object' });
    }
    expect(result.nodeResolution.find(
      ({ packageName }) => packageName === '@chirpstack/chirpstack-api',
    )).toMatchObject({
      resolvedRelativePath:
        'node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js',
    });
    expect(result.nodeResolution.filter(
      ({ packageName }) => packageName.startsWith('osi-'),
    )).toHaveLength(17);
  });

  it('loads the actual shipped helper entrypoints through only the sealed sqlite3 initializer stub', async () => {
    const nodePath = process.env.NODE_PATH;
    const { nodeRed, result } = await runShippedOperation({
      dbHelperPrefix: [
        "const initializerStub = require('sqlite3');",
        "if (Object.keys(initializerStub).sort().join(',') !== 'Database,OPEN_CREATE,OPEN_READONLY,OPEN_READWRITE') throw new Error('sqlite3 initializer stub is not minimal');",
      ].join('\n'),
    });
    expect(result.nodeResolution).toHaveLength(21);
    expect(result.nodeResolution.find(({ packageName }) => packageName === 'osi-db-helper'))
      .toEqual({
        packageName: 'osi-db-helper',
        specifier: 'osi-db-helper',
        resolvedRelativePath: 'node_modules/osi-db-helper/index.js',
        exportType: 'object',
      });
    await expect(access(join(nodeRed, 'node_modules/sqlite3'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(process.env.NODE_PATH).toBe(nodePath);
  });

  it('fails closed for a missing dependency outside the immutable native stub allowlist', async () => {
    await expect(runShippedOperation({
      dbHelperPrefix: "require('unknown-target-native-dependency');",
    })).rejects.toThrow(/unknown-target-native-dependency/u);
  });

  it('rejects child_process execution before an injected helper can mutate the host', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-exec-marker-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'executed');
    await expect(runShippedOperation({
      dbHelperPrefix: [
        "const childProcess = require('child_process');",
        `childProcess.execFileSync(process.execPath, ['-e', ${JSON.stringify(
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`,
        )}]);`,
      ].join('\n'),
    })).rejects.toThrow(/unapproved builder builtin: child_process/u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects fs mutation before an injected helper can write a file', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-fs-marker-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'written');
    await expect(runShippedOperation({
      dbHelperPrefix:
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'written');`,
    })).rejects.toThrow(/filesystem capability|writeFileSync/u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('denies process.getBuiltinModule filesystem writes inside the rootfs', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-builtin-fs-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'written');
    await expect(runShippedOperation({
      dbHelperPrefix: [
        "const builtinFs = process.getBuiltinModule('fs');",
        `builtinFs.writeFileSync(${JSON.stringify(marker)}, 'written');`,
      ].join('\n'),
    })).rejects.toThrow(/ERR_ACCESS_DENIED|FileSystemWrite|permission/u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('denies process.getBuiltinModule writes to the extracted rootfs', async () => {
    await expect(runShippedOperation({
      dbHelperPrefix: [
        "const builtinFs = process.getBuiltinModule('fs');",
        "builtinFs.writeFileSync(`${__dirname}/written`, 'written');",
      ].join('\n'),
    })).rejects.toThrow(/ERR_ACCESS_DENIED|FileSystemWrite|permission/u);
    const fixtureRoot = temporaryRoots.at(-1);
    expect(fixtureRoot).toBeDefined();
    await expect(access(join(
      fixtureRoot!,
      'workspace/openwrt/build_dir/target-aarch64_cortex-a76_musl/root-bcm27xx',
      'usr/share/node-red/osi-db-helper/written',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('denies process.getBuiltinModule child processes before they can mutate the host', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-builtin-child-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'spawned');
    await expect(runShippedOperation({
      dbHelperPrefix: [
        "const builtinChildProcess = process.getBuiltinModule('child_process');",
        `builtinChildProcess.spawnSync(process.execPath, ['-e', ${JSON.stringify(
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`,
        )}]);`,
      ].join('\n'),
    })).rejects.toThrow(/ERR_ACCESS_DENIED|ChildProcess|permission/u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('denies process.getBuiltinModule node:sqlite before it can create a host database', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-builtin-sqlite-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'marker.db');
    await expect(runShippedOperation({
      dbHelperPrefix: [
        "const builtinSqlite = process.getBuiltinModule('node:sqlite');",
        `const markerDatabase = new builtinSqlite.DatabaseSync(${JSON.stringify(marker)});`,
        "markerDatabase.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');",
        'markerDatabase.close();',
      ].join('\n'),
    })).rejects.toThrow(/unapproved builder builtin: node:sqlite/u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('denies dynamic import of node:sqlite before it can create a host database', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-import-sqlite-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'marker.db');
    await expect(runShippedOperation({
      dbHelperPrefix: [
        "void import('node:sqlite').then(({ DatabaseSync }) => {",
        `  const markerDatabase = new DatabaseSync(${JSON.stringify(marker)});`,
        "  markerDatabase.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');",
        '  markerDatabase.close();',
        '}).catch(() => {});',
      ].join('\n'),
    })).rejects.toThrow(/unapproved builder ESM builtin: node:sqlite/u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed for a computed dynamic import even when rootfs code catches it', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-computed-import-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'marker.db');
    await expect(runShippedOperation({
      dbHelperPrefix: [
        "void import(['node', 'sqlite'].join(':')).then(({ DatabaseSync }) => {",
        `  const markerDatabase = new DatabaseSync(${JSON.stringify(marker)});`,
        "  markerDatabase.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');",
        '  markerDatabase.close();',
        '}).catch(() => {});',
      ].join('\n'),
    })).rejects.toThrow(/unapproved builder ESM builtin: node:sqlite/u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits through a Promise-deferred caught dynamic import before succeeding', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-deferred-import-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'marker.db');
    await expect(runShippedOperation({
      dbHelperPrefix: [
        "void Promise.resolve().then(() => import(['node', 'sqlite'].join(':')).catch(() => {}));",
        `void ${JSON.stringify(marker)};`,
      ].join('\n'),
    })).rejects.toThrow(/unapproved builder ESM builtin: node:sqlite/u);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exits before a retained timer callback can poison the host', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'osi-operation-tool-delayed-timer-'));
    temporaryRoots.push(markerRoot);
    const marker = join(markerRoot, 'marker');
    const started = Date.now();
    await runShippedOperation({
      dbHelperPrefix: [
        `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'); throw new Error('late timer ran'); }, 250);`,
        "process.once('beforeExit', () => { throw new Error('beforeExit emitted'); });",
      ].join('\n'),
    });
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates a mutated extension loader from every other package child', async () => {
    await runOperation({
      '@grpc/grpc-js': [
        "require.extensions['.js'] = function poisonedLoader(module) { module.exports = { poisoned: true }; };",
        'module.exports = { compatible: true };',
      ].join('\n'),
    });
    const result = await runOperation();
    expect(result.nodeResolution).toHaveLength(21);
  });

  it('restores per-package cache state so a later shipped entrypoint cannot be poisoned', async () => {
    const result = await runOperation({
      '@grpc/grpc-js': [
        "const future = require.resolve('@chirpstack/chirpstack-api');",
        "require.cache[future] = { exports: { poisoned: true }, loaded: true };",
        'module.exports = { compatible: true };',
      ].join('\n'),
    });
    expect(result.nodeResolution.find(({ packageName }) => packageName === '@chirpstack/chirpstack-api'))
      .toMatchObject({ exportType: 'function' });
  });

  it('isolates Module.prototype.require mutation from every other package child', async () => {
    await runOperation({
      '@grpc/grpc-js': [
        "module.constructor.prototype.require = function poisonedRequire() { return { poisoned: true }; };",
        'module.exports = { compatible: true };',
      ].join('\n'),
    });
    const result = await runOperation();
    expect(result.nodeResolution).toHaveLength(21);
  });

  it('seals process.getBuiltinModule while preserving approved harmless builtins', async () => {
    const { result } = await runShippedOperation({
      dbHelperPrefix: [
        "const builtinDescriptor = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule');",
        "if (builtinDescriptor.writable !== false || builtinDescriptor.configurable !== false) throw new Error('getBuiltinModule is mutable');",
        "const builtinCrypto = process.getBuiltinModule('node:crypto');",
        "if (typeof builtinCrypto.createHash !== 'function') throw new Error('approved builtin unavailable');",
      ].join('\n'),
    });
    expect(result.nodeResolution.find(({ packageName }) => packageName === 'osi-db-helper'))
      .toMatchObject({ exportType: 'object' });
  });

  it('does not allow a target helper to select a dependency from the builder host tree', async () => {
    await expect(runShippedOperation({
      dbHelperPrefix: "require('host-only-target-dependency');",
      hostDependency: 'host-only-target-dependency',
    })).rejects.toThrow(/FileSystemRead|outside the trusted rootfs|permission/u);
  });

  it('records object, function, and incompatible exports from target execution', async () => {
    const result = await runOperation({
      protobufjs: 'module.exports = 7;\n',
    });
    expect(result.nodeResolution.find(({ packageName }) => packageName === 'protobufjs'))
      .toMatchObject({ exportType: 'incompatible' });
    expect(result.nodeResolution.some(({ exportType }) => exportType === 'object')).toBe(true);
    expect(result.nodeResolution.some(({ exportType }) => exportType === 'function')).toBe(true);

    const resolved = await createNodeVerifier(target, () => trustedExecution(result))
      .resolve(request);
    expect(resolved.modules.find(({ packageName }) => packageName === 'protobufjs'))
      .toMatchObject({ exportType: 'incompatible' });
  });

  it('launches exactly one child per fixed package in fixed order', async () => {
    const calls: Array<{ binary: string; args: string[]; options: Record<string, unknown> }> = [];
    const thirdParty = [
      '@grpc/grpc-js',
      '@chirpstack/chirpstack-api',
      'google-protobuf',
      'protobufjs',
    ];
    const relative = [
      'osi-chameleon-helper',
      'osi-chirpstack-helper',
      'osi-cloud-http',
      'osi-db-helper',
      'osi-dendro-helper',
      'osi-health-helper',
      'osi-history-helper',
      'osi-history-sync-helper',
      'osi-lib',
    ];
    const direct = [
      'osi-command-ledger',
      'osi-dendro-analytics',
      'osi-zone-env',
      'osi-history-router',
      'osi-journal',
      'osi-device-writer',
      'osi-uc512-normalize',
      'osi-lsn50-normalize',
    ];
    const all = [...thirdParty, ...relative, ...direct];
    const result = await runProbeWithFakeChildren((binary, args, options) => {
      calls.push({ binary, args, options });
      const index = Number(args.at(-1));
      const packageName = all[index]!;
      const specifier = index < 13 ? packageName : `./${packageName}`;
      const resolvedRelativePath = index === 1
        ? 'node_modules/@chirpstack/chirpstack-api/api/application_grpc_pb.js'
        : index < 13
          ? `node_modules/${packageName}/index.js`
          : `${packageName}/index.js`;
      return {
        error: null,
        status: 0,
        signal: null,
        stderr: '',
        stdout: `${JSON.stringify({
          packageIndex: index,
          packageName,
          specifier,
          resolvedRelativePath,
          exportType: index % 2 === 0 ? 'object' : 'function',
        })}\n`,
      };
    });
    expect(calls).toHaveLength(21);
    expect(calls.map(({ args }) => Number(args.at(-1)))).toEqual(all.map((_, index) => index));
    for (const [index, call] of calls.entries()) {
      expect(call.binary).toBe('/usr/local/bin/node');
      expect(call.args).toEqual([
        '--experimental-vm-modules',
        '--permission',
        '--allow-fs-read=/probe.js',
        '--allow-fs-read=/rootfs/usr/share/node-red',
        '/probe.js',
        '--rootfs-node-red',
        '/rootfs/usr/share/node-red',
        '--package-index',
        String(index),
      ]);
      expect(call.options).toMatchObject({
        cwd: '/',
        encoding: 'utf8',
        timeout: 15_000,
        killSignal: 'SIGKILL',
        maxBuffer: 8 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      });
    }
    expect(result.map(({ packageName }) => packageName)).toEqual(all);
  });

  it.each([
    ['timeout', () => ({ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGKILL', stdout: '', stderr: '' }), /timed out/u],
    ['malformed result', () => ({ error: null, status: 0, signal: null, stdout: 'not-json\n', stderr: '' }), /not JSON/u],
    ['mismatched result', () => ({ error: null, status: 0, signal: null, stdout: `${JSON.stringify({ packageIndex: 1, packageName: 'wrong', specifier: 'wrong', resolvedRelativePath: 'node_modules/@grpc/grpc-js/index.js', exportType: 'object' })}\n`, stderr: '' }), /binding changed/u],
  ])('rejects a child %s', async (_name, child, expected) => {
    await expect(runProbeWithFakeChildren(child)).rejects.toThrow(expected);
  });

  it('does not carry nested Module static mutations from package N into package N+1', async () => {
    const result = await runOperation({
      '@grpc/grpc-js': [
        "module.constructor._pathCache = { poisoned: true };",
        "module.constructor.globalPaths = ['/poisoned'];",
        'module.exports = { compatible: true };',
      ].join('\n'),
      '@chirpstack/chirpstack-api': [
        "if (Object.hasOwn(module.constructor._pathCache, 'poisoned') || module.constructor.globalPaths.includes('/poisoned')) throw new Error('cross-child Module state leaked');",
        'module.exports = { compatible: true };',
      ].join('\n'),
    });
    expect(result.nodeResolution).toHaveLength(21);
  });

  it.each([
    ['unknown result key', (value: Record<string, unknown>) => {
      value.unknown = true;
    }],
    ['missing module', (value: Record<string, unknown>) => {
      (value.nodeResolution as unknown[]).pop();
    }],
    ['duplicate module', (value: Record<string, unknown>) => {
      const modules = value.nodeResolution as Record<string, unknown>[];
      modules[1] = { ...modules[0] };
    }],
    ['module path escape', (value: Record<string, unknown>) => {
      const modules = value.nodeResolution as Record<string, unknown>[];
      modules[0] = { ...modules[0], resolvedRelativePath: '../outside.js' };
    }],
    ['wrong package root', (value: Record<string, unknown>) => {
      const modules = value.nodeResolution as Record<string, unknown>[];
      modules[0] = { ...modules[0], resolvedRelativePath: 'node_modules/protobufjs/index.js' };
    }],
    ['unknown module key', (value: Record<string, unknown>) => {
      const modules = value.nodeResolution as Record<string, unknown>[];
      modules[0] = { ...modules[0], unknown: true };
    }],
    ['reordered module keys', (value: Record<string, unknown>) => {
      const modules = value.nodeResolution as Record<string, unknown>[];
      const first = modules[0]!;
      modules[0] = {
        exportType: first.exportType,
        packageName: first.packageName,
        specifier: first.specifier,
        resolvedRelativePath: first.resolvedRelativePath,
      };
    }],
  ])('rejects %s', async (_name, mutate) => {
    const produced = await runOperation();
    const candidate = JSON.parse(JSON.stringify(produced)) as Record<string, unknown>;
    mutate(candidate);
    await expect(createNodeVerifier(target, () => trustedExecution(candidate)).resolve(request))
      .rejects.toThrow(/trusted verify-image|resolved rootfs Node module/i);
  });
});
