# Worker Prompt — Forge Controller Stage 1

You are implementing **Stage 1 of the OSI Forge pipeline** — the controller
that claims eligible work requests, runs a three-pass AI pipeline (Claude plan
→ Codex exec → Claude review), and opens draft PRs with test evidence.

## Repos

- **osi-os** (edge): `/home/phil/Repos/osi-os` — skills live here (Tasks 1-2)
- **osi-server** (cloud): `/home/phil/Repos/osi-server` — server API + controller code (Tasks 3-4)

Each repo gets its own feature branch and PR. Do not cross-commit.

## Read first (your requirements)

1. **Spec:** `docs/superpowers/specs/2026-07-10-forge-controller-stage1-design.md`
   — the revised design with credential separation, execution isolation, CLI
   flag verification, error handling, and cleanup protocol. **Read the whole
   thing before touching code.** The spec was revised after a Fable review that
   found 8 critical issues in the original plan — the revised plan addresses all
   of them.
2. **Plan:** `docs/superpowers/plans/2026-07-10-forge-controller-stage1.md` —
   5 tasks with exact code. Execute task-by-task using
   `superpowers:subagent-driven-development`.
3. **Skill audit:** `docs/superpowers/specs/2026-07-10-forge-skill-audit.md` —
   per-skill assessment, new skill outlines, and categorization (always-inject
   vs Claude-selects vs excluded). Use the outlines when writing new skills.
4. **Plan review:** `docs/superpowers/specs/2026-07-10-forge-controller-stage1-plan-review.md`
   — Fable review of the original plan. All critical/important findings are
   addressed in the revised plan, but read it to understand WHY each code
   pattern was chosen.
5. **AGENTS.md** in both repos. Architecture, sync model, file locations,
   conventions.
6. **Engineering playbook:** `docs/engineering-playbook.md` — the working loop.
   Every change follows VERIFY REALITY → PLAN → EXECUTE (TDD) → VERIFY.

## Execution method

Use `superpowers:subagent-driven-development` — dispatch a fresh subagent per
task, review between tasks. Each task should produce independently testable
output.

## Task overview and repo mapping

| Task | Repo | Branch | What |
|------|------|--------|------|
| 1 | osi-os | `feat/forge-skills-stage1` | 3 new always-inject skills + fix 3 existing skills |
| 2 | osi-os | same branch | 3 new Claude-selects skills |
| 3 | osi-server | `feat/forge-controller-stage1` **from `feat/field-to-pr-stage0-revised`** | Flyway migration, ForgeService, ForgeController, ForgeTokenFilter, ISSUE_OPEN→AWAITING_AGENT dispatch |
| 4 | osi-server | same branch | Python controller: config, pipeline, gates, skill_index, github_pr, prompts |
| 5 | test VPS | ops | Node.js, CLIs, credential split, egress restriction, venv, E2E validation |

**Critical: Task 3 branches from `feat/field-to-pr-stage0-revised`, NOT
`main`.** Stage 0 entities (`WorkRequest`, `WorkRequestEvent`, the
`work_requests` migration) exist only on that unmerged branch. Branching from
`main` means nothing in Task 3 compiles.

## Skills to load

Load these skills BEFORE touching the corresponding files:

- **`osi-schema-change-control`** — before writing Flyway migrations (Task 3)
- **`osi-flows-json-editing`** — if any task touches flows.json (unlikely but check)
- **`superpowers:writing-skills`** — before writing new SKILL.md files (Tasks 1-2)

## Non-negotiable invariants

1. **No production access.** Do not SSH to `osicloud.ch`. The test server is
   `server.opensmartirrigation.org`.

2. **Credential separation is mandatory.** The controller uses TWO config
   files:
   - `codex.env` — contains ONLY `OPENAI_API_KEY`. This is the ONLY env file
     the Codex subprocess sees.
   - `controller.env` — contains `ANTHROPIC_API_KEY`, `FORGE_RUNNER_TOKEN`,
     `GITHUB_APP_*`. NOT propagated to Codex.
   **Why:** Codex runs untrusted-influenced prompts. If it can read the
   GitHub App key, it can mint installation tokens with Contents+PR rights on
   both public repos.

3. **Controller re-runs tests.** After Codex finishes, the controller
   independently executes `plan.json.tests_to_run`. The review pass receives
   the controller's verification output, NOT Codex's self-reported evidence.

4. **Egress restriction is a hard prerequisite** for the first Codex run.
   `iptables -m owner --uid-owner forge-runner` restricts outbound to
   `api.openai.com`, `api.anthropic.com`, `github.com` (443 only).

5. **Atomic claim.** `ForgeService.claim()` uses `findByIdForUpdate`
   (pessimistic lock). `ClaimConflictException` → HTTP 409. The controller
   checks for 409 and skips.

6. **ISSUE_OPEN → AWAITING_AGENT dispatch.** Stage 0's state machine treats
   `ISSUE_OPEN` as terminal for triage. Task 3 Step 3.6 adds an explicit
   exception: when disposition is `AWAITING_AGENT` and current state is
   `ISSUE_OPEN`, allow the transition. This enables the spec's "issue first,
   then dispatch" flow.

7. **WorkRequestEvent uses `@ManyToOne workRequest`, NOT `workRequestId`.**
   Builder calls: `.workRequest(wr)`. This was a critical compile error in the
   original plan (Fable review C4).

8. **Ephemeral git auth.** Never persist the GitHub installation token in
   `.git/config`. Use `git push <url-with-token> <branch>` directly. Redact
   the token from any logged error output.

9. **Skills follow house style.** YAML frontmatter (`name`, `description`),
   verified claims with file paths, re-verification commands, common-mistakes
   section. New skills use the outlines from the skill audit.

10. **Verification pass signals must be correct.** The original plan had wrong
    pass signals (Fable review I3). Verified values:
    - `verify-sync-flow.js` → `Sync flow verification passed`
    - `verify-seed-replay.js` → `verify-seed-replay: OK`
    - `verify-migrations.js` → exit code 0 (no specific success string)
    - `verify-profile-parity.js` → `All parity checks passed.`

## CLI invocations (verified 2026-07-10)

These are the exact CLI flags. Do not guess — use these:

**Claude planning:**
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

**Codex execution:**
```bash
# Timeout is controller-side (subprocess.run(timeout=3600)), NOT a CLI flag
codex exec "$PROMPT" \
  --model codex-5.5 \
  -c model_reasoning_effort=high \
  --full-auto
```

**Claude review:**
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

**Do NOT use:** `--max-turns` (doesn't exist), `--reasoning xhigh` (use
`-c model_reasoning_effort=high`), `--timeout` on Codex (use Python
`subprocess.run(timeout=)`).

## Key design decisions (already made — do not re-decide)

1. **Skill selection:** Claude selects skills during planning (from an index of
   names + descriptions). Controller validates names against `SELECTABLE_SKILLS`
   whitelist, enforces ~9K token ceiling, loads SKILL.md files, and injects
   them verbatim into the Codex prompt. Claude review gets the same skills +
   `code-quality-principles`.

2. **Gates protect the push, not the merge.** Pre-gate: plan scope only.
   Post-gate: secrets, credential paths, diff size, branch name, plus content
   scans on diff + execution-report.md + PR body. Human reviewers handle
   quality.

3. **One bounded fix cycle.** Review returns `fix` → one Codex pass → re-review.
   If still not approved → `AGENT_FAILED`. No loops.

4. **Dangling skill backstop.** Post-hoc check: if a file surface was touched
   but its mandatory skill wasn't injected, flag it in the review input and
   PR body.

5. **`osi-live-ops-runbook` is EXCLUDED** from the forge skill index. It
   teaches SSH/deploy commands the post-gate scans for.

6. **`osi-server-backend-patterns` is created but EXCLUDED from Stage 1 index**
   (`target_repo` enum forbids `osi-server`). Ready for Stage 2.

## Definition of done — gates (ALL green before PR)

### osi-os (Tasks 1-2)

```bash
# Verify skills are well-formed
for skill in .claude/skills/*/SKILL.md; do
  head -4 "$skill"  # YAML frontmatter present
done
# Verify no broken internal references
grep -r "See \`osi-" .claude/skills/ | grep -v SKILL.md || true
```

### osi-server (Tasks 3-4)

```bash
# Server API tests
cd backend && ./gradlew test --tests 'org.osi.server.workrequest.ForgeServiceTest' \
  -x buildFrontend -x buildTerraIntelligenceFrontend

# Controller tests
cd forge && python -m pytest tests/ -v
```

### Test server (Task 5)

```bash
# Isolation verification (all must fail)
sudo -u forge-runner cat /home/rocky/.env         # → Permission denied
sudo -u forge-runner docker ps                     # → Permission denied
sudo -u forge-runner ls /home/rocky/docker/        # → Permission denied

# CLI verification
sudo -u forge-runner claude --version
sudo -u forge-runner codex --version

# Credential separation
sudo -u forge-runner cat ~/config/codex.env        # → OPENAI_API_KEY only
sudo -u forge-runner cat ~/config/controller.env   # → ANTHROPIC + FORGE + GITHUB

# E2E: at least one hand-crafted issue dispatched and draft PR created
```

## When stuck

- Re-read the spec section for the task you're on — the spec was revised
  extensively and contains rationale for every decision.
- The plan review (`forge-controller-stage1-plan-review.md`) explains WHY each
  pattern was chosen. If you're wondering "why not just X?", the review likely
  has the answer.
- If a CLI flag doesn't work, check `claude --help` or `codex --help` on the
  test server. The spec says "verify exact syntax at install time" — this is
  real, not aspirational.
- For Java compile errors: you're on `feat/field-to-pr-stage0-revised`, not
  `main`. If `WorkRequest`, `WorkRequestEvent`, or `WorkRequestRepository`
  don't exist, you're on the wrong branch.
- For Python import errors: the package is `forge/` with `__init__.py`. Run
  from the parent directory: `cd /path/to && python -m forge.controller`.

## Report

Open two PRs (osi-os skills + osi-server API/controller). In each PR:

```markdown
## Summary
- [what changed]

## Test plan
- [ ] All verification gates green (output below)
- [ ] Skills have correct YAML frontmatter and verified claims
- [ ] ForgeService.claim() uses pessimistic lock (findByIdForUpdate)
- [ ] ISSUE_OPEN → AWAITING_AGENT dispatch works
- [ ] Controller credential separation verified (codex.env / controller.env)
- [ ] Post-gate scans diff + execution-report.md + PR body
- [ ] Controller re-runs tests independently
- [ ] Ephemeral git auth (no token in .git/config)
- [ ] Egress restriction active (iptables)
- [ ] Codex CLI smoke test passes
- [ ] At least one hand-crafted issue dispatched and draft PR created

## Verification output
[paste exact output here]
```
