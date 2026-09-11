# OSI Forge subscription multi-agent upgrade implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox form so progress and evidence can be recorded in place.

**Goal:** Upgrade the existing OSI Forge controller into a neutral, subscription-authenticated, multi-agent issue-to-draft-PR service for both `osi-os` and `osi-server`, with GitHub Mobile control and a Tailscale/Termux break-glass path.

**Architecture:** Keep the current Python controller in `osi-server/forge` and extend it in place. GitHub issues labeled `forge-ready` become the primary work source; the existing OSI Server WorkRequest API remains a secondary intake source. The existing `forge-runner` identity owns only the neutral controller, queue, GitHub App, and WorkRequest credentials. Claude Code, Codex, OpenCode, and deterministic verification run under separate locked service accounts through a fixed root-owned stage launcher, so model-written commands cannot read controller or peer-provider credentials. A job edits one repository and opens one draft PR. The controller never merges or deploys.

**Tech stack:** Python 3.12, SQLite, pytest, GitHub App API, Spring Boot/Gradle for the existing WorkRequest API, Claude Code CLI, Codex CLI, OpenCode CLI with OpenCode Go, systemd, firewalld, Tailscale SSH, GitHub Mobile.

## Global constraints

- Work in two isolated worktrees, one from current `origin/main` in each repository. Never mix commits across repositories.
- Upgrade the controller already present in `osi-server/forge`. Do not create a second controller or a parallel queue.
- Keep orchestration deterministic. No model chooses another model, changes policy, skips a gate, merges a PR, deploys software, or mutates controller state directly.
- Keep controller, provider, and verifier identities separate. Shared access is limited to the current job worktree and typed result files; no provider can read controller configuration or another provider's home/auth store.
- One Forge job targets exactly one repository and produces at most one draft PR. A cross-repository feature uses linked issues and separate jobs/PRs.
- Support only `Open-Smart-Irrigation/osi-os` and `Open-Smart-Irrigation/osi-server`.
- Accept only issues labeled `forge-ready`, risk level `0`, `1`, or `2`, and authored or approved by an allowlisted maintainer.
- Run every model invocation without session continuation. Do not share provider conversation IDs between stages or jobs.
- Use subscription authentication only. Reject OpenAI API-key authentication, Anthropic API-key authentication, OpenCode Zen fallback, free fallback models, and paid overage fallback.
- Subscription plans still have usage limits. When a provider reports exhausted usage, stop the job and project `forge-blocked-usage`; never switch credentials, provider, or billing mode automatically.
- Deterministic gates veto model approval. Claude adjudication cannot override a failed command, forbidden path, secret finding, boundary violation, or malformed structured result.
- Keep all PRs draft. Never add merge, release, deploy, production, or gateway-control commands.
- Do not access or change `osicloud.ch`. All deployment and end-to-end work in this plan targets the existing test server only.
- Preserve unrelated untracked or modified files in both repositories.
- Before editing `osi-os` Forge boundary documentation, load `osi-forge-boundaries`, `osi-common-pitfalls`, and `anti-slop-writing`.
- Before editing `osi-server`, load `osi-server-backend-patterns`, `osi-forge-boundaries`, `osi-common-pitfalls`, and `anti-slop-writing`.
- Before claiming a task complete, use `superpowers:verification-before-completion` and record fresh command output.

## Initial starting-point snapshot on 2026-07-15

This snapshot is retained for provenance only. It described a proposed
deployment layout, not verified host state. The 2026-07-16 recheck below is the
source of truth for implementation and deployment decisions.

## Rechecked starting point on 2026-07-16

The test server was inspected again before implementation. The 2026-07-15
deployment snapshot was stale in several important ways:

- `/home/rocky/osi-server/forge` is the existing Stage 1 source copy. It
  contains the controller, pipeline, gates, GitHub publisher, skill index, and
  15 Python tests. The local source baseline used for comparison is commit
  `97ec0be`; the remote copy needs a content fingerprint during rollout.
- `/home/forge-runner/forge`, `/home/forge-runner/repos`, `/home/forge-runner/config`,
  `/home/forge-runner/jobs`, `/home/forge-runner/logs`, and `/home/forge-runner/state`
  do not exist. There is no deployed Forge checkout under the runner account.
- `forge-runner` exists as uid 1002 with no supplementary groups. `forge-admin`
  does not exist. No Forge systemd unit is installed or active.
- `claude`, `codex`, `opencode`, `gh`, and `tailscale` are not installed on the
  test server. The only Forge-related host scripts are the existing Stage 2
  server deploy/verify wrappers and the edge wrappers that fail closed.
- The old forge-runner liveness and prune cron entries remain, but their target
  paths are absent. They are deployment residue, not proof of a running
  controller.
- The host firewall is active with the existing public services and ports. No
  Forge-specific egress policy or provider service accounts are present.

Implementation consequence: extend the existing `osi-server/forge` package in
the isolated source worktree, then provision the missing runner layout and
provider identities as a later, explicitly approved test-server rollout. Do
not copy the source into a second controller path, reuse `/home/rocky` as the
agent runtime, or treat the stale cron entries as a working deployment. The
existing Stage 2 server deploy wrapper remains outside this Stage 1 plan and
must not be enabled by the new controller.

The matching source worktree already exists at
`/home/phil/Repos/osi-server/.worktrees/forge-subscription-multi-agent` on
`feat/forge-subscription-multi-agent`, 32 commits ahead of `origin/main`. It
contains the provider adapters, durable job store, GitHub Mobile intake,
three-review council, OpenCode routing harness, stage launcher, and test-server
assets. Resume review and repair in that worktree; do not create a parallel
Forge branch or queue.

The OSI OS boundary worktree also already exists at
`/home/phil/Repos/osi-os/.worktrees/forge-multi-repo-boundaries` on
`docs/forge-multi-repo-boundaries`, two commits ahead of `origin/main`. It
contains the reviewed multi-repository boundary, provider/control rules, and
bounded repair policy. Reuse that branch for the OSI OS documentation PR.

Current execution checkpoint:

- `osi-server` head `c8858c9` is 40 commits ahead of `origin/main`; its
  worktree is clean.
- The Forge suite passes `1120` tests. The focused operations/source suite
  passes `117` tests. Targeted backend Forge tests pass with `BUILD SUCCESSFUL`.
- The latest hardening commit seals controller-owned Git subprocesses, makes
  edited mobile comments durable tombstones, replays interrupted source
  outbox operations in order, binds routing and verification to the committed
  candidate diff (including repair), rejects executable or redirecting local
  Git configuration before network operations, and validates the root-owned
  reviewed skill manifest and bundle snapshot.
- PR [#64](https://github.com/Open-Smart-Irrigation/osi-server/pull/64) is
  pushed and ready for review (non-draft); its backend and pytest checks are
  green. A Rocky Linux test-server rollout is authorized and in progress.
- `osi-os` boundary head `3ed32de9` is two commits ahead of `origin/main`; its
  worktree is clean.
- PR [#147](https://github.com/Open-Smart-Irrigation/osi-os/pull/147) is
  pushed and ready for review (non-draft); all checks and CodeRabbit are
  green.
- On `osi-test-server`, the rollback snapshot is checksummed, the reviewed
  Forge source and OSI OS skill bundle are installed, the HTTPS WorkRequest
  endpoint is configured, and the proxy plus per-identity egress policy are
  active. Subscription authentication is the remaining activation gate.

The remaining rollout steps are subscription login, provider preflight,
systemd lifecycle proof, and fixture validation. Production `osicloud.ch`
and live gateways remain out of scope.

## Settled design choices

| Concern | Decision |
|---|---|
| Controller | Neutral Python controller; deterministic state machine and policy only |
| Task source | GitHub issues are primary; existing WorkRequest API remains a secondary source |
| Start authorization | Maintainer applies `forge-ready` or sends exact `/forge start` command |
| Repositories | `osi-os` and `osi-server` |
| Execution host | Dedicated `forge-runner` account on the existing test server, provisioned during rollout |
| Planner | Claude Code, `claude-opus-4-8` |
| Plan critic | Codex, `gpt-5.6-sol` |
| Implementer and repairer | Codex, `gpt-5.6-luna` |
| First code reviewer | Codex, `gpt-5.6-sol` |
| Second code reviewer | OpenCode Go, benchmark-selected allowlisted model |
| Third reviewer and adjudicator | Claude Code, `claude-opus-4-8`; performs an independent review and then adjudicates the other reviews |
| Repair budget | At most one fresh Luna repair cycle, followed by fresh gates, verification, and all three reviews |
| Authentication | Codex ChatGPT OAuth, Claude subscription login, OpenCode Go subscription only |
| Billing fallback | Fail closed; no API-key, paid-overage, Zen, free-model, or cross-provider fallback |
| Mobile control | GitHub Mobile for normal issue, status, review, and PR interaction |
| Break-glass control | Tailscale SSH from Android Termux to a dedicated `forge-admin` account |
| Completion | Verified draft PR only; never merge or deploy |

## Pipeline and bounded revision rules

```text
READY
  -> PLANNING                Claude Opus 4.8
  -> PLAN_CRITIQUE           Codex Sol
  -> PLAN_REVISION?          fresh Claude Opus 4.8, maximum once
  -> PLAN_RECHECK?           fresh Codex Sol, maximum once
  -> IMPLEMENTING            Codex Luna
  -> DETERMINISTIC_GATES
  -> VERIFYING               repository-owned commands
  -> REVIEW_CODEX            fresh Codex Sol
  -> REVIEW_OPENCODE         fresh benchmark-routed OpenCode Go model
  -> REVIEW_CLAUDE           fresh Claude Opus 4.8, independent review plus adjudication
  -> REPAIRING?              fresh Codex Luna, maximum once
  -> DETERMINISTIC_GATES     rerun from a clean result set
  -> VERIFYING               rerun all required commands
  -> REVIEW_CODEX            all reviewers run fresh
  -> REVIEW_OPENCODE
  -> REVIEW_CLAUDE
  -> PR_OPEN                 verified draft PR
```

If the rechecked plan still fails, the job becomes `BLOCKED`. If any final reviewer rejects the post-repair result, the job becomes `BLOCKED`. There is no second repair cycle.

## GitHub Mobile contract

The controller recognizes an exact command only when it is the first non-empty line of a new issue comment from an allowlisted maintainer:

```text
/forge start
/forge status
/forge cancel
/forge retry
/forge model opencode-go/<allowlisted-model>
```

`/forge start` applies `forge-ready`. `/forge retry` is valid only for a terminal retryable job and creates a new attempt record. `/forge cancel` requests cooperative cancellation and then terminates the active provider process group after the configured grace period. `/forge model` changes only the OpenCode reviewer for that issue and only to an allowlisted OpenCode Go model. No command accepts arbitrary shell text or a model outside policy.

Status is projected through one active status label and a controller comment. Required labels are:

```text
forge-ready
forge-running
forge-planning
forge-implementing
forge-verifying
forge-pr-open
forge-blocked
forge-blocked-usage
forge-failed
forge-cancelled
```

The controller removes stale Forge status labels before applying the next one. It does not remove non-Forge labels.

## Model and billing policy

The fixed role policy is version controlled. Initial OpenCode Go allowlist:

```text
opencode-go/deepseek-v4-pro
opencode-go/kimi-k2.7-code
opencode-go/qwen3.7-max
opencode-go/glm-5.2
```

Until benchmark evidence activates a route, OpenCode review uses `opencode-go/deepseek-v4-pro`. Candidate routing classes are:

```text
edge_flow_schema
edge_frontend
sync_cross_repo
server_backend_flyway
docs_config
```

“Cross repo” classifies sync-contract work; it does not authorize editing both repositories in one job.

Route promotion requires at least ten evaluated cases for the task class. Rank candidates by critical-finding recall first, then false-positive rate and evidence quality. Use elapsed time and included-allowance consumption only as tie breakers. Store no invented scores and activate no non-default route before the threshold is met.

OpenCode Go exposes a subscription key to the CLI. That fact alone cannot prove that the account-level “Use balance” control remains disabled. Treat a root-owned, expiring operator attestation as the mechanical boundary: when the attestation is missing or stale, block OpenCode execution and project `forge-blocked-usage`. The operator must also disable “Use balance” in the OpenCode console. Document this limitation honestly.

## Planned file map

Paths prefixed `osi-server/` are relative to `/home/phil/Repos/osi-server`. Paths prefixed `osi-os/` are relative to `/home/phil/Repos/osi-os`.

```text
osi-server/forge/forge/config.py
osi-server/forge/forge/domain.py                         new
osi-server/forge/forge/job_store.py                      new
osi-server/forge/forge/job_sources.py                    new
osi-server/forge/forge/auth.py                           new
osi-server/forge/forge/providers/__init__.py             new
osi-server/forge/forge/providers/base.py                 new
osi-server/forge/forge/providers/claude.py               new
osi-server/forge/forge/providers/codex.py                new
osi-server/forge/forge/providers/opencode.py             new
osi-server/forge/forge/model_routing.py                   new
osi-server/forge/forge/benchmark.py                       new
osi-server/forge/forge/controller.py
osi-server/forge/forge/pipeline.py
osi-server/forge/forge/github_pr.py
osi-server/forge/forge/gates.py
osi-server/forge/forge/skill_index.py
osi-server/forge/policy/repositories.json                 new
osi-server/forge/policy/opencode-routing.json             new
osi-server/forge/schemas/plan_critique_schema.json        new
osi-server/forge/schemas/review_schema.json
osi-server/forge/schemas/adjudication_schema.json         new
osi-server/forge/prompts/plan_critic.md                   new
osi-server/forge/prompts/codex_reviewer.md                new
osi-server/forge/prompts/opencode_reviewer.md             new
osi-server/forge/prompts/claude_adjudicator.md            new
osi-server/forge/prompts/repair.md                        new
osi-server/forge/tests/...
osi-server/forge/ops/systemd/osi-forge.service            new
osi-server/forge/ops/opencode/agents/forge-review.md      new
osi-server/forge/ops/bin/forgectl                         new
osi-server/forge/ops/bin/forge-stage-exec                 new
osi-server/forge/ops/sudoers/osi-forge-admin              new
osi-server/forge/ops/sudoers/osi-forge-controller         new
osi-server/forge/ops/firewalld/forge-runner-egress.sh      new
osi-server/docs/operations/forge-runner-test-server.md     new
osi-server/backend/src/main/java/org/osi/server/workrequest/ForgeService.java
osi-server/backend/src/main/java/org/osi/server/workrequest/WorkRequestAdminService.java
osi-server/backend/src/test/java/org/osi/server/workrequest/ForgeServiceTest.java
osi-server/backend/src/test/java/org/osi/server/workrequest/WorkRequestAdminServiceTest.java
osi-os/.claude/skills/osi-forge-boundaries/SKILL.md
```

## Task 1: Establish repository policy and a normalized job model

**Repository:** `osi-server`

**Files:**

- Create: `forge/policy/repositories.json`
- Create: `forge/forge/domain.py`
- Create: `forge/forge/job_store.py`
- Modify: `forge/forge/config.py`
- Test: `forge/tests/test_domain.py`
- Test: `forge/tests/test_job_store.py`
- Test: `forge/tests/test_config.py`

- [ ] **Step 1: Create failing tests for repository policy and transitions**

Cover these exact cases:

```python
def test_policy_contains_only_the_two_approved_repositories(policy):
    assert set(policy.repositories) == {
        "Open-Smart-Irrigation/osi-os",
        "Open-Smart-Irrigation/osi-server",
    }

def test_job_key_deduplicates_sources():
    issue = IssueRef("Open-Smart-Irrigation/osi-os", 123)
    assert issue.key == "Open-Smart-Irrigation/osi-os#123"

def test_job_cannot_skip_from_ready_to_implementing(store, job):
    store.create(job)
    with pytest.raises(InvalidTransition):
        store.transition(job.id, JobState.IMPLEMENTING)

def test_pr_open_requires_recorded_gate_and_verification_passes(store, job):
    store.create(job)
    store.force_state_for_test(job.id, JobState.REVIEW_CLAUDE)
    with pytest.raises(InvalidTransition):
        store.transition(job.id, JobState.PR_OPEN)
```

- [ ] **Step 2: Run the focused tests and record the expected RED result**

Run:

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_domain.py tests/test_job_store.py tests/test_config.py -q
```

Expected: failure because the new modules and policy do not exist.

- [ ] **Step 3: Add the exact repository policy**

`forge/policy/repositories.json`:

```json
{
  "schema_version": 1,
  "repositories": {
    "Open-Smart-Irrigation/osi-os": {
      "checkout": "/home/forge-runner/repos/osi-os",
      "github_installation_scope": "osi-os",
      "max_risk": 2,
      "verification_profile": "osi-os",
      "forbidden_path_prefixes": [".github/workflows/", "scripts/pipeline/"]
    },
    "Open-Smart-Irrigation/osi-server": {
      "checkout": "/home/forge-runner/repos/osi-server",
      "github_installation_scope": "osi-server",
      "max_risk": 2,
      "verification_profile": "osi-server",
      "forbidden_path_prefixes": [".github/workflows/", "scripts/pipeline/"]
    }
  }
}
```

Keep path restrictions additive to existing Stage 1 forbidden-path rules. A repository policy can narrow a job; it cannot relax a global boundary.

- [ ] **Step 4: Implement immutable domain records and SQLite persistence**

Use these public interfaces:

```python
class JobState(StrEnum):
    READY = "ready"
    PLANNING = "planning"
    PLAN_CRITIQUE = "plan_critique"
    PLAN_REVISION = "plan_revision"
    IMPLEMENTING = "implementing"
    GATING = "gating"
    VERIFYING = "verifying"
    REVIEW_CODEX = "review_codex"
    REVIEW_OPENCODE = "review_opencode"
    REVIEW_CLAUDE = "review_claude"
    REPAIRING = "repairing"
    PR_OPEN = "pr_open"
    BLOCKED = "blocked"
    BLOCKED_USAGE = "blocked_usage"
    FAILED = "failed"
    CANCELLED = "cancelled"

@dataclass(frozen=True)
class IssueRef:
    repository: str
    number: int

    @property
    def key(self) -> str:
        return f"{self.repository}#{self.number}"

@dataclass(frozen=True)
class Job:
    id: str
    issue: IssueRef
    source: Literal["github", "work_request"]
    work_request_id: str | None
    target_branch: str
    risk_level: int
    attempt: int
    state: JobState
    repair_count: int = 0
    cancel_requested: bool = False
```

`JobStore` must expose:

```python
create(job: Job) -> None
claim_next(controller_id: str) -> Job | None
get(job_id: str) -> Job | None
get_by_issue(issue: IssueRef) -> Job | None
transition(job_id: str, next_state: JobState, evidence: Mapping[str, object] | None = None) -> Job
request_cancel(job_id: str, requested_by: str) -> Job
record_command(repository: str, comment_id: int, command: str, actor: str) -> bool
record_stage_result(job_id: str, stage: str, result: Mapping[str, object]) -> None
```

Use `BEGIN IMMEDIATE` for claims and a unique constraint on `(repository, issue_number, attempt)`. Persist the selected OpenCode model, routing version, provider usage metadata, worktree, branch, PR URL, gate result, verification result, timestamps, and terminal reason. Store no provider access token or full environment.

- [ ] **Step 5: Replace hard-coded repository configuration**

`config.py` loads the JSON policy, `FORGE_STATE_DB`, controller identity, maintainer allowlist, polling intervals, cancellation grace period, and provider command paths. Remove `OSI_OS_REPO` as the global source of truth. Validate all configured paths with `Path.resolve()` and fail startup when a checkout escapes `/home/forge-runner/repos`.

- [ ] **Step 6: Run focused and full Python tests**

Run:

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_domain.py tests/test_job_store.py tests/test_config.py -q
python3 -m pytest tests -q
```

Expected: both commands exit `0`.

- [ ] **Step 7: Commit Task 1**

```bash
git add forge/forge/config.py forge/forge/domain.py forge/forge/job_store.py forge/policy/repositories.json forge/tests/test_domain.py forge/tests/test_job_store.py forge/tests/test_config.py
git commit -m "feat: add Forge job state and repository policy"
```

## Task 2: Add subscription-only provider adapters

**Repository:** `osi-server`

**Files:**

- Create: `forge/forge/auth.py`
- Create: `forge/forge/providers/__init__.py`
- Create: `forge/forge/providers/base.py`
- Create: `forge/forge/providers/claude.py`
- Create: `forge/forge/providers/codex.py`
- Create: `forge/forge/providers/opencode.py`
- Test: `forge/tests/test_auth.py`
- Test: `forge/tests/test_providers.py`
- Modify: `forge/pyproject.toml`

- [ ] **Step 1: Write failing command-contract and auth tests**

Assert the full argv and sanitized environment. Minimum assertions:

```python
assert "--no-session-persistence" in claude.argv
assert "--model" in claude.argv and "claude-opus-4-8" in claude.argv
assert "--max-budget-usd" not in claude.argv
assert "--dangerously-skip-permissions" not in claude.argv

assert "--ephemeral" in codex.argv
assert "--ignore-user-config" in codex.argv
assert "--full-auto" not in codex.argv
assert "-s" in codex.argv

assert opencode.argv[:2] == ("opencode", "run")
assert "--pure" in opencode.argv
assert "--agent" in opencode.argv and "forge-review" in opencode.argv
assert "--port" in opencode.argv and "4096" in opencode.argv

assert "OPENAI_API_KEY" not in env
assert "ANTHROPIC_API_KEY" not in env
assert "OPENCODE_API_KEY" not in env
```

Also test that API-key Codex output, logged-out Claude JSON, stale OpenCode attestation, a non-Go model, malformed structured output, and known usage-exhaustion messages fail closed.

- [ ] **Step 2: Run the tests and record RED**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_auth.py tests/test_providers.py -q
```

Expected: failure because adapters are absent.

- [ ] **Step 3: Implement provider-neutral request and result records**

Use a provider protocol with no controller-specific imports:

```python
@dataclass(frozen=True)
class Invocation:
    stage: str
    model: str
    worktree: Path
    prompt_file: Path
    output_schema: Path
    output_file: Path
    timeout_seconds: int
    sandbox: Literal["read-only", "workspace-write"]

@dataclass(frozen=True)
class ProviderResult:
    exit_code: int
    structured: Mapping[str, object]
    stdout_path: Path
    stderr_path: Path
    usage: Mapping[str, object]
    duration_seconds: float

class Provider(Protocol):
    def preflight(self) -> None: ...
    def command(self, invocation: Invocation) -> CommandSpec: ...
    def parse_result(self, invocation: Invocation, completed: CompletedProcess[str]) -> ProviderResult: ...

class ProviderExecutor(Protocol):
    def run(self, job_id: str, command: CommandSpec) -> CompletedProcess[str]: ...
    def cancel(self, job_id: str) -> None: ...
```

Use an in-process fake executor in tests. Production uses the root-owned `forge-stage-exec` launcher from Task 9. The launcher maps the stage to a fixed service account and starts a transient systemd unit; it never accepts an executable, UID, arbitrary path, or shell fragment from the caller. Inside that unit, run the CLI with `stdin=subprocess.DEVNULL`, explicit timeout, explicit cwd, and a minimal allowlisted environment. Write stdout and stderr under the job log directory. Do not interpolate prompts through a shell.

- [ ] **Step 4: Implement exact subscription preflights**

- Codex: run `codex login status` as `forge-codex`; accept only output containing `Logged in using ChatGPT`. Reject `Logged in using an API key` and any `OPENAI_API_KEY` in the inherited environment.
- Claude: run `claude auth status --json` as `forge-claude`; require `loggedIn=true`, `authMethod="claude.ai"`, and `apiProvider="firstParty"`. Reject any `ANTHROPIC_API_KEY`.
- OpenCode: run as `forge-opencode` with an isolated `XDG_CONFIG_HOME` and `XDG_DATA_HOME`; require the selected model to start with `opencode-go/` and appear in policy; require a root-owned `0600` attestation file whose JSON contains `use_balance_disabled=true` and a future `expires_at`. Reject generic OpenCode or Zen credentials in the sanitized environment.

The attestation schema is:

```json
{
  "schema_version": 1,
  "account": "forge-go-subscription",
  "use_balance_disabled": true,
  "checked_at": "2026-07-15T00:00:00Z",
  "expires_at": "2026-08-15T00:00:00Z",
  "checked_by": "operator-github-login"
}
```

Do not claim that the controller can query the account-level toggle. It verifies only this operator attestation.

- [ ] **Step 5: Implement the exact CLI shapes**

Planner/reviewer Claude shape:

```text
claude --print --model claude-opus-4-8 --no-session-persistence \
  --output-format json --json-schema <schema> \
  --allowedTools Read,Glob,Grep,Bash(git diff:*),Bash(git status:*),Bash(git log:*) \
  < <prompt-file>
```

Codex read-only critic/reviewer shape:

```text
codex exec --ephemeral --ignore-user-config -C <worktree> \
  -m gpt-5.6-sol -s read-only --output-schema <schema> \
  -o <output-file> < <prompt-file>
```

Codex implementer/repairer shape:

```text
codex exec --ephemeral --ignore-user-config -C <worktree> \
  -m gpt-5.6-luna -s workspace-write --output-schema <schema> \
  -o <output-file> < <prompt-file>
```

OpenCode reviewer shape:

```text
opencode run --pure --model <allowlisted-go-model> --agent forge-review \
  --format json --dir <worktree> --port 4096 <prompt>
```

At implementation time, capture `--help` output from all three installed versions as a deployment artifact. If a flag differs, update the adapter and its test before enabling the service. Never add Claude `--bare`; it disables subscription OAuth for this use case.

- [ ] **Step 6: Classify usage exhaustion separately from execution failure**

`classify_provider_failure(provider, exit_code, stderr)` returns one of `USAGE_EXHAUSTED`, `AUTH_INVALID`, `OUTPUT_INVALID`, `TIMED_OUT`, or `EXECUTION_FAILED`. Match only version-controlled provider-specific patterns and preserve a redacted excerpt. Unknown failures become `EXECUTION_FAILED`, not usage exhaustion.

- [ ] **Step 7: Run tests and commit**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_auth.py tests/test_providers.py -q
python3 -m pytest tests -q
git add forge/forge/auth.py forge/forge/providers forge/tests/test_auth.py forge/tests/test_providers.py forge/pyproject.toml
git commit -m "feat: add subscription-only Forge providers"
```

Expected: tests exit `0`; staged diff contains no credential value.

## Task 3: Add GitHub issue intake, mobile commands, and source deduplication

**Repository:** `osi-server`

**Files:**

- Create: `forge/forge/job_sources.py`
- Modify: `forge/forge/controller.py`
- Modify: `forge/forge/github_pr.py`
- Test: `forge/tests/test_job_sources.py`
- Test: `forge/tests/test_mobile_commands.py`
- Test: `forge/tests/test_controller.py`
- Test: `forge/tests/test_github_pr.py`

- [ ] **Step 1: Write failing source and command tests**

Cover:

- `forge-ready` issue from either approved repository becomes a normalized job.
- Unapproved repository, risk `3+`, pull request, locked issue, and non-allowlisted actor are ignored with a recorded reason.
- A WorkRequest and GitHub scan referring to the same `repo#issue` produce one job; the WorkRequest-backed record wins so server reporting remains linked.
- A command below quoted text or later in a comment is ignored.
- A repeated comment ID is idempotent.
- `/forge model` accepts only the four OpenCode Go IDs.
- Cancellation sets the database flag and sends a signal only to the current job process group.
- Dynamic PR publishing uses the job repository and rejects a branch whose recorded repository differs.

- [ ] **Step 2: Run focused tests and record RED**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_job_sources.py tests/test_mobile_commands.py tests/test_controller.py tests/test_github_pr.py -q
```

- [ ] **Step 3: Implement two `JobSource` adapters**

```python
class JobSource(Protocol):
    def discover(self) -> Sequence[CandidateJob]: ...
    def acknowledge(self, candidate: CandidateJob, job: Job) -> None: ...
    def report(self, job: Job, projection: StatusProjection) -> None: ...

class GitHubIssueSource(JobSource): ...
class WorkRequestSource(JobSource): ...
```

GitHub discovery queries open issues with `forge-ready` in both configured repositories through the existing GitHub App installation. WorkRequest discovery retains the existing eligible endpoint. Normalize and deduplicate before claiming. Sort deterministically by source priority, creation time, repository name, and issue number.

- [ ] **Step 4: Implement the exact command parser**

Use an anchored parser, not substring matching:

```python
COMMAND = re.compile(
    r"^/forge (?P<verb>start|status|cancel|retry|model)"
    r"(?: (?P<argument>[^\r\n]+))?$"
)

def first_non_empty_line(body: str) -> str:
    return next((line.strip() for line in body.splitlines() if line.strip()), "")
```

Validate actor login against the maintainer allowlist after GitHub App identity verification. Record comment ID before applying a side effect in the same SQLite transaction. A failed side effect records a retryable command result without applying it twice.

- [ ] **Step 5: Project labels and comments**

Create one status projection table in code. Comments include job ID, attempt, state, current stage, selected models, elapsed time, last successful gate, failure category, redacted log reference, and PR link when present. Do not publish raw prompts, provider stderr, environment variables, tokens, or server filesystem paths.

- [ ] **Step 6: Generalize worktree, push, and PR operations**

Remove OSI OS constants from `controller.py` and `github_pr.py`. Resolve checkout, GitHub repository, verification profile, branch prefix, and base branch from the immutable job policy. Branch names follow:

```text
forge/<repo-short-name>/<issue-number>-<slug>/attempt-<n>
```

Publish through the existing GitHub App token. Set draft status unconditionally. Reject an existing non-Forge branch, a non-draft existing PR, or a remote branch whose head SHA does not equal the recorded local head.

- [ ] **Step 7: Run tests and commit**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_job_sources.py tests/test_mobile_commands.py tests/test_controller.py tests/test_github_pr.py -q
python3 -m pytest tests -q
git add forge/forge/job_sources.py forge/forge/controller.py forge/forge/github_pr.py forge/tests/test_job_sources.py forge/tests/test_mobile_commands.py forge/tests/test_controller.py forge/tests/test_github_pr.py
git commit -m "feat: add GitHub Mobile control to Forge"
```

## Task 4: Enable bounded WorkRequest intake for both repositories

**Repository:** `osi-server`

**Files:**

- Modify: `backend/src/main/java/org/osi/server/workrequest/ForgeService.java`
- Modify: `backend/src/main/java/org/osi/server/workrequest/WorkRequestAdminService.java`
- Modify: `backend/src/test/java/org/osi/server/workrequest/ForgeServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/workrequest/WorkRequestAdminServiceTest.java`
- Modify: `forge/forge/skill_index.py`
- Test: `forge/tests/test_skill_index.py`

- [ ] **Step 1: Write failing backend tests**

Add parameterized tests proving that `osi-os` and `osi-server` are eligible and dispatchable at risk `0..2`; an unknown repository and risk `3` are rejected. Preserve every existing eligibility condition.

```java
@ParameterizedTest
@ValueSource(strings = {
    "Open-Smart-Irrigation/osi-os",
    "Open-Smart-Irrigation/osi-server"
})
void eligibleAllowsOnlyApprovedForgeRepositories(String repository) {
    // create a reviewed, ready, risk-2 request for repository
    // assert eligible response contains it
}
```

- [ ] **Step 2: Run focused Gradle tests and record RED**

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test \
  --tests 'org.osi.server.workrequest.ForgeServiceTest' \
  --tests 'org.osi.server.workrequest.WorkRequestAdminServiceTest' \
  -x buildFrontend -x buildTerraIntelligenceFrontend
```

Expected: the new OSI Server cases fail under the existing OSI OS-only filter.

- [ ] **Step 3: Replace duplicated allowlists with one immutable backend set**

Use the same exact two repository names in `ForgeService` and `WorkRequestAdminService`. Do not broaden by organization prefix. Do not add a database migration; the WorkRequest entity already carries repository and issue identity.

- [ ] **Step 4: Extend skill selection without weakening boundaries**

For OSI Server jobs, include `osi-server-backend-patterns`, `osi-common-pitfalls`, `osi-forge-boundaries`, and the applicable verification guidance. Preserve OSI OS skill selection. The controller supplies skill text as context; workers do not gain permission to edit skill files or leave the worktree.

- [ ] **Step 5: Run backend and Python tests**

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test \
  --tests 'org.osi.server.workrequest.ForgeServiceTest' \
  --tests 'org.osi.server.workrequest.WorkRequestAdminServiceTest' \
  -x buildFrontend -x buildTerraIntelligenceFrontend

cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_skill_index.py tests -q
```

Expected: both commands exit `0`.

- [ ] **Step 6: Commit Task 4**

```bash
cd /home/phil/Repos/osi-server
git add backend/src/main/java/org/osi/server/workrequest/ForgeService.java backend/src/main/java/org/osi/server/workrequest/WorkRequestAdminService.java backend/src/test/java/org/osi/server/workrequest/ForgeServiceTest.java backend/src/test/java/org/osi/server/workrequest/WorkRequestAdminServiceTest.java forge/forge/skill_index.py forge/tests/test_skill_index.py
git commit -m "feat: allow bounded Forge work in both repositories"
```

## Task 5: Replace the three-pass pipeline with the settled role graph

**Repository:** `osi-server`

**Files:**

- Modify: `forge/forge/pipeline.py`
- Create: `forge/schemas/plan_critique_schema.json`
- Modify: `forge/schemas/review_schema.json`
- Create: `forge/schemas/adjudication_schema.json`
- Create: `forge/prompts/plan_critic.md`
- Create: `forge/prompts/codex_reviewer.md`
- Create: `forge/prompts/opencode_reviewer.md`
- Create: `forge/prompts/claude_adjudicator.md`
- Create: `forge/prompts/repair.md`
- Test: `forge/tests/test_pipeline_roles.py`
- Test: `forge/tests/test_pipeline_repair.py`
- Test: `forge/tests/test_pipeline_cancellation.py`

- [ ] **Step 1: Write failing orchestration tests using fake providers**

Assert exact order and models:

```python
assert calls == [
    ("plan", "claude", "claude-opus-4-8"),
    ("plan_critique", "codex", "gpt-5.6-sol"),
    ("implement", "codex", "gpt-5.6-luna"),
    ("review_codex", "codex", "gpt-5.6-sol"),
    ("review_opencode", "opencode", selected_go_model),
    ("review_claude", "claude", "claude-opus-4-8"),
]
```

Add tests for one plan revision, rejection after one recheck, deterministic gate veto, one repair cycle, full fresh review after repair, cancellation at each boundary, usage exhaustion at each provider, and malformed reviewer output.

- [ ] **Step 2: Run focused tests and record RED**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_pipeline_roles.py tests/test_pipeline_repair.py tests/test_pipeline_cancellation.py -q
```

- [ ] **Step 3: Define strict structured outputs**

Plan critique requires:

```json
{
  "decision": "approve|revise|block",
  "findings": [
    {
      "id": "PLAN-001",
      "severity": "critical|high|medium|low",
      "claim": "string",
      "evidence": [{"path": "string", "line": 1, "detail": "string"}],
      "required_change": "string"
    }
  ]
}
```

All three code reviewers use one review schema with `reviewer`, `decision`, `findings`, and `verification_observations`. Claude adjudication adds `accepted_finding_ids`, `rejected_findings` with reasons, `independent_findings`, and `final_decision`. Finding IDs are namespaced by reviewer and stable within an attempt.

Reject output that fails JSON Schema validation. Do not recover prose heuristically.

- [ ] **Step 4: Implement bounded plan criticism**

Claude writes the plan. Sol receives the issue, repository context, deterministic scope policy, and plan. If Sol returns `revise`, a fresh Claude invocation receives only the original inputs plus structured findings and may revise once. A fresh Sol invocation rechecks once. A second `revise` or any `block` ends in `BLOCKED`.

- [ ] **Step 5: Implement independent verification and three-review adjudication**

After implementation, run deterministic gates and repository verification before reviewers. Codex Sol and OpenCode receive the issue, plan, diff, and verification report independently. Claude receives those same materials plus both structured reviews. Its prompt requires an independent diff review before adjudication. It cannot change a gate or command result.

- [ ] **Step 6: Implement one repair cycle**

When Claude returns `repair`, build a repair packet from accepted findings only. A fresh Luna invocation may edit the worktree. Increment `repair_count` before launch in the same transaction. Then discard prior gate and review approvals, rerun all deterministic gates and verification, and invoke all reviewers fresh. Any remaining rejection becomes `BLOCKED`.

- [ ] **Step 7: Persist the execution report**

Write `execution-report.md` in the job artifact directory, not in the target repository. Include issue identity, commit base/head, stage timestamps, provider/model per stage, selected OpenCode route and reason, routing-policy version, redacted usage fields emitted by CLIs, gates and commands with exit codes, reviewer decisions, accepted/rejected findings, repair count, and PR URL. Never include secrets or raw auth state.

- [ ] **Step 8: Run tests and commit**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_pipeline_roles.py tests/test_pipeline_repair.py tests/test_pipeline_cancellation.py -q
python3 -m pytest tests -q
git add forge/forge/pipeline.py forge/schemas forge/prompts forge/tests/test_pipeline_roles.py forge/tests/test_pipeline_repair.py forge/tests/test_pipeline_cancellation.py
git commit -m "feat: orchestrate the Forge review council"
```

## Task 6: Add benchmark-driven OpenCode Go routing

**Repository:** `osi-server`

**Files:**

- Create: `forge/policy/opencode-routing.json`
- Create: `forge/forge/model_routing.py`
- Create: `forge/forge/benchmark.py`
- Test: `forge/tests/test_model_routing.py`
- Test: `forge/tests/test_benchmark.py`
- Extend: `forge/README.md`

- [ ] **Step 1: Write failing policy, classification, and promotion tests**

Cover exact allowlist, default model, deterministic path classification, human override validation, ten-case minimum, critical-recall ranking, tie breakers, and a refusal to activate a route with missing evidence.

- [ ] **Step 2: Run focused tests and record RED**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_model_routing.py tests/test_benchmark.py -q
```

- [ ] **Step 3: Add an inactive-by-default policy**

`forge/policy/opencode-routing.json`:

```json
{
  "schema_version": 1,
  "routing_version": "2026-07-15.1",
  "default_model": "opencode-go/deepseek-v4-pro",
  "minimum_cases_per_class": 10,
  "allowlist": [
    "opencode-go/deepseek-v4-pro",
    "opencode-go/kimi-k2.7-code",
    "opencode-go/qwen3.7-max",
    "opencode-go/glm-5.2"
  ],
  "routes": {}
}
```

- [ ] **Step 4: Implement deterministic task classification**

Classification uses target repository plus changed paths after implementation. Order from most specific to least specific:

1. Sync contracts, outbox/inbox/cursor, pending commands, or matching edge/cloud resource paths: `sync_cross_repo`.
2. OSI OS flows, SQLite migrations, seed DB, or runtime schema: `edge_flow_schema`.
3. OSI OS React GUI: `edge_frontend`.
4. OSI Server backend, frontend, Terra, prediction service, or Flyway: `server_backend_flyway`.
5. Documentation and configuration-only changes: `docs_config`.

If multiple classes match, record all matches and choose the first by this precedence. Unknown paths use the default model and reason `unclassified_default`.

- [ ] **Step 5: Implement an offline benchmark harness**

The harness consumes versioned case manifests with repository, base SHA, patch SHA, task class, seeded critical findings, admissible evidence paths, and expected non-findings. It invokes each allowlisted model through the read-only OpenCode adapter and writes raw structured results outside the target repository. It calculates critical recall, false-positive rate, evidence-path validity, median duration, and usage metadata when available.

Benchmark execution is an operator action, never part of a live job. Promotion emits a proposed routing-policy patch for human review; it does not edit active policy automatically.

- [ ] **Step 6: Document model-selection evidence**

Add commands for creating a case, running all candidates, producing a report, and reviewing a proposed policy change. State that empty routes mean DeepSeek V4 Pro by default and that no model-specific quality claim exists until real benchmark results are committed.

- [ ] **Step 7: Run tests and commit**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_model_routing.py tests/test_benchmark.py -q
python3 -m pytest tests -q
git add forge/policy/opencode-routing.json forge/forge/model_routing.py forge/forge/benchmark.py forge/tests/test_model_routing.py forge/tests/test_benchmark.py forge/README.md
git commit -m "feat: add evidence-based OpenCode routing"
```

## Task 7: Harden gates, recovery, and cancellation

**Repository:** `osi-server`

**Files:**

- Modify: `forge/forge/gates.py`
- Modify: `forge/forge/controller.py`
- Modify: `forge/forge/pipeline.py`
- Test: `forge/tests/test_gates.py`
- Test: `forge/tests/test_recovery.py`
- Test: `forge/tests/test_cancellation.py`

- [ ] **Step 1: Write failing boundary and crash-recovery tests**

Add cases for symlink escape, nested Git repository, submodule change, worktree path escape, forbidden file, secret-like patch, diff over 5,000 lines, target-repository mismatch, dirty base, untracked generated credentials, host-local URL in agent-written files, and a PR head that differs from the verified SHA.

Recovery tests simulate a crash before and after every durable transition. A restarted controller must either resume at a safe deterministic boundary or fail the job with a precise reason. It must never repeat a side effect whose idempotency key was recorded.

- [ ] **Step 2: Run focused tests and record RED**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_gates.py tests/test_recovery.py tests/test_cancellation.py -q
```

- [ ] **Step 3: Make verification evidence SHA-bound**

Before gates, record base SHA and candidate SHA. After each model invocation and verification command, recalculate candidate SHA and dirty-state fingerprint. A stage result is valid only for its recorded fingerprint. Before push and before draft PR creation, require the candidate SHA to equal the last fully approved SHA.

- [ ] **Step 4: Add cancellation checkpoints and process-group termination**

Check `cancel_requested` before and after every external call and between commands. On active cancellation, send `SIGTERM` to the job process group, wait the configured grace period, send `SIGKILL` if needed, mark `CANCELLED`, remove the worktree only after process exit, and retain redacted artifacts according to retention policy.

- [ ] **Step 5: Add fail-closed restart behavior**

Safe resumable boundaries are `READY`, before a provider invocation, before deterministic verification, and before PR publication. A crash during a write-capable model invocation invalidates the worktree and starts a new attempt after operator `/forge retry`; do not guess whether the provider finished. A crash after a draft PR was created reconciles by issue, branch, and head SHA before changing state.

- [ ] **Step 6: Run tests and commit**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_gates.py tests/test_recovery.py tests/test_cancellation.py -q
python3 -m pytest tests -q
git add forge/forge/gates.py forge/forge/controller.py forge/forge/pipeline.py forge/tests/test_gates.py forge/tests/test_recovery.py forge/tests/test_cancellation.py
git commit -m "fix: bind Forge approvals to verified state"
```

## Task 8: Extend OSI Forge boundaries to both repositories

**Repository:** `osi-os`

**Files:**

- Modify: `.claude/skills/osi-forge-boundaries/SKILL.md`

- [ ] **Step 1: Create the OSI OS worktree from current `origin/main`**

Use `superpowers:using-git-worktrees`. Confirm that the worktree contains none of the user's unrelated untracked plan/spec files from the original checkout.

- [ ] **Step 2: Update the Stage 1 boundary text**

Make these rules explicit:

- Forge supports both approved repositories, one repository per job.
- Controller-created job branches use `forge/<repo-short-name>/<issue-number>-<slug>/attempt-<n>` as defined in Task 3. Update the Stage 1 `agent/*`-only gate accordingly; legacy `agent/req-*` branches may remain readable for historical jobs but are not the new creation pattern.
- An OSI Server job may run repository-owned backend/frontend tests but cannot deploy a server, access production, read live secrets, or use Docker sockets.
- A Forge worker cannot SSH, use Tailscale, call controller admin commands, merge, deploy, or change provider/auth policy.
- The separate human `forge-admin` Tailscale path is an operator path, not a worker capability.
- GitHub Mobile commands are limited to start, status, cancel, retry, and allowlisted OpenCode reviewer override.
- All successful outputs are draft PRs.
- Subscription exhaustion blocks the job and cannot trigger API or paid fallback.

Preserve existing forbidden actions and evidence rules. Do not weaken OSI OS edge, hardware, schema, or production restrictions.

- [ ] **Step 3: Run documentation checks**

```bash
cd /home/phil/Repos/osi-os
node .claude/skills/anti-slop-writing/slop-check.js .claude/skills/osi-forge-boundaries/SKILL.md
git diff --check
```

Expected: checker has no Tier 1 findings; `git diff --check` exits `0`.

- [ ] **Step 4: Commit Task 8 in the OSI OS repository**

```bash
git add .claude/skills/osi-forge-boundaries/SKILL.md
git commit -m "docs: extend Forge worker boundaries"
```

Do not include any `osi-server` file in this commit.

## Task 9: Add service, egress, OpenCode, and break-glass operations assets

**Repository:** `osi-server`

**Files:**

- Create: `forge/ops/systemd/osi-forge.service`
- Create: `forge/ops/opencode/agents/forge-review.md`
- Create: `forge/ops/bin/forgectl`
- Create: `forge/ops/bin/forge-stage-exec`
- Create: `forge/ops/sudoers/osi-forge-admin`
- Create: `forge/ops/sudoers/osi-forge-controller`
- Create: `forge/ops/firewalld/forge-runner-egress.sh`
- Create: `forge/tests/test_ops_assets.py`
- Create: `docs/operations/forge-runner-test-server.md`

- [ ] **Step 1: Write failing static tests for operations assets**

Test that the systemd unit uses `forge-runner`, restarts on failure, creates one controller instance, and contains no secret. Test that `forge-stage-exec` maps every stage to exactly one locked account and rejects unknown jobs, stages, actions, paths, and extra arguments. Test that `forgectl` accepts only `status`, `logs`, `cancel`, `retry`, `pause`, `resume`, and `health`. Test both sudoers files expose only their root-owned wrappers. Test that provider firewalld chains reject host loopback except TCP destination port `4096` for `forge-opencode`.

- [ ] **Step 2: Run the tests and record RED**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_ops_assets.py -q
```

- [ ] **Step 3: Add the hardened systemd unit**

The unit must include:

```ini
[Unit]
Description=OSI Forge controller
After=network-online.target firewalld.service
Wants=network-online.target

[Service]
Type=simple
User=forge-runner
Group=forge-runner
WorkingDirectory=/home/forge-runner/forge
EnvironmentFile=/home/forge-runner/config/controller.env
ExecStart=/home/forge-runner/forge/.venv/bin/python -m forge.controller
Restart=on-failure
RestartSec=10
KillMode=control-group
TimeoutStopSec=45
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
ReadWritePaths=/home/forge-runner/jobs /home/forge-runner/logs /home/forge-runner/state /home/forge-runner/repos
InaccessiblePaths=/home/forge-codex /home/forge-claude /home/forge-opencode /home/forge-verifier

[Install]
WantedBy=multi-user.target
```

Validate these directives on Rocky Linux 10 with `systemd-analyze security` and `systemd-analyze verify`. Add tighter address-family or syscall restrictions only after all three subscription CLIs pass their preflight and dry-run tests.

- [ ] **Step 4: Add locked provider and verifier identities plus the fixed stage launcher**

Create `forge-codex`, `forge-claude`, `forge-opencode`, and `forge-verifier` as non-login, non-sudo service accounts with `0700` homes and no Docker membership. Interactive provider login is performed by an operator with `sudo -u <account> -H <cli> login`, not SSH. Add all five Forge identities to a narrow `forge-jobs` group used only for current job worktrees and typed artifacts. Use setgid directories and an explicit `umask 007`; controller configuration and each provider home remain outside that group.

`forge-stage-exec` is root-owned and accepts only:

```text
forge-stage-exec start  <job-uuid> <stage>
forge-stage-exec status <job-uuid> <stage>
forge-stage-exec cancel <job-uuid> <stage>
```

It resolves a root/controller-owned stage manifest under the fixed job root, checks owner/mode, canonical worktree, stage/model policy, schema path, timeout, and current job state, then creates a transient `osi-forge-agent-<job>-<stage>.service`. The stage determines the identity: Claude stages use `forge-claude`, Codex stages use `forge-codex`, OpenCode review uses `forge-opencode`, and deterministic repository commands use `forge-verifier`. Cancellation stops the transient unit and its cgroup. The controller sudoers file permits `forge-runner` to invoke only this wrapper.

Provider homes hold only that provider's subscription state and cache. `forge-verifier` has no provider or GitHub credentials and runs prewarmed repository commands offline. Add negative tests proving every account is denied access to `/home/forge-runner/config`, `.ssh`, other provider homes, and controller process environments.

- [ ] **Step 5: Add the read-only OpenCode reviewer agent**

The global agent file denies edit, write, patch, web fetch, external directories, task delegation, and Bash by default. Permit only repository reads plus exact read-only Git commands needed for review:

```yaml
permission:
  edit: deny
  external_directory: deny
  webfetch: deny
  task: deny
  bash:
    "*": deny
    "git diff*": allow
    "git log*": allow
    "git status*": allow
```

Run OpenCode with `--agent forge-review`, `--pure`, and fixed port `4096`. Do not use `--dangerously-skip-permissions`.

- [ ] **Step 6: Apply per-identity egress policy**

The root-owned idempotent script must rebuild per-UID chains atomically:

- `forge-runner`: configured DNS plus TCP `443` to GitHub and the OSI test-server API only.
- `forge-claude`: configured DNS plus TCP `443` to Claude subscription endpoints only.
- `forge-codex`: configured DNS plus TCP `443` to Codex ChatGPT subscription endpoints only.
- `forge-opencode`: configured DNS, TCP `443` to OpenCode Go endpoints, and loopback TCP destination port `4096` only.
- `forge-verifier`: no network. Prewarm required Gradle/npm/Python caches during deployment, then run repository verification in offline mode.

Reject all other loopback, RFC1918, link-local, Tailscale CGNAT, metadata addresses, and remaining egress. The implementation must document how hostnames refresh safely and what happens when an endpoint changes. A failed refresh leaves the last known allowset in place and raises health failure; it does not open broad `443`.

The exception for port `4096` exists only because OpenCode starts its local review server there. Before that stage starts, fail if another process already listens on that port.

- [ ] **Step 7: Add the root-owned `forgectl` wrapper**

The wrapper validates a fixed verb and, where required, a Forge job UUID. It calls systemd/journalctl or writes a typed controller command through a root-owned local command directory. It never accepts shell fragments, paths, provider commands, model names, merge commands, deploy commands, or secret-printing commands.

Map commands:

```text
status [job-id]
logs <job-id>
cancel <job-id>
retry <job-id>
pause
resume
health
```

Grant `forge-admin` passwordless sudo only for `/usr/local/sbin/forgectl` through the supplied sudoers file. `forge-admin` is not a member of `forge-runner`, `docker`, `wheel`, or any repository-writing group.

- [ ] **Step 8: Write the test-server runbook**

Include:

1. Record the current no-runtime state, then back up `/home/rocky/osi-server/forge` at the audited SHA, any discovered Forge configuration, cron entries, and firewall rules with secrets excluded from copied evidence. Do not assume `/home/forge-runner` paths exist.
2. Installation from reviewed commit SHAs.
3. Python virtual environment creation with test dependencies and a full pytest pass before activation.
4. Creation of locked provider/verifier accounts, shared-job permissions, the fixed stage launcher, and cross-account denial tests.
5. Codex logout from API-key auth and interactive ChatGPT subscription login as `forge-codex`.
6. Claude subscription login as `forge-claude` and JSON auth preflight.
7. OpenCode installation as `forge-opencode`, isolated XDG state, Go subscription connection, “Use balance” disabled in the console, root-owned attestation creation, and allowlisted model smoke test.
8. Revocation of old provider API keys after confirming no other service uses them. Remove API-key environment variables only after revocation planning is complete.
9. Migration of the secondary WorkRequest source from the old localhost mapping to the approved test-server HTTPS endpoint before blanket loopback is removed.
10. Firewalld update and explicit proof that provider and verifier identities cannot reach test-server host services, private addresses, controller endpoints, peer-provider endpoints, or arbitrary internet endpoints.
11. systemd install, daemon reload, start, liveness, restart, cancellation, and crash-recovery tests.
12. Removal of the obsolete liveness cron only after systemd health is proven. Preserve or replace job garbage collection deliberately.
13. Rollback to the saved controller/config/firewall state without touching production.

For Tailscale on Rocky Linux 10, document the current official installation path:

```bash
sudo dnf config-manager --add-repo https://pkgs.tailscale.com/stable/rhel/10/tailscale.repo
sudo dnf install tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up --ssh --advertise-tags=tag:forge-controller
```

Validate current package and policy syntax against official Tailscale documentation at execution time. Use a tailnet policy equivalent to:

```json
{
  "tagOwners": {
    "tag:forge-controller": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["autogroup:admin"],
      "dst": ["tag:forge-controller"],
      "ip": ["tcp:22"]
    }
  ],
  "ssh": [
    {
      "action": "check",
      "checkPeriod": "always",
      "src": ["autogroup:admin"],
      "dst": ["tag:forge-controller"],
      "users": ["forge-admin"]
    }
  ]
}
```

This plan adds no Tailscale root login. It does not silently remove the server's existing `rocky` administration path; changing that access is a separate operator decision. The new `forge-admin` path is tailnet-only.

- [ ] **Step 9: Run static checks and commit**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m pytest tests/test_ops_assets.py -q

cd /home/phil/Repos/osi-server
node /home/phil/Repos/osi-os/.claude/skills/anti-slop-writing/slop-check.js docs/operations/forge-runner-test-server.md
git diff --check
git add forge/ops forge/tests/test_ops_assets.py docs/operations/forge-runner-test-server.md
git commit -m "ops: harden the Forge test-server service"
```

## Task 10: Perform independent local verification and open two draft PRs

**Repositories:** `osi-server`, then `osi-os`

- [ ] **Step 1: Rebase or merge current `origin/main` into each worktree as appropriate**

Resolve each repository independently. Do not squash. Record branch, base SHA, head SHA, and worktree path.

- [ ] **Step 2: Run the full Forge Python suite in a clean virtual environment**

```bash
cd /home/phil/Repos/osi-server/forge
python3 -m venv /tmp/osi-forge-verify
/tmp/osi-forge-verify/bin/pip install -e '.[test]'
/tmp/osi-forge-verify/bin/python -m pytest tests -q
```

Expected: exit `0` with no skipped security, provider, recovery, or operations tests.

- [ ] **Step 3: Run OSI Server backend tests**

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test \
  --tests 'org.osi.server.workrequest.ForgeServiceTest' \
  --tests 'org.osi.server.workrequest.WorkRequestAdminServiceTest' \
  -x buildFrontend -x buildTerraIntelligenceFrontend
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Run repository checks**

```bash
cd /home/phil/Repos/osi-server
git diff --check origin/main...HEAD

cd /home/phil/Repos/osi-os
node .claude/skills/anti-slop-writing/slop-check.js .claude/skills/osi-forge-boundaries/SKILL.md
git diff --check origin/main...HEAD
```

- [ ] **Step 5: Request an independent code review**

Use `superpowers:requesting-code-review`. Review each repository separately against this plan. Treat any cross-repository file leakage, billing fallback, unbounded repair, mutable model choice, missing SHA binding, loopback access, or merge/deploy capability as blocking.

- [ ] **Step 6: Push and open separate draft PRs**

Open one draft PR against `osi-server/main` for controller/backend/ops changes and one draft PR against `osi-os/main` for boundary documentation. Link the PRs but preserve their independent commit histories.

## Task 11: Roll out to the test server and prove the full path

**Target:** existing OSI Forge test server only

**Precondition:** Both draft PR heads passed Task 10. The operator has approved test-server mutation in the execution turn. No production access is permitted.

- [ ] **Step 1: Capture pre-rollout evidence and backups**

Record OS, active services, current cron entries, the absence or presence of
`/home/forge-runner` runtime paths, the `/home/rocky/osi-server/forge` source
content fingerprint, repository heads, installed CLI versions, redacted
auth states, firewall rules, UID/group memberships, listening ports, and disk
space. Create the runbook-defined backup. The current baseline is no deployed
runtime, the local comparison baseline `97ec0be`, no provider CLIs, and no Forge
service.

- [ ] **Step 2: Install reviewed controller artifacts and test dependencies**

Deploy from the reviewed OSI Server commit SHA into the newly created
`/home/forge-runner/forge` runtime root. Do not use `/home/rocky/osi-server/forge`
as the service working directory and do not reuse the stale
`feat/forge-controller-stage1` checkout. Build the virtual environment and run
the entire Python suite on the server. Stop if pytest is unavailable or any
test fails.

- [ ] **Step 3: Establish and prove subscription authentication**

Under each dedicated provider identity, prove:

```text
Codex:  Logged in using ChatGPT
Claude: loggedIn=true, authMethod=claude.ai, apiProvider=firstParty
OpenCode: allowlisted opencode-go model succeeds under isolated XDG state
```

Also prove `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are absent from every service environment. Verify the OpenCode attestation owner, mode, and expiry. Prove each provider cannot read controller configuration, peer-provider homes, or verifier state. Redact account identifiers and tokens from evidence.

- [ ] **Step 4: Install egress rules and prove isolation before starting agents**

Required negative tests under every provider and verifier identity:

```text
127.0.0.1:8080            rejected
test-server private IP     rejected except approved external API path
Tailscale CGNAT addresses  rejected
cloud metadata addresses  rejected
unapproved internet host  rejected
```

Required positive tests are identity-specific:

```text
forge-runner GitHub/API    works on approved TCP 443 paths
each provider auth         works only for its own approved TCP 443 paths
OpenCode local port 4096   works only for forge-opencode during its stage
forge-verifier commands    work offline from prewarmed caches
```

Do not start the controller if a negative test unexpectedly succeeds.

- [ ] **Step 5: Install and prove systemd lifecycle**

Run unit verification, start the service, confirm exactly one controller process, kill it to prove restart, reboot or simulate service restart to prove SQLite recovery, and issue pause/resume through `forgectl`. Remove the old liveness cron only after this passes.

- [ ] **Step 6: Install and prove Tailscale break-glass access**

Create `forge-admin`, apply the reviewed sudoers file, install Tailscale, validate tailnet policy, and connect from Android Termux. Prove `status`, `logs`, `health`, and a cancellation against a disposable test job. Prove that `forge-admin` cannot read provider auth files, edit repositories, invoke a provider directly, merge, or deploy.

- [ ] **Step 7: Run dry-run issue intake in both repositories**

Create one maintainer-owned, risk-0 fixture issue in each repository. Exercise `/forge status`, invalid actor rejection, invalid model rejection, valid allowlisted model override, cancellation, retry, and source deduplication. Keep provider write stages disabled for this step.

- [ ] **Step 8: Run one low-risk end-to-end fixture per repository**

Choose documentation-only issues with deterministic acceptance criteria. Apply `forge-ready` from GitHub Mobile. Require the full planner, plan critic, Luna implementation, gates, verification, Sol review, OpenCode review, Claude adjudication, and draft PR flow. Do not merge either PR.

Evidence must show fresh sessions, exact models, subscription preflights, chosen OpenCode route/reason, all command exit codes, final approved SHA, one draft PR per repository, and no forbidden host or production access.

- [ ] **Step 9: Exercise the one-repair path deliberately**

Use a controlled fixture that produces one seeded, repairable finding. Prove exactly one Luna repair invocation and fresh gates plus all three reviewers afterward. Then use a second fixture whose finding remains unresolved and prove the job stops at `forge-blocked` without a second repair.

- [ ] **Step 10: Exercise usage blocking without consuming paid fallback**

Use adapter fixtures or a provider-supported test response to produce `USAGE_EXHAUSTED`. Prove `forge-blocked-usage`, no alternate credential/provider/model, no PR publication, and a useful GitHub Mobile comment. Do not intentionally exhaust a live subscription to test this branch.

- [ ] **Step 11: Close out the rollout**

Record installed commits, service status, firewall fingerprint, auth modes, test issue/PR links, skipped checks, rollback point, and remaining risks. Leave both fixture PRs draft. Do not touch `osicloud.ch`, live gateways, or production data.

## Verification matrix

The test-server column describes expected evidence after Task 9 provisioning;
it is not a statement about the 2026-07-16 baseline. The recheck found no
controller runtime, provider CLI, service account homes, or Forge-specific
firewall chains on the host.

| Invariant | Automated evidence | Test-server evidence |
|---|---|---|
| Existing controller upgraded in place | one package and one service definition | exactly one controller process |
| Two repositories only | policy/backend parameterized tests | fixture issue accepted in each; third repo rejected |
| Neutral orchestration | pipeline order tests with fake providers | stage/model execution report |
| Subscription-only Codex | auth parser tests | `Logged in using ChatGPT`; no API-key env |
| Subscription-only Claude | JSON auth tests | `claude.ai` plus `firstParty`; no API-key env |
| OpenCode Go only | model/attestation tests | Go smoke test and current attestation |
| No paid fallback | environment and failure-class tests | blocked-usage fixture |
| Fresh sessions | exact argv tests | recorded CLI invocation metadata |
| One repair maximum | pipeline repair tests | repair and unresolved fixtures |
| Gates cannot be overridden | gate-veto tests | blocked fixture despite reviewer approval |
| Mobile controls are bounded | parser/actor/idempotency tests | Android GitHub Mobile exercise |
| Break-glass path is bounded | static wrapper/sudoers tests | Termux allow/deny checks |
| Controller/provider secrets are isolated | stage-launcher and cross-account tests | UID/home/process-environment denial probes |
| Host services are isolated | per-identity firewall tests | loopback/private negative probes |
| No merge or deploy | command vocabulary and PR tests | draft PRs remain unmerged |

## External references to verify during execution

- [GitHub Mobile](https://docs.github.com/en/get-started/using-github/github-mobile)
- [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh)
- [Tailscale stable packages](https://pkgs.tailscale.com/stable/)
- [OpenCode Go](https://opencode.ai/docs/go/)
- [OpenCode agents and permissions](https://opencode.ai/docs/agents/)
- [Claude Code subscription login](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [Claude Code model configuration](https://support.claude.com/en/articles/11940350-claude-code-model-configuration)

## Completion definition

This plan is complete only when all local tests pass, both repository-specific draft PRs exist, the test-server service survives restart, the two repository fixtures reach verified draft PRs, the bounded repair and usage-blocked paths are proven, GitHub Mobile control works, Tailscale/Termux break-glass checks pass, and the evidence shows no API-key fallback, paid overage, merge, deploy, production access, or host-local agent access.
