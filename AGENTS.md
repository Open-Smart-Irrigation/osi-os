# AGENTS.md — OSI OS (Edge)

Operational source of truth for `osi-os`. The edge is canonical; `osi-server` mirrors edge-backed farms. Cloud-originated edits are pending until the edge applies them.

Sister repo: [`osi-server`](../osi-server/AGENTS.md).

> **How to work here:** [docs/engineering-playbook.md](docs/engineering-playbook.md) — the working loop (verify reality → written plan → adversarial review → exact execution → independent verification), the thinking tools, and the failure modes this repo has already paid for. Read it before your first non-trivial change; hold every PR to its §8 definition of done.

Binding rules come first in this file; reference detail lives in the docs and skills each section links. Some harnesses read only the first 32 KiB of this file, so move reference material out instead of letting the file grow.

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

Chameleon SWT analysis reads canonical kPa values from `device_data.swt_1`, `swt_2`, and `swt_3`. `chameleon_readings` is the raw/diagnostic mirror. If historical SWT values are repaired from `chameleon_readings` plus `chameleon_calibrations`, update `device_data` too. Historical repairs that UPDATE `device_data` rows are carried by the `trg_sync_device_data_dirty_au` trigger → `sync_history_dirty_keys` → history correction phase. Do not enqueue explicit `DEVICE_DATA_APPENDED` events for them: every such event has `sync_version` 0, and the cloud rejects a changed payload at an equal version as `equal_version_payload_conflict`. Update by row `id`: `device_data` has no UNIQUE(deveui, recorded_at).

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
  WATERMARK-related capabilities. Effect keys and base rules:
  [docs/sync/watermark-cloud-parity.md](docs/sync/watermark-cloud-parity.md).
- **WATERMARK scheduler interlock:** the scheduler still rejects every
  `device_data` row linked to `watermark_readings`, regardless of legacy device
  flags. Cloud parity and field qualification records do not lift it.
- **Zone `weather_source`:** the cloud puts `weatherSource` into zone commands
  only for a gateway that reported `zone_config_weather_source_v1` (and
  `stageStartedOn` only with `zone_config_stage_started_on_v1`); the edge sends
  `weather_source` only when the stored value is not `auto` or (update event
  only) changed in that update, never as an unconditional default.
- **Live gateway identity:** `osi-identityd` owns it after boot. During a live
  identity transition, link and sync builders read only the restart sentinel
  and fail closed. Do not route identity transitions through the GUI
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

Field manuals for agents live in `.claude/skills/` (Agent Skills spec: SKILL.md + `name`/`description` frontmatter); `.agents/skills` is a committed symlink to it for `.agents`-convention tools (Codex, Gemini CLI, …). Index:

- `osi-debugging-playbook` — symptom→triage table + verifier toolbox; load when investigating any edge failure or data gap.
- `osi-live-ops-runbook` — deploy/repair/post-check procedures for live Pis; load before touching a real gateway.
- `osi-flows-json-editing` — script-only flows.json editing rules; load before ANY Node-RED flow change.
- `osi-schema-change-control` — migrations, risk classes, frozen boot DDL, parity gates; load before ANY schema change.
- `osi-agronomy-sensors-reference` — domain pack (SWT/pF, Chameleon, dendrometry, rain, LoRaWAN as used here); load when touching sensor semantics or displays.
- `osi-config-and-flags` — UCI/env/flag catalog incl. DEVICE_EUI resolution; load when configuring or provisioning.
- `osi-common-pitfalls` — short cross-cutting hazard card (FK fences, silent catches, profile mirroring, missing-data rule, pipe-exit traps); load at the start of any edge change or review.
- `osi-verification-commands` — verifier catalog with pass signals and per-surface minimum evidence; load when selecting gates or writing execution reports.
- `osi-sync-contract-awareness` — sync contract invariants (edge-authoritative writes, outbox/inbox/cursor, canonicalization, cross-repo PR rule); load for any sync or paired edge/cloud change.
- `osi-react-gui-patterns` — GUI serving/routing/auth/i18n/missing-data patterns and test invocation; load for `web/react-gui` changes.
- `osi-server-backend-patterns` — paired-repo awareness for osi-server (Flyway discipline, Gradle builds, API bridge); load for cloud-side work initiated from this repo.
- `osi-forge-boundaries` — Stage 1 Forge worker/controller boundaries and stop-and-report rules; load for issue-to-PR automation tasks.
- `osi-hardest-problem-campaign` — deferred stub; do not author without maintainer input.
- `anti-slop-writing` — prose floor for ALL documentation and user-facing text; load before writing or editing any docs/README/ADR/runbook/PR prose. Mechanical check: `node .claude/skills/anti-slop-writing/slop-check.js <files>`.

### Cross-harness discovery and process parity

The 14 skills above load in Claude Code (`.claude/skills/`), Codex (through the
`.agents/skills` symlink, which is load-bearing) and OpenCode (both roots; its
`duplicate skill name` warnings are cosmetic). Keep the single symlink; never
add a second real copy. A harness without the superpowers skills applies the
same loop by hand from `docs/engineering-playbook.md`. Read
[docs/agents/cross-harness-skills.md](docs/agents/cross-harness-skills.md)
before changing that layout.

## Session closeout

When the user says `finish the session`:

1. Run `git status --short --branch` and report staged/unstaged/untracked.
2. Remove only clearly temporary files. List ambiguous files as cleanup candidates instead of deleting them.
3. Review and update this `AGENTS.md` for durable repo-level changes.
4. Record cross-session operational context in the memory store of the harness you are running in (Claude Code: its auto-memory for this repo). A harness without a memory store writes it to the run's `HANDOVER.md` under `.superpowers/sdd/<run>/` and says so in the closeout report. Never edit another harness's memory files. A rule every harness must follow goes into this file or a repo skill by PR, not into memory.
5. Run `scripts/session-closeout.sh` (`OSI_OS_MEMORY_FILE=<your memory index>` opts into a memory check) and report warnings.
6. If no context files needed changes, say so explicitly.
7. End with remaining risks, skipped verification, and the next recommended step.

Keep closeout updates factual. Never delete ambiguous files without asking.

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

> **Why this is still a manual checklist:** there is no plugin registry — see ADR [`docs/adr/2026-05-28-static-device-plugin-registry.md`](docs/adr/2026-05-28-static-device-plugin-registry.md) for the deferral rationale. Do not propose a plugin system without a concrete second-party candidate.

1. Add an ordered migration `database/migrations/ordered/NNNN__<slug>.sql` and the matching `seed-blank.sql` change (load `osi-schema-change-control`); step 6 regenerates the bundled `farming.db` copies. A new `devices.type_id` member is a `destructive` ordered migration that rebuilds `devices` (SQLite cannot alter `CHECK` in place; precedent `0060__add_rak10701_field_tester_type.sql`), plus `REQUIRED_TYPES` and `DEVICES_COLUMNS` in `sync-init-fn` under the boot-node merge gate. Never add a second rebuild path.
2. Add TypeScript types (`web/react-gui/src/types/farming.ts`).
3. Add Node-RED ingest flow in `flows.json` (use the `application/+/device/+/event/up` topic; guard the branch head with a `deviceProfileName` filter so other branches don't double-process the same message).
4. Add catalog / merge logic.
5. Add React card/component and render in dashboard.
6. Regenerate the bundled DB copies with `node scripts/build-seed-db.js` (it replays the ordered migrations into a fresh image, so the shipped ledger advances with the schema); verify with `scripts/verify-db-schema-consistency.js` and `scripts/verify-seed-db-ledger.js`.
7. Add the profile to `chirpstack-bootstrap.js` (all three copies: `scripts/` and both profiles) and map its ChirpStack application; if the flows filter on the profile ID, add its `CHIRPSTACK_PROFILE_*` key to `node-red.init`.
8. For Data-view support, update the finite source policy in both payload
   profiles and run the source matrix, manifest parity, and deploy-file coverage
   checks documented in [docs/channel-manifest.md](docs/channel-manifest.md).

---

## Device catalog

Device types: `KIWI_SENSOR`, `TEKTELIC_CLOVER`, `DRAGINO_LSN50`, `DRAGINO_SDI12`, `SENSECAP_S2120`, `AQUASCOPE_LORAIN` (ChirpStack app `Sensors`); `STREGA_VALVE`, `MILESIGHT_UC512` (`Actuators`); `RAK10701_FIELD_TESTER` (`Field Tester`). Profiles, sensors, SWT canonicalization, LoRain onboarding, STREGA timed irrigation and valve control: `osi-agronomy-sensors-reference`, "Device catalog (edge reference)". Rules that bind every change:

- `device_data.swt_1`, `swt_2`, `swt_3` are canonical positive kPa magnitudes; derive pF at display through the shared conversion in [matric-potential/v1.md](docs/contracts/matric-potential/v1.md), and aggregate kPa before deriving pF.
- STREGA user-facing opens are `OPEN_FOR_DURATION`; normal close is the valve's own timed close, not a bare `CLOSE` command. Operator cancellation uses `POST /api/v1/valves/:deveui/cancel`.
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

---

## Issues

Tracked at https://github.com/Open-Smart-Irrigation/osi-os/issues. Don't trust this
list or any issue body blindly — re-verify against current `main` before planning
(several issues have turned out already-fixed or mostly stale). Long-running open
areas as of 2026-07-05: i18n (#47), lossless edge→cloud backup (#56), rootfs
auto-grow (#50), Uganda live-ops (#55, #64, #87), dendro scheduling (#22), Mclimate
valve (#18), and the schema-hardening roadmap (#88–#90, gated — see its plan docs).
