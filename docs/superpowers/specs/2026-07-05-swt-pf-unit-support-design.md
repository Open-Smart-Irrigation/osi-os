# SWT pF Unit Support — Design

**Date:** 2026-07-05
**Status:** Revised after expert review (see
`docs/superpowers/prompts/swt-pf-settings-spec-review/review-2026-07-05.md`) —
ready for planning.
**Scope:** osi-os edge first; osi-server computes pF independently from the same rule.

## Problem

OSI OS stores soil water tension as kPa in `device_data.swt_1`, `swt_2`, and `swt_3`. That remains the right canonical ingest unit, but German-speaking soil-science users also expect pF values. pF cannot be treated as a label change: it is logarithmic, must support threshold input, and must appear in exports without every consumer inventing its own conversion.

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

For `NULL`, non-finite, or `<= 0` kPa, the derived pF value is `null`. Display layers may show a wet/saturated label for zero; converters never invent a substitute number, and they never clamp — kPa validity is the ingest path's responsibility.

**Precision rule:** nothing pF-related is ever rounded at storage. The only stored pF value (`threshold_pf`, below) holds exactly what the user authored. Rounding happens at display only: pF at 2 decimals, kPa under the existing kPa rules. The conversion formula and the display rounding rule (round-half-up, 2 dp) are pinned in the sync-schema contract with shared golden vectors so the edge (JS), GUI (JS), and osi-server (Java) provably agree.

## Decision

**kPa stays the only stored measurement unit. pF is derived on demand at every surface where a value leaves the system.** The sole stored pF value is schedule *authoring intent*.

- Live cards, history, analysis, and soil-profile surfaces derive pF in the shared GUI formatter.
- Edge API responses derive pF at response-assembly time.
- CSV export derives pF at export time (see CSV section).
- osi-server derives pF from mirrored kPa values with the same contract-pinned rule.
- Schedule thresholds can be authored in either kPa or pF; the authored unit and value are stored, and a kPa mirror is always recomputed for the runtime.
- The scheduler always compares in kPa. Unit choice never changes trigger behavior.

Why not stored `swt_*_pf` measurement columns (the earlier draft): pF is a pure, strictly monotonic function of kPa and every consumer is JS or Java. Storing it would require a data-class backfill over history-bearing tables and replacement of the `DEVICE_DATA_APPENDED` outbox trigger (destructive class; an explicit Option B promotion condition in the 2026-06-30 ADR), while the boot node is frozen and the migration runner does not yet run on-device — and the cloud would *still* have to derive pF for all pre-change history because backfill UPDATEs emit no sync events. Two independent reviews converged on derive-at-read; the flip conditions are recorded under Non-Goals.

## Prerequisites

1. **Schedules CHECK fix (P0, separate work):** the seed and all live DBs constrain `irrigation_schedules.trigger_metric` to `('SWT_WM1','SWT_WM2','SWT_AVG')`, while the API/GUI vocabulary is `SWT_1/2/3, SWT_AVG, DENDRO` — since 2026-06-25 only `SWT_AVG` schedules can be saved at all. Widening the CHECK is a destructive (table-rebuild) migration tracked as its own issue and must land before or with this work.
2. **Migration delivery at deploy:** live gateways currently have no sanctioned schema-change path (boot node frozen; runner not invoked anywhere). `deploy.sh` must gain a runner invocation (writers stopped → backup → apply → verify → restart) before the schema slice below can roll out. Fresh-flash images pick the columns up from the seed regardless.

## Database

The complete schema delta of this feature:

```text
irrigation_schedules.threshold_unit TEXT NOT NULL DEFAULT 'kPa' CHECK (threshold_unit IN ('kPa','pF'))
irrigation_schedules.threshold_pf   REAL
```

No pF columns on `device_data` or `chameleon_readings`. No backfill.

`threshold_kpa` is `NOT NULL` in both repos and stays that way — it is the mandatory runtime mirror, not an optional convenience.

### Threshold authority invariants

- `threshold_unit` names the field the user authored. `kPa` ⇒ `threshold_kpa` is authored, `threshold_pf` is the derived mirror; `pF` ⇒ `threshold_pf` is authored, `threshold_kpa` is the derived mirror.
- The mirror is **always recomputed server-side at save time** from the authoritative field. Client-supplied mirror values are ignored. Disagreement is therefore impossible by construction.
- The scheduler always evaluates against `threshold_kpa`. `threshold_unit`/`threshold_pf` are authoring/display metadata and never alter runtime behavior.
- `threshold_unit='pF'` is valid only for SWT metrics. DENDRO schedules encode a stress level 1–4 in `threshold_kpa`; the API rejects `pF` + `DENDRO` with 400.
- pF input validation converts to kPa first, then applies the existing rule (`0 < kPa ≤ 300`, i.e. `pF ≤ 3.4771`) — one source of range truth.
- Requests without a unit (old edge clients, unit-less cloud `UPSERT_SCHEDULE` commands) mean kPa-authored: set `threshold_unit='kPa'` and recompute `threshold_pf`.
- Displays of the authored threshold always read the authoritative field, never the recomputed mirror.

## Scheduler

**Unchanged.** The trigger-metric vocabulary stays `SWT_1, SWT_2, SWT_3, SWT_AVG, DENDRO` (with legacy `SWT_WM1/SWT_WM2` normalization and the `COALESCE(swt_1, swt_wm1)` fallback expressions as they are). Evaluation remains the arithmetic hour-mean of kPa compared against `threshold_kpa`; `irrigation_events.aggregate_kpa`/`threshold_kpa` keep their meaning.

Aggregation semantics are deliberately unit-independent. Averaging pF values would compute a geometric mean of tension (mean-of-logs), which triggers differently from the arithmetic kPa mean for the same physical threshold — unit choice must never change irrigation behavior. If agronomists later prefer geometric-mean triggering, that is a global, explicitly-communicated change for *all* schedules, made as its own project (and it can be computed from kPa in the JS rollup/scheduler paths without stored pF).

## Data Flow

One conversion rule, three runtimes, golden-vector-pinned:

```text
kpaToPf(kpa) -> number | null
pfToKpa(pf) -> number | null
```

- **React GUI:** a shared formatter `formatSwtValue({ kpa }, preferredUnit)` (see the global-settings spec) so no card/chart invents its own pF fallback.
- **Edge (Node-RED):** the converters live in the shared helper surface and are used by the schedule save path (both the edge API handler and the cloud `UPSERT_SCHEDULE` apply path) to recompute the mirror, and by the history/CSV helper at export time.
- **osi-server:** one small Java utility, same golden vectors.

## API And Sync

Edge API responses include both units, computed at response time:

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

**Sync payloads are unchanged in this increment.** `DEVICE_DATA_APPENDED` stays as-is (osi-server derives pF from kPa where it needs it). Adding `threshold_unit`/`threshold_pf` to `SCHEDULE_UPSERTED` requires replacing `trg_sync_schedules_outbox_au` — including extending its change-detection `WHEN` clause — which is destructive-class trigger work deferred to the Option B window. When that lands, the contract update must ship in the same change and also fix the **existing** Schedule contract drift (`resources.schema.json` enum missing `SWT_1/2/3`; field named `trigger_value` while live payloads emit `threshold_kpa`).

Until then, a cloud edit echoed back as a unit-less `UPSERT_SCHEDULE` resets the schedule to kPa-authored per the invariants above; runtime behavior stays correct because the runtime only ever reads the kPa mirror.

## UI

Normal display follows the global SWT unit preference from the global settings page. Data objects carry kPa; the shared formatter derives pF, so no new API calls are needed.

Schedule threshold input always has an explicit `kPa | pF` segmented control (hidden for DENDRO). This selector is not display preference; it sets `threshold_unit`.

Display precision: pF at 2 decimals, kPa under existing rules, per the Unit Rule precision paragraph.

## CSV Export

CSV export always includes both kPa and pF for each SWT channel, by default. The
export is tidy long format (`…,channel_key,…,unit,value`); each SWT kPa row is
paired with a derived pF row (`channel_key` gains the `_pf` suffix, `unit` is
`pF`, value rounded to 4 decimals):

```text
timestamp,...,channel_key,...,unit,value
2026-06-01T08:00:00.000Z,...,swt_1,...,kPa,6.2
2026-06-01T08:00:00.000Z,...,swt_1_pf,...,pF,1.7924
```

pF columns are **computed at export time** from the kPa value in hand. Both the on-demand zone export and the persisted `/data/exports` rollup CSVs funnel through `rawZoneExportRows`/`aggregateZoneExportRows` in `osi-history-helper`, so this is a single choke point — and the guarantee holds for *all* history, including every row recorded before this feature exists, with no backfill.

The export does not follow the global display preference: exports are analysis artifacts and stay self-describing.

## Migration

- One `additive` ordered migration (next number in `database/migrations/ordered/`) adding the two `irrigation_schedules` columns, plus the same columns in `seed-blank.sql` and the bundled DBs.
- Delivery to live gateways via the deploy-time runner invocation (Prerequisite 2). No boot-node changes; the boot-DDL freeze is untouched.
- No backfill, no trigger changes, no table rebuilds in this feature. (The schedules CHECK rebuild is Prerequisite 1's separate migration.)
- Existing schedules read as `threshold_unit='kPa'` via the column default; `threshold_pf` is recomputed lazily on next save or eagerly by the migration — either is acceptable, pick one in the plan.

## Testing

- Converter unit tests incl. golden vectors: `10 -> 2.00`, `30 -> 2.4771`, `0 -> null`, `null -> null`, negatives/NaN, round-trip `pfToKpa(kpaToPf(x)) ≈ x`.
- **Equivalence property (the core guarantee):** for any reading series, a schedule authored at `pF p` triggers on exactly the same evaluation cycles as one authored at `pfToKpa(p)` kPa.
- Schedule save: pF+DENDRO rejected 400; out-of-range pF rejected via the converted-kPa rule; mirror recomputed and client-sent mirror ignored; unit-less save defaults to kPa; cloud `UPSERT_SCHEDULE` without unit resets to kPa and recomputes `threshold_pf`.
- API tests: both units in latest-data and schedule payloads; old clients unaffected (fields additive).
- CSV tests: both columns present for all rows including pre-feature history; pF cell empty exactly when kPa is `NULL`/`<= 0`.
- Migration tests: applies on fresh seed and on an upgraded production-DB copy.
- Repo gates: `verify-profile-parity.js` (all flows edits mirrored to bcm2709), `verify-sync-flow.js`, flows wiring tests.
- Contract fixtures untouched in this increment (sync payloads unchanged); a failing contract fixture must gate the deferred payload change.

## Non-Goals

- Do not add stored pF measurement columns (`device_data`/`chameleon_readings`). Flip conditions, all required: a validated need for per-sample-pF aggregates in raw SQL (not JS rollups), the migration runner live on-device with the outbox-trigger cutover done, and a cloud backfill path.
- Do not change aggregation semantics (arithmetic kPa hour-mean) — and never key them to the authoring unit.
- Do not change sync payloads or the sync-schema contract in this increment.
- Do not replace kPa as the canonical measurement unit.
- Do not build a generic unit-conversion framework.
- Do not make CSV exports depend on the UI display preference.
