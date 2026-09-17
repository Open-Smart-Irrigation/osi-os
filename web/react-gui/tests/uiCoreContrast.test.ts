import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * WCAG 2.2 AA 1.4.3 on the tokens the whole product reads its body text from.
 *
 * The 2026-09-17 screen review found 3256 contrast failures across 170 screens
 * from a single token: a branding block redeclared `--text-tertiary` as
 * slate-500 (4.04:1 on `--surface`) after `tokens.css` had already set a
 * compliant value, and the second declaration wins. Nothing failed — the
 * override was valid CSS and every test was about key coverage, not colour.
 *
 * So this reads the cascade the way the browser does: `tokens.css` first,
 * then `index.css`, which is imported after it and is where a customer
 * branch's palette block goes. A regression fails here on main and on every
 * branch cut from it.
 */

const uiCore = path.resolve(import.meta.dirname, '../src/ui-core/tokens.css');
const indexCss = path.resolve(import.meta.dirname, '../src/index.css');

/** Declarations of one selector, in source order, later wins. */
function declarations(css: string, selector: string): Map<string, string> {
  const values = new Map<string, string>();
  const pattern = new RegExp(`${selector.replace(/[[\]']/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  let block: RegExpExecArray | null;
  while ((block = pattern.exec(css)) !== null) {
    for (const line of block[1].split(';')) {
      const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
      if (match) values.set(match[1], match[2]);
    }
  }
  return values;
}

function parseHex(value: string): [number, number, number] {
  const hex = value.trim().replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  assert.match(full, /^[0-9a-fA-F]{6}$/, `not a hex colour: ${value}`);
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function effectiveTokens(selector: string): Map<string, string> {
  const merged = declarations(fs.readFileSync(uiCore, 'utf8'), selector);
  // index.css imports tokens.css first, so its own `:root` wins — that is the
  // slot a branding palette occupies.
  for (const [name, value] of declarations(fs.readFileSync(indexCss, 'utf8'), selector)) {
    merged.set(name, value);
  }
  return merged;
}

/** Body-text tokens. `--text-disabled` is exempt: 1.4.3 excludes inactive controls. */
const TEXT_TOKENS = ['--text', '--text-secondary', '--text-tertiary'];
const SURFACE_TOKENS = ['--bg', '--surface', '--card'];
const AA_BODY_TEXT = 4.5;

function assertReadable(selector: string) {
  const tokens = effectiveTokens(selector);
  for (const text of TEXT_TOKENS) {
    const foreground = tokens.get(text);
    assert.ok(foreground, `${selector} declares no ${text}`);
    for (const surface of SURFACE_TOKENS) {
      const background = tokens.get(surface);
      assert.ok(background, `${selector} declares no ${surface}`);
      const ratio = contrast(foreground, background);
      assert.ok(
        ratio >= AA_BODY_TEXT,
        `${selector} ${text} (${foreground}) on ${surface} (${background}) is ${ratio.toFixed(2)}:1, below ${AA_BODY_TEXT}:1`,
      );
    }
  }
}

test('light theme body text clears AA on every surface token', () => {
  assertReadable(':root');
});

test('dark theme body text clears AA on every surface token', () => {
  assertReadable("html[data-theme='dark']");
});

test('the ratio maths matches the published WCAG examples', () => {
  assert.equal(Number(contrast('#FFFFFF', '#000000').toFixed(2)), 21);
  assert.equal(Number(contrast('#777777', '#FFFFFF').toFixed(2)), 4.48);
  // The override the review measured, against the surface it was measured on.
  assert.equal(Number(contrast('#64748b', '#e8edf2').toFixed(2)), 4.04);
  assert.equal(Number(contrast('#576474', '#e8edf2').toFixed(2)), 5.12);
});
