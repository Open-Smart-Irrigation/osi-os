# Cross-check of the farming-sim research pass

Critic report, 2026-11-23. Worktree `4682fb17b1` (PR #658 head). I read these six reports in full: sim-integration, osi-tiers, agronomy, tech, game-design and art-direction. Paths are relative to the worktree root. `EDGE` = `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red`, `SIM` = `web/react-gui/demo`.

Each spot-check verdict is one of **VERIFIED**, **REFUTED**, **PARTLY** or **UNRESOLVED**, with the evidence I used myself.

## 0. Headline

Tier 2 ("decision support / know the demand") is where the reports disagree. More importantly, it is where **the simulator disagrees with the edge**.

- **T1, T3 and T4 can be honest in a vertical slice** once readings come from the game soil model. That works today with zero hooks; I re-ran it.
- **T4 caveat.** The busy-valve skip and the English advisory sentences are simulator behaviour, not edge behaviour. Do not label them "OSI".
- **T2 is blocked as an "OSI recommendation"** until three parity gaps are fixed upstream or avoided in the slice:
  1. **No flow meter.** The edge treats missing flow as 0 L. It still computes a balance and can say `irrigate_today`. The simulator returns `balance_unknown`.
  2. **Empty tank.** The simulator's "measured" flow always equals valve time × configured rate. It overwrites any flow value the game supplies. The phone would show litres that were never delivered.
  3. **Rain unknown.** The simulator lacks the edge's `rain_unknown` branch. Separately, the ET0 composition the reports propose for "today" (daily FAO-56 PM on game weather) is not one of the edge's shipped ET0 tiers.

## 1. Contradictions between reports

### 1.1 Tier ladder vs what the code executes

| Topic | Positions | Resolution |
|---|---|---|
| What T2 is | **osi-tiers §2:** T2 = `resolveWaterAction` verdict (water balance plus forecast); `osi-irrigation-policy` is unqualified research. **agronomy §6 item 2:** "Tier 2: the OSI recommendation, using the 06:00 SWT trigger port and `osi-irrigation-policy`"; "Tier 3: automation using timed valve opens and weekly plans". **game-design §6.2:** T2 = ET0/ETc information, T3 = valve, T4 = trigger, optional T5 = conditional policy. | Agronomy is wrong on two counts. (a) The 06:00 trigger is automation; it opens a valve, it is not advice. (b) `osi-irrigation-policy` is refused with 503 `qualification_unavailable` in the simulator (`SIM/model.ts:1053-1066`, per sim-integration and osi-tiers). Adopt the osi-tiers ladder: T0 none, T1 monitoring, T2 water verdict, T3 remote valve, T4 06:00 trigger, R research (omitted). |
| Is T2's verdict "real OSI"? | **game-design §5.2:** the "Action" tile is "simulated sensor advice", so hide it or never call it OSI. **osi-tiers / sim-integration:** it is a port of `osi-zone-env::resolveWaterAction`, missing one branch. | Both are partly right. The verdict logic is a port (`SIM/model/water-action.ts`). The "Simulated sensor advice" label is demo copy, applied in every demo mode (`SIM/i18n.ts:33-34` sets `water.drivenByBalance = WATER_COPY[...].advice`; `SIM/water-copy.ts:3`). With game readings and real ET0 the label stays accurate ("simulated" sensors), but the verdict differs from the edge in the cases in §0. Decision for the owner: §4 D3. |
| T2 prerequisites | **game-design:** T2 = T1 + weather station + crop/stage, with no flow meter. **osi-tiers §3:** T2 needs a rain source, a **flow meter** for irrigation credit, a forecast, zone area/efficiency/lat-lon, and no soil probe. **sim-integration §2:** no meter gives `balance_unknown`. | game-design omits the flow meter (LSN50 MOD9) and the zone area/efficiency. In the simulator, the weather station is only a rain source and local current T/RH. It plays no part in the ET0 for "today" (see 1.2). |
| T4 "busy valve" skip | **game-design §5.2 / §6.2:** "skips a busy valve" is part of the faithful port. **osi-tiers §2:** simulator-only. | osi-tiers is right. The edge decision node "Decide + build actuator cmd" (function) has no valve-state check: 0 matches for `current_state` or `busy` in its `func`, which I checked with node. `SIM/controller-semantics.md:99` calls the one-owner rule "an illustrative model rule, not physical overlap parity". |
| Tier 1 "advice" | **agronomy:** Tier 1 shows the 20/50 kPa colours. **osi-tiers:** the colours are display categories, not advice. | No conflict. Note that art-direction's world soil bands differ (1.4). |

### 1.2 ET0 for "today": three incompatible plans

- **sim-integration §5.** A `WeatherSource` hook supplies daily `fao56Et0` for today and forecast days, labelled `fao56_daily_game_weather`.
- **game-design §4.5 / §6.2.** ET0 comes from `et0.js` on an in-world station's **hourly** aggregates, i.e. the station tier, and the forecast is a labelled world input.
- **osi-tiers §2.** The shipped edge takes **today's** ET0 from the provider forecast day. The station and Hargreaves tiers fill only **completed** days (`osi-agronomy-daily/index.js:179 resolveDay`). Daily `fao56Et0` is exported but used by none of the three tiers.
  - VERIFIED: `grep fao56Et0( EDGE/osi-agronomy-daily/index.js` returns nothing.
- **agronomy.** Calls daily `fao56Et0` and verified the numbers (see 2.3).

Reconciliation. The simulator does not run `osi-agronomy-daily` at all, so game-design's station-tier plan has nothing in the simulator to plug into. The honest options are:
- (a) the game weather acts as an external provider, and the daily `fao56Et0` maths is disclosed as "OSI's FAO-56 code on game weather, a composition the product does not ship for today"; or
- (b) port the station tier and run it only for past days.

This is an owner-level labelling decision (§4 D3).

### 1.3 Engine, rendering and UI

| Topic | tech | art-direction | game-design | Resolution |
|---|---|---|---|---|
| Tile size | 16 px, 480×270 logical | **16×16**, 480×270, character cell 24×32 | **24×24**, "a deliberate choice that differs from the 16×16 common in the genre" | Use 16×16. The art pipeline, P0 asset list and perf budget are all sized for it. The originality argument is weak: tile size is a genre convention, not a protected look. Originality comes from palette, setting, UI and characters. A team decision, not an owner one. |
| Renderer | PixiJS 8.23, `['webgl']`, own GLSL composite pass, albedo × light + LUT | Custom WebGL2 with a palette-index **G-buffer** and a ramp-table lookup; asks the owner "custom vs PixiJS" | "2D canvas or WebGL with a canvas fallback" | Compatible if Pixi is the scene graph and atlas host and art's ramp-step resolve is a custom Pixi filter. But tech's atlas is RGBA albedo plus a normals page, while art's atlas stores palette index, height, flags and ramp id. Choose one atlas format before writing any shader. Recommendation: art's indexed atlas inside Pixi RenderTextures. |
| Pass count / budget | ≤ 5 full-screen passes; ≤ 3 on low tier | About 10 passes plus quarter-res bloom | n/a | Contradiction. Adopt tech's budget as the gate. Art's extra passes (shadow mask, bloom) go behind the quality tiers. |
| Canvas2D fallback | Not planned (WebGL2 at 99 % of Android) | Planned, pre-baked palette variants | Planned | Drop it for the slice. Revisit only if field telemetry shows non-WebGL2 devices. |
| HUD / menus | **DOM** overlay (Preact), CSS `border-image` 9-slice; canvas only for world text | "UI: a separate low-res **canvas** layer"; bottom-left tool strip, phone button bottom-right | Tool belt on the **left edge**, water-container gauge, daylight arc | Use tech's DOM overlay; it brings accessibility, i18n and screen readers. Adopt game-design's left-edge belt: a bottom hotbar is the genre default and the brief asks for distance. Art's signboard styling applies to the DOM. |
| Atlas bake | `scripts/bake-atlas.ts` (Node), Worker at dev boot | Vite plugin, plus browser at boot | n/a | Trivial; pick one. |
| Font coverage | Latin Extended | Latin-1 plus `ŋ œ ’ – — … − ← → ≤ ≥ ≈ ₀ Ω` | n/a | Use art's list; it was derived from the shipped locales. |

### 1.4 Soil bands: world visuals vs phone

- The phone uses wet < 20, moist 20-50 and dry > 50 kPa (`src/utils/swt.ts:41-42`). The history calendar uses 22/50 (osi-tiers).
- Art-direction's world soil-colour bands are: saturated 0-8, wet 8-25, moist 25-50, dry 50-100, very dry > 100.
- So a tile at 22 kPa is drawn "wet" while the phone says "moist". Art-direction flags this risk itself (§6). Agronomy anchors field capacity at 20 kPa (§2.4), so freshly drained soil sits exactly on the phone's wet/moist edge.
- Recommendation: put the world bands on the phone's 20 and 50 kPa edges, and keep extra bands only outside them (saturated < 8, very dry > 100).
- Also: game-design's layers are 0-20 / 20-40 / 40-60 cm, while agronomy's layers are **centred** on 20/40/60 cm. A probe at 20 cm sits on game-design's layer boundary. Use agronomy's centred layers.

### 1.5 Seasons and climate

- **agronomy / art-direction.** The bimodal Kenya-type model has long rains Mar-May, a **cool** dry season Jun-Sep (the longer dry; agronomy Tmax 26.9-29.3 °C), short rains Oct-Dec and a **hot** dry season Jan-Feb (Tmax 29.3-30.6 °C).
- **game-design §3.2.** Big Rains 90 d, then "Short Dry 60 d, hot", then Small Rains 75 d, then "Long Dry 140 d, hottest and driest".
- This swaps the dry seasons: the dry season after the long rains is the long, cool one, and the short dry season after the short rains is the hot one.
- Use agronomy's monthly table (§A) as the calendar source and give the seasons fictional names.
- game-design's M1 slice is set in the "Short Dry". Under agronomy's calendar that is Jan-Feb (hot, ET0 4.8-5.2 mm/d). That is a good slice window, but rename it consistently.

### 1.6 Crops

- **Slice crop.**
  - game-design M1: tomato only.
  - art-direction: P0 crop maize, tomato P1.
  - Recommendation: tomato as the P0 crop. Irrigation, drip, valves and the price-volatility lesson all centre on it. Maize goes to P1 (its sprites are already prototyped).
- **Kale / sukuma.**
  - agronomy: maps kale to `cabbage` (crop JSON `osiKcId: "cabbage"`) and amaranth to `spinach`.
  - osi-tiers: an owner decision, because the app would then display "Cabbage".
  - game-design: notes kale is absent.
  - Owner decision §4 D5.
- **Stage lengths.**
  - Agronomy invents regional "game" stage rows. sim-integration and osi-tiers note that `resolveKc` uses only the edge `stage_lengths_days` (VERIFIED `EDGE/osi-crop-kc/index.js:55,69`), so game stages diverge from OSI's Kc ramp, which then lags or flags `stageOverrun`.
  - For the slice, use the edge rows for the game crop's hidden physiology (agronomy's "no divergence" option). Tomato dev is 40 d, which is longer than a 21-day slice.
- **"Verified crops only."** game-design says the slice uses only `verified: true` crops. The flag lives inside `stage_lengths_days`, not on the crop. Tomato's row is `verified: true` (VERIFIED).

### 1.7 Clock ownership and save/load

| Topic | game-design | tech | sim-integration |
|---|---|---|---|
| Who owns time | World events scheduled **on the simulator's `SimulationClock` queue** | Game core has its own fixed 20 Hz tick and calls `sim.advanceTo` | Game time drives `advanceTo`; the reading source **pulls** soil state at sample instants |
| Save / counterfactual | "Restart from a snapshot and seed" | `Simulator.snapshot()/restore()` is a **prerequisite**; clock callbacks are closures | Not addressed; minimal hook has no snapshot |

- VERIFIED: there is no snapshot API. `SimulationClock` stores closures (`SIM/model/clock.ts:18-30`), and `grep snapshot|restore` in `model.ts` finds only `snapshotLatestData` and `planSnapshot`.
- Recommendation: tech's model (the game's own tick) combined with sim-integration's pull model. Putting world events on the simulator queue would widen the closure-serialisation problem to the whole game.
- For the slice, **save = seed + command log, replayed headless**. sim-integration measured 30 days in 1.5-1.8 s on desktop with its memo, and tech measured 817 ms with memo plus formatter cache. A 21-day replay is therefore about 0.6-1.3 s on desktop. Phone timing is **unmeasured**; tech's 4-6× slowdown is an assumption.
- Snapshot/restore becomes necessary for full seasons (M2) and counterfactual replay (M4), not for M1.

### 1.8 Which upstream changes are needed

| Change | sim-integration | tech |
|---|---|---|
| Reading seam | Not needed: instance override works (Option Z). Optional `readingSource` in the hook commit | "No hook for external values … cannot drive what OSI measures"; seam is a prerequisite |
| Weather seam | **Required**; no zero-hook path | Not mentioned |
| Intl perf fix | `localCalendarDayStart` memo plus formatter cache in `localCalendarDate` | Same, **plus** `aggregation.ts dateParts` formatter cache |
| Snapshot/restore | Not mentioned | Prerequisite |
| Phone entry | All in `web/farm-sim`; zero files in react-gui; one Vite (react-gui's 5.4) builds both | New files in `web/react-gui/demo/game/`, a `--mode game` in `vite.demo.config.ts`, output `web/react-gui/game-phone-build/`; farm-sim on Vite 8 |

Resolutions:
- **Reading seam:** tech is refuted in practice (2.1). The hook is still cleaner, and both reports recommend it.
- **Perf:** VERIFIED that `aggregation.ts:10` builds a new `Intl.DateTimeFormat` per call. Fold tech's third fix into the hook commit.
- **Phone build:** sim-integration's approach keeps react-gui untouched and was build-tested with a headless smoke. Tech's approach adds files to react-gui but gets Vite 8 for the game. Recommendation: sim-integration's, to keep #658 small. The choice is reversible.
- **Perf numbers are unreconciled.** Unpatched 30 days: tech 74-76 s (52 ms per report, fixture farm) vs sim-integration 26 s (4.6 ms per event, 4-device farm). The farms differ (fixture devices, Kiwi `rain_mm_delta` cost) but nobody measured the cause. Re-measure both with one harness on the slice farm.

### 1.9 Timezone, coordinates, names

- **Coordinates and timezone.**
  - sim-integration: the public seed's coordinates 0.3476, 32.5825 and `Africa/Kampala` are real-world values and must be replaced (VERIFIED `SIM/model/state.ts:73-74`, `state.ts:46`, `fixtures.ts:12`).
  - art-direction §1.8: "the farm runs … in the simulator's farm timezone (Africa/Kampala)". This contradicts sim-integration.
  - agronomy: the weather site is lat -1.8, lon 37.6. That is a real NASA POWER grid point; the latitude feeds `et0.js` radiation.
  - Fix: a fictional location with the same latitude band is enough for ET0. For the zone, `Etc/GMT-3` is a no-DST UTC+3 zone without a city name. VERIFIED that the simulator accepts it: `SIM/model/preferences.ts:46-50` validates only through `Intl`, and `Etc/GMT-3` formats 03:00Z as 06 local.
  - Whether the GUI settings screen lists `Etc/GMT-3` is unverified; the game sets it over REST.
- **Names.**
  - game-design's NPC placeholders (Asha, Baraka, Neema, Joseph, Mama Rehema, Kito, Wanjiru-Lee, Halima) are real given names, some ethnically marked ("Wanjiru" is Kikuyu).
  - agronomy §5 says "no real ethnic, linguistic or place references … Swahili-like words should be checked with native speakers or avoided".
  - Art-direction proposes a different P1 NPC roster: goat-keeping elder, agro-dealer, young technician.
  - Owner decision on the naming policy (§4 D6); align the roster afterwards.

### 1.10 Smaller inconsistencies

- **game-design internal.** The M1 exit criterion says 21 days in under 45 min (about 2 min per day). The same document sets classroom day length to 4-8 min per day (84-168 min for 21 days). Fix: sleep or fast-forward skips most days, or the slice spans fewer days.
- **game-design §4.2** uses 3 min per jerrycan round trip at 100 m. **agronomy** uses 33 min (UNICEF rural average, including queueing). These are different quantities; label the in-game number as walking time only.
- **The pump.** Agronomy's ladder has hip/treadle pump flows up to 60 L/min. game-design's "1 per 20 L" pump labour is a tuning value. No conflict.
- **tech §4.1** vendors `osi-daily-scheduler/decision.js`. **REFUTED:** it does not exist. `ls EDGE | grep -i sched` gives only `osi-scheduler-mean-query`. osi-tiers and game-design both caught this.
- **osi-tiers** says "KIWI uses `swt_wm1/2` aliases". Imprecise. They are legacy read-only aliases on old rows (`src/utils/zoneSoil.ts:105-106`, `SIM/model/triggers.ts:140`), not a Kiwi field. The synthetic Kiwi emits `swt_1..3` (`SIM/model/readings.ts:17-20`).
- **game-design §5.2** calls the README's "automatic trigger execution is not simulated" line stale. **PARTLY.** The line is in the "Four-minute rehearsal" section (`SIM/README.md:44-85`), and the runtime shows that notice only when `!publicMode` (`SIM/runtime.ts:129-131`). The "Real functionality" table row at `README.md:129` ("no scheduler execution") does read stale for public mode.

## 2. Spot-checks of claims

| # | Claim (report) | Verdict | Evidence |
|---|---|---|---|
| 2.1 | Zero-hook closed loop works: game readings via instance override, litres equal, deterministic (sim-integration §0) | **VERIFIED** | Re-ran `scratchpad/bench/closed-loop.ts` on the unpatched head. The trigger fired 10/10 evaluations, sim litres equal game litres for all runs, and `deterministic=true` held with and without a meter. This refutes tech §1.3 "cannot drive what OSI measures". |
| 2.2 | Without a flow meter the simulator answers `insufficient_data / balance_unknown` (sim-integration §2) | **VERIFIED**, but it is a **simulator divergence** | Same run: `meterInZone1=false` gives `{code:null, reasonCode:'balance_unknown'}`. Simulator: `liters = flow ? aggregate(...) : null` (`SIM/model.ts:453`) leads to `net = null` (`SIM/model/environment.ts:151`). Edge `zone-env-fn`: `irrigationTodayMeasuredLiters = ZE.round(todayEnvironment ? todayEnvironment.flow_liters : 0, 2) \|\| 0`, then `toEffectiveIrrigationMm(0, area, eff)` gives `0` (`EDGE/osi-zone-env/index.js:786-791`), so the balance is computed. osi-tiers' statement of edge behaviour is correct. sim-integration's "lesson for the sensor-only tier" would teach non-OSI behaviour. |
| 2.3 | Agronomy ET0 table is the output of real `et0.js` | **VERIFIED** | `fao56Et0({tMinC:15.6,tMaxC:29.3,meanRhPct:64,windSpeedMs:1.54,windHeightM:2,solarRadMjM2:23.3,elevationM:1233,latDeg:-1.8,dayOfYear:15})` returns **4.78**, matching Jan. Jul returns 3.53 vs 3.54 reported, a day-of-year choice, not an error. |
| 2.4 | Voi normals: 555 mm/yr, 58 rain days, monthly 34/29/79/100/30/6/3/8/15/26/106/119 (agronomy §1.1) | **VERIFIED** | https://en.wikipedia.org/wiki/Voi (WMO), fetched. |
| 2.5 | FAO indicative application efficiency: surface 60 %, sprinkler 75 %, drip 90 % (agronomy, game-design) | **VERIFIED** | https://www.fao.org/4/t7202e/t7202e08.htm, Table 8. Agronomy cites `t7202e06.htm` for the same values; game-design's `e08` is the page that holds Table 8. |
| 2.6 | crop-kc.json has 136 crops, including maize, sorghum, millet, green_gram, dry_bean, tomato, onion, cabbage, sweet_potato and spinach; no kale, cowpea or amaranth; Kc values as tabled | **VERIFIED** | node over `EDGE/osi-crop-kc/crop-kc.json`: n = 136; the Kc and stage rows match osi-tiers §6 and agronomy §3.1; kale, cowpea and amaranth are missing. |
| 2.7 | `resolveKc` reads only `stage_lengths_days`, not the alternatives (osi-tiers) | **VERIFIED** | `EDGE/osi-crop-kc/index.js:55,69`. |
| 2.8 | Synthetic Kiwi emits no `bat_pct` (game-design §6.3) and does emit `rain_mm_delta: 0` (sim-integration §3) | **VERIFIED** (both) | `SIM/model/readings.ts:15-21`. `bat_pct` appears for LSN50 (`:53`), UC512 and the field tester (`:90-91`). |
| 2.9 | Busy-valve skip is part of the faithful edge port (game-design) | **REFUTED** | 1.1 above: there is no state check in edge node "Decide + build actuator cmd" (function). The simulator-only check is at `SIM/model/triggers.ts:201-202`. |
| 2.10 | `osi-daily-scheduler/decision.js` exists (brief, tech §4.1) | **REFUTED** | `ls EDGE`. |
| 2.11 | Simulator has no snapshot/restore (tech §1.4) | **VERIFIED** | `SIM/model/clock.ts:18-30`; grep. |
| 2.12 | `aggregation.ts` builds a formatter per call (tech §1.2) | **VERIFIED** | `SIM/model/aggregation.ts:10`. sim-integration's hook commit does not cover it. |
| 2.13 | The simulator's "measured" flow is the valve-time estimate and overrides game-supplied flow (sim-integration §3-4) | **VERIFIED** | `SIM/model/readings.ts:190-193`: when an `observed-flow` sample exists at the same instant, its `flow_liters_delta/_today/_per_10min` win over a non-observed sample. `SIM/model.ts:404-408` writes those litres to `latest_data`. Consequence: game-design's "empty tank delivers nothing" cannot reach the phone. |
| 2.14 | Host protocol speeds are 1/10/60; `MAX_JUMP_MS` = 8 d (game-design, sim-integration) | **VERIFIED** | `SIM/protocol.ts:6`, `SIM/model/clock.ts:15`. |
| 2.15 | Trigger editor defaults: threshold 30 kPa, valid 0 < x ≤ 300 (osi-tiers) | **VERIFIED** | `src/components/farming/ScheduleSection.tsx:254,257,350`. |
| 2.16 | Fictional dendro row can enter the water verdict (osi-tiers §4) | **VERIFIED** | `SIM/model.ts:545-564`: `publicWaterAction` passes `dendroRecommendationEvidence` as argument 2. It is harmless if the game registers no dendrometer. |
| 2.17 | Unverified [S]/[A] numbers in agronomy and game-design | **UNRESOLVED** | Not re-checked: agronomy's [S]/[S?] climate statistics (Katumani CV 45-58 %, good/failed season rates, Barron dry spells), prices, and game-design's "Florida tomato 10-20 kPa" (already marked unverified). They are tuning inputs, not slice blockers. |

## 3. Gaps that block a design document or a vertical slice

**Blockers for the slice**

1. **T2 parity with the edge** (§0, 2.2, 2.13). Either:
   - fix upstream in `SIM/` in one commit, with parity tests against `osi-zone-env`:
     - port the 7-argument `resolveWaterAction` with `rain_unknown`;
     - treat a zone with no meter as 0 measured litres, as the edge does;
     - feed measured flow from the game when a source is set; or
   - scope the slice to the parity-safe envelope: gauge and meter present, no dendrometer, and a tank that can never run dry mid-run (pumping is the labour, and the valve refuses to open when the tank is below one run's volume, as a **game-side** rule).
2. **Weather hook** (sim-integration §8). There is no zero-hook path for ET0, forecast or demand. Without it the phone shows the sine-fixture ET0 (3.1 + sin, `SIM/model/environment.ts:43-54`), unrelated to the game's weather. This blocks T2 and the agronomic tab entirely.
3. **The owner's ET0 labelling decision** (§4 D3). The hook can be coded either way, but its `et0_source`/`et0_tier` label and the in-game disclosure depend on the decision.
4. **Intl perf fix** in all three places. It is required for sleep and skip, and for any phone target. Unpatched cost is 26-76 s per 30 sim-days.

**Blockers for the design document** (decisions or specs missing, not code)

5. **Fictional location, timezone and names policy** (1.9).
6. **One atlas format and render-pass budget** (1.3). Art's indexed G-buffer and tech's albedo pipeline need one spec before shader work.
7. **World-event message for device animations.** Art-direction needs it (LED blink on uplink, valve lever on open). With the simulator in the game window this needs no protocol message: the game reads `sim.outcomes` and the reading ledger directly, through sim-integration's `OsiWaterTap.drain()`. Art-direction's "new protocol message" requirement is obsolete under the in-process architecture. Record this in the design document.
8. **Data-collection spec.** game-design §8 wants `screen_view` and `reading_shown` events, which need hooks inside the edge app. The bridge can log `api_read` (every phone REST call passes through it) without touching `src/`. Decide that logging is bridge-only for M1.
9. **Stage-length mismatch policy** (1.6) and the **kale question**, if kale is in scope.
10. **Device floor and phone performance.** Nothing measured the game canvas and the phone iframe together on a real low-end Android device. Tech measured the phone alone: 1.7 s to the first dashboard at 1×, 8.7 s at 6× throttle, 21 MB heap. This is an M1 exit criterion.

**Not blockers for the slice; defer**

- Snapshot/restore (M2).
- Counterfactual replay (M4).
- PWA (M5).
- `@pixi/tilemap` maintenance risk.
- Cross-browser replay hashes (V8 is the reference).

## 4. Decisions for the project owner (short list)

- **D1 Repo location.** Should the game live in public osi-os (`web/farm-sim`) or in its own repository that imports the simulator? (game-design Q8; tech and sim-integration assume `web/farm-sim`.)
- **D2 Hook commit placement.** Should the demo hook commit (weather source, reading source, `fictionalHistory`, Intl fix, plus the T2 parity fixes from §3.1) land on PR #658 or in a follow-up PR after it merges?
- **D3 What T2 may be labelled.** Choose one:
  - (a) "OSI water advice", once the parity fixes land and today's ET0 is computed by OSI's `et0.js` on game weather, with that composition disclosed; or
  - (b) present the game weather as an external provider value and keep the app's "Simulated sensor advice" label; or
  - (c) leave T2 out of M1.

  Also: should the phone keep the provider name `open_meteo` on game weather?
- **D4 Research tier.** Omit conditional irrigation (`osi-irrigation-policy`) until it is production-qualified, or show it as a labelled "experimental, never opens a valve" lab?
- **D5 Crop catalogue upstream.** For kale/sukuma and East African or arid stage lengths, choose among:
  - accept `heuristic_phenology` and Mediterranean rows;
  - map with a visible disclosure; or
  - add rows to `docs/contracts/agronomy/crop-kc.json` (a product change).
- **D6 Fictional identity.**
  - Approve a fictional location (coordinates in the -2° latitude band) and `Etc/GMT-3`.
  - Approve a naming policy for people and places: invented vs real given names.
  - Name who does the cultural review.
- **D7 Pilot audience, consent and ethics.** Classroom or farmer group first; research consent, retention and hosting; and whether the PWA may check for updates online.
- **D8 Device floor.** Which low-end Android class must run the slice with the phone open?

Team-level decisions, not for the owner: tile size (16), slice crop (tomato), DOM UI, clock ownership, phone-build location, render-pass budget and soil-band alignment. §1 gives recommendations for each.

## 5. Recommended vertical-slice definition (reconciled)

**Goal.** One playable dry-season stretch that proves the closed loop: game weather and soil produce sensor uplinks, the real OSI code decides or actuates, and water reaches the game soil. Every number on the phone traces to OSI code.

| Element | Scope | Source report |
|---|---|---|
| Location and time | Fictional plateau at about -2° latitude, about 1,200 m, `Etc/GMT-3` set via `PUT /api/system/settings`. Epoch moved to the start of the hot dry season (Jan) with `clock.reset` before the farm is built. **14 in-game days**, so the 45-minute target holds at about 3 min per day with sleep. | sim-integration §6, agronomy §A, this report 1.5 and 1.10 |
| Weather | agronomy's Markov-gamma generator with the Jan-Feb parameters. One fixed seed plus two alternates, one of which contains a ≥ 7-day dry spell. ET0 via `EDGE/osi-agronomy-daily/et0.js fao56Et0`, quantised to 0.01 mm, fed through the `WeatherSource` hook. The label follows D3. | agronomy, sim-integration §5, tech §4.1 |
| Soil | Sandy loam. agronomy's FAO-56 bucket with three layers centred on 20/40/60 cm. Depletion to kPa from agronomy's table, clamped to 200 kPa for the Kiwi. Drainage to FC in 1 day. SCS-CN runoff on crusted soil. Over-watering losses (deep percolation) shown in the daily summary. | agronomy §2 |
| Crop | One `tomato` bed (8×8 tiles, 64 m²), transplanted and set to `development` with `stage_started_on` via `PUT /config`. Hidden physiology uses the edge stage rows, so the OSI Kc ramp equals the game's. Ks drives the stress sprites. | game-design §10, agronomy §3, osi-tiers §6 |
| Water and labour | Shared well 150 m away with jerrycan carrying. A 1,000 L raised tank filled by hand pump. Drip line at 90 % efficiency. Watering-can water is **unmetered** (OSI does not see it). Game-side rule: the valve does not open, as a world fault, when the tank holds less than one run's volume. The simulator's "measured" flow therefore never claims undelivered water (until upstream flow sourcing exists). | game-design §4, sim-integration §4, this report 2.13 |
| OSI devices | Through REST with fictional EUIs `00000000000000Bx`: one `KIWI_SENSOR` (`swt_1`, `swt_2` at 20/40 cm, `bat_pct` from world state, no `rain_mm_delta`); one `DRAGINO_LSN50` MOD9 rain gauge and flow meter on the tank outlet; one `STREGA_VALVE`. No weather station, no dendrometer, no UC512. | sim-integration §2-3, osi-tiers §1 |
| Tiers | A facilitator or debug panel toggles: T0 (phone has no OSI app); T1 (Kiwi cards, soil-now pill, history); T3 (manual timed open, weekly plan); T4 (06:00 trigger: player sets threshold, metric and duration). **T2** is included only if D3 is (a) or (b) **and** the parity envelope in §3.1 holds; otherwise it is hidden for M1. | osi-tiers, this report §0 |
| Phone | Real edge React app in a same-origin iframe, structured-clone bridge, built from `web/farm-sim` with react-gui's Vite (sim-integration §7). Lazy mount at a "phone boots" moment. Explicit revalidation after `advanceTo` and after writes, throttled to 1/s. Memory storage backed by the parent. Every mutating phone request is logged as replay input. | sim-integration §7, tech §4.8 |
| Simulator changes | One `SIM/` commit: Intl memo plus formatter cache in `model.ts` **and** `aggregation.ts`; `readingSource`; `fictionalHistory:false`; `weatherSource`. If T2 is in scope, also the 7-argument `resolveWaterAction` port and edge-parity no-meter handling, with parity tests against `osi-zone-env`. Gates: `tsc -p demo/tsconfig.json`, the full `demo:test` suite, and `check-build-isolation.mjs` extended to `(demo\|farm-sim)`. | sim-integration §8, tech §8.1, osi-tiers §7 |
| Engine | Pure-TS core with a 20 Hz tick and a seeded PRNG. Pixi 8 WebGL, 16 px tiles, 480×270 logical, integer upscale, ≤ 5 passes. Art-direction's palette and indexed sprite format. Preact DOM HUD with a left-edge tool belt. No Canvas2D fallback. | tech, art-direction |
| Art (P0 only) | Laterite and tilled-soil autotiles, crack overlay, drip line and pipe, tank, well, farmhouse, one acacia, tomato in 5 stages × 5 states, Kiwi probe, valve box, gateway pole, player (3 directions, core actions), 12 icons, signboard 9-slice, phone bezel. The maize set moves to P1. | art-direction §4 |
| Save | Seed plus command log, replayed headless on load. No snapshot/restore in M1. | this report 1.7 |
| Report and log | End-of-slice report: litres by source, litres lost, labour minutes, water productivity, one calendar-habit NPC comparison on the same seed. Local hash-chained JSONL, with bridge-level `api_read` only. | game-design §7-8 |
| Honesty checklist | Every phone number traces to: the Kiwi uplink (game physics); `swt.ts` categories; the trigger port; valve and plan ports; `resolveKc`; `et0.js` (T2 only). Busy-skip and advisory sentences are labelled as simulator text. The moisture lens and NPC habits are labelled "game". World soil bands sit on the 20/50 kPa edges. | osi-tiers §5, game-design §5 |

**M1 exit criteria**

1. 14 days finish in ≤ 45 min.
2. The same seed and log reproduce identical hashes in Node and Chromium.
3. The simulator's existing port tests and the new parity tests pass.
4. The honesty checklist is signed off.
5. Frame time and heap are measured with the phone open on the D8 device class.
6. In playtests, 5 players can explain why the 40 cm reading lags the 20 cm reading.
