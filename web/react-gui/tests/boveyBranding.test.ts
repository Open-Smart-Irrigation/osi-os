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

test('dashboard header renders the Bovey logo', () => {
  const source = readText('src/components/DashboardHeader.tsx');
  assert.match(source, /<BoveyLogo/);
});

test('theme tokens carry the Bovey palette in light and dark themes', () => {
  const css = readText('src/index.css');
  const [, lightBlock = '', darkBlock = ''] = css.split(/:root \{|html\[data-theme='dark'\] \{/);
  assert.match(lightBlock, /--primary: #055E92;/);
  assert.match(lightBlock, /--header-bg: #1D1D1B;/);
  assert.match(lightBlock, /--danger-fg: #AB2129;/);
  assert.match(darkBlock, /--primary: #4FAEE3;/);
});

test('favicon is the shipped Bovey favicon', () => {
  assert.equal(fs.existsSync(path.join(guiRoot, 'public/favicon.png')), true);
});
