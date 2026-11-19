# Uplinks during a Node-RED restart

The local MQTT session queues uplinks while Node-RED is offline once both
ChirpStack's integration publisher and the Node-RED subscriptions use QoS 1.
The client id stays `nodered`, with MQTT 3.1.1 and `cleansession: false`.
A QoS 2 subscription cannot upgrade a QoS 1 publication.

The broker node also sets `autoUnsubscribe: false`. The image pins Node-RED
3.1.15, whose default is true: closing input nodes can otherwise unsubscribe
from the broker before disconnecting, leaving a persistent session with no
uplink subscription.

The image configures 1,000 queued messages and 16 MiB per client. A 60-second
outage at six uplinks per second needs 360 slots; 360 envelopes of 16 KiB
need less than 6 MiB. Other traffic on the same session also consumes this
budget. Mosquitto drops subsequent messages when either queue limit is reached.

`persistence false` retains the session and queue in memory while the broker
runs. This covers a Node-RED-only restart. It does not cover broker restart,
power loss, or a message acknowledged by the MQTT client immediately before
Node-RED crashes before its database write commits. A durable application inbox
would be a separate change.

## Duplicate identity

Migration 0081 adds nullable `uplink_key` columns with partial unique indexes on
`(deveui, uplink_key)` to `device_data`, `watermark_readings` and
`sdi12_transmissions`. Existing history stays unchanged and is excluded from
these new indexes. The inserted row itself is the durable receipt, so a rollback
also rolls back its identity.

Keys prefer ChirpStack's `deduplicationId` and include the decoder source. The
legacy fallback requires the original network timestamp and frame counter;
frame counter alone is unsafe after a rejoin. Missing identity leaves the key
NULL. SDI12 multipart keys combine the original frame identities in sorted order.

KIWI/CLOVER SQL, the shared device writer and STREGA raw telemetry suppress a
conflicting insert. LSN50 skips downstream Chameleon/dendrometer writes when
its canonical row already exists. WATERMARK's raw receipt and measurement share
one transaction, including rejected-frame receipts. Tensiomark skips its evidence
insert on a duplicate canonical row. The SDI12 archive also suppresses retries.
The in-memory guard uses the same network identity builder as the durable
key. Local receipt time controls cache expiry only; it never proves a duplicate.

STREGA checks its receipt inside the existing observation transaction, before
applying the report to observed state. This also stops an old report with an
untrusted timestamp from replacing a newer observed state after redelivery.
Repeated CLOSED reports retain the existing post-commit close-evidence retry.
SDI12 duplicates skip acquisition bookkeeping and first-join work, so timestamp
clamping cannot turn repeated delivery into several commissioning failures.
Unsupported payloads retain their original frames before the gate returns.
The edge-local `uplink_effect_receipts` table in migration 0081 covers effects
without a canonical measurement: rejection quarantine and commissioning updates
commit with their receipts in one transaction. Observation failures roll them
back for retry. Identify replies and STREGA ACKs also use transactional receipts,
so an old reply cannot advance a later attempt or consume a successor push.
The shared writer commits the canonical insert, unknown-channel quarantine
and eviction in one transaction, including concurrent deliveries. A quarantine
failure rolls back the canonical row so a retry can recover both. Synchronous
callers use a savepoint; standalone facade handles own a queued transaction,
and existing transaction scopes remain owned by their caller.

S2120 and LoRain already claim a durable `rain_observations` event identity.
Identity-conflict quarantine also has a transactional receipt. Its legacy key
uses the matched observation and conflicting payload digest, so a repeated
conflict adds no further evidence rows while a later frame-counter reuse
retains its own evidence. The canonical one-hour matching window is unchanged.
Radio capture already merges observations by installation and deduplication id;
missing network ids use the same original timestamp/frame fallback. Field-tester
reply enqueueing has a separate receipt; a failed enqueue rolls it back. MQTT
relay outputs still carry at-least-once transport semantics; their receivers
must handle repeated envelopes. The new keys are edge-local:
sync event fields and canonical history hashes keep their existing contracts.

## Script-upgraded gateways

Routine `deploy.sh` payload updates deliver flows, helper modules and the ordered
migration. They do **not** replace the image's ChirpStack init or Mosquitto config.
Updating flows alone therefore does not establish QoS 1 end to end on an older
gateway. The first activation also needs a successful QoS 1 subscription before
its persistent session can queue subsequent offline traffic.

Use the separately reviewed one-shot init-upgrade pattern from PR #673 for a
future field rollout: preserve and validate the original init, set the MQTT
integration QoS alongside the pragmas, verify generated TOML, and retain rollback.
Extend that proposal to preserve and check the broker config and queue settings.
Do not silently fold a ChirpStack or broker restart into ordinary payload deploys.
This patch does not change #673 or run a one-shot on any gateway.

The upstream CGOS profile broker config has the same three directives as this
repository's previous image config. Neither specifies persistence or queue
limits. Installed field overrides have not been inspected. Mosquitto 2.0 defaults
are persistence off, 1,000 queued messages, unlimited queued bytes, and no queued
QoS 0 messages. The explicit byte cap bounds memory; the message default already
covers the stated outage.

Sources checked on 2026-11-19:

- ChirpStack's example configs omit integration QoS in both
  [4.12.1](https://github.com/chirpstack/chirpstack/blob/v4.12.1/chirpstack/configuration/chirpstack.toml)
  and [4.16.0](https://github.com/chirpstack/chirpstack/blob/v4.16.0/chirpstack/configuration/chirpstack.toml).
  Their configuration implementations define `qos` and default it to zero:
  [4.12.1](https://github.com/chirpstack/chirpstack/blob/v4.12.1/chirpstack/src/config.rs),
  [4.16.0](https://github.com/chirpstack/chirpstack/blob/v4.16.0/chirpstack/src/config.rs).
- [CGOS profile broker config](https://github.com/chirpstack/chirpstack-gateway-os/blob/22f85a51ac79b0641975b449737127cb03f9d340/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/mosquitto/mosquitto.conf).
- [Node-RED 3.1.15 MQTT lifecycle](https://github.com/node-red/node-red/blob/3.1.15/packages/node_modules/@node-red/nodes/core/network/10-mqtt.js),
  the auto-unsubscribe default and input-node close handler.
- [Mosquitto configuration manual](https://mosquitto.org/man/mosquitto-conf-5.html),
  the persistence and queue-limit sections. The local rehearsal uses 2.0.22.

## Qualification sheet

The opt-in local test starts a disposable, network-isolated Mosquitto 2.0.22
container with the shipped config. It establishes the persistent subscription,
exits the subscriber, publishes 360 distinct integration envelopes plus a replay,
and reconnects with the same client id. It checks all 361 deliveries and writes
360 canonical rows. Run it under `osi-heavy`, with `TMPDIR` on a filesystem with
sufficient per-user quota, using `OSI_MQTT_RESTART_TEST=1 node --test
scripts/test-mqtt-uplink-reliability.js`.

For the real-device sheet, after the operator has named and authorized the test
gateway:

1. Verify generated `[integration.mqtt] qos=1`, all ten subscription QoS values,
   client id, clean-session and auto-unsubscribe flags, and active broker queue settings. Start Node-RED
   once to register the new subscription; save broker and ChirpStack process ids.
2. Record canonical row counts and the event-id/frame-counter baseline for a
   configured sensor. Stop only Node-RED. Keep publishing through ChirpStack at
   six distinct uplinks per second for 60 seconds, then restart Node-RED.
3. Verify the broker and ChirpStack process ids did not change. Confirm all 360
   identities arrive and produce the expected canonical rows, with no unexplained
   counter gaps. Replay an identical event, restart Node-RED, and replay it again;
   the canonical row and outbox event counts must stay unchanged.
4. Repeat with two distinct deduplication ids sharing a frame counter to model a
   rejoin. Both must be stored. Check radio and any enabled raw diagnostic tables
   independently. Record errors, backlog drain time and payload sizes.

The local test exercises MQTT clients and the shared writer. It does not run
Node-RED itself, ChirpStack, procd, physical sensors or an actual gateway restart.
