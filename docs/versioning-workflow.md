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
- [ ] `osi-server` VPS is healthy (`docker compose ps` — all services Up/healthy).
- [ ] No uncommitted changes: `git status --short` is clean.
- [ ] Every CI workflow is green on the `main` commit you are releasing. There
      are ten: Codec Verifiers, Doc Hygiene, Field Journal Tests, History
      Router Tests, Journal Catalog Vendor Parity, Edge Migrations, GUI
      Typecheck & Unit Tests, UI Core Vendor Parity, Sync Flow Verifier,
      Test Inventory (`.github/workflows/*.yml`). Check with:
      ```bash
      gh run list --commit "$(git rev-parse origin/main)" --json workflowName,conclusion
      ```
      Ten entries, each `success`. A run still in progress is not green.
      Test Inventory (`node scripts/verify-test-inventory.js`) is the gate
      that fails when a test file exists that no workflow can fail on.
- [ ] Decide whether the sync contract changed since the previous release:
      ```bash
      git diff --stat v<OLD>..origin/main -- docs/contracts/
      ```
      Decide the order per change, by which side must accept the new form
      first. A change that widens what the edge sends (a new event,
      resource field or value) needs the cloud first: Step 6 before Steps 7
      and 9, because a cloud without the new appliers rejects the new events
      terminally. A change that widens what the cloud sends (a new or wider
      command field) needs the gateways first: an old edge refuses the new
      form. The CHANGELOG upgrade notes name the order for each such change.
- [ ] Identify a matching `osi-server` revision. Check it out (or the
      revision a cloud already runs, from its `BACKEND_IMAGE_TAG=sha-<short>`)
      and run the event-op parity check against it:
      ```bash
      OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server checkout>/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
        node scripts/verify-sync-op-parity.js
      ```
      `verify-sync-op-parity: OK` means that revision has an applier for
      every event op this edge emits; `FAIL` lists the ops it is missing.
- [ ] Luganda release gate: if the release goes to any gateway whose
      interface runs in Luganda (`lg`), every key in the "Release gate"
      section of `docs/i18n/pending-luganda-translations.md` has human
      Luganda, or the owner has accepted the English in writing for this
      release. Never fill a key by machine translation.
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

**What the version string reaches.** `96_osi_server_config` sets
`osi-server.cloud.firmware_version` when a flashed image boots for the first
time. `deploy.sh` reads the release version from the same file and writes it
to that key right after it flips to the new payload and before the restart
that starts it; every flip back to the previous payload restores the
previous value first. `node-red.init` reads the key when Node-RED starts, so
the deploy's own restart makes the heartbeat report the new version. A
missing `uci`, a missing `osi-server.cloud` section or a failed commit is
logged as a `WARN` and does not fail the deploy; the gateway then reports the
`node-red.init` fallback or the old value.

### Step 1a — Bundle Chameleon calibrations

Before the release commit, obtain the calibration snapshot with the refresh
script using an operator-supplied admin token in a private, unrecorded local
terminal. First run the seven-image parity gate. If it fails, stop the release
and inspect each image separately; one image is representative only after the
gate passes. Inspect every generated SQL row and every preexisting bundled
table row across all 17 columns. Review names, deployment-linked device
identifiers, private mappings and other fields that may be unfit for a public
repository. Decide whether every identifier is publishable. For each
`array_id` present in both the snapshot and the old image, decide whether
retaining all old column values is correct. Approve that retention explicitly
or stop the release for a separately reviewed update policy.

Apply the reviewed snapshot to all seven bundled images with `--require-rows`;
an empty-snapshot refusal stops the release. Run the seven-image parity gate
again *before* using one image to inspect the final table. Inspect every final
row and all 17 columns, including rows retained by `INSERT OR IGNORE`. If
parity fails, stop and inspect each image; do not assume the representative
row set covers the others. Record only
`public-row review passed; retained-old-value collisions approved` or
`release stopped: <nonidentifying category>`, without identifiers or row
values. Run the remaining checks, then commit the SQL and all seven images
with the release change.

The following commands are future release steps. The operator supplies
`CALIBRATION_ADMIN_TOKEN` privately in the shell environment. The placeholder
is not a token or a retrieval step for this campaign. If a parity gate fails
or a collision is disapproved, stop before the next command.

```bash
OSI_ADMIN_TOKEN="$CALIBRATION_ADMIN_TOKEN" node scripts/refresh-chameleon-calibrations.js
# Private terminal: inspect every generated INSERT and decide publishability.
less database/seeds/chameleon-calibrations.sql
calibration_review_sql='SELECT
  quote(array_id) AS array_id,
  quote(sensor_id) AS sensor_id,
  quote(sensor1_a) AS sensor1_a,
  quote(sensor1_b) AS sensor1_b,
  quote(sensor1_c) AS sensor1_c,
  quote(sensor1_r2) AS sensor1_r2,
  quote(sensor2_a) AS sensor2_a,
  quote(sensor2_b) AS sensor2_b,
  quote(sensor2_c) AS sensor2_c,
  quote(sensor2_r2) AS sensor2_r2,
  quote(sensor3_a) AS sensor3_a,
  quote(sensor3_b) AS sensor3_b,
  quote(sensor3_c) AS sensor3_c,
  quote(sensor3_r2) AS sensor3_r2,
  quote(test_rig_run_start_date) AS test_rig_run_start_date,
  quote(source) AS source,
  quote(fetched_at) AS fetched_at
FROM chameleon_calibrations
ORDER BY array_id;'
node scripts/verify-seed-db-ledger.js
# Private terminal: inspect every old row and compare overlapping keys with the SQL.
sqlite3 -readonly -line database/farming.db "$calibration_review_sql"
# For each collision, approve retained old values or stop the release.
node scripts/apply-chameleon-calibration-seed.js --require-rows
node scripts/verify-seed-db-ledger.js
# Private terminal: inspect every final row only after seven-image parity passes.
sqlite3 -readonly -line database/farming.db "$calibration_review_sql"
node --test scripts/test-apply-chameleon-calibration-seed.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
```

The query applies `quote()` to every named column, so `NULL` is visibly
different from empty text. Review its output privately and scroll through all
rows, including nullable `sensor*_r2` fields and metadata. Do not capture or
publish the output. If parity fails, stop and inspect every image separately
with the same query:

```bash
for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do
  printf '%s\n' "$db"
  sqlite3 -readonly -line "$db" "$calibration_review_sql"
done
```

Do not commit or publish until parity is repaired and the row review is
repeated. `verify-seed-db-ledger.js` checks all seven image digests alongside
ledger and schema fingerprints. `verify-profile-parity.js` covers only the
maintained profile pair. The focused writer test checks row values on
temporary copies.

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
cd web/react-gui && npm ci && npm run test:unit && npm run build
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

Commit the version bump, the CHANGELOG and the refreshed feed GUI on a
release branch and merge it through a pull request, so the CI workflows from
the pre-flight run on the release commit. The feed GUI is tracked in git;
`git add -A` on its directory also stages the deleted old hashed assets:

```bash
git switch -c release/v<NEW>
git add web/react-gui/src/pages/Login.tsx \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/96_osi_server_config \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/96_osi_server_config \
        feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-sync-flow.js \
        database/seeds/chameleon-calibrations.sql \
        conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        database/farming.db \
        web/react-gui/farming.db \
        .claude/skills/osi-config-and-flags/SKILL.md \
        README.md \
        CHANGELOG.md
git add -A -- feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
git status --short    # nothing left unstaged
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

Build both release images from the tagged commit with a clean
`git status` (the feed GUI from Step 3 is part of that commit), following
[docs/build/rpi5-full-osi-image.md](build/rpi5-full-osi-image.md) from "Pre-Build Verification" through "Build Pi 4 / 400 / 3 / 2":

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

## Step 6 — Deploy osi-server (if changed)

When the pre-flight found a change that needs the cloud first, this step
is mandatory and must be complete before the release is published (Step 7)
and before any linked gateway is upgraded (Step 9). A change that needs the
gateways first waits instead until Step 9 has reached the gateways that
receive the new form. Deploy the `osi-server` revision
that passed `verify-sync-op-parity.js` in the pre-flight, to every cloud
that has linked gateways.

Cloud environments:

| Role | Host |
|------|------|
| Production | `osicloud.ch` |
| Test | `server.opensmartirrigation.org` (`<test-host-address>`) |

Production access needs the user to name the host in the current turn; see
AGENTS.md, "Host access gate". Do not store production SSH
credentials, private keys, or host aliases in this repo or local agent
memory. Use an ephemeral SSH key supplied for the specific rollout.

Follow the procedure in the `osi-server` repository rather than a copy here:
`DEPLOY.md`, section "Updating", and for production
`docs/operations/ghcr-pull-deploy-production.md`. In short: the backend
image is built in CI and pulled. Record the current `BACKEND_IMAGE_TAG` in
`.env` as the rollback target, pin the new `sha-<short>` tag, run
`scripts/verify-flyway-target.sh` against the target database before
pulling, then pull and recreate only the backend.

The cloud is verified when the backend is healthy after the restart
(`docker compose ps`, `docker logs osi-backend` shows `Started`) and the
`sha-<short>` now in its `BACKEND_IMAGE_TAG` is the revision that passed the
parity check (rerun the check against that revision if in doubt).

> **Never** run `docker compose up -d --build` (builds all services, overwhelms the VPS). Production has no from-source build path; do not run `docker compose build` there either.
> **Flyway ordering**: if a new migration uses date-based versioning (`V2026_05_16_*`), verify it sorts *after* the highest existing applied version. Check with:
> `docker exec osi-postgres psql -U osiserver -d osiserver -c "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 5;"`

---

## Step 7 — GitHub Release

Publish only after Step 6 is verified when a contract change needs the cloud first.

Extract the release section into a notes file:

```bash
awk '/^## \[<NEW>\]/{on=1; print; next} on && /^## \[/{exit} on && !/^---$/' CHANGELOG.md \
  > tmp/release-notes-<NEW>.md
```

When the previous GitHub release with images is older than the previous
CHANGELOG version (for example 0.6.5 images, then a 0.7.0 that shipped no
image), image users skip the versions in between: append those CHANGELOG
sections to the notes file.

Add a short image section to the notes: which file is for which Pi, and the
SHA-256 values from `SHA256SUMS`, so operators can verify downloads.

Check the finished notes file, then create the release with both images and
the checksum file:

```bash
node scripts/verify-doc-hygiene.js --stdin < tmp/release-notes-<NEW>.md

gh release create v<NEW> \
  --title "OSI OS v<NEW>" \
  --notes-file tmp/release-notes-<NEW>.md \
  --latest \
  tmp/release-assets/osi-os_<NEW>/osi-os_<NEW>-rpi5-factory.img.gz \
  tmp/release-assets/osi-os_<NEW>/osi-os_<NEW>-rpi4-factory.img.gz \
  tmp/release-assets/osi-os_<NEW>/SHA256SUMS
```

---

## Step 8 — Prepare deployment

Build the release payload and hand it to the deployment procedure for the target gateway. The stable-link path can serve `deploy.sh` from a local HTTP server; the flaky-link path uses the self-contained bundle scripts described in [Deploying over a flaky link](operations/deploying-over-a-flaky-link.md).

`deploy.sh` owns payload promotion, schema work, and the Node-RED restart. Read its verdict and the deployment runbook's post-deploy checks; do not add a separate manual restart after a green deploy.

---

## Step 9 — Deploy to the gateways and smoke test

Deploy to a test gateway first, then to the others, with the procedure from
Step 8, and only after Step 6 when a contract change needs the cloud first. `deploy.sh`
writes the firmware version itself (see Step 1): its output shows
`OK: osi-server.cloud.firmware_version <previous> -> <NEW>` or `already
<NEW>`. A `WARN` line there means the key was not written.

A failed command-ledger activation can leave Node-RED and `osi-identityd`
stopped with the marker `/srv/node-red/.osi-command-ledger-hold`, which
records the reason and the time. The way out is to re-run the deploy: every
deploy reads the marker first and clears it once the ledger pair loads
(`.claude/skills/osi-live-ops-runbook/SKILL.md`, "Failed command-ledger
activation").

On each Pi after the deploy:

- [ ] No ledger hold: `ssh root@<pi-ip> 'test ! -e /srv/node-red/.osi-command-ledger-hold && echo no-hold'`
      prints `no-hold`
- [ ] `uci get osi-server.cloud.firmware_version` → `<NEW>`, and the
      heartbeat in the cloud reports `<NEW>`
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
[ ] Pre-flight — mains merged, CI green (all workflows), contract change decided,
                 matching osi-server revision found with verify-sync-op-parity
                 Luganda release gate checked (docs/i18n/pending-luganda-translations.md)
[ ] Step 1  — Bump every version location; run the verifiers
[ ] Step 1a — Refresh Chameleon snapshot; review every SQL, old and final row privately; approve or stop on collisions; apply with --require-rows; verify all seven images before representative inspection
[ ] Step 2  — Rename [Unreleased] to the release; new empty [Unreleased]
[ ] Step 3  — Rebuild React GUI + react_gui.tar.gz; refresh the feed GUI copy
[ ] Step 4  — Release PR (incl. feed GUI), merge, CI green, tag v<NEW>, push only the tag
[ ] Step 5  — Build both factory images, rename, SHA256SUMS, first-boot check
[ ] Step 6  — Deploy and verify osi-server (first when a contract change needs the cloud first)
[ ] Step 7  — GitHub Release (notes checked, images + SHA256SUMS attached)
[ ] Step 8  — Prepare deployment payload
[ ] Step 9  — Deploy to Pis (test gateway first), check version line and hold marker, smoke test
```
