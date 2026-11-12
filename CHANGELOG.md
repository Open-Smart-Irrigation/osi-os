# Changelog

All notable changes to OSI OS are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- Edge keeps every complete SDI-12 transmission, with the original LoRaWAN
  application events, in a local archive table before normalization
  (migration 0080). The archive is local-only and has no retention rule yet
  (#625); it stops inserting when the database filesystem has less than 1 GiB
  free, and the normal reading write is never blocked by it.

### Fixed
- **Valves are no longer blocked after an open, a timed close, flushing, a
  power cut or an upgrade: valve control decides as in 0.8.1.** 0.8.2 refused
  a new open (`valve_busy`) while an earlier command of that valve was
  unresolved, and for the shipped hardware that state never ended: after one
  open whose OPEN report was not received, after "close for N minutes", a
  timed close or flushing, after a report that arrived before the gateway's
  first time signal, and for a run left by 0.8.0 or 0.8.1 at upgrade. The
  0.8.2 entry "a new open of that valve is refused `valve_busy` until the
  first open's bounded duration has passed" described a bound the shipped
  configuration did not have. Now every command that is not a
  conditional-irrigation occurrence (manual, cloud, scheduler, one-time and
  service commands) is accepted and sent as 0.8.1 did;
  `scripts/test-valve-v081-equivalence.js` runs 54 sequences on the code of
  tag `v0.8.1` and on this code and compares what the caller is told, the
  frames, what the valve does and the state shown. In detail:
  - The gateway puts no queue expiry of its own on a valve frame. 0.8.2 gave
    every open and CLOSE 31 minutes, after which ChirpStack discarded it, a
    CLOSE included. A cloud `OPEN_FOR_DURATION` that carries its own
    `expires_at` keeps it, by the gateway's clock.
  - A manual CLOSE is always sent, with or without a time signal.
  - Without a time signal the state shown follows the newest report received.
    A report received in that state is attached to the one open it can belong
    to, as evidence without an observed time; 0.8.2 booked it as a second run
    with trigger `unexplained`. A report that fits no open, or more than one,
    is still booked as a run without a command, and the record says which.
  - The cancel of an ordinary open works as in 0.8.1: the open is taken out
    of the queue, settings and a CLOSE are queued again. The whole-queue flush
    of 0.8.2 applies where conditional irrigation is involved.
  - A timed open for a valve whose last report said OPEN is sent, and the
    answer carries `warning: valve_last_reported_open`: an open valve ignores
    a timed open and is not closed by it. A refusal by a conditional
    occurrence is answered 409 `valve_busy`, not 503.
  - A zone schedule save on a zone that holds a soft-deleted schedule row
    revives the row as 0.8.1 did, instead of failing on the unique
    constraint. A cloud command that names a version must be newer than the
    deleted row's; an equal version is answered 409.
  - Not protected, as in 0.8.1: two opens sent one after the other can both
    run when the valve's state-change report between them is lost; an open
    for a valve that is out of reach runs when the valve returns, hours or
    days later; a valve left open without a timer stays open until a CLOSE
    reaches it; a cancel does not stop an open the valve has already fetched.
    Frames a 0.8.2 gateway queued before the upgrade keep the 31-minute expiry
    0.8.2 gave them.
    A time-bounded protection for ordinary commands is a later project.
- **A rejected API token no longer marks the gateway `degraded` until
  Node-RED restarts (#462).** Record Error counted every 401 from a token
  guard as a gateway error, and `health_state` stays `degraded` while that
  counter is above zero, so one unauthenticated request or a browser with
  an expired token degraded the gateway until the next restart. Tagged token
  rejections are no longer counted in `errors_total`; they still appear as
  a rate-limited warning in the gateway log. Other errors count as before.
- The Kiwi/Clover `Process Data` node no longer logs
  `Unexpected payload structure` for every LSN50 uplink (#466).
- Journal V2: a mutation the cloud refuses with a 4xx no longer blocks the
  mutations of other journal records. A refusal receipt marks it rejected and
  it is not retried automatically; any other refusal holds it and retries it
  with a backoff from 15 minutes up to 24 hours. Later mutations of the same
  entry, plot, plot group, product or custom field wait behind a held or
  rejected one, so they reach the cloud in the order they were made. Behind a
  rejected mutation they stay queued and unsent until an operator resolves it
  (#612). 401, 403, 408, 429 and 5xx answers keep stopping the tick, and so
  does any 4xx refusal of a cutover barrier (#447).
- `deploy.sh` no longer refuses every deploy on a legacy-capture marker whose
  capture was pruned. It moves the marker aside and captures the live flows,
  GUI and helper modules afresh. Before any capture it now checks that they
  are one set, and refuses a set left half switched by a deploy cut off during
  its switch, with or without a marker; without a marker, earlier releases
  captured such a set as the rollback target. The same refusal follows a
  sysupgrade with a v0.8.1 or older image on a gateway deployed with helper
  modules in the payload, because those images copy their helpers over the
  module links. Both checks run before any live file is replaced (#466).

---

## [0.8.2] — 2026-11-09

Ordered schema migrations `0071__rain_observations.sql` to
`0079__chameleon_reading_links.sql` (nine) are new since 0.8.1, so the
migration head moves from 70 to 79. `0078` is a `data` migration; the other
eight are `additive`. Five helper modules are new in the payload:
`osi-rain`, `osi-matric-potential`, `osi-irrigation-policy`,
`osi-scheduler-mean-query` and `osi-local-password-reset`. `deploy.sh`
installs them with the flows (see the helper-module note below). The rain
coverage per zone day and the single selected gauge per zone that 0.8.1
announced for 0.9.0 ship in this release.

### Upgrade notes
- **Valve gateways: bench pass before farm gateways (#506).** This release
  changes how valve plans reach a STREGA valve: one full plan snapshot per
  edit instead of re-sent queued configuration. The change ships with the
  author's deploy statement unresolved: a GEN1 (SV1) farm gateway takes it
  only after a bench pass on a test gateway that includes a ChirpStack
  restart, and a GEN2 (SV2) gateway only after hardware gate 4 confirms the
  one-byte zero-window frame for an emptied day (or the owner adopts the
  `80` clear-prefix interim, `app_settings` `valve_gen2_snapshot_clear_prefix`
  = `1`). The bench list is in the #506 description. Deploy this release to
  the valve-equipped test gateway first and run that list before any farm
  gateway with valves.
- **Gateways still on 0.7.0 upgrade too.** The notes above assume 0.8.1. A
  gateway at 0.7.0 (migration head 68) also takes `0069` and `0070` in the
  same deploy; nothing else differs, and `deploy.sh` captures its live
  helper modules into the previous payload the same way.
- **Cloud first: OSI Server at osi-server `460c424b` (#389) or later before
  any linked gateway takes this release.** The edge adds four sync event ops
  for conditional irrigation (`IRRIGATION_POLICY_UPSERTED`,
  `IRRIGATION_POLICY_RUNTIME_CHANGED`,
  `IRRIGATION_POLICY_VALVE_RUNTIME_CHANGED`,
  `IRRIGATION_POLICY_DECISION_UPSERTED`) and links `VALVE_SCHEDULE` payloads
  to a policy. `460c424b` is the lowest osi-server revision whose
  `EdgeSyncService.java` passes `scripts/verify-sync-op-parity.js`; osi-server
  `main` at `3f670d6e` also passes. The gateway sends these events only while
  the cloud reports `conditional_irrigation_v1`, and it re-reads that every
  sync cycle. On an older cloud nothing is rejected: the events wait in the
  outbox and go out after the cloud upgrade, without a re-link. Linking or
  re-linking a gateway that holds a live conditional policy fails closed on
  an older cloud. To check a cloud, take the SHA from its
  `BACKEND_IMAGE_TAG=sha-<short>` and run
  `git -C <osi-server> merge-base --is-ancestor 460c424b <sha>`. If that
  fails, deploy the cloud (versioning workflow Step 6) before the release is
  published and before any linked gateway is upgraded. Per-contract detail:
  [docs/release/contract-order-v0.8.1-to-main-2026-11-09.md](docs/release/contract-order-v0.8.1-to-main-2026-11-09.md).
- **Never below osi-server `26d81145` (#366): zone-day rain goes wrong
  without an error.** `ZONE_ENVIRONMENT_APPENDED`, bootstrap and history rows
  now carry `rain_coverage`, `rain_selected_deveui`, `rain_policy_version`,
  `rain_quality_reasons` and `rain_received_mm`, and `rainfall_mm` is null
  unless the day's coverage is `complete`. A cloud before `26d81145` accepts
  these rows, but it reads a null `rainfall_mm` as "keep the stored amount"
  and a new row as 0 mm. Its rain history and irrigation advice are then
  wrong, and nothing reports it. `460c424b` from the previous note includes
  this receiver; this floor applies only when a cloud cannot reach
  `460c424b` before the gateways are upgraded.
- **The three new cloud commands need no gateway-first step.**
  `UPSERT_IRRIGATION_POLICY`, `PAUSE_IRRIGATION_POLICY` and
  `RETRY_IRRIGATION_VALVE` widen what the cloud sends, which would normally
  mean gateways first. OSI Server from `460c424b` delivers them only to a
  gateway that reports `conditional_irrigation_v1`. A 0.8.1 gateway never
  reports it and receives none of them.
- **Tensiomark observations wait for osi-server `0534ae13` (#372).** The new
  `tensiomark_observations` history table needs the cloud's mirror. An older
  cloud answers `REJECTED_PERMANENT` with `unsupported_table`; the gateway
  leaves that table's cursor where it was, keeps the observations pending
  until the cloud is upgraded, and keeps sending the other history tables.
  The Tensiomark channel layout on a device (`sdi12_channel_layout_json`) is
  stored by an older cloud but not interpreted.
- **LoRain rain rates: upgrade LoRain gateways before osi-server `3f670d6e`
  (#396) reaches their cloud, or in the same release window.** Edge
  migration `0078` (risk `data`) clears the rain rate and 10-minute value
  that earlier releases computed from the time between two reports. On a
  linked gateway the `device_data` update trigger queues each cleared row,
  and the gateway re-sends it to the cloud as a history correction. #396
  clears the cloud's copy once (Flyway `V2026_10_30_001`) and removes the
  "Show legacy estimates" switch. A 0.8.1 gateway still writes these rates,
  so rows it sends after that cloud migration keep them until the gateway's
  own `0078` runs and re-sends them cleared. The cloud no longer shows or
  exports LoRain rate channels, so nothing displays them in between. In the
  other order, an older cloud stores the cleared rows and shows an empty
  legacy channel behind the switch until it takes #396.
- **Valve actuation `archived_at`: no deploy order, one residual (#572).**
  Gateway snapshots now take `archived_at` from `observed_close_at`, else
  `commanded_at`, and no longer from `expected_close_at`. The cloud appliers
  ignore a strictly older value. A cloud row that already holds an
  `archived_at` taken from `expected_close_at` is later than the new value,
  so it keeps it and does not converge. Correcting those rows is open as
  #331.
- **A failed deploy now rolls the helper modules back with the flows (#603).**
  `deploy.sh` stages the `osi-*` helper modules in the payload and switches
  them with `flows.json` and the GUI, so a deploy that exits 1 on a 0.8.1
  gateway leaves the 0.8.1 flows on the 0.8.1 modules. Its first run copies
  the live 0.8.1 modules into the retained payload and refuses, before
  anything is stopped, if a module changed after an earlier attempt copied
  it. A run with an older `deploy.sh` that exits 1 can still leave the 0.8.1
  flows on the new modules: re-run it before leaving the site
  ([deploy runbook](.claude/skills/osi-live-ops-runbook/references/deploy.md),
  "Helper modules in the payload";
  [audit](docs/operations/deploy-module-ordering-audit-2026-11-09.md)).
- **Conditional irrigation cannot be switched on in this release (#515).**
  The shipped flows pass the policy service no valve qualification, so
  saving a policy that is enabled and attached to a schedule is refused with
  HTTP 503 `qualification_unavailable`. The refusal rolls the whole save
  back: the zone keeps its fixed schedules, and the valve keeps its plan and
  keeps watering. Once the gateway clock is trusted, the policy editor shows
  "Qualification: unavailable". A cloud `UPSERT_IRRIGATION_POLICY` that
  enables a policy is not applied either. A disabled policy can still be
  saved. Gen1 and Gen2 hardware qualification is open
  ([conditional irrigation](docs/operations/conditional-irrigation.md)).
- **Luganda: the owner accepted English text for this release.** On
  2026-11-09 the owner accepted the English source text, for 0.8.2, for the
  keys listed in
  [docs/i18n/pending-luganda-translations.md](docs/i18n/pending-luganda-translations.md):
  the "Release gate" section (device card footer keys that replaced human
  Luganda) and the keys added by #599, #585 and #569. This meets that
  section's gate, so 0.8.2 may go to a gateway whose interface runs in
  Luganda. A human Luganda pass follows in a later release.
- **Expect history repair uploads after the upgrade (#507).** The first
  history manifest pass compares segments that 0.8.1 never compared (see
  Fixed). It takes about 5 minutes per 500 segments, about 5.5 hours for
  33,000. A mismatch queues repair keys, at most 2,000 per table, and they
  drain at 50 keys per table per sync tick through the history batch upload.
- **Valve plans after a database restore (#506).** Press "Re-send plan to
  valve" on each valve after restoring `farming.db` from a backup: the
  restored ledger can describe a plan the valve does not hold, and nothing
  re-sends a plan on its own (see the plan snapshot entry under Changed).

### Added
- **Conditional irrigation, set up but not active (#515).** A zone can carry
  an irrigation policy that decides at each scheduled opportunity whether to
  water, from soil tension (Wet 20 kPa, Moist 30 kPa, Dry 50 kPa or a custom
  value), VWC or a dendrometer condition. Crossing a threshold never starts a
  run by itself. Without selected schedules the farmer picks a daily start
  time. The local resource is `/api/irrigation-zones/:id/irrigation-policy`;
  the cloud edits it with `UPSERT_IRRIGATION_POLICY`,
  `PAUSE_IRRIGATION_POLICY` and `RETRY_IRRIGATION_VALVE`. Migrations `0076`
  and `0077` add the tables and sync triggers. Activation is refused in
  this release; see the upgrade note.
- **Rain coverage per zone day and one rain gauge per zone (#488, #490,
  #493, #494, #497, #547).** Every LoRain and S2120 uplink is recorded once
  in `rain_observations` (migration `0071`), keyed by ChirpStack's
  `deduplicationId`. A repeated delivery, also after a restart, and a
  confirmed-uplink retransmission count once. A different payload under the
  same identity is quarantined, and a frame without that identity is stored
  but never counted. Each zone day now carries a coverage (migration
  `0072`): a measured 0 mm stays 0, missing evidence stays unknown, and an
  incomplete day keeps what was received as a lower bound, shown as
  "received only". When two gauges in a zone qualify, nothing adds them: the
  zone asks for one to be chosen in its settings, and a change recomputes
  the last 30 days. A gauge chosen automatically because it is the only one
  is named in the settings, and a failed gauge save after the other settings
  saved keeps the dialog open with a retry message. Migration `0073` sends
  the quality fields to the cloud (see the cloud-first notes above).
- **SDI-12 Tensiomark probes (#503, #525).** The SDI-12 card commissions a
  Tensiomark through versioned probe profiles, with a validated layout per
  sensor (address, channel, depth). The gateway converts the probe's pF into
  canonical kPa in `swt_N` with the `osi-matric-potential` conversion the
  cloud also uses, and keeps each observation in `tensiomark_observations`
  (migrations `0074` and `0075`), which syncs as a history table (see the
  Tensiomark note above). The soil tension display range widens to 0 to
  1,000,000 kPa, and CSV v1 soil-tension pF cells carry full precision,
  formatted like the cloud export. A legacy `PUT /sdi12/config` with
  `probe_profile: TENSIOMARK` and no layout is refused with HTTP 400 instead
  of clearing the layout. #525 makes commissioning call the ChirpStack
  helper methods that exist; before, every apply and rollback failed before
  it reached the device.
- **Read-only rain history comparison (#498).**
  `scripts/rain-history-diff.js` reads a retained copy of `farming.db` and
  writes per-device and zone-day CSV with summaries. It gives numeric
  differences only where gauge and period provenance supports them, and it
  refuses a live database path or its SQLite sidecars.

### Changed
- **A cancelled open that was handed to ChirpStack keeps the valve reserved.**
  The cancel still flushes the device queue and never sends a CLOSE, but a
  queue read taken before the flush no longer counts as proof that the open
  was not delivered: ChirpStack can deliver it between the read and the flush.
  Such a cancel is answered `handed_off` (HTTP 409 with the cancel help text),
  the actuation stays observed, and a new open of that valve is refused
  `valve_busy` until the first open's bounded duration has passed. Only an open
  that never reached ChirpStack is cancelled outright. An unclaim reports the
  same outcome in `in_flight_cancel`.
- **One full plan snapshot per valve edit (#506, #515).** A schedule add,
  edit or delete, "Re-send plan to valve", pause, skip today, resume and
  unclaim each send the valve its complete current plan. 0.8.1 re-sent older
  queued plan rows after a queue flush. Edits less than 30 s apart produce
  one snapshot, sent 30 to 90 s after the last edit and at most 5 minutes
  after the first; the valve tick runs every 60 s instead of 600 s. A GEN1
  snapshot is up to 8 downlinks (status, then seven weekdays) and Class A
  delivers one downlink per uplink, so it takes about 8 uplink intervals; a
  pause, one downlink before, is now a full snapshot. A valve with no weekly
  schedule and no plan history gets the status only, so a plan programmed
  over Bluetooth is not wiped. A newer snapshot supersedes older rows still
  waiting for an ACK. A row the valve may not hold (unacknowledged after
  24 hours, or removed by a cancel or unclaim flush) shows "Device may not
  hold this plan" on the valve tile, and nothing re-sends it: "Re-send plan
  to valve" is the recovery. Snapshots go out through the ChirpStack API
  only, with no MQTT fallback; without it they stay pending and STREGA
  writes fail closed. A GEN2 empty day is sent as a zero-window frame;
  `app_settings` key `valve_gen2_snapshot_clear_prefix` set to `1` sends the
  whole-plan clear `80` first (default off). An older cloud shows the new
  lost slots as failed.
- **Sync contract: a cloud `PAUSE_IRRIGATION_POLICY` may carry
  `expected_policy_version: null`.** The field stays required. Null pauses the
  version that is current on the gateway, also while a newer edit is still
  pending on the valve or was not applied; an integer still has to match the
  current version or the pause is refused as a version conflict.
- **Irrigation advice reads rain by evidence, not by amount (#492, #496).**
  Dendrometer advice and the Water tab take a certified local gauge day
  first, so a measured dry day wins over provider rain. Next comes a
  received amount of 5 mm or more as a lower bound: it may start rain
  suppression but never proves a dry day. Then provider rain, measured by a
  station before modelled, over the hours of the farm day that have passed.
  Otherwise the rain is unknown: that never starts suppression, and the zone
  verdict is shown with `rain_unknown`. Before this release a measured 0 mm
  day fell through to provider rain, and a provider's 6 mm could start
  suppression on a dry day. The rules are in
  [docs/contracts/rainfall/rain-resolution-policy.md](docs/contracts/rainfall/rain-resolution-policy.md).
- **Threshold scheduling counts a Chameleon reading only through its link
  to the raw reading (#573).** Migration `0079` adds
  `chameleon_reading_links`, and ingest writes the reading, its raw
  diagnostic and the link in one transaction. The scheduler leaves out a
  Chameleon reading without a link, a reading flagged I2C, timeout or
  data-invalid, and a channel flagged open, and it counts a Chameleon
  channel only from 0 to 300 kPa. Readings stored before the upgrade have no
  link, so a Chameleon zone's one-hour mean starts with the first reading
  after the upgrade. If the new query module does not load, the zone is not
  evaluated and no valve opens. KIWI, CLOVER and SDI-12 keep the 0 to
  1,000,000 kPa range, and the Water card display is unchanged.
- **The LoRain rate and 10-minute value are gone from the Data view
  (#584).** Migration `0078` clears them (see the LoRain note above), and the
  "Show legacy estimates" switch and its "(legacy estimate)" label are
  removed. A saved view that held the rate opens without it and keeps the
  rain amount.
- **Soil cards (#500, #508, #510, #599).** The Wet, Moist and Dry pill shows
  on the latest stored reading at any age, and the card states that age;
  0.8.1 hid the pill after 3 hours. A stale Water card reading keeps its
  value and pill under "No reading since …". The status dot gets a fill
  level, so the three states differ without colour. WATERMARK and Tensiomark
  readings share one soil tension layout, and LSN50 and SDI-12 cards get the
  "Last seen" footer. Device and zone cards say that automatic irrigation
  does not use WATERMARK readings.
- **VWC rows in the CSV export carry their depth (#509).** A `vwc_N` or
  `soil_vic_N` row takes its depth from the Sentek layout when the depth map
  has none, and is labelled `VWC 20cm` or `VIC 12.5cm`. **Values change** in
  the `series_label` column.
- **Environment tab (#581, #582, #583).** It opens on Weather when current
  conditions or a forecast can be shown, otherwise on the first of Water,
  Soil, Sensors or Agronomy that has data; a tab the user picked stays
  picked across refreshes. Tabs are at least 48 px high and wrap their
  labels on a narrow card. Fallback banners are translated from a new
  `display.fallbackReasonCode`, and the environment summary adds an ordered
  `reasonCodes` list next to the English drift `reason`.
- **Valve schedule dialogs (#560, #593, #595).** Deleting a valve schedule
  asks for confirmation and names the valve and schedule. A rejected
  schedule lists every conflict instead of the first. The valve overflow
  menu no longer reopens on a second click on "More", and it takes arrow
  keys and Escape.
- **Migration files are checked before the database is touched (#528).**
  The migration runner, the deploy staging, retry, reconciliation and
  rebuild tools accept only the exact set of migration files listed in
  `CHECKSUMS.json`, with matching SHA-256, and refuse before any bookkeeping,
  backup pruning or SQL. The operator still has to deliver the files from a
  trusted checkout or bundle:
  [docs/operations/migration-manifest-trust.md](docs/operations/migration-manifest-trust.md).
- **Faster migration step (#577).** The runner reads the schema fingerprint
  PRAGMAs in four queries instead of one `sqlite3` process per table and
  index. A replay of all migrations went from 201 s to 8 s on the CI host,
  and the deploy's migration step uses the same runner.
- **`scripts/verify-sync-op-parity.js` counts every cloud event applier
  (#602).** The release pre-flight check from the first upgrade note only
  looked for appliers next to `EdgeSyncService.java`, so a cloud without the
  journal or scoped-access appliers could still pass. It now scans the
  whole server source tree.
- **Repair runbook corrections (#571, #548).** The live-ops references no
  longer describe editing a linked password verifier by hand or applying
  raw seed SQL. A backup counts only when the flows, settings, credentials
  and GUI copies all succeed, and a requested ChirpStack edit stops before
  any write, because the optional raw ChirpStack copy is not a rollback
  backup. The pre-ledger catch-up runbook is now a general guide.

### Fixed
- **A valve unclaimed from the cloud now gets the same plan-clearing push as
  a local delete (#504, #515).** In 0.8.1 a cloud `UNCLAIM_DEVICE` cleared
  the device owner and zone and acknowledged success, but never ran the
  valve plan cleanup the local device delete runs, so an unclaimed STREGA
  valve kept executing the weekly plan stored in its firmware. Both paths
  now run in the conditional lifecycle service. It detaches the device,
  cancels queued opens without sending a CLOSE, tombstones the schedules and
  queues the snapshot that clears the valve, which the valve tick sends 30
  to 90 s later. Like the local path, the cloud path flushes the device's
  whole ChirpStack queue. The valve may still hold its plan until it
  receives the clearing push; nothing confirms that it did.
- **A replayed cloud unclaim no longer detaches a re-claimed device.** The
  detach is now fenced on `sync_version`, like zone assignment and removal: a
  command older than the device's current version changes nothing and is
  acknowledged `REJECTED_PERMANENT` with `stale_sync_version`, which the
  cloud shows as a failed removal. A valve's open/close transitions also
  raise its version, so an unclaim issued while the cloud mirror is behind
  can be refused; retry once the gateway has synced.
- **Unclaim reports what happened to the valve plan.** Both unclaim paths now
  report one cleanup outcome: `not_applicable`, `not_attempted` (for example
  a refused version fence), `failed`, `no_plan_to_clear` or
  `clearing_scheduled`, with `may_still_hold_plan` and
  `plan_clear_confirmed: false`. The valve has no read-back, so a scheduled
  clearing plan is not reported as a cleared plan. The local
  `DELETE /api/devices/:deveui` still answers 200 when the device was
  removed, adds `valve_cleanup` to the body, and its message says when the
  clear is still on its way or failed. The cloud ACK result is `APPLIED`,
  with `valveCleanup` (including `final`) and `reason`; a cleanup that
  finishes after the ACK goes out as a second, final ACK row. No cloud
  change is needed to accept the fields.
- **History repair reaches every segment (#507).** The gateway sent the
  cloud the same first 500 history segments every 5 minutes, so a segment
  after position 500 was never compared or repaired. The manifest now pages
  through all segments with a stored cursor; the request, the 500-segment
  page and the 5-minute cadence are unchanged. After a repair batch, new
  rows of that table go out within two turns. See the upgrade note on the
  first pass.
- **History charts keep each physical sensor as its own trace (#502).**
  History reads and charts could join readings of different sensors into
  one line, with jumps that no sensor measured. Series are now keyed by
  device and channel through raw reads, retained history, the API and the
  GUI; a missing bucket stays a gap and zero stays a measurement. An
  interactive request is capped at 30,000 points in total; above that the
  chart offers another source, a shorter range or a coarser step instead of
  drawing part of the data.
- **Two rain counter uplinks in flight no longer count the same rise twice
  (#490).** The S2120 counter read, the `device_data` insert and the zone
  rain update were separate steps: with 100 stored, readings of 101 and 102
  were counted as 1 and 2 mm. They now run in one transaction, as does the
  LSN50 MOD9 tip counter. A counter frame older than the latest reading is
  stored with `late_counter_frame` and never counted.
- **Provider rain on a day with a midnight clock change (#497).** The
  forecast now uses the same zone-day boundaries as the rest of the rain
  code. On such a day it had counted the hour before midnight and 24 hours
  instead of 23.
- **LoRain and STREGA housing temperature no longer counts as zone air
  temperature (#585).** The LoRain temperature comes from a thermistor on
  the gauge's circuit board and the STREGA reading from the valve enclosure,
  and both were averaged into the zone's air temperature and from there
  into VPD and dew point. The zone environment now leaves both out. The
  LoRain card labels the value "Gauge housing temperature" with the time of
  the last report, and ingest stores a LoRain temperature outside -50 to
  100 °C as empty, which catches the -273.1 °C of an open or shorted
  thermistor. Stored values are not rewritten.
- **The valve safety CLOSE no longer refuses on some uptime readings
  (#587).** A valid `/proc/uptime` value such as `2.01` became
  2009.9999999999998 ms in floating point, and the integer receipt check
  then refused the CLOSE. The reader now takes the decimal digits as whole
  milliseconds.
- **Removing an S2120 from a zone removes its weather link (#588).** The
  zone kept using the detached station. Only that station and zone pair is
  removed, with its sync event in the same transaction; the primary
  assignment and other links stay. A cloud unclaim of an S2120 removes its
  weather links before the unclaim event and records the decision with its
  acknowledgement, so a replay gets the same answer.
- **RAK10701 field tester (#398).** The gateway recognises a tester by its
  device type instead of its ChirpStack profile, so a Clover uplink can no
  longer be decoded as a tester position, and a valve in the tester
  application no longer gets a tester reply on fPort 2, the STREGA
  timed-action port. A frame with zeroed coordinates is no GPS fix. A reply
  that misses its uplink's downlink window expires instead of going out
  after the next uplink. The Network page marks a row without a position
  "No GPS fix" and says the tester needs a clear sky.
- **Chart axes fit their labels (#511).** Axis titles could fall off the
  canvas, and right-hand axes were squeezed into a fixed margin. Axis bands
  are now sized to their tick labels, small multiples drop to one column
  below 520 px, and an overlaid chart stacks its series when the plot is too
  narrow to read.
- **Per-zone history CSV is served as CSV (#561).** The export answered
  `application/json` around CSV bytes; it now answers
  `text/csv; charset=utf-8`.
- **The device list shows rain-day dates again (#586).** The flow asked for
  a helper module that the shipped registry did not map, so rain-day data
  was missing from the device list.
- **Native SQLite module recovery (#570).** An interrupted restore of the
  `sqlite3` module by `deploy.sh` or the first-boot seed could leave the
  original under the final path, and the other tool could then delete it.
  Each tool now refuses before touching the module while the other's
  rollback entry exists.
- **Readable button labels (#596, #598).** White text on the dark-mode
  primary colour (1.86:1) moves to the theme's near-black, 10.39:1; this
  covers Sign In, the Add menu, the active tab and the main valve buttons.
  Labels on amber confirm buttons, the green schedule toggle, the zone
  card's "Data" link and the "Re-authenticate" button get the same
  near-black in both themes.
- **Translations (#559, #563, #592, #594).** The Advanced Schedule drawer is
  translated in every interface language, and the valve-control setting in
  Spanish, Italian and Portuguese. New Luganda keys ship the English text
  and are listed in `docs/i18n/pending-luganda-translations.md`.
- **Journal times in the repeated hour (#543).** An untouched default time
  in the capture and copy forms no longer becomes ambiguous during the hour
  that repeats when clocks go back.
- **Pasted device credentials (#544).** A DevEUI or AppKey pasted with
  spaces into either registration form was cut at the field length before
  validation; spaces are now removed first.

### Security
- **Self-registration only creates the first account (#468).** With
  `OSI_SCOPED_ACCESS` off, `POST /auth/register` created an account for any
  client that could reach port 1880. It now creates an account only while
  the gateway has none, in one conditional write, and answers 403 with
  "Registration is closed: this gateway already has an account. Sign in with
  an existing account." afterwards; the register screen shows that message.
  A fresh image still sets up its first account the same way, and login is
  unchanged. With the flag on, the same empty-table rule applies since #519
  (next entry). With the flag off there is no route for a second local
  account: the account recovery runbook
  (`docs/operations/account-recovery-runbook.md`) describes how an operator
  adds one on the gateway, and turning scoped access on gives admins account
  management. The live test harness now needs `--user NAME` on a
  gateway that already has an account.
- **Scoped self-registration no longer creates an admin on a gateway that
  has accounts (#519).** With `OSI_SCOPED_ACCESS` on, `POST /auth/register`
  created an admin whenever no admin row existed, even if `users` held other
  accounts. A gateway with only researcher or viewer accounts, for example
  one whose first account was registered with the flag off, gave admin to
  the first client that reached port 1880. Registration now
  requires an empty `users` table in both modes; disabled and linked
  accounts count. A refused request gets 403 with "Public registration is
  closed. Ask an administrator to create your account, or contact the
  gateway operator for account recovery." A fresh image still makes its
  first account an admin. Before turning scoped access on for a gateway that
  already has accounts, follow the account recovery runbook: the new
  `scripts/account-recovery.js`, run on the gateway, changes the role or
  disabled state of one selected account, or creates a named recovery
  admin, in a single checked transaction.
- **Scoped admin actions read the current role (#575).** With
  `OSI_SCOPED_ACCESS` on, an admin guard could keep authorizing an account
  demoted after its role was cached. Each token-bound admin decision now
  reads the current user row and refuses a disabled or deleted account, and
  a scope load started before a change can no longer refill the cache. The
  history admin path uses the same check.
- **A linked account's password is not reset locally (#569).** A linked
  account signs in with its linked credential, so the admin password reset
  reported success without changing that login. The reset now changes only
  local accounts and refuses a linked one with 409
  `linked_account_password_reset_unsupported`; the Users page offers the
  form only for local accounts and points to recovery through the linked
  identity.
- **Reference-tree flag bound to its owner (#523).** With
  `OSI_SCOPED_ACCESS` off, a signed-in user could change another owner's
  reference-tree flag. The route now binds its lookup and its update to the
  signed-in owner and answers 404 when ownership changes in between. The
  valve API also closes its ChirpStack client after each request that
  flushed a queue.
- **Credential env files are written with mode 0600 (#527, #532).**
  `.chirpstack.env` and the other credential env files could keep a wider
  mode through a repair or replacement. They are now written complete
  through a temporary file at mode 0600, with a raw backup kept, and a
  failure on the credential file stops the deploy's provisioning step.
- **The ChirpStack API key stays out of error output (#530).** A failed
  `create-api-key` CLI call in the bootstrap printed the CLI output and the
  error message, and a key with characters that gRPC metadata refuses made
  grpc-js quote the whole `Bearer` value. Both now fail with a fixed message
  that carries neither.

---

## [0.8.1] — 2026-10-10

Rain fixes from the October rainfall review, plus valve command safety. No
schema migration and no new device type since 0.8.0: a gateway goes back to
0.8.0 by redeploying the 0.8.0 bundle.

### Upgrade notes
- **Deploy OSI Server first.** It is not a hard order (no new sync event, no
  new contract field the cloud must accept), but two edge changes read
  better on an updated cloud. A flow-only LSN50 day now syncs
  `rainfall_mm: null` with `rain_source: none`; OSI Server from #358 on reads
  that row as unknown rain, while an older cloud stores 0 mm and its
  prediction input uses that zero in place of the weather archive. The valve
  refusals below come back as `REJECTED_PERMANENT` acknowledgements, which
  every cloud already handles.
- **No database change.** 0.8.1 adds no migration and rewrites no stored
  row. Rolling back is a redeploy of the 0.8.0 bundle. Rows that 0.8.1
  wrote stay valid under 0.8.0: 0 mm zone rows from dry LoRain heartbeats,
  and empty rain on flow-only LSN50 days, which 0.8.0 reads as 0 mm as it
  always did.
- **Check each zone's time zone.** Rain history, the rain "today" tiles and
  the LoRain zone rows now count days from the zone's own midnight. A zone
  whose stored time zone is an abbreviation such as `CET` or a name the
  gateway does not know shows "Check the zone time zone in its settings."
  under its rain history; set it to a region name such as `Europe/Zurich`
  in the zone settings. Nothing rewrites the value for you. A zone on the
  default `UTC` is valid but counts days from UTC midnight. To list the
  zones to look at:
  `sqlite3 /data/db/farming.db "SELECT id, name, timezone FROM irrigation_zones WHERE deleted_at IS NULL AND timezone NOT LIKE '%/%';"`
- **Upgrade with `deploy.sh`, so flows and GUI change together.**
  `GET /api/devices/:deveui/rain-history` now answers a version 2 object
  (farm time zone, day bounds, one entry per day). A 0.8.0 dashboard on
  0.8.1 flows shows "No rainfall recorded in this window" in the 7, 30 and
  90 day rain views. A 0.8.1 dashboard on 0.8.0 flows still works (it reads
  the old array as UTC days). The firmware feed copy of the dashboard is
  refreshed in this release.
- **SenseCAP S2120 rain totals stored before this release are not validated
  measurements.** Earlier ingest read the rain intensity (measurement 4113,
  mm/h) as a rain counter, so the stored S2120 increments, daily totals,
  zone rain from an S2120 and the rain rates derived from them are wrong in
  both directions: steady rain was stored as zero, and a fall in intensity
  was read as a counter reset. These rows are not rewritten by the upgrade
  and still reach the history, the zone water balance and the cloud mirror.
  `scripts/assess-s2120-rain-history.js <copy of farming.db> [--uplinks
  <events.jsonl>]` reports, per device and day, the stored increments next
  to what the cumulative rainfall (4213) gives where raw uplinks were kept,
  and marks every other day unverifiable. It opens the copy read-only and
  refuses `/data/db/farming.db`. After the upgrade, the first S2120 uplink
  that carries 4213 starts a new counter baseline (status
  `cumulative_baseline`) and has no increment, so the rain of that one
  interval is not counted.
- **Cloud valve commands that the gateway now refuses.** A `VALVE_COMMAND`
  with `action: OPEN` or `CLOSE`, or without a duration, and a
  `SET_STREGA_TIMED_ACTION` without a usable duration are answered
  `REJECTED_PERMANENT` with a reason (`valve_action_not_allowed`,
  `missing_or_invalid_duration`, `duration_out_of_range`). Before,
  `action: OPEN` and `CLOSE` reached the valve as a bare open or close, and
  the timed action was dropped. A cancel that names no actuation while two or more actuations of
  one valve are active is refused with `ambiguous_actuation`; OSI Server does
  not send `expectation_id` yet, and the local dashboard cancel answers 409 in
  that case.
- **Dendrometer advice may move on the first run.** See the rolling 7-day
  rain entry under Fixed: some zones move from `decrease_20` to
  `decrease_10`.

### Known limitations
- A LoRain heartbeat writes 0 mm for its zone day at the heartbeat's own
  time. If rain reports of that day were lost, the day total undercounts and
  nothing marks it. Coverage and interval quality per day come in 0.9.0.
- `rain_mm_today` on a device is still summed per gateway host day. On a
  gateway whose system clock runs on UTC with a farm in another time zone,
  the "today" tile can show the UTC-day total between the farm's midnight
  and UTC midnight.
- A LoRain report with rain still overwrites a zone day that another rain
  source (S2120, LSN50 gauge, weather service) wrote. Zero reports no longer
  do. One selected gauge per zone comes in 0.9.0.
- On the Water tab, a verdict flagged `rain_unknown` shows its reason but no
  action word while the balance is empty. The zone card shows both.
- OSI Server prefers any zone rain row over the weather archive for its
  forecast input, so a zone measured only by a LoRain gauge gets 0 mm from
  the cloud on days with heartbeats and no rain report, including days
  whose rain frames were lost.
- New strings in this release carry English text in the Luganda bundle
  until the human translation pass (`docs/i18n/pending-luganda-translations.md`).

### Added
- **Data view CSV with quality columns (opt-in).** An "Include quality
  columns" switch next to "Export CSV" writes version 2 of the Data view
  CSV: a first line `# osi-csv-version: 2`, then the version 1 columns plus
  `timezone, period_start, period_end, quality, coverage, sample_count`. A
  daily row spans its zone-local day (23 or 25 hours across a clock
  change). Rain amounts are `received_only` and carry no coverage figure; a
  partial weather sum gives its coverage as a fraction. Version 1 stays the
  default with the same columns and format. The gateway's zone and
  all-zones exports have no version 2.
- **LoRain rainfall contract.** `docs/contracts/rainfall/lorain.md` states
  what each LoRain frame proves (truth table `T1` to `T16`), when a silent
  span counts as dry, and the conditions under which a gauge's reports may
  be treated as verified. Replay fixtures under `scripts/fixtures/lorain-rain/`
  run through the shipped codec in CI. No codec or flow change.

### Changed
- **Data view daily device buckets follow the zone's local day.** Device
  series in the Data view summed and averaged their daily buckets over UTC
  days; they now run from the zone's local midnight to the next, like the
  weather series beside them, the history cards and the zone export. This
  applies to every device channel (soil, rain, temperature and the rest).
  **Values change:** a saved view at daily aggregation, and the daily
  device rows of a Data view CSV, show new bucket times (for example
  22:00Z or 23:00Z instead of 00:00Z in Europe/Zurich) and new values.
  Weekly buckets are unchanged (7 × 24 hours from the range start), as are
  hourly and raw series. Devices without a zone stay on UTC days. Stored
  data and rollups are not touched.
- **Rain amounts are labelled as amounts.** `rain_mm_delta` reads
  "Rainfall amount", and "Rainfall this interval" on raw samples, in the
  Data view (series, legend, tooltip, axis) and in the `series_label` of
  every CSV: the Data view CSV and the gateway's zone and all-zones
  exports. **Values change** in that column ("Rain delta" before). Channel
  keys, units and series ids are unchanged, so saved views keep opening.
- **The LoRain rate and 10-minute value are legacy estimates.** They are
  computed over the time since the previous report, not measured. For a
  LoRain gauge the Data view lists them only on request ("Show legacy
  estimates") or when a saved view selected one, marked "(legacy
  estimate)", and metric presets skip them. Saved views and exports still
  resolve them under their keys. S2120 and LSN50 rates are unchanged. Rain
  amount tooltips state how many reports were received instead of a
  coverage figure.
- **The LoRain card's "Rate" tile is now "Last report".** It shows when
  the last report arrived, in the farm timezone with the zone named. The
  interval tile reads "Rainfall this interval", and the card's rain history
  offers the interval amount and the farm-day total.

### Fixed
- **Rain "today" tiles no longer show yesterday's total as today.** The
  LoRain "Today" tile, the S2120 "Rain today" tile and the LSN50 rain gauge
  line showed the stored daily total without a date, so the morning after
  the last report of a day still read "Today 8 mm". `GET /api/devices` now
  adds `rain_day`, `rain_day_timezone` and `rain_day_timezone_basis` for
  every rain-capable device: the farm-local date of the latest reading and
  where the time zone came from (the device's zone, else the zone of the
  weather station it serves, else UTC). The tiles show the value only while
  that date is today in the farm's time zone, never the browser's;
  otherwise they show "—" and "Last report <date>: <value> mm". An open tab
  switches at the farm's midnight without a reload.
- **Rain history days are the farm's days.** The daily rain history
  (7, 30 and 90 days) was bucketed with the viewer's current UTC offset,
  applied to every past date: a Zurich reading at 22:30 UTC on 1 July
  belongs to 2 July but landed on 1 July for a viewer on winter time, and a
  viewer abroad shifted every day. The gateway now cuts the days at the
  zone's own midnights, so 23- and 25-hour days around a clock change are
  exact, also in zones where the change happens at midnight. A day without
  readings is empty instead of 0 mm, the current day is marked "so far",
  and the footer names the farm time zone. `tz_offset_min` is accepted and
  ignored.
- **Dry LoRain heartbeats reach the zone table.** A LoRain gauge as
  installed sends nothing while it is dry and a heartbeat with zero tips
  every 4 hours. Those heartbeats never reached the zone's daily row, so a
  gauge that reported dry looked like a silent one. A valid zero report now
  writes 0 mm for the zone day, owned by the gauge; a silent gauge still
  has no row. A zero never takes over a day that another source wrote. A
  new zone day starts from this gauge's own reports inside the zone's local
  day, not from the gateway host's daily total, so yesterday's rain no
  longer carries into the next local morning. Further dry heartbeats on the
  same day add no cloud sync events.
- **Unknown rain is no longer reported as a measured 0 mm.** The zone water
  tile read a day without a rain-gauge row as 0 mm, so a zone with a 4 mm
  demand and no rain observation showed a balance of -4 mm. Today's rain now
  counts only when a gauge wrote it; a measured 0 needs a configured rain
  gauge (the cloud's rule). Otherwise `rainTodayMm` is null,
  `rainTodayStatus` is `unknown` and the balance is null. The water verdict is
  still shown, computed on zero rain and flagged with the reason
  `rain_unknown` ("No rain measurement for today"); with no forecast rain
  either, it stays "Not enough data to advise". The switch is
  `RAIN_UNKNOWN_POLICY` in `osi-zone-env` (`warn`, or `withhold` for
  insufficient data), the same name and default as on the cloud.
- **Forecast rain totals without rain values are unknown, not 0 mm.** The
  next-24-hour and next-72-hour totals are null when no forecast hour in the
  window carries a rain value, and the 24-hour total comes with
  `next24hCoverage`. The Weather tab shows a dash for an unknown total and
  "x of 24 h" for a partly covered one.
- **An LSN50 flow-only uplink no longer writes a dry day.** An uplink with a
  flow delta but no valid rain delta inserted 0 mm of rain labelled as a
  gauge reading. It now writes flow only: a new zone day keeps rain empty
  with source `none`, and an existing day keeps its rain and source.
- **Zone forecast: rain hours are no longer shifted by the zone's UTC
  offset.** The zone environment summary asked Open-Meteo for the zone's
  timezone, which returns local times without an offset, and then read
  those times as UTC. In a zone two hours ahead of UTC, rain forecast for
  12:00 local was shown at 14:00 local. The next rain time, the hourly rain
  chart and the next-24-hour and next-72-hour rain sums took the wrong
  hours, and so did the delay-irrigation advice that uses the next-24-hour
  sum. The time of the current online weather had the same shift. The
  gateway now asks Open-Meteo for exact timestamps. Daily forecast values
  and the hourly weather history used for ET0 were not affected. Forecasts
  and current weather cached before the upgrade are no longer used, also
  not as the offline fallback.
- **S2120 rain comes from the cumulative rainfall, not the intensity.** The
  SenseCAP S2120 sends two rain values: 4113, rain intensity in mm/h (six
  times the rain of the past ten minutes), and, from firmware v2.0, 4213,
  cumulative rainfall in mm. Ingest differenced 4113 as if it were the
  counter and never read 4213. With a steady 0.254 mm/h intensity and the
  cumulative value rising from 1.778 to 2.032 mm, the gateway stored no
  rain instead of 0.254 mm, and every fall in intensity was logged as a
  counter reset. Now 4213 is stored as `rain_gauge_cumulative_mm` and
  differenced; 4113 is stored as `rain_mm_per_hour` and is never a counter.
  Rows written before the upgrade are never used as a counter baseline. For
  firmware without 4213, an interval gets 4113 / 6 as its rain only when it
  is the vendor's ten-minute window (600 s, with 60 s tolerance); any other
  interval (a lost uplink, another reporting interval) keeps the amount
  empty with status `intensity_only`, and the zone shows "the rain amount for
  this interval is unknown". A device that has sent 4213 never adds
  intensity, so no rain is counted twice. Increments, daily totals and hourly
  station rain keep 0.001 mm; values are rounded only for display.
- **Dendrometer advice counts rain over seven calendar days.** The rolling
  rain behind the "No stress + heavy recent rain (>20mm/7d)" rule added the
  seven most recent stored days to the analytics day, so with complete
  history it covered eight days, and with gaps it could reach back months.
  It now covers the seven calendar days ending on the zone's analytics day,
  and the recommendation records the window and how many of its days had a
  rain value. A day without a rain value counts as missing, never as a dry
  day. When the analytics day's rain is unknown (no local gauge amount and no
  provider precipitation value), the recommendation is still given and
  carries a `rain_unknown` warning; unknown rain never starts rain
  suppression. **Behaviour change on the first run after the update:** a
  zone without stress that had more than 20 mm over the old eight days but
  20 mm or less over the seven calendar days moves from `decrease_20` to
  `decrease_10`, and so does a zone whose sparse history reached outside the
  week.
- **Cloud valve commands open a STREGA valve only for a bounded time.** A
  cloud `VALVE_COMMAND` reached the valve with its action as sent, so
  `action: OPEN` became an open with no end time. The gateway now accepts
  only `OPEN_FOR_DURATION` for 1 to 255 minutes, read from
  `duration_seconds`, `durationMinutes` or `duration_minutes`, and the
  STREGA downlink builder no longer encodes a bare open. A cloud
  `SET_STREGA_TIMED_ACTION` is sent as a timed open for the duration it
  carries (`amount` and `unit` included); before, the gateway dropped every
  one. Each refused command is answered with a reason instead of staying
  leased in the cloud until it expires. A second delivery of the same timed
  action, partial opening or flushing replays its first answer instead of
  acting again. Refs #427.
- **A valve cancel stops the actuation it names.** A cancel marked the
  newest actuation and flushed the valve's whole downlink queue. It now
  cancels the actuation named by `expectation_id`, or the only active one,
  and refuses when several are active and none is named. Plan pushes and
  configuration queued for the valve are queued again in order; another
  actuation's open that the cancel took out is not re-sent, and the answer
  names it (`dropped_opens`). Refs #428.
- **Deploy keeps the newest three pre-migration backups, not three files.**
  The retention step of `deploy.sh` (and of every migrating run) counted the
  `-wal`, `-shm` and `-journal` files that SQLite leaves next to a backup
  that was once opened in place. Those side files took slots in the kept
  window, so real backups were deleted even when no migration ran. Retention
  now counts only backup files, removes a backup together with its side
  files, never touches the newest `MIGRATE_BACKUP_KEEP` backups, and logs
  every file it removes. Side files whose backup is already gone are left in
  place. Fixes #474.

---

## [0.8.0] — 2026-10-07

Ordered schema migrations `0017__zone_key_fallback_parity.sql` to
`0070__journal_catalog_v11.sql` (54 migrations) are new since 0.7.0. Two
new device types: `DRAGINO_SDI12` and `RAK10701_FIELD_TESTER`. The last
pre-built image was 0.6.5, so a gateway upgraded from that image also takes
every 0.7.0 entry below. Some entries fix behaviour that only builds from
`main` made between 0.7.0 and this release had; a gateway upgraded from 0.7.0
never saw those defects.

The `v0.8.0` tag was moved on 2026-10-08 to the commit that also carries
#471, #472 and #473; their entries are the last ones under Fixed and
Security below.

### Upgrade notes
- **Cloud before edge.** This edge emits sync events that an OSI Server
  without the matching appliers rejects terminally: `VALVE_SCHEDULE_UPSERTED`,
  `VALVE_SETTINGS_UPSERTED`, `VALVE_RUNTIME_CHANGED`,
  `VALVE_ACTUATION_ARCHIVED`, `ZONE_IRRIGATION_CALIBRATION_UPSERTED`,
  `WEATHER_STATION_ZONES_REPLACED`, `DEVICE_INSTALLATION_LOCATION_REVISED`,
  `DEVICE_RADIO_CONFIGURATION_REVISED`, `ZONE_AGRONOMY_UPSERTED`,
  `WATERMARK_CALIBRATION_UPSERTED` and `WATERMARK_CALIBRATION_DELETED`.
  Before upgrading a linked gateway, deploy an OSI Server revision whose
  `EdgeSyncService.java` passes `scripts/verify-sync-op-parity.js` (set
  `OSI_SERVER_EDGE_SYNC_SERVICE` to that file); osi-server `main` at
  `b6752126` passes. A rejected event stays rejected; recovery is the manual
  path under Fixed below. Gateways that are not linked to a cloud are not
  affected.
- **Gateways before the cloud for the 32-hex actor id.** The contract now
  lets `actor_user_uuid` take 32 hex digits (see Changed). Deploy gateways
  before the cloud that sends that form: a new edge with an old cloud is
  harmless, but an old edge refuses a command with a 32-hex actor as
  malformed. 0.7.0 has no command or resource that carries
  `actor_user_uuid`, so the order matters only for gateways on main builds
  made before this change.
- **Upgrade with `deploy.sh`, not by copying files.** The script now stages
  `flows.json` and the GUI as one payload, stops Node-RED (and
  `osi-identityd`) before migrating, applies pending migrations with
  `scripts/migrate-cli.js` after a backup, and activates the new payload
  before Node-RED starts again. Four migrations in the range are
  `destructive` (`0027` and `0060` rebuild the `devices` type list, `0058`
  recreates the gateway-attribution triggers, `0069` rebuilds the journal V2
  queue and replay tables and copies their rows) and need the writers-stopped
  state that only the deploy provides.
- **Journal catalog v11 and migrations 0069/0070: cloud first, then
  gateways.** The cloud compares the catalog version and hash a gateway
  advertises with the catalog it vendors, and disables cloud journal capture
  for a gateway whose catalog differs. Deploy an OSI Server revision that
  vendors catalog v11 (osi-server `main` at `b6752126` does), then upgrade
  the gateways soon after: until a gateway runs this release it still
  advertises catalog v10, and cloud capture for it reports a catalog mismatch
  (`gateway_catalog_mismatch`). The cloud accepts
  the journal V2 contract fingerprint of both releases, so replication keeps
  running in between. `0069` rebuilds two journal tables during the deploy
  (see the previous note); `0070` only adds catalog rows.
- **Cloud MQTT broker URL.** `node-red.init` and `flows.json` ship
  together: the new flows read the broker from `OSI_CLOUD_BROKER_URL`, which
  only the new init sets. `deploy.sh` and images install both; a flows.json
  copied by hand under an old init, with `osi-server.cloud.mqtt_broker_url`
  empty, leaves MQTT disconnected (`Connection failed to broker:
  device_<EUI>@mqtt://${OSI_CLOUD_BROKER_URL}:443` every 15 s). A gateway
  with `server_host` set to another host and no `mqtt_broker_url` switches
  its MQTT to `wss://<server_host>/mqtt` at the first start after the
  upgrade. `mqtt_broker_url` wins when set; it is the cloud's
  `MQTT_DEVICE_PUBLIC_BROKER_URL` at link time, so each cloud's environment
  must name its own host. A malformed `server_host` is logged as a WARN
  (shape only) and the default broker is used, as for an unlinked gateway.
  Before rolling out, compare per gateway (production first) the predicted
  URL with the host in its last `Connected to broker` log line.
- A gateway whose database has no `schema_migrations` ledger (installed from
  the 0.6.5 image and never upgraded since) takes the pre-ledger path on its
  first deploy: `repair-sync-outbox-v2.js`, then `baseline-existing-db.js`,
  then the migrations. For a gateway that is far behind, follow
  [docs/operations/ledger-catchup-runbook.md](docs/operations/ledger-catchup-runbook.md).
- The migration step now refuses to start, before stopping Node-RED, unless
  the backup directory has free space of twice the database size plus 128 MB
  (`MIGRATE_MIN_FREE_MARGIN_MB`). Pre-migration backups are pruned to the
  newest three (`MIGRATE_BACKUP_KEEP`).
- A gateway that once ran a customer line, and whose ledger numbers
  collide with main's, is reconciled automatically by
  `scripts/reconcile-ledger-numbering.js` during the deploy; the deploy
  aborts before the payload flip when a row cannot be proven equivalent.
- `deploy.sh` reports its own verdict and restarts Node-RED itself. A manual
  restart after a green deploy is not needed.
- On a flaky link, use the offline bundle path (`scripts/deploy-bundle.sh`,
  `scripts/deploy-push-bundle.sh`, `scripts/deploy-offline.sh`) described in
  [docs/operations/deploying-over-a-flaky-link.md](docs/operations/deploying-over-a-flaky-link.md).
- The Node-RED editor is closed (see Security). Field repair that needs it
  means editing `/srv/node-red/settings.js` on the gateway and restarting
  Node-RED; the next `deploy.sh` run overwrites that edit.
- `deploy.sh` writes `osi-server.cloud.firmware_version` from the deployed
  tree after the payload flip and before its own Node-RED restart, and puts
  the previous value back on every flip back. A gateway flashed from the
  0.6.5 image stops reporting 0.6.5 after its first deploy. A missing `uci`
  or `osi-server.cloud` section is logged as a `WARN` and does not fail the
  deploy.
- `deploy.sh` now refuses, before it stops Node-RED, when a migration file is
  missing or does not match its SHA-256 in `CHECKSUMS.json`, or when
  `CHECKSUMS.json` or a migration-runner module is missing, empty or does not
  parse, and it fails instead of reporting success when a
  command-ledger staging or activation step fails.
- After a failed command-ledger activation whose previous files also fail to
  load, Node-RED and `osi-identityd` stay stopped and
  `/srv/node-red/.osi-command-ledger-hold` records the reason and time. A
  reboot starts the previous payload. Re-run the deploy to clear it: every
  deploy reads the marker first and removes it once the ledger pair loads.
- A gateway on an earlier main build receives the updated
  `osi-command-ledger` and WATERMARK binding files through the deploy's
  SHA-256-pinned install.
- On an install onto stock ChirpStack Gateway OS, `deploy.sh` enables
  `osi-bootstrap`, which provisions ChirpStack at the next boot;
  `/etc/init.d/osi-bootstrap start` provisions at once. Do not run
  `chirpstack-bootstrap.js` directly: it writes no stamp, so the next boot
  runs it again and creates a second API key. The one exception is the
  Kiwi and Clover profile repair in the next note.
- **Kiwi and Clover profile repair runs during the deploy.** On a gateway
  that is already provisioned, `deploy.sh` runs
  `chirpstack-bootstrap.js --repair-soil-profiles`: it attaches the Tektelic
  codec to a Kiwi or Clover profile that has none, creates the
  `OSI CLOVER Sensor` profile with its UCI key and env line where Clover was
  unset or shared the field tester's profile, and changes nothing else. A
  codec already on a profile is left alone, and a second deploy writes
  nothing. A failed repair is logged as a `WARN` and does not fail the
  deploy. Rerun it by hand only after that `WARN`, and only as
  `node /srv/node-red/chirpstack-bootstrap.js --repair-soil-profiles`, never
  the copy under `/usr/share/node-red/` (an older image ignores the flag and
  runs a full provisioning pass).
- **Operator action for a Clover registered before the repair.** The deploy
  does not move an existing Clover device off the field tester's profile.
  Re-point each one with
  `node /srv/node-red/chirpstack-bootstrap.js --repair-soil-profiles --repoint-clover-device=<DevEUI>`
  (repeatable). When a hand-run repair created the Clover profile, Node-RED
  needs a restart to pick up the new profile id:
  `/usr/libexec/osi-identityd.sh request-restart chirpstack_bootstrap 60`.
  The full procedure is in `.claude/skills/osi-live-ops-runbook/SKILL.md`.
- **Check `recorded_at` before the upgrade.** History readers now select
  rows by the instant SQLite reads from `recorded_at`, so both stored shapes
  (ISO UTC with `Z`, and the `+00:00` offset that earlier builds wrote for
  WATERMARK, SDI-12 and UC512 rows) are included. A row whose `recorded_at`
  SQLite cannot read as a time falls out of every export and series. Count
  such rows on the gateway first:
  `sqlite3 /data/db/farming.db "SELECT COUNT(*) FROM device_data WHERE strftime('%s', recorded_at) IS NULL;"`.
  A non-zero count means those rows will be missing after the upgrade.
- **Raw export timestamps change shape.** The per-zone raw CSV export and
  the raw series print every timestamp as ISO UTC with milliseconds and `Z`
  (`2026-10-06T08:35:00.000Z`). Before, rows from WATERMARK, SDI-12 and
  UC512 nodes printed the `+00:00` form. A script that parses raw exports as
  text must accept the `Z` form. Stored rows are not rewritten, because a
  rewrite would queue one cloud correction per row.
- **WATERMARK readings stored without a value.** A gateway that ran a
  WATERMARK build from `main` before this release stored no tension value
  for readings flagged `unsettled` (see Added). `scripts/repair-watermark-unsettled.js`
  fills them. The deploy never runs it; stage it on the gateway with
  `lib/osi-migrate/runner-iface.js` in the same relative layout (the
  script header shows how). It runs as a dry run by default with the
  database opened read-only, and `--apply` fills only rows with no value
  whose only problem was the flag, in one transaction. It refuses while
  sync events for those rows are still unsent, because such an event would
  overwrite the corrected value in the cloud with an empty one.
- **Gateway clock and cloud valve commands.** The gateway now answers a
  cloud valve open `EXPIRED` once the command's expiry has passed by the
  gateway clock, so a gateway whose clock runs ahead refuses opens that are
  still valid. Stop commands are never refused. Check the gateway's time
  source after the upgrade if cloud opens come back `EXPIRED`.

### Known limitations
- Journal entries written by a user whose gateway-local id is 32 hex digits
  without hyphens (the first admin and backfilled users) are probably refused
  when they replicate, and cloud journal writes for such an account are
  refused: the journal's owner and author fields accept only the hyphenated
  form. Read from the code, not reproduced; tracked in #401.
- Device add, device assign, device delete and account link still keep
  per-request values in shared flow context, so overlapping requests of
  these kinds can exchange values (overlapping device adds can cross).
  Tracked in #377.
- A Clover on the repaired profile stores temperature, humidity and light,
  but not yet soil moisture or soil temperature. With the vendor codec, the
  MQTT telemetry message carries no Kiwi soil tension because the field
  names differ; the stored readings and the sync to the cloud are correct.
- The cloud receives WATERMARK tension values from unsettled readings but
  not the `unsettled` flag itself, which stays on the gateway.
- GUI strings added in this release ship in English in the Luganda locale
  until a native speaker translates them (eleven new ones from the Data
  view among them); `docs/i18n/pending-luganda-translations.md` lists them.

### Added
- **WATERMARK soil tension on the Dragino LSN50**
  (`0061__watermark_lsn50.sql`): FPort 11 profile 3 frames are validated
  (anything else on that port is rejected with a raw row), resistance is
  converted to temperature-compensated kPa, raw readings stay in the
  edge-local `watermark_readings` table and canonical kPa lands in
  `device_data`. Calibration routes (GET, PUT, DELETE), probe display,
  calibration and depth settings on the LSN50 card. The node needs custom
  LSN50 firmware that is not shipped in this repository. WATERMARK values are
  recorded and displayed only and do not drive automated irrigation: the
  scheduler skips every `device_data` row linked to `watermark_readings`.
  A reading whose only problem is the node's `unsettled` flag (two samples
  further apart than the firmware tolerance, common on a wet channel) is
  converted and stored like any other, appears in the card, history, charts
  and CSV export, and keeps the "Reading not settled" status. A reading with
  a real fault (invalid sample, open circuit, short, out of range, missing
  calibration or temperature) stores no value and shows its own status.
- **WATERMARK cloud parity** (`0068__watermark_cloud_parity.sql`): calibration
  rows sync as events and in bootstrap and force-sync snapshots. The edge
  accepts four protected cloud commands (`SET_WATERMARK_CALIBRATION`,
  `DELETE_WATERMARK_CALIBRATION`, `SET_CHAMELEON_CONFIG`,
  `UPSERT_DEVICE_SOIL_DEPTHS`) through `osi-command-ledger` with an exact-base
  check, command-id and effect-key dedupe, and one transaction per command,
  behind the capabilities `watermark_v1`, `chameleon_config_commands_v1` and
  `device_soil_depth_commands_v1`.
- Water-status pill on current SWT readings (Wet under 20 kPa, Moist 20 to
  50 kPa, Dry above 50 up to 300 kPa) on the KIWI, SDI-12 and zone water
  cards and in the LSN50 Chameleon and WATERMARK sections; no status for
  missing, stale, faulted or out-of-range readings.
- **Scoped multi-user access** (`0044__scoped_access_schema.sql`,
  `0045__scoped_access_backfill.sql`): account-wide reads, grant-gated writes,
  admin screens for users and grants. Off by default
  (`osi-server.cloud.scoped_access_enabled=0`); with it off, auth routes do
  not load the scope helper.
- **All-zones history export and saved-view delete.**
  `GET /api/history/export.csv?scope=allZones` returns one CSV over every
  zone the caller may read: their own zones, or every zone with scoped access
  on. Units and columns are the same as the per-zone export. The export is
  bounded to 200,000 rows and to the per-granularity ranges, and only one
  runs at a time (otherwise 413 or 429 with a suggestion).
  `DELETE /api/analysis/views/:id` deletes one of the caller's saved views.
  The analysis page gets an "Export all zones CSV" action with a busy state
  and error messages, and a confirmed delete for saved views. Daily CSV
  exports, the per-zone one included, are now limited to 3,660 days, and CSV
  text cells that start with a tab or a carriage return are neutralised like
  formula prefixes. Hourly and daily CSV exports (both routes) aggregate one
  local month at a time, so a long range no longer holds every raw reading
  in memory at once.
- **Every device card value opens its history.** WATERMARK probe rows
  (unsettled readings included) and soil temperature, every SDI-12 value
  per depth (VWC, VIC, soil temperature, EC, tension), the LoRain
  temperature, today and rate values, and the STREGA Gen1 enclosure reading
  open the same history view as the older cards, with the same cue (dotted
  underline, hover colour, focus ring). A card offers only keys the
  gateway's history API serves, so a click never opens an empty chart.
- Durable history batches (`0051__durable_history_batch.sql`), installation
  identity with a v2 offline verifier keyed on the installation UUID
  (`0052`, `0053`), and per-device installation-location and
  radio-configuration revisions synced as protected events (`0054` to
  `0056`).
- **Dragino SDI-12 soil node** (`DRAGINO_SDI12`, migrations
  `0026__sdi12_columns.sql` to `0030__sdi12_recipe_deployments.sql`): codec
  and ChirpStack profile, `aI!` auto-identify over FPort 100, a probe-profile
  registry that includes Sentek EnviroSCAN and TriSCAN (scaled frequency to
  VWC), multi-segment uplink reassembly with a durable quarantine, per-depth
  VWC, VIC, soil temperature and EC channels, a commissioning state machine
  and Sentek acquisition-recipe deployment. Cloud `SET_SDI12_IDENTIFY`
  commands dispatch to the identify path.
- **RAK10701 field tester** (`RAK10701_FIELD_TESTER`,
  `0060__add_rak10701_field_tester_type.sql`): its own ChirpStack
  application; the gateway answers the tester's fPort 1 frame with the
  six-byte coverage reply, and the Network page shows the measured track with
  GeoJSON and CSV export. Reply and capture run only with radio capture
  switched on (`osi-server.cloud.radio_capture_enabled=1`), which is off by
  default.
- **Journal catalog v11 and plot-group snapshots**
  (`0069__journal_v2_plot_group_snapshot.sql`,
  `0070__journal_catalog_v11.sql`). Catalog v11 adds `full_record@11` with a
  final-entry requirement matrix (which fields a final entry needs per
  activity or operation, and which quantity families may be recorded as not
  observed), plot layouts that declare their machinery availability, and a
  `farm_wide` layout. 0069 widens the closed operation and kind lists of the
  journal V2 queue and replay tables with `PLOT_GROUP_SNAPSHOT` and adds
  `journal_v2_plot_group_snapshots`; the replication worker validates and
  stores plot-group snapshots. The sync contract defines the
  `UPSERT_JOURNAL_ENTRY_BATCH` command and the `JOURNAL_CROP_CYCLE_UPSERTED`
  event.
- **Journal entry batches and crop-cycle projection.** A cloud-issued
  `UPSERT_JOURNAL_ENTRY_BATCH` is applied in one transaction: all member
  entries, the command ledger row and one ACK listing every member's
  version and payload hash, or nothing. Every crop-cycle change (seeding,
  harvest, reseed, manual close, correction, void) is sent to the cloud as
  `JOURNAL_CROP_CYCLE_UPSERTED`, except on a cloud-primary gateway. The
  replication worker advertises the `journal_entry_batch_v1` release once
  the cloud accepts the gateway's journal contract.
- **Journal capture.** Final entries on catalog v11 Full templates are
  checked against the catalog's final-requirement matrix; a required
  quantity the matrix allows may be recorded as not observed. A Farm-wide
  choice records maintenance and observations on the `farm_wide` layout
  without plot, zone or other field context. Entry lists and exports narrow
  to a station or a plot group. Capture closes with Escape, the activity
  grid is one tab stop moved with the arrow keys, and the detail preference
  falls back to the least detailed template a layout supports.
- **Field Journal** (`0018__field_journal.sql` to
  `0021__journal_plot_lookup_indexes.sql`, `0031__journal_catalog_v2.sql` to
  `0043__journal_v2_media.sql`): typed field activities against plots and
  zones, catalog v10, plot context and crop cycles, capture and desktop GUI,
  exports, and cloud-primary replication over its own channel
  (`osi-journal-replication`) with media caching under
  `osi-server.cloud.journal_media_root`. On by default; replication needs a
  linked OSI Server that offers Journal V2 and accepts this gateway's journal
  schema.
- **STREGA valve control** (`0022__valve_control.sql` to
  `0025__valve_settings_sync_triggers.sql`): a valve panel across zones;
  weekly schedules compiled into the valve's own scheduler (Gen1 FPort 14 to
  20, Gen2 FPort 25 day mask, up to four windows per weekday) and pushed only
  on a user change or an explicit re-send; one-time opens from a 60 s tick,
  skipped once more than 10 minutes overdue; the gateway keeps the valve clock
  in sync every 10 minutes, including DST changes; push acknowledgements in
  `valve_schedule_pushes`; a gateway time zone in `app_settings`; enclosure
  temperature and humidity telemetry. The threshold scheduler is now labelled
  "Trigger-based irrigation"; its behaviour is unchanged.
- **Valve sync contract**: resources `VALVE_SCHEDULE`, `VALVE_SETTINGS`,
  `VALVE_RUNTIME` and `VALVE_ACTUATION`, and cloud commands
  `UPSERT_VALVE_SCHEDULE`, `DELETE_VALVE_SCHEDULE`, `UPSERT_VALVE_SETTINGS`,
  `SET_VALVE_SCHEDULER_STATUS`, `RESEND_VALVE_PLAN` and
  `CANCEL_VALVE_ACTUATION` (which fails closed when ChirpStack is
  unavailable).
- **Provider weather and daily agronomy** (`0062__weather_provider_store.sql`
  to `0067__zone_daily_agronomy_sync.sql`): hourly weather per farm location,
  which the gateway fetches over the internet every 30 minutes from
  Open-Meteo or MeteoSwiss (a SwissMetNet station within 15 km)
  (`osi-server.cloud.weather_provider_default`,
  default `open_meteo`, overridable per zone with `weather_source`), a FAO-56
  catalogue of 136 crops, daily ET0 and crop demand per zone in
  `zone_daily_agronomy`, a Water tab with seven days of demand, and provider,
  station and agronomy series in the Data view. A SenseCAP S2120 assigned to a
  zone supplies hourly station inputs.
- **Versioned zone sync** (`0046__zone_insert_outbox.sql` to
  `0050__weather_station_zone_backfill.sql`): a zone insert emits
  `ZONE_UPSERTED`; versioned `UPSERT_ZONE`, `DELETE_ZONE` and
  `UPSERT_ZONE_LOCATION` commands; irrigation calibration and weather-station
  zone assignments carry a `sync_version` and sync.
- **Zone and device rename**: `PUT /api/irrigation-zones/:id/name` and
  `PUT /api/devices/:deveui/name`, cloud commands `UPSERT_ZONE_NAME` and
  `UPSERT_DEVICE_NAME` behind `entity_name_commands_v1`, one name rule in
  `osi-entity-name` for every write path, the ChirpStack device name updated
  best effort, and an inline name editor on eight cards.
- Terra zone-selection commands apply atomically and acknowledge with the
  full correlation envelope the cloud expects.
- Repairable sync rejections (`0059__sync_rejection_recovery.sql`): rejected
  outbox rows keep a fixed code and class; an audited exact-UUID route
  (`POST /api/sync/outbox/recover`, admin) and a dry-run-by-default CLI
  re-queue a row once, given a complete cloud replay receipt. Force Sync
  reports applied, duplicate, retryable, rejected, protocol-error and pending
  counts.
- Per-event exponential backoff for retryable outbox failures (60 s after the
  first failure, doubling to a 1 h cap) instead of a resend every cycle.
- Live gateway identity convergence: `osi-identityd` reconciles provisional
  boot identity to concentratord's authoritative EUI, persists it through the
  shared helper, warns operators for 60 seconds, and restarts Node-RED once so
  `DEVICE_EUI`, MQTT credentials/client ID, sync triggers, link requests, and
  sync requests switch together.
- Global GUI restart banner: `/api/system/stats` now exposes a filtered
  `restartPending` object and the React GUI shows a localized countdown or
  in-progress message before the daemon restarts Node-RED.
- Settings → Modules: Data view, Network, Gateway hub and Field Journal can
  be switched off per gateway (`app_settings`), with defaults from
  `osi-module-defaults`. The Network module is shown only when a RAK10701
  field tester is registered, unless switched on.
- The cloud MQTT broker URL is configurable with
  `osi-server.cloud.mqtt_broker_url`; without it, the gateway uses
  `wss://<osi-server.cloud.server_host>/mqtt` (see Fixed).
- Persistent system log: `node-red.init` points syslog at
  `/data/log/osi-system.log` (two files of 2 MiB), so boot-node failures
  survive a power cycle.
- **Ledger cutover rehearsal** (`scripts/rehearse-ledger-cutover.js`): runs
  the schema cutover of a gateway on an earlier lineage's ledger numbering
  against a copy of its database (reconcile, migrate, verify head,
  devices-rebuild and boot-node rehearsals, integrity, schema against the
  seed, per-table row counts and content hashes, and a second pass that must
  change nothing) and writes a JSON report with each step's result and
  duration. Workstation tool; nothing on the gateway changes.
- Operator tools: `scripts/reconcile-ledger-numbering.js`,
  `scripts/restamp-fingerprints.js --report`,
  `scripts/requeue-rejected-outbox.js` (dry run by default), the
  `osi-sync-protocol-state` CLI, the offline deploy bundle scripts,
  `scripts/repair-watermark-unsettled.js` (dry run by default),
  `scripts/rehearse-history-queue-drain.js` (runs the history correction
  drain against a copy of a database), and the
  `--repair-soil-profiles` and `--repoint-clover-device=<DevEUI>` modes of
  `chirpstack-bootstrap.js`.
- CI and developer tooling: workflows for doc hygiene, Field Journal, journal
  catalog parity, ui-core vendor parity and the test inventory
  (`scripts/verify-test-inventory.js` fails on a test file no workflow can
  fail on); test steps fail on an empty collection; the GUI installs with
  `npm ci` on Node 22 and gives each tsx test file 120 s; a request-state
  guard (`verify-request-context-isolation.js`) and a scoped-access gate that
  probes every HTTP route; the calibration seed script writes all seven seed
  images or none; new verifiers including
  `verify-seed-db-ledger.js`, `verify-trigger-body-parity.js`,
  `verify-rename-swap-fence.js`, `verify-flows-output-arity.js`,
  `verify-module-file-deploy-coverage.js`, `verify-auth-flag-off-hermetic.js`,
  `verify-init-log-capture.js`, `verify-live-gateway-identity.js`,
  `verify-sdi12-codec.js`, `verify-lsn50-watermark-codec.js` and
  `verify-doc-hygiene.js` with a pre-push guard; sync triggers generated
  from one canonical source (`scripts/generate-sync-trigger-source.js`);
  vendored ui-core GUI primitives; an offline WATERMARK dry-down analyzer; a
  presentation simulator (`npm run demo:build`) built separately from the
  gateway GUI.

### Changed
- An assigned LSN50 counts as a soil source when it is a Chameleon node, a
  WATERMARK node, or has none of the dendrometer, temperature, rain-gauge and
  flow-meter modes; a plain LSN50's third SWT channel is no longer shown.
- **Command ledger safety.** A cloud command that can move a valve is
  answered `EXPIRED` and not sent to the valve once its expiry has passed;
  `CLOSE` and `CANCEL_VALVE_ACTUATION` are exempt and always run, so a stop
  is never refused because of the gateway clock. A command without an
  expiry (from an older cloud) runs as before. Each command is acknowledged
  to the cloud once: queued answers that disagree about one command are
  held back and dead-lettered after 20 attempts instead of blocking the
  queue. When the cloud answers one command twice, the gateway keeps it
  pending (`AMBIGUOUS_RESULT`) and never sends the valve command again.
- The heartbeat carries `sync_rejected_recent`, the count of rejections in
  the last 24 h, and `health_state` uses it instead of the all-time count.
  Health and heartbeat also report `sync_dirty_rejected` (history rows the
  cloud refused and the gateway set aside) and `command_ack_dead_lettered`
  (command acknowledgements given up after 20 attempts).
- Sync contract: `actor_user_uuid` in `commands.schema.json` and the actor on
  both revision resources in `resources.schema.json`
  (`DeviceInstallationLocationRevision`, `DeviceRadioConfigurationRevision`)
  accept 32 lower-case hex digits as well as the hyphenated UUID, matched
  exactly and never converted; `watermark-cloud-parity-v1.json` gains the
  `gateway-local-hex-actor` binding vector and a list of rejected actor forms.
- The cloud sync token is refreshed once less than half its lifetime remains,
  instead of only in its last 24 h.
- Rejected outbox rows are pruned after 14 days.
- A local zone create or delete, or an applied cloud zone command, flushes the
  outbox at once instead of waiting for the 30 s tick; only one flush runs at a
  time.
- Every ChirpStack gRPC call carries a deadline: 20 s by default,
  `OSI_CHIRPSTACK_GRPC_DEADLINE_MS` to override.
- Cloud command registration also maps `MILESIGHT_UC512`.
- Journal API and capture with scoped access off: a `plot_uuid` filter on a
  plot the caller does not own, or that does not exist, answers 404
  `scope_not_found` instead of an empty list; `station_code` and
  `group_uuid` now narrow entry lists and exports; the catalog response
  carries `capture_permissions`; with no plot chosen, the capture layout
  selector offers only the farm-wide layout.
- A non-admin farm owner loses the farm-wide right when another account
  links the gateway later: the farm owner is always the latest linked
  account, the one sync uses.
- GUI: a language switcher in the dashboard header; dialogs keep keyboard
  focus inside and close on Escape; sensor chart axes and tooltips use the
  app date format; a newly created zone scrolls into view with focus; valve
  panel strings translated into Spanish, Italian and Portuguese.
- `deploy.sh` enables `osi-bootstrap` where it installs it (also an
  operator-disabled one; when the gateway is already provisioned it writes
  the stamp so the bootstrap does not run again), and writes the deployed
  firmware version.
- `deploy.sh`: flows and GUI deploy and roll back as one pair; readiness is
  checked through the named procd service within a 30 s window; Node-RED stays
  stopped when a migration committed and no compatible payload exists; a fresh
  install seeds a database already stamped at the migration head; the firmware
  `sqlite3` module survives `npm install` on armv7l and musl; the command
  ledger and the WATERMARK binding install from SHA-256-pinned copies after
  the migration.
- The migration runner skips an `ADD COLUMN` whose column already exists with
  a matching definition, and its fingerprints ignore the gateway EUI literal
  in trigger fallbacks (normalizer v3).
- `osi-bootstrap`, account link, and account unlink publish restart requests
  for `osi-identityd` instead of starting their own Node-RED restart paths.
- `firmware_version` UCI default bumped `0.7.0` → `0.8.0`; the GUI login
  screen, `README.md`, the `node-red.init` and `flows.json` fallbacks and
  `scripts/verify-sync-flow.js` updated to match.

### Fixed
- **pF never below 0.** Soil water tension is stored and synced in kPa, and
  pF is derived for display. A reading between 0 and 0.1 kPa used to show a
  negative pF in the GUI and the zone CSV export (-0.301 for 0.05 kPa). It
  now shows `0.00 pF` and exports 0; a missing reading still shows no value,
  and kPa values, stored data and sync payloads are unchanged.
- Scoped access: the owner of a soil sensor that is in no zone, or an
  enabled admin of the gateway, can set its depths and WATERMARK calibration.
  Before, no rule covered a sensor without a zone and both were refused.
  Researchers, viewers and disabled admins are still refused.
- History time ranges: rows stored with a `+00:00` offset could be ordered
  wrongly at a range bound, because readers compared the timestamp text.
  Exports, aggregates, rollups, raw, dendrometer, rain and data-view series
  now compare the actual time, and the device writer for WATERMARK, SDI-12
  and UC512 stores ISO UTC with `Z` like the other writers.
- **Data view finds every device the caller may read.** Discovery
  enumerated only devices with a history card, so LoRain rain gauges and
  unassigned devices were missing. It now lists every authorized device:
  with scoped access off, the caller's zones, their devices and the
  caller's unassigned devices; with it on, the account's zones and claimed
  unassigned devices. A disabled account gets 403. Saved selectors keep
  working. Card history for rain and flow interval channels reads raw rows
  at every range, so the total shown equals the stored total (a 7-day
  LoRain history showed a third of the stored rain before).
- **History corrections to the cloud keep flowing.** The queue that sends
  corrected history rows stopped for a whole table when one key could never
  complete. A key whose row no longer exists is now dropped and logged (a
  read error or a locked database never drops one), and a row the cloud
  rejects is set aside as `rejected` with its reason while the rest of the
  table continues; the next change to that row queues it again. Keys queued
  under an earlier gateway identifier complete, radio rows included.
- Valves: the card shows the state the valve reported, not the commanded
  target; deleting a valve clears its on-valve plan; cloud schedule commands
  are keyed by schedule UUID and valve; a soft-deleted schedule revives on a
  matching upsert; a one-time open keeps its dispatch intent across a restart
  and is never sent twice (`0057__valve_once_dispatch_intents.sql`); archived
  actuation events have stable IDs; push state breaks timestamp ties by row
  id; a cloud STREGA command runs the expectation writer once.
- Valve schedules after a backward step of the gateway clock: reverting a
  weekday to an earlier plan pushed nothing, so the valve kept the later
  plan, and the push state could show acknowledged for a slot whose current
  push was still queued. The schedule push ledger is now read in the order
  rows were written, not by timestamp.
- Overlapping requests on the manual valve route
  (`POST /api/valve/:deveui`), the zone schedule route
  (`PUT /api/irrigation-zones/:id/schedule`) and zone delete could exchange
  target, duration and response, or leave a deleted zone's schedule enabled:
  request values now travel on the message. A manual or scheduled valve open
  no longer acknowledges the last unrelated cloud command as applied.
- Protected cloud commands (WATERMARK calibration, Chameleon configuration,
  soil depths), rename commands, the Terra owner check and local
  installation-location and radio edits accept the 32-hex form of a
  gateway-local user id, which a gateway gives its first admin and backfilled
  users; before, such a user's commands were refused and its local edits
  failed with a 400.
- **Kiwi and Clover device profiles.** Provisioning created the Kiwi profile
  without a payload codec and put Clover on the field tester's profile,
  which has none. Node-RED drops an uplink that ChirpStack did not decode, so
  a Kiwi reported only where someone had attached a codec by hand, and a
  Clover never reported. New installs create both profiles with the Tektelic
  codec (shipped unmodified from the vendor repository the ChirpStack feed
  pins), Clover with its own `OSI CLOVER Sensor` profile. `deploy.sh`
  repairs gateways that are already provisioned (see Upgrade notes).
- UC512 and SDI-12 uplinks wrote no `device_data` row because the writer
  called `db.prepare` on a database facade that has none.
- SenseCAP S2120 wind gust read the wrong measurement; STREGA Gen2 battery
  percent was derived from a raw voltage. Missing STREGA climate and battery
  values stay null instead of becoming 0.
- A republished ChirpStack uplink no longer creates a second `device_data`
  row (bounded in-memory dedup on `deduplicationId`).
- A ChirpStack 4.12 unset key read back as 32 zeros is treated as unset.
- Journal replication and the SDI-12 recipe poll stay quiet on gateways and
  clouds without those capabilities.
- Deploy: Node-RED is never restarted on the old payload after a migration
  has run, which had let the previous boot node rebuild `devices` against the
  migrated schema and cascade-delete `device_data`. The boot node's `devices`
  rebuild now follows the seed's column order and copies by live column name.
- Deploy: a failed command-ledger activation, or a migration file that failed
  to download, no longer ends in "OK" and exit 0. Before, a missing 0068
  could flip the new flows onto the old schema. The header shows the
  download-then-run form, and the closing message names the bootstrap path
  that exists on the gateway.
- Deploy: a no-op migration no longer marks the database as migrated; after
  a later failure the deploy restores the retained flows and GUI pair when the
  schema is still compatible with it; the ledger reconciliation probe
  compares every applied row, not only the lowest.
- MQTT (heartbeat, telemetry, status, schedule and command ACKs) goes to the
  cloud the gateway is linked to. The "OSI Cloud Broker" node had the default
  cloud's URL as a literal, so a gateway linked to another cloud without
  `osi-server.cloud.mqtt_broker_url` set published to the default cloud,
  which refused its credentials, while HTTPS sync worked. The node now reads
  `${OSI_CLOUD_BROKER_URL}`; `node-red.init` sets it from
  `osi-server.cloud.mqtt_broker_url`, else `wss://<server_host>/mqtt`, else
  the previous default `wss://server.opensmartirrigation.org/mqtt`, and logs
  `cloud MQTT broker <url> source=<key>`. Unlinked gateways and gateways
  linked to the default cloud connect exactly as before.
- Sync: rejected events no longer count as delivery successes, and the
  account-link page shows rejected events and the re-authentication path when
  the token has expired; the outbox marker treats a missing result or status
  0 as retryable; command ACKs are marked delivered per entry; a local command
  id no longer poisons the ACK queue; schedule and device-zone commands are
  acknowledged only after the database shows the change; replayed
  work-request status commands return the original ACK; a valve actuation's
  `cancel_reason` and `command_result_detail` are capped at 255 characters
  before the cloud rejects them;
  `valve_schedules.deleted_at` ships as UTC ISO; zone time zone and location
  edits bump `sync_version`.
- The migration-owned copies of the zone-daily outbox triggers key a zone
  without a UUID as `zone-id:<id>` instead of an empty string that collided
  across zones, as the boot-time triggers already did
  (`0017__zone_key_fallback_parity.sql`); bootstrap and force sync send
  `sync_version` for dendrometer daily, zone recommendation and zone
  environment rows; the dendrometer node's fallback table DDL includes
  `sync_version`, which had crashed the first rewrite on an older database.
- Gateway attribution triggers fall back to the persisted link identifier,
  and linking commits account state and blank gateway identifiers in one
  transaction (`0058__gateway_eui_fallback.sql`).
- Account link works against a cloud that predates installation identity.
- API: assigning an unknown DevEUI to a zone answered nothing (the client
  hung); deleting an unknown device answers 404; zone time zones are
  validated.
- GUI: the zone ✕ unassigns a device instead of unlinking it from the
  account; the water card shows no invented numbers for a zone without data
  and no English prose from the cloud bundle; the Network nav label is
  translated; water-chart bars carry the right day west of UTC; the system
  card, grants page, dendrometer calibration, schedule titles, LSN50 mode
  captions, account-link sync screens and valve clocks are localized; zone
  card links follow the module switches; analysis charts load lazily and show
  only the soil channels a device has.
- Fresh flashes with concentratord enabled no longer stay stuck on a
  MAC-derived provisional gateway identity until an operator restarts Node-RED.
  Link and sync builders fail closed while an identity transition is healing or
  waiting for the warned restart.
- **History upload position no longer jumps.** A linked gateway uploads its
  history to the cloud in order and remembers how far the cloud has
  confirmed. The confirmation of a repair or correction batch also moved
  that position. A repair of an old reading moved it back, so the gateway
  sent every newer reading again (the cloud recognised them as duplicates).
  A correction of a newer reading moved it forward, so readings in between
  were skipped, and only the periodic history comparison could bring them
  back. Now only the ordered upload moves the position, and only forward. A
  position that an earlier build already moved past unsent readings is not
  moved back; those readings still arrive through the history comparison.
  Refs #432.
- **SDI-12 recipe poll: no "client close failed" warning every minute.** The
  60-second recipe poll and the recipe apply and rollback routes closed their
  ChirpStack client in a `finally` block, but the client in
  `osi-chirpstack-helper` had no `close()`. On every gateway with a
  `DRAGINO_SDI12` device the poll logged `SDI12 recipe poll client close
  failed` once a minute and left the client's five gRPC channels open. The
  client now has `close()`, which shuts down all five channels and returns any
  close error instead of throwing. Polling behaves as before. (Recipe apply
  and rollback still fail on real gateways for a separate reason, #469.)

### Removed
- The legacy boot-DDL nodes that altered `users` on every start; their
  columns are in the seed and `0001__baseline.sql`.

### Security
- The Node-RED editor and admin API are closed by default
  (`httpAdminRoot: false`); `/gui` and the product routes are unchanged.
- `GET /api/system/stats` and `GET /download-fieldtest` require a bearer
  token; in 0.7.0 both answered without one.
- `PUT /api/irrigation-zones/:zone_id/timezone` changes only a zone the
  caller owns; in 0.7.0 any signed-in user could change any zone.
- **Scoped access** (applies only with
  `osi-server.cloud.scoped_access_enabled=1`; with it off nothing changes):
  - Account link and unlink (`POST` and `DELETE /api/account-link`), Force
    Sync (`POST /api/sync/force`), the manual rollup run
    (`POST /api/history/rollups/run`), reboot, fan control and gateway
    settings need an enabled admin; before, any signed-in member could call
    them. The GUI disables the reboot, fan and time-zone controls for
    non-admins with an "Admin only" hint. The cloud force-sync command and
    the rollup timer work as before.
  - Improvement requests and the journal catalog refuse a disabled account
    before reading or writing anything.
  - A farm-wide journal entry (no plot, no zone) is created, finalized,
    changed or voided only by the farm owner (the account the gateway is
    linked to the cloud with) or an enabled admin, from the gateway GUI and
    from cloud commands alike. Others get 403 (404 for an existing entry;
    `scope_denied` for a cloud command), and the capture screen no longer
    offers them the Farm-wide choice. Farm-wide finals that another account
    wrote earlier become read-only for that account; its own farm-wide
    drafts stay editable. An entry that belongs to a zone but to no plot
    also needs the grant on that zone. Another user's entry answers like a
    missing one.
  - Only the owner of a journal plot group's plots may create or change the
    group. A grant on another user's plot no longer lets the grantee create
    or rewrite that user's group (#418).
  - Replacing a weather station's zones changes only assignments to zones
    the caller owns or holds a grant on. A zone outside the caller's scope
    that is already assigned stays as it is; naming a new one is refused.
- GUI: cached data and in-flight writes belong to one login session. After a
  logout and login as another user in the same tab, the second user no
  longer sees data cached for the first, and the first user's chained writes
  stop. The support request status secret is no longer stored in the
  browser.
- **The raw sensor export, the valve litres read and the reference-tree switch
  need a signed-in session with scoped access off.** With `OSI_SCOPED_ACCESS`
  off, `GET /download-sensordata` (every `device_data` row as CSV) and
  `GET /api/v1/devices/:deveui/today-liters` answered without any token, and
  `PUT /api/devices/:deveui/reference-tree` accepted any `Authorization`
  header that started with `Bearer `. Node-RED listens on port 1880 on every
  interface, so anyone who could reach the gateway could download its data
  without logging in. All three now check the session token the way the
  history and export routes beside them do, in both flag states, and answer
  401 without one. This is a deliberate change for gateways with the flag off:
  a script or bookmark that fetched `/download-sensordata` without logging in
  now gets 401 and has to send `Authorization: Bearer <token>` from
  `POST /auth/login`. The dashboard already sends the session on both routes
  it calls (litres and reference tree) and does not call the sensor export.
  With the flag on, the answer without a session is unchanged (401); a
  signed-in session on the export and litres routes now works on gateways that
  keep the token secret in `/data/db/osi_auth_token_secret` (the usual case),
  where it used to get 500. The other routes were checked the same way: with
  the flag off, only the login and registration routes, the CORS preflights,
  `GET /api/catalog` (the static device-type list) and
  `GET /api/system/features` answer without a session. **This narrows the
  exposure; it does not close it.** With the flag off, `POST /auth/register`
  still creates an account for anyone who can reach the gateway, and that
  account's session reaches all three routes. Closing that needs scoped access
  on, or registration closed once the first account exists (follow-up).

---

## [0.7.0] — 2026-07-13

### Added
- **Daily-analytics sync versioning** (migration `0015__upsert_sync_versioning.sql`): `dendrometer_daily`, `zone_daily_recommendations`, and `zone_daily_environment` gain a `sync_version` column; their outbox triggers now pass `NEW.sync_version` instead of a literal `0`.
- **Device chameleon sync** (migration `0016__device_chameleon_sync.sql`): `chameleon_enabled` and the three `chameleon_swt{1,2,3}_depth_cm` columns join `trg_sync_devices_outbox_au`'s change-detection and payload, so a Chameleon-enabled LSN50 no longer appears as a plain LSN50 in the cloud.
- `verify-flows-fn-parse` CI gate: parse-checks every function node's source across all three flow profiles and fails on a syntax error a compiled Node-RED node would otherwise swallow silently.
- `verify-boot-ddl-interpolation.js` CI gate: executes `sync-init-fn`'s boot-DDL statement array against a scratch DB and fails on a broken string interpolation or a sync-versioning regression in any trigger.
- GUI favicon (`/gui/favicon.png`, derived from the existing OSI logo asset) — browsers no longer log a 404 on `/favicon.ico`.

### Changed
- `firmware_version` UCI default bumped `0.6.5` → `0.7.0`; the GUI login screen, `README.md`, and `docs/versioning-workflow.md` version strings updated to match.
- Pipeline verification checks (`routes.py`, `errors.py`, `schema.py`, `gui.py`, `canary.py`) hardened against silent false passes: probed routes now match the shipped route table, error/staleness counts come from real on-disk signals instead of a nonexistent table, and a missing Playwright or admin token now fails the gate instead of skipping it quietly.
- `sqlite3-cli` enabled in every full-image `.config` profile (`deploy.sh` previously depended on internet access to self-heal it via `opkg`).
- `commands.schema.json`'s `command_type` enum gained `UC512_OPEN_FOR_DURATION`, matching the duration-bound actuator entry already present in the flow's command-type registry, with the same `duration_seconds` payload constraint as `OPEN_FOR_DURATION`.

### Fixed
- Daily-analytics writers (`dendro-compute-fn`, `sim-dendro-fn-setup`, and the LSN50/S2120/LoRain zone-aggregation nodes) now bump `sync_version` on every rewrite, so a recompute no longer collides with the cloud's per-resource watermark (`equal_version_payload_conflict`).
- Boot-DDL string-interpolation bug in `sync-init-fn`: two trigger DDL strings shipped the literal text `+ gatewaySql +` instead of interpolating the gateway EUI.
- `dendro-raw-fn` (`GET /api/dendrometer/:deveui/readings`) hung indefinitely because a corrupted regex made Node-RED unable to compile the node.
- `device-api-http500` returned a hardcoded 500 on every failure, including unauthenticated requests, discarding the thrown 401 from `verifyBearer`.
- Chameleon enable-toggle endpoint (`put-chameleon-enabled-auth-fn`) now bumps `devices.sync_version`, so a toggle after the first delivered `DEVICE` event reaches the cloud instead of being rejected.
- Reference-tree toggle endpoint (`dendro-ref-tree-fn`) now bumps `devices.sync_version`, the same defect class as the chameleon fix above.

---

## [0.6.5] — 2026-05-18

### Added
- **Auto-provision on first boot** (`osi-bootstrap` init script, START=99): ChirpStack apps, device profiles, MQTT credentials, and UCI identity fields are written automatically without manual intervention.
- **IPv4-forced cloud REST** (`osi-cloud-http` module): all cloud sync HTTP calls explicitly bind to IPv4 (`family: 4`) to avoid DNS resolution falling back to unreachable IPv6 addresses in dual-stack environments.
- **Chameleon SWT integration** (TEKTELIC LSN50 dendrometer): per-device polynomial calibration coefficients (`chameleon_swt{1,2,3}_{depth_cm,a,b,c}`), `chameleon_readings` table, and calibration UI in the device settings panel.
- **Mosquitto ownership fix** in `deploy.sh`: `passwd`, `acl`, and `/var/lib/mosquitto/` are chowned to the mosquitto service user on every deploy, preventing broker startup failures after upgrades.
- `verify-db-schema-consistency.js` script to catch seed DB / live DB drift at development time.
- `scripts/session-closeout.sh` repo health check script.

### Changed
- Seed database (`seed-blank.sql` and bundled `farming.db`) is now built from a clean schema with all current tables — no demo data, no stale columns.
- `deploy.sh` preserves the live `/data/db/farming.db` unconditionally; seeding only happens when the file is absent on a fresh device.
- React GUI login screen version string updated to v0.6.5.

### Fixed
- `deploy.sh` now deploys the `osi-cloud-http` module directory (was missing, leaving a broken `node_modules` symlink).
- Duplicate `normalizeTriggerMetric` function in `ScheduleSection.tsx` removed (merge artifact from chameleon-swt integration).
- Post-merge schema sync: chameleon calibration columns added to all farming.db copies and `seed-blank.sql`.

---

## [0.6.0] — 2026-04-22

### Added
- Initial public release on Raspberry Pi 5 (`bcm2712`).
- ChirpStack LoRaWAN network server integration with KIWI, STREGA, LSN50, S2120, CLOVER device support.
- Node-RED backend: REST API, irrigation scheduler, dendrometer analytics, bidirectional sync.
- React farmer dashboard: login, device cards, schedule editor, dendrometer graph.
- SQLite local database with offline-first operation.
- Bidirectional cloud sync via REST polling (30 s outbox, 6 h bootstrap).
- HMAC-signed local auth tokens; bcrypt-hashed passwords; gateway-specific offline verifier for linked accounts.
- SenseCAP S2120 8-in-1 weather station support with multi-zone junction table.

---
