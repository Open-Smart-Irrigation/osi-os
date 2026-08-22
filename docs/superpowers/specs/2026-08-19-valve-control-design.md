# Valve control module: design

Date: 2026-08-19. Status: approved design, ready for an implementation plan.
Research input: `docs/ux/timed-valve-control-research-brief.md`. Vendor byte
reference: `docs/hardware/strega-codecs/`.

## 1. What this is

A new dashboard module, **Valve control**, placed between the zone list and
"Recent irrigations" on `FarmingDashboard`. It lists every STREGA valve the
user owns, across all zones, as tiles: valve glyph (closed / pending / open /
closing / failed), device name, zone chip, next-run line, and two buttons,
**Open** and **Schedule**. Open sends a one-shot `OPEN_FOR_DURATION`. Schedule
edits a weekly plan that the gateway compiles and writes into the valve's own
scheduler, so the valve keeps irrigating when the gateway is unreachable.

The existing sensor-threshold scheduler (`irrigation_schedules`, one per zone,
06:00 cron) is renamed **Trigger-based irrigation** in every locale. Its
behaviour does not change.

Target user: Swiss farmers running many valves on drip or micro-sprinkler
from cooperative networks with booked slots, without soil sensors.

## 2. Decisions taken in the brainstorm (binding)

| Topic | Decision |
|---|---|
| Where schedules run | On the valve (STREGA internal weekly scheduler). The gateway authors, compiles, pushes, and mirrors; it does not fire weekly opens. |
| Recurrence v1 | Weekly: weekday set + start time + duration, several schedules per valve, ≤ 4 windows per weekday per valve (STREGA limit). One-time opens (date + time + duration) are gateway-fired. "Every N days", odd/even, cycle-soak, seasonal %, blackout windows: out. |
| Schedules per valve | Several. |
| Hydraulic guard | None in v1. |
| Scheduled vs manual | Distinguished in Recent irrigations and history. |
| Cloud | Weekly and one-time schedules sync to the cloud from day one (new aggregate, lockstep osi-server change). Per-valve flow rate stays edge-only in v1. |
| Layout | Tiles everywhere (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`). |
| Litres | Open and Schedule dialogs show an estimated volume when a flow rate is known; never a guessed number. |
| Names | "Valve control" (new), "Trigger-based irrigation" (renamed). German: "Ventilsteuerung" / "Sensorgesteuerte Bewässerung". |
| Buttons | Two on the tile. "Skip today" and "Re-send plan to valve" live in the tile's overflow menu. |
| SV2 compatibility | The gateway never re-pushes a plan on a timer; it pushes only on a user change or an explicit re-send, so Bluetooth edits on an SV2 are not silently overwritten. The mirror is labelled "last sent", never "on valve". |

## 3. Domain model

**Schedule** (`valve_schedules` row): `kind` `WEEKLY` or `ONCE`; a valve
(`device_eui`); `duration_minutes` 1–1439 for WEEKLY (a window, not an FPort 2
duration) and 1–255 for ONCE (sent as FPort 2); `enabled`; for WEEKLY a
`weekdays_mask` (bit 0 = Sunday … bit 6 = Saturday, STREGA order) and
`start_time` `HH:MM`; for ONCE a `fire_at` ISO instant; a `label` (optional,
e.g. "Genossenschaft Slot"); `timezone` (IANA, resolved at save time from the
valve's zone, else the gateway's local zone); sync columns `schedule_uuid`,
`sync_version`, `deleted_at`, `created_at`, `updated_at`.

**Window**: the compiled unit the valve understands, `(weekday, on_hh, on_mm,
off_hh, off_mm)`. `off = on + duration` in wall-clock minutes, wrapping past
midnight (STREGA's own example is 23:05 → 00:10). A window that wraps belongs
to the weekday of its start.

**Compiled plan** of a valve: for each weekday, the ordered list of windows
from every enabled WEEKLY schedule of that valve. Validation at save time:
no weekday may exceed 4 windows; windows may not overlap, including a window
that wraps past midnight overlapping the next weekday's early windows (the
valve would receive a second ON during an ON; the firmware would restart its
timer, which silently extends irrigation). A wrapped window is still encoded
on its start weekday; the wrap matters only for conflict detection. Both are 422 errors naming the
weekday and the conflicting schedule label.

**Generation** (`valve_settings.strega_generation`): `GEN1` or `GEN2`. Default
`GEN1` (the whole fleet today). Set from the tile's settings or auto-promoted
to `GEN2` when an uplink decodes with the Gen2 ACK marker `0x06` and a 3-char
battery field (detection lives in `strega-process-fn`; it only ever promotes,
never demotes). Generation selects the encoder and the clock-sync command.

**Push** (`valve_schedule_pushes` row): one queued downlink for one valve:
`fport`, `payload_hex`, `purpose` (`WEEKDAY_PLAN` | `DAYMASK_PLAN` |
`SCHEDULER_STATUS` | `CLOCK_SYNC`), `weekday` (for Gen1 plans), `plan_hash`,
`queued_at`, `acked_at`, `ack_status` (raw byte), `state`
(`QUEUED` | `ACKED` | `FAILED` | `SUPERSEDED`), `command_id`.

## 4. Data model (edge, SQLite)

All new objects go through **osi-schema-change-control**: seed-blank.sql,
`database/migrations/ordered/NNNN__valve_control.sql`, fingerprints, bundled
DB, verifiers. Column lists below are the contract; types follow repo
conventions (`TEXT` ISO timestamps, `INTEGER` booleans).

```sql
CREATE TABLE valve_schedules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_uuid    TEXT NOT NULL UNIQUE,
  device_eui       TEXT NOT NULL REFERENCES devices(deveui) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('WEEKLY','ONCE')),
  label            TEXT,
  weekdays_mask    INTEGER,            -- WEEKLY: 1..127, bit0=Sun..bit6=Sat
  start_time       TEXT,               -- WEEKLY: 'HH:MM'
  fire_at          TEXT,               -- ONCE: ISO instant (UTC)
  duration_minutes INTEGER NOT NULL,
  timezone         TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  once_state       TEXT CHECK (once_state IN ('PENDING','FIRED','SKIPPED','CANCELLED')),
  once_fired_at    TEXT,
  sync_version     INTEGER DEFAULT 0,
  deleted_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((kind='WEEKLY' AND weekdays_mask IS NOT NULL AND weekdays_mask BETWEEN 1 AND 127
          AND start_time IS NOT NULL AND duration_minutes BETWEEN 1 AND 1439)
      OR (kind='ONCE' AND fire_at IS NOT NULL AND duration_minutes BETWEEN 1 AND 255))
);
CREATE INDEX idx_valve_schedules_device ON valve_schedules(device_eui, deleted_at);

CREATE TABLE valve_settings (
  device_eui          TEXT PRIMARY KEY REFERENCES devices(deveui) ON DELETE CASCADE,
  strega_generation   TEXT NOT NULL DEFAULT 'GEN1' CHECK (strega_generation IN ('GEN1','GEN2')),
  flow_rate_lpm       REAL,
  flow_rate_source    TEXT,            -- 'measured' | 'estimated' | NULL
  flow_rate_updated_at TEXT,
  default_open_minutes INTEGER,        -- last used in the Open dialog
  scheduler_status    TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (scheduler_status IN ('ACTIVE','SKIP_TODAY','DEACTIVATED')),
  skip_today_date     TEXT,            -- local date the skip applies to
  last_clock_sync_queued_at TEXT,
  last_clock_sync_acked_at  TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE valve_schedule_pushes (
  push_id      TEXT PRIMARY KEY,        -- uuid, also the ChirpStack command id
  device_eui   TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN','SCHEDULER_STATUS','CLOCK_SYNC')),
  weekday      INTEGER,                 -- GEN1 WEEKDAY_PLAN: 0..6
  fport        INTEGER NOT NULL,
  payload_hex  TEXT NOT NULL,
  plan_hash    TEXT,                    -- sha1 of the compiled windows this push carries
  state        TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','ACKED','FAILED','SUPERSEDED')),
  ack_status   INTEGER,
  queued_at    TEXT NOT NULL DEFAULT (datetime('now')),
  acked_at     TEXT,
  error        TEXT
);
CREATE INDEX idx_valve_schedule_pushes_device_state ON valve_schedule_pushes(device_eui, state);
```

`valve_actuation_expectations` gains one column, `trigger TEXT` with values
`manual`, `cloud_command`, `trigger_based`, `one_time`, `on_valve_schedule`,
`unexplained`. Existing rows backfill from `actuator_log.reason` where
possible, else `manual`. `irrigation_events.reason` gains values
`one_time_open`, `one_time_missed`.

Sync triggers on `valve_schedules` mirror the `irrigation_schedules` pair
(`_ai`, `_au`), aggregate type `VALVE_SCHEDULE`, aggregate key
`schedule_uuid`, op `VALVE_SCHEDULE_UPSERTED`; `_au` fires only when linked
and only when a synced column changed. **The triggers ship with Phase B**
(edge migration `0024` (0023 taken by app_settings, 2026-08-21), lockstep with
the osi-server release), not with the Phase A tables: every live gateway is
cloud-linked, and emitting an aggregate the cloud has never seen produces
terminally-rejected outbox rows. Phase A carries
`schedule_uuid`/`sync_version`/`deleted_at` from day one so 0024 is
trigger-only. `valve_settings` and `valve_schedule_pushes` have no sync
triggers.

## 5. Gateway behaviour

### 5.1 Compile and push (WEEKLY)

Triggered by every create / update / delete / enable-toggle of a WEEKLY
schedule and by the explicit "Re-send plan" action. Never by a timer.

1. Load all enabled WEEKLY schedules of the valve, compute windows per
   weekday in the schedule's timezone, sort by on-time.
2. **GEN1**: for each of the 7 weekdays build the 24-byte payload
   (`[FF, 80|BCD(on_h), BCD(on_m), FF, BCD(off_h), BCD(off_m)]` × 4, unused
   bytes `FF`), FPort `14 + weekday`. Queue a push per weekday **only when its
   `plan_hash` differs from the last `ACKED` or `QUEUED` push for that
   weekday**, except on "Re-send plan", which queues all 7. An empty weekday is
   an all-`FF` payload (that is how a day is cleared).
3. **GEN2**: group weekdays by identical window list; one FPort 25 payload per
   group: `daymask` (`0x80` if all 7 days share one list, else the bit set),
   then `[80|BCD(on_h), BCD(on_m), BCD(off_h), BCD(off_m)]` per window, no
   padding. Weekdays with no windows that previously had some get a payload
   with their bit set and zero windows (a 1-byte FPort 25 frame; whether the
   firmware accepts it as "clear" is part of hardware gate 4, the fallback
   being FPort 21 `'3'` followed by a full re-push, used only for GEN2 and
   only in this case). Same hash rule as GEN1.
4. Each push is emitted as a ChirpStack MQTT downlink
   (`application/<actuators-app>/device/<eui>/command/down`,
   `confirmed: false`) built in the valve-control module and sent through a
   dedicated mqtt-out node. The existing builder `cdbaa3891d40d7a1` is not
   touched: it is a hot node under the flows size ratchet, and plan pushes
   have their own ledger (`valve_schedule_pushes`) — `actuator_log` records
   actuations only. (Amended at plan review; the first draft routed through
   the builder.)
5. An older `QUEUED` push for the same `(device, purpose, weekday|daymask)`
   becomes `SUPERSEDED` when a newer one is queued. Before enqueueing the new
   set the ChirpStack device queue is flushed **unless** the device has an
   expectation in `PENDING_OBSERVATION` (a manual or one-time open still
   waiting for delivery); a flush is all-or-nothing and must not drop that
   open. In the unflushed case the superseded payloads are delivered first
   and the valve ends on the latest plan because it processes downlinks in
   order.
6. Class A delivers one downlink per uplink. A full GEN1 plan is 7 payloads,
   so it lands over 7 uplinks (≈ 7 × the reporting interval; 70 min at the
   10-min default), and GEN2 needs one uplink per day-group. Hash-diffing
   keeps routine edits to one or two payloads. The tile and the Schedule
   dialog show "plan delivery: 3 of 7 days acknowledged · ≈ 40 min
   remaining", computed from `reporting_interval_min × pending pushes`.

### 5.2 ACK handling

`strega-process-fn` today ignores ACK frames. It will: on `Schl_Port`
14–20 / 25 set the newest `QUEUED` push for that `(device, fport)` to `ACKED`
with `ack_status = Schl_status`; on `Schl_status_Port` 21 likewise for
`SCHEDULER_STATUS`; on `RTC_Port` 12/13 set `valve_settings.last_clock_sync_acked_at`
and the `CLOCK_SYNC` push to `ACKED`. A push still `QUEUED` 24 h after
`queued_at` becomes `FAILED` (`error='no_ack_24h'`); the tile shows it.

### 5.3 Scheduler status

"Skip today" → FPort 21 `'1'`, `valve_settings.scheduler_status='SKIP_TODAY'`,
`skip_today_date` = today in the valve's timezone; the state resets to
`ACTIVE` automatically at local midnight (edge-side; the valve already
resets itself). "Pause all schedules" / "Resume" (tile overflow) → `'2'` /
`'0'`. The gateway never sends `'3'` (delete all): deleting every schedule in
the GUI produces seven empty weekday pushes instead, which keeps the
inhibition state untouched.

### 5.4 Clock sync

- **GEN1**: FPort 12 with local wall-clock digits in the schedule timezone
  (gateway zone if no schedule exists yet). Queued: when the first schedule
  for a valve is saved, on "Re-send plan", once every 7 days per valve, and
  within 10 min after a DST transition in that timezone. The weekly cadence
  is a `CLOCK_SYNC` push and does not touch the plan (it does not violate the
  "no timer re-push" rule, which is about the plan). The clock tick runs
  every 10 minutes so the DST re-sync lands within the 10-minute bound. Because FPort 12 is
  local time, the valve's RTC is correct only for the timezone it was set
  with; a valve moved between zones with different timezones gets a fresh
  sync on the next save.
- **GEN2**: FPort 13 `0x01`. ChirpStack answers `DeviceTimeReq` with GPS
  epoch; whether SV2 turns that into local time, and from which offset, is a
  **hardware verification gate** (§10) before GEN2 is declared supported.
- A push carrying the clock is delivered at the valve's next uplink;
  latency equals the valve's reporting interval (FPort 11), shown on the tile
  as "next contact ≤ N min".

### 5.5 One-time opens (ONCE)

A 60 s inject `valve-once-tick` selects `ONCE` rows with
`once_state='PENDING' AND enabled=1 AND fire_at <= now AND fire_at >= now - 10 min`,
emits `OPEN_FOR_DURATION` through link-out `1ef83e7d26a33d6c` with
`reason='one_time_open'` and `trigger='one_time'`, writes `irrigation_events`
(`reason='one_time_open'`), sets `once_state='FIRED'`, `once_fired_at`. Rows
older than 10 min are marked `SKIPPED` with an `irrigation_events` row
`action='SKIP', reason='one_time_missed'` and are never fired late (time
integrity spec rule). Backward clock jumps cannot re-fire: `once_state` is
the guard. The expectation/reconciliation path handles the rest as for any
manual open. The tile shows "Open Sat 22:00 · 90 min (gateway-timed)"; the
Schedule dialog explains that one-time opens need the gateway online at that
minute.

### 5.6 Observing valve-fired opens

A dedicated 60 s observe worker (same cadence as the reconciliation
monitor, in its own node so the existing monitor does not grow): for each
STREGA device whose latest uplink reports `Valve = OPEN` and
that has no active expectation, insert an expectation row with
`trigger='on_valve_schedule'` when the current local time falls inside a
compiled window of that valve (`commanded_at` = window start,
`commanded_duration_seconds` = window length, `expected_close_at` = window
end + 120 s, `reconciliation_state='OBSERVED_RUNNING'`, `observed_open_at` =
uplink time, `volume_source` per §5.7), else with `trigger='unexplained'`,
`commanded_duration_seconds = 0` (the column is `NOT NULL`; 0 means "unknown"
and the GUI shows no duration), `expected_close_at` = uplink time + 24 h, and
`volume_source='unknown'`. The existing close-observation logic
then completes it. Recent irrigations and the history timeline show
"Scheduled (on valve)" / "Opened on valve" accordingly.

### 5.7 Volume estimate

Resolution order, used by the Open dialog, the Schedule dialog, and
`write-strega-expectation`: `valve_settings.flow_rate_lpm` → the zone's
`zone_irrigation_calibration.measured_flow_rate_lpm` → none (no number
shown). The estimate is `flow_rate_lpm × minutes`, rounded to 10 L, labelled
"≈". The per-valve rate is edited in the tile settings (gear): litres per
minute, with source `measured` or `estimated`.

### 5.8 Time-integrity rules inherited

From `docs/superpowers/specs/2026-07-08-time-integrity-design.md`: a forward
clock jump never fires a missed ONCE row late; a backward jump cannot
double-fire (`once_state`). WEEKLY execution is on the valve and unaffected
by gateway clock jumps; a gateway clock jump does trigger a GEN1 clock-sync
push if the jump exceeds 5 min, so the valve does not inherit a wrong time.

## 6. REST API (edge, all Bearer-auth, device ownership checked)

| Method + path | Purpose |
|---|---|
| `GET /api/valves` | All STREGA valves of the user with zone id + **zone name**, `strega_generation`, flow rate, `scheduler_status`, active expectation summary, next run (`next_run_at`, `next_run_kind`, `next_run_minutes`), pending/failed push counts, `last_plan_sent_at`, `last_plan_acked_at`. One query, the tile's whole data. (`reporting_interval_min` was cut at plan review: no edge column carries it, and the tile's pending hint no longer shows a minutes estimate.) |
| `GET /api/valves/:deveui/schedules` | Schedules of a valve (WEEKLY + ONCE), plus the compiled weekday table (≤4 windows/day) and per-weekday push state. |
| `POST /api/valves/:deveui/schedules` | Create; validates §3; compiles and queues pushes; 422 with `weekday` and `conflicts[]` on violation. |
| `PUT /api/valves/:deveui/schedules/:uuid` | Update (same validation). |
| `DELETE /api/valves/:deveui/schedules/:uuid` | Soft delete (`deleted_at`), recompile. |
| `POST /api/valves/:deveui/plan/resend` | Queue all 7 / all groups + clock sync. |
| `POST /api/valves/:deveui/scheduler-status` | `{status: 'SKIP_TODAY'|'DEACTIVATED'|'ACTIVE'}` → FPort 21. |
| `PUT /api/valves/:deveui/settings` | `{strega_generation?, flow_rate_lpm?, flow_rate_source?}`. |
| `POST /api/valve/:deveui` | Unchanged (Open). The Open dialog stores `default_open_minutes` via `PUT …/settings` after a successful 202. |
| `GET /api/irrigation/recent-actuations` | Gains `trigger` per row. |

Request and response shapes are JSON snake_case like the rest of flows.json;
`api.ts` normalises to camelCase as for `activeValveActuation`.

## 7. GUI (`web/react-gui`)

- `ValveControlPanel.tsx` (section, same chrome as `IrrigationOutcomesPanel`),
  rendered from `FarmingDashboard` after the zone list, gated by a new module
  toggle `valveControl` (`MODULE_KEYS`, `DEFAULT_MODULES` = true, Settings
  `ModuleRow`). Data from `GET /api/valves` on SWR with a 10 s interval, plus
  the existing `irrigationActuations`.
- `ValveTile.tsx`: glyph · name · zone chip (or "Unassigned") · status line ·
  next-run line · buttons **Open** | **Schedule** · overflow `⋯` (Skip today,
  Pause/Resume schedules, Re-send plan, Settings). Width-stable; the buttons
  keep their labels while running (Open becomes Cancel only while a
  gateway-commanded actuation is `PENDING_OBSERVATION`, as today).
- `ValveGlyph.tsx`: one inline SVG, five states driven by
  `activeValveActuation` + `current_state` + push state:
  `closed` (outline), `pending` (dashed outline + clock badge, caption "waiting
  for valve · next contact ≤ N min"), `open` (filled body, three droplets
  animated unless `prefers-reduced-motion`, ring showing elapsed/duration
  when the duration is known, caption "closes ≈ HH:MM"), `closing`
  (hollow + hourglass, after `expected_close_at` until the close uplink),
  `failed` (alert badge; `STALE_*` expectation or a `FAILED` push). Tones
  reuse `FEEDBACK_STYLES` amber/blue/emerald plus the existing error token.
- `ValveOpenDialog.tsx`: default = `default_open_minutes` ?? 5; chips 15 / 30 /
  60; numeric field 1–255; live line "closes ≈ HH:MM · ≈ N L" (litres only
  when known); Confirm. Sends `OPEN_FOR_DURATION` exactly like
  `StregaValveCard.handleOpen`.
- `ValveScheduleDialog.tsx`: header with the compiled week (7 columns, ≤4
  windows each, conflicts highlighted) and the push state per weekday
  ("sent 22:14 · acknowledged" / "waiting for valve" / "failed"); list of
  schedules with enable toggles, edit, delete; "+ Weekly" form (weekday
  chips, start time, duration, label, preview "Mon · Wed · Fri 06:00–07:30
  · ≈ 900 L") and "+ One-time" form (date, time, duration, label, note that
  it is gateway-timed). Save errors from 422 are shown inline on the
  weekday.
- `StregaValveCard` keeps its gear panel; its "Open" block stays for now
  (removal is a follow-up once the panel is proven on kaba100).
- i18n: new namespace `valves.json` in all 7 locales (`de-CH, en, es, fr, it,
  lg, pt`), English + de-CH authored in the plan, the rest machine-drafted
  and flagged for the human pass the i18n programme already runs. Rename:
  `devices.json schedule.irrigationSchedule`, `settings.json
  irrigationSchedule`, `schedule.triggerHint`, `history.json
  irrigationTimeline.eventLabel.scheduled` (+ new `onValveSchedule`,
  `oneTime`, `unexplained`).

## 8. Cloud (osi-server, separate plan, lockstep merge)

- `docs/contracts/sync-schema/resources.schema.json`: `ValveSchedule`
  `{schedule_uuid, device_eui, kind, label, weekdays_mask, start_time,
  fire_at, duration_minutes, timezone, enabled, once_state, deleted_at}`.
- `events.schema.json`: op `VALVE_SCHEDULE_UPSERTED`.
- `commands.schema.json`: `UPSERT_VALVE_SCHEDULE`, `DELETE_VALVE_SCHEDULE`,
  `RESEND_VALVE_PLAN`, `SET_VALVE_SCHEDULER_STATUS`; the edge routes them to
  the same handlers as the REST endpoints (`934bf2bc19a8ce22` "Route
  Command" gains the cases) and ACKs via the existing command-ack path.
- osi-server: Flyway table `valve_schedules` mirror, REST, and the AgroLink
  panel via `ui-core` (same components, cloud data source). Cloud-authored
  changes arrive as commands; the edge compiles and pushes exactly as for a
  local save, so the valve sees one writer.
- `docs/contracts/sync-schema/canonicalization.md` gains the `weekdays_mask`
  bit order and `start_time` format as a cross-runtime contract.

## 9. Safety rules

- Only `OPEN_FOR_DURATION` (FPort 2) and scheduler windows ever open a valve;
  no bare `OPEN`, no `CLOSE` (unchanged policy).
- The gateway never sends FPort 21 `'3'` (delete all), with one exception:
  the GEN2 clear-a-day fallback in §5.1 step 3, if hardware gate 4 shows the
  1-byte frame is not accepted; it is always followed by a full re-push.
- The gateway never re-pushes a plan without a user action (SV2 Bluetooth
  compatibility).
- A plan push that would exceed 4 windows on a weekday is refused before
  anything is queued.
- Deleting a valve (unclaim) queues seven empty weekday pushes (GEN1) or an
  all-days-empty FPort 25 (GEN2) and a `'2'` deactivate, so a re-sold valve
  does not keep irrigating an old plan; the pushes are best-effort and logged.

## 10. Hardware verification gates (before "done")

1. On a test STREGA (kaba100 or Silvan): write a weekday plan, observe the
   ACK (`Schl_Port`), observe the valve open at the window start without any
   gateway command, observe the `on_valve_schedule` expectation row and the
   Recent-irrigations entry.
2. FPort 12 clock sync ACK (`RTC_Port = 12`) and a window firing at the right
   local minute after the sync.
3. FPort 21 `'1'` suppresses today's windows only.
4. GEN2: FPort 25 ACK and FPort 13 behaviour with ChirpStack's
   `DeviceTimeReq`; until an SV2 is on the bench, GEN2 is implemented, unit
   tested against the vendor encoder's vectors, and labelled "untested on
   hardware" in the settings dropdown.
5. STREGA Gen2 device profile, once an SV2 is on the bench:
   - Register a valve as Gen2 explicitly: it lands on the
     `CHIRPSTACK_PROFILE_STREGA_GEN2` device profile from the first
     registration, no promotion needed.
   - Register the same SV2 as Gen1 (the mis-registration case): its first
     Gen2-shaped ACK both promotes `valve_settings.strega_generation` to
     `GEN2` and re-points its ChirpStack device profile — verify both, not
     just the row.
   - After that re-point, Gen2 telemetry (valve state, battery) decodes
     correctly — confirms the profile swap actually took effect, not only
     the local ledger write.
   - A Gen1 valve on the bench at the same time is unaffected throughout:
     its profile, schedule pushes, and ACKs behave exactly as before.

## 11. Testing

- Pure functions extracted into a new local module
  `conf/.../node-red/osi-valve-control/` (compile windows, validate, encode
  GEN1/GEN2, decode ACK, hash, next-run computation, DST-aware local time),
  with Node unit tests and golden vectors copied from
  `docs/hardware/strega-codecs/` (e.g. Sunday 08:30–08:45 + 23:05–00:10 →
  `FF 88 30 FF 08 45 FF A3 05 FF 00 10 FF…`; Gen2 all days 19:15–19:30 +
  19:45–20:01 → `80 99 15 19 30 99 45 20 01`; Tue+Sat 06:05–10:05 →
  `44 86 05 10 05`).
- flows.json: `scripts/verify-flows-*` guards, `verify-strega-gen1.js`
  extended with ACK fixtures (`Schl_Port`, `RTC_Port`).
- Schema: the full osi-schema-change-control verifier set.
- GUI: vitest for glyph state derivation, dialog validation, 422 rendering,
  next-run formatting across DST; the existing `stregaValveCard.test.ts`
  stays green.
- Sync contract: `scripts/verify-sync-contract*` with the new resource/op.

## 12. Phasing

- **Phase A (edge, GEN1):** schema + module + panel + Open dialog + WEEKLY
  compile/push/ACK + clock sync + skip-today + observed runs + rename +
  i18n + ONCE. Hardware gates 1–3.
- **Phase B (cloud):** contract + osi-server + AgroLink panel; lockstep
  merge with A.
- **Phase C:** GEN2 encoder behind the generation setting, bench-verified
  when an SV2 arrives; remove the Open block from `StregaValveCard`.

## 13. Open items (not blockers)

- Ask STREGA whether SV2 firmware can report its scheduler over LoRaWAN after
  a Bluetooth edit; if yes, add a read-back step and a "verified on valve"
  state.
- Meaning of the `0xFF` prefix byte in Gen1 weekday payloads (we send it
  exactly as the vendor encoder does).
- Frost-protection sprinkling and pressure-limited concurrency are
  explicitly out of scope; both are recorded in the research brief for a
  later module.
