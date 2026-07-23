import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// @ts-expect-error The executable gate is JavaScript by design; its runtime contract is tested below.
import { checkNodeVersion } from '../../scripts/require-node22.mjs';

const packagePath = new URL('../../package.json', import.meta.url);
const tsconfigPath = new URL('../../tsconfig.json', import.meta.url);
const vitestConfigPath = new URL('../../vitest.config.ts', import.meta.url);
const execFile = promisify(execFileCallback);

describe('toolchain contract', () => {
  it.each([
    ['22.4.9', 'NODE_VERSION_UNSUPPORTED'],
    ['22.5.0', undefined],
    ['23.0.0', undefined],
  ])('checks Node %s', (version, errorCode) => {
    expect(checkNodeVersion(version)).toEqual(errorCode ? { ok: false, errorCode } : { ok: true });
  });

  it('declares the initial package contract', async () => {
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      type?: string;
      scripts?: Record<string, string>;
    };
    const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8')) as {
      compilerOptions?: { strict?: boolean };
    };
    const vitestConfig = await readFile(vitestConfigPath, 'utf8');

    expect(packageJson.type).toBe('module');
    expect(tsconfig.compilerOptions?.strict).toBe(true);
    expect(packageJson.scripts).toEqual({
      'test:unit': expect.any(String),
      'test:integration': expect.any(String),
      'test:browser': expect.any(String),
    });
    expect(packageJson.scripts?.['test:unit']).toContain('require-node22.mjs');
    expect(packageJson.scripts?.['test:integration']).toContain('require-node22.mjs');
    expect(packageJson.scripts?.['test:browser']).toContain('require-node22.mjs');
    expect(packageJson.scripts?.['test:unit']).toContain('test/unit ui/src/__tests__');
    expect(packageJson.scripts?.['test:integration']).toContain('test/integration');
    expect(vitestConfig).toContain("'test/**/*.test.ts'");
    expect(vitestConfig).toContain("'ui/src/**/*.test.ts'");
    expect(vitestConfig).toContain("'ui/src/**/*.test.tsx'");
    expect(vitestConfig).toContain('fileParallelism: false');
    expect(vitestConfig).toContain('maxWorkers: 1');
    expect(vitestConfig).not.toContain('passWithNoTests');
    await expect(execFile(process.execPath, ['-e', "import('node:sqlite')"])).resolves.toBeDefined();
  });
});
