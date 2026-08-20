import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const guiRoot = process.cwd();

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(guiRoot, relativePath), 'utf8');
}

test('BoveyLogo component ships the official wordmark and follows text color', () => {
  const source = readText('src/components/BoveyLogo.tsx');
  assert.match(source, /viewBox="0 0 226\.5 52\.2"/);
  assert.match(source, /fill="currentColor"/);
  assert.match(source, /aria-label="BOVEY"/);
});

test('Login page uses the Bovey logo, not the retired OSI logo asset', () => {
  const source = readText('src/pages/Login.tsx');
  assert.match(source, /BoveyLogo/);
  assert.doesNotMatch(source, /osi_logo/);
  assert.equal(fs.existsSync(path.join(guiRoot, 'src/assets/osi_logo.png')), false);
});

test('Login states only the Bovey brand — no OSI OS name, version, or Alpha tag', () => {
  const source = readText('src/pages/Login.tsx');
  assert.doesNotMatch(source, /OSI OS/);
  assert.doesNotMatch(source, /v0\.\d/);
  assert.doesNotMatch(source, /Alpha/);
});

test('browser title is Bovey and dashboard titles carry no OSI product name', () => {
  assert.match(readText('index.html'), /<title>Bovey<\/title>/);
  for (const locale of ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt']) {
    const dashboard = readText(`public/locales/${locale}/dashboard.json`);
    assert.doesNotMatch(dashboard, /Open Smart Irrigation|OSI OS/, `${locale} dashboard.json`);
  }
});

test('dashboard header renders the Bovey logo', () => {
  const source = readText('src/components/DashboardHeader.tsx');
  assert.match(source, /<BoveyLogo/);
});

test('theme tokens carry the Bovey palette in light and dark themes', () => {
  const css = readText('src/index.css');
  const [, lightBlock = '', darkBlock = ''] = css.split(/:root \{|html\[data-theme='dark'\] \{/);
  assert.match(lightBlock, /--primary: #055E92;/);
  assert.match(lightBlock, /--header-bg: #D7DADD;/);
  assert.match(lightBlock, /--header-text: #1D1D1B;/);
  assert.match(lightBlock, /--danger-fg: #AB2129;/);
  assert.match(darkBlock, /--primary: #4FAEE3;/);
});

test('light theme uses the brushed-aluminium chrome, not a dark header', () => {
  const css = readText('src/index.css');
  assert.match(css, /\.brushed-header \{/);
  assert.match(readText('src/components/DashboardHeader.tsx'), /brushed-header/);
});

test('cloud connection copy says Bovey Cloud, not OSI Server', () => {
  for (const locale of ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt']) {
    const bundle = readText(`public/locales/${locale}/accountLink.json`);
    assert.doesNotMatch(bundle, /OSI/, `${locale} accountLink.json`);
    assert.match(bundle, /Bovey Cloud/, `${locale} accountLink.json`);
  }
});

test('favicon is the shipped Bovey favicon', () => {
  assert.equal(fs.existsSync(path.join(guiRoot, 'public/favicon.png')), true);
});
