# Wildcard MQTT Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all per-Pi hardcoded UUIDs from MQTT IN subscription topics, replacing them with wildcard patterns that work on any gateway, backed by existing profile-name/ID filters in downstream function nodes.

**Architecture:** Each ChirpStack instance generates random application and device-profile UUIDs at bootstrap. Node-RED MQTT IN nodes must not encode these UUIDs in their subscription topics. Instead they subscribe to `application/+/device/+/event/up` and rely on downstream function-node profile filters to dispatch correctly. Three platform-specific flow files are affected; the RPi 3 / RPi Zero flows also need profile-filter additions that the RPi 5 flow already has.

**Tech Stack:** Node-RED flows (JSON), shell (init script already passes `CHIRPSTACK_PROFILE_*` env vars), Python (validation script).

---

## Current State (Bug)

| Platform | File | Node | Current topic | Problem |
|----------|------|------|---------------|---------|
| RPi 5 | `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | `lsn50-mqtt-in` | `application/22f61e5c-…/device/#` | Hardcoded Silvan UUID |
| RPi 5 | same | `e382bbf0dde572b1` (Field Testing) | `application/ac0fa0cb-…/#` | Hardcoded Silvan UUID |
| RPi 3 | `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` | `e73a11a2a36aab22` (KIWI IN) | `application/3f268526-…/device/#` | Hardcoded UUID + no profile filter downstream |
| RPi 3 | same | `e382bbf0dde572b1` (Field Testing) | `application/ac0fa0cb-…/#` | Hardcoded Silvan UUID |
| RPi Zero | `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json` | `e73a11a2a36aab22` (KIWI IN) | `application/3f268526-…/device/#` | Hardcoded UUID + no profile filter downstream |
| RPi Zero | same | `e382bbf0dde572b1` (Field Testing) | `application/ac0fa0cb-…/#` | Hardcoded Silvan UUID |

**Additional concern:** The RPi 5 `lsn50-mqtt-in` uses `device/#` which also catches join/ack/error events that the decode function immediately discards. The narrower `device/+/event/up` pattern is correct and consistent with the other three wildcard MQTT IN nodes.

---

## Target State

All MQTT IN nodes across all three platform flows use `application/+/device/+/event/up`. Every downstream function node has a profile filter that discards messages from mismatched device types. No per-Pi UUIDs in topics.

---

### Task 1: Replace hardcoded topics in RPi 5 flow (bcm2712)

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`

Two string replacements in the JSON:

- [ ] **Step 1: Replace LSN50 IN topic**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, find the node with `"id": "lsn50-mqtt-in"` and change its `"topic"` value from:

```
application/22f61e5c-d89b-4222-839f-3d72a302fc2e/device/#
```

to:

```
application/+/device/+/event/up
```

- [ ] **Step 2: Replace Field Testing MQTT IN topic**

In the same file, find the node with `"id": "e382bbf0dde572b1"` and change its `"topic"` value from:

```
application/ac0fa0cb-8775-418e-8181-6346862660d5/#
```

to:

```
application/+/device/+/event/up
```

- [ ] **Step 3: Validate JSON is well-formed**

Run:
```bash
python3 -c "import json; json.load(open('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json')); print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Verify no hardcoded UUID patterns remain in MQTT IN topics**

Run:
```bash
python3 -c "
import json
with open('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json') as f:
    flows = json.load(f)
import re
uuid_re = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE)
bad = [n for n in flows if n.get('type') == 'mqtt in' and uuid_re.search(n.get('topic', ''))]
if bad:
    print('FAIL: MQTT IN nodes with UUID topics:')
    for n in bad:
        print(f'  {n.get(\"name\", n[\"id\"])}: {n[\"topic\"]}')
else:
    print('OK: no UUID patterns in MQTT IN topics')
"
```

Expected: `OK: no UUID patterns in MQTT IN topics`

- [ ] **Step 5: Verify all MQTT IN topics are now wildcards**

Run:
```bash
python3 -c "
import json
with open('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json') as f:
    flows = json.load(f)
mqtt_ins = [n for n in flows if n.get('type') == 'mqtt in']
for m in mqtt_ins:
    print(f'{m[\"name\"]:30} topic={m[\"topic\"]}')
expected = 'application/+/device/+/event/up'
all_wildcard = all(m['topic'] == expected for m in mqtt_ins)
print(f'\nAll use wildcard: {all_wildcard}')
"
```

Expected: All 5 MQTT IN nodes show `application/+/device/+/event/up`, output ends with `All use wildcard: True`.

- [ ] **Step 6: Verify profile filters still exist in downstream functions**

Run:
```bash
python3 -c "
import json
with open('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json') as f:
    flows = json.load(f)
checks = [
    ('lsn50-decode-fn', ['CHIRPSTACK_PROFILE_LSN50', 'profileName', 'DRAGINO']),
    ('81c98fb07344a787', ['CHIRPSTACK_PROFILE_KIWI', 'profileName', 'CLOVER']),
    ('8809bb5239dfb3d4', ['CHIRPSTACK_PROFILE_KIWI', 'profileName']),
]
for node_id, keywords in checks:
    node = next((n for n in flows if n.get('id') == node_id), None)
    if not node:
        print(f'MISSING: node {node_id}')
        continue
    func = node.get('func', '')
    missing = [kw for kw in keywords if kw not in func]
    if missing:
        print(f'WEAK: node {node.get(\"name\", node_id)} missing keywords: {missing}')
    else:
        print(f'OK: node {node.get(\"name\", node_id)} has profile filter')
"
```

Expected: All three nodes report `OK`.

- [ ] **Step 7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "fix: replace hardcoded ChirpStack UUIDs with wildcard MQTT topics (RPi 5)

The LSN50 IN and Field Testing MQTT IN nodes had Silvan demo Pi UUIDs
hardcoded in their subscription topics, breaking silently on every other
device. Both now use application/+/device/+/event/up, matching the
existing KIWI, S2120, and Local Sensor Uplinks nodes. Downstream profile
filters in Decode LSN50 and Process Data provide device-type discrimination."
```

---

### Task 2: Add profile filter to KIWI Process Data in RPi 3 flow (bcm2709)

The RPi 3 and RPi Zero `KIWI IN` also has a hardcoded UUID topic, but unlike the RPi 5 flow, their Process Data function (`81c98fb07344a787`) lacks the profile filter. The wildcard topic cannot be used until the filter is in place, because a KIWI-subscribed wildcard would deliver LSN50/STREGA/other uplinks directly into the KIWI processing pipeline with no guard.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`

- [ ] **Step 1: Read the current Process Data function from bcm2709**

Run:
```bash
python3 -c "
import json
with open('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json') as f:
    flows = json.load(f)
node = next(n for n in flows if n.get('id') == '81c98fb07344a787')
print(node.get('func', ''))
"
```

Compare the output to the RPi 5 version to confirm the filter is missing. The RPi 5 version starts with:
```javascript
const profileName = String(data.deviceInfo.deviceProfileName || '').toUpperCase();
const profileId = String(data.deviceInfo.deviceProfileId || '').trim();
const kiwiProfileId = String(env.get('CHIRPSTACK_PROFILE_KIWI') || '').trim();
// ...
if (!knownProfiles.includes(profileId) && !profileName.includes('KIWI') && !profileName.includes('CLOVER')) {
    return null; // not a KIWI/CLOVER device, ignore
}
```

The RPi 3 version will lack this block.

- [ ] **Step 2: Add profile filter to Process Data in bcm2709**

Insert the following guard block into the Process Data function (`81c98fb07344a787`), immediately after the `if (!data || !data.deviceInfo || !data.object)` null-check and before any KIWI-specific processing:

```javascript
const profileName = String(data.deviceInfo.deviceProfileName || '').toUpperCase();
const profileId = String(data.deviceInfo.deviceProfileId || '').trim();
const kiwiProfileId = String(env.get('CHIRPSTACK_PROFILE_KIWI') || '').trim();
const cloverProfileId = String(env.get('CHIRPSTACK_PROFILE_CLOVER') || '').trim();
const kiwiProfiles = [kiwiProfileId, 'ae4194a5-56f8-4ca0-a129-8ad958505e1e'].filter(Boolean);
const cloverProfiles = [cloverProfileId, '46bdcc01-86db-41bd-bbf8-78cc439edae5'].filter(Boolean);
const knownProfiles = [...kiwiProfiles, ...cloverProfiles];
if (!knownProfiles.includes(profileId) && !profileName.includes('KIWI') && !profileName.includes('CLOVER')) {
    return null;
}
```

This matches the exact filter pattern used in the RPi 5 version of the same function.

- [ ] **Step 3: Validate JSON is well-formed**

Run:
```bash
python3 -c "import json; json.load(open('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json')); print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Verify profile filter was added correctly**

Run:
```bash
python3 -c "
import json
with open('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json') as f:
    flows = json.load(f)
node = next(n for n in flows if n.get('id') == '81c98fb07344a787')
func = node.get('func', '')
for kw in ['CHIRPSTACK_PROFILE_KIWI', 'profileName', 'profileId', 'KIWI', 'CLOVER']:
    print(f'  {kw}: {\"present\" if kw in func else \"MISSING\"}')"
```

Expected: All keywords present.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "fix: add profile filter to KIWI Process Data (RPi 3)

Guard against non-KIWI/CLOVER uplinks reaching the KIWI processing
pipeline. This is a prerequisite for changing the KIWI MQTT IN topic
from a hardcoded UUID to a wildcard pattern."
```

---

### Task 3: Replace hardcoded topics in RPi 3 flow (bcm2709)

Prerequisite: Task 2 is complete (profile filter is in place).

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`

Two string replacements:

- [ ] **Step 1: Replace KIWI IN topic**

Find the node with `"id": "e73a11a2a36aab22"` and change its `"topic"` value from:

```
application/3f268526-2f47-48c7-8b8c-0cae26fc3a7e/device/#
```

to:

```
application/+/device/+/event/up
```

- [ ] **Step 2: Replace Field Testing MQTT IN topic**

Find the node with `"id": "e382bbf0dde572b1"` and change its `"topic"` value from:

```
application/ac0fa0cb-8775-418e-8181-6346862660d5/#
```

to:

```
application/+/device/+/event/up
```

- [ ] **Step 3: Validate JSON and verify no UUID patterns in MQTT IN topics**

Run:
```bash
python3 -c "
import json, re
with open('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json') as f:
    flows = json.load(f)
print('JSON: OK')
uuid_re = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE)
bad = [n for n in flows if n.get('type') == 'mqtt in' and uuid_re.search(n.get('topic', ''))]
if bad:
    print('FAIL: MQTT IN nodes with UUID topics:')
    for n in bad: print(f'  {n.get(\"name\", n[\"id\"])}: {n[\"topic\"]}')
else:
    print('Topics: OK (no UUID patterns)')
"
```

Expected: `JSON: OK` and `Topics: OK (no UUID patterns)`.

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
git commit -m "fix: replace hardcoded ChirpStack UUIDs with wildcard MQTT topics (RPi 3)

KIWI IN and Field Testing had per-Pi UUIDs. Both now use
application/+/device/+/event/up. Profile filter added in previous commit
ensures KIWI pipeline only processes KIWI/CLOVER devices."
```

---

### Task 4: Add profile filter and replace hardcoded topics in RPi Zero flow (bcm2708)

Mirror of Tasks 2+3 for the RPi Zero platform. Same KIWI Process Data node ID (`81c98fb07344a787`), same bug pattern.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json`

- [ ] **Step 1: Read the current Process Data function from bcm2708**

Run:
```bash
python3 -c "
import json
with open('conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json') as f:
    flows = json.load(f)
node = next(n for n in flows if n.get('id') == '81c98fb07344a787')
func = node.get('func', '')
has_filter = 'deviceProfileId' in func and 'CHIRPSTACK_PROFILE' in func
print(f'Profile filter present: {has_filter}')
print(f'Function length: {len(func)} chars')
"
```

If it reports `Profile filter present: False`, proceed with Step 2.

- [ ] **Step 2: Add profile filter to Process Data in bcm2708**

Insert the same guard block as Task 2 Step 2 into the Process Data function (`81c98fb07344a787`), immediately after the data/null-check and before any KIWI-specific processing:

```javascript
const profileName = String(data.deviceInfo.deviceProfileName || '').toUpperCase();
const profileId = String(data.deviceInfo.deviceProfileId || '').trim();
const kiwiProfileId = String(env.get('CHIRPSTACK_PROFILE_KIWI') || '').trim();
const cloverProfileId = String(env.get('CHIRPSTACK_PROFILE_CLOVER') || '').trim();
const kiwiProfiles = [kiwiProfileId, 'ae4194a5-56f8-4ca0-a129-8ad958505e1e'].filter(Boolean);
const cloverProfiles = [cloverProfileId, '46bdcc01-86db-41bd-bbf8-78cc439edae5'].filter(Boolean);
const knownProfiles = [...kiwiProfiles, ...cloverProfiles];
if (!knownProfiles.includes(profileId) && !profileName.includes('KIWI') && !profileName.includes('CLOVER')) {
    return null;
}
```

- [ ] **Step 3: Replace KIWI IN topic**

Find node `"id": "e73a11a2a36aab22"` and change `"topic"` from:

```
application/3f268526-2f47-48c7-8b8c-0cae26fc3a7e/device/#
```

to:

```
application/+/device/+/event/up
```

- [ ] **Step 4: Replace Field Testing MQTT IN topic**

Find node `"id": "e382bbf0dde572b1"` and change `"topic"` from:

```
application/ac0fa0cb-8775-418e-8181-6346862660d5/#
```

to:

```
application/+/device/+/event/up
```

- [ ] **Step 5: Validate JSON and verify**

Run:
```bash
python3 -c "
import json, re
with open('conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json') as f:
    flows = json.load(f)
print('JSON: OK')
uuid_re = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE)
bad = [n for n in flows if n.get('type') == 'mqtt in' and uuid_re.search(n.get('topic', ''))]
if bad:
    print('FAIL: MQTT IN nodes with UUID topics:')
    for n in bad: print(f'  {n.get(\"name\", n[\"id\"])}: {n[\"topic\"]}')
else:
    print('Topics: OK (no UUID patterns)')
# Verify profile filter
node = next(n for n in flows if n.get('id') == '81c98fb07344a787')
func = node.get('func', '')
for kw in ['CHIRPSTACK_PROFILE_KIWI', 'profileName', 'profileId', 'KIWI', 'CLOVER']:
    print(f'  {kw}: {\"present\" if kw in func else \"MISSING\"}')"
```

Expected: `JSON: OK`, `Topics: OK`, all keywords present.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json
git commit -m "fix: add profile filter and replace hardcoded MQTT topics (RPi Zero)

Same fix as bcm2709: profile guard in Process Data + wildcard
application/+/device/+/event/up for KIWI IN and Field Testing."
```

---

### Task 5: Add validation script to catch future regressions

A lightweight check that can run in CI or manually to detect UUIDs in MQTT IN topics across all platform flows.

**Files:**
- Create: `scripts/check-mqtt-topics.sh`

- [ ] **Step 1: Create validation script**

Write `scripts/check-mqtt-topics.sh`:

```bash
#!/bin/bash
# check-mqtt-topics.sh — Ensure no MQTT IN node has a per-Pi UUID in its topic.
# All MQTT IN nodes should use application/+/device/+/event/up
set -euo pipefail

FLOWS=(
    conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
    conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
    conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json
)

UUID_RE='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
EXPECTED_TOPIC='application/+/device/+/event/up'
FAIL=0

for flow in "${FLOWS[@]}"; do
    if [ ! -f "$flow" ]; then
        echo "MISSING: $flow"
        FAIL=1
        continue
    fi

    # Check for per-Pi UUIDs in MQTT IN topics
    UUID_TOPICS=$(python3 -c "
import json, re
with open('$flow') as f:
    flows = json.load(f)
uuid_re = re.compile(r'$UUID_RE', re.IGNORECASE)
bad = [n for n in flows if n.get('type') == 'mqtt in' and uuid_re.search(n.get('topic', ''))]
for n in bad:
    print(f'{n.get(\"name\", n[\"id\"])}: {n[\"topic\"]}')
")

    if [ -n "$UUID_TOPICS" ]; then
        echo "FAIL: $flow has MQTT IN nodes with per-Pi UUID topics:"
        echo "$UUID_TOPICS"
        FAIL=1
    else
        echo "OK: $flow — no UUID patterns in MQTT IN topics"
    fi

    # Check all MQTT IN topics use the expected wildcard pattern
    NON_WILDCARD=$(python3 -c "
import json
with open('$flow') as f:
    flows = json.load(f)
mqtt_ins = [n for n in flows if n.get('type') == 'mqtt in']
for m in mqtt_ins:
    if m['topic'] != '$EXPECTED_TOPIC':
        print(f'{m.get(\"name\", m[\"id\"])}: {m[\"topic\"]}')
")

    if [ -n "$NON_WILDCARD" ]; then
        echo "WARN: $flow has MQTT IN nodes not using expected wildcard pattern:"
        echo "$NON_WILDCARD"
    fi
done

exit $FAIL
```

- [ ] **Step 2: Make script executable and test it**

Run:
```bash
chmod +x scripts/check-mqtt-topics.sh
bash scripts/check-mqtt-topics.sh
```

Expected: All three flow files report `OK`. No FAIL or WARN lines.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-mqtt-topics.sh
git commit -m "ci: add check-mqtt-topics.sh to detect per-Pi UUID regressions

Validates that all MQTT IN nodes across platform flows use wildcard
topics instead of hardcoded ChirpStack application UUIDs."
```

---

### Task 6: Update AGENTS.md with wildcard MQTT topic convention

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add MQTT topic convention section**

Add a section to the Node-RED / flows documentation area documenting the wildcard topic convention. Find the appropriate location (after the existing ChirpStack bootstrap or Node-RED section) and add:

```markdown
### Node-RED MQTT IN Topics

All MQTT IN nodes in flows.json **must** use wildcard subscription topics. ChirpStack generates random per-installation application UUIDs at bootstrap, so hardcoded UUIDs break silently on every gateway except the one whose UUIDs were baked in.

**Required pattern:** `application/+/device/+/event/up`

Device-type discrimination is handled by downstream function-node profile filters (env var match + `deviceProfileName` string fallback), not by MQTT topic filtering. The validation script `scripts/check-mqtt-topics.sh` enforces this convention.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: document wildcard MQTT topic convention in AGENTS.md"
```

---

## Out of Scope (Noted for Future Work)

1. **`scripts/patch-sim-dendro.js` line 312** — `const LSN50_APP_ID = '22f61e5c-d89b-4222-839f-3d72a302fc2e'` is a simulation seeding script that writes `chirpstack_app_id` to the local SQLite DB. This is not an MQTT subscription topic but a DB column value. It should eventually read from `env.get('CHIRPSTACK_APP_SENSORS')` or UCI, but that's a separate concern.

2. **ChirpStack init script topic patching** — The init script (`feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`) currently does NOT patch MQTT topics (it only patches the cloud MQTT `clientid`). No changes to the init script are needed for this approach, since the wildcard topics work universally without runtime patching.

3. **Downlink topic construction** — The `Build LSN50 mode downlink` function already constructs its publish topic using `env.get('CHIRPSTACK_APP_SENSORS')`, which is correctly sourced from UCI. No changes needed.