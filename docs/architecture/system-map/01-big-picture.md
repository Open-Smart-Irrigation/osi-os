# 01 — Big Picture

[← Index](README.md)

## The problem being solved

Farms in places with unreliable (or no) internet need automated irrigation that
reacts to what the soil and the plants actually need. Cloud-only IoT platforms
fail there: no connection means no irrigation logic. OSI inverts that: **the farm
gateway is a complete, self-sufficient irrigation controller**, and the cloud is
an optional companion that adds convenience and heavier analytics on top.

## The actors

```
   Field devices (battery, radio)             The gateway (Raspberry Pi 5)              The cloud (optional)
┌──────────────────────────────┐       ┌──────────────────────────────────┐      ┌─────────────────────────────┐
│ Soil probes   (Chameleon,    │ LoRa  │  ChirpStack  — radio server      │ REST │  osi-server (Spring Boot)   │
│                Kiwi)         │ ────► │  Node-RED    — backend + API     │ ───► │  PostgreSQL mirror          │
│ Weather       (SenseCAP      │       │  SQLite      — farm database     │ ◄─── │  Cloud dashboard + admin    │
│  stations      S2120)        │       │  React GUI   — farmer dashboard  │ poll │  Terra Intelligence (map)   │
│ Rain gauges   (LoRain)       │ ◄──── │                                  │      │  Prediction service (Python)│
│ Tree sensors  (dendrometers) │ LoRa  │  Works 100% offline.             │ MQTT │  Weather providers          │
│ Water valves  (STREGA,       │ down- │  Local Wi-Fi/LAN dashboard.      │ ───► │  (telemetry listen only)    │
│                UC512)        │ link  │                                  │      │                             │
└──────────────────────────────┘       └──────────────────────────────────┘      └─────────────────────────────┘
```

- **Field devices**: third-party LoRaWAN hardware (sensors and valves). They
  wake up, transmit a few bytes, and sleep; batteries last years. Catalog and
  payload details: chapter [03](03-edge-backend-flows.md) and
  [AGENTS.md § Device catalog](../../../AGENTS.md).
- **The gateway**: one Raspberry Pi 5 per farm running the custom **OSI OS**
  firmware built from this repo. It hears the radio traffic, stores readings,
  runs schedules, opens valves, and serves the farmer a dashboard on the local
  network. Chapter [02](02-edge-gateway.md).
- **The cloud**: one shared osi-server installation
  (production: `osicloud.ch`) serving all linked farms: remote dashboards,
  admin tools, fleet health, and analytics that need more compute or external
  data (weather forecasts, crop models). Chapter [07](07-cloud-server.md).
- **The farmer**: uses the same style of dashboard locally (on the gateway)
  or remotely (on the cloud); can also send feedback/problem reports from the
  dashboard that end up as GitHub issues for the developers (chapter [08](08-operations.md)).

## One sensor reading, start to finish

1. A soil probe transmits its reading by radio. **ChirpStack** (on the Pi)
   receives it, decrypts it, and republishes it on the Pi's internal message bus
   (MQTT topic `application/+/device/+/event/up`).
2. A **Node-RED ingest flow** for that device family picks it up, runs the
   matching **decoder** (translates raw bytes into named values like
   "soil tension 32 kPa"), normalizes it, and writes one row into the local
   SQLite table `device_data`.
3. Database **triggers** automatically drop a copy of the change into the
   `sync_outbox` table — the "outgoing mail tray".
4. The dashboard shows the new value immediately (the GUI polls the local REST
   API). The **scheduler** will use it at the next decision time.
5. If the farm is linked to the cloud, the sync worker posts outbox batches to
   the cloud every 30 seconds; the cloud stores a mirror copy. Live telemetry is
   additionally streamed over MQTT so cloud dashboards update in real time.
6. If nothing is connected, steps 5–6 simply wait. Nothing is lost; the outbox
   drains whenever connectivity returns.

## One irrigation, start to finish

1. Every morning at 06:00 (gateway-local cron) the **Scheduler** flow reads all
   enabled irrigation schedules, averages the last hour of soil-tension readings
   per zone, and applies the rule *"mean tension ≥ threshold → irrigate"*
   (drier soil = higher tension).
2. A positive decision produces an **actuator command**: the STREGA valve flow
   builds an `OPEN_FOR_DURATION` radio downlink (the valve closes itself when
   the time is up — there is deliberately no separate "close" command in normal
   operation) and hands it to ChirpStack for transmission.
3. The action is journaled (`actuator_log`, `irrigation_events`) and an
   **actuation expectation** row is created — "we expect this valve to be open
   until 07:10". A minute-by-minute **reconciliation monitor** compares
   expectation against the valve's actual reported state and flags anomalies
   (e.g. a valve that stayed open too long).
4. Farmers can also trigger or cancel irrigation manually from the dashboard;
   cancel flushes the radio queue and marks the expectation `CANCELLED`.

## Design principles (the rules everything follows)

These come from [docs/engineering-playbook.md](../../engineering-playbook.md)
and [AGENTS.md](../../../AGENTS.md); they explain *why* the architecture looks
the way it does.

1. **Edge-authoritative.** The gateway's database is the single source of truth
   for its farm. Cloud edits are only *requests* (pending commands) until the
   gateway applies them and reports back. This is why sync has outboxes, inboxes,
   and acknowledgements instead of a simple shared database.
2. **REST is the only cloud→edge command path.** The gateway *pulls* commands
   every 30 s over HTTPS. MQTT flows one way only (edge → cloud telemetry). The
   gateway never listens to the cloud broker, so a compromised or buggy cloud
   cannot push anything onto a farm.
3. **Missing data stays missing.** A day with no rain *samples* is "no data",
   never "0.0 mm". No plausible defaults are ever substituted for absent
   measurements — the GUI shows an explicit "unavailable" state instead.
4. **Farm history is irreplaceable.** The live database is never overwritten or
   reseeded; schema changes go through a checksummed migration ledger with
   backups and fingerprint verification (chapter [04](04-edge-database.md)).
5. **One canonical copy, byte-identical mirrors.** The Pi 5 profile
   (`conf/full_raspberrypi_bcm27xx_bcm2712/`) is the source of truth for all
   runtime payload files; the Pi 4/2 profile mirrors it byte-for-byte, enforced
   by `scripts/verify-profile-parity.js`.
6. **Guard rails as code.** Roughly a hundred verification scripts under
   `scripts/` pin wiring, schema parity, decoder behavior, and size/quality
   ratchets; CI runs them on every change (chapter [08](08-operations.md)).

## Where "the refactor program" fits

The 2026 refactor program
([docs/architecture/refactor-program-2026.md](../refactor-program-2026.md))
restructured the edge backend from one monolithic flow file toward **extracted,
unit-tested helper modules** (history router, dendro analytics, zone environment,
device writer, DB integrity) loaded by the flow, introduced the **ordered
migration runner** as the schema authority, added a **narrow-waist device writer**
(one shared, validated path for writing sensor rows, piloted with the LSN50 and
Milesight UC512 families), and hardened sync ingest and deploys. This document
set describes the *post-refactor* state.
