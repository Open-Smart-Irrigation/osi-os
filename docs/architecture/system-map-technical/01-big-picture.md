# 01 — System overview

[← Index](README.md)

## Topology

```
Field devices (LoRaWAN class A)        Gateway (Raspberry Pi 5, OSI OS)          Cloud (osi-server)
┌────────────────────────────┐   ┌───────────────────────────────────────┐   ┌──────────────────────────────┐
│ Chameleon/Kiwi soil probes │   │ ChirpStack NS + concentratord  :8080  │   │ Spring Boot backend   :8080  │
│ SenseCAP S2120 weather     │──►│ Mosquitto (local broker)              │──►│ PostgreSQL 16 (Flyway)       │
│ Aqua-Scope LoRain rain     │   │ Node-RED (flows.json)          :1880  │◄──│ Mosquitto          :8883 TLS │
│ Dragino LSN50 multi-sensor │   │ SQLite /data/db/farming.db            │   │ React frontend (in JAR)      │
│ STREGA / UC512 valves      │◄──│ React GUI at /gui                     │   │ Terra Intelligence           │
└────────────────────────────┘   └───────────────────────────────────────┘   │ Prediction service    :8090  │
        uplink/downlink              REST/HTTPS ▲ (edge-initiated, 30 s poll)  └──────────────────────────────┘
                                     MQTT/WSS:443 ▲ (edge→cloud telemetry only)
```

Each farm runs one gateway. The gateway operates with no upstream connectivity:
ingest, storage, scheduling, actuation, and the dashboard are all local. A
linked gateway additionally mirrors state to one shared osi-server
installation (production `osicloud.ch`).

## Data path: sensor uplink

1. ChirpStack decrypts the LoRaWAN frame and publishes it on the local broker
   under `application/+/device/+/event/up`. Application IDs are generated per
   installation at bootstrap, so every flow subscription uses that wildcard
   topic; `scripts/check-mqtt-topics.sh` rejects hardcoded UUIDs.
2. The device family's ingest tab in flows.json decodes the payload
   (`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/`),
   normalizes it, and inserts a `device_data` row. The LSN50 and UC512 families
   run through the shared writer (`osi-device-writer`) introduced by the
   refactor program; the remaining families still insert directly.
3. `AFTER INSERT` triggers enqueue a `DEVICE_DATA_APPENDED` event in
   `sync_outbox` and mark history dirty keys. No application code participates.
4. The GUI reads the row over the local REST API. When linked, the sync worker
   delivers the outbox batch within 30 s and republishes the reading on
   `devices/{eui}/telemetry` for live cloud dashboards.

## Data path: irrigation

1. The scheduler (flows.json → tab "Scheduler", cron `00 06 * * *`) selects
   enabled `irrigation_schedules`, computes the last-hour mean of the zone's
   trigger channel, and irrigates when `meanKpa >= threshold_kpa`. SWT is
   stored positive in kPa; higher means drier. For `trigger_metric='DENDRO'`
   the same column holds a stress level 1–4, not kPa.
2. The STREGA tab builds an `OPEN_FOR_DURATION` downlink and enqueues it via
   ChirpStack. There is no CLOSE in normal operation; the valve firmware
   closes itself at duration end. Early termination is a cancel:
   `POST /api/v1/valves/:deveui/cancel` flushes the ChirpStack device queue
   and marks the active `valve_actuation_expectations` row `CANCELLED`.
3. Every actuation writes `actuator_log`, `irrigation_events`, and an
   expectation row (`expected_close_at`, `reconciliation_state`). A 60 s
   monitor compares expectations against `devices.current_state` and last
   uplink time, and raises states such as `STALE_OPEN_OBSERVED`.

## Architectural invariants

These constraints shape every module; sources are
[docs/engineering-playbook.md](../../engineering-playbook.md) and
[AGENTS.md](../../../AGENTS.md).

1. **Edge authority.** Local SQLite commits first; the cloud mirrors. A cloud
   edit exists only as a pending command until the edge applies it and ACKs.
2. **REST-only command path.** The edge polls
   `/api/v1/sync/gateways/{eui}/pending-commands` every 30 s. The edge holds
   no subscription on the cloud broker, and the cloud's `MqttPublisherService`
   is deprecated. A compromised cloud cannot push into a farm.
3. **Null means unavailable.** No plausible defaults for missing telemetry. A
   day with zero rain samples is no-data, not 0.0 mm. The GUI renders explicit
   unavailable states; helper tests pin this behavior.
4. **Live databases are never reseeded.** `deploy.sh` seeds only when
   `/data/db/farming.db` and its WAL/SHM/journal sidecars are absent. Schema
   changes travel through the checksummed migration ledger.
5. **Profile parity.** `conf/full_raspberrypi_bcm27xx_bcm2712/` is canonical
   for all runtime payload files; `bcm2709` must match byte-for-byte
   (`scripts/verify-profile-parity.js`, CI-gated).
6. **Executable guard rails.** Around 100 verifier scripts under `scripts/`
   pin wiring, schema parity, decoder behavior, and quality ratchets
   (chapter [08](08-operations.md)).

## Refactor program outcome (2026)

[docs/architecture/refactor-program-2026.md](../refactor-program-2026.md)
defines the program; this snapshot documents its end state. Concretely: heavy
flow-node logic moved into unit-tested helper packages (`osi-history-router`,
`osi-dendro-analytics`, `osi-zone-env`, `osi-device-writer`,
`osi-db-integrity`); the ordered migration runner (`lib/osi-migrate`) became
the schema authority with a frozen boot-DDL node; ingest gained a validated
narrow-waist writer path piloted on LSN50 and Milesight UC512; deploys gained
atomic payload swap, a canary gate, and deploy-time migration delivery. A
size ratchet (`scripts/verify-flows-size-ratchet.js`) prevents embedded flow
code from growing again.
