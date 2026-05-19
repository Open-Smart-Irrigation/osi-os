# OSI OS — Versioning Workflow

This document defines every step required to cut a new OSI OS release.
Run through it top-to-bottom. Do not skip steps; each has a downstream dependency.

---

## Version scheme

`MAJOR.MINOR.PATCH` — e.g. `0.6.5`

- **PATCH**: bug fixes, minor improvements, deploy-only rollout (no firmware rebuild required)
- **MINOR**: new device type, new feature area, schema additions
- **MAJOR**: breaking protocol change, full firmware rebuild required

---

## Pre-flight

- [ ] All feature branches merged to `main` in both `osi-os` and `osi-server`.
- [ ] `osi-server` VPS is up to date and healthy (`docker compose ps` — all services Up/healthy).
- [ ] No uncommitted changes: `git status --short` is clean.

---

## Step 1 — Bump the version string (4 files)

Edit all four places in one commit. Search for the previous version to catch anything new added since this doc was last updated.

```bash
grep -r "0\.6\.5" web/react-gui/src/ conf/ README.md CHANGELOG.md
```

| File | What to change |
|------|----------------|
| `web/react-gui/src/pages/Login.tsx` | `OSI OS v<NEW> (Alpha)` in the `<h1>` |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` | `set osi-server.cloud.firmware_version=<NEW>` |
| `README.md` | `**v<NEW> Alpha**` at the top |
| `CHANGELOG.md` | New `## [<NEW>] — YYYY-MM-DD` section (see Step 2) |

### Step 1a — Refresh Chameleon calibrations (if applicable)

Run before cutting a release to bundle known calibrations into the firmware seed DB:

```bash
OSI_ADMIN_TOKEN=<token> node scripts/refresh-chameleon-calibrations.js
```

Review the diff in `database/seeds/chameleon-calibrations.sql` and commit it as part of the release PR. Apply the seed to both canonical DBs:

```bash
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db < database/seeds/chameleon-calibrations.sql
sqlite3 conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db < database/seeds/chameleon-calibrations.sql
```

---

## Step 2 — Write the CHANGELOG entry

Add a new section at the top of [CHANGELOG.md](../CHANGELOG.md) before the previous release:

```markdown
## [X.Y.Z] — YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

Keep entries user-facing: what changed and why it matters. Reference deploy.sh steps if they affect operators.

---

## Step 3 — Rebuild the React GUI

```bash
cd web/react-gui && npm install && npm run build
cd ../..
tar -czf react_gui.tar.gz -C web/react-gui/dist .
```

Verify the bundle includes the new version string:
```bash
grep -r "v0\." web/react-gui/dist/ | head -5
```

---

## Step 4 — Commit and tag

```bash
git add web/react-gui/src/pages/Login.tsx \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config \
        README.md \
        CHANGELOG.md
git commit -m "release: OSI OS v<NEW>"
git tag v<NEW>
git push origin main --tags
```

`react_gui.tar.gz` is gitignored (large binary) — do not commit it.

---

## Step 5 — Capture the golden image

Flash a **clean** SD card with the current firmware (not an upgraded Pi — start fresh).
Boot, let `osi-bootstrap` run to completion, then capture:

```bash
# On workstation — determine used sector count from Pi
ssh root@<pi-ip> 'cat /sys/block/mmcblk0/mmcblk0p*/size | awk "{s+=\$1} END {print s}"'
# sectors × 512 / 1048576 = MB to capture

COUNT=<MB>
ssh root@<pi-ip> "dd if=/dev/mmcblk0 bs=1M count=$COUNT 2>/dev/null | gzip -1" \
  > tmp/osi-os-<VERSION>-golden-$(date -u +%Y%m%d).img.gz

# Record SHA-256
sha256sum tmp/osi-os-<VERSION>-golden-$(date -u +%Y%m%d).img.gz
```

Store the SHA-256 in the GitHub Release description (Step 6). The image lives in `/tmp/` (gitignored).

---

## Step 6 — GitHub Release

```bash
gh release create v<NEW> \
  --title "OSI OS v<NEW>" \
  --notes-file <(sed -n '/^## \[<NEW>\]/,/^## \[/p' CHANGELOG.md | head -n -1) \
  --latest
```

Attach the golden image if it fits within the 2 GB GitHub release asset limit:
```bash
gh release upload v<NEW> tmp/osi-os-<VERSION>-golden-$(date -u +%Y%m%d).img.gz
```

Include the SHA-256 in the release notes so operators can verify downloads.

---

## Step 7 — Deploy to Pis

Run `deploy.sh` on each Pi in order: staging Pis first, production last.

```bash
# Start local file server (from repo root)
python3 -m http.server 9876 &

# Per Pi
ssh -R 9876:localhost:9876 root@<pi-ip> 'curl -fsS http://localhost:9876/deploy.sh | sh'
ssh root@<pi-ip> '/etc/init.d/node-red restart'

# Set firmware_version on existing Pis (96_osi_server_config only runs on first boot)
ssh root@<pi-ip> 'uci set osi-server.cloud.firmware_version=<NEW> && uci commit osi-server'

# Verify
ssh root@<pi-ip> 'uci get osi-server.cloud.firmware_version'   # → <NEW>
ssh root@<pi-ip> 'cat /srv/node-red/node_modules/osi-cloud-http/index.js | head -1'  # → 'use strict';
```

Kill the server when done:
```bash
kill %1
```

Pi order for this project:
1. **Silvan** `100.81.220.8` — staging
2. **kaba100** `100.93.68.86` — staging
3. **Uganda** `100.69.51.98` — production (always last)

---

## Step 8 — Deploy osi-server (if changed)

If `osi-server` has changes to deploy alongside this OSI OS release:

```bash
# On VPS — pull and rebuild backend only
ssh -i ~/.ssh/osi_server_rollout rocky@83.228.220.63 '
  git -C /home/rocky/docker/osi-server pull --ff-only origin main &&
  cd /home/rocky/docker/osi-server/docker &&
  docker compose build backend &&
  docker compose up -d backend
'

# Verify startup (~20 s)
ssh -i ~/.ssh/osi_server_rollout rocky@83.228.220.63 \
  'docker logs osi-backend 2>&1 | grep -E "Started|ERROR" | tail -5'
```

> **Never** run `docker compose up -d --build` (builds all services, overwhelms the VPS).
> **Flyway ordering**: if a new migration uses date-based versioning (`V2026_05_16_*`), verify it sorts *after* the highest existing applied version. Check with:
> `docker exec osi-postgres psql -U osiserver -d osiserver -c "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 5;"`

---

## Step 9 — Smoke test

On each Pi after Node-RED restarts:

- [ ] `uci get osi-server.cloud.firmware_version` → correct version
- [ ] Login screen in browser shows `OSI OS v<NEW> (Alpha)`
- [ ] Dashboard loads without console errors
- [ ] Latest heartbeat visible in osi-server cloud (within 90 s)
- [ ] `osi-cloud-http` module resolves: `cat /srv/node-red/node_modules/osi-cloud-http/index.js | head -1`

---

## Checklist summary

```
[ ] Step 1  — Bump 4 version strings
[ ] Step 2  — Write CHANGELOG entry
[ ] Step 3  — Rebuild React GUI + react_gui.tar.gz
[ ] Step 4  — Commit + git tag + push
[ ] Step 5  — Capture golden image (fresh Pi, record SHA-256)
[ ] Step 6  — GitHub Release (notes + optional image upload)
[ ] Step 7  — Deploy to Pis (staging → production)
[ ] Step 8  — Deploy osi-server if changed
[ ] Step 9  — Smoke test all Pis
```
