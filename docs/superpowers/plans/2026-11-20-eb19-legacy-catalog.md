# EB19: populated legacy catalog retirement

EB19 is blocked on a governed legacy-FK repair. Deleting the boot-time surgery
alone preserves existing rows but leaves populated history tables unusable. This
branch supplies the fixture and rehearsal needed to assign that repair; it makes
no runtime, migration, seed, or bundled-database change. Refs #93.

## Sources and scope

Analysis uses `origin/main` at `ec822b556`, the release plan's EB19/R24 requirement,
and `inventory-platform.md`'s reachable boot-compatibility defect. The ordered
ledger ends at 0082. The implementer brief reserves migration numbers to the
dispatcher and places EB19 third in the flows queue, after EB2 and EB12.

Startup was READY: HEAD/base `ec822b556`, behind 0/ahead 0, AGENTS.md last changed
at `c63103827`. An inherited readiness receipt described an older branch; the
clean task checkout was moved to a new branch from freshly fetched `origin/main`
as the implementer brief required. The previous branch was preserved.

Issue #93 proposes deletion after checking known gateways. This task requires
support for populated legacy shapes, and permits local fixtures only. No fleet
census or production-copy claim is made here. The separate #88 boot-owner cutover
remains deferred. IM2's startup-doctor removal and operator restore cannot be used
as evidence that these catalogs no longer exist.

## What the block does

In `sync-init-fn`, after the guarded devices CHECK rebuild and before trigger
creation, the function queries:

```sql
SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%devices_old%'
```

Any matching table SQL enters the branch. This includes the old table itself,
comments, column names and string defaults; the underscore is also a LIKE
wildcard. The query does not inspect `PRAGMA foreign_key_list` or require a
missing parent. Normal SQLite LIKE matching is case-insensitive for ASCII.

The branch reads `schema_version`, enables `writable_schema`, and replaces the
case-sensitive substrings `REFERENCES "devices_old"` and `REFERENCES devices_old`
with `REFERENCES devices` throughout matching table SQL. It disables
`writable_schema`, manually increments the schema cookie, then logs a success
warning. The UPDATE has no transaction or rollback. Its catch currently warns
`FK self-heal failed`; the failure is visible in current main, although #93's
older description calls it swallowed. Boot proceeds after that warning.

The intent is to repair children whose FK target was rewritten by a historical
`ALTER TABLE devices RENAME TO devices_old` followed by a replacement table and
`DROP TABLE devices_old`. On modern SQLite, `foreign_keys=OFF` alone does not
prevent that rewrite. The current boot rebuild and migrations 0010, 0027 and
0060 use `legacy_alter_table=ON` to prevent new damage. None of those migrations
repairs an existing child's dangling target. The boot CHECK guard can also skip
a catalog with a healthy parent CHECK and damaged child FKs.

On the two exact spellings the UPDATE handles, the repair makes FK-enforced
telemetry inserts work again and restores referential checking and cascade
behavior. Deletion alone loses that protection. Bracketed identifiers and
lowercase `references` enter the branch but survive its replacements unchanged;
the function still logs success. The actual historical rename can also rewrite
trigger bodies, which this table-only UPDATE never repairs.

The migration runner seals table definitions and FK metadata through
`computeFingerprints`. Rewriting those definitions changes their fingerprints.
`applyPending` checks stored fingerprints before applying pending migrations;
its trigger-body grace path does not excuse changed table FKs. A pre-ledger
catalog instead goes through `baseline-existing-db`'s semantic comparison, which
also cannot simply accept a missing parent. Assigning a new migration number
alone does not bypass either admission check.

## Fixture and rehearsal

`scripts/fixtures/legacy-devices-catalog.js` derives schemas from the real
`database/seed-blank.sql`. The quoted, unquoted, bracketed and lowercase fixtures
change only FK spelling before creating the database. A separate rename fixture
executes the historical rename/copy/drop sequence on an already populated seed.
The literal-only fixture gives an unrelated table a string default containing
the replacement text. No fixture writes `sqlite_master` directly.

Every fixture populates two devices and every discovered direct FK child of
`devices` (13 in this base), including calibration and schedule tables. A newly
added child without a seed fails fixture construction. Complete rows, with all
columns, are compared before and after; counts alone do not establish survival.
The fixture is synthetic and does not claim to cover unknown deployed columns,
or a surviving `devices_old` table with divergent device data.

`scripts/rehearse-legacy-catalog.js` extracts the actual shipped block or executes
the entire shipped function with the existing real-SQLite facade shim. The
verbatim block is retained in `scripts/fixtures/legacy-catalog-surgery.txt`
from `ec822b556`; its equality to the current block is checked while present.
After retirement, legacy characterization reinserts that historical fixture
into the current boot context so the suite continues to exercise the hazard. The
retirement candidate is transformed in memory; no flows file is written. Each
run owns a temporary directory, accepts no existing DB path, and removes it in
`finally`. The report includes row comparisons, FK and integrity checks, a
rolled-back telemetry insert, table fingerprints, and PRAGMAs read from the
facade's actual connection before close. Reopening a DB would conceal a leaked
connection-local PRAGMA.

The suite characterizes the current hazards and tests the proposed deletion.
Its green result means the hazards were reproduced, not that #93 is fixed.
Catalog-update failure must expose the current leaked `writable_schema=ON`;
schema-cookie failure must expose already-committed table changes. Rebuild
success and failures at legacy-mode setup, transaction entry, copy, rename and
before commit exercise FK restoration and complete-row preservation. A storage
engine refusing the restore itself cannot be proven to restore successfully;
the handoff makes those existing restore catches warn independently.

## Disposition and stop boundary

The populated quoted retirement rehearsal exits 1: 28 rows survive unchanged,
`integrity_check` is `ok`, but `foreign_key_check` reports 26 violations across
13 children. The FK-enforced telemetry insert fails. The full boot function
still finishes normally. Empty seed parity would miss this failure.

Retire the surgery only after an assigned, reviewed repair handles affected
catalogs through the schema-governed deployment path. A child-table constraint
rebuild belongs to a `destructive` migration: writers stopped, online backup,
FK OFF outside a transaction, copy every supported column, preserve indexes and
triggers, validate populated rows and FKs, and restore FK ON on success and
error exits. Refuse unknown shapes or divergent surviving old-parent data.
Do not repair with a new writable-schema block or bless drift by hand-stamping.

The dispatcher must assign the repair and its number (0083 is currently next),
and decide how damaged pre-ledger or already-drifted catalogs enter that repair
without weakening preflight. That design and its implementation are stopped here
as requested. No new migration or runner change is authored. An affected local
copy must pass its governed repair plus the retirement rehearsal before the
handoff can be activated. An unaffected synthetic catalog is insufficient.

## Flows handoff

Reservation is still required. Both maintained profiles retain their original
bytes on this branch. No new runtime helper, `libs` entry, or `osiLib.require`
line is needed for deletion. Node id remains `sync-init-fn`; wires are unchanged.

The following is an exact diff of each JSON node's **decoded `func` string** at
the named base, not a raw JSON patch. Apply through parse/mutate/stringify after
byte-identical roundtrip checks, using the tested `retiredFunction` export. Copy
the canonical serialization to the mirror, then verify both. The three catch
changes satisfy the touched-node warning rule. They make existing duplicate-
column warnings visible; they add no schema behavior. The function shrinks.
Do not apply this candidate before the repair disposition above is complete.

```diff
--- a/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json :: sync-init-fn.func (decoded)
+++ b/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json :: sync-init-fn.func (decoded)
@@ -216 +216 @@
-for (const sql of stmts) { try { await exec(sql); } catch (_) {} }
+for (const sql of stmts) { try { await exec(sql); } catch (e) { node.warn('sync-init: ' + (e && e.message ? e.message : e)); } }
@@ -258,2 +258,2 @@
-      try { await _db.run('PRAGMA foreign_keys=ON'); } catch (_) {}
-      try { await _db.run('PRAGMA legacy_alter_table=OFF'); } catch (_) {}
+      try { await _db.run('PRAGMA foreign_keys=ON'); } catch (e) { node.warn('sync-init: ' + (e && e.message ? e.message : e)); }
+      try { await _db.run('PRAGMA legacy_alter_table=OFF'); } catch (e) { node.warn('sync-init: ' + (e && e.message ? e.message : e)); }
@@ -266,14 +265,0 @@
-// Self-heal broken FK refs (can be caused by devices table rename migration)
-try {
-  const q2 = (sql) => new Promise((res,rej) => _db.all(sql, (e,r) => e?rej(e):res(r||[])));
-  const bad2 = await q2("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%devices_old%'");
-  if (bad2.length > 0) {
-    const svRows = await q2('PRAGMA schema_version');
-    const sv = svRows[0] ? svRows[0].schema_version : 0;
-    await exec('PRAGMA writable_schema=ON');
-    await exec("UPDATE sqlite_master SET sql = REPLACE(REPLACE(sql, 'REFERENCES \"devices_old\"', 'REFERENCES devices'), 'REFERENCES devices_old', 'REFERENCES devices') WHERE type='table' AND sql LIKE '%devices_old%'");
-    await exec('PRAGMA writable_schema=OFF');
-    await exec('PRAGMA schema_version=' + (sv + 1));
-    node.warn('Self-healed FK refs for: ' + bad2.map(r=>r.name).join(', '));
-  }
-} catch(fkErr) { node.warn('FK self-heal failed: ' + fkErr.message); }
--- a/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json :: sync-init-fn.func (decoded)
+++ b/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json :: sync-init-fn.func (decoded)
@@ -216 +216 @@
-for (const sql of stmts) { try { await exec(sql); } catch (_) {} }
+for (const sql of stmts) { try { await exec(sql); } catch (e) { node.warn('sync-init: ' + (e && e.message ? e.message : e)); } }
@@ -258,2 +258,2 @@
-      try { await _db.run('PRAGMA foreign_keys=ON'); } catch (_) {}
-      try { await _db.run('PRAGMA legacy_alter_table=OFF'); } catch (_) {}
+      try { await _db.run('PRAGMA foreign_keys=ON'); } catch (e) { node.warn('sync-init: ' + (e && e.message ? e.message : e)); }
+      try { await _db.run('PRAGMA legacy_alter_table=OFF'); } catch (e) { node.warn('sync-init: ' + (e && e.message ? e.message : e)); }
@@ -266,14 +265,0 @@
-// Self-heal broken FK refs (can be caused by devices table rename migration)
-try {
-  const q2 = (sql) => new Promise((res,rej) => _db.all(sql, (e,r) => e?rej(e):res(r||[])));
-  const bad2 = await q2("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%devices_old%'");
-  if (bad2.length > 0) {
-    const svRows = await q2('PRAGMA schema_version');
-    const sv = svRows[0] ? svRows[0].schema_version : 0;
-    await exec('PRAGMA writable_schema=ON');
-    await exec("UPDATE sqlite_master SET sql = REPLACE(REPLACE(sql, 'REFERENCES \"devices_old\"', 'REFERENCES devices'), 'REFERENCES devices_old', 'REFERENCES devices') WHERE type='table' AND sql LIKE '%devices_old%'");
-    await exec('PRAGMA writable_schema=OFF');
-    await exec('PRAGMA schema_version=' + (sv + 1));
-    node.warn('Self-healed FK refs for: ' + bad2.map(r=>r.name).join(', '));
-  }
-} catch(fkErr) { node.warn('FK self-heal failed: ' + fkErr.message); }
```

## Final-branch gate requirements

After the assigned repair and flows reservation, rerun the populated fixture
through the repair, then the full boot candidate. Require identical complete
rows, successful telemetry writes, zero FK violations, and FK ON/legacy OFF/
writable-schema OFF on the same connection after every tested exit. Add cases
for the repair's own failures before calling that disposition safe.

The final flows branch must pass:

```sh
node scripts/verify-runtime-schema-parity.js
node scripts/verify-profile-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node --test scripts/rehearse-legacy-catalog.test.js
node scripts/verify-sync-flow.js
```

Also run the flows skill's roundtrip, parse, wiring, bare-require, size, silent-
catch and stray-DDL checks. The governed repair will require the migration and
seed gates from `osi-schema-change-control`. The existing populated devices
rebuild suite includes a pending production-column capture; its skip is not a
production-copy rehearsal. This package uses only the populated synthetic copy
authorized by the task. Non-author review and final verification belong to the
dispatcher's next review stage; this draft is not merge-ready.
