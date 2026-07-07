# Agroscope IoT Dendrometer Forwarding

## Status

Slice B forwards OSI dendrometer uplinks from the edge to the Agroscope/FiBL
MQTT broker. It is an opt-in, publish-only egress path for raw dendrometer
data. It does not subscribe to Agroscope topics, does not actuate valves, and
does not pull Agroscope processed results back into OSI.

Tasks deferred outside this edge-firmware slice:

- End-to-end confirmation with live Agroscope credentials.
- Pulling Agroscope processed results back into OSI Server.

## Contract

| Field | Value |
|---|---|
| Broker host | `51.107.5.147` |
| Broker port | `1883` |
| Transport | Plaintext MQTT |
| Direction | OSI edge to Agroscope only |
| Source topic | Local ChirpStack MQTT `application/+/device/+/event/up` |
| Publish topic | `OSI_dendro/<DevEUI>/uplink` |
| Payload shape | Swisscom/ThingPark-style `DevEUI_uplink` JSON |
| Delivery | Live-only best-effort; no backfill or durable retry queue |
| QoS | `1` |
| Default state | Disabled until explicitly enabled per gateway |

Published payload:

```json
{
  "DevEUI_uplink": {
    "Time": "2026-07-07T09:48:32.101+02:00",
    "DevEUI": "A840413A10601D75",
    "FPort": "2",
    "payload_hex": "0d3e...",
    "payload": {
      "Bat_V": 3.39,
      "VDC_intput_V": 0
    }
  }
}
```

`VDC_intput_V` intentionally uses Agroscope's existing misspelled dendrometer
column name. OSI carries the LSN50 ADC voltage there; Agroscope's
`dendro_processing` converts voltage to micrometers.

## Dendrometer Inventory

The Node-RED branch computes the publish topic directly from the uplink DevEUI.
Keep the enabled dendrometer inventory here when a gateway is enrolled.

| Gateway | OSI device DevEUI | Agroscope topic | Sensor type | Status |
|---|---|---|---|---|
| TBD | TBD | `OSI_dendro/<DevEUI>/uplink` | Dendrometer LSN50 ADC voltage | Pending enrollment |

Dendrometer identification is heuristic: the transform forwards LSN50/Dragino
profile uplinks that contain decoded ADC voltage and explicitly drops
Chameleon-tagged payloads. Future non-dendrometer analog LSN50 uses, such as
Watermark-on-ADC, need their own exclusion or profile tag before enabling this
forwarder.

## Configuration

The forwarding branch is disabled by default. Enrollment must provide:

| Setting | Purpose | Example |
|---|---|---|
| `AGROSCOPE_FORWARD_ENABLED` | Opt-in gate for publishing | `true` |
| `AGROSCOPE_MQTT_HOST` | Broker host override for staging or loopback | `51.107.5.147` |
| `AGROSCOPE_MQTT_PORT` | Broker port override for staging or loopback | `1883` |
| MQTT username/password | Agroscope-provisioned credentials | Stored in `flows_cred.json` |

Secrets are never committed to the repo or firmware image. Store MQTT
credentials in `/srv/node-red/flows_cred.json` during enrollment, rotate them
there, and restart Node-RED after credential changes.

On the Pi, enrollment can provide the same values through UCI:

```bash
uci set osi-server.cloud.agroscope_forward_enabled='true'
uci set osi-server.cloud.agroscope_mqtt_host='51.107.5.147'
uci set osi-server.cloud.agroscope_mqtt_port='1883'
uci set osi-server.cloud.agroscope_mqtt_username='<provided-by-agroscope>'
uci set osi-server.cloud.agroscope_mqtt_password='<provided-by-agroscope>'
uci commit osi-server
```

`node-red.init` also accepts the equivalent keys in
`/srv/node-red/.chirpstack.env` as a compatibility fallback. At startup it
merges the Agroscope credential entry into `/srv/node-red/flows_cred.json` under
the `agroscope-mqtt-broker` node id and rewrites that broker node's host/port in
`/srv/node-red/flows.json`. When forwarding is disabled, the broker host remains
local (`127.0.0.1`); the live Agroscope host is written only after
`AGROSCOPE_FORWARD_ENABLED` is truthy. The username and password are not
exported to the Node-RED function runtime.

## Enable

1. Confirm the gateway is authorized to share dendrometer data with Agroscope.
2. Add the gateway's dendrometer DevEUIs to the inventory table above.
3. Add Agroscope MQTT credentials to `/srv/node-red/flows_cred.json`.
4. Set `AGROSCOPE_FORWARD_ENABLED=true`.
5. Set broker overrides only for staging or loopback tests.
6. Restart Node-RED.
7. Watch Node-RED logs for MQTT connection or credential errors.

## Disable

1. Set `AGROSCOPE_FORWARD_ENABLED=false`.
2. Restart Node-RED.
3. Confirm no messages arrive on `OSI_dendro/#`.

## Verify With Loopback

Use a local broker before enabling the live broker:

```bash
mosquitto_sub -h localhost -p 1883 -t 'OSI_dendro/#' -v
```

Configure the gateway for loopback:

```bash
AGROSCOPE_FORWARD_ENABLED=true
AGROSCOPE_MQTT_HOST=localhost
AGROSCOPE_MQTT_PORT=1883
```

Or via UCI:

```bash
uci set osi-server.cloud.agroscope_forward_enabled='true'
uci set osi-server.cloud.agroscope_mqtt_host='localhost'
uci set osi-server.cloud.agroscope_mqtt_port='1883'
uci commit osi-server
/etc/init.d/node-red restart
```

Replay a recorded ChirpStack v4 dendrometer uplink into the local
`application/+/device/+/event/up` topic. The subscriber should receive an
`OSI_dendro/<DevEUI>/uplink` message containing `DevEUI_uplink`.

## Operational Limits

- This path is live-only best-effort. If Node-RED or the broker is offline, OSI
  does not backfill missed Agroscope publishes.
- OSI remains authoritative for edge state and actuation.
- Agroscope receives observations only.
- Use the OSI local ChirpStack uplink as the source of truth; do not republish
  derived cloud data from this slice.

## Observe-Only Guard

Agroscope's instance is observe-only on OSI farms. The edge forwards
dendrometer observations to Agroscope and never consumes Agroscope actuator
topics or commands. OSI actuation stays on the existing STREGA-via-ChirpStack
path, including OSI Server pending commands and local edge scheduling.

The firmware flow has one Agroscope MQTT broker node and one MQTT-out node. It
has no MQTT-in node attached to `agroscope-mqtt-broker`, no subscription to
`AGS/<farm>/Actuator/#`, and no inbound bridge from Agroscope.
