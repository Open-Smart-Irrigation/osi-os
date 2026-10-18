# SDI-12 external review correction evidence

The correction addresses the confirmed offline-profile and legacy-adapter
findings against base `40fc259ed` on `feat/sdi12-profile-foundation`. The
[plan](2026-10-03-sdi12-external-review-followup.md) and
[decision record](../specs/2026-10-03-sdi12-review-decisions.md) define its scope.

Candidate version 2 rejects undocumented Tensiomark hPa, requires variant 1,
uses its documented temperature range and removes firmware from desired TEROS
settings. Evaluated rules now have pinned interpretation hashes; the full
configuration hash includes that digest and address/depth metadata. Range-only
PR2 or TEROS VWC failures can retain other channels as partial, while fatal
errors still suppress every sensor channel. The CLI signals partial data with
exit 1. Legacy descriptors preserve generic learned counts and valid depths.

## Reproduction and test evidence

The two new legacy regression tests failed against the original adapter: generic
descriptions exposed extra channels, and zero/fractional depths became null.
Candidate contract tests failed before implementation of version 2. The CLI
partial test failed because the previous CLI returned exit 0 for partial data.
Each passed after its correction.

The version pin was tested by temporarily changing TEROS's accepted VWC maximum
from 70 to 71 without a version change. The digest test failed with the expected
version-bump diagnostic. The original source was restored before the final
suites and profile-parity checks.

| Verification | Result |
|---|---|
| Exact helper/CLI CI command | Exit 0; 106 passed, 0 failed |
| Combined device integration, registration, recipe schema/flow | Exit 0; 76 passed, 0 failed |
| `verify-sdi12-codec.js` | Exit 0 |
| `verify-profile-parity.js` | Exit 0; both Pi payloads match |
| `verify-channel-manifest-parity.js` | Exit 0 |
| `verify-helper-registration.js` | Exit 0 |
| `verify-module-file-deploy-coverage.js` | Exit 0; 119 files covered |
| Legacy `index.js` comparison with base | No changes in either Pi profile |

An independent reviewer approved the correction plan and found no material
source/test defects after implementation. A separate verifier reran all gates
above, checked mirror bytes and reviewed the updated documentation. No material
behavior/evidence contradiction was found. The full sync-flow gate and frontend
build were not run; this correction changes no flows, schema or frontend code.

The ecoTech technical table was rendered and visually inspected before changing
the temperature bounds. Vendor and ChirpStack sources in the decision record
were checked independently of the external review. Synthetic fixtures remain
synthetic; no sensor, gateway or production host was accessed.

## Open transport defect and next boundary

A read-only reproduction also confirmed the existing mixed-cycle reassembly
problem: segment 0 carrying `+10` at counter 100 followed by segment 1 carrying
`+40` at counter 103, ten seconds later, returns `complete` with `+10+40`.
The current helper ignores the supplied counters. The correction does not alter
that live transport path, and candidate acquisition remains disabled.

The next reviewed work must establish transport evidence and rejection rules
before adding revision persistence. A final PAYVER tag cannot establish all
preceding command writes; an ACK establishes radio receipt, and an effective
timestamp alone cannot select historical depth metadata. The decision record
lists the required counter/session, tag-lifetime and failed-apply simulations.
