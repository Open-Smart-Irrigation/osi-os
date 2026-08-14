import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const frontendRoot = path.resolve(import.meta.dirname, '..');
const LOCALES = ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt'];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function referencedAddModalKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(path.join(frontendRoot, 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/addModal\.([A-Za-z0-9_]+)/g)) keys.add(match[1]);
  }
  return [...keys].sort();
}

test('every locale carries every addModal key referenced by the source', () => {
  const keys = referencedAddModalKeys();
  for (const locale of LOCALES) {
    const devices = JSON.parse(
      fs.readFileSync(path.join(frontendRoot, `public/locales/${locale}/devices.json`), 'utf8'),
    );
    for (const key of keys) {
      assert.equal(typeof devices.addModal?.[key], 'string', `${locale} devices.addModal.${key}`);
      assert.notEqual(devices.addModal[key].trim(), '', `${locale} devices.addModal.${key}`);
    }
  }
});
