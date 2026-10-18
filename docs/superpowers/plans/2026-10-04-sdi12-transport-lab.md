# SDI-12 offline transport lab

Spec: [prebench readiness](../specs/2026-10-04-sdi12-prebench-readiness.md), package 2,
and [review decisions](../specs/2026-10-03-sdi12-review-decisions.md).

Implement the first transport slice: an executable comparison of the shipped
decoder/reassembler with a conservative, explicitly hypothetical assembly policy.
Use the comparison to expose what counter/session checks can and cannot establish.
This slice does not settle application verification or revision activation.

## Global constraints

- Work only in `.worktrees/sdi12-profile-foundation`, based on `a7468dd6f`.
- No runtime, flow, database, deployment or device changes; no network in the lab.
- Every report has `hardware_verified: false`, `acquisition_available: false` and
  `eligible: false`. Transport completeness is a separate fact.
- Execute the actual shipped codec and legacy reassembler. Keep raw payload bytes.
- Synthetic session epochs are harness annotations, not fields promised by
  ChirpStack. Trusted ordering of epoch transitions is an additional assumption:
  an unseen old epoch cannot be distinguished from a new epoch by its label.
  Frame continuity is an assumption about acquisition, not its proof.
- Support only the current codec's PAYVER 1/single and 2/segmented convention.
  Unknown tags are rejected. No arbitrary-tag remapping or tag reuse allocator.
- ACK and TXACK are evidence records only. They never alter assembly eligibility.
- Root owns CLI, scenarios, documents and CI. Terra owns the lab helper and its
  tests. Luna finds sources. Astra reviews design/code; Sol verifies independently.

## Task 1: Implement the replay engine

Files: `scripts/lib/sdi12-transport-lab.js`, `scripts/test-sdi12-transport-lab.js`.

Export `replay(scenario)`. Scenario object: `{ name, evidence_kind, events }`;
`evidence_kind` is `synthetic` or `installed_capture`. Validate a nonempty name,
events array (maximum 1000), event shapes and bounds. Reject malformed input with
`{ ok: false, code, hardware_verified: false, acquisition_available: false,
eligible: false }`; do not throw to the caller or mutate input.

Event union:

- Uplink: `{ type: 'up', at_ms, session_epoch, event: { deviceInfo: { devEui },
  fCnt, fPort, data } }`. `data` is canonical base64, at most 255 decoded bytes;
  `devEui` is 16 hex characters (normalize uppercase), `fCnt` an unsigned 32-bit
  integer, `fPort` integer 1..223. `session_epoch` is a nonempty bounded string or
  null (missing is also unknown). `at_ms` is a nonnegative safe integer.
- ACK/TXACK: `{ type: 'ack' | 'txack', at_ms, event: { deviceInfo: { devEui },
  queueItemId, ... } }`. Preserve supplied acknowledgement data, report only
  `evidence_only`. Require valid device ID and a bounded nonempty queue item ID;
  ACK `acknowledged` must be boolean. They do not prove sensor command application.
- Restart: `{ type: 'restart', at_ms }`. Clear legacy buffers. Clear candidate
  buffers and mark candidate context unavailable for the rest of this replay:
  a new process cannot reconstruct a trustworthy replay floor from these events.

Require nondecreasing event times across the replay; malformed scenarios fail as
a whole. Output successful replay as `{ ok: true, name, evidence_kind,
hardware_verified: false, acquisition_available: false, eligible: false,
assumptions: [...], results: [...] }`. Each result has `type`, `at_ms` and, for
uplinks, `raw_bytes`, `decoded`, `event`, `session_epoch`, `legacy` and `candidate`.
Preserve event metadata in a detached copy. Both assembly results
have `action`, `code`, and `ascii` when complete. Actions are `buffered`,
`complete`, `rejected`, or `evidence_only`; restart uses `reset`. Legacy may also
return `reset`; preserve its underlying status/quarantine because it can reseed.

Legacy: real codec via VM (as in profile preview), real `step` for PAYVER 2;
PAYVER 1 completes directly. Catch legacy validation failures into a rejection.
Do not add protections to the legacy comparison; it must reproduce its defects.
Catch codec exceptions per frame as bounded `codec_error` (for example FPort 5,
base64 `Fw==` crashes the shipped codec). Preserve bytes, consume its valid
counter when session context permits, clear candidate assembly and continue.

Candidate: maintain per-device buffer, current synthetic epoch, retired epochs,
and maximum seen frame counter. A missing epoch clears the buffer and refuses;
a changed epoch clears buffer/counter and retires the previous epoch; a retired
epoch is refused. Duplicate/replayed counters (`fCnt <= maxSeen`) clear buffer and
refuse. Consume valid counters even for unsupported/status frames. Refuse frames
outside FPort 2, unsupported PAYVER, invalid segment count/index or lossy ASCII:
body bytes must be printable ASCII or CR/LF; retain raw bytes before decoding.
Every such rejection clears that device's candidate buffer.

PAYVER 1 completes only after these checks. PAYVER 2 requires count 1..15 and
index 0..count-1, including count=1. Start only at index 0. Continuation requires
the same PAYVER/count/epoch, exactly next index, and exactly previous fragment's
fCnt+1; time since first fragment must be <= the legacy 600000 ms window. On any
failure clear the buffer and reject the incoming frame; do not silently seed a
new buffer with that rejected frame. On completion clear buffer but retain epoch
and counter history. A later independent index 0 may start a fresh assembly.
No accepted transport sequence proves a common measurement cycle, fresh sensor
data, completed configuration, or the correct interpretation revision.

TDD: first reproduce the real legacy mixed-cycle completion (`+10` at fCnt100,
index0; `+40` at fCnt103, index1; count2). Then assert candidate refusal. Include
normal completion, interleaved devices, loss/reorder/duplicates, reset/reseed,
codec exception recovery, count changes,
session change and return to retired epoch, missing context, restart, timeout
at and just beyond boundary, counter rollover, index invalid even for count1,
unsupported tags/ports, lossy bytes, and input validation. Include a surviving
counterexample: complementary segments from different simulated cycles with
consecutive counters still complete; all eligibility flags must remain false.
ACK success/failure, missing ACK, duplicate/late ACK and TXACK cannot promote.
Also demonstrate the epoch-ordering limitation: current B/100, previously unseen
old A/1, then B/101 treats A as new and refuses B. This records an unresolved
requirement for trustworthy session ordering, not general replay protection.
Record the initial failing test run and final passing run in the task report.

## Task 2: Expose scenarios and consultation material

Root creates `scripts/replay-sdi12-transport.js`, its `.test.js`, and
`scripts/fixtures/device-integration/sdi12/transport-scenarios.json`.
CLI accepts `--list`, `--example NAME`, or a JSON file. Output JSON only, exit 0
for a completed replay (even if frames were rejected), exit 1 for input/usage
errors. Never write files, connect to services, or send commands. Errors are
bounded codes, not payload/stack dumps. Make report meaning clear in documentation.

Provide named scenarios for normal assembly, known mixed-cycle defect, surviving
consecutive-counter ambiguity, duplicate/reordered/lost fragments, session change,
restart, unsupported PAYVER and ACK-only evidence. Each fixture states the
synthetic provenance and its expected limitation in a description. Test actual
CLI invocation, listed names, malformed file/input, unknown names and eligibility
flags. Add both test files to the SDI-12 offline CI step.

Write `docs/devices/sdi12-transport-lab.md` with commands, evidence assumptions,
PAYVER/DATAUP table, source/claim/test ledger from Luna's findings, known
counterexamples and options for a targeted transport consultation. Link the
parallel sensor research prompt. Mark this as one completed slice, not completion
of every readiness work package. Update the readiness document with the entry
point once verified.

## Task 3: Independent review and verification

Astra reviews the plan before Task 1, then implementation for contract/quality.
Sol independently runs new tests and existing SDI-12 offline regression group,
checks actual CLI output, and attacks counter/session/ACK assumptions. Resolve
material findings, recheck affected cases, run prose lint and whitespace checks,
and record verdicts and commands in a dated execution report. Commit only this
slice's files. No publishing or live activation.
