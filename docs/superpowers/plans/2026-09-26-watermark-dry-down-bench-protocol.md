# WATERMARK dry-down bench protocol (phase 3 gate)

Date: 2026-09-26 · Status: raw observation allowed; gate acceptance pending the manifest (phase 1 is on main as `ca08dcc13`; the Task E1 analyzer is implemented) · Owner of the run: the bench operator

> **Separate capture from acceptance.** The offline Task E1 analyzer is
> implemented. The isolated node may also collect raw observations before Phase 1
> is deployed on the bench gateway, provided it is unassigned and cannot reach irrigation
> control. No real PASS, FAIL, or INCONCLUSIVE result is accepted until §2.3
> turns the identity history into a complete manifest and the rewritten Task E1
> analyzer is green. The current EUI alone is not calibration provenance.

This protocol is the bench gate in spec §8
(`docs/superpowers/specs/2026-09-25-watermark-lsn50-design.md`): no WATERMARK
probe on an LSN50 drives irrigation in the field until a real-probe dry-down
through 2–15 kΩ has passed it. The run answers three questions:

1. Does the §5.1 joint solve stay consistent across the irrigation band? The
   check is that the electrode offset it recovers is stable and the resistance
   curve is smooth.
2. How often does the firmware set the unsettled flag (`0x04`) in that band?
3. When `0x04` is set, how far can the late sample be trusted? The answer is
   the **unsettled acceptance envelope**, a relative early/late resistance
   drift below which an unsettled reading still gets kPa.

The 2–15 kΩ band is where irrigation decisions sit. With the 200SS relation at
20 °C, 2 kΩ is about 14 kPa and 15 kΩ about 88 kPa. Below 2 kΩ the probe is
wet enough that the phase 1 clip rules (`saturated`, `wet_offset_clipped`)
already decide. Above 15 kΩ the soil is past every threshold in use.

An accepted result needs the Phase 3 analysis script
(`scripts/watermark-drydown-analysis.js`, Phase 3 plan Task E1) and the §2.3
software state. Raw radio logging is a separate observational path and may
predate the phase 1 deployment on the bench gateway.

## 1. What this protocol must never contain

No LoRaWAN keys (AppKey, NwkSKey, AppSKey), no ChirpStack API tokens, no
passwords. Where a step needs one, it names the Vaultwarden entry or the
provisioning record, never the value. The run record (§7) follows the same
rule. The historical calibration record at
`<bench-records>/<previous-device-eui>/` is local-only and stays
that way. It is calibration provenance, not proof of the current radio identity.

## 2. Setup

### 2.1 Hardware

| Item | Detail |
|---|---|
| Node | Dragino LSN50v2, current DevEUI `<device-eui>`, explicitly reprogrammed from `<previous-device-eui>` on this same physical measurement circuit. Firmware is `feature/watermark-profile3-temperature` at the commit and image SHA-256 recorded by §2.3. |
| Probes | Two IRROMETER WATERMARK 200SS. WM1 on T2 PA0 + T20 PB12, WM2 on T3 PA1 + T21 PB13 (bench record wiring) |
| Soil thermometer | DS18B20: red to T1 VDD, black to T12 GND, data to T8 PB3 (board R7 4.7 kΩ pull-up) |
| Reference thermometer | Any probe thermometer readable to 0.1 °C, placed at probe depth |
| Reference resistors | Four metal-film resistors near 2.2 kΩ, 4.7 kΩ, 10 kΩ and 15 kΩ, each measured with the bench multimeter (record the measured value, not the marking) |
| Medium | A pot of at least 5 L of the target soil (or a sandy loam), sieved, no stones against the probes |
| Gateway | the Pi 4 bench gateway (unlinked). It must stay unlinked for the whole run |
| Power | Node on its battery, console cable disconnected during buried measurements (the firmware README warns that a grounded console adds a current path) |

Both probes go in the same pot at the same depth (about 15 cm), 10 cm apart,
with the DS18B20 between them at the same depth.

### 2.2 Probe conditioning

The bench record found a 170 mV electrode offset on WM1 while wet. Condition
both probes before the run, per the bench record's own next step:

1. Soak both probes in water overnight.
2. Let them dry in air for 4 h, then soak again for 2 h.
3. Install them wet, packing soil slurry around each probe so the granular
   matrix touches soil on all sides.

### 2.3 Acceptance identity and software prerequisites

These are operator steps on the bench gateway, done by the bench operator with the
`osi-live-ops-runbook` skill loaded. They must be complete before accepting a
gate result. Steps 3–5 and the isolation rule in step 7 apply before raw
capture; the completed manifest, Phase 1 deployment, saved calibration, and
green analyzer apply before acceptance.

1. **Write the identity-bound run manifest.** Record the board serial or durable
   physical label; a statement that this same node and measurement circuit was
   reprogrammed from `<previous-device-eui>` to `<device-eui>`; the UART
   `AT+DEUI?` result; firmware commit, build ID and image SHA-256; the DevEUI on
   a fresh ChirpStack uplink produced while only this node is powered; the
   matching `devices` row on the bench gateway; circuit revision; both probe
   IDs; and the historical calibration-record path. UART, ChirpStack and edge
   must all say `<device-eui>`. The calibration provenance remains tied to
   the physical board, circuit revision and old record path, not solely to the
   new EUI. If any binding cannot be recorded, the capture remains
   observational; recalibrate before accepting it as gate evidence.
2. Phase 1 (on main since `ca08dcc13`, migration `0061__watermark_lsn50.sql`)
   is deployed on the bench gateway, with a pre-deploy backup. The spec §12
   cleanup of the old misread rows is done first, also with a backup.
3. The node is registered in ChirpStack on that gateway as
   `<device-eui>`, with the OSI Dragino LSN50 profile and shared codec
   (never a new profile). Keys come from the provisioning record, not from this
   document.
4. The temporary bench configuration is reverted (`AT+NJM=1`, `ATZ`) so the
   node joins over OTAA, or the ABP session is registered consistently. The
   bench record lists the revert commands.
5. The uplink interval is 5 minutes: `AT+TDC=300000`. The interval is part of
   the continuity reference in §5.3, so it must stay fixed for the run.
6. Only after step 1 passes, the calibration from the historical record is
   saved through the edge GUI (or
   `PUT /api/devices/<device-eui>/watermark/calibration`): ch1 Pu 41 670,
   Pd 41 260, sf 130, sr 112; ch2 Pu 42 530, Pd 42 070, sf 46, sr 27.
7. The node is **not** assigned to any irrigation zone, and (once phase 3 is
   deployed) its WATERMARK scheduler admission is absent or disabled. A bench
   node must never be able to reach the scheduler.

## 3. Procedure

### 3.1 Resistor check before the run (P1, first half)

Do this with the probes disconnected from the node, over the UART console, so
no fake soil reading reaches `device_data`.

1. Give each physical resistor a durable `resistor_id` and one nominal-band
   label: `2k2`, `4k7`, `10k`, or `15k`. Use one distinct resistor per band and
   keep the same four IDs for the after check.
2. Measure each resistor with the multimeter. For each channel and resistor,
   run `AT+GETSENSORVALUE=0` exactly three times and number the observations
   `repeat=1`, `2`, and `3`.
3. Copy the printed forward/reverse early and late codes into
   `resistor-check-before.csv` using §4.2's exact columns. The file contains 24
   logical cells: two channels × four resistor IDs × three repeats. Repeating a
   cell does not fill a missing one.

### 3.2 Wet start (information only)

1. Reconnect both probes, bury them as in §2.1, water the pot to saturation,
   and let it drain for 1 h.
2. Let the node uplink for at least 2 h. These readings answer the phase 1
   open question about clip detection: whether the ADC saturates exactly at
   code 0 / 4095, and what a clipped and unsettled sample looks like. They
   are not part of any criterion.

### 3.3 Dry-down

1. Stop watering. Keep the pot indoors, out of direct sun, away from heaters.
2. Once a day, and at start and end, read the reference thermometer at probe
   depth and note the time and value in the run record. The DS18B20 value for
   the same time comes from the nearest uplink.
3. Let the dry-down run until both probes read above 15 kΩ for at least 6 h.
   In soil this takes days to a couple of weeks. Do not speed it up with a
   fan or heat: the continuity reference in §5.3 needs resistance to change
   slowly between uplinks.
4. If a probe reaches 15 kΩ in under 24 h, the run is too fast. Rewet and
   repeat with a larger pot or a finer soil.

### 3.4 Resistor check after the run (P1, second half)

Repeat §3.1 with the same four resistor IDs and nominal-band mapping into
`resistor-check-after.csv`. Remeasure each resistor and repeat that measured
value on its six rows in this file. The after file also has exactly 24 logical
cells. A shift between before and after means the calibration drifted during
the run (die temperature, VDDA) and the dry-down data has to be read against
that.

### 3.5 Optional: asymmetric board

The phase 1 final review noted that the joint solve's accuracy on these
boards partly rests on Pu ≈ Pd (41.7k/41.3k, 42.5k/42.1k), where the
first-order offset error cancels. If a board with |Pu − Pd| / Pu above 5 % is
available, run §3.1 on it with a known offset source (a 1.5 V cell through a
100 kΩ divider giving about 10 mV in series with the resistor). This result
is information for the spec, not a gate criterion.

## 4. Data to capture

### 4.1 Uplink data from the gateway or raw logger

After Phase 1, export read-only from the edge DB; never open the live DB for
writing and never copy a DB onto the gateway. On the bench gateway:

```sh
sqlite3 -readonly -header -csv /data/db/farming.db "
SELECT deveui, id, recorded_at, f_cnt, frame_status, reject_reason, payload_hex,
       supply_mv, soil_temp_c, soil_temp_source, die_temp_c, status_byte,
       ch1_flags, ch1_fwd_early, ch1_fwd, ch1_rev_early, ch1_rev,
       ch1_r_solved, ch1_offset_mv, ch1_status, ch1_kpa,
       ch2_flags, ch2_fwd_early, ch2_fwd, ch2_rev_early, ch2_rev,
       ch2_r_solved, ch2_offset_mv, ch2_status, ch2_kpa,
       calibration_sync_version, conversion_version
  FROM watermark_readings
 WHERE deveui = '<device-eui>'
   AND recorded_at >= '<run start, ISO UTC>'
 ORDER BY recorded_at, id;" > /tmp/drydown.csv
```

Then copy `/tmp/drydown.csv` to the workstation with `scp` and delete it on
the gateway. The analysis recomputes everything from `payload_hex` with the
shipped helper, so the stored derived columns are a cross-check only: if they
disagree with the recomputation, stop and find out why before trusting either.
`watermark_readings.f_cnt` is nullable (ingest stores null when an uplink has
no integer frame counter). The analyzer refuses a row without an integer
`f_cnt` and two accepted rows with the same `deveui` and `f_cnt`. A node rejoin
that resets the counter during the run can therefore fail validation.

Before Phase 1 is deployed there, the existing isolated raw logger may collect the same radio
observations as JSON. Preserve that original file unchanged. Before analysis,
convert it deterministically to `drydown.csv` with at least
`deveui,id,recorded_at,f_cnt,frame_status,payload_hex`; carry the DevEUI from
each radio record rather than injecting one constant after capture. Assign a
stable unique ID from the immutable source record. Mark a row `accepted` only
when the source contains a complete profile-3 payload and the shipped parser
accepts it; otherwise retain it as `frame_rejected` with the reason. Record the
conversion command and tool version, original JSON path and SHA-256, and
derived CSV SHA-256 in `run-metadata.json`. The analyzer rejects a missing or
mixed row EUI. Raw JSON collection is observational until §2.3 and all
remaining protocol evidence are complete.

### 4.2 Hand-recorded files

| File | Columns |
|---|---|
| `resistor-check-before.csv`, `resistor-check-after.csv` | `resistor_id,nominal_band,channel,repeat,meter_ohm,fwd_early,fwd_late,rev_early,rev_late,supply_mv` |
| `reference-temperature.csv` | `reference_id,recorded_at,reference_c` |
| `run-metadata.json` | §2.3 identity, firmware, circuit, probe and calibration-record fields using Task E1's schema |
| `calibration.json` | the eight values from §2.3 step 6 plus `sync_version` and Task E1's physical-board/circuit/source-record provenance object |

Each resistor file has exactly one row for every channel/resistor/repeat cell.
The four `resistor_id` values are distinct, map one-to-one to the four nominal
bands, and keep the same mapping in both files. Within one file, repeat the one
measured `meter_ohm` value for that physical resistor on all six uses. The
nominal band identifies the part; P1 compares against `meter_ohm`, not the
marking. `supply_mv` is the observed supply for the check, from the nearest
uplink when available; record 3300 only when that is the documented bench
assumption.

Give every thermometer observation a unique `reference_id`. Do not omit an
observation because there is no nearby uplink: the analyzer must report that
row as unmatched.

## 5. Analysis

Run on the workstation from an osi-os checkout that carries the Task E1
analyzer:

```sh
node scripts/watermark-drydown-analysis.js \
  --readings drydown.csv \
  --calibration calibration.json \
  --run-metadata run-metadata.json \
  --resistors-before resistor-check-before.csv \
  --resistors-after resistor-check-after.csv \
  --reference-temperature reference-temperature.csv \
  --interval-min 5 \
  --out drydown-report
```

It writes `drydown-report/readings.csv` (one row per channel per accepted
frame, all metrics below) and `drydown-report/summary.json` (identity,
calibration and capture provenance; the raw-source hash when applicable; every
analyzer input's SHA-256 and row count; every criterion with its value, limit,
verdict and details; per-probe candidate tables; the single deployed envelope;
final P5 counts; and all thermometer matches or unmatched rows). The script uses
`osi-watermark-helper`'s own `parseProfile3`, `resistanceFromCodes` and
`tensionFromResistance`, so the bench judges the code that runs on the
gateway.

### 5.1 Per-channel metrics

For each accepted frame and each channel with trusted flags (no `0x01`,
`0x02`, `0x08`, `0x10`, no `0xFFFF` code), not open and not clipped:

| Metric | Definition |
|---|---|
| `r_late` | joint solve (§5.1) on the late forward and reverse codes |
| `r_early` | the same solve on the early codes (skipped when an early code is at a rail) |
| `rho` | \|r_early − r_late\| / r_late |
| `drift_fwd`, `drift_rev` | \|early − late\| in counts, and as a multiple of the firmware tolerance max(6, signal/50), with signal = late forward code, or 4095 − late reverse code |
| `offset_mv` | electrode offset from the late solve |
| `kpa_late`, `kpa_early` | `tensionFromResistance` at the frame's DS18B20 temperature (source 2 only) |
| `unsettled` | flag `0x04` set |
| `band` | `r_late` in [2 000, 5 000), [5 000, 10 000) or [10 000, 15 000] Ω; otherwise out of band |

### 5.2 Offset stability (the forward/reverse agreement check)

The joint solve assumes one offset shared by both phases of a frame. A single
frame cannot test that, because two equations always fit two unknowns. The
run tests it over time: for settled in-band readings, compare each offset
with the rolling median of the six readings around it. At 2 kΩ and about
75 µA drive, a 10 mV offset change inside one frame moves the solved
resistance by about 130 Ω, about 0.6 kPa. That bounds the criterion in §6.

The naive single-direction resistances (`r_fwd`, `r_rev`) are reported but
not judged. With the 170 mV wet offset seen on WM1 they disagree by more than
100 % at 2 kΩ, and the joint solve exists to remove exactly that.

### 5.3 Continuity reference

A slowly drying pot gives a smooth resistance curve, so a trustworthy reading
lies on the curve of its settled neighbours. For a reading at time t on one
probe:

1. Take the latest settled in-band reading before t and the earliest one
   after t, both within 3 uplink intervals (15 min at a 5 min interval).
2. Interpolate ln(R) linearly in time between them to get `r_ref`, and
   convert with the reading's own temperature to get `kpa_ref`.
3. The residual is ε = |kpa_late − kpa_ref|.

The script computes ε for every unsettled reading, and a leave-one-out ε for
every settled reading (the reading's own neighbours, itself excluded). The
leave-one-out distribution is the noise floor of the method. If it is wide,
the pot dried too fast for the interval and the envelope cannot be judged.

### 5.4 Envelope derivation

Candidate values of `rho`: 0.005, 0.01, 0.02, 0.03, 0.05, 0.08. Evaluate each
probe separately. For each candidate c, construct that candidate's own set of
unsettled in-band observations that have a continuity reference and `rho ≤ c`.
Let p be the previous candidate, or 0 for candidate 0.005. The candidate
qualifies only when its set has at least 5 observations, every residual in the
set is at most 3 kPa, and at least one observation has `p < rho ≤ c`. This last
condition fixes the observed-support tolerance in advance: each candidate is
supported by its own grid interval, not extrapolated from lower drift. Choose
the largest qualifying candidate per probe. Five passing observations at
`rho = 0.025` qualify 0.03, but not 0.02, 0.05, or 0.08.

The single envelope that could be deployed is the smaller of the two
per-probe envelopes when both are non-null; otherwise it is null and the phase
1 rule stands (unsettled above 550 Ω gets no kPa). P5 is evaluated only after
this global value is selected, and both probes are reevaluated under it.

3 kPa is this protocol's tolerance for a trustworthy reading. It is an owner
decision (phase 3 plan OD-6), not a general accuracy claim for WATERMARK or
the 200SS relation. It can be tightened before the run; loosening it after the
run to make a result pass is not allowed. The same rule applies to every limit
in §6.

## 6. Criteria and verdict

| # | Criterion | Limit | Failure class |
|---|---|---|---|
| P1 | Exact before and after matrices: 2 channels × 4 distinct resistor IDs/bands × 3 repeats; evaluate every valid uniquely identified cell's late-solve \|R_solved − R_meter\| | Complete 24-cell matrix per file and error ≤ 1.5 % + 15 Ω | Any valid out-of-tolerance cell is FAIL even with other gaps; otherwise gaps are INCONCLUSIVE |
| P2 | Coverage per probe: accepted, trusted, unclipped in-band readings with DS18B20 temperature | ≥ 30 total and ≥ 5 in each sub-band | INCONCLUSIVE |
| P3 | Offset stability per probe: p95 of \|offset − rolling median\| over settled in-band readings | ≤ 10 mV | INCONCLUSIVE with no usable deviations; FAIL above the limit |
| P4 | Method noise floor per probe: p95 of leave-one-out ε over settled in-band readings | ≤ 3 kPa | INCONCLUSIVE |
| P5 | Unusable share per probe after selecting the one global deployed `E`: in-band readings that are unsettled and rejected under that global value, over all in-band readings | ≤ 20 % | FAIL |
| P6 | DS18B20 against every reference-thermometer row, nearest valid frame within ±30 min | Every row matched and \|Δ\| ≤ 1.0 °C | INCONCLUSIVE for no/unmatched data; FAIL for a matched excessive delta |

The gate **passes** when P1 to P6 all pass. It is **inconclusive** when there is
no actual failure but P1 lacks a complete matrix, P2 lacks coverage, P3 has no
usable settled deviations, P4 lacks a usable continuity reference, or P6 has
no data or any unmatched row. An
unmatched thermometer row stays in the report with its nearest-frame distance;
it is never dropped from the denominator. The gate **fails** when any valid,
uniquely identified P1 cell is out of tolerance—even if a different cell is
missing—when P3 or P5 fails, or when a matched P6 row exceeds 1.0 °C.
If P6 has both an unmatched row and a matched excessive delta, the established
temperature failure wins and the overall result is FAIL.

P5 carries the irrigation consequence. The scheduler averages the last hour
and acts on the 06:00 run. If most in-band readings carry no kPa, a zone
gets no decision exactly when the soil is drying. A 20 % unusable share at a
15 min field interval still leaves about 3 points per hour on average.

## 7. How the result feeds the phase 3 code

| Outcome | Code consequence |
|---|---|
| PASS, `E` null (no unsettled readings in band, or none trustworthy) | No conversion change. `conversion_version` stays `wm-lsn50-p3-v1`. Phase 3 plan Task E10 is skipped; the ruling is recorded in the execution ledger with the `summary.json` hash. |
| PASS, `E` = number | Phase 3 plan Task E10: `UNSETTLED_MAX_REL_DRIFT = E` in `osi-watermark-helper/conversion.js`, the unsettled rule accepts `rho` ≤ E, and `conversion_version` becomes `wm-lsn50-p3-v2`. Stored readings are not rewritten. Three dry-down frames (one accepted unsettled, one rejected unsettled, one settled) become golden fixtures. |
| INCONCLUSIVE | Repeat or extend the evidence as §6 directs. Isolated observational capture may continue, but there is no irrigation-control use. |
| FAIL | Do not enable irrigation control for this circuit. Isolated diagnostic capture may continue. Phase 3 code may still merge because admission is explicit. File a firmware issue on the LoRa_STM32 fork naming the failed criterion (a P5 failure points at the 20/60 µs sample timing in `wm_core.c`; P1 or P3 at the circuit). |

The run record goes to
`<bench-records>/<device-eui>/<date>-watermark-drydown.md`
with: firmware commit and image hash, calibration values, uplink interval,
previous and current DevEUIs, physical-board statement, circuit revision,
probe IDs, calibration-record path, pot and soil description, start and end
times, the `summary.json` verdict table and hash, the envelope, and anything
that deviated from this protocol. The record carries no keys and no DB copies.

## 8. What this gate does not cover

- Long cables. The run uses the probes' stock leads. A field install with a
  longer cable adds capacitance and has to be rechecked against P5.
- Temperature and VDDA drift of the pulls. Die temperature and VDDA are in
  every frame and the analysis reports them, but no criterion uses them.
- Agreement with a KIWI node or a handheld WATERMARK meter. If one is
  available, read it at the same times as the reference thermometer and add
  the values to the run record as information.
