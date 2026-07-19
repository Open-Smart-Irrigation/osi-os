---
name: osi-flows-json-editing
description: Use when editing conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json or its bcm2709 mirror, adding/modifying a Node-RED function node, HTTP endpoint, inject, or MQTT IN node, changing REST routes or the scheduler/sync orchestration logic that lives in flows.json, wiring a new npm module or shared helper into a function node, or touching the edge backend in general.
---

# OSI Flows.json Editing

## Overview

`flows.json` is the Node-RED flow definition that IS the edge backend for OSI OS:
REST API routes, the scheduler, sync orchestration, and sensor ingest are all
nodes in this one JSON array. The maintained copies are formatted as
`JSON.stringify(flows, null, 2) + '\n'`, but node counts and byte counts drift as
features land. Re-measure them in the current branch before citing them. The
canonical copy at
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` must be
mirrored byte-for-byte into
`conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`.

This skill covers the mechanics of making a safe, wiring-correct edit to that
file — not deploying it, diagnosing a live symptom, schema/migration changes,
sensor semantics, or env-var/flag semantics (see "When NOT to use").

## When to use / When NOT to use

Use this skill when you are about to:
- Add, remove, or modify a node in either `flows.json` copy (function, http in/out,
  inject, mqtt in/out, link in/out, etc.).
- Add a new REST endpoint or scheduler tick.
- Wire a new npm module or shared helper (`osi-db-helper`, `osi-cloud-http`,
  `osi-chameleon-helper`, `osi-dendro-helper`) into a function node.
- Change existing wiring (a node's `wires` array) between nodes.

Do NOT use this skill, and instead go to the named sibling, when you are:
- Diagnosing a live symptom (hanging endpoint, 404 flood, silent crash on a
  running Pi) — go to `osi-debugging-playbook` first; come back here once you
  know which node to change.
- Deploying an edited `flows.json` to a live or demo Pi — go to
  `osi-live-ops-runbook`.
- Changing SQLite schema, adding a migration, or touching the frozen boot-DDL
  node (`sync-init-fn` / "Sync Init Schema + Triggers") for schema behavior —
  go to `osi-schema-change-control`. That skill owns the FROZEN boot-DDL policy
  in full; this skill only tells you not to add schema DDL there.
- Deciding what a sensor field means, which device type owns which reading, or
  irrigation/agronomy semantics — go to `osi-agronomy-sensors-reference`.
- Looking up what an env var or `env.get(...)` flag controls — go to
  `osi-config-and-flags`.

## The iron rule

**`flows.json` is edited by a one-shot Node script, never by hand, never by
string patching, never by a text-replacement tool.** The file is machine-formatted
JSON; a manual edit that looks harmless (wrong quote style, wrong indentation,
reordered keys) silently breaks the byte-identical profile-parity check or,
worse, produces JSON Node-RED still parses but with subtly wrong structure.

Canonical procedure, every time:

1. Write a throwaway Node script in your scratchpad (never in the repo).
2. `JSON.parse` the current file.
3. Mutate the in-memory node array (push new nodes, edit `wires`, edit `func`,
   etc.).
4. `fs.writeFileSync(path, JSON.stringify(flows, null, 2) + '\n')`.
5. Do this for **both** `conf/full_raspberrypi_bcm27xx_bcm2712/.../flows.json`
   (canonical) and `conf/full_raspberrypi_bcm27xx_bcm2709/.../flows.json`
   (mirror) — either by running the mutation twice or by mutating the
   canonical file then `cp`-ing it over the mirror.

**Before any mutation**, verify the no-op roundtrip is byte-identical: read the
file, `JSON.parse` it, `JSON.stringify(parsed, null, 2) + '\n'`, and
`Buffer.compare` against the original bytes. If they are not identical, STOP —
either the file's real formatting has drifted from this assumption, or your
script has a serialization bug (e.g. wrong indent width, missing trailing
newline, a `Map`/`Set` in the mutation that doesn't round-trip). Do not
proceed with a real mutation until the no-op case is proven byte-identical.

Expected roundtrip-check output shape after you rerun it in the current branch:

```
$ node roundtrip-check.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
byte-identical: true   (<current bytes> / <current bytes>)

$ node roundtrip-check.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json
byte-identical: true   (<current bytes> / <current bytes>)
```

Do not reuse old byte counts as proof. Fresh output from the branch you are
editing is the evidence.

## Complete script skeleton

Save this in your scratchpad (e.g. `flows-edit.js`), read it fully, adapt the
`MUTATE` section, then run it with plain `node`. It includes the mandatory
roundtrip guard and writes both profile copies.

```js
#!/usr/bin/env node
// One-shot flows.json editor skeleton. Run from the repo root.
// Usage: node flows-edit.js
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd(); // run from repo root; verify with `pwd` first
const CANONICAL = path.join(
  REPO_ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);
const MIRROR = path.join(
  REPO_ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'
);

function serialize(flows) {
  return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');
}

function assertRoundtripByteIdentical(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  const reserialized = serialize(parsed);
  if (Buffer.compare(original, reserialized) !== 0) {
    throw new Error(
      `Roundtrip guard failed for ${filePath}: file formatting has drifted ` +
      `from JSON.stringify(x, null, 2) + '\\n'. STOP and investigate before mutating.`
    );
  }
  return parsed;
}

// --- Step 1: guard, then load canonical ---
const flows = assertRoundtripByteIdentical(CANONICAL);
console.log('Roundtrip guard OK. Node count:', flows.length);

// --- Step 2: MUTATE (edit this section for your change) ---
// Example: add a new, fully self-contained inject + function node pair.
// Mint a NEW id — never reuse or regenerate an existing id. Real ids in this
// file are either a 16-lowercase-hex-char Node-RED-generated id (e.g.
// "062a0f9bf66d9789", the Build Heartbeat node) or a short descriptive slug
// (e.g. "auth-db-query"). Prefer the hex form for new nodes to avoid clashes;
// generate one with: node -e "console.log(require('crypto').randomBytes(8).toString('hex'))"
const NEW_FUNCTION_ID = 'REPLACE_WITH_FRESH_16_HEX_ID';
const NEW_INJECT_ID = 'REPLACE_WITH_ANOTHER_FRESH_16_HEX_ID';

const exampleFunctionNode = {
  id: NEW_FUNCTION_ID,
  type: 'function',
  z: 'REPLACE_WITH_TARGET_TAB_ID', // copy z from a neighboring node in the same tab
  name: 'Example Sampler',
  func: [
    "let value = null;",
    "try {",
    "  const fs = global.get('fs');", // functionGlobalContext local, NOT an npm module — no libs entry needed
    "  value = parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim());",
    "} catch (e) {",
    "  node.warn('Example Sampler read failed: ' + (e && e.message ? e.message : e));",
    "}",
    "msg.payload = { value };",
    "return msg;",
  ].join('\n'),
  outputs: 1,
  // libs only needed for real npm modules bound via settings.js functionExternalModules,
  // e.g. [{ var: 'osiDb', module: 'osi-db-helper' }] — see "Function-node conventions" below.
  // In-repo seam modules: bind osiLib and call osiLib.require('<name>') — see "In-repo seam modules" below.
  libs: [],
  x: 400,
  y: 400,
  wires: [[]],
};

const exampleInjectNode = {
  id: NEW_INJECT_ID,
  type: 'inject',
  z: 'REPLACE_WITH_TARGET_TAB_ID',
  name: 'Example Tick (60s)',
  props: [{ p: 'payload' }],
  repeat: '60',
  crontab: '',
  once: true,
  onceDelay: 5,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 180,
  y: 400,
  wires: [[NEW_FUNCTION_ID]],
};

flows.push(exampleInjectNode, exampleFunctionNode);

// --- Step 3: write canonical, then mirror ---
fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
console.log('Wrote canonical + mirror. New node count:', flows.length);

// --- Step 4: re-run the roundtrip guard on what you just wrote ---
assertRoundtripByteIdentical(CANONICAL);
assertRoundtripByteIdentical(MIRROR);
console.log('Post-write roundtrip guard OK on both profiles.');
```

After running this, always run the full pre-commit checklist (below) before
considering the edit done.

## Function-node conventions (verified against real nodes in this repo)

### npm modules: bind via `libs`, not `functionExternalModules` alone

`feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` sets
`functionExternalModules: true`. That flag only permits a function node's
`libs` array to bind an npm module into scope — **it does not auto-inject
anything.** If a function node's code references a module-backed variable
(e.g. `osiDb`, `bcrypt`) without a matching `libs` entry, that variable is
`undefined` at runtime. Because most of these handlers are `async`, the
failure is a silent hang: no HTTP response, `curl` exits 52 or 28, nothing is
logged.

Real working precedent — node `auth-db-query` ("Lookup Auth User"):

```json
"libs": [{ "var": "osiDb", "module": "osi-db-helper" }]
```

and its `func` opens with `const db = new osiDb.Database('/data/db/farming.db');`.
Verify any node's `libs` binding with:

```bash
node -e "
const flows = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const n = flows.find(x => x.id === 'auth-db-query');
console.log(JSON.stringify(n.libs));
"
```

### In-repo seam modules: bind `osiLib`, load with `osiLib.require()`

`osi-lib` (repo source
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js`,
deployed at `/srv/node-red/osi-lib`) is the single-choke-point loader for
extracted in-repo seam modules (refactor-program item 1.A1). Rather than
binding a helper module directly, a function node binds the loader itself
via `libs`:

```json
"libs": [{ "var": "osiLib", "module": "osi-lib" }]
```

and then calls `osiLib.require('<name>')` at the point of use. Real
precedent, node `dendro-compute-fn` ("Daily Dendrometer Analytics"):

```js
const _daLoad = osiLib.require('dendro-analytics');
if (!_daLoad.ok) {
  node.error('Daily Dendro Analytics: analytics module unavailable: ' + _daLoad.error, msg);
  return null;
}
const DA = _daLoad.value;
// A failed load is quarantined for 30s (OSI_LIB_COOLDOWN_MS): a retry within
// that window fails fast with `quarantined: true` instead of re-attempting a
// doomed require() on every tick.
```

`osiLib.require(name)` never throws. It always returns either
`{ ok: true, value }` or `{ ok: false, error, quarantined? }` — check `.ok`
before touching `.value`, and on `ok: false` call `node.error(...)` and
return, exactly as above.

Registered names live in the `NAME_TO_PATH` map in `osi-lib/index.js`
(examples: `'history-sync'` → `osi-history-sync-helper`, `'dendro-analytics'`
→ `osi-dendro-analytics`, `'device-writer'` → `osi-device-writer`). A new
helper module needs three-surface registration — registry entry, loader
test, and `deploy.sh` coverage — enforced by
`node scripts/verify-helper-registration.js`; run it after registering any
new module and before wiring a function node to it.

- Legacy direct `libs` bindings of specific helpers (`osiDb` via
  `osi-db-helper`, `osiCloudHttp`, `chameleon`, `dendro`) are widespread
  precedent (~137 nodes) and stay valid in nodes that already use them.
- New in-repo module access goes through `osiLib.require` instead (rule #15
  in the sibling skill `osi-common-pitfalls`); a bare `require()` of anything
  but a Node builtin in a function node fails
  `node scripts/flows-bare-require-scan.js`.

### Guarded shared-module locals: `global.get(...)`, not `libs`

A second, different pattern exists for the small set of built-in Node.js
modules that `settings.js` pre-loads into `functionGlobalContext`:

```js
// feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js
functionGlobalContext: {
    os: require('os'),
    fs: require('fs'),
    cp: require('child_process'),
},
```

Function nodes that need `fs`, `os`, or `cp` bind them with
`global.get('fs')` / `global.get('os')` / `global.get('cp')` at the top of the
function — **not** via `libs`, because these are context globals, not
`functionExternalModules`-loaded npm packages. Real precedent, node
`sys-stats-fn` ("System Stats"):

```js
var os = global.get('os');
var fs = global.get('fs');
```

Do not add `fs`/`os`/`cp` to a node's `libs` array — that binding mechanism is
for npm modules declared in `settings.js`'s external-modules allowlist, and
mixing the two patterns on the same variable is confusing and redundant.

### Every opened DB handle must be closed

Any function node that does `new osiDb.Database(...)` must also call
`.close(` somewhere in the same function body. This is enforced by
`scripts/test-flows-wiring.js`, in the "WS2/WS3 osiDb.Database close audit"
section: it scans every `function` node whose `func` matches
`/new\s+osiDb\.Database/` and fails if that same `func` does not also match
`/\.close\s*\(/`. On failure it prints:

```
FAIL: N function node(s) open osiDb.Database without closing it:
  - <node name> [<node id>]
```

Real precedent for the close call, node `write-strega-expectation`:

```js
const __close = () => new Promise((res) => db.close(() => res()));
```

The same script also has a separate "function-node library declaration audit"
that fails if a node's `func` references `osiDb.`, `osiCloudHttp.`,
`chameleon.`, or `dendro.` without a matching `libs` entry — this is the
automated form of the npm-module rule above.

### Function nodes must never crash the flow

Wrap every sysfs/file/subprocess read in its own `try/catch` that resolves to
`null` for that one reading — a sampler failing to read one sysfs path must
never take down the rest of the function or the flow. Adapted from node
`062a0f9bf66d9789` ("Build Heartbeat", part of the frozen heartbeat cluster —
read it for isolation shape, but do not copy legacy empty catches):

```js
var cpuTemp = null, memPercent = null, load1 = null, load5 = null, load15 = null, fanValue = null;

try {
  cpuTemp = Math.round(parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim()) / 100) / 10;
} catch (e) {
  node.warn('Build Heartbeat cpu temp read failed: ' + (e && e.message ? e.message : e));
}
try {
  var tm = os.totalmem(), fm = os.freemem();
  memPercent = Math.round(((tm - fm) / tm) * 100);
} catch (e) {
  node.warn('Build Heartbeat memory read failed: ' + (e && e.message ? e.message : e));
}
```

**The let-before-try scoping trap:** a `const` (or `let`) declared *inside* a
`try { }` block is block-scoped and invisible outside that block. If later
code (including code in the same function, after the `catch`) references that
name, you get a `ReferenceError` — and in an `async` handler with no outer
catch, that error can be silent: no response sent, nothing logged, the flow
just stops producing output for that path. This has previously killed a
nightly compute job (a `const` inside a weather-API `try` block was
referenced later in an INSERT). The fix pattern:

```js
let zoneTimezone = 'UTC';       // safe default, declared OUTSIDE try
let phenoMod = null;
try {
  zoneTimezone = await lookupTimezone(zoneId);   // assignment, not declaration
  phenoMod = await lookupPhenoMod(zoneId);
} catch (e) {
  node.warn('zone metadata lookup failed: ' + (e && e.message ? e.message : e));
  // zoneTimezone/phenoMod keep their safe defaults; nothing downstream breaks.
}
// zoneTimezone and phenoMod are both safely usable here
```

Always declare-with-default before the `try`, assign inside it, and never
`const`/`let` a name inside `try{}` that anything outside the block needs.

### Empty catches are ratcheted

The repo allows legacy empty catches only as an existing baseline. When you
touch a function node, convert empty `catch(_){}` / `catch(e){}` /
`catch {}` blocks in that node to a visible warning such as:

```js
catch (e) {
  node.warn('node/context: ' + (e && e.message ? e.message : e));
}
```

Run `node scripts/verify-no-new-silent-catch.js` before committing. It ratchets
maintained flow nodes, so a newly-added or worsened silent catch is a real
failure even when the flow still imports.

### Authenticated HTTP endpoints

For a gated HTTP endpoint, copy the auth block verbatim from the newest shipped
endpoint with the same auth mode, then diff your block against that precedent.
Do not retype timing-safe HMAC checks, expiry checks, or token parsing from
memory.

Every code path must send exactly one HTTP response: success, validation
failure, auth failure, not-found, and exception paths all terminate in one
`http response` node or one response send. A route that sometimes returns no
response is a silent hang; a route that sends twice becomes a Node-RED runtime
error.

For auth-gated routes, a no-token `401` is healthy proof that the route exists
and is protected. Treat `404` as broken wiring/path and `500` as a handler bug.

### No ad hoc DDL in flows.json

Schema DDL belongs in ordered migrations and sanctioned deploy/boot repair
paths, not new flow-node strings. `node scripts/verify-no-stray-ddl.js` is a
git-anchored count ratchet over the maintained `flows.json` copies and
`deploy.sh`; adding a new `CREATE TABLE`, `ALTER TABLE`, trigger, index, or
similar marker in `flows.json` trips that guard against `origin/main`.

If a flow edit appears to need DDL, stop and route through
`osi-schema-change-control` instead of burying schema changes in a function node.

### Stable node ids

Never regenerate or reuse an existing node's `id` — every `wires` array in
every other node references ids directly, so changing one breaks wiring
silently (Node-RED will not error; the edge from the old id just stops
being a target). Real ids observed in this file take one of two forms:
16-lowercase-hex-character Node-RED-generated ids (e.g. `062a0f9bf66d9789`,
`c2b43a6c6e7d2c11`) or short descriptive slugs (e.g. `auth-db-query`,
`sync-init-fn`, `write-strega-expectation`). Re-measure the current distribution
if you need exact counts for a report.
For a new node, mint a fresh 16-hex id
(`node -e "console.log(require('crypto').randomBytes(8).toString('hex'))"`)
or a new, clearly-unique descriptive slug if you are extending a named
subsystem — but never copy an id from an existing node "to be safe."

### Placement: additive over teeing

Prefer a self-contained new inject + new function node (own timer, own
handler) over adding a new output/wire into an existing shared node. Two
independent additive changes land in either order with at most an adjacency
conflict in the JSON array; two changes that both tee into the same shared
node collide on the `wires` array itself.

Two clusters are explicitly hot/frozen and need a blast-radius check before
any touch:
- The **heartbeat cluster** (`Build Heartbeat` / `062a0f9bf66d9789` and its
  MQTT wiring) — read for precedent, do not modify without checking who else
  reads/writes it.
- The **`sync-init-fn`** boot-DDL node ("Sync Init Schema + Triggers") — fully
  FROZEN for new schema behavior. Policy and the narrow sanctioned exception
  (guarded `devices` rebuild) live in `osi-schema-change-control`; this skill
  only tells you to route there.

Before editing any shared node, run a blast-radius grep:

```bash
node -e "
const flows = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const targetId = 'PUT_TARGET_NODE_ID_HERE';
for (const n of flows) {
  const wires = JSON.stringify(n.wires || []);
  if (wires.includes(targetId)) console.log('wired FROM:', n.id, n.name);
  if (n.id === targetId) console.log('target node:', n.id, n.name, n.type);
}
"
```

## Guard tests: `scripts/test-flows-wiring.js`

Run with plain `node scripts/test-flows-wiring.js` (not `node --test` — the
file is a plain script with hand-rolled assertions, not a `node:test` suite).
It pins these wiring and function-node contracts against the canonical
(bcm2712) `flows.json` only:

1. **STREGA actuation wiring** (labelled WS1, tags C5/H2/L1/M8) — exact
   `wires` arrays for specific node ids (e.g. `5974306566e99a92` must wire to
   exactly `072f29aa8760340a` and `write-strega-expectation`, and not directly
   to Build STREGA downlink), a required string
   (`STALE_OPEN_OBSERVED`) inside `strega-reconciliation-monitor`'s `func`,
   an absence check (must NOT contain `flow.get('command_types') || {}`), and
   node-existence checks for the today-liters HTTP trio.
2. **Field request intake + status apply wiring** — required HTTP routes,
   router `osiDb` binding/close behavior, contact-email persistence, pending
   command split output count, and status ACK queue wiring.
3. **Settings module gates** — bulk schedule-disable endpoint existence, bearer
   auth, scoped schedule update, response shape, and no valve/downlink mutation.
4. **`osiDb.Database` close audit** (WS2/WS3) — described above.
5. **Function-node `libs` declaration audit** — described above.
6. **Misc WS2/WS3 wiring invariants** — a handful of `node.id === '...'` checks
   for specific required substrings in specific nodes (gateway migration
   preflight's parameterized `q`/`run` helpers, `sync-force-build`'s timeout
   guard, `command-ack-build-batch`'s bootstrap gate, `s2120-zones-put-auth-fn`'s
   zone-id validation).

On failure it prints one `FAIL: N flow wiring regression(s):` line followed by
a bulleted list, then `process.exit(1)`; on success, it prints `OK` lines for
the asserted groups plus a final `PASS: STREGA wiring + osiDb close + WS2/WS3
wiring guards all passed`.

**When you intend a wiring change that this file pins, update the pin in the
same commit, with a commit message explaining why the wiring changed.** A
guard test that silently gets "fixed" to match new behavior stops being a
guard.

## Profile parity

`bcm2712` is canonical; `bcm2709` must mirror it byte-for-byte. Either write
your edit script to update both paths (as in the skeleton above) or mutate
the canonical file then `cp` it over the mirror — do not hand-edit the
mirror separately, and do not let the two diverge even by a trailing newline.

Enforced by `node scripts/verify-profile-parity.js`, which is chained from
`node scripts/verify-sync-flow.js` (it runs as the final step, via
`spawnSync`). Output shape:

```
=== conf/full_raspberrypi_bcm27xx_bcm2709 ===
OK:   files/etc/board.d/02_network
... (25 OK: / absent: lines total — 20 file-parity checks incl. flows.json, 5 absence checks)

All parity checks passed.
```

On a mismatch it instead prints `FAIL: files/usr/share/flows.json: content
differs between conf/full_raspberrypi_bcm27xx_bcm2712 and
conf/full_raspberrypi_bcm27xx_bcm2709` and exits non-zero.

## MQTT IN topic rule

Every `mqtt in` node in `flows.json` must subscribe to the literal topic
`application/+/device/+/event/up`. Confirmed by inspecting all 7 `mqtt in`
nodes in the canonical file (`Local Device Uplinks`, `MQTT IN (Field Testing)`,
`Local Sensor Uplinks`, `LSN50 IN`, `S2120 IN`, `LoRain IN`, `UC512 IN`) —
all 7 use exactly that topic string. ChirpStack generates a fresh
per-installation application UUID at bootstrap; a topic hardcoded to one
gateway's UUID (e.g. `application/<uuid>/device/+/event/up`) will silently
never match on any other gateway — no error, just zero uplinks. Device-type
discrimination happens downstream of the MQTT IN node via
`CHIRPSTACK_PROFILE_*` env vars and `deviceProfileName` fallback matching
(semantics documented in `osi-config-and-flags`, not here).

Enforced by `scripts/check-mqtt-topics.sh`, which checks all three flow
copies (bcm2712, bcm2709, and a legacy bcm2708 path) for both a UUID-shaped
regex in any MQTT IN topic and an exact-string match against the expected
topic. Expected output shape:

```
OK: conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
```
exit 0.

## Pre-commit checklist

Run every row before committing a `flows.json` change. All commands below run
from the repo root.

| Check | Command | Pass signal |
|---|---|---|
| Roundtrip byte-check ran on both profiles (before AND after your mutation) | your scratchpad roundtrip script | `byte-identical: true` for both `.../bcm2712/.../flows.json` and `.../bcm2709/.../flows.json` |
| Both profile copies updated | `git status --short` shows both `flows.json` paths changed together | both paths listed, never just one |
| Profile parity | `node scripts/verify-profile-parity.js` | ends `All parity checks passed.`, exit 0 |
| Sync flow verification (chains schema/history/parity checks) | `node scripts/verify-sync-flow.js` | prints `Sync flow verification passed` at the end of its own section, then chains profile parity; a healthy full run ends `All parity checks passed.`, exit 0 |
| MQTT topic compliance | `scripts/check-mqtt-topics.sh` | three `OK:` lines, one per flow copy, exit 0 |
| Flow wiring guards | `node scripts/test-flows-wiring.js` | ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`, exit 0 |
| Silent catch ratchet | `node scripts/verify-no-new-silent-catch.js` | exit 0; no new or worsened empty catches in maintained flow nodes |
| Stray DDL ratchet | `node scripts/verify-no-stray-ddl.js` | exit 0; no unreviewed DDL-marker count increase in flows/deploy surfaces |
| Flows size ratchet | `node scripts/verify-flows-size-ratchet.js` | exit 0; no node grew, no new node exceeds 4 KB, total embedded JS did not increase |
| Bare require scan | `node scripts/flows-bare-require-scan.js` | exit 0; no function node uses bare `require()` instead of `osiLib.require()` |
| Function-node parse | `node scripts/verify-flows-fn-parse.js` | ends `verify-flows-fn-parse: OK`, exit 0 — required for any function-node edit |
| Helper registration (only when adding or moving a helper/seam module) | `node scripts/verify-helper-registration.js` | exit 0; registry, loader test, and deploy.sh coverage all match |

If you intentionally changed a pinned wiring contract, update
`scripts/test-flows-wiring.js` in the same commit and say why in the commit
message — do not just make the test pass by weakening the assertion.

This checklist is the mechanical gate only. Non-trivial flows.json changes
still go through the engineering-playbook loop (`docs/engineering-playbook.md`
§2: written plan, adversarial review, independent verification by a
non-author) — §8 defines done, not a green checklist.

## Common mistakes

- Editing `flows.json` with a text editor or an Edit-tool string replacement.
  Even a single reformatted line can break the byte-identical parity check or
  subtly corrupt adjacent JSON.
- Forgetting the bcm2709 mirror. `verify-profile-parity.js` will catch this,
  but it is cheaper to write both copies in the same script than to discover
  the CI failure later.
- Adding an npm-module-backed variable to a function node without a matching
  `libs` entry — the node "works" in that Node-RED loads it without error,
  but any code path through the undefined variable hangs silently.
- Confusing the `libs` binding (npm modules) with the `global.get(...)`
  binding (built-ins pre-loaded into `functionGlobalContext`: `fs`, `os`,
  `cp`). Adding `fs` to `libs` is not wrong per se but is not how any existing
  node does it, and the "helper globals" audit in `test-flows-wiring.js` only
  checks the npm-module list (`osiDb`, `osiCloudHttp`, `chameleon`, `dendro`) —
  it will not catch a missing `global.get('fs')`.
- Declaring a variable with `const`/`let` inside a `try{}` block, then
  referencing it after the block. Silent `ReferenceError`, no log line, no
  crash report — the symptom is just "this stopped updating."
- Reusing or "tidying up" an existing node id. Every reference lives in some
  other node's `wires` array; renaming breaks those edges without any error.
- Teeing a new feature into an existing shared node (especially the
  heartbeat cluster or `sync-init-fn`) instead of adding an own inject + own
  function node.
- Trusting `functionExternalModules: true` alone to make a module available.
  It only enables the *mechanism*; each node still needs its own `libs` entry.
- Binding a brand-new in-repo helper directly via `libs` (or bare
  `require()`) instead of registering it in osi-lib's `NAME_TO_PATH` and
  loading it with `osiLib.require` — the bare form fails
  `flows-bare-require-scan.js` and an unregistered module fails
  `verify-helper-registration.js`.
- Adding schema DDL inside `sync-init-fn` because "it's just one more ADD
  COLUMN" — that node is frozen; see `osi-schema-change-control`.
- Adding or leaving an empty catch in a touched function node. The
  `verify-no-new-silent-catch.js` ratchet exists because swallowed errors made
  flow failures look like missing data or HTTP hangs.
- Retyping auth boilerplate for a new HTTP endpoint instead of copying and
  diffing the newest shipped gated endpoint.
- Treating a no-token `401` on a gated endpoint as a failure. It is the healthy
  protected-route signal; `404`/`500` are the route/handler failures.
- Adding DDL-like SQL to `flows.json` and assuming schema verifiers cover it.
  `verify-no-stray-ddl.js` is the guard that catches ad hoc DDL in flow/deploy
  surfaces.

## Provenance and maintenance

Re-verify these before trusting them again, especially after any large flows.json refactor:

- Node count / byte size of canonical `flows.json`: `node -e "const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'); console.log(f.length)"` and `wc -c conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`.
- Roundtrip byte-identity claim: re-run a roundtrip script like the one in "The iron rule" against both profile copies.
- `libs` binding precedent (`auth-db-query`): `node -e "const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'); console.log(JSON.stringify(f.find(n=>n.id==='auth-db-query').libs))"`.
- `global.get` precedent (`sys-stats-fn`, `062a0f9bf66d9789`): same pattern, swap the id, inspect `.func`.
- `functionGlobalContext` keys: `grep -n -A5 "functionGlobalContext" feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`.
- MQTT IN topic compliance: `bash scripts/check-mqtt-topics.sh`.
- Wiring guard behavior and pass/fail text: `node scripts/test-flows-wiring.js`.
- Silent-catch ratchet behavior: `node scripts/verify-no-new-silent-catch.js`.
- Stray-DDL ratchet behavior: `node scripts/verify-no-stray-ddl.js`.
- Profile parity behavior and pass/fail text: `node scripts/verify-profile-parity.js`.
- Full chained verifier and current baseline health: `node scripts/verify-sync-flow.js`.
- Node id format distribution (16-hex vs slug counts): re-run the id-length-distribution one-liner from this skill's authoring session, or `node -e "const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'); const ids=f.filter(n=>n.id).map(n=>n.id); console.log(ids.filter(i=>/^[0-9a-f]{16}$/.test(i)).length,'/',ids.length)"`.
