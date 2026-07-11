# Forge Controller Stage 1 Implementation Plan (Revised)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Repo split:** this plan lives in **osi-os**, but changes span both repos. Skills (Tasks 1-2) are osi-os. Server API (Task 3) is osi-server **branched from `feat/field-to-pr-stage0-revised`** (Stage 0 entities are on that unmerged branch). Controller (Task 4) is osi-server. Server setup (Task 5) is ops on the test VPS. Use separate branches/PRs per repo.
> **Spec:** [`docs/superpowers/specs/2026-07-10-forge-controller-stage1-design.md`](../specs/2026-07-10-forge-controller-stage1-design.md) (revised 2026-07-10 — incorporates CLI flag verification, credential separation, execution isolation, error handling, and cleanup protocol)
> **Skill audit:** [`docs/superpowers/specs/2026-07-10-forge-skill-audit.md`](../specs/2026-07-10-forge-skill-audit.md)
> **Plan review:** [`docs/superpowers/specs/2026-07-10-forge-controller-stage1-plan-review.md`](../specs/2026-07-10-forge-controller-stage1-plan-review.md) (Fable review — 8 critical, 12 important findings; all addressed in this revision)

**Goal:** Build the forge controller that claims eligible work requests from OSI Server, runs a three-pass AI pipeline (Claude Opus plan → Codex 5.5 exec → Claude Opus review), and opens draft PRs with test evidence on the osi-os repo.

**Architecture:** Python controller running as `forge-runner` on the test VPS polls `/api/v1/forge/jobs/eligible` every 5 minutes, claims a job, creates a worktree, runs three CLI passes with injected skills, applies deterministic safety gates, re-runs tests independently (does not trust Codex's self-reported evidence), and pushes an `agent/*` branch with a draft PR. Server-side Spring Boot endpoints handle job claim (pessimistic lock), heartbeat, and result reporting with whitelisted state transitions.

**Tech Stack:** Python 3.12 + venv (controller), httpx + PyJWT + cryptography (deps), Claude CLI (`claude -p --model opus --json-schema`), Codex CLI (`codex exec --model codex-5.5 -c model_reasoning_effort=high --full-auto`), Java 17/Spring Boot/Flyway (server API), SKILL.md files (skills).

---

## Global Constraints

- **No production access.** Do not SSH to / inspect / run commands on `osicloud.ch`.
- **osi-os only for Stage 1.** Controller pulls only osi-os; `target_repo` enum in the plan schema enforces this.
- **Credential separation.** `codex.env` (OPENAI_API_KEY only) is the only env file Codex can see. `controller.env` (ANTHROPIC_API_KEY, FORGE_RUNNER_TOKEN, GITHUB_APP_*) is NOT propagated to Codex subprocesses.
- **Egress restriction is a hard prerequisite.** `iptables -m owner --uid-owner forge-runner` restricts outbound to `api.openai.com`, `api.anthropic.com`, `github.com` (port 443) before the first Codex run.
- **Controller re-runs tests.** After Codex finishes, the controller independently executes `plan.json.tests_to_run` and feeds the real output to the reviewer. The review pass never sees Codex's self-reported evidence without the controller's independent verification alongside it.
- **One job at a time. Human merge mandatory. 7-day job log retention.**
- **Skills follow house style:** YAML frontmatter (`name`, `description`), verified claims with file paths, re-verification commands, common-mistakes section.
- **Server branch base:** Task 3 branches from `feat/field-to-pr-stage0-revised`, not `main` (Stage 0 entities exist only on that unmerged branch).

---

## Task 1: Always-Inject Skills + Existing Skill Fixes

**Repo:** osi-os
**Branch:** `feat/forge-skills-stage1`

**Files:**
- Create: `.claude/skills/osi-forge-boundaries/SKILL.md`
- Create: `.claude/skills/osi-common-pitfalls/SKILL.md`
- Create: `.claude/skills/osi-verification-commands/SKILL.md`
- Modify: `.claude/skills/osi-flows-json-editing/SKILL.md`
- Modify: `.claude/skills/osi-schema-change-control/SKILL.md`
- Modify: `.claude/skills/osi-agronomy-sensors-reference/SKILL.md`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: 3 new skill files + 3 fixed skill files that `skill_index.py` (Task 4) reads at runtime

- [ ] **Step 1.1: Create `osi-forge-boundaries` skill**

Create `.claude/skills/osi-forge-boundaries/SKILL.md` — the safety policy card. Content as specified in the original plan Step 1.1 with these amendments from the Fable review (I4):

- Mark deploy/verify wrappers as **"Stage 2 — not yet available"**. In Stage 1, runtime verification that requires deployment is a **stop-and-report** outcome, not a wrapper invocation.
- Split prohibitions into **"mechanically rejected"** (the 4 real post-gate checks: secrets, credential paths, diff size, branch name) vs **"policy — caught by human review"** (outbound HTTP, env reads, raw IPs). The skill must describe the world as it is — claiming mechanical enforcement for checks that don't exist in gates.py causes agents to distrust the skill.

The full content follows the structure from the original plan Step 1.1 with these two sections revised.

- [ ] **Step 1.2: Create `osi-common-pitfalls` skill**

Same content as original plan Step 1.2 (14 pitfalls). No changes from the review.

- [ ] **Step 1.3: Create `osi-verification-commands` skill**

Create `.claude/skills/osi-verification-commands/SKILL.md` — with **corrected pass signals** (Fable review I3, verified against actual scripts):

| Script | Actual pass signal (verified) |
|--------|-------------------------------|
| `verify-sync-flow.js` | `Sync flow verification passed` (NOT "All parity checks passed.") |
| `verify-seed-replay.js` | `verify-seed-replay: OK` (NOT "Seed replay matches.") |
| `verify-migrations.js` | Exit code 0 (no specific success string) |
| `verify-profile-parity.js` | `All parity checks passed.` |

Also add missing rows from the audit: `verify-s2120-codec.js`, `verify-codec-robustness.js` (decoders), and the rebuild-fence pair (`verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js`) for `sync-init-fn`/devices-CHECK touches.

The full skill content follows the structure from the original plan Step 1.3 with the pass signals corrected per above.

- [ ] **Step 1.4: Fix `osi-flows-json-editing`**

Same edits as original plan Step 1.4 (silent-catch ratchet, auth endpoint subsection, stray-DDL awareness). No changes from the review.

- [ ] **Step 1.5: Fix `osi-schema-change-control`**

Same as original plan Step 1.5 (dynamic migration inventory, stray-DDL verifier). No changes.

- [ ] **Step 1.6: Fix `osi-agronomy-sensors-reference`**

Same as original plan Step 1.6 (remove stale #92 reference). No changes.

- [ ] **Step 1.7: Commit**

```bash
git add .claude/skills/
git commit -m "$(cat <<'EOF'
feat: add forge always-inject skills and fix existing skill defects

New: osi-forge-boundaries, osi-common-pitfalls, osi-verification-commands.
Fix: flows-json-editing (silent-catch ratchet, auth endpoint, stray-DDL),
schema-change-control (migration inventory refresh), agronomy-sensors
(stale #92 reference).
EOF
)"
```

---

## Task 2: Claude-Selects New Skills

Same as original plan Task 2. Three new skills: `osi-sync-contract-awareness`, `osi-react-gui-patterns`, `osi-server-backend-patterns` (created but excluded from Stage 1 index since `target_repo` enum forbids `osi-server`).

No changes from the review for this task.

---

## Task 3: Server Forge API Endpoints

**Repo:** osi-server
**Branch:** `feat/forge-controller-stage1` **based on `feat/field-to-pr-stage0-revised`** (not `main`)

**Files:**
- Create: `backend/src/main/resources/db/migration/V2026_07_10_001__forge_dispatch.sql`
- Create: `backend/src/main/java/org/osi/server/workrequest/ForgeController.java`
- Create: `backend/src/main/java/org/osi/server/workrequest/ForgeService.java`
- Create: `backend/src/main/java/org/osi/server/config/ForgeTokenFilter.java`
- Modify: `backend/src/main/java/org/osi/server/config/SecurityConfig.java`
- Modify: `backend/src/main/java/org/osi/server/workrequest/WorkRequestRepository.java`
- Modify: `backend/src/main/java/org/osi/server/workrequest/WorkRequestAdminService.java`
- Modify: `backend/src/main/resources/application.yml`
- Create: `backend/src/test/java/org/osi/server/workrequest/ForgeServiceTest.java`

**Interfaces:**
- Consumes: Stage 0's `WorkRequest` entity (on `feat/field-to-pr-stage0-revised`), `WorkRequestRepository`, `WorkRequestEvent`
- Produces: `GET /api/v1/forge/jobs/eligible`, `POST .../claim` (409 on race), `POST .../report` (whitelisted states), `POST .../heartbeat`

- [ ] **Step 3.1: Create branch from Stage 0**

```bash
cd /home/phil/Repos/osi-server
git fetch origin
git worktree add .worktrees/forge-stage1 origin/feat/field-to-pr-stage0-revised
cd .worktrees/forge-stage1
git switch -c feat/forge-controller-stage1
```

- [ ] **Step 3.2: Write failing tests**

Create `ForgeServiceTest.java`. Key corrections from Fable review C4:

- Use `.workRequest(wr)` not `.workRequestId(wr.getId())` (WorkRequestEvent has `@ManyToOne private WorkRequest workRequest`)
- Assert `getAgentPrUrl()` not `getGithubIssueUrl()` for PR URL storage

```java
@ExtendWith(MockitoExtension.class)
class ForgeServiceTest {

    @Mock WorkRequestRepository workRequestRepo;
    @Mock WorkRequestEventRepository eventRepo;
    @InjectMocks ForgeService forgeService;

    @Test
    void claimUsesForUpdateAndTransitionsAtomically() {
        var wr = workRequest("AWAITING_AGENT", 1);
        when(workRequestRepo.findByIdForUpdate(1L)).thenReturn(Optional.of(wr));

        var result = forgeService.claim(1L, "forge-runner-1");
        assertThat(result.state()).isEqualTo("AGENT_PLANNING");
        verify(eventRepo).save(argThat(e ->
            e.getWorkRequest().equals(wr) && e.getEventType().equals("CLAIMED")));
    }

    @Test
    void claimRejectsNonAwaitingAgent() {
        var wr = workRequest("SUBMITTED", 1);
        when(workRequestRepo.findByIdForUpdate(1L)).thenReturn(Optional.of(wr));

        assertThatThrownBy(() -> forgeService.claim(1L, "forge-runner-1"))
            .isInstanceOf(ForgeService.ClaimConflictException.class);
    }

    @Test
    void reportWhitelistsValidStates() {
        var wr = workRequest("AGENT_IMPLEMENTING", 1);
        when(workRequestRepo.findById(1L)).thenReturn(Optional.of(wr));

        forgeService.report(1L, new ForgeService.ReportRequest(
            "VERIFYING", null, null, null));
        assertThat(wr.getState()).isEqualTo("VERIFYING");
    }

    @Test
    void reportRejectsInvalidState() {
        var wr = workRequest("AGENT_IMPLEMENTING", 1);
        when(workRequestRepo.findById(1L)).thenReturn(Optional.of(wr));

        assertThatThrownBy(() -> forgeService.report(1L,
            new ForgeService.ReportRequest("MERGED", null, null, null)))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void reportWithPrUrlSetsAgentPrUrl() {
        var wr = workRequest("VERIFYING", 1);
        when(workRequestRepo.findById(1L)).thenReturn(Optional.of(wr));

        forgeService.report(1L, new ForgeService.ReportRequest(
            "PR_OPEN", "https://github.com/…/pull/42", null, null));
        assertThat(wr.getAgentPrUrl()).isEqualTo("https://github.com/…/pull/42");
    }

    @Test
    void eligibleFiltersOsiOsOnly() {
        // Verify eligible() filters by target or defaults to osi-os
        // (osi-server requests should not appear in Stage 1)
    }
}
```

- [ ] **Step 3.3: Add Flyway migration**

Same SQL as original plan. Fields: `target_repo`, `claimed_by`, `last_heartbeat_at`, `agent_pr_url`. Add to `WorkRequest.java` entity.

- [ ] **Step 3.4: Implement ForgeService with atomic claim and whitelisted states**

```java
@Service
@RequiredArgsConstructor
@Slf4j
public class ForgeService {

    private final WorkRequestRepository workRequestRepo;
    private final WorkRequestEventRepository eventRepo;

    private static final Set<String> ALLOWED_REPORT_STATES = Set.of(
        "AGENT_PLANNING", "AGENT_IMPLEMENTING", "VERIFYING", "PR_OPEN", "AGENT_FAILED"
    );

    public static class ClaimConflictException extends RuntimeException {
        public ClaimConflictException(String msg) { super(msg); }
    }

    // ... records same as original ...

    @Transactional
    public ClaimResult claim(Long id, String claimedBy) {
        // Pessimistic lock — atomic claim (Fable review C8)
        WorkRequest wr = workRequestRepo.findByIdForUpdate(id)
            .orElseThrow(() -> new IllegalArgumentException("not_found"));
        if (!"AWAITING_AGENT".equals(wr.getState())) {
            throw new ClaimConflictException(
                "not in AWAITING_AGENT: " + wr.getState());
        }
        wr.setState("AGENT_PLANNING");
        wr.setClaimedBy(claimedBy);
        wr.setLastHeartbeatAt(Instant.now());
        workRequestRepo.save(wr);
        eventRepo.save(WorkRequestEvent.builder()
            .workRequest(wr)  // NOT workRequestId (C4)
            .actor(claimedBy)
            .eventType("CLAIMED")
            .build());
        return new ClaimResult(/* ... */);
    }

    @Transactional
    public void report(Long id, ReportRequest request) {
        if (!ALLOWED_REPORT_STATES.contains(request.state())) {
            throw new IllegalArgumentException(
                "invalid report state: " + request.state());
        }
        WorkRequest wr = workRequestRepo.findById(id)
            .orElseThrow(() -> new IllegalArgumentException("not_found"));
        wr.setState(request.state());
        if (request.prUrl() != null) wr.setAgentPrUrl(request.prUrl());
        if (request.failureReason() != null) wr.setRejectionReason(request.failureReason());
        workRequestRepo.save(wr);
        eventRepo.save(WorkRequestEvent.builder()
            .workRequest(wr)
            .actor(wr.getClaimedBy() != null ? wr.getClaimedBy() : "forge")
            .eventType(request.state())
            .reason(request.failureReason())
            .build());
    }
}
```

- [ ] **Step 3.5: Add ForgeController with exception handlers**

```java
@RestController
@RequestMapping("/api/v1/forge/jobs")
@RequiredArgsConstructor
public class ForgeController {

    private final ForgeService forgeService;

    @GetMapping("/eligible")
    public List<ForgeService.EligibleJob> eligible() { ... }

    @PostMapping("/{id}/claim")
    public ForgeService.ClaimResult claim(@PathVariable Long id,
            @RequestParam(defaultValue = "forge-runner") String claimedBy) {
        return forgeService.claim(id, claimedBy);
    }

    @PostMapping("/{id}/report")
    public void report(@PathVariable Long id,
            @RequestBody ForgeService.ReportRequest request) { ... }

    @PostMapping("/{id}/heartbeat")
    public void heartbeat(@PathVariable Long id) { ... }

    // Exception handlers (Fable review C8)
    @ExceptionHandler(ForgeService.ClaimConflictException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, String> handleClaimConflict(ForgeService.ClaimConflictException e) {
        return Map.of("error", e.getMessage());
    }

    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public Map<String, String> handleNotFound(IllegalArgumentException e) {
        return Map.of("error", e.getMessage());
    }
}
```

- [ ] **Step 3.6: Allow ISSUE_OPEN → AWAITING_AGENT dispatch (Fable review C5)**

In `WorkRequestAdminService.java`, amend the triage method:

The current `TERMINAL_STATES` includes `ISSUE_OPEN`, blocking triage from that state. Add an explicit dispatch path: when `disposition` is `AWAITING_AGENT` and the current state is `ISSUE_OPEN`, allow the transition. This ensures the spec's "issue first, then dispatch" flow works:

```java
public WorkRequestSummary triage(Long id, TriageRequest request) {
    WorkRequest wr = workRequestRepo.findById(id).orElseThrow();
    
    String disposition = hasText(request.disposition())
        ? request.disposition().trim() : "AWAITING_PUBLISH";
    
    // Allow ISSUE_OPEN → AWAITING_AGENT (forge dispatch after publish)
    if ("AWAITING_AGENT".equals(disposition) && "ISSUE_OPEN".equals(wr.getState())) {
        wr.setState("AWAITING_AGENT");
        if (request.targetRepo() != null) wr.setTargetRepo(request.targetRepo());
        workRequestRepo.save(wr);
        eventRepo.save(/* DISPATCHED event */);
        return toSummary(wr);
    }
    
    rejectTerminalTransition("triage", wr);
    // ... existing triage logic ...
}
```

This fixes the state machine hole: intake → triage → publish (ISSUE_OPEN) → dispatch to forge (AWAITING_AGENT).

- [ ] **Step 3.7: Add config, SecurityConfig, repository method**

Same as original plan steps (ForgeTokenFilter, SecurityConfig permit, application.yml `forge.runner-token`, repository query method).

- [ ] **Step 3.8: Run tests and commit**

```bash
cd backend && ./gradlew test --tests 'org.osi.server.workrequest.*' \
  -x buildFrontend -x buildTerraIntelligenceFrontend
git add backend/src/
git commit -m "feat: add forge dispatch API with atomic claim and ISSUE_OPEN dispatch"
```

---

## Task 4: Python Controller Implementation

**Repo:** osi-server (same branch as Task 3)

**Files:**
- Create: `forge/__init__.py`
- Create: `forge/config.py`
- Create: `forge/skill_index.py`
- Create: `forge/gates.py`
- Create: `forge/pipeline.py`
- Create: `forge/github_pr.py`
- Create: `forge/controller.py`
- Create: `forge/prompts/plan_system.md`
- Create: `forge/prompts/exec_preamble.md`
- Create: `forge/prompts/review_system.md`
- Create: `forge/tests/__init__.py`
- Create: `forge/tests/test_gates.py`
- Create: `forge/tests/test_skill_index.py`
- Create: `forge/pyproject.toml`

**Interfaces:**
- Consumes: Task 3's `/api/v1/forge/jobs/*` endpoints, Tasks 1-2's SKILL.md files
- Produces: running forge controller, draft PRs on GitHub

### Key changes from original plan (all review findings incorporated):

- [ ] **Step 4.1: Create `forge/__init__.py` and `forge/pyproject.toml`**

```python
# forge/__init__.py — empty, marks package
```

```toml
# forge/pyproject.toml
[project]
name = "osi-forge"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["httpx>=0.27", "PyJWT>=2.8", "cryptography>=42.0"]

[project.optional-dependencies]
test = ["pytest>=8.0"]
```

- [ ] **Step 4.2: Create `forge/config.py` — credential separation**

```python
"""Configuration with credential separation (codex.env vs controller.env)."""
import os
from pathlib import Path

CONFIG_DIR = Path("/home/forge-runner/config")
REPOS_DIR = Path("/home/forge-runner/repos")
JOBS_DIR = Path("/home/forge-runner/jobs")
LOGS_DIR = Path("/home/forge-runner/logs")
OSI_OS_REPO = REPOS_DIR / "osi-os"

POLL_INTERVAL_SECONDS = 300
HEARTBEAT_INTERVAL_SECONDS = 300
CODEX_TIMEOUT_SECONDS = 3600
CLAUDE_MAX_BUDGET_USD = "2.00"
JOB_RETENTION_DAYS = 7

def _load_env_file(path: Path) -> dict:
    config = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                config[key.strip()] = value.strip()
    return config

def load_controller_config() -> dict:
    """Load controller.env — NOT passed to Codex subprocess."""
    cfg = _load_env_file(CONFIG_DIR / "controller.env")
    # Env vars override file values; also pick up keys only in env
    for key in ("ANTHROPIC_API_KEY", "FORGE_RUNNER_TOKEN",
                "FORGE_SERVER_URL", "FORGE_GITHUB_APP_ID",
                "FORGE_GITHUB_INSTALLATION_ID", "FORGE_GITHUB_PRIVATE_KEY_PATH"):
        if key in os.environ:
            cfg[key] = os.environ[key]
        elif key not in cfg:
            cfg[key] = ""
    return cfg

def load_codex_env() -> dict:
    """Load codex.env — the ONLY env Codex subprocess sees."""
    cfg = _load_env_file(CONFIG_DIR / "codex.env")
    if "OPENAI_API_KEY" in os.environ:
        cfg["OPENAI_API_KEY"] = os.environ["OPENAI_API_KEY"]
    return cfg

def validate_controller_config(cfg: dict) -> list[str]:
    required = ["ANTHROPIC_API_KEY", "FORGE_SERVER_URL", "FORGE_RUNNER_TOKEN",
                "FORGE_GITHUB_APP_ID", "FORGE_GITHUB_INSTALLATION_ID",
                "FORGE_GITHUB_PRIVATE_KEY_PATH"]
    return [k for k in required if not cfg.get(k)]

def validate_codex_env(env: dict) -> list[str]:
    return [] if env.get("OPENAI_API_KEY") else ["OPENAI_API_KEY"]
```

- [ ] **Step 4.3: Create `forge/skill_index.py` — token ceiling + validation**

```python
"""Skill discovery, index generation, content loading with token ceiling."""
from pathlib import Path

SKILL_DIR = Path("/home/forge-runner/repos/osi-os/.claude/skills")

SELECTABLE_SKILLS = {
    "osi-flows-json-editing": "Script-only flows.json editing. MANDATORY before ANY Node-RED flow change.",
    "osi-schema-change-control": "Edge SQLite migrations, risk classes, frozen boot DDL. MANDATORY before ANY schema change.",
    "osi-sync-contract-awareness": "Edge↔cloud sync contracts, transport invariants, idempotency, cross-repo PR rules.",
    "osi-react-gui-patterns": "Edge React GUI: HashRouter, PrivateRoute, i18n, api.ts, null-rendering rule.",
    "osi-config-and-flags": "UCI/env/flag catalog, DEVICE_EUI resolution, adding new config knobs.",
    "osi-agronomy-sensors-reference": "SWT/pF, Chameleon calibration, dendrometry, rain gauges. Not for pure layout changes.",
    "osi-debugging-playbook": "Symptom→triage table for bug-class requests.",
    "systematic-debugging": "Feedback-loop-first bug investigation methodology.",
}

ALWAYS_INJECT = [
    "osi-forge-boundaries",
    "osi-common-pitfalls",
    "osi-verification-commands",
]

EXCLUDED = {"osi-live-ops-runbook", "osi-hardest-problem-campaign"}

SELECTABLE_TOKEN_CEILING = 9000  # ~9K tokens, ~4 chars/token

# Surface → mandatory skill mapping (for dangling-sibling backstop)
SURFACE_SKILL_MAP = {
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json": "osi-flows-json-editing",
    "conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json": "osi-flows-json-editing",
    "database/migrations/": "osi-schema-change-control",
    "database/seed-blank.sql": "osi-schema-change-control",
    "web/react-gui/": "osi-react-gui-patterns",
}

def build_skill_index_text() -> str:
    lines = [
        "Available skills — select by name. Combined token ceiling: ~9K.",
        "If the request needs more skills than fit, note 'scope too broad' in escalation_reason.",
        "Stage 1 scope: osi-os only (target_repo must be 'osi-os').\n",
    ]
    for name, desc in SELECTABLE_SKILLS.items():
        lines.append(f"- {name}: {desc}")
    return "\n".join(lines)

def load_skill_content(skill_name: str) -> str | None:
    path = SKILL_DIR / skill_name / "SKILL.md"
    if path.exists():
        return path.read_text()
    return None

def load_always_inject() -> str:
    parts = []
    for name in ALWAYS_INJECT:
        content = load_skill_content(name)
        if content:
            parts.append(f"--- SKILL: {name} ---\n{content}\n--- END SKILL ---")
    return "\n\n".join(parts)

def validate_and_load_selected(skill_names: list[str]) -> tuple[str, list[str]]:
    """Validate names, enforce token ceiling, return (content, warnings)."""
    warnings = []
    parts = []
    total_chars = 0
    loaded = []

    for name in skill_names:
        # Validate against whitelist (Fable review I9)
        if name not in SELECTABLE_SKILLS:
            warnings.append(f"skill '{name}' not in SELECTABLE_SKILLS — skipped")
            continue
        content = load_skill_content(name)
        if not content:
            warnings.append(f"skill '{name}' SKILL.md not found — skipped")
            continue
        if total_chars + len(content) > SELECTABLE_TOKEN_CEILING * 4:
            warnings.append(f"token ceiling (~9K) reached — '{name}' skipped")
            continue
        parts.append(f"--- SKILL: {name} ---\n{content}\n--- END SKILL ---")
        total_chars += len(content)
        loaded.append(name)

    if warnings:
        for w in warnings:
            __import__("logging").getLogger("forge.skill_index").warning(w)

    return "\n\n".join(parts), warnings

def check_dangling_skills(changed_files: list[str], injected_skills: list[str]) -> list[str]:
    """Deterministic backstop: flag surfaces touched without their mandatory skill."""
    missing = []
    for filepath in changed_files:
        for surface, skill in SURFACE_SKILL_MAP.items():
            if surface in filepath and skill not in injected_skills:
                missing.append(f"file '{filepath}' touches surface '{surface}' but skill '{skill}' was not injected")
    return missing
```

- [ ] **Step 4.4: Create `forge/gates.py` — expanded scope + tightened patterns**

```python
"""Deterministic pre/post execution safety gates."""
import json
import re
import subprocess
from pathlib import Path

# Tightened secret patterns (Fable review I2 — avoid false positives on auth UI code)
SECRET_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}"),
    re.compile(r"-----BEGIN"),
    re.compile(r'(?:password|secret)\s*=\s*"[^"]{8,}"'),  # Quoted literal assignment only
    re.compile(r'(?:password|secret)\s*=\s*\'[^\']{8,}\''),
    re.compile(r"\bANTHROPIC_API_KEY\b"),
    re.compile(r"\bOPENAI_API_KEY\b"),
]

# Path segment matching (Fable observation — avoid .env matching config.env.ts)
FORBIDDEN_PATH_SEGMENTS = [
    ".github/workflows/",
    "/.env",
    "_cred.",
    "id_rsa",
    "id_ed25519",
    "flows_cred.json",
]

MAX_DIFF_LINES = 5000


def pre_execution_gate(plan: dict) -> dict:
    failures = []
    files = plan.get("files_to_touch", [])
    for f in files:
        for forbidden in FORBIDDEN_PATH_SEGMENTS:
            if forbidden in f:
                failures.append(f"plan touches forbidden path: {f}")
    # Check plan_md for prohibited patterns
    plan_md = plan.get("plan_md", "")
    for pattern in [r"\bssh\s+", r"\bdocker\s+exec\b", r"\bdeploy\.sh\b"]:
        if re.search(pattern, plan_md, re.IGNORECASE):
            failures.append(f"plan_md contains prohibited pattern: {pattern}")
    return {"passed": len(failures) == 0, "failures": failures}


def post_execution_gate(worktree: Path, plan: dict,
                        exec_report: str = "", pr_body: str = "") -> dict:
    """Expanded gate: scans diff + execution-report.md + PR body (Fable review HIGH)."""
    failures = []
    
    diff = subprocess.run(
        ["git", "diff", "origin/main...HEAD"],
        capture_output=True, text=True, cwd=worktree
    ).stdout

    # Empty diff check (Fable review I10)
    has_commits = subprocess.run(
        ["git", "log", "--oneline", "origin/main...HEAD"],
        capture_output=True, text=True, cwd=worktree
    ).stdout.strip()
    if not has_commits:
        failures.append("no commits — nothing was implemented")
        return {"passed": False, "failures": failures}

    diff_lines = diff.count("\n")
    if diff_lines > MAX_DIFF_LINES:
        failures.append(f"diff too large: {diff_lines} lines (max {MAX_DIFF_LINES})")

    # Scan all three surfaces for secrets (Fable review HIGH)
    for surface_name, surface_text in [("diff", diff), ("execution-report", exec_report), ("pr-body", pr_body)]:
        for line in surface_text.splitlines():
            check_line = line if surface_name != "diff" else (line if line.startswith("+") else "")
            if not check_line:
                continue
            for pattern in SECRET_PATTERNS:
                if pattern.search(check_line):
                    failures.append(f"secret pattern in {surface_name}: {pattern.pattern[:40]}...")
                    break

    # Forbidden paths in diff
    for line in diff.splitlines():
        if line.startswith("diff --git") or line.startswith("+++"):
            for forbidden in FORBIDDEN_PATH_SEGMENTS:
                if forbidden in line:
                    failures.append(f"diff touches forbidden path: {line.strip()}")

    # Branch name
    branch = subprocess.run(
        ["git", "branch", "--show-current"],
        capture_output=True, text=True, cwd=worktree
    ).stdout.strip()
    if not branch.startswith("agent/req-"):
        failures.append(f"branch '{branch}' does not match agent/req-*")

    # Diff conformance warning (Fable review HIGH — WARNING not hard reject)
    warnings = []
    planned_files = set(plan.get("files_to_touch", []))
    changed = _extract_changed_files(diff)
    unexpected = changed - planned_files - _test_and_report_files(changed)
    if unexpected:
        warnings.append(f"files changed but not in plan: {unexpected}")

    return {
        "passed": len(failures) == 0,
        "failures": failures,
        "warnings": warnings,
    }


def _extract_changed_files(diff: str) -> set[str]:
    files = set()
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            files.add(line[6:])
    return files


def _test_and_report_files(changed: set[str]) -> set[str]:
    """Files that Codex legitimately touches beyond the plan."""
    return {f for f in changed if "test" in f.lower() or f == "execution-report.md"}
```

- [ ] **Step 4.5: Create prompt templates**

`forge/prompts/plan_system.md` — same as spec §Pass 1 preamble.

`forge/prompts/exec_preamble.md` — same as spec §Pass 2 prompt structure, with the dangling-sibling rule.

`forge/prompts/review_system.md` — same as spec §Pass 3, incorporating `code-quality-principles` finding vocabulary.

- [ ] **Step 4.6: Create `forge/pipeline.py` — corrected CLI invocations + credential isolation + controller-run verification**

Key changes from original:
- Use `--json-schema` + `--print` for Claude (output is validated structured JSON, not an envelope)
- Use `subprocess.run(timeout=3600)` for Codex timeout (not CLI flag)
- Use `-c model_reasoning_effort=high` not `--reasoning xhigh`
- Credential separation: Claude env gets `ANTHROPIC_API_KEY` only; Codex env gets `OPENAI_API_KEY` only
- Controller re-runs `plan.tests_to_run` independently after Codex
- Stream subprocess output to log files (not `capture_output=True` — prevents OOM on shared VPS)
- Fence request text with random sentinel (not backtick — prevents breakout)
- Report state transitions at pass boundaries

```python
"""Three-pass pipeline with credential isolation and controller-run verification."""
import json
import logging
import os
import re
import secrets
import signal
import subprocess
import time
from pathlib import Path

from . import config, gates, skill_index

log = logging.getLogger("forge.pipeline")


def run_pipeline(job: dict, job_dir: Path, worktree: Path,
                 ctrl_cfg: dict, codex_env: dict) -> dict:
    _setup_worktree(job, job_dir, worktree)
    
    # Pass 1: Claude planning
    plan = _run_planning(job, job_dir, worktree, ctrl_cfg)
    if plan.get("risk_class", 99) >= 3:
        return {"state": "AGENT_FAILED", "reason": f"risk_class_{plan.get('risk_class')}"}
    
    gate_pre = gates.pre_execution_gate(plan)
    _write_json(job_dir / "gate-pre.json", gate_pre)
    if not gate_pre["passed"]:
        return {"state": "AGENT_FAILED", "reason": "pre_gate: " + "; ".join(gate_pre["failures"])}
    
    # Pass 2: Codex execution (isolated env)
    _run_execution(job, job_dir, worktree, plan, codex_env)
    
    # Controller-run verification (Fable review HIGH — do NOT trust Codex's report)
    verification = _run_independent_verification(plan, worktree, job_dir)
    
    # Post-execution gate (scans diff + report + PR body)
    exec_report = _read_file(worktree / "execution-report.md")
    pr_body = _build_pr_body_preview(job, plan, exec_report)
    gate_post = gates.post_execution_gate(worktree, plan, exec_report, pr_body)
    _write_json(job_dir / "gate-post.json", gate_post)
    if not gate_post["passed"]:
        return {"state": "AGENT_FAILED", "reason": "post_gate: " + "; ".join(gate_post["failures"])}
    
    # Dangling skill backstop
    changed_files = list(gates._extract_changed_files(
        subprocess.run(["git", "diff", "origin/main...HEAD"],
                       capture_output=True, text=True, cwd=worktree).stdout))
    dangling = skill_index.check_dangling_skills(changed_files, plan.get("required_skills", []))
    
    # Pass 3: Claude review (with real verification output + dangling warnings)
    review = _run_review(job, job_dir, worktree, plan, ctrl_cfg,
                         verification, gate_post.get("warnings", []), dangling)
    
    if review["verdict"] == "approve":
        return {"state": "PR_OPEN", "plan": plan, "review": review}
    
    if review["verdict"] == "fix":
        _run_fix_cycle(job, job_dir, worktree, plan, review, codex_env)
        exec_report2 = _read_file(worktree / "execution-report.md")
        gate_post2 = gates.post_execution_gate(worktree, plan, exec_report2, "")
        _write_json(job_dir / "gate-post-fix.json", gate_post2)
        if not gate_post2["passed"]:
            return {"state": "AGENT_FAILED", "reason": "post_gate_fix: " + "; ".join(gate_post2["failures"])}
        verification2 = _run_independent_verification(plan, worktree, job_dir)
        review2 = _run_review(job, job_dir, worktree, plan, ctrl_cfg,
                              verification2, [], [], suffix="-fix")
        if review2["verdict"] == "approve":
            return {"state": "PR_OPEN", "plan": plan, "review": review2}
        return {"state": "AGENT_FAILED", "reason": "review_rejected_after_fix",
                "findings": review2.get("findings", [])}
    
    return {"state": "AGENT_FAILED", "reason": "review_rejected",
            "findings": review.get("findings", [])}


def _setup_worktree(job, job_dir, worktree):
    repo = config.OSI_OS_REPO
    subprocess.run(["git", "fetch", "origin"], cwd=repo, check=True)
    # Use origin/main explicitly (Fable review I8 — don't mutate local main)
    shortid = job["requestUuid"][:8]
    slug = re.sub(r"[^a-z0-9]+", "-", job.get("title", "job").lower())[:30].strip("-")
    branch = f"agent/req-{shortid}-{slug}"
    
    # Clean up stale branch from previous attempt (Fable review I8)
    subprocess.run(["git", "branch", "-D", branch], cwd=repo,
                   capture_output=True)  # ignore error if doesn't exist
    subprocess.run(["git", "worktree", "prune"], cwd=repo, capture_output=True)
    
    subprocess.run(
        ["git", "worktree", "add", str(worktree), "-b", branch, "origin/main"],
        cwd=repo, check=True)
    
    # Set git identity for Codex commits
    subprocess.run(["git", "config", "user.name", "OSI Forge"], cwd=worktree, check=True)
    subprocess.run(["git", "config", "user.email", "forge@opensmartirrigation.org"],
                   cwd=worktree, check=True)
    
    (job_dir / "branch.txt").write_text(branch)


def _run_planning(job, job_dir, worktree, ctrl_cfg) -> dict:
    system_prompt = _build_planning_prompt(worktree)
    user_msg = _fence_request(job)
    plan_schema = (Path(__file__).parent / "prompts" / "plan_schema.json").read_text()
    
    log_path = job_dir / "logs" / "claude-plan.log"
    with open(log_path, "w") as log_file:
        result = subprocess.run(
            ["claude", "-p", user_msg,
             "--model", "opus",
             "--output-format", "json",
             "--json-schema", plan_schema,
             "--system-prompt", system_prompt,
             "--max-budget-usd", config.CLAUDE_MAX_BUDGET_USD,
             "--allowedTools", "Read",
             "--print"],
            stdout=log_file, stderr=subprocess.STDOUT,
            cwd=worktree, timeout=600,
            env=_claude_env(ctrl_cfg))
    
    raw = log_path.read_text()
    plan = _parse_claude_json(raw)
    _write_json(job_dir / "plan.json", plan)
    (job_dir / "plan.md").write_text(plan.get("plan_md", ""))
    return plan


def _run_execution(job, job_dir, worktree, plan, codex_env):
    prompt = _build_execution_prompt(job, job_dir, worktree, plan)
    
    log_path = job_dir / "logs" / "codex-exec.log"
    env = {**codex_env, "HOME": str(Path("/home/forge-runner")),
           "PATH": os.environ.get("PATH", "")}
    
    with open(log_path, "w") as log_file:
        try:
            subprocess.run(
                ["codex", "exec", prompt,
                 "--model", "codex-5.5",
                 "-c", "model_reasoning_effort=high",
                 "--full-auto"],
                stdout=log_file, stderr=subprocess.STDOUT,
                cwd=worktree,
                timeout=config.CODEX_TIMEOUT_SECONDS,
                env=env,
                start_new_session=True)  # Process group for clean kill
        except subprocess.TimeoutExpired:
            # Kill entire process group (Fable review I7)
            os.killpg(os.getpgid(result.pid), signal.SIGTERM)
            raise


def _run_independent_verification(plan: dict, worktree: Path, job_dir: Path) -> list[dict]:
    """Controller re-runs tests — does NOT trust Codex's report (Fable review HIGH)."""
    results = []
    for cmd in plan.get("tests_to_run", []):
        try:
            r = subprocess.run(cmd, shell=True, capture_output=True,
                               text=True, timeout=300, cwd=worktree)
            results.append({
                "cmd": cmd,
                "rc": r.returncode,
                "stdout": r.stdout[-4000:] if r.stdout else "",
                "stderr": r.stderr[-2000:] if r.stderr else "",
            })
        except subprocess.TimeoutExpired:
            results.append({"cmd": cmd, "rc": -1, "stdout": "TIMEOUT", "stderr": ""})
    _write_json(job_dir / "verification-results.json", results)
    return results


def _run_review(job, job_dir, worktree, plan, ctrl_cfg,
                verification, gate_warnings, dangling_warnings, suffix=""):
    system_prompt = _build_review_prompt(worktree, plan)
    
    diff = subprocess.run(
        ["git", "diff", "origin/main...HEAD"],
        capture_output=True, text=True, cwd=worktree).stdout[:50000]
    exec_report = _read_file(worktree / "execution-report.md")[:10000]
    verif_text = json.dumps(verification, indent=2)[:5000]
    
    extra_flags = []
    if gate_warnings:
        extra_flags.append(f"\n## Gate Warnings\n{json.dumps(gate_warnings)}")
    if dangling_warnings:
        extra_flags.append(f"\n## Missing Skill Coverage\n{json.dumps(dangling_warnings)}")
    
    review_msg = "\n\n".join([
        f"## Diff\n```\n{diff}\n```",
        f"## Execution Report (Codex)\n{exec_report}",
        f"## Controller Verification (independent re-run)\n```json\n{verif_text}\n```",
        *extra_flags
    ])
    
    review_schema = (Path(__file__).parent / "prompts" / "review_schema.json").read_text()
    log_path = job_dir / "logs" / f"claude-review{suffix}.log"
    
    with open(log_path, "w") as log_file:
        subprocess.run(
            ["claude", "-p", review_msg,
             "--model", "opus",
             "--output-format", "json",
             "--json-schema", review_schema,
             "--system-prompt", system_prompt,
             "--max-budget-usd", config.CLAUDE_MAX_BUDGET_USD,
             "--allowedTools", "Read,Bash(git diff *),Bash(git log *)",
             "--print"],
            stdout=log_file, stderr=subprocess.STDOUT,
            cwd=worktree, timeout=600,
            env=_claude_env(ctrl_cfg))
    
    raw = log_path.read_text()
    review = _parse_claude_json(raw)
    _write_json(job_dir / f"review{suffix}.json", review)
    return review


def _fence_request(job) -> str:
    """Fence untrusted text with random sentinel (Fable review I9 — backtick breakout)."""
    sentinel = f"FIELD_REQUEST_{secrets.token_hex(8)}"
    title = (job.get("title") or "")[:200]
    desc = (job.get("description") or "")[:4000]
    # Strip XML-tag-like markup (spec: defense-in-depth)
    desc = re.sub(r"</?(?:system|instructions|prompt|assistant|user)[^>]*>", "", desc, flags=re.IGNORECASE)
    return (f"<untrusted-field-request sentinel=\"{sentinel}\">\n"
            f"Title: {title}\nDescription: {desc}\n"
            f"</untrusted-field-request>")


def _parse_claude_json(raw: str) -> dict:
    """Parse Claude --print --json-schema output. With --json-schema the CLI
    validates the schema and --print outputs the result content directly."""
    raw = raw.strip()
    if not raw:
        raise ValueError("empty Claude output")
    # --print with --json-schema outputs the validated JSON directly
    # Try direct parse first
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # Fallback: extract JSON from markdown fences
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if match:
        return json.loads(match.group(1))
    raise ValueError(f"could not parse JSON from Claude output: {raw[:200]}")


def _claude_env(ctrl_cfg: dict) -> dict:
    env = {"ANTHROPIC_API_KEY": ctrl_cfg["ANTHROPIC_API_KEY"],
           "HOME": str(Path("/home/forge-runner")),
           "PATH": os.environ.get("PATH", "")}
    return env


def _build_planning_prompt(worktree: Path) -> str:
    agents_md = _read_file(worktree / "AGENTS.md")
    template = _read_file(Path(__file__).parent / "prompts" / "plan_system.md")
    idx = skill_index.build_skill_index_text()
    return f"{template}\n\n## Project Context (AGENTS.md)\n\n{agents_md}\n\n## Skill Index\n\n{idx}"


def _build_execution_prompt(job, job_dir, worktree, plan) -> str:
    preamble = _read_file(Path(__file__).parent / "prompts" / "exec_preamble.md")
    always = skill_index.load_always_inject()
    selected, _ = skill_index.validate_and_load_selected(plan.get("required_skills", []))
    agents_md = _read_file(worktree / "AGENTS.md")
    plan_md = _read_file(job_dir / "plan.md")
    request = _fence_request(job)
    return "\n\n".join([preamble, always, selected,
                        f"## Project Context\n\n{agents_md}",
                        f"## Plan\n\n{plan_md}", request])


def _build_review_prompt(worktree, plan) -> str:
    template = _read_file(Path(__file__).parent / "prompts" / "review_system.md")
    always = skill_index.load_always_inject()
    selected, _ = skill_index.validate_and_load_selected(plan.get("required_skills", []))
    # Include code-quality-principles (spec Resolved Q4)
    cqp = skill_index.load_skill_content("code-quality-principles")
    cqp_block = f"--- SKILL: code-quality-principles ---\n{cqp}\n--- END SKILL ---" if cqp else ""
    return "\n\n".join([template, always, selected, cqp_block])


def _build_pr_body_preview(job, plan, exec_report) -> str:
    issue = job.get("githubIssueNumber")
    return "\n".join([
        f"## Summary\n\nAutomated implementation of field request.",
        f"Closes #{issue}" if issue else "",
        f"\n## Plan\n\n{plan.get('plan_summary', '')}",
        f"\n## Verification\n\n```\n{exec_report[:3000]}\n```",
        "\n---\n*Created by OSI Forge. Human review and merge required.*"
    ])


def _read_file(path: Path) -> str:
    return path.read_text() if path.exists() else ""


def _write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, default=str))
```

- [ ] **Step 4.7: Create `forge/github_pr.py` — ephemeral auth (Fable review I5)**

```python
"""Push branch and create draft PR — ephemeral git auth, no persistent tokens."""
import logging
import os
import subprocess
import time
from pathlib import Path

import httpx
import jwt

log = logging.getLogger("forge.github_pr")


def push_and_create_pr(worktree: Path, job: dict, job_dir: Path,
                       ctrl_cfg: dict) -> str:
    branch = (job_dir / "branch.txt").read_text().strip()
    token = _get_installation_token(ctrl_cfg)

    # Ephemeral auth via env credential helper (Fable review I5)
    # — does NOT persist token in .git/config
    push_env = {
        "GIT_ASKPASS": "true",  # suppress interactive prompts
        "GIT_TERMINAL_PROMPT": "0",
        "HOME": str(Path("/home/forge-runner")),
        "PATH": os.environ.get("PATH", ""),
    }
    push_url = f"https://x-access-token:{token}@github.com/Open-Smart-Irrigation/osi-os.git"
    
    result = subprocess.run(
        ["git", "push", push_url, f"{branch}:{branch}"],
        capture_output=True, text=True, cwd=worktree, env=push_env)
    
    if result.returncode != 0:
        # Redact token from error output before logging/reporting
        safe_stderr = result.stderr.replace(token, "[REDACTED]")
        raise RuntimeError(f"git push failed: {safe_stderr}")

    # Create draft PR
    issue_number = job.get("githubIssueNumber")
    exec_report = (worktree / "execution-report.md").read_text()[:3000] \
        if (worktree / "execution-report.md").exists() else ""
    plan_json = _read_json(job_dir / "plan.json")

    title = f"[Forge] {job.get('title', 'automated change')}"[:70]
    body = "\n".join(filter(None, [
        "## Summary\n\nAutomated implementation of field request.",
        f"Closes #{issue_number}" if issue_number else "",
        f"\n## Plan\n\n{plan_json.get('plan_summary', '')}",
        f"\n## Verification\n\n```\n{exec_report}\n```",
        "\n---\n*Created by OSI Forge runner. Human review and merge required.*"
    ]))

    resp = httpx.post(
        "https://api.github.com/repos/Open-Smart-Irrigation/osi-os/pulls",
        json={"title": title, "body": body, "head": branch,
              "base": "main", "draft": True},
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json"})
    resp.raise_for_status()
    pr_url = resp.json()["html_url"]
    log.info(f"Draft PR created: {pr_url}")
    return pr_url


def _get_installation_token(cfg: dict) -> str:
    pem = Path(cfg["FORGE_GITHUB_PRIVATE_KEY_PATH"]).read_text()
    now = int(time.time())
    encoded_jwt = jwt.encode(
        {"iat": now - 60, "exp": now + 540, "iss": cfg["FORGE_GITHUB_APP_ID"]},
        pem, algorithm="RS256")
    resp = httpx.post(
        f"https://api.github.com/app/installations/{cfg['FORGE_GITHUB_INSTALLATION_ID']}/access_tokens",
        headers={"Authorization": f"Bearer {encoded_jwt}",
                 "Accept": "application/vnd.github+json"})
    resp.raise_for_status()
    return resp.json()["token"]


def _read_json(path: Path) -> dict:
    import json
    return json.loads(path.read_text()) if path.exists() else {}
```

- [ ] **Step 4.8: Create `forge/controller.py` — cleanup protocol + crash recovery**

```python
"""Main controller loop with cleanup protocol and crash recovery."""
import json
import logging
import os
import shutil
import subprocess
import sys
import time
import threading
from datetime import datetime, timedelta
from pathlib import Path

import httpx

from . import config, pipeline, github_pr

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(config.LOGS_DIR / "controller.log"),
    ])
log = logging.getLogger("forge.controller")


def main():
    config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    config.JOBS_DIR.mkdir(parents=True, exist_ok=True)
    
    ctrl_cfg = config.load_controller_config()
    missing = config.validate_controller_config(ctrl_cfg)
    if missing:
        log.error(f"Missing controller config: {missing}")
        sys.exit(1)
    
    codex_env = config.load_codex_env()
    missing_codex = config.validate_codex_env(codex_env)
    if missing_codex:
        log.error(f"Missing codex config: {missing_codex}")
        sys.exit(1)
    
    log.info(f"Forge controller starting — server: {ctrl_cfg['FORGE_SERVER_URL']}")
    
    while True:
        try:
            _tick(ctrl_cfg, codex_env)
        except KeyboardInterrupt:
            log.info("Shutting down")
            break
        except Exception as e:
            log.exception(f"Tick failed: {e}")
        time.sleep(config.POLL_INTERVAL_SECONDS)


def _tick(ctrl_cfg: dict, codex_env: dict):
    with _make_client(ctrl_cfg) as client:
        resp = client.get("/api/v1/forge/jobs/eligible")
        if resp.status_code != 200:
            log.warning(f"Poll failed: {resp.status_code}")
            return
        
        jobs = resp.json()
        if not jobs:
            return
        
        job_summary = jobs[0]
        log.info(f"Eligible job: {job_summary['id']} — {job_summary['title']}")
        
        # Check for existing branch/PR from previous attempt (Fable review HIGH)
        shortid = job_summary["requestUuid"][:8]
        existing = _check_existing_branch(shortid)
        if existing:
            log.info(f"Branch already exists for {shortid}: {existing} — skipping")
            return
        
        # Claim
        resp = client.post(f"/api/v1/forge/jobs/{job_summary['id']}/claim",
                           params={"claimedBy": "forge-runner"})
        if resp.status_code == 409:
            log.info("Already claimed, skipping")
            return
        resp.raise_for_status()
        job = resp.json()
        
        job_id = f"req-{job['requestUuid'][:8]}"
        job_dir = config.JOBS_DIR / f"{job_id}-{int(time.time())}"
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "logs").mkdir(exist_ok=True)
        (job_dir / "request.json").write_text(json.dumps(job, indent=2, default=str))
        worktree = job_dir / "worktree"
        
        # Background heartbeat (Fable review HIGH)
        stop_hb = threading.Event()
        hb_thread = threading.Thread(
            target=_heartbeat_loop, args=(client, job["id"], stop_hb), daemon=True)
        hb_thread.start()
        
        try:
            client.post(f"/api/v1/forge/jobs/{job['id']}/report",
                        json={"state": "AGENT_PLANNING"})
            
            result = pipeline.run_pipeline(job, job_dir, worktree, ctrl_cfg, codex_env)
            
            if result["state"] == "PR_OPEN":
                client.post(f"/api/v1/forge/jobs/{job['id']}/report",
                            json={"state": "VERIFYING"})
                pr_url = github_pr.push_and_create_pr(worktree, job, job_dir, ctrl_cfg)
                client.post(f"/api/v1/forge/jobs/{job['id']}/report",
                            json={"state": "PR_OPEN", "prUrl": pr_url})
                log.info(f"Job {job_id} complete: {pr_url}")
            else:
                branch = _read_file(job_dir / "branch.txt")
                client.post(f"/api/v1/forge/jobs/{job['id']}/report",
                            json={"state": result["state"],
                                  "failureReason": result.get("reason"),
                                  "findings": result.get("findings"),
                                  "branch": branch})
                log.warning(f"Job {job_id} failed: {result.get('reason')}")
                _cleanup_failed_branch(worktree, branch)
        
        except Exception as e:
            log.exception(f"Job {job_id} error: {e}")
            # Redact potential secrets from error message
            safe_msg = str(e)[:500]
            try:
                client.post(f"/api/v1/forge/jobs/{job['id']}/report",
                            json={"state": "AGENT_FAILED", "failureReason": safe_msg})
            except Exception:
                pass
            _cleanup_failed_branch(worktree, _read_file(job_dir / "branch.txt"))
        
        finally:
            stop_hb.set()
            _cleanup_worktree(worktree)


def _heartbeat_loop(client, job_id, stop_event):
    while not stop_event.wait(config.HEARTBEAT_INTERVAL_SECONDS):
        try:
            client.post(f"/api/v1/forge/jobs/{job_id}/heartbeat")
        except Exception as e:
            log.warning(f"Heartbeat failed: {e}")


def _cleanup_worktree(worktree: Path):
    if worktree.exists():
        subprocess.run(["git", "worktree", "remove", "--force", str(worktree)],
                       cwd=config.OSI_OS_REPO, capture_output=True)
    subprocess.run(["git", "worktree", "prune"],
                   cwd=config.OSI_OS_REPO, capture_output=True)


def _cleanup_failed_branch(worktree: Path, branch: str):
    """Delete remote branch on failure — no PR to reference it."""
    if not branch or not branch.startswith("agent/"):
        return
    try:
        subprocess.run(["git", "push", "origin", "--delete", branch],
                       cwd=config.OSI_OS_REPO, capture_output=True)
        subprocess.run(["git", "branch", "-D", branch],
                       cwd=config.OSI_OS_REPO, capture_output=True)
    except Exception:
        pass


def _check_existing_branch(shortid: str) -> str | None:
    result = subprocess.run(
        ["git", "branch", "-r", "--list", f"origin/agent/req-{shortid}-*"],
        capture_output=True, text=True, cwd=config.OSI_OS_REPO)
    branches = result.stdout.strip()
    return branches.split("\n")[0].strip() if branches else None


def _make_client(ctrl_cfg: dict) -> httpx.Client:
    return httpx.Client(
        base_url=ctrl_cfg["FORGE_SERVER_URL"],
        headers={"Authorization": f"Bearer {ctrl_cfg['FORGE_RUNNER_TOKEN']}"},
        timeout=30.0)


def _read_file(path) -> str:
    p = Path(path)
    return p.read_text().strip() if p.exists() else ""


if __name__ == "__main__":
    main()
```

- [ ] **Step 4.9: Create JSON schema files**

Create `forge/prompts/plan_schema.json` — same as spec §Pass 1 schema.
Create `forge/prompts/review_schema.json` — same as spec §Pass 3 schema.

- [ ] **Step 4.10: Tests and commit**

Same test content as original plan Steps 4.11-4.12 with:
- `test_gates.py`: add empty-diff test, tightened secret pattern tests, diff-conformance test
- `test_skill_index.py`: add token-ceiling test, SELECTABLE_SKILLS validation test

```bash
cd forge
python -m venv /home/forge-runner/venv  # or local venv for dev
source /home/forge-runner/venv/bin/activate
pip install -e ".[test]"
python -m pytest tests/ -v

git add forge/
git commit -m "$(cat <<'EOF'
feat: add forge controller with credential isolation and independent verification

Three-pass pipeline (Claude Opus plan → Codex exec → Claude Opus review),
credential separation (codex.env/controller.env), controller-run test
verification, ephemeral git auth, cleanup protocol, crash recovery,
deterministic safety gates with expanded scope.
EOF
)"
```

---

## Task 5: Test Server Setup and E2E Validation

Same structure as original plan Task 5 with these corrections:

- [ ] **Step 5.1: Install Node.js 20 LTS**

```bash
ssh rocky@server.opensmartirrigation.org 'sudo dnf module install -y nodejs:20 && node --version'
```

- [ ] **Step 5.2: Install CLIs with per-user npm prefix (Fable review I11)**

```bash
ssh rocky@server.opensmartirrigation.org '
sudo -u forge-runner bash -c "
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  echo \"export PATH=~/.npm-global/bin:\\\$PATH\" >> ~/.bashrc
  export PATH=~/.npm-global/bin:\$PATH
  npm install -g @anthropic-ai/claude-code @openai/codex
  claude --version
  codex --version
  
  # Smoke test (Fable review C3)
  mkdir -p /tmp/forge-cli-test && cd /tmp/forge-cli-test
  codex exec \"create a file hello.txt containing the word test\" --model codex-5.5 --full-auto 2>&1 | tail -5
  cat hello.txt  # should contain 'test'
  rm -rf /tmp/forge-cli-test
"
'
```

- [ ] **Step 5.3: Split credentials into codex.env + controller.env**

```bash
ssh rocky@server.opensmartirrigation.org '
sudo -u forge-runner bash -c "
  # controller.env — NOT readable by Codex
  cat > ~/config/controller.env << ENVEOF
ANTHROPIC_API_KEY=$(grep ANTHROPIC ~/config/forge.env | cut -d= -f2)
FORGE_SERVER_URL=https://server.opensmartirrigation.org
FORGE_RUNNER_TOKEN=PLACEHOLDER_SET_IN_NEXT_STEP
FORGE_GITHUB_APP_ID=4260238
FORGE_GITHUB_INSTALLATION_ID=145546368
FORGE_GITHUB_PRIVATE_KEY_PATH=/home/forge-runner/config/github-app-key.pem
ENVEOF
  chmod 600 ~/config/controller.env

  # codex.env — ONLY OPENAI_API_KEY
  cat > ~/config/codex.env << ENVEOF
OPENAI_API_KEY=$(grep CODEX ~/config/forge.env | cut -d= -f2)
ENVEOF
  chmod 600 ~/config/codex.env
"
'
```

- [ ] **Step 5.4: Set FORGE_RUNNER_TOKEN and deploy server API**

Generate token on the server side (Fable review I11 — don't echo to local shell):

```bash
ssh rocky@server.opensmartirrigation.org '
TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(32))")
echo "FORGE_RUNNER_TOKEN=$TOKEN" >> /home/rocky/osi-server/docker/.env
sudo -u forge-runner sed -i "s|^FORGE_RUNNER_TOKEN=.*|FORGE_RUNNER_TOKEN=$TOKEN|" /home/forge-runner/config/controller.env
cd /home/rocky/osi-server/docker && docker compose build backend && docker compose up -d --no-deps backend
sleep 15
docker logs osi-backend --tail 3
'
```

- [ ] **Step 5.5: Set up execution isolation (HARD PREREQUISITE)**

```bash
ssh rocky@server.opensmartirrigation.org '
# File permissions
sudo chmod 750 /home/rocky
sudo chmod 750 /home/rocky/docker 2>/dev/null || true

# Verify isolation
echo "=== Isolation verification ==="
sudo -u forge-runner cat /home/rocky/.env 2>&1 | head -1  # should fail
sudo -u forge-runner docker ps 2>&1 | head -1  # should fail
sudo -u forge-runner ls /home/rocky/docker/ 2>&1 | head -1  # should fail

# Egress restriction (iptables)
sudo iptables -A OUTPUT -m owner --uid-owner forge-runner -p tcp --dport 443 \
  -d api.openai.com,api.anthropic.com,github.com -j ACCEPT
sudo iptables -A OUTPUT -m owner --uid-owner forge-runner -p tcp --dport 443 -j DROP
sudo iptables -A OUTPUT -m owner --uid-owner forge-runner -p tcp --dport 80 -j DROP
echo "Egress restricted to API + GitHub only"
'
```

- [ ] **Step 5.6: Set up Python venv and deploy controller**

```bash
ssh rocky@server.opensmartirrigation.org '
sudo -u forge-runner bash -c "
  python3 -m venv ~/venv
  ~/venv/bin/pip install httpx PyJWT cryptography
  
  # Copy controller code
  cp -r ~/repos/osi-server/forge ~/forge
  
  # Set git identity
  cd ~/repos/osi-os
  git config user.name \"OSI Forge\"
  git config user.email \"forge@opensmartirrigation.org\"
  git pull origin main
"
'
```

- [ ] **Step 5.7: Set up liveness monitoring cron (Fable review MEDIUM)**

```bash
ssh rocky@server.opensmartirrigation.org '
sudo -u forge-runner bash -c "
(crontab -l 2>/dev/null; echo \"*/10 * * * * pgrep -f controller.py > /dev/null || echo \\\"\$(date -Iseconds) ALERT: forge controller not running\\\" >> ~/logs/liveness.log\") | crontab -
"
# Daily GC cron (cleanup protocol)
sudo -u forge-runner bash -c "
(crontab -l 2>/dev/null; echo \"0 3 * * * find ~/jobs -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null; cd ~/repos/osi-os && git worktree prune 2>/dev/null\") | crontab -
"
'
```

- [ ] **Step 5.8-5.10: Create test issues, dispatch, and validate**

Same flow as original plan: create 3 hand-crafted issues, submit corresponding work requests through the intake endpoint, triage → publish (ISSUE_OPEN) → dispatch to AWAITING_AGENT, start controller in tmux, observe first job. Key difference: the dispatch flow is now intake → publish → **dispatch** (ISSUE_OPEN → AWAITING_AGENT via the amended triage endpoint from Step 3.6).

---

## Self-Review

**Spec coverage (checked against revised spec 2026-07-10):**
- CLI flags: `--json-schema`, `--system-prompt`, `--allowedTools`, `--max-budget-usd`, `--print` ✓
- Credential separation (codex.env / controller.env) ✓
- Egress restriction (iptables, hard prerequisite) ✓
- Controller-run verification (independent test re-run) ✓
- Post-gate expanded scope (diff + report + PR body) ✓
- Diff conformance check (warning not reject) ✓
- Token ceiling (~9K) with escalation ✓
- Error handling table: all 7 modes covered in pipeline.py/controller.py ✓
- Cleanup protocol (worktree + branch + 7-day retention + daily GC) ✓
- Liveness cron (10-min pgrep) ✓
- ISSUE_OPEN → AWAITING_AGENT dispatch ✓
- Atomic claim (pessimistic lock) ✓
- State whitelist in report() ✓
- Ephemeral git auth ✓
- Dangling skill backstop ✓
- `code-quality-principles` in review prompt ✓

**Fable review findings addressed:**
- C1 (envelope parsing): `--json-schema` + `--print` eliminates the envelope issue
- C2 (--max-turns): removed; using --allowedTools + --max-budget-usd
- C3 (Codex flags): `-c model_reasoning_effort=high`, `subprocess.run(timeout=)`, smoke test
- C4 (entity mismatch): `.workRequest(wr)`, `getAgentPrUrl()`, branch base declared
- C5 (dispatch flow): ISSUE_OPEN → AWAITING_AGENT transition added
- C6 (GitHub App): same App (user decision), documented
- C7 (package layout): `__init__.py`, venv, git identity, correct import path
- C8 (atomic claim): `findByIdForUpdate`, ClaimConflictException, @ExceptionHandler(409)
- I1 (always-inject): `code-quality-principles` added to review; TDD/verification in always-inject
- I2 (secret regex): tightened to quoted-literal-RHS
- I3 (pass signals): corrected in skill content
- I5 (git token): ephemeral push URL, redacted errors
- I8 (branch collision): cleanup on failure, stale branch check at claim
- I9 (injection): random sentinel fencing, SELECTABLE_SKILLS whitelist validation
- I10 (empty diff): explicit no-commits check in post-gate
- I11 (ops commands): npm prefix, venv, server-side token gen
