# SDI-12 protocol preview execution

Implemented offline command-labelled SDI-12 reply parsing and capacity estimates
against base `384579b72` on `feat/sdi12-profile-foundation`. The parser validates
M/C announcements, addressed D replies, CRC and announced counts. It distinguishes
incomplete, aborted and complete exchanges. Eight examples expose those outcomes
without qualifying a sensor or applying a configuration.

Plan: [protocol preview](2026-10-04-sdi12-protocol-preview.md).
Usage: [preview guide](../../devices/sdi12-protocol-preview.md).
Evidence decisions: [audit reconciliation](../../devices/sdi12-protocol-audit/RECONCILIATION.md).

## Evidence and ownership

The supplied five JSON files were retained without edits. The audit README was
qualified where recommendations exceeded the reviewed documentation; corrections
are recorded separately. Source checks covered claims needed by this slice, not
all 139 research claims. No source hash or complete transcription audit is claimed.

| Role | Work | Result |
|---|---|---|
| Luna finder | PR2 command tables, SDI-12 framing and capacity | Distinguished packed estimates from permitted sparse groups |
| Terra finder | TEROS firmware/units and Tensiomark timing | Identified unresolved firmware applicability, typical timing and incomplete printed announcements |
| Sol source reviewer | Cross-sensor risks and bench procedures | Kept unresolved mappings unavailable and corrected acceptance procedures |
| Astra preflight reviewer | Protocol engine plan | Required explicit output envelopes, capacity formula and terminal/boundary cases; adopted |
| Terra worker | Pure engine and direct tests | Implemented reviewed contract; 17 direct tests |
| Root | CLI, examples, audit reconciliation, CI and shared reader | Five new CLI/corpus tests, including 36 packed-capacity vectors |
| Independent Astra code reviewer | Spec compliance and code quality | Approved after two corrections; no open findings |
| Independent Sol verifier | Exact CI suite and separate CLI probes | GREEN after corrections; no open findings |

The audit supports further offline recipes, but not automatic activation. PR2
needs installed calibration readback; TEROS older EC units and firmware evidence
remain unresolved. Tensiomark timing is an experiment budget, and its printed
announcement/order does not establish a wire contract. HydraScout quantity lists
do not establish commands or data grouping.

## Review corrections

One test originally described a three-digit C count but used a valid count 99
with a nine-second wait. Its `ok:false` assertion passed because no data blocks
were supplied. The corrected test asserts `invalid_announcement` for an actual
three-digit count and separately pins the valid case.

The CLI originally checked file size before an unbounded read. Astra reproduced
an oversized valid input through a FIFO. Both offline CLIs now use a shared reader
that opens without blocking, rejects nonregular files, bounds actual reads and
closes the descriptor on every path. The new regression failed with a FIFO timeout
before the fix and passed afterward; it also simulates stale size metadata for
both CLIs. This is the only change to the preceding transport implementation.

## Verification

Root ran the exact updated offline CI command after all code corrections:

```sh
node --test scripts/preview-sdi12-profile.test.js \
  scripts/test-sdi12-transport-lab.js scripts/replay-sdi12-transport.test.js \
  scripts/test-sdi12-protocol-lab.js scripts/preview-sdi12-exchange.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/*.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-reassemble/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js
```

Result: 143 passed, zero failed, skipped or cancelled; exit 0. The initial engine
and CLI tests failed before their implementations existed. All five supplied JSON
files parse.

Astra independently generated 1,000 CRC exchanges using an MSB-first algorithm,
including 25 DEL cases, and ran 43 malformed-input/numeric probes. All passed.
After the fixes, Astra's 27 focused tests and eight file-reader probes passed.
The reader probes covered exact size boundaries, short reads, nonregular files
and descriptor closure after injected failures.

Sol independently reran the exact command: 143 passed, zero failures. A separate
driver invoked the CLI from outside the repository and checked example outcomes,
CRC including DEL/empty replies, framing, digit limits, C99, zero-count policy,
terminal/excess blocks, command order and FIFO refusal. Every probe passed and
kept all three qualification flags false.

Changed prose and staged whitespace checks passed. Documentation hygiene passed
with 405 files scanned using built-in patterns only; no private name list was
supplied and allowlist staleness was not checked. The full sync gate was outside
this slice's verification scope because no runtime or sync behavior changed.

## Next slice

Join raw converter payloads to labelled replies before compiling sensor recipes.
That work must establish wrapper lengths, slot boundaries and preservation of
CR/LF/CRC; the current codec's `data_sum` has already discarded wrapper evidence.
Timing, radio limits, command application and acquisition freshness remain outside
this parser. All qualification flags stay false. No runtime payload, schema,
deployment or live sensor was changed.
