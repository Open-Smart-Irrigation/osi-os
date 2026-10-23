# Soil water status implementation verification

Implemented on `feat/swt-water-status` in `.worktrees/swt-water-status`. Product revision: `2dee79592`; reviewed feature base: `723903425`. The external-review follow-up starts at `d7b81d9ab`.

The Water, KIWI, LSN50 Chameleon, and SDI-12 SWT readings use neutral numbers beside the approved colored dot and translated label. The shared indicator reads the existing history namespace. All seven locales and runtime language switching are tested; no English status fallback was introduced. Classification uses unrounded kPa, including when pF is displayed.

## Checks on the final product revision

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run test:unit` | Node: 193 passed; Vitest: 205 files, 2,114 tests passed |
| `npm run build` | Passed; existing large-chunk and browser-data advisories remain |
| Base-relative `git diff --check` | Passed |
| Default-mode browser matrix | [23 implemented-mode cases passed](checks.json), with `SWT_PREVIEW_MODE` unset on both commands |
| Phone interactions | [Four cases passed](interactions.json): 320/390 px, light/dark |

Browser captures use real components with the design transform disabled. Local fixture responses isolate them from gateway writes. The matrix covers English, Swiss German, French, kPa/pF, stale readings, global Chameleon faults, zero, and a clock one year ahead. There were no page errors, external requests, document or badge overflow, nested buttons, or status live regions.

Additional interaction checks traverse badge ancestors for container overflow after the expand animation settles, tab through both existing history controls, verify visible keyboard focus, and open one history drawer per Enter activation. The badges never receive focus. Switching from kPa to pF preserves every classification. The interactive script is recorded as [check-interactions.mjs](check-interactions.mjs); select a local Playwright installation and fixture URL through environment variables.

Inspected full-page captures at 1440, 390, and 320 px, plus dark Water/device details and the zero/future scenarios. The numeric values stay neutral, labels wrap within their rows, KIWI keeps its sibling history control, and Chameleon keeps a single row button. Zero remains `0.0 kPa`; a future observation supplies neither a current badge nor a last-valid Water value.

- [Desktop light](1440-light-en-kPa-fresh.png)
- [Phone French](390-light-fr-kPa-fresh.png)
- [Narrow phone German](320-light-de-CH-kPa-fresh.png)
- [Dark Water detail](1440-dark-en-kPa-fresh-water.png)
- [Zero in pF mode](390-light-en-pF-zero.png)
- [Future timestamps](390-light-en-pF-future.png)

## Independent review and correction

A fresh Astra review inspected all 16 feature files at `d02783e03`. It found no critical or important issue and suggested two minor improvements. The executor re-graded the historical timestamp finding as important: rejected future dates could contribute to a value described as Last valid. Six new regressions first failed, then passed after limiting historical contributors to parseable timestamps older than three hours. The full suite, typecheck, build, and 23 browser cases passed again at `e5375747e`.

The external-review follow-up closes that deferred test gap. Both global-fault flags are tested with finite readings beside a healthy current device and alone. Further cases cover an open channel beside a healthy channel and a healthy historical value beside a currently faulted device. The global-fault card tests now use finite values.

The follow-up also separates timestamp eligibility from measurement validity. A valid value with a future, missing, or malformed timestamp leaves its value and observation time unavailable and renders the existing localized No reading yet copy. An actual measurement fault still sets invalid when no eligible value exists. Ten timestamp and copy regressions failed before the correction; all 83 focused summary, Water, and Chameleon tests then passed.

KIWI keeps the SWT history button for unavailable values, using the existing translated unavailable label. Three missing-button regressions failed before the correction; all nine KIWI tests passed afterward, including opening the first and second channel histories. Other measurement controls retain their previous behavior.

The preview server and capture script now default to implemented mode. The old default was reproduced failing on the removed KIWI source anchor. The future-scenario browser assertion now checks No reading yet and rejects Invalid reading, No reading since, and Last valid text for an untrusted timestamp.

A fresh follow-up review found no required or optional changes. The reviewer independently ran all four focused suites (92 tests) and 5,418 combinations of timestamps, values, faults, companions, and requested channels. The executor separately completed typecheck, the full 2,114-test GUI suite and 193-test Node suite, production build, the 23-case browser matrix, and all four phone interaction cases. The future-timestamp capture was visually inspected and replaced; captures of unchanged views were retained to avoid binary churn.

Existing card-header controls can truncate names at 320 px. Existing non-status device copy remains English in some translated views, and legacy device footers can display negative age for future timestamps. These behaviors predate this feature.

## Recorded implementation decisions

- Ruling: branch from reviewed 975a40434 rather than origin/main; the user approved the actual card designs from this revision, and a sibling worktree isolates changes without switching their checkout; cost if wrong: rebase and repeat integration/browser checks before merge.
- Task 1: Ruling: return language-neutral status from the unused summarizeSwtValues helper, replacing its English label property, and update its two Node-runner tests; the user explicitly prohibits hardcoded English statuses, and repository search found no production consumers; cost if wrong: an undocumented external consumer would require adaptation.
- Task 2: Ruling: verify all seven shipped locales, not just German; latest user request emphasizes translated Wet/Moist/Dry labels; cost: a small table-driven component test.
- Task 2: Ruling: assert CSS variable tokens through DOM style properties; jest-dom computed-style matching did not preserve variables although jsdom stores them correctly; browser checks will verify the rendered colors.
- Task 4: Ruling: spy on Date.now rather than use fake timers, and preserve existing key-only translation mocks except explicit status labels; freshness is deterministic without changing unrelated async polling or translation assertions; browser checks exercise real translations.
- Task 5: Ruling: keep the Date.now spy approach in the locale suite, retaining pre-existing fake timers in SensorGating; avoids altering established async behavior; both suites and browser checks verify the result.
- Task 6: Ruling: feature allowlist also permits tests/swtCanonical.test.ts as recorded in Task 1; implementation browser evidence lives under previews/swt-water-status/implemented; these document the authorized language-neutral summary and verification; no runtime scope expansion.
- Final: Ruling: re-grade future/invalid timestamps in historical aggregates as Important; a user could read an invented mean and future timestamp as Last valid; require observations with verified historical timestamps; cost if wrong: samples without trusted observation time no longer supply last-valid values.
- Final: Ruling: retain unchanged VWC aggregation and historical-analysis/settings diagnostics; separate quantities and explicitly excluded surfaces; their existing behavior remains outside this SWT card feature.
- Final: Ruling: leave per-input validation of unused summarizeSwtValues outside this change; no production consumer exists and displayed aggregates validate each input; a future consumer must establish its input contract.

The branch remains local with its worktree preserved. The original checkout retains its prior state. No locale JSON, shared UI core, backend, database, scheduler, or cloud code changed.

## Main-based gate run (2026-09-25)

The ten feature commits were lifted onto `origin/main` `72e25b5ca` as branch `feat/swt-water-status-main` (no conflicts; the feature files are byte-identical to the reviewed branch, whose field-tester block is absent on main). Gates on that head: `git diff --check` clean, `npm run typecheck` exit 0, Vitest 198 files / 2,063 tests passed, node runner 178 / 178 passed (0 skipped once `build/` existed), `npm run build` exit 0. The browser matrix was not repeated on the main-based head; the checked files are unchanged. Commit hashes cited above (`2dee79592`, `723903425`, `d7b81d9ab`, `d02783e03`, `e5375747e`, `975a40434`) belong to the development branch `feat/swt-water-status`, which is not merged; they are kept for traceability only. Only the six screenshots linked from this record are kept in the repository; the full capture set stays on that development branch.

## Contrast and colour-vision check (2026-10-19)

Residual R-4 asked for numbers behind the "readable without colour" claim. `contrast-cvd.mjs` in this directory reads the soil, text and surface tokens from `web/react-gui/src/ui-core/tokens.css`, computes WCAG 2.2 contrast ratios, and simulates the three dot colours for protanopia, deuteranopia and tritanopia (Machado, Oliveira and Fernandes 2009, severity 1.0, applied to linear sRGB) and for monochromacy. Pairwise differences are CIEDE2000. The cloud frontend declares the same token values in `frontend/src/index.css`; running the script against that file produced byte-identical output.

Command: `node docs/superpowers/previews/swt-water-status/implemented/contrast-cvd.mjs` (exit 0). Output:

#### Light theme

| State | Dot = border | Wash | Dot/border vs wash | Border vs card | Border vs surface | Wash vs card | Label vs wash |
|---|---|---|---|---|---|---|---|
| wet | #3B82F6 | #DBEAFE | 3.01 | 3.68 | 3.12 | 1.22 | 14.63 |
| moist | #15803D | #DCFCE7 | 4.57 | 5.02 | 4.26 | 1.10 | 16.26 |
| dry | #EF4444 | #FEE2E2 | 3.08 | 3.76 | 3.19 | 1.22 | 14.61 |

| Vision | Simulated wet / moist / dry | ΔE00 wet-moist | ΔE00 wet-dry | ΔE00 moist-dry | L-contrast wet-moist | L-contrast wet-dry | L-contrast moist-dry |
|---|---|---|---|---|---|---|---|
| normal | #3B82F6 / #15803D / #EF4444 | 50.9 | 45.4 | 68.1 | 1.36 | 1.02 | 1.33 |
| protanopia | #418EFA / #817437 / #766C42 | 52.0 | 48.3 | 5.4 | 1.45 | 1.63 | 1.13 |
| deuteranopia | #007DF4 / #756C42 / #A0913E | 48.7 | 57.1 | 16.3 | 1.32 | 1.26 | 1.67 |
| tritanopia | #009EB0 / #007E70 / #FF0046 | 17.4 | 73.2 | 64.4 | 1.55 | 1.22 | 1.27 |
| monochromacy | #858585 / #6F6F6F / #848484 | 8.7 | 0.6 | 8.1 | 1.36 | 1.02 | 1.33 |

#### Dark theme

| State | Dot = border | Wash | Dot/border vs wash | Border vs card | Border vs surface | Wash vs card | Label vs wash |
|---|---|---|---|---|---|---|---|
| wet | #60A5FA | #172B48 | 5.60 | 6.06 | 6.73 | 1.08 | 13.19 |
| moist | #4ADE80 | #173827 | 7.39 | 8.84 | 9.81 | 1.20 | 11.93 |
| dry | #F87171 | #3B1717 | 5.75 | 5.57 | 6.18 | 1.03 | 14.74 |

| Vision | Simulated wet / moist / dry | ΔE00 wet-moist | ΔE00 wet-dry | ΔE00 moist-dry | L-contrast wet-moist | L-contrast wet-dry | L-contrast moist-dry |
|---|---|---|---|---|---|---|---|
| normal | #60A5FA / #4ADE80 / #F87171 | 50.0 | 43.8 | 71.5 | 1.46 | 1.09 | 1.59 |
| protanopia | #81AAFE / #DFCC79 / #918A70 | 50.9 | 38.3 | 22.7 | 1.43 | 1.51 | 2.15 |
| deuteranopia | #6C9CF8 / #CCBF86 / #B3A66E | 48.1 | 47.4 | 6.9 | 1.47 | 1.11 | 1.32 |
| tritanopia | #00B8C4 / #00DBC7 / #FF5B72 | 13.5 | 73.7 | 70.6 | 1.37 | 1.24 | 1.71 |
| monochromacy | #A2A2A2 / #C4C4C4 / #9B9B9B | 9.3 | 2.1 | 11.4 | 1.46 | 1.09 | 1.59 |

OK: dot and border vs wash >= 3:1 in both themes
Pairs under ΔE00 10 (colour alone does not separate them): light protanopia moist-dry ΔE00 5.4; light monochromacy wet-moist ΔE00 8.7; light monochromacy wet-dry ΔE00 0.6; light monochromacy moist-dry ΔE00 8.1; dark deuteranopia moist-dry ΔE00 6.9; dark monochromacy wet-moist ΔE00 9.3; dark monochromacy wet-dry ΔE00 2.1

Findings:

- Every dot and border clears WCAG 1.4.11 (3:1) against its own wash in both themes. Light-theme wet (3.01) and dry (3.08) pass with almost no margin; a lighter wet or dry token would fail. The label text clears 1.4.3 by a wide margin (at least 11.9:1).
- The wash alone barely differs from the card (1.03 to 1.22), so the border, not the wash, outlines the pill. The border clears 3:1 against both the card and the surface in both themes.
- Under simulation, moist and dry fall below a CIEDE2000 difference of 10: 5.4 for protanopia in the light theme and 6.9 for deuteranopia in the dark theme. Both become similar olive tones. Under monochromacy, wet and dry are nearly identical (0.6 light, 2.1 dark). Wet stays distinct from the other two under both red-green simulations.
- The visible label always names the state, so colour was never the only carrier (WCAG 1.4.1 holds). Because two states merge for a red-green dichromat, the dot now also carries a fill level: wet a full disc, moist a half-filled ring, dry an empty ring. The fill uses the same colour token, so the contrast figures above apply to it unchanged. `SwtStatusIndicator.test.tsx` pins the three fill levels on both the edge and the cloud.

The browser matrix was not re-run for the fill-level dot: production builds are not run on this workstation. The dot keeps its 12 px box, so the pill's width and wrapping do not change.
