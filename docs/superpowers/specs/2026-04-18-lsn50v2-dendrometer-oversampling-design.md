# LSN50V2 Dendrometer Oversampling — Design Spec

**Date:** 2026-04-18  
**Status:** Approved  
**Scope:** `LoRa_STM32` firmware + `osi-os` decoder

---

## Overview

Improve Dragino LSN50V2 dendrometer measurement quality in `MOD=3` by replacing the current small fixed ADC sample set with a paired oversampling pipeline and a ratiometric decoder path.

The new `MOD=3` behavior is dendrometer-specific:

- switched `+5V OUT` powers the potentiometer before measurement
- `PA0` is the dendrometer signal channel
- `PA1` is the dendrometer reference channel
- both channels are sampled repeatedly and averaged
- raw averaged counts are transmitted
- the decoder computes the ratio from the two averaged channels

This change intentionally extends `MOD=3` and requires a decoder update. Other modes must remain unchanged.

---

## Current State

### Firmware

Current `MOD=3` behavior lives in:

- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`
- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`

The current flow:

1. enables `PWR_OUT`
2. waits `AT+5VT`
3. reads analog channels using small 6-sample groups
4. converts readings into millivolt-like values using battery scaling
5. packs the existing `MOD=3` payload

Current `MOD=3` payload shape is not suitable for the new requirements because it mixes legacy fields and does not express paired oversampled raw counts cleanly.

### Decoder

The current raw LSN50 decode path lives in:

- `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`

`decodeRawAdcPayload()` currently assumes the legacy `MOD=3` byte layout and derives `adcCh0V`, `adcCh1V`, and `adcCh4V` from that format.

---

## Hardware Mapping

Target hardware: Dragino LSN50V2, EU868

Potentiometer wiring:

- Brown -> switched `+5V OUT`
- Blue -> `GND`
- Yellow -> signal

Target ADC mapping:

- `PA0` / ADC channel 0: dendrometer signal
- `PA1` / ADC channel 1: dendrometer reference

Analog front-end:

- signal divider: `3.9k / 3.9k`
- reference divider: `3.9k / 3.9k`
- signal RC filter: `1k` series + `100nF` to `GND`
- no RC filter on reference

For this feature, `PA4` is not part of the `MOD=3` dendrometer measurement path.

---

## Goals

- Improve dendrometer measurement stability using oversampling
- Preserve low-power behavior by staying inside the existing switched `5V` measurement window
- Keep firmware changes localized and readable
- Preserve AT command compatibility
- Avoid increasing LoRa airtime unnecessarily
- Keep the decoder-compatible data model in `osi-os` by updating the shared LSN50 helper instead of forking the ingest pipeline

---

## Non-Goals

- No new mm calibration in firmware
- No new AT commands in this first pass
- No change to non-`MOD=3` sensor modes
- No V3-specific board support in this first pass, beyond leaving a clean abstraction boundary for later

---

## Architecture

### 1. Board Layer

Board-facing operations remain thin and hardware-specific.

Responsibilities:

- enable and disable `PWR_OUT`
- perform one raw ADC conversion on a selected channel
- perform millisecond delays through the existing HAL path

This layer must not contain averaging, validity, ratio, or payload logic.

### 2. Measurement Layer

Add a dedicated dendrometer module:

- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`
- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`

Responsibilities:

- power on dendrometer supply
- wait for analog settle
- sample signal and reference as a pair
- accumulate with integer arithmetic
- average raw counts
- mark validity and error flags
- always power off before returning

Primary API:

- `read_adc_avg(...)`
- `measure_dendrometer(...)`

### 3. Conversion Layer

Keep conversion minimal and local to the dendrometer module.

Responsibilities:

- check reference validity
- compute ratio only for internal validation support if needed
- avoid divide-by-zero and non-finite results

The transmitted payload does **not** include `ratio_scaled`.

### 4. Payload Layer

`main.c` remains the single place that builds LoRa uplinks.

Only the `mode == 3` payload branch changes. Other branches stay behaviorally unchanged.

### 5. Decoder Layer

Update `osi-os` shared helper:

- `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`

Responsibilities:

- detect the new `MOD=3` raw frame
- decode averaged raw counts and flags
- preserve compatibility return fields for downstream logic where possible
- continue computing `dendro_ratio` from the two channels in software

---

## Measurement Parameters

Initial compile-time constants:

- `DENDROMETER_SETTLE_TIME_MS = 50`
- `DENDROMETER_SAMPLE_COUNT = 50`
- `DENDROMETER_SAMPLE_DELAY_MS = 1`
- `DENDROMETER_REF_MIN_RAW = 128`

These live in `dendrometer.h` so they can be tuned later without changing call sites.

Expected timing budget for `MOD=3`:

- settle: `50 ms`
- sample loop: about `50 ms` plus ADC conversion overhead
- total dendrometer-specific time: comfortably within the existing default `5V` active window

`AT+5VT` remains unchanged and continues to control the overall `5V` power-on window for the measurement cycle.

---

## Measurement Flow

`measure_dendrometer()` performs the following sequence:

1. enable switched `5V`
2. wait `DENDROMETER_SETTLE_TIME_MS`
3. loop `DENDROMETER_SAMPLE_COUNT` times
4. read `PA0` raw ADC count
5. read `PA1` raw ADC count
6. accumulate both counts into `uint32_t` sums
7. wait `DENDROMETER_SAMPLE_DELAY_MS`
8. divide once at the end to produce averaged raw counts
9. mark measurement invalid if the averaged reference is too small
10. disable switched `5V`
11. return averaged counts plus flags

Loop arithmetic must be integer-only.

No float operations are allowed inside the sampling loop.

---

## Dendrometer Data Model

Add a dedicated measurement result struct in `dendrometer.h`.

Required fields:

- `uint16_t adc_signal_avg_raw`
- `uint16_t adc_reference_avg_raw`
- `uint8_t valid`
- `uint8_t flags`

Initial flag definitions:

- bit `0`: measurement valid
- bit `1`: reference too low
- bit `2`: ratio/division skipped
- bit `3`: reserved for future sampling/runtime fault
- bit `4-7`: reserved

Behavior:

- if reference is invalid, raw averaged counts are still returned
- `valid = 0` when reference is too low
- no firmware-side calibration to millimeters is applied

---

## MOD=3 Payload Format

New `MOD=3` payload is 8 bytes:

| Byte | Field | Type | Notes |
|---|---|---|---|
| 0-1 | `battery_mv` | `uint16` big-endian | existing battery source, full mV |
| 2-3 | `adc_signal_avg_raw` | `uint16` big-endian | averaged raw ADC counts from `PA0` |
| 4-5 | `adc_reference_avg_raw` | `uint16` big-endian | averaged raw ADC counts from `PA1` |
| 6 | `status_mode_byte` | `uint8` | keeps existing LSN50 mode/status bit semantics |
| 7 | `dendro_flags` | `uint8` | new measurement validity/error flags |

This intentionally drops:

- legacy `oil` field from `MOD=3`
- legacy `PA4` analog field from `MOD=3`
- firmware-side `ratio_scaled`
- optional SHT payload bytes from `MOD=3`

Rationale:

- keeps payload compact
- avoids duplicated information
- makes the frame dendrometer-specific and unambiguous
- lets the decoder compute ratio from the transmitted averages

---

## Decoder Behavior

`decodeRawAdcPayload()` in `osi-dendro-helper` must branch on the new `MOD=3` layout and return:

- `batV`
- `modeCode`
- `modeLabel`
- `adcSignalAvgRaw`
- `adcReferenceAvgRaw`
- `measurementValid`
- `referenceTooLow`
- `divisionSkipped`

For downstream compatibility, it should also expose:

- `adcCh0V`
- `adcCh1V`
- `adcCh4V = null` for the new `MOD=3` frame

These compatibility fields may be derived from the raw counts using the transmitted battery voltage and the existing divider assumptions, so the current ratio-based helper functions continue to work with minimal churn.

`ratio_scaled` is not decoded because it is not transmitted.

The shared helper remains responsible for:

- ratio calculation
- calibration-based mm conversion
- validity propagation into `device_data`

---

## File Changes

### Firmware repo: `LoRa_STM32`

Modify:

- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`
- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h`
- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`

Add:

- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`
- `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`

### Edge decoder repo: `osi-os`

Modify:

- `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`

Optional documentation follow-up during implementation:

- `README.md` or device-specific docs if a durable firmware payload note is useful

---

## Testing Strategy

There is no checked-in STM32CubeIDE project or embedded unit-test harness in the Dragino repo, so verification must be split:

### Firmware helper tests

Add a small host-side C test target for the pure dendrometer helper logic, covering:

- average computation
- invalid reference handling
- flag generation
- payload packing for the new `MOD=3` frame

These tests should use local `gcc` and avoid HAL dependencies.

### Firmware integration checks

Manual integration review in the embedded source should confirm:

- only `MOD=3` behavior changed
- `AT+5VT` behavior is preserved
- `PWR_OUT` is always disabled after measurement
- non-`MOD=3` code paths are unchanged

### Decoder verification

Update or add a fixture-based check in `osi-os` for the new 8-byte `MOD=3` payload so:

- raw averages decode correctly
- validity flags decode correctly
- ratio is still derived in `osi-dendro-helper`
- downstream dendrometer metrics still populate

---

## Risks And Mitigations

### Payload compatibility break

Risk:

- legacy `MOD=3` decoders will misread the new frame

Mitigation:

- explicitly update `osi-dendro-helper`
- keep `modeCode` detection behavior intact through the status byte

### Reference threshold too aggressive

Risk:

- legitimate readings may be marked invalid if the threshold is set too high

Mitigation:

- keep `DENDROMETER_REF_MIN_RAW` as a compile-time constant
- still transmit raw averaged counts for debugging

### Power-off leak

Risk:

- a failure path could leave `5V` enabled

Mitigation:

- centralize power sequencing in `measure_dendrometer()`
- structure the function so all exits power off first

### Hidden dependence on legacy `MOD=3` fields

Risk:

- some downstream code may assume old `MOD=3` field semantics

Mitigation:

- keep decoder changes localized in `osi-dendro-helper`
- verify the existing LSN50 ingest path with a real fixture

---

## Future Extensions

This design intentionally leaves room for:

- user-tunable sample count and timing
- additional measurement fault flags
- board-specific channel mapping for LSN50V3
- optional firmware-side calibration once the raw oversampled path is validated

The board/measurement split is the main preparation for LSN50V3 support.
