import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const appPath = join(import.meta.dirname, '..', 'src', 'App.tsx');
const analysisRoutePath = join(import.meta.dirname, '..', 'src', 'pages', 'AnalysisRoute.tsx');
const chartPanelPath = join(import.meta.dirname, '..', 'src', 'components', 'analysis', 'AnalysisChartPanel.tsx');

test('App imports only the small analysis route guard', () => {
  const source = readFileSync(appPath, 'utf8');
  assert.match(source, /import\s+\{\s*AnalysisRoute\s*\}\s+from\s+['"]\.\/pages\/AnalysisRoute['"]/, 'App.tsx should import the desktop guard directly');
  assert.doesNotMatch(source, /import\(['"]\.\/pages\/AnalysisRoute['"]\)/, 'App.tsx must not add a second lazy route hop');
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

test('analysis chart engines are lazy-loaded behind the selected-series boundary', () => {
  const source = readFileSync(chartPanelPath, 'utf8');
  assert.match(source, /import\(['"]\.\/EChart['"]\)/, 'AnalysisChartPanel should lazy-load EChart');
  assert.match(source, /import\(['"]\.\/CorrelationPanel['"]\)/, 'AnalysisChartPanel should lazy-load CorrelationPanel');
  assert.doesNotMatch(source, /import\s+\{\s*EChart\b/, 'AnalysisChartPanel must not statically import EChart');
  assert.doesNotMatch(source, /import\s+\{\s*CorrelationPanel\b/, 'AnalysisChartPanel must not statically import CorrelationPanel');
});

test('built default index chunk does not contain echarts after build', (t) => {
  const assetsDir = join(import.meta.dirname, '..', 'build', 'assets');
  let files: string[];
  try {
    files = readdirSync(assetsDir);
  } catch {
    t.skip('build/assets is absent; run npm run build before enforcing bundle output');
    return;
  }
  const indexFiles = files.filter((file) => /^index-[\w-]+\.js$/.test(file));
  assert.ok(indexFiles.length > 0, 'build/assets should contain an index chunk after npm run build');
  for (const file of indexFiles) {
    const source = readFileSync(join(assetsDir, file), 'utf8');
    const sourceWithoutChunkFileNames = source.replace(/analysis-echarts-[\w-]+\.js/g, '');
    assert.doesNotMatch(sourceWithoutChunkFileNames, /\becharts\b|zrender|ECharts/, `${file} should not contain ECharts`);
  }
  assert.ok(files.some((file) => /^analysis-echarts-[\w-]+\.js$/.test(file)), 'build should contain an analysis-echarts chunk');
  const workspaceChunk = files.find((file) => /^CrossZoneAnalysisPage-[\w-]+\.js$/.test(file));
  assert.ok(workspaceChunk, 'build should contain a lazy Analysis workspace chunk');
  assert.ok(
    readFileSync(join(assetsDir, workspaceChunk)).byteLength < 100 * 1024,
    'the Analysis workspace shell should remain below 100 KiB before charts load',
  );
});
