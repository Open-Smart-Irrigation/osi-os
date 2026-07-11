# Dendrometer Golden Vectors

These fixtures are owned by `osi-os`.

- `cases/` contains shared DailyPoint envelope fixtures consumed by the edge module and mirrored into `osi-server` by refactor-program item 2.3.
- `edge-node-cases/` contains the extraction replay fixture for `dendro-compute-fn`; it proves the flow adapter produces the same DB writes after the compute core moves into `osi-dendro-analytics`.

For the shared contract, inputs use `dendrometer_daily` daily-point field names and expected outputs assert the shared envelope/TWD/MDS core: `envelope_ref_um`, `twd_night_um`, `twd_day_um`, and `mds_um`.
