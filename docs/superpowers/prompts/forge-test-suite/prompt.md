# Worker Prompt — Forge Test Suite

You are implementing the **OSI Forge test suite** — a multi-layered testing
framework that proves the forge controller is safe (deterministic gates),
measures output quality (simulation rubrics), and improves itself over time
(feedback loop that classifies failures and proposes skill edits).

## Repo

- **osi-os**: `/home/phil/Repos/osi-os` — Task 1 only (skill frontmatter validator)
- **osi-server**: `/home/phil/Repos/osi-server` — Tasks 2-7

Task 1 goes on the osi-os `feat/forge-skills-stage1` branch. Tasks 2-7 go on
the osi-server `feat/forge-controller-stage1` branch.

## Read first (your requirements)

1. **Plan:** `docs/superpowers/plans/2026-07-10-forge-test-suite.md` in osi-os
   — 7 tasks with exact code. Execute task-by-task using
   `superpowers:subagent-driven-development`.
2. **Spec:** `docs/superpowers/specs/2026-07-10-forge-test-suite-design.md` in
   osi-os — the five-layer test architecture, simulation catalog, rubrics,
   feedback loop, dashboard.
3. **Stage 1 controller plan:** `docs/superpowers/plans/2026-07-10-forge-controller-stage1.md`
   in osi-os — Tasks 2-7 import from `forge.*` modules defined there.
4. **Skill audit:** `docs/superpowers/specs/2026-07-10-forge-skill-audit.md`
   — the skill inventory the frontmatter validator (Task 1) will check.
5. **AGENTS.md** in both repos. Architecture, conventions.

## Execution method

Use `superpowers:subagent-driven-development` — dispatch a fresh subagent per
task, review between tasks.

## Task overview

| Task | Repo | What | Tier |
|------|------|------|------|
| 1 | osi-os | Skill frontmatter validator + CI step | A |
| 2 | osi-server | Gate tests (PRE/SEC/POST/CAP) | A |
| 3 | osi-server | Skill index + config credential tests | A |
| 4 | osi-server | Simulation catalog + harness + rubrics + nightly driver | C/D |
| 5 | osi-server | Feedback loop (classify + propose) | B |
| 6 | osi-server | Dashboard + nightly wiring | B |
| 7 | osi-server | CI wiring | — |

**Dependencies:** Task 1 is independent (osi-os). Tasks 2-3 can start once
Stage 1 Task 4 exists (they import `forge.gates`, `forge.skill_index`,
`forge.config`). Tasks 4-7 depend on Tasks 2-3.

## Non-negotiable invariants

1. **No production access.** Do not SSH to `osicloud.ch`.

2. **Deterministic first.** Anything checkable without an LLM is checked
   without an LLM. LLM-judge items exist in rubrics but the deterministic
   checks carry the weight.

3. **Properties over transcripts.** Never assert "plan equals this exact
   JSON." Assert invariants: "every path in `files_to_touch` exists in the
   repo."

4. **Safety is binary; quality is a distribution.** Safety invariants must
   hold 100% (non-negotiable). Quality scores have thresholds but human
   review backstops.

5. **Skills are never auto-edited.** The feedback loop *proposes*; the
   operator *approves*. `propose_skill_edits.py` writes proposals to disk;
   it never modifies SKILL.md files.

6. **The judge never self-judges.** Any future LLM-judge must be a fresh
   context that sees only the diff + rubric, never the planning/execution
   transcript.

## Key module interfaces (from Stage 1 Task 4)

The test suite imports these — verify they exist before writing tests:

```python
from forge.gates import pre_execution_gate, post_execution_gate
from forge.skill_index import (
    SELECTABLE_SKILLS, ALWAYS_INJECT, EXCLUDED,
    SELECTABLE_TOKEN_CEILING, SURFACE_SKILL_MAP,
    build_skill_index_text, validate_and_load_selected,
    check_dangling_skills,
)
from forge.config import load_controller_config, load_codex_env, validate_codex_env
```

If any of these don't exist, you're on the wrong branch or Stage 1 Task 4
hasn't been committed yet.

## Definition of done

```bash
# osi-os: skill frontmatter validator
node scripts/verify-skill-frontmatter.js
# Expected: OK (N skills)

# osi-server: all forge tests
cd forge && python -m pytest tests/ -v
# Expected: all tests PASS

# Nightly driver runs without error (dry run)
cd forge && python -c "from forge.tests.simulation.catalog import ALL_SIMULATIONS; print(f'{len(ALL_SIMULATIONS)} simulations defined')"
```

## Report

Task 1 goes in the osi-os skills PR. Tasks 2-7 go in the osi-server PR:

```markdown
## Summary
- Skill frontmatter validator (CI-gated, osi-os)
- Gate tests: PRE-01..12, SEC-01..25, POST/CAP checks
- Skill index + config credential separation tests
- Simulation catalog (18 requests), harness, rubrics, nightly driver
- Feedback loop: failure classifier + skill edit proposer
- Quality dashboard + nightly cron

## Test plan
- [ ] verify-skill-frontmatter.js passes
- [ ] Gate tests cover all forbidden paths and secret patterns
- [ ] SEC false-positive tests pass (config.env.ts, _credits.scss, etc.)
- [ ] Credential separation proof: codex_env has ONLY OPENAI_API_KEY
- [ ] Token ceiling enforced in skill loading
- [ ] Dangling skill backstop works
- [ ] Classifier handles all 6 buckets
- [ ] Proposer requires ≥3 same-signature failures
- [ ] Dashboard generates from scores.jsonl
- [ ] Nightly driver invocable
```
