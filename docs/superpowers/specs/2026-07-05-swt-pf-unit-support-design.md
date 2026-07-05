# SWT pF Unit Support — Design

**Date:** 2026-07-05
**Status:** Draft for user review
**Scope:** osi-os edge first; osi-server parity follows the same contract.

## Problem

OSI OS stores soil water tension as kPa in `device_data.swt_1`, `swt_2`, and `swt_3`. That remains the right canonical ingest unit, but German-speaking soil-science users also expect pF values. pF cannot be treated as a label change: it is logarithmic, should support threshold input, and should be queryable/exportable without every consumer recalculating it.

## Unit Rule

Use the pF definition from the German `PF-Wert` reference: pF is the decimal logarithm of the absolute soil-water tension in hPa. For the OSI positive SWT tension values:

```text
pF = log10(kPa * 10)
kPa = 10^pF / 10
```

Examples:

| kPa | hPa | pF |
|-----|-----|----|
| 10 | 100 | 2.00 |
| 30 | 300 | 2.48 |
| 60 | 600 | 2.78 |
| 300 | 3000 | 3.48 |

For `NULL`, non-finite, or `<= 0` kPa, the derived pF value is `NULL`. Display layers may show a wet/saturated label for zero, but the database should not store a fake pF value.

## Decision

Implement pF as a complete stored derived chain:

- kPa remains the canonical measurement chain.
- pF is stored beside each SWT measurement as a deterministic derivative.
- Schedule thresholds can be authored in either kPa or pF.
- Scheduler comparison uses same-unit data: kPa threshold against kPa readings, pF threshold against pF readings.
- CSV exports always include both kPa and pF columns for SWT channels.

This gives pF users first-class display and threshold behavior without making pF an independent raw measurement.

## Database

Add pF columns to the canonical measurement table:

```text
device_data.swt_1_pf REAL
device_data.swt_2_pf REAL
device_data.swt_3_pf REAL
```

Also add pF columns to `chameleon_readings` because it already has diagnostic `swt_1`, `swt_2`, and `swt_3` mirrors:

```text
chameleon_readings.swt_1_pf REAL
chameleon_readings.swt_2_pf REAL
chameleon_readings.swt_3_pf REAL
```

Add schedule threshold unit fields:

```text
irrigation_schedules.threshold_unit TEXT DEFAULT 'kPa'
irrigation_schedules.threshold_pf REAL
```

`threshold_kpa` stays for backward compatibility and for kPa-authored schedules. `threshold_unit` determines which threshold is authoritative:

| threshold_unit | Authoritative field | Derived mirror |
|----------------|---------------------|----------------|
| `kPa` | `threshold_kpa` | `threshold_pf` may be populated |
| `pF` | `threshold_pf` | `threshold_kpa` may be populated |

Populate the derived mirror when saving schedules so API responses can display both values. Runtime logic must still obey `threshold_unit`.

## Data Flow

Create one shared conversion helper in the Node-RED runtime helper surface, then use it everywhere pF is computed:

```text
kpaToPf(kpa) -> number | null
pfToKpa(pf) -> number | null
```

Derive pF at these points:

- Chameleon/KIWI ingest when `device_data.swt_*` is inserted.
- Chameleon diagnostic insert/update when `chameleon_readings.swt_*` is populated.
- Historical repair/backfill scripts for existing SWT rows.
- Schedule save path when the submitted unit is known.

Do not use SQLite generated columns. The Pi runtime should not depend on SQLite math-function availability for a core field.

## Scheduler

The scheduler keeps the existing trigger metric set:

```text
SWT_1, SWT_2, SWT_3, SWT_AVG
```

It changes only the value expression based on `threshold_unit`:

```text
if threshold_unit = 'pF':
  SWT_1 uses dd.swt_1_pf
  SWT_2 uses dd.swt_2_pf
  SWT_3 uses dd.swt_3_pf
  SWT_AVG averages available pF values
  compare against threshold_pf
else:
  existing kPa expressions
  compare against threshold_kpa
```

The pF average is the average of the stored pF channels, not `pF(mean kPa)`. This matches the chosen complete pF chain and avoids hidden conversion during runtime comparison.

## API And Sync

Edge API responses should include both units for latest data and schedule payloads:

```json
{
  "latest_data": {
    "swt_1": 30,
    "swt_1_pf": 2.4771
  },
  "schedule": {
    "threshold_unit": "pF",
    "threshold_pf": 2.48,
    "threshold_kpa": 30.2
  }
}
```

`DEVICE_DATA_APPENDED` should include the new pF fields so osi-server can mirror them without recalculation. Schedule sync payloads should include `threshold_unit` and `threshold_pf` while preserving `threshold_kpa`.

## UI

Normal display follows the global SWT unit preference from the global settings page. The same data objects carry both values, so cards and charts can format either unit without new API calls.

Schedule threshold input always has an explicit `kPa | pF` segmented control. This selector is not just display preference; it controls `threshold_unit`.

Display precision:

- Store pF with enough precision for stable comparisons, at least 4 decimal places when rounded.
- Display pF with 2 decimals by default.
- Display kPa with the existing kPa precision rules.

## CSV Export

CSV export always includes both kPa and pF for each requested SWT channel. For example:

```text
swt_1_kpa,swt_1_pf,swt_2_kpa,swt_2_pf,swt_3_kpa,swt_3_pf
```

The export should not silently follow the global display preference because exports are analysis artifacts and should remain self-describing.

## Migration And Backfill

This is an additive schema change:

- Add nullable columns to seed DB and live repair/migration surfaces.
- Backfill pF for existing rows with positive kPa values.
- Leave pF `NULL` for missing, zero, or invalid kPa.
- Preserve existing `threshold_kpa` schedules with `threshold_unit='kPa'`.

Because this touches history-bearing tables, implementation must follow the repo's migration risk guidance and keep the boot DDL freeze in mind. No table rebuild is required for the proposed columns.

## Testing

Required verification:

- Unit tests for `kpaToPf` and `pfToKpa`, including `10 -> 2.00`, `30 -> 2.4771`, `0 -> null`, `null -> null`.
- Ingest tests proving `device_data.swt_*_pf` is populated with matching pF values.
- Scheduler tests for kPa and pF thresholds, including `SWT_AVG`.
- API tests proving both units are returned for latest data and schedules.
- CSV export tests proving both kPa and pF columns are always present for SWT channels.
- Sync/contract verifier updates for new pF payload fields.

## Non-Goals

- Do not replace kPa as the internal canonical measurement.
- Do not make pF an independent raw sensor measurement.
- Do not build a generic unit-conversion framework for all metrics.
- Do not make CSV exports depend on the UI display preference.
