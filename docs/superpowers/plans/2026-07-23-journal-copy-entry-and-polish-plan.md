# Plan — Copy-an-entry + capture-form polish (GUI-only) — REVISED per Fable review

**Date:** 2026-07-23 · **Branch:** design-sync/agrolink · **Base:** 14b61270
Session wrap-up. All `web/react-gui`-only — no catalog version, no migration, no edge change (uses existing `journalApi.createEntry` + `deriveFieldStates` + `resolveOccurrence`). Fable plan-review verdict was REVISE; all 7 revisions are folded in below.

## A — Copy-an-entry (final-only, non-cycle activities)

**Ask:** "if I already irrigated plot 1, for a second time just copy the entry and adjust the date." → duplicate an entry into a prefilled form, edit the date (or anything), save as a NEW entry, source untouched.

**Scope gate (A4 — removes the crop-cycle hazard class):** offer **Copy only for `status==='final'` entries whose activity is NOT in the cycle-cascade set.** Hide/disable Copy on `seeding`, `planting_transplanting`, and `harvest` (seeding/planting open/continue a cycle; harvest closes the covering cycle with no flag — the copy form has none of the capture flow's cycle-disambiguation UI, and building it is out of scope for a wrap-up). This covers the maintainer's use case (irrigation/fertigation/fertilization/plant-protection/tillage/weeding). The copy path NEVER sends `cycle_action`/`cycle_uuid`/`ends_crop_cycle`. `final`-only is ALSO a safety invariant (see A6), not just UX.

**Form (A7):** a **sibling `EntryCopyForm`** (NOT a `mode:'copy'` branch on `EntryCorrectionForm` — the dangerous divergence is the save target; a shared submit handler risks mis-routing). Reuse the prefill helpers — export `initialCorrectionSeed`/`scalarSelectionsFromValues` (already in `entryCorrection.ts`) + the note-seed pattern (`DetailPanel.tsx:637`); the copy form **imports ONLY `journalApi.createEntry`** (never `updateEntry`/`voidEntry`/`discardDraft`). Do NOT give it the correction's `key={aggregate.sync_version}` machinery (meaningless for create).

**Date editor (A1):** the copy form renders its OWN occurred date/time input (default: now). Resolve via `resolveOccurrence` (`journal/occurrence.ts:214`) in the **source's `occurred_timezone`** (DST-safe — compute `occurred_start_local`/`occurred_utc_offset_minutes` for the NEW date; do NOT reuse the source's stored offset). Set `occurred_end_local: null`, `occurred_end_utc_offset_minutes: null`.

**Payload — new tested module `journal/entryCopy.ts`** (A5; no existing helper builds a create payload from an aggregate — `buildPayload` is a closure in the flow, `buildFinalBatchPayload` is flow-shaped). Export `buildCopyPayload(aggregate, formOwnedAttributeCodes, editedValues, occurrence): CreateEntryPayload`:
- `entry_uuid`: fresh client-generated `randomUuid()` (batch-member convention, `JournalCaptureFlow.tsx:1391`); `base_sync_version: 0`; `status: 'final'`.
- `plot_uuid` from source; `zone_uuid` from the plot's current row (plots prop is in DetailPanel scope).
- occurred fields per the date editor above.
- **values** = the same preserved+edited merge correction uses (`mergedValues`), **MINUS `attr.actuation_expectation_id`** (A3 — internal valve-linkage id; DetailPanel already omits it from display). `attr.measurement_source` is carried but editable.
- `season_crop`/`season_variety`: **re-derive from the plot's `active_crop_cycles` as of the copy's occurred date** (the flow gates crop inheritance on the open cycle covering the date, `JournalCaptureFlow.tsx:1312-1343`), fall back to null. NEVER carry the source's stored value, and never the display-only `closed_crop_code`/`closed_crop_variety`.
- `template_code`/`template_version` + `layout_code`/`layout_version`: **current catalog versions** (what `model` resolves today — a copy is captured today; the form derives against current versions anyway), NOT the source's stored versions.
- `note`: the edited textarea value (`currentNoteValue`).
- `campaign_uuid`/`protocol_code`/`protocol_version`/`observation_unit_code`: **carry** (repeating a protocol activity is a plausible copy).
- `context_json`: OMIT — the edge freezes a fresh sensor snapshot on create (correctly absent from `JournalEntryWriteFields`).
- **OMIT entirely:** `pass_uuid`, `batch_uuid`, `cycle_action`, `cycle_uuid`, `ends_crop_cycle`, any `sync_version`, and `duplicate_guard_ack_entry_uuid` (until the A2 retry).

**Duplicate-guard 409 (A2):** the edge 409s (`duplicate_candidate`, `lifecycle.js:1766`) when a same-plot/same-activity **final** entry exists within ±1h of the new occurred time — copying the same entry always trips it. Catch the 409, surface the candidate, and on explicit "save separately" retry with `duplicate_guard_ack_entry_uuid: candidate.entry_uuid` (the field exists, `journalApi.ts:26`; mirror the confirm-step handling at `JournalCaptureFlow.tsx:2813`).

**Never-mutate-source proof (A6):** `EntryCopyForm` importing only `createEntry` (POST `/entries`, no uuid in path) structurally cannot address the source. Edge backstop: POST runs `exactBaseVersion(creating)` — a POST mistakenly carrying the source uuid + `base_sync_version: 0` against a **final** source (sync_version ≥ 1) → 409, not overwrite. The one landmine is a **draft** source (sync_version 0 → POST-with-uuid+base-0 is the draft-upsert path, silent overwrite) — closed by the `final`-only gate. **Test must assert the POSTed `entry_uuid !== source.entry_uuid` and the source aggregate is never written.**

**i18n:** `workspace.detail.actions.copy` + the copy form's heading/save/cancel/error/duplicate-confirm strings — all 7 public locales + feed mirrors.

**Entry point:** Copy action in `DetailPanel` alongside Correct/Void (desktop only — there is no mobile detail surface; mobile `JournalPage.tsx:260` is timeline+filters, workspace is `isDesktop`-gated, so Correct/Void/Copy are all desktop-only). Gate per the scope rule above.

**Tests:** copy seeds source activity/operation/plot/values + today's date; save calls `createEntry` (not `updateEntry`) with a fresh uuid, no batch/pass/cycle, no `actuation_expectation_id`, current template/layout versions; edited date persists; `season_crop` re-derived (or null), not the stale source value; 409 duplicate → candidate shown → ack-retry succeeds; Copy hidden on seeding/planting/harvest and on non-final entries; source aggregate never mutated.

## B — Static-context grouping (regression test) + denominator gate

**B1 — grouping is ALREADY correct:** `attr.block_bed_row`/`attr.cover_type`/`attr.denominator` are the layout's `static_context_fields`, force-added visible-but-optional (`templateEngine.ts:221-224`), not choice-dependency targets, so `isKeyField` (`EntryForm.tsx:415`) already routes them to the collapsed "More detail" group for full_record. (The audit's "renders prominently" was a stale bundle or the DetailPanel read-back list.) **Do NOT "move" them** — instead ADD a regression test that the three resolve into `moreDetailStates` for full_record.

**B2 — denominator gate (generic, catalog-driven):** the only reason `attr.denominator` shows on every operation is the layout static-context force-add. Fix in `templateEngine.ts`'s non-quick static-context loop: **skip force-adding any static-context field that the template's own operation-scoping references anywhere** (`operation_fields_by_activity` ∪ `operation_fields_by_operation` ∪ conditional_groups ∪ requirements). Then `attr.denominator` (referenced in irrigation/fertigation/watering scoping) shows ONLY when the operation resolution includes it (dosing/irrigation); `block_bed_row`/`cover_type` (referenced nowhere in template scoping) stay force-added everywhere. NO hardcoded attribute codes. Required fields stay safe (`addRequirement` force-add still runs). Do NOT use an `attr.amount_*` rule — it self-defeats because `attr.amount_operation_depth` is visible on tillage. State two side-effects: (a) correcting an old tillage entry with a stored denominator keeps the value via the preserved-passthrough (`entryCorrection.ts:102`) — safe; (b) `plotContextInputs` still snapshots a plot-settings denominator onto every created entry regardless of visibility — pre-existing, leave as-is.

## C — Operation as a read-only chip

Render `attr.agroscope.operation` as a read-only chip (the selected operation label) with a small **"change"** button, via a **host-supplied prop** (e.g. `confirmedChoiceCodes`, following the `fieldHints`/`allowedProductKinds` precedent, `EntryForm.tsx:57-69`) — NO hardcoded `attr.agroscope.operation` in EntryForm. "change" re-enables the in-place select; the in-form re-scope (spec §0.5, selections derived from `values`) keeps working unchanged. **Device on operation change: keep the EXISTING error-driven behavior** — the stale device is flagged `invalidDependency` (`EntryForm.tsx:279-291`) and the user re-picks; do NOT add auto-clear (reword the plan's "reset the device" → "the stale device is still flagged invalid"). A11y: the chip keeps the field's label as its accessible name; "change" is a real labelled `<button>`; validation errors still render adjacent. Note: the correction/copy form's autofocus (`DetailPanel.tsx:682`) may land on "change" — acceptable; assert it in a test.

## Verify / deploy
- `npm run typecheck` clean; `npm run test:unit` fully green (+ the new tests); new i18n keys in 7 public locales + feed mirrors (agrolinkBranding green).
- Build, deploy kaba100, live-verify: (A) Copy an existing **irrigation** entry, change the date, save → a new entry with the new date, source unchanged (verify via API the source uuid is untouched and a new uuid exists); Copy absent on a harvest/seeding entry; the duplicate-guard confirm appears if you copy into the ±1h window. (B) denominator absent on weeding/tillage, present on irrigation; block/bed/row + cover type in "More detail". (C) operation shows as a chip with a working "change".
- Commit path-scoped (web/react-gui/src + locales + feed journal.json mirrors + this plan), exclude pre-existing feed/lock dirt, push.

## Risks
- **Copy writing the source** — the `final`-only gate + create-only import + fresh-uuid are load-bearing; the never-mutate test is mandatory.
- **Crop-cycle cascade** — fully avoided by the scope gate; do not weaken it.
- **season_crop staleness** — re-derive, never carry.
- Reusing correction prefill helpers must not regress correction (keep the copy save target explicit + separate).
