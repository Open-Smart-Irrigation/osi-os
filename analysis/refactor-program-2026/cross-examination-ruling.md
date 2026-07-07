# Refactor Program 2026 — Cross-Examination Ruling (2026-07-07)

After the three expert reports (`expert-iot-edge.md`, `expert-cloud-backend.md`,
`expert-architecture.md`), the architecture expert was given the peers' load-bearing
findings and ruled on the three open conflicts. Rulings below are adopted by the
program (`docs/architecture/refactor-program-2026.md`).

## Ruling A — Option B Stage 0+1 timing: parallel tracks

Delivery *capability* and the Uganda *use* of it are decoupled. Track A (extraction
guardrails: flows loading + CI ratchets) and Track B (Option B Stage 0 → Stage 1 →
deliver migration 0004 to the two demo gateways) run in parallel from week 1 — they
touch different files and different failure domains, and the migration runner is
already well-tested. **Uganda catch-up is hard-gated on the osi-server per-event
transaction fix + `sync_dead_letter` table**: a weeks-stale gateway replaying backlog
into a batch-wide `@Transactional` is precisely the poison-pill trigger, so forcing
Uganda first would convert a schema catch-up into a cloud outage. Demo delivery early
also de-risks Stage 1 before it meets production.

## Ruling B — Generic-writer retrofit: shadow-parity evidence, not calendar time

"Full field season" (IoT) is a proxy for input diversity; "right after pilot"
(architecture) under-specified the evidence. Adopted: after MClimate ships, run the
generic writer in **shadow mode** on demo gateways — old path writes, new path
computes and diffs against the written row (including NULL/absent-column semantics
and dedup behavior). Cutover evidence bar: **≥14 days or ≥500 live LSN50 uplinks per
gateway, zero row diffs, zero dead-letter entries**; then cut over demos, then
production after one more clean window. The rest of the fleet **never gets a
scheduled retrofit** — remaining devices migrate convert-on-touch only. Two writers
coexisting indefinitely is acceptable; the manifest allow-list contains the drift.

## Ruling C — Per-gateway feature flags: YAGNI stands, one scoped exception

No flag *framework*. Canary-gated, heartbeat-verified, per-gateway-ordered image
deploys ARE per-gateway staging, with a trusted revert path (redeploy previous
image). Shadow mode is non-destructive and needs no flag. Exception: the LSN50
**cutover** deploy may carry one temporary UCI boolean kill-switch reverting to the
old writer without redeploy, **deleted after fleet convergence** (consistent with the
ownership ADR's consumed-or-deleted invariant). A third pipeline change needing the
same lever is the flip condition to revisit a real flag surface.

## Phase-membership changes from peer findings

- Per-event tx boundary + `sync_dead_letter` (cloud finding) → Phase 1, blocking
  Uganda; ships with a Testcontainers test reproducing the poison-batch replay.
- GHCR pull-only deploys (cloud finding) → Phase 1, folded into the server-CI item;
  on-host compose `build:` is retired.
- Crash-loop escalation in heartbeat (IoT finding: procd `respawn 3600 5 -1` masks
  crash loops) → Phase 1; prerequisite for trusting heartbeat-gated deploys.
- `sync_outbox` retention + size cap (IoT finding: unbounded SD growth) → Phase 1;
  offline-first correctness bug, not hygiene.
- Actuator duration-bound CI assertion → entry gate of Phase 3, before any MClimate
  downlink code merges.

Net effect: delivery capability moves ~10 weeks earlier, Uganda gets strictly safer,
and the writer retrofit gets an evidence bar instead of a date.
