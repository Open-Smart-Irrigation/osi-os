import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const packagePath = join(import.meta.dirname, '..', 'package.json');
const viteConfigPath = join(import.meta.dirname, '..', 'vite.config.js');

test('analysis frontend declares echarts without replacing recharts history dependency', () => {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.ok(pkg.dependencies?.echarts, 'ECharts dependency is required for the lazy analysis route');
  assert.ok(pkg.dependencies?.recharts, 'Recharts must remain for existing history views');
});

test('vite config keeps echarts in a named async chunk', () => {
  const source = readFileSync(viteConfigPath, 'utf8');
  assert.match(source, /manualChunks/, 'vite config should define manualChunks');
  assert.match(source, /analysis-echarts/, 'echarts chunk name should be analysis-echarts');
});
