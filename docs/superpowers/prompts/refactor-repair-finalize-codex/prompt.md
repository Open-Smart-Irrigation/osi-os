# Codex Task: Refactor Repair Program — finalize Train A to the local A3 boundary

## Orchestrator instructions

You are the orchestrator. You plan, dispatch, verify, and loop. Spawn a cheap execution worker per slice and an independent reviewer (spec compliance + code quality, two verdicts) after each. Never accept a worker's claim unverified: rerun the slice's gates yourself, then dispatch the reviewer with the diff. On findings, write a corrective worker prompt, re-dispatch, re-review until approved. TDD is mandatory: red captured first, test + fix committed together, no deliberately red commit on the integration branch. Export `OSI_REPAIR_PROGRAM_MODE=1` in every worker shell; source-slice commits never stage `AGENTS.md`.

**Hard boundaries.** Stop at the end of Task A3 (reviewed integrated commit series, all local gates green) and report back. Do not execute Task A3.5 or A4–A6: no deployment, no SSH to any gateway or server, no `osicloud.ch` under any circumstances, no push and no PR — the user authorizes those separately. Do not touch the main checkout at `/home/phil/Repos/osi-os` (in use); work only in worktrees you create. Load the repo skills before the matching work: `osi-flows-json-editing` for any flows change, `osi-schema-change-control` for the Task 5 boot-node gate, `osi-sync-contract-awareness` for contract work, `osi-common-pitfalls` and `osi-verification-commands` always, `anti-slop-writing` before any prose (run its `slop-check.js` on every doc you touch).

## Plans of record

Read `docs/superpowers/plans/2026-07-15-refactor-repair-program.md` fully before dispatching anything; it is the umbrella and its Shared-file ownership ledger governs every hotspot. The six source plans (same directory, dated 2026-07-15: sync-delivery-stop-loss, lsn50-writer-runtime-recovery, chirpstack-device-reconciliation, device-api-auth-status-repair, cross-repo-sync-contract-ci, refactor-boundary-hardening) carry the exact requirements; a worker gets the relevant task text, never a paraphrase. `docs/engineering-playbook.md` defines done. Train B (`refactor-boundary-hardening`) is out of scope for this handover except where the program plan says Train A must not foreclose it.

## State at handover (verify before starting)

Base: `origin/main` @ `f50950b1` — unchanged since the campaign started; confirm with `git fetch` and base everything on it or a verified descendant. Eleven review-approved scratch branches exist locally (all approvals include an independent re-review after fixes; the campaign closed 1 Critical and 19 Important findings):

| Branch | Head | Base | Content |
|---|---|---|---|
| `sdd/a0-ratchet-absolute` | `b174be03` | f50950b1 | Flow-size ratchet on absolute ceilings, exact 240/240 node coverage, identity ownership split, profile-parity lstat hardening |
| `sdd/a0-detect-backup-helpers` | `0d33b769` | f50950b1 | Closed board+SoC+model profile detector; checked ChirpStack online backup (respawn-visible identity, failure cleanup) |
| `sdd/dbhelper-primitives` | `578b7073` | f50950b1 | `osi-db-helper` `durableTransaction`/`createDedicatedDatabase`/`enterFailStop` with in-work outer-facade guard |
| `sdd/deployment-state-core` | `5233f6ab` | f50950b1 | Deployment-state library/CLI, ordinary lifecycle: envelope, CAS under mutation lockfile, link(2)-exclusive first arm, receipts, permits, locks |
| `sdd/deployment-state-guard` | `d08748a4` | 5233f6ab (stacked) | Guard-bootstrap chain verbs, claim/abandon, authorize-topology-activation (`authorityKind` discriminated), reclaim hardenings |
| `sdd/protocol-state-core` | `409299b5` | f50950b1 | `osi-sync-protocol-state` four-root init, codecs (full kind union), load verification with bidirectional set equality, locks, initialize/status |
| `sdd/protocol-state-witnessed` | `be7bfe77` | 409299b5 (stacked) | `runWitnessedOperation`, one-use capability, activity append/external-head/checkpoint/prune, capacity + crash matrix |
| `sdd/sync-stoploss-harness` | `01338cf6` | f50950b1 | Plan 3 Tasks 1–2: executable harness (ack/commands sections red by design) + delivery consumers fail-closed |
| `sdd/writer-primitives` | `a08c0672` | f50950b1 | Plan 4 Tasks 1–2: async facade, fail-closed writer, normalizer nullish-placeholder fix, integration gate |
| `sdd/chirpstack-helper` | `d046c5a3` | f50950b1 | Plan 5 Tasks 1–3: reconciliation, 10 s deadlines, idempotent close, fence-gated rollback, JoinEUI restore |
| `sdd/device-api-auth` | `1a7ccada` | f50950b1 | Plan 6 Tasks 1–2: 41-verifier tag protocol, 401/500 classifier, fixture with 43 protected + 3 unprotected routes |

Evidence: progress ledger `.superpowers/sdd/progress.md` (append to it, same format); worker reports and briefs archived at `.superpowers/sdd/handoff/reports/` and `.../briefs/`. Each report's "proposed changes to forbidden files" section is integration input, not history.

Resolved plan-owner decisions (already recorded in the program plan and ledger — binding): allowances carry an exact ceiling for every current function node, so a new node fails until a reviewed ceiling exists; `advance-guard-bootstrap` binds bootEpoch/bootId transitively through the expected head SHA, no extra flags.

## Binding integration corrections (from the ledger — none are optional)

1. Sync: a present-but-empty `results` array must set batch-level `protocol_response_missing_results` (plan-literal), not per-id errors; add the harness case. Fix when replaying the sync flow slice.
2. Writer: the two `flows.json` call sites must `await writeDeviceData(...)`; lands with plan 4 Task 3. Until then the async writer is inert live.
3. ChirpStack helper must never land without plan 5 Task 4 rewiring: `provisioned.deviceCreated` → `deviceAction === 'created'`, `error.grpcStatus`/`error.details` → `error.code`, `close()` in `finally` in both registration nodes, the `INTENT_PERSISTED` external-effect boundary; the `grpcStatus` removal also ripples to `cs-reg-cloud-ack-fn` (now a silent no-op) and `Format Response` (opaque shape change).
4. `deploy.sh` must hold `/var/lock/osi-deploy.lock.d` across every deployment-state verb call of an attempt; the module does not self-enforce this.
5. Guard-aware-94 absence stays rejected (`guard-94-consumption-unverifiable`) until the deploy-integration slice creates and verifies a typed, generation-bound consumption receipt in the same terminal generation.
6. The osi-command-ledger witnessed integration must implement durable `commandKeySha256`-scoped dedup independent of the activity ledger's 8193-row window, with an explicit test that a beyond-window replay of the same logical command cannot re-invoke an external-effect or ACK-transport adapter. This is an acceptance criterion, not a note.
7. Apply the verifier-pin proposals from the worker reports (`verify-sync-flow.js`, `test-flows-wiring.js`, `test-ci-guard-wiring.js`, workflow steps) when the owning file is first touched; compare the final command set against the program plan's hotspot ledger.
8. After every flow slice, re-derive the exact absolute ceilings for changed nodes (allowances schema is absolute + exact coverage; "scratch:"-prefixed delta reasons from wave-1 branches must not survive integration).
9. Live-only follow-ups to record in the execution report for the later A4 rehearsal, not to attempt now: real procd adapter exec plumbing, cross-uid wrong-owner behavior.

## Remaining implementation slices (build order)

Continue the campaign pattern: each slice in its own worktree branched from the current integration head (or stacked where noted), TDD, review, ledger line. The plan text named per slice is the complete requirement.

1. **Protocol verbs** (stack on `sdd/protocol-state-witnessed`): `record-v2-disposition`, `prepare-disposition-restore`, `invalidate-v2-disposition`, `prepare-database-restore`, `complete-database-restore-reconciliation`, `prepare-integrity-recovery`, `complete-integrity-recovery`, `authorize-reset`, `initialize-factory-zero` — plan 3 Task 3 Step 0 text plus the JSON contract blocks. Reconcile the core slice's flagged field-name concretizations against the plan literals as you implement each kind.
2. **Audit/reconcile/baseline CLIs**: `audit-command-ack-state` extension, `reconcile-command-ack-state`, `audit-farming-database-state`, `seal-database-restore-baseline`, `database-integrity-recovery`, the three manifests plus Ed25519 trust roots — plan 3 Task 3 file list and contract blocks.
3. **osi-command-ledger witnessed integration** + `scripts/verify-command-activity-witness.js` (correction 6 governs), then **plan 3 Tasks 3–5 flow slices** (per-entry ACK, dedupe-before-validation with durable rejection, trigger-readiness gate — the boot-node merge gate from `osi-schema-change-control` is mandatory for Task 5) following the plan's four-commit dormant/activation structure; only the activation commit is deployable.
4. **A0 deploy machinery**: compatibility-set CLI, Train A artifact builder/verifier, staged-npm `ujail` wrapper, `backup-pre-deploy`/`restore-pre-deploy`, deployment inhibitor init/S01, read-only `osi-db-integrity` rewrite, `migrate-cli --report-pending`, `deploy.sh` train-a-compat mode with `test-deploy-sh.sh` under `/bin/sh` and BusyBox ash, image-guard `93`/`97` + factory provenance codec/generators/verifiers, staging-GC and image-baseline deployment-state verbs — program plan Task A0, honoring its four-commit split (commit 3 already exists as `sdd/a0-ratchet-absolute`).
5. **Writer/device-api/pipeline remainder**: plan 4 Tasks 3–5 (LSN50 safety path, UCI kill switch, `node-red.init` export, ingest correlation gate), plan 6 Task 3 (`routes.py` 401 enforcement), pipeline test unions.
6. **Plan 5 Task 4** flow rewiring (correction 3), then **plan 7 Task 1** edge contract — only after the sync and ChirpStack flow graphs are final, per its constraint. Plan 7 Tasks 2–4 (osi-server) are out of scope here.
7. **Workflow/CI union** + `test-ci-guard-wiring.js`, then the single integrated **`AGENTS.md` checkpoint** (program plan Task A1 last bullet; cached scope exactly `AGENTS.md`).

## Integration and gates

Construct a fresh integration worktree from `f50950b1` (or the verified descendant) and replay in the program's declared order: A0 commit series → sync stop-loss (four-commit rule) → writer → ChirpStack → Device API → edge contract → `AGENTS.md`. The orchestrator applies all `flows.json` changes via the guarded scripts committed on the worker branches, bcm2712 first, mirror once, sentinel readers byte-preserved. Maintain the hotspot ledger from the program plan's Task A1; after every shared-file resolution run the owner union (program plan lines 394–417), and reject any resolution that drops a named test even at exit zero. Finish with the complete A2 gate block (program plan Task A2) — every command, real output, exit codes in the execution report — then the A3 review: an independent reviewer compares the integrated diff against all five edge-side source plans for silently broadened behavior.

Report back with: integration branch name and head SHA, the A2 gate transcript, the A3 review verdict, updated ledger, and the list of live-leg preconditions (A3.5/A4) left for the user. Branches stay local; nothing is pushed, merged, deployed, or accessed live.
