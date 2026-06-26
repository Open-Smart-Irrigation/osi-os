# Agroscope Dendrometer Controller Architecture

**Status:** Draft design, not shipped behavior.

This document preserves the durable architecture from the Agroscope-style dendrometer controller design. Treat it as the starting point for implementation planning, not as a description of the current runtime.

## Goal

Add an opt-in dendrometer-driven irrigation recommendation mode that can be compared against Agroscope's Agro Dendro reference logic (`Tree_HSMM` and `Tree_irrigator`). For opted-in zones, OSI OS should produce the same recommendation as the reference system for identical inputs, then publish raw uplinks, derived metrics, and decisions to Agroscope for independent verification.

The current OSI scheduler remains the default and primary controller for zones that do not opt in.

## Non-Goals

- Do not replace the existing kPa/`irrigation_schedules` scheduling logic.
- Do not auto-actuate valves from dendrometer mode. The controller produces recommendations; the farmer triggers irrigation manually in the GUI.
- Do not model trees as first-class entities. A tree is identified by its dendrometer DevEUI.
- Do not design Agroscope's ingestion pipeline here. OSI defines its outbound stream contract; Agroscope owns its receiver.

## Operational Model

`irrigation_zones` gains a `controller_mode`:

- `schedule` - default behavior; existing OSI scheduling remains active.
- `dendrometer` - Agroscope-style controller is the source of truth for recommendations. Legacy OSI scheduling may still compute a shadow recommendation for comparison.

In `dendrometer` mode, the controller uses the full Agroscope pipeline: MeteoSwiss OGD weather, VPD/rain derivation, `Tree_HSMM`, and `Tree_irrigator`. Do not mix this mode with S2120 weather or kPa-based soil logic.

Enabling `dendrometer` mode is rejected when the zone has no dendrometer, no latitude/longitude, or no MeteoSwiss coverage.

## Responsibilities

Edge (`osi-os`) is authoritative for controller computation. Node-RED and a helper module read local SQLite state, cache weather, compute recommendations offline-first, and surface stale-data states when external fetches age out.

Cloud (`osi-server`) mirrors edge tables and hosts read-only Advanced Lab/comparison views. It does not make controller decisions.

Agroscope is an independent verifier. It receives OSI streams, runs its own reference implementation, and compares decisions with OSI.

## Data Flow

The edge caches hourly MeteoSwiss OGD local-forecasting data in `agroscope_weather`, keyed by forecast point and timestamp. The planned fetch cadence is hourly at HH:10. VPD follows the FAO-style computation used by Agroscope's reference code. Forecast rows are reconciled with measured rows using an insert/update/skip state machine and retained for 7 days.

Dendrometer input comes from the existing LSN50 ratiometric pipeline and `dendrometer_readings`. The controller reads position in micrometers; ingestion itself should not change.

Each dendrometer carries its own learning state (`vpd_threshold`, `kc_factor`, `req_precip_mm`, `cumulative_vpd`, `last_water_event_at`). Multi-dendrometer zones use worst-tree-wins:

- irrigate when max `P(Dry)` is at least `0.8`,
- use max `req_precip_mm` for the amount,
- reset every tree in the zone when irrigation is applied.

Water events reset cumulative VPD when MeteoSwiss rain exceeds the configured threshold or when any zone irrigation closes. The day-1 rain threshold is `0.1 mm/hr`; final thresholds require Agroscope sign-off.

## Planned Tables

- `agroscope_weather` - MeteoSwiss cache.
- `agroscope_tree_params` - per-tree HSMM/irrigator parameters; nulls inherit defaults.
- `agroscope_tree_state` - mutable per-tree learning state.
- `agroscope_decisions` - per-zone recommendations and outcomes.
- `agroscope_mds_daily` - daily maximum-shrinkage metrics.

Weather cache rows are local-only and are not mirrored to cloud. Derived state and decisions may be mirrored for Advanced Lab display.

## Publishing

The outbound publisher is a Node-RED helper module with pluggable transport. MQTT to an Agroscope-provided broker and REST to an Agroscope endpoint were both considered; the final transport, credentials, and payload schema require Agroscope sign-off.

Streams:

- `raw_uplinks` - every dendrometer uplink and relevant ancillary data.
- `derived_metrics` - VPD, MDS, cumulative VPD, and related per-zone/per-tree metrics.
- `decisions` - `P(Dry)`, required precipitation, recommendation, applied water, and learned parameters.

## Open Decisions

- Final cumulative-VPD reset thresholds for rain and irrigation.
- Agroscope transport endpoint, credentials, and payload schemas.
- HSMM parameter re-tuning for OSI's micrometer/baseline MDS convention.
- What, if anything, Agroscope sends back to OSI for display.
- Non-Swiss weather-source support; initial design rejects `dendrometer` mode outside MeteoSwiss coverage.
