# Agroscope-Style Dendrometer Irrigation Controller — Design

**Status:** Draft for review
**Date:** 2026-05-29
**Owner:** Project-OSI
**Upstream reference:** Agroscope Agro Dendro (`Tree_HSMM`, `Tree_irrigator`, see `randd/20260331_model_explanation.ipynb` in their repo)

## 1. Goal

Port Agroscope's dendrometer-driven irrigation logic (`Tree_HSMM` + `Tree_irrigator`) into OSI OS so that, on zones the operator opts in, the OSI system produces *the same irrigation recommendation* as the Agroscope reference system given identical inputs. Publish all dendrometer-related data (raw uplinks, derived metrics, decisions) to the Agroscope server so their team can independently verify convergence.

The existing OSI scheduler (kPa thresholds, `irrigation_schedules`) remains untouched on zones that don't opt in.

### 1.1 Non-goals

- We are not replacing the existing OSI scheduling logic. It continues to be the default and the long-term primary controller for non-opted-in zones.
- We are not automating valve actuation for dendrometer-controlled zones. The controller produces a *recommendation*; the farmer triggers irrigation manually via the GUI. (Future: revisit auto-actuation once parity is proven.)
- We are not designing the Agroscope-side ingestion pipeline. We define the OSI-side publisher contract; Agroscope owns their ingestion adapter.
- We are not modelling "tree" as a first-class entity. A tree is identified by its dendrometer DevEUI (one LSN50 per tree).

## 2. Operational model

Each `irrigation_zones` row gains a `controller_mode` column with two values:

- `schedule` (default) — legacy OSI scheduling logic actuates; the Agroscope-style controller does not run for this zone.
- `dendrometer` — the Agroscope-style controller is the source of truth for irrigation recommendations on this zone; legacy scheduling logic continues to compute for this zone but only as a *shadow* recommendation surfaced in the Advanced Lab.

In `dendrometer` mode the controller uses the **full Agroscope pipeline**: MeteoSwiss OGD for VPD and rain, Tree_HSMM, Tree_irrigator. It does **not** mix in S2120 or our kPa-based logic — the two pipelines do not share inputs.

Selecting `dendrometer` mode is rejected at the API when:
- The zone has no dendrometer devices, OR
- The zone has no latitude/longitude, OR
- The zone's location is outside MeteoSwiss coverage (no closest forecasting point can be resolved).

### 2.1 Aggregation across multiple dendrometers per zone

A zone can have multiple dendrometers (one per tree). Each tree carries its own learning state (`vpd_threshold`, `kc_factor`, `req_precip_mm`, `cumulative_vpd`, `last_water_event_at`).

- **Decision**: `irrigate = max(P(Dry)_tree) ≥ 0.8` — worst-tree-wins.
- **Amount**: `req_precip_mm = max(req_precip_mm_tree)` — enough water for the driest tree.
- **Reset on irrigation**: when the farmer triggers irrigation, every tree in the zone receives a `register_irrigation(applied_mm)` call.

### 2.2 Decision-to-actuation flow

The controller does not open valves on its own. Instead:

1. Controller computes per-zone `recommendation`: `{action: "OPEN"|"HOLD", duration_min: int, p_dry: float, mds_um: int, req_precip_mm: float, computed_at: timestamp}`.
2. Recommendation is published to the React GUI in the existing Water tab (see §7 UI).
3. The farmer presses an **Irrigate** button. The minutes field is pre-filled from `duration_min` but is editable.
4. The actual STREGA open uses the existing manual-actuation path (no new actuator code).
5. On STREGA close, the controller observes the close event, computes `applied_mm` (flow-meter delta when available, else `duration_min × mm_per_minute_open`), calls `register_irrigation(applied_mm)` on every tree in the zone, resets `cumulative_vpd` to 0, and updates `last_water_event_at`.

Manual operator actions (open/close from the React GUI, regardless of which mode the zone is in) are always treated as water events.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Pi (edge)                                                │
│ ┌────────────┐  ┌─────────────────┐  ┌────────────────┐  │
│ │ Node-RED   │  │ osi-agroscope-  │  │ React GUI      │  │
│ │ flows.json │──┤ controller       ├──┤ (Water tab,   │  │
│ │ + helpers  │  │ (new helper)     │  │ Advanced Lab) │  │
│ └─────┬──────┘  └────────┬─────────┘  └────────┬───────┘  │
│       │ ChirpStack/      │ MeteoSwiss OGD     │ HTTP     │
│       │ LoRa uplinks     │ (HTTPS public)     │          │
│       │                  ▼                    │          │
│       │           cached weather              │          │
│       │           (in SQLite)                 │          │
│ ┌─────▼────────────────────────────────────────▼──────┐  │
│ │ farming.db                                          │  │
│ │ • irrigation_zones (extended)                       │  │
│ │ • agroscope_tree_state, _params, _decisions, _mds   │  │
│ │ • agroscope_weather (MeteoSwiss cache)              │  │
│ └─────┬───────────────────────────────────────────────┘  │
└───────┼──────────────────────────────────────────────────┘
        │ existing sync (events/bootstrap/pending-commands)
        ▼
┌──────────────────────────────────────────────────────────┐
│ osi-server (OSI cloud)                                   │
│ • mirrors edge tables                                    │
│ • surfaces Advanced Lab (read-only)                      │
└─────────┬────────────────────────────────────────────────┘
          │
          ▼ (independent stream)
┌──────────────────────────────────────────────────────────┐
│ Agroscope server (cloud)                                 │
│ Three streams from edge (transport: MQTT or REST, TBD):  │
│ • raw_uplinks      — every dendrometer uplink            │
│ • derived_metrics  — per-zone-per-hour VPD, MDS, cum_vpd │
│ • decisions        — per-decision P(Dry), req_precip,    │
│                       applied_mm, learned params         │
└──────────────────────────────────────────────────────────┘
```

### 3.1 Where the logic lives

- **Edge (Pi, Node-RED + helper module)** is authoritative for the controller. Offline-first: a Pi without internet keeps computing recommendations from cached MeteoSwiss data until the cache ages out (then dendrometer mode degrades gracefully — recommendation surfaces as "stale, fetch failed", farmer can still operate manually).
- **osi-server (cloud)** is the same role it plays today: a sync mirror plus the host of the Advanced Lab view. It does not make decisions.
- **Agroscope server** is the independent verifier. It receives the three streams, runs *its own* Tree_HSMM / Tree_irrigator on the data, and compares decisions to ours.

## 4. Inputs

### 4.1 MeteoSwiss OGD (VPD + rain)

When a zone is in `dendrometer` mode, the controller pulls hourly weather from MeteoSwiss OGD using their local-forecasting STAC endpoint (mirrors Agroscope's `get_weather.py:get_local_forecast`):

- **Endpoint**: `https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-local-forecasting/items`
- **Parameters pulled**: `tre200h0` (temp °C), `gre000h0` (radiation W/m²), `fu3010h0` (wind m/s), `rre150h0` (precipitation mm)
- **Per-zone identifier**: nearest `point_id` resolved from zone lat/lon via the OGD point metadata (same `get_closest_station` logic Agroscope uses).
- **Cadence**: hourly cron in Node-RED, at HH:10 (MeteoSwiss publishes near the top of the hour with a few minutes of latency).
- **VPD computation**: FAO method — `e_s = 0.6108 × exp(17.27T / (237.3+T))`, `e_a` derived from daily-min temperature, `VPD = max(0, e_s − e_a)`. This is verbatim from Agroscope's `get_weather.py:138-147`.
- **Caching**: persisted to a new `agroscope_weather` table on the edge, keyed by `point_id + timestamp`. The measured-vs-forecast reconciliation pattern from Agroscope's `check_and_update_weather_data` is reproduced (5-state state machine: `insert | update_to_measured | update_forecast | skip_duplicate | skip_keep_measured`).
- **Forecast retention**: 7 days, then pruned (matches Agroscope's `cleanup_old_forecast_data`).

If the MeteoSwiss fetch fails for a zone for more than 2 hours, the controller surfaces a stale-data warning in the Water tab and refuses to update its recommendation until fresh data arrives. The farmer can still irrigate manually.

### 4.2 Dendrometer readings

- Source: the existing `dendrometer_readings` table (LSN50 ratiometric mode), filled by the existing `osi-dendro-helper` pipeline.
- The controller reads `positionUm` per uplink. No changes to the existing dendrometer ingestion.

### 4.3 Water-event detection (cumulative VPD reset)

`cumulative_vpd_since_reset` resets to zero when:
- Any rain ≥ 0.1 mm/hr observed in MeteoSwiss data for the zone, **OR**
- Any irrigation event closes on the zone (any duration > 0).

**TODO** (acknowledged in §10): Agroscope's threshold rule is not yet finalised. Both thresholds are exposed as per-zone parameters (`vpd_reset_threshold_mm_rain`, `vpd_reset_threshold_mm_irrigation`) so we can move from "any" to "≥X mm" when Agroscope publishes their rule, without code changes.

## 5. Algorithm

### 5.1 Maximum Daily Shrinkage (MDS)

Computed once per day at 02:00 zone-local time over the **predawn-to-predawn window** (02:00 day N-1 → 02:00 day N):

- `daily_min_position_um = min(positionUm)` over the window
- `daily_max_position_um = max(positionUm)` over the window
- `daily_mds_um = daily_max_position_um - daily_min_position_um`
- `baseline_position_um` = the install-time baseline already tracked by `osi-dendro-helper.computeDendroStemChangeUm.baselineState.positionMm * 1000`
- `mds_fraction = daily_mds_um / baseline_position_um` (the dimensionless input the HSMM consumes)

The "% diameter loss" framing in Agroscope's notebook is replaced by **µm shrinkage normalised against the install-time dendrometer baseline**. This deviates from Agroscope's `mds_inflection = 1.15` calibration; their HSMM parameters will need to be re-tuned to match this convention, which is acknowledged as their responsibility. All HSMM parameters are tunable per zone (or via a global default) without code changes — see §6.

### 5.2 Tree_HSMM (per tree)

Direct port of Agroscope's `Tree_HSMM` class, naming preserved 1:1 for diff-review compatibility:

```
prior_dry  = sigmoid(vpd_steepness × (cumulative_vpd − vpd_threshold))
l_dry      = sigmoid(mds_steepness × (mds_fraction − mds_inflection))
l_wet      = 1 − l_dry

post_dry   = prior_dry × l_dry^weight
post_wet   = (1 − prior_dry) × l_wet^weight
p_dry      = post_dry / (post_dry + post_wet)
```

Online feedback:
- If `mds_fraction < mds_inflection` AND `cumulative_vpd > vpd_threshold` → `vpd_threshold += lr_vpd`.
- If `mds_fraction > mds_inflection` AND `cumulative_vpd < vpd_threshold` → `vpd_threshold -= lr_vpd`.

Initial parameter values (per Agroscope's notebook, all overridable per tree):
- `vpd_threshold = 50.0`, `vpd_steepness = 0.1`
- `mds_inflection = 1.15`, `mds_steepness = 6` *(TODO: re-tune for our µm/baseline convention — see §10)*
- `weight = 2`, `lr_vpd = 5`

### 5.3 Tree_irrigator (per tree)

Direct port:
```
req_precip += kc_factor × daily_accumulated_vpd

if req_precip > 5.0 and p_dry < 0.2:
    kc_factor   -= learning_rate × 0.01
    req_precip  *= 0.9
elif req_precip <= 2.0 and p_dry > 0.8:
    kc_factor   += learning_rate × 0.05
    req_precip  += 2.0

register_irrigation(amount_mm):
    req_precip = max(0, req_precip − amount_mm)
```

Initial values (overridable per tree): `kc_factor = 1.0`, `learning_rate = 0.1`.

Note: Agroscope's notebook has a typo (`self.k_factor` instead of `self.kc_factor`). We use `kc_factor` consistently.

### 5.4 Update cadence

- **Daily run** at 02:00 zone-local time: MDS computed for previous predawn-to-predawn window, Tree_HSMM and Tree_irrigator updated, recommendation refreshed.
- **Post-irrigation run**: triggered immediately after STREGA close. `register_irrigation(applied_mm)` is called on every tree in the zone. `cumulative_vpd` is reset to 0. `last_water_event_at` is set. New recommendation is computed and surfaced.

### 5.5 Applied mm calculation

`applied_mm` for the post-irrigation update is determined in this order:
1. Flow meter delta during the open window, if a flow meter is bound to the zone (`irrigation_zones.flow_meter_deveui`).
2. Otherwise, geometry-derived: `applied_mm = duration_min × mm_per_minute_open`, where `mm_per_minute_open = (dripper_capacity_l_h × drippers_per_m2) / 60`, and `drippers_per_m2 = 1 / (distance_between_drippers_m × distance_between_lines_m)`.

The flow-meter integration is a separate work item; this spec assumes its absence as the default state.

## 6. Schema changes

### 6.1 Extensions to existing tables

`irrigation_zones`:
- `controller_mode TEXT NOT NULL DEFAULT 'schedule'` — `'schedule' | 'dendrometer'`
- `dripper_capacity_l_h REAL` — Agroscope's `area.dripper_capacity`
- `distance_between_drippers_m REAL`
- `distance_between_lines_m REAL`
- `distance_between_trees_m REAL`
- `flow_meter_deveui TEXT` — nullable FK to a LSN50 MOD9 device acting as the zone's flow meter

`area_m2` is the existing canonical surface column; we do not introduce Agroscope's `surface` as a duplicate.

### 6.2 New tables

`agroscope_weather` — MeteoSwiss cache:
- `id INTEGER PRIMARY KEY`
- `point_id TEXT NOT NULL` — MeteoSwiss forecasting point id
- `timestamp DATETIME NOT NULL` — UTC, hour-aligned
- `temperature_c REAL`, `radiation_w_m2 REAL`, `wind_m_s REAL`, `precipitation_mm REAL`
- `vpd_kpa REAL` — derived
- `measured BOOLEAN NOT NULL DEFAULT 0` — true once the hour has elapsed and we replaced the forecast with a measurement
- UNIQUE(`point_id`, `timestamp`)

`agroscope_zone_weather` — pivot from zone to point (so we don't redo the closest-station lookup on every read):
- `zone_id INTEGER PRIMARY KEY` (FK `irrigation_zones.id`)
- `point_id TEXT NOT NULL`
- `resolved_at DATETIME NOT NULL`

`agroscope_tree_params` — per-tree HSMM/irrigator parameters (one row per dendrometer DevEUI, NULL columns inherit global defaults):
- `deveui TEXT PRIMARY KEY` (FK `devices.deveui`)
- `vpd_threshold REAL`, `vpd_steepness REAL`
- `mds_inflection REAL`, `mds_steepness REAL`
- `weight REAL`, `lr_vpd REAL`
- `kc_factor REAL`, `learning_rate REAL`
- `vpd_reset_threshold_mm_rain REAL`, `vpd_reset_threshold_mm_irrigation REAL`

Global defaults live in a single-row `agroscope_global_params` table (same columns minus `deveui`). Reads use COALESCE per-tree → global default → hard-coded constants.

`agroscope_tree_state` — per-tree mutable learning state:
- `deveui TEXT PRIMARY KEY` (FK `devices.deveui`)
- `current_vpd_threshold REAL NOT NULL` — drifts via `lr_vpd` feedback
- `current_kc_factor REAL NOT NULL` — drifts via Tree_irrigator feedback
- `req_precip_mm REAL NOT NULL DEFAULT 0`
- `cumulative_vpd REAL NOT NULL DEFAULT 0`
- `last_water_event_at DATETIME`
- `last_decision_at DATETIME`
- `last_p_dry REAL`
- `last_mds_um INTEGER`

`agroscope_daily_mds` — predawn-to-predawn window snapshot, one row per tree per day:
- `id INTEGER PRIMARY KEY`
- `deveui TEXT NOT NULL` (FK `devices.deveui`)
- `window_start_at DATETIME NOT NULL` — 02:00 local of day N-1
- `daily_min_position_um INTEGER`
- `daily_max_position_um INTEGER`
- `daily_mds_um INTEGER`
- `baseline_position_um INTEGER`
- `mds_fraction REAL`
- UNIQUE(`deveui`, `window_start_at`)

`agroscope_decisions` — per-zone decision audit trail:
- `id INTEGER PRIMARY KEY`
- `zone_id INTEGER NOT NULL` (FK `irrigation_zones.id`)
- `computed_at DATETIME NOT NULL`
- `controller_mode TEXT NOT NULL` — snapshot at decision time (so we can audit retroactively)
- `action TEXT NOT NULL` — `'OPEN' | 'HOLD'`
- `recommended_duration_min INTEGER`
- `max_p_dry REAL` — across trees in zone
- `max_req_precip_mm REAL`
- `farmer_action TEXT` — `'ACCEPTED' | 'MODIFIED' | 'IGNORED' | NULL` (filled in when farmer responds)
- `farmer_duration_min INTEGER` — what the farmer actually ran, if irrigated
- `applied_mm REAL` — measured or estimated, filled in post-close
- `legacy_shadow_action TEXT` — what the legacy controller would have done (for the Advanced Lab comparison)

### 6.3 Migration / seeding

- Add `controller_mode` with default `'schedule'` → all existing zones stay on legacy.
- New `agroscope_*` tables are empty until an operator opts a zone in.
- `agroscope_global_params` is seeded with the constants from §5.2 / §5.3 in a one-row INSERT in the migration.

## 7. UI

### 7.1 Water tab (React GUI, on-device)

Per zone, the existing Water tab gains:

- **Soil Now** indicator is reduced in size to make room for the new controls. It still shows the latest soil-moisture/SWT reading.
- **Irrigate** button (prominent, primary CTA when in `dendrometer` mode and a recommendation exists).
- **Minutes** numeric input field, pre-filled with the controller's recommended `duration_min`, editable by the farmer.
- **Action** field, supplied by the dendrometer logic. Displays the recommendation summary: `"Irrigate 12 min — P(Dry) 0.87, MDS 1.3 µm/µm baseline, cum VPD 73 kPa·hr"`. Hidden in `schedule` mode.

When the farmer presses **Irrigate** with N minutes:
1. Frontend posts to the existing manual-open endpoint with `duration = N min`.
2. The decision row in `agroscope_decisions` is updated: `farmer_action = 'ACCEPTED' | 'MODIFIED'` based on whether N matches `recommended_duration_min`, `farmer_duration_min = N`.
3. Existing actuation pipeline runs (STREGA downlink → ChirpStack → uplink ack → STREGA close → `actuations` row).
4. On close, the post-irrigation update (§5.4) runs.

If the zone is in `dendrometer` mode and the controller has produced no recommendation (no fresh MeteoSwiss data, no dendrometer reading, etc.), the **Action** field shows a stale-state message and the Minutes field is empty — the farmer can still enter a value and irrigate.

### 7.2 Dendrometer panel/card (configuration view, on-device + cloud)

The existing dendrometer device panel gains a `controller_mode` toggle for the zone the device belongs to. Toggling to `dendrometer`:
- Runs the eligibility check (§2): dendrometers present, lat/lon present, MeteoSwiss coverage.
- On success: marks the zone as `dendrometer`, kicks off the first MeteoSwiss fetch + closest-point resolution.
- On failure: surfaces the reason and rejects the change.

A "Show Advanced Lab" toggle on this card controls whether the Advanced Lab section appears in the **cloud UI** for this zone. Default off. The Advanced Lab is **not** rendered in the on-device React GUI under any circumstance.

### 7.3 Advanced Lab (cloud UI only)

Read-only diagnostic view, shown in osi-server's UI for zones where the dendrometer panel toggle is on:

- Per-zone time series: `cumulative_vpd`, `vpd_threshold` (drift), `kc_factor` (drift), `req_precip_mm`.
- Per-tree time series: daily MDS (µm), `p_dry`, last reading positions.
- Side-by-side: dendrometer controller's recommendation vs. **legacy controller's shadow recommendation** vs. **Agroscope cloud's reported decision** (the third column populated once the publish/feedback loop is closed).
- Per-decision row: farmer's response (`ACCEPTED | MODIFIED | IGNORED`) and the actual applied_mm.

## 8. Edge ↔ osi-server sync

Reuses the existing sync mechanism (no new control-plane primitives):

### 8.1 New event types in the outbox (`POST /api/v1/sync/edge/events`, 30 s cadence)

- `agroscope_zone_mode_changed` — emitted when `controller_mode` toggles.
- `agroscope_tree_state_updated` — emitted whenever Tree_HSMM or Tree_irrigator drifts a parameter or updates `req_precip` / `cumulative_vpd`. Carries the full row (small).
- `agroscope_daily_mds_recorded` — emitted at 02:00 daily run, one event per tree.
- `agroscope_decision_recorded` — emitted when a new recommendation is computed.
- `agroscope_decision_resolved` — emitted when farmer acts on a recommendation (the `farmer_action` / `farmer_duration_min` / `applied_mm` fields are filled in).
- `agroscope_weather_cached` — *not* emitted; weather is local-only on the edge. Cloud doesn't need it for display (we publish derived metrics to Agroscope cloud directly).

### 8.2 Bootstrap (`POST /api/v1/sync/edge/bootstrap`, 6 h cadence)

The bootstrap payload gains a top-level `agroscope` object containing:
- `zone_configs[]` — controller_mode + geometry per zone
- `tree_params[]` — per-tree param overrides
- `global_params` — current single-row
- `tree_states[]` — current per-tree learning state
- Most recent N decisions per zone (configurable, default 30) — enough to populate the Advanced Lab without growing the bootstrap unboundedly.

### 8.3 Pending commands (no changes)

The existing `pending-commands` channel is used for manual operator overrides as today. The cloud does not issue dendrometer-controller commands — it can only push the same STREGA opens that the manual UI can.

## 9. Publish to Agroscope server

Transport-pluggable: either MQTT (option 6a/6b — partner broker, to be provisioned by Agroscope) or REST (`POST iot.agroscope.ch/api/...`, schema TBD). The publisher is a single Node-RED helper module (`osi-agroscope-publisher`) with two transport adapters; only one is active at a time, selected via config.

Until Camilo confirms the endpoint and contract, the publisher runs in **dry-run mode**: it serialises the three streams to a local JSON log file (`/data/agroscope-publisher-dryrun.jsonl`) so we can review payloads on the edge without touching the network.

### 9.1 The three streams

#### `raw_uplinks`

One message per dendrometer (and ancillary device) uplink. Fields:
```json
{
  "stream": "raw_uplinks",
  "tenant": "osi",
  "gateway_eui": "0016C001F11766E7",
  "device_eui": "<lsn50-deveui>",
  "device_type": "DRAGINO_LSN50",
  "received_at": "2026-05-29T08:14:00Z",
  "f_port": 2,
  "payload_hex": "...",
  "decoded": { "batV": 3.6, "adcCh0V": 0.42, "adcCh1V": 1.83, ... },
  "gateway_meta": { "rssi": -101, "snr": 6.5, "sf": 7 }
}
```

#### `derived_metrics`

One message per zone per hour, emitted at the top of each hour:
```json
{
  "stream": "derived_metrics",
  "tenant": "osi",
  "zone_id": 12,
  "hour_start_at": "2026-05-29T08:00:00Z",
  "vpd_kpa": 1.42,
  "rain_mm": 0.0,
  "rain_measured": true,
  "cumulative_vpd_kpa_hr": [
    {"deveui": "A8...01", "cumulative_vpd": 38.7, "since": "2026-05-27T13:00:00Z"},
    {"deveui": "A8...02", "cumulative_vpd": 41.2, "since": "2026-05-27T13:00:00Z"}
  ],
  "daily_mds_um": [
    {"deveui": "A8...01", "mds_um": 187, "baseline_um": 14200, "window_start_at": "2026-05-29T00:00:00Z"}
  ]
}
```

#### `decisions`

One message per decision (daily + post-irrigation):
```json
{
  "stream": "decisions",
  "tenant": "osi",
  "decision_id": 4271,
  "zone_id": 12,
  "computed_at": "2026-05-29T02:00:00Z",
  "controller_mode": "dendrometer",
  "action": "OPEN",
  "recommended_duration_min": 12,
  "max_p_dry": 0.87,
  "max_req_precip_mm": 4.3,
  "tree_states": [
    {"deveui": "A8...01", "p_dry": 0.87, "req_precip_mm": 4.3, "vpd_threshold": 47.5, "kc_factor": 1.02},
    {"deveui": "A8...02", "p_dry": 0.61, "req_precip_mm": 3.1, "vpd_threshold": 50.0, "kc_factor": 1.00}
  ],
  "farmer_action": null,
  "applied_mm": null
}
```
A follow-up message with the same `decision_id` is sent when the farmer responds, with `farmer_action`, `farmer_duration_min`, and `applied_mm` filled in.

### 9.2 Transport adapters

`MQTTPublisher`:
- Broker URL, TLS settings, username/password, and topic prefix come from config. Topics: `{prefix}/raw_uplinks`, `{prefix}/derived_metrics`, `{prefix}/decisions`.
- QoS 1, retained=false.
- Reconnect with exponential backoff; queue up to N messages locally during disconnects, drop oldest on overflow.

`RESTPublisher`:
- Endpoint URL, bearer token, batch size come from config. Endpoints: `{base}/raw_uplinks`, `{base}/derived_metrics`, `{base}/decisions`.
- Batches by stream, flushes every 60 s or when a batch reaches 100 messages.
- Retries with exponential backoff, persistent on-disk queue keyed by stream.

Both adapters share the same outbox table (`agroscope_publish_outbox`) so retries survive reboots and the choice of transport is purely a runtime config flag.

## 10. Open questions / TODOs

These must be resolved before we can claim production parity with Agroscope.

| # | Question | Status | Owner |
|---|---|---|---|
| 1 | Cumulative-VPD reset threshold (rain_mm, irrigation_mm). Day-1 is "any" (0.1 mm and any irrigation); needs Agroscope's final rule. | Pending Agroscope | Camilo |
| 2 | Agroscope endpoint: partner MQTT broker URL+credentials OR REST `iot.agroscope.ch/api` route+token. | Pending Agroscope | Camilo |
| 3 | Stream payload schemas: §9.1 is OSI's proposal. Needs Agroscope sign-off. | Pending Agroscope | Camilo |
| 4 | HSMM parameter re-tuning for our µm/baseline MDS convention. The shipped `mds_inflection=1.15` and `mds_steepness=6` will saturate; we'll iterate together. | Pending Agroscope | Camilo |
| 5 | What does Agroscope want to send *back* to OSI (their reported decisions, for the Advanced Lab "Agroscope cloud decision" column)? Not in this spec; depends on transport choice. | Future | Camilo + OSI |

The "Day-1 placeholder, parameters configurable" pattern means none of these block the initial implementation — but the spec must not claim "behavioural parity" until they're all resolved.

## 11. Out of scope

- **Auto-actuation.** Farmer-triggered only in this iteration.
- **Multi-sensor-per-tree.** One LSN50 per tree, identified by DevEUI. A future spec can introduce a `trees` table.
- **Flow-meter rollout.** This spec assumes the flow meter is absent and falls back to geometry; flow-meter hardware integration is a separate work item.
- **Non-Swiss zones.** `dendrometer` mode is rejected outside MeteoSwiss coverage. A future spec can add a different weather source for Uganda etc.
- **Backfilling decisions for already-collected dendrometer data.** Forward-only.

## 12. Testing & verification

### 12.1 Unit tests

- VPD computation from temperature: known-input test vectors covering 0 °C–40 °C, 10 %–100 % RH.
- Tree_HSMM update: pin to the worked example in Agroscope's notebook (`cumulative_vpd=10, mds=0.5 → P(Dry)≈7.5e-6; cumulative_vpd=40, mds=2.0 → P(Dry)≈0.9998`). Re-running OSI's port against the same inputs must produce the same outputs to machine precision *until we re-tune for the µm/baseline convention*, at which point we add a second test vector against the re-tuned parameters.
- Tree_irrigator update: similar pinning, including the `register_irrigation` subtraction.
- Worst-tree-wins aggregation: 3-tree zone with `[0.5, 0.85, 0.72]` → decision OPEN; with `[0.3, 0.5, 0.4]` → decision HOLD.
- MDS daily window: synthetic position series across a 02:00 boundary, assert correct rollup.

### 12.2 Integration tests

- End-to-end on a test farm: opt one zone into `dendrometer`, observe the Water tab recommendation, accept it, confirm STREGA actuation, confirm `applied_mm` updates `req_precip_mm`, confirm `cumulative_vpd` reset.
- Stale-data degradation: block MeteoSwiss access, observe stale warning surfaces in <2 h, controller refuses to update recommendation.
- Eligibility rejection: try to enable `dendrometer` on a Ugandan zone (no MeteoSwiss coverage) and confirm the API returns the eligibility error.

### 12.3 Convergence verification with Agroscope

Once the publisher contract is settled with Camilo:
- Send the same week of raw data through both systems.
- Compare per-zone `P(Dry)`, `req_precip_mm`, decision actions across decisions.
- Document divergences and the parameters that explain them.

## 13. Rollout

1. **Spec + plan** — this document; implementation plan generated next.
2. **Schema migration** — add columns + new tables on every supported profile (bcm2709 + bcm2712), shipped via firmware build.
3. **`osi-agroscope-controller` helper module** — Node.js, in the same shape as `osi-dendro-helper`. Pure functions, exported and unit-tested.
4. **MeteoSwiss fetch flow** — Node-RED flow + helper module for OGD STAC pull + caching.
5. **Daily run flow** — Node-RED flow firing at 02:00 zone-local, computing MDS, updating Tree_HSMM + Tree_irrigator per tree, persisting state, emitting outbox events.
6. **Post-irrigation flow** — Node-RED flow firing on STREGA close in zones marked `dendrometer`.
7. **React GUI changes** — Water tab Irrigate button + Action field; dendrometer card mode toggle + Advanced Lab visibility toggle.
8. **osi-server changes** — sync schema, Advanced Lab view (cloud-only).
9. **`osi-agroscope-publisher` (dry-run mode)** — write JSONL to local disk.
10. **Live publisher** — once Camilo confirms endpoint + contract, swap dry-run for the chosen transport.
11. **One zone opt-in** — pick a Silvan zone with a dendrometer-bearing tree, enable `dendrometer` mode, observe a week.
12. **Convergence comparison** — coordinate with Camilo, document and tune.

Each numbered step is a candidate for its own implementation slice in the follow-up plan.
