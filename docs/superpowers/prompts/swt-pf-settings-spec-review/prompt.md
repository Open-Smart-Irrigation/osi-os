# Expert Review Prompt - SWT pF Units and Global Settings

You are reviewing two draft OSI OS edge specs before implementation. Act as a senior architecture reviewer with strong skepticism about schema evolution, sync contracts, data semantics, and frontend product design. Your job is not to implement code; your job is to decide whether the specs are technically sound, identify missing decisions, and elaborate the core design choices that should be locked before work starts.

Repo context: `/home/phil/Repos/osi-os`

## Read First

1. `AGENTS.md`
2. `docs/adr/2026-06-30-schema-and-contract-ownership.md`
3. `docs/superpowers/specs/2026-07-05-swt-pf-unit-support-design.md`
4. `docs/superpowers/specs/2026-07-05-global-settings-page-design.md`

Also inspect the relevant current code paths before making claims, especially:

- SQLite seed and migrations: `database/seed-blank.sql`, `database/migrations/`, `scripts/repair-pi-schema.js`
- Node-RED flow/API/scheduler/export paths in the maintained profile `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- React GUI sources under `web/react-gui/src/`
- Any existing CSV/history/export tests and sync contract verifiers under `scripts/`

Do not use production access. Do not connect to `osicloud.ch`.

## Current Product Decisions To Review

The current intended direction is:

- OSI stores canonical soil water tension as positive kPa in `device_data.swt_1`, `device_data.swt_2`, and `device_data.swt_3`.
- German soil-science users need pF display and pF threshold input.
- pF definition: decimal logarithm of absolute soil-water tension in hPa. For OSI's positive kPa values:

```text
pF = log10(kPa * 10)
kPa = 10^pF / 10
```

- The database should always have pF columns for SWT values, not just display-time conversion.
- pF is a complete stored derived chain, not an independent raw measurement.
- Schedules can be authored in either kPa or pF, with `threshold_unit` determining which threshold field is authoritative.
- Scheduler runtime compares kPa thresholds to kPa readings and pF thresholds to pF readings.
- CSV export always includes both kPa and pF columns.
- A new global settings page replaces the header language button.
- The settings page owns language, SWT display unit, view/display defaults, theme selection starting with dark mode, and a global timezone/default-zone timezone workflow.

## Core Design Decisions To Elaborate

For each decision below, give a verdict: `keep`, `revise`, or `reject`. Explain why, cite concrete code/spec lines where relevant, and propose exact spec changes when needed.

1. **pF conversion and invalid values**
   - Confirm the unit conversion is correct.
   - Decide how to handle `NULL`, zero, negative, non-finite, and suspiciously high kPa values.
   - Decide display precision versus stored precision.

2. **Stored derived pF chain**
   - Evaluate whether storing pF beside kPa is worth the duplication.
   - Define invariants that prevent kPa and pF drift.
   - Decide where pF columns must exist beyond `device_data` and `chameleon_readings` if history APIs, rollups, views, or cloud mirrors currently depend on narrower shapes.

3. **Threshold authority**
   - Review the `threshold_unit`, `threshold_kpa`, and `threshold_pf` design.
   - Decide whether both threshold mirrors should always be populated, and what happens if they disagree.
   - Define API validation behavior for new and old clients.

4. **`SWT_AVG` semantics**
   - The current spec says pF schedules average stored pF channel values, not `pF(mean kPa)`.
   - Review whether this is scientifically and operationally defensible.
   - If not, propose the exact alternative and its migration/test impact.

5. **Migration and backfill safety**
   - Classify the schema/data changes using the repo's migration risk classes in `AGENTS.md`.
   - Decide whether this can remain additive plus data backfill, or whether any runtime boot-path/migration-runner concern is understated.
   - Identify any tables/triggers/outbox behavior that could pass tests while silently leaving historical rows or sync events inconsistent.

6. **Sync and osi-server parity**
   - Decide which new fields belong in `DEVICE_DATA_APPENDED`, schedule sync payloads, API responses, and CSV exports.
   - Review whether osi-server should mirror pF values from edge or compute them independently.
   - Identify contract/versioning risks and tests that must fail before merge if fields drift.

7. **Settings scope and persistence**
   - Review the split between local display preferences, farm defaults, and bulk operational mutations.
   - Decide whether `osi.defaults.timezone` can stay local-only or must be persisted in edge SQLite so new-zone behavior is consistent across browsers/devices.
   - Decide whether any other proposed setting should be excluded from the first increment.

8. **Timezone bulk update**
   - Review the proposed `PUT /api/settings/zones/timezone` endpoint versus looping through existing zone APIs.
   - Specify transactionality, confirmation UX, sync event emission, failure handling, and auditability.
   - Define how this affects scheduler behavior, history windows, daily rollups, and existing zone-specific intent.

9. **Theme and dark mode architecture**
   - Review the CSS-variable approach and `html[data-theme='dark']` selector.
   - Identify chart/map/component surfaces likely to ignore CSS variables.
   - Define the smallest testable dark-mode increment that is not visually broken.

10. **Implementation sequencing**
    - Decide the safest order of work across schema, ingest, API, scheduler, CSV, settings UI, timezone API, and osi-server parity.
    - Split work into reviewable increments with clear rollback boundaries.

## Expected Output

Return a structured review with these sections:

1. **Executive Verdict** - one paragraph: are the specs ready, mostly ready with changes, or not ready?
2. **Decision Matrix** - one row per core decision with verdict, main risk, and required spec change.
3. **Highest-Risk Gaps** - prioritized, with concrete failure modes.
4. **Spec Patch Suggestions** - exact wording or bullet changes to apply to the two spec files.
5. **Implementation Slices** - recommended order, with each slice small enough for one PR/commit series.
6. **Verification Plan** - exact test/verifier categories and what each must prove.
7. **Open Questions For Phil** - only questions that block a clean design decision.

## Review Rules

- Be direct. Do not rubber-stamp the specs.
- Ground claims in the files and code you inspected.
- Preserve the repo's edge-canonical model: the edge writes first, cloud mirrors.
- Treat data loss, sync drift, and pF/kPa disagreement as release blockers.
- Prefer boring additive changes unless a stronger model is clearly justified.
- Do not propose a generic unit framework unless you can name a second immediate metric and show the simpler pF-specific approach would be worse.
- Do not propose cloud-synced user preferences in the first increment unless you can show local preferences break a required workflow.
- If you recommend changing a decision, state what evidence would make you switch back.
