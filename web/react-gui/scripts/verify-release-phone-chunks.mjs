import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const build = process.argv[2] ?? 'build';
const deferredChunk = /MobileTensionHistoryRoute|MobileSoilUplotHistory|mobile-history|history-uplot/i;
if (!process.argv.includes('--packaged')) {
  const manifest = JSON.parse(await readFile(path.join(build, '.vite/manifest.json'), 'utf8'));
  assert.ok(manifest['index.html']?.isEntry, 'inspect the real Vite output');
  assert.doesNotMatch(JSON.stringify(manifest), deferredChunk);
}

const index = await readFile(path.join(build, 'index.html'), 'utf8');
assert.match(index, /<script[^>]+src="[^"]*assets\/[^"]+\.js"/, 'inspect a packaged GUI entry point');
assert.doesNotMatch(index, deferredChunk);

const assets = path.join(build, 'assets');
const files = await readdir(assets);
for (const file of files) assert.doesNotMatch(file, deferredChunk);
const scripts = files.filter((file) => file.endsWith('.js'));
assert.ok(scripts.length > 0, 'inspect the emitted JavaScript');
for (const file of scripts) {
  const source = await readFile(path.join(assets, file), 'utf8');
  assert.doesNotMatch(source, /__osiMobileHistoryDiagnostics|mobile-tension-history|mobile-soil-uplot|mobile-tension-chart-frame/, file);
}
console.log('Release GUI has no experimental phone chart chunks or diagnostics entry points.');
