# Field Journal Slice 2 — autonomous overnight implementation prompt

Paste the block below into the orchestrator (codex). It runs unattended and
should be woken only by completion or a recorded hard stop.

---

## MISSION

Implement **Field Journal Slice 2 in full** (Phase 0 through Phase 6) on the branch
`design-sync/agrolink`, working from the two committed plans, until every phase is
**green and merge-ready**. Run autonomously overnight: loop review → implement →
verify until done, do not idle, do not wait for human input on decisions the plans
already answer.

## INPUTS (authoritative, in priority order)

1. `docs/superpowers/plans/2026-07-15-field-journal-slice2-phase0-catalog-definitions.md` — Phase 0 (edge).
2. `docs/superpowers/plans/2026-07-15-field-journal-slice2-gui.md` — Phases 1–6 (GUI); its "Contract findings" and per-phase "Acceptance" are binding.
3. Reference only (do not re-derive): `docs/superpowers/specs/2026-07-12-field-journal-design.md` §6, the UX addendum, and `docs/design/agrolink-journal-ux.md`.

The plans are accepted. Do not rewrite them. If a step is factually wrong against
the current code, fix the code to satisfy the step's intent and log the deviation;
do not redesign.

## ROLES

- **Orchestrator (you):** own the loop. Sequence phases per DEPENDENCY ORDER, dispatch sol then luna, gather results, run the phase GATES yourself, and only advance a phase when its gate is green. Maintain a running decision log at `docs/superpowers/prompts/field-journal-slice2-codex/RUN-NOTES.md` (create it; append, never overwrite).

- **sol (reviewer) — blocker-only:** one short pre-flight per phase and one post-implementation check.
  - Pre-flight mandate: **flag only MAJOR blockers** — a plan step that references a function/column/shape that does not exist in the code, a missing prerequisite, or a step that cannot compile/build as written. Everything else: **ACCEPT and proceed.** No style notes, no nitpicks, no re-planning.
  - Two specific pre-flight checks sol must make before the phases that use them: (a) before Phase 0 Task 1, confirm `database/seed-blank.sql` actually seeds catalog rows (vocab/templates/layouts) so `loadScopedCatalog` returns non-empty; (b) before Phase 3, verify the plan's `CreateEntryPayload` against `saveEntry` in `osi-journal/api.js` and correct the payload type if the required fields differ.
  - Post-check mandate: confirm the phase's Acceptance criteria and GATES genuinely pass (re-run them; never take a worker's word). If a real defect, return it to luna with the specific failing assertion. If green, approve.

- **luna (implementers) — parallel:** execute tasks task-by-task exactly per the plan's TDD steps (write failing test → run, confirm fail → implement → run, confirm pass → commit). Each worker edits only its assigned task's files. Multiple luna run concurrently only on tasks the ORDER marks independent.

## DEPENDENCY ORDER

Two independent tracks converge at Phase 3.

- **Track A (edge):** Phase 0 (its 4 tasks are sequential).
- **Track B (GUI):** Phase 1 Tasks 1→2→3 (sequential), then `{Task 4 ∥ Task 5 ∥ Task 6}` in parallel, then Task 7. Phase 2 completes Track B.
- **Converge:** Phase 3 (requires Phase 0 landed + Track B). Then Phase 4. Then `{Phase 5 ∥ Phase 6}`.

Run Track A and Track B concurrently from the start. Phases 3–6 are specified at
file/interface/acceptance granularity in the GUI plan; when you reach each, first
have luna+sol produce a task-decomposed breakdown of that phase (same TDD shape as
Phases 1–2, code in every step) recorded under the plan, then implement it. Hold
each phase's forms to the spec Acceptance line verbatim.

## GATES — a phase is GREEN only when ALL of its gates pass

**Edge (Phase 0):**
- `node scripts/test-journal-api.js` passes (incl. the new definitions test).
- `node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js` and the bcm2709 twin both pass.
- `node scripts/verify-profile-parity.js` passes (the two `api.js` copies are byte-identical).
- The other field-journal script gates in `.github/workflows/field-journal.yml` pass (schema, lifecycle, command-path, sync-contract, bootstrap) as regression guards.

**GUI (Phases 1–6), run from `web/react-gui`:**
- `npx tsc --noEmit` clean.
- `npm run test:unit` green (both the tsx-runner and vitest halves).
- `npm run build` succeeds.
- Each phase's Acceptance criteria from the plan are demonstrably met by a test.

**MERGE-READY (loop exit):** every phase green; working tree has no uncommitted
changes; `RUN-NOTES.md` holds the decision log; a final `MERGE-READINESS.md`
summarizes commit range per phase, gate results, decisions taken, and any open
questions.

## CONSTRAINTS (hard)

- Branch `design-sync/agrolink` only. Frequent commits per the plans' commit steps. Do **not** force-push, rebase shared history, or delete branches.
- **Never hand-edit `flows.json`.** These phases do not require it. If a phase appears to need a `flows.json` change, HARD STOP and record it — it is out of scope.
- Any `conf/` edit is mirrored byte-identical to both profiles (`bcm2712` and `bcm2709`); run profile parity before committing.
- **No live-gateway work.** kaba100 runs pre-journal firmware; do not deploy, SSH a Pi, or hit a live `/api/journal/*`. Verify only via the mocked-response unit tests and the `osi-journal` `node:test` harness.
- Load the skills each plan names in Global Constraints before touching matching files (`osi-react-gui-patterns` for `web/react-gui`; the edge plan triggers no schema/flows skills). GUI i18n strings are `journal`-namespace keys with English values; do **not** add `journal.json` to the feed locale mirror before Phase 6. Glass stays chrome-only; red stays reserved for danger.
- The Phase 0 full-catalog wire shape (`labels`/`constraints`/`definition`/`composition`) must match the GUI's Phase 3 types.

## AUTONOMY RULES

- Do not stop for minor or ambiguous decisions. Follow the plan's stated default, make the smallest reasonable choice, append it to `RUN-NOTES.md`, and continue.
- **HARD STOP only for:** a sol-confirmed major blocker that invalidates a phase; a gate that stays red after **3** focused fix attempts on the same task; a step that would need `flows.json`/a schema migration/live-Pi; or any destructive/irreversible action. On a hard stop, record the blocker precisely and **keep working on other independent tracks/phases** — never idle.
- If `git push` fails (no SSH agent), leave commits local, note it in `RUN-NOTES.md`, and continue; the human pushes on wake.
- Never claim a phase green without having re-run its gates and seen them pass. Evidence before assertion.

## LOOP

```
for each phase in DEPENDENCY ORDER (tracks A and B concurrent):
    sol.preflight(phase)                       # blocker-only; accept otherwise
    if major_blocker: record; continue other independent work
    if phase in {3,4,5,6}: decompose phase into TDD tasks (record under plan)
    luna.implement(phase tasks)                # parallel where ORDER allows; TDD + commits
    run GATES(phase)
    sol.postcheck(phase)                       # re-run gates; approve or return defect
    if defect: luna.fix; repeat GATES (≤3 attempts, then hard stop this task)
until all phases GREEN
write MERGE-READINESS.md
```

Begin now. Wake me only on merge-ready or a recorded hard stop.
