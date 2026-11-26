# Game Design Document (draft v0.1): OSI farming simulation for education and validation

Working title: **Project Furrow** (placeholder; the owner chooses and clears the final name).
Status: research draft for owner review. Nothing here is decided until the owner signs off.
Simulator baseline: osi-os PR #658, branch `t3/simulator-ux-analysis`, worktree HEAD `4682fb17b1`.

Conventions in this draft:
- **[REPO]** marks a claim taken from code in this worktree, with a path and line.
- **[WEB]** marks a number taken from a public source, with its URL.
- **[TUNE]** marks a game-balance placeholder. It has no source and must be tuned in playtests.

---

## 0. Summary

A cozy, original, top-down pixel-art farming game. The player runs a small irrigated plot in a fictional semi-arid region with two rainy seasons. Water is the central resource, and carrying it is the central labour cost. The in-game phone runs the real OSI OS edge React app against the simulator's in-memory REST model. The player can unlock four tiers of OSI help: readings, crop-demand information, a remote valve, and an automatic threshold trigger. Each tier saves labour or adds information. Each also costs money, upkeep and attention, and has failure modes the player can see.

The same build is a research instrument. Scenarios have fixed seeds, a season can be replayed under another tier as a counterfactual, and a local append-only event log can be exported as a file. Version 1 sends no network telemetry.

The key architectural rule (section 9): **the game owns the world** (weather, soil water, crop growth, labour). **OSI code owns every recommendation and every automated action.** The world produces sensor readings. The real OSI code reads them, the same way it reads LoRaWAN uplinks on a gateway.

---

## 1. Pillars, audiences, sessions, platforms, languages

### 1.1 Design pillars

| # | Pillar | What it means in play | Test question for any feature |
|---|---|---|---|
| P1 | **Water is labour** | Every litre the player does not get from rain is carried, pumped or paid for. Time and stamina show the cost. | Does this feature keep water tangible? |
| P2 | **See the invisible** | Soil water in the root zone is normally invisible. The game shows it through plant signs, a moisture lens and, at higher tiers, the real OSI app. | Does this help the player build a mental model of the root zone? |
| P3 | **Honest tools** | OSI output in the game is always real OSI code. Tools have prices, upkeep, battery, coverage and placement errors. | Could a farmer who played this be misled about what OSI does? |
| P4 | **Cozy, not punishing** | Bad seasons hurt the household budget, but nobody dies and nothing is lost forever. Food security is a soft goal. Failure leads to a reflection, not a game-over. | Would a 14-year-old want to play another day? |
| P5 | **Comparable runs** | The same seed gives the same weather and the same NPC behaviour, so results can be compared across players and tiers. | Does this feature break determinism or replay? |

### 1.2 Target players

| Audience | Context of use | Session length | Primary goal | Key features |
|---|---|---|---|---|
| Secondary and university students | Classroom, lab or homework; facilitator present | 20–45 min | Learn root zone, ET and irrigation timing | Guided scenarios, quiz hooks, season report |
| Farmers in training, TVET and farmer field schools | Group sessions on a shared laptop or projector; personal Android phones | 30–60 min | Practical judgment: when and how much to water; labour versus water | Local-language UI, low text density, NPC strategy comparison |
| Extension officers | Training of trainers; demonstrating OSI to farmer groups | 10–30 min demo, longer self-study | Explain the OSI tiers and their limits honestly | Facilitator mode, tier toggles, counterfactual replay |
| Donors and policy audiences | Briefings, exhibitions, conference booths | 5–10 min | Understand labour, water and yield trade-offs at a glance | "Briefing" scenario, auto-play, summary dashboard |
| General public | Web link | 15 min to many hours | Enjoyment; curiosity about farming in drylands | Free-play "story" mode, cozy progression |

### 1.3 Session structure

| Mode | In-game span | Real time target | Notes |
|---|---|---|---|
| Briefing | 3–5 days | 5–8 min | Fast day length; tiers pre-unlocked; ends at a mini report |
| Classroom scenario | 10–21 days | 20–45 min | Facilitator-set day length (4–8 min per day); auto-chores on; fixed seed |
| Season (story) | One rainy season plus dry period, about 120–150 days | Several sessions | Default day length about 12 min; autosave each night |
| Multi-year (story) | 3–5 years | Long-term | Unlocks land, water sources and tiers |

Day length is a setting. The default of about 12 real minutes per in-game day is a genre convention **[TUNE]**. In classroom scenarios, "sleep" skips the night and "fast-forward to next event" uses the simulator clock's `nextEventAt` (`web/react-gui/demo/model/clock.ts:68`) **[REPO]**.

### 1.4 Platforms

| Requirement | Decision (proposed) | Reason |
|---|---|---|
| Desktop browsers (Chrome, Firefox, Edge, Safari) | Supported | Classrooms, briefings |
| Android phone browsers (Chrome, including low-end 2–3 GB RAM devices) | Supported, primary mobile target | Farmers and extension officers |
| iOS Safari | Best effort | Not a primary audience |
| Offline | Installable PWA; after first load, assets, locales and saves work offline | Connectivity in rural areas; the existing simulator already runs without network after build (`web/react-gui/demo/README.md`) **[REPO]** |
| Input | Mouse and keyboard; touch with a virtual joystick and tap-to-act; gamepad optional | |
| Rendering | 2D canvas or WebGL with a canvas fallback; integer scaling of pixel art | Performance on low-end phones |
| Phone overlay | On desktop the in-game phone shows the real app at 390 × 844, the simulator's native iframe size. On a real phone, the in-game phone goes full screen. | Reuses the simulator layout without changes |

Performance risk: the real edge React app plus the game canvas in one tab may be heavy on low-end phones. M1 must measure this (section 11).

### 1.5 Languages

| Layer | Launch | Later | Notes |
|---|---|---|---|
| Game UI, dialogue, tutorial | English | Same locales as the OSI app, Swahili-family or region-appropriate languages on request | Separate game i18n bundle |
| OSI app in the phone | en, de-CH, fr, it, es, pt, lg as shipped (`web/react-gui/demo/protocol.ts:2`) **[REPO]** | | The demo's Luganda valve strings are machine-translated and live only in `demo/locales/lg-valves.json`. Production Luganda keeps its human-review policy, and other pending strings fall back to English (`web/react-gui/demo/README.md`) **[REPO]**. |
| Language sync | One language setting drives both game and phone; the simulator already posts `language` messages to the host (`protocol.ts:15`) **[REPO]** | | |

Design for low literacy: icons and colour plus a short label, voice-over hooks (M5), no essential information conveyed by colour alone (SWT categories also show a number and a word).

---

## 2. Setting (original, fictional)

- **Region:** a fictional semi-arid plateau, called "the Red Ridge Plain" in this draft. Laterite soils, scattered acacia-like trees, seasonal rivers, hand-dug wells. Placeholder names need a collision check by the owner.
- **Climate model:** bimodal rainfall, inspired by the general East African pattern of a stronger March–May season and a weaker October–December season **[WEB]** (Nature Reviews Earth & Environment review on East African rainfall: https://doi.org/10.1038/s43017-023-00397-x). The game uses its own fictional calendar names (section 3.2) and seeded rainfall. Seasonal totals are **[TUNE]**; no county-level climatology was used.
- **Village:** "Three Wells" (placeholder) with a market square, a cooperative store, a school, a borehole kiosk and a clinic. Its layout is original and drawn for this game.
- **People:** fictional characters (section 4.10). No real customers, farms, gateways, institutions or place names. Device EUIs use the simulator's fictional range `00000000000000xx` (`web/react-gui/demo/README.md`, registration range B0–CF) **[REPO]**.
- **Art direction (original):** 3/4 top-down pixel art on a 24 × 24 px tile grid (a deliberate choice that differs from the 16 × 16 grid common in the genre). The palette is built around ochre, laterite red, dusty sage, indigo shadows and a single saturated "water blue" used only for water and wet soil, so water stands out on every screen. All sprites are drawn in-house. No third-party or downloaded packs.
- **UI identity (original):** a tool belt on the left edge instead of a bottom hotbar, a water-container gauge (litres carried) as the main HUD element, the phone as a physical item in the player's hand (raised with one key or tap), and a daylight arc instead of a clock face.

---

## 3. Core loops

### 3.1 Daily loop

| Phase (in-game time) | Activities | Systems touched | Teaching moment |
|---|---|---|---|
| Dawn (05:30–07:00) | Wake, eat (food stock), household chores (cook fire, sweep, care for a younger sibling or an elder) | Energy, household | Labour competes with field work |
| Early morning (06:00) | **The OSI Tier 4 trigger evaluates at 06:00 farm time** if enabled (section 6) | OSI trigger | Automation decides *when*, at a fixed hour |
| Morning (07:00–11:00) | Fetch water (well, pond, river, borehole kiosk), inspect plants, check soil by feel or with the moisture lens, irrigate, weed, scout for pests | Water, soil, crops, energy | Cool hours mean less evaporation loss **[TUNE]** |
| Midday (11:00–14:00) | Heat slows the player (energy cost multiplier); plants show midday leaf rolling on stressed tiles | Weather, crop stress | Midday wilting can recover by evening; persistent wilting is real stress |
| Afternoon (14:00–17:30) | Market (on market days), cooperative, savings group meeting (weekly), errands, school pickup | Economy, NPCs | Prices change; credit costs |
| Evening (17:30–20:00) | Second irrigation round, harvest, family meal | Water, household | Evening watering versus morning |
| Night (20:00–) | **Evening reflection:** open the phone (real OSI app), review the day's water and labour, set tomorrow's plan, sleep | OSI app, journal | Reflection consolidates learning |

### 3.2 Seasonal loop (fictional calendar)

| Season (game name) | Approx. length [TUNE] | Weather character | Main activities | Irrigation role |
|---|---|---|---|---|
| **Big Rains** | 90 days | Most reliable rain; dry spells of 1–3 weeks possible | Plant staples (maize, sorghum, beans) and vegetables | Supplementary irrigation during dry spells |
| **Short Dry** | 60 days | Hot, little rain | Harvest staples; vegetables only with irrigation | Full irrigation; water source stress (well level drops) |
| **Small Rains** | 75 days | Less reliable, erratic onset | Second planting; risk management | Bridging dry spells; deciding whether to plant at all |
| **Long Dry** | 140 days | Hottest and driest; river dries up, pond shrinks | High-value vegetables for market if water allows; repairs, savings group share-out | Water is scarce and expensive; borehole fee dominates |

Seasonal hooks: onset of rains varies by seed; the savings group's annual cycle ends in Long Dry with a share-out **[WEB]** (VSLA methodology: one-year cycle, share-out proportional to savings, https://www.vsla.net/the-vsla-methodology).

### 3.3 Multi-year progression

| Track | Steps | Gate | Notes |
|---|---|---|---|
| Land | Home garden (about 64 m²) → leased plot → second plot → shared cooperative block | Savings, community standing | Lease costs and lease security |
| Tools | Hand hoe → better hoe → wheelbarrow and drum → bicycle with jerrycan rack → treadle or hand pump → small solar pump | Money; some via cooperative | Each step changes litres per trip or per hour |
| Water source | River and pond (free, far, seasonal) → shared hand-dug well (queue) → own shallow well (dig labour, dries up in Long Dry) → borehole kiosk (fee per jerrycan) → rainwater tank and roof catchment | Money, labour, seasons | Source reliability versus cost |
| Irrigation method | Can and bucket → hose from a raised tank → low-cost drip kit | Money, tank, water source | Application efficiency (section 4.6) |
| OSI tiers | T1 → T2 → T3 → T4 (section 6) | Cooperative purchase, savings group loan, grant, extension demo | Tier prerequisites are physical (a valve needs a tank and pipe) |
| Savings and credit | Cash at home → savings group shares → loans → cooperative membership | Trust, repayment history | Credit is a tool and a risk |
| Community standing | Helping neighbours, cooperative work days, sharing knowledge, honouring loans | Social | Unlocks lease offers, group purchases, demo plots |
| Household | School fees paid, meals, savings goal (for example a roof or a bicycle) | Income | Soft goals, not fail states |

---

## 4. Systems

### 4.1 Time

- One deterministic clock: the simulator's `SimulationClock` event queue (`web/react-gui/demo/model/clock.ts:18-91`) **[REPO]**. The game world schedules its own events (weather steps, soil water updates, crop growth ticks, NPC actions) on the **same** queue as the OSI model's valve timers, plan runs and the daily trigger. That keeps the world and OSI in one consistent timeline.
- The clock cannot move backward (`clock.ts:53`) **[REPO]**, so counterfactual replay restarts from a snapshot and seed instead of rewinding. `MAX_JUMP_MS` (8 days, `clock.ts:15`) only caps the lookahead of `nextEvent`; `advanceTo` itself has no span limit.
- The simulator's host protocol supports speeds 1, 10 and 60 only (`protocol.ts:6`) **[REPO]**. The game needs about 120× (12 min per day) and higher in classroom mode. Proposal: the game embeds the model in-process and calls `advanceTo` itself, instead of driving speed through the iframe host protocol. Integration work.
- Farm timezone: the simulator uses one gateway timezone (`runtime.ts:162`), and schedules the daily trigger at 06:00 local time in that timezone (`nextDailyTriggerAt`, `web/react-gui/demo/model.ts:240-248`) **[REPO]**. The game sets a farm timezone with the same UTC offset as its climate inspiration (UTC+3) for daylight and the 06:00 trigger.

### 4.2 Energy and labour

| Action | Energy cost [TUNE] | Time cost [TUNE] | Notes |
|---|---|---|---|
| Carry one 20 L jerrycan (about 20 kg of water) 100 m | 6 | 3 min round trip at walking pace | Mass from water density, 1 kg per litre |
| Draw water at a shared well | 2 per can | Queue 0–30 min, longer in Long Dry | Queue length is a world variable |
| Water with a can (10 L) | 1 per can | 1 min per can | Precise placement, slow |
| Pour a bucket at the plant base | 2 | 1 min | Fast, some runoff on crusted soil |
| Treadle or hand pump into a 1000 L tank | 1 per 20 L | 1 min per 20 L | Labour, but at one location |
| Open a drip line from the tank | 1 | 1 min, then unattended | Needs a full tank |
| Tilling one tile | 4 | 2 min | |
| Weeding one tile | 2 | 1 min | Weeds compete for water |

Real-world anchors used for calibration and on-screen facts:
- Women and girls collect water in about 7 of 10 households that fetch water; in Malawi women who collected water spent on average 54 minutes per day **[WEB]** (UNICEF/WHO press release, 2023: https://www.unicef.org/press-releases/women-and-girls-bear-brunt-water-and-sanitation-crisis-new-unicef-who-report; UNICEF 2016: https://www.unicef.org/press-releases/unicef-collecting-water-often-colossal-waste-time-women-and-girls).
- Labour arithmetic the game should make felt: a 64 m² plot at a crop water demand (ETc) of 5 mm/day needs 320 L/day, which is 16 jerrycans, before application losses. (1 mm over 1 m² is 1 L.) The 5 mm/day value is the FAO-56 reference ETc used for Table 22 depletion fractions **[WEB]** (https://www.fao.org/4/x0490e/x0490e0e.htm); the plot size is **[TUNE]**.

Labour hours are tracked per day, per activity, and per household member. The season report shows them (section 7.4).

The player character's gender and age are chosen at start. Household chores rotate among family members, and the game does not assign all water carrying to one figure by default. A short journal entry can show the real-world gendered burden as a fact, without moralising.

### 4.3 Soil and water (world model, game-owned)

Proposed model: a layered "bucket" water balance per tile, following FAO-56 chapter 8.

| Quantity | Formula or value | Source |
|---|---|---|
| Total available water | TAW = 1000 (θFC − θWP) Zr | FAO-56 Eq. 82 **[WEB]** https://www.fao.org/4/x0490e/x0490e0e.htm |
| Readily available water | RAW = p × TAW | FAO-56 Eq. 83 **[WEB]** same URL |
| p adjustment for ETc | p = p_table + 0.04 (5 − ETc), limited to 0.1–0.8 | FAO-56 **[WEB]** same URL |
| Water stress coefficient | Ks = (TAW − Dr) / ((1 − p) TAW) when Dr > RAW, else 1 | FAO-56 chapter 8 **[WEB]** same URL |
| Soil types (θFC − θWP, m³/m³) | Sand 0.05–0.11; loamy sand 0.06–0.12; sandy loam 0.11–0.15; loam 0.13–0.18; clay 0.12–0.20 | FAO-56 Table 19 **[WEB]** https://www.fao.org/4/x0490e/x0490e0c.htm |
| Water content to tension (kPa) | van Genuchten retention curve per soil type | Parameter source to be verified: a candidate sandy loam row (θs 0.41, θr 0.065, α 0.075 /cm, n 1.89) appears at https://apps.dasnr.okstate.edu/SSL/soilphysics.okstate.edu/software/water/conductivity.html, attributed to Leij et al. 1996. The column order is unconfirmed, so treat it as **[TUNE]** until checked. |

Layers per tile: 0–20 cm, 20–40 cm, 40–60 cm (the simulator's Kiwi fixture has probe depths 20 and 40 cm, `web/react-gui/demo/fixtures.ts:18`) **[REPO]**. Water infiltrates top-down; roots extract by root density; deep percolation leaves the bottom layer (counted as "water lost" in the report). Surface evaporation from wet topsoil is a separate loss; mulch reduces it **[TUNE]**.

**Visible soil water:**

| Cue | Always visible | Unlockable |
|---|---|---|
| Surface colour (dark when wet, pale and cracked when dry) | Yes | |
| "Feel test" mini-interaction: squeeze soil from 0–20 cm (wet ribbon, crumbly, dusty) | Yes | |
| **Moisture lens**: tile overlay of root-zone depletion | No | Unlocked in tutorial as a learning aid; can be locked by the facilitator to test unaided judgment |
| Real OSI app readings in kPa | No | Tier 1 and above |

The moisture lens is a game-side teaching tool, labelled "field view (game)", never "OSI". Research scenarios can disable it.

### 4.4 Crops

Crop selection uses entries in the real OSI crop catalogue (`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json`, 136 crops) **[REPO]**, so the in-game crop and the OSI app's Kc for that crop agree.

| Crop (catalogue id) | Kc ini / mid / end [REPO] | Stage lengths, days [REPO] | p (Table 22) [WEB] | Max root depth m [WEB] | Seasonal Ky [WEB] | Game role |
|---|---|---|---|---|---|---|
| `tomato` | 0.6 / 1.15 / 0.7 | 30 / 40 / 45 / 30 | 0.40 | 0.7–1.5 | 1.05 (unverified) | Slice crop: high value, water-sensitive, irrigation pays |
| `maize` | 0.3 / 1.2 / 0.35 | 30 / 40 / 50 / 30 | 0.55 | 1.0–1.7 | 1.25 | Staple, mostly rainfed with supplementary water |
| `sorghum` | 0.3 / 1.0 / 0.55 | catalogue | 0.55 | 1.0–2.0 | 0.9 (unverified) | Drought-tolerant staple; low-risk option |
| `dry_bean` | 0.4 / 1.15 / 0.35 | 20 / 30 / 40 / 20 | 0.45 | 0.6–0.9 | 1.15 | Legume; household food |
| `green_gram` (green gram and cowpeas) | 0.4 / 1.05 / 0.35 | 20 / 30 / 30 / 20 | 0.45 | 0.6–1.0 | — | Short-cycle legume |
| `onion` | 0.7 / 1.05 / 0.75 | 15 / 25 / 70 / 40 | 0.30 | 0.3–0.6 | — | Shallow roots: frequent light watering |
| `sweet_potato` | 0.5 / 1.15 / 0.65 | 20 / 30 / 60 / 40 | 0.65 | 1.0–1.5 | — | Hardy; food security |
| `cabbage` | 0.7 / 1.05 / 0.95 | 20 / 30 / 20 / 10 | 0.45 | 0.5–0.8 | — | Market vegetable |

Sources: p and root depth from FAO-56 Table 22 (https://www.fao.org/4/x0490e/x0490e0e.htm). Seasonal Ky: maize 1.25 and beans 1.15 are confirmed on the FAO deficit-irrigation page that reproduces FAO-33 (Table 1, continuous-deficit column, https://www.fao.org/4/Y3655E/y3655e04.htm). Tomato 1.05 and sorghum 0.9 came only from a search summary of https://fao.org/4/i2800e/i2800e02.pdf and stay **unverified** until checked against that table. FAO itself notes Ky varies with stage and site.

**Catalogue caveat [REPO]:** most stage lengths in `crop-kc.json` come from Mediterranean or European rows of FAO-56 Table 11 (for example tomato: "Mediterranean, April/May"), and some entries are `verified: false`. They do not describe a tropical semi-arid planting. The slice uses only `verified: true` crops, and the game sets `stage_started_on` explicitly so the OSI Kc stage matches the in-game crop stage. Kale and cowpea are not separate catalogue entries.

**Yield response:** FAO-33 form, 1 − Ya/Ym = Ky (1 − ETa/ETc), accumulated per stage with stage-weighted Ky in M2 **[WEB]** (same FAO-33 URLs). Ym is a per-crop potential yield **[TUNE]**.

**Visible stress** (game-side, driven by Ks):

| Ks band [TUNE] | Visual | Recoverable? |
|---|---|---|
| 1.0 | Upright, saturated green | — |
| 0.8–1.0 | Midday leaf rolling only | Yes, overnight |
| 0.5–0.8 | Rolling all afternoon; leaves dull grey-green | Yes, with yield penalty |
| 0.2–0.5 | Wilting; lower leaves yellow; flower drop (tomato) | Partly |
| < 0.2 for several days | Leaf scorch, stunting | Permanent loss |
| Waterlogged (top layer saturated over 24 h) | Yellowing, leaning | Yes, with penalty |

Overwatering is not free: deep percolation wastes water and leaches fertiliser, and waterlogging lowers yield. This keeps "always water a lot" from being the dominant strategy.

### 4.5 Weather

| Element | Model | Notes |
|---|---|---|
| Rainfall | Seeded stochastic daily occurrence (two-state Markov chain per season) and amount (gamma distribution); dry-spell lengths emerge from the chain | Parameters **[TUNE]**; calibrate against public rainfall statistics of a comparable semi-arid region in M2 |
| Temperature, humidity, wind, radiation | Seasonal mean plus day-to-day noise; rain days are cooler, cloudier and more humid | Same rules the simulator already uses qualitatively (`web/react-gui/demo/agronomy.md`) **[REPO]** |
| ET0 | Computed by the **real** `osi-agronomy-daily/et0.js` (`fao56Et0`, `hargreavesEt0`, export at `et0.js:188`) **[REPO]** from the hourly aggregates of an **in-world weather station**. On the edge, only the station tiers run `et0.js`; the provider tier sums ET0 hours the provider delivered (`docs/superpowers/specs/2026-09-26-daily-agronomy-design.md:24, 133-136`) **[REPO]**. A forecast in the game is therefore a fictional world input, labelled as such, with no real provider name. | Replaces the simulator's fictional sine ET0 fixture (`web/react-gui/demo/model/environment.ts:44-54`) **[REPO]** |
| Forecast | The radio, the trader's gossip, and (Tier 2) the OSI app's forecast field. Forecasts are generated from the true future plus seeded error that grows with lead time. | Teaches uncertainty. Forecast skill **[TUNE]** |
| Determinism | One master seed derives sub-seeds for weather, events, prices and NPCs, so replaying a scenario with another tier gives identical weather | Pillar P5 |

### 4.6 Water sources and irrigation methods

| Source | Distance from house [TUNE] | Cost | Reliability | Unlock |
|---|---|---|---|---|
| Seasonal river | 600 m | Free | Dry in Long Dry | Start |
| Pond | 300 m | Free | Shrinks in dry seasons; turbid | Start |
| Shared hand-dug well | 150 m | Free; queue | Level drops in Long Dry | Start |
| Own shallow well | At the plot | Digging labour and materials | Can dry up | Year 1–2 |
| Borehole kiosk | 400 m | Fee per 20 L **[TUNE]** | Reliable; breakdowns (event) | Start (expensive) |
| Roof catchment and tank | At the house | Tank purchase | Only stores rain | Mid-game |

| Method | Application efficiency | Labour | Prerequisite |
|---|---|---|---|
| Watering can | **[TUNE]**, high with careful aim | Highest | None |
| Bucket | **[TUNE]**, lower (runoff) | High | None |
| Hose from raised tank | Surface-like; FAO indicative value 60% for surface methods **[WEB]** | Pumping only | Tank, pump or gravity |
| Drip kit | FAO indicative value 90% for drip **[WEB]** | Pumping only; line maintenance (clogging event) | Tank, kit purchase |

Efficiency source: FAO Irrigation Water Management, indicative field application efficiencies of 60% surface, 75% sprinkler, 90% drip; Table 8; FAO notes that lack of farmer discipline may lower them (http://www.fao.org/4/t7202e/t7202e08.htm, fetched).

**Carrying versus pumping** is the slice's core contrast: carrying spreads water labour across trips and distance; pumping concentrates it at one spot and enables drip, and only drip with a valve unlocks OSI Tiers 3–4.

### 4.7 OSI devices in the world

| Device (simulator type) | World object | Install mini-game | Upkeep and failure modes |
|---|---|---|---|
| Soil probe (`KIWI_SENSOR`, channels `swt_1`, `swt_2` at 20 and 40 cm, `fixtures.ts:18`) **[REPO]** | A probe staked into a chosen tile | Choose the tile (inside or outside the drip wetted zone, near a plant or in a gap), auger the hole, install at depth, backfill and tamp. Air gaps or wrong depth give a biased reading **[TUNE]**. | Battery drains; LoRa link drops behind obstacles; a goat can knock it over (event); readings represent one spot only |
| Gateway | A small box on the house roof | Place within range; solar panel orientation | Power cut, no connectivity (data stays on the gateway; the app still works on the local network) |
| Valve (`STREGA_VALVE`) | A motorised valve on the tank outlet feeding the drip line | Fit to pipe | Battery, a valve that does not close if the tank pressure is too low **[TUNE]**, tank must hold water |
| Weather station (Tier 2) | A small station on a pole | Mount the station clear of shade | Covered or dirty sensors give partial days; the edge then falls back to another tier or reports `partial_day` (agronomy spec) |
| Phone | The player's phone | Charging at the kiosk or solar charger | Low battery means no app; airtime cost for cloud features (not used in v1) |

Missing readings stay missing. The production rule says missing data is not filled in (`web/react-gui/demo/agronomy.md`) **[REPO]**, so a disconnected probe shows stale or absent data in the real app, and the real trigger records `no_data_last_hour` (`web/react-gui/demo/model/triggers.ts:180-181`) **[REPO]**.

### 4.8 Economy

| Element | Mechanic | Values |
|---|---|---|
| Market days | Twice a week in the village; weekly at a bigger town market (a longer walk or a paid ride) | **[TUNE]** |
| Prices | Seeded random walk per crop with seasonal pattern (vegetable prices rise in dry seasons); gluts after harvests | **[TUNE]** |
| Post-harvest | Tomatoes spoil within days; sell or lose | **[TUNE]** |
| Inputs | Seed, fertiliser, mulch, pest control, drip spares, batteries | **[TUNE]** |
| Savings group | 10–25 members, weekly meetings, buy 1–5 shares per meeting at a fixed share price, loans up to 3× savings for at most 3 months with a monthly service charge set by the group, optional social fund, yearly share-out | **[WEB]** https://www.vsla.net/the-vsla-methodology ; service charge rate **[TUNE]** |
| Cooperative | Group purchase of OSI kits and drip kits at a discount; demo plot obligations | **[TUNE]** |
| Credit (trader or shop) | Inputs on credit at a higher effective cost; repaid from harvest | **[TUNE]**; teaches the cost of credit |
| Grants | Extension or NGO grant for a demo kit, with a reporting obligation (share season data at a farmer day) | Narrative unlock |

### 4.9 Household

| Member (fictional, chosen at start) | Needs | Can help with |
|---|---|---|
| Player character | Food, rest | Everything |
| Partner or sibling | Food | Water fetching, market |
| School-age child | School fees each term; food | After-school chores (only light ones; the game never makes child labour a strategy that pays) |
| Elder | Food, medicine | Advice; storytelling (journal tips) |

Food security is a soft goal: a pantry with days of food. Running low lowers energy and mood and triggers help from neighbours, but never ends the game.

### 4.10 Community NPCs (original characters)

All names are placeholders that need a collision check.

| Role | Character sketch | Strategy or function | Relationship rewards |
|---|---|---|---|
| Extension officer, "Officer Asha" | Rides a motorbike, visits weekly, runs farmer field days | Tutorial guide; explains SWT, ET; offers the Tier 1 demo kit | Demo kits, training badges |
| Neighbour "Old Baraka" | Proud, experienced, waters by calendar every two days | **Calendar strategy** (game heuristic) | Tool loans, planting tips |
| Neighbour "Neema" | Young, careful, uses the feel test and watches plants | **Feel-and-plant strategy** (game heuristic) | Seed swaps |
| Neighbour "Joseph" | Runs a cooperative demo plot with OSI | **OSI Tier 4 strategy**: his zone runs the same real trigger code as the player's would (section 6.4) | Lets the player look at his phone app |
| Neighbour "Mama Rehema" | Rainfed only; grows sorghum and sweet potato | **Rainfed low-risk strategy** | Food security tips |
| Trader "Kito" | Buys at the market, sometimes on credit | Price signals, gossip forecasts (unreliable) | Better prices with trust |
| Cooperative chair "Mrs. Wanjiru-Lee" | Organiser; runs group purchases | Unlocks group buys and lease offers | Committee role |
| Savings group treasurer "Halima" | Keeps the cash box | Savings and loans | Loan size |
| Kids "the Pump Club" | Curious schoolkids | Mini-quests (find a leak, chase goats), school science fair tie-in | Fun, small help |

The neighbour farms run on the same weather and soil model, so their season outcomes are comparable with the player's under identical conditions. Non-OSI strategies are labelled as farmer habits in the game, never as OSI.

### 4.11 Events (seeded)

| Event | Trigger | Effect | Response options |
|---|---|---|---|
| Dry spell | Weather chain | Rising soil tension, crop stress | Prioritise crops, deficit irrigation, buy water |
| Pest outbreak (fictional "leaf hopper") | Seeded; more likely on stressed plants | Yield loss | Scout, remove, buy control |
| Price drop | Glut at harvest | Lower income | Store (if possible), sell at town market, process |
| Broken pump or borehole kiosk breakdown | Seeded | Water source unavailable for days | Switch sources, repair, share |
| Probe knocked over or flat battery | Seeded or neglect | OSI readings stop or go wrong | Visit and fix; real app shows stale data |
| Gateway power cut | Seeded | No new readings, no remote valve | Manual operation |
| Clogged drip emitter | Usage | Uneven wetting, sensor may misread the field | Flush line |
| Flash flood | Rare heavy rain | Erosion, waterlogging | Drainage, bunds |
| Family illness | Seeded | Lost labour days, clinic cost | Social fund, neighbours |

---

## 5. Honesty boundary

### 5.1 The rule

Anything the game labels as an **OSI recommendation** or **OSI automation** must be the output of real OSI code: either the simulator's ported logic, pinned by port tests, or an edge helper module run unchanged. Game-side teaching aids (moisture lens, plant cues, NPC habits, journal tips) are labelled as game content.

### 5.2 Findings from the simulator that constrain the design

| Finding | Evidence [REPO] | Design consequence |
|---|---|---|
| The dashboard "Action" tile (irrigate / delay / monitor) is labelled simulated sensor advice and does not call a production prediction service | `web/react-gui/demo/water-copy.ts:3`; `web/react-gui/demo/agronomy.md` | The game must hide this tile, or keep its "simulated" label and never call it an OSI recommendation. It is not real OSI advice. |
| Conditional irrigation policies are not qualified; an enabled conditional schedule returns 503 | `web/react-gui/demo/controller-semantics.md:42` | `osi-irrigation-policy` cannot be a shipped tier. At most it is a clearly labelled experimental tier, if the owner agrees. |
| The legacy daily SWT trigger is a faithful port, pinned by tests: 06:00 farm time, mean SWT over the last hour compared with a threshold, fixed duration clamped to 1–240 min (default 20), one run per UTC date, needs an assigned valve, skips a busy valve | `web/react-gui/demo/model/triggers.ts:171-213`; `web/react-gui/demo/PRODUCTION-HOOKS.md` ("Source-backed behavior notes"); `web/react-gui/demo/tests/triggers.test.ts` (TR01–TR03 and following) | This is Tier 4. It decides *when*, once a day; the farmer decides *how much*. |
| Timed valve opens and weekly plans are ports of edge behaviour | `web/react-gui/demo/model/irrigation.ts:29`, `web/react-gui/demo/model/plans.ts:54-202` | This is Tier 3. |
| SWT colour categories in the app: below 20 kPa wet, 20–50 moist, above 50 dry | `web/react-gui/src/utils/swt.ts:41-42` | These are display categories in the real app, not crop-specific prescriptions (`agronomy.md`). The game teaches exactly that distinction. |
| ETc in the environment summary = ET0 × Kc, with Kc from the real catalogue (`resolveKc`), but ET0 comes from a fictional sine fixture | `web/react-gui/demo/model/environment.ts:19-23, 44-54, 79` | Tier 2 must feed ET0 computed by real `et0.js` from in-world station data. Until then, ETc is not an honest OSI number. |
| Readings are synthetic sine curves | `web/react-gui/demo/model/readings.ts:13-21` | Replace with readings sampled from the game soil model (section 9). |
| The simulator README says automatic trigger execution is not simulated; that line is stale against `triggers.ts:171-213`, the scheduling in `demo/model.ts:230-248` and `tests/triggers.test.ts` (TR02 runs the daily event) | `web/react-gui/demo/README.md` ("Expand Trigger-based irrigation...") | Cite code, not the README, when explaining Tier 4; flag the README line for correction in the simulator PR |
| `osi-daily-scheduler/decision.js`, named in the project brief, does not exist in this checkout | `ls conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` lists no `osi-daily-scheduler` | Do not design on it. The legacy trigger in the simulator is the ported daily decision. |
| The host protocol exposes time, next event, language and guide steps, but not routes or screens opened | `web/react-gui/demo/protocol.ts:11-19` | Logging "phone screens opened" needs new instrumentation (section 8.3). |

---

## 6. OSI integration UX

### 6.1 The phone

- The phone is a physical item. Raising it pauses world input (not world time, unless the facilitator setting "pause while phone open" is on, default on for classroom).
- The screen is the **real OSI OS edge React app** running against the simulator's in-memory REST model (`web/react-gui/demo/adapter.ts`, `model.ts`) **[REPO]**. Game-specific chrome sits outside the app frame (battery, signal, time).
- Before Tier 1 the phone has only calls, messages (NPC texts, extension SMS tips, labelled as game content) and a radio forecast.

### 6.2 Tier definitions (proposed; owner decision)

The repo has no "Tier 1–4" vocabulary for this purpose (the only "tier" usage is the ET0 source precedence in `docs/superpowers/specs/2026-09-26-daily-agronomy-design.md`) **[REPO]**. Proposal:

| Tier | Name in game | Hardware in the world | Real OSI code that produces what the player sees | What changes in play | Costs and failure modes |
|---|---|---|---|---|---|
| T0 | No OSI | — | — | Eyes, hands, feel test, plant cues, radio forecast | Labour and guesswork |
| T1 | **Know your soil** | Soil probe at 20 and 40 cm, gateway | Real app soil cards, SWT colour categories (`src/utils/swt.ts:41-42`), history charts with 7/30/90 d (`demo/README.md`) | Information: root-zone tension by depth, history after rain or irrigation. No labour saved. | Kit price; battery; placement error (probe reads one spot); link drops; the player still decides everything |
| T2 | **Know the demand** | T1 plus an in-world weather station, and a zone crop and stage | Water tab: ET0 from real `et0.js` on the station's hourly aggregates of game weather (station tiers; any forecast is a labelled fictional input), Kc from the real catalogue, ETc = ET0 × Kc (`demo/model/environment.ts:79`), forecast rain | Information about *how much*: daily crop water use in mm, which converts to litres per bed | Subscription or station cost **[TUNE]**; wrong crop stage setting gives a wrong Kc; forecast error |
| T3 | **Water from your phone** | T1 plus valve on a tank and drip line | Real timed open and close (`demo/model/irrigation.ts:29-78`), weekly plans (`demo/model/plans.ts`) | Labour saved: no carrying to the bed; can irrigate while at the market. Pumping into the tank is still labour (or a solar pump cost). | Valve and drip kit cost; tank must be full; valve battery; a timed open sent while the valve is already open is ignored, as in the current edge flow (`PRODUCTION-HOOKS.md`) |
| T4 | **Automatic trigger** | T3 | Real legacy daily trigger: 06:00 evaluation of mean SWT versus threshold, fixed duration, debounce, busy-valve skip (`demo/model/triggers.ts:171-213`); which app surface displays the evaluation record and its advisory text is to be verified in M1 | Automation of *when*. Player sets threshold, metric (SWT_1, SWT_2, average) and duration. | Wrong threshold or duration over- or under-waters; runs only once a day at 06:00; empty tank means a "started" run delivers nothing; no data means no run (`no_data_last_hour`) |
| T5 (optional) | **Experimental: conditional irrigation** | T3 | `osi-irrigation-policy` evaluate, observations and occurrences | Not shown by default | Not qualified in OSI (`controller-semantics.md:42`). Show only if the owner approves, with an "experimental, not shipped" label. |

Unlock paths (any one, by scenario): cooperative group purchase, savings group loan, an extension demo loan (time-limited), an NGO grant with reporting obligations, or direct purchase. In research scenarios the facilitator assigns the tier.

### 6.3 How each tier avoids being a magic button

| Trade-off | How the game shows it |
|---|---|
| Money | Kit prices compete with school fees and seed; loans have service charges |
| Maintenance | The real Kiwi card shows a battery percentage from `latest_data.bat_pct` (`web/react-gui/src/components/farming/KiwiSensorCard.tsx:467`) **[REPO]**, but the simulator's synthetic Kiwi readings emit no `bat_pct` (only LSN50, UC512 and the field tester do, `demo/model/readings.ts:53, 90-91`). The sensor bridge must write `bat_pct` from world battery state. Valve battery display is to be verified in M1; until then it is game chrome outside the phone. A world task replaces batteries. |
| Sensor placement | The probe reads its own tile and depth. If it sits outside the drip wetted zone, the real trigger keeps irrigating a bed that is already wet. The season report shows "probe tile versus bed average". |
| Connectivity | Link drops create gaps in the app history and `no_data_last_hour` in the trigger log |
| Fixed schedule | Tier 4 evaluates only at 06:00. A heatwave starting at 07:00 waits until tomorrow. |
| Duration is the farmer's choice | The trigger never decides how much. Tier 2 helps convert ETc into minutes of drip with a calculator that uses tank flow rate. The calculator is game content, shown outside the phone frame and labelled as such. |
| Water source | Automation cannot create water. An empty tank or dry well stops irrigation regardless of tier. |

### 6.4 NPC farmers using OSI

Joseph's demo plot is a second irrigation zone in the same simulator model, with his own probe and valve. His Tier 4 trigger runs through the same `evaluateAutomaticTriggers` call on the same clock. Visiting him lets the player open his phone and see the real app for his zone. If the game ever shows "Joseph's OSI recommended X", X must come from that call.

---

## 7. Education design

### 7.1 Learning objectives

| # | Objective (the player can...) | Where it is taught | Where it is assessed |
|---|---|---|---|
| LO1 | Explain soil water holding capacity and why sand and loam differ | Feel test; two soil plots in tutorial; moisture lens | Quiz; choosing irrigation interval per soil |
| LO2 | Locate the root zone and explain why sensor depth matters | Probe install mini-game; 20 versus 40 cm curves after watering | Quiz; probe placement in scenario |
| LO3 | Name the weather drivers of crop water use (sun, heat, wind, dry air) and relate ET to daily demand | Hot windy day versus cloudy day; Tier 2 ETc | Quiz; predicting which day needs more water |
| LO4 | Separate *when* to irrigate (soil tension) from *how much* (demand, root-zone deficit) | Tier 1 versus Tier 2; Tier 4 duration setting | Scenario: set threshold and duration |
| LO5 | Apply deficit irrigation: accept mild stress in tolerant stages to save water | Mid-game quest; Ky explained in plain language | Season report: water productivity versus yield |
| LO6 | Compute and interpret water productivity (kg/m³) | Season report | Quiz item with numbers |
| LO7 | Read SWT in kPa: higher means drier; the app's wet, moist and dry colour bands are display categories, not prescriptions for every crop and soil | Phone tutorial with the real app | Quiz; scenario with sandy soil where 20–30 kPa is already late for tomato (a search summary reported Florida trials on sandy soil favouring 10–20 kPa triggers for tomato; the URL it gave did not contain the study when fetched, so this needs a primary source before use, **[UNVERIFIED]**) |
| LO8 | Manage risk: forecast uncertainty, diversifying crops, savings, water source backup | Small Rains season; events | Multi-season outcome; reflection prompts |
| LO9 | Weigh labour, water and money for each OSI tier | Tier unlocks; season report comparison | Counterfactual replay discussion |

### 7.2 Scaffolding and tutorial flow

| Step | Day | Content | Mechanic introduced |
|---|---|---|---|
| 1 | 1 | Arrive at the plot; Officer Asha greets; move, pick up a can | Movement, interaction |
| 2 | 1 | Fetch water from the shared well; see stamina drop | Water is labour |
| 3 | 2 | Water seedlings; feel test before and after | Soil water, feel test |
| 4 | 3 | Hot windy day: plants roll leaves at noon and recover at night | Plant cues, ET intuition |
| 5 | 4 | Moisture lens unlocked "as a learning aid" (game content) | Root zone visual |
| 6 | 5 | Field day at Joseph's demo plot: see the probe and real app | OSI introduction |
| 7 | 6 | Demo kit loan: install probe (mini-game), open the app | Tier 1 |
| 8 | 7–10 | Dry spell: follow readings at 20 and 40 cm after irrigation | Depth response |
| 9 | 11 | Season mini-report and reflection questions | Feedback |

Hints fade: after three successful decisions the guide stops prompting. Facilitators can turn hints off.

### 7.3 Feedback

- **Immediate:** plant posture, soil colour, a splash or runoff animation, stamina.
- **Daily (evening reflection):** litres applied, litres lost (runoff, deep percolation, evaporation estimate), labour minutes, plant stress summary.
- **Season report** (section 7.4).
- **Journal:** short plain-language explanations unlocked by experience ("Why did the 40 cm reading change a day later?").

### 7.4 Season report

| Metric | Definition | Display |
|---|---|---|
| Yield | kg harvested (marketable, from the crop model) | Number and bar compared with potential |
| Irrigation water applied | m³ delivered to the field from all sources | Number; split by source |
| Effective rain | mm rain stored in root zone | Number |
| Water lost | Runoff + deep percolation + soil evaporation, m³ (world model) | Stacked bar |
| Water productivity (irrigation) | Yield kg ÷ irrigation water m³ | kg/m³, compared with neighbours |
| Water productivity (total) | Yield kg ÷ (irrigation + effective rain) m³ | kg/m³ |
| Labour hours | Hours spent on water (fetch, carry, pump, apply) and other field work | Hours; split |
| Income | Sales − input costs − water fees − OSI costs − loan charges | Currency |
| Stress days | Days with mean Ks < 0.8 in the root zone (world model) | Timeline strip |
| Neighbour comparison | Same metrics for each NPC strategy on the same weather | Table: Baraka (calendar), Neema (feel), Joseph (OSI T4), Rehema (rainfed) |
| Counterfactual (research and facilitator mode) | Same season replayed with another tier | Side-by-side |

### 7.5 Assessment hooks

- Optional pre-quiz and post-quiz (8–12 items), stored only in the local log, off by default.
- Sample items: "The probe at 20 cm reads 60 kPa and at 40 cm reads 25 kPa. What happened?"; "Which day uses more water: 30 °C, windy and dry, or 24 °C, cloudy and humid?"; "Yield 120 kg with 8 m³ of irrigation. What is the water productivity?"; "The app shows 'moist' (35 kPa). Should a tomato on sandy soil be watered?"
- In-game performance probes: placement choice; threshold choice versus scenario optimum; response time to stress cues.

### 7.6 Facilitator (teacher) mode

| Feature | Description |
|---|---|
| Scenario picker | Pre-built fixed-seed scenarios (dry spell, sandy soil, broken pump, Small Rains failure) |
| Locks | Tier, moisture lens, hints, day length, pause-on-phone |
| Class code (offline) | A short code encodes scenario, seed, tier and settings so all devices in a room play the same run without a server |
| Projector view | Large-font season report and neighbour comparison |
| Debrief kit | Printable discussion questions per scenario (docs, not in-game) |
| Export | Collect players' exported log files manually (USB, shared folder); no upload in v1 |

---

## 8. Validation and data collection

### 8.1 Research questions (candidates)

| # | Question | Design | Primary metric |
|---|---|---|---|
| RQ1 | Do players with OSI tiers use less irrigation water for the same yield? | Between-subject tier assignment, fixed seed | Irrigation water m³ at matched yield; water productivity |
| RQ2 | Do players learn to read SWT? | Pre/post quiz; in-game decisions after reading the app | Quiz gain; decision consistency (8.4) |
| RQ3 | Which tier gives the best labour, water and yield trade-off under identical weather? | Counterfactual replay, within-subject | Labour hours, m³, kg, income |
| RQ4 | Do players follow or override real OSI outputs, and when? | All tiers | Follow rate (8.4), override reasons (optional prompt) |
| RQ5 | How do sensor placement errors affect outcomes, and do players notice? | Seeded scenarios with a misplaced probe | Detection time; water lost |
| RQ6 | Does the real OSI app UI support correct interpretation by first-time users? (UX validation of OSI itself) | Screen-open logs, task completion | Time to find a reading; misreads |

External validity caveat: results describe behaviour in the game world model. They validate the OSI UX and decision logic as players use them, and they indicate learning; they do not prove field water savings.

### 8.2 Experiment modes

| Mode | Description | Determinism needs |
|---|---|---|
| Fixed-seed scenario | Same weather, events, prices, NPC behaviour for everyone | Master seed; world events on the shared clock |
| Counterfactual replay | After a season, replay from the same start snapshot with another tier; optional "ghost" of the first run | Snapshot plus seed; clock restart (no rewind, `clock.ts:53`) |
| A/B tier assignment | Facilitator code or a local random draw assigns T0–T4; recorded in the log | Assignment logged before play |
| Oracle baseline | Offline computation of a good irrigation schedule for the seed (world model only, labelled as such) | Same world model; never shown as OSI |
| NPC baselines | Calendar, feel, OSI T4 and rainfed neighbours on the same seed | Shared world |

### 8.3 What to log (local, append-only)

Format: JSON Lines, one event per line, each line carrying the SHA-256 of the previous line (the simulator already has `demo/model/sha256.ts`) **[REPO]** so tampering or truncation is detectable.

| Field | Content |
|---|---|
| `seq` | Monotonic integer |
| `sim_time` | Simulation clock ms (UTC) |
| `wall_offset_s` | Seconds since session start (no absolute wall time by default) |
| `session_id` | Random local ID, regenerated per export; no device or person identifier |
| `scenario_id`, `seed`, `build_hash`, `tier`, `settings` | Run context |
| `type` | Event type (below) |
| `payload` | Type-specific data |
| `prev_hash` | Hash chain |

| Event type | Payload | Source |
|---|---|---|
| `irrigation_manual` | Tile(s), method, litres, source | Game |
| `water_fetch` | Source, litres, minutes, queue | Game |
| `valve_command` | Open duration, close, result | Adapter (real model call) |
| `plan_change` | Plan before and after | Adapter |
| `trigger_config` | Metric, threshold, duration, enabled | Adapter |
| `trigger_evaluation` | The real `TriggerEvaluation` record (status, reason, value, threshold, duration, advisory) | Model (`triggers.ts:7-20`) |
| `api_read` | REST path read by the app (proxy for screens opened) | Adapter instrumentation (new) |
| `screen_view` | Route shown in the phone app | New route-change message (new protocol message) |
| `reading_shown` | Device, channel, value, category when a soil card is visible | App instrumentation (new; needs care to avoid touching production code, section 11) |
| `sensor_install` | Tile, depth, quality score | Game |
| `world_daily` | Per-tile depletion summary, Ks, ET0, rain, ETc | World model |
| `harvest`, `sale`, `purchase`, `loan` | Amounts | Game |
| `quiz_answer` | Item, answer, correct | Game (if enabled) |
| `hint_shown`, `lens_toggled` | — | Game |

### 8.4 Metric definitions

| Metric | Definition |
|---|---|
| Irrigation water use | Σ litres delivered to the field from all sources ÷ 1000 (m³) |
| Water productivity, irrigation (WPi) | Marketable yield kg ÷ irrigation m³ |
| Water productivity, total (WPt) | Marketable yield kg ÷ (irrigation m³ + effective rain m³) |
| Water labour hours | Σ minutes in fetch, carry, pump, apply ÷ 60 |
| Stress exposure | Σ over days of (1 − mean root-zone Ks), weighted by stage Ky |
| Recommendation shown | Only real outputs count: (a) a soil reading with its app colour category was visible on the phone, or (b) a `trigger_evaluation` record was created (T4) or its advisory was visible |
| Followed (information tiers) | Within 24 h of a shown "dry" category, the player irrigated that zone; within 24 h of a shown "wet" category, the player did not. "Moist" is neutral. This is a consistency measure, not a judgment that the category was right for the crop. |
| Override (T4) | Player irrigated manually within 24 h after a `below_threshold` evaluation, or disabled the trigger or closed the valve during a `started` run |
| SWT reading accuracy | Quiz items plus in-game prompts ("Is the 40 cm layer wetter than the 20 cm layer?") |
| Placement error detection | Time from a misplaced probe install to a corrective action (move probe, change metric) |

### 8.5 Privacy and consent

- **No network telemetry in v1.** The game makes no requests after install, apart from PWA updates if the owner wants them (owner decision).
- Logs stay on the device. Export is a user action that produces a file; the player can view the file before sharing.
- No names, accounts, device IDs, location or free text by default. An optional free-text reflection field is off by default and flagged in the export.
- Consent screen before any research scenario that turns on logging, with plain-language text in the player's language. Minors: facilitator-led consent; the owner decides the procedure with partner ethics boards.
- Hosting, data retention, consent text and ethics review are owner decisions.

---

## 9. Technical architecture (game-side view)

| Layer | Owner | Notes |
|---|---|---|
| World model: weather, soil water per tile and layer, crop growth, labour, economy, NPC habits | Game (new, TypeScript, deterministic) | Runs on the shared `SimulationClock` |
| Sensor bridge | Game (new) | Samples world soil tension at the probe's tile and depth at the device interval (simulator default 30 min, `controller-semantics.md`) and writes `ReadingSample`s, replacing `ReadingLedger.sampleValues` sine output (`demo/model/readings.ts:13`) |
| Weather bridge | Game (new) | Turns game weather into in-world station hourly aggregates, runs real `et0.js` on them, and writes the environment records (`demo/model/environment.ts`) in place of the fictional fixture. Any forecast is a labelled world input. |
| Valve bridge | Game (new) | When the real model opens a valve, the world delivers tank water through the drip line at a flow rate; an empty tank delivers nothing |
| OSI model | Existing simulator model, adapter and real React app | Unchanged logic; ported code stays pinned by its port tests |
| Phone UI | Real edge React app in an iframe | Existing |
| Logging | Game (new) | Hash-chained JSONL; adapter-level instrumentation |

Rule of thumb: raw inputs on the phone (sensor readings, station weather, a labelled forecast) come from the world, exactly as uplinks reach a real gateway. Anything derived, advised or actuated on the phone (categories, ET0, ETc, trigger decisions, valve runs) comes from OSI code. Game-side aids such as the drip-minutes calculator are shown outside the phone frame.

---

## 10. Vertical slice (M1) and roadmap

### 10.1 M1 vertical slice: the smallest playable that proves the loop

| Element | Scope |
|---|---|
| Map | One farm: house, yard, one 8 × 8 tile tomato bed (about 64 m², **[TUNE]**), path to a shared well (150 m) and a raised 1000 L tank with hand pump and drip line |
| Crop | `tomato` (catalogue entry, `verified: true`), starting at crop development stage with `stage_started_on` set to match |
| Span | 21 in-game days in the Short Dry with one seeded dry spell; one fixed seed plus two alternates |
| Weather | Seeded daily rain, temperature, humidity, wind, radiation; ET0 from real `et0.js` |
| Soil | One soil type (sandy loam), three layers, FAO-56 bucket model, van Genuchten tension |
| Labour | Carrying (can, bucket) versus pumping into the tank and opening the drip line |
| Phone | Real OSI app; debug and research panel with T0–T4 toggles (T1 probe, T2 ET0/ETc, T3 valve, T4 trigger) |
| Plant cues | Leaf rolling and wilting from Ks |
| Report | End-of-slice season report with water, yield estimate, labour, WP and one NPC comparison (calendar strategy) |
| Log | Local hash-chained JSONL with export |
| Platforms | Desktop Chrome and one mid-range Android phone |

M1 exit criteria:
1. A tester can finish 21 days in under 45 minutes at classroom speed.
2. The same seed and inputs give identical logs (determinism test).
3. The real trigger, timed valve and plans port tests still pass unchanged.
4. Every number on the phone traces to OSI code (a reviewer checklist against section 5.2).
5. Frame rate and memory measured on a low-end Android phone with the app iframe open.
6. Playtest: at least 5 players can explain why the 40 cm reading lags the 20 cm reading.

### 10.2 Roadmap

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M1** Vertical slice | Section 10.1 | Section 10.1 |
| **M2** Full season and economy | Full Big Rains or Short Dry season; market days, prices, input costs, savings group, credit; tier purchase paths; stage-weighted Ky; events (dry spell, broken pump, flat battery); evening reflection | A full season playable; economy balanced so T0 is viable but labour-heavy; season report complete |
| **M3** NPCs, community, multiple crops | All neighbour strategies on the shared world; Joseph's OSI zone; extension officer quests; cooperative; maize, sorghum, beans, onion, sweet potato; multi-year progression; second soil type | NPC comparisons meaningful under identical weather; relationships and progression tracks working |
| **M4** Research modes and localisation | Facilitator mode, class codes, counterfactual replay, A/B assignment, quizzes, consent flow, log viewer; game strings in the OSI app's locales with human review | Pilot with one classroom and one farmer group (owner-run); export files validated against the schema |
| **M5** Polish, audio, mobile | Original music and ambient sound, voice-over hooks, accessibility (colour-blind safe palette, text size, one-hand touch), PWA install and offline audit, performance on low-end Android | Store-quality build; offline install verified; accessibility checklist passed |

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Something on the phone looks like OSI advice but is game logic or a demo fixture (the "Action" tile, fixture ET0) | Breaks the honesty constraint; misleads farmers | Section 5.2 checklist in every review; hide or relabel the tile; replace ET0 fixture |
| Players or audiences read game outcomes as field evidence of OSI water savings | Overclaiming | Report labels ("in this simulated season"); research write-ups state world-model limits |
| Crop catalogue stage lengths are Mediterranean, not tropical semi-arid | Wrong Kc timing | Explicit `stage_started_on`; owner decision on a regional catalogue variant |
| The real app plus game canvas is too heavy on low-end Android | Excludes the main farmer audience | Measure in M1; lazy-load the app iframe; lower canvas resolution |
| Production-code changes needed for screen logging | Touches the shipped edge app | Prefer adapter-level logging; any app hook behind the existing public-simulator compile-time flag (`PRODUCTION-HOOKS.md`) |
| Simulator host speeds are limited to 1/10/60 | Classroom pacing | Drive `advanceTo` in-process |
| The trigger's same-day debounce uses the UTC date, not the farm date (`triggers.ts:167-169, 200`) | At UTC+3 this does not matter for a 06:00 evaluation, but it could confuse a tutorial that explains "once per day" in other time zones | Keep as ported; explain as "once per day" in the farm's zone |
| Similarity to existing farming games | Legal and reputational | Section 2 art and UI rules; external review of character, map and UI drafts |
| Water-carrying portrayal feels exploitative or stereotyped | Audience trust | Player chooses character; balanced chores; review by people from comparable communities |
| Determinism breaks through floating point or event ordering | Invalid counterfactuals | Single clock; seeded PRNG; determinism test in CI |
| Luganda and other locales partly untranslated | Learning barrier | Human review before research use; English fallback flagged |

---

## 12. Open questions for the owner

1. Tier definitions: accept T0–T4 as proposed in section 6.2? Should the unqualified conditional policy appear at all as an experimental T5?
2. The dashboard "Action" tile: hide it in the game, or keep it with its "simulated" label?
3. Region and calendar: keep a fully fictional bimodal climate, or calibrate rainfall statistics to a named real climate zone (without naming places in the game)?
4. Crop calendar: accept Mediterranean-row stage lengths with explicit stage dates, or commission a regional Kc and stage-length variant?
5. Consent, ethics review, data retention and hosting for research use; whether the PWA may check for updates online.
6. Which audience the first pilot targets (classroom or farmer group), since it changes M2 and M4 priorities.
7. Game title, character and place names: name clearance and cultural review process.
8. Whether the game code lives in osi-os (`web/react-gui/demo` neighbour) or a new repository, given osi-os is public and the simulator is imported.

---

## Sources

Repository (this worktree, HEAD 4682fb17b1):
- `web/react-gui/demo/model/clock.ts`, `model/readings.ts`, `model/triggers.ts`, `model/irrigation.ts`, `model/plans.ts`, `model/environment.ts`, `protocol.ts`, `runtime.ts`, `fixtures.ts`, `water-copy.ts`, `README.md`, `agronomy.md`, `controller-semantics.md`, `PRODUCTION-HOOKS.md`, `tests/triggers.test.ts`
- `web/react-gui/src/utils/swt.ts`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/crop-kc.json`, `osi-agronomy-daily/et0.js`, `osi-irrigation-policy/evaluate.js`
- `docs/superpowers/specs/2026-09-26-daily-agronomy-design.md`

Web:
- FAO-56 chapter 8 (TAW, RAW, p, Table 22): https://www.fao.org/4/x0490e/x0490e0e.htm
- FAO-56 Table 19 (soil water characteristics): https://www.fao.org/4/x0490e/x0490e0c.htm
- FAO-33 Ky values as reproduced by FAO: https://www.fao.org/4/Y3655E/y3655e04.htm (maize, beans confirmed); https://fao.org/4/i2800e/i2800e02.pdf (tomato, sorghum unverified)
- FAO indicative field application efficiencies: http://www.fao.org/4/t7202e/t7202e08.htm
- East African bimodal rainfall: https://doi.org/10.1038/s43017-023-00397-x
- Water collection burden: https://www.unicef.org/press-releases/women-and-girls-bear-brunt-water-and-sanitation-crisis-new-unicef-who-report ; https://www.unicef.org/press-releases/unicef-collecting-water-often-colossal-waste-time-women-and-girls
- VSLA methodology: https://www.vsla.net/the-vsla-methodology
- Tomato tensiometer thresholds on sandy soil: no verified source yet (the search-result URL did not contain the study)
- van Genuchten parameters (candidate, unverified column order): https://apps.dasnr.okstate.edu/SSL/soilphysics.okstate.edu/software/water/conductivity.html
