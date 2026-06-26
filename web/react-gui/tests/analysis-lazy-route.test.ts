import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const appPath = join(import.meta.dirname, '..', 'src', 'App.tsx');
const analysisRoutePath = join(import.meta.dirname, '..', 'src', 'pages', 'AnalysisRoute.tsx');

test('analysis route is lazy-loaded and not statically imported by App', () => {
  const source = readFileSync(appPath, 'utf8');
  assert.match(source, /lazy\s*\(/, 'App.tsx should use React.lazy');
  assert.match(source, /import\(['"]\.\/pages\/AnalysisRoute['"]\)/, 'AnalysisRoute must be dynamically imported');
  assert.doesNotMatch(source, /import\s+\{?\s*AnalysisRoute\b/, 'AnalysisRoute must not be statically imported');
  assert.doesNotMatch(source, /from ['"][^'"]*analysis[^'"]*['"]/, 'App.tsx must not import analysis modules directly');
  assert.doesNotMatch(source, /from ['"][^'"]*CrossZoneAnalysisPage[^'"]*['"]/, 'App.tsx must not import CrossZoneAnalysisPage directly');
});

test('analysis route guard lazy-loads the analysis page after desktop detection', () => {
  const source = readFileSync(analysisRoutePath, 'utf8');
  assert.match(source, /lazy\s*\(/, 'AnalysisRoute.tsx should lazy-load the analysis page');
  assert.match(
    source,
    /import\(['"]\.\/CrossZoneAnalysisPage['"]\)/,
    'CrossZoneAnalysisPage must be dynamically imported after the desktop guard',
  );
  assert.doesNotMatch(
    source,
    /import\s+\{?\s*CrossZoneAnalysisPage\b/,
    'AnalysisRoute must not statically import CrossZoneAnalysisPage',
  );
});

test('built default index chunk does not contain echarts after build', () => {
  const assetsDir = join(import.meta.dirname, '..', 'build', 'assets');
  const files = readdirSync(assetsDir);
  const indexFiles = files.filter((file) => /^index-[\w-]+\.js$/.test(file));
  assert.ok(indexFiles.length > 0, 'build/assets should contain an index chunk after npm run build');
  for (const file of indexFiles) {
    const source = readFileSync(join(assetsDir, file), 'utf8');
    const sourceWithoutChunkFileNames = source.replace(/analysis-echarts-[\w-]+\.js/g, '');
    assert.doesNotMatch(sourceWithoutChunkFileNames, /\becharts\b|zrender|ECharts/, `${file} should not contain ECharts`);
  }
  assert.ok(files.some((file) => /^analysis-echarts-[\w-]+\.js$/.test(file)), 'build should contain an analysis-echarts chunk');
});
