# SDI-12 external review follow-up

> For agentic workers: use executing-plans and test-driven-development inline;
> obtain independent review and fresh verification before completion.

Goal: correct the offline foundation's confirmed defects before designing live
revision transitions. Base: `40fc259ed`. Continue in its isolated worktree.
No gateway access, commands, flow changes, schema changes or cloud writes.

The external review is the input to this correction, checked against the code
and primary manuals. The [preparation design](../specs/2026-10-02-sdi12-sensor-expansion-preparation.md)
remains the broader scope; update its disputed sections in this follow-up.

## Decisions for this correction

- Candidate profile definitions advance to version 2. Version 1 is refused,
  rather than silently changing its interpretation. These APIs have not entered
  live ingestion; no persisted revision or historical row is migrated.
- Tensiomark accepts only explicit pF and variant `1` (4244/1). hPa and other
  variants return `protocol_evidence_required`. Different circulated editions
  disagree on variant 3's range; do not infer an installed variant. Validate
  pF 0..7 and temperature −40..80 °C, as the ecoTech technical table specifies.
- TEROS settings contain only `calibration: 'mineral'`. Firmware is not a
  user-selectable interpretation setting. Reject the former `firmware` field;
  future commissioning must retain identity readback and evaluate compatibility
  against the applicable guide. This correction does not establish compatibility.
- Return an `interpretation` descriptor containing profile ID/version, parser
  and rounding identifiers, source positions, manifest units, transforms,
  ranges, sentinels and failure policy. Evaluate measurements using those same
  rule objects. Hash the descriptor as `interpretation_hash`; include that hash
  with the canonical desired configuration in `configuration_hash`. Address and
  depths change the latter, not the former. Neither hash attests to device state.
- Pin every version-2 interpretation hash in regression tests. Keep these pins
  immutable; future rule changes require a new profile version and pin. Also
  retain conversion/boundary tests, because table pins cannot prove evaluator
  semantics by themselves.
- PR2 per-position range failures and TEROS VWC range failures retain other
  valid channels with `partial`. If no sensor channel survives, quarantine.
  Framing/count errors, non-finite values, every TEROS sentinel and other channel
  failures remain whole-vector failures. Inspect all positions before publishing
  anything: a later sentinel must override an earlier recoverable range failure.
  Never clamp invalid VWC into a plausible value. This is offline diagnostic
  behavior and does not establish that a received vector belongs to one cycle.
- CLI partial previews retain the sample and return exit 1 / `sample_partial`.
  Synthetic examples and acquisition-disabled flags remain explicit.
- Legacy descriptors truncate generic channels to the valid learned count and
  preserve finite zero/fractional depths accepted by the save route. Preserve
  Sentek's separately validated layout depths and all live normalizer behavior.

## Files and execution

Modify `configuration.js` and `configuration.test.js` under both
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/`
and its bcm2709 mirror. Modify `scripts/preview-sdi12-profile.js`, its test,
`scripts/fixtures/device-integration/sdi12/configuration-examples.json` and the
preview guide. Existing CI globs already run these suites. No new module file.

- [x] Add and run failing tests for legacy generic counts and fractional/zero
  depths; fix the adapter without editing `normalize()`.
- [x] Update candidate tests to version 2. Pin rejection of version 1, hPa,
  unspecified Tensiomark variant and firmware-as-setting. Test −40 and +80 °C
  inclusively and out-of-range temperatures, plus detachment of returned rules.
- [x] Add range-failure tests: TEROS RAW 1780 retains temperature/EC, PR2 `-7`
  at one depth retains other depths, all invalid PR2 depths quarantine, and a
  TEROS sentinel after low VWC overrides partial acceptance. Watch them fail.
- [x] Implement the bounded rule descriptor, hashes and evaluator. Pin the
  reviewed descriptor digests by profile/version; verify equal interpretation
  across address/depth edits and different full configuration hashes.
- [x] Update fixtures and test CLI partial results, including nonzero exit.
  Run the offline examples through the real codec.
- [x] Mirror source/tests, run the full helper/CLI command from CI, then device
  integration, registration, recipe schema/flow, codec, profile parity, manifest
  parity, helper registration and module-file deployment coverage.
- [x] Correct the preparation design and preview guide. Record accepted,
  qualified and deferred review advice with sources, particularly tag evidence,
  finite tag reuse, frame counters, presentation revisions and edge-local sync.
- [x] Obtain independent whole-diff review and verification, run prose lint and
  whitespace checks, record results, and commit locally.

## Review focus

Test that returning a rule object cannot mutate subsequent normalization. Check
mixed failures in both field orders, old profile-version refusal, generic counts
1..8 and invalid learned counts, Sentek depths outside the generic save range,
and no-response samples with invalid settings. A positive preview remains
insufficient evidence for live activation.

## Evidence sources

The [ecoTech manual, May 2014, §§5.1.5 and 7](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf)
documents pF output; page 18 was rendered and visually checked for the temperature
range. Variant 1 covers pF 0..7. The 8 s SDI-12 reply time does not include the
listed 15–20 s warm-up requirement; do not reuse Sentek's 8 s power recipe.

The [METER integrator guide, revision 12](https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf)
documents the three error values; their independent per-field semantics are not
established. Keep all three fatal to the vector. Firmware belongs to identity
evidence and future commissioning eligibility, outside desired settings.

Verification and review results are recorded in the
[execution report](2026-10-03-sdi12-external-review-execution-report.md).
