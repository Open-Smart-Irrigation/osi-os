# OSI Server (Cloud Backend) — Expert Refactor Program

Senior cloud backend / architect review. Scope: osi-server Spring monolith, sync ingestion, contract governance, CI/testing, ops posture. Verified against `/home/phil/Repos/osi-server` (read-only).

## Verified ground truth (what's actually there)

- **Package layout is fine.** `org.osi.server.{sync,mqtt,analytics,prediction,chameleon,soil,...}` — 20 top-level packages, sensibly named. The problem is not the package tree; it's two god-files: `sync/EdgeSyncService.java` = **93 KB / ~1900 LOC** and `analytics` ~8.6 KLOC across the widest fan-out. Boundaries are drawn; they're just not *enforced* and one of them is a monolith-within-the-monolith.
- **Sync ingestion is more mature than the briefing implies.** V2 path (`applyEventsV2` → `applyEventV2`) already has: inbox dedup (`existsById`), a `SUPPORTED_OPS` gate returning `rejected(…, "unknown_op")`, per-resource watermark idempotency (`SyncResourceWatermark`, highest-sync-version + payload-hash), `contract_version` read + logged mismatch, and typed results (`applied/duplicate/rejected/retryable`). Retention jobs exist for inbox, commands, telemetry.
- **The real #89 residual:** rejected/unknown events are written to the inbox via `saveInboxTerminal(...)` **for dedup only**. `SyncInboxEvent` has columns `event_uuid, processed_at, source_node` — **no status, no reason, no payload**. So a dead-lettered event is byte-identical to a successfully applied one, and its payload is *gone*. You cannot answer "what did gateway X send that we dropped, and why" — which is the entire point of dead-lettering. This is the cheap, high-value fix.
- **Batch transaction hazard (poison-pill).** `applyEventsV2` is one `@Transactional`. `applyEventV2` catches and returns `retryable` on generic exceptions — but if a JPA repository call already threw inside that outer tx, Spring marks it **rollback-only**; the whole batch then fails at commit, *including the inbox dedup rows written for events that "succeeded" earlier in the loop*. Under weeks-of-backlog replay this is exactly the condition that produces silent, repeating whole-batch failures. Confirmed structurally; needs per-event tx boundary or `noRollbackFor`.
- **No CI on osi-server. Confirmed.** `.github/` contains only `pull_request_template.md`. 159 test files, `spring-boot-starter-test` + `h2` (testRuntimeOnly) present, but tests are Mockito-repository style — **no test actually runs against Postgres or Flyway**. So Flyway migrations (V2–V41, 55 SQL files) and all JPA/native SQL are **completely untested until production deploy**.
- **On-host build = the VPS-killer, confirmed.** `docker/docker-compose.yml` uses `build:` for backend + 3 prediction services; `docker/backend/Dockerfile` is a multi-stage build compiling **two Vite frontends + a Gradle Spring Boot jar** on the host. On 4 CPU / 4 GB this is the documented unresponsiveness. No `bootBuildImage`, no jib, no layered jar, no prebuilt-artifact path.
- Actuator is on the classpath (good — cheap `/health`, `/metrics` baseline) but no Micrometer/Prometheus registry dependency observed.

---

## 1. Design choices (the decisions that matter)

### D1 — Module enforcement: ArchUnit, not Spring Modulith, not Gradle modules
- **A. Spring Modulith** — runtime module verification, event-driven decoupling, docs generation. *Trade:* buys an idiom (application events between modules) you don't need at 20 packages / one deployable; adds a framework to learn and version-track for a solo maintainer.
- **B. Multi-module Gradle** — hard compile-time boundaries. *Trade:* real friction (build graph, cyclic-dep fights) for a codebase that has one god-file, not a boundary-crossing epidemic. Premature.
- **C. ArchUnit as a plain JUnit test** — assert "no cycles between top-level packages", "`sync` must not depend on `analytics`", "controllers only in `*Controller`". *Trade:* advisory not structural, but zero deploy/build changes and it runs in the CI you're about to build.
- **Recommendation: C.** One ArchUnit test locks the boundaries you already have *before* you refactor `EdgeSyncService`, so the split can't accidentally create a cycle. Revisit Modulith only if a second deployable appears (it won't at this scale).

### D2 — Split `EdgeSyncService` (93 KB) — the one structural refactor that pays
This file is the strangler target on the server side. Options for *how*:
- **A. Leave it, add tests around it.** *Trade:* every device-integration change keeps editing a 1900-line file with no seams; merge/AI-agent risk stays high.
- **B. Extract per-resource *appliers*** (`DeviceDataApplier`, `DendroApplier`, `ChameleonApplier`, `ZoneApplier`, …) behind a `SyncEventApplier` interface keyed by op, with the orchestration loop (dedup → contract → ownership → watermark → apply → inbox) staying thin. *Trade:* real work (M), but it directly mirrors the edge "narrow-waist" proposal — a new device = one new applier + one contract entry, testable in isolation.
- **Recommendation: B, convert-on-touch.** Do NOT big-bang. Extract the applier for whatever resource the next device (MClimate) touches, prove the pattern, leave the rest until touched. The op→handler `switch` at line ~428 is the natural seam.

### D3 — Idempotency & dead-letter model (the #89 fix)
- **A. Keep dedup-in-inbox, add nothing.** *Trade:* cheapest, but you keep flying blind on drops — unacceptable for a fleet growing 30×.
- **B. Add `status` + `reason` + `payload` (jsonb) + `contract_version` to the inbox** (or a sibling `sync_dead_letter` table). Rejected/unknown ops land here queryable; a small admin endpoint lists them per gateway; retention prunes applied rows aggressively but keeps dead-letters longer. *Trade:* one Flyway migration + a repository method; payload storage grows, bounded by retention.
- **Recommendation: B, as a separate `sync_dead_letter` table** (not widening the hot inbox row that every dedup check hits). This is the single highest leverage item in the whole program: it closes #89 *and* gives you the forensic surface for every future contract mismatch during the slow, uneven fleet upgrade.

### D4 — Contract governance: generate fixtures, NOT types (respect the ADR kill-switch)
- **A. Full codegen** (JSON Schema → Java records + TS types). *Trade:* violates the ADR's kill-switch spirit unless the generated Java is *actually consumed*; today osi-server parses payloads as maps (`nullableStr(payload, …)`), so generated types would be dead code — auto-delete-worthy.
- **B. Generate only what's consumed: contract *fixtures* + a schema-validation test.** Golden example payloads per op, validated against `events.schema.json` in CI on *both* repos; the op-enum parity gate already exists (Tranche A). *Trade:* doesn't give you compile-time payload safety, but it's honest under the ADR and catches the real failure (edge emits a shape the server can't parse) as a test, not a 2 a.m. rejected-batch.
- **Recommendation: B.** Add a runtime JSON-Schema validation of inbound events at the ingest boundary (fail → dead-letter with `reason=schema_violation`), fed by the same schemas. Versioning: keep the current "one handler version, log mismatch, apply anyway" for minor; reserve a hard reject (→ dead-letter, not drop) for a bumped major `contract_version` the server predates. Generate Java records only if/when you stop map-parsing — and delete them the day they're not consumed.

### D5 — Test architecture: Testcontainers for the sync/JPA/Flyway core, keep Mockito for logic
- **A. H2** (already a dep). *Trade:* H2 ≠ Postgres — jsonb, `ON CONFLICT`, native SQL, Flyway PG-specific migrations all diverge; you'd be testing a database you don't run. Reject for the sync path.
- **B. Testcontainers Postgres 16** for a thin slice: Flyway-migrate-clean test, `EdgeSyncService` apply/dedup/watermark/dead-letter behavior, retention jobs. Keep Mockito for analytics math and weather adapters. *Trade:* Testcontainers needs Docker in CI (GitHub-hosted runners have it) and ~10–20 s startup; negligible for the ~15 tests that need a real DB.
- **Recommendation: B, reuse a single container** across the DB-backed tests (static `@Container` / Spring context reuse) so the suite stays fast. This is the credible minimum: the untested surface today is *exactly* the surface that touches live-farm mirror data.

### D6 — Deploy: prebuilt artifact, never on-host build
- **A. Keep `docker compose build` on the VPS.** *Trade:* the known unresponsiveness; also couples a farm-data-adjacent host's uptime to a Gradle+2×Vite build succeeding under memory pressure.
- **B. Build the image in CI → push to GHCR → VPS `docker compose pull && up -d --no-deps backend`.** *Trade:* needs a registry (GHCR free for this) and CI (which D5 already brings). Frees the VPS from ever compiling.
- **Recommendation: B.** This is a *safety* change, not just speed: builds move off the box that mirrors irreplaceable farm history. Pair with a layered `bootJar` so `docker pull` diffs are small over the VPS's link.

---

## 2. Phasing (≈4–6 months, each phase leaves it shippable & safer)

**Phase 0 — Make it testable & observable (weeks 1–3).** Prereq for everything.
- CI workflow: `./gradlew test` on PR — *goal:* stop untested merges · dep: none · **S**
- Testcontainers Postgres + Flyway-migrate-clean test — *goal:* migrations tested pre-deploy · dep: CI · **M**
- ArchUnit boundary test (no cycles, `sync`↛`analytics`) — *goal:* lock boundaries before refactor · dep: CI · **S**
- Micrometer + actuator Prometheus endpoint (heap, ingest rate, batch-fail count) — *goal:* server-side observability beyond gateway heartbeat · dep: none · **S**

**Phase 1 — Ingest durability & forensics (weeks 3–7).** Closes #89, hardens replay.
- `sync_dead_letter` table (status/reason/payload/contract_version) + admin list endpoint — *goal:* stop losing dropped events · dep: Testcontainers (to test it) · **M**
- Per-event transaction boundary (or `noRollbackFor`) in batch apply — *goal:* one poison event can't fail a whole backlog batch · dep: dead-letter · **M**
- Batch-size cap + gateway-scoped rate limit on `/sync/events` — *goal:* backpressure when a gateway replays weeks · dep: none · **S**
- Runtime JSON-Schema validation at ingest → dead-letter on violation — *goal:* contract enforced as data, not crash · dep: dead-letter, contract fixtures · **M**

**Phase 2 — Deploy safety off-VPS (weeks 6–9).** Can overlap Phase 1.
- Layered `bootJar` + GHCR image build in CI — *goal:* never build on the VPS again · dep: CI · **M**
- VPS deploy = `pull && up -d --no-deps backend` + rollback-to-previous-tag runbook — *goal:* atomic, reversible deploy · dep: GHCR · **S**
- Canary gate: post-deploy assert `/actuator/health` + sync applies non-zero before declaring success — *goal:* auto-catch a bad rollout · dep: metrics · **S**

**Phase 3 — Strangle the god-file (weeks 9–16).** Convert-on-touch only.
- Extract `SyncEventApplier` interface + first per-resource applier (MClimate/whatever's next) — *goal:* new device = new applier, tested alone · dep: Testcontainers, ArchUnit · **M**
- Extract remaining appliers as their resources are touched — *goal:* shrink 93 KB file incrementally · dep: first applier · **L (spread over months)**
- Contract fixtures (golden payloads per op) validated in both repos' CI — *goal:* honest contract generation under the ADR · dep: schema validation · **M**

**Phase 4 — Postgres care & scale prep (weeks 14–22).** Do before, not after, fleet grows.
- Index audit on hot paths (`sensor_data(device_eui, recorded_at)`, watermark PK, inbox `source_node/processed_at`) — *goal:* keep ingest O(1) at 100× · dep: none · **M**
- Retention/pruning tuning + partition-or-brin decision for `sensor_data` — *goal:* bounded table growth · dep: index audit · **M**
- autovacuum/analyze tuning for high-churn inbox/watermark tables — *goal:* no bloat stall · dep: none · **S**
- Backlog-replay soak test (one gateway replays N weeks) against Testcontainers — *goal:* prove backpressure works before a real gateway does it · dep: Phase 1 · **M**

---

## 3. Risks & failure modes / one-way doors

- **Poison-pill batch rollback under replay** is live *today*. The stale Uganda gateway (#87) catching up is the exact trigger. Fix (Phase 1) before forcing that catch-up.
- **Dead-letter table + retention is a one-way door on data:** if you prune dead-letters too aggressively you re-lose the forensic value. Start with generous retention (90 d), tighten later.
- **Flyway migrations are one-way doors on production Postgres.** Every V-migration must be tested clean-migrate *and* migrate-from-prod-snapshot in CI before it touches `osicloud.ch`. A destructive PG migration on farm-mirror data is the cloud analogue of the edge data-loss incident. **Rehearse against a restored prod snapshot, never straight to prod.**
- **GHCR/registry cutover:** the first pull-based deploy must be rehearsed on the *test* server (`server.opensmartirrigation.org`) with a tested rollback tag, because if `up -d` fails and you've removed the on-host build path, you need the previous image already pulled.
- **AI-agent editing a 93 KB file** is itself a risk (merge conflicts, silent logic drift). Extracting appliers reduces the blast radius per change — that's a safety argument, not just cleanliness.
- **Don't refactor `EdgeSyncService` before Phase 0/1 tests exist** — you'd be restructuring the farm-data ingest path with zero DB-level test coverage. That ordering is non-negotiable.

## 4. YAGNI (do not build at this scale)

- **Spring Modulith / multi-module Gradle** — one deployable, 20 packages; ArchUnit covers it.
- **Kafka / RabbitMQ / any external broker for sync** — REST inbox/outbox is right for a 100s-gateway, 30 s-cadence, offline-tolerant fleet. A broker adds an always-up dependency that violates offline-first tolerances and needs care on 4 GB.
- **Full JSON-Schema→Java/TS type codegen** — dead code today (map-parsing); violates the kill-switch invariant. Fixtures only.
- **Read replicas / Postgres HA / connection pooler beyond Hikari defaults** — single 4 GB box; a replica doesn't fit and isn't the bottleneck (see §5).
- **Microservice split of analytics/prediction** — prediction is already a separate Python service; further splitting the JVM monolith buys nothing but ops overhead for a solo maintainer.
- **Event sourcing / CQRS for sync** — you already have an event log (inbox) and materialized state; formalizing it is pure ceremony here.
- **Distributed tracing (Jaeger/Tempo)** — one process; actuator + structured logs + a metrics scrape is enough until proven otherwise.

## 5. Performance & scale (where it breaks first, cheapest durable fix)

- **First break, ~10× (30 gw):** not CPU — it's the **whole-batch transaction** and **unbounded batch size**. A single stale gateway replaying weeks (Uganda-shaped) either (a) submits a huge batch that holds one long PG transaction and blocks vacuum, or (b) hits one poison event and repeatedly fails the entire batch. *Cheapest durable fix:* per-event tx boundary + batch cap + dead-letter (Phase 1). Survives 100×.
- **~10–30×:** **`sensor_data` table growth + missing/So-so indexes.** Ingest and dashboard queries do `device × time` scans; without a `(device_eui, recorded_at)` index and retention/partitioning, ingest latency climbs and autovacuum falls behind on the high-churn inbox/watermark tables. *Cheapest fix:* index audit + BRIN or monthly partition on `sensor_data` + retention tuning (Phase 4). A single 4 GB box handles 100s of gateways at 30 s cadence *if* the hot tables are indexed and pruned — the volume is modest; the risk is unbounded tables and vacuum stalls, not raw throughput.
- **~30–100×:** **bootstrap snapshot every 6 h × N gateways** becomes a thundering-herd of full-state reads. *Cheapest fix:* stagger/jitter snapshot windows per gateway and make snapshots incremental (watermark-delta) rather than full — the watermark machinery to do this already exists.
- **JVM heap on 4 GB:** the JAR co-locates with Postgres 16, Mongo, Mosquitto, Caddy, prediction services. Heap pressure will bite before CPU. *Cheapest fix:* cap `-Xmx` explicitly (~768 MB–1 GB), watch it via the Micrometer endpoint from Phase 0, and keep the frontend build off the box (Phase 2) so nothing but steady-state serving runs there.

**Bottom line:** the cloud side is in better shape than the framing suggests — the boundaries exist and the sync path is thoughtfully built. Three things are load-bearing and under-served: (1) no CI/DB tests over the exact code that mutates farm-mirror data, (2) dropped events vanish without a trace (#89), and (3) the VPS still compiles its own images next to irreplaceable data. Phases 0–2 close all three cheaply and unlock the rest.
