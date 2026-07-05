# OSI Engineering Playbook

How to work on OSI OS and OSI Server without breaking farms. Written by the outgoing
senior engineer for whoever comes next — human or agent. AGENTS.md tells you *what*
the system is; this document tells you *how to think* while changing it.

Everything here was paid for. Each rule traces to a real incident or a bug caught in
review. When a rule seems pedantic, assume it once cost a day of debugging or a night
of Ugandan sensor data.

---

## 1. Prime directives

1. **Live farms outrank everything.** A wrong chart annoys someone; a wiped
   `farming.db` destroys months of irreplaceable field data. Every decision inherits
   this asymmetry. Never reseed a provisioned Pi. Fail closed: when a guard cannot
   prove an operation is safe, the operation must not run.
2. **Evidence before assertions.** "It works" means: you ran the command, you read
   the output, and the output is in your report. A test you didn't run is a test that
   fails. A pipeline exit code can lie (`git push | tail -1` returns tail's status —
   a push once "succeeded" this way while GitHub was unreachable).
3. **Missing data must look missing.** Never substitute a plausible default for an
   absent measurement. We shipped `-42 kPa` and `rootVwcPct ?? 24` fallbacks; both
   looked like real agronomy and misled operators. Propagate `null` end to end and
   render an explicit unavailable state. Corollary: a rain day with zero *samples* is
   "no data", not "0.0 mm dry" — the ingest writes real zeros when it is dry.
4. **One source of truth per fact.** Two definitions of the same schema, depth, or
   contract WILL drift (deploy.sh vs runtime DDL did; selector vs save-path did).
   When you find duplication, either unify it or add a verifier that fails on
   divergence — never leave silent duplicates.

## 2. The working loop

Every non-trivial change follows the same loop. Do not skip stages because a change
"looks small" — the smallest diffs of 2026-07 (a one-line cap check, a URL guard)
were the ones reviews caught real bugs in.

```
VERIFY REALITY → PLAN (written) → ADVERSARIAL REVIEW → EXECUTE (TDD, exact)
      → INDEPENDENT VERIFICATION → SHIP (PR + evidence) → RECORD
```

**Verify reality first.** Issues and docs go stale; code moves under you. Before
planning, prove the problem still exists on the current base: reproduce the failure,
grep for the claimed code, run the failing command. Recent examples: two issues were
already fixed on main (closed with evidence instead of re-fixed); an "add four
weather charts" issue was three-quarters shipped — the real gap was rain plus a
subtle aggregation bug nobody had reported.

**Plan in writing, with zero placeholders.** A plan an unfamiliar engineer cannot
execute verbatim is not a plan. Exact file paths, complete code in every step, exact
commands with expected output, and the commit sequence. "Add appropriate error
handling" is a planning failure. Plans live in `docs/superpowers/plans/` and get
committed with the work — they are the reviewable design record.

**Adversarial review before execution.** A second mind (a fresh agent or colleague,
never the author) reads the plan with the mandate *hunt for flaws*, verifying every
claim against the code. This stage has caught: an open-redirect bypass class the
author's tests masked, a plan that would have re-broken the panel-overlap bug it was
fixing, a classification that told a live farm to "assign a device" it already had,
and a heartbeat tee that would have collided with a parallel workstream. Review
output is a list of REQUIRED changes (apply all, then re-check) and OPTIONAL ones
(apply the cheap ones). "Looks good" is not a review.

**Execute exactly; stop on divergence.** The executor follows the amended plan
step-by-step, TDD order: write the failing test, *watch it fail for the stated
reason*, implement, watch it pass. If actual output differs from the plan's
Expected, STOP and report — do not improvise a different fix mid-execution. (Trivial
line-number drift is fine; find code by content.)

**Independent verification, never by the author.** Before any PR: a verifier who did
not write the code re-runs every gate fresh, diffs the branch hunk-by-hunk against
the plan, and adversarially probes the semantics (not just "tests pass" — "what
input breaks this?"). The dot-segment `/.//evil.example` redirect survived the
author, the executor, and the tests; only the independent probe found it. GREEN from
this stage is the ship criterion; RED means fix and re-verify the fix.

**Ship with the evidence in the PR body.** Root cause, the fix, the deliberate
tradeoffs, and the verification outputs. A reviewer six months from now must be able
to audit why without archaeology.

**Record.** Durable repo facts → AGENTS.md. Operational/cross-session context →
memory. Incidents → `docs/operations/`. If you learned it the hard way, write it
down where the next person will trip.

## 3. Thinking tools (use these before writing code)

- **Find the invariant, then enforce it.** The best fixes replace point-patches with
  a structural guarantee. "The probe selector must offer exactly what the save path
  accepts" turned three symptoms into one loop rebuilt around the shared resolver.
  If you can state the invariant in one sentence, you can usually test it in one.
- **Blast radius before edit.** Before touching a shared surface (`flows.json`
  heartbeat cluster, the frozen boot-DDL node, a record constructor, a pinned CSS
  grid), enumerate who else reads/writes it: `grep` the repo, check open plans and
  branches, check parallel workstreams. Prefer additive, self-contained designs
  (own inject + own node) over teeing into someone else's node — two plans then land
  in either order with at most adjacency conflicts.
- **Boundaries are exact complements.** When a read path says `expiresAt.isAfter(now)`,
  the eviction path must say `!expiresAt.isAfter(now)` — not `isBefore`. Off-by-one
  at boundaries is where cache and retention bugs live. Also hour-align time cutoffs:
  a mid-hour prune boundary silently degraded a re-aggregated rollup.
- **Validate with the parser that will consume the value.** String prefix checks on
  URLs are bypassable (WHATWG strips tab/LF/CR; dot-segments re-serialize to `//`).
  Parse with `new URL`, check the origin, then **re-check the serialized output** —
  and write bypass tests that assert on the *raw returned string*, because
  re-parsing in the test hides exactly the bug class you are hunting.
- **Concurrency: reason about the interleaving, not the happy path.** A cap checked
  before a `put` lets N concurrent misses all pass; enforce after the write. On
  ConcurrentHashMap, `entrySet().removeIf` is value-conditional and safe; `size()`
  is an estimate — design so slack is harmless.
- **When two subsystems disagree, find which one production trusts.** The upgrade
  test broke because it tested against `main`'s seed while production Pis upgrade
  from a *historical* schema — pin the baseline production actually has, not the
  moving target.

## 4. Avoiding issues in the first place

- **Schema changes:** ordered migrations only (`database/migrations/ordered/`,
  runner in `lib/osi-migrate`, risk class header). The boot-DDL node is FROZEN.
  Seed, bundled DBs, and runtime must stay in fingerprint parity — the verifiers
  exist because they have each caught a real drift.
- **Both Pi profiles, byte-identical.** Any payload edit under bcm2712 `files/`
  must be mirrored to bcm2709; `verify-profile-parity.js` enforces it.
- **`flows.json` is edited by script, never by hand.** One-shot Node editor in the
  scratchpad: parse → mutate → `JSON.stringify(flows, null, 2) + '\n'` → verify the
  no-op roundtrip is byte-identical first. Function nodes: bind guarded modules via
  `libs` + `global.get` locals, always `.close(` the DB handle (linted), wrap every
  sysfs/IO read in its own try/catch → null. A sampler must never crash the flow.
- **Guard tests pin contracts.** When a design decision matters (a node's wiring, a
  mobile grid, an auth block), write a static guard test that fails when someone
  changes it casually. When you *intend* the change, update the pin in the same
  commit with a message saying why.
- **Never assert success on text you didn't produce.** Check exit codes directly;
  in pipelines the last command wins. In fish, `$status`; in scripts, `set -eu` and
  explicit `ls-remote --exit-code`-style confirmation for remote effects.
- **Stacked PRs:** merge the base *without* deleting its branch (GitHub auto-CLOSES
  children on base-branch deletion and they cannot be reopened) → rebase the child
  `--onto origin/main <old-base-sha>` → force-push → retarget → merge child → then
  delete the base branch.
- **Isolation:** feature work in worktrees; never switch a checkout a human is
  actively using; never branch from a local main that carries someone's unpushed
  commits — branch from `origin/main`.
- **Copy the working precedent.** Auth blocks, prune jobs, monitor modals, test
  fixtures: this repo has a proven pattern for almost everything. Diff your new code
  against the precedent (`byte-identical auth section` is a review check, not a
  metaphor). Novelty in infrastructure code is a cost, not a virtue.

## 5. Security posture

- Auth boilerplate is copied verbatim from the newest shipped endpoint, then diffed
  to prove it. HMAC verify with `timingSafeEqual`, expiry checked.
- SQL: bound parameters only. User-influenced values (even a timezone offset) never
  reach a query string by interpolation — clamp, then bind.
- Redirect/URL inputs: same-origin proof via the URL constructor *plus* serialized
  re-check (§3). Assume every query param is hostile.
- Secrets never enter the repo, docs, or memory — AppKeys, sync tokens, production
  SSH. Production (`osicloud.ch`) access requires explicit user consent in the
  current conversation; a working key is not consent.
- Prefer reading sysfs to spawning subprocesses in long-running flows; prefer
  read-only DB access in observability paths.

## 6. When you are stuck or debugging

1. **Reproduce before theorizing.** Run the failing thing; capture exact output.
2. **Read the actual code, not your memory of it.** Line numbers move; claims rot.
3. **Bisect with history:** `git log -S "string"` finds when a behavior appeared;
   `git show <ref>:<path>` compares generations without switching branches.
4. **Test hypotheses empirically and cheaply:** a temp SQLite DB from the seed, a
   ten-line Node script in the scratchpad, one `curl`. Minutes, not arguments.
5. **Root cause, then fix.** A signal that pattern-matches a known failure may have
   a different cause (the "duplicate column" errors were blamed on the boot DDL in
   writing — the real cause was a stale test baseline; the misattribution itself had
   to be fixed later).
6. **Fix the class, not the instance,** and grep for siblings — the `-42 kPa`
   fallback had a `?? 24` sibling one line up. File issues for what you don't fix.
7. **If your fix fights the harness or the conventions, you misread the system.**
   Stop and re-read AGENTS.md and the nearest working precedent.

## 7. Orchestrating agents (and being one)

- **Separate the three roles.** Author, adversarial reviewer, and post-execution
  verifier must be different contexts. Authors are systematically blind to their own
  assumptions; every serious bug this quarter that reached review was caught by a
  non-author.
- **Capability-match the stage.** Design, review, and verification need the
  strongest available model; faithful execution of a zero-placeholder plan is
  exactly what a sonnet-class agent does well. A weaker executor with a stronger
  plan beats the reverse.
- **The plan is the contract.** Executors get fresh context and only the plan — if
  they need conversation history to succeed, the plan is incomplete. The
  stop-on-divergence rule is what makes delegation safe.
- **Verify agent reports.** Trust structure, not claims: clean tree, expected commit
  list, gates re-run by the verifier. Agents (and engineers) sincerely report
  successes that didn't happen — the report is a hypothesis, the repo is the truth.
- **Expect interruption.** Quota walls and network flaps killed agents mid-write
  this month. Design work to be resumable: plans on disk, commits early, state in
  the branch — then inspect leftovers before resuming (the half-executed worktree
  was completed inline by diffing it against its plan).

## 8. Definition of done

A change is done when: the issue's claim was re-verified against reality; the plan
and its review live in the repo; tests exist that fail without the change; every
gate is green *as re-run by a non-author*; both profiles/seeds are in parity where
applicable; the PR body carries root cause, tradeoffs, and evidence; stale docs and
memory touched by the change are corrected; and follow-ups you chose not to do are
filed as issues, not left as silences.

Anything less is work in progress wearing a green checkmark.
