# Chameleon Depth Review Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the review findings left after the Chameleon depth/auth implementation: working Node-RED crypto imports, honest depth-save responses, server-side depth validation, deployable GUI assets, and a stronger cloud regression test.

**Architecture:** The edge remains the source of truth for Chameleon depth configuration. `osi-os` owns the local API, Node-RED flow metadata, SQLite outbox trigger, and firmware GUI bundle. `osi-server` remains read-only for Chameleon configuration and only mirrors edge-synced depth fields.

**Tech Stack:** Node-RED function nodes in `flows.json`, SQLite via `osi-db-helper`, React/Vite static GUI bundles, Node-based `scripts/verify-sync-flow.js`, Spring/React frontend tests in `osi-server`.

---

## File Map

| File | Change |
|------|--------|
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` | Add missing `crypto` libs to Chameleon auth nodes; harden `chameleon-depth-save` |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` | Same flow changes as `bcm2712` |
| `scripts/verify-sync-flow.js` | Add assertions for Chameleon auth libs and depth-save validation/error behavior |
| `.gitignore` | Stop ignoring the firmware GUI bundle directory |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/` | Track the complete rebuilt GUI bundle, not only `index.html` |
| `../osi-server/frontend/tests/chameleonSwtCanonical.test.ts` | Make the removed-coefficient regression test feed actual legacy coefficient fields |

---

### Task 1: Add Missing `crypto` Function Libs To Chameleon Auth Nodes

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add failing verification for the missing Node-RED libs**

Add these assertions next to the existing Chameleon auth assertions in `scripts/verify-sync-flow.js`:

```js
expectLibById('8b93fa005d78e25f', 'crypto', 'crypto', 'imports crypto for Chameleon depth auth verification');
expectLibById('44e7d74ff3668e01', 'crypto', 'crypto', 'imports crypto for Chameleon refresh auth verification');
```

- [ ] **Step 2: Confirm the new assertions fail before the fix**

Run:

```bash
node scripts/verify-sync-flow.js > /tmp/verify-sync-flow-before-crypto.log 2>&1 || true
rg "Chameleon (depth|refresh) auth verification|MISSING.*chameleon-(depth|refresh)-auth" /tmp/verify-sync-flow-before-crypto.log
```

Expected: both Chameleon auth nodes are reported without the `crypto` lib.

- [ ] **Step 3: Patch both profile flow files**

Run this repository-local JSON patch script:

```bash
node - <<'NODE'
const fs = require('fs');

const profiles = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const targetIds = new Set(['8b93fa005d78e25f', '44e7d74ff3668e01']);

for (const file of profiles) {
  const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
  let patched = 0;
  for (const node of flows) {
    if (!targetIds.has(node.id)) continue;
    const libs = Array.isArray(node.libs) ? node.libs : [];
    if (!libs.some((lib) => lib && lib.var === 'crypto' && lib.module === 'crypto')) {
      node.libs = [...libs, { var: 'crypto', module: 'crypto' }];
    }
    patched += 1;
  }
  if (patched !== 2) {
    throw new Error(`${file}: expected to patch 2 Chameleon auth nodes, patched ${patched}`);
  }
  fs.writeFileSync(file, JSON.stringify(flows));
  console.log(`${file}: patched ${patched} auth nodes`);
}
NODE
```

- [ ] **Step 4: Verify the auth node metadata**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const flows = JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json', 'utf8'));
for (const id of ['8b93fa005d78e25f', '44e7d74ff3668e01']) {
  const node = flows.find((item) => item.id === id);
  const hasCrypto = Array.isArray(node?.libs) && node.libs.some((lib) => lib.var === 'crypto' && lib.module === 'crypto');
  console.log(`${id} ${node?.name}: crypto=${hasCrypto}`);
}
NODE
```

Expected:

```text
8b93fa005d78e25f chameleon-depth-auth: crypto=true
44e7d74ff3668e01 chameleon-refresh-auth: crypto=true
```

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-sync-flow.js
git commit -m "fix(flows): import crypto in Chameleon auth nodes"
```

---

### Task 2: Harden `chameleon-depth-save`

`chameleon-depth-save` must only report success when a live device row was updated. It must also normalize the route DevEUI and reject invalid direct API payloads rather than relying only on GUI validation.

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add failing verification for validation and 404 behavior**

Add these assertions near the existing `bf93cd55db0eb57f` assertion in `scripts/verify-sync-flow.js`:

```js
expectIncludesById('bf93cd55db0eb57f', 'function parseDepthCm', 'chameleon-depth-save validates direct API depth values');
expectIncludesById('bf93cd55db0eb57f', 'Number.isFinite(parsed)', 'chameleon-depth-save rejects non-finite direct API depth values');
expectIncludesById('bf93cd55db0eb57f', '.trim().toUpperCase()', 'chameleon-depth-save normalizes route DevEUI before persistence');
expectIncludesById('bf93cd55db0eb57f', 'deleted_at IS NULL', 'chameleon-depth-save ignores deleted devices');
expectIncludesById('bf93cd55db0eb57f', 'if (changes === 0)', 'chameleon-depth-save returns 404 when no device row was updated');
expectIncludesById('bf93cd55db0eb57f', "Device not found", 'chameleon-depth-save reports missing devices honestly');
```

- [ ] **Step 2: Confirm the new assertions fail before the fix**

Run:

```bash
node scripts/verify-sync-flow.js > /tmp/verify-sync-flow-before-depth-hardening.log 2>&1 || true
rg "chameleon-depth-save" /tmp/verify-sync-flow-before-depth-hardening.log
```

Expected: the new `chameleon-depth-save` assertions fail.

- [ ] **Step 3: Replace `chameleon-depth-save` in both profile flow files**

Run:

```bash
node - <<'NODE'
const fs = require('fs');

const files = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

const func = `return (async () => {
  const db = new osiDb.Database('/data/db/farming.db');
  const run = (sql, params = []) => new Promise((res, rej) => {
    db.run(sql, params, function(error) {
      if (error) return rej(error);
      return res(this && typeof this.changes === 'number' ? this.changes : 0);
    });
  });
  const close = () => new Promise(res => db.close(() => res()));

  function parseDepthCm(label, value) {
    if (value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      const err = new Error(label + ' must be a finite number or null');
      err.statusCode = 400;
      throw err;
    }
    if (parsed <= 0 || parsed > 1000) {
      const err = new Error(label + ' must be greater than 0 and no more than 1000 cm, or null');
      err.statusCode = 400;
      throw err;
    }
    return Math.round(parsed * 100) / 100;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  try {
    const deveui = String((msg.req.params || {}).deveui || '').trim().toUpperCase();
    if (!deveui) {
      msg.statusCode = 400;
      msg.payload = { error: 'missing deveui' };
      await close();
      return [null, msg];
    }

    const body = typeof msg.payload === 'object' && msg.payload !== null && !Array.isArray(msg.payload) ? msg.payload : {};
    const sets = [];
    const params = [];
    if (hasOwn(body, 'chameleonSwt1DepthCm')) {
      sets.push('chameleon_swt1_depth_cm = ?');
      params.push(parseDepthCm('SWT1 depth', body.chameleonSwt1DepthCm));
    }
    if (hasOwn(body, 'chameleonSwt2DepthCm')) {
      sets.push('chameleon_swt2_depth_cm = ?');
      params.push(parseDepthCm('SWT2 depth', body.chameleonSwt2DepthCm));
    }
    if (hasOwn(body, 'chameleonSwt3DepthCm')) {
      sets.push('chameleon_swt3_depth_cm = ?');
      params.push(parseDepthCm('SWT3 depth', body.chameleonSwt3DepthCm));
    }
    if (sets.length === 0) {
      msg.statusCode = 400;
      msg.payload = { error: 'No depth fields supplied' };
      await close();
      return [null, msg];
    }

    sets.push("sync_version = COALESCE(sync_version, 0) + 1");
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    params.push(deveui);

    await run('BEGIN IMMEDIATE');
    const changes = await run('UPDATE devices SET ' + sets.join(', ') + ' WHERE UPPER(deveui) = ? AND deleted_at IS NULL', params);
    if (changes === 0) {
      await run('ROLLBACK');
      msg.statusCode = 404;
      msg.payload = { error: 'Device not found' };
      await close();
      return [null, msg];
    }
    await run('COMMIT');
    msg.payload = { ok: true };
    msg.statusCode = 200;
    await close();
    return [null, msg];
  } catch (e) {
    try { await run('ROLLBACK'); } catch (_) {}
    try { await close(); } catch (_) {}
    msg.statusCode = e.statusCode || 500;
    msg.payload = { error: e.message };
    return [null, msg];
  }
})();`;

for (const file of files) {
  const flows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = flows.find((item) => item.id === 'bf93cd55db0eb57f');
  if (!node) throw new Error(`${file}: missing chameleon-depth-save node`);
  node.func = func;
  fs.writeFileSync(file, JSON.stringify(flows));
  console.log(`${file}: patched chameleon-depth-save`);
}
NODE
```

- [ ] **Step 4: Verify the hardening assertions**

Run:

```bash
node scripts/verify-sync-flow.js > /tmp/verify-sync-flow-after-depth-hardening.log 2>&1 || true
rg "chameleon-depth-save" /tmp/verify-sync-flow-after-depth-hardening.log
```

Expected: all `chameleon-depth-save` lines are `OK`.

- [ ] **Step 5: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/verify-sync-flow.js
git commit -m "fix(flows): validate Chameleon depth saves"
```

---

### Task 3: Track A Complete Firmware GUI Bundle

The current commit tracks only `feeds/.../gui/index.html`, but the referenced hashed JS/CSS files are ignored. A clean checkout can ship an `index.html` pointing at missing assets. The firmware GUI bundle must be tracked as a coherent static asset set.

**Files:**
- Modify: `.gitignore`
- Modify/Add: `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/index.html`
- Add: `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/assets/*`
- Add: `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/*`

- [ ] **Step 1: Stop ignoring the firmware GUI bundle**

Edit `.gitignore` and remove these two lines:

```gitignore
/feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
/feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/index.html
```

Keep `/react_gui.tar.gz` ignored.

- [ ] **Step 2: Rebuild and copy the GUI bundle**

Run:

```bash
cd web/react-gui
npm run test:unit
npm run build
cd ../..
rm -rf feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
mkdir -p feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
cp -a web/react-gui/build/. feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
```

Expected: `npm run test:unit` and `npm run build` pass.

- [ ] **Step 3: Verify the tracked index references tracked assets**

Run:

```bash
asset=$(node - <<'NODE'
const fs = require('fs');
const html = fs.readFileSync('feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/index.html', 'utf8');
const match = html.match(/src="\/gui\/assets\/([^"]+\.js)"/);
if (!match) process.exit(1);
console.log(match[1]);
NODE
)
test -f "feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/assets/$asset"
git add .gitignore feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
git diff --cached --name-only | rg 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/assets/.+\.js'
```

Expected: the JS asset referenced by `index.html` exists and is staged.

- [ ] **Step 4: Confirm old Chameleon config calls are absent from the copied bundle**

Run:

```bash
rg "chameleon-config|setChameleonConfig" feeds/chirpstack-openwrt-feed/apps/node-red/files/gui && exit 1 || true
rg "chameleon/depth|refresh-calibration" feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/assets
```

Expected: no old config references; at least one match for `chameleon/depth` and `refresh-calibration`.

- [ ] **Step 5: Commit**

```bash
git add .gitignore feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
git commit -m "chore(gui): track complete rebuilt firmware bundle"
```

---

### Task 4: Strengthen The Cloud Coefficient-Removal Regression Test

The current cloud test asserts absent coefficient fields are absent, but it does not prove legacy coefficient fields are ignored when present in raw backend data.

**Files:**
- Modify: `../osi-server/frontend/tests/chameleonSwtCanonical.test.ts`

- [ ] **Step 1: Replace the weak coefficient-removal test**

In `../osi-server/frontend/tests/chameleonSwtCanonical.test.ts`, replace the test named `normaliseDevice does NOT map coefficient fields (mapping removed)` with:

```ts
  test('normaliseDevice ignores legacy Chameleon coefficient fields when raw data still contains them', () => {
    const rawDevice = {
      id: 1,
      deviceEui: 'TEST-1',
      name: 'Test',
      type: 'KIWI_SENSOR',
      online: true,
      claimed: true,
      createdAt: '2026-05-02',
      chameleonEnabled: 1,
      chameleonSwt1DepthCm: 30,
      chameleonSwt1A: 1.5,
      chameleonSwt2B: 2.5,
      chameleonSwt3C: 3.5,
      chameleon_swt1_a: 4.5,
      chameleon_swt2_b: 5.5,
      chameleon_swt3_c: 6.5,
    } as any;

    const result = normaliseDevice(rawDevice as Device);
    assert.equal(result.chameleon_enabled, 1);
    assert.equal(result.chameleon_swt1_depth_cm, 30);
    assert.equal((result as any).chameleonSwt1A, undefined);
    assert.equal((result as any).chameleonSwt2B, undefined);
    assert.equal((result as any).chameleonSwt3C, undefined);
    assert.equal((result as any).chameleon_swt1_a, undefined);
    assert.equal((result as any).chameleon_swt2_b, undefined);
    assert.equal((result as any).chameleon_swt3_c, undefined);
  });
```

- [ ] **Step 2: Run frontend tests and build**

Run:

```bash
cd ../osi-server/frontend
npm run test:unit
npm run build
cd ../../osi-os
```

Expected: both commands pass.

- [ ] **Step 3: Commit in `osi-server`**

Run:

```bash
cd ../osi-server
git add frontend/tests/chameleonSwtCanonical.test.ts
git commit -m "test(frontend): assert Chameleon coefficients are ignored"
cd ../osi-os
```

---

### Task 5: Final Verification And Known Non-Chameleon Gate

This task prevents a false “green” claim. The Chameleon fixes must pass their targeted checks, and the branch owner must either fix or explicitly split the existing replay-ledger verification failures before release.

**Files:**
- No planned source edits.

- [ ] **Step 1: Run `osi-os` verification**

Run:

```bash
git diff --check origin/main..HEAD
scripts/check-mqtt-topics.sh
cd web/react-gui
npm run test:unit
npm run build
cd ../..
node scripts/verify-sync-flow.js > /tmp/verify-sync-flow-final.log 2>&1; status=$?
echo "verify-sync-flow status=$status"
rg '^FAIL:' /tmp/verify-sync-flow-final.log || true
```

Expected for the Chameleon follow-up:

```text
OK 8b93fa005d78e25f imports crypto for Chameleon depth auth verification
OK 44e7d74ff3668e01 imports crypto for Chameleon refresh auth verification
OK bf93cd55db0eb57f chameleon-depth-save validates direct API depth values
OK bf93cd55db0eb57f chameleon-depth-save returns 404 when no device row was updated
```

If `verify-sync-flow status` is non-zero and the only `FAIL:` lines are:

```text
FAIL: sync-pending-split missing routes pending cloud commands through the replay ledger
FAIL: sync-force-build missing routes force-sync replayed commands through the replay ledger
```

then the Chameleon review findings are fixed, but `osi-os` still has a separate release gate. Do not report the whole branch as green until those replay-ledger failures are fixed or split into a tracked issue.

- [ ] **Step 2: Run `osi-server` verification**

Run:

```bash
cd ../osi-server/frontend
npm run test:unit
npm run build
cd ../backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest
cd ../../osi-os
```

Expected: all commands pass.

- [ ] **Step 3: Check git status in both repos**

Run:

```bash
git status --short --branch
cd ../osi-server
git status --short --branch
cd ../osi-os
```

Expected: only intended committed changes remain. Existing unrelated dirty files should be reported, not reverted.

---

## Self-Review

- Spec coverage: Task 1 fixes the missing `crypto` imports; Task 2 fixes false success and direct API validation; Task 3 fixes the incomplete GUI bundle; Task 4 fixes the weak cloud regression test; Task 5 prevents false green reporting while preserving the known non-Chameleon verifier failures as a release gate.
- Placeholder scan: implementation steps contain concrete commands and code, with no deferred placeholders or undefined helper names.
- Type/name consistency: Node IDs match the reviewed Chameleon nodes: `8b93fa005d78e25f`, `44e7d74ff3668e01`, and `bf93cd55db0eb57f`. Depth payload fields stay `chameleonSwt1DepthCm`, `chameleonSwt2DepthCm`, and `chameleonSwt3DepthCm`.
