# Cross-Zone Research Analysis — moved (pointer)

This design is **cloud-only** OSI Server work, so its durable, implementation-driving home is
the `osi-server` repo:

> `osi-server/docs/architecture/2026-06-18-cross-zone-research-analysis-design.md`

This file is a pointer only — do not edit the design here. It was brainstormed in `osi-os`
(2026-06-18) and promoted to `osi-server` because the `osi-os/docs/superpowers/specs/` tree is
treated as transient planning material.

Summary: a desktop, research-aligned `/analysis` surface on OSI Cloud to compare sensors across
all accessible zones/farms — a free-form `(zone × sensor)` series builder with an overlay
preset, auto stacked-by-unit reconciliation, and an ECharts renderer. No R in the interactive
path. See the osi-server doc for the full API, schema, and contracts.
