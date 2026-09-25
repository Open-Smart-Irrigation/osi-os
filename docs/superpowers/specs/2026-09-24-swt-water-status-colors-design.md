# SWT water-status colors design

**Status:** Proposed for implementation

**Decision:** Add one shared, text-labeled status indicator to current soil-water-tension readings. Classify the original kPa value with VIA Chameleon bands, keep numeric values and card surfaces neutral, and retain irrigation-trigger proximity as separate information.

## Intent

Farmers should be able to scan a KIWI, SDI-12 Tensiomark, LSN50 Chameleon, or zone Water card and recognize the current soil-water state without interpreting a raw tension value. The treatment must match the VIA Chameleon convention:

| Canonical SWT value | Status | Color |
|---|---|---|
| `0 <= kPa < 20` | Wet | Blue |
| `20 <= kPa <= 50` | Moist | Green |
| `50 < kPa <= 300` | Dry | Red |

VIA describes the product bands as blue below 20 kPa, green from 20 to 50 kPa, and red above 50 kPa. Its product page and FAQ use the same nominal 20/50 boundaries, while noting that physical sensor switch points vary slightly. The GUI uses the nominal boundaries because it receives calibrated numeric kPa rather than an LED state. Sources: [VIA Chameleon sensor](https://via.farm/chameleon-soil-water-sensor/), [VIA FAQ](https://via.farm/faq/), and [VIA Wi-Fi reader](https://via.farm/chameleon-wi-fi-reader/).

Success means:

- every current SWT channel shown on the three named device-card families has its own blue Wet, green Moist, or red Dry indicator;
- the Water card's current tension value uses the same classifier;
- pF display mode changes only the formatted number, never the classification;
- missing, invalid, faulted, or stale telemetry receives no water-status color;
- status remains understandable without color and does not weaken the existing history-button affordance; and
- SDI-12 Tensiomark contributes tension, rather than being misclassified as volumetric water content, in the Water card.

## Current behavior and gaps

`web/react-gui/src/utils/swt.ts` already canonicalizes legacy KIWI aliases and formats kPa or pF. Its unused `summarizeSwtValues()` helper still says Wet below 20 kPa, Moderate below 60 kPa, and Dry at 60 kPa or above. `IrrigationZoneCard.tsx` repeats the same 20/60 fallback. Neither matches VIA's 20/50 convention.

The presentation is split across four consumers:

- `KiwiSensorCard.tsx` renders two possible SWT channels as individual tiles.
- `DraginoTempCard.tsx` renders up to three Chameleon channels inside history buttons.
- `Sdi12SoilCard.tsx` renders `swt_N` alongside other quantities and displays both kPa and pF for SWT.
- `IrrigationZoneCard.tsx` renders one selected tension value under “Soil now.” It may also describe that value relative to a configured irrigation trigger.

Two data-selection defects affect an honest status display. `zoneSoil.ts` treats every `DRAGINO_SDI12` as volumetric, although the Tensiomark profile writes canonical `swt_1`. It also pools stale and fresh contributors before assigning the newest contributing timestamp, so a mixed aggregate can look current. The design fixes both in the UI summary path; it does not change the scheduler.

The palette already exists in `web/react-gui/src/ui-core/tokens.css`: `--soil-wet`, `--soil-moist`, `--soil-dry`, and their `-bg` washes have light- and dark-theme values. All seven `history.json` locale bundles already carry `history.soil.state.wet`, `.moist`, and `.dry`. No palette or locale additions are required.

## Expert-board review and vote

Three fresh, read-only agents inspected the repository and received the same evidence packet. None saw another review before voting.

| Reviewer role | Model | First choice | Ranking |
|---|---|---|---|
| Agronomy and sensor semantics | GPT-6 Astra | Shared labeled indicator | B > A > C |
| Field UX, accessibility, and themes | GPT-5.6 Sol | Shared labeled indicator | B > A > C |
| Frontend architecture and testing | GPT-6 Astra | Shared labeled indicator | B > A > C |

The board compared three approaches:

1. **A: Color the numeric value.** This is compact, but it relies on color alone, conflicts with existing hover colors on history buttons, and produces insufficient small-text contrast for the light-theme wet and dry colors.
2. **B: Add a shared dot-and-label indicator on neutral surfaces.** This keeps exact values readable, supplies a non-color cue, works per depth, and places the classification in one tested function. The board selected this approach unanimously.
3. **C: Tint each full tile and border.** This is visually strong, but red reads like a device fault, multiple depths create competing slabs, and colored borders obscure hover and focus states.

The vote added six binding amendments: use unrounded canonical kPa; classify each depth separately; recognize SDI-12 Tensiomark as tension; gate status on validity and freshness; exclude stale or faulted contributors from a current aggregate; and show VIA status independently from the irrigation trigger.

## Domain contract

Add `SwtWaterStatus = 'wet' | 'moist' | 'dry'` and `classifySwtWaterStatus(value: unknown): SwtWaterStatus | null` to `utils/swt.ts`.

The classifier accepts only finite numbers in the canonical stored range `[0, 300]`. It returns:

```text
wet    for 0 <= value < 20
moist  for 20 <= value <= 50
dry    for 50 < value <= 300
null   otherwise
```

Classification happens before rounding and before `kpaToPf()`. Thus `19.999` is Wet, `20` is Moist, `50` is Moist, and `50.001` is Dry. A numeric string is invalid. Zero is valid Wet even though its pF representation is undefined; when pF mode cannot format zero, the card displays `0.0 kPa` rather than an em dash so a real reading is not hidden.

`summarizeSwtValues()` must delegate to this classifier if it remains exported. It returns a language-neutral status code, with user-visible labels resolved from the existing locale resources. It may not retain a competing 60 kPa boundary or hardcoded English labels.

VIA status is descriptive, not an irrigation command. The UI must not translate the states into “safe,” “overwatered,” or “irrigate now.” Crop, depth, salinity, and the farm's configured trigger still affect the operator's decision.

## Shared visual indicator

Create `components/farming/shared/SwtStatusIndicator.tsx`. It accepts a preclassified status or `null`; it owns no fetching, device rules, freshness calculation, or history interaction.

The indicator is a compact pill on the existing neutral card surface:

```text
┌───────────────┐
│ ●  Moist      │
└───────────────┘
```

- The 12 px dot and 1 px pill border use `--soil-wet`, `--soil-moist`, or `--soil-dry`.
- The pill wash uses the matching `--soil-*-bg` token.
- The visible label uses neutral `--text`, not the status color. This preserves body-text contrast in both themes.
- The dot is `aria-hidden`; the translated Wet, Moist, or Dry text supplies the accessible cue.
- The element has no `role="status"`, because normal telemetry refreshes must not create live-region announcements.
- The indicator is never independently interactive. When it sits inside an existing history button, the whole row remains the one button.

The locale files nest these labels at `history.soil.state.wet`, `.moist`, and `.dry`. With `useTranslation('history')`, the component calls those full paths because `history.json` retains its `history` root object. A component test must exercise a real non-English resource, because a dynamic translation key is not visible to the static default-value coverage test.

## Freshness and validity

The three-hour `SENSOR_FRESHNESS_WINDOW_MS` remains the age limit for current telemetry. Add a small exported predicate beside that constant so device cards and the zone summary use the same timestamp rule. A reading is current only when `nowMs` is finite, `last_seen` parses to a finite timestamp, and `-5 minutes <= nowMs - observedMs <= 3 hours`. Both endpoints are inclusive. This admits at most five minutes of device clock skew; a timestamp five minutes and one millisecond in the future is not current. Missing, unparseable, and far-future timestamps cannot establish freshness.

A device-card indicator renders only when:

- its raw canonical kPa classifies successfully;
- the device's `last_seen` is current; and
- the device-specific sample is not faulted.

For LSN50 Chameleon channels, `chameleon_i2c_missing`, `chameleon_timeout`, and the matching `chameleon_chN_open` flag suppress status. The existing “No valid Chameleon sample” treatment remains for global I2C and timeout faults. A missing channel value continues to render as unavailable.

`summarizeZoneSoil()` must build a current tension value from current, valid contributors only. If at least one eligible current contributor exists, stale or faulted devices do not enter its mean. If none is current but valid historical snapshots exist, the function retains the last-valid value and timestamp for the existing stale display, which receives no indicator. If reported values exist but all are invalid or faulted, the result remains invalid.

Historical contributors must have parseable observation timestamps older than the three-hour window. Missing, invalid, and future-dated timestamps do not supply a last-valid value or affect its mean. This rule applies per channel. An `SWT_AVG` schedule averages eligible current channels; it does not create a new device-card average. The selected channel and depth behavior stays unchanged.

An otherwise valid measurement with an untrusted timestamp leaves both the value and observation time unavailable. It does not count as an invalid measurement; the Water card uses the existing localized No reading yet copy. An actual measurement fault still sets invalid when no eligible value is available. A healthy historical value takes precedence over faults on other devices in the zone summary, while each faulted device retains its own fault display.

## Device-card behavior

### KIWI

Each visible SWT tile gets one indicator beside its formatted value. `swt_1` and `swt_2` classify independently. Legacy `swt_wm1` and `swt_wm2` remain compatibility inputs through `canonicalSwtChannels()`.

The numeric value remains the existing history button. The status pill sits beside the button rather than inside a second interactive element. A stale KIWI continues to show its last value and footer timestamp but receives no current-status pill.

An unavailable SWT value uses the existing translated unavailable label inside the history button. History remains accessible for a displayed channel even when its latest measurement is missing or outside the valid range. Other KIWI measurement controls keep their existing behavior.

### LSN50 Chameleon

Each Chameleon channel row gets its own indicator, so a shallow Dry channel can coexist with a deep Wet channel. The whole row remains one history button, including the noninteractive pill. The value stays neutral, while the row retains its existing border, hover border, title, and focus ring.

Global faults keep the existing invalid-sample message. A per-channel open flag suppresses only that channel's status.

### SDI-12

Only rows whose `kind` is `swt` receive an indicator. VWC, VIC, soil temperature, and soil EC never use VIA tension colors.

The Tensiomark normalizer already converts its pF input to canonical `swt_1` kPa. `Sdi12SoilCard` continues showing its existing kPa and pF pair, with one status pill derived from kPa. In the zone summary, `sdi12_probe_profile === 'TENSIOMARK'` establishes that the device is a tension sensor before its first sample. Other current SDI-12 profiles remain volumetric.

The live SWT values inside `DraginoChameleonSwtSection` are settings-modal diagnostics, not a device card, and remain outside this change.

## Water card behavior

“Soil now” continues to show one selected quantity. Tension takes precedence over volumetric data when both exist. A Tensiomark-only zone now follows the tension path.

For a current valid tension value, render the shared indicator beside the number. For VWC, retain the neutral “Volumetric water content” text and show no VIA color. Stale, missing, and invalid states keep their existing warning and last-valid copy without a status indicator.

Trigger proximity remains a separate neutral line:

```text
Soil now · 20 cm
56.5 kPa   [● Dry]
At or past the trigger
```

A status and trigger message can differ without contradiction: `35 kPa` is Moist under VIA's fixed bands and may also be At or past a farm trigger of `30 kPa`.

Only compare the displayed value with `threshold_kpa` when `soilNow.channel` equals the schedule's requested channel, including the explicit `mean` case. `selectChannel()` may fall back when a requested channel is absent; that fallback value receives a VIA status but no trigger-relative claim. DENDRO's encoded 1–4 value is never treated as kPa.

For an unscheduled tension value, the badge replaces the old Wet/Moderate/Dry descriptor. Remove the duplicated `<20`/`<60` branch from `IrrigationZoneCard.tsx`.

## Accessibility, themes, and responsive layout

Color is redundant with visible text. Screen readers encounter the same localized label as sighted users, and no live region announces polling updates.

Status colors are reserved for the dot, border, and wash. Values and labels retain neutral high-contrast text. Existing history affordances remain unchanged: KIWI keeps its dotted underline; LSN50 keeps its bordered row, title, hover border, and focus ring. Touch targets stay intact. The pill may wrap below a value on narrow screens; it must not force horizontal scrolling or reduce the history target.

Light and dark themes use the existing soil tokens. This feature does not edit `ui-core`, so it does not trigger a cloud-vendoring change.

## Testing and acceptance

Pure tests pin `-1`, `0`, `19.999`, `20`, `50`, `50.001`, `300`, `301`, null, undefined, numeric strings, `NaN`, and both infinities. A pF-mode component test proves that the displayed unit does not change the status and that zero still appears as a real Wet reading.

Freshness tests pin exactly three hours old and one millisecond older, exactly five minutes ahead and one millisecond farther ahead, a far-future timestamp, missing and invalid timestamps, and a non-finite `nowMs`.

Zone-summary tests cover:

- Tensiomark with `swt_1` as tension;
- non-Tensiomark SDI-12 with VWC as volumetric;
- mixed fresh and stale contributors;
- global LSN50 Chameleon faults;
- per-channel open flags;
- requested-channel fallback without a false trigger comparison; and
- a fully stale set retaining last-valid copy without a status indicator.

Component tests cover one Wet, Moist, and Dry channel across the device-card families, a mixed-depth LSN50, missing and stale values, preserved history buttons, a real non-English label, and the Water card showing both fixed VIA status and schedule-relative copy.

Completion requires:

```bash
(cd web/react-gui && npm run typecheck)
(cd web/react-gui && npm run test:unit)
(cd web/react-gui && npm run build)
git diff --check
```

Browser acceptance uses a deterministic local fixture that renders the real zone and device cards with local fixture responses. The proposed-badge preview is a design review artifact, not evidence that the implementation passes. After implementation, run the same fixture with its preview-only source transforms disabled. Its capture gate covers 23 cases: 1440, 390, and 320 px in light and dark themes and English, Swiss German, and French, plus 390 px pF cases for stale, fault, zero, future, and current readings. It saves one full-page screenshot per case and two Water-card details. Check visible labels, neutral numeric values, badge placement, wrapping, horizontal overflow, and keyboard focus/history-button behavior in the browser. Existing device-header controls may truncate at 320 px independently of the badge; record that separately. Unit tests remain the semantic gate for exact thresholds and freshness boundaries. Product readiness requires the actual-source implemented-mode capture gate to pass.

## Scope boundaries

This change is confined to the edge React GUI. It does not change storage, decoders, calibration, REST payloads, scheduler thresholds, pF persistence, history API status names, or cloud UI behavior.

The history backend currently defaults to 22/50 kPa and returns `wet_excess`, `optimal`, and `dry_stress`. Those historical interpretations are not imported into the live-card classifier and are not changed here. Aligning historical analysis with the 20/50 live-card convention requires a separate contract review because it changes existing aggregated states.
