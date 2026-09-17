'use strict';
// Pure helpers for U1's French hardcoded-English scan (ui/smoke.js). Kept
// separate from smoke.js -- which needs a real browser -- so the
// classification rule itself is testable offline in selftest.js.
//
// Background (the "max 85 °C" false positive): ui/smoke.js already skips DOM
// text that exactly equals a locale bundle VALUE (frValues.has(t)). That only
// works for a plain string. An i18next template with an interpolation, e.g.
// devices.json's `"maxTemperature": "max {{max}} °C"`, renders as "max 85 °C"
// on the page -- a string that appears in NEITHER locale bundle verbatim (the
// bundle only ever holds the un-interpolated template). Without help, that
// legitimately-translated string falls all the way through to the
// ENGLISH_MARKERS heuristic, which flags it for containing the word "max" --
// even though "max" is the correct French rendering too (devices.json/fr's
// own template is "max {{max}} °C", genuinely translated, not hardcoded).
//
// The fix is narrow on purpose: recognise a rendered string ONLY when it
// matches a REAL template already present in the served locale bundle, not by
// loosening the English-word heuristic itself (which stays exactly as strict
// for anything that doesn't trace back to a real, interpolated translation).

const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}/g;
// A template that is (almost) nothing but placeholders would match nearly any
// string, which would hide a real leak instead of recognising one specific,
// known-good rendering -- so it is excluded rather than trusted.
const MIN_LITERAL_CHARS = 3;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Turns an i18next interpolation template into a matcher for what the
// RENDERED text looks like once i18next has substituted every placeholder.
// Returns null for a template with no placeholder at all (nothing for this
// helper to do -- smoke.js's exact-value check already covers it) or with too
// little surrounding literal text to match narrowly.
function templateToMatcher(template) {
  if (typeof template !== 'string' || !template.includes('{{')) return null;
  const parts = template.split(PLACEHOLDER_RE);
  if (parts.length < 2) return null;
  const literalChars = parts.reduce((n, p) => n + p.length, 0);
  if (literalChars < MIN_LITERAL_CHARS) return null;
  return new RegExp('^' + parts.map(escapeRegExp).join('[\\s\\S]*?') + '$');
}

// Builds one matcher per interpolated entry in a flattened locale map
// (dotted-key -> raw template string, as ui/smoke.js's flatten() produces).
function buildInterpolatedMatchers(localeMap) {
  const matchers = [];
  for (const template of Object.values(localeMap || {})) {
    const re = templateToMatcher(template);
    if (re) matchers.push(re);
  }
  return matchers;
}

// True when `text` is exactly what a REAL, currently-served, interpolated
// locale entry renders as for the page's language -- i.e. a legitimately
// translated string, not a hardcoded-English leak that merely happens to
// contain an English-looking word.
function matchesInterpolatedLocale(text, matchers) {
  return matchers.some((re) => re.test(text));
}

module.exports = { templateToMatcher, buildInterpolatedMatchers, matchesInterpolatedLocale, MIN_LITERAL_CHARS };
