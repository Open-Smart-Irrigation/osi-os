# Uganda Safe Repair And Current Codebase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely migrate the Uganda Pi to the current committed `osi-os` codebase, restore canonical Kiwi device-data mirroring to cloud, and leave a clean rollback path if any step regresses sync or local operation.

**Architecture:** Treat Uganda as a live edge node with operational data in `/data/db/farming.db`, so the migration must preserve the DB and repair runtime drift around Node-RED flows, helper packages, and trigger installation. Use a backup-first, compare-before-write rollout, then verify the end-to-end data-plane path from local `device_data` inserts to `sync_outbox`, `/api/sync/state`, and cloud freshness for Kiwi 1–3.

**Tech Stack:** OpenWrt shell, Node-RED, SQLite, Tailscale SSH, local `osi-os` repo artifacts, REST sync endpoints, `deploy.sh`, `sha256sum`, `sqlite3`, `curl`

---

## File Map

- Modify: `deploy.sh`
  Make the live migration path explicit for helper package/runtime sync if the current rollout shows a packaging gap.
- Reference: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
  Canonical Node-RED backend flow; current repo contains the sync-state diagnostics and trigger-install logic that Uganda should run.
- Reference: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js`
  Canonical ChirpStack helper package; live Uganda hash currently differs from repo.
- Reference: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh`
  Already matches Uganda; used as a control file during migration verification.
- Reference: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`
  Already matches Uganda; used as a control file during migration verification.
- Reference: `scripts/verify-sync-flow.js`
  Static verification for the committed flow and packaged runtime dependencies.
- Create: `docs/superpowers/plans/2026-04-19-uganda-safe-repair-current-codebase-migration.md`
  This plan document.

### Live Paths Touched During Migration

- `/data/db/`
- `/srv/node-red/flows.json`
- `/srv/node-red/settings.js`
- `/srv/node-red/osi-chirpstack-helper/`
- `/srv/node-red/node_modules/`
- `/usr/share/node-red/osi-chirpstack-helper/index.js`
- `/usr/share/node-red/codecs/dragino_lsn50_decoder.js`
- `/etc/init.d/node-red`
- `/usr/libexec/osi-gateway-identity.sh`
- `/usr/lib/node-red/gui/`

### Known Live Facts This Plan Must Respect

- Uganda machine health is currently good: low load, ample RAM, low disk usage.
- Uganda runtime identity and linked auth are healthy.
- Uganda local device ingest is healthy: fresh `device_data` still lands for Kiwi 1–3.
- Uganda cloud freshness is broken because canonical `DEVICE_DATA` sync events stopped after `2026-04-18T20:53:43.721Z`.
- On Uganda, `device_data` currently has only the `sync_dendro_to_readings` trigger, not the expected `trg_dp_device_data_outbox_ai` path.
- Uganda is deployment-drifted: live `flows.json` and live `osi-chirpstack-helper/index.js` do not match the repo commit, while `osi-gateway-identity.sh` and `node-red.init` do match.
- The live hostname `chirpstack-8d5f67` is stale residue and should be treated as non-blocking cleanup, not part of the sync repair critical path.

### Acceptance Criteria

- Uganda local `device_data` keeps updating for Kiwi 1–3 during and after rollout.
- Uganda SQLite has a working `device_data` outbox trigger after migration.
- A fresh Kiwi uplink creates a fresh `DEVICE_DATA_APPENDED` row in `sync_outbox`.
- `/api/sync/state` shows a fresh `lastMirroredEventAt` and non-null `lastOutboxDeliverySuccessAt`.
- Cloud freshness for Kiwi 1–3 advances to current local timestamps.
- No DB replacement occurs and no user/device/zone rows are lost.

### Rollback Rule

- If Node-RED fails to restart cleanly, `/api/sync/state` regresses, or no new `DEVICE_DATA_APPENDED` events appear after a fresh Kiwi uplink, stop and restore from the timestamped backup before attempting any broader edits.

## Task 1: Freeze Evidence And Take A Full Backup

**Files:**
- Modify: none
- Test: live Pi state only

- [ ] **Step 1: Create a timestamped Uganda backup on the Pi**

Run from `/home/phil/Repos/osi-os`:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 "
set -eu
backup_dir=/data/db/backups/osi-os-${ts}-uganda-current-codebase-migration
mkdir -p \"\$backup_dir\"
cp -a /data/db \"\$backup_dir/\"
cp -a /srv/node-red \"\$backup_dir/\"
cp -a /usr/lib/node-red/gui \"\$backup_dir/gui\"
cp -a /etc/init.d/node-red \"\$backup_dir/node-red.init\"
cp -a /usr/libexec/osi-gateway-identity.sh \"\$backup_dir/osi-gateway-identity.sh\"
cp -a /usr/share/node-red/osi-chirpstack-helper \"\$backup_dir/osi-chirpstack-helper\"
cp -a /srv/node-red/flows.json \"\$backup_dir/flows.json\"
cp -a /srv/node-red/settings.js \"\$backup_dir/settings.js\"
printf '%s\n' \"\$backup_dir\"
"
rm -f "$tmp"
```

Expected: prints a new `/data/db/backups/osi-os-<timestamp>-uganda-current-codebase-migration` path.

- [ ] **Step 2: Capture pre-repair evidence bundle**

Run:

```bash
mkdir -p /tmp/uganda-evidence
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 '
set -eu
date -u +%FT%TZ
cat /proc/sys/kernel/hostname
uptime
df -h / /data || df -h /
free -m
sha256sum /srv/node-red/flows.json /usr/libexec/osi-gateway-identity.sh /etc/init.d/node-red /usr/share/node-red/osi-chirpstack-helper/index.js
sqlite3 -header -column /data/db/farming.db "PRAGMA integrity_check;"
sqlite3 -header -column /data/db/farming.db "SELECT name FROM sqlite_master WHERE type='\''trigger'\'' AND tbl_name='\''device_data'\'' ORDER BY name;"
sqlite3 -header -column /data/db/farming.db "SELECT MAX(recorded_at) AS latest_local_device_data FROM device_data;"
sqlite3 -header -column /data/db/farming.db "SELECT MAX(occurred_at) AS latest_outbox_event, MAX(delivered_at) AS latest_outbox_delivery FROM sync_outbox WHERE aggregate_type='\''DEVICE_DATA'\'';"
sqlite3 -header -column /data/db/farming.db "SELECT d.name, d.deveui, latest.recorded_at AS latest_recorded_at FROM devices d LEFT JOIN (SELECT deveui, MAX(recorded_at) AS recorded_at FROM device_data GROUP BY deveui) latest ON latest.deveui = d.deveui WHERE d.name IN ('\''Kiwi 1'\'','\''Kiwi 2'\'','\''Kiwi 3'\'') ORDER BY d.name;"
' > /tmp/uganda-evidence/pre-repair.txt
rm -f "$tmp"
```

Expected: `/tmp/uganda-evidence/pre-repair.txt` exists locally with the current evidence snapshot.

- [ ] **Step 3: Capture local sync-state before touching the Pi**

Run:

```bash
token=$(curl -sS -X POST 'http://100.69.51.98:1880/auth/login' \
  -H 'Content-Type: application/json' \
  --data '{"username":"Kaweza","password":"kaweza@123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')
curl -sS 'http://100.69.51.98:1880/api/sync/state' \
  -H "Authorization: Bearer $token" \
  | python3 -m json.tool > /tmp/uganda-evidence/pre-repair-sync-state.json
```

Expected: JSON includes healthy identity/auth fields but stale data-plane fields such as `lastMirroredEventAt` or `lastOutboxDeliverySuccessAt`.

- [ ] **Step 4: Commit the evidence bundle to the operator log, not git**

Run:

```bash
ls -lh /tmp/uganda-evidence
```

Expected: only local operator evidence files are present; nothing new is added to git.

## Task 2: Prepare The Current Codebase Artifact Set

**Files:**
- Modify: none
- Test: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Verify the committed repo state before staging artifacts**

Run:

```bash
git status --short --branch
node scripts/verify-sync-flow.js
```

Expected:

```text
## main...origin/main [ahead 1]
Sync flow verification passed
```

- [ ] **Step 2: Record the repo hashes that Uganda must match**

Run:

```bash
sha256sum \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh \
  feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js \
  > /tmp/uganda-evidence/repo-hashes.txt
cat /tmp/uganda-evidence/repo-hashes.txt
```

Expected: the repo hash file contains the canonical local checksums to compare against the Pi after rollout.

- [ ] **Step 3: Build the frontend bundle only if the GUI changed in the target release**

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run build
```

Expected: build completes successfully. Skip redeploying `/usr/lib/node-red/gui` later if no GUI files are part of the repair scope.

- [ ] **Step 4: Decide the minimal artifact set for Uganda**

Use this exact live drift matrix:

```text
Must update:
- /srv/node-red/flows.json
- /usr/share/node-red/osi-chirpstack-helper/index.js
- /srv/node-red/osi-chirpstack-helper/ (package sync if different)
- /srv/node-red/node_modules/ (only if helper dependency resolution is broken)

Already matching but safe to reapply:
- /usr/libexec/osi-gateway-identity.sh
- /etc/init.d/node-red

Only update if the release requires them:
- /srv/node-red/settings.js
- /usr/share/node-red/codecs/dragino_lsn50_decoder.js
- /usr/lib/node-red/gui/
```

Expected: the rollout remains narrow and does not widen into a full image reprovision.

## Task 3: Dry-Run The Migration Procedure Against The Live Drift

**Files:**
- Modify: none
- Test: live Pi compare only

- [ ] **Step 1: Compare live hashes against the repo one more time right before rollout**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 \
  'sha256sum /srv/node-red/flows.json /usr/libexec/osi-gateway-identity.sh /etc/init.d/node-red /usr/share/node-red/osi-chirpstack-helper/index.js' \
  > /tmp/uganda-evidence/live-hashes-pre-rollout.txt
rm -f "$tmp"
cat /tmp/uganda-evidence/live-hashes-pre-rollout.txt
```

Expected: `flows.json` and helper index still differ, while identity helper and init still match.

- [ ] **Step 2: Confirm the missing trigger before rollout**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 \
  "sqlite3 -header -column /data/db/farming.db \"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='device_data' ORDER BY name;\""
rm -f "$tmp"
```

Expected: output lists `sync_dendro_to_readings` only, proving the exact repair target is still present.

- [ ] **Step 3: Confirm there is no pending outbox backlog that would be invalidated by restart**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 \
  "sqlite3 -header -column /data/db/farming.db \"SELECT COUNT(*) AS pending_outbox FROM sync_outbox WHERE delivered_at IS NULL;\""
rm -f "$tmp"
```

Expected: `pending_outbox = 0`.

## Task 4: Migrate Uganda To The Current Codebase Safely

**Files:**
- Modify: live Pi files only
- Test: live Pi runtime and DB trigger state

- [ ] **Step 1: Stop only Node-RED**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 '/etc/init.d/node-red stop'
rm -f "$tmp"
```

Expected: Node-RED stops; `mosquitto`, `chirpstack-concentratord`, and the DB remain untouched.

- [ ] **Step 2: Copy only the current committed runtime artifacts to Uganda**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
export DISPLAY=:0
export SSH_ASKPASS="$tmp"
export SSH_ASKPASS_REQUIRE=force
for src dst in \
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:/srv/node-red/flows.json" \
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-gateway-identity.sh:/usr/libexec/osi-gateway-identity.sh" \
  "feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init:/etc/init.d/node-red" \
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js:/usr/share/node-red/osi-chirpstack-helper/index.js" \
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/package.json:/usr/share/node-red/osi-chirpstack-helper/package.json" \
  "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/dragino_lsn50_decoder.js:/usr/share/node-red/codecs/dragino_lsn50_decoder.js"
do
  src_path="${src%%:*}"
  dst_path="${src#*:}"
  setsid scp \
    -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    "$src_path" "root@100.69.51.98:$dst_path"
done
rm -f "$tmp"
```

Expected: only the intended runtime files are replaced; `/data/db/farming.db` is not copied or modified.

- [ ] **Step 3: Realign the Node-RED helper package in the runtime tree**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 "
set -eu
mkdir -p /srv/node-red/osi-chirpstack-helper
cp -a /usr/share/node-red/osi-chirpstack-helper/. /srv/node-red/osi-chirpstack-helper/
if [ -d /srv/node-red/node_modules/osi-chirpstack-helper ]; then
  rm -rf /srv/node-red/node_modules/osi-chirpstack-helper
fi
"
rm -f "$tmp"
```

Expected: the runtime helper source is aligned under `/srv/node-red/osi-chirpstack-helper`, and any stale installed copy that could shadow it is removed.

- [ ] **Step 4: Start Node-RED and let sync-init rerun**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 '/etc/init.d/node-red start && sleep 20 && /etc/init.d/node-red status'
rm -f "$tmp"
```

Expected: `running`.

- [ ] **Step 5: If Node-RED does not start cleanly, restore immediately**

Run only if Step 4 fails:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 "
set -eu
backup_dir=$(ls -1dt /data/db/backups/osi-os-*-uganda-current-codebase-migration | head -n1)
cp -a \"\$backup_dir/flows.json\" /srv/node-red/flows.json
cp -a \"\$backup_dir/settings.js\" /srv/node-red/settings.js
cp -a \"\$backup_dir/node-red.init\" /etc/init.d/node-red
cp -a \"\$backup_dir/osi-gateway-identity.sh\" /usr/libexec/osi-gateway-identity.sh
rm -rf /srv/node-red/osi-chirpstack-helper
cp -a \"\$backup_dir/osi-chirpstack-helper\" /srv/node-red/osi-chirpstack-helper
/etc/init.d/node-red start
"
rm -f "$tmp"
```

Expected: Uganda is restored to its pre-rollout runtime state before any further debugging.

## Task 5: Verify Trigger Repair And End-To-End Mirroring

**Files:**
- Modify: none
- Test: live Pi DB and cloud freshness

- [ ] **Step 1: Verify live hashes after rollout**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 \
  'sha256sum /srv/node-red/flows.json /usr/libexec/osi-gateway-identity.sh /etc/init.d/node-red /usr/share/node-red/osi-chirpstack-helper/index.js'
rm -f "$tmp"
```

Expected: the four live hashes now match the repo hash file from `/tmp/uganda-evidence/repo-hashes.txt`.

- [ ] **Step 2: Verify the `device_data` outbox trigger exists**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 \
  "sqlite3 -header -column /data/db/farming.db \"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='device_data' ORDER BY name;\""
rm -f "$tmp"
```

Expected:

```text
sync_dendro_to_readings
trg_dp_device_data_outbox_ai
```

- [ ] **Step 3: Verify `/api/sync/state` is still healthy after restart**

Run:

```bash
token=$(curl -sS -X POST 'http://100.69.51.98:1880/auth/login' \
  -H 'Content-Type: application/json' \
  --data '{"username":"Kaweza","password":"kaweza@123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')
curl -sS 'http://100.69.51.98:1880/api/sync/state' \
  -H "Authorization: Bearer $token" \
  | python3 -m json.tool
```

Expected: identity and linked-auth fields remain healthy; no new `lastError` appears.

- [ ] **Step 4: Wait for a fresh Kiwi uplink and confirm outbox creation**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 "
set -eu
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sqlite3 -header -column /data/db/farming.db \"SELECT MAX(recorded_at) AS latest_local_device_data FROM device_data; SELECT MAX(occurred_at) AS latest_outbox_event, MAX(delivered_at) AS latest_outbox_delivery FROM sync_outbox WHERE aggregate_type='DEVICE_DATA';\"
  sleep 30
done
"
rm -f "$tmp"
```

Expected: after the next Kiwi uplink, `latest_outbox_event` and `latest_outbox_delivery` advance beyond the previous `2026-04-18T20:53:43.721Z` watermark.

- [ ] **Step 5: Force one sync sweep only if the new trigger is present but delivery lags**

Run only if local outbox events appear but cloud freshness still lags:

```bash
token=$(curl -sS -X POST 'http://100.69.51.98:1880/auth/login' \
  -H 'Content-Type: application/json' \
  --data '{"username":"Kaweza","password":"kaweza@123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')
curl -sS -X POST 'http://100.69.51.98:1880/api/sync/force' \
  -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' \
  --data '{}' | python3 -m json.tool
```

Expected: a clean force-sync response without any gateway identity or migration pause error.

## Task 6: Verify Cloud Freshness For Kiwi 1–3

**Files:**
- Modify: none
- Test: local edge state versus cloud state

- [ ] **Step 1: Capture current local freshness for Kiwi 1–3**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 \
  "sqlite3 -header -column /data/db/farming.db \"SELECT d.name, d.deveui, latest.recorded_at AS latest_recorded_at FROM devices d LEFT JOIN (SELECT deveui, MAX(recorded_at) AS recorded_at FROM device_data GROUP BY deveui) latest ON latest.deveui = d.deveui WHERE d.name IN ('Kiwi 1','Kiwi 2','Kiwi 3') ORDER BY d.name;\""
rm -f "$tmp"
```

Expected: three recent local timestamps for Kiwi 1–3.

- [ ] **Step 2: Compare cloud device freshness**

Run the existing server-side comparison command or script already used in operator checks. If using curl directly, request the canonical cloud device list for the linked account and inspect `lastSeen` / `currentStateRecordedAt` for:

```text
Kiwi 1
Kiwi 2
Kiwi 3
```

Expected: cloud timestamps catch up to the local timestamps captured in Step 1.

- [ ] **Step 3: Confirm sync-state data-plane fields recovered**

Run:

```bash
token=$(curl -sS -X POST 'http://100.69.51.98:1880/auth/login' \
  -H 'Content-Type: application/json' \
  --data '{"username":"Kaweza","password":"kaweza@123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')
curl -sS 'http://100.69.51.98:1880/api/sync/state' \
  -H "Authorization: Bearer $token" \
  | python3 -c 'import sys,json; s=json.load(sys.stdin); print(json.dumps({k:s.get(k) for k in ["pendingOutboxCount","lastMirroredEventAt","lastOutboxDeliverySuccessAt","lastPendingCommandPollSuccessAt","lastError"]}, indent=2))'
```

Expected:

```json
{
  "pendingOutboxCount": 0,
  "lastMirroredEventAt": "<recent timestamp>",
  "lastOutboxDeliverySuccessAt": "<recent timestamp>",
  "lastPendingCommandPollSuccessAt": "<recent timestamp>",
  "lastError": null
}
```

## Task 7: Decide Whether The Current Codebase Needs A Packaging Follow-Up

**Files:**
- Modify: `deploy.sh` only if the live migration exposed a durable packaging gap
- Test: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Decide if the drift came from rollout method or missing packaging**

Use this decision table:

```text
If Uganda reaches repo-matching hashes and the trigger repairs itself after copying current files:
- treat the issue as a past partial rollout or live drift
- no repo code change is required for sync repair

If Uganda still differs after a clean artifact copy, or helper shadowing recurs:
- update deploy.sh so helper package/runtime sync is explicit and deterministic
- add a static verification check that the deployed helper path is the same one runtime resolves
```

- [ ] **Step 2: If packaging follow-up is needed, write the smallest failing verification first**

Add to `scripts/verify-sync-flow.js` a check that the deploy path includes:

```js
expectFileIncludes('deploy.sh', deployScript, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js', 'deploys the shipped ChirpStack helper index to live devices');
```

Expected: the new check fails first if the deploy script is missing that explicit sync path.

- [ ] **Step 3: Implement only the minimal deploy-script hardening if Step 2 fails**

Target shape in `deploy.sh`:

```sh
fetch_required "osi-chirpstack-helper index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js" \
    "/srv/node-red/osi-chirpstack-helper/index.js"
```

Expected: deployment of the runtime helper path becomes explicit and verifiable.

- [ ] **Step 4: Re-run static verification if any repo file changed**

Run:

```bash
node scripts/verify-sync-flow.js
git diff --check
```

Expected: both pass before any follow-up commit.

## Task 8: Close Out The Migration Safely

**Files:**
- Modify: none unless Task 7 required repo hardening
- Test: git state and final operator notes

- [ ] **Step 1: Save final evidence after repair**

Run:

```bash
token=$(curl -sS -X POST 'http://100.69.51.98:1880/auth/login' \
  -H 'Content-Type: application/json' \
  --data '{"username":"Kaweza","password":"kaweza@123"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')
curl -sS 'http://100.69.51.98:1880/api/sync/state' \
  -H "Authorization: Bearer $token" \
  | python3 -m json.tool > /tmp/uganda-evidence/post-repair-sync-state.json
```

Expected: final sync-state evidence is preserved locally.

- [ ] **Step 2: Record the live trigger and outbox recovery snapshot**

Run:

```bash
tmp=$(mktemp)
cat >"$tmp" <<'EOF'
#!/bin/sh
echo 'opensmartirrigation'
EOF
chmod 700 "$tmp"
DISPLAY=:0 SSH_ASKPASS="$tmp" SSH_ASKPASS_REQUIRE=force setsid ssh \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  root@100.69.51.98 '
sqlite3 -header -column /data/db/farming.db "SELECT name FROM sqlite_master WHERE type='\''trigger'\'' AND tbl_name='\''device_data'\'' ORDER BY name;"
sqlite3 -header -column /data/db/farming.db "SELECT MAX(occurred_at) AS latest_outbox_event, MAX(delivered_at) AS latest_outbox_delivery FROM sync_outbox WHERE aggregate_type='\''DEVICE_DATA'\'';"
' > /tmp/uganda-evidence/post-repair-db.txt
rm -f "$tmp"
```

Expected: the evidence shows a recovered trigger set and new outbox activity.

- [ ] **Step 3: Keep the backup until at least one full day of stable Kiwi updates**

Do not delete:

```text
/data/db/backups/osi-os-<timestamp>-uganda-current-codebase-migration
```

Expected: a clean rollback point remains available after the live fix.

- [ ] **Step 4: Commit only if Task 7 changed repo files**

Run:

```bash
git status --short --branch
```

Expected: clean repo if the migration needed no follow-up hardening, or a small scoped diff if Task 7 introduced a packaging fix.
