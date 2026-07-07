# EdgeSyncService per-resource applier split (refactor-program 3.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Repo split:** this plan file lives in **osi-os** (docs home), but **every code change is in `/home/phil/Repos/osi-server`** — branch `feat/sync-applier-split`, PR in the osi-server repo, **do not merge**. Zero osi-os file changes.
> **Execution notes:** (1) work on a feature branch/worktree of osi-server `main`, run all commands from `/home/phil/Repos/osi-server/backend`; (2) **osi-server CI wiring is 1.B3's job** — gates here are LOCAL `./gradlew test`; the fast iteration variant is `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend` (per osi-server AGENTS.md); run the un-skipped full `./gradlew test` once before the PR; (3) **Docker must be running locally** — Testcontainers (the 1.B4 `PostgresSyncTestBase` singleton) starts one Postgres 16 container for the whole test JVM; (4) **HARD DEPENDENCY: 1.B4 must be merged first.** This plan consumes `SyncEventTxExecutor`, `SyncOpDispatcher`, `SyncEventShapes`, `PostgresSyncTestBase`, and `PoisonBatchIT` — all introduced by 1.B4. If any is absent, STOP and confirm 1.B4 landed; re-verify their exact shapes in-repo before starting (a concurrent 1.B4 revision could shift a signature).
> **Spec:** [`docs/superpowers/specs/2026-07-08-edge-sync-applier-split-design.md`](../specs/2026-07-08-edge-sync-applier-split-design.md) (approved; §A–§D references point there).

**Goal:** Prove the DD12 per-resource-applier pattern by extracting **one** applier — `GATEWAY_LOCATION_UPSERTED` — out of `EdgeSyncService`'s op-dispatch switch into a `SyncEventApplier` bean, wired through a startup-built op→applier registry, with the applier testable in complete isolation against real Postgres. The other 11 cases stay in the switch and migrate convert-on-touch. Behavior-preserving by mandate.

**Architecture (spec §A–§C):** a package-private `SyncEventApplier` interface (`Set<String> supportedOps()`, `void apply(gatewayDeviceEui, event)`). `GatewayLocationApplier` `@Component` implements it, body = today's `upsertGatewayLocation` moved verbatim (return dropped to `void`), depending only on `GatewayLocationRepository` + `SyncEventShapes` static helpers. `EdgeSyncService` injects `List<SyncEventApplier>`, folds to `Map<String,SyncEventApplier>` in `@PostConstruct` with a duplicate-op fail-fast; `applyEvent(gatewayDeviceEui, event, dryRun)` consults the registry before the switch (extracted op → `apply` live / `return true` dry-run); the `GATEWAY_LOCATION_UPSERTED` case is deleted from the switch. The 1.B4 transaction boundary (`SyncEventTxExecutor.applyOne`, the loop classifier, `recordRejection`, `finalizeBatch`, the anonymous `SyncOpDispatcher`) is **untouched** — the applier slots inside `applyOne` via the existing dispatcher→`applyEvent` delegation.

**Tech Stack:** Java 17 / Spring Boot 3.4.3, Lombok (`@Component @RequiredArgsConstructor`; the registry fold is `@PostConstruct`, not a constructor body), Testcontainers Postgres 16 (via 1.B4's `PostgresSyncTestBase`), JUnit 5 + Mockito + AssertJ.

## Global Constraints

- **All code changes in osi-server only.** Branch `feat/sync-applier-split`; commit per task; open a PR at the end; **do not merge it.** Never modify anything under `/home/phil/Repos/osi-os`.
- **Behavior-preserving extraction (program mandate).** The `GATEWAY_LOCATION_UPSERTED` apply path must behave byte-for-byte as today. 1.B4's `PoisonBatchIT` (which already drives `GATEWAY_LOCATION_UPSERTED` through the full loop) is the golden regression net — it must stay green unmodified.
- **Do not touch the 1.B4 transaction boundary** (`SyncEventTxExecutor`, the classifier, `recordRejection`, `finalizeBatch`, the anonymous `SyncOpDispatcher`), `applyBootstrap`, the V1 path, or any other op's behavior.
- **`isStale`/watermark harmonization is out of scope** — the applier keeps `upsertGatewayLocation`'s self-contained stale guard verbatim, redundant with `applyOne`'s watermark check. Harmonizing is a separate behavior-change PR.
- **No production or test-server access.** Everything runs locally via Testcontainers. No secrets in code or tests.
- Local gates per task; full suite (`cd backend && ./gradlew test`) green before the PR.

## Non-goals (do not do these)

- No migration of any op other than `GATEWAY_LOCATION_UPSERTED`. The other 11 stay in the switch.
- No change to the 1.B4 boundary, `applyBootstrap`, or the event-path watermark/ownership/dead-letter logic.
- No `isStale`/watermark harmonization, no canonical-state refactor, no logic change of any kind on the moved path.
- No CI workflow / GHCR / deploy changes (1.B3). No bootstrap-snapshot work (5.5). No actuator applier (that's MClimate 3.1's second-consumer proof).
- No edge-side (osi-os) changes of any kind.

## File Structure (all paths relative to `/home/phil/Repos/osi-server/backend`)

- Create: `src/main/java/org/osi/server/sync/SyncEventApplier.java` (Task 1)
- Create: `src/main/java/org/osi/server/sync/GatewayLocationApplier.java`, `src/test/java/org/osi/server/sync/GatewayLocationApplierIT.java`, `src/test/java/org/osi/server/sync/SyncEventApplierTest.java`; Modify: `src/main/java/org/osi/server/sync/SyncEventShapes.java` (add the primitives the applier needs — Task 2)
- Modify: `src/main/java/org/osi/server/sync/EdgeSyncService.java` (Task 3)
- Create: `src/test/java/org/osi/server/sync/SyncApplierDispatchIT.java`, `src/test/java/org/osi/server/sync/SyncApplierRegistryTest.java` (Task 4)

---

### Task 1: `SyncEventApplier` interface + pre-flight verification of the 1.B4 surface

**Files:**
- Create: `src/main/java/org/osi/server/sync/SyncEventApplier.java`

**Interfaces:**
- Produces: the `SyncEventApplier` interface consumed by Tasks 2–4.

- [ ] **Step 1.1: Verify 1.B4 landed and re-confirm shapes** — before any code, confirm in-repo:
  - `git checkout main && git pull --ff-only` on osi-server, then `git checkout -b feat/sync-applier-split`.
  - `SyncEventTxExecutor`, its nested `SyncOpDispatcher` interface (`boolean supports(SyncEventRecord)`, `void apply(SyncEventRecord)`), `SyncEventShapes` (with `payloadWithOp`, `eventSyncVersion`, `str`, `nullableStr`, `numLong`), `PostgresSyncTestBase`, and `PoisonBatchIT` all exist under `src/*/java/org/osi/server/sync/`. If any is missing, **STOP** — 1.B4 has not merged; do not proceed.
  - Re-read the current `EdgeSyncService.applyEvent(gatewayDeviceEui, event, dryRun)` (the switch) and `upsertGatewayLocation` to confirm line ranges and the exact primitive call list (spec §B lists the verified-at-spec-time set: `normalizeGatewayDeviceEui`, `str`, `numDoubleObj`, `numIntegerObj`, `nullableStr`, `parseNullableInstant` 2-arg + 3-arg overload, `isStale`). **Re-derive the actual list from the live body** — a concurrent merge may have changed it.

- [ ] **Step 1.2: Create the interface** — `src/main/java/org/osi/server/sync/SyncEventApplier.java`:

```java
package org.osi.server.sync;

import java.util.Set;

/**
 * DD12 per-resource applier (spec 2026-07-08-edge-sync-applier-split-design.md §A).
 * One applier owns one or more op strings, lifted out of EdgeSyncService's op-dispatch
 * switch. Runs inside SyncEventTxExecutor.applyOne's REQUIRES_NEW transaction (1.B4):
 * ownership, watermark, dedup, and dead-letter are the caller's job — an applier is
 * exactly the former upsert* body, nothing more.
 */
interface SyncEventApplier {

    /** The op strings this applier owns — the switch case labels it replaces. */
    Set<String> supportedOps();

    /**
     * Apply the domain mutation for one already-validated event. Live path only
     * (dry-run is answered by supportedOps().contains(op)). May throw
     * IllegalArgumentException for payload-validation faults (classified in-method by
     * applyOne); repository/JPA exceptions propagate to applyEventsV2's loop
     * classifier. Behavior identical to the switch case it replaces.
     */
    void apply(String gatewayDeviceEui, EdgeSyncService.SyncEventRecord event);
}
```

- [ ] **Step 1.3: Compile** — `./gradlew compileJava -x buildFrontend -x buildTerraIntelligenceFrontend`. Expected: `BUILD SUCCESSFUL` (interface compiles; `EdgeSyncService.SyncEventRecord` is the existing public record).

- [ ] **Step 1.4: Commit**

```bash
git add src/main/java/org/osi/server/sync/SyncEventApplier.java
git commit -m "feat(sync): SyncEventApplier interface — the DD12 per-resource applier seam (3.4)"
```

---

### Task 2: `GatewayLocationApplier` + its isolation test (the pattern proof, TDD'd)

This is the headline deliverable: an applier testable with no `EdgeSyncService`, no executor, no ownership — just the applier + a real repository.

**Files:**
- Create: `src/test/java/org/osi/server/sync/GatewayLocationApplierIT.java`
- Create: `src/test/java/org/osi/server/sync/SyncEventApplierTest.java`
- Create: `src/main/java/org/osi/server/sync/GatewayLocationApplier.java`

**Interfaces:**
- Produces: `GatewayLocationApplier` (`supportedOps() = {"GATEWAY_LOCATION_UPSERTED"}`, `apply(...)` = `upsertGatewayLocation` moved) consumed by Task 3's registry.

- [ ] **Step 2.1: Write the failing isolation IT** — create `src/test/java/org/osi/server/sync/GatewayLocationApplierIT.java`. Use the 1.B4 `PostgresSyncTestBase` singleton, `@DataJpaTest` + `@AutoConfigureTestDatabase(replace = NONE)`, `@Import(GatewayLocationApplier.class)`, a **unique gateway EUI for this class** (shared DB). Assert:
  - `apply(eui, event)` with a `GATEWAY_LOCATION_UPSERTED` event upserts the `gateway_locations` row with latitude/longitude/status from the payload;
  - a second `apply` with a **lower** `sync_version` no-ops (the `isStale` guard — row unchanged);
  - a fresh insert with no `sync_version` in the payload sets `sync_version = 1`.
  Build the `SyncEventRecord` the same way `PoisonBatchIT` does (reuse its `gwLocEvent`-style helper shape). No `EdgeSyncService`, no `@MockBean` services — that isolation is the point.

Run: `./gradlew test --tests 'org.osi.server.sync.GatewayLocationApplierIT' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: FAIL — compile error, `GatewayLocationApplier` does not exist. That is the red.

- [ ] **Step 2.2: Write the `supportedOps()` unit test** — create `src/test/java/org/osi/server/sync/SyncEventApplierTest.java`: a plain JUnit test (no container) asserting `new GatewayLocationApplier(mock(GatewayLocationRepository.class)).supportedOps()` equals `Set.of("GATEWAY_LOCATION_UPSERTED")`.

- [ ] **Step 2.3: Implement `GatewayLocationApplier`** — create `src/main/java/org/osi/server/sync/GatewayLocationApplier.java`. `@Component @RequiredArgsConstructor`, `implements SyncEventApplier`, depends only on `GatewayLocationRepository`. `apply` builds `SyncEventShapes.payloadWithOp(event)` and runs **the `upsertGatewayLocation` body moved verbatim** with `gatewayDeviceEui` as the fallback EUI, `return`s dropped (bare `gatewayLocationRepository.save(location)`). Any primitive the body needs that `SyncEventShapes` lacks (per Step 1.1's re-derived list — expected: `normalizeGatewayDeviceEui`, `str`, `numDoubleObj`, `numIntegerObj`, `nullableStr`, `parseNullableInstant` both overloads, `isStale`) is added in Task 3 to `SyncEventShapes`; reference them as `SyncEventShapes.<name>(...)`. **Do not change the logic** — same stale guard, same field mapping, same sync-version bookkeeping.

- [ ] **Step 2.4: Add the primitives to `SyncEventShapes` (this task owns the add)** — the applier cannot compile without them, so they are added here, not deferred to Task 3. For each helper `GatewayLocationApplier` references that `SyncEventShapes` lacks (per Step 1.1's re-derived list — expected: `normalizeGatewayDeviceEui`, `str`, `numDoubleObj`, `numIntegerObj`, `nullableStr`, `parseNullableInstant` both overloads, `isStale`), add a static package-private helper — a verbatim copy of `EdgeSyncService`'s instance method (which STAYS for its ~100 other call sites). Keep the `numLong` boxed/primitive detail in mind (spec §B): the moved body's `Optional.ofNullable(numLong(...)).orElse(0L)` auto-boxes harmlessly against the primitive-returning `SyncEventShapes.numLong`.

- [ ] **Step 2.5: Run it (green)**

Run: `./gradlew test --tests 'org.osi.server.sync.GatewayLocationApplierIT' --tests 'org.osi.server.sync.SyncEventApplierTest' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: all pass — the applier upserts, the stale guard no-ops, `supportedOps()` is correct.

- [ ] **Step 2.6: Commit**

```bash
git add src/main/java/org/osi/server/sync/GatewayLocationApplier.java \
        src/test/java/org/osi/server/sync/GatewayLocationApplierIT.java \
        src/test/java/org/osi/server/sync/SyncEventApplierTest.java \
        src/main/java/org/osi/server/sync/SyncEventShapes.java
git commit -m "feat(sync): GatewayLocationApplier + isolation test — the DD12 pattern proof (3.4)"
```

---

### Task 3: Wire the registry into `EdgeSyncService`, delete the switch case

**Files:**
- Modify: `src/main/java/org/osi/server/sync/EdgeSyncService.java`

**Interfaces:**
- Produces: the op→applier registry + registry-before-switch dispatch in `applyEvent`.

- [ ] **Step 3.1: Confirm `SyncEventShapes` primitives compiled in Task 2** — the primitive-add is Task 2's job (Step 2.4); this step is a check, not an edit. If `GatewayLocationApplier` compiled green in Task 2, the primitives are in place — no `SyncEventShapes` change here.

- [ ] **Step 3.2: Inject the applier list + build the registry** — in `EdgeSyncService`:
  - Add `private final List<SyncEventApplier> syncEventAppliers;` (Lombok `@RequiredArgsConstructor` includes it — do NOT hand-write a constructor).
  - Add `private final Map<String, SyncEventApplier> appliersByOp = new HashMap<>();` and a `@PostConstruct void buildApplierRegistry()` that folds `syncEventAppliers` into it, throwing `IllegalStateException` if two appliers claim the same op (fail-fast, spec §C). **Verify no existing `Map<String,...>` bean-collection convention exists** (spec §C notes this idiom is new to the repo) — if one does, use it.

- [ ] **Step 3.3: Rewrite `applyEvent` to consult the registry before the switch** — at the top of `applyEvent(gatewayDeviceEui, event, dryRun)`, after the `event.op() == null` guard, insert:

```java
SyncEventApplier applier = appliersByOp.get(event.op());
if (applier != null) {
    if (!dryRun) applier.apply(gatewayDeviceEui, event);
    return true;
}
```

Then **delete the `GATEWAY_LOCATION_UPSERTED` case** from the switch (the `case "GATEWAY_LOCATION_UPSERTED" -> { if (!dryRun) upsertGatewayLocation(payload, gatewayDeviceEui); return true; }` block). Leave the other 11 cases and `default` exactly as-is. **Delete the now-unused private `upsertGatewayLocation` method** from `EdgeSyncService` (its logic now lives in the applier) — confirm via grep it has no other caller (`applyBootstrap` calls it at `:1173`-region! — VERIFY: if `applyBootstrap` still calls `upsertGatewayLocation`, do NOT delete it; keep the private method for the bootstrap path and let the applier hold its own copy, OR route bootstrap through the applier. **Default safe choice: keep `EdgeSyncService.upsertGatewayLocation` for `applyBootstrap`'s use; the applier holds the moved copy.** Duplication is acceptable and convert-on-touch will resolve it when `applyBootstrap` is next touched — do not expand scope to refactor bootstrap here.).

- [ ] **Step 3.4: Run the regression net (green — behavior preservation)**

Run: `./gradlew test --tests 'org.osi.server.sync.*' -x buildFrontend -x buildTerraIntelligenceFrontend`
Expected: **1.B4's `PoisonBatchIT` passes unchanged** (it drives `GATEWAY_LOCATION_UPSERTED` through the full loop — this is the golden proof the registry path is behavior-identical), plus all Task 2 tests. If `PoisonBatchIT` fails, the extraction changed behavior — stop and diff.

- [ ] **Step 3.5: Commit**

```bash
git add src/main/java/org/osi/server/sync/EdgeSyncService.java
git commit -m "feat(sync): op->applier registry in EdgeSyncService; extract GATEWAY_LOCATION_UPSERTED case (3.4/DD12)"
```

---

### Task 4: Dispatch-parity + registry-guard tests, full-suite gate, PR

**Files:**
- Create: `src/test/java/org/osi/server/sync/SyncApplierDispatchIT.java`
- Create: `src/test/java/org/osi/server/sync/SyncApplierRegistryTest.java`

- [ ] **Step 4.1: Dispatch-parity IT** — create `SyncApplierDispatchIT.java` reusing the `PoisonBatchIT` slice shape (`PostgresSyncTestBase`, `@DataJpaTest`, `@Import({EdgeSyncService.class, SyncEventTxExecutor.class, GatewayLocationApplier.class, ...})`, the same `@MockBean` set, a unique gateway EUI): send a `GATEWAY_LOCATION_UPSERTED` batch through `edgeSyncService.applyEventsV2(...)` and assert the result is `APPLIED`, the `gateway_locations` row is present, and the watermark advanced — proving the registry-through-`applyOne` path is behavior-identical to the pre-split switch. (This overlaps `PoisonBatchIT` intentionally; it is the explicit parity assertion for this item.) **`@Import` note:** under the `@DataJpaTest` slice, `EdgeSyncService`'s injected `List<SyncEventApplier>` is populated ONLY by the applier beans you explicitly `@Import` — so the `@Import` applier set must include every applier the registry expects (today just `GatewayLocationApplier`); otherwise the `@PostConstruct` fold builds a partial registry unlike production. As more appliers are extracted, keep this `@Import` set in sync.

- [ ] **Step 4.2: Registry duplicate-op guard test** — create `SyncApplierRegistryTest.java`: either a plain unit test of the fold function with two mock appliers claiming the same op (assert `IllegalStateException`), or a `@SpringBootTest`-lite that fails context startup with a duplicate applier. Prefer the plain unit test (no Spring context) if the fold is extractable to a static/testable method; otherwise assert on the `@PostConstruct` throwing.

- [ ] **Step 4.3: Full-suite gate**

Run: `cd /home/phil/Repos/osi-server/backend && ./gradlew test`
Expected: entire suite green (un-skipped, including frontend hooks). The 1.B4 tests, all pre-existing sync tests, and this item's four new tests all pass. Docker must be running.

- [ ] **Step 4.4: Commit + open PR (do not merge)**

```bash
git add src/test/java/org/osi/server/sync/SyncApplierDispatchIT.java \
        src/test/java/org/osi/server/sync/SyncApplierRegistryTest.java
git commit -m "test(sync): dispatch-parity + registry duplicate-op guard for the applier split (3.4)"
git push -u origin feat/sync-applier-split
gh pr create --title "feat(sync): DD12 first per-resource applier — GATEWAY_LOCATION_UPSERTED (3.4)" \
  --body "Refactor-program 3.4. Extracts the first SyncEventApplier as the DD12 pattern proof. Behavior-preserving: 1.B4 PoisonBatchIT stays green. Other 11 ops convert-on-touch. Do not merge without review." --draft
```

---

## Verification checklist (before marking done)

- [ ] `SyncEventApplier` interface + `GatewayLocationApplier` exist; applier depends only on `GatewayLocationRepository` + `SyncEventShapes`.
- [ ] `GatewayLocationApplierIT` proves the applier works in isolation (no `EdgeSyncService`/executor/ownership) — the headline capability.
- [ ] `EdgeSyncService.applyEvent` consults `appliersByOp` before the switch; `GATEWAY_LOCATION_UPSERTED` case deleted; both dry-run (`return true`) and live (`apply`) preserved.
- [ ] `@PostConstruct` registry fold with duplicate-op fail-fast; `@RequiredArgsConstructor` kept.
- [ ] 1.B4 `PoisonBatchIT` green unchanged (behavior-preservation net).
- [ ] `applyBootstrap`'s `upsertGatewayLocation` call handled (kept the private method OR routed through applier — no bootstrap behavior change).
- [ ] `SyncEventTxExecutor` / classifier / `recordRejection` / `finalizeBatch` / anonymous `SyncOpDispatcher` untouched.
- [ ] Full `./gradlew test` green; zero osi-os changes; PR open, not merged.
