# Tensiomark pF and pressure output investigation

Investigated 2026-10-05 against implementation commit `6c83eabe7`. The public
record supports default pF and selectable mbar output for one documented
GeoPrecision implementation. It does not establish a firmware defect in kPa
conversion. The installed sensor's hardware and firmware remain unknown.

Our earlier pF-only conclusion was too broad. It described the
[ecoTech May 2014 manual](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf),
not every Tensiomark implementation. The investigation itself changed the evidence
record only. The subsequent
[pF preparation slice](../superpowers/plans/2026-10-05-tensiomark-pf-preparation.md)
implements explicit offline ordering and quarantines unqualified legacy inputs.
No descriptor has been qualified for hardware.

## New source and its limits

[GeoPrecision Tensiomark SDI12, revision 2.1, 25 July 2019](https://thermistor-string.com/downloads/legacy/sdi_tensiomark_2r1%20HOT.pdf)
documents pF as the factory default and bit 7 of Flag0 as the pF/mbar selector.
It provides no native kPa selector. Page 4 contains contradictory examples:
128 decimal is printed as binary `1000000`; decimal 28 is described as mbar
although its bit 7 is zero. Page 2's measurement example puts temperature before
tension. Its cached example changes the tension number while claiming unchanged
values. Root inspected both rendered pages.

The [download index](https://thermistor-string.com/downloads/legacy/) labels these
files for discontinued hardware and requires model/revision compatibility checks.
Document revision 2.1 is not a firmware identifier. Do not infer applicability to
an installed 4244/1 from the product name alone.

Retrieved PDF SHA-256:
`60205f5677108e70e6d5ed5a399afd143a23aae2528794b640bd873c7a4b992f`.
The former indexed download endpoint returned 404; the linked legacy file was
retrieved directly. Searches for Tensiomark unit-switch errors, firmware notices
and German error reports found no public confirmation of the reported defect.
This is a search limit, not proof that no defect exists.

## What could explain wrong pressure values

Binary arithmetic establishes a documentation error independently of any sensor:
128 is `10000000`; `1000000` is 64; `28 & 128` is zero. Following inconsistent
examples could leave the receiver expecting a different unit from the sensor.
This is a plausible cause of the report, not evidence that a particular firmware
implements the flag table correctly. A whole-flag write also risks changing
unrelated settings; none is prescribed here.

The pressure conversion itself is simple: 1 mbar = 1 hPa = 0.1 kPa. For the
log-hPa convention used by OSI, positive suction is `10 ** pF / 10` kPa. The
[Stevens pF Sensor manual, p. 5](https://www.stevenswater.com/resources/documentation/discontinued/stevens_pf_sensor_manual.pdf)
documents this convention and distinguishes positive suction from negative matric
potential. That is a different product manual, not evidence for Tensiomark commands.
Classical pF uses centimetres of water; the applicable conversion convention must
be pinned before interpreting a small scale difference as a defect.

| Constructed example | Correct result under the log-hPa convention |
|---|---|
| pF 2 | 10 kPa |
| pF 3 | 100 kPa |
| pF 4 | 1,000 kPa |
| 300 mbar | 30 kPa |

A tenfold discrepancy suggests hPa/kPa confusion. A ceiling at exactly 300 kPa
suggests clipping in our code. Large errors tied to temperature suggest swapped
fields. Failures that appear only when numbers gain digits suggest a converter
cut or numeric-width problem. These are diagnostic hypotheses, not observations
from the user's sensors. Never infer units from magnitude: valid ranges overlap.

## Reproduced OSI behavior at the investigation baseline

The active [legacy normalizer](../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.js)
assumes tension first in pF and temperature second. It caps every SWT value at
300 kPa after conversion. Five direct calls to `normalize()` reproduced:

| Input after framing removal | Current output | Interpretation |
|---|---|---|
| `+2.48+21.5` | 30.2 kPa, 21.5 °C | Baseline for the assumed order |
| `+4+21.5` | 300 kPa, 21.5 °C | Loses a valid 1,000 kPa magnitude |
| `+300+21.5` | 300 kPa, 21.5 °C | If input is hPa, correct pressure would be 30 kPa |
| `+21.93+4.551` | 300 kPa, 4.55 °C | Misinterprets the newer manual's field order |
| `-9.88+21.5` | 0 kPa, 21.5 °C | Constructed negative-value case passes as wet soil |

The last row isolates the assumed tension slot; it is not a captured sensor error
frame. All five calls produced no quarantine marker. The module's existing test
explicitly expects the 300 kPa ceiling, so a green legacy suite does not establish
physical correctness.

The offline [versioned candidate](../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/configuration.js)
removes that ceiling and rejects negative pF, but still assumes tension first.
It remains unsuitable for the new manual's layout without a separate reviewed
interpretation. The raw recipe/capture tools leave numeric positions unbound.
The [GUI SWT helper](../../web/react-gui/src/utils/swt.ts) separately excludes
values above 300 kPa; integration must address that consumer too. The GUI unit
preference changes presentation and does not write the probe's output mode.

## Preparation and subsequent field integration

The user selected pF acquisition with one explicit edge conversion. The preparation
slice now requires explicit order in candidate version 3, rejects pressure-unit
inputs and retains the full converted range. Its tests cover field order and
error rejection. Without an explicit live layout, Tensiomark ingestion retains
decoded replies for diagnosis and emits battery only. The card displays the wider
range; zone summaries and irrigation rules retain their existing limits. The
preparation slice did not activate hardware.

The subsequent [field integration](../superpowers/specs/2026-10-15-tensiomark-field-integration.md)
supports one or two explicitly identified probes with bench-observed
temperature-then-pF replies. The edge converts pF once, rounds canonical kPa and
temperature to two decimals, and atomically retains original payloads, addressed
text and configuration snapshots alongside accepted or rejected observations.
The saved calibration range remains unverified. See the
[live-path requirements](dragino-sdi12.md#ecotech-tensiomark) before configuring a
different sensor revision; a declared order is not installed-device evidence.

At the bench, identify the hardware first and record the complete identification
reply, converter configuration and supply behavior. If this manual applies, read
Flag0 using `aXF!` or `aXF0!` before any setting change. Capture complete SDI-12
replies directly and through the converter so framing failures can be separated
from sensor values. Keep the existing conservative 15-minute measurement spacing
until the installed revision's heating/freshness behavior is established.

A later controlled pF/pressure/pF comparison should record flag readback and fresh
acquisitions after each transition, with stable conditions and temperature logged.
Different acquisitions cannot establish conversion accuracy by exact equality.
Compare expected pressure using the applicable pF convention and output precision;
check return-to-pF repeatability. A raw pressure mismatch that survives direct
capture, verified settings, correct field order and stable conditions would justify
a firmware-specific manufacturer question. No manufacturer has been contacted.
