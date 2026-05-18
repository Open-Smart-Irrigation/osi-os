# osi-bootstrap Init Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-bootstrapping init script that eliminates the manual `node /srv/node-red/chirpstack-bootstrap.js` step when flashing a golden image to a new Pi.

**Architecture:** An OpenWrt init script at START=85 (between ChirpStack and Node-RED) checks stamp+env validity, waits for ChirpStack gRPC, runs chirpstack-bootstrap.js, then writes a completion stamp. A uci-defaults script enables the init on first boot. On subsequent boots the stamp is found and the script returns instantly.

**Tech Stack:** Shell (BusyBox ash), OpenWrt init framework (`/etc/rc.common`), `curl` for gRPC health check

**Spec:** [2026-05-17-osi-bootstrap-init-design.md](/home/phil/Repos/osi-os/docs/superpowers/specs/2026-05-17-osi-bootstrap-init-design.md)

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/95_osi_bootstrap_enable` | First-boot activation: creates rc.d symlink, self-deletes |
| Create | `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` | Main init: stamp check, gRPC wait, bootstrap run |
| Modify | `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/sysupgrade.conf` | Add `/etc/osi-bootstrap.done` to preserve list |
| Modify | `scripts/verify-sync-flow.js` | Add repo-level verification of new files |

---

### Task 1: Create uci-defaults activation script

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/95_osi_bootstrap_enable`

- [ ] **Step 1: Write the activation script**

```sh
#!/bin/sh
/etc/init.d/osi-bootstrap enable
```

Use Write tool to create the file at `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/95_osi_bootstrap_enable` with the content above.

- [ ] **Step 2: Make it executable**

```bash
chmod 755 conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/95_osi_bootstrap_enable
```

- [ ] **Step 3: Verify**

```bash
ls -la conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/95_osi_bootstrap_enable
# Expected: -rwxr-xr-x ... 95_osi_bootstrap_enable
```

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/95_osi_bootstrap_enable
git commit -m "feat: add uci-defaults script to enable osi-bootstrap init on first boot"
```

---

### Task 2: Create osi-bootstrap init script

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap`

- [ ] **Step 1: Write the init script**

```sh
#!/bin/sh /etc/rc.common

START=85

stamp_valid() {
	[ -f /etc/osi-bootstrap.done ] || return 1
	[ -f /srv/node-red/.chirpstack.env ] || return 1
	grep -q 'CHIRPSTACK_APP_SENSORS=[0-9a-f]\{8\}-' /srv/node-red/.chirpstack.env 2>/dev/null || return 1
	return 0
}

boot() {
	start
}

start() {
	if stamp_valid; then
		return 0
	fi

	if [ ! -f /srv/node-red/chirpstack-bootstrap.js ]; then
		logger -t osi-bootstrap "bootstrap script not found, marking done"
		touch /etc/osi-bootstrap.done
		return 0
	fi

	logger -t osi-bootstrap "waiting for ChirpStack gRPC..."
	local ready=0
	for i in $(seq 1 12); do
		if curl -sf --max-time 3 http://localhost:8080 2>/dev/null; then
			ready=1
			break
		fi
		sleep 5
	done

	if [ "$ready" = 0 ]; then
		logger -t osi-bootstrap "ChirpStack not ready after 60s, will retry next boot"
		return 0
	fi

	logger -t osi-bootstrap "running chirpstack-bootstrap.js..."
	if node /srv/node-red/chirpstack-bootstrap.js; then
		touch /etc/osi-bootstrap.done
		logger -t osi-bootstrap "bootstrap completed successfully"
	else
		logger -t osi-bootstrap "bootstrap failed, will retry next boot"
	fi
	return 0
}
```

Use Write tool to create the file at `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap` with the content above.

- [ ] **Step 2: Make it executable**

```bash
chmod 755 conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap
```

- [ ] **Step 3: Verify syntax statically**

```bash
# Check the shebang line and START= line
head -3 conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap
# Expected: #!/bin/sh /etc/rc.common\n\nSTART=85

# Verify key functions are present
grep -c 'stamp_valid\|boot()\|start()' conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap
# Expected: 3 (three function definitions)

# Verify no STOP= is set (one-shot script, no shutdown behavior)
grep -c 'STOP=' conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap
# Expected: 0

# Verify logger uses the correct tag throughout
grep 'logger.*osi-bootstrap' conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap | wc -l
# Expected: 5
```

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap
git commit -m "feat: add osi-bootstrap init script for automatic first-boot ChirpStack provisioning"
```

---

### Task 3: Add stamp file to sysupgrade.conf

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/sysupgrade.conf`

- [ ] **Step 1: Add the stamp file path**

Read the current `sysupgrade.conf` and append `/etc/osi-bootstrap.done` before the final line. The file currently reads:

```
## This file contains files and directories that should
## be preserved during an upgrade.
# /etc/example.conf
# /etc/openvpn/
/srv
/etc/tailscale/authkey
/var/lib/tailscale
```

Use Edit tool to replace the last line (`/var/lib/tailscale`) with:

```
/var/lib/tailscale
/etc/osi-bootstrap.done
```

- [ ] **Step 2: Verify**

```bash
tail -3 conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/sysupgrade.conf
# Expected:
# /etc/tailscale/authkey
# /var/lib/tailscale
# /etc/osi-bootstrap.done
```

- [ ] **Step 3: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/sysupgrade.conf
git commit -m "feat: preserve osi-bootstrap stamp file across sysupgrade"
```

---

### Task 4: Add verification to verify-sync-flow.js

**Files:**
- Modify: `scripts/verify-sync-flow.js` (append checks near end, before the `Promise.all(pendingChecks)` block)

- [ ] **Step 1: Define file paths for new files**

Find the existing file path declarations at lines 13-16 (near `osiServerDefaultsPath`, `sx1301GatewayDefaultPath`, etc.). Add two new paths after line 16 (`const chirpstackBootstrapPath`):

```javascript
const osiBootstrapInitPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'etc', 'init.d', 'osi-bootstrap');
const osiBootstrapEnablePath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'etc', 'uci-defaults', '95_osi_bootstrap_enable');
const sysupgradeConfPath = path.resolve(__dirname, '..', 'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'etc', 'sysupgrade.conf');
```

Use Edit tool to insert these three lines right after line 16 (`const chirpstackBootstrapPath = path.resolve(__dirname, 'chirpstack-bootstrap.js');`).

- [ ] **Step 2: Read the new files and add verification checks**

Find a good insertion point near the end of the file, before the `Promise.all(pendingChecks)` block at line 2353. Add the following verification block before it (after the last `expectFileIncludes` / `expectFileExcludes` call, around line 1769):

```javascript
// --- osi-bootstrap init script verification ---

let osiBootstrapInitScript = '';
if (fs.existsSync(osiBootstrapInitPath)) {
  osiBootstrapInitScript = fs.readFileSync(osiBootstrapInitPath, 'utf8');
  console.log('OK osi-bootstrap init script present');
} else {
  fail(`missing osi-bootstrap init script at ${osiBootstrapInitPath}`);
}

expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, 'START=85', 'init script declares correct boot priority');
expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, 'stamp_valid()', 'init script defines stamp validity check');
expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, '/etc/osi-bootstrap.done', 'init script uses the canonical stamp file path');
expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, '/srv/node-red/.chirpstack.env', 'init script checks env file existence');
expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, "grep -q 'CHIRPSTACK_APP_SENSORS=[0-9a-f]\\{8\\}-'", 'init script validates env file contains valid app UUIDs');
expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, 'chirpstack-bootstrap.js', 'init script references the bootstrap script');
expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, 'curl -sf --max-time 3 http://localhost:8080', 'init script waits for ChirpStack gRPC via curl');
expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, 'seq 1 12', 'init script retries gRPC health check up to 12 times');
expectFileIncludes('osi-bootstrap', osiBootstrapInitScript, 'logger -t osi-bootstrap', 'init script logs all events with the correct tag');
expectFileExcludes('osi-bootstrap', osiBootstrapInitScript, 'STOP=', 'init script does not set a shutdown priority (one-shot)');

// uci-defaults activation script
let osiBootstrapEnableScript = '';
if (fs.existsSync(osiBootstrapEnablePath)) {
  osiBootstrapEnableScript = fs.readFileSync(osiBootstrapEnablePath, 'utf8');
  console.log('OK osi-bootstrap uci-defaults activation script present');
} else {
  fail(`missing osi-bootstrap uci-defaults activation script at ${osiBootstrapEnablePath}`);
}

expectFileIncludes('95_osi_bootstrap_enable', osiBootstrapEnableScript, '/etc/init.d/osi-bootstrap enable', 'activation script enables the osi-bootstrap init on first boot');

// sysupgrade.conf preservation
let sysupgradeConf = '';
if (fs.existsSync(sysupgradeConfPath)) {
  sysupgradeConf = fs.readFileSync(sysupgradeConfPath, 'utf8');
  console.log('OK sysupgrade.conf present');
} else {
  fail(`missing sysupgrade.conf at ${sysupgradeConfPath}`);
}

expectFileIncludes('sysupgrade.conf', sysupgradeConf, '/etc/osi-bootstrap.done', 'sysupgrade.conf preserves the osi-bootstrap stamp file');
```

Use Edit tool to insert this block right before the existing `Promise.all(pendingChecks)` line (currently `Promise.all(pendingChecks).finally(() => {`).

- [ ] **Step 3: Run the verification script**

```bash
node scripts/verify-sync-flow.js
```

Expected: All checks pass, including the new osi-bootstrap checks. Final line: `Sync flow verification passed`.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-sync-flow.js
git commit -m "feat: add osi-bootstrap init script verification to sync flow checks"
```

---

### Task 5: Final verification and summary

- [ ] **Step 1: Run full verification**

```bash
node scripts/verify-sync-flow.js
```

Expected output includes:
```
OK osi-bootstrap init script present
OK osi-bootstrap init script declares correct boot priority
OK osi-bootstrap init script defines stamp validity check
OK osi-bootstrap init script uses the canonical stamp file path
OK osi-bootstrap init script checks env file existence
OK osi-bootstrap init script validates env file contains valid app UUIDs
OK osi-bootstrap init script references the bootstrap script
OK osi-bootstrap init script waits for ChirpStack gRPC via curl
OK osi-bootstrap init script retries gRPC health check up to 12 times
OK osi-bootstrap init script logs all events with the correct tag
OK osi-bootstrap init script does not set a shutdown priority (one-shot)
OK osi-bootstrap uci-defaults activation script present
OK activation script enables the osi-bootstrap init on first boot
OK sysupgrade.conf present
OK sysupgrade.conf preserves the osi-bootstrap stamp file
Sync flow verification passed
```

- [ ] **Step 2: List all files changed**

```bash
git log --oneline -4
```

Expected: Four commits in this order:
1. `feat: add uci-defaults script to enable osi-bootstrap init on first boot`
2. `feat: add osi-bootstrap init script for automatic first-boot ChirpStack provisioning`
3. `feat: preserve osi-bootstrap stamp file across sysupgrade`
4. `feat: add osi-bootstrap init script verification to sync flow checks`

---

## Hardware Smoke Test (separate, not in this plan)

After building a golden image with these changes:

1. Flash golden image to SD card
2. Boot on Pi 5; wait 2 min
3. Verify: `ls /etc/rc.d/S85osi-bootstrap` — symlink exists (uci-defaults created it)
4. Verify: `cat /etc/osi-bootstrap.done` — exists (bootstrap succeeded)
5. Verify: `grep CHIRPSTACK_APP_SENSORS /srv/node-red/.chirpstack.env` — valid UUID
6. Verify: `uci get osi-server.cloud.chirpstack_app_sensors` — matching UUID
7. Reboot; verify bootstrap is a no-op (no duplicate log messages)
8. Delete `.chirpstack.env`; reboot; verify bootstrap re-runs and recreates it
