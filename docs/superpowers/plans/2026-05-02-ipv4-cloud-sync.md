# IPv4 Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OSI edge-to-cloud REST sync reliable on IPv4-only or broken-IPv6 Pi networks, and prevent sync data loss when cloud REST requests fail before a valid HTTP response.

**Architecture:** Keep MQTT unchanged and scope the fix to OSI cloud REST calls. Replace Node-RED core HTTP request nodes on the sync/account-link paths with a small packaged Node helper that calls `http.request` / `https.request` using `family: 4`, then harden event acknowledgment so outbox rows are marked delivered only after the cloud explicitly accepts them. Add server event-outcome metadata so the edge can safely mark applied and duplicate event UUIDs while keeping failed rows pending for retry.

**Tech Stack:** Node-RED flow JSON, Node.js CommonJS helper module, SQLite outbox state, Spring Boot sync API, Gradle/JUnit, repo static verification scripts.

---

## Diagnosis This Plan Addresses

The Uganda Pi can reach `https://server.opensmartirrigation.org` with `curl -4`, but Node.js calls from the Pi fail with `AggregateError` containing IPv6 `ENETUNREACH` and IPv4 timeout attempts. A direct Node `https.request(..., { family: 4 })` succeeds against the pending-commands endpoint. Node DNS ordering alone did not fix it.

The edge flow also has a data-loss bug: `Mark Synced Events Delivered` treats a missing `msg.statusCode` as success, so a Node-RED HTTP request failure can still set `sync_outbox.delivered_at`. The live Uganda Pi already has `sync_outbox` rows marked delivered after the cloud `sync_inbox` stopped advancing.

## File Structure

- Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/package.json`: local Node-RED helper package metadata.
- Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/index.js`: IPv4-only JSON REST helper for OSI cloud HTTP/HTTPS calls.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`: add `osi-cloud-http` as a local file dependency.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json`: lock the new local package.
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`: replace cloud REST HTTP request nodes with IPv4 helper function nodes; harden bootstrap/outbox/refresh/force-sync response handling.
- Modify `scripts/verify-sync-flow.js`: static checks for the helper, flow node types, helper imports, `family: 4`, and strict outbox response handling.
- Modify `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`: return per-event applied, duplicate, and failed UUIDs from `applyEvents`.
- Modify `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`: include event-outcome metadata in `/api/v1/sync/edge/events` responses.
- Modify `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/sync/EdgeSyncServiceDataPlaneTest.java`: cover event outcome lists.
- Modify `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java`: cover event response metadata.

Concrete quality risks:

- Do not force IPv4 globally in Node-RED. The fix belongs only in OSI cloud REST calls, not local ChirpStack, MQTT, OpenAgri, or generic internet fetches.
- Do not change the server URL to an IP literal. Keep the hostname so TLS SNI and certificate validation remain correct.
- Do not mark all outbox rows delivered on a `200` if the server reports partial failures. Mark only accepted event UUIDs.
- Do not repair the live Uganda outbox before the strict acknowledgment guard is deployed, or the same communication failure can mark replayed rows delivered again.

## Task 1: Add The IPv4 Cloud REST Helper

**Files:**
- Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/package.json`
- Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/index.js`
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json`
- Test through `scripts/verify-sync-flow.js`

- [ ] **Step 1: Add the failing static checks**

In `scripts/verify-sync-flow.js`, add constants near the other helper candidates:

```js
const cloudHttpHelperPath = path.join(nodeRedRoot, 'osi-cloud-http', 'index.js');
const cloudHttpPackagePath = path.join(nodeRedRoot, 'osi-cloud-http', 'package.json');
```

After `const packageJsonPath = path.join(nodeRedRoot, 'package.json');`, read the files:

```js
const cloudHttpHelperSource = fs.existsSync(cloudHttpHelperPath) ? fs.readFileSync(cloudHttpHelperPath, 'utf8') : '';
const cloudHttpPackageSource = fs.existsSync(cloudHttpPackagePath) ? fs.readFileSync(cloudHttpPackagePath, 'utf8') : '';
const nodeRedPackageSource = fs.readFileSync(packageJsonPath, 'utf8');
```

Add these assertions after the existing helper package assertions:

```js
expectCondition(!!cloudHttpHelperSource, 'osi-cloud-http helper exists', 'missing osi-cloud-http helper');
expectFileIncludes('osi-cloud-http/index.js', cloudHttpHelperSource, 'family: 4', 'forces IPv4 DNS/address selection');
expectFileIncludes('osi-cloud-http/index.js', cloudHttpHelperSource, 'requestJsonIpv4', 'exports requestJsonIpv4');
expectFileIncludes('osi-cloud-http/index.js', cloudHttpHelperSource, 'setTimeout', 'sets a bounded cloud REST timeout');
expectFileIncludes('osi-cloud-http/index.js', cloudHttpHelperSource, 'JSON.parse', 'parses JSON responses');
expectFileIncludes('osi-cloud-http/package.json', cloudHttpPackageSource, '"name": "osi-cloud-http"', 'declares the helper package name');
expectFileIncludes('node-red/package.json', nodeRedPackageSource, '"osi-cloud-http": "file:osi-cloud-http"', 'installs the helper package as a local dependency');
```

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: `FAIL: missing osi-cloud-http helper` or a related missing-helper assertion.

- [ ] **Step 2: Create package metadata**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/package.json`:

```json
{
  "name": "osi-cloud-http",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
```

- [ ] **Step 3: Create the IPv4 helper**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http/index.js`:

```js
'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 30000;

function hasHeader(headers, wanted) {
  const needle = String(wanted || '').toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

function parseJsonBody(rawBody) {
  if (rawBody == null || rawBody === '') return null;
  try {
    return JSON.parse(rawBody);
  } catch (_) {
    return rawBody;
  }
}

function normalizeRequest(input) {
  const source = input || {};
  const method = String(source.method || 'GET').trim().toUpperCase();
  const url = String(source.url || '').trim();
  if (!url) {
    throw new Error('Cloud REST URL is required');
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported cloud REST protocol: ${parsed.protocol}`);
  }
  const headers = Object.assign({}, source.headers || {});
  const hasBody = source.payload !== undefined && source.payload !== null && method !== 'GET' && method !== 'HEAD';
  const body = hasBody
    ? Buffer.from(typeof source.payload === 'string' ? source.payload : JSON.stringify(source.payload))
    : null;
  if (body && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  if (body && !hasHeader(headers, 'content-length')) {
    headers['Content-Length'] = String(body.length);
  }
  const timeoutMs = Math.max(1000, Number(source.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  return { method, parsed, headers, body, timeoutMs };
}

function requestJsonIpv4(input) {
  const request = normalizeRequest(input);
  const transport = request.parsed.protocol === 'https:' ? https : http;
  const options = {
    protocol: request.parsed.protocol,
    hostname: request.parsed.hostname,
    port: request.parsed.port || undefined,
    path: `${request.parsed.pathname}${request.parsed.search}`,
    method: request.method,
    headers: request.headers,
    family: 4,
    timeout: request.timeoutMs
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: Number(res.statusCode || 0),
          headers: res.headers || {},
          payload: parseJsonBody(rawBody),
          rawBody,
          diagnostics: {
            family: 4,
            host: request.parsed.hostname,
            protocol: request.parsed.protocol
          }
        });
      });
    });

    req.setTimeout(request.timeoutMs, () => {
      req.destroy(new Error(`Cloud REST IPv4 request timed out after ${request.timeoutMs}ms`));
    });
    req.on('error', (error) => {
      error.cloudRestIpv4 = {
        family: 4,
        host: request.parsed.hostname,
        protocol: request.parsed.protocol
      };
      reject(error);
    });
    if (request.body) req.write(request.body);
    req.end();
  });
}

module.exports = {
  requestJsonIpv4
};
```

- [ ] **Step 4: Add the local dependency**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`, add:

```json
"osi-cloud-http": "file:osi-cloud-http"
```

Keep the dependencies alphabetically near the existing `osi-*` helpers:

```json
"osi-chirpstack-helper": "file:osi-chirpstack-helper",
"osi-cloud-http": "file:osi-cloud-http",
"osi-dendro-helper": "file:osi-dendro-helper",
"osi-db-helper": "file:osi-db-helper",
```

- [ ] **Step 5: Update the package lock**

Run:

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red
npm install --package-lock-only
```

Expected: command exits `0` and `package-lock.json` contains `osi-cloud-http`.

- [ ] **Step 6: Prove the helper uses IPv4 locally**

Run from repo root:

```bash
node - <<'NODE'
const http = require('http');
const { requestJsonIpv4 } = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http');

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ family: req.socket.remoteFamily, address: req.socket.remoteAddress }));
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const port = server.address().port;
    const result = await requestJsonIpv4({ method: 'GET', url: `http://localhost:${port}/ping`, timeoutMs: 5000 });
    if (result.statusCode !== 200 || !result.payload || result.payload.family !== 'IPv4') {
      console.error(result);
      process.exitCode = 1;
    } else {
      console.log('OK helper reached localhost over IPv4');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
NODE
```

Expected: `OK helper reached localhost over IPv4`.

- [ ] **Step 7: Run the static checks**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: the helper-related assertions pass. Later flow assertions may still fail until Task 2 and Task 3 are complete.

- [ ] **Step 8: Commit**

```bash
git add scripts/verify-sync-flow.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-cloud-http
git commit -m "fix: add ipv4 cloud rest helper"
```

## Task 2: Route Cloud REST Nodes Through The IPv4 Helper

**Files:**
- Modify `scripts/verify-sync-flow.js`
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Test `node scripts/verify-sync-flow.js`

- [ ] **Step 1: Add failing flow-shape checks**

In `scripts/verify-sync-flow.js`, add this helper near `expectLibById`:

```js
function expectNodeTypeById(nodeId, expectedType, description) {
  const node = findNodeById(nodeId);
  if (!node) {
    fail(`missing node ${nodeId}`);
    return;
  }
  if (node.type !== expectedType) {
    fail(`${nodeId} expected type ${expectedType}, got ${node.type}: ${description}`);
  } else {
    console.log(`OK ${nodeId} ${description}`);
  }
}
```

Add this block near the sync/account-link wire assertions:

```js
const cloudRestNodeIds = [
  'al-link-server-auth',
  'sync-bootstrap-http',
  'sync-outbox-http',
  'sync-pending-http',
  'sync-refresh-http'
];
for (const nodeId of cloudRestNodeIds) {
  expectNodeTypeById(nodeId, 'function', 'uses function node for IPv4 cloud REST');
  expectLibById(nodeId, 'osiCloudHttp', 'osi-cloud-http', 'imports the IPv4 cloud REST helper');
  expectIncludesById(nodeId, 'requestJsonIpv4', 'calls requestJsonIpv4');
  expectIncludesById(nodeId, 'Cloud REST IPv4 request failed', 'preserves IPv4 request failures as message payloads');
}
expectIncludes('Run Force Sync', 'osiCloudHttp.requestJsonIpv4', 'uses the shared IPv4 cloud REST helper');
expectLibById('sync-force-build', 'osiCloudHttp', 'osi-cloud-http', 'imports the IPv4 helper for manual force sync');
```

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: failures that the five node IDs are still `http request` nodes and `Run Force Sync` does not import/call the helper.

- [ ] **Step 2: Replace each cloud HTTP request node with a helper function node**

For each node ID below in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, preserve the existing `id`, `z`, `x`, `y`, and `wires`, but change the node to a function node.

Node IDs:

```text
al-link-server-auth
sync-bootstrap-http
sync-outbox-http
sync-pending-http
sync-refresh-http
```

Use this function body for all five:

```js
return (async () => {
  try {
    const result = await osiCloudHttp.requestJsonIpv4({
      method: msg.method || 'GET',
      url: msg.url,
      headers: msg.headers || {},
      payload: msg.payload,
      timeoutMs: Number(env.get('OSI_CLOUD_REST_TIMEOUT_MS') || 30000) || 30000
    });
    msg.statusCode = result.statusCode;
    msg.headers = result.headers || {};
    msg.payload = result.payload;
    msg._cloudRestIpv4 = result.diagnostics;
    return msg;
  } catch (error) {
    msg.statusCode = 0;
    msg.headers = {};
    msg.error = {
      message: String(error.message || error),
      code: error.code || null,
      cloudRestIpv4: error.cloudRestIpv4 || null
    };
    msg.payload = {
      error: 'Cloud REST IPv4 request failed',
      detail: String(error.message || error),
      code: error.code || null
    };
    return msg;
  }
})();
```

Each replacement node must include:

```json
"outputs": 1,
"noerr": 0,
"initialize": "",
"finalize": "",
"libs": [
  {
    "var": "osiCloudHttp",
    "module": "osi-cloud-http"
  }
]
```

Keep names specific:

```text
POST /auth/local-sync IPv4
POST Bootstrap to Cloud IPv4
POST Edge Events to Cloud IPv4
GET Pending Commands IPv4
POST Refresh Sync Token IPv4
```

- [ ] **Step 3: Update `Run Force Sync` imports**

In the `Run Force Sync` function node, add this library entry:

```json
{
  "var": "osiCloudHttp",
  "module": "osi-cloud-http"
}
```

Remove the now-unneeded `httpLib`, `httpsLib`, and `urlLib` imports only after the function body no longer references them.

- [ ] **Step 4: Replace `Run Force Sync` custom request helper**

Inside the `Run Force Sync` function body, replace its local `requestJson` implementation with:

```js
async function requestJson(method, targetUrl, headers, payload) {
  return osiCloudHttp.requestJsonIpv4({
    method,
    url: targetUrl,
    headers: headers || {},
    payload,
    timeoutMs: Number(env.get('OSI_CLOUD_REST_TIMEOUT_MS') || 30000) || 30000
  });
}
```

This keeps the rest of `Run Force Sync` readable while ensuring manual sync, bootstrap, outbox delivery, token refresh, and pending-command polling all use the same IPv4-only transport.

- [ ] **Step 5: Run the flow verifier**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: cloud REST node type/import/helper assertions pass. Strict acknowledgment assertions from Task 3 may still fail.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-sync-flow.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "fix: send cloud sync rest over ipv4"
```

## Task 3: Harden Edge Response Handling

**Files:**
- Modify `scripts/verify-sync-flow.js`
- Modify `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Test `node scripts/verify-sync-flow.js`

- [ ] **Step 1: Add failing strict-ack checks**

In `scripts/verify-sync-flow.js`, add:

```js
expectIncludes('Mark Bootstrap Synced', 'const statusCode = Number(msg.statusCode || 0);', 'requires an explicit bootstrap HTTP status');
expectIncludes('Mark Bootstrap Synced', "payload.success === false", 'rejects bootstrap responses that explicitly report failure');
expectExcludes('Mark Bootstrap Synced', 'if (msg.statusCode && (msg.statusCode < 200 || msg.statusCode >= 300))', 'truthy-only bootstrap status guard');

expectIncludes('Mark Synced Events Delivered', 'const statusCode = Number(msg.statusCode || 0);', 'requires an explicit outbox HTTP status');
expectIncludes('Mark Synced Events Delivered', 'acceptedOutboxEventIds', 'marks only accepted outbox event UUIDs');
expectIncludes('Mark Synced Events Delivered', 'failedEvents', 'records partial event failures without dropping failed rows');
expectExcludes('Mark Synced Events Delivered', 'if (msg.statusCode && (msg.statusCode < 200 || msg.statusCode >= 300))', 'truthy-only outbox status guard');
expectExcludes('Mark Synced Events Delivered', 'UPDATE sync_outbox SET delivered_at = \'" + now + "\' WHERE event_uuid IN', 'string-concatenated delivered_at update');

expectIncludes('Store Refreshed Sync Token', 'const statusCode = Number(msg.statusCode || 0);', 'requires an explicit refresh HTTP status');
expectIncludes('Store Refreshed Sync Token', 'if (!nextSyncToken)', 'requires a token before storing refresh success');
expectExcludes('Store Refreshed Sync Token', 'if (msg.statusCode && (msg.statusCode < 200 || msg.statusCode >= 300))', 'truthy-only refresh status guard');

expectIncludes('Run Force Sync', 'acceptedOutboxEventIds', 'uses accepted event UUIDs for manual outbox marking');
expectIncludes('Run Force Sync', 'failedEvents', 'reports partial outbox failures during manual force sync');
```

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: failures for missing strict status handling and accepted-event marking.

- [ ] **Step 2: Harden `Mark Bootstrap Synced`**

At the top of `Mark Bootstrap Synced`, replace the truthy-only status guard with:

```js
const statusCode = Number(msg.statusCode || 0);
const payload = msg.payload || {};
if (!statusCode || statusCode < 200 || statusCode >= 300 || payload.success === false) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'bootstrap',
      message: String(payload.message || payload.error || payload.detail || 'Bootstrap sync failed'),
      statusCode: statusCode || null
    }
  });
  return null;
}
```

Keep the existing token rotation and gateway migration handling below this guard.

- [ ] **Step 3: Replace `Mark Synced Events Delivered`**

Replace the full function body for `Mark Synced Events Delivered` with:

```js
return (async()=>{
function setSyncState(patch) {
  const current = flow.get('sync_state') || {};
  flow.set('sync_state', Object.assign({}, current, patch));
}
function responseMessage(payload, fallback) {
  return String((payload || {}).message || (payload || {}).error || (payload || {}).detail || fallback);
}
function uniqueList(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
function acceptedOutboxEventIds(payload, requestedIds) {
  const requested = new Set(uniqueList(requestedIds));
  const detailed = uniqueList([]
    .concat(Array.isArray(payload && payload.appliedEventUuids) ? payload.appliedEventUuids : [])
    .concat(Array.isArray(payload && payload.duplicateEventUuids) ? payload.duplicateEventUuids : []))
    .filter((eventUuid) => requested.has(eventUuid));
  if (detailed.length) return detailed;
  const applied = Number((payload || {}).applied || 0);
  const skipped = Number((payload || {}).skipped || 0);
  const failedEvents = Array.isArray(payload && payload.failedEvents) ? payload.failedEvents : [];
  if (failedEvents.length) return [];
  if (applied === requested.size && skipped === 0) return Array.from(requested);
  return [];
}

const statusCode = Number(msg.statusCode || 0);
const payload = msg.payload || {};
const requestedIds = uniqueList(msg._syncEventIds);
if (!statusCode || statusCode < 200 || statusCode >= 300 || payload.success === false) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'outbox',
      message: responseMessage(payload, 'Outbox delivery failed'),
      statusCode: statusCode || null
    }
  });
  return null;
}
if (!requestedIds.length) return null;

const acceptedIds = acceptedOutboxEventIds(payload, requestedIds);
const failedEvents = Array.isArray(payload.failedEvents) ? payload.failedEvents : [];
if (!acceptedIds.length && requestedIds.length) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'outbox',
      message: failedEvents.length ? 'Cloud rejected all outbox events in this batch' : 'Cloud response did not acknowledge delivered outbox events',
      statusCode
    }
  });
  return null;
}

const _db = new osiDb.Database('/data/db/farming.db');
const run = (sql, params = []) => new Promise((res,rej) => _db.run(sql, params, e => e?rej(e):res()));
const close = () => new Promise(res => _db.close(() => res()));
try {
  const now = new Date().toISOString();
  const placeholders = acceptedIds.map(() => '?').join(',');
  await run("UPDATE sync_outbox SET delivered_at = ? WHERE event_uuid IN (" + placeholders + ")", [now].concat(acceptedIds));
  const currentState = flow.get('sync_state') || {};
  const patch = {
    lastOutboxDeliverySuccessAt: now,
    lastOutboxBatchCount: acceptedIds.length,
    updatedAt: now
  };
  if (failedEvents.length) {
    patch.lastError = {
      at: now,
      source: 'outbox',
      message: 'Cloud reported ' + failedEvents.length + ' failed outbox event(s)',
      statusCode,
      failedEvents: failedEvents.slice(0, 5)
    };
  } else if (currentState.lastError && currentState.lastError.source === 'outbox') {
    patch.lastError = null;
  }
  setSyncState(patch);
  await close();
  return null;
} catch (e) {
  try { await close(); } catch(_) {}
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'outbox',
      message: String(e.message || e),
      statusCode: null
    }
  });
  node.warn('Sync outbox mark failed: ' + e.message);
  return null;
}
})();
```

- [ ] **Step 4: Harden `Store Refreshed Sync Token`**

In `Store Refreshed Sync Token`, use this guard before writing the token:

```js
const statusCode = Number(msg.statusCode || 0);
const payload = msg.payload || {};
if (!statusCode || statusCode < 200 || statusCode >= 300 || payload.success === false) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'sync-token-refresh',
      message: String(payload.message || payload.error || payload.detail || 'Sync token refresh failed'),
      statusCode: statusCode || null
    }
  });
  return null;
}
const nextSyncToken = String(payload.token || '').trim();
if (!nextSyncToken) {
  setSyncState({
    lastError: {
      at: new Date().toISOString(),
      source: 'sync-token-refresh',
      message: 'Sync token refresh response did not include a token',
      statusCode
    }
  });
  return null;
}
```

Keep the existing DB update after `nextSyncToken` is defined.

- [ ] **Step 5: Harden `Run Force Sync` outbox marking**

Inside `Run Force Sync`, add the same helper logic from `Mark Synced Events Delivered`:

```js
function uniqueList(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
function acceptedOutboxEventIds(payload, requestedIds) {
  const requested = new Set(uniqueList(requestedIds));
  const detailed = uniqueList([]
    .concat(Array.isArray(payload && payload.appliedEventUuids) ? payload.appliedEventUuids : [])
    .concat(Array.isArray(payload && payload.duplicateEventUuids) ? payload.duplicateEventUuids : []))
    .filter((eventUuid) => requested.has(eventUuid));
  if (detailed.length) return detailed;
  const applied = Number((payload || {}).applied || 0);
  const skipped = Number((payload || {}).skipped || 0);
  const failedEvents = Array.isArray(payload && payload.failedEvents) ? payload.failedEvents : [];
  if (failedEvents.length) return [];
  if (applied === requested.size && skipped === 0) return Array.from(requested);
  return [];
}
```

Then replace the manual-sync outbox success block:

```js
if (outboxRes.statusCode >= 200 && outboxRes.statusCode < 300) {
  const ids = outboxRows.map((r) => "'" + escapeSql(r.event_uuid) + "'").join(',');
  const now = new Date().toISOString();
  await run("UPDATE sync_outbox SET delivered_at = ? WHERE event_uuid IN (" + ids + ")", [now]);
  ...
}
```

with:

```js
if (outboxRes.statusCode >= 200 && outboxRes.statusCode < 300 && (outboxRes.payload || {}).success !== false) {
  const acceptedIds = acceptedOutboxEventIds(outboxRes.payload || {}, outboxRows.map((r) => r.event_uuid));
  const failedEvents = Array.isArray((outboxRes.payload || {}).failedEvents) ? (outboxRes.payload || {}).failedEvents : [];
  if (!acceptedIds.length && outboxRows.length) {
    summary.outbox.succeeded = false;
    summary.outbox.error = failedEvents.length ? 'Cloud rejected all outbox events in this batch' : 'Cloud response did not acknowledge delivered outbox events';
    summary.outbox.afterCount = summary.outbox.beforeCount;
    recordFailure('outbox', summary.outbox.error, outboxRes.statusCode);
  } else {
    const placeholders = acceptedIds.map(() => '?').join(',');
    const now = new Date().toISOString();
    await run("UPDATE sync_outbox SET delivered_at = ? WHERE event_uuid IN (" + placeholders + ")", [now].concat(acceptedIds));
    const afterRows = await q("SELECT COUNT(*) AS pending_count FROM sync_outbox WHERE delivered_at IS NULL");
    summary.outbox.succeeded = failedEvents.length === 0;
    summary.outbox.deliveredCount = acceptedIds.length;
    summary.outbox.afterCount = Number((afterRows[0] || {}).pending_count || 0);
    summary.outbox.applied = Number((outboxRes.payload || {}).applied || 0);
    summary.outbox.skipped = Number((outboxRes.payload || {}).skipped || 0);
    summary.outbox.failedEvents = failedEvents;
    if (failedEvents.length) {
      summary.outbox.error = 'Cloud reported ' + failedEvents.length + ' failed outbox event(s)';
      recordFailure('outbox', summary.outbox.error, outboxRes.statusCode);
    } else {
      setSyncState({ lastOutboxDeliverySuccessAt: now, lastOutboxBatchCount: acceptedIds.length, updatedAt: now });
    }
  }
} else {
```

- [ ] **Step 6: Run verifier**

Run:

```bash
node scripts/verify-sync-flow.js
```

Expected: strict status and accepted-event checks pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-sync-flow.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
git commit -m "fix: require explicit sync acknowledgements"
```

## Task 4: Add Server Event Outcome Metadata

**Files:**
- Modify `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- Modify `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncController.java`
- Modify `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/sync/EdgeSyncServiceDataPlaneTest.java`
- Modify `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java`
- Test Gradle sync tests

- [ ] **Step 1: Add failing service tests**

In `EdgeSyncServiceDataPlaneTest.java`, add:

```java
@Test
void applyEvents_reportsAppliedDuplicateAndFailedEventUuids() {
    when(inboxRepository.existsById("evt-applied")).thenReturn(false);
    when(inboxRepository.existsById("evt-duplicate")).thenReturn(true);
    when(deviceRepository.findByDeviceEui("DEV-1")).thenReturn(Optional.empty());

    EdgeSyncService.SyncApplyResult result = edgeSyncService.applyEvents(new EdgeSyncService.EdgeEventBatchRequest(
            "edge-1",
            "GW-1",
            List.of(
                    new EdgeSyncService.SyncEventRecord(
                            "evt-applied",
                            "DEVICE",
                            "DEV-1",
                            "DEVICE_FLAGS_UPDATED",
                            1L,
                            "2026-05-02T10:00:00Z",
                            Map.of("device_eui", "DEV-1", "name", "Device 1")
                    ),
                    new EdgeSyncService.SyncEventRecord(
                            "evt-duplicate",
                            "DEVICE",
                            "DEV-1",
                            "DEVICE_FLAGS_UPDATED",
                            1L,
                            "2026-05-02T10:01:00Z",
                            Map.of("device_eui", "DEV-1")
                    ),
                    new EdgeSyncService.SyncEventRecord(
                            "",
                            "DEVICE",
                            "DEV-2",
                            "DEVICE_FLAGS_UPDATED",
                            1L,
                            "2026-05-02T10:02:00Z",
                            Map.of("device_eui", "DEV-2")
                    )
            )
    ));

    assertThat(result.applied()).isEqualTo(1);
    assertThat(result.skipped()).isEqualTo(2);
    assertThat(result.appliedEventUuids()).containsExactly("evt-applied");
    assertThat(result.duplicateEventUuids()).containsExactly("evt-duplicate");
    assertThat(result.failedEvents()).hasSize(1);
    assertThat(result.failedEvents().get(0).message()).contains("eventUuid is required");
}
```

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest
```

Expected: compilation fails because `appliedEventUuids`, `duplicateEventUuids`, and `failedEvents` do not exist yet.

- [ ] **Step 2: Add outcome fields to the service result**

In `EdgeSyncService.java`, add `java.util.ArrayList` to imports if needed:

```java
import java.util.ArrayList;
```

Replace the `SyncApplyResult` record with:

```java
public record SyncApplyResult(
        int applied,
        int skipped,
        GatewayMigrationSummary gatewayMigration,
        List<String> appliedEventUuids,
        List<String> duplicateEventUuids,
        List<SyncEventFailure> failedEvents) {

    public SyncApplyResult {
        gatewayMigration = gatewayMigration != null ? gatewayMigration : GatewayMigrationSummary.none(null);
        appliedEventUuids = appliedEventUuids != null ? List.copyOf(appliedEventUuids) : List.of();
        duplicateEventUuids = duplicateEventUuids != null ? List.copyOf(duplicateEventUuids) : List.of();
        failedEvents = failedEvents != null ? List.copyOf(failedEvents) : List.of();
    }

    public SyncApplyResult(int applied, int skipped, GatewayMigrationSummary gatewayMigration) {
        this(applied, skipped, gatewayMigration, List.of(), List.of(), List.of());
    }
}

public record SyncEventFailure(
        String eventUuid,
        String aggregateType,
        String aggregateKey,
        String op,
        String message) {
}
```

- [ ] **Step 3: Populate event outcomes in `applyEvents`**

In `applyEvents`, initialize lists before the loop:

```java
List<String> appliedEventUuids = new ArrayList<>();
List<String> duplicateEventUuids = new ArrayList<>();
List<SyncEventFailure> failedEvents = new ArrayList<>();
```

Replace the missing UUID branch:

```java
if (event.eventUuid() == null || event.eventUuid().isBlank()) {
    skipped++;
    continue;
}
```

with:

```java
if (event.eventUuid() == null || event.eventUuid().isBlank()) {
    skipped++;
    failedEvents.add(new SyncEventFailure(
            event.eventUuid(),
            event.aggregateType(),
            event.aggregateKey(),
            event.op(),
            "eventUuid is required"));
    continue;
}
```

Replace the duplicate branch:

```java
if (inboxRepository.existsById(event.eventUuid())) {
    skipped++;
    continue;
}
```

with:

```java
if (inboxRepository.existsById(event.eventUuid())) {
    skipped++;
    duplicateEventUuids.add(event.eventUuid());
    continue;
}
```

After a successful inbox save, add:

```java
appliedEventUuids.add(event.eventUuid());
```

Inside the `catch`, add failure metadata:

```java
failedEvents.add(new SyncEventFailure(
        event.eventUuid(),
        event.aggregateType(),
        event.aggregateKey(),
        event.op(),
        e.getMessage()));
```

Change the return statement to:

```java
return new SyncApplyResult(
        applied,
        skipped,
        GatewayMigrationSummary.none(normalizeGatewayDeviceEui(request.gatewayDeviceEui())),
        appliedEventUuids,
        duplicateEventUuids,
        failedEvents);
```

- [ ] **Step 4: Add controller response metadata**

In `EdgeSyncController.java`, replace the `Map.of(...)` response in `applyEvents` with a `LinkedHashMap` so null/empty lists are explicit and ordering is readable:

```java
Map<String, Object> body = new java.util.LinkedHashMap<>();
body.put("success", true);
body.put("applied", result.applied());
body.put("skipped", result.skipped());
body.put("appliedEventUuids", result.appliedEventUuids());
body.put("duplicateEventUuids", result.duplicateEventUuids());
body.put("failedEvents", result.failedEvents());
body.put("partialFailure", !result.failedEvents().isEmpty());
return ResponseEntity.ok(body);
```

Keep `success` as `true` for a processed batch. Partial per-event failures are represented by `partialFailure` and `failedEvents`; transport/auth failures still use non-2xx responses.

- [ ] **Step 5: Add controller test coverage**

In `EdgeSyncControllerTest.java`, add a test that mocks an authorized sync token and verifies the event response body includes `appliedEventUuids`, `duplicateEventUuids`, `failedEvents`, and `partialFailure`.

Use this return value in the mock:

```java
new EdgeSyncService.SyncApplyResult(
        1,
        2,
        EdgeSyncService.GatewayMigrationSummary.none("GW-1234"),
        List.of("evt-applied"),
        List.of("evt-duplicate"),
        List.of(new EdgeSyncService.SyncEventFailure("evt-failed", "DEVICE", "DEV-1", "DEVICE_FLAGS_UPDATED", "boom"))
)
```

Expected assertions:

```java
assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
assertThat(response.getBody()).containsEntry("appliedEventUuids", List.of("evt-applied"));
assertThat(response.getBody()).containsEntry("duplicateEventUuids", List.of("evt-duplicate"));
assertThat(response.getBody()).containsEntry("partialFailure", true);
@SuppressWarnings("unchecked")
List<EdgeSyncService.SyncEventFailure> failedEvents =
        (List<EdgeSyncService.SyncEventFailure>) response.getBody().get("failedEvents");
assertThat(failedEvents).hasSize(1);
```

- [ ] **Step 6: Run server tests**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest
./gradlew test --tests org.osi.server.sync.EdgeSyncControllerTest
```

Expected: both test classes pass.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server
git add backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
  backend/src/main/java/org/osi/server/sync/EdgeSyncController.java \
  backend/src/test/java/org/osi/server/sync/EdgeSyncServiceDataPlaneTest.java \
  backend/src/test/java/org/osi/server/sync/EdgeSyncControllerTest.java
git commit -m "fix: report edge sync event outcomes"
```

## Task 5: Full Local Verification

**Files:**
- Verify `osi-os`
- Verify `osi-server`

- [ ] **Step 1: Run OSI OS sync and communication checks**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
node scripts/verify-communication-contract.js
scripts/check-mqtt-topics.sh
```

Expected:

```text
OK ...
```

and each command exits `0`.

- [ ] **Step 2: Run focused server sync tests**

Run:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceControlPlaneTest
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceStatusTest
./gradlew test --tests org.osi.server.sync.EdgeSyncControllerTest
```

Expected: all selected Gradle tests pass.

- [ ] **Step 3: Inspect changed files**

Run:

```bash
cd /home/phil/Repos/osi-os
git status --short
git diff --check
cd /home/phil/Repos/osi-server
git status --short
git diff --check
```

Expected: only planned files are changed before commit, and `git diff --check` prints no whitespace errors.

## Task 6: Deploy Order

**Files:**
- No new source files; operational rollout.

- [ ] **Step 1: Deploy server event-outcome response first**

Deploy the `osi-server` backend change before the Pi flow change so the edge can receive `appliedEventUuids`, `duplicateEventUuids`, and `failedEvents` during replay.

Use the existing small-VPS-safe pattern from `AGENTS.md`:

```bash
cd /home/rocky/docker/osi-server/docker
docker compose build backend
docker compose up -d --no-deps backend
docker compose logs --tail=100 backend
```

Expected: backend starts cleanly and `/api/v1/sync/edge/events` still returns `success`, `applied`, and `skipped`, plus the new event outcome arrays.

- [ ] **Step 2: Back up the Uganda Pi before rollout**

On the Pi:

```bash
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/data/db/backups/osi-os-$TS"
mkdir -p "$BACKUP_DIR/db"
cp -a /data/db/farming.db "$BACKUP_DIR/db/" 2>/dev/null || true
cp -a /data/db/farming.db-wal "$BACKUP_DIR/db/" 2>/dev/null || true
cp -a /data/db/farming.db-shm "$BACKUP_DIR/db/" 2>/dev/null || true
cp -a /data/db/farming.db-journal "$BACKUP_DIR/db/" 2>/dev/null || true
cp -a /srv/node-red "$BACKUP_DIR/node-red"
cp -a /usr/lib/node-red/gui "$BACKUP_DIR/gui" 2>/dev/null || true
cp -a /etc/init.d/node-red "$BACKUP_DIR/node-red.init" 2>/dev/null || true
cp -a /srv/node-red/flows.json "$BACKUP_DIR/flows.json"
```

Expected: backup directory exists and contains `farming.db`, sidecars if present, and Node-RED files.

- [ ] **Step 3: Deploy the edge flow/helper patch**

Use the project’s established Pi rollout path for Node-RED flow/helper updates. The rollout must include:

```text
/srv/node-red/flows.json
/usr/share/node-red/osi-cloud-http/index.js
/usr/share/node-red/osi-cloud-http/package.json
/usr/share/node-red/package.json
/usr/share/node-red/package-lock.json
```

Then restart Node-RED:

```bash
/etc/init.d/node-red restart
sleep 10
logread | tail -n 100
```

Expected: Node-RED restarts without function import errors for `osi-cloud-http`.

- [ ] **Step 4: Verify IPv4 sync on the Pi before replay**

On the Pi, run a direct helper test against the cloud pending-commands endpoint using the existing sync token:

```bash
TOKEN="$(sqlite3 /data/db/farming.db "SELECT server_sync_token FROM users WHERE server_sync_token IS NOT NULL AND server_sync_token <> '' ORDER BY server_linked_at DESC, id DESC LIMIT 1")"
export TOKEN
node - <<'NODE'
const { requestJsonIpv4 } = require('/usr/share/node-red/osi-cloud-http');
const token = process.env.TOKEN;
requestJsonIpv4({
  method: 'GET',
  url: 'https://server.opensmartirrigation.org/api/v1/sync/gateways/0016C001F151B1D6/pending-commands',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  timeoutMs: 30000
}).then((res) => {
  console.log(JSON.stringify({ statusCode: res.statusCode, payloadType: Array.isArray(res.payload) ? 'array' : typeof res.payload, count: Array.isArray(res.payload) ? res.payload.length : null }));
  process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
```

Expected:

```json
{"statusCode":200,"payloadType":"array","count":0}
```

## Task 7: Recover The Uganda False-Delivered Outbox Rows

**Files:**
- Live Pi database only, after backup.
- Live server database read-only query for comparison.

- [ ] **Step 1: Export cloud inbox event UUIDs for the Uganda gateway**

On the server:

```bash
docker exec -i osi-postgres psql -U osiserver -d osiserver -Atc \
  "COPY (SELECT event_uuid FROM sync_inbox WHERE source_node = '0016C001F151B1D6') TO STDOUT" \
  > /tmp/uganda-cloud-inbox-event-uuids.txt
```

Copy the exported UUID list to the Pi:

```bash
scp /tmp/uganda-cloud-inbox-event-uuids.txt root@100.69.51.98:/tmp/uganda-cloud-inbox-event-uuids.txt
```

- [ ] **Step 2: Reset only delivered rows missing from cloud inbox**

On the Pi:

```bash
test -s /tmp/uganda-cloud-inbox-event-uuids.txt
sqlite3 /data/db/farming.db <<'SQL'
CREATE TEMP TABLE cloud_inbox_event_uuids(event_uuid TEXT PRIMARY KEY);
.mode tabs
.import /tmp/uganda-cloud-inbox-event-uuids.txt cloud_inbox_event_uuids

SELECT COUNT(*) AS rows_to_replay
FROM sync_outbox o
LEFT JOIN cloud_inbox_event_uuids i ON i.event_uuid = o.event_uuid
WHERE o.gateway_device_eui = '0016C001F151B1D6'
  AND o.delivered_at IS NOT NULL
  AND i.event_uuid IS NULL;

UPDATE sync_outbox
SET delivered_at = NULL
WHERE gateway_device_eui = '0016C001F151B1D6'
  AND delivered_at IS NOT NULL
  AND event_uuid NOT IN (SELECT event_uuid FROM cloud_inbox_event_uuids);
SQL
```

Expected: `rows_to_replay` is close to the previously observed false-delivered count, and the update completes without locking errors.

- [ ] **Step 3: Trigger a manual sync**

From a machine that can reach the Pi GUI API:

```bash
PI_LOCAL_USERNAME="${PI_LOCAL_USERNAME:?set PI_LOCAL_USERNAME to a local GUI username}"
PI_LOCAL_PASSWORD="${PI_LOCAL_PASSWORD:?set PI_LOCAL_PASSWORD to the local GUI password}"
LOCAL_TOKEN="$(
  curl -sS -X POST http://100.69.51.98:1880/auth/login \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$PI_LOCAL_USERNAME\",\"password\":\"$PI_LOCAL_PASSWORD\"}" |
  node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const p=JSON.parse(d);const t=p.token||p.accessToken||'';if(!t)process.exit(1);process.stdout.write(t);})"
)"
curl -sS -X POST http://100.69.51.98:1880/api/sync/force \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $LOCAL_TOKEN" \
  -d '{}'
```

Expected payload:

```json
{
  "success": true,
  "outbox": {
    "attempted": true,
    "succeeded": true,
    "deliveredCount": 100
  },
  "pendingCommands": {
    "succeeded": true
  }
}
```

If more than 100 rows remain, repeat manual sync or wait for the 30-second scheduler until `pending_count` reaches `0`.

- [ ] **Step 4: Confirm cloud state catches up**

On the Pi:

```bash
sqlite3 /data/db/farming.db "SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL;"
```

Expected: `0` or only genuinely new rows created after the sync began.

On the server:

```bash
docker exec -i osi-postgres psql -U osiserver -d osiserver -c \
  "SELECT MAX(processed_at) FROM sync_inbox WHERE source_node = '0016C001F151B1D6';"
docker exec -i osi-postgres psql -U osiserver -d osiserver -c \
  "SELECT device_eui, MAX(recorded_at) FROM sensor_data WHERE device_eui IN ('AC1F09FFFE128C11','AC1F09FFFE128C12','AC1F09FFFE128C13','AC1F09FFFE128C14') GROUP BY device_eui ORDER BY device_eui;"
```

Expected: `sync_inbox.MAX(processed_at)` is current, and sensor timestamps reflect May 2, 2026 or newer readings from the Pi.

- [ ] **Step 5: Confirm the cloud API no longer shows all devices offline**

Log in as `Kaweza` on the cloud or call the cloud devices API. Expected: Uganda Kiwi/valve devices show recent `lastSeen` / observed timestamps and online state according to the cloud’s normal freshness window.

## Task 8: Final Verification And Closeout

**Files:**
- `osi-os` git state
- `osi-server` git state

- [ ] **Step 1: Confirm no private credentials remain in files**

Run:

```bash
cd /home/phil/Repos/osi-os
rg -n "opensmartirrigation|BEGIN RSA PRIVATE KEY|kaweza@123|0016C001F151B1D6" .
cd /home/phil/Repos/osi-server
rg -n "opensmartirrigation|BEGIN RSA PRIVATE KEY|kaweza@123" .
```

Expected: no private key or SSH password appears in tracked files. The gateway EUI may appear only in notes or plan files if intentionally documented.

- [ ] **Step 2: Run final verification**

Run:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
node scripts/verify-communication-contract.js
scripts/check-mqtt-topics.sh

cd /home/phil/Repos/osi-server/backend
./gradlew test --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest
./gradlew test --tests org.osi.server.sync.EdgeSyncControllerTest
```

Expected: all commands pass.

- [ ] **Step 3: Record the operational result**

Update `AGENTS.md` only if the IPv4 helper and strict outbox acknowledgment become durable repo-level facts after rollout. Suggested factual note:

```md
- OSI cloud REST calls from Node-RED use the `osi-cloud-http` helper with `family: 4`; do not replace these with generic HTTP request nodes unless Node-RED supports explicit address-family control.
- `sync_outbox.delivered_at` must only be set for event UUIDs explicitly accepted by `/api/v1/sync/edge/events`.
```

- [ ] **Step 4: Commit final documentation, if changed**

```bash
cd /home/phil/Repos/osi-os
git add AGENTS.md docs/superpowers/plans/2026-05-02-ipv4-cloud-sync.md
git commit -m "docs: plan ipv4 cloud sync recovery"
```

Skip this commit if `AGENTS.md` is unchanged and the plan file was already committed separately.

## Rollback Plan

If the edge rollout fails to start Node-RED, restore the backup made in Task 6:

```bash
/etc/init.d/node-red stop
BACKUP_DIR="$(ls -dt /data/db/backups/osi-os-* | head -n 1)"
test -n "$BACKUP_DIR"
cp -a "$BACKUP_DIR/node-red/flows.json" /srv/node-red/flows.json
/etc/init.d/node-red start
```

Do not restore `/data/db/farming.db` unless the database itself was damaged. The sync replay update is reversible before rows are delivered by setting `delivered_at` back to the backup values, but after successful replay the cloud is expected to contain those events and the edge should keep the new delivered markers.

## Success Criteria

- Node helper request to `server.opensmartirrigation.org` succeeds from the Pi over IPv4.
- Manual sync no longer reports `AggregateError` from pending commands.
- Missing or failed HTTP responses never mark `sync_outbox` rows delivered.
- Server event responses identify applied, duplicate, and failed event UUIDs.
- Uganda false-delivered rows absent from cloud `sync_inbox` are replayed.
- Cloud devices for the Uganda gateway show fresh telemetry instead of all offline.
