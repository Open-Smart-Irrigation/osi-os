# SDI-12 converter wrapper implementation plan

**Goal:** Preserve Dragino command-slot replies offline and connect explicitly
labelled replies to the existing standard parser, with a bounded payload model.

**Architecture:** Pure offline helper plus CLI, following the protocol preview.
The configuration and response-command bindings are caller assumptions. Nothing
qualifies hardware, applies commands, reassembles radio fragments or changes the
shipped codec. This continues package 3 of the
[readiness programme](../specs/2026-10-04-sdi12-prebench-readiness.md).

**Tech stack:** Node.js built-ins, existing bounded JSON reader and protocol lab.
Base: `59efe73cc`, isolated `feat/sdi12-profile-foundation` worktree.

## Evidence and constraints

Source: [Dragino SDI-12-LB/LS manual](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/),
§§2.3.4, 2.4.3–5, 3.6–7 and 3.11–12, checked 2026-10-04.
The documentation defines a command-slot marker followed by return length in
ALLDATAMOD. DATACUT has precedence. PAYVER is independently configurable; DATAUP
selects the three- or five-byte header. EXT adds fields before command returns.
NEWLINE changes segmentation. No tag identifies a unique acquisition.

The supported model assumes ALLDATAMOD=1, all DATACUT and DATACONV settings cleared, EXT=0,0,0
and one payload. These are input assertions, never evidence of installed settings.
DATAUP=1 is diagnosed only. Retain every byte, including DEL and non-ASCII values;
wrapper parsing does not imply that a body is valid SDI-12. No repair of framing,
numeric text, missing announcements or stripped bodies. Never infer layout from
PAYVER or scan through junk for plausible markers.

Every result has `hardware_verified:false`, `acquisition_available:false`,
`eligible:false`. No runtime/flow/schema/profile/normalizer/recipe/deployment edits.
No network in the implementation, hardware commands or manufacturer contact.

## Review focus

- Incorrect DATAUP can make an arbitrary PAYVER appear to select another layout.
- A marker or length may be split across radio fragments; parsing each loses data.
- Binary/DEL bytes inside a length-delimited reply must survive exactly.
- Missing, duplicate or extra slot bindings must not silently choose a reply.
- Valid wrapper structure cannot establish CRC, command application or freshness.

## Task 1: Pure wrapper parser, payload model and protocol bridge

Terra owns `scripts/lib/sdi12-converter-lab.js` and
`scripts/test-sdi12-converter-lab.js`; root owns the remaining files. Export only
`inspectFrame`, `modelSingleUplink`, `inspectWrappedExchange`. Do not mutate input;
reject malformed JSON-compatible input without throwing. All objects below require
exact keys, ordinary arrays without holes, and finite integer ranges where given.

`inspectFrame({fport,bytes,configuration})`:

```json
{"fport":2,"bytes":[12,132,1,241,13,48,43,49,46,48,56,43,50,52,46,54,13,10],"configuration":{"dataup":0,"payver":1,"alldatamod":1,"datacut":"none","dataconv":"none","ext":[0,0,0]}}
```

- `bytes` is 3..255 integers 0..255; fport must be 2. Configuration keys are
  exactly dataup, payver, alldatamod, datacut, dataconv, ext. dataup is 0/1, payver 0..255;
  alldatamod is integer 0/1, datacut/dataconv each 'none' or 'configured', ext is
  exactly three integers 0/1. Malformed domains yield invalid_configuration;
  valid but unsupported settings yield unsupported_configuration.
  support only alldatamod=1, datacut='none', dataconv='none', ext=[0,0,0]. Other valid settings
  return a bounded unsupported-configuration error. PAYVER must match byte 2.
- Return detached `raw_bytes`, `header` with battery_mv (low 15 bits), interrupt
  boolean, payver and dataup, and detached `body_bytes` once header validated.
  Set `configuration_verified:false` on every result as an additional constant.
  Successful frame output retains a detached copy of the supplied configuration.
- DATAUP=0: offset 3, parse strictly marker F1..FF (slot 1..15), one-byte length,
  exactly that many body bytes, then next marker. No scanning/resynchronization.
  Preserve each record as `{slot,offset,length,bytes,text}`. Offset is the zero-based
  marker position in the complete raw frame. `text` maps each byte
  directly to its character code without UTF-8 substitution or filtering. It is
  diagnostic byte text, not proof of SDI-12. Zero length is structurally valid.
  Reject duplicate slots, truncated marker/length/body and unexpected bytes. Slot
  order is retained; do not sort or infer absent slots. Empty body returns
  ok:false disposition='empty', code='no_records'. Invalid output has no records.
- DATAUP=1: require five header bytes; count 1..15, index 0..count-1. This is
  a conservative zero-based index policy. Add segment_count/index to header;
  retain body bytes starting at offset 5, but no records. Return ok:false,
  disposition='fragment', code='fragment_requires_reassembly', even count=1.
  Do not join fragments, infer cycle identity or call the standard parser.
- Valid complete wrappers return ok:true, disposition='wrapped'. Invalid input
  returns ok:false, disposition='invalid', bounded code. When bytes are valid,
  raw_bytes remains available even on unsupported/invalid wrapper results.

`modelSingleUplink({battery_mv,interrupt,payver,returns,max_payload_bytes})`:

- battery_mv integer 0..32767, interrupt boolean, payver 0..255, max_payload_bytes
  integer 3..255. `returns` is 1..15 exact `{slot,bytes}` with distinct slots 1..15
  and zero..100 byte arrays (documented return bound; inspector remains structural). Preserve caller order; do not pretend to execute it.
- Construct battery big-endian with interrupt bit, PAYVER, then F0|slot, length,
  raw body for each return. Refuse output longer than max_payload_bytes (or 255)
  with code='payload_budget_exceeded', reporting required_bytes. The supplied
  budget is caller policy, not a verified regional/data-rate limit.
- Success returns ok:true disposition='modelled', model='all_data_no_cut_single_v1',
  `bytes`, `required_bytes`, `max_payload_bytes`, and constant false flags.
  This only models wrapper serialization: no cuts/conversion, timing, retries, firmware
  conformance, automatic D0, NEWLINE or actual radio behavior.

`inspectWrappedExchange({frame,bindings})`:

- `frame` is exactly an inspectFrame input. `bindings` is 1..11 exact
  `{slot,response_command}` records. Slots 1..15 distinct. response_command is
  a bounded string (1..6 chars); the protocol parser enforces command grammar.
  bindings must match every parsed wrapper slot exactly once. Map by slot, use
  wire-record order; no selection/discarding extra records or accepting absent
  bound slots. Bindings name the command that elicited the preserved response,
  not necessarily COMMANDx's configured text (automatic D0 is a known difference).
- Only a successful single-frame wrapped result can bridge. Construct
  `{command:first.response_command,response:first.text,blocks:remaining records}`
  for existing inspectExchange. Thus a missing M/C announcement, ID reply, wrong
  D order, extra records or bad CRC is refused by the standard parser.
- Return `wrapper` and nested `exchange` plus top-level ok/disposition mirroring
  exchange, all false qualification flags and `bindings_verified:false`.
  Wrapper failure returns wrapper diagnosis without invoking the protocol parser.
  After structural binding validation retain a detached `bindings` array in bridge output,
  including on a slot-set mismatch,
  so the report preserves caller hypotheses including measurement-command suffixes.
  Mapping failures return bounded invalid errors with no exchange/values.
  A caller can intentionally lie about configuration/bindings; no success is an
  authorization or an acquisition-identity guarantee.

Test-first cases: vendor PDTA bytes above decode slot1 length13, `0+1.08+24.6\r\n`,
battery3204; independent literal F1/F2 synthetic exchange; marker/length embedded
in reply preserved; DEL CRC bytes; zero length; full slot15; duplicate slots;
truncated lengths, unknown markers including F0, junk tail; exact 255-byte frame;
unknown keys/types/holes/nonfinite input; PAYVER 1/2/5 with both DATAUP layouts;
mismatch/unsupported EXT/cut/conversion/allmode; short/invalid segment headers; fragment
body starts mid-record and is never parsed; model battery boundaries/EXTI bit,
budget equal/one over, literal expected bytes independent of roundtrip; bridge
complete/incomplete/abort/CRC invalid, missing/extra/duplicate binding, wrong
command order, missing announcement, no CRLF repair, flags false throughout.
Shuffle bindings input order and verify wire order still controls the exchange.

- [x] Write the direct contract tests; run `node --test scripts/test-sdi12-converter-lab.js`
  and record RED before helper implementation.
- [x] Implement the three functions; run the suite to GREEN and report evidence.
- [x] Freeze owned files for independent review. Do not commit or spawn agents.

## Task 2: CLI, documented examples and source decisions

Root creates `scripts/preview-sdi12-converter.js`, `.test.js`,
`scripts/fixtures/device-integration/sdi12/converter-examples.json` and
`docs/devices/sdi12-converter-preview.md`. CLI follows the existing exchange CLI:
--list, --example NAME, or regular JSON file through readBoundedJsonFile. Input
is exactly `{operation:'frame'|'model'|'exchange',input:{...}}`. JSON stdout only;
exit0 for ok:true, else1; same constant false flags, bounded errors.

Examples: PDTA vendor-derived bytes (remove log address/date/time/length18 and
join its two printed lines; not an installed uplink), synthetic wrapped CRC
exchange, incomplete and aborted exchange, PAYVER5 single frame, PAYVER1 fragment
split at a marker, wrong-length refusal, model budget success/failure. Label
every fixture, source and transformation; no omitted CRLF inserted into vendor data.

- [x] Write CLI tests before implementation, watch RED. Test all examples against
  pinned expected fields (not only ok), file mode outside CWD, input refusal and
  qualification flags. Include shipped-codec comparison demonstrating DEL loss
  and fragment marker loss; do not change the codec to make a comparison pass.
- [x] Implement CLI/examples and run CLI plus engine tests to GREEN.
- [x] Add both suites to the existing offline SDI-12 CI step. Link guide from
  protocol preview and readiness programme. Document exact assumptions, source
  gaps, supported model, PAYVER/DATAUP matrix and next bench capture procedure.

## Task 3: Independent review and verification

Astra reviews this plan before execution and final code/spec compliance. Sol runs
the exact updated offline SDI-12 CI command independently plus external-CWD CLI
and malformed/boundary probes. Run verify-sdi12-codec and verify-codec-robustness
for the comparison's shipped dependency; no full sync gate is required without
runtime/sync changes. Review fixes get scoped re-review. Lint changed prose,
documentation hygiene and staged whitespace; record results in a permanent
execution report, then commit only this slice locally. No publishing.
