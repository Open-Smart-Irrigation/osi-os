# Chameleon V2 Hardening And Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Chameleon LSN50 v2 firmware against the no-boot/downlink-debug findings and mirror the V2 `data_invalid` status through OSI OS and OSI Server.

**Architecture:** Keep Chameleon firmware MOD3-only and stock-aligned, but make rejected MOD changes observable through the existing Dragino response-level mechanism. Persist `data_invalid` as a first-class diagnostic field on edge and server so V1 and V2 Chameleon rows can be queried consistently without overloading `i2c_missing` or `timeout`.

**Tech Stack:** STM32L072/Dragino C firmware in `/home/phil/Repos/LoRa_STM32-claude`, Node-RED JSON + SQLite verifiers in `/home/phil/Repos/osi-os`, Spring Boot/Flyway/JPA tests in `/home/phil/Repos/osi-server`.

---

## Decisions

- Invalid Chameleon `AT+MOD=N` downlinks where `N != 3` must produce a negative Dragino response (`0x00` in the existing reply path), not a positive received/applied ack.
- Invalid Chameleon `AT+MOD=N` downlinks must follow stock Dragino `AT+RPL` response-level behavior. Do not force an uplink reply when response level disables replies.
- Watchdog LSI measurement must fail safe. If TIM21 capture does not complete, use a conservative fallback LSI value instead of hanging before LoRa init.
- Keep Chameleon I2C HAL timeouts at `1000 ms` in this slice. Add no I2C timeout behavior change unless verification shows a real issue.
- Sync diagnostic schema changes through both OSI OS and OSI Server.

## File Map

### Firmware: `/home/phil/Repos/LoRa_STM32-claude`

- Modify `STM32CubeExpansion_LRWAN/Drivers/BSP/Components/iwdg/iwdg.c`
  - Add bounded LSI capture wait and fallback frequency.
- Modify `STM32CubeExpansion_LRWAN/Drivers/BSP/Components/iwdg/iwdg.h`
  - Remove the bad private `static uint32_t GetLSIFrequency(void);` header prototype.
- Modify `STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`
  - Return a negative downlink result for unsupported MOD values under `USE_CHAMELEON`.
- Modify `tests/test_chameleon_fdr_defaults.c`
  - Assert the unsupported MOD downlink path sets `rxpr_flags=0`, leaves `atz_flags` unset, and logs the rejection.
- Create `tests/test_iwdg_guard.c`
  - Static test for timeout/fallback guard and header cleanup.
- Modify `tests/Makefile`
  - Add `iwdg_guard` to host tests.

### OSI OS: `/home/phil/Repos/osi-os`

- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
  - Add `data_invalid` column in sync-init schema and insert SQL.
  - Persist computed `dataInvalid` value in `chameleon_readings`.
  - Make Chameleon insert node status grey/yellow/green based on normalized integer flags.
  - Ensure `CHAMELEON_READING_APPENDED` outbox payload includes `data_invalid`.
- Modify bundled SQLite seeds:
  - `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
  - `database/farming.db`
  - `web/react-gui/farming.db`
- Modify `scripts/verify-lsn50-chameleon-persistence.js`
  - Assert `data_invalid` schema, insert params, V1/V2 storage, and status colors.
- Modify `scripts/verify-sync-flow.js`
  - Assert all seed DBs include `chameleon_readings.data_invalid`.

### OSI Server: `/home/phil/Repos/osi-server`

- Create `backend/src/main/resources/db/migration/V41__chameleon_data_invalid.sql`
  - Add `data_invalid BOOLEAN NOT NULL DEFAULT false`.
- Modify `backend/src/main/java/org/osi/server/analytics/ChameleonReading.java`
  - Add `dataInvalid`.
- Modify `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
  - Read `data_invalid`, `dataInvalid`, and `Chameleon_Data_Invalid`.
- Modify server sync tests:
  - `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceDataPlaneTest.java`
  - `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceBootstrapTest.java`

## Code Quality Notes

- KISS/YAGNI: do not introduce a new firmware command protocol. Reuse Dragino's existing `rxpr_flags` reply mechanism.
- SoC: firmware boot safety, edge persistence, and server mirror changes stay in their repos. The only shared contract is the `data_invalid` field name.
- DRY: use one computed `dataInvalid` value in Node-RED insert logic, then store it and use it for nulling data fields and node status.

---

### Task 1: Firmware Static Tests

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/tests/test_chameleon_fdr_defaults.c`
- Create: `/home/phil/Repos/LoRa_STM32-claude/tests/test_iwdg_guard.c`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/tests/Makefile`

- [ ] **Step 1: Add downlink rejection expectations**

In `tests/test_chameleon_fdr_defaults.c`, replace the current downlink MOD assertion block:

```c
assert_contains(downlink_mod_case, "#ifdef USE_CHAMELEON\n\t\t\t\t\t\tif(AppData->Buff[1]==0x03)\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tmode=0x03;", "downlink mod accepts only chameleon mode 3");
assert_contains(downlink_mod_case, "#else\n\t\t\t\t\t\tmode=AppData->Buff[1];", "stock downlink mod remains configurable");
```

with:

```c
assert_contains(downlink_mod_case, "#ifdef USE_CHAMELEON\n\t\t\t\t\t\tif(AppData->Buff[1]==0x03)\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tmode=0x03;", "downlink mod accepts only chameleon mode 3");
assert_contains(downlink_mod_case, "else\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tPPRINTF(\"Chameleon firmware supports MOD=3 only\\r\\n\");\n\t\t\t\t\t\t\trxpr_flags=0;", "downlink mod rejects non-3 with negative ack");
assert_contains(downlink_mod_case, "#else\n\t\t\t\t\t\tmode=AppData->Buff[1];", "stock downlink mod remains configurable");
```

- [ ] **Step 2: Add IWDG guard static test**

Create `tests/test_iwdg_guard.c`:

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *read_file(const char *path) {
    FILE *fp = fopen(path, "rb");
    if (!fp) {
        perror(path);
        exit(1);
    }
    if (fseek(fp, 0, SEEK_END) != 0) exit(1);
    long size = ftell(fp);
    if (size < 0) exit(1);
    rewind(fp);
    char *buf = (char *)calloc((size_t)size + 1U, 1U);
    if (!buf) exit(1);
    if (fread(buf, 1U, (size_t)size, fp) != (size_t)size) exit(1);
    fclose(fp);
    return buf;
}

static void assert_contains(const char *haystack, const char *needle, const char *label) {
    if (!strstr(haystack, needle)) {
        fprintf(stderr, "missing %s: %s\n", label, needle);
        exit(1);
    }
}

static void assert_not_contains(const char *haystack, const char *needle, const char *label) {
    if (strstr(haystack, needle)) {
        fprintf(stderr, "unexpected %s: %s\n", label, needle);
        exit(1);
    }
}

int main(void) {
    char *c = read_file("../STM32CubeExpansion_LRWAN/Drivers/BSP/Components/iwdg/iwdg.c");
    char *h = read_file("../STM32CubeExpansion_LRWAN/Drivers/BSP/Components/iwdg/iwdg.h");

    assert_contains(c, "#define LSI_FALLBACK_HZ", "fallback LSI frequency constant");
    assert_contains(c, "#define LSI_CAPTURE_TIMEOUT_MS", "capture timeout constant");
    assert_contains(c, "TimerGetCurrentTime()", "timeout start timestamp");
    assert_contains(c, "TimerGetElapsedTime(captureStart)", "bounded capture wait");
    assert_contains(c, "return LSI_FALLBACK_HZ;", "fallback return path");
    assert_not_contains(c, "while(uwCaptureNumber != 2)\n  {\n  }", "unbounded capture wait");
    assert_not_contains(h, "static uint32_t GetLSIFrequency(void);", "private static prototype in public header");

    free(c);
    free(h);
    return 0;
}
```

- [ ] **Step 3: Wire the new test**

In `tests/Makefile`, change:

```make
TESTS := harness_smoke chameleon_payload chameleon_driver chameleon_dummy battery_level_typo chameleon_fdr_defaults
```

to:

```make
TESTS := harness_smoke chameleon_payload chameleon_driver chameleon_dummy battery_level_typo chameleon_fdr_defaults iwdg_guard
```

Add this target after `test_chameleon_fdr_defaults`:

```make
$(OBJDIR)/test_iwdg_guard: test_iwdg_guard.c | $(OBJDIR)
	$(CC) $(CFLAGS) -o $@ test_iwdg_guard.c
```

- [ ] **Step 4: Run failing firmware tests**

Run:

```bash
cd /home/phil/Repos/LoRa_STM32-claude
make -C tests
```

Expected: FAIL. `test_chameleon_fdr_defaults` fails on the missing negative-ack branch, and `test_iwdg_guard` fails on the unbounded IWDG capture wait.

---

### Task 2: Firmware Implementation

**Files:**
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Drivers/BSP/Components/iwdg/iwdg.c`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Drivers/BSP/Components/iwdg/iwdg.h`
- Modify: `/home/phil/Repos/LoRa_STM32-claude/STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN(AT)/src/main.c`

- [ ] **Step 1: Remove private static prototype from header**

In `iwdg.h`, remove:

```c
static uint32_t GetLSIFrequency(void);
```

Keep:

```c
void iwdg_init(void);
void IWDG_Refresh(void);
```

- [ ] **Step 2: Add IWDG fallback constants**

In `iwdg.c`, after the global capture variables:

```c
__IO uint32_t uwCaptureNumber = 0;
```

add:

```c
#define LSI_FALLBACK_HZ          37000U
#define LSI_CAPTURE_TIMEOUT_MS   100U
```

- [ ] **Step 3: Make LSI measurement bounded**

Replace the unbounded wait in `GetLSIFrequency()`:

```c
  /* Wait until the TIM21 get 2 LSI edges */
  while(uwCaptureNumber != 2)
  {
  }
```

with:

```c
  /* Wait until TIM21 captures 2 LSI edges. If the capture interrupt path fails,
   * fall back instead of hanging before LoRa init. */
  uint32_t captureStart = TimerGetCurrentTime();
  while(uwCaptureNumber != 2)
  {
    if (TimerGetElapsedTime(captureStart) >= LSI_CAPTURE_TIMEOUT_MS)
    {
      HAL_TIM_IC_Stop_IT(&Input_Handle, TIM_CHANNEL_1);
      HAL_TIM_IC_DeInit(&Input_Handle);
      uwCaptureNumber = 0;
      return LSI_FALLBACK_HZ;
    }
  }
```

Leave the existing successful stop/deinit and `return uwLsiFreq;` path in place.

- [ ] **Step 4: Negative-ack unsupported Chameleon MOD downlinks**

In `main.c` case `0x0A`, replace the `USE_CHAMELEON` branch:

```c
#ifdef USE_CHAMELEON
						if(AppData->Buff[1]==0x03)
						{
							mode=0x03;
							EEPROM_Store_Config();
							atz_flags=1;
							rxpr_flags=1;
						}
#else
```

with:

```c
#ifdef USE_CHAMELEON
						if(AppData->Buff[1]==0x03)
						{
							mode=0x03;
							EEPROM_Store_Config();
							atz_flags=1;
							rxpr_flags=1;
						}
						else
						{
							PPRINTF("Chameleon firmware supports MOD=3 only\r\n");
							rxpr_flags=0;
						}
#else
```

Do not set `atz_flags` or call `EEPROM_Store_Config()` in the rejection branch.

- [ ] **Step 5: Verify firmware tests and build**

Run:

```bash
cd /home/phil/Repos/LoRa_STM32-claude
make -C tests
./build/build.sh chameleon
arm-none-eabi-size build/LSN50-chameleon.elf
sha256sum build/LSN50-chameleon.hex build/LSN50-chameleon.bin build/LSN50-chameleon.elf
git status --short
```

Expected:

- Host tests pass.
- ARM build succeeds.
- Size remains below STM32L072 limits: flash under 192 KiB, RAM under 20 KiB.
- Only intended source/test/build artifact changes are present.

- [ ] **Step 6: Commit firmware**

Run:

```bash
cd /home/phil/Repos/LoRa_STM32-claude
git add STM32CubeExpansion_LRWAN/Drivers/BSP/Components/iwdg/iwdg.c \
        STM32CubeExpansion_LRWAN/Drivers/BSP/Components/iwdg/iwdg.h \
        STM32CubeExpansion_LRWAN/Projects/Multi/Applications/LoRa/DRAGINO-LRWAN\(AT\)/src/main.c \
        tests/test_chameleon_fdr_defaults.c \
        tests/test_iwdg_guard.c \
        tests/Makefile \
        build/LSN50-chameleon.hex \
        build/LSN50-chameleon.bin \
        build/LSN50-chameleon.elf \
        build/LSN50-chameleon.map
git commit -m "fix: harden chameleon firmware boot and mod downlink"
```

---

### Task 3: OSI OS Edge Persistence

**Files:**
- Modify: `/home/phil/Repos/osi-os/scripts/verify-lsn50-chameleon-persistence.js`
- Modify: `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: six bundled SQLite seed DB files listed in the file map.

- [ ] **Step 1: Update persistence verifier first**

In `scripts/verify-lsn50-chameleon-persistence.js`, add after the existing schema assertions:

```js
assertIncludes(syncInit, 'data_invalid INTEGER DEFAULT 0', 'schema creates chameleon_readings.data_invalid');
assertIncludes(chameleonInsert, 'const statusFlags = toInt(d.chameleonStatusFlags);', 'insert normalizes status flags once');
assertIncludes(chameleonInsert, 'const dataInvalidFlag = dataInvalid ? 1 : 0;', 'insert stores computed data_invalid');
assertIncludes(chameleonInsert, "statusFlags == null ? 'grey' : (statusFlags ? 'yellow' : 'green')", 'insert status handles unknown flags');
```

Update the normal insert expectations:

```js
assert.strictEqual(normal.writes[0].params.length, 27, 'normal write uses all insert parameters');
assert.strictEqual(normal.writes[0].params[4], 0, 'data_invalid is stored for valid data');
assert.strictEqual(normal.writes[0].params[5], 0, 'i2c_missing flag is persisted');
```

Shift later parameter indexes by one after `status_flags`, because `data_invalid` becomes parameter index `4`.

Add a status assertion after the normal write:

```js
assert.deepStrictEqual(normal.statuses[0], { fill: 'green', shape: 'dot', text: 'Chameleon stored a84041ffffffffff' }, 'valid flags show green status');
```

Update the V2 invalid expectations:

```js
assert.strictEqual(v2Invalid.writes[0].params[3], 1, 'v2 simplified status_flags stores data-invalid bit');
assert.strictEqual(v2Invalid.writes[0].params[4], 1, 'v2 data_invalid column stores computed invalid state');
assert.strictEqual(v2Invalid.writes[0].params[5], null, 'v2 i2c_missing remains NULL when not sent');
assert.strictEqual(v2Invalid.writes[0].params[6], null, 'v2 timeout remains NULL when not sent');
assert.deepStrictEqual(v2Invalid.statuses[0], { fill: 'yellow', shape: 'dot', text: 'Chameleon stored a84041ffffffffff' }, 'nonzero flags show yellow status');
```

Add an unknown-flags fixture:

```js
const unknownFlagsMsg = JSON.parse(JSON.stringify(normalMsg));
unknownFlagsMsg.formattedData.chameleonStatusFlags = null;
const unknownFlags = await runFunctionNode('chameleon-readings-insert-fn', unknownFlagsMsg);
assert.strictEqual(unknownFlags.writes[0].params[3], null, 'unknown status_flags stores NULL');
assert.strictEqual(unknownFlags.writes[0].params[4], 0, 'unknown flags with valid data stores data_invalid=0');
assert.deepStrictEqual(unknownFlags.statuses[0], { fill: 'grey', shape: 'dot', text: 'Chameleon stored a84041ffffffffff' }, 'unknown flags show grey status');
```

- [ ] **Step 2: Update seed DB verifier**

In `scripts/verify-sync-flow.js`, add after the `f_cnt` assertion inside the `for (const seedDatabasePath of seedDatabasePaths)` Chameleon block:

```js
expectCondition(
  chameleonColumns.has('data_invalid'),
  `${relativeSeedPath} includes data_invalid in the bundled chameleon_readings schema`,
  `${relativeSeedPath} is missing data_invalid in the bundled chameleon_readings schema`
);
```

- [ ] **Step 3: Run failing edge verifiers**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-sync-flow.js
```

Expected: FAIL on missing `data_invalid` schema/insert/status behavior.

- [ ] **Step 4: Update Node-RED schema and insert**

In `flows.json` function node `sync-init-fn`, update the `CREATE TABLE IF NOT EXISTS chameleon_readings` SQL to include:

```sql
data_invalid INTEGER DEFAULT 0
```

immediately after `status_flags INTEGER`.

Add an idempotent migration entry:

```sql
ALTER TABLE chameleon_readings ADD COLUMN data_invalid INTEGER DEFAULT 0
```

In `chameleon-readings-insert-fn`, replace:

```js
const dataInvalid = toInt(d.chameleonDataInvalid) === 1 || toInt(d.chameleonI2cMissing) === 1 || toInt(d.chameleonTimeout) === 1;
```

with:

```js
const statusFlags = toInt(d.chameleonStatusFlags);
const dataInvalid = toInt(d.chameleonDataInvalid) === 1 || toInt(d.chameleonI2cMissing) === 1 || toInt(d.chameleonTimeout) === 1;
const dataInvalidFlag = dataInvalid ? 1 : 0;
```

Update the insert SQL column list from:

```sql
status_flags,i2c_missing,timeout
```

to:

```sql
status_flags,data_invalid,i2c_missing,timeout
```

Update the values placeholder count from `26` to `27`.

Update the parameter list from:

```js
toInt(d.chameleonStatusFlags),
toInt(d.chameleonI2cMissing),
```

to:

```js
statusFlags,
dataInvalidFlag,
toInt(d.chameleonI2cMissing),
```

Replace the node status:

```js
node.status({ fill: d.chameleonStatusFlags ? 'yellow' : 'green', shape: 'dot', text: 'Chameleon stored ' + d.devEui });
```

with:

```js
node.status({ fill: statusFlags == null ? 'grey' : (statusFlags ? 'yellow' : 'green'), shape: 'dot', text: 'Chameleon stored ' + d.devEui });
```

- [ ] **Step 5: Include `data_invalid` in edge sync payload**

In the `CHAMELEON_READING_APPENDED` outbox trigger/payload in `sync-init-fn`, add:

```sql
'data_invalid', NEW.data_invalid
```

immediately after:

```sql
'status_flags', NEW.status_flags
```

This keeps the server mirror aligned without changing existing V1/V2 decoder behavior.

- [ ] **Step 6: Patch bundled SQLite seed DBs**

Run this exact loop:

```bash
cd /home/phil/Repos/osi-os
for db in \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do
  sqlite3 "$db" "ALTER TABLE chameleon_readings ADD COLUMN data_invalid INTEGER DEFAULT 0;" 2>/dev/null || true
done
```

- [ ] **Step 7: Verify edge**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-sync-flow.js
```

Expected: all pass.

- [ ] **Step 8: Commit OSI OS**

Run:

```bash
cd /home/phil/Repos/osi-os
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        database/farming.db \
        web/react-gui/farming.db \
        scripts/verify-lsn50-chameleon-persistence.js \
        scripts/verify-sync-flow.js \
        docs/superpowers/plans/2026-05-15-chameleon-v2-hardening-and-sync.md
git commit -m "fix: persist chameleon data-invalid status"
```

---

### Task 4: OSI Server Mirror

**Files:**
- Create: `/home/phil/Repos/osi-server/backend/src/main/resources/db/migration/V41__chameleon_data_invalid.sql`
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/analytics/ChameleonReading.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/sync/EdgeSyncServiceDataPlaneTest.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/sync/EdgeSyncServiceBootstrapTest.java`

- [ ] **Step 1: Update server tests first**

In `EdgeSyncServiceDataPlaneTest`, extend the Chameleon event payload:

```java
"swt_1", 12.3,
"data_invalid", true,
"i2c_missing", false
```

Add assertion after `isI2cMissing()`:

```java
assertThat(captor.getValue().isDataInvalid()).isTrue();
```

In `EdgeSyncServiceBootstrapTest`, extend the bootstrap Chameleon reading payload:

```java
"swt_1", 12.3,
"data_invalid", true,
"i2c_missing", false
```

Add the same assertion:

```java
assertThat(captor.getValue().isDataInvalid()).isTrue();
```

- [ ] **Step 2: Run failing server tests**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest
```

Expected: FAIL because `ChameleonReading` has no `dataInvalid` property yet.

- [ ] **Step 3: Add Flyway migration**

Create `backend/src/main/resources/db/migration/V41__chameleon_data_invalid.sql`:

```sql
-- V41: persist consolidated Chameleon V2 data-invalid status

ALTER TABLE chameleon_readings
    ADD COLUMN IF NOT EXISTS data_invalid BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 4: Add JPA field**

In `ChameleonReading.java`, after `statusFlags` add:

```java
    @Column(name = "data_invalid", nullable = false)
    @Builder.Default
    private boolean dataInvalid = false;
```

- [ ] **Step 5: Map sync payload field**

In `EdgeSyncService.upsertChameleonReading`, after `setStatusFlags(...)`, add:

```java
        reading.setDataInvalid(boolAny(payload, false, "data_invalid", "dataInvalid", "Chameleon_Data_Invalid"));
```

- [ ] **Step 6: Verify server**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest
```

Expected: PASS.

- [ ] **Step 7: Commit OSI Server**

Run:

```bash
cd /home/phil/Repos/osi-server
git add backend/src/main/resources/db/migration/V41__chameleon_data_invalid.sql \
        backend/src/main/java/org/osi/server/analytics/ChameleonReading.java \
        backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
        backend/src/test/java/org/osi/server/sync/EdgeSyncServiceDataPlaneTest.java \
        backend/src/test/java/org/osi/server/sync/EdgeSyncServiceBootstrapTest.java
git commit -m "fix: mirror chameleon data-invalid status"
```

---

### Task 5: Final Cross-Repo Verification

**Files:** no additional files.

- [ ] **Step 1: Firmware verification**

Run:

```bash
cd /home/phil/Repos/LoRa_STM32-claude
make -C tests
./build/build.sh chameleon
arm-none-eabi-size build/LSN50-chameleon.elf
```

Expected: tests/build pass and size remains within STM32L072 limits.

- [ ] **Step 2: Edge verification**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-sync-flow.js
git status --short --branch
```

Expected: all verifiers pass. Working tree only contains intentional changes before commit, then clean after commit.

- [ ] **Step 3: Server verification**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest
```

Expected: PASS.

- [ ] **Step 4: Flashing/deploy notes**

Before flashing another LSN50:

```bash
cd /home/phil/Repos/LoRa_STM32-claude
sha256sum build/LSN50-chameleon.hex
head -n 2 build/LSN50-chameleon.hex
```

Expected: first line is an Intel HEX extended linear address for `0x0800`:

```text
:020000040800F2
```

Use the `.hex` artifact for ST-LINK flashing unless the flashing tool explicitly sets `.bin` base address to `0x08000000`.

## Self-Review

- Spec coverage: all findings are covered: firmware downlink negative ack, IWDG no-boot risk, bad IWDG header warning, edge `data_invalid`, Node-RED status color, server mirror.
- Placeholder scan: no `TBD`, `TODO`, or "add tests" placeholders are present.
- Type consistency: edge uses `data_invalid` SQL/JSON and `chameleonDataInvalid` internal formatted data; server accepts `data_invalid`, `dataInvalid`, and `Chameleon_Data_Invalid`.

