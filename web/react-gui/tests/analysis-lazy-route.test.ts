import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const appPath = join(import.meta.dirname, '..', 'src', 'App.tsx');

test('analysis route is lazy-loaded and not statically imported by App', () => {
  const source = readFileSync(appPath, 'utf8');
  assert.match(source, /lazy\s*\(/, 'App.tsx should use React.lazy');
  assert.match(source, /import\(['"]\.\/pages\/AnalysisRoute['"]\)/, 'AnalysisRoute must be dynamically imported');
  assert.doesNotMatch(source, /import\s+\{?\s*AnalysisRoute\b/, 'AnalysisRoute must not be statically imported');
  assert.doesNotMatch(source, /from ['"][^'"]*analysis[^'"]*['"]/, 'App.tsx must not import analysis modules directly');
  assert.doesNotMatch(source, /from ['"][^'"]*CrossZoneAnalysisPage[^'"]*['"]/, 'App.tsx must not import CrossZoneAnalysisPage directly');
});

test('built default index chunk does not contain echarts after build', () => {
  const assetsDir = join(import.meta.dirname, '..', 'build', 'assets');
  let files: string[];
  try {
    files = readdirSync(assetsDir);
  } catch {
    return; // npm run build has not been run in this checkout yet.
  }
  const indexFiles = files.filter((file) => /^index-[\w-]+\.js$/.test(file));
  assert.ok(indexFiles.length > 0, 'build/assets should contain an index chunk after npm run build');
  for (const file of indexFiles) {
    const source = readFileSync(join(assetsDir, file), 'utf8');
    const sourceWithoutChunkFileNames = source.replace(/analysis-echarts-[\w-]+\.js/g, '');
    assert.doesNotMatch(sourceWithoutChunkFileNames, /\becharts\b|zrender|ECharts/, `${file} should not contain ECharts`);
  }
  assert.ok(files.some((file) => /^analysis-echarts-[\w-]+\.js$/.test(file)), 'build should contain an analysis-echarts chunk');
});
