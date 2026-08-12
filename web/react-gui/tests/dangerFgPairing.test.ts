import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './stripComments';

// --danger-fg (#DC2626 light) clears 4.5:1 only on --card (4.83). Measured
// against every other surface it could land on it FAILS as body text:
//   --bg      #F4F6F8  4.458
//   --surface #E8EDF2  4.100
//   --error-bg #FEE2E2 3.953
//   --border  #CBD5E1  3.253   <- SystemPanel's hover state before S6 T2
// All four clear 3:1, so --danger-fg stays legal as a BORDER on all of them
// (that is exactly how Banner.tsx:7 and Chip.tsx:9 use it). This guard fences
// the text case, PER VARIANT: a state variant may not end up with an effective
// background from that list while its effective text colour is --danger-fg.
// Per-variant is the whole point — `hover:bg-[var(--error-bg)]` paired with
// `hover:text-[var(--error-text)]` is CORRECT and must not be flagged, while
// `hover:bg-[var(--error-bg)]` on its own inherits the base --danger-fg text
// and must be.
const FORBIDDEN_BG = ['--bg', '--surface', '--error-bg', '--border'];
const DANGER = '--danger-fg';
const srcRoot = path.resolve(import.meta.dirname, '../src');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : files(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

// Extract each quoted/backticked class-string-shaped literal, so a multi-line
// template literal is inspected as ONE string rather than line by line — the
// same-line weakness the S3 ledger records for errorTokenMisuse.
function classStrings(source: string): string[] {
  return [...source.matchAll(/(["'`])((?:[^\\]|\\.)*?)\1/gs)]
    .map((m) => m[2])
    .filter((s) => s.includes('-[var(--'));
}

/**
 * Split `hover:text-[var(--x)]` into { variant: 'hover', utility:
 * 'text-[var(--x)]' }. Only a colon BEFORE the first `[` separates a variant,
 * so arbitrary values keep their own colons: `bg-[color-mix(in_srgb,…)]` and
 * `text-[var(--x)]` stay whole. Stacked variants (`dark:hover:…`) come back as
 * one composite variant key, which is what we want — `dark:hover` is its own
 * rendering state and must be resolved as one.
 */
function splitVariant(token: string): { variant: string; utility: string } {
  const bracket = token.indexOf('[');
  const limit = bracket === -1 ? token.length : bracket;
  const lastColon = token.lastIndexOf(':', limit - 1);
  if (lastColon === -1) return { variant: '', utility: token };
  return { variant: token.slice(0, lastColon), utility: token.slice(lastColon + 1) };
}

const tokenOf = (utility: string, prefix: 'bg' | 'text'): string | undefined =>
  new RegExp(`^${prefix}-\\[var\\((--[a-z-]+)\\)\\]$`).exec(utility)?.[1];

/** Variants of `cls` whose EFFECTIVE bg/text pair fails. Empty means legal. */
function failingVariants(cls: string): string[] {
  const byVariant = new Map<string, { bg?: string; text?: string }>();
  for (const token of cls.split(/\s+/).filter(Boolean)) {
    const { variant, utility } = splitVariant(token);
    const bg = tokenOf(utility, 'bg');
    const text = tokenOf(utility, 'text');
    if (!bg && !text) continue;
    const entry = byVariant.get(variant) ?? {};
    if (bg) entry.bg = bg;
    if (text) entry.text = text;
    byVariant.set(variant, entry);
  }
  const base = byVariant.get('') ?? {};
  const failing: string[] = [];
  for (const [variant, entry] of byVariant) {
    const bg = entry.bg ?? base.bg;
    const text = entry.text ?? base.text;
    if (bg && text === DANGER && FORBIDDEN_BG.includes(bg)) failing.push(variant || 'base');
  }
  return failing;
}

test('no element pairs text-[var(--danger-fg)] with a background it fails AA on', () => {
  // Table cases first, so the resolver itself is proven in both directions
  // before it is pointed at the tree. Without these the guard could be
  // silently over- or under-matching and still report zero offenders.
  // Kept as assertions inside this one test() — NOT extra test() calls — so
  // the suite delta stays +1 per repo and T11's arithmetic holds.
  assert.deepEqual(
    failingVariants('bg-[var(--card)] hover:bg-[var(--border)] text-[var(--danger-fg)]'),
    ['hover'],
    'a hover bg swap that leaves the base danger text in place must be flagged',
  );
  assert.deepEqual(
    failingVariants(
      'bg-[var(--card)] hover:bg-[var(--error-bg)] text-[var(--danger-fg)] hover:text-[var(--error-text)]',
    ),
    [],
    'swapping bg AND text in the same variant is the correct fix and must NOT be flagged',
  );
  assert.deepEqual(
    failingVariants('bg-[var(--surface)] text-[var(--danger-fg)]'),
    ['base'],
    'a base-variant failing pair must be flagged',
  );
  assert.deepEqual(
    failingVariants('border border-[var(--border)] text-[var(--danger-fg)]'),
    [],
    'a border token is not a background — --danger-fg clears 3:1 on all four',
  );
  assert.deepEqual(
    failingVariants(
      'bg-[color-mix(in_srgb,var(--overlay)_70%,transparent)] text-[var(--danger-fg)]',
    ),
    [],
    'an arbitrary value containing colons must not be split into a bogus variant',
  );

  const offenders: string[] = [];
  for (const file of files(srcRoot)) {
    // Comments are not code: classStrings() extracts every quoted/backticked
    // literal, and a doc comment describing a class in backticks (or a
    // commented-out JSX line) is quoted text too. Stripped here so a
    // comment can never manufacture — or hide — an offender.
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const cls of classStrings(source)) {
      if (!cls.includes(`text-[var(${DANGER})]`)) continue;
      for (const variant of failingVariants(cls)) {
        offenders.push(`${path.relative(srcRoot, file)}: ${variant} variant pairs text-[var(${DANGER})] with a failing background`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
