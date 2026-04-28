# Reproducible Pi Communication Design

## Context

The OSI edge communication stack currently spans local ChirpStack MQTT, Node-RED runtime configuration, OSI Cloud MQTT telemetry, and REST sync. Live evidence collected read-only on 2026-04-28 from Uganda, kaba100, and Silvan shows the stack works in places because each Pi has accumulated runtime-specific state, not because the repo is fully reproducible.

The current live pattern is:

- Repo `flows.json` uses portable MQTT IN topics: `application/+/device/+/event/up`.
- Live `/srv/node-red/flows.json` on all three Pis has been mutated by `chirpstack-bootstrap.js` to use app-specific LSN50 and field-tester topics.
- Live STREGA downlink functions on all three Pis still use `const FIXED_APP_ID = 'af28ecae-1af8-4ffe-8576-76384b6805ca';`.
- That STREGA ID does not match the live Actuators app ID on Uganda, kaba100, or Silvan.
- Runtime ChirpStack app/profile IDs are split between UCI and `/srv/node-red/.chirpstack.env`. Silvan has the IDs in `.chirpstack.env` but empty UCI values.

This design removes installation-specific flow mutation and makes runtime configuration explicit, validated, and reproducible.

## Goals

- A clean repo checkout plus documented bootstrap/deploy steps should produce a working Pi without manual flow hotfixes.
- `flows.json` must remain installation-neutral across all hardware variants.
- Bootstrap should provision or discover ChirpStack resources and persist runtime configuration, not rewrite flow logic to embed local IDs.
- Local downlinks must use runtime app IDs from environment/configuration, not hardcoded UUIDs.
- Deploy and startup should validate communication-critical configuration and fail loudly where silent failure would lose data or commands.
- Live rollout must be safe for Uganda and the demo Pis: backup first, read-only diagnostics before changes, narrow deployment, and measurable post-checks.

## Non-Goals

- Replace Node-RED with a new backend.
- Change the REST-only cloud-to-edge command architecture.
- Remove MQTT telemetry or ChirpStack local MQTT.
- Rework all flow logic unrelated to communication reproducibility.
- Perform live Pi writes as part of the design phase.

## Architecture

The edge communication architecture keeps four separate paths:

1. Local ChirpStack uplinks: local MQTT broker publishes `application/<appId>/device/<devEui>/event/up`; Node-RED subscribes with `application/+/device/+/event/up`; downstream function nodes route by device profile ID/name and local device records.
2. Local ChirpStack downlinks: Node-RED publishes command/down messages to `application/<runtimeAppId>/device/<devEui>/command/down`; `<runtimeAppId>` comes from runtime config.
3. Edge to cloud MQTT: Node-RED publishes heartbeat, telemetry, status, and command ACKs to OSI Cloud using the canonical uppercase gateway EUI and cloud MQTT password.
4. Cloud to edge REST: Node-RED polls bootstrap/events/pending-commands/status endpoints with the sync token.

Installation-specific IDs are runtime data. They may live in UCI and `.chirpstack.env`, but they must not be baked into checked-in flow behavior.

## Configuration Contract

UCI is the canonical runtime source for Node-RED startup:

- `osi-server.cloud.chirpstack_app_sensors`
- `osi-server.cloud.chirpstack_app_actuators`
- `osi-server.cloud.chirpstack_app_field_tester`
- `osi-server.cloud.chirpstack_profile_kiwi`
- `osi-server.cloud.chirpstack_profile_strega`
- `osi-server.cloud.chirpstack_profile_lsn50`
- `osi-server.cloud.chirpstack_profile_clover`
- `osi-server.cloud.chirpstack_profile_s2120`

`/srv/node-red/.chirpstack.env` remains a compatibility fallback during upgrades. Bootstrap writes both UCI and `.chirpstack.env` until all live Pis are migrated. `node-red.init` reads UCI first, then falls back to `.chirpstack.env` for missing ChirpStack app/profile IDs.

Fallback must be per key, not all-or-nothing. A Pi may have a valid `chirpstack_app_sensors` in UCI and a valid `CHIRPSTACK_APP_ACTUATORS` only in `.chirpstack.env`. Startup must merge these safely by evaluating each required key independently:

1. use a non-empty UCI value when present,
2. otherwise use the matching `.chirpstack.env` value when present,
3. otherwise leave the environment variable empty and let the flow command path fail loudly for commands that require it.

The init script should log the source for each communication-critical key as `uci`, `env-fallback`, or `missing`, without logging secrets. This makes partial migration states debuggable and avoids Silvan-style empty UCI values breaking otherwise valid compatibility config.

Gateway identity remains canonicalized through `/usr/libexec/osi-gateway-identity.sh`. Runtime `DEVICE_EUI` and `LINK_GATEWAY_DEVICE_EUI` stay uppercase before Node-RED uses them.

## Flow Contract

All MQTT IN nodes in checked-in and deployed `flows.json` must use:

```text
application/+/device/+/event/up
```

Function nodes must ignore irrelevant devices by profile or DB device type. Device profile routing may use:

- runtime `CHIRPSTACK_PROFILE_*` values,
- stable profile-name checks such as `KIWI`, `STREGA`, `LSN50`, `DRAGINO`, `CLOVER`,
- local DB device type checks when needed for safety.

No MQTT IN node may use `application/<uuid>/...`.

Downlink function nodes may use runtime app IDs:

- STREGA commands use `CHIRPSTACK_APP_ACTUATORS`.
- LSN50 and Kiwi configuration commands use `CHIRPSTACK_APP_SENSORS`.

If a required app ID is missing, the function must not publish a command to a fallback UUID. It should return a failed command ACK when the incoming command has a command ID and log a clear local status.

## Bootstrap Behavior

`scripts/chirpstack-bootstrap.js` is responsible for:

- Creating or discovering ChirpStack tenant, applications, profiles, codecs, and API key.
- Writing the discovered IDs to `/srv/node-red/.chirpstack.env`.
- Persisting the same IDs into UCI `osi-server.cloud.*`.
- Patching `settings.js` only to load `.chirpstack.env` as compatibility fallback.
- Leaving MQTT IN topics wildcarded.

Bootstrap must not write app-specific MQTT IN topics.

Bootstrap must be idempotent on an already configured Pi. It should discover existing resources, compare them with persisted IDs, and update missing runtime config without deleting or recreating working ChirpStack resources.

Legacy flow repair must be conservative and explicit. Normal bootstrap should detect app-specific MQTT IN topics and hardcoded downlink IDs, then fail with a clear diagnostic unless it is invoked with an explicit repair flag. The repair mode may only replace known legacy topic shapes with `application/+/device/+/event/up` and must write a timestamped backup before modifying `/srv/node-red/flows.json`.

## Deploy Behavior

`deploy.sh` may copy the repo flow to `/srv/node-red/flows.json`, but that flow must already be portable. Deploy should include a communication validation step that checks:

- all MQTT IN topics are wildcarded,
- STREGA downlink does not contain `FIXED_APP_ID`,
- cloud MQTT broker client ID can be written from canonical `DEVICE_EUI`,
- `flows_cred.json` is regenerated when EUI/password are present,
- live DB is preserved and not overwritten.

Deploy should not require a manual post-deploy hotfix. If bootstrap must run after deploy, bootstrap should be idempotent and should preserve the portable flow contract.

## Runtime Diagnostics

Add a read-only diagnostic script suitable for any Pi. It should report, without exposing secrets:

- gateway identity and confidence,
- UCI ChirpStack app/profile values,
- `.chirpstack.env` ChirpStack app/profile values,
- MQTT IN topic list,
- STREGA/Kiwi/LSN50 downlink source checks,
- cloud MQTT client ID and credential presence,
- latest `device_data` per device,
- required sync triggers,
- pending and delivered `sync_outbox` counts,
- recent Node-RED/MQTT/ChirpStack error log lines.

The script should be dependency-light and degrade gracefully. It should use POSIX shell plus BusyBox-compatible commands where possible. If `sqlite3` is present, it should query SQLite directly. If `sqlite3` is absent or the schema differs, it should still report file presence, mtimes, Node-RED flow checks, UCI/env values, MQTT credential presence, and service logs, then mark DB-derived checks as `skipped: sqlite3 unavailable`.

## Verification

Repo verification must include:

- `scripts/check-mqtt-topics.sh` fails on any MQTT IN topic other than `application/+/device/+/event/up`.
- `scripts/verify-sync-flow.js` asserts STREGA downlink uses `CHIRPSTACK_APP_ACTUATORS` and no longer uses `FIXED_APP_ID`.
- Bootstrap source checks assert no code writes `application/${sensorsAppId}/device/#` or `application/${fieldTesterAppId}/#`.
- Bootstrap tests or source checks assert UCI persistence of `CHIRPSTACK_APP_*` and `CHIRPSTACK_PROFILE_*`.
- Node-RED init checks assert `.chirpstack.env` fallback for missing UCI values.

Live rollout verification must include:

- pre-change diagnostic output saved locally,
- backup path recorded before any write,
- post-deploy diagnostic output saved locally,
- fresh local `device_data` after a natural or observed uplink,
- sync outbox delivery advances or remains healthy,
- cloud MQTT client ID matches `device_<uppercase gateway EUI>`,
- STREGA downlink construction targets the runtime Actuators app ID.

Regression tests must cover partial configuration states:

- all keys in UCI and `.chirpstack.env`,
- mixed UCI/env fallback, including the Silvan shape where UCI ChirpStack IDs are empty,
- missing Actuators app ID causing a failed command ACK instead of publishing to a fallback UUID,
- missing Sensors app ID causing LSN50/Kiwi config commands to fail loudly,
- legacy app-specific MQTT IN topics rejected by normal bootstrap/deploy validation.

## Rollout Strategy

1. Implement and verify repo changes locally.
2. Run read-only diagnostics on Uganda, kaba100, and Silvan.
3. Choose a demo Pi first, preferably kaba100 because it has active device_data and sqlite3 available.
4. Take a timestamped backup of `/data/db`, `/srv/node-red`, `/usr/lib/node-red/gui`, `/etc/init.d/node-red`, `flows.json`, and `settings.js`.
5. Deploy the narrow artifact set.
6. Restart Node-RED only during the approved rollout window.
7. Run post-check diagnostics and compare with pre-check diagnostics.
8. Repeat for the second demo Pi.
9. Roll out Uganda only after demo Pi checks prove the path.

Rollback uses the timestamped backup and restores the previous runtime artifacts if Node-RED fails to start, local ingest stops, sync outbox delivery regresses, or STREGA command construction still targets a non-runtime app ID.

Because Uganda already has communication issues, rollout to Uganda has stricter gates:

- no Uganda write until at least one demo Pi has passed post-checks for local ingest, sync outbox delivery, cloud MQTT identity, and STREGA runtime app selection,
- no automatic ChirpStack resource deletion or recreation during rollout,
- no automatic legacy flow repair during normal bootstrap on Uganda,
- abort before restart if preflight shows required app/profile IDs are missing from both UCI and `.chirpstack.env`,
- record pre-change and post-change diagnostics side by side so a rollback decision is based on observed deltas, not only service start status.

File backup alone is not considered a complete rollback plan for stateful services. Before a live write, record the ChirpStack app/profile IDs, Node-RED flow checksum, credential presence, DB sidecar files, and sync outbox counters. Rollback restores files from backup and then reruns diagnostics to confirm that these state indicators match the pre-change baseline as closely as possible.

## Consolidated Review Risks

External review identified five implementation risks that must remain visible during planning:

- Partial UCI/env fallback is easy to get wrong; tests must prove per-key merge behavior.
- Uganda rollback risk is higher than the other Pis because file restore may not undo transient state changes in ChirpStack, MQTT sessions, or queued sync work.
- Bootstrap repair logic can itself become a source of breakage; normal bootstrap should detect and stop, with repair behind an explicit flag and backup.
- Diagnostics must still be useful when `sqlite3` is missing, as seen on Silvan.
- The `CHIRPSTACK_PROFILE_CLOVER` versus `CHIRPSTACK_PROFILE_RAK10701` mismatch and field tester flow inclusion are unresolved compatibility questions that should be resolved before broad rollout, even though they do not block the STREGA hardcoded-ID fix.

## Open Questions

- Whether `CHIRPSTACK_PROFILE_CLOVER` should remain a separate UCI key when bootstrap currently creates `CHIRPSTACK_PROFILE_RAK10701` but not a Clover profile.
- Whether field tester MQTT IN should remain in the shipped flow or be disabled until a field tester is configured.
- Whether Silvan should install `sqlite3` for diagnostics or diagnostics should always rely on Node/helper APIs there.

These questions do not block the main reproducibility fix.
