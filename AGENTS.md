# AGENTS.md — OSI OS (Edge)

Operational source of truth for `osi-os`. The edge is canonical; `osi-server` mirrors edge-backed farms. Cloud-originated edits are pending until the edge applies them.

Sister repo: [`osi-server`](../osi-server/AGENTS.md).

> **How to work here:** [docs/engineering-playbook.md](docs/engineering-playbook.md) — the working loop (§2: a standard loop, and the full plan-first loop for risk classes), the thinking tools, and the failure modes this repo has already paid for. Read it before your first non-trivial change; hold every PR to its §8 definition of done.

Binding rules come first in this file; reference detail lives in the docs and skills each section links. Some harnesses read only the first 32 KiB of this file, so move reference material out instead of letting the file grow (`node scripts/verify-agents-size.js`).

---

## Architecture

```
Pi (edge)
  ├── Node-RED  (:1880, LAN-reachable)  — REST API, scheduler, sync orchestration
  │     ├── SQLite  /data/db/farming.db — canonical local state
  │     └── React GUI  /gui             — farmer dashboard
  ├── ChirpStack (LoRaWAN NS, :8080)    — sensor uplinks / valve downlinks
  └── osi-bootstrap (first boot)        — auto-provisions ChirpStack + UCI identity

  ↕ REST/HTTPS (primary, bidirectional)
  ↕ MQTT/WSS:443 (telemetry only, edge → cloud)

osi-server (cloud) — see ../osi-server/AGENTS.md
```

**REST is the only cloud→edge command path.** MQTT carries only edge→cloud telemetry, heartbeats, status, and ACKs. The edge is **not** subscribed to the cloud broker.

Per-module system map (both repos, every module described with location): [docs/architecture/system-map/](docs/architecture/system-map/README.md) (plain-language) and [docs/architecture/system-map-technical/](docs/architecture/system-map-technical/README.md) (engineering edition). Snapshot-dated; AGENTS.md wins on conflict.

## Branch and tag visibility

Customer branches and `archive/*` tags live in a private repository. Never push
either ref class to the public `origin`; keep the public repository's branches
and tags free of customer-specific history.

---

## Host access gate

- Gated hosts: the production OSI Server (`osicloud.ch`) and every customer-hosted cloud instance (listed in the private operations docs, never here).
- Before any SSH session, file inspection, environment read, secret copy or command on a gated host, the user must name that host in the current turn. A loaded key, a local alias or a successful `ssh` probe is never consent.
- Ambiguous requests such as "the other server" are not enough; clarify, or use the test host `server.opensmartirrigation.org` instead. The test host can carry production gateway data (noted 2026-10-22); treat data-changing operations there as production-affecting.

---

## Live-deploy safety rules

- **Flaky link (Uganda-class Tailscale/cellular):** the default `deploy.sh`
  tunnel flow dies with the SSH session, mid-deploy. Use the bundle path
  (`scripts/deploy-bundle.sh`, `deploy-push-bundle.sh`, `deploy-offline.sh`
  under `setsid`):
  [docs/operations/deploying-over-a-flaky-link.md](docs/operations/deploying-over-a-flaky-link.md).
  The tunnel flow stays the default on a stable LAN.
- **Never** overwrite `/data/db/farming.db` on a running or previously provisioned Pi. `deploy.sh` only seeds on a fresh device (target file absent and no orphaned WAL/SHM/journal sidecars). The bundled seed ships already stamped at the migration head (full `schema_migrations` ledger plus `schema_object_fingerprints`); an unstamped seed sends every fresh install into a 1..head rebuild that is not a viable deploy step on a Pi (why: `osi-live-ops-runbook`, rule 1). `scripts/verify-seed-db-ledger.js` is the gate; regenerate with `node scripts/build-seed-db.js`, never by applying a migration to the bundled `.db` files by hand.
- `deploy.sh` pins the command ledger (`osi-command-ledger/index.js` and
  `package.json`), the WATERMARK binding
  (`osi-watermark-binding/canonicalization.js`) and the staging installer
  (`scripts/deploy-command-ledger-dependency.js`) by SHA-256
  (`COMMAND_LEDGER_*_SHA256`). A change to any of them updates its pin in the
  same commit; `node --test scripts/deploy-command-ledger-dependency.test.js`
  fails otherwise, and a deploy with a stale pin aborts before activation.
- Before risky repair: timestamped backup under `/data/db/backups/osi-os-<timestamp>/` taken with `sqlite3 /data/db/farming.db ".backup '<dir>/farming.db'"` (online and WAL-consistent; never copy the DB and its `-wal`/`-shm` separately while Node-RED runs), plus `cp -aL` of `/srv/node-red/flows.json`, `settings.js`, `flows_cred.json` and `/usr/lib/node-red/gui/`. Procedure: `osi-live-ops-runbook`.
- Schema changes go via migrations or idempotent SQL; never replace `farming.db`.
- **After an integration merge, reconcile artifacts against both parents even when Git reports a clean merge.** Resolve the integrating checkout's local attributes path with `git rev-parse --git-path info/attributes` and inspect it when present; retain `git check-attr merge -- <paths>` for effective attributes and inspect configured drivers with `git config --show-origin --get-regexp '^merge\..*\.driver$'`. Compare each parent's artifact with the result. Compare every bundled database individually with both parents: `database/farming.db`, `web/react-gui/farming.db`, `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`, `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`, `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`, `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`, and `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`. Reconcile ordered SQL files and `database/migrations/ordered/CHECKSUMS.json` against approved source history; never create trusted checksums by hashing whichever SQL survived. Run `node scripts/verify-migrations.js` on the approved corpus. Rebuild bundled seeds with `node scripts/build-seed-db.js` only when that approved corpus advances the migration head; otherwise leave the seed images unchanged. After rebuilding, run the schema skill's `verify-migrations.js`, `verify-seed-replay.js`, `verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js`, `verify-no-stray-ddl.js`, `verify-profile-parity.js`, `verify-seed-db-ledger.js`, and `verify-sqlite-cli-limits.js`; add `test-journal-schema.js` for journal-catalog changes. `build-seed-db.js` does not write `CHECKSUMS.json`. Check allowance preservation with `node scripts/verify-merge-allowance-preservation.js --left-ref HEAD^1 --right-ref HEAD^2`; for a removal or reduction, record measured reasons in a SHA-bound receipt and rerun with `--dispositions <receipt.json>`.
- **Stale-stamp recovery:** if `applyPending`/`verifyHead` report fingerprint drift after a crash between a migration commit and its stamp, and the live schema is confirmed correct, re-baseline with `node scripts/restamp-fingerprints.js /data/db/farming.db`. This is the ONLY sanctioned way to overwrite the fingerprint baseline; do not hand-edit `schema_object_fingerprints`.
- **Foreign-numbered ledger recovery:** a gateway that ran a customer line can
  carry `schema_migrations` rows numbered under that line's own scheme;
  `applyPending` refuses on the checksum mismatch (`repair_required`) and
  `deploy.sh` aborts before the payload flip. `node scripts/reconcile-ledger-numbering.js <db> --report`
  (dry run; add `--apply` plus `--backup-dir` to act) is the ONLY sanctioned
  recovery; it refuses and touches nothing on any unproven row, and
  `deploy.sh`'s `run_schema_migration()` calls it automatically when an applied
  row above version 21 disagrees with main's `CHECKSUMS.json`.
  `--clear-repair-required` is the narrower recovery for a row stuck
  `repair_required` whose checksum already matches main; it never clears one
  that still disagrees. Never hand-edit `schema_migrations` outside these two
  sanctioned tools. Rehearse on a copy with `scripts/rehearse-ledger-cutover.js`.
  Long form: `osi-live-ops-runbook`, "Foreign-numbered ledger recovery".
- Stale `/srv/node-red/.chirpstack.env` `DEVICE_EUI*` values are legacy
  artifacts. Current `node-red.init` does not read identity from that file, and
  `settings.js` protects identity keys, but operators should still remove stale
  identity lines during repair so no future or manual env-file path can revive
  them. Canonical EUI is uppercase and comes from the helper / UCI path.

---

## Schema and migration rules

Load `osi-schema-change-control` before any schema change.

- SQLite startup migrations must preserve local history. If a parent table such as `devices` is rebuilt with a drop/rename swap, fence the swap with `PRAGMA foreign_keys=OFF` and restore `PRAGMA foreign_keys=ON` after the final drop; otherwise `ON DELETE CASCADE` child tables such as `device_data` and `chameleon_readings` can be wiped on Node-RED startup. See [docs/operations/edge-history-retention.md](docs/operations/edge-history-retention.md).
- **Profile parity invariant:** `bcm2712 / DEVICE_rpi-5` is the canonical source-of-truth for all OSI runtime payload files (flows, codecs, DB, bootstrap, helpers). `bcm2709 / DEVICE_rpi-2` mirrors that payload byte-for-byte; `scripts/verify-profile-parity.js` enforces this for the paths in its `CANONICAL_PAYLOAD` list and is chained from `scripts/verify-sync-flow.js`. Any change to a file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` must also be propagated to `conf/full_raspberrypi_bcm27xx_bcm2709/files/`, listed or not.

### Boot-DDL freeze (edge schema)

`sync-init-fn` (Node-RED "Sync Init Schema + Triggers") performs schema DDL inline
on every boot (incl. ~93 ADD COLUMNs, 81 of them redundant with the seed; the
verifier's past `duplicate column` failures were the stale upgrade-test baseline,
issue #84 — not this node). This node is FROZEN:
do not add new schema behavior there. New schema changes go through the migration
runner (`lib/osi-migrate`). `scripts/verify-runtime-schema-parity.js` (CI-gated) fails
if the shipped flow DOWNGRADES `database/seed-blank.sql` (devices CHECK / triggers).
Replacing the inline boot DDL with the runner ("Option B") is a separate boot-path
project — see the ADR trigger conditions.

The boot node remains frozen for *schema* changes; the guarded + fail-closed `devices`
rebuild (2026-07, both profiles) is the sanctioned exception, because it is a safety
fix rather than new schema behavior: the rebuild only runs when the live `devices`
CHECK is missing a required `type_id`, copies rows with a plain `INSERT` inside
`_db.transaction()` (a CHECK violation throws → ROLLBACK, `devices` left intact —
no more silent `INSERT OR IGNORE` drops), and restores `PRAGMA foreign_keys=ON` in a
`finally` on every exit path; errors are surfaced via `node.error`, never swallowed.
Merge gate for any further touch to this block: `verify-runtime-schema-parity.js` +
`verify-profile-parity.js` + `verify-devices-rebuild-fence.js` +
`node --test scripts/rehearse-devices-rebuild.test.js` green, plus a production-copy
rehearsal.

### Migration risk classes

- `additive` — append-only schema (new tables, columns, indexes, views, triggers). No backup, no FK toggle; runs in one `BEGIN IMMEDIATE` transaction with its ledger row.
- `destructive` — schema mutation (drop/rename/rebuild/alter). Requires `writersStopped=true` (deploy pre-start), toggles `PRAGMA foreign_keys` outside the transaction, and takes a backup. Fenced: `BEGIN`/`COMMIT` inside the FK toggle.
- `data` — data backfill/mutation: takes an online backup, applies in a normal transaction (no FK fence, no writers-stopped gate). Run at deploy (a long backfill holds the write lock past the 5s runtime busy timeout); write it idempotently against the pre-migration row format.

### SWT history repairs

Chameleon SWT analysis reads canonical kPa values from `device_data.swt_1`, `swt_2`, and `swt_3`. `chameleon_readings` is the raw/diagnostic mirror. If historical SWT values are repaired from `chameleon_readings` plus `chameleon_calibrations`, update `device_data` too. Historical repairs that UPDATE `device_data` rows are carried by the `trg_sync_device_data_dirty_au` trigger → `sync_history_dirty_keys` → history correction phase. Do not enqueue explicit `DEVICE_DATA_APPENDED` events for them: every such event has `sync_version` 0, and the cloud rejects a changed payload at an equal version as `equal_version_payload_conflict`. Update by row `id`: `device_data` has no UNIQUE(deveui, recorded_at). Historical clipped WATERMARK nulls use the explicit backed-up correction tool ([unified soil tension](docs/operations/unified-soil-tension.md)), never replacement append events.

---

## Sync model

- Edge writes canonical local state first, then emits events to the outbox.
- Cloud mirrors via REST polling; cloud-originated edits arrive via pending-commands.
- Identifiers: `user_uuid`, `zone_uuid`, `gateway_device_eui`, `sync_version`. Tombstones via `deleted_at`.
- Tables: `sync_outbox` (pending → cloud), `sync_inbox` (dedupe incoming), `sync_cursor` (progress).
- **Protected exact-base commands** (`SET_WATERMARK_CALIBRATION`,
  `DELETE_WATERMARK_CALIBRATION`, `SET_CHAMELEON_CONFIG`,
  `UPSERT_DEVICE_SOIL_DEPTHS`): an applied write stays pending until both the
  authoritative acknowledgement and mirror convergence arrive, in either order.
  A definitive non-application acknowledgement settles without mirror
  convergence. The cloud never updates the confirmed edge-owned value when it
  queues a command. Deploy the cloud contract, appliers, pending-command
  support, and read-only UI before an edge that advertises the three
  WATERMARK-related capabilities. Effect keys, base rules, post-deploy
  capability gating, the edge-only diagnostics boundary and the Data-view
  soil-source rule (`isSoilSource`):
  [docs/sync/watermark-cloud-parity.md](docs/sync/watermark-cloud-parity.md).
- **WATERMARK scheduler interlock:** the scheduler still rejects every
  `device_data` row linked to `watermark_readings`, regardless of legacy device
  flags. Cloud parity and field qualification records do not lift it.
- **Zone `weather_source`:** the cloud puts `weatherSource` into zone commands
  only for a gateway that reported `zone_config_weather_source_v1` (and
  `stageStartedOn` only with `zone_config_stage_started_on_v1`); the edge sends
  `weather_source` only when the stored value is not `auto` or (update event
  only) changed in that update, never as an unconditional default. Detail:
  [docs/api/sync-endpoints.md](docs/api/sync-endpoints.md) ("Sync
  capabilities the edge reports") and "Zone weather_source" in
  `docs/contracts/sync-schema/README.md`.
- **Live gateway identity:** `osi-identityd` owns it after boot. During a live
  identity transition, link and sync builders read only the restart sentinel
  and fail closed; they never substitute the cache's candidate EUI. Bootstrap,
  link and unlink publish restart requests instead of restarting Node-RED
  directly. Do not route identity transitions through the GUI
  `/api/system/reboot` route, and do not edit `sync-init-fn` or any
  `runGatewayMigrationPreflight` body as part of this path. Detail:
  [docs/sync/gateway-identity-convergence.md](docs/sync/gateway-identity-convergence.md).
- **Chameleon calibration:** a global `chameleon_calibrations` table keyed by
  `array_id`, filled from the cloud by the sync worker. Power the reader from
  LSN50 `VDD`, never from switched 5 V without a bidirectional level shifter
  and power isolation. Before a release run
  `OSI_ADMIN_TOKEN=… node scripts/refresh-chameleon-calibrations.js`, then
  `node scripts/apply-chameleon-calibration-seed.js`. Detail:
  [docs/sync/chameleon-calibration.md](docs/sync/chameleon-calibration.md).

### Sync REST endpoints

The edge links via `POST /auth/local-sync` (token refresh hourly), uploads a
bootstrap snapshot every 6 h, and every 30 s delivers outbox events, history
batches and command ACKs and polls
`/api/v1/sync/gateways/{eui}/pending-commands`. It never calls the cloud
diagnostics `/status` and `/reconciliation`, nor the legacy
`/api/v1/devices/claim-bulk`. Endpoint table, command types, rename routes and
sync capabilities: [docs/api/sync-endpoints.md](docs/api/sync-endpoints.md).

### MQTT topics (edge → cloud only)

| Topic | Payload | Cadence |
|-------|---------|---------|
| `devices/{eui}/heartbeat` | Gateway status (CPU, memory, firmware) | 60 s |
| `devices/{eui}/telemetry` | Sensor readings | Real-time |
| `devices/{eui}/status` | Valve state | On change |
| `devices/{eui}/command_ack` | Command result | Per command |

Broker URL, heartbeat error counters, fan telemetry/control (`pwmfan` hwmon first; raw PWM writes fail with `EBUSY`) and gateway health persistence: [docs/api/sync-endpoints.md](docs/api/sync-endpoints.md).

---

## Security

- Local auth tokens: HMAC-signed JWT.
- Local passwords: bcrypt-hashed.
- `/download/database`: disabled (always refused).
- Linked login uses an offline verifier, **not** cloud password hash sync: v2 `bcrypt(password::installation_uuid)` for gateways reporting `installation_recovery_v1`, v1 `bcrypt(password::DEVICE_EUI)` otherwise.
- `osi-server.cloud.link_gateway_device_eui`, preset by an operator, bypasses the provisional-identity block on concentrator-less gateways during account-link. Test/demo path only; production uses a configured concentrator that resolves an authoritative EUI. The override risks stranding cloud data and breaking v1 offline login if the linked EUI later changes. Mechanism: `osi-config-and-flags`.
- **Node-RED editor/admin API is disabled by default.** `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` sets `httpAdminRoot: false`, which closes the editor and the `/flows`, `/settings` (Node-RED admin route, distinct from the product `/api/system/settings`), and `/nodes` admin routes on the shared `:1880` listener. `uiHost` stays unset: setting it would bind that whole listener to loopback and remove LAN access to `/gui` and `/api` for every farmer browser, not just the editor. Static guard: `node --test scripts/test-node-red-admin-root-off.js`.
  - Re-enabling the editor for field repair is a deliberate operator action on the gateway itself, closed again before leaving; there is no in-repo toggle. Procedure, the nginx 404, the smoke check and the planned per-device `adminAuth` fix: [docs/operations/node-red-editor-access.md](docs/operations/node-red-editor-access.md).

---

## Conventions

- Commit prefixes: `feat:` for new features, `fix:` for bug fixes, `chore:` / `docs:` / `release:` as appropriate.
- BusyBox case conversion: use `tr 'abcdef' 'ABCDEF'`; `tr '[:lower:]' '[:upper:]'` is unreliable on the Pi image.
- Treat `flows.json` as the main edge backend: most API and scheduler changes live there.
- Empty `catch` blocks in `flows.json`: `scripts/verify-no-new-silent-catch.js` ratchets the maintained-profile baseline. When touching any function node, convert empty `catch(_){}` / `catch(e){}` / `catch {}` blocks in that node to a visible warning such as `catch (e) { node.warn('<node/context>: ' + (e && e.message ? e.message : e)); }`; new function code must not swallow errors silently. Load in-repo helper modules via `osiLib.require('<name>')` with `{"var": "osiLib", "module": "osi-lib"}` declared in the node's `libs` (bare `require()` of a non-builtin fails CI via the ratchet in `scripts/verify-sync-flow.js`); beyond such declared helpers, keep function-node `libs` minimal.
- **MQTT IN topic rule:** all Node-RED MQTT IN nodes must subscribe to `application/+/device/+/event/up`. ChirpStack generates per-installation application UUIDs at bootstrap; hardcoded UUIDs break silently. Device-type discrimination is done downstream via `CHIRPSTACK_PROFILE_*` env vars and `deviceProfileName` fallback. Check with `scripts/check-mqtt-topics.sh` (manual; no CI workflow runs it).
- `MqttPublisherService` on the cloud is deprecated (kept for potential future use); all cloud→edge commands are REST.
- **No deployment identities in public text.** Documents, guidance files,
  skills, commit messages, issues and pull requests do not name customers,
  farms or individual gateways, and carry no real EUI or tailnet address.
  Write "the customer test gateway", "the demo gateway", "a customer
  gateway", "a customer cloud instance", "the partner institute". The
  production site in Uganda is named as such; that is allowed. Example
  values: gateway EUI `0016C001F1000001`, device EUI `A840410000000001`,
  address `100.x.y.z`. A 16-digit hex value that is not an identifier,
  such as a Node-RED node id, needs an entry in
  `scripts/verify-doc-hygiene-allowlist.json` with a reason.
  `node scripts/verify-doc-hygiene.js` enforces this in CI for files,
  pull-request text and commit messages; maintainers hold the name list.
  Maintainers install the matching pre-push guard once per clone and
  reinstall the copy when the script changes; the two install commands are in
  the header of `scripts/hooks/pre-push-doc-hygiene.sh`. It scans the pushed
  commits and their messages before anything reaches the public repository.

## TypeScript work in `web/react-gui`

Read the repo-owned `architect.yaml` and `RULES.yaml` overlays before edits. See [docs/agents/typescript-rule-overlays.md](docs/agents/typescript-rule-overlays.md) for the workflow.

---

## Agent skills

Field manuals for agents live in `.claude/skills/` (Agent Skills spec); `.agents/skills` is a committed symlink to it for Codex and other `.agents`-convention tools. Each skill's `description` says when to load it, and harnesses show those descriptions in every session, so this file does not repeat them. Load the owning skill before the change it covers: `osi-flows-json-editing` before any Node-RED flow change, `osi-schema-change-control` before any schema change, `osi-live-ops-runbook` before touching a real gateway, and `anti-slop-writing` before writing docs or PR text (mechanical check: `node .claude/skills/anti-slop-writing/slop-check.js <files>`).

### Cross-harness discovery and process parity

The 14 skills load in Claude Code (`.claude/skills/`), Codex (through the
`.agents/skills` symlink, which is load-bearing) and OpenCode (both roots; its
`duplicate skill name` warnings are cosmetic). Keep the single symlink; never
add a second real copy. Process: `docs/engineering-playbook.md` §2 (standard
and risk-class loops); harnesses without workflow skills apply it by hand. Read
[docs/agents/cross-harness-skills.md](docs/agents/cross-harness-skills.md)
before changing that layout.

## Session closeout

When the user says `finish the session`, load `osi-session-closeout` and follow it.

---

## Verification commands

```bash
node scripts/verify-sync-flow.js              # sync implementation
node scripts/verify-no-new-silent-catch.js    # empty catch ratchet
node scripts/verify-strega-gen1.js            # STREGA Gen1 decoder
node scripts/verify-lorain-codec.js           # Aqua-Scope LoRain decoder
node scripts/verify-tektelic-agriculture-codec.js # Tektelic KIWI/CLOVER decoder
node scripts/verify-communication-contract.js # contract preflight
scripts/check-mqtt-topics.sh                  # MQTT IN topic compliance
node --test scripts/test-gateway-health-persistence.js  # gateway health persistence guard
node scripts/verify-doc-hygiene.js            # no deployment identities in docs, guidance, skills
node scripts/verify-agents-size.js            # AGENTS.md size and required-heading offsets

cd web/react-gui && npm run test:unit         # frontend unit tests
cd web/react-gui && npm run build             # frontend build
```

**Base ref for a stacked branch:** the size-ratchet, stray-DDL, migration and
live-identity verifiers compare against `origin/main` by default. A stack that
sat unmerged through other merges pins all four
(`OSI_FLOWS_SIZE_BASE_REF`, `OSI_DDL_BASE_REF`, `OSI_MIGRATIONS_BASE_REF`,
`OSI_IDENTITY_BASE_REF`) to the commit it branched from until it is rebased.
Long form: `osi-verification-commands`, "Base ref for a stacked branch".

---

## Adding a new device type

There is no plugin registry (ADR [2026-05-28](docs/adr/2026-05-28-static-device-plugin-registry.md)); follow the manual checklist in [docs/architecture/adding-a-device-type.md](docs/architecture/adding-a-device-type.md). A new `devices.type_id` member is a `destructive` ordered migration that rebuilds `devices`, under the boot-node merge gate.

---

## Device catalog

Device types: `KIWI_SENSOR`, `TEKTELIC_CLOVER`, `DRAGINO_LSN50`, `DRAGINO_SDI12`, `SENSECAP_S2120`, `AQUASCOPE_LORAIN` (ChirpStack app `Sensors`); `STREGA_VALVE`, `MILESIGHT_UC512` (`Actuators`); `RAK10701_FIELD_TESTER` (`Field Tester`). Profiles, sensors, SWT canonicalization, unified SWT estimates, LoRain onboarding and interval-rain aggregation, STREGA timed irrigation and valve control (schedules pushed only on user change or explicit re-send, never on a timer): `osi-agronomy-sensors-reference`, "Device catalog (edge reference)". Rules that bind every change:

- `device_data.swt_1`, `swt_2`, `swt_3` are canonical positive kPa magnitudes; derive pF only for display or export through the shared conversion in [matric-potential/v1.md](docs/contracts/matric-potential/v1.md); aggregate kPa before deriving pF; preserve calculated doubles and round display strings only.
- STREGA user-facing opens are `OPEN_FOR_DURATION`; normal close is the valve's own timed close, not a bare `CLOSE` command. Operator cancellation uses `POST /api/v1/valves/:deveui/cancel`; a flushed open that may have been sent is answered `handed_off` and keeps the valve reserved. Conditional irrigation (`osi-irrigation-policy`): see the agronomy skill.
- The LoRain AppKey is retrieved from Aqua-Scope and must not be stored in this repo.

---

## File locations

### On the Pi

| What | Path |
|------|------|
| Node-RED flows | `/srv/node-red/flows.json` (symlink into `payloads/<stamp>/`; copy with `cp -L`) |
| SQLite database | `/data/db/farming.db` |
| React GUI | `/usr/lib/node-red/gui/` (symlink into `payloads/<stamp>/gui`) |
| Node-RED settings | `/srv/node-red/settings.js` |
| MQTT credentials | `/srv/node-red/flows_cred.json` |
| UCI identity | `osi-server.cloud.*` (`uci show osi-server`) |

### In the repo

Repo paths, the Pi image workflow, the Journal V2 media cache and the provider weather store: [docs/architecture/repo-file-locations.md](docs/architecture/repo-file-locations.md).
