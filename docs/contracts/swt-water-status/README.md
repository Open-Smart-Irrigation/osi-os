# SWT water-status contract

`vectors.json` pins the classifier behind the Wet / Moist / Dry pill that both GUIs show beside a soil water tension (SWT) value. The design is `docs/superpowers/specs/2026-09-24-swt-water-status-colors-design.md`.

## Rule

The classifier takes the stored canonical kPa, before rounding and before any pF conversion:

| Input | Status |
|---|---|
| `0 <= kPa < 20` | `wet` |
| `20 <= kPa <= 50` | `moist` |
| `50 < kPa <= max_kpa` | `dry` |
| anything else | `null` (no pill) |

"Anything else" covers negative values, values above the cap, non-finite numbers, and every non-number, including numeric strings. `-0.0` compares equal to zero and is `wet`.

## The upper cap

The original spec capped the classifier at 300 kPa, the Chameleon conversion range. The cloud frontend caps at `SWT_DISPLAY_MAX_KPA` (1,000,000 kPa, pF 7), because a Tensiomark can report tensions far above 300 kPa and those readings are dry, not invalid. The contract follows the cloud: `bands.max_kpa` is 1,000,000.

Edge main still caps at 300. The edge Tensiomark field integration moves the edge to the same 1,000,000 kPa domain. Until it lands, `implementations` records each GUI's actual cap, and each side's test expects `null` for a vector above its own cap. When the edge cap changes, update `implementations["osi-os web/react-gui"].max_kpa` in both copies; the edge test fails until the file and the code agree.

## Copies and tests

This directory is canonical. osi-server keeps a byte-identical copy at `docs/contracts/swt-water-status/vectors.json`. Check it from an osi-os checkout with `cmp docs/contracts/swt-water-status/vectors.json ../osi-server/docs/contracts/swt-water-status/vectors.json`.

| Side | Test |
|---|---|
| Edge GUI | `web/react-gui/tests/swtWaterStatusVectors.test.ts` (`npm run test:unit`) |
| Cloud frontend | osi-server `frontend/tests/swtWaterStatusVectors.test.ts` (`npm run test:unit`) |

`non_json_inputs` lists values JSON cannot carry; each test maps the names to `undefined`, `NaN` and the two infinities.

## Out of scope

The history calendar's daily states (`wet_excess` / `optimal` / `dry_stress`, default wet boundary 22 kPa in `osi-history-helper`) are a separate contract and do not follow these vectors. Aligning them is a separate decision (colour residual R-3).
