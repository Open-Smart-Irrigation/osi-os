import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const GUI_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(GUI_ROOT, 'src');
const LOCALES_ROOT = path.join(GUI_ROOT, 'public/locales');
const LOCALES = ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt'];
const NEW_KEYS = ['history.export.open', 'history.export.title', 'history.desktop.railLabel'];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function usedHistoryKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/t\(\s*['"`](history\.[a-zA-Z0-9_.]+)['"`]/g)) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function localeKeys(locale: string): Set<string> {
  const file = path.join(LOCALES_ROOT, locale, 'history.json');
  return new Set(flattenKeys(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

describe('history locale key coverage', () => {
  it('defines every literal history.* key used in src in the en locale', () => {
    const defined = localeKeys('en');
    const missing = usedHistoryKeys().filter((key) => !defined.has(key));
    expect(missing).toEqual([]);
  });

  it('defines the export/rail keys in every locale', () => {
    for (const locale of LOCALES) {
      const defined = localeKeys(locale);
      const missing = NEW_KEYS.filter((key) => !defined.has(key));
      expect(missing, `locale ${locale}`).toEqual([]);
    }
  });
});
