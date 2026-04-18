# LSN50V2 Dendrometer — Stock-Shape Payload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 8-byte breaking MOD=3 payload with a stock-shape 12-byte frame (`USE_SHT` compiled in) while keeping the 20-sample paired oversampling on PA0/PA1. Gateway gains a stock-shape decoder; firmware stays minimally diverged from Dragino master.

**Architecture:** Firmware emits the *real* Dragino MOD=3 wire layout (`[0-1]oil_mV [2-3]ADC_1_mV [4-5]ADC_2_mV [6]status|0x08 [7-10]SHT/BH1750 [11]batt/100`). On the STM32, only the PA0+PA1 sampling is replaced with a new `dendrometer_measure()` that enables the dendrometer's own 5 V boost, pair-samples 20 times, and writes mV values back into the stock `sensor_t.oil` / `sensor_t.ADC_1` fields. The stock PA4 6-sample read, stock `if((mode==1)||(mode==3))` I²C block, and stock main.c MOD=3 packer are all preserved untouched; the new MOD=3 logic lives in a new `else if(mode==3)` block inserted before the stock `else if((mode==3)||(mode==8))` branch. On the gateway, the 8-byte decoder path from the previous iteration is reverted and replaced with a new `decodeStockMod3Payload()` that parses the 12-byte stock shape, computes `dendroRatio = oil/ADC_1`, and feeds the existing `buildDendroDerivedMetrics` pipeline. SHT/BH1750 bytes are read from the wire but ignored downstream ("keep I2C for later").

**Tech Stack:** STM32L072 Cortex-M0+ C firmware (Dragino `LoRa_STM32` fork, Keil/GCC), host C test harness (cmocka-style in `host_tests/`), Node.js 22 for osi-dendro-helper (`node:test` via `npm test`), Node-RED `flows.json`, `scripts/verify-sync-flow.js` verifier.

---

## File Structure

**Firmware repo: `/home/phil/Repos/LoRa_STM32-claude` — branch `feature/ratiometric-dendrometer-claude`**

- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h` — simplify public interface: drop `flags`, drop `dendrometer_pack_payload`, return raw averaged ADC codes for signal and reference.
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c` — keep 5 V on → 50 ms settle → 20 paired samples → average → 5 V off logic; drop flag classification; drop packer function.
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c` — add a new `else if(mode==3) { ... }` block *above* the existing stock `else if((mode==3)||(mode==8)) { ... }` branch. New block calls `dendrometer_measure()`, converts raw → mV using `batteryLevel_mV`, writes `sensor_data->oil` and `sensor_data->ADC_1`, then runs the stock 6-sample PA4 loop to populate `sensor_data->ADC_2`. Stock block unchanged; I²C `if((mode==1)||(mode==3))` block at L154 unchanged.
- Revert: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c` MOD=3 packer — restore commit `4fb3cbe`'s parent version verbatim.
- Modify: `host_tests/test_dendrometer_core.c` (or equivalent host test) — drop flag-classification tests and packer tests; keep "20 paired samples averaged correctly" and "5 V disabled on every exit path" tests.
- Modify: `README-dendrometer-claude.md` — rewrite rollout notes to describe stock-shape payload and gateway-transparent upgrade.

**Gateway repo: `/home/phil/Repos/osi-os` — branch `feature/lsn50-dendrometer-decoder-claude` (worktree: `.worktrees/lsn50-dendrometer-decoder-claude`)**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js` — delete `decodeMod3DendroPayload` (8-byte); delete `MOD3_DENDRO_FRAME_LENGTH` and `DENDRO_FLAG_*` constants; delete firmware-validity override branch in `buildDendroDerivedMetrics`; add new `decodeStockMod3Payload(b64)` that parses 12-byte stock layout; update dispatcher in `decodeRawAdcPayload` to route 12-byte frames with mode nibble 3 to the new decoder.
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js` — remove 8-byte fixture tests, remove `measurementValid` override tests, add 12-byte stock MOD=3 fixture tests covering happy path, tiny reference (invalid), disconnected DS18B20 (0x7FFF → null tempC1), and no-USE_SHT 8-byte fallback via legacy path.
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` — remove `measurementValid` threading from decoder node (≈L3696), analytics node (≈L3884), and cloud-mirror builder (≈L3431). Decoder node now calls `decodeRawAdcPayload` and uses its `adcCh0V/adcCh1V` directly.
- Modify: `scripts/verify-sync-flow.js` — remove `customMod3ValidFixture` and `customMod3InvalidFixture` (8-byte). Rename `stockMod3Fixture` → `stockMod3Fixture` (keep) and update assertions to reflect the real 12-byte stock layout (`oil`, `ADC_1`, `ADC_2` in mV, SHT bytes ignored, battery/100 from buf[11]).

---

## Task 1: Simplify dendrometer.h public interface

**Files:**
- Modify: `LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`

- [ ] **Step 1: Replace file contents**

```c
#ifndef DENDROMETER_H
#define DENDROMETER_H

#include <stdint.h>

/**
 * Raw 12-bit ADC averages from 20 paired samples of the ratiometric divider.
 * The caller is responsible for converting these to mV using batteryLevel_mV
 * (VDDA ≈ batV on LSN50 V2). The ratio PA0/PA1 cancels batV, so the raw
 * codes are sufficient for ratiometric analytics on the gateway.
 */
typedef struct {
    uint16_t signal_raw;     /* PA0 — 20-sample average, 12-bit code */
    uint16_t reference_raw;  /* PA1 — 20-sample average, 12-bit code */
} dendrometer_result_t;

/**
 * Enable dendrometer 5 V rail, wait for settle, take 20 paired samples of
 * PA0 (signal) and PA1 (reference), average, disable 5 V rail.
 * Must be called with interrupts usable and HAL ADC initialised.
 */
void dendrometer_measure(dendrometer_result_t *result);

#endif /* DENDROMETER_H */
```

- [ ] **Step 2: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h'
git commit -m "refactor(dendrometer): simplify public API to raw averaged codes"
```

---

## Task 2: Simplify dendrometer.c — drop flags and packer, keep 20-sample paired averaging

**Files:**
- Modify: `LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`
- Test: `LoRa_STM32-claude/host_tests/test_dendrometer_core.c`

- [ ] **Step 1: Rewrite host test to match new API**

Replace any `flags`, `DENDRO_FLAG_*`, or `pack_payload` tests with these two:

```c
/* host_tests/test_dendrometer_core.c — relevant cases */

static void test_dendrometer_pair_samples_and_averages(void **state) {
    (void)state;
    /* mock_adc_set_channel_sequence(PA0, (uint16_t[]){2000, 2001, 1999, ...}, 20);
       mock_adc_set_channel_sequence(PA1, (uint16_t[]){3000, 2999, 3001, ...}, 20); */
    dendrometer_result_t r;
    dendrometer_measure(&r);
    assert_int_equal(r.signal_raw, 2000);
    assert_int_equal(r.reference_raw, 3000);
    assert_int_equal(mock_board_5v_enabled_total_ms(), 50 /* settle */ + /* 20 pair-sample cycles */);
    assert_int_equal(mock_board_5v_final_state(), 0);
}

static void test_dendrometer_5v_disabled_on_all_exit_paths(void **state) {
    (void)state;
    mock_adc_force_fail_at_sample(10);
    dendrometer_result_t r;
    dendrometer_measure(&r);
    assert_int_equal(mock_board_5v_final_state(), 0);
}
```

- [ ] **Step 2: Run host tests — expect FAIL (old symbols still referenced / new API missing)**

```bash
cd /home/phil/Repos/LoRa_STM32-claude && make -C host_tests test
```

Expected: FAIL (compile errors or assertion failures against old flag-based API).

- [ ] **Step 3: Rewrite dendrometer.c**

```c
#include "dendrometer.h"
#include "bsp.h"
#include "stm32l0xx_hal.h"

#define DENDRO_SAMPLE_COUNT   20U
#define DENDRO_SETTLE_MS      50U

extern void     dendro_board_enable_5v(void);
extern void     dendro_board_disable_5v(void);
extern uint16_t dendro_board_read_signal(void);    /* PA0 */
extern uint16_t dendro_board_read_reference(void); /* PA1 */

void dendrometer_measure(dendrometer_result_t *result) {
    if (result == 0) { return; }
    result->signal_raw    = 0;
    result->reference_raw = 0;

    dendro_board_enable_5v();
    HAL_Delay(DENDRO_SETTLE_MS);

    uint32_t sig_sum = 0;
    uint32_t ref_sum = 0;
    for (uint32_t i = 0; i < DENDRO_SAMPLE_COUNT; i++) {
        sig_sum += dendro_board_read_signal();
        ref_sum += dendro_board_read_reference();
    }

    dendro_board_disable_5v();

    result->signal_raw    = (uint16_t)(sig_sum / DENDRO_SAMPLE_COUNT);
    result->reference_raw = (uint16_t)(ref_sum / DENDRO_SAMPLE_COUNT);
}
```

- [ ] **Step 4: Run host tests — expect PASS**

```bash
cd /home/phil/Repos/LoRa_STM32-claude && make -C host_tests test
```

Expected: PASS (both tests green).

- [ ] **Step 5: Commit**

```bash
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c' host_tests/test_dendrometer_core.c
git commit -m "refactor(dendrometer): drop flag classification and packer, keep 20-sample paired averaging"
```

---

## Task 3: Insert new `else if(mode==3)` block in bsp.c above stock branch

**Files:**
- Modify: `LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`

Current Claude-branch state at ~L302 has a minimal `else if(mode==3) { dendrometer_measure(...); PPRINTF(...); }` block. Stock `else if((mode==3)||(mode==8))` follows. We keep the new-block approach but expand it to fully populate the stock `sensor_t` fields the packer expects.

- [ ] **Step 1: Read current mode==3 block and stock block**

```bash
grep -n 'else if(mode==3)\|else if((mode==3)||(mode==8))' \
  'LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c'
```

Confirm order: new `else if(mode==3)` comes BEFORE `else if((mode==3)||(mode==8))`.

- [ ] **Step 2: Replace the new `else if(mode==3)` block contents**

Old (Claude branch current):
```c
else if(mode==3)
{
    dendrometer_measure(&sensor_data->dendro);
    if(message==1) { /* PPRINTF */ }
}
```

New:
```c
else if(mode==3)
{
    /* Ratiometric dendrometer: replace stock 6-sample PA0+PA1 with 20-sample
     * paired average from a dedicated 5 V boost. PB4 / OIL_CONTROL is NOT
     * toggled — the production dendrometer wiring does not use it. PA4 still
     * runs the stock 6-sample loop so sensor_data->ADC_2 keeps its stock
     * meaning. The stock else-if((mode==3)||(mode==8)) branch below becomes
     * unreachable for mode==3; it is intentionally left untouched so the
     * mode==8 path is unchanged. */
    dendrometer_result_t dendro_samples;
    dendrometer_measure(&dendro_samples);
    sensor_data->oil   = (uint16_t)(((uint32_t)dendro_samples.signal_raw   * batteryLevel_mV) / 4095U);
    sensor_data->ADC_1 = (uint16_t)(((uint32_t)dendro_samples.reference_raw * batteryLevel_mV) / 4095U);

    HAL_Delay(50);
    uint16_t adc_pa4[6];
    for (uint8_t z = 0; z < 6; z++) {
        adc_pa4[z] = HW_AdcReadChannel(ADC_Channel_IN4); /* PA4 */
        HAL_Delay(10);
    }
    uint16_t AD_code_pa4 = ADC_Average(adc_pa4);
    sensor_data->ADC_2 = (uint16_t)(((uint32_t)AD_code_pa4 * batteryLevel_mV) / 4095U);

    if (message == 1) {
        PPRINTF("ADC_PA0:%.3f V\r\n", sensor_data->oil   / 1000.0);
        PPRINTF("ADC_PA1:%.3f V\r\n", sensor_data->ADC_1 / 1000.0);
        PPRINTF("ADC_PA4:%.3f V\r\n", sensor_data->ADC_2 / 1000.0);
    }
}
```

Confirm `ADC_Channel_IN4`, `HW_AdcReadChannel`, `ADC_Average`, `PPRINTF`, and `batteryLevel_mV` are already in scope at this location (they are used by the stock `else if((mode==3)||(mode==8))` block a few lines below).

- [ ] **Step 3: Do NOT modify the stock `else if((mode==3)||(mode==8))` block**

Verify with `git diff src/bsp.c` — the only change in this file should be inside the new `else if(mode==3)` block. The stock block text must be byte-identical to master for mode==8 to remain stock.

- [ ] **Step 4: Verify I²C block at ~L154 untouched**

```bash
grep -n 'if((mode==1)||(mode==3))' \
  'LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c'
```

Expected: line present, unchanged — this populates `sensor_data->temp_sht` / `hum_sht` / `illuminance` which the stock packer writes to wire bytes 7-10.

- [ ] **Step 5: Commit**

```bash
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c'
git commit -m "feat(bsp): dendrometer MOD=3 writes stock sensor_t.oil/ADC_1/ADC_2"
```

---

## Task 4: Revert main.c MOD=3 packer to stock

**Files:**
- Modify: `LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`

- [ ] **Step 1: Replace the `else if(mode==3)` block contents with the stock packer**

Restore exactly what commit `4fb3cbe`'s parent produced. The replacement block is:

```c
else if(mode==3)
{
    AppData.Buff[i++] =(int)(sensor_data.oil)>>8;          //oil float
    AppData.Buff[i++] =(int)sensor_data.oil;

    AppData.Buff[i++] =(int)(sensor_data.ADC_1)>>8;
    AppData.Buff[i++] =(int)(sensor_data.ADC_1);
    AppData.Buff[i++] =(int)(sensor_data.ADC_2)>>8;
    AppData.Buff[i++] =(int)(sensor_data.ADC_2);

    if(exit_temp==0)
    {
        switch_status=HAL_GPIO_ReadPin(GPIO_EXTI14_PORT,GPIO_EXTI14_PIN);
    }
    AppData.Buff[i++]=(switch_status<<7)|(sensor_data.in1<<1)|0x08|(exit_temp&0x01);

    #if defined USE_SHT
    if(bh1750flags==1)
    {
        AppData.Buff[i++] =(sensor_data.illuminance)>>8;
        AppData.Buff[i++] =(sensor_data.illuminance);
        AppData.Buff[i++] = 0x00;
        AppData.Buff[i++] = 0x00;
    }
    else
    {
        AppData.Buff[i++] =(int)(sensor_data.temp_sht*10)>>8;
        AppData.Buff[i++] =(int)(sensor_data.temp_sht*10);
        AppData.Buff[i++] =(int)(sensor_data.hum_sht*10)>>8;
        AppData.Buff[i++] =(int)(sensor_data.hum_sht*10);
    }
    #endif

    AppData.Buff[i++] =(int)(batteryLevel_mV/100);
}
```

- [ ] **Step 2: Verify no other call sites reference `dendrometer_pack_payload`**

```bash
grep -rn 'dendrometer_pack_payload' LoRa_STM32-claude/
```

Expected: zero results (we deleted it in Task 1).

- [ ] **Step 3: Commit**

```bash
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c'
git commit -m "revert(main): restore stock MOD=3 packer, emit 12-byte stock wire layout"
```

---

## Task 5: Remove `sensor_t.dendro` field (stock field reuse only)

**Files:**
- Modify: `LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h`

The Claude branch added a `dendrometer_result_t dendro` field to `sensor_t`. With the new design, the dendrometer result is consumed locally in `BSP_sensor_Read` and written to stock `sensor_t.oil` / `ADC_1` / `ADC_2`. The dedicated field is dead weight.

- [ ] **Step 1: Locate and remove the field**

```bash
grep -n 'dendrometer_result_t\|\.dendro' \
  'LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h'
```

Delete the `dendrometer_result_t dendro;` line and, if present, the `#include "dendrometer.h"` at the top of `bsp.h` (dendrometer.h should be included only where `dendrometer_measure` is called, i.e. `bsp.c`).

- [ ] **Step 2: Verify no other references to `sensor_data.dendro` / `sensor_data->dendro`**

```bash
grep -rn 'sensor_data\.dendro\|sensor_data->dendro' LoRa_STM32-claude/
```

Expected: zero results.

- [ ] **Step 3: Commit**

```bash
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h'
git commit -m "refactor(bsp): drop sensor_t.dendro, reuse stock oil/ADC_1/ADC_2 fields"
```

---

## Task 6: Update firmware README

**Files:**
- Modify: `LoRa_STM32-claude/README-dendrometer-claude.md`

- [ ] **Step 1: Rewrite the rollout notes section**

Replace any 8-byte payload description with this summary:

```markdown
## MOD=3 payload (stock-shape, 12 bytes with USE_SHT)

| Offset | Bytes | Meaning                                          |
|--------|-------|--------------------------------------------------|
| 0-1    | 2     | PA0 signal in mV (20-sample paired avg × batV / 4095) |
| 2-3    | 2     | PA1 reference in mV (20-sample paired avg × batV / 4095) |
| 4-5    | 2     | PA4 in mV (stock 6-sample avg, unused by dendrometer wiring) |
| 6      | 1     | status byte: `(switch<<7) \| (in1<<1) \| 0x08 \| (exit_temp&1)` |
| 7-10   | 4     | SHT20/SHT31 temp+hum ×10, OR BH1750 illum + 0x00 0x00 |
| 11     | 1     | batteryLevel_mV / 100                            |

### What changed from stock
- PA0 and PA1 are sampled 20× each, paired (interleaved in time) for ratiometric accuracy. Stock: 6 samples per channel, sequential with 50 ms gap between channels.
- The 5 V rail for the dendrometer divider is toggled by dedicated primitives in `bsp.c` (`dendro_board_enable_5v` / `dendro_board_disable_5v`). PB4 / OIL_CONTROL is not used — the production wiring does not include it.
- PA4 path is unchanged (stock 6-sample, stock power sequencing).
- I²C SHT / BH1750 read in `BSP_sensor_Read`'s `if((mode==1)||(mode==3))` block is untouched; those bytes are still written to the wire and ignored by the gateway for now.

### Gateway compatibility
The gateway's `osi-dendro-helper` module now decodes the stock 12-byte MOD=3 layout and computes `dendroRatio = PA0_mV / PA1_mV`. Upgrading firmware is safe in either order with the paired gateway update in `feature/lsn50-dendrometer-decoder-claude`.
```

- [ ] **Step 2: Commit**

```bash
git add README-dendrometer-claude.md
git commit -m "docs(dendrometer): rewrite rollout notes for stock-shape 12-byte payload"
```

---

## Task 7: Gateway — revert 8-byte decoder path in osi-dendro-helper/index.js

**Files:**
- Modify: `osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`

- [ ] **Step 1: Remove 8-byte-specific constants and function**

Delete:
- `MOD3_DENDRO_FRAME_LENGTH`
- `DENDRO_FLAG_VALID`, `DENDRO_FLAG_REF_LOW`, `DENDRO_FLAG_REF_HIGH`, `DENDRO_FLAG_ADC_FAIL`
- `decodeMod3DendroPayload` function in full
- The `if (buf.length === MOD3_DENDRO_FRAME_LENGTH) { ... }` dispatcher branch inside `decodeRawAdcPayload`
- The `firmwareFlagProvided` / `firmwareSaysInvalid` branch inside `buildDendroDerivedMetrics` (return to the version that only uses voltage-derived validity)

- [ ] **Step 2: Add `decodeStockMod3Payload` function**

```js
const STOCK_MOD3_MIN_LENGTH = 12; // with USE_SHT: oil + ADC_1 + ADC_2 + status + 4 SHT + batt/100

function decodeStockMod3Payload(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < STOCK_MOD3_MIN_LENGTH) return null;

    const rawMode = (buf[6] >> 2) & 0x1f;
    if (rawMode + 1 !== 3) return null;

    const oilMv    = (buf[0] << 8) | buf[1];   // PA0 signal
    const adc1Mv   = (buf[2] << 8) | buf[3];   // PA1 reference
    const adc2Mv   = (buf[4] << 8) | buf[5];   // PA4
    const statusByte = buf[6];
    const batV     = (buf[11] * 100) / 1000;   // battery_mV/100 → V

    return {
      batV,
      tempC1: null,                            // DS18B20 not carried in MOD=3 stock layout
      adcCh0V: oilMv  / 1000,
      adcCh1V: adc1Mv / 1000,
      adcCh4V: adc2Mv / 1000,
      statusByte,
      switchStatus: (statusByte >> 7) & 0x01,
      modeCode: 3,
      modeLabel: 'MOD3',
    };
  } catch (_) {
    return null;
  }
}
```

- [ ] **Step 3: Update dispatcher in `decodeRawAdcPayload`**

Replace the old 8-byte dispatcher branch with:

```js
if (buf.length >= STOCK_MOD3_MIN_LENGTH) {
  const rawMode = (buf[6] >> 2) & 0x1f;
  if (rawMode + 1 === 3) {
    return decodeStockMod3Payload(b64);
  }
}
// fall through to legacy decoder below
```

- [ ] **Step 4: Update module exports**

Remove `decodeMod3DendroPayload` from `module.exports`; add `decodeStockMod3Payload`. Keep every other export.

---

## Task 8: Gateway — rewrite decoder tests

**Files:**
- Modify: `osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js`

- [ ] **Step 1: Remove all tests that reference 8-byte `MOD3_DENDRO_FRAME_LENGTH`, `DENDRO_FLAG_*`, `measurementValid`, or the deleted `decodeMod3DendroPayload`**

- [ ] **Step 2: Add stock MOD=3 fixture tests**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeRawAdcPayload,
  decodeStockMod3Payload,
  buildDendroDerivedMetrics,
} = require('../index');

// batV=3.28V via batt/100=33 → buf[11]=33
// oil=1500mV, ADC_1=3000mV, ADC_2=0mV, status=0x08, SHT temp=20.5C hum=55.0%
function buildStockMod3Base64(opts = {}) {
  const {
    oilMv = 1500,
    adc1Mv = 3000,
    adc2Mv = 0,
    switchStatus = 0,
    shtTempC = 20.5,
    shtHumPct = 55.0,
    battMvDiv100 = 33,
  } = opts;
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(oilMv, 0);
  buf.writeUInt16BE(adc1Mv, 2);
  buf.writeUInt16BE(adc2Mv, 4);
  buf[6] = (switchStatus << 7) | 0x08; // mode nibble 2 → MOD3
  buf.writeInt16BE(Math.round(shtTempC * 10), 7);
  buf.writeInt16BE(Math.round(shtHumPct * 10), 9);
  buf[11] = battMvDiv100;
  return buf.toString('base64');
}

test('decodeStockMod3Payload — happy path', () => {
  const b64 = buildStockMod3Base64();
  const out = decodeStockMod3Payload(b64);
  assert.equal(out.modeCode, 3);
  assert.equal(out.modeLabel, 'MOD3');
  assert.equal(out.adcCh0V, 1.5);
  assert.equal(out.adcCh1V, 3.0);
  assert.equal(out.adcCh4V, 0.0);
  assert.equal(out.batV, 3.3);
  assert.equal(out.switchStatus, 0);
});

test('decodeStockMod3Payload — reports null tempC1 (not carried in MOD=3)', () => {
  const out = decodeStockMod3Payload(buildStockMod3Base64());
  assert.equal(out.tempC1, null);
});

test('decodeRawAdcPayload dispatches 12-byte MOD=3 to stock decoder', () => {
  const out = decodeRawAdcPayload(buildStockMod3Base64());
  assert.equal(out.modeLabel, 'MOD3');
  assert.equal(out.adcCh0V, 1.5);
  assert.equal(out.adcCh1V, 3.0);
});

test('buildDendroDerivedMetrics computes ratio from stock MOD=3 decode', () => {
  const decoded = decodeStockMod3Payload(buildStockMod3Base64());
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: decoded.adcCh0V,
    adcCh1V: decoded.adcCh1V,
    effectiveMode: 3,
    strokeMm: 10,
    ratioZero: 0.0,
    ratioSpan: 1.0,
  });
  assert.equal(metrics.dendroModeUsed, 'ratio_mod3');
  assert.equal(metrics.dendroRatio, 0.5); // 1.5 / 3.0
  assert.equal(metrics.dendroValid, 1);
});

test('buildDendroDerivedMetrics flags reference_voltage_too_small on tiny PA1', () => {
  const b64 = buildStockMod3Base64({ adc1Mv: 40 }); // 0.04 V < threshold
  const decoded = decodeStockMod3Payload(b64);
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: decoded.adcCh0V,
    adcCh1V: decoded.adcCh1V,
    effectiveMode: 3,
  });
  assert.equal(metrics.dendroValid, 0);
  assert.equal(metrics.ratioInvalidReason, 'reference_voltage_too_small');
});

test('decodeStockMod3Payload returns null for wrong mode nibble', () => {
  const buf = Buffer.from(buildStockMod3Base64(), 'base64');
  buf[6] = (buf[6] & ~0x7c) | 0x00; // mode nibble 0 → MOD1
  const out = decodeStockMod3Payload(buf.toString('base64'));
  assert.equal(out, null);
});

test('decodeRawAdcPayload falls back to legacy for 8-byte (no USE_SHT build)', () => {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(1500, 0); // oil_mV at [0-1] — legacy decoder reads this as batV
  buf.writeUInt16BE(3000, 2); // legacy reads as tempC1
  buf.writeUInt16BE(0, 4);    // legacy reads as adcCh0V
  buf[6] = 0x08;
  buf[7] = 33;
  const out = decodeRawAdcPayload(buf.toString('base64'));
  // Not the stock MOD=3 path; returns legacy shape. Just assert it didn't crash
  // and didn't claim MOD3 ratio context. Production devices always ship USE_SHT.
  assert.equal(out.modeLabel, null); // buf.length<12 → not dispatched as stock MOD3; mode detect falls through
});
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
cd osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper
npm test
```

Expected: all tests green.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js
git commit -m "feat(dendro-helper): decode stock 12-byte MOD=3 payload"
```

---

## Task 9: Gateway — add REF_HIGH guard in `buildDendroDerivedMetrics`

**Why:** VDDA sag during heavy LoRa TX can push VDDA toward the divider's ~2.5 V output, saturating both PA0 and PA1 near 4095 and collapsing the ratio to ~1.0 (indistinguishable from "sensor stuck at midpoint"). The dropped firmware VALID/REF_HIGH flags were the original guard for this; with firmware flags gone, the gateway needs a cheap voltage-based check.

**Files:**
- Modify: `osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`
- Modify: `osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `decoder.test.js`:

```js
test('REF_HIGH: reference voltage near VDDA flags invalid', () => {
  // batV=3.2V, PA1=3.1V (>95% of batV) → REF_HIGH
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: 2.0,
    adcCh1V: 3.1,
    batV: 3.2,
    effectiveMode: 3,
  });
  assert.equal(metrics.dendroValid, 0);
  assert.equal(metrics.ratioInvalidReason, 'reference_voltage_too_high');
  assert.equal(metrics.positionMm, null);
  assert.equal(metrics.dendroRatio, null);
});

test('REF_HIGH: reference safely below 0.95*VDDA passes', () => {
  // batV=3.3V, PA1=2.5V (76% of batV) → OK
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: 1.25,
    adcCh1V: 2.5,
    batV: 3.3,
    effectiveMode: 3,
    strokeMm: 10,
    ratioZero: 0.0,
    ratioSpan: 1.0,
  });
  assert.equal(metrics.dendroValid, 1);
  assert.equal(metrics.ratioInvalidReason, null);
});

test('REF_HIGH: missing batV disables the guard (no false positives)', () => {
  const metrics = buildDendroDerivedMetrics({
    adcCh0V: 1.25,
    adcCh1V: 2.5,
    effectiveMode: 3,
  });
  // Without batV we cannot evaluate REF_HIGH, so the existing REF_LOW / ratio
  // validity rules stand. PA1=2.5V is well above threshold → valid.
  assert.equal(metrics.dendroValid, 1);
  assert.notEqual(metrics.ratioInvalidReason, 'reference_voltage_too_high');
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper
npm test
```

Expected: the three new tests fail (guard not yet implemented — the `REF_HIGH` case will incorrectly report `dendroValid=1`).

- [ ] **Step 3: Implement the guard in `buildDendroDerivedMetrics`**

Add this constant near the top of `index.js` (alongside `SMALL_REFERENCE_THRESHOLD`):

```js
const HIGH_REFERENCE_VDDA_FRACTION = 0.95;
```

Modify the `modeUsed === 'ratio_mod3'` branch in `buildDendroDerivedMetrics` to evaluate REF_HIGH before the normal ratio-validity path:

```js
if (modeUsed === 'ratio_mod3') {
  const batV = toFiniteNumber(options.batV);
  const refTooHigh = batV !== null
    && adcCh1V !== null
    && adcCh1V > HIGH_REFERENCE_VDDA_FRACTION * batV;

  if (refTooHigh) {
    dendroValid = 0;
    positionMm = null;
    ratioValue = null;
    ratioInvalidReason = 'reference_voltage_too_high';
  } else {
    dendroValid = ratioInfo.isValid ? 1 : 0;
    positionMm = calculateRatioDendroPositionMm({
      strokeMm,
      ratioZero,
      ratioSpan,
      ratio: ratioInfo.ratio,
      invertDirection,
    });
    if (ratioInfo.isValid && positionMm === null) {
      calibrationMissing = true;
    }
  }
}
```

- [ ] **Step 4: Export the new constant (for tunability) and run tests — expect PASS**

Add `HIGH_REFERENCE_VDDA_FRACTION` to `module.exports`.

```bash
npm test
```

Expected: all tests green (the three new REF_HIGH tests plus every existing test).

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js
git commit -m "feat(dendro-helper): flag REF_HIGH when PA1 approaches VDDA"
```

---

## Task 10: Gateway — remove `measurementValid` threading and thread `batV` for REF_HIGH guard

**Files:**
- Modify: `osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`

- [ ] **Step 1: Find each site that threads `measurementValid`**

```bash
grep -n 'measurementValid' \
  'osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
```

Expected sites (from the earlier Claude edits): decoder node (~L3696), analytics/buildDendroDerivedMetrics call site (~L3884), cloud-mirror builder (~L3431).

- [ ] **Step 2: Remove each `measurementValid` field**

At each site, delete the `measurementValid: ...` key/value (and the trailing comma) so the remaining JSON stays valid. The decoder node should no longer attach the field to `formattedData`. The analytics site should drop it from the `buildDendroDerivedMetrics(...)` argument object. The cloud-mirror builder should not pass it through.

- [ ] **Step 3: Thread `batV` into the analytics `buildDendroDerivedMetrics` call**

Task 9 adds a REF_HIGH guard that requires `batV` on the options bag. In the analytics node (~L3884) add `batV: d.batV` to the options passed to `buildDendroDerivedMetrics`. `d.batV` is already present on the formattedData object produced by the decoder node — no new decoder edit is needed. If the function change (Task 9) landed first, this step just adds the field; tests in Task 9 already cover the behavior.

- [ ] **Step 4: Validate flows.json**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8'))" && echo OK
```

Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "refactor(flows): replace measurementValid threading with batV for REF_HIGH guard"
```

---

## Task 11: Gateway — update `scripts/verify-sync-flow.js` fixtures

**Files:**
- Modify: `osi-os/.worktrees/lsn50-dendrometer-decoder-claude/scripts/verify-sync-flow.js`

- [ ] **Step 1: Remove 8-byte custom fixtures**

Delete `customMod3ValidFixture` and `customMod3InvalidFixture` and any assertions that reference them or the `measurementValid` flag.

- [ ] **Step 2: Rewrite `stockMod3Fixture` to the real 12-byte stock layout and assert stock decoder output**

```js
// Stock MOD=3 wire: [0-1]oil_mV [2-3]ADC_1_mV [4-5]ADC_2_mV [6]status|0x08
// [7-10] SHT temp*10, hum*10  [11] batt_mV/100
const stockMod3Buf = Buffer.alloc(12);
stockMod3Buf.writeUInt16BE(1500, 0);   // PA0 = 1.500 V
stockMod3Buf.writeUInt16BE(3000, 2);   // PA1 = 3.000 V
stockMod3Buf.writeUInt16BE(0,    4);   // PA4 = 0.000 V
stockMod3Buf[6] = 0x08;                // mode nibble 2 → MOD3
stockMod3Buf.writeInt16BE(205, 7);     // SHT temp 20.5
stockMod3Buf.writeInt16BE(550, 9);     // SHT hum 55.0
stockMod3Buf[11] = 33;                 // batt 3.3 V
const stockMod3Fixture = stockMod3Buf.toString('base64');

const decoded = decodeRawAdcPayload(stockMod3Fixture);
assert.strictEqual(decoded.modeLabel, 'MOD3', 'stock MOD=3 fixture should decode as MOD3');
assert.strictEqual(decoded.adcCh0V, 1.5);
assert.strictEqual(decoded.adcCh1V, 3.0);
assert.strictEqual(decoded.adcCh4V, 0.0);

const metrics = buildDendroDerivedMetrics({
  adcCh0V: decoded.adcCh0V,
  adcCh1V: decoded.adcCh1V,
  effectiveMode: 3,
});
assert.strictEqual(metrics.dendroModeUsed, 'ratio_mod3');
assert.strictEqual(metrics.dendroRatio, 0.5);
```

- [ ] **Step 3: Run verify-sync-flow**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
node scripts/verify-sync-flow.js
```

Expected: all assertions pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-sync-flow.js
git commit -m "test(verify): cover stock 12-byte MOD=3 fixture, drop 8-byte custom fixtures"
```

---

## Task 12: End-to-end smoke test on staging Pi

**Files:** none (manual verification)

- [ ] **Step 1: Deploy updated `osi-dendro-helper` and `flows.json` to Silvan staging Pi (100.81.220.8)**

Use the existing safe-deploy wrapper. Do not overwrite `/data/db/farming.db`.

- [ ] **Step 2: Restart Node-RED**

```bash
ssh root@100.81.220.8 '/etc/init.d/node-red restart'
```

- [ ] **Step 3: Flash firmware to a test LSN50 V2 with dendrometer wiring**

Confirm first uplink arrives. On gateway, query:

```bash
ssh root@100.81.220.8 'sqlite3 /data/db/farming.db \
  "SELECT deveui, recorded_at, adc_ch0v, adc_ch1v, adc_ch4v, dendro_position_mm \
   FROM device_data WHERE deveui = ?<TEST_DEVEUI>? \
   ORDER BY recorded_at DESC LIMIT 3;"'
```

Expected: `adc_ch0v` and `adc_ch1v` populated from the dendrometer divider (non-zero, ratio-consistent), `dendro_position_mm` non-null when calibration is present.

- [ ] **Step 4: Spot-check Node-RED debug console for decoder errors**

No `decodeRawAdcPayload` or `buildDendroDerivedMetrics` errors in `/var/log/messages` or the Node-RED debug pane.

---

## Self-Review

Spec coverage (against the user's confirmed choices):

- **A1 — firmware emits stock 12-byte MOD=3 wire layout** → Task 4 (restore stock packer) + Task 3 (populate stock sensor_t fields from dendrometer).
- **B2 — SHT/BH1750 bytes stay in the wire** → Task 4 preserves `#if defined USE_SHT` SHT block verbatim; Task 3 leaves the I²C read block at bsp.c L154 untouched.
- **C — new `else if(mode==3)` block above stock branch** → Task 3.
- **20-sample paired oversampling on PA0/PA1** → Task 2 (dendrometer.c body).
- **PA4 stock 6-sample** → Task 3 step 2.
- **No PB4 / OIL_CONTROL usage on new mode==3 path** → Task 3 step 2 omits `BSP_oil_float_Init` and the final `HAL_GPIO_WritePin` SET; explicit comment in the code.
- **Gateway decodes stock 12-byte MOD=3 and computes ratio** → Task 7 (new decoder) + Task 8 (tests) + Task 11 (verifier).
- **measurementValid threading gone** → Task 7 step 1 + Task 10.
- **REF_HIGH guard (VDDA-sag protection)** → Task 9 (code + tests) + Task 10 step 3 (batV threading in flows.json).
- **`sensor_t.dendro` removed** → Task 5.
- **README updated** → Task 6.

Cross-task consistency:

- `dendrometer_result_t` in Task 1 uses `signal_raw` / `reference_raw`; Task 2's `dendrometer.c` writes those names; Task 3's `bsp.c` snippet reads `dendro_samples.signal_raw` / `dendro_samples.reference_raw`.
- `decodeStockMod3Payload` return shape in Task 7 (`adcCh0V`, `adcCh1V`, `adcCh4V`, `modeLabel`, `modeCode`, `batV`, `tempC1`, `statusByte`, `switchStatus`) matches the fields consumed by `buildDendroDerivedMetrics` (Task 8 and Task 10 tests).
- Wire layout in Task 4 (C) and Task 7 (JS) match byte-for-byte: `oil_mV` at 0-1, `ADC_1_mV` at 2-3, `ADC_2_mV` at 4-5, status at 6, SHT/BH1750 at 7-10, battery/100 at 11.

Ambiguity resolved inline:

- `tempC1` in MOD=3: stock packer does not write temp1 into MOD=3; the stock decoder returns `null`. Legacy LSN50 decoder path remains available for non-MOD=3 frames and is unaffected.
- No-`USE_SHT` production: Task 8 step 2 documents that production always ships with `USE_SHT` defined; the 8-byte fallback path is tolerated by the legacy decoder but not promoted.

---

## Notes for the executor

- Work in worktrees for both repos. The firmware branch `feature/ratiometric-dendrometer-claude` is already checked out at `/home/phil/Repos/LoRa_STM32-claude`. The gateway branch `feature/lsn50-dendrometer-decoder-claude` is already checked out at `/home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude`.
- Do **not** flash production devices from within the automated flow. Task 11 is a human checkpoint.
- Keep commits small and scoped per task. Push each branch to origin only after all tasks on that side are complete and the respective test suite passes.
