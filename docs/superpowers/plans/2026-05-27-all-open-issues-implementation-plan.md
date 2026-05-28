# All Open Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining open GitHub issues across `osi-os` and `osi-server`, preserving edge-first sync semantics, avoiding speculative scope, and closing each issue only after focused verification evidence.

**Architecture:** Independently mergeable slices, not one giant branch. Cross-repo contracts (sync, LSN50 command payloads, Terra live field-state) get one documented contract and tests on both sides. Diagnostic work precedes infrastructure work — we do not build replay queues, alert lifecycles, or plugin registries until evidence shows they are needed.

**Tech Stack:** Node-RED `flows.json`, SQLite (edge), OpenWrt image profile files, React/Vite/TypeScript, Spring Boot/JPA/Flyway/PostgreSQL (cloud), Android Gradle, iOS WKWebView, Terra Intelligence React/Vitest.

---

## Issue Coverage

Issues open after triage on 2026-05-27. Each issue is assigned to exactly one slice.

**`osi-os`**
- `#61` Fix Chameleon depth save from the edge LSN50 configure panel → Slice 2
- `#56` Guarantee lossless edge→cloud sensor backup → Slice 1 (diagnostic-first)
- `#55` Bug: Environment tab fails on Uganda and shows bad forecast values on kaba100 → Slice 2
- `#50` Auto-grow writable rootfs on Raspberry Pi Path B installs → Slice 2
- `#47` Add i18n layer and translations (French, Swahili) → Slice 8
- `#33` S2120 card: no history/chart for wind, UV, barometric pressure, rain → Slice 8
- `#22` Dendrometer scheduling → Slice 10
- `#18` Implement Mclimate smart valve → Slice 10
- `#8` Integration of plugin system → Slice 11 (ADR-only)
- `#7` Set up error tracking → Slice 12

**`osi-server`**
- `#27` LSN50 mode change does not work from server device card → Slice 3
- `#24` Terra crop assets: maize stage coverage/cleanup → Slice 7
- `#23` Terra soil profile: layer background textures expose black seams → Slice 7
- `#22` Terra soil profile: live layer depths are fabricated thirds → Slice 6
- `#21` Terra: show unavailable matrix potential instead of fake -42 kPa → Slice 6
- `#20` Terra forecast rail: anchor to gateway-local time → Slice 6
- `#19` Terra: redesign sensor anchoring around device-level placement → Slice 4
- `#18` Terra: empty SWT probe selector does not explain missing inventory → Slice 5
- `#17` iPhone app: wrap OSI OS dashboard and Terra in a native iOS app → Slice 13
- `#14` Add back-to-dashboard navigation button in Terra → Slice 5
- `#13` Terra: sensor anchor / placement panel cannot be dismissed cleanly → Slice 5
- `#12` Terra: draw field control and sensor anchors panel overlap → Slice 5
- `#1` Multilanguage support → Slice 9

## Code Quality Guardrails

These guardrails enforce CLAUDE.md principles ("no speculative abstractions", "no error handling for impossible scenarios", "no half-finished migrations"):

- **Reuse existing infrastructure.** Server-side payload hashing already exists in `SyncPayloadCanonicalizer` (SHA-256 over canonicalized JSON with sorted keys, BigDecimal numbers, and UUID/EUI/timestamp normalization). Do not invent a parallel hash. If the edge needs to compute matching hashes, port the exact algorithm to JS in `scripts/sync-payload-canonicalizer.js`.
- **Diagnose before building.** Issues that hypothesize a system problem ("data loss", "needs alerts") begin with a measurement task that proves whether the problem is real. If the measurement shows no gap, the issue closes with evidence and no code change.
- **No speculative migrations.** Migrations that change a model must drop the legacy table in the same release, not leave dual read paths. Half-migrated state is forbidden.
- **No premature abstraction.** Plugin registry, alert lifecycles, and state-machine enums are abstractions. Defer until a concrete second user exists.
- **No `.toFixed()` on nullable numbers.** Any value that the contract permits to be `null` must be rendered through a helper that returns "Unavailable", not `.toFixed()` directly.
- **Operational safety.** Pi deployment must preserve `/data/db/farming.db`, profile parity, REST-only cloud-to-edge commands, and MQTT telemetry-only semantics.

## Common Prerequisites

- [ ] **Step 1: Confirm open issue inventory**

```bash
cd /home/phil/Repos/osi-os
gh issue list --repo Open-Smart-Irrigation/osi-os --state open --limit 100
gh issue list --repo Open-Smart-Irrigation/osi-server --state open --limit 100
```

Expected: the open issue numbers match the coverage list above, minus any issues already closed by newer work. If a covered issue is already closed, remove it from the plan.

- [ ] **Step 2: Snapshot working tree before starting any slice**

```bash
cd /home/phil/Repos/osi-os
git status --short --branch
cd /home/phil/Repos/osi-server
git status --short --branch
```

Expected: identify dirty files. Do not overwrite unrelated user changes.

- [ ] **Step 3: Apply TypeScript rule overlays before frontend edits**

Use the Read tool (or `cat`) — not a line-truncated `sed`/`head`, so the agent doesn't silently miss rules added past an arbitrary line cap:

```bash
cd /home/phil/Repos/osi-os
cat docs/agents/typescript-rule-overlays.md architect.yaml RULES.yaml

cd /home/phil/Repos/osi-server
cat docs/agents/typescript-rule-overlays.md architect.yaml RULES.yaml
```

Expected: each frontend task states which overlay matched the files being edited.

- [ ] **Step 4: Establish SSH access to live Pis**

`kaba100` (`100.93.68.86`) requires password auth. Create the askpass helper on this workstation:

```bash
cat > /tmp/ssh-askpass-osi.sh <<'EOF'
#!/bin/sh
# Reads the kaba100 root password from $KABA100_ROOT_PASSWORD.
# Exit non-zero if unset so the SSH attempt fails fast instead of hanging.
[ -n "$KABA100_ROOT_PASSWORD" ] || { echo "KABA100_ROOT_PASSWORD not set" >&2; exit 1; }
printf '%s\n' "$KABA100_ROOT_PASSWORD"
EOF
chmod 700 /tmp/ssh-askpass-osi.sh
```

Wrap every `ssh root@100.93.68.86` invocation in this plan with:

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh -o BatchMode=no root@100.93.68.86 '<command>'
```

`Silvan` (`100.81.220.8`) uses key auth and accepts bare `ssh root@100.81.220.8`. `Uganda` (`100.69.51.98`) uses password auth — apply the same askpass wrapper with `KABA100_ROOT_PASSWORD` swapped for `UGANDA_ROOT_PASSWORD`.

Expected: live Pi commands run non-interactively.

---

## Slice 1: Sensor History Gap — Diagnostic First

**Issues:** `osi-os#56`

**Why first:** Issue `#56` hypothesizes loss. The existing `sync_outbox` + `SyncResourceWatermark` system already gives at-least-once delivery with SHA-256 payload-hash dedup. Before building a replay queue, measure whether a gap actually exists. If the diagnostic shows no gap, close the issue with evidence and skip Slice 1b. If the gap is real, Slice 1b implements the minimum reconciliation needed.

**Files:**
- Create: `/home/phil/Repos/osi-os/scripts/diagnose-sensor-history-gap.js`
- Create: `/home/phil/Repos/osi-os/scripts/diagnose-sensor-history-gap.test.js`
- Create: `/home/phil/Repos/osi-os/scripts/fixtures/sensor-history-diagnostic/edge.json`
- Create: `/home/phil/Repos/osi-os/scripts/fixtures/sensor-history-diagnostic/cloud.json`

### Task 1.1: Build the diagnostic

- [ ] **Step 1: Write the test fixtures**

```bash
mkdir -p /home/phil/Repos/osi-os/scripts/fixtures/sensor-history-diagnostic
```

Create `/home/phil/Repos/osi-os/scripts/fixtures/sensor-history-diagnostic/edge.json` with three rows for one device:

```json
[
  {"deveui":"A84041FFFF000001","recorded_at":"2026-05-27T08:00:00.000Z"},
  {"deveui":"A84041FFFF000001","recorded_at":"2026-05-27T09:00:00.000Z"},
  {"deveui":"A84041FFFF000001","recorded_at":"2026-05-27T11:00:00.000Z"}
]
```

Create `/home/phil/Repos/osi-os/scripts/fixtures/sensor-history-diagnostic/cloud.json` with two of the three:

```json
[
  {"deveui":"A84041FFFF000001","recorded_at":"2026-05-27T08:00:00.000Z"},
  {"deveui":"A84041FFFF000001","recorded_at":"2026-05-27T11:00:00.000Z"}
]
```

- [ ] **Step 2: Write the failing test**

Create `/home/phil/Repos/osi-os/scripts/diagnose-sensor-history-gap.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { compareHistories } = require('./diagnose-sensor-history-gap');

const fixtures = path.join(__dirname, 'fixtures', 'sensor-history-diagnostic');

test('flags rows present on edge but missing on cloud', () => {
  const result = compareHistories({
    edgePath: path.join(fixtures, 'edge.json'),
    cloudPath: path.join(fixtures, 'cloud.json'),
    rangeStart: '2026-05-27T08:00:00.000Z',
    rangeEnd:   '2026-05-27T12:00:00.000Z'
  });
  assert.equal(result.edgeCount, 3);
  assert.equal(result.cloudCount, 2);
  assert.equal(result.missingOnCloud.length, 1);
  assert.equal(result.missingOnCloud[0].deveui,     'A84041FFFF000001');
  assert.equal(result.missingOnCloud[0].recordedAt, '2026-05-27T09:00:00.000Z');
});
```

Run:

```bash
cd /home/phil/Repos/osi-os
node --test scripts/diagnose-sensor-history-gap.test.js
```

Expected: FAIL — `compareHistories` not defined.

- [ ] **Step 3: Implement the diagnostic**

Create `/home/phil/Repos/osi-os/scripts/diagnose-sensor-history-gap.js`:

```js
'use strict';
const fs = require('node:fs');

function loadRows(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function identityKey(row) {
  return `${row.deveui}|${row.recorded_at}`;
}

function compareHistories({ edgePath, cloudPath, rangeStart, rangeEnd }) {
  const inRange = r => r.recorded_at >= rangeStart && r.recorded_at < rangeEnd;
  const edge  = loadRows(edgePath).filter(inRange);
  const cloud = loadRows(cloudPath).filter(inRange);
  const cloudKeys = new Set(cloud.map(identityKey));
  const missingOnCloud = edge
    .filter(r => !cloudKeys.has(identityKey(r)))
    .map(r => ({ deveui: r.deveui, recordedAt: r.recorded_at }));
  return { edgeCount: edge.length, cloudCount: cloud.length, missingOnCloud };
}

if (require.main === module) {
  const [, , edgePath, cloudPath, rangeStart, rangeEnd] = process.argv;
  if (!edgePath || !cloudPath || !rangeStart || !rangeEnd) {
    console.error('usage: diagnose-sensor-history-gap.js <edge.json> <cloud.json> <rangeStart> <rangeEnd>');
    process.exit(2);
  }
  const result = compareHistories({ edgePath, cloudPath, rangeStart, rangeEnd });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.missingOnCloud.length === 0 ? 0 : 1);
}

module.exports = { compareHistories, identityKey };
```

Run the test again. Expected: PASS.

### Task 1.2: Run against live data and decide

**Cloud schema note:** Server `sensor_data` is `(id, device_id FK → devices, recorded_at, data_json JSONB)` — there is no `gateway_eui`, `deveui`, or `sensor` column directly on the row. Joining through `devices` is mandatory. Sensor channel names live inside `data_json` as JSONB keys. Comparing at `(deveui, recorded_at)` tuples — not per-channel — is sufficient for "did this row sync at all?" (the question issue `#56` asks). Per-channel divergence is a separate concern not covered by this diagnostic.

- [ ] **Step 1: Dump 7 days of edge `(deveui, recorded_at)` tuples**

For each live Pi (kaba100, Silvan, Uganda), choose a 7-day window ending yesterday UTC. On kaba100:

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'sqlite3 /data/db/farming.db ".mode json" \
   "SELECT deveui, recorded_at FROM device_data WHERE recorded_at >= '\''2026-05-20T00:00:00Z'\'';"' \
  > /tmp/kaba100-edge.json
```

Repeat for each gateway. The diagnostic compares row identity (`deveui` + `recorded_at`), not individual sensor channels.

- [ ] **Step 2: Dump cloud-side `(deveui, recorded_at)` tuples for the same window**

Use the server's read-only diagnostic DB user with `SELECT` on `sensor_data` and `devices`:

```bash
psql "$OSI_SERVER_DSN" -A -F '|' -t -c \
  "SELECT d.deveui || '|' || to_char(sd.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
     FROM sensor_data sd \
     JOIN devices d ON d.id = sd.device_id \
    WHERE d.gateway_device_eui = '0016C001F11766E7' \
      AND sd.recorded_at >= '2026-05-20T00:00:00Z' \
      AND sd.recorded_at <  '2026-05-27T00:00:00Z';" \
  | jq -R 'split(\"|\") | {deveui:.[0], recorded_at:.[1]}' \
  | jq -s '.' > /tmp/kaba100-cloud.json
```

The gateway column on `devices` is `gateway_device_eui` (mapped from `Device.java:118` `gatewayDeviceEui`). If the deployed schema differs from `main`, verify with `psql -c '\d devices'` before running.

- [ ] **Step 3: Run the diagnostic**

```bash
cd /home/phil/Repos/osi-os
node scripts/diagnose-sensor-history-gap.js \
  /tmp/kaba100-edge.json /tmp/kaba100-cloud.json \
  2026-05-20T00:00:00.000Z 2026-05-27T00:00:00.000Z
```

Exit code 0 means no gap. Exit code 1 prints the missing identities.

- [ ] **Step 4: Decide and record**

Append the result to the issue:

```text
gateway: 0016C001F11766E7
window: 2026-05-20T00:00:00Z .. 2026-05-27T00:00:00Z
edge: <N> rows; cloud: <M> rows; missing-on-cloud: <K>
```

Branching:

- **K = 0 on all gateways** → close `osi-os#56` with the diagnostic output as evidence. Skip Task 1.3.
- **K > 0 and the missing rows are within `sync_outbox.last_attempt_at` retry window** → fix the outbox retry path (separate, targeted task in `flows.json`). Skip Task 1.3.
- **K > 0 and outbox shows the rows were never enqueued, or were enqueued but never acknowledged after exhausted retries** → proceed to Task 1.3.

- [ ] **Step 5: Commit the diagnostic**

```bash
cd /home/phil/Repos/osi-os
git add scripts/diagnose-sensor-history-gap.js scripts/diagnose-sensor-history-gap.test.js scripts/fixtures/sensor-history-diagnostic/
git commit -m "feat(diagnostics): add sensor history edge vs cloud gap diagnostic"
```

### Task 1.3 (Conditional): Build reconciliation only if Task 1.2 Step 4 selected this path

**Skip this task if K = 0 on all gateways. The decision recorded in Task 1.2 Step 4 is the gate.**

If proceeding, the reconciliation contract reuses the existing canonicalizer:

- **Hash algorithm:** SHA-256 hex over JSON canonicalized by `SyncPayloadCanonicalizer` (Java, server) and a JS port living at `/home/phil/Repos/osi-os/scripts/sync-payload-canonicalizer.js`. The JS port MUST produce byte-identical output to the Java version for a shared test vector set committed to both repos under `tests/sync-canonicalizer-vectors.json`.
- **Reading identity:** `${gatewayDeviceEui}|${devEui}|${sourceTable}|${recordedAtIsoMillis}|${channelSet}`. `channelSet` is the sorted, comma-joined list of non-null sensor column names in the row (e.g. `swt_1,swt_2`). `recordedAtIsoMillis` is the ms-precision UTC ISO string the canonicalizer produces.
- **Endpoint:** `POST /api/v1/sync/gateways/{eui}/sensor-history/reconciliation` with body `{readings:[{readingIdentity, payloadHash}]}`. No `rangeStart`/`rangeEnd` — server infers from the identity timestamps. Response: `{missingReadingIdentities:[...]}`.

Implement the rest in a separate plan `docs/superpowers/plans/<date>-sensor-history-reconciliation.md`. Do not implement reconciliation inside this plan — it would prejudge Task 1.2 Step 4.

---

## Slice 2: Edge Deployment, Runtime Safety, and Environment Tab Fix

**Issues:** `osi-os#61`, `osi-os#50`, `osi-os#55`

**Files:**
- Create: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/90_osi_rootfs_grow`
- Create: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/90_osi_rootfs_grow`
- Create: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-rootfs-resize`
- Create: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-rootfs-resize`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/environment/LocalTab.tsx`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/environment/ForecastTab.tsx`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/environment/WeatherTab.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/utils/forecastFormat.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/tests/environmentSummary.test.ts`
- Modify: `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js`
- Modify: `/home/phil/Repos/osi-os/README.md`

### Task 2.1: One-Shot Rootfs Grow Helper

Use `parted resizepart` instead of `sgdisk -d/-n` because parted's in-place resize avoids deleting and recreating the partition currently mounted as root. Verify `parted` and `resize2fs` are bundled in the image; if not, add them to the image profile package list.

- [ ] **Step 1: Confirm tooling is bundled**

```bash
cd /home/phil/Repos/osi-os
grep -nR 'parted\|e2fsprogs' conf/full_raspberrypi_bcm27xx_bcm2712/ | head
```

Expected: `parted` and `e2fsprogs` (which provides `resize2fs`) are listed in package selections or the image-builder manifest. If missing, add them to the profile package list before continuing.

- [ ] **Step 2: Add the failing verifier assertion**

Add to `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js` (alongside other `expectFileExists` style helpers):

```js
expectFileExists('conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/90_osi_rootfs_grow', 'bcm2712 ships rootfs grow uci-default');
expectFileExists('conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/90_osi_rootfs_grow', 'bcm2709 ships rootfs grow uci-default');
expectFileExists('conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-rootfs-resize',          'bcm2712 ships rootfs resize init');
expectFileExists('conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-rootfs-resize',          'bcm2709 ships rootfs resize init');
```

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: FAIL with the four missing-file messages.

- [ ] **Step 3: Add the partition-resize helper (bcm2712)**

Create `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/90_osi_rootfs_grow`:

```sh
#!/bin/sh
STAMP=/etc/osi-rootfs-grow.partitioned
NEEDS_RESIZE=/etc/osi-rootfs-grow-needs-resize

# Either the partition is already grown (STAMP) OR we're between a successful
# partition-grow and a not-yet-successful resize2fs (NEEDS_RESIZE). In both
# cases this script must exit cleanly so we never re-partition or re-reboot —
# the init.d resize will retry resize2fs on each boot until it succeeds.
[ -f "$STAMP" ]        && exit 0
[ -f "$NEEDS_RESIZE" ] && exit 0

ROOT_SRC="$(findmnt -n -o SOURCE /overlay 2>/dev/null || findmnt -n -o SOURCE / 2>/dev/null)"
case "$ROOT_SRC" in
  /dev/mmcblk0p2) DISK=/dev/mmcblk0; PART=2 ;;
  *) logger -t osi-rootfs-grow "unsupported root source $ROOT_SRC; skipping"; exit 0 ;;
esac

command -v parted    >/dev/null 2>&1 || { logger -t osi-rootfs-grow "parted missing; skipping";    exit 0; }
command -v resize2fs >/dev/null 2>&1 || { logger -t osi-rootfs-grow "resize2fs missing; skipping"; exit 0; }

logger -t osi-rootfs-grow "resizing $DISK partition $PART in place"
if ! parted -s "$DISK" --align optimal --pretend-input-tty <<EOF
resizepart $PART 100%
quit
EOF
then
  logger -t osi-rootfs-grow "parted resizepart failed; leaving partition unchanged"
  exit 0
fi

# Tell the kernel to re-read the partition table. partprobe is best-effort here.
partprobe "$DISK" 2>/dev/null || true

# Mark that the filesystem still needs to grow on next boot. Do NOT stamp the
# partition marker here — we only stamp after resize2fs succeeds, so power loss
# between reboot and resize2fs is recoverable by replaying the helper.
touch "$NEEDS_RESIZE"
logger -t osi-rootfs-grow "partition resized; rebooting to grow filesystem"
sync
reboot
```

- [ ] **Step 4: Add the post-reboot filesystem-grow init script (bcm2712)**

Create `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-rootfs-resize`:

```sh
#!/bin/sh /etc/rc.common
# Must run before Node-RED (default S50) so we never resize while RW services
# are pounding the filesystem.
START=08
STOP=
USE_PROCD=0

NEEDS_RESIZE=/etc/osi-rootfs-grow-needs-resize
STAMP=/etc/osi-rootfs-grow.partitioned

start() {
  [ -f "$NEEDS_RESIZE" ] || return 0
  ROOT_SRC="$(findmnt -n -o SOURCE /overlay 2>/dev/null || findmnt -n -o SOURCE / 2>/dev/null)"
  case "$ROOT_SRC" in
    /dev/mmcblk0p2) : ;;
    *) logger -t osi-rootfs-grow "unexpected root source $ROOT_SRC after partition grow; leaving marker"; return 0 ;;
  esac

  if resize2fs "$ROOT_SRC"; then
    rm -f "$NEEDS_RESIZE"
    touch "$STAMP"
    logger -t osi-rootfs-grow "filesystem grown; partition stamp committed"
  else
    logger -t osi-rootfs-grow "resize2fs failed; will retry on next boot"
  fi
}
```

- [ ] **Step 5: Mirror to bcm2709**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/90_osi_rootfs_grow \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/90_osi_rootfs_grow
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-rootfs-resize \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-rootfs-resize
chmod +x conf/full_raspberrypi_bcm27xx_bcm27{09,12}/files/etc/uci-defaults/90_osi_rootfs_grow \
         conf/full_raspberrypi_bcm27xx_bcm27{09,12}/files/etc/init.d/osi-rootfs-resize
```

Run:

```bash
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
```

Expected: PASS.

- [ ] **Step 6: Document Path B**

Append to `/home/phil/Repos/osi-os/README.md` under Path B:

```text
On first boot after a Path B deploy, OSI OS attempts a one-shot in-place resize
of the Raspberry Pi writable partition when the SD layout is the expected
two-partition mmcblk0 layout. The helper uses `parted resizepart` (in-place;
no delete/recreate) followed by a reboot, then a `resize2fs` pass on the next
boot. It is idempotent — power loss between reboot and `resize2fs` is recovered
on the next boot. It never touches /data/db/farming.db.
```

- [ ] **Step 7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712 conf/full_raspberrypi_bcm27xx_bcm2709 scripts/verify-sync-flow.js README.md
git commit -m "feat(rootfs): one-shot in-place rootfs grow on first boot (Path B)"
```

### Task 2.2: Chameleon Depth Live Verification (deploy-only)

**This task ships no source changes.** Edge support (`/api/devices/{deveui}/chameleon/depth`, the outbox trigger, sync_version bump) is already in `main` as of commits `e3758b9b`, `88b6f092`, `edb5d781`. The remaining work is verifying the live kaba100 deployment matches `main` and the save round-trips end-to-end. If a real bug surfaces during verification, raise it as a new sub-issue rather than re-editing flows here.

- [ ] **Step 1: Confirm local source state**

```bash
cd /home/phil/Repos/osi-os
git rev-parse HEAD
rg -n "chameleon/depth|chameleonSwt[123]DepthCm" web/react-gui/src \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
node scripts/verify-sync-flow.js
cd web/react-gui && npx tsx --test tests/draginoSettings.test.ts
```

Expected: HEAD includes `88b6f092` or later; ripgrep prints the active endpoint + DB columns; verifier passes; tests pass.

- [ ] **Step 2: Capture pre-deploy state on kaba100**

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'date -u +%Y-%m-%dT%H:%M:%SZ; df -h /overlay; \
   sqlite3 -header -column /data/db/farming.db \
     "SELECT name,deveui,chameleon_swt1_depth_cm,chameleon_swt2_depth_cm,chameleon_swt3_depth_cm,sync_version \
      FROM devices WHERE deveui IN (\"A84041A75D5E7CFB\",\"A84041CE3F5ECF52\");"' \
  > /tmp/kaba100-pre.txt
```

Expected: SSH works (askpass helper resolves); SQL prints current depths and sync_version. If SSH fails, stop and document the blocker on `osi-os#61`.

- [ ] **Step 3: Deploy without touching the database**

Run the production deploy wrapper (`/home/phil/bin/osi-os-deploy-live.sh` or equivalent). Confirm it does NOT copy `farming.db` (the wrapper must skip the seed when `/data/db/farming.db` exists with sidecars).

- [ ] **Step 4: Verify the deployed bundle has the new code path AND lacks the old one**

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'grep -R "chameleon/depth" /usr/lib/node-red/gui/assets || echo NEW_ENDPOINT_MISSING; \
   grep -R "chameleon-config\|setChameleonConfig" /usr/lib/node-red/gui/assets || echo OLD_ENDPOINT_ABSENT'
```

Expected:
- `chameleon/depth` grep prints at least one match in the minified bundle (positive assertion that the new bundle deployed).
- `chameleon-config|setChameleonConfig` grep prints `OLD_ENDPOINT_ABSENT` (negative assertion that the legacy strings are gone).

If `NEW_ENDPOINT_MISSING` is printed, the GUI bundle deploy did not run — re-run the GUI rollout step of the deploy wrapper.

- [ ] **Step 5: Smoke-test the endpoint (unauthenticated)**

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'curl -s -o /dev/null -w "%{http_code}\n" -X PUT \
     http://127.0.0.1:1880/api/devices/A84041CE3F5ECF52/chameleon/depth \
     -H "Content-Type: application/json" \
     -d "{\"chameleonSwt1DepthCm\":5,\"chameleonSwt2DepthCm\":10,\"chameleonSwt3DepthCm\":40}"'
```

Expected: prints `401` (auth required). Any 5xx is a bug — capture the response body in the issue.

- [ ] **Step 6: Save from the GUI and verify persistence**

Save Chameleon 2 depths in the LSN50 configure panel from a browser pointed at `http://100.93.68.86:1880/gui`, then:

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'sqlite3 -header -column /data/db/farming.db \
     "SELECT name,deveui,chameleon_swt1_depth_cm,chameleon_swt2_depth_cm,chameleon_swt3_depth_cm,sync_version \
      FROM devices WHERE deveui=\"A84041CE3F5ECF52\"; \
      SELECT event_type,aggregate_key,delivered_at FROM sync_outbox \
      WHERE aggregate_key LIKE \"%A84041CE3F5ECF52%\" ORDER BY id DESC LIMIT 5;"'
```

Expected: depth columns match the GUI-saved values, sync_version incremented from the pre-deploy snapshot, and a `device_updated` outbox row exists (delivered or pending). Attach this output to the issue.

### Task 2.3: Environment Tab Runtime Bugfix

- [ ] **Step 1: Reproduce live errors**

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.69.51.98 \
  'logread -e node-red | tail -n 200'
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'logread -e node-red | tail -n 200'
```

Expected: capture the Uganda 500 stack trace and a kaba100 forecast payload sample. If SSH is unavailable, copy the failing payload from a browser network inspector and create a local fixture under `web/react-gui/tests/fixtures/environment-summary-uganda.json`.

- [ ] **Step 2: Write failing tests**

Create `/home/phil/Repos/osi-os/web/react-gui/tests/environmentSummary.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatForecastHighLow } from '../src/utils/forecastFormat';

test('formats high/low when both finite', () => {
  assert.equal(formatForecastHighLow(28.4, 14.6), '28°/15°');
});

test('returns Unavailable when either side is null', () => {
  assert.equal(formatForecastHighLow(null, 14.6),      'Unavailable');
  assert.equal(formatForecastHighLow(28.4, null),      'Unavailable');
  assert.equal(formatForecastHighLow(undefined, null), 'Unavailable');
});

test('treats 0 as a valid value, not Unavailable', () => {
  assert.equal(formatForecastHighLow(0, -3), '0°/-3°');
});
```

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npx tsx --test tests/environmentSummary.test.ts
```

Expected: FAIL — `formatForecastHighLow` not defined.

- [ ] **Step 3: Add the helper**

Create `/home/phil/Repos/osi-os/web/react-gui/src/utils/forecastFormat.ts`:

```ts
export function formatForecastHighLow(
  highC: number | null | undefined,
  lowC:  number | null | undefined
): string {
  if (!Number.isFinite(highC as number) || !Number.isFinite(lowC as number)) return 'Unavailable';
  return `${Math.round(highC as number)}°/${Math.round(lowC as number)}°`;
}
```

Run the test. Expected: PASS.

- [ ] **Step 4: Replace direct number formatting in the three environment tabs**

In `LocalTab.tsx`, `ForecastTab.tsx`, `WeatherTab.tsx`, find every site that builds a `${high}°/${low}°` string or calls `.toFixed()` on a forecast value and route it through `formatForecastHighLow`. Do not introduce additional formatters in this task.

For `useTranslation('devices')` callsites in these files, wrap the helper call as:

```tsx
<span>{formatForecastHighLow(day.maxC, day.minC) === 'Unavailable'
  ? t('forecast.unavailable')
  : formatForecastHighLow(day.maxC, day.minC)}</span>
```

and add `"forecast.unavailable": "Unavailable"` to `web/react-gui/public/locales/en/devices.json` (other locales caught by Slice 8 parity check).

- [ ] **Step 5: Harden the Node-RED `Get Zone Environment Summary` endpoint**

In both profile `flows.json` files, locate the `Get Zone Environment Summary` function node. Wrap weather and provider section construction in try/catch that returns:

```json
{ "available": false, "source": null, "warnings": ["weather_provider_unavailable"] }
```

for the missing or failing section, instead of letting the response throw a 500. Do not change the shape of available sections.

- [ ] **Step 6: Verify**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
cd web/react-gui && npx tsx --test tests/environmentSummary.test.ts && npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/react-gui/src/utils/forecastFormat.ts \
        web/react-gui/src/components/farming/environment/ \
        web/react-gui/tests/environmentSummary.test.ts \
        web/react-gui/public/locales/en/devices.json \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "fix(environment): null-safe forecast formatting and resilient summary endpoint"
```

---

## Slice 3: LSN50 Mode — Diagnose the Actual Break (`osi-server#27`)

**Issues:** `osi-server#27` ("LSN50 mode change does not work from server device card")

**Why now:** Quick cross-repo fix that unblocks a live operator workflow.

**Important:** The backend endpoint **already exists** at [`DeviceController.java:307`](../../../osi-server/backend/src/main/java/org/osi/server/device/DeviceController.java#L307) — `PUT /api/devices/{deviceEui}/lsn50/mode` with a `Lsn50ModeRequest` body. It validates ownership and device type, enqueues a `SET_LSN50_MODE` gateway command with payload `{deviceEui, mode, modeCode, payloadHex, fPort}`. The actual bug from `#27` must be one of:

1. Frontend (`DraginoCard.tsx`) never calls the endpoint, or sends the wrong shape.
2. Edge does not honour the `SET_LSN50_MODE` pending command (handler missing, payload shape mismatch).
3. Edge handles it but the LoRaWAN downlink isn't acknowledged by the device.

Do NOT re-implement the backend. The slice is a contract audit + targeted fix on whichever layer is actually broken.

**Files (read-only first; modifications only after diagnosis):**
- Read: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/device/DeviceController.java` (lines 307-352)
- Read: `/home/phil/Repos/osi-server/frontend/src/components/farming/DraginoCard.tsx`
- Read: `/home/phil/Repos/osi-server/frontend/src/services/api.ts`
- Read: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (search for `SET_LSN50_MODE`)
- Modify: whichever layer the diagnosis identifies.

### Task 3.1: Cross-layer contract audit

- [ ] **Step 1: Capture the existing cloud payload shape**

```bash
sed -n '307,352p' /home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/device/DeviceController.java
```

Record verbatim: route path, request body shape (`Lsn50ModeRequest`), mode validation (uppercased `MOD1..MOD9`), and the gateway command payload keys: `deviceEui`, `mode`, `modeCode`, `payloadHex`, `fPort`.

- [ ] **Step 2: Capture the frontend call site**

```bash
cd /home/phil/Repos/osi-server
rg -n "lsn50/mode|setLsn50Mode|SET_LSN50_MODE|Lsn50Mode" frontend/src
```

Identify: does `frontend/src/services/api.ts` expose a `setLsn50Mode` function? Does `DraginoCard.tsx` actually call it? Does the user-visible mode picker submit a value the backend will accept (MOD1..MOD9 uppercase)?

- [ ] **Step 3: Capture the edge handler for `SET_LSN50_MODE`**

```bash
cd /home/phil/Repos/osi-os
rg -n "SET_LSN50_MODE|set_lsn50_mode" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  web/react-gui/src/services/api.ts
```

Identify the function node that processes pending commands of type `SET_LSN50_MODE`. Confirm it reads `deviceEui`, `payloadHex`, and `fPort` from the cloud-sent payload (the exact keys the cloud sends per Step 1). If the edge reads e.g. `devEui` (camel) when the cloud sends `deviceEui` (camel-with-Eui), that key mismatch is the bug.

- [ ] **Step 4: Classify the failure mode and pick a fix path**

Based on Steps 1–3, classify into ONE of:

```text
A. Frontend never calls / sends wrong shape → fix only frontend/src
B. Edge handler missing / wrong key      → fix only flows.json + add an edge contract test
C. Edge handler correct, downlink times out → fix is operational (gateway radio, device asleep) — not in scope; document and close as wontfix-here
D. Mixed                                    → multiple narrow fixes, each tested independently
```

Record the classification in `osi-server#27` before continuing.

### Task 3.2: Fix the broken layer (path A — frontend only)

**The API client already exists.** [`frontend/src/services/api.ts:584`](../../../osi-server/frontend/src/services/api.ts#L584) exposes `lsn50API.setMode(deviceEui, mode)` which calls `PUT /api/v1/devices/{deviceEui}/lsn50/mode` with body `{ mode }`. Do NOT add a new `setLsn50Mode` function and do NOT change the route — the route prefix is `/api/v1` (backend `@RequestMapping("/api/v1")` at `DeviceController.java:27`). Any new code that calls `/api/devices/...` (without `/v1`) is a regression.

Path A is about the **call site** in `DraginoCard.tsx`: does the mode picker invoke `lsn50API.setMode()` and surface queued/success/failure correctly?

- [ ] **Step 1: Failing frontend test**

Create `frontend/src/components/farming/__tests__/DraginoCard.test.tsx` asserting:

```text
mode picker change calls lsn50API.setMode(deviceEui, 'MOD1')
successful resolution sets local UI state to "Queued"/"Sent" (matching existing convention)
rejection sets local UI state to "Failed" with error message visible
mode picker is disabled while the in-flight request is pending
```

Mock `lsn50API.setMode` (or the `api.put` it uses) — do NOT hit a real server.

Run:

```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit -- DraginoCard
```

Expected: FAIL.

- [ ] **Step 2: Hook up `DraginoCard.tsx`**

Import `lsn50API` from `../services/api`. On picker change, call `await lsn50API.setMode(deviceEui, mode)` where `mode` is the picker's value normalized to uppercase `MOD1..MOD9` (the backend uppercases too, but normalizing client-side keeps the UI predictable). Track in-flight state and surface queued/error to the user the same way the existing `setUplinkInterval`/`setRainGaugeEnabled` controls in this card do — match the existing pattern, do not introduce a new state-management abstraction.

Run the test. Expected: PASS.

### Task 3.3: Fix the broken layer (path B — edge handler only)

- [ ] **Step 1: Failing edge contract test**

Add an assertion to `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js`:

```text
flows.json must contain a function node that, when receiving a pending command
with commandType="SET_LSN50_MODE", reads (deviceEui, payloadHex, fPort) from
the payload exactly as the cloud sends them.
```

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
```

Expected: FAIL if the edge currently uses a different key (e.g. `devEui` vs `deviceEui`).

- [ ] **Step 2: Fix the function node**

Update the `SET_LSN50_MODE` handler in both `flows.json` profiles to read the canonical keys. Re-run the verifier. Expected: PASS.

### Task 3.4: Verify end-to-end and commit

If path A:
```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit && npm run build
git add frontend
git commit -m "fix(devices): wire LSN50 mode picker to existing backend endpoint"
```

If path B:
```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js && node scripts/verify-profile-parity.js
git add scripts conf
git commit -m "fix(flows): SET_LSN50_MODE handler reads canonical cloud payload keys"
```

Live verification: from the cloud device card, change a LSN50 mode for `kaba100`'s LSN50 device, then on kaba100:

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'sqlite3 -header -column /data/db/farming.db \
     "SELECT command_id, command_type, device_eui, result, result_detail, applied_at \
      FROM applied_commands \
      WHERE command_type='\''SET_LSN50_MODE'\'' \
      ORDER BY applied_at DESC LIMIT 3;"'
```

**Edge ACK ledger:** the edge does NOT have a `pending_commands` table. After polling and dispatching a cloud-issued command, the edge writes the outcome to `applied_commands` (verified in `flows.json`: `INSERT OR REPLACE INTO applied_commands(command_id, effect_key, device_eui, command_type, result, applied_at, result_detail, originator)`). The same row is also queued to `command_ack_outbox` for cloud-bound delivery.

Expected: a row appears in `applied_commands` within ~30s of the cloud action with `result='success'` (or `result='failure'` plus a populated `result_detail` if the LoRaWAN downlink did not ack). Attach the output to `osi-server#27`.

---

## Slice 4: Terra Device-Level Anchor Model (data migration before UI)

**Issues:** `osi-server#19`

**Why now:** Slice 6 (Terra live data) reads the anchor model. Changing the model after Terra is already keyed to the old shape would mean writing Terra twice. We migrate first, then build on the new model.

**Files:**
- Create: `/home/phil/Repos/osi-server/backend/src/main/resources/db/migration/V2026_05_27_001__device_level_sensor_anchors.sql`
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/zone/ZoneSensorAnchor.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/zone/ZoneSensorAnchorPayloads.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/zone/ZoneSensorAnchorService.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/prediction/PredictionSpatialUnitAssembler.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/zone/ZoneSensorAnchorServiceTest.java`

### Task 4.1: Migration with one-step cutover

**No dual-table reads.** The migration creates the new table, backfills from the old table in the same transaction, drops the old table, and updates the JPA entity to point at the new name. Half-migrated state is forbidden by the guardrails.

**Current schema (V38):** `zone_sensor_anchors(id, zone_id FK irrigation_zones, device_eui, probe_key, longitude, latitude, active, created_at, updated_at)`. There is no `label` column — child probes are identified by `probe_key`. The unique index is `(zone_id, device_eui, probe_key)`. The new table collapses this to one row per `(zone_id, device_eui)`.

**Migration naming — do NOT change to `V42__…`.** The repo uses two coexisting Flyway version schemes: the older sequential `V38__`…`V41__` and the newer date-prefixed `V2026_05_16_010__`…`V2026_05_20_001__`. Flyway compares versions numerically, so `V41` = `41` and `V2026_05_20_001` = `2026.05.20.001` — the date-prefixed migrations are already applied at versions far higher than `42`. `application.yml:20` does NOT enable `outOfOrder`, so a new `V42__…` would be older than already-applied migrations and Flyway would refuse it. The correct next migration name continues the date-prefixed convention: `V2026_05_27_001__device_level_sensor_anchors.sql`.

- [ ] **Step 0: Verify the current schema before writing the migration**

```bash
cd /home/phil/Repos/osi-server
cat backend/src/main/resources/db/migration/V38__zone_sensor_anchors.sql
```

Expected: columns match the description above. If the schema has evolved past V38, adjust the migration accordingly before continuing.

- [ ] **Step 1: Write the migration**

Create `V2026_05_27_001__device_level_sensor_anchors.sql`:

```sql
CREATE TABLE zone_device_sensor_anchors (
  id          BIGSERIAL PRIMARY KEY,
  zone_id     BIGINT NOT NULL REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  device_eui  VARCHAR(32) NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  latitude    DOUBLE PRECISION NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(zone_id, device_eui)
);

CREATE INDEX IF NOT EXISTS idx_zone_device_sensor_anchor_zone
  ON zone_device_sensor_anchors(zone_id);

-- Backfill: one row per (zone, device) using the earliest active probe coordinate.
-- `id ASC` is a stable tie-breaker for rows that share created_at (probes can
-- be inserted in the same transaction with identical timestamps).
INSERT INTO zone_device_sensor_anchors (zone_id, device_eui, longitude, latitude, active, created_at, updated_at)
SELECT DISTINCT ON (zone_id, device_eui)
       zone_id, device_eui, longitude, latitude, active, created_at, updated_at
  FROM zone_sensor_anchors
 ORDER BY zone_id, device_eui, active DESC, created_at ASC, id ASC;

DROP TABLE zone_sensor_anchors;
```

Column types mirror V38 (`TIMESTAMPTZ`, `BOOLEAN active`) so JPA mappings keep the same types. `probe_key` is intentionally dropped — probes are derived from `devices` columns at read time.

- [ ] **Step 2: Update the JPA entity and payloads**

Rename `ZoneSensorAnchor` to map to `zone_device_sensor_anchors`. Remove the `probeKey` field from the entity. Probes are derived at read time from `devices` rows joined by `device_eui`.

Update `ZoneSensorAnchorPayloads` so the API exposes one anchor per device, with child probes as a nested array `probes:[{slot:"swt_1", depthCm:5}, ...]` computed from device columns (e.g. `chameleon_swt1_depth_cm`).

Update the repository: any `findByZoneAndDeviceAndProbe` style methods become `findByZoneAndDevice`. Audit all callers — `ZoneSensorAnchorService`, `PredictionSpatialUnitAssembler`, controllers, and tests — and remove `probeKey` from request bodies and DTOs (or accept and ignore for one release if a Terra client still sends it).

- [ ] **Step 3: Update prediction assembly**

In `PredictionSpatialUnitAssembler`, anchor coordinates are now device-level. Map each probe depth to the device coordinate when building spatial units. The previous per-probe coordinate path is gone — assert in a test that two probes on the same device produce two spatial units at the same `(lat, lng)`.

- [ ] **Step 4: Tests**

Replace existing per-probe tests with:

```text
one device with swt_1/swt_2/swt_3 has exactly one anchor coordinate and three probes
two devices have two coordinates
backfill preserves earliest coordinate when a device previously had per-probe rows
prediction assembler maps all probe depths to the device coordinate
```

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.zone.ZoneSensorAnchorServiceTest \
                --tests org.osi.server.prediction.PredictionSpatialUnitAssemblerTest \
                --tests org.osi.server.sync.EdgeSyncServiceControlPlaneTest
```

Expected: PASS. The control-plane test catches sync regressions from the entity rename.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server
git add backend
git commit -m "feat(zones): collapse anchors to device-level with one-step migration"
```

---

## Slice 5: Terra Empty-Probe Reasons, Dismissible Placement, Back-to-Dashboard

**Issues:** `osi-server#18`, `osi-server#13`, `osi-server#12`, `osi-server#14`

**Files:**
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/zone/ZoneSensorAnchorPayloads.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/zone/ZoneSensorAnchorService.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/zone/ZoneSensorAnchorServiceTest.java`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/hooks/useLiveData.ts`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/App.tsx`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/styles.css`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/useLiveData.test.ts`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/mobileControls.test.tsx`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/mobileUx.test.tsx`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/mobileCss.test.ts`

### Task 5.1: Empty Probe Reasons (`osi-server#18`)

- [ ] **Step 1: Backend tests**

In `ZoneSensorAnchorServiceTest`, assert `/sensor-anchors` returns one of:

```text
NO_ASSIGNED_SWT_DEVICES
NO_PROBE_DEPTH_INVENTORY
LOAD_FAILED
OK
```

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.zone.ZoneSensorAnchorServiceTest
```

Expected: FAIL.

- [ ] **Step 2: Add the response field**

In `ZoneSensorAnchorPayloads`:

```java
public enum EmptyProbeReason {
    NO_ASSIGNED_SWT_DEVICES,
    NO_PROBE_DEPTH_INVENTORY,
    LOAD_FAILED
}
```

`availableProbes` empty → set `emptyProbeReason`. `availableProbes` non-empty → `null`.

- [ ] **Step 3: Terra UI copy**

In `useLiveData.ts`, preserve the reason. In `App.tsx`, render:

```text
NO_ASSIGNED_SWT_DEVICES   → "No SWT devices assigned to this zone."
NO_PROBE_DEPTH_INVENTORY  → "Probe depths are missing. Configure probe depths on the edge and sync again."
LOAD_FAILED               → "Live sensor anchors failed to load."
```

The placement controls are disabled when no eligible probes exist, but the panel itself remains dismissible.

### Task 5.2: Dismissible Placement (`osi-server#13`)

**No 4-state machine.** The existing panel has implicit coupling between `activeAnchorKey` and panel visibility. Decoupling is enough — a single `isPlacementPanelOpen: boolean` controls visibility; saving is tracked by an existing `saveStatus: 'idle'|'saving'|'error'`.

- [ ] **Step 1: Failing tests**

In `__tests__/mobileUx.test.tsx`, add:

```text
cancel with a selected probe closes the panel and clears activeAnchorKey
cancel with no eligible probes still closes the panel
panel will not close while saveStatus === 'saving'
re-opening preserves unsaved draft data unless user explicitly cleared it
```

Run the tests. Expected: FAIL.

- [ ] **Step 2: Decouple panel visibility from `activeAnchorKey`**

In `App.tsx`, introduce `const [isPlacementPanelOpen, setIsPlacementPanelOpen] = useState(false);` and gate the panel render on this flag. Cancel handler clears `activeAnchorKey` and sets `isPlacementPanelOpen = false` only when `saveStatus !== 'saving'`.

Run the tests. Expected: PASS.

### Task 5.3: Overlay Layout (`osi-server#12`)

- [ ] **Step 1: CSS test**

In `__tests__/mobileCss.test.ts`, assert draw controls and anchor panel use different CSS grid zones, that touch targets are ≥44px, and that Mapbox attribution is not covered.

- [ ] **Step 2: Refactor CSS only**

In `styles.css`, move draw controls, anchor panel, tool stack, live status, and mobile controls into coordinated zones. No JSX restructure — only class additions and CSS grid placement.

### Task 5.4: Back-to-Dashboard Button (`osi-server#14`)

- [ ] **Step 1: URL resolution test (Vitest)**

```ts
import { describe, test, expect } from 'vitest';
import { resolveDashboardUrl } from '../lib/resolveDashboardUrl';

describe('resolveDashboardUrl', () => {
  test('priority: query > env > default', () => {
    expect(resolveDashboardUrl({ search: '?dashboardUrl=https://a.test', env: 'https://b.test' })).toBe('https://a.test');
    expect(resolveDashboardUrl({ search: '',                             env: 'https://b.test' })).toBe('https://b.test');
    expect(resolveDashboardUrl({ search: '',                             env: undefined         })).toBe('/dashboard');
  });
});
```

Run. Expected: FAIL.

- [ ] **Step 2: Implement and render**

Add `resolveDashboardUrl` and a compact button in `App.tsx`. Button renders unconditionally — no "embedded mode" detection in this pass.

### Task 5.5: Verify

```bash
cd /home/phil/Repos/osi-server/terra-intelligence
npm test
npm run build
```

Expected: PASS.

```bash
cd /home/phil/Repos/osi-server
git add backend terra-intelligence
git commit -m "feat(terra): empty-probe reasons, dismissible placement, dashboard nav"
```

---

## Slice 6: Terra Live Data Correctness

**Issues:** `osi-server#21`, `osi-server#22`, `osi-server#20`

**Files:**
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/prediction/PredictionFieldStatePayloads.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/prediction/PredictionFieldStateService.java`
- Modify: `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/prediction/PredictionFieldStateServiceTest.java`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/terraLive.ts`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/App.tsx`
- Create: `/home/phil/Repos/osi-server/terra-intelligence/src/lib/formatMatrixPotential.ts`
- Create: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/formatMatrixPotential.test.ts`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/terraLive.test.ts`

### Task 6.1: Remove Fake Matrix Potential at ALL sites

The `-42` fallback appears at four sites in `terraLive.ts` (lines ~498, ~515, ~557, ~626). `App.tsx` calls `.toFixed(0)` on `matrixPotentialKpa` at four sites (~1309, ~1442, ~1459, ~1521) which will throw once values become null. Both must be addressed.

- [ ] **Step 1: Format helper test**

Create `__tests__/formatMatrixPotential.test.ts` (terra-intelligence uses **Vitest**, not `node:test`):

```ts
import { describe, test, expect } from 'vitest';
import { formatMatrixPotentialKpa } from '../lib/formatMatrixPotential';

describe('formatMatrixPotentialKpa', () => {
  test('formats finite kPa to integer', () => {
    expect(formatMatrixPotentialKpa(-42)).toBe('-42 kPa');
    expect(formatMatrixPotentialKpa(0)).toBe('0 kPa');
    expect(formatMatrixPotentialKpa(-12.7)).toBe('-13 kPa');
  });

  test('returns "Unavailable" for null, undefined, NaN', () => {
    expect(formatMatrixPotentialKpa(null)).toBe('Unavailable');
    expect(formatMatrixPotentialKpa(undefined)).toBe('Unavailable');
    expect(formatMatrixPotentialKpa(NaN)).toBe('Unavailable');
  });
});
```

Run. Expected: FAIL.

- [ ] **Step 2: Implement helper**

Create `terra-intelligence/src/lib/formatMatrixPotential.ts`:

```ts
export function formatMatrixPotentialKpa(value: number | null | undefined): string {
  return Number.isFinite(value as number)
    ? `${Math.round(value as number)} kPa`
    : 'Unavailable';
}
```

Run. Expected: PASS.

- [ ] **Step 3: Failing tests for the live-data layer**

In `terraLive.test.ts`:

```text
missing day.matrixPotentialKpa returns null on profile metrics
missing layer.tensionKpa keeps the layer matrixPotentialKpa as null
interpolation of (null, n) returns null
interpolation of (n, null) returns null
interpolation of (n, m) returns linear interp
```

Run. Expected: FAIL.

- [ ] **Step 4: Replace fallbacks in `terraLive.ts`**

Replace the four `-42` sites with null-preserving code. For the layer site at ~498:

```ts
const layerTension = layer?.tensionKpa;
const matrixPotentialKpa = layerAvailable
  ? (Number.isFinite(layerTension) ? layerTension
     : (Number.isFinite(day.matrixPotentialKpa) ? day.matrixPotentialKpa : null))
  : null;
```

For the day-level site at ~515:

```ts
matrixPotentialKpa: Number.isFinite(day?.matrixPotentialKpa) ? day.matrixPotentialKpa : null,
```

For the two `interp` sites at ~557 and ~626, add a null-aware helper:

```ts
const interpNullable = (a: number | null, b: number | null) =>
  (a == null || b == null) ? null : interp(a, b);
```

and use it for `matrixPotentialKpa`.

Run `terraLive.test.ts`. Expected: PASS.

- [ ] **Step 5: Replace `.toFixed()` sites in `App.tsx`**

In each of the four App.tsx sites (~1309, ~1442, ~1459, ~1521), replace `${value.toFixed(0)} kPa` with `formatMatrixPotentialKpa(value)`. Import the helper at the top of the file.

- [ ] **Step 6: Grep for residual unsafe patterns**

```bash
cd /home/phil/Repos/osi-server/terra-intelligence
rg -n 'matrixPotentialKpa\s*\?\?\s*-42' src
rg -n 'matrixPotentialKpa[^A-Za-z0-9_]*\.toFixed' src
```

Expected: both greps return nothing.

### Task 6.2: Real or Explicitly-Inferred Layer Depths

Keep it simple — `inferred: boolean`, not a two-value string enum.

- [ ] **Step 1: Tests**

In `terraLive.test.ts`:

```text
valid layerStates produce horizons with inferred=false and integer-cm boundaries
missing layerStates produce three inferred horizons with inferred=true
inferred horizon labels are whole-cm, never fractional 0.333333
```

- [ ] **Step 2: Extend the live soil type**

In `terraLive.ts`:

```ts
type LiveSoilHorizon = {
  depthTopCm: number;
  depthBottomCm: number;
  inferred: boolean;
};
```

- [ ] **Step 3: Use `layerStates` when present**

When `layerStates` exists, map directly to horizons with `inferred: false` and round to whole cm. When missing, keep the existing three-layer fallback but set `inferred: true` and round display labels to whole cm.

- [ ] **Step 4: Label format**

Render inferred labels as `"0–18 cm (inferred)"` not raw floats.

### Task 6.3: Gateway-Local Forecast Anchor

- [ ] **Step 1: Backend contract test**

In `PredictionFieldStateServiceTest`, assert responses include:

```json
{
  "forecastAnchorIso": "2026-05-27T08:15:00+03:00",
  "forecastAnchorTimezone": "Africa/Kampala",
  "forecastAnchorSource": "gateway"
}
```

Use `Clock.fixed` for determinism.

- [ ] **Step 2: Add fields**

Extend `PredictionFieldStatePayloads`; populate from the gateway/zone timezone in `PredictionFieldStateService`. Keep the legacy date-only field on the payload during this release.

- [ ] **Step 3: Terra rail**

In `terraLive.ts`, parse `forecastAnchorIso` (fall back to the legacy date if missing) and expose a rail start. In `App.tsx`, initialize the live forecast rail from the parsed anchor, not a UTC default. Demo mode keeps its fixed demo anchor.

### Task 6.4: Verify

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.prediction.PredictionFieldStateServiceTest
cd ../terra-intelligence
npm test
npm run build
```

Expected: PASS.

```bash
cd /home/phil/Repos/osi-server
git add backend terra-intelligence
git commit -m "fix(terra): null-safe matrix potential, inferred layer labels, gateway-local forecast anchor"
```

---

## Slice 7: Terra Visual Rendering — Maize Assets and Soil Background

**Issues:** `osi-server#24`, `osi-server#23`

**Files:**
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/assets/v3_processed/crop-maize-*.png`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/cropVisuals.ts`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/App.tsx`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/styles.css`
- Create: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/maizeAssetCoverage.test.ts`
- Modify: `/home/phil/Repos/osi-server/terra-intelligence/src/__tests__/cropCssClasses.test.ts`

### Task 7.1: Maize Asset Coverage Only

Scope: maize only. Other crops are not in regression scope for this issue. Do not assert universal 4-stage coverage.

- [ ] **Step 1: Failing test**

Create `__tests__/maizeAssetCoverage.test.ts` (Vitest; the actual export is `CROP_IMAGES`; the phenology stage keys are `initial / development / mid_season / late_season`, but the *asset filenames* historically use `seedling / development / mature / late_season`):

```ts
import { describe, test, expect } from 'vitest';
import { CROP_IMAGES } from '../cropVisuals';

const STAGE_KEYS = ['initial', 'development', 'mid_season', 'late_season'] as const;

describe('maize crop image coverage', () => {
  test('CROP_IMAGES.maize has all four phenology stages', () => {
    for (const stage of STAGE_KEYS) {
      const src = CROP_IMAGES.maize?.[stage];
      expect(src, `missing maize ${stage} image`).toBeTruthy();
      expect(src).toMatch(/crop-maize-.*\.png$/);
    }
  });

  test('each stage points at a stage-specific file (no shared placeholder)', () => {
    const seen = new Set<string>();
    for (const stage of STAGE_KEYS) seen.add(CROP_IMAGES.maize[stage]);
    expect(seen.size).toBe(STAGE_KEYS.length);
  });
});
```

Run. Expected: FAIL if any of the four maize images are missing, or if any two stages share the same file.

- [ ] **Step 2: Regenerate/clean PNGs**

The four maize asset files on disk are `crop-maize-seedling.png`, `crop-maize-development.png`, `crop-maize-mature.png`, `crop-maize-late_season.png`. Replace with cleaned versions. Keep transparent backgrounds; do not hide artifacts with opaque masks. Match canvas size and baseline alignment to the other stage files for the same crop so plants do not float.

- [ ] **Step 3: Wire the four files**

In `cropVisuals.ts`, the `CROP_IMAGES.maize` map already references all four files (verify with the existing line `maize: { initial: maizeCropSeedling, development: maizeCropDevelopment, mid_season: maizeCropMature, late_season: maizeCropLateSeason }`). Confirm each import points at the cleaned file from Step 2.

Run the test. Expected: PASS.

### Task 7.2: Continuous Soil Profile Background

- [ ] **Step 1: CSS test**

In `cropCssClasses.test.ts`:

```text
no horizon style produces a black base color
horizon percentages sum to 100 after rounding
thin (<5%) layers use overlap or continuous-background strategy
```

- [ ] **Step 2: Render a continuous backing**

In `App.tsx` and `styles.css`, render a single soil-column background div behind the per-horizon styled layers. Per-layer textures clip from a shared coordinate system. Do not force equal layer heights.

### Task 7.3: Verify

```bash
cd /home/phil/Repos/osi-server/terra-intelligence
npm test
npm run build
```

Expected: PASS. Manually capture screenshots for three-layer, thin-layer, inferred-layer, and maize-at-each-stage views; attach to the closing comments.

```bash
cd /home/phil/Repos/osi-server
git add terra-intelligence
git commit -m "fix(terra): maize stage assets and continuous soil-profile background"
```

---

## Slice 8: Edge i18n (French audit + Swahili) and S2120 History

**Issues:** `osi-os#47`, `osi-os#33`

**Files:**
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/i18n/config.ts`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/public/locales/en/*.json`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/public/locales/fr/*.json`
- Create: `/home/phil/Repos/osi-os/web/react-gui/public/locales/sw/*.json`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/SenseCapWeatherCard.tsx`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/SensorMonitor.tsx`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/services/api.ts`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/types/farming.ts`
- Create: `/home/phil/Repos/osi-os/scripts/check-locale-parity.js`
- Create: `/home/phil/Repos/osi-os/web/react-gui/tests/s2120HistoryFields.test.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/weatherHistoryFields.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/tests/i18nRenderSmoke.test.tsx`

### Task 8.1: Locale Parity Including Existing `fr`

`fr/` already exists alongside `lg/`. The parity check will likely surface gaps in `fr` too; treat `fr` completion as in-scope for issue `#47`.

- [ ] **Step 1: Failing parity check**

Create `/home/phil/Repos/osi-os/scripts/check-locale-parity.js`:

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'web/react-gui/public/locales');

function loadKeys(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  (function walk(node, p) {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, p ? `${p}.${k}` : k);
    } else {
      out.push(p);
    }
  })(data, '');
  return out;
}

const enDir = path.join(root, 'en');
const namespaces = fs.readdirSync(enDir).filter(f => f.endsWith('.json'));
const locales = fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory() && d !== 'en');
let failures = 0;
for (const ns of namespaces) {
  const enKeys = new Set(loadKeys(path.join(enDir, ns)));
  for (const loc of locales) {
    const locPath = path.join(root, loc, ns);
    if (!fs.existsSync(locPath)) {
      console.error(`missing ${loc}/${ns}: file does not exist`);
      failures++;
      continue;
    }
    const locKeys = new Set(loadKeys(locPath));
    for (const k of enKeys) if (!locKeys.has(k)) { console.error(`missing ${loc}/${ns}: ${k}`); failures++; }
  }
}
process.exit(failures === 0 ? 0 : 1);
```

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/check-locale-parity.js
```

Expected: FAIL with gaps in `fr/`, `lg/`, possibly others.

- [ ] **Step 2: Move hardcoded strings (per-file, separately committed)**

For each file below, in this order, add `useTranslation('devices')`, replace hardcoded strings with `t(...)` calls, and commit individually so a single file's translation drift can be reverted without losing the others:

```text
web/react-gui/src/pages/FarmingDashboard.tsx
web/react-gui/src/components/farming/SystemPanel.tsx
web/react-gui/src/components/farming/ZoneConfigModal.tsx
web/react-gui/src/components/farming/IrrigationZoneCard.tsx
web/react-gui/src/components/farming/SenseCapWeatherCard.tsx
web/react-gui/src/components/farming/DendrometerMonitor.tsx
web/react-gui/src/components/farming/ScheduleSection.tsx
web/react-gui/src/components/farming/environment/LocalTab.tsx
web/react-gui/src/components/farming/environment/ForecastTab.tsx
web/react-gui/src/components/farming/environment/WeatherTab.tsx
```

Per file: add new keys to `en/devices.json` only. After the file is updated, run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run build
```

to confirm the file still compiles. Do not translate `DeviceType` values, EUI strings, MQTT topics, REST paths, units (`kPa`, `mm`, `hPa`, `m/s`, `V`), or protocol command names.

- [ ] **Step 3: Add Swahili directory and complete French**

Create `/home/phil/Repos/osi-os/web/react-gui/public/locales/sw/{accountLink,auth,common,dashboard,devices}.json` by copying the `en/` files and translating values. Then complete `fr/` for any missing keys reported by the parity check.

Update `web/react-gui/src/i18n/config.ts`:

```ts
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'sw', label: 'Kiswahili' },
  // ... existing additional entries
];
```

In the i18n init block, add `nonExplicitSupportedLngs: true` (NOT `load: 'languageOnly'`). The reason: `SUPPORTED_LANGUAGES` currently includes `de-CH` with no base `de` locale on disk. `load: 'languageOnly'` would force `de-CH` → `de` and break Swiss-German rendering. `nonExplicitSupportedLngs: true` keeps `de-CH` explicit while letting `sw-TZ` / `sw-KE` / `fr-FR` fall back to the base `sw` / `fr` we ship.

- [ ] **Step 4: Smoke-test renders in all locales**

Create `web/react-gui/tests/i18nRenderSmoke.test.tsx`:

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n/config';
import FarmingDashboard from '../src/pages/FarmingDashboard';

for (const lng of ['en','fr','sw']) {
  test(`FarmingDashboard renders in ${lng}`, async () => {
    await i18n.changeLanguage(lng);
    const html = renderToString(
      <I18nextProvider i18n={i18n}><FarmingDashboard/></I18nextProvider>
    );
    assert.doesNotMatch(html, /\b__MISSING_KEY__\b/);
  });
}
```

Run:

```bash
node scripts/check-locale-parity.js
cd web/react-gui && npx tsx --test tests/i18nRenderSmoke.test.tsx && npm run build
```

Expected: PASS.

### Task 8.2: S2120 Weather History Channels

- [ ] **Step 1: Failing test**

Create `/home/phil/Repos/osi-os/web/react-gui/tests/s2120HistoryFields.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S2120_WEATHER_HISTORY_FIELDS } from '../src/components/farming/weatherHistoryFields';

test('S2120 history exposes all sensor channels', () => {
  const keys = S2120_WEATHER_HISTORY_FIELDS.map(f => f.key);
  for (const k of [
    'temperature_c','relative_humidity_pct','wind_speed_mps','wind_direction_deg',
    'wind_gust_mps','uv_index','barometric_pressure_hpa',
    'rain_gauge_cumulative_mm','rain_mm_per_10min','bat_pct'
  ]) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
  const dir = S2120_WEATHER_HISTORY_FIELDS.find(f => f.key === 'wind_direction_deg');
  assert.equal(dir?.kind, 'direction');
});
```

Run. Expected: FAIL.

- [ ] **Step 2: Extract field metadata**

Create `web/react-gui/src/components/farming/weatherHistoryFields.ts`:

```ts
export type WeatherHistoryField = {
  key: string;
  labelKey: string;
  fallbackLabel: string;
  unit: string;
  kind: 'scalar' | 'direction';
};

export const S2120_WEATHER_HISTORY_FIELDS: WeatherHistoryField[] = [
  { key: 'temperature_c',            labelKey: 'sense.temperature',     fallbackLabel: 'Temperature',     unit: '°C',  kind: 'scalar' },
  { key: 'relative_humidity_pct',    labelKey: 'sense.humidity',        fallbackLabel: 'Humidity',        unit: '%',   kind: 'scalar' },
  { key: 'wind_speed_mps',           labelKey: 'sense.windSpeed',       fallbackLabel: 'Wind speed',      unit: 'm/s', kind: 'scalar' },
  { key: 'wind_direction_deg',       labelKey: 'sense.windDirection',   fallbackLabel: 'Wind direction',  unit: '°',   kind: 'direction' },
  { key: 'wind_gust_mps',            labelKey: 'sense.windGust',        fallbackLabel: 'Wind gust',       unit: 'm/s', kind: 'scalar' },
  { key: 'uv_index',                 labelKey: 'sense.uvIndex',         fallbackLabel: 'UV index',        unit: '',    kind: 'scalar' },
  { key: 'barometric_pressure_hpa',  labelKey: 'sense.pressure',        fallbackLabel: 'Pressure',        unit: 'hPa', kind: 'scalar' },
  { key: 'rain_gauge_cumulative_mm', labelKey: 'sense.rainCumulative',  fallbackLabel: 'Rain cumulative', unit: 'mm',  kind: 'scalar' },
  { key: 'rain_mm_per_10min',        labelKey: 'sense.rainPer10min',    fallbackLabel: 'Rain (10 min)',   unit: 'mm',  kind: 'scalar' },
  { key: 'bat_pct',                  labelKey: 'sense.battery',         fallbackLabel: 'Battery',         unit: '%',   kind: 'scalar' },
];
```

Run the test. Expected: PASS.

- [ ] **Step 3: Render S2120 selectors**

Update `SenseCapWeatherCard.tsx` to iterate `S2120_WEATHER_HISTORY_FIELDS`. For `kind: 'direction'`, use a polar/circular formatter; do not feed degrees to a scalar moisture chart. For channels with no data, render an explicit empty state.

- [ ] **Step 4: Verify the API allow-list**

In `flows.json`, confirm the device history endpoint allows these S2120 fields. Add `verify-sync-flow.js` assertions for `wind_*`, `uv_index`, `barometric_pressure_hpa`, and `rain_*` field names appearing in the allow-list.

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
node scripts/check-locale-parity.js
cd web/react-gui && npx tsx --test tests/s2120HistoryFields.test.ts && npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui scripts/check-locale-parity.js scripts/verify-sync-flow.js \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "feat(i18n,s2120): locale parity (fr+sw) and full S2120 history channels"
```

---

## Slice 9: Cloud i18n (French audit + Swahili)

**Issues:** `osi-server#1`

**Files:**
- Modify: `/home/phil/Repos/osi-server/frontend/public/locales/en/*.json`
- Modify: `/home/phil/Repos/osi-server/frontend/public/locales/fr/*.json`
- Create: `/home/phil/Repos/osi-server/frontend/public/locales/sw/*.json`
- Modify: `/home/phil/Repos/osi-server/frontend/src/i18n/config.ts`
- Modify: `/home/phil/Repos/osi-server/frontend/src/pages/Account.tsx`
- Modify: `/home/phil/Repos/osi-server/frontend/src/pages/admin/*.tsx`
- Modify: `/home/phil/Repos/osi-server/frontend/src/components/farming/*.tsx`
- Modify: `/home/phil/Repos/osi-server/frontend/src/components/farming/environment/*.tsx`
- Modify: `/home/phil/Repos/osi-server/frontend/src/components/farming/prediction/*.tsx`
- Modify: `/home/phil/Repos/osi-server/frontend/src/pages/DeviceDetail.tsx`
- Create: `/home/phil/Repos/osi-server/scripts/check-frontend-locale-parity.js`
- Create: `/home/phil/Repos/osi-server/frontend/tests/i18nRenderSmoke.test.tsx`

### Task 9.1: Same approach as Slice 8.1

- [ ] **Step 1: Reuse the parity script**

Create `scripts/check-frontend-locale-parity.js` with the same algorithm as the edge script in Slice 8.1 Step 1, rooted at `frontend/public/locales`.

- [ ] **Step 2: Run and capture gaps**

```bash
cd /home/phil/Repos/osi-server
node scripts/check-frontend-locale-parity.js
```

Expected: FAIL with current gaps.

- [ ] **Step 3: Per-file conversion + Swahili**

Same pattern as Slice 8 Task 8.1 Steps 2-3. Add `sw` to `frontend/src/i18n/config.ts` (`Kiswahili`) with `nonExplicitSupportedLngs: true` (same reasoning as Slice 8 — preserve any regional codes like `de-CH` and let `sw-TZ`/`sw-KE` fall back to `sw`).

- [ ] **Step 4: Render smoke tests**

Mirror Slice 8.1 Step 4 for the cloud frontend's main pages (`DeviceDetail`, `Account`, admin pages).

- [ ] **Step 5: Verify and commit**

```bash
cd /home/phil/Repos/osi-server
node scripts/check-frontend-locale-parity.js
cd frontend && npm run test:unit && npm run build
git add frontend scripts/check-frontend-locale-parity.js
git commit -m "feat(i18n): cloud frontend locale parity (fr+sw)"
```

---

## Slice 10: Dendrometer Scheduling and MClimate T-Valve

**Issues:** `osi-os#22`, `osi-os#18`

**Files:**
- Modify: `/home/phil/Repos/osi-os/database/seed-blank.sql`
- Create: `/home/phil/Repos/osi-os/database/migrations/2026-05-27-dendro-scheduling.sql`
- Create: `/home/phil/Repos/osi-os/database/migrations/2026-05-27-mclimate-device-type.sql`
- Modify: `/home/phil/Repos/osi-os/scripts/repair-pi-schema.js`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/types/farming.ts`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/ZoneConfigModal.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/MClimateValveCard.tsx`
- Create: `/home/phil/Repos/osi-os/scripts/verify-mclimate-t-valve.js`
- Create: `/home/phil/Repos/osi-os/scripts/fixtures/mclimate-t-valve/`

### Task 10.1: Live Device Schema Migration Path

`deploy.sh` only seeds `farming.db` when absent. New schema must be applied to existing live DBs via `repair-pi-schema.js`. Every migration in this plan must also register here.

- [ ] **Step 1: Failing test for migration registration**

Add a test asserting `repair-pi-schema.js` adds each new column to a fixture DB missing them. If a fixture-based schema-repair test does not yet exist, create `scripts/test-repair-schema.js` with a fixture DB:

```bash
cd /home/phil/Repos/osi-os
node scripts/test-repair-schema.js
```

Expected: FAIL — fixture DB shows missing columns after running repair, because repair script doesn't know about the new columns yet.

- [ ] **Step 2: Extend `repair-pi-schema.js` for column adds**

For each new column added in Task 10.2, add an idempotent block in `repair-pi-schema.js`:

```js
ensureColumn('irrigation_zones', 'dendro_scheduling_enabled', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('irrigation_zones', 'dendro_stress_threshold',   "TEXT NOT NULL DEFAULT 'high'");
ensureColumn('irrigation_zones', 'dendro_stale_hours',        "INTEGER NOT NULL DEFAULT 36");
```

`ensureColumn` is the existing helper — `ADD COLUMN` is supported by SQLite as long as the column has a `DEFAULT` (which all three above do) or is nullable.

- [ ] **Step 3: Extend `repair-pi-schema.js` for the `devices.type_id` CHECK constraint**

SQLite does NOT support `ALTER TABLE … ADD/DROP CONSTRAINT`. To accept `MCLIMATE_T_VALVE` as a new value in the `type_id IN (...)` CHECK, the `devices` table must be rebuilt.

**Important SQLite gotchas this block has to respect:**

1. `repair-pi-schema.js` does NOT use a JS SQLite driver. It shells out via `execFileSync('sqlite3', [dbPath], { input: sql })` (see [scripts/repair-pi-schema.js:18](/home/phil/Repos/osi-os/scripts/repair-pi-schema.js)). All DDL goes through the existing `exec()` helper. Do not introduce `db.prepare`/`db.exec` style — there is no `db` handle.
2. `PRAGMA foreign_keys = OFF/ON` **must** be set outside any open transaction. Issuing the PRAGMA inside `BEGIN` is silently ignored. The recommended pattern per the SQLite docs is: PRAGMA off → BEGIN → rebuild → COMMIT → PRAGMA on → `PRAGMA foreign_key_check` to confirm no orphans.
3. The rebuild must preserve every column (in original order), every non-autogenerated index, and every trigger on `devices`. Capture them before DROP.

Add this idempotent block to `repair-pi-schema.js` (uses the existing `exec()` and `execFileSync('sqlite3', ...)` patterns):

```js
function readSingleColumn(sql) {
    return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);
}

function devicesTypeIdAcceptsMclimate() {
    // Probe with a throwaway row inside a SAVEPOINT, then roll back. We do not
    // need the row to persist — we only need to know whether the CHECK rejects
    // the value. Wrap in a fresh sqlite3 invocation so we don't pollute the
    // outer script's transaction state.
    const probe = `
        SAVEPOINT probe_check;
        INSERT INTO devices(deveui, name, type_id)
        VALUES ('__probe_mclimate__', '__probe__', 'MCLIMATE_T_VALVE');
        ROLLBACK TO SAVEPOINT probe_check;
        RELEASE SAVEPOINT probe_check;
    `;
    try {
        execFileSync('sqlite3', [dbPath], { input: probe, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
    } catch (e) {
        return false;
    }
}

function ensureDeviceTypeAcceptsMclimate() {
    if (devicesTypeIdAcceptsMclimate()) return false;

    console.log('repair-pi-schema: rebuilding devices to widen type_id CHECK for MCLIMATE_T_VALVE');

    // 1. Build the new CREATE TABLE SQL by reading sqlite_master and inserting
    //    'MCLIMATE_T_VALVE' into the CHECK list. Helper lives in
    //    scripts/sqlite-migration-helpers.js (Task 10.3 Step 2 of this plan
    //    adds it). It returns SQL with table name `devices` — we rename to
    //    `devices_new` below.
    const { buildDevicesTableSqlWithMclimate } = require('./sqlite-migration-helpers');
    const newTableSql = buildDevicesTableSqlWithMclimate({ dbPath, execFileSync })
        .replace(/^\s*CREATE TABLE\s+(IF NOT EXISTS\s+)?devices\b/i, 'CREATE TABLE devices_new');

    // 2. Capture columns (preserve order for the INSERT...SELECT), indexes,
    //    and triggers on `devices`.
    const cols = columns('devices');             // existing helper at line ~28
    const indexes  = readSingleColumn(
        "SELECT sql FROM sqlite_master WHERE type='index'   AND tbl_name='devices' AND sql IS NOT NULL;"
    );
    const triggers = readSingleColumn(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='devices';"
    );

    // 3. Run the rebuild in ONE sqlite3 invocation so PRAGMA foreign_keys
    //    sits outside the BEGIN…COMMIT block. The PRAGMA is set, then we open
    //    a transaction, do the rebuild, commit, re-enable FKs, and finally
    //    foreign_key_check confirms no orphans.
    const colList = cols.join(',');
    const rebuildScript = [
        'PRAGMA foreign_keys = OFF;',
        'BEGIN;',
        newTableSql + ';',
        `INSERT INTO devices_new(${colList}) SELECT ${colList} FROM devices;`,
        'DROP TABLE devices;',
        'ALTER TABLE devices_new RENAME TO devices;',
        ...indexes.map(s => s + ';'),
        ...triggers.map(s => s + ';'),
        'COMMIT;',
        'PRAGMA foreign_keys = ON;',
        'PRAGMA foreign_key_check;',
    ].join('\n');

    try {
        const out = execFileSync('sqlite3', [dbPath], { input: rebuildScript, encoding: 'utf8' });
        if (out.trim().length > 0) {
            // PRAGMA foreign_key_check prints any orphans. Empty output = clean.
            throw new Error('foreign_key_check found violations:\n' + out);
        }
    } catch (e) {
        // Best-effort rollback if BEGIN succeeded but COMMIT didn't.
        try { execFileSync('sqlite3', [dbPath], { input: 'ROLLBACK;', encoding: 'utf8' }); } catch (_) {}
        throw new Error(`devices rebuild failed: ${e.message}`);
    }
    applied++;
    return true;
}
ensureDeviceTypeAcceptsMclimate();
```

**Helper `buildDevicesTableSqlWithMclimate` in `scripts/sqlite-migration-helpers.js`:**

```js
function buildDevicesTableSqlWithMclimate({ dbPath, execFileSync }) {
    const sql = execFileSync(
        'sqlite3',
        [dbPath, "SELECT sql FROM sqlite_master WHERE type='table' AND name='devices';"],
        { encoding: 'utf8' }
    ).trim();
    if (!sql) throw new Error('devices table not found');
    // Find the CHECK(type_id IN ('A','B',…)) clause and append MCLIMATE_T_VALVE
    // if absent. The CHECK list is the only place new device types are added.
    return sql.replace(
        /CHECK\s*\(\s*type_id\s+IN\s*\(([^)]*)\)\s*\)/i,
        (_full, list) => {
            const values = list.split(',').map(v => v.trim().replace(/^'|'$/g, ''));
            if (values.includes('MCLIMATE_T_VALVE')) return _full;  // already widened
            const newList = [...values, 'MCLIMATE_T_VALVE'].map(v => `'${v}'`).join(',');
            return `CHECK(type_id IN (${newList}))`;
        }
    );
}
module.exports = { buildDevicesTableSqlWithMclimate };
```

- [ ] **Step 4: Test the rebuild on a fixture DB**

Extend `scripts/test-repair-schema.js`:

```text
1. Seed a fixture DB without MCLIMATE_T_VALVE in the CHECK.
2. Insert a couple of pre-existing devices, an index, and a trigger on devices.
3. Run ensureDeviceTypeAcceptsMclimate.
4. Assert: a MCLIMATE_T_VALVE row now inserts successfully.
5. Assert: pre-existing rows are still present.
6. Assert: pre-existing indexes and triggers still exist.
7. Run ensureDeviceTypeAcceptsMclimate a SECOND time.
8. Assert: no rebuild happens (probe succeeds), table unchanged.
```

Run the test. Expected: PASS.

### Task 10.2: Dendrometer Scheduling

- [ ] **Step 1: Confirm `stress_class` column existence**

```bash
cd /home/phil/Repos/osi-os
rg -n 'stress_class' database/seed-blank.sql conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
```

If absent, this task ships without `stress_class` and derives a conservative signal in the scheduler from existing daily metrics; UI labels stay generic ("Dendrometer stress"). If present, use it directly.

- [ ] **Step 2: Add zone config columns**

In `database/seed-blank.sql` and a new migration `database/migrations/2026-05-27-dendro-scheduling.sql`:

```sql
ALTER TABLE irrigation_zones ADD COLUMN dendro_scheduling_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE irrigation_zones ADD COLUMN dendro_stress_threshold  TEXT    NOT NULL DEFAULT 'high';
ALTER TABLE irrigation_zones ADD COLUMN dendro_stale_hours       INTEGER NOT NULL DEFAULT 36;
```

SQLite does not support `IF NOT EXISTS` on `ADD COLUMN`; the seed runs on a fresh DB so order matters, and `repair-pi-schema.js` (Task 10.1 Step 2) handles live DBs idempotently.

- [ ] **Step 3: Extend the scheduler**

In `flows.json` (both profiles), the scheduler decision node consults dendrometer data only when:

```text
zone.dendro_scheduling_enabled = 1
≥1 assigned dendrometer device has recent valid daily data within dendro_stale_hours
device is not Chameleon-only and not calibration-missing
```

Decision matrix:

```text
high stress + fresh data       → keep/escalate to irrigate
low stress + SWT says irrigate → do not override SWT
stale dendrometer data         → ignore dendrometer; log a single info entry per zone-day
```

- [ ] **Step 4: UI**

In `ZoneConfigModal.tsx`, add a disabled-by-default section with three controls (`Enable`, `Stress threshold`, `Stale data fallback window`). Use existing form components — do not create new abstractions for this single config section.

- [ ] **Step 5: Verify**

Scheduler fixtures must cover irrigate, skip, stale fallback, and mixed SWT+dendrometer cases. Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
cd web/react-gui && npx tsx --test tests/scheduleMetrics.test.ts && npm run build
```

Expected: PASS.

### Task 10.3: MClimate T-Valve

- [ ] **Step 1: Fixtures**

Download the vendor PDFs attached to `osi-os#18`, extract example uplink frames, and save to `scripts/fixtures/mclimate-t-valve/{open_ack,close_ack,heartbeat}.json`. If example frames aren't in the PDFs, build fixtures from the payload format table and cite the table in a `README.md` next to the fixtures.

- [ ] **Step 2: Catalog and DB type**

Add `MCLIMATE_T_VALVE` to:

```text
database/seed-blank.sql       (devices.type_id CHECK constraint)
database/migrations/2026-05-27-mclimate-device-type.sql
scripts/repair-pi-schema.js   (CHECK constraint update for live DBs)
web/react-gui/src/types/farming.ts   (DeviceType union)
scripts/chirpstack-bootstrap.js      (profile creation)
```

- [ ] **Step 3: Codec and ingest branch with device-type filter**

Add `mclimate_t_valve_decoder.js` to the bundled codec paths. Add an MQTT ingest branch subscribed to `application/+/device/+/event/up`. **The branch entry function node MUST filter by ChirpStack device profile name (`MCLIMATE_T_VALVE`) before invoking the decoder** — otherwise existing KIWI/Dragino/STREGA branches will also pick up the same message and produce garbage rows.

Filter template:

```js
const profile = msg.payload?.deviceProfileName;
if (profile !== 'MCLIMATE_T_VALVE') { return null; }
return msg;
```

Persist:

```text
valve_state (open/closed/unknown)
bat_pct or bat_v
last_seen
command_ack_state (success/failure/timeout)
rssi, snr, fcnt
```

- [ ] **Step 4: Valve UI**

The MClimate command surface differs from STREGA (no timed irrigation). Create a separate `MClimateValveCard.tsx` rather than overloading `StregaValveCard.tsx`. Reuse low-level controls (open/close button) by extracting only when a third device with the same surface appears — not now.

- [ ] **Step 5: Verify (note: bash, not node, for shell scripts)**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-mclimate-t-valve.js
bash scripts/check-mqtt-topics.sh
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
node scripts/verify-strega-gen1.js
cd web/react-gui && npx tsx --test tests/stregaValveCard.test.ts && npm run build
```

Expected: PASS and no STREGA regression. `verify-strega-gen1.js` explicitly proves the new device type didn't impact the existing valve card path.

### Task 10.4: Commit

```bash
cd /home/phil/Repos/osi-os
git add database scripts conf web/react-gui
git commit -m "feat(devices): dendrometer scheduling and MClimate T-Valve support"
```

---

## Slice 11: Plugin System — ADR Only

**Issues:** `osi-os#8`

**Files:**
- Create: `/home/phil/Repos/osi-os/docs/adr/2026-05-27-static-device-plugin-registry.md`
- Modify: `/home/phil/Repos/osi-os/AGENTS.md`

### Task 11.1: ADR

- [ ] **Step 1: Write the ADR**

Sections: Context, Decision, Consequences, Alternatives Considered. Decision body:

```text
OSI plugins are static in-repo device capability registrations for this phase.
A plugin can own catalog metadata, codec path, ingest mapping, dashboard card
mapping, schedule metric provider, command capability, and verification fixture.
The system will not load remote executable plugins. The registry data
structure, verifier, and any concrete plugin entries are deferred until a
second concrete user beyond the existing device-type catalog exists (e.g. a
third-party sensor that does NOT ship inside the OSI image).
```

- [ ] **Step 2: Link the ADR from `AGENTS.md`**

Add a one-line index entry under the docs section.

- [ ] **Step 3: Commit**

```bash
cd /home/phil/Repos/osi-os
git add docs/adr AGENTS.md
git commit -m "docs(adr): static device plugin registry decision"
```

This slice does NOT create `device-registry/registry.json` or `verify-device-registry.js`. Those are downstream work the ADR explicitly defers.

---

## Slice 12: Irrigation Operational Error Tracking (`osi-os#7`)

**Issues:** `osi-os#7`

**Issue body verbatim:** *"Error tracking and display in dashboard to advice user interventions, (e.g. control if irrigation was successful and check multiple points of failire, opening initiated, valve opend, soil moisture change)"*

This is operational tracking around irrigation success/failure points, surfaced on the dashboard — not Sentry-style infrastructure exception capture. The minimum that closes `#7`:

1. Detect three failure points: (a) valve open command issued but no `command_ack` within a grace window; (b) valve reported open but soil moisture (SWT/Chameleon) shows no change within an irrigation-response window; (c) scheduler decided to irrigate but no valve command was actually dispatched.
2. Persist each detected failure with enough context to make it actionable on the dashboard (which zone, which device, what was expected, what was observed).
3. Render the most recent failures on the farming dashboard.

**Explicitly NOT in this slice** (CLAUDE.md "no premature abstraction"): acknowledge/resolve lifecycle, severity enums, evidence-JSON schema beyond a single context blob, sync_version columns, cloud sync of the failures, or operator notification channels (email/SMS/push). Add those only when a follow-up issue requests them with concrete requirements.

**Files:**
- Modify: `/home/phil/Repos/osi-os/database/seed-blank.sql`
- Create: `/home/phil/Repos/osi-os/database/migrations/2026-05-27-irrigation-failures.sql`
- Modify: `/home/phil/Repos/osi-os/scripts/repair-pi-schema.js`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/services/api.ts`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/types/farming.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/components/farming/IrrigationFailuresPanel.tsx`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/pages/FarmingDashboard.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/tests/irrigationFailuresPanel.test.tsx`

### Task 12.1: Schema for detected failures

- [ ] **Step 1: Add the table to seed and migration**

Add to `database/seed-blank.sql` and a new `database/migrations/2026-05-27-irrigation-failures.sql`:

```sql
CREATE TABLE IF NOT EXISTS irrigation_failures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at     TEXT NOT NULL,           -- ISO8601 UTC
  failure_kind    TEXT NOT NULL CHECK (failure_kind IN (
                    'command_not_acked',
                    'valve_open_no_moisture_response',
                    'scheduler_decided_no_command'
                  )),
  zone_id         INTEGER,                 -- nullable: not every failure ties to a zone
  device_deveui   TEXT,                    -- nullable: scheduler_decided_no_command has no device yet
  context_json    TEXT NOT NULL            -- single opaque blob; no schema yet
);

CREATE INDEX IF NOT EXISTS idx_irrigation_failures_detected_at
  ON irrigation_failures(detected_at DESC);
```

Register in `repair-pi-schema.js` so live Pi DBs get the table (CREATE TABLE IF NOT EXISTS is idempotent).

### Task 12.2: Detection in `flows.json`

Each of the three checks is a single function node that emits one INSERT per detected failure. None of these checks attempt to mutate the irrigation flow — they observe and record only.

- [ ] **Step 1: `command_not_acked`**

**Edge ACK ledger anchor (the same as Slice 3 verification):** the canonical "command was applied" record is the `applied_commands` row keyed by `command_id`. A row exists with `result='success'` once the LoRaWAN downlink ACK comes back; the row is absent (or has `result='failure'`) when the device did not confirm.

After each STREGA or MClimate valve command is dispatched (i.e. immediately after the `INSERT OR REPLACE INTO applied_commands` for that `command_id` would happen if successful), schedule a deferred check via a Node-RED `delay` node set to the grace window. When the timer fires, run:

```sql
SELECT command_id, result, result_detail, applied_at
  FROM applied_commands
 WHERE command_id = $commandId;
```

Branching:

```text
no row                      → INSERT into irrigation_failures(failure_kind='command_not_acked', ...)
row with result='success'   → success path, do nothing
row with result='failure'   → INSERT into irrigation_failures(failure_kind='command_not_acked', ...)
                              and copy result_detail into context_json.lastError
```

`command_ack_outbox` is the cloud-bound delivery queue for the same ACK — do NOT use it as the detector source (its presence/absence reflects cloud forwarding, not whether the device acknowledged). For each detected failure, the `context_json` body is:

```json
{
  "commandId": "<uuid>",
  "deveui": "<eui>",
  "commandType": "OPEN_VALVE",
  "graceWindowMinutes": 5,
  "appliedCommandsResult": null,
  "lastError": null
}
```

`appliedCommandsResult` is `null` when no row exists at all, or the literal `result` value (e.g. `'failure'`) when the row exists but is not `'success'`. Grace window default: 5 minutes. Hardcode for now; promote to zone config only when a real second value exists.

Add a verifier assertion to `scripts/verify-sync-flow.js`:

```text
flows.json must contain a query against applied_commands keyed by command_id
inside the irrigation_failures detector branch. The detector must NOT reference
a (non-existent) pending_commands table.
```

- [ ] **Step 2: `valve_open_no_moisture_response`**

After a valve_state transitions to `open`, schedule a deferred check (default 30 minutes — irrigation response window). When the timer fires, compare the latest SWT reading from devices assigned to the same zone against the reading at valve-open time. If no reading changed by more than a configurable epsilon (default: 1 kPa drop on any swt_1/swt_2/swt_3), INSERT with `failure_kind='valve_open_no_moisture_response'` and:

```json
{
  "deveui": "<valve eui>",
  "zoneId": 12,
  "openedAt": "2026-05-27T08:00:00Z",
  "responseWindowMinutes": 30,
  "epsilonKpa": 1.0,
  "metricBefore": {"swt_1": 42.0},
  "metricAfter":  {"swt_1": 42.1}
}
```

- [ ] **Step 3: `scheduler_decided_no_command`**

In the scheduler decision node, when the decision is "irrigate" but the resulting command dispatch path returns no commandId (e.g. queue full, transient error, device not addressable), INSERT with `failure_kind='scheduler_decided_no_command'`:

```json
{
  "zoneId": 12,
  "decidedAt": "2026-05-27T08:00:00Z",
  "trigger": "swt_threshold",
  "thresholdKpa": 50.0,
  "currentKpa": 65.0,
  "reason": "no_addressable_valve"
}
```

### Task 12.3: API and dashboard surface

- [ ] **Step 1: List endpoint**

Add a Node-RED `GET /api/irrigation/failures` endpoint that returns the latest 50 rows (`ORDER BY detected_at DESC LIMIT 50`). Apply the same `verifyBearer` auth used by other edge endpoints. No filter/pagination yet — 50 is small enough to ship without it.

Response shape:

```json
{
  "failures": [
    {
      "id": 123,
      "detectedAt": "2026-05-27T08:35:00Z",
      "failureKind": "valve_open_no_moisture_response",
      "zoneId": 12,
      "deviceDeveui": "A84041FFFF000099",
      "context": { /* JSON-decoded context_json */ }
    }
  ]
}
```

- [ ] **Step 2: Frontend types and API client**

In `src/types/farming.ts`:

```ts
export type IrrigationFailureKind =
  | 'command_not_acked'
  | 'valve_open_no_moisture_response'
  | 'scheduler_decided_no_command';

export interface IrrigationFailure {
  id: number;
  detectedAt: string;
  failureKind: IrrigationFailureKind;
  zoneId: number | null;
  deviceDeveui: string | null;
  context: Record<string, unknown>;
}
```

In `src/services/api.ts`, add `listIrrigationFailures(): Promise<IrrigationFailure[]>`.

- [ ] **Step 3: Failing UI test**

Create `web/react-gui/tests/irrigationFailuresPanel.test.tsx`:

```tsx
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import { IrrigationFailuresPanel } from '../src/components/farming/IrrigationFailuresPanel';

test('renders empty state when no failures', () => {
  const html = renderToString(<IrrigationFailuresPanel failures={[]} />);
  assert.match(html, /No recent failures/);
});

test('renders one row per failure with kind-specific copy', () => {
  const html = renderToString(<IrrigationFailuresPanel failures={[{
    id: 1,
    detectedAt: '2026-05-27T08:35:00Z',
    failureKind: 'valve_open_no_moisture_response',
    zoneId: 12,
    deviceDeveui: 'A84041FFFF000099',
    context: { responseWindowMinutes: 30 },
  }]} />);
  assert.match(html, /no moisture change observed/i);
  assert.match(html, /Zone 12/);
});
```

Run. Expected: FAIL.

- [ ] **Step 4: Implement `IrrigationFailuresPanel.tsx`**

Plain table or card list. Each row shows: detected time (relative), failure kind in human language, zone (if any), device (if any), and a small context summary derived from the context blob (e.g. `responseWindowMinutes` → "after 30 min"). Use `useTranslation('devices')` for kind labels:

```text
command_not_acked                → "Valve command not acknowledged"
valve_open_no_moisture_response  → "No moisture change observed after irrigation"
scheduler_decided_no_command     → "Scheduler tried to irrigate but no command was sent"
```

No acknowledge/resolve actions in this pass. The list is read-only.

- [ ] **Step 5: Render from `FarmingDashboard.tsx`**

Fetch on mount + every 60s while the dashboard is visible. Render `IrrigationFailuresPanel` below existing zone cards.

Run the test. Expected: PASS.

### Task 12.4: Verify and commit

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
node scripts/verify-profile-parity.js
node scripts/verify-db-schema-consistency.js
cd web/react-gui && npx tsx --test tests/irrigationFailuresPanel.test.tsx && npm run build
git add database scripts conf web/react-gui
git commit -m "feat(irrigation): operational failure detection and dashboard panel"
```

Expected: PASS. After deploy to a live Pi, manually trigger one of the failure paths (queue a command to a powered-off valve, or temporarily set `epsilonKpa=999` to force a missed-response detection) and confirm the row appears on the dashboard.

---

## Slice 13: iOS WKWebView Wrapper (Minimum Viable)

**Issues:** `osi-server#17`

**Platform gate (read this first):** Building and verifying this slice requires macOS with Xcode installed. **The primary OSI workstation is Linux**, so `xcodebuild` will not run there. Choose one execution path before starting:

```text
PATH 1 — macOS workstation: implement and verify locally with xcodebuild.
PATH 2 — XcodeBuildMCP from Linux: scaffold/edit locally; offload `xcodebuild` to a
         remote macOS host via the XcodeBuildMCP server.
PATH 3 — CI runner: scaffold/edit locally; final build verification runs on a
         macOS GitHub Actions runner (e.g. `macos-14`) on the slice's branch.
```

If none of those is available, **do not begin this slice** — scaffolding `.xcodeproj` without ever building it produces an artifact nobody can verify. Document the blocker on `osi-server#17` and skip until a macOS path exists.

**Files:**
- Create: `/home/phil/Repos/osi-server/ios/`
- Create: `/home/phil/Repos/osi-server/ios/OsiServer.xcodeproj`
- Create: `/home/phil/Repos/osi-server/ios/OsiServer/AppDelegate.swift`
- Create: `/home/phil/Repos/osi-server/ios/OsiServer/SceneDelegate.swift`
- Create: `/home/phil/Repos/osi-server/ios/OsiServer/MainViewController.swift`
- Create: `/home/phil/Repos/osi-server/ios/OsiServer/Assets.xcassets/`
- Modify: `/home/phil/Repos/osi-server/README.md`

### Task 13.1: Day-1 wrapper

No settings screen, no custom URL storage. Hardcode the production URL. Add settings only when a documented user need exists.

- [ ] **Step 1: Scaffold the iOS app**

Create an iOS app target with a `WKWebView` defaulting to:

```text
https://server.opensmartirrigation.org
```

- [ ] **Step 2: Navigation policy**

```text
same-origin http/https → open in WKWebView
external http/https    → open in SFSafariViewController
mailto/tel             → system handling
unknown schemes        → cancel with a visible toast
```

- [ ] **Step 3: Assets and docs**

App icons/splash consistent with the Android wrapper. Document Xcode version, bundle identifier, signing requirement, and simulator run steps in `README.md`.

- [ ] **Step 4: Verify and commit (path-dependent)**

```bash
# Detect host first.
case "$(uname -s)" in
  Darwin)
    cd /home/phil/Repos/osi-server/ios
    xcodebuild -scheme OsiServer -destination 'platform=iOS Simulator,name=iPhone 16' build
    ;;
  *)
    echo "Skipping xcodebuild on non-macOS host. Use XcodeBuildMCP or a macOS CI runner."
    echo "Do NOT commit until the build has been verified on a real Xcode host."
    exit 0
    ;;
esac

cd /home/phil/Repos/osi-server
git add ios README.md
git commit -m "feat(ios): minimal WKWebView wrapper for production dashboard"
```

Expected: on macOS, build succeeds; simulator smoke test can log in, open dashboard, open Terra, and navigate back. On non-macOS hosts the verification is deferred — no commit until a macOS run is captured and the output attached to `osi-server#17`.

---

## Slice 14: Final Cross-Repo Verification and Issue Closure

**Issues:** all covered

### Task 14.1: Full verification

- [ ] **Step 1: Edge verification**

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
node scripts/verify-strega-gen1.js
node scripts/verify-communication-contract.js
bash scripts/check-mqtt-topics.sh
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
node scripts/check-locale-parity.js
cd web/react-gui && npm run test:unit && npm run build
```

Expected: every command exits 0.

- [ ] **Step 2: Server verification**

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test
cd ../frontend
npm run test:unit && npm run build
cd ../terra-intelligence
npm test && npm run build
cd ../android
./gradlew :app:assembleDebug
node /home/phil/Repos/osi-server/scripts/check-frontend-locale-parity.js

# iOS verification is platform-gated. Run only on macOS / XcodeBuildMCP / macOS CI runner.
case "$(uname -s)" in
  Darwin)
    cd ../ios
    xcodebuild -scheme OsiServer -destination 'platform=iOS Simulator,name=iPhone 16' build
    ;;
  *)
    echo "Skipping iOS xcodebuild on non-macOS host — record blocker on osi-server#17 if not yet verified elsewhere."
    ;;
esac
```

Expected: every command on the active platform exits 0. The iOS line is only required on a macOS host; on Linux the slice ships when a macOS verification has been independently captured and attached to `osi-server#17`.

- [ ] **Step 3: Live Pi verification**

```bash
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.93.68.86 \
  'date; df -h /overlay; \
   grep -R "chameleon/depth" /usr/lib/node-red/gui/assets || echo NEW_ENDPOINT_MISSING; \
   grep -R "chameleon-config\|setChameleonConfig" /usr/lib/node-red/gui/assets || echo OLD_ENDPOINT_ABSENT; \
   sqlite3 -header -column /data/db/farming.db \
     "SELECT name,deveui,chameleon_swt1_depth_cm,chameleon_swt2_depth_cm,chameleon_swt3_depth_cm \
      FROM devices WHERE deveui IN (\"A84041A75D5E7CFB\",\"A84041CE3F5ECF52\");"'
DISPLAY=:0 SSH_ASKPASS=/tmp/ssh-askpass-osi.sh SSH_ASKPASS_REQUIRE=force ssh root@100.69.51.98 \
  'logread -e node-red | tail -n 200'
```

Expected: kaba100 depths match the GUI; new endpoint string present; old endpoint absent; Uganda log shows no 500s from the environment endpoint. If SSH is unavailable, leave affected issues open with a blocked-verification comment.

### Task 14.2: Close issues with evidence

- [ ] **Step 1: Comment template**

For each issue closed, the comment begins:

```text
> *This was generated by AI during implementation verification.*

**Commits:**
- osi-os: <SHA(s)>
- osi-server: <SHA(s)>  (if applicable)

**Tests run:**
<copy/paste exit-0 lines from Tasks 14.1 Steps 1-2>

**Live verification (if applicable):**
<copy/paste of Step 3 output>

**Residual risks:**
<any caveats or remaining work>
```

For cross-repo issues (e.g., `osi-os#56`, `osi-os#22`), include both repos' commit SHAs.

- [ ] **Step 2: Close**

```bash
gh issue close <num> --repo Open-Smart-Irrigation/osi-os     --comment-file /tmp/issue-close-comment.md
gh issue close <num> --repo Open-Smart-Irrigation/osi-server --comment-file /tmp/issue-close-comment.md
```

Do not close any issue blocked on live verification.

- [ ] **Step 3: Final inventory**

```bash
gh issue list --repo Open-Smart-Irrigation/osi-os     --state open --limit 100
gh issue list --repo Open-Smart-Irrigation/osi-server --state open --limit 100
```

Expected: remaining open issues are only those with explicit blocked verification or new scope discovered during implementation.

---

## Execution Order

Order is data-correctness first, quick cross-repo fix next, then Terra model migration before Terra UI consumers, then i18n, then large product additions:

1. **Slice 1** — Sensor history diagnostic (often closes `#56` without code)
2. **Slice 2** — Edge runtime safety + Chameleon verification + Environment tab fix
3. **Slice 3** — Server LSN50 mode command
4. **Slice 4** — Terra device-level anchor migration (must precede Terra UI work)
5. **Slice 5** — Terra empty-probe reasons, dismissible placement, dashboard nav
6. **Slice 6** — Terra live data correctness (depends on Slice 4 anchor model)
7. **Slice 7** — Terra visual rendering (maize, soil background)
8. **Slice 8** — Edge i18n (fr+sw) and S2120 history
9. **Slice 9** — Cloud i18n (fr+sw)
10. **Slice 10** — Dendrometer scheduling + MClimate T-Valve
11. **Slice 11** — Plugin ADR (no code beyond the ADR)
12. **Slice 12** — Error tracking infrastructure
13. **Slice 13** — iOS wrapper (minimum viable)
14. **Slice 14** — Final verification and issue closure

Each slice is independently mergeable. Recommended workflow: one branch per slice, PR per slice, merge in the order above. If a slice's scope is large (Slice 8 i18n especially), consider splitting per file.
