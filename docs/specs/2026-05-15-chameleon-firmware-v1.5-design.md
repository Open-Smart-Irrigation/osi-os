# Chameleon Firmware V1.5 Design

**Date:** 2026-05-15
**Scope:** `LoRa_STM32-claude` firmware repo (`feature/chameleon-v1.5` branch). One small osi-os follow-up to surface a new status-flag bit.
**Status:** Design approved, ready for implementation plan.

---

## Background

The Chameleon LSN50 v2 firmware on the `kaba100` Pi (DEUI `A84041A75D5E7CFB`) emits a 44-byte V1 LoRaWAN payload containing per-channel raw resistance, per-channel temperature-compensated resistance, soil temperature, ADC channels, battery, and the array OneWire ID. A 13-hour capture (158 uplinks) shows that channels 2 and 3 carry `CAL[i] == RAW[i]` on **146 of 158** uplinks (~92.4 %), with only **12 of 158** uplinks (~7.6 %) emitting a properly compensated `CAL` value. Channel 1 emits a properly compensated value on **all 158** uplinks.

Byte-level analysis of `payload_b64` proves the pass-through is in the wire bytes themselves — bytes 16–19 / 20–23 (`r2/r3_ohm_comp`) literally contain the same value as bytes 28–31 / 32–35 (`r2/r3_ohm_raw`) on bad uplinks. The osi-os Node-RED decoder is faithful; the bug is upstream of the LoRa transmit.

Tracing into the firmware ([`via_chameleon.c:78-94`](../../../LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/via_chameleon.c)), the LSN50 firmware simply reads I²C registers `CAL1/2/3 (0x11/0x12/0x13)` and `RAW1/2/3 (0x21/0x22/0x23)` from the Chameleon array MCU after a single `STATUS == READY` (0x01) poll. The working hypothesis, supported by the data, is that the Chameleon array MCU signals `READY` once its fast channel (CH1) has compensation computed, but channels 2 and 3 (higher-impedance gypsum tips) are still settling, so `CAL2 / CAL3` hold a pre-trigger value that happens to equal RAW. None of the recorded payloads have `i2c_missing`, `timeout`, `temp_fault`, `id_fault`, or any open-channel flag set; ADC, battery, and soil temperature distributions are statistically identical between the good 12 and bad 146 uplinks; there is no periodic / f_cnt / battery / temperature correlation with the good uplinks. The triggering condition is internal to the Chameleon peripheral.

---

## Goals

1. Make `CAL[i]` in the LoRaWAN payload reflect actual temperature-compensated resistance on **≥ 99 %** of uplinks for **all three channels** on the kaba100 device, under the same physical conditions.
2. When the device still fails to compute compensation in time, **emit a visible flag** so the back end can mark the affected row pending instead of plotting the raw artefact.
3. Stay binary-compatible with the existing V1 44-byte payload, the osi-os ingest path, and the `chameleon_readings` schema. **No** wire-format changes.
4. Do not regress timeout/error behaviour: stay within the existing `CHAMELEON_DEFAULT_TIMEOUT_MS = 2000` envelope.

---

## Non-goals

- The V2 compact 32-byte payload, MOD=3 default mode change, IWDG hardening, and downlink-reject behaviour stay on the `feature/chameleon-i2c-reader` branch. V1.5 carries **none** of those changes.
- No changes to ChirpStack device profiles, codec, or osi-server.
- No bench-rig logic-analyser investigation in this scope (recommended as a follow-up but not blocking V1.5).

---

## Approach

Adopt **option C** from brainstorming: a fixed blind settle window after `STATUS_READY`, plus per-channel detect-and-retry with a single re-read, plus a new `COMP_PENDING` status-flag bit when retry still leaves any channel with `CAL == RAW`. The blind settle is grounded in the empirical evidence that some uplinks already do produce correct values without any retry — we are not inventing a delay against an unknown distribution. The retry catches the long tail and converts it into a labelled "compensation pending" row, so we know whether V1.5 actually worked without a logic-analyser session.

---

## Branch & baseline

- New local branch `feature/chameleon-v1.5` in `/home/phil/Repos/LoRa_STM32-claude`, branched from commit `884fda3` (2026-05-01, *"build(chameleon): add firmware artifacts"*). This is the last V1 commit before V2 work began on 2026-05-14.
- `feature/chameleon-i2c-reader` and its V2 commits (`dc88235`, `fc11715`, `e3cd327`, `1b48398`, `8cf5973`, `310cd52`, `7153161`) are **not** reverted; that branch stays as the V2 record.
- After merge, tag the merge commit `chameleon-fw-v1.5`.

---

## Firmware changes

All edits live in `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/`.

### `inc/via_chameleon.h` — new timing constants

```c
#define CHAMELEON_POST_READY_SETTLE_MS  250U   /* blind settle after STATUS_READY before reading CAL/RAW */
#define CHAMELEON_CAL_RETRY_DELAY_MS    150U   /* wait between the first read and the single retry */
#define CHAMELEON_CAL_RETRY_COUNT       1U     /* retries per channel when CAL[i] == RAW[i] */
```

These values give a worst-case extra latency of `250 + 3 × 150 = 700 ms` on top of the existing trigger + poll cost. The 2 s `CHAMELEON_DEFAULT_TIMEOUT_MS` already accommodates this in the normal case where `wait_ready` returns well under 1 s.

### `inc/chameleon_payload.h` — new status-flag bit

```c
#define CHAMELEON_FLAG_COMP_PENDING   (1U << 7)  /* CAL[i] == RAW[i] for at least one non-open channel after retry */
```

Bits 0–6 are already used (`I2C_MISSING`, `TIMEOUT`, `TEMP_FAULT`, `ID_FAULT`, `CH1_OPEN`, `CH2_OPEN`, `CH3_OPEN`). Bit 7 was previously unused. `status_flags` stays a single `uint8_t` field in the V1 wire layout; no struct or payload-length change.

### `src/via_chameleon.c` — read sequence

Modify `via_chameleon_read_sample` (the function that runs after `via_chameleon_wait_ready` has returned success):

1. After the I²C temperature read (`CHAMELEON_CMD_TEMP`), call `chameleon_board_delay_ms(CHAMELEON_POST_READY_SETTLE_MS)`. This is unconditional and applies before any CAL/RAW read.
2. Inside the existing `for (int i = 0; i < 3; i++)` loop, after reading both `CAL[i]` into `*comp_outs[i]` and `RAW[i]` into `*raw_outs[i]`:
   - If `*comp_outs[i] == *raw_outs[i]` **and** `*raw_outs[i] != CHAMELEON_RES_OPEN_OHMS`, run a retry loop of up to `CHAMELEON_CAL_RETRY_COUNT` iterations: `chameleon_board_delay_ms(CHAMELEON_CAL_RETRY_DELAY_MS)`, then re-issue `CHAMELEON_CMD_RES_CAL{1,2,3}` and overwrite `*comp_outs[i]`. Stop as soon as `*comp_outs[i] != *raw_outs[i]`.
   - The open-circuit check prevents pointlessly burning 150 ms on disconnected channels (which legitimately return open sentinels on both CAL and RAW).
3. After the channel loop, walk the three channels once more. If for any channel `*comp_outs[i] == *raw_outs[i]` and `*raw_outs[i] != CHAMELEON_RES_OPEN_OHMS`, set `sample->status_flags |= CHAMELEON_FLAG_COMP_PENDING`.

The retry overwrites `*comp_outs[i]` with whatever the second read returns, including the case where it still equals raw. We never write zero, and we never write a partially read buffer; if an I²C read errors on retry, leave the previous value in place and let the next periodic uplink try again. (The existing error path that sets `*comp_outs[i] = 0` and `all_ok = 0` on the first-read I²C failure is unchanged.)

### `src/bsp.c` — diagnostic PPRINTF

The existing `PPRINTF("Chameleon flags:0x%02x ...")` block already dumps `status_flags`. No change needed; the new bit appears automatically in the `0x%02x` output.

---

## Tests (host, under `tests/`)

Three new tests, wired into the existing make-test harness. Each uses (and may extend) the existing I²C mock used by V1 tests so the fixtures are deterministic and synchronous.

### `tests/test_chameleon_settle_and_retry.c`

Scenario: Chameleon mock returns `CAL[i] == RAW[i]` for channels 2 and 3 on first read, and a distinct compensated value on second read. Channel 1 returns a properly compensated value on first read.

Assert:
- `via_chameleon_read_sample` returns success.
- `r1_ohm_comp != r1_ohm_raw`, `r2_ohm_comp != r2_ohm_raw`, `r3_ohm_comp != r3_ohm_raw` after the call.
- `status_flags & CHAMELEON_FLAG_COMP_PENDING == 0`.
- The number of I²C transactions matches the expected sequence: 1 temp + (1 CAL + 1 RAW) for ch1 + (1 CAL + 1 RAW + 1 retry CAL) for ch2 + (1 CAL + 1 RAW + 1 retry CAL) for ch3 + 1 ID = **10 transactions**. Pin this exact count to lock the retry path against future regressions.

### `tests/test_chameleon_comp_pending.c`

Scenario: Mock returns `CAL[i] == RAW[i]` for channel 3 on **both** first read and retry. Channels 1 and 2 are healthy.

Assert:
- `r1_ohm_comp != r1_ohm_raw`, `r2_ohm_comp != r2_ohm_raw`.
- `r3_ohm_comp == r3_ohm_raw` (we did not overwrite with zero or garbage).
- `status_flags & CHAMELEON_FLAG_COMP_PENDING != 0`.
- Other status-flag bits are unchanged (no spurious `TIMEOUT` etc.).

### `tests/test_chameleon_open_channel_no_retry.c`

Scenario: Mock returns `CHAMELEON_RES_OPEN_OHMS` for both `CAL2` and `RAW2`. Channels 1 and 3 are healthy with proper compensation.

Assert:
- Exactly **zero** retry reads on channel 2 (mock transaction count proves it).
- `CHAMELEON_FLAG_CH2_OPEN` is set.
- `CHAMELEON_FLAG_COMP_PENDING` is **not** set (an open channel is not pending compensation).
- Other channels' compensation values are intact.

### Regression

All existing V1 tests under `tests/` must continue to pass without changes. The `make test` target is the gate.

---

## osi-os follow-up

A single small commit on osi-os to expose the new bit:

- Extend the Chameleon decoder in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` to decode bit 7 of `status_flags` as `comp_pending`.
- Add a column `comp_pending INTEGER DEFAULT 0` to `chameleon_readings` (idempotent migration in the existing schema-repair path).
- Populate the column on insert. No GUI change in this spec — surfacing the flag in the dashboard is a separate small task tracked outside V1.5.

This follow-up is required because the verification plan reads `comp_pending` from the DB. It can be merged before or after the firmware ships; the DB column defaults to 0, so old firmware (V1) and new firmware (V1.5) both produce well-formed rows.

---

## Build artefacts

- Build `LSN50-chameleon.bin / .elf / .hex / .map` and the `dummy` variants via the existing GCC build system, from the V1.5 branch.
- Commit binaries into `build/` on the V1.5 branch, consistent with V1 convention (`884fda3 build(chameleon): add firmware artifacts`).

---

## Deployment

- Flash one Chameleon LSN50 unit on kaba100 (the device currently producing the bad data) using the existing JTAG/serial flashing flow. **Do not** flash the Silvan or Uganda Pis with V1.5 until verification on kaba100 passes.
- No osi-os / osi-server deployment is required for the firmware itself. The osi-os follow-up (above) deploys via the standard `deploy.sh` GUI-only path used in the April rollout.

---

## Verification

Pre-flash baseline (already captured in `/tmp/kaba100-analysis/farming.db`, ~13 h window): 12 of 158 uplinks (~7.6 %) had `r2_comp != r2_raw` and `r3_comp != r3_raw`.

Post-flash, over a comparable 13 h window on kaba100:

- **Success:** `≥ 99 %` of uplinks have `r2_comp != r2_raw` **and** `r3_comp != r3_raw` (channel 1 was already at 100 % and must stay there).
- **Success:** `comp_pending == 1` on **< 1 %** of uplinks.
- **Success:** `swt_1 / swt_2 / swt_3` shown in the dashboard becomes smooth — visually no saw-tooth — across at least one full diurnal cycle. The daily-min vs daily-max swing on swt_2 / swt_3 in `device_data` shrinks materially.
- **Regression watch:** `i2c_missing`, `timeout`, `temp_fault`, `id_fault` counts stay at their pre-flash levels (essentially zero on kaba100). A surge in `timeout` would indicate the worst-case 700 ms extra latency (250 ms settle + 3 × 150 ms retries) pushed `via_chameleon_acquire` past 2 s; that would block the rollout.

All checks reuse SQL queries we already validated in the diagnosis session against `chameleon_readings`.

---

## Risk register

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| 250 ms settle isn't enough; bug persists on kaba100 | Low | `COMP_PENDING` makes this visible immediately. Bump constant, rebuild, re-flash. |
| Retry pushes total acquire past 2 s timeout on some uplinks | Low | Test math: worst case 700 ms extra is well under the 1.3 s headroom we typically have. Verify in post-flash regression watch above. |
| Open-channel sentinel value is wrong (so we end up retrying disconnected channels) | Low | Existing `CHAMELEON_RES_OPEN_OHMS` constant is already used elsewhere in V1; we are just adding one more comparison against the same constant. |
| osi-os decoder follow-up not deployed before flashing | Low | DB column defaults to 0; old decoder ignores bit 7. We lose visibility into `COMP_PENDING` until the follow-up ships, but no rows break. |
| Future Chameleon firmware revisions on the peripheral side change CAL register behaviour | Low (out of our control) | Retry logic is conservative — if a future revision makes CAL == RAW the *correct* behaviour for some channel, we'd flag spurious `COMP_PENDING`. Document the assumption next to the constants. |

---

## Out-of-scope follow-ups

These are **not** part of V1.5 but worth listing so we don't lose them:

1. Bench-rig logic-analyser session on a spare Chameleon array to characterise actual `STATUS_READY` vs `CAL` register population timing. Lets us tune `CHAMELEON_POST_READY_SETTLE_MS` from "safe guess" to "measured".
2. Surface `comp_pending` in the osi-os dashboard (badge or per-row indicator). Currently the spec only adds the DB column.
3. Optional V2-style compact 32-byte payload as a separate branch later — independent of V1.5.

---

## Approval

Brainstormed and approved with the user on 2026-05-15. This spec is the input to the implementation plan generated by the `superpowers:writing-plans` skill.
