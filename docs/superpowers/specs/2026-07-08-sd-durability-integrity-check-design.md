# SD durability — boot integrity check + quarantine / restore-from-local-backup

**Status:** Draft
**Refactor-program item:** 5.1 (DD18 "edge durability first-class"; the "Any / SD durability" scale-table row). **Couples issue #56** (lossless edge→cloud backup — see §F).
**Focus: osi-os edge.** No boot-node change (the integrity check runs OUT-OF-PROCESS, before Node-RED starts — never in the frozen `sync-init-fn`). No live gateway in this slice.
**Depends on:** nothing hard; reuses `lib/osi-migrate/backup.js`'s rotation precedent.

## Problem

The gateway's entire farm state lives in one SQLite file on an SD card (`/data/db/farming.db`) — the least reliable component in the system. SD cards corrupt on power loss mid-write (the field reality for solar/mains-flaky irrigation sites). Today there is **no boot-time integrity gate**: if the SD corrupts the DB, Node-RED starts against a corrupt file and either crash-loops (procd `respawn` masks it — a crash-looping gateway looks alive, ground-truth #9 / DD18) or, worse, runs against a subtly-corrupt DB and writes further bad state on top. A corrupt `farming.db` with no automated recovery path is a silent farm-data loss and a field-unrecoverable gateway.

There *is* a recovery asset: `lib/osi-migrate/backup.js` already takes online `.backup` copies with `integrity_check` verification and 5-deep rotation (`<db>.bak-<ISO-stamp>` siblings) — created before destructive migrations. What's missing is a **boot-time check that runs before Node-RED touches the DB**, quarantines a corrupt file (never deletes it — it's farm data), restores the newest passing local backup, and surfaces the event so the gateway cannot look healthy after silently swapping its DB.

## Verified ground truth

1. **Boot ordering (init.d, verified):** `osi-rootfs-resize` is `START=08` (USE_PROCD=0, runs before write-heavy services by design — its own comment says so), `redis` is `START=95`, `osi-bootstrap` is `START=99`, and **`node-red` (the OpenWrt feed package `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`) is `START=99`, `USE_PROCD=1`**. So a new integrity-check init.d at a START **below 99** runs before Node-RED and before osi-bootstrap. The check is out-of-process by construction — a standalone init.d `start()`, exactly the `osi-rootfs-resize` shape.
2. **The DB path is `/data/db/farming.db`** (verified in `deploy.sh`: `DB_DIR="/data/db"`, all embedded scripts use `/data/db/farming.db`). WAL sidecars (`-wal`, `-shm`) may exist under WAL journal mode (`backup.js` test uses `PRAGMA journal_mode=WAL`).
3. **`backup.js` precedent (verified):** `backupDb(dbPath, {keep=5})` runs `sqlite3 <db> ".backup <path>"` (online, WAL-consistent), then `sqlite3 <backup> "PRAGMA integrity_check;"` and throws unless the result is `ok`; `pruneBackups` keeps the newest 5 `<basename>.bak-<stamp>` siblings, per-file-resilient. ISO stamps sort lexically = chronologically. The restore path needs the **inverse**: find the newest `.bak-*` sibling that *passes* `integrity_check`, and copy it into place.
4. **`sync-init-fn` is FROZEN** (`osi-schema-change-control`) — the integrity check must NOT be added there. It runs in the init.d script, before Node-RED loads flows at all.
5. **`PRAGMA quick_check` vs `integrity_check`:** `quick_check` is the pre-ruled check (faster — skips the expensive index-vs-table cross-checks; catches the corruption classes that matter at boot: malformed pages, unreadable structure). `backup.js` uses the fuller `integrity_check` for post-backup verification. The 5.1 boot gate uses `quick_check` per the pre-ruling (boot-time speed); the restore-candidate verification can use `quick_check` too for consistency and speed.

## Design

### A. The boot integrity-check script (out-of-process, before Node-RED)

A new init.d service, e.g. `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-db-integrity`, modeled on `osi-rootfs-resize`:
- `START=90` (below node-red/osi-bootstrap's 99, above redis's 95? — **place it before redis too if redis reads the DB; redis here is a cache, not the farm DB, so START=90 before both 95 and 99 is safe and simplest**), `USE_PROCD=0`, a `start()` that runs the check and returns.
- The actual check logic lives in a **Node.js script** (e.g. `scripts/boot-db-integrity-check.js`, or an `osi-migrate`-adjacent module) invoked by the init.d `start()` — Node is already on the image (osi-bootstrap runs `node`), and the backup/restore logic reuses `backup.js`'s `sqliteDotQuote`/rotation helpers. The init.d is a thin shell wrapper (`node /path/to/check.js || logger -t osi-db-integrity "..."`); the testable logic is JS with `node --test` coverage (the repo's test idiom).
- **Refuse safely on a missing DB:** if `/data/db/farming.db` does not exist (fresh/unprovisioned gateway), the check is a clean no-op — do NOT create or restore anything (the deploy path owns first seeding; DD guardrail: never reseed a provisioned DB). Log and return 0.

### B. The check → quarantine → restore sequence

On `start()`:
1. **`PRAGMA quick_check`** against `/data/db/farming.db` (via the `cliRunner`/`sqlite3` CLI, the `backup.js` I/O style). Under WAL, `quick_check` reads through the WAL, so a clean WAL replay is validated too.
2. **If `quick_check` returns `ok`:** done — Node-RED starts normally. **Additionally, opportunistically take a fresh known-good backup here** (reusing `backupDb`, keep 5) so the pool of restore candidates always includes a recent passing copy — this is the cheap durability win: every clean boot refreshes the safety net. (Guard: only if a backup isn't already recent, to avoid churning the SD on every reboot — e.g. skip if the newest `.bak-*` is < 24 h old.)
3. **If `quick_check` fails (corrupt):**
   a. **Quarantine, never delete.** Move the corrupt DB (and its `-wal`/`-shm` sidecars) aside to a timestamped name: `/data/db/farming.db.corrupt-<ISO-stamp>`. **NEVER auto-delete the quarantined bad DB** (pre-ruled — it's farm data; an operator may forensically recover rows from it). Quarantined corrupt files are NOT part of the `.bak-*` rotation and are never pruned by this tool.
   b. **Restore the newest passing local backup.** Walk `<db>.bak-*` siblings newest-first (lexical-descending ISO stamps); for each, run `quick_check`; the first that passes is copied to `/data/db/farming.db`. Log which backup was restored and its age.
   c. **If no passing backup exists** (all `.bak-*` fail or none exist): do NOT fabricate a DB. Leave the DB absent (corrupt file already quarantined), write a loud persistent flag (§D), and let the deploy/seed path or an operator recover. **A gateway with a corrupt DB and no good backup must fail visibly, not boot against garbage** — this is the honest failure the whole item exists to make loud rather than silent.
4. Return; init.d completes; Node-RED (`START=99`) starts against either the healthy original, a restored backup, or (recovery-needed) an absent DB it will refuse/seed per deploy rules.

### C. Backup rotation policy

- Reuse `backup.js`'s **keep-5** rotation for the `.bak-*` pool (pre-ruled: "local backup rotation follows `lib/osi-migrate/backup.js` precedent (keep 5)"). The opportunistic clean-boot backup (§B.2) feeds this pool; the pool is what §B.3.b restores from.
- **Quarantined `.corrupt-*` files are separate and NEVER auto-pruned** (§B.3.a) — bounded only by SD space and operator cleanup. Rationale: a corrupt farm DB is potentially recoverable data; auto-deleting it to save space would be the exact silent-data-loss this item prevents. If SD-full becomes a real pressure (5.2's SD-full scenario), the operator decides — the tool does not.

### D. Surfacing — heartbeat flag + node.error on first boot

The recovery event must be visible; a gateway that silently swapped its DB must not look untouched:
- **Persistent local flag:** on quarantine/restore (or on the no-good-backup failure), write a stamp file (e.g. `/data/db/.integrity-recovery.json` with `{event, at, restoredFrom, quarantinedTo, quickCheckError}`). Persistent so the state survives the reboot and Node-RED can read it on first boot.
- **Heartbeat flag:** Node-RED, on first boot after a recovery, reads the stamp and sets a heartbeat health field (the DD18 / crash-loop-escalation pattern — a distinct health state the cloud/operator sees, not a silent OK). This is the same "gateway cannot look alive when it isn't" principle as 1.A4. The exact heartbeat field wiring is a small flows read of the stamp — **noted as the flows-side counterpart** (the `osi-health-helper` heartbeat builder), consistent with how other health flags surface; the integrity check itself (init.d + JS) does not touch flows.
- **`node.error` on first boot:** the same first-boot flows read emits a `node.error` so the event lands in the Node-RED log/debug and any error-count surface — one clear, greppable line naming the recovery. (Pre-ruled: "heartbeat flag + node.error on first boot".)

### E. Testing

- **`node --test` for the check/restore JS** (the repo idiom, like `backup.test.js`): construct a temp dir with a DB;
  - healthy DB → `quick_check` ok → no quarantine, opportunistic backup taken (and skipped if recent);
  - deliberately-corrupted DB (truncate/scribble a page) + a passing `.bak-*` → asserts quarantine to `.corrupt-*`, restore from the newest passing backup, stamp written;
  - corrupt DB + multiple `.bak-*` where the newest is ALSO corrupt → asserts it skips to the next-newest passing one;
  - corrupt DB + NO passing backup → asserts no fabrication, DB left absent, loud stamp written, non-zero signal;
  - missing DB (fresh gateway) → clean no-op, nothing created.
- **init.d placement** is verified by the START-number ordering (< 99) — a doc/test assertion that the script's `START` is below node-red's, not a runtime test (init.d ordering isn't unit-testable without the image).
- **No live gateway, no SSH.** All synthetic temp-dir DBs. The on-device rehearsal (corrupt a copy, reboot a throwaway instance) is a 5.2 chaos-rig scenario (SD durability is one of its scenarios) / an operator step, not this item's CI.

### F. Coupling with issue #56 (lossless edge→cloud backup)

Issue #56 is about a **lossless edge→cloud backup** — getting farm state safely to the cloud, not just to a local SD sibling. 5.1's local `.bak-*` pool + quarantine is the **local** durability tier; #56 is the **remote** tier. They couple, honestly:
- 5.1's opportunistic clean-boot backup (§B.2) is the natural artifact #56 would ship to the cloud (a verified-good `.backup` copy). This spec does **not** implement the upload (that's #56's scope) but shapes the local backup so #56 can consume it: a verified-`quick_check`-passing `<db>.bak-<stamp>` file with a known location and rotation.
- **Boundary:** 5.1 delivers the local integrity gate + local restore. #56 delivers the cloud upload/restore. 5.1 does not depend on #56 (local recovery works offline — the offline-first invariant); #56 builds on 5.1's verified-backup artifact. Note the coupling; don't merge the scopes.

## Non-goals

- **Any boot-node (`sync-init-fn`) change** — the check is out-of-process, init.d + JS, before Node-RED. Explicitly forbidden per the pre-ruling and change-control.
- **Auto-deleting the quarantined corrupt DB** — never (pre-ruled; farm data).
- **Cloud upload / #56's remote tier** — coupled, scoped separately (§F).
- **Fabricating a DB when no good backup exists** — fail loud, don't invent (§B.3.c).
- **A/B rootfs OTA or filesystem-level SD redundancy** — YAGNI at this scale (program map); payload/DB durability is where the risk lives.
- **The heartbeat/`node.error` flows wiring beyond noting it** — the init.d + JS is this item's core; the first-boot stamp-read that sets the heartbeat flag is a small paired flows counterpart (§D), landed with the durable check but scoped as the flows-side note, not the integrity logic.
- **Live-gateway rehearsal** — a 5.2 chaos-rig scenario / operator step.

## Definition of Done

- New init.d `osi-db-integrity` (START < 99, USE_PROCD=0, `osi-rootfs-resize` shape) invoking a testable Node script.
- `scripts/boot-db-integrity-check.js` (or osi-migrate-adjacent module): `quick_check` gate → quarantine-to-`.corrupt-<stamp>` (sidecars too, never deleted) → restore newest passing `.bak-*` → opportunistic clean-boot backup (keep-5, skip-if-recent) → persistent recovery stamp; clean no-op on missing DB; loud fail (no fabrication) on no-good-backup.
- Reuses `backup.js`'s `.backup`/`integrity_check`/rotation helpers (`keep=5`).
- `node --test` coverage for all §E branches (healthy, corrupt+restore, corrupt+skip-to-older, corrupt+no-backup, missing).
- The paired first-boot flows counterpart (§D: read stamp → heartbeat flag + `node.error`) noted as a coupled slice under `osi-flows-json-editing` (both-profile parity), not built inside the integrity check.
- Both-profile parity for the init.d file (bcm2712 + bcm2709 mirror) if the init.d ships in `conf/` (verify which profiles ship init.d).
- Issue #56 coupling recorded (§F): 5.1 = local tier, #56 = remote tier, 5.1's verified backup is #56's artifact.
- No `sync-init-fn` change; no live gateway; no auto-delete of quarantined data.
- "Open decisions" shows none outstanding.

## Open decisions

None outstanding.

- Check runs out-of-process before Node-RED: **new init.d at START < 99 (node-red/osi-bootstrap are both 99), USE_PROCD=0, `osi-rootfs-resize` shape**, decided in §A — verified boot ordering; never in the frozen boot node.
- `quick_check` not `integrity_check` at boot: **`quick_check`** (pre-ruled, boot-time speed), decided in §B — `integrity_check` stays for `backup.js`'s post-backup verification.
- Quarantine never deletes: **move to `.corrupt-<stamp>`, sidecars included, never pruned**, decided in §B/§C — pre-ruled; farm data.
- Restore source: **newest passing `.bak-*` (quick_check each, newest-first), keep-5 pool fed by opportunistic clean-boot backups**, decided in §B/§C — reuses `backup.js` rotation.
- No-good-backup: **fail loud (stamp + heartbeat + node.error), do not fabricate**, decided in §B.3.c — the honest visible failure the item exists to create.
- #56 coupling: **5.1 local tier, #56 remote tier, shared verified-backup artifact, no scope merge, no dependency**, decided in §F.
