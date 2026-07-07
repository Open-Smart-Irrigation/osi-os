# osi-server CI + ArchUnit + Micrometer + GHCR Pull-Only Deploys (refactor-program 1.B3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Repo split:** this plan file lives in **osi-os** (docs home), but **every code change is in `/home/phil/Repos/osi-server`** — branch `feat/ci-ghcr-deploys`, PR in the osi-server repo, **do not merge**. Zero osi-os file changes.
> **Execution notes:** (1) work on a feature branch of osi-server `main`; Gradle commands run from `/home/phil/Repos/osi-server/backend`, everything else from the repo root; (2) the two CI workflows and the publish workflow cannot be *executed* locally — the PR itself exercises `backend-ci.yml`/`prediction-ci.yml` (they trigger on `pull_request`); `ghcr-publish.yml` triggers only on push to `main` and is first exercised post-merge — its pre-merge gates are YAML validity + careful review; (3) `yamllint`/`actionlint` are NOT installed on this machine (verified) — YAML validity gate is `python3 -c "import yaml, sys; yaml.safe_load(open(sys.argv[1]))" <file>` (pyyaml verified present) plus a careful field-by-field review note in each workflow step; (4) `./gradlew test` does NOT trigger the frontend `npm` builds (verified: they hook `processResources`, which `test` does not depend on) — no `-x` flags needed anywhere in this plan.
> **Spec:** [`docs/superpowers/specs/2026-07-07-osi-server-ci-ghcr-design.md`](../specs/2026-07-07-osi-server-ci-ghcr-design.md) (approved with touch-ups; §A–§F references point there). **Runway for 1.B4's Testcontainers tests; removes the on-host-build production hazard (DD16).**

**Goal:** Give osi-server its first CI (backend `./gradlew test` on Docker-capable runners — the 1.B4 Testcontainers runway — plus prediction-service `pytest`); lock today's real package boundaries with an ArchUnit test (frozen-baseline cycle rule + two clean directional rules, DD11 as corrected by the spec); add Micrometer/Prometheus metrics behind an admin gate with an explicit JVM heap cap; publish CI-built images to GHCR (`sha-<short>` + `latest`, private, linux/amd64); cut `docker-compose.yml` over from `build:` to `image:` for `backend`/`prediction-service`/`fao-reference-service`; and ship the operator-run rehearsal + production runbooks so the VPS never compiles again.

**Architecture (spec §A–§F):** three GitHub Actions workflows (`backend-ci`, `prediction-ci` on PR+main; `ghcr-publish` on main only, `permissions: {contents: read, packages: write}`); one `ArchitectureTest` in the normal test source set (archunit-junit5; the cycles rule is `FreezingArchRule` over a committed violation store — the spec's exhaustive verification found a 12-package SCC + 15 mutual pairs, so a hand-ignore list is untenable); `micrometer-registry-prometheus` + `management.endpoints.web.exposure.include: health,info,prometheus` + a `SecurityConfig` matcher `/actuator/prometheus → hasRole("ADMIN")` (SUPER_ADMIN carries ROLE_ADMIN too — verified in `UserDetailsServiceImpl`); compose `image:` refs parameterized by `*_IMAGE_TAG` env vars defaulting `latest` (dev-only; live servers pin `sha-<short>` per runbook); a `docker-compose.dev-build.yml` override preserving local `build:` iteration; two runbook documents in `docs/operations/` (rehearsal on the test server gates the production one, which ships gated NOT-READY).

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `setup-java@v4` temurin 21 + gradle cache, `setup-python@v5` 3.11 + pip cache, `docker/setup-buildx-action@v3`, `docker/login-action@v3`, `docker/build-push-action@v5`); ArchUnit `archunit-junit5` 1.4.1 (JUnit 5, existing `useJUnitPlatform()`); Micrometer Prometheus registry (Spring Boot 3.4.3 BOM-managed); Docker Compose; no new runtime frameworks.

## Global Constraints

- **All code changes in osi-server only.** Branch `feat/ci-ghcr-deploys`; commit per task; open a PR at the end; **do not merge it**. Never modify anything under `/home/phil/Repos/osi-os` in this plan.
- **Nothing executes against `osicloud.ch` or `server.opensmartirrigation.org`.** The runbooks written in Task 5 are operator-run documents, not agent tasks. No SSH, no `docker` commands against remote hosts, no secrets of any kind committed or logged (the GHCR PAT is operator-provisioned later, never appears in this plan's execution).
- **No changes to `EdgeSyncService.java`, any Flyway migration, or anything under `db/migration/`** — that is 1.B4's territory. This plan touches no sync-path production code at all; the only main-source Java change is one line in `SecurityConfig.java`.
- **Local gate is `cd backend && ./gradlew test`** — full suite green before the PR (no `-x` flags needed; verified `test` doesn't invoke the frontend builds).
- **Workflow YAML validity**: every workflow file gets a `python3 yaml.safe_load` check (yamllint/actionlint unavailable — verified) + explicit review of action versions, `working-directory`, and secret references before commit.
- **The ArchUnit rules must pass on today's `main` code** (DD11: lock, don't refactor). The temporary rule-bite probes in Task 2 are scratch files that MUST NOT be committed — each probe step ends with deletion + `git status` confirmation.
- `.env.example` gets placeholders only — never a real token, tag values default `latest` with the pin-on-servers warning.

## Non-goals (do not do these)

- No Testcontainers tests, no `sync_dead_letter`, no per-event transactions (1.B4 — landable in either order; this item only guarantees Docker-capable CI).
- No cycle-breaking refactor: the frozen baseline grandfathers the 12-package SCC; do not "fix" any cycle while implementing this plan.
- No multi-arch images, no k8s, no registry HA, no layered-jar Dockerfile rewrite (spec §D keeps single-jar `COPY` for the first cut; only *confirm* `layers.idx` exists).
- No frontend (React/Terra) CI job; no Caddy config change; no `mosquitto`/`prediction-validation` compose conversion; no GPU `docker-compose.vps.yml` conversion (all explicitly deferred in spec §A/§C/§E).
- No `osi-os` `migrations.yml` mirroring (op-parity stays one-sided, spec §A).
- No edits to `docs/architecture/refactor-program-2026.md` (the DD11 charter correction is handled by the coordinator).

## File Structure (paths relative to `/home/phil/Repos/osi-server` unless noted)

- Create: `.github/workflows/backend-ci.yml`, `.github/workflows/prediction-ci.yml` (Task 1)
- Modify: `backend/build.gradle.kts`; Create: `backend/src/test/resources/archunit.properties`, `backend/src/test/java/org/osi/server/ArchitectureTest.java`, `backend/src/test/resources/archunit-store/` (generated + committed) (Task 2)
- Modify: `backend/build.gradle.kts`, `backend/src/main/resources/application.yml`, `backend/src/main/java/org/osi/server/config/SecurityConfig.java`, `docker/docker-compose.yml` (JAVA_TOOL_OPTIONS); Create: `backend/src/test/java/org/osi/server/config/ActuatorSecurityTest.java` (Task 3)
- Create: `.github/workflows/ghcr-publish.yml` (Task 4)
- Modify: `docker/docker-compose.yml` (build→image), `.env.example`; Create: `docker/docker-compose.dev-build.yml`, `docs/operations/ghcr-pull-deploy-rehearsal.md`, `docs/operations/ghcr-pull-deploy-production.md` (Task 5)
- Task 6: full gate + PR (no new files)

**Task-cut note:** identical to the suggested T1–T6 cut. Two internal adjustments, both justified: (a) the ArchUnit cycle rule uses `FreezingArchRule` + committed store instead of the originally suggested six-pair ignore list — the spec's exhaustive re-verification found 15 mutual pairs and a 12-package SCC, so a hand-ignore list cannot be made correct (spec §B corrected accordingly; reported upward as a spec mismatch); (b) Task 2's TDD "red" is a pair of deliberate, uncommitted scratch violations (one per rule family) since the rules must pass on today's code — the red proves the rules bite, the scratch files are deleted before commit, per the coordinator's explicit ask to decide and state this.

---

### Task 1: CI first — `backend-ci.yml` + `prediction-ci.yml`

CI lands first so every later commit in this PR is gated by it (the workflows run on the PR itself via the `pull_request` trigger).

**Files:**
- Create: `.github/workflows/backend-ci.yml`
- Create: `.github/workflows/prediction-ci.yml`

**Interfaces:**
- Produces: PR + main gating for `./gradlew test` (JDK 21 temurin, gradle cache, Docker-capable `ubuntu-latest` — **the 1.B4 Testcontainers runway**: `@Testcontainers` ITs manage their own Postgres 16 container against the runner's pre-installed Docker daemon, no service-container YAML needed) and for `pytest` (Python 3.11 matching `docker/prediction-service/Dockerfile`'s `python:3.11-slim` base — verified).
- Torch note (verified): `prediction-service/requirements.txt` pins `torch==2.5.1+cpu`, which resolves **only** with the PyTorch CPU index — the workflow must set `PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cpu`, mirroring the Dockerfile's `PYTORCH_CPU_INDEX_URL` arg, or the install fails. Pip caching keeps the ~200 MB wheel from re-downloading every run.

- [ ] **Step 1.1: Create the branch**

```bash
cd /home/phil/Repos/osi-server && git checkout main && git pull --ff-only && git checkout -b feat/ci-ghcr-deploys
```

- [ ] **Step 1.2: Write `backend-ci.yml`** — create `.github/workflows/backend-ci.yml` with exactly:

```yaml
name: Backend CI
on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]
jobs:
  backend:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: gradle
      # Docker is pre-installed and running on ubuntu-latest — this job is the
      # 1.B4 Testcontainers runway: @Testcontainers integration tests manage
      # their own Postgres 16 container against the runner's Docker daemon.
      # No service-container YAML is needed now or when 1.B4 lands.
      #
      # ./gradlew test deliberately has NO -x flags: the two frontend npm
      # builds hook processResources, which the test task does not depend on
      # (verified in the 1.B3 spec, "Verified ground truth" item 5).
      - name: Backend tests (unit + ArchUnit; Testcontainers ITs once 1.B4 lands)
        working-directory: backend
        run: ./gradlew test --no-daemon
```

- [ ] **Step 1.3: Write `prediction-ci.yml`** — create `.github/workflows/prediction-ci.yml` with exactly:

```yaml
name: Prediction Service CI
on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]
jobs:
  pytest:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    defaults:
      run:
        working-directory: prediction-service
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-python@v5
        with:
          # Matches docker/prediction-service/Dockerfile: FROM python:3.11-slim
          python-version: '3.11'
          cache: pip
          cache-dependency-path: prediction-service/requirements.txt
      # PIP_EXTRA_INDEX_URL mirrors the Dockerfile's PYTORCH_CPU_INDEX_URL:
      # torch==2.5.1+cpu resolves only from the PyTorch CPU index, not PyPI.
      - name: Install dependencies
        run: PIP_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cpu pip install -r requirements.txt
      - name: Run tests
        run: pytest
```

- [ ] **Step 1.4: YAML validity gate**

Run: `cd /home/phil/Repos/osi-server && for f in .github/workflows/backend-ci.yml .github/workflows/prediction-ci.yml; do python3 -c "import yaml, sys; yaml.safe_load(open(sys.argv[1])); print(sys.argv[1], 'OK')" "$f"; done`
Expected: both files print `OK`. Then review by eye against this plan: action versions (`checkout@v4`, `setup-java@v4`, `setup-python@v5`), `working-directory` values, no secret references in either file.

- [ ] **Step 1.5: Prove the exact CI command is green locally (pre-existing suite)**

Run: `cd /home/phil/Repos/osi-server/backend && ./gradlew test --no-daemon`
Expected: `BUILD SUCCESSFUL`, no frontend/npm output anywhere in the log (confirms the no-`-x` decision), all existing tests pass. If npm output appears, STOP — the spec's ground-truth item 5 is wrong and the workflow needs `-x` exclusions plus a Node setup step; report before proceeding.

- [ ] **Step 1.6: Commit**

```bash
cd /home/phil/Repos/osi-server
git add .github/workflows/backend-ci.yml .github/workflows/prediction-ci.yml
git commit -m "ci: first CI for osi-server — backend gradle test (Docker-capable, 1.B4 runway) + prediction pytest (1.B3)"
```

---

### Task 2: `ArchitectureTest` — frozen cycle baseline + two clean directional rules (DD11 as corrected)

The rules must PASS on today's code — that is the point (lock, don't refactor). TDD shape, as decided: green-first for the committed state, then **two deliberate, uncommitted scratch violations prove each rule family actually bites** (red), then deletion restores green. The frozen store's creation is itself verified by a run-twice + flip-`allowStoreCreation` sequence.

**Files:**
- Modify: `backend/build.gradle.kts`
- Create: `backend/src/test/resources/archunit.properties`
- Create: `backend/src/test/java/org/osi/server/ArchitectureTest.java`
- Create (generated by first run, then committed): `backend/src/test/resources/archunit-store/`

**Interfaces:**
- Produces: three `@ArchTest` rules running inside plain `./gradlew test` (no new Gradle task, no separate CI step): (1) `noNewPackageCycles` — `slices` cycle rule wrapped in `FreezingArchRule` over a committed baseline store grandfathering the verified cyclic core (12-package SCC + `analysis↔history` + `retention↔sync`); (2) `analyticsMustNotDependOnSync` — the direction that is actually true today (verified: zero `sync` imports under `analytics/`); (3) `controllersOnlyInControllerClasses` — verified passing (`GlobalExceptionHandler` is `@RestControllerAdvice`, not matched).
- Freeze semantics (spec §B): new cycle-participating dependencies fail, including ones that grow a grandfathered cycle (DD3 "may only decrease" spirit); fixed violations auto-shrink the store; the escape hatch for an intentionally accepted violation is a reviewed store-file edit in the same PR.

- [ ] **Step 2.1: Add the ArchUnit dependency** — in `backend/build.gradle.kts`, in the `// Testing` block after `testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")`, add:

```kotlin
    // ArchUnit boundary tests (1.B3/DD11) — not BOM-managed, explicit version
    testImplementation("com.tngtech.archunit:archunit-junit5:1.4.1")
```

- [ ] **Step 2.2: Configure the freeze store** — create `backend/src/test/resources/archunit.properties` with exactly:

```properties
# FreezingArchRule violation store (1.B3/DD11): committed baseline of the
# pre-existing package-cycle core — 15 mutual pairs, one 12-package SCC, plus
# analysis<->history and retention<->sync. See the spec's "Contradiction"
# section (2026-07-07-osi-server-ci-ghcr-design.md) for the verified graph.
# Path is relative to the Gradle test working directory (backend/).
freeze.store.default.path=src/test/resources/archunit-store
# true ONLY for initial store creation (plan Task 2); flipped to false in the
# same task so a deleted/missing store fails loudly instead of silently
# re-freezing the current state.
freeze.store.default.allowStoreCreation=true
```

- [ ] **Step 2.3: Write the test** — create `backend/src/test/java/org/osi/server/ArchitectureTest.java` with exactly:

```java
package org.osi.server;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RestController;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;
import static com.tngtech.archunit.library.freeze.FreezingArchRule.freeze;

/**
 * DD11 boundary lock (refactor-program 1.B3): rules that pass on TODAY's main —
 * they lock existing boundaries before the DD12 EdgeSyncService split, they do
 * not refactor. Spec: osi-os docs/superpowers/specs/2026-07-07-osi-server-ci-ghcr-design.md §B.
 *
 * Rule 1 is a FreezingArchRule: the committed violation store under
 * src/test/resources/archunit-store/ grandfathers the pre-existing cyclic core
 * (verified exhaustively in the spec: a 12-package SCC — analytics, command,
 * device, gateway, mqtt, prediction, security, soil, telemetry, user,
 * websocket, zone — plus analysis<->history and retention<->sync; only
 * chameleon, channels, config are cycle-free). Any NEW cycle-participating
 * dependency fails; fixed ones auto-shrink the store (ratchet). To accept a
 * new violation deliberately, edit the store file in a reviewed PR.
 *
 * DD11's original example rule ("sync must not depend on analytics") is FALSE
 * today (EdgeSyncService imports 13 analytics classes) — rule 2 asserts the
 * direction that is actually true and that the DD12 split must preserve.
 */
@AnalyzeClasses(packages = "org.osi.server", importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    @ArchTest
    static final ArchRule noNewPackageCycles = freeze(
            slices().matching("org.osi.server.(*)..").namingSlices("$1")
                    .should().beFreeOfCycles()
                    .because("new cross-package cycles (or growth of frozen ones) must not merge; "
                            + "the committed archunit-store is the grandfathered baseline (1.B3/DD11)"));

    @ArchTest
    static final ArchRule analyticsMustNotDependOnSync = noClasses()
            .that().resideInAPackage("org.osi.server.analytics..")
            .should().dependOnClassesThat().resideInAPackage("org.osi.server.sync..")
            .because("analytics must never reach back into sync (verified true today; "
                    + "the reverse direction is the known, DD12-ticketed coupling)");

    @ArchTest
    static final ArchRule controllersOnlyInControllerClasses = classes()
            .that().areAnnotatedWith(RestController.class)
            .or().areAnnotatedWith(Controller.class)
            .should().haveSimpleNameEndingWith("Controller")
            .because("web entry points must be findable by name "
                    + "(@RestControllerAdvice, e.g. GlobalExceptionHandler, is deliberately not matched)");
}
```

- [ ] **Step 2.4: First run — creates the frozen store (green)**

Run: `cd /home/phil/Repos/osi-server/backend && ./gradlew test --no-daemon --tests 'org.osi.server.ArchitectureTest'`
Expected: `BUILD SUCCESSFUL`, 3 rules pass. The run CREATES `src/test/resources/archunit-store/` containing `stored.rules` plus one violation file for the frozen cycle rule. Verify: `ls src/test/resources/archunit-store/ && wc -l src/test/resources/archunit-store/*`. The violation file will be large (it enumerates the class-level dependencies of every detected cycle in the 12-package core — ArchUnit caps detection at 100 cycles by default); that is expected and is the committed baseline, exactly like a ratchet scoreboard file.
If instead `analyticsMustNotDependOnSync` or `controllersOnlyInControllerClasses` FAILS: the spec's verification missed something — STOP and report the exact violation text upward; do not freeze or weaken those two rules unilaterally.

- [ ] **Step 2.5: Flip store creation off and prove the committed store is read**

In `backend/src/test/resources/archunit.properties`, change `freeze.store.default.allowStoreCreation=true` → `freeze.store.default.allowStoreCreation=false`.
Run: `./gradlew test --no-daemon --tests 'org.osi.server.ArchitectureTest'`
Expected: still `BUILD SUCCESSFUL` — the rule now reads the committed store and would fail loudly if the store were missing (the silent-refreeze hazard the spec §B names).

- [ ] **Step 2.6: Rule-bite proof A — directional rule (scratch, DO NOT COMMIT)**

Create `backend/src/main/java/org/osi/server/analytics/TempArchProbe.java` with exactly:

```java
package org.osi.server.analytics;

/** TEMPORARY ArchUnit bite-proof — MUST NOT BE COMMITTED (plan Task 2, Step 2.6). */
class TempArchProbe {
    private org.osi.server.sync.SyncInboxRepository probe;
}
```

Run: `./gradlew test --no-daemon --tests 'org.osi.server.ArchitectureTest'`
Expected: FAIL — `analyticsMustNotDependOnSync` reports `TempArchProbe` depending on `SyncInboxRepository`. This is the red that proves the rule bites.
Then: `rm src/main/java/org/osi/server/analytics/TempArchProbe.java` and re-run.
Expected: PASS again.

- [ ] **Step 2.7: Rule-bite proof B — frozen cycle rule catches a NEW cycle (scratch, DO NOT COMMIT)**

The probe builds a brand-new 2-cycle between the two cycle-free packages `channels` and `chameleon` — guaranteed absent from the frozen baseline. Create both files:

`backend/src/main/java/org/osi/server/channels/TempCycleProbeA.java`:
```java
package org.osi.server.channels;

/** TEMPORARY ArchUnit bite-proof — MUST NOT BE COMMITTED (plan Task 2, Step 2.7). */
class TempCycleProbeA {
    private org.osi.server.chameleon.ChameleonCalibrationsService probe;
}
```

`backend/src/main/java/org/osi/server/chameleon/TempCycleProbeB.java`:
```java
package org.osi.server.chameleon;

/** TEMPORARY ArchUnit bite-proof — MUST NOT BE COMMITTED (plan Task 2, Step 2.7). */
class TempCycleProbeB {
    private org.osi.server.channels.ChannelManifest probe;
}
```

Run: `./gradlew test --no-daemon --tests 'org.osi.server.ArchitectureTest'`
Expected: FAIL — `noNewPackageCycles` reports a cycle `channels -> chameleon -> channels` NOT covered by the frozen store. This proves freeze grandfathers only the baseline, not new cycles.
Then: `rm src/main/java/org/osi/server/channels/TempCycleProbeA.java src/main/java/org/osi/server/chameleon/TempCycleProbeB.java` and re-run.
Expected: PASS. Confirm no probe remnants: `git status --short` must show only the intended Task 2 files (build.gradle.kts, archunit.properties, ArchitectureTest.java, archunit-store/).

- [ ] **Step 2.8: Full suite + commit (store files included)**

Run: `./gradlew test --no-daemon`
Expected: `BUILD SUCCESSFUL` — ArchitectureTest passes alongside the whole existing suite.

```bash
cd /home/phil/Repos/osi-server
git add backend/build.gradle.kts backend/src/test/resources/archunit.properties \
        backend/src/test/resources/archunit-store/ \
        backend/src/test/java/org/osi/server/ArchitectureTest.java
git commit -m "test(arch): ArchUnit boundary lock — frozen cycle baseline (12-pkg SCC grandfathered), analytics!->sync, controller naming (1.B3/DD11)"
```

---

### Task 3: Micrometer/Prometheus + admin gate + JVM heap cap

**Files:**
- Modify: `backend/build.gradle.kts`
- Modify: `backend/src/main/resources/application.yml`
- Modify: `backend/src/main/java/org/osi/server/config/SecurityConfig.java`
- Modify: `docker/docker-compose.yml` (JAVA_TOOL_OPTIONS only — the build→image cutover is Task 5)
- Create: `backend/src/test/java/org/osi/server/config/ActuatorSecurityTest.java`

**Interfaces:**
- Produces: `/actuator/prometheus` (Micrometer Prometheus registry, BOM-managed version) gated `hasRole("ADMIN")` — matching the existing `/api/v1/admin/**` matcher precedent in `SecurityConfig`; verified safe for super-admins because `UserDetailsServiceImpl` grants `ROLE_ADMIN` to every `SUPER_ADMIN` user. `/actuator/health` stays `permitAll`, `show-details: when-authorized` untouched.
- TDD note: the distinguishing red test is the **authenticated non-admin** case — before the matcher, `/actuator/prometheus` falls through to `anyRequest().authenticated()`, so an authenticated `USER` passes authorization (404 in the MVC slice); after the matcher they get 403. The unauthenticated and admin cases pass both before and after (documented, not load-bearing for red/green).
- Honest limits: the `@WebMvcTest` slice proves the *security chain*, not the endpoint's existence — actuator endpoints aren't part of the MVC slice. The `management.endpoints.web.exposure.include` change and the registry dependency are exercised at boot; their runtime verification is a named post-check in the Task 5 rehearsal runbook (`docker exec osi-backend curl -s -o /dev/null -w '%{http_code}' localhost:8080/actuator/prometheus` → 401/403 without auth; 200 with an admin JWT).

- [ ] **Step 3.1: Write the failing security test** — create `backend/src/test/java/org/osi/server/config/ActuatorSecurityTest.java` with exactly (mirrors `SpaControllerSecurityTest`'s slice pattern verbatim — same imports, same jwt test properties):

```java
package org.osi.server.config;

import org.junit.jupiter.api.Test;
import org.osi.server.security.JwtAuthenticationFilter;
import org.osi.server.security.JwtTokenProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.context.annotation.Import;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Security-chain test for the /actuator/prometheus admin gate (1.B3 spec §C).
 * Actuator endpoints are not part of the @WebMvcTest slice, but the
 * SecurityFilterChain matchers apply to every request URI: an authorization
 * PASS surfaces as 404 (no handler in the slice), a DENY as 403.
 */
@WebMvcTest(controllers = SpaController.class)
@Import({SecurityConfig.class, JwtAuthenticationFilter.class, JwtTokenProvider.class})
@TestPropertySource(properties = {
        "jwt.secret=0123456789012345678901234567890123456789012345678901234567890123",
        "jwt.expiration-ms=3600000",
        "jwt.sync-expiration-ms=3600000"
})
class ActuatorSecurityTest {

    @Autowired
    MockMvc mvc;

    @MockBean
    UserDetailsService userDetailsService;

    @Test
    void prometheusIsDeniedWithoutAuthentication() throws Exception {
        mvc.perform(get("/actuator/prometheus"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(roles = "USER")
    void prometheusIsDeniedForAuthenticatedNonAdmins() throws Exception {
        // THE red test: before the SecurityConfig matcher this request fell
        // through to anyRequest().authenticated() and passed authorization (404).
        mvc.perform(get("/actuator/prometheus"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(roles = "ADMIN")
    void prometheusPassesAuthorizationForAdmins() throws Exception {
        // 404 = authorization passed; the actuator endpoint isn't in the MVC slice.
        // SUPER_ADMIN also passes: UserDetailsServiceImpl grants ROLE_ADMIN to it.
        mvc.perform(get("/actuator/prometheus"))
                .andExpect(status().isNotFound());
    }

    @Test
    void healthStaysPublic() throws Exception {
        mvc.perform(get("/actuator/health"))
                .andExpect(status().isNotFound()); // permitAll -> reaches MVC (no handler in slice)
    }
}
```

Run: `cd /home/phil/Repos/osi-server/backend && ./gradlew test --no-daemon --tests 'org.osi.server.config.ActuatorSecurityTest'`
Expected: FAIL — `prometheusIsDeniedForAuthenticatedNonAdmins` gets 404 (authorization passed under `anyRequest().authenticated()`), expected 403. The other three pass. (If `prometheusIsDeniedWithoutAuthentication` observes 401 instead of 403, an entry point is configured somewhere unverified — pin the assertion to the observed 401 and note it in the commit message; both statuses prove denial.)

- [ ] **Step 3.2: Add the Micrometer registry** — in `backend/build.gradle.kts`, after `implementation("org.springframework.boot:spring-boot-starter-actuator")`, add:

```kotlin
    implementation("io.micrometer:micrometer-registry-prometheus")
```

- [ ] **Step 3.3: Expose the endpoint** — in `backend/src/main/resources/application.yml`, in the `management:` block, change:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info
```
to:
```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
```
(`management.endpoint.health.show-details: when-authorized` stays untouched.)

- [ ] **Step 3.4: Gate it** — in `backend/src/main/java/org/osi/server/config/SecurityConfig.java`, immediately after the line `.requestMatchers("/actuator/health").permitAll()`, add:

```java
                    // Micrometer scrape endpoint (1.B3 spec §C): never public.
                    // hasRole("ADMIN") covers SUPER_ADMIN too — UserDetailsServiceImpl
                    // grants ROLE_ADMIN to SUPER_ADMIN users. Matches the
                    // /api/v1/admin/** precedent below.
                    .requestMatchers("/actuator/prometheus").hasRole("ADMIN")
```

Run: `./gradlew test --no-daemon --tests 'org.osi.server.config.ActuatorSecurityTest'`
Expected: PASS — all 4 tests green.

- [ ] **Step 3.5: Heap cap in compose** — in `docker/docker-compose.yml`, `backend` service `environment:` block, change:

```yaml
      JAVA_TOOL_OPTIONS: "-Dosi.rate-limit.trusted-proxies=10.0.0.0/8,172.16.0.0/12"
```
to:
```yaml
      # -Xmx768m: 1.B3 spec §C — low end of the expert's 768m–1g range because six
      # other containers (Postgres, Mongo, Mosquitto, openagri, 2x prediction) share
      # the 4 GB host. Watch jvm_memory_used_bytes via /actuator/prometheus; revise
      # with evidence, not guesses.
      JAVA_TOOL_OPTIONS: "-Dosi.rate-limit.trusted-proxies=10.0.0.0/8,172.16.0.0/12 -Xmx768m"
```

Gate: `cd /home/phil/Repos/osi-server/docker && docker compose config > /dev/null && echo COMPOSE-OK`
Expected: `COMPOSE-OK` (interpolation + syntax valid; the external `caddy-net` is declared, not resolved, by `config`).

- [ ] **Step 3.6: Full suite + commit**

Run: `cd /home/phil/Repos/osi-server/backend && ./gradlew test --no-daemon`
Expected: `BUILD SUCCESSFUL`.

```bash
cd /home/phil/Repos/osi-server
git add backend/build.gradle.kts backend/src/main/resources/application.yml \
        backend/src/main/java/org/osi/server/config/SecurityConfig.java \
        backend/src/test/java/org/osi/server/config/ActuatorSecurityTest.java \
        docker/docker-compose.yml
git commit -m "feat(metrics): Micrometer Prometheus endpoint (admin-gated) + -Xmx768m heap cap (1.B3 spec C)"
```

---

### Task 4: `ghcr-publish.yml` — CI-built images to GHCR

**Files:**
- Create: `.github/workflows/ghcr-publish.yml`

**Interfaces:**
- Produces: on every push to `main`, three private `linux/amd64` images in `ghcr.io/open-smart-irrigation/` (names hardcoded lowercase — GHCR requires lowercase and `github.repository_owner` is mixed-case `Open-Smart-Irrigation`): `osi-server-backend` (from `docker/backend/Dockerfile`), `osi-server-prediction` (`runtime` target), `osi-server-fao-reference` (`fao-runtime` target), each tagged `sha-<short7>` (immutable, the only tag runbooks reference) + `latest` (dev convenience only).
- `permissions: {contents: read, packages: write}` is explicit (coordinator touch-up 2): `GITHUB_TOKEN` default permissions can be read-only per org settings, and the first push also creates the package namespace.
- `VITE_MAPBOX_TOKEN` build arg comes from a **repo secret of the same name** — the operator must create it in the osi-server repo settings before the first main build (noted in the PR body; an empty secret produces the same empty-token build as today's `.env` default, so a missing secret degrades identically to current behavior, it does not break the build).
- Not executable pre-merge (push-to-main trigger only). Pre-merge gates: YAML validity + field review. First-run verification happens on the merge commit — named in the PR body as an operator/coordinator follow-up, honest about what this plan cannot itself prove.

- [ ] **Step 4.1: Write the workflow** — create `.github/workflows/ghcr-publish.yml` with exactly:

```yaml
name: GHCR Publish
on:
  push:
    branches: [ main ]
# Explicit because GITHUB_TOKEN's default permissions can be read-only
# depending on org settings; packages:write is also what creates the
# package namespace on the very first push (1.B3 spec D).
permissions:
  contents: read
  packages: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Compute short SHA tag
        id: sha
        run: echo "short=$(git rev-parse --short=7 HEAD)" >> "$GITHUB_OUTPUT"
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      # Image names are hardcoded lowercase: GHCR requires lowercase and the
      # org slug (Open-Smart-Irrigation) is mixed-case. Single-arch amd64 per
      # spec (multi-arch is YAGNI; VPS arch operator-confirmed in the runbook).
      - name: Build and push backend
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/backend/Dockerfile
          platforms: linux/amd64
          push: true
          build-args: |
            VITE_MAPBOX_TOKEN=${{ secrets.VITE_MAPBOX_TOKEN }}
          tags: |
            ghcr.io/open-smart-irrigation/osi-server-backend:sha-${{ steps.sha.outputs.short }}
            ghcr.io/open-smart-irrigation/osi-server-backend:latest
      - name: Build and push prediction-service (runtime)
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/prediction-service/Dockerfile
          target: runtime
          platforms: linux/amd64
          push: true
          tags: |
            ghcr.io/open-smart-irrigation/osi-server-prediction:sha-${{ steps.sha.outputs.short }}
            ghcr.io/open-smart-irrigation/osi-server-prediction:latest
      - name: Build and push fao-reference-service (fao-runtime)
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/prediction-service/Dockerfile
          target: fao-runtime
          platforms: linux/amd64
          push: true
          tags: |
            ghcr.io/open-smart-irrigation/osi-server-fao-reference:sha-${{ steps.sha.outputs.short }}
            ghcr.io/open-smart-irrigation/osi-server-fao-reference:latest
```

- [ ] **Step 4.2: YAML validity + review gate**

Run: `cd /home/phil/Repos/osi-server && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ghcr-publish.yml')); print('OK')"`
Expected: `OK`. Then review by eye: the `permissions` block is present at workflow level; the three `file`/`target` pairs match `docker/docker-compose.yml`'s current `build:` blocks exactly (backend: `docker/backend/Dockerfile`, no target; prediction: `docker/prediction-service/Dockerfile` target `runtime`; fao: same file, target `fao-runtime`); all tags lowercase.

- [ ] **Step 4.3 (optional, heavy): local image-build smoke** — only if local time/bandwidth allows; NOT a required gate (the Gradle+2×Vite build in Docker takes many minutes and downloads dependencies):

Run: `cd /home/phil/Repos/osi-server && docker build -f docker/prediction-service/Dockerfile --target runtime -t local-smoke-prediction . && docker rmi local-smoke-prediction`
Expected: successful build (the cheaper of the images; proves Dockerfile paths from repo-root context, which is what CI will use). Skipping this step is acceptable — record skipped/done.

- [ ] **Step 4.4: Commit**

```bash
cd /home/phil/Repos/osi-server
git add .github/workflows/ghcr-publish.yml
git commit -m "ci: GHCR publish on main — backend + prediction + fao images, sha-<short> + latest, amd64, private (1.B3/DD16)"
```

---

### Task 5: Compose cutover + `.env.example` + dev-build override + the two runbooks

**Files:**
- Modify: `docker/docker-compose.yml` (three `build:` → `image:`)
- Modify: `.env.example`
- Create: `docker/docker-compose.dev-build.yml`
- Create: `docs/operations/ghcr-pull-deploy-rehearsal.md`
- Create: `docs/operations/ghcr-pull-deploy-production.md`

**Interfaces:**
- The dev-build override decision (spec §E deferred it; coordinator offered either path): **INCLUDED** — it is ~20 lines, removes the "local dev can no longer `docker compose up` from source" footgun entirely, and keeps the PR body free of a deferral caveat.
- Runbooks live in **osi-server** `docs/operations/` (new directory; osi-server's `docs/` has `agents/`, `architecture/`, `prediction/`, `sync/` — operations is the natural sibling, and the runbooks version together with the compose files they operate). They are **operator-run documents**; nothing in this plan executes them.
- Spec-reconciliation note (state in the PR body too): spec §F says the production runbook is written only after rehearsal passes; per coordinator direction both documents ship now, with the production one carrying an explicit NOT-READY gate banner tied to the rehearsal record — honoring the spec's intent ("not written down as *ready*") while making the full procedure reviewable in one PR.

- [ ] **Step 5.1: Compose cutover** — in `docker/docker-compose.yml`:

(a) Replace the `backend` service's `build:` block:
```yaml
    build:
      context: ..                          # Repo root — gives access to both backend/ and frontend/
      dockerfile: docker/backend/Dockerfile
      args:
        VITE_MAPBOX_TOKEN: ${VITE_MAPBOX_TOKEN:-}
```
with:
```yaml
    # 1.B3/DD16: image built in CI (ghcr-publish.yml), pulled — never built — here.
    # Live servers MUST pin BACKEND_IMAGE_TAG to an immutable sha-<short> in .env
    # (latest is dev-only). Local from-source iteration: docker-compose.dev-build.yml.
    image: ghcr.io/open-smart-irrigation/osi-server-backend:${BACKEND_IMAGE_TAG:-latest}
```

(b) Replace the `prediction-service` service's `build:` block (`context: ..` / `dockerfile: docker/prediction-service/Dockerfile` / `target: runtime`) with:
```yaml
    image: ghcr.io/open-smart-irrigation/osi-server-prediction:${PREDICTION_IMAGE_TAG:-latest}
```

(c) Replace the `fao-reference-service` service's `build:` block (same file, `target: fao-runtime`) with:
```yaml
    image: ghcr.io/open-smart-irrigation/osi-server-fao-reference:${FAO_IMAGE_TAG:-latest}
```

(d) **Leave `mosquitto` and `prediction-validation` `build:` blocks untouched** (spec §E: trivial Alpine layer / profile-gated one-shot harness — both explicitly deferred with rationale).

- [ ] **Step 5.2: Dev-build override** — create `docker/docker-compose.dev-build.yml` with exactly:

```yaml
# Local development ONLY — restores from-source builds for the three services
# that moved to GHCR images (1.B3/DD16). NEVER use on a live server: the whole
# point of the cutover is that deploy hosts never compile.
#
#   docker compose -f docker-compose.yml -f docker-compose.dev-build.yml up -d --build
services:
  backend:
    build:
      context: ..
      dockerfile: docker/backend/Dockerfile
      args:
        VITE_MAPBOX_TOKEN: ${VITE_MAPBOX_TOKEN:-}
    image: ghcr.io/open-smart-irrigation/osi-server-backend:dev-local
  prediction-service:
    build:
      context: ..
      dockerfile: docker/prediction-service/Dockerfile
      target: runtime
    image: ghcr.io/open-smart-irrigation/osi-server-prediction:dev-local
  fao-reference-service:
    build:
      context: ..
      dockerfile: docker/prediction-service/Dockerfile
      target: fao-runtime
    image: ghcr.io/open-smart-irrigation/osi-server-fao-reference:dev-local
```

- [ ] **Step 5.3: `.env.example`** — two edits:

(a) Replace the `VITE_MAPBOX_TOKEN` comment block:
```
# Terra Intelligence frontend build
# Required when building the backend Docker image because Terra is compiled by Vite.
VITE_MAPBOX_TOKEN=
```
with:
```
# Terra Intelligence frontend build (Vite). Backend images are built in CI
# (repo secret VITE_MAPBOX_TOKEN feeds ghcr-publish.yml); this .env value is
# used only for local from-source builds via docker-compose.dev-build.yml.
VITE_MAPBOX_TOKEN=
```

(b) Append after that block:
```
# ── GHCR pull-only deploys (refactor-program 1.B3 / DD16) ────────────────────
# Images are built in CI and pulled from ghcr.io — deploy hosts never compile.
# On ANY live server, PIN all three tags to an immutable sha-<short> from the
# GHCR package page (see docs/operations/ghcr-pull-deploy-*.md). `latest` is a
# dev convenience ONLY: a server left on `latest` silently drifts on the next
# `docker compose pull`.
BACKEND_IMAGE_TAG=latest
PREDICTION_IMAGE_TAG=latest
FAO_IMAGE_TAG=latest
# GHCR pull credential: a read-only PAT (classic `read:packages` only, or a
# fine-grained package-read token), generated by the operator, set ONLY on the
# deploy host, and used once for `docker login ghcr.io`. It is NOT read by
# compose. NEVER commit a real value to any repo file.
# GHCR_PULL_TOKEN=
```

- [ ] **Step 5.4: Compose validity gates**

Run:
```bash
cd /home/phil/Repos/osi-server/docker
docker compose config > /dev/null && echo BASE-OK
docker compose -f docker-compose.yml -f docker-compose.dev-build.yml config > /dev/null && echo DEVBUILD-OK
docker compose config | grep -c 'image: ghcr.io/open-smart-irrigation'
```
Expected: `BASE-OK`, `DEVBUILD-OK`, and the grep prints `3` (backend, prediction, fao on GHCR images; mosquitto/prediction-validation still `build:`-only — note `prediction-validation` is profile-gated so it does not appear in plain `config` output; that is expected).

- [ ] **Step 5.5: Rehearsal runbook (operator-run document)** — create `docs/operations/ghcr-pull-deploy-rehearsal.md` with exactly:

```markdown
# GHCR Pull-Only Deploy — TEST-SERVER Rehearsal Runbook (1.B3)

**Host:** `server.opensmartirrigation.org` (test server) — NEVER `osicloud.ch`.
**Executor:** the operator (Phil), by hand. No agent runs any step here.
**Purpose:** prove pull-based deploy AND rollback-to-previous-tag before the
production runbook (`ghcr-pull-deploy-production.md`) may be declared ready
(refactor-program risk line: "rehearse pull-based deploy + rollback on the
test server before removing the on-host build path").

## Prerequisites
- [ ] The 1.B3 PR is merged and `ghcr-publish.yml` has completed at least TWO
      runs on `main` (two distinct `sha-<short>` tags exist — needed for the
      rollback rehearsal). Record both tags here: ______ / ______
- [ ] Repo secret `VITE_MAPBOX_TOKEN` was set in osi-server settings BEFORE
      those runs (else Terra ships without a map token — same as an empty
      `.env` value today, not fatal, but note it).
- [ ] GHCR pull PAT generated (read:packages ONLY; never committed anywhere).
- [ ] Architecture check: `uname -m` on the test server → expected `x86_64`.
      If NOT x86_64, STOP: the images are linux/amd64 single-arch (spec §D);
      report before proceeding.
- [ ] No auto-prune on the host: `crontab -l` and `systemctl list-timers` show
      no `docker image prune`/`docker system prune` (rollback depends on the
      previous image staying local).
- [ ] Backup per AGENTS.md: timestamped `/home/rocky/backups/osi-server-<ts>`
      covering repo snapshot, Docker env/config, PostgreSQL dump, Mosquitto
      state, OpenAgri data.

## Deploy rehearsal
1. `docker login ghcr.io -u <github-username>` (paste the PAT when prompted —
   do not put it on the command line).
2. Pull the repo state containing this runbook's compose cutover (git pull /
   bundle per AGENTS.md), so `docker-compose.yml` uses `image:` refs.
3. **Pin tags** in `.env` (MANDATORY — `latest` is dev-only):
   `BACKEND_IMAGE_TAG=sha-<newest>`, `PREDICTION_IMAGE_TAG=sha-<newest>`,
   `FAO_IMAGE_TAG=sha-<newest>`.
4. `cd docker && docker compose pull backend prediction-service fao-reference-service`
5. `docker compose up -d --no-deps backend prediction-service fao-reference-service`
6. Post-checks (all must pass):
   - `docker exec osi-backend curl -s -o /dev/null -w '%{http_code}' localhost:8080/actuator/health` → `200`
   - `docker exec osi-backend curl -s -o /dev/null -w '%{http_code}' localhost:8080/actuator/prometheus` → `401` or `403` (gated, NOT 200 or 404)
   - `/actuator/prometheus` WITH an admin JWT → `200`, body contains `jvm_memory_used_bytes`
   - a demo gateway's sync events still apply (fresh rows / heartbeat within
     ~2 min — same smoke check as previous test-server rollouts)
   - `docker exec osi-backend java -XX:+PrintFlagsFinal -version 2>/dev/null | grep MaxHeapSize`
     reflects the 768m cap (or check startup log line)
   - `docker images | grep osi-server-backend` still lists the PREVIOUS tag

## Rollback rehearsal (deliberate — this is the point)
7. Set `.env` tags back to the PREVIOUS `sha-<short>`; run
   `docker compose up -d --no-deps backend prediction-service fao-reference-service`
   (no pull needed — the image is local). Re-run post-check 6's health lines.
8. Roll forward again to the newest tag the same way.

## Record (fill in — gates the production runbook)
- Date/operator: ______
- Deployed tag / rolled-back-to tag: ______ / ______
- All post-checks green: YES / NO (if NO: what failed, and the production
  runbook stays NOT READY)
```

- [ ] **Step 5.6: Production runbook (gated, operator-run document)** — create `docs/operations/ghcr-pull-deploy-production.md` with exactly:

```markdown
# GHCR Pull-Only Deploy — PRODUCTION Runbook (1.B3)

> **STATUS: NOT READY — HARD GATE.** Do not execute ANY step until the
> rehearsal record at the bottom of `ghcr-pull-deploy-rehearsal.md` is filled
> in with all post-checks green. Per the 1.B3 spec §F this document only
> becomes "ready" through that record; until then it exists for review only.
>
> **Access policy:** `osicloud.ch` is restricted production. Executor is the
> operator (Phil), by hand, with explicit intent — never an agent, never
> automation, per the standing policy in AGENTS.md.

## Pre-flight
- [ ] Rehearsal record complete and green (see gate above).
- [ ] `uname -m` on the production VPS → `x86_64` confirmed (images are
      linux/amd64 single-arch).
- [ ] No auto-prune cron/timer on the host (rollback needs the previous image
      to stay local).
- [ ] **Backup per AGENTS.md (mandatory, unchanged by this item):**
      timestamped `/home/rocky/backups/osi-server-<ts>` covering repo
      snapshot, Docker env/config, PostgreSQL dump, Mosquitto state,
      OpenAgri data.
- [ ] GHCR pull PAT (read:packages only) available; `docker login ghcr.io`
      done once on the host; the PAT lives nowhere but this host.

## Deploy
1. Update the checkout (git pull / bundle fallback per AGENTS.md) so
   `docker/docker-compose.yml` is the `image:`-based version.
2. **Pin tags in `.env`** to the target `sha-<short>` for all three vars
   (`BACKEND_IMAGE_TAG`, `PREDICTION_IMAGE_TAG`, `FAO_IMAGE_TAG`). Record the
   previous values first — they are the rollback target. `latest` must not
   remain on this host.
3. `cd docker && docker compose pull backend prediction-service fao-reference-service`
   (pull is CPU-cheap — the entire point: this host never compiles again.
   Do NOT run `docker compose build` or `up --build` on this host, ever.)
4. `docker compose up -d --no-deps backend prediction-service fao-reference-service`

## Post-checks (same bar as rehearsal)
- `/actuator/health` → 200 from inside the host.
- `/actuator/prometheus` unauthenticated → 401/403; with admin JWT → 200.
- Live gateway sync still applying (fresh heartbeats/telemetry within ~2 min).
- Previous image tags still present in `docker images`.

## Rollback
Set the three `.env` tags back to the recorded previous `sha-<short>`;
`docker compose up -d --no-deps backend prediction-service fao-reference-service`
(no pull needed — image already local); re-run post-checks.

## Record
- Date/operator, previous → new tags, post-check results: ______
```

- [ ] **Step 5.7: Commit**

```bash
cd /home/phil/Repos/osi-server
git add docker/docker-compose.yml docker/docker-compose.dev-build.yml .env.example docs/operations/
git commit -m "feat(deploy): compose build->image cutover (GHCR, pinned sha tags) + dev-build override + rehearsal/production runbooks (1.B3/DD16)"
```

---

### Task 6: Full local gate + PR (do not merge)

- [ ] **Step 6.1: Full gate, everything**

```bash
cd /home/phil/Repos/osi-server/backend && ./gradlew test --no-daemon
cd /home/phil/Repos/osi-server && for f in .github/workflows/*.yml; do python3 -c "import yaml, sys; yaml.safe_load(open(sys.argv[1])); print(sys.argv[1], 'OK')" "$f"; done
cd /home/phil/Repos/osi-server/docker && docker compose config > /dev/null && docker compose -f docker-compose.yml -f docker-compose.dev-build.yml config > /dev/null && echo COMPOSE-OK
cd /home/phil/Repos/osi-server && git status --short   # nothing unexpected, no Temp*Probe files
git log --oneline main..HEAD                            # 5 commits, one per task 1-5
```
Expected: `BUILD SUCCESSFUL`; all workflow files `OK`; `COMPOSE-OK`; clean status; five task commits.

- [ ] **Step 6.2: Push + PR** — open the PR in osi-server, **do not merge**:

```bash
cd /home/phil/Repos/osi-server && git push -u origin feat/ci-ghcr-deploys
gh pr create --repo Open-Smart-Irrigation/osi-server --title "1.B3: first CI + ArchUnit boundary lock + Micrometer metrics + GHCR pull-only deploys" --body "$(cat <<'EOF'
Part of refactor-program item 1.B3 (DD11 + DD16). Spec: osi-os `docs/superpowers/specs/2026-07-07-osi-server-ci-ghcr-design.md`. Plan: osi-os `docs/superpowers/plans/2026-07-07-osi-server-ci-ghcr.md`.

## Scope
- **First CI for this repo**: `backend-ci.yml` (`./gradlew test`, temurin 21, gradle cache, Docker-capable runner — the 1.B4 Testcontainers runway) + `prediction-ci.yml` (pytest 3.11, PyTorch CPU index). Both run on this PR.
- **ArchUnit boundary lock (DD11, corrected)**: frozen-baseline cycle rule + `analytics !-> sync` + controller naming, passing on today's code.
- **Micrometer/Prometheus**: `/actuator/prometheus`, admin-gated in SecurityConfig (`hasRole("ADMIN")`; SUPER_ADMIN carries ROLE_ADMIN — verified in UserDetailsServiceImpl); `-Xmx768m` heap cap in compose.
- **GHCR publish on main** (`permissions: contents:read, packages:write`): backend + prediction(runtime) + fao(fao-runtime), `sha-<short>` immutable + `latest` dev-only, private, linux/amd64.
- **Compose cutover**: `backend`/`prediction-service`/`fao-reference-service` switch `build:` -> `image:` (mosquitto + prediction-validation deliberately stay, rationale in spec §E); `docker-compose.dev-build.yml` preserves local from-source iteration; runbooks in `docs/operations/`.

## The cycle-core finding (DD11 correction)
DD11's illustrative rule "`sync` must not depend on `analytics`" is **false today** (EdgeSyncService imports 13 analytics classes), and exhaustive import-graph verification found the cyclic core is a **12-package SCC plus 15 mutually-importing pairs** — far beyond the six pairs first sampled. The cycle rule therefore ships as a `FreezingArchRule` with a committed baseline store (grandfathers today's core, fails any new cycle-participating dependency, ratchets down as cycles are fixed); the directional rule asserts the true direction (`analytics !-> sync`). The DD11 charter text in `docs/architecture/refactor-program-2026.md` is being corrected separately (coordinator).

## Evidence
- Full local `./gradlew test` green (incl. ArchitectureTest + ActuatorSecurityTest).
- Rule-bite proofs executed and reverted (scratch violations: analytics->sync probe, channels<->chameleon new-cycle probe) — both rules demonstrably fail on violations.
- `docker compose config` green for base + dev-build override; 3 services on GHCR image refs.
- backend-ci + prediction-ci runs on this PR are the live proof of the workflows.

## Hard rules for rollout (spec §F)
- `ghcr-publish.yml` first runs on the merge commit — watch that run; the operator must set the `VITE_MAPBOX_TOKEN` repo secret **before merging**.
- **The FIRST production cutover happens only after the test-server rehearsal (`docs/operations/ghcr-pull-deploy-rehearsal.md`) passes and is recorded, and it is operator-executed** — no agent, no prod SSH, per the standing osicloud.ch policy. The production runbook ships gated NOT-READY (per coordinator direction both documents are in this PR for review; the spec's "write production runbook only after rehearsal" intent is honored via the hard gate banner + rehearsal record).
- Backup-before-rollout per AGENTS.md is unchanged and mandatory.

**Do not merge without coordinator sign-off.**
EOF
)"
```

- [ ] **Step 6.3: Confirm CI runs on the PR**

Run: `gh pr checks --repo Open-Smart-Irrigation/osi-server --watch` (or check the PR page).
Expected: `Backend CI` and `Prediction Service CI` both appear and go green (first live execution of the workflows — this is Task 1's real verification). `GHCR Publish` must NOT appear (push-to-main only). If either CI job fails on the runner but passed locally, fix within this branch and re-push before reporting done.
