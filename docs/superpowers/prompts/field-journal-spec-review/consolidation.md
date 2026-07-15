# Field Journal — Review Consolidation Record

> **Supersession note (2026-07-15):** The original 2026-07-12 consolidation snapshot remains below unchanged, including the consultant's Slice 1/Slice 3 recommendation. Current Slice 1 contracts are in `docs/superpowers/specs/2026-07-12-field-journal-design.md` and the PR #141 hardening design. They use migrations `0018`–`0021` (`0018` creates 13 tables; `0019` contains generated catalog v1), bind layouts through `journal_plot_settings.plot_uuid`, and pair formula-neutralized CSV with lossless `records.ndjson`.

**Date:** 2026-07-12
**Inputs:** Phase-1 consultant review (`report.md`, 623 lines, SHA-verified against parent spec v1) + UX addendum (U1–U5/P1–P9) + Agroscope layout doc. **The Phase-2 review (`followup-01-layouts-and-cascade.md`) was never run** — its questions (cascade mechanism, product registry, layout binding, picker stress-test) were decided autonomously per product-owner instruction ("decide on your own, don't prompt").
**Outputs:** parent spec rewritten as v2; layout doc §5 resolved; addendum §4 verdicts added.

## Finding → decision → application

Every Phase-1 finding was accepted; none conflicted with adjudicated decisions (the reviewer confirmed all D1–D9 keep/revise, none reject). Modifications are noted.

| ID | Sev | Decision | Applied in |
|---|---|---|---|
| SYS-1 command/event contract absent | Blocker | Accept | Spec §5.3–§5.5 (uppercase names, conditional schemas, capability `field_journal_v1`, catalog negotiation, durable unsupported-command NACK) |
| SYS-2 non-atomic aggregate | Blocker | Accept | Spec §5.2 (single BEGIN IMMEDIATE contract), §5.6 (cloud version/hash rules) |
| SYS-3 dedupe replays rejection as APPLIED | Blocker | Accept — note: pre-existing defect in the shared pending-command path; fixing it benefits all command types | Spec §5.4 + crash-state test §9 |
| SYS-7 no bootstrap/snapshot for journal | Blocker | Accept — manifest/capability in Slice 1, snapshot worker in Slice 3 | Spec §5.5, §11 |
| SYS-8 custom-code collisions, mutable seeds | Blocker | Accept; tenant decided = gateway + owner (Q4) | Spec §4.3 (custom.UUID, ownership, immutability, catalog versioning/delivery), §4.4–§4.5 (code,version PKs), §4.1 (version pins) |
| STD-1 unit/basis ambiguity | Blocker | Accept | Spec §4.3 quantity_kind/basis + allowed families, §4.2 entered value/unit + value_status, §7 contract, irrigation amount_kind + actuation link |
| UX-4 false autosave assurance | Blocker | Accept | Spec §6.1 save states/drafts queue/leave guard |
| UX-7 unrecoverable rejected cloud edit | Blocker | Accept | Spec §5.6 (payload preserved, rejection sheet, Waiting-for-farm tray) |
| STD-3 ADAPT schema-only validation insufficient | Blocker | Accept | Spec §8 (pinned 1.0.0 artifacts, semantic linter, negative fixtures, no centroid-Field, OSI profile v1) |
| RES-1 zone-local timestamps | Major | Accept | Spec §4.1 UTC + timezone/offset snapshot; §7, §9 DST tests |
| SEC-1 auth under-specified | Major | Accept | Spec §5.1 route/auth matrix; owner_user_uuid vs author_principal_uuid in §4.1 |
| SEC-3 no size/escaping limits | Major | Accept | Spec §7 hard limits + output hardening + PII-safe logging |
| SYS-9 EAV determinism/indexes | Major | Accept | Spec §4.2 FK/CHECK/UNIQUE + partial indexes + 10k/150k fixture |
| SYS-12 migration gates incomplete | Major | Accept | Spec §9 change-control gate list; §11 Slice 1; full detail in implementation plan |
| RES-2 no campaign/protocol identity | Major | Accept; Q3 decided yes-multiple-campaigns → Slice 1 | Spec §4.1 campaign/protocol/observation-unit columns + value_status in §4.2 |
| RES-5 wide CSV not lossless | Major | Accept | Spec §8 canonical research package; wide pivot demoted to convenience |
| STD-2 flat mapping columns insufficient | Major | Accept | Spec §4.3 journal_vocab_mappings (role-qualified, versioned); flat columns = caches |
| AGR-1 activity list flaws | Major | Accept; fertigation decided = first-class activity with water + nutrient groups | Spec §4.3 final v1 activity list (16 activities) |
| AGR-3 layouts under-specified, no dependency mechanism | Major | Accept; mechanism decided = `option_dependencies` in layout definition_json (converges with layout doc §5 recommendation) | Spec §4.5 (contract + per-layout minimums); layout doc §5 resolution |
| AGR-7 unsafe carry-forward | Major | Accept | Spec §6.1 (season freezing §4.1; Repeat-last-treatment; compatibility rules); addendum P4 verdict |
| AGR-9 compliance hand-waving | Major | Accept; Q1 decided = detailed record, no ÖLN promise in v1 | Spec §1, §4.4 conditional matrix, §10 non-goals, §12 Q1 |
| AGR-12 context snapshot unsafe | Major | Accept | Spec §4.8 versioned channel schema (provenance/freshness/no-absence-as-zero) |
| UX-1 untestable 5-tap promise | Major | Accept | Spec §6.1 entry points + redefined SLA + viewport tests |
| UX-3 layout/template transition undefined | Major | Accept; reconciled with adopted P1 (zone property) — transitions still needed for zone-settings changes and per-entry override | Spec §6.2; addendum P1/P3 verdicts |
| UX-9 i18n not a delivery contract | Major | Accept | Spec §6.4 (icon_key in §4.3; reviewed-labels-or-visible-fallback; CI coverage) |
| SYS-13 attachment contract unsafe | Major | Accept | Spec §4.7 content-addressed contract |
| SEC-5 feature-flag semantics | Minor | Accept; Q6 decided = UI-visibility-only flag, no v1 writes switch | Spec §10 |
| UX-8 marker density | Minor | Accept | Spec §6.3 |
| STD-6 wrong ADAPT-observation rationale | Minor | Accept (my error in v1 spec) | Spec D9 + §8 corrected wording |

## Enhancement adjudication

| # | Enhancement | Decision |
|---|---|---|
| 12 | Recent-activity personalization | v1 Slice 2 (already U1) |
| 2 | Linked irrigation annotation | Fast-follow after Slice 2; schema hook (`actuation_expectation_id`) in Slice 1; aligns with addendum P9 |
| 1, 3–11 | Orchard layout, ÖLN reminder, BLV library, campaign registry, photos, deposit bundle, ADAPT observations, tap-to-hear, authoring UI, phone queue | v2 as recommended (orchard gated on named-pilot evidence per D8/Q2) |

## Open questions Q1–Q6 — autonomous decisions

Recorded normatively in parent spec §12: Q1 detailed-record-only; Q2 no orchard pilot → 3+1 layouts with documented limits; Q3 multiple campaigns → identity in Slice 1; Q4 tenant = gateway + owner user; Q5 no named ADAPT consumer → OSI semantic profile v1 as acceptance contract; Q6 UI-visibility-only flag.

## Phase-2 questions decided without the review

- **Cascade mechanism:** layout `definition_json` `option_dependencies` (layout-doc recommendation + AGR-3 agreement; keeps shared vocab flat and reusable).
- **Product registry (U5):** dedicated `journal_products` table (not vocab kind) — structured composition, tenant-owned farm rows, immutable-after-use; derived nutrient rates computed at display/export from frozen compositions, never stored (no drift).
- **Layout binding:** P1 adopted via `journal_zone_settings` (avoids touching the `irrigation_zones` sync contract).
- **Combined operations:** entry-level `pass_uuid`; SoilManageR `combination` derived at export.
- **Picker stress-test items** (shortlist size, cold start, synonym curation workflow, near-duplicate devices): deferred to Slice-2 implementation planning; U1–U3 stand as adjudicated. <!-- slop-allow: preserved historical wording -->

## What was deliberately not adopted

Nothing was rejected outright. Two reviewer suggestions were scoped down: SYS-7's replacement-Pi rehydration is explicitly out of v1 (as the reviewer itself proposed), and SEC-5's optional `fieldJournalWritesEnabled` kill switch is omitted from v1 (capability gating covers the compatibility risk; a UCI switch can be added later without schema impact).
