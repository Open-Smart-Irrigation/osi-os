# Tensiomark field integration execution report

This records the initial implementation review. Subsequent fixes and rollout
evidence are tracked in the [acceptance continuation](2026-10-16-tensiomark-acceptance-execution-report.md).

The reviewed software supports one or two explicitly configured Tensiomark addresses, converts pF to canonical kPa once on the edge, and preserves accepted and rejected raw observations. Live deployment verification remains pending. Scratch tests and a migration rehearsal do not establish field reception or cloud availability.

The implementation follows the [approved specification](../specs/2026-10-15-tensiomark-field-integration.md) and [reviewed plan](2026-10-15-tensiomark-field-integration.md). Calibration range remains unverified; the saved qualification is `bench_observed`. No irrigation assignment or controller enablement is part of this change.

## Reviewed changes

| Repository | Commit | Change |
|---|---|---|
| Edge | `7498bc5e1` | Strict addressed parser, explicit layout validation and configuration hash |
| Edge | `4d33ea537` | Atomic canonical/raw observation storage, migration 0074, configuration route and discovery guards |
| Edge | `1f82000ac` | Reachable settings and paired SWT/temperature display with nullable depths |
| Edge | `0f615660f` | Allow an enabled owner or admin to configure an unassigned SDI-12 device |
| Cloud | `203a5b67` | Both SWT/temperature history paths and layout metadata |
| Cloud | `129f5f0a` | Strict layout aliases, partial-update preservation, null-depth history discovery and formatting fixes |

Independent review caught missing provenance for empty replies, order-only configuration updates, duplicate HTTP error responses, permissive cloud layout handling, websocket layout loss and disappearing history after rejected samples. The fixes were rerun. The three initially reported cloud frontend failures passed on the baseline and failed on the first implementation; they were introduced regressions and are now resolved.

## Verification evidence

These counts come from independent reviewer runs on 2026-10-15. The suites overlap and must not be added into a unique-test total.

| Check | Result |
|---|---|
| Edge normalizer, runtime, registration and recipe flow suites | 122 passed |
| Edge API, settings modal, soil card and history registry | 74 passed |
| Edge TypeScript check | Exit 0 |
| Cloud frontend feature and regression suites | 65 passed |
| Independent cloud malformed-layout cases | 4 passed |
| Cloud backend policy, catalog, temperature history and PostgreSQL scope suites | 69 passed, including 20 PostgreSQL integration tests |
| Public scoped-access helper and write suites after the port | 120 passed |
| Scoped-access verifier, profile parity and function parsing | Exit 0 |

A recorded native `sqlite3` test used a scratch database and confirmed accepted writes, retained rejected evidence, rollback on failure and zero foreign-key violations. A separate rehearsal advanced a protected copy of a provisioned gateway database from migration 70 to 74 by applying additive migrations 71–74. Row counts and full-row SHA-256 digests stayed identical for `device_data`, `devices`, `users`, `irrigation_zones`, `sync_outbox` and `sync_inbox`; integrity was `ok` with zero foreign-key violations. Operational logs and database copies remain outside the public repository.

The public port contains only the generic scoped-access fix. No customer branding, network configuration, hardware identifiers or credentials were copied with it. Both maintained runtime profiles remain byte-identical.

## Remaining field verification

The executing operator must verify the deployed payload and migration ledger, then register through the ordinary owner session and save the explicit layout without a zone assignment. A fresh join must be followed by a real addressed uplink, a linked raw observation and canonical four-channel row, API/card/history readback, and confirmed cloud delivery. Deployment and cloud rollout status must be recorded separately from radio reception.

Installed depths, calibrated range and the outstanding electrical checks remain unverified. No live measurements are claimed by this report.
