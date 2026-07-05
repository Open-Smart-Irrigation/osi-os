# Worker Prompt — SWT pF Display + CSV Export (derive-at-read slice)

You are implementing the **pF display + CSV export slice** for osi-os. Repo: `/home/phil/Repos/osi-os`.

## Read first (your requirements)

1. Spec: `docs/superpowers/specs/2026-07-05-swt-pf-unit-support-design.md` (revised 2026-07-05 — the "derive-at-read" version; if the CSV section shows wide `swt_1_kpa,swt_1_pf` columns you have a stale checkout, stop and rebase)
2. Implementation plan: `docs/superpowers/plans/2026-07-05-swt-pf-display-csv.md`
3. Background (why the invariants exist): `docs/superpowers/prompts/swt-pf-settings-spec-review/review-2026-07-05.md`

The plan is task-by-task with exact code. **Execute it with `superpowers:subagent-driven-development` (fresh subagent per task, review between) or `superpowers:executing-plans`.** TDD; commit per task; branch off `main` first (do not commit to `main`). Verify the revised spec and plan are present on your base branch before starting — they land via `docs/swt-pf-settings-review-updates`.

This design converged through an expert review round plus an independent senior-engineer second opinion. The invariants below are load-bearing — do not regress them.

## Non-negotiable invariants (the review-hardened parts)

- **ZERO schema, trigger, flows.json, or sync-payload changes.** This slice touches only `web/react-gui/` and the `osi-history-helper` (+ tests, CI, contract doc). If you find yourself editing `database/`, any SQLite trigger, `flows.json`, or a sync payload, you have left the slice — stop. (Threshold authoring is a later slice, blocked on issue #92 and a migration-delivery prerequisite.)
- **Conversion rule:** `pF = log10(kPa * 10)`; `kPa = 10^pF / 10`. `NULL`, non-finite, or `<= 0` kPa derives `null`. Converters never clamp and never round; rounding happens only at display (pF `toFixed(2)`) and CSV (4 decimals). Golden vectors: `10 → 2.00`, `30 → 2.4771212547196626`, `60 → 2.7781512503836436`, `300 → 3.4771212547196626`, `0/null → null`. These get pinned in `docs/contracts/sync-schema/canonicalization.md` (plan Task 6).
- **The scheduler is untouched.** Unit choice must never change trigger behavior — that is the core review finding. Nothing in this slice may read or write `threshold_kpa`, `irrigation_schedules`, or the scheduler flow nodes.
- **CSV pairing lives in exactly one choke point:** `rawZoneExportRows` and `csvRowsFromAggregate` inside `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`. The export is tidy long format; each SWT kPa row gets a paired row with `channel_key` + `_pf` suffix, `unit: 'pF'`, `series_label` + `' (pF)'` suffix, value `roundTo(pf, 4)`. Pairing there automatically covers BOTH the on-demand download endpoint and the persisted `/data/exports` rollup CSVs — do not add pF logic anywhere else in the helper.
- **Preference module API is fixed:** localStorage key `osi.display.swtUnit` (`'kPa' | 'pF'`, default `'kPa'`); function names `readDisplayPreferences` / `writeDisplayPreferences` / `useDisplayPreferences` exactly as in the plan — the future settings page extends this module, so renames break a downstream spec. Components never read localStorage directly.
- **Three existing tests in `scripts/test-history-helper.js` legitimately break** when pairing lands (row counts / channel-key sets). The plan lists the exact assertion updates. Update them as specified — do not delete or weaken any test, and do not "fix" a failure by filtering pF rows back out.
- **Profile parity:** after editing the bcm2712 helper, copy it byte-identically to `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js`. `node scripts/verify-profile-parity.js` must pass. Do NOT touch bcm2708 (diverged unmaintained fork).

## Definition of done (gates — all green)

- `node scripts/test-history-helper.js` (all pre-existing tests + the 4 new ones)
- `node scripts/verify-profile-parity.js` and `node scripts/verify-sync-flow.js`
- The new CI step (`node scripts/test-history-helper.js`) added to `.github/workflows/migrations.yml`
- In `web/react-gui/`: `npm run typecheck`, `npm run test:unit`, `npm run build`
- `git diff --check` clean
- New tests prove: golden vectors (both runtimes), preference default kPa + live update, KiwiSensorCard renders `30.0 kPa` by default and `2.48 pF` under the preference, paired pF CSV rows (raw + aggregate), no pF row for `kPa <= 0`

## Scope boundary

- **In scope:** GUI converters/formatter/preference module; Kiwi + Chameleon live SWT values; zone "Soil now"; Soil tab; CSV pairing; bcm2709 mirror; CI step; contract golden-vector pin.
- **Out of scope:** history/analysis chart surfaces (axes, tooltips, soil-profile view — separate follow-up plan), schedule threshold authoring, the settings page UI (until it ships, the preference is set via localStorage), any deploy or gateway access. Kiwi mini-chart axis defs (`KiwiSensorCard.tsx` `SENSORS`) stay kPa.
- Do not use production access. Do not connect to `osicloud.ch` or any gateway.

## Report

Open a PR. In the description: the gate results, confirmation both profiles are byte-identical, the list of pre-existing test assertions you updated (should be exactly the 3 from the plan, plus any the full suite surfaced), and a screenshot or rendered snippet of a CSV export showing a kPa/pF row pair.
