// Contrast and colour-vision-deficiency check for the SWT water-status pill.
//
// Reads the soil, text and surface tokens from web/react-gui/src/ui-core/tokens.css
// (light :root and html[data-theme='dark']), then prints:
//   1. WCAG 2.2 contrast ratios: dot and border against the pill wash (1.4.11, 3:1),
//      border against the surfaces the pill sits on, label text against the wash (1.4.3, 4.5:1);
//   2. the three dot colours simulated for protanopia, deuteranopia and tritanopia
//      (Machado, Oliveira and Fernandes 2009, severity 1.0, applied to linear sRGB) and
//      monochromacy (luminance only), with the pairwise CIEDE2000 difference and the
//      pairwise luminance contrast of each simulated pair.
//
// Run from the repository root: node docs/superpowers/previews/swt-water-status/implemented/contrast-cvd.mjs
// An optional first argument names another stylesheet with the same token blocks.
// Exits 1 when a dot or border falls under 3:1 against its wash. A simulated pair of
// states under DELTA_E_MIN is listed as needing a non-colour cue (the dot's fill level).
import { readFileSync } from 'node:fs';

const DELTA_E_MIN = 10;
const css = readFileSync(process.argv[2] ?? 'web/react-gui/src/ui-core/tokens.css', 'utf8');

function block(selector) {
  const values = new Map();
  const pattern = new RegExp(`${selector.replace(/[[\]']/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  let match;
  while ((match = pattern.exec(css)) !== null) {
    for (const line of match[1].split(';')) {
      const decl = /^\s*(--[\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,6})\s*$/.exec(line.replace(/\/\*.*?\*\//g, ''));
      if (decl) values.set(decl[1], decl[2]);
    }
  }
  return values;
}

const light = block(':root');
const dark = new Map([...light, ...block("html[data-theme='dark']")]);

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
};
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const luminanceLinear = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const luminance = (hex) => luminanceLinear(hexToRgb(hex).map(toLinear));
const ratioOfLuminance = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const ratio = (a, b) => ratioOfLuminance(luminance(a), luminance(b));

// Machado et al. 2009, severity 1.0.
const MACHADO = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const clamp = (v) => Math.min(1, Math.max(0, v));
function simulateLinear(hex, kind) {
  const lin = hexToRgb(hex).map(toLinear);
  if (kind === 'normal') return lin;
  if (kind === 'monochromacy') { const y = luminanceLinear(lin); return [y, y, y]; }
  return MACHADO[kind].map((row) => clamp(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
}
const linearToHex = (lin) => `#${lin.map((c) => Math.round(clamp(toGamma(c)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

function linearToLab([r, g, b]) {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

// CIEDE2000 (Sharma, Wu and Dalal 2005).
function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (b, a) => { if (b === 0 && a === 0) return 0; const h = Math.atan2(b, a) / rad; return h >= 0 ? h : h + 360; };
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbarp - 30) * rad) + 0.24 * Math.cos(2 * hbarp * rad)
    + 0.32 * Math.cos((3 * hbarp + 6) * rad) - 0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

const STATES = ['wet', 'moist', 'dry'];
const PAIRS = [['wet', 'moist'], ['wet', 'dry'], ['moist', 'dry']];
const KINDS = ['normal', 'protanopia', 'deuteranopia', 'tritanopia', 'monochromacy'];
const f2 = (n) => n.toFixed(2);
let failures = 0;
const confusable = [];

for (const [theme, tokens] of [['light', light], ['dark', dark]]) {
  console.log(`\n## ${theme}`);
  // The border uses the dot colour, so one ratio covers both.
  console.log('| State | Dot = border | Wash | Dot/border vs wash | Border vs card | Border vs surface | Wash vs card | Label vs wash |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const state of STATES) {
    const dot = tokens.get(`--soil-${state}`);
    const wash = tokens.get(`--soil-${state}-bg`);
    const dotWash = ratio(dot, wash);
    if (dotWash < 3) failures += 1;
    console.log(`| ${state} | ${dot} | ${wash} | ${f2(dotWash)} | ${f2(ratio(dot, tokens.get('--card')))} | ${f2(ratio(dot, tokens.get('--surface')))} | ${f2(ratio(wash, tokens.get('--card')))} | ${f2(ratio(tokens.get('--text'), wash))} |`);
  }
  console.log('\n| Vision | Simulated wet / moist / dry | ΔE00 wet-moist | ΔE00 wet-dry | ΔE00 moist-dry | L-contrast wet-moist | L-contrast wet-dry | L-contrast moist-dry |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const kind of KINDS) {
    const sim = Object.fromEntries(STATES.map((s) => [s, simulateLinear(tokens.get(`--soil-${s}`), kind)]));
    const dE = PAIRS.map(([a, b]) => deltaE2000(linearToLab(sim[a]), linearToLab(sim[b])));
    const lc = PAIRS.map(([a, b]) => ratioOfLuminance(luminanceLinear(sim[a]), luminanceLinear(sim[b])));
    PAIRS.forEach(([a, b], i) => { if (dE[i] < DELTA_E_MIN) confusable.push(`${theme} ${kind} ${a}-${b} ΔE00 ${dE[i].toFixed(1)}`); });
    console.log(`| ${kind} | ${STATES.map((s) => linearToHex(sim[s])).join(' / ')} | ${dE.map((d) => d.toFixed(1)).join(' | ')} | ${lc.map(f2).join(' | ')} |`);
  }
}

console.log(`\n${failures === 0 ? 'OK' : `FAIL (${failures})`}: dot and border vs wash >= 3:1 in both themes`);
console.log(`Pairs under ΔE00 ${DELTA_E_MIN} (colour alone does not separate them): ${confusable.length ? confusable.join('; ') : 'none'}`);
process.exitCode = failures === 0 ? 0 : 1;
