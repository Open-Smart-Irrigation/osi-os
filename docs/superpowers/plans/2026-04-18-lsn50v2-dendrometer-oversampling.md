# LSN50V2 Dendrometer Oversampling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement paired oversampled `MOD=3` dendrometer measurements in the Dragino LSN50V2 firmware and update `osi-os` to decode the new 8-byte raw payload while preserving the existing ratio-based dendrometer pipeline.

**Architecture:** Add a pure C dendrometer module in `LoRa_STM32` with compile-time sampling constants, a host-buildable board-ops callback interface, and paired integer accumulation for the two ADC channels. Integrate that module into `BSP_sensor_Read()` and the `mode==3` payload packer, intentionally bypassing the legacy `AT+5VT` warm-up path and unused SHT reads for `MOD=3` so the new measurement path stays inside its fixed timing budget. Then update `osi-dendro-helper` and the existing sync-flow fixture so `osi-os` computes ratios from the two oversampled channels without depending on a ChirpStack codec.

**Tech Stack:** C (STM32/HAL-compatible helper code + local `gcc` test build), JavaScript (Node-RED helper, verification script), Bash, git

---

## File Map

### Firmware Repo: `/home/phil/Repos/LoRa_STM32`

- Create: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`
  Responsibility: compile-time constants, logical channel IDs, pure board callback interface, function declarations, payload length/flag constants without pulling STM32-only headers into host tests.

- Create: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`
  Responsibility: `read_adc_avg()`, `measure_dendrometer()`, `dendrometer_pack_mod3_payload()`.

- Create: `tests/dendrometer_test.c`
  Responsibility: host-side tests for averaging, paired oversampling, invalid-reference flags, and the new 8-byte `MOD=3` frame.

- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h:74-103`
  Responsibility: extend `sensor_t` with dedicated raw dendrometer fields without disturbing mode 8’s legacy `ADC_1` / `ADC_2` fields.

- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c:105-367`
  Responsibility: split the current combined `mode==3 || mode==8` ADC branch, add board wrappers for the pure dendrometer module, route `mode==3` through `measure_dendrometer()`.

- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c:641-675`
  Responsibility: replace the legacy `MOD=3` packet builder with the new 8-byte payload.

### Edge Repo: `/home/phil/Repos/osi-os`

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js:42-239`
  Responsibility: decode the new `MOD=3` raw frame, expose the averaged raw counts + flags, and keep returning compatibility fields (`batV`, `adcCh0V`, `adcCh1V`, `adcCh4V`) for the existing flow logic.

- Modify: `scripts/verify-sync-flow.js:1031-1197`
  Responsibility: replace the old `MOD=3` raw fixture with the new 8-byte frame and assert the updated decode behavior.

### Not Expected To Change

- `flows.json`
  The default LSN50 profile is created without a ChirpStack codec, so the existing flow already relies on `decodeRawAdcPayload(data.data)` as the authoritative raw path.

- `scripts/chirpstack-bootstrap.js`
  The LSN50 profile is created via `getOrCreateProfile(...)` without a payload codec, so no provisioning change is required for this feature.

---

### Task 1: Build The Pure Dendrometer Module With Failing Tests First

**Files:**
- Create: `/home/phil/Repos/LoRa_STM32/tests/dendrometer_test.c`
- Create: `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`
- Create: `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`
- Test: `/home/phil/Repos/LoRa_STM32/tests/dendrometer_test.c`

- [ ] **Step 1: Write the failing test**

Create `/home/phil/Repos/LoRa_STM32/tests/dendrometer_test.c`:

```c
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "dendrometer.h"

typedef struct {
    uint8_t power_events[4];
    uint8_t power_event_count;
    uint8_t channel_trace[128];
    uint8_t channel_trace_count;
    uint16_t delay_trace[128];
    uint8_t delay_trace_count;
    uint16_t signal_samples[DENDROMETER_SAMPLE_COUNT];
    uint16_t reference_samples[DENDROMETER_SAMPLE_COUNT];
    uint16_t signal_index;
    uint16_t reference_index;
} fake_board_t;

static void fake_set_power_enabled(void *ctx, uint8_t enabled) {
    fake_board_t *board = (fake_board_t *)ctx;
    board->power_events[board->power_event_count++] = enabled;
}

static uint16_t fake_read_adc_raw(void *ctx, uint8_t channel_id) {
    fake_board_t *board = (fake_board_t *)ctx;
    board->channel_trace[board->channel_trace_count++] = channel_id;
    if (channel_id == DENDROMETER_CHANNEL_SIGNAL) {
        return board->signal_samples[board->signal_index++];
    }
    if (channel_id == DENDROMETER_CHANNEL_REFERENCE) {
        return board->reference_samples[board->reference_index++];
    }
    return 0;
}

static void fake_delay_ms(void *ctx, uint16_t delay_ms) {
    fake_board_t *board = (fake_board_t *)ctx;
    board->delay_trace[board->delay_trace_count++] = delay_ms;
}

static void seed_samples(fake_board_t *board, uint16_t signal, uint16_t reference) {
    memset(board, 0, sizeof(*board));
    for (uint16_t i = 0; i < DENDROMETER_SAMPLE_COUNT; ++i) {
        board->signal_samples[i] = signal;
        board->reference_samples[i] = reference;
    }
}

static void test_read_adc_avg_returns_integer_mean(void) {
    assert(read_adc_avg(5000U, 5U) == 1000U);
    assert(read_adc_avg(999U, 0U) == 0U);
}

static void test_measure_dendrometer_pairs_channels_and_sets_valid_flag(void) {
    fake_board_t board;
    seed_samples(&board, 1024, 2048);

    dendrometer_board_ops_t ops = {
        .ctx = &board,
        .set_power_enabled = fake_set_power_enabled,
        .read_adc_raw = fake_read_adc_raw,
        .delay_ms = fake_delay_ms,
    };
    dendrometer_measurement_t measurement = {0};

    assert(measure_dendrometer(&ops, &measurement) == 0);
    assert(measurement.adc_signal_avg_raw == 1024);
    assert(measurement.adc_reference_avg_raw == 2048);
    assert(measurement.valid == 1);
    assert(measurement.flags == DENDROMETER_FLAG_VALID);
    assert(board.power_event_count == 2);
    assert(board.power_events[0] == 1);
    assert(board.power_events[1] == 0);
    assert(board.delay_trace_count == DENDROMETER_SAMPLE_COUNT);
    assert(board.delay_trace[0] == DENDROMETER_SETTLE_TIME_MS);
    assert(board.delay_trace[1] == DENDROMETER_SAMPLE_DELAY_MS);
    assert(board.channel_trace_count == (uint8_t)(DENDROMETER_SAMPLE_COUNT * 2U));
    assert(board.channel_trace[0] == DENDROMETER_CHANNEL_SIGNAL);
    assert(board.channel_trace[1] == DENDROMETER_CHANNEL_REFERENCE);
}

static void test_measure_dendrometer_marks_low_reference_invalid(void) {
    fake_board_t board;
    seed_samples(&board, 900, 64);

    dendrometer_board_ops_t ops = {
        .ctx = &board,
        .set_power_enabled = fake_set_power_enabled,
        .read_adc_raw = fake_read_adc_raw,
        .delay_ms = fake_delay_ms,
    };
    dendrometer_measurement_t measurement = {0};

    assert(measure_dendrometer(&ops, &measurement) == 0);
    assert(measurement.adc_signal_avg_raw == 900);
    assert(measurement.adc_reference_avg_raw == 64);
    assert(measurement.valid == 0);
    assert(measurement.flags == (DENDROMETER_FLAG_REFERENCE_TOO_LOW | DENDROMETER_FLAG_DIVISION_SKIPPED));
    assert(board.power_event_count == 2);
    assert(board.power_events[1] == 0);
}

static void test_pack_mod3_payload_emits_new_8_byte_frame(void) {
    const dendrometer_measurement_t measurement = {
        .adc_signal_avg_raw = 1024,
        .adc_reference_avg_raw = 2048,
        .valid = 1,
        .flags = DENDROMETER_FLAG_VALID,
    };
    uint8_t payload[DENDROMETER_MOD3_PAYLOAD_LEN] = {0};
    const uint8_t expected[DENDROMETER_MOD3_PAYLOAD_LEN] = {0x0F, 0xA0, 0x04, 0x00, 0x08, 0x00, 0x08, 0x01};

    assert(dendrometer_pack_mod3_payload(4000, 0x08, &measurement, payload, sizeof(payload)) == DENDROMETER_MOD3_PAYLOAD_LEN);
    assert(memcmp(payload, expected, sizeof(expected)) == 0);
}

int main(void) {
    test_read_adc_avg_returns_integer_mean();
    test_measure_dendrometer_pairs_channels_and_sets_valid_flag();
    test_measure_dendrometer_marks_low_reference_invalid();
    test_pack_mod3_payload_emits_new_8_byte_frame();
    puts("All dendrometer tests passed");
    return 0;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /home/phil/Repos/LoRa_STM32
gcc -std=c11 -Wall -Wextra -Werror -pedantic \
  -I STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/inc \
  tests/dendrometer_test.c \
  STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/dendrometer.c \
  -o /tmp/dendrometer_test
```

Expected: FAIL with missing `dendrometer.h` / `dendrometer.c` or undefined symbols for the new API.

- [ ] **Step 3: Write minimal implementation**

Create `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`:

```c
#ifndef __DENDROMETER_H__
#define __DENDROMETER_H__

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

#define DENDROMETER_SETTLE_TIME_MS      50U
#define DENDROMETER_SAMPLE_COUNT        50U
#define DENDROMETER_SAMPLE_DELAY_MS     1U
#define DENDROMETER_REF_MIN_RAW         128U
#define DENDROMETER_MOD3_PAYLOAD_LEN    8U

#define DENDROMETER_CHANNEL_SIGNAL      0U
#define DENDROMETER_CHANNEL_REFERENCE   1U

#define DENDROMETER_FLAG_VALID              0x01U
#define DENDROMETER_FLAG_REFERENCE_TOO_LOW  0x02U
#define DENDROMETER_FLAG_DIVISION_SKIPPED   0x04U

typedef struct {
    void *ctx;
    void (*set_power_enabled)(void *ctx, uint8_t enabled);
    uint16_t (*read_adc_raw)(void *ctx, uint8_t channel_id);
    void (*delay_ms)(void *ctx, uint16_t delay_ms);
} dendrometer_board_ops_t;

typedef struct {
    uint16_t adc_signal_avg_raw;
    uint16_t adc_reference_avg_raw;
    uint8_t valid;
    uint8_t flags;
} dendrometer_measurement_t;

uint16_t read_adc_avg(uint32_t accumulated_sum, uint16_t sample_count);
int measure_dendrometer(const dendrometer_board_ops_t *ops, dendrometer_measurement_t *measurement);
uint8_t dendrometer_pack_mod3_payload(uint16_t battery_mv, uint8_t status_mode_byte, const dendrometer_measurement_t *measurement, uint8_t *payload, uint8_t payload_len);

#ifdef __cplusplus
}
#endif

#endif
```

Create `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`:

```c
#include <string.h>

#include "dendrometer.h"

uint16_t read_adc_avg(uint32_t accumulated_sum, uint16_t sample_count)
{
    if (sample_count == 0U) {
        return 0U;
    }

    return (uint16_t)(accumulated_sum / sample_count);
}

int measure_dendrometer(const dendrometer_board_ops_t *ops, dendrometer_measurement_t *measurement)
{
    uint32_t signal_sum = 0U;
    uint32_t reference_sum = 0U;

    if (ops == 0 || measurement == 0 || ops->set_power_enabled == 0 || ops->read_adc_raw == 0 || ops->delay_ms == 0) {
        return -1;
    }

    memset(measurement, 0, sizeof(*measurement));

    ops->set_power_enabled(ops->ctx, 1U);
    ops->delay_ms(ops->ctx, DENDROMETER_SETTLE_TIME_MS);

    for (uint16_t i = 0; i < DENDROMETER_SAMPLE_COUNT; ++i) {
        signal_sum += ops->read_adc_raw(ops->ctx, DENDROMETER_CHANNEL_SIGNAL);
        reference_sum += ops->read_adc_raw(ops->ctx, DENDROMETER_CHANNEL_REFERENCE);
        if ((i + 1U) < DENDROMETER_SAMPLE_COUNT) {
            ops->delay_ms(ops->ctx, DENDROMETER_SAMPLE_DELAY_MS);
        }
    }

    ops->set_power_enabled(ops->ctx, 0U);

    measurement->adc_signal_avg_raw = read_adc_avg(signal_sum, DENDROMETER_SAMPLE_COUNT);
    measurement->adc_reference_avg_raw = read_adc_avg(reference_sum, DENDROMETER_SAMPLE_COUNT);

    if (measurement->adc_reference_avg_raw < DENDROMETER_REF_MIN_RAW) {
        measurement->valid = 0U;
        measurement->flags = DENDROMETER_FLAG_REFERENCE_TOO_LOW | DENDROMETER_FLAG_DIVISION_SKIPPED;
        return 0;
    }

    measurement->valid = 1U;
    measurement->flags = DENDROMETER_FLAG_VALID;
    return 0;
}

uint8_t dendrometer_pack_mod3_payload(uint16_t battery_mv, uint8_t status_mode_byte, const dendrometer_measurement_t *measurement, uint8_t *payload, uint8_t payload_len)
{
    if (measurement == 0 || payload == 0 || payload_len < DENDROMETER_MOD3_PAYLOAD_LEN) {
        return 0;
    }

    payload[0] = (uint8_t)(battery_mv >> 8);
    payload[1] = (uint8_t)(battery_mv);
    payload[2] = (uint8_t)(measurement->adc_signal_avg_raw >> 8);
    payload[3] = (uint8_t)(measurement->adc_signal_avg_raw);
    payload[4] = (uint8_t)(measurement->adc_reference_avg_raw >> 8);
    payload[5] = (uint8_t)(measurement->adc_reference_avg_raw);
    payload[6] = status_mode_byte;
    payload[7] = measurement->flags;
    return DENDROMETER_MOD3_PAYLOAD_LEN;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd /home/phil/Repos/LoRa_STM32
gcc -std=c11 -Wall -Wextra -Werror -pedantic \
  -I STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/inc \
  tests/dendrometer_test.c \
  STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/dendrometer.c \
  -o /tmp/dendrometer_test && /tmp/dendrometer_test
```

Expected: PASS with `All dendrometer tests passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32
git add tests/dendrometer_test.c \
  STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/inc/dendrometer.h \
  STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/dendrometer.c
git commit -m "feat: add pure dendrometer helpers for MOD3"
```

### Task 2: Wire The Dendrometer Module Into The Firmware

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h:74-103`
- Modify: `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c:105-367`
- Modify: `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c:641-675`
- Test: `/home/phil/Repos/LoRa_STM32/tests/dendrometer_test.c`

- [ ] **Step 1: Extend `sensor_t` with dedicated raw dendrometer fields**

Update `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h` inside `sensor_t`:

```c
typedef struct{
	
  uint8_t   in1;/*GPIO Digital Input 0 or 1*/
	
	float temp1;//DS18B20-1

	float temp2;//DS18B20-2

	float temp3;//DS18B20-3
	
	float oil;  //oil float

	float ADC_1; //ADC1
	
	float ADC_2;  //ADC2

    uint16_t dendro_signal_avg_raw;
    uint16_t dendro_reference_avg_raw;
    uint8_t dendro_valid;
    uint8_t dendro_flags;

	float temp_sht;
	
	float hum_sht;
	
	uint16_t illuminance;	
	
  uint16_t distance_mm;
	
	uint16_t distance_signal_strengh;
	
	int32_t Weight;

  /**more may be added*/
} sensor_t;
```

- [ ] **Step 2: Route `mode==3` through `measure_dendrometer()` and split it from `mode==8`**

Update `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`:

```c
#include "dendrometer.h"
```

Change the shared SHT/BH1750 gate so the new compact `MOD=3` path does not spend time reading sensors it no longer transmits:

```c
  if(mode==1)
```

Add wrappers near the top of the file:

```c
static void dendro_set_power_enabled(void *ctx, uint8_t enabled)
{
    (void)ctx;
    HAL_GPIO_WritePin(PWR_OUT_PORT, PWR_OUT_PIN, enabled ? GPIO_PIN_RESET : GPIO_PIN_SET);
}

static uint16_t dendro_read_adc_raw(void *ctx, uint8_t channel_id)
{
    (void)ctx;

    switch (channel_id)
    {
        case DENDROMETER_CHANNEL_SIGNAL:
            return HW_AdcReadChannel(ADC_Channel_Oil);
        case DENDROMETER_CHANNEL_REFERENCE:
            return HW_AdcReadChannel(ADC_Channel_IN1);
        default:
            return 0U;
    }
}

static void dendro_delay_ms(void *ctx, uint16_t delay_ms)
{
    (void)ctx;
    HAL_Delay(delay_ms);
}

static const dendrometer_board_ops_t dendro_board_ops = {
    .ctx = 0,
    .set_power_enabled = dendro_set_power_enabled,
    .read_adc_raw = dendro_read_adc_raw,
    .delay_ms = dendro_delay_ms,
};
```

Change the generic `power_time` block so `mode==3` does not do the legacy warm-up path:

```c
if ((power_time != 0) && (mode != 3))
{
    HAL_GPIO_WritePin(PWR_OUT_PORT,PWR_OUT_PIN,GPIO_PIN_RESET);//Enable 5v power supply
    for(uint16_t i=0;i<(uint16_t)(power_time/100);i++)
    {
         HAL_Delay(100);
         if((i%99==0)&&(i!=0))
         {
            IWDG_Refresh();
         }
    }
}
```

Replace the current combined `else if((mode==3)||(mode==8))` branch with separate `mode==3` and `mode==8` branches:

```c
else if(mode==3)
{
    dendrometer_measurement_t measurement = {0};
    measure_dendrometer(&dendro_board_ops, &measurement);

    sensor_data->dendro_signal_avg_raw = measurement.adc_signal_avg_raw;
    sensor_data->dendro_reference_avg_raw = measurement.adc_reference_avg_raw;
    sensor_data->dendro_valid = measurement.valid;
    sensor_data->dendro_flags = measurement.flags;

    if(message==1)
    {
        PPRINTF("DENDRO_PA0_RAW:%u\r\n", sensor_data->dendro_signal_avg_raw);
        PPRINTF("DENDRO_PA1_RAW:%u\r\n", sensor_data->dendro_reference_avg_raw);
        PPRINTF("DENDRO_VALID:%d FLAGS:0x%02X\r\n", sensor_data->dendro_valid, sensor_data->dendro_flags);
    }
}
else if(mode==8)
{
     BSP_oil_float_Init();
     for(uint8_t w=0;w<6;w++)
     {
         adcdata[0][w] = HW_AdcReadChannel( ADC_Channel_Oil );//PA0
         HAL_Delay(10);
     }
     AD_code1=ADC_Average(adcdata[0]);
     sensor_data->oil=AD_code1*batteryLevel_mV/4095;

     HAL_Delay(50);
     for(uint8_t y=0;y<6;y++)
     {
         adcdata[1][y] = HW_AdcReadChannel( ADC_Channel_IN1 );//PA1
         HAL_Delay(10);
     }
     AD_code2=ADC_Average(adcdata[1]);
     sensor_data->ADC_1=AD_code2*batteryLevel_mV/4095;

     HAL_Delay(50);
     for(uint8_t z=0;z<6;z++)
     {
         adcdata[2][z] = HW_AdcReadChannel( ADC_Channel_IN4 );//PA4
         HAL_Delay(10);
     }
     AD_code3=ADC_Average(adcdata[2]);
     sensor_data->ADC_2=AD_code3*batteryLevel_mV/4095;
     HAL_GPIO_WritePin(OIL_CONTROL_PORT,OIL_CONTROL_PIN,GPIO_PIN_SET);

     if(message==1)
     {
         PPRINTF("ADC_PA0:%.3f V\r\n",(sensor_data->oil/1000.0));
         PPRINTF("ADC_PA1:%.3f V\r\n",(sensor_data->ADC_1/1000.0));
         PPRINTF("ADC_PA4:%.3f V\r\n",(sensor_data->ADC_2/1000.0));
     }
}
```

- [ ] **Step 3: Replace the `MOD=3` payload builder with the new 8-byte frame**

Update `/home/phil/Repos/LoRa_STM32/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`:

```c
	else if(mode==3)
	{
        dendrometer_measurement_t measurement;
        uint8_t status_mode_byte;
        uint8_t written;

		if(exit_temp==0)
		{
			switch_status=HAL_GPIO_ReadPin(GPIO_EXTI14_PORT,GPIO_EXTI14_PIN);		
		}
        measurement.adc_signal_avg_raw = sensor_data.dendro_signal_avg_raw;
        measurement.adc_reference_avg_raw = sensor_data.dendro_reference_avg_raw;
        measurement.valid = sensor_data.dendro_valid;
        measurement.flags = sensor_data.dendro_flags;
        status_mode_byte = (switch_status<<7)|(sensor_data.in1<<1)|0x08|(exit_temp&0x01);
        written = dendrometer_pack_mod3_payload(
            batteryLevel_mV,
            status_mode_byte,
            &measurement,
            &AppData.Buff[i],
            (uint8_t)(LORAWAN_APP_DATA_BUFF_SIZE - i)
        );
        i += written;
	}
```

Add the include near the existing local headers:

```c
#include "dendrometer.h"
```

- [ ] **Step 4: Run regression checks**

Run the host test again:

```bash
cd /home/phil/Repos/LoRa_STM32
gcc -std=c11 -Wall -Wextra -Werror -pedantic \
  -I STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/inc \
  tests/dendrometer_test.c \
  STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/dendrometer.c \
  -o /tmp/dendrometer_test && /tmp/dendrometer_test
```

Expected: PASS with `All dendrometer tests passed`.

Then do the embedded integration check in STM32CubeIDE:

1. Refresh the imported `LoRa_STM32` project so the new `dendrometer.c` / `dendrometer.h` files are visible.
2. Confirm `REGION_EU868` is still enabled for the active LSN50 build configuration.
3. Build the project.

Expected: clean build, or at worst only pre-existing warnings unrelated to this change.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32
git add STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/inc/bsp.h \
  STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/bsp.c \
  STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/main.c
git commit -m "feat: switch MOD3 to oversampled dendrometer payload"
```

### Task 3: Update The `osi-os` Raw Decoder With A Failing Fixture First

**Files:**
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js:42-239`
- Modify: `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js:1031-1197`
- Test: `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js`

- [ ] **Step 1: Write the failing test**

Update the `MOD=3` helper fixture in `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js`:

```js
    const mod3Fixture = Buffer.from([0x0F, 0xA0, 0x04, 0x00, 0x08, 0x00, 0x08, 0x01]).toString('base64');
    const decoded = dendroHelper.decodeRawAdcPayload(mod3Fixture);
    expectApprox(decoded && decoded.batV, 4.0, 0.001, 'dendro helper decodes battery voltage from the new MOD3 payload');
    expectApprox(decoded && decoded.adcCh0V, 1.0, 0.001, 'dendro helper derives ADC_CH0V from averaged raw MOD3 counts');
    expectApprox(decoded && decoded.adcCh1V, 2.0, 0.001, 'dendro helper derives ADC_CH1V from averaged raw MOD3 counts');
    expectEqual(decoded && decoded.adcCh4V, null, 'dendro helper clears ADC_CH4V for the new MOD3 payload');
    expectEqual(decoded && decoded.adcSignalAvgRaw, 1024, 'dendro helper exposes averaged PA0 raw counts');
    expectEqual(decoded && decoded.adcReferenceAvgRaw, 2048, 'dendro helper exposes averaged PA1 raw counts');
    expectEqual(decoded && decoded.measurementValid, 1, 'dendro helper exposes the dendrometer valid flag');
    expectEqual(decoded && decoded.modeCode, 3, 'dendro helper decodes MOD3 mode from raw payloads');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
```

Expected: FAIL on the old `MOD=3` decode assertions because `decodeRawAdcPayload()` still interprets bytes `2-5` as legacy temperature/voltage fields.

- [ ] **Step 3: Write minimal implementation**

Update `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`:

```js
function decodeRawAdcPayload(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < 7) return null;

    const batV = ((buf[0] << 8) | buf[1]) / 1000;
    const modeCode = detectLsn50ModeCode(b64);
    const isNewMod3 = modeCode === 3 && buf.length === 8;

    if (isNewMod3) {
      const adcSignalAvgRaw = (buf[2] << 8) | buf[3];
      const adcReferenceAvgRaw = (buf[4] << 8) | buf[5];
      const flags = buf[7];
      const measurementValid = (flags & 0x01) === 0x01 ? 1 : 0;
      const referenceTooLow = (flags & 0x02) === 0x02 ? 1 : 0;
      const divisionSkipped = (flags & 0x04) === 0x04 ? 1 : 0;
      const adcScaleV = batV / 4095;
      const adcCh0V = roundTo(adcSignalAvgRaw * adcScaleV, 6);
      const adcCh1V = roundTo(adcReferenceAvgRaw * adcScaleV, 6);

      return {
        batV,
        tempC1: null,
        adcCh0V,
        adcCh1V,
        adcCh4V: null,
        adcSignalAvgRaw,
        adcReferenceAvgRaw,
        measurementValid,
        referenceTooLow,
        divisionSkipped,
        modeCode,
        modeLabel: lsn50ModeLabel(modeCode),
      };
    }

    const tempDisconnected = buf.length >= 4 && buf[2] === 0x7f && buf[3] === 0xff;
    const tempRaw = buf.length >= 4 ? ((buf[2] << 24 >> 16) | buf[3]) : null;
    const tempC1 = tempDisconnected || tempRaw === null ? null : tempRaw / 10;
    const adcCh0V = buf.length >= 6 ? ((buf[4] << 8) | buf[5]) / 1000 : null;
    const adcCh1V = buf.length >= 9 ? ((buf[7] << 8) | buf[8]) / 1000 : null;
    const adcCh4V = buf.length >= 11 ? ((buf[9] << 8) | buf[10]) / 1000 : null;

    return {
      batV,
      tempC1,
      adcCh0V,
      adcCh1V,
      adcCh4V,
      modeCode,
      modeLabel: lsn50ModeLabel(modeCode),
    };
  } catch (_) {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
```

Expected: PASS with the existing tail line:

```text
Sync flow verification passed
```

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js \
  scripts/verify-sync-flow.js
git commit -m "fix: decode the new LSN50 MOD3 dendrometer payload"
```

### Task 4: Final Verification And Integration Notes

**Files:**
- Modify: none expected if all prior tasks are green
- Test: `/home/phil/Repos/LoRa_STM32/tests/dendrometer_test.c`
- Test: `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js`

- [ ] **Step 1: Re-run firmware helper tests from a clean shell**

Run:

```bash
cd /home/phil/Repos/LoRa_STM32
gcc -std=c11 -Wall -Wextra -Werror -pedantic \
  -I STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/inc \
  tests/dendrometer_test.c \
  STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/dendrometer.c \
  -o /tmp/dendrometer_test && /tmp/dendrometer_test
```

Expected: PASS with `All dendrometer tests passed`.

- [ ] **Step 2: Re-run the `osi-os` flow verification**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
```

Expected: PASS with `Sync flow verification passed`.

- [ ] **Step 3: Perform the STM32CubeIDE build check**

Manual verification in the IDE:

1. Refresh the Dragino project tree after the new source files are added.
2. Make sure the EU868 configuration is still active.
3. Build the project and confirm the `mode==3` branch compiles with `dendrometer.h`.

Expected: project builds without introducing new `MOD=3` compile errors.

- [ ] **Step 4: Record the outcome**

Capture in the implementation summary:

- whether the host C tests passed
- whether `verify-sync-flow.js` passed
- whether STM32CubeIDE build was completed or skipped
- that no ChirpStack profile codec update was required because the default LSN50 profile is provisioned without one

- [ ] **Step 5: Commit only if verification changed a tracked file**

If verification left the tree unchanged, do not create an extra commit.

If a tracked file needed a last-minute fix during verification, commit with the narrowest message that matches the change:

```bash
git add <exact-fixed-files>
git commit -m "fix: clean up MOD3 dendrometer verification issues"
```

---

## Self-Review

### Spec coverage

- Firmware board/measurement split: covered by Task 1 and Task 2.
- `measure_dendrometer()` / `read_adc_avg()`: covered by Task 1.
- New `MOD=3` payload: covered by Task 1 and Task 2.
- Other modes unchanged: covered by the `mode==3` / `mode==8` split in Task 2.
- Decoder update in `osi-os`: covered by Task 3.
- Verification notes: covered by Task 4.

### Placeholder scan

- No `TODO`, `TBD`, or “similar to Task N” placeholders remain.
- Every code-changing step includes concrete file paths and code.
- All verification steps include exact commands where the repo supports them.

### Type consistency

- `dendrometer_measurement_t` is the shared source for payload packing and sensor-state handoff.
- `sensor_t` adds new dedicated raw fields instead of reusing `ADC_1` / `ADC_2`, so mode 8 remains stable.
- `decodeRawAdcPayload()` continues to expose `adcCh0V` / `adcCh1V` as compatibility fields, which matches the existing `buildDendroDerivedMetrics()` API.
