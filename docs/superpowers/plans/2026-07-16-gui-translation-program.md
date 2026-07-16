# GUI translation program — translate the whole AgroLink/OSI OS GUI

**Date:** 2026-07-16
**Goal (product owner, 2026-07-16):** every GUI string is translated into all seven shipped
locales. **Catalog labels stay English for now** — that decision is unchanged and out of
scope here (see `2026-07-16-journal-catalog-completeness.md` F2/N2).
**Status:** wave 1 (journal) DONE; waves 2–3 specified, not started.

## Why this needs a plan rather than a sweep

The GUI is not uniformly translated, and the gap is not where you would guess. Measured by
counting strings whose locale value is byte-identical to English, across the 6 non-English
locales:

| namespace | strings | untranslated (×6) | share |
|---|---|---|---|
| `history` | 414 | **2360** | 95% |
| `journal` | 127 | **762** | 100% |
| `accountLink` | 51 | 144 | 47% |
| `devices` | 212 | 49 | 4% |
| `settings` | 55 | 43 | 13% |
| `dashboard` | 26 | 20 | 13% |
| `support` | 74 | 15 | 3% |
| `auth` | 26 | 8 | 5% |
| `common` | 59 | 8 | 2% |
| **total** | **1044** | **3409** | |

So `history` and `journal` are 92% of the whole problem, and everything else is a long tail
of individual misses. Luganda is **not** the weak locale people assume: `lg` is 96–100%
translated in `auth`, `common` and `support`. It is untranslated in exactly the same two
namespaces as every other language, because those two namespaces were never translated at
all.

## The trap this program has to avoid

`journal.json` shipped with a **complete key tree whose values were English**. Key-parity
tests passed. Worse, `journalLocales.test.ts` actively asserted
`expect(resource.capture).toEqual(en.capture)` — a test that *required* the placeholder.

A key-presence test cannot see this class of bug. Every wave below therefore ends with a
**value-level** parity test: for each locale, the set of keys whose value equals English must
equal an explicit, reviewed allowlist of strings that are legitimately shared (proper nouns,
loanwords). Anything else identical fails. That pins both directions — an untranslated
regression and an unreviewed new shared string.

## Constraints that apply to every wave

- **Feed mirror.** `web/react-gui/public/locales/` is mirrored to
  `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/`, and
  `web/react-gui/tests/agrolinkBranding.test.ts` enforces byte-identity for
  `auth.json`, `dashboard.json`, `devices.json`, `history.json`. **Wave 2 touches `history`,
  so it must write both trees or that test goes red.** `journal.json` is not yet mirrored —
  adding it is Slice 2 Phase 6's job, not this program's.
- **Placeholders** (`{{username}}`, `{{min}}`, `{{max}}`) survive verbatim.
- **de-CH is Swiss German: never `ß`, always `ss`.** Formal *Sie*, matching existing files.
- **pt is inconsistent today**: `common.json` uses European ("A carregar…"), `support.json`
  uses Brazilian ("Carregando…"). Waves follow the dominant European convention and the
  divergence in `support.json` is recorded as tech debt, not silently "fixed".
- Reuse established terminology rather than coining new terms. Glossary derived from the
  already-translated namespaces; Zone = *Ekitundu*/*Zone*/*Zona*, Add = *Yongera*, etc.
- Agronomic terms in the GUI (activity names, plot vs zone) get the conventional
  agricultural term, and anything uncertain is listed for native review rather than guessed
  silently.

## Wave 1 — `journal` (762 strings) — DONE

The active feature; blocks nothing else but is the most visible. One worker per locale,
each given the glossary plus that locale's existing `dashboard`/`common`/`devices` files for
tone. Ends with the value-level parity test replacing the English-pinning assertion.

**Gate:** key parity, zero `ß` in de-CH, placeholders intact, value-parity test green,
`npm run test:unit`, `npx tsc --noEmit`, `npm run build`, browser spot-check of the de-CH
capture flow at 320px (the header already proved translated labels change layout).

## Wave 2 — `history` (2360 strings) — the elephant

414 strings, 95% untranslated, and **mirrored + enforced**. This is 69% of the program.

Decompose per locale as in wave 1, but note `history` is chart/analytics vocabulary
(axis labels, statistics, diagnostics) rather than farm-record vocabulary, so it needs its
own glossary pass first: series, rollup, axis, min/max, percentile, drought index, etc.
Several strings are template-heavy and will need placeholder care.

**Gate:** wave 1's gate, plus `agrolinkBranding.test.ts` green (proves both trees written),
plus the existing `localizes thematic history empty-zone copy in all bundled locales` test.

## Wave 3 — long tail (287 strings)

`accountLink` 144 (47% — a half-done namespace), then the scattered misses in
`devices` 49, `settings` 43, `dashboard` 20, `support` 15, `auth` 8, `common` 8. Small
enough to do in one pass per locale once the value-parity test exists to enumerate them.

**Gate:** the value-parity test extended to every namespace, so the allowlist becomes the
single reviewed record of "legitimately English" strings across the whole GUI.

## Open question for the product owner

Native review. The spec's §6.4 native-review requirement is written about *catalog* labels,
and catalog labels are explicitly staying English, so it does not formally bind this program.
But `de-CH`, `fr` and `lg` GUI copy still ends up in front of farmers, and `lg` serves the
live Uganda gateway. These waves produce reviewable drafts with uncertain terms flagged
rather than buried; who signs them off is still unanswered.
