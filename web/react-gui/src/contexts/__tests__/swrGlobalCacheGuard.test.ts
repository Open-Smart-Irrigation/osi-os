// #378: SWR's process-global `mutate`, `cache` and `preload` act on the
// default cache, not on the per-session cache that AuthSessionDataBoundary
// installs. A call through them either reaches across sessions or silently
// misses the cache the app renders from. Use `useSWRConfig().mutate` or the
// bound `mutate` a hook returns.
import { describe, expect, it } from 'vitest';

const SOURCES: Record<string, string> = {
  ...import.meta.glob<string>(['../../**/*.{ts,tsx,js,jsx,mjs}', '!../../**/__tests__/**'], {
    eager: true,
    import: 'default',
    query: '?raw',
  }),
  ...import.meta.glob<string>(['../../../demo/**/*.{ts,tsx,js,jsx,mjs}', '!../../../demo/tests/**'], {
    eager: true,
    import: 'default',
    query: '?raw',
  }),
};

const SWR_IMPORT = /import\s+([^;]*?)\s+from\s+['"](swr(?:\/[^'"]*)?)['"]/g;
const GLOBAL_NAMES: readonly string[] = ['mutate', 'cache', 'preload'];

function globalSwrImports(source: string): string[] {
  const findings: string[] = [];
  for (const match of source.matchAll(SWR_IMPORT)) {
    const [statement, clause, specifier] = match;
    if (specifier.startsWith('swr/_internal')) {
      findings.push(statement);
      continue;
    }
    if (/\*\s+as\s+\w+/.test(clause)) {
      findings.push(statement);
      continue;
    }
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    const importedNames = named
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
      .filter(Boolean);
    if (importedNames.some((name) => GLOBAL_NAMES.includes(name))) {
      findings.push(statement);
    }
  }
  return findings;
}

describe('SWR global cache guard (#378)', () => {
  it('scans the application and the simulator sources', () => {
    const files = Object.keys(SOURCES);
    expect(files.some((file) => file.endsWith('/journal/useDraftsQueue.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('/demo/runtime.ts'))).toBe(true);
  });

  it('recognises the forbidden import forms', () => {
    expect(globalSwrImports("import useSWR, { mutate as globalMutate } from 'swr';")).toHaveLength(1);
    expect(globalSwrImports("import {mutate} from 'swr';")).toHaveLength(1);
    expect(globalSwrImports("import * as swr from 'swr';")).toHaveLength(1);
    expect(globalSwrImports("import { cache } from 'swr/_internal';")).toHaveLength(1);
    expect(globalSwrImports("import useSWR, { useSWRConfig, type KeyedMutator } from 'swr';")).toHaveLength(0);
  });

  it('finds no import of the process-global mutate, cache or preload', () => {
    const offenders = Object.entries(SOURCES)
      .flatMap(([file, source]) => globalSwrImports(source).map((statement) => `${file}: ${statement}`));
    expect(offenders).toEqual([]);
  });
});
