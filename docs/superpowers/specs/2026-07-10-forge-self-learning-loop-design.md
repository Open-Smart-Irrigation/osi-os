# Forge Self-Learning Loop — Design

**Date:** 2026-07-10
**Status:** Draft — ML/systems architecture for the forge's advanced learning layer.
**Author role:** Senior ML/systems architect. This document designs how the forge
gets better from every production job, not just from nightly simulation failures.
**Scope:** Learning-signal extraction from production jobs, institutional memory,
evolution of every forge component (skills, AGENTS.md, prompt templates, gates,
simulation catalog, skill index, quality thresholds, pipeline configuration),
domain-expert input adaptation, and the safety rails that keep a self-modifying
pipeline trustworthy.
**Depends on:**
- Forge spec: `docs/superpowers/specs/2026-07-10-forge-controller-stage1-design.md`
- Test suite spec (Layer 4 = the basic loop this supersedes/extends):
  `docs/superpowers/specs/2026-07-10-forge-test-suite-design.md`
- Test suite plan: `docs/superpowers/plans/2026-07-10-forge-test-suite.md`
- Skill audit: `docs/superpowers/specs/2026-07-10-forge-skill-audit.md`
- Stage 0 design: `docs/superpowers/specs/2026-07-08-field-to-pr-design.md`
- Engineering playbook: `docs/engineering-playbook.md`

---

## 1. Executive summary

The basic feedback loop (test-suite Layer 4) is a good skeleton: classify
simulation failures into SKILL_GAP / MODEL_FAILURE / GATE_DEFECT /
HARNESS_DEFECT, propose skill edits when ≥3 same-signature failures accumulate,
human applies, nightly re-score validates. It has four structural limits:

1. **It only sees simulations.** Production jobs — the distribution that
   actually matters — leave artifacts on disk and outcomes on GitHub that
   nobody reads back. The forge is blind to its own real track record.
2. **It only learns from failures.** A merged PR carries at least as much
   information as a failed one: which skills were injected, how the request was
   phrased, what the plan looked like, how fast the human merged, what the
   human changed afterward. The basic loop discards roughly all of that.
3. **It only improves one surface** (SKILL.md files). Prompt templates, gate
   regexes, the skill index descriptions, the simulation catalog, quality
   thresholds, and the pipeline configuration all decay or miscalibrate with
   zero corrective mechanism.
4. **Its ≥3-repeat threshold is tuned for the wrong data regime.** At 5–20
   jobs/week, waiting for three identical failures means reacting in months.
   In a low-data regime you must extract maximum structure from *each* job and
   let a human act on high-confidence single events — a human fixup commit on
   an agent branch is a definitive label at n=1.

The design principle of this document: **extract maximum structure per job,
store it durably in a queryable ledger, distill it into injectable memory,
gate every codification through a weekly human review bounded at ~45 minutes,
and stamp every job with the versions of everything that influenced it so
every change is attributable and revertible.**

Nothing here weakens the existing safety posture. The loop may automatically
*restrict* (quarantine class-2 jobs when the model version changes, flag a
regression), but every action that *loosens* behavior or feeds text into
future prompts is human-gated — because a self-learning pipeline adds a new
attack surface the static forge did not have: **memory poisoning** via crafted
field requests (§8.3).

---

## 2. Signal taxonomy

Every learning signal the forge can extract, its source artifact, how it is
extracted, and how much to trust it. "Deterministic" means a parser/differ
computes it with no model in the loop.

### 2.1 Per-job pipeline signals (exist today, unread)

| # | Signal | Source artifact | Extraction | Confidence |
|---|--------|----------------|------------|------------|
| S1 | Terminal state + failure reason | `work_request_events` (server) + controller report | deterministic | High |
| S2 | Gate results, per check, incl. warnings | `gate-pre.json`, `gate-post.json` | deterministic | High |
| S3 | Independent test results | `verification-results.json` | deterministic | High |
| S4 | Codex-claim vs controller-rerun divergence | `execution-report.md` × `verification-results.json` | deterministic diff | High — the honesty signal |
| S5 | Review verdict + findings + severities | `review.json` | deterministic parse (content is LLM output) | Medium-high |
| S6 | Fix-cycle occurrence + fix instructions | `fix-instructions.md` presence + content | occurrence deterministic; content is LLM text | High / Medium |
| S7 | Skill selection vs surface backstop | `plan.json.required_skills` × diff-touched surfaces (`check_dangling_skills`) | deterministic | High |
| S8 | Skill-selection reasoning | `plan.json.skill_reasoning` | LLM text, read at digest time | Medium |
| S9 | Escalation events + Fable verdict | `plan.json.escalation_needed` + escalation output | deterministic | High |
| S10 | Plan hallucination rate | `plan.json.files_to_touch` × repo file existence | deterministic | High |
| S11 | Cost / latency / model identity per pass | CLI result envelopes (`total_cost_usd`, model id, wall clock) | deterministic | High |
| S12 | Injection/sanitizer hits | sanitizer log + gate content-scan results | deterministic | High — adversarial intelligence |

### 2.2 Human-behavior signals (the ultimate ground truth — new harvest)

| # | Signal | Source | Extraction | Confidence |
|---|--------|--------|------------|------------|
| H1 | PR merged / closed-unmerged | GitHub API (`gh pr view`) | deterministic | High |
| H2 | **Human fixup diff** — commits by a human on the agent branch before merge, or the delta between the agent's last commit and the merge commit | GitHub API + git | deterministic diff | **Very high.** The exact delta between forge output and human-acceptable output. The single richest signal in the system. |
| H3 | Follow-up commits touching the same files within 7 days of merge, referencing the PR/issue | git log on main | heuristic match | Medium |
| H4 | Review comment content | GitHub PR review comments | structured-prefix convention first (§4.3), LLM categorization fallback | High (prefixed) / Medium (LLM-parsed) |
| H5 | Merge latency, review-round count | GitHub timeline | deterministic | Medium — confounded by human availability; use as secondary evidence only |
| H6 | Interpretation confirmed/corrected | `INTERPRETATION:` review comments (§6.3) | deterministic prefix parse | High |
| H7 | Explicit operator lessons | `LESSON:` review comments | deterministic prefix parse | High — human-authored |
| H8 | Proposal accept/reject decisions | proposals ledger (§5) | deterministic | High — labels the *proposer's* calibration |

### 2.3 Field-side signals

| # | Signal | Source | Extraction | Confidence |
|---|--------|--------|------------|------------|
| F1 | Request re-submission after "fixed" (same `dedup_hash` family or reopened issue) | server dedup + issue events | deterministic | High — the fix did not fix it |
| F2 | NEEDS_INFO round-trips per request category/register | `work_request_events` | deterministic | Medium |
| F3 | Request phrasing → implemented surface mapping | request text × merged-PR diff surfaces | recorded per job; generalized only at digest time | Low individually, Medium in aggregate — **untrusted-text provenance, see §8.3** |

### 2.4 Simulation signals (existing Layer 4, unchanged)

| # | Signal | Source | Confidence |
|---|--------|--------|------------|
| M1 | Nightly scorecards | `scores.jsonl` | High within-catalog; sim ≠ production distribution |
| M2 | Failure classifications | `classify.py` output | High for deterministic buckets |
| M3 | Judge-vs-human calibration drift | monthly calibration set | High |

**Confidence policy:** deterministic signals feed automation directly.
Human-behavior signals feed automation after deterministic extraction (a
fixup diff is deterministic even though its cause needs interpretation).
LLM-extracted and field-side signals are *evidence for the weekly digest*,
never direct inputs to any prompt-injectable store.

---

## 3. Learning surfaces

What can be improved, ordered by (impact × feasibility) in this data regime.
Each row names the improver mechanism defined in §4–§7.

| Rank | Surface | Lives at | Signal inputs | Mechanism | Gate |
|------|---------|----------|---------------|-----------|------|
| 1 | **Skills** (SKILL.md content) | osi-os `.claude/skills/` | S5, S7, H2, H4, H7, M2 | `propose_skill_edits.py` extended to production evidence (§4.4) | Human applies |
| 2 | **Skill index descriptions** (selection triggers) | `forge/skill_index.py` index text | S7 (selection misses), S8, backstop flags | selection-accuracy report → description-sharpening proposal | Human applies |
| 3 | **Request interpretation layer** (phrasebook + plan-schema interpretation) | `plan_system.md` assembly + `memory/phrasebook.json` | H6, F3, F2 | §6 | Human approves entries |
| 4 | **Simulation catalog** (new sims from production) | `forge/tests/simulation/catalog.py` | any "interesting" job (§7.1 criteria: first-of-cell, fix-cycled, failed, fixup-heavy, injection) | `promote_simulation.py` drafts a catalog entry; goldens derived from the *human-corrected* merged outcome | Human approves; field text paraphrased (public repo) |
| 5 | **Gate patterns** (FP/FN tuning) | `forge/gates.py` | S2 warnings × H1/H2 (merged-unchanged ⇒ FP evidence), H4 `GATE:` verdicts, human-caught misses ⇒ FN | FP/FN ledger → proposal = failing Tier-A test + patch (test-suite discipline) | Human applies; Tier A+B must stay green |
| 6 | **AGENTS.md** (cross-domain staleness) | osi-os / osi-server `AGENTS.md` | fact-provenance failures across ≥2 skill domains (existing §6.3 of test suite) + S10 path staleness | staleness report → AGENTS.md diff proposal | Human applies |
| 7 | **Prompt templates** (`plan_system.md`, `exec_preamble.md`, `review_system.md`) | `osi-server/forge/prompts/` | outcome patterns per prompt version (version stamping §5.2), H2/H4 clusters not attributable to any skill | single-variable change discipline (§8.4); validated in simulation before production | Human applies; one template change per embargo window |
| 8 | **Quality thresholds** (rubric pass/fail calibration) | `rubrics.py` thresholds | production rubric scores × human outcome labels (merged-clean / merged-with-fixups / rework / rejected) | quarterly calibration report (§7.3) — needs ~30–50 labeled jobs | Human applies |
| 9 | **Pipeline configuration** (model, reasoning effort, budgets, timeouts per category) | `forge/config.py` + `pipeline_config.json` (new, versioned) | S11 telemetry × quality outcomes per category | config-trial protocol (§7.2) | Human approves trial AND adoption |

Ranks 1–4 work from week one. Ranks 5–6 trigger rarely but matter when they
do. Ranks 7–9 need the most data and the most discipline; they are Phase C
(§9).

---

## 4. The production learning cycle

### 4.1 Overview

```
job completes (PR_OPEN or AGENT_FAILED)
  │
  ├─ (1) extract_signals.py — reads the job dir + CLI envelopes,
  │      writes one row per signal to forge-memory.db      [automatic, per job]
  │
  ├─ (2) archive — redacted, compressed copy of the job dir to
  │      memory/archive/ before the 7-day prune             [automatic, per job]
  │
  ├─ (3) harvest_github.py — daily poll of open agent PRs:
  │      merge state, review comments, fixup diffs, latency [automatic, daily]
  │
  ├─ (4) classify_production.py — assigns each job an outcome label +
  │      failure/weakness/success signatures                [automatic, daily]
  │
  ├─ (5) digest.py — weekly: clusters signals → drafts lessons,
  │      proposals, phrasebook candidates, sim candidates →
  │      one markdown digest for the operator               [automatic, weekly]
  │
  └─ (6) HUMAN weekly review (~45 min): approve/reject each item.
         Approved items are committed (skills, catalog, prompts, gates)
         or activated (phrasebook, precedent pool, config trial).
         │
         └─ (7) next nightly simulation + next production jobs run with
                the new versions; version stamps make the effect
                attributable; regression tripwire watches (§8.4).
```

Steps 1–5 are code. Step 6 is the only place knowledge becomes behavior.
Step 7 closes the loop with measurement.

### 4.2 Signal extraction — `forge/learning/extract_signals.py`

**READS:** the completed job directory (`request.json`, `plan.json`,
`gate-pre.json`, `execution-report.md`, `gate-post.json`, `review.json`,
`verification-results.json`, `fix-instructions.md` if present, CLI logs for
the result envelopes).
**COMPUTES:** signals S1–S12 as structured rows; the job's **version stamp**
(§5.2); touched-surface tags via the existing surface→skill map; the
interpretation record from `plan.json.request_interpretation` (§6.2).
**WRITES:** one `jobs` row + N `signals` rows to
`/home/forge-runner/memory/forge-memory.db`; a redacted compressed job-dir
archive to `/home/forge-runner/memory/archive/<job-id>.tar.gz` (using the
test suite's redaction filter — same code path as the replay corpus).
**ACTOR:** the controller calls it in the job-cleanup step. No human.

### 4.3 GitHub harvest — `forge/learning/harvest_github.py`

**READS:** open + recently closed `agent/*` PRs on osi-os via `gh` (the
controller's GitHub App token; read-only calls).
**COMPUTES:**
- H1 merge state; H5 latency and review rounds.
- H2 fixup diff: `git diff <last-agent-commit>..<merge-commit>` restricted to
  the PR branch, attributing commits by author. Non-empty ⇒ a `human_fixup`
  signal whose payload is the diff (redacted) and per-file line counts.
- H4/H6/H7: review comments. Comments with structured prefixes are parsed
  deterministically — the repo adopts three reviewer conventions,
  documented in the forge README and the PR-body reviewer checklist:
  - `INTERPRETATION: <correction>` — the forge misread the request; correction
    text is the fixed mapping.
  - `LESSON: <statement>` — operator hands the loop an explicit lesson.
  - `GATE: noise` / `GATE: valid` — verdict on a gate warning flagged in the
    PR body.
  Unprefixed comments are batched into a single weekly Claude call
  (`--json-schema`, categories aligned with the Layer 3 rubric items;
  ≤$0.50/week) whose output is marked `confidence: medium`.
- H3 follow-up commits: `git log --since=<merge+7d> -- <touched files>` on
  main, flagged when the message references the PR/issue.
**WRITES:** `signals` rows; updates the `jobs` row (`pr_outcome`,
`merge_latency_h`, `human_fixup_lines`, `interpretation_corrected`).
**ACTOR:** daily cron under forge-runner. No human.

### 4.4 Production classification — `forge/learning/classify_production.py`

Extends the existing `classify.py` from failures-only to all outcomes.
**READS:** `jobs` + `signals` for jobs newly reaching a final human state.
**COMPUTES:** exactly one **outcome label** per job:

```
MERGED_CLEAN        merged, no fixup commits, no must-fix comments
MERGED_WITH_FIXUPS  merged, human fixup diff non-empty or must-fix comments
REWORKED            merged only after substantial human rework (>30% of diff)
REJECTED            PR closed unmerged
AGENT_FAILED        never reached PR (existing failure buckets apply)
```

plus zero or more **signatures** — the same `(skill|surface, rule)` scheme
the basic loop uses, now with three kinds:

- `failure` signatures: unchanged from `classify.py` (SKILL_GAP / MODEL_FAILURE
  / GATE_DEFECT / HARNESS_DEFECT), now also produced from production evidence:
  a fix cycle (S6), a human fixup (H2), or a must-fix comment (H4) each map to
  the rubric item / skill rule they violated, using the same surface→skill map.
- `weakness` signatures: the job succeeded but needed correction — the fix
  cycle's instructions or the fixup diff name what was weak.
- `success` signatures: MERGED_CLEAN jobs record the (category, skills
  injected, register, config_id) tuple that worked. These are the positive
  examples the precedent pool (§5.4) and the config analytics (§7.2) consume.

**WRITES:** `jobs.outcome_label`; `lessons` candidate rows keyed by signature
(status `candidate`), each accumulating evidence job-ids.
**ACTOR:** daily cron. No human.

**Threshold change vs the basic loop:** signature accumulation still applies,
but the trigger is tiered by evidence strength, not a flat ≥3:

| Evidence | Trigger for a proposal |
|----------|----------------------|
| Human fixup diff or `LESSON:` comment | **1 occurrence** — a human already adjudicated it |
| Fix-cycle or must-fix review finding | 2 occurrences, same signature |
| Simulation-only or heuristic signal | 3 occurrences (unchanged) |

### 4.5 The weekly digest — `forge/learning/digest.py`

**READS:** the week's `jobs`, `signals`, `lessons` (candidates), open
`proposals`, `scores.jsonl` trends, `config_trials` in flight.
**COMPUTES:** clusters candidate lessons by signature; for each cluster past
its trigger threshold, drafts the artifact the human will act on:
- skill-edit proposals (via the existing `propose_skill_edits.py`, now fed
  production evidence hunks — fixup diffs and review comments are attached
  verbatim as evidence, exactly like simulation hunks are today);
- skill-index description sharpenings (selection-miss report per skill:
  selected-when-needed rate, selected-when-not-needed rate, with the request
  texts that were misrouted);
- phrasebook candidates (§6.4) and case-file drafts (§5.3);
- simulation-catalog candidates (§7.1);
- gate FP/FN items with drafted test case + patch;
- AGENTS.md staleness items;
- config-trial suggestions when a category's telemetry supports one (§7.2).
**WRITES:** `/home/forge-runner/memory/digests/<ISO-week>.md` — a single
document, hard-capped at the top by a **proposal budget of 5 items/week**
(overflow queues to next week, highest evidence first), plus the individual
proposal files in `memory/proposals/`.
**ACTOR:** cron writes it; **the operator reads it weekly** — this is the
human gate. Every item has three buttons' worth of choices: apply (commit the
diff / approve the entry), reject (recorded — trains the proposer's
calibration, H8), defer.

### 4.6 Worked example, end to end

**Week 31, job `req-7c2e`.** Field request from kaba100 (register: farmer):

> *type: bug, area: history, severity: annoying*
> *"The dashboard says the watering ran 0 minutes yesterday but the water
> definitely came, I was standing there. The plants got water."*

1. **Planning.** Claude's `request_interpretation` (§6.2):
   `normalized_statement: "History view renders a 0-duration irrigation entry
   for a completed STREGA timed open; likely a null-vs-zero confusion between
   valve_actuation_expectations observed timestamps and the display layer"`,
   `register: farmer`, `ambiguity: medium`, `assumed_mappings:
   [{"the watering" → "STREGA valve actuation / irrigation history entry",
   confidence: high}]`. Skills: `osi-react-gui-patterns`,
   `osi-agronomy-sensors-reference`. risk_class 1.
2. **Execution + review.** Codex renders `0 min` when the observed-close
   timestamp is null. Review returns `fix`: "null observed duration must
   render as unavailable, not 0 — missing data must look missing."
   Fix cycle succeeds; verdict `approve`; PR opens. The PR body carries the
   interpretation block for the reviewer to confirm.
3. **Signals written at job end** (`extract_signals.py`): S6 fix-cycle with
   instructions text; version stamp (skills_sha `a1b2c3d`, prompts v3,
   config_id `cfg-7`, opus-4.8/codex-5.5); interpretation record.
4. **Human review on GitHub.** The operator merges after one fixup commit —
   they replaced the agent's new inline duration formatter with the existing
   shared helper — and leaves two comments:
   - `LESSON: check for an existing formatter/helper before adding one —
     precedent-copying applies to utils, not just auth blocks.`
   - `INTERPRETATION: correct.`
5. **Harvest (next morning).** H2 fixup diff (−18/+6 lines, file-level:
   the component file), H7 lesson, H6 confirmation. `classify_production.py`
   labels the job `MERGED_WITH_FIXUPS` with signatures:
   - `weakness(osi-react-gui-patterns, copies-precedent)` — evidence: fixup
     diff + LESSON comment → **trigger at 1 occurrence** (human-adjudicated).
   - `weakness(osi-react-gui-patterns, missing-data-rule)` — evidence: the
     fix cycle. The skill *does* document the rule prominently → routed as
     MODEL_FAILURE-leaning; recorded, no skill proposal, but it increments the
     rule's "prominence pressure" counter (if the same clearly-documented rule
     is violated across ≥3 jobs, the digest proposes moving it into
     `osi-common-pitfalls`, the always-inject card — prominence, not content,
     is the lever for model failures).
   - `success(interpretation, farmer→actuation-history)` — confirmed mapping.
6. **Weekly digest** presents four items:
   1. Skill proposal: add to `osi-react-gui-patterns` service-layer section —
      *"Before adding any formatter/util, grep `src/utils/` and the nearest
      similar component for an existing helper; copying precedent applies to
      helpers (playbook §4)."* Evidence: req-7c2e fixup diff attached.
   2. Phrasebook candidate: `"the watering" → STREGA valve actuation /
      irrigation history (register: farmer)` — source req-7c2e, human-confirmed.
   3. Case-file draft `memory/cases/case-0031.md` (§5.3).
   4. Simulation candidate `SIM-C1-04` — the request paraphrased (public
      repo), goldens derived from the merged PR: expect
      `osi-react-gui-patterns`, expect files `web/react-gui/src/**`, code
      rubric items "null duration renders unavailable" and "reuses existing
      duration helper".
7. **Operator applies all four** (~10 minutes). The skill edit and catalog
   entry are commits to osi-os / osi-server; the phrasebook entry and case
   file flip to `approved`, entering the planning-prompt injection pool.
8. **Validation.** Next nightly run scores SIM-C1-04; the next
   farmer-register production job gets the phrasebook line and the case as a
   precedent. If SIM-C1-04's "reuses existing helper" item passes 5/5, the
   lesson row flips `candidate → codified`, closing the loop. Recurrence of
   the same signature after codification is the primary failure metric (§10).

---

## 5. Institutional memory architecture

### 5.1 Four layers, one promotion path

```
Layer 0  Raw artifacts     memory/archive/<job>.tar.gz   forever (redacted, ~1MB/job)
Layer 1  Structured ledger memory/forge-memory.db        SQLite, the queryable truth
Layer 2  Distilled memory  memory/cases/*.md,            injectable, human-approved
                           memory/phrasebook.json
Layer 3  Codified knowledge .claude/skills/, AGENTS.md,  the repos — versioned,
                           forge/prompts/, catalog.py,    reviewed, what every
                           gates.py, pipeline_config.json future job runs on
```

Knowledge moves **only upward and only through the weekly human gate**
(Layer 1 → 2 and 2 → 3 both require operator approval; Layer 0 → 1 is
automatic because it is inert — nothing reads the ledger into a prompt).

**Privacy boundary:** Layers 0–2 live on the runner
(`/home/forge-runner/memory/`, backed up nightly to the operator's
workstation via the existing backup path) and are **never committed** — they
contain field-derived text. Layer 3 is public-repo content; anything promoted
into it is paraphrased/redacted (the simulation-candidate drafter and skill
proposer both run the redaction filter and the digest flags any verbatim
field text for the human to rewrite).

### 5.2 The ledger — `forge-memory.db` schema

SQLite (house style — same engine as the edge). Owned by
`forge/learning/ledger.py`; created via ordered DDL in
`forge/learning/schema.sql`; all writers go through the module.

```sql
CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,           -- req-<shortid>
  request_uuid TEXT, created_at TEXT,
  risk_class INTEGER, area TEXT, register TEXT, language TEXT,
  surfaces TEXT,                     -- JSON array of surface tags from the diff
  skills_injected TEXT,              -- JSON array
  -- version stamp: everything that influenced this job
  skills_sha TEXT,                   -- osi-os HEAD the skills were read at
  prompts_version TEXT,              -- forge/prompts/ content hash
  config_id TEXT,                    -- pipeline_config.json version
  plan_model TEXT, exec_model TEXT, review_model TEXT,  -- exact ids from envelopes
  -- outcome
  terminal_state TEXT, fix_cycles INTEGER, outcome_label TEXT,
  pr_url TEXT, merge_latency_h REAL, human_fixup_lines INTEGER,
  interpretation_corrected INTEGER,  -- 0/1/NULL(no verdict)
  cost_usd REAL, wall_s INTEGER
);
CREATE TABLE signals (
  id INTEGER PRIMARY KEY, job_id TEXT REFERENCES jobs(job_id),
  type TEXT,                         -- S1..S12, H1..H8, F1..F3, M1..M3
  payload TEXT,                      -- JSON, redacted
  confidence TEXT,                   -- high | medium | low
  provenance TEXT,                   -- deterministic | human | llm | field-untrusted
  created_at TEXT
);
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY,
  signature TEXT,                    -- e.g. "weakness(osi-react-gui-patterns,copies-precedent)"
  kind TEXT,                         -- success | weakness | failure | interpretation
  statement TEXT,                    -- one-sentence lesson
  evidence_jobs TEXT,                -- JSON array of job_ids
  status TEXT,                       -- candidate | proposed | codified | rejected | retired
  codified_in TEXT,                  -- commit sha / file once applied
  created_at TEXT, decided_at TEXT
);
CREATE TABLE proposals (
  id INTEGER PRIMARY KEY, lesson_id INTEGER,
  target TEXT,                       -- skill|index|agents|prompt|gate|catalog|threshold|config|phrasebook|case
  artifact_path TEXT,                -- the drafted diff/file in memory/proposals/
  status TEXT,                       -- open | applied | rejected | deferred
  decided_by TEXT, decided_at TEXT
);
CREATE TABLE pass_telemetry (
  id INTEGER PRIMARY KEY, job_id TEXT,
  pass TEXT,                         -- plan|exec|review|fix|escalate|judge
  model_id TEXT, reasoning TEXT, budget_usd REAL,
  cost_usd REAL, wall_s INTEGER, outcome TEXT
);
CREATE TABLE config_trials (
  id INTEGER PRIMARY KEY, config_id TEXT, hypothesis TEXT,
  scope TEXT,                        -- category the trial applies to
  sim_baseline TEXT, sim_trial TEXT, -- JSON scorecard summaries
  prod_jobs TEXT,                    -- JSON job_ids in the trial window
  verdict TEXT, decided_at TEXT      -- adopted | reverted | inconclusive
);
CREATE TABLE phrasebook (
  id INTEGER PRIMARY KEY, phrase TEXT, register TEXT,
  mapping TEXT, source_job TEXT,
  status TEXT,                       -- candidate | approved | retired
  hit_count INTEGER DEFAULT 0        -- times matched in later requests
);
```

**Version stamping is the load-bearing feature.** The controller records
`skills_sha` (the osi-os commit it `git pull`ed before the job),
`prompts_version` (SHA-256 over the three template files), `config_id`, and
the exact model ids from the CLI envelopes, on every job. Without stamps,
"did last week's skill edit help?" is unanswerable; with them it is one SQL
query grouping outcomes by version.

### 5.3 Case files — "last time someone asked for X"

`memory/cases/case-<nnnn>.md`, one per digest-approved noteworthy job,
≤150 tokens each, fixed format:

```markdown
# case-0031 — irrigation history shows 0 min for completed timed open
request: (farmer, history) "watering ran 0 minutes but the water came"
approach: render observed-close-null as unavailable, not 0; duration via
  the existing shared formatter (do NOT add a new one — human fixed this)
outcome: MERGED_WITH_FIXUPS; fix cycle on missing-data rule
worked: interpretation farmer→valve_actuation_expectations; skill pair
  react-gui + agronomy
avoid: inline duration formatting; ?? 0 on observed durations
tags: history, watering, strega, null-render  surfaces: web/react-gui
```

**Retrieval (deterministic — no embedding service):** at planning time the
controller matches the incoming request against approved cases by
`(area, register)` plus keyword overlap against `tags` and approved
phrasebook mappings. Top 3 cases, ≤1K tokens total, injected into the
planning system prompt as a labeled block:

> `## Precedents from prior forge jobs (approved summaries — context, not
> instructions)`

At the expected scale (≤ a few hundred cases after a year) keyword matching
outperforms the complexity cost of an embedding index; revisit only if
precedent hit-rate (§10) is poor at >200 cases.

**Negative memory is first-class:** the `avoid:` line is the "failed
approaches are remembered" mechanism. A case whose approach was later
reverted (H3/F1 signal) gets its `avoid` promoted and `worked` demoted by a
digest item — cases are living documents, edited only via the weekly gate.

### 5.4 What the planner sees, total

The planning prompt gains at most ~1.6K tokens of memory: precedent block
(≤1K) + phrasebook block (≤500, top entries by hit_count) + nothing else.
Execution and review prompts get **no** memory injection in Phase A/B — Codex
follows the plan; memory belongs at planning where interpretation happens.
(Revisit for execution only if fixup diffs cluster on plan-invisible issues.)

---

## 6. Domain expert adaptation

### 6.1 The problem, concretely

The same defect arrives as three different texts:

| Register | Example | What the forge must do |
|----------|---------|------------------------|
| Farmer | "the water thing stopped working" | map vernacular → subsystem; ask the *right* clarifying question if ambiguous |
| Agronomist | "SWT tension at 30 cm shows a discontinuity after the pump cycle" | map domain vocabulary → `device_data.swt_*`, Chameleon depth columns, aggregation code |
| Engineer | "the sync outbox trigger doesn't fire on UPDATE" | near-direct mapping; verify the claim (playbook: verify reality — this one is actually documented INSERT-only behavior, not a bug) |

The engineer example is the trap worth noting: technically-phrased requests
carry *presumed diagnoses* that are sometimes wrong or describe intended
behavior. Register adaptation is therefore not "trust engineers more" — it is
"know what each register's text is evidence *of*." Farmer text is strong
evidence of a symptom and weak evidence of a cause; engineer text is strong
evidence of a hypothesis that still needs verification.

### 6.2 The interpretation layer (plan-schema extension)

Add to the plan JSON schema (Stage 1 spec §Pass 1), all fields required:

```json
"request_interpretation": {
  "type": "object",
  "required": ["normalized_statement", "register", "ambiguity", "assumed_mappings"],
  "properties": {
    "normalized_statement": { "type": "string" },
    "register": { "type": "string", "enum": ["farmer", "agronomist", "engineer", "mixed"] },
    "language": { "type": "string" },
    "ambiguity": { "type": "string", "enum": ["low", "medium", "high"] },
    "assumed_mappings": { "type": "array", "items": { "type": "object",
      "required": ["phrase", "technical_meaning", "confidence"],
      "properties": {
        "phrase": { "type": "string" },
        "technical_meaning": { "type": "string" },
        "confidence": { "type": "string", "enum": ["low", "medium", "high"] } } } }
  }
}
```

Behavioral rules added to `plan_system.md`:
- The normalized statement is the planner's restatement in repo-technical
  terms; the fenced original remains the only authority-free evidence.
- `ambiguity: high` + any `confidence: low` mapping on a load-bearing phrase
  ⇒ the plan must set `escalation_needed: true` or conclude needs-info —
  matching the SIM-C4-01 rubric ("confidently inventing a fix for a vague
  report is the failure mode").
- For engineer-register requests: the stated diagnosis is a hypothesis; the
  plan must cite `file:line` evidence confirming or refuting it before
  building on it (this is just playbook §2 applied to the register).

**The PR body renders the interpretation block** with a one-line reviewer
instruction: *"If any mapping is wrong, reply `INTERPRETATION: <correction>`."*
That single convention converts every human review into labeled
interpretation data (H6) at near-zero reviewer cost.

### 6.3 Learning from confirmations and corrections

**READS:** H6 signals + the job's `assumed_mappings`.
**COMPUTES:**
- Confirmed high-confidence mappings on merged jobs → phrasebook candidates.
- Corrections → immediate digest items (1-occurrence trigger — human
  adjudicated): fix the phrasebook entry if one misled the planner, or add a
  disambiguation note.
- Per-register calibration: of mappings the planner marked `high` confidence,
  what fraction were corrected? If farmer-register high-confidence mappings
  are corrected >20% of the time, the digest proposes a `plan_system.md` line
  raising the planner's caution for that register (a prompt-surface change,
  so it rides the §8.4 embargo discipline).
**WRITES:** `phrasebook` rows (status `candidate`), lesson rows kind
`interpretation`.

### 6.4 The phrasebook

`memory/phrasebook.json` — approved entries only are injected:

```json
{ "phrase": "the water thing", "register": "farmer",
  "mapping": "STREGA valve / watering subsystem (valve_actuation_expectations, schedules)",
  "hit_count": 4 }
```

Injection: a `## Field vocabulary (approved mappings from prior requests)`
block in the planning system prompt, top ~25 entries by hit_count, ≤500
tokens. `hit_count` increments when a later request contains the phrase and
the job merges without an interpretation correction — so useful entries rise
and stale ones sink; entries at 0 hits after 90 days are proposed for
retirement in the digest.

**Poisoning rail (see §8.3):** phrases originate in untrusted field text.
Candidates are quoted in the digest inside a fenced block with
`provenance: field-untrusted`; only the human's approval moves them into the
injected pool, and the injected form is the *human-approved* text, not the
raw submission.

### 6.5 NEEDS_INFO question templates per register

Vague requests currently dead-end as issue-only. The loop learns better
clarifying questions: when a NEEDS_INFO request later returns with the
missing detail and succeeds, the (register, area, question-that-worked)
triple is recorded; the digest accumulates these into
`forge/prompts/needs_info_templates.md` — e.g. farmer-register questions ask
"which screen were you on, which zone, roughly when" rather than "provide
reproduction steps." Stage 0's NEEDS_INFO UX is the delivery channel; this
file is just its content, human-gated like every prompt surface. (Lowest
priority in §9 — needs the NEEDS_INFO round-trip to exist first.)

### 6.6 i18n

Requests may arrive in any GUI locale (incl. Luganda). The planner records
`language` and normalizes into English in `normalized_statement`; the
original stays verbatim in the PR body. Phrasebook entries are
per-language-phrase (the farmer vocabulary that matters is the one actually
used). No machine-translation infrastructure is added — the planning model
handles translation, and the interpretation-correction loop catches its
mistakes the same way it catches register mistakes.

---

## 7. Pipeline self-optimization

### 7.1 Simulation catalog growth (the cheapest optimization: better tests)

**Promotion criteria** — `promote_simulation.py` drafts a catalog candidate
when a production job is any of: (a) first job in a `(risk_class, surface)`
cell with no catalog coverage; (b) had a fix cycle; (c) AGENT_FAILED;
(d) MERGED_WITH_FIXUPS/REWORKED; (e) sanitizer/injection hit;
(f) interpretation corrected.
**READS:** the job's request, plan, diff, review, human fixups.
**COMPUTES:** a `Simulation` dataclass draft — request text **paraphrased**
(one Claude call + human check; the catalog is in a public repo and field
text is both untrusted and potentially identifying); golden expectations
derived from the **human-corrected end state** (the merged PR's skills,
files, and the fixup content become rubric items — the human fixup literally
writes the rubric: "reuses existing duration helper").
**WRITES:** `memory/proposals/sim-<id>.py` for the digest.
**ACTOR:** human approves and commits to `catalog.py`. Golden expectations
are never machine-committed — a forge that writes its own exam can grade
itself up (§8.2).

This is how the catalog stops being 18 hand-written guesses and becomes a
regression suite of everything the forge has ever gotten wrong in the field —
the same philosophy as the test-suite's fixture-corpus bootstrap (§8.4
there), extended for the life of the system.

### 7.2 Configuration tuning — the trial protocol

**Telemetry (automatic, from day one):** every pass writes a
`pass_telemetry` row (§5.2) from the CLI envelope. Categories are coarse on
purpose for this data regime: `class-0`, `class-1-gui`, `class-1-flows`,
`class-2`.

**Analytics (automatic, monthly or per-30-jobs, in the digest):** per
category — mean cost, p90 wall clock, fix-cycle rate, outcome-label
distribution, broken down by config_id and model_id. This is descriptive
only. No bandits, no auto-tuning: at 5–20 jobs/week the variance swamps any
online-learning scheme; humans reading a monthly table outperform it.

**Trial protocol (human-approved, one at a time globally):**

1. The digest proposes a hypothesis with evidence, e.g. *"class-0 jobs
   (n=14, 100% MERGED_CLEAN) ran Codex at xhigh reasoning, mean $4.10/job;
   sim class-0 entries pass 5/5 at medium reasoning in the shadow run —
   propose dropping class-0 exec reasoning to medium."*
2. **Simulation shadow first:** re-run the relevant catalog subset (N=5)
   under trial config `cfg-8`. Gate: zero safety-invariant change, no rubric
   mean drop >5 points vs the same night's baseline config run.
3. **Bounded production trial:** the next 8 class-0 jobs run `cfg-8`
   (stamped). Class-2 jobs are **never** trial subjects.
4. **Verdict at the next monthly review:** compare outcome labels, fix-cycle
   rate, human_fixup_lines, cost between trial jobs and the trailing baseline
   window. Adopt (config committed to `pipeline_config.json`, new default) or
   revert. Inconclusive after one extension window ⇒ revert (default to the
   known state).

`pipeline_config.json` (new, in `osi-server/forge/`, versioned in git):

```json
{ "config_id": "cfg-7",
  "categories": {
    "class-0":       { "exec_reasoning": "high",  "plan_budget_usd": 1.0, "exec_timeout_s": 1800 },
    "class-1-gui":   { "exec_reasoning": "high",  "plan_budget_usd": 2.0, "exec_timeout_s": 3600 },
    "class-1-flows": { "exec_reasoning": "xhigh", "plan_budget_usd": 2.0, "exec_timeout_s": 3600 },
    "class-2":       { "exec_reasoning": "xhigh", "plan_budget_usd": 2.0, "exec_timeout_s": 3600,
                       "escalation_default": true } } }
```

### 7.3 Threshold calibration (Phase C — needs the most data)

The Layer 3 rubric thresholds (plan ≥70, evidence ≥80, …) are currently
educated guesses. Calibration mechanism:
**READS:** deterministic rubric items run post-hoc on every *production*
job's artifacts (cheap — no LLM; the judge runs only on the extremes:
MERGED_CLEAN and REJECTED/REWORKED jobs, to bound cost) × the human outcome
labels.
**COMPUTES:** quarterly, once ≥30 labeled jobs exist: score distributions per
outcome label. The question is separation — does evidence_score actually
distinguish MERGED_CLEAN from REWORKED? Output: a confusion table per rubric
dimension and, where separation exists, a proposed threshold that would have
flagged the REWORKED jobs pre-review.
**WRITES:** a calibration report in the digest; threshold changes are diffs
to `rubrics.py`, human-applied.
**Also computed here:** rubric items with *no* separation across 50+ jobs are
proposed for demotion (dead weight in the score) — the rubric itself is a
learning surface.

### 7.4 Model-upgrade watch (automatic restriction — the one auto-action)

The Stage 1 spec pins model *aliases* (`opus`, `codex-5.5`), so upgrades
arrive unannounced. `extract_signals.py` compares each envelope's model id to
the last seen id per pass. On change:
1. Alert the operator (dashboard red banner + the liveness webhook).
2. **Auto-quarantine class-2:** the controller stops claiming class-2 jobs
   (they stay AWAITING_AGENT) until the full simulation catalog has been
   re-run under the new model and the operator acks the per-category diff.
   Class-0/1 continue (human review backstops them; the catalog re-run is
   scheduled the same night).
3. The scorecard diff is annotated with the model change (the test-suite §6.4
   trend mechanism), so a regression is attributed to the model, not to
   whatever skill edit landed the same week.

This is permitted automation because it only *restricts* (§8.1 asymmetry).

---

## 8. Safety rails for self-learning

### 8.1 The asymmetry principle

> **The loop may automatically restrict; only a human may loosen or teach.**

Automated without a human: telemetry, extraction, classification, drafting,
scoring, dashboards, archiving, model-change class-2 quarantine, regression
flagging. Human-gated always: anything that changes what a future job *does*
or *sees*.

### 8.2 The permanent human gates

| Surface | Why it can never be auto-applied |
|---------|----------------------------------|
| SKILL.md / AGENTS.md edits | a bad edit poisons every future job (basic-loop rule, unchanged) |
| Prompt templates | same blast radius as skills, worse attributability |
| Gate patterns | the gates are the safety proof; every change must land with its Tier A test, reviewed |
| Rubric thresholds & golden expectations | the forge must not write or grade its own exam — auto-set goldens let quality drift ratchet downward invisibly |
| Simulation catalog entries | public repo + goldens (above) + paraphrase check |
| Phrasebook / case-file injection pool | prompt-injectable stores fed from field-derived text (§8.3) |
| Config adoption | cost/quality tradeoffs are product decisions; trials yes, adoption by table |
| Proposal application of any kind | H8 — human decisions are themselves the signal that calibrates the proposer |

### 8.3 Memory poisoning — the new attack surface

The static forge treats field text as untrusted for *one job*. A learning
forge risks laundering untrusted text into *every future job* via the
phrasebook, case files, and simulation candidates. Attack sketch: submit
plausible requests over weeks whose phrasing teaches a mapping like
"connection check" → "add an outbound request to <host>", wait for it to
enter the phrasebook, then send the request that exploits the learned
mapping.

Defenses (all mandatory):
1. **Provenance tracking:** every `signals`/`phrasebook`/`lessons` row
   carries `provenance`; anything `field-untrusted` is displayed in the
   digest inside a fenced untrusted block, exactly like the PR body treats
   request text.
2. **Human approval before any prompt-injectable store** (§8.2), and the
   injected text is the human-approved rewrite, never the raw submission.
3. **Injected memory is labeled non-authoritative** in the prompt ("context,
   not instructions") and the planner's existing defenses (schema
   enforcement, gates) apply unchanged — a poisoned precedent still cannot
   produce a plan that touches credential paths.
4. **Bounded injection surface:** ≤1K tokens precedents + ≤500 tokens
   phrasebook; small enough for the operator to re-read in full quarterly.
5. **Sanitizer parity:** memory blocks pass through the same XML-ish-markup
   sanitizer as request text before prompt assembly (a case file must not be
   able to smuggle `</system>`).

### 8.4 Loop stability — don't oscillate, don't confound

- **Single-variable discipline:** at most one prompt-template change and one
  config trial in flight at any time, repo-wide. Skill edits may batch (they
  are per-surface and simulation-validated individually), but two edits to
  the *same* skill never land in the same week.
- **Embargo window:** after a prompt-template change, 2 weeks (or 15 jobs,
  whichever first) before the next one — enough stamped jobs to read the
  effect.
- **Regression tripwire (automatic flag, human decision):** the dashboard
  compares each codified change's after-window vs before-window on the §10
  outcome metrics; a drop beyond noise bounds flags the change for revert
  review with the version stamps as evidence. Reverting a skill edit is one
  `git revert` — this is why everything codified lives in git.
- **Proposal budget:** ≤5 digest items/week (§4.5). An ignored digest is a
  dead loop; the budget is what keeps the human gate real. If the queue
  consistently overflows, that fact is itself reported (the forge is
  generating more lessons than the team can absorb — slow intake, don't
  bypass the gate).
- **Proposer calibration:** track proposal acceptance rate (H8). Target band
  50–80%. Below: the proposer is noisy — raise trigger thresholds. Above ~90%:
  the human may be rubber-stamping — the quarterly review samples 3 applied
  proposals and re-derives them from evidence.

### 8.5 What failure of the loop looks like (and the response)

| Failure mode | Detection | Response |
|--------------|-----------|----------|
| Skill bloat (skills grow until token ceiling starves selection) | FM-04 token warnings + selection-drop warnings trend | digest proposes *removals* — every skill edit proposal must state what it displaces; quarterly skill-length review |
| Lesson churn (codify → revert → recodify) | same signature codified twice | freeze the signature; escalate to a human root-cause (usually MODEL_FAILURE misclassified as SKILL_GAP) |
| Overfitting to the catalog | sim scores rise while production fixup lines don't fall | §10 pairs every sim metric with its production twin; production wins |
| Digest ignored | proposal queue age > 21 days | dashboard red; intake pause recommendation |

---

## 9. Implementation roadmap

Ordered by dependency and by how much production data each mechanism needs.
Phase A ships with (or immediately after) the first Stage 1 jobs — **you
cannot learn from data you did not record.**

### Phase A — record everything (build now; needs 0 jobs)

| # | Deliverable | Where | Notes |
|---|-------------|-------|-------|
| A1 | `forge/learning/` package skeleton + `schema.sql` + `ledger.py` | osi-server | SQLite ledger, §5.2 |
| A2 | **Version stamping** in the controller (skills_sha, prompts_version, config_id, model ids per envelope) | `controller.py`/`pipeline.py` | the one change to Stage 1 code that cannot be retrofitted onto past jobs |
| A3 | `extract_signals.py` wired into job cleanup + archive step | controller | S1–S12 |
| A4 | `request_interpretation` plan-schema extension + PR-body interpretation block + reviewer conventions (`INTERPRETATION:`/`LESSON:`/`GATE:`) documented in forge README | plan schema + `github_pr.py` | §6.2–6.3 |
| A5 | `harvest_github.py` daily cron | runner | H1–H7 |
| A6 | `pipeline_config.json` + `pass_telemetry` capture | config.py | §7.2 telemetry only, no trials yet |

Exit criterion: every job produces a complete `jobs` row with stamps, and a
merged PR produces fixup/comment signals within 24 h.

### Phase B — learn (needs ~10–30 jobs)

| # | Deliverable | Needs |
|---|-------------|-------|
| B1 | `classify_production.py` (outcome labels + tiered triggers §4.4) | ~10 labeled outcomes |
| B2 | `digest.py` weekly digest + proposals dir + budget | B1 |
| B3 | `propose_skill_edits.py` extended to production evidence (fixup diffs, comments as hunks) | B1 |
| B4 | Case files + phrasebook + planning-prompt injection (precedent + vocabulary blocks, sanitizer parity) | first approved entries from B2 |
| B5 | `promote_simulation.py` + paraphrase step | first interesting jobs |
| B6 | Skill-index selection-accuracy report in the digest | ~20 jobs for stable rates |
| B7 | Model-upgrade watch + class-2 auto-quarantine | A6 |

Exit criterion: the worked example of §4.6 can happen end-to-end: a Monday
merge produces a Friday digest item that is applied and validated by the
next nightly run.

### Phase C — optimize (needs ~30–100 jobs and a stable catalog)

| # | Deliverable | Needs |
|---|-------------|-------|
| C1 | Config-trial protocol (shadow sim + bounded production window) | ≥15 jobs in the target category |
| C2 | Threshold calibration report (quarterly) | ≥30 labeled jobs |
| C3 | Prompt-template evolution under embargo discipline | B-phase attribution working |
| C4 | Per-register interpretation calibration → `plan_system.md` adjustments | ≥20 farmer-register jobs |
| C5 | NEEDS_INFO question templates | Stage 0 round-trip UX shipped |
| C6 | Regression tripwire automation | 2+ codified changes with before/after windows |

**Explicitly deferred indefinitely:** embeddings/retrieval infrastructure
(keyword matching until >200 cases *and* poor hit rate), any online/bandit
tuning, any auto-applied change to a prompt-visible surface, cross-repo
learning for osi-server jobs (rides Stage 2).

---

## 10. Metrics — is the learning loop actually working?

Two metric families, deliberately paired: every simulation-side metric has a
production-side twin, and **production wins conflicts** (§8.5 overfitting).

### 10.1 Loop-effectiveness metrics (is learning sticking?)

| Metric | Definition | Target / signal |
|--------|-----------|-----------------|
| **Repeat-signature rate** (headline) | codified lessons whose signature recurs in production within the next 20 jobs | **0.** A recurrence means the codification didn't work — auto-flags the lesson for reclassification (usually SKILL_GAP → MODEL_FAILURE → the lever is prominence or a gate, not prose) |
| Signal-to-codification lead time | median days from first evidence to applied proposal | ≤14 days for human-adjudicated (tier-1) signals |
| Proposal acceptance rate | applied / (applied+rejected) | 50–80% band (§8.4 calibration) |
| Proposal validation rate | applied proposals whose targeted sim/metric recovered in the next window | ≥80%; below ⇒ the classifier is mislabeling |
| Precedent hit rate | jobs where an injected case matched the request's final surfaces | ≥50% of jobs that received precedents; below ⇒ retrieval or case quality is off |
| Phrasebook utility | approved entries with hit_count >0 at 90 days | ≥60%; the rest retire |
| Operator cost | minutes/week on the digest (self-reported, logged in the digest header) | ≤45 min; trending up = budget too high |

### 10.2 Forge-improvement metrics (is the forge getting better?)

Rolling window of **last 20 jobs** (not calendar time — at 5–20 jobs/week,
calendar windows have unstable n; report the count alongside every rate, and
draw no conclusion from n<5 in any cell).

| Metric | Source | Direction |
|--------|--------|-----------|
| **Human fixup lines per merged PR** (headline) | H2 | ↓ — the purest "output quality as judged by reality" number |
| MERGED_CLEAN share | outcome labels | ↑ |
| Must-fix findings per PR (review + human comments) | S5 + H4 | ↓ |
| Fix-cycle rate | S6 | ↓ |
| Interpretation-correction rate (per register) | H6 | ↓ per register; farmer register is the one to watch |
| AGENT_FAILED rate, by bucket | S1 + classification | SKILL_GAP → ~0; the residual should be MODEL_FAILURE (the honest model ceiling) — same "which lever" logic as the test suite §9.3 |
| Re-submission rate (fix didn't fix) | F1 | ~0 |
| Cost per **merged** PR | S11 / H1 | ↓ or flat while quality metrics improve (cost per *attempted* job is a vanity denominator) |
| Merge latency | H5 | ↓, secondary (confounded) |

### 10.3 Unchanged non-negotiables

Safety invariant-hold rate stays 100% and the Trust Score gate for enabling
intake is untouched — the learning loop is measured strictly *on top of* the
test suite's safety floor, never traded against it. The learning dashboard is
a new panel in the existing `dashboard.py` output, not a second dashboard:
panels for repeat-signature rate, fixup-lines trend, proposal queue
age/acceptance, per-register interpretation accuracy, config-trial status,
and the version-stamp annotations on every trend line.

### 10.4 The quarterly meta-review

Once a quarter the operator answers, in writing at the top of that week's
digest: which applied changes demonstrably helped (version-stamped
before/after), which metrics are being gamed or have gone stale
(Goodhart check — metrics are reviewed as a set, and the fixup-lines +
repeat-signature pair is hard to game simultaneously), and whether the
proposal budget and trigger tiers need retuning. The loop's own parameters
are the last learning surface, and they are tuned by the slowest, most
human process in the system — on purpose.
