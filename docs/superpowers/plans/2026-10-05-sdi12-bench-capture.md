# SDI-12 bench capture package implementation plan

> Execute with Superpowers subagent-driven development, TDD and independent review.

Goal: turn the existing offline previews into a repeatable capture/replay procedure
for the approved prebench programme, without qualifying or activating hardware.
Base: `f5ac5bf31`, existing isolated `sdi12-profile-foundation` worktree.
Spec: [readiness programme, package 5](../specs/2026-10-04-sdi12-prebench-readiness.md).
This delivers capture preparation and replay; stored-row/UI evidence remains a
later integration boundary. User approved continued preparation and delegation.

## Design and constraints

Add a local JSON capture record and a pure checker that composes previewRecipe
and inspectWrappedExchange. Generate an incomplete capture template from an
explicit existing recipe input. Keep byte arrays for discovery replies, raw
framed strings for the protocol exchange and original radio bytes. No serial
connection, command execution, configuration writes, files followed from input,
network access, deployment, normalization or persistence. Existing runtime code
and profile mirrors stay untouched. No new dependency.

A record selects `scope:serial` or `scope:radio`. Serial checks a documented
measurement transcript with identity/readback evidence and elapsed-time records.
Radio adds an observed single uplink and explicit slot bindings, compares every
command/reply against the serial record and checks actual budgets. Equality is
necessary evidence, never proof that the two observations came from the same
acquisition. DATAUP=1 stays diagnostic; do not concatenate fragments.

All public helper/CLI envelopes carry these five flags as false: hardware_verified,
configuration_verified, acquisition_available, eligible, recipe_deployable.
Successful validation means `disposition:consistent`, not sensor qualification.
Metadata and timestamps are operator assertions, not authenticated evidence.
Synthetic fixtures must remain labelled synthetic.
Nested results retain their existing flag subsets without recursive rewriting.

## Exact record contract

Export `createCaptureTemplate(recipeInput)` and `inspectCapture(record)` from
`scripts/lib/sdi12-bench-capture.js`. The template input is the existing exact
previewRecipe shape with exchange:null; refuse non-null exchange as
`template_requires_plan`. Call previewRecipe, preserve its refusal code. On
success return `{ok:true,disposition:'template',capture,...flags}` with this exact
capture shape (all keys required, unknown keys refused):

```json
{
  "version": 1,
  "evidence": "bench",
  "scope": "serial",
  "capture_id": null,
  "captured_at": null,
  "setup": {
    "sensor_label": null,
    "converter_model": null,
    "converter_firmware": null,
    "converter_settings_text": null
  },
  "recipe_input": {},
  "discovery": [],
  "timing": {
    "measurement_started_ms": null,
    "announcement_received_ms": null,
    "data_requested_ms": [],
    "since_previous_start_ms": null,
    "power_on_ms": null
  },
  "radio": null
}
```

recipe_input is a detached copy of the exact successful input, not an empty
object. Discovery is populated in recipe discovery order with
`{command,response_bytes:null}` for every generated command. Response bytes are
kept verbatim, not parsed or accepted as identity/calibration. No invented
firmware, depth count, timings, settings or serial/radio readings in a template.

Scalar domains:

- version exactly1; evidence bench or synthetic; scope serial or radio.
- capture_id null or nonblank string <=128 chars; sensor_label/model/firmware null
  or nonblank strings <=256; settings text null or nonblank string <=32768.
- captured_at is the capture start, null or exact UTC ISO timestamp YYYY-MM-DDTHH:mm:ss.sssZ whose
  Date roundtrip matches. Reject impossible dates rather than normalizing them.
- timing exact keys above. Times null or safe integer0..86400000 (software bound,
  not a sensor guarantee). data_requested_ms dense array of at most10 such values.
- discovery dense array at most7, exact item keys, command string1..16 chars,
  response_bytes null or dense integer byte array length0..1024. Empty response
  is retained but does not satisfy evidence completeness.
- radio null or exact `{received_at,dev_eui,session_ref,fcnt_up,frame,bindings}`.
  received_at is a non-null valid UTC timestamp; dev_eui16 hexadecimal chars;
  session_ref null or nonblank string<=128; fcnt_up uint32. Null session_ref is
  missing evidence and prevents a consistent result while preserving the frame.
  Require frame and bindings
  keys but delegate their value validation entirely to inspectWrappedExchange,
  retaining malformed/unsupported values as diagnostics rather than failing outer
  metadata validation. No session identifier proves freshness. The bridge enforces
  its existing3..255 frame bound and exact binding grammar.

Reject structural violations as `{ok:false,disposition:'invalid',code:'invalid_capture',...flags}`;
never throw on JSON-compatible inputs. Do not echo malformed freeform input.
Deep-detach retained output from caller and do not mutate input.

## Inspection sequence and outputs

1. Validate outer/setup/timing/discovery/radio metadata shapes first. Retain a
   detached `capture` after structure validation, including malformed protocol
   response text or unsupported radio settings for diagnosis. Cap recipe/exchange
   through the existing preview helper rather than duplicating profile grammar.
2. Obtain the logical plan by previewRecipe with exchange:null. If refused,
   propagate its code/disposition with capture and `plan`. No custom HydraScout
   command map. Require exact discovery command count/order from that plan;
   otherwise `discovery_commands_mismatch`.
3. Run previewRecipe on actual recipe_input; retain as `preview`. Collect `missing`
   paths for capture_id, captured_at, sensor_label, absent/empty discovery responses,
   exchange:null, absent measurement/announcement timing, and missing/null D request
   times for every supplied block. data_requested_ms length must equal supplied
   blocks length when exchange is a structurally valid object with a blocks array;
   otherwise leave malformed exchange to preview. Nonempty times with exchange:null
   refuse `timing_blocks_mismatch`. Extra/missing array elements refuse that code;
   null entries at the correct length are incomplete evidence, not malformed.
4. Timing contradictions refuse even when other evidence is missing. If present:
   announcement_received_ms >= measurement_started_ms;
   power_on_ms <= measurement_started_ms; known D request times nondecreasing
   across null entries, and each >= known measurement start and announcement time.
   Obtain announcement timing separately via existing inspectExchange with the
   actual command/response and blocks:[], because malformed later replies can drop
   wait_seconds from the full preview result. When that announcement-only result
   supplies wait_seconds and announcement_received_ms is non-null, every known D time must also be
   >= announcement_received_ms + wait_seconds*1000 (conservative
   full announced wait after response). Fail `timing_order_invalid` or
   `announced_wait_not_observed`. For Tensiomark, known since_previous_start_ms
   below900000 refuses `measurement_interval_not_observed`, regardless of requested
   recipe interval. Null means unobserved; report it as an unresolved fact rather
   than claim the first recorded cycle proves prior history. No startup duration
   is accepted as sufficient, and no check proves elapsed physical time.
5. Radio scope requires converter model, firmware, settings text and radio object;
   append missing paths otherwise, including radio.session_ref when null.
   Serial scope requires radio:null, refusing
   `scope_radio_mismatch` on an attached frame. In radio scope call
   inspectWrappedExchange and retain `radio_check` even if preview fails. Delegate
   frame/binding/protocol refusal (`radio_not_complete`, retaining nested code).
   A valid wrapper's payload bytes and record count must fit recipe converter
   budgets (`radio_payload_budget_exceeded`, `radio_slot_budget_exceeded`). PAYVER
   must match recipe input (`radio_payver_mismatch`). Do not compare synthetic
   header battery/interrupt assumptions with observed battery/interrupt.
   Compare exact ordered commands and response bytes to serial measurement +
   ordered blocks; fail `radio_exchange_mismatch` on any difference, including CRC,
   CRLF, address, grouping or numerically equivalent formatting. Slot numbers may
   differ from the modelling assignments; explicit bindings supply their labels.
   Traverse radio_check.wrapper.records in wire order, resolve commands from
   bindings by slot and compare record.text directly to serial response strings.
   Do not normalize numbers or encode arbitrary serial text as ASCII/Latin-1.
   Compare only if the necessary serial command/response structure is available;
   otherwise retain the actual preview failure. Bridge refusal details can live
   in radio_check.exchange.code or radio_check.wrapper.code; preserve both.
   received_at earlier than captured_at refuses `radio_time_order_invalid`.
6. Return diagnostics in deterministic precedence: structural/plan/discovery
   errors first; timing errors next; radio errors next; failed actual preview next;
   missing evidence last. Preserve preview and radio_check when available. For
   exchange:null, return `incomplete/capture_incomplete`, not plan success. For
   failed preview return its code/disposition (including incomplete/aborted) rather
   than claiming consistency. Missing-only result is
   `{ok:false,disposition:'incomplete',code:'capture_incomplete',missing,...}`.
   Complete result is `{ok:true,disposition:'consistent',...}`.
   Every structurally valid inspected result includes `evidence` copied from input,
   `timing_verified:false`, `bindings_verified:false`,
   `qualification:'not_assessed'`, and `unresolved` containing plan unresolved
   codes plus `identity_and_readback_semantics`, `operator_metadata_unverified`,
   `cross_observation_freshness`, and `previous_start_unknown` when null.
   These fields may be omitted on early structural/plan errors. A successful
   synthetic record remains synthetic; a bench label never raises qualification.

## Review focus

- A perfect synthetic transcript must never become hardware proof.
- Different raw SDI replies with equal numeric values must fail radio comparison.
- Unknown timing stays unknown; a requested interval cannot mask a short observed
  Tensiomark interval or premature D read, including partial/aborted transcripts.
- A template with nulls, missing radio metadata, or empty discovery reply must
  never pass. Non-ASCII discovery bytes remain evidence without interpretation.
- Reordered/extra discovery, malformed arrays, DATAUP1 and unsupported converter
  transforms must remain bounded diagnostics, with original evidence retained.

## Tasks and ownership

### Task 1: Capture helper (Terra)

Own helper and `scripts/test-sdi12-bench-capture.js` only. Read existing preview
and converter/protocol helpers first. Use tests before implementation and report
RED/GREEN commands. Test every review focus plus template detachment, all five
profiles/readback counts, Hydra refusal, exact UTC validation, timing boundaries,
serial/radio scope, independent payload/slot limits, PAYVER mismatch, all false
flags, evidence labels, error precedence and raw CRC/DEL preservation. Use literal
constructed transcripts, not expectations generated from the helper under test.
Pin premature D plus malformed framing/CRC, D-before-start with missing
announcement time, descending known times separated by null, and malformed radio
frame/bindings versus malformed outer metadata as distinct regression cases.
Do not commit, spawn agents or edit root-owned files. Freeze when direct suite
passes; provide a short report in the current plan scratch directory.

- [x] Direct tests fail for missing helper.
- [x] Implement helper; tests pass with contract and boundaries covered.
- [x] Freeze helper/tests for independent review.

### Task 2: CLI, fixtures and bench guide (root)

Create `scripts/check-sdi12-capture.js` and `.test.js`. Reuse bounded regular-file
reader. Modes: `--template RECIPE_FILE`, `--list`, `--example NAME`, or CAPTURE_FILE.
Template returns the helper envelope; `.capture` is the editable record. JSON-only
stdout, exit0 iff oktrue, all false flags on input/usage failures. Local IO only.
Fixtures `scripts/fixtures/device-integration/sdi12/bench-captures.json`: at least
PR2four serial, PR2six radio split, TEROS11 CRC radio, TEROS12 serial, Tensi serial,
incomplete template, altered equal-number radio, early D request, too-short observed
Tensi interval, DATAUP1 diagnostic. All synthetic and independently pinned outcomes;
source links reference reconciled recipe examples; raw payloads literal.

Create `docs/devices/sdi12-bench-capture.md`: exact CLI preparation/replay steps,
recipe input reuse, sensor-specific discovery/measurement commands via existing
recipe generator, raw byte/CRLF/CRC preservation, monotonic clock recording,
stop conditions and procedure for cold start/normal/no-response/interrupted setup.
At least15minutes between Tensi starts; no asserted25–30s or250ms power guarantee.
PR2 readbacks remain unparsed, identity alone cannot prove4/6. No guessed Hydra
measurements; collect identity/vendor protocol by a separately validated procedure.
Do not print unverified converter AT commands or calibration/address writes.
Console settings snapshots must cover COMMAND/DATACUT/DATACONV/ALLDATAMOD/DATAUP/
PAYVER/EXT/NEWLINE using installed firmware documentation; store original local
logs separately and omit keys/tokens. The JSON checker does not authenticate logs.
Specify single-probe isolated bench setup, suitable documented supply and adapter,
no automated actuation, no replay into production, no candidate activation.
Captured failures are useful evidence even when checker exits1; never edit them to
make a check pass. Actual firmware unit/startup/order qualification remains human.
Include open decisions and the smallest experiment to resolve each, with current
source references. A later stored-row/UI capture remains outside this slice.
Link guide from recipe preview and readiness package5; add helper+CLI tests to
existing offline CI. Run prose lint, staged hygiene and whitespace.

- [x] CLI tests fail before CLI exists.
- [x] Implement CLI/corpus; examples and external-CWD/bounded-input checks pass.
- [x] Write bench guide and add CI/discovery links.

### Task 3: Independent review and verification

Astra adversarially reviews this plan before code. Fresh Astra reviews frozen final
helper/CLI/fixtures/guide and relations between them. Sol independently runs exact
updated offline CI and adversarial capture probes. Correct material findings with
regressions and scoped review. Root records all decisions, test evidence, limits
and reviewer findings in `2026-10-05-sdi12-bench-capture-execution.md`, commits this
slice locally and removes only this plan's scratch after durable evidence exists.
No broad runtime/sync checks are required without runtime changes.

- [x] Plan reviewed and material corrections applied before implementation.
- [x] Final review and independent verification pass.
- [x] Permanent evidence, scoped local commit, clean worktree.
