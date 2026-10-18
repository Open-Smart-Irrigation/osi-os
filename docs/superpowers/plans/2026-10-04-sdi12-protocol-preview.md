# SDI-12 reply framing and capacity preview

Continue package 3 of the [approved preparation programme](../specs/2026-10-04-sdi12-prebench-readiness.md)
using the supplied [sensor audit](../../devices/sdi12-protocol-audit/README.md).
This slice checks raw command/reply exchanges offline before sensor recipe
compilers depend on them. The acquisition and persistence boundary stays as
specified in the [review decisions](../specs/2026-10-03-sdi12-review-decisions.md).

## Scope and evidence

Use SDI-12 1.4 (2023), §§4.4.5–4.4.12, for announced waits/counts, numeric replies
and CRC. The standard permits a sensor to return fewer values per D command than
would fit. Capacity calculations therefore cannot predict the observed number of
blocks. A valid empty D response means measurement aborted, not a block to skip.

The supplied audit needs reconciliation before its recipe proposals become code:
TEROS firmware/EC evidence, Tensiomark timing and the short printed `0082` reply,
PR2 block-count bounds, and unsupported HydraScout mappings. Preserve the supplied
evidence JSON as research provenance; record corrections separately and qualify
the report's implementation recommendations. Do not claim all source transcriptions
were independently verified.

No runtime, existing normalizer/recipe, flow, database, deployment or live sensor
changes. No manufacturer contact. Every tool result includes
`hardware_verified: false`, `acquisition_available: false`, `eligible: false`.
Do not generate Dragino downlinks, assert full-reply forwarding works, silently
strip markers/addresses/CRC, infer missing CR/LF, or activate firmware profiles.

## Task 1: Pure offline protocol engine

Terra owns `scripts/lib/sdi12-protocol-lab.js` and
`scripts/test-sdi12-protocol-lab.js`. Root owns all other files. Export two pure
functions, `inspectExchange(input)` and `calculateCapacity(input)`. Never mutate
inputs or throw for malformed JSON-compatible input; return bounded error codes.
Use no runtime services or network. No subagents or commits by the worker.

Exchange input, exact keys:

```json
{
  "command": "0M3!",
  "response": "00026\r\n",
  "blocks": [
    {"command": "0D0!", "response": "0+10+20+30\r\n"},
    {"command": "0D1!", "response": "0+40+50+60\r\n"}
  ]
}
```

- Command address is exactly one ASCII digit or letter; comparison is case
  sensitive. Command families: M, C, MC, CC with optional suffix 1..9. Reject M0,
  C0, wildcard addresses, writes and all other command families.
- Require exact CR/LF framing. Announcements have address + three wait digits +
  one count digit for M/MC, two for C/CC. Do not pad malformed vendor examples.
  Wait is 0..999 seconds. Zero count is represented as `no_values` only with zero
  wait and no blocks; otherwise reject. This is an explicit conservative policy.
  `no_values` has `ok:false`, code `no_values`, empty values/tokens/blocks, and
  no next command. It establishes neither base-C support nor sensor qualification.
- `blocks` is an array of at most ten exact `{command,response}` objects. Each
  command must be the next D index, starting D0, same case-sensitive address.
  D replies do not carry a block index; never guess it from concatenated text.
- Each data reply retains its original response and numeric token strings. Parse
  signed decimal tokens, at least one digit total, up to seven digits and one
  optional decimal point, at most nine characters including sign. Permit a
  leading or trailing decimal point with digits on the other side. Reject
  exponent, whitespace, missing sign, non-ASCII or trailing text. Preserve zero
  and negative/error-looking values as raw numbers; this layer does not assign
  sensor meaning or apply calibration/sentinel rules.
- The numeric body limit is 35 characters after M/MC, 75 after C/CC, excluding
  address, CR/LF and CRC. Reject a single overlong block. Values never span blocks.
- For MC/CC require three CRC characters. Verify CRC-16 initialized to zero,
  reflected polynomial 0xA001, calculated over address plus numeric body. Encode
  as `0x40 | (crc >> 12)`, `0x40 | ((crc >> 6) & 63)`, `0x40 | (crc & 63)`.
  The last two encoded bytes may be DEL (0x7f); do not apply printable-only rules
  to CRC. Reject missing/wrong CRC; non-CRC commands must not accept an extra CRC.
- Stop only at the announced value count. A transcript ending earlier returns
  `ok: false`, `disposition: incomplete`, collected raw values and `next_command`.
  D9 exhaustion returns `data_blocks_exhausted` without a next command. Too many
  values, or any extra block after completion, is invalid, not silently trimmed.
- An empty valid D response returns `ok: false`, `disposition: aborted` and no
  next D command. Verify CRC even for empty replies when requested. Reject
  subsequent blocks after this terminal response. Do not expose partial values
  as a complete vector or carry them into a later acquisition.
  Aborted output omits top-level values/tokens, retains raw block evidence, and
  uses code `measurement_aborted`.
- Complete result: `ok: true`, `disposition: complete`, `address`, `family` (M/C),
  `crc_requested`, `wait_seconds`, `announced_count`, ordered `values`, `tokens`,
  and per-block `command`, `raw_response`, `value_characters`, `wire_bytes` and
  tokens. All results keep the three constant false qualification flags.
  Invalid results have `ok: false`, `disposition: invalid`, `code` and no values.
  Incomplete/aborted/no_values results also carry a bounded `code`.
- Bounds: command length <=6, announcement length <=8 including CR/LF, each raw
  D response <=81 characters (75 + address + CRC + CR/LF). Reject unknown fields,
  scalar/array substitutions, holes, non-strings and non-finite inputs.

Capacity input, exact keys: `{family: 'M'|'C', value_count, value_width, crc}`.
Require integer count 1..9 for M, 1..99 for C, integer width 2..9, boolean CRC.
Return cap 35/75 as `value_characters_per_block`, `values_per_packed_block`,
`packed_blocks`, `packed_wire_bytes`
(`value_count * value_width + packed_blocks * (3 + (crc ? 3 : 0))`),
and `fits_ten_blocks`. Report `packing_assumption: 'equal_width_tightly_packed'`
and `actual_block_count_known: false`. Width is a hypothetical signed-token width,
not a documented width for a probe. Do not infer converter slots, radio frames,
regional airtime, readiness, or maximum firmware block count from this arithmetic.
Capacity success has `ok:true`, `disposition:'capacity'`, and qualification flags;
errors use the same invalid envelope as exchange errors. Byte counts cover only
D responses, not command, announcement, converter or radio overhead.

TDD with meaningful contract cases: standard one-block and sparse multi-block
examples; PR2 synthetic widths including four width-nine values and six width-six
values under M; C sparse responses despite available capacity; complete/incomplete/
aborted/count mismatch/D9 exhaustion; duplicate or reordered D commands; address
case errors; exact framing and unknown fields; seven/eight digit boundaries;
numeric exponent/whitespace/nonfinite rejection; correct/incorrect/absent CRC,
including published `0+3.14OqZ` and `0+3.14+2.718+1.414Ipz`; generated CRC DEL
boundary checked independently; CRC of empty response; zero-count refusal policy;
capacity calculations from audit explicitly labeled as packed estimates. Record
the initial failing run and final result in the task report.
Pin C count 99 acceptance, three-digit count rejection, overcount, C D9 exhaustion,
empty D after partial values, and extra blocks following completion or abortion.
No timing inputs exist: do not claim to validate waits, service requests, bus
timing or acquisition freshness.

## Task 2: CLI, evidence and review reconciliation

Root creates `scripts/preview-sdi12-exchange.js`, `.test.js`, and
`scripts/fixtures/device-integration/sdi12/protocol-examples.json`.
CLI accepts `--list`, `--example NAME`, or one JSON file (<=1 MiB).
File input is `{operation:'exchange'|'capacity', input:{...}}` with exact keys.
Print JSON only, exit 0 for `ok:true`, 1 otherwise. Reuse helper codes, bound errors.
Review correction: share a bounded JSON reader with the existing transport CLI.
Reject nonregular files without waiting for a FIFO writer and limit actual reads
to 1 MiB even when a file grows after the size check. Cover both CLIs with the
same regression; this is the only change to the preceding transport slice.
No writes or network. Mark each bundled fixture as synthetic or a transcribed
standard example, with source/section and explicit transformations such as
replacing printed CR/LF notation with actual control characters.
Document any omitted service requests; this is response framing, not timed replay.

Include examples for published CRC, legal sparse blocks, incomplete exchange,
aborted exchange, malformed Tensiomark announcement (synthetic framing added,
not a vendor wire capture), and PR2 M/C capacity comparisons. CLI tests invoke
all examples, file mode from outside repo, and invalid usage/input; assert the
qualification flags and expected outcomes. Add both suites to offline SDI-12 CI.

Write a user guide with an executable example, exact limitations, and links to
the audit reconciliation. Clarify that a whole-reply parser does not establish
converter preservation or acquisition identity. Update audit README statements
that overstate block counts or qualification; keep unresolved sensor modes
unavailable. Do not import old TEROS EC semantics into current candidates.

## Task 3: Review, verification and commit

Astra adversarially reviews this plan before implementation and reviews finished
code/spec compliance. Sol independently runs the exact offline CI command and
additional protocol boundary probes. Recheck material fixes, lint changed prose,
validate all supplied JSON, check documentation hygiene and whitespace. Record
decisions and verification in a permanent execution report, then commit only the
reviewed scope locally. No publishing.
