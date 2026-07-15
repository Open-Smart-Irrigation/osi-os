# AgroLink Field Journal — Slice 2 UX proposal

Design proposal for the journal front-end (Slice 2 of the field-journal
program). Slice 1 shipped the edge record engine — plots, catalog, sync,
exports — with no UI; this document and its companion artifact propose the
capture and review interface, in AgroLink's liquid-glass language.

Interactive proposal (live CSS, real brand type/colour):
https://claude.ai/code/artifact/ef06ee60-3d0b-41bf-a18c-15453b41e5c8

Normative source: [field-journal design §6](../superpowers/specs/2026-07-12-field-journal-design.md)
and the [UX addendum](../superpowers/specs/2026-07-12-field-journal-ux-addendum.md)
(U1–U7, P1–P9). Where this proposal and the spec disagree, the spec wins.

## Design stance

The activity taxonomy is large (about 128 operation·device pairs) but a farm
repeats 8–12 all season. The interface is a personalised shortlist first and
the guided tree last: the cascade is the data model, not the default screen
(UX addendum §1). Glass is reserved for the floating chrome — header, tab
pill, action buttons — while entry fields and record surfaces stay solid and
legible, matching Apple's own rule that Liquid Glass belongs to the navigation
layer above content, never the content itself.

## Mobile capture — the common path

Four screens from a zone card's "Log activity" button to an acknowledged save:

1. **Quick grid** — six ranked activity leaves in a 2×3 tap grid, sections
   visibly labelled ("Recent on this plot" → "Common this season"), with
   search and a guided tree behind "Browse all" for cold start (U1, U3).
2. **Product-first dose** — the farmer picks a product and application rate;
   nutrient rates are *derived* from the frozen composition and shown as
   chips, never re-typed (U5). Numeric entry is large steppers anchored on the
   last value, unit as a fixed suffix (P5, P6).
3. **Confirm by reading** — one generated sentence with every value tappable to
   edit; carried-forward consequential fields render as hollow chips demanding
   a confirming tap (P2, P4).
4. **Honest save** — four distinct states: `Saving…` / `Saved on farm gateway`
   / `Saved on OSI Server — waiting for farm gateway` / `Not saved`. Server-
   saved-but-waiting never reads as farm-saved (D6).

Target: ≤5 primary-control activations for a common carried-forward entry,
tested at 320×568.

## Multi-plot batch entry

The "Where?" step multi-selects plots: a station (e.g. a 72-plot lysimeter
facility) renders as a numbered grid with a range input (`2, 5, 6, 10-12`),
never a scroll list; recurring cohorts are one-tap chips ("Barley 2026 · 5").
Finalisation fans out to one independent record per plot sharing a
`batch_uuid` (D11); the timeline collapses the batch to a single expandable
card. History charts carry journal entries as markers in a separate event
lane (icon + shape + colour, ≥48px targets), so activities explain the curves.

## Desktop three-pane workspace

On ≥1024px the Journal tab becomes a review-and-enrichment desk: a left rail
for scope and filters (stations as one collapsible row, active groups,
plots with sensor dots, status filters), a dense record table in the centre,
and the read-back sentence plus entry/enrichment form on the right. The
"needs completion" queue opens on the right with field-level focus — the
capture-in-field, enrich-at-desk split (P7). Mobile stays the capture surface;
desktop is the review/export surface.

## Build status

The IA and chrome for the journal are implemented; the capture flow is the
next build slice.

| Piece | State |
|---|---|
| Journal as a top-level tab (Zones · Data · Journal) | Done — shared `AppHeader` |
| `/journal` route + aligned landing page | Done — `JournalPage` (placeholder panel) |
| Liquid-glass chrome (floating tab pill, glass buttons) | Done |
| Mobile capture flow (quick grid, product-first, confirm strip, save states) | Proposed — this doc |
| Multi-plot batch + station grid + group chips | Proposed — this doc |
| Desktop three-pane workspace | Proposed — this doc |
| History-chart markers | Proposed — this doc |

Open question before build: whether system-initiated drafts (P9 — "valve ran
45 min yesterday, log it?") enter this slice or fast-follow. The schema hook
shipped in Slice 1, so it needs no migration.
