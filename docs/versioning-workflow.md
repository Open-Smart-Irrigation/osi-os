# OSI OS — Versioning Workflow

This document defines every step required to cut a new OSI OS release.
Run through it top-to-bottom. Do not skip steps; each has a downstream dependency.

In the commands below, `<OLD>` is the version the tree carries today and
`<NEW>` is the version you are cutting. `v<OLD>` stands for the commit of
the previous release. Not every version was tagged (there is no `v0.7.0`
tag); when the tag is missing, use the commit that added the previous
CHANGELOG heading instead:

```bash
git log -S'## [<OLD>]' --format=%h -- CHANGELOG.md | tail -1
```

---

## Version scheme

`MAJOR.MINOR.PATCH` — e.g. `0.7.0`

- **PATCH**: bug fixes, minor improvements, deploy-only rollout (no firmware rebuild required)
- **MINOR**: new device type, new feature area, schema additions
- **MAJOR**: breaking protocol change, full firmware rebuild required

---

## Pre-flight

- [ ] All feature branches merged to `main` in both `osi-os` and `osi-server`.
- [ ] `osi-server` VPS is up to date and healthy (`docker compose ps` — all services Up/healthy).
- [ ] No uncommitted changes: `git status --short` is clean.
- [ ] Every CI workflow is green on the `main` commit you are releasing. There
      are nine: Codec Verifiers, Doc Hygiene, Field Journal Tests, History
      Router Tests, Journal Catalog Vendor Parity, Edge Migrations, GUI
      Typecheck & Unit Tests, UI Core Vendor Parity, Sync Flow Verifier
      (`.github/workflows/*.yml`). Check with:
      ```bash
      gh run list --commit "$(git rev-parse origin/main)" --json workflowName,conclusion
      ```
      Nine entries, each `success`. A run still in progress is not green.
- [ ] Decide whether the sync contract changed since the previous release:
      ```bash
      git diff --stat v<OLD>..origin/main -- docs/contracts/
      ```
      Any change there (new event, command, resource or capability) means
      the matching `osi-server` release must be deployed before any linked
      gateway gets this edge (Step 8 before Step 9). A cloud without the new
      appliers rejects the new events terminally.
- [ ] Maintainers: the doc-hygiene pre-push guard is installed in this clone
      (see AGENTS.md, "No deployment identities in public text"). It scans the
      release commit and its message before the push.

---

## Step 1 — Bump the version string

Edit every location in one commit. Search for the version the tree carries
today, not the one you are cutting, to catch anything added since this
document was last updated:

```bash
git grep -n -F "<OLD>" -- . ':!openwrt' ':!CHANGELOG.md' ':!**/node_modules/**' ':!**/package-lock.json'
```

| File | What to change |
|------|----------------|
| `web/react-gui/src/pages/Login.tsx` | `OSI OS v<NEW> (Alpha)` in the `<h1>` |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config` | `set osi-server.cloud.firmware_version=<NEW>` |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config` | the same line; the two profiles stay byte-identical |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` | the fallback in `fw_version=$(uci -q get osi-server.cloud.firmware_version ... \|\| echo "<NEW>")` |
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | four `'<OLD>'` fallbacks: one in `Build Heartbeat`, three in `Improvement Requests API Router` |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` | copy of the bcm2712 file |
| `scripts/verify-sync-flow.js` | `EXPECTED_VERSION` and the comment above it |
| `README.md` | `**v<NEW> Alpha**` at the top |
| `CHANGELOG.md` | the release heading (see Step 2) |
| `.claude/skills/osi-config-and-flags/SKILL.md` | the two lines that state the `firmware_version` default |

Edit `flows.json` with a script, never in the Node-RED editor. For example,
from 0.7.0 to 0.8.0 (dots escaped in the pattern):

```bash
sed -i "s/'0\.7\.0'/'0.8.0'/g" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git diff --stat -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json   # 2 lines changed
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
```

Not version locations: `web/react-gui/package.json` (`1.0.0`), the Node-RED
`package.json` (no version field), and the `release_id` fixture in
`osi-journal-replication/index.test.js`. Leave them.

Then verify:

```bash
node scripts/verify-sync-flow.js        # checks 96_osi_server_config, node-red.init and the heartbeat fallback
node scripts/verify-profile-parity.js
node scripts/verify-flows-fn-parse.js
```

**What the version string reaches.** `96_osi_server_config` is a first-boot
`uci-defaults` script: it sets `osi-server.cloud.firmware_version` once, when
a flashed image boots for the first time. `deploy.sh` never writes that key,
so a gateway upgraded with `deploy.sh` keeps reporting the version of the
image it was flashed with (a gateway flashed from the 0.6.5 image reports
`0.6.5` however often it is upgraded). Step 9 sets the key on every gateway
you upgrade.

### Step 1a — Refresh Chameleon calibrations

Run before cutting a full image release to bundle known calibrations into the
firmware seed DB. The script reads from
`https://server.opensmartirrigation.org` unless `OSI_SERVER_BASE_URL` is set.

```bash
OSI_ADMIN_TOKEN=<token> node scripts/refresh-chameleon-calibrations.js
node scripts/apply-chameleon-calibration-seed.js --require-rows
```

Review the diff in `database/seeds/chameleon-calibrations.sql` and the
seeded DB copies, then commit them as part of the release PR. The apply
script updates `database/farming.db`, `web/react-gui/farming.db`, and both
Raspberry Pi profile DBs. Without `--require-rows` it accepts an empty
snapshot and the image relies on runtime calibration sync from OSI Server;
pass `--require-rows` for a release image so an empty snapshot fails. A
development image may skip this gate only when that decision is explicit in
the build notes.

Then rerun the seed verifiers, because the script touches four of the seven
bundled database copies:

```bash
node scripts/verify-chameleon-calibration.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
```

---

## Step 2 — Write the CHANGELOG entry

[CHANGELOG.md](../CHANGELOG.md) collects changes under `## [Unreleased]` as
they merge. At release time:

1. Rename `## [Unreleased]` to `## [<NEW>] — YYYY-MM-DD`.
2. Re-read every entry, including its "Upgrade notes", against the merged
   history since the previous release:
   `git log --first-parent --oneline v<OLD>..origin/main`.
3. Add a new, empty `## [Unreleased]` section above it.

```markdown
## [X.Y.Z] — YYYY-MM-DD

### Upgrade notes
- ...

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

Keep entries user-facing: what changed and why it matters. Reference deploy.sh
steps if they affect operators. Check the prose:

```bash
node .claude/skills/anti-slop-writing/slop-check.js CHANGELOG.md
node scripts/verify-doc-hygiene.js
```

---

## Step 3 — Rebuild the React GUI

```bash
cd web/react-gui && npm install && npm run test:unit && npm run build
cd ../..
tar -czf react_gui.tar.gz -C web/react-gui/build .
```

Verify the bundle includes the new version string:
```bash
grep -rl "OSI OS v<NEW>" web/react-gui/build/assets/ | head -1
```

The firmware image takes its GUI from the feed, not from `web/react-gui/build`.
The committed feed copy is stale between releases (it can still show an older
version on the login screen), so refresh it before every image build:

```bash
rm -rf feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
mkdir -p feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
cp -a web/react-gui/build/. feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
grep -rl "OSI OS v<NEW>" feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/assets/ | head -1
```

`react_gui.tar.gz` is gitignored (large binary) — do not commit it.

---

## Step 4 — Commit, merge and tag

Commit the version bump, CHANGELOG and calibration seed on a release branch
and merge it through a pull request, so the CI workflows from the pre-flight
run on the release commit:

```bash
git switch -c release/v<NEW>
git add web/react-gui/src/pages/Login.tsx \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config \
        feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-sync-flow.js \
        .claude/skills/osi-config-and-flags/SKILL.md \
        README.md \
        CHANGELOG.md
git commit -m "release: OSI OS v<NEW>"
git push origin release/v<NEW>
gh pr create --title "release: OSI OS v<NEW>" --body "Version bump and changelog for v<NEW>."
```

After the merge, re-run the CI check from the pre-flight against the merge
commit, then tag that commit and push only the tag:

```bash
git fetch origin
git tag -a v<NEW> <merge-commit-sha> -m "OSI OS v<NEW>"
git push origin v<NEW>
```

Take `<merge-commit-sha>` from the merged pull request.

Never `git push --tags`: customer branches and `archive/*` tags must not
reach the public repository (AGENTS.md, "Branch and tag visibility").

---

## Step 5 — Build the factory images

Build both release images from the tagged commit with the feed GUI from
Step 3, following [docs/build/rpi5-full-osi-image.md](build/rpi5-full-osi-image.md)
from "Pre-Build Verification" through "Build Pi 4 / 400 / 3 / 2":

- Raspberry Pi 5: `make switch-env ENV=full_raspberrypi_bcm27xx_bcm2712`
- Raspberry Pi 4 / 400 / 3 / 2: `make switch-env ENV=full_raspberrypi_bcm27xx_bcm2709`

Do not capture an image from a booted Pi instead. First-boot provisioning
(`uci-defaults`, `osi-bootstrap`) has already run on it, so its image carries
that Pi's gateway identity and ChirpStack IDs.

Stage and rename the assets as in that document's "Release Asset Naming",
with the new version in the directory and file names:

```bash
mkdir -p tmp/release-assets/osi-os_<NEW>
cp openwrt/bin/targets/bcm27xx/bcm2712/*rpi-5*squashfs-factory.img.gz \
  tmp/release-assets/osi-os_<NEW>/osi-os_<NEW>-rpi5-factory.img.gz
cp openwrt/bin/targets/bcm27xx/bcm2709/*rpi-2*squashfs-factory.img.gz \
  tmp/release-assets/osi-os_<NEW>/osi-os_<NEW>-rpi4-factory.img.gz
(cd tmp/release-assets/osi-os_<NEW> && sha256sum *.img.gz > SHA256SUMS)
```

Flash each image on a spare card and run that document's "First Boot
Acceptance". Its `curl http://<pi-ip>:1880/flows` probe now answers 404,
because the Node-RED editor and admin API are closed by default; skip that
probe. On the flashed Pi, `uci get osi-server.cloud.firmware_version` must
print `<NEW>`.

---

## Step 6 — GitHub Release

Extract the release section into a file, check it, then create the release
with both images and the checksum file:

```bash
awk '/^## \[<NEW>\]/{on=1; print; next} on && /^## \[/{exit} on && !/^---$/' CHANGELOG.md \
  > tmp/release-notes-<NEW>.md
node scripts/verify-doc-hygiene.js --stdin < tmp/release-notes-<NEW>.md

gh release create v<NEW> \
  --title "OSI OS v<NEW>" \
  --notes-file tmp/release-notes-<NEW>.md \
  --latest \
  tmp/release-assets/osi-os_<NEW>/osi-os_<NEW>-rpi5-factory.img.gz \
  tmp/release-assets/osi-os_<NEW>/osi-os_<NEW>-rpi4-factory.img.gz \
  tmp/release-assets/osi-os_<NEW>/SHA256SUMS
```

When the previous GitHub release with images is older than the previous
CHANGELOG version (for example 0.6.5 images, then a 0.7.0 that shipped no
image), image users skip the versions in between: append those CHANGELOG
sections to the notes file before creating the release.

Add a short image section to the notes: which file is for which Pi, and the
SHA-256 values from `SHA256SUMS`, so operators can verify downloads.

---

## Step 7 — Prepare deployment

Build the release payload and hand it to the deployment procedure for the target gateway. The stable-link path can serve `deploy.sh` from a local HTTP server; the flaky-link path uses the self-contained bundle scripts described in [Deploying over a flaky link](operations/deploying-over-a-flaky-link.md).

`deploy.sh` owns payload promotion, schema work, and the Node-RED restart. Read its verdict and the deployment runbook's post-deploy checks; do not add a separate manual restart after a green deploy.

---

## Step 8 — Deploy osi-server (if changed)

Do this before Step 9 whenever the pre-flight found a sync contract change,
and before any gateway linked to that cloud is upgraded.

Cloud environments:

| Role | Host |
|------|------|
| Production | `osicloud.ch` |
| Test | `server.opensmartirrigation.org` (`<test-host-address>`) |

Production access needs explicit consent in the current conversation; see
AGENTS.md, "Production cloud access". Do not store production SSH
credentials, private keys, or host aliases in this repo or local agent
memory. Use an ephemeral SSH key supplied for the specific rollout.

Follow the procedure in the `osi-server` repository rather than a copy here:
`DEPLOY.md`, section "Updating", and for production
`docs/operations/ghcr-pull-deploy-production.md`. In short: the backend
image is built in CI and pulled. Record the current `BACKEND_IMAGE_TAG` in
`.env` as the rollback target, pin the new `sha-<short>` tag, run
`scripts/verify-flyway-target.sh` against the target database before
pulling, then pull and recreate only the backend.

> **Never** run `docker compose up -d --build` (builds all services, overwhelms the VPS). Production has no from-source build path; do not run `docker compose build` there either.
> **Flyway ordering**: if a new migration uses date-based versioning (`V2026_05_16_*`), verify it sorts *after* the highest existing applied version. Check with:
> `docker exec osi-postgres psql -U osiserver -d osiserver -c "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 5;"`

---

## Step 9 — Deploy to the gateways and smoke test

Deploy to a test gateway first, then to the others, with the procedure from
Step 7. After each green deploy verdict, record the release version on the
gateway; `deploy.sh` does not do it (see Step 1):

```bash
ssh root@<pi-ip> 'uci set osi-server.cloud.firmware_version=<NEW> && uci commit osi-server'
```

`node-red.init` exports the value as `FIRMWARE_VERSION` when Node-RED starts,
so the heartbeat reports it from the next Node-RED start.

On each Pi after the deploy:

- [ ] `uci get osi-server.cloud.firmware_version` → `<NEW>`
- [ ] Login screen in browser shows `OSI OS v<NEW> (Alpha)`
- [ ] Dashboard loads without console errors
- [ ] Latest heartbeat visible in osi-server cloud (within 90 s)
- [ ] `osi-cloud-http` module resolves: `cat /srv/node-red/node_modules/osi-cloud-http/index.js | head -1`
- [ ] The post-deploy checks in `.claude/skills/osi-live-ops-runbook/SKILL.md`
      ("Post-deploy verification checklist") pass.
- [ ] For a linked gateway, the cloud canary passes:
      `OSI_ADMIN_TOKEN=<admin JWT> node scripts/deploy-canary-gate.js --eui <GATEWAY_EUI> --since <deploy-start ISO8601>`
      (see [docs/operations/deploy-canary-gate-runbook.md](operations/deploy-canary-gate-runbook.md)).

---

## Checklist summary

```
[ ] Pre-flight — mains merged, CI green (9 workflows), contract change decided
[ ] Step 1  — Bump every version location; run the verifiers
[ ] Step 1a — Refresh Chameleon calibrations; rerun the seed verifiers
[ ] Step 2  — Rename [Unreleased] to the release; new empty [Unreleased]
[ ] Step 3  — Rebuild React GUI + react_gui.tar.gz; refresh the feed GUI copy
[ ] Step 4  — Release PR, merge, CI green, tag v<NEW>, push only the tag
[ ] Step 5  — Build both factory images, rename, SHA256SUMS, first-boot check
[ ] Step 6  — GitHub Release (notes checked, images + SHA256SUMS attached)
[ ] Step 7  — Prepare deployment payload
[ ] Step 8  — Deploy osi-server first if the sync contract changed
[ ] Step 9  — Deploy to Pis (test gateway first), set firmware_version, smoke test
```
