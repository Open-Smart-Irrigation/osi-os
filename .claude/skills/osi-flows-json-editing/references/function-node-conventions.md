# Function-node conventions

Part of the osi-flows-json-editing skill; read SKILL.md first.

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
