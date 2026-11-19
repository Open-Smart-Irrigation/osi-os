# Preserve uplinks across a Node-RED restart

Status: implementation draft; independent plan review and verification pending.
The task forbids subagents, review requests and merging. The lead owns review.
Base: `234a3635867db4a71bb921aba1f65b2a734abcbb`.

Set all maintained MQTT inputs to QoS 1, preserve the `nodered` MQTT 3.1.1
persistent session, disable `autoUnsubscribe` so input shutdown retains its
subscription, and set the image ChirpStack integration publish QoS to 1.
Pin Mosquitto's queue to 1,000 messages and 16 MiB per client. Keep disk
persistence disabled: the broker continues running during this outage.

Use the inserted measurement itself as the durable receipt. Migration
`0081__uplink_idempotency.sql` adds nullable `uplink_key` columns and partial
unique indexes on `(deveui, uplink_key)` in `device_data`, `watermark_readings`
and `sdi12_transmissions`. Add equivalent seed DDL and verifier contracts,
rebuild all seven seeds, reapply the Chameleon snapshot, then verify ledger 81.
No existing row is keyed, deleted or repaired.

`osi-uplink-dedup-guard/durable.js` hashes decoder source plus the ChirpStack
event id, falling back only to frame counter plus original network time.
Missing identity stays NULL. Combine multipart SDI12 frame keys in sorted order.
Deliver this helper through a required staged fetch in `deploy.sh`.

Pass the key through the KIWI SQL builder, UC512 writer, LSN50 canonical writer,
STREGA telemetry and SDI12 handler. STREGA checks its receipt inside the
observation transaction before a report can update observed state. Preserve
the existing post-commit close-evidence retry for repeated CLOSED reports. The shared writer returns the existing row
id with `duplicate: true`; it uses a targeted conflict clause, preserving other
constraint errors. LSN50 skips derivative writes, and Tensiomark skips evidence
insertion. WATERMARK checks its raw receipt inside the measurement transaction.
Its rejected-frame receipts are also durable. Deduplicate the SDI12 raw archive
and skip commissioning/first-join work for an existing canonical observation.
Rain and radio already have durable identities. Existing flow node ids, wiring
and in-memory guards remain; every changed function stays below its base size.

The configuration test failed on base for mixed QoS and missing publisher/queue
settings. The writer test reproduced duplicate canonical inserts before the fix.
Require regression cases for module/database reopen, rollback/retry, independent
sources, rejoin, missing identity and multipart order. Rehearse 360 offline
messages plus an intentional replay on local Mosquitto under `osi-heavy`.
Register the new test in `migrations.yml`; keep the physical qualification steps
in `docs/operations/mqtt-uplink-restart.md`.

Run the affected module suites, flow checklist, migration/seed/schema gates and
the binding common gates. Record every exit code. All test runs use the task's
build directory as TMPDIR because /tmp has a per-user quota. The final draft PR
states the field-upgrade limitation and proposes the separately reviewed one-shot
pattern; no gateway or other branch is touched.
