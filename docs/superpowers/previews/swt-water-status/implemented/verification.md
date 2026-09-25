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
