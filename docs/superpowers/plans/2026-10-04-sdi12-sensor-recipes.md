# Offline SDI-12 sensor recipe previews

Continue package 3 of the [readiness programme](../specs/2026-10-04-sdi12-prebench-readiness.md)
against base `3dbb19e5f` in the existing isolated worktree. Produce logical probe
commands and test supplied exchanges through the protocol/converter helpers.
This is an offline preparation contract; no fixed Dragino recipe is established.

## Sources and decisions

- PR2 manual v4.1 pp.49–52: M3/C3 and CRC forms, four/six values, XRM3Sx readback
  commands. Use actual standard announcements; do not reproduce its malformed C
  example. Every position requires calibration qualification; no XRM parser exists.
- TEROS guide18224-12 pp.7–8: M/MC, two/three values. Refuse C/CC in this slice
  because the guide describes nonstandard concurrent behavior. The source is
  scoped to firmware3.00+, not an assertion about an installed device. No fixed
  announcement wait or worst-case startup delay is established.
- Tensiomark May2014 §§5.1.5,6,7: M, two values, variant1, minimum900 seconds
  between starts. MC/C/CC unavailable. Printed0082 is not a valid wire frame.
  Raw replies remain unbound to pF/temperature positions. No power-window guarantee.
- Sources are linked in the [audit reconciliation](../../devices/sdi12-protocol-audit/RECONCILIATION.md).
  Supply domains: PR2 7.2..16V, TEROS4..15V, Tensiomark7..14V. These are electrical
  input checks, not proof that the converter can supply the load.

Do not modify runtime payloads, candidate interpretations, Sentek recipes, flows,
schema, deployment, or live systems. No manufacturer messages. Output must retain
`hardware_verified:false`, `acquisition_available:false`, `eligible:false`,
`configuration_verified:false`, `recipe_deployable:false` on every path.
No address-changing/calibration writes, converter AT/downlink output, numeric
channel normalization or assertions of installed firmware compatibility.

## Task 1: Pure logical plan and transcript simulation

Terra owns `scripts/lib/sdi12-sensor-recipes.js` and
`scripts/test-sdi12-sensor-recipes.js`. Export `previewRecipe(input)` only. Use
existing resolveConfiguration from `osi-sdi12-normalize/configuration.js`,
inspectExchange/calculateCapacity from the protocol lab, and
modelSingleUplink/inspectWrappedExchange from the converter lab. No mutation or
I/O. Resolve modules relative to __dirname. No subagents or worker commits.

Exact input:

```json
{
  "configuration": {"version":1,"profile_id":"METER_TEROS_11","profile_version":2,"address":"1","settings":{"calibration":"mineral"},"depths":[30]},
  "command_family":"M", "supply_v":12, "power_mode":"switched",
  "interval_seconds":1200,
  "converter":{"battery_mv":3300,"interrupt":false,"payver":1,"max_slots":8,"max_payload_bytes":51},
  "exchange":null
}
```

Every object here except exchange follows exact keys. Delegate configuration
validation to existing resolver (no duplicate interpretation registry); preserve
its refusal codes. This includes HydraScout and unsupported Tensiomark variants.
All arrays reject holes via existing resolver. Other input domains: command_family
exact M/MC/C/CC; finite numeric supply_v within model source domain; power_mode
continuous/switched; integer interval_seconds1..86400 (software bound);
converter exact keys as above, battery_mv integer0..32767, interrupt boolean,
payver integer0..255, max_slots integer1..15, max_payload_bytes integer3..255.
max_slots is hypothetical retention capacity supplied by the caller, not verified
installed firmware support or a candidate converter slot configuration.
No strings-as-numbers or unknown properties. Return bounded invalid code on bad
JSON-compatible input without throwing. Missing exchange is invalid, null means
plan-only; otherwise pass its exact shape to inspectExchange.

Sensor-specific rules:

| Profile | Allowed families | Suffix | Required values | Discovery/readback commands |
|---|---|---|---|---|
| DELTAT_PR2_4 | M,MC,C,CC | 3 | resolver count4 | aI!, aXRM3S1!..aXRM3S4! |
| DELTAT_PR2_6 | M,MC,C,CC | 3 | resolver count6 | aI!, aXRM3S1!..aXRM3S6! |
| METER_TEROS_11 | M,MC | none | resolver count2 | aI! |
| METER_TEROS_12 | M,MC | none | resolver count3 | aI! |
| TENSIOMARK variant1 | M | none | resolver count2 | aI! |

Require Tensiomark interval>=900, refuse code `measurement_interval_too_short`.
Refuse TEROS address0 with switched power (`startup_string_requires_handling`);
continuous address0 can be planned but still lists initial startup handling as
unresolved. Unsupported command families: `unsupported_sensor_command`.
Out-of-domain supply: `unsupported_supply_voltage`.

Plan success: ok:true, disposition:'planned', `recipe` and five false flags.
Recipe contains:

- `version:1`, detached canonical `configuration`, `expected_values` from resolver,
  `command_family`, `supply_v`, `power_mode`, `interval_seconds`, detached converter.
- `discovery`: objects `{purpose,command,bytes}`; address remains case-sensitive,
  bytes are exact ASCII command bytes including !, no CRLF. Mark purpose identify
  or calibration_readback. Discovery is separate from periodic slot budgeting.
- `measurement`: `{command,bytes}`; explicit family plus sensor suffix.
- `retrieval`: `{policy:'until_announced_count',wait:'announced_seconds',
  commands:[aD0!..aD9!],stop_on_empty:true,max_successful_data_blocks:n}`.
  These are adaptive alternatives, never a fixed schedule of all10 commands.
  Wait for full announced seconds; early service-request scheduling is not modelled.
- `reference`: `{url,locator,scope}` source/version; no firmware input or identity
  parser. `unresolved`: sensor-specific codes plus shared converter_application,
  whole_reply_preservation, acquisition_freshness, startup_power_timing. PR2 adds
  calibration_readback_and_units and installed_model_depth_count; TEROS adds
  firmware_applicability and raw_equation_mapping (TEROS12 adds ec_units);
  Tensiomark adds installed_variant, response_order and sensor_error_contract.
- `fixed_converter_recipe:null`, `power_window_ms:null`. No generated AT/downlinks.
- `capacity` uses calculateCapacity at hypothetical signed-token width9, family
  M or C, count n, CRC from family. Name this assumption explicitly. Return
  `packed_data_blocks`, `max_successful_data_blocks:n`, `packed_slots:1+packed`,
  `max_slots:1+n`, `packed_payload_bytes`, `max_payload_bytes`, and booleans
  `packed_payload_fits`, `max_payload_fits`, `max_slots_fit` against input budgets.
  Include `actual_layout_known:false`, `regional_budget_verified:false`.
  Announcement length L=7 for M/MC,8 for C/CC including address/CRLF.
  Packed payload =3+2+L+packed.packed_wire_bytes+2*packed.packed_blocks.
  Maximum successful payload =3+2+L+n*(2+3+9+(crc?3:0)). This assumes one positive
  value-bearing reply per D block at most n, with no retries/service requests.
  These are legal-width bounds under the wrapper model, not predictions or proof
  that firmware can retain the announcement. A budget shortfall here is diagnostic;
  narrow actual tokens/grouping may fit, so do not refuse a plan on these estimates.

With supplied exchange:

1. Build the same recipe first; require exchange.command===measurement.command,
   otherwise invalid `recipe_command_mismatch`. Call inspectExchange unchanged.
2. Retain result as `simulation.protocol`. If it reports announced_count and that
   differs from required n, refuse `profile_count_mismatch`. Zero counts also fail
   the profile contract: outer code profile_count_mismatch, original no_values
   retained inside simulation.protocol. Never repair/massage an announcement. If announced wait
   exceeds requested interval, refuse `interval_below_announced_wait` (necessary,
   not sufficient scheduling check; no startup/retrieval duration is known).
3. For invalid/incomplete/aborted protocol result, return ok:false, its disposition
   and code, recipe and simulation; no converter payload. Even partial raw values
   are diagnostic, never normalized channels. No proof of elapsed timing.
4. For complete protocol result, create one hypothetical return slot per response,
   beginning with the announcement at slot1, followed by actual D replies. Preserve
   raw response strings exactly as bytes, including DEL. Retain bindings with the
   explicit command for each. If count exceeds caller max_slots, refuse
   `command_slot_budget_exceeded`, retaining protocol and required_slots.
5. Call modelSingleUplink using explicit battery/interrupt/PAYVER and max payload.
   Retain result as simulation.payload. On refusal propagate code and invalid
   disposition with recipe/protocol evidence; never truncate or auto-segment.
6. On model success pass bytes through inspectWrappedExchange with explicit
   DATAUP0/PAYVER, ALLDATAMOD1, DATACUT/DATACONV none, EXT[0,0,0] and bindings.
   Retain simulation.roundtrip; success is ok:true, disposition:'simulated'.
   If roundtrip fails return its code or `model_roundtrip_failed`; no success claim.
   Mark simulation.evidence='modelled_from_supplied_exchange',
   simulation.timing_verified=false. Never report sensor channels or validate units
   merely because the vector fits. Tensiomark positions remain unbound.

Test-first meaningful coverage: exact case-sensitive commands/bytes for all five
profiles; all PR2 readbacks including correct four/six boundary; unsupported
Hydra/variants/settings/families; supply endpoints and outside each; Tensi899/900;
TEROS switched/continuous address0; unknown/null/array/sparse/nonfinite inputs;
literal independently calculated M/C/CRC capacity budgets and narrow transcripts
fitting despite hypothetical width9 overflow; slot exactfit and one under; payload
exactfit and one under; PR2four vs six count mismatch, default M vs M3 mismatch;
incomplete/abort/no-values/malformed CRC/count/order; protocol preserves DEL;
observed wait vs requested interval; no repair of Tensi0082; direct protocol vs
model roundtrip numbers/tokens match, no mutation, all flags false on every path.

- [x] Write direct tests and observe RED before implementation.
- [x] Implement minimal helper and observe GREEN; report actual commands/results.
- [x] Freeze owned files for independent review; no runtime modifications/commits.

## Task 2: CLI and reusable synthetic corpus

Root owns `scripts/preview-sdi12-recipe.js`, `.test.js`,
`scripts/fixtures/device-integration/sdi12/recipe-examples.json`,
`docs/devices/sdi12-recipe-preview.md` and CI/docs links. CLI matches converter
preview: --list, --example NAME, or bounded regular JSON file. File directly
contains previewRecipe input (no operation wrapper). JSON only, exit0 iff oktrue,
same false flags on usage/read errors. No IO beyond local input/fixture reads.

Fixtures at least: PR2four plan/readbacks, PR2six multi-D simulation, PR2C3
simulation, TEROS11 MC simulation, TEROS12 M simulation, Tensiomark raw simulation,
Tensi899 refusal, malformed0082 refusal, payloadbudget failure, Hydrablocked.
All measurement transcripts are synthetic; attach primary-source URL/section,
explicit transformations and pinned expected outcomes. Do not label source-derived
synthetic announcements as vendor captures or imply field ordering is validated.

- [x] CLI tests before implementation; show RED, then implement/run GREEN.
- [x] Test every example with pinned outcomes/bytes/readbacks/false flags, file
  mode outside CWD, malformed/oversize/nonregular input and unknown usage.
- [x] Add helper/CLI suites to existing offline SDI-12 CI step; link new guide
  from profile/converter preview and readiness. Explain partial scope and bench
  evidence needed before fixed converter recipes/normalization/activation.

## Task 3: Independent review and verification

Astra reviews plan before implementation, then fresh Astra reviews final slice.
Sol independently runs exact updated offline CI and adversarial sample/budget
probes. Fix material findings with test-first regressions and scoped re-review.
No runtime changes, so full sync is outside scope. Lint changed prose, documentation
hygiene and staged whitespace. Record source limits and verification in permanent
execution report. Commit only reviewed slice locally, preserving branch/worktree.
