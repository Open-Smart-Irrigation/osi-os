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
// Orchestrator follow-up 2 (PR #301 review): round 1 accepted a template
// match on its literal text alone, with a lone placeholder's captured value
// checked by word-count + marker word -- word-count-and-marker is a poor
// proxy for "value-like" in both directions: a marker-free short English
// PHRASE ("please try again", "no data yet") still passed a lone-placeholder
// template, and a legitimate customer name that happens to CONTAIN a marker
// word ("High tunnel control", "Control valve north") would have started
// failing the slot check and then tripped the marker heuristic too -- a new
// false positive that did not exist before this feature did.
//
// The fix: classify each placeholder by its OWN NAME, not by scanning its
// captured text for English-looking words.
//   - A NAME-LIKE placeholder (see NAME_LIKE_PLACEHOLDER_NAMES below) holds
//     real user/customer content -- a zone, device or account name -- so its
//     slot accepts free text. The template's STATIC (literal) text is still
//     matched byte-for-byte against the real served locale entry, so a
//     hardcoded English sentence can only "match" a name template if it
//     literally contains that template's own translated wording; an English
//     rendering of the SAME concept (a different translation, or none) does
//     not match at all and falls through to the marker heuristic exactly as
//     before -- nothing here exempts static text, only the placeholder's own
//     span.
//   - Every OTHER placeholder must be value-like: a number (with separators,
//     a sign, an optional short unit), or a time/date shape. No free prose,
//     regardless of word count or marker words.

const PLACEHOLDER_CAPTURE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
// A template that is (almost) nothing but placeholders would match nearly any
// string, which would hide a real leak instead of recognising one specific,
// known-good rendering -- so it is excluded rather than trusted.
const MIN_LITERAL_CHARS = 3;
const LETTER_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]/;

// The SAME word list ui/smoke.js's own untranslated-English heuristic uses,
// defined once here so both the whole-string heuristic and the fallback path
// below can never drift apart from each other.
const ENGLISH_MARKERS = /\b(the|and|with|your|ago|used|not|available|updated|refresh|reboot|status|memory|temperature|settings|gateway|current|load|control|off|low|medium|high|max)\b/i;

// Placeholder names that, in THIS codebase's real locale bundles
// (web/react-gui/public/locales/en/*.json, surveyed 2026-09-17), hold
// genuine user/customer-authored content -- a zone, device, crop or account
// name -- rather than a number or a controlled/technical vocabulary term.
// Real usages: devices.json "zoneConfig.title": "Configure zone — {{zone}}";
// devices.json "assignModal.title": "Assign Device to {{zoneName}}";
// dashboard.json "welcome": "Welcome, {{username}}"; valves.json
// "openDialog.title": "Open {{name}}"; journal.json
// "capture.cycle.closesCycle": "Closes crop cycle: {{crop}}"; journal.json
// "capture.cycle.bannerCropVariety": "{{crop}} · {{variety}}"; history.json
// "history.source.multipleNamed": "{{count}} sources: {{names}}".
//
// Deliberately narrower than it could be: `label`, `title`, `message`,
// `detail`, `activity` and `op` also occur, but a live-source check found
// each of those is USUALLY (label: 3 of 4 sites; title: a fixed ~5-entry
// card-name vocabulary; op/reason: sync rejection reason codes) a
// translated technical term or a system-generated string, not customer
// text -- exempting them from the marker heuristic would risk hiding a real
// untranslated-technical-label leak. Leaving them out means this
// improvement simply does not help THOSE placeholders yet (the pre-existing
// heuristics still apply to them unchanged), which is the safe default.
const NAME_LIKE_PLACEHOLDER_NAMES = new Set(['name', 'zone', 'zonename', 'username', 'crop', 'variety', 'names']);

function isNameLikePlaceholder(placeholderName) {
  return NAME_LIKE_PLACEHOLDER_NAMES.has(String(placeholderName || '').toLowerCase());
}

// A value-like slot: digits (with `,`/`.` separators), an optional sign, an
// optional single short trailing unit token (letters/%/°, e.g. "kPa", "min",
// "%", "°C") -- OR a time shape ("14:04[:22]") -- OR an ISO date/datetime
// ("2026-09-17", optionally with a time part) -- OR a day/spelled-month/year
// date ("17 septembre 2026", "17 September 2026"), which is a genuine
// formatted-date shape even though it contains one word, not free prose.
// Anchored end to end: a leading digit/date run followed by MORE than one
// trailing word (real prose) does not match any alternative.
const VALUE_LIKE_RE = new RegExp(
  '^(?:' +
    '[+-]?\\d[\\d.,]*\\s?[%°]?[A-Za-zÀ-ÖØ-öø-ÿ]{0,12}' +
    '|\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?Z?)?' +
    '|\\d{1,2}:\\d{2}(?::\\d{2})?' +
    '|\\d{1,2}\\s+[A-Za-zÀ-ÖØ-öø-ÿ]{2,15}\\.?\\s+\\d{2,4}' +
  ')$'
);

function isValueLikeSlot(text) {
  const trimmed = String(text).trim();
  return trimmed.length > 0 && VALUE_LIKE_RE.test(trimmed);
}

// True when a placeholder's own captured span is acceptable: free text for a
// name-like placeholder (real user content), value-like shape for anything
// else.
function isSlotAcceptable(text, placeholderName) {
  const trimmed = String(text).trim();
  if (!trimmed) return false;
  if (isNameLikePlaceholder(placeholderName)) return true;
  return isValueLikeSlot(trimmed);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Splits a template into its literal segments and, in the same order, the
// NAME of each placeholder between them -- literals.length is always
// placeholderNames.length + 1 (literal[0] PLACEHOLDER[0] literal[1] ...).
function parseTemplate(template) {
  const literals = [];
  const placeholderNames = [];
  let lastIndex = 0;
  let m;
  PLACEHOLDER_CAPTURE_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_CAPTURE_RE.exec(template))) {
    literals.push(template.slice(lastIndex, m.index));
    placeholderNames.push(m[1]);
    lastIndex = PLACEHOLDER_CAPTURE_RE.lastIndex;
  }
  literals.push(template.slice(lastIndex));
  return { literals, placeholderNames };
}

// Turns an i18next interpolation template into a matcher for what the
// RENDERED text looks like once i18next has substituted every placeholder.
// Returns null for a template with no placeholder at all (nothing for this
// helper to do -- smoke.js's exact-value check already covers it), with too
// little surrounding literal text, or whose literal text has no actual
// letter in it (symbols/spaces alone are not "real substance" -- keeps a
// near-content-free template like a bare unit suffix from ever qualifying).
// Each placeholder becomes a CAPTURING group, paired with its own name, so
// matchesInterpolatedLocale can apply the RIGHT rule to what was captured
// instead of a single wildcard everything squeezes through.
function templateToMatcher(template) {
  if (typeof template !== 'string' || !template.includes('{{')) return null;
  const { literals, placeholderNames } = parseTemplate(template);
  if (placeholderNames.length === 0) return null;
  const literalText = literals.join('');
  if (literalText.length < MIN_LITERAL_CHARS) return null;
  if (!LETTER_RE.test(literalText)) return null;
  return {
    regex: new RegExp('^' + literals.map(escapeRegExp).join('([\\s\\S]*?)') + '$'),
    placeholderNames,
  };
}

// Builds one matcher per interpolated entry in a flattened locale map
// (dotted-key -> raw template string, as ui/smoke.js's flatten() produces).
function buildInterpolatedMatchers(localeMap) {
  const matchers = [];
  for (const template of Object.values(localeMap || {})) {
    const matcher = templateToMatcher(template);
    if (matcher) matchers.push(matcher);
  }
  return matchers;
}

// True when `text` is exactly what a REAL, currently-served, interpolated
// locale entry renders as for the page's language -- i.e. a legitimately
// translated string, not a hardcoded-English leak that merely happens to end
// (or start) the way some template's literal text does. The template's
// static text must match byte-for-byte (case above); each placeholder's own
// captured span must additionally be acceptable for THAT placeholder's kind
// (free text if name-like, value-like shape otherwise) -- a match on the
// static text alone is not enough.
function matchesInterpolatedLocale(text, matchers) {
  return matchers.some((matcher) => {
    const m = matcher.regex.exec(text);
    if (!m) return false;
    const slots = m.slice(1);
    return slots.length > 0 && slots.every((slot, i) => isSlotAcceptable(slot, matcher.placeholderNames[i]));
  });
}

module.exports = {
  templateToMatcher, buildInterpolatedMatchers, matchesInterpolatedLocale,
  isSlotAcceptable, isValueLikeSlot, isNameLikePlaceholder,
  NAME_LIKE_PLACEHOLDER_NAMES, MIN_LITERAL_CHARS, ENGLISH_MARKERS,
};
