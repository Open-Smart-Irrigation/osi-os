# Safe Branch Integration Plan — osi-server + osi-os

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely merge all complete feature and hardening branches into `main` in both `osi-server` and `osi-os`, in the correct order, with conflict resolution documented for every known collision.

**Architecture:** osi-server merges first (server-side DB migrations run before edge deploys). For osi-os, `feature/osi-bootstrap-init` acts as the integration branch — all other osi-os fixes accumulate there before a single merge to main. Conflicts are deterministic and resolved in this plan.

**Tech Stack:** Git worktrees (already provisioned), Gradle (osi-server tests), Node.js `verify-sync-flow.js` (osi-os), SQLite3, OpenWrt uci-defaults.

---

## Context — Branch Status Summary

### osi-server (`/home/phil/Repos/osi-server`)
| Branch | Commits ahead of main | Merge notes |
|--------|----------------------|-------------|
| `feature/phase0-1a-code-hardening` | 12 | **Merges cleanly (confirmed dry-run)** |
| `feature/consolidated-refactor` | 15 | = phase0-1a + 2 merge-commits already in main + 1 branch-internal dedup fix; **skip — not needed** |
| `feature/native-terra-android` | 13 | Independent feature; **out of scope** |

### osi-os (`/home/phil/Repos/osi-os`)
| Branch | Commits ahead of main | Strategy |
|--------|----------------------|----------|
| `feature/osi-bootstrap-init` | 8 | **Integration base** — most current flows.json |
| `fix/ipv4-cloud-sync` | 2 | Conflicts on flows.json — cherry-pick module, apply wiring manually |
| `feature/phase0-1a-code-hardening` | 2 | Only touches `deploy.sh` and docs — cherry-pick |
| `feature/chameleon-swt-integration` | 19 | Conflicts on flows.json + farming.db — merge with resolution |
| `feature/lsn50-dendrometer-decoder-claude` | 12 | **Out of scope — parked** |
| `feature/farming-db-r-workflow` | 1 | **Out of scope — parked** |

### Known conflicts in osi-os
- **`flows.json`**: touched by ipv4-cloud-sync, osi-bootstrap-init, chameleon-swt. Resolution: keep osi-bootstrap-init's base (most current); apply other changes on top.
- **`farming.db`**: osi-bootstrap-init has clean seed schema (chameleon_readings ✓). Chameleon-swt's version may have demo data. **Always take osi-bootstrap-init's farming.db** when conflict appears.
- **`deploy.sh`**: osi-bootstrap-init updated the next-steps message; phase0-1a added mosquitto fix. Both changes are in different regions — expect no conflict after cherry-pick order.

---

## Part 1: osi-server — Merge phase0-1a Hardening

All commands run in `/home/phil/Repos/osi-server` unless noted.

### Task 1: Baseline tests pass on osi-server main

**Files:** none (verification only)

- [ ] **Step 1: Run tests on main**

```bash
cd /home/phil/Repos/osi-server
git checkout main
./gradlew test 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 2: If tests fail, stop**

Do not proceed if main is red. Investigate and fix before continuing.

---

### Task 2: Baseline tests pass on phase0-1a worktree

**Files:** `/home/phil/Repos/osi-server/.worktrees/phase0-1a-code-hardening/`

- [ ] **Step 1: Run tests in phase0-1a worktree**

```bash
cd /home/phil/Repos/osi-server/.worktrees/phase0-1a-code-hardening
./gradlew test 2>&1 | tail -20
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 2: If tests fail, stop**

Do not merge a red branch. Fix first.

---

### Task 3: Verify Flyway migration is additive

The branch adds `V2026_05_16_001__ensure_sync_inbox_event_uuid_unique.sql`. Flyway treats date-versioned names as later than `V41__*`, so no ordering conflict.

**Files:** `backend/src/main/resources/db/migration/`

- [ ] **Step 1: Confirm no filename collision**

```bash
cd /home/phil/Repos/osi-server
ls backend/src/main/resources/db/migration/ | grep "V2026"
```

Expected: no output (file only exists in phase0-1a worktree, not yet in main).

- [ ] **Step 2: Confirm migration content is idempotent**

```bash
cat /home/phil/Repos/osi-server/.worktrees/phase0-1a-code-hardening/backend/src/main/resources/db/migration/V2026_05_16_001__ensure_sync_inbox_event_uuid_unique.sql
```

Expect: `DO $$ BEGIN IF NOT EXISTS ... THEN ALTER TABLE sync_inbox ADD CONSTRAINT ...` — confirmed idempotent.

---

### Task 4: Merge phase0-1a into osi-server main

**Files:** all 20 files modified by phase0-1a (see context above)

- [ ] **Step 1: Confirm you are on main**

```bash
cd /home/phil/Repos/osi-server
git status --short --branch
```

Expected: `## main`

- [ ] **Step 2: Merge with a merge commit (no fast-forward)**

```bash
git merge --no-ff feature/phase0-1a-code-hardening -m "$(cat <<'EOF'
merge: phase0-1a-code-hardening — security, sync, and config hardening

- fix(security): rate-limit identity trusts only X-Forwarded-For from
  configured trusted proxies; native forward-headers-strategy in prod
- fix(security): remove IP leak header; fix test isolation in rate-limit filter
- fix(sync): replace unsafe ctid dedup; enforce sync_inbox(event_uuid) unique
- fix(device): SUPER_ADMIN included in canClaimGatewayDevices
- fix(config): AsyncConfig CallerRunsPolicy back-pressure on saturation
- fix(prediction): startup token validation; filesystem path security
- fix(integration): conservative SoilHive expires_in default (3000s)
- fix(build): add H2 test dependency to enable DataJpaTest
EOF
)"
```

Expected: `Merge made by the 'ort' strategy.`

If conflicts appear (unexpected): run `git merge --abort`, investigate, and resolve before retrying.

- [ ] **Step 3: Confirm merge commit present**

```bash
git log --oneline -3
```

Expected: top commit is the merge commit, followed by the previous main tip.

---

### Task 5: Run full test suite post-merge

**Files:** none (verification)

- [ ] **Step 1: Run tests**

```bash
cd /home/phil/Repos/osi-server
./gradlew test 2>&1 | tail -30
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 2: If tests fail, investigate**

Check which test class failed. If it's one of the newly added tests from phase0-1a, the issue is likely a test environment problem (H2 config, Spring context). Fix before pushing.

---

### Task 6: Push osi-server main

- [ ] **Step 1: Push**

```bash
cd /home/phil/Repos/osi-server
git push origin main
```

Expected: `main -> main`

- [ ] **Step 2: Deploy to VPS**

Follow the standard osi-server VPS deploy procedure (git pull on VPS + restart). The V2026_05_16_001 migration runs automatically on startup via Flyway — it is idempotent.

---

### Task 7: Remove stale osi-server worktrees

- [ ] **Step 1: Remove phase0-1a worktree**

```bash
cd /home/phil/Repos/osi-server
git worktree remove .worktrees/phase0-1a-code-hardening
git branch -d feature/phase0-1a-code-hardening
```

- [ ] **Step 2: Remove consolidated-refactor worktree**

```bash
git worktree remove .worktrees/consolidated-refactor
git branch -d feature/consolidated-refactor
```

- [ ] **Step 3: Confirm**

```bash
git worktree list
```

Expected: only `main` and `native-terra-android` worktrees remain.

---

## Part 2: osi-os — Integration onto osi-bootstrap-init

All commands run in `/home/phil/Repos/osi-os` on branch `feature/osi-bootstrap-init` unless noted.

The strategy: accumulate all fixes onto `feature/osi-bootstrap-init` (which already has the most current `flows.json` and a clean `farming.db`), then merge once to main.

### Task 8: Cherry-pick mosquitto fix from phase0-1a

`feature/phase0-1a-code-hardening` commit `368cac37` adds a mosquitto ownership fix to `deploy.sh`. It does not touch `flows.json`.

**Files:**
- Modify: `deploy.sh`

- [ ] **Step 1: Confirm you are on osi-bootstrap-init**

```bash
cd /home/phil/Repos/osi-os
git status --short --branch
```

Expected: `## feature/osi-bootstrap-init`

- [ ] **Step 2: Cherry-pick the mosquitto fix**

```bash
git cherry-pick 368cac37
```

Expected: clean apply. If conflict in `deploy.sh`, open the file, keep both sets of changes (mosquitto fix + osi-bootstrap-init's next-steps update — they are in different regions of the file), then `git add deploy.sh && git cherry-pick --continue`.

- [ ] **Step 3: Cherry-pick the contract docs commit**

```bash
git cherry-pick a1c82c07
```

Expected: clean apply (only touches `docs/contracts/sync-schema/canonicalization.md`).

- [ ] **Step 4: Verify**

```bash
git log --oneline -3
```

Expected: two new cherry-pick commits on top of osi-bootstrap-init.

---

### Task 9: Apply ipv4-cloud-sync osi-cloud-http module

`fix/ipv4-cloud-sync` introduces a new `osi-cloud-http` Node.js module that forces IPv4 for all cloud REST calls. The `flows.json` change wires this module in. We cherry-pick the module files, then manually apply the `flows.json` wiring.

**Files:**
- Cherry-pick: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/index.js`
- Cherry-pick: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/package.json`
- Cherry-pick: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json` (adds osi-cloud-http dependency)
- Cherry-pick: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json`
- Manual: `flows.json` (apply wiring diff on top of current version)

- [ ] **Step 1: Inspect the two commits in fix/ipv4-cloud-sync**

```bash
git log fix/ipv4-cloud-sync --oneline
```

Note the two SHAs (call them SHA_HELPER and SHA_WIRE).

- [ ] **Step 2: Cherry-pick the helper module commit (SHA_HELPER)**

```bash
git cherry-pick 9577d804
```

If `flows.json` conflicts:

```bash
# Keep ours (osi-bootstrap-init) for flows.json, accept theirs for the module files
git checkout --ours conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git checkout --theirs conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/index.js
git checkout --theirs conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/package.json
git add -A
git cherry-pick --continue -m ""
```

- [ ] **Step 3: Cherry-pick the wiring commit (SHA_WIRE)**

```bash
git cherry-pick ae18a563
```

If `flows.json` conflicts, use the same resolution: keep ours for `flows.json`, then manually inspect what the wire commit actually changed in `flows.json` and apply just that change:

```bash
# See what flows.json change the wire commit intended
git show ae18a563 -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json | head -60
```

Apply the node wiring shown in the diff to the current `flows.json`. The change typically adds an `osi-cloud-http` require reference inside the cloud sync function nodes. Then:

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git cherry-pick --continue -m ""
```

- [ ] **Step 4: Run verify-sync-flow.js**

```bash
node scripts/verify-sync-flow.js 2>&1 | tail -5
```

Expected: `Sync flow verification passed`

- [ ] **Step 5: Commit if verify passes**

```bash
git log --oneline -4
```

---

### Task 10: Merge chameleon-swt-integration into osi-bootstrap-init

`feature/chameleon-swt-integration` (19 commits) adds the Chameleon SWT sensor integration. It conflicts on `flows.json` and `farming.db`.

**Files:**
- Conflict: `conf/.../usr/share/flows.json` → take theirs (chameleon) as base; verify osi-bootstrap-init changes are preserved
- Conflict: `conf/.../usr/share/db/farming.db` → **take ours** (osi-bootstrap-init — clean seed schema)
- Conflict: `conf/.../base_raspberrypi_bcm27xx_bcm2712/.../farming.db` → **take ours**
- Conflict: `conf/.../full_raspberrypi_bcm27xx_bcm2708/.../farming.db` → **take ours**
- Conflict: `conf/.../full_raspberrypi_bcm27xx_bcm2709/.../farming.db` → **take ours**
- Conflict: `database/farming.db` → **take ours**
- New files: `osi-chameleon-helper/index.js`, `osi-chameleon-helper/package.json`, scripts, React components → **take theirs** (no conflict)

- [ ] **Step 1: Attempt merge**

```bash
cd /home/phil/Repos/osi-os
git merge --no-ff feature/chameleon-swt-integration
```

Expected: conflicts on `flows.json` and `farming.db` files.

- [ ] **Step 2: Resolve farming.db conflicts — take ours**

```bash
# For every farming.db conflict: take osi-bootstrap-init's version
git checkout --ours conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
git checkout --ours conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db 2>/dev/null || true
git checkout --ours conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db 2>/dev/null || true
git checkout --ours conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db 2>/dev/null || true
git checkout --ours database/farming.db
git checkout --ours web/react-gui/farming.db 2>/dev/null || true
```

Rationale: osi-bootstrap-init's `farming.db` was built from `database/seed-blank.sql` which already includes `chameleon_readings` and all WS2/WS3 tables. Chameleon-swt's `farming.db` may have demo data. Our version is canonical.

- [ ] **Step 3: Resolve flows.json conflict**

`flows.json` is a large JSON file. The conflict will be a text merge. Open it:

```bash
# Check what sections are in conflict
grep -c "<<<<<<" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
```

The chameleon-swt integration adds new nodes for chameleon ingest. The osi-bootstrap-init changes added the bootstrap/version bump changes. Both sets of changes need to be in the final version.

Best approach — use a three-way merge understanding:

```bash
# Inspect the conflict markers and manually combine
# Look for: <<<< HEAD (our changes) vs ==== vs >>>> chameleon-swt-integration (their new nodes)
# Goal: keep ALL nodes from both sides, no duplicates
```

After editing to resolve all conflict markers:

```bash
# Validate the result is valid JSON
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8')); console.log('valid JSON')"
```

Expected: `valid JSON`

- [ ] **Step 4: Stage all resolved files**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
git add database/farming.db
git add web/react-gui/farming.db 2>/dev/null || true
# Stage any remaining conflicted files
git status --short | grep "^UU\|^AA\|^DD" | awk '{print $2}' | xargs git add 2>/dev/null || true
```

- [ ] **Step 5: Complete the merge commit**

```bash
git merge --continue -m "merge: feature/chameleon-swt-integration into osi-bootstrap-init

Chameleon SWT sensor integration deployed and verified on kaba100.
Resolved:
  - flows.json: preserved osi-bootstrap-init base + chameleon ingest nodes
  - farming.db: kept osi-bootstrap-init clean seed (chameleon_readings already present)"
```

---

### Task 11: Run full osi-os verification suite

**Files:** none (verification only)

- [ ] **Step 1: verify-sync-flow.js**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js 2>&1 | tail -10
```

Expected: `Sync flow verification passed`

- [ ] **Step 2: validate flows.json is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8')); console.log('flows.json: valid JSON')"
```

- [ ] **Step 3: check farming.db integrity**

```bash
sqlite3 database/farming.db "PRAGMA integrity_check;" | grep -qx "ok" && echo "farming.db OK"
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db "PRAGMA integrity_check;" | grep -qx "ok" && echo "seed farming.db OK"
```

- [ ] **Step 4: verify chameleon_readings present in seed**

```bash
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  "SELECT name FROM sqlite_master WHERE type='table' AND name='chameleon_readings';"
```

Expected: `chameleon_readings`

- [ ] **Step 5: If any check fails, stop and investigate**

---

### Task 12: Merge osi-bootstrap-init into main

**Files:** all files accumulated in osi-bootstrap-init

- [ ] **Step 1: Switch to main**

```bash
cd /home/phil/Repos/osi-os
git checkout main
```

- [ ] **Step 2: Dry-run check**

```bash
git merge --no-commit --no-ff feature/osi-bootstrap-init
git merge --abort
```

Expected: `Automatic merge went well; stopped before committing as requested`

If conflicts appear: stop, investigate, and resolve on `feature/osi-bootstrap-init` first before retrying.

- [ ] **Step 3: Merge**

```bash
git merge --no-ff feature/osi-bootstrap-init -m "$(cat <<'EOF'
merge: feature/osi-bootstrap-init — OSI OS 0.6.5, auto-provision, and branch integration

- feat: OSI OS 0.6.5 with osi-bootstrap init (START=99) for first-boot ChirpStack provisioning
- feat: clean seed DB (seed-blank.sql, 29 tables, no demo data)
- feat: 97_osi_db_seed uci-default; 96_osi_server_config CGOS 4.10.1 pre-create fix
- feat: install-osi-os.sh overlay install script
- fix(mosquitto): repair password/state file ownership on deploy
- fix: ipv4-cloud-sync osi-cloud-http module for reliable cloud REST over IPv4
- merge: chameleon-swt-integration (deployed and verified on kaba100)
- chore: exclude /tmp/ from git tracking
EOF
)"
```

- [ ] **Step 4: Run verify-sync-flow.js on main**

```bash
node scripts/verify-sync-flow.js 2>&1 | tail -5
```

Expected: `Sync flow verification passed`

- [ ] **Step 5: Commit is on main**

```bash
git log --oneline -3
```

---

### Task 13: Push osi-os main and deploy to 3 Pis

- [ ] **Step 1: Push main**

```bash
git push origin main
```

- [ ] **Step 2: Build React GUI**

```bash
cd web/react-gui && npm run build && cd ../..
```

- [ ] **Step 3: Package GUI artifact**

```bash
tar czf react_gui.tar.gz -C web/react-gui/dist .
```

- [ ] **Step 4: Deploy to each Pi via SSH reverse-tunnel**

For each Pi (`192.168.178.125` / Silvan / kaba100 / Uganda — use actual IPs/hostnames):

```bash
# Start local HTTP server in repo root
python3 -m http.server 9876 &
HTTP_PID=$!

# Deploy (repeat for each Pi)
ssh -R 9876:localhost:9876 root@<pi-ip> 'curl -fsS http://localhost:9876/deploy.sh | sh'

kill $HTTP_PID
```

Safety invariant: `deploy.sh` never overwrites `/data/db/farming.db` if it exists.

- [ ] **Step 5: Restart Node-RED on each Pi**

```bash
ssh root@<pi-ip> '/etc/init.d/node-red restart'
```

- [ ] **Step 6: Verify firmware_version**

```bash
ssh root@<pi-ip> 'uci get osi-server.cloud.firmware_version'
```

Expected: `0.6.5`

---

### Task 14: Remove stale osi-os worktrees

- [ ] **Step 1: Remove merged worktrees**

```bash
cd /home/phil/Repos/osi-os
git worktree remove .worktrees/phase0-1a-code-hardening
git worktree remove .worktrees/ipv4-cloud-sync 2>/dev/null || git worktree remove .worktrees/ipv4-cloud-sync
git worktree remove .worktrees/chameleon-swt-integration
git worktree remove .worktrees/consolidated-refactor
git worktree remove .worktrees/osi-bootstrap-init 2>/dev/null || true  # if we switched to main
```

- [ ] **Step 2: Delete merged branches**

```bash
git branch -d feature/phase0-1a-code-hardening
git branch -d fix/ipv4-cloud-sync
git branch -d feature/chameleon-swt-integration
git branch -d feature/consolidated-refactor
git branch -d feature/osi-bootstrap-init
```

- [ ] **Step 3: Confirm remaining worktrees**

```bash
git worktree list
```

Expected: only `main` remains, plus any intentionally parked branches (`feature/lsn50-dendrometer-decoder-claude`, `feature/farming-db-r-workflow`).

---

## Out of Scope (parked branches — do not merge)

| Branch | Repo | Reason |
|--------|------|--------|
| `feature/lsn50-dendrometer-decoder-claude` | osi-os | 12 commits of decoder work, not yet reviewed for production |
| `feature/farming-db-r-workflow` | osi-os | Minor standalone feature, 1 commit, separate decision |
| `feature/native-terra-android` | osi-server | Independent Terra product, different release timeline |

---

## Self-Review

**Spec coverage:**
- osi-server phase0-1a (12 hardening commits): Tasks 1–7 ✓
- osi-os mosquitto fix: Task 8 ✓
- osi-os ipv4-cloud-sync: Task 9 ✓
- osi-os chameleon-swt: Task 10 ✓
- Verification after each: Tasks 11, 5 ✓
- Deployment: Tasks 6, 13 ✓
- Worktree cleanup: Tasks 7, 14 ✓

**Conflict resolution documented:**
- `flows.json`: Task 9 (cherry-pick resolution), Task 10 (merge resolution) ✓
- `farming.db`: Task 10 (take ours) ✓
- `deploy.sh`: Task 8 (different regions, expect clean) ✓

**Risk flags:**
- Task 9 Step 3 requires manual `flows.json` inspection if cherry-pick conflicts — do not auto-accept either side
- Task 10 `flows.json` merge is the highest-risk step — validate JSON after resolution before continuing
- Never overwrite `/data/db/farming.db` on live Pis; deploy.sh enforces this invariant
