# OSI Domain Context

This file is a compact domain glossary for agent skills. `AGENTS.md` remains the operational source of truth.

## Core Terms

- **OSI OS** - Edge firmware and local application stack running on a Raspberry Pi gateway. It owns canonical operational farm state.
- **OSI Server** - Cloud application that mirrors edge-backed farms and exposes cloud/mobile experiences.
- **Edge-first sync** - Sync model where the edge applies local state first, emits events to the cloud, and treats cloud edits as pending until applied on the edge.
- **Gateway** - Raspberry Pi 5 LoRaWAN gateway running ChirpStack, Node-RED, SQLite, and the React GUI.
- **Gateway EUI** - Canonical gateway identifier. Runtime values are normalized to uppercase on the edge.
- **Farm** - User-managed irrigation domain mirrored between edge and cloud when linked.
- **Zone** - Irrigation area with schedules, configuration, device assignments, and optional field geometry.
- **Field geometry** - Zone shape and spatial metadata used by Terra Intelligence and prediction flows.
- **Device** - Field hardware such as Kiwi sensors, Dragino LSN50 dendrometers, or STREGA valves.
- **Telemetry** - Sensor, heartbeat, status, and command acknowledgment data sent from edge to cloud over MQTT.
- **Pending command** - Cloud-originated control-plane instruction fetched by the edge via REST polling.
- **Sync outbox** - Edge queue of local changes waiting to be delivered to the cloud.
- **Sync inbox** - Cloud/edge deduplication record for received sync events.
- **Sync cursor** - Progress marker for sync state and replay.
- **Bootstrap** - Full edge state snapshot uploaded to the cloud.
- **Linked login** - Cloud-assisted local account linking that uses a gateway-specific offline verifier, not cloud password hash sync.
- **Dendrometer** - Tree growth sensor flow, including canonical ratio endpoint fields for retracted and extended positions.
- **STREGA Gen1 sentinel** - `ffff/ffff` temperature/humidity payload indicating unavailable environmental telemetry.
- **Terra Intelligence** - Standalone prediction UX served by `osi-server` at `/terra-intelligence`.

## Protocol Rules

- REST is the only cloud-to-edge command path.
- MQTT is edge-to-cloud only for telemetry, heartbeats, status, and command ACKs.
- Cloud MQTT command publishing is legacy/deprecated unless the edge subscribes in a future design.

## Device Vocabulary

- **Kiwi** - Sensor device in the ChirpStack `Sensors` application using the `Kiwi` profile.
- **LSN50** - Dragino dendrometer device in the `Sensors` application using the `LSN50` profile.
- **STREGA** - Valve actuator in the ChirpStack `Actuators` application using the `STREGA` profile.

## Operational Constraints

- Never overwrite `/data/db/farming.db` on a running or previously provisioned Pi.
- Use wildcard ChirpStack MQTT subscriptions: `application/+/device/+/event/up`.
- Preserve existing user or live-device state unless the user explicitly authorizes destructive repair.
