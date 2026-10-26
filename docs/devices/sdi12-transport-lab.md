# SDI-12 transport replay lab

The lab compares the shipped decoder and segment assembler with a conservative
offline candidate. It reproduces a mixed-cycle reading and tests which additional
checks reject it. A completed assembly remains ineligible for acquisition: neither
policy establishes that its bytes describe one fresh measurement under a verified
configuration.

Run from the repository root:

```sh
node scripts/replay-sdi12-transport.js --list
node scripts/replay-sdi12-transport.js --example mixed-cycle-gap
node scripts/replay-sdi12-transport.js --example consecutive-counter-ambiguity
node scripts/replay-sdi12-transport.js capture.json
node --test scripts/test-sdi12-transport-lab.js scripts/replay-sdi12-transport.test.js
```

The CLI prints JSON. Exit 0 means the recording was replayed, including frames
that were rejected; exit 1 means the input or invocation failed. Every report sets
`hardware_verified`, `acquisition_available` and `eligible` to false. Nothing is
sent to a device or written to measurement storage. Live ingestion is unchanged.
The comparison runs the codec and assembler directly. It excludes the Node-RED
gate's profile filtering and uplink deduplication, as well as storage. For example,
the duplicate fixture reaches the assembler here; the live gate would normally
drop that identical frame before assembly.

## What the comparison establishes

| Recording | Shipped assembler | Offline candidate | Meaning |
|---|---|---|---|
| Index 0 / FCnt 100 / `+10`, then index 1 / FCnt 103 / `+40` | Completes `+10+40` | Rejects the gap | The shipped path can combine complementary fragments from different cycles |
| Same fragments with FCnt 100 and 101 | Completes `+10+40` | Also completes | Consecutive radio frames alone cannot establish sensor acquisition identity |
| Duplicate index 0, then index 1 | Resets, retains replacement index 0, then completes | Clears buffer and refuses continuation | A legacy reset can seed later output |
| Session label changes between fragments | Can complete across the labels | Clears partial assembly | Protection depends on an externally established session order |
| Unseen old session A follows current session B | Has no session concept | Treats A as new and retires B | Opaque labels alone cannot establish which session is current |
| Restart | Loses partial buffer | Refuses subsequent frames in this replay | Durable context recovery is not implemented |
| Positive ACK after a missing or failed command | No application proof | Evidence record only | A final ACK cannot fill missing command evidence |

Counterexamples describe synthetic converter behavior. They establish a limitation
of the proposed inference, not a finding that installed firmware behaves that way.
The first gap case exercises a real missing guard in the shipped assembler.

The candidate requires index 0 first, then consecutive indices and frame counters
within one annotated epoch and the same count/PAYVER. It retains the existing
600000 ms timeout as a test parameter, including the boundary; this is not a
documented sensor freshness interval. Missing context, lossy body decoding,
unsupported frames and structural faults clear candidate buffers. Single-segment
messages still require index 0. Replayed counters are refused within an observed
epoch; an epoch already retired in this recording cannot be used again.

A malformed status packet can throw inside the actual codec. The lab records a
bounded `codec_error`, preserves its raw bytes and continues. It does not patch
the shipped decoder. Such a frame also invalidates candidate assembly.

## Recording format and assumptions

Use a scenario's `input` object from
[`transport-scenarios.json`](../../scripts/fixtures/device-integration/sdi12/transport-scenarios.json)
as the starting point for a file. All bundled examples are synthetic. A recording
may be labeled `installed_capture` only when its source is an installed device;
the label itself never changes eligibility.

Each uplink wrapper carries a nondecreasing `at_ms`, optional `session_epoch`,
and an `event` containing `deviceInfo.devEui`, `fCnt`, `fPort`, and base64 `data`.
`at_ms` models arrival time in the replay; retain the original event timestamp
inside `event` when testing late delivery. Additional event metadata is retained.
ACK and TXACK wrappers retain their event
data and queue item ID. Restart is an explicit wrapper event. Input is bounded to
1000 events and 255 decoded bytes per frame; the CLI accepts files up to 1 MiB.
These are lab resource limits, not regional radio payload budgets.

`session_epoch` is a harness annotation. It is not a promised ChirpStack field.
Its ordering must come from separate trustworthy evidence; choosing a label from
DevAddr or from a counter reset does not supply that evidence. In a capture where
session identity is unknown, omit it and inspect the candidate's refusal. ACKs
are preserved without matching them to a proposed configuration transaction.
No queue-empty or final-tag inference is implemented.

## PAYVER and DATAUP

The following table combines the vendor's configurable header with the shipped
codec's narrower convention. DATAUP is not supplied in an uplink header, so the
lab cannot independently verify the configured layout.

| Converter DATAUP | PAYVER byte | Shipped interpretation | Lab candidate |
|---|---|---|---|
| 0, single payload | 1 | ASCII after byte 2 | Supported convention, subject to context/body checks |
| 1, segmented | 2 | Count/index at bytes 3/4 | Supported convention, subject to strict assembly |
| 0 | 2 | Treats first data bytes as count/index | Mismatched convention; no validity guarantee |
| 1 | 1 | Treats count/index as body bytes | Mismatched convention; candidate rejects lossy body decoding |
| Either | Any other byte | Unsupported | Refused; no arbitrary-tag mapping |

## Source and test ledger

Public references checked 2026-10-04. These links are mutable; no downloaded
reference snapshot is committed. Edition and installed firmware still need to be
matched before a recipe is qualified.

| Claim / source | Test or follow-up | Limit |
|---|---|---|
| Dragino DATAUP selects single/segmented layout; PAYVER is configurable. [Manual §§2.3.4, 2.4.5, 3.6](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/) | `single`, `normal`, `unsupported-payver`; mismatch cases in CLI tests | PAYVER is not documented as an acquisition transaction ID |
| Dragino documents 15 command slots and up to 15 segments. [§2.3.4](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/) | Helper segment bounds; command-budget emulator remains a later slice | OSI's eight-slot compiler limit is separate; verify segment numbering on installed firmware |
| ALLDATAMOD, when enabled, adds command markers; DATACUT takes precedence. [§2.3.4](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/) | `lossy-markers` preserves bytes and refuses stripped content | Marker semantics across retries still unresolved |
| NEWLINE separates command groups; invalid validated returns trigger resend, maximum three retries. [§§2.3.4, 3.12](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/) | Command/retry emulator deferred | No cycle identity proof; timeout retries, total attempts and buffer behavior unresolved |
| ChirpStack uplinks expose raw data and radio metadata, without a universally present session identifier. [Event schema](https://github.com/chirpstack/chirpstack/blob/master/api/proto/integration/integration.proto) | Session, retired-epoch and replay tests | Optional `JoinServerContext.session_key_id` applies when ChirpStack lacks the AppSKey for end-to-end decryption; see [common schema](https://github.com/chirpstack/chirpstack/blob/master/api/proto/common/common.proto). This lab implements no session-evidence provider |
| `ack` includes queue item ID and acknowledgement outcome. [Event documentation](https://www.chirpstack.io/docs/chirpstack/integrations/events.html#ack---confirmed-downlink-nack) | `ack-evidence-only`, helper ACK cases | Device acknowledgement is not sensor command readback |
| `txack` can precede scheduled transmission. [TxAckEvent schema](https://github.com/chirpstack/chirpstack/blob/master/api/proto/integration/integration.proto) | TXACK remains evidence only | Gateway scheduling is not delivery or application |

## Focused transport consultation

The [parallel external prompt](sdi12-external-research-prompt.md) assigns sensor
protocol research while this lab is built. Once those findings arrive, supply
this lab and the [review decisions](../superpowers/specs/2026-10-03-sdi12-review-decisions.md)
for a narrower transport consultation. Request concrete counterexamples to each
proposed guarantee and a recommendation among these options:

| Option | What must be established | Present decision |
|---|---|---|
| Bracket configuration writes with PAYVER tags and ACKs | All commands applied, buffers drained, sample tied to revision; safe tag lifetime/exhaustion | Insufficient documented evidence; do not activate |
| Operator readback with retained configuration and session evidence | Reliable readback commands and a capture boundary excluding delayed frames | Research exact procedure; do not assume console success proves future samples |
| Keep candidate acquisition unavailable | Preserve legacy operation and raw observations while unknowns remain explicit | Current behavior |

Ask specifically how to distinguish the consecutive-counter counterexample, how
to order session transitions without a durable event field, and whether NEWLINE
or command readback can retain enough provenance to reduce the ambiguity. Define
which evidence survives restart and how byte-sized tags can be exhausted without
reuse collisions. Delayed frames must never be reinterpreted using the latest
desired settings.

This slice does not implement tag allocation, configuration transaction correlation,
durable provenance, converter command emulation or hardware qualification. Those
remain separate tasks in the [readiness programme](../superpowers/specs/2026-10-04-sdi12-prebench-readiness.md).
