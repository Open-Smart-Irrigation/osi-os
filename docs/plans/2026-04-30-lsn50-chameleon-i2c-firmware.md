
# LSN50 Chameleon I2C Firmware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone Chameleon-only LSN50 firmware variant that reads the VIA Chameleon I²C reader at address `0x08`, encodes a stock-MOD=3-aligned 44-byte payload, and sends it over LoRaWAN on the configured Dragino application port.

**Architecture:**
- Add a new `via_chameleon.{h,c}` driver under the DRAGINO-LRWAN(AT) app. Keep it HAL-free by routing board access through `chameleon_board_*` extern primitives; ARM implementations live in `bsp.c`, and host mocks live in `tests/mock_chameleon_i2c.c`.
- Add Chameleon-specific MOD=3 read and send logic behind `USE_CHAMELEON`, producing a 44-byte payload on the configured Dragino application port (default FPort 2). The payload keeps the first 8 bytes of the stock no-SHT MOD=3 frame (ADC/status/battery) and appends Chameleon fields in big-endian order. This firmware variant is standalone: it must not include or depend on any legacy sensor-specific driver, host tests, build artifacts, or rollout notes.
- Bring-up uses a second flag, `CHAMELEON_DUMMY`, that skips real I²C and emits canned Chameleon measurement values while the stock MOD=3 ADC/status/battery fields stay real, so we can debug the LoRaWAN/payload path before wiring the reader.
- The kPa formula stays server-side (per the protocol-reference doc); firmware ships ohms.
- This remains a Dragino LSN50 firmware variant. No gateway decoder, device type, schema, or server/gateway flow changes are part of this plan.

**Tech Stack:**
- ARM target: STM32L072CZ, GCC arm-none-eabi, STM32 HAL (HAL_I2C_*).
- Host tests: native gcc, `tests/Makefile`, Chameleon-specific mock board primitives.
- Repo: `Project-OSI/LoRa_STM32` (working copy at `/home/phil/Repos/LoRa_STM32-claude`).
- Branch off: `feature/ratiometric-dendrometer-claude` (the dendrometer fork). Task 0 begins by deleting the dendrometer-specific files in a single "prune" commit, leaving only the generic GCC build harness and the host-test scaffold. Rationale: the dendro fork is the only branch carrying the GCC build harness (`build/build.sh`, `cflags.rsp`, `stm32l072cz.ld`) and the generic host-test scaffold (`tests/Makefile`, smoke test). Recreating those from scratch off `master` would be substantial extra work. Pruning the dendrometer artefacts up-front gives us "no unrelated sensor carry-over" without paying that cost. The dendrometer's ADC sampling logic is isolated to its own file and mode-3 branch — once those are removed in Task 0, no dendrometer code path remains in the chameleon build.

**Scope (in v1):** Firmware driver + payload + host tests + ARM build targets + rollout notes + bench verification. **Out of scope:** gateway/server integration, new device types, kPa conversion on device, irrigation logic, OTA, multiple readers per node, dynamic addressing, calibration provisioning UX.

---

## Reference repo layout (firmware)

All paths below are inside `/home/phil/Repos/LoRa_STM32-claude/`. The Dragino app directory has literal parens in its name; quote it in shell commands.

| What | Path |
|---|---|
| Firmware app root | `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/` |
| Headers | `…/inc/` |
| Sources | `…/src/` |
| MOD dispatch (read) | `…/src/bsp.c` — `BSP_sensor_Read()` ~line 106; mode==3 branch around lines 303-320 |
| MOD dispatch (init) | `…/src/bsp.c` — `BSP_sensor_Init()` ~line 501; mode==3 SHT/BH1750 probe at lines 507-569 |
| ARM I²C handle | Baseline `Drivers/BSP/Components/sht20/sht20.c:63` declares `I2C_HandleTypeDef I2cHandle1` only under `USE_SHT`. The Chameleon target undefines `USE_SHT` and defines its own `I2cHandle1` in `bsp.c` under `USE_CHAMELEON`, so the firmware does not depend on the SHT driver. |
| I²C pin macros | `…/inc/stm32l0xx_hw_conf.h:171-186` — `I2Cx = I2C1`, SCL = PB6, SDA = PB7, AF1 |
| I²C timing | `Drivers/BSP/Components/sht20/sht20.c:66-67` documents both timings: `0x10A13E56` (100 kHz) and commented `0x00B1112E` (400 kHz). Chameleon uses a dedicated `bsp.c` init helper with `0x00B1112E`, matching the vendor library's `Wire.setClock(400000)`. |
| Payload assembly | `…/src/main.c::Send()` ~line 539; mode==3 branch at lines 641-675 |
| Battery | `…/src/main.c` declares `batteryLevel_mV`; `HW_GetBatteryLevel()` is called at the top of `BSP_sensor_Read` (`bsp.c:110`) |
| Host tests | `tests/Makefile`, `tests/test_harness_smoke.c`, `tests/test_chameleon_payload.c`, `tests/test_chameleon_driver.c` |
| ARM build | `build/build.sh` + `build/cflags.rsp` — direct compile/link script currently defining `-DREGION_EU868 -DUSE_SHT`; Task 8 overrides this for Chameleon targets with `-UUSE_SHT -DUSE_CHAMELEON`. This plan produces `build/LSN50-chameleon.{elf,bin,hex}` and `build/LSN50-chameleon-dummy.{elf,bin,hex}` |
| Rollout notes | `README-chameleon-claude.md` |

## Assumptions to verify in Task 0

These assumptions drive later tasks. If any fails, stop and replan.

1. **I²C bus.** I2C1 on PB6/PB7 (the user-confirmed wiring) is already represented by the board-level MSP pin setup. The Chameleon target defines its own `I2cHandle1` in `bsp.c` under `USE_CHAMELEON`, reusing those pins without depending on the SHT driver. No new bus, no new pins.
2. **Timing.** v1 uses 400 kHz because the vendor library explicitly calls `Wire.setClock(400000)` and there is no device-specific reason to downshift. Scope the 400 kHz timing to the Chameleon-only build path in `bsp.c`; do not globally change the stock SHT timing.
3. **Mode-3 ownership.** This firmware variant is Chameleon-only for I2C, but it preserves stock MOD=3 ADC behavior. Task 0 removes only the dendrometer-specific mode==3 branch and leaves the stock `else if((mode==3)||(mode==8))` ADC branch intact. Task 6 appends the Chameleon I2C acquisition inside that stock MOD=3 read path.
4. **Application port.** Use the configured Dragino application port via the existing `AppData.Port = lora_config_application_port_get()` path in `Send()` (default FPort 2). Do not hardcode a dedicated Chameleon FPort.
5. **Endianness.** The uplink payload is **big-endian**, matching stock Dragino LSN50 payload convention. The I2C driver still decodes the Chameleon slave's little-endian register responses into integers at the driver boundary.
6. **Battery.** `batteryLevel_mV` is the canonical battery field; refreshed at `bsp.c:110` for every `BSP_sensor_Read` call. Encode it like stock no-SHT MOD=3: one byte `batteryLevel_mV / 100` immediately after the status byte at offset 7.
7. **Firmware identity.** This is a Dragino LSN50 firmware image. Do not add `VIA_CHAMELEON`, `swt_wm3`, or any gateway/server changes in this plan.

---

## Review consolidation notes

These notes consolidate follow-up review findings for the implementation agent:

1. **Blocker: move `I2cHandle3` extern out of `USE_SHT`.** The Chameleon build passes `-UUSE_SHT`; in stock `bsp.c`, `extern I2C_HandleTypeDef I2cHandle3;` is currently inside `#ifdef USE_SHT`, but mode 2 code still references `I2cHandle3` outside that guard (`HAL_I2C_MspInit(&I2cHandle3)` in `BSP_sensor_Read` and `HAL_I2C_Mem_Write(&I2cHandle3, ...)` / `HAL_I2C_MspDeInit(&I2cHandle3)` in `BSP_sensor_Init`). `I2cHandle3` is defined unconditionally in `lidar_lite_v3hp.c`, so the smallest correct fix is to make only the extern declaration unconditional. `I2cHandle2` stays guarded because its references are also `USE_SHT`-guarded. `I2cHandle1` stays Chameleon-owned under `USE_CHAMELEON`.
2. **Task 5 init failure must fail soft.** Stock SHT init calls `Error_Handler()` on `HAL_I2C_Init` failure, but `Error_Handler()` spins forever in `debug.c`, which would prevent a faulty field unit from joining and reporting status. The Chameleon helper should return failure, print a fault, leave `g_chameleon_i2c_ready=0`, and let later probes report `CHAMELEON_FLAG_I2C_MISSING`.
3. **Task 6 mode guard is low risk, but verify during compile.** The Chameleon acquisition is inserted inside the stock `else if((mode==3)||(mode==8))` ADC branch and still needs an inner `if(mode==3)` guard so mode 8 keeps stock ADC-only behavior. In the checked Dragino source, `mode` is file-scope `extern uint8_t mode;` near the top of `bsp.c`, not a local variable in `BSP_sensor_Read`, so it is in scope at the insertion point. Implementation should still compile the ARM target in Task 8 to catch any preprocessor/scope drift after pruning.
4. **Task 7 battery overwrite removed.** `via_chameleon_acquire()` fills `sample->battery_mv` via `chameleon_board_battery_mv()`, which returns `batteryLevel_mV`; Task 7 should not assign `cs.battery_mv = batteryLevel_mV` again. The ADC fields and `mod3_status` still must be filled in `Send()` because the Chameleon driver does not own stock MOD=3 fields.
5. **Battery offset is correct for the aligned Chameleon payload.** Stock no-SHT MOD=3 emits PA0, PA1, PA4, status, then one battery byte, for an 8-byte frame. The Chameleon payload preserves those first 8 bytes exactly: battery is offset 7, and the Chameleon extension starts at offset 8.
6. **Dead-code link bloat is acceptable for v1.** The Chameleon build may still compile/link unused Dragino component sources such as BH1750 and LIDAR. This is not a correctness issue on STM32L072 flash budget, and retaining `lidar_lite_v3hp.c` keeps the unconditional `I2cHandle3` definition available. Dropping unused component sources can be a later size cleanup only if paired with mode-branch guards.
7. **Minor follow-ups are documentation/test quality, not blockers.** Struct field order should mirror the wire order for readability; the mock can keep one `mock_chameleon_set_resistance()` setter for now because existing fixtures still cover encoded raw and compensated values. If later tests need to prove the open-circuit `comp == 10M || raw == 10M` OR logic independently, split the mock setter into compensated/raw variants.
8. **Verified clean from review.** The reviewed numeric payload fixtures, 44-byte encoder bounds, big-endian conversion, and stock-aligned first-8-byte layout all checked out. Keep those tests unchanged unless the payload contract changes again.
9. **Keep Chameleon globals outside `USE_SHT`.** Any `USE_CHAMELEON` globals in `bsp.c`, including `g_chameleon_last_sample` and `bsp_chameleon_last_sample()`, must live outside the existing `USE_SHT` block. The Chameleon target compiles with `-UUSE_SHT`; nesting these declarations under the SHT guard would make the ARM build fail.

---

## File map (creates / modifies)

**Create (firmware):**
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/via_chameleon.h`
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c`
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h`
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/chameleon_payload.c`
- `tests/test_chameleon_payload.c`
- `tests/test_chameleon_driver.c`
- `tests/mock_chameleon_i2c.c` + `tests/mock_chameleon_i2c.h`
- `README-chameleon-claude.md` (standalone rollout notes)

**Modify (firmware):**
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c` — add 400 kHz Chameleon I2C1 init and `chameleon_board_*` primitives; gate mode==3 init/read on `USE_CHAMELEON`.
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h` — expose `bsp_chameleon_last_sample()` under `USE_CHAMELEON`.
- `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c` — gate mode==3 `Send()` payload assembly on `USE_CHAMELEON`.
- `tests/Makefile` — add chameleon test targets.
- `build/build.sh` — add a `-UUSE_SHT -DUSE_CHAMELEON` build target producing `build/LSN50-chameleon.{elf,bin,hex}` and a `-UUSE_SHT -DUSE_CHAMELEON -DCHAMELEON_DUMMY` target producing `build/LSN50-chameleon-dummy.{elf,bin,hex}`.

**Create / modify (gateway/server):**
- None in this plan.

---

## Proposed payload encoder

### Encoder (firmware → wire), stock MOD=3-aligned, big-endian, 44 bytes, configured/default port 2

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 2 | `adc_pa0_mv` | `uint16 BE` | stock MOD=3 PA0 / oil field |
| 2 | 2 | `adc_pa1_mv` | `uint16 BE` | stock MOD=3 PA1 / ADC_1 field |
| 4 | 2 | `adc_pa4_mv` | `uint16 BE` | stock MOD=3 PA4 / ADC_2 field |
| 6 | 1 | `mod3_status` | `uint8` | stock MOD=3 status byte: `(switch_status<<7)|(in1<<1)|0x08|(exit_temp&0x01)` |
| 7 | 1 | `battery_100mv` | `uint8` | stock no-SHT MOD=3 battery field: `batteryLevel_mV / 100` |
| 8 | 1 | `payload_version` | `uint8` | `0x01` for Chameleon v1 extension |
| 9 | 1 | `status_flags` | `uint8` | Chameleon status bits below |
| 10 | 2 | `soil_temp_c_x100` | `int16 BE` | DS18B20 reading × 100; `-12700` is sentinel |
| 12 | 4 | `r1_ohm_comp` | `uint32 BE` | compensated, 0x11 |
| 16 | 4 | `r2_ohm_comp` | `uint32 BE` | compensated, 0x12 |
| 20 | 4 | `r3_ohm_comp` | `uint32 BE` | compensated, 0x13 |
| 24 | 4 | `r1_ohm_raw` | `uint32 BE` | uncompensated, 0x21 |
| 28 | 4 | `r2_ohm_raw` | `uint32 BE` | uncompensated, 0x22 |
| 32 | 4 | `r3_ohm_raw` | `uint32 BE` | uncompensated, 0x23 |
| 36 | 8 | `array_id` | `uint8[8]` | DS18B20 ROM, byte-order from 0x30 read |

Status flag bits (per spec):
| Bit | Meaning |
|---|---|
| 0 | I²C device not found at 0x08 |
| 1 | Measurement timeout or not ready |
| 2 | Temperature fault (raw == -12700) |
| 3 | ID fault (all 0xFF) |
| 4 | Channel 1 open/disconnected (compensated or raw R == 10_000_000) |
| 5 | Channel 2 open |
| 6 | Channel 3 open |
| 7 | Reserved (must be 0) |

If bit 0 or bit 1 is set, the firmware **still** emits a 44-byte frame with the first 8 bytes matching stock no-SHT MOD=3 (ADC/status/battery) and Chameleon measurement fields zero-filled, so the uplink frame shape stays fixed.

### Test plan (minimal)

- **Host (TDD-driven, in plan tasks below):** payload encode known fixture; driver state machine across happy path / timeout / sentinel / probe-fail; sentinel→flag mapping.
- **Bench, dummy build (no reader connected):** flash `-DCHAMELEON_DUMMY`, observe LoRaWAN uplink on the configured/default FPort 2 with variable stock MOD=3 bytes followed by deterministic Chameleon extension bytes: `<adc_pa0_be> <adc_pa1_be> <adc_pa4_be> <mod3_status> <bat_100mv> 01 00 07 D0 00 00 06 40 00 01 86 A0 00 18 6A 00 00 00 06 40 00 01 86 A0 00 18 6A 00 DE AD BE EF DE AD BE EF`. Confirms payload path independent of I²C while preserving stock MOD=3 ADC/status/battery fields.
- **Bench, real build:** flash `-DUSE_CHAMELEON` (no dummy). With reader unpowered, expect bit 0 set. With reader powered but probe disconnected, expect bits 4-6 set. With probe connected, expect realistic resistances.
- **Soak:** 24-48 h on the bench; uplinks every nominal interval; no resets, no drift, status bits clean except for any deliberately disconnected channel.

---

## Tasks

### Task 0: Branch off dendrometer fork and prune dendrometer specifics

**Files:**
- Delete:
  - `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`
  - `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`
  - `tests/test_dendrometer.c`
  - `tests/mock_board.h`
  - `tests/mock_board.c`
  - `README-dendrometer-claude.md`
  - `build/LSN50-dendro.elf`, `build/LSN50-dendro.bin`, `build/LSN50-dendro.hex`, `build/LSN50-dendro.map` — these were committed by mistake on the dendro fork; verified tracked via `git ls-files build/`. `build/.gitignore` covers `obj/`, `home/`, `Makefile` but does **not** cover the build outputs. (Task 8 fixes the gitignore so the chameleon equivalents stay untracked.)
  - **Do not delete** `LSN50.hex/` or `LoRa ST.hex/`. Despite the `.hex` suffix, both are *directories* present on upstream Dragino master containing per-region stock vendor firmware (`LSN50.hex/Readme.txt`, `LoRa ST.hex/v1.2/EU868.hex`, `LoRa ST.hex/v1.3/AS923.hex`, etc.). They are not dendrometer carry-over. Leave them in place.
- Modify:
  - `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c` — remove `#include "dendrometer.h"`, remove the `else if(mode==3) { dendrometer_measure(...); ... }` block in `BSP_sensor_Read` (currently `bsp.c:303-320`), leave the following stock `else if((mode==3)||(mode==8))` ADC branch intact, remove the dendrometer board-primitive block at the end of the file (`bsp.c:641-669`: `dendro_board_5v_on/off`, `dendro_board_adc_read_*`, `dendro_board_delay_ms`).
  - `tests/Makefile` — drop `dendrometer` from the `TESTS` list and remove the `$(OBJDIR)/test_dendrometer:` rule.

After this commit, the working tree is "stock Dragino LSN50 + generic GCC build harness + generic host-test scaffold." The firmware build will fail until Task 8 introduces the chameleon target — that's expected. Host tests (just the smoke test) should still pass.

- [ ] **Step 1: Verify clean working tree on the dendrometer fork**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git status --short --branch
```

Expected: `## feature/ratiometric-dendrometer-claude...origin/feature/ratiometric-dendrometer-claude` and no uncommitted changes. If dirty, stop and resolve before continuing.

- [ ] **Step 2: Create the feature branch**

```bash
git checkout -b feature/chameleon-i2c-reader
git status --short --branch
```

Expected branch: `## feature/chameleon-i2c-reader`.

- [ ] **Step 3: Sanity-check the dendrometer build is healthy on the new branch**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh
ls -l LSN50-dendro.hex
cd ../tests
make clean && make test
```

Expected: hex file exists; host tests pass (`all host tests passed`). If either fails, stop — do not prune until the baseline is healthy, otherwise you can't tell whether Task 0 broke something or whether it was already broken.

- [ ] **Step 4: Delete dendrometer-specific files**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git rm 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h' \
       'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c' \
       tests/test_dendrometer.c \
       tests/mock_board.h \
       tests/mock_board.c \
       README-dendrometer-claude.md \
       build/LSN50-dendro.elf \
       build/LSN50-dendro.bin \
       build/LSN50-dendro.hex \
       build/LSN50-dendro.map
```

All seven files plus four build artefacts are tracked on the dendro fork; `git rm` should succeed for every entry. If any reports "did not match", stop and investigate — the baseline differs from what this plan expects.

**Do not** include `LSN50.hex` or `LoRa ST.hex` in this command — both are directories of upstream stock vendor firmware (see "Do not delete" note in the file map above). `git rm` on a directory without `-r` would fail; with `-r` it would erase upstream reference firmware.

- [ ] **Step 5: Modify `bsp.c` — remove the dendrometer code paths**

Open `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c` and apply these edits exactly:

1. Near the top of the file, remove the line `#include "dendrometer.h"` (search for the include and delete it).

2. In `BSP_sensor_Read`, delete the dendrometer mode==3 branch. The current text (around lines 303-320) is:

```c
	else if(mode==3)
	{
		/* Ratiometric dendrometer: 20 paired PA0/PA1 samples at 10 ms cadence
		 * for 50 Hz mains rejection. Converted to stock MOD=8-shape mV so the
		 * MOD=3 uplink reuses the stock 12-byte wire layout. PA4 is not wired
		 * for the dendrometer: sensor_data->ADC_2 is left at 0. */
		dendrometer_result_t dendro;
		dendrometer_measure(&dendro);
		sensor_data->oil   = (uint16_t)((uint32_t)dendro.signal_raw    * batteryLevel_mV / 4095U);
		sensor_data->ADC_1 = (uint16_t)((uint32_t)dendro.reference_raw * batteryLevel_mV / 4095U);
		sensor_data->ADC_2 = 0;
		if(message==1)
		{
			PPRINTF("ADC_PA0:%.3f V\r\n",(sensor_data->oil/1000.0));
			PPRINTF("ADC_PA1:%.3f V\r\n",(sensor_data->ADC_1/1000.0));
			PPRINTF("ADC_PA4:%.3f V\r\n",(sensor_data->ADC_2/1000.0));
		}
	}
```

Delete the entire block.

3. Immediately after, the next branch (around `bsp.c:321`) reads `else if((mode==3)||(mode==8))`. Leave this branch intact. It is the stock MOD=3 ADC path, and the Chameleon firmware must keep PA0/PA1/PA4 ADC values in the uplink.

4. At the bottom of the file (around lines 641-669), delete the dendrometer board-primitive block — everything between (and including) the comment header `/* ========================================================================` … `Dendrometer board primitives` … `==== */` and the closing brace of `dendro_board_delay_ms`. Concretely: delete `dendro_board_5v_on`, `dendro_board_5v_off`, `dendro_board_adc_read_signal`, `dendro_board_adc_read_reference`, `dendro_board_delay_ms`, and the section comment header above them.

- [ ] **Step 6: Modify `tests/Makefile`**

Change the `TESTS` line:

```make
TESTS := harness_smoke
```

(was `harness_smoke dendrometer`)

Delete the `$(OBJDIR)/test_dendrometer:` rule entirely (it follows the harness_smoke rule).

- [ ] **Step 7: Verify host tests still pass and the firmware build now fails (expected)**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean && make test
```

Expected: `all host tests passed` (only the smoke test runs).

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh || echo "build failed (expected — chameleon target not yet added)"
```

Expected: build fails on missing `dendrometer.c` (or similar). This is fine — Task 8 fixes the build script. If the build *succeeds*, the build script does not depend on the deleted files, which means we can postpone fixing it until Task 8 with no surprises.

- [ ] **Step 8: Commit the prune**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git status --short
git add -A
git commit -m "chore(chameleon): prune dendrometer artefacts from firmware base"
```

Expected `git status` before staging: deleted files listed plus modifications to `bsp.c` and `tests/Makefile`. After commit: clean tree.

---

### Task 1: Failing host test for the payload encoder

**Files:**
- Create: `tests/test_chameleon_payload.c`
- Create: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h`
- Create/modify: `tests/Makefile`

- [ ] **Step 1: Write `chameleon_payload.h` (header only, struct + encoder declaration)**

```c
// inc/chameleon_payload.h
#ifndef CHAMELEON_PAYLOAD_H
#define CHAMELEON_PAYLOAD_H

#include <stdint.h>
#include <stddef.h>

#define CHAMELEON_PAYLOAD_VERSION_V1   0x01
#define CHAMELEON_PAYLOAD_LEN_V1       44U

#define CHAMELEON_FLAG_I2C_MISSING     (1U << 0)
#define CHAMELEON_FLAG_TIMEOUT         (1U << 1)
#define CHAMELEON_FLAG_TEMP_FAULT      (1U << 2)
#define CHAMELEON_FLAG_ID_FAULT        (1U << 3)
#define CHAMELEON_FLAG_CH1_OPEN        (1U << 4)
#define CHAMELEON_FLAG_CH2_OPEN        (1U << 5)
#define CHAMELEON_FLAG_CH3_OPEN        (1U << 6)

typedef struct {
    uint16_t adc_pa0_mv;
    uint16_t adc_pa1_mv;
    uint16_t adc_pa4_mv;
    uint8_t  mod3_status;
    uint16_t battery_mv;
    uint8_t  status_flags;
    int16_t  soil_temp_c_x100;
    uint32_t r1_ohm_comp;
    uint32_t r2_ohm_comp;
    uint32_t r3_ohm_comp;
    uint32_t r1_ohm_raw;
    uint32_t r2_ohm_raw;
    uint32_t r3_ohm_raw;
    uint8_t  array_id[8];
} chameleon_sample_t;

/* Encode a sample into a 44-byte stock-MOD=3-aligned big-endian frame.
 * Returns the number of bytes written (always 44 for v1) on success, 0 if buf
 * is NULL, sample is NULL, or buf_len < 44. */
size_t chameleon_payload_encode_v1(uint8_t *buf, size_t buf_len,
                                   const chameleon_sample_t *sample);

#endif /* CHAMELEON_PAYLOAD_H */
```

- [ ] **Step 2: Write the failing test**

```c
// tests/test_chameleon_payload.c
#include "chameleon_payload.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ASSERT_EQ_U32(actual, expected, label) do {                             \
    if ((uint32_t)(actual) != (uint32_t)(expected)) {                           \
        fprintf(stderr, "FAIL %s: expected %u got %u (%s:%d)\n",                \
                (label), (unsigned)(expected), (unsigned)(actual),              \
                __FILE__, __LINE__);                                            \
        exit(1);                                                                \
    }                                                                           \
} while (0)

static void test_encode_known_sample(void) {
    chameleon_sample_t s = {
        .adc_pa0_mv      = 1010,
        .adc_pa1_mv      = 2020,
        .adc_pa4_mv      = 3030,
        .mod3_status     = 0x08,
        .array_id        = {0x28, 0x6D, 0x6A, 0xDB, 0x0F, 0x00, 0x00, 0xF1},
        .soil_temp_c_x100 = 1987,        /* 19.87 °C */
        .r1_ohm_comp     = 1100,         /* 1.1 kΩ */
        .r2_ohm_comp     = 10100,        /* 10.1 kΩ */
        .r3_ohm_comp     = 101200,       /* 101.2 kΩ */
        .r1_ohm_raw      = 1200,         /* raw values travel separately */
        .r2_ohm_raw      = 10200,
        .r3_ohm_raw      = 102200,
        .battery_mv      = 3300,
        .status_flags    = 0,
    };
    uint8_t buf[46];
    memset(buf, 0xAA, sizeof(buf));
    size_t n = chameleon_payload_encode_v1(buf, sizeof(buf), &s);
    ASSERT_EQ_U32(n, 44, "len");

    /* stock MOD=3 ADC/status prefix, big-endian */
    ASSERT_EQ_U32(buf[0], 0x03, "adc0 hi");  /* 1010 = 0x03F2 */
    ASSERT_EQ_U32(buf[1], 0xF2, "adc0 lo");
    ASSERT_EQ_U32(buf[2], 0x07, "adc1 hi");  /* 2020 = 0x07E4 */
    ASSERT_EQ_U32(buf[3], 0xE4, "adc1 lo");
    ASSERT_EQ_U32(buf[4], 0x0B, "adc4 hi");  /* 3030 = 0x0BD6 */
    ASSERT_EQ_U32(buf[5], 0xD6, "adc4 lo");
    ASSERT_EQ_U32(buf[6], 0x08, "mod3 status");
    ASSERT_EQ_U32(buf[7], 0x21, "battery / 100"); /* 3300 / 100 = 33 */
    ASSERT_EQ_U32(buf[8], 0x01, "version");
    ASSERT_EQ_U32(buf[9], 0x00, "flags");
    /* soil temp BE */
    ASSERT_EQ_U32(buf[10], 0x07, "temp hi");
    ASSERT_EQ_U32(buf[11], 0xC3, "temp lo");
    /* r1 = 1100 = 0x0000044C BE */
    ASSERT_EQ_U32(buf[12], 0x00, "r1 b0");
    ASSERT_EQ_U32(buf[13], 0x00, "r1 b1");
    ASSERT_EQ_U32(buf[14], 0x04, "r1 b2");
    ASSERT_EQ_U32(buf[15], 0x4C, "r1 b3");
    /* r2 = 10100 = 0x00002774 BE */
    ASSERT_EQ_U32(buf[16], 0x00, "r2 b0");
    ASSERT_EQ_U32(buf[19], 0x74, "r2 b3");
    /* r3 = 101200 = 0x00018B50 BE */
    ASSERT_EQ_U32(buf[20], 0x00, "r3 b0");
    ASSERT_EQ_U32(buf[21], 0x01, "r3 b1");
    ASSERT_EQ_U32(buf[23], 0x50, "r3 b3");
    /* raw r1 = 1200 = 0x000004B0 BE */
    ASSERT_EQ_U32(buf[24], 0x00, "raw r1 b0");
    ASSERT_EQ_U32(buf[26], 0x04, "raw r1 b2");
    ASSERT_EQ_U32(buf[27], 0xB0, "raw r1 b3");
    /* raw r2 = 10200 = 0x000027D8 BE */
    ASSERT_EQ_U32(buf[28], 0x00, "raw r2 b0");
    ASSERT_EQ_U32(buf[31], 0xD8, "raw r2 b3");
    /* raw r3 = 102200 = 0x00018F38 BE */
    ASSERT_EQ_U32(buf[32], 0x00, "raw r3 b0");
    ASSERT_EQ_U32(buf[33], 0x01, "raw r3 b1");
    ASSERT_EQ_U32(buf[35], 0x38, "raw r3 b3");
    /* array id verbatim */
    ASSERT_EQ_U32(buf[36], 0x28, "id 0");
    ASSERT_EQ_U32(buf[43], 0xF1, "id 7");
    /* untouched byte */
    ASSERT_EQ_U32(buf[44], 0xAA, "no overflow");
}

static void test_encode_negative_temp_and_flags(void) {
    chameleon_sample_t s = {
        .adc_pa0_mv       = 0,
        .adc_pa1_mv       = 0,
        .adc_pa4_mv       = 0,
        .mod3_status      = 0x08,
        .array_id         = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
        .soil_temp_c_x100 = -12700,      /* DS18B20 sentinel */
        .r1_ohm_comp      = 10000000U,   /* open-circuit sentinel */
        .r2_ohm_comp      = 0,
        .r3_ohm_comp      = 0,
        .r1_ohm_raw       = 10000000U,
        .r2_ohm_raw       = 0,
        .r3_ohm_raw       = 0,
        .battery_mv       = 3000,
        .status_flags     = CHAMELEON_FLAG_TEMP_FAULT | CHAMELEON_FLAG_ID_FAULT |
                            CHAMELEON_FLAG_CH1_OPEN,
    };
    uint8_t buf[44];
    size_t n = chameleon_payload_encode_v1(buf, sizeof(buf), &s);
    ASSERT_EQ_U32(n, 44, "len");
    ASSERT_EQ_U32(buf[9], 0x1C, "combined flags"); /* 0x04|0x08|0x10 */
    /* -12700 = 0xCE64 BE */
    ASSERT_EQ_U32(buf[10], 0xCE, "neg temp hi");
    ASSERT_EQ_U32(buf[11], 0x64, "neg temp lo");
    /* 10_000_000 = 0x00989680 BE */
    ASSERT_EQ_U32(buf[12], 0x00, "10M b0");
    ASSERT_EQ_U32(buf[13], 0x98, "10M b1");
    ASSERT_EQ_U32(buf[14], 0x96, "10M b2");
    ASSERT_EQ_U32(buf[15], 0x80, "10M b3");
    ASSERT_EQ_U32(buf[24], 0x00, "raw 10M b0");
    ASSERT_EQ_U32(buf[25], 0x98, "raw 10M b1");
    ASSERT_EQ_U32(buf[26], 0x96, "raw 10M b2");
    ASSERT_EQ_U32(buf[27], 0x80, "raw 10M b3");
}

static void test_encode_rejects_short_buf(void) {
    chameleon_sample_t s = {0};
    uint8_t buf[10];
    size_t n = chameleon_payload_encode_v1(buf, sizeof(buf), &s);
    ASSERT_EQ_U32(n, 0, "short buf rejected");
}

static void test_encode_rejects_null(void) {
    uint8_t buf[44];
    ASSERT_EQ_U32(chameleon_payload_encode_v1(NULL, sizeof(buf), NULL), 0, "null buf");
    chameleon_sample_t s = {0};
    ASSERT_EQ_U32(chameleon_payload_encode_v1(buf, sizeof(buf), NULL), 0, "null sample");
}

int main(void) {
    test_encode_known_sample();
    test_encode_negative_temp_and_flags();
    test_encode_rejects_short_buf();
    test_encode_rejects_null();
    printf("test_chameleon_payload OK\n");
    return 0;
}
```

- [ ] **Step 3: Add the test to `tests/Makefile`**

The Makefile already exists from Task 0 with `TESTS := harness_smoke`. Update the `TESTS` line to:

```make
TESTS := harness_smoke chameleon_payload
```

And add this rule (after the existing `$(OBJDIR)/test_harness_smoke:` rule):

```make
$(OBJDIR)/test_chameleon_payload: test_chameleon_payload.c \
		$(PROJ_BASE)/src/chameleon_payload.c \
		| $(OBJDIR)
	$(CC) $(CFLAGS) "-I$(PROJ_BASE)/inc" -o $@ \
		test_chameleon_payload.c "$(PROJ_BASE)/src/chameleon_payload.c"
```

- [ ] **Step 4: Run the test to confirm it fails (no encoder yet)**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make test
```

Expected: build error, "no rule to make `…/src/chameleon_payload.c`" or "undefined reference to `chameleon_payload_encode_v1`". This proves the test would catch a missing encoder.

- [ ] **Step 5: Do not commit yet — commit happens after Task 2 makes it pass.**

---

### Task 2: Implement the payload encoder

**Files:**
- Create: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/chameleon_payload.c`

- [ ] **Step 1: Write the encoder**

```c
// src/chameleon_payload.c
#include "chameleon_payload.h"

static void put_u16_be(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)((v >> 8) & 0xFFU);
    p[1] = (uint8_t)(v & 0xFFU);
}

static void put_u32_be(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)((v >> 24) & 0xFFU);
    p[1] = (uint8_t)((v >> 16) & 0xFFU);
    p[2] = (uint8_t)((v >> 8) & 0xFFU);
    p[3] = (uint8_t)(v & 0xFFU);
}

size_t chameleon_payload_encode_v1(uint8_t *buf, size_t buf_len,
                                   const chameleon_sample_t *sample) {
    if (buf == 0 || sample == 0) { return 0; }
    if (buf_len < CHAMELEON_PAYLOAD_LEN_V1) { return 0; }

    put_u16_be(&buf[0], sample->adc_pa0_mv);
    put_u16_be(&buf[2], sample->adc_pa1_mv);
    put_u16_be(&buf[4], sample->adc_pa4_mv);
    buf[6] = sample->mod3_status;
    buf[7] = (uint8_t)(sample->battery_mv / 100U);
    buf[8] = CHAMELEON_PAYLOAD_VERSION_V1;
    buf[9] = sample->status_flags;
    put_u16_be(&buf[10], (uint16_t)sample->soil_temp_c_x100);
    put_u32_be(&buf[12], sample->r1_ohm_comp);
    put_u32_be(&buf[16], sample->r2_ohm_comp);
    put_u32_be(&buf[20], sample->r3_ohm_comp);
    put_u32_be(&buf[24], sample->r1_ohm_raw);
    put_u32_be(&buf[28], sample->r2_ohm_raw);
    put_u32_be(&buf[32], sample->r3_ohm_raw);
    for (size_t i = 0; i < 8; i++) { buf[36 + i] = sample->array_id[i]; }
    return CHAMELEON_PAYLOAD_LEN_V1;
}
```

- [ ] **Step 2: Run the tests**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make test
```

Expected last lines: `running build/test_chameleon_payload ... test_chameleon_payload OK` and `all host tests passed`.

- [ ] **Step 3: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h' \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/chameleon_payload.c' \
        tests/test_chameleon_payload.c \
        tests/Makefile
git commit -m "feat(chameleon): add stock-aligned BE payload encoder + host tests"
```

---

### Task 3: Failing test for the I²C driver state machine (mocked bus)

**Files:**
- Create: `tests/mock_chameleon_i2c.h`
- Create: `tests/mock_chameleon_i2c.c`
- Create: `tests/test_chameleon_driver.c`
- Create: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/via_chameleon.h`
- Modify: `tests/Makefile`

The driver never includes any HAL header. Instead it calls four extern primitives that are implemented for ARM in `bsp.c` and for host in `mock_chameleon_i2c.c`.

- [ ] **Step 1: Write `via_chameleon.h`**

```c
// inc/via_chameleon.h
#ifndef VIA_CHAMELEON_H
#define VIA_CHAMELEON_H

#include <stdint.h>
#include <stddef.h>
#include "chameleon_payload.h"

#define CHAMELEON_I2C_ADDR_7BIT       0x08U
#define CHAMELEON_CMD_TEMP            0x01U
#define CHAMELEON_CMD_RES_CAL1        0x11U
#define CHAMELEON_CMD_RES_CAL2        0x12U
#define CHAMELEON_CMD_RES_CAL3        0x13U
#define CHAMELEON_CMD_RES_RAW1        0x21U
#define CHAMELEON_CMD_RES_RAW2        0x22U
#define CHAMELEON_CMD_RES_RAW3        0x23U
#define CHAMELEON_CMD_ID              0x30U
#define CHAMELEON_CMD_TRIGGER         0x40U
#define CHAMELEON_CMD_STATUS          0x41U

#define CHAMELEON_STATUS_READY        0x01U

#define CHAMELEON_DEFAULT_TIMEOUT_MS  2000U
#define CHAMELEON_POLL_INTERVAL_MS    50U

#define CHAMELEON_TEMP_SENTINEL_X100  ((int16_t)-12700)
#define CHAMELEON_RES_OPEN_OHMS       10000000U

/* Board-side primitives. Implemented in bsp.c on ARM, mock_chameleon_i2c.c on host. */
typedef enum {
    CHAMELEON_I2C_OK = 0,
    CHAMELEON_I2C_ERR_NACK,
    CHAMELEON_I2C_ERR_BUS,
    CHAMELEON_I2C_ERR_TIMEOUT
} chameleon_i2c_status_t;

chameleon_i2c_status_t chameleon_board_i2c_write(uint8_t addr7, const uint8_t *data, size_t len);
chameleon_i2c_status_t chameleon_board_i2c_write_read(uint8_t addr7,
                                                      const uint8_t *wdata, size_t wlen,
                                                      uint8_t *rdata, size_t rlen);
void                   chameleon_board_delay_ms(uint32_t ms);
uint16_t               chameleon_board_battery_mv(void);

/* High-level driver. */
int  via_chameleon_probe(void);                     /* 1 if device ACKs at 0x08, 0 otherwise */
int  via_chameleon_trigger(void);                   /* 1 on success */
int  via_chameleon_wait_ready(uint16_t timeout_ms); /* 1 if status==0x01 within timeout */

/* Read Chameleon measurement registers into `sample`, applying sentinel
 * detection and setting the appropriate status bits. Battery is filled by
 * via_chameleon_acquire() after this lower-level read.
 * Returns 1 if the I²C transactions all succeeded, 0 if any low-level call
 * failed (in which case status_flags will reflect the failure). */
int  via_chameleon_read_sample(chameleon_sample_t *sample);

/* End-to-end: probe → trigger → wait_ready → read_sample → fill battery_mv.
 * Always populates a payload-ready sample, even on failure (zero-filled
 * measurement fields with appropriate status bits set). Returns 1 if any
 * useful data was read; 0 if the device was missing entirely. */
int  via_chameleon_acquire(chameleon_sample_t *sample, uint16_t timeout_ms);

#endif /* VIA_CHAMELEON_H */
```

- [ ] **Step 2: Write `mock_chameleon_i2c.h`**

```c
// tests/mock_chameleon_i2c.h
#ifndef MOCK_CHAMELEON_I2C_H
#define MOCK_CHAMELEON_I2C_H

#include <stdint.h>
#include <stddef.h>
#include "via_chameleon.h"

void mock_chameleon_reset(void);

/* Configure the simulated slave's responses. */
void mock_chameleon_set_present(int present);             /* default: 1 */
void mock_chameleon_set_status_after_trigger(uint8_t v);  /* default: 0x01 */
void mock_chameleon_set_status_ready_after_polls(uint8_t polls); /* default: 0 */
void mock_chameleon_set_temp_x100(int16_t v);
void mock_chameleon_set_resistance(uint8_t channel, uint32_t ohms); /* channel 0..2 */
void mock_chameleon_set_id(const uint8_t id[8]);
void mock_chameleon_set_battery_mv(uint16_t v);

/* Inspect what the driver did. */
size_t mock_chameleon_trigger_count(void);
size_t mock_chameleon_status_poll_count(void);
size_t mock_chameleon_total_delay_ms(void);

#endif
```

- [ ] **Step 3: Write `mock_chameleon_i2c.c`**

```c
// tests/mock_chameleon_i2c.c
#include "mock_chameleon_i2c.h"
#include <string.h>

static int      g_present                = 1;
static uint8_t  g_status_after_trigger   = CHAMELEON_STATUS_READY;
static uint8_t  g_status_polls_until_ready = 0;
static uint8_t  g_status_polls_seen      = 0;
static int16_t  g_temp_x100              = 1987;
static uint32_t g_res_comp[3]            = {1100U, 10100U, 101200U};
static uint32_t g_res_raw[3]             = {1200U, 10200U, 102200U};
static uint8_t  g_id[8]                  = {0x28,0x6D,0x6A,0xDB,0x0F,0x00,0x00,0xF1};
static uint16_t g_battery_mv             = 3300;

static size_t   g_trigger_count          = 0;
static size_t   g_status_poll_count      = 0;
static size_t   g_total_delay_ms         = 0;

void mock_chameleon_reset(void) {
    g_present                  = 1;
    g_status_after_trigger     = CHAMELEON_STATUS_READY;
    g_status_polls_until_ready = 0;
    g_status_polls_seen        = 0;
    g_temp_x100                = 1987;
    g_res_comp[0] = 1100U; g_res_comp[1] = 10100U; g_res_comp[2] = 101200U;
    g_res_raw[0]  = 1200U; g_res_raw[1]  = 10200U; g_res_raw[2]  = 102200U;
    static const uint8_t default_id[8] = {0x28,0x6D,0x6A,0xDB,0x0F,0x00,0x00,0xF1};
    memcpy(g_id, default_id, 8);
    g_battery_mv               = 3300;
    g_trigger_count            = 0;
    g_status_poll_count        = 0;
    g_total_delay_ms           = 0;
}

void mock_chameleon_set_present(int present)             { g_present = present; }
void mock_chameleon_set_status_after_trigger(uint8_t v)  { g_status_after_trigger = v; }
void mock_chameleon_set_status_ready_after_polls(uint8_t n) {
    g_status_polls_until_ready = n;
    g_status_polls_seen        = 0;
}
void mock_chameleon_set_temp_x100(int16_t v)             { g_temp_x100 = v; }
void mock_chameleon_set_resistance(uint8_t ch, uint32_t v) {
    if (ch < 3) {
        g_res_comp[ch] = v;
        g_res_raw[ch] = v;
    }
}
void mock_chameleon_set_id(const uint8_t id[8])          { memcpy(g_id, id, 8); }
void mock_chameleon_set_battery_mv(uint16_t v)           { g_battery_mv = v; }

size_t mock_chameleon_trigger_count(void)        { return g_trigger_count; }
size_t mock_chameleon_status_poll_count(void)    { return g_status_poll_count; }
size_t mock_chameleon_total_delay_ms(void)       { return g_total_delay_ms; }

/* ---- driver primitives ---------------------------------------------- */

chameleon_i2c_status_t chameleon_board_i2c_write(uint8_t addr7, const uint8_t *data, size_t len) {
    if (!g_present) return CHAMELEON_I2C_ERR_NACK;
    if (addr7 != CHAMELEON_I2C_ADDR_7BIT) return CHAMELEON_I2C_ERR_NACK;
    if (len == 0) return CHAMELEON_I2C_OK;        /* zero-byte probe */
    if (len == 1 && data[0] == CHAMELEON_CMD_TRIGGER) {
        g_trigger_count++;
        g_status_polls_seen = 0;
        return CHAMELEON_I2C_OK;
    }
    return CHAMELEON_I2C_OK;
}

chameleon_i2c_status_t chameleon_board_i2c_write_read(uint8_t addr7,
                                                      const uint8_t *wdata, size_t wlen,
                                                      uint8_t *rdata, size_t rlen) {
    if (!g_present) return CHAMELEON_I2C_ERR_NACK;
    if (addr7 != CHAMELEON_I2C_ADDR_7BIT) return CHAMELEON_I2C_ERR_NACK;
    if (wlen != 1) return CHAMELEON_I2C_ERR_BUS;

    switch (wdata[0]) {
    case CHAMELEON_CMD_STATUS: {
        if (rlen != 1) return CHAMELEON_I2C_ERR_BUS;
        g_status_poll_count++;
        if (g_status_polls_seen < g_status_polls_until_ready) {
            g_status_polls_seen++;
            rdata[0] = 0x00;
        } else {
            rdata[0] = g_status_after_trigger;
        }
        return CHAMELEON_I2C_OK;
    }
    case CHAMELEON_CMD_TEMP: {
        if (rlen != 2) return CHAMELEON_I2C_ERR_BUS;
        rdata[0] = (uint8_t)(g_temp_x100 & 0xFF);
        rdata[1] = (uint8_t)((g_temp_x100 >> 8) & 0xFF);
        return CHAMELEON_I2C_OK;
    }
    case CHAMELEON_CMD_RES_CAL1:
    case CHAMELEON_CMD_RES_CAL2:
    case CHAMELEON_CMD_RES_CAL3: {
        if (rlen != 4) return CHAMELEON_I2C_ERR_BUS;
        uint32_t v = g_res_comp[wdata[0] - CHAMELEON_CMD_RES_CAL1];
        rdata[0] = (uint8_t)(v & 0xFF);
        rdata[1] = (uint8_t)((v >> 8) & 0xFF);
        rdata[2] = (uint8_t)((v >> 16) & 0xFF);
        rdata[3] = (uint8_t)((v >> 24) & 0xFF);
        return CHAMELEON_I2C_OK;
    }
    case CHAMELEON_CMD_RES_RAW1:
    case CHAMELEON_CMD_RES_RAW2:
    case CHAMELEON_CMD_RES_RAW3: {
        if (rlen != 4) return CHAMELEON_I2C_ERR_BUS;
        uint32_t v = g_res_raw[wdata[0] - CHAMELEON_CMD_RES_RAW1];
        rdata[0] = (uint8_t)(v & 0xFF);
        rdata[1] = (uint8_t)((v >> 8) & 0xFF);
        rdata[2] = (uint8_t)((v >> 16) & 0xFF);
        rdata[3] = (uint8_t)((v >> 24) & 0xFF);
        return CHAMELEON_I2C_OK;
    }
    case CHAMELEON_CMD_ID: {
        if (rlen != 8) return CHAMELEON_I2C_ERR_BUS;
        memcpy(rdata, g_id, 8);
        return CHAMELEON_I2C_OK;
    }
    default:
        return CHAMELEON_I2C_ERR_BUS;
    }
}

void chameleon_board_delay_ms(uint32_t ms) { g_total_delay_ms += ms; }

uint16_t chameleon_board_battery_mv(void)  { return g_battery_mv; }
```

- [ ] **Step 4: Write the failing driver test**

```c
// tests/test_chameleon_driver.c
#include "via_chameleon.h"
#include "mock_chameleon_i2c.h"
#include <stdio.h>
#include <stdlib.h>

#define ASSERT_EQ_U32(actual, expected, label) do {                             \
    if ((uint32_t)(actual) != (uint32_t)(expected)) {                           \
        fprintf(stderr, "FAIL %s: expected %u got %u (%s:%d)\n",                \
                (label), (unsigned)(expected), (unsigned)(actual),              \
                __FILE__, __LINE__);                                            \
        exit(1);                                                                \
    }                                                                           \
} while (0)

#define ASSERT_TRUE(c, l) do { if(!(c)){ fprintf(stderr, "FAIL %s (%s:%d)\n", (l), __FILE__, __LINE__); exit(1);} } while(0)

static void test_happy_path(void) {
    mock_chameleon_reset();
    chameleon_sample_t s;
    int ok = via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_TRUE(ok, "acquire ok");
    ASSERT_EQ_U32(s.status_flags, 0,        "no flags");
    ASSERT_EQ_U32(s.soil_temp_c_x100, 1987, "temp");
    ASSERT_EQ_U32(s.r1_ohm_comp, 1100,      "r1");
    ASSERT_EQ_U32(s.r2_ohm_comp, 10100,     "r2");
    ASSERT_EQ_U32(s.r3_ohm_comp, 101200,    "r3");
    ASSERT_EQ_U32(s.r1_ohm_raw,  1200,      "raw r1");
    ASSERT_EQ_U32(s.r2_ohm_raw,  10200,     "raw r2");
    ASSERT_EQ_U32(s.r3_ohm_raw,  102200,    "raw r3");
    ASSERT_EQ_U32(s.battery_mv, 3300,       "battery");
    ASSERT_EQ_U32(s.array_id[0], 0x28,      "id 0");
    ASSERT_EQ_U32(s.array_id[7], 0xF1,      "id 7");
    ASSERT_EQ_U32(mock_chameleon_trigger_count(), 1, "one trigger");
}

static void test_device_missing(void) {
    mock_chameleon_reset();
    mock_chameleon_set_present(0);
    chameleon_sample_t s;
    int ok = via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_EQ_U32(ok, 0, "acquire reports missing");
    ASSERT_TRUE(s.status_flags & CHAMELEON_FLAG_I2C_MISSING, "i2c missing flag");
    ASSERT_EQ_U32(s.r1_ohm_comp, 0, "r1 zeroed");
    ASSERT_EQ_U32(s.r1_ohm_raw, 0, "raw r1 zeroed");
}

static void test_status_polled_until_ready(void) {
    mock_chameleon_reset();
    mock_chameleon_set_status_ready_after_polls(3);
    chameleon_sample_t s;
    int ok = via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_TRUE(ok, "acquire ok");
    ASSERT_EQ_U32(s.status_flags, 0, "no flags");
    /* 3 not-ready polls + 1 ready poll = 4 status polls total */
    ASSERT_EQ_U32(mock_chameleon_status_poll_count(), 4, "4 polls");
    /* total delay >= 3 * 50 ms (poll interval) */
    ASSERT_TRUE(mock_chameleon_total_delay_ms() >= 150, "delay >= 150 ms");
}

static void test_status_timeout(void) {
    mock_chameleon_reset();
    mock_chameleon_set_status_after_trigger(0x00);  /* never goes ready */
    chameleon_sample_t s;
    int ok = via_chameleon_acquire(&s, 200);  /* short timeout */
    ASSERT_EQ_U32(ok, 1, "device present, partial data ok");
    ASSERT_TRUE(s.status_flags & CHAMELEON_FLAG_TIMEOUT, "timeout flag");
}

static void test_sentinel_temperature(void) {
    mock_chameleon_reset();
    mock_chameleon_set_temp_x100(CHAMELEON_TEMP_SENTINEL_X100);
    chameleon_sample_t s;
    via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_TRUE(s.status_flags & CHAMELEON_FLAG_TEMP_FAULT, "temp fault flag");
}

static void test_sentinel_id(void) {
    mock_chameleon_reset();
    uint8_t ff[8] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
    mock_chameleon_set_id(ff);
    chameleon_sample_t s;
    via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_TRUE(s.status_flags & CHAMELEON_FLAG_ID_FAULT, "id fault flag");
}

static void test_sentinel_open_channel(void) {
    mock_chameleon_reset();
    mock_chameleon_set_resistance(0, CHAMELEON_RES_OPEN_OHMS);
    mock_chameleon_set_resistance(2, CHAMELEON_RES_OPEN_OHMS);
    chameleon_sample_t s;
    via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_TRUE(s.status_flags & CHAMELEON_FLAG_CH1_OPEN, "ch1 open");
    ASSERT_TRUE(!(s.status_flags & CHAMELEON_FLAG_CH2_OPEN), "ch2 ok");
    ASSERT_TRUE(s.status_flags & CHAMELEON_FLAG_CH3_OPEN, "ch3 open");
}

int main(void) {
    test_happy_path();
    test_device_missing();
    test_status_polled_until_ready();
    test_status_timeout();
    test_sentinel_temperature();
    test_sentinel_id();
    test_sentinel_open_channel();
    printf("test_chameleon_driver OK\n");
    return 0;
}
```

- [ ] **Step 5: Wire it into `tests/Makefile`**

Update `TESTS`:

```make
TESTS := harness_smoke chameleon_payload chameleon_driver
```

And add the rule:

```make
$(OBJDIR)/test_chameleon_driver: test_chameleon_driver.c mock_chameleon_i2c.c \
		$(PROJ_BASE)/src/via_chameleon.c \
		$(PROJ_BASE)/src/chameleon_payload.c \
		| $(OBJDIR)
	$(CC) $(CFLAGS) "-I$(PROJ_BASE)/inc" "-I." -o $@ \
		test_chameleon_driver.c mock_chameleon_i2c.c \
		"$(PROJ_BASE)/src/via_chameleon.c" \
		"$(PROJ_BASE)/src/chameleon_payload.c"
```

- [ ] **Step 6: Run to confirm it fails**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make test
```

Expected: failure on missing `via_chameleon.c` (`No such file`) or undefined references like `via_chameleon_acquire`. That proves Task 4's implementation is what makes this pass.

---

### Task 4: Implement the I²C driver

**Files:**
- Create: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c`

- [ ] **Step 1: Write the driver**

```c
// src/via_chameleon.c
#include "via_chameleon.h"
#include <string.h>

static uint32_t le32(const uint8_t *p) {
    return ((uint32_t)p[0])
         | ((uint32_t)p[1] << 8)
         | ((uint32_t)p[2] << 16)
         | ((uint32_t)p[3] << 24);
}

static int16_t le16(const uint8_t *p) {
    return (int16_t)(((uint16_t)p[0]) | ((uint16_t)p[1] << 8));
}

int via_chameleon_probe(void) {
    /* Zero-byte transmission: ACK from address means device is present. */
    return chameleon_board_i2c_write(CHAMELEON_I2C_ADDR_7BIT, 0, 0) == CHAMELEON_I2C_OK ? 1 : 0;
}

int via_chameleon_trigger(void) {
    uint8_t cmd = CHAMELEON_CMD_TRIGGER;
    return chameleon_board_i2c_write(CHAMELEON_I2C_ADDR_7BIT, &cmd, 1) == CHAMELEON_I2C_OK ? 1 : 0;
}

static int read_status_byte(uint8_t *out) {
    uint8_t cmd = CHAMELEON_CMD_STATUS;
    return chameleon_board_i2c_write_read(CHAMELEON_I2C_ADDR_7BIT, &cmd, 1, out, 1) == CHAMELEON_I2C_OK ? 1 : 0;
}

int via_chameleon_wait_ready(uint16_t timeout_ms) {
    uint32_t elapsed = 0;
    while (elapsed <= timeout_ms) {
        uint8_t status = 0;
        if (read_status_byte(&status) && status == CHAMELEON_STATUS_READY) {
            return 1;
        }
        chameleon_board_delay_ms(CHAMELEON_POLL_INTERVAL_MS);
        elapsed += CHAMELEON_POLL_INTERVAL_MS;
    }
    return 0;
}

static void zero_measurements(chameleon_sample_t *s) {
    s->soil_temp_c_x100 = 0;
    s->r1_ohm_comp      = 0;
    s->r2_ohm_comp      = 0;
    s->r3_ohm_comp      = 0;
    s->r1_ohm_raw       = 0;
    s->r2_ohm_raw       = 0;
    s->r3_ohm_raw       = 0;
    memset(s->array_id, 0, 8);
}

int via_chameleon_read_sample(chameleon_sample_t *sample) {
    if (sample == 0) return 0;
    int all_ok = 1;
    uint8_t cmd;
    uint8_t buf4[4];
    uint8_t buf2[2];

    cmd = CHAMELEON_CMD_TEMP;
    if (chameleon_board_i2c_write_read(CHAMELEON_I2C_ADDR_7BIT, &cmd, 1, buf2, 2) == CHAMELEON_I2C_OK) {
        sample->soil_temp_c_x100 = le16(buf2);
    } else {
        sample->soil_temp_c_x100 = 0;
        all_ok = 0;
    }

    static const uint8_t comp_cmds[3] = {CHAMELEON_CMD_RES_CAL1, CHAMELEON_CMD_RES_CAL2, CHAMELEON_CMD_RES_CAL3};
    static const uint8_t raw_cmds[3]  = {CHAMELEON_CMD_RES_RAW1, CHAMELEON_CMD_RES_RAW2, CHAMELEON_CMD_RES_RAW3};
    uint32_t *comp_outs[3] = {&sample->r1_ohm_comp, &sample->r2_ohm_comp, &sample->r3_ohm_comp};
    uint32_t *raw_outs[3]  = {&sample->r1_ohm_raw,  &sample->r2_ohm_raw,  &sample->r3_ohm_raw};
    for (int i = 0; i < 3; i++) {
        cmd = comp_cmds[i];
        if (chameleon_board_i2c_write_read(CHAMELEON_I2C_ADDR_7BIT, &cmd, 1, buf4, 4) == CHAMELEON_I2C_OK) {
            *comp_outs[i] = le32(buf4);
        } else {
            *comp_outs[i] = 0;
            all_ok = 0;
        }

        cmd = raw_cmds[i];
        if (chameleon_board_i2c_write_read(CHAMELEON_I2C_ADDR_7BIT, &cmd, 1, buf4, 4) == CHAMELEON_I2C_OK) {
            *raw_outs[i] = le32(buf4);
        } else {
            *raw_outs[i] = 0;
            all_ok = 0;
        }
    }

    cmd = CHAMELEON_CMD_ID;
    if (chameleon_board_i2c_write_read(CHAMELEON_I2C_ADDR_7BIT, &cmd, 1, sample->array_id, 8) != CHAMELEON_I2C_OK) {
        memset(sample->array_id, 0, 8);
        all_ok = 0;
    }

    /* Sentinel detection. */
    if (sample->soil_temp_c_x100 == CHAMELEON_TEMP_SENTINEL_X100) {
        sample->status_flags |= CHAMELEON_FLAG_TEMP_FAULT;
    }
    {
        int all_ff = 1;
        for (int i = 0; i < 8; i++) { if (sample->array_id[i] != 0xFF) { all_ff = 0; break; } }
        if (all_ff) sample->status_flags |= CHAMELEON_FLAG_ID_FAULT;
    }
    if (sample->r1_ohm_comp == CHAMELEON_RES_OPEN_OHMS || sample->r1_ohm_raw == CHAMELEON_RES_OPEN_OHMS) sample->status_flags |= CHAMELEON_FLAG_CH1_OPEN;
    if (sample->r2_ohm_comp == CHAMELEON_RES_OPEN_OHMS || sample->r2_ohm_raw == CHAMELEON_RES_OPEN_OHMS) sample->status_flags |= CHAMELEON_FLAG_CH2_OPEN;
    if (sample->r3_ohm_comp == CHAMELEON_RES_OPEN_OHMS || sample->r3_ohm_raw == CHAMELEON_RES_OPEN_OHMS) sample->status_flags |= CHAMELEON_FLAG_CH3_OPEN;

    return all_ok;
}

int via_chameleon_acquire(chameleon_sample_t *sample, uint16_t timeout_ms) {
    if (sample == 0) return 0;
    memset(sample, 0, sizeof(*sample));

    if (!via_chameleon_probe()) {
        sample->status_flags |= CHAMELEON_FLAG_I2C_MISSING;
        sample->battery_mv = chameleon_board_battery_mv();
        return 0;
    }

    if (!via_chameleon_trigger()) {
        sample->status_flags |= CHAMELEON_FLAG_TIMEOUT;
        sample->battery_mv = chameleon_board_battery_mv();
        return 1;
    }

    if (!via_chameleon_wait_ready(timeout_ms)) {
        sample->status_flags |= CHAMELEON_FLAG_TIMEOUT;
        zero_measurements(sample);
        sample->battery_mv = chameleon_board_battery_mv();
        return 1;
    }

    via_chameleon_read_sample(sample);
    sample->battery_mv = chameleon_board_battery_mv();
    return 1;
}
```

- [ ] **Step 2: Run the tests**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make test
```

Expected last lines: `running build/test_chameleon_driver ... test_chameleon_driver OK` and `all host tests passed`.

- [ ] **Step 3: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/via_chameleon.h' \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c' \
        tests/test_chameleon_driver.c \
        tests/mock_chameleon_i2c.h tests/mock_chameleon_i2c.c \
        tests/Makefile
git commit -m "feat(chameleon): add I2C driver with trigger/poll/read state machine + sentinel detection"
```

---

### Task 5: ARM-side board primitives in `bsp.c`

**Files:**
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`

Add the Chameleon board primitives near the other HAL-adjacent helpers in `bsp.c`. Implement a Chameleon-owned `I2cHandle1`, a local 400 kHz I2C1 init helper, and four board functions:
- `chameleon_board_i2c_write` → for `len=0`: `HAL_I2C_IsDeviceReady` (probe). For `len>0`: `HAL_I2C_Master_Transmit(&I2cHandle1, addr7<<1, ...)`. Convert 7-bit address to 8-bit by `<<1`.
- `chameleon_board_i2c_write_read` → **single** `HAL_I2C_Mem_Read(&I2cHandle1, addr7<<1, cmd_byte, I2C_MEMADD_SIZE_8BIT, rdata, rlen, 1000)`. This issues `START → addr+W → cmd_byte → repeated START → addr+R → read rlen bytes → STOP` as one transaction, which is what the Chameleon protocol requires (the vendor library's repeated-start pattern via `Wire.endTransmission(false)`). Sequential `HAL_I2C_Master_Transmit` + `HAL_I2C_Master_Receive` would emit STOP between the command and the read, which the [hardware reference](2026-04-30-via-chameleon-hardware-reference.md) flags as "may not work."
- `chameleon_board_delay_ms` → `HAL_Delay(ms)`.
- `chameleon_board_battery_mv` → `extern uint16_t batteryLevel_mV; return batteryLevel_mV;`

Also add a local `chameleon_i2c1_init_400khz()` helper in `bsp.c` so the Chameleon-only mode configures PB6/PB7 at the vendor speed without changing the stock SHT timing globally.

`HAL_I2C_Mem_Read` is supported on this MCU and already used elsewhere in the codebase (see `HAL_I2C_Mem_Write` at `bsp.c:577` for the LIDAR), so this is a drop-in choice with no scaffolding cost. The host-test signature `chameleon_board_i2c_write_read(addr7, wdata, wlen, rdata, rlen)` is unchanged — `wlen` is always 1 (a single command byte) on every caller, so the ARM impl can ignore `wdata[0]`'s position and pass `wdata[0]` straight to the `MemAddress` parameter:

```c
return HAL_I2C_Mem_Read(&I2cHandle1, addr7 << 1, wdata[0], I2C_MEMADD_SIZE_8BIT, rdata, rlen, 1000);
```

The mock implementation in `tests/mock_chameleon_i2c.c` is unaffected — it dispatches on `wdata[0]` exactly as before.

Probe via `chameleon_board_i2c_write(..., len=0)` keeps the host-test interface small; the ARM implementation maps that case to `HAL_I2C_IsDeviceReady`.

- [ ] **Step 1: Fix I2C handle externs, then add the Chameleon include, handle, ready flag, and forward declaration in `bsp.c`**

Find the existing block of includes near the top of `bsp.c`. Add:

```c
#ifdef USE_CHAMELEON
#include "via_chameleon.h"
#endif
```

Then fix the existing handle declarations near the top of `bsp.c`. `I2cHandle3` must be visible even when the Chameleon target compiles with `-UUSE_SHT`, because mode 2 code references it outside the `USE_SHT` block and `lidar_lite_v3hp.c` defines it unconditionally. Keep `I2cHandle1` and `I2cHandle2` guarded, and move only `I2cHandle3` out:

```c
#ifdef USE_SHT
extern float sht31_tem,sht31_hum;
extern I2C_HandleTypeDef I2cHandle1;
extern I2C_HandleTypeDef I2cHandle2;
tfsensor_reading_t reading_t;
#endif
extern I2C_HandleTypeDef I2cHandle3;
```

Then, near the existing private/global variable block and outside the `#ifdef USE_SHT` block, add:

```c
#ifdef USE_CHAMELEON
I2C_HandleTypeDef I2cHandle1;
static uint8_t g_chameleon_i2c_ready;
#define CHAMELEON_I2C_TIMING_400KHZ  0x00B1112EU
static int chameleon_i2c1_init_400khz(void);
#endif
```

- [ ] **Step 2: Add the primitives near the end of `bsp.c`, before the copyright footer**

```c
/* ========================================================================
 *  VIA Chameleon board primitives (see inc/via_chameleon.h)
 *
 *  Implemented behind USE_CHAMELEON for the standalone Chameleon build.
 *  Reuses I2cHandle1 on PB6/PB7 and initialises it at 400 kHz to match
 *  the vendor library's Wire.setClock(400000).
 * ====================================================================== */
#ifdef USE_CHAMELEON

static int chameleon_i2c1_init_400khz(void) {
    g_chameleon_i2c_ready = 0;
    I2cHandle1.Instance              = I2Cx;
    I2cHandle1.Init.Timing           = CHAMELEON_I2C_TIMING_400KHZ;
    I2cHandle1.Init.AddressingMode   = I2C_ADDRESSINGMODE_7BIT;
    I2cHandle1.Init.DualAddressMode  = I2C_DUALADDRESS_DISABLE;
    I2cHandle1.Init.OwnAddress2Masks = I2C_OA2_NOMASK;
    I2cHandle1.Init.GeneralCallMode  = I2C_GENERALCALL_DISABLE;
    I2cHandle1.Init.NoStretchMode    = I2C_NOSTRETCH_DISABLE;
    I2cHandle1.Init.OwnAddress1      = 0xF0;
    I2cHandle1.Init.OwnAddress2      = 0xFE;

    if (HAL_I2C_Init(&I2cHandle1) != HAL_OK) {
        PRINTF("\r\nChameleon I2C init failed\r\n");
        return 0;
    }
    g_chameleon_i2c_ready = 1;
    return 1;
}

chameleon_i2c_status_t chameleon_board_i2c_write(uint8_t addr7, const uint8_t *data, size_t len) {
    uint16_t addr8 = (uint16_t)addr7 << 1;
    HAL_StatusTypeDef hs;
    if (!g_chameleon_i2c_ready) { return CHAMELEON_I2C_ERR_NACK; }
    if (len == 0) {
        /* Probe-only: zero-byte write. Use HAL_I2C_IsDeviceReady for clarity. */
        hs = HAL_I2C_IsDeviceReady(&I2cHandle1, addr8, 1, 1000);
    } else {
        hs = HAL_I2C_Master_Transmit(&I2cHandle1, addr8, (uint8_t *)data, (uint16_t)len, 1000);
    }
    if (hs == HAL_OK)      return CHAMELEON_I2C_OK;
    if (hs == HAL_TIMEOUT) return CHAMELEON_I2C_ERR_TIMEOUT;
    return CHAMELEON_I2C_ERR_NACK;
}

chameleon_i2c_status_t chameleon_board_i2c_write_read(uint8_t addr7,
                                                      const uint8_t *wdata, size_t wlen,
                                                      uint8_t *rdata, size_t rlen) {
    /* Every caller passes a single command byte and reads the response; the
     * VIA Chameleon protocol requires a repeated start between the two
     * phases. HAL_I2C_Mem_Read does both in one transaction:
     *   START → addr+W → wdata[0] → repeated START → addr+R → rlen bytes → STOP
     * Sequential Transmit+Receive would inject a STOP and may break the
     * slave (see vendor library: Wire.endTransmission(false)). */
    if (!g_chameleon_i2c_ready) { return CHAMELEON_I2C_ERR_NACK; }
    if (wlen != 1) { return CHAMELEON_I2C_ERR_BUS; }
    HAL_StatusTypeDef hs = HAL_I2C_Mem_Read(&I2cHandle1, (uint16_t)addr7 << 1,
                                            wdata[0], I2C_MEMADD_SIZE_8BIT,
                                            rdata, (uint16_t)rlen, 1000);
    if (hs == HAL_OK)      return CHAMELEON_I2C_OK;
    if (hs == HAL_TIMEOUT) return CHAMELEON_I2C_ERR_TIMEOUT;
    return CHAMELEON_I2C_ERR_NACK;
}

void chameleon_board_delay_ms(uint32_t ms) { HAL_Delay(ms); }

uint16_t chameleon_board_battery_mv(void) { return batteryLevel_mV; }

#endif /* USE_CHAMELEON */
```

- [ ] **Step 3: Defer ARM compile verification until Task 8**

The new code is behind `USE_CHAMELEON`; Task 8 adds the first ARM target that compiles it. Continue to Task 6 after reviewing the `bsp.c` diff.

- [ ] **Step 4: Commit**

```bash
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c'
git commit -m "feat(chameleon): add ARM HAL board primitives behind USE_CHAMELEON"
```

---

### Task 6: Replace MOD=3 init/read inside `bsp.c` under `USE_CHAMELEON`

**Files:**
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`

Three surgical edits:
- `BSP_sensor_Init()` — gate the MOD=3 SHT/BH1750 probe so under `USE_CHAMELEON` we instead call `chameleon_i2c1_init_400khz()` (sets up `I2cHandle1` at 400 kHz on PB6/PB7) and probe `0x08`.
- `BSP_sensor_Read()` — in the standalone Chameleon build, keep the stock MOD=3 ADC branch (`mode==3 || mode==8`) and call `via_chameleon_acquire()` after the ADC reads when `mode==3`.
- `main.c::Send()` — Task 7 keeps the stock MOD=3 status byte and ADC fields in the Chameleon payload.

`sensor_t` does not have a Chameleon field. Rather than expand `sensor_t` (it is shared across all firmware variants), we keep the latest sample in a file-local static inside `bsp.c` and provide an accessor for `main.c::Send()`.

- [ ] **Step 1: Add a static `chameleon_sample_t` and accessor near the top of `bsp.c`, outside the existing `USE_SHT` block**

Task 5 already created a `USE_CHAMELEON` block outside `USE_SHT` for `I2cHandle1`, `g_chameleon_i2c_ready`, the Chameleon timing macro, and `chameleon_i2c1_init_400khz()`. Extend that same block so the Chameleon sample accessor cannot disappear when the build uses `-UUSE_SHT`:

```c
#ifdef USE_CHAMELEON
I2C_HandleTypeDef I2cHandle1;
static uint8_t g_chameleon_i2c_ready;
static chameleon_sample_t g_chameleon_last_sample;
#define CHAMELEON_I2C_TIMING_400KHZ  0x00B1112EU
static int chameleon_i2c1_init_400khz(void);
const chameleon_sample_t *bsp_chameleon_last_sample(void)
{
    return &g_chameleon_last_sample;
}
#endif
```

Also add the matching declaration in `bsp.h` (so `main.c` can include it):

```c
/* in inc/bsp.h, near the existing function declarations */
#ifdef USE_CHAMELEON
#include "via_chameleon.h"
const chameleon_sample_t *bsp_chameleon_last_sample(void);
#endif
```

- [ ] **Step 2: Append Chameleon acquisition inside the stock MOD=3 ADC branch in `BSP_sensor_Read`**

After Task 0 there is no dendrometer-specific `else if(mode==3)` block in `bsp.c`, and the stock `else if((mode==3)||(mode==8))` branch remains. Inside that branch, immediately after `sensor_data->ADC_2=AD_code3*batteryLevel_mV/4095;`, add the Chameleon acquisition guarded by `mode==3`:

Review note: `mode` is file-scope `extern uint8_t mode;` in stock `bsp.c`, so the inner `if(mode==3)` is expected to be in scope here. Keep it anyway to avoid running Chameleon I2C acquisition during stock mode 8.

```c
#ifdef USE_CHAMELEON
    if(mode==3)
    {
        /* Keep stock MOD=3 ADC values in sensor_data, then append the
         * Chameleon I2C sample for main.c to encode in the same uplink. */
        (void)via_chameleon_acquire(&g_chameleon_last_sample,
                                    CHAMELEON_DEFAULT_TIMEOUT_MS);
        if(message==1)
        {
            PPRINTF("Chameleon flags:0x%02x temp:%d comp:%lu/%lu/%lu raw:%lu/%lu/%lu\r\n",
                    g_chameleon_last_sample.status_flags,
                    (int)g_chameleon_last_sample.soil_temp_c_x100,
                    (unsigned long)g_chameleon_last_sample.r1_ohm_comp,
                    (unsigned long)g_chameleon_last_sample.r2_ohm_comp,
                    (unsigned long)g_chameleon_last_sample.r3_ohm_comp,
                    (unsigned long)g_chameleon_last_sample.r1_ohm_raw,
                    (unsigned long)g_chameleon_last_sample.r2_ohm_raw,
                    (unsigned long)g_chameleon_last_sample.r3_ohm_raw);
        }
    }
#endif
```

- [ ] **Step 3: Gate the MOD=3 SHT block inside `BSP_sensor_Read`**

Locate the `if((mode==1)||(mode==3))` block at `bsp.c:155-199`. Under `USE_CHAMELEON`, the Chameleon MOD=3 path owns I2C1, so the SHT/BH1750 read path must not run for mode 3. Change the condition to:

```c
#ifdef USE_CHAMELEON
  if(mode==1)
#else
  if((mode==1)||(mode==3))
#endif
  {
    /* ...existing SHT2x / SHT3x / BH1750 read... */
  }
```

(do **not** change anything else in that block).

- [ ] **Step 4: Gate the MOD=3 init in `BSP_sensor_Init`**

Locate `bsp.c:507` (`if((mode==1)||(mode==3))`). Apply the same `#ifdef` gating:

```c
#ifdef USE_CHAMELEON
  if(mode==1)
#else
  if((mode==1)||(mode==3))
#endif
  {
    /* ...existing SHT/BH1750 probe... */
  }
```

Then add a new `else if` below the entire SHT/BH1750 block (still inside `BSP_sensor_Init`):

```c
#ifdef USE_CHAMELEON
  else if(mode==3)
  {
    /* Initialise I2C1 at 400 kHz on PB6/PB7, matching the VIA reference
     * library's Wire.setClock(400000). Init failure must not hard-hang the
     * node; later acquisition will report I2C missing. */
    if (!chameleon_i2c1_init_400khz()) {
      PRINTF("\r\nChameleon I2C disabled; uplinks will set I2C missing\r\n");
    } else if (via_chameleon_probe()) {
      PRINTF("\r\nChameleon detected at 0x08\r\n");
    } else {
      PRINTF("\r\nChameleon NOT detected at 0x08\r\n");
    }
  }
#endif
```

- [ ] **Step 5: Defer ARM compile verification until Task 8**

Task 8 adds the Chameleon ARM target that compiles these `USE_CHAMELEON` paths. Continue after reviewing the `bsp.c`/`bsp.h` diff for unrelated sensor carry-over.

- [ ] **Step 6: Commit**

```bash
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c' \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h'
git commit -m "feat(chameleon): wire MOD=3 read/init paths under USE_CHAMELEON flag"
```

---

### Task 7: Replace MOD=3 payload assembly inside `main.c::Send()` with stock-aligned Chameleon encoder

**Files:**
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`

- [ ] **Step 1: Add the include near the top of `main.c` (after existing app includes)**

```c
#ifdef USE_CHAMELEON
#include "via_chameleon.h"
#include "chameleon_payload.h"
#include "bsp.h"
#endif
```

- [ ] **Step 2: Replace the `else if(mode==3)` block in `Send()` (currently `main.c:641-675`) with a body-gated stock-aligned version**

```c
	else if(mode==3)
	{
#ifdef USE_CHAMELEON
		chameleon_sample_t cs = *bsp_chameleon_last_sample();
		uint8_t mod3_status;
		if(exit_temp==0)
		{
			switch_status=HAL_GPIO_ReadPin(GPIO_EXTI14_PORT,GPIO_EXTI14_PIN);
		}
		mod3_status = (switch_status<<7)|(sensor_data.in1<<1)|0x08|(exit_temp&0x01);

		cs.adc_pa0_mv  = sensor_data.oil;
		cs.adc_pa1_mv  = sensor_data.ADC_1;
		cs.adc_pa4_mv  = sensor_data.ADC_2;
		cs.mod3_status = mod3_status;

		/* AppData.Port is already set to lora_config_application_port_get()
		 * at the top of Send(), preserving stock/default FPort 2 behavior. */
		i = chameleon_payload_encode_v1(AppData.Buff, LORAWAN_APP_DATA_BUFF_SIZE, &cs);
#else
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
#endif /* USE_CHAMELEON */
	}
```

`AppData.BuffSize = i;` is set later in `Send()`; verify by reading lines after the switch in `main.c`. If it isn't set automatically, add `AppData.BuffSize = i;` immediately after the chameleon branch.
The `#else` body is the stock Dragino mode-3 payload code and must stay byte-for-byte equivalent except for formatting required by the surrounding preprocessor block.
Do not assign `cs.battery_mv` in `Send()`; `via_chameleon_acquire()` already populated it from `batteryLevel_mV` through `chameleon_board_battery_mv()`. Only fill the stock ADC fields and `mod3_status` here.

- [ ] **Step 3: Defer ARM compile verification until Task 8**

Task 8 adds the Chameleon ARM target that compiles the new `Send()` path.

- [ ] **Step 4: Commit**

```bash
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c'
git commit -m "feat(chameleon): emit stock-aligned BE chameleon MOD3 payload"
```

---

### Task 8: Convert ARM build to Chameleon targets

**Files:**
- Modify: `build/build.sh`
- Inspect: `build/cflags.rsp`, `build/stm32l072cz.ld`

The dendro-fork base already carries a working `build.sh` + `cflags.rsp` + `stm32l072cz.ld` GCC harness; the Task 0 prune commit deleted `dendrometer.c` but did not edit `build.sh`, which still references the now-missing source and bakes in the `LSN50-dendro` target name. This task rewrites `build.sh` to accept `chameleon` / `chameleon-dummy` arguments, drop the dendrometer source compile step, and add the chameleon source compile steps.

- [ ] **Step 1: Read the existing harness**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
sed -n '1,260p' build.sh
echo "---cflags.rsp---"
cat cflags.rsp
```

Note: the script will already reference `dendrometer.c` (since the dendro fork added it to the SRCS list when generating the Makefile). That reference is what makes the build fail after Task 0 step 7 — confirming this is the correct starting point.

- [ ] **Step 2: Remove the dendrometer compile step and add target selection**

Edit `build/build.sh`:
- Find the line that compiles `dendrometer.c` (something like `arm-none-eabi-gcc … -c '…/src/dendrometer.c' -o '…/obj/dendrometer.o'` plus an `OBJS="$OBJS …/obj/dendrometer.o"`). Delete both lines.
- Find the `TARGET=` (or equivalent) variable that hardcodes `LSN50-dendro` and remove that hardcoding — it will be replaced by `TARGET_BASENAME` from the case statement below.
- Do **not** remove `lidar_lite_v3hp.c` from the build in this task. Even though Chameleon mode does not use mode 2 at runtime, that file currently provides the unconditional `I2cHandle3` definition needed by the stock mode 2 code still present in `bsp.c`.

Then add target selection so it accepts `chameleon` (default) or `chameleon-dummy`:

```bash
TARGET_VARIANT="${1:-chameleon}"
case "$TARGET_VARIANT" in
  chameleon)
    TARGET_BASENAME="LSN50-chameleon"
    EXTRA_CFLAGS=(-UUSE_SHT -DUSE_CHAMELEON)
    ;;
  chameleon-dummy)
    TARGET_BASENAME="LSN50-chameleon-dummy"
    EXTRA_CFLAGS=(-UUSE_SHT -DUSE_CHAMELEON -DCHAMELEON_DUMMY)
    ;;
  *)
    echo "usage: $0 [chameleon|chameleon-dummy]" >&2
    exit 2
    ;;
esac
```

Update each compile command to include `"${EXTRA_CFLAGS[@]}"` **after** `@cflags.rsp`, for example. The order matters: `cflags.rsp` currently contains `-DUSE_SHT`, and the Chameleon targets intentionally override that with `-UUSE_SHT` so this firmware does not depend on the SHT driver.

```bash
arm-none-eabi-gcc @'/home/phil/Repos/LoRa_STM32-claude/build/cflags.rsp' "${EXTRA_CFLAGS[@]}" -c '...' -o '...'
```

- [ ] **Step 3: Compile the Chameleon sources**

Add these compile steps before linking:

```bash
echo "CC via_chameleon.c"
arm-none-eabi-gcc @'/home/phil/Repos/LoRa_STM32-claude/build/cflags.rsp' "${EXTRA_CFLAGS[@]}" -c '/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c' -o '/home/phil/Repos/LoRa_STM32-claude/build/obj/via_chameleon.o'
OBJS="$OBJS /home/phil/Repos/LoRa_STM32-claude/build/obj/via_chameleon.o"

echo "CC chameleon_payload.c"
arm-none-eabi-gcc @'/home/phil/Repos/LoRa_STM32-claude/build/cflags.rsp' "${EXTRA_CFLAGS[@]}" -c '/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/chameleon_payload.c' -o '/home/phil/Repos/LoRa_STM32-claude/build/obj/chameleon_payload.o'
OBJS="$OBJS /home/phil/Repos/LoRa_STM32-claude/build/obj/chameleon_payload.o"
```

Use `${TARGET_BASENAME}` in the link and `objcopy` commands:

```bash
arm-none-eabi-gcc -mcpu=cortex-m0plus -mthumb -T/home/phil/Repos/LoRa_STM32-claude/build/stm32l072cz.ld -Wl,--gc-sections -Wl,-Map=/home/phil/Repos/LoRa_STM32-claude/build/${TARGET_BASENAME}.map --specs=nano.specs --specs=nosys.specs $OBJS -o "/home/phil/Repos/LoRa_STM32-claude/build/${TARGET_BASENAME}.elf"
arm-none-eabi-objcopy -O ihex "/home/phil/Repos/LoRa_STM32-claude/build/${TARGET_BASENAME}.elf" "/home/phil/Repos/LoRa_STM32-claude/build/${TARGET_BASENAME}.hex"
arm-none-eabi-objcopy -O binary "/home/phil/Repos/LoRa_STM32-claude/build/${TARGET_BASENAME}.elf" "/home/phil/Repos/LoRa_STM32-claude/build/${TARGET_BASENAME}.bin"
arm-none-eabi-size "/home/phil/Repos/LoRa_STM32-claude/build/${TARGET_BASENAME}.elf"
```

- [ ] **Step 4: Run both build targets**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon
./build.sh chameleon-dummy
ls -l LSN50-chameleon.hex LSN50-chameleon-dummy.hex
```

Expected: both files exist and are non-empty. Both `.elf` files should reference symbols `via_chameleon_acquire` and `chameleon_payload_encode_v1`. Verify:

```bash
arm-none-eabi-nm LSN50-chameleon.elf | grep -E 'via_chameleon|chameleon_payload'
arm-none-eabi-nm LSN50-chameleon-dummy.elf | grep -E 'via_chameleon|chameleon_payload'
```

Expected: at least one symbol per name in both variants.

Also verify the standalone target did not retain dendrometer or SHT runtime symbols:

```bash
arm-none-eabi-nm LSN50-chameleon.elf | grep -E 'dendro|dendrometer|SHT20|SHT31|sht20|sht31' || true
```

Expected: no output.

- [ ] **Step 5: Run host tests one more time**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean && make test
```

Expected: `all host tests passed`.

- [ ] **Step 6: Update `build/.gitignore` to cover the new build outputs**

The existing `build/.gitignore` only ignores `obj/`, `home/`, and `Makefile`. That is why the dendro fork accidentally tracked `LSN50-dendro.{elf,bin,hex,map}` (deleted in Task 0). Without an update, the chameleon build outputs would face the same fate.

Edit `build/.gitignore` to:

```
obj/
home/
Makefile
LSN50-*.elf
LSN50-*.bin
LSN50-*.hex
LSN50-*.map
```

The `LSN50-*` glob covers `LSN50-chameleon.*`, `LSN50-chameleon-dummy.*`, and any future variants.

Verify with a clean build:

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon
git status --short build/
```

Expected `git status` for `build/`: only `build.sh` and `.gitignore` show as modified. The `.elf/.bin/.hex/.map` outputs must not appear.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add build/build.sh build/.gitignore
git commit -m "build(chameleon): rework ARM build for chameleon and chameleon-dummy targets"
```

Only `build.sh` and `.gitignore` should be staged. `cflags.rsp` and `stm32l072cz.ld` are unchanged.

---

### Task 9: Bring-up dummy mode (`CHAMELEON_DUMMY`)

**Files:**
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c`
- Modify: `build/build.sh`

The user's bring-up sequence requires a build that emits a fixed payload without touching I²C, so we can debug the LoRaWAN/payload pipeline before the reader is connected.

- [ ] **Step 1: Add the dummy short-circuit in `via_chameleon_acquire`**

Insert at the very top of `via_chameleon_acquire`, before `memset(sample, 0, ...)`:

```c
#ifdef CHAMELEON_DUMMY
    if (sample == 0) return 0;
    static const uint8_t dummy_id[8] = {0xDE,0xAD,0xBE,0xEF,0xDE,0xAD,0xBE,0xEF};
    sample->soil_temp_c_x100 = 2000;            /* 20.00 °C */
    sample->r1_ohm_comp      = 1600U;           /* 1.6 kΩ */
    sample->r2_ohm_comp      = 100000U;         /* 100 kΩ */
    sample->r3_ohm_comp      = 1600000U;        /* 1.6 MΩ */
    sample->r1_ohm_raw       = 1600U;
    sample->r2_ohm_raw       = 100000U;
    sample->r3_ohm_raw       = 1600000U;
    for (int i = 0; i < 8; i++) sample->array_id[i] = dummy_id[i];
    sample->battery_mv       = chameleon_board_battery_mv();
    sample->status_flags     = 0;
    (void)timeout_ms;
    return 1;
#endif
```

(The rest of the function stays unchanged after the `#endif`.)

- [ ] **Step 2: Confirm the dummy target exists**

Task 8 should already have this case in `build/build.sh`:

```bash
chameleon-dummy)
  TARGET_BASENAME="LSN50-chameleon-dummy"
  EXTRA_CFLAGS=(-UUSE_SHT -DUSE_CHAMELEON -DCHAMELEON_DUMMY)
  ;;
```

- [ ] **Step 3: Build and verify**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon-dummy
ls -l LSN50-chameleon-dummy.hex
```

Expected: file exists.

- [ ] **Step 4: Commit**

```bash
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c' \
        build/build.sh
git commit -m "feat(chameleon): add CHAMELEON_DUMMY bring-up build that bypasses I2C"
```

---

### Task 10: Firmware-only build verification

**Files:** none expected, unless verification exposes a build issue.

This task deliberately stays inside `/home/phil/Repos/LoRa_STM32-claude`. Do not edit server/gateway flows, schemas, or device types in this plan.

- [ ] **Step 1: Run host tests from a clean test build**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make test
```

Expected: `all host tests passed`.

- [ ] **Step 2: Build all firmware variants**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon
./build.sh chameleon-dummy
ls -l LSN50-chameleon.hex LSN50-chameleon-dummy.hex
```

Expected: both `.hex` files exist and are non-empty.

- [ ] **Step 3: Verify chameleon symbols are linked only into chameleon variants**

```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
arm-none-eabi-nm LSN50-chameleon.elf | grep -E 'via_chameleon|chameleon_payload'
arm-none-eabi-nm LSN50-chameleon-dummy.elf | grep -E 'via_chameleon|chameleon_payload'
```

Expected: chameleon symbols appear in both Chameleon variants.

- [ ] **Step 4: Commit any verification fixes**

If Task 10 required edits, commit them:

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git status --short
git add <changed-files>
git commit -m "fix(chameleon): complete firmware variant build verification"
```

If Task 10 required no edits, do not create an empty commit.

---

### Task 11: Rollout notes

**Files:**
- Create: `README-chameleon-claude.md` (in LoRa_STM32-claude root)

- [ ] **Step 1: Write the rollout doc**

```markdown
# LSN50 + VIA Chameleon I²C — Rollout Notes (Claude fork)

This fork adds a standalone Chameleon-only firmware variant for the Dragino
LSN50. It uses the LSN50's MOD=3 sampling/uplink path for a VIA Chameleon I²C
read and emits a 44-byte stock-MOD=3-aligned payload on the configured Dragino
application port (default FPort 2).

## Build variants

| Target        | Defines / overrides                  | Payload                                   |
|---------------|--------------------------------------|-------------------------------------------|
| `chameleon`   | `-UUSE_SHT -DUSE_CHAMELEON`          | 44-byte stock-aligned Chameleon payload, configured/default port |
| `chameleon-dummy` | `-UUSE_SHT -DUSE_CHAMELEON -DCHAMELEON_DUMMY` | Same shape; canned values, no I²C       |

Build with `./build/build.sh chameleon|chameleon-dummy`.

## Wiring

| LSN50 | VIA Chameleon |
|-------|---------------|
| GND   | GND           |
| VDD (3.3 V) | VCC     |
| PB6   | SCL           |
| PB7   | SDA           |

Power the reader at **3.3 V**, never 5 V (onboard 4.7 kΩ pull-ups would
drag SDA/SCL to 5 V and damage the STM32).

## Payload (configured/default FPort 2, big-endian, 44 bytes)

The first 8 bytes keep the stock no-SHT MOD=3 frame: ADCs, status, and the
one-byte `batteryLevel_mV / 100` field. The Chameleon extension starts at
offset 8.

| Offset | Size | Field                         |
|--------|------|-------------------------------|
| 0      | 2    | PA0 / oil ADC mV              |
| 2      | 2    | PA1 / ADC_1 mV                |
| 4      | 2    | PA4 / ADC_2 mV                |
| 6      | 1    | stock MOD=3 status byte       |
| 7      | 1    | battery / 100 mV              |
| 8      | 1    | payload version (`0x01`)      |
| 9      | 1    | Chameleon status flags        |
| 10     | 2    | soil temperature ×100         |
| 12     | 4    | compensated R1 (ohms)         |
| 16     | 4    | compensated R2 (ohms)         |
| 20     | 4    | compensated R3 (ohms)         |
| 24     | 4    | raw R1 (ohms)                 |
| 28     | 4    | raw R2 (ohms)                 |
| 32     | 4    | raw R3 (ohms)                 |
| 36     | 8    | DS18B20 array ID              |

Status flag bits: `0` = I²C missing, `1` = timeout, `2` = temp fault
(-127 °C), `3` = ID fault (0xFF×8), `4..6` = R1..R3 open
(compensated or raw 10 MΩ sentinel), `7` reserved.

On Chameleon-only deployments with nothing wired to PA0/PA1/PA4, bytes 0-5
are floating ADC noise and should be ignored downstream. They remain in the
payload only to preserve stock MOD=3 layout.

**Stock alignment:** stock LSN50 frames are big-endian and use the configured
application port. This firmware preserves that convention. The I²C driver
normalizes the Chameleon slave's little-endian register responses before the
payload encoder writes big-endian uplink bytes.

## kPa conversion

Resistance → soil-water tension is computed by the **server**, not the node:

```
x = ohms / 1000                  // x in kΩ
kPa = a*ln(x) + b*x + c           // (a, b, c) per array channel
```

Coefficients ship from VIA on paper; provisioning UX is out of scope for
this firmware version.

## Bring-up sequence

1. Build `chameleon-dummy`, flash, observe the raw configured/default FPort
   frame in ChirpStack or gateway logs. The first 8 bytes are live stock MOD=3
   ADC/status/battery fields; the Chameleon extension bytes match the canned values
   (compensated and raw both 1.6 kΩ / 100 kΩ / 1.6 MΩ, DEADBEEFx2 ID).
2. Build `chameleon`, flash, leave reader **disconnected** → expect
   `status_flags & 0x01` set (I²C missing).
3. Connect reader **without** soil probes → expect `0x70` (R1/R2/R3 open).
4. Connect a real probe set → expect realistic resistances and clean flags.
   If temp fault bit 2 appears, it refers to the Chameleon-side DS18B20 path
   (`0x01` / `0x30`), not the LSN50 external DS18B20 path.
5. 24-48 h soak.

Cycle time note: one acquisition includes the stock MOD=3 ADC sweep plus a
Chameleon measurement trigger/poll and 11 I²C register reads. A timeout can
add up to 2 s before the uplink; this is acceptable at minute-scale uplink
intervals but should be considered if the transmit interval is shortened.

## Rollback

- Flash the last known-good LSN50 firmware image for the target device.
- Or flash Dragino stock firmware (`kDrive/OSI OS/Hardware/Dragino LSN50/V2/.../EU868.hex`).
```

- [ ] **Step 2: Commit**

```bash
git add README-chameleon-claude.md
git commit -m "docs(chameleon): add rollout notes"
```

---

### Task 12: Bench and soak verification

**Files:** none (manual procedure).

- [ ] **Step 1: Flash the dummy build, no reader connected**

```bash
# from a workstation with the LSN50 attached via UART
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon-dummy
# follow the existing UART flashing procedure for the LSN50 hardware
```

Expected ChirpStack uplink on the configured/default port with payload bytes:
`<adc_pa0_be> <adc_pa1_be> <adc_pa4_be> <mod3_status> <bat_100mv> 01 00 07 D0 00 00 06 40 00 01 86 A0 00 18 6A 00 00 00 06 40 00 01 86 A0 00 18 6A 00 DE AD BE EF DE AD BE EF`
(20.00 °C → `0x07D0`; compensated 1600 → `0x00000640`, 100 000 → `0x000186A0`, 1 600 000 → `0x00186A00`; raw repeats the same three values).
ADC, status, and battery bytes vary with the device.

Decode the payload manually or with a throwaway local script during firmware bring-up. Persistence is not part of this plan.

- [ ] **Step 2: Flash the real build, reader powered off**

Build and flash `chameleon`. Expected first uplink on the configured/default port: Chameleon `status_flags = 0x01` at offset 9 (I2C missing); resistance fields zero; stock ADC/status/battery fields populated.

- [ ] **Step 3: Power the reader, leave probes disconnected**

Expected: Chameleon `status_flags = 0x70` at offset 9 (CH1/CH2/CH3 open).

- [ ] **Step 4: Connect the probe set**

Expected: realistic resistance (probe in moist soil → 1–10 kΩ; dry soil → 100 kΩ–1 MΩ). Status flags clean, except possibly bit 2 (temp fault) if the Chameleon-side DS18B20 read through commands `0x01` / `0x30` is unavailable. This is not the LSN50 external DS18B20 path.

- [ ] **Step 5: 24-48 h soak**

Leave the device joined and uplinking on its normal interval. Acceptance criteria:
- No watchdog resets (check device boot count via heartbeat or AT log).
- No degradation in uplink success rate vs. the stock LSN50.
- Chameleon status flags decoded from offset 9 are consistent across uplinks (no flapping).
- Battery byte decoded from offset 7 decreases at the expected rate (compare to a control unit).

- [ ] **Step 6: Promote**

If all bench/soak checks pass, open a firmware PR from `feature/chameleon-i2c-reader` in `LoRa_STM32`. Track decoding and persistence as a separate follow-up only after the payload shape is proven on hardware.

---

## Deferred / out-of-scope (tracked elsewhere)

- Per-channel calibration coefficient provisioning UX.
- Power-cycling the reader between cycles (PWR_OUT_PIN switching) — defer until current draw is measured on bench.
- Multiple Chameleon readers per node — would require an I²C mux; vendor library hard-codes 0x08.
- DS18B20 ID transmitted only on join / change — bandwidth optimisation; v1 sends it every cycle.
