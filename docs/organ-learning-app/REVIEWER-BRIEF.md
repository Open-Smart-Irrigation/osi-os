# PocketMaestro: brief for the external reviewer

You are looking at the complete design record of PocketMaestro, a mobile
app that teaches organ playing through complete classical pieces — one
lesson per piece, short adaptive exercises, for adult classical music
enthusiasts who already read music. No code exists yet. The specification
is frozen for a two-week technical spike, which makes this the last cheap
moment to find what is wrong or missing.

## What we ask of you

Analyse the design, identify gaps, and suggest enhancements. Three specific
requests:

1. **Ranked findings**, each with a severity (blocker / major / minor), the
   document and section it concerns, and a concrete fix. Only findings you
   would defend under questioning.
2. **Gaps**: whole topics the record does not treat at all. An internal
   four-seat panel has already reviewed this design (see below), so the
   highest-value contribution is what *no* seat caught — candidates we
   suspect ourselves: onboarding flow detail, accessibility beyond one NFR
   line, support and operations after launch, localisation mechanics,
   abuse/edge cases of the commerce tiers, anything in your own field we
   did not think to name.
3. **Enhancements** worth their cost under the constraints below, and one
   thing you would cut.

## Reading order

| File | What it is |
|---|---|
| `spec.md` (draft 0.7) | The product: users, principles, lessons, exercises, pricing, tutoring, distribution, stack summary, decisions D-1..D-48, assumptions, open items. Start here. |
| `catalogue.md` (0.2) | Grading scale (two pedal-technique axes), source and licensing policy, the launch ladder, authoring effort model. |
| `architecture.md` (0.3) | Algorithms and data: scoring pipeline, adaptivity engine, console emulator, package format, database, rendering, build order, testing. |
| `panel-review-2026-09-06.md` | The internal panel's adjudication: 47 adopted changes, 7 owner decisions (all accepted), rejections, conflict notes. Read before writing findings — anything listed there is already handled or consciously declined. |
| `panel/*.md` (4 files) | The verbatim internal reviews: organ pedagogue, learning scientist, mobile/MIDI engineer, product strategist. Useful as depth on any point in the adjudication. |

## Constraints to respect (challenging them is allowed, but say so)

- One founder-organist builds alone with AI assistance at 20 hours per
  week, 4 of which are reserved for distribution. Every suggestion has an
  hours cost; name it.
- Device-local launch on Android (Pixel 8 Pro), no user accounts until the
  iOS port; no server holds learner state.
- Public-domain sources only, engraved to a declared hierarchy.
- Phone-first; subscription CHF 15/96; Swiss legal entity (private person
  founding an Einzelfirma); German and English at launch.
- MIDI scoring is the differentiator but not the entry ticket — the
  self-assessed track must be a complete product on its own.

## Where we most want your judgment

The adaptivity policy (architecture section 6) after its panel rework; the
self-assessed track's calibration design; whether the launch scope
(free lesson + four paid lessons + one free demo exercise) is a sellable
subscription; and the assumptions register (spec section 19) plus open
items (section 20) — each row there is a claim we have not yet verified,
and confirming or demolishing one is as valuable as a new finding.
