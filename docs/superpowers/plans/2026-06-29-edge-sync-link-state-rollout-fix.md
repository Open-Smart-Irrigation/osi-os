# Edge Sync Link State Rollout Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the edge history-sync rollout bug so existing linked gateways keep producing sync/history work after deploy, then safely repair Kaba100 and Silvan.

**Architecture:** Keep the edge DB canonical. `sync_link_state` is the cloud peer gate for link-gated triggers/history jobs; startup migration, account link finalization, deploy repair, seed schema, and live repair must all derive it from the existing linked `users` row plus the canonical gateway EUI. Do not use `linked_users`; that table is not present on field DBs.

**Tech Stack:** Node-RED `flows.json` function nodes, SQLite, Node.js repo verifiers, OpenWrt deploy helper, `sqlite3` CLI on seed/live DBs.

---

## Current Evidence

- Local verifier is already red in the correct place:

```text
FAIL: Sync Init Schema + Triggers missing creates sync link state table at runtime
FAIL: Sync Init Schema + Triggers missing backfills sync_link_state from existing linked users during runtime upgrade
```

- Kaba100 and Silvan had current local measurements, linked `users.auth_mode='server'`, and zero `sync_link_state` rows. New local rows were stored locally, but link-gated sync/history work stopped.
- `deploy.sh` now has a deploy-time guard, but runtime startup still needs the permanent migration.

## File Structure

- Modify `scripts/verify-sync-flow.js`: add regression assertions for runtime startup, account link, unlink, seed schema, and bundled DB schema.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`: runtime startup and link/unlink function nodes.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`: keep the Pi 4/3/2 profile byte-for-byte aligned with the Pi 5 flow payload.
- Modify `database/seed-blank.sql`: add `sync_link_state` to fresh DB schema.
- Modify `scripts/verify-db-schema-consistency.js`: require `sync_link_state` in every bundled seed DB.
- Modify bundled DB copies with `sqlite3`: add the table to all seed databases.
- Do not modify `osi-server` for this fix. The server endpoints and DB are not the active blocker.

Concrete quality risks:
- `flows.json` is a large generated JSON file. Use a small Node patch script to edit function-node bodies, then verify JSON parse and profile parity.
- Runtime startup should not brick Node-RED if the gateway EUI is missing; it should warn and leave the link gate unlinked. `deploy.sh` remains stricter and fails linked deploys with no resolvable EUI.
- Seed schema and startup migration must use the same column list to avoid future drift.

---

### Task 1: Add Failing Regression Assertions

**Files:**
- Modify: `scripts/verify-sync-flow.js`
- Test: `node scripts/verify-sync-flow.js`

- [ ] **Step 1: Add account-link assertions**

In `scripts/verify-sync-flow.js`, near the existing `Finalize linked account state` checks, add:

```js
expectIncludes(
  'Finalize linked account state',
  'INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at)',
  'persists sync_link_state when account link succeeds'
);
expectIncludes(
  'Finalize linked account state',
  'ON CONFLICT(peer_node) DO UPDATE SET',
  'upserts sync_link_state idempotently during account link'
);
expectIncludes(
  'Finalize linked account state',
  "normalizeGatewayDeviceEui(env.get('LINK_GATEWAY_DEVICE_EUI'))",
  'prefers linked gateway identity when finalizing sync_link_state'
);
```

- [ ] **Step 2: Add unlink assertions**

In `scripts/verify-sync-flow.js`, near the existing `Clear linked account state` checks, add:

```js
expectIncludes(
  'Clear linked account state',
  "UPDATE sync_link_state SET linked=0",
  'marks cloud sync_link_state unlinked during account unlink'
);
expectIncludes(
  'Clear linked account state',
  "WHERE peer_node='cloud'",
  'updates only the cloud sync_link_state row during unlink'
);
```

- [ ] **Step 3: Add seed schema assertions**

Inside the existing `if (fs.existsSync(seedSqlPath)) { ... }` block near the end of `scripts/verify-sync-flow.js`, add:

```js
expectFileIncludes('seed-blank.sql', seedSql, 'CREATE TABLE sync_link_state', 'seed-blank.sql defines sync_link_state');
expectFileIncludes('seed-blank.sql', seedSql, 'peer_node            TEXT PRIMARY KEY', 'seed-blank.sql keys sync_link_state by peer_node');
expectFileIncludes('seed-blank.sql', seedSql, 'gateway_device_eui   TEXT', 'seed-blank.sql stores sync_link_state gateway identity');
```

- [ ] **Step 4: Add bundled DB assertions**

Inside the existing `for (const seedDatabasePath of seedDatabasePaths) { ... }` loop in `scripts/verify-sync-flow.js`, add:

```js
const syncLinkStateColumns = new Set(readTableColumns(seedDatabasePath, 'sync_link_state'));
for (const name of ['peer_node', 'linked', 'server_url', 'cloud_user_id', 'gateway_device_eui', 'updated_at']) {
  expectCondition(
    syncLinkStateColumns.has(name),
    `${relativeSeedPath} includes sync_link_state.${name} in the bundled schema`,
    `${relativeSeedPath} is missing sync_link_state.${name} in the bundled schema`
  );
}
```

- [ ] **Step 5: Run verifier and capture expected failures**

Run:

```bash
node scripts/verify-sync-flow.js >/tmp/verify-sync-flow-before-link-state-fix.log 2>&1; status=$?; echo "status=$status"; grep -E 'FAIL:.*sync_link_state|FAIL:.*linked users|FAIL:.*account link|FAIL:.*seed-blank' /tmp/verify-sync-flow-before-link-state-fix.log
```

Expected: non-zero status. Failures should name missing startup `sync_link_state`, missing runtime backfill, missing account-link upsert/unlink, and missing seed DB schema. If unrelated failures appear, stop and inspect before changing runtime code.

---

### Task 2: Fix Runtime Startup Migration in Both Flow Profiles

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Test: `node scripts/verify-sync-flow.js`

- [ ] **Step 1: Patch the `Sync Init Schema + Triggers` function body**

Use a Node JSON rewrite, not manual string editing in escaped JSON. The patch must update both `bcm2712` and `bcm2709` flow files.

In the `Sync Init Schema + Triggers` function:

1. Change the DB helpers near the top from:

```js
const exec = (sql) => _db.run(sql);
```

to:

```js
const exec = (sql, params) => _db.run(sql, params);
const query = (sql, params) => _db.all(sql, params || []);
```

2. Add this helper after `gatewaySql`:

```js
function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}
```

3. After `for (const sql of stmts) { try { await exec(sql); } catch (_) {} }`, add:

```js
const syncLinkStateStmts = [
  `CREATE TABLE IF NOT EXISTS sync_link_state (
    peer_node TEXT PRIMARY KEY,
    linked INTEGER NOT NULL DEFAULT 0,
    server_url TEXT,
    cloud_user_id TEXT,
    gateway_device_eui TEXT,
    updated_at TEXT NOT NULL
  )`,
  "ALTER TABLE sync_link_state ADD COLUMN server_url TEXT",
  "ALTER TABLE sync_link_state ADD COLUMN cloud_user_id TEXT",
  "ALTER TABLE sync_link_state ADD COLUMN gateway_device_eui TEXT",
  "ALTER TABLE sync_link_state ADD COLUMN updated_at TEXT"
];
for (const sql of syncLinkStateStmts) {
  try { await exec(sql); } catch (error) {
    if (!/duplicate column name/i.test(String(error && error.message || error))) throw error;
  }
}
const linkedUsers = await query("SELECT id, server_url, cloud_user_id, server_linked_at FROM users WHERE auth_mode = 'server' AND server_url IS NOT NULL AND trim(server_url) <> '' ORDER BY COALESCE(server_linked_at, '') DESC, id DESC LIMIT 1");
if (linkedUsers.length) {
  const gatewayDeviceEui = normalizeGatewayDeviceEui(env.get('LINK_GATEWAY_DEVICE_EUI')) || normalizeGatewayDeviceEui(gateway);
  if (gatewayDeviceEui) {
    const linkedUser = linkedUsers[0];
    await exec(
      `INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at)
         VALUES('cloud', 1, ?, ?, ?, ?)
         ON CONFLICT(peer_node) DO UPDATE SET
           linked=1,
           server_url=excluded.server_url,
           cloud_user_id=excluded.cloud_user_id,
           gateway_device_eui=excluded.gateway_device_eui,
           updated_at=excluded.updated_at`,
      [
        String(linkedUser.server_url || '').trim(),
        linkedUser.cloud_user_id == null ? null : String(linkedUser.cloud_user_id),
        gatewayDeviceEui,
        new Date().toISOString()
      ]
    );
  } else {
    node.warn('Linked users exist but no gateway EUI is available to backfill sync_link_state');
  }
}
```

This exact query includes `FROM users WHERE auth_mode = 'server'`, satisfying the current verifier and documenting the intended migration source.

- [ ] **Step 2: Parse-check both JSON files**

Run:

```bash
node -e "for (const p of ['conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json']) { JSON.parse(require('fs').readFileSync(p,'utf8')); console.log('OK '+p); }"
```

Expected:

```text
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
```

- [ ] **Step 3: Run focused verifier**

Run:

```bash
node scripts/verify-sync-flow.js >/tmp/verify-sync-flow-after-startup-link-state.log 2>&1; status=$?; echo "status=$status"; grep -E 'FAIL:|sync_link_state|linked_users' /tmp/verify-sync-flow-after-startup-link-state.log | tail -40
```

Expected: the startup create/backfill failures are gone. Account-link and seed failures may remain until later tasks.

---

### Task 3: Persist Link State During Account Link and Unlink

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Test: `node scripts/verify-sync-flow.js`

- [ ] **Step 1: Patch `Finalize linked account state`**

In both flow files, update the function body for `Finalize linked account state`.

Add this helper before `const now = new Date().toISOString();`:

```js
function normalizeGatewayDeviceEui(value) {
  const raw = String(value || '').trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.length === 16) return raw === '0101010101010101' ? '' : raw;
  if (raw.length === 12) return raw.slice(0, 6) + 'FFFE' + raw.slice(6);
  return '';
}
const gatewayDeviceEui = normalizeGatewayDeviceEui(env.get('LINK_GATEWAY_DEVICE_EUI')) || normalizeGatewayDeviceEui(env.get('DEVICE_EUI'));
if (!gatewayDeviceEui) {
  msg.statusCode = 500;
  msg.payload = { message: 'Unable to resolve gateway identity for linked account state' };
  return [null, msg];
}
```

After the existing `UPDATE users ...` statement succeeds, add:

```js
await run(
  `INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at)
     VALUES('cloud', 1, ?, ?, ?, ?)
     ON CONFLICT(peer_node) DO UPDATE SET
       linked=1,
       server_url=excluded.server_url,
       cloud_user_id=excluded.cloud_user_id,
       gateway_device_eui=excluded.gateway_device_eui,
       updated_at=excluded.updated_at`,
  [serverUrl, String(cloudUserId), gatewayDeviceEui, now]
);
```

- [ ] **Step 2: Patch `Clear linked account state`**

In both flow files, before closing the DB in `Clear linked account state`, add:

```js
await run(
  "UPDATE sync_link_state SET linked=0, updated_at=? WHERE peer_node='cloud'",
  [new Date().toISOString()]
);
```

Keep this after the `users` unlink update so a failed user update does not clear the peer gate.

- [ ] **Step 3: Parse-check both JSON files**

Run:

```bash
node -e "for (const p of ['conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json']) { JSON.parse(require('fs').readFileSync(p,'utf8')); console.log('OK '+p); }"
```

Expected: both files parse.

- [ ] **Step 4: Run verifier**

Run:

```bash
node scripts/verify-sync-flow.js >/tmp/verify-sync-flow-after-link-finalize.log 2>&1; status=$?; echo "status=$status"; grep -E 'FAIL:|Finalize linked account state|Clear linked account state|sync_link_state' /tmp/verify-sync-flow-after-link-finalize.log | tail -80
```

Expected: account-link and unlink `sync_link_state` assertions pass. Seed DB assertions may remain red until Task 4.

---

### Task 4: Align Fresh Seed Schema and Bundled DBs

**Files:**
- Modify: `database/seed-blank.sql`
- Modify: `scripts/verify-db-schema-consistency.js`
- Modify SQLite DBs:
  - `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
  - `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
  - `database/farming.db`
  - `web/react-gui/farming.db`
- Test: `node scripts/verify-db-schema-consistency.js`

- [ ] **Step 1: Add schema to seed SQL**

In `database/seed-blank.sql`, after the `sync_cursor` table, add:

```sql
-- ---------------------------------------------------------------------------
-- sync_link_state
-- ---------------------------------------------------------------------------
CREATE TABLE sync_link_state (
  peer_node          TEXT PRIMARY KEY,
  linked            INTEGER NOT NULL DEFAULT 0,
  server_url        TEXT,
  cloud_user_id     TEXT,
  gateway_device_eui TEXT,
  updated_at        TEXT NOT NULL
);
```

- [ ] **Step 2: Add DB schema contract**

In `scripts/verify-db-schema-consistency.js`, add this entry to `schemaContract`:

```js
  sync_link_state: [
    'peer_node',
    'linked',
    'server_url',
    'cloud_user_id',
    'gateway_device_eui',
    'updated_at',
  ],
```

- [ ] **Step 3: Update bundled DB copies**

Run:

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
  sqlite3 "$db" "
    CREATE TABLE IF NOT EXISTS sync_link_state (
      peer_node TEXT PRIMARY KEY,
      linked INTEGER NOT NULL DEFAULT 0,
      server_url TEXT,
      cloud_user_id TEXT,
      gateway_device_eui TEXT,
      updated_at TEXT NOT NULL
    );
  "
done
```

- [ ] **Step 4: Verify seed schema**

Run:

```bash
node scripts/verify-db-schema-consistency.js
```

Expected: every listed DB prints `OK ...`, followed by:

```text
DB schema consistency verification passed
```

---

### Task 5: Full Local Verification

**Files:**
- Verify only

- [ ] **Step 1: Run syntax and whitespace checks**

Run:

```bash
sh -n deploy.sh
git diff --check -- deploy.sh scripts/verify-sync-flow.js database/seed-blank.sql scripts/verify-db-schema-consistency.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
```

Expected: no output, exit `0`.

- [ ] **Step 2: Run sync verifier**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: exit `0`. The output should include:

```text
OK Sync Init Schema + Triggers creates sync link state table at runtime
OK Sync Init Schema + Triggers backfills sync_link_state from existing linked users during runtime upgrade
OK Sync Init Schema + Triggers removed obsolete linked_users table for sync_link_state backfill
OK Finalize linked account state persists sync_link_state when account link succeeds
OK Clear linked account state marks cloud sync_link_state unlinked during account unlink
```

- [ ] **Step 3: Verify profile parity**

Run:

```bash
node scripts/verify-profile-parity.js
```

Expected:

```text
All parity checks passed.
```

- [ ] **Step 4: Inspect dirty worktree**

Run:

```bash
git status --short --branch
git diff --name-only
```

Expected: only scoped fix files plus already-known pre-existing local changes. Do not stage unrelated `CLAUDE.md`, `.config`, `analysis/`, or incident report files unless the user explicitly includes them.

---

### Task 6: Deploy the Fix to Kaba100 and Silvan Safely

**Files:**
- Deploy artifacts only
- Live targets: Kaba100 and Silvan edge gateways
- Do not access `osicloud.ch`

- [ ] **Step 1: Confirm access and backup each gateway**

For each gateway, run the existing safe deploy process:

```bash
ssh root@<gateway> 'ts=$(date -u +%Y%m%dT%H%M%SZ); backup=/data/db/backups/osi-os-$ts; mkdir -p "$backup"; cp -a /data/db /srv/node-red /usr/lib/node-red/gui "$backup"/; echo "$backup"'
```

Expected: backup command prints one `/data/db/backups/osi-os-...` path, and that path exists before deploy.

- [ ] **Step 2: Deploy using `deploy.sh`**

Use the repo's existing deploy path for the gateway. The deploy must run the new `ensure_sync_link_state` guard before Node-RED restart.

Expected deploy output includes:

```text
--- Sync link-state gate ---
OK: sync_link_state linked for cloud gateway <16_HEX_EUI>
```

If deploy prints:

```text
linked users exist but no gateway EUI is available to repair sync_link_state
```

stop and repair gateway identity first.

- [ ] **Step 3: Verify local DB after deploy**

On each gateway, run:

```bash
sqlite3 /data/db/farming.db "
SELECT 'linked_users', COUNT(*)
  FROM users
 WHERE auth_mode='server'
   AND server_url IS NOT NULL
   AND trim(server_url) <> ''
UNION ALL
SELECT 'sync_link_state', COUNT(*)
  FROM sync_link_state
 WHERE peer_node='cloud'
   AND linked=1
   AND gateway_device_eui IS NOT NULL
   AND trim(gateway_device_eui) <> '';
"
```

Expected for linked gateways:

```text
linked_users|1
sync_link_state|1
```

- [ ] **Step 4: Verify triggers do not contain literal generator fragments**

On each gateway, run:

```bash
sqlite3 /data/db/farming.db "
SELECT name
  FROM sqlite_master
 WHERE type='trigger'
   AND sql LIKE '%gatewaySql%';
"
```

Expected: no rows.

- [ ] **Step 5: Verify new uplinks enqueue sync/history work**

On each gateway, record current counts:

```bash
sqlite3 /data/db/farming.db "
SELECT MAX(recorded_at) FROM device_data;
SELECT MAX(recorded_at) FROM chameleon_readings;
SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL;
SELECT COUNT(*) FROM sync_history_dirty_keys WHERE peer_node='cloud';
"
```

Wait for one live uplink from an active device, then rerun the same query. Expected:
- newest local telemetry timestamp advances,
- either a new outbox row or a new history dirty key appears,
- no Node-RED sync-init errors in `logread`.

---

### Task 7: Backfill the Outage Window and Verify Cloud Freshness

**Files:**
- Live gateway DBs
- Server analysis API verification only

- [ ] **Step 1: Identify gap boundaries per gateway**

On each gateway, run:

```bash
sqlite3 /data/db/farming.db "
SELECT 'device_data', MIN(recorded_at), MAX(recorded_at), COUNT(*)
  FROM device_data
 WHERE recorded_at >= '2026-06-29T00:00:00Z'
UNION ALL
SELECT 'chameleon_readings', MIN(recorded_at), MAX(recorded_at), COUNT(*)
  FROM chameleon_readings
 WHERE recorded_at >= '2026-06-29T00:00:00Z';
"
```

Use the last server-side fresh timestamp from the incident notes as the lower bound, then include all local rows after that timestamp.

- [ ] **Step 2: Enqueue corrected history work**

Use the existing history-sync/backfill mechanism from the deployed history enhancement. If the history dirty-key tables exist, insert missing dirty keys from local canonical rows using the same key format as runtime triggers. If the history worker is not yet deployed or not functioning, use the existing force-sync/bootstrap path as a temporary catch-up, then document the residual historical gap.

Required verification query after enqueue:

```bash
sqlite3 /data/db/farming.db "
SELECT peer_node, table_name, status, COUNT(*)
  FROM sync_history_dirty_keys
 WHERE peer_node='cloud'
 GROUP BY peer_node, table_name, status
 ORDER BY table_name, status;
"
```

Expected: rows exist for the missing local history tables until the worker drains them.

- [ ] **Step 3: Verify cloud/server freshness**

Using the non-production configured server for these gateways, verify:

```text
Kaba100 Chameleon 1 server chameleon_readings latest >= latest local row after fix
Silvan Wetterstation server sensor_data latest >= latest local row after fix
```

Also verify the analysis view/API shows fresh current data again. If heartbeats are fresh but history remains stale, inspect gateway history batch logs before changing server code.

---

## Final Verification Checklist

- [ ] `node scripts/verify-sync-flow.js` passes locally.
- [ ] `node scripts/verify-profile-parity.js` passes locally.
- [ ] `node scripts/verify-db-schema-consistency.js` passes locally.
- [ ] Kaba100 has `sync_link_state(peer_node='cloud', linked=1)` locally.
- [ ] Silvan has `sync_link_state(peer_node='cloud', linked=1)` locally.
- [ ] Latest local rows enqueue sync/history work after deploy.
- [ ] Server analysis freshness catches up after backfill.
- [ ] No trigger SQL on gateways contains literal `gatewaySql`.
- [ ] No production `osicloud.ch` access was used.

## Execution Recommendation

Use subagent-driven development for Tasks 1-5 because the flow JSON and DB seed updates are separable and reviewable. Execute Tasks 6-7 inline in the main session because they touch live gateways and require operator judgment.
