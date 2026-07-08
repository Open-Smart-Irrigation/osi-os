# Staged atomic payload deploy + auto-rollback

**Status:** Draft
**Refactor-program item:** 5.3 (DD10 verbatim: "Staged dir → migrate copy → health-probe → symlink flip → auto-rollback on failed post-check"). The "Edge fleet ops" scale-table row: "0.2 + 5.3 (canary gate + staged atomic deploy) are the seed of fleet rollout."
**Focus: osi-os** (deploy tooling). No boot-node change; no live gateway in this slice (rehearsed via 5.2 / operator).
**Depends on:** **1.B1** (Option B Stage 1 deploy-time runner invocation — the writers-stopped/backup/restore machinery this consumes for the "migrate a copy" step) and **0.2** (`scripts/deploy-canary-gate.js` — the heartbeat health probe this consumes for the post-check). Cite both; do not re-implement their contracts.

## Problem

`deploy.sh` today writes the new payload **in place**: it fetches `flows.json` straight to `/srv/node-red/flows.json`, runs additive `ensure_*` repairs against the live `/data/db/farming.db`, and restarts Node-RED (verified: `deploy.sh:535-537` writes flows.json to `/srv/node-red/flows.json` directly; there is no staging dir, no symlink, no atomic swap). If the new flows are bad — a broken function node, a bad migration, a payload that crash-loops Node-RED — the gateway is **already committed** to the new payload with no automatic way back; recovery is a manual re-deploy of the old version, which a remote/offline farm may not get for days. DD10 is the fix: make the payload swap **atomic** (a symlink flip, instantly reversible) and **auto-rolled-back** when the post-deploy health probe fails.

DD10 also draws a hard line 5.3 must honor honestly: **DB migrations are NOT auto-rolled-back.** Rolling back flows is a symlink flip; rolling back a destructive schema migration is a restore-from-backup — a fundamentally different, heavier, operator-gated operation (1.B1's path). Conflating them would be dangerous. 5.3 auto-rolls-back the *payload symlink*; the DB-restore path stays 1.B1's operator-invoked backup restore.

## Verified ground truth

1. **No staging/symlink today** (`deploy.sh`, verified): flows.json → `/srv/node-red/flows.json` in place (`:535-537`); `settings.js`/`package.json` similarly direct; `ensure_*` migrations run against the live DB; `node-red restart` at the end. The atomic-swap machinery is entirely new.
2. **0.2 provides the health probe** (`2026-07-07-deploy-canary-gate-design.md`, verified): `scripts/deploy-canary-gate.js` polls `GET /api/v1/admin/sync-health`, evaluates ONE gateway against freshness + server-verdict + disk + error-delta + **N=5 consecutive healthy heartbeats**, exit `0`=PASS / `1`=FAIL / `2`=couldn't-judge. **This IS 5.3's post-check** — 5.3 does not invent a health probe; it invokes 0.2's gate and rolls back on non-zero. (0.2 explicitly says "the gate does not deploy, does not roll back — payload atomicity/rollback is item 5.3" — the two are designed to compose.)
3. **1.B1 provides the migrate-a-copy machinery** (Option B Stage 1): the deploy-time `applyPending` invocation with writers-stopped, byte-verified backup fsync'd before the first destructive statement, restore-on-failure. 5.3's "migrate a COPY" step and the DB-restore path both defer to 1.B1's runner + backup — 5.3 does not re-implement migration or backup.
4. **`lib/osi-migrate/backup.js`** (verified) is the shared `.backup`+`integrity_check`+keep-5 machinery 1.B1 and 5.1 use — the DB safety net the rollback asymmetry rests on.
5. **The payload is flows.json + DB migration + GUI bundle + settings/package** — the "payload" DD10 makes atomic is primarily flows.json (the behavior) and the DB migration (the schema); the GUI bundle is disposable (re-servable). So the atomic unit is the **flows payload directory**; the DB migration is coupled but rolled back differently (§C).

## Design

### A. Staged directory + symlink flip (the atomic payload swap)

- **Introduce a versioned payload directory + a `current` symlink.** Instead of writing `flows.json` in place, deploy writes the new payload into a **staging directory** (e.g. `/srv/node-red/payloads/<deploy-stamp>/` holding `flows.json`, `settings.js`, `package.json`, the GUI bundle reference), and Node-RED reads its flows from a stable path that is a **symlink** (`/srv/node-red/flows.json` → `payloads/<stamp>/flows.json`, or a `payloads/current` symlink the runtime path points at).
- **The swap is a single `ln -sfn` (atomic rename of the symlink)** — instantaneous, and instantly reversible by re-pointing the symlink at the previous `<stamp>` directory. The previous payload directory is retained (keep-N, like backup rotation) so rollback is a symlink flip to an already-present directory, never a re-fetch.
- **Migration-path note:** the first deploy under this scheme must transition the in-place `/srv/node-red/flows.json` file to the symlink layout without breaking a mid-deploy interruption — do this by writing the new staging dir first, then atomically replacing the path with the symlink (`ln -sfn` over the existing file is atomic on the same filesystem). Verify same-filesystem placement so the rename is atomic, not a copy.

### B. The DD10 sequence (verbatim)

Deploy becomes:
1. **Stage dir** — fetch the new payload into `/srv/node-red/payloads/<stamp>/` (nothing live is touched yet).
2. **Migrate a COPY** — per 1.B1: take a byte-verified backup of `/data/db/farming.db`, run `applyPending` (writers-stopped) — 1.B1's exact machinery. (A destructive migration works on the live DB under 1.B1's writers-stopped/backup guard; the "copy" framing is 1.B1's — 5.3 invokes it, doesn't reshape it.) If the migration fails, 1.B1's restore-on-failure fires and the deploy aborts **before** the symlink flip — the old payload is still live, nothing swapped.
3. **Health probe** — flip the symlink to the new payload, restart Node-RED, then run **0.2's `deploy-canary-gate.js`** against this gateway (N=5 consecutive healthy heartbeats, server verdict, disk, error-delta, and — for a schema deploy — `--expect-schema-sig`). This is the post-check.
4. **Symlink flip** (done in step 3's start; the flip + probe are the commit) — on probe PASS (exit 0), the deploy is committed: keep the new payload as `current`, prune old payload dirs (keep-N).
5. **Auto-rollback on failed post-check** — on probe FAIL (exit 1) or couldn't-judge (exit 2 treated as fail for rollout): **flip the symlink back to the previous payload directory and restart Node-RED.** This is instant and always available (the previous dir is retained). Log the rollback loudly (heartbeat flag, per DD2/1.A4 visibility). The gateway returns to the last-known-good payload automatically.

### C. The rollback asymmetry — stated honestly (DD10)

- **Payload (flows) rollback = symlink flip + restart. Auto.** Always safe, always available, instant — because the previous payload dir is retained and flipping a symlink cannot corrupt anything.
- **DB migration rollback = restore-from-backup. NOT auto — operator-invoked (1.B1's path).** A destructive migration that has committed to the live DB is NOT undone by the payload rollback; undoing it means restoring 1.B1's byte-verified pre-migration backup, which is a deliberate, heavier, operator-gated operation (destructive schema changes are one-way doors — the program map says so). **So the honest sequencing is: run the migration LAST-safe and the health probe such that a migration failure aborts BEFORE the flip (step 2 before step 3), so the common failure — bad flows — rolls back cleanly via symlink with the DB untouched.** If a migration succeeds but the new flows then fail the probe, the payload rolls back (symlink) but the DB migration stays; the runbook must state that a schema-and-flows deploy whose flows fail leaves a migrated DB on the old flows — usually fine (migrations are additive/forward-compatible by the ownership ADR for the additive class; destructive 0004-class deploys are gated and rehearsed), but the operator is told, and the DB-restore is their explicit call, not an automatic one. **This asymmetry is the item's central honesty: flip-back is automatic, DB-restore is not.**

### D. Fleet-rollout seed (with 0.2)

- 5.3 + 0.2 are "the seed of fleet rollout" (scale table): 0.2 gates advancing between gateways; 5.3 makes each gateway's deploy atomic + self-rolling-back. Together: `deploy(atomic, self-rollback) → gate(0.2) → next gateway`. 5.3 does not orchestrate the whole fleet (that's beyond 100-gateway YAGNI) — it makes one gateway's deploy safe and reversible, which is the unit the manual/canary rollout repeats.

### E. Testing

- **`node --test` for the swap/rollback logic** (the deploy orchestration extracted to a testable JS module, `deploy.sh` calling it — the repo's script-with-test idiom): stage-dir creation, symlink flip (atomic rename), rollback flip-back (previous dir retained), keep-N pruning of old payload dirs, and the failure paths (migration-fails-before-flip → no swap; probe-fails-after-flip → flip back).
- **Rehearsal (5.2 / operator):** the genuine "bad flows → probe fails → auto-rollback → gateway healthy on old payload" cycle is a 5.2-rig / operator rehearsal against a throwaway Node-RED instance, with the captured artifact cited by the rollout runbook. CI covers the symlink/prune logic deterministically; the live restart+probe+rollback loop is rehearsed, not unit-tested.
- **No live gateway, no SSH.** All synthetic dirs / throwaway instances.

## Non-goals

- **Auto-rolling-back a DB migration** — NEVER (DD10 / §C); DB restore is 1.B1's operator-invoked backup path. The item auto-rolls-back the payload symlink only.
- **Re-implementing the health probe** (0.2) or the migration/backup machinery (1.B1) — 5.3 composes them.
- **A/B rootfs OTA** — YAGNI (program map); payload-level atomicity is the scoped risk. The symlink swap is payload atomicity, not rootfs atomicity.
- **Fleet orchestration** — 5.3 makes one gateway's deploy atomic; the canary-gated fleet walk is 0.2 + the runbook, not a fleet controller (YAGNI at 100).
- **Boot-node change** — the staging/symlink/rollback is all in the deploy path, not `sync-init-fn`.
- **Live-gateway rehearsal** — 5.2-rig / operator step.

## Definition of Done

- Staged payload directory + `current` symlink layout; `deploy.sh` writes to a staging dir and swaps via atomic `ln -sfn` (same-filesystem verified), retaining previous payload dirs (keep-N) for instant rollback.
- The DD10 sequence: stage → migrate-a-copy (1.B1's writers-stopped/backup, abort-before-flip on failure) → symlink flip + restart → 0.2 health probe → auto-rollback (flip back + restart + loud flag) on probe FAIL/couldn't-judge.
- The rollback asymmetry documented in the runbook: **payload flip-back is automatic; DB migration restore is 1.B1's operator-invoked path** — a flows-fail-after-successful-migration deploy leaves the migrated DB on old flows and the operator is told.
- Deploy orchestration extracted to a `node --test`-covered module: stage/flip/rollback/prune + the two failure paths.
- 0.2 + 1.B1 cited as consumed contracts (health probe; runner/backup) — not re-implemented.
- 5.2/operator rehearsal of the live bad-flows→auto-rollback cycle noted; the runbook cites the artifact.
- No boot-node change; no DB auto-rollback; no live gateway.
- "Open decisions" shows none outstanding.

## Open decisions

None outstanding.

- Atomic swap: **versioned payload dir + `current` symlink, flipped via `ln -sfn` (atomic same-fs rename), previous dirs retained keep-N**, decided in §A — instant + instantly reversible; verified no symlink layout exists today.
- Post-check: **0.2's `deploy-canary-gate.js` (N=5 healthy heartbeats), not a new probe**, decided in §B — 0.2 and 5.3 are designed to compose (0.2 gates, 5.3 rolls back).
- Migrate step: **1.B1's writers-stopped/backup `applyPending`, aborting BEFORE the flip on failure**, decided in §B/§C — the common bad-flows failure then rolls back via symlink with the DB untouched.
- Rollback asymmetry: **payload flip-back automatic; DB restore operator-invoked (1.B1)**, decided in §C — DD10 verbatim; destructive migrations are one-way doors, never auto-undone.
- Scope: **one gateway's atomic self-rolling-back deploy, not fleet orchestration**, decided in §D — 5.3 + 0.2 seed the canary rollout; a fleet controller is 100-gateway YAGNI.
