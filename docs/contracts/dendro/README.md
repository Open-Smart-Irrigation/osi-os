# Dendrometer Golden Vectors

These fixtures are the cross-repo dendrometer analytics contract. `osi-os` is the
source of truth. `osi-server` mirrors the shared fixture set byte-for-byte under
`backend/src/test/resources/contracts/dendro/`.

- `MANIFEST.json` lists every shared case.
- `cases/` contains the shared DailyPoint envelope fixtures consumed by the edge
  module and mirrored by `osi-server`.
- `edge-node-cases/` contains the extraction replay fixture for `dendro-compute-fn`; it proves the flow adapter produces the same DB writes after the compute core moves into `osi-dendro-analytics`.

For the shared contract, inputs use `dendrometer_daily` daily-point field names
and expected outputs assert the shared envelope/TWD/MDS core:
`envelope_ref_um`, `twd_night_um`, `twd_day_um`, and `mds_um`.

The shared contract intentionally excludes edge-only and server-only downstream
policy fields such as `stress_level`, `twd_rel`, RDI recommendations, confidence
rollups, and irrigation decisions.

CI verifies two things:

1. `osi-os` recomputes every shared case from `MANIFEST.json` with the extracted
   edge module.
2. `osi-server` carries a byte-identical mirror of `MANIFEST.json` and `cases/`.

When a legitimate analytics change alters these vectors, update the `osi-os`
fixtures first, mirror the same files into `osi-server`, and keep both PRs linked.
Any divergence is a contract failure until both sides intentionally agree.
