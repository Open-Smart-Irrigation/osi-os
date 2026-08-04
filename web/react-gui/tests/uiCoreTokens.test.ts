import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const tokensPath = path.resolve(import.meta.dirname, '../src/ui-core/tokens.css');

test('tokens.css carries exactly the :root and dark-theme blocks', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  assert.equal((css.match(/\{/g) ?? []).length, 2, 'only :root and html[data-theme=dark] blocks');
  assert.match(css, /^:root \{/m);
  assert.match(css, /^html\[data-theme='dark'\] \{/m);
});

test('light theme fixes the error pair to wash background + dark text', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const light = css.slice(0, css.indexOf("html[data-theme='dark']"));
  assert.match(light, /--error-bg: #FEE2E2;/);
  assert.match(light, /--error-text: #7F1D1D;/);
  assert.doesNotMatch(light, /--error-text: #FFFFFF;/);
});

test('dark theme error pair is unchanged', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const dark = css.slice(css.indexOf("html[data-theme='dark']"));
  assert.match(dark, /--error-bg: #7F1D1D;/);
  assert.match(dark, /--error-text: #FEE2E2;/);
});

test('every cloud-sheet variable and the glass set exist in tokens.css', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const cloudNames = [
    '--bg', '--surface', '--card', '--text', '--text-secondary', '--text-tertiary',
    '--text-disabled', '--border', '--focus', '--primary', '--primary-hover',
    '--secondary-bg', '--header-bg', '--header-text', '--header-subtext',
    '--success-bg', '--success-text', '--success-border', '--warn-bg', '--warn-text',
    '--warn-border', '--error-bg', '--error-text', '--toggle-on', '--toggle-off', '--overlay',
  ];
  for (const name of cloudNames) assert.match(css, new RegExp(`${name}: #`), name);
  const glassNames = [
    '--glass-hi', '--glass-lo', '--glass-mid', '--glass-edge', '--glass-edge-dim',
    '--glass-spec', '--glass-sweep', '--chrome-hi', '--chrome-lo', '--brand-red',
  ];
  for (const name of glassNames) assert.match(css, new RegExp(`${name}:`), name);
});
