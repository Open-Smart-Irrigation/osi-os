# SD durability — boot integrity check + quarantine/restore (refactor-program 5.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Repo:** all changes in **osi-os** (`/home/phil/Repos/osi-os`). Branch `feat/51-boot-db-integrity`, PR, **do not merge**. Work in a worktree, not the root `main` checkout.
> **Execution notes:** (1) run every command from the worktree root; (2) **do NOT touch `sync-init-fn`** (frozen boot node) — the check is out-of-process (init.d + JS); (3) init.d files ship in **bcm2709 + bcm2712** profiles only (verified: those two carry `osi-bootstrap`/`osi-rootfs-resize`; bcm2708/rak7391 carry only `redis`) — mirror the new init.d to both, byte-identical; (4) the JS test wires into `.github/workflows/migrations.yml`'s `node --test scripts/*.test.js` line — add it there; (5) `sqlite3` CLI is on the image and in CI (used by `lib/osi-migrate`).
> **Spec:** [`docs/superpowers/specs/2026-07-08-sd-durability-integrity-check-design.md`](../specs/2026-07-08-sd-durability-integrity-check-design.md) (approved; §A–§F references point there).

**Goal:** A boot-time SQLite integrity gate that runs **before Node-RED starts** (out-of-process init.d at START < 99): `PRAGMA quick_check` on `/data/db/farming.db`; on failure, quarantine the corrupt file (timestamped, NEVER deleted — farm data), restore the newest passing local `.bak-*` backup, and write a persistent recovery stamp so the gateway surfaces the event (heartbeat flag + `node.error` on first boot) instead of silently swapping its DB. Clean-boot path opportunistically refreshes the keep-5 backup pool. No good backup → fail loud, never fabricate a DB.

**Architecture (spec §A–§D):** thin init.d shell wrapper (`osi-rootfs-resize` shape, USE_PROCD=0, START=90) invokes a testable Node script `scripts/boot-db-integrity-check.js` that reuses `lib/osi-migrate/backup.js` helpers (`backupDb`/`sqliteDotQuote`, keep-5 rotation, `.backup`+`integrity_check`). The recovery stamp (`/data/db/.integrity-recovery.json`) is read on first boot by a small flows counterpart (the `osi-health-helper` heartbeat builder) to set a health flag + emit `node.error` — that flows read is a paired slice noted, not built inside the integrity logic.

**Tech Stack:** Node.js (`node:test`, no new deps), `sqlite3` CLI via `lib/osi-migrate/runner-iface` / `backup.js`, OpenWrt init.d (`/etc/rc.common`), GitHub Actions (`migrations.yml`).

## Global Constraints

- **osi-os only.** Branch `feat/51-boot-db-integrity`; commit per task; PR; **do not merge**.
- **NEVER touch `sync-init-fn`, `deploy.sh`, or `scripts/repair-pi-schema.js`.** The integrity logic is init.d + a new JS script; no flows.json change in this plan except the paired heartbeat counterpart (§D), which is a SEPARATE noted slice, not required for the core check to ship.
- **NEVER auto-delete a quarantined corrupt DB** (spec §B.3.a — farm data). Quarantined `.corrupt-*` files are outside the keep-5 rotation and never pruned by this tool.
- **NEVER fabricate a DB** when no good backup exists (spec §B.3.c) — fail loud (stamp + non-zero), leave the DB absent for deploy/operator recovery.
- **Missing DB (fresh gateway) → clean no-op** — never create/reseed (DD guardrail; deploy owns first seeding).
- **No SSH, no live gateways.** All tests use synthetic temp-dir DBs. On-device rehearsal is a 5.2 chaos-rig scenario / operator step.
- **Both-profile parity** for the init.d file (bcm2709 + bcm2712, byte-identical).
- CI (`migrations.yml`) green at every commit.

## Non-goals (do not do these)

- No boot-node (`sync-init-fn`) change. No cloud upload (#56's remote tier — coupled, separate; spec §F). No A/B rootfs / filesystem SD redundancy (YAGNI). No live-gateway rehearsal. The heartbeat/`node.error` flows wiring beyond the paired-slice note is NOT this item's core (§D).

## File Structure (all paths from the worktree root)

- Create: `scripts/boot-db-integrity-check.js`, `scripts/boot-db-integrity-check.test.js` (Task 1)
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-db-integrity` + byte-identical mirror `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-db-integrity` (Task 2)
- Modify: `.github/workflows/migrations.yml` (add the new test to the `node --test scripts/*.test.js` run) (Task 3)
- Paired slice (SEPARATE, noted): the `osi-health-helper` heartbeat builder flows read (§D) — NOT in this plan's core commits.

---

### Task 1: `boot-db-integrity-check.js` + `node --test` coverage (TDD, all §E branches)

**Files:**
- Create: `scripts/boot-db-integrity-check.test.js`
- Create: `scripts/boot-db-integrity-check.js`

**Interfaces:**
- Produces: `runBootIntegrityCheck(dbPath, { backupKeep = 5, recentBackupMaxAgeMs, now }) → { status, restoredFrom?, quarantinedTo?, stampPath?, error? }` where `status ∈ {'ok', 'ok-missing', 'recovered', 'unrecoverable'}`. Reuses `backup.js` (`backupDb`, `sqliteDotQuote`, `pruneBackups`).

- [ ] **Step 1.1: Worktree + branch** — create a worktree of `main` at `feat/51-boot-db-integrity`; `cd` into it.

- [ ] **Step 1.2: Write the failing test (red)** — create `scripts/boot-db-integrity-check.test.js` (`node:test`, mirroring `lib/osi-migrate/__tests__/backup.test.js` style — temp dirs, `cliRunner`/`sqlite3` to build DBs, corrupt by truncating/scribbling a page). Cover every spec §E branch:
  1. **healthy DB** → `quick_check` ok → `status: 'ok'`, no quarantine; an opportunistic backup is taken when none is recent; and **skipped when the newest `.bak-*` is < `recentBackupMaxAgeMs` old** (assert no new backup written on a second immediate call).
  2. **corrupt DB + a passing `.bak-*`** → `status: 'recovered'`; assert the corrupt file moved to `.corrupt-<stamp>` (present, not deleted), the restored DB now passes `quick_check`, the stamp file written with `restoredFrom`/`quarantinedTo`.
  3. **corrupt DB + newest `.bak-*` ALSO corrupt, older one passing** → restores the older passing one (skips the corrupt newest); assert `restoredFrom` is the older backup.
  4. **corrupt DB + NO passing backup** → `status: 'unrecoverable'`; assert the corrupt file is quarantined, NO new DB fabricated (`/data/db/farming.db` absent), a loud stamp written, function signals failure (non-zero exit when run as CLI / `unrecoverable` status).
  5. **missing DB** (fresh gateway) → `status: 'ok-missing'`, nothing created, no stamp.
  Also assert WAL sidecars (`-wal`/`-shm`) are moved alongside the corrupt DB on quarantine (build the DB with `PRAGMA journal_mode=WAL`).

Run: `node --test scripts/boot-db-integrity-check.test.js`
Expected: FAIL — `Cannot find module './boot-db-integrity-check'`.

- [ ] **Step 1.3: Implement** — create `scripts/boot-db-integrity-check.js`:
  - `require('../lib/osi-migrate/backup')` for `backupDb`/`pruneBackups`/`sqliteDotQuote`; `require('../lib/osi-migrate/runner-iface')` for the `sqlite3` exec style.
  - `quickCheck(dbPath)`: `sqlite3 <db> "PRAGMA quick_check;"`, trim, return whether it equals `ok`.
  - `runBootIntegrityCheck(dbPath, opts)`:
    - missing DB → `{status:'ok-missing'}` (no side effects).
    - `quick_check` ok → opportunistic `backupDb(dbPath,{keep:backupKeep})` UNLESS newest `.bak-*` is younger than `recentBackupMaxAgeMs` (default 24 h; use injectable `now` for tests) → `{status:'ok'}`.
    - `quick_check` fail → move `dbPath` + `-wal`/`-shm` to `${dbPath}.corrupt-${isoStamp}` (fs.renameSync; NEVER unlink) → walk `${dbPath}.bak-*` newest-first, `quickCheck` each, copy the first passing one to `dbPath` → write stamp `${dir}/.integrity-recovery.json` → `{status:'recovered', restoredFrom, quarantinedTo, stampPath}`. If none passes → write loud stamp, leave DB absent → `{status:'unrecoverable', quarantinedTo, stampPath}`.
  - CLI `main()`: run against `/data/db/farming.db`, log the outcome via `console.error` (one greppable line naming the event), `process.exit(status==='unrecoverable' ? 1 : 0)`.
  - Anti-typo/refuse rules mirror `backup.js`/`restamp-fingerprints.js` (never operate on a path that would create garbage).

- [ ] **Step 1.4: Run it (green)**

Run: `node --test scripts/boot-db-integrity-check.test.js`
Expected: all branches pass.

- [ ] **Step 1.5: Commit**

```bash
git add scripts/boot-db-integrity-check.js scripts/boot-db-integrity-check.test.js
git commit -m "feat(durability): boot-time SQLite quick_check + quarantine/restore-from-local-backup (5.1, DD18)"
```

---

### Task 2: The `osi-db-integrity` init.d service (out-of-process, START < 99), both profiles

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-db-integrity`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-db-integrity` (byte-identical mirror)

**Interfaces:** produces the boot gate that runs Task 1's script before Node-RED (`START=99`) and osi-bootstrap (`START=99`).

- [ ] **Step 2.1: Create the init.d (bcm2712)** — model on `osi-rootfs-resize` (USE_PROCD=0, `start()` + logger). `START=90` (below node-red/osi-bootstrap's 99 and redis's 95 — runs first). `start()` invokes `node /usr/share/... /boot-db-integrity-check.js` (resolve the on-image path where scripts land — verify how `scripts/` maps into the image, mirroring how `chirpstack-bootstrap.js` is placed under `/usr/share/node-red/`; if `scripts/` isn't imaged, place the check script under an imaged path and reference it — **verify the image layout before hard-coding the path**). Route output to `logger -t osi-db-integrity`. Never fail the boot (a non-zero from the script logs loudly but `start()` returns 0 so the gateway still boots to a recoverable state — the stamp + heartbeat carry the alarm, not a boot-halt).

- [ ] **Step 2.2: Verify START ordering** — confirm (doc/grep assertion) the new `START=90 < 99` (node-red, osi-bootstrap) so the check runs before Node-RED touches the DB. This is the load-bearing ordering property.

- [ ] **Step 2.3: Mirror to bcm2709 byte-identically**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-db-integrity \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-db-integrity
```

Confirm identical (`diff` → no output). (If a profile-parity verifier covers init.d, run it; otherwise the `diff` is the gate.)

- [ ] **Step 2.4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-db-integrity \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-db-integrity
git commit -m "feat(durability): osi-db-integrity init.d (START=90, before Node-RED) on both Pi profiles (5.1)"
```

---

### Task 3: CI wiring + paired-slice note + PR

**Files:**
- Modify: `.github/workflows/migrations.yml`

- [ ] **Step 3.1: Wire the test into CI** — in `migrations.yml`, add `scripts/boot-db-integrity-check.test.js` to the existing `node --test scripts/...test.js` run (line ~38). Confirm the workflow's `sqlite3` availability (the migrations job already uses it).

Run locally: `node --test scripts/boot-db-integrity-check.test.js` (green) and, if quick to run, the broader `node --test lib/osi-migrate/__tests__/*.test.js` to confirm nothing regressed.

- [ ] **Step 3.2: Record the §D paired flows counterpart as a follow-up** — in the PR body, note the separate slice: the `osi-health-helper` heartbeat builder reads `/data/db/.integrity-recovery.json` on first boot → sets a heartbeat health field + emits `node.error` (both-profile parity, `osi-flows-json-editing` change control). Not built here; the core integrity check ships independently, and the stamp is already written for that slice to consume.

- [ ] **Step 3.3: Record the #56 coupling** (spec §F) in the PR body: 5.1 = local durability tier; #56 = remote (cloud) tier; 5.1's verified opportunistic backup is #56's upload artifact; no scope merge, no dependency.

- [ ] **Step 3.4: Push + open PR (do not merge)**

```bash
git push -u origin feat/51-boot-db-integrity
gh pr create --title "feat(durability): boot-time DB integrity check + quarantine/restore (5.1)" \
  --body "Refactor-program 5.1 (DD18), couples #56. Out-of-process init.d (START=90) runs quick_check before Node-RED; corrupt DB quarantined (never deleted) + restored from newest passing local backup; loud stamp + heartbeat/node.error on recovery; no fabrication when no good backup. Paired heartbeat-flag flows slice noted separately. Do not merge without review." --draft
```

---

## Verification checklist (before marking done)

- [ ] `quick_check` gate runs OUT-OF-PROCESS via init.d at START=90 (< node-red/osi-bootstrap's 99); `sync-init-fn` untouched.
- [ ] Corrupt DB → quarantined to `.corrupt-<stamp>` (with `-wal`/`-shm`), NEVER deleted; restored from newest passing `.bak-*`; stamp written.
- [ ] Skip-to-older-passing-backup branch works; no-good-backup → `unrecoverable`, no fabrication, loud stamp + non-zero.
- [ ] Healthy boot → opportunistic keep-5 backup, skipped when recent; missing DB → clean no-op.
- [ ] `node --test scripts/boot-db-integrity-check.test.js` green; wired into `migrations.yml`.
- [ ] init.d byte-identical on bcm2709 + bcm2712; ships to the two profiles that carry init.d.
- [ ] Paired heartbeat/`node.error` flows slice + #56 coupling noted in PR body; not built inside the check.
- [ ] Zero live-gateway/SSH; PR open, not merged.
