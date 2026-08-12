/**
 * Strip `//` line comments and `/* ... *\/` block comments from TypeScript /
 * TSX source, for guards that text-scan source files. Comments have
 * defeated text-scanning checks on this project three separate times: twice
 * by tripping a guard that hunted the exact pattern the comment named, and
 * once by SATISFYING an assertion because the guard read prose instead of
 * code. Any guard whose corpus can contain a comment describing the pattern
 * it looks for should run its corpus through this first.
 *
 * Guarantees:
 *   - `//` and `/* ... *\/` sequences that are NOT inside a string, template,
 *     or JSX-comment-embedded string are removed.
 *   - Content inside single-quoted, double-quoted, and backtick-delimited
 *     literals is preserved byte-for-byte, INCLUDING a literal `//` inside
 *     it (e.g. a URL string). This is the known flaw in the guard this
 *     helper generalises (`routeReachability.test.ts`'s
 *     `(^|[^:])\/\/.*$` regex): that regex protects `://` in URLs but would
 *     still truncate a plain string literal containing `//` with no
 *     preceding colon, because it never tracks whether it is inside a
 *     string. This implementation tracks string/template state character by
 *     character instead of pattern-matching, so it does not have that gap.
 *   - A line comment stops at the newline without consuming it, so line
 *     numbers in any surrounding diagnostic stay stable for single-line
 *     comments; a block comment removes its interior newlines along with
 *     its content, same as the regex it replaces.
 *
 * Does NOT guarantee:
 *   - Correctness where a bare `/` is a division operator or a regex
 *     literal containing `//` or `/*` — this project's guards never scan
 *     files where that ambiguity arises, so it is not handled.
 *   - A `${...}` template-literal interpolation that itself contains a
 *     backtick, string, or comment is not specially tracked — the scanner
 *     treats the whole template literal as opaque text up to its closing
 *     backtick, which is enough for every guard that currently needs this.
 *
 * Deliberately NOT used by `chromeTokens.test.ts`: a comment naming a raw
 * Tailwind palette class in a chrome header would, without stripping, cause
 * that guard to go red for a false positive — the SAFE failure direction,
 * unlike the false-green risk this helper exists to close elsewhere. Wiring
 * it in there would trade a safe false-red for a small chance of masking a
 * real one, for no benefit.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
