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
//
// Orchestrator follow-up (PR #301 review): a template whose literal text is
// short enough to still pass MIN_LITERAL_CHARS but whose placeholder sits
// right next to the literal boundary -- e.g. valves.json/fr's
// `"format.temperature": "{{value}} °C"` -- used to match with a lazy
// `[\s\S]*?` wildcard that accepted ANYTHING before " °C", including a whole
// hardcoded English sentence ("Gateway temperature high 85 °C"). The
// template itself is real and the string genuinely ends the way that
// template renders, so excluding the template outright (raising
// MIN_LITERAL_CHARS) would have thrown out "max {{max}} °C" too. The
// narrower fix: capture what the placeholder actually stood for and require
// it to be VALUE-LIKE (a number, a unit, a short identifier, at most a
// couple of words) -- never a marker-bearing or sentence-length string.

const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}/g;
// A template that is (almost) nothing but placeholders would match nearly any
// string, which would hide a real leak instead of recognising one specific,
// known-good rendering -- so it is excluded rather than trusted.
const MIN_LITERAL_CHARS = 3;

// The SAME word list ui/smoke.js's own untranslated-English heuristic uses,
// defined once here so both the whole-string heuristic and the per-slot
// value check below can never drift apart from each other.
const ENGLISH_MARKERS = /\b(the|and|with|your|ago|used|not|available|updated|refresh|reboot|status|memory|temperature|settings|gateway|current|load|control|off|low|medium|high|max)\b/i;

// A legitimate interpolated VALUE in this codebase is a number, a unit, a
// short identifier (e.g. a harness-created resource name like
// "osi_zone_ab12") or a short label -- never assembled English prose. Bound
// chosen to comfortably admit a 1-word value or a short (<= 3-word)
// compound/date-like one, while rejecting a hardcoded English sentence
// squeezed into a lone placeholder (routinely 4+ words). Checked
// independently of the ENGLISH_MARKERS test below, since a short
// marker-bearing phrase ("not available", 2 words) would otherwise slip
// through on word count alone.
const MAX_SLOT_WORDS = 3;

function isValueLikeSlot(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return false;
  if (ENGLISH_MARKERS.test(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= MAX_SLOT_WORDS;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Turns an i18next interpolation template into a matcher for what the
// RENDERED text looks like once i18next has substituted every placeholder.
// Returns null for a template with no placeholder at all (nothing for this
// helper to do -- smoke.js's exact-value check already covers it) or with too
// little surrounding literal text to match narrowly. Each placeholder becomes
// a CAPTURING group (not a bare wildcard) so matchesInterpolatedLocale can
// validate what was actually captured instead of accepting anything.
function templateToMatcher(template) {
  if (typeof template !== 'string' || !template.includes('{{')) return null;
  const parts = template.split(PLACEHOLDER_RE);
  if (parts.length < 2) return null;
  const literalChars = parts.reduce((n, p) => n + p.length, 0);
  if (literalChars < MIN_LITERAL_CHARS) return null;
  return new RegExp('^' + parts.map(escapeRegExp).join('([\\s\\S]*?)') + '$');
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
// translated string, not a hardcoded-English leak that merely happens to end
// (or start) the way some template's literal text does. A template match on
// its own is not enough: every placeholder's captured value must also be
// value-like, or the "match" is really a sentence that swallowed the
// wildcard, not a translation.
function matchesInterpolatedLocale(text, matchers) {
  return matchers.some((re) => {
    const m = re.exec(text);
    if (!m) return false;
    const slots = m.slice(1);
    return slots.length > 0 && slots.every(isValueLikeSlot);
  });
}

module.exports = {
  templateToMatcher, buildInterpolatedMatchers, matchesInterpolatedLocale, isValueLikeSlot,
  MIN_LITERAL_CHARS, MAX_SLOT_WORDS, ENGLISH_MARKERS,
};
