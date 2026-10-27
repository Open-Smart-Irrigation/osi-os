# Common mistakes and maintenance

Part of the osi-flows-json-editing skill; read SKILL.md first.

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
