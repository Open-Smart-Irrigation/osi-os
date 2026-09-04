# Sentek EnviroSCAN/TriSCAN and Dragino SDI-12 commissioning record

This record closes the 2026-08 bench and field investigation for a Sentek
SDI12-E16-R probe connected through a Dragino SDI-12-LB/LS. It records what was
measured, what failed, and the byte-level configuration that produced complete
readings. Use it with the current [Dragino SDI-12 device guide](../devices/dragino-sdi12.md),
not as a generic recipe for other probes.

## Hardware and field layout

- Sentek interface hardware revision 2.4, firmware 1.39, identity
  `012SENTEK  XEPI  139D938D7150000`.
- Dragino hardware revision 1.3.
- Field Dragino DevEUI `A8404135955C327D`, gateway EUI
  `0016C001F116EBF2`.
- Saved SDI-12 address `0`. The address belongs to the probe and remains saved
  layout data; the compiler does not hard-code it.
- Modules: TriSCAN at 10 and 50 cm; EnviroSCAN at 20, 30, 40, 60, 80, and
  100 cm. Response positions are 1 through 8 in that order.

The vendor configuration utility showed these air/water counts after the
two-point normalization:

| Response | Depth | Module | High/Air | Low/Water |
|---:|---:|---|---:|---:|
| 1 | 10 cm | TriSCAN | 29853 | 19844 |
| 2 | 20 cm | EnviroSCAN | 37387 | 24569 |
| 3 | 30 cm | EnviroSCAN | 37630 | 24746 |
| 4 | 40 cm | EnviroSCAN | 37382 | 24657 |
| 5 | 50 cm | TriSCAN | 29793 | 20423 |
| 6 | 60 cm | EnviroSCAN | 37688 | 24714 |
| 7 | 80 cm | EnviroSCAN | 37958 | 24646 |
| 8 | 100 cm | EnviroSCAN | 37736 | 24434 |
| 65 | 10 cm | TriSCAN salinity | 20306 | 13940 |
| 69 | 50 cm | TriSCAN salinity | 20250 | 13985 |

The water test was a commissioning check with the probe held in the container,
not an agronomic calibration of the installed soil profile. Preserve the vendor
backup file before changing these values.

## Bench chronology and physical lessons

The Dragino USB/UART console was unreliable during the first session even after
the CH343 adapter port and 3.3 V logic were confirmed. BLE was the dependable
converter console for the textual `AT` and `AT+CFGDEV` checks. The Waveshare
UART adapter was not a substitute for an SDI-12 interface: logic-level TX/RX
activity and a 5 V pin did not prove that it could drive the single-wire SDI-12
bus. The Sentek vendor cable and PConfig utility connected immediately once the
probe had power.

PConfig detected the original probe, read its identity and configuration, and
queried all ten internal rows. This proved the probe electronics were alive.
The original Dragino also communicated with that probe later in the lab after
their grounds were tied together. Replacing the field converter and probe was
therefore not evidence that either original SDI-12 interface had failed.

The Sentek Series II manual allows about 750 ms from power-on before commands.
Its EnviroSCAN revision 2.4 example lists up to 200 mA startup current at 5.5 V
and reaches idle after roughly 120 ms; measurement commands then announce their
own response timing. A power source must tolerate that startup current without
voltage collapse. The field Dragino's switched 12 V output and common ground
did so. The measured rail alone was not enough to diagnose acquisition because
the malformed converter slots failed even when the rail was present.

## Proven measurement contract

The working console configuration requested VWC with `aM!`, `aD1!`, and
`aD2!`, then the compact TriSCAN VIC group with `aM2!`:

```text
AT+COMMAND1=0M!,1,1,2
AT+DATACUT1=30,2,2~28
AT+COMMAND2=0D1!,0,0,2
AT+DATACUT2=30,2,2~28
AT+COMMAND3=0D2!,0,0,2
AT+DATACUT3=21,2,2~19
AT+COMMAND4=0M2!,1,1,2
AT+DATACUT4=21,2,2~19
```

The converter also needs `DATAUP=1`, `PAYVER=2`, newline suppression, an
8-second switched-power window, and the normal 1200-second reporting interval.
The observed field payload was split into three 42-character ASCII slices. A
complete reassembly was:

```text
+0.732840+28.27938+37.45271+41.05683+0.969157+46.21098+38.87460+44.38053+1615.877+4237.622
```

The normalizer maps the first eight values by saved response position to
the eight moisture channels. EnviroSCAN positions are already calibrated
millimetres per 10 cm, numerically equal to VWC percent. The legacy TriSCAN
positions use identity coefficients in the saved probe configuration and are
therefore scaled frequency; the normalizer applies the Sentek default moisture
curve before writing `vwc_1` and `vwc_5`. It maps the following two values to
`soil_vic_1` and `soil_vic_5` because only response positions 1 and 5 are
TriSCAN modules. It rejects a VWC-only or wrong-cardinality mixed frame
atomically.

## TriSCAN moisture and VIC interpretation

PConfig auto-detected both TriSCAN moisture rows with `A=1`, `B=1`, and `C=0`.
That identity equation exposes normalized scaled frequency on `aM!`; it does
not turn `0.732840` into `0.7%` VWC. For configured TriSCAN modules, OSI applies
Sentek's default moisture relation:

```text
SF = 0.1957 * VWC^0.404 + 0.02852
VWC = ((SF - 0.02852) / 0.1957)^(1 / 0.404)
```

Values at or below the curve's `C` constant map to zero. Negative, non-finite,
or greater-than-100% results are rejected. The field vector above therefore
means approximately `23.81%` at 10 cm and `48.72%` at 50 cm, not `0.73%` and
`0.97%`. The six EnviroSCAN values remain unchanged. Do not replace the
TriSCAN identity coefficients in PConfig while this normalization contract is
active; a probe configured to return site-calibrated VWC directly would be
converted twice and needs an explicit future calibration-mode setting.

The `aM2!` values are different. They are Sentek's nominal Volumetric Ion
Content index and already include the probe's proprietary two-frequency model.
They are not electrical conductivity and have no universal EC unit. The bench
utility reported about `205` and `208` VIC for the two modules; the field series
reported about `1614-1627` at 10 cm and `4238-4244` at 50 cm. This scale is
credible: Sentek's own examples use VIC values from hundreds into thousands.
The high, stable 50 cm baseline is not by itself evidence of a decoder error or
fertilizer leaching. Interpret changes at comparable water content, and use
site-specific soil samples plus regression before presenting VIC as EC or ECe.

## Correct LoRaWAN frames

Dragino `0xAF` downlinks are compact binary structures. The command text ends
at `!`; the wait, automatic-data, and validation parameters are individual raw
bytes. DATACUT's four values are also raw bytes. They are not the ASCII text of
the console line.

For the saved address and layout above, recipe version 2 compiles these 16
confirmed FPort 2 frames, in order:

```text
07031F40
AB01
AE02
AD01
A500
A90D09
AF010106304D2101010200
AF0102041E02021C00
AF0201073044312100000200
AF0202041E02021C00
AF0301073044322100000200
AF0302041502021300
AF040107304D322101010200
AF0402041502021300
09050F
010004B0
```

`A500` disables inserted newlines while all-data mode is active. It prevents a
converter formatting choice from breaking strict reassembly, but it was not
the root cause of the earlier empty readings. The final `010004B0` restores the
20-minute interval.

## Field evidence

The field node stored complete readings after the compact binary recipe was
sent manually:

| UTC timestamp | Battery | VWC channels | VIC at 10/50 cm | Power window |
|---|---:|---|---|---:|
| 2026-08-30 22:16:48 | 3.408 V | all 8 | 1616.42 / 4237.62 | 45 s |
| 2026-08-30 22:18:36 | 3.414 V | all 8 | 1615.88 / 4237.62 | 45 s |
| 2026-08-30 22:20:29 | 3.414 V | all 8 | 1614.79 / 4243.75 | 45 s |
| 2026-08-30 22:30:49 | 3.414 V | all 8 | 1619.17 / 4237.62 | 8 s |
| 2026-08-30 22:40:48 | 3.414 V | all 8 | 1627.09 / 4237.62 | 8 s |
| 2026-08-30 23:01:05 | 3.414 V | all 8 | 1617.24 / 4237.62 | 8 s |

The last two rows prove that an 8-second power window is sufficient for this
specific eight-module, two-TriSCAN build. They do not establish an 8-second
limit for every supported ten-module arrangement. Test a larger or all-TriSCAN
build before applying the same timing.

The 1200-second interval frame was accepted and removed from the ChirpStack
queue after the 22:40:48 uplink. The next complete row arrived 20 minutes 17
seconds later, proving the normal reporting cadence was restored.

Each complete row emitted its normal `DEVICE_DATA_APPENDED` event. The checked
outbox records had no pending item, retry, or rejection for this device.

After deploying the TriSCAN scaled-frequency conversion, the live row at
`2026-08-30 23:46:38Z` stored VWC
`23.62, 28.19, 37.42, 41.07, 48.73, 46.21, 38.87, 44.37%` and VIC
`1615.59, 4243.75`. The matching outbox event was accepted by the cloud at
`23:47:03Z`. The first post-drain row at `00:06:37Z` repeated the profile within
`0.03` percentage points, repeated VIC within `0.01`, and was accepted by the
cloud at `00:07:03Z` without a retry or rejection. The next scheduled row at
`00:26:37Z` stored VWC
`23.79, 28.16, 37.43, 41.08, 48.72, 46.23, 38.87, 44.37%` and VIC
`1611.54, 4243.75`. It moved recipe commissioning to `observed_compatible` and
was accepted by the cloud at `00:26:57Z` with zero retries. Twelve earlier
complete rows retain rounded scaled frequency in their two TriSCAN VWC columns
because their full-precision source strings were not persisted. Do not derive
replacement history from those rounded values.

The corrected profile is internally coherent: across three scheduled rows,
each VWC channel spans at most `0.17` percentage points. VIC at 10 cm spans
`4.06`, about `0.25%` of its level, while VIC at 50 cm is unchanged. No new
ingest quarantine was recorded after the final incomplete commissioning frame
at `22:15:45Z`. The field profile rises from about `24%` at 10 cm to `41-49%`
at 40-60 cm, then remains about `39-44%` at 80-100 cm. Those are plausible
volume percentages for a wet profile, not percentages of saturation. They do
not establish site-calibrated absolute accuracy. The 10 and 50 cm values use
the default TriSCAN curve, while the other six use the probe-configured
EnviroSCAN curve; soil-specific calibration and confirmed tube contact are
required before treating small differences between those sensor types as
agronomic effects.

## Failure and diagnostic correction

The first recipe compiler treated the console strings as an opaque value. It
encoded `0M!,1,1,2` and `30,2,2~28` as ASCII bytes inside `0xAF` frames. The
Dragino accepted the downlinks, but the stored acquisition slots did not
represent the console commands. The deployment queue drained successfully and
the node continued to send battery telemetry, which made the failure look like
a probe, power, address, or wiring problem.

That interpretation was wrong. The same Sentek and the original Dragino later
worked in the lab with their common ground restored. The working textual console
commands and the official binary example then exposed the compiler mismatch.
The initial investigation spent too long testing physical hypotheses before
comparing the actual downlink bytes with the vendor frame layout.

For future incidents, use this order:

1. Confirm the probe identity and direct textual measurement through the vendor
   utility or Dragino console.
2. Capture the exact console command that works.
3. Decode the queued LoRaWAN frame field by field and compare it with a vendor
   binary example. Queue acceptance proves delivery only, not interpretation.
4. Confirm common ground, switched voltage under load, and address after the
   protocol bytes match.
5. Separate converter telemetry, SDI-12 acquisition, normalizer acceptance,
   database storage, and cloud sync. A battery-only row locates the failure
   before normalization; it does not prove damaged hardware.

The official Dragino example
`AF 03 01 07 30 4D 43 21 01 01 01 00` for
`AT+COMMAND3=0MC!,1,1,1` is now a regression fixture. Future command families
must add their own vendor or bench wire vector before deployment.

## Operational boundaries

- The GUI supports one through ten modules and renders only configured channels.
- The current field build has eight modules and three PAYVER 2 segments. A
  ten-value VWC vector needs three segments at the observed 42-character slice
  size. The integration suite proves that ten TriSCAN modules can reassemble
  and persist all twenty values over five segments. That synthetic proof does
  not establish that an 8-second power window is long enough for such a build;
  bench-test the timing before deploying one.
- Temporary short reporting intervals are monitored commissioning operations,
  not part of the saved recipe. A queued command can be delayed by Class A
  timing, so the canonical recipe always ends at 1200 seconds.
- VIC is the value returned by the Sentek TriSCAN command. Do not relabel it as
  generic electrical conductivity without a documented conversion and unit.
- TriSCAN `aM!` values from this legacy identity-coefficient configuration are
  scaled frequency. They require the documented default-curve conversion before
  entering canonical VWC columns.

## Vendor references

- Dragino, *SDI-12-LB/LS LoRaWAN SDI-12 Sensor Node User Manual*:
  <https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/>
- Sentek, *SDI-12 Series II Manual, version 1.1*:
  <https://sentektechnologies.com/download/sentek-sdi-12-series-ii-manual-ver-1-1/>
- Sentek, *TriSCAN Agronomic User Manual, version 1.2a*:
  <https://sentektechnologies.com/download/triscan-user-manual-2/>
- Sentek, *Calibration Manual for Sentek Soil Moisture Sensors, version 2.0*:
  <https://sentektechnologies.com/download/moisture-calibration-manual/>
