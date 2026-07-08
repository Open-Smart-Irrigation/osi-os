# Dendro Cross-Repo Golden-Vector Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Execution notes:** (1) work inside a feature branch `feat/dendro-contract` (worktree recommended); (2) this item adds NO flows.json changes — the `osi-flows-json-editing` skill is not invoked; (3) osi-os changes commit here; osi-server changes are described for a paired osi-server PR (this line is osi-os docs-home, but the plan enumerates the server-side work so the osi-server executor has an exact task list); (4) run osi-os commands from the osi-os repo root, server commands from `osi-server/backend/`.
> **Spec:** [`docs/superpowers/specs/2026-07-08-dendro-cross-repo-golden-vector-contract-design.md`](../specs/2026-07-08-dendro-cross-repo-golden-vector-contract-design.md) (approved — this plan elaborates). §A–§E point there.
> **Charter:** `docs/architecture/refactor-program-2026.md` Phase 2, item 2.3 (DD5). **Depends on 2.2** (creates `osi-dendro-analytics` + the first `docs/contracts/dendro/` fixtures). Server-side automated CI additionally depends on 1.B3; until then the server runner is local-only and the osi-os byte-parity gate is the standing enforcement.

**Goal:** Turn 2.2's `docs/contracts/dendro/` fixtures into a cross-repo contract: fix the fixture format, add an osi-os fixture-driven suite over `osi-dendro-analytics`, mirror the fixtures byte-for-byte into osi-server + a plain-JUnit runner over the server's pure `EnvelopeTwd.compute` unit, and add an always-on osi-os CI byte-parity gate — asserting the two implementations agree on the shared envelope/TWD/MDS core, with divergence detected and attributed (DD5).

**Architecture:** osi-os is source of truth for `docs/contracts/dendro/` (`README.md`, `MANIFEST.json`, `cases/*.input.json` / `*.expected.json`). The osi-os side runs the cases through `osi-dendro-analytics` (`node --test`, CI). The osi-server side mirrors the fixtures to `backend/src/test/resources/contracts/dendro/` and runs them through `EnvelopeTwd.compute` + pure helpers in a **no-Spring** JUnit test. `scripts/verify-dendro-contract-mirror.js` in osi-os CI enforces the byte-mirror against a read-only osi-server checkout (the `verify-sync-op-parity.js` plumbing). The asserted shared field set is `envelope_ref_um`, `twd_day_um`, `twd_night_um`, `mds_um` (spec §C — `stress_level`/`twd_rel`/RDI excluded as intentional divergence).

**Tech Stack:** osi-os: Node.js (`node --test`, Node 22). osi-server: JUnit (no Spring context), `backend/gradlew test`. CI: osi-os `migrations.yml`; osi-server CI is 1.B3's.

## Global Constraints

- **No flows.json changes.** Tooling + fixtures + tests only.
- **Fixture directional field names (spec §A/§E):** `*.input.json` uses `channels.json` dendro channel names (`dendro_position_mm`, `adc_ch0v`, …); `*.expected.json` uses `dendrometer_daily` column names for the asserted set (`envelope_ref_um`, `twd_day_um`, `twd_night_um`, `mds_um`). Do NOT assert `stress_level` (§C exclusion).
- **osi-os is source of truth; the osi-server mirror must match bytewise** (the `docs/contracts/sync-schema/README.md` convention).
- **Both implementations are pure and deterministic in the contract:** osi-os runs `osi-dendro-analytics` pure functions; osi-server runs `EnvelopeTwd.compute` (static, no Spring/clock/weather). No DB, no weather stub (§spec §A/§C).
- **No live gateway / production host / SSH.**
- Branch `feat/dendro-contract` (osi-os); a paired `feat/dendro-contract` branch on osi-server for the mirror + runner. Open PRs, do not merge.

## Verification findings (plan-write checks)

1. **The server's fixture-drivable compute unit is `EnvelopeTwd.compute(List<DailyPoint>, method, maxGrowth)`** (`backend/src/main/java/org/osi/server/analytics/EnvelopeTwd.java`, `public static`, two overloads). `DendroDaily` is a JPA `@Entity` (no compute); `DendroAnalyticsService.computeForAllZones()` is no-arg + repo/clock/weather-driven (not fixture-drivable). Confirmed 2026-07-08. The runner targets `EnvelopeTwd.compute` + the pure helpers `DendroConfidenceGatingTest` already exercises.
2. **`EnvelopeTwd.EnvelopeResult` exposes the shared fields** — `envelopeRef` (→ `envelope_ref_um`), `twdNight` (→ `twd_night_um`), `twdDay` (→ `twd_day_um`), `mds` (→ `mds_um`) — the exact edge `computeEnvelope` output shape. This is why the intersection is these four fields.
3. **The cross-repo checkout plumbing exists** (`migrations.yml:18-27`: `Open-Smart-Irrigation/osi-server` via `OSI_SERVER_RO_TOKEN` into `osi-server/`, `::error::` guard). `verify-dendro-contract-mirror.js` reuses it verbatim.
4. **`channels.json` covers dendro telemetry inputs, NOT daily outputs** — so input keys are channels; output keys are `dendrometer_daily` columns (spec §ground-truth 2). Do not validate output keys against channels.json.
5. **2.2 already committed `docs/contracts/dendro/` in the §A format** (README + MANIFEST + cases). If 2.2's format matches spec §A, Task 1 is a re-affirmation; if 2.2 shipped it ad-hoc, Task 1 reshapes it. Verify at execution.

## File Structure (all changes)

**osi-os:**
- Modify/affirm: `docs/contracts/dendro/{README.md, MANIFEST.json, cases/*}` (T1)
- Create: `scripts/test-dendro-contract.js` (osi-os fixture-driven suite) (T2)
- Create: `scripts/verify-dendro-contract-mirror.js` + `scripts/verify-dendro-contract-mirror.test.js` (T4)
- Modify: `.github/workflows/migrations.yml` (T2, T4), `docs/architecture/refactor-program-2026.md` (T5)

**osi-server (paired PR):**
- Create: `backend/src/test/resources/contracts/dendro/**` (byte-mirror of osi-os cases + MANIFEST) (T3)
- Create: `backend/src/test/java/org/osi/server/analytics/DendroContractFixtureTest.java` (T3)

---

### Task 1: Fix the fixture format + README (osi-os)

- [ ] **Step 1.1: Confirm/reshape 2.2's fixtures** to spec §A: `docs/contracts/dendro/cases/<case>.input.json` = `{ zones, devices, readings, priorState, computedAt }`; `<case>.expected.json` = `{ dendrometer_daily: [...] }` (per-tree daily rows) with the asserted keys present. `MANIFEST.json` = `{ schemaVersion: <int>, cases: ["<name>", ...] }`. Input telemetry rows use `channels.json` names; expected rows use `dendrometer_daily` column names.

- [ ] **Step 1.2: README** (`docs/contracts/sync-schema/README.md` pattern): osi-os is source of truth; osi-server mirror at `backend/src/test/resources/contracts/dendro/` must match bytewise; the asserted shared field set is `envelope_ref_um`/`twd_day_um`/`twd_night_um`/`mds_um` (`stress_level`/`twd_rel`/RDI excluded as intentional DD5 divergence); **divergence-handling rule** — a red contract test on one side names which implementation moved; resolution is a human decision (fix the regression, or update the fixture on the side that legitimately moved), never automated reconciliation.

- [ ] **Step 1.3: Commit** (`git add docs/contracts/dendro; git commit -m "feat(contract): fix dendro fixture format + cross-repo README (refactor-program 2.3, spec §A)"`).

---

### Task 2: osi-os fixture-driven suite over `osi-dendro-analytics` + CI

- [ ] **Step 2.1: `scripts/test-dendro-contract.js`** (`node --test`): read `MANIFEST.json`; for each case, load `*.input.json`, map the readings into the `osi-dendro-analytics` compute-core call path (the same envelope/TWD/MDS pipeline the module exposes — `require` the module from `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-analytics`), and assert the produced daily values equal `*.expected.json` on the four asserted fields (exact equality on the rounded values, spec §A). Green at introduction (2.2 captured the fixtures from the edge).

- [ ] **Step 2.2: Run + wire CI:**
```bash
node --test scripts/test-dendro-contract.js
```
Add `scripts/test-dendro-contract.js` to the `node --test` line in `.github/workflows/migrations.yml`.

- [ ] **Step 2.3: Commit** (`git add scripts/test-dendro-contract.js .github/workflows/migrations.yml; git commit -m "feat(ci): osi-os dendro contract runner over osi-dendro-analytics (refactor-program 2.3, spec §B)"`).

---

### Task 3: osi-server mirror + no-Spring JUnit runner (paired osi-server PR)

> This task is executed on the osi-server repo (paired PR). Described here so the server executor has an exact list; nothing in this task is committed to osi-os.

- [ ] **Step 3.1: Byte-mirror** the osi-os `docs/contracts/dendro/cases/*` + `MANIFEST.json` into `osi-server/backend/src/test/resources/contracts/dendro/` — byte-identical (the osi-os byte-parity gate, Task 4, enforces this).

- [ ] **Step 3.2: `DendroContractFixtureTest.java`** (plain JUnit, **no `@SpringBootTest`**, no `@Autowired`): for each case in `MANIFEST.json`, read `*.input.json` off the classpath, build `List<EnvelopeTwd.DailyPoint>` from the readings (the same `DailyPoint(date, dMaxUm, dMinUm, notLowConfidence)` shape `DendroAnalyticsService` builds at its line ~362), call `EnvelopeTwd.compute(points, method, maxGrowth)` with the case's calibration method, and assert the resulting `EnvelopeResult` fields (`envelopeRef`/`twdDay`/`twdNight`/`mds`) equal `*.expected.json`'s `envelope_ref_um`/`twd_day_um`/`twd_night_um`/`mds_um`. Exact equality on the rounded values. Do NOT assert `stress_level`.

- [ ] **Step 3.3: Run** from `osi-server/backend/`: `./gradlew test --tests '*DendroContractFixtureTest'` — green. (CI wiring is 1.B3's; noted, not built.)

- [ ] **Step 3.4: Commit** on the osi-server branch (`feat(test): dendro cross-repo golden-vector contract runner (refactor-program 2.3, spec §C)`).

---

### Task 4: osi-os byte-parity gate (always-on cross-repo enforcement)

- [ ] **Step 4.1: `scripts/verify-dendro-contract-mirror.test.js`** (first) — scratch-dir tests: (a) identical trees → pass; (b) a byte-diverging case file → fail with a message naming the file; (c) a missing mirror file → fail; (d) an extra file in the mirror not in the source → fail (mirror must be exact, not a superset).

- [ ] **Step 4.2: `scripts/verify-dendro-contract-mirror.js`** — reuse the `verify-sync-op-parity.js` shape: resolve the osi-server checkout root (env/arg, matching how `verify-sync-op-parity.js` takes the server path); for every file under `docs/contracts/dendro/cases/` + `MANIFEST.json`, byte-compare against `<server>/backend/src/test/resources/contracts/dendro/<same relative path>`; fail listing any missing/diverging/extra file. Include the checkout-missing `::error::` guard (clear message if `OSI_SERVER_RO_TOKEN`/checkout absent). Exit 0 iff exact mirror.

- [ ] **Step 4.3: Run + wire CI:**
```bash
node --test scripts/verify-dendro-contract-mirror.test.js
node scripts/verify-dendro-contract-mirror.js osi-server   # against a local osi-server checkout
```
In `.github/workflows/migrations.yml`: add `scripts/verify-dendro-contract-mirror.test.js` to the `node --test` line and `- run: node scripts/verify-dendro-contract-mirror.js osi-server` after `verify-sync-op-parity.js` (reusing the already-checked-out `osi-server/` path).

- [ ] **Step 4.4: Commit** (`git add scripts/verify-dendro-contract-mirror.js scripts/verify-dendro-contract-mirror.test.js .github/workflows/migrations.yml; git commit -m "feat(ci): dendro contract byte-mirror gate against osi-server checkout (refactor-program 2.3, spec §D)"`).

---

### Task 5: Program-doc outcome + PRs

- [ ] **Step 5.1:** In `docs/architecture/refactor-program-2026.md` Phase 2, append to the 2.3 row: `— done: dendro golden-vector contract (osi-os runner + byte-mirror gate; osi-server EnvelopeTwd runner in paired PR), asserted core = envelope/TWD/MDS, PR #<FILL>`. Commit.

- [ ] **Step 5.2: Full osi-os local run** (green): `node --test scripts/test-dendro-contract.js scripts/verify-dendro-contract-mirror.test.js`; `node scripts/verify-dendro-contract-mirror.js osi-server` (against a checkout); the existing gates unchanged.

- [ ] **Step 5.3: Open the osi-os PR (do not merge)** — summary: fixture format, osi-os runner, byte-mirror gate, the asserted shared core, the DD5 divergence-handling rule; note dependency on 2.2 and the paired osi-server PR; note server-side CI is 1.B3's. **Open the paired osi-server PR** (Task 3) referencing this one.

---

## Follow-ups (not tasks in this plan)

- **Item 2.5** exports `channels.json` into the osi-server build; if it later adds daily-aggregate fields, the §A parity check can validate output keys against it too.
- A **stress-classification sub-contract** could be added later if the edge and server stress logic ever converge (excluded here as intentional divergence, spec §C).
- **1.B3** wires the osi-server `DendroContractFixtureTest` into osi-server CI (this item runs it locally + relies on the osi-os byte-parity gate meanwhile).
