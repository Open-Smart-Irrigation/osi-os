# Forge Controller Stage 1 — Plan Review

**Date:** 2026-07-10
**Reviewer:** senior review pass (adversarial), claims verified against
`osi-os` working tree + `origin/main`, `osi-server` `main` +
`feat/field-to-pr-stage0-revised`, and the locally installed `claude` CLI.
**Plan:** `docs/superpowers/plans/2026-07-10-forge-controller-stage1.md`
**Spec:** `docs/superpowers/specs/2026-07-10-forge-controller-stage1-design.md`

---

## 1. Verdict: REVISE

The architecture is right (controller-owned orchestration, files-not-chat,
deterministic gates, one bounded fix cycle), the skill content in Tasks 1–2 is
mostly accurate (locale list, migration set, ratchet scripts all verified), and
the server API shape is close. But the plan as written cannot complete a single
job: the Claude CLI invocations use a flag that does not exist and parse the
wrong JSON layer (every job would fail with `risk_class_4`), the Codex
invocation uses a nonexistent flag and would run in a read-only sandbox, Task 3
does not compile against the actual Stage 0 entities (which live on an
**unmerged branch** the plan never names as a base), and the dispatch flow has
a state-machine hole: as Stage 0 is implemented, a work request can never be
in `AWAITING_AGENT` *and* have a published GitHub issue, so the spec's
"draft PR with issue link" is unreachable. There is also a direct contradiction
with a Stage 0 safety control (GitHub App private key on the runner). All are
fixable with bounded edits; none invalidate the design.

---

## 2. Critical findings (fix before implementation)

### C1. `claude -p --output-format json` returns a CLI envelope, not the model's JSON

`pipeline.py` (`_run_planning`, `_run_review`, plan lines ~1146–1206) does
`plan = json.loads(result.stdout)`. With `--output-format json` the CLI emits a
result envelope (`{"type":"result","subtype":"success","result":"<model
text>","total_cost_usd":...}`), not the model's JSON object. Consequence:
`plan.get("risk_class", 4)` → `4` → `run_pipeline` returns
`AGENT_FAILED / risk_class_4` for **every job, unconditionally**. Same bug
kills the review pass (`review["verdict"]` → `KeyError`).
Fix: parse the envelope, extract `.result`, then robustly extract the model's
JSON (strip markdown fences / leading prose — a bare "JSON only" instruction is
not reliable). Validate against the schema and fail with a distinct reason
(`plan_parse_error`) so this is diagnosable from `work_request_events`.

### C2. `--max-turns` does not exist in the installed Claude CLI

Verified: `claude --help` (current install, 59 flags) has `--system-prompt`,
`--output-format`, `--max-budget-usd` — **no `--max-turns`**. Both `claude -p`
invocations in `_run_planning`/`_run_review` will exit with an unknown-option
error before any model call; stdout is empty; `json.loads("")` raises; every
job fails. Additionally there is a design tension to resolve when removing the
flag: `plan_system.md` (Step 4.4) demands "plan_md must contain exact file
paths, complete code, and exact verification commands", but a single-turn
Claude with no tool use cannot read the repo — `files_to_touch` will be
hallucinated, and the pre-gate then scans hallucinated paths. Decide
explicitly: either allow the planning pass a bounded agentic exploration of the
worktree (read-only tools work in `-p` mode; use `--max-budget-usd` as the
bound), or drop the "exact paths / complete code" requirement and make Codex
responsible for path discovery.

### C3. `codex exec --reasoning xhigh` — wrong flags, and the default sandbox blocks the whole job

`codex exec` has no `--reasoning` flag (reasoning effort is a config override:
`-c model_reasoning_effort="xhigh"`); the invocation in `_run_execution`
(plan lines ~1171–1178) exits with an argument error. Even with the flag fixed,
`codex exec` defaults to a read-only sandbox with non-interactive approvals:
Codex could neither write files in the worktree, nor `git commit`, nor run
`npm`/`node` verifiers. You need explicit sandbox/approval flags (workspace
write + network enabled — a fresh worktree has **no `node_modules`**, so the
first `npm run test:unit` in `web/react-gui` requires a network install).
`codex` is not installed on any machine I can verify against — Step 5.2 must
add a smoke test (`codex exec "write hello.txt" …` in a scratch dir, confirm
the file appears) before the first real job, and the exact flag set must be
pinned in the plan, not discovered in production.

### C4. Task 3 does not compile against the real Stage 0 entities

Verified against `feat/field-to-pr-stage0-revised`:

- `WorkRequestEvent` has `private WorkRequest workRequest` (`@ManyToOne`) —
  there is **no `workRequestId` builder property**. `ForgeService.claim()` and
  `report()` (Steps 3.3) call `WorkRequestEvent.builder().workRequestId(wr.getId())`
  → compile error. Use `.workRequest(wr)`.
- Step 3.1's test `reportWithPrUrlTransitionsToPrOpen` asserts
  `wr.getGithubIssueUrl()` equals the PR URL, but Step 3.3's implementation
  sets `wr.setAgentPrUrl(...)`. The TDD cycle can never go green as written.
  (The implementation is right; fix the test to assert `getAgentPrUrl()` —
  do not store a PR URL in `github_issue_url`.)
- **Branch base:** the `workrequest` package and `work_requests` migrations do
  not exist on osi-server `main` (verified: `main` has no
  `backend/src/main/java/org/osi/server/workrequest/` and no work_request
  migration). Stage 0 lives on `feat/field-to-pr-stage0-revised`, unmerged.
  Task 3's `feat/forge-controller-stage1` must be declared as based on that
  branch (or gated on its merge); as written the plan's branch instruction
  produces a tree where nothing in Task 3 compiles.

### C5. The dispatch flow cannot produce a claimable job with a linked issue — spec §Admin dispatch has no plan task

Verified in `WorkRequestAdminService` (Stage 0 branch):

- `triage()` maps `request.targetRepo()` to `setGithubRepo(...)` — **nothing
  ever writes the new `target_repo` column** Step 3.2 adds, so
  `ForgeService.eligible()`'s `wr.getTargetRepo()` is always null (masked by
  the `"osi-os"` default — and duplicating `github_repo` violates pitfall #13
  in the very skill this plan ships).
- `TERMINAL_STATES` includes `ISSUE_OPEN`, and `triage()` calls
  `rejectTerminalTransition(...)`. So: publish first (issue exists, state
  `ISSUE_OPEN`) → **cannot** triage to `AWAITING_AGENT` (409). Triage to
  `AWAITING_AGENT` first → no GitHub issue exists → `job["githubIssueNumber"]`
  is null → the PR has no `Closes #N` and Stage 0's "issue first, always" rule
  is violated.
- Step 5.7 creates issues with `gh issue create` — those issues are never
  linked to any `work_requests` row; no step sets `github_issue_number`.

The spec's §Admin dispatch ("existing triage endpoint gains AWAITING_AGENT")
has **no corresponding plan task** and, per the above, a one-word disposition
addition is not sufficient. Required: a plan task amending
`WorkRequestAdminService` (allow `ISSUE_OPEN → AWAITING_AGENT` dispatch, or a
dedicated `/dispatch` admin endpoint), and a Task 5 procedure that goes
intake → triage → **publish** (real issue) → dispatch, dropping the unlinked
`gh issue create` step. Also fix Step 5.8's payload: `"targetRepo": "osi-os"`
lands in `github_repo`, which `WorkRequestGithubProperties.isAllowedRepo()`
compares against `Open-Smart-Irrigation/osi-os` — the short form would break
the publish path.

### C6. GitHub App private key on the runner contradicts a Stage 0 safety control

Stage 0 design (`2026-07-08-field-to-pr-design.md`, Safety Controls): "GitHub
App private key accessible only to the backend container … **not as a host env
var readable by forge-runner**." Task 4's `config.py` requires
`FORGE_GITHUB_PRIVATE_KEY_PATH` readable by forge-runner, and `github_pr.py`
mints installation tokens with it. If this is the *same* App the server uses
for issue publishing, the runner gains issue/PR/contents authority over both
repos and the Stage 0 isolation boundary is gone. Neither spec nor plan
acknowledges the contradiction. Fix: provision a **second** GitHub App (or
fine-grained token) scoped to `osi-os`, Contents + Pull Requests only, for the
runner — and record the decision in the spec.

### C7. Task 5 deployment layout breaks Python imports

Step 5.5 copies `osi-server/forge` → `/home/forge-runner/controller`, then
Step 5.9 runs `cd ~/controller && python -m forge.controller`. There is no
`forge` package inside `~/controller` — the package *contents* are
`~/controller`. `python -m forge.controller` fails (`No module named forge`),
and `python -m pytest tests/` fails on `from forge.gates import …`. Fix: copy
to `/home/forge-runner/forge` and run `cd /home/forge-runner && python -m
forge.controller`; add `forge/__init__.py` and `forge/tests/__init__.py`
(Step 4.13's `pip install -e ".[test]"` also references a `pyproject.toml`
that no step creates). Also: `logging.FileHandler("/home/forge-runner/logs/controller.log")`
crashes at import if `~/logs` doesn't exist — no step creates it, and the
Stage 0 plan contains **no forge-runner provisioning at all** (verified: zero
`forge` references in `2026-07-08-field-to-pr-stage0.md`). Task 5 needs a
step 5.0 that verifies/creates: user, `~/repos/osi-os` clone, git
identity (user.name/email — Codex commits fail without it), `~/jobs`, `~/logs`,
`~/config/forge.env` with exactly the key names `config.py` requires
(Step 5.3's `sed -i 's|^FORGE_SERVER_ADMIN_TOKEN=…'` silently no-ops if the
line doesn't exist → every API call 401s).

### C8. Claim is not atomic and error statuses don't match the contract

`ForgeService.claim()` uses `findById` — the repository already provides
`findByIdForUpdate` (`@Lock(PESSIMISTIC_WRITE)`, used by the Stage 0 publish
reservation exactly for this reason); use it. And no exception mapping exists:
`IllegalStateException` from a lost claim race surfaces as HTTP **500**, not
the spec'd **409** — `controller._tick` checks `resp.status_code == 409`, so
the "already claimed" branch is dead code. Add an `@ExceptionHandler` (409 for
`IllegalStateException`, 404 for not-found) on `ForgeController`.

---

## 3. Important findings (fix before first real job; won't block coding)

### I1. Skill injection set diverges from the spec and audit

- Spec's always-inject table has 5 rows; `skill_index.py ALWAYS_INJECT` has 3.
  `verification-before-completion` (audit: "highest value-per-token in the
  entire library", always-inject for **both** Codex and review) and the TDD
  forge variant are missing — and cannot load anyway, because
  `load_skill_content` reads only `/home/forge-runner/repos/osi-os/.claude/skills/`
  where superpowers skills don't exist. `code-quality-principles` is likewise
  absent from `_build_review_prompt` despite spec Resolved Question 4 and
  audit §5. `systematic-debugging` is in the spec's Claude-selects table but
  not in `SELECTABLE_SKILLS`. Either commit forge-adapted copies into
  `osi-os/.claude/skills/` (recommended — keeps the single load path) or amend
  the spec to defer them explicitly. Right now the plan silently ships a
  weaker prompt than the one the spec costed (~6.7K always-inject baseline).
- The review-checklist question stands: the parallel Fable
  `code-quality-principles` review is a **resolved decision** in the spec
  (Resolved Q4) but "enhancement after MVP" in the plan's self-review. Same
  for Fable escalation (`escalation_needed` is emitted but never dispatched).
  Pick one: implement, or move both to the spec's open/Stage-2 section so the
  documents agree.

### I2. Post-gate secret patterns will false-positive on ordinary auth-adjacent code

`(?:password|secret|token)\s*[=:]\s*\S{8,}` (IGNORECASE) matches
`password: values.password`, `token: localStorage.getItem(...)`, test fixtures
(`password=testpass123`) — i.e., any change near the GUI Login page or auth
context gate-fails. The spec's own table asks only for `password=` / `secret=`
literal-assignment forms. Tighten to literal-RHS (quoted string ≥8 chars not
containing `(`/`.`), and expect to allowlist. `\b[0-9A-Fa-f]{32}\b` will also
hit undashed UUIDs and content hashes. FP gate failures are `AGENT_FAILED` with
no retry — each one costs a full job.

### I3. `osi-verification-commands` teaches wrong pass signals (verified against scripts)

- `verify-sync-flow.js` ends **"Sync flow verification passed"** — the plan
  says "Ends `All parity checks passed.`" (that string belongs to
  `verify-profile-parity.js`).
- `verify-seed-replay.js` prints **"verify-seed-replay: OK"**, not "Seed
  replay matches."
- `verify-migrations.js` never prints "All migrations valid." (its failure
  form is `verify-migrations: FAIL — …`; document the actual success line).
- Missing rows the audit specified: `verify-s2120-codec.js`,
  `verify-codec-robustness.js` (decoders), and the rebuild-fence pair
  (`verify-devices-rebuild-fence.js` + `rehearse-devices-rebuild.test.js`)
  for `sync-init-fn`/devices-CHECK touches.
A skill whose stated pass signal never appears trains Codex to report
"verification failed" on green runs — or worse, to stop trusting pass signals.

### I4. `osi-forge-boundaries` promises enforcement and tooling that don't exist in Stage 1

Step 1.1's skill lists `sudo -u deploy-svc forge-deploy-server-test <job-id>`
etc. as available. No plan task creates the wrappers, the sudoers rules, or
`deploy-svc` (spec scope line: wrappers are Stage 2; Stage 0 plan provisioned
none of it). Codex following the skill's "Deployment awareness" table will
attempt `sudo` and fail (`sudo: a password is required` — no NOPASSWD rule).
The skill also claims outbound-HTTP/MQTT, `env.get()` probing, and raw-IP
checks "trigger mechanical gate rejection" — `gates.py` implements **none** of
those (the Stage 1 spec deliberately narrowed the gate). Skills must describe
the world as it is: mark the wrappers "Stage 2 — not yet available; treat
runtime verification as stop-and-report", and split prohibitions into
"mechanically rejected" (the 4 real checks) vs "policy — human review".

### I5. GitHub token exposure paths in `github_pr.py`

- `git remote add forge-push https://x-access-token:<TOKEN>@github.com/…`
  persists the installation token in the **shared repo's** `.git/config`
  (remotes are repo-wide, shared by every worktree) and it stays there after
  the job. Prefer ephemeral auth: `git -c http.extraHeader="Authorization:
  Bearer <token>" push origin <branch>` or a credential-helper env, and never
  write the token to on-disk config.
- `git push` failure output is uncaptured; git prints the full credentialed
  URL in "unable to access" errors → token lands in the tmux scrollback.
  Capture stderr and redact before logging. The controller's generic handler
  then posts `str(e)` as `failureReason` to the server — audit rows must never
  receive raw subprocess error text without redaction.
- Positive note (checklist item): the installation token is minted fresh per
  push, not cached — correct, given 1 h expiry.

### I6. Crash recovery and the reclaim deferral

Controller crash / kill -9 mid-job leaves the request in `AGENT_PLANNING` with
no heartbeat consumer — the deferred server-side reclaim means nothing
auto-recovers, and `eligible` only lists `AWAITING_AGENT`, so the job is
invisible to the runner forever. Mitigating fact (verified):
`AGENT_PLANNING` is **not** in `WorkRequestAdminService.TERMINAL_STATES`, so an
admin re-triage back to `AWAITING_AGENT` works today. The deferral is
acceptable for Stage 1 **only if** `forge/README.md` documents this manual
reset and the heartbeat endpoint's current behavior (always 200, never 409 —
it is write-only decoration until reclaim exists; `_heartbeat_loop` ignores
status codes anyway). Also handle restart leftovers: a crashed job leaves
`jobs/<id>/worktree` registered and the `agent/req-…` branch created →
see I8.

### I7. Subprocess output buffering can OOM the shared VPS; timeouts orphan children

All three passes use `capture_output=True`, which buffers the entire
Claude/Codex stdout **in controller RAM** before writing the log. A runaway
Codex (the exact "massive output" scenario the spec's diff-size gate exists
for) OOMs a 4 GB shared host that also runs the OSI test stack. Stream
directly to the log file (`stdout=open(job_dir/"logs"/...)`), enforce a size
cap (truncate + fail the job past ~50 MB). `subprocess.run(timeout=…)` kills
only the direct child — Codex's spawned processes (node, gradle) survive; use
`start_new_session=True` + `os.killpg` on timeout. Note the per-pass timeout
(7200 s each) allows ~4×2 h worst case vs the spec's 2 h job budget, and
`MAX_TOKENS_PER_JOB = 200_000` is defined and never referenced — the spec's
Resolved Q2 budget is unenforced.

### I8. Branch and job-dir collisions on re-dispatch

`_setup_worktree` creates `agent/req-<shortid>-<slug>`; the `finally` cleanup
removes the worktree but **never deletes the branch**. Re-dispatch of the same
request (the standard recovery path after any of the failures above) →
`git worktree add -b <branch>` fails (branch exists) → `check=True` raises →
`AGENT_FAILED` again, forever. Also `job_dir` is reused (`mkdir(exist_ok=True)`)
so stale `plan.json`/`review.json` from the failed attempt sit next to new
artifacts. Fix: per-attempt suffix on job_dir, and `git branch -D` +
`git worktree prune` before `worktree add`. While here: `git pull --ff-only
origin main` mutates whatever branch the shared repo has checked out — pin the
gate's diff base and the worktree base to `origin/main` explicitly instead of
local `main`.

### I9. Prompt-injection hardening has two open holes

- `_fence_request` wraps untrusted text in ``` fences; a description containing
  ``` breaks out of the fence in the planning, execution, **and** review
  prompts. Strip/escape backtick runs or use a long random sentinel per job.
- `plan["required_skills"]` — a value influenced by the untrusted request via
  the planning pass — is used directly as a path component in
  `load_skill_content` (`SKILL_DIR / skill_name / "SKILL.md"`). Constrain to
  `name in SELECTABLE_SKILLS` membership (not just `not in EXCLUDED`) before
  touching the filesystem. Bonus: this also implements the spec's "controller
  takes the first 3 **and logs a warning**" — the current code truncates
  silently.

### I10. State reporting and report-endpoint hygiene

- An **empty diff passes the post-gate** (no failures, branch name matches) →
  review sees nothing → if it approves, PR creation 422s ("no commits").
  Add an explicit `no_commits` gate failure.
- The server shows `AGENT_PLANNING` for the entire job: `AGENT_IMPLEMENTING`
  is never reported, and `VERIFYING` is posted *after* review approval (spec
  orders it as implementation-done). Report transitions at the pass
  boundaries.
- `ForgeService.report()` accepts **any** state string and any transition, and
  doesn't check `claimedBy`. Whitelist
  `{AGENT_IMPLEMENTING, VERIFYING, PR_OPEN, AGENT_FAILED}` and validate the
  from-state; the bearer token protects the route, but a controller bug can
  currently write `MERGED`.
- Forge transitions never call `WorkRequestStatusNotifier` (triage/reject do)
  — the edge never learns `PR_OPEN`. Fine to defer, but note it.
- If PR creation fails after a successful push (GitHub 5xx — the checklist
  scenario), the job goes `AGENT_FAILED` with a live pushed branch and no
  record of the branch name in the report. Include `branch` in the report
  payload so recovery is possible without grepping runner disk.

### I11. Task 5 ops commands will not run as written

- Paths: Steps 5.3–5.5 use `/home/rocky/osi-server/…`; the recorded checkout
  layout (project memory, deploy history) is `/home/rocky/docker/osi-server`
  (symlink). Verify on the test host before scripting; a wrong `.env` path
  means the backend silently keeps `FORGE_RUNNER_TOKEN` unset → filter
  fail-closes → every forge call 401s with no obvious cause.
- Step 5.2 `sudo -u forge-runner npm install -g …` → EACCES on the system npm
  prefix. Set a per-user prefix (`npm config set prefix ~/.npm-global` + PATH)
  or use nvm as the spec suggests.
- Step 5.5 `pip install --user` on Rocky 9 / Python 3.12 will likely hit PEP
  668 (externally-managed environment). Use a venv
  (`python3 -m venv ~/venv && ~/venv/bin/pip install …`) and run the
  controller from it.
- Step 5.3 prints the token (`echo "Token: $TOKEN"`) and embeds it in ssh
  command lines (visible in `ps` on both hosts, plus local shell history).
  Generate on the server side, or pass via stdin.
- Step 5.4 restarts the backend before the forge-endpoints image exists
  (5.3 restart) — harmless but pointless; fold 5.3's restart into 5.4.

### I12. Eligible-list doesn't pin the repo

Stage 1 is osi-os-only, but `eligible()` returns any `AWAITING_AGENT` class
0–2 row. A request triaged toward osi-server would be claimed and implemented
**in the osi-os worktree** (pipeline ignores `targetRepo` after claim). Filter
server-side (`github_repo` ∈ {null, osi-os forms}) or skip client-side before
claiming.

---

## 4. Observations (non-blocking)

- `target_repo` column duplicates the existing `github_repo` (see C5) —
  pitfall #13 ("one source of truth per fact") from the plan's own
  `osi-common-pitfalls`. Drop the column and normalize `github_repo`.
- `controller.py` has `import subprocess` at the bottom of the module; the
  per-tick `httpx.Client` is never closed (socket leak over days);
  `config.load_config` only lets env vars override keys already present in
  `forge.env` — a key supplied *only* via environment is ignored.
- Gate/diff cap mismatch: the gate allows 5000 diff lines but `_run_review`
  truncates the diff at 50 000 **characters** (~700–1000 lines) — the reviewer
  can approve code it never saw. Align the caps or chunk the diff. The
  diff-size gate also counts *all* diff lines (context + headers), not "lines
  changed" as the spec says — it fires ~40% early. Conservative, but document
  it.
- `FORBIDDEN_PATHS` substring matching: `.env` also matches `config.env.ts`,
  `_cred` matches `_credits.scss`. Low frequency; will surface as confusing
  gate failures. Anchor on path segments.
- The review pass is single-shot with no tool access: it cannot re-run tests
  or gates, only read `execution-report.md` — the audit's instruction that the
  review "must re-run gates, not trust the report" is structurally
  unsatisfiable here. At minimum, feed `gate-post.json` and the verifier exit
  codes (captured by the controller, not by Codex) into the review prompt.
- `ClaimResult` omits `diagnostics` though the spec's claim contract lists it
  (pipeline doesn't use it either — fine, but make the spec and record agree).
- `_run_fix_cycle` re-sends the full original prompt + fix instructions to a
  fresh Codex with no memory of its own change; workable, but include the
  current diff so it doesn't re-derive state from disk alone. Guard against
  `fix_instructions: null` (writes empty file today).
- Step 1.7's "verify skills are well-formed" is `head -4` — it checks nothing.
  A 5-line Node script validating frontmatter (`name`, `description`) across
  `.claude/skills/*/SKILL.md` would be a real check and reusable in CI.
- Step 1.5's dynamic-inventory rewrite is the right call — verified that
  `origin/main` already has `0005__field_work_requests.sql` and `0006` (the
  audit's "0001–0004" snapshot is already stale two days later, proving the
  point).
- Positive: gate unit tests (Step 4.11) are behavior-focused and will pass as
  written; skill-index tests match the module; the Flyway version
  `V2026_07_10_001` correctly sorts after Stage 0's `V2026_07_09_002`;
  `docker logs osi-backend` matches the real container name.

---

## 5. Spec coverage gaps (spec requirement → no plan task)

| Spec section | Status in plan |
|---|---|
| §Admin dispatch (triage gains `AWAITING_AGENT`, dispatch of *published* requests) | **No task.** And the Stage 0 implementation makes the naive version impossible (C5). |
| §Skill Framework always-inject: `verification-before-completion`, TDD forge variant | No task creates or injects them; loader can't reach them (I1). |
| §Skill Framework Claude-selects: `systematic-debugging` forge variant | Absent from `SELECTABLE_SKILLS`; no adaptation task (I1). Acceptable to defer for the first hand-crafted (non-bug) issues *if* the spec table is annotated — bug-class requests must not be dispatched until it lands. |
| §Fable Escalation (`escalation_needed` dispatch) | Flag emitted, never consumed. Plan self-review defers; spec presents it as part of the design. Reconcile. |
| Resolved Q4: parallel Fable `code-quality-principles` review + injection into Codex prompts | Neither implemented nor injected (I1). Spec calls it resolved; plan calls it post-MVP. Reconcile — cheapest compliant slice: inject the static skill into exec+review prompts now, defer only the parallel Fable enhancement. |
| Resolved Q2: 200K token budget per job | Constant defined, never enforced; no cost accounting from CLI envelopes (which carry `total_cost_usd` — free to capture once C1 is fixed). |
| §State transitions: timeout reclaim (30 min) | Deferred as follow-up. Safe for Stage 1 **conditionally**: single runner, manual re-triage path verified to exist, must be documented in README (I6). Not safe to carry into Stage 3 auto-dispatch. |
| Skill index line "Tags: static / test-env / live-only" for `osi-debugging-playbook` | No task adds the tags to the skill (audit §2.4, priority 9). The index promises tags the skill body doesn't have. |
| §Monitoring: `/var/log/forge-wrappers.log` | No wrappers exist in Stage 1 (I4); drop from Stage 1 monitoring or mark Stage 2. |

---

## 6. Suggested revision order

1. C4 + C5 + C8 (server task compiles, dispatch flow reachable, claim atomic)
2. C1 + C2 + C3 (CLI contract — prototype one end-to-end `claude -p` /
   `codex exec` round trip on the runner before writing more pipeline code)
3. C6 (runner-scoped GitHub credential — decision needed from maintainer)
4. C7 + I11 (deployment mechanics)
5. I1–I5, I8–I10 (prompt/gate/skill correctness)
6. Reconcile spec ↔ plan on Fable items and always-inject set (§5)
