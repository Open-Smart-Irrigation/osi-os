# AgroLink Locale Expansion — Chinese, Arabic, Kiswahili (Design)

**Status:** Approved 2026-07-22 (variant/RTL/delivery decisions adjudicated by maintainer).
**Base:** branch `fix/i18n-review-repairs-2026-07` (PR #150) — the enhanced English source produced by the 2026-07 translation-review repairs is the origin for all new translations.

## Goal

Add three fully translated locales to the AgroLink GUI — Simplified Chinese (`zh`), Arabic (`ar`), Kiswahili (`sw`) — translated from the repaired English corpus (1,325 strings × 9 namespaces), registered end-to-end (config, switcher, tests, review pack, feeds mirror), with correct plural handling per language and document-direction support for Arabic.

## Adjudicated decisions

1. **Chinese = Simplified only**, locale code `zh`, switcher label `中文`.
2. **Arabic = strings + direction switch.** `ar` translations ship now; `document.documentElement.dir`/`lang` follow `i18n.dir()` on language change so Arabic gets RTL text flow immediately. Full layout mirroring (icons, chevrons, chart axes, directional padding) is an explicitly tracked follow-up, not part of this slice. Switcher label `العربية`.
3. **Delivery = same branch/PR.** Commits append to `fix/i18n-review-repairs-2026-07` (PR #150).
4. **Digits in Arabic:** Western Arabic numerals (ASCII digits) everywhere — consistency with units (kPa, pF), interpolated counts, and CSV exports. No Eastern Arabic numeral conversion.
5. **Kiswahili = standard Kiswahili** (Tanzania/Kenya norm), farmer-facing register, label `Kiswahili`.

## Plural-group parity (the one structural change)

CLDR cardinal categories differ per locale: `zh` {other}, `sw` {one, other}, `ar` {zero, one, two, few, many, other}, existing seven locales {one, other}. The current `i18nParity.test.ts` rule "identical flattened key sets across locales" therefore cannot survive.

**New rule set for `web/react-gui/tests/i18nParity.test.ts`:**

- A **plural group** is the set of keys sharing a base name after stripping a `_zero|_one|_two|_few|_many|_other` suffix. A base name is a plural group iff at least one locale carries a suffixed form of it.
- **Group-set parity:** the set of {non-plural keys} ∪ {plural-group base names} must be identical across all locales, per namespace.
- **Per-locale form completeness:** for every plural group, each locale must carry exactly the suffix forms returned by `new Intl.PluralRules(locale).resolvedOptions().pluralCategories` — no more, no fewer. This derives the requirement from the same CLDR data i18next uses at runtime, so the test cannot drift from resolution behavior.
- **Placeholder parity:** non-plural keys compare token sets against `en` per key, as today. Plural forms compare against the `en` group's `_other` form ({{count}} et al.).
- Existing checks (no ß in de-CH, no ASCII `...`/`->`) extend over the new locales unchanged.

Consequence for content: every existing plural group (`deviceCount`, `staleSensors`, `freshSensors`, `intervalPending` ×2, the journal count groups, `schedulerDisableSuccess`, …) gets six `ar` forms, two `sw` forms, one `zh` form (`_other`).

## Translation conventions

Shared: translate from the current `en` values on the branch; preserve every `{{placeholder}}`; typographic `…`/`→`; glossary stays Latin in all three scripts (OSI Server, OSI OS, AgroLink, ChirpStack, LoRaWAN, DevEUI, FPort, RSSI, SNR, kPa, pF, ET₀, Kc, VPD, THI, UV, CSV, PNG, GPS, EUI, STREGA, Kiwi, Open-Meteo, OpenAgri); the unified settings/support pairs get ONE identical translation per concept per locale; the farm gateway is one consistent term per locale; `settings.predictionAdvisoryWarning` must be phrased so it cannot be read as agricultural production.

- **zh:** concise UI Mandarin, Simplified script; no space between CJK and interpolated Latin tokens unless required for units; full-width punctuation where conventional (，。？) but keep `…` and ASCII parentheses around Latin tokens.
- **ar:** Modern Standard Arabic, formal-neutral address; ASCII digits per decision 4; punctuation may use Arabic comma (،) and question mark (؟) where conventional; placeholders stay LTR tokens inside RTL text (browser bidi handles ordering — the parity test verifies token presence, not position).
- **sw:** standard Kiswahili, farmer-facing (kumwagilia/umwagiliaji family for irrigation, shamba for farm/field, bonde/eneo choices to be made consistently by the translator and kept uniform).

## Pipeline

Per language, the established two-stage SDD loop: one Sonnet translator subagent produces the 9 namespace files (translating every string, building the correct plural sets), then an independent native-level reviewer subagent verifies (accuracy, register consistency, glossary, plural grammar, placeholders) with fix waves until approved. Arabic's reviewer additionally checks MSA correctness and that no string relies on layout mirroring to be understood.

## Registration & file surface (per language task)

- `web/react-gui/public/locales/<code>/*.json` — 9 namespaces, and byte-identical copies in `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/<code>/` (the two known web-only key families — `common.restart.*`, `settings.journalTitle/journalDetailLevel*` — exist only in the web tree for existing locales; for NEW locales the web tree carries them and the mirror does not, matching the en/mirror asymmetry).
- `src/i18n/config.ts` — one `SUPPORTED_LANGUAGES` entry (drives `supportedLngs` + switcher).
- Locale-enumerating tests extended: `tests/i18nParity.test.ts` (LOCALES), `tests/agrolinkBranding.test.ts` (per-locale expectations incl. `noZonesBody`), `tests/devicesI18n.test.ts`, `src/history/__tests__/historyLocaleValues.test.ts` (+ per-locale reviewed-identical sets, e.g. DevEUI), `src/history/__tests__/historyLocaleKeys.test.ts`, `src/journal/__tests__/journalLocales.test.ts`, `src/components/__tests__/LanguageSwitcher.test.tsx`, `src/pages/__tests__/SettingsPage.test.tsx` — exact list confirmed at plan time by grepping locale enumerations.

## RTL direction switch

In `src/i18n/config.ts`: on init and on `languageChanged`, set `document.documentElement.dir = i18n.dir(lng)` and `document.documentElement.lang = lng`. Covered by a vitest that changes language to `ar` and asserts `dir === 'rtl'`, back to `en` asserts `ltr`. No component CSS changes in this slice.

## Task order (each commit shippable)

1. Parity-test plural-group rework (7 existing locales stay green — proves the rework is behavior-preserving).
2. `zh` (translate + register + tests, both trees).
3. `sw` (same).
4. `ar` (same, plus the dir-switch change and its test — hardest plural surface last).
5. Review-pack regeneration (script auto-discovers new locales → `terms-zh/ar/sw.csv`) + README caveat extension (three machine-translated locales, AI-verified only, no human native pass yet).
6. Full gate, final whole-branch review, push to PR #150 (PR body updated).

## Verification

Per task: `npm run typecheck && npm run test:unit` green; parity test proves group parity + per-locale plural completeness + placeholder integrity; per-language reviewer approval. Final: `npm run build`, `git diff --check`, mirror-tree per-key identity check for the three new locales.

## Ship gates & follow-ups

- All three locales are machine translations with AI verification only — human native pass recommended before marketing into zh/ar/sw markets (same gate class as lg, which remains gated for Uganda).
- Follow-up issue (append to the existing PR-#150 follow-up bundle): full RTL layout audit for Arabic (CSS logical properties, icon mirroring, chart axes).
- The 182 post-snapshot English keys caveat applies to the new locales too, trivially: they translate the CURRENT corpus, so they have no snapshot gap.
