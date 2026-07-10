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

1. **Both CLIs installed.** Claude Code CLI (`claude -p`) for planning and review.
   Codex CLI (`codex exec`) for implementation. Claude uses `ANTHROPIC_API_KEY`;
   Codex uses `OPENAI_API_KEY`; both configured in `/home/forge-runner/config/forge.env`.
   **Model allocation:** Claude `--model opus` (currently Opus 4.8) for planning
   and review. Codex `--model codex-5.5 --reasoning xhigh` for implementation.
   For architectural escalation: Claude `--model fable` (Fable 5). Use the
   `--model` alias (`opus`, `fable`) not the full model ID — the alias resolves
   to the latest version automatically.
2. **Python controller** in `osi-server/forge/`. Orchestration-focused: HTTP
   calls, subprocess management, file I/O, JSON parsing. Minimal dependencies
   (httpx, no heavy frameworks).
3. **Claude selects skills during planning, controller injects them into
   Codex.** Claude sees a skill index (~500 tokens) and picks relevant skills
   based on the actual request text. The controller reads the selected SKILL.md
   files and concatenates them verbatim into the Codex execution prompt. Codex
   follows, doesn't re-decide. Claude review also receives the same skills.
4. **Poll + claim + heartbeat.** Controller polls `GET /api/v1/forge/jobs/eligible` every
   5 minutes. Claims a job via `POST /api/v1/forge/jobs/{id}/claim` which
   atomically transitions to `AGENT_PLANNING`. One job at a time.
   **Heartbeat (Fable review HIGH):** the controller runs a background thread
   that POSTs `/api/v1/forge/jobs/{id}/heartbeat` every 5 minutes during all
   blocking passes (Codex can run up to 60 min; the server reclaims after 30
   min of no heartbeat). Without the background heartbeat, a single-threaded
   controller loses every >30-min Codex job. At claim time, the controller
   also checks for an existing `agent/req-<shortid>-*` branch or open PR
   (from a previous failed attempt) and reports it instead of re-running —
   this prevents duplicate branches/PRs from retry-after-reclaim.
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

Invocation:

```bash
claude -p "$USER_MESSAGE" \
  --model opus \
  --output-format json \
  --json-schema "$PLAN_SCHEMA" \
  --system-prompt "$SYSTEM_PROMPT" \
  --max-budget-usd 2.00 \
  --allowedTools "Read" \
  --print
```

**CLI flags that matter (verified 2026-07-10):**
- `--json-schema` enforces structured output validation at the CLI level — Claude's response must conform to the schema or the CLI errors. This replaces hoping the model follows a schema from the system prompt.
- `--system-prompt` separates system instructions from user content — cleaner separation than assembling everything into one message.
- `--allowedTools "Read"` restricts the planning pass to read-only operations. The planner should explore the codebase to ground its plan, but must not edit files or run commands.
- `--max-budget-usd 2.00` enforces token budget at the CLI level for this pass.

System prompt (`$SYSTEM_PROMPT`) assembled from:
- Static planning preamble (~300 tokens): role, "you are planning not implementing", truncation rules
- AGENTS.md from the target repo
- Skill index (names + one-line descriptions for all selectable skills)
- Engineering playbook preamble (verify reality, TDD, no placeholders)

User message (`$USER_MESSAGE`): the field request text, fenced and labeled untrusted, truncated to 4000 characters. **Sanitization:** strip any text that looks like system prompt markup (`<system>`, `</system>`, `<instructions>`, XML-tag patterns that could be interpreted as prompt structure) before fencing. This is defense-in-depth against prompt injection — the `--json-schema` validation is the primary gate (a manipulated plan still must conform to the schema).

Plan JSON schema (`$PLAN_SCHEMA`):

```json
{
  "type": "object",
  "required": ["plan_summary", "required_skills", "risk_class", "target_repo",
               "files_to_touch", "tests_to_run", "plan_md"],
  "properties": {
    "plan_summary": { "type": "string" },
    "required_skills": { "type": "array", "items": { "type": "string" }, "maxItems": 5 },
    "skill_reasoning": { "type": "string" },
    "risk_class": { "type": "integer", "minimum": 0, "maximum": 2 },
    "escalation_needed": { "type": "boolean" },
    "escalation_reason": { "type": "string" },
    "target_repo": { "type": "string", "enum": ["osi-os"] },
    "files_to_touch": { "type": "array", "items": { "type": "string" } },
    "files_do_not_touch": { "type": "array", "items": { "type": "string" } },
    "tests_to_run": { "type": "array", "items": { "type": "string" } },
    "runtime_verification": { "type": "string" },
    "plan_md": { "type": "string" }
  },
  "additionalProperties": false
}
```

**Schema enforcements:** `target_repo` restricted to `osi-os` for Stage 1 via `enum`; `risk_class` bounded 0–2; `additionalProperties: false` prevents schema extension via prompt manipulation.

**Skill selection cap (Fable review MEDIUM — revised from count to token ceiling):** the schema allows up to 5 skills (`maxItems: 5`) but the controller enforces a **~9K token ceiling** on the combined area-skill content. If Claude selects skills whose concatenated SKILL.md files exceed 9K tokens, the controller rejects the plan with "scope too broad for one PR — split the request or escalate." A hard count cap of 3 would silently drop `osi-schema-change-control` on a flows+schema+sync+GUI job — exactly the job that needs every skill. The token ceiling is a softer, more correct bound.

### Pass 2: Codex Execution

Invocation (verify exact syntax at install time — Codex CLI is not installed locally):

```bash
# Controller wraps this in subprocess.run(timeout=3600) — do NOT rely on a CLI --timeout flag.
codex exec "$PROMPT" \
  --model codex-5.5 \
  -c model_reasoning_effort=high \
  --full-auto
```

Run in the job worktree directory with `env` restricted to `codex.env` contents only (see §Credential separation).

**CLI flag notes (Fable review 2026-07-10):**
- `--reasoning xhigh` is likely `-c model_reasoning_effort=high` in Codex CLI — verify at install time.
- **Timeout is controller-side, not CLI-side.** Codex CLI likely has no `--timeout` flag. The controller uses `subprocess.run(timeout=3600)` (Python) to enforce a 1-hour wall-clock limit and `SIGTERM`→`SIGKILL` on expiry. This is the authoritative timeout mechanism regardless of CLI capabilities.
- Verify `codex exec`, `--model`, `--full-auto` exist in the installed version.

**Execution isolation (CRITICAL — the VPS hosts farm-mirror data):**

The forge-runner user and Codex execution environment must be locked down:
- **Filesystem:** forge-runner has NO read access to `/home/rocky/docker/` (Docker volumes with Postgres farm data), `/home/rocky/.env` (production secrets), or any other user's home directory. Enforce via Unix file permissions, not application-level trust.
- **Network:** Codex needs outbound HTTPS to `api.openai.com` (its own API) and `github.com` (git push). It does NOT need access to `localhost:*` (Postgres, the OSI Server backend). Use `iptables` rules on the forge-runner user or a network namespace to restrict outbound connections.
- **Docker socket:** forge-runner must NOT be in the `docker` group and must NOT have access to `/var/run/docker.sock` (a Docker socket = root on the host).
- **SSH keys:** forge-runner has NO SSH keys and no access to `~rocky/.ssh/` or the Tailscale admin.
- **Credential separation (Fable review CRITICAL):** `forge.env` must be split into TWO files with different permissions:
  - `codex.env` (readable by Codex process): contains ONLY `OPENAI_API_KEY`. Nothing else.
  - `controller.env` (readable only by the controller, NOT by the Codex subprocess): contains `ANTHROPIC_API_KEY`, `FORGE_RUNNER_TOKEN`, `GITHUB_APP_*`. The controller passes `ANTHROPIC_API_KEY` to Claude CLI via its own environment but does NOT propagate it to the Codex subprocess. `GITHUB_APP_*` is used only by the controller's git-push step.
  - **Why:** Codex runs untrusted-influenced prompts. A crafted command could `cat codex.env` + `curl` the contents to any host. If Codex can read `GITHUB_APP_*`, it can mint GitHub installation tokens with Contents+PR rights on both public repos. Limiting Codex to only its own API key bounds the blast radius to "Codex bills run up" — recoverable via key rotation.
- **Egress restriction is a HARD PREREQUISITE for the first Codex run (Fable review CRITICAL),** not deferred to "before connecting to real field requests." Even hand-crafted validation jobs copy realistic field text. Use `iptables -m owner --uid-owner forge-runner` to allowlist only `api.openai.com`, `api.anthropic.com`, and `github.com` (port 443). All other outbound is blocked.

If Codex supports a `--sandbox` or container isolation mode, prefer it. The file-permission lockdown + egress restriction is the baseline; sandboxing is defense-in-depth.

Prompt (`$PROMPT`) assembled by concatenating (in order):
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

Invocation:

```bash
claude -p "$REVIEW_MESSAGE" \
  --model opus \
  --output-format json \
  --json-schema "$REVIEW_SCHEMA" \
  --system-prompt "$REVIEW_SYSTEM_PROMPT" \
  --max-budget-usd 2.00 \
  --allowedTools "Read,Bash(git diff *),Bash(git log *)" \
  --print
```

The reviewer gets read access + git diff/log to verify claims in the execution report, but cannot edit files or run arbitrary commands.

System prompt (`$REVIEW_SYSTEM_PROMPT`) assembled from:
- Static review preamble: finding categories (must-fix / should-fix / note per `code-quality-principles`)
- Always-inject skills (same set as execution)
- Selected area skills (same set as execution)
- `code-quality-principles` skill (static version, NOT per-task enhanced — see §Resolved Questions)

Review message (`$REVIEW_MESSAGE`):
- Original request text + plan.md
- Git diff (`git diff main...HEAD`)
- Test output / execution-report.md

Review JSON schema (`$REVIEW_SCHEMA`):

```json
{
  "type": "object",
  "required": ["verdict", "findings"],
  "properties": {
    "verdict": { "type": "string", "enum": ["approve", "fix", "reject"] },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "description"],
        "properties": {
          "severity": { "type": "string", "enum": ["must-fix", "should-fix", "note"] },
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "description": { "type": "string" }
        }
      }
    },
    "fix_instructions": { "type": ["string", "null"] },
    "summary": { "type": "string" }
  },
  "additionalProperties": false
}
```

Verdict values: `approve` (push PR), `fix` (one Codex fix cycle, then re-review), `reject` (job fails with findings). The `--json-schema` flag ensures the verdict is always one of the three enum values — no ambiguous text responses.

### Fable Escalation (optional, for hard decisions)

When Claude Opus flags uncertainty in its plan — architectural trade-offs,
cross-system impact, ambiguous requirements — the controller can escalate to a
Fable 5 agent for a second opinion before Codex executes:

```bash
claude -p "$ESCALATION_MESSAGE" \
  --model fable \
  --output-format json \
  --json-schema "$ESCALATION_SCHEMA" \
  --system-prompt "You are a senior architect reviewing a proposed implementation plan..." \
  --max-budget-usd 3.00 \
  --allowedTools "Read" \
  --print
```

The Fable agent receives the original request, Claude's plan, and the
uncertainty description. It returns either a confirmation, a revised plan, or a
rejection with reasoning. The controller uses the Fable verdict to proceed or
fail. This is optional and triggered only when Claude's plan output includes
`"escalation_needed": true`.

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
| Prohibited patterns in plan | `plan_md` contains SSH commands, `docker exec`, raw IP addresses, or `deploy.sh` invocation instructions |

All other quality concerns (risk class, skill consistency, injection patterns)
are left to the human reviewer. The gate protects the execution environment,
not the merge.

### Post-execution gate (after Codex, before push)

| Check | Scope | Rejects if |
|-------|-------|-----------|
| Secret patterns | Diff + `execution-report.md` + PR body | Contains: `Bearer ` + 20 chars, `sk-` + 20 chars, `-----BEGIN`, `password=`, `secret=`, AppKey-like 32-hex, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| Credential paths | Diff | Touches `.github/workflows/`, `.env`, `*_cred*`, SSH keys |
| Content scan | Diff | Contains new outbound HTTP/MQTT to non-allowlisted hosts, new `process.env` / `env.get()` reads, raw IP addresses outside docs/tests, SSH/deploy command patterns (restored from Stage 0 gate spec) |
| Diff conformance | Diff | Files changed ⊄ (`files_to_touch` ∪ test files ∪ `execution-report.md`). Files Codex actually changed must be a subset of what the plan declared + test files. Unexpected file edits are flagged. |
| Diff size | Diff | > 5000 lines changed |
| Branch name | Branch | Not `agent/req-<shortid>-<slug>` |

**Secret scan scope (Fable review HIGH):** the scan runs over the diff AND
`execution-report.md` AND the assembled PR body — not just the diff. Codex
pastes command output into the report, which can include env dumps; the report
goes into the public draft PR body. Scanning only the diff misses this surface.

**Diff conformance (Fable review HIGH):** the plan declares `files_to_touch`;
Codex may edit different files (especially during the fix cycle). Without this
check, a plan claiming `README.md` passes the pre-gate while Codex edits
`deploy.sh`. The check is a WARNING (logged in `gate-post.json` + flagged in
the PR body for the human reviewer), not a hard reject — Codex legitimately
touches test files and the execution report that weren't in the plan.

Gate results logged to `gate-pre.json` / `gate-post.json` in the job directory.
A gate failure transitions to `AGENT_FAILED` with the specific check that
failed.

### Controller-run verification (after Codex, before review — Fable review HIGH)

The controller does NOT trust Codex's self-reported test results. After the
post-execution gate passes, the controller **re-runs `plan.json.tests_to_run`
itself** and captures the real output:

```python
for cmd in plan["tests_to_run"]:
    result = subprocess.run(cmd, shell=True, capture_output=True, timeout=300, cwd=worktree)
    verification_results.append({"cmd": cmd, "rc": result.returncode, "stdout": result.stdout[-4000:]})
```

The real test output (not Codex's report) is included in the Claude review
prompt. A divergence between Codex's claimed results and the controller's
re-run is flagged as a finding for the reviewer. If ALL mandatory tests fail,
the job transitions to `AGENT_FAILED` without reaching review.

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

**Claude-selects** (planning pass picks by touched surface, cap 3 per job;
if Claude selects more, the controller takes the first 3 and logs a warning):

| Skill | Select when |
|-------|------------|
| `osi-flows-json-editing` | Any flows.json / Node-RED / edge REST change |
| `osi-schema-change-control` | Any edge SQLite schema/seed/migration change |
| `osi-sync-contract-awareness` | Any sync, outbox, contract, or paired-repo change (**NEW**) |
| `osi-react-gui-patterns` | Any `web/react-gui` change (**NEW**) |
| ~~`osi-server-backend-patterns`~~ | ~~Any osi-server change~~ — **EXCLUDED from Stage 1 index** (Fable review: `target_repo` enum forbids `osi-server`; Claude would burn a slot planning for a repo the controller rejects). Created now, ready for Stage 2. |
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
Available skills — select by name. Combined token ceiling: ~9K.
If the request needs more skills than that, note "scope too broad" in escalation_reason.
Stage 1 scope: osi-os only (target_repo must be "osi-os").

AREA SKILLS (select when the change touches the named surface):
- osi-flows-json-editing: Script-only flows.json editing. MANDATORY before ANY Node-RED flow change.
- osi-schema-change-control: Edge SQLite migrations, risk classes, frozen boot DDL. MANDATORY before ANY schema change.
- osi-sync-contract-awareness: Edge↔cloud sync contracts, transport invariants, idempotency. Stage 1 is single-repo — record mirror-side work in the PR body as follow-up.
- osi-react-gui-patterns: Edge React GUI: HashRouter, PrivateRoute, i18n, api.ts service layer, null-rendering rule.
- osi-config-and-flags: UCI/env/flag catalog, DEVICE_EUI resolution, adding new config knobs.
- osi-agronomy-sensors-reference: SWT/pF, Chameleon calibration, dendrometry, rain gauges, device payloads. Not for pure layout changes.
- osi-debugging-playbook: Symptom→triage table for bug-class requests. Tags: static / test-env / live-only.
- systematic-debugging: Feedback-loop-first bug investigation methodology.
```

### Dangling sibling rule + deterministic backstop

The OSI skills cross-reference each other by name. Since the forge injects only
selected skills, some pointers will dangle. The execution prompt includes:

> "If an injected skill routes you to a sibling skill not present in this
> prompt, do not guess its contents — note the gap in execution-report.md and
> proceed only if the current skills cover the surface you are changing;
> otherwise stop and report the blocker."

**Deterministic backstop (Fable review MEDIUM):** the prompt rule is pure model
compliance — an agent that doesn't "note the gap" leaves no trace. The
controller adds a post-hoc check: map the diff-touched file surfaces to the
surface→skill table (e.g. `conf/.../flows.json` → `osi-flows-json-editing`;
`database/migrations/` → `osi-schema-change-control`; `web/react-gui/` →
`osi-react-gui-patterns`). If a surface was touched but its mandatory skill
was NOT injected, the controller flags it in the Claude review input and in the
PR body. This catches the case where Claude under-selected skills and Codex
edited a surface it had no instructions for.

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
# Node.js 20 LTS (prerequisite — forge-runner currently has Python 3.12 + git only)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo dnf install -y nodejs  # Rocky Linux

# Claude Code CLI (npm-based)
sudo -u forge-runner npm install -g @anthropic-ai/claude-code

# Codex CLI (npm-based)
sudo -u forge-runner npm install -g @openai/codex
```

**Post-install verification:** run `sudo -u forge-runner claude --version` and `sudo -u forge-runner codex --version`. Then verify the exact Codex CLI flags used in Pass 2 (`codex exec --help`) — the `exec` subcommand, `--model`, `--reasoning`, `--full-auto`, and `--timeout` flags must be confirmed against the installed version. If any flag doesn't exist, update the Pass 2 invocation in this spec before the first job.

## Execution Isolation (CRITICAL — pre-requisite for first job)

The test VPS (`server.opensmartirrigation.org`) hosts the farm-mirror
Postgres database and production Docker stack alongside the forge-runner.
The forge-runner user must be locked down before any Codex invocation:

```bash
# 1. forge-runner cannot read other users' homes or Docker state
sudo chmod 750 /home/rocky
sudo chmod 750 /home/rocky/docker
# Verify: sudo -u forge-runner ls /home/rocky/ → Permission denied

# 2. forge-runner is NOT in the docker group
sudo gpasswd -d forge-runner docker 2>/dev/null || true
# Verify: sudo -u forge-runner docker ps → Permission denied

# 3. No SSH keys for forge-runner
sudo -u forge-runner ls ~/.ssh/ → should be empty or nonexistent

# 4. Network restriction (iptables — restrict forge-runner to API + GitHub only)
# This is a Stage 1 hardening step — implement before connecting to real field requests.
# For hand-crafted validation jobs, file-permission isolation is sufficient.
```

**Verification checklist (before first job):**
- [ ] `sudo -u forge-runner cat /home/rocky/.env` → Permission denied
- [ ] `sudo -u forge-runner docker ps` → Permission denied
- [ ] `sudo -u forge-runner ls /home/rocky/docker/` → Permission denied
- [ ] `sudo -u forge-runner psql -U osiserver osiserver -c "SELECT 1"` → fails (no local socket or credentials)
- [ ] `forge.env` contains ONLY: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FORGE_RUNNER_TOKEN`, `GITHUB_APP_*` — no DB credentials, no SSH keys, no production URLs

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

- `tmux` session for the controller process.
  **Liveness (Fable review MEDIUM):** tmux is unsupervised — a controller crash or VPS reboot leaves no running process and no alert; jobs queue in `AWAITING_AGENT` indefinitely. **Minimum Stage 1 mitigation:** a cron job every 10 minutes that checks `pgrep -f controller.py` and sends a webhook alert (or writes to a monitored log) if the process is absent. Systemd is a Stage 2 hardening step, but silent death for a week is unacceptable even during validation.
- `/var/log/forge-wrappers.log` for deploy wrapper invocations
- Job logs in `/home/forge-runner/jobs/<job-id>/logs/`
- Server `work_request_events` audit trail for state transitions
- Heartbeat timeout reclaim as the dead-job recovery mechanism

## Error Handling

| Failure | Controller response |
|---------|-------------------|
| Claude returns malformed JSON (despite `--json-schema`) | Retry once with the same prompt. If still malformed, `AGENT_FAILED` with "plan_parse_error" / "review_parse_error". |
| Codex hangs past `--timeout` (1 hour) | Kill the process. `AGENT_FAILED` with "execution_timeout". |
| Codex exits non-zero | Log output. If post-gate passes, proceed to review (Codex may have partially succeeded). If post-gate fails, `AGENT_FAILED`. |
| Server unreachable during `report` | Retry 3× with exponential backoff (5s, 30s, 180s). If still unreachable, leave the job in claimed state — heartbeat timeout (30 min) will eventually reclaim it. Log locally. |
| Git push fails | `AGENT_FAILED` with "push_failed" + the git error. Do NOT retry push (could mask a branch-protection or auth issue). |
| Fix cycle introduces new gate failures | `AGENT_FAILED` — the fix made things worse. Do not loop. |
| Controller crash mid-job | On restart, check for any job directory with a `request.json` but no `gate-post.json` or `review.json`. If the server says the job is still claimed by this runner (heartbeat alive), resume from the last completed pass. If reclaimed (timeout), abandon the local state and clean up. |

## Cleanup Protocol

**On job completion (success or failure):**
1. Delete the git worktree: `git worktree remove --force <path>`.
2. Delete the remote `agent/*` branch if the job failed (no PR to reference it): `git push origin --delete agent/req-<shortid>-<slug>`.
3. Retain the job directory (`/home/forge-runner/jobs/<job-id>/`) for 7 days (logs, gate results, execution reports for debugging), then prune.

**On heartbeat timeout reclaim:**
- The server reclaims the job. On the next controller startup or poll cycle, the controller detects orphaned job directories (job ID in local state but no longer claimed on the server) and runs the same cleanup.

**Periodic garbage collection (daily cron):**
- Delete job directories older than 7 days.
- `git worktree prune` to clean up stale worktree references.
- Delete remote `agent/*` branches with no open PR older than 7 days.

## Resolved Questions

1. **Controller process:** tmux session for Stage 1. Simpler for debugging and
   observability during the validation phase. Systemd is a Stage 2+ hardening
   step.
2. **Token budget:** `--max-budget-usd` on each Claude CLI invocation (planning: $2, review: $2, fix-review: $2). Codex budget enforcement via `--timeout` (1 hour) — Codex bills by the minute, not tokens; 1 hour × xhigh reasoning is the cost cap. Total per-job: ~$10 ceiling ($2 plan + Codex hour + $2 review + optional $2 fix-review + optional $2 Fable escalation). The always-inject baseline is ~6.7K tokens; with 3 area skills and AGENTS.md, a typical prompt is 15–25K input tokens.
3. **Repo scope:** osi-os only for Stage 1. The controller pulls only the
   osi-os repo before each job. osi-server jobs are a Stage 2 expansion.
   (The `osi-server-backend-patterns` skill from the audit is created now but not in the Stage 1 skill index — it's ready for Stage 2.)
4. **`code-quality-principles`:** inject the static skill into both Codex execution and Claude review prompts (all code-bearing jobs, class 0-2). ~~Per-task Fable enhancement~~ **Dropped (review 2026-07-10):** a per-task enhanced quality lens undermines the consistency that skills are designed to provide — different quality standards per job make human review unpredictable. Instead, enhance `code-quality-principles` once via a Fable review pass, commit the improved version, and inject it statically. The Fable escalation path (§Fable Escalation) remains available for genuinely hard architectural decisions, which is the appropriate use of a stronger model.
5. **Prompt injection mitigation:** defense-in-depth via three layers: (a) field request text sanitized (XML-tag-like markup stripped) and fenced as `<untrusted-field-request>`; (b) `--json-schema` validation ensures Claude's output conforms to the expected structure regardless of prompt manipulation; (c) the pre-execution gate rejects plans that touch credential paths or CI workflows. A manipulated plan that passes all three layers and produces a PR that passes human review is, by definition, a valid plan.
