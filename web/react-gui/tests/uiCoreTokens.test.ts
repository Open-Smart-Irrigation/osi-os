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

// The categorical history-state palette (S4 T1). Distinct from the four chrome
// semantic tones on purpose: a 20-state calendar heatmap and a 4-tone banner
// vocabulary are different systems, and conflating them means a change to
// --warn-bg silently repaints the dendro calendar. Precedent: --soil-*.
const CAL_TONES = [
  'warn', 'good', 'cool', 'bad', 'alert', 'humid', 'water', 'mixed', 'violet',
] as const;
const CAL_PARTS = ['bg', 'text', 'border', 'solid'] as const;

// Light values are verbatim Tailwind v4 oklch() strings (M11); dark values are
// hex. Both shapes must resolve to sRGB for a WCAG ratio, so parse both.
function srgbOf(value: string): [number, number, number] {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as [number, number, number];
  }
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  assert.ok(ok, `unparseable colour: ${value}`);
  const L = ok![2] === '%' ? Number(ok![1]) / 100 : Number(ok![1]);
  const C = Number(ok![3]);
  const hRad = (Number(ok![4]) * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  // Gamut-clip then encode, which is what a browser does on an sRGB display.
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  return lin.map((c) => clamp(encode(clamp(c)))) as [number, number, number];
}

function luminance(value: string): number {
  const [r, g, b] = srgbOf(value).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blocks(css: string): { name: string; css: string }[] {
  const split = css.indexOf("html[data-theme='dark']");
  return [
    { name: 'light', css: css.slice(css.indexOf(':root'), split) },
    { name: 'dark', css: css.slice(split) },
  ];
}

function value(block: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6}|oklch\\([^)]*\\));`).exec(block);
  assert.ok(match, `${name} must be a hex or an oklch() literal in this block`);
  return match![1];
}

test('every --cal tone declares bg/text/border/solid in BOTH themes', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const missing: string[] = [];
  for (const block of blocks(css)) {
    for (const tone of CAL_TONES) {
      for (const part of CAL_PARTS) {
        const decl = `--cal-${tone}-${part}:`;
        if (!block.css.includes(decl)) missing.push(`${block.name} ${decl}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// Sanity-check the conversion itself against a value read out of the edge's own
// installed palette, so a broken helper cannot silently pass the ratio test.
test('the oklch helper agrees with the known sRGB of amber-50', () => {
  assert.equal(contrastRatio('oklch(98.7% 0.022 95.277)', '#FFFBEB').toFixed(3), '1.000');
});

test('every --cal tone clears AA for its own text on its own bg, both themes', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const failures: string[] = [];
  for (const block of blocks(css)) {
    for (const tone of CAL_TONES) {
      const ratio = contrastRatio(
        value(block.css, `--cal-${tone}-text`),
        value(block.css, `--cal-${tone}-bg`),
      );
      if (ratio < 4.5) failures.push(`${block.name} --cal-${tone}: ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, []);
});

// The light values must be the edge's own Tailwind v4 palette verbatim (M11):
// an sRGB hex conversion would render differently on a P3 display, which is
// the whole reason the ruling says "verbatim".
test('light --cal values are oklch() literals, dark values are hex', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const [light, dark] = blocks(css);
  for (const tone of CAL_TONES) {
    for (const part of CAL_PARTS) {
      assert.match(value(light.css, `--cal-${tone}-${part}`), /^oklch\(/, `light --cal-${tone}-${part}`);
      assert.match(value(dark.css, `--cal-${tone}-${part}`), /^#[0-9A-F]{6}$/, `dark --cal-${tone}-${part}`);
    }
  }
});
