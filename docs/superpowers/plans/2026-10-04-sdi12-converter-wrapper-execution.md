# SDI-12 converter wrapper execution

Implemented an offline wrapper inspector, a single-payload serialization model
and an explicit bridge to standard SDI-12 validation against base `59efe73cc` on
`feat/sdi12-profile-foundation`. The CLI preserves raw bytes and command-slot
boundaries under caller-declared settings. Nine examples distinguish one published
Dragino log payload from synthetic exchanges and failure cases.

Plan: [converter wrapper](2026-10-04-sdi12-converter-wrapper.md).
Usage: [converter preview](../../devices/sdi12-converter-preview.md).

## Decisions and source checks

DATAUP selects the assumed header layout; PAYVER is an independently matched
byte. ALLDATAMOD, cleared DATACUT/DATACONV and disabled EXT are explicit caller
assertions. Their truth on installed hardware is never inferred from a parse.

DATAUP=1 remains diagnostic, including count one. It can retain a fragment ending
at a marker without losing that byte, but cannot prove which acquisition supplied
the next fragment. The cost of this decision is a further integration step if a
defensible assembly contract is established. Single-frame wrapper success likewise
does not prove that all replies are fresh or came from one sensor cycle.

Luna checked the current Dragino manual and source examples; Terra inspected the
repository codec/recipes before implementation. Root independently checked the
manual's header, wrapper, PDTA, DATACONV, EXT and segment-limit sections. Luna then
rechecked the guide and fixture provenance. The PDTA example contains exactly 18
bytes after removal of log metadata; its return includes CR/LF. A separate PDF
transcription from research was not adopted because its length needed checking.

Source: [Dragino SDI-12-LB/LS manual](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/),
checked 2026-10-04. This is documentary evidence, not installed firmware validation.

## Implementation and review

Terra implemented the pure helper and direct tests; root implemented the CLI,
examples, dependency comparison, guide and CI wiring. Initial helper and CLI tests
failed before their implementations existed. The comparison demonstrates that
the shipped codec drops DEL and split markers; runtime behavior remains unchanged.

Astra's preflight required disabled DATACONV, explicit configuration domains and
separate structural/model limits. All were adopted: modelling limits each return
to 100 bytes, the inspector retains structurally valid longer records within its
255-byte input bound, and fragment diagnostics cap the count at 15. These limits
do not choose a regional radio budget. Optional marker offsets, shuffled bindings
and detached configuration/binding provenance were also adopted.

Root caught a sparse EXT validation error during implementation: array iteration
skipped holes. Test-first corrections added indexed validation, prevented guessed
segment fields under unsupported EXT settings and preserved body bytes on malformed
wrappers. The added tests failed before the fixes, then passed.

Independent Astra review found valid raw bytes were lost when an envelope or port
was refused. Sol found that structurally valid bindings were lost on a slot-set
mismatch. Both corrections retain detached evidence while refusing the same inputs;
each regression failed before its fix, then passed. Malformed or oversized byte
arrays are still omitted, and failed bindings never produce measurement values.

## Verification

Root ran the exact updated offline CI command after both review fixes:

```sh
node --test scripts/preview-sdi12-profile.test.js \
  scripts/test-sdi12-transport-lab.js scripts/replay-sdi12-transport.test.js \
  scripts/test-sdi12-protocol-lab.js scripts/preview-sdi12-exchange.test.js \
  scripts/test-sdi12-converter-lab.js scripts/preview-sdi12-converter.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/*.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-reassemble/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js
```

Result: 161 passed, zero failures, skips or cancellations; exit 0. This includes
14 direct converter tests and four CLI/comparison tests. The SDI-12 codec and codec
robustness verifiers also passed. No runtime or sync file changed, so the full sync
gate is outside this slice's verification scope.

Astra approved the corrected slice with no remaining findings. Its 336 independent
probes covered every byte value, PAYVER/DATAUP combinations, segment boundaries,
255/256-byte model budgets and standard-parser rejection cases. The final 18-test
focused suite and additional evidence-retention probes passed.

Sol independently reran the exact workflow command after both fixes: 161 passed,
zero failures. Both codec verifiers passed again. Sol's eight semantic probe groups
and an external-working-directory CLI driver passed; both review findings were
closed without changing acceptance or qualification rules.

Changed prose and staged/unstaged whitespace checks passed. The prose checker
flagged only the technical verifier name as a tier-2 warning. Documentation hygiene
passed over 408 files using built-in patterns only; no private name list was
supplied and allowlist staleness was not checked.

## Remaining boundary

The tool models byte serialization, not command execution, cuts, conversion,
startup timing, retries, automatic D0 or radio scheduling. Response-command bindings
are hypotheses and must cover every received slot. Existing compact payloads cannot
supply their discarded announcements or framing. Source-backed sensor recipe work
can use this interface, while hardware activation and durable provenance still
depend on the acquisition-evidence decisions in the readiness programme.
