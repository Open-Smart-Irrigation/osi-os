# WATERMARK field qualification

Date: 2026-09-30 · Status: recording runbook; scheduler admission disabled

## Purpose

Use this runbook to create a repeatable field record for a WATERMARK 200SS
installation on an LSN50. It supplements the bench protocol. It does not enable
irrigation scheduling, and a completed record is not an admission token.

Phase 2 may improve this process without blocking cloud parity. A later Phase 3
design must define the independent-reference limits, sampling policy, admission
resource, and explicit acceptance workflow before WATERMARK can drive the
scheduler.

## Safety boundary

- Keep the device unable to reach irrigation control throughout qualification.
- Do not store radio keys, passwords, tokens, database copies, customer names,
  network addresses, or workstation paths in the record.
- Identify evidence with stable record IDs, UTC timestamps, software and
  firmware versions, and SHA-256 hashes.
- Treat board temperature as a board diagnostic. It is not soil or ambient
  temperature. If firmware marks it invalid, record it as unavailable.
- Do not smooth, interpolate, or replace an individual sample to make it pass.

## When a record is required

Create a record before claiming an installation is qualified. Repeat the
affected qualification after any of these changes:

- any of the eight pull or series calibration coefficients changes;
- board, circuit revision, probe, channel, polarity, grounding, connector, or
  cable type or length changes;
- probe depth, placement, soil contact, or temperature-sensor arrangement
  changes;
- firmware conversion logic or `conversion_version` changes;
- observed temperature, VDDA, resistance, kPa, salinity, or EC falls outside
  the accepted envelope;
- unexplained offset, cross-channel influence, reference disagreement, stale
  data, or repeated channel failure appears.

Changing calibration notes, method text, or other metadata without changing an
electrical coefficient does not itself revoke qualification. A material
coefficient change does: it requires fresh evidence and explicit human
reacceptance. Saving the new values is not acceptance.

A metadata-only edit can still bump the calibration resource's `sync_version`.
Because a future admission must bind exact versions, Phase 3 must preserve a
separate coefficient identity or equivalent proof that distinguishes an
unchanged coefficient set from a material recalibration. It must not revoke or
silently reaccept qualification from the version number alone.

## Record header

Record these facts before installation:

| Field | Required evidence |
|---|---|
| Record identity | stable record ID, revision, UTC creation time, operator role |
| Hardware | durable board label, circuit revision, probe IDs, channel mapping, connector and cable specification |
| Software | edge release, firmware commit and image hash, conversion version |
| Calibration | calibration sync version, eight coefficients, source record ID and hash, measurement method and residual |
| Location | non-identifying field reference, installation layout, probe depths and separation |
| Medium | soil description, texture if known, amendments, stones or voids near probes |
| Temperature | sensor ID and depth for each probe, or the planned comparison proving a shared sensor is representative |
| Reference | independent tension-reference make/class, calibration status, range, resolution, uncertainty, and method |
| Electrical envelope | planned VDDA, board-temperature, cable, grounding, channel, and polarity conditions |
| Agronomic context | observed salinity or EC method and value when available; do not invent a compensation rule |

## Installation and conditioning

1. Record the probe conditioning and rewetting procedure. If the probes were
   dry, condition them according to their approved installation procedure
   before judging field response.
2. Install each probe at its recorded depth with full soil contact. Record the
   hole preparation, slurry or packing method, orientation, separation, and any
   disturbed soil.
3. Route and secure the actual field cable. Record its type, total length,
   joints, shielding, ground connection, and proximity to power or switching
   conductors.
4. Record the node ground state during capture. A grounded console or temporary
   supply is a different electrical condition and cannot stand in for normal
   battery operation.
5. Place a temperature sensor at each probe depth. If one DS18B20 is proposed
   for two depths, compare both depths over the claimed temperature range and
   declare the maximum allowed difference before collecting acceptance data.

## Electrical checks

Use the installed cable and normal power arrangement.

- Verify the resistor-fit evidence for both channels and both excitation
  polarities across the claimed resistance range.
- Exercise one channel at a time and both together. Record any change caused by
  the other channel, including disconnected, wet, and dry/open conditions.
- Repeat enough points across observed VDDA and board-temperature conditions to
  state the tested range. Lack of coverage is recorded as a limit, not assumed
  stability.
- Record open, short, unsettled, clipping, invalid-temperature, and invalid
  board-temperature behavior. A diagnostic status must not be replaced with a
  plausible numeric value.

The calibration-fit wizard, if available later, may capture this evidence. A
complete manual resistor record remains equivalent; the wizard is not required
for Phase 2.

## Independent-reference comparison

The reference must be independent of the LSN50 codes, the same calibration
coefficients, and the dry-down interpolation used to judge self-consistency.

1. Declare the reference range, uncertainty, pairing window, required sample
   count, and pass tolerance before capture. A future Phase 3 design must approve
   these values; until then the result is `qualification_pending`.
2. Pair each reference observation with one named WATERMARK channel at the same
   depth and a recorded time. Preserve unmatched and out-of-range observations.
3. Cover wetting, drainage, dry-down, and rewetting across the claimed kPa
   range. Record placement differences that could create real soil gradients.
4. Compare pointwise readings. Trends and smoothed curves may be shown as
   diagnostics but cannot replace a failed or missing pair.
5. Record salinity or EC observations with the comparison. Do not apply an
   unvalidated salinity correction.

## Applicability envelope

The qualification record gets an immutable envelope version. State the tested:

- resistance and kPa range per channel;
- soil-temperature range and temperature-sensor arrangement;
- VDDA and board-temperature range;
- cable type and length, connectors, grounding, and power arrangement;
- channel, polarity, and cross-channel states;
- soil medium, placement, depth, conditioning, wetting, and rewetting method;
- salinity or EC observations and the reference method's range and uncertainty;
- firmware, conversion version, and calibration sync version.

A reading outside any relevant bound is outside the qualification. Display may
continue, but a future scheduler must treat that sample as ineligible. It must
not smooth neighbouring values into eligibility.

## Monitoring record

At installation, after the first wetting and drainage cycle, during a natural
dry-down, after rewetting, and after any requalification trigger, record:

- `lastSeen` for contact and `currentStateRecordedAt` for canonical measurement
  age, recorded separately;
- channel status, kPa, resistance, offset, soil temperature, VDDA, board
  temperature status/value, calibration version, and conversion version from
  the edge diagnostic view;
- independent-reference pairs and unmatched observations;
- placement, soil-contact, cable, connector, ground, salinity/EC, weather, and
  irrigation changes relevant to interpretation;
- missing uplinks, stale readings, abrupt channel disagreement, drift, open or
  short status, and the corrective action.

The long-term monitoring cadence and alert thresholds must be declared before
future scheduler admission. Until a Phase 3 policy fixes per-channel freshness,
minimum points, hysteresis, and re-arm behavior, scheduler admission remains
disabled.

## Verdict

Use one of these record outcomes:

- `observational`: useful evidence, but one or more required limits or checks
  are absent;
- `qualification_pending`: the record is complete under this runbook, but the
  approved Phase 3 limits or admission workflow do not yet exist;
- `rejected`: a declared electrical, temperature, reference, or field criterion
  failed;
- `qualified_for_review`: all predeclared checks passed and the evidence is
  ready for explicit human review under a future Phase 3 policy.

`qualified_for_review` is not scheduler admission. Only a future edge-owned
admission resource, bound to the exact calibration and envelope versions and
explicitly accepted by an authorized person, may lift the scheduler interlock.
