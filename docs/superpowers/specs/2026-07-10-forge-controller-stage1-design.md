# Forge Controller (Stage 1) — Design

**Date:** 2026-07-10
**Status:** Draft — brainstormed collaboratively, incorporates skill audit
findings from `2026-07-10-forge-skill-audit.md`.
**Scope:** The Stage 1 controller that claims eligible work requests from OSI
Server and runs a three-pass AI pipeline (Claude plan → Codex exec → Claude
review) to produce tested draft PRs. Server-side dispatch API. Skill injection
framework. Deterministic safety gates. Does NOT include deploy wrappers for
test devices (Stage 2) or wider intake tuning (Stage 3).
**Depends on:** Stage 0 (intake/publish pipeline) deployed on the test server.

## Problem

Stage 0 delivers field requests to the server and publishes them as GitHub
issues. Stage 1 closes the loop: an automated runner picks up eligible issues,
plans the implementation, builds and tests it, reviews the result, and opens a
draft PR with evidence. Human merge and production deploy remain mandatory.

The runner must produce code that meets the project's quality standards despite
having zero accumulated context about the codebase. Skills — instruction
documents injected into agent prompts — are the mechanism for transferring
architectural knowledge, conventions, pitfalls, and verification procedures.

## Architecture

```
OSI Server
  /api/v1/forge/jobs/eligible     (poll)
  /api/v1/forge/jobs/{id}/claim   (atomic claim)
  /api/v1/forge/jobs/{id}/report  (result + PR URL)
  /api/v1/forge/jobs/{id}/heartbeat (keep-alive)

forge-controller (Python, runs as forge-runner on test VPS)
  poll → claim → worktree setup
    → Claude CLI (-p, plan pass)
      → plan.json + plan.md + required_skills
    → pre-execution gate (deterministic)
    → Codex CLI (exec, implementation pass)
      → code changes + tests + execution-report.md
    → post-execution gate (deterministic)
    → Claude CLI (-p, review pass)
      → review.json (approve / fix / reject)
    → push agent/* branch + draft PR
    → report result to server

GitHub (osi-os, osi-server)
  Draft PR with issue link + evidence
  Human review → human merge
```

The controller is the only stateful component. Claude and Codex communicate
through files in the job worktree and CLI stdout, never directly.

## Current Decisions

1. **Both CLIs installed.** Claude CLI (`claude -p`) for planning and review
   (structured JSON output, precise prompt control). Codex CLI (`codex exec`)
   for implementation (purpose-built for repo-level code changes with built-in
   sandboxing). Both use the API keys already configured in
   `/home/forge-runner/config/forge.env`.
2. **Python controller** in `osi-server/forge/`. Orchestration-focused: HTTP
   calls, subprocess management, file I/O, JSON parsing. Minimal dependencies
   (httpx, no heavy frameworks).
3. **Claude selects skills during planning, controller injects them into
   Codex.** Claude sees a skill index (~500 tokens) and picks relevant skills
   based on the actual request text. The controller reads the selected SKILL.md
   files and concatenates them verbatim into the Codex execution prompt. Codex
   follows, doesn't re-decide. Claude review also receives the same skills.
4. **Poll + claim.** Controller polls `GET /api/v1/forge/jobs/eligible` every
   5 minutes. Claims a job via `POST /api/v1/forge/jobs/{id}/claim` which
   atomically transitions to `AGENT_PLANNING`. One job at a time.
5. **Lightweight safety-only gates.** The gates protect the push (to a public
   GitHub repo), not the merge. Human reviewers handle code quality, risk class
   appropriateness, and architectural fit. The gates catch only things that
   cause damage before human review: secret leakage, credential paths, CI
   mutation, runaway diffs.
6. **Service-account auth.** The forge controller authenticates to the server
   with a static bearer token (`FORGE_RUNNER_TOKEN`), not a user JWT.
7. **One bounded fix cycle.** If Claude review returns `fix`, Codex gets one
   chance to apply the fix instructions. Claude re-reviews. If still not
   approved, the job fails — no unbounded loops.

## Three-Pass Pipeline

### Pass 1: Claude Planning

Invocation: `claude -p "<prompt>" --model opus --output-format json`

System prompt assembled from:
- Static planning preamble (~300 tokens): role, output schema, "you are
  planning not implementing", truncation rules
- AGENTS.md from the target repo
- Skill index (names + one-line descriptions for all selectable skills)
- Engineering playbook preamble (verify reality, TDD, no placeholders)

User message: the field request text, fenced and labeled untrusted, truncated
to 4000 characters.

Required output schema:

```json
{
  "plan_summary": "One-paragraph summary of the implementation approach",
  "required_skills": ["osi-flows-json-editing", "osi-schema-change-control"],
  "skill_reasoning": "Why these skills are needed",
  "risk_class": 1,
  "target_repo": "osi-os",
  "files_to_touch": ["conf/.../flows.json", "database/migrations/..."],
  "files_do_not_touch": [".github/", "deploy.sh"],
  "tests_to_run": ["node scripts/verify-sync-flow.js", "npm run test:unit"],
  "runtime_verification": "deploy to test edge and check endpoint",
  "plan_md": "# Implementation Plan\n\n## Task 1: ..."
}
```

### Pass 2: Codex Execution

Invocation: `codex exec "<prompt>"` in the job worktree.

Prompt assembled by concatenating (in order):
1. Static execution preamble (~200 tokens): TDD, verify reality, commit per
   task, "follow the plan exactly; stop and report on divergence"
2. Always-inject skills (see §Skill Framework)
3. Selected area skills (from Claude's `required_skills`)
4. AGENTS.md from the target repo
5. `plan.md` from Pass 1
6. Original request text (fenced, untrusted, max 4000 chars)
7. Structural rule: "If an injected skill routes you to a sibling skill not
   present in this prompt, do not guess its contents — note the gap in
   execution-report.md and proceed only if the current skills cover the
   surface you are changing; otherwise stop."

Codex writes: code changes, tests, `execution-report.md` with commands,
outputs, diffs, and verification evidence.

### Pass 3: Claude Review

Invocation: `claude -p "<prompt>" --model opus --output-format json`

Prompt assembled from:
- Static review preamble: verdict schema, finding categories (must-fix /
  should-fix / note per `code-quality-principles`)
- Always-inject skills (same set as execution)
- Selected area skills (same set as execution)
- Original request text + plan.md
- Git diff (`git diff main...HEAD`)
- Test output / execution-report.md

Required output schema:

```json
{
  "verdict": "approve",
  "findings": [
    {
      "severity": "should-fix",
      "file": "web/react-gui/src/pages/SupportRequests.tsx",
      "description": "Missing i18n key for the cancel button label"
    }
  ],
  "fix_instructions": null
}
```

Verdict values: `approve` (push PR), `fix` (one Codex fix cycle, then
re-review), `reject` (job fails with findings).

### Fix Cycle

If review returns `fix`:
1. Controller writes `fix-instructions.md` to the worktree from
   `review.json.fix_instructions`
2. Codex exec runs again with: fix instructions + original plan + the review
   findings
3. Post-execution gate runs again
4. Claude reviews again
5. If verdict is not `approve`, job transitions to `AGENT_FAILED`

Maximum one fix cycle. No unbounded loops.

## Deterministic Gates

### Pre-execution gate (after planning, before Codex)

| Check | Rejects if |
|-------|-----------|
| Scope | `files_to_touch` includes `.github/workflows/` or known credential paths (`.env`, `*_cred*`, SSH keys) |

All other quality concerns (risk class, skill consistency, injection patterns)
are left to the human reviewer. The gate protects the execution environment,
not the merge.

### Post-execution gate (after Codex, before push)

| Check | Rejects if |
|-------|-----------|
| Secret patterns | Diff contains: `Bearer ` + 20 chars, `sk-` + 20 chars, `-----BEGIN`, `password=`, `secret=`, AppKey-like 32-hex |
| Credential paths | Diff touches `.github/workflows/`, `.env`, `*_cred*`, SSH keys |
| Diff size | > 5000 lines changed |
| Branch name | Not `agent/req-<shortid>-<slug>` |

Gate results logged to `gate-pre.json` / `gate-post.json` in the job directory.
A gate failure transitions to `AGENT_FAILED` with the specific check that
failed.

## Skill Framework

### Three tiers

**Always-inject** (every Codex prompt + Claude review prompt):

| Skill | Tokens | Status |
|-------|--------|--------|
| `osi-forge-boundaries` | ~1.5K | **NEW** — safety policy card |
| `osi-common-pitfalls` | ~1.2K | **NEW** — 14 paid-for failure modes |
| `osi-verification-commands` | ~1.5K | **NEW** — per-surface command table |
| `verification-before-completion` | ~1K | Existing superpowers, verbatim |
| TDD forge variant | ~1.5K | Adapted from superpowers TDD |

Baseline overhead: ~6.7K tokens.

**Claude-selects** (planning pass picks by touched surface, cap 3 per job):

| Skill | Select when |
|-------|------------|
| `osi-flows-json-editing` | Any flows.json / Node-RED / edge REST change |
| `osi-schema-change-control` | Any edge SQLite schema/seed/migration change |
| `osi-sync-contract-awareness` | Any sync, outbox, contract, or paired-repo change (**NEW**) |
| `osi-react-gui-patterns` | Any `web/react-gui` change (**NEW**) |
| `osi-server-backend-patterns` | Any osi-server change (**NEW**) |
| `osi-config-and-flags` | UCI/env/flag/bootstrap surface |
| `osi-agronomy-sensors-reference` | Sensor semantics, units, decoders, thresholds |
| `osi-debugging-playbook` | Bug-class requests (informs plan triage) |
| `systematic-debugging` (forge variant) | Bug-class requests (Codex execution) |

**Excluded from forge index entirely:**
- `osi-live-ops-runbook` — teaches SSH/deploy commands the gate scans for
- `osi-hardest-problem-campaign` — placeholder stub
- Superpowers orchestration skills (`executing-plans`, `using-git-worktrees`,
  `finishing-a-development-branch`, `writing-plans`, `brainstorming`,
  `subagent-driven-development`, `requesting/receiving-code-review`) —
  controller owns these mechanics
- Non-engineering Codex skills (`caveman`, `grill-me`, `to-prd`, etc.)

### Skill index for Claude planning prompt

```
Available skills — select by name. Cap: 3 area skills per job.

AREA SKILLS (select when the change touches the named surface):
- osi-flows-json-editing: Script-only flows.json editing. MANDATORY before ANY Node-RED flow change.
- osi-schema-change-control: Edge SQLite migrations, risk classes, frozen boot DDL. MANDATORY before ANY schema change.
- osi-sync-contract-awareness: Edge↔cloud sync contracts, transport invariants, idempotency, cross-repo PR rules.
- osi-react-gui-patterns: Edge React GUI: HashRouter, PrivateRoute, i18n, api.ts service layer, null-rendering rule.
- osi-server-backend-patterns: Spring Boot/Flyway, test conventions, API shape bridge, DeviceType gotchas.
- osi-config-and-flags: UCI/env/flag catalog, DEVICE_EUI resolution, adding new config knobs.
- osi-agronomy-sensors-reference: SWT/pF, Chameleon calibration, dendrometry, rain gauges, device payloads. Not for pure layout changes.
- osi-debugging-playbook: Symptom→triage table for bug-class requests. Tags: static / test-env / live-only.
- systematic-debugging: Feedback-loop-first bug investigation methodology.
```

### Dangling sibling rule

The OSI skills cross-reference each other by name. Since the forge injects only
selected skills, some pointers will dangle. The execution prompt includes:

> "If an injected skill routes you to a sibling skill not present in this
> prompt, do not guess its contents — note the gap in execution-report.md and
> proceed only if the current skills cover the surface you are changing;
> otherwise stop and report the blocker."

### Skill updates

The controller reads skill files from the cloned repos at runtime
(`/home/forge-runner/repos/osi-os/.claude/skills/`). A `git pull` before each
job picks up skill updates without redeploying the controller.

## Server-Side Changes

### New endpoints

All require forge-runner bearer token (`FORGE_RUNNER_TOKEN` env var), not user
JWT.

```
GET  /api/v1/forge/jobs/eligible
  → list work requests in AWAITING_AGENT, class 0-2
  → returns: [{id, requestUuid, title, area, riskClass, targetRepo}]

POST /api/v1/forge/jobs/{id}/claim
  → atomic transition AWAITING_AGENT → AGENT_PLANNING
  → returns: full work request payload (title, description, area, severity,
    diagnostics, public fields)
  → 409 if already claimed or not in AWAITING_AGENT

POST /api/v1/forge/jobs/{id}/report
  → body: {state, prUrl, failureReason, findings}
  → transitions to PR_OPEN or AGENT_FAILED
  → creates work_request_events audit row

POST /api/v1/forge/jobs/{id}/heartbeat
  → updates last_heartbeat_at
  → 200 if job is still claimed by this runner
  → 409 if job was reclaimed (timeout)
```

### Auth

A static bearer token configured in the server's `.env` as
`FORGE_RUNNER_TOKEN` and in the forge-runner's `forge.env` as
`FORGE_SERVER_ADMIN_TOKEN`. The `SecurityConfig` permits
`/api/v1/forge/**` with this token, separate from user JWT and admin auth.

### State transitions

```
Admin triage (disposition=AWAITING_AGENT)
  → AWAITING_AGENT
    → AGENT_PLANNING      (claim)
    → AGENT_IMPLEMENTING  (report: planning done)
    → VERIFYING           (report: implementation done)
    → PR_OPEN             (report: review approved + PR URL)
    → AGENT_FAILED        (report: gate failure / review rejected / timeout)

Timeout reclaim:
  AGENT_PLANNING / AGENT_IMPLEMENTING / VERIFYING
    → AWAITING_AGENT  (if no heartbeat for 30 min)
```

### Admin dispatch

The existing triage endpoint gains `AWAITING_AGENT` as a valid disposition.
Admin triages a request, sets disposition to `AWAITING_AGENT`, and the forge
controller picks it up on the next poll. No new UI needed in Stage 1 — the
existing triage dropdown covers it.

## Controller File Structure

```
osi-server/forge/
├── controller.py          # Main loop: poll → claim → pipeline → report
├── pipeline.py            # Three-pass orchestration
├── gates.py               # Pre/post execution deterministic checks
├── prompts/
│   ├── plan_system.md     # Static system prompt for Claude planning
│   ├── exec_preamble.md   # Static preamble for Codex execution
│   └── review_system.md   # Static system prompt for Claude review
├── skill_index.py         # Skill name→path mapping + index text
├── github_pr.py           # Branch push + draft PR via GitHub App
├── config.py              # Reads forge.env, validates required keys
├── requirements.txt       # httpx
└── README.md              # Operator docs
```

## Job Lifecycle on Disk

```
/home/forge-runner/jobs/req-a1b2-add-battery-pct/
├── request.json           # Field request payload from server
├── plan.json              # Claude planning output (structured)
├── plan.md                # Human-readable plan (extracted from plan.json)
├── gate-pre.json          # Pre-execution gate results
├── execution-report.md    # Codex output
├── gate-post.json         # Post-execution gate results
├── review.json            # Claude review output
├── worktree/              # Git worktree (the repo checkout)
└── logs/
    ├── claude-plan.log    # Raw Claude CLI output
    ├── codex-exec.log     # Raw Codex CLI output
    └── claude-review.log  # Raw Claude CLI output
```

## Skill Creation and Fixes Required

Based on the skill audit (`2026-07-10-forge-skill-audit.md`), the following
work is required before or alongside Stage 1 implementation:

### New skills (priority order)

1. **`osi-forge-boundaries`** (~1.5K tokens) — always-inject safety policy.
   Environment description, absolute prohibitions, deployment awareness table,
   branch/PR contract, "on being blocked: stop and report" rule.
2. **`osi-common-pitfalls`** (~1.2K tokens) — always-inject insurance. 14
   paid-for failure modes, one to three lines each, pointing to owning skill.
3. **`osi-verification-commands`** (~1.5K tokens) — always-inject for Codex.
   Per-surface command → pass-signal table. Evidence formatting rules.
4. **`osi-sync-contract-awareness`** (~3K tokens) — Claude-selects. Contract
   home, transport invariants, edge-canonical rule, idempotency patterns,
   INSERT-only trigger gotcha, canonicalization golden vectors, cross-repo PR
   rule.
5. **`osi-server-backend-patterns`** (~2K tokens) — Claude-selects. Stack
   facts, Flyway discipline, test conventions, build commands, API shape
   bridge, DeviceType gotcha.
6. **`osi-react-gui-patterns`** (~2K tokens) — Claude-selects. HashRouter,
   PrivateRoute, i18n, service layer, missing-data rendering rule, rule
   overlays, test invocation.

### Existing skill fixes

7. **`osi-flows-json-editing`**: add silent-catch ratchet to checklist, add
   authenticated endpoint subsection, add `verify-no-stray-ddl.js` awareness.
8. **`osi-schema-change-control`**: refresh migration inventory (0001-0004 +
   CHECKSUMS.json), fix "create 0003" example, add stray-DDL verifier.
9. **`osi-agronomy-sensors-reference`**: remove stale #92 P0 reference.

### Adapted forge variants

10. **TDD forge variant**: superpowers TDD trimmed to ~150 lines, broken
    companion references stripped, forge preamble added ("if TDD order was
    violated, note it in execution-report.md").
11. **Systematic-debugging forge variant**: strip companion references, add
    "hitting 3-fix wall = AGENT_FAILED" preamble.

## CLI Installation

The test server needs `claude` and `codex` CLIs installed for the
`forge-runner` user:

```bash
# Claude Code CLI (npm-based)
sudo -u forge-runner npm install -g @anthropic-ai/claude-code

# Codex CLI (npm-based)
sudo -u forge-runner npm install -g @openai/codex
```

Node.js must be installed first (the forge-runner currently has Python 3.12
and git only). Install Node 20 LTS system-wide or via `nvm` for forge-runner.

## Rollout

### Pre-requisites

- Stage 0 deployed on test server (done)
- Pseudonym secret + GitHub App configured (done)
- Node.js + Claude CLI + Codex CLI installed for forge-runner
- New skills created (at minimum: `osi-forge-boundaries`,
  `osi-common-pitfalls`, `osi-verification-commands`)
- Existing skill defects fixed

### First jobs

Stage 1 starts with **manually created GitHub issues**, not field intake.
Write 3–5 hand-crafted issues representing realistic class 0-1 requests
(copy fix, i18n key addition, small UI improvement, simple API change). Admin
triages them to `AWAITING_AGENT`. Validate the full pipeline before connecting
to real field requests.

### Monitoring

- `tmux` session for the controller process
- `/var/log/forge-wrappers.log` for deploy wrapper invocations
- Job logs in `/home/forge-runner/jobs/<job-id>/logs/`
- Server `work_request_events` audit trail for state transitions
- Heartbeat timeout reclaim as the dead-job recovery mechanism

## Open Questions

1. Should the controller run as a systemd service or a tmux session for Stage
   1? (Tmux is simpler for debugging; systemd is more robust.)
2. What is the token budget per job? The always-inject baseline is ~6.7K; with
   3 area skills and AGENTS.md, a typical prompt is 15–25K input tokens.
   Planning + execution + review ≈ 50–100K tokens per job.
3. Should the controller pull both repos before every job, or only the target
   repo?
4. Should `code-quality-principles` be injected into Codex execution prompts
   (class 1-2 only) or reserved for Claude review only?
