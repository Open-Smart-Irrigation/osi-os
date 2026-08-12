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
 *     literal containing `//` or `/*`. A regex is not tracked as its own
 *     construct, so a quote INSIDE one (`/("[^"]*"|'[^']*')/`) is read as
 *     opening a string literal. Single- and double-quoted scans are bounded
 *     at the newline below, which caps the damage to the rest of that line;
 *     a stray backtick inside a regex is not bounded and can run to the next
 *     backtick or EOF. An earlier revision of this docstring claimed "this
 *     project's guards never scan files where that ambiguity arises" — that
 *     was FALSE (`dangerFgPairing` walks the whole `src` tree, which holds
 *     three such files) and a false claim in a guard's own description is
 *     the exact failure mode this helper exists to end. Verified against the
 *     TypeScript compiler's own comment ranges over all source files in both
 *     repos: zero divergence.
 *   - JSX text containing `//` or `/*` outside any string or expression —
 *     `<p>a // b</p>` loses the rest of the line. This is a false-GREEN
 *     direction for a guard that scans for a pattern later on that line, so
 *     prefer not to write such text in a file a guard scans.
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
        // A single- or double-quoted literal cannot span a newline, so an
        // unclosed one is not a string at all — most often a quote inside a
        // regex character class. Without this bound the scan runs to the next
        // matching quote anywhere later in the file, swallowing hundreds of
        // lines (and the comments in them) as string content. Treat the quote
        // as a lone character and resume scanning after it.
        if (quote !== '`' && source[j] === '\n') {
          j = i + 1;
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
