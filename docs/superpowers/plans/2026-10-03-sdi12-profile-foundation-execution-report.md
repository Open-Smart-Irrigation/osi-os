# SDI-12 profile foundation execution report

This records `40fc259ed`. The
[external review follow-up](2026-10-03-sdi12-external-review-followup.md) corrects
the candidate rules and legacy adapter; the counts below describe the original run.

The offline configuration resolver and preview CLI are implemented on
`feat/sdi12-profile-foundation`, based on `031cfaf4b47397b4a8e33a4f3385ebe68e2cc7cd`.
This completes the [foundation plan](2026-10-03-sdi12-profile-foundation.md).
The original checkout and its preparation drafts were left untouched.

## Delivered behavior

Versioned candidate configurations describe PR2/4, PR2/6, TEROS 11/12 and
Tensiomark channels, units and depths. Resolution rejects unknown fields and
settings, returns a content hash, and keeps acquisition unavailable. HydraScout
returns `protocol_evidence_required`; its response order and units still need
vendor evidence.

Candidate normalization checks exact response counts and validates every
measurement before accepting the sensor vector. TEROS uses the documented
mineral calibration and rejects its error sentinels. Tensiomark converts explicit
pF or hPa input to kPa without the legacy 300 kPa clamp. Battery diagnostics
remain available when sensor values are quarantined.

The legacy adapter describes existing PR2 learned counts and Sentek layouts.
The deployed normalizer's behavior is unchanged: its only source changes are
additive lazy exports. Both Pi payloads contain identical source and tests, and
`deploy.sh` explicitly delivers the new module.

The CLI runs the shipped codec against labeled synthetic examples. Try
`node scripts/preview-sdi12-profile.js --example teros12`; the result includes
46.81% VWC, −10 °C, zero EC and 3.3 V battery, with `hardware_verified: false`.
Usage and validation rules are in the
[preview guide](../../devices/sdi12-offline-preview.md).

## Test evidence

Tests were written before implementation. The resolver first produced eight
missing-function failures, candidate normalization then produced five, and the
CLI/delivery tests produced six missing-behavior failures. Each group passed
after its implementation.

The implementation author and an independent verifier ran the scoped checks
below successfully. No sensor or gateway was contacted.

| Check | Result |
|---|---|
| Normalizer, reassembler, recipe, commissioning and CLI suites | 101 tests passed |
| Device integration, registration, recipe schema and recipe flow | 76 tests passed in the combined runner |
| SDI-12 codec verifier and codec robustness verifier | Exit 0 |
| Module-file deployment coverage | Exit 0; 119 module files covered |
| Helper registration, profile parity and manifest parity | Exit 0 |
| `bash -n deploy.sh` | Exit 0 |
| Prose lint and staged whitespace check | Exit 0 |
| Documentation hygiene scanner | Exit 0 using built-in patterns; private name-list and allowlist-staleness checks unavailable |

The sync-flow CI workflow now runs the 101 helper/CLI tests in its own named
step. Existing workflow steps continue to cover the registration and recipe
scripts. The full sync-flow gate and frontend build were not run for this slice;
no flow, schema or frontend source was changed.

## Review and decisions

Plan review required use of the existing VM codec loader pattern, bundled
manifest loading by relative path, and the module-file deployment gate. All
three were included before implementation. Independent whole-diff review found
no material defects and checked 38 additional legacy, boundary, malformed-input
and module-loading cases.

The CLI also accepts `--example` to make fixtures directly runnable. Candidate
samples use `complete`, `quarantined` and `no_response`; partial acceptance awaits
evidence for independent per-position failures. These statuses are local return
values and do not alter a persisted enum.

## Remaining work before bench testing

Durable desired/observed configuration revisions and the acquisition transition
fence must precede live use of the candidate normalizer. Subsequent work covers
ingestion persistence, commissioning state, UI/cloud integration and the offline
failure/recovery matrix in the
[preparation design](../specs/2026-10-02-sdi12-sensor-expansion-preparation.md).
HydraScout still needs an authoritative protocol description. Electrical timing,
actual firmware responses and recipe activation require bench evidence.
