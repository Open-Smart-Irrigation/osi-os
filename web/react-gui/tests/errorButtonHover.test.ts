import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no class string pairs bg-[var(--error-bg)] with hover:bg-red-700', () => {
  const offenders: string[] = [];
  for (const filePath of listSourceFiles(srcRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(/className="([^"]*)"/g)) {
      if (match[1].includes('bg-[var(--error-bg)]') && match[1].includes('hover:bg-red-700')) {
        offenders.push(path.relative(srcRoot, filePath));
      }
    }
  }
  assert.deepEqual(offenders, []);
});
