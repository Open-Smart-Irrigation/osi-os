# Kaba100 Chameleon 1 I2C Outage Analysis

Date: 2026-06-28  
Device: Chameleon 1, `A84041A75D5E7CFB`  
Gateway: Kaba100, `0016C001F11766E7`  
Final tested array ID: `28DE7EC80B0000E2`

## Executive Summary

Chameleon 1 did not primarily suffer from a LoRaWAN, server-sync, calibration, or soil-probe outage. The dominant outage mode was a device-side I2C acquisition failure: uplinks kept arriving, but the Chameleon firmware reported `i2c_missing=1` and therefore the SWT values were unavailable.

The most likely root cause is the original power/interface topology:

- The Chameleon I2C board was powered from the LSN50 switched 5 V output.
- SDA/SCL were connected directly to the LSN50 STM32 I2C pins.
- The Chameleon board has pull-ups to VCC on SDA/SCL. Supplying VCC with 5 V therefore pulls the I2C bus toward 5 V.
- When switched 5 V is off, SDA/SCL remain connected and can back-power the board into a partial brownout state.

This matches the field measurements exactly: SDA/SCL rose to about 4.6 V during measurement when powered from switched 5 V, and when the 5 V rail was off the board sat at about 1.4-1.5 V on VCC and about 1.9-2.0 V on SDA/SCL. After moving the Chameleon board to LSN50 VDD, all rails stayed around 3.6 V and the I2C fault stopped in the refreshed observation window.

Recommendation: keep the Chameleon board powered from the same 3.3-3.6 V rail as the LSN50 I2C bus, or add a proper bidirectional I2C level shifter plus power isolation if 5 V switching is required.

## Data Sources

Sources used:

- Kaba100 local SQLite DB at `/data/db/farming.db`
- Server-export analysis artifacts in `analysis/chameleon1_i2c_20260628/`
- Firmware notes in `../chameleon-integration.md`
- Hardware/protocol notes in `../hardware/chameleon-reference.md`
- Custom LSN50 firmware source in `/home/phil/Repos/LoRa_STM32-claude`
- Live multimeter observations made during the 2026-06-28 field test

The current Kaba100 local DB snapshot for this device starts at `2026-06-24T21:49:57Z`. The earlier server export covers `2026-06-17T00:02:21Z` to `2026-06-28T18:19:57Z`.

## Firmware and Data Path

The Chameleon board is an ATtiny814 I2C slave at address `0x08`, sampled by the LSN50 STM32 over I2C at 400 kHz. The LSN50 firmware probes the address, triggers a measurement, polls status, then reads temperature, compensated resistances, raw resistances, and the DS18B20 array ID.

Relevant firmware behavior:

- `i2c_missing` is set when the I2C address probe fails or a later I2C read fails.
- `timeout` is set when the board is reachable but does not become ready in time.
- `comp_pending` is separate and means raw and compensated resistances matched before compensation settled.
- The first MOD=3 ADC fields are legacy stock LSN50 fields and are not the Chameleon soil-water-tension data.

Therefore rows can arrive on schedule while still being unusable for SWT if the I2C acquisition failed.

## Data Completeness and Outage Pattern

### Server Export, 2026-06-17 to 2026-06-28 18:19 UTC

From `analysis/chameleon1_i2c_20260628/chameleon1_i2c_summary.txt`:

| Metric | Value |
|---|---:|
| Total rows | 3379 |
| Good rows | 1886 |
| I2C-missing rows | 1493 |
| I2C-missing share | 44.2% |
| Other invalid rows | 0 |
| Rows with SWT | 1886 |
| Max cadence gap | 43.4 min |
| Cadence gaps > 7.5 min | 3 |

The key finding is that most bad periods were not missing uplinks. The node still transmitted, but the payload carried the fixed diagnostic signature `i2c_missing=1`, `timeout=0`, no temp fault, no ID fault, and no open-channel flags.

Largest I2C-missing blocks in the server export:

| Start UTC | End UTC | Duration | Rows |
|---|---|---:|---:|
| 2026-06-24 06:20 | 2026-06-26 06:44 | 48.41 h | 581 |
| 2026-06-18 19:32 | 2026-06-20 14:27 | 42.91 h | 515 |
| 2026-06-27 00:50 | 2026-06-27 07:40 | 6.83 h | 83 |
| 2026-06-22 19:45 | 2026-06-23 01:35 | 5.83 h | 71 |
| 2026-06-28 03:25 | 2026-06-28 08:09 | 4.75 h | 58 |

The complete block list is in `analysis/chameleon1_i2c_20260628/chameleon1_i2c_blocks.csv`. The visual timeline is in `analysis/chameleon1_i2c_20260628/chameleon1_i2c_timeline.png`.

### Refreshed Gateway Data, 2026-06-24 to 2026-06-28 21:59 UTC

The local gateway DB had 1298 Chameleon rows for this refreshed window:

| Metric | Value |
|---|---:|
| Total rows | 1298 |
| I2C-missing rows | 726 |
| I2C-missing share | 55.9% |
| Timeout rows | 0 |
| Data-invalid rows | 726 |
| `comp_pending` rows | 6 |
| Canonical `device_data` rows with SWT | 559 |
| Canonical `device_data` rows without SWT | 739 |

There were no cadence gaps over 20 minutes in this refreshed local window. This again supports a sensor-side acquisition fault rather than an uplink or sync outage.

### After Moving the Board to VDD

After connecting the Chameleon board to LSN50 VDD, the local DB showed:

| Window | Rows | I2C missing | Data invalid |
|---|---:|---:|---:|
| 2026-06-28 21:29:20 UTC to 21:59:17 UTC | 31 | 0 | 0 |

The latest checked canonical `device_data` row was `2026-06-28T21:59:17Z` with SWT values `7.42`, `6.79`, `3.10` and battery `3.6 V`.

## Physical Test Timeline

Observed during the 2026-06-28 live field test:

1. Switched 5 V topology, original I2C board and array connected:
   - Uplinks arrived, but rows repeatedly reported `I2C_MISSING`.
   - VCC was 5 V during measurements, then floated around 1.4-1.5 V.
   - SDA/SCL were around 1.9-2.0 V while idle/off.
   - SDA/SCL rose to about 3.9-4.6 V during measurement.

2. Chameleon array disconnected, I2C board still connected:
   - Fault persisted, so the soil array itself was not the primary cause.

3. Test array connected:
   - The fault pattern was still controlled by the board/power/bus behavior, not by the specific soil probe.

4. Second I2C board tested:
   - Similar voltage behavior appeared.
   - With only VCC connected and no SDA/SCL, the rail rose weakly during measurement and then decayed toward zero.
   - With SDA/SCL connected, VCC again stayed around 1.4 V when off.
   - This is strong evidence that the off-state voltage came from bus back-powering through SDA/SCL.

5. Chameleon board moved to LSN50 VDD:
   - VCC, SDA, and SCL all remained around 3.6 V.
   - I2C acquisition recovered.
   - Subsequent rows were clean on `i2c_missing`, `timeout`, and `data_invalid`.

## Root Cause Analysis

### Confirmed Symptom

The outage is not primarily a missing-uplink outage. It is an I2C readout outage:

- Chameleon rows exist in the database.
- Frame counters advance during most fault windows.
- Battery remains normal at about 3.6 V.
- `timeout=0`, so the firmware is usually not reaching a measurement wait timeout.
- `i2c_missing=1`, so the STM32 cannot reliably talk to the Chameleon slave at `0x08`.

### Most Likely Root Cause

The Chameleon board was powered from switched 5 V while its I2C bus was directly connected to a 3.3-3.6 V STM32 master.

The board can be supplied at 5 V in the generic Arduino example, but that does not mean the LSN50 can safely use it at 5 V without level shifting. Because SDA/SCL pull-ups go to VCC, using 5 V VCC raises the I2C high level toward 5 V. This is valid for a 5 V Arduino-style master, but not for the LSN50 STM32 bus.

When the switched 5 V output turns off, SDA/SCL are still attached. The measured idle voltages show the Chameleon board is then partially powered through the I2C lines. This leaves the ATtiny/I2C peripheral in an undefined state between true off and valid power. That explains why the fault is intermittent: sometimes the slave wakes cleanly enough to ACK, sometimes it stays brownout-latched or bus-stuck and the STM32 sees a NACK/read failure.

### Why the Fault Came and Went

The intermittent behavior is expected under this topology:

- A real open wire would usually fail consistently.
- Moisture or corrosion would not be expected to disappear immediately after moving only the supply rail.
- The same pattern appeared with another I2C board.
- The fault changed immediately when the power topology changed.
- Frame-counter resets and recovery after power events fit a board-state reset problem.

The board likely needed a clean reset or stable rail. Switched 5 V plus bus back-power prevented a clean off-state.

## Hypotheses Considered

| Hypothesis | Evidence | Conclusion |
|---|---|---|
| Server sync or cloud mirror issue | Local rows contained the same diagnostic flags; earlier local/server checks matched. | Not root cause. |
| LoRaWAN/radio outage | Rows continued to arrive during fault windows. | Not root cause for the main issue. |
| Calibration missing | Fault rows had `i2c_missing`; good rows produced raw/comp resistance and canonical SWT. | Not root cause. |
| Soil probe disconnected/open | Open-channel flags were not the dominant bad-row signature. | Not root cause. |
| One bad I2C board | Similar behavior with a second board. | Unlikely. |
| Moisture on board | No visible moisture; behavior changed with power rail. | Possible aggravator, not primary cause. |
| Firmware timeout too short | `timeout_rows=0` in refreshed data; fault is probe/read failure. | Not primary cause. |
| Switched 5 V mixed with direct 3.3 V I2C | Predicts 5 V-ish SDA/SCL, off-state back-power, intermittent NACKs, recovery on VDD. All observed. | Most likely root cause. |

## SWT Storage Note

For operational analysis, use different tables for different questions:

- `chameleon_readings`: protocol-level diagnosis, including `f_cnt`, raw payload, `status_flags`, `i2c_missing`, `timeout`, raw/comp resistances, and array ID.
- `device_data`: canonical SWT values used by the application and cloud mirror.

In the refreshed local DB, `chameleon_readings.swt_1..3` remained NULL even for clean calibrated rows, while `device_data.swt_1..3` contained the expected SWT values. This should be clarified or fixed separately, but it does not change the hardware root-cause conclusion because the raw/comp readings and `device_data` SWT recover after VDD wiring.

## Recommended Corrective Actions

1. Keep the current wiring for ongoing soak tests:
   - Chameleon VCC to LSN50 VDD.
   - Common GND.
   - SDA/SCL directly connected only if both sides share the same 3.3-3.6 V logic rail.

2. Do not connect the Chameleon board to switched 5 V with direct SDA/SCL to the LSN50.

3. If 5 V supply is required:
   - Add a proper bidirectional I2C level shifter.
   - Keep pull-ups on the LSN50 side to 3.3-3.6 V.
   - Prevent back-powering when the 5 V rail is off.
   - Ensure the Chameleon side gets a real power-off reset or stays continuously powered.

4. If low-power switching is required:
   - Switch a compatible 3.3 V rail, not 5 V, or isolate SDA/SCL while the slave is unpowered.
   - Add a discharge path or defined pull-down so VCC cannot float at 1.4-1.5 V.
   - Verify with a multimeter that off-state VCC is truly near 0 V and SDA/SCL are not feeding the board.

5. Add a hardware bring-up checklist:
   - Idle VCC/SDA/SCL voltage.
   - Measurement VCC/SDA/SCL voltage.
   - `i2c_missing` count after 30-60 minutes.
   - `timeout` count.
   - `device_data.swt_*` presence.
   - Array ID stability.

6. Add firmware hardening later, after the hardware topology is fixed:
   - Optional I2C bus recovery on NACK, such as deinit/reinit and SCL clock pulses.
   - More granular status bits for probe failure versus later read failure.
   - A boot-time or periodic diagnostic counter for Chameleon acquisition failures.

## Follow-Up Checks

Run a 24-48 hour soak on VDD wiring and check:

- Zero or near-zero `i2c_missing` rows.
- No large cadence gaps.
- Stable array ID `28DE7EC80B0000E2`.
- Stable SWT in `device_data`.
- Battery trend, because VDD continuous power may increase current draw.

Suggested gateway SQL:

```sql
SELECT
  MIN(recorded_at) AS first_row,
  MAX(recorded_at) AS latest_row,
  COUNT(*) AS rows,
  SUM(i2c_missing) AS i2c_missing_rows,
  SUM(timeout) AS timeout_rows,
  SUM(data_invalid) AS data_invalid_rows,
  SUM(comp_pending) AS comp_pending_rows
FROM chameleon_readings
WHERE upper(deveui)=upper('A84041A75D5E7CFB')
  AND recorded_at >= '2026-06-28T21:29:00Z';
```

```sql
SELECT recorded_at, swt_1, swt_2, swt_3, bat_v
FROM device_data
WHERE upper(deveui)=upper('A84041A75D5E7CFB')
ORDER BY recorded_at DESC
LIMIT 20;
```

## Conclusion

The root cause is best explained as an electrical integration fault: switched 5 V power was used with a direct 3.3-3.6 V I2C bus, causing both over-voltage bus highs during measurement and back-powered brownout states when switched 5 V was off. The board's 5 V compatibility applies to the board supply in a compatible bus environment; it does not make direct 5 V-pulled I2C safe for the LSN50 STM32.

The VDD wiring change is the correct immediate mitigation and should be treated as the baseline for the next soak test.
