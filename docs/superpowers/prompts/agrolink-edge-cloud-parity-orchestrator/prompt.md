# AgroLink edge/cloud parity orchestrator prompt

Execute the autonomous program in
`docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-orchestrator.md`.
Use the matrix and execution report beside it as live control documents.

## Start gate

Do not start implementation until all of these are true:

1. The active AgroLink network integration has released
   `design-sync/agrolink` or supplied an explicit file-level handoff.
2. The preparation branch `docs/agrolink-parity-orchestrator-prep` has been
   integrated into `design-sync/agrolink`.
3. Both integration worktrees are clean.
4. OSI Server branch `AgroLink` contains the Testcontainers compatibility fix,
   and its declared smoke test passes.
5. The current heads, merge bases, active program owners, and owned hotspots
   are recorded in the execution report.

If any gate is false, diagnose safe local causes, record the exact blocker, and
stop only the affected slice. Do not absorb another program's uncommitted work.

## Execution contract

- OSI OS is canonical. Cloud edits create durable desired state and REST
  pending commands.
- Zone and journal edits render immediately from the desired-state overlay;
  synchronization continues in the background.
- Preserve separate accounts as the default. Scope roles per gateway.
- Keep REST as the only cloud-to-edge command path.
- Keep AgroLink network-drive data edge-local.
- Do not redesign device provisioning; verify and extend the existing paths.
- Use the six-device supported catalog. Keep UC512 hidden.
- Never remove the legacy durable history path without maintainer approval.
- Do not select or provision an external recovery-key service.
- Do not access production, `osicloud.ch`, live gateways, or a real SMB share.

Use isolated worktrees and the required repository skills for each slice. Apply
test-first implementation, independent diff review, and verification before
every completion claim. Update the parity matrix and execution report after
each accepted slice.

## Dispatch order

1. Run all launch prerequisites and Task 0.
2. Refresh governing documents.
3. Run scoped Phase A repair and the narrow contract gate in parallel only when
   their worktrees and owned files do not overlap.
4. Record `SCOPED_PHASE_A_READY` when the repaired edge commit is pushed. This
   permits the network program to continue; it does not transfer ownership of
   network files to the parity program.
5. Build desired-state/conflict handling.
6. Run journal server parity and scoped edge Phases B-D in independent slices.
7. Start server scoped enforcement only after its contract, desired-state, and
   edge prerequisites are green.
8. Close the code-derived portable parity matrix.
9. Add durable history coverage while retaining the legacy path.
10. Add installation-bound recovery within the stated external-provider limit.
11. Run program verification and finish the report.

The plan's dependency graph wins over this summary if a detail differs.

## Delivery policy

Commit and push reviewed slices directly:

- OSI OS: `design-sync/agrolink`
- OSI Server: `AgroLink`

No pull request is required. Record paired branch names and commit SHAs; never
cross-commit files between repositories.

End only when the definition of done is met or a declared stop condition
requires maintainer input. A stop report must name the affected slice, exact
evidence, safe work completed elsewhere, and the smallest decision needed.
