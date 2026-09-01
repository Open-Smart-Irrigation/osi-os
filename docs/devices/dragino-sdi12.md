# Dragino SDI-12 soil node

`DRAGINO_SDI12` represents a Dragino SDI-12-LB or SDI-12-LS converter with one SDI-12 probe. The probe address is saved layout data, never an edge default. The edge stores battery voltage and the probe channels in `device_data`; the probe profile supplies the meaning and order of the ASCII values.

The LB uses an 8500 mAh Li-SOCl2 battery. The LS uses solar charging with a 3000 mAh Li-ion battery. Their SDI-12 and LoRaWAN payloads are the same, so both use this device type.

Probe layouts, identity matchers, and AT recipes remain provisional where the registry marks them provisional. The Sentek EnviroSCAN and TriSCAN recipe below was bench-verified on 2026-08-28 and field-verified on 2026-08-30; the other probe recipes still require their own captures. The full investigation record is [Sentek EnviroSCAN/TriSCAN and Dragino SDI-12 commissioning](../operations/sentek-dragino-sdi12-commissioning-2026-08-31.md).

## Commissioning

1. Register the node in the GUI as `DRAGINO_SDI12` under the `Sensors` application. The successful registration starts the identify flow.
2. Wait for the next Class A receive window. With no saved layout, the edge sends
   discovery `?!` through the Dragino `0xA8` command path. A valid one-character
   response triggers `<address>I!`; a valid saved layout skips discovery and sends
   that layout's addressed request directly. The converter returns the probe
   identity on FPort `100` on a later uplink.
3. If a bench-enabled identity matcher returns a unique profile, the device becomes `identified`. With the v1 provisional registry, the usual result is `unmatched`; keep the raw identity and choose the profile manually after confirming the probe wiring and recipe.
4. Set physical depths in the device settings modal. The modal stores channel-keyed depths, while the UI accepts one value per physical depth slot.
5. The profile list endpoint is `GET /api/sdi12/probe-profiles`. It requires the same signed-in enabled session as the device catalog. It is not a public registry endpoint.

The manual path is safe when identification is unavailable: select the profile, enter its depth values, and trigger a normal uplink. A profile mismatch writes the battery row but quarantines the sensor values, which leaves the node visible without fabricating measurements.

## Sentek recipe deployment

For a Sentek EnviroSCAN or TriSCAN layout, saving the layout and applying its
acquisition recipe are separate actions. Save validates and stores the address,
response positions, module types, and depths. It does not send a downlink or
change converter slots. The modal reports `Layout saved; acquisition
configuration not applied.` until an operator selects **Apply acquisition
configuration**.

Apply compiles the command and cut frames on the edge. The browser cannot submit
frame bytes, slot commands, queue IDs, or an FPort. The edge first requires an
empty ChirpStack device queue, then enqueues confirmed FPort 2 frames in order.
It never flushes, reorders, or overwrites an existing queue item. A maximum
ten-module recipe can take about eight hours at the normal 20-minute interval;
each cycle keeps the switched 12 V window at eight seconds. The process does not
offer continuous power or a shorter reporting interval.

The deployment state is local to the gateway and has six values:

- **Not applied**: the saved layout has no queued hardware recipe.
- **Queueing**: the gateway has claimed the request and is checking or adding
  queue items.
- **Queued**: ChirpStack accepted every recipe frame. This does not prove that
  the Class A node received or interpreted them.
- **Observed once**: one complete post-drain reading matches the saved layout.
- **Active**: two consecutive complete matching post-drain readings were stored;
  this is the UI label for `observed_compatible`.
- **Degraded**: queueing, delivery, or observed acquisition failed. The prior
  finite readings and their timestamps remain visible.

The gateway polls its stored queue-item IDs every minute. If they remain queued
for twelve hours, it records `queue_delivery_timeout`; an interrupted
`queueing` claim reaches `queueing_interrupted` after the same deadline. Do not
apply repeatedly while an attempt is queued or degraded. Inspect the bounded
error shown by the modal, wait for any accepted frames to drain, then retry the
same saved layout when the device queue is empty.

Rollback is available only after the gateway has observed a compatible recipe.
It queues that preserved recipe first, without changing the canonical device
layout. Only after ChirpStack accepts every rollback frame does the gateway
restore the matching saved layout and increment its device sync version. A
rejected or partial rollback keeps the current canonical layout and preserves
the accepted queue IDs as recovery evidence.

Identify also has two stages. With no saved layout, the edge sends `?!`; it
accepts exactly one alphanumeric address and then sends `<address>I!`. With a
valid saved layout, it sends that layout's `<address>I!` directly. A malformed
saved layout returns an error and sends no downlink. Discovery can prefill the
address input, but the operator must still save the canonical layout before
applying a recipe.

PConfig remains authoritative for probe calibration, the probe's SDI-12
address, and its physical depth configuration. Recipe deployment changes only
the Dragino converter's acquisition slots, cuts, power window, payload mode,
and normal reporting interval.

## Bench setup

Use the converter's USB/UART console or its active BLE console while the node is awake. The Dragino manual documents 1200-baud SDI-12 operation, BLE activation, the console commands, and the LoRaWAN downlink equivalents.

Start with one probe powered and address `0`. These settings are bench defaults, not a release recipe:

```text
AT+ADDRI=0
AT+DATAUP=0
AT+TDC=1200000
```

`AT+TDC=1200000` is a 20-minute interval in milliseconds. Keep `AT+DATAUP=0` here: a single probe response at this depth count fits one uplink, so the codec receives one battery/version header followed by one compact ASCII value string. See [Multi-segment uplinks](#multi-segment-uplinks) below for the `AT+DATAUP=1` contract, needed once a profile's value count exceeds the single-uplink budget.

For each probe, first issue `0I!`, `0M!`, and `0D0!` from the console and save the complete response bytes, including the address byte, carriage return, line feed, and any CRC. The periodic command can use the converter's automatic `D0!` follow-up:

```text
AT+COMMAND1=0M!,5,1,1
```

The fourth argument asks the converter to validate printable response bytes. The third argument asks it to issue `0D0!` after the measurement timeout. Increase the timeout for a probe whose datasheet or capture requires it.

`AT+DATACUT1` must remove the address byte and the trailing CR/LF. If the command requests a CRC, it must also remove the three CRC characters. The resulting payload must match `^([+-]\d+(?:\.\d+)?)+$`; an address digit such as `0+30.5` is invalid for the edge normalizer.

For a raw 13-byte response `0+2.48+21.5\r\n`, the exact no-CRC cut is:

```text
AT+DATACUT1=13,2,2~11
```

The cut keeps bytes 2 through 11, producing `+2.48+21.5`. For any other response, calculate the first and last kept byte from the captured byte count. Do not copy the 13-byte line into a probe with a different response layout.

## Multi-segment uplinks

`AT+DATAUP=1` splits one probe response across up to 15 LoRaWAN frames instead of one, for profiles whose value count would otherwise exceed the 51-byte DR0 uplink budget. The field converter split the verified eight-module/two-TriSCAN vector into three 42-character ASCII slices. The registry allows five for the supported worst case of ten TriSCAN modules: ten moisture plus ten VIC values. Every other profile stays single-uplink until it has its own reviewed reason to change.

A device set to `AT+DATAUP=1` must also be set `AT+PAYVER=2`. The codec reads the header layout from the `payver` byte, never from frame length:

- `payver=1`: 3-byte header, `[bat_hi][bat_lo][payver][ascii...]`.
- `payver=2`: 5-byte header, `[bat_hi][bat_lo][payver][count][index][ascii-slice...]` — `count` is the total segment count (1–15) and `index` is zero-based. The current converter produced 42-character slices for the field vector; budget the Sentek profile against that observed size. The reassembler accepts the protocol limit of 15 segments and caps the full sequence at 1500 bytes.

Leaving `AT+PAYVER=1` while `AT+DATAUP=1` is set is a misconfiguration, not a silent failure: the codec reads a 5-byte header as a 3-byte one, so the count and index bytes land inside the ASCII slice as garbage. That garbage fails the normalizer's strict `^([+-]\d+(?:\.\d+)?)+$` grammar and quarantines as `unparseable_sdi12` — it is never mis-assembled into a plausible-looking reading.

The edge buffers segments per device in Node-RED flow context and reassembles them into the single ASCII string the normalizer already consumes. Everything downstream — the normalizer, schema, channels, identify path, GUI, and cloud — never learns that segments existed.

Reassembly uses a 10-minute lazy window: the window is checked only when the next segment for that device arrives, never by a background timer. A device that goes silent mid-sequence leaves its partial buffer in memory (bounded to one buffer, at most `count` slices) until it speaks again or Node-RED restarts. A duplicate index, a count mismatch, an out-of-range index, or the window being exceeded all reset the sequence the same way: one row is dead-lettered as channel `sdi12_segments_incomplete`, reason `unknown_channel`, with `raw_value` in the form `<count>:[<seen indices>]` — for example `3:[0,2]` for a 3-segment sequence missing index 1. No `device_data` row is written for that sequence.

Frames carry no sequence id, so a late-delivered tail segment of one sequence can in principle land in the next sequence's buffer and, if its index and count happen to line up, complete a mixed string that still parses. This is bounded, not excluded: the 10-minute window is well under the default 20-minute `TDC`, so genuine interleaving cannot occur at default timing, and the normalizer's exact-cardinality check still rejects a fixed-count profile whose merged string has the wrong number of values. "Atomic" here means never a partial write and never a cross-sequence merge at default timing — not a cryptographic guarantee.

## Probe recipes

Each section gives a concrete starting command and a cut for the sample response length shown. Unless a section says it is bench-verified, its sample cuts assume address `0`, one decimal place, no CRC, and CR/LF termination. If the capture differs, update the recipe and the corresponding golden vector together.

### Sentek EnviroSCAN

**Bench-verified 2026-08-19** on agrolink-test-01 (device `A8404161D1886837`), so this section is fact, not hypothesis.

- Identity (`0I!`): `012SENTEK  XEPI  139D938D7150000` — address 0, SDI-12 v1.2, vendor `SENTEK`, model `XEPI` (the EnviroSCAN variant; the Sentek manual names `XPI` for EnviroSMART and `IPI` for EasyAG — all three auto-match `SENTEK_ENVIROSCAN`), firmware 1.3.9, then the serial.
- Measurement: `0M!` answers `0tttn` then needs `0D0!` (and `0D1!` above 3 values) — the Dragino's `aD0!` flag (third `AT+COMMANDx` field = `1`) handles that. Live response with the sensor count learned as 5: `+0.000000+0.000000+0.000000+0.104748+0.339201`.
- **Unit:** calibrated EnviroSCAN soil-moisture values are **mm per 10 cm of soil**, numerically identical to VWC percent (1 mm / 100 mm = 1%), and map directly to `vwc_N`. Legacy TriSCAN moisture rows auto-configured with `A=1`, `B=1`, `C=0` instead return normalized scaled frequency. For layout entries marked `TRISCAN`, the normalizer derives VWC with Sentek's default curve `SF = 0.1957 × VWC^0.404 + 0.02852`. This conversion does not apply to EnviroSCAN entries or to VIC.
- Value count is variable per probe build (1–9 per `aM!`, `aM1!` for 10–16): the system learns it per device (`devices.sdi12_value_count`) from the settings modal; frames with a different count quarantine as `sdi12_value_count` until the count is saved.
- TriSCAN Volumetric Ion Content (VIC) uses `0M2!`. The returned VIC group contains only configured TriSCAN modules, in response-position order, after the complete VWC group.

Recipe as deployed (five sensors, cut keeps the sign-delimited values and drops the address):

```text
AT+COMMAND1=0M!,10,1,1
AT+DATACUT1=0,2,2~46
```

#### Eight-depth EnviroSCAN (multi-segment)

Eight depths exceed the single-uplink budget (worst case 3 + 8×9 = 75 bytes against the 51-byte DR0 limit), so the 8-sensor recipe needs [multi-segment uplinks](#multi-segment-uplinks):

```text
AT+PAYVER=2
AT+DATAUP=1
AT+COMMAND1=0M!,10,1,1
```

The eight-module mixed VWC/VIC recipe was bench-verified on 2026-08-28 with TriSCAN modules at response positions 1 and 5:

```text
AT+COMMAND1=0M!,1,1,2
AT+COMMAND2=0D1!,0,0,2
AT+COMMAND3=0D2!,0,0,2
AT+COMMAND4=0M2!,1,1,2
AT+DATACUT1=30,2,2~28
AT+DATACUT2=30,2,2~28
AT+DATACUT3=21,2,2~19
AT+DATACUT4=21,2,2~19
```

The field three-segment payload contained eight VWC values followed by the two
TriSCAN VIC values:

```text
+0.732840+28.27938+37.45271+41.05683+0.969157+46.21098+38.87460+44.38053+1615.877+4237.622
```

In this capture, positions 1 and 5 are the legacy TriSCAN scaled-frequency
outputs. The default curve converts them to `23.81%` and `48.72%` VWC. The
other six values are already calibrated VWC and remain unchanged. The last two
values are nominal, unitless VIC indices; they must not be labelled EC or
assigned an EC unit without a site-specific soil-sampling regression.

This recipe is address-specific. Replace the leading `0` in every command only
when the probe itself has another confirmed SDI-12 address. The Dragino does not
have a separate SDI-12 address to set.

### Delta-T PR2/4

Use the four-depth profile only after the capture shows four VWC values in order.

Sample four-value response: `0+30.5+28.1+25.9+20.0\r\n`.

```text
AT+COMMAND1=0M!,10,1,1
AT+DATACUT1=23,2,2~21
```

### Delta-T PR2/6

Use the six-depth profile only after the capture shows six VWC values in order. PR2/4 and PR2/6 are deliberately not auto-matched by the v1 registry because their identity strings may not distinguish the depth variant.

Sample six-value response: `0+30.5+28.1+25.9+20.0+19.0+18.0\r\n`.

```text
AT+COMMAND1=0M!,10,1,1
AT+DATACUT1=33,2,2~31
```

### ecoTech Tensiomark

The first value is expected to be pF or hPa, depending on the probe configuration. The v1 `TENSIOMARK` profile assumes pF and transforms it to kPa with `10^pF / 10`; a hPa capture requires a profile decision before deployment. The second value is expected to be soil temperature in °C.

Sample response: `0+2.48+21.5\r\n`.

```text
AT+COMMAND1=0M!,5,1,1
AT+DATACUT1=13,2,2~11
```

The expected normalized vector is `+2.48+21.5`, which becomes `swt_1 = 30.2 kPa` and `soil_temp_1 = 21.5 °C`. A response with an extra value is quarantined as `sdi12_value_count`; the writer inserts battery only.

### IMKO TRIME PICO64

The v1 profile expects one VWC value followed by one soil-temperature value. Confirm whether the probe emits those values from `0M!` or requires a concurrent measurement command.

Sample response: `0+30.5+21.5\r\n`.

```text
AT+COMMAND1=0M!,5,1,1
AT+DATACUT1=13,2,2~11
```

### HydraScout

The v1 profile supports two depths with VWC, temperature, and EC at each depth. Its provisional order is `vwc_1`, `soil_temp_1`, `soil_ec_1`, then the same three channels for depth 2. Confirm the EC unit; the target storage unit is µS/cm.

Sample response: `0+30.5+21.5+250.0+28.1+22.0+300.0\r\n`.

```text
AT+COMMAND1=0M!,10,1,1
AT+DATACUT1=35,2,2~33
```

The six-value order and EC conversion are **unverified until bench capture**. More than two HydraScout depths would need [multi-segment uplinks](#multi-segment-uplinks); that stays gated on a HydraScout bench capture, not on missing reassembly support — its six-value order and interleave are unverified at any depth count.

## Identify and downlink frames

Identify is address-agnostic until the edge has a validated address. With no
saved layout, the edge compiles `?!` with `encodeIdentifyFrame('?!')` and sends:

```text
A8 02 3F 21 01 01 00
```

The frame requests a one-second wait, enables the FPort 100 echo, and disables
automatic `D0!`. The Node-RED downlink uses FPort 2; the identity response
arrives later in a Class A receive cycle. After discovery returns exactly one
alphanumeric address, or when a saved layout already validates, the edge compiles
that address's `<address>I!` frame. No runtime path substitutes `0`, `L`, `C`, or
another probe-specific address.

The Sentek recipe compiler owns `0xAF` frames for active converter slots. It
emits one selector-`01` command frame and one selector-`02` cut frame per active
slot, then clears only the unused tail. The browser cannot supply raw `0xAF`
bytes, slot commands, cuts, or queue IDs; Apply and Rollback use only frames
compiled from a validated saved layout.

The `0xAF` value is not an ASCII copy of the console line. For selector `01`,
the command characters run through `!`, followed by the wait, automatic-data,
and validation settings as three raw bytes. Selector `02` carries the four
DATACUT numbers as raw bytes. For example, the vendor's
`AT+COMMAND3=0MC!,1,1,1` frame is
`AF 03 01 07 30 4D 43 21 01 01 01 00`. Encoding the commas and decimal digits
inside the frame can drain the queue successfully while leaving acquisition
non-functional.

`0x01` sets the converter's transmit interval. The documented payload uses three interval bytes after the command code; for example, `01 00 00 3C` requests 60 seconds. Use the console or the normal edge configuration path during commissioning. A 20-minute default is `AT+TDC=1200000`.

## Troubleshooting

### `NULL` on FPort 100

`NULL` on FPort 100 means the probe did not answer a debug or Identify command.
Check probe power, the SDI-12 data line, the configured probe address, and the
command's wait timeout. FPort 100 routes its `datas_sum` to Identify rather than
the periodic telemetry writer, so it writes no periodic telemetry. Discovery
rejects `NULL`, and an addressed Identify response cannot match it.

### Quarantine rows

Normalizer rejects use `reason = 'unknown_channel'`. The `channel` column identifies the cause:

| Channel | Meaning |
|---|---|
| `unparseable_sdi12` | The cut still contains an address character, CRC, whitespace, or other non-numeric text. |
| `sdi12_value_count` | A fixed-cardinality profile received too few or too many values; the frame is rejected atomically. |
| `sdi12_unconfigured` | No probe profile is selected. Battery still writes. |
| `swt_1:out_of_range` or another channel with `:out_of_range` | The parsed value is outside the channel's bounds. |

The edge retains the newest 1,000 quarantine rows. A yellow SDI-12 node status means the writer dead-lettered at least one channel; inspect the channel and raw value before changing a profile.

### FPort 100 debugging

Use the Identify button to send discovery `?!` when no valid layout is saved; a
valid discovery response triggers the addressed `<address>I!` request. With a
valid saved layout, Identify sends that layout's address directly. For another
command, use the documented `0xA8` frame with echo enabled and inspect the raw
FPort 100 string. Capture the full response before changing a cut. A debug
response is not a periodic FPort 2 golden vector until the address and
terminators have been removed.

### `unmatched` identify status

`unmatched` means the edge stored the raw identity but no enabled registry matcher selected a profile. Select the profile manually after checking the probe model and response capture. Do not enable a matcher for an identity that is shared by PR2/4 and PR2/6.

### Missing or partial soil data

Check the profile's expected count and the exact `AT+DATACUTx` output first. The writer is intentionally narrow: a malformed fixed-cardinality frame produces battery-only data, while a valid variable-count `GENERIC_VWC` frame maps values in order and leaves unused channels null.

## References

- [Dragino SDI-12-LB/LS manual](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/)
- [Dragino SDI-12 decoder source](https://github.com/dragino/dragino-end-node-decoder/tree/main/SDI-12-LB)
- [ecoTech Tensiomark](https://www.ecotech.de/en/product/tensiomark)
- [HydraScout](https://www.hydrascout.co/?lang=en)
