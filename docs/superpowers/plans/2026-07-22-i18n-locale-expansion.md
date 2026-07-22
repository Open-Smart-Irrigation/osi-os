# AgroLink Locale Expansion Implementation Plan (zh, ar, sw)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Simplified Chinese (`zh`), Arabic (`ar`, with document-direction switch), and Kiswahili (`sw`) to the AgroLink GUI, translated from the repaired English corpus, registered end-to-end.

**Architecture:** Per the approved spec `docs/superpowers/specs/2026-07-22-i18n-locale-expansion-design.md`. One structural change first (plural-group parity in the guard test), then one shippable task per language (translate 9 namespaces → both locale trees, register, extend locale-enumerating tests), then review-pack regeneration and the final gate. Commits append to `fix/i18n-review-repairs-2026-07` (PR #150).

**Tech Stack:** i18next JSON v4 plural suffixes (CLDR cardinal categories per locale), node:test/tsx runner + Vitest, `Intl.PluralRules` for category cross-checks.

## Global Constraints

- **Branch/worktree:** append to `fix/i18n-review-repairs-2026-07` in `/home/phil/Repos/osi-os/.worktrees/i18n-review-repairs`. Never rebase or force-push; PR #150 is open.
- **Mirror rule:** every new locale ships in BOTH trees. Web tree: `web/react-gui/public/locales/<code>/`. Feeds mirror: `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/<code>/`, where each mirror file contains exactly the key set of the MIRROR's `en/<ns>.json` (this reproduces the existing en/mirror asymmetry: `common.restart.*` and `settings.journalTitle/journalDetailLevel*` are web-only). Mechanical filter (run from repo root, per locale):

```bash
node -e '
const fs = require("fs"), path = require("path");
const code = process.argv[1];
const web = "web/react-gui/public/locales", feed = "feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales";
const filter = (src, ref) => {
  if (typeof src === "string") return src;
  const out = {};
  for (const k of Object.keys(ref)) out[k] = filter(src[k], ref[k]);
  return out;
};
fs.mkdirSync(path.join(feed, code), { recursive: true });
for (const f of fs.readdirSync(path.join(web, code))) {
  const src = JSON.parse(fs.readFileSync(path.join(web, code, f), "utf8"));
  const ref = JSON.parse(fs.readFileSync(path.join(feed, "en", f), "utf8"));
  fs.writeFileSync(path.join(feed, code, f), JSON.stringify(filter(src, ref), null, 2) + "\n");
}
console.log("mirrored", code);
' <code>
```

- **Plural categories (source of truth, hardcoded in the guard test):** en, de-CH, fr, it, es, pt, lg, sw → `one, other`; zh → `other`; ar → `zero, one, two, few, many, other`.
- **Do-not-translate glossary (stays Latin in all scripts):** OSI Server, OSI OS, AgroLink, ChirpStack, LoRaWAN, DevEUI, FPort, RSSI, SNR, kPa, pF, ET₀, Kc, VPD, THI, UV, CSV, PNG, GPS, EUI, STREGA, Kiwi, Open-Meteo, OpenAgri.
- **Language conventions:** zh — concise Simplified UI Mandarin, full-width ，。？ where conventional, keep `…` and ASCII parens around Latin tokens; ar — Modern Standard Arabic, formal-neutral, WESTERN (ASCII) digits everywhere, Arabic comma/question mark where conventional, placeholders stay intact LTR tokens; sw — standard Kiswahili (TZ/KE norm), farmer-facing, consistent term choices (irrigation = kumwagilia/umwagiliaji family; farm = shamba).
- **Unified pairs:** the settings/support concepts (Bug, Blocks my work, Workaround available, Annoying, Idea, Improvement↔featureRequest, Saved-waiting-for-internet, share-consent) each get ONE identical translation per locale in both namespaces.
- **predictionAdvisoryWarning** must not be readable as agricultural production in any language.
- Typography: `…` never `...`, `→` never `->` (test-enforced). Preserve every `{{placeholder}}` token exactly.
- **Verification after every task** (from `web/react-gui`): `npm run typecheck && npm run test:unit`. `git diff --check` before commits.
- **Execution model:** Sonnet implementers; per-task review by TWO parallel reviewers (Fable + Opus) on the same review package; a task closes only when both approve; fix waves address the union of their Critical/Important findings.
- **Ship gate (documented, not implemented here):** all three locales are machine translations with AI verification only — human native pass before marketing into those markets; Arabic layout mirroring is a tracked follow-up.

---

### Task 1: Plural-group parity rework of the guard test

**Files:**
- Modify: `web/react-gui/tests/i18nParity.test.ts`

**Interfaces:**
- Produces: `LOCALES` array and `EXPECTED_PLURAL_CATEGORIES` map that Tasks 2–4 each extend by one entry; group-aware key-set comparison that all later tasks rely on.

- [ ] **Step 1: Rewrite the key-set portion of the test** (keep `flatten`, `load`, placeholder/ß/ellipsis tests, adapting placeholder comparison for plural groups). Full replacement content for the structural parts:

```ts
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

// Hardcoded source of truth; an agreement test below keeps it honest vs Intl.
const EXPECTED_PLURAL_CATEGORIES: Record<string, string[]> = {
  en: ['one', 'other'], 'de-CH': ['one', 'other'], fr: ['one', 'other'],
  it: ['one', 'other'], es: ['one', 'other'], pt: ['one', 'other'],
  lg: ['one', 'other'],
};

function splitKeys(keys: string[], pluralBases: Set<string>) {
  const plain = new Set<string>();
  const forms = new Map<string, Set<string>>(); // base -> suffixes present
  for (const key of keys) {
    const m = key.match(PLURAL_SUFFIX);
    const base = m ? key.slice(0, -m[0].length) : key;
    if (m && pluralBases.has(base)) {
      if (!forms.has(base)) forms.set(base, new Set());
      forms.get(base)!.add(m[1]);
    } else {
      plain.add(key);
    }
  }
  return { plain, forms };
}

function pluralBasesFor(ns: string): Set<string> {
  const bases = new Set<string>();
  for (const locale of LOCALES) {
    for (const key of Object.keys(load(locale, ns))) {
      const m = key.match(PLURAL_SUFFIX);
      if (m) bases.add(key.slice(0, -m[0].length));
    }
  }
  return bases;
}

for (const ns of NAMESPACES) {
  test(`locale key sets match en for namespace ${ns} (plural-group aware)`, () => {
    const pluralBases = pluralBasesFor(ns);
    const en = splitKeys(Object.keys(load('en', ns)), pluralBases);
    for (const locale of LOCALES.slice(1)) {
      const loc = splitKeys(Object.keys(load(locale, ns)), pluralBases);
      assert.deepEqual([...loc.plain].sort(), [...en.plain].sort(),
        `${locale}/${ns}.json plain key set differs from en`);
      assert.deepEqual([...loc.forms.keys()].sort(), [...en.forms.keys()].sort(),
        `${locale}/${ns}.json plural-group set differs from en`);
      for (const [base, suffixes] of loc.forms) {
        assert.deepEqual([...suffixes].sort(), [...EXPECTED_PLURAL_CATEGORIES[locale]].sort(),
          `${locale}/${ns}.json "${base}" must carry exactly the CLDR forms for ${locale}`);
      }
    }
    for (const [base, suffixes] of en.forms) {
      assert.deepEqual([...suffixes].sort(), [...EXPECTED_PLURAL_CATEGORIES.en].sort(),
        `en/${ns}.json "${base}" must carry exactly the CLDR forms for en`);
    }
  });
}

test('EXPECTED_PLURAL_CATEGORIES agrees with Intl.PluralRules', () => {
  for (const locale of LOCALES) {
    const intl = [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories].sort();
    assert.deepEqual(intl, [...EXPECTED_PLURAL_CATEGORIES[locale]].sort(),
      `Intl disagrees for ${locale} — investigate before trusting either`);
  }
});
```

Placeholder test adaptation: for suffixed keys of a plural group, compare the locale form's `{{...}}` token set against the EN group's `_other` form; plain keys compare per-key as today.

- [ ] **Step 2: Run against the existing 7 locales** — `npx tsx --test tests/i18nParity.test.ts` → PASS (proves behavior-preserving; the journal bare-base + `_one/_other` coexistence pattern must be handled by the plain/forms split: bare bases are plain keys).
- [ ] **Step 3: Full suite** — `npm run typecheck && npm run test:unit` → PASS.
- [ ] **Step 4: Commit** — `test: plural-group-aware i18n parity (prep for zh/ar/sw)`.

---

### Tasks 2–4: One language per task — zh (Task 2), sw (Task 3), ar (Task 4)

**Files (per language `<code>`):**
- Create: `web/react-gui/public/locales/<code>/{accountLink,auth,common,dashboard,devices,history,journal,settings,support}.json`
- Create: `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/<code>/*.json` (via the mirror filter script — Global Constraints)
- Modify: `web/react-gui/src/i18n/config.ts` (one `SUPPORTED_LANGUAGES` entry: zh → `{ code: 'zh', label: '中文' }`; sw → `{ code: 'sw', label: 'Kiswahili' }`; ar → `{ code: 'ar', label: 'العربية' }`)
- Modify: `web/react-gui/tests/i18nParity.test.ts` (add locale to `LOCALES` + `EXPECTED_PLURAL_CATEGORIES` per Global Constraints)
- Modify: every other locale-enumerating test — discover the authoritative list with `grep -rln "'lg'" web/react-gui/src web/react-gui/tests` and extend each enumeration/table with the new locale (known set: `tests/agrolinkBranding.test.ts` incl. per-locale expected strings, `tests/devicesI18n.test.ts`, `src/history/__tests__/historyLocaleValues.test.ts` (+ a reviewed-identical Set for glossary-identical values such as the DevEUI field labels), `src/history/__tests__/historyLocaleKeys.test.ts`, `src/journal/__tests__/journalLocales.test.ts`, `src/components/__tests__/LanguageSwitcher.test.tsx`, `src/pages/__tests__/SettingsPage.test.tsx`, `src/branding/__tests__/agrolink.test.ts`, journal capture tests if they enumerate locales)

**Task 4 (ar) additionally:**
- Create: `web/react-gui/src/i18n/direction.ts`:

```ts
const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur'];

export function documentDirectionFor(lng: string): 'ltr' | 'rtl' {
  return RTL_LANGUAGES.some((c) => lng === c || lng.startsWith(`${c}-`)) ? 'rtl' : 'ltr';
}

export function applyDocumentDirection(lng: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dir = documentDirectionFor(lng);
  document.documentElement.lang = lng;
}
```

- Modify: `web/react-gui/src/i18n/config.ts` — `import { applyDocumentDirection } from './direction';`, then after the `.init({...})` chain: `i18n.on('languageChanged', applyDocumentDirection);` and `applyDocumentDirection(i18n.language ?? 'en');`
- Create: `web/react-gui/src/i18n/__tests__/direction.test.ts` (Vitest): `documentDirectionFor('ar') === 'rtl'`, `('ar-EG') === 'rtl'`, `('en') === 'ltr'`, `('zh') === 'ltr'`; `applyDocumentDirection('ar')` sets `document.documentElement.dir === 'rtl'` and `lang === 'ar'`; `applyDocumentDirection('en')` restores `ltr`.

**Interfaces:**
- Consumes: Task 1's `EXPECTED_PLURAL_CATEGORIES`; the enhanced English corpus as translation source.
- Produces: a fully registered locale; later tasks only regenerate the pack.

**Steps (identical recipe per language):**
- [ ] **Step 1: Translate all 9 namespaces** from `web/react-gui/public/locales/en/` (1,325 strings), following Global Constraints conventions. Plural groups: enumerate with `grep -hoE '"[A-Za-z0-9_.]+_(one|other)"' web/react-gui/public/locales/en/*.json | sort -u`; produce the locale's exact CLDR form set per group (zh: `_other` only; sw: `_one`+`_other`; ar: all six — for ar, forms for 0/1/2 must be genuine Arabic number agreement, not copies).
- [ ] **Step 2: Mirror** via the filter script; spot-check one namespace diff.
- [ ] **Step 3: Register + extend tests** (files above). For `agrolinkBranding.test.ts` per-locale expectation tables, insert the new locale's actual translated strings.
- [ ] **Step 4: Verify** — `npx tsx --test tests/i18nParity.test.ts` (proves group parity + CLDR form completeness + placeholders for the new locale), then `npm run typecheck && npm run test:unit` → PASS.
- [ ] **Step 5: Commit** — `feat(i18n): add <Language> (<code>) locale` (ar commit also carries direction.ts + config wiring + its test).

---

### Task 5: Review-pack regeneration + README caveats

**Files:**
- Modify: `docs/i18n-review/terms-*.csv` (regenerated; three new files appear: terms-zh.csv, terms-ar.csv, terms-sw.csv)
- Modify: `docs/i18n-review/README.md`

- [ ] **Step 1:** `node scripts/export-i18n-review-pack.mjs` → nine CSVs, 1,325 rows each.
- [ ] **Step 2:** README: change "six non-English locales" phrasing to nine; add a paragraph after the 182-row caveat: zh/ar/sw are 2026-07-22 machine translations from the repaired English, AI-verified only, no human native pass; Arabic ships with document-direction switching but full RTL layout mirroring is a tracked follow-up.
- [ ] **Step 3:** `npm run test:unit` → PASS; commit — `docs(i18n): regenerate review pack with zh/ar/sw; provenance notes`.

---

### Task 6: Final gate + PR update

- [ ] **Step 1:** From `web/react-gui`: `npm run typecheck && npm run test:unit && npm run build` → PASS. From repo root: `git diff --check` → clean.
- [ ] **Step 2:** Mirror per-key identity check for zh/ar/sw (the parity test covers the web tree; for the mirror, diff each mirror file's key set against mirror en and values against the web tree).
- [ ] **Step 3:** Final incremental whole-branch review (Fable + Opus in parallel) over the expansion commits; fix wave if findings.
- [ ] **Step 4:** Push; update PR #150 title/body (`gh pr edit`) — add the locale-expansion section, the three-locale machine-translation ship gate, and the Arabic RTL follow-up to the follow-up bundle.

## Self-Review (authoring time)

- Spec coverage: plural rework → T1; three locales → T2–4; RTL dir switch → T4; pack + caveats → T5; gate/PR → T6. Digits/register/glossary/unified-pairs constraints carried in Global Constraints.
- No placeholders: test code, filter script, direction module, and registration entries are given verbatim; translation content is generated work product with mechanical verification (parity test) and dual review.
- Type consistency: `EXPECTED_PLURAL_CATEGORIES` keys match `LOCALES` extensions; `documentDirectionFor` signature matches its test.
