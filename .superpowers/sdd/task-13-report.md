# Task 13 — Verification Report (Steps 1–3)

Branch: `fix/i18n-review-repairs-2026-07`
Worktree: `/home/phil/Repos/osi-os/.worktrees/i18n-review-repairs`
Scope: this report covers Steps 1–3 only (full gate, whitespace check, findings-closure audit). Step 4 (finish-the-branch / PR) is explicitly out of scope and was not performed — no PR was created, no push was made.

## Step 1 — Full gate (`web/react-gui/`)

Command: `npm run typecheck && npm run test:unit && npm run build`
Result: **PASS** (exit code 0)

- **typecheck** (`tsc --noEmit`): passed silently, no diagnostics printed. Because the command chain is `&&`, the fact that `test:unit` and `build` both ran to completion is itself proof `tsc` exited 0.
- **test:unit**: two runners, both green.
  - `test:unit:tsx-runner` (`tsx --test 'tests/**/*.test.ts'`): `tests 114, suites 1, pass 113, fail 0, cancelled 0, skipped 1, todo 0`. The one skip is expected/benign: *"built default index chunk does not contain echarts after build — SKIP build/assets is absent; run npm run build before enforcing bundle output"* (this check runs before `npm run build` in the script chain, so `build/` doesn't exist yet at that point).
  - `test:unit:vitest` (`vitest run --passWithNoTests`): `Test Files 159 passed (159)`, `Tests 1570 passed (1570)`, duration 37.40s.
  - Notably green: the i18n parity guard tests (`locale key sets match en` / `placeholder tokens match en` for all 9 namespaces), `de-CH never uses ß (Swiss convention)`, and `no ASCII three-dot ellipsis or -> arrow in any locale` — all passing, confirming Tasks 1–12's structural guarantees hold.
- **build** (`vite build`): succeeded, `✓ 1704 modules transformed`, `✓ built in 7.16s`.

### Build warnings (benign, pre-existing — not caused by this branch's changes)
- `[baseline-browser-mapping] The data in this module is over two months old.` — stale caniuse dependency data, repo-wide/pre-existing.
- `Browserslist: browsers data (caniuse-lite) is 8 months old.` — same category, pre-existing.
- Rollup chunk-size warning: `analysis-echarts-DOTAK0kg.js` (1,036.20 kB) and `index-CrZBEGxm.js` (1,503.95 kB) exceed the 500 kB warning threshold. Pre-existing bundle-size characteristic of the app (echarts + main bundle), unrelated to i18n locale changes.

No errors, no new/unexpected warnings.

## Step 2 — Whitespace check

Command (repo root): `git diff --check`
Result: **clean** (exit code 0, no output).

## Step 3 — Findings-closure audit

### Method

Wrote `.superpowers/sdd/audit-findings.js` (uncommitted, scratch tool only — not part of the deliverable, safe to delete). For every row in each `findings-{lang}.csv`, the script:

1. Resolves the **baseline value** (the value the reviewer actually saw) by reading the locale JSON at commit `96b36da64451a323b8c7979b0cb959476a9d07e8` — the merge-base with `design-sync/agrolink`, i.e. the exact repo state immediately before Task 1 (the first i18n-repair commit, `94a174bc`). This is ground truth for "what was wrong," rather than inferring it from the free-text `finding` column.
2. Resolves the **current value** from the working tree (HEAD; locale files have no uncommitted changes — only `task-12-report.md` and untracked `node_modules/` are dirty per `git status`).
3. Classifies each row, in priority order:
   - Key absent from the current locale file and in the known superseded set (`devices/kiwiSensor.intervalPending`, `devices/stregaValve.intervalPending`, `devices/environment.local.freshSensors`) → **SKIPPED_PLURAL**.
   - Key absent and *not* in that set → **ANOMALY** (would need manual investigation; none occurred).
   - Value changed (current ≠ baseline) and `category == punctuation` with an `ASCII '...'` finding → **SKIPPED_ELLIPSIS**.
   - Value changed and `namespace/key` is one of the 33 rows in `manifest-table.md` → **MANIFEST_RETRANSLATED**.
   - Value changed, neither of the above → **CLOSED**.
   - Value unchanged (current == baseline, byte-identical) → **OPEN**, regardless of category — this deliberately overrides the ellipsis/manifest shortcuts so a row can never be silently hidden as "handled" if nothing actually changed.

This is stricter than a suggestion-string match: it uses the real pre-repair value as the trigger, so a row is only ever "closed" if something was actually edited, not merely because it belongs to a bucket the plan expected to be closed.

### Per-language results

| Language | Total | Closed | Skipped (ellipsis) | Skipped (plural) | Manifest (retranslated) | **Open** | Anomaly |
|---|---:|---:|---:|---:|---:|---:|---:|
| en | 91 | 24 | 31 | 2 | 33 | **1** | 0 |
| de-CH | 68 | 27 | 28 | 0 | 13 | **0** | 0 |
| fr | 55 | 38 | 1 | 3 | 13 | **0** | 0 |
| it | 69 | 47 | 0 | 3 | 19 | **0** | 0 |
| es | 40 | 21 | 0 | 0 | 19 | **0** | 0 |
| pt | 63 | 52 | 0 | 1 | 10 | **0** | 0 |
| lg | 97 | 90 | 0 | 0 | 5 | **2** | 0 |
| **Total** | **483** | **299** | **60** | **9** | **112** | **3** | **0** |

Zero anomalies: no CSV row referenced a key that vanished from a locale file outside the three known plural-split keys, and no row referenced a key absent from the pre-repair baseline. `483` matches the brief's stated total exactly (en 91 / de 68 / fr 55 / it 69 / es 40 / pt 63 / lg 97).

### Every strict-OPEN row (byte-identical to the pre-repair baseline)

**1. `en / devices / kiwiSensor.badge`** (low, i18n-style)
- Finding: *"ALL-CAPS is baked into source strings (also SETTINGS, SOIL WATER TENSION 1…2, STATUS…). Prefer normal case in strings + CSS text-transform so each locale controls casing."*
- Suggestion column: **empty** — the reviewer gave no replacement text, only an architectural recommendation (move casing to CSS `text-transform` instead of baking `KIWI SENSOR` in uppercase into the string).
- Baseline == current == `"KIWI SENSOR"`.
- **Assessment: correctly left open.** This is a code-level refactor (component/CSS change), not a copy fix, and is out of scope per the plan's own self-review ("nothing else in the findings requires code" beyond the plural-key antipattern in Task 5). No text edit was possible here since none was proposed.

**2. `lg / accountLink / backToDashboard`** (low, consistency)
- Finding: capitalization mismatch between `accountLink.backToDashboard` ("Ddayo ku Dashboard") and `settings.backToDashboard` ("Ddayo ku dashboard", lowercase) for the same English string.
- Suggestion: `Ddayo ku Dashboard` — **identical to both baseline and current value**.
- **Assessment: correctly left open / no-op.** The reviewer's suggestion for *this* key is simply "keep as-is"; the inconsistency's fix belongs on the sibling `settings.backToDashboard` key, not this one. Nothing to change here.

**3. `lg / journal / plot.layout`** (low, consistency)
- Finding: *"Layout" is left in English here... If this is a distinct technical concept from chart "Layout", consider a distinguishing Luganda term rather than reusing the bare English word...* — phrased as a conditional judgment call, not a mandated fix.
- Suggestion: `Layout` — **identical to both baseline and current value**.
- **Assessment: correctly left open / no-op.** The finding itself doesn't commit to a required replacement (the suggestion column echoes the current text), so there was nothing actionable to apply.

No other rows, in any language, are byte-identical to their pre-repair baseline value.

### Cross-check: the lg `devices.schedule.average` WM1+WM2 exception

This row does **not** appear in the strict-OPEN list above, because the lg string *did* change (`"Wakati (WM1 + WM2)"` → `"Omutindo gwa wakati (WM1 + WM2)"` — the low-severity "naturalness" issue about the ambiguous word for "Average" was fixed), but it still contains the raw `WM1 + WM2` legacy jargon that the English source's *high*-severity finding on the same key replaced with `SWT 1 + SWT 2` (and that all 6 other locales matched — see below). I verified this two ways:

1. **Repo-wide grep** for `WM1|WM2` under `web/react-gui/public/locales/`: the **only** remaining hit anywhere in any locale file is `lg/devices.json`'s `schedule.average` value. All other locales read cleanly translated (`en: "Average (SWT 1 + SWT 2)"`, `de-CH: "Durchschnitt (Bodenwasserspannung 1 + 2)"`, `fr: "Moyenne (Tension 1 + Tension 2)"`, `it: "Media (Tensione idrica del suolo 1 + 2)"`, `es: "Promedio (Tensión 1 + Tensión 2)"`, `pt: "Média (Tensão hídrica do solo 1 + 2)"`).
2. **Source verification** (also independently confirmed by a sub-agent read): `web/react-gui/src/components/farming/ScheduleSection.tsx`'s `SwtForm` sub-component (lines ~88–105) renders the SWT-metric dropdown with **hardcoded English string literals** (`"Sensor 1"`, `"Sensor 2"`, `"Sensor 3"`, `"Mean (all sensors)"`) — it never calls `t('schedule.average')`, even though the same file calls `useTranslation('devices')` and does use `t('schedule.*')` for every other string in view (`schedule.saved`, `schedule.enabled`, `schedule.on`/`off`, `schedule.loadingSchedule`, etc., lines 317–406). A repo-wide grep for `schedule.average`/`schedule:average` outside `public/locales`/`build` returns zero matches.

**Conclusion: the `devices.schedule.average` key is orphaned/unreachable in the live UI for every locale, not just lg** — this is a pre-existing dead-code condition in `ScheduleSection.tsx`, unrelated to and out of scope for this i18n-repair branch. The lg string's residual `WM1 + WM2` therefore has no user-visible effect in the current app. This matches — and confirms as accurate — the deliberately-open item named in the task brief. **No other OPEN row of this "changed-but-incompletely" kind was found**: the `WM1|WM2` grep is exhaustive and turned up nothing else.

### Step 5 — Workbook inputs untouched (read-only check)

```
$ ls -la /home/phil/Repos/osi-os/tmp/i18n-review-2026-07-21/
total 168
-rw-r--r-- 1 phil phil 18607 Jul 21 22:26 findings-de-CH.csv
-rw-r--r-- 1 phil phil 15266 Jul 21 22:26 findings-en.csv
-rw-r--r-- 1 phil phil 10611 Jul 21 22:26 findings-es.csv
-rw-r--r-- 1 phil phil 15379 Jul 21 22:26 findings-fr.csv
-rw-r--r-- 1 phil phil 25037 Jul 21 22:26 findings-it.csv
-rw-r--r-- 1 phil phil 49613 Jul 21 22:26 findings-lg.csv
-rw-r--r-- 1 phil phil 14645 Jul 21 22:26 findings-pt.csv
-rw-r--r-- 1 phil phil  7144 Jul 21 22:26 review-notes.json
```

All 8 files share a single mtime (`Jul 21 22:26`), consistent with a one-shot generation and no later edits. Row counts (`wc -l`, minus header) match the brief's stated per-language totals exactly.

## Summary

- Gate: typecheck / test:unit (114+1570 tests) / build all **PASS**. `git diff --check` **clean**.
- 483/483 findings accounted for; 480 closed via a repo-wide sweep, plural-key split, manifest retranslation, or a direct fix; 3 strictly open, all verified as correct no-ops (2 have empty/self-referential suggestions requiring no text change, 1 needs a CSS/code change outside this branch's scope).
- The one "changed but incomplete" item flagged in advance (lg `devices.schedule.average` WM1+WM2) was independently re-verified as functionally unreachable dead code in `ScheduleSection.tsx`, confirmed by both a direct grep/read and an independent sub-agent read of the same file.
- No anomalies, no other OPEN rows, no other findings-CSV keys missing from the current locale files outside the three known plural-split keys.

## Note on this file

This path (`.superpowers/sdd/task-13-report.md`) previously held an unrelated report (a database/journal-schema performance task, apparently a stale artifact of task-number reuse in `.superpowers/sdd/` from a different plan). It has been overwritten with this i18n-repair Task 13 report as instructed by the current task brief.

## Final-review fix wave (2026-07-22)

Applied the three pre-merge fixes identified by the whole-branch final review, on branch `fix/i18n-review-repairs-2026-07`.

1. **`docs/i18n-review/README.md`** — provenance caveat + semantics reconciliation:
   - Added a "Provenance caveat" paragraph after the "What's here" bullet list stating that 182 of the 1,325 rows postdate the 2026-07-21 native-speaker review (post-snapshot growth, mostly `journal.*` incl. `tankMix`, plus `settings.journal*` and `common.restart.*`) and have had no native review pass; the 2026-07 repair branch fixed the 483 findings raised against the original 1,140-row snapshot.
   - Rewrote the `shared_with_english = yes` description in "What's here" to the mechanical meaning (byte-identical to English — brand names, units, acronyms, international loanwords), removing the "deliberately left identical … intentional, not gaps" framing that contradicted the "Regenerating this pack" section.
   - Softened "The AgroLink GUI is fully translated" to "fully translated as of the original snapshot; see the caveat below for rows added since."

2. **lg unification** (both `web/react-gui/public/locales/lg/settings.json` and `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/lg/settings.json`):
   - `featureRequest`: "Okusaba ekintu ekipya" → "Okulongoosa" (now byte-identical to `support.json` `types.improvement`).
   - `requestSubmitting`: "Kitereka…" → "Kutereka…" (now byte-identical to `support.json` `form.submitting`).
   - `backToDashboard`: "Ddayo ku dashboard" → "Ddayo ku Dashboard" (matches `accountLink`/`support`/`common` casing).
   - Verified byte-identity programmatically in both trees post-edit: `featureRequest == types.improvement` and `requestSubmitting == form.submitting` both `True`.

3. **`web/react-gui/src/components/farming/StregaValveCard.tsx`** (`applyInterval`, ~line 229) — removed the stale `defaultValue: 'Interval change requested for {{closed}} min closed / {{opened}} min opened.'` and the now-unused `closed`/`opened` interpolation options from the `stregaValve.intervalPending` call, left only `count: closedMinutes` to match the current plural key (`intervalPending_one`/`intervalPending_other`, which interpolates only `{{count}}`).

### Test evidence

- `npx tsx --test tests/i18nParity.test.ts tests/agrolinkBranding.test.ts` — 30/30 pass.
- `npm run typecheck` — clean, no errors.
- `npm run test:unit` — 114/114 (tsx runner) + 1570/1570 (vitest) pass.
- `npx tsx --test tests/stregaValveCard.test.ts` — 8/8 pass (explicit run per contract).

All changes committed as a single commit: `fix(i18n): final-review fixes — review-pack provenance, lg unification, stale defaultValue`.
