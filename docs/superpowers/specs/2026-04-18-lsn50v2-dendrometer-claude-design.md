# LSN50V2 Ratiometric Dendrometer — Design Spec (Claude)

**Date:** 2026-04-18
**Status:** Draft — awaiting user approval
**Author:** Claude (independent of any parallel Codex draft)
**Scope:** `Project-OSI/LoRa_STM32` firmware + `osi-os` Node-RED decoder

---

## 1. Problem

The LSN50V2 stock firmware handles dendrometer hardware in `MOD=3` by reading PA0, PA1, and PA4 with a six-sample average per channel and converting each to millivolts scaled by the measured battery voltage. That pipeline has three issues for ratiometric dendrometer use:

1. **Noise floor is set by six samples.** Potentiometer wiper noise and 5V-rail ripple leak into every reading. With 50+ samples the standard error drops by a factor of three and wiper noise averages out.
2. **Scaling is non-ratiometric.** Multiplying raw counts by `batteryLevel_mV / 4095` uses the battery rail as the reference. The potentiometer is driven by the switched 5V rail (regulated by a boost), not the battery, so the two drift independently. A true ratio `PA0 / PA1` is ratiometric against the same rail that drives the sensor — battery sag drops out.
3. **PA4 is a third ADC channel unrelated to the dendrometer measurement.** Keeping it in the payload wastes 2 bytes of airtime and confuses the decoder.

## 2. Goal

Replace the `MOD=3` measurement pipeline on LSN50V2 with an oversampled, ratiometric-friendly dendrometer read:

- sample PA0 (signal) and PA1 (reference) as an interleaved pair, 50 times
- ship raw averaged counts (not millivolts) so the gateway can compute the ratio
- report validity via a dedicated flags byte
- keep the `5V` active window well under the existing `AT+5VT` default
- leave other modes untouched
- update the `osi-dendro-helper` decoder in `osi-os` so raw averages flow through to analytics

## 3. Non-goals

- No new AT commands (compile-time constants only)
- No mm calibration inside firmware (stays in the gateway analytics)
- No V3 board support (only leave a clean abstraction seam)
- No change to MOD 1, 2, 4, 5, 6, 7, 8, 9
- No firmware-side ratio computation

## 4. Hardware contract

Target: Dragino LSN50V2, EU868.

| Signal | Pin | Role | Front-end |
|---|---|---|---|
| Potentiometer wiper | PA0 (`ADC_Channel_Oil` in stock code) | signal | 3.9k/3.9k divider, 1k series + 100nF to GND RC filter |
| 5V rail midpoint | PA1 (`ADC_Channel_IN1`) | reference | 3.9k/3.9k divider, no RC |
| Switched 5V output | `PWR_OUT` GPIO | power gate | `RESET` enables, `SET` disables (inverted logic in stock firmware) |

PA4 (`ADC_Channel_IN4`) is **not read** in the new MOD=3. The OIL_CONTROL pin sequence stays wrapped inside the board layer — the dendrometer module does not touch it directly.

## 5. Current code (confirmed by reading the fork)

- Dispatch lives in `bsp.c` via a chain of `if (mode == N)` branches inside `BSP_sensor_Read()`. The MOD=3 branch is lines 302–338 of `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`.
- Payload packing lives in `main.c`, `else if (mode == 3)` branch at lines 641–675.
- Stock MOD=3 payload (without `USE_SHT`):

  ```
  [0-1] oil_mV        (PA0 avg × batteryLevel_mV / 4095, big-endian)
  [2-3] ADC_1_mV      (PA1 avg × batteryLevel_mV / 4095)
  [4-5] ADC_2_mV      (PA4 avg × batteryLevel_mV / 4095)
  [6]   status_byte   (switch<<7 | in1<<1 | 0x08 | exit_temp)
  [7]   battery_10mV  (batteryLevel_mV / 100, 1 byte)
  ```

- `osi-dendro-helper/index.js` currently assumes a MOD=1-style layout (battery in bytes 0-1, PA0 at bytes 4-5, PA1 at bytes 7-8). That means the stock MOD=3 frame is already decoded sub-optimally — a secondary reason to redefine MOD=3 cleanly.

## 6. Module architecture (Approach 2)

Three seams, one new header:

```
inc/dendrometer.h   (new)     — public API, board primitives (forward decls), constants, flags
src/dendrometer.c   (new)     — pure integer logic: sampling, averaging, validation, packing
src/bsp.c           (edit)    — MOD=3 branch calls measure_dendrometer(); adds board primitive impls
src/main.c          (edit)    — MOD=3 payload packing uses pack_mod3_payload()
inc/bsp.h           (edit)    — extends sensor_t with a dendrometer_result_t field
```

No new `board.c` — the board primitives are declared in `dendrometer.h` and implemented inside `bsp.c` (five short new functions) to stay consistent with the upstream "everything HAL-adjacent goes in bsp.c" convention. The seam is that `dendrometer.c` never includes any `stm32*` header; it sees only the five prototypes declared at the top of `dendrometer.h`.

## 7. `dendrometer.h` — public surface

```c
#ifndef __DENDROMETER_H__
#define __DENDROMETER_H__

#include <stdint.h>
#include <stdbool.h>

/* ---- Compile-time tunables ------------------------------------------ */
#ifndef DENDRO_SAMPLE_COUNT
#define DENDRO_SAMPLE_COUNT         50u
#endif
#ifndef DENDRO_SETTLE_MS
#define DENDRO_SETTLE_MS            50u
#endif
#ifndef DENDRO_INTER_SAMPLE_MS
#define DENDRO_INTER_SAMPLE_MS      1u
#endif
#ifndef DENDRO_REF_MIN_RAW
#define DENDRO_REF_MIN_RAW          128u    /* below = reference rail failed  */
#endif
#ifndef DENDRO_REF_MAX_RAW
#define DENDRO_REF_MAX_RAW          4080u   /* above = reference rail saturated */
#endif

/* ---- Flag bits (single payload byte) -------------------------------- */
#define DENDRO_FLAG_VALID           0x01u   /* ratio is trustworthy           */
#define DENDRO_FLAG_REF_LOW         0x02u   /* avg2 < DENDRO_REF_MIN_RAW      */
#define DENDRO_FLAG_REF_HIGH        0x04u   /* avg2 > DENDRO_REF_MAX_RAW      */
#define DENDRO_FLAG_ADC_FAIL        0x08u   /* one channel returned all zeros */
/* bits 4..7 reserved */

/* ---- Result type ---------------------------------------------------- */
typedef struct {
    uint16_t adc_signal_avg_raw;      /* PA0, 0..4095 */
    uint16_t adc_reference_avg_raw;   /* PA1, 0..4095 */
    uint8_t  flags;                    /* DENDRO_FLAG_* */
} dendrometer_result_t;

/* ---- Board primitives (implemented in bsp.c) ------------------------ */
void     dendro_board_5v_on(void);
void     dendro_board_5v_off(void);
uint16_t dendro_board_adc_read_signal(void);
uint16_t dendro_board_adc_read_reference(void);
void     dendro_board_delay_ms(uint32_t ms);

/* ---- Public API (implemented in dendrometer.c) ---------------------- */
void     dendrometer_measure(dendrometer_result_t *out);
uint8_t  dendrometer_pack_payload(const dendrometer_result_t *m,
                                   uint16_t battery_mv,
                                   uint8_t  status_byte,
                                   uint8_t *dst /* must hold >= 8 bytes */);

#endif /* __DENDROMETER_H__ */
```

Rationale for design choices:

- **`adc*_avg_raw` as uint16, not uint8**: 12-bit ADC plus headroom for higher-resolution silicon later.
- **Five board primitives, not four**: `adc_read_signal` / `adc_read_reference` stay channel-specific so the measurement layer never sees channel constants. Channel-to-pin mapping is a board concern.
- **`dendrometer_pack_payload()` takes battery + status as inputs**: the measurement module owns dendrometer bytes only; caller passes framing bytes. Keeps the module pure and testable.
- **Compile-time tunables named with `DENDRO_` prefix**: readable at call sites, easy to override via `-D` at build time.

## 8. Measurement sequence

```
dendrometer_measure(out):
    /* 1. zero the result so every exit path is safe */
    out->adc_signal_avg_raw = 0
    out->adc_reference_avg_raw = 0
    out->flags = 0

    /* 2. enable 5V rail, let the divider + RC settle */
    dendro_board_5v_on()
    dendro_board_delay_ms(DENDRO_SETTLE_MS)

    /* 3. interleaved sampling loop — shared time window for ch1/ch2 */
    uint32_t sum1 = 0, sum2 = 0
    uint16_t zeros1 = 0, zeros2 = 0
    for (uint16_t i = 0; i < DENDRO_SAMPLE_COUNT; ++i) {
        uint16_t s1 = dendro_board_adc_read_signal()
        uint16_t s2 = dendro_board_adc_read_reference()
        sum1 += s1;   if (s1 == 0) ++zeros1
        sum2 += s2;   if (s2 == 0) ++zeros2
        dendro_board_delay_ms(DENDRO_INTER_SAMPLE_MS)
    }

    /* 4. integer divide to produce averages (sums ≤ 50*4095 ≈ 200k) */
    out->adc_signal_avg_raw    = (uint16_t)(sum1 / DENDRO_SAMPLE_COUNT)
    out->adc_reference_avg_raw = (uint16_t)(sum2 / DENDRO_SAMPLE_COUNT)

    /* 5. unconditional power-off — happens before validation */
    dendro_board_5v_off()

    /* 6. validation (mutually-exclusive outcome in flags bits 0..3) */
    if (zeros1 == DENDRO_SAMPLE_COUNT || zeros2 == DENDRO_SAMPLE_COUNT) {
        out->flags |= DENDRO_FLAG_ADC_FAIL
    } else if (out->adc_reference_avg_raw < DENDRO_REF_MIN_RAW) {
        out->flags |= DENDRO_FLAG_REF_LOW
    } else if (out->adc_reference_avg_raw > DENDRO_REF_MAX_RAW) {
        out->flags |= DENDRO_FLAG_REF_HIGH
    } else {
        out->flags |= DENDRO_FLAG_VALID
    }
```

Three properties that fall out of this structure:

1. **Power-off is unconditional** (step 5) and happens before validation, so no error branch can skip it. Tested by assertion: the mock board's event log must end with `OFF` in every test case.
2. **Interleaved sampling** (step 3) keeps both channels inside the same ~1 ms window, so 5V-rail drift is common-mode and cancels in the ratio. A batched "all ch1, then all ch2" sweep would let the rail droop between the two windows.
3. **Integer math only** — sums are `uint32_t` (max 50·4095 ≈ 200k, zero overflow risk), averages divide exactly, no float anywhere.

Timing budget:

- settle: 50 ms
- 50 iterations × (~5 µs × 2 ADC + 1 ms delay) ≈ 50–55 ms
- validation + power-off: < 1 ms
- **Total ~105 ms** — well inside the default `AT+5VT=500ms` window

Airtime delta vs. stock MOD=3: new payload is 8 bytes vs. stock 8 bytes (no `USE_SHT`), so **no airtime increase**. Stock layout bytes 4-5 (PA4) are repurposed for a flags byte + preserving status byte placement.

## 9. `MOD=3` payload — new layout (8 bytes)

| Byte | Field | Type | Notes |
|---|---|---|---|
| 0–1 | `battery_mv` | `uint16` BE | full-resolution battery in millivolts, same encoding as MOD=1 |
| 2–3 | `adc_signal_avg_raw` | `uint16` BE | PA0 averaged raw count, 0..4095 |
| 4–5 | `adc_reference_avg_raw` | `uint16` BE | PA1 averaged raw count, 0..4095 |
| 6 | `status_byte` | `uint8` | `(switch<<7) \| (in1<<1) \| 0x08 \| (exit_temp & 0x01)` — byte layout unchanged from stock so `detectLsn50ModeCode()` still returns 3 |
| 7 | `dendro_flags` | `uint8` | `DENDRO_FLAG_*` bitfield |

Total: 8 bytes. Same as stock MOD=3 without `USE_SHT`. No payload size regression.

Intentional changes from stock:

- **Battery moves from byte 7 to bytes 0-1** (aligns with MOD=1/2/4/5; decoder becomes uniform across modes).
- **Raw ADC counts replace millivolt-scaled values** (ratiometric compute happens in the decoder using both channels).
- **PA4 field is removed** (not part of dendrometer measurement).
- **SHT/BH1750 legacy block is removed** from MOD=3 specifically — `USE_SHT` remains available in other modes unchanged.
- **Flags byte replaces the bottom byte** — diagnostic data that was previously absent.

The `0x08` nibble in byte 6 stays, so `detectLsn50ModeCode()` in `osi-dendro-helper` continues to identify the frame as MOD=3 without change.

## 10. Decoder changes (`osi-os`)

File: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`.

New function `decodeMod3DendroPayload(b64)` returning:

```js
{
    batV:                    number,   // bytes 0-1 / 1000
    adcSignalAvgRaw:         uint16,   // bytes 2-3
    adcReferenceAvgRaw:      uint16,   // bytes 4-5
    statusByte:              uint8,    // byte 6 (raw)
    modeCode:                3,
    modeLabel:               "MOD3",
    switchStatus:            0 | 1,    // decoded from status byte
    dendroFlags:             uint8,    // byte 7 (raw)
    measurementValid:        boolean,  // flags & DENDRO_FLAG_VALID
    refTooLow:               boolean,  // flags & DENDRO_FLAG_REF_LOW
    refTooHigh:              boolean,  // flags & DENDRO_FLAG_REF_HIGH
    adcFail:                 boolean,  // flags & DENDRO_FLAG_ADC_FAIL
    /* Backwards-compat aliases so existing pipeline keeps working:     */
    adcCh0V:                 number | null,   // raw * 5.0 / 4095 (5V divided)
    adcCh1V:                 number | null,   // same
    adcCh4V:                 null,            // always null in new MOD=3
    dendroRatio:             number | null,   // signal / reference if measurementValid
}
```

Dispatch update:

- `decodeRawAdcPayload(b64)` detects the new frame by `buf.length === 8 && ((buf[6] >> 2) & 0x1f) === 2` (stock MOD=3 packed without SHT also matched this, but we intentionally redefine the semantics inside the new firmware rollout — any gateway receiving this frame is running matched firmware).
- When matched, delegate to `decodeMod3DendroPayload(b64)`. Otherwise fall back to the existing path (which is what MOD=1/2/4/… still use).

`buildDendroDerivedMetrics()` gets a thin adjustment:

- when the new MOD=3 decoder returned a result, set `dendroModeUsed = 'ratio_mod3'` and use `dendroRatio` directly
- `detectDendroModeUsed()` gains an `adcRaw` signal so it stops depending on the millivolt-scaled approximation

No schema changes to `device_data`. The existing columns (`adc_ch0v`, `adc_ch1v`, `dendro_position_mm`, etc.) continue to populate via the backwards-compat aliases.

## 11. Host-side unit tests

New dir: `tests/` at the **firmware repo root** (`/home/phil/Repos/LoRa_STM32-claude/tests/`) — outside the EWARM/MDK-ARM scan paths so no commercial IDE ever sees it.

```
tests/
  Makefile                    # native gcc target `make test` (host, not ARM)
  mock_board.c                # implements dendro_board_* with scripted samples
  mock_board.h                # test-only control API (set_samples, log_events)
  test_dendrometer.c          # assertions
```

`dendrometer.c` is compiled with host `gcc` directly — it has no HAL dependencies, so it's portable C99. The mock board provides all five `dendro_board_*` symbols via a scripted sample table and an event log (`5V_ON`, `5V_OFF`, `ADC_SIG(val)`, `ADC_REF(val)`, `DELAY(ms)`).

Minimum cases:

| Test | Scripted samples | Expected |
|---|---|---|
| `average_of_constant` | 50×(sig=2048, ref=2048) | avg1 == avg2 == 2048, VALID set, no other flags |
| `average_rounding_floor` | 50×(sig=1, ref=1) alternating with (sig=0, ref=0) | avg1 == avg2 == 0 (integer rounding) |
| `reference_low` | sig=1024, ref=50 | REF_LOW set, VALID clear, averages still reported |
| `reference_high` | sig=1024, ref=4095 | REF_HIGH set, VALID clear |
| `adc_fail_signal_zero` | sig=0 all samples, ref=2048 | ADC_FAIL set, VALID clear |
| `adc_fail_reference_zero` | sig=1024, ref=0 all | ADC_FAIL set, VALID clear |
| `power_always_off` | any error case | mock board event log ends with `5V_OFF` |
| `power_on_settle_sequence` | any | event log starts `5V_ON, DELAY(50ms)` |
| `pack_known_result` | fixed struct | dst bytes match expected hex |
| `pack_preserves_status_byte` | caller passes `0x8A` | `dst[6] == 0x8A` |
| `pack_flags_valid_only` | `flags=VALID` | `dst[7] == 0x01` |
| `pack_flags_combined` | `flags=REF_LOW\|ADC_FAIL` | `dst[7] == 0x0A` |

Decoder tests (osi-os side) — `conf/.../osi-dendro-helper/test/` (new):

| Test | Input | Expected |
|---|---|---|
| `decode valid MOD=3 frame` | 8-byte hex with VALID flag | all fields populated, dendroRatio computed |
| `decode REF_LOW frame` | flags=0x02 | measurementValid==false, refTooLow==true, dendroRatio=null |
| `backwards-compat aliases` | valid frame | adcCh0V/adcCh1V populated from raw×5/4095 |
| `unknown frame fallback` | MOD=1 frame | legacy path returns expected MOD=1 fields |

Test runner: `node --test` (Node ≥ 20 built-in test runner). No new dependency.

## 12. File changes summary

### Firmware (`Project-OSI/LoRa_STM32`, branch `feature/ratiometric-dendrometer-claude`)

New:
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`
- `tests/Makefile`
- `tests/mock_board.c` + `tests/mock_board.h`
- `tests/test_dendrometer.c`
- `README-dendrometer.md` (new, rollout notes for this fork)

Edit:
- `.../src/bsp.c` — replace MOD=3 branch in `BSP_sensor_Read()` with `dendrometer_measure()` call; add board primitive implementations (~30 lines added); delete the PA4 read for MOD=3 specifically
- `.../src/main.c` — replace MOD=3 branch in payload packing with `dendrometer_pack_payload()` call (~5 lines)
- `.../inc/bsp.h` — add `dendrometer_result_t dendro;` field to `sensor_t`

### Decoder (`osi-os`, worktree `.worktrees/lsn50-dendrometer-decoder-claude`, branch `feature/lsn50-dendrometer-decoder-claude`)

Edit:
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js` — add `decodeMod3DendroPayload`, dispatcher in `decodeRawAdcPayload`, small adjustment to `buildDendroDerivedMetrics`

New:
- `conf/.../osi-dendro-helper/test/decoder.test.js` — `node --test` cases above
- `conf/.../osi-dendro-helper/package.json` (if missing) — so `npm test` works in CI

Commit:
- `docs/superpowers/specs/2026-04-18-lsn50v2-dendrometer-claude-design.md` (this file)

## 13. Verification checklist

Upstream ships IAR (`EWARM/`) and Keil (`MDK-ARM/`) project files only — no Makefile, no GCC build. Full ARM firmware build requires a commercial IDE on a separate host. Verification is therefore split:

### In this session (Linux workstation, arm-none-eabi-gcc)

- [ ] `make -C tests test` — all dendrometer host unit tests pass (native gcc)
- [ ] `arm-none-eabi-gcc -c -mcpu=cortex-m0plus -mthumb -I<stm32l0 hal headers> -o /tmp/dendrometer.o src/dendrometer.c` — confirms `dendrometer.c` compiles clean as ARM code against real HAL headers (smoke test, no link)
- [ ] `node --test conf/.../osi-dendro-helper/test/` — decoder tests pass
- [ ] `node scripts/verify-sync-flow.js` in osi-os — still passes (no sync impact)
- [ ] Fixed-hex round-trip: hand-crafted 8-byte MOD=3 frame decodes to expected struct
- [ ] `grep -r 'HAL_\|stm32' src/dendrometer.c` — returns no matches (module stays HAL-free)
- [ ] `git diff` review: no changes to MOD !=3 code paths in bsp.c / main.c

### Out-of-session (user's IDE host)

- [ ] Keil or IAR builds EU868 `.hex` from the fork with no errors or warnings beyond upstream baseline
- [ ] Flashed LSN50V2 bench unit joins EU868, uplinks MOD=3, and the gateway decodes the new frame into populated `device_data` rows

## 14. Risks & mitigations

**Decoder/firmware out of sync during rollout.**
If a field unit gets the new firmware before its gateway gets the new decoder, the gateway will misread the frame. Mitigation: ship decoder update first to the gateway, then flash firmware. Document this sequencing in `README-dendrometer.md`. The `status_byte` keeps the MOD=3 nibble intact, so the gateway can cleanly reject frames it doesn't know how to parse.

**Reference threshold drops valid readings.**
`DENDRO_REF_MIN_RAW = 128` corresponds to ~0.16 V after the divider — if the 5V rail is healthier than 0.32 V from the battery, the reference should sit around 2.5 V raw = ~2048 counts. 128 is a wide margin. If field data shows false REF_LOW, the constant is a single edit and a recompile.

**ADC read returns non-zero garbage when channel is floating.**
`ADC_FAIL` only triggers when all 50 samples are exactly 0. A stuck-at-mid-scale ADC bug would not trigger it. Left as a known limitation — variance detection is a future flag bit.

**Interleaving skew.**
PA0 and PA1 are sampled ~5-10 µs apart. A 1-kHz ripple on the 5V rail would phase-shift between the two reads by < 1% of a cycle, negligible. Higher-frequency noise is filtered by the RC on PA0 and by averaging.

**Upstream rebase pain.**
The new module is self-contained in two new files. `bsp.c` and `main.c` edits are localized to the MOD=3 branches. Upstream rebase conflicts will be narrow and easy to resolve.

## 15. Future work (explicitly out of scope)

- AT command to tune `DENDRO_SAMPLE_COUNT` and `DENDRO_SETTLE_MS` at runtime
- LSN50V3 board variant — add `src/dendrometer_board_v3.c` backing the same primitives and select via `-D LSN50_VARIANT=3`
- Variance / glitch detection flag (bit 4 reserved)
- Optional firmware-side calibration once raw pipeline is validated in the field
- Migrate `pwr_out` / OIL_CONTROL handling into a real `board.c` if a second board variant arrives
