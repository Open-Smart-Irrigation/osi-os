# osi-bootstrap: automatic first-boot ChirpStack provisioning init script

**Status:** draft
**Date:** 2026-05-17
**Scope:** New `/etc/init.d/osi-bootstrap` init script + golden image build integration

---

## 1. Purpose

Eliminate the manual `node /srv/node-red/chirpstack-bootstrap.js` step after flashing a golden image. On first boot, the init script detects an unprovisioned system, waits for ChirpStack, runs the idempotent bootstrap, and exits. On subsequent boots it is a no-op. The end user flashes the golden image, powers on, and OSI OS is fully configured with zero manual steps.

## 2. Design

### 2.1 Init ordering

```
START=99   chirpstack              → /etc/rc.d/S99chirpstack
START=99   node-red                → /etc/rc.d/S99node-red
START=99   osi-bootstrap           → /etc/rc.d/S99osi-bootstrap
```

OpenWrt traverses equal-priority init scripts by rc.d symlink name. `S99osi-bootstrap` therefore runs after `S99chirpstack` and the initial `S99node-red` start without patching the vendored ChirpStack feed. On successful first-boot provisioning, `osi-bootstrap` restarts Node-RED so it picks up the generated UCI and `.chirpstack.env` values. On later stamp-valid boots, it exits without restarting Node-RED.

### 2.2 Control flow

```
boot() / start()
  │
  ├─[1] stamp_valid()? ────── yes ──→ exit 0        (already provisioned)
  │
  ├─[2] bootstrap.js exists? ── no ──→ logger warn → exit 0
  │
  ├─[3] Wait for ChirpStack gRPC (120s max, 24 × 5s)
  │      curl -sf --max-time 3 http://localhost:8080
  │
  │      timeout? ──→ logger warn → exit 0          (retry next boot)
  │
  ├─[4] node /usr/share/node-red/chirpstack-bootstrap.js
  │      fallback: /srv/node-red/chirpstack-bootstrap.js
  │
  │      success? ──→ touch stamp → restart node-red → exit 0
  │
  │      failure? ──→ logger err → exit 0           (retry next boot)
  │                   (never blocks system boot)
```

### 2.3 Stamp validity

A stamp file alone is insufficient — the env file can be deleted or corrupted after provisioning. The validity check is:

```sh
stamp_valid() {
    [ -f /etc/osi-bootstrap.done ] || return 1
    [ -f /srv/node-red/.chirpstack.env ] || return 1
    grep -q 'CHIRPSTACK_APP_SENSORS=[0-9a-f]\{8\}-' /srv/node-red/.chirpstack.env 2>/dev/null || return 1
    return 0
}
```

If the env file is missing or its UUIDs look invalid (no sensor app UUID), the stamp is treated as stale and bootstrap re-runs.

### 2.4 Script location and activation

Three files are placed in the overlay:

| Source (repo) | Destination (image) | Purpose |
|---|---|---|
| `files/etc/init.d/osi-bootstrap` | `/etc/init.d/osi-bootstrap` | Main init script (mode 755) |
| `files/etc/uci-defaults/95_osi_bootstrap_enable` | `/etc/uci-defaults/95_osi_bootstrap_enable` | First-boot activation (mode 644; sourced by OpenWrt) |
| `files/usr/share/node-red/chirpstack-bootstrap.js` | `/usr/share/node-red/chirpstack-bootstrap.js` | Immutable image copy of the bootstrap JS |

**Why the uci-defaults file?** Init scripts in the overlay directory are NOT auto-enabled by the OpenWrt image builder (no package postinst creates rc.d symlinks for overlay files). The `uci-defaults` script runs on first boot before init traversal, creates `/etc/rc.d/S99osi-bootstrap → ../init.d/osi-bootstrap`, then self-deletes. The init script then runs during that same first boot when the init system reaches `S99osi-bootstrap`.

No `STOP=` is set on the init script — it is a one-shot provisioning step with no shutdown behavior.

**uci-defaults script** (`95_osi_bootstrap_enable`):

```sh
#!/bin/sh
/etc/init.d/osi-bootstrap enable
```

### 2.5 Sysupgrade preservation

Add `/etc/osi-bootstrap.done` to `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/sysupgrade.conf` so OTA sysupgrades preserve the stamp. Without this, every OTA upgrade re-triggers bootstrap (idempotent, so safe but wasteful).

### 2.6 Bootstrap JS source and image copy

`scripts/chirpstack-bootstrap.js` remains the source of truth for development and live deploys. The golden image carries a byte-identical copy at `/usr/share/node-red/chirpstack-bootstrap.js`; `osi-bootstrap` prefers that ROM path and falls back to `/srv/node-red/chirpstack-bootstrap.js` for live-deploy compatibility. The repo verifier compares the two checked-in copies byte-for-byte to prevent drift.

### 2.7 API key creation

No change. Bootstrap continues to create the `osi-nodered` API key via `chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered`. Pre-seeding was considered and rejected (requires build-time ChirpStack DB injection; fragile across ChirpStack versions).

## 3. Failure point analysis

### F1: ChirpStack not installed
- **Trigger:** image missing ChirpStack package
- **Behavior:** step [3] times out after 120s; stamp not created; retries every boot
- **Severity:** low — missing ChirpStack is a build error caught by CI

### F2: ChirpStack slow first-boot DB init
- **Trigger:** factory image first boot; ChirpStack creates SQLite DB, runs migrations (30–45s on Pi 5)
- **Behavior:** port responds but gRPC calls may fail during init; bootstrap fails; stamp not created; retries next boot
- **Result:** two-boot scenario — ChirpStack DB exists from first boot, starts in ~2s on second boot, bootstrap succeeds
- **Severity:** low — rare (slow SD only); user sees dashboard without ChirpStack integration for one boot cycle

### F3: Node.js binary missing
- **Trigger:** Node-RED package corrupted or not installed
- **Behavior:** step [4] fails immediately (`node` not found); stamp not created
- **Severity:** low — if Node.js is missing, Node-RED cannot start; system is broken beyond bootstrap

### F4: chirpstack CLI unavailable
- **Trigger:** CLI binary missing, wrong permissions, or ChirpStack auth not ready
- **Behavior:** bootstrap step 1/5 fails ("CLI create-api-key failed"); stamp not created; retries next boot
- **Severity:** medium — if CLI consistently fails (ChirpStack v4 changes setup-mode behavior), system never provisions; requires CGOS compatibility fix

### F5: Partial bootstrap — ChirpStack creates but local writes fail
- **Trigger:** disk full or permissions error during env file write, UCI commit, or stamp write
- **Behavior:** tenant/apps/profiles exist in ChirpStack but required local state is incomplete; stamp is not created
- **Result:** retry reuses existing ChirpStack resources (idempotent by name); only file writes are re-attempted; no duplicate resources
- **Severity:** low — idempotent design self-heals

### F6: Disk full
- **Trigger:** overlay filesystem at capacity (extremely unlikely on first boot with auto-expanded overlay)
- **Behavior:** `fs.writeFileSync` in bootstrap fails with ENOSPC; stamp not created; retries every boot
- **Severity:** low — disk full is a fatal system state; bootstrap failing is a symptom, not a cause

### F7: Concurrent execution
- **Trigger:** theoretical only — OpenWrt init runs sequentially
- **Risk:** none; no mitigation needed

### F8: Power loss during bootstrap
- **State scenarios:**
  - Before any gRPC calls: ChirpStack unchanged, no damage
  - After tenant, before apps: tenant exists, apps don't; retry reuses tenant, creates missing apps
  - After apps, before profiles: apps exist, profiles don't; retry reuses all, creates profiles
  - After all ChirpStack calls, before env write: all resources exist; retry reuses everything (fast), writes env
  - During env file write: partial/corrupt `.chirpstack.env`; retry overwrites
  - During UCI commit: UCI may be partially written; retry overwrites
- **Conclusion:** safe in all scenarios; `getOrCreate` + file-overwrite semantics are power-loss tolerant

### F9: Stamp file exists but env file is corrupt/missing
- **Trigger:** user manually deletes `.chirpstack.env` or it is corrupted
- **Detection:** stamp validity check (2.3) catches this; env file missing → stamp treated as stale → re-bootstrap
- **Severity:** mitigated by stamp validity check

### F10: Bootstrap runs on manually configured system
- **Trigger:** golden image flashed to Pi previously configured with custom ChirpStack app names
- **Behavior:** bootstrap creates standard "OSI Sensors" etc. apps alongside existing custom apps; no name collision; Node-RED uses standard apps
- **Severity:** low — golden image implies clean install

### F11: gRPC health check false positive
- **Trigger:** `curl http://localhost:8080` returns HTTP 200 but gRPC not fully ready (DB connection pool not initialized)
- **Behavior:** step [3] passes; step [4] fails with gRPC error; stamp not created; retries next boot
- **Result:** by next boot ChirpStack is fully ready
- **Severity:** low — the health check is a "probably ready" heuristic; actual readiness determined by gRPC call succeeding

### F12: Node-RED not installed
- **Trigger:** Node-RED package missing from image; chirpstack-bootstrap.js itself runs fine (Node.js may or may not be present)
- **Behavior:** bootstrap succeeds, stamp created, but the post-bootstrap Node-RED restart fails and is logged
- **Note:** this is a build error, not a runtime concern; CI verifies Node-RED package presence

### F13: System clock not synchronized
- **Trigger:** Pi has no RTC and no network time on first boot; clock is Jan 1 1970
- **Behavior:** ChirpStack gRPC calls may reject requests with bad timestamps; bootstrap fails; retries next boot
- **Result:** by second boot, NTP has usually synced; if no internet, clock remains wrong and ChirpStack may reject all operations
- **Severity:** low — Pi 5 typically gets NTP quickly; if offline permanently, bootstrap will retry indefinitely; user must sync clock

### F14: Node-RED starts before bootstrap completes
- **Trigger:** `node-red` and `osi-bootstrap` both use START=99, and `S99node-red` sorts before `S99osi-bootstrap`
- **Behavior:** Node-RED may start once without generated ChirpStack app/profile IDs on a fresh image
- **Mitigation:** after successful bootstrap, `osi-bootstrap` restarts Node-RED exactly once for that provisioning run; stamp-valid boots skip the restart

## 4. Build integration

### 4.1 Files to add

```
conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap           (new, 755)
conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/95_osi_bootstrap_enable  (new, 644)
conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js (new, 644)
```

### 4.2 Files to modify

```
conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/sysupgrade.conf
    + /etc/osi-bootstrap.done
```

### 4.3 Verification (CI / manual)

```bash
# After image build, check init script and uci-defaults script are present
ls -la <root>/etc/init.d/osi-bootstrap                  # exists, mode 755
ls -la <root>/etc/uci-defaults/95_osi_bootstrap_enable   # exists, mode 644
ls -la <root>/usr/share/node-red/chirpstack-bootstrap.js # exists, mode 644
# Note: rc.d symlink is created at RUNTIME on first boot, not at build time

# Check sysupgrade.conf includes stamp file
grep 'osi-bootstrap.done' <root>/etc/sysupgrade.conf

# Smoke test on Pi 5 hardware
# 1. Flash golden image
# 2. Boot; wait 3 min
# 3. Check: /etc/rc.d/S99osi-bootstrap exists (uci-defaults created it)
# 4. Check: /etc/osi-bootstrap.done exists
# 5. Check: /srv/node-red/.chirpstack.env has valid UUIDs
# 6. Check: uci get osi-server.cloud.chirpstack_app_sensors returns a UUID
# 7. Reboot; verify stamp_valid returns immediately (no re-bootstrap)
# 8. Delete .chirpstack.env; reboot; verify bootstrap re-runs, recreates it, and restarts Node-RED
```

## 5. Non-goals

- Pre-seeding the ChirpStack API key (rejected; see 2.7)
- Integrating the bootstrap logic into node-red.init (separate init = cleaner ownership)
- Backgrounding the bootstrap work (synchronous wait ≤120s on first boot only is acceptable)
- Handling the case where ChirpStack is not installed at all (build error; CI gate)

## 6. Dependencies

- `chirpstack-bootstrap.js` at `/usr/share/node-red/chirpstack-bootstrap.js` (golden image) or `/srv/node-red/chirpstack-bootstrap.js` (live deploy fallback)
- `osi-chirpstack-helper` at `/usr/share/node-red/osi-chirpstack-helper/` or `/srv/node-red/osi-chirpstack-helper/` (required by bootstrap.js)
- ChirpStack gRPC API on `localhost:8080` (required for bootstrap.js to provision apps/profiles)
- `curl` for gRPC health check (present in all CGOS builds)
