# Fix history-schema upgrade-test baseline (issue #84) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scripts/test-sync-history-schema.js` (and therefore `scripts/verify-sync-flow.js`) pass on `main` again by pointing its upgrade-path leg at a valid pre-migration baseline, with a graceful skip if the baseline ever becomes invalid again.

**Architecture:** The test builds two SQLite DBs: (a) current `database/seed-blank.sql` ("fresh seed") and (b) `git show <baseRef>:database/seed-blank.sql` + `database/migrations/2026-06-28-history-sync-v1.sql` ("upgrade path"). `baseRef` defaults to `main`, but since PR #70 (merge `682f7c1f`) the seed on `main` already contains the migrated schema, so the migration's `ALTER TABLE … ADD COLUMN` statements fail with `duplicate column name: data_invalid / comp_pending / event_uuid`. Fix: default `baseRef` to the pinned pre-merge commit `0d925c6f16a3a8145bf464737783e4baff41eeea` (= `682f7c1f^1`, verified: its seed has zero `data_invalid` occurrences and the migration applies cleanly on it), and add a marker-column guard that downgrades an already-migrated base seed to a SKIP instead of a hard failure.

**Tech Stack:** Node.js (plain script, no test framework), `sqlite3` CLI, git.

## Global Constraints

- Do NOT modify `database/migrations/2026-06-28-history-sync-v1.sql` (it is already deployed to field Pis; SQLite has no `ADD COLUMN IF NOT EXISTS`).
- Do NOT modify `database/seed-blank.sql`.
- Do NOT change any assertion inside `assertHistorySchemaAndTriggers` other than the label string shown below — the upgrade coverage itself must remain intact.
- The `OSI_HISTORY_BASE_REF` env override must keep working.
- The existing "cannot read ref" SKIP path (shallow clones) must keep working.

---

### Task 1: Pin the upgrade baseline and guard against already-migrated seeds

**Files:**
- Modify: `scripts/test-sync-history-schema.js:10-16` (baseRef default + new guard)
- Modify: `scripts/test-sync-history-schema.js:214` (label rename only)
- Modify: `AGENTS.md:73-74` (remove a now-false attribution of the verifier failures to the boot DDL)

**Interfaces:**
- Consumes: nothing from other tasks (single-task plan).
- Produces: `node scripts/test-sync-history-schema.js` exits 0 on `main`-based checkouts; `node scripts/verify-sync-flow.js` exits 0.

- [ ] **Step 1: Reproduce the failing baseline**

Run: `node scripts/test-sync-history-schema.js`
Expected: FAIL — stderr contains `duplicate column name: data_invalid` (and `comp_pending`, `event_uuid`), non-zero exit.

- [ ] **Step 2: Apply the fix**

In `scripts/test-sync-history-schema.js`, replace this block (currently lines 10–16):

```js
const baseRef = process.env.OSI_HISTORY_BASE_REF || 'main';
let mainSchema = null;
try {
  mainSchema = execFileSync('git', ['show', `${baseRef}:database/seed-blank.sql`], { encoding: 'utf8' });
} catch (error) {
  console.warn(`SKIP upgrade-path test: cannot read ${baseRef}:database/seed-blank.sql (${error.message})`);
}
```

with:

```js
// Upgrade-path baseline: last main commit whose seed-blank.sql predates the
// 2026-06-28 history-sync-v1 migration (682f7c1f^1). 'main' stopped being a
// valid baseline when PR #70 merged the migrated schema into the seed itself.
// Shallow (depth-1) clones cannot resolve this SHA and SKIP the upgrade leg.
// Assertions added to assertHistorySchemaAndTriggers must not depend on
// post-baseline schema unless gated on the label, or this leg fails spuriously.
const PRE_HISTORY_SYNC_BASE_SHA = '0d925c6f16a3a8145bf464737783e4baff41eeea';
const baseRef = process.env.OSI_HISTORY_BASE_REF || PRE_HISTORY_SYNC_BASE_SHA;
let mainSchema = null;
try {
  mainSchema = execFileSync('git', ['show', `${baseRef}:database/seed-blank.sql`], { cwd: repoRoot, encoding: 'utf8' });
} catch (error) {
  console.warn(`SKIP upgrade-path test: cannot read ${baseRef}:database/seed-blank.sql (${error.message})`);
}
if (mainSchema && mainSchema.includes('data_invalid')) {
  console.warn(`SKIP upgrade-path test: ${baseRef}:database/seed-blank.sql already contains the history-sync-v1 columns; set OSI_HISTORY_BASE_REF to a pre-migration commit to restore upgrade coverage`);
  mainSchema = null;
}
```

(`cwd: repoRoot` fixes a pre-existing latent bug: run from outside the repo, `git show` resolved against the caller's directory and silently skipped the leg. `repoRoot` is already defined at line 7.)

Then, in the try-block near the bottom of the file, rename the now-inaccurate label (the string appears exactly once):

```js
    assertHistorySchemaAndTriggers('main seed + history migration');
```

becomes

```js
    assertHistorySchemaAndTriggers('base seed + history migration');
```

Note: `assertHistorySchemaAndTriggers` gates one assertion on `label.includes('history migration')` — the renamed label still satisfies that, so no assertion behavior changes.

Finally, correct a now-false claim in `AGENTS.md` (lines 73–74). The "Boot-DDL freeze (edge schema)" section currently reads:

```
on every boot (incl. ~93 ADD COLUMNs, 81 of them redundant with the seed — the cause
of verify-sync-flow's pre-existing `duplicate column` failures). This node is FROZEN:
```

Replace those two lines with:

```
on every boot (incl. ~93 ADD COLUMNs, 81 of them redundant with the seed; the
verifier's past `duplicate column` failures were the stale upgrade-test baseline,
issue #84 — not this node). This node is FROZEN:
```

Rationale: verify-sync-flow only string-checks the Sync Init node and never executes the boot DDL; the duplicate-column failures came from the stale upgrade baseline fixed here. Leaving the misattribution in the repo's source-of-truth doc would be doubly wrong after this merge.

- [ ] **Step 3: Verify the default path passes**

Run: `node scripts/test-sync-history-schema.js`
Expected: exit 0, output ends with:
```
OK sync history schema fresh seed
OK sync history schema base seed + history migration
OK sync history schema
```

- [ ] **Step 4: Verify the guard path skips instead of failing**

Run: `OSI_HISTORY_BASE_REF=main node scripts/test-sync-history-schema.js`
Expected: exit 0; stderr contains `SKIP upgrade-path test: main:database/seed-blank.sql already contains the history-sync-v1 columns`; stdout still contains `OK sync history schema fresh seed` and final `OK sync history schema` (no upgrade leg).

- [ ] **Step 5: Verify the missing-ref path still skips**

Run: `OSI_HISTORY_BASE_REF=doesnotexist node scripts/test-sync-history-schema.js`
Expected: exit 0; stderr contains `SKIP upgrade-path test: cannot read doesnotexist:database/seed-blank.sql`.

- [ ] **Step 6: Verify the explicit pre-migration ref still exercises the upgrade leg**

Run: `OSI_HISTORY_BASE_REF='682f7c1f^1' node scripts/test-sync-history-schema.js`
Expected: exit 0 with `OK sync history schema base seed + history migration` present (proves upgrade coverage is real, not skipped).

- [ ] **Step 7: Verify the full repo gate is green**

Run: `node scripts/verify-sync-flow.js`
Expected: exit 0, final line `All parity checks passed.`

- [ ] **Step 8: Commit**

```bash
git add scripts/test-sync-history-schema.js AGENTS.md
git commit -m "fix(test): pin history-schema upgrade baseline to pre-merge seed" -m "Fixes #84"
```
