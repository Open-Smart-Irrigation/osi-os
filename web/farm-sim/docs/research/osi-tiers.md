# OSI tier ladder for the farming-sim game (derived from code)

Scope: the in-game ladder of OSI tools, built only from code that ships in
osi-os at the PR #658 head (`4682fb17b1`, branch `t3/farming-sim-osi-education`
worktree). Paths below are relative to the worktree root
`<repo>`.
Abbreviations: `EDGE` = `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red`,
`SIM` = `web/react-gui/demo`, `GUI` = `web/react-gui/src`.

No numeric parameter in this report comes from the web; every number is quoted
from repository code. Where the code cites FAO-56 (Allen et al. 1998), that is
the code's own reference and was not re-fetched.

## 0. Corrections to the brief (paths that do not exist)

- `EDGE/osi-daily-scheduler/decision.js` does not exist. The 06:00 legacy
  scheduler lives in `flows.json`: inject node "Schedule time" (inject) ("Schedule
  time", cron `00 06 * * *`), decision node "Decide + build actuator cmd" (function) ("Decide + build
  actuator cmd + build DB logs"), with the SWT SQL extracted to
  `EDGE/osi-scheduler-mean-query/index.js:17 buildSwtMeanQuery`. The browser port
  is `SIM/model/triggers.ts:171 evaluateAutomaticTriggers`.
- `osi-zone-env` has no `run-projection`. The water verdict is
  `EDGE/osi-zone-env/index.js:947 resolveWaterAction`, called from flow node
  `zone-env-fn` ("Get Zone Environment Summary"). "Projection" only appears in
  `docs/contracts/rainfall/zone-day-projection.md` and test scripts.
- `docs/development/dendro-provider-control.md` (cited by the AGENTS.md in the
  session context) is not in this checkout. The "dendrometer irrigation effect off
  by default" rule therefore rests on the AGENTS.md text alone here.

## 1. The ladder at a glance

Tiers are **not cumulative in code**. They are separate features with separate
inputs:

- The 06:00 trigger never reads the water verdict.
- The water verdict never needs a valve.
- Monitoring never needs weather.

The game can sell them as a ladder, but each one has its own prerequisites
(section 3).

| Tier | Name | Player installs | Real OSI code that computes it | In simulator today? |
|---|---|---|---|---|
| 0 | No OSI | nothing | none | n/a |
| 1 | Monitoring | soil tension probe (KIWI_SENSOR / TEKTELIC_CLOVER / DRAGINO_SDI12 / LSN50+Chameleon), rain gauge (AQUASCOPE_LORAIN, SENSECAP_S2120, LSN50 MOD9 rain), flow meter (LSN50 MOD9 flow) | `GUI/utils/swt.ts:38 classifySwtWaterStatus`; `GUI/utils/zoneSoil.ts summarizeZoneSoil`; `EDGE/osi-matric-potential` (kPa to pF); history calendar `EDGE/osi-history-helper classifySoilStatus`. Rain day totals in the simulator come from its own `SIM/model/histories.ts dailyRainHistory`, a simulator implementation, not edge code | Display logic yes, but readings are sine curves (`SIM/model/readings.ts:232 sampleValues`) |
| 2 | Decision support | Tier 1 rain + flow, plus zone set-up (crop, stage, area, efficiency, location); optionally a SENSECAP_S2120 weather station | `EDGE/osi-zone-env/index.js:947 resolveWaterAction`; `EDGE/osi-crop-kc/index.js:59 resolveKc`; `EDGE/osi-zone-env/index.js:550 sumRain`; past-day ET0 via `EDGE/osi-agronomy-daily/index.js:179 resolveDay` + `et0.js` | Partly. Verdict is ported (`SIM/model/water-action.ts`) without the `rain_unknown` branch; Kc is ported (`GUI/agronomy/cropKc.ts`); ET0 is a sine fixture (`SIM/model/environment.ts:43 weather`) |
| 3 | Remote control | STREGA_VALVE (Gen1/Gen2) | timed open: `EDGE/osi-valve-control` (ports in `SIM/model/irrigation.ts`); weekly/one-time plans: `EDGE/osi-valve-control/plan.js` (port `SIM/model/plans.ts`) | Yes (pinned port tests) |
| 4 | Automation | Tier 1 eligible SWT probe + STREGA in the same zone | flow "Decide + build actuator cmd" (function) + `buildSwtMeanQuery` (port `SIM/model/triggers.ts`) | Yes (pinned port tests C21-C26) |
| R | Research (unqualified) | dendrometer (LSN50 dendro), conditional irrigation policy | `EDGE/osi-irrigation-policy/evaluate.js`, `osi-dendro-analytics` | Conditional: refused with 503. Dendro: **fictional** stand-in, not real analytics |

## 2. Tier detail

### Tier 0: no OSI (farmer judgment)

- **Player buys:** nothing.
- **App shows:** nothing. The OSI app is not available.
- **OSI code:** none.
- **Inputs the game feeds:** none. The game's own soil-water model drives visual
  cues (wilting, soil colour, cracks).
- **Honesty boundary:** no OSI branding. Hints from NPCs or the game itself
  ("the leaves look limp") must never carry an OSI label, colour pill or kPa
  number.

### Tier 1: monitoring

**What the player installs.** Each in-game item maps to a catalog device type:

- **Soil tension probe.**
  - KIWI_SENSOR: `swt_1`, `swt_2`, plus air temperature, humidity and light.
  - TEKTELIC_CLOVER: same shape as KIWI.
  - DRAGINO_SDI12: multi-depth soil profile, SWT and/or VWC.
  - DRAGINO_LSN50 with Chameleon: `swt_1..3`, 0..300 kPa domain.
- **Rain gauge.** AQUASCOPE_LORAIN gives interval rain in 0.5 mm steps.
  SENSECAP_S2120 gives a cumulative counter turned into a delta. LSN50 MOD9 rain
  input sets `rain_gauge_enabled=1`.
- **Flow meter.** LSN50 MOD9 flow input sets `flow_meter_enabled=1` (the predicate
  is `GUI/utils/zoneSoil.ts zoneHasFlowMeter` and `EDGE/osi-zone-env/index.js:909
  buildSensorHealth`).
- MILESIGHT_UC512 is in the catalog, but main has no visible card. The simulator
  refuses its registration (PRODUCTION-HOOKS row `Uc512DeviceCard.tsx`), so leave
  it out of the game.

**What the real app shows.**

- Per-device cards: KIWI, SDI-12, Dragino, rain monitor, flow on the valve card.
- The zone "Soil now" tile with a value, a colour pill and a depth suffix.
- History charts and the month calendar.
- The pill comes from `classifySwtWaterStatus`
  (`GUI/utils/swt.ts:38-44`), drawn by `GUI/components/farming/shared/SwtStatusIndicator.tsx`.
  The dot fill (full, half, empty) is the non-colour cue.

**Soil status categories (exact).**

| Surface | Wet | Moist | Dry | Source |
|---|---|---|---|---|
| Device cards and zone tile pill | `< 20` kPa | `20..50` kPa (inclusive) | `> 50` kPa | `GUI/utils/swt.ts:41-42` |
| History month calendar (`wet_excess` / `optimal` / `dry_stress`) | `< 22` kPa | `22..50` | `> 50` | `EDGE/osi-history-helper/index.js:754-762` (defaults; thresholds overridable) |

Values outside 0..1,000,000 kPa are classed `null` (invalid). The two surfaces
**disagree between 20 and 22 kPa**. The game must not merge them into one band.
If it shows one colour, it must say which surface it imitates.

**Zone "Soil now" value** (`GUI/utils/zoneSoil.ts:408 summarizeZoneSoil`,
`:326 summarizeTension`, `:186 selectChannel`):

- Takes each device's `latest_data` snapshot. Values outside 0..1,000,000 kPa, or
  faulted Chameleon/WATERMARK channels, count as invalid.
- The chosen channel's value is the mean across the zone's devices.
- Channel choice:
  - `mean` when the trigger metric is SWT_AVG (all channels pooled);
  - the trigger's channel when it is available;
  - otherwise the **shallowest channel with a recorded depth**. Channels without
    a depth sort last; ties go to channel order. The code comment says the
    shallowest channel "leads the drying front".
- Freshness window is 3 h (`SENSOR_FRESHNESS_WINDOW_MS`). Fresh values win.
  Otherwise older values show "Last reading ...".
- Tension wins over VWC when a zone has both.
- Proximity text against the zone trigger
  (`GUI/components/farming/IrrigationZoneCard.tsx:366-371`):
  - `>= threshold` gives "At or past the trigger".
  - `>= 0.8 * threshold` gives "Approaching the trigger".
  - Otherwise "Below the trigger".

**Depth.** OSI has no fixed depths. A depth is a value the installer records
per channel: `chameleon_swtN_depth_cm` or `soil_moisture_probe_depths_json`
(`SIM/model/device-sources.ts:61 soilDepthCm`). Depth has one effect beyond the
label: with no trigger channel, the "Soil now" tile shows the shallowest channel.
A pooled mean shows no depth. The game decides the depths (for example `swt_1` =
20 cm, `swt_2` = 40 cm), stores them as installation fields, and lets OSI display
and select them. The 06:00 trigger ignores depth; it uses the configured channel.

**pF.** `pF = log10(|kPa|) + 1`, and kPa = 0 has no pF
(`EDGE/osi-matric-potential/index.js`; GUI copy `GUI/utils/matricPotential`). A
measured 0 kPa shows as `0.0 kPa` in pF mode (`GUI/utils/swt.ts formatMeasuredSwtValue`).

**Inputs the game must feed.**

- **SWT.** Canonical **positive kPa** per channel (`swt_1/2/3`; KIWI uses
  `swt_wm1/2` aliases). Use the device's native interval; the simulator default
  is 30 min.
- **Rain.** `rain_mm_delta` per uplink, in mm. LoRain is interval rain and must
  not be double-counted.
- **Flow.** `flow_liters_delta` per uplink, in L.
- The game's soil-water model (not OSI) produces these values. They are the
  game's ground truth, sampled through the "sensor".

**Outputs and how the game uses them.** The status pill, values and history are
display only. Nothing decides anything at this tier.

**Simulator status.** Display logic is the real edge React app. Readings come from
`ReadingLedger.sampleValues` sine curves (`SIM/model/readings.ts:232`). The soil
response to irrigation is a simulator invention
(`SIM/model/readings.ts:272 applySoilResponse`: capped at 18, scaled by
delivered L/100 x 0.85 x 1.5, onset 10 min after observed irrigation per
`SIM/controller-semantics.md`). **Needed:** an input seam so the game's soil model
replaces `deviceValues()`. Today `protocol.ts` has no host-to-app message for
readings or weather (only `active`, `speed`, `next-event`, `guide`,
`clear-guide`), and `ReadingSample.source` has no `game` tag.

**Honesty boundary.** Tier 1 shows measurements and fixed categories. It gives no
advice. "Dry" is a fixed 50 kPa band, not "irrigate now". The game must not turn
the pill into a recommendation.

### Tier 2: decision support (water balance and forecast)

**What the player installs.** Prerequisites for a non-null verdict:

1. Zone configuration: `crop_type`, `phenological_stage`, `stage_started_on`
   (optional), `area_m2`, `irrigation_efficiency_pct`, and latitude/longitude.
   Without area or efficiency the verdict is `insufficient_data / balance_unknown`
   ("Set zone area and irrigation efficiency").
2. A rain source for today: a gauge, or trusted elapsed provider rain via
   `providerRainToday`. Without it, `rain_unknown` applies (below).
3. A **flow meter** for irrigation credit (see "Limits").
4. A forecast/weather provider (in-game "weather service").
5. Optional: SENSECAP_S2120 as a local weather station, used for past-day ET0
   only.

**What the real app shows.** The Water card subtitle and the Environment card's
Water and Agronomic tabs (`GUI/components/farming/environment/WaterTab.tsx`,
`AgronomicTab.tsx`):

- action label: `irrigate_today` "Irrigate today", `delay_irrigation` "Delay
  irrigation", `monitor_today` "Monitor today";
- reason label: `supply_covers_demand`, `forecast_rain_covers_demand`,
  `demand_exceeds_supply`, `balance_neutral`, `balance_unknown`,
  `forecast_unknown`, `rain_unknown`, `demand_unknown` (`WaterTab.tsx:61-87`);
- the 7-day table: rain, irrigation litres and net mm, demand (ETc), ET0, Kc,
  stage;
- Agronomic tab extras: VPD, dew point, heat index and THI from local or online
  T/RH (`EDGE/osi-zone-env/index.js:677 buildAgronomic`).

**OSI code and the exact composition the edge ships** (flow node `zone-env-fn`):

```
waterNeededTodayMm = agronomic.current.etcMmDay
                   = round(ET0_today x resolveKc(crop, stage, stageStartedOn, today).kc, 2)
  ET0_today = the provider forecast's daily et0MmDay for today's date,
              only when the forecast is live or was fetched today (buildAgronomic)
rainTodayMm = R.resolveAdviceRain(gauge rows | providerRainToday) (null = unknown)
              (osi-rain resolveAdviceRain was not read: its rain-known rules are NOT assessed here)
measuredIrrigationNetMm = toEffectiveIrrigationMm(flow_liters_today, area_m2, efficiency_pct)
                        = round(L x eff/100 / area, 2)
balanceTodayMm = round(rainTodayMm + measuredIrrigationNetMm - waterNeededTodayMm, 2)  (null if any is null)
next24hRainMm = sumRain(forecast hours, now, 24h)  (Open-Meteo points end-stamped: (now, now+24h])
action = resolveWaterAction(today, dendroRow, balance, next24hRain, demand,
                            rainTodayKnown = rainTodayMm != null, measuredIrrigationNetMm)
```

`resolveWaterAction` decision order (`EDGE/osi-zone-env/index.js:947-1012`):

1. A dendrometer recommendation row exists: return it as is (`source: 'dendro'`).
2. Balance null, rain unknown, irrigation and demand known: under
   `RAIN_UNKNOWN_POLICY = 'warn'` (`:1002`), rerun on `irrigation - demand` (zero
   rain) and relabel the reason `rain_unknown`. If that still needs a missing
   forecast, return `insufficient_data / rain_unknown`.
3. Balance null and demand null: `demand_unknown`. Balance null otherwise:
   `balance_unknown`.
4. `balance >= 0` gives `delay_irrigation / supply_covers_demand`.
5. Forecast null gives `insufficient_data / forecast_unknown`.
6. `forecast >= shortfall` gives `delay_irrigation / forecast_rain_covers_demand`.
7. `balance <= -1` mm gives `irrigate_today / demand_exceeds_supply`.
8. Otherwise (-1 < balance < 0) `monitor_today / balance_neutral`.

**Kc** (`EDGE/osi-crop-kc/index.js:59`; byte-identical GUI copy
`GUI/agronomy/crop-kc.json`, confirmed with `cmp`):

- Unknown crop gives `heuristic_phenology`: initial 0.45, development 0.70, mid
  0.90, late 0.60, dormancy 0.25, unset 0.75 (`:17`).
- Known crop with no stage gives `kc_mid` (`fao56_crop_stage_unset`).
- Stage without a start date: initial = `kc_ini`, development = `kc_mid`, mid =
  `kc_mid`, late = `kc_end`, dormancy = 0.25.
- With `stage_started_on`, development and late season ramp linearly by FAO-56
  eq. 66 over the default `stage_lengths_days` (`fao56_curve`). `stageOverrun` is
  set when the day in stage exceeds the length.
- Only `stage_lengths_days` is used. The `stage_length_alternatives` rows
  (including "East Africa" and "Arid Region") are **not** read by `resolveKc`.

**ET0 for completed days** (`EDGE/osi-agronomy-daily/index.js:179 resolveDay`,
writes `zone_daily_agronomy`). Tiers in order:

1. `station_fao56`: FAO-56 hourly Penman-Monteith (eq. 53) summed over the local
   day (`et0.js:132 fao56Et0HourlyDay`). Station = SENSECAP_S2120 assigned to the
   zone. Every hour needs T, RH, wind, radiation (lux / 120 = W/m²,
   `crop-kc.json luxPerWm2: 120`) and **at least 3 samples per hour**
   (`index.js:109 MIN_SAMPLES_PER_HOUR = 3`). It also needs longitude and a
   plausible radiation day (>= 0.06 x Ra). Wind height comes from
   `stationWindHeightM: 2`.
2. `provider_hourly_sum`: the sum of the provider's hourly ET0 (Open-Meteo or
   MeteoSwiss).
3. `hargreaves_station`: Hargreaves-Samani from the station's daily Tmin/Tmax
   (`et0.js:175 hargreavesEt0`). Needs all hours with min/max temperature.
4. Otherwise null, with reason `no_location`, `pending`, `partial_day` or
   `no_source`.

The daily Penman-Monteith `fao56Et0` (`et0.js:149`; inputs Tmin, Tmax, mean RH,
wind + height, Rs MJ/m²/day, elevation, latitude, day of year) is exported but is
not one of the three tiers.

**Inputs the game must feed (Tier 2).**

| Input | Unit | Cadence | Who produces it in-game |
|---|---|---|---|
| Hourly forecast rain (72 h) | mm/h, end-stamped hour | the code requires a forecast that is live or was fetched on today's local date before today's ET0 counts (`buildAgronomic`); the simulator reports a 15-min cache expiry | game weather generator, acting as "provider" |
| Daily provider ET0 for today (and forecast days) | mm/day | daily | game weather generator. To be honest it should be computed with `et0.js` (see open question) |
| Gauge rain | mm per uplink (`rain_mm_delta`) | device interval | game weather, via the rain gauge |
| Flow litres | L per uplink | device interval, while the valve is open | game hydraulics |
| Zone config | crop id from `crop-kc.json`, stage id, ISO date, m², % (1..100), lat/lon | on change | player through the real ZoneConfigModal |
| S2120 hourly T/RH/wind/lux/pressure | °C, %, m/s, lux, hPa | **20 min or faster** (3 samples/hour) for `station_fao56` | game weather, via the station |

**Outputs and how the game uses them.** `action.code` and `reasonCode` appear in
the in-game phone UI exactly as the real app renders them. The game may score
whether the player followed the advice, but it must use the verdict as returned.

**Limits (state these in-game).**

- The balance covers **today only**. It is not a soil water bucket and carries no
  root-zone storage or carry-over from yesterday.
- Irrigation credit is **flow-meter litres only**. Valve-time estimates
  (`estimated_gross_liters`, `estimatedIrrigationLiters`) are never added to the
  balance (`zone-env-fn`, and the skill rule "Estimated vs measured volume").
  Without a flow meter the measured litres are 0, so a zone that was just
  irrigated can still read `irrigate_today`. That is real product behaviour. The
  game should teach it ("buy a flow meter"), not paper over it.
- No output gives an amount or a duration. "Irrigate N minutes / N litres" is
  **not** OSI output.

**Simulator status.**

- `SIM/model/water-action.ts` ports only the 5-argument form. It lacks
  `rainTodayKnown`, `irrigationNetMm` and the `rain_unknown` branch. With rain
  unknown, the simulator answers `balance_unknown` where the edge would answer a
  `rain_unknown` verdict. A one-function update is needed.
- ET0 is a fictional sine fixture (`SIM/model/environment.ts:43-53`:
  `3.1 + sin(day/3.7) x 0.8`, floor 1.2; rain 1.6 mm every 4th day). It is
  **not** computed by `et0.js`.
- Forecast hours are fictional (`buildForecast`, 0.4 mm/h for 4 h on rain days).
- Kc is real (`resolveKc` GUI copy).
- Browser port needed: `et0.js` (pure CommonJS, no dependencies; trivially
  portable), plus `osi-agronomy-daily`'s `resolveDay` / `stationDayInputs` if
  the game wants the station tiers (these depend only on rows, which the game can
  synthesise).

**Honesty boundary.**

- Only `resolveWaterAction`'s code and reason are "OSI recommendations".
- Game-side derivations must not be labelled OSI: minutes to run, litres to
  apply, "irrigate tomorrow", soil-bucket depletion, yield forecasts.
- When the verdict is `insufficient_data`, the game must show that state. It must
  not substitute its own guess.
- Do not feed a fictional dendro row into argument 2 (see Research tier).

### Tier 3: remote control (phone valve control)

**What the player installs.** STREGA_VALVE, Gen1 or Gen2 (`strega_generation`).

**What the real app shows.** The valve tile and control panel, the open dialog
(`GUI/components/farming/valves/ValveOpenDialog.tsx`), the schedule dialog
(weekly and one-time), the settings dialog (default open minutes, flow rate,
early close), the service dialog, and the irrigation outcomes panel.

**OSI code.** `EDGE/osi-valve-control/*` (`api.js`, `plan.js validateScheduleInput /
compileWindows / nextLocalOccurrence / nextRun`, `push.js`, `workers.js
runOnceTick`, `cancel.js`). Pinned browser ports: `SIM/model/irrigation.ts`,
`SIM/model/plans.ts`.

**Constants.**

- **Manual timed open.** `OPEN_FOR_DURATION` takes 60..15300 s, which is
  1..255 min (`SIM/model/irrigation.ts:114`; dialog `MIN_MINUTES=1`,
  `MAX_MINUTES=255`).
- **Default open minutes** (three different values; do not collapse them):
  - Edge default: `null` (`EDGE/osi-valve-control/store.js:86`).
  - Dialog fallback: **5** (`ValveOpenDialog.tsx:33`).
  - Simulator seed: **1** (`SIM/model/state.ts:56`).
  - Settable range: 1..255.
- **Open semantics.** A repeated timed open while the valve runs is accepted and
  ignored. It does not extend the run (`scripts/test-valve-v081-equivalence.js`).
  Normal close is the valve's own timer. Early close is the two-step settings
  override. Queued cancel goes through `POST /api/v1/valves/:deveui/cancel`.
- **Weekly plan.**
  - Duration 1..1439 min; weekday mask 1..127 (bit 0 = Sunday); start time HH:MM;
    label up to 80 characters.
  - At most 4 windows per day. Overlap is checked on half-open windows, including
    a midnight spill.
  - Plans run on the valve itself (autonomous on-valve windows).
  - Scheduler status is `ACTIVE`, `SKIP_TODAY` or `DEACTIVATED`.
  - Plans are pushed only on user change or explicit re-send.
- **One-time plan.** Duration 1..255 min. A fire more than 10 min late gives
  `SKIPPED/one_time_missed`. ONCE fires even while WEEKLY is deactivated.
- **Simulator timing** (demonstration constants, not radio guarantees): ACK
  after 2 s; flow integrates from the observed open; the seed flow rate is
  6 L/min (`SIM/controller-semantics.md`).

**Inputs the game feeds.** Valve hydraulics: the flow rate in L/min while open,
which feeds the flow meter (Tier 1) and the game's soil model.

**Simulator status.** Available today. Logic and dialogs are real; the radio is
modelled.

**Honesty boundary.** This tier has no decision content. A plan the player types
is the player's plan. The game must not present a preset weekly plan as "OSI
recommends this schedule".

### Tier 4: automation (06:00 SWT threshold trigger)

**What the player installs.** An **eligible** SWT probe and a STREGA_VALVE in the
same zone.

**Eligible probes** (`buildSwtMeanQuery`, `EDGE/osi-scheduler-mean-query/index.js:60-85`):

- KIWI_SENSOR, TEKTELIC_CLOVER and DRAGINO_SDI12: domain 0..1,000,000 kPa.
- DRAGINO_LSN50 with `chameleon_enabled=1`: domain 0..300 kPa. A row counts only
  through its `chameleon_reading_links` row, and is dropped on I2C missing,
  timeout, invalid data or an open channel.

**Excluded:**

- Any row linked to `watermark_readings` (`:84`). These come from LSN50
  WATERMARK profile-3 firmware (`EDGE/osi-watermark-helper/ingest.js`). This is
  the AGENTS.md "WATERMARK scheduler interlock".
- Plain LSN50 without Chameleon.
- VWC.

A KIWI's own `swt_1/2` stay eligible, because they do not write
`watermark_readings`. In-game: a "WATERMARK node" item can show readings at
Tier 1, but the 06:00 rule must refuse it (case C24).

**What the real app shows.** The zone schedule section
(`GUI/components/farming/ScheduleSection.tsx`):

- On/off switch.
- Metric: SWT_1, SWT_2, SWT_3, SWT_AVG ("Mean (all sensors)") or DENDRO.
- Threshold in kPa: default **30**, valid `0 < x <= 300`.
- Duration in minutes: default **20**, input 1..240.
- An evaluation log. The edge node logs SKIP with reasons such as
  `no_data_last_hour` and `missing_valve`, and the debounce. The simulator's own
  record adds `started`, `below_threshold`, `same_logical_window` and the
  simulator-only `busy`.

**OSI code.** Flow inject "Schedule time" (inject) (cron `00 06 * * *`) and decision
node "Decide + build actuator cmd" (function), with `buildSwtMeanQuery`. Browser port:
`SIM/model/triggers.ts:171`.

**Exact rule.**

- Evaluated **once a day at 06:00** gateway local time. A threshold crossing at
  any other time never dispatches.
- Aggregation window: points with `recorded_at >= now - 1 h`.
- `SWT_1/2/3` average that channel over all eligible rows (SWT_1/2 fall back to
  legacy `swt_wm1/2`).
- `SWT_AVG` takes the mean of each row's non-null channels, then the mean over
  rows (not per device). Example C22: rows [30, null, 60] and [60, 60, null] give
  52.5.
- Unknown metric reads channel 1.
- Comparison: `mean >= threshold` irrigates (equality irrigates).
- No points gives `no_data_last_hour`. There is no substitute value.
- Valve: the oldest-created STREGA in the zone. None gives `missing_valve`.
- Debounce `sameLogicalWindow`: same **UTC calendar date** as
  `last_triggered_at`. A second open the same UTC day is refused (not the farm's
  local date).
- Duration: schedule `duration_minutes`, fallback 20, clamped 1..240, sent as
  `OPEN_FOR_DURATION`.

**Simulator-only behaviour, not edge rules:**

- The `busy` skip: an OPEN valve, an active command or a timed-close hold is
  recorded as skipped and not replayed. `SIM/controller-semantics.md` says the
  source has no cross-source arbiter, and the one-owner rule is "an illustrative
  model rule".
- The evaluation record and its English `advisory` sentences, which
  `triggers.ts` writes itself.
- `swtMean` (`triggers.ts:130`) accepts any finite value. The edge query
  bounds values (0..300 kPa Chameleon, 0..1,000,000 other) and applies the
  Chameleon diagnostic flags. **Verify** before a game soil model drives the
  LSN50 above 300 kPa.

**Inputs the game feeds.** The same SWT samples as Tier 1, at least one inside the
last hour before 06:00. The game's sensor interval must be under 60 min, or the
rule reports `no_data_last_hour`. The game also supplies the gateway timezone of
its fictional region.

**Outputs and how the game uses them.** A real `OPEN_FOR_DURATION` actuation runs
through the Tier 3 valve model. The flow meter and soil model then respond.

**Simulator status.** Available today (golden cases C21-C26 in
`SIM/controller-semantics.md`). Seeded triggers start disabled.

**Honesty boundary.**

- The trigger is a threshold rule the player configures. The threshold and
  duration are the player's choice.
- SWT presets Wet 20 / Moist 30 / Dry 50 kPa are defined in
  `GUI/utils/irrigationPolicy.ts:17`. At this head no `.tsx` component imports
  `SWT_PRESETS`, and the legacy trigger editor shows a plain number field
  (default 30). The skill describes them for the conditional-policy editor, with
  "Recommended" on Moist. They are generic UI presets, not a crop-specific OSI
  recommendation.
- The game must not label a threshold "optimal for sorghum".

### "Whatever else is shipped" in automation

- **DENDRO legacy trigger.** The same 06:00 node dispatches when a fresh
  (36 h local, 6 h server) non-empty dendro action exists. Duration = base x
  factor: decrease_20 0.8, decrease_10 0.9, maintain 1, increase_10 1.1,
  increase_20 1.2, emergency_irrigate 1.5, clamped 1..240
  (`SIM/model/triggers.ts:74 dendroRuleDecision`). This is real code, but its
  input is dendrometer analytics. See the Research tier.
- **Weekly and one-time plans** are calendar automation (Tier 3), not sensor
  automation.
- **Conditional irrigation policy** is shipped code that is **not qualified**.
  See below.

## 3. Prerequisite matrix (tiers are separate features)

| Feature | Soil SWT probe | Rain source | Flow meter | Valve | Weather/forecast | Zone config |
|---|---|---|---|---|---|---|
| T1 soil pill and history | required | - | - | - | - | - |
| T1 rain/flow history | - | required for rain | required for flow | - | - | - |
| T2 water verdict | **not used** | required (or provider rain) | required for irrigation credit | **not used** | required (ET0 + forecast) | crop, stage, area, efficiency, lat/lon |
| T3 timed open / plans | - | - | optional (measured litres) | required | - | timezone |
| T4 06:00 SWT trigger | required (eligible type) | **not used** | - | required | **not used** | trigger settings |
| R conditional policy | SWT/VWC sources | - | - | required | - | policy (refused today) |
| R dendro action | dendrometer cohort | - | - | for DENDRO trigger | - | - |

The game can sequence the store as a ladder (T1 then T2 then T3 then T4), but it
must not claim that T4 "uses the forecast" or that T2 "reads the soil probe". In
the shipped product they do not.

## 4. Research tier: experimental and unqualified items

| Item | Code | State | Recommendation |
|---|---|---|---|
| Conditional irrigation policy (SWT/VWC/DENDRO at scheduled opportunities; SWT presets 20/30/50; VWC `<=` percent; observation window default 60 min, 1..1440; delivery interval 1..60 min) | `EDGE/osi-irrigation-policy/evaluate.js:106 evaluateCondition`, `model.js:86 validatePolicyInput`, `worker.js:604` qualification gate | **Production qualification is false** (skill "Conditional irrigation": hardware gates unrun). The edge skips with `qualification_unavailable`. The simulator refuses an enabled conditional schedule with **503** (`SIM/model.ts:1055-1063`, `route-dispositions.ts:8`). PRODUCTION-HOOKS drops the public evaluation display (`AdvancedScheduleDrawer.tsx` row) | Do not expose it in the main ladder. At most, a clearly labelled "Research lab" tier that runs `evaluateCondition` (pure) on game data and shows the result as "experimental, not a product feature, never opens a valve". Better to omit until qualified |
| Prediction advisory (dendro zone recommendations banner) | `GUI/components/farming/dendrometer/DendrometerSection.tsx`, settings toggle "Prediction advisory": "Experimental, do not use for production!" | Experimental; hidden in the public simulator (`SettingsPage.tsx` hook row) | Do not expose |
| Dendrometer analytics (MDS/TWD stress, irrigation action) | edge `osi-dendro-analytics` (not ported) | Experimental. The AGENTS.md in the session context says provider observations have their irrigation effect off by default | **The simulator's dendro is fictional**: `SIM/model/histories.ts:75` classifies MDS with invented bands 80/180/300/450 µm, `twd_method: 'fictional_ledger_range'` (`:83`), and `zoneRecommendations` (`:90`) maps severe/significant to `increase_10`. That row still enters `resolveWaterAction` as `source: 'dendro'` (`SIM/model.ts:559 publicWaterAction`) and can drive the DENDRO trigger. **The game must not reuse it as an OSI recommendation.** Dendrometers suit trees; the semi-arid annual-crop setting does not need them. Omit |
| Gateway modules (Data, Network, Gateway hub, Journal) | Settings "Experimental only" | Experimental | Not part of the irrigation ladder |

## 5. Constants the game must align with (consolidated)

| Constant | Value | Source |
|---|---|---|
| Soil pill bands | wet `< 20`, moist `20..50`, dry `> 50` kPa | `GUI/utils/swt.ts:41-42` |
| History calendar bands | wet `< 22`, optimal `22..50`, dry `> 50` kPa | `EDGE/osi-history-helper/index.js:754-755` |
| Valid SWT domain | 0..1,000,000 kPa (LSN50 Chameleon 0..300 for the trigger) | `swt.ts SWT_KPA_RANGE`; `osi-scheduler-mean-query:69` |
| pF | `log10(kPa) + 1`, undefined at 0 | `EDGE/osi-matric-potential/index.js` |
| Sensor freshness | 3 h | `GUI/utils/zoneSoil.ts SENSOR_FRESHNESS_WINDOW_MS` |
| Trigger proximity | `>= T` at; `>= 0.8 T` approaching | `IrrigationZoneCard.tsx:366-371` |
| Legacy trigger time | daily 06:00 (`00 06 * * *`), gateway timezone | flow "Schedule time" (inject) |
| Latest-hour window | `recorded_at >= now - 60 min` | node "Decide + build actuator cmd" (function); `triggers.ts:130` |
| Trigger debounce | same UTC date as `last_triggered_at` | `triggers.ts:167` |
| Trigger threshold | default 30 kPa, valid `0 < T <= 300` | `ScheduleSection.tsx:254,350` |
| Trigger duration | default 20 min, 1..240 | `ScheduleSection.tsx:255,349`; node fallback 20 |
| SWT presets (policy editor, not imported by any component at this head) | Wet 20, Moist 30, Dry 50 kPa | `GUI/utils/irrigationPolicy.ts:17`; skill "Conditional irrigation" |
| Soil-now channel without a trigger | shallowest recorded depth | `GUI/utils/zoneSoil.ts:186 selectChannel` |
| Manual open | 1..255 min (60..15300 s) | `irrigation.ts:114`; `ValveOpenDialog.tsx:16-17` |
| Default open minutes | edge `null`; dialog fallback 5; simulator 1 | `store.js:86`; `ValveOpenDialog.tsx:33`; `state.ts:56` |
| Weekly window | 1..1439 min, max 4 windows/day | `plans.ts:43` |
| One-time open | 1..255 min, late > 10 min skips | `plans.ts:48`; controller-semantics |
| Water verdict irrigate cut | `balance <= -1` mm | `osi-zone-env/index.js` (resolveWaterAction) |
| Rain-unknown policy | `warn` | `osi-zone-env/index.js:1002` |
| Forecast window | next 24 h, Open-Meteo end-stamped `(now, now+24h]` | `sumRain` `:550` |
| Rain hour threshold | `> 0.05` mm counts as a rain hour | `buildForecastSection` |
| Net irrigation | `L x eff% / 100 / area_m2` | `toEffectiveIrrigationMm` `:786` |
| ET0 tiers (past days) | station FAO-56 hourly, then provider hourly sum, then Hargreaves station | `osi-agronomy-daily/index.js:179` |
| Station hour completeness | T, RH, wind, radiation present, `>= 3` samples/hour, radiation `>= 0` | `index.js:108-113` |
| Lux to radiation | 120 lux per W/m² | `crop-kc.json luxPerWm2` |
| Station wind height | 2 m | `crop-kc.json stationWindHeightM` |
| Radiation plausibility | day Rs `>= 0.06 x Ra` | `index.js MIN_RS_SHARE_OF_RA` |
| Dendro freshness | local 36 h, server 6 h | `triggers.ts:65` |
| Dendro duration factors | 0.8 / 0.9 / 1 / 1.1 / 1.2 / 1.5 | `triggers.ts:74`; `model.js:11` |

## 6. Crop coefficients (`crop-kc.json`, 136 crops; each row cites its FAO-56 `fao_row`, and stage lengths cite their Table 11 row)

Semi-arid smallholder crops requested:

| Requested | Present? | Catalogue id | Kc ini / mid / end | Default stage lengths ini/dev/mid/late (days) | Default row region |
|---|---|---|---|---|---|
| Sorghum | yes | `sorghum` (grain); also `sorghum_sweet` 0.3/1.2/1.05 | 0.30 / 1.00 / 0.55 | 20/35/40/30 | USA, Pakistan, Med. (alt: Arid Region 20/35/45/30, unused) |
| Millet | yes | `millet` | 0.30 / 1.00 / 0.30 | 20/30/55/35 | Central USA (alt: Pakistan 15/25/40/25) |
| Maize | yes | `maize` (grain); `maize_sweet` 0.3/1.15/1.05 | 0.30 / 1.20 / 0.35 | 30/40/50/30 | Spain / Calif. (alt: East Africa 30/50/60/40, Arid 25/40/45/30) |
| Cowpea | yes, combined | `green_gram` ("Green gram, cowpea") | 0.40 / 1.05 / 0.35 | 20/30/30/20 | Mediterranean (only row) |
| Green gram | yes | `green_gram` | as above | as above | as above |
| Beans | yes | `dry_bean` 0.40/1.15/0.35 (20/30/40/20); `green_bean` 0.50/1.05/0.90 (20/30/30/10) | | | Continental / Calif.-Med. |
| Tomato | yes | `tomato` | 0.60 / 1.15 / 0.70 | 30/40/45/30 | Mediterranean (alt: Arid Region 30/40/40/25) |
| Onion | yes | `onion` (dry); also `onion_green`, `onion_seed` | 0.70 / 1.05 / 0.75 | 15/25/70/40 | Mediterranean (alt: Arid 20/35/110/45) |
| Cabbage | yes | `cabbage` | 0.70 / 1.05 / 0.95 | 20/30/20/10 | Mediterranean "Crucifers" |
| Kale / sukuma wiki | **no** | none (no kale, collard or sukuma row) | n/a | n/a | n/a |

Other semi-arid candidates present: `groundnut` 0.4/1.15/0.6, `cassava`
0.3/0.8/0.3, `sweet_potato` 0.5/1.15/0.65, `chickpea` (stage row `verified:
false`), `sesame`, `sunflower`, `cotton`, `pepper`, `eggplant`, `watermelon`,
`pumpkin`, `spinach`, `potato`, `banana`, `mango`, `papaya`.

Kale and sukuma are absent. If the game offers kale, real OSI behaviour is that
the crop id is unknown to `resolveKc`, which returns `heuristic_phenology` Kc by
stage. That output is honest. Mapping kale to `cabbage` instead is a game-side
substitution: the app would then display "Cabbage". The project owner decides
(section 8).

## 7. What must be built for the game

1. **Reading seam.** Let the host inject per-device samples (SWT kPa, rain mm
   delta, flow L delta, S2120 hourly weather) into `ReadingLedger`. This replaces
   `sampleValues` sine curves and `applySoilResponse`, and needs a `game` source
   tag.
2. **Weather seam.** Replace `environment.ts weather()` and `buildForecast` with
   game weather: hourly forecast rain and daily ET0.
3. **Port the `rain_unknown` branch.** Bring the full 7-argument
   `resolveWaterAction` and `RAIN_UNKNOWN_POLICY` into `SIM/model/water-action.ts`,
   with a parity test against `osi-zone-env`, as `demo/tests/environment.test.ts`
   already does for the 5-argument form.
4. **Port ET0.** `et0.js` as a pure browser module. Optionally port
   `osi-agronomy-daily resolveDay` / `stationDayInputs` for past-day ET0 and
   station tiers, with an S2120 sampling interval of 20 min or less.
5. **Remove the fictional dendro feed** from `publicWaterAction` in the game
   build, or gate it behind the research tier.
6. **Tier gating** in the game shop maps to device registration in the real app
   (AddDeviceModal with fictional EUIs `00000000000000xx`) and to zone config
   fields. No new OSI logic is needed for gating.

## 8. Open questions for the owner

- **Today's ET0 source.** The shipped product takes today's ET0 from the
  provider forecast day. `et0.js` only fills completed days. Should the game
  compute "provider" ET0 with `et0.js` (real OSI maths on game weather, a
  composition the product does not ship for today), or present the game weather
  as an external provider value with its own label?
- **Kale / sukuma.** Accept the `heuristic_phenology` Kc for unknown crops, map
  to `cabbage` with a visible disclosure, or add a kale row upstream to
  `docs/contracts/agronomy/crop-kc.json`?
- **Stage lengths.** `resolveKc` uses Mediterranean/US default stage lengths.
  For East African or arid seasons the game's phenology will overrun
  (`stageOverrun`). Accept that, or add a region-aware stage length upstream?
- **Research tier.** Expose conditional irrigation as a labelled research lab,
  or omit it entirely until production qualification?
- **Soil band disagreement.** Show only the card bands (20/50), or also the
  calendar bands (22/50)?
