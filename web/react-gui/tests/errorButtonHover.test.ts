import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Matches className="..." (double-quoted string literal) and
// className={`...`} (template literal), so both quoting styles used in
// this codebase are inspected. The captured group is the raw class-string
// content (template-literal ${...} interpolations are kept as literal
// text, which is fine: we only ever substring-match against them).
const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;

// Any hardcoded (non-arbitrary-value) hover background utility, e.g.
// hover:bg-red-700, hover:bg-red-800, hover:bg-blue-600 — but not
// hover:bg-[var(--x)] (arbitrary value) or hover:opacity-90 (no bg-).
const HARDCODED_HOVER_BG = /hover:bg-(?!\[)[a-z]+-\d+/;

// Either error-token utility: bg-[var(--error-bg)] or text-[var(--error-text)].
const ERROR_TOKEN = /(?:bg|text)-\[var\(--error-(?:bg|text)\)\]/;

/**
 * True when a single class-string (the content of one className attribute,
 * whatever its quote style) pairs an error token with a hardcoded hover
 * background shade — the dark-on-dark twin bug's general shape.
 */
function isOffendingClassString(classString: string): boolean {
  return ERROR_TOKEN.test(classString) && HARDCODED_HOVER_BG.test(classString);
}

test('no class string pairs an error-bg/error-text token with a hardcoded hover background shade', () => {
  const offenders: string[] = [];
  for (const filePath of listSourceFiles(srcRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(CLASS_ATTR)) {
      const classString = match[1] ?? match[2] ?? '';
      if (isOffendingClassString(classString)) {
        offenders.push(path.relative(srcRoot, filePath));
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('detection: catches a shade other than red-700 (red-800) paired with the error-bg token', () => {
  assert.equal(
    isOffendingClassString('bg-[var(--error-bg)] hover:bg-red-800 text-[var(--error-text)]'),
    true,
  );
});

test('detection: catches the offending pairing inside a template-literal className', () => {
  // Same shape as LoRainGaugeCard.tsx / DraginoTempCard.tsx's real
  // template-literal classNames, but with a hardcoded hover shade
  // substituted in place of their actual hover:opacity-80 — proves the
  // template-literal quote style is inspected, not just double-quoted
  // string literals.
  const source =
    'className={`rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:bg-blue-600 disabled:opacity-40 ${FOCUS_VISIBLE_RING}`}';
  const offenders: string[] = [];
  for (const match of source.matchAll(CLASS_ATTR)) {
    const classString = match[1] ?? match[2] ?? '';
    if (isOffendingClassString(classString)) offenders.push(classString);
  }
  assert.equal(offenders.length, 1);
});

test('detection: does not flag AccountLink.tsx\'s idiom (fully hardcoded red button, no error token)', () => {
  // The real string at src/pages/AccountLink.tsx:368. Fully hardcoded
  // bg-red-600/hover:bg-red-700/text-white stays readable and is outside
  // this guard's scope by design — it never touches the error token.
  assert.equal(
    isOffendingClassString(
      'bg-red-600 hover:bg-red-700 text-white font-bold px-4 py-2 rounded-lg transition-colors disabled:opacity-50',
    ),
    false,
  );
});

test('detection: does not flag the sanctioned hover:opacity-90 treatment', () => {
  assert.equal(
    isOffendingClassString(
      'bg-[var(--error-bg)] hover:opacity-90 text-[var(--error-text)] font-bold px-4 py-2 rounded-lg text-sm transition-colors',
    ),
    false,
  );
});
