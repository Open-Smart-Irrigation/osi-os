# Valve Control Module (Edge, Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the "Valve control" dashboard module on the edge: cross-zone valve tiles with Open + Schedule, weekly schedules compiled into the STREGA valve's own scheduler (Gen1 live, Gen2 encoder unit-tested), gateway-fired one-time opens, clock sync, skip-today, observed on-valve runs in Recent irrigations, and the rename of the threshold scheduler to "Trigger-based irrigation".

**Architecture:** All logic lives in a new seam module `osi-valve-control` (pure plan compiler/encoder, HTTP router, ACK/observe/once workers) loaded through `osi-lib`; flows.json gains only thin (< 4 KB) nodes that delegate to it, additive to existing wiring (new http-in nodes, a new mqtt-in for ACKs, a new mqtt-out for plan pushes, a new link-out into the existing actuator link-in for one-time opens). Schema goes through one additive ordered migration. The GUI adds a `ValveControlPanel` section with tiles, two dialogs, a five-state glyph, and a `valves` i18n namespace.

**Tech Stack:** Node-RED function nodes + CommonJS seam modules (Node 18+, `node:test`), SQLite via `osi-db-helper` facade, ChirpStack MQTT downlinks + gRPC queue flush (`osi-chirpstack-helper`), React 18 + TypeScript + SWR + i18next + Tailwind tokens, vitest + tsx test runner.

**Spec:** `docs/superpowers/specs/2026-08-19-valve-control-design.md` (read it first; research in `docs/ux/timed-valve-control-research-brief.md`; vendor byte reference in `docs/hardware/strega-codecs/`).

## Global Constraints

- flows.json is edited ONLY by a one-shot Node script with the roundtrip guard (skill `osi-flows-json-editing`); canonical `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, mirror `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`, byte-identical.
- New function nodes must be thin: ≤ 4096 chars, no SQL literal > 400 chars, logic via `osiLib.require('osi-valve-control')`. Existing nodes may not grow except via an entry in `scripts/verify-flows-size-ratchet-allowances.json` with a reason.
- Schema changes: one additive ordered migration `0022__valve_control.sql` (next after `0021`), `-- risk: additive` header, mirrored in `database/seed-blank.sql` and all 7 bundled `farming.db` copies (skill `osi-schema-change-control`).
- STREGA: only `OPEN_FOR_DURATION` (FPort 2 `0x41 NN`, 1–255 min) or scheduler windows open a valve. Never bare `OPEN`/`CLOSE`. Never FPort 21 `'3'` (see spec §9 for the single GEN2 exception, not implemented in this plan).
- The gateway never re-pushes a plan on a timer. Plan pushes happen only on a user change or `POST /api/valves/:deveui/plan/resend`.
- Weekday bit order everywhere: bit0 = Sunday … bit6 = Saturday (STREGA order). `start_time` is `HH:MM` 24 h.
- Missing data stays `null`; litres are shown only when a flow rate is known.
- Verification commands are run fresh in the branch; old outputs are not evidence. Frontend build is memory-heavy on this workstation: never run two `npm run build` concurrently (see memory `feedback_frontend_build_memory_pressure`).
- Copy/strings: `docs/` prose passes `node .claude/skills/anti-slop-writing/slop-check.js`.
- Commit after every task; do not push unless asked.

## File map

| Path | Responsibility |
|---|---|
| `database/migrations/ordered/0022__valve_control.sql` | New tables `valve_schedules`, `valve_settings`, `valve_schedule_pushes`; `valve_actuation_expectations.trigger`; sync triggers for `valve_schedules`. |
| `database/seed-blank.sql` | Same DDL appended. |
| `scripts/verify-db-schema-consistency.js` | Contract entries for the three tables + new column. |
| `conf/.../node-red/osi-valve-control/package.json`, `index.js` | Module entry; re-exports. |
| `conf/.../node-red/osi-valve-control/plan.js` | Pure: window compile, validation, GEN1/GEN2 encoding, plan hash, next-run, DST-aware local time, FPort 12 clock payload. |
| `conf/.../node-red/osi-valve-control/ack.js` | Pure: map decoded STREGA uplink fields (`Schl_Port`, `Schl_status_Port`, `RTC_Port`, Gen2 ACK) to push/setting updates; Gen2 detection. |
| `conf/.../node-red/osi-valve-control/store.js` | SQL access: schedules, settings, pushes, expectations (uses the `osi-db-helper` facade, promise-wrapped). |
| `conf/.../node-red/osi-valve-control/push.js` | Compile-and-queue: diff vs last pushes, build MQTT downlink messages, flush decision, clock-sync queueing. |
| `conf/.../node-red/osi-valve-control/api.js` | `handleHttpRequest` router for `/api/valves*` (bearer auth copied from `osi-journal/api.js`). |
| `conf/.../node-red/osi-valve-control/workers.js` | `runOnceTick`, `runObserveTick`, `runPushTimeouts`, `runClockSyncTick`, `handleUplink`. |
| `conf/.../node-red/osi-valve-control/*.test.js` | `node:test` suites with vendor golden vectors. |
| `conf/.../node-red/osi-lib/index.js` + `index.test.js`, `node-red/package.json` + `package-lock.json`, `conf/.../etc/uci-defaults/98_osi_node_red_seed`, `deploy.sh` | Helper registration (4 surfaces, `scripts/verify-helper-registration.js`). |
| `flows.json` (both profiles) | New tab `valve-control-tab`: http-in ×9 → `valve-api-router-fn` → http response; `valve-push-emit-fn` → mqtt out; `valve-ack-mqtt-in` → `valve-ack-fn`; `valve-once-tick` → `valve-once-fn` → link out → actuator link-in; `valve-observe-tick` → `valve-observe-fn`; `valve-clock-tick` → `valve-clock-fn`. `get-actuations-query` gains `trigger`. |
| `scripts/test-flows-wiring.js` | Pins for the new wiring. |
| `scripts/verify-flows-size-ratchet-allowances.json` | Allowance for `get-actuations-query`. |
| `web/react-gui/src/types/farming.ts`, `src/services/api.ts` | `ValveSummary`, `ValveSchedule`, `valvesAPI`. |
| `web/react-gui/src/utils/displayPreferences.ts`, `src/pages/SettingsPage.tsx` | `valveControl` module toggle. |
| `web/react-gui/src/components/farming/valves/{ValveControlPanel,ValveTile,ValveGlyph,ValveOpenDialog,ValveScheduleDialog,valveState}.tsx/.ts` | The module UI. |
| `web/react-gui/src/pages/FarmingDashboard.tsx` | Mounts the panel between zones and Recent irrigations. |
| `web/react-gui/src/components/farming/IrrigationOutcomesPanel.tsx` | Trigger label per row. |
| `web/react-gui/public/locales/*/valves.json` (7), `devices.json`, `settings.json`, `history.json` | New namespace + rename. |
| `web/react-gui/src/i18n/config.ts` | Register `valves` namespace. |
| `docs/contracts/sync-schema/{resources,events}.schema.json`, `canonicalization.md` | `ValveSchedule` resource + `VALVE_SCHEDULE_UPSERTED` op. |
| `AGENTS.md`, `docs/architecture/system-map/03-edge-backend-flows.md` | Module + rename documentation. |

Phase B (osi-server mirror, AgroLink panel, cloud→edge `UPSERT_VALVE_SCHEDULE` command routing) is a separate plan in osi-server plus a small edge follow-up; it is not in this file.

---

### Task 1: Schema migration 0022 (tables, trigger column, sync triggers)

**Files:**
- Create: `database/migrations/ordered/0022__valve_control.sql`
- Modify: `database/seed-blank.sql` (append after the `valve_actuation_expectations` block, before the trigger section), `scripts/verify-db-schema-consistency.js`
- Regenerate: the 7 bundled `farming.db` copies

**Interfaces:**
- Produces: tables `valve_schedules`, `valve_settings`, `valve_schedule_pushes`; column `valve_actuation_expectations.trigger`; triggers `trg_sync_valve_schedules_outbox_ai`, `trg_sync_valve_schedules_outbox_au` emitting aggregate `VALVE_SCHEDULE`, op `VALVE_SCHEDULE_UPSERTED`, key `schedule_uuid`.

- [ ] **Step 1: Confirm the next migration number and baseline verifiers are green**

Run:
```bash
ls database/migrations/ordered/ | tail -3
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-db-schema-consistency.js
```
Expected: `0021__journal_plot_lookup_indexes.sql` is the highest; all three print OK.

- [ ] **Step 2: Write the migration**

Create `database/migrations/ordered/0022__valve_control.sql`:

```sql
-- risk: additive
-- 0022: Valve control module (spec docs/superpowers/specs/2026-08-19-valve-control-design.md).
-- Weekly schedules compiled into the STREGA on-valve scheduler, per-valve settings,
-- downlink push tracking, and a trigger column on actuation expectations.

CREATE TABLE IF NOT EXISTS valve_schedules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_uuid    TEXT NOT NULL UNIQUE,
  device_eui       TEXT NOT NULL REFERENCES devices(deveui) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('WEEKLY','ONCE')),
  label            TEXT,
  weekdays_mask    INTEGER,
  start_time       TEXT,
  fire_at          TEXT,
  duration_minutes INTEGER NOT NULL,
  timezone         TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  once_state       TEXT CHECK (once_state IN ('PENDING','FIRED','SKIPPED','CANCELLED')),
  once_fired_at    TEXT,
  sync_version     INTEGER DEFAULT 0,
  deleted_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'WEEKLY' AND weekdays_mask BETWEEN 1 AND 127 AND start_time IS NOT NULL
      AND duration_minutes BETWEEN 1 AND 1439)
    OR
    (kind = 'ONCE' AND fire_at IS NOT NULL AND duration_minutes BETWEEN 1 AND 255)
  )
);
CREATE INDEX IF NOT EXISTS idx_valve_schedules_device ON valve_schedules(device_eui, deleted_at);
CREATE INDEX IF NOT EXISTS idx_valve_schedules_once_due
  ON valve_schedules(fire_at) WHERE kind = 'ONCE' AND once_state = 'PENDING' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS valve_settings (
  device_eui                TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
  strega_generation         TEXT NOT NULL DEFAULT 'GEN1' CHECK (strega_generation IN ('GEN1','GEN2')),
  flow_rate_lpm             REAL,
  flow_rate_source          TEXT CHECK (flow_rate_source IS NULL OR flow_rate_source IN ('measured','estimated')),
  flow_rate_updated_at      TEXT,
  default_open_minutes      INTEGER CHECK (default_open_minutes IS NULL OR default_open_minutes BETWEEN 1 AND 255),
  scheduler_status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (scheduler_status IN ('ACTIVE','SKIP_TODAY','DEACTIVATED')),
  skip_today_date           TEXT,
  last_clock_sync_queued_at TEXT,
  last_clock_sync_acked_at  TEXT,
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS valve_schedule_pushes (
  push_id      TEXT PRIMARY KEY,
  device_eui   TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS','CLOCK_SYNC')),
  weekday      INTEGER,
  fport        INTEGER NOT NULL,
  payload_hex  TEXT NOT NULL,
  plan_hash    TEXT,
  state        TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','ACKED','FAILED','SUPERSEDED')),
  ack_status   INTEGER,
  queued_at    TEXT NOT NULL DEFAULT (datetime('now')),
  acked_at     TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_valve_schedule_pushes_device_state ON valve_schedule_pushes(device_eui, state);

ALTER TABLE valve_actuation_expectations ADD COLUMN trigger TEXT;

-- Sync: valve schedules are a cloud-visible aggregate (VALVE_SCHEDULE).
CREATE TRIGGER IF NOT EXISTS trg_sync_valve_schedules_outbox_ai
AFTER INSERT ON valve_schedules
FOR EACH ROW
BEGIN
  UPDATE valve_schedules
  SET sync_version = CASE WHEN COALESCE(sync_version,0)=0 THEN 1 ELSE sync_version END
  WHERE id = NEW.id;
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  )
  SELECT
    lower(hex(randomblob(16))), 'VALVE_SCHEDULE', NEW.schedule_uuid, 'VALVE_SCHEDULE_UPSERTED',
    json_object(
      'contract_version', 1,
      'schedule_uuid',    NEW.schedule_uuid,
      'device_eui',       NEW.device_eui,
      'kind',             NEW.kind,
      'label',            NEW.label,
      'weekdays_mask',    NEW.weekdays_mask,
      'start_time',       NEW.start_time,
      'fire_at',          NEW.fire_at,
      'duration_minutes', NEW.duration_minutes,
      'timezone',         NEW.timezone,
      'enabled',          NEW.enabled,
      'once_state',       NEW.once_state,
      'sync_version',     CASE WHEN COALESCE(NEW.sync_version,0)=0 THEN 1 ELSE NEW.sync_version END,
      'deleted_at',       NEW.deleted_at
    ),
    CASE WHEN COALESCE(NEW.sync_version,0)=0 THEN 1 ELSE NEW.sync_version END,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM devices WHERE deveui = NEW.device_eui)
  WHERE EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1);
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_valve_schedules_outbox_au
AFTER UPDATE ON valve_schedules
FOR EACH ROW
WHEN
  EXISTS (SELECT 1 FROM sync_link_state WHERE peer_node = 'cloud' AND linked = 1)
  AND (
    COALESCE(NEW.kind,'') <> COALESCE(OLD.kind,'') OR
    COALESCE(NEW.label,'') <> COALESCE(OLD.label,'') OR
    COALESCE(NEW.weekdays_mask,0) <> COALESCE(OLD.weekdays_mask,0) OR
    COALESCE(NEW.start_time,'') <> COALESCE(OLD.start_time,'') OR
    COALESCE(NEW.fire_at,'') <> COALESCE(OLD.fire_at,'') OR
    COALESCE(NEW.duration_minutes,0) <> COALESCE(OLD.duration_minutes,0) OR
    COALESCE(NEW.timezone,'') <> COALESCE(OLD.timezone,'') OR
    COALESCE(NEW.enabled,0) <> COALESCE(OLD.enabled,0) OR
    COALESCE(NEW.once_state,'') <> COALESCE(OLD.once_state,'') OR
    COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'') OR
    COALESCE(NEW.sync_version,0) <> COALESCE(OLD.sync_version,0)
  )
BEGIN
  INSERT INTO sync_outbox(
    event_uuid, aggregate_type, aggregate_key, op, payload_json,
    sync_version, occurred_at, gateway_device_eui
  ) VALUES (
    lower(hex(randomblob(16))), 'VALVE_SCHEDULE', NEW.schedule_uuid, 'VALVE_SCHEDULE_UPSERTED',
    json_object(
      'contract_version', 1,
      'schedule_uuid',    NEW.schedule_uuid,
      'device_eui',       NEW.device_eui,
      'kind',             NEW.kind,
      'label',            NEW.label,
      'weekdays_mask',    NEW.weekdays_mask,
      'start_time',       NEW.start_time,
      'fire_at',          NEW.fire_at,
      'duration_minutes', NEW.duration_minutes,
      'timezone',         NEW.timezone,
      'enabled',          NEW.enabled,
      'once_state',       NEW.once_state,
      'sync_version',     NEW.sync_version,
      'deleted_at',       NEW.deleted_at
    ),
    NEW.sync_version,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    (SELECT gateway_device_eui FROM devices WHERE deveui = NEW.device_eui)
  );
END;
```

Before committing, open `database/seed-blank.sql` around the `trg_sync_schedules_outbox_au` trigger (≈ line 1364) and confirm the `sync_outbox` column list used there is exactly `event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui`; if the seed's column list differs, match the seed, not this plan.

- [ ] **Step 3: Mirror the DDL into `database/seed-blank.sql`**

Append the three `CREATE TABLE` + index statements right after the `idx_valve_act_exp_effect_key` index (≈ line 1014), and add `trigger TEXT` as the last column of `CREATE TABLE valve_actuation_expectations` (after `valve_channel INTEGER`, keep the odd `, valve_channel INTEGER);` formatting by turning it into `, valve_channel INTEGER, trigger TEXT);`). Append the two triggers after `trg_sync_schedules_outbox_au`.

- [ ] **Step 4: Regenerate the 7 bundled DBs**

```bash
MIGRATION=database/migrations/ordered/0022__valve_control.sql
cd "$(git rev-parse --show-toplevel)" && for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do sqlite3 -bail "$db" < "$MIGRATION" && echo "OK $db"; done \
  && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  && echo "OK mirror copy"
```

- [ ] **Step 5: Extend the schema contract**

In `scripts/verify-db-schema-consistency.js`, add to the hand-maintained contract (find the object that lists tables → required columns; follow the existing entry shape exactly):

```js
valve_schedules: ['id','schedule_uuid','device_eui','kind','label','weekdays_mask','start_time','fire_at','duration_minutes','timezone','enabled','once_state','once_fired_at','sync_version','deleted_at','created_at','updated_at'],
valve_settings: ['device_eui','strega_generation','flow_rate_lpm','flow_rate_source','flow_rate_updated_at','default_open_minutes','scheduler_status','skip_today_date','last_clock_sync_queued_at','last_clock_sync_acked_at','updated_at'],
valve_schedule_pushes: ['push_id','device_eui','purpose','weekday','fport','payload_hex','plan_hash','state','ack_status','queued_at','acked_at','error'],
valve_actuation_expectations: ['expectation_id','device_eui','zone_id','command_id','effect_key','commanded_at','commanded_duration_seconds','expected_close_at','reconciliation_state','trigger'],
```
and `idx_valve_schedules_device`, `idx_valve_schedules_once_due`, `idx_valve_schedule_pushes_device_state` to the required-index list; add `trg_sync_valve_schedules_outbox_au` to the required-trigger-fragment list (fragment `'VALVE_SCHEDULE_UPSERTED'`).

- [ ] **Step 6: Run the verifier set**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/test-journal-schema.js
```
Expected: each prints its OK line (`verify-seed-replay: OK`, all 7 paths `OK` + `DB schema consistency verification passed`, `All parity checks passed.`). If `verify-runtime-schema-parity.js` complains that the boot node lacks the new triggers, read its message: it compares the boot node's trigger SET against the seed — new sync triggers that only exist in the seed are the established precedent for migration-delivered triggers (check how `0019`/`0020` handled their triggers and follow that precedent; do NOT add DDL to `sync-init-fn`).

- [ ] **Step 7: Commit**

```bash
git add database/migrations/ordered/0022__valve_control.sql database/seed-blank.sql scripts/verify-db-schema-consistency.js \
  conf/*/files/usr/share/db/farming.db database/farming.db web/react-gui/farming.db
git commit -m "schema: valve control tables, expectation trigger column, VALVE_SCHEDULE sync triggers (0022)"
```

---

### Task 2: `osi-valve-control/plan.js` — pure compiler, encoders, next-run

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/package.json`, `index.js`, `plan.js`, `plan.test.js`

**Interfaces (produces):**
```js
// plan.js
compileWindows(schedules)            // [{kind:'WEEKLY', weekdays_mask, start_time, duration_minutes, enabled, schedule_uuid, label}] -> { days: Array(7) of [{onH,onM,offH,offM,scheduleUuid,label}], errors: [{code, weekday, conflicts:[uuid]}] }
encodeGen1Day(windows)               // [{onH,onM,offH,offM}] (≤4) -> Buffer(24)
encodeGen2(daymask, windows)         // (int 0..0x7F|0x80, windows ≤4) -> Buffer(1 + 4*n)
gen2Groups(days)                     // days from compileWindows -> [{daymask, windows}]
planHash(windows)                    // sha1 hex of canonical window list
gen1ClockPayload(date, timeZone)     // -> Buffer(14) FPort 12 digits, local time
weekdayLocal(date, timeZone)         // -> 0..6 (Sun=0) in that zone
localParts(date, timeZone)           // -> {year,month,day,hour,minute,second,weekday}
nextRun(schedules, now, timeZoneFallback) // -> {at: ISO, kind:'WEEKLY'|'ONCE', minutes, scheduleUuid} | null
isDstTransitionWithin(timeZone, fromMs, toMs) // boolean
validateScheduleInput(body)          // -> {ok:true, value} | {ok:false, status:422|400, error, details}
WEEKDAY_FPORT_BASE = 14; GEN2_SCHEDULER_FPORT = 25; STATUS_FPORT = 21; CLOCK_FPORT = 12; CLOCK_REQ_FPORT = 13
```

- [ ] **Step 1: Module scaffold**

`package.json`:
```json
{
  "name": "osi-valve-control",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
```
`index.js` (extended in later tasks):
```js
'use strict';
const plan = require('./plan');
module.exports = { ...plan };
```

- [ ] **Step 2: Write the failing tests with vendor golden vectors**

`plan.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./plan');

const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();

test('GEN1 day encoding matches vendor example (Sun 08:30-08:45, 23:05-00:10)', () => {
  const buf = P.encodeGen1Day([{ onH: 8, onM: 30, offH: 8, offM: 45 }, { onH: 23, onM: 5, offH: 0, offM: 10 }]);
  assert.equal(hex(buf), 'FF8830FF0845FFA305FF0010' + 'FF'.repeat(12));
  assert.equal(buf.length, 24);
});

test('GEN1 empty day is all FF', () => {
  assert.equal(hex(P.encodeGen1Day([])), 'FF'.repeat(24));
});

test('GEN2 all days 19:15-19:30 + 19:45-20:01 matches vendor example', () => {
  assert.equal(hex(P.encodeGen2(0x80, [{ onH: 19, onM: 15, offH: 19, offM: 30 }, { onH: 19, onM: 45, offH: 20, offM: 1 }])), '809915193099452001');
});

test('GEN2 Tue+Sat 06:05-10:05 matches vendor example', () => {
  assert.equal(hex(P.encodeGen2((1 << 2) | (1 << 6), [{ onH: 6, onM: 5, offH: 10, offM: 5 }])), '4486051005');
});

test('compileWindows: duration wraps past midnight and stays on start weekday', () => {
  const r = P.compileWindows([{ schedule_uuid: 'a', kind: 'WEEKLY', enabled: 1, weekdays_mask: 1, start_time: '23:05', duration_minutes: 65 }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.days[0].length, 1);
  assert.deepEqual({ onH: r.days[0][0].onH, onM: r.days[0][0].onM, offH: r.days[0][0].offH, offM: r.days[0][0].offM }, { onH: 23, onM: 5, offH: 0, offM: 10 });
  assert.equal(r.days[1].length, 0);
});

test('compileWindows: more than 4 windows on a weekday is an error naming the weekday', () => {
  const s = (i) => ({ schedule_uuid: 's' + i, kind: 'WEEKLY', enabled: 1, weekdays_mask: 2, start_time: `0${i}:00`, duration_minutes: 10 });
  const r = P.compileWindows([1, 2, 3, 4, 5].map(s));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'too_many_windows');
  assert.equal(r.errors[0].weekday, 1);
});

test('compileWindows: overlapping windows on a weekday is an error listing both uuids', () => {
  const r = P.compileWindows([
    { schedule_uuid: 'a', kind: 'WEEKLY', enabled: 1, weekdays_mask: 4, start_time: '06:00', duration_minutes: 90 },
    { schedule_uuid: 'b', kind: 'WEEKLY', enabled: 1, weekdays_mask: 4, start_time: '07:00', duration_minutes: 30 },
  ]);
  assert.equal(r.errors[0].code, 'overlap');
  assert.deepEqual(r.errors[0].conflicts.sort(), ['a', 'b']);
});

test('compileWindows ignores disabled and ONCE schedules', () => {
  const r = P.compileWindows([
    { schedule_uuid: 'a', kind: 'WEEKLY', enabled: 0, weekdays_mask: 127, start_time: '06:00', duration_minutes: 30 },
    { schedule_uuid: 'b', kind: 'ONCE', enabled: 1, fire_at: '2026-08-22T20:00:00Z', duration_minutes: 30 },
  ]);
  assert.deepEqual(r.days.map((d) => d.length), [0, 0, 0, 0, 0, 0, 0]);
});

test('gen2Groups merges identical weekdays and uses 0x80 for all-days', () => {
  const w = [{ onH: 6, onM: 0, offH: 6, offM: 30 }];
  const all = P.gen2Groups([w, w, w, w, w, w, w]);
  assert.deepEqual(all.map((g) => g.daymask), [0x80]);
  const some = P.gen2Groups([[], w, [], [], [], [], w]);
  assert.deepEqual(some.map((g) => g.daymask).sort(), [(1 << 1) | (1 << 6)]);
});

test('planHash is order-independent for equal windows and differs for different windows', () => {
  const a = [{ onH: 6, onM: 0, offH: 6, offM: 30 }, { onH: 7, onM: 0, offH: 7, offM: 30 }];
  const b = [a[1], a[0]];
  assert.equal(P.planHash(a), P.planHash(b));
  assert.notEqual(P.planHash(a), P.planHash([a[0]]));
});

test('gen1ClockPayload: 2026-08-20 01:03:44 Thu in Europe/Zurich -> 14 digits HHMMSSddDDMMYY', () => {
  // 2026-08-19T23:03:44Z == 2026-08-20 01:03:44 CEST (Thursday)
  const buf = P.gen1ClockPayload(new Date('2026-08-19T23:03:44Z'), 'Europe/Zurich');
  assert.equal(hex(buf), '0001000304040004020000080206');
});

test('localParts handles DST boundary (Europe/Zurich 2026-10-25)', () => {
  const before = P.localParts(new Date('2026-10-25T00:30:00Z'), 'Europe/Zurich'); // 02:30 CEST
  const after = P.localParts(new Date('2026-10-25T01:30:00Z'), 'Europe/Zurich');  // 02:30 CET
  assert.equal(before.hour, 2); assert.equal(after.hour, 2);
  assert.equal(P.isDstTransitionWithin('Europe/Zurich', Date.parse('2026-10-24T12:00:00Z'), Date.parse('2026-10-25T12:00:00Z')), true);
  assert.equal(P.isDstTransitionWithin('Europe/Zurich', Date.parse('2026-08-01T12:00:00Z'), Date.parse('2026-08-02T12:00:00Z')), false);
});

test('nextRun picks the earliest upcoming WEEKLY or ONCE occurrence', () => {
  const now = new Date('2026-08-19T10:00:00Z'); // Wed 12:00 CEST
  const r = P.nextRun([
    { schedule_uuid: 'w', kind: 'WEEKLY', enabled: 1, weekdays_mask: 1 << 3, start_time: '13:00', duration_minutes: 30, timezone: 'Europe/Zurich' },
    { schedule_uuid: 'o', kind: 'ONCE', enabled: 1, once_state: 'PENDING', fire_at: '2026-08-19T12:30:00Z', duration_minutes: 15, timezone: 'Europe/Zurich' },
  ], now, 'Europe/Zurich');
  assert.equal(r.kind, 'WEEKLY'); // 13:00 CEST == 11:00Z, before the ONCE at 12:30Z
  assert.equal(r.at, '2026-08-19T11:00:00.000Z');
  assert.equal(r.minutes, 30);
});

test('validateScheduleInput: WEEKLY and ONCE happy paths and rejections', () => {
  assert.equal(P.validateScheduleInput({ kind: 'WEEKLY', weekdays_mask: 3, start_time: '06:00', duration_minutes: 45 }).ok, true);
  assert.equal(P.validateScheduleInput({ kind: 'ONCE', fire_at: '2026-08-22T20:00:00Z', duration_minutes: 90 }).ok, true);
  assert.equal(P.validateScheduleInput({ kind: 'WEEKLY', weekdays_mask: 0, start_time: '06:00', duration_minutes: 45 }).ok, false);
  assert.equal(P.validateScheduleInput({ kind: 'WEEKLY', weekdays_mask: 1, start_time: '24:00', duration_minutes: 45 }).ok, false);
  assert.equal(P.validateScheduleInput({ kind: 'ONCE', fire_at: '2026-08-22T20:00:00Z', duration_minutes: 300 }).ok, false);
  assert.equal(P.validateScheduleInput({ kind: 'DAILY' }).ok, false);
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan.test.js`
Expected: FAIL, `Cannot find module './plan'`.

- [ ] **Step 4: Implement `plan.js`**

```js
'use strict';
const crypto = require('node:crypto');

const WEEKDAY_FPORT_BASE = 14; // 14=Sun .. 20=Sat (STREGA Gen1)
const GEN2_SCHEDULER_FPORT = 25;
const STATUS_FPORT = 21;
const CLOCK_FPORT = 12;
const CLOCK_REQ_FPORT = 13;
const MAX_WINDOWS_PER_DAY = 4;

function bcd(n) { return ((Math.floor(n / 10) & 0x0F) << 4) | (n % 10); }

function parseHHMM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

function windowFrom(startTime, durationMinutes, extra) {
  const t = parseHHMM(startTime);
  const startMin = t.h * 60 + t.m;
  const endMin = (startMin + durationMinutes) % 1440;
  return Object.assign({
    onH: t.h, onM: t.m, offH: Math.floor(endMin / 60), offM: endMin % 60,
    startMin, endMin: startMin + durationMinutes,
  }, extra || {});
}

function compileWindows(schedules) {
  const days = Array.from({ length: 7 }, () => []);
  const errors = [];
  for (const s of schedules || []) {
    if (!s || s.kind !== 'WEEKLY' || !Number(s.enabled) || s.deleted_at) continue;
    for (let d = 0; d < 7; d += 1) {
      if (!((Number(s.weekdays_mask) >> d) & 1)) continue;
      days[d].push(windowFrom(s.start_time, Number(s.duration_minutes), { scheduleUuid: s.schedule_uuid, label: s.label || null }));
    }
  }
  for (let d = 0; d < 7; d += 1) {
    days[d].sort((a, b) => a.startMin - b.startMin);
    if (days[d].length > MAX_WINDOWS_PER_DAY) {
      errors.push({ code: 'too_many_windows', weekday: d, count: days[d].length, conflicts: days[d].map((w) => w.scheduleUuid) });
    }
    for (let i = 1; i < days[d].length; i += 1) {
      if (days[d][i].startMin < days[d][i - 1].endMin) {
        errors.push({ code: 'overlap', weekday: d, conflicts: [days[d][i - 1].scheduleUuid, days[d][i].scheduleUuid] });
      }
    }
  }
  return { days, errors };
}

function encodeGen1Day(windows) {
  const buf = Buffer.alloc(24, 0xFF);
  (windows || []).slice(0, MAX_WINDOWS_PER_DAY).forEach((w, i) => {
    const o = i * 6;
    buf[o] = 0xFF; buf[o + 1] = 0x80 | bcd(w.onH); buf[o + 2] = bcd(w.onM);
    buf[o + 3] = 0xFF; buf[o + 4] = bcd(w.offH); buf[o + 5] = bcd(w.offM);
  });
  return buf;
}

function encodeGen2(daymask, windows) {
  const ws = (windows || []).slice(0, MAX_WINDOWS_PER_DAY);
  const buf = Buffer.alloc(1 + ws.length * 4);
  buf[0] = daymask & 0xFF;
  ws.forEach((w, i) => {
    const o = 1 + i * 4;
    buf[o] = 0x80 | bcd(w.onH); buf[o + 1] = bcd(w.onM); buf[o + 2] = bcd(w.offH); buf[o + 3] = bcd(w.offM);
  });
  return buf;
}

function canonicalWindows(windows) {
  return (windows || []).map((w) => [w.onH, w.onM, w.offH, w.offM].join(':')).sort();
}

function planHash(windows) {
  return crypto.createHash('sha1').update(canonicalWindows(windows).join('|')).digest('hex');
}

function gen2Groups(days) {
  const byHash = new Map();
  days.forEach((w, d) => {
    const key = planHash(w);
    if (!byHash.has(key)) byHash.set(key, { daymask: 0, windows: w });
    byHash.get(key).daymask |= (1 << d);
  });
  const groups = [...byHash.values()];
  return groups.map((g) => (g.daymask === 0x7F ? { daymask: 0x80, windows: g.windows } : g));
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();
function formatter(timeZone) {
  if (!fmtCache.has(timeZone)) {
    fmtCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(timeZone);
}

function localParts(date, timeZone) {
  const parts = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

function weekdayLocal(date, timeZone) { return localParts(date, timeZone).weekday; }

function gen1ClockPayload(date, timeZone) {
  const p = localParts(date, timeZone);
  const digits = [p.hour, p.minute, p.second, p.weekday, p.day, p.month, p.year % 100]
    .map((n, i) => (i === 3 ? '0' + n : String(n).padStart(2, '0'))).join('');
  return Buffer.from(digits.split('').map((c) => Number(c)));
}

function offsetMinutes(date, timeZone) {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function isDstTransitionWithin(timeZone, fromMs, toMs) {
  return offsetMinutes(new Date(fromMs), timeZone) !== offsetMinutes(new Date(toMs), timeZone);
}

// First instant >= from at which local wall-clock in timeZone equals (weekday, HH:MM).
// Nonexistent times (spring-forward gap) resolve to the first valid minute after the gap.
function nextLocalOccurrence(from, timeZone, weekday, h, m) {
  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const probe = new Date(from.getTime() + dayOffset * 86400000);
    const p = localParts(probe, timeZone);
    if (p.weekday !== weekday) continue;
    const off = offsetMinutes(probe, timeZone);
    let candidate = new Date(Date.UTC(p.year, p.month - 1, p.day, h, m) - off * 60000);
    const check = localParts(candidate, timeZone);
    if (check.hour !== h || check.minute !== m) {
      // offset changed between probe and candidate (DST); recompute with the candidate's own offset
      const off2 = offsetMinutes(candidate, timeZone);
      candidate = new Date(Date.UTC(p.year, p.month - 1, p.day, h, m) - off2 * 60000);
    }
    if (candidate.getTime() >= from.getTime() && localParts(candidate, timeZone).weekday === weekday) return candidate;
  }
  return null;
}

function nextRun(schedules, now, timeZoneFallback) {
  let best = null;
  for (const s of schedules || []) {
    if (!s || !Number(s.enabled) || s.deleted_at) continue;
    const tz = s.timezone || timeZoneFallback || 'UTC';
    let at = null;
    if (s.kind === 'ONCE') {
      if (s.once_state !== 'PENDING') continue;
      const t = Date.parse(s.fire_at);
      if (Number.isFinite(t) && t >= now.getTime()) at = new Date(t);
    } else if (s.kind === 'WEEKLY') {
      const hm = parseHHMM(s.start_time);
      if (!hm) continue;
      for (let d = 0; d < 7; d += 1) {
        if (!((Number(s.weekdays_mask) >> d) & 1)) continue;
        const c = nextLocalOccurrence(now, tz, d, hm.h, hm.m);
        if (c && (!at || c < at)) at = c;
      }
    }
    if (at && (!best || at < best.atDate)) best = { atDate: at, at: at.toISOString(), kind: s.kind, minutes: Number(s.duration_minutes), scheduleUuid: s.schedule_uuid };
  }
  if (!best) return null;
  delete best.atDate;
  return best;
}

function validateScheduleInput(body) {
  const b = body || {};
  const fail = (status, error, details) => ({ ok: false, status, error, details: details || null });
  const kind = String(b.kind || '').toUpperCase();
  const duration = Number(b.duration_minutes);
  const label = b.label == null ? null : String(b.label).slice(0, 80);
  if (kind === 'WEEKLY') {
    const mask = Number(b.weekdays_mask);
    if (!Number.isInteger(mask) || mask < 1 || mask > 127) return fail(422, 'invalid_weekdays', 'weekdays_mask must be 1..127');
    if (!parseHHMM(b.start_time)) return fail(422, 'invalid_start_time', 'start_time must be HH:MM');
    if (!Number.isInteger(duration) || duration < 1 || duration > 1439) return fail(422, 'invalid_duration', 'duration_minutes must be 1..1439');
    return { ok: true, value: { kind, weekdays_mask: mask, start_time: b.start_time, fire_at: null, duration_minutes: duration, label, enabled: b.enabled === undefined ? 1 : (b.enabled ? 1 : 0) } };
  }
  if (kind === 'ONCE') {
    const t = Date.parse(b.fire_at);
    if (!Number.isFinite(t)) return fail(422, 'invalid_fire_at', 'fire_at must be an ISO instant');
    if (!Number.isInteger(duration) || duration < 1 || duration > 255) return fail(422, 'invalid_duration', 'duration_minutes must be 1..255 for one-time opens');
    return { ok: true, value: { kind, weekdays_mask: null, start_time: null, fire_at: new Date(t).toISOString(), duration_minutes: duration, label, enabled: b.enabled === undefined ? 1 : (b.enabled ? 1 : 0) } };
  }
  return fail(422, 'invalid_kind', 'kind must be WEEKLY or ONCE');
}

module.exports = {
  WEEKDAY_FPORT_BASE, GEN2_SCHEDULER_FPORT, STATUS_FPORT, CLOCK_FPORT, CLOCK_REQ_FPORT, MAX_WINDOWS_PER_DAY,
  compileWindows, encodeGen1Day, encodeGen2, gen2Groups, planHash, gen1ClockPayload,
  localParts, weekdayLocal, offsetMinutes, isDstTransitionWithin, nextLocalOccurrence, nextRun,
  validateScheduleInput, parseHHMM,
};
```

- [ ] **Step 5: Run the tests until green**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan.test.js`
Expected: all tests pass. If the `gen1ClockPayload` vector disagrees, recheck the vendor encoder in `docs/hardware/strega-codecs/ChirpStack-STREGA-CODEC-Encoder-Gen1` (port 12 section) and fix the implementation, not the vector, unless the vector itself misreads the vendor code (document the decision in the commit message).

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/
git commit -m "feat(valve-control): pure plan compiler, STREGA Gen1/Gen2 scheduler encoders, next-run (vendor golden vectors)"
```

---

### Task 3: `ack.js` — uplink ACK mapping and Gen2 detection

**Files:**
- Create: `conf/.../node-red/osi-valve-control/ack.js`, `ack.test.js`
- Modify: `conf/.../node-red/osi-valve-control/index.js`

**Interfaces (produces):**
```js
// ack.js
interpretUplink(decoded, fPort) // decoded = object from strega codec (Gen1 fields Schl_Port/Schl_status/Schl_status_Port/Schl_status_ack/RTC_Port/RTC_status; Gen2 fields per vendor decoder)
// -> { acks: [{ purpose:'WEEKDAY_PLAN'|'DAYMASK_PLAN'|'SCHEDULER_STATUS'|'CLOCK_SYNC', fport, weekday|null, status }], generationHint: 'GEN1'|'GEN2'|null }
```

- [ ] **Step 1: Read the vendor decoders for the exact field names**

```bash
grep -n "Schl_Port\|Schl_status\|RTC_Port\|RTC_status\|Date Time Update\|Schedulers" docs/hardware/strega-codecs/ChirpStack-STREGA-CODEC-Decoder-Gen1 docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up | head -40
grep -n "Schl_Port\|RTC_Port" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/strega_gen1_decoder.js | head
```
Note the Gen2 decoder's ACK object shape (port + status naming); use those exact names in the tests below (replace `<gen2AckField>` placeholders you find with the real names; the test must match the vendor decoder).

- [ ] **Step 2: Failing tests**

`ack.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { interpretUplink } = require('./ack');

test('Gen1 scheduler ACK on port 16 maps to WEEKDAY_PLAN weekday 2', () => {
  const r = interpretUplink({ Schl_Port: 16, Schl_status: '00', Valve: '0' }, 2);
  assert.deepEqual(r.acks, [{ purpose: 'WEEKDAY_PLAN', fport: 16, weekday: 2, status: 0 }]);
  assert.equal(r.generationHint, 'GEN1');
});

test('Gen1 scheduler-status ACK (port 21) and RTC ACK (port 12)', () => {
  assert.deepEqual(interpretUplink({ Schl_status_Port: 21, Schl_status_ack: '00' }, 2).acks, [{ purpose: 'SCHEDULER_STATUS', fport: 21, weekday: null, status: 0 }]);
  assert.deepEqual(interpretUplink({ RTC_Port: 12, RTC_status: '00' }, 2).acks, [{ purpose: 'CLOCK_SYNC', fport: 12, weekday: null, status: 0 }]);
});

test('plain telemetry yields no acks', () => {
  assert.deepEqual(interpretUplink({ Battery: 87, Valve: '1' }, 2).acks, []);
});

test('Gen2 scheduler ACK on port 25 maps to DAYMASK_PLAN and hints GEN2', () => {
  // Shape per docs/hardware/strega-codecs Gen2 decoder; adjust field names to the vendor decoder output.
  const r = interpretUplink({ Ack_Port: 25, Ack_Value: 0, Ack: true }, 2);
  assert.deepEqual(r.acks, [{ purpose: 'DAYMASK_PLAN', fport: 25, weekday: null, status: 0 }]);
  assert.equal(r.generationHint, 'GEN2');
});
```

- [ ] **Step 3: Run, expect failure (module missing)**

`node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/ack.test.js`

- [ ] **Step 4: Implement `ack.js`**

```js
'use strict';
const { WEEKDAY_FPORT_BASE, GEN2_SCHEDULER_FPORT, STATUS_FPORT, CLOCK_FPORT, CLOCK_REQ_FPORT } = require('./plan');

function statusInt(v) { const n = parseInt(String(v == null ? '' : v), 16); return Number.isFinite(n) ? n : null; }

function interpretUplink(decoded, fPort) {
  const d = decoded || {};
  const acks = [];
  let generationHint = null;
  const schl = Number(d.Schl_Port);
  if (schl >= WEEKDAY_FPORT_BASE && schl <= WEEKDAY_FPORT_BASE + 6) {
    acks.push({ purpose: 'WEEKDAY_PLAN', fport: schl, weekday: schl - WEEKDAY_FPORT_BASE, status: statusInt(d.Schl_status) });
    generationHint = 'GEN1';
  }
  if (Number(d.Schl_status_Port) === STATUS_FPORT) {
    acks.push({ purpose: 'SCHEDULER_STATUS', fport: STATUS_FPORT, weekday: null, status: statusInt(d.Schl_status_ack) });
  }
  const rtc = Number(d.RTC_Port);
  if (rtc === CLOCK_FPORT || rtc === CLOCK_REQ_FPORT) {
    acks.push({ purpose: 'CLOCK_SYNC', fport: rtc, weekday: null, status: statusInt(d.RTC_status) });
  }
  // Gen2 vendor decoder exposes the echoed port on its ACK frame; field names per
  // docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up.
  const g2port = Number(d.Ack_Port);
  if (d.Ack === true && Number.isFinite(g2port)) {
    generationHint = 'GEN2';
    const status = Number.isFinite(Number(d.Ack_Value)) ? Number(d.Ack_Value) : null;
    if (g2port === GEN2_SCHEDULER_FPORT) acks.push({ purpose: 'DAYMASK_PLAN', fport: g2port, weekday: null, status });
    else if (g2port === STATUS_FPORT) acks.push({ purpose: 'SCHEDULER_STATUS', fport: g2port, weekday: null, status });
    else if (g2port === CLOCK_REQ_FPORT) acks.push({ purpose: 'CLOCK_SYNC', fport: g2port, weekday: null, status });
  }
  return { acks, generationHint };
}

module.exports = { interpretUplink };
```
Adjust the Gen2 field names (`Ack_Port`, `Ack_Value`, `Ack`) to whatever the vendor Gen2 decoder actually emits (Step 1); keep tests and implementation in agreement and note the mapping in a comment.

- [ ] **Step 5: Export from `index.js`, run tests, commit**

`index.js`: `module.exports = { ...require('./plan'), ...require('./ack') };`

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/*.test.js
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/
git commit -m "feat(valve-control): STREGA ACK interpretation + Gen2 hint"
```

---

### Task 4: `store.js` + `push.js` — SQL access and compile-and-queue

**Files:**
- Create: `conf/.../node-red/osi-valve-control/store.js`, `push.js`, `push.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: `plan.js` (Task 2).
- Produces:
```js
// store.js — every function takes a db facade (osi-db-helper Database, promise-style .get/.all/.run/.transaction)
listValvesForUser(db, userId)                 // -> rows: devices (STREGA_VALVE, deleted_at IS NULL, user_id=?) + zone name + settings + active expectation + reporting interval
listSchedules(db, deviceEui)                  // -> valve_schedules rows (deleted_at IS NULL)
getSettings(db, deviceEui)                    // -> valve_settings row or defaults {strega_generation:'GEN1', scheduler_status:'ACTIVE', ...}
upsertSettings(db, deviceEui, patch)          // -> void
insertSchedule(db, row)                       // row has schedule_uuid etc.
updateSchedule(db, scheduleUuid, patch)
softDeleteSchedule(db, scheduleUuid)
lastPushHashes(db, deviceEui)                 // -> { 'WEEKDAY_PLAN:3': 'hash', 'DAYMASK_PLAN:<mask>': 'hash' } from newest QUEUED|ACKED pushes
insertPushes(db, pushes)                      // [{push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash}]
supersedeQueued(db, deviceEui, purpose, weekdayOrNull)
ackPush(db, deviceEui, purpose, fport, weekdayOrNull, status, atIso) // marks newest QUEUED -> ACKED; returns changes
failStalePushes(db, olderThanIso)             // QUEUED older than 24h -> FAILED
pushSummary(db, deviceEui)                    // -> {queued, acked, failed, lastQueuedAt, lastAckedAt}
hasPendingObservation(db, deviceEui)          // -> boolean (expectation PENDING_OBSERVATION)
// push.js
buildPlanPushes({generation, days, lastHashes, force}) // -> [{purpose, weekday, daymask, fport, payloadHex, planHash}]  (pure)
buildDownlinkMessage({appId, deviceEui, fport, payloadHex}) // -> {topic, payload:{devEui, confirmed:false, fPort, data}} (pure)
buildStatusPush(statusCode)                   // '0'|'1'|'2' -> {purpose:'SCHEDULER_STATUS', fport:21, payloadHex:'30'|'31'|'32'} (pure)
buildClockPush(generation, now, timeZone)     // GEN1 -> {purpose:'CLOCK_SYNC', fport:12, payloadHex}; GEN2 -> fport 13, '01' (pure)
compileAndQueue({db, deviceEui, userId, force, appId, now, flushQueue, warn}) // async: loads schedules+settings, compiles, validates (throws 422 error with details on errors), diffs, supersedes, inserts pushes, returns {pushes:[...], messages:[...], flushed:boolean}
```

- [ ] **Step 1: Failing tests for the pure parts of `push.js`**

`push.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./plan');
const { buildPlanPushes, buildDownlinkMessage, buildStatusPush, buildClockPush } = require('./push');

const w = (onH, onM, offH, offM) => ({ onH, onM, offH, offM });

test('GEN1: only changed weekdays are pushed unless force', () => {
  const days = [[w(6, 0, 6, 30)], [], [], [], [], [], []];
  const lastHashes = {};
  for (let d = 1; d < 7; d += 1) lastHashes['WEEKDAY_PLAN:' + d] = P.planHash([]);
  const pushes = buildPlanPushes({ generation: 'GEN1', days, lastHashes, force: false });
  assert.deepEqual(pushes.map((p) => p.weekday), [0]);
  assert.equal(pushes[0].fport, 14);
  assert.equal(pushes[0].payloadHex.length, 48);
  assert.equal(buildPlanPushes({ generation: 'GEN1', days, lastHashes, force: true }).length, 7);
});

test('GEN1 with no prior pushes sends all 7 weekdays', () => {
  const days = Array.from({ length: 7 }, () => []);
  assert.equal(buildPlanPushes({ generation: 'GEN1', days, lastHashes: {}, force: false }).length, 7);
});

test('GEN2: one push per distinct window group, all-days uses 0x80', () => {
  const days = Array.from({ length: 7 }, () => [w(19, 15, 19, 30)]);
  const pushes = buildPlanPushes({ generation: 'GEN2', days, lastHashes: {}, force: false });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].fport, 25);
  assert.equal(pushes[0].payloadHex, '8099151930');
});

test('downlink message shape for ChirpStack MQTT', () => {
  const m = buildDownlinkMessage({ appId: 'app-uuid', deviceEui: '0016C001F1000001', fport: 14, payloadHex: 'FF'.repeat(24) });
  assert.equal(m.topic, 'application/app-uuid/device/0016C001F1000001/command/down');
  assert.deepEqual(Object.keys(m.payload).sort(), ['confirmed', 'data', 'devEui', 'fPort']);
  assert.equal(m.payload.confirmed, false);
  assert.equal(Buffer.from(m.payload.data, 'base64').length, 24);
});

test('status and clock pushes', () => {
  assert.deepEqual(buildStatusPush('1'), { purpose: 'SCHEDULER_STATUS', weekday: null, fport: 21, payloadHex: '31', planHash: null });
  assert.equal(buildClockPush('GEN1', new Date('2026-08-19T23:03:44Z'), 'Europe/Zurich').payloadHex, '0001000304040004020000080206');
  assert.deepEqual(buildClockPush('GEN2', new Date(), 'Europe/Zurich'), { purpose: 'CLOCK_SYNC', weekday: null, fport: 13, payloadHex: '01', planHash: null });
});
```

- [ ] **Step 2: Run → fail; implement `push.js` pure parts**

```js
'use strict';
const crypto = require('node:crypto');
const P = require('./plan');
const store = require('./store');

function hexOf(buf) { return Buffer.from(buf).toString('hex').toUpperCase(); }

function buildPlanPushes({ generation, days, lastHashes, force }) {
  const out = [];
  const last = lastHashes || {};
  if (generation === 'GEN2') {
    for (const g of P.gen2Groups(days)) {
      const h = P.planHash(g.windows);
      const key = 'DAYMASK_PLAN:' + g.daymask;
      if (!force && last[key] === h) continue;
      out.push({ purpose: 'DAYMASK_PLAN', weekday: null, daymask: g.daymask, fport: P.GEN2_SCHEDULER_FPORT, payloadHex: hexOf(P.encodeGen2(g.daymask, g.windows)), planHash: h });
    }
    return out;
  }
  for (let d = 0; d < 7; d += 1) {
    const h = P.planHash(days[d]);
    if (!force && last['WEEKDAY_PLAN:' + d] === h) continue;
    out.push({ purpose: 'WEEKDAY_PLAN', weekday: d, daymask: null, fport: P.WEEKDAY_FPORT_BASE + d, payloadHex: hexOf(P.encodeGen1Day(days[d])), planHash: h });
  }
  return out;
}

function buildDownlinkMessage({ appId, deviceEui, fport, payloadHex }) {
  const eui = String(deviceEui).toUpperCase();
  return {
    topic: 'application/' + appId + '/device/' + eui + '/command/down',
    payload: { devEui: eui, confirmed: false, fPort: fport, data: Buffer.from(payloadHex, 'hex').toString('base64') },
  };
}

function buildStatusPush(code) {
  if (!['0', '1', '2'].includes(String(code))) throw new Error('scheduler status code must be 0, 1 or 2');
  return { purpose: 'SCHEDULER_STATUS', weekday: null, fport: P.STATUS_FPORT, payloadHex: hexOf(Buffer.from(String(code), 'ascii')), planHash: null };
}

function buildClockPush(generation, now, timeZone) {
  if (generation === 'GEN2') return { purpose: 'CLOCK_SYNC', weekday: null, fport: P.CLOCK_REQ_FPORT, payloadHex: '01', planHash: null };
  return { purpose: 'CLOCK_SYNC', weekday: null, fport: P.CLOCK_FPORT, payloadHex: hexOf(P.gen1ClockPayload(now, timeZone)), planHash: null };
}

function toRow(deviceEui, p) {
  return { push_id: crypto.randomUUID(), device_eui: deviceEui, purpose: p.purpose, weekday: p.weekday, fport: p.fport, payload_hex: p.payloadHex, plan_hash: p.planHash || null };
}

// Queue a list of built pushes: supersede older QUEUED of the same key, insert rows, build MQTT messages.
async function queuePushes({ db, deviceEui, appId, pushes, flushQueue, warn }) {
  if (!pushes.length) return { rows: [], messages: [], flushed: false };
  let flushed = false;
  const pending = await store.hasPendingObservation(db, deviceEui);
  if (!pending && typeof flushQueue === 'function') {
    try { await flushQueue(deviceEui); flushed = true; } catch (e) { warn && warn('[valve-control] queue flush failed ' + deviceEui + ': ' + (e && e.message ? e.message : e)); }
  }
  const rows = pushes.map((p) => toRow(deviceEui, p));
  await db.transaction(async (tx) => {
    for (const p of pushes) await store.supersedeQueued(tx, deviceEui, p.purpose, p.weekday == null ? (p.daymask == null ? null : p.daymask) : p.weekday);
    await store.insertPushes(tx, rows);
  });
  const messages = rows.map((r) => buildDownlinkMessage({ appId, deviceEui, fport: r.fport, payloadHex: r.payload_hex }));
  return { rows, messages, flushed };
}

async function compileAndQueue({ db, deviceEui, appId, force, now, flushQueue, warn, timeZoneFallback }) {
  const schedules = await store.listSchedules(db, deviceEui);
  const settings = await store.getSettings(db, deviceEui);
  const compiled = P.compileWindows(schedules);
  if (compiled.errors.length) {
    const err = new Error('plan_conflict'); err.statusCode = 422; err.code = 'plan_conflict'; err.details = compiled.errors; throw err;
  }
  const lastHashes = await store.lastPushHashes(db, deviceEui);
  const pushes = buildPlanPushes({ generation: settings.strega_generation, days: compiled.days, lastHashes, force: !!force });
  const tz = (schedules.find((s) => s.timezone) || {}).timezone || timeZoneFallback || 'UTC';
  const needsClock = force || !settings.last_clock_sync_queued_at;
  if (needsClock) pushes.push(buildClockPush(settings.strega_generation, now || new Date(), tz));
  const queued = await queuePushes({ db, deviceEui, appId, pushes, flushQueue, warn });
  if (needsClock) await store.upsertSettings(db, deviceEui, { last_clock_sync_queued_at: (now || new Date()).toISOString() });
  return Object.assign({ compiled }, queued);
}

module.exports = { buildPlanPushes, buildDownlinkMessage, buildStatusPush, buildClockPush, queuePushes, compileAndQueue };
```

- [ ] **Step 3: Implement `store.js`**

```js
'use strict';
// All functions accept either the osi-db-helper Database facade or a transaction scope (tx) — both expose get/all/run returning promises.

const VALVE_LIST_SQL = `
SELECT d.deveui, d.name, d.type_id, d.irrigation_zone_id, d.current_state, d.target_state, d.user_id,
       iz.name AS zone_name, iz.zone_uuid, iz.timezone AS zone_timezone,
       vs.strega_generation, vs.flow_rate_lpm, vs.flow_rate_source, vs.default_open_minutes,
       vs.scheduler_status, vs.skip_today_date, vs.last_clock_sync_queued_at, vs.last_clock_sync_acked_at,
       zic.measured_flow_rate_lpm AS zone_flow_rate_lpm,
       (SELECT MAX(dd.recorded_at) FROM device_data dd WHERE dd.deveui = d.deveui) AS last_uplink_at,
       (SELECT vae.expectation_id FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_expectation_id,
       (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_reconciliation_state,
       (SELECT vae.commanded_at FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_commanded_at,
       (SELECT vae.expected_close_at FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_expected_close_at,
       (SELECT vae.commanded_duration_seconds FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_duration_seconds,
       (SELECT vae.trigger FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_trigger,
       (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state LIKE 'STALE_%' AND vae.commanded_at > datetime('now','-1 day') ORDER BY vae.commanded_at DESC LIMIT 1) AS recent_stale_state
  FROM devices d
  LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
  LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui
  LEFT JOIN zone_irrigation_calibration zic ON zic.zone_id = d.irrigation_zone_id
 WHERE d.type_id = 'STREGA_VALVE' AND d.deleted_at IS NULL AND d.user_id = ?
 ORDER BY COALESCE(iz.name,'~'), d.name`;

async function listValvesForUser(db, userId) { return db.all(VALVE_LIST_SQL, [userId]); }

async function listSchedules(db, deviceEui) {
  return db.all('SELECT * FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL ORDER BY kind, start_time, fire_at', [deviceEui]);
}

const SETTINGS_DEFAULTS = { strega_generation: 'GEN1', flow_rate_lpm: null, flow_rate_source: null, default_open_minutes: null, scheduler_status: 'ACTIVE', skip_today_date: null, last_clock_sync_queued_at: null, last_clock_sync_acked_at: null };

async function getSettings(db, deviceEui) {
  const row = await db.get('SELECT * FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
  return Object.assign({}, SETTINGS_DEFAULTS, row || {}, { device_eui: String(deviceEui).toUpperCase() });
}

const SETTINGS_COLUMNS = ['strega_generation', 'flow_rate_lpm', 'flow_rate_source', 'flow_rate_updated_at', 'default_open_minutes', 'scheduler_status', 'skip_today_date', 'last_clock_sync_queued_at', 'last_clock_sync_acked_at'];

async function upsertSettings(db, deviceEui, patch) {
  const cols = SETTINGS_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(patch || {}, c));
  if (!cols.length) return;
  const eui = String(deviceEui).toUpperCase();
  await db.run('INSERT OR IGNORE INTO valve_settings(device_eui) VALUES (?)', [eui]);
  await db.run('UPDATE valve_settings SET ' + cols.map((c) => c + '=?').join(', ') + ", updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE device_eui=?", cols.map((c) => patch[c]).concat([eui]));
}

async function insertSchedule(db, r) {
  await db.run(
    'INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, fire_at, duration_minutes, timezone, enabled, once_state) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [r.schedule_uuid, String(r.device_eui).toUpperCase(), r.kind, r.label, r.weekdays_mask, r.start_time, r.fire_at, r.duration_minutes, r.timezone, r.enabled, r.kind === 'ONCE' ? 'PENDING' : null]
  );
}

const SCHEDULE_COLUMNS = ['label', 'weekdays_mask', 'start_time', 'fire_at', 'duration_minutes', 'timezone', 'enabled', 'once_state', 'once_fired_at'];

async function updateSchedule(db, scheduleUuid, patch) {
  const cols = SCHEDULE_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(patch || {}, c));
  if (!cols.length) return 0;
  return db.run('UPDATE valve_schedules SET ' + cols.map((c) => c + '=?').join(', ') + ", sync_version = COALESCE(sync_version,0)+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE schedule_uuid=? AND deleted_at IS NULL", cols.map((c) => patch[c]).concat([scheduleUuid]));
}

async function softDeleteSchedule(db, scheduleUuid) {
  return db.run("UPDATE valve_schedules SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), sync_version=COALESCE(sync_version,0)+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE schedule_uuid=? AND deleted_at IS NULL", [scheduleUuid]);
}

async function lastPushHashes(db, deviceEui) {
  const rows = await db.all("SELECT purpose, weekday, payload_hex, plan_hash, state, queued_at FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED') ORDER BY queued_at DESC", [deviceEui]);
  const out = {};
  for (const r of rows) {
    const key = r.purpose === 'WEEKDAY_PLAN' ? 'WEEKDAY_PLAN:' + r.weekday : 'DAYMASK_PLAN:' + parseInt(r.payload_hex.slice(0, 2), 16);
    if (!(key in out)) out[key] = r.plan_hash;
  }
  return out;
}

async function insertPushes(db, rows) {
  for (const r of rows) {
    await db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash) VALUES (?,?,?,?,?,?,?)', [r.push_id, String(r.device_eui).toUpperCase(), r.purpose, r.weekday, r.fport, r.payload_hex, r.plan_hash]);
  }
}

async function supersedeQueued(db, deviceEui, purpose, weekdayOrMask) {
  if (purpose === 'WEEKDAY_PLAN') {
    return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose='WEEKDAY_PLAN' AND weekday=? AND state='QUEUED'", [deviceEui, weekdayOrMask]);
  }
  if (purpose === 'DAYMASK_PLAN') {
    return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose='DAYMASK_PLAN' AND state='QUEUED' AND CAST(('0x' || substr(payload_hex,1,2)) AS INTEGER) = ?", [deviceEui, weekdayOrMask]);
  }
  return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose=? AND state='QUEUED'", [deviceEui, purpose]);
}

async function ackPush(db, deviceEui, purpose, fport, weekdayOrNull, status, atIso) {
  const where = weekdayOrNull == null ? '' : ' AND weekday=?';
  const params = [status, atIso, deviceEui, purpose, fport].concat(weekdayOrNull == null ? [] : [weekdayOrNull]);
  return db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status=?, acked_at=? WHERE push_id = (SELECT push_id FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose=? AND fport=? AND state='QUEUED'" + where + ' ORDER BY queued_at DESC LIMIT 1)', params);
}

async function failStalePushes(db, olderThanIso) {
  return db.run("UPDATE valve_schedule_pushes SET state='FAILED', error='no_ack_24h' WHERE state='QUEUED' AND queued_at < ?", [olderThanIso]);
}

async function pushSummary(db, deviceEui) {
  const row = await db.get(`SELECT
      SUM(CASE WHEN state='QUEUED' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN state='ACKED' THEN 1 ELSE 0 END) AS acked,
      SUM(CASE WHEN state='FAILED' THEN 1 ELSE 0 END) AS failed,
      MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') THEN queued_at END) AS last_plan_queued_at,
      MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state='ACKED' THEN acked_at END) AS last_plan_acked_at
    FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND queued_at > datetime('now','-30 day')`, [deviceEui]);
  return row || { queued: 0, acked: 0, failed: 0, last_plan_queued_at: null, last_plan_acked_at: null };
}

async function hasPendingObservation(db, deviceEui) {
  const row = await db.get("SELECT 1 AS x FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) AND reconciliation_state='PENDING_OBSERVATION' LIMIT 1", [deviceEui]);
  return !!row;
}

async function weekdayPushStates(db, deviceEui) {
  return db.all("SELECT purpose, weekday, payload_hex, state, queued_at, acked_at, error FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED','FAILED') ORDER BY queued_at DESC", [deviceEui]);
}

module.exports = { listValvesForUser, listSchedules, getSettings, upsertSettings, insertSchedule, updateSchedule, softDeleteSchedule, lastPushHashes, insertPushes, supersedeQueued, ackPush, failStalePushes, pushSummary, hasPendingObservation, weekdayPushStates, SETTINGS_DEFAULTS };
```

Check the real `zone_irrigation_calibration` column names before relying on `zic.zone_id` / `measured_flow_rate_lpm`:
```bash
grep -n "CREATE TABLE zone_irrigation_calibration" -A 12 database/seed-blank.sql
```
Adjust the JOIN if the column is named differently.

- [ ] **Step 4: Integration test of `compileAndQueue` against a real SQLite file**

Append to `push.test.js` (uses the bundled dev DB schema copied to a temp file and the `osi-db-helper` facade):
```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../osi-db-helper');
const store = require('./store');
const { compileAndQueue } = require('./push');

async function tempDb() {
  const src = path.resolve(__dirname, '../../db/farming.db');
  const dst = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-')), 'farming.db');
  fs.copyFileSync(src, dst);
  const db = new Database(dst);
  await db.run("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))").catch(() => {});
  await db.run("INSERT INTO devices(deveui, name, type_id, user_id) VALUES ('0016C001F1000001','Valve A','STREGA_VALVE',1)");
  return db;
}

test('compileAndQueue: first save pushes 7 weekdays + clock, second identical save pushes nothing, change pushes one day', async () => {
  const db = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'u1', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 1, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const flushes = [];
  const r1 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date('2026-08-19T10:00:00Z'), flushQueue: async (e) => flushes.push(e), warn: () => {} });
  assert.equal(r1.rows.filter((r) => r.purpose === 'WEEKDAY_PLAN').length, 7);
  assert.equal(r1.rows.filter((r) => r.purpose === 'CLOCK_SYNC').length, 1);
  assert.equal(r1.messages.length, 8);
  assert.deepEqual(flushes, ['0016C001F1000001']);
  const r2 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  assert.equal(r2.rows.length, 0);
  await store.insertSchedule(db, { schedule_uuid: 'u2', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 2, start_time: '07:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  const r3 = await compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', force: false, now: new Date(), flushQueue: async () => {}, warn: () => {} });
  assert.deepEqual(r3.rows.map((r) => r.weekday), [1]);
  const superseded = await db.all("SELECT state FROM valve_schedule_pushes WHERE weekday=1 ORDER BY queued_at");
  assert.deepEqual(superseded.map((s) => s.state), ['SUPERSEDED', 'QUEUED']);
  await new Promise((res) => db.close(() => res()));
});

test('compileAndQueue rejects >4 windows with a 422 plan_conflict', async () => {
  const db = await tempDb();
  for (let i = 1; i <= 5; i += 1) await store.insertSchedule(db, { schedule_uuid: 'x' + i, device_eui: '0016C001F1000001', kind: 'WEEKLY', label: null, weekdays_mask: 4, start_time: '0' + i + ':00', duration_minutes: 10, timezone: 'UTC', enabled: 1 });
  await assert.rejects(() => compileAndQueue({ db, deviceEui: '0016C001F1000001', appId: 'app', flushQueue: async () => {}, warn: () => {} }), (e) => e.statusCode === 422 && e.details[0].weekday === 2);
  await new Promise((res) => db.close(() => res()));
});
```
If the `users` table columns differ, read `database/seed-blank.sql` `CREATE TABLE users` and fix the insert; the `devices` insert needs whatever `NOT NULL` columns the seed requires (check `CREATE TABLE devices`).

- [ ] **Step 5: Run all module tests, then commit**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/*.test.js
```
Expected: all pass (the integration tests need `database/farming.db` regenerated in Task 1 — that path is `../../db/farming.db` relative to the module? No: the module lives under `files/usr/share/node-red/`, the bundled DB under `files/usr/share/db/farming.db`, so `path.resolve(__dirname, '../../db/farming.db')` is correct).

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/
git commit -m "feat(valve-control): store + compile-and-queue with hash diffing, flush guard, clock sync"
```

---

### Task 5: `api.js` — HTTP router for `/api/valves*`

**Files:**
- Create: `conf/.../node-red/osi-valve-control/api.js`, `api.test.js`
- Modify: `index.js`

**Interfaces:**
- Consumes: `store.js`, `push.js`, `plan.js`.
- Produces: `handleHttpRequest({ msg, Database, environment, warn, flushQueue, appId, now }) -> Promise<msg>` where `msg.statusCode`, `msg.payload`, `msg.headers` are set and `msg.valvePushMessages` (array of MQTT downlink messages) is set when pushes were queued (the thin flow node forwards those to the mqtt-out node).

- [ ] **Step 1: Copy auth helpers from `osi-journal/api.js`**

Copy `apiError`, `unauthorized`, `verifyBearer`, `resolveAuthSecret`, `requestBody`, `closeFacade` verbatim from `conf/.../osi-journal/api.js` (lines ≈ 87–100, 185–215, 2675–2745) into `api.js`, renaming the log prefix `[journal-api]` → `[valve-api]`. Do not retype them.

- [ ] **Step 2: Failing router tests**

`api.test.js` (uses the same `tempDb()` helper as Task 4 — extract it to `test-helpers.js` and import from both files):
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { tempDb } = require('./test-helpers');
const { handleHttpRequest } = require('./api');
const { Database } = require('../osi-db-helper');

const SECRET = 'test-secret';
function token(userId) {
  const payload = Buffer.from(JSON.stringify({ userId, username: 'u', exp: Date.now() + 60000 })).toString('base64url');
  return 'Bearer ' + payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
function req(method, url, body, auth) {
  return { req: { method, url, headers: { authorization: auth === undefined ? token(1) : auth }, body, params: {} }, payload: body };
}
async function call(dbPath, msg, extra) {
  return handleHttpRequest(Object.assign({ msg, Database, environment: { authTokenSecret: SECRET, dbPath }, warn: () => {}, flushQueue: async () => {}, appId: 'app' }, extra || {}));
}

test('GET /api/valves returns the user valves with zone name and defaults', async () => {
  const { path } = await tempDb();
  const out = await call(path, req('GET', '/api/valves'));
  assert.equal(out.statusCode, 200);
  assert.equal(out.payload.valves.length, 1);
  assert.equal(out.payload.valves[0].device_eui, '0016C001F1000001');
  assert.equal(out.payload.valves[0].strega_generation, 'GEN1');
  assert.equal(out.payload.valves[0].next_run, null);
});

test('no token -> 401', async () => {
  const { path } = await tempDb();
  assert.equal((await call(path, req('GET', '/api/valves', undefined, null))).statusCode, 401);
});

test('POST schedule creates, compiles, queues pushes and exposes mqtt messages; GET lists it', async () => {
  const { path } = await tempDb();
  const out = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 3, start_time: '06:00', duration_minutes: 30, label: 'Slot' }));
  assert.equal(out.statusCode, 201);
  assert.ok(out.payload.schedule.schedule_uuid);
  assert.equal(out.payload.pushes_queued, 8); // 7 weekdays + clock sync
  assert.equal(out.valvePushMessages.length, 8);
  const list = await call(path, req('GET', '/api/valves/0016C001F1000001/schedules'));
  assert.equal(list.payload.schedules.length, 1);
  assert.equal(list.payload.compiled.days[0].length, 1);
  assert.equal(list.payload.push_state.length, 7);
});

test('POST schedule that overflows 4 windows -> 422 with weekday and conflicts', async () => {
  const { path } = await tempDb();
  for (let i = 1; i <= 4; i += 1) await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 4, start_time: '0' + i + ':00', duration_minutes: 10 }));
  const out = await call(path, req('POST', '/api/valves/0016C001F1000001/schedules', { kind: 'WEEKLY', weekdays_mask: 4, start_time: '09:00', duration_minutes: 10 }));
  assert.equal(out.statusCode, 422);
  assert.equal(out.payload.error, 'plan_conflict');
  assert.equal(out.payload.details[0].weekday, 2);
  const list = await call(path, req('GET', '/api/valves/0016C001F1000001/schedules'));
  assert.equal(list.payload.schedules.length, 4, 'rejected schedule must not be persisted');
});

test('scheduler-status SKIP_TODAY queues FPort 21 "1" and records the local date', async () => {
  const { path } = await tempDb();
  const out = await call(path, req('POST', '/api/valves/0016C001F1000001/scheduler-status', { status: 'SKIP_TODAY' }));
  assert.equal(out.statusCode, 202);
  assert.equal(out.valvePushMessages[0].payload.fPort, 21);
  assert.equal(Buffer.from(out.valvePushMessages[0].payload.data, 'base64').toString('ascii'), '1');
});

test('settings PUT validates flow rate and generation', async () => {
  const { path } = await tempDb();
  assert.equal((await call(path, req('PUT', '/api/valves/0016C001F1000001/settings', { flow_rate_lpm: 12.5, flow_rate_source: 'measured' }))).statusCode, 200);
  assert.equal((await call(path, req('PUT', '/api/valves/0016C001F1000001/settings', { strega_generation: 'GEN3' }))).statusCode, 422);
});

test('another user -> 403 on schedules', async () => {
  const { path } = await tempDb();
  assert.equal((await call(path, req('GET', '/api/valves/0016C001F1000001/schedules', undefined, token(2)))).statusCode, 403);
});
```

- [ ] **Step 3: Implement `api.js`**

```js
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const P = require('./plan');
const store = require('./store');
const push = require('./push');

// --- copied verbatim from osi-journal/api.js (apiError, unauthorized, verifyBearer, resolveAuthSecret, requestBody, closeFacade) ---
// ... paste here, prefix logs with [valve-api] ...

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };
const EUI_RE = /^[0-9A-F]{16}$/;

function shapeValve(row, schedules, now, tzFallback, pushes) {
  const flowRate = row.flow_rate_lpm != null ? Number(row.flow_rate_lpm) : (row.zone_flow_rate_lpm != null ? Number(row.zone_flow_rate_lpm) : null);
  return {
    device_eui: row.deveui, name: row.name, zone_id: row.irrigation_zone_id, zone_name: row.zone_name || null, zone_uuid: row.zone_uuid || null,
    timezone: row.zone_timezone || tzFallback, current_state: row.current_state || null, target_state: row.target_state || null,
    strega_generation: row.strega_generation || 'GEN1',
    flow_rate_lpm: flowRate, flow_rate_source: row.flow_rate_lpm != null ? (row.flow_rate_source || 'estimated') : (row.zone_flow_rate_lpm != null ? 'zone' : null),
    default_open_minutes: row.default_open_minutes != null ? Number(row.default_open_minutes) : null,
    scheduler_status: row.scheduler_status || 'ACTIVE', skip_today_date: row.skip_today_date || null,
    last_uplink_at: row.last_uplink_at || null,
    active_actuation: row.active_expectation_id ? { expectation_id: row.active_expectation_id, reconciliation_state: row.active_reconciliation_state, commanded_at: row.active_commanded_at, expected_close_at: row.active_expected_close_at, duration_seconds: row.active_duration_seconds, trigger: row.active_trigger || null } : null,
    recent_stale_state: row.recent_stale_state || null,
    next_run: P.nextRun(schedules, now, row.zone_timezone || tzFallback),
    schedule_count: schedules.length,
    push_state: { queued: Number(pushes.queued || 0), acked: Number(pushes.acked || 0), failed: Number(pushes.failed || 0), last_plan_queued_at: pushes.last_plan_queued_at || null, last_plan_acked_at: pushes.last_plan_acked_at || null },
    last_clock_sync_acked_at: row.last_clock_sync_acked_at || null,
  };
}

async function ownedValve(db, eui, userId) {
  if (!EUI_RE.test(eui)) throw apiError(400, 'invalid_eui', 'device EUI must be 16 hex chars');
  const row = await db.get("SELECT deveui, user_id, type_id, irrigation_zone_id, (SELECT timezone FROM irrigation_zones WHERE id = devices.irrigation_zone_id) AS zone_timezone FROM devices WHERE UPPER(deveui)=? AND deleted_at IS NULL", [eui]);
  if (!row) throw apiError(404, 'not_found', 'Valve not found');
  if (row.type_id !== 'STREGA_VALVE') throw apiError(409, 'not_a_valve', 'Device is not a STREGA valve');
  if (row.user_id != null && Number(row.user_id) !== Number(userId)) throw apiError(403, 'forbidden', 'Valve is claimed by another user');
  return row;
}

async function handleHttpRequest(options) {
  const { msg, Database } = options;
  const environment = options.environment || {};
  const warn = typeof options.warn === 'function' ? options.warn : function () {};
  const now = options.now || new Date();
  const tzFallback = environment.gatewayTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const respond = (statusCode, payload) => { msg.statusCode = statusCode; msg.payload = payload; msg.headers = HEADERS; return msg; };
  const method = String(msg.req && msg.req.method || '').toUpperCase();
  const requestPath = String(msg.req && msg.req.url || '').split('?')[0];
  let db = null;
  try {
    const secret = resolveAuthSecret(environment, warn);
    const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization, secret);
    db = new Database(environment.dbPath || '/data/db/farming.db');
    const m = (re) => re.exec(requestPath);
    let match;

    if (method === 'GET' && requestPath === '/api/valves') {
      const rows = await store.listValvesForUser(db, auth.userId);
      const valves = [];
      for (const row of rows) {
        const schedules = await store.listSchedules(db, row.deveui);
        const pushes = await store.pushSummary(db, row.deveui);
        valves.push(shapeValve(row, schedules, now, tzFallback, pushes));
      }
      return respond(200, { generatedAt: now.toISOString(), valves });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/schedules$/)) && (method === 'GET' || method === 'POST')) {
      const eui = match[1].toUpperCase();
      const device = await ownedValve(db, eui, auth.userId);
      if (method === 'GET') {
        const schedules = await store.listSchedules(db, eui);
        const compiled = P.compileWindows(schedules);
        return respond(200, { schedules, compiled: { days: compiled.days, errors: compiled.errors }, push_state: await store.weekdayPushStates(db, eui), settings: await store.getSettings(db, eui) });
      }
      const v = P.validateScheduleInput(requestBody(msg));
      if (!v.ok) return respond(v.status, { error: v.error, message: v.details });
      const row = Object.assign({ schedule_uuid: crypto.randomUUID(), device_eui: eui, timezone: device.zone_timezone || tzFallback }, v.value);
      // Validate the compiled plan BEFORE persisting so a rejected schedule never reaches the DB.
      if (row.kind === 'WEEKLY') {
        const existing = await store.listSchedules(db, eui);
        const trial = P.compileWindows(existing.concat([Object.assign({ enabled: 1 }, row)]));
        if (trial.errors.length) return respond(422, { error: 'plan_conflict', details: trial.errors });
      }
      await store.insertSchedule(db, row);
      const q = row.kind === 'WEEKLY' ? await push.compileAndQueue({ db, deviceEui: eui, appId: options.appId, force: false, now, flushQueue: options.flushQueue, warn, timeZoneFallback: tzFallback }) : { rows: [], messages: [] };
      msg.valvePushMessages = q.messages;
      return respond(201, { schedule: row, pushes_queued: q.rows.length });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/schedules\/([0-9a-fA-F-]{36})$/)) && (method === 'PUT' || method === 'DELETE')) {
      const eui = match[1].toUpperCase(); const uuid = match[2];
      await ownedValve(db, eui, auth.userId);
      const existing = await store.listSchedules(db, eui);
      const current = existing.find((s) => s.schedule_uuid === uuid);
      if (!current) return respond(404, { error: 'not_found', message: 'Schedule not found' });
      if (method === 'DELETE') {
        await store.softDeleteSchedule(db, uuid);
      } else {
        const body = requestBody(msg);
        const v = P.validateScheduleInput(Object.assign({}, current, body, { kind: current.kind }));
        if (!v.ok) return respond(v.status, { error: v.error, message: v.details });
        const trial = P.compileWindows(existing.map((s) => (s.schedule_uuid === uuid ? Object.assign({}, s, v.value) : s)));
        if (trial.errors.length) return respond(422, { error: 'plan_conflict', details: trial.errors });
        await store.updateSchedule(db, uuid, v.value);
      }
      const q = await push.compileAndQueue({ db, deviceEui: eui, appId: options.appId, force: false, now, flushQueue: options.flushQueue, warn, timeZoneFallback: tzFallback });
      msg.valvePushMessages = q.messages;
      return respond(200, { ok: true, pushes_queued: q.rows.length });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/plan\/resend$/)) && method === 'POST') {
      const eui = match[1].toUpperCase();
      await ownedValve(db, eui, auth.userId);
      const q = await push.compileAndQueue({ db, deviceEui: eui, appId: options.appId, force: true, now, flushQueue: options.flushQueue, warn, timeZoneFallback: tzFallback });
      msg.valvePushMessages = q.messages;
      return respond(202, { ok: true, pushes_queued: q.rows.length });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/scheduler-status$/)) && method === 'POST') {
      const eui = match[1].toUpperCase();
      const device = await ownedValve(db, eui, auth.userId);
      const status = String((requestBody(msg) || {}).status || '').toUpperCase();
      const code = { ACTIVE: '0', SKIP_TODAY: '1', DEACTIVATED: '2' }[status];
      if (!code) return respond(422, { error: 'invalid_status', message: 'status must be ACTIVE, SKIP_TODAY or DEACTIVATED' });
      const q = await push.queuePushes({ db, deviceEui: eui, appId: options.appId, pushes: [push.buildStatusPush(code)], flushQueue: options.flushQueue, warn });
      const tz = device.zone_timezone || tzFallback;
      const lp = P.localParts(now, tz);
      await store.upsertSettings(db, eui, { scheduler_status: status, skip_today_date: status === 'SKIP_TODAY' ? `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}` : null });
      msg.valvePushMessages = q.messages;
      return respond(202, { ok: true, status });
    }

    if ((match = m(/^\/api\/valves\/([0-9A-Fa-f]{16})\/settings$/)) && method === 'PUT') {
      const eui = match[1].toUpperCase();
      await ownedValve(db, eui, auth.userId);
      const b = requestBody(msg) || {};
      const patch = {};
      if (b.strega_generation !== undefined) { if (!['GEN1', 'GEN2'].includes(b.strega_generation)) return respond(422, { error: 'invalid_generation' }); patch.strega_generation = b.strega_generation; }
      if (b.flow_rate_lpm !== undefined) {
        if (b.flow_rate_lpm === null) { patch.flow_rate_lpm = null; patch.flow_rate_source = null; patch.flow_rate_updated_at = null; }
        else { const n = Number(b.flow_rate_lpm); if (!Number.isFinite(n) || n <= 0 || n > 10000) return respond(422, { error: 'invalid_flow_rate' }); patch.flow_rate_lpm = n; patch.flow_rate_source = b.flow_rate_source === 'measured' ? 'measured' : 'estimated'; patch.flow_rate_updated_at = now.toISOString(); }
      }
      if (b.default_open_minutes !== undefined) { const n = Number(b.default_open_minutes); if (!Number.isInteger(n) || n < 1 || n > 255) return respond(422, { error: 'invalid_default_open_minutes' }); patch.default_open_minutes = n; }
      await store.upsertSettings(db, eui, patch);
      return respond(200, { ok: true, settings: await store.getSettings(db, eui) });
    }

    return respond(404, { error: 'not_found', message: 'Unknown valve-control route' });
  } catch (error) {
    const status = Number(error && error.statusCode) || 500;
    if (status === 500) warn('[valve-api] ' + method + ' ' + requestPath + ' failed: ' + (error && error.stack || error));
    return respond(status, { error: status === 500 ? 'internal_error' : (error.code || 'error'), message: status === 500 ? 'Valve request failed' : String(error.message || ''), details: status === 500 ? undefined : (error.details || undefined) });
  } finally {
    await closeFacade(db, warn);
  }
}

module.exports = { handleHttpRequest };
```

- [ ] **Step 4: Tests green, export, commit**

`index.js`: add `...require('./api')` (exporting `handleHttpRequest`) and also export `store`, `push` namespaces: `module.exports = { ...plan, ...ack, ...api, store: require('./store'), push: require('./push') };`

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/*.test.js
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/
git commit -m "feat(valve-control): /api/valves HTTP router (schedules, plan resend, scheduler status, settings)"
```

---

### Task 6: `workers.js` — uplink ACK handling, once-tick, observe-tick, clock-tick

**Files:**
- Create: `conf/.../node-red/osi-valve-control/workers.js`, `workers.test.js`
- Modify: `index.js`

**Interfaces (produces):**
```js
handleUplink({ db, deviceEui, decoded, fPort, receivedAt, warn })  // -> { acked: n, generationPromoted: bool }
runOnceTick({ db, now, gatewayEui, warn })   // -> { fired: [{schedule_uuid, device_eui, duration_minutes, command_id}], skipped: [...] }  — also writes irrigation_events and sets once_state; returns actuator_command payloads for the caller to emit
runObserveTick({ db, now, warn })            // -> { created: n } — inserts on_valve_schedule / unexplained expectations
runClockTick({ db, now, appId, warn })       // -> { messages: [...] } — weekly + DST-triggered clock pushes, and fails stale pushes
```

- [ ] **Step 1: Failing tests**

`workers.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDb } = require('./test-helpers');
const store = require('./store');
const W = require('./workers');
const { Database } = require('../osi-db-helper');

test('handleUplink acks the newest queued weekday push and records RTC ack', async () => {
  const { db } = await tempDb();
  await store.insertPushes(db, [{ push_id: 'p1', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 2, fport: 16, payload_hex: 'FF'.repeat(24), plan_hash: 'h' }, { push_id: 'p2', device_eui: '0016C001F1000001', purpose: 'CLOCK_SYNC', weekday: null, fport: 12, payload_hex: '00', plan_hash: null }]);
  const r = await W.handleUplink({ db, deviceEui: '0016C001F1000001', decoded: { Schl_Port: 16, Schl_status: '00' }, fPort: 2, receivedAt: '2026-08-19T10:00:00.000Z', warn: () => {} });
  assert.equal(r.acked, 1);
  await W.handleUplink({ db, deviceEui: '0016C001F1000001', decoded: { RTC_Port: 12, RTC_status: '00' }, fPort: 2, receivedAt: '2026-08-19T10:01:00.000Z', warn: () => {} });
  const rows = await db.all('SELECT push_id, state FROM valve_schedule_pushes ORDER BY push_id');
  assert.deepEqual(rows, [{ push_id: 'p1', state: 'ACKED' }, { push_id: 'p2', state: 'ACKED' }]);
  assert.equal((await store.getSettings(db, '0016C001F1000001')).last_clock_sync_acked_at, '2026-08-19T10:01:00.000Z');
});

test('runOnceTick fires due ONCE rows within grace and skips stale ones', async () => {
  const { db } = await tempDb();
  await store.insertSchedule(db, { schedule_uuid: 'due', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T10:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await store.insertSchedule(db, { schedule_uuid: 'old', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T09:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  await store.insertSchedule(db, { schedule_uuid: 'future', device_eui: '0016C001F1000001', kind: 'ONCE', label: null, weekdays_mask: null, start_time: null, fire_at: '2026-08-19T12:00:00.000Z', duration_minutes: 20, timezone: 'UTC', enabled: 1 });
  const r = await W.runOnceTick({ db, now: new Date('2026-08-19T10:03:00Z'), gatewayEui: null, warn: () => {} });
  assert.deepEqual(r.fired.map((f) => f.schedule_uuid), ['due']);
  assert.deepEqual(r.skipped.map((f) => f.schedule_uuid), ['old']);
  assert.equal(r.fired[0].actuator_command.data.action, 'OPEN_FOR_DURATION');
  assert.equal(r.fired[0].actuator_command.data.duration_minutes, 20);
  assert.equal(r.fired[0].actuator_command.data.reason, 'one_time_open');
  const states = await db.all('SELECT schedule_uuid, once_state FROM valve_schedules ORDER BY schedule_uuid');
  assert.deepEqual(states, [{ schedule_uuid: 'due', once_state: 'FIRED' }, { schedule_uuid: 'future', once_state: 'PENDING' }, { schedule_uuid: 'old', once_state: 'SKIPPED' }]);
  const again = await W.runOnceTick({ db, now: new Date('2026-08-19T10:04:00Z'), gatewayEui: null, warn: () => {} });
  assert.equal(again.fired.length + again.skipped.length, 0, 'idempotent');
});

test('runObserveTick creates an on_valve_schedule expectation when OPEN inside a compiled window, unexplained otherwise', async () => {
  const { db } = await tempDb();
  // valve reports OPEN at 06:10 local (Europe/Zurich) on a Wednesday; window Wed 06:00-06:30 exists
  await store.insertSchedule(db, { schedule_uuid: 'w', device_eui: '0016C001F1000001', kind: 'WEEKLY', label: 'Morning', weekdays_mask: 1 << 3, start_time: '06:00', duration_minutes: 30, timezone: 'Europe/Zurich', enabled: 1 });
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T04:10:00.000Z')");
  const r = await W.runObserveTick({ db, now: new Date('2026-08-19T04:10:30Z'), warn: () => {} });
  assert.equal(r.created, 1);
  const e = await db.get("SELECT trigger, commanded_duration_seconds, reconciliation_state, volume_source FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'");
  assert.equal(e.trigger, 'on_valve_schedule'); assert.equal(e.commanded_duration_seconds, 1800); assert.equal(e.reconciliation_state, 'OBSERVED_RUNNING');
  // second tick does not duplicate
  assert.equal((await W.runObserveTick({ db, now: new Date('2026-08-19T04:11:30Z'), warn: () => {} })).created, 0);
});

test('runObserveTick: OPEN outside any window -> unexplained with 0 duration', async () => {
  const { db } = await tempDb();
  await db.run("UPDATE devices SET current_state='OPEN' WHERE deveui='0016C001F1000001'");
  await db.run("INSERT INTO device_data(deveui, recorded_at) VALUES ('0016C001F1000001','2026-08-19T15:00:00.000Z')");
  await W.runObserveTick({ db, now: new Date('2026-08-19T15:00:30Z'), warn: () => {} });
  const e = await db.get("SELECT trigger, commanded_duration_seconds FROM valve_actuation_expectations WHERE device_eui='0016C001F1000001'");
  assert.deepEqual(e, { trigger: 'unexplained', commanded_duration_seconds: 0 });
});

test('runClockTick queues a weekly GEN1 clock push and fails >24h queued pushes', async () => {
  const { db } = await tempDb();
  await store.upsertSettings(db, '0016C001F1000001', { last_clock_sync_queued_at: '2026-08-01T00:00:00.000Z' });
  await store.insertPushes(db, [{ push_id: 'stale', device_eui: '0016C001F1000001', purpose: 'WEEKDAY_PLAN', weekday: 0, fport: 14, payload_hex: 'FF'.repeat(24), plan_hash: 'h' }]);
  await db.run("UPDATE valve_schedule_pushes SET queued_at='2026-08-17T00:00:00.000Z' WHERE push_id='stale'");
  const r = await W.runClockTick({ db, now: new Date('2026-08-19T10:00:00Z'), appId: 'app', warn: () => {} });
  assert.equal(r.messages.length, 1); assert.equal(r.messages[0].payload.fPort, 12);
  assert.equal((await db.get("SELECT state FROM valve_schedule_pushes WHERE push_id='stale'")).state, 'FAILED');
});
```
Adjust the `device_data` INSERT to include whatever `NOT NULL` columns the seed requires (check `CREATE TABLE device_data`).

- [ ] **Step 2: Implement `workers.js`**

```js
'use strict';
const crypto = require('node:crypto');
const P = require('./plan');
const store = require('./store');
const push = require('./push');
const { interpretUplink } = require('./ack');

const ONCE_GRACE_MS = 10 * 60 * 1000;
const STALE_PUSH_MS = 24 * 3600 * 1000;
const CLOCK_PERIOD_MS = 7 * 86400000;
const DOWNLINK_LATENCY_BUDGET_SEC = 120;

async function handleUplink({ db, deviceEui, decoded, fPort, receivedAt, warn }) {
  const { acks, generationHint } = interpretUplink(decoded, fPort);
  const at = receivedAt || new Date().toISOString();
  let acked = 0;
  for (const a of acks) {
    acked += Number(await store.ackPush(db, deviceEui, a.purpose, a.fport, a.weekday, a.status, at)) || 0;
    if (a.purpose === 'CLOCK_SYNC') await store.upsertSettings(db, deviceEui, { last_clock_sync_acked_at: at });
  }
  let generationPromoted = false;
  if (generationHint === 'GEN2') {
    const s = await store.getSettings(db, deviceEui);
    if (s.strega_generation !== 'GEN2') { await store.upsertSettings(db, deviceEui, { strega_generation: 'GEN2' }); generationPromoted = true; warn && warn('[valve-control] ' + deviceEui + ' promoted to GEN2 from uplink'); }
  }
  return { acked, generationPromoted };
}

function actuatorCommand(deviceEui, zoneId, minutes, commandId, reason) {
  return { type: 'actuator_command', device: { devEui: deviceEui, zone_id: zoneId }, data: { action: 'OPEN_FOR_DURATION', duration_minutes: minutes, reason, commandId, commandType: 'OPEN_FOR_DURATION', deviceEui, trigger: 'one_time' } };
}

async function runOnceTick({ db, now, gatewayEui, warn }) {
  const nowMs = (now || new Date()).getTime();
  const rows = await db.all("SELECT vs.*, d.irrigation_zone_id, d.user_id FROM valve_schedules vs JOIN devices d ON d.deveui = vs.device_eui WHERE vs.kind='ONCE' AND vs.once_state='PENDING' AND vs.enabled=1 AND vs.deleted_at IS NULL AND vs.fire_at <= ? ORDER BY vs.fire_at", [new Date(nowMs).toISOString()]);
  const fired = []; const skipped = [];
  for (const r of rows) {
    const fireMs = Date.parse(r.fire_at);
    const nowIso = new Date(nowMs).toISOString();
    if (nowMs - fireMs > ONCE_GRACE_MS) {
      await db.transaction(async (tx) => {
        await store.updateSchedule(tx, r.schedule_uuid, { once_state: 'SKIPPED' });
        await tx.run("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json, event_uuid, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [r.user_id, r.irrigation_zone_id, 'SKIP', 'one_time_missed', r.duration_minutes, r.device_eui, JSON.stringify({ schedule_uuid: r.schedule_uuid, fire_at: r.fire_at }), crypto.randomUUID(), nowIso]).catch((e) => warn && warn('[valve-control] irrigation_events insert failed: ' + e.message));
      });
      skipped.push({ schedule_uuid: r.schedule_uuid, device_eui: r.device_eui });
      continue;
    }
    const commandId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await store.updateSchedule(tx, r.schedule_uuid, { once_state: 'FIRED', once_fired_at: nowIso });
      await tx.run("INSERT INTO irrigation_events(user_id, irrigation_zone_id, action, reason, duration_minutes, valve_deveui, payload_json, event_uuid, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [r.user_id, r.irrigation_zone_id, 'IRRIGATE', 'one_time_open', r.duration_minutes, r.device_eui, JSON.stringify({ schedule_uuid: r.schedule_uuid, command_id: commandId }), crypto.randomUUID(), nowIso]).catch((e) => warn && warn('[valve-control] irrigation_events insert failed: ' + e.message));
    });
    fired.push({ schedule_uuid: r.schedule_uuid, device_eui: r.device_eui, duration_minutes: r.duration_minutes, command_id: commandId, actuator_command: actuatorCommand(r.device_eui, r.irrigation_zone_id, r.duration_minutes, commandId, 'one_time_open') });
  }
  return { fired, skipped };
}

async function runObserveTick({ db, now, warn }) {
  const nowDate = now || new Date();
  const open = await db.all(`SELECT d.deveui, d.irrigation_zone_id, iz.timezone AS zone_timezone,
      (SELECT MAX(recorded_at) FROM device_data dd WHERE dd.deveui = d.deveui) AS last_uplink_at,
      zic.measured_flow_rate_lpm AS zone_flow_rate_lpm, vs.flow_rate_lpm, vs.flow_rate_source
    FROM devices d
    LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id
    LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui
    LEFT JOIN zone_irrigation_calibration zic ON zic.zone_id = d.irrigation_zone_id
    WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NULL AND d.current_state='OPEN'
      AND NOT EXISTS (SELECT 1 FROM valve_actuation_expectations v WHERE v.device_eui = d.deveui AND v.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING'))`);
  let created = 0;
  for (const d of open) {
    if (!d.last_uplink_at) continue;
    const tz = d.zone_timezone || 'UTC';
    const schedules = await store.listSchedules(db, d.deveui);
    const { days } = P.compileWindows(schedules);
    const lp = P.localParts(nowDate, tz);
    const minuteOfDay = lp.hour * 60 + lp.minute;
    let hit = null; let hitDay = lp.weekday;
    for (const w of days[lp.weekday]) { if (minuteOfDay >= w.startMin && minuteOfDay < w.endMin) hit = w; }
    if (!hit) { // a window that started yesterday and wraps past midnight
      const y = (lp.weekday + 6) % 7;
      for (const w of days[y]) { if (w.endMin > 1440 && minuteOfDay < w.endMin - 1440) { hit = w; hitDay = y; } }
    }
    const flowRate = d.flow_rate_lpm != null ? Number(d.flow_rate_lpm) : (d.zone_flow_rate_lpm != null ? Number(d.zone_flow_rate_lpm) : null);
    const flowSource = d.flow_rate_lpm != null ? 'valve_' + (d.flow_rate_source || 'estimated') : (d.zone_flow_rate_lpm != null ? 'zone_calibration' : null);
    const uplinkMs = Date.parse(d.last_uplink_at);
    let commandedAt, durationSec, expectedClose, trigger, volumeSource, liters = null;
    if (hit) {
      const startOffsetMin = hitDay === lp.weekday ? minuteOfDay - hit.startMin : minuteOfDay + 1440 - hit.startMin;
      commandedAt = new Date(nowDate.getTime() - startOffsetMin * 60000);
      durationSec = (hit.endMin - hit.startMin) * 60;
      expectedClose = new Date(commandedAt.getTime() + durationSec * 1000 + DOWNLINK_LATENCY_BUDGET_SEC * 1000);
      trigger = 'on_valve_schedule';
      volumeSource = flowRate != null ? 'estimated_duration_flow_rate' : 'unknown';
      if (flowRate != null) liters = Math.round(flowRate * durationSec / 60);
    } else {
      commandedAt = new Date(uplinkMs); durationSec = 0; expectedClose = new Date(uplinkMs + 86400000); trigger = 'unexplained'; volumeSource = 'unknown';
    }
    await db.run(`INSERT INTO valve_actuation_expectations(expectation_id, device_eui, zone_id, command_id, effect_key, commanded_at, commanded_duration_seconds, expected_close_at, flow_rate_lpm, flow_rate_source, estimated_gross_liters, volume_source, observed_open_at, reconciliation_state, created_at, trigger)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [crypto.randomUUID(), d.deveui, d.irrigation_zone_id, null, null, commandedAt.toISOString(), durationSec, expectedClose.toISOString(), flowRate, flowSource, liters, volumeSource, new Date(uplinkMs).toISOString(), 'OBSERVED_RUNNING', nowDate.toISOString(), trigger]);
    created += 1;
  }
  return { created };
}

async function runClockTick({ db, now, appId, warn }) {
  const nowDate = now || new Date();
  await store.failStalePushes(db, new Date(nowDate.getTime() - STALE_PUSH_MS).toISOString());
  const valves = await db.all("SELECT d.deveui, iz.timezone AS zone_timezone, vs.strega_generation, vs.last_clock_sync_queued_at FROM devices d LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NULL AND EXISTS (SELECT 1 FROM valve_schedules s WHERE s.device_eui = d.deveui AND s.deleted_at IS NULL)");
  const messages = [];
  for (const v of valves) {
    const tz = v.zone_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const last = v.last_clock_sync_queued_at ? Date.parse(v.last_clock_sync_queued_at) : 0;
    const due = nowDate.getTime() - last >= CLOCK_PERIOD_MS;
    const dst = last && P.isDstTransitionWithin(tz, last, nowDate.getTime());
    if (!due && !dst) continue;
    const q = await push.queuePushes({ db, deviceEui: v.deveui, appId, pushes: [push.buildClockPush(v.strega_generation || 'GEN1', nowDate, tz)], flushQueue: null, warn });
    await store.upsertSettings(db, v.deveui, { last_clock_sync_queued_at: nowDate.toISOString() });
    messages.push(...q.messages);
  }
  return { messages };
}

// Hourly housekeeping that rides on the clock tick:
//  (a) SKIP_TODAY resets to ACTIVE once the valve's local date has moved past skip_today_date;
//  (b) a gateway clock jump > 5 min since the previous tick forces a GEN1 clock re-sync for every scheduled valve;
//  (c) decommission sweep: a STREGA device soft-deleted (deleted_at set) that still has an ACKED non-empty plan
//      gets seven empty weekday pushes (GEN1) / an all-days empty FPort 25 (GEN2) plus FPort 21 '2'.
let lastClockTickMs = null;
async function runHousekeeping({ db, now, appId, warn }) {
  const nowDate = now || new Date();
  const out = { resets: 0, clockJump: false, decommissioned: 0, messages: [] };
  const skips = await db.all("SELECT vs.device_eui, vs.skip_today_date, iz.timezone AS zone_timezone FROM valve_settings vs JOIN devices d ON d.deveui = vs.device_eui LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id WHERE vs.scheduler_status='SKIP_TODAY'");
  for (const s of skips) {
    const lp = P.localParts(nowDate, s.zone_timezone || 'UTC');
    const today = `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}`;
    if (!s.skip_today_date || today > s.skip_today_date) { await store.upsertSettings(db, s.device_eui, { scheduler_status: 'ACTIVE', skip_today_date: null }); out.resets += 1; }
  }
  if (lastClockTickMs != null && Math.abs(nowDate.getTime() - lastClockTickMs - 3600000) > 5 * 60000) {
    out.clockJump = true;
    await db.run("UPDATE valve_settings SET last_clock_sync_queued_at = NULL WHERE device_eui IN (SELECT device_eui FROM valve_schedules WHERE deleted_at IS NULL)");
    warn && warn('[valve-control] gateway clock jump detected; forcing valve clock re-sync');
  }
  lastClockTickMs = nowDate.getTime();
  const gone = await db.all("SELECT d.deveui, COALESCE(vs.strega_generation,'GEN1') AS gen FROM devices d LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui WHERE d.type_id='STREGA_VALVE' AND d.deleted_at IS NOT NULL AND EXISTS (SELECT 1 FROM valve_schedule_pushes p WHERE p.device_eui = d.deveui AND p.purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND p.state='ACKED' AND p.plan_hash <> ?) AND NOT EXISTS (SELECT 1 FROM valve_schedule_pushes p2 WHERE p2.device_eui = d.deveui AND p2.purpose='SCHEDULER_STATUS' AND p2.payload_hex='32' AND p2.queued_at > d.deleted_at)", [P.planHash([])]);
  for (const g of gone) {
    const days = Array.from({ length: 7 }, () => []);
    const pushes = push.buildPlanPushes({ generation: g.gen, days, lastHashes: {}, force: true }).concat([push.buildStatusPush('2')]);
    const q = await push.queuePushes({ db, deviceEui: g.deveui, appId, pushes, flushQueue: null, warn });
    out.messages.push(...q.messages); out.decommissioned += 1;
  }
  return out;
}

module.exports = { handleUplink, runOnceTick, runObserveTick, runClockTick, runHousekeeping, ONCE_GRACE_MS };
```
Note: `queuePushes` with `flushQueue: null` never flushes (clock ticks must not flush a pending manual open). `runHousekeeping` runs BEFORE `runClockTick` in the clock node (Task 8 `clockFunc`: call `VC.runHousekeeping(...)` first, append its `messages` to the clock tick's messages). Add tests: SKIP_TODAY resets when `now` is the next local day; a soft-deleted device with an ACKED non-empty plan yields 7 empty pushes + one FPort 21 `'2'`; a second run yields none.

The trigger backfill (Task 9) also fills volume on rows with `volume_source='unknown'` when a per-valve or zone flow rate exists and `commanded_duration_seconds > 0`: set `flow_rate_lpm`, `flow_rate_source` (`valve_measured|valve_estimated|zone_calibration`), `estimated_gross_liters = round(rate × seconds / 60)`, `volume_source='estimated_duration_flow_rate'`. This keeps Recent irrigations consistent with the dialogs without touching `write-strega-expectation`.

- [ ] **Step 3: Tests green; export; commit**

`index.js` → `module.exports = { ...plan, ...ack, ...api, ...workers, store, push }`.
```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/*.test.js
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/
git commit -m "feat(valve-control): uplink ACK handling, one-time tick, observed on-valve runs, clock tick"
```

---

### Task 7: Register the helper on all four surfaces

**Files:**
- Modify: `conf/.../node-red/osi-lib/index.js` (`NAME_TO_PATH`), `osi-lib/index.test.js`, `conf/.../node-red/package.json`, `package-lock.json`, `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed` (module loop), `deploy.sh` (`fetch_required` for every file of the module)

- [ ] **Step 1: Add the registry entry and its loader test**

`osi-lib/index.js`: add `'osi-valve-control': 'osi-valve-control',` to `NAME_TO_PATH`.
`osi-lib/index.test.js`: add `'osi-valve-control'` to the list near line 33 and `assert.equal(osiLib.NAME_TO_PATH['osi-valve-control'], 'osi-valve-control');` next to the uc512 assertion.

- [ ] **Step 2: package.json / package-lock.json**

`conf/.../node-red/package.json` dependencies: `"osi-valve-control": "file:osi-valve-control"` (after `osi-lsn50-normalize`). In `package-lock.json`, mirror the `osi-uc512-normalize` entries (root `dependencies` entry `"osi-valve-control": "file:osi-valve-control"`, and a `"node_modules/osi-valve-control": { "resolved": "osi-valve-control", "link": true }` block plus the `"osi-valve-control": { "version": "1.0.0" }` package block — copy the exact shape of the uc512 entries).

- [ ] **Step 3: Seed loop + deploy.sh**

`98_osi_node_red_seed`: append `osi-valve-control` to the `for module in …` list.
`deploy.sh`: after the `osi-uc512-normalize index.js` block, add `fetch_required` lines for `package.json`, `index.js`, `plan.js`, `ack.js`, `store.js`, `push.js`, `api.js`, `workers.js` of `osi-valve-control` (target `/srv/node-red/osi-valve-control/<file>`), copying the existing three-line `fetch_required` format exactly.

- [ ] **Step 4: Verify and commit**

```bash
node scripts/verify-helper-registration.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
git add -A conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed deploy.sh
git commit -m "chore(valve-control): register osi-valve-control helper (osi-lib, package, seed loop, deploy.sh)"
```

---

### Task 8: flows.json — thin nodes for API, pushes, ACKs, once/observe/clock ticks

**Files:**
- Modify (via one-shot script only): both `flows.json` profiles
- Modify: `scripts/test-flows-wiring.js` (new pins), `scripts/verify-flows-size-ratchet-allowances.json` (no entry needed if all new nodes are thin; the `link in` `links` edit is not JS growth)

**Interfaces:**
- Consumes: `osi-valve-control` exports from Tasks 2–7; existing `link in` `5974306566e99a92` (actuator path), mqtt broker config `b0b19352dac3fb34`, env `CHIRPSTACK_APP_ACTUATORS`, `DEVICE_EUI`, `AUTH_TOKEN_SECRET`/`JWT_SECRET`.
- Produces: routes `GET /api/valves`, `GET|POST /api/valves/:deveui/schedules`, `PUT|DELETE /api/valves/:deveui/schedules/:uuid`, `POST /api/valves/:deveui/plan/resend`, `POST /api/valves/:deveui/scheduler-status`, `PUT /api/valves/:deveui/settings`; nodes listed in the file map.

- [ ] **Step 1: Roundtrip guard and blast-radius check**

Write `<scratchpad>/roundtrip-check.js` from the skill skeleton and run it on both profiles (`byte-identical: true`). Then:
```bash
node -e "
const flows = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
for (const id of ['5974306566e99a92','244a39f37fe623c1','b0b19352dac3fb34']) { const n = flows.find(x=>x.id===id); console.log(id, n.type, n.name||n.label||'', JSON.stringify(n.links||n.wires||'')); }
"
```

- [ ] **Step 2: Write the edit script**

`<scratchpad>/flows-add-valve-control.js` (run from repo root). All `func` bodies below are complete; each is < 4 KB.

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs'); const path = require('path');
const CANONICAL = path.resolve('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.resolve('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
const serialize = (f) => Buffer.from(JSON.stringify(f, null, 2) + '\n', 'utf8');
function guard(p) { const o = fs.readFileSync(p); const parsed = JSON.parse(o.toString('utf8')); if (Buffer.compare(o, serialize(parsed)) !== 0) throw new Error('roundtrip drift ' + p); return parsed; }
const flows = guard(CANONICAL);
const ids = new Set(flows.map((n) => n.id));
const assertNew = (id) => { if (ids.has(id)) throw new Error('id exists: ' + id); ids.add(id); };
const TAB = 'valve-control-tab'; assertNew(TAB);
const BROKER = 'b0b19352dac3fb34';
const ACTUATOR_LINK_IN = '5974306566e99a92';

const LIBS = [{ var: 'osiLib', module: 'osi-lib' }];
const LIBS_WITH_CS = [{ var: 'osiLib', module: 'osi-lib' }, { var: 'chirpstack', module: 'osi-chirpstack-helper' }];

const loaderPrefix = [
  "const dbLoad = osiLib.require('osi-db-helper');",
  "const vcLoad = osiLib.require('osi-valve-control');",
  "if (!dbLoad.ok || !vcLoad.ok) {",
  "  const detail = [dbLoad, vcLoad].filter(function(l) { return !l.ok; }).map(function(l) { return l.error; }).join('; ');",
  "  node.error('Valve control helpers unavailable: ' + detail, msg);",
  "  msg.statusCode = 503; msg.payload = { error: 'valve_control_unavailable', message: detail };",
  "  return [msg, null];",
  "}",
  "const osiDb = dbLoad.value; const VC = vcLoad.value;",
].join('\n');

const routerFunc = loaderPrefix + '\n' + [
  "const appId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();",
  "let flushQueue = null;",
  "try { const client = chirpstack.createProvisioningClientFromEnv(env); flushQueue = function(eui) { return client.flushDeviceQueue(eui); }; }",
  "catch (e) { node.warn('valve-api: chirpstack client unavailable, plan pushes will not flush the queue: ' + (e && e.message ? e.message : e)); }",
  "return VC.handleHttpRequest({",
  "  msg: msg, Database: osiDb.Database, appId: appId, flushQueue: flushQueue,",
  "  environment: { authTokenSecret: env.get('AUTH_TOKEN_SECRET'), jwtSecret: env.get('JWT_SECRET'), deviceEui: env.get('DEVICE_EUI') },",
  "  warn: function(m) { node.warn(m); }",
  "}).then(function(out) {",
  "  const pushes = Array.isArray(out.valvePushMessages) ? out.valvePushMessages : [];",
  "  delete out.valvePushMessages;",
  "  if (!appId && pushes.length) node.warn('valve-api: CHIRPSTACK_APP_ACTUATORS missing; ' + pushes.length + ' downlink(s) not sent');",
  "  const downlinks = appId ? pushes.map(function(p) { return { topic: p.topic, payload: p.payload }; }) : [];",
  "  return [out, downlinks];",
  "});",
].join('\n');

const ackFunc = loaderPrefix.replace('return [msg, null];', 'return null;') + '\n' + [
  "// STREGA uplinks: feed decoded ACK frames to the valve-control push ledger.",
  "const p = msg.payload || {};",
  "const devEui = String((p.deviceInfo && p.deviceInfo.devEui) || p.devEui || '').toUpperCase();",
  "const decoded = p.object || null;",
  "if (!devEui || !decoded) return null;",
  "if (!('Schl_Port' in decoded || 'Schl_status_Port' in decoded || 'RTC_Port' in decoded || decoded.Ack === true)) return null;",
  "return (async () => {",
  "  const db = new osiDb.Database('/data/db/farming.db');",
  "  try {",
  "    const r = await VC.handleUplink({ db: db, deviceEui: devEui, decoded: decoded, fPort: Number(p.fPort), receivedAt: p.time || new Date().toISOString(), warn: function(m) { node.warn(m); } });",
  "    node.status({ fill: 'green', shape: 'dot', text: devEui + ' acked ' + r.acked });",
  "  } catch (e) { node.error('valve-ack: ' + (e && e.message ? e.message : e), msg); }",
  "  finally { await new Promise(function(res) { db.close(function() { res(); }); }); }",
  "  return null;",
  "})();",
].join('\n');

const onceFunc = loaderPrefix.replace('return [msg, null];', 'return null;') + '\n' + [
  "return (async () => {",
  "  const db = new osiDb.Database('/data/db/farming.db');",
  "  try {",
  "    const r = await VC.runOnceTick({ db: db, now: new Date(), gatewayEui: env.get('DEVICE_EUI'), warn: function(m) { node.warn(m); } });",
  "    if (r.fired.length || r.skipped.length) node.status({ fill: 'green', shape: 'dot', text: 'fired ' + r.fired.length + ' skipped ' + r.skipped.length });",
  "    return r.fired.map(function(f) { return { payload: f.actuator_command, _stregaExpectationCommand: { command_type: 'OPEN_FOR_DURATION', device_eui: f.device_eui, duration_seconds: f.duration_minutes * 60, duration_minutes: f.duration_minutes, commandId: f.command_id, trigger: 'one_time' } }; });",
  "  } catch (e) { node.error('valve-once: ' + (e && e.message ? e.message : e)); return null; }",
  "  finally { await new Promise(function(res) { db.close(function() { res(); }); }); }",
  "})().then(function(msgs) { return msgs && msgs.length ? [msgs] : null; });",
].join('\n');

const observeFunc = loaderPrefix.replace('return [msg, null];', 'return null;') + '\n' + [
  "return (async () => {",
  "  const db = new osiDb.Database('/data/db/farming.db');",
  "  try {",
  "    const o = await VC.runObserveTick({ db: db, now: new Date(), warn: function(m) { node.warn(m); } });",
  "    const b = await VC.runTriggerBackfill({ db: db, warn: function(m) { node.warn(m); } });",
  "    if (o.created || b.updated) node.status({ fill: 'green', shape: 'dot', text: 'observed ' + o.created + ' backfilled ' + b.updated });",
  "  } catch (e) { node.error('valve-observe: ' + (e && e.message ? e.message : e)); }",
  "  finally { await new Promise(function(res) { db.close(function() { res(); }); }); }",
  "  return null;",
  "})();",
].join('\n');

const clockFunc = loaderPrefix.replace('return [msg, null];', 'return null;') + '\n' + [
  "const appId = String(env.get('CHIRPSTACK_APP_ACTUATORS') || '').trim();",
  "return (async () => {",
  "  const db = new osiDb.Database('/data/db/farming.db');",
  "  try {",
  "    const h = await VC.runHousekeeping({ db: db, now: new Date(), appId: appId, warn: function(m) { node.warn(m); } });",
  "    const r = await VC.runClockTick({ db: db, now: new Date(), appId: appId, warn: function(m) { node.warn(m); } });",
  "    const all = h.messages.concat(r.messages);",
  "    if (all.length) node.status({ fill: 'green', shape: 'dot', text: 'clock/housekeeping pushes ' + all.length });",
  "    return appId ? all.map(function(m) { return { topic: m.topic, payload: m.payload }; }) : [];",
  "  } catch (e) { node.error('valve-clock: ' + (e && e.message ? e.message : e)); return []; }",
  "  finally { await new Promise(function(res) { db.close(function() { res(); }); }); }",
  "})().then(function(msgs) { return msgs.length ? [msgs] : null; });",
].join('\n');

const nodes = [];
nodes.push({ id: TAB, type: 'tab', label: 'Valve Control', disabled: false, info: 'Valve control module: /api/valves routes, STREGA on-valve scheduler pushes, ACK ledger, one-time opens, observed runs, clock sync (spec docs/superpowers/specs/2026-08-19-valve-control-design.md)', env: [] });

const routes = [
  ['valve-list-get-http', 'get', '/api/valves'],
  ['valve-schedules-get-http', 'get', '/api/valves/:deveui/schedules'],
  ['valve-schedules-post-http', 'post', '/api/valves/:deveui/schedules'],
  ['valve-schedule-put-http', 'put', '/api/valves/:deveui/schedules/:uuid'],
  ['valve-schedule-delete-http', 'delete', '/api/valves/:deveui/schedules/:uuid'],
  ['valve-plan-resend-post-http', 'post', '/api/valves/:deveui/plan/resend'],
  ['valve-scheduler-status-post-http', 'post', '/api/valves/:deveui/scheduler-status'],
  ['valve-settings-put-http', 'put', '/api/valves/:deveui/settings'],
];
routes.forEach(([id, method, url], i) => { assertNew(id); nodes.push({ id, type: 'http in', z: TAB, name: method.toUpperCase() + ' ' + url, url, method, upload: false, swaggerDoc: '', x: 220, y: 80 + i * 50, wires: [['valve-api-router-fn']] }); });

['valve-api-router-fn', 'valve-api-response', 'valve-push-mqtt-out', 'valve-ack-mqtt-in', 'valve-ack-fn', 'valve-once-tick', 'valve-once-fn', 'valve-once-link-out', 'valve-observe-tick', 'valve-observe-fn', 'valve-clock-tick', 'valve-clock-fn'].forEach(assertNew);

nodes.push({ id: 'valve-api-router-fn', type: 'function', z: TAB, name: 'Valve API Router', func: routerFunc, outputs: 2, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: LIBS_WITH_CS, x: 560, y: 250, wires: [['valve-api-response'], ['valve-push-mqtt-out']] });
nodes.push({ id: 'valve-api-response', type: 'http response', z: TAB, name: 'Valve API Response', statusCode: '', headers: {}, x: 860, y: 230, wires: [] });
nodes.push({ id: 'valve-push-mqtt-out', type: 'mqtt out', z: TAB, name: 'Valve plan downlinks → ChirpStack', topic: '', qos: '0', retain: 'false', respTopic: '', contentType: '', userProps: '', correl: '', expiry: '', broker: BROKER, x: 880, y: 290, wires: [] });

nodes.push({ id: 'valve-ack-mqtt-in', type: 'mqtt in', z: TAB, name: 'STREGA ACK IN', topic: 'application/+/device/+/event/up', qos: '0', datatype: 'json', broker: BROKER, nl: false, rap: true, rh: 0, inputs: 0, x: 200, y: 520, wires: [['valve-ack-fn']] });
nodes.push({ id: 'valve-ack-fn', type: 'function', z: TAB, name: 'Valve ACK ledger', func: ackFunc, outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: LIBS, x: 480, y: 520, wires: [[]] });

nodes.push({ id: 'valve-once-tick', type: 'inject', z: TAB, name: 'One-time opens tick (60s)', props: [{ p: 'payload' }], repeat: '60', crontab: '', once: true, onceDelay: 20, topic: '', payload: '', payloadType: 'date', x: 220, y: 620, wires: [['valve-once-fn']] });
nodes.push({ id: 'valve-once-fn', type: 'function', z: TAB, name: 'Fire due one-time opens', func: onceFunc, outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: LIBS, x: 500, y: 620, wires: [['valve-once-link-out']] });
nodes.push({ id: 'valve-once-link-out', type: 'link out', z: TAB, name: 'To Actuator (one-time opens)', mode: 'link', links: [ACTUATOR_LINK_IN], x: 760, y: 620, wires: [] });

nodes.push({ id: 'valve-observe-tick', type: 'inject', z: TAB, name: 'Observe on-valve runs (60s)', props: [{ p: 'payload' }], repeat: '60', crontab: '', once: true, onceDelay: 35, topic: '', payload: '', payloadType: 'date', x: 220, y: 700, wires: [['valve-observe-fn']] });
nodes.push({ id: 'valve-observe-fn', type: 'function', z: TAB, name: 'Observe valve-fired opens + trigger backfill', func: observeFunc, outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: LIBS, x: 540, y: 700, wires: [[]] });

nodes.push({ id: 'valve-clock-tick', type: 'inject', z: TAB, name: 'Valve clock sync tick (1h)', props: [{ p: 'payload' }], repeat: '3600', crontab: '', once: true, onceDelay: 90, topic: '', payload: '', payloadType: 'date', x: 220, y: 780, wires: [['valve-clock-fn']] });
nodes.push({ id: 'valve-clock-fn', type: 'function', z: TAB, name: 'Valve clock sync + stale pushes', func: clockFunc, outputs: 1, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: LIBS, x: 520, y: 780, wires: [['valve-push-mqtt-out']] });

for (const n of nodes) if (n.type === 'function' && n.func.length > 4000) throw new Error(n.id + ' too large: ' + n.func.length);
flows.push(...nodes);
// Register the new link-out on the actuator link-in (a link in lists its sources).
const linkIn = flows.find((n) => n.id === ACTUATOR_LINK_IN);
if (!linkIn.links.includes('valve-once-link-out')) linkIn.links.push('valve-once-link-out');

fs.writeFileSync(CANONICAL, serialize(flows)); fs.writeFileSync(MIRROR, serialize(flows));
guard(CANONICAL); guard(MIRROR);
console.log('added', nodes.length, 'nodes; total', flows.length);
```

Add `runTriggerBackfill` to `workers.js` before running (Task 9 defines it; implement Task 9 Step 1 first, or temporarily make Task 8 and 9 one commit — do Task 9 Step 1 now, then continue here).

- [ ] **Step 3: Run the script and the full flows checklist**

```bash
node <scratchpad>/flows-add-valve-control.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
bash scripts/check-mqtt-topics.sh
node scripts/test-flows-wiring.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-flows-size-ratchet.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
```
Expected: all green. If `test-flows-wiring.js` pins `5974306566e99a92`'s `links` (it pins `wires`; check), update the pin in the same commit with the reason "one-time opens feed the actuator path".

- [ ] **Step 4: Add wiring pins**

In `scripts/test-flows-wiring.js`, in the WS1 STREGA block, add:
```js
// Valve control (2026-08): one-time opens enter the actuator path through their own link-out.
const valveLinkOut = byId('valve-once-link-out');
assert(valveLinkOut && valveLinkOut.type === 'link out' && valveLinkOut.links.includes('5974306566e99a92'), 'valve-once-link-out must target the actuator link-in 5974306566e99a92');
assert(byId('5974306566e99a92').links.includes('valve-once-link-out'), 'actuator link-in must list valve-once-link-out as a source');
for (const id of ['valve-list-get-http','valve-schedules-get-http','valve-schedules-post-http','valve-schedule-put-http','valve-schedule-delete-http','valve-plan-resend-post-http','valve-scheduler-status-post-http','valve-settings-put-http']) {
  assert(byId(id) && JSON.stringify(byId(id).wires) === JSON.stringify([['valve-api-router-fn']]), id + ' must wire to valve-api-router-fn');
}
assert(JSON.stringify(byId('valve-api-router-fn').wires) === JSON.stringify([['valve-api-response'], ['valve-push-mqtt-out']]), 'valve-api-router-fn outputs: response, mqtt out');
assert(byId('valve-ack-mqtt-in').topic === 'application/+/device/+/event/up', 'valve ACK mqtt-in must use the wildcard uplink topic');
```
(Use the file's own helper/assert style — read the surrounding code and match it.)

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-flows-wiring.js
git commit -m "feat(flows): valve-control tab — /api/valves router, plan downlinks, STREGA ACK ledger, one-time/observe/clock ticks"
```

---

### Task 9: Recent irrigations carries `trigger`; trigger backfill worker

**Files:**
- Modify: `conf/.../osi-valve-control/workers.js` (+ tests), flows `get-actuations-query` (SELECT gains `vae.trigger`), `scripts/verify-flows-size-ratchet-allowances.json`, `web/react-gui/src/services/api.ts` (`IrrigationActuation.trigger`)

**Interfaces:**
- Produces: `runTriggerBackfill({db, warn}) -> {updated}`; `IrrigationActuation.trigger: 'manual'|'cloud_command'|'trigger_based'|'one_time'|'on_valve_schedule'|'unexplained'|null`.

- [ ] **Step 1: `runTriggerBackfill` + test**

Append to `workers.js`:
```js
// Fill trigger on expectation rows written by the legacy writer (which does not know the column).
async function runTriggerBackfill({ db, warn }) {
  const rows = await db.all("SELECT expectation_id, device_eui, command_id, commanded_at FROM valve_actuation_expectations WHERE trigger IS NULL ORDER BY commanded_at DESC LIMIT 200");
  let updated = 0;
  for (const r of rows) {
    let trigger = 'manual';
    if (r.command_id) {
      const once = await db.get("SELECT 1 AS x FROM irrigation_events WHERE reason='one_time_open' AND payload_json LIKE ? LIMIT 1", ['%' + r.command_id + '%']);
      if (once) trigger = 'one_time';
      else if (await db.get('SELECT 1 AS x FROM applied_commands WHERE command_id=? LIMIT 1', [r.command_id])) trigger = 'cloud_command';
    }
    if (trigger === 'manual') {
      const log = await db.get("SELECT reason FROM actuator_log WHERE UPPER(deveui)=UPPER(?) AND created_at BETWEEN datetime(?, '-2 minutes') AND datetime(?, '+2 minutes') ORDER BY created_at DESC LIMIT 1", [r.device_eui, r.commanded_at, r.commanded_at]);
      if (log && /^scheduler_/.test(String(log.reason || ''))) trigger = 'trigger_based';
    }
    updated += Number(await db.run('UPDATE valve_actuation_expectations SET trigger=? WHERE expectation_id=? AND trigger IS NULL', [trigger, r.expectation_id])) || 0;
  }
  return { updated };
}
```
Export it. Test (append to `workers.test.js`): insert an expectation row with `trigger NULL` and an `actuator_log` row with `reason='scheduler_threshold'` at the same time → `trigger_based`; a row with no log → `manual`.

- [ ] **Step 2: `get-actuations-query` gains `vae.trigger,`**

One-shot script: find node `get-actuations-query`, replace the substring `      vae.cancel_reason,\n` with `      vae.cancel_reason,\n      vae.trigger,\n` in `func` (assert exactly one occurrence), write both profiles. Add an allowance entry:
```json
"get-actuations-query": { "delta": 20, "reason": "valve control: recent-actuations SELECT exposes valve_actuation_expectations.trigger" }
```
and raise `total_allowance.delta` by 20 with the reason appended. Run the flows checklist from Task 8 Step 3.

- [ ] **Step 3: Pass `trigger` through `api.ts`**

In `web/react-gui/src/services/api.ts` `IrrigationActuation` add `trigger: IrrigationTrigger | null;` with `export type IrrigationTrigger = 'manual'|'cloud_command'|'trigger_based'|'one_time'|'on_valve_schedule'|'unexplained';` and map `row.trigger ?? null` in the normaliser next to `cancelReason`. Add a vitest case in the existing actuations normaliser test (find it with `grep -rn "recentActuations\|normaliseActuation" web/react-gui/src web/react-gui/tests`).

- [ ] **Step 4: Verify, commit**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/*.test.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-profile-parity.js && node scripts/test-flows-wiring.js && node scripts/verify-flows-fn-parse.js
cd web/react-gui && npm run typecheck && npm run test:unit && cd ../..
git add -A conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control conf/*/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json web/react-gui/src/services/api.ts web/react-gui/tests web/react-gui/src
git commit -m "feat: recent actuations expose trigger; valve-control trigger backfill"
```

---

### Task 10: GUI data layer — types, `valvesAPI`, module toggle, i18n namespace

**Files:**
- Modify: `web/react-gui/src/types/farming.ts`, `src/services/api.ts`, `src/utils/displayPreferences.ts`, `src/pages/SettingsPage.tsx`, `src/i18n/config.ts`
- Create: `web/react-gui/public/locales/{en,de-CH,fr,it,es,pt,lg}/valves.json`, `src/components/farming/valves/valveState.ts`, `src/components/farming/valves/__tests__/valveState.test.ts`

**Interfaces (produces):**
```ts
// types/farming.ts
export type StregaGeneration = 'GEN1' | 'GEN2';
export type ValveSchedulerStatus = 'ACTIVE' | 'SKIP_TODAY' | 'DEACTIVATED';
export interface ValveNextRun { at: string; kind: 'WEEKLY' | 'ONCE'; minutes: number; scheduleUuid: string; }
export interface ValveActiveActuation { expectationId: string; reconciliationState: string; commandedAt: string; expectedCloseAt: string; durationSeconds: number | null; trigger: string | null; }
export interface ValvePushState { queued: number; acked: number; failed: number; lastPlanQueuedAt: string | null; lastPlanAckedAt: string | null; }
export interface ValveSummary { deviceEui: string; name: string; zoneId: number | null; zoneName: string | null; zoneUuid: string | null; timezone: string; currentState: 'OPEN'|'CLOSED'|null; targetState: 'OPEN'|'CLOSED'|null; stregaGeneration: StregaGeneration; flowRateLpm: number | null; flowRateSource: 'measured'|'estimated'|'zone'|null; defaultOpenMinutes: number | null; schedulerStatus: ValveSchedulerStatus; skipTodayDate: string | null; lastUplinkAt: string | null; activeActuation: ValveActiveActuation | null; recentStaleState: string | null; nextRun: ValveNextRun | null; scheduleCount: number; pushState: ValvePushState; lastClockSyncAckedAt: string | null; }
export interface ValveSchedule { scheduleUuid: string; deviceEui: string; kind: 'WEEKLY'|'ONCE'; label: string | null; weekdaysMask: number | null; startTime: string | null; fireAt: string | null; durationMinutes: number; timezone: string; enabled: boolean; onceState: 'PENDING'|'FIRED'|'SKIPPED'|'CANCELLED'|null; }
export interface ValveCompiledWindow { onH: number; onM: number; offH: number; offM: number; scheduleUuid: string; label: string | null; }
export interface ValvePlanError { code: 'too_many_windows'|'overlap'; weekday: number; conflicts: string[]; }
export interface ValveWeekdayPush { purpose: string; weekday: number | null; state: 'QUEUED'|'ACKED'|'FAILED'; queuedAt: string; ackedAt: string | null; error: string | null; }
export interface ValveSchedulesResponse { schedules: ValveSchedule[]; compiled: { days: ValveCompiledWindow[][]; errors: ValvePlanError[] }; pushState: ValveWeekdayPush[]; }
export interface ValveScheduleInput { kind: 'WEEKLY'|'ONCE'; label?: string | null; weekdaysMask?: number; startTime?: string; fireAt?: string; durationMinutes: number; enabled?: boolean; }
// services/api.ts
export const valvesAPI = { list(): Promise<ValveSummary[]>; schedules(eui): Promise<ValveSchedulesResponse>; createSchedule(eui, input): Promise<{schedule: ValveSchedule; pushesQueued: number}>; updateSchedule(eui, uuid, patch): Promise<{pushesQueued:number}>; deleteSchedule(eui, uuid): Promise<{pushesQueued:number}>; resendPlan(eui): Promise<{pushesQueued:number}>; setSchedulerStatus(eui, status): Promise<void>; updateSettings(eui, patch: {stregaGeneration?, flowRateLpm?: number|null, flowRateSource?, defaultOpenMinutes?}): Promise<void>; }
// valveState.ts
export type ValveGlyphState = 'closed' | 'pending' | 'open' | 'closing' | 'failed';
export function deriveValveGlyphState(v: ValveSummary, nowMs: number): { state: ValveGlyphState; remainingSeconds: number | null; progress: number | null; closesAt: string | null };
export function estimateLiters(flowRateLpm: number | null, minutes: number): number | null; // rounded to 10 L
export function weekdaysFromMask(mask: number): number[]; export function maskFromWeekdays(days: number[]): number;
export function windowEnd(startTime: string, minutes: number): string; // 'HH:MM' wrapping
```

- [ ] **Step 1: Failing tests for `valveState.ts`**

`src/components/farming/valves/__tests__/valveState.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { deriveValveGlyphState, estimateLiters, weekdaysFromMask, maskFromWeekdays, windowEnd } from '../valveState';
import type { ValveSummary } from '../../../../types/farming';

const base: ValveSummary = { deviceEui: '0016C001F1000001', name: 'A', zoneId: 1, zoneName: 'Z', zoneUuid: 'u', timezone: 'Europe/Zurich', currentState: 'CLOSED', targetState: null, stregaGeneration: 'GEN1', flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null, schedulerStatus: 'ACTIVE', skipTodayDate: null, lastUplinkAt: null, activeActuation: null, recentStaleState: null, nextRun: null, scheduleCount: 0, pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null }, lastClockSyncAckedAt: null };
const now = Date.parse('2026-08-19T10:00:00Z');

describe('deriveValveGlyphState', () => {
  it('closed when no actuation and state CLOSED', () => { expect(deriveValveGlyphState(base, now).state).toBe('closed'); });
  it('pending while PENDING_OBSERVATION', () => {
    const v = { ...base, activeActuation: { expectationId: 'e', reconciliationState: 'PENDING_OBSERVATION', commandedAt: '2026-08-19T09:59:00Z', expectedCloseAt: '2026-08-19T10:31:00Z', durationSeconds: 1800, trigger: 'manual' } };
    expect(deriveValveGlyphState(v, now).state).toBe('pending');
  });
  it('open with progress and remaining while OBSERVED_RUNNING before expected close', () => {
    const v = { ...base, currentState: 'OPEN' as const, activeActuation: { expectationId: 'e', reconciliationState: 'OBSERVED_RUNNING', commandedAt: '2026-08-19T09:50:00Z', expectedCloseAt: '2026-08-19T10:22:00Z', durationSeconds: 1800, trigger: 'on_valve_schedule' } };
    const r = deriveValveGlyphState(v, now);
    expect(r.state).toBe('open'); expect(r.remainingSeconds).toBe(1200); expect(r.progress).toBeCloseTo(1 / 3, 2);
  });
  it('closing after expected close while still OBSERVED_RUNNING', () => {
    const v = { ...base, currentState: 'OPEN' as const, activeActuation: { expectationId: 'e', reconciliationState: 'OBSERVED_RUNNING', commandedAt: '2026-08-19T09:00:00Z', expectedCloseAt: '2026-08-19T09:32:00Z', durationSeconds: 1800, trigger: 'manual' } };
    expect(deriveValveGlyphState(v, now).state).toBe('closing');
  });
  it('failed on a recent STALE state or a failed push', () => {
    expect(deriveValveGlyphState({ ...base, recentStaleState: 'STALE_NO_OBSERVATION' }, now).state).toBe('failed');
    expect(deriveValveGlyphState({ ...base, pushState: { ...base.pushState, failed: 1 } }, now).state).toBe('failed');
  });
  it('open with unknown duration (unexplained) has null progress', () => {
    const v = { ...base, currentState: 'OPEN' as const, activeActuation: { expectationId: 'e', reconciliationState: 'OBSERVED_RUNNING', commandedAt: '2026-08-19T09:50:00Z', expectedCloseAt: '2026-08-20T09:50:00Z', durationSeconds: 0, trigger: 'unexplained' } };
    const r = deriveValveGlyphState(v, now); expect(r.state).toBe('open'); expect(r.progress).toBeNull(); expect(r.remainingSeconds).toBeNull();
  });
});

describe('helpers', () => {
  it('estimateLiters rounds to 10 L and keeps null', () => { expect(estimateLiters(12.5, 30)).toBe(380); expect(estimateLiters(null, 30)).toBeNull(); });
  it('mask round trip', () => { expect(weekdaysFromMask(0b1000101)).toEqual([0, 2, 6]); expect(maskFromWeekdays([1, 3, 5])).toBe(0b0101010); });
  it('windowEnd wraps midnight', () => { expect(windowEnd('23:05', 65)).toBe('00:10'); expect(windowEnd('06:00', 90)).toBe('07:30'); });
});
```

- [ ] **Step 2: Implement `valveState.ts`**

```ts
import type { ValveSummary } from '../../../types/farming';
export type ValveGlyphState = 'closed' | 'pending' | 'open' | 'closing' | 'failed';

export function deriveValveGlyphState(v: ValveSummary, nowMs: number) {
  const a = v.activeActuation;
  const failed = (v.recentStaleState !== null && v.recentStaleState.startsWith('STALE_')) || v.pushState.failed > 0;
  if (a && a.reconciliationState === 'PENDING_OBSERVATION') {
    return { state: 'pending' as const, remainingSeconds: null, progress: null, closesAt: a.durationSeconds ? a.expectedCloseAt : null };
  }
  if (a && a.reconciliationState === 'OBSERVED_RUNNING') {
    const started = Date.parse(a.commandedAt);
    const closes = Date.parse(a.expectedCloseAt);
    if (!a.durationSeconds) return { state: 'open' as const, remainingSeconds: null, progress: null, closesAt: null };
    const end = started + a.durationSeconds * 1000;
    if (nowMs >= closes) return { state: 'closing' as const, remainingSeconds: 0, progress: 1, closesAt: new Date(end).toISOString() };
    const remaining = Math.max(0, Math.round((end - nowMs) / 1000));
    return { state: 'open' as const, remainingSeconds: remaining, progress: Math.min(1, Math.max(0, (nowMs - started) / (a.durationSeconds * 1000))), closesAt: new Date(end).toISOString() };
  }
  if (failed) return { state: 'failed' as const, remainingSeconds: null, progress: null, closesAt: null };
  if (v.currentState === 'OPEN') return { state: 'open' as const, remainingSeconds: null, progress: null, closesAt: null };
  return { state: 'closed' as const, remainingSeconds: null, progress: null, closesAt: null };
}

export function estimateLiters(flowRateLpm: number | null, minutes: number): number | null {
  if (flowRateLpm === null || !Number.isFinite(flowRateLpm) || flowRateLpm <= 0) return null;
  return Math.round((flowRateLpm * minutes) / 10) * 10;
}
export function weekdaysFromMask(mask: number): number[] { return [0, 1, 2, 3, 4, 5, 6].filter((d) => (mask >> d) & 1); }
export function maskFromWeekdays(days: number[]): number { return days.reduce((m, d) => m | (1 << d), 0); }
export function windowEnd(startTime: string, minutes: number): string {
  const [h, m] = startTime.split(':').map(Number);
  const end = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}
```
Note the `failed` precedence: an active actuation wins over a stale history so a running valve never shows as failed.

- [ ] **Step 3: Types + `valvesAPI`**

Add the interfaces from the Interfaces block to `types/farming.ts`. In `api.ts` add a `normaliseValveSummary(row)` / `normaliseValveSchedule(row)` pair (snake→camel, `Boolean(row.enabled)`, `String(row.device_eui).toUpperCase()`), and:
```ts
export const valvesAPI = {
  list: async (): Promise<ValveSummary[]> => { const r = await api.get<{ valves: unknown[] }>('/api/valves'); return (r.data?.valves ?? []).map(normaliseValveSummary); },
  schedules: async (eui: string): Promise<ValveSchedulesResponse> => { const r = await api.get(`/api/valves/${eui}/schedules`); return normaliseValveSchedules(r.data); },
  createSchedule: async (eui: string, input: ValveScheduleInput) => { const r = await api.post(`/api/valves/${eui}/schedules`, toScheduleBody(input)); return { schedule: normaliseValveSchedule(r.data.schedule), pushesQueued: Number(r.data.pushes_queued ?? 0) }; },
  updateSchedule: async (eui: string, uuid: string, patch: Partial<ValveScheduleInput>) => { const r = await api.put(`/api/valves/${eui}/schedules/${uuid}`, toScheduleBody(patch)); return { pushesQueued: Number(r.data.pushes_queued ?? 0) }; },
  deleteSchedule: async (eui: string, uuid: string) => { const r = await api.delete(`/api/valves/${eui}/schedules/${uuid}`); return { pushesQueued: Number(r.data.pushes_queued ?? 0) }; },
  resendPlan: async (eui: string) => { const r = await api.post(`/api/valves/${eui}/plan/resend`, {}); return { pushesQueued: Number(r.data.pushes_queued ?? 0) }; },
  setSchedulerStatus: async (eui: string, status: ValveSchedulerStatus) => { await api.post(`/api/valves/${eui}/scheduler-status`, { status }); },
  updateSettings: async (eui: string, patch: { stregaGeneration?: StregaGeneration; flowRateLpm?: number | null; flowRateSource?: 'measured' | 'estimated'; defaultOpenMinutes?: number }) => { await api.put(`/api/valves/${eui}/settings`, { strega_generation: patch.stregaGeneration, flow_rate_lpm: patch.flowRateLpm, flow_rate_source: patch.flowRateSource, default_open_minutes: patch.defaultOpenMinutes }); },
};
```
`toScheduleBody` maps camelCase → `kind, label, weekdays_mask, start_time, fire_at, duration_minutes, enabled` and omits undefined keys. A 422 `plan_conflict` must surface to callers: export `export class ValvePlanConflictError extends Error { details: ValvePlanError[] }` and throw it from `createSchedule`/`updateSchedule` when `error.response?.status === 422 && error.response.data?.error === 'plan_conflict'`.

- [ ] **Step 4: Module toggle**

`displayPreferences.ts`: add `valveControl: 'osi.modules.valveControl'` to `MODULE_KEYS`, `valveControl: boolean` to `ModulePreferences`, `valveControl: true` to `DEFAULT_MODULES`. `SettingsPage.tsx`: add a `ModuleRow` with `label={t('valveControl')}` after the `irrigationSchedule` row (plain `updateModule('valveControl', enabled)`).

- [ ] **Step 5: i18n namespace**

`src/i18n/config.ts`: add `'valves'` to `ns`. Create `public/locales/en/valves.json`:
```json
{
  "title": "Valve control",
  "subtitle": "All valves, all zones. Weekly plans run on the valve itself.",
  "empty": "No STREGA valves registered yet.",
  "unassignedZone": "Unassigned",
  "open": "Open",
  "schedule": "Schedule",
  "cancel": "Cancel",
  "more": "More",
  "skipToday": "Skip today",
  "pauseSchedules": "Pause all schedules",
  "resumeSchedules": "Resume schedules",
  "resendPlan": "Re-send plan to valve",
  "settings": "Valve settings",
  "state": { "closed": "Closed", "pending": "Waiting for valve", "open": "Open", "closing": "Closing", "failed": "Attention" },
  "pendingHint": "Next contact ≤ {{minutes}} min",
  "closesAt": "closes ≈ {{time}}",
  "remaining": "{{minutes}} min left",
  "nextRun": "Next: {{when}} · {{minutes}} min",
  "nextRunOnce": "Next: {{when}} · {{minutes}} min (one-time, gateway-timed)",
  "noSchedule": "No schedule",
  "schedulerPaused": "Schedules paused",
  "skippedToday": "Skipped today",
  "planDelivery": "Plan delivery: {{acked}} of {{total}} days acknowledged",
  "planDeliveryEta": "≈ {{minutes}} min remaining",
  "planFailed": "{{count}} downlink(s) not acknowledged in 24 h",
  "lastSent": "Last sent {{when}}",
  "bluetoothNote": "Changes made on the valve over Bluetooth are not visible here.",
  "openDialog": { "title": "Open {{name}}", "duration": "Duration (min)", "custom": "Custom", "summary": "closes ≈ {{time}}", "liters": "≈ {{liters}} L", "confirm": "Open for {{minutes}} min", "error": "Could not send the open command." },
  "scheduleDialog": {
    "title": "Schedules for {{name}}", "week": "Compiled week (what the valve will run)", "windows": "{{count}} of 4 windows", "noWindows": "—",
    "list": "Schedules", "addWeekly": "+ Weekly", "addOnce": "+ One-time",
    "label": "Label (optional)", "weekdays": "Days", "startTime": "Start", "duration": "Duration (min)", "date": "Date", "time": "Time",
    "preview": "{{days}} {{start}}–{{end}} · {{minutes}} min", "previewLiters": "≈ {{liters}} L",
    "onceNote": "One-time opens are sent by the gateway at that minute; the gateway must be online.",
    "save": "Save", "saving": "Saving…", "delete": "Delete", "enabled": "Enabled",
    "conflictTooMany": "{{weekday}} would have more than 4 windows.", "conflictOverlap": "Overlaps another window on {{weekday}}.",
    "push": { "QUEUED": "waiting for valve", "ACKED": "acknowledged {{when}}", "FAILED": "failed" }
  },
  "settingsDialog": { "title": "Valve settings", "generation": "Valve generation", "gen2Untested": "GEN2 (SV2, untested on hardware)", "flowRate": "Flow rate (L/min)", "flowSource": "Source", "measured": "Measured", "estimated": "Estimated", "clear": "Clear", "save": "Save" },
  "weekdays": { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat" },
  "trigger": { "manual": "Manual", "cloud_command": "Cloud", "trigger_based": "Trigger-based", "one_time": "One-time", "on_valve_schedule": "Scheduled (on valve)", "unexplained": "Opened on valve" }
}
```
Author `de-CH/valves.json` with real German (Phil reviews): "Ventilsteuerung", "Alle Ventile, alle Zonen. Wochenpläne laufen auf dem Ventil selbst.", "Öffnen", "Zeitplan", "Heute auslassen", "Plan erneut ans Ventil senden", "Wartet auf Ventil", "schliesst ≈ {{time}}", "Nächster Lauf: {{when}} · {{minutes}} min", "Planübertragung: {{acked}} von {{total}} Tagen bestätigt", "Änderungen direkt am Ventil (Bluetooth) sind hier nicht sichtbar.", weekdays "So Mo Di Mi Do Fr Sa", triggers "Manuell / Cloud / Sensorgesteuert / Einmalig / Zeitplan (auf Ventil) / Am Ventil geöffnet". For fr/it/es/pt/lg copy the English file verbatim as a machine-draft placeholder (the i18n review programme picks them up; note this in the commit message).

- [ ] **Step 6: Verify, commit**

```bash
cd web/react-gui && npm run typecheck && npm run test:unit && cd ../..
git add web/react-gui/src web/react-gui/public/locales
git commit -m "feat(gui): valve-control data layer — types, valvesAPI, glyph state derivation, module toggle, valves i18n namespace"
```

---

### Task 11: GUI components — glyph, tile, Open dialog, Schedule dialog, panel

**Files:**
- Create under `web/react-gui/src/components/farming/valves/`: `ValveGlyph.tsx`, `ValveTile.tsx`, `ValveOpenDialog.tsx`, `ValveScheduleDialog.tsx`, `ValveSettingsDialog.tsx`, `ValveControlPanel.tsx`, `__tests__/ValveOpenDialog.test.tsx`, `__tests__/ValveScheduleDialog.test.tsx`
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx`, `src/components/farming/IrrigationOutcomesPanel.tsx`

Look first at how existing dialogs/modals are built (`grep -rn "role=\"dialog\"\|useDismissOnPointerDown" web/react-gui/src/components | head`) and reuse that pattern and the design tokens (`var(--surface)`, `var(--border)`, `var(--toggle-on)`, `FEEDBACK_STYLES` in `StregaValveCard.tsx`). Load the `frontend-design` skill before writing JSX.

- [ ] **Step 1: `ValveGlyph.tsx`**

One inline SVG (viewBox 0 0 64 64): a valve body (horizontal pipe + gate + wheel), a droplet group below the outlet, and a progress ring around the body. Props: `{ state: ValveGlyphState; progress: number | null; size?: number; reducedMotion?: boolean }`. Visuals:
- `closed`: stroke `var(--text-muted)`, gate down, no droplets.
- `pending`: dashed stroke (`strokeDasharray="4 3"`) in amber (`#b45309`/token), small clock badge top-right.
- `open`: body filled blue (`#2563eb` light / `#60a5fa` dark via currentColor on a `text-blue-600 dark:text-blue-400` wrapper), gate up, three droplets with a CSS `@keyframes valve-drip` translateY animation (disabled when `prefers-reduced-motion` or `reducedMotion`), ring stroke-dashoffset from `progress` when not null.
- `closing`: hollow body, hourglass badge.
- `failed`: closed body + red alert badge.
Export also `valveGlyphLabel(state, t)` for `aria-label`.

- [ ] **Step 2: `ValveTile.tsx`**

Props: `{ valve: ValveSummary; nowMs: number; onOpen(): void; onSchedule(): void; onCancel(): void; onSkipToday(): void; onPause(): void; onResume(): void; onResend(): void; onSettings(): void; busy: boolean }`. Layout (Tailwind, matches the unassigned-device tiles): card `rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col gap-3`; header row = glyph (48 px) + name (`font-semibold`) + zone chip (`text-xs rounded-full px-2 py-0.5 bg-[var(--card)]`); status line from `deriveValveGlyphState` (`t('state.*')`, plus `pendingHint` when pending and `reportingIntervalMin` known — derive from `lastUplinkAt`? no: show `pendingHint` only when `valve.lastUplinkAt` exists, minutes = `Math.max(1, Math.ceil(…))` using the device's interval if exposed, else omit the number — keep it honest); next-run line (`nextRun` / `nextRunOnce` / `noSchedule` / `schedulerPaused` / `skippedToday`); plan-delivery line when `pushState.queued > 0` (`planDelivery` with `acked`/`total` = acked + queued) or `planFailed` when `failed > 0`; buttons row `grid grid-cols-2 gap-2`: **Open** (becomes **Cancel** when `activeActuation?.reconciliationState === 'PENDING_OBSERVATION'`) and **Schedule**; overflow `⋯` button opening a small menu (`useDismissOnPointerDown`) with Skip today / Pause or Resume / Re-send plan / Settings.

- [ ] **Step 3: `ValveOpenDialog.tsx` + test**

Props `{ valve: ValveSummary; open: boolean; onClose(): void; onSubmit(minutes: number): Promise<void> }`. State: `minutes` initialised to `valve.defaultOpenMinutes ?? 5`. Chips 15/30/60 + numeric input (1–255, `inputMode="numeric"`). Live summary `closes ≈ HH:MM` (now + minutes, `Intl.DateTimeFormat` in `valve.timezone`) and `≈ N L` when `estimateLiters(valve.flowRateLpm, minutes)` is not null. Confirm button label `openDialog.confirm`. Test: renders default 5, chip click sets 30, litres hidden when flow rate null and shown as "≈ 380 L" for 12.5 L/min × 30 min, submit passes minutes, out-of-range disables confirm.

- [ ] **Step 4: `ValveScheduleDialog.tsx` + test**

Props `{ valve: ValveSummary; open: boolean; onClose(): void; onChanged(): void }`. On open, `valvesAPI.schedules(eui)` via SWR key `/api/valves/${eui}/schedules`. Sections: compiled week (7 columns, each listing `HH:MM–HH:MM` per window, `windows` count `n of 4`, push state badge per weekday from `pushState` for GEN1 `weekday`, or a single badge for GEN2), Bluetooth note, schedule list (label/days/start/duration or date/time; enabled toggle → `updateSchedule`; delete), forms: Weekly (weekday chips, `<input type="time">`, duration number 1–1439, label) and One-time (`<input type="date">`, `<input type="time">`, duration 1–255, label, `onceNote`); preview line using `windowEnd` and `estimateLiters`; save → `createSchedule`; on `ValvePlanConflictError` render `conflictTooMany` / `conflictOverlap` with the weekday name under the form; after any mutation call `mutate()` and `onChanged()`. Test: renders schedules from a mocked API, shows `2 of 4 windows` for a weekday with two windows, renders the conflict message when the API rejects with `plan_conflict` on weekday 2, and a one-time form builds `fireAt` as the ISO instant of the chosen local date+time in `valve.timezone`.

- [ ] **Step 5: `ValveSettingsDialog.tsx`**

Generation select (GEN1 / `gen2Untested`), flow rate number + source radio + Clear, Save → `valvesAPI.updateSettings`.

- [ ] **Step 6: `ValveControlPanel.tsx` and dashboard mount**

`ValveControlPanel` = `<section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">` with `h2 {t('title')}` + subtitle, SWR `valvesAPI.list` (`refreshInterval: 10_000`), a 1-second `nowMs` ticker only while any valve is `open`/`pending`, grid `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4` of `ValveTile`, the three dialogs keyed by selected EUI, `empty` state. Actions: Open → `devicesAPI.controlValve(eui, { action: 'OPEN_FOR_DURATION', duration_seconds: minutes * 60 })` then `valvesAPI.updateSettings(eui, { defaultOpenMinutes: minutes })`, then `mutate()` + `onUpdate()`; Cancel → `devicesAPI.cancelIrrigation`; Skip today / Pause / Resume → `setSchedulerStatus`; Re-send → `resendPlan`.
`FarmingDashboard.tsx`: after the zones section (line ≈ 206) and before the unassigned-devices box: `{modules.valveControl && (<div className="mt-8"><ValveControlPanel onUpdate={handleUpdate} /></div>)}` — read how `modules` is obtained in `IrrigationZoneCard` (`useDisplayPreferences` or prop) and do the same.
`IrrigationOutcomesPanel.tsx`: next to the status badge render `t('valves:trigger.<trigger>')` as a muted chip when `actuation.trigger` is set.

- [ ] **Step 7: Verify and commit**

```bash
cd web/react-gui && npm run typecheck && npm run test:unit && npm run build && cd ../..
git add web/react-gui/src
git commit -m "feat(gui): Valve control panel — tiles, five-state glyph, Open/Schedule/Settings dialogs, trigger chip in Recent irrigations"
```

---

### Task 12: Rename "Irrigation schedule" → "Trigger-based irrigation" (7 locales) and history labels

**Files:**
- Modify: `web/react-gui/public/locales/*/devices.json` (`schedule.irrigationSchedule`, `schedule.triggerHint`), `*/settings.json` (`irrigationSchedule`), `*/history.json` (`irrigationTimeline.eventLabel.scheduled` + new `onValveSchedule`, `oneTime`, `unexplained`), `web/react-gui/src/components/farming/IrrigationEventTimelineView.tsx` (label mapping from `trigger`/reason)

- [ ] **Step 1: Apply the new strings**

| key | en | de-CH | fr | it | es | pt | lg |
|---|---|---|---|---|---|---|---|
| `schedule.irrigationSchedule` | Trigger-based irrigation | Sensorgesteuerte Bewässerung | Irrigation déclenchée par capteur | Irrigazione attivata da sensore | Riego activado por sensor | Irrigação acionada por sensor | Okufukirira okusinziira ku ssensa |
| `settings.irrigationSchedule` | same as above | … | … | … | … | … | … |
| `schedule.triggerHint` | Trigger if {{metric}} ≥ {{threshold}} kPa (checked once a day at 06:00). | Auslösen, wenn {{metric}} ≥ {{threshold}} kPa (Prüfung einmal täglich um 06:00). | Déclenche si {{metric}} ≥ {{threshold}} kPa (vérifié une fois par jour à 06:00). | Attiva se {{metric}} ≥ {{threshold}} kPa (controllo una volta al giorno alle 06:00). | Activa si {{metric}} ≥ {{threshold}} kPa (se comprueba una vez al día a las 06:00). | Aciona se {{metric}} ≥ {{threshold}} kPa (verificado uma vez por dia às 06:00). | keep current lg wording, replace only the module name |
| `history.irrigationTimeline.eventLabel.scheduled` | Trigger-based irrigation | Sensorgesteuerte Bewässerung | (fr) | (it) | (es) | (pt) | (lg) |
| `…eventLabel.onValveSchedule` | Scheduled (on valve) | Zeitplan (auf Ventil) | Programmé (sur la vanne) | Programmato (sulla valvola) | Programado (en la válvula) | Agendado (na válvula) | Enteekateeka (ku valve) |
| `…eventLabel.oneTime` | One-time open | Einmalige Öffnung | Ouverture unique | Apertura singola | Apertura única | Abertura única | Okuggula omulundi gumu |
| `…eventLabel.unexplained` | Opened on valve | Am Ventil geöffnet | Ouvert sur la vanne | Aperta sulla valvola | Abierta en la válvula | Aberta na válvula | Eggulwa ku valve |

Keep `lg` changes minimal and flag them for the native pass (memory: lg human-native pass is the Uganda gate).

- [ ] **Step 2: Wire the history label**

In `IrrigationEventTimelineView.tsx`, where `eventLabel.scheduled`/`manualOverride` are chosen, prefer the actuation `trigger` when present: `on_valve_schedule → onValveSchedule`, `one_time → oneTime`, `unexplained → unexplained`, `trigger_based → scheduled`, else the existing logic. Add a vitest case.

- [ ] **Step 3: Verify, commit**

```bash
cd web/react-gui && npm run typecheck && npm run test:unit && cd ../..
git add web/react-gui/public/locales web/react-gui/src
git commit -m "feat(i18n): rename threshold scheduler to Trigger-based irrigation; on-valve/one-time history labels (7 locales)"
```

---

### Task 13: Sync contract documents (edge→cloud `VALVE_SCHEDULE`)

**Files:**
- Modify: `docs/contracts/sync-schema/resources.schema.json`, `events.schema.json`, `canonicalization.md`, `README.md`

- [ ] **Step 1: Resource + op**

`resources.schema.json` `definitions`: add
```json
"ValveSchedule": {
  "type": "object",
  "required": ["schedule_uuid", "device_eui", "kind", "duration_minutes", "timezone"],
  "properties": {
    "schedule_uuid": { "type": "string" },
    "device_eui": { "type": "string", "pattern": "^[0-9A-F]{16}$" },
    "kind": { "type": "string", "enum": ["WEEKLY", "ONCE"] },
    "label": { "type": ["string", "null"] },
    "weekdays_mask": { "type": ["integer", "null"], "minimum": 1, "maximum": 127, "description": "bit0=Sunday … bit6=Saturday (STREGA order)" },
    "start_time": { "type": ["string", "null"], "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
    "fire_at": { "type": ["string", "null"], "format": "date-time" },
    "duration_minutes": { "type": "integer", "minimum": 1, "maximum": 1439 },
    "timezone": { "type": "string" },
    "enabled": { "type": "integer", "enum": [0, 1] },
    "once_state": { "type": ["string", "null"], "enum": ["PENDING", "FIRED", "SKIPPED", "CANCELLED", null] },
    "sync_version": { "type": "integer" },
    "deleted_at": { "type": ["string", "null"] }
  }
}
```
`events.schema.json`: add `VALVE_SCHEDULE_UPSERTED` to the op enum and `VALVE_SCHEDULE` to the aggregate-type enum (find both enums; keep alphabetical/insertion convention used there).

- [ ] **Step 2: Canonicalization + README**

`canonicalization.md`: add a "Valve schedule" section: weekday bit order, `start_time` as zero-padded `HH:MM`, `fire_at` as UTC ISO with milliseconds, `timezone` IANA; golden vector: `weekdays_mask 3 = Sunday+Monday`. `README.md` contract table: add the row for `VALVE_SCHEDULE` (edge canonical, cloud mirror, Phase B pending).

- [ ] **Step 3: Verify + commit**

```bash
node scripts/verify-sync-contract.js 2>/dev/null || ls scripts | grep -i contract   # run whichever contract verifier exists
node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/sync-schema/canonicalization.md docs/contracts/sync-schema/README.md
git add docs/contracts/sync-schema
git commit -m "docs(contract): VALVE_SCHEDULE resource + VALVE_SCHEDULE_UPSERTED op"
```

---

### Task 14: Documentation — AGENTS.md, system map, skill pointer

**Files:**
- Modify: `AGENTS.md` (new "Valve control" paragraph next to "STREGA timed irrigation"; rename mention), `docs/architecture/system-map/03-edge-backend-flows.md` and `docs/architecture/system-map-technical/03-edge-backend-flows.md` (new tab + ticks; scheduler paragraph renamed), `.claude/skills/osi-agronomy-sensors-reference/SKILL.md` (STREGA section: scheduler FPorts 14–20/25, 21, 12/13, pointer to `docs/hardware/strega-codecs/`)

- [ ] **Step 1: Write the paragraphs**

AGENTS.md, after the STREGA timed irrigation paragraph:
> **Valve control (2026-08):** `ValveControlPanel` lists every STREGA valve across zones. Weekly schedules (`valve_schedules`, kind `WEEKLY`) are compiled by `osi-valve-control` into the valve's own scheduler (Gen1 FPort 14–20 one weekday per downlink, Gen2 FPort 25 day-mask; ≤ 4 windows per weekday) and pushed only on a user change or explicit re-send — never on a timer, so Bluetooth edits on an SV2 are not overwritten. Push delivery is tracked in `valve_schedule_pushes` via the uplink ACK (`Schl_Port`). One-time opens (kind `ONCE`) are gateway-fired FPort 2 through the actuator link; missed by > 10 min → skipped, never late. The gateway owns the valve clock (Gen1 FPort 12 local wall-clock, weekly + after DST). Valve-fired opens are observed from uplinks into `valve_actuation_expectations` with `trigger='on_valve_schedule'`. The threshold scheduler is now labelled "Trigger-based irrigation" in the GUI; its behaviour is unchanged.

System map: add the `Valve Control` tab and its four ticks (60 s once, 60 s observe, 1 h clock, ACK mqtt-in) to the timing table; rename "Irrigation scheduler" row text.

- [ ] **Step 2: Slop-check and commit**

```bash
node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md docs/architecture/system-map/03-edge-backend-flows.md docs/architecture/system-map-technical/03-edge-backend-flows.md .claude/skills/osi-agronomy-sensors-reference/SKILL.md
git add AGENTS.md docs/architecture .claude/skills/osi-agronomy-sensors-reference/SKILL.md
git commit -m "docs: valve control module, STREGA scheduler ports, trigger-based rename"
```

---

### Task 15: Full verification set, then live verification on Silvan (hardware gates 1–3)

**Files:** none (evidence goes into the execution report `docs/superpowers/plans/2026-08-19-valve-control-edge-execution-report.md`).

- [ ] **Step 1: Full local gate set (fresh output pasted into the report)**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/*.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node scripts/verify-helper-registration.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js && node scripts/verify-sync-flow.js && bash scripts/check-mqtt-topics.sh && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-flows-size-ratchet.js && node scripts/flows-bare-require-scan.js && node scripts/verify-flows-fn-parse.js
node scripts/verify-strega-gen1.js
cd web/react-gui && npm run typecheck && npm run test:unit && npm run build && cd ../..
git diff --check
```

- [ ] **Step 2: Deploy to Silvan (`100.81.220.8`) per `osi-live-ops-runbook`**

Pre-repair backup of `/data/db/farming.db`; safe deploy flow (build GUI → tar → http.server → `ssh -R` → `deploy.sh` which runs migration 0022 with writers stopped → Node-RED restart). Post-checks: `/api/valves` returns 401 without token and the valve list with a token; `schema_migrations` shows 0022 applied; `flows` log shows the `Valve Control` tab nodes started.

- [ ] **Step 3: Hardware gates on Silvan's STREGA**

1. Create a WEEKLY schedule for today's weekday starting ≥ 2 × reporting interval from now, 5 min. Expect: 7 + 1 pushes QUEUED; within one reporting interval the weekday port ACK flips the push to `ACKED` (`SELECT purpose, weekday, state, acked_at FROM valve_schedule_pushes`); at the window start the valve reports OPEN **without** any gateway `actuator_log` row; the observe tick creates an `on_valve_schedule` expectation; Recent irrigations shows "Scheduled (on valve)"; at window end the valve closes and the expectation completes.
2. FPort 12 ACK (`RTC_Port 12`) → `last_clock_sync_acked_at` set.
3. "Skip today" → FPort 21 ACK, and a second window today does not fire.
After the gates: delete the test schedule (seven empty weekday pushes, ACKed), confirm `valve_schedule_pushes` shows no `QUEUED` rows, and restore `scheduler_status` ACTIVE.

- [ ] **Step 4: Execution report + commit**

Write `docs/superpowers/plans/2026-08-19-valve-control-edge-execution-report.md` with fresh command outputs, Silvan evidence (SQL rows, uplink excerpts, screenshots if available), deviations, and open items (GEN2 untested, Phase B pending). `git commit -m "docs: valve-control edge execution report"`.
