import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

type PackageJson = Readonly<{ scripts?: Readonly<Record<string, string>> }>;

const packagePath = new URL('../../package.json', import.meta.url);
const installerPath = new URL('../../installer/install.ts', import.meta.url);

function referencedScripts(script: string): readonly string[] {
  return [...script.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/gu)].map((match) => match[1]!);
}

function reachableScripts(scripts: Readonly<Record<string, string>>, start: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const reference of referencedScripts(scripts[current] ?? '')) {
      if (!visited.has(reference)) pending.push(reference);
    }
  }
  return visited;
}

async function scripts(): Promise<Readonly<Record<string, string>>> {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as PackageJson;
  return packageJson.scripts ?? {};
}

describe('package script graph', () => {
  it('runs the Node gate, exactly one check, then installer core in that order', async () => {
    const packageScripts = await scripts();
    const outer = packageScripts['install:versioned'];
    expect(outer).toBeDefined();
    if (outer === undefined) return;

    expect(outer).toBe('node scripts/require-node22.mjs && npm run check && tsx installer/install.ts --core');
    expect(outer.match(/\bnpm\s+run\s+check\b/gu) ?? []).toHaveLength(1);
    expect(outer.indexOf('node scripts/require-node22.mjs')).toBeLessThan(outer.indexOf('npm run check'));
    expect(outer.indexOf('npm run check')).toBeLessThan(outer.indexOf('tsx installer/install.ts --core'));
  });

  it('keeps installer core free of npm and package-check recursion', async () => {
    const source = await readFile(installerPath, 'utf8');
    expect(source).not.toMatch(/\bnpm\b/iu);
    expect(source).not.toMatch(/\brun\s+check\b/iu);
  });

  it('does not let check directly or transitively invoke install:versioned', async () => {
    const packageScripts = await scripts();
    const check = packageScripts.check;
    expect(check).toBeDefined();
    if (check === undefined) return;
    expect(reachableScripts(packageScripts, 'check')).not.toContain('install:versioned');
  });
});
