# Codex brief: execute the AgroLink fix wave

## Mission

Execute `docs/superpowers/plans/2026-08-13-agrolink-fix-wave.md` (edge worktree, commit
`1b98a437`). It fixes the adjudicated findings in
`docs/superpowers/reviews/2026-08-13-agrolink-branch-findings-ledger.md` (ledger v2).
Execution only — where a plan step conflicts with reality, stop and report; several tasks
(C7 ArchUnit counter, X9b revocation choice, L3 measure-then-decide, D1 widening) already
contain explicit decision or verify-first points; honor them rather than guessing past
them.

## Scope for this run

Phases 1, 2, 3, and the repo tasks of Phase 4 (E11, C7, X12 cleanups, C8 full cloud
sweep). **Do NOT execute Phase L or the D2/W deploy-day tasks** — those run against live
gateways and the production cloud and are maintainer-run. agrolink-test-01 is offline
anyway (ledger D8). Stop after Phase 4's repo tasks and report.

## Standing rules

All rules from `docs/superpowers/prompts/write-only-scoping-codex.md` apply unchanged:
worktree locations, read-first list, flows-editing skill, bcm2709 byte mirror, ratchet
measure-and-raise, the do-not-touch list, test invocations (frontend `npm run test:unit`;
cloud `./gradlew test` with the docker-java quirk), one frontend build at a time, one
commit per task, local commits only — no push, no deploy, no live hosts.

Additional for this wave:

- Phase 1 is the merge gate for the write-only scoping pair; run the full edge and cloud
  suites at the end of Phase 1 and record the results in the execution report before
  moving on.
- X1's CI job and X11's workflow changes are repo files (`.github/workflows/`); add them
  as specified, but do not attempt to trigger or verify remote CI runs.
- X7 (staging the seven event ops) changes `sync-contract-golden.json` — contract files
  are vendored in both repos; keep the copies byte-identical, as the plan's task states.
- C8: preserve the gradle test result artifacts (copy `build/test-results` +
  `build/reports` to a `docs/superpowers/execution-reports/artifacts/` path per the task)
  so the sweep is verifiable this time.

## Done means

Every checkbox in Phases 1–3 and the Phase 4 repo tasks ticked; both repos' full verifier
and test sweeps green with recorded output; an execution report at
`docs/superpowers/execution-reports/2026-08-13-agrolink-fix-wave.md` listing commits per
task, deviations with reasons, the decision points you hit and what you chose or deferred,
and an explicit restatement that Phase L, D2, and the walkthrough remain for the
maintainer.
