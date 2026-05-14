# LSN50 Chameleon Firmware V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the next Dragino LSN50 v2 Chameleon firmware revision as a Chameleon-specific image that runs MOD=3 from first boot and emits a smaller Chameleon V2 uplink that omits routine raw resistance values while preserving decoder compatibility with deployed V1 frames.

**Architecture:** Keep the first 8 bytes stock-MOD3-aligned so the frame still carries ADC/status/battery and remains recognizable as Dragino `3ADC+IIC`. Add payload version `0x02` at byte 8 and encode only a simplified status byte, temperature, compensated resistances, and array ID after that prefix. Force MOD=3 for `USE_CHAMELEON` after EEPROM config reads so stale device config cannot leave the standalone Chameleon firmware in another LSN50 mode. Update the OSI OS decoder to support both V1 and V2; V2 leaves raw resistance fields absent/null because raw values are diagnostics, not SWT inputs.

**Tech Stack:** STM32L072CZ Dragino LSN50 firmware in `/home/phil/Repos/LoRa_STM32-claude`, GCC arm-none-eabi build harness, native C host tests, OSI OS Node-RED JavaScript codec/verifier tests in `/home/phil/Repos/osi-os`.

---

## Payload Decision

Current decoded payload fields from the gateway:

```text
Chameleon_R2_Ohm_Raw
Chameleon_CH2_Open
Chameleon_ID_Fault
ADC_CH0V
Digital_IStatus
Chameleon_R3_Ohm_Raw
Chameleon_Payload_Version
ADC_CH1V
Chameleon_CH1_Open
Chameleon_R2_Ohm_Comp
Chameleon_I2C_Missing
Chameleon_CH3_Open
EXTI_Trigger
Chameleon_Timeout
BatV
Chameleon_R3_Ohm_Comp
Chameleon_Array_ID
ADC_CH4V
Work_mode
Chameleon_Status_Flags
Node_type
Chameleon_R1_Ohm_Raw
Chameleon_Temp_Fault
Chameleon_TempC
Door_status
Chameleon_R1_Ohm_Comp
```

Recommended omission from the LoRaWAN frame:

- Omit `Chameleon_R1_Ohm_Raw`, `Chameleon_R2_Ohm_Raw`, and `Chameleon_R3_Ohm_Raw` from routine V2 uplinks.
- Keep `Chameleon_R1_Ohm_Comp`, `Chameleon_R2_Ohm_Comp`, and `Chameleon_R3_Ohm_Comp`; these are the canonical SWT conversion inputs.
- Keep `Chameleon_Array_ID`; it is needed to detect probe swaps and later attach array-specific calibration.
- Keep `Chameleon_TempC`; it is useful telemetry and validates the Chameleon reader/probe path.
- Keep one `Chameleon_Status_Flags` byte, but simplify its V2 meaning. A status byte still matters because otherwise an acquisition failure would look like real zero-valued resistance/temperature. We do **not** need all V1 flag bits in routine V2 uplinks.
- Keep `BatV`.
- Keep the stock MOD3 ADC/status prefix (`ADC_CH0V`, `ADC_CH1V`, `ADC_CH4V`, `Digital_IStatus`, `EXTI_Trigger`, `Door_status`, `Work_mode`) for now. The ADC values are ignored when dendrometer is disabled, but preserving them keeps the firmware compatible with the current LSN50 MOD3 flow and allows Chameleon and dendrometer derivation to coexist on one uplink.
- `Node_type` is not sent by firmware; it is a decoder/flow label. Do not make firmware changes for it.

The V2 frame is 32 bytes instead of 44 bytes, saving 12 bytes per uplink.

V2 status byte:

| Bit | V2 meaning | Rationale |
|---|---|---|
| 0 | `DATA_INVALID` | Collapses V1 `I2C_MISSING` and `TIMEOUT`/read-failure into one "do not trust trailing Chameleon fields" condition. The field unit does not need to spend payload semantics distinguishing unpowered reader from timeout on every routine uplink. |
| 1 | `TEMP_FAULT` | Keeps DS18B20/temperature invalid separate so resistance/SWT can still be valid when only temperature is bad. |
| 2 | `ID_FAULT` | Keeps array ID validity separate so readings can still be processed while the probe identity is unavailable. |
| 3-7 | reserved, always 0 | No channel-open flags in V2. Channel open is derived by the decoder from compensated resistance equal to `10_000_000` ohm. Dry-connected probes at `9_999_999` raw ohm remain valid and are not flagged open. |

V1 flags remain supported in the decoder for already-flashed devices.

## File Map

Firmware repo: `/home/phil/Repos/LoRa_STM32-claude`

- Modify `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h`
  - Add `CHAMELEON_PAYLOAD_VERSION_V2`, `CHAMELEON_PAYLOAD_LEN_V2`, and `chameleon_payload_encode_v2()`.
- Modify `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/chameleon_payload.c`
  - Add the compact V2 encoder and keep V1 unchanged for compatibility.
- Modify `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`
  - Use `chameleon_payload_encode_v2()` in the `USE_CHAMELEON` MOD3 send branch.
- Modify `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/lora.c`
  - Initialize `mode=3` under `USE_CHAMELEON`, set `mode=3` in `fdr_config()`, and force `mode=3` after `EEPROM_Read_Config()` loads stored config. This makes the Chameleon image MOD3-only even when flashed over a device whose EEPROM still says another mode.
- Modify `tests/test_chameleon_payload.c`
  - Add known-sample tests for the 32-byte V2 encoder and retain V1 tests.
- Create `tests/test_chameleon_fdr_defaults.c`
  - Textual regression test for the Chameleon-only FDR default mode.
- Modify `tests/Makefile`
  - Add the new FDR default test target.
- Modify `README-chameleon-claude.md`
  - Document V2 payload shape and V1 compatibility.

OSI OS repo: `/home/phil/Repos/osi-os`

- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js`
  - Decode Chameleon V2 alongside V1. V2 does not emit raw resistance fields, and V2 exposes `Chameleon_Data_Invalid` instead of separate `Chameleon_I2C_Missing` / `Chameleon_Timeout`.
- Modify `scripts/verify-lsn50-chameleon-codec.js`
  - Add V2 fixture and keep existing V1/dry/fault coverage.
- Modify `scripts/verify-lsn50-chameleon-persistence.js`
  - Verify V2 `Chameleon_Data_Invalid` normalization and omitted raw fields store as `NULL`.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
  - Normalize `Chameleon_Data_Invalid` into `formattedData.chameleonDataInvalid` and use it to null invalid V2 measurements before inserting `chameleon_readings`.
- Modify `scripts/verify-sync-flow.js`
  - Add a source assertion that the shipped LSN50 decoder recognizes Chameleon payload version 2.

## Code Quality Notes

- KISS/YAGNI: do not add a runtime payload selector or new LoRaWAN port. V2 is the Chameleon build default; V1 remains only in code/tests for decoder compatibility with already deployed firmware.
- SoC: firmware owns byte packing and default MOD; OSI OS owns decoded field names and database null semantics.
- DRY: keep flag decoding in one helper in the JavaScript codec so V1 and V2 do not drift.
- Data integrity: do not infer open/dry state from raw saturation. In V2, only compensated `10_000_000` ohm derives channel-open state; raw values are not transmitted.

---

## Tasks

### Task 1: Firmware V2 Payload Tests

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/tests/test_chameleon_payload.c`

- [ ] **Step 1: Add failing V2 encoder tests**

Insert the following function after `test_encode_known_sample()`:

```c
static void test_encode_v2_known_sample(void) {
    chameleon_sample_t s = {
        .adc_pa0_mv       = 1010,
        .adc_pa1_mv       = 2020,
        .adc_pa4_mv       = 3030,
        .mod3_status      = 0x08,
        .battery_mv       = 3300,
        .status_flags     = 0,
        .soil_temp_c_x100 = 1987,
        .r1_ohm_comp      = 1100,
        .r2_ohm_comp      = 10100,
        .r3_ohm_comp      = 101200,
        .r1_ohm_raw       = 1200,
        .r2_ohm_raw       = 10200,
        .r3_ohm_raw       = 102200,
        .array_id         = {0x28, 0x6D, 0x6A, 0xDB, 0x0F, 0x00, 0x00, 0xF1},
    };
    uint8_t buf[34];
    memset(buf, 0xAA, sizeof(buf));
    size_t n = chameleon_payload_encode_v2(buf, sizeof(buf), &s);
    ASSERT_EQ_U32(n, 32, "v2 len");

    ASSERT_EQ_U32(buf[0], 0x03, "v2 adc0 hi");
    ASSERT_EQ_U32(buf[1], 0xF2, "v2 adc0 lo");
    ASSERT_EQ_U32(buf[2], 0x07, "v2 adc1 hi");
    ASSERT_EQ_U32(buf[3], 0xE4, "v2 adc1 lo");
    ASSERT_EQ_U32(buf[4], 0x0B, "v2 adc4 hi");
    ASSERT_EQ_U32(buf[5], 0xD6, "v2 adc4 lo");
    ASSERT_EQ_U32(buf[6], 0x08, "v2 mod3 status");
    ASSERT_EQ_U32(buf[7], 0x21, "v2 battery / 100");
    ASSERT_EQ_U32(buf[8], 0x02, "v2 version");
    ASSERT_EQ_U32(buf[9], 0x00, "v2 flags");
    ASSERT_EQ_U32(buf[10], 0x07, "v2 temp hi");
    ASSERT_EQ_U32(buf[11], 0xC3, "v2 temp lo");
    ASSERT_EQ_U32(buf[12], 0x00, "v2 r1 b0");
    ASSERT_EQ_U32(buf[13], 0x00, "v2 r1 b1");
    ASSERT_EQ_U32(buf[14], 0x04, "v2 r1 b2");
    ASSERT_EQ_U32(buf[15], 0x4C, "v2 r1 b3");
    ASSERT_EQ_U32(buf[16], 0x00, "v2 r2 b0");
    ASSERT_EQ_U32(buf[17], 0x00, "v2 r2 b1");
    ASSERT_EQ_U32(buf[18], 0x27, "v2 r2 b2");
    ASSERT_EQ_U32(buf[19], 0x74, "v2 r2 b3");
    ASSERT_EQ_U32(buf[20], 0x00, "v2 r3 b0");
    ASSERT_EQ_U32(buf[21], 0x01, "v2 r3 b1");
    ASSERT_EQ_U32(buf[22], 0x8B, "v2 r3 b2");
    ASSERT_EQ_U32(buf[23], 0x50, "v2 r3 b3");
    ASSERT_EQ_U32(buf[24], 0x28, "v2 id 0");
    ASSERT_EQ_U32(buf[31], 0xF1, "v2 id 7");
    ASSERT_EQ_U32(buf[32], 0xAA, "v2 no overflow");
}
```

Insert this function after `test_encode_v2_known_sample()`:

```c
static void test_encode_v2_simplifies_status_flags(void) {
    chameleon_sample_t s = {
        .adc_pa0_mv       = 0,
        .adc_pa1_mv       = 0,
        .adc_pa4_mv       = 0,
        .mod3_status      = 0x08,
        .battery_mv       = 3000,
        .status_flags     = CHAMELEON_FLAG_I2C_MISSING | CHAMELEON_FLAG_TIMEOUT |
                            CHAMELEON_FLAG_TEMP_FAULT | CHAMELEON_FLAG_ID_FAULT |
                            CHAMELEON_FLAG_CH1_OPEN | CHAMELEON_FLAG_CH2_OPEN |
                            CHAMELEON_FLAG_CH3_OPEN,
        .soil_temp_c_x100 = -12700,
        .r1_ohm_comp      = 10000000U,
        .r2_ohm_comp      = 0,
        .r3_ohm_comp      = 0,
        .r1_ohm_raw       = 10000000U,
        .r2_ohm_raw       = 0,
        .r3_ohm_raw       = 0,
        .array_id         = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF},
    };
    uint8_t buf[32];
    size_t n = chameleon_payload_encode_v2(buf, sizeof(buf), &s);
    ASSERT_EQ_U32(n, 32, "v2 flag len");
    ASSERT_EQ_U32(buf[8], 0x02, "v2 flag version");
    ASSERT_EQ_U32(buf[9], 0x07, "v2 simplified flags");
    ASSERT_EQ_U32(buf[12], 0x00, "v2 10M b0");
    ASSERT_EQ_U32(buf[13], 0x98, "v2 10M b1");
    ASSERT_EQ_U32(buf[14], 0x96, "v2 10M b2");
    ASSERT_EQ_U32(buf[15], 0x80, "v2 10M b3");
}
```

Add these calls in `main()` before `test_encode_negative_temp_and_flags();`:

```c
    test_encode_v2_known_sample();
    test_encode_v2_simplifies_status_flags();
```

- [ ] **Step 2: Run the payload test and verify it fails**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make build/test_chameleon_payload
```

Expected: compile failure because `chameleon_payload_encode_v2` is not declared.

- [ ] **Step 3: Commit the failing test**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/test_chameleon_payload.c
git commit -m "test: add chameleon v2 payload fixture"
```

### Task 2: Firmware V2 Encoder And Send Path

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/chameleon_payload.c`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`

- [ ] **Step 1: Add V2 declarations**

In `inc/chameleon_payload.h`, add these definitions below the V1 definitions:

```c
#define CHAMELEON_PAYLOAD_VERSION_V2   0x02
#define CHAMELEON_PAYLOAD_LEN_V2       32U

#define CHAMELEON_V2_FLAG_DATA_INVALID (1U << 0)
#define CHAMELEON_V2_FLAG_TEMP_FAULT   (1U << 1)
#define CHAMELEON_V2_FLAG_ID_FAULT     (1U << 2)
```

Add this prototype below `chameleon_payload_encode_v1()`:

```c
/* Encode the compact 32-byte V2 frame. V2 keeps the stock MOD=3 prefix and
 * omits raw resistance fields; raw diagnostics remain available through V1. */
size_t chameleon_payload_encode_v2(uint8_t *buf, size_t buf_len,
                                   const chameleon_sample_t *sample);
```

- [ ] **Step 2: Implement V2 status mapping and encoder**

In `src/chameleon_payload.c`, add this helper above `chameleon_payload_encode_v1()`:

```c
static uint8_t chameleon_payload_status_v2(uint8_t v1_flags) {
    uint8_t out = 0;
    if (v1_flags & (CHAMELEON_FLAG_I2C_MISSING | CHAMELEON_FLAG_TIMEOUT)) {
        out |= CHAMELEON_V2_FLAG_DATA_INVALID;
    }
    if (v1_flags & CHAMELEON_FLAG_TEMP_FAULT) {
        out |= CHAMELEON_V2_FLAG_TEMP_FAULT;
    }
    if (v1_flags & CHAMELEON_FLAG_ID_FAULT) {
        out |= CHAMELEON_V2_FLAG_ID_FAULT;
    }
    return out;
}
```

Then add this function after `chameleon_payload_encode_v1()`:

```c
size_t chameleon_payload_encode_v2(uint8_t *buf, size_t buf_len,
                                   const chameleon_sample_t *sample) {
    if (buf == 0 || sample == 0) { return 0; }
    if (buf_len < CHAMELEON_PAYLOAD_LEN_V2) { return 0; }

    put_u16_be(&buf[0], sample->adc_pa0_mv);
    put_u16_be(&buf[2], sample->adc_pa1_mv);
    put_u16_be(&buf[4], sample->adc_pa4_mv);
    buf[6] = sample->mod3_status;
    buf[7] = (uint8_t)(sample->battery_mv / 100U);
    buf[8] = CHAMELEON_PAYLOAD_VERSION_V2;
    buf[9] = chameleon_payload_status_v2(sample->status_flags);
    put_u16_be(&buf[10], (uint16_t)sample->soil_temp_c_x100);
    put_u32_be(&buf[12], sample->r1_ohm_comp);
    put_u32_be(&buf[16], sample->r2_ohm_comp);
    put_u32_be(&buf[20], sample->r3_ohm_comp);
    for (size_t i = 0; i < 8; i++) { buf[24 + i] = sample->array_id[i]; }
    return CHAMELEON_PAYLOAD_LEN_V2;
}
```

- [ ] **Step 3: Use V2 in the Chameleon send path**

In `src/main.c`, replace:

```c
		i = chameleon_payload_encode_v1(AppData.Buff, LORAWAN_APP_DATA_BUFF_SIZE, &cs);
```

with:

```c
		i = chameleon_payload_encode_v2(AppData.Buff, LORAWAN_APP_DATA_BUFF_SIZE, &cs);
```

- [ ] **Step 4: Run the payload test and verify it passes**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make build/test_chameleon_payload
./build/test_chameleon_payload
```

Expected: `test_chameleon_payload OK`.

- [ ] **Step 5: Build the firmware**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon
./build.sh chameleon-dummy
ls -l LSN50-chameleon.hex LSN50-chameleon-dummy.hex
```

Expected: both `.hex` files exist and the build completes without errors.

- [ ] **Step 6: Commit the encoder and send-path change**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h' \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/chameleon_payload.c' \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c'
git commit -m "feat: use compact chameleon v2 payload"
```

### Task 3: Chameleon MOD3-Only Defaults

**Files:**
- Create: `/home/phil/Repos/LoRa_STM32-claude/tests/test_chameleon_fdr_defaults.c`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/tests/Makefile`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/at.c`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/lora.c`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`

- [ ] **Step 1: Add the failing MOD3-only default test**

Create `tests/test_chameleon_fdr_defaults.c`:

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *read_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "failed to open %s\n", path);
        exit(1);
    }
    if (fseek(f, 0, SEEK_END) != 0) exit(1);
    long n = ftell(f);
    if (n < 0) exit(1);
    rewind(f);
    char *buf = (char *)calloc((size_t)n + 1U, 1U);
    if (!buf) exit(1);
    if (fread(buf, 1U, (size_t)n, f) != (size_t)n) exit(1);
    fclose(f);
    return buf;
}

static void assert_contains(const char *haystack, const char *needle, const char *label) {
    if (!strstr(haystack, needle)) {
        fprintf(stderr, "FAIL %s: missing [%s]\n", label, needle);
        exit(1);
    }
}

static char *copy_between(const char *source, const char *start_marker, const char *end_marker, const char *label) {
    const char *start = strstr(source, start_marker);
    const char *end;
    size_t len;
    char *section;

    if (!start) {
        fprintf(stderr, "FAIL %s: missing start marker [%s]\n", label, start_marker);
        exit(1);
    }
    end = strstr(start, end_marker);
    if (!end) {
        fprintf(stderr, "FAIL %s: missing end marker [%s]\n", label, end_marker);
        exit(1);
    }
    len = (size_t)(end - start);
    section = (char *)calloc(len + 1U, 1U);
    if (!section) exit(1);
    memcpy(section, start, len);
    return section;
}

int main(void) {
    char *lora = read_file("../STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/lora.c");
    char *at = read_file("../STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/at.c");
    char *main_source = read_file("../STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c");
    char *at_mod_set = copy_between(at, "ATEerror_t at_MOD_set", "ATEerror_t at_MOD_get", "at_MOD_set");
    char *downlink_mod_case = copy_between(main_source, "case 0x0A:", "case 0x20:", "downlink MOD case");

    assert_contains(lora, "#ifdef USE_CHAMELEON\nuint8_t mode=3;\n#else\nuint8_t mode;\n#endif", "chameleon mode initializer");
    assert_contains(lora, "#ifdef USE_CHAMELEON\n\tmode=3;\n#else\n\tmode=1;\n#endif", "fdr chameleon mode");
    assert_contains(lora, "Chameleon firmware is MOD3-only", "eeprom force comment");
    assert_contains(lora, "#ifdef USE_CHAMELEON\n\tmode=3;\n#endif", "eeprom read forces mode 3");
    assert_contains(at_mod_set, "#ifdef USE_CHAMELEON\n\tif (workmode != 3)\n\t{\n\t\tPPRINTF(\"Chameleon firmware supports MOD=3 only\\r\\n\");\n\t\treturn AT_PARAM_ERROR;\n\t}\n#endif", "at mod rejects non-3 chameleon mode");
    assert_contains(at_mod_set, "Chameleon firmware supports MOD=3 only", "at mod chameleon message");
    assert_contains(downlink_mod_case, "#ifdef USE_CHAMELEON\n\t\t\t\t\tmode=0x03;\n#else\n\t\t\t\t\tmode=AppData->Buff[1];\n#endif", "downlink mod clamps chameleon mode");

    free(downlink_mod_case);
    free(at_mod_set);
    free(main_source);
    free(at);
    free(lora);
    puts("test_chameleon_fdr_defaults OK");
    return 0;
}
```

In `tests/Makefile`, add `chameleon_fdr_defaults` to `TESTS`:

```make
TESTS := harness_smoke chameleon_payload chameleon_driver chameleon_dummy battery_level_typo chameleon_fdr_defaults
```

Add this target:

```make
$(OBJDIR)/test_chameleon_fdr_defaults: test_chameleon_fdr_defaults.c | $(OBJDIR)
	$(CC) $(CFLAGS) -o $@ test_chameleon_fdr_defaults.c
```

- [ ] **Step 2: Run the MOD3-only default test and verify it fails**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make build/test_chameleon_fdr_defaults
./build/test_chameleon_fdr_defaults
```

Expected: failure because `lora.c` still declares `uint8_t mode;`, sets `mode=1;` in `fdr_config()`, accepts EEPROM-loaded modes without a Chameleon override, and the runtime AT/downlink MOD setters can still move Chameleon builds away from MOD3.

- [ ] **Step 3: Initialize Chameleon builds to MOD3**

In `src/lora.c`, replace the global mode declaration:

```c
uint8_t mode;
```

with:

```c
#ifdef USE_CHAMELEON
uint8_t mode=3;
#else
uint8_t mode;
#endif
```

- [ ] **Step 4: Set Chameleon FDR config to MOD3**

In `src/lora.c::fdr_config()`, replace:

```c
	mode=1;			
```

with:

```c
#ifdef USE_CHAMELEON
	mode=3;
#else
	mode=1;
#endif
```

- [ ] **Step 5: Force stale EEPROM config back to MOD3 for Chameleon builds**

In `src/lora.c::EEPROM_Read_Config()`, replace the final assignment block:

```c
	LinkADR_NbTrans_retransmission_nbtrials=r_config[18]>>8&0xFF;
	LinkADR_NbTrans_uplink_counter_retransmission_increment_switch=r_config[18]&0xFF;
	
	unconfirmed_uplink_change_to_confirmed_uplink_timeout=r_config[19]&0xFFFF;
}
```

with:

```c
	LinkADR_NbTrans_retransmission_nbtrials=r_config[18]>>8&0xFF;
	LinkADR_NbTrans_uplink_counter_retransmission_increment_switch=r_config[18]&0xFF;
	
	unconfirmed_uplink_change_to_confirmed_uplink_timeout=r_config[19]&0xFFFF;

#ifdef USE_CHAMELEON
	/* Chameleon firmware is MOD3-only; ignore stale EEPROM modes from older LSN50 images. */
	mode=3;
#endif
}
```

- [ ] **Step 6: Reject non-MOD3 AT mode writes in Chameleon builds**

In `src/at.c::at_MOD_set()`, after `workmode` is parsed and validated as a numeric mode, add:

```c
#ifdef USE_CHAMELEON
	if (workmode != 3)
	{
		PPRINTF("Chameleon firmware supports MOD=3 only\r\n");
		return AT_PARAM_ERROR;
	}
#endif
```

This keeps stock builds configurable while making the Chameleon image a dedicated MOD3 firmware even when an operator sends `AT+MOD=<n>`.

- [ ] **Step 7: Clamp downlink MOD writes in Chameleon builds**

In `src/main.c`, inside the downlink `case 0x0A:` MOD handler, keep the stock validity check but store `0x03` under `USE_CHAMELEON`:

```c
#ifdef USE_CHAMELEON
					mode=0x03;
#else
					mode=AppData->Buff[1];
#endif
```

This prevents queued cloud/downlink mode commands from moving already-deployed Chameleon devices out of the acquisition path.

- [ ] **Step 8: Run host tests**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean && make test
```

Expected: all host tests pass, including text assertions for boot defaults, FDR defaults, EEPROM clamping, AT rejection, and downlink clamping.

- [ ] **Step 9: Commit the MOD3-only default**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/test_chameleon_fdr_defaults.c tests/Makefile \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/at.c' \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c' \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/lora.c'
git commit -m "feat: default chameleon firmware to mod3"
```

### Task 4: OSI OS Decoder V2 Support

**Files:**
- Modify: `/home/phil/Repos/osi-os/scripts/verify-lsn50-chameleon-codec.js`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js`
- Modify: `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js`

- [ ] **Step 1: Add a failing V2 codec fixture**

In `scripts/verify-lsn50-chameleon-codec.js`, add this fixture after the existing `chameleon` assertions and before `faultFrame`:

```js
const chameleonV2Frame = [
  0x03, 0xf2, // ADC PA0 = 1010 mV
  0x07, 0xe4, // ADC PA1 = 2020 mV
  0x0b, 0xd6, // ADC PA4 = 3030 mV
  0x08,       // stock status/mode byte, mode code 2
  0x21,       // battery / 100 = 3.3 V
  0x02,       // Chameleon payload version 2
  0x00,       // Chameleon status flags
  0x07, 0xc3, // soil temperature = 19.87 C
  0x00, 0x00, 0x04, 0x4c, // R1 compensated = 1100 ohm
  0x00, 0x00, 0x27, 0x74, // R2 compensated = 10100 ohm
  0x00, 0x01, 0x8b, 0x50, // R3 compensated = 101200 ohm
  0x28, 0x6d, 0x6a, 0xdb, 0x0f, 0x00, 0x00, 0xf1
];

const chameleonV2 = decode(chameleonV2Frame);
assert.strictEqual(chameleonV2.Work_mode, '3ADC+IIC');
assert.strictEqual(chameleonV2.BatV, 3.3);
assert.strictEqual(chameleonV2.ADC_CH0V, 1.01);
assert.strictEqual(chameleonV2.ADC_CH1V, 2.02);
assert.strictEqual(chameleonV2.ADC_CH4V, 3.03);
assert.strictEqual(chameleonV2.Chameleon_Payload_Version, 2);
assert.strictEqual(chameleonV2.Chameleon_Status_Flags, 0);
assert.strictEqual(chameleonV2.Chameleon_Data_Invalid, false);
assert.strictEqual(chameleonV2.Chameleon_I2C_Missing, undefined);
assert.strictEqual(chameleonV2.Chameleon_Timeout, undefined);
assert.strictEqual(chameleonV2.Chameleon_TempC, 19.87);
assert.strictEqual(chameleonV2.Chameleon_R1_Ohm_Comp, 1100);
assert.strictEqual(chameleonV2.Chameleon_R2_Ohm_Comp, 10100);
assert.strictEqual(chameleonV2.Chameleon_R3_Ohm_Comp, 101200);
assert.strictEqual(chameleonV2.Chameleon_R1_Ohm_Raw, undefined);
assert.strictEqual(chameleonV2.Chameleon_R2_Ohm_Raw, undefined);
assert.strictEqual(chameleonV2.Chameleon_R3_Ohm_Raw, undefined);
assert.strictEqual(chameleonV2.Chameleon_Array_ID, '286D6ADB0F0000F1');

const chameleonV2FaultFrame = chameleonV2Frame.slice();
chameleonV2FaultFrame[9] = 0x07; // data invalid + temp fault + id fault
for (let i = 10; i < chameleonV2FaultFrame.length; i += 1) {
  chameleonV2FaultFrame[i] = 0x00;
}
const chameleonV2Fault = decode(chameleonV2FaultFrame);
assert.strictEqual(chameleonV2Fault.Chameleon_Payload_Version, 2);
assert.strictEqual(chameleonV2Fault.Chameleon_Status_Flags, 0x07);
assert.strictEqual(chameleonV2Fault.Chameleon_Data_Invalid, true);
assert.strictEqual(chameleonV2Fault.Chameleon_Temp_Fault, true);
assert.strictEqual(chameleonV2Fault.Chameleon_ID_Fault, true);
assert.strictEqual(chameleonV2Fault.Chameleon_TempC, 'NULL');
assert.strictEqual(chameleonV2Fault.Chameleon_R1_Ohm_Comp, 'NULL');
assert.strictEqual(chameleonV2Fault.Chameleon_Array_ID, 'NULL');

const chameleonV2OpenFrame = chameleonV2Frame.slice();
chameleonV2OpenFrame.splice(12, 4, 0x00, 0x98, 0x96, 0x80); // R1 compensated = 10000000 ohm
const chameleonV2Open = decode(chameleonV2OpenFrame);
assert.strictEqual(chameleonV2Open.Chameleon_CH1_Open, true);
assert.strictEqual(chameleonV2Open.Chameleon_CH2_Open, false);
assert.strictEqual(chameleonV2Open.Chameleon_R1_Ohm_Comp, 'NULL');
assert.strictEqual(chameleonV2Open.Chameleon_R2_Ohm_Comp, 10100);
```

In `scripts/verify-sync-flow.js`, add this assertion near the existing `dragino_lsn50_decoder.js` assertions:

```js
expectFileIncludes('dragino_lsn50_decoder.js', lsn50CodecSource, 'function isChameleonV2Frame(bytes)', 'ships Chameleon V2 frame detection');
expectFileIncludes('dragino_lsn50_decoder.js', lsn50CodecSource, 'decode.Chameleon_Data_Invalid', 'ships simplified Chameleon V2 status handling');
```

- [ ] **Step 2: Run the codec test and verify it fails**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-lsn50-chameleon-codec.js
```

Expected: failure because version 2 is not decoded yet.

- [ ] **Step 3: Implement V1/V2 decoder helpers**

In `dragino_lsn50_decoder.js`, replace the existing Chameleon helper block from `function isChameleonV1Frame(bytes)` through `decode.Chameleon_Array_ID = ...;` with:

```js
function isChameleonV1Frame(bytes) {
  return bytes.length >= 44 && bytes[8] == 0x01;
}

function isChameleonV2Frame(bytes) {
  return bytes.length >= 32 && bytes[8] == 0x02;
}

function readChameleonResistance(bytes, offset, dataInvalid, channelOpen) {
  if(dataInvalid || channelOpen)
    return "NULL";
  return readUInt32BE(bytes, offset);
}

function readChameleonResistanceValue(bytes, offset) {
  return readUInt32BE(bytes, offset);
}

function decodeChameleonV1(decode, bytes) {
  var status_flags = bytes[9];
  var soil_temp_c_x100 = readInt16BE(bytes, 10);
  var dataInvalid;

  decode.Chameleon_Payload_Version = 1;
  decode.Chameleon_Status_Flags = status_flags;
  decode.Chameleon_I2C_Missing = (status_flags & 0x01) ? true : false;
  decode.Chameleon_Timeout = (status_flags & 0x02) ? true : false;
  decode.Chameleon_Temp_Fault = (status_flags & 0x04) ? true : false;
  decode.Chameleon_ID_Fault = (status_flags & 0x08) ? true : false;
  decode.Chameleon_CH1_Open = (status_flags & 0x10) ? true : false;
  decode.Chameleon_CH2_Open = (status_flags & 0x20) ? true : false;
  decode.Chameleon_CH3_Open = (status_flags & 0x40) ? true : false;
  dataInvalid = decode.Chameleon_I2C_Missing || decode.Chameleon_Timeout;

  if(dataInvalid || decode.Chameleon_Temp_Fault || soil_temp_c_x100 == -12700)
    decode.Chameleon_TempC = "NULL";
  else
    decode.Chameleon_TempC = parseFloat((soil_temp_c_x100 / 100).toFixed(2));

  decode.Chameleon_R1_Ohm_Comp = readChameleonResistance(bytes, 12, dataInvalid, decode.Chameleon_CH1_Open);
  decode.Chameleon_R2_Ohm_Comp = readChameleonResistance(bytes, 16, dataInvalid, decode.Chameleon_CH2_Open);
  decode.Chameleon_R3_Ohm_Comp = readChameleonResistance(bytes, 20, dataInvalid, decode.Chameleon_CH3_Open);
  decode.Chameleon_R1_Ohm_Raw = readChameleonResistance(bytes, 24, dataInvalid, decode.Chameleon_CH1_Open);
  decode.Chameleon_R2_Ohm_Raw = readChameleonResistance(bytes, 28, dataInvalid, decode.Chameleon_CH2_Open);
  decode.Chameleon_R3_Ohm_Raw = readChameleonResistance(bytes, 32, dataInvalid, decode.Chameleon_CH3_Open);
  decode.Chameleon_Array_ID = (dataInvalid || decode.Chameleon_ID_Fault) ? "NULL" : bytesToHex(bytes, 36, 8);
}

function decodeChameleonV2(decode, bytes) {
  var status_flags = bytes[9];
  var soil_temp_c_x100 = readInt16BE(bytes, 10);
  var dataInvalid;
  var r1 = readChameleonResistanceValue(bytes, 12);
  var r2 = readChameleonResistanceValue(bytes, 16);
  var r3 = readChameleonResistanceValue(bytes, 20);

  decode.Chameleon_Payload_Version = 2;
  decode.Chameleon_Status_Flags = status_flags;
  decode.Chameleon_Data_Invalid = (status_flags & 0x01) ? true : false;
  decode.Chameleon_Temp_Fault = (status_flags & 0x02) ? true : false;
  decode.Chameleon_ID_Fault = (status_flags & 0x04) ? true : false;
  dataInvalid = decode.Chameleon_Data_Invalid;

  decode.Chameleon_CH1_Open = dataInvalid ? null : (r1 == 10000000);
  decode.Chameleon_CH2_Open = dataInvalid ? null : (r2 == 10000000);
  decode.Chameleon_CH3_Open = dataInvalid ? null : (r3 == 10000000);

  if(dataInvalid || decode.Chameleon_Temp_Fault || soil_temp_c_x100 == -12700)
    decode.Chameleon_TempC = "NULL";
  else
    decode.Chameleon_TempC = parseFloat((soil_temp_c_x100 / 100).toFixed(2));

  decode.Chameleon_R1_Ohm_Comp = (dataInvalid || decode.Chameleon_CH1_Open) ? "NULL" : r1;
  decode.Chameleon_R2_Ohm_Comp = (dataInvalid || decode.Chameleon_CH2_Open) ? "NULL" : r2;
  decode.Chameleon_R3_Ohm_Comp = (dataInvalid || decode.Chameleon_CH3_Open) ? "NULL" : r3;
  decode.Chameleon_Array_ID = (dataInvalid || decode.Chameleon_ID_Fault) ? "NULL" : bytesToHex(bytes, 24, 8);
}
```

In the MOD3 branch, replace:

```js
    if(isChameleonV1Frame(bytes))
    {
      decode.BatV= bytes[7]/10;
      decodeChameleonV1(decode, bytes);
    }
```

with:

```js
    if(isChameleonV2Frame(bytes))
    {
      decode.BatV= bytes[7]/10;
      decodeChameleonV2(decode, bytes);
    }
    else if(isChameleonV1Frame(bytes))
    {
      decode.BatV= bytes[7]/10;
      decodeChameleonV1(decode, bytes);
    }
```

- [ ] **Step 4: Run decoder verification**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-sync-flow.js
```

Expected: both scripts pass.

- [ ] **Step 5: Commit decoder support**

```bash
cd /home/phil/Repos/osi-os
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js \
        scripts/verify-lsn50-chameleon-codec.js \
        scripts/verify-sync-flow.js
git commit -m "feat: decode chameleon v2 payloads"
```

### Task 5: Flow Normalization And Persistence For V2 Status

**Files:**
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `/home/phil/Repos/osi-os/scripts/verify-lsn50-chameleon-persistence.js`

- [ ] **Step 1: Add persistence coverage for V2 data-invalid and omitted raw fields**

In `scripts/verify-lsn50-chameleon-persistence.js`, add this source assertion after the existing decode assertions:

```js
assertIncludes(decode, 'chameleonDataInvalid', 'decode normalizes V2 Chameleon data invalid flag');
```

Add `chameleonDataInvalid: 0,` to `normalMsg.formattedData` immediately after `chameleonStatusFlags: 0,`.

Add this block after the normal Chameleon write assertions:

```js
  const v2Msg = JSON.parse(JSON.stringify(normalMsg));
  v2Msg.formattedData.chameleonPayloadVersion = 2;
  delete v2Msg.formattedData.chameleonR1OhmRaw;
  delete v2Msg.formattedData.chameleonR2OhmRaw;
  delete v2Msg.formattedData.chameleonR3OhmRaw;
  const v2 = await runFunctionNode('chameleon-readings-insert-fn', v2Msg);
  assert.strictEqual(v2.writes.length, 1, 'v2 chameleon payload writes one row');
  assert.strictEqual(v2.writes[0].params[2], 2, 'payload_version stores v2');
  assert.strictEqual(v2.writes[0].params[12], 1168, 'v2 r1_ohm_comp is stored');
  assert.strictEqual(v2.writes[0].params[15], null, 'v2 omitted r1_ohm_raw stores NULL');
  assert.strictEqual(v2.writes[0].params[16], null, 'v2 omitted r2_ohm_raw stores NULL');
  assert.strictEqual(v2.writes[0].params[17], null, 'v2 omitted r3_ohm_raw stores NULL');

  const v2InvalidMsg = JSON.parse(JSON.stringify(v2Msg));
  v2InvalidMsg.formattedData.chameleonStatusFlags = 1;
  v2InvalidMsg.formattedData.chameleonDataInvalid = 1;
  v2InvalidMsg.formattedData.chameleonI2cMissing = null;
  v2InvalidMsg.formattedData.chameleonTimeout = null;
  v2InvalidMsg.formattedData.chameleonTempC = 0;
  v2InvalidMsg.formattedData.chameleonR1OhmComp = 0;
  v2InvalidMsg.formattedData.chameleonArrayId = 'SHOULD_NOT_STORE';
  const v2Invalid = await runFunctionNode('chameleon-readings-insert-fn', v2InvalidMsg);
  assert.strictEqual(v2Invalid.writes[0].params[3], 1, 'v2 simplified status_flags stores data-invalid bit');
  assert.strictEqual(v2Invalid.writes[0].params[4], null, 'v2 i2c_missing remains NULL when not sent');
  assert.strictEqual(v2Invalid.writes[0].params[5], null, 'v2 timeout remains NULL when not sent');
  assert.strictEqual(v2Invalid.writes[0].params[11], null, 'v2 temp_c is nulled when data_invalid is set');
  assert.strictEqual(v2Invalid.writes[0].params[12], null, 'v2 r1_ohm_comp is nulled when data_invalid is set');
  assert.strictEqual(v2Invalid.writes[0].params[18], null, 'v2 array_id is nulled when data_invalid is set');
```

- [ ] **Step 2: Run the persistence verifier and verify it fails**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-lsn50-chameleon-persistence.js
```

Expected: failure because `flows.json` does not yet normalize `Chameleon_Data_Invalid` or use `chameleonDataInvalid` in the insert function.

- [ ] **Step 3: Normalize the V2 data-invalid flag in the LSN50 decode node**

In the `lsn50-decode-fn` function inside `flows.json`, add this property to `msg._chameleonDecoded` immediately after `statusFlags: chameleonInteger(obj.Chameleon_Status_Flags),`:

```js
                dataInvalid: chameleonFlag(obj.Chameleon_Data_Invalid),
```

Add this property to the `Object.assign(msg.formattedData, { ... })` Chameleon block immediately after `chameleonStatusFlags: chameleonDecoded.statusFlags,`:

```js
            chameleonDataInvalid: chameleonDecoded.dataInvalid,
```

- [ ] **Step 4: Use V2 data-invalid in the Chameleon insert node**

In `chameleon-readings-insert-fn`, replace:

```js
const dataInvalid = toInt(d.chameleonI2cMissing) === 1 || toInt(d.chameleonTimeout) === 1;
```

with:

```js
const dataInvalid = toInt(d.chameleonDataInvalid) === 1 || toInt(d.chameleonI2cMissing) === 1 || toInt(d.chameleonTimeout) === 1;
```

- [ ] **Step 5: Run persistence and sync verification**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-sync-flow.js
```

Expected: both scripts pass.

- [ ] **Step 6: Commit the flow normalization and persistence test**

```bash
cd /home/phil/Repos/osi-os
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        scripts/verify-lsn50-chameleon-persistence.js
git commit -m "feat: persist chameleon v2 status"
```

### Task 6: Documentation And End-To-End Verification

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/README-chameleon-claude.md`
- Modify: `/home/phil/Repos/osi-os/docs/plans/2026-04-30-lsn50-chameleon-i2c-firmware.md`

- [ ] **Step 1: Update the firmware README payload section**

In `/home/phil/Repos/LoRa_STM32-claude/README-chameleon-claude.md`, update the payload summary to include:

```markdown
## Chameleon V2 Payload

The default Chameleon build now emits payload version `0x02`.

V2 is 32 bytes on the configured/default FPort 2:

| Offset | Size | Field |
|---|---:|---|
| 0 | 2 | ADC PA0 mV, stock MOD3 prefix |
| 2 | 2 | ADC PA1 mV, stock MOD3 prefix |
| 4 | 2 | ADC PA4 mV, stock MOD3 prefix |
| 6 | 1 | stock MOD3 status/mode byte |
| 7 | 1 | battery / 100 mV |
| 8 | 1 | payload version = `0x02` |
| 9 | 1 | simplified Chameleon status flags |
| 10 | 2 | soil temperature x100, signed big-endian |
| 12 | 4 | R1 compensated ohms, unsigned big-endian |
| 16 | 4 | R2 compensated ohms, unsigned big-endian |
| 20 | 4 | R3 compensated ohms, unsigned big-endian |
| 24 | 8 | Chameleon array ID |

V2 status flags:

- bit 0: data invalid; do not trust trailing Chameleon fields
- bit 1: temperature fault
- bit 2: array ID fault
- bits 3-7: reserved

Raw resistance values are omitted from routine V2 uplinks. They were retained in V1 for diagnostics, but SWT conversion uses compensated resistance values. Per-channel open state is derived from compensated resistance equal to `10_000_000` ohm. The OSI OS decoder still accepts V1 frames from already flashed devices.
```

- [ ] **Step 2: Update the existing OSI OS firmware plan note**

Append this note under `Implementation improvements` in `/home/phil/Repos/osi-os/docs/plans/2026-04-30-lsn50-chameleon-i2c-firmware.md`:

```markdown
- **Next firmware revision: compact Chameleon V2 payload.** This Chameleon-specific firmware should force MOD3 after config reads so stale EEPROM cannot leave the device in another LSN50 mode. Keep the stock MOD3 first 8 bytes, keep payload version/a simplified status byte/temp/compensated resistances/array ID, and omit the three raw resistance fields from routine uplinks. This reduces the frame from 44 to 32 bytes. Raw values remain a diagnostics-only concern; SWT conversion uses compensated resistance. V2 status keeps only data-invalid, temp-fault, and ID-fault bits; per-channel open state is derived from compensated `10_000_000` ohm readings.
```

- [ ] **Step 3: Run firmware verification**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean && make test
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon
./build.sh chameleon-dummy
```

Expected: host tests pass; both firmware builds complete without errors.

- [ ] **Step 4: Run OSI OS verification**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-sync-flow.js
```

Expected: all scripts pass.

- [ ] **Step 5: Check both working trees**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git status --short --branch
cd /home/phil/Repos/osi-os
git status --short --branch
```

Expected: only intended documentation changes remain uncommitted in `osi-os` if Task 6 docs have not been committed yet; firmware repo is clean after previous task commits except README updates.

- [ ] **Step 6: Commit documentation**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add README-chameleon-claude.md
git commit -m "docs: document chameleon v2 payload"

cd /home/phil/Repos/osi-os
git add docs/plans/2026-04-30-lsn50-chameleon-i2c-firmware.md \
        docs/superpowers/plans/2026-05-14-lsn50-chameleon-firmware-v2.md
git commit -m "docs: plan chameleon firmware v2"
```

## Self-Review

- Spec coverage: MOD3 from first boot, FDR, stale EEPROM, AT mode writes, and downlink mode writes are covered by Task 3; payload cleanup and simplified V2 status are covered by Tasks 1-2 and 4-5; documentation is covered by Task 6.
- Placeholder scan: no placeholder markers or unspecified implementation steps are present.
- Type consistency: V2 version is consistently `0x02`, V2 length is consistently `32`, V2 status bits are consistently data-invalid/temp-fault/ID-fault, raw resistance fields are omitted from V2 decoder output and stored as `NULL` by persistence normalization.
- Deliberate non-change: ADC/status/battery prefix remains because it preserves stock MOD3 behavior and allows dendrometer and Chameleon derivation to coexist.
