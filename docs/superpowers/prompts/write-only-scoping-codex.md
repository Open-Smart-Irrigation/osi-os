# Codex brief: execute the write-only scoping rework

## Mission

Implement the approved write-only scoping rework and the two-tab zone-card device add,
exactly as planned. The spec and both plans are committed and cross-reviewed; your job is
execution, not redesign. Where a plan step conflicts with reality, stop and report the
conflict instead of improvising.

## Read first, in order

1. `docs/superpowers/specs/2026-08-12-write-only-scoping-device-add-design.md` (spec v2 —
   decisions W1–W10, preserve-ledger P1–P11)
2. `docs/superpowers/plans/2026-08-12-write-only-scoping-edge.md` (16 tasks)
3. `docs/superpowers/plans/2026-08-12-write-only-scoping-cloud.md` (15 tasks)
4. `AGENTS.md` in each repo, and the `osi-flows-json-editing` skill before any flows.json
   edit (skills load from `.agents/skills`)

## Where to work

- Edge: `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep`, branch
  `feat/journal-cloud-primary`. All plan and spec paths above are relative to this
  worktree.
- Cloud: `/home/phil/Repos/osi-server/.worktrees/agrolink`, branch
  `feat/journal-cloud-primary`. The cloud plan's task paths are relative to this checkout.

## Order of execution

0. First commit the four pending `osi-chirpstack-helper` files already modified in the
   edge worktree (both profile trees) as
   `fix(chirpstack-helper): accept ChirpStack 4.12+ zero-key read-back in verifyKeys`.
   They are a finished, live-verified fix; do not rework them.
1. Edge tasks 1–16 in order, one commit per task, following each task's checkbox steps
   literally (failing test first, exact commands, expected failures).
2. Cloud tasks 1–15 in order. Cloud Task 10 must match the contract edge Task 15
   implements: the `REGISTER_DEVICE` command carries `zoneUuid`, never an integer id.

## Hard constraints (violations are stop-and-report, not judgment calls)

- Flag-off behavior is byte-for-byte unchanged; only `OSI_SCOPED_ACCESS=1` semantics move.
- `bcm2712` is the edit source; mirror flows/helper changes byte-identical to `bcm2709`.
- After every flows edit: `node scripts/verify-sync-flow.js` green, and raise the exact
  ceilings in `scripts/verify-flows-size-ratchet-allowances.json` (they currently equal
  current sizes — zero headroom).
- Never touch: `write-strega-expectation` and its dual-gate, `assertFreshDeviceAccess`
  internals, `EdgeOwnershipService`, the cloud sync appliers, `sync-init-fn`.
- `scripts/test-scoped-access-writes.js` stays green throughout; only the cases the plans
  name may change.
- Frontend tests: `cd web/react-gui && npm run test:unit` (never bare `npx vitest run`).
  Cloud backend: `./gradlew test` (Testcontainers wants `api.version=1.44` in
  `~/.docker-java.properties`; run `./gradlew --stop` after env changes). Never run two
  frontend builds at once — this workstation OOMs.
- Commit locally only. Do not push, do not deploy, do not touch any live gateway or cloud
  host. Rollout is a manual lockstep step the maintainer runs (spec §10).

## Done means

Every checkbox in both plans ticked; full verifier sweep green in both repos (edge:
`verify-sync-flow.js`, `verify-scoped-access.js`, scoped reads/writes suites, frontend
unit tests; cloud: full `./gradlew test`, frontend unit tests). Finish with a report:
commits per task, any deviation from a plan step with its reason, and the deferred items
the plans already name (unassigned rename/config, cloud 404-to-403 sweep, custom-vocab
follow-up) restated so they are not mistaken for omissions.
