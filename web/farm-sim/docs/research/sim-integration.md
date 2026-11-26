# Integration spec: driving the PR #658 OSI OS simulator from the farming game

Worktree: `<repo>` at `4682fb17b1` (PR #658 head). Paths below are relative to `web/react-gui/` unless stated otherwise. Line numbers were re-derived per file with `grep -n`.

## 0. Verdict and evidence

**The target architecture holds, with one refinement.** The game window owns one `Simulator` as part of its deterministic state. A same-origin iframe phone runs the real OSI app. Its axios adapter forwards to the parent's `requestResponse`, and its `Date` reads the parent clock. The game tells it to revalidate after mutations or time jumps. The phone is a pure view: it can be unloaded at any time, and the simulation, headless tests and replays run without it.

The refinement: **every value that crosses the frame boundary is structured-cloned on the receiving side**. Request bodies are cloned into the parent realm and responses into the iframe realm. <!-- slop-allow: "realm" is the ECMAScript term for a JS global environment -->

`instanceof` checks are realm-bound, so without the clones they silently misclassify: <!-- slop-allow: "realm" is the ECMAScript term for a JS global environment -->
- the model's body checks `body instanceof FormData/Blob/ArrayBuffer` (`demo/model.ts:667,672`);
- the adapter's `data instanceof Blob/ArrayBuffer` response encoding (`demo/adapter.ts:9-12,17-19`);
- the app's `data instanceof Blob` (`src/services/api.ts:2302`).

SWR 2.3.7 itself is mostly tolerant: `stableHash` uses `Array.isArray` and type-name checks, and `compare` is `dequal/lite`, whose `ctor === Array` miss falls back to key-wise comparison.

What was run, not argued. Scripts are in the scratchpad `bench/` and `patched/farm-sim/` folders.

| Test | Result |
|---|---|
| Closed loop on the **unpatched** head, zero hooks (`bench/closed-loop.ts`) | Farm built through REST, game readings, game soil bucket fed from the actuation ledger, 06:00 trigger, 5 nights. The trigger fired every day. Game litres equalled `estimatedGrossLiters` for all 10 runs, with and without a flow meter. The next Kiwi sample after each run showed the water (for example 53→42.86 kPa). Two runs gave identical SHA-256 hashes over zones, devices, outcomes and samples. |
| Closed loop with the proposed hook commit (`bench/closed-loop-hooks.ts`, scratch copy) | Game weather, ET0 from the edge `fao56Et0` (osi-agronomy-daily/et0.js), `fictionalHistory:false`, epoch moved to 2027-03-01 with the public `clock.reset`. The app's today ET0 was 6.89, equal to the game's value. Kc 1.18 (`fao56_curve`), demand 8.13 mm, action `irrigate_today`, past days labelled with the game's `et0_source`. Deterministic across two runs. The epoch move ran only on the patched copy, and only forward in time. |
| Hook commit vs CI gates (scratch copy) | `tsc -p demo/tsconfig.json --noEmit` exit 0, the gate in `.github/workflows/public-simulator.yml`. 16 demo test files: 203/203 pass, the same 203/203 as the unpatched head. This is not the full `demo:test` suite. |
| Other control paths on the **unpatched** head (`bench/closed-loop-2.ts`) | Exercised a manual `OPEN_FOR_DURATION` followed by an early `CLOSE` (CANCELLED, 60 L sim = 60 L game) and a weekly plan (2 runs of 160 L at the calibration rate of 8 L/min, sim = game). Also exercised: `PUT /api/system/settings` gatewayTimezone, `POST .../calibration`, `PUT .../zone-assignments` (the station became the selected rain source), and Kiwi temperature/humidity enable. Deterministic across two runs. |
| CPU profile, 10 simulated days | 72.5 % of time in `localCalendarDayStart` (`demo/model.ts:70-78`). |
| Trial phone build (`patched/farm-sim/vite.config.mjs`, Vite 5.4.21 from `react-gui/node_modules`) | Builds. One React copy (react 18.3.1 and react-dom 18.3.1 modules each bundled once). Tailwind utilities emitted (`.bg-white`, `.flex`, `.rounded-xl`). No model code in phone chunks. The CJS `et0.js` builds only with `build.commonjsOptions.include` and fails without it (`"fao56Et0" is not exported`). |
| Headless Chromium smoke of the trial build (`patched/farm-sim/smoke.cjs`) | The phone iframe rendered the parent's farm. Phone `Date.now()` equalled the parent `sim.now` (drift 0). The parent's `localStorage.auth_token` was untouched (null). A game-side REST rename appeared in the phone. Zero console errors. The trial ran with cwd = `react-gui` and no `package.json` in farm-sim, so Tailwind output and the single-React result are **untested from a farm-sim npm script**. |

The repo was not modified (`git status --porcelain` is empty). All experiments ran on a scratch copy.

---

## 1. Mode: use `public`. `presentation` cannot drive a game

| | `presentation` | `public` |
|---|---|---|
| Epoch | `DEMO_EPOCH` 2026-09-29T09:00Z (`demo/history.ts:3`) | `PUBLIC_EPOCH` 2026-10-10T02:59:50Z, 10 s before 06:00 Kampala (`demo/fixtures.ts:5`, `controller-semantics.md` "Clock and seed") |
| Modules | data, network, hub and journal off (`demo/model/state.ts:64-66`) | defaults |
| Clock events | none: `setupPublicClock` is public-only (`demo/model.ts:109-112`) | per-device sampling plus the 06:00 daily trigger (`model.ts:138-141`) |
| Readings | `ReadingLedger(..., false)`, no ledger (`model.ts:106`); fixed fixtures from `demo/history.ts` | 90-day synthetic seed, 48 samples a day per device (`demo/model/readings.ts:158-172`), then snapshots (`model.ts:193-198`) |
| Daily trigger | none, and the "not simulated" notice (`demo/runtime.ts:129-131`) | `onDailyTrigger = evaluateAutomaticTriggers` (`model.ts:110`). Only scheduled while some zone has `schedule.enabled` (`model.ts:231,238`); the public seed sets schedules to null (`state.ts:81`) |
| Environment | `environmentFixture`: no ET0, forecast or demand (`fixtures.ts`, comment above `environmentFixture`; `model.ts:1133`) | `buildEnvironmentSummary` plus 92 days of retained records (`model.ts:256-266`, `environment.ts:94-104`) |
| Device registration | Kiwi only, no AppKey (`model.ts:1209`) | all catalogue types except UC512 (`model.ts:1207`) |
| Device routes, plans, valve settings, service actions, history, network | unsupported (`model.ts:1246,1248`, `model.ts:504`, `irrigation.ts:151`, `model.ts:627,633`) | supported |
| Flow samples | `appendFlowSample` public-only (`model.ts:407`) | yes |
| Timed-open ACK delay | 0 (`irrigation.ts:122`) | 2 s |

The public seed also adds fixture devices (`state.ts:80-129`). It sets zone coordinates to 0.3476, 32.5825 (`state.ts:73-74`). **Those are real-world Kampala coordinates; the game must replace them with fictional ones.**

---

## 2. Defining the game's own farm

**Recommendation: drive the simulator's own REST routes from the game, exactly as the app would. Proven in `closed-loop.ts`.**

REST is more robust than writing state directly. The routes carry validation and side effects that direct writes would have to reproduce:
- Sampling schedule on device create (`model.ts:1220`).
- Daily-trigger refresh on schedule change (`model.ts:1201`).
- Environment-record refresh on zone create and config (`model.ts:1034,1105`).
- Skip-today rollover for valves (`model.ts:1107`).
- Clock invalidation on delete (`removeDevice`, `model.ts:287-309`).

Writing state directly needs the private `setupPublicClock` and `completedEnvironmentKeys`, so it breaks on refactors.

### Recipe (all routes exist in public mode)

Exercised headless: steps 1-10 in `closed-loop.ts` and `closed-loop-2.ts`, with zone deletion in `closed-loop-hooks.ts`. Only one-time (`ONCE`) plans and plan update/delete were not exercised; for those, see the code.

1. Remove fixture devices: `DELETE /api/devices/:eui` for each (`model.ts:1224-1229`).
2. **Keep zone 1 and rename it**, rather than deleting it. The public app auto-expands zone 1 (`src/pages/FarmingDashboard.tsx:304`); new zones start at id 3 (`state.ts:54`).
   - Rename: `PUT /api/irrigation-zones/1/name`.
   - Remove extra zones: `DELETE /api/irrigation-zones/2` (`model.ts:1086`). There is no protected-zone rule in the model.
3. Zone agronomy: `PUT /api/irrigation-zones/:id/config` with any of `cropType, variety, soilType, irrigationMethod, areaM2, irrigationEfficiencyPct, schedulingMode, notes, timezone, phenologicalStage, calibrationKey, predictionCardEnabled, weatherSource, stageStartedOn` (`demo/model/farm.ts:26-45`).
   - Validation: `areaM2 > 0`; `0 < irrigationEfficiencyPct ≤ 100`.
   - `cropType` is a catalogue id from `src/agronomy/crop-kc.json` (136 crops, including maize, sorghum, millet, dry_bean, groundnut, green_gram, onion, tomato, cabbage, cassava).
   - Kc comes from `resolveKc` (`src/agronomy/cropKc.ts:73-93`, "the GUI copy of osi-crop-kc"). It depends on `phenologicalStage` and `stageStartedOn`.
   - **Kc does not advance stages on its own.** The game must `PUT .../config` when its crop changes stage, either as the farmer updating the app or as a tutorial prompt.
4. Location: `PUT /api/irrigation-zones/:id/location {latitude, longitude}` (`model.ts:1120-1124`). **`createZone` does not set coordinates** (`farm.ts:13-19`). Without them, `hasValidWeatherLocation` is false and ET0 is null ("no_location", `environment.ts:84`).
5. Gateway timezone: `PUT /api/system/settings {gatewayTimezone}` (route `model.ts:1000`, handler `model.ts:267-283`).
   - The daily trigger fires at 06:00 **gateway** time (`model.ts:240-249`), and the flow day uses the gateway timezone (`model.ts:225`). The rain day uses the **zone** timezone (`model.ts:199-207`).
   - Keep both equal, and pick a zone without daylight saving time (see section 6).
6. Devices: `POST /api/devices {deveui, name, type_id, zone_id}` (`model.ts:1205-1223`; defaults from `createDevice`, `demo/model/devices.ts:18-54`).
   - Use fictional EUIs `00000000000000xx`.
   - LSN50 defaults to MOD9 with rain and flow enabled (`devices.ts:41-44`).
   - Kiwi starts with temperature and humidity off (`devices.ts:34`). Enable them with `POST /api/devices/:eui/kiwi/temperature-humidity/enable {minutes}`. This is deferred 2 s (`model.ts:740-742`, `applyDeviceConfig` `model.ts:174-192`).
7. Weather station to zones: `PUT /api/devices/:eui/zone-assignments {zone_ids}` (`model.ts:684-687`). The station then becomes the zone's preferred rain source (`model.ts:464-466`).
8. Flow rate:
   - per valve: `PUT /api/valves/:eui/settings {flow_rate_lpm, flow_rate_source}` (`irrigation.ts:83-101`); or
   - per zone: `POST /api/irrigation-zones/:id/calibration {measuredFlowRateLpm}` (`model.ts:1112-1118`).
   - Resolution order: valve, then zone calibration, then zone, then 6 L/min (`model.ts:520-525`).
9. Automation tiers:
   - legacy 06:00 trigger: `PUT /api/irrigation-zones/:id/schedule {trigger_metric, threshold_kpa, duration_minutes, enabled}` (`model.ts:1169-1203`);
   - weekly or one-time plans: `/api/valves/:eui/schedules` (`demo/model/plans.ts:479-552`);
   - manual timed open: `POST /api/valve/:eui {action:'OPEN_FOR_DURATION', duration_seconds}`, 60..15300 s (`irrigation.ts:103-124`).
10. After setup, set `sim.state.sessions.pendingOutboxCount = 0`. Every canonical REST write bumps the demo "pending sync" counter (`model.ts:621-637`, `demo/model/sessions.ts:136-138`).

### REST caveats

- **Without the hook, `POST /api/devices` writes 90 days of fictional history for the new device** (`seedNewDevice`, `model.ts:1219`, `readings.ts:174-180`). Override it before posting; see section 3.
- New devices are first sampled 30 min after creation, whatever their interval (`model.ts:1220`).
- `weather_source_default` cannot be set over REST; it is seeded only (`state.ts:73-74`). It falls back to `open_meteo` (`environment.ts:29-31`).
- UC512 registration returns 501 (`model.ts:1207`).
- A zone without a flow meter gets `balance_unknown`. Measured litres come only from a device with `flow_meter_enabled === 1` (`model.ts:445,453`), so the net, total and balance are all null (`environment.ts:151-152,218`). Measured in `closed-loop.ts`: with meter `irrigate_today`; without meter `insufficient_data / balance_unknown`. This is a lesson for the game's "sensor-only" tier.

---

## 3. Readings: replacing the synthetic curves with game physics

### How readings flow today

- Each device has a self-rescheduling clock event (`model.ts:146-164`; priority 4).
- On LSN50 events, active flow for that meter is integrated first (`model.ts:151-155`).
- Then `values = withDailyWaterTotals(device, applyDendroBaseline(device, readings.sampleValues(device, at)))`. The result is appended to the ledger, and **`device.latest_data` is replaced wholesale** (`snapshotLatestData`, `model.ts:165-173`).
- `withDailyWaterTotals` derives `rain_mm_today/rain_day/...` and `flow_liters_today` from the ledger (`model.ts:208-229`). It returns early when a sample has neither `rain_mm_delta` nor LSN50 `flow_liters_delta` (`model.ts:211`).

### Fields the game must supply per device

Only physical uplink fields. Never `*_today`; the simulator derives those.

| Device | Required fields | Why |
|---|---|---|
| `KIWI_SENSOR` | `swt_1`, `swt_2` as positive kPa (20 and 40 cm by default, `soil_moisture_probe_depths_json`, `fixtures.ts:18`); `bat_pct`; optional `ambient_temperature`, `relative_humidity`, `light_lux` when `temp_humidity_enabled=1` | Card reads these (`src/components/farming/KiwiSensorCard.tsx`). Trigger eligible (`triggers.ts:121-128`). **Never include a `watermark` object**: that makes the sample ineligible (`triggers.ts:122`). **Omit `rain_mm_delta`**: the synthetic Kiwi emits it (`readings.ts:21`), which makes every Kiwi sample pay the daily-total cost. |
| `DRAGINO_LSN50` (MOD9) | `rain_mm_delta` (mm since previous uplink), `rain_mm_per_10min`, **`flow_liters_delta: 0` on every uplink**, `flow_liters_per_10min`, `lsn50_mode_label:'MOD9'`, `lsn50_mode_code:9`, `bat_pct` | `publicWaterDays` sums `flow_liters_delta`; with no numeric value `aggregate` returns null, and the balance becomes unknown (`readings.ts:220-225`, `model.ts:452-455`). Real flow is merged from the simulator's own `observed-flow` sample at the same instant (`readings.ts:190-200`). |
| `SENSECAP_S2120` | `ambient_temperature`, `relative_humidity`, `wind_speed_mps`, `wind_gust_mps`, `wind_direction_deg`, `rain_mm_delta`, `barometric_pressure_hpa`, `light_lux`, `uv_index` | Synthetic shape (`readings.ts:63-67`); card fields; local environment channels (`environment.ts:10-16`) |
| `STREGA_VALVE` | `valve_state` (0/1), `bat_pct`, or delegate to synthetic | `readings.ts:62` |
| `AQUASCOPE_LORAIN` | `rain_mm_delta`, `rain_mm_per_10min`, `rain_gauge_cumulative_mm` | `readings.ts:68-74` |
| `TEKTELIC_CLOVER` | `swt_1`, `swt_2`, `ambient_temperature`, `relative_humidity`, `light_lux` | `readings.ts:23-27` |

### Option Z: zero hooks, works on today's head (proven)

```ts
const sim = new Simulator({mode: 'public'});            // pays ~1.1 s for the 90-day seed (measured), then discards it
sim.readings = new ReadingLedger([], true);              // precedent: demo/tests/history-api.test.ts:135, rain-history.test.ts:22
sim.readings.sampleValues = (device, at) => game.readDevice(device, at);
sim.readings.seedNewDevice = (device, at) => sim.readings.append(device.deveui, at, sim.readings.sampleValues(device, at), 'synthetic');
```

Caveats:
- `readings` is a public, non-readonly field (`model.ts:90`). Every port reads `this.readings` at call time (`model.ts:537,628,634`), so replacing it is safe.
- `ReadingLedger.enabled` is read nowhere else (grep).
- `applySoilResponse` still runs 10 min after a run (`model.ts:352-364`). It calls the override, which appends one extra game sample. Harmless, but it is synthetic-response plumbing.
- `sim.reset()` rebuilds the default ledger (`model.ts:315`), so the game must never call `reset()`.

### Option H: hook commit (recommended; section 8)

Use `new Simulator({mode:'public', fictionalHistory:false, readingSource})`.
- Construction is no longer paid for history that gets discarded.
- New devices get one sample from the source instead of 90 fictional days.
- `applySoilResponse` becomes a no-op when a source is set, because game physics owns the soil response.
- The source gets a `synthetic()` fallback for device types the game does not model.

### The game's reading function should pull, not push

When the simulator asks for a Kiwi value at `at`, step the zone's soil model to `at` first: rain from game weather plus irrigation from section 4. Then report SWT at the probe depths. Events at the same instant run in priority order: close 1, ACK/open 3, sample 4 (`clock.ts:55`, `irrigation.ts:57,60`, `model.ts:163`), so a sample sees ordinary opens and closes from the same instant.

The exception is a weekly-plan start (priority 6, `plans.ts:264`): it opens with zero delay *after* a sample at that exact instant. That costs nothing, because `litersBetween` counts from `observedOpenAt`, and the next sample includes the water.

---

## 4. Water out: how the game learns about irrigation

### Lifecycle (`demo/model/irrigation.ts`)

- `startValveActuation` (lines 29-62) creates an `ActiveCommand` (`state.ts:19-33`) and stores it in `state.activeCommands`. It also unshifts an `IrrigationActuation` with status `PENDING_OPEN` into `state.ledger` (`sim.outcomes`).
- ACK after `open_delay_ms` (2 s public, 0 for weekly plans; `plans.ts:254`): status `RUNNING`, `observedOpenAt`, `valve.current_state='OPEN'`, `valve_opening_percent=100`.
- Auto-close at `open_delay + duration` (priority 1).
- `closeValveActuation` (lines 64-76) integrates flow, sets `observedCloseAt` and final status, calls `afterActuationClosed`, and deletes the command.
- Cancel before ACK: `CANCELLED` with no `observedOpenAt` (lines 126-140). Cancel after ACK: 409 `actuation_handed_off`.

### Flow integration (`model.ts:372-442`)

- `integrateCommandFlow` computes litres as `Δt_min × flow_rate_lpm × valve_opening_percent/100` (lines 380-389).
- It pushes `{zoneId, from, until, liters}` to the private `estimatedFlowIntervals` (line 390) and updates `estimatedGrossLiters/flowRateLpm` on the outcome (lines 398-401). With a meter, it appends an `observed-flow` sample (lines 404-408, 419-442).
- Integration happens only at LSN50 sample instants (`model.ts:151-155`), at close (`irrigation.ts:68`) and at partial-opening or flushing steps (`irrigation.ts:252,269,273`). Pushed intervals are therefore up to 30 min coarse. **Do not drive soil physics from them.**
- Note: the simulator's "flow meter reading" is this duration × rate estimate. It is not an independent physical measurement (see the honesty ledger in section 9).

### Option Z: exact zero-hook interface

Verified, with game litres equal to `estimatedGrossLiters`, for:
- 10 trigger runs, with and without a meter;
- 2 weekly-plan runs;
- 1 manual open cancelled early with `CLOSE`.

Timed-close holds, partial opening and flushing are covered by code reading only.

```ts
export type IrrigationEvent =
  | {kind: 'commanded'; at: number; expectationId: string; valveEui: string; zoneId: number | null; trigger: string; durationSeconds: number}
  | {kind: 'opened';    at: number; expectationId: string; valveEui: string; zoneId: number | null; flowRateLpm: number}
  | {kind: 'closed';    at: number; expectationId: string; valveEui: string; zoneId: number | null; status: 'COMPLETED' | 'CANCELLED'; grossLiters: number | null};

export class OsiWaterTap {
  private seen = new Map<string, string>();              // expectationId -> last status
  constructor(private sim: Simulator) {}
  /** Litres delivered to a zone in [from, to): same formula as model.ts:385-387. */
  litersBetween(zoneId: number, from: number, to: number): number {
    let total = 0;
    for (const o of this.sim.outcomes) {
      if (o.zoneId !== zoneId || !o.observedOpenAt) continue;
      const open = Date.parse(o.observedOpenAt), close = o.observedCloseAt ? Date.parse(o.observedCloseAt) : to;
      const active = this.sim.state.activeCommands.get(o.deviceEui);
      const rate = active?.expectation_id === o.expectationId ? active.flow_rate_lpm! : Number(o.flowRateLpm ?? 0);
      total += Math.max(0, Math.min(close, to) - Math.max(open, from)) / 60_000 * rate;
    }
    return total;                                          // net mm = liters × eff% / 100 / area (model.ts:32-35)
  }
  /** Call after each advanceTo: diff outcome statuses into events with exact simulated timestamps. */
  drain(): IrrigationEvent[] { /* compare sim.outcomes[i].status with this.seen; emit commandedAt / observedOpenAt / observedCloseAt */ return []; }
}
```

How the parts fit:
- **Soil physics** calls `litersBetween` from inside the reading source (pull model, section 3). It is exact at every sample instant, including runs inside an overnight jump.
- **Animation and HUD** use `drain()` once per frame. During sleep, the events simply arrive in bulk with their real timestamps.
- Plans firing (`plans.ts:202-264`, `trigger: 'on_valve_schedule'`, plan id in `commandResultDetail`) and trigger firing (`triggers.ts:171-215`, dispatch at line 202, `trigger: 'trigger_based'`, evaluations in `sim.state.triggerEvaluations`) appear in the same ledger. One interface covers manual, plan and trigger water.

Known gap: partial-opening and flushing service actions change `valve_opening_percent` mid-run (`irrigation.ts:244-282`), and the ledger does not record that. Either keep those STREGA service dialogs out of the game's scope, or approximate them with the current percentage. An observer hook for exact openness is possible but not part of the minimal commit.

### Manual watering outside OSI (watering can or hose)

Treat it as **unmetered**: the game applies it, and OSI does not see it. That is honest, and it teaches the point. Appending game "flow" to the LSN50 conflicts with `observed-flow` merging (`readings.ts:190-194`).

---

## 5. Weather and ET0

### Today, the ET0 is illustrative

- `weather(date, provider)` returns a sine series (`environment.ts:43-54`), not the edge FAO-56.
- `recordFor` (56-92) turns it into `et0_mm`, `etc_mm = et0 × Kc` (real Kc), `forecast_rain_mm`, a constant RH of 62, and the label `provider_hourly_sum`. Past days with a numeric ET0 are frozen in `state.environmentRecords` (line 61).
- `syntheticDays` (132-172) builds the 7-day water table. `buildEnvironmentSummary` (198-235) sets `waterNeededTodayMm = today.etc`, `balanceTodayMm = total − demand` (217-218), and online and agronomic current values with constant RH 62 and wind 1.1.
- `buildForecast` (237-278) builds 72 hourly points: **0.4 mm/h for 4 h on any wet day, whatever the daily amount** (line 249).
- `syntheticEnvironmentTimeline` (106-130) feeds history and analysis (`model/history.ts:245,279`, `model/analysis.ts:100`).
- `resolveWaterAction` (`model/water-action.ts:10-26`) is a port of `osi-zone-env::resolveWaterAction` that **lacks the edge's rain-unknown branch** (edge `conf/.../node-red/osi-zone-env/index.js:973-975`).

**There is no zero-hook path.** `weather` is module-private. Today and forecast days are always recomputed (line 61 only reuses past days), so pre-filling `environmentRecords` cannot change today's demand or the forecast.

### Minimal hook (in the section 8 diff)

The hook is a `WeatherSource` set from `SimulatorOptions.weatherSource`. It is threaded as an optional `zone` argument into all three `weather()` calls. RH, wind, `et0_source`, `et0_tier` and the hourly rain amount come from the source; the hourly amount becomes `daily.rain/4`, which equals the old 0.4 for the default 1.6 mm series, and the 203 tests confirm the change is invisible.

```ts
export type DailyWeatherInput = {et0: number; rain: number; maxTemp: number; meanRhPct?: number; windSpeedMps?: number;
  et0Source?: string; et0Tier?: string};
export type WeatherSource = (date: string, zone: IrrigationZone) => DailyWeatherInput | null;
```

Game-side source, honest because ET0 is real OSI code:

```ts
import {fao56Et0} from '@osi-edge/osi-agronomy-daily/et0.js';   // pure CJS; needs build.commonjsOptions (verified)
const weatherSource: WeatherSource = (date, zone) => {
  const w = gameWeather.day(date);                               // game Tmin/Tmax/RH/wind/Rs/rain, actual or forecast
  const et0 = fao56Et0({tMinC: w.tMin, tMaxC: w.tMax, meanRhPct: w.rh, windSpeedMs: w.wind, windHeightM: 2,
    solarRadMjM2: w.rs, elevationM: w.elevation, latDeg: zone.latitude!, dayOfYear: dayOfYear(date)});
  return et0 == null ? null : {et0, rain: w.forecastRainMm, maxTemp: w.tMax, meanRhPct: w.rh, windSpeedMps: w.wind,
    et0Source: 'fao56_daily_game_weather', et0Tier: 'fao56_daily'};
};
```

**Still illustrative after the hook.** The minimal diff does not touch:
- `agronomic.current`, which keeps `relativeHumidityPct: 62`, `vpdKpa: 1.1`, `dewPointC: 17`, `thi: 67`, `heatIndexC = maxTemp` and `thermodynamicSource: 'illustrative'` (`environment.ts:226-229`);
- the hourly forecast's rain timing (4 h starting at a date-derived hour), rain probability (45/8 %) and temperature shape (`maxTemp − |hour−14|×0.35`) (`environment.ts:246-250`);
- the daily forecast min temperature, which is derived from that shape (`environment.ts:259-260`).

`DailyWeatherInput` has no Tmin. The hook makes these correct: ET0, Kc × ET0 demand, the balance, the daily forecast rain total, today's RH and wind in the online "current" block, and the water action that depends on them.

To make the Agronomic and Weather tabs fully game-driven, widen the hook:
- add `minTemp`, optional `hourly` rows, and computed VPD and dew point (FAO-56 eq. 11-14 vapour pressure, the same formulas `et0.js` uses internally);
- or label those tiles as illustrative in the game.

Rules:
- `rain` is the **forecast** for that date. Measured rain reaches OSI only through the gauges' `rain_mm_delta` (section 3), so forecast and actual can differ, as in real life.
- The source **must return non-null for today and the next 3 days** whenever the zone has a provider and location. `buildForecast` dereferences `weather(...)!` (line 244). It is also called for the 92 days before the start; climatology or null is acceptable there.
- Do not label daily FAO-56 as `provider_hourly_sum`. The edge uses that label for summed provider ET0 (`osi-agronomy-daily/index.js:209`).

---

## 6. Clock

- **Driving time.** Simulated time is game time. Each game tick calls `sim.advanceTo(gameNowMs)` (`model.ts:330-333`). `advanceTo` runs every due event at its own timestamp, re-sorting after each callback, so events scheduled during the jump run in the same call. It then sets `now = target` (`clock.ts:51-66`). Events exactly at the target fire (`atMs > target` breaks).
  - Never call `advance()` (real-time × speed, `model.ts:323-329`); that is the runtime's real-time path.
  - The clock refuses to go backward (`clock.ts:53`).
- **Sleeping** is `advanceTo(next 06:00 local)`. Samples, plan starts, closes, the 06:00 trigger and soil responses for the skipped hours all run in order, and the trigger fires during the jump. Sleeping until 05:59 instead lets the player watch the 06:00 decision.
- **`MAX_JUMP_MS` = 8 days** (`clock.ts:15`) limits only `nextEvent`/`jumpToNextEvent` lookahead (`clock.ts:68-78`, `model.ts:334-347`) and the daily-trigger scheduling horizon (`model.ts:231`). It does **not** limit `advanceTo`.
- **Event counts, measured:** a 4-device farm (Kiwi, valve, LSN50, SenseCAP) with the trigger fires 97 events per 12 h. Roughly that is devices × 2/h plus about 3 per run plus the trigger.
- **Performance, measured on this machine:**
  - Unpatched: 12 h takes 0.44-0.46 s (about 4.6 ms/event), and 30 days takes 26 s.
  - The cost is `localCalendarDayStart`, which steps minute by minute with `formatToParts` (`model.ts:70-78`). It runs for every rain or flow sample via `withDailyWaterTotals`, and 14× per environment-summary request (`model.ts:443-460`).
  - With the 9-line memo in section 8: 12 h nights take 6-45 ms (about 10-75× faster; 45 ms was a first night including the environment-record seeding), 30 days 1.5-1.8 s, and environment-summary 70-115 ms. Outputs and 203 tests are unchanged.
  - Remaining growth: `aggregate` and `forDevice` are O(N) over each device's samples, and `forDevice` structured-clones them (`readings.ts:210-225`). For a 120-day season at 30-min uplinks that is about 5,800 samples per device. Fine for now; prune later if needed.
  - Construction in public mode with the seed takes about 1.1 s; `fictionalHistory:false` removes it.
- **Moving the epoch, zero hooks** (shown in `closed-loop-hooks.ts`, which ran on the patched copy and moved forward only; the steps use only public API that the hook does not touch):
  1. Construct.
  2. `DELETE` the fixture devices; this cancels their events.
  3. `sim.clock.reset(start)` (`clock.ts:80-88`, public).
  4. `sim.state.environmentRecords.clear()`.
  5. Build the farm through REST, which reschedules sampling and the trigger.

  `state.now` goes stale, but it is only read by the constructor and `reset()` (`model.ts:105,314`).
- **Determinism:**
  - No `Math.random`, `crypto` or `performance.now` in the model or the `src/` modules it bundles (grep over all 43 bundle inputs).
  - The only `Date.now()` is a default argument that is always supplied (`triggers.ts:74`, called with `at` at line 184).
  - Event order is total: time, then priority, then insertion sequence (`clock.ts:55`).
  - `structuredClone` and Map iteration are deterministic.
  - Remaining risks:
    1. Intl time-zone data. Choose a zone with no daylight saving time.
    2. ECMAScript lets `Math.exp/pow/sin` differ across engines. The game physics and `et0.js` may differ in the last bit across browsers; `round2` hides most of it. Guarantee replays per engine only.
    3. App-originated inputs. The phone prefills random `02F1…` EUIs (`src/utils/publicSimulatorDeviceDefaults.ts:10-26`), and the runtime writes `settings.defaultTimezone` from display preferences (`runtime.ts:36-38`), which `createZone` uses (`farm.ts:15`). **Log every phone `requestResponse` that is not a GET, with `sim.now`, plus preference writes, as replay input.**
    4. GET side effects are limited to caching past-day environment records (`environment.ts:88-90`). These are deterministic, given the same weather source and zone config at first computation.

---

## 7. Phone build (`web/farm-sim`)

### Verified in the trial build

Config file: `patched/farm-sim/vite.config.mjs`, a sibling of a copied `react-gui`.

- **No `react` in `web/farm-sim/package.json`.**
  - App files resolve bare imports from `web/react-gui/node_modules` by walking up from their own location.
  - farm-sim's own phone files import only relative react-gui paths.
  - The trial adds a safety alias that resolves react and react-dom through `createRequire(react-gui/package.json)`.
  - Result: each React module bundled once. The game's own engine dependencies can live in `web/farm-sim/node_modules`.
- **Load Vite and plugins from react-gui.** `createRequire(resolve(gui,'package.json'))` supplies `vite`, `@vitejs/plugin-react`, `@tailwindcss/postcss` and `autoprefixer`. Run with `react-gui/node_modules/.bin/vite build --config ../farm-sim/vite.config.mjs`.
- **Inline PostCSS:** `css.postcss.plugins = [tailwind(), autoprefixer()]`. `react-gui/postcss.config.js` is not an ancestor of the farm-sim root, so Vite would not find it.
  - `src/index.css` keeps `@config "../tailwind.config.js"`, whose `content` covers `./src/**`. Utilities were emitted.
- **Reuse from `vite.demo.config.ts`:**
  - define `VITE_PUBLIC_SIMULATOR='true'` and `VITE_OSI_SERVER_URL` (lines 17-20);
  - the pre-plugin aliases (lines 21-31): `utils/datetime` → `demo/public/datetime.ts` (zone-aware formatting, `public/datetime.ts:13-19`), `services/deviceLocation` → `demo/public/device-location.ts`, and `i18n/config` → `demo/i18n.ts`.
  - The public flag is what turns on `subscribePublicSimulatorInvalidation` (`src/utils/publicSimulatorInvalidation.ts:5-13`, used by `EnvironmentCard.tsx:133` and `IrrigationZoneCard.tsx:424`), the zone-1 expansion and the route redirects (`src/App.tsx:89,108,131,142`).
- **CJS edge modules:** add `build.commonjsOptions.include: [/node_modules/, /osi-agronomy-daily/]` and an alias such as `@osi-edge` → `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red`. Verified: without the option the build fails.
- **No model code in phone chunks**, even though `demo/adapter.ts:2` imports `DemoError` and `Simulator` from `./model` (`Simulator` is type-only; `DemoError` is re-exported from `errors.ts`). Shared chunks between the game and phone entries contain only `src/` helpers.
- **Unverified:** the dev server. Vite's default `server.fs.allow` stops at the nearest package root, so add `server.fs.allow: [resolve(here, '..')]` for `vite dev`.

### What the phone runtime must replicate from `demo/runtime.ts` and `demo/bootstrap.ts`

1. Memory `localStorage` and `sessionStorage` installed **before any app import** (`bootstrap.ts:3-15`). `src/services/api` reads storage at import time (`bootstrap.ts:1-2`).
   - Without it, the same-origin phone writes into the game's storage. The smoke test confirmed isolation.
   - Refinement: back the memory store with a parent-owned map (`bridge.storage`), so language and theme survive unloading and live in the save file.
2. `applyPublicCopy(i18n)` (`runtime.ts:18`, `public-copy.ts:15`).
3. `data-public-simulator` on `<html>` and `#root` (`runtime.ts:20-21`). `demo/app.css` keys off it (lines 4-5, 23-31).
4. The object-URL boundary (`runtime.ts:22-30`).
5. Seed `auth_token='public-demo-session'`, `username`, `osi.display.theme`, and `osi.defaults.timezone` set to **the game timezone, not `Africa/Kampala`** (`runtime.ts:31-35`). Also call `setGatewayTimezone(sim.state.settings.gatewayTimezone)` at boot: the store defaults to Kampala (`timezone-store.ts:2`), and the runtime only syncs it after a settings PUT (`runtime.ts:125-127`).
6. The `Date` proxy reading the parent clock (`runtime.ts:40-45`). Verified, drift 0.
7. Block fetch, XHR, WebSocket, EventSource and sendBeacon; stub geolocation; clear the native bridges (`runtime.ts:78-92`).
8. Navigation guard, form notice and submit `preventDefault` (`runtime.ts:95-112`, `public-navigation.ts:8`).
9. Adapter: `createDemoAdapter({requestResponse: (m, p, b) => structuredClone(bridge.request(m, p, b))}, onError, onResponse)`. The parent side is `sim.requestResponse(m, p, structuredClone(b))`.
   - In `onResponse`: call `requestDemoRevalidation(['*'])` for successful writes (`revalidation.ts:15-21`), and tell the game which route changed, so tutorials can react.
10. Notices (`runtime.ts:73-77`): the runtime shows `#demo-notice` only when `parent === window`, which is never true inside the game. The phone must render notices itself and may also forward them.
11. Mount with `demo/mount.tsx`, which can be imported as is (the trial did). It wraps `App` in `SWRConfig {use:[demoRevalidation]}` (`mount.tsx:39`). It posts a `time` message with a hard-coded `Africa/Kampala` (`mount.tsx:22`), which is harmless.
12. Auth subscription to `sim.setSessionUser` (`runtime.ts:266`), routed through the bridge.

### What it must not do

- Construct a `Simulator` (`runtime.ts:19`).
- Run the real-time `tick`, timer, speed or pause (`runtime.ts:134-185`).
- Apply the localhost-only guard (`runtime.ts:17`, presentation only).
- Load the guide machinery (`runtime.ts:186-260`), unless it is reused for tutorials.

### Revalidation contract

The game calls `bridge.notify()` in three cases:
- after any `advanceTo` that changed `sim.clock.revision`;
- after any game-originated REST write;
- after the farm is built.

The phone answers with one local `requestDemoRevalidation(['*'])`. Throttle this to at most once per second of real time, and to once after a sleep jump. A `'*'` revalidation refetches every mounted SWR key, and environment-summary alone costs 70-190 ms (measured).

### `check-build-isolation.mjs`

It enforces three things:
- production `build/` contains none of the public markers (`02F1`, `publicSimulator`, `osi-demo:revalidate`, `cloud.example.test`, `osi-mobile-simulator-v1`, `inert-demo-session-not-a-jwt`) and no `demo/` module paths (lines 29-36, 82-91);
- `src/` never imports a path containing `demo` (lines 93-119);
- the public artifact holds only `index.html`, `app.html` and `assets/` (lines 121-130).

farm-sim builds to its own `dist`, so it does not interact with any of these. The gaps:
- the `src/` import check does not catch `../farm-sim`;
- the workflow triggers only on `web/react-gui/**` (`.github/workflows/public-simulator.yml`).

Proposals: extend the regex to `(demo|farm-sim)`, and add a farm-sim workflow with typecheck, build and a headless smoke like `smoke.cjs`.

---

## 8. Minimal changes inside `web/react-gui`

**Zero changes are needed** for the farm, readings, water-out, clock, epoch and phone build (Option Z, proven).

**One small commit in `demo/` is needed** for two things:
- game weather/ET0: there is no zero-hook path (section 5);
- the time-zone perf fix: nights about 10-75× faster.

The same commit adds the cleaner `readingSource` and `fictionalHistory` options. Nothing in `src/` changes.

Size: 3 files, +63 / −19 lines. Typecheck green; 203/203 in 16 demo test files (same as the head). Full diff: scratchpad `research/hook-commit.diff`. Key hunks:

```diff
--- a/web/react-gui/demo/model.ts
+++ b/web/react-gui/demo/model.ts
-import {applyDendroBaseline, ReadingLedger, sampleIntervalMs, type ReadingValues} from './model/readings';
+import {applyDendroBaseline, ReadingLedger, sampleIntervalMs, type ReadingSource, type ReadingValues} from './model/readings';
-import {buildEnvironmentSummary, hasValidWeatherLocation, seedCompletedEnvironmentRecords, selectedWeatherProvider} from './model/environment';
+import {buildEnvironmentSummary, hasValidWeatherLocation, seedCompletedEnvironmentRecords, selectedWeatherProvider, setWeatherSource, type WeatherSource} from './model/environment';
+const dateFormatters = new Map<string, Intl.DateTimeFormat>();
 function localCalendarDate(at: number, timezone: string): string {
-  return new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(at));
+  let format = dateFormatters.get(timezone);
+  if (!format) { format = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}); dateFormatters.set(timezone, format); }
+  return format.format(new Date(at));
 }
+const dayStartCache = new Map<string, number>();
 function localCalendarDayStart(localDate: string, timezone: string): number {
+  const key = `${timezone}|${localDate}`, cached = dayStartCache.get(key);
+  if (cached !== undefined) return cached;
+  const value = uncachedLocalCalendarDayStart(localDate, timezone);
+  if (dayStartCache.size >= 1024) dayStartCache.delete(dayStartCache.keys().next().value!);
+  dayStartCache.set(key, value);
+  return value;
+}
+function uncachedLocalCalendarDayStart(localDate: string, timezone: string): number {
+export type SimulatorOptions = {
+  mode?: SimulatorMode;
+  /** Public mode: replaces the synthetic uplink values; the simulator still owns flow integration and daily totals. */
+  readingSource?: ReadingSource;
+  /** Public mode: false starts with no fictional 90-day history and gives new devices none. Default true. */
+  fictionalHistory?: boolean;
+  /** Public mode: replaces the illustrative daily weather series for ET0, demand and forecast. */
+  weatherSource?: WeatherSource;
+};
-  constructor(options: {mode?: SimulatorMode} = {}) {
+  private readonly readingOptions: {source?: ReadingSource; fictionalHistory?: boolean};
+  constructor(options: SimulatorOptions = {}) {
     this.mode = options.mode ?? 'presentation';
+    this.readingOptions = {source: options.readingSource, fictionalHistory: options.fictionalHistory};
+    setWeatherSource(options.weatherSource ?? null);
-    this.readings = new ReadingLedger(this.state.devices, this.mode === 'public');
+    this.readings = new ReadingLedger(this.state.devices, this.mode === 'public', this.readingOptions);
   (same change in reset())
--- a/web/react-gui/demo/model/readings.ts
+++ b/web/react-gui/demo/model/readings.ts
+export type ReadingSource = (device: Device, at: number, synthetic: () => ReadingValues) => ReadingValues;
+export type ReadingLedgerOptions = {source?: ReadingSource; fictionalHistory?: boolean};
-  constructor(devices: Device[], public readonly enabled: boolean) {
-    if (enabled) this.seed(devices);
+  private readonly source?: ReadingSource;
+  private readonly fictionalHistory: boolean;
+  constructor(devices: Device[], public readonly enabled: boolean, options: ReadingLedgerOptions = {}) {
+    this.source = options.source;
+    this.fictionalHistory = options.fictionalHistory ?? true;
+    if (enabled && this.fictionalHistory) this.seed(devices);
   seedNewDevice(device: Device, createdAt: number): void {
+    if (!this.fictionalHistory) {
+      this.append(device.deveui, createdAt, this.source ? this.sampleValues(device, createdAt) : {...device.latest_data}, 'synthetic');
+      return;
+    }
   sampleValues(device: Device, at: number): ReadingValues {
+    if (this.source) return this.convertWatermark(device.deveui, {...this.source(device, at, () => deviceValues(device, at))}, at);
-    if (deliveredLiters <= 0) return;
+    if (deliveredLiters <= 0 || this.source) return;
-    const copy = new ReadingLedger([], false);
+    const copy = new ReadingLedger([], false, {source: this.source, fictionalHistory: this.fictionalHistory});
--- a/web/react-gui/demo/model/environment.ts
+++ b/web/react-gui/demo/model/environment.ts
+export type DailyWeatherInput = {et0: number; rain: number; maxTemp: number; meanRhPct?: number; windSpeedMps?: number;
+  et0Source?: string; et0Tier?: string};
+export type WeatherSource = (date: string, zone: IrrigationZone) => DailyWeatherInput | null;
+let weatherSource: WeatherSource | null = null;
+export function setWeatherSource(source: WeatherSource | null): void { weatherSource = source; }
-function weather(date: string, provider: 'open_meteo' | 'meteoswiss' | null) {
+function weather(date: string, provider: 'open_meteo' | 'meteoswiss' | null, zone?: IrrigationZone): DailyWeatherInput | null {
   if (!provider) return null;
+  if (weatherSource && zone) return weatherSource(date, zone);
-  const input = weather(date, provider);
+  const input = weather(date, provider, zone);
-    air_temperature_c: input?.maxTemp ?? null, relative_humidity_pct: input ? 62 : null,
-    et0_source: provider ? `${provider}_hourly_sum` : null, et0_tier: provider ? 'provider_hourly_sum' : null,
+    air_temperature_c: input?.maxTemp ?? null, relative_humidity_pct: input ? input.meanRhPct ?? 62 : null,
+    et0_source: input ? input.et0Source ?? `${provider}_hourly_sum` : null, et0_tier: input ? input.et0Tier ?? 'provider_hourly_sum' : null,
-  const currentWeather = provider ? weather(currentDate, provider) : null;
+  const currentWeather = provider ? weather(currentDate, provider, zone) : null;
-        relativeHumidityPct: 62, pressureHpa: null, windSpeedMps: 1.1, windDirectionDeg: null,
+        relativeHumidityPct: currentWeather.meanRhPct ?? 62, pressureHpa: null, windSpeedMps: currentWeather.windSpeedMps ?? 1.1, windDirectionDeg: null,
-    const daily = weather(date, provider)!;
+    const daily = weather(date, provider, zone)!;
-    return {time: iso(at), rainMm: wet ? 0.4 : 0, rainProbabilityPct: wet ? 45 : 8,
-      tempC: round(daily.maxTemp - Math.abs(hour - 14) * 0.35), windSpeedMps: 1.1};
+    return {time: iso(at), rainMm: wet ? round(daily.rain / 4) : 0, rainProbabilityPct: wet ? 45 : 8,
+      tempC: round(daily.maxTemp - Math.abs(hour - 14) * 0.35), windSpeedMps: daily.windSpeedMps ?? 1.1};
```

Notes on the commit:
- `setWeatherSource` is per realm, and the last-constructed `Simulator` wins. Headless tests that build several simulators must construct them sequentially; a source on the `SimulatorState` would avoid this but needs `history.ts` and `analysis.ts` port changes. <!-- slop-allow: "realm" is the ECMAScript term for a JS global environment -->
- An optional `startAt` option could replace the `clock.reset` workaround in section 6. It is not needed.

**Lives entirely in `web/farm-sim`:**
- game engine and physics;
- farm builder (the REST recipe);
- `OsiWaterTap`;
- the weather source using `et0.js`;
- the parent-side `osiPhoneBridge`;
- phone `bootstrap.ts`, `runtime.ts` and `index.html`;
- Vite config and its own CI;
- the replay log;
- tutorials.

---

## 9. Honesty ledger (what the game may label as "OSI")

| Output | Status | Evidence |
|---|---|---|
| 06:00 legacy SWT/DENDRO trigger decision | Port pinned by port tests | `PRODUCTION-HOOKS.md` "Source-backed behavior notes"; `controller-semantics.md` "Automatic irrigation" |
| Timed opens, cancel, weekly and one-time plans | Ports pinned by tests (`osi-valve-control` plan.js/api.js/cancel.js) | `controller-semantics.md`; `demo/tests/irrigation.test.ts`, `plans.test.ts` |
| Kc | Real: the GUI copy of `osi-crop-kc` with the same contract vectors | `src/agronomy/cropKc.ts:4` |
| Water action (`resolveWaterAction`) | Port, **missing the rain-unknown branch** | `water-action.ts:9-26` vs edge `osi-zone-env/index.js:947-985` |
| ET0, ETc demand, daily forecast rain total, online RH and wind | **Illustrative** today; game-driven and real once the hook plus `fao56Et0` are used | `environment.ts:43-54,77-87,223-225` |
| Agronomic current block (RH 62, VPD 1.1, dew point 17, THI 67, heat index), hourly forecast shape, rain probability, forecast min temp | **Illustrative even after the minimal hook** | `environment.ts:226-229,246-250,259-260` |
| Daily water balance feeding the water action (net = L × eff / area; total = rain + net; balance = total − demand) | Simulator arithmetic; **parity with `osi-zone-env` not checked** | `model.ts:32-35,443-460`; `environment.ts:146-152,217-218` |
| Post-irrigation soil response | **Synthetic** (disabled by `readingSource` in the hook) | `readings.ts:272-279`, `model.ts:352-364` |
| "Measured" flow | Duration × configured rate, not physics | `model.ts:385-387` |
| ACK delay of 2 s, 5 s identify/reboot | Demo constants | `controller-semantics.md` "Clock and seed" |
| Conditional irrigation policy (`osi-irrigation-policy`) | **Not available**: 503 `qualification_unavailable` | `model.ts:1053-1066` |

---

## 10. Reproducing the measurements

For shared-`/tmp` quota, the patched scratch tree (`patched/react-gui/{src,demo}`) and the build outputs (`patched/farm-sim/dist*`) were deleted after use. What remains:
- the scripts in `<scratch>/bench/`;
- the trial config in `.../scratchpad/patched/farm-sim/`;
- the diff in `.../scratchpad/research/hook-commit.diff`.

`closed-loop.ts` and `closed-loop-2.ts` run against the repo head as is:

```
cd <repo>/web/react-gui && ./node_modules/.bin/tsx <scratchpad>/bench/closed-loop.ts
```

To re-run the hook measurements (`closed-loop-hooks.ts`, `bench2p.ts`, the farm-sim build and `smoke.cjs`), recreate the tree:
1. Copy `web/react-gui/{src,demo,public,tsconfig.json,tsconfig.node.json,tailwind.config.js,postcss.config.js,index.html}` to `<scratchpad>/patched/react-gui/`.
2. Symlink `node_modules`.
3. Apply `hook-commit.diff` with `patch -p3`; the paths start `a/web/react-gui/`.
4. Symlink `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/{flows.json,node-red}` into `<scratchpad>/conf/...` for the port tests.
5. Run `react-gui/node_modules/.bin/vite build --config ../farm-sim/vite.config.mjs` from `patched/react-gui`.
6. Serve `farm-sim/dist` and run `node smoke.cjs http://127.0.0.1:<port>`.

## 11. Open questions for the owner

- May the demo hook commit land on PR #658, or must it be a follow-up PR after #658 merges?
- Should the game start at the fixed `PUBLIC_EPOCH` (2026-10-10) or at its own season date? The latter uses the `clock.reset` workaround or an added `startAt` option.
- Game time vs agronomic time: FAO stage lengths are in days. A compressed game season would break Kc curves and the once-a-day trigger cadence unless one game day equals one simulated day.
- The fixture coordinates (Kampala) and `Africa/Kampala` defaults are real-world values. Which fictional coordinates and which no-DST IANA zone should the fictional region use?
- Should the phone keep the provider name (`open_meteo`) on game weather, or should the copy read only "Weather data"?


## Appendix A: full hook-commit diff (verbatim `diff -u` against `4682fb17b1`)

```diff
--- a/web/react-gui/demo/model.ts
+++ b/web/react-gui/demo/model.ts
@@ -4,7 +4,7 @@
 import type { IrrigationActuation, UpdateSystemSettingsRequest } from '../src/services/api';
 import { DEMO_EPOCH, PUBLIC_EPOCH, VALVE_EUI, SPARE_EUI, environmentFixture, iso } from './fixtures';
 import {SimulationClock, MAX_JUMP_MS} from './model/clock';
-import {applyDendroBaseline, ReadingLedger, sampleIntervalMs, type ReadingValues} from './model/readings';
+import {applyDendroBaseline, ReadingLedger, sampleIntervalMs, type ReadingSource, type ReadingValues} from './model/readings';
 import {SimulatorState, makeDevice, type SimulatorMode, type ActiveCommand} from './model/state';
 import {configureZone, createZone, deleteZone, normalizedName, renameZone} from './model/farm';
 import {createDevice, DEVICE_CATALOG} from './model/devices';
@@ -23,7 +23,7 @@
 import {createJournalState, handleJournalRoute, type JournalState} from './model/journal';
 import {handleAnalysisRoute} from './model/analysis';
 import {handleHistoryRoute} from './model/history';
-import {buildEnvironmentSummary, hasValidWeatherLocation, seedCompletedEnvironmentRecords, selectedWeatherProvider} from './model/environment';
+import {buildEnvironmentSummary, hasValidWeatherLocation, seedCompletedEnvironmentRecords, selectedWeatherProvider, setWeatherSource, type WeatherSource} from './model/environment';
 import {resolveWaterAction} from './model/water-action';
 import {handleNetworkRoute} from './model/network';
 export { DEMO_EPOCH, PUBLIC_EPOCH, VALVE_EUI, SPARE_EUI };
@@ -60,14 +60,26 @@
 function localDayStart(at: number, timezone: string): number {
   return localCalendarDayStart(localCalendarDate(at, timezone), timezone);
 }
+const dateFormatters = new Map<string, Intl.DateTimeFormat>();
 function localCalendarDate(at: number, timezone: string): string {
-  return new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date(at));
+  let format = dateFormatters.get(timezone);
+  if (!format) { format = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}); dateFormatters.set(timezone, format); }
+  return format.format(new Date(at));
 }
 function shiftCalendarDate(date: string, days: number): string {
   const [year, month, day] = date.split('-').map(Number);
   return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
 }
+const dayStartCache = new Map<string, number>();
 function localCalendarDayStart(localDate: string, timezone: string): number {
+  const key = `${timezone}|${localDate}`, cached = dayStartCache.get(key);
+  if (cached !== undefined) return cached;
+  const value = uncachedLocalCalendarDayStart(localDate, timezone);
+  if (dayStartCache.size >= 1024) dayStartCache.delete(dayStartCache.keys().next().value!);
+  dayStartCache.set(key, value);
+  return value;
+}
+function uncachedLocalCalendarDayStart(localDate: string, timezone: string): number {
   const start = Date.parse(`${localDate}T00:00:00Z`) - 18 * 60 * 60 * 1000;
   const format = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
   for (let time = start; time <= start + 48 * 60 * 60 * 1000; time += 60000) {
@@ -81,6 +93,15 @@
   const result = normalizeEntityName(value);
   return result.ok ? result.name : fail(400, result.reason);
 }
+export type SimulatorOptions = {
+  mode?: SimulatorMode;
+  /** Public mode: replaces the synthetic uplink values; the simulator still owns flow integration and daily totals. */
+  readingSource?: ReadingSource;
+  /** Public mode: false starts with no fictional 90-day history and gives new devices none. Default true. */
+  fictionalHistory?: boolean;
+  /** Public mode: replaces the illustrative daily weather series for ET0, demand and forecast. */
+  weatherSource?: WeatherSource;
+};
 export class Simulator {
   active = true;
   speed = 1;
@@ -96,14 +117,17 @@
   private completedEnvironmentKeys = new Map<number, string>();
   private presentationWaterSeed = new Map<string, {rain_mm_today?: number | null; flow_liters_today?: number | null}>();
   onDailyTrigger?: (at: number) => void;
-  constructor(options: {mode?: SimulatorMode} = {}) {
+  private readonly readingOptions: {source?: ReadingSource; fictionalHistory?: boolean};
+  constructor(options: SimulatorOptions = {}) {
     this.mode = options.mode ?? 'presentation';
+    this.readingOptions = {source: options.readingSource, fictionalHistory: options.fictionalHistory};
+    setWeatherSource(options.weatherSource ?? null);
     this.state = new SimulatorState(this.mode);
     if (this.mode === 'presentation') for (const device of this.state.devices) {
       this.presentationWaterSeed.set(device.deveui, {rain_mm_today: device.latest_data.rain_mm_today, flow_liters_today: device.latest_data.flow_liters_today});
     }
     this.clock = new SimulationClock(this.state.now);
-    this.readings = new ReadingLedger(this.state.devices, this.mode === 'public');
+    this.readings = new ReadingLedger(this.state.devices, this.mode === 'public', this.readingOptions);
     this.refreshCompletedEnvironmentRecords();
     if (this.mode === 'public') this.syncSeedSnapshots();
     if (this.mode === 'public') {
@@ -312,7 +336,7 @@
     this.state = new SimulatorState(this.mode);
     this.journal = createJournalState();
     this.clock.reset(this.state.now);
-    this.readings = new ReadingLedger(this.devices, this.mode === 'public');
+    this.readings = new ReadingLedger(this.devices, this.mode === 'public', this.readingOptions);
     this.completedEnvironmentKeys.clear();
     this.refreshCompletedEnvironmentRecords();
     if (this.mode === 'public') this.syncSeedSnapshots();
--- a/web/react-gui/demo/model/readings.ts
+++ b/web/react-gui/demo/model/readings.ts
@@ -4,6 +4,9 @@

 export type ReadingValues = Record<string, unknown>;
 export type ReadingSample = {deviceEui: string; at: number; values: ReadingValues; source: 'seed' | 'fictional-history' | 'synthetic' | 'observed-flow'};
+/** Supplies a device's uplink values at a simulated instant (for example from an external soil and weather model). */
+export type ReadingSource = (device: Device, at: number, synthetic: () => ReadingValues) => ReadingValues;
+export type ReadingLedgerOptions = {source?: ReadingSource; fictionalHistory?: boolean};

 const INTERVAL_MS = 30 * 60 * 1000;
 const round = (n: number) => Number(n.toFixed(2));
@@ -151,8 +154,12 @@
   private sampleIndexes = new Map<string, Map<number, number>>();
   private soilResponse = new Map<string, number>();
   private watermarkCalibration = new Map<string, Record<string, number>>();
-  constructor(devices: Device[], public readonly enabled: boolean) {
-    if (enabled) this.seed(devices);
+  private readonly source?: ReadingSource;
+  private readonly fictionalHistory: boolean;
+  constructor(devices: Device[], public readonly enabled: boolean, options: ReadingLedgerOptions = {}) {
+    this.source = options.source;
+    this.fictionalHistory = options.fictionalHistory ?? true;
+    if (enabled && this.fictionalHistory) this.seed(devices);
   }

   private seed(devices: Device[]): void {
@@ -172,6 +179,10 @@
   }

   seedNewDevice(device: Device, createdAt: number): void {
+    if (!this.fictionalHistory) {
+      this.append(device.deveui, createdAt, this.source ? this.sampleValues(device, createdAt) : {...device.latest_data}, 'synthetic');
+      return;
+    }
     const start = createdAt - 90 * 24 * 60 * 60 * 1000;
     for (let at = start; at < createdAt; at += INTERVAL_MS) {
       this.append(device.deveui, at, this.convertWatermark(device.deveui, deviceValues(device, at), at), 'fictional-history');
@@ -230,6 +241,7 @@
   }

   sampleValues(device: Device, at: number): ReadingValues {
+    if (this.source) return this.convertWatermark(device.deveui, {...this.source(device, at, () => deviceValues(device, at))}, at);
     const values = deviceValues(device, at), response = this.soilResponse.get(device.deveui) ?? 0;
     for (const field of ['swt_1', 'swt_2', 'swt_3']) {
       if (typeof values[field] === 'number') values[field] = round(Math.max(0, values[field]! - response));
@@ -270,7 +282,7 @@
   }

   applySoilResponse(deviceEui: string, at: number, deliveredLiters: number, device: Device): void {
-    if (deliveredLiters <= 0) return;
+    if (deliveredLiters <= 0 || this.source) return;
     const response = Math.min(18, (this.soilResponse.get(deviceEui) ?? 0) + deliveredLiters / 100 * 0.85 * 1.5);
     this.soilResponse.set(deviceEui, response);
     const values = this.sampleValues(device, at);
@@ -284,7 +296,7 @@

   clear(): void { this.samples.clear(); this.sampleIndexes.clear(); }
   clone(): ReadingLedger {
-    const copy = new ReadingLedger([], false);
+    const copy = new ReadingLedger([], false, {source: this.source, fictionalHistory: this.fictionalHistory});
     for (const [eui, samples] of this.samples) for (const sample of samples) copy.append(eui, sample.at, sample.values, sample.source);
     copy.soilResponse = new Map(this.soilResponse);
     copy.watermarkCalibration = new Map(this.watermarkCalibration);
--- a/web/react-gui/demo/model/environment.ts
+++ b/web/react-gui/demo/model/environment.ts
@@ -40,9 +40,18 @@
     && Math.abs(Number(zone.latitude)) <= 90 && Math.abs(Number(zone.longitude)) <= 180;
 }

-function weather(date: string, provider: 'open_meteo' | 'meteoswiss' | null) {
+/** Daily weather input for one zone and local date. `et0` must come from a real ET0 calculation. */
+export type DailyWeatherInput = {et0: number; rain: number; maxTemp: number; meanRhPct?: number; windSpeedMps?: number;
+  et0Source?: string; et0Tier?: string};
+export type WeatherSource = (date: string, zone: IrrigationZone) => DailyWeatherInput | null;
+let weatherSource: WeatherSource | null = null;
+/** Replace the illustrative daily series (null restores it). One source per JavaScript realm. */
+export function setWeatherSource(source: WeatherSource | null): void { weatherSource = source; }
+
+function weather(date: string, provider: 'open_meteo' | 'meteoswiss' | null, zone?: IrrigationZone): DailyWeatherInput | null {
   const dayNumber = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
   if (!provider) return null;
+  if (weatherSource && zone) return weatherSource(date, zone);
   // These are date-keyed fictional provider input records. Provider modes use
   // distinct deterministic fixture series; they never claim fetched data.
   const et0 = round(Math.max(1.2, provider === 'meteoswiss'
@@ -62,7 +71,7 @@
   if (existing && date < today && (!hasValidWeatherLocation(zone) || selectedWeatherProvider(zone) === null)) return structuredClone(existing);
   const hasLocation = hasValidWeatherLocation(zone);
   const provider = hasLocation ? selectedWeatherProvider(zone) : null;
-  const input = weather(date, provider);
+  const input = weather(date, provider, zone);
   const kc = input ? cropCoefficient(zone, date) : null;
   const dayStart = localMidnight(date, timezone), dayEnd = localMidnight(shiftDate(date, 1), timezone);
   const firstUtcHour = Math.floor(dayStart / 3600000) * 3600000;
@@ -77,8 +86,8 @@
   const record: RetainedEnvironmentRecord = {date, provider, timezone, sampleAt: date < today ? dayStart + 12 * 3600000 : Math.min(now, dayStart + 12 * 3600000),
     dayStart, dayEnd, hourly, values: {et0_mm: input?.et0 ?? null,
     etc_mm: input && kc ? round(input.et0 * kc.kc) : null, forecast_rain_mm: input?.rain ?? null,
-    air_temperature_c: input?.maxTemp ?? null, relative_humidity_pct: input ? 62 : null,
-    et0_source: provider ? `${provider}_hourly_sum` : null, et0_tier: provider ? 'provider_hourly_sum' : null,
+    air_temperature_c: input?.maxTemp ?? null, relative_humidity_pct: input ? input.meanRhPct ?? 62 : null,
+    et0_source: input ? input.et0Source ?? `${provider}_hourly_sum` : null, et0_tier: input ? input.et0Tier ?? 'provider_hourly_sum' : null,
     location_key: locationKey, source_provider: provider, source_captured_at: iso(now),
     hours_present: hourly.length, expected_hours: expectedHours, coverage_pct: provider && expectedHours > 0 ? 100 : null,
     null_reason: provider ? null : hasLocation ? 'no_source' : 'no_location'}, provenance: {cropType: zone.crop_type ?? null,
@@ -201,7 +210,7 @@
   const {days, currentDate} = syntheticDays(zone, measuredDays, now, timezone, retained);
   const current = days.find(day => day.date === currentDate)!;
   const provider = hasIllustrativeWeatherSource(zone) ? selectedWeatherProvider(zone) : null;
-  const currentWeather = provider ? weather(currentDate, provider) : null;
+  const currentWeather = provider ? weather(currentDate, provider, zone) : null;
   const fullForecast = buildForecast(zone, currentDate, now, timezone, provider, retained);
   const forecast = fullForecast ? {...fullForecast, hourly: fullForecast.hourly.filter(row => {
     const at = Date.parse(row.time); return at >= now && at < now + 24 * 3600000;
@@ -221,7 +230,7 @@
       cacheStatus: availability ? 'live' : 'miss', observedAt: availability ? iso(now) : null,
       expiresAt: availability ? iso(now + 15 * 60_000) : null,
       current: availability && currentWeather ? {description: 'Weather conditions', weatherCode: null, airTemperatureC: currentWeather.maxTemp,
-        relativeHumidityPct: 62, pressureHpa: null, windSpeedMps: 1.1, windDirectionDeg: null,
+        relativeHumidityPct: currentWeather.meanRhPct ?? 62, pressureHpa: null, windSpeedMps: currentWeather.windSpeedMps ?? 1.1, windDirectionDeg: null,
         cloudCoverPct: null, rainMm: currentWeather.rain, precipitationProbabilityPct: currentWeather.rain > 0 ? 40 : 10} : null},
     agronomic: {...base.agronomic, preferredSource: availability ? `Illustrative ${provider}` : 'unavailable', current: availability && currentWeather ? {thermodynamicSource: 'illustrative',
       evapotranspirationSource: 'Weather data', cropCoefficientSource: 'Crop coefficient',
@@ -241,13 +250,13 @@
   const hourly = Array.from({length: 72}, (_, index) => {
     const at = firstHour + index * 3600000;
     const date = localDateKey(at, timezone), hour = new Date(at).getUTCHours();
-    const daily = weather(date, provider)!;
+    const daily = weather(date, provider, zone)!;
     const dayNumber = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
     const rainStartHour = (dayNumber + (provider === 'meteoswiss' ? 5 : 0)) % 24;
     const rainOffset = (hour - rainStartHour + 24) % 24;
     const wet = daily.rain > 0 && rainOffset < 4;
-    return {time: iso(at), rainMm: wet ? 0.4 : 0, rainProbabilityPct: wet ? 45 : 8,
-      tempC: round(daily.maxTemp - Math.abs(hour - 14) * 0.35), windSpeedMps: 1.1};
+    return {time: iso(at), rainMm: wet ? round(daily.rain / 4) : 0, rainProbabilityPct: wet ? 45 : 8,
+      tempC: round(daily.maxTemp - Math.abs(hour - 14) * 0.35), windSpeedMps: daily.windSpeedMps ?? 1.1};
   });
   const daily = [0, 1, 2].map(offset => {
     const date = shiftDate(currentDate, offset);
```
