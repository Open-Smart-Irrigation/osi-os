import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pagesRoot = path.resolve(import.meta.dirname, '../src');

function listPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...listPages(full));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

// Hardcoded fills and text colors are theme-blind: #f4f1e8 with text-slate-950
// reads as intended in light mode and as unreadable intent in dark mode.
// Covers bg-/border-/ring-/divide-/from-/to- (gradient stops are just as
// theme-blind as a flat fill) and the full Tailwind color palette, not just
// the neutrals + a handful of accents the original guard happened to list.
const HARDCODED_BG =
  /\b(?:bg|border|ring|divide|from|to)-(?:\[#[0-9a-fA-F]{3,8}\]|(?:slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|white|black)[-\w]*)\b/;
// `white`/`black` are complete utilities on their own (`text-white`), unlike
// the shaded palette entries which always need a `-DD(D)` shade suffix
// (`text-slate-950`); requiring the shade suffix on every entry let a bare
// `text-white` slip past this guard undetected.
const HARDCODED_TEXT =
  /\btext-(?:\[#[0-9a-fA-F]{3,8}\]|(?:slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white|black)\b/;

// Collect class strings from both `className="…"` and `className={…}`, so the
// guard does not silently stop applying the day a shell becomes a template
// literal or a ternary. All 17 shells are plain string attributes today; that
// is exactly why the brace form has to be covered now rather than later.
const CLASS_ATTR = /class(?:Name)?=(?:"([^"]*)"|\{([\s\S]*?)\})/g;
const LITERAL = /(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)/g;

function classStrings(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(CLASS_ATTR)) {
    if (m[1] !== undefined) { out.push(m[1]); continue; }
    for (const lit of (m[2] ?? '').matchAll(LITERAL)) out.push(lit[1] ?? lit[2] ?? lit[3] ?? '');
  }
  return out;
}

// Two false positives, both verified by reading the source rather than
// forced into a "fix": the fragment-based `classStrings()` scanner records
// each string/template-literal segment separately, so a shell built from a
// static prefix plus a conditional suffix gets scanned as two independent
// pieces that don't individually contain `bg-[var(--bg)]` even though the
// element does, once rendered.
//   - pages/Login.tsx: `.login-scene` is a dedicated CSS class (index.css)
//     that paints a theme-aware gradient background in both
//     `:root` and `html[data-theme='dark']` — a deliberate design choice
//     that happens to route around the `bg-[var(--bg)]` Tailwind utility
//     this guard checks for, not a missing background.
//   - pages/HistoryCardDetailPage.tsx:753: the root div is
//     `` `flex min-h-screen flex-col bg-[var(--bg)] ${isLandscape ? 'h-[100dvh] overflow-hidden' : ''}` ``.
//     `bg-[var(--bg)]` is in the static prefix (always applied); the widened
//     shell predicate matches the *conditional suffix* literal in isolation,
//     which — scanned on its own — has no bg utility, even though the
//     rendered element always does.
const KNOWN_SHELL_GUARD_FALSE_POSITIVES = new Set<string>([
  "pages/Login.tsx: shell does not paint bg-[var(--bg)]: login-scene relative min-h-screen flex items-center justify-center px-4",
  "pages/HistoryCardDetailPage.tsx: shell does not paint bg-[var(--bg)]: h-[100dvh] overflow-hidden",
]);

// One test, per shell, both directions. A file-level `content.includes(...)`
// positive check passes a two-shell file when only one shell carries the token,
// which is precisely the regression this page sweep exists to prevent.
test('every viewport-claiming shell paints the app tokens and hardcodes nothing', () => {
  const offenders: string[] = [];
  for (const filePath of listPages(pagesRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const shells = classStrings(source).filter((c) => /\b(min-h-screen|h-screen)\b|min-h-\[calc\(|h-\[100dvh\]/.test(c));
    for (const shell of shells) {
      const rel = path.relative(pagesRoot, filePath);
      if (HARDCODED_BG.test(shell) || HARDCODED_TEXT.test(shell)) offenders.push(`${rel}: hardcoded color in shell: ${shell}`);
      if (!shell.includes('bg-[var(--bg)]')) offenders.push(`${rel}: shell does not paint bg-[var(--bg)]: ${shell}`);
    }
  }
  const unexpected = offenders.filter((o) => !KNOWN_SHELL_GUARD_FALSE_POSITIVES.has(o));
  assert.deepEqual(unexpected, []);
});
