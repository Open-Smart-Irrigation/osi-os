# VWC display contract

`vectors.json` pins how both GUIs show volumetric water content (VWC): the number format, what counts as a reading, how a probe profile is qualified, which depth a channel belongs to, the series colours, and the zone "Soil now" value. It is display only. No value here starts or stops irrigation.

## Rules

| Section | Rule |
|---|---|
| `reading_state` | `null` or `undefined` is `absent` (no reading). A finite number from 0 to 100 inclusive is a `value`; a measured `0` is a reading. Anything else (out of range, non-finite, a string, a boolean) is `invalid` and is never printed as a number. |
| `format` | A `value` prints with one decimal, a plain space, then `%` (`28.0 %`). Everything else formats to `null`, and the GUI shows its own unavailable or out-of-range text. CSV exports keep the stored value and do not use this format. |
| `display.rounding` | Half away from zero on the shortest decimal form of the stored value: `28.45` prints `28.5 %`, although the binary double is just below 28.45. A result of zero never carries a sign, so `-0` prints `0.0 %`. Neither `toFixed` (it rounds the binary value) nor `Intl.NumberFormat` (its rounding input is engine-dependent) is used for the rounding. |
| `qualification` | `SENTEK_ENVIROSCAN` is `field_verified`. `GENERIC_VWC` is `generic`. `TENSIOMARK`, an empty profile and no profile give `null` (not a VWC probe). Every other profile, including one this list does not know yet, is `provisional`. |
| `derivation` | A layout sensor of type `TRISCAN` is `sentek_default_curve`: the normalizer converts its scaled frequency with the Sentek default calibration. Everything else is `probe_reported`. |
| `depth` | For a `vwc_N` or `soil_vic_N` key: a positive finite depth in the device's depth map wins. Otherwise, on a `DRAGINO_SDI12` whose layout has no `kind`, the layout sensor with channel `N` supplies its positive `depth_cm`. A zero or negative depth, a Tensiomark layout (`"kind": "tensiomark"`) and any non-SDI-12 device give `null`. |
| `series_colors` | VWC `#0072B2`, VIC `#CC79A7`, both from the shared series palette. |
| `zone_summary` | See below. |

### Zone summary

Eligible devices are `DRAGINO_SDI12` probes whose profile is not `TENSIOMARK`. With none, `hasSensor` is false and every other field is empty.

1. Each eligible device contributes one entry per channel 1 to 10 that holds a `value`. An `invalid` channel contributes nothing but is remembered.
2. Fresh entries win: an entry is fresh when its device's `last_seen` is at most `freshness_window_ms` (3 h) old, with `clock_skew_ms` (5 min) of tolerance for a clock ahead of now. With no fresh entry, every entry with a parseable `last_seen` is used and `stale` is true.
3. Entries are grouped by depth when the depth is known, else by channel number. The shallowest depth group wins; any depth group beats a channel group; channel groups go in channel order. Readings from different depths are never averaged together.
4. `value` is the mean of the winning group. `depthCm` is its depth; `channel` is set only when the depth is unknown. `contributorCount` is the group size. `qualification` is the weakest in the group (`provisional` is weaker than `generic`, which is weaker than `field_verified`), or the weakest among eligible devices when no group exists.
5. `observedAt` is the newest `last_seen` in the winning group. With no group, it is the newest `last_seen` of any device that reported a value, valid or not, else `null`.
6. `invalid` is true only when no entry was usable and at least one channel was invalid. With no group, `stale` follows `observedAt`: true when it is missing or outside the window.

## Copies and tests

This directory is canonical. osi-server keeps a byte-identical copy at `docs/contracts/vwc-display/vectors.json`. Check it from an osi-os checkout with `cmp docs/contracts/vwc-display/vectors.json ../osi-server/docs/contracts/vwc-display/vectors.json`.

| Side | Test |
|---|---|
| Edge GUI | `web/react-gui/tests/vwcDisplayVectors.test.ts` (`npm run test:unit`) |
| Cloud frontend | osi-server `frontend/tests/vwcDisplayVectors.test.ts` (`npm run test:unit`) |

The `format` vectors are the English form. A GUI may localise the decimal mark: the cloud follows its interface language (`28,0 %` in French), and the edge prints `.` until it gains locale-aware number formatting. Rounding, the space and the unit do not change with the locale.

`non_json_inputs` lists values JSON cannot carry; each test maps the names to `undefined`, `NaN` and the two infinities.

## Out of scope

VWC as a schedule trigger (gap G1, feature FEAT-04, decision D18) and per-channel calibration records (VWC Option 2) are not covered. Option 2 would change `derivation` to read a stored calibration record; cloud advice eligibility (Option 4) would add a per-qualification eligibility field. Either change is a new contract version.
