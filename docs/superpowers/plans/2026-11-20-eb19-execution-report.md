# EB19 execution report

The populated fixture rejects deletion alone. Runtime implementation stopped at
the migration-assignment boundary; #93 remains open. The
[analysis and flows handoff](2026-11-20-eb19-legacy-catalog.md) records the source
trace, proposed repair requirements and exact decoded-function patch.

## Code and authorization

Startup: READY at `ec822b556`, intended base `origin/main`, 0 behind/0 ahead,
AGENTS.md revision `c63103827`. No flows reservation was granted. Neither
maintained flows file, the ordered corpus, runner, seed SQL nor bundled databases
changed. There was no host, gateway or cloud access.

The branch contains synthetic fixtures, a real-SQLite rehearsal, its CI entry,
and the analysis. The dispatcher must assign the repair (0083 is currently next)
and resolve preflight/baseline admission before the flows handoff. No schema
repair is implemented or claimed safe here. Independent review is the next
assigned stage; the draft must remain unmerged.

## Reproduction and result

All SQLite-heavy commands ran sequentially through:

```sh
osi-heavy wait --contain --scratch-tmpfs 1G --need-gib 8 -- <command>
```

The red acceptance command was:

```sh
node scripts/rehearse-legacy-catalog.js quoted retired boot
```

It exited 1. Complete rows were preserved: two devices plus two rows in each of
13 FK children, 28 rows total. There were 26 FK violations; a telemetry INSERT
failed with `no such table: main.devices_old`. The same connection closed with
`foreign_keys=1`, `legacy_alter_table=0`, `writable_schema=0`. The physical
integrity check returned `ok`. Row survival and integrity alone therefore do
not establish a usable catalog.

The green characterization suite is deliberately different from a green repair
acceptance test. It reproduces that failure, validates the historical surgery's
exact-spelling repairs, and exposes its partial-failure leaks and text-matching
hazards. It also checks row preservation and FK restoration for a healthy
catalog and the existing sanctioned parent rebuild's tested exits. These checks
do not qualify a future child-table migration.

## Checks

| Command | Result |
|---|---|
| `node --test scripts/rehearse-legacy-catalog.test.js` | 18 passed, no skips |
| `node scripts/verify-runtime-schema-parity.js` | Exit 0: `verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)` |
| `node scripts/verify-profile-parity.js` | Exit 0: `All parity checks passed.` |
| `node scripts/verify-devices-rebuild-fence.js` | Exit 0: `verify-devices-rebuild-fence: OK (2 flows)` |
| `node --test scripts/rehearse-devices-rebuild.test.js` | Exit 0: 9 passed, 1 existing pending-production-capture skip |
| `node scripts/verify-sync-flow.js` | Exit 0: `Sync flow verification passed`; ends `All parity checks passed.` |
| `node scripts/verify-no-new-silent-catch.js` | Exit 0: baseline 65 per maintained profile |
| `node scripts/verify-flows-fn-parse.js` | Exit 0: `verify-flows-fn-parse: OK` |
| `node scripts/verify-test-inventory.js` | Exit 0: new suite is assigned to the migrations workflow |
| `node scripts/verify-agents-size.js` | Exit 0: 28,648 bytes |
| `node scripts/verify-doc-hygiene.js` | Exit 0, built-in patterns; maintainer name list unavailable |
| `node .claude/skills/anti-slop-writing/slop-check.js <both EB19 Markdown files>` | Exit 0, no tier-1 findings |
| `git diff --cached --check` | Exit 0 |

Node emitted its expected experimental-SQLite warning. The existing production
column-capture skip is unrelated to these synthetic fixtures and is not counted
as a production-copy rehearsal. The new fixture populates every discovered
direct devices FK child and has no capture placeholder.

Migration/seed regeneration and their gates were not run: their source artifacts
are unchanged and the task explicitly stops before a new migration. GUI checks
are outside this branch's scope. The entire boot/flows gate must run again after
the assigned repair and reservation; the present green gates cover the current
shipped flows, while the new rehearsal also exercises the handoff in memory.
