# Codex Task: Field Journal Slice 1 — Tasks 2–14 (edge core)

## Orchestrator instructions

You are the orchestrator. You plan, dispatch, verify, and loop. Spawn a **cheap execution worker** for each task, and a **gpt-5.6-sol reviewer** after each task. You never accept a worker's claim unverified: after each worker completes, run the task's verification gates yourself, then dispatch the reviewer. If verification or review fails, diagnose, write a corrective worker prompt, re-dispatch, re-review. Loop until green.

**Workspace:** `/home/phil/Repos/osi-os/.claude/worktrees/feat+field-journal-slice1` — an existing git worktree on branch `feat/field-journal-slice1` (based on origin/main @ `69f7a9f2`). Work ONLY here. Do not touch the main checkout at `/home/phil/Repos/osi-os` (it is in use by other work), do not rebase, do not force-push, do not create a PR — stop when done and report.

**Plan of record:** `docs/superpowers/plans/2026-07-12-field-journal-slice1.md` — read it fully before dispatching anything. Each `### Task N:` section is a worker's complete requirement set; extract the full section text into each worker prompt (workers are cheap and must receive exact file paths, code, and commands — they discover nothing on their own).

**Spec of record:** `docs/superpowers/specs/2026-07-12-field-journal-design.md` (v2, post-review). Companions: UX addendum, Agroscope layout doc + `docs/superpowers/specs/agroscope-open-field/catalog.json`, and the consultant review at `docs/superpowers/prompts/field-journal-spec-review/report.md` (findings SYS-1/2/3, STD-1 etc. are referenced by the plan).

## State at handover (verify before starting)

- Commit `a28a6237`: all design docs (spec v2, plan, review artifacts, Agroscope catalog).
- Commit `f72c6e2b`: **Task 1 complete and reviewed clean** — migration `database/migrations/ordered/0018__field_journal.sql` (13 journal tables + indexes; authored as 0014, renumbered 2026-07-14), registered in CHECKSUMS.json, seed-blank.sql, all 7 bundled farming.db copies, and `scripts/verify-db-schema-consistency.js` schemaContract.
- Progress ledger: `.superpowers/sdd/progress.md` — append one line per completed task: `Task N: complete (commits <base7>..<head7>, review clean[, notes])`. Worker reports go to `.superpowers/sdd/task-N-report.md`.
- Baseline gates all green at `f72c6e2b`: `verify-migrations` (14), `verify-seed-replay`, `verify-profile-parity`, `verify-db-schema-consistency`, `verify-runtime-schema-parity`, `verify-no-stray-ddl`, `test-deploy-migration-wiring`, `test-flows-wiring`, `test-contract-schemas`.
- Known Minor deferred to final review: `journal_products` lacks `updated_at` (spec-inherited; do not fix unless the final review says so).
- **Numbering:** the plan was renumbered — field-journal DDL is `0014`, catalog data migration is `0015`. If any plan prose still says 0009/0010, the artifacts must say 0014/0015.

## Remaining tasks (execution order 2 → 14)

2. Catalog v1 — `scripts/journal-catalog-core.js` + `scripts/generate-journal-catalog.js` → generated `0019__journal_catalog_v1.sql` (authored as 0015, renumbered 2026-07-14); `scripts/test-journal-schema.js`
3. `osi-journal` module — catalog loader + entry validation (+ registration in osi-lib NAME_TO_PATH, srv package.json, deploy.sh — both profiles)
4. Units engine (quantity_kind/basis, entered→canonical)
5. Cascade engine (`option_dependencies`)
6. Canonical aggregate + hashing
7. Transaction lifecycle (draft/final/correction/void + `finalizeBatch` fan-out)
8. Context snapshot v1
9. Sync contract schemas + parity fixtures
10. REST routes in flows.json (one-shot script only)
11. Command apply path + **exact-replay dedupe fix** (touches shared command path)
12. Bootstrap capability + catalog advertisement + `fieldJournalUxEnabled` flag
13. Perf fixture (10k/150k) + pinned query plans
14. CI workflow + full-suite gate

One commit per task, message per the plan (`feat(journal): …`). Never amend a previous task's commit; correction commits are fine.

## Mandatory repo skills (read before the relevant tasks; distill into worker prompts)

- `.claude/skills/osi-schema-change-control/` — before Task 2 (0015 registration follows the same procedure as Task 1; check the Task-1 diff `git show f72c6e2b --stat` for the exact surfaces).
- `.claude/skills/osi-flows-json-editing/` — before Tasks 10–12. **IRON RULE:** `flows.json` is edited only by one-shot Node scripts with a JSON roundtrip guard, written to `scripts/`, applied to BOTH profiles (`conf/full_raspberrypi_bcm27xx_bcm2712/...` and `...bcm2709/...`), verified with `node scripts/verify-profile-parity.js`. Never hand-edit, never text-replace. Do not touch the frozen `sync-init-fn` node.

## High-risk review authority

Before dispatching a worker for these, read the relevant spec/plan sections yourself and verify the decision independently; after the worker returns, re-verify the substance — not just that tests pass:

1. **Catalog semantics (Task 2)** — this encodes review Blocker STD-1's fix. Every numeric attribute must carry a defensible `quantity_kind` + `basis` + allowed-unit family; unit rows need tested scale conversions; the Agroscope cascade in the layout's `option_dependencies` must reproduce `catalog.json` exactly (25 operations, 128 device slots, per-device unit sets, quirk handling per the layout doc §3: seed `cleaning_cut→mower`, dedupe `mower`, no-unit devices get no unit family). The generator must be deterministic (`--check` mode re-emits byte-identical output). Cross-check a sample of 10 device→unit mappings against `catalog.json` by hand.
2. **Transaction atomicity (Task 7)** — spec §5.2: version check, value replacement, context, outbox aggregate, and (for commands) ledger+ACK all inside ONE `BEGIN IMMEDIATE`. The crash-injection tests are the proof; read them and confirm they actually inject mid-transaction failures rather than mocking.
3. **Dedupe fix (Task 11)** — this modifies the SHARED pending-command dedupe used by all existing command types (review Blocker SYS-3). After the worker's change, run `node scripts/verify-sync-flow.js` and `node scripts/verify-command-safety.js` yourself and read the diff of the dedupe node change line by line.
4. **Sync contract names (Task 9)** — uppercase closed enums exactly as spec §5.3: commands `UPSERT_JOURNAL_ENTRY`, `VOID_JOURNAL_ENTRY`, `UPSERT_JOURNAL_CUSTOM_VOCAB`, `UPSERT_JOURNAL_PLOT`, `UPSERT_JOURNAL_PLOT_GROUP`; aggregates `JOURNAL_ENTRY`, `JOURNAL_VOCAB`, `JOURNAL_PLOT`, `JOURNAL_PLOT_GROUP`; ops `JOURNAL_ENTRY_UPSERTED`, `JOURNAL_ENTRY_VOIDED`, `JOURNAL_VOCAB_UPSERTED`, `JOURNAL_PLOT_UPSERTED`, `JOURNAL_PLOT_GROUP_UPSERTED`. The `device_eui` requirement becomes conditional (exempt `*_JOURNAL_*`), never dropped for device commands.
5. **Module registration pattern (Task 3)** — must mirror `osi-history-router` exactly: `NAME_TO_PATH` entry in `osi-lib/index.js` (both profiles), `"osi-journal": "file:/usr/share/node-red/osi-journal"` in `files/srv/node-red/package.json` (both profiles), deploy.sh helper section, byte-identical module files across profiles.

## Per-task loop protocol

1. Extract the full `### Task N` section from the plan into the worker prompt, plus: the worktree path, the interfaces produced by earlier tasks that this task consumes (copy the "Interfaces" blocks from the plan sections of its dependencies), the binding global constraints from the plan's Global Constraints section, and the report-file path `.superpowers/sdd/task-N-report.md`.
2. Dispatch the cheap worker. Workers must follow TDD as the plan's steps specify (failing test first, then implementation, then green run), self-review, and commit with the plan's exact message.
3. When the worker returns: run the task's verification-gate commands yourself (they are in each plan section). All must exit 0.
4. Generate a diff for the task (`git diff <base>..<head>` to a file) and dispatch the **gpt-5.6-sol reviewer** with: the task's plan section, the worker's report, the diff file, and the global constraints. The reviewer returns two verdicts: spec compliance (missing/extra/misunderstood) and code quality (Critical/Important/Minor). Reviewers do not re-run suites; they read the diff and cite file:line evidence.
5. Critical/Important findings → corrective worker dispatch → re-run gates → re-review. Minor findings → record in the ledger line for final-review triage.
6. Append the ledger line. Next task.

## Final gate (after Task 14)

1. Full suite, all must exit 0:
   `node scripts/verify-sync-flow.js` · `node scripts/verify-migrations.js` · `node scripts/verify-seed-replay.js` · `node scripts/verify-db-schema-consistency.js` · `node scripts/verify-runtime-schema-parity.js` · `node scripts/verify-profile-parity.js` · `node scripts/test-flows-wiring.js` · `node scripts/test-contract-schemas.js` · `node scripts/verify-sync-op-parity.js` · `node scripts/verify-command-safety.js` · `node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js` · `node scripts/test-journal-schema.js` · `node scripts/test-journal-lifecycle.js` · `node scripts/test-journal-perf-fixture.js`
2. Whole-branch review by a **gpt-5.6-sol** reviewer over `git diff 69f7a9f2..HEAD` (write it to a file first): spec compliance against the spec v2 Slice-1 scope + the deferred Minors in the ledger. Fix Criticals/Importants via one corrective worker with the complete findings list, re-run the full suite, re-review.
3. Stop. Final report: ledger contents, commit list (`git log --oneline 69f7a9f2..HEAD`), full-suite outputs summary, unresolved Minors with your triage recommendation. **Do not merge, do not push, do not open a PR** — Phil decides that.

## Rules

- Workers receive complete instructions; if a worker must "figure out" repo conventions, your prompt was too thin — fix the prompt, not the worker.
- Never weaken, skip, or reinterpret a verification gate. A failing gate is a diagnosis task, not an obstacle.
- Never edit shipped migrations (0001–0014 included, now that 0014 is committed); catalog changes after 0015 exists = new migration.
- All timestamps UTC `YYYY-MM-DDTHH:MM:SS.sssZ`. Hard limits per plan Global Constraints (request 256 KiB, note 4000 chars, ≤128 values, ≤32 groups, aggregate 256 KiB, batch ≤100 plots).
- If the plan and repo reality conflict (e.g. a script name moved), reconcile in favor of repo reality, note it in the ledger, and keep the plan's intent.
- If genuinely blocked (ambiguity no document resolves), stop and report the specific question rather than guessing.
