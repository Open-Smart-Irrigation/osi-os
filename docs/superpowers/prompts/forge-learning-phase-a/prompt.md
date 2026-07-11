# Worker Prompt — Forge Learning Loop Phase A

You are implementing **Phase A of the OSI Forge self-learning loop** — the
"record everything" instrumentation layer. After this, every forge job produces
structured records in a SQLite ledger, and every merged PR's human feedback
is harvested daily.

## Repo

- **osi-server**: `/home/phil/Repos/osi-server` — all work is here
- **Branch:** `feat/forge-controller-stage1` (same branch as the controller)

You are extending code that the Stage 1 controller plan created. The files you
modify (`pipeline.py`, `controller.py`, `config.py`, `github_pr.py`,
`plan_schema.json`) already exist on this branch.

## Read first (your requirements)

1. **Plan:** `docs/superpowers/plans/2026-07-11-forge-learning-phase-a.md` in
   osi-os — 4 tasks with exact code. Execute task-by-task using
   `superpowers:subagent-driven-development`.
2. **Spec:** `docs/superpowers/specs/2026-07-10-forge-self-learning-loop-design.md`
   in osi-os — §4 (production learning cycle), §5 (institutional memory), §6
   (domain expert adaptation), §9 Phase A. **Read §4.2, §5.2, §6.2 before
   writing any code.**
3. **Stage 1 controller plan:** `docs/superpowers/plans/2026-07-10-forge-controller-stage1.md`
   in osi-os — Task 4 defines the files you're modifying. Know their structure.
4. **AGENTS.md** in osi-os. Architecture, conventions.
5. **Engineering playbook:** `docs/engineering-playbook.md` — the working loop.

## Execution method

Use `superpowers:subagent-driven-development` — dispatch a fresh subagent per
task, review between tasks.

## Task overview

| Task | What | Key files |
|------|------|-----------|
| 1 | Learning ledger package (schema.sql, ledger.py, redact.py) | `forge/learning/` (new) |
| 2 | Version stamping + signal extraction + telemetry | `forge/learning/extract_signals.py` (new), `forge/pipeline.py` (modify), `forge/controller.py` (modify) |
| 3 | Request interpretation + PR body conventions | `forge/prompts/plan_schema.json` (modify), `forge/prompts/plan_system.md` (modify), `forge/github_pr.py` (modify) |
| 4 | GitHub harvest cron | `forge/learning/harvest_github.py` (new) |

**Dependencies:** Task 1 first (ledger needed by Tasks 2-4). Tasks 2-4 can
run in any order after Task 1, but Task 2 before Task 3 is recommended since
the version stamp is referenced in extraction.

## Non-negotiable invariants

1. **No production access.** Do not SSH to `osicloud.ch`.

2. **The ledger is on the runner, never committed.** `forge-memory.db` and
   `memory/archive/` live in `/home/forge-runner/memory/`. They contain
   field-derived text. Nothing from Layers 0–1 enters a public repo.

3. **Signal provenance is mandatory.** Every `signals` row carries `provenance`
   ∈ {`deterministic`, `human`, `llm`, `field-untrusted`}. This is how Phase B
   knows which signals are safe to feed into prompts (deterministic + human)
   vs evidence-only (llm, field-untrusted).

4. **Version stamps cannot be retrofitted.** The stamp computation
   (`compute_version_stamp()`) must run at job start and be written with the
   job record. A job without stamps is permanently un-attributable. This is
   why Phase A ships with Stage 1, not after.

5. **Phase A records only — no learning actions.** Nothing in this plan changes
   what a future job sees or does. The asymmetry principle (spec §8.1): "the
   loop may automatically restrict; only a human may loosen or teach."

6. **Credential separation unchanged.** The learning package reads controller
   config only (for the GitHub App token in harvest). It never touches
   `codex.env`.

7. **Reviewer conventions are the data contract.** The three PR body prefixes
   (`INTERPRETATION:`, `LESSON:`, `GATE:`) are how human review becomes
   structured signal. The PR body template must render the interpretation block
   and document these conventions clearly.

## The SQLite schema (source of truth)

The schema is in `forge/learning/schema.sql`. Key tables:
- `jobs` — one row per forge job, with version stamps and outcome fields
- `signals` — N rows per job, typed (S1–S12, H1–H8, F1–F3)
- `pass_telemetry` — per-pass cost/latency/model
- `lessons`, `proposals`, `phrasebook`, `config_trials` — Phase B tables,
  created now but empty until Phase B code writes them

The schema creates tables with `IF NOT EXISTS` — safe to re-run.

## Integration points with Stage 1 code

These are the exact files you modify and where:

1. **`forge/config.py`** — add `MEMORY_DIR`, `MEMORY_DB`, `ARCHIVE_DIR`
   constants and `load_pipeline_config()` function. Add after the existing
   path constants block.

2. **`forge/pipeline.py`** — add `compute_version_stamp()` call at pipeline
   start, `pass_telemetry` list threaded through each pass, `_parse_cost()`
   helper, and include `version_stamp` + `pass_telemetry` in return dicts.

3. **`forge/controller.py`** — import `Ledger` and `extract_signals`, create
   ledger instance at tick start, call `extract_signals()` in both success
   and failure cleanup paths (wrapped in try/except — extraction failure must
   not crash the controller).

4. **`forge/github_pr.py`** — replace `_build_pr_body_preview()` with
   `_build_pr_body()` that renders the interpretation block and reviewer
   conventions. Update `push_and_create_pr()` to call the new function.

5. **`forge/prompts/plan_schema.json`** — add `request_interpretation` object
   to `properties` and to the `required` array.

6. **`forge/prompts/plan_system.md`** — append the interpretation behavioral
   rules section.

## Definition of done

```bash
# All learning tests pass
cd forge && python -m pytest tests/unit/test_ledger.py tests/unit/test_extract_signals.py \
  tests/unit/test_interpretation.py tests/unit/test_harvest.py -v

# Existing Stage 1 tests still pass
cd forge && python -m pytest tests/ -v

# Schema creates all expected tables
python -c "
from forge.learning.ledger import Ledger
from pathlib import Path
import sqlite3, tempfile
l = Ledger(Path(tempfile.mktemp(suffix='.db')))
conn = sqlite3.connect(l.db_path)
tables = {r[0] for r in conn.execute('SELECT name FROM sqlite_master WHERE type=\"table\"').fetchall()}
assert tables >= {'jobs', 'signals', 'pass_telemetry', 'lessons', 'proposals', 'config_trials', 'phrasebook'}
print(f'OK: {len(tables)} tables created')
"

# plan_schema.json has request_interpretation
python -c "
import json
schema = json.loads(open('forge/prompts/plan_schema.json').read())
assert 'request_interpretation' in schema['properties']
assert 'request_interpretation' in schema.get('required', [])
print('OK: request_interpretation in schema')
"
```

## Critical: Read the actual code first

This plan was originally written against the Stage 1 *plan* document. The actual
Stage 1 code in the `feat/forge-controller-stage1` branch has different function
names and structure. **Before executing any "Modify" step, READ the real file**
and match function names, signatures, and control flow. Known divergences:

- `_tick()` → actual name may be `_run_claimed_job()` (verify)
- `run_pipeline` has a 6th `report_state` param
- `_run_fix_cycle()` is a separate function with its own return dict
- `build_pr_body()` is the public export (no underscore)

The plan's "Fable Review Errata" section at the bottom has additional medium/low
items to address during implementation.

## When stuck

- Re-read the spec section for the task you're on. The spec has worked
  examples (§4.6) that show exactly what each signal looks like.
- **Read the actual Stage 1 code** (not the plan) to understand the structure
  of `pipeline.py`, `controller.py`, etc.
- For SQLite issues: the schema uses `IF NOT EXISTS` and WAL journal mode.
  The `Ledger` class creates the DB on init. Don't use `sqlite3` directly
  outside `ledger.py`.
- For import errors: the package is `forge/learning/` with `__init__.py`.
  Imports from the parent: `from ..config import MEMORY_DB`.

## Report

All changes go into the existing osi-server PR on `feat/forge-controller-stage1`:

```markdown
## Summary (append to existing PR)
- Added forge learning ledger (SQLite schema, 7 tables)
- Version stamping on every job (skills_sha, prompts_version, config_id, model ids)
- Signal extraction (S1–S12) wired into controller cleanup
- Request interpretation in plan schema + PR body conventions
- Daily GitHub harvest for human-behavior signals (H1–H7)

## Learning-specific verification
- [ ] Ledger creates all 7 tables
- [ ] extract_signals produces ≥6 signals for a typical job
- [ ] Version stamp captured at pipeline start
- [ ] pass_telemetry recorded per CLI pass
- [ ] plan_schema.json requires request_interpretation
- [ ] PR body renders interpretation block + 3 reviewer conventions
- [ ] harvest parses INTERPRETATION:/LESSON:/GATE: prefixes
- [ ] Existing Stage 1 tests still pass
```
