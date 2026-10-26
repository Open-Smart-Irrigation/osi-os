# SDI-12 sensor protocol audit

Date: 2026-10-04. Scope: Delta-T PR2/4 and PR2/6, METER TEROS 11 and 12, ecoTech
Tensiomark, HSTI HydraScout. Documents only. No sensor, converter or gateway was
contacted, and no manufacturer was asked anything.

PR2 and TEROS can go to offline framing and conditional recipe planning now.
Tensiomark variant 1 can go to timing/budget experiments with response positions
unbound. HydraScout stays blocked: the reviewed sources provide no applicable
command reference. The [intake reconciliation](RECONCILIATION.md) qualifies the
research recommendations below; it does not certify every source transcription.

## Files

| File | Content |
|---|---|
| `pr2.evidence.json` | 71 claims, 9 transcripts, 15 unknowns |
| `teros.evidence.json` | 25 claims, 4 transcripts, 10 unknowns; six guide editions and the Dragino example |
| `tensiomark.evidence.json` | 18 claims, 1 transcript, 8 unknowns |
| `hydrascout.evidence.json` | 25 claims, 1 transcript, 12 unknowns |
| `calculations.json` | Independent arithmetic: conversions, boundaries, D-block counts |

Each claim records model, firmware, source, locator, a short quote, the derived
rule, a test where one exists, a confidence and its limitation. The `category`
field separates `vendor_specification`, `vendor_example`, `third_party_example`
and `derived_expectation`. `calculations.json` holds arithmetic only. None of
these files contains a capture from our hardware, and none contains an invented
reply.

Sources carry reported hashes and retrieval dates; some hash fields contain only
prefixes or explanatory text and cannot be used as SHA-256 integrity checks.
The research agents report that PDFs were downloaded on 2026-10-03
and 2026-10-04. Tables and equations were read from rendered page images, because
text extraction drops minus signs and misaligns table cells.

## Five findings that save bench time

1. **No generally safe fixed cut is established for these variable-width replies.** The PR2 manual prints no data
   reply, so value width is unknown. TEROS widths differ between sources: the
   guide's examples have one decimal (`1797.7`), Dragino's firmware-1.12 example
   has two (`+1828.88`), and EC runs from one to five digits. Dragino's own
   TEROS recipe uses `AT+DATACUT2=18,2,1~18`, which fits only an 18-byte reply.
   Recommendation: forward the whole reply with address and CR/LF, and frame it
   on the edge. See "Reply framing" below.
2. **PR2 units can only be established by readback.** `aM3!` is mineral percent
   by default, but the manual's own ranges for redefinable measurements disagree
   (1–6, 2–6, 1–9), and one sentence implies `M1`/`M3` follow per-position
   overrides. Read `aXRM3S1!` to `aXRM3S6!` before trusting a percent vector.
3. **PR2/6 under `aM3!` needs at least two blocks at six characters per value.**
   Six values fit one block only at five characters each (`+12.3`). The
   concurrent form `aC3!` has capacity for one block at any legal width, but
   neither command guarantees tightly packed replies. Retrieve by announced count.
4. **Tensiomark requires at least 15 minutes between measurement starts.**
   Its supply range is 7–14 V; 12 V is recommended. A 25–30 s power window is
   a derived trial proposal, not a validated SDI-12 timing requirement. Read the part label
   (4244/1, /2 or /3) before the session; the candidate covers variant 1 only.
5. **The deployed HydraScout interleave has no support in the reviewed sources.**
   HSTI's 2016 and 2017 product pages list measurement 0 as moisture percent,
   1 as temperature and 2 as raw frequency in MHz. No conductivity appears. Take
   a console transcript of `aI!`, `aM!`, `aM1!` and `aM2!` before anything else.

## Reply framing: the decision that cuts across sensors

| Option | Assumes | Defeated by |
|---|---|---|
| Fixed `DATACUT` per slot (current Sentek pattern) | Reply length never changes | TEROS EC going from `+0` to `+660`; a PR2 value gaining a digit; a negative temperature |
| Forward the whole reply, parse on the edge | Converter passes `a<values><CR><LF>` unmodified; edge knows the address | A converter firmware that truncates or pads at the declared length; replies longer than the uplink budget |
| Forward with CRC (`aMC!`, `aCC!`) and verify on the edge | Probe implements CRC forms; converter passes the three CRC characters | Probe without CRC support. PR2 documents it; Tensiomark and HydraScout do not |

Recommendation: the second option, with CRC where the probe documents it. The
Dragino TEROS example already uplinks unstripped replies, so the form is shown by
the vendor for that firmware. Edge framing also checks the reply's address
against the configured one, which a stripped payload cannot do. How the converter
treats a reply shorter or longer than the declared cut length is not documented
and belongs to the transport lab.

The shipped decoder removes Dragino slot/length markers before producing
`data_sum`. A future whole-reply path must preserve and validate those wrappers
from raw bytes before checking SDI-12 frames. The protocol preview below starts
with command-labelled raw replies; it cannot restore lost command boundaries.

## Delta-T PR2/4 and PR2/6

Source: PR2 SDI-12 User Manual v4.1, May 2016 (manufacturer). No firmware version
is stated anywhere, and no newer edition was found.

| Topic | Documented | Locator |
|---|---|---|
| `aM!` / `aC!` | Permittivity | pp. 49–50 |
| `aM1!`, `aM2!` | Theta in m³/m³, mineral and organic | p. 50 |
| `aM3!`, `aM4!` | Percent, mineral and organic | p. 50 |
| `aM5!`, `aM6!` | Custom; default "same as M4"; no reply printed | p. 50 |
| `aM7!`–`aM9!` | mV, uncalibrated mV, raw ADC; auto-zero channel first, so n+1 values | pp. 40, 50 |
| CRC forms | `aMC!`, `aCC!` and numbered variants | p. 50 |
| Announced reply | `a0026` (PR2/6), `a0024` (PR2/4): two seconds, six or four values | pp. 49–50 |
| Data limits | 35 characters after M, 75 after C | p. 50 |
| Order | Position 1 is the top sensor | pp. 23, 27 |
| Identity | `a13Delta-T PR2SDI002…`; identical for /4 and /6 | pp. 21, 49 |
| Calibration | √ε = a0 + a1·θ; mineral 1.6 and 8.4, organic 1.3 and 7.7 | pp. 32–33 |
| Readback | `aXRMxSy!`, example reply `B M2 U=V,S6,a0=1.2 a1=8.2` | p. 52 |
| Power | 7.2–16 V, under 60 mA awake, one-second warm-up | pp. 16–17, 42 |
| Depths | PR2/4: 100/200/300/400 mm. PR2/6: product page only (10/20/30/40/60/100 cm) | p. 23 |

Not documented: any data reply with values, value width or decimals, error or
out-of-range output, clamping, the `n` for `M5`/`M6`, replies to write commands,
a sensor-count command.

Conflicts inside the manual:

- p. 27 says 76 characters and `D0`–`D8`; p. 50 says 35 and 75 and `D0`–`D9`.
- The identity string is printed with 33 characters on p. 49 and 34 on p. 21.
- The `aC!` reply is printed in the five-character form; SDI-12 requires
  `atttnn` for concurrent commands.
- p. 31, "the previous SDI-12 reading for that sensor will be reported", sits in
  a logger recording-rate paragraph. Whether the probe or the logger does this
  is not stated.

Derived (see `calculations.json`): mineral θ for air (ε = 1) is −0.0714, for
water (ε = 81) 0.881. With tight packing, six values after M need one block at
width 4–5 and two at width 6–9; four need one up to width 8. These are capacity
estimates. The standard permits smaller groups even when all values fit D0.

**Smallest defensible contract**

- Mode: mineral percent, declared, and confirmed by readback of all positions.
- Command candidates: `aM3!` or experimental `aC3!`, followed by D0 and further
  D commands through D9 as required by the announced count.

| Option | For | Against |
|---|---|---|
| `aC3!` + D retrieval | Capacity for one block at any legal width | Actual grouping and converter handling are unknown; printed announcement is nonstandard |
| `aM3!` + D retrieval | Sequential command family is already exercised by Sentek | Split point and number of blocks are unknown; an empty reply means aborted measurement |

Recommendation: preview both alternatives and capture grouping before compiling
fixed converter slots. One successful exchange cannot establish all reply widths.
Counterexample to preferring `aC3!` outright: a converter that sends `aD0!`
before the announced wait, which returns no data.

- Capability requirements: 12 V output, wait of at least three seconds
  (one-second warm-up plus the announced two), whole-reply forwarding, and
  segmentation when a PR2/6 reply exceeds one uplink. Worst case for six values
  is 54 value characters plus framing, above a 51-byte uplink.
- Refuse: any mode other than the declared one, a count other than four or six,
  `M7`–`M9` (extra leading channel), positions whose readback differs from the
  mineral defaults, an identity that is not `PR2SDI`.

## METER TEROS 11 and 12

Sources: integrator guide 18224-12 (June 2025, firmware 3.00 or newer); user
manual 18225-16; guide revisions 00, 02, 04 and 05 (firmware 1.00, 1.07, 1.07,
1.14); Dragino manual §2.6.4 example 4 (TEROS 12, firmware 1.12).

| Topic | Firmware 3.00+ (guide rev. 12) | Firmware 1.x |
|---|---|---|
| `aM!` + `aD0!` | `a+<calibratedCountsVWC>±<temperature>+<electricalConductivity>`; EC on TEROS 12 only | Same field order in rev. 00–05 |
| Announced reply | Not printed | `30013` in the Dragino example: one second, three values |
| First field | "Calibrated ADC counts", no range given | Dragino example: `+1818.98`, `+1828.88` |
| EC unit | µS/cm, normalised to 25 °C | Rev. 02 dS/m, rev. 03–05 "mS/cm", with the firmware column unchanged |
| Error codes | −9999, −9992, −9991 "in place of the measured value" | Absent before rev. 05 (firmware 1.14) |
| Identity | `…METER   TER11 …` or `TER12 `, three version digits | `313METER   TER12 112T12-00024895` |
| Concurrent command | Does not meet SDI-12 concurrent requirements | Not compared |
| Power-up | 245 ms typical; 145–165 ms with the startup string disabled | Maximum measurement 50 ms in rev. 00–03, 150 ms later |
| Supply | 4.0–15.0 V | — |

The raw field. The manual's Eq. 6 is θ = 3.879×10⁻⁴ × RAW − 0.6956, where RAW is
"the raw sensor output, when read with a METER or third-party data logger". No
sentence says RAW is `calibratedCountsVWC`. Two checks support it: the
verification-clip values 2650 and 2730 give 0.3323 and 0.3634 against the
printed 0.332 and 0.363, and Dragino's bench values 1818.98 and 1828.88 give
1.0 % and 1.4 %, plausible for a sensor in air. This is a strong inference for
both firmware lines, not a statement.

Boundaries (derived): θ = 0 at RAW 1793.25 and θ = 0.70 at RAW 3597.83. Eq. 8
reaches a permittivity of 80 at RAW 3393.6, where Eq. 6 gives 0.62, so the top
of the mineral range lies outside the documented permittivity range.

Error scope is not specified. "In place of the measured value" reads as
per-field, but the −9999 text says "subsequent measurement values have no
meaning". The current vector-fatal rule is the conservative reading.
Counterexample: a TEROS 12 with a failed EC measurement that reports −9999 in
EC only would lose its VWC and temperature for as long as the fault lasts.

The guide and the manual disagree on addressing: the guide recommends a nonzero
address so the startup string is omitted; the manual says ZENTRA loggers need
address 0. On a power-switched converter every cycle is a power-up, so address 0
puts the startup string on the bus each time.

Two printed checksum examples in the guide do not reproduce from its own code
(a case difference, and a value printed as 1797.2 that computes as 1797.7). The
candidate does not use those commands.

**Smallest defensible contract**

- Separate evidence by model and firmware line before defining descriptors.
  Preserve the raw identity version: the current 3.00+ guide still prints `114`
  in an example. Do not treat that example as a verified 3.x identity. The reviewed
  sources establish no sentinel contract for firmware 1.12 and do not settle
  1.x EC scaling across conflicting guide editions.
- Command: `aM!` then `aD0!`, nonzero address, wait of at least one second.
- Count: two for TEROS 11, three for TEROS 12, checked against the model string.
- Capability requirements: verified whole-reply forwarding and startup timing.
  A 250 ms delay is a trial setting based on typical power-up timing, not a
  documented worst-case bound.
- Refuse: address 0 on switched power, a model string other than `TER11`/`TER12`,
   unresolved firmware applicability, `aC!`, `aR3!`/`aR4!` (space-delimited).

## ecoTech Tensiomark

Source: manual, May 2014, ecoTech-authored and hosted by a distributor. No other
ecoTech edition was found. The "second circulated manual" mentioned in the review
decisions could not be confirmed.

| Topic | Documented | Locator |
|---|---|---|
| Commands | `aI!`, `aAb!`, `aM!`, `aM9!`, `aD0!`, `aR0!` | §5.1.5 |
| `aM!` | "measure pF value and temperature; answer: 0082" | §5.1.5 |
| `aM9!` | Supply voltage; answer `0011` | §5.1.5 |
| Output | pF, resolution 0.01; °C, resolution 0.1 | §7 |
| Variant 1 (4244/1) | pF 0–7.0; calibrated to about 6.59, extrapolated above | §§2.2, 3 |
| Variant 2 (4244/2) | pF 0–3.8 | §§3, 7 |
| Variant 3 (4244/3) | pF 0–3.0 in §§3 and 7; "pF 2,9 ≙ 800 hPa" in the §3 introduction | §§3, 7 |
| Temperature | "−40 … +80 °C"; the table row has no label | §7 |
| Timing | Measurement 4 s (§7), heating 5 s (§5.2.5), 8 s announced by `aM!` | — |
| Warm-up | 15–20 s | §§5.2.5, 7 |
| Minimum cycle | 15 minutes; heat pulses accumulate | §§5.2.3, 6 |
| Supply | 7–14 V; 1.5 mA idle, 55 mA active | §7 |

The printed `0082` and `0011` strings are four characters, shorter than the
standard address-plus-three-wait-digits-plus-count announcement. The associated
prose supports the stated waits/counts; it does not establish complete wire frames.
Do not supply a missing address or zero implicitly.

Variant 3 has three published bounds: 1000 hPa and 800 hPa in the manual, and
0–700 hPa in a German distributor's datasheet for a reduced-range SDI-12 model.
The distributor's model maps to 4244/3 only by inference. Active current is also
given as 45–50 mA (manufacturer web page) and 30 mA (distributor).

Not documented: any data reply, value order beyond the wording "pF value and
temperature", error values, the identity string, CRC or concurrent support, and
whether `aM!` starts its own heat pulse after a powered warm-up.

Conversion (derived): hPa = 10^pF, kPa = 10^pF / 10. pF 0 is 0.1 kPa, pF 2.48 is
30.2 kPa, pF 7 is 1,000,000 kPa. One 0.01 pF step is 2.3 % of the reading. The
manual's "6.500 hPa" for pF 3.8 is rounded; 10^3.8 is 6,310.

**Smallest defensible contract**

- Variant 1 only, pF and temperature, two values with positions still unbound.
- Command: `aM!` then `aD0!` after the announced eight seconds.
- Capability requirements: supply within 7–14 V (12 V recommended), reporting
  interval of at least 15 minutes, 55 mA budget. A 25–30 s power window is a
  proposed bench experiment; SDI-12 startup/heating behavior remains unresolved.
- Refuse: variants 2 and 3 outside this candidate's scope, intervals under
  15 minutes, a 5 V supply, the hPa unit.

Counterexample to the 25–30 s window: if power-on already triggers a heat pulse
and `aM!` triggers another, each cycle heats twice and the reading drifts as the
manual warns. One bench cycle with a current trace settles it.

## HSTI HydraScout

Manufacturer evidence (archived HSTI product pages, 2016 and 2017; shop listings
2020–2022; current site):

- Measurements: "0 = soil moisture percentage (SMP%) / 1 = soil temperature
  (degrees Celsius) / 2 = raw frequency measurement (Megahertz)".
- One data point per 10 cm sensor segment. Default address 0.
- Sampling about 300 ms, settling 250 ms, 5–24 V, 30 mA measuring.
- Families: Budget (3 sensors), Standard (2–6), HD (6, 8 or 10).
- Salinity: absent in 2016, claimed in 2021, "in development" in 2022, absent
  from the current measurement statement.

The mapping of measurements 0, 1, 2 to `aM!`, `aM1!`, `aM2!` is an inference; the
table never prints a command.

Third-party evidence: the Banner note (Rev. A, 2015) labels `M!` as moisture and
`M1!` as temperature for a three-sensor example on one radio model. Its table
values are placeholders that recur in Banner's notes for other probes. It prints
no SDI-12 reply and tells the reader twice to check with the manufacturer.

Not documented anywhere: the identity string, announced waits and counts, value
order within a group, units and scaling, any conductivity output, error values,
depths per model, how a ten-sensor probe returns more than the nine values an
M command allows.

**Contract: none.** Keep `protocol_evidence_required`. Two capacity facts are
safe to encode now: a ten-sensor HD exceeds the eight temperature channels in
the manifest, and no conductivity mapping has a source.

## Implementable now from documents

1. Edge-side reply framing: address check, sign-delimited values, CR/LF, optional
   three-character CRC per SDI-12 1.4. Use the
   [offline protocol preview](../sdi12-protocol-preview.md) on raw command-labelled replies.
2. PR2 dry-run compilers for both command options, with the D-block table as the
   test oracle and readback parsing of `B M2 U=V,S6,a0=1.2 a1=8.2`.
3. TEROS evidence split by model and firmware line, with the Dragino
   firmware-1.12 exchange as a labelled vendor example and Eq. 6 boundary tests.
   Descriptor activation awaits the firmware/unit contract.
4. Tensiomark timing and power budget checks, including refusal of short
   intervals; power-window proposals remain experimental.
5. HydraScout grouped-response and capacity refusals.
6. Replay cases from `calculations.json` for zero, boundary and out-of-range
   inputs.

## Questions for manufacturers (drafted, not sent)

Delta-T:

1. What is the exact format of each value in an `aD0!` reply for `aM!`, `aM1!`
   and `aM3!`: sign, digits, decimals?
2. Does a PR2/6 return six values in `aD0!` after `aM3!`, or split them, and where?
3. Is the `aC!` reply `atttn` or `atttnn`?
4. Which measurement numbers can `aXWMn…` redefine? Can `M1`–`M4` change?
5. What does a position report in air, in water and on a fault? Is θ clamped?
6. Is the stale-reading behaviour on p. 31 a property of the probe?
7. Which firmware versions exist, and does `002` in the identity identify them?

METER:

1. Is `calibratedCountsVWC` the RAW input of Eq. 6, on firmware 1.x and 3.x?
2. Can an error code appear in one field while the others remain valid?
3. What are `ttt` and `n` for TEROS 11 and 12 on firmware 3.x?
4. What changed in the SDI-12 output between firmware 1.14 and 3.00?
5. How many decimals does the first field carry on each firmware line?

ecoTech:

1. What is the exact `aD0!` reply after `aM!`: order, sign, decimals?
2. What does the sensor return when dry, frozen, below pF 0 or faulty?
3. Does `aM!` start a heat pulse, and must power be applied 15–20 s before it?
4. Is the measurement time 4, 5 or 8 seconds?
5. What is the calibrated bound of 4244/3, and how is the variant read from the
   sensor?
6. What is the identity string?

HSTI:

1. Please supply the SDI-12 command reference for the installed model.
2. What do `aI!`, `aM!`, `aM1!` and `aM2!` return: count, order, units, decimals?
3. How does a ten-sensor probe return its values?
4. Is any salinity or conductivity value available over SDI-12, in which unit?
5. What are the error values and the announced wait?

## Questions for our hardware

Use the converter's serial console. Record every byte including address, CR/LF
and CRC.

| Sensor | Procedure | Outcomes that decide |
|---|---|---|
| PR2 | Identity and all relevant M3 readbacks; M3/C3 trials with D retrieval until count is met. For the manufacturer's raw-mV check use C7: air in protection tube; water with probe inside an access tube, never bare-probe immersion. Follow manual pp. 39–40 for spacing and temperature | Width/grouping and readback contract; official raw reference is 75±20 mV in air and 1020–1100 mV in water, not the derived M3 percentages |
| TEROS | Identity; M/D retrieval in air and water; separately authorized address/power trials | Version, decimals, startup string; manufacturer check expects slightly negative VWC in air and about 0.70 m³/m³ in water, without proving RAW-field identity |
| Tensiomark | Read label/identity; compare proposed warm-up settings while logging current; allow at least 15 minutes between every measurement start, including comparison trials | Variant, response positions, warm-up need and heat pulses; no automatic shortened-cycle test |
| HydraScout | `aI!`; `aM!`, `aD0!`…; `aM1!`; `aM2!`; `aC!` | Count per group, grouping, units, whether more than nine values need `aC!` |
| Converter | Capture raw ALLDATAMOD output with DATACUT cleared under a separately reviewed configuration procedure | Whether full replies and slot/length boundaries survive for varying widths; exact installed firmware behavior |

## Limits of this audit

- The PR2 manual is the only PR2 protocol source; it has no firmware history.
- TEROS guide revisions 06–11 were not read. No guide covers firmware 1.12; the
  Dragino exchange is the only evidence for that version.
- The Dragino page is mutable; its hash and access date are in
  `teros.evidence.json`. The older wiki URL now redirects and was not read.
- HydraScout pages from 2016–2022 are archive captures. HSTI's catalogue sits
  behind a form and was not obtained.
- Other vendors' integration notes for HydraScout were searched by name only;
  none was found.
