# Independent architecture review: OSI edge and cloud

**Review date:** 2026-09-01

**Repository baselines:** `osi-os` `3c7b95bc83cec1a2758379ebf23b29919e3b0440`; `osi-server` `8cac33d3a8a210784fa5f9b73c8e4dfe796203f7`

**Evidence notation:** **Fact** is directly observed in code, history, or an official upstream source. **Inference** explains likely consequences. **Recommendation** is a proposed decision.

## Review limits

The four product-intent files named in the brief—`250123_Practice_Abstract_Open_Smart_Irrigation_heph.docx`, `OSI concept.docx`, `OSI_pitch.pdf`, and `OSIxAquaMind_executive_summary.docx`—were not present in either repository, the supplied attachment directory, or the accessible home and data directories. Their contents therefore could not be independently verified. This review treats the product requirements quoted in the brief as constraints: offline autonomy, accessibility, robustness, low infrastructure dependence, local data and scheduling, LoRaWAN, a simple farmer interface, and a controlled extension path for trained local users. This missing evidence lowers confidence from high to medium-high.

No live gateway or production server was accessed. Hardware, power-loss, performance, and recovery claims are gates to test, not assumed facts.

## 1. Executive recommendation

**Recommendation:** adopt **contained Node-RED (option B)** as the application architecture for the next production stages. Make flows protocol and timing adapters. Move authentication, validation, scheduling policy, command idempotency, persistence, and sync contract handling into tested OSI modules behind a small local interface. Do not create a second edge process yet. Preserve a designed exit to **hybrid (option C)** if measured failure, testability, or platform-support triggers fire.

Separately, make **64-bit Raspberry Pi OS Lite or Debian 13 the provisional target base for new Pi 4/5 gateways**, subject to a time-boxed appliance-parity spike. Maintain the current OpenWrt image only as a bounded bridge for the installed fleet. Do not commit the project to OpenWrt 25.12 until a reproducible spike proves OSI can sustainably package Node.js 22/24, npm, Node-RED 5, every native dependency, and upgrades. Official OpenWrt 25.12 packages Node.js as host-only/build-only, so this is not an ordinary package bump.

**Confidence: medium-high** for contained Node-RED; **medium** for the Debian/Raspberry Pi OS target pending hardware evidence.

The recommendation would change if:

1. A Pi 4/5 OpenWrt 25.12 spike produces a small, reproducible, security-updateable Node.js/Node-RED package set with acceptable build ownership.
2. A Debian appliance spike cannot reproduce concentrator, access-point onboarding, unattended boot, power-loss recovery, payload rollback, and field reflash behavior.
3. Production evidence shows that Node-RED restarts or event-loop stalls cause unacceptable loss of sensing, scheduled control, or command reconciliation despite module extraction. That would justify option C.

The immediate priority is not a runtime rewrite. It is to close the Node-RED editor/admin boundary, because the shipped settings leave it enabled without `adminAuth` on the default all-interface listener, while nginx directs `/apps/node-red` to port 1880. Node-RED states that its editor is unsecured by default and anyone who reaches it can deploy changes ([official security guide](https://nodered.org/docs/user-guide/runtime/securing-node-red)).

## 2. Verified current-state system map

### OSI OS

```text
LoRa devices
    │ radio
    ▼
concentratord ─► ChirpStack (SQLite) ─► local Mosquitto
                                           │ uplinks
                                           ▼
                                  Node-RED process :1880
                           ┌───────────────┼────────────────┐
                           │               │                │
                      HTTP API        schedulers       sync workers
                           │               │                │ REST/WSS
React GUI /gui ────────────┤               │                ├────► OSI Server
                           ▼               ▼                │
                    farming.db        LoRa downlinks        └────► cloud MQTT
                    canonical edge    duration-bounded
                    state + outbox     valve commands
```

**Facts.** The maintained `flows.json` contains 602 nodes on 19 tabs, including 240 function nodes, 118 HTTP inputs, 27 inject nodes, seven MQTT inputs, nine MQTT outputs, and about 1.07 million characters of embedded function JavaScript. The technical system map's 579/18/238/101 counts are stale. The largest functions include sync initialization, history routing, forced sync, dendrometer analysis, zone-environment aggregation, and bootstrap. Node-RED therefore remains the REST backend, static GUI host, scheduler, sensor ingest, actuator dispatcher, and sync orchestrator ([flows.json](../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json)).

The edge database at `/data/db/farming.db` is canonical for gateway-backed farms. Writes generate an outbox; the server mirrors them over REST. Cloud commands are leased and pulled over REST. MQTT carries uplink telemetry, gateway status, and acknowledgements from edge to cloud. The gateway does not subscribe to the cloud broker. ChirpStack and Node-RED are separate processes; ChirpStack uses its own SQLite database and local MQTT. The React farmer UI is a separate application artifact but is served by Node-RED.

The refactor program has delivered real seams: `osi-db-helper`, `osi-cloud-http`, normalizers, analytics, history, zone-environment, command-ledger, and device-writer packages; ordered/checksummed `osi-migrate`; schema and profile parity checks; deploy preflight, backup, atomic payload swap, canary, rollback; and chaos/soak tests. This is substantive, not cosmetic. It has not made flows thin: domain policy and raw SQL remain distributed through a large runtime artifact. Sixty function nodes contain a copy of `getAuthSecret`, demonstrating the cost of flow-local cross-cutting policy.

**Failure domains.** A Node-RED process failure removes the farmer API, GUI hosting, scheduling, sync, sensor processing, and actuator dispatch together. ChirpStack and Mosquitto can continue, but that does not prove QoS, queue capacity, or recovery will preserve every uplink. A ChirpStack failure removes LoRaWAN ingest/downlink but need not corrupt farm state. A `farming.db` failure affects all local OSI state; WAL, integrity checks, quarantine/restore, backups, and migration fences reduce but do not eliminate this risk. Internet or server failure does not stop local state, schedules, or direct control. Clock error affects scheduling and timestamp acceptance; code now clamps implausible device timestamps, but wall-clock jumps remain a system test case.

**Security boundaries.** Farmer API routes use custom HMAC-signed local tokens, but authorization is implemented repeatedly in flows and coverage is uneven enough to require an endpoint inventory test. The token format uses millisecond `iat`/`exp` values consistently in the inspected issuer and common validators; it is JWT-like but not a standard three-part JWT. The Node-RED editor/admin API is a separate and currently under-protected boundary: [settings.js](../../feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js) sets neither `adminAuth` nor `httpAdminRoot: false`, and [node-red.nginx](../../feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.nginx) redirects to `http://$host:1880`. OpenWrt firewall placement may reduce WAN reachability, but it does not make a LAN/AP programming surface an acceptable farmer surface.

### OSI Server

```text
edge REST bootstrap/events ─┐
edge MQTT telemetry ────────┼──► Spring Boot monolith ───► PostgreSQL/Flyway
farmer/admin browser ───────┤          │   │
                            │          │   └──► pending-command leases
                            │          └──────► WebSocket / embedded React UI
                            └──► dead-letter + watermarks + sync cursor

Spring Boot ──HTTP──► Python prediction service
auxiliary compose services: Mosquitto, OpenAgri/Mongo, FAO reference service
```

**Facts.** The cloud is a Java 17/Spring Boot 3.4.3 monolith deployed on a Java 21 runtime, with PostgreSQL 16/Flyway, an embedded React build, MQTT intake, and a separate Python prediction service. CI runs backend and prediction tests; GHCR publishing and pull-only deployment already exist. The July baseline claim that these were absent is stale.

`EdgeSyncService.java` is still about 1,800 lines. `SyncEventTxExecutor` now applies individual events in `REQUIRES_NEW` transactions, records terminal failures, preserves retryable parent misses, and finalizes the cursor separately. Tests exercise poison batches, backlog draining, dead letters, dispatch, and PostgreSQL 16 through Testcontainers. Only `GATEWAY_LOCATION_UPSERTED` has a dedicated `SyncEventApplier`; most resource operations remain private branches inside `EdgeSyncService`. Dead letters are list-only; the controller explicitly says there is no replay pipeline. `FlywayMigrationIT` migrates an empty PostgreSQL container, not a sanitized production-shape snapshot.

The server reads `contract_version`, but an unexpected version logs a warning and is applied with the current handler. That is unsafe for an uneven fleet: a syntactically similar future event can be misinterpreted rather than rejected or negotiated. Unknown operations are correctly rejected.

### Ownership and command rules

| Concern                        | Authority                              | Transport and invariant                                                                                                 |
| ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Farm state on a linked gateway | Edge SQLite                            | Local commit precedes outbox delivery. Cloud is a mirror.                                                               |
| Cloud-originated edit          | Edge after application                 | Server creates a leased pending command; edge pulls, deduplicates, applies locally, and acknowledges.                   |
| Telemetry/status               | Edge source                            | Local MQTT/processing, then WSS MQTT to cloud; internet loss must not block local storage.                              |
| Schema                         | `osi-migrate` at edge; Flyway in cloud | Never replace a provisioned DB. Destructive edge changes require stopped writers, backup, FK fence, and recovery proof. |
| Irrigation safety              | Device plus edge policy                | User opens are duration-bounded at the valve/firmware. Gateway cancellation and reconciliation are secondary defenses.  |
| Prediction                     | Cloud advisory                         | Must never gate local sensing, scheduling, or safe close behavior.                                                      |

### Stale, contradicted, or unverified statements

| Statement                                                  | Finding                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openwrt/` and the feed are git submodules                 | **Contradicted.** `main` stores ordinary trees, while README, `.gitmodules`, and the technical map still call them submodules.                                                                                                                                           |
| Technical map flow counts are 579/18/238/101               | **Stale.** The reviewed `main` is 602/19/240/118.                                                                                                                                                                                                                        |
| Server tests have “No test DB”                             | **Contradicted.** PostgreSQL 16 Testcontainers integration tests exist; the server `AGENTS.md` guidance is stale.                                                                                                                                                        |
| Server lacks CI/GHCR delivery                              | **Contradicted.** Workflows and prebuilt-image compose deployment exist since commits `970dfc3e` and `84a85016`.                                                                                                                                                         |
| Per-resource sync appliers substantially decomposed ingest | **Overstated.** One operation is extracted; the service remains about 1,800 lines.                                                                                                                                                                                       |
| Node-RED 3 remains supported                               | **Contradicted upstream.** 3.x reached EOL on 2025-06-30; 4.x reaches EOL on 2026-12-31 ([release plan](https://nodered.org/about/releases/)).                                                                                                                           |
| ChirpStack Gateway OS full images still include Node-RED   | **Contradicted by current config.** The v4.12 Pi 5 full-image config disables it ([official config](https://github.com/chirpstack/chirpstack-gateway-os/blob/v4.12.0/conf/full_raspberrypi_bcm27xx_bcm2712/.config)); the official guide saying it is included is stale. |
| ChirpStack removed Node-RED “after runtime problems”       | **Unverified reason.** Omission is verified; no primary source found for that causal claim.                                                                                                                                                                              |
| Product-document contents were reviewed                    | **Unavailable.** Only the requirements quoted in the brief could be used.                                                                                                                                                                                                |

## 3. Node-RED and base-OS decision analysis

### Application alternatives

| Option                        | Product and field fit                                                                                                       | Engineering and operations                                                                                                                                                                                             | Decision                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **A. Broad Node-RED backend** | Preserves proven behavior and visual accessibility. One process keeps deployment simple.                                    | Cross-cutting auth, SQL, scheduling, and sync remain hard to test and review. Editor compromise can alter the whole appliance. Node-RED/Node EOL is already a release blocker.                                         | **Reject as target.** Maintain only while extracting. |
| **B. Contained Node-RED**     | Keeps offline behavior and current field semantics. Visual orchestration remains accessible.                                | Lowest-risk strangler. Tested modules improve review, reuse, and eventual portability without another process, IPC, database owner, health check, or upgrade unit. It does not isolate process crashes.                | **Adopt now.**                                        |
| **C. Hybrid edge core**       | Can isolate durable scheduling, persistence, sync, and API from integrations and an optional editor.                        | Adds an operationally meaningful failure boundary only if the core survives Node-RED failure. Requires IPC semantics, supervision, upgrade ordering, resource budgets, and data ownership. Shadow parity is mandatory. | **Keep as evidence-triggered successor.**             |
| **D. Full replacement**       | Removes editor/runtime and Node.js packaging concerns. Risks losing field-proven integrations and super-user accessibility. | Highest regression and staffing cost; a rewrite reproduces years of edge cases. No current measurement justifies it.                                                                                                   | **Reject.**                                           |

Legitimate Node-RED work is protocol wiring, MQTT subscription and publication, HTTP adaptation, timers that invoke a durable scheduler, diagnostics composition, and optional local integration. Domain work to extract includes normalized reading semantics, authorization, resource ownership, schedule evaluation and recovery, valve command validation/idempotency, database transactions, outbox/inbox behavior, contract validation, and reconciliation state machines.

The tested-helper strategy is enough **if it has an enforceable destination**: no new raw SQL or auth copies in functions; module APIs receive explicit clocks and stores; flow-size and duplicate-policy ratchets only decrease; and failure tests call the same modules used in production. A separate process is justified only when isolation buys observed availability or when the supported platform cannot host Node-RED sustainably.

### Base operating system

**Facts.** The vendored source identifies OpenWrt 24.10.1; upstream's current 24.10 service release is 24.10.8, and the entire 24.10 line stops receiving security updates after September 2026 ([official announcement](https://lists.openwrt.org/pipermail/openwrt-announce/2026-July/000089.html)). OpenWrt 25.12 is the current stable line ([official release page](https://openwrt.org/releases/25.12/start)). The image pins Node-RED 3.1.15 and a Node 20-era package. Node-RED 5 requires Node.js 22.9 or newer and recommends Node 24 ([Node-RED 5 announcement](https://nodered.org/blog/2026/06/09/version-5-0-released)); Node 20 reached EOL in March 2026 ([Node.js release schedule](https://nodejs.org/en/about/previous-releases)). OpenWrt 25.12's official Node package is Node 22.23.2 but declares `PKG_HOST_ONLY:=1` and the target package `BUILDONLY:=1`, with no target npm package ([official package Makefile](https://github.com/openwrt/packages/blob/openwrt-25.12/lang/node/Makefile)). A native Node-RED 5 image would therefore make OSI responsible for the target Node/npm package, ABI rebuilds, CVE cadence, and native module compatibility.

Current ChirpStack Gateway OS v4.12 omits Node-RED from its Pi 5 full configuration, although the feed still contains a Node-RED 4.0.9 recipe. This proves upstream image divergence, not that Node-RED cannot run. ChirpStack provides an official Debian/Ubuntu repository, but its documented installation uses PostgreSQL plus MQTT and Redis/Valkey ([official installation guide](https://www.chirpstack.io/docs/getting-started/debian-ubuntu.html)). OSI must either accept and operate local PostgreSQL or maintain a Debian ChirpStack SQLite build. That trade-off must be measured for memory, writes, backup, and recovery.

Raspberry Pi OS/Debian does not itself solve Node-RED 5: Debian 13 ships Node 20.19.2 ([Debian package](https://packages.debian.org/trixie/nodejs)), so OSI still needs a maintained Node 22/24 source. It does remove the OpenWrt cross-target packaging problem and gives contributors a conventional apt/systemd/glibc environment. Debian 13 has full support to 2028 and LTS to 2030 ([Debian release information](https://www.debian.org/releases/trixie/)).

### Support and ownership matrix

| Fleet                 | CPU/base                                      | Node/Node-RED path                                                                | ChirpStack/native path                                          | OSI ownership and stance                                                               |
| --------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Pi 5                  | arm64, current custom OpenWrt 24.10           | Node 20 + NR 3.1.15; both EOL                                                     | Proven OSI SQLite build and concentratord                       | Bridge only; security backports and full image owned by OSI.                           |
| Pi 4                  | arm64 preferred                               | Same bridge; candidate Debian appliance                                           | Must prove HAT/concentratord and local NS                       | **Production baseline.** Target arm64 Debian/RPi OS after spike.                       |
| Pi 5                  | arm64 Debian 13/RPi OS Lite                   | OSI-managed Node 24 + NR 5                                                        | Official repo implies PostgreSQL; SQLite build is an OSI choice | **Provisional target.** OS packages upstream; appliance integration remains OSI-owned. |
| Pi 3                  | arm64-capable hardware, constrained resources | Node-RED 5 upstream support warning for older Pi generations; measure             | Hardware/HAT dependent                                          | Legacy/canary only; no architecture should be constrained by it.                       |
| Pi 2 and other 32-bit | armv7/armhf                                   | Node-RED 5 no longer supports older 32-bit Raspberry Pi use in its supported path | Existing image only                                             | Freeze as legacy with explicit end-of-support; security-only fixes where feasible.     |
| Pi 4/5 OpenWrt 25.12  | arm64                                         | OSI must restore target Node/npm and package NR5                                  | Current CGOS lineage is closest to proven radio appliance       | Spike only unless maintenance budget and reproducible upgrades are accepted.           |

### Operational comparison

| Concern             | Custom OpenWrt                                                                        | Debian/Raspberry Pi OS appliance                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build/security      | Small immutable image, but OSI owns a large vendored build and would own target Node. | Larger upstream ecosystem and familiar tooling; OSI must pin repositories and build immutable images.                                                         |
| SD wear             | Read-mostly appliance can be tuned tightly.                                           | More background services/logging by default; must disable, cap journald, use tmpfs, and test write amplification. Local PostgreSQL would increase complexity. |
| Memory/boot         | Lean and currently field-proven.                                                      | Higher baseline; acceptable only after Pi 4/5 measurements and service pruning.                                                                               |
| AP onboarding/radio | Existing scripts and packages are assets.                                             | Must reproduce hostapd/dnsmasq/nftables, regulatory settings, concentratord, and HAT reset paths.                                                             |
| Backup/recovery     | Existing payload/database backup, canary, and reflash process.                        | Easier conventional debugging, but image, data partition, atomic payload activation, and offline recovery must be built and rehearsed.                        |
| Contributors        | Specialized OpenWrt cross-build and vendored trees.                                   | Wider Linux/Node/Java skill pool and simpler native debugging.                                                                                                |
| Updates             | Payload deploy is proven; full firmware carries custom-image risk.                    | Apt must not become uncontrolled in-field mutation; signed, staged OSI releases still required.                                                               |

## 4. Target architecture

```text
protected appliance
┌──────────────────────────────────────────────────────────────────┐
│ radio adapter ─► ChirpStack/MQTT ─► thin Node-RED adapters       │
│                                      │                           │
│                              stable in-process API               │
│                                      ▼                           │
│  auth/ownership | device adapters | scheduler | command ledger   │
│  persistence + migrations | outbox/inbox | sync contracts        │
│                                      │                           │
│                            canonical farming.db                  │
│                                                                  │
│ farmer GUI ─► versioned local HTTP API                           │
└──────────────────────────────────────────────────────────────────┘
          ▲ optional, isolated integration runtime
          └── allowlisted API/topics; no DB, editor, or raw valve access
```

The first target is a modular monolith inside Node-RED, not microservices. Module boundaries must be portable CommonJS/JavaScript packages now and may later move unchanged behind a conventional service. Use explicit interfaces:

- `ReadingEnvelope -> DeviceWriterResult`: normalized channel values, quality, source timestamp, device identity, and dedupe key. A static adapter registry is sufficient; add a plugin system only when a real second-party adapter requires independent release.
- `ScheduleEvaluation(clock, state) -> bounded intent`: no direct downlink. The command layer validates duration, ownership, supported model, idempotency/effect key, and records expectation before dispatch.
- `FarmStore`: the only application route to SQLite transactions. `osi-migrate` remains the sole DDL owner; retire boot-time DDL after production-copy rehearsal.
- Versioned event, command, bootstrap, and history schemas with golden fixtures in both repositories. Support declared N/N-1 versions, reject unknown future versions, and publish gateway capabilities.
- A local API whose resource and error shapes are independent of Node-RED nodes. The farmer GUI depends on this API, never on the editor.

Production settings should disable the editor/admin API (`httpAdminRoot: false`) and bind Node-RED to loopback, with nginx exposing only farmer routes. An explicit maintenance mode may temporarily expose an authenticated editor on a management-only interface. It must log enable/disable, time out, require a unique credential, and never share farmer authentication.

Super-users should get a separate optional integration runtime or signed extension bundle with allowlisted telemetry and high-level commands. It must have no direct SQLite write access, no flow-deploy access to the protected runtime, and no raw indefinite-open command. A stable localhost API or namespaced local MQTT topics provide the extension seam.

Updates remain signed/versioned artifacts with an inactive payload slot, schema preflight, DB backup where required, canary, automatic rollback before irreversible migration, and a full-image recovery card. Downgrade policy is explicit per release: application payloads may roll back only while schema compatibility is retained; destructive migrations require forward repair or backup restore, never blind binary downgrade.

Health must distinguish radio, ChirpStack, broker, Node-RED event loop, database integrity/WAL size, scheduler lag, last sensor ingest, outbox age/depth, command lease age, clock confidence, disk wear/free space, and last successful backup. Valve safety remains non-negotiable: device/firmware duration bound, durable idempotency key, expectation before dispatch, queue cancellation, observed-state reconciliation, and no cloud/prediction dependency.

## 5. Phased roadmap for OSI OS and OSI Server

Phases are dependency ordered. “Parallel” means independent teams or branches may proceed; fleet promotion remains gated.

### Phase 0 — contain the exposed administration surface (S; `osi-os`)

- **Goal:** prevent LAN/AP users from deploying production flows.
- **Prerequisites:** none.
- **Deliverables:** production `httpAdminRoot: false`; loopback binding; nginx removal of the port-1880 redirect; authenticated, time-limited maintenance-mode design; static verifier and Pi smoke test.
- **Acceptance:** `/flows`, `/settings`, and editor assets are unreachable from farmer LAN; `/gui`, required `/auth` and `/api` routes work; MQTT ingest, schedules, reboot/fan authorization, and restart survive; rollback restores the prior payload without DB changes.
- **Rollback:** settings/nginx payload rollback; no migration.

### Phase 1 — establish supported-platform evidence (M; `osi-os`, build/field operations)

- **Goal:** make the base-OS decision with measurements before changing production.
- **Prerequisites:** Phase 0 security default.
- **Deliverables:** two reproducible Pi 4/5 arm64 prototypes: OpenWrt 25.12 + maintained target Node 24/NR5, and Debian/RPi OS Lite + Node 24/NR5 + local ChirpStack/concentratord; dependency SBOM; cold-boot, memory, write-rate, image-size, and build-time results.
- **Acceptance:** 72-hour offline radio/irrigation soak; 100 abrupt-power cycles without unrecoverable DB damage; AP onboarding; HAT reset and packet flow; clock loss/jump; one-week backlog drain; signed payload upgrade/rollback; recovery by a documented non-developer procedure. Record local PostgreSQL versus maintained SQLite evidence.
- **Rollback:** prototypes only; no fleet deployment.
- **Parallelism:** both prototypes can run in parallel. The platform ADR waits for both.

### Phase 2 — finish the modular-monolith boundary (L; `osi-os`, contracts)

- **Goal:** make flows thin enough that staying or leaving Node-RED is reversible.
- **Prerequisites:** Phase 0; no dependency on the Phase 1 winner.
- **Deliverables:** one auth/ownership module and endpoint manifest; schedule evaluator with injected clock; command validation/ledger interface; FarmStore repositories; per-device normalized adapters through the writer; JSON-schema validation and shared golden fixtures; removal ratchets for auth copies/raw SQL/embedded JS.
- **Acceptance:** power loss, duplicate command, delayed command, clock jump, missing parent, DB busy, corrupt payload, and long-offline tests call production modules; profile parity passes; no new flow-local auth or direct domain SQL; production-copy database rehearsal passes.
- **Rollback:** adapters can route back to old functions per bounded capability flag; schema changes remain backward compatible.
- **Stop/revise:** finish current helper extraction and migration work. Stop adding large all-in-one function nodes. Do not build a generic plugin marketplace.

### Phase 3 — harden mixed-fleet cloud sync (M; `osi-server`, `osi-os`, contracts)

- **Goal:** upgrade gateways slowly without silent semantic mismatch.
- **Prerequisites:** a version/capability envelope agreed before new event shapes.
- **Deliverables:** capability report in bootstrap/health; per-operation schema registry; fail-closed future-version handling; N/N-1 compatibility tests; minimum-edge-version command gating; audited dead-letter resolution/replay; extract the next high-volume/high-risk resource appliers.
- **Acceptance:** old, current, malformed, future, duplicate, reordered, and week-long backlog fixtures pass on PostgreSQL 16; future versions are never handled as current; replay is idempotent and audited; unsupported commands are withheld, not leased.
- **Rollback:** retain old handlers for N-1; feature-gate new command/event versions.
- **Parallelism:** applier extraction and replay UI/API can proceed in parallel after schema rules settle.

### Phase 4 — production platform migration (L; `osi-os`, server fleet view, field operations)

- **Goal:** move Pi 4/5 cohorts to the Phase 1 winner without data loss.
- **Prerequisites:** Phases 0–3; signed image; recovery kit; field acceptance.
- **Deliverables:** immutable image pipeline, device-specific backup/export, reflash/import, identity preservation, cohort selector, health dashboard, rollback image, and operator runbook.
- **Acceptance:** demo, lab, and field canaries meet telemetry thresholds in section 6; local schedules/control work with cloud blocked; imported DB/outbox converges without duplicate effects; a non-developer performs recovery from a corrupt card.
- **Rollback:** reflash prior image and restore verified backup; server continues N/N-1 behavior.

### Phase 5 — decide whether a separate edge core is earned (M spike, then L if adopted; `osi-os`)

- **Goal:** decide B versus C from operational data.
- **Prerequisites:** Phase 2 metrics and at least one field release.
- **Deliverables:** decision report against the triggers in section 9. If triggered, shadow a core that owns scheduler, persistence, sync, and stable API while Node-RED remains the live path.
- **Acceptance for C:** identical decisions on recorded traffic and fault cases; core continues safe scheduling/storage while Node-RED is killed; bounded CPU/RAM/write cost; independent rollback. Otherwise record B as the long-term choice and continue dependency upgrades.
- **Rollback:** remove the shadow process and capability flag; the live Node-RED path and database schema remain unchanged until a later cutover package is approved.

## 6. Migration and fleet strategy

Use four cohorts: developer bench, automated hardware-in-loop, one recoverable demonstration farm, then a small geographically supportable field canary. Expand only after a full irrigation cycle and at least one offline/backlog episode; do not promote merely because a gateway stayed online.

For any new scheduler/core path, run shadow evaluation against recorded inputs. Compare intended command, duration, due time, skip reason, and dedupe key. Shadow code must not publish downlinks. Promote one device class at a time behind a durable capability flag.

Schema compatibility rules:

- Additive migrations precede code that requires them and remain readable by the previous payload.
- Data migrations are idempotent and operate on pre-migration shapes with verified backup.
- Destructive migrations wait until rollback no longer depends on the old schema. They require stopped writers, FK fencing, integrity check, backup restore rehearsal, and explicit “no binary downgrade” metadata.
- Reflash never overwrites the only copy of a provisioned database. Export identity, database plus WAL-consistent backup, secrets, radio configuration, payload version, and checksums first.

The server must support N/N-1 contracts and a broader range of firmware capability sets. A gateway advertises firmware, schema head, contract versions, command capabilities, platform, architecture, and last successful backup. The server withholds commands the gateway cannot apply. Edge events remain queued for weeks; server limits must drain by cursor in bounded batches without treating backlog age as corruption.

Promotion telemetry includes: DB integrity, disk/free space and write rate, process restart count, boot time, event-loop/scheduler lag, last uplink, radio packet counts, outbox depth/oldest age, backlog drain rate, duplicate/rejected/dead-letter rates, command lease/ACK latency, valve reconciliation anomalies, clock confidence, memory/load/temperature, and recovery/rollback result. Thresholds should come from current-fleet baselines plus explicit safety limits, not arbitrary percentages.

## 7. Server roadmap

Complete the strangler already started in `EdgeSyncService`; do not split the Spring monolith into network services.

1. Define `SyncEventApplier` by resource/operation with canonical validation, ownership key, parent dependency, and transactional effect. Move one related slice at a time, starting with valve/device configuration or the highest dead-letter volume. Keep dispatch and per-event `REQUIRES_NEW` orchestration small.
2. Retain per-event transactions. Decompose bootstrap's large transaction into dependency-ordered, idempotent slices with a durable checkpoint only after tests prove retry semantics. Do not expose partially authoritative snapshots as complete.
3. Add dead-letter states (`OPEN`, `RESOLVED_WITH_CODE`, `REPLAYED`, `DISMISSED`), immutable original payload, resolution note/operator, and replay through the same dispatcher. Replay must acquire ownership/version checks and create an audit record; never edit a dead-letter payload in place.
4. Replace “warn and apply” for future `contract_version` with negotiation and fail-closed rejection. Validate schemas before ownership or persistence. Publish server-supported versions and gate pending commands by reported capability.
5. Keep PostgreSQL 16 Testcontainers tests and add a sanitized, representative schema/data snapshot migration test, including large tables, old nullable forms, constraints, and rollback/repair instructions. Empty-database Flyway success is necessary but insufficient.
6. Keep GHCR immutable images and pull-only production deployment. Pin image digests for a release, retain the prior digest, run migration compatibility before switch, and fail fast on placeholder secrets in production profiles.
7. Build fleet health around actionable states: offline versus backlog, unsupported contract, dead-letter reason, stale command lease, last successful bootstrap, schema/firmware distribution, and recovery-needed. Avoid a single green/red gateway status.
8. Keep prediction advisory and cloud-only. It may create a recommendation; only the edge scheduler and bounded command path may cause irrigation. If unavailable or stale, local schedules continue and the UI labels the recommendation unavailable.

## 8. Architecture decision records to adopt

| ADR title                                                     | Proposed decision statement                                                                                                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contain Node-RED behind tested domain modules**             | Node-RED remains the production edge process while flows become adapters; domain policy and persistence live behind tested interfaces. A separate core requires documented triggers.         |
| **Production editor and admin isolation**                     | The farmer network never exposes the protected runtime editor/admin API. Maintenance access is authenticated, management-only, time-bounded, and audited.                                    |
| **Pi 4/5 arm64 production baseline and 32-bit legacy policy** | New production releases target Pi 4/5 arm64. Pi 3 is measured legacy; Pi 2/32-bit receives a declared sunset and cannot constrain runtime choices.                                           |
| **Gateway base OS after appliance-parity spike**              | Choose OpenWrt 25.12 or Debian/RPi OS only from reproducible radio, recovery, security-update, and ownership evidence; record the losing option and revisit triggers.                        |
| **Edge application narrow waist**                             | Reading, schedule-intent, command, store, and sync interfaces are stable and independent of Node-RED nodes or cloud availability.                                                            |
| **Mixed-fleet contract compatibility**                        | Server and edge negotiate capabilities, support N/N-1 schemas, reject unknown future versions, and withhold unsupported commands.                                                            |
| **Database downgrade and reflash policy**                     | Migrations declare rollback compatibility; provisioned databases are backed up and imported, never reseeded; destructive changes require rehearsed recovery.                                 |
| **Controlled local extensions**                               | Super-user extensions run outside the protected runtime and use allowlisted APIs/topics without direct DB or raw actuator access.                                                            |
| **ChirpStack storage on Debian**                              | After measurement, select official PostgreSQL deployment or an OSI-maintained SQLite build and document resource, backup, and update ownership.                                              |
| **Revise static device registry ADR**                         | Retain the static registry until a concrete independently released second-party adapter proves a plugin lifecycle is needed. Define adapter interface now without inventing dynamic loading. |

## 9. Risk register and decision triggers

| Risk                                   | Leading indicator                                                     | Mitigation                                           | Explicit trigger                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Unsecured editor/admin surface         | Port 1880/admin API reachable from AP/LAN                             | Phase 0 default-off, loopback, verifier              | Any reachable production editor blocks release.                                                                                     |
| EOL Node/Node-RED/OpenWrt              | CVEs without supported upstream patches; build no longer reproducible | Platform spikes, SBOM, bounded bridge                | No supported runtime image before bridge expiry forces platform migration.                                                          |
| OSI becomes Node-on-OpenWrt maintainer | Repeated ABI/native build fixes or delayed CVEs                       | Prefer Debian target unless spike proves low burden  | More than one release requires bespoke runtime patching, or security update misses policy, rejects OpenWrt target.                  |
| Debian weakens appliance behavior      | Radio/AP/power/recovery failures                                      | Hardware-in-loop and field rehearsal                 | Any unresolved concentrator or non-developer recovery failure rejects Debian promotion.                                             |
| Node-RED common failure domain         | restarts, scheduler lag, lost/unreconciled uplinks or commands        | metrics, watchdog, extraction, durable ledger        | Two releases show safety/data SLO breaches attributable to Node-RED, or kill tests cannot preserve required duties: start option C. |
| Extraction stalls                      | embedded JS/auth copies/raw SQL do not decline                        | ratchets and phase gates                             | Two release cycles with no measurable reduction: staff Phase 2 before features or evaluate C.                                       |
| Mixed-version semantic corruption      | future contract applied as current; dead-letter growth                | fail-closed schemas, capability gates, replay        | Any version-related wrong state is a release stop.                                                                                  |
| SD wear/corruption                     | rising writes, WAL, read-only filesystems, restore failures           | write budgets, capped logs, integrity/backup         | Candidate exceeds current write baseline materially or fails power-cycle gate.                                                      |
| Valve unsafe effect                    | missing duration, duplicate open, stale command executes              | device duration, effect keys, expiry, reconciliation | Any indefinite or duplicate actuation blocks release and requires incident review.                                                  |
| Small-team overload                    | platform and application migrations overlap; security patches lag     | serialize fleet changes, keep modular monolith       | If two critical stacks need project-owned upstream maintenance, choose the base with less ownership; do not add a core process.     |
| Product intent drift                   | super-user or offline workflow cannot be demonstrated                 | retrieve source documents, field acceptance          | Material conflict in the missing product documents reopens target ADRs.                                                             |

**Stay with option B long term** if a supported runtime can be patched within policy, hardware fault tests pass, Node-RED restart/loss metrics meet the safety and data objectives, and flow-local domain code keeps declining. **Move to option C** if isolation is needed to keep scheduling/storage/sync alive during Node-RED failure, or if extracted modules are stable but Node-RED remains the platform/security bottleneck. Option D requires evidence that even optional Node-RED creates unacceptable risk; none exists today.

## 10. First implementation package

### Production Node-RED admin-boundary containment

This is a reviewable safety improvement that commits to neither Debian nor a separate edge core.

**Likely files and modules**

- `feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.nginx`
- `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`
- both maintained profile payload copies if any of these are mirrored under `conf/.../files/`
- a new `scripts/verify-node-red-production-security.js`, chained from the relevant existing verification entry point
- deployment canary checks and an operator note for explicitly enabling maintenance access

**Behavior**

- Bind the protected Node-RED runtime to `127.0.0.1`.
- Set `httpAdminRoot: false` by default, leaving HTTP-node APIs and `/gui` available through nginx.
- Remove `/apps/node-red -> :1880` from production nginx.
- If maintenance mode is included, require an explicit UCI flag, `adminAuth`, a management-only listener/path, expiry or boot reset, and a warning in system status. Prefer a follow-up slice if this cannot remain small.
- Add a generated endpoint manifest that classifies every HTTP route as public, farmer-authenticated, gateway-authenticated, or maintenance-only. Do not try to fix every route in this slice; fail CI only on unclassified additions and open audited follow-ups for current exceptions.

**Tests and field verification**

1. Static test proves production settings disable admin routes, bind loopback, and nginx has no direct 1880 redirect.
2. From the gateway AP and LAN, editor HTML, `GET /flows`, and `POST /flows` are unreachable; direct port 1880 is unreachable.
3. Farmer login, GUI assets, catalog, authenticated device/zone/history calls, database download authorization, and CORS still work.
4. Local MQTT ingest writes a sensor row; scheduler evaluation runs; a bounded test-valve command builds the expected downlink without publishing on a live device.
5. Node-RED restart, gateway reboot, payload rollback, and identity transition work. No database migration occurs.
6. Canary runs on a bench Pi and one recoverable demo gateway before the field cohort.

**Do not combine** this package with Node-RED 5, Node.js or OpenWrt upgrades, Debian migration, flow/domain extraction, token-format replacement, schema migration, broad endpoint auth remediation, or live valve behavior changes. Those changes would obscure rollback and make a security boundary fix unnecessarily risky.

## Decision table

| Decision needed               | Recommended choice                                         | Evidence                                                                                             | Owner                                | Prerequisite                              | Latest responsible decision point                    |
| ----------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- | ---------------------------------------------------- |
| Production editor exposure    | Disable admin/editor; loopback runtime                     | Shipped settings/nginx plus Node-RED security guidance                                               | Edge maintainer/security reviewer    | None                                      | Before next field payload                            |
| Edge application architecture | Contained Node-RED (B) with exit triggers                  | Proven behavior plus incomplete but successful helper strangler; large flow/common failure domain    | Edge architecture owner              | Phase 0                                   | Adopt now; reassess after Phase 2 field release      |
| Separate edge core            | Defer; shadow only when triggers fire                      | No current availability measurement justifies a second process                                       | Edge architecture + field operations | Phase 2 metrics                           | Before any core implementation                       |
| New-fleet base OS             | Provisional Debian/RPi OS arm64                            | OpenWrt 25.12 Node is host-only; Debian reduces toolchain ownership but appliance parity is unproved | Release/build owner                  | Dual prototype and hardware gates         | Before building the first production migration image |
| Existing OpenWrt fleet        | Bounded supported bridge                                   | Current radio/recovery path is field-proven; runtime/base are EOL or near EOL                        | Release/security owner               | SBOM and bridge expiry                    | Publish with next release policy                     |
| Pi support                    | Pi 4/5 arm64 baseline; older models legacy                 | Node-RED 5/modern Node and upstream architecture direction                                           | Product + field operations           | Fleet inventory                           | Before target-image contract freezes                 |
| ChirpStack on Debian storage  | Measure official PostgreSQL versus maintained SQLite build | Official Debian guide assumes PostgreSQL; current edge uses SQLite                                   | Edge/data owner                      | Phase 1 resource and recovery tests       | Before Debian image beta                             |
| Sync versions                 | Negotiated N/N-1; reject future versions                   | Current server warns then applies future versions                                                    | Server sync owner                    | Shared schema registry                    | Before emitting contract v2                          |
| Dead-letter recovery          | Audited replay through normal dispatcher                   | Current API is read-only by design                                                                   | Server operations owner              | Contract validation and idempotency tests | Before field volume makes manual repair routine      |
| Production migration          | Cohorted reflash/import with recovery kit                  | OS change is a field operation, not a package update                                                 | Field operations                     | Phases 0–3 and signed image               | Before first non-demo gateway                        |
| Product-intent validation     | Retrieve and review the four source documents              | Files were unavailable in this review                                                                | Product owner                        | Access to originals                       | Before final target ADR approval                     |

## Primary upstream sources

- [Node-RED release plan](https://nodered.org/about/releases/)
- [Node-RED supported Node.js versions](https://nodered.org/docs/faq/node-versions)
- [Node-RED 5 release announcement](https://nodered.org/blog/2026/06/09/version-5-0-released)
- [Node-RED security guidance](https://nodered.org/docs/user-guide/runtime/securing-node-red)
- [Node-RED runtime configuration](https://nodered.org/docs/user-guide/runtime/configuration)
- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [OpenWrt 25.12 Node package](https://github.com/openwrt/packages/blob/openwrt-25.12/lang/node/Makefile)
- [OpenWrt 24.10 Node package](https://github.com/openwrt/packages/blob/openwrt-24.10/lang/node/Makefile)
- [OpenWrt 24.10.8 support/EOL announcement](https://lists.openwrt.org/pipermail/openwrt-announce/2026-July/000089.html)
- [OpenWrt 25.12 stable release page](https://openwrt.org/releases/25.12/start)
- [ChirpStack Gateway OS v4.12 Pi 5 configuration](https://github.com/chirpstack/chirpstack-gateway-os/blob/v4.12.0/conf/full_raspberrypi_bcm27xx_bcm2712/.config)
- [ChirpStack OpenWrt feed Node-RED recipe](https://github.com/chirpstack/chirpstack-openwrt-feed/blob/master/apps/node-red/Makefile)
- [ChirpStack Debian/Ubuntu installation](https://www.chirpstack.io/docs/getting-started/debian-ubuntu.html)
- [Raspberry Pi OS downloads and architecture support](https://www.raspberrypi.com/software/operating-systems/)
- [Debian 13 release information](https://www.debian.org/releases/trixie/)

## Repository evidence index

- Edge baseline: [`osi-os@3c7b95bc`](https://github.com/Open-Smart-Irrigation/osi-os/tree/3c7b95bc83cec1a2758379ebf23b29919e3b0440); server baseline: [`osi-server@8cac33d3`](https://github.com/Open-Smart-Irrigation/osi-server/tree/8cac33d3a8a210784fa5f9b73c8e4dfe796203f7).
- Existing decisions reviewed: [static device registry](../adr/2026-05-28-static-device-plugin-registry.md), [schema and contract ownership](../adr/2026-06-30-schema-and-contract-ownership.md), and [scoped multi-user access](../adr/2026-07-19-scoped-multiuser-access-model.md).
- Edge refactor evidence includes the history-router extraction (`0ae6065f`), database integrity/quarantine path (`bc98472d`), chaos/soak rig (`0ca96c83`), and live identity supervision (`6dfb386c`).
- Server refactor evidence includes CI/GHCR and architecture gates (`970dfc3e`), per-event transactions/dead letters/backlog drain (`71dedeae`), deployment canary/fleet health (`84a85016`), and the first resource applier (`ba1672bf`).
- Relevant tracked work referenced by current repository guidance includes OSI OS issues [#50](https://github.com/Open-Smart-Irrigation/osi-os/issues/50) (root filesystem growth), [#56](https://github.com/Open-Smart-Irrigation/osi-os/issues/56) (lossless backup), and [#88–#90](https://github.com/Open-Smart-Irrigation/osi-os/issues/88) (schema-hardening roadmap). These issue bodies were not treated as facts without matching code.
