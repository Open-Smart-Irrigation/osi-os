# Agroscope Integration — Program Overview (umbrella)

**Status:** Decomposition / program map. Each sub-project gets its own spec → plan → build.
**Date:** 2026-07-06
**Scope:** OSI edge (osi-os) + cloud (osi-server) + an external integration to Agroscope IoT.

## Goal

**Behavioral parity with deployed Agroscope irrigation systems**, achieved on two fronts, plus the measured
data both fronts require:

1. **OSI runs Agroscope's logic itself** — a faithful port of the dendro stress → SEM → PID → dose-mm
   pipeline, as a compute-only shadow, for the in-OSI 3-way comparison (v6 / v6-RDI / Agroscope). Runs offline
   and in-stack, independent of Agroscope's availability.
2. **OSI feeds its raw data to Agroscope's live IoT stack** — so Agroscope's *real* hosted system
   (`iot.agroscope.ch`) ingests and processes OSI's data. This is the authoritative live reference, and can
   feed the comparison (pull results back via `get_data_api_iot`).
3. **Measured water** — the controller subtracts *measured* applied water (never an estimate), which requires
   ingesting water-meter readings OSI does not collect today.

Fronts 1 and 2 are complementary, not redundant: the port gives an in-stack, always-available comparison arm;
the forward gives the ground-truth live instance to validate the port against.

## Sub-projects

| # | Sub-project | Where | Deliverable (independently testable) | Depends on |
|---|---|---|---|---|
| **A** | Water-meter ingestion — **already implemented** | osi-os (LSN50 count mode) + osi-server | measured daily litres per zone in `zone_daily_environment.flow_liters` (exists) | — |
| **B** | Raw-data forwarding to Agroscope IoT | MQTT bridge (edge or cloud) | OSI raw data flowing into Agroscope's live stack | Agroscope broker + creds + contract (external) |
| **C** | Agroscope shadow controller (faithful port) | cloud (osi-server) | the 3-way comparison arm | **A** (reuses `flow_liters`) |

**A is done.** The Dragino LSN50 flow-meter (pulse count mode) is already integrated: decoder `mode 5/6/8`
→ `flow_*` channels → measured daily litres in `zone_daily_environment.flow_liters` (counter-reset handled).
The PID needs only the *daily* measured volume, so C consumes it directly — `water_input_mm = flow_liters /
areaM2` — and the Python oracle quantifies any divergence from Agroscope's `watermeter_processing`; the raw
sub-daily path is ported **only if** the oracle shows a material gap. So the real remaining work is **C + B**.

C is already specced: [agroscope-shadow-controller-design.md](agroscope-shadow-controller-design.md) (its
water-meter section reuses `flow_liters`, below).

## Interfaces (the contracts that let the slices be built independently)

1. **Water-meter data contract (A → C) — already exists.** C reads **`zone_daily_environment.flow_liters`**
   (measured daily litres per zone, from the implemented LSN50 count-mode flow meter) and converts to mm via
   **`IrrigationZone.areaM2`**: `water_input_mm = flow_liters / areaM2`. The raw `flow_*` channels and
   `flow_count_cumulative` remain available if a strict-parity raw port is ever needed (oracle-gated).
2. **Agroscope MQTT contract (B → Agroscope IoT).** Publish to Agroscope's broker under
   `AGS/<farm>/Sensor/<type>` (Dendrometers / Rain / WaterMeter / …) with the payload schema Agroscope IoT
   expects. Exact topic naming, payload format, broker endpoint, and credentials are **external inputs from
   Agroscope** (see open questions).
3. **Dendro raw contract (existing).** `sensor_data.data_json->>'dendro_position_mm'` (mm), via
   `SensorDataRepository.findDendroRawForPeriod` — consumed by C, forwarded by B.

## Sequencing

- **A** and **C** are fully in our control and can proceed now; C is built against A's water-meter contract
  (validated by the Python oracle) and lights up full measured-water parity once A lands.
- **B** is independent of A/C and can run in parallel, but is **gated on external Agroscope inputs**; start by
  obtaining those. B is where the *live Agroscope reference* comes from.
- Recommended order: **A first (or A ∥ C)**, pursue **B**'s external dependencies in parallel, finalize **C**.

## Open questions to resolve before each slice's spec

**A — water-meter ingestion (resolved / already built)**
- Hardware: Dragino LSN50 in **pulse count mode** (decoder `mode 5/6/8`). Per-zone (dedicated). ✓
- Measured daily litres already at `zone_daily_environment.flow_liters`; C reuses it. ✓
- Only open item (verify in C's plan): does OSI's daily flow window match Agroscope's 03:00-offset day? The
  oracle answers this; port the raw path only on a material gap.

**B — forward to Agroscope IoT** (mostly external, from Agroscope)
- Broker endpoint (host/port/TLS) and **provisioned credentials** (NOT the hardcoded creds in the source).
- Exact topic naming per farm/sensor and the **payload schema** (raw LoRaWAN bytes vs decoded JSON?).
- **Origin:** edge (each Pi forwards its LoRaWAN uplinks, like `mqtt_bridge.py`) vs cloud (osi-server forwards
  ingested `sensor_data`)? Which data streams? Live-only vs backfill?
- Do we pull Agroscope's processed results back (`get_data_api_iot`) for the comparison?

**C — controller** — mostly resolved; the only external is A's water-meter contract.

## Constraints (apply across slices)

- **Credentials / secrets:** never reuse the Agroscope source's hardcoded plaintext creds or its TLS-disable
  path. Agroscope IoT credentials are provisioned per deployment, TLS on, stored per OSI's secret policy (no
  secrets in the repo).
- **Data egress / governance:** B sends farm data to an external third party (Agroscope) — an authorized but
  deliberate cross-org data flow.
- **Shadow-only for C:** no change to v6 actuation (as specced).
- **Firmware minimalism (A/B edge parts):** follow OSI's stock-firmware conventions; keep edge additions minimal.

## Future phase (deferred — do NOT start until the server is proven)
- **D — Edge port of the Agroscope logic (osi-os).** The full faithful logic eventually also runs on the edge
  (Node-RED/edge runtime) — this is the path to **Phase 1: local actuation** (the edge is edge-authoritative
  for STREGA). **Deliberately deferred until slice C is parity-proven in osi-server.** Rationale: build the
  subtle logic once in the mature Java/oracle/test environment; then the **proven server becomes the oracle
  for the edge port** (edge-vs-server parity, mirroring the Python→Java pattern). Edge actuation additionally
  gates on the deploy guardrails + a gateway-gate go decision — it is a separate, higher-stakes phase, not
  part of the shadow work.

## Next step

Brainstorm the slices into specs in the recommended order. **A** (water-meter ingestion) is the concrete
starting point and needs the hardware/LoRaWAN answers above; **B** needs the external Agroscope inputs before
its spec can be complete.
