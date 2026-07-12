# Chaos / Soak Rig (refactor-program 5.2)

Local rehearsal harness exercising four field-fatal failure modes against **real edge code** (facade shim over `node:sqlite` + real `lib/osi-migrate`). The rig **runs** real code; it **never modifies** it.

## Scenarios

| Scenario | CI (`node --test`) | Operator (`run.js`) | Artifact gates |
|---|---|---|---|
| **outbox-replay** — weeks-offline backlog drain | Yes | Yes | `outbox-replay-*.json` → #87 Uganda catch-up, companion to 1.B4 |
| **clock-jump** — forward/backward wall-clock jump | Yes | Yes | `clock-jump-*.json` → 5.6 scheduler clock-jump behavior |
| **kill9-migration** — SIGKILL mid-`applyPending` on a DB copy | Deterministic subset | Full kill-point matrix | `kill9-migration-*.json` → Option B **Stage 2 (4.3)** + Stage 1 (1.B1/1.B2) runbook |
| **sd-full** — backup write-failure (ENOSPC) | Yes (unwritable dest) | Size-capped mount | `sd-full-*.json` → Stage 1 runbook, couples **1.A5** + **5.1** |

## CI vs operator split

**Deterministic scenarios** run in CI via `node --test` (wired into `.github/workflows/migrations.yml`):
- Outbox replay with an in-process fake server modelling 1.B4's per-event-tx contract
- Clock jump with injectable `now` (no real clock manipulation)
- Kill-9 recovery: deterministic backup + ledger-consistency path (no real SIGKILL)
- SD-full: forced write-failure via unwritable destination path

**Operator rehearsals** (not in CI — require privileges or timing-dependent):
- `node scripts/soak/run.js kill9-migration` — genuine SIGKILL kill-point matrix
- `node scripts/soak/run.js sd-full <db>` on a size-capped tmpfs/loopback mount

## Usage

```bash
# CI deterministic tests (all four)
node --test scripts/soak/rig.test.js scripts/soak/scenario-outbox-replay.test.js scripts/soak/scenario-clock-jump.test.js scripts/soak/scenario-kill9-migration.test.js scripts/soak/scenario-sd-full.test.js

# Operator: run a single scenario (writes artifact to scripts/soak/artifacts/)
node scripts/soak/run.js outbox-replay
node scripts/soak/run.js clock-jump
node scripts/soak/run.js kill9-migration
node scripts/soak/run.js sd-full <seeded-scratch.db>
```

## Artifact format

Each scenario emits a JSON artifact under `scripts/soak/artifacts/` (gitignored):

```json
{
  "scenario": "<name>",
  "timestamp": "<ISO>",
  "inputs": { ... },
  "invariants": { ... },
  "outcome": "pass" | "fail",
  "timingsMs": <number>,
  "notes": "<context>"
}
```

## Downstream citation map

| Artifact | Gates |
|---|---|
| `kill9-migration-*.json` | Option B Stage 2 (4.3): "power-loss-mid-migration rehearsed" |
| `kill9-migration-*.json` | Stage 1 (1.B1/1.B2) runbook: "backup/restore rehearsed" |
| `sd-full-*.json` | Stage 1 runbook: "backup under ENOSPC rehearsed" |
| `outbox-replay-*.json` | #87 Uganda catch-up: "edge-side backlog drain rehearsed" |
| `clock-jump-*.json` | 5.6: "scheduler clock-jump behavior rehearsed" |

## Farm-data safety

Every scenario operates on **synthetic or copied** DBs in a scratch directory. The kill-9 runner's target is always a copy; `assertFixtureUnchanged` verifies the source fixture's SHA-256 is unchanged after every run. A SIGKILL only ever damages the copy. No live gateway, no SSH, no production cloud writes.
