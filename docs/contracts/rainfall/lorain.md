# LoRain rainfall measurement contract

This contract states what one Aqua-Scope LoRain frame proves about rainfall: which frames carry an additive amount, which interval each amount covers, and when a period of silence counts as measured dry. Ingestion, history, cards, exports and advice consumers cite the truth-table rows `T1` to `T14` by ID. The replay fixtures in `scripts/fixtures/lorain-rain/` pin every row, and `scripts/test-lorain-rain-contract.js` replays them through the shipped codec.

## Scope

The contract covers devices of type `AQUASCOPE_LORAIN`. They uplink on FPort 10 or on the legacy FPort 2, and ChirpStack decodes both with `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js` (bcm2709 carries a byte-identical copy). The codec emits `rain_tips_delta` (raw tips), `rainlevel` (the same raw value under the vendor's name) and `rain_mm_delta` (tips × 0.5 mm). It also decodes the configuration block `0x04` (`conf_heartbeat`, `conf_heavyrain`, `conf_interval`, `conf_temperature_calibration`), the firmware block `0x0A` (`fw_version`), the hardware block `0x03` and the heavy-rain alarm block `0x0B` (`alarm_status`, `alarm_type`, `alarm_value`).

Other rain instruments have their own rules; see `README.md` in this directory.

## Reference configuration

The owner of the first production installation stated this configuration on 2026-10-09:

- The gauge wakes every 15 minutes and sends a report only when it counted at least one tip in that window. The report carries the tips of that window.
- A window without tips produces no frame. Silence is the dry signal.
- A heartbeat frame with zero tips goes out every 4 hours.

The pinned vendor source below produces exactly this behaviour with `conf_interval` = 900 and `conf_heartbeat` = 16, because that revision counts the heartbeat in wake cycles (16 × 900 s = 4 h). Both values are confirmed only when the device's own `0x04` blocks report them. Row `T2` covers configurations that also send zero reports when dry; the reference configuration does not produce it.

## Pinned vendor source

The reviewed source is revision `04ac8e3b67d7be54976a2f463e935a03cdbbab64` of `github.com/aqua-scope/lorain`, file `lorain.ino`. That revision behaves as follows.

- **Ordinary loop.** The device wakes every `conf_interval` seconds (default 900). It transmits when the tip counter is non-zero, or when `conf_heartbeat` wakes have passed since the last dry transmission (default 4, one hour). It encodes the tip count, clears the counter, then requests transmission. Clearing does not wait for delivery, so a lost frame loses the tips of its window, and no later frame recovers them. Because every non-zero count is sent and cleared at the next wake, an ordinary report's tips fall inside the one wake window that ends at the report.
- **Heartbeat counter.** The wake counter resets only after a dry transmission. After wet reports the next dry transmission can therefore come earlier than a full heartbeat period, never later.
- **Default heartbeat.** The source default is one hour (`conf_heartbeat` = 4 at 900 s). The current vendor manual describes six hours. Neither default proves the configuration of an installed device.
- **Button.** A button press encodes and sends the current count through a different path that does not clear the counter. The next ordinary report repeats those tips. The frame carries no marker that tells it apart from an ordinary report.
- **Heavy-rain alarm.** When two tips arrive closer together than `conf_heavyrain` seconds, the interrupt handler sends an `0x0B` block at once: status 1, type 3, value = seconds between the last two tips. The clearing block (status 0) is sent from the interrupt or appended to the next ordinary report. The tips themselves stay in the counter and reach the next ordinary report. An alarm is event information, never an independent amount.
- **Configuration blocks.** The device sends a `0x04` block only in reply to a downlink that asks for that configuration index. The reply rides in the next uplink.
- **Firmware block.** After each join the first uplink carries `0x0A` and `0x03` blocks. The `0x0A` value is the build date as `yymmdd` (for example 241015); it identifies a build, not a source revision.
- **Port.** This revision transmits on FPort 2. A device that reports on FPort 10 runs a different build, whose counter behaviour this source does not establish.
- **Restart.** The counter starts at zero after boot. Tips counted but not yet sent before a restart are lost.

This is evidence about that revision, not proof of the firmware installed on any device (owner decision D8). The installed build is observable from frames: the `0x0A` value, the FPort and the `0x04` values. The owner's statement that the gauge runs stock vendor firmware is the one item no frame can supply.

## Quantities

| Concept | Rule |
|---|---|
| Amount | `rain_mm_delta`, millimetres received in a distinct valid report. Preserve raw integer tips (`rain_tips_delta`) and the 0.5 mm conversion. Never average amounts when combining reports. |
| Interval | Separate measurement start/end from reception time and time since the previous message. Unknown measurement bounds stay null. Under the pinned revision an ordinary report covers the `conf_interval` seconds that end at the report. |
| Rate | Amount / verified measurement duration in hours. Label it `Average rain rate` and expose its averaging window. Never infer a fixed 15-minute duration solely from the default configuration. A 15-minute window is verified only after `conf_interval` = 900 has been recorded from the device's own `0x04` block and the device has been promoted (see below). |
| Legacy rate | Existing elapsed-between-reports values (`rain_mm_per_hour`) remain auditable as legacy estimates. Hide them from default views, keep the key, and do not relabel historical numbers as corrected measurements (owner decision D4). |
| Ten-minute value | A rescaled rate is not a measured ten-minute amount. `rain_mm_per_10min` is a legacy estimate, hidden from default views, key kept (D4). |
| Day | Farm-local midnight to the next midnight in the zone's configured IANA timezone, including 23/25-hour DST days. Browser and gateway timezones cannot change the selected farm day. |
| Zero | A valid zero report establishes zero recorded tips only over its supported interval. It does not establish an entire dry day or absence of sub-tip precipitation. Under the reference configuration silence between two continuous frames is the zero (row `T13`). |
| Coverage | `complete`, `partial`, or `unknown` for an explicit requested period, with reason codes. Track freshness separately; an old complete period stays complete. The current day is always described as "so far." |
| Total | Show the observed amount together with coverage. Missing observations give null, not zero. Never promote partial or unknown observed sums to a complete-day measurement. |
| Source | Identify the instrument. When two gauges are eligible for one zone, the zone is in an ambiguity state until the operator selects one (owner decision D1). Two gauges observing the same field must never be added together. |

## Promotion from received-only to verified

Every LoRain observation starts as received only: its amount is kept and shown, but its interval basis is `unknown` and it cannot enter a certified total (owner decision D9). The backend promotes a device's observations for a period without any manual step once both conditions hold:

1. it has recorded `conf_interval` and `conf_heartbeat` from the device's own `0x04` blocks, and
2. fCnt continuity holds over the period: one session (same `devAddr`, no fCnt reset) and no missing fCnt value. Alarm, button and configuration frames take fCnt values too, so continuity counts every frame of the session.

The truth table has one interval-basis column for each state. A device's observations move from the "installed revision unknown" column to the "pinned revision proven installed" column automatically once those config frames and that continuity have been observed. Promotion is per period: a later gap or session reset returns the affected period to the left column.

Under the pinned revision a configuration value reaches the gateway only as a reply to a downlink query. A device that is never queried therefore stays received only; whether and when the configuration is read is an operations decision outside this contract.

**Wake-grid assumption.** Consecutive loop frames of one session are spaced by whole multiples of `conf_interval`, so a report's window is the `conf_interval` seconds before it. The pinned loop sleeps `conf_interval` seconds after each wake's work, so the grid drifts by the awake time (about 0.2 s plus radio time per wake). This is an assumption to verify from frame timing on installed devices. The fixtures keep this spacing and the contract test checks it to within 60 s.

## Truth table

| ID | Frame | Additive amount? | Interval it covers | Interval basis (installed revision unknown) | Interval basis (pinned revision proven installed) | Counted in certified totals? |
|---|---|---|---|---|---|---|
| `T1` | Ordinary report, tips > 0 | Yes | Since the previous counter clear: the `conf_interval` window that ends at the report | `unknown` | `protocol_verified` only with recorded `conf_interval` and continuity | Only with continuity |
| `T2` | Ordinary report, tips = 0. Other configurations only; the reference configuration sends nothing when dry | Yes, as zero | Same as `T1` | `unknown` | `protocol_verified` under the same conditions | Yes, as zero over its interval only |
| `T3` | Dry heartbeat (tips = 0, after `conf_heartbeat` dry wakes; 4 h in the reference configuration) | Yes, as zero | Its own wake window; the silent span before it follows `T13` or `T14` | `unknown` | `protocol_verified` with recorded `conf_heartbeat` | Yes, as zero over its interval only |
| `T4` | Missed frame (fCnt gap within one session) | No amount for the lost frame | None: the lost frame cleared the counter, so the next frame does not recover the lost interval | `unknown` | `unknown` for the gap and for the first frame after it | No; coverage reason `frame_gap` |
| `T5` | Duplicate delivery (same `deduplicationId`) | Not again | That of the first delivery | As the first delivery | As the first delivery | Counted once; reason `duplicate` on the repeat |
| `T6` | Delayed distinct frame (older `time`, new `deduplicationId`, fCnt that fits the session order) | Yes, once | Its own window; the affected periods are recomputed | `unknown` | `protocol_verified` once the fCnt chain around it is continuous | Yes, after recomputation |
| `T7` | Restart or rejoin (fCnt resets, `devAddr` may change) | The reset implies no amount; the first frame after it carries tips counted since boot | First frame: from boot, whose time is not observed | `unknown` | `unknown` for the first frame; continuity restarts in the new session | Not across the reset; reason `session_reset` |
| `T8` | Heavy-rain alarm frame (`0x0B` without a rain block) | No: `alarm_value` is seconds between tips, an event | None | `unknown` | `unknown` | No; reason `alarm_event` |
| `T9` | Alarm followed by the ordinary report that carries the same tips | Only the ordinary report | That of the ordinary report | As `T1` | As `T1` | The ordinary report only |
| `T10` | Button-triggered report | No: the next ordinary report repeats its tips | From the last clear to the press | `unknown` | `unknown`; recognised only by its time off the wake grid | No; reason `overlap_unqualified`. The next ordinary report keeps its amount but is not certified either |
| `T11` | Configuration change mid-day (`0x04` block whose value differs from the recorded one) | The frame's own amount follows `T1` or `T3` | Interval transition | `unknown` | `unknown` until the new interval has been observed twice between consecutive frames | Not during the transition; reason `config_change` |
| `T12` | Invalid tip count (null, string, non-finite, negative, fractional) | No: rejected measurement | None | `unknown` | `unknown` | No; diagnostic evidence retained; reason `invalid_tips` |
| `T13` | Silence between two frames with continuous fCnt in one session | Yes, as zero | From the earlier frame to the start of the later frame's window; at most `conf_heartbeat` × `conf_interval` (4 h in the reference configuration) | `unknown` | `protocol_verified` | Yes, as zero over the span |
| `T14` | Silence between two frames with an fCnt gap | No: the missing frame may have been a rain report whose tips are lost | The span, unresolved | `unknown` | `unknown` | No; reason `frame_gap` |

Values of `interval_basis`: `protocol_verified` (bounds follow from the pinned protocol and recorded configuration), `reception_gap` (only the time between two received frames is known; this is the basis of the legacy rate and never certifies), `unknown`. Values of `frame_kind`: `ordinary`, `heartbeat_zero`, `button`, `alarm`, `config`, `status`. Under the reference configuration a zero-tip frame without an alarm block is a heartbeat.

Rows `T4`, `T10` and the first frame after a rejoin in `T7` stay `unknown` even after promotion, although the pinned protocol bounds those frames' own windows. The conservative choice keeps a period with a gap, a reset or an unidentified button press out of certified totals.

## Coverage rule

A farm day is `complete` only when the frames covering it (rain reports, heartbeats and the frames that bound each silent span) form one chain with no fCnt gap and no session reset, and a frame of that chain exists at or after the day end. Under the reference configuration that frame arrives within 4 hours after the day end. Otherwise the day is `partial` or `unknown`, with reason codes. A continuous span longer than `conf_heartbeat` × `conf_interval` plus 60 s contradicts the recorded configuration and is `unknown` with reason `config_mismatch`.

`complete` requires known, non-overlapping accepted intervals covering the entire requested [start,end) period, under recorded configuration and source policy, without delivery/session gaps. Amount allocation to that period must also be proven: a crossing interval cannot certify its amount or coverage without tip timing or another protocol-proven allocation. Assess an ongoing day against its explicitly reported observation cutoff, never the unobserved future. `unknown` takes precedence if measurement bounds, boundary allocation, continuity, overlap or source cannot be established; `partial` applies when interval evidence is usable but a known part of the requested period is uncovered. A late event may improve coverage after deterministic recomputation. Preserve reason codes rather than reducing every case to one percentage.

An amount whose measurement interval crosses an hour/day boundary cannot be divided exactly without tip timing. Keep it as an interval observation with uncertain allocation. A report-date grouping may show it as "received in this period," explicitly separate from a measured period total. Do not prorate uniformly or place all of it at the endpoint while claiming an exact hourly/day amount. A timestamp exactly at midnight requires the same interval check.

A zero span or zero heartbeat that crosses midnight splits exactly (zero on both sides), so only a non-zero window across the boundary blocks certification; its reason code is `boundary_allocation`.

| Reason code | Meaning |
|---|---|
| `received_only` | The device has not been promoted for this period. |
| `frame_gap` | An fCnt value is missing inside one session. |
| `session_reset` | fCnt restarted or `devAddr` changed. |
| `duplicate` | A repeat of an already counted `deduplicationId`. |
| `alarm_event` | An alarm frame; event information only. |
| `overlap_unqualified` | A button report whose tips the next ordinary report repeats. |
| `config_change` | A recorded configuration value changed; the new interval is not yet observed twice. |
| `config_mismatch` | Frame spacing contradicts the recorded configuration. |
| `invalid_tips` | The tip count is not a non-negative integer. |
| `boundary_allocation` | A non-zero window crosses the period boundary. |
| `ongoing` | The period has not ended; the total is "so far". |

## Limitations

- Precipitation phase: Open-Meteo `precipitation` includes rain, showers and snow water equivalent. A provider value is not liquid rain during snowfall or frost, and a tipping bucket under snow reports melt later, not when the snow fell.
- Measured rain is not effective root-zone water. The gauge measures precipitation at its exposure; infiltration, runoff and interception are not measured.
- Physical calibration and exposure are commissioning work: a level and clean collector, a known-volume check and, where possible, comparison with a colocated reference. Software tests do not certify gauge accuracy.
- A bucket-factor change is recorded with its date and is never applied retroactively to old counts.
