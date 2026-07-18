# Refactor repair Train A local finalization

Date: 2026-07-19

Scope: local implementation and integration through Task A3. Task A3.5 and Tasks A4-A6 are excluded. No push, PR, deployment, SSH, gateway access, server access, or production-cloud access is permitted.

## Run state

- Base fetched and verified: `origin/main` at `f50950b1767a1aa6302ef2553d68a4e379b5b142`.
- Integration branch: `integration/refactor-repair-train-a-a3-20260719`.
- Integration worktree: `/home/phil/Repos/osi-os/.worktrees/refactor-repair-train-a-a3`.
- Program mode for source-slice workers: `OSI_REPAIR_PROGRAM_MODE=1`.
- Handoff inputs remain read-only in the main checkout because the prompt, plans, briefs, and reports are untracked or ignored there.

## Baseline gates

| Command | Exit | Pass signal |
|---|---:|---|
| `node scripts/verify-sync-flow.js` | 0 | `All parity checks passed.` |
| `node scripts/verify-profile-parity.js` | 0 | `All parity checks passed.` |
| `node scripts/verify-flows-size-ratchet.js` | 0 | `committed baseline not exceeded` |

## A2 environment preflight

- `web/react-gui/npm ci`: exit 0, 269 packages installed. npm reported 12 dependency-audit findings and blocked two unapproved install scripts; these are recorded separately from repository gate results.
- The host has no `apt-get`, no passwordless sudo, and no `busybox` on `PATH`. The existing executable `/usr/lib/initcpio/busybox` is BusyBox 1.36.1 and its `ash` passed a direct readiness probe. `/tmp/osi-train-a-tools/busybox` points to it for the local A2 shell gate; no system package or repository file was changed.

## Preflight adjudications

- The umbrella plan governs the prompt's ordering ambiguity. Pure protocol, audit, and dormant witnessed primitives may be prepared on isolated stacks before A0. Shared flow activation and integration wait until the complete A0 commit-4 boundary is integrated.
- Scratch branches are proposal vehicles. Their commits will be reconstructed into the plan-mandated green commit shapes; intentionally red or partial scratch commits will not enter integration history.
- The approval ledger from the main checkout will be reproduced deliberately in this worktree before the final documentation checkpoint. No main-checkout mutation is allowed.
- The pinned cumulative comparison base is `f50950b1767a1aa6302ef2553d68a4e379b5b142`. A2 and A3 use `git diff --check "$BASE_SHA...HEAD"`; a later movement of `origin/main` cannot change the review basis.
- Sync Tasks 3-4 own four ordered commits. Task 5 is a fifth, separate post-activation commit named `fix: fail sync readiness on missing triggers`.
- The A2 union includes the umbrella block plus `node --test scripts/factory-database-seed-cli.test.js` and `node scripts/generate-factory-image-provenance.js --refresh-bound-hashes --preserve-image-build-id --check` from the source plans.
- Before A2, install the React dependency tree with `npm ci` and provide a verified BusyBox `ash`. Missing tools are environment failures, not repository defects.
- A3 covers umbrella Tasks A0-A2, all five edge-side source plans, PR #146 lifecycle preservation, the hotspot ledger, and Train B non-foreclosure.
- Local documentation is part of Train A: sync Task 6 Steps 1-3, writer Task 5, ChirpStack Task 5 Steps 1-3, cross-repo Task 1 Step 5, A0 build/live-ops documentation, the plans, and this prompt. Live steps remain excluded.
- The main checkout's uncommitted `osi-config-and-flags` and `osi-live-ops-runbook` edits are user-owned. They are read-only conflict input: compatible hunks may be reconstructed deliberately, but no wholesale copy or main-checkout mutation is allowed.

## Reconstruction map

| Final boundary | Proposal input | Reconstruction rule |
|---|---|---|
| A0 commit 1: deployment state and guard primitives | `sdd/deployment-state-core`, `sdd/deployment-state-guard`, `sdd/a0-detect-backup-helpers`, `sdd/dbhelper-primitives`, protocol-state skeleton | Consolidate the approved primitives and guards into one non-deployable commit. Exclude callers, flow activation, ratchet changes, and documentation. |
| A0 commit 2: factory provenance and baseline bootstrap | A0 image-provenance work plus the relevant protocol/factory initialization primitives | One non-deployable provenance/bootstrap commit with regenerated trust anchors and direct tests. |
| A0 commit 3: absolute flow-size ceilings | `sdd/a0-ratchet-absolute` | Fold its four proposal commits into exactly one reviewed commit. Replace scratch/delta reasons with exact absolute ceilings and exact node coverage. |
| A0 commit 4: runtime compatibility set | Remaining A0 machinery | First deployable A0 SHA. Integrate the compatibility CLI, artifact build/verify, staged npm wrapper, backup/restore, inhibitor, integrity/migration reports, deploy lock discipline, image guards, and staging/baseline verbs as one compatibility set. |
| Sync commits 1-3: dormant trust state | `sdd/protocol-state-witnessed` plus the protocol-verbs, audit/reconcile, and command-ledger proposal stacks | Reconstruct the three green dormant checkpoints. No flow/deploy callers. Preserve all four regenerated trust anchors whenever a bound byte changes. |
| Sync commit 4: activation | `sdd/sync-stoploss-harness` plus Tasks 3-4 final flow/wiring | Do not import the deliberately red scratch commit. Land tests and caller wiring together; this is the first deployable sync SHA. Apply empty-results batch semantics and durable beyond-window command dedupe. |
| Sync Task 5 | Post-activation boot-node gate | Separate commit after activation. Touch only trigger-readiness owners and their exact ratchet ceiling. |
| Writer | `sdd/writer-primitives` plus writer Tasks 3-5 | Land async primitives only with awaited live callers, fallback safety path, UCI/procd export, correlated ingest gate, and local documentation. |
| ChirpStack | `sdd/chirpstack-helper` plus Task 4 | Helper and both flow-owner rewires land together, including the intent-persisted external-effect boundary and every client close path. |
| Device API | `sdd/device-api-auth` plus Task 3 | Auth status repair and pipeline 401 enforcement remain a reviewed vertical slice. |
| Edge contract | Cross-repo Task 1 only | Generate after sync and ChirpStack graphs are final. No server-repo work. |
| Documentation and CI | Owner-union gates, source-plan documentation, plan records, then `AGENTS.md` | Preserve every named gate. Commit `AGENTS.md` alone at the final checkpoint. |

## Hotspot ledger

Pending extraction before the first shared-file integration.

## Slice evidence

### A0 commit 3 proposal reconstruction

- Branch/head: `sdd/finalize-a0-commit3-20260719` at `4a2a12c48dde5b4353d7e93844cfc768cb848d8d`.
- Commit: `fix: migrate the flow-size ratchet to absolute ceilings`.
- TDD evidence: the final test suite failed against the old ratchet and profile-parity implementations; mutation controls then failed at 28/30 when per-node comparison was disabled and 29/30 when zero-length coverage was broken.
- Orchestrator rerun: ratchet 30/30; scanner 8/8; identity ownership 6/6; profile parity 12/12; direct ratchet, live-identity, profile-parity, and sync-flow verifiers all exited 0.
- Measured boundary: both profiles have 240 measured and 240 configured node IDs, no missing/extra/mismatched IDs, and exact total `1069245`.
- Diff boundary: eight allocated files only; no flow, runtime, deploy, workflow, pipeline, or `AGENTS.md` change. Independent spec/quality review is pending.
- Independent review 1: spec `FAIL`, quality `NEEDS FIXES`; no Critical findings. Three Important bypasses were reproduced: same-target valid-versus-broken symlink parity, lossy/unsafe JSON numeric ceilings, and a duplicate-key scan confused by braces inside a reason string. Corrective TDD and an amended single commit are in progress; the original head is not approved for integration.
- Corrected head: `d970b64ced95ca9f701b04436ceb48b921158853`, still exactly one commit with the required subject/eight-file boundary. The expanded orchestrator rerun is green: ratchet 36/36, scanner 8/8, identity ownership 6/6, profile parity 12/12, and all direct verifiers. Independent re-review is pending.
- Final approved head: `27241bff167b76ea2382062a452150d97e2f98c6`. Three corrective review loops closed unsafe/lossy number tokens, string-confused duplicate detection, broken/intermediate/final symlink escapes, missing chains, cycles, and special targets. Final independent verdicts: spec `PASS`, quality `APPROVED`, no Critical or Important findings. Ratchet 36/36, profile parity 19/19, identity ownership 6/6, scanner 8/8, and all direct gates are green. This proposal remains unintegrated until A0 commits 1 and 2 precede it.

### A0 commit 1 proposal reconstruction

- Branch/head: `sdd/finalize-a0-commit1-20260719` at `b74587b0eb344c377d29d30dda2b1038cef29aed`.
- Commit: `feat: add deployment state and guard primitives`; exactly one commit above the design-record base and no caller/runtime/workflow/`AGENTS.md` edits.
- Orchestrator rerun: deployment-state/guard 282/282; launcher 3/3; compatibility set 3/3; detector 18/18; ChirpStack backup 23/23; staged npm, inhibitor, and profile parity pass; factory seed, command-audit skeleton, and protocol skeleton 2/2 each; resident/caller guard 3/3.
- Disclosed scope tensions under review: legacy backup/restore helpers and direct tests were omitted; the audit/protocol surfaces are dormant skeletons; commit-1 residents are checked by a direct guard but do not enter the general profile-parity inventory until commit 3. The worker's interpretation is not accepted until independent spec and quality verdicts complete.
- Independent review 1: spec `FAIL`, quality `NEEDS FIXES`. Four Critical and seven Important findings were reproduced despite green direct tests. Critical: incomplete/fail-open startup authority, launcher-orphan behavior, factory-seed no-replace race, and factory-zero eligibility without trust inputs. Important: incomplete file allocation, wrong lineage union, incomplete compatibility protocol, incomplete lineage verification, unproved npm jail isolation, ChirpStack destination/source gaps, and non-durable inhibitor unlink. A full corrective TDD loop is in progress; `b74587b0` is not approved for integration.

### Protocol-verbs proposal

- Branch/head: `sdd/finalize-protocol-verbs-20260719` at `72ba27271e7e000aae3e2ee61a66dc52fde62b40`, one commit above witnessed-protocol head `be7bfe77`.
- Orchestrator rerun: both maintained protocol suites 157/157; CLI 24/24; profile parity, helper registration/tests, sync-flow, and diff checks exited 0.
- Worker-disclosed residuals: all-root-absence integrity authority, non-disposition crash-prefix completion, positive spawned CLI coverage for seven verbs, and final A0 envelope/artifact/provenance coupling. The slice is not approved or integrated; independent spec/quality review remains mandatory.
- Independent review 1: spec `FAIL`, quality `NEEDS FIXES`; no Critical findings because the slice is dormant. Seven Important gaps: incomplete authority gate, parsed-but-unused evidence, missing non-disposition crash resume, same-operation replay without unchanged-authority comparison, under-typed permanent receipts, absent all-root integrity initialization, and incomplete CLI/fault coverage. Deployment-only verbs were also exposed through the public helper index. A corrective TDD loop is in progress; `72ba2727` is not approved.
