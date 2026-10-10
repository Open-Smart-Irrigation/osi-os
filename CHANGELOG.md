# Changelog

All notable changes to OSI OS are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Upgrade notes
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
- **Deploy keeps the newest three pre-migration backups, not three files.**
  The retention step of `deploy.sh` (and of every migrating run) counted the
  `-wal`, `-shm` and `-journal` files that SQLite leaves next to a backup
  that was once opened in place. Those side files took slots in the kept
  window, so real backups were deleted even when no migration ran. Retention
  now counts only backup files, removes a backup together with its side
  files, never touches the newest `MIGRATE_BACKUP_KEEP` backups, and logs
  every file it removes. Side files whose backup is already gone are left in
  place. Fixes #474.
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

### Security
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

## [0.8.0] — 2026-10-07

Ordered schema migrations `0017__zone_key_fallback_parity.sql` to
`0070__journal_catalog_v11.sql` (54 migrations) are new since 0.7.0. Two
new device types: `DRAGINO_SDI12` and `RAK10701_FIELD_TESTER`. The last
pre-built image was 0.6.5, so a gateway upgraded from that image also takes
every 0.7.0 entry below. Some entries fix behaviour that only builds from
`main` made between 0.7.0 and this release had; a gateway upgraded from 0.7.0
never saw those defects.

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
  [docs/operations/uganda-catchup-runbook.md](docs/operations/uganda-catchup-runbook.md).
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
