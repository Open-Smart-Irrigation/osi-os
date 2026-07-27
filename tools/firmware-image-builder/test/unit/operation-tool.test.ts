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
  const module = await import(operationToolPath) as {
    createOperationHandlersForTesting(rootPath: string): {
      verifyImage(): Promise<OperationResult>;
    };
  };
  return module.createOperationHandlersForTesting(root).verifyImage();
}

async function runShippedOperation(options: Readonly<{
  dbHelperPrefix?: string;
  hostDependency?: string;
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

  it('does not allow a target helper to select a dependency from the builder host tree', async () => {
    await expect(runShippedOperation({
      dbHelperPrefix: "require('host-only-target-dependency');",
      hostDependency: 'host-only-target-dependency',
    })).rejects.toThrow(/outside the trusted rootfs/u);
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
