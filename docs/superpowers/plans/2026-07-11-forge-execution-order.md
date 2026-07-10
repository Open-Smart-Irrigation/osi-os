# Forge Pipeline — Master Execution Order

**Date:** 2026-07-11
**Purpose:** Single-page dependency map for Codex workers executing the forge plans. Each plan has its own worker prompt; this document says **what order to run them in** and **what must be true before starting each one**.

---

## Execution phases

```
Phase 1 — Skills (osi-os)          ← no deps, can start immediately
Phase 2 — Server API (osi-server)  ← no deps on Phase 1 (different repo)
Phase 3 — Controller (osi-server)  ← depends on Phase 2
Phase 4 — Learning (osi-server)    ← depends on Phase 3
Phase 5 — Test Server Setup (ops)  ← depends on Phases 1-4 being committed
Phase 6 — Test Suite (osi-server)  ← depends on Phase 3, can parallel Phase 4
```

**Phases 1 and 2 can run in parallel** (different repos, different branches).
**Phase 6 can start once Phase 3 is done**, in parallel with Phase 4.

---

## Phase 1: Skills (osi-os)

**Plan:** `docs/superpowers/plans/2026-07-10-forge-controller-stage1.md` — Tasks 1-2
**Prompt:** `docs/superpowers/prompts/forge-controller-stage1/prompt.md`
**Branch:** `feat/forge-skills-stage1` (from `main`)
**Repo:** osi-os

| Task | What | Output |
|------|------|--------|
| 1 | 3 new always-inject skills + fix 3 existing skills | `.claude/skills/osi-forge-boundaries/`, `osi-common-pitfalls/`, `osi-verification-commands/` + fixes |
| 2 | 3 new Claude-selects skills | `.claude/skills/osi-sync-contract-awareness/`, `osi-react-gui-patterns/`, `osi-server-backend-patterns/` |

**Preconditions:** None.
**Verification:** `node scripts/verify-skill-frontmatter.js` passes.
**PR:** osi-os skills PR.

---

## Phase 2: Server Forge API (osi-server)

**Plan:** `docs/superpowers/plans/2026-07-10-forge-controller-stage1.md` — Task 3
**Branch:** `feat/forge-controller-stage1` **from `feat/field-to-pr-stage0-revised`** (not `main`)
**Repo:** osi-server

| Task | What | Output |
|------|------|--------|
| 3 | Flyway migration, ForgeService, ForgeController, ForgeTokenFilter, ISSUE_OPEN→AWAITING_AGENT dispatch | `backend/src/main/java/org/osi/server/workrequest/Forge*.java` |

**Preconditions:** `feat/field-to-pr-stage0-revised` exists on origin (it does — deployed on test server).
**Verification:** `./gradlew test --tests 'org.osi.server.workrequest.*'` passes.

---

## Phase 3: Controller (osi-server)

**Plan:** `docs/superpowers/plans/2026-07-10-forge-controller-stage1.md` — Task 4
**Branch:** same as Phase 2 (`feat/forge-controller-stage1`)
**Repo:** osi-server

| Task | What | Output |
|------|------|--------|
| 4 | Python controller: config, skill_index, gates, pipeline, github_pr, controller, prompt templates, JSON schemas, tests | `forge/` package |

**Preconditions:** Phase 2 committed (ForgeController endpoints exist for the controller to call).
**Verification:** `cd forge && python -m pytest tests/ -v` passes.

---

## Phase 4: Learning Loop Phase A (osi-server)

**Plan:** `docs/superpowers/plans/2026-07-11-forge-learning-phase-a.md` — Tasks 1-4
**Branch:** same as Phases 2-3 (`feat/forge-controller-stage1`)
**Repo:** osi-server

| Task | What | Output |
|------|------|--------|
| 1 | Learning ledger package (schema.sql, ledger.py, redact.py) | `forge/learning/` |
| 2 | Version stamping + signal extraction + telemetry | `extract_signals.py`, modified `pipeline.py` + `controller.py` |
| 3 | Request interpretation + PR body conventions | Modified `plan_schema.json` + `plan_system.md` + `github_pr.py` |
| 4 | GitHub harvest cron | `harvest_github.py` |

**Preconditions:** Phase 3 committed (`forge/pipeline.py`, `forge/controller.py`, `forge/github_pr.py`, `forge/prompts/plan_schema.json` exist).
**Verification:** `cd forge && python -m pytest tests/unit/ -v` passes (all including new test_ledger, test_extract_signals, test_interpretation, test_harvest).

---

## Phase 5: Test Server Setup (ops)

**Plan:** `docs/superpowers/plans/2026-07-10-forge-controller-stage1.md` — Task 5
**Prompt:** `docs/superpowers/prompts/forge-controller-stage1/prompt.md`
**Where:** test VPS (`server.opensmartirrigation.org`)

| Step | What |
|------|------|
| 5.1 | Install Node.js 20 LTS |
| 5.2 | Install Claude CLI + Codex CLI (per-user npm prefix) |
| 5.3 | Split credentials into codex.env + controller.env |
| 5.4 | Generate FORGE_RUNNER_TOKEN + deploy server API |
| 5.5 | Set up execution isolation (file perms + iptables egress restriction) |
| 5.6 | Set up Python venv + deploy controller code |
| 5.7 | Liveness monitoring + daily GC cron + harvest cron |
| 5.8-5.10 | E2E: dispatch hand-crafted issue, observe first draft PR |

**Preconditions:** Phases 1-4 committed; server running `feat/forge-controller-stage1` or later.
**Verification:** All isolation checks pass; CLI smoke test; at least one hand-crafted issue produces a draft PR.

---

## Phase 6: Test Suite (osi-server)

**Plan:** `docs/superpowers/plans/2026-07-10-forge-test-suite.md` — Tasks 1-7
**Branch:** same as Phases 2-4 (`feat/forge-controller-stage1`)
**Repo:** osi-os (Task 1 only: skill frontmatter validator) + osi-server (Tasks 2-7)

| Task | What | Tier |
|------|------|------|
| 1 | Skill frontmatter validator + CI step | A (osi-os) |
| 2 | Gate tests (PRE/SEC/POST/CAP) | A |
| 3 | Skill index + config credential tests | A |
| 4 | Simulation catalog + harness + rubrics + nightly driver | C/D |
| 5 | Feedback loop (classify + propose) | B |
| 6 | Dashboard + nightly wiring | B |
| 7 | CI wiring | — |

**Preconditions:** Phase 3 committed (forge controller modules exist for imports). Can run in parallel with Phase 4 since it doesn't import from `forge.learning`.
**Verification:** `cd forge && python -m pytest tests/ -v` + `node scripts/verify-skill-frontmatter.js`.

---

## Dependency graph (visual)

```
                    ┌─── Phase 1 (osi-os skills) ──────────────────────┐
                    │                                                    │
start ──┤                                                    ├──► Phase 5 (ops)
                    │                                                    │
                    └─── Phase 2 (server API) ──► Phase 3 (controller) ─┤
                                                       │                 │
                                                       ├──► Phase 4 (learning) ──┘
                                                       │
                                                       └──► Phase 6 (test suite)
```

---

## PR structure

| PR | Repo | Branch | Phases | Base |
|----|------|--------|--------|------|
| **PR A** | osi-os | `feat/forge-skills-stage1` | 1 + 6.Task1 | `main` |
| **PR B** | osi-server | `feat/forge-controller-stage1` | 2 + 3 + 4 + 6.Tasks2-7 | `feat/field-to-pr-stage0-revised` |

Two PRs total. Phase 5 is ops (no PR — server configuration).

---

## What each Codex worker needs

| Worker | Plan file | Prompt file | Phases |
|--------|-----------|-------------|--------|
| Worker 1 (skills) | `forge-controller-stage1.md` Tasks 1-2 | `forge-controller-stage1/prompt.md` | 1 |
| Worker 2 (server API) | `forge-controller-stage1.md` Task 3 | `forge-controller-stage1/prompt.md` | 2 |
| Worker 3 (controller) | `forge-controller-stage1.md` Task 4 | `forge-controller-stage1/prompt.md` | 3 |
| Worker 4 (learning) | `forge-learning-phase-a.md` Tasks 1-4 | (new prompt needed, or extend Stage 1 prompt) | 4 |
| Worker 5 (test suite) | `forge-test-suite.md` Tasks 1-7 | (needs its own prompt) | 6 |
| Human (ops) | `forge-controller-stage1.md` Task 5 | `forge-controller-stage1/prompt.md` | 5 |

Workers 1 and 2 can run in parallel. Worker 3 waits for Worker 2. Workers 4 and 5 can run in parallel after Worker 3. Human ops (Worker 6) runs last.

---

## Stage 0 (field intake) — separate track

**Plan:** `docs/superpowers/plans/2026-07-08-field-to-pr-stage0.md`
**Prompt:** `docs/superpowers/prompts/field-to-pr-stage0/prompt.md`
**Repos:** osi-os (`feat/field-to-pr-stage0`) + osi-server (`feat/field-to-pr-stage0-revised`, already deployed)

Stage 0 is the intake pipeline (GUI form → sync → server → GitHub issue). It is **already partially deployed** on the test server. The remaining osi-os side (edge schema, Node-RED intake, React form) runs independently of the forge controller work. Its osi-server branch (`feat/field-to-pr-stage0-revised`) is the **base for all forge controller work**.

Execution order: Stage 0 osi-os work can run in parallel with everything above. Stage 0 osi-server work is already deployed.
