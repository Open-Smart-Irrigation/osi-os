# SDI-12 transport lab execution

Implemented the first offline transport slice against base `a7468dd6f` on
`feat/sdi12-profile-foundation`. The CLI runs the shipped codec and reassembler
against 13 synthetic scenarios and compares an explicitly hypothetical policy.
It reproduces mixed-cycle assembly, rejects the counter-gap case in the candidate,
and preserves the consecutive-counter case that still defeats cycle inference.

Plan: [transport lab](2026-10-04-sdi12-transport-lab.md).
Entry point: [replay guide](../../devices/sdi12-transport-lab.md).
Parallel assignment: [external sensor research prompt](../../devices/sdi12-external-research-prompt.md).

## Work and review ownership

| Role | Work | Result |
|---|---|---|
| Luna finder | Dragino and ChirpStack primary-source audit, then guide claim check | Qualified session-key-context wording and narrowed retry/marker claims |
| Astra preflight reviewer | Adversarial plan review | Required per-frame codec exception handling, accurate reset/reseed reporting and an epoch-ordering counterexample; all adopted |
| Terra worker | Replay helper and direct tests | Implemented the reviewed contract; initial tests failed before the helper existed |
| Root | CLI, fixtures, documentation and CI | Initial CLI tests failed before implementation; five CLI tests now pass |
| Independent Astra code reviewer | Full slice, shipped dependencies and extra boundary probes | Spec compliance PASS; code quality PASS; no blocking or important findings |
| Independent Sol verifier | Fresh CI command, external CLI execution and adversarial probes | GREEN; no findings |

Astra's final review requested a documentation clarification: the lab invokes
codec/assembler directly and excludes the Node-RED gate's duplicate filtering,
profile selection and storage. The guide now states this, including why a duplicate
fixture can reach the assembler here even when the live gate would discard it.
The reviewer rechecked the change.

## Verification

Sol independently ran the exact updated offline CI command:

```sh
node --test scripts/preview-sdi12-profile.test.js \
  scripts/test-sdi12-transport-lab.js scripts/replay-sdi12-transport.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/*.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-reassemble/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js
```

Result: 121 passed, zero failed, skipped or cancelled; exit 0. This includes 15
new helper/CLI tests. Sol also ran 12 independent adversarial assertions and
invoked `normal`, `mixed-cycle-gap` and `consecutive-counter-ambiguity` from `/tmp`.
All passed. The reports retained raw bytes and kept every qualification flag false.

The adversarial checks covered case-insensitive device identity, detached event
metadata, `installed_capture` labels, ACK isolation, unsupported-frame counter
consumption, missing/retired epochs, unseen old epochs, restart and rollover.
Astra additionally checked three-fragment completion and invalid input boundaries.

Staged whitespace and prose lint passed. The documentation scanner passed using
built-in patterns only; no private name list was supplied and allowlist staleness
was not checked. No runtime payload, flow, schema or deployment file changed, so
the full sync gate was outside this slice's verification scope.

## Remaining work

Transport completion does not establish measurement freshness, a common sensor
cycle or complete command application. Synthetic epoch labels require an external
ordering guarantee; the lab exposes the failure when an unseen old epoch arrives.
Restart intentionally leaves candidate context unavailable for the remainder of
that recording. ACKs are retained without configuration-transaction correlation.

The next transport decision must settle session evidence, delayed frames and
configuration/tag lifetime before durable revision activation is implemented.
Source-backed sensor recipe previews and converter command emulation can progress
with the parallel audit. The [readiness programme](../specs/2026-10-04-sdi12-prebench-readiness.md)
tracks those remaining packages. The separately created sensor-protocol audit
drafts were excluded from this slice and these review verdicts.
