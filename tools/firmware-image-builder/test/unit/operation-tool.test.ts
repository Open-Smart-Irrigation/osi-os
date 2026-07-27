import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
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
const packages = [
  '@grpc/grpc-js',
  '@chirpstack/chirpstack-api',
  'google-protobuf',
  'protobufjs',
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
