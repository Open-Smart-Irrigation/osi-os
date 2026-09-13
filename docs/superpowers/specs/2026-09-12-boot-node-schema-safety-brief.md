# P0 brief: boot-node schema safety after the Uganda incident (verified 2026-09-12)

Baseline: osi-os `origin/main` at `b79bdf4a` (PR #225 merged). Every claim below was re-checked against that ref today. Work off `origin/main`, not the `feat/valve-control` checkout (410 commits behind).

## Uganda live state (read-only SSH, 2026-09-12 19:22Z)
- Recovered. `device_data` = 70,578 rows, newest `2026-09-12T19:19:49Z` (ingest running).
- `schema_migrations` head = 56. `devices` has 45 columns incl. all five `sdi12_*`.
- Live payload `payloads/20260912T000527Z` (main boot node). Uptime 7 h.
- Backups from the window remain under `/data/db/` (five `farming.db.bak-2026-09-11T22-4*`).
- Runbook `docs/operations/uganda-catchup-runbook.md` still says execution is gated; it is stale and must be reconciled (issue #87).

## Boot node on main (`sync-init-fn`, extracted to `boot-node-main.js` for review, 75,613 chars; scratchpad artifact, not retained)
- Line 7 `DEVICES_NEW_DDL`: 45 columns, hardcoded, includes sdi12_*; `chameleon_enabled INTEGER NOT NULL DEFAULT 0` (seed says nullable; issue #173 CONFIRMED).
- Line 8 `DEVICES_COPY_SQL`: explicit positional 45-column SELECT from `devices`. Any live column not in this list is silently dropped on rebuild (#219 class). Any listed column missing on the source aborts the rebuild every boot (#220 CONFIRMED: selects `sdi12_*` unconditionally).
- Line 167 `REQUIRED_TYPES` (8 types); line 171 set-equality guard `needsRebuild`.
- Lines 173-195: `PRAGMA foreign_keys=OFF` → `legacy_alter_table=ON` → transaction {create devices_new, copy, DROP devices_old, RENAME devices→devices_old, ..., DROP devices_old} → finally FK=ON. Fence exists on main (added `81d70a212`); Uganda ran a pre-fix payload.
- Lines 205-211: `writable_schema=ON` + `UPDATE sqlite_master` healer for `devices_old` refs still present (#93 CONFIRMED).
- 93 inline `ADD COLUMN` statements remain in the boot node (#88 scope).

## Fence verifier `scripts/verify-devices-rebuild-fence.js`
Checks: no INSERT OR IGNORE, transaction present, REQUIRED_TYPES guard, FK OFF/ON-in-finally, DROP IF EXISTS devices_new, no `_db.*` inside tx. Does NOT check that DDL/COPY columns are a superset of `ALTER TABLE devices ADD COLUMN` across `database/migrations/ordered/` (#219 gate missing). Migrations adding devices columns today: 0026 (3 cols), 0028 (1), 0029 (1).

## Drift grace path `lib/osi-migrate/runner.js` (PR #214, lines ~46-160)
`isBootOwnedTriggerBodyDrift`: builds `reference(appliedHead)` via `scripts/baseline-existing-db.buildReference`, tolerates `changed` diffs only for `kind === 'trigger'` whose name is not in `verify-runtime-schema-parity.MIGRATION_OWNED_TRIGGERS`, and only when the body is v3-normaliser-equal. A `table|devices` diff from a boot-node rebuild is NOT tolerated (#221 CONFIRMED). Note: today the DDL and seed both have 45 columns, so the diff arises from `NOT NULL` on chameleon_enabled (#173) and stored-SQL formatting, not column sets.

## Rename-swap audit (#224)
- Migrations `0004` (irrigation_schedules), `0010` and `0027` (devices) do rename-swaps; the runner wraps each migration in `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; …; COMMIT; PRAGMA foreign_keys=ON;` (`runner.js:277`), so they are fenced by construction.
- Ops scripts `scripts/ops/generate-uganda-schema-rebuild-20260911.js` hold FK OFF across the whole transaction.
- No CI verifier scans for rename-swap-without-fence generically. `runner-destructive.test.js` covers the runner wrapper only.

## Init script (#223)
Deployed init is `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` (no `conf/*/etc/init.d/node-red` overlay). procd block (lines ~339-378) sets `command`, `env`, `respawn` only. No `procd_set_param stdout 1` / `stderr 1`. CONFIRMED. Note this file lives in the firmware feed, so a change ships only with a firmware rebuild unless deploy.sh also patches `/etc/init.d/node-red` on-device.

## Silvan EUI literal (#157 / #153)
`0016C001F11715E2` appears 96 times: seed-blank.sql (21), ordered migrations 0001 (22), 0003 (20), 0010 (3), 0015 (12), 0016 (2), 0017 (8), 0027 (5), 0028 (3). Normaliser v3 (`lib/osi-migrate/fingerprints.js`) is EUI-blind only in the COALESCE slot. Ordered migrations are immutable (checksum manifest, PR #95 CI guard), so the fix is a new migration that recreates the triggers with a data-driven fallback plus a seed rebuild, not an edit of old files.

## Related deploy facts
- PR #225 fixed #222 (payload flips before the post-migration restart). Close #222.
- `deploy.sh` fetches `restamp-fingerprints.js`, `verify-head-cli.js`, `verify-runtime-schema-parity.js` on-device (PR #214).
- Baseline ladder cost (#175/#158) is P1, not in scope here, but any plan that adds reference builds must not worsen it.

## Issues in scope, with what each needs
| Issue | Verified state | Needed |
|---|---|---|
| #219 | DDL/COPY hardcoded 45 cols; no superset gate | derive or assert column set from migrations; CI gate in fence verifier |
| #220 | COPY aborts on missing source cols | tolerant copy (introspect `PRAGMA table_info(devices)` on source, select NULL for absent) or apply outstanding ADD COLUMNs before copy; fixture test |
| #221 | grace path tolerates trigger bodies only | extend to boot-node-owned `devices` table diff bounded by reference(head) column set; test that stamps → boots → passes gate |
| #224 | migrations fenced by runner; boot node fenced; no generic scanner | verifier scanning flows.json function bodies + ops scripts for RENAME TO *_old/_new + DROP without adjacent FK OFF |
| #223 | no stdout/stderr capture | `procd_set_param stdout 1`/`stderr 1` in feed init + deploy.sh on-device patch for already-flashed gateways; verifier |
| #173 | NOT NULL vs nullable | make DDL nullable to match seed; parity test between DDL and seed CREATE TABLE devices |
| #157 | 96 literal sites | new ordered migration recreating affected triggers with data-driven fallback; seed regen; normaliser interplay |
| #93 | writable_schema block present | probe fleet for `devices_old` refs (Uganda now clean post-rebuild? verify), then delete block |
| #88 | 93 inline ADD COLUMNs | Option B cutover: out of scope for this wave beyond sequencing; note as follow-on |
| #87 | runbook stale | reconcile runbook + close with evidence above |
| #222 | fixed by PR #225 | close |
