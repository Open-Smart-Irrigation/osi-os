# Time integrity — timestamp sanity clamp, scheduler clock-jump safety, RTC health

**Status:** Draft
**Refactor-program item:** 5.6 (DD18 "timestamp sanity + defined scheduler behavior on clock jumps"). The "Any / SD durability" and edge-durability rows — a clock that jumps is a silent farm-safety hazard.
**Focus: osi-os edge.** Scheduler/ingest logic + heartbeat health field. No boot-node change. Couples 5.2 (its clock-jump scenario is this item's regression rehearsal).
**Depends on:** nothing hard; the scheduler and `osi-health-helper` already exist.

## Problem

A gateway's wall clock is not trustworthy: a Pi with no/failed RTC boots at the epoch or a stale time, then NTP corrects it, producing a **jump** — forward (clock leaps ahead) or backward (clock rewinds). Two farm-safety hazards follow, plus one observability gap:

1. **Forward jump → phantom missed windows.** The irrigation scheduler fires on a daily cron (verified: `Schedule time` inject, `crontab "00 06 * * *"`). If the clock leaps forward across 06:00, a naive scheduler might treat the skipped window as "missed" and fire it late — irrigating at the wrong time. **Farmer safety demands: never auto-fire a missed window after a forward jump** (irrigating an already-wet field, or at night, is crop/water harm).
2. **Backward jump → double-fire.** If the clock rewinds past 06:00, the cron could fire the same daily window twice. This must be prevented by a `last_triggered_at` guard.
3. **Implausible device timestamps.** Uplinks/telemetry carry device-supplied timestamps; a device with a bad clock can write a row dated 1970 or 2099, polluting history and range queries. Ingest must **clamp or reject implausible timestamps** to sane bounds.
4. **No RTC health signal.** There is no heartbeat field telling the operator whether a gateway even has a working RTC — so a clock-drift-prone gateway is invisible until it misbehaves.

## Verified ground truth

1. **The scheduler is a daily cron** (`Schedule time` inject, `crontab "00 06 * * *"`, verified) driving the `Build zones query (enabled schedules)` → `Decide + build actuator cmd + build DB logs` chain.
2. **`last_triggered_at` exists and is WRITTEN when irrigating, but is NOT read as a debounce guard** (verified — this is the load-bearing "report what exists" finding the pre-ruling asked for):
   - `irrigation_schedules.last_triggered_at` is `SELECT`ed by `Build zones query` and available in the `zone` object;
   - the decision node (`Decide + build actuator cmd`) writes `SET last_triggered_at = '${nowIso}'` **only when it irrigates** (two write sites);
   - **but the zones query's `WHERE` clause filters only on `s.enabled = 1 AND iz.deleted_at IS NULL`** — it does NOT filter or debounce on `last_triggered_at`, and the decision node does not consult `last_triggered_at` before deciding to fire. **So today there is NO backward-jump double-fire guard active** — the column is populated but not enforced as a same-window debounce. This item adds the guard; it does not merely rely on an existing one.
3. **RTC is checkable on the image:** BusyBox `hwclock` is built in (`CONFIG_BUSYBOX_DEFAULT_HWCLOCK=y`, verified across profiles) though the standalone `hwclock` package is not installed. The Pi 5 has an on-SoC RTC exposed at `/sys/class/rtc/rtc0` (kernel-standard sysfs). So RTC presence/health is readable via `/sys/class/rtc/rtc0` (existence + `hctosys` / `since_epoch`) and/or BusyBox `hwclock -r`. **Verify the exact sysfs node on the running Pi 5 image at implementation time** (`/sys/class/rtc/rtc0` is the standard, but confirm it's populated — the Pi 5's RV3028 RTC needs the overlay/driver present).
4. **`osi-health-helper`** (`conf/.../node-red/osi-health-helper/index.js`, verified) is the heartbeat builder — it assembles `{schema_sig, sync_pending, sync_oldest_age_s, disk_free_pct, ...}` and already uses `node:child_process`, so it can shell out for `hwclock`/read `/sys/class/rtc`. This is the correct home for a new `rtc_present`/`clock_health` field. It is a DD2-loader-covered module (1.A1) subject to the ratchet trio (1.A2) — a field-add must stay within the size ceiling.
4b. **`osi-health-helper` is loaded from function nodes** — the heartbeat flow reads its output. Adding a health field is a helper change + a heartbeat-flow field wiring (both-profile parity).

## Design

### A. Timestamp sanity clamp at edge ingest

- **Define plausible bounds:** a device/uplink timestamp is plausible iff it falls within `[FLOOR, now + SKEW]` where `FLOOR` is a fixed floor (e.g. `2024-01-01` — before the project existed, no real reading predates it) and `SKEW` is a small forward tolerance (e.g. +1 h, for minor device-vs-gateway clock skew). **Bounds are constants, documented; not guessed per-call.**
- **On an implausible timestamp at ingest:** the safer of clamp-or-reject per data class (pre-ruled: "reject/clamp implausible device timestamps — define bounds"):
  - **Telemetry/history rows** (`device_data`, `dendro_readings`, `chameleon_readings`): **clamp to `now`** if the device timestamp is implausible AND log the clamp (a slightly-wrong recorded_at is better than a 1970/2099 row that breaks every range query and rollup); OR reject the row if clamping would corrupt a dedup key — decide per table at implementation, defaulting to clamp-and-log for append telemetry.
  - **The ingest point is the decoder/normalize boundary**, not the scheduler — the same boundary DD6's narrow-waist writer will own; for now it's the existing per-device write path. The clamp is a small guard function applied where `recorded_at` is derived.
- **This is edge-ingest-only** — it does not touch the sync wire contract or the server (the server already has its own `recorded_at` handling); it prevents the bad timestamp from ever entering the edge DB.

### B. Scheduler behavior on clock jumps

- **Forward jump — NEVER auto-fire missed windows** (pre-ruled, farmer safety over completeness): the scheduler fires on the cron tick for the *current* window only; it does not compute "windows I should have run since last tick" and backfill them. A forward jump that skips 06:00 means that day's window is simply skipped — **logged + heartbeat-flagged, never silently caught up.** Because the scheduler is already a stateless daily-cron tick (it evaluates current soil state, not a missed-window queue — verified §2), the correct behavior is largely the *current* behavior; this item makes it *explicit and guarded* rather than relying on the accident that the cron doesn't backfill. Add: on detecting a large forward time delta since the last tick (persisted last-tick timestamp vs `now`), log a `clock_jump_forward` event and set the heartbeat flag — so the skipped window is visible, not silent.
- **Backward jump — prevent double-fire via a `last_triggered_at` guard** (pre-ruled; and §2 verified NO such guard is active today): add a debounce to the decision path — before firing a window, check `last_triggered_at`; if the schedule already fired for the *current* logical window (same calendar day for a daily 06:00 cron, within a min-interval guard), **skip and log** rather than re-fire. Implement as either a `WHERE` predicate in the zones query (`AND (last_triggered_at IS NULL OR last_triggered_at < :windowStart)`) or a guard in the decision node reading the already-selected `last_triggered_at`. **The decision-node guard is preferred** (the query already selects `last_triggered_at`; adding the guard there is a localized, testable change and avoids a `windowStart` computation inside SQL). A backward jump that rewinds past 06:00 then hits the guard (the window's `last_triggered_at` is already today) → skip + log `clock_jump_backward_suppressed`.
- **This is the behavior 5.2's clock-jump scenario rehearses** — 5.6 defines and builds it; 5.2 Scenario 2 is its regression net (forward: no backfill; backward: no double-fire).

### C. RTC presence/health in heartbeat

- **Add a `rtc_present` / `clock_health` field** to the `osi-health-helper` heartbeat: read `/sys/class/rtc/rtc0` existence (and, if present, whether it's the system-clock source / has a plausible time) and/or BusyBox `hwclock -r` success. Report:
  - `rtc_present: true/false` (sysfs node exists + reads),
  - optionally `clock_source` (rtc vs ntp-only) and a `clock_jump` flag set when §B detects a jump (persisted last-tick delta).
- **Respect the 1.A1/1.A2 constraints:** `osi-health-helper` is a DD2-loader module under the ratchet trio — the field-add must stay within the node/module size ceiling; keep the RTC read small (one sysfs stat + optional `hwclock -r`), fail-soft (a read error → `rtc_present: null`, never a thrown heartbeat).
- **Both-profile parity:** the helper change + the heartbeat-flow field wiring land on bcm2712 + bcm2709 (mirror), `verify-profile-parity.js`.

### D. Testing

- **Timestamp clamp:** `node --test` unit tests for the clamp function — plausible timestamp passes through; 1970/2099/epoch/future-beyond-skew get clamped-to-now (or rejected per the table's decision) with the log; boundary values at `FLOOR` and `now+SKEW` behave as specified.
- **Scheduler clock-jump:** using the `rehearse-devices-rebuild.js`-style facade shim over the real `Decide + build actuator cmd` node (and/or the zones-query + decision path) with an injectable `now` and a seeded `last_triggered_at`:
  - forward jump across a window → assert NO fire (no actuator command, no `last_triggered_at` write) and a `clock_jump_forward` log;
  - backward jump with `last_triggered_at` = today → assert the guard suppresses the fire (no double-fire) and logs;
  - normal tick (no jump, `last_triggered_at` = yesterday) → assert it fires as before (the guard doesn't break normal operation — the critical regression check).
  These are the deterministic scenarios 5.2's Scenario 2 also runs.
- **RTC health:** unit-test the `osi-health-helper` RTC read against a fake sysfs path (present / absent / unreadable) → asserts `rtc_present` true/false/null (fail-soft). Wire into the existing health-helper test (`scripts/test-health-helper.js`).
- **No live gateway** — the on-Pi RTC read is verified in the 5.2 rig / operator rehearsal, not CI (CI has no `/sys/class/rtc/rtc0`).

## Non-goals

- **No boot-node (`sync-init-fn`) change** — the scheduler guard is in the decision node / zones query; the RTC read is in `osi-health-helper`.
- **No NTP/chrony reconfiguration** — this item defines *behavior under* clock jumps, it does not manage time sync itself.
- **No server-side timestamp handling change** — the clamp is edge-ingest-only; the server keeps its own `recorded_at` logic.
- **No missed-window catch-up feature** — the explicit farmer-safety decision is to NOT backfill; building a catch-up queue is the opposite of this item's intent.
- **No RTC hardware provisioning** — reports presence/health; does not add or configure an RTC chip.
- **The scheduler guard is not a general scheduling rewrite** — a localized debounce on the existing daily cron, nothing more.

## Definition of Done

- Timestamp sanity clamp at edge ingest with documented `[FLOOR, now+SKEW]` bounds; clamp-and-log (or reject per table) for implausible device timestamps; `node --test` covering plausible/1970/2099/boundary.
- Scheduler forward-jump safety: no missed-window auto-fire (explicit, logged `clock_jump_forward` + heartbeat flag), verified via the real decision node with injectable `now`.
- Scheduler backward-jump guard: `last_triggered_at` debounce in the decision node (verified today ABSENT), suppresses double-fire + logs, does NOT break the normal daily fire — the regression check.
- RTC presence/health field in `osi-health-helper` (reads `/sys/class/rtc/rtc0` + optional `hwclock -r`, fail-soft), within the 1.A1/1.A2 size ceiling; heartbeat-flow field wiring; both-profile parity.
- Tests wired into `migrations.yml` (`node --test` for the clamp + scheduler-guard + health-helper RTC read).
- 5.2 coupling recorded: Scenario 2 is this item's clock-jump regression rehearsal.
- The §2 finding recorded: today `last_triggered_at` is populated but NOT enforced as a debounce — this item adds the guard.
- No boot-node change; no NTP reconfiguration; no missed-window catch-up.
- "Open decisions" shows none outstanding.

## Open decisions

None outstanding.

- Timestamp handling: **clamp-to-now-and-log for append telemetry (reject where clamping corrupts a dedup key), bounds `[2024-01-01, now+1h]` as documented constants**, decided in §A — a slightly-wrong recorded_at beats a range-query-breaking 1970/2099 row; edge-ingest-only.
- Forward jump: **never auto-fire missed windows; log + heartbeat-flag the skip**, decided in §B — farmer safety over completeness (pre-ruled); the stateless daily cron already doesn't backfill, this makes it explicit and visible.
- Backward jump: **`last_triggered_at` debounce guard in the decision node (verified ABSENT today), skip + log**, decided in §B — the query already selects the column; the guard is a localized decision-node change over a SQL `windowStart` computation.
- RTC health: **`rtc_present`/`clock_health` in `osi-health-helper` via `/sys/class/rtc/rtc0` + `hwclock -r`, fail-soft, within the ratchet ceiling**, decided in §C — verified BusyBox `hwclock` present and the helper already uses `child_process`.
- 5.2 coupling: **Scenario 2 rehearses this item's scheduler behavior**, decided in §B/§D — 5.6 builds, 5.2 proves.
