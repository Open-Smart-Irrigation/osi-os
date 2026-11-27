# Backend contract for T1 replay

Any backend that is not the Node-RED oracle runs under T1 as a command line:

    node edge/harness/record.js --replay CASSETTE_DIR --out OUT_DIR --backend-cmd "/abs/path/to/binary ARGS"

The harness copies the cassette's `fixture.db` (the database the Node-RED
oracle left after its own boot) to `OUT_DIR/run/data/db/farming.db`, starts
the fakes (MQTT broker and gRPC DeviceService stand-in, `fakes.js`), then
starts the backend with the environment below and waits for it to be ready.

## Environment the backend receives

| Variable | Meaning |
|---|---|
| `OSI_EDGE_DB` | Absolute path of `farming.db`. Open it; never replace it. |
| `OSI_EDGE_DATA_ROOT` | Scratch root. Map the image paths `/data/...` and `/srv/node-red/...` under it when you touch files. |
| `OSI_EDGE_GUI_DIR` | Static root for `/gui`. Defaults to `/usr/lib/node-red/gui` on the gateway. T1 stages the same synthetic files and fixed modification times for both backends. |
| `OSI_EDGE_HTTP_ADDR` | `host:port` to listen on (the `:1880` equivalent). |
| `OSI_EDGE_MQTT_URL` | Local broker (ChirpStack MQTT), `tcp://host:port`. MQTT 3.1.1, client id `nodered`, clean session off, QoS 1 subscription to `application/+/device/+/event/up`. |
| `OSI_CLOUD_BROKER_URL` | For a scenario with `"cloud": true`, loopback MQTT 5 proxy backed by a persistent Mosquitto container. |
| `DEVICE_MQTT_PASSWORD` | Synthetic cloud MQTT password. The cloud MQTT username is the synthetic `DEVICE_EUI`. |
| `CHIRPSTACK_API_URL` | gRPC DeviceService stand-in, `http://host:port`, insecure. |
| `OSI_EDGE_TEST_HOOKS` | `1` enables the test endpoints below. Never set on a device. |
| `OSI_EDGE_TEST_NONCE` | A per-run value that `/__test/ready` must echo. |
| `AUTH_TOKEN_SECRET` | Token secret (synthetic). Same precedence as the flows: `AUTH_TOKEN_SECRET`, then `JWT_SECRET`, then `/data/db/osi_auth_token_secret`, then `/var/lib/node-red/.node-red/osi_auth_token_secret`, else generate one. |
| `OSI_SCOPED_ACCESS` | `1` or `0`, read per request as the flows do. |
| `DEVICE_EUI`, `LINK_GATEWAY_DEVICE_EUI`, `TZ`, `CHIRPSTACK_*` | As the Node-RED init script sets them (synthetic values). |

## Test hooks (only with `OSI_EDGE_TEST_HOOKS=1`)

| Hook | Behaviour |
|---|---|
| `GET /__test/ready` | 200 with `{"ok":true,"nonce":<OSI_EDGE_TEST_NONCE>}` once HTTP, the database and the MQTT subscription are up. The harness rejects any other answer. |
| `POST /__test/settle` | 200 once every received uplink and every queued job has finished its database writes. |
| `POST /__test/timer/<name>` | Runs one tick of the named timer synchronously, then 200. Names: `edge/harness/timers.json`. |

Timers do not run on their own schedule while test hooks are on, exactly
as the oracle pauses its inject timers after boot.

## What is compared

Per step: HTTP status, the contract headers (`content-type`,
`content-disposition`, `location`, `cache-control`, CORS headers), the body
after normalisation (`lib/normalize.js`: volatile ids and clocks become
placeholders that keep their text form), the UTF-8 BOM, the database diff
of every table (rows added, removed, changed), the gRPC calls and the MQTT
publications. JSON key order alone is reported as a warning.

Cloud scenarios require Podman. The `cloud` field records packets in both
directions, with PUBLISH payloads as base64 so comparison preserves every byte.
The comparator matches packet IDs across PUBLISH and PUBACK and normalizes
the numeric value of message expiry when present.

`cloudHoldPuback` on an uplink step intercepts the next broker PUBACK and
marks it `forwarded: false`. A `cloudBroker: "restart"` step stops the
container, sends its `outageUplinks` to the local broker, then starts the
same container and waits for a fresh CONNACK.

## Byte-exact vectors

`edge/vectors/*.vectors.json` are generated from the shipped JavaScript
(`node edge/vectors/generate.js`). A backend must reproduce every `expect`
exactly; the value encoding is described at the top of `generate.js`.
