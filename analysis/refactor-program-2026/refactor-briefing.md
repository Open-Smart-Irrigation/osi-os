# OSI System Refactor Program — Expert Briefing (2026-07-07)

You are consulted as a domain expert to help design a multi-month refactor program for a two-repo smart-irrigation system. Read this briefing fully; verify against the repos where needed (paths below), but prioritize reasoning over exploration.

## Mission

Propose design choices and a phased program to evolve the system toward **modularity, stability, performance, and flexibility** — specifically: integrating new sensor/actuator hardware must become cheap, safe, and testable; the system must stay farmer-operable offline; refactors must never endanger live farm data.

## System snapshot

**osi-os** (`/home/phil/Repos/osi-os`) — OpenWrt 24.10 firmware for Raspberry Pi 5 LoRaWAN gateways. Offline-first edge:
- Node-RED is the backend: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` — 525 nodes, 17 tabs, 227 function nodes holding ~1.0 MB of JavaScript embedded as JSON strings. Largest single nodes: History API Router (76 KB), Sync Init Schema + Triggers (72 KB, FROZEN), Get Zone Environment Summary (67 KB), Daily Dendrometer Analytics (57 KB), Run Force Sync (45 KB). REST API (~97 http-in endpoints), scheduler, sync orchestration all live here.
- SQLite `/data/db/farming.db` is canonical state; ~36 tables; farm history is irreplaceable (documented data-loss incident from an unfenced table rebuild).
- ChirpStack = LoRaWAN network server; payload codecs are per-device JS files (`node-red/codecs/*.js`, standard `decodeUplink` API) uploaded to ChirpStack device profiles — 4 of 6 device types extracted, KIWI/STREGA decode inline in flows.
- React dashboard (`web/react-gui/`), served by Node-RED.
- Device catalog: KIWI_SENSOR, TEKTELIC_CLOVER, DRAGINO_LSN50 (+Chameleon SWT reader), SENSECAP_S2120 weather, AQUASCOPE_LORAIN rain, STREGA_VALVE actuator. Next: MClimate T-Valve (issue #18).
- Adding a device type = manual 8-step checklist (AGENTS.md): DB schema, TS types, Node-RED ingest branch, catalog/merge logic, React card, bundled DB copies, ChirpStack profile + bootstrap. Per-device tab pattern: `mqtt in → Process Data (decode/normalize, ~5.7 KB fn) → Build SQL INSERT → sqlite`.
- Two image profiles (bcm2712 canonical, bcm2709 byte-mirror, CI-enforced parity). 7 bundled farming.db copies must stay schema-identical (CI-enforced).

**osi-server** (`/home/phil/Repos/osi-server`) — cloud mirror. Spring Boot monolith (Java 17 source/21 runtime, Lombok), React frontend embedded in the JAR, Python FastAPI prediction service (AquaCrop water balance) + optional FAO reference service, PostgreSQL 16 + Flyway, Mosquitto MQTT (TLS), Docker Compose behind Caddy. Terra Intelligence standalone frontend. Weather chain OpenAgri → AgroMonitoring → Open-Meteo. Key packages: `sync/` (inbox/outbox), `mqtt/` (telemetry routing), `analytics/`, `prediction/`, `chameleon/`, `soil/`. Tests are Mockito-mocked repositories — no test DB. Production VPS is small: 4 CPU / 4 GB RAM / 80 GB disk; on-host full Docker builds have made it unresponsive.

**Sync model**: edge writes canonical local state, emits to `sync_outbox`; cloud mirrors via REST (events every 30 s, bootstrap snapshot every 6 h); cloud→edge commands ONLY via REST polling of pending-commands (30 s); MQTT is edge→cloud telemetry/heartbeat/ACK only, edge is not subscribed to the broker. Contract package: `osi-os/docs/contracts/sync-schema/` JSON Schemas; Tranche A merged 2026-07-06 (op-enum parity CI gate cross-repo, `contract_version` stamped in payloads).

**Fleet reality**: 3 live gateways (2 demo, 1 production in Uganda that is months-stale on schema, issue #87). Fleet should be able to grow to ~100s of gateways without redesign. Solo maintainer working with AI agents; engineering playbook (`osi-os/docs/engineering-playbook.md`) mandates plan → adversarial review → exact execution → independent verification.

## Hard constraints (accepted ADRs — do not relitigate, but note flip conditions)

1. **ADR 2026-05-28 (plugin registry)**: any device "plugin" is a static, in-repo, PR-reviewed bundle shipped in the image. NO remote loading, NO npm-style registry, NO hot-reload. Registry data structure deferred until a real second-party candidate.
2. **ADR 2026-06-30 (schema & contract ownership)**: edge SQLite DDL owned by ordered migrations + ledger (`lib/osi-migrate`, CI-time only today); cloud Postgres owned by Flyway independently; cross-repo compatibility owned by versioned sync contracts. NO shared SQLite↔Postgres DDL codegen (a YAML-DSL design was formally rejected; flip conditions recorded). Kill-switch invariant: generated contract artifacts must be actually consumed or deleted.
3. **Boot-DDL freeze**: the Node-RED boot node performs inline DDL every boot (~93 ADD COLUMNs); it is frozen; new schema goes through ordered migrations. Option B (cut boot DDL over to the runner, deploy-time invocation) is issue #88 — its ADR promotion trigger is NOW satisfied: migration `0004` (a destructive table rebuild fixing farmer-facing bug #92) is merged and awaits delivery to live gateways. There is currently NO destructive-schema delivery path to live Pis.
4. Offline-first is non-negotiable: gateways may have no internet for weeks; farmer GUI must work locally.
5. Never reseed/overwrite a live `farming.db`. All refactors must be deployable to a fleet that is in a non-deterministic schema state until Option B Stage 0 canonicalizes it.

## Recently completed (don't re-propose)

Stabilization tranche merged 2026-07-06/07: fleet heartbeat with edge health + `schema_sig` (#100), codec golden-vector tests + CI (#106), unhandled-error counter + silent-catch ratchet (#102), sync contract parity gate + contract_version (#105), Option B near-term DDL guards (#101), gateway health persistence (#96), migration runner hardening (#83), boot-node fail-closed devices rebuild (#86). ~11 verifier scripts now run in 4 CI workflows.

## Known open pain points (verify numbers if you build on them)

- osi-os: #99 history-sync nodes use bare `require` outside the libs sandbox (brick risk); #107 heartbeat `schema_sig` blind to CHECK/FK drift; #87 Uganda schema catch-up; #56 lossless edge→cloud backup; #50 rootfs autogrow; #22 dendro scheduling; #18 MClimate valve; #47 i18n; #90 CSV export parity; #89 tranche-A residual (dead-letter unknown ops).
- osi-server: #19/#20/#23/#24 Terra work, #36 fabricated fallback values, #17 iOS wrapper, #1 i18n. No CI on osi-server yet (repeatedly flagged as P0-next by prior reviews).
- Merged flows changes (error counter, contract_version) are not yet deployed to any gateway.

## Proposals already on the table (critique freely)

- **Narrow-waist ingest**: per-device pure `normalize(decoded, meta) → {channels}` modules (like codecs), ONE generic channel-manifest-driven writer replacing per-device SQL builders, `verify-device-integration.js` turning the 8-step checklist into CI, per-gateway UCI feature flags, MClimate as pilot. Known risk: Node-RED `libs` module-load failure bricks a function node silently — loading strategy must be single-choke-point with quarantine.
- **Strangler extraction**: the 45–76 KB function nodes move to real tested modules (`node --test`), function nodes become thin adapters; convert-on-touch, never big-bang.
- **Option B staging**: Stage 0 canonicalize fleet schema (fold `ensure_*`/repair drift into seed+migrations, retire `writable_schema` surgery #93), Stage 1 deploy-time runner invocation (writers stopped), Stage 2 remove boot-node DDL.
- General: chaos/soak rig (power-loss, weeks-offline outbox replay, uplink storms, clock jumps), SD-card durability (integrity check + quarantine/restore, retention/pruning, disk-free in heartbeat), time integrity (RTC health, timestamp sanity, scheduler behavior on clock jumps), deploy atomicity + canary gate on heartbeat health, per-gateway feature flags.

## What we need from you

Deliver a markdown report (≤ ~300 lines) with:

1. **Design choices** in your domain — the 4–6 decisions that matter most, each with 2–3 realistic options, trade-offs, and ONE recommendation. Ground them in this system's actual constraints (solo maintainer, 3-gateway fleet growing to 100s, 4 GB VPS, offline-first, farm-data safety).
2. **Phasing proposal** — how you would order the work over ~4–6 months: numbered phases, each bundling 3–6 concrete items; per item one line: goal + dependency + rough size (S/M/L). Phases must each leave the system shippable and safer than before.
3. **Risks & failure modes** — what kills this program; which refactor steps are one-way doors; what to rehearse before touching production.
4. **Explicit YAGNI list** — tempting things NOT to build at this scale, with one-line reasons.
5. **Performance & scale notes** — where the current design actually breaks first at 10× and 100× gateways, and the cheapest fix that survives that growth.

Be opinionated. Disagree with the proposals on the table where warranted — a documented rejection is as valuable as an endorsement. Do NOT write code. Do NOT modify any repo files. Write your report to the output path given in your task prompt AND return it as your final message.
