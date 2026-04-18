# LSN50V2 Ratiometric Dendrometer Implementation Plan (Claude)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LSN50V2 stock `MOD=3` with an oversampled ratiometric dendrometer pipeline (50 paired samples of PA0/PA1, raw averages on the wire, validity flags), and update the `osi-dendro-helper` decoder so raw averages drive the existing analytics.

**Architecture:** Two-repo change. Firmware work lives in `/home/phil/Repos/LoRa_STM32-claude` on branch `feature/ratiometric-dendrometer-claude` — a new pure-C `dendrometer.c/h` module gated behind five board primitives declared in the header and implemented inside the existing `bsp.c`. Decoder work lives in the osi-os worktree `/home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude` on branch `feature/lsn50-dendrometer-decoder-claude` — a new `decodeMod3DendroPayload` plus a small dispatcher change in `osi-dendro-helper/index.js`. Everything is test-driven: host-side C tests with native gcc for firmware logic, `node --test` for decoder.

**Tech Stack:** C99, native `gcc` for host tests, `arm-none-eabi-gcc` for ARM smoke-compile, Node.js ≥ 20 built-in test runner, GNU Make.

**Repo references:**
- **Firmware fork:** `/home/phil/Repos/LoRa_STM32-claude` — branch `feature/ratiometric-dendrometer-claude`
- **osi-os worktree:** `/home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude` — branch `feature/lsn50-dendrometer-decoder-claude`
- **Spec:** `docs/superpowers/specs/2026-04-18-lsn50v2-dendrometer-claude-design.md`

Every task below specifies which directory to `cd` into first.

---

## Task 1: Scaffold firmware test harness

**Goal:** Get a trivial host-side C test running in `tests/` before writing any dendrometer code, so the harness is proven before TDD starts.

**Files:**
- Create: `/home/phil/Repos/LoRa_STM32-claude/tests/Makefile`
- Create: `/home/phil/Repos/LoRa_STM32-claude/tests/test_harness_smoke.c`

- [ ] **Step 1.1: Write the smoke-test file**

Create `tests/test_harness_smoke.c`:

```c
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int expected = 2;
    int actual = 1 + 1;
    if (expected != actual) {
        fprintf(stderr, "FAIL: expected %d got %d\n", expected, actual);
        return 1;
    }
    puts("PASS harness_smoke");
    return 0;
}
```

- [ ] **Step 1.2: Write the Makefile**

Create `tests/Makefile`:

```make
# Host-side tests for LSN50V2 dendrometer firmware.
# Uses native gcc; no ARM, no HAL, no cross-compilation.

CC      ?= gcc
CFLAGS  ?= -std=c99 -Wall -Wextra -Werror -O0 -g -I../STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/inc
OBJDIR  := build

TESTS := harness_smoke dendrometer

.PHONY: all test clean
all: test

test: $(addprefix $(OBJDIR)/test_,$(TESTS))
	@set -e; for t in $^; do \
		printf "running %s ... " "$$t"; \
		"./$$t" || { echo FAIL; exit 1; }; \
	done
	@echo "all host tests passed"

$(OBJDIR)/test_harness_smoke: test_harness_smoke.c | $(OBJDIR)
	$(CC) $(CFLAGS) -o $@ $<

$(OBJDIR)/test_dendrometer: test_dendrometer.c mock_board.c \
		../STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/dendrometer.c \
		| $(OBJDIR)
	$(CC) $(CFLAGS) -o $@ test_dendrometer.c mock_board.c \
		../STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/dendrometer.c

$(OBJDIR):
	mkdir -p $@

clean:
	rm -rf $(OBJDIR)
```

- [ ] **Step 1.3: Run the harness smoke test**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude/tests && make build/test_harness_smoke && ./build/test_harness_smoke
```

Expected output:
```
PASS harness_smoke
```

(The `test_dendrometer` target will fail to build at this point because the source files don't exist yet — that's fine and expected until Task 3.)

- [ ] **Step 1.4: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/Makefile tests/test_harness_smoke.c
git commit -m "tests: add host-side C test harness scaffold"
```

---

## Task 2: Create `dendrometer.h` with constants, flags, struct, prototypes

**Goal:** Freeze the public interface (the design spec's Section 7) as a header file. No implementation yet.

**Files:**
- Create: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h`

- [ ] **Step 2.1: Write the header**

Create the file with this exact content:

```c
/*
 * dendrometer.h — ratiometric dendrometer measurement module for LSN50V2.
 *
 * Pure C99. No HAL dependencies. Host-testable.
 *
 * See docs/superpowers/specs/2026-04-18-lsn50v2-dendrometer-claude-design.md
 */
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
#define DENDRO_FLAG_VALID           0x01u
#define DENDRO_FLAG_REF_LOW         0x02u
#define DENDRO_FLAG_REF_HIGH        0x04u
#define DENDRO_FLAG_ADC_FAIL        0x08u
/* bits 4..7 reserved */

/* ---- Result type ---------------------------------------------------- */
typedef struct {
    uint16_t adc_signal_avg_raw;
    uint16_t adc_reference_avg_raw;
    uint8_t  flags;
} dendrometer_result_t;

/* ---- Board primitives (implemented in bsp.c for ARM; mock_board.c for tests) */
void     dendro_board_5v_on(void);
void     dendro_board_5v_off(void);
uint16_t dendro_board_adc_read_signal(void);
uint16_t dendro_board_adc_read_reference(void);
void     dendro_board_delay_ms(uint32_t ms);

/* ---- Public API (implemented in dendrometer.c) ---------------------- */
void     dendrometer_measure(dendrometer_result_t *out);

/*
 * Packs the MOD=3 dendrometer frame (8 bytes, big-endian) into dst.
 * Layout:
 *   [0-1] battery_mv
 *   [2-3] adc_signal_avg_raw
 *   [4-5] adc_reference_avg_raw
 *   [6]   status_byte  (caller-provided; see bsp.c)
 *   [7]   flags
 * Returns the number of bytes written (always 8).
 * dst MUST have at least 8 bytes of space.
 */
uint8_t  dendrometer_pack_payload(const dendrometer_result_t *m,
                                   uint16_t battery_mv,
                                   uint8_t  status_byte,
                                   uint8_t *dst);

#endif /* __DENDROMETER_H__ */
```

- [ ] **Step 2.2: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h"
git commit -m "feat: add dendrometer.h public interface"
```

---

## Task 3: Mock board + first failing test (average_of_constant)

**Goal:** Prove the TDD loop end-to-end with one test that will drive the skeleton of `dendrometer.c`.

**Files:**
- Create: `/home/phil/Repos/LoRa_STM32-claude/tests/mock_board.h`
- Create: `/home/phil/Repos/LoRa_STM32-claude/tests/mock_board.c`
- Create: `/home/phil/Repos/LoRa_STM32-claude/tests/test_dendrometer.c`
- Create: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`

- [ ] **Step 3.1: Write `mock_board.h`**

```c
#ifndef MOCK_BOARD_H
#define MOCK_BOARD_H

#include <stdint.h>
#include <stddef.h>

/* Scripted sample injection for board ADC primitives. */
void mock_board_reset(void);
void mock_board_set_signal_constant(uint16_t value);
void mock_board_set_reference_constant(uint16_t value);
void mock_board_set_signal_sequence(const uint16_t *seq, size_t len);
void mock_board_set_reference_sequence(const uint16_t *seq, size_t len);

/* Event log — captures every board call in order. */
typedef enum {
    MOCK_EVT_5V_ON,
    MOCK_EVT_5V_OFF,
    MOCK_EVT_ADC_SIG,
    MOCK_EVT_ADC_REF,
    MOCK_EVT_DELAY
} mock_event_kind_t;

typedef struct {
    mock_event_kind_t kind;
    uint32_t          value;   /* ADC value for ADC events, ms for delay */
} mock_event_t;

size_t              mock_board_event_count(void);
const mock_event_t *mock_board_events(void);

#endif
```

- [ ] **Step 3.2: Write `mock_board.c`**

```c
#include "mock_board.h"
#include "dendrometer.h"
#include <string.h>

#define MOCK_EVT_CAP 512
#define MOCK_SEQ_CAP 512

static mock_event_t g_events[MOCK_EVT_CAP];
static size_t       g_event_count = 0;

static uint16_t g_sig_seq[MOCK_SEQ_CAP];
static size_t   g_sig_len = 0;
static size_t   g_sig_idx = 0;
static uint16_t g_sig_const = 0;
static int      g_sig_is_const = 1;

static uint16_t g_ref_seq[MOCK_SEQ_CAP];
static size_t   g_ref_len = 0;
static size_t   g_ref_idx = 0;
static uint16_t g_ref_const = 0;
static int      g_ref_is_const = 1;

static void record(mock_event_kind_t k, uint32_t v) {
    if (g_event_count < MOCK_EVT_CAP) {
        g_events[g_event_count].kind  = k;
        g_events[g_event_count].value = v;
        g_event_count++;
    }
}

void mock_board_reset(void) {
    g_event_count = 0;
    g_sig_len = 0; g_sig_idx = 0; g_sig_const = 0; g_sig_is_const = 1;
    g_ref_len = 0; g_ref_idx = 0; g_ref_const = 0; g_ref_is_const = 1;
}

void mock_board_set_signal_constant(uint16_t v)     { g_sig_const = v; g_sig_is_const = 1; }
void mock_board_set_reference_constant(uint16_t v)  { g_ref_const = v; g_ref_is_const = 1; }

void mock_board_set_signal_sequence(const uint16_t *seq, size_t len) {
    size_t n = len > MOCK_SEQ_CAP ? MOCK_SEQ_CAP : len;
    memcpy(g_sig_seq, seq, n * sizeof(uint16_t));
    g_sig_len = n; g_sig_idx = 0; g_sig_is_const = 0;
}
void mock_board_set_reference_sequence(const uint16_t *seq, size_t len) {
    size_t n = len > MOCK_SEQ_CAP ? MOCK_SEQ_CAP : len;
    memcpy(g_ref_seq, seq, n * sizeof(uint16_t));
    g_ref_len = n; g_ref_idx = 0; g_ref_is_const = 0;
}

size_t              mock_board_event_count(void) { return g_event_count; }
const mock_event_t *mock_board_events(void)      { return g_events; }

/* ---- dendro_board_* implementations --------------------------------- */

void dendro_board_5v_on(void)  { record(MOCK_EVT_5V_ON,  0); }
void dendro_board_5v_off(void) { record(MOCK_EVT_5V_OFF, 0); }

uint16_t dendro_board_adc_read_signal(void) {
    uint16_t v;
    if (g_sig_is_const) v = g_sig_const;
    else { v = (g_sig_idx < g_sig_len) ? g_sig_seq[g_sig_idx++] : 0; }
    record(MOCK_EVT_ADC_SIG, v);
    return v;
}
uint16_t dendro_board_adc_read_reference(void) {
    uint16_t v;
    if (g_ref_is_const) v = g_ref_const;
    else { v = (g_ref_idx < g_ref_len) ? g_ref_seq[g_ref_idx++] : 0; }
    record(MOCK_EVT_ADC_REF, v);
    return v;
}
void dendro_board_delay_ms(uint32_t ms) { record(MOCK_EVT_DELAY, ms); }
```

- [ ] **Step 3.3: Write the first test in `test_dendrometer.c`**

```c
#include "dendrometer.h"
#include "mock_board.h"
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

#define ASSERT_TRUE(cond, label) do {                                           \
    if (!(cond)) {                                                              \
        fprintf(stderr, "FAIL %s: %s (%s:%d)\n", (label), #cond,                \
                __FILE__, __LINE__);                                            \
        exit(1);                                                                \
    }                                                                           \
} while (0)

static void test_average_of_constant(void) {
    mock_board_reset();
    mock_board_set_signal_constant(2048);
    mock_board_set_reference_constant(2048);

    dendrometer_result_t r;
    dendrometer_measure(&r);

    ASSERT_EQ_U32(r.adc_signal_avg_raw,    2048, "sig avg");
    ASSERT_EQ_U32(r.adc_reference_avg_raw, 2048, "ref avg");
    ASSERT_TRUE(r.flags & DENDRO_FLAG_VALID,            "VALID set");
    ASSERT_TRUE(!(r.flags & DENDRO_FLAG_REF_LOW),       "REF_LOW clear");
    ASSERT_TRUE(!(r.flags & DENDRO_FLAG_REF_HIGH),      "REF_HIGH clear");
    ASSERT_TRUE(!(r.flags & DENDRO_FLAG_ADC_FAIL),      "ADC_FAIL clear");

    puts("  PASS average_of_constant");
}

int main(void) {
    test_average_of_constant();
    puts("PASS dendrometer");
    return 0;
}
```

- [ ] **Step 3.4: Run the test and confirm it fails to link**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude/tests && make build/test_dendrometer 2>&1 | tail -10
```

Expected: compilation/link failure — `dendrometer.c` does not exist yet, so `dendrometer_measure` is undefined. This confirms the test harness actually exercises the module under test.

- [ ] **Step 3.5: Create the minimal `dendrometer.c` to pass the test**

Write `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c`:

```c
/*
 * dendrometer.c — ratiometric dendrometer measurement module for LSN50V2.
 * See dendrometer.h and the design spec in osi-os for rationale.
 */
#include "dendrometer.h"

void dendrometer_measure(dendrometer_result_t *out) {
    out->adc_signal_avg_raw    = 0;
    out->adc_reference_avg_raw = 0;
    out->flags                 = 0;

    dendro_board_5v_on();
    dendro_board_delay_ms(DENDRO_SETTLE_MS);

    uint32_t sum1 = 0, sum2 = 0;
    uint16_t zeros1 = 0, zeros2 = 0;
    for (uint16_t i = 0; i < DENDRO_SAMPLE_COUNT; ++i) {
        uint16_t s1 = dendro_board_adc_read_signal();
        uint16_t s2 = dendro_board_adc_read_reference();
        sum1 += s1; if (s1 == 0) ++zeros1;
        sum2 += s2; if (s2 == 0) ++zeros2;
        dendro_board_delay_ms(DENDRO_INTER_SAMPLE_MS);
    }

    out->adc_signal_avg_raw    = (uint16_t)(sum1 / DENDRO_SAMPLE_COUNT);
    out->adc_reference_avg_raw = (uint16_t)(sum2 / DENDRO_SAMPLE_COUNT);

    dendro_board_5v_off();

    if (zeros1 == DENDRO_SAMPLE_COUNT || zeros2 == DENDRO_SAMPLE_COUNT) {
        out->flags |= DENDRO_FLAG_ADC_FAIL;
    } else if (out->adc_reference_avg_raw < DENDRO_REF_MIN_RAW) {
        out->flags |= DENDRO_FLAG_REF_LOW;
    } else if (out->adc_reference_avg_raw > DENDRO_REF_MAX_RAW) {
        out->flags |= DENDRO_FLAG_REF_HIGH;
    } else {
        out->flags |= DENDRO_FLAG_VALID;
    }
}

uint8_t dendrometer_pack_payload(const dendrometer_result_t *m,
                                  uint16_t battery_mv,
                                  uint8_t  status_byte,
                                  uint8_t *dst) {
    dst[0] = (uint8_t)(battery_mv >> 8);
    dst[1] = (uint8_t)(battery_mv & 0xFF);
    dst[2] = (uint8_t)(m->adc_signal_avg_raw >> 8);
    dst[3] = (uint8_t)(m->adc_signal_avg_raw & 0xFF);
    dst[4] = (uint8_t)(m->adc_reference_avg_raw >> 8);
    dst[5] = (uint8_t)(m->adc_reference_avg_raw & 0xFF);
    dst[6] = status_byte;
    dst[7] = m->flags;
    return 8;
}
```

- [ ] **Step 3.6: Run the test and verify it passes**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude/tests && make test
```

Expected tail of output:
```
  PASS average_of_constant
PASS dendrometer
all host tests passed
```

- [ ] **Step 3.7: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/mock_board.h tests/mock_board.c tests/test_dendrometer.c
git add "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c"
git commit -m "feat: add dendrometer measurement core with first host test"
```

---

## Task 4: TDD — reference validation flags

**Goal:** Add tests that exercise each of the three error flag branches (`REF_LOW`, `REF_HIGH`, `ADC_FAIL`), verify the mutual-exclusion property, and verify averages are still reported on invalid measurements.

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/tests/test_dendrometer.c`

- [ ] **Step 4.1: Add four new test cases**

Append these functions above `main()`:

```c
static void test_reference_low(void) {
    mock_board_reset();
    mock_board_set_signal_constant(1024);
    mock_board_set_reference_constant(50);   /* < DENDRO_REF_MIN_RAW (128) */

    dendrometer_result_t r;
    dendrometer_measure(&r);

    ASSERT_EQ_U32(r.adc_signal_avg_raw,    1024, "sig avg (low ref)");
    ASSERT_EQ_U32(r.adc_reference_avg_raw, 50,   "ref avg (low ref)");
    ASSERT_TRUE(r.flags & DENDRO_FLAG_REF_LOW,    "REF_LOW set");
    ASSERT_TRUE(!(r.flags & DENDRO_FLAG_VALID),   "VALID clear");
    puts("  PASS reference_low");
}

static void test_reference_high(void) {
    mock_board_reset();
    mock_board_set_signal_constant(1024);
    mock_board_set_reference_constant(4095); /* > DENDRO_REF_MAX_RAW (4080) */

    dendrometer_result_t r;
    dendrometer_measure(&r);

    ASSERT_EQ_U32(r.adc_reference_avg_raw, 4095, "ref avg (high ref)");
    ASSERT_TRUE(r.flags & DENDRO_FLAG_REF_HIGH,   "REF_HIGH set");
    ASSERT_TRUE(!(r.flags & DENDRO_FLAG_VALID),   "VALID clear");
    puts("  PASS reference_high");
}

static void test_adc_fail_signal_zero(void) {
    mock_board_reset();
    mock_board_set_signal_constant(0);       /* channel dead */
    mock_board_set_reference_constant(2048);

    dendrometer_result_t r;
    dendrometer_measure(&r);

    ASSERT_TRUE(r.flags & DENDRO_FLAG_ADC_FAIL,   "ADC_FAIL set (sig dead)");
    ASSERT_TRUE(!(r.flags & DENDRO_FLAG_VALID),   "VALID clear");
    /* averages still reported */
    ASSERT_EQ_U32(r.adc_signal_avg_raw,    0,    "sig avg still 0");
    ASSERT_EQ_U32(r.adc_reference_avg_raw, 2048, "ref avg still 2048");
    puts("  PASS adc_fail_signal_zero");
}

static void test_adc_fail_reference_zero(void) {
    mock_board_reset();
    mock_board_set_signal_constant(1024);
    mock_board_set_reference_constant(0);    /* reference dead */

    dendrometer_result_t r;
    dendrometer_measure(&r);

    ASSERT_TRUE(r.flags & DENDRO_FLAG_ADC_FAIL,   "ADC_FAIL set (ref dead)");
    ASSERT_TRUE(!(r.flags & DENDRO_FLAG_VALID),   "VALID clear");
    puts("  PASS adc_fail_reference_zero");
}
```

- [ ] **Step 4.2: Register the new tests in `main()`**

Replace `main()` with:

```c
int main(void) {
    test_average_of_constant();
    test_reference_low();
    test_reference_high();
    test_adc_fail_signal_zero();
    test_adc_fail_reference_zero();
    puts("PASS dendrometer");
    return 0;
}
```

- [ ] **Step 4.3: Run and verify all tests pass**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude/tests && make test
```

Expected:
```
  PASS average_of_constant
  PASS reference_low
  PASS reference_high
  PASS adc_fail_signal_zero
  PASS adc_fail_reference_zero
PASS dendrometer
all host tests passed
```

(If any test fails, the implementation in `dendrometer.c` is wrong — fix it before proceeding. The expected truth is that all four error-flag tests should pass because `dendrometer.c` already has the full validation logic from Task 3.)

- [ ] **Step 4.4: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/test_dendrometer.c
git commit -m "test: cover REF_LOW / REF_HIGH / ADC_FAIL branches"
```

---

## Task 5: TDD — power sequencing invariants

**Goal:** Prove structurally that `dendro_board_5v_off` runs on every exit path, regardless of validation outcome.

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/tests/test_dendrometer.c`

- [ ] **Step 5.1: Add power-sequence tests**

Append:

```c
static int last_event_is(mock_event_kind_t kind) {
    size_t n = mock_board_event_count();
    if (n == 0) return 0;
    return mock_board_events()[n - 1].kind == kind;
}

static int first_event_is(mock_event_kind_t kind) {
    if (mock_board_event_count() == 0) return 0;
    return mock_board_events()[0].kind == kind;
}

static void test_power_sequence_happy_path(void) {
    mock_board_reset();
    mock_board_set_signal_constant(2048);
    mock_board_set_reference_constant(2048);

    dendrometer_result_t r;
    dendrometer_measure(&r);

    ASSERT_TRUE(first_event_is(MOCK_EVT_5V_ON), "first event is 5V_ON");
    ASSERT_TRUE(last_event_is(MOCK_EVT_5V_OFF), "last event is 5V_OFF");
    puts("  PASS power_sequence_happy_path");
}

static void test_power_sequence_ref_low(void) {
    mock_board_reset();
    mock_board_set_signal_constant(1024);
    mock_board_set_reference_constant(10);

    dendrometer_result_t r;
    dendrometer_measure(&r);

    ASSERT_TRUE(last_event_is(MOCK_EVT_5V_OFF), "5V_OFF still fires on REF_LOW");
    puts("  PASS power_sequence_ref_low");
}

static void test_power_sequence_adc_fail(void) {
    mock_board_reset();
    mock_board_set_signal_constant(0);
    mock_board_set_reference_constant(2048);

    dendrometer_result_t r;
    dendrometer_measure(&r);

    ASSERT_TRUE(last_event_is(MOCK_EVT_5V_OFF), "5V_OFF still fires on ADC_FAIL");
    puts("  PASS power_sequence_adc_fail");
}

static void test_settle_delay_happens(void) {
    mock_board_reset();
    mock_board_set_signal_constant(2048);
    mock_board_set_reference_constant(2048);

    dendrometer_result_t r;
    dendrometer_measure(&r);

    /* Second event must be the settle DELAY(50). */
    ASSERT_TRUE(mock_board_event_count() >= 2, "enough events recorded");
    const mock_event_t *evts = mock_board_events();
    ASSERT_TRUE(evts[1].kind == MOCK_EVT_DELAY,      "second event is DELAY");
    ASSERT_EQ_U32(evts[1].value, DENDRO_SETTLE_MS,   "settle delay value");
    puts("  PASS settle_delay_happens");
}
```

Register in `main()`:

```c
int main(void) {
    test_average_of_constant();
    test_reference_low();
    test_reference_high();
    test_adc_fail_signal_zero();
    test_adc_fail_reference_zero();
    test_power_sequence_happy_path();
    test_power_sequence_ref_low();
    test_power_sequence_adc_fail();
    test_settle_delay_happens();
    puts("PASS dendrometer");
    return 0;
}
```

- [ ] **Step 5.2: Run the tests**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude/tests && make test
```

Expected: all 9 tests pass. If `power_sequence_*` fails, `dendrometer.c` is placing `5V_off` inside a conditional branch — restructure so it's called unconditionally after averaging.

- [ ] **Step 5.3: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/test_dendrometer.c
git commit -m "test: verify 5V power-off fires on every exit path"
```

---

## Task 6: TDD — payload packer byte layout

**Goal:** Lock in the 8-byte MOD=3 wire format with hex-exact assertions.

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/tests/test_dendrometer.c`

- [ ] **Step 6.1: Add packer tests**

Append:

```c
static void test_pack_known_result(void) {
    dendrometer_result_t m = {
        .adc_signal_avg_raw    = 0x0A0B,
        .adc_reference_avg_raw = 0x0C0D,
        .flags                 = DENDRO_FLAG_VALID,
    };
    uint8_t dst[8] = {0};
    uint8_t n = dendrometer_pack_payload(&m, 0x0C80, 0x8A, dst);

    ASSERT_EQ_U32(n, 8, "pack size");
    ASSERT_EQ_U32(dst[0], 0x0C, "battery HI"); /* 3200 = 0x0C80 */
    ASSERT_EQ_U32(dst[1], 0x80, "battery LO");
    ASSERT_EQ_U32(dst[2], 0x0A, "sig HI");
    ASSERT_EQ_U32(dst[3], 0x0B, "sig LO");
    ASSERT_EQ_U32(dst[4], 0x0C, "ref HI");
    ASSERT_EQ_U32(dst[5], 0x0D, "ref LO");
    ASSERT_EQ_U32(dst[6], 0x8A, "status preserved");
    ASSERT_EQ_U32(dst[7], 0x01, "flags VALID");
    puts("  PASS pack_known_result");
}

static void test_pack_combined_flags(void) {
    dendrometer_result_t m = {
        .adc_signal_avg_raw    = 0,
        .adc_reference_avg_raw = 0,
        .flags = DENDRO_FLAG_REF_LOW | DENDRO_FLAG_ADC_FAIL,
    };
    uint8_t dst[8] = {0};
    (void)dendrometer_pack_payload(&m, 0, 0x08, dst);
    ASSERT_EQ_U32(dst[7], 0x0A, "REF_LOW|ADC_FAIL == 0x0A");
    puts("  PASS pack_combined_flags");
}

static void test_pack_battery_max(void) {
    dendrometer_result_t m = { 0, 0, DENDRO_FLAG_VALID };
    uint8_t dst[8] = {0};
    (void)dendrometer_pack_payload(&m, 0xFFFF, 0x08, dst);
    ASSERT_EQ_U32(dst[0], 0xFF, "battery HI max");
    ASSERT_EQ_U32(dst[1], 0xFF, "battery LO max");
    puts("  PASS pack_battery_max");
}
```

Register in `main()` (add three more lines before `puts("PASS dendrometer");`):

```c
    test_pack_known_result();
    test_pack_combined_flags();
    test_pack_battery_max();
```

- [ ] **Step 6.2: Run the tests**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude/tests && make test
```

Expected: 12 tests pass.

- [ ] **Step 6.3: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/test_dendrometer.c
git commit -m "test: lock MOD=3 payload byte layout"
```

---

## Task 7: Implement board primitives inside `bsp.c`

**Goal:** Wire the five `dendro_board_*` functions to real HAL calls, using the same idioms already in `bsp.c`.

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`

- [ ] **Step 7.1: Append board primitive implementations to `bsp.c`**

At the very bottom of `bsp.c` (after the last existing function, before the final `/************** EOF */` banner if present), add:

```c
/* ========================================================================
 *  Dendrometer board primitives (see inc/dendrometer.h)
 *
 *  Kept in bsp.c so all HAL-adjacent code lives in one translation unit.
 *  The dendrometer module itself never includes any HAL header.
 * ====================================================================== */

#include "dendrometer.h"

void dendro_board_5v_on(void) {
    /* PWR_OUT uses inverted logic: RESET enables the 5V boost. */
    HAL_GPIO_WritePin(PWR_OUT_PORT, PWR_OUT_PIN, GPIO_PIN_RESET);
}

void dendro_board_5v_off(void) {
    HAL_GPIO_WritePin(PWR_OUT_PORT, PWR_OUT_PIN, GPIO_PIN_SET);
}

uint16_t dendro_board_adc_read_signal(void) {
    /* PA0 — same channel constant the stock MOD=3 read used for the first
     * 6-sample sweep ("oil" channel in stock nomenclature). */
    return HW_AdcReadChannel(ADC_Channel_Oil);
}

uint16_t dendro_board_adc_read_reference(void) {
    /* PA1 — stock ADC_Channel_IN1. */
    return HW_AdcReadChannel(ADC_Channel_IN1);
}

void dendro_board_delay_ms(uint32_t ms) {
    HAL_Delay(ms);
}
```

- [ ] **Step 7.2: Verify the file still compiles syntactically**

Run a quick parse check (no ARM cross-compile yet — we'll do that in Task 10):

```
cd /home/phil/Repos/LoRa_STM32-claude && grep -n 'dendro_board_' "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c"
```

Expected: five definitions listed.

- [ ] **Step 7.3: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c"
git commit -m "feat: implement dendrometer board primitives in bsp.c"
```

---

## Task 8: Extend `sensor_t` with a dendrometer result field

**Goal:** Give the existing `sensor_data` struct a home for the new measurement so `main.c` can pack it without touching legacy fields.

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h`

- [ ] **Step 8.1: Edit `bsp.h`**

Replace the `sensor_t` closing brace region. The existing struct ends with:

```c
    int32_t Weight;

  /**more may be added*/
} sensor_t;
```

Change to:

```c
    int32_t Weight;

    /* MOD=3 ratiometric dendrometer result (see dendrometer.h). Only the
     * MOD=3 code path reads this; other modes leave it zero-initialized. */
    dendrometer_result_t dendro;

  /**more may be added*/
} sensor_t;
```

And at the top of `bsp.h`, after the existing `#include "hw.h"` line, add:

```c
#include "dendrometer.h"
```

- [ ] **Step 8.2: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h"
git commit -m "feat: add dendrometer_result_t field to sensor_t"
```

---

## Task 9: Rewire MOD=3 branch in `BSP_sensor_Read`

**Goal:** Replace the existing PA0/PA1/PA4 triple sweep (lines 302–338 of `bsp.c`) with a single `dendrometer_measure(&sensor_data->dendro)` call. Leave every other mode untouched.

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c`

- [ ] **Step 9.1: Read the current MOD=3 branch**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude && sed -n '295,345p' "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c"
```

Confirm you see `else if((mode==3)||(mode==8))` at the top of the block and `HAL_GPIO_WritePin(OIL_CONTROL_PORT,OIL_CONTROL_PIN,GPIO_PIN_SET);` followed by a `message==1` `PPRINTF` block at the bottom.

Note: MOD=8 shares this block in stock firmware. We must preserve MOD=8 behavior — **only** MOD=3 gets the new pipeline.

- [ ] **Step 9.2: Split the combined branch**

Replace the entire `else if((mode==3)||(mode==8))` block with two separate branches. The old block (for reference — do not keep it):

```c
	else if((mode==3)||(mode==8))
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

New replacement (paste exactly):

```c
	else if(mode==3)
	{
		 /* Ratiometric dendrometer: 50 paired PA0/PA1 samples, raw averages.
		  * See inc/dendrometer.h and the Claude-authored design spec. */
		 dendrometer_measure(&sensor_data->dendro);
		 if(message==1)
		 {
			 PPRINTF("DENDRO sig:%u ref:%u flags:0x%02X\r\n",
			         (unsigned)sensor_data->dendro.adc_signal_avg_raw,
			         (unsigned)sensor_data->dendro.adc_reference_avg_raw,
			         (unsigned)sensor_data->dendro.flags);
		 }
	}
	else if(mode==8)
	{
		 /* MOD=8 preserved from stock firmware unchanged. */
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

Also check the earlier `if((mode!=3)&&(mode!=8)&&(mode!=9))` gate (around line 243 per the exploration done earlier) — no change required there; MOD=3 continues to bypass the oil sweep.

- [ ] **Step 9.3: Also remove MOD=3 from the `mode==3||mode==8` init check earlier in `BSP_sensor_Init()`**

In `BSP_sensor_Init()` (search `488:\tif((mode==1)||(mode==3))` which controls the +3V3 sensor init branch), no change needed — the shared SHT/BH1750 branch is not invoked when `USE_SHT` is undefined, and our MOD=3 does not need the SHT sensors. Leave init logic alone.

(If a future variant needs to *disable* SHT init specifically on MOD=3, that's a follow-up; out of scope here.)

- [ ] **Step 9.4: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c"
git commit -m "feat: swap MOD=3 in BSP_sensor_Read to dendrometer_measure"
```

---

## Task 10: Rewire MOD=3 payload in `main.c`

**Goal:** Replace the MOD=3 payload packing branch (lines 641–675 of `main.c`) with a single `dendrometer_pack_payload()` call. Leave every other mode untouched.

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`

- [ ] **Step 10.1: Locate and read the current MOD=3 block**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude && sed -n '638,678p' "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c"
```

Confirm lines 641–675 match the stock MOD=3 packer (starts with `else if(mode==3)` and ends with `AppData.Buff[i++] =(int)(batteryLevel_mV/100);`).

- [ ] **Step 10.2: Replace the MOD=3 branch**

Replace the entire `else if(mode==3) { ... }` block with:

```c
	else if(mode==3)
	{
		/* Ratiometric dendrometer payload — 8 bytes, see dendrometer.h.
		 * Status byte preserves the legacy switch / in1 / mode-nibble layout
		 * so osi-dendro-helper's detectLsn50ModeCode() still returns 3. */
		if(exit_temp==0)
		{
			switch_status=HAL_GPIO_ReadPin(GPIO_EXTI14_PORT,GPIO_EXTI14_PIN);
		}
		uint8_t status_byte = (switch_status<<7)
		                    | (sensor_data.in1<<1)
		                    | 0x08
		                    | (exit_temp & 0x01);
		i += dendrometer_pack_payload(&sensor_data.dendro,
		                              batteryLevel_mV,
		                              status_byte,
		                              &AppData.Buff[i]);
	}
```

- [ ] **Step 10.3: Confirm no `USE_SHT` block leaked into MOD=3**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude && awk '/else if\(mode==3\)/,/else if\(mode==4\)/' "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c" | grep -E 'USE_SHT|bh1750|temp_sht|hum_sht|illuminance' || echo "clean"
```

Expected: `clean`.

- [ ] **Step 10.4: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c"
git commit -m "feat: swap MOD=3 payload packer to 8-byte dendrometer frame"
```

---

## Task 11: Verify nothing else in firmware changed

**Goal:** Sanity-check the diff scope before moving to ARM smoke-compile.

- [ ] **Step 11.1: Confirm only five files changed**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude && git diff --name-only master..feature/ratiometric-dendrometer-claude | sort
```

Expected exactly:
```
STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/bsp.h
STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/dendrometer.h
STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/bsp.c
STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c
STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c
tests/Makefile
tests/mock_board.c
tests/mock_board.h
tests/test_dendrometer.c
tests/test_harness_smoke.c
```

If any other file appears, stop and investigate.

- [ ] **Step 11.2: Verify `dendrometer.c` has no HAL includes**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude && grep -E 'stm32|HAL_|hw\.h' "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c" || echo "clean"
```

Expected: `clean`. If any match, the module has leaked HAL dependencies and tests won't compile on the host.

- [ ] **Step 11.3: Re-run host tests one more time**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude/tests && make clean && make test
```

Expected: all 12 tests pass.

---

## Task 12: ARM smoke-compile of `dendrometer.c`

**Goal:** Prove `dendrometer.c` is valid ARM code against real HAL headers (we can't produce a full firmware without Keil/IAR, but compile-only is cheap and catches 95% of issues).

**Requires:** `arm-none-eabi-gcc` installed (user needs to `sudo pacman -S arm-none-eabi-gcc arm-none-eabi-newlib arm-none-eabi-binutils` first).

- [ ] **Step 12.1: Locate HAL header directory**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude && find STM32CubeExpansion_LRWAN/Drivers/STM32L0xx_HAL_Driver/Inc -maxdepth 1 -type f -name 'stm32l0xx_hal.h' | head
```

Expected: one path printed. Capture it — let `HAL_INC=$(dirname that path)`.

- [ ] **Step 12.2: Locate CMSIS device header directory**

Run:
```
cd /home/phil/Repos/LoRa_STM32-claude && find STM32CubeExpansion_LRWAN/Drivers/CMSIS/Device/ST/STM32L0xx/Include -maxdepth 1 -type f -name 'stm32l0xx.h' | head
```

Expected: one path. Let `CMSIS_INC=$(dirname that path)`.

- [ ] **Step 12.3: Run the smoke compile**

```
cd /home/phil/Repos/LoRa_STM32-claude
HAL_INC=STM32CubeExpansion_LRWAN/Drivers/STM32L0xx_HAL_Driver/Inc
CMSIS_DEV=STM32CubeExpansion_LRWAN/Drivers/CMSIS/Device/ST/STM32L0xx/Include
CMSIS_CORE=STM32CubeExpansion_LRWAN/Drivers/CMSIS/Include
APP_INC="STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc"
arm-none-eabi-gcc -c -std=c99 -Wall -Wextra -Werror \
  -mcpu=cortex-m0plus -mthumb \
  -DSTM32L072xx -DUSE_HAL_DRIVER \
  -I "$APP_INC" -I "$HAL_INC" -I "$CMSIS_DEV" -I "$CMSIS_CORE" \
  -o /tmp/dendrometer.o \
  "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c"
```

Expected: exit code 0, no output, `/tmp/dendrometer.o` exists.

If the compile fails because `dendrometer.c` doesn't need any of the HAL macros (it uses only stdint — recall it has no HAL includes), simplify:

```
arm-none-eabi-gcc -c -std=c99 -Wall -Wextra -Werror \
  -mcpu=cortex-m0plus -mthumb \
  -I "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc" \
  -o /tmp/dendrometer.o \
  "STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/dendrometer.c"
```

Expected: exit 0.

- [ ] **Step 12.4: Verify object produces Cortex-M0+ Thumb output**

Run:
```
arm-none-eabi-objdump -h /tmp/dendrometer.o | head -20
```

Expected: contains sections `.text` `.rodata`, architecture `arm` (in a preamble line: `file format elf32-littlearm`).

- [ ] **Step 12.5: No commit needed** (this is a verification step). If the smoke compile fails, fix the source before proceeding.

---

## Task 13: Switch to osi-os worktree for decoder work

**Goal:** Leave the firmware repo clean; everything from here on lives in the osi-os worktree.

- [ ] **Step 13.1: Change to the osi-os worktree**

```
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
git status --short --branch
```

Expected: `## feature/lsn50-dendrometer-decoder-claude`, and only the committed design spec (no pending changes).

- [ ] **Step 13.2: Verify Node version supports the built-in test runner**

```
node --version
```

Expected: `v20.x` or newer. If lower, stop — the plan's test runner depends on Node 20+.

---

## Task 14: TDD — decoder for the new MOD=3 frame

**Goal:** Drive the new `decodeMod3DendroPayload` function from a failing test.

**Files:**
- Create: `/home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/package.json`
- Create: `/home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js`
- Modify: `/home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`

- [ ] **Step 14.1: Check if `package.json` already exists in the helper dir**

```
ls /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/
```

If no `package.json`, create it:

```json
{
  "name": "osi-dendro-helper",
  "version": "1.0.0",
  "description": "Dendrometer decoder/analytics helpers for Node-RED flows",
  "main": "index.js",
  "scripts": {
    "test": "node --test test/"
  },
  "license": "UNLICENSED"
}
```

- [ ] **Step 14.2: Write the failing decoder test**

Create `test/decoder.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeMod3DendroPayload,
} = require('..');

function hex(bytes) {
  return Buffer.from(bytes).toString('base64');
}

// Fixture: valid MOD=3 dendrometer frame
//   battery = 3200 mV = 0x0C80
//   signal  = 2048    = 0x0800
//   ref     = 2048    = 0x0800
//   status  = 0x08 (mode nibble = 3, nothing else set)
//   flags   = 0x01 (VALID)
const FRAME_VALID = [0x0C, 0x80, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01];

test('decodeMod3DendroPayload: valid frame populates all fields', () => {
  const out = decodeMod3DendroPayload(hex(FRAME_VALID));
  assert.equal(out.batV, 3.2);
  assert.equal(out.adcSignalAvgRaw, 2048);
  assert.equal(out.adcReferenceAvgRaw, 2048);
  assert.equal(out.statusByte, 0x08);
  assert.equal(out.modeCode, 3);
  assert.equal(out.modeLabel, 'MOD3');
  assert.equal(out.dendroFlags, 0x01);
  assert.equal(out.measurementValid, true);
  assert.equal(out.refTooLow, false);
  assert.equal(out.refTooHigh, false);
  assert.equal(out.adcFail, false);
  assert.equal(out.dendroRatio, 1);
  // Back-compat aliases: raw * 5.0 / 4095
  assert.ok(Math.abs(out.adcCh0V - (2048 * 5 / 4095)) < 1e-6);
  assert.ok(Math.abs(out.adcCh1V - (2048 * 5 / 4095)) < 1e-6);
  assert.equal(out.adcCh4V, null);
});

test('decodeMod3DendroPayload: REF_LOW sets flags and nulls ratio', () => {
  const frame = [0x0C, 0x80, 0x04, 0x00, 0x00, 0x32, 0x08, 0x02];
  const out = decodeMod3DendroPayload(hex(frame));
  assert.equal(out.measurementValid, false);
  assert.equal(out.refTooLow, true);
  assert.equal(out.refTooHigh, false);
  assert.equal(out.dendroRatio, null);
});

test('decodeMod3DendroPayload: REF_HIGH sets flags and nulls ratio', () => {
  const frame = [0x0C, 0x80, 0x04, 0x00, 0x0F, 0xFF, 0x08, 0x04];
  const out = decodeMod3DendroPayload(hex(frame));
  assert.equal(out.refTooHigh, true);
  assert.equal(out.dendroRatio, null);
});

test('decodeMod3DendroPayload: ADC_FAIL flag', () => {
  const frame = [0x0C, 0x80, 0x00, 0x00, 0x08, 0x00, 0x08, 0x08];
  const out = decodeMod3DendroPayload(hex(frame));
  assert.equal(out.adcFail, true);
  assert.equal(out.measurementValid, false);
  assert.equal(out.dendroRatio, null);
});

test('decodeMod3DendroPayload: wrong-length buffer returns null', () => {
  const frame = [0x0C, 0x80, 0x08, 0x00];
  assert.equal(decodeMod3DendroPayload(hex(frame)), null);
});
```

- [ ] **Step 14.3: Run the test and verify it fails**

```
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper && npm test 2>&1 | tail -20
```

Expected: tests fail with `TypeError: decodeMod3DendroPayload is not a function` — the symbol isn't exported yet.

- [ ] **Step 14.4: Implement `decodeMod3DendroPayload` in `index.js`**

Open `index.js` and make three additions.

**(a)** Add flag constants near the top, right after the `SMALL_REFERENCE_THRESHOLD` line:

```js
const DENDRO_FLAG_VALID    = 0x01;
const DENDRO_FLAG_REF_LOW  = 0x02;
const DENDRO_FLAG_REF_HIGH = 0x04;
const DENDRO_FLAG_ADC_FAIL = 0x08;

const MOD3_DENDRO_FRAME_LENGTH = 8;
```

**(b)** Add the decoder function, above `decodeRawAdcPayload`:

```js
function decodeMod3DendroPayload(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length !== MOD3_DENDRO_FRAME_LENGTH) return null;

    const batV                = ((buf[0] << 8) | buf[1]) / 1000;
    const adcSignalAvgRaw     = (buf[2] << 8) | buf[3];
    const adcReferenceAvgRaw  = (buf[4] << 8) | buf[5];
    const statusByte          = buf[6];
    const dendroFlags         = buf[7];

    const refTooLow        = (dendroFlags & DENDRO_FLAG_REF_LOW)  !== 0;
    const refTooHigh       = (dendroFlags & DENDRO_FLAG_REF_HIGH) !== 0;
    const adcFail          = (dendroFlags & DENDRO_FLAG_ADC_FAIL) !== 0;
    const measurementValid = (dendroFlags & DENDRO_FLAG_VALID)    !== 0;

    const dendroRatio = measurementValid && adcReferenceAvgRaw > 0
      ? roundTo(adcSignalAvgRaw / adcReferenceAvgRaw, 6)
      : null;

    // Back-compat aliases: raw ADC counts rescaled to volts using the
    // nominal 5V rail midpoint assumption.
    const toVolts = (raw) => raw === null ? null : (raw * 5) / 4095;

    return {
      batV,
      adcSignalAvgRaw,
      adcReferenceAvgRaw,
      statusByte,
      modeCode: 3,
      modeLabel: 'MOD3',
      switchStatus: (statusByte >> 7) & 0x01,
      dendroFlags,
      measurementValid,
      refTooLow,
      refTooHigh,
      adcFail,
      dendroRatio,
      adcCh0V: toVolts(adcSignalAvgRaw),
      adcCh1V: toVolts(adcReferenceAvgRaw),
      adcCh4V: null,
    };
  } catch (_) {
    return null;
  }
}
```

**(c)** Export it. Find the `module.exports = { ... }` block at the end and add `decodeMod3DendroPayload,` to the list.

- [ ] **Step 14.5: Run and verify tests pass**

```
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper && npm test 2>&1 | tail -20
```

Expected: 5 tests pass.

- [ ] **Step 14.6: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/package.json
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js
git commit -m "feat: add decodeMod3DendroPayload and node test harness"
```

---

## Task 15: Wire new decoder into `decodeRawAdcPayload` dispatcher

**Goal:** Keep the public surface (`decodeRawAdcPayload`) the single entry point, and route 8-byte MOD=3 frames to the new decoder so the rest of the flow doesn't need changes.

**Files:**
- Modify: `/home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js`
- Modify: `/home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js`

- [ ] **Step 15.1: Add a dispatcher test**

Append to `test/decoder.test.js`:

```js
test('decodeRawAdcPayload: 8-byte MOD=3 frame goes through new decoder', () => {
  const frame = [0x0C, 0x80, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01];
  const { decodeRawAdcPayload } = require('..');
  const out = decodeRawAdcPayload(hex(frame));
  assert.equal(out.modeCode, 3);
  assert.equal(out.adcSignalAvgRaw, 2048);
  assert.equal(out.measurementValid, true);
  // Back-compat alias still present so downstream flow code works.
  assert.ok(typeof out.adcCh0V === 'number');
});

test('decodeRawAdcPayload: legacy MOD=1 frame still works', () => {
  // 11 bytes, MOD=1: battery=3200, temp=200, oil=1500, status=0x04, SHT block
  const frame = [0x0C, 0x80, 0x00, 0xC8, 0x05, 0xDC, 0x04, 0x00, 0x3C, 0x00, 0x28];
  const { decodeRawAdcPayload } = require('..');
  const out = decodeRawAdcPayload(hex(frame));
  assert.equal(out.batV, 3.2);
  assert.equal(out.modeCode, 1);
});
```

- [ ] **Step 15.2: Run the tests; confirm the new one fails, the legacy one passes**

```
cd .../osi-dendro-helper && npm test 2>&1 | tail -20
```

Expected: the legacy dispatcher test passes (existing code already handles MOD=1), but the MOD=3 dispatcher test fails because `decodeRawAdcPayload` still runs the legacy path on the 8-byte frame and returns fields like `adcCh0V` based on wrong bytes — causing the `out.adcSignalAvgRaw` assertion to fail.

- [ ] **Step 15.3: Update `decodeRawAdcPayload` to dispatch**

In `index.js`, find `function decodeRawAdcPayload(b64) {` and replace its body with:

```js
function decodeRawAdcPayload(b64) {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (buf.length < 7) return null;

    // New MOD=3 dendrometer frame is always exactly 8 bytes with the
    // MOD nibble (bits 2..6 of byte 6) encoding "3" (raw==2).
    if (buf.length === MOD3_DENDRO_FRAME_LENGTH) {
      const rawMode = (buf[6] >> 2) & 0x1f;
      if (rawMode + 1 === 3) {
        return decodeMod3DendroPayload(b64);
      }
    }

    // Legacy path unchanged — used by MOD=1, 2, 4, 5, 6, 7, 8, 9 etc.
    const batV = ((buf[0] << 8) | buf[1]) / 1000;
    const modeCode = detectLsn50ModeCode(b64);
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

- [ ] **Step 15.4: Run the tests and confirm all pass**

```
cd .../osi-dendro-helper && npm test 2>&1 | tail -30
```

Expected: 7 tests pass.

- [ ] **Step 15.5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/index.js
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js
git commit -m "feat: dispatch 8-byte MOD=3 frames to dendrometer decoder"
```

---

## Task 16: Update `detectDendroModeUsed` + `buildDendroDerivedMetrics` for raw-count frames

**Goal:** The existing `buildDendroDerivedMetrics` picks `ratio_mod3` based on `effectiveMode === 3 && adcCh0V !== null && adcCh1V > threshold`. That still works because the new decoder populates `adcCh0V` / `adcCh1V` via the back-compat alias. Add a test that confirms the pipeline end-to-end.

**Files:**
- Modify: `.../osi-dendro-helper/test/decoder.test.js`

- [ ] **Step 16.1: Add an end-to-end pipeline test**

Append to `test/decoder.test.js`:

```js
test('buildDendroDerivedMetrics: ratio_mod3 path with new frame', () => {
  const {
    decodeRawAdcPayload,
    buildDendroDerivedMetrics,
  } = require('..');

  const frame = [0x0C, 0x80, 0x08, 0x00, 0x0C, 0x00, 0x08, 0x01];
  const decoded = decodeRawAdcPayload(hex(frame));

  const metrics = buildDendroDerivedMetrics({
    adcCh0V: decoded.adcCh0V,
    adcCh1V: decoded.adcCh1V,
    effectiveMode: decoded.modeCode,
    strokeMm: 50,
    ratioZero: 0.2,
    ratioSpan: 0.9,
    invertDirection: 0,
  });

  assert.equal(metrics.dendroModeUsed, 'ratio_mod3');
  assert.equal(typeof metrics.dendroRatio, 'number');
  assert.ok(metrics.dendroRatio > 0.66 && metrics.dendroRatio < 0.67);
  assert.equal(metrics.dendroValid, 1);
});

test('buildDendroDerivedMetrics: invalid MOD=3 frame falls to dendroValid=0', () => {
  const {
    decodeRawAdcPayload,
    buildDendroDerivedMetrics,
  } = require('..');

  const frame = [0x0C, 0x80, 0x08, 0x00, 0x00, 0x32, 0x08, 0x02];
  const decoded = decodeRawAdcPayload(hex(frame));

  const metrics = buildDendroDerivedMetrics({
    adcCh0V: decoded.adcCh0V,
    adcCh1V: decoded.adcCh1V,
    effectiveMode: decoded.modeCode,
    strokeMm: 50,
    ratioZero: 0.2,
    ratioSpan: 0.9,
    invertDirection: 0,
  });

  assert.equal(metrics.dendroValid, 0);
});
```

- [ ] **Step 16.2: Run the tests**

```
cd .../osi-dendro-helper && npm test 2>&1 | tail -30
```

Expected: 9 tests pass. (If the second test fails because `detectDendroModeUsed` picked `ratio_mod3` even for a REF_LOW frame and then tried to divide by a tiny `adcCh1V`, this is working as designed — the `calculateDendroRatio` helper has its own `SMALL_REFERENCE_THRESHOLD` check and will set `isValid: false`, which flows through to `dendroValid: 0`. Confirm by inspecting the output.)

- [ ] **Step 16.3: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/test/decoder.test.js
git commit -m "test: end-to-end pipeline check with new MOD=3 frame"
```

---

## Task 17: Sync flow verifier still passes

**Goal:** Make sure the decoder change didn't break any Node-RED flow sync invariants.

- [ ] **Step 17.1: Run the verifier**

```
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude && node scripts/verify-sync-flow.js 2>&1 | tail -20
```

Expected: same output as the main branch would produce (no new warnings). If the verifier reports any new issue related to `osi-dendro-helper`, it's in scope to fix before continuing.

- [ ] **Step 17.2: No commit needed** (verification-only step).

---

## Task 18: Cross-repo rollout README

**Goal:** Leave a one-page operational note so future-you knows the deploy order.

**Files:**
- Create: `/home/phil/Repos/LoRa_STM32-claude/README-dendrometer-claude.md`

- [ ] **Step 18.1: Write the rollout README**

```markdown
# LSN50V2 Ratiometric Dendrometer — Rollout Notes (Claude fork)

This fork extends stock `MOD=3` with oversampled ratiometric dendrometer
measurement. The payload format changed; the gateway decoder in `osi-os`
must be updated before field units are flashed.

## Payload (`MOD=3`, 8 bytes, big-endian)

| Byte | Field                  |
|------|------------------------|
| 0-1  | battery_mv             |
| 2-3  | adc_signal_avg_raw     |
| 4-5  | adc_reference_avg_raw  |
| 6    | status_byte            |
| 7    | dendro_flags           |

Flags: `VALID=0x01`, `REF_LOW=0x02`, `REF_HIGH=0x04`, `ADC_FAIL=0x08`.

## Tunables (compile-time, `dendrometer.h`)

- `DENDRO_SAMPLE_COUNT` — default 50
- `DENDRO_SETTLE_MS` — default 50
- `DENDRO_INTER_SAMPLE_MS` — default 1
- `DENDRO_REF_MIN_RAW` — default 128
- `DENDRO_REF_MAX_RAW` — default 4080

Override at build time with `-D` if experimentation is needed.

## Deploy order

1. Update gateway first: ship the matched `osi-dendro-helper` change
   (`feature/lsn50-dendrometer-decoder-claude` branch in the osi-os repo).
2. Restart Node-RED on the gateway.
3. Flash new firmware to one LSN50V2 dendrometer unit.
4. Join EU868, confirm uplinks, confirm the gateway populates
   `device_data.dendro_position_mm` correctly for the calibrated zone.
5. Only then roll the firmware forward to other field units.

## Rollback

- Reflash the dragino stock `EU868.hex` from
  `kDrive/OSI OS/Hardware/Dragino LSN50/V2/LSN50 & LSN50-v2/Firmware/v1.8.2/EU868.hex`.
- The legacy decoder path in `osi-dendro-helper` is unchanged, so stock frames
  still decode correctly.

## Tests

- Host unit tests: `make -C tests test` (native gcc, requires no ARM toolchain)
- ARM smoke compile: see `docs/superpowers/plans/2026-04-18-lsn50v2-dendrometer-claude.md`, Task 12
- Full firmware image: requires Keil (MDK-ARM) or IAR (EWARM) on a separate host
```

- [ ] **Step 18.2: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add README-dendrometer-claude.md
git commit -m "docs: rollout notes for Claude dendrometer fork"
```

---

## Task 19: Commit the plan file in the osi-os worktree

**Goal:** Make the plan itself part of the repo so review is reproducible.

- [ ] **Step 19.1: Stage and commit this plan**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
git add docs/superpowers/plans/2026-04-18-lsn50v2-dendrometer-claude.md
git commit -m "docs: add Claude implementation plan for LSN50V2 dendrometer"
```

---

## Task 20: Push both branches

**Goal:** Make both feature branches visible for comparison.

- [ ] **Step 20.1: Push firmware branch**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git push --set-upstream origin feature/ratiometric-dendrometer-claude
```

Expected: branch created on `Project-OSI/LoRa_STM32` remote.

- [ ] **Step 20.2: Push osi-os decoder branch**

```bash
cd /home/phil/Repos/osi-os/.worktrees/lsn50-dendrometer-decoder-claude
git push --set-upstream origin feature/lsn50-dendrometer-decoder-claude
```

Expected: branch created on the `osi-os` remote.

---

## Verification summary

After Task 20, the deliverables are:

- `Project-OSI/LoRa_STM32` — branch `feature/ratiometric-dendrometer-claude`
  - 5 firmware source edits, 5 new test files, 1 rollout README
  - 12 host tests passing
  - `dendrometer.c` cleanly compiles as ARM Cortex-M0+ object
- `osi-os` — branch `feature/lsn50-dendrometer-decoder-claude`
  - Decoder + test suite for new MOD=3 frame
  - 9 decoder tests passing
  - Sync flow verifier still clean
  - Design spec + implementation plan committed

**Out of scope (deliberately):**
- Full Keil/IAR firmware build — requires commercial IDE on a separate host
- Field flash + end-to-end RF test — operational task for the user
- Merge to main branches — user performs after comparison with Codex branch

---

## Spec coverage self-check

| Spec section | Tasks that implement it |
|---|---|
| §6 Module architecture | Tasks 2, 3, 7, 8, 9, 10 |
| §7 Public interface | Task 2 |
| §8 Measurement sequence | Tasks 3, 4, 5 |
| §9 Payload format | Tasks 6, 10 |
| §10 Decoder changes | Tasks 14, 15, 16 |
| §11 Test matrix | Tasks 3, 4, 5, 6, 14, 15, 16 |
| §12 File changes | Tasks 2, 3, 7, 8, 9, 10, 14, 15, 18, 19 |
| §13 Verification checklist | Tasks 11, 12, 17, 20 |
| §14 Risks | Rollout order in Task 18 README |
| §15 Future work | Explicitly out of scope (documented in Task 18 README) |

All spec sections covered.
