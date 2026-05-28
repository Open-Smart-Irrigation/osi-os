# Chameleon Depth Edge Fixes (osi-os #61) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three live failures on KABA100: stale GUI bundle calling a removed API, `chameleon-depth-auth` (and `chameleon-refresh-auth`) crashing because `authCheck` is never set in the global context, and depth saves not propagating to the cloud sync outbox.

**Architecture:** All code changes are in Node-RED flows.json (edge API behaviour) and the React GUI (rebuilt bundle). `chameleon-depth-auth` and `chameleon-refresh-auth` use `global.get('authCheck')` but `authCheck` is never registered anywhere — neither in `settings.js` `functionGlobalContext` nor via `global.set()`. The fix replaces both nodes with the inline `getAuthSecret()` + `verifyBearer()` pattern used by every other auth node in the flows. The sync outbox fix extends the existing `trg_sync_devices_outbox_au` SQLite trigger. **bcm2709 and bcm2712 share the same `flows.json` node IDs and `verify-profile-parity.js` requires them to be byte-for-byte identical — every flows.json change must be applied to both profiles.**

**Tech Stack:** Node-RED function nodes (JavaScript), SQLite triggers embedded in flows.json, React/TypeScript (Vite build to `web/react-gui/build/`), `scripts/verify-sync-flow.js` (Node.js assertion runner).

---

## File Map

| File | Change |
|------|--------|
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Fix chameleon-depth-auth + chameleon-refresh-auth; consolidate chameleon-depth-save; extend trigger |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` | Identical changes (bcm2709 must byte-match bcm2712) |
| `scripts/verify-sync-flow.js` | Add assertions for correct auth pattern, sync_version bump, trigger coverage |
| `web/react-gui/` | Rebuild bundle (source already correct; `outDir: 'build'`) |

---

### Task 1: Fix `chameleon-depth-auth` and `chameleon-refresh-auth` — replace dead global with real auth

Nodes `8b93fa005d78e25f` (chameleon-depth-auth) and `44e7d74ff3668e01` (chameleon-refresh-auth) both call `global.get('authCheck')(msg.req)`. The global `authCheck` is never set anywhere — not in `settings.js` `functionGlobalContext`, not via `global.set()` in any node. Every call currently throws `TypeError: global.get(...) is not a function`. The correct fix is to replace both nodes with the inline `getAuthSecret()` + `verifyBearer()` pattern used by `put-chameleon-enabled-auth-fn` and all other auth nodes in the flows.

After this fix, unauthenticated requests will return 401 (not 500) and authenticated requests will proceed.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Write the failing verify assertions**

Add to `scripts/verify-sync-flow.js`:

```js
expectIncludesById('8b93fa005d78e25f',
  'verifyBearer',
  'chameleon-depth-auth uses verifyBearer (not dead global.get authCheck)');
expectIncludesById('44e7d74ff3668e01',
  'verifyBearer',
  'chameleon-refresh-auth uses verifyBearer (not dead global.get authCheck)');
expectExcludesById('8b93fa005d78e25f',
  "global.get('authCheck')",
  "chameleon-depth-auth does not call dead global.get('authCheck')");
expectExcludesById('44e7d74ff3668e01',
  "global.get('authCheck')",
  "chameleon-refresh-auth does not call dead global.get('authCheck')");
```

- [ ] **Step 2: Run verify to confirm all four assertions fail**

```bash
node scripts/verify-sync-flow.js 2>&1 | grep -E 'chameleon-(depth|refresh)-auth'
```

Expected: 4 FAIL lines.

- [ ] **Step 3: Apply the fix to both flows.json files**

Save this as `/tmp/fix_auth_nodes.py` and run it:

```python
import json, pathlib

CORRECT_FUNC = (
    "return (async () => {\n"
    "function getAuthSecret() {\n"
    "  const configured = String(env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET') || '').trim();\n"
    "  if (configured) return configured;\n"
    "  const fs = global.get('fs');\n"
    "  const secretPaths = ['/data/db/osi_auth_token_secret', '/var/lib/node-red/.node-red/osi_auth_token_secret'];\n"
    "  if (fs) {\n"
    "    for (const secretPath of secretPaths) {\n"
    "      try {\n"
    "        const existing = String(fs.readFileSync(secretPath, 'utf8') || '').trim();\n"
    "        if (existing) return existing;\n"
    "      } catch (_) {}\n"
    "    }\n"
    "  }\n"
    "  const err = new Error('AUTH_TOKEN_SECRET or JWT_SECRET must be configured');\n"
    "  err.statusCode = 500;\n"
    "  throw err;\n"
    "}\n"
    "function toBase64Url(input) { return Buffer.from(input).toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, ''); }\n"
    "function fromBase64Url(input) { let v = String(input || '').replace(/-/g, '+').replace(/_/g, '/'); while (v.length % 4) v += '='; return Buffer.from(v, 'base64'); }\n"
    "function verifyBearer(authHeader) {\n"
    "  if (!authHeader || !authHeader.startsWith('Bearer ')) { const err = new Error('Unauthorized'); err.statusCode = 401; throw err; }\n"
    "  const token = authHeader.substring(7).trim();\n"
    "  const parts = token.split('.');\n"
    "  if (parts.length !== 2 || !parts[0] || !parts[1]) { const err = new Error('Invalid token'); err.statusCode = 401; throw err; }\n"
    "  const payloadB64 = parts[0];\n"
    "  const sig = parts[1];\n"
    "  const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());\n"
    "  const sigBuf = Buffer.from(sig, 'utf8'); const expectedBuf = Buffer.from(expectedSig, 'utf8');\n"
    "  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) { const err = new Error('Invalid token'); err.statusCode = 401; throw err; }\n"
    "  let payload;\n"
    "  try { payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8')); } catch (_) { const err = new Error('Invalid token'); err.statusCode = 401; throw err; }\n"
    "  const userId = Number(payload.userId); const username = String(payload.username || '').trim(); const exp = Number(payload.exp || 0);\n"
    "  if (!Number.isFinite(userId) || !username) { const err = new Error('Invalid token'); err.statusCode = 401; throw err; }\n"
    "  if (exp && Date.now() > exp) { const err = new Error('Token expired'); err.statusCode = 401; throw err; }\n"
    "  return { userId, username };\n"
    "}\n"
    "try {\n"
    "  const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);\n"
    "  msg._authUser = { userId: auth.userId, username: auth.username };\n"
    "  return [msg, null];\n"
    "} catch (err) {\n"
    "  msg.statusCode = err.statusCode || 401;\n"
    "  msg.payload = { error: err.message };\n"
    "  return [null, msg];\n"
    "}\n"
    "})();"
)

TARGET_IDS = {'8b93fa005d78e25f', '44e7d74ff3668e01'}

PROFILES = [
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
    'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
]

for profile_path in PROFILES:
    path = pathlib.Path(profile_path)
    flows = json.loads(path.read_text())
    changed = 0
    for node in flows:
        if node.get('id') in TARGET_IDS:
            node['func'] = CORRECT_FUNC
            changed += 1
    assert changed == 2, f"Expected 2 nodes, patched {changed} in {profile_path}"
    path.write_text(json.dumps(flows, ensure_ascii=False))
    print(f"Patched {changed} nodes in {profile_path}")
```

```bash
python3 /tmp/fix_auth_nodes.py
```

Expected output:
```
Patched 2 nodes in conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
Patched 2 nodes in conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
```

- [ ] **Step 4: Run verify to confirm all four assertions pass**

```bash
node scripts/verify-sync-flow.js 2>&1 | grep -E 'chameleon-(depth|refresh)-auth'
```

Expected: 4 PASS lines.

- [ ] **Step 5: Confirm profiles still byte-match**

```bash
node scripts/verify-profile-parity.js 2>&1 | tail -5
```

Expected: `All N checks passed`.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-sync-flow.js
git commit -m "fix(flows): replace dead global.get(authCheck) with verifyBearer in chameleon depth and refresh auth nodes"
```

---

### Task 2: Consolidate `chameleon-depth-save` and bump `sync_version`

Node `bf93cd55db0eb57f`. Currently runs 3 separate `UPDATE devices SET chameleon_swtN_depth_cm` statements with no `sync_version` bump. The existing `trg_sync_devices_outbox_au` trigger fires on `sync_version` changes — depth saves currently never fire it. Use `COALESCE(sync_version, 0) + 1` to match the pattern in every other node that bumps sync_version.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Write the failing verify assertions**

Add to `scripts/verify-sync-flow.js`:

```js
expectIncludesById('bf93cd55db0eb57f',
  'COALESCE(sync_version, 0) + 1',
  'chameleon-depth-save bumps sync_version (COALESCE pattern) so outbox trigger fires');
```

- [ ] **Step 2: Run to confirm the assertion fails**

```bash
node scripts/verify-sync-flow.js 2>&1 | grep 'chameleon-depth-save bumps'
```

Expected: `FAIL`

- [ ] **Step 3: Apply the fix to both flows.json files**

Save as `/tmp/fix_depth_save.py` and run it:

```python
import json, pathlib

OLD_BODY = (
    "    await run('BEGIN IMMEDIATE');\n"
    "    if ('chameleonSwt1DepthCm' in body) {\n"
    "      await run('UPDATE devices SET chameleon_swt1_depth_cm = ? WHERE deveui = ?',\n"
    "        [body.chameleonSwt1DepthCm ?? null, deveui]);\n"
    "    }\n"
    "    if ('chameleonSwt2DepthCm' in body) {\n"
    "      await run('UPDATE devices SET chameleon_swt2_depth_cm = ? WHERE deveui = ?',\n"
    "        [body.chameleonSwt2DepthCm ?? null, deveui]);\n"
    "    }\n"
    "    if ('chameleonSwt3DepthCm' in body) {\n"
    "      await run('UPDATE devices SET chameleon_swt3_depth_cm = ? WHERE deveui = ?',\n"
    "        [body.chameleonSwt3DepthCm ?? null, deveui]);\n"
    "    }\n"
    "    await run('COMMIT');"
)

NEW_BODY = (
    "    await run('BEGIN IMMEDIATE');\n"
    "    const sets = [];\n"
    "    const params = [];\n"
    "    if ('chameleonSwt1DepthCm' in body) {\n"
    "      sets.push('chameleon_swt1_depth_cm = ?');\n"
    "      params.push(body.chameleonSwt1DepthCm ?? null);\n"
    "    }\n"
    "    if ('chameleonSwt2DepthCm' in body) {\n"
    "      sets.push('chameleon_swt2_depth_cm = ?');\n"
    "      params.push(body.chameleonSwt2DepthCm ?? null);\n"
    "    }\n"
    "    if ('chameleonSwt3DepthCm' in body) {\n"
    "      sets.push('chameleon_swt3_depth_cm = ?');\n"
    "      params.push(body.chameleonSwt3DepthCm ?? null);\n"
    "    }\n"
    "    if (sets.length > 0) {\n"
    "      sets.push('sync_version = COALESCE(sync_version, 0) + 1');\n"
    "      sets.push(\"updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')\");\n"
    "      params.push(deveui);\n"
    "      await run('UPDATE devices SET ' + sets.join(', ') + ' WHERE deveui = ?', params);\n"
    "    }\n"
    "    await run('COMMIT');"
)

PROFILES = [
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
    'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
]

for profile_path in PROFILES:
    path = pathlib.Path(profile_path)
    flows = json.loads(path.read_text())
    for node in flows:
        if node.get('id') == 'bf93cd55db0eb57f':
            assert OLD_BODY in node['func'], f"body not found in {profile_path}"
            node['func'] = node['func'].replace(OLD_BODY, NEW_BODY, 1)
    path.write_text(json.dumps(flows, ensure_ascii=False))
    print(f"Patched {profile_path}")
```

```bash
python3 /tmp/fix_depth_save.py
```

- [ ] **Step 4: Run verify to confirm pass and no parity regressions**

```bash
node scripts/verify-sync-flow.js 2>&1 | grep 'chameleon-depth-save bumps'
node scripts/verify-profile-parity.js 2>&1 | tail -3
```

Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-sync-flow.js
git commit -m "fix(flows): consolidate chameleon-depth-save and bump sync_version to trigger outbox event"
```

---

### Task 3: Add chameleon depth columns to `trg_sync_devices_outbox_au`

Node `sync-init-fn`. The trigger's WHEN clause does not include `chameleon_swt*_depth_cm`. After Task 2 the sync_version bump fires the trigger, but the outbox payload does not carry depth values. Fix: add the three depth columns to both the WHEN clause and the `json_object` payload so cloud sync receives the updated depths.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Write failing assertions**

Add to `scripts/verify-sync-flow.js`:

```js
expectIncludesById('sync-init-fn',
  "'chameleon_swt1_depth_cm', NEW.chameleon_swt1_depth_cm",
  'trg_sync_devices_outbox_au payload includes chameleon_swt1_depth_cm');
expectIncludesById('sync-init-fn',
  "'chameleon_swt2_depth_cm', NEW.chameleon_swt2_depth_cm",
  'trg_sync_devices_outbox_au payload includes chameleon_swt2_depth_cm');
expectIncludesById('sync-init-fn',
  "'chameleon_swt3_depth_cm', NEW.chameleon_swt3_depth_cm",
  'trg_sync_devices_outbox_au payload includes chameleon_swt3_depth_cm');
```

- [ ] **Step 2: Run to confirm all three fail**

```bash
node scripts/verify-sync-flow.js 2>&1 | grep 'trg_sync_devices_outbox_au payload'
```

Expected: 3 FAIL lines.

- [ ] **Step 3: Apply the fix to both flows.json files**

Save as `/tmp/fix_trigger.py` and run it:

```python
import json, pathlib

# Extend WHEN clause: insert chameleon depth conditions before deleted_at
OLD_WHEN_TAIL = (
    "COALESCE(NEW.soil_moisture_probe_depths_configured,0) <> COALESCE(OLD.soil_moisture_probe_depths_configured,0) OR "
    "COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'')"
)

NEW_WHEN_TAIL = (
    "COALESCE(NEW.soil_moisture_probe_depths_configured,0) <> COALESCE(OLD.soil_moisture_probe_depths_configured,0) OR "
    "COALESCE(NEW.chameleon_swt1_depth_cm,-1) <> COALESCE(OLD.chameleon_swt1_depth_cm,-1) OR "
    "COALESCE(NEW.chameleon_swt2_depth_cm,-1) <> COALESCE(OLD.chameleon_swt2_depth_cm,-1) OR "
    "COALESCE(NEW.chameleon_swt3_depth_cm,-1) <> COALESCE(OLD.chameleon_swt3_depth_cm,-1) OR "
    "COALESCE(NEW.deleted_at,'') <> COALESCE(OLD.deleted_at,'')"
)

# Extend payload: insert depth columns after soil_moisture_probe_depths_configured
OLD_PAYLOAD_PART = (
    "'soil_moisture_probe_depths_configured', COALESCE(NEW.soil_moisture_probe_depths_configured, 0), "
    "'gateway_device_eui',"
)

NEW_PAYLOAD_PART = (
    "'soil_moisture_probe_depths_configured', COALESCE(NEW.soil_moisture_probe_depths_configured, 0), "
    "'chameleon_swt1_depth_cm', NEW.chameleon_swt1_depth_cm, "
    "'chameleon_swt2_depth_cm', NEW.chameleon_swt2_depth_cm, "
    "'chameleon_swt3_depth_cm', NEW.chameleon_swt3_depth_cm, "
    "'gateway_device_eui',"
)

PROFILES = [
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
    'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
]

for profile_path in PROFILES:
    path = pathlib.Path(profile_path)
    flows = json.loads(path.read_text())
    for node in flows:
        if node.get('id') == 'sync-init-fn':
            f = node['func']
            assert OLD_WHEN_TAIL in f, f"WHEN tail not found in {profile_path}"
            assert OLD_PAYLOAD_PART in f, f"payload part not found in {profile_path}"
            f = f.replace(OLD_WHEN_TAIL, NEW_WHEN_TAIL, 1)
            f = f.replace(OLD_PAYLOAD_PART, NEW_PAYLOAD_PART, 1)
            node['func'] = f
    path.write_text(json.dumps(flows, ensure_ascii=False))
    print(f"Patched {profile_path}")
```

```bash
python3 /tmp/fix_trigger.py
```

- [ ] **Step 4: Run full verify to confirm all assertions pass**

```bash
node scripts/verify-sync-flow.js 2>&1 | grep 'trg_sync_devices_outbox_au payload'
node scripts/verify-sync-flow.js 2>&1 | tail -3
node scripts/verify-profile-parity.js 2>&1 | tail -3
```

Expected: 3 PASS for payload assertions, overall pass, parity pass.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-sync-flow.js
git commit -m "fix(sync): add chameleon depth columns to device outbox trigger WHEN clause and payload"
```

---

### Task 4: Rebuild GUI bundle

The React source calls `PUT /api/devices/:deveui/chameleon/depth` (correct). The deployed bundle on KABA100 is stale and still calls the removed `/chameleon-config`. Rebuild locally. Note: `vite.config.js` sets `outDir: 'build'` — verify under `web/react-gui/build/assets/`.

**Files:**
- `web/react-gui/build/` (rebuilt static assets, committed in `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/`)

- [ ] **Step 1: Build the React GUI**

```bash
cd web/react-gui && npm run build
```

Expected: build completes with no TypeScript errors.

- [ ] **Step 2: Confirm the old stale API call is absent**

```bash
grep -r "chameleon-config\|setChameleonConfig" web/react-gui/build/assets/ && echo "FAIL: old API still present" || echo "PASS: old API absent"
```

Expected: `PASS: old API absent`

- [ ] **Step 3: Confirm the new API call is present**

```bash
grep -l "chameleon/depth" web/react-gui/build/assets/*.js | head -3
```

Expected: at least one JS filename listed.

- [ ] **Step 4: Commit the new build**

```bash
git add feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
git commit -m "build(gui): rebuild React bundle — depth endpoint calls PUT /api/devices/:deveui/chameleon/depth"
```

---

### Task 5: Live deployment verification on KABA100

Run after all four tasks are committed and deployed to KABA100. SSH to kaba100 uses password auth — use `sshpass` or the `SSH_ASKPASS` helper from MEMORY.md.

- [ ] **Step 1: Confirm stale API string absent from deployed bundle**

```bash
ssh root@100.93.68.86 'grep -Rl "chameleon-config\|setChameleonConfig" /usr/lib/node-red/gui/assets/ 2>/dev/null && echo STALE || echo CLEAN'
```

Expected: `CLEAN`

- [ ] **Step 2: Confirm unauthenticated depth request returns 401 (not 500)**

```bash
ssh root@100.93.68.86 'curl -s -o /dev/null -w "%{http_code}" -X PUT http://localhost:1880/api/devices/A84041CE3F5ECF52/chameleon/depth -H "Content-Type: application/json" -d "{}"'
```

Expected: `401`

- [ ] **Step 3: Confirm unauthenticated refresh request returns 401 (not 500)**

```bash
ssh root@100.93.68.86 'curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:1880/api/devices/A84041CE3F5ECF52/chameleon/refresh-calibration'
```

Expected: `401`

- [ ] **Step 4: Open the LSN50 configure panel in the browser and save depths for Chameleon 2**

Using the live GUI at `http://100.93.68.86:1880/gui`, navigate to the Chameleon 2 device configure panel and save depths (e.g., 5 cm / 15 cm / 40 cm). Verify the panel shows "Chameleon depths saved." without an error.

- [ ] **Step 5: Confirm depths persisted in DB**

```bash
ssh root@100.93.68.86 'sqlite3 -header -column /data/db/farming.db "SELECT name, deveui, chameleon_swt1_depth_cm, chameleon_swt2_depth_cm, chameleon_swt3_depth_cm, sync_version FROM devices WHERE deveui = \"A84041CE3F5ECF52\";"'
```

Expected: non-NULL depth values and `sync_version` greater than the pre-save value.

- [ ] **Step 6: Confirm depth save emitted an outbox event**

```bash
ssh root@100.93.68.86 'sqlite3 -header /data/db/farming.db "SELECT aggregate_type, op, occurred_at, payload_json FROM sync_outbox WHERE aggregate_type = \"DEVICE\" ORDER BY occurred_at DESC LIMIT 3;"'
```

Expected: a recent row with `op = DEVICE_FLAGS_UPDATED`. The `payload_json` column should contain `chameleon_swt1_depth_cm`, `chameleon_swt2_depth_cm`, `chameleon_swt3_depth_cm`.
