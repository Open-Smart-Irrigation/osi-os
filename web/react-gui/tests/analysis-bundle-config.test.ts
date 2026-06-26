import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const packagePath = join(import.meta.dirname, '..', 'package.json');
const viteConfigPath = join(import.meta.dirname, '..', 'vite.config.js');

test('analysis frontend declares echarts without replacing recharts history dependency', () => {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.ok(pkg.dependencies?.echarts, 'ECharts dependency is required for the lazy analysis route');
  assert.ok(pkg.dependencies?.recharts, 'Recharts must remain for existing history views');
});

test('vite config keeps echarts and zrender in a package-boundary-aware async chunk', async () => {
  const { manualChunksForVendor } = await import(pathToFileURL(viteConfigPath).href);

  assert.equal(
    manualChunksForVendor('/repo/node_modules/echarts/index.js'),
    'analysis-echarts',
    'echarts should be isolated in the analysis ECharts chunk',
  );
  assert.equal(
    manualChunksForVendor('/repo/node_modules/zrender/lib/core.js'),
    'analysis-echarts',
    'zrender should be isolated with ECharts',
  );
  assert.equal(
    manualChunksForVendor('/repo/node_modules/echarts-gl/index.js'),
    undefined,
    'prefixed ECharts packages should not be swept into the chunk',
  );
  assert.equal(
    manualChunksForVendor('/repo/src/App.tsx'),
    undefined,
    'application source should stay in its normal chunk',
  );
});
