# Chameleon Firmware V1.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Chameleon I²C `CAL2/CAL3 == RAW2/RAW3` pass-through on kaba100 by adding a blind settle, per-channel retry, and a new `COMP_PENDING` status-flag bit to the V1 firmware. No wire-format change. Comp values become valid on ≥ 99 % of uplinks instead of ~7.6 %.

**Architecture:** Two repos touched. Firmware work in `/home/phil/Repos/LoRa_STM32-claude` on a new branch `feature/chameleon-v1.5` rooted at commit `884fda3` (the last V1 commit before V2 work). One small osi-os follow-up adds a `comp_pending INTEGER` column to `chameleon_readings` and surfaces bit 7 of `status_flags` through the Node-RED decoder. No ChirpStack codec change is needed — the codec already exposes `Chameleon_Status_Flags` as a raw byte, and we extract bit 7 in Node-RED.

**Tech Stack:** C99 (firmware, STM32L072CZ Cortex-M0+, GCC arm-none-eabi), `make` host tests on native gcc, Node-RED `function` nodes in `flows.json`, SQLite for migration.

**Spec:** [`docs/specs/2026-05-15-chameleon-firmware-v1.5-design.md`](../../specs/2026-05-15-chameleon-firmware-v1.5-design.md)

---

## File map

**Firmware repo** (`/home/phil/Repos/LoRa_STM32-claude`):

| File | Action |
|------|--------|
| `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/via_chameleon.h` | Modify — add 3 timing constants |
| `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h` | Modify — add `CHAMELEON_FLAG_COMP_PENDING` |
| `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c` | Modify — blind settle + per-channel retry + pending-bit set |
| `tests/mock_chameleon_i2c.h` | Modify — new setter prototypes for separate comp/raw + CAL sequence |
| `tests/mock_chameleon_i2c.c` | Modify — implement separated state and CAL sequence |
| `tests/test_chameleon_settle_and_retry.c` | Create — TDD test for blind-settle + retry happy path |
| `tests/test_chameleon_comp_pending.c` | Create — TDD test for COMP_PENDING bit |
| `tests/test_chameleon_open_channel_no_retry.c` | Create — TDD test that open channels do not trigger retry |
| `tests/Makefile` | Modify — register the three new tests in `TESTS` and add link recipes |
| `build/LSN50-chameleon.{bin,elf,hex,map}` | Regenerate via `build/build.sh chameleon` |
| `build/LSN50-chameleon-dummy.{bin,elf,hex,map}` | Regenerate via `build/build.sh chameleon-dummy` |

**osi-os repo** (`/home/phil/Repos/osi-os`):

| File | Action |
|------|--------|
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Modify — one `ALTER TABLE` in the migration block; add `compPending` to the decoder field map; add `comp_pending` to the `INSERT INTO chameleon_readings` column list and parameter array |
| `scripts/verify-chameleon-v1.5.sh` | Create — one-shot SQL verification script for post-flash check |

---

## Task 1: Branch the firmware from the V1 baseline

**Files:**
- Create: `feature/chameleon-v1.5` branch in `/home/phil/Repos/LoRa_STM32-claude`

- [ ] **Step 1: Verify firmware repo is clean before branching**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude
git status --short
git rev-parse HEAD
```
Expected: empty `git status` output and HEAD on whatever branch is currently checked out (most likely `feature/chameleon-i2c-reader` at commit `7153161`). If there are local modifications, stash or commit them before branching.

- [ ] **Step 2: Create the V1.5 branch from the V1 baseline commit**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude
git checkout -b feature/chameleon-v1.5 884fda3
git log -1 --oneline
```
Expected output: `884fda3 build(chameleon): add firmware artifacts`. Working tree clean.

- [ ] **Step 3: Confirm V2 work is absent from this branch**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude
grep -c "CHAMELEON_PAYLOAD_VERSION_V2" 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h' || true
```
Expected: `0`. (V2 macros do not exist on the V1.5 baseline.)

---

## Task 2: Add the new firmware constants and status-flag bit

**Files:**
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/via_chameleon.h` (constants block, just after `CHAMELEON_POLL_INTERVAL_MS`)
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h` (after the existing `CHAMELEON_FLAG_CH3_OPEN` definition)

- [ ] **Step 1: Add the three timing constants in `via_chameleon.h`**

Open `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/via_chameleon.h`. Find the line:

```c
#define CHAMELEON_POLL_INTERVAL_MS    50U
```

Add immediately below it:

```c
#define CHAMELEON_POST_READY_SETTLE_MS  250U   /* blind settle after STATUS_READY before reading CAL/RAW */
#define CHAMELEON_CAL_RETRY_DELAY_MS    150U   /* delay between first read and the single retry */
#define CHAMELEON_CAL_RETRY_COUNT       1U     /* retries per channel when CAL[i] == RAW[i] */
```

- [ ] **Step 2: Add the new status-flag bit in `chameleon_payload.h`**

Open `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h`. Find the line:

```c
#define CHAMELEON_FLAG_CH3_OPEN        (1U << 6)
```

Add immediately below it:

```c
#define CHAMELEON_FLAG_COMP_PENDING    (1U << 7)  /* CAL[i] == RAW[i] for at least one non-open channel after retry */
```

- [ ] **Step 3: Compile-test the headers via the existing host test suite**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean test
```
Expected: all 8 existing host tests pass (`all host tests passed`). Headers compile cleanly; no behaviour change yet.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add 'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/via_chameleon.h' \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/inc/chameleon_payload.h'
git commit -m "feat(chameleon): declare v1.5 settle/retry constants and COMP_PENDING bit"
```

---

## Task 3: Extend the I²C mock with separate comp/raw setters and a CAL sequence helper

The existing `mock_chameleon_set_resistance(ch, v)` writes the same value to both comp and raw. With V1.5 retry logic, that would trigger spurious retries in existing tests. We add finer-grained setters and keep the old function intact so existing tests don't need to change.

**Files:**
- Modify: `tests/mock_chameleon_i2c.h`
- Modify: `tests/mock_chameleon_i2c.c`

- [ ] **Step 1: Add the three new setter prototypes**

In `tests/mock_chameleon_i2c.h`, after the existing `mock_chameleon_set_resistance` prototype, add:

```c
/* Set CAL[ch] only (returns this value on every CAL[ch] read). */
void mock_chameleon_set_resistance_comp(uint8_t channel, uint32_t ohms);

/* Set RAW[ch] only (returns this value on every RAW[ch] read). */
void mock_chameleon_set_resistance_raw(uint8_t channel, uint32_t ohms);

/* On the first CAL[ch] read after reset, return `first`. On every subsequent
 * CAL[ch] read, return `subsequent`. Use to simulate a peripheral whose
 * compensated register becomes valid only on a retry. RAW[ch] is unaffected
 * and continues to return whatever mock_chameleon_set_resistance_raw set
 * (or its default). */
void mock_chameleon_set_resistance_comp_sequence(uint8_t channel,
                                                 uint32_t first,
                                                 uint32_t subsequent);
```

- [ ] **Step 2: Implement the new setters and per-channel sequence state in `tests/mock_chameleon_i2c.c`**

Add three new file-static variables next to the existing `g_res_comp` / `g_res_raw`:

```c
static uint32_t g_res_comp_first[3]    = {1100U, 10100U, 101200U};
static uint8_t  g_res_comp_use_first[3] = {0U, 0U, 0U};   /* 1 = sequence mode active */
static uint8_t  g_res_comp_reads[3]    = {0U, 0U, 0U};   /* per-channel CAL reads seen */
```

Update `mock_chameleon_reset` to also reset these:

```c
g_res_comp_first[0] = 1100U; g_res_comp_first[1] = 10100U; g_res_comp_first[2] = 101200U;
g_res_comp_use_first[0] = g_res_comp_use_first[1] = g_res_comp_use_first[2] = 0U;
g_res_comp_reads[0] = g_res_comp_reads[1] = g_res_comp_reads[2] = 0U;
```

Implement the three new setters:

```c
void mock_chameleon_set_resistance_comp(uint8_t ch, uint32_t v) {
    if (ch < 3) {
        g_res_comp[ch] = v;
        g_res_comp_use_first[ch] = 0U;
    }
}

void mock_chameleon_set_resistance_raw(uint8_t ch, uint32_t v) {
    if (ch < 3) g_res_raw[ch] = v;
}

void mock_chameleon_set_resistance_comp_sequence(uint8_t ch,
                                                 uint32_t first,
                                                 uint32_t subsequent) {
    if (ch < 3) {
        g_res_comp_first[ch]     = first;
        g_res_comp[ch]           = subsequent;
        g_res_comp_use_first[ch] = 1U;
        g_res_comp_reads[ch]     = 0U;
    }
}
```

In `chameleon_board_i2c_write_read`, modify the `CHAMELEON_CMD_RES_CAL1 / CAL2 / CAL3` case to consult the sequence state:

```c
case CHAMELEON_CMD_RES_CAL1:
case CHAMELEON_CMD_RES_CAL2:
case CHAMELEON_CMD_RES_CAL3: {
    if (rlen != 4) return CHAMELEON_I2C_ERR_BUS;
    uint8_t ch = (uint8_t)(wdata[0] - CHAMELEON_CMD_RES_CAL1);
    uint32_t v;
    if (g_res_comp_use_first[ch] && g_res_comp_reads[ch] == 0U) {
        v = g_res_comp_first[ch];
    } else {
        v = g_res_comp[ch];
    }
    if (g_res_comp_reads[ch] < 255U) g_res_comp_reads[ch]++;
    rdata[0] = (uint8_t)(v & 0xFF);
    rdata[1] = (uint8_t)((v >> 8) & 0xFF);
    rdata[2] = (uint8_t)((v >> 16) & 0xFF);
    rdata[3] = (uint8_t)((v >> 24) & 0xFF);
    return CHAMELEON_I2C_OK;
}
```

- [ ] **Step 3: Confirm existing tests still pass with the extended mock**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean test
```
Expected: all 8 existing host tests pass. No retry behaviour exists yet, so the existing happy-path defaults (comp != raw out of the box) are unchanged.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/mock_chameleon_i2c.h tests/mock_chameleon_i2c.c
git commit -m "test(chameleon): add comp/raw split setters and CAL sequence helper to mock"
```

---

## Task 4: TDD — blind settle + per-channel retry happy path

**Files:**
- Create: `tests/test_chameleon_settle_and_retry.c`
- Modify: `tests/Makefile` (add to `TESTS` list and add link recipe)
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c`

- [ ] **Step 1: Write the failing test**

Create `tests/test_chameleon_settle_and_retry.c`:

```c
#include "via_chameleon.h"
#include "chameleon_payload.h"
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

#define ASSERT_TRUE(cond, label) do {                                           \
    if (!(cond)) {                                                              \
        fprintf(stderr, "FAIL %s (%s:%d)\n", (label), __FILE__, __LINE__);      \
        exit(1);                                                                \
    }                                                                           \
} while (0)

/* Channels 2 and 3 return CAL == RAW on the first read; on the retry they
 * return a properly compensated (distinct) value. Channel 1 returns a
 * properly compensated value on the first read (no retry needed). */
static void test_retry_recovers_ch2_and_ch3(void) {
    mock_chameleon_reset();

    /* CH1: comp=1100, raw=1200 (default, distinct) — no retry expected. */

    /* CH2: first comp read == raw (10200), retry returns 9800. */
    mock_chameleon_set_resistance_raw(1, 10200U);
    mock_chameleon_set_resistance_comp_sequence(1, 10200U, 9800U);

    /* CH3: first comp read == raw (102200), retry returns 95000. */
    mock_chameleon_set_resistance_raw(2, 102200U);
    mock_chameleon_set_resistance_comp_sequence(2, 102200U, 95000U);

    chameleon_sample_t s;
    int ok = via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_TRUE(ok, "acquire ok");

    /* Compensated values are the post-retry (distinct) values. */
    ASSERT_EQ_U32(s.r1_ohm_comp, 1100U,  "r1 comp");
    ASSERT_EQ_U32(s.r2_ohm_comp, 9800U,  "r2 comp (retried)");
    ASSERT_EQ_U32(s.r3_ohm_comp, 95000U, "r3 comp (retried)");

    /* Raw values are unchanged. */
    ASSERT_EQ_U32(s.r1_ohm_raw,  1200U,   "r1 raw");
    ASSERT_EQ_U32(s.r2_ohm_raw,  10200U,  "r2 raw");
    ASSERT_EQ_U32(s.r3_ohm_raw,  102200U, "r3 raw");

    /* No COMP_PENDING because retry succeeded. */
    ASSERT_EQ_U32((uint32_t)(s.status_flags & CHAMELEON_FLAG_COMP_PENDING),
                  0U, "COMP_PENDING clear");

    /* No other flags. */
    ASSERT_EQ_U32(s.status_flags, 0U, "no flags at all");

    /* Total delay >= settle (250) + 2 retries * 150 = 550 ms.
     * (Plus any wait_ready polls; defaults are 0, so total is exactly 550.) */
    ASSERT_TRUE(mock_chameleon_total_delay_ms() >= 550U,
                "total delay >= 550 ms (settle + 2 retries)");
}

int main(void) {
    test_retry_recovers_ch2_and_ch3();
    printf("test_chameleon_settle_and_retry OK\n");
    return 0;
}
```

- [ ] **Step 2: Register the test in `tests/Makefile`**

Open `tests/Makefile`. Find the `TESTS :=` line:

```make
TESTS := harness_smoke chameleon_payload chameleon_driver chameleon_dummy battery_level_typo chameleon_fdr_defaults iwdg_guard
```

Append `chameleon_settle_and_retry` to it:

```make
TESTS := harness_smoke chameleon_payload chameleon_driver chameleon_dummy battery_level_typo chameleon_fdr_defaults iwdg_guard chameleon_settle_and_retry
```

Add a build recipe near the existing `$(OBJDIR)/test_chameleon_driver` recipe:

```make
$(OBJDIR)/test_chameleon_settle_and_retry: test_chameleon_settle_and_retry.c mock_chameleon_i2c.c \
		$(PROJ_BASE)/src/via_chameleon.c \
		$(PROJ_BASE)/src/chameleon_payload.c \
		| $(OBJDIR)
	$(CC) $(CFLAGS) "-I$(PROJ_BASE)/inc" "-I." -o $@ \
		test_chameleon_settle_and_retry.c mock_chameleon_i2c.c \
		"$(PROJ_BASE)/src/via_chameleon.c" \
		"$(PROJ_BASE)/src/chameleon_payload.c"
```

- [ ] **Step 3: Run the test and confirm it FAILS**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make build/test_chameleon_settle_and_retry
./build/test_chameleon_settle_and_retry
```
Expected: test FAILS at `r2 comp (retried)` because the firmware does not yet retry — it reads `10200` on the first CAL2 read and never re-reads. Exit code 1.

- [ ] **Step 4: Implement the blind settle and the per-channel retry in `via_chameleon.c`**

Open `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c`. The current `via_chameleon_read_sample` function (lines 42–126) is:

```c
int via_chameleon_read_sample(chameleon_sample_t *sample) {
    if (sample == 0) return 0;

    int all_ok = 1;
    uint8_t cmd;
    uint8_t buf4[4];
    uint8_t buf2[2];
    static const uint8_t comp_cmds[3] = { ... };
    static const uint8_t raw_cmds[3]  = { ... };
    uint32_t *comp_outs[3] = { ... };
    uint32_t *raw_outs[3]  = { ... };

    cmd = CHAMELEON_CMD_TEMP;
    if (chameleon_board_i2c_write_read(...) == CHAMELEON_I2C_OK) {
        sample->soil_temp_c_x100 = le16(buf2);
    } else {
        sample->soil_temp_c_x100 = 0;
        all_ok = 0;
    }

    for (int i = 0; i < 3; i++) {
        cmd = comp_cmds[i];
        if (chameleon_board_i2c_write_read(...) == CHAMELEON_I2C_OK) {
            *comp_outs[i] = le32(buf4);
        } else {
            *comp_outs[i] = 0;
            all_ok = 0;
        }

        cmd = raw_cmds[i];
        if (chameleon_board_i2c_write_read(...) == CHAMELEON_I2C_OK) {
            *raw_outs[i] = le32(buf4);
        } else {
            *raw_outs[i] = 0;
            all_ok = 0;
        }
    }

    cmd = CHAMELEON_CMD_ID;
    /* ... ID + flag computation unchanged ... */
}
```

Make two modifications inside this function:

**(a)** Immediately after the temperature read, before the `for` loop, add:

```c
    /* Settle: STATUS_READY can fire before CAL2/CAL3 are populated on the
     * peripheral side. Wait unconditionally before reading any CAL register. */
    chameleon_board_delay_ms(CHAMELEON_POST_READY_SETTLE_MS);
```

**(b)** Inside the `for (int i = 0; i < 3; i++)` loop, immediately after the existing block that reads `raw_cmds[i]` into `*raw_outs[i]`, add:

```c
        /* Retry CAL[i] when the peripheral returned CAL == RAW for a
         * non-open channel — that is the pass-through signature observed on
         * kaba100 when STATUS_READY fires before per-channel compensation
         * has actually been computed. */
        if (*comp_outs[i] == *raw_outs[i] &&
            *raw_outs[i] != CHAMELEON_RES_OPEN_OHMS) {
            for (uint8_t r = 0; r < CHAMELEON_CAL_RETRY_COUNT; r++) {
                chameleon_board_delay_ms(CHAMELEON_CAL_RETRY_DELAY_MS);
                cmd = comp_cmds[i];
                if (chameleon_board_i2c_write_read(CHAMELEON_I2C_ADDR_7BIT,
                                                   &cmd, 1, buf4, 4)
                    == CHAMELEON_I2C_OK) {
                    *comp_outs[i] = le32(buf4);
                }
                if (*comp_outs[i] != *raw_outs[i]) break;
            }
        }
```

Leave the rest of the function (ID read, sentinel/open flag computation) untouched.

- [ ] **Step 5: Run the test and confirm it PASSES**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make build/test_chameleon_settle_and_retry
./build/test_chameleon_settle_and_retry
```
Expected: `test_chameleon_settle_and_retry OK`. Exit code 0.

- [ ] **Step 6: Run the full regression suite — existing tests must still pass**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean test
```
Expected: `all host tests passed`. (The new test brings the total to 9.)

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/Makefile tests/test_chameleon_settle_and_retry.c \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c'
git commit -m "feat(chameleon): add post-ready settle and per-channel CAL retry

Fixes the CAL2/CAL3 == RAW2/RAW3 pass-through observed on kaba100. After
STATUS_READY, wait 250 ms before reading CAL registers, and if any
non-open channel's CAL still matches RAW after the first read, wait
150 ms and re-read CAL once."
```

---

## Task 5: TDD — COMP_PENDING bit set when retry fails to recover

**Files:**
- Create: `tests/test_chameleon_comp_pending.c`
- Modify: `tests/Makefile`
- Modify: `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c`

- [ ] **Step 1: Write the failing test**

Create `tests/test_chameleon_comp_pending.c`:

```c
#include "via_chameleon.h"
#include "chameleon_payload.h"
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

#define ASSERT_TRUE(cond, label) do {                                           \
    if (!(cond)) {                                                              \
        fprintf(stderr, "FAIL %s (%s:%d)\n", (label), __FILE__, __LINE__);      \
        exit(1);                                                                \
    }                                                                           \
} while (0)

/* Channel 3 keeps returning CAL == RAW on every read (peripheral never
 * computed compensation for it). Channels 1 and 2 are healthy. */
static void test_comp_pending_when_retry_exhausted(void) {
    mock_chameleon_reset();

    /* CH1: defaults — comp 1100, raw 1200 (distinct). */
    /* CH2: defaults — comp 10100, raw 10200 (distinct). */

    /* CH3: comp and raw both 102200, every read. */
    mock_chameleon_set_resistance_raw(2, 102200U);
    mock_chameleon_set_resistance_comp(2, 102200U);

    chameleon_sample_t s;
    int ok = via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_TRUE(ok, "acquire ok");

    /* CH1 and CH2 are still properly compensated. */
    ASSERT_EQ_U32(s.r1_ohm_comp, 1100U,  "r1 comp");
    ASSERT_EQ_U32(s.r2_ohm_comp, 10100U, "r2 comp");

    /* CH3 comp == raw — we did NOT overwrite with garbage; the value is
     * the (still-uncompensated) read. */
    ASSERT_EQ_U32(s.r3_ohm_comp, 102200U, "r3 comp == raw");
    ASSERT_EQ_U32(s.r3_ohm_raw,  102200U, "r3 raw");

    /* COMP_PENDING is set because at least one non-open channel finished
     * with CAL == RAW. */
    ASSERT_TRUE(s.status_flags & CHAMELEON_FLAG_COMP_PENDING,
                "COMP_PENDING set");

    /* No other flags spuriously set (no I2C_MISSING, TIMEOUT, etc.). */
    ASSERT_EQ_U32((uint32_t)(s.status_flags & ~CHAMELEON_FLAG_COMP_PENDING),
                  0U, "no other flags");
}

int main(void) {
    test_comp_pending_when_retry_exhausted();
    printf("test_chameleon_comp_pending OK\n");
    return 0;
}
```

- [ ] **Step 2: Register the test in `tests/Makefile`**

Append `chameleon_comp_pending` to the `TESTS :=` list (now ending `... chameleon_settle_and_retry chameleon_comp_pending`).

Add the build recipe (clone of the settle-and-retry recipe):

```make
$(OBJDIR)/test_chameleon_comp_pending: test_chameleon_comp_pending.c mock_chameleon_i2c.c \
		$(PROJ_BASE)/src/via_chameleon.c \
		$(PROJ_BASE)/src/chameleon_payload.c \
		| $(OBJDIR)
	$(CC) $(CFLAGS) "-I$(PROJ_BASE)/inc" "-I." -o $@ \
		test_chameleon_comp_pending.c mock_chameleon_i2c.c \
		"$(PROJ_BASE)/src/via_chameleon.c" \
		"$(PROJ_BASE)/src/chameleon_payload.c"
```

- [ ] **Step 3: Run the test and confirm it FAILS**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make build/test_chameleon_comp_pending
./build/test_chameleon_comp_pending
```
Expected: test FAILS at `COMP_PENDING set` because no code path currently sets that bit. Exit code 1.

- [ ] **Step 4: Implement the post-loop COMP_PENDING check in `via_chameleon.c`**

Open `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c`. After the channel `for` loop closes and before the ID read (`cmd = CHAMELEON_CMD_ID;`), add:

```c
    /* If any non-open channel finished with CAL == RAW, flag the sample as
     * compensation-pending so the back end can mark this row invalid. */
    for (int i = 0; i < 3; i++) {
        if (*comp_outs[i] == *raw_outs[i] &&
            *raw_outs[i] != CHAMELEON_RES_OPEN_OHMS) {
            sample->status_flags |= CHAMELEON_FLAG_COMP_PENDING;
            break;
        }
    }
```

- [ ] **Step 5: Run the test and confirm it PASSES**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make build/test_chameleon_comp_pending
./build/test_chameleon_comp_pending
```
Expected: `test_chameleon_comp_pending OK`. Exit code 0.

- [ ] **Step 6: Run the full regression suite**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean test
```
Expected: `all host tests passed`. (Total now 10 tests.)

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/Makefile tests/test_chameleon_comp_pending.c \
        'STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c'
git commit -m "feat(chameleon): set COMP_PENDING status bit when CAL still equals RAW after retry"
```

---

## Task 6: TDD — open-channel sentinel must not trigger retry

**Files:**
- Create: `tests/test_chameleon_open_channel_no_retry.c`
- Modify: `tests/Makefile`

The retry guard `*raw_outs[i] != CHAMELEON_RES_OPEN_OHMS` from Task 4 should already make this test pass without further firmware change. We write the test to lock the behaviour in.

- [ ] **Step 1: Write the test**

Create `tests/test_chameleon_open_channel_no_retry.c`:

```c
#include "via_chameleon.h"
#include "chameleon_payload.h"
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

#define ASSERT_TRUE(cond, label) do {                                           \
    if (!(cond)) {                                                              \
        fprintf(stderr, "FAIL %s (%s:%d)\n", (label), __FILE__, __LINE__);      \
        exit(1);                                                                \
    }                                                                           \
} while (0)

/* Channel 2 is disconnected — both CAL2 and RAW2 return the open sentinel.
 * Verify that no retry is attempted for this channel and COMP_PENDING is
 * NOT set (open is not pending, it's a hardware condition). */
static void test_open_channel_skips_retry(void) {
    mock_chameleon_reset();

    /* CH2 open: both comp and raw return the open sentinel on every read. */
    mock_chameleon_set_resistance_raw(1, CHAMELEON_RES_OPEN_OHMS);
    mock_chameleon_set_resistance_comp(1, CHAMELEON_RES_OPEN_OHMS);

    chameleon_sample_t s;
    int ok = via_chameleon_acquire(&s, CHAMELEON_DEFAULT_TIMEOUT_MS);
    ASSERT_TRUE(ok, "acquire ok");

    ASSERT_TRUE(s.status_flags & CHAMELEON_FLAG_CH2_OPEN, "CH2_OPEN set");
    ASSERT_EQ_U32((uint32_t)(s.status_flags & CHAMELEON_FLAG_COMP_PENDING),
                  0U, "COMP_PENDING NOT set for open channel");

    /* CH1 and CH3 healthy — their compensation values stay distinct from raw. */
    ASSERT_EQ_U32(s.r1_ohm_comp, 1100U,   "r1 comp untouched");
    ASSERT_EQ_U32(s.r3_ohm_comp, 101200U, "r3 comp untouched");

    /* Total delay is JUST the settle (250 ms), no retry for the open channel. */
    ASSERT_EQ_U32((uint32_t)mock_chameleon_total_delay_ms(), 250U,
                  "delay = 250 ms (settle only, no retry)");
}

int main(void) {
    test_open_channel_skips_retry();
    printf("test_chameleon_open_channel_no_retry OK\n");
    return 0;
}
```

- [ ] **Step 2: Register the test in `tests/Makefile`**

Append `chameleon_open_channel_no_retry` to the `TESTS :=` list, and add the build recipe (same pattern as the previous two):

```make
$(OBJDIR)/test_chameleon_open_channel_no_retry: test_chameleon_open_channel_no_retry.c mock_chameleon_i2c.c \
		$(PROJ_BASE)/src/via_chameleon.c \
		$(PROJ_BASE)/src/chameleon_payload.c \
		| $(OBJDIR)
	$(CC) $(CFLAGS) "-I$(PROJ_BASE)/inc" "-I." -o $@ \
		test_chameleon_open_channel_no_retry.c mock_chameleon_i2c.c \
		"$(PROJ_BASE)/src/via_chameleon.c" \
		"$(PROJ_BASE)/src/chameleon_payload.c"
```

- [ ] **Step 3: Run the test and confirm it PASSES first try**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean
make build/test_chameleon_open_channel_no_retry
./build/test_chameleon_open_channel_no_retry
```
Expected: `test_chameleon_open_channel_no_retry OK`. The retry guard from Task 4 already covers this case. If the test fails on the delay assertion, double-check that the retry block in Task 4 step 4 contains the `*raw_outs[i] != CHAMELEON_RES_OPEN_OHMS` condition.

- [ ] **Step 4: Run the full regression suite**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean test
```
Expected: `all host tests passed`. (Total now 11 tests.)

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add tests/Makefile tests/test_chameleon_open_channel_no_retry.c
git commit -m "test(chameleon): lock open-channel skip-retry behaviour"
```

---

## Task 7: Build firmware artefacts

**Files:**
- Regenerate: `build/LSN50-chameleon.{bin,elf,hex,map}`
- Regenerate: `build/LSN50-chameleon-dummy.{bin,elf,hex,map}`

- [ ] **Step 1: Verify the ARM toolchain is available**

Run:
```bash
which arm-none-eabi-gcc && arm-none-eabi-gcc --version | head -1
```
Expected: `/usr/bin/arm-none-eabi-gcc` (or similar) and a version string. If absent, install before continuing.

- [ ] **Step 2: Build the chameleon variant**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon
```
Expected: Many `CC` lines, then `LINK`, then `arm-none-eabi-size` reporting `text data bss dec hex filename` for the `.elf`, then `BUILD OK`. The `.bin`, `.elf`, `.hex`, `.map` files in `build/` are updated.

- [ ] **Step 3: Build the chameleon-dummy variant**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/build
./build.sh chameleon-dummy
```
Expected: `BUILD OK`. `LSN50-chameleon-dummy.{bin,elf,hex,map}` updated.

- [ ] **Step 4: Sanity-check binary size change vs. V1**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude
git diff --stat 884fda3 -- build/LSN50-chameleon.bin build/LSN50-chameleon-dummy.bin
arm-none-eabi-size build/LSN50-chameleon.elf build/LSN50-chameleon-dummy.elf
```
Expected: binaries have changed (non-zero diff). `.text` grows by tens to a couple hundred bytes (one extra delay call site and a small loop). If `.text` jumped by kilobytes, something has gone wrong — investigate before committing.

- [ ] **Step 5: Commit binary artefacts**

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add build/LSN50-chameleon.bin build/LSN50-chameleon.elf build/LSN50-chameleon.hex build/LSN50-chameleon.map \
        build/LSN50-chameleon-dummy.bin build/LSN50-chameleon-dummy.elf build/LSN50-chameleon-dummy.hex build/LSN50-chameleon-dummy.map
git commit -m "build(chameleon): regenerate v1.5 firmware artefacts"
```

---

## Task 8: osi-os — add `comp_pending` column to `chameleon_readings`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (migration block at the `data_invalid` ALTER, around line 5628)

- [ ] **Step 1: Find the existing `data_invalid` migration**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, locate the function node that contains:

```
ALTER TABLE chameleon_readings ADD COLUMN data_invalid INTEGER DEFAULT 0
```

This is around line 5628 inside the schema-repair `stmts` array.

- [ ] **Step 2: Add the `comp_pending` ALTER immediately after it**

Insert a new line in the `stmts` array, immediately after the `data_invalid` ALTER:

```
"ALTER TABLE chameleon_readings ADD COLUMN comp_pending INTEGER DEFAULT 0",
```

(Remember the trailing comma. The repair block already ignores `duplicate column name` errors via the same idempotent pattern used for `data_invalid`.)

- [ ] **Step 3: Validate JSON parses**

Run:
```bash
cd /home/phil/Repos/osi-os
python3 -c "import json; json.load(open('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'))" && echo OK
```
Expected: `OK`. If JSON parsing fails, fix quoting/commas before continuing.

- [ ] **Step 4: Commit (squash with Task 9 if you prefer — see Task 9 step 6)**

Hold the commit until Task 9 is done; one combined commit is cleaner than two-half-changes.

---

## Task 9: osi-os — surface `comp_pending` in the Chameleon decoder and INSERT

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (decoder field map around line 3731, and INSERT statement around line 8244)

- [ ] **Step 1: Extend the decoder field map**

In `flows.json`, find the block (around line 3731) that builds `chameleonDecoded`-keyed fields onto the message — the run of `chameleonI2cMissing: chameleonDecoded.i2cMissing,` … `chameleonCh3Open: chameleonDecoded.ch3Open,`.

The `chameleonDecoded` object itself does **not** decode the new bit (the ChirpStack codec only exposes the raw `Chameleon_Status_Flags` byte plus the historical bit-flag keys). We derive `compPending` directly from `chameleonStatusFlags` here.

Replace the line:

```
chameleonStatusFlags: chameleonDecoded.statusFlags,
```

with the two lines:

```
chameleonStatusFlags: chameleonDecoded.statusFlags,
chameleonCompPending: (chameleonDecoded.statusFlags != null && (Number(chameleonDecoded.statusFlags) & 0x80)) ? 1 : 0,
```

(Same nullable handling as the surrounding decoder code uses for the other flags.)

- [ ] **Step 2: Extend the INSERT statement**

Find the function node (around line 8244) with:

```sql
INSERT INTO chameleon_readings (deveui,recorded_at,payload_version,status_flags,data_invalid,i2c_missing,timeout,temp_fault,id_fault,ch1_open,ch2_open,ch3_open,temp_c,r1_ohm_comp,r2_ohm_comp,r3_ohm_comp,r1_ohm_raw,r2_ohm_raw,r3_ohm_raw,array_id,adc_ch0v,adc_ch1v,adc_ch4v,bat_v,payload_b64,f_port,f_cnt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
```

Add `comp_pending` to the column list immediately after `data_invalid`, and add one more `?` to the VALUES list:

```sql
INSERT INTO chameleon_readings (deveui,recorded_at,payload_version,status_flags,data_invalid,comp_pending,i2c_missing,timeout,temp_fault,id_fault,ch1_open,ch2_open,ch3_open,temp_c,r1_ohm_comp,r2_ohm_comp,r3_ohm_comp,r1_ohm_raw,r2_ohm_raw,r3_ohm_raw,array_id,adc_ch0v,adc_ch1v,adc_ch4v,bat_v,payload_b64,f_port,f_cnt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
```

In the parameter array immediately below, the existing `dataInvalidFlag,` line is followed by `toInt(d.chameleonI2cMissing),`. Insert one new line between them:

```
toInt(d.chameleonCompPending),
```

so the order becomes `… dataInvalidFlag, toInt(d.chameleonCompPending), toInt(d.chameleonI2cMissing), …`.

- [ ] **Step 3: Validate JSON parses**

Run:
```bash
cd /home/phil/Repos/osi-os
python3 -c "import json; json.load(open('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'))" && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Run the sync-flow verifier (smoke check, not a strict check on this change)**

Run:
```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
```
Expected: the verifier completes without errors. It does not specifically check the chameleon decoder, but it sanity-checks that the flow loads.

- [ ] **Step 5: Spot-check column count vs placeholder count**

Run:
```bash
cd /home/phil/Repos/osi-os
python3 - <<'PY'
import re, json
with open('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json') as f:
    txt = f.read()
m = re.search(r'INSERT INTO chameleon_readings \(([^)]+)\) VALUES \(([?,]+)\)', txt)
cols = m.group(1).split(',')
qs   = m.group(2).split(',')
print('columns:', len(cols), 'placeholders:', len(qs))
assert len(cols) == len(qs), 'mismatch'
print('OK')
PY
```
Expected: `columns: 28 placeholders: 28` and `OK`.

- [ ] **Step 6: Commit Task 8 + Task 9 together**

```bash
cd /home/phil/Repos/osi-os
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "feat(chameleon): persist comp_pending flag from v1.5 firmware

Adds idempotent ALTER TABLE migration for the new comp_pending column on
chameleon_readings, decodes bit 7 (CHAMELEON_FLAG_COMP_PENDING) from the
Chameleon status byte, and writes it on insert. Default 0 keeps old V1
firmware rows well-formed."
```

---

## Task 10: Verification script for post-flash check

**Files:**
- Create: `/home/phil/Repos/osi-os/scripts/verify-chameleon-v1.5.sh`

- [ ] **Step 1: Write the verification script**

Create `/home/phil/Repos/osi-os/scripts/verify-chameleon-v1.5.sh`:

```bash
#!/usr/bin/env bash
# verify-chameleon-v1.5.sh — post-flash check for the V1.5 firmware on kaba100.
#
# Usage:
#   scripts/verify-chameleon-v1.5.sh /path/to/farming.db [hours]
#
# Defaults: hours = 13 (matches the pre-flash baseline window).
#
# Pre-flash baseline (kaba100, 13 h window before flashing V1.5):
#   - 12 of 158 uplinks (~7.6 %) had r2_comp != r2_raw and r3_comp != r3_raw.
#
# Post-flash success criteria (over the same DEUI, comparable window):
#   - >= 99 % of uplinks have r2_comp != r2_raw and r3_comp != r3_raw.
#   - < 1 % of uplinks have comp_pending = 1.
#   - i2c_missing / timeout / temp_fault / id_fault counts stay at pre-flash
#     levels (essentially zero on kaba100).

set -euo pipefail

DB="${1:?path to farming.db required}"
HOURS="${2:-13}"
DEUI="A84041A75D5E7CFB"

[ -f "$DB" ] || { echo "DB not found: $DB" >&2; exit 1; }

sqlite3 -header -column "$DB" <<SQL
.print '== Window: last $HOURS h for $DEUI =='
WITH win AS (
  SELECT * FROM chameleon_readings
  WHERE deveui = '$DEUI'
    AND recorded_at >= datetime('now', '-$HOURS hours')
)
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN r1_ohm_comp != r1_ohm_raw THEN 1 ELSE 0 END) AS r1_ok,
  SUM(CASE WHEN r2_ohm_comp != r2_ohm_raw THEN 1 ELSE 0 END) AS r2_ok,
  SUM(CASE WHEN r3_ohm_comp != r3_ohm_raw THEN 1 ELSE 0 END) AS r3_ok,
  SUM(CASE WHEN comp_pending = 1 THEN 1 ELSE 0 END) AS pending,
  SUM(i2c_missing) AS i2c_missing,
  SUM(timeout)     AS timeout,
  SUM(temp_fault)  AS temp_fault,
  SUM(id_fault)    AS id_fault
FROM win;

.print ''
.print '== Sample of any comp_pending rows =='
SELECT recorded_at, temp_c,
       r1_ohm_raw AS r1raw, r1_ohm_comp AS r1c,
       r2_ohm_raw AS r2raw, r2_ohm_comp AS r2c,
       r3_ohm_raw AS r3raw, r3_ohm_comp AS r3c
FROM chameleon_readings
WHERE deveui='$DEUI'
  AND recorded_at >= datetime('now', '-$HOURS hours')
  AND comp_pending = 1
ORDER BY recorded_at DESC
LIMIT 5;
SQL
```

- [ ] **Step 2: Make the script executable**

Run:
```bash
chmod +x /home/phil/Repos/osi-os/scripts/verify-chameleon-v1.5.sh
```

- [ ] **Step 3: Smoke-test the script against the pre-flash baseline DB**

Run:
```bash
/home/phil/Repos/osi-os/scripts/verify-chameleon-v1.5.sh /tmp/kaba100-analysis/farming.db 13
```
Expected: shows `total=158`, `r1_ok=158`, `r2_ok=12`, `r3_ok=12`, `pending=0` (column doesn't exist yet — the migration hasn't been deployed). If the DB doesn't have the column, sqlite3 will error on `comp_pending`; the script still proves itself once the migration ships, but for the baseline check it's enough to confirm the `total / r1_ok / r2_ok / r3_ok` numbers match what we documented in the spec.

If you want a baseline-only smoke check that works against the pre-migration DB, run instead:
```bash
sqlite3 /tmp/kaba100-analysis/farming.db \
  "SELECT COUNT(*) total,
          SUM(CASE WHEN r2_ohm_comp != r2_ohm_raw THEN 1 ELSE 0 END) r2_ok,
          SUM(CASE WHEN r3_ohm_comp != r3_ohm_raw THEN 1 ELSE 0 END) r3_ok
   FROM chameleon_readings
   WHERE deveui='A84041A75D5E7CFB';"
```
Expected: `158 | 12 | 12`.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-os
git add scripts/verify-chameleon-v1.5.sh
git commit -m "test(chameleon): add v1.5 post-flash verification script"
```

---

## Task 11: Final cross-check before flashing

This task does not write code; it confirms the deliverables are in place.

- [ ] **Step 1: Firmware branch summary**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude
git log --oneline 884fda3..HEAD
git diff --stat 884fda3..HEAD
```
Expected: 5 commits (Task 2, 3, 4, 5, 6 had commits; Task 7 added a 6th for binaries; Task 10 was osi-os). Roughly:
- `feat(chameleon): declare v1.5 settle/retry constants and COMP_PENDING bit`
- `test(chameleon): add comp/raw split setters and CAL sequence helper to mock`
- `feat(chameleon): add post-ready settle and per-channel CAL retry`
- `feat(chameleon): set COMP_PENDING status bit when CAL still equals RAW after retry`
- `test(chameleon): lock open-channel skip-retry behaviour`
- `build(chameleon): regenerate v1.5 firmware artefacts`

`diff --stat` should show modifications to the two headers, `via_chameleon.c`, the mock, three new test files, the Makefile, and the binaries — nothing else.

- [ ] **Step 2: All host tests green**

Run:
```bash
cd /home/phil/Repos/LoRa_STM32-claude/tests
make clean test
```
Expected: 11 tests pass; final line `all host tests passed`.

- [ ] **Step 3: osi-os repo summary**

Run:
```bash
cd /home/phil/Repos/osi-os
git log --oneline -3
git status --short
```
Expected: the most recent commit on whatever branch is checked out is `feat(chameleon): persist comp_pending flag from v1.5 firmware`, then `test(chameleon): add v1.5 post-flash verification script`, then the spec commit (`docs: plan chameleon firmware v1.5`). No unstaged changes related to this work.

- [ ] **Step 4: Ready to flash**

Flash `build/LSN50-chameleon.hex` (the live variant, **not** `-dummy`) to the kaba100 Chameleon LSN50 via the existing JTAG/serial flashing flow. Do **not** flash other Pis until verification on kaba100 passes.

Wait at least one full diurnal cycle on kaba100 (24 h is comfortable; 13 h matches the baseline window).

Re-snapshot the DB and run:
```bash
/home/phil/Repos/osi-os/scripts/verify-chameleon-v1.5.sh /tmp/farming.db 24
```

Success criteria, from the spec:
- `r2_ok / total ≥ 0.99` and `r3_ok / total ≥ 0.99` (channel 1 already 100 %).
- `pending / total < 0.01`.
- `i2c_missing, timeout, temp_fault, id_fault` counts unchanged from pre-flash.

If `pending` is non-trivial (> a handful of rows), the 250 ms settle is not enough — bump `CHAMELEON_POST_READY_SETTLE_MS` (e.g. to 500 ms), rebuild, re-flash. Use the same verification script.

If `timeout` count surges, the worst-case 700 ms extra latency is pushing `via_chameleon_acquire` past the 2 s budget — the spec considers this low-likelihood but worth checking. Mitigation: drop `CHAMELEON_CAL_RETRY_COUNT` to 0 and lean on the blind settle only, or raise `CHAMELEON_DEFAULT_TIMEOUT_MS`.

---

## Self-review notes

- **Spec coverage:** Each spec section maps to a task. Goal 1 (≥ 99 % comp != raw) → Tasks 4 + 7; Goal 2 (visible flag) → Tasks 5 + 8 + 9; Goal 3 (binary compat) → Task 2 keeps payload version `0x01`; Goal 4 (2 s budget) → Task 11 step 4 watch.
- **Placeholder scan:** All steps contain exact paths, exact code, exact commands, exact expected output. No TBDs.
- **Type consistency:** `CHAMELEON_FLAG_COMP_PENDING` is the single name used in headers, firmware, tests, and the osi-os derivation (`& 0x80` literal mirrors the bit). `comp_pending` is the single column name in both the migration and the INSERT. The Node-RED key is `chameleonCompPending`, consistent across decoder and INSERT parameter array.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-15-chameleon-firmware-v1.5.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
