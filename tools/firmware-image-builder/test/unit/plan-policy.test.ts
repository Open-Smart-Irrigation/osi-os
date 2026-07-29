import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scanPlanPolicy } from '../../scripts/check-plan-policy.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'osi-builder-policy-'));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), contents, 'utf8');
  }
  return root;
}

describe('builder plan policy', () => {
  it('scans every required production source root by default', async () => {
    const result = await scanPlanPolicy();
    const requiredRoots = [
      'api/src',
      'builder',
      'cleanup-worker/src',
      'config',
      'domain',
      'installer',
      'manifest',
      'publisher',
      'runner/src',
      'scripts',
      'shared',
      'ui/src',
    ];

    for (const root of requiredRoots) {
      expect(result.files.some((path) => path.startsWith(`${root}/`)), `missing default policy root: ${root}`)
        .toBe(true);
    }
  });

  it('scans JavaScript and JSON execution surfaces in addition to TypeScript', async () => {
    const root = await fixture({
      'builder/operation.js': 'export const argv = ["docker", "--privileged"];',
      'builder/execution-definition.json': JSON.stringify({ mount: '/run/docker.sock' }),
      'builder/safe.ts': 'export const argv = ["docker", "version"];',
    });

    const result = await scanPlanPolicy({ packageRoot: root, sourceRoots: ['builder'] });

    expect(result.files).toEqual([
      'builder/execution-definition.json',
      'builder/operation.js',
      'builder/safe.ts',
    ]);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'DOCKER_SOCKET_MOUNT', path: 'builder/execution-definition.json' }),
      expect.objectContaining({ id: 'DOCKER_PRIVILEGE', path: 'builder/operation.js' }),
    ]));
  });

  it.each([
    ['dynamic shell', 'export const run = { shell: true };', 'DYNAMIC_SHELL_EXECUTION'],
    ['device access', 'export const argv = ["docker", "--device=/dev/sda"];', 'DOCKER_DEVICE'],
    ['production endpoint', 'export const host = "osicloud.ch";', 'PRODUCTION_ENDPOINT'],
    ['request output path', 'export const path = request.outputPath;', 'ARBITRARY_OUTPUT_PATH'],
  ])('rejects %s mutations', async (_name, contents, expectedRule) => {
    const root = await fixture({ 'api/src/mutation.ts': contents });

    const result = await scanPlanPolicy({ packageRoot: root, sourceRoots: ['api/src'] });

    expect(result.violations).toEqual([
      expect.objectContaining({ id: expectedRule, path: 'api/src/mutation.ts', line: 1 }),
    ]);
  });

  it('accepts trusted argv and approved root identifiers', async () => {
    const root = await fixture({
      'api/src/safe.ts': 'export const request = { outputRootId: "release" };',
      'builder/execution-definition.json': JSON.stringify({ argv: ['docker', 'create', '--cap-drop=ALL'] }),
    });

    await expect(scanPlanPolicy({ packageRoot: root, sourceRoots: ['api/src', 'builder'] }))
      .resolves.toMatchObject({ violations: [] });
  });
});
