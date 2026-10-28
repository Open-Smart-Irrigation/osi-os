# Ledger catch-up runbook

**Status:** General guidance for planning a pre-ledger catch-up from a completed incident. This document does not authorize work on any gateway. Each operation needs current, gateway-specific evidence and explicit authorization from the responsible operator.

This guide records the safety lessons from a completed schema catch-up and rebuild. The incident and rehearsal reports linked below retain their historical scope. Their artifacts describe that work only.

- [Catch-up rehearsal report](uganda-catchup-rehearsal-20260911-report.md)
- [Schema rebuild report](uganda-schema-rebuild-20260911-report.md)
- [Boot-node schema safety plan](../superpowers/plans/2026-09-12-boot-node-schema-safety.md)
- [Live operations runbook](../../.claude/skills/osi-live-ops-runbook/SKILL.md)
- [Schema change control](../../.claude/skills/osi-schema-change-control/SKILL.md)

## Authorization and scope

A pre-ledger repair can rebuild tables, apply migrations, stop services, and affect stored history. The operator must establish the target gateway, approved scope, maintenance window, recovery owner, and current access authority before preparing an execution plan. Reconfirm each item for that gateway. This document is not standing authorization for another operation.

Do not copy a previous gateway's gate results, schema counts, database copy, backup, SQL, script arguments, expected output, or cloud account state. The prior work's generators, generated SQL, and window script are historical single-use artifacts. They are not generic tools or instructions for another gateway.

## Failure mechanism and required controls

The incident showed that a schema repair can complete while the running gateway still has an older flow payload. A subsequent Node-RED restart then ran an old boot-node table rebuild against the new schema. Its unfenced `DROP TABLE` caused a foreign-key cascade that deleted child history.

Before any restart against a changed schema, confirm the intended flows payload is active, not merely staged. If the live payload cannot be matched to the reviewed repair plan, stop before changing the database or restarting Node-RED.

Any parent-table rebuild must set `PRAGMA foreign_keys=OFF` before opening the rebuild transaction. Keep it disabled across the complete drop/rename swap and through transaction completion. On every exit path, restore `PRAGMA foreign_keys=ON` after the final drop and after `COMMIT` or `ROLLBACK`, using a `finally` path. Then run `PRAGMA foreign_key_check` and require zero violations before proceeding. Review every dependent child table. A rebuild must fail closed if row mapping or constraints do not match the reviewed plan.

## Plan evidence to establish for each gateway

Build a new plan from a current, read-only inventory of the target gateway and the exact source revision that will be applied. The plan should identify:

- The missing ledger state and schema differences, with evidence for each table or object in scope.
- The exact migration path and any required pre-ledger repair, reviewed against the migration source and current schema.
- The active flows payload and the restart behavior that will follow the schema change.
- A fresh, integrity-checked backup with a verified off-device copy and a defined restore owner.
- Before-and-after row-count expectations for every history-bearing table, including any intentional count changes.
- Postflight checks for migration head, SQLite integrity, foreign-key violations, restored service operation, and the relevant sync or ingest path.
- A stop condition and recovery decision for every failed preflight, apply step, or postflight check.

A successful rehearsal on a copy is a prerequisite to a live plan, not a substitute for current live preflight evidence. A mismatch between the current schema and the reviewed copy invalidates the rehearsal for that target.

## Execution boundary

Follow the approved gateway-specific plan and the current live-operations procedure. Keep a verified backup before the first destructive or data-changing step. Preserve it until the responsible operator accepts postflight evidence and the recovery window closes.

Compare history-bearing row counts with the recorded pre-change values after each planned stage. Stop on an unexplained difference; do not continue to later migrations or restart Node-RED to see whether the issue clears. Preserve logs and database copies for investigation.

Do not use commands, generated SQL, script options, migration heads, or expected values copied from the historical artifacts as a replacement for a reviewed plan. If a general-purpose migration or repair tool is needed, use only one that is already documented and approved for the target state.

## Postflight and closure evidence

The gateway-specific execution record should contain the plan and source revision, backup verification, actual command exit statuses, before-and-after row counts, migration-head result, SQLite integrity result, foreign-key check, active flows confirmation, service restart result, and the relevant ingest or sync evidence. Record any deviations and leave the work open if a required check is missing or unexplained.

The incident's durable lessons are the payload-flip precondition before restart, a foreign-key fence around parent-table rebuilds, verified backups, row-count comparison, and postflight checks tied to the actual gateway. The companion reports remain historical records of one repair.
