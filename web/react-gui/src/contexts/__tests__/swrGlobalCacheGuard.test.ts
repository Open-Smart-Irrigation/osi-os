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

const SWR_SPECIFIER = String.raw`['"]swr(?:\/[^'"]*)?['"]`;
// `import … from 'swr'` and `export … from 'swr'`, with or without spaces.
const SWR_STATIC = new RegExp(String.raw`\b(import|export)\b([^;]*?)\bfrom\s*(${SWR_SPECIFIER})`, 'g');
// `import('swr')` and `require('swr')` in any form.
const SWR_DYNAMIC = new RegExp(String.raw`\b(?:import|require)\s*\(\s*${SWR_SPECIFIER}`, 'g');
const GLOBAL_NAMES: readonly string[] = ['mutate', 'cache', 'preload'];

// SWRConfig.defaultValue exposes the default cache and its global mutate.
const SWR_DEFAULT_VALUE = /\bSWRConfig\s*\.\s*defaultValue\b/g;
// Only the session boundary may install a cache provider: a second one could
// return a module-level Map that outlives the session.
const SWR_PROVIDER = /\bprovider\s*:/;
const BOUNDARY_FILE = 'AuthSessionDataBoundary.tsx';

function globalSwrImports(source: string, file = ''): string[] {
  const findings: string[] = [];
  for (const match of source.matchAll(SWR_DYNAMIC)) findings.push(match[0]);
  for (const match of source.matchAll(SWR_DEFAULT_VALUE)) findings.push(match[0]);
  if (/\bSWRConfig\b/.test(source) && SWR_PROVIDER.test(source) && !file.endsWith(`/${BOUNDARY_FILE}`)) {
    findings.push('SWRConfig provider outside AuthSessionDataBoundary');
  }
  for (const match of source.matchAll(SWR_STATIC)) {
    const [statement, keyword, clause, specifier] = match;
    if (/swr\/_internal/.test(specifier)) {
      findings.push(statement);
      continue;
    }
    if (/\*/.test(clause)) {
      // `import * as swr` and `export * from 'swr'` expose the globals.
      findings.push(statement);
      continue;
    }
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
    const names = named
      .split(',')
      .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    if (names.some((name) => GLOBAL_NAMES.includes(name))) {
      findings.push(statement);
      continue;
    }
    if (keyword === 'export' && !named) findings.push(statement);
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
    expect(globalSwrImports("import{mutate}from'swr'")).toHaveLength(1);
    expect(globalSwrImports("export { mutate } from 'swr';")).toHaveLength(1);
    expect(globalSwrImports("export { mutate as refresh } from \"swr\";")).toHaveLength(1);
    expect(globalSwrImports("export * from 'swr';")).toHaveLength(1);
    expect(globalSwrImports("const swr = await import('swr');")).toHaveLength(1);
    expect(globalSwrImports("const { mutate } = require('swr');")).toHaveLength(1);
    expect(globalSwrImports("import {\n  cache,\n} from 'swr';")).toHaveLength(1);
    expect(globalSwrImports("import useSWR, { useSWRConfig, type KeyedMutator } from 'swr';")).toHaveLength(0);
    expect(globalSwrImports("import { SWRConfig, type SWRConfiguration } from 'swr';")).toHaveLength(0);
    expect(globalSwrImports('const { cache } = SWRConfig.defaultValue;')).toHaveLength(1);
    expect(globalSwrImports('<SWRConfig value={{ provider: () => shared }}>', 'src/pages/Other.tsx')).toHaveLength(1);
    expect(globalSwrImports('<SWRConfig value={{ provider: () => new Map() }}>', 'src/contexts/AuthSessionDataBoundary.tsx')).toHaveLength(0);
    expect(globalSwrImports("import type { Cache, Middleware, ScopedMutator } from 'swr';")).toHaveLength(0);
  });

  it('finds no import of the process-global mutate, cache or preload', () => {
    const offenders = Object.entries(SOURCES)
      .flatMap(([file, source]) => globalSwrImports(source, file).map((statement) => `${file}: ${statement}`));
    expect(offenders).toEqual([]);
  });
});
