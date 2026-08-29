# SDI-12 recipe deployment implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Compile and explicitly deploy a Dragino acquisition recipe from any valid one-to-ten-module Sentek EnviroSCAN/TriSCAN layout, observe compatibility from real uplinks, and expose honest deployment and identification state without hardcoded probe addresses.

**Architecture:** A pure `osi-sdi12-recipe` module validates layouts and compiles exact FPort 2 frames. A database-backed `osi-sdi12-commissioning` module owns layout saves, apply/rollback state transitions, ChirpStack queue observation, and telemetry compatibility observation. Node-RED remains a thin authenticated transport and ingest adapter. Two additive local-only tables hold deployment and address-discovery state. React shows saved, queued, observed, active, and degraded states while preserving prior readings.

**Tech stack:** CommonJS Node helpers, Node-RED function nodes, ChirpStack v4 gRPC/protobuf, SQLite ordered migrations, React/TypeScript, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-29-sdi12-recipe-deployment-design.md` — read first.

## Global constraints

- Work in `/home/phil/Repos/osi-os-agrolink` on branch `AgroLink`. Preserve all unrelated modified and untracked files, especially `node_modules/`.
- Address is data. It must come from a validated saved layout or a validated one-character discovery response. No runtime path may default to `0`, `L`, `C`, or another address.
- Support every EnviroSCAN/TriSCAN type mask for module counts 1 through 10: 2,046 layouts in total. VWC is present for every module; VIC is present only for TriSCAN modules and follows TriSCAN response-position order.
- Stable channel IDs remain independent of response positions. Wire compilation uses response positions, never depth or channel ID.
- Keep normal reporting at 1,200 seconds and switched 12 V at 8,000 ms. Do not introduce continuous power or a shortened commissioning interval.
- Apply and rollback use unconfirmed ChirpStack downlinks on FPort 2. Never flush, reorder, or overwrite a pre-existing queue item.
- Null means missing; numeric zero is a valid measurement. Deployment failures never delete or replace prior finite readings.
- New deployment state is edge-local. Do not add it to edge/cloud sync schemas or touch `osi-server`.
- Migration `0049` is additive. Do not alter the frozen boot DDL, rebuild `devices`, replace a live database, or restamp fingerprints.
- `bcm2712` is canonical. Mirror all maintained runtime payloads byte-for-byte to `bcm2709`; do not add runtime modules to `bcm2708`.
- Edit `flows.json` once with a checked-in, one-shot Node transformation. Before mutation, require `JSON.stringify(parsed, null, 2) + '\n'` to equal the source bytes. After mutation, require the same round-trip and copy the canonical bytes to the maintained mirror. Do not patch flow JSON textually.
- Load non-builtin helpers in function nodes only through declared `osiLib.require(...)`. Register every new helper in runtime package metadata, `osi-lib`, image seeding, `deploy.sh`, and registration tests.
- Bind all SQL values. The browser cannot supply command strings, data cuts, recipe JSON, queue IDs, FPort, or raw frame bytes.
- When touching an existing function node, replace any empty `catch` in that node with a bounded `node.warn` or `node.error`. Update flow-size ratchet allowances with exact reviewed ceilings.
- Write a failing test before each behavior change, run it to confirm the intended failure, implement the minimum change, then rerun it green. Commit at each task boundary.

## Baseline evidence

- [x] `osi-sdi12-normalize/index.test.js`: 27 tests passed on the dirty starting tree.
- [x] `osi-chirpstack-helper/index.test.js`: 52 tests passed on the dirty starting tree.
- [x] `scripts/test-sdi12-registration.js`: 13 tests passed on the dirty starting tree.
- [x] The two maintained `flows.json` files are byte-identical and use two-space JSON plus a final newline. A compact-stringify comparison fails by design; the required invariant is `JSON.stringify(parsed, null, 2) + '\n'`.

---

### Task 1: Add durable local commissioning schema

**Files:**

- Create: `database/migrations/ordered/0049__sdi12_recipe_deployments.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json`
- Modify: `database/seed-blank.sql`
- Modify: `scripts/verify-db-schema-consistency.js`
- Create: `scripts/test-sdi12-recipe-schema.js`
- Modify through the migration workflow:
  - `conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
  - `conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db`
  - `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db`
  - `database/farming.db`
  - `web/react-gui/farming.db`

**Schema contract:**

- `sdi12_recipe_deployments` has the exact columns and status CHECK from the design, including `compatible_layout_json`.
- `sdi12_identify_attempts` has stages `discovering` and `identifying` only.
- Both `deveui` keys reference `devices(deveui) ON DELETE CASCADE`.
- Add `idx_sdi12_recipe_deployments_status` on `status` for the 60-second poller.
- Mark the migration `-- risk: additive` and add only its raw SHA-256 to `CHECKSUMS.json`.

- [ ] Write `scripts/test-sdi12-recipe-schema.js` against a temporary database created from `database/seed-blank.sql`. Assert both tables, every column, both CHECK constraints, cascade deletion, and the status index.
- [ ] Add the expected schema to `scripts/verify-db-schema-consistency.js`. Run `node scripts/test-sdi12-recipe-schema.js`; confirm it fails because the seed and migration are absent.
- [ ] Write `0049`, update the seed with the same objects, and calculate the checksum from the raw migration bytes. Do not change an older checksum.
- [ ] Apply the migration to all seven committed databases using the repository migration workflow. Do not copy one database over another.
- [ ] Run:

  ```bash
  node scripts/test-sdi12-recipe-schema.js
  node scripts/verify-migrations.js
  node scripts/verify-seed-replay.js
  node scripts/verify-db-schema-consistency.js
  node scripts/verify-runtime-schema-parity.js
  ```

  Expected: all commands exit 0; migration 0049 is recognized as additive; all seven database schemas match the seed.
- [ ] Commit only Task 1 files: `feat(sdi12): add recipe deployment state`.

### Task 2: Build the exhaustive pure recipe compiler

**Canonical files:**

- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/package.json`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js`
- Mirror the directory under `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/`.
- Modify both maintained `osi-lib/index.js` and `osi-lib/index.test.js`.
- Modify both maintained Node-RED `package.json` and `package-lock.json` files.
- Modify both maintained `files/etc/uci-defaults/98_osi_node_red_seed` files.
- Modify: `deploy.sh`
- Modify: `scripts/verify-helper-registration.js`
- Modify: `scripts/verify-helper-registration.test.js`

**Public interface:**

```js
compileSentekRecipe(layout)
canonicalLayoutHash(layout)
encodeIdentifyFrame(command)
```

`compileSentekRecipe` returns the exact success/error shapes from the design. `encodeIdentifyFrame` accepts only `?!` or `<validated-address>I!` and returns the complete Dragino `0xA8` bytes; it rejects all other ASCII.

- [ ] Add failing tests for canonicalization: input object key order does not change the SHA-256; channel order is normalized by response position; invalid layouts return bounded `invalid_layout` errors from the existing `validateSentekLayout()` gate.
- [ ] Add a generated test over every type mask for lengths 1 through 10. Alternate valid addresses across cases, use channel IDs that differ from response positions, and assert:
  - one VWC output per module;
  - one VIC output per TriSCAN module;
  - VWC slots precede VIC slots;
  - no emitted command contains a depth or stable channel ID;
  - no emitted address differs from the layout address;
  - no recipe uses more than eight command/cut slots.
- [ ] Add boundary tests for 3, 4, 6, 7, 9, and 10 values in both VWC and VIC families. Assert `M!`/`D1!`/`D2!`, `M1!`, `M2!`/`D1!`/`D2!`, and `M3!` selection and the `3 + 9*k` cut formula.
- [ ] Add an exact fixture for address `0`, response positions 1–8, and TriSCAN at positions 1 and 5. Assert the four commands and cuts from the spec, the eight-VWC/two-VIC shape, the complete ordered frame list, and exact AF bytes including:

  ```text
  AF010109304D212C312C312C3200
  AF02010A304431212C302C302C3200
  ```

- [ ] Add exact tests for the global frames `07031F40`, `AB01`, `AE02`, `AD01`, `A90D09`, tail clear `09 <first-unused> 0F`, and final `010004B0`.
- [ ] Assert every active slot receives both its command and cut frame before the single unused-tail clear; the compiler must not clear an active slot or emit a broad queue/converter reset.
- [ ] Add exact identify encoder tests for `?!`, `0I!`, `CI!`, and invalid/multi-character inputs. Assert echo is enabled, automatic D0 is disabled, delay is one second, and the frame itself does not choose FPort.
- [ ] Run the new test and confirm failure because the module does not exist. Implement the compiler by calling the existing normalizer validator; do not duplicate layout validation.
- [ ] Register aliases in `osi-lib`: `sdi12-recipe -> osi-sdi12-recipe`. Add the runtime dependency, lockfile entry, seed-loop name, and `deploy.sh` package/index downloads. Extend the registration verifier so omission from any surface fails.
- [ ] Mirror canonical files, then run:

  ```bash
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
  node scripts/verify-helper-registration.js
  node scripts/verify-profile-parity.js
  ```

  Expected: all 2,046 generated layouts and exact-byte fixtures pass; registration and profile parity exit 0.
- [ ] Commit Task 2: `feat(sdi12): compile Sentek acquisition recipes`.

### Task 3: Extend ChirpStack queue access without queue mutation shortcuts

**Files:**

- Modify both maintained `osi-chirpstack-helper/index.js` files.
- Modify both maintained `osi-chirpstack-helper/index.test.js` files.
- Modify both maintained `osi-lib/index.js` and `osi-lib/index.test.js` files to register `chirpstack -> osi-chirpstack-helper`.

**New client methods:**

```js
enqueueDeviceDownlink({ devEui, fPort, confirmed, data }) -> Promise<{ id }>
listDeviceQueue(devEui) -> Promise<Array<{ id, devEui, fPort, confirmed, data }>>
```

- [ ] Add failing request-shape tests using the generated protobuf classes. For enqueue, assert `DeviceQueueItem` carries normalized DevEUI, FPort 2, `confirmed=false`, and exact bytes; assert the returned queue ID comes from `response.getId()`.
- [ ] Add failing queue-list tests for `GetDeviceQueueItemsRequest`, `setDevEui`, `setCountOnly(false)`, `getResultList()`, and `getData_asU8()` conversion.
- [ ] Add rejection tests for invalid EUI, FPort outside 1–255, non-boolean confirmation, empty/non-buffer data, missing queue ID, and gRPC errors. Error messages must be bounded and must not include payload bytes or credentials.
- [ ] Implement only enqueue and list. Keep `flushDeviceQueue()` unchanged and never call it from the new workflow.
- [ ] Run:

  ```bash
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
  node scripts/verify-profile-parity.js
  ```

  Expected: exact protobuf shape tests pass and maintained helper files are identical.
- [ ] Commit Task 3: `feat(chirpstack): expose safe device queue operations`.

### Task 4: Implement the durable commissioning state machine

**Canonical files:**

- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/package.json`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js`
- Mirror the directory under the maintained `bcm2709` profile.
- Modify both maintained `osi-lib/index.js` and `osi-lib/index.test.js` files.
- Modify both maintained Node-RED `package.json` and `package-lock.json` files.
- Modify both maintained `files/etc/uci-defaults/98_osi_node_red_seed` files.
- Modify: `deploy.sh`
- Modify: `scripts/verify-helper-registration.js`
- Modify: `scripts/verify-helper-registration.test.js`

**Public interface:**

```js
saveSentekLayout(db, { deveui, profileId, layout, depths })
applyDesiredRecipe(db, client, deveui, { now })
rollbackCompatibleRecipe(db, client, deveui, { now })
pollDeployments(db, client, { now })
observeAcquisition(db, {
  deveui, profileId, layout, normalization, outcome, observedAt
})
projectDeployment(row)
```

- [ ] Add failing save tests proving one transaction updates `devices`, stores canonical layout/depth JSON, clears legacy count, increments `sync_version`, compiles `desired_recipe_json`, increments `desired_version`, resets observation fields, preserves the compatible recipe/layout pair, and deletes a stale identify attempt. Assert `queueing` and `queued` return 409 without changing either table.
- [ ] Add failing apply tests for missing/malformed layouts, wrong profile/type, empty and non-empty ChirpStack queues, two concurrent apply attempts, exact sequential FPort 2 unconfirmed enqueue, all returned queue IDs, a twelve-hour deadline, and 202 projection. Assert no queue flush call exists.
- [ ] Add partial-enqueue tests. When zero frames were accepted, restore `not_applied` with a bounded error. When one or more IDs were accepted, retain them and mark `degraded`; a same-version retry remains allowed because frames are idempotent.
- [ ] Add rollback tests proving the stored compatible layout and recipe match each other before mutation. On success, restore canonical layout/depths and create a new desired version before enqueue. On preflight rejection before any accepted frame, restore the complete pre-rollback device/deployment pair. On partial enqueue, retain the compatible layout as desired and mark `degraded`.
- [ ] Add poll tests using stored queue IDs rather than assuming an empty whole-device queue. Assert drain time is set only after all stored IDs disappear, IDs queued past the twelve-hour deadline become `degraded/queue_delivery_timeout`, a `queueing` claim with no IDs past its deadline becomes `degraded/queueing_interrupted`, and unrelated later queue items do not block drain observation.
- [ ] Add observation tests. Observation starts only after drain; requires profile `SENTEK_ENVIROSCAN`, matching canonical layout hash, exact finite VWC/VIC cardinality, no no-response, no quarantine, and a successful telemetry write. First success becomes `observed_once`; second consecutive success becomes `observed_compatible` and copies both desired recipe and current canonical layout to the compatible pair. Any failed acquisition resets the consecutive count; three failures become degraded. Prior telemetry is untouched.
- [ ] Add `projectDeployment` tests that expose only desired version/hash, status, timestamps, frame count, compatible availability, and bounded error code. Assert recipe JSON and queue IDs never appear.
- [ ] Implement transactions with bound values and compare-and-set predicates. Accept the database and ChirpStack client as dependencies; do not open `/data/db/farming.db` inside the helper. Require the sibling compiler internally.
- [ ] Register `sdi12-commissioning -> osi-sdi12-commissioning`, update every delivery surface, mirror canonical files, and run:

  ```bash
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js
  node scripts/verify-helper-registration.js
  node scripts/verify-profile-parity.js
  ```

  Expected: state, compensation, queue, timeout, and observation tests pass; registration is complete.
- [ ] Commit Task 4: `feat(sdi12): add durable commissioning state machine`.

### Task 5: Wire API, queue poller, address-aware Identify, and acquisition observation in one flow edit

**Files:**

- Create: `scripts/patch-sdi12-recipe-deployment.js`
- Create: `scripts/test-sdi12-recipe-flow.js`
- Modify once through the patch script: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror bytes to: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `scripts/test-sdi12-registration.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Existing nodes to transform:**

- `scoped-device-config-guard`
- `sdi12-config-auth-fn`
- `sdi12-config-action-fn`
- `sdi12-identify-action-fn`
- `sdi12-identify-trigger-fn`
- `sdi12-identify-fn`
- `sdi12-config-query-fn` and its SQLite query
- `sdi12-write-fn`
- `get-devices-query`
- `merge-device-data`

**New HTTP nodes and routes:**

- `POST /api/devices/:deveui/sdi12/recipe/apply`
- `POST /api/devices/:deveui/sdi12/recipe/rollback`

Add both routes after the existing SDI-12 config route in `scoped-device-config-guard`; increase its outputs from 26 to 28, with the final output still reserved for errors. Route both through the existing scoped/authenticated SDI-12 guard. Expand `sdi12-config-auth-fn` to four outputs: save, apply, rollback, and error.

- [ ] First extend `scripts/test-sdi12-recipe-flow.js` and `scripts/test-sdi12-registration.js` so they fail for missing routes, wrong output counts/wires, missing 60-second poller, helper aliases/libs, hardcoded `0I!`, missing deployment projection, unbound SQL, recipe leakage, and absent observation calls.
- [ ] Add function-harness tests for authorization and EUI scoping. Wrong device type returns 409; unknown/inaccessible device does not enqueue; empty request bodies are accepted only for Apply/Rollback; errors use stable HTTP 400/401/403/404/409/500 mappings.
- [ ] Change Sentek layout save in `sdi12-config-action-fn` to call `saveSentekLayout`. Preserve the existing legacy/non-Sentek path. Return explicit text/state that the layout is saved but not applied.
- [ ] Add thin Apply/Rollback action nodes. They open the edge DB, construct the existing ChirpStack client from configured runtime credentials, call the commissioning helper, close resources in `finally`, and return HTTP 202 or the helper's bounded error. FPort and frames come only from the compiler/helper.
- [ ] Add a 60-second inject plus thin poll function. It calls `pollDeployments`; an error produces a visible warning and cannot block ingest or other flows.
- [ ] Extend the SDI-12 writer config query with the deployment fields needed for observation. After successful normalization and storage, call `observeAcquisition` best-effort with the exact result/write outcome. For no-response, incomplete reassembly, quarantine, cardinality failure, or writer failure, report the failed outcome without inventing data. An observation-state write error warns but does not reject valid telemetry.
- [ ] Make Identify address-aware:
  - valid saved layout: record `identifying`, compile `<address>I!`;
  - absent layout: record `discovering`, compile `?!`;
  - malformed layout: return 409 without a downlink;
  - discovery response: accept exactly one alphanumeric address, persist it, move to `identifying`, and enqueue `<address>I!`;
  - identity response: run existing profile matching and retain the latest attempt for GUI address projection;
  - new Identify replaces the prior attempt; manual layout save removes it.
- [ ] Keep Identify on the existing Dragino MQTT-downlink path and FPort 2. Use `encodeIdentifyFrame`; remove the literal `[0xA8,...0x30,0x49,0x21...]`. Ensure first-join auto-identify takes the same discovery path when no layout exists.
- [ ] Extend `get-devices-query` with LEFT JOINs for both new local tables. In `merge-device-data`, expose `sdi12_recipe_deployment` only for `DRAGINO_SDI12` and expose a valid `sdi12_discovered_address`; never expose recipes or queue IDs. Replace the node's empty JSON parse catch with a bounded warning because the node is being touched.
- [ ] Implement `scripts/patch-sdi12-recipe-deployment.js` as an assertion-heavy one-shot transformation: require every expected node ID/type/wire before changing it; reject duplicate routes/nodes; serialize with two-space indentation plus final newline; reparse; mirror canonical bytes; assert maintained files are identical. The script must be safe to rerun or fail clearly after successful application.
- [ ] Update flow-size ratchet ceilings only for the reviewed changed/new function nodes, with a reason naming recipe deployment. Do not widen unrelated allowances.
- [ ] Run:

  ```bash
  node scripts/patch-sdi12-recipe-deployment.js
  node scripts/test-sdi12-recipe-flow.js
  node scripts/test-sdi12-registration.js
  node scripts/verify-flows-size-ratchet.js
  node scripts/verify-no-new-silent-catch.js
  node scripts/verify-sync-flow.js
  scripts/check-mqtt-topics.sh
  node scripts/verify-profile-parity.js
  ```

  Expected: both flow files parse and are byte-identical; all new endpoints and poll/observation paths are registered; no silent catch, topic, sync, or size ratchet regresses.
- [ ] Commit Task 5: `feat(sdi12): deploy and observe converter recipes`.

### Task 6: Expose honest commissioning controls and state in React

**Files:**

- Modify: `web/react-gui/src/types/farming.ts`
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/components/farming/Sdi12SettingsModal.tsx`
- Modify: `web/react-gui/src/components/farming/Sdi12SoilCard.tsx`
- Modify: `web/react-gui/src/components/farming/__tests__/Sdi12SettingsModal.test.tsx`
- Modify: `web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx`
- Modify: `web/react-gui/src/services/__tests__/api.sdi12.test.ts`
- Modify: `web/react-gui/public/locales/{de-CH,en,es,fr,it,lg,pt}/devices.json`

**Types and API:**

```ts
type Sdi12RecipeDeploymentStatus =
  | 'not_applied' | 'queueing' | 'queued'
  | 'observed_once' | 'observed_compatible' | 'degraded'

postSdi12RecipeApply(deveui: string)
postSdi12RecipeRollback(deveui: string)
```

- [ ] Add failing service normalization tests for the bounded deployment object and discovered address. Invalid status/data is omitted rather than trusted. Add endpoint tests for empty POST bodies and encoded DevEUI paths.
- [ ] Add failing modal tests proving a new Sentek address starts empty, a valid discovered address prefills it, and neither path defaults to `L`, `0`, or `C`.
- [ ] Add failing modal tests for every deployment state, save/apply separation, disabled Apply on unsaved/invalid layout, explicit confirmation before Apply, busy-state double-click prevention, degraded error display, and Rollback visibility only when a compatible pair exists.
- [ ] The confirmation must state that a maximum recipe takes about eight hours at the normal 20-minute cadence and uses an eight-second 12 V window per cycle. Do not offer continuous power or a shorter interval.
- [ ] Add failing card tests that show a commissioning banner without hiding old readings. Only `observed_compatible` is labelled active. Preserve VWC and VIC side-by-side at configured TriSCAN depths, hide unused modules, render missing as an em dash, and render numeric zero as `0.0`.
- [ ] Implement typed API normalization at the service boundary. Do not put recipe compilation, frame data, queue IDs, or status inference into React.
- [ ] On successful layout save, show `Layout saved; acquisition configuration not applied.` Refresh device state before enabling Apply. On Apply/Rollback 202, refresh the device list and show the returned status/version without claiming delivery.
- [ ] Add concise translations for all seven locales and run any locale-key parity test discovered by `npm run test:unit`.
- [ ] Run:

  ```bash
  cd web/react-gui
  npm run test:unit:vitest -- src/services/__tests__/api.sdi12.test.ts src/components/farming/__tests__/Sdi12SettingsModal.test.tsx src/components/farming/__tests__/Sdi12SoilCard.test.tsx
  npm run test:unit
  npm run build
  ```

  Expected: focused and full tests pass; production build exits 0; no empty-address, zero-value, or missing-data regression.
- [ ] Commit Task 6: `feat(gui): control SDI-12 recipe deployment`.

### Task 7: Document, adversarially review, and run the complete gate

**Files:**

- Modify: `docs/devices/dragino-sdi12.md`
- Create: `docs/superpowers/plans/2026-08-29-sdi12-recipe-deployment-execution-report.md`
- Modify `AGENTS.md` only if implementation creates a durable repository invariant not already documented.

- [ ] Update the device guide with layout-save versus hardware-apply semantics, two-stage Identify, all six deployment states, the no-flush rule, twelve-hour queue timeout, rollback behavior, and recovery actions. State that PConfig remains authoritative for probe calibration/address/depth configuration.
- [ ] Adversarially review the full diff for hardcoded addresses, browser-controlled bytes, wrong FPort, queue flushes, partial-enqueue lies, rollback/layout divergence, stale `queueing`, unbound SQL, recipe/queue-ID leakage, missing-data-to-zero coercion, hidden prior readings, sync-contract expansion, boot-DDL edits, and profile drift.
- [ ] Run the focused helper and integration suite:

  ```bash
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
  node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.test.js
  node scripts/test-sdi12-recipe-schema.js
  node scripts/test-sdi12-recipe-flow.js
  node scripts/test-sdi12-registration.js
  node scripts/verify-device-integration.js
  ```

- [ ] Run schema/runtime gates:

  ```bash
  node scripts/verify-migrations.js
  node scripts/verify-seed-replay.js
  node scripts/verify-db-schema-consistency.js
  node scripts/verify-runtime-schema-parity.js
  node scripts/verify-helper-registration.js
  node scripts/verify-profile-parity.js
  ```

- [ ] Run flow and contract gates:

  ```bash
  node scripts/verify-sync-flow.js
  node scripts/verify-no-new-silent-catch.js
  node scripts/verify-flows-size-ratchet.js
  node scripts/verify-communication-contract.js
  scripts/check-mqtt-topics.sh
  ```

- [ ] Run the full GUI tests and build from `web/react-gui`.
- [ ] Run `git diff --check`, inspect `git status --short --branch`, and confirm every changed file belongs to this plan or was pre-existing user work.
- [ ] Run the prose gate:

  ```bash
  node /home/phil/Repos/osi-os/.claude/skills/anti-slop-writing/slop-check.js \
    docs/superpowers/specs/2026-08-29-sdi12-recipe-deployment-design.md \
    docs/superpowers/plans/2026-08-29-sdi12-recipe-deployment-plan.md \
    docs/devices/dragino-sdi12.md \
    docs/superpowers/plans/2026-08-29-sdi12-recipe-deployment-execution-report.md
  ```

- [ ] Record exact commands, pass/fail output, baseline-only failures, deferred bench evidence, and reviewed commit IDs in the execution report. Do not label the build deployable while any new failure remains.
- [ ] Request an independent code review against the approved design. Resolve findings with new failing tests before live deployment.
- [ ] Commit Task 7: `docs(sdi12): record recipe deployment verification`.

### Task 8: Deploy to the AgroLink Pi only after the field fixture is confirmed

**Target:** `100.121.141.64`

**Expected first field device:** `A8404135955C327D`

**Expected layout after the operator confirms that the lab-tested probe is installed:** address digit `0`; TriSCAN at response positions 1/10 cm and 5/50 cm; EnviroSCAN at positions 2/20 cm, 3/30 cm, 4/40 cm, 6/60 cm, 7/80 cm, and 8/100 cm.

- [ ] Stop before deployment unless every Task 7 gate is green and the operator confirms the physical probe/layout. Do not infer confirmation from this plan or from earlier failed probes.
- [ ] Load `osi-live-ops-runbook`. Verify the exact SSH target and device EUI without contacting `osicloud.ch`.
- [ ] Take a timestamped pre-deploy backup covering `/data/db/`, `/srv/node-red/`, `/usr/lib/node-red/gui/`, flows, settings, and ChirpStack state. Record the backup path.
- [ ] Record pre-deploy `device_data` row count, latest timestamp, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, migration head/fingerprints, active queue contents, Node-RED health, and current GUI asset name.
- [ ] Stop Node-RED for the additive migration/deploy window. Deploy through the repository script using download-then-run semantics. Never replace `/data/db/farming.db`.
- [ ] Verify migration 0049, both tables/index, database integrity/foreign keys, Node-RED restart, `/gui`, rotated GUI asset, helper presence, and empty/pre-existing ChirpStack queue state.
- [ ] Save the confirmed canonical layout through the GUI/API. Verify it reports `not_applied` and does not enqueue anything.
- [ ] With explicit operator confirmation, press Apply once. Verify the API returns 202, all frames are on FPort 2, status is `queued`, normal TDC remains 1,200 seconds, 12 V window remains 8,000 ms, and no unrelated queue item was flushed.
- [ ] Monitor queue drain and at least two complete post-drain uplinks. Require eight finite VWC values and two finite VIC values mapped to the configured stable channels before accepting `observed_compatible`/active.
- [ ] If the queue times out, readings quarantine, or cardinality differs, keep prior readings visible, preserve evidence, and stop. Do not guess another address, shorten TDC, enable continuous 12 V, or repeatedly apply.
- [ ] Record post-deploy row counts, latest readings/timestamps, deployment state, queue evidence, integrity checks, and rollback availability in the execution report.
