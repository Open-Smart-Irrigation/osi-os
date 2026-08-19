# Timed valve control: research brief and open design questions

Date: 2026-08-19. Status: brainstorm input, not a spec. Companion to the
brainstorming session for the new "Valves" dashboard module; the existing
sensor-threshold scheduler is renamed "Trigger-based irrigation" in the same
program.

## What the module is

A dashboard section at the same level as the zone list and the "Recent
irrigations" card. It lists every STREGA valve the user owns, across all zones,
one row or tile per valve: device name, zone name, a valve glyph showing
closed / open / pending, and two actions. **Open** asks for a duration and
sends `OPEN_FOR_DURATION`; the valve self-closes. **Schedule** creates a timed
plan (start time, recurrence, duration) that the gateway executes without
sensors.

Target user: Swiss farmers running many valves on drip or micro-sprinkler,
usually drawing from a cooperative network with a booked slot or a rotating
turn, and no soil-moisture probes on most plots.

## What already exists on the edge (verified 2026-08-19)

The open path is complete end to end and the new module should reuse it
unchanged:

| Piece | Where | Fact that constrains the design |
|---|---|---|
| Command endpoint | `POST /api/valve/:deveui`, flows.json http-in `6ba1d1d0ac7fd7db` (line 1938); validator node `83bb4a452dd9ae37` | `duration_seconds` must be a whole-minute multiple, 1–255 min. Bare `OPEN` is rejected (400). |
| Shared actuator link | link-out `1ef83e7d26a33d6c`, link-in `5974306566e99a92` "from scheduler/manual" | Anything emitted here gets an expectation row, reconciliation, `actuator_log`, and a line in Recent irrigations for free. |
| Expectations | `valve_actuation_expectations` (seed-blank.sql:990); writer node `write-strega-expectation` (line 9024); monitor `strega-reconciliation-tick` every 60 s | States `PENDING_OBSERVATION` → `OBSERVED_RUNNING` → `OBSERVED_COMPLETE`, plus `STALE_*` after `expected_close_at + 300 s`. `expected_close_at` already includes a 120 s downlink budget. |
| Cancel | `POST /api/valve/:deveui/cancel` → `cancel-strega-actuation-fn` (line 9123) | Flushes the ChirpStack queue and marks the expectation `CANCELLED`. It cannot close a valve that already opened; the valve closes on its own timer. |
| Device list | `GET /api/devices` (`get-devices-query`, line 490) | Returns all devices with `active_valve_*` columns, but **not the zone name**; only `irrigation_zone_uuid`. Zone names come from `/api/irrigation-zones`, already fetched in `FarmingDashboard.tsx:45`. |
| Existing valve UI | `StregaValveCard.tsx` (865 lines) | Duration input is `type=number` 1–255 with default 5. Status is a 12 px pulsing dot next to OPEN/CLOSED text. Feedback badge tones already exist: queued (amber) / running (blue) / closed (emerald). |
| Existing scheduler | `irrigation_schedules` (`UNIQUE(irrigation_zone_id)`), cron inject `00 06 * * *` (line 2108), decision node `5f0d2b7e9b9b1b3a` | One threshold schedule per zone, evaluated once a day at a fixed gateway-local time. No start time, weekday, interval, or calendar column exists anywhere in the schema or the 21 migrations. |
| Cron primitive | none bundled | The stack has no cron library. The established pattern for per-row timing is a 60 s inject plus a "due rows" query (used by reconciliation and sync outbox). |
| Clock rules | `docs/superpowers/specs/2026-07-08-time-integrity-design.md` | A forward clock jump must never auto-fire missed windows; a backward jump must be debounced with a `last_triggered_at`-style guard. Both rules bind a calendar scheduler. |
| Rename surface | `schedule.irrigationSchedule` in `devices.json` + `settings.json`, 7 locales | German currently reads "Bewässerungsplan", which is the natural name for the new timed module, so the rename frees it. `schedule.triggerHint` hard-codes "06:00" in every locale. |
| UC512 | type registered, uplink normalizer only | `UC512_OPEN_FOR_DURATION` is declared in the command registry but nothing dispatches it. `zone_valve_assignments` exists for its two channels and no flow reads it. |

Also relevant: `devices.irrigation_zone_id` is single-valued, so a valve has 0
or 1 zone. `irrigation_schedules` syncs to the cloud as aggregate `SCHEDULE`;
any new table that should appear in AgroLink needs its own outbox trigger, a
new op in `events.schema.json`, and a matching osi-server change.

## How other products solve it

Sources and the full comparison table live in the appendix. The condensed
picture:

**Recurrence options across 14 products.** Every controller offers specific
weekdays and "every N days" (Rain Bird 1–30, OpenSprinkler 1–128, LinkTap
1–30). Multiple start times per day is standard (Hydrawise 6, Rain Bird 4 per
program, OpenSprinkler 4 fixed or a repeating series, LinkTap up to 100).
Odd/even days is a US-municipal artefact with no Swiss driver. Seasonal
percentage, rain skip, and cycle-and-soak appear in the consumer tier; ag
controllers (Netafim GrowSphere, Talgil DREAM, Galcon) instead model
**shifts** (valves that open together), **sequences** (next valve opens when
the previous one closes), **cycles with an interval between cycles**, and a
per-day **run list** (W / F / – / S) that the operator can edit by hand.

**Manual run.** Three patterns recur: a numeric prompt on tap (OpenSprinkler,
Hydrawise "run for", 1–1439 min), a per-device default duration with one-tap
start (Eve Aqua, Rachio quick run default 3 min, LinkTap instant default 5
min), and preset chips. Hydrawise shows ▶ / ■ / ‖ on the zone tile; Rachio
turns the run button into a progress indicator with time remaining. Stop on a
self-closing LoRaWAN valve can only mean "cancel what hasn't left the
gateway", and Talgil's "freeze with dose left" is the closest analogue.

**Class-A latency.** Milesight's UC51x guide states that a downlink does not
act until the device's next uplink (default 600 s) and its UI shows a clock
badge for "waiting for uplink". Kilo IoT uses three command states
(pending / confirmed / failed) with plain-language failure reasons and
disables controls when the device is offline. The consensus pattern is: start
the visible countdown only once the device confirms open; before that, show
"waiting for valve, next contact in ≤ X min" where X is the device's uplink
interval; show when an undelivered command expires.

**Swiss constraints.** The Wallis Suonen "Kehr" rotates water rights in
hours over a 5–30 day cycle, night hours often unallocated (suone.ch). The
Furttal cooperative (18 members, 400 m³/h) has members book slots in an
online tool and closes hydrants below a tank threshold (Bauernzeitung). The
BLW Leitfaden Bewässerung 2024 assumes 16 h/day operation, lists bans during
certain periods and night-only irrigation as planning inputs, and observes
that members coordinate with "Doodle-Einträge, gemeinsame Kalender". Turnus of
6–7 days at 25–30 mm is the reported main-season cadence for vegetables
(Agropool). No Swiss vendor found offers a sensor-less LoRaWAN-valve scheduler
for this use; PlantCare, Smart Farm Tech, and Agroscope's Vaud pilots are all
sensor-driven.

**Icon idioms.** Material Symbols ships `valve`, `faucet`, `water_drop`,
`timer`, `pending`, `schedule_send`, `event_repeat`; Lucide has `droplet`,
`droplet-off`, `timer`, `calendar-clock`, `hourglass`, `clock-fading` but no
valve glyph. Products animate running state with falling droplets, a pulsing
tile, or a progress ring; Talgil distinguishes program-opened from
manually-opened by colour.

## STREGA's on-valve scheduler (decision input, added 2026-08-19 after review)

Phil's direction: schedules must run on the valve's internal scheduler, not be
fired by the gateway, and the design must stay compatible with the STREGA SV2
(Gen2), whose scheduler can also be edited on site over Bluetooth. The
byte-level facts below come from STREGA's official encoder/decoder code
(`github.com/Strega-Technologies/Strega`, Gen1 + Gen2, last commit
2026-08-12), the TTN device repository `vendor/strega/smart-valve.js`, the
public 2019 Ubidots integration manual, and the SV2 2026 datasheet. STREGA's
narrative manuals are password-walled on stregauniverse.com.

| Capability | Gen1 (SV/SE, what the fleet runs) | Gen2 (SV2/SE2, 2025+) |
|---|---|---|
| Scheduler model | Weekly. 4 ON/OFF windows per weekday, times in HH:MM (BCD). A window, not a duration; may cross midnight (vendor example 23:05 → 00:10). | Same model: weekday bitmask + up to 4 windows per payload. |
| Write | FPort 14–20, one port per weekday (14 = Sun … 20 = Sat), 24 bytes = 4 × `[FF, 80\|BCD(on_h), BCD(on_m), FF, BCD(off_h), BCD(off_m)]`, unused fields `FF`. | FPort 25: `[daymask, 80\|BCD(on_h), BCD(on_m), BCD(off_h), BCD(off_m)] × ≤4`; `daymask 0x80` = all days, bit0 Sun … bit6 Sat. |
| Activate / inhibit | FPort 21 ASCII: `'0'` activate, `'1'` skip today only, `'2'` deactivate, `'3'` deactivate and delete all. | Same. |
| Read-back of the schedule | None. The ACK uplink echoes only port + 1 status byte ("Schedulers Setting Ack"). | None in the public codec. |
| Takes effect | "New schedulers will start from the next uplink only" (Ubidots widget). | Same assumption. |
| Clock | RTC on board. Set with FPort 12 (14 digits, **local** wall-clock, no timezone field; the valve is timezone-naive). FPort 13 = clock-sync request. | FPort 12 absent from Gen2 encoders; FPort 13 only. Whether it maps to LoRaWAN `DeviceTimeReq` is unverified. |
| Runs offline | Yes, explicitly: "stored directly into the smart-valve memory … independently from the communication". | Same. |
| Interval / every-N-days / one-time date | Not available. | Not available. |
| Bluetooth | None. | "Bluetooth for local control / LoRaWAN debug / settings / schedulers". No GATT or app doc published; no uplink reports a BLE-made change. |
| One-shot timed open | FPort 2, `41 NN` minutes (1–255) — what `POST /api/valve/:deveui` sends today. | Same. |

What this means for the module:

1. **Weekly is the native recurrence, and it is the only one.** "Every N days" and
   one-time dates cannot live on the valve. One-time opens can still be done
   from the gateway as a delayed FPort 2 (it is just an `OPEN_FOR_DURATION`
   sent at the right minute); "every N days" has no clean home and the Swiss
   Turnus of 6–7 days is close enough to weekly to drop it from v1.
2. **The gateway is a compiler and a mirror, not a scheduler.** Schedules are
   authored per valve as (weekdays, start HH:MM, duration); the gateway
   merges every enabled schedule of a valve into ≤ 4 windows per weekday,
   encodes per generation, queues the downlinks, and tracks the per-port
   ACK. More than 4 windows on a weekday is a validation error at save time.
3. **Drift is unobservable.** No read-back exists, so a BLE edit on an SV2 is
   invisible to the gateway. The mirror must be shown as "last sent to the
   valve at <time>, acknowledged / pending", never as "what the valve holds",
   and the gateway must not re-push on a timer (that would overwrite BLE
   edits). Re-push only on explicit user action or on a user change to the
   plan. Open action item: ask STREGA whether SV2 firmware can report its
   scheduler over LoRaWAN after a BLE change.
4. **The gateway owns the valve clock.** Gen1 needs FPort 12 with local
   wall-clock; DST shifts the valve by an hour until re-synced, so the
   gateway should push FPort 12 after each DST transition and periodically,
   delivered at the valve's next uplink. Gen2 needs FPort 13 and a verified
   `DeviceTimeReq` answer from ChirpStack.
5. **"Skip today" is free.** FPort 21 `'1'` is the rain button the consumer
   apps build in software; it belongs in the tile menu or the Schedule
   dialog.
6. **Recent irrigations needs an observed-open source.** Valve-fired opens
   are not commanded by the gateway, so no expectation row exists. The
   uplink stream does report valve state; a state transition that matches a
   compiled window should be logged as a scheduled run, otherwise as an
   unexplained open.
7. **Generation must be known per device** (FPort 14–20 vs 25, 24-byte vs
   packed encoding, FPort 12 vs 13). The Gen2 uplink format differs (3-char
   battery, `0x06` ACK marker), so detection from the first uplink is
   feasible; a settable field is the fallback.

## Design implications I draw from this

1. **The "Open" dialog should be one tap for the common case.** Per-valve
   last-used duration as the default, 3 chips (e.g. 15 / 30 / 60 min), and a
   numeric field for anything else, capped at 255 min by the existing
   validator. Show the expected close time ("closes ≈ 18:42") before the user
   confirms, because that is what a farmer checks against a slot.
2. **The valve glyph needs five states, not two.** Closed (grey outline),
   pending (dashed outline + clock, with "next contact ≤ N min"), open
   (filled, droplets, progress ring + remaining minutes), closing (hollow +
   hourglass, awaiting the close uplink), failed / stale (alert badge). The
   existing `getStregaActuationFeedback` already derives three of these from
   `valve_actuation_expectations`; the remaining two map onto `STALE_*` and
   `OBSERVED_RUNNING` past `expected_close_at`.
3. **Schedules are per valve, not per zone.** The module lists valves, the
   hydraulic unit a cooperative slot applies to is a valve or a group of
   valves, and a zone can have more than one valve. Grouping can be a later
   feature layered on top.
4. **One-time scheduled opens are first-class.** "Open Tue 19 Aug 22:00 for
   90 min" is the Kehr / booked-slot primitive and is cheaper to build than
   any recurrence; Milesight even has a device-side opcode for it.
5. **Recurrence v1 = weekdays, every N days from a start date, multiple
   starts per day (or repeat every X h).** Odd/even, cycle-and-soak, seasonal
   percentage, volume-based runs, and frost mode stay out.
6. **Execution = 60 s due-row poll, idempotent per (schedule, occurrence).**
   Each fire writes an `irrigation_events` row (reason
   `scheduler_timed`) and emits through link-out `1ef83e7d26a33d6c`, so
   Recent irrigations, expectations, and `actuator_log` need no new code.
   Missed occurrences (gateway off, clock jump) are logged as skipped, never
   fired late; this is what the time-integrity spec already mandates.
7. **Concurrency guard is the one ag-grade constraint worth a v1 setting.**
   A gateway-level "max valves open at once" (default unlimited) with
   schedule creation refusing overlaps, or staggering them, is what
   pressure-limited networks need and what no consumer controller has.
8. **Rename "Bewässerungsplan" → "Sensorgesteuerte Bewässerung" (and
   equivalents)** and give the new module the plain name "Ventile" /
   "Valves"; the timed plans inside it are "Zeitpläne" / "Schedules".

## Open questions for the brainstorm

These are the decisions that change the design materially. My recommendation
comes first in each list.

**Q1. Where does the Schedule dialog's recurrence stop in v1?**
(a) One-time date + weekdays + every N days + multiple start times.
(b) Only weekdays + one-time.
(c) Everything in (a) plus allowed/blackout windows per valve.

**Q2. How many schedules per valve?**
(a) Several, each with its own recurrence and duration (a Tuesday plan and a
one-off Saturday slot coexist).
(b) Exactly one, edited in place.

**Q3. What is the hydraulic guard in v1?**
(a) A single gateway setting "max valves open simultaneously"; the dialog
warns on overlap and refuses to save if the limit is exceeded.
(b) No guard; the farmer staggers by hand.
(c) Full groups / shifts with auto-chaining (v2 in my view).

**Q4. Should scheduled runs and manual runs be distinguishable in Recent
irrigations and history?**
(a) Yes: reason `scheduler_timed` vs `manual`, with a small label on the card.
(b) No distinction.

**Q5. Cloud visibility.** Should timed schedules sync to AgroLink (new
aggregate + osi-server change, lockstep merge), or stay edge-only for v1?
(a) Edge-only v1; sync in the next wave.
(b) Sync from day one.

**Q6. Layout of the valve list.** Tile grid (like unassigned devices,
`grid-cols-1 md:2 lg:3`) or a compact table sorted by zone?
(a) Tiles on mobile, compact rows on desktop, grouped by zone with a zone
header.
(b) Tiles everywhere.

**Q7. Module placement.** Above the zone list (it is the thing a sensor-less
farmer uses daily) or below it, between zones and Recent irrigations?

**Q8. Per-valve flow rate.** `zone_irrigation_calibration.measured_flow_rate_lpm`
is per zone. Should the Open dialog show an estimated volume (litres) next to
the duration, and if so, is a per-valve flow rate worth adding now?

**Q9. Naming.** "Trigger-based irrigation" vs "Sensor-triggered irrigation"
for the renamed module; "Valves" vs "Valve control" for the new one.

## Appendix: product comparison

| Product | Weekdays | Every N days | Odd/even | Starts per day | Sub-daily repeat | Cycle & soak | Window / end-by | Seasonal % | Rain/frost skip | Run-once | Sequencing |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Rachio | yes | yes | yes | 1 per schedule | no | smart soak | start at time / sunrise / sunset, end-by-sunrise | monthly % | rain, freeze, wind | quick run, default 3 min | sequential |
| Hunter Hydrawise | yes | yes | yes | 6 | no | cycle + soak | start-time windows | monthly % | forecast delay | ▶ with adjustable minutes 1–1439, ■, ‖ suspend | sequential |
| Rain Bird ESP-TM2 | custom days | cyclic 1–30 | yes | 3 programs × 4 | no | no | no | per program | rain sensor, permanent days off | manual station/program | sequential |
| Orbit B-hyve | yes | interval | yes | multiple | no | smart soak (unverified) | – | auto | rain delay 24/48/72 h | per-zone manual | sequential |
| OpenSprinkler | weekly | 1–128 with offset | yes | 4 fixed or repeating | yes | via repeating | sunrise/sunset ± | water level % | rain delay, weather | run-once program; queue append/insert/replace | sequential groups or parallel, station delay |
| LinkTap | 7-day | 1–30 | yes | up to 100 cycles | yes | ECO on/off | – | month / calendar modes | rain skip | instant default 5 min, by duration or volume | batch groups with delays |
| Gardena smart | yes | 2nd/3rd/7th day, 8/12/24 h | no | per schedule | yes | no | – | auto | frost < 5 °C stop | 1 min–3 h 59 | one valve at a time |
| Eve Aqua | 7 daily periods | no | no | up to 7 | no | no | – | no | no | default duration, max 1 h | single valve |
| Netro Sprite | yes | yes | via regulations | yes | no | – | regulations | – | rain > 5 mm | remote on/off | sequential |
| Milesight UC51x | weekday bitmask | day/week/month loop | no | 16 rules | yes | no | start/end timestamps | no | no | downlink 1–1440 min or pulse volume; scheduled single open | per valve |
| Galcon GSI | yes | cyclic 1–30 | – | unlimited | – | – | – | – | weather | open from app | sequential |
| Netafim GrowSphere | days per program | cycles | – | starts + triggers | – | – | – | – | – | manual start of shift | shifts (together) in sequence, 32 valves/shift |
| Talgil DREAM | run-list W/F/–/S | every N | – | cycles + interval | yes | – | conditions | – | – | start / stop / skip / freeze | `&` same dose, `+` together |

Sources (fetched 2026-08-19): Rachio community threads 36154 / 22907 / 14438;
Sprinkler Warehouse Hydrawise programming overview; Rain Bird ESP-TM2 store
page; Orbit B-hyve support; OpenSprinkler firmware manual 2.2.1; LinkTap app
overview (irrigation-guide.com); Gardena MultiControl Duo and smart help;
Eve Aqua manual; Netro user guide; Milesight UC51x user guide; Galcon GSI
getting-started guide; Netafim GrowSphere MAX quick setup guide; Talgil DREAM
2 manual; Kilo IoT control page; TTN downlink queue docs; suone.ch Kehr;
Bauernzeitung Furttal article; BLW Leitfaden Bewässerung 2024; Agropool
Bewässerung; Material Symbols codepoints; Lucide tags.json. Claims marked
"unverified" in the text could not be confirmed against a primary source.
