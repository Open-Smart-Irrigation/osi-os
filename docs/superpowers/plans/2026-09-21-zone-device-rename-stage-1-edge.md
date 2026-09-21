# Rename zones and devices, stage 1 (edge): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can change the name of an irrigation zone and of a device after creation, from the edge dashboard, and the gateway applies the two name commands a linked cloud sends it.

**Architecture:** One new Node-RED module, `osi-entity-name`, holds the name rule of spec section 4 and every writer that puts a name on an existing row. `flows.json` reaches it through `osiLib.require('entity-name')` from two new REST routes, one new command-apply node and the four create paths, so create and rename accept exactly the same names. The dashboard gets a shared `EditableName` control and a TypeScript copy of the rule. No sync event, trigger or migration changes: the existing outbox triggers already carry `name` and `sync_version`.

**Tech Stack:** CommonJS modules under `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`, tested with `node --test`; Node-RED function nodes inside `flows.json`; SQLite through `osi-db-helper`; gRPC to ChirpStack through `osi-chirpstack-helper`; React 18, TypeScript, Vite and Vitest in `web/react-gui`; the repository's `scripts/verify-*.js` gates. The development host runs Node 22; the gateway image ships a Node 20-era package, which is why no code here uses an ES2024 method.

**Spec:** `docs/superpowers/specs/2026-09-21-zone-device-rename-design.md`. Stage 1 is section 5 plus sections 4, 8, 9 and 10. Sections 6 and 7 are osi-server work and are not in this plan.

## Global Constraints

- **The mirror rule.** Every file under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is copied byte for byte into `conf/full_raspberrypi_bcm27xx_bcm2709/files/`. Each task that touches one runs the copy and then `node scripts/verify-profile-parity.js`, which hashes the whole tree and fails on a directory that exists in only one profile.
- **Public text.** This plan, every commit message, every code comment and the pull-request body name no customer, site, farm or person. Test fixtures use invented EUIs and UUIDs.
- **`flows.json` is edited the way `.claude/skills/osi-flows-json-editing/SKILL.md` prescribes:** a scratch Node script that parses the file, asserts a byte-identical `JSON.stringify(flows, null, 2)` round trip before and after, finds nodes by `id` and never by line number, and writes the canonical profile and the mirror from the same in-memory array. A function node reaches an in-repo module with `osiLib.require('<registry name>')`, never with a bare `require()`.
- **One frontend build at a time.** `npm run build` in `web/react-gui` runs once, in Task 15, and never beside another build: this workstation runs out of memory with two.
- **Every commit is green.** Each task ends with the gates it can break, and the task order below exists so no commit leaves a verifier red. If a gate is red after your change, it is your change.
- **No push and no deploy without the repository owner's word.** The bench check in Task 15 needs an explicit go-ahead before anything touches a gateway.
- **The section 4 vectors stay literal backslash-u text.** In this file and in every test file, write `\u00a0`, `\u2028`, `\ufeff`, `\u0085` and the surrogate halves `\ud83c` and `\udf31` as escapes, never as the characters themselves. Many editors interpret them on write; after creating or editing a file, confirm it holds no raw NUL, U+0085, U+00A0, U+2028, U+2029 or U+FEFF:

  ```bash
  python3 -c "import sys;d=open(sys.argv[1],encoding='utf-8').read();bad=[hex(ord(c)) for c in d if ord(c) in (0,0x85,0xa0,0x2028,0x2029,0xfeff)];print('raw control characters:',bad or 'none')" <file>
  ```

- **Reason codes are exactly** `name_empty`, `name_too_long`, `name_control_characters`, `name_invalid_unicode`. The limit is 100 Unicode code points, counted with `Array.from(...).length`, never `String.length`.
- **Pinned names.** Command types `UPSERT_DEVICE_NAME` and `UPSERT_ZONE_NAME`; registry entry `{ dispatch: 'entity_name_apply', actuator: false, requires_duration: false }`; function node id `entity-name-command-apply-fn`, name `Apply Entity Name Command`; capability string `entity_name_commands_v1`; osi-lib registry key `entity-name`.
- **The size ratchet is re-measured, never added up.** `scripts/verify-flows-size-ratchet-allowances.json` is edited by five tasks and the deltas stack. Every task that touches it sets `total_allowance.delta` from a fresh measurement against `origin/main`, with the command in "Setting a size-ratchet number" below.

## Setting a size-ratchet number

Tasks 6, 7, 8, 9 and 10 each grow `flows.json`, and each has to keep `node scripts/verify-flows-size-ratchet.js` green. Never add a task's recorded increase to the number already in the file: if a task is reworked or the tasks land out of order, the sum drifts from the truth. Measure the whole file against `origin/main` instead, and write that figure:

```bash
node -e "
const { execFileSync } = require('node:child_process');
const { nodeSizes, totalChars } = require('./scripts/flows-size-scan');
const rel = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const baseFlows = JSON.parse(execFileSync('git', ['show', 'origin/main:' + rel], { encoding: 'utf8', maxBuffer: 67108864 }));
const headFlows = require('./' + rel);
const base = nodeSizes(baseFlows);
const head = nodeSizes(headFlows);
for (const id of process.argv.slice(1)) {
  const b = base.get(id);
  const h = head.get(id);
  console.log(id, 'base', b ? b.chars : '(new)', '-> head', h ? h.chars : '(gone)', b && h ? 'delta ' + (h.chars - b.chars) : '');
}
console.log('profile total base', totalChars(baseFlows), '-> head', totalChars(headFlows), 'delta', totalChars(headFlows) - totalChars(baseFlows));
" <node id> <node id> ...
```

The last line is the number `total_allowance.delta` must hold. An existing node that grew needs a `node_allowances` entry whose `delta` is at least its measured growth; a node the base ref does not have needs a `new_node_ceilings` entry only when it measures over 4096 characters. Every entry carries a `reason` that names the task and the measurement, in the style the file already uses.

## Shared facts

Checked in the worktree against `origin/main` at `c37207b30`. Re-check the ones your task uses before you rely on them: both mains move daily.

- A transaction scope from `osi-db-helper` has `get`, `run`, `all` and `exec`, and no `transaction` method (`osi-db-helper/index.js`, `createTransactionScope`). A writer that runs inside a caller's transaction takes that scope; the wrappers call `db.transaction(...)` themselves.
- Module tests run as `node --test <path to the test file>` from the repository root, one workflow line per module in `.github/workflows/migrations.yml`, and the pass signal is `# fail 0` with exit 0. They use `node:sqlite`, which needs Node 22.5 or newer; an older local Node reports `Cannot find module 'node:sqlite'` rather than a test failure.
- These verifiers are green on the base: `verify-sync-flow.js`, `verify-sync-contract.js`, `test-contract-schemas.js`, `verify-helper-registration.js`, `verify-module-file-deploy-coverage.js` (`all 96 runtime files`), `verify-profile-parity.js`, `verify-sync-op-parity.js`, `verify-flows-size-ratchet.js` and `osi-lib-binding-audit.js`. A red one after your change is your change.
- The canonical `flows.json` is 1,847,351 bytes, 726 nodes, 297 function nodes and 1,539,627 characters of embedded function JavaScript. The bcm2709 mirror is byte-identical.
- `Route Command` (node `934bf2bc19a8ce22`) never reads the registry's `dispatch` value. It is an explicit `commandType` if-chain ending in `return null;`, so `dispatch: 'entity_name_apply'` is metadata that only `scripts/verify-command-safety.js` reads. The new applier consumes both name types before they reach it.
- `command-dedupe-dispatch` passes an unhandled message on as `return [msg, null]` with `cmd._pendingCommandEnvelope` untouched, and consumes a message only when `osi-command-ledger.deduplicatePendingCommand` reports a replay. A name command carries no `effect_key`, no effect-key grammar matches the empty string, and the ledger returns `{ handled: false }` before its effect-key duplicate lookup.
- In `web/react-gui`, `npm run test:unit` chains `tsx --test 'tests/**/*.test.ts'` and `vitest run` over a fixed list of `__tests__` directories. That list already holds `src/utils/__tests__`, `src/components/farming/__tests__` and `src/components/farming/valves/__tests__`, so no script edit is needed. There is no `src/components/farming/shared/__tests__` in it, which is why `EditableName`'s test goes next to `HelpTip.test.tsx` in `src/components/farming/__tests__/`.
- `web/react-gui/tsconfig.json` sets `"target": "ES2020"` and `"lib": ["ES2020", "DOM", "DOM.Iterable"]`. `String.prototype.isWellFormed` is ES2024 and in neither, which is why both copies of the rule scan UTF-16 code units by hand.
- `scripts/verify-sync-flow.js` and `scripts/verify-command-safety.js` read GUI files by absolute path. Between them they pin `src/services/api.ts`, `IrrigationZoneCard.tsx`, `KiwiSensorCard.tsx`, `DraginoTempCard.tsx`, `LoRainGaugeCard.tsx`, `SenseCapWeatherCard.tsx`, `FarmingDashboard.tsx`, `valves/ValveTile.tsx`, `valves/ValveControlPanel.tsx`, `StregaValveCard.tsx` and `types/farming.ts`. None of them may be renamed, moved or deleted.

## Task order

The numbers are the execution order. Two dependencies decide it, and neither is cosmetic.

**The module lands before the flows.** Tasks 1 to 5 create `osi-entity-name`, register it in `osi-lib/index.js`, cover it in `deploy.sh` and the firmware seed loop, and add `updateDeviceName` to the ChirpStack helper. Every flow task calls `osiLib.require('entity-name')`, so landing one of them first turns `node scripts/verify-helper-registration.js` and every new flow test red.

**The command contract travels with the registry.** `scripts/verify-sync-contract.js` builds the expected `command_type` enum as the types in the `cmd-type-registry` function node, plus `WORK_REQUEST_STATUS`, plus the commands staged in `scripts/fixtures/sync-contract-staging.json`, and requires `docs/contracts/sync-schema/commands.schema.json` to equal it exactly. Adding the two types to either side alone turns that gate red. Task 8 therefore owns both halves and commits them together: the schema enum, the two `allOf` branches, the three missing top-level properties, the `scripts/test-contract-schemas.js` instances, the `cmd-type-registry` entries, the `reject-indefinite-open` fallback entries and the capability builders. Task 5 keeps only the half that is green on its own, the name rule inside the versioned `UPSERT_ZONE` applier.

| # | Task | Depends on | Why |
|---|---|---|---|
| 1 | Module `osi-entity-name`, name rule and registration | — | Everything else loads this module |
| 2 | Rename writers in `index.js` | 1 | Uses `normalizeEntityName` and the module's files |
| 3 | Receiver `commands.js` for the two name commands | 1, 2 | Calls the in-transaction writers |
| 4 | ChirpStack device name, bounded at five seconds | — (module-local) | Tasks 7 and 8 call `updateDeviceName` |
| 5 | The name rule in the versioned `UPSERT_ZONE` applier | 1 | `osi-zone-commands` requires `../osi-entity-name` |
| 6 | Route `PUT /api/irrigation-zones/:id/name` | 1, 2 | Calls `renameZone` through the osi-lib seam |
| 7 | Route `PUT /api/devices/:deveui/name` | 1, 2, 4 | Calls `renameDevice`, then `updateDeviceName` |
| 8 | Command path, registry, capability and the command contract | 1, 2, 3, 4 | Calls `applyNameCommand`; schema and registry must move together |
| 9 | The name rule on the four create paths | 1 | Four function nodes call `normalizeEntityName` |
| 10 | Legacy `UPSERT_ZONE` branch of node `4f4a765f36cee6f3` | 1 | Same |
| 11 | The name rule in TypeScript | — | The GUI copy of section 4 |
| 12 | The shared `EditableName` component | 11 | Validates with the TypeScript rule |
| 13 | API helpers and card wiring | 11, 12, and the routes of 6 and 7 at runtime | Renders `EditableName` on eight surfaces |
| 14 | The nine strings in seven locales | 12, 13 name the keys | Supplies what those call sites read |
| 15 | Full gate run, bench check and pull request | all | The stage-1 gate set, one production build, the bench check |

Tasks 13 and 14 ship in the same pull request. Between those two commits the dashboard renders the raw key `rename.zone` where a label belongs, which no gate catches and no gateway ever sees, because nothing is deployed from a mid-branch commit.

No task was renumbered. Tasks 1 to 14 keep the numbers their authors gave them, and only the content of Task 5 moved, into Task 8, so a reference to "Task N" means the same task it always did.

---

## File structure

Paths under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` are written once below; each has a byte-identical twin under `conf/full_raspberrypi_bcm27xx_bcm2709/files/` that the same task writes.

### Created

| File | Responsibility | Task |
|---|---|---|
| `.../node-red/osi-entity-name/package.json` | Module manifest, `main: index.js`, no dependency | 1 |
| `.../node-red/osi-entity-name/index.js` | `normalizeEntityName` and the four rename writers; touches nothing but the database handle it is given | 1, 2 |
| `.../node-red/osi-entity-name/index.test.js` | The sixteen name vectors of spec section 4 and the writer cases of spec section 10 | 1, 2 |
| `.../node-red/osi-entity-name/commands.js` | `applyNameCommand`: the receiver for `UPSERT_DEVICE_NAME` and `UPSERT_ZONE_NAME` | 3 |
| `.../node-red/osi-entity-name/commands.test.js` | Every receiver case of spec section 10, plus the command-ledger passthrough proof | 3 |
| `scripts/test-zone-rename-route.js` | Runs `zone-rename-scope-guard` and `zone-rename-fn` against an in-memory SQLite fixture | 6 |
| `scripts/test-device-rename-route.js` | The same for the device route, with a fake ChirpStack helper | 7 |
| `scripts/test-entity-name-command-path.js` | Runs the shipped `entity-name-command-apply-fn` source and pins the registry, the fallback table and the three capability builders | 8 |
| `scripts/test-entity-name-create-paths.js` | Runs the name handling of `post-zone-auth`, `scoped-zone-create-router`, `post-devices-auth` and `cs-reg-cloud-fn` | 9 |
| `scripts/test-legacy-upsert-zone-name.js` | Builds the `UPSERT_ZONE` statement with node `4f4a765f36cee6f3` and applies it to a fixture database | 10 |
| `web/react-gui/src/utils/entityName.ts` | The section 4 rule in TypeScript: `ENTITY_NAME_MAX`, `EntityNameReason`, `EntityNameResult`, `normalizeEntityName` | 11 |
| `web/react-gui/src/utils/__tests__/entityName.test.ts` | The sixteen vectors again, in the GUI runtime | 11 |
| `web/react-gui/src/components/farming/shared/EditableName.tsx` | Heading and pencil in read mode, input and error in edit mode, one in-flight save | 12 |
| `web/react-gui/src/components/farming/__tests__/EditableName.test.tsx` | Save, cancel, focus return, client-side rejection, server reason, save-once | 12 |
| `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardRename.test.tsx` | Zone-card wiring: calls `irrigationZonesAPI.rename`, refreshes through `onUpdate`, hides the pencil without `canWrite` | 13 |
| `web/react-gui/tests/renameLocales.test.ts` | Seven-locale parity, placeholder parity, five European locales translated, `lg` byte-identical to `en` | 14 |

### Modified

| File | Change | Task |
|---|---|---|
| `.../node-red/osi-lib/index.js` | `entity-name` entry in `NAME_TO_PATH` | 1 |
| `.../node-red/osi-lib/index.test.js` | `entity-name` in the pinned registry key list | 1 |
| `.../node-red/package.json` | `"osi-entity-name": "file:osi-entity-name"` | 1 |
| `.../node-red/package-lock.json` | Root dependency, `node_modules` link entry, local package metadata | 1 |
| `conf/.../files/etc/uci-defaults/98_osi_node_red_seed` | `osi-entity-name` in the module-copy loop | 1 |
| `deploy.sh` | One `fetch_required` block per shipped module file | 1, 3 |
| `.github/workflows/migrations.yml` | Runs `osi-entity-name/*.test.js` | 1 |
| `.../node-red/osi-chirpstack-helper/index.js` | `NAME_UPDATE_DEADLINE_MS`, a per-call deadline on `grpcInvoke` and `getDevice`, `setDeviceName`, `updateDeviceName`, name reconciliation in `ensureDeviceProvisioned` | 4 |
| `.../node-red/osi-chirpstack-helper/index.test.js` | The ChirpStack cases of spec section 10, the deadline cases, and one fixture correction | 4 |
| `.../node-red/osi-zone-commands/index.js` | `zone.name` runs the shared rule instead of its 128-character bound | 5 |
| `scripts/test-zone-command-path.js` | Name-rule cases for the versioned `UPSERT_ZONE` applier | 5 |
| `.../files/usr/share/flows.json` | Two route chains, the command-apply node, the registry and capability edits, the create-path edits, the legacy branch | 6, 7, 8, 9, 10 |
| `scripts/verify-sync-flow.js` | Route, node, wiring, capability and GUI assertions | 6, 7, 8, 9, 10, 13 |
| `scripts/verify-flows-size-ratchet-allowances.json` | New-node ceilings, per-node growth allowances, the re-measured total | 6, 7, 8, 9, 10 |
| `.github/workflows/verify-sync-flow.yml` | Runs the five new flow test files | 6, 7, 8, 9, 10 |
| `docs/contracts/sync-schema/commands.schema.json` | Both command types, their `allOf` branches, three missing top-level properties | 8 |
| `scripts/test-contract-schemas.js` | Valid and invalid instances of both commands; 101-character resource names stay valid | 8 |
| `scripts/osi-lib-binding-audit.js` | The reviewed SHA-256 and binding policy for `entity-name-command-apply-fn` | 8 |
| `scripts/osi-lib-binding-audit.test.js` | The matching `expectedById` entry | 8 |
| `scripts/test-flows-wiring.js` | Re-pins the command-apply chain and adds the new applier's contract | 8 |
| `scripts/test-journal-bootstrap.js` | `EXPECTED_CAPABILITIES` gains `entity_name_commands_v1` | 8 |
| `AGENTS.md` | Cloud-to-edge command list, edge rename routes, reported sync capabilities | 8, 15 |
| `web/react-gui/src/services/api.ts` | `irrigationZonesAPI.rename`, `devicesAPI.rename`, the `reason`-carrying error mapping | 13 |
| `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` | Heading out of the collapse button, `EditableName`, `onUpdate` for three child cards | 13 |
| `web/react-gui/src/components/farming/KiwiSensorCard.tsx`, `StregaValveCard.tsx`, `DraginoTempCard.tsx`, `LoRainGaugeCard.tsx`, `SenseCapWeatherCard.tsx`, `Sdi12SoilCard.tsx` | `EditableName` heading and a rename handler; three gain an `onUpdate` prop | 13 |
| `web/react-gui/src/components/farming/valves/ValveTile.tsx` | `EditableName` heading, new `canEdit` and `onRename` props | 13 |
| `web/react-gui/src/components/farming/valves/ValveControlPanel.tsx` | New `canWrite` prop and a rename handler that refreshes the valve list | 13 |
| `web/react-gui/src/pages/FarmingDashboard.tsx` | Passes `canWrite` to the panel and `onUpdate` to the two cards that lacked it | 13 |
| `web/react-gui/src/components/farming/AddDeviceModal.tsx`, `ZoneDeviceModal.tsx`, `CreateZoneModal.tsx` | Validate with `normalizeEntityName` and send the normalized name | 13 |
| `web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx`, `AddDeviceModal.test.tsx`, `ZoneDeviceModal.test.tsx`, `CreateZoneModal.uicore.test.tsx` | Rename and modal-validation cases; `rename` added to the api mocks | 13 |
| `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardRemoveContext.test.tsx`, `IrrigationZoneCardData.test.tsx`, `IrrigationZoneCardLocale.test.tsx`, `IrrigationZoneCardSensorGating.test.tsx` | Six call sites that expanded the card by clicking its heading move to the collapse button | 13 |
| `web/react-gui/public/locales/{en,de-CH,fr,it,es,pt,lg}/devices.json` | The nine `rename.*` keys | 14 |
| `docs/i18n/pending-luganda-translations.md` | A section listing the nine keys | 14 |

`docs/contracts/sync-schema/resources.schema.json` does not change. Decision D6: rows longer than 100 characters already exist legally and still travel in bootstrap and in unrelated events.

## Spec coverage

Every stage-1 requirement of the spec, and the task that carries it.

| Spec | Requirement | Task |
|---|---|---|
| 4 | The five-step rule, the four reason codes, the 100-code-point limit, the sixteen vectors, on the edge | 1 |
| 4 | The same rule and vectors in the GUI's TypeScript copy | 11 |
| 4 | A row that already breaks the rule keeps syncing and is only held to the rule at the next save | 8 (the 101-character resource instances stay valid), 2 (the writers touch a name only on request) |
| 4 | History labels keep hiding a 16-hex token; the rename UI does not warn about it | No change. Task 13 leaves `osi-history-helper` and `src/history/sourceLabels.ts` alone |
| 5.1 | Module `osi-entity-name` with `index.js` and `commands.js`, registered in `osi-lib/index.js` as `entity-name` | 1, 3 |
| 5.1 | Callers of `normalizeEntityName`: the writers, the receiver, the versioned `UPSERT_ZONE` applier, the legacy branch, and the four create paths | 2, 3, 5, 10, 9 |
| 5.2 | `PUT /api/irrigation-zones/:id/name` with its body, 200 shape and error codes | 6 |
| 5.2 | `PUT /api/devices/:deveui/name`, including the `chirpstack` field | 7 |
| 5.2 | `changed: false` writes nothing; `chirpstack` is `skipped` when nothing changed or provisioning is not configured | 6, 7 |
| 5.2 | Authorization: owner match with the flag off, `assertFreshRole` plus `canMutate` plus the per-resource assertion with the flag on | 6, 7 |
| 5.3 | The three steps of each in-transaction writer, and the wrappers that open the transaction | 2 |
| 5.3 | The versioned `UPSERT_ZONE` applier uses the rule instead of its 128-character bound | 5 |
| 5.3 | The legacy `UPSERT_ZONE` branch | 10 |
| 5.3 | Device re-claim: the rule applied upstream in `post-devices-auth` | 9 |
| 5.3 | `REGISTER_DEVICE` in `cs-reg-cloud-fn` applies the rule and falls back to the DevEUI | 9 |
| 5.4 | No new sync event: the update fires the existing trigger with the new name and version, and a `changed: false` result fires neither | 2 (outbox assertions), 6, 7 |
| 5.5 | `updateDeviceName` reads `devices.name` at the moment it runs, is serialized per DevEUI, and rejects on a gRPC failure | 4 |
| 5.5 | The call happens after the transaction commits, never inside it; a failure is a `node.warn` and `chirpstack: "failed"`, and an acknowledgement stays `APPLIED` | 7, 8 |
| 5.5 | `ensureDeviceProvisioned` reconciles an existing device's name from the value it is given | 4 |
| 5.6 | The receiver: payload shape, the eight in-transaction steps, the stable reason set, the two identities, the supersession fence | 3 |
| 5.6 | The command ledger passes a payload without an `effect_key` on to the receiver | 3, 8 |
| 5.6 | A new function node in the pending-command chain that emits the acknowledgement on `devices/<gatewayEui>/command_ack` and runs the ChirpStack update after an applied device rename | 8 |
| 5.6 | Both types in `cmd-type-registry` and in the `reject-indefinite-open` fallback, with `actuator: false` and `requires_duration: false` | 8 |
| 5.6 | `entity_name_commands_v1` in all three `syncCapabilities` builders | 8 |
| 5.7 | Node `4f4a765f36cee6f3` keeps the stored name for an invalid or missing name, falls back to `Zone` on a first insert, and warns | 10 |
| 5.8 | `EditableName`: Enter and blur save, Escape cancels and returns focus, client-side rejection, server reason, one in-flight save | 12 |
| 5.8 | The control replaces the heading on the zone card and on all seven device surfaces, behind the existing permission signal | 13 |
| 5.8 | `irrigationZonesAPI.rename` and `devicesAPI.rename` | 13 |
| 5.8 | `entityName.ts` with the section 4 vectors; the three modals use it and send normalized names | 11, 13 |
| 5.8 | Nine new strings in seven locales, `lg` shipping the English source text, listed in `docs/i18n/pending-luganda-translations.md` with the test allowlist | 14 |
| 5.9 | The bcm2709 mirror and `verify-profile-parity.js` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 |
| 5.9 | A `deploy.sh` `fetch_required` entry per module file; `verify-module-file-deploy-coverage.js` and `verify-helper-registration.js` pass | 1, 3 |
| 5.9 | `osi-lib-binding-audit.js` entry for the new function node | 8 |
| 5.9 | Registration in the node-red `package.json`, the lockfile, `osi-lib/index.js` and `98_osi_node_red_seed` | 1 |
| 5.9 | `verify-sync-flow.js` assertions for the new routes and API functions | 6, 7, 8, 9, 10, 13 |
| 5.9 | New HTTP nodes use parameterised SQL | 6, 7 |
| 8 | `commands.schema.json`: both types in the enum, one `allOf` branch each, the missing top-level properties | 8 |
| 8 | `test-contract-schemas.js`: a valid and an invalid instance of each command, and a 101-character resource name that stays valid | 8 |
| 8 | `resources.schema.json` unchanged, so stage 1 needs no osi-server mirror pull request | 8 (the task asserts the file is untouched) |
| 9 | After its Node-RED restart a gateway reports `entity_name_commands_v1` in the bootstrap it sends at start | 8 |
| 9 | Stage 1 is safe against an older cloud: it emits only events every deployed cloud already applies | 15 (stated in the pull-request body; no code change) |
| 10 | Name rule vectors in `osi-entity-name` and in `entityName.ts` | 1, 11 |
| 10 | Writers: changed, unchanged, missing, deleted; one version bump; one outbox row; none when unchanged; the in-transaction variant inside a caller's transaction | 2 |
| 10 | Receiver: every listed case, including `superseded` and two renames in order | 3 |
| 10 | ChirpStack: updated, unchanged, gRPC failure, reverse-order completion, `ensureDeviceProvisioned` reconciliation | 4 |
| 10 | Routes: both routes with the flag off and on, and each reason code | 6, 7 |
| 10 | Legacy `UPSERT_ZONE`: no name, over-long, control character, first insert, valid name | 10 |
| 10 | Compatibility: a 101-character name stays valid in the resource schema | 8 |
| 10 | Edge GUI: save on Enter and blur, one API call, Escape restores focus, client-side blocks, server reason, pencil hidden, locale parity in seven languages | 12, 13, 14 |
| 10 | The fourteen stage-1 gates, the GUI typecheck, the unit tests and one production build | 15 |
| 10 | The bench check on a test gateway | 15 |

---

### Task 1: module `osi-entity-name`, name rule and registration

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/package.json`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js:24-53`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed:42`
- Modify: `deploy.sh` (after the `osi-device-commands weather.js` block, currently line 1135)
- Modify: `.github/workflows/migrations.yml` (after the `osi-device-commands/weather.test.js` line, currently line 122)
- Mirror: the bcm2709 twin of every path above under `conf/full_raspberrypi_bcm27xx_bcm2709/`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `normalizeEntityName(raw)` returns the trimmed, valid name as a string, or
    throws an `Error` carrying `.code` (one of the four reason codes) and
    `.statusCode = 400`. `null` and `undefined` throw `name_empty`, so a request
    body with no `name` key reads as a missing name; any other non-string throws
    `name_invalid_unicode`, the reason code of the rule's first step.
  - `ENTITY_NAME_MAX = 100`, the code-point limit.
  - The osi-lib key `entity-name`, so a function node reaches the module with
    `osiLib.require('entity-name')` and reads `.ok` / `.value` / `.error`.

- [ ] **Step 1: Write the failing test**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js`:

```js
'use strict';
// Co-located tests for osi-entity-name. The vector table below is the whole of
// section 4 of docs/superpowers/specs/2026-09-21-zone-device-rename-design.md;
// the TypeScript copy in the GUI and the Java class in osi-server carry the
// same sixteen rows.
const assert = require('node:assert/strict');
const test = require('node:test');

const entityName = require('./index');

const ACCEPTED = [
  ['North block', 'North block'],
  ['  North block \n', 'North block'],
  ['\u00a0Bloc nord\u00a0', 'Bloc nord'],
  ['\ufeffNorth', 'North'],
  ['\u2028North\u2029', 'North'],
  ['a'.repeat(100), 'a'.repeat(100)],
  ['\ud83c\udf31'.repeat(100), '\ud83c\udf31'.repeat(100)],
];

const REJECTED = [
  ['', 'name_empty'],
  ['   ', 'name_empty'],
  ['Row\t7', 'name_control_characters'],
  ['Row\u00007', 'name_control_characters'],
  ['A\u2028B', 'name_control_characters'],
  ['\u0085North', 'name_control_characters'],
  ['a'.repeat(101), 'name_too_long'],
  ['\ud83c', 'name_invalid_unicode'],
  ['\udf31x', 'name_invalid_unicode'],
];

test('the accepted vectors normalize to their stored form', () => {
  for (const [input, expected] of ACCEPTED) {
    assert.equal(
      entityName.normalizeEntityName(input),
      expected,
      'vector ' + JSON.stringify(input)
    );
  }
});

test('the rejected vectors fail with their reason code', () => {
  for (const [input, reason] of REJECTED) {
    assert.throws(
      () => entityName.normalizeEntityName(input),
      (error) => error.code === reason && error.statusCode === 400,
      'vector ' + JSON.stringify(input) + ' must fail with ' + reason
    );
  }
});

test('the limit counts code points, not UTF-16 units', () => {
  assert.equal(entityName.ENTITY_NAME_MAX, 100);
  const hundredSeedlings = '\ud83c\udf31'.repeat(100);
  assert.equal(hundredSeedlings.length, 200);
  assert.equal(Array.from(hundredSeedlings).length, 100);
  assert.equal(entityName.normalizeEntityName(hundredSeedlings), hundredSeedlings);
  assert.throws(
    () => entityName.normalizeEntityName('\ud83c\udf31'.repeat(101)),
    (error) => error.code === 'name_too_long'
  );
});

test('a missing name is name_empty and any other non-string is name_invalid_unicode', () => {
  for (const missing of [undefined, null]) {
    assert.throws(
      () => entityName.normalizeEntityName(missing),
      (error) => error.code === 'name_empty' && error.statusCode === 400,
      'a body without a name field must read as name_empty, not as broken Unicode'
    );
  }
  for (const wrongType of [42, {}, ['North'], true]) {
    assert.throws(
      () => entityName.normalizeEntityName(wrongType),
      (error) => error.code === 'name_invalid_unicode' && error.statusCode === 400,
      'vector ' + JSON.stringify(wrongType)
    );
  }
});

test('the surrogate scan does not depend on String.prototype.isWellFormed', () => {
  const source = require('node:fs').readFileSync(__dirname + '/index.js', 'utf8');
  // Call-shaped, so the comment in index.js that explains why the feature is
  // avoided does not trip its own guard.
  assert.equal(/\.(?:isWellFormed|toWellFormed)\s*\(/.test(source), false,
    'the gateway image ships a Node 20-era package; the scan must be hand-written');
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js`

Expected: FAIL, exit 1, with `Cannot find module './index'`. Nothing has been
created yet.

- [ ] **Step 3: Write the module manifest**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/package.json`:

```json
{
  "name": "osi-entity-name",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "type": "commonjs"
}
```

- [ ] **Step 4: Write the name rule**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js`:

```js
'use strict';
// osi-entity-name -- the edge implementation of the zone and device name rule
// (docs/superpowers/specs/2026-09-21-zone-device-rename-design.md, section 4)
// and of the writers that put a validated name on an existing row.
//
// Pure Node, no npm dependency: this file touches nothing but the database
// handle it is given, so the rule can be required from a REST handler, from a
// command receiver and from a test alike.

const MAX_CODE_POINTS = 100;

// The ECMAScript trim set: WhiteSpace plus LineTerminator, spelled out so the
// GUI copy and the cloud's Java class can be diffed against the same list.
// U+0085 is deliberately absent. It is category Cc, so it fails the control
// check below instead of being trimmed away.
const TRIM_CLASS = '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
const TRIM_RE = new RegExp('^[' + TRIM_CLASS + ']+|[' + TRIM_CLASS + ']+$', 'g');

// Unicode categories Cc, Zl and Zp.
const CONTROL_RE = new RegExp('[\u0000-\u001F\u007F-\u009F\u2028\u2029]');

function nameError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

// String.prototype.isWellFormed landed in V8 11.0, and the gateway image ships
// a Node 20-era OpenWrt package whose exact build is not pinned anywhere in
// this repository. The scan is written by hand so the rule cannot depend on a
// runtime feature nobody has verified on a Pi.
function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizeEntityName(raw) {
  // An absent field is a missing name, not a broken one: a PUT body without a
  // `name` key answers name_empty, the same reason an empty string gets, so
  // the GUI shows one sentence for both. Any other non-string is a client that
  // sent the wrong type, and it gets the step-1 reason code.
  if (raw === null || raw === undefined) {
    throw nameError('name_empty', 'name is required');
  }
  if (typeof raw !== 'string') {
    throw nameError('name_invalid_unicode', 'name must be a string');
  }
  if (hasLoneSurrogate(raw)) {
    throw nameError('name_invalid_unicode', 'name contains a lone UTF-16 surrogate');
  }
  const trimmed = raw.replace(TRIM_RE, '');
  if (!trimmed) {
    throw nameError('name_empty', 'name must not be empty');
  }
  if (Array.from(trimmed).length > MAX_CODE_POINTS) {
    throw nameError(
      'name_too_long',
      'name must not exceed ' + MAX_CODE_POINTS + ' characters'
    );
  }
  if (CONTROL_RE.test(trimmed)) {
    throw nameError('name_control_characters', 'name must not contain control characters');
  }
  return trimmed;
}

module.exports = {
  ENTITY_NAME_MAX: MAX_CODE_POINTS,
  normalizeEntityName,
};
```

The two classes are built with `new RegExp` from one shared string, so the
opening and closing halves of the trim expression can never drift apart.

- [ ] **Step 5: Run the test and watch it pass**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js`

Expected: PASS, exit 0, `# fail 0` with five passing tests.

- [ ] **Step 6: Register the module in the osi-lib loader**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js`,
add one entry to `NAME_TO_PATH` immediately after the `'device-writer'` line:

```js
  'device-writer': 'osi-device-writer',
  // Zone and device rename: the name rule, the two writers and the receiver
  // for UPSERT_DEVICE_NAME / UPSERT_ZONE_NAME live in one module.
  'entity-name': 'osi-entity-name',
```

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js`,
add `'entity-name',` to the sorted key list between `'device-writer',` and
`'history-router',`, and add one assertion after the `device-writer` line inside
the same test:

```js
  assert.equal(osiLib.NAME_TO_PATH['entity-name'], 'osi-entity-name');
```

- [ ] **Step 7: Declare the module in the runtime package files**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`,
add the dependency after the `"osi-device-commands"` line:

```json
    "osi-entity-name": "file:osi-entity-name",
```

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json`,
make three edits. First, in `packages[""].dependencies`, after the
`"osi-device-commands"` line:

```json
        "osi-entity-name": "file:osi-entity-name",
```

Second and third, at the end of the `packages` object, after the existing
`"osi-network-api": { "version": "1.0.0" }` entry (currently the last one), add
a comma to that entry and append:

```json
    "node_modules/osi-entity-name": {
      "resolved": "osi-entity-name",
      "link": true
    },
    "osi-entity-name": {
      "version": "1.0.0"
    }
```

`verify-helper-registration.js` requires all three lockfile shapes: the root
dependency, the `node_modules/<name>` link, and the local package metadata.

- [ ] **Step 8: Add the module to the firmware seed loop**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed`,
line 42, append `osi-entity-name` to the module list. The loop must read:

```sh
for module in osi-chameleon-helper osi-chirpstack-helper osi-cloud-http osi-command-ledger osi-scoped-access-commands osi-zone-commands osi-device-commands osi-db-helper osi-dendro-helper osi-dendro-analytics osi-zone-env osi-history-helper osi-history-sync-helper osi-radio-helper osi-network-api osi-installation-location-helper osi-installation-helper osi-history-router osi-health-helper osi-lib osi-module-defaults osi-journal osi-journal-replication osi-device-writer osi-uplink-dedup-guard osi-uc512-normalize osi-lsn50-normalize osi-sdi12-normalize osi-sdi12-commissioning osi-sdi12-recipe osi-sdi12-reassemble osi-valve-control osi-system-settings osi-scope-helper osi-entity-name; do
```

- [ ] **Step 9: Add the deploy.sh fetch blocks**

In `deploy.sh`, after the `osi-device-commands weather.js` block (currently
ending at line 1134), insert:

```sh
fetch_required "osi-entity-name package.json" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/package.json" \
    "/srv/node-red/osi-entity-name/package.json"

fetch_required "osi-entity-name index.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js" \
    "/srv/node-red/osi-entity-name/index.js"
```

`commands.js` gets its own block in Task 3, together with the file. A
`fetch_required` line for a file that does not exist yet would abort a real
deploy.

- [ ] **Step 10: Add the CI line**

In `.github/workflows/migrations.yml`, after the
`osi-device-commands/weather.test.js` line (currently line 122), insert:

```yaml
      - run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/*.test.js
```

The glob picks up `commands.test.js` when Task 3 adds it. This is the same shape
as the `osi-valve-control/*.test.js` and `osi-system-settings/*.test.js` lines
above it.

- [ ] **Step 11: Mirror to the bcm2709 profile**

```bash
mkdir -p conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name
cp -a conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/. \
      conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name/
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib/index.test.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package.json
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package-lock.json
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/98_osi_node_red_seed
```

- [ ] **Step 12: Run the registration gates**

```bash
node scripts/verify-profile-parity.js
node scripts/verify-helper-registration.js
node scripts/verify-module-file-deploy-coverage.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js
```

Expected, in order: `All parity checks passed.` and exit 0;
`OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-entity-name` among the lines,
then `All helper-registration checks passed.` and exit 0;
`OK: all 98 runtime files in deploy.sh-shipped osi-* modules are fetched.` and
exit 0 (96 before this task, plus the module's two files); `# fail 0` twice.

- [ ] **Step 13: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-lib \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package-lock.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/package-lock.json \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/98_osi_node_red_seed \
        deploy.sh .github/workflows/migrations.yml
git commit -m "feat: add osi-entity-name with the shared zone and device name rule"
```

---

### Task 2: rename writers in `index.js`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js`
- Mirror: both files into `conf/full_raspberrypi_bcm27xx_bcm2709/`

**Interfaces:**
- Consumes: `normalizeEntityName` from Task 1. Callers normalize the name before
  they call a writer; the writers take an already normalized string.
- Produces:
  - `renameZoneInTransaction(tx, { zoneId?, zoneUuid?, name })` returns
    `{ changed, id, zone_uuid, name, sync_version }`. Exactly one of `zoneId` and
    `zoneUuid` must be given.
  - `renameDeviceInTransaction(tx, { deveui, name })` returns
    `{ changed, deveui, name, sync_version }`.
  - `renameZone(db, args)` and `renameDevice(db, args)`, same arguments and
    results, each opening its own transaction.
  - A missing or deleted row throws an `Error` with `.code = 'not_found'` and
    `.statusCode = 404`.

- [ ] **Step 1: Write the failing tests**

Append to
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js`.
Add these requires at the top of the file, under the existing ones:

```js
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');

const GATEWAY = '0011223344556677';
const DEVICE = 'AABBCCDDEEFF0011';
const ZONE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-09-21T09:00:00.000Z';
```

Then append these tests:

```js
// A fixture on the real schema: seed-blank.sql brings the two outbox triggers
// with it, so an assertion about sync_outbox is an assertion about what a
// gateway would really enqueue. sync_link_state decides whether they fire at
// all, which is why `linked` is a knob.
function fixture(t, options = {}) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec(SEED);
  raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) ' +
    "VALUES(1,'grower','hash',?,?,?,'admin')"
  ).run(NOW, NOW, ACTOR);
  if (options.linked !== false) {
    raw.prepare(
      'INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) ' +
      "VALUES('cloud',1,?,?)"
    ).run(GATEWAY, NOW);
  }
  raw.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) ' +
    'VALUES(1,?,1,?,?,3,?,?)'
  ).run('Old zone', ZONE_UUID, GATEWAY, NOW, NOW);
  raw.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) ' +
    "VALUES(?,?,'DRAGINO_LSN50',1,1,?,5,?,?)"
  ).run(DEVICE, 'Old device', GATEWAY, NOW, NOW);
  // The zone INSERT trigger enqueues its own ZONE_UPSERTED. Clear it so every
  // count below is about the rename under test.
  raw.exec('DELETE FROM sync_outbox');

  // Exactly the shape osi-db-helper's createTransactionScope hands a writer:
  // get / run / all / exec, and no transaction method.
  const scope = {
    get: async (sql, params = []) => raw.prepare(sql).get(...params),
    all: async (sql, params = []) => raw.prepare(sql).all(...params),
    run: async (sql, params = []) => { raw.prepare(sql).run(...params); },
    exec: async (sql) => { raw.exec(sql); },
  };
  const db = Object.assign({}, scope, {
    transaction: async (executor) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const value = await executor(scope);
        raw.exec('COMMIT');
        return value;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  });
  return { raw, db, scope };
}

function outbox(raw) {
  return raw.prepare(
    'SELECT aggregate_type, aggregate_key, op, payload_json, sync_version FROM sync_outbox ORDER BY rowid'
  ).all();
}

test('renaming a zone writes the row once and enqueues one ZONE_UPSERTED', async (t) => {
  const { raw, db } = fixture(t);
  const before = Date.now();
  const result = await entityName.renameZone(db, { zoneId: 1, name: 'North block' });
  assert.deepEqual(
    {
      changed: result.changed,
      id: result.id,
      zone_uuid: result.zone_uuid,
      name: result.name,
      sync_version: result.sync_version,
    },
    { changed: true, id: 1, zone_uuid: ZONE_UUID, name: 'North block', sync_version: 4 }
  );
  const row = raw.prepare('SELECT name, sync_version, updated_at FROM irrigation_zones WHERE id=1').get();
  assert.equal(row.name, 'North block');
  assert.equal(row.sync_version, 4);
  assert.ok(Date.parse(row.updated_at) >= before - 1000, 'updated_at must be refreshed');
  const events = outbox(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'ZONE_UPSERTED');
  assert.equal(events[0].aggregate_type, 'ZONE');
  assert.equal(events[0].aggregate_key, ZONE_UUID);
  assert.equal(events[0].sync_version, 4);
  assert.equal(JSON.parse(events[0].payload_json).name, 'North block');
});

test('renaming a zone by uuid reaches the same row', async (t) => {
  const { raw, db } = fixture(t);
  const result = await entityName.renameZone(db, { zoneUuid: ZONE_UUID.toUpperCase(), name: 'Bloc nord' });
  assert.equal(result.changed, true);
  assert.equal(result.id, 1);
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Bloc nord');
});

test('renaming a device writes the row once and enqueues one DEVICE_FLAGS_UPDATED', async (t) => {
  const { raw, db } = fixture(t);
  const result = await entityName.renameDevice(db, { deveui: DEVICE, name: 'Probe 7' });
  assert.deepEqual(result, { changed: true, deveui: DEVICE, name: 'Probe 7', sync_version: 6 });
  assert.equal(raw.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(DEVICE).sync_version, 6);
  const events = outbox(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'DEVICE_FLAGS_UPDATED');
  assert.equal(events[0].aggregate_type, 'DEVICE');
  assert.equal(events[0].aggregate_key, DEVICE);
  assert.equal(JSON.parse(events[0].payload_json).name, 'Probe 7');
});

test('an unchanged name writes nothing and enqueues nothing', async (t) => {
  const { raw, db } = fixture(t);
  const zone = await entityName.renameZone(db, { zoneId: 1, name: 'Old zone' });
  const device = await entityName.renameDevice(db, { deveui: DEVICE, name: 'Old device' });
  assert.equal(zone.changed, false);
  assert.equal(zone.sync_version, 3);
  assert.equal(device.changed, false);
  assert.equal(device.sync_version, 5);
  assert.equal(raw.prepare('SELECT sync_version FROM irrigation_zones WHERE id=1').get().sync_version, 3);
  assert.equal(raw.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(DEVICE).sync_version, 5);
  assert.equal(outbox(raw).length, 0);
});

test('an unlinked gateway writes the row and enqueues nothing', async (t) => {
  const { raw, db } = fixture(t, { linked: false });
  await entityName.renameZone(db, { zoneId: 1, name: 'North block' });
  await entityName.renameDevice(db, { deveui: DEVICE, name: 'Probe 7' });
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 7');
  assert.equal(outbox(raw).length, 0);
});

test('a missing row is a 404 not_found', async (t) => {
  const { db } = fixture(t);
  for (const call of [
    () => entityName.renameZone(db, { zoneId: 99, name: 'North block' }),
    () => entityName.renameZone(db, { zoneUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'North block' }),
    () => entityName.renameDevice(db, { deveui: 'AABBCCDDEEFF9999', name: 'Probe 7' }),
  ]) {
    await assert.rejects(call, (error) => error.code === 'not_found' && error.statusCode === 404);
  }
});

test('a deleted row is a 404 not_found', async (t) => {
  const { raw, db } = fixture(t);
  raw.prepare('UPDATE irrigation_zones SET deleted_at=? WHERE id=1').run(NOW);
  raw.prepare('UPDATE devices SET deleted_at=? WHERE deveui=?').run(NOW, DEVICE);
  raw.exec('DELETE FROM sync_outbox');
  await assert.rejects(
    () => entityName.renameZone(db, { zoneId: 1, name: 'North block' }),
    (error) => error.code === 'not_found'
  );
  await assert.rejects(
    () => entityName.renameDevice(db, { deveui: DEVICE, name: 'Probe 7' }),
    (error) => error.code === 'not_found'
  );
});

test('exactly one of zoneId and zoneUuid is required', async (t) => {
  const { db } = fixture(t);
  await assert.rejects(
    () => entityName.renameZone(db, { name: 'North block' }),
    /exactly one of zoneId/
  );
  await assert.rejects(
    () => entityName.renameZone(db, { zoneId: 1, zoneUuid: ZONE_UUID, name: 'North block' }),
    /exactly one of zoneId/
  );
});

test('the in-transaction writers run inside a caller transaction and commit together', async (t) => {
  const { raw, db } = fixture(t);
  const result = await db.transaction(async (tx) => {
    assert.equal(typeof tx.transaction, 'undefined',
      'a transaction scope has no transaction() of its own');
    const zone = await entityName.renameZoneInTransaction(tx, { zoneId: 1, name: 'North block' });
    const device = await entityName.renameDeviceInTransaction(tx, { deveui: DEVICE, name: 'Probe 7' });
    return { zone, device };
  });
  assert.equal(result.zone.sync_version, 4);
  assert.equal(result.device.sync_version, 6);
  const events = outbox(raw);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.op), ['ZONE_UPSERTED', 'DEVICE_FLAGS_UPDATED']);
});

test('a caller rollback undoes the rename and the outbox row', async (t) => {
  const { raw, db } = fixture(t);
  await assert.rejects(
    db.transaction(async (tx) => {
      await entityName.renameZoneInTransaction(tx, { zoneId: 1, name: 'North block' });
      throw new Error('caller changed its mind');
    }),
    /caller changed its mind/
  );
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Old zone');
  assert.equal(outbox(raw).length, 0);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js`

Expected: FAIL, exit 1, with
`TypeError: entityName.renameZone is not a function` on the new tests. The five
Task 1 tests still pass.

- [ ] **Step 3: Write the writers**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js`,
insert this block between `normalizeEntityName` and `module.exports`:

```js
const EUI = /^[0-9A-F]{16}$/;

function notFound(message) {
  const error = new Error(message);
  error.code = 'not_found';
  error.statusCode = 404;
  return error;
}

// Each in-transaction writer reads the row, returns early when the stored name
// already equals the new one, and otherwise writes name, updated_at and
// sync_version in one statement. The outbox triggers read sync_version; they
// never set it, so the writer owns the increment (spec section 2.3).
async function renameZoneInTransaction(tx, args) {
  const byId = args != null && args.zoneId != null;
  const byUuid = args != null && args.zoneUuid != null;
  if (byId === byUuid) {
    throw new Error('renameZone requires exactly one of zoneId / zoneUuid');
  }
  const name = String(args.name);
  const row = byId
    ? await tx.get(
        'SELECT id, zone_uuid, name, sync_version FROM irrigation_zones WHERE id=? AND deleted_at IS NULL LIMIT 1',
        [Number(args.zoneId)]
      )
    : await tx.get(
        'SELECT id, zone_uuid, name, sync_version FROM irrigation_zones WHERE zone_uuid=? AND deleted_at IS NULL LIMIT 1',
        [String(args.zoneUuid).trim().toLowerCase()]
      );
  if (!row) throw notFound('zone not found');
  const current = Number(row.sync_version || 0);
  if (row.name === name) {
    return {
      changed: false,
      id: Number(row.id),
      zone_uuid: row.zone_uuid,
      name: row.name,
      sync_version: current,
    };
  }
  await tx.run(
    'UPDATE irrigation_zones SET name=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE id=?',
    [name, new Date().toISOString(), Number(row.id)]
  );
  return {
    changed: true,
    id: Number(row.id),
    zone_uuid: row.zone_uuid,
    name,
    sync_version: current + 1,
  };
}

async function renameDeviceInTransaction(tx, args) {
  const deveui = String((args && args.deveui) || '').trim().toUpperCase();
  if (!EUI.test(deveui)) {
    throw new Error('renameDevice requires a 16-hex DevEUI');
  }
  const name = String(args.name);
  const row = await tx.get(
    'SELECT deveui, name, sync_version FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1',
    [deveui]
  );
  if (!row) throw notFound('device not found');
  const current = Number(row.sync_version || 0);
  if (row.name === name) {
    return { changed: false, deveui: row.deveui, name: row.name, sync_version: current };
  }
  await tx.run(
    'UPDATE devices SET name=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE deveui=?',
    [name, new Date().toISOString(), deveui]
  );
  return { changed: true, deveui: row.deveui, name, sync_version: current + 1 };
}

function renameZone(db, args) {
  return db.transaction((tx) => renameZoneInTransaction(tx, args));
}

function renameDevice(db, args) {
  return db.transaction((tx) => renameDeviceInTransaction(tx, args));
}
```

Replace the export block with:

```js
module.exports = {
  ENTITY_NAME_MAX: MAX_CODE_POINTS,
  normalizeEntityName,
  renameZoneInTransaction,
  renameDeviceInTransaction,
  renameZone,
  renameDevice,
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js`

Expected: PASS, exit 0, `# fail 0` with fifteen passing tests.

- [ ] **Step 5: Mirror and check parity**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name/index.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.test.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name/index.test.js
node scripts/verify-profile-parity.js
```

Expected: `All parity checks passed.`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name
git commit -m "feat: add zone and device rename writers to osi-entity-name"
```

---

### Task 3: receiver `commands.js` for the two name commands

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.js`
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js` (export `applyNameCommand`)
- Modify: `deploy.sh` (the `osi-entity-name` fetch blocks from Task 1)
- Mirror: all three module files into `conf/full_raspberrypi_bcm27xx_bcm2709/`

**Interfaces:**
- Consumes: `renameZoneInTransaction`, `renameDeviceInTransaction` and
  `normalizeEntityName` from Tasks 1 and 2. From `osi-scope-helper`, read at
  `osi-scope-helper/index.js`: `assertFreshDeviceAccess(db, userUuid, deveui, { scopedMode })`,
  `assertFreshZoneAccess(db, userUuid, zoneUuid, { scopedMode })` and
  `canMutate(role)`. Both assertions throw an `Error` with `.status` and
  `.statusCode` set to 403 for a disabled account and 404 for no access, and
  return the loaded scope, whose `.role` is what `canMutate` takes.
- Produces: `applyNameCommand(db, envelope, runtime)`, exported from
  `commands.js` and re-exported lazily from `index.js`. It returns
  `{ handled: false }` for any command type other than `UPSERT_DEVICE_NAME` and
  `UPSERT_ZONE_NAME`, and otherwise `{ handled: true, ack }` with
  `ack = { commandId, commandType, effectKey: null, gatewayDeviceEui, status,
  result, reason, duplicate, appliedSyncVersion, appliedAt, target, requestedAt }`.
  Task 8's function node publishes `ack` on `devices/<gatewayEui>/command_ack`
  and, after an `APPLIED` device rename, calls Task 4's `updateDeviceName`.

**What the command ledger does with a payload that has no `effect_key`**

Checked in
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js`:

1. `deduplicatePendingCommand(db, envelope, runtime)` opens a transaction and
   first looks the delivery id up in `applied_commands`. A hit returns
   `{ handled: true, ack }` from `persistReplayAck`, which is the exact-replay
   path and is what we want for a redelivered envelope.
2. On a miss it calls `validEffectBinding(envelope, opts)`. `UPSERT_DEVICE_NAME`
   and `UPSERT_ZONE_NAME` are not journal types (`isJournalCommandType` matches
   `JOURNAL` as a word), so it falls through to
   `validNonJournalEffectBinding(envelope, runtime)`.
3. There, `effectKey` resolves to the empty string. None of the three regular
   expressions (`irrigation:scheduler:`, `irrigation:manual:`, `config:`)
   matches it, `isZoneCommandType` lists only `UPSERT_ZONE`, `DELETE_ZONE` and
   `UPSERT_ZONE_LOCATION`, and `scopedBindings` has no entry for either name
   type. The function returns `false`.
4. `deduplicatePendingCommand` then returns `{ handled: false }` immediately,
   before the effect-key duplicate lookup that would otherwise search
   `applied_commands` for `effect_key=''`.

The flow node `command-dedupe-dispatch` (verified by node id in `flows.json`)
sends a `{ handled: false }` message out of output 0, which is the apply chain.
So the ledger neither swallows nor rejects a name command; it passes it on, and
no fix to `osi-command-ledger` is needed. The last two tests below pin that, so
a future edit to `validNonJournalEffectBinding` cannot start swallowing these
commands silently.

- [ ] **Step 1: Write the failing tests**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.test.js`:

```js
'use strict';
// Receiver tests for UPSERT_DEVICE_NAME and UPSERT_ZONE_NAME (design section
// 5.6 and the "Receiver" row of section 10). The database is the real
// seed-blank.sql schema, so applied_commands, command_ack_outbox and the two
// outbox triggers behave exactly as they do on a gateway.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const commands = require('./commands');
const ledger = require('../osi-command-ledger');

const repo = path.resolve(__dirname, '../../../../../../..');
const SEED = fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');

const GATEWAY = '0011223344556677';
const OTHER_GATEWAY = '0011223344556688';
const DEVICE = 'AABBCCDDEEFF0011';
const ZONE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const VIEWER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-09-21T09:00:00.000Z';

function fixture(t) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec(SEED);
  raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) ' +
    "VALUES(1,'grower','hash',?,?,?,'admin')"
  ).run(NOW, NOW, OWNER);
  raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) ' +
    "VALUES(2,'stranger','hash',?,?,?,'admin')"
  ).run(NOW, NOW, STRANGER);
  raw.prepare(
    'INSERT INTO users(id,username,password_hash,created_at,updated_at,user_uuid,role) ' +
    "VALUES(3,'reader','hash',?,?,?,'viewer')"
  ).run(NOW, NOW, VIEWER);
  raw.prepare(
    'INSERT INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) ' +
    "VALUES('cloud',1,?,?)"
  ).run(GATEWAY, NOW);
  raw.prepare(
    'INSERT INTO irrigation_zones(id,name,user_id,zone_uuid,gateway_device_eui,sync_version,created_at,updated_at) ' +
    'VALUES(1,?,1,?,?,3,?,?)'
  ).run('Old zone', ZONE_UUID, GATEWAY, NOW, NOW);
  raw.prepare(
    'INSERT INTO devices(deveui,name,type_id,user_id,irrigation_zone_id,gateway_device_eui,sync_version,created_at,updated_at) ' +
    "VALUES(?,?,'DRAGINO_LSN50',1,1,?,5,?,?)"
  ).run(DEVICE, 'Old device', GATEWAY, NOW, NOW);
  // The viewer is granted the zone so the scoped-mode test isolates canMutate
  // from the access assertion.
  raw.prepare(
    'INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at,updated_at,sync_version) ' +
    'VALUES(?,?,?,?,?,1)'
  ).run('55555555-5555-4555-8555-555555555555', VIEWER, ZONE_UUID, NOW, NOW);
  raw.exec('DELETE FROM sync_outbox');

  const scope = {
    get: async (sql, params = []) => raw.prepare(sql).get(...params),
    all: async (sql, params = []) => raw.prepare(sql).all(...params),
    run: async (sql, params = []) => { raw.prepare(sql).run(...params); },
    exec: async (sql) => { raw.exec(sql); },
  };
  const db = Object.assign({}, scope, {
    transaction: async (executor) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const value = await executor(scope);
        raw.exec('COMMIT');
        return value;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  });
  return { raw, db };
}

function deviceCommand(id, overrides = {}) {
  return {
    commandId: id,
    commandType: 'UPSERT_DEVICE_NAME',
    payload: Object.assign({
      command_type: 'UPSERT_DEVICE_NAME',
      command_id: '11111111-1111-4111-8111-' + String(id).padStart(12, '0'),
      gateway_device_eui: GATEWAY,
      device_eui: DEVICE,
      actor_user_uuid: OWNER,
      requested_at: '2026-09-21T10:00:00.000Z',
      values: { name: 'Probe 7' },
    }, overrides),
  };
}

function zoneCommand(id, overrides = {}) {
  return {
    commandId: id,
    commandType: 'UPSERT_ZONE_NAME',
    payload: Object.assign({
      command_type: 'UPSERT_ZONE_NAME',
      command_id: '11111111-1111-4111-8111-' + String(id).padStart(12, '0'),
      gateway_device_eui: GATEWAY,
      zone_uuid: ZONE_UUID,
      actor_user_uuid: OWNER,
      requested_at: '2026-09-21T10:00:00.000Z',
      values: { name: 'North block' },
    }, overrides),
  };
}

// Scoped mode is a runtime flag, never process.env, so these tests behave the
// same whether or not the developer has OSI_SCOPED_ACCESS set.
function runtime(options = {}) {
  return Object.assign({
    gateway_device_eui: GATEWAY,
    scopedMode: false,
    command_type_recognized: true,
  }, options);
}

test('another command type is not handled', async (t) => {
  const { db } = fixture(t);
  assert.deepEqual(
    await commands.applyNameCommand(db, { commandId: 1, commandType: 'REBOOT', payload: {} }, runtime()),
    { handled: false }
  );
});

test('a device rename applies, acknowledges and enqueues one event', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(db, deviceCommand(1), runtime());
  assert.equal(result.handled, true);
  assert.deepEqual(
    {
      commandId: result.ack.commandId,
      commandType: result.ack.commandType,
      effectKey: result.ack.effectKey,
      gatewayDeviceEui: result.ack.gatewayDeviceEui,
      status: result.ack.status,
      result: result.ack.result,
      reason: result.ack.reason,
      duplicate: result.ack.duplicate,
      appliedSyncVersion: result.ack.appliedSyncVersion,
      target: result.ack.target,
      requestedAt: result.ack.requestedAt,
    },
    {
      commandId: 1,
      commandType: 'UPSERT_DEVICE_NAME',
      effectKey: null,
      gatewayDeviceEui: GATEWAY,
      status: 'ACKED',
      result: 'APPLIED',
      reason: null,
      duplicate: false,
      appliedSyncVersion: 6,
      target: DEVICE,
      requestedAt: '2026-09-21T10:00:00.000Z',
    }
  );
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 7');
  assert.equal(raw.prepare('SELECT command_id FROM applied_commands').get().command_id, '1');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox').get().n, 1);
  const events = raw.prepare('SELECT op, payload_json FROM sync_outbox').all();
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'DEVICE_FLAGS_UPDATED');
  assert.equal(JSON.parse(events[0].payload_json).name, 'Probe 7');
});

test('a zone rename applies, acknowledges and enqueues one event', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(db, zoneCommand(2), runtime());
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(result.ack.target, ZONE_UUID);
  assert.equal(result.ack.appliedSyncVersion, 4);
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
  const events = raw.prepare('SELECT op FROM sync_outbox').all();
  assert.deepEqual(events.map((event) => event.op), ['ZONE_UPSERTED']);
});

test('a replayed envelope id returns the stored ack and re-queues it once', async (t) => {
  const { raw, db } = fixture(t);
  const first = await commands.applyNameCommand(db, deviceCommand(3), runtime());
  raw.prepare('UPDATE command_ack_outbox SET delivered_at=?').run(NOW);
  const replay = await commands.applyNameCommand(db, deviceCommand(3), runtime());
  assert.deepEqual(replay.ack, first.ack);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM applied_commands').get().n, 1);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM command_ack_outbox WHERE delivered_at IS NULL').get().n,
    1
  );
  assert.equal(raw.prepare('SELECT sync_version FROM devices WHERE deveui=?').get(DEVICE).sync_version, 6);
});

test('an unchanged name still acknowledges APPLIED and writes no event', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(
    db,
    deviceCommand(4, { values: { name: 'Old device' } }),
    runtime()
  );
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(result.ack.appliedSyncVersion, 5);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
});

test('a malformed payload is rejected permanently', async (t) => {
  const { raw, db } = fixture(t);
  const cases = [
    deviceCommand(10, { command_type: 'UPSERT_ZONE_NAME' }),
    deviceCommand(11, { command_id: 'not-a-uuid' }),
    deviceCommand(12, { actor_user_uuid: 'nope' }),
    deviceCommand(13, { requested_at: '2026-09-21T10:00:00Z' }),
    deviceCommand(14, { device_eui: 'aabb' }),
    deviceCommand(15, { values: { name: 42 } }),
    deviceCommand(16, { values: {} }),
    zoneCommand(17, { zone_uuid: 'nope' }),
  ];
  for (const envelope of cases) {
    const result = await commands.applyNameCommand(db, envelope, runtime());
    assert.equal(result.ack.result, 'REJECTED_PERMANENT', JSON.stringify(result.ack));
    assert.equal(result.ack.status, 'NACKED');
    assert.equal(result.ack.reason, 'malformed_command');
    assert.equal(result.ack.appliedSyncVersion, null);
  }
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Old device');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 0);
});

test('a name that breaks the rule is rejected with its own reason code', async (t) => {
  const { raw, db } = fixture(t);
  const cases = [
    [20, '', 'name_empty'],
    [21, 'a'.repeat(101), 'name_too_long'],
    [22, 'Row\t7', 'name_control_characters'],
    [23, '\ud83c', 'name_invalid_unicode'],
  ];
  for (const [id, name, reason] of cases) {
    const result = await commands.applyNameCommand(db, deviceCommand(id, { values: { name } }), runtime());
    assert.equal(result.ack.result, 'REJECTED_PERMANENT');
    assert.equal(result.ack.reason, reason);
  }
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Old device');
});

test('a name with surrounding whitespace is stored trimmed', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(
    db,
    deviceCommand(24, { values: { name: '\u00a0Probe 7\u00a0' } }),
    runtime()
  );
  assert.equal(result.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 7');
});

test('a command addressed to another gateway is rejected', async (t) => {
  const { db } = fixture(t);
  const result = await commands.applyNameCommand(
    db,
    deviceCommand(30, { gateway_device_eui: OTHER_GATEWAY }),
    runtime()
  );
  assert.equal(result.ack.result, 'REJECTED_PERMANENT');
  assert.equal(result.ack.reason, 'gateway_mismatch');
});

test('a row bound to another gateway is rejected', async (t) => {
  const { raw, db } = fixture(t);
  raw.prepare('UPDATE devices SET gateway_device_eui=? WHERE deveui=?').run(OTHER_GATEWAY, DEVICE);
  raw.prepare('UPDATE irrigation_zones SET gateway_device_eui=? WHERE id=1').run(OTHER_GATEWAY);
  raw.exec('DELETE FROM sync_outbox');
  const device = await commands.applyNameCommand(db, deviceCommand(31), runtime());
  const zone = await commands.applyNameCommand(db, zoneCommand(32), runtime());
  assert.equal(device.ack.reason, 'gateway_mismatch');
  assert.equal(zone.ack.reason, 'gateway_mismatch');
});

test('an unknown or deleted target is rejected as not_found', async (t) => {
  const { raw, db } = fixture(t);
  const unknownDevice = await commands.applyNameCommand(
    db, deviceCommand(33, { device_eui: 'AABBCCDDEEFF9999' }), runtime()
  );
  const unknownZone = await commands.applyNameCommand(
    db, zoneCommand(34, { zone_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), runtime()
  );
  assert.equal(unknownDevice.ack.reason, 'not_found');
  assert.equal(unknownZone.ack.reason, 'not_found');
  raw.prepare('UPDATE devices SET deleted_at=? WHERE deveui=?').run(NOW, DEVICE);
  const deleted = await commands.applyNameCommand(db, deviceCommand(35), runtime());
  assert.equal(deleted.ack.reason, 'not_found');
});

test('a disabled or missing actor is rejected', async (t) => {
  const { raw, db } = fixture(t);
  const missing = await commands.applyNameCommand(
    db, deviceCommand(36, { actor_user_uuid: '66666666-6666-4666-8666-666666666666' }), runtime()
  );
  assert.equal(missing.ack.reason, 'actor_missing_or_disabled');
  raw.prepare('UPDATE users SET disabled_at=? WHERE user_uuid=?').run(NOW, OWNER);
  const disabled = await commands.applyNameCommand(db, deviceCommand(37), runtime());
  assert.equal(disabled.ack.reason, 'actor_missing_or_disabled');
});

test('with scoped access off, a non-owner and an unclaimed device are refused', async (t) => {
  const { raw, db } = fixture(t);
  const stranger = await commands.applyNameCommand(
    db, deviceCommand(40, { actor_user_uuid: STRANGER }), runtime()
  );
  assert.equal(stranger.ack.reason, 'forbidden');
  const strangerZone = await commands.applyNameCommand(
    db, zoneCommand(41, { actor_user_uuid: STRANGER }), runtime()
  );
  assert.equal(strangerZone.ack.reason, 'forbidden');
  raw.prepare('UPDATE devices SET user_id=NULL WHERE deveui=?').run(DEVICE);
  raw.exec('DELETE FROM sync_outbox');
  const unclaimed = await commands.applyNameCommand(db, deviceCommand(42), runtime());
  assert.equal(unclaimed.ack.reason, 'forbidden');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Old device');
});

test('with scoped access on, an actor without access is refused and the owner is not', async (t) => {
  const { raw, db } = fixture(t);
  const forged = await commands.applyNameCommand(
    db, deviceCommand(43, { actor_user_uuid: STRANGER }), runtime({ scopedMode: true })
  );
  assert.equal(forged.ack.reason, 'forbidden');
  const forgedZone = await commands.applyNameCommand(
    db, zoneCommand(44, { actor_user_uuid: STRANGER }), runtime({ scopedMode: true })
  );
  assert.equal(forgedZone.ack.reason, 'forbidden');
  const owner = await commands.applyNameCommand(db, deviceCommand(45), runtime({ scopedMode: true }));
  assert.equal(owner.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 7');
});

test('with scoped access on, a viewer who has the zone still cannot rename it', async (t) => {
  const { raw, db } = fixture(t);
  const result = await commands.applyNameCommand(
    db, zoneCommand(46, { actor_user_uuid: VIEWER }), runtime({ scopedMode: true })
  );
  assert.equal(result.ack.reason, 'forbidden');
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Old zone');
});

test('two renames of one target apply in order', async (t) => {
  const { raw, db } = fixture(t);
  const first = await commands.applyNameCommand(
    db,
    deviceCommand(50, { requested_at: '2026-09-21T10:00:00.000Z', values: { name: 'Probe 7' } }),
    runtime()
  );
  const second = await commands.applyNameCommand(
    db,
    deviceCommand(51, { requested_at: '2026-09-21T10:05:00.000Z', values: { name: 'Probe 8' } }),
    runtime()
  );
  assert.equal(first.ack.result, 'APPLIED');
  assert.equal(second.ack.result, 'APPLIED');
  assert.equal(second.ack.appliedSyncVersion, 7);
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 8');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 2);
});

test('an older command that arrives after a newer one is rejected as superseded', async (t) => {
  const { raw, db } = fixture(t);
  const newer = await commands.applyNameCommand(
    db,
    deviceCommand(52, { requested_at: '2026-09-21T10:05:00.000Z', values: { name: 'Probe 8' } }),
    runtime()
  );
  assert.equal(newer.ack.result, 'APPLIED');
  const older = await commands.applyNameCommand(
    db,
    deviceCommand(53, { requested_at: '2026-09-21T10:00:00.000Z', values: { name: 'Probe 7' } }),
    runtime()
  );
  assert.equal(older.ack.result, 'REJECTED_PERMANENT');
  assert.equal(older.ack.reason, 'superseded');
  assert.equal(raw.prepare('SELECT name FROM devices WHERE deveui=?').get(DEVICE).name, 'Probe 8');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get().n, 1);
});

test('the fence is per target and per command type', async (t) => {
  const { raw, db } = fixture(t);
  await commands.applyNameCommand(
    db, deviceCommand(54, { requested_at: '2026-09-21T10:05:00.000Z' }), runtime()
  );
  // An older zone rename is untouched by a newer device rename.
  const zone = await commands.applyNameCommand(
    db, zoneCommand(55, { requested_at: '2026-09-21T10:00:00.000Z' }), runtime()
  );
  assert.equal(zone.ack.result, 'APPLIED');
  assert.equal(raw.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
});

test('a rejected command does not arm the fence', async (t) => {
  const { db } = fixture(t);
  const rejected = await commands.applyNameCommand(
    db,
    deviceCommand(56, { requested_at: '2026-09-21T10:05:00.000Z', values: { name: 'a'.repeat(101) } }),
    runtime()
  );
  assert.equal(rejected.ack.result, 'REJECTED_PERMANENT');
  const older = await commands.applyNameCommand(
    db, deviceCommand(57, { requested_at: '2026-09-21T10:00:00.000Z' }), runtime()
  );
  assert.equal(older.ack.result, 'APPLIED');
});

test('an invalid delivery envelope throws instead of acknowledging', async (t) => {
  const { db } = fixture(t);
  for (const commandId of [0, -1, 1.5, '1', null]) {
    await assert.rejects(
      () => commands.applyNameCommand(db, { commandId, commandType: 'UPSERT_DEVICE_NAME', payload: {} }, runtime()),
      /invalid protected delivery envelope/
    );
  }
});

test('the command ledger hands a name command without an effect_key to the receiver', async (t) => {
  const { db } = fixture(t);
  for (const envelope of [deviceCommand(60), zoneCommand(61)]) {
    assert.deepEqual(
      await ledger.deduplicatePendingCommand(db, envelope, {
        gateway_device_eui: GATEWAY,
        command_type_recognized: true,
      }),
      { handled: false },
      envelope.commandType + ' must reach the receiver, not be swallowed by the ledger'
    );
  }
});

test('the command ledger still catches an exact delivery replay before the receiver', async (t) => {
  const { db } = fixture(t);
  await commands.applyNameCommand(db, deviceCommand(62), runtime());
  const replay = await ledger.deduplicatePendingCommand(db, deviceCommand(62), {
    gateway_device_eui: GATEWAY,
    command_type_recognized: true,
  });
  assert.equal(replay.handled, true);
  assert.equal(replay.ack.commandId, 62);
  assert.equal(replay.ack.result, 'APPLIED');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.test.js`

Expected: FAIL, exit 1, with `Cannot find module './commands'`.

- [ ] **Step 3: Write the receiver**

Create `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.js`:

```js
'use strict';
// osi-entity-name/commands.js -- the receiver for UPSERT_DEVICE_NAME and
// UPSERT_ZONE_NAME (design section 5.6), modelled on
// osi-installation-location-helper/commands.js: ONE transaction covers the
// replay check, validation, authorization, the supersession fence, the write,
// the applied_commands row and the command_ack_outbox row.
//
// Two identities travel with every command. envelope.commandId is the numeric
// delivery identity: it keys applied_commands and it is the commandId the
// cloud reads back. payload.command_id is a UUID the cloud mints for tracing,
// and nothing here is keyed on it.
//
// These commands carry no effect_key. effect_key binds a physical effect, and
// the ledger treats a repeated key as a replay, so a constant key per target
// would make the second rename of a device look like a duplicate of the first.
const scope = require('../osi-scope-helper');
const index = require('./index');

const TARGETS = {
  UPSERT_DEVICE_NAME: 'device',
  UPSERT_ZONE_NAME: 'zone',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI = /^[0-9A-F]{16}$/;
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NAME_REASONS = new Set([
  'name_empty',
  'name_too_long',
  'name_control_characters',
  'name_invalid_unicode',
]);

// A rejection is a terminal answer the cloud must see, never a crash: it is
// caught below and turned into a REJECTED_PERMANENT acknowledgement.
function rejection(reason, message) {
  const error = new Error(message);
  error.code = 'entity_name_rejected';
  error.reason = reason;
  return error;
}

function canonicalUuid(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function canonicalEui(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

async function queueAck(tx, ack) {
  await tx.run(
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [String(ack.commandId)]
  );
  await tx.run(
    'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES(?,?,?)',
    [String(ack.commandId), JSON.stringify(ack), ack.appliedAt]
  );
}

function parsePayload(type, payload, runtime) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw rejection('malformed_command', 'payload must be an object');
  }
  if (String(payload.command_type || '') !== type) {
    throw rejection('malformed_command', 'payload command_type differs from the envelope');
  }
  if (!UUID.test(canonicalUuid(payload.command_id))) {
    throw rejection('malformed_command', 'command_id must be a canonical UUID');
  }
  const actor = canonicalUuid(payload.actor_user_uuid);
  if (!UUID.test(actor)) {
    throw rejection('malformed_command', 'actor_user_uuid must be a canonical UUID');
  }
  const gateway = canonicalEui(payload.gateway_device_eui);
  if (!EUI.test(gateway)) {
    throw rejection('malformed_command', 'gateway_device_eui must be 16 upper-case hex digits');
  }
  const requestedAt = String(payload.requested_at == null ? '' : payload.requested_at).trim();
  if (!UTC_MS.test(requestedAt) || !Number.isFinite(Date.parse(requestedAt))) {
    throw rejection('malformed_command', 'requested_at must be a UTC timestamp with milliseconds');
  }
  const values = payload.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw rejection('malformed_command', 'values must be an object');
  }
  if (typeof values.name !== 'string') {
    throw rejection('malformed_command', 'values.name must be a string');
  }
  let name;
  try {
    name = index.normalizeEntityName(values.name);
  } catch (error) {
    throw rejection(
      NAME_REASONS.has(error.code) ? error.code : 'malformed_command',
      error.message
    );
  }
  const parsed = { actor, gateway, requestedAt, name };
  if (TARGETS[type] === 'device') {
    parsed.target = canonicalEui(payload.device_eui);
    if (!EUI.test(parsed.target)) {
      throw rejection('malformed_command', 'device_eui must be 16 upper-case hex digits');
    }
  } else {
    parsed.target = canonicalUuid(payload.zone_uuid);
    if (!UUID.test(parsed.target)) {
      throw rejection('malformed_command', 'zone_uuid must be a canonical UUID');
    }
  }
  if (parsed.gateway !== canonicalEui(runtime && runtime.gateway_device_eui)) {
    throw rejection('gateway_mismatch', 'command names another gateway');
  }
  return parsed;
}

async function assertActor(tx, actorUuid) {
  const actor = await tx.get(
    'SELECT id, disabled_at FROM users WHERE user_uuid=? LIMIT 1',
    [actorUuid]
  );
  if (!actor || actor.disabled_at) {
    throw rejection('actor_missing_or_disabled', 'actor account is missing or disabled');
  }
  return actor;
}

// The scope assertions answer 403 for a disabled account and 404 for no
// access. The row's existence was already checked above, so a 404 here means
// the actor may not see the target.
function accessRejection(error) {
  const status = Number(error.statusCode || error.status);
  return status === 403
    ? rejection('actor_missing_or_disabled', error.message)
    : rejection('forbidden', error.message);
}

// One cloud clock orders cloud renames of one target among themselves. A
// rename typed at the gateway is not in applied_commands, so it never fences a
// cloud rename (decision D2). Only an APPLIED row arms the fence; a rejected
// command must not block the retry that follows it.
async function assertNotSuperseded(tx, type, target, requestedAt) {
  const later = await tx.get(
    'SELECT 1 AS hit FROM applied_commands ' +
      "WHERE command_type=? AND result='APPLIED' " +
      "AND json_extract(result_detail,'$.target')=? " +
      "AND json_extract(result_detail,'$.requestedAt')>? LIMIT 1",
    [type, target, requestedAt]
  );
  if (later) {
    throw rejection('superseded', 'a later rename of this target has already been applied');
  }
}

async function authorize(tx, parsed, runtime, kind, rowUserId, zoneUuid) {
  const actor = await assertActor(tx, parsed.actor);
  if (runtime.scopedMode === true) {
    let access;
    try {
      access = kind === 'device'
        ? await scope.assertFreshDeviceAccess(tx, parsed.actor, parsed.target, { scopedMode: true })
        : await scope.assertFreshZoneAccess(tx, parsed.actor, zoneUuid, { scopedMode: true });
    } catch (error) {
      throw accessRejection(error);
    }
    if (!scope.canMutate(access.role)) {
      throw rejection('forbidden', 'actor may not rename this ' + kind);
    }
    return;
  }
  // Scoped access off: the wildcard admin that assertFreshDeviceAccess returns
  // in this mode proves nothing, so ownership is checked directly. A NULL
  // user_id is an unclaimed device and fails here.
  if (rowUserId == null || Number(rowUserId) !== Number(actor.id)) {
    throw rejection('forbidden', 'actor does not own this ' + kind);
  }
}

async function applyDevice(tx, parsed, runtime) {
  const row = await tx.get(
    'SELECT deveui, user_id, gateway_device_eui FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1',
    [parsed.target]
  );
  if (!row) throw rejection('not_found', 'device not found');
  const bound = canonicalEui(row.gateway_device_eui);
  if (bound && bound !== parsed.gateway) {
    throw rejection('gateway_mismatch', 'device belongs to another gateway');
  }
  await authorize(tx, parsed, runtime, 'device', row.user_id, null);
  await assertNotSuperseded(tx, 'UPSERT_DEVICE_NAME', parsed.target, parsed.requestedAt);
  return index.renameDeviceInTransaction(tx, { deveui: parsed.target, name: parsed.name });
}

async function applyZone(tx, parsed, runtime) {
  const row = await tx.get(
    'SELECT id, zone_uuid, user_id, gateway_device_eui FROM irrigation_zones ' +
      'WHERE zone_uuid=? AND deleted_at IS NULL LIMIT 1',
    [parsed.target]
  );
  if (!row) throw rejection('not_found', 'zone not found');
  const bound = canonicalEui(row.gateway_device_eui);
  if (bound && bound !== parsed.gateway) {
    throw rejection('gateway_mismatch', 'zone belongs to another gateway');
  }
  await authorize(tx, parsed, runtime, 'zone', row.user_id, row.zone_uuid);
  await assertNotSuperseded(tx, 'UPSERT_ZONE_NAME', parsed.target, parsed.requestedAt);
  return index.renameZoneInTransaction(tx, { zoneUuid: row.zone_uuid, name: parsed.name });
}

async function applyNameCommand(db, envelope, runtime = {}) {
  const type = String((envelope && envelope.commandType) || '');
  if (!TARGETS[type]) return { handled: false };
  const id = envelope.commandId;
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('invalid protected delivery envelope');
    error.code = 'invalid_entity_name_command';
    throw error;
  }
  const gatewayDeviceEui = canonicalEui(runtime.gateway_device_eui);
  return db.transaction(async (tx) => {
    const previous = await tx.get(
      'SELECT result_detail FROM applied_commands WHERE command_id=?',
      [String(id)]
    );
    if (previous) {
      const stored = JSON.parse(previous.result_detail);
      await queueAck(tx, stored);
      return { handled: true, ack: stored };
    }
    let result = 'APPLIED';
    let reason = null;
    let target = null;
    let requestedAt = null;
    let written = null;
    try {
      const parsed = parsePayload(type, envelope.payload, runtime);
      target = parsed.target;
      requestedAt = parsed.requestedAt;
      written = TARGETS[type] === 'device'
        ? await applyDevice(tx, parsed, runtime)
        : await applyZone(tx, parsed, runtime);
    } catch (error) {
      if (error.code && /SQLITE/.test(error.code)) throw error;
      if (error.code !== 'entity_name_rejected') throw error;
      result = 'REJECTED_PERMANENT';
      reason = error.reason;
    }
    const ack = {
      commandId: id,
      commandType: type,
      effectKey: null,
      gatewayDeviceEui,
      status: result === 'APPLIED' ? 'ACKED' : 'NACKED',
      result,
      reason,
      duplicate: false,
      appliedSyncVersion: written ? written.sync_version : null,
      appliedAt: new Date().toISOString(),
      target,
      requestedAt,
    };
    await tx.run(
      'INSERT INTO applied_commands(' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES(?,?,?,?,?,?,?,?)',
      [
        String(id),
        gatewayDeviceEui || 'UNKNOWN',
        type,
        null,
        ack.appliedAt,
        result,
        JSON.stringify(ack),
        'cloud',
      ]
    );
    await queueAck(tx, ack);
    return { handled: true, ack };
  });
}

module.exports = { applyNameCommand };
```

- [ ] **Step 4: Export the receiver lazily from index.js**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js`,
replace the export block with:

```js
module.exports = {
  ENTITY_NAME_MAX: MAX_CODE_POINTS,
  normalizeEntityName,
  renameZoneInTransaction,
  renameDeviceInTransaction,
  renameZone,
  renameDevice,
  // Lazy: commands.js requires this file back, and a REST handler that only
  // needs the rule must not pull osi-scope-helper in with it.
  applyNameCommand: (...args) => require('./commands').applyNameCommand(...args),
};
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.test.js`

Expected: PASS, exit 0, `# fail 0` with twenty passing tests.

- [ ] **Step 6: Run the module's whole suite**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/*.test.js`

Expected: PASS, exit 0, `# fail 0`. The lazy export must not break the Task 1
and Task 2 tests.

- [ ] **Step 7: Add the commands.js fetch block**

In `deploy.sh`, directly after the `osi-entity-name index.js` block from Task 1,
insert:

```sh
fetch_required "osi-entity-name commands.js" \
    "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.js" \
    "/srv/node-red/osi-entity-name/commands.js"
```

- [ ] **Step 8: Mirror and run the gates**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name/index.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name/commands.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/commands.test.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name/commands.test.js
node scripts/verify-profile-parity.js
node scripts/verify-module-file-deploy-coverage.js
node scripts/verify-helper-registration.js
```

Expected: `All parity checks passed.`;
`OK: all 99 runtime files in deploy.sh-shipped osi-* modules are fetched.`;
`All helper-registration checks passed.` Each exits 0.

- [ ] **Step 9: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-entity-name \
        deploy.sh
git commit -m "feat: apply UPSERT_DEVICE_NAME and UPSERT_ZONE_NAME on the edge"
```

---

### Task 4: ChirpStack device name, bounded at five seconds

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js` (one fixture correction, then twelve new tests)
- Mirror: both files into `conf/full_raspberrypi_bcm27xx_bcm2709/`

**Interfaces:**
- Consumes: nothing from Tasks 1 to 3. The module stays free of a dependency on
  `osi-entity-name`, because the OSI database is the source of truth for the
  label and the value it receives has already passed the rule.
- Produces:
  - `updateDeviceName(client, devEui, readCurrentName)`, a module-level export.
    `readCurrentName` is `async () => string | null`, called at the moment the
    per-DevEUI serialized call actually runs. Returns `'updated'`, `'unchanged'`
    or `'skipped'`, and rejects on a gRPC failure. Task 7 maps `'unchanged'` and
    `'skipped'` both onto the REST field value `skipped`, and a rejection onto
    `failed`.
  - `NAME_UPDATE_DEADLINE_MS = 5000`, exported so a test can pin it. Both RPCs
    of a name update carry `Math.min(NAME_UPDATE_DEADLINE_MS, grpcDeadlineMs())`
    instead of the 20 s default, so a rename waiting behind the call gives up in
    five seconds.
  - `ChirpStackClient.setDeviceName(devEui, name)`, returning `true` when it
    issued an update RPC.
  - `ChirpStackClient.getDevice(devEui, options)`, where `options.deadlineMs`
    shortens that one read. Every existing caller passes nothing and is
    unaffected.
  - `ensureDeviceProvisioned` gains `nameAction` in its result and reconciles
    the name of an existing device from the name it is given.

Why the shorter budget. `grpcDeadlineMs()` returns 20000 by default, which F110
chose so a ChirpStack that accepts the connection and never answers cannot hang
a caller for ever. A rename is a different kind of caller: the REST handler in
Task 7 answers only after this call settles, and the command applier in Task 8
holds its database handle open across it because `readCurrentName` reads through
that handle. Twenty seconds of spinner for a label change is the wrong trade, so
the name update carries its own budget. It is a floor, not a ceiling: an
operator who lowers `OSI_CHIRPSTACK_GRPC_DEADLINE_MS` below 5000 lowers this
call too.

- [ ] **Step 1: Write the failing tests**

In
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`,
change the module require (currently line 13) to pull the new exports in:

```js
const { createClient, updateDeviceName, NAME_UPDATE_DEADLINE_MS } = require('./index');
```

Correct the existing fixture in the test
`ensureDeviceProvisioned reports unchanged when the profile already matches`.
Its stub device carries no name, so name reconciliation would issue a legitimate
update and break the test's `captured.update === undefined` assertion. The call
already asks for `name: 'Vanne 1'`; give the fixture device the same name and
pin the new field. Replace its two body lines:

```js
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', deviceProfileId: 'prof-gen2' }, keys: { nwkKey: 'A'.repeat(32) } });
  const result = await client.ensureDeviceProvisioned({ devEui: '00DEC0DE00000001', appKey: 'A'.repeat(32), applicationId: 'app-1', deviceProfileId: 'prof-gen2', name: 'Vanne 1' });
  assert.equal(result.profileAction, 'unchanged');
  assert.equal(captured.update, undefined);
```

with:

```js
  const client = stubClient(captured, { device: { devEui: '00dec0de00000001', name: 'Vanne 1', deviceProfileId: 'prof-gen2' }, keys: { nwkKey: 'A'.repeat(32) } });
  const result = await client.ensureDeviceProvisioned({ devEui: '00DEC0DE00000001', appKey: 'A'.repeat(32), applicationId: 'app-1', deviceProfileId: 'prof-gen2', name: 'Vanne 1' });
  assert.equal(result.profileAction, 'unchanged');
  assert.equal(result.nameAction, 'unchanged');
  assert.equal(captured.update, undefined);
```

That is a fixture correction, not a weakened guard: the test now also pins
`nameAction === 'unchanged'`.

Then append:

```js

// updateDeviceName keeps one promise chain per DevEUI in module state, so each
// test below uses its own DevEUI and no test can inherit another's queue.
function nameStubClient(captured, fixtures) {
  const client = createClient({ apiUrl: 'http://localhost:8080', apiKey: 'test-key' });
  const device = fixtures.device === null
    ? null
    : buildMinimalDeviceMessage(fixtures.device || { devEui: '00dec0de00000001', name: 'Old' });
  captured.updates = [];
  captured.reads = [];
  captured.deadlines = [];
  client.deviceClient = {
    get: (request, metadata, options, callback) => {
      captured.reads.push('get');
      captured.deadlines.push(options.deadline.getTime() - Date.now());
      if (!device) return callback(notFoundError());
      callback(null, { getDevice: () => device });
    },
    update: (request, metadata, options, callback) => {
      const name = request.getDevice().getName();
      captured.updates.push(name);
      captured.deadlines.push(options.deadline.getTime() - Date.now());
      if (fixtures.updateFails) return callback(Object.assign(new Error('boom'), { code: 13 }));
      const delay = fixtures.updateDelayMs ? fixtures.updateDelayMs(name) : 0;
      setTimeout(() => callback(null, {}), delay);
    },
  };
  return client;
}

test('updateDeviceName sends the database name when ChirpStack disagrees', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000101', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000101', async () => 'Probe 7'), 'updated');
  assert.deepEqual(captured.updates, ['Probe 7']);
});

test('updateDeviceName sends nothing when the names already match', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000102', name: 'Probe 7' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000102', async () => 'Probe 7'), 'unchanged');
  assert.deepEqual(captured.updates, []);
});

test('updateDeviceName skips when the database has no name to send', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000103', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000103', async () => null), 'skipped');
  assert.deepEqual(captured.reads, [], 'a null name must not cost a gRPC round trip');
  assert.deepEqual(captured.updates, []);
});

test('updateDeviceName skips a device ChirpStack does not have', async () => {
  const captured = {};
  const client = nameStubClient(captured, { device: null });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000104', async () => 'Probe 7'), 'skipped');
  assert.deepEqual(captured.updates, []);
});

test('updateDeviceName rejects on a gRPC failure so the caller can report "failed"', async () => {
  const captured = {};
  const client = nameStubClient(captured, {
    device: { devEui: '00dec0de00000105', name: 'Old' },
    updateFails: true,
  });
  await assert.rejects(
    updateDeviceName(client, '00DEC0DE00000105', async () => 'Probe 7'),
    (error) => error.step === 'updateDeviceName'
  );
});

test('two renames whose gRPC calls finish in reverse order end on the newer name', async () => {
  const captured = {};
  const client = nameStubClient(captured, {
    device: { devEui: '00dec0de00000106', name: 'Old' },
    // The first update is the slow one. Without per-DevEUI serialization the
    // second would land first and the first would overwrite it.
    updateDelayMs: (name) => (name === 'Probe 7' ? 60 : 0),
  });
  const reads = [];
  const first = updateDeviceName(client, '00DEC0DE00000106', async () => {
    reads.push('first');
    return 'Probe 7';
  });
  const second = updateDeviceName(client, '00DEC0DE00000106', async () => {
    reads.push('second');
    return 'Probe 8';
  });
  assert.deepEqual(await Promise.all([first, second]), ['updated', 'updated']);
  assert.deepEqual(captured.updates, ['Probe 7', 'Probe 8'], 'the newer name must be sent last');
  assert.deepEqual(reads, ['first', 'second'], 'the second read happens after the first call settles');
});

test('a failed rename does not block the next rename of the same device', async () => {
  const captured = {};
  const failing = nameStubClient(captured, {
    device: { devEui: '00dec0de00000107', name: 'Old' },
    updateFails: true,
  });
  await assert.rejects(updateDeviceName(failing, '00DEC0DE00000107', async () => 'Probe 7'));
  const recovered = {};
  const client = nameStubClient(recovered, { device: { devEui: '00dec0de00000107', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000107', async () => 'Probe 8'), 'updated');
  assert.deepEqual(recovered.updates, ['Probe 8']);
});

// F110 bounded the whole client at 20 s. A rename waits behind this call, so
// both of its RPCs carry the shorter name-update budget instead.
test('both name-update RPCs carry the five-second budget, not the twenty-second default', async () => {
  assert.equal(NAME_UPDATE_DEADLINE_MS, 5000);
  const captured = {};
  const client = nameStubClient(captured, { device: { devEui: '00dec0de00000110', name: 'Old' } });
  assert.equal(await updateDeviceName(client, '00DEC0DE00000110', async () => 'Probe 7'), 'updated');
  assert.equal(captured.deadlines.length, 2, 'the read and the update each carry a deadline');
  for (const budgetMs of captured.deadlines) {
    assert.ok(budgetMs > 4000 && budgetMs <= 5000, `name-update budget was ${budgetMs} ms`);
  }
});

test('a longer operator deadline does not lengthen the name update', async () => {
  const previous = process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
  process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = '60000';
  try {
    const captured = {};
    const client = nameStubClient(captured, { device: { devEui: '00dec0de00000111', name: 'Old' } });
    await updateDeviceName(client, '00DEC0DE00000111', async () => 'Probe 7');
    for (const budgetMs of captured.deadlines) {
      assert.ok(budgetMs > 4000 && budgetMs <= 5000, `name-update budget was ${budgetMs} ms`);
    }
  } finally {
    if (previous === undefined) delete process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
    else process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = previous;
  }
});

// The budget is injected through the existing setting so this test finishes in
// under a second while driving the same code path a five-second wait would.
// The fixture is the one the F110 deadline test uses: a socket that accepts the
// connection and says nothing.
test('a ChirpStack that never answers ends the name update at its deadline, not in a hang', async (t) => {
  const net = require('node:net');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const port = server.address().port;

  const previous = process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
  process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = '400';
  t.after(() => {
    if (previous === undefined) delete process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS;
    else process.env.OSI_CHIRPSTACK_GRPC_DEADLINE_MS = previous;
  });

  const client = createClient({ apiUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' });
  const started = Date.now();
  const outcome = await Promise.race([
    updateDeviceName(client, '00DEC0DE00000112', async () => 'Probe 7').then(() => 'resolved', (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('still pending after 5 s'), 5000))
  ]);
  if (client.deviceClient && typeof client.deviceClient.close === 'function') client.deviceClient.close();

  assert.ok(outcome instanceof Error, `expected a rejection, got: ${outcome}`);
  assert.equal(outcome.grpcStatus, 'DEADLINE_EXCEEDED');
  assert.ok(Date.now() - started < 4000, 'must give up close to the injected deadline');
});

test('ensureDeviceProvisioned reconciles an existing device name from the value it is given', async () => {
  const captured = {};
  const client = stubClient(captured, {
    device: { devEui: '00dec0de00000108', name: 'Stale label', deviceProfileId: 'prof-gen2' },
    keys: { nwkKey: 'A'.repeat(32) },
  });
  const result = await client.ensureDeviceProvisioned({
    devEui: '00DEC0DE00000108',
    appKey: 'A'.repeat(32),
    applicationId: 'app-1',
    deviceProfileId: 'prof-gen2',
    name: 'Probe 7',
  });
  assert.equal(result.nameAction, 'updated');
  assert.equal(result.profileAction, 'unchanged');
  assert.equal(captured.update.device.name, 'Probe 7');
});

test('ensureDeviceProvisioned leaves a created device alone: createDevice already set its name', async () => {
  const captured = {};
  const client = stubClient(captured, { device: null, keys: null });
  const result = await client.ensureDeviceProvisioned({
    devEui: '00DEC0DE00000109',
    appKey: 'A'.repeat(32),
    applicationId: 'app-1',
    deviceProfileId: 'prof-gen2',
    name: 'Probe 7',
  });
  assert.equal(result.deviceCreated, true);
  assert.equal(result.nameAction, 'unchanged');
  assert.equal(captured.create.device.name, 'Probe 7');
  assert.equal(captured.update, undefined);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`

Expected: FAIL, exit 1. `TypeError: updateDeviceName is not a function` on the
nine `updateDeviceName` tests, `NAME_UPDATE_DEADLINE_MS` reading `undefined` in
the budget test, and `undefined` `nameAction` on the three
`ensureDeviceProvisioned` tests.

- [ ] **Step 3: Add the name-update deadline**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js`,
insert the constant directly above `function grpcDeadlineMs()` (currently line 116):

```js
// A rename waits behind this call: the REST handler answers only once it settles,
// and the command applier holds its database handle open across it. Twenty seconds
// of a restarting ChirpStack is too long for a label change, so the name update
// carries its own budget. It never exceeds the general setting, so lowering
// OSI_CHIRPSTACK_GRPC_DEADLINE_MS lowers this one too.
const NAME_UPDATE_DEADLINE_MS = 5000;
```

Then replace the opening of `grpcInvoke` (currently lines 122 to 124):

```js
function grpcInvoke(client, methodName, request, metadata, step) {
  return new Promise((resolve, reject) => {
    const options = { deadline: new Date(Date.now() + grpcDeadlineMs()) };
```

with:

```js
function nameUpdateDeadlineMs() {
  return Math.min(NAME_UPDATE_DEADLINE_MS, grpcDeadlineMs());
}

// deadlineMs is optional: a caller that needs a shorter budget than the general
// setting passes one, and every existing call site keeps grpcDeadlineMs().
function grpcInvoke(client, methodName, request, metadata, step, deadlineMs) {
  return new Promise((resolve, reject) => {
    const requested = Number(deadlineMs);
    const budgetMs = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, grpcDeadlineMs())
      : grpcDeadlineMs();
    const options = { deadline: new Date(Date.now() + budgetMs) };
```

The rest of the function body is unchanged. grpc-js arms the timer from
`options.deadline`, which is why the never-answering-socket test in step 1 needs
no other machinery.

- [ ] **Step 4: Let `getDevice` take the same budget**

A bounded update has to bound its read too, or the read spends the general 20 s
before the update's five even start. In the same file, replace the opening of
`getDevice` (currently lines 209 to 213):

```js
  async getDevice(devEui) {
    const request = new devicePb.GetDeviceRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      const response = await grpcInvoke(this.deviceClient, 'get', request, this.metadata, 'getDevice');
```

with:

```js
  async getDevice(devEui, options) {
    const request = new devicePb.GetDeviceRequest();
    request.setDevEui(normalizeDevEui(devEui));
    try {
      const response = await grpcInvoke(
        this.deviceClient, 'get', request, this.metadata, 'getDevice',
        options && options.deadlineMs
      );
```

The `NOT_FOUND` catch below it is unchanged. Every existing caller passes one
argument and keeps the default budget.

- [ ] **Step 5: Add `setDeviceName` to the client**

In the same file, insert this method directly above `async ensureDeviceProvisioned(input) {`
(currently line 311):

```js
  // Re-reads the device rather than taking a caller's copy: setDeviceProfile
  // may have written to it a moment ago, and an UpdateDeviceRequest replaces
  // the whole message.
  async setDeviceName(devEui, name) {
    const wanted = String(name === null || name === undefined ? '' : name).trim();
    if (!wanted) return false;
    const existing = await this.getDevice(devEui);
    if (!existing) return false;
    if (String(existing.getName() || '') === wanted) return false;
    existing.setName(wanted);
    const request = new devicePb.UpdateDeviceRequest();
    request.setDevice(existing);
    await grpcInvoke(this.deviceClient, 'update', request, this.metadata, 'setDeviceName');
    return true;
  }

```

This one keeps the general deadline. It runs inside provisioning, which nobody
is waiting on with a spinner.

- [ ] **Step 6: Reconcile the name inside `ensureDeviceProvisioned`**

In the same file, add `nameAction` to the declaration block (currently lines 334
to 337):

```js
    let profileAction = 'unchanged';
    let nameAction = 'unchanged';

    try {
```

Replace the `else if` arm of the create-or-reconcile chain (currently lines 357
to 364):

```js
      } else if (String(existingDevice.getDeviceProfileId() || '') !== deviceProfileId) {
        // setDeviceProfile re-fetches the device itself (the price of routing every
        // profile assignment through the single seam); its boolean return is the
        // truth about whether an update RPC was actually issued -- do not assume
        // 'repointed' just because the two getDevice reads disagreed once.
        profileAction = (await this.setDeviceProfile(devEui, deviceProfileId)) ? 'repointed' : 'unchanged';
      }
```

with:

```js
      } else {
        if (String(existingDevice.getDeviceProfileId() || '') !== deviceProfileId) {
          // setDeviceProfile re-fetches the device itself (the price of routing every
          // profile assignment through the single seam); its boolean return is the
          // truth about whether an update RPC was actually issued -- do not assume
          // 'repointed' just because the two getDevice reads disagreed once.
          profileAction = (await this.setDeviceProfile(devEui, deviceProfileId)) ? 'repointed' : 'unchanged';
        }
        // The OSI database owns the label. A rename that could not reach
        // ChirpStack (an outage, a restart) heals at the next provisioning.
        // createDevice above already set the name, so this runs only for a
        // device that was already there.
        nameAction = (await this.setDeviceName(devEui, name)) ? 'updated' : 'unchanged';
      }
```

Add the field to the returned object (currently lines 378 to 384):

```js
        keysAction,
        profileAction,
        nameAction
      };
```

- [ ] **Step 7: Add the serialized `updateDeviceName`**

In the same file, insert this block directly above `function createClient(config) {`:

```js
// One promise chain per DevEUI. Two renames of one device in quick succession
// must end with ChirpStack on the newer name whichever gRPC call is slower, so
// the second call's readCurrentName and its update RPC both wait for the first
// to settle. The chain is dropped once it drains, so the map cannot grow with
// the fleet.
const deviceNameQueues = new Map();

function serializeByDevEui(devEui, task) {
  const previous = deviceNameQueues.get(devEui) || Promise.resolve();
  const scheduled = previous.then(task, task);
  const settled = scheduled.then(() => undefined, () => undefined);
  deviceNameQueues.set(devEui, settled);
  settled.then(() => {
    if (deviceNameQueues.get(devEui) === settled) deviceNameQueues.delete(devEui);
  });
  return scheduled;
}

// readCurrentName reads devices.name from SQLite at the moment this call
// actually runs, never before it is queued: the value that reaches ChirpStack
// is the one the database holds after every earlier rename has committed.
// Both RPCs carry nameUpdateDeadlineMs(), so a ChirpStack that accepts the
// connection and never answers costs the caller five seconds, not twenty.
async function updateDeviceName(client, devEui, readCurrentName) {
  const normalized = normalizeDevEui(devEui);
  if (!/^[0-9A-F]{16}$/.test(normalized)) {
    throw annotateError(new Error('DevEUI is required'), 'updateDeviceName');
  }
  if (typeof readCurrentName !== 'function') {
    throw annotateError(new Error('updateDeviceName requires a readCurrentName function'), 'updateDeviceName');
  }
  return serializeByDevEui(normalized, async () => {
    const stored = await readCurrentName();
    if (stored === null || stored === undefined) return 'skipped';
    const wanted = String(stored);
    const budgetMs = nameUpdateDeadlineMs();
    const device = await client.getDevice(normalized, { deadlineMs: budgetMs });
    if (!device) return 'skipped';
    if (String(device.getName() || '') === wanted) return 'unchanged';
    device.setName(wanted);
    const request = new devicePb.UpdateDeviceRequest();
    request.setDevice(device);
    await grpcInvoke(
      client.deviceClient, 'update', request, client.metadata, 'updateDeviceName', budgetMs
    );
    return 'updated';
  });
}

```

Add the two exports to `module.exports`:

```js
module.exports = {
  createClient,
  createProvisioningClientFromEnv,
  updateDeviceName,
  NAME_UPDATE_DEADLINE_MS,
  normalizeApiUrl,
  normalizeDevEui,
  normalizeHexKey,
  listItemToObject,
  enums: {
    Region: commonPb.Region,
    MacVersion: commonPb.MacVersion,
    RegParamsRevision: commonPb.RegParamsRevision
  }
};
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/*.test.js`

Expected: PASS, exit 0, `# tests 25`, `# fail 0`: the thirteen tests that were
there before plus the twelve added here. The run takes about six seconds,
because three deadline tests drive a real socket.

- [ ] **Step 9: Mirror and check parity**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.js
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/index.test.js
node scripts/verify-profile-parity.js
```

Expected: `All parity checks passed.`, exit 0.

- [ ] **Step 10: Run the gates this task can break**

```bash
node scripts/verify-sync-flow.js
node scripts/verify-command-safety.js
node --test scripts/test-sdi12-registration.js
```

Expected: exit 0 from each. `getDevice` and `ensureDeviceProvisioned` are on the
device-registration path, and these three are what exercise it.

- [ ] **Step 11: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper
git commit -m "feat: reconcile the ChirpStack device name after a rename

The name update carries its own 5 s gRPC budget instead of the 20 s default,
because a REST handler and a command applier both wait for it to settle."
```

---

### Task 5: the name rule in the versioned `UPSERT_ZONE` applier

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js:748`
- Modify: `scripts/test-zone-command-path.js`
- Mirror: `osi-zone-commands/index.js` into `conf/full_raspberrypi_bcm27xx_bcm2709/`

The command-contract half of this work lives in Task 8, not here.
`scripts/verify-sync-contract.js` requires the `command_type` enum of
`docs/contracts/sync-schema/commands.schema.json` to equal the types in the
`cmd-type-registry` function node exactly, so the schema edit and the registry
edit have to land in one commit. This task holds only what is green on its own.

**Interfaces:**
- Consumes: `normalizeEntityName` from Task 1, required from
  `osi-zone-commands/index.js` as `require('../osi-entity-name')`. That is the
  module-to-module form `osi-installation-location-helper/commands.js` already
  uses for `require('../osi-scope-helper')`; the `osiLib.require` rule applies
  to `flows.json` function nodes, not to one module reaching a sibling.
- Produces: nothing later tasks consume. Spec 5.3 gives this applier the shared
  rule in place of its 128-character bound, so a name the rename route refuses
  can no longer arrive through a versioned `UPSERT_ZONE`.

- [ ] **Step 1: Write the failing tests**

In `scripts/test-zone-command-path.js`, append:

```js
test('the versioned UPSERT_ZONE applier holds zone.name to the shared name rule', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.exec('DELETE FROM sync_outbox');

    const tooLong = await commands.applyZoneCommand(
      db.facade,
      envelope(20, 'UPSERT_ZONE', 1, { name: 'a'.repeat(101) }),
      runtime()
    );
    assert.equal(tooLong.ack.result, 'REJECTED_PERMANENT');
    assert.match(tooLong.ack.reason, /zone\.name/);

    const control = await commands.applyZoneCommand(
      db.facade,
      envelope(21, 'UPSERT_ZONE', 1, { name: 'North\tblock' }),
      runtime()
    );
    assert.equal(control.ack.result, 'REJECTED_PERMANENT');
    assert.match(control.ack.reason, /zone\.name/);

    assert.equal(
      db.raw.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name,
      'North'
    );

    const trimmed = await commands.applyZoneCommand(
      db.facade,
      envelope(22, 'UPSERT_ZONE', 1, { name: '\u00a0Bloc nord\u00a0' }),
      runtime()
    );
    assert.equal(trimmed.ack.result, 'APPLIED');
    assert.equal(
      db.raw.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name,
      'Bloc nord'
    );
  } finally {
    db.raw.close();
  }
});

test('the versioned UPSERT_ZONE applier accepts a 100-code-point name', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.exec('DELETE FROM sync_outbox');
    const seedlings = '\ud83c\udf31'.repeat(100);
    const applied = await commands.applyZoneCommand(
      db.facade,
      envelope(23, 'UPSERT_ZONE', 1, { name: seedlings }),
      runtime()
    );
    assert.equal(applied.ack.result, 'APPLIED');
    assert.equal(
      db.raw.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name,
      seedlings
    );
  } finally {
    db.raw.close();
  }
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test scripts/test-zone-command-path.js`

Expected: FAIL, exit 1. The 101-character name is accepted today because the
applier's bound is 128 characters, so `tooLong.ack.result` is `APPLIED`; the tab
and the non-breaking spaces survive `requiredText`, which uses `String.trim()`.

- [ ] **Step 3: Put the name rule into the zone applier**

In `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js`,
add the require directly under the existing header block, before the first
`function`:

```js
const entityName = require('../osi-entity-name');
```

Replace line 748:

```js
    result.name = requiredText(zone.name, 'zone.name', 128);
```

with:

```js
    // One name rule for create and for rename, on both sides (decision D4).
    // classify() turns malformed_command into a REJECTED_PERMANENT ack, so a
    // bad name ends as a visible rejection and never as a silent truncation.
    try {
      result.name = entityName.normalizeEntityName(zone.name);
    } catch (error) {
      throw commandError('malformed_command', 'zone.name is invalid: ' + error.code);
    }
```

A `zone` object with no `name` key now reaches `normalizeEntityName(undefined)`,
which throws `name_empty` (Task 1), so the rejection reason reads
`zone.name is invalid: name_empty`. The `/zone\.name/` assertion in step 1
covers every one of the four codes without pinning which.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test scripts/test-zone-command-path.js
node --test scripts/test-terra-selection-edge-acceptance.js
```

Expected: `# fail 0` and exit 0 for both. The second run proves the Terra
`UPSERT_ZONE_CONFIG` path, which shares the module's serialization queue, is
unaffected.

- [ ] **Step 5: Mirror and run the surrounding gates**

```bash
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js \
   conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-commands/index.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-communication-contract.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/*.test.js
```

Expected: `All parity checks passed.`; exit 0 from `verify-sync-contract.js`,
which this task leaves untouched because it adds no command type;
`PASS: contract schema checks pass`; exit 0 from
`verify-communication-contract.js`; `# fail 0` from the module suite.

- [ ] **Step 6: Commit**

```bash
git add scripts/test-zone-command-path.js \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-commands/index.js
git commit -m "fix(zones): hold the versioned UPSERT_ZONE name to the shared name rule"
```

---

### Task 6: Route `PUT /api/irrigation-zones/:id/name`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (adds nodes `zone-rename-http`, `zone-rename-scope-guard`, `zone-rename-fn`, `zone-rename-resp`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (mirror)
- Create: `scripts/test-zone-rename-route.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `.github/workflows/verify-sync-flow.yml`

**Interfaces:**
- Consumes (Tasks 1 and 2, module `osi-entity-name`, registered in `osi-lib/index.js` as `entity-name`):
  `normalizeEntityName(raw) -> string`, throwing `Error` with `.code` in
  `name_empty` | `name_too_long` | `name_control_characters` | `name_invalid_unicode`;
  `renameZone(db, { zoneId: number, name: string }) -> { changed, id, zone_uuid, name, sync_version }`,
  throwing `Error` with `.code === 'not_found'` and `.statusCode === 404`.
- Consumes (in tree today): `osi-scope-helper` via `osiLib.require('scope')` —
  `verifyBearer`, `assertFreshRole`, `canMutate`, `assertFreshZoneAccess`;
  `osi-db-helper` via the `osiDb` libs binding.
- Produces: HTTP route `PUT /api/irrigation-zones/:id/name`, body `{ "name": string }`,
  `200 { id, zone_uuid, name, sync_version, changed }`,
  `400 { message, reason }`, `401 { message }`, `403 { message }`, `404 { message }`.
  Node ids `zone-rename-http`, `zone-rename-scope-guard`, `zone-rename-fn`,
  `zone-rename-resp`. No later task references them by id; Task 13 reaches the
  route through `irrigationZonesAPI.rename`.

Design note for the implementer: the existing `PUT /api/irrigation-zones/:zone_id/config`
chain hangs off the shared five-output `scoped-zone-config-guard`. This task does
**not** extend that guard. `.claude/skills/osi-flows-json-editing/SKILL.md`
("Placement: additive over teeing") prefers a self-contained chain, and growing a
shared guard would also have to buy a `node_allowances` entry for it in the size
ratchet. The new guard is a one-route copy of `scoped-zone-config-guard`'s body.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-zone-rename-route.js`:

```js
#!/usr/bin/env node
'use strict';

// Behavioural test for PUT /api/irrigation-zones/:id/name (nodes
// zone-rename-scope-guard + zone-rename-fn in the canonical flows.json).
// Runs the shipped function-node source through the flow-node harness in
// scripts/lib/scoped-access-harness.js, the same harness that covers the
// sibling zone writes in scripts/test-zone-timezone-route.js.
//
// Run: node --test scripts/test-zone-rename-route.js

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const AUTH_SECRET = 'zone-rename-route-test-secret';
const FLAG_OFF = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
const FLAG_ON = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1' };
const OWNER = { userId: 2, username: 'res1' };      // owns zone id 1 ('Z One')
const STRANGER = { userId: 1, username: 'admin1' }; // owns zone id 2
const VIEWER = { userId: 3, username: 'view1' };    // granted zone 1, cannot mutate

function renameRequest({ zoneId = 1, name, authorization }) {
  return {
    req: {
      method: 'PUT',
      path: '/api/irrigation-zones/' + zoneId + '/name',
      headers: authorization === undefined ? {} : { authorization },
      params: { id: String(zoneId) },
      body: name === undefined ? {} : { name },
    },
  };
}

function token(identity) {
  return makeAuthHeader({ userId: identity.userId, username: identity.username, secret: AUTH_SECRET });
}

function linkCloud(db) {
  db.exec("INSERT OR REPLACE INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) "
    + "VALUES ('cloud', 1, '0016C001F11715E2', datetime('now'))");
}

async function callRoute(db, env, options) {
  const guard = await executeFunction(loadNode('zone-rename-scope-guard'), {
    msg: renameRequest(options),
    env,
    db,
  });
  if (guard.result[1]) return { stage: 'guard', result: guard.result[1], warnings: guard.warnings };
  const handler = await executeFunction(loadNode('zone-rename-fn'), {
    msg: guard.result[0],
    env,
    db,
  });
  return { stage: 'handler', result: handler.result, warnings: handler.warnings };
}

test('flag-off: the owner renames the zone, one sync_version bump, one outbox row', async () => {
  const db = seedScopedDb();
  linkCloud(db);
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: '  North block \n', authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.name, 'North block');
    assert.equal(result.payload.changed, true);
    assert.equal(result.payload.zone_uuid, 'z-1');
    assert.equal(result.payload.id, 1);
    const row = db.prepare('SELECT name, sync_version FROM irrigation_zones WHERE id=1').get();
    assert.equal(row.name, 'North block');
    assert.equal(Number(row.sync_version), Number(result.payload.sync_version));
    const events = db.prepare("SELECT op, payload_json FROM sync_outbox WHERE aggregate_type='ZONE'").all();
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'ZONE_UPSERTED');
    assert.equal(JSON.parse(events[0].payload_json).name, 'North block');
  } finally {
    db.close();
  }
});

test('flag-off: an unchanged name writes nothing and emits no event', async () => {
  const db = seedScopedDb();
  linkCloud(db);
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Z One', authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.changed, false);
    assert.equal(db.prepare("SELECT count(*) n FROM sync_outbox WHERE aggregate_type='ZONE'").get().n, 0);
    assert.equal(db.prepare('SELECT sync_version FROM irrigation_zones WHERE id=1').get().sync_version, 0);
  } finally {
    db.close();
  }
});

test('flag-off: a stranger gets 404, never 403, and the zone keeps its name', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Taken', authorization: token(STRANGER) });
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
  } finally {
    db.close();
  }
});

test('no Authorization header answers 401', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Anything', authorization: undefined });
    assert.equal(result.statusCode, 401, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

test('a shaped but unsigned bearer token answers 401', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Anything', authorization: 'Bearer not-real.also-not-real' });
    assert.equal(result.statusCode, 401, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of [
  ['empty', '', 'name_empty'],
  ['blank', '   ', 'name_empty'],
  ['control character', 'Row\t7', 'name_control_characters'],
  ['over-long', 'a'.repeat(101), 'name_too_long'],
  ['lone surrogate', '\ud83c', 'name_invalid_unicode'],
]) {
  test('flag-off: a ' + label + ' name is 400 with reason ' + reason, async () => {
    const db = seedScopedDb();
    try {
      const { result } = await callRoute(db, FLAG_OFF, { name: value, authorization: token(OWNER) });
      assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
      assert.equal(result.payload.reason, reason);
      assert.equal(typeof result.payload.message, 'string');
      assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
    } finally {
      db.close();
    }
  });
}

test('flag-off: a body with no name field is 400 with reason name_empty', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: undefined, authorization: token(OWNER) });
    assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
    assert.equal(result.payload.reason, 'name_empty');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
  } finally {
    db.close();
  }
});

test('scoped: a granted researcher renames a zone owned by someone else', async () => {
  const db = seedScopedDb();
  try {
    // res1 (u-res1) holds grant g-3 on z-2, which admin1 owns.
    const { result } = await callRoute(db, FLAG_ON, { zoneId: 2, name: 'Granted block', authorization: token(OWNER) });
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=2').get().name, 'Granted block');
  } finally {
    db.close();
  }
});

test('scoped: a viewer is refused 403 before any write', async () => {
  const db = seedScopedDb();
  try {
    const { stage, result } = await callRoute(db, FLAG_ON, { name: 'Viewer edit', authorization: token(VIEWER) });
    assert.equal(stage, 'guard');
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(result.payload.message, 'Forbidden');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Z One');
  } finally {
    db.close();
  }
});

test('scoped: a zone the actor has no access to is refused without a write', async () => {
  const db = seedScopedDb();
  try {
    // view1 has no grant on z-2 and does not own it.
    const { stage, result } = await callRoute(db, FLAG_ON, { zoneId: 2, name: 'Nope', authorization: token(VIEWER) });
    assert.equal(stage, 'guard');
    assert.ok(result.statusCode === 403 || result.statusCode === 404, String(result.statusCode));
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=2').get().name, 'Z Two');
  } finally {
    db.close();
  }
});

test('a deleted zone answers 404', async () => {
  const db = seedScopedDb();
  try {
    db.exec("UPDATE irrigation_zones SET deleted_at='2026-09-20T00:00:00Z' WHERE id=1");
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Gone', authorization: token(OWNER) });
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Run the test and watch it fail for the stated reason**

```bash
node --test scripts/test-zone-rename-route.js
```

Expected: every test fails with `Error: node not found: zone-rename-scope-guard`
thrown from `loadNode`, and a final `# fail 15` line.

- [ ] **Step 3: Add the four nodes to both flows.json profiles**

Save this as `$SCRATCH/task6-flows-edit.js` (scratchpad, never in the repo) and
run it with `node` from the repository root.

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
const serialize = (flows) => Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8');

function guard(file) {
  const original = fs.readFileSync(file);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) {
    throw new Error('roundtrip guard failed for ' + file + ': STOP, formatting has drifted');
  }
  console.log('byte-identical: true (' + original.length + ' / ' + original.length + ') ' + file);
  return parsed;
}

const flows = guard(CANONICAL);
guard(MIRROR);

const AUTH_BLOCK = (sourceId) => [
  "function getAuthSecret() {",
  "  const scopedForSecret = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';",
  "  if (scopedForSecret) {",
  "    const scopeLoad = osiLib.require('scope');",
  "    if (!scopeLoad.ok) {",
  "      const error = new Error('Authentication scope helper unavailable');",
  "      error.statusCode = 500;",
  "      throw error;",
  "    }",
  "    return scopeLoad.value.resolveAuthSecret({",
  "      configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),",
  "      fs: global.get('fs'),",
  "      warn: (message) => node.warn(message),",
  "    });",
  "  }",
  "  // Flag-off: this path must never touch osiLib/the scope helper",
  "  // (scripts/verify-auth-flag-off-hermetic.js enforces it).",
  "  const configured = String(env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET') || '').trim();",
  "  if (configured) return configured;",
  "  const fsMod = global.get('fs');",
  "  const secretPaths = ['/data/db/osi_auth_token_secret', '/var/lib/node-red/.node-red/osi_auth_token_secret'];",
  "  if (fsMod) {",
  "    for (const secretPath of secretPaths) {",
  "      try {",
  "        const existing = String(fsMod.readFileSync(secretPath, 'utf8') || '').trim();",
  "        if (existing) return existing;",
  "      } catch (error) {",
  "        if (!error || error.code !== 'ENOENT') {",
  "          node.warn('" + sourceId + " auth secret read failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));",
  "        }",
  "      }",
  "    }",
  "    const generated = crypto.randomBytes(48).toString('hex');",
  "    for (const secretPath of secretPaths) {",
  "      try {",
  "        fsMod.writeFileSync(secretPath, generated + '\\n', { mode: 0o600 });",
  "        return generated;",
  "      } catch (error) {",
  "        node.warn('" + sourceId + " auth secret write failed for ' + secretPath + ': ' + String(error && error.message ? error.message : error));",
  "      }",
  "    }",
  "  }",
  "  const err = new Error('AUTH_TOKEN_SECRET or JWT_SECRET must be configured');",
  "  err.statusCode = 500;",
  "  throw err;",
  "}",
  "function toBase64Url(input) { return Buffer.from(input).toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, ''); }",
  "function fromBase64Url(input) { let value = String(input || '').replace(/-/g, '+').replace(/_/g, '/'); while (value.length % 4) value += '='; return Buffer.from(value, 'base64'); }",
  "function verifyBearer(authHeader) { delete msg._osiAuthFailure;",
  "  if (!authHeader || !authHeader.startsWith('Bearer ')) { const err = new Error('Unauthorized'); err.statusCode = 401; msg._osiAuthFailure = { format: 1, code: 'MISSING_BEARER', sourceId: '" + sourceId + "' }; throw err; }",
  "  const token = authHeader.substring(7).trim();",
  "  const parts = token.split('.');",
  "  if (parts.length !== 2 || !parts[0] || !parts[1]) { const err = new Error('Invalid token'); err.statusCode = 401; msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '" + sourceId + "' }; throw err; }",
  "  const payloadB64 = parts[0];",
  "  const sig = parts[1];",
  "  const expectedSig = toBase64Url(crypto.createHmac('sha256', getAuthSecret()).update(payloadB64).digest());",
  "  const sigBuf = Buffer.from(sig, 'utf8');",
  "  const expectedBuf = Buffer.from(expectedSig, 'utf8');",
  "  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) { const err = new Error('Invalid token'); err.statusCode = 401; msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '" + sourceId + "' }; throw err; }",
  "  let payload;",
  "  try { payload = JSON.parse(fromBase64Url(payloadB64).toString('utf8')); } catch (_) { const err = new Error('Invalid token'); err.statusCode = 401; msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '" + sourceId + "' }; throw err; }",
  "  const userId = Number(payload.userId);",
  "  const username = String(payload.username || '').trim();",
  "  const exp = Number(payload.exp || 0);",
  "  if (!Number.isFinite(userId) || !username) { const err = new Error('Invalid token'); err.statusCode = 401; msg._osiAuthFailure = { format: 1, code: 'INVALID_TOKEN', sourceId: '" + sourceId + "' }; throw err; }",
  "  if (exp && Date.now() > exp) { const err = new Error('Token expired'); err.statusCode = 401; msg._osiAuthFailure = { format: 1, code: 'TOKEN_EXPIRED', sourceId: '" + sourceId + "' }; throw err; }",
  "  return { userId, username };",
  "}",
].join('\n');

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const zoneRenameHttp = {
  id: 'zone-rename-http',
  type: 'http in',
  z: 'device-api-tab',
  name: 'PUT /api/irrigation-zones/:id/name',
  method: 'put',
  url: '/api/irrigation-zones/:id/name',
  x: 200,
  y: 2660,
  wires: [['zone-rename-scope-guard']],
};

const zoneRenameGuard = {
  id: 'zone-rename-scope-guard',
  type: 'function',
  z: 'device-api-tab',
  name: 'Fresh Zone Rename Scope',
  outputs: 2,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'osiLib', module: 'osi-lib' },
    { var: 'osiDb', module: 'osi-db-helper' },
  ],
  x: 460,
  y: 2660,
  wires: [['zone-rename-fn'], ['zone-rename-resp']],
  func: [
    "return (async () => {",
    "const outputs = [null, null];",
    "if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') {",
    "  outputs[0] = msg;",
    "  return outputs;",
    "}",
    "let db;",
    "const closeDb = function() {",
    "  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();",
    "};",
    "try {",
    "  const scopeLoad = osiLib.require('scope');",
    "  if (!scopeLoad.ok) {",
    "    node.error('zone rename scope: module unavailable: ' + scopeLoad.error, msg);",
    "    throw Object.assign(new Error('scope resolver unavailable'), { statusCode: 500 });",
    "  }",
    "  const scope = scopeLoad.value;",
    "  const auth = scope.verifyBearer(",
    "    msg.req && msg.req.headers && msg.req.headers.authorization,",
    "    {",
    "      configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),",
    "      fs: global.get('fs'),",
    "      warn: function(message) { node.warn(message); }",
    "    }",
    "  );",
    "  db = new osiDb.Database('/data/db/farming.db');",
    "  const actor = await db.get(",
    "    'SELECT user_uuid,role FROM users WHERE id=? AND username=? LIMIT 1',",
    "    [auth.userId, auth.username]",
    "  );",
    "  if (!actor || !actor.user_uuid) {",
    "    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });",
    "  }",
    "  const actorScope = await scope.assertFreshRole(db, actor.user_uuid, actor.role, { scopedMode: true });",
    "  if (!scope.canMutate(actorScope.role)) {",
    "    throw Object.assign(new Error('insufficient role'), { statusCode: 403 });",
    "  }",
    "  const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);",
    "  if (!Number.isInteger(zoneId)) {",
    "    throw Object.assign(new Error('Invalid zone ID'), { statusCode: 400 });",
    "  }",
    "  const zone = await db.get(",
    "    'SELECT id,user_id,zone_uuid FROM irrigation_zones WHERE id=? AND deleted_at IS NULL LIMIT 1',",
    "    [zoneId]",
    "  );",
    "  if (!zone || !zone.zone_uuid) {",
    "    throw Object.assign(new Error('zone not found'), { statusCode: 404 });",
    "  }",
    "  await scope.assertFreshZoneAccess(db, actor.user_uuid, zone.zone_uuid, { scopedMode: true });",
    "  msg._scopedZoneWriteAuthorized = true;",
    "  msg._scopedZoneOwnerId = Number(zone.user_id);",
    "  msg.actor_user_uuid = actor.user_uuid;",
    "  outputs[0] = msg;",
    "  return outputs;",
    "} catch (error) {",
    "  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;",
    "  msg.payload = {",
    "    message: msg.statusCode === 404 ? 'Zone not found' :",
    "      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))",
    "  };",
    "  outputs[1] = msg;",
    "  return outputs;",
    "} finally {",
    "  try {",
    "    await closeDb();",
    "  } catch (closeError) {",
    "    node.warn('zone rename scope close: ' + String(closeError && closeError.message ? closeError.message : closeError));",
    "  }",
    "}",
    "})();",
  ].join('\n'),
};

const zoneRenameFn = {
  id: 'zone-rename-fn',
  type: 'function',
  z: 'device-api-tab',
  name: 'Rename Zone',
  outputs: 1,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'crypto', module: 'crypto' },
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiLib', module: 'osi-lib' },
  ],
  x: 720,
  y: 2660,
  wires: [['zone-rename-resp']],
  func: [
    "return (async () => {",
    AUTH_BLOCK('zone-rename-fn'),
    "function respond(statusCode, payload) { msg.statusCode = statusCode; msg.payload = payload; return msg; }",
    "try {",
    "  const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);",
    "  const zoneId = Number(msg.req && msg.req.params && msg.req.params.id);",
    "  if (!Number.isInteger(zoneId)) return respond(400, { message: 'Invalid zone ID' });",
    "  const nameLoad = osiLib.require('entity-name');",
    "  if (!nameLoad.ok) {",
    "    node.error('Zone rename name helper unavailable: ' + nameLoad.error, msg);",
    "    return respond(500, { message: 'Entity name helper unavailable' });",
    "  }",
    "  const body = (msg.req && msg.req.body && typeof msg.req.body === 'object') ? msg.req.body :",
    "    ((msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)) ? msg.payload : {});",
    "  let normalized = '';",
    "  try {",
    "    normalized = nameLoad.value.normalizeEntityName(body.name);",
    "  } catch (nameError) {",
    "    return respond(400, { message: 'Zone name is not valid', reason: String(nameError && nameError.code || 'name_empty') });",
    "  }",
    "  const ownerId = msg._scopedZoneWriteAuthorized ? Number(msg._scopedZoneOwnerId) : Number(auth.userId);",
    "  const db = new osiDb.Database('/data/db/farming.db');",
    "  const close = () => new Promise((resolve) => db.close(() => resolve()));",
    "  try {",
    "    const owned = await db.get(",
    "      'SELECT id FROM irrigation_zones WHERE id=? AND user_id=? AND deleted_at IS NULL LIMIT 1',",
    "      [zoneId, ownerId]",
    "    );",
    "    if (!owned) return respond(404, { message: 'Zone not found' });",
    "    const renamed = await nameLoad.value.renameZone(db, { zoneId: zoneId, name: normalized });",
    "    return respond(200, {",
    "      id: renamed.id,",
    "      zone_uuid: renamed.zone_uuid,",
    "      name: renamed.name,",
    "      sync_version: renamed.sync_version,",
    "      changed: renamed.changed",
    "    });",
    "  } finally {",
    "    try {",
    "      await close();",
    "    } catch (closeError) {",
    "      node.warn('zone rename close: ' + String(closeError && closeError.message ? closeError.message : closeError));",
    "    }",
    "  }",
    "} catch (error) {",
    "  const statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;",
    "  return respond(statusCode, {",
    "    message: statusCode === 404 ? 'Zone not found' : String(error && error.message || error)",
    "  });",
    "}",
    "})();",
  ].join('\n'),
};

const zoneRenameResp = {
  id: 'zone-rename-resp',
  type: 'http response',
  z: 'device-api-tab',
  name: 'Zone Rename Response',
  statusCode: '',
  headers: RESPONSE_HEADERS,
  x: 980,
  y: 2660,
  wires: [],
};

for (const id of ['zone-rename-http', 'zone-rename-scope-guard', 'zone-rename-fn', 'zone-rename-resp']) {
  if (flows.some((n) => n && n.id === id)) throw new Error('node id already exists: ' + id);
}
flows.push(zoneRenameHttp, zoneRenameGuard, zoneRenameFn, zoneRenameResp);

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
console.log('Wrote canonical + mirror. New node count:', flows.length);
guard(CANONICAL);
guard(MIRROR);
```

Expected output: two `byte-identical: true (1847351 / 1847351)` lines, then
`Wrote canonical + mirror. New node count: 730`, then two more
`byte-identical: true` lines at the new size.

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test scripts/test-zone-rename-route.js
```

Expected: `# pass 15`, `# fail 0`, exit 0. If a name-rule test fails with
`normalizeEntityName is not a function`, Task 1 has not landed
yet — stop and sequence the tasks, do not weaken the test.

- [ ] **Step 5: Add the verify-sync-flow assertions**

In `scripts/verify-sync-flow.js`, add `'/api/irrigation-zones/:id/name'` to the
`requiredHttpRoutes` array (immediately after `'/api/irrigation-zones/:id/calibration'`),
and add this block next to the other zone-write assertions, right after the
`zone-calibration-fn` group that ends with the `[zoneId, measuredFlowRateLpm, ...]`
assertion:

```js
expectNodeTypeById('zone-rename-http', 'http in', 'exposes the zone rename route');
expectWireById('zone-rename-http', 'zone-rename-scope-guard', 'routes zone renames through the fresh scope guard');
expectWireById('zone-rename-scope-guard', 'zone-rename-fn', 'passes authorized zone renames to the writer');
expectWireById('zone-rename-scope-guard', 'zone-rename-resp', 'answers refused zone renames on the route response node');
expectWireById('zone-rename-fn', 'zone-rename-resp', 'answers every zone rename on the route response node');
expectLibById('zone-rename-scope-guard', 'osiLib', 'osi-lib', 'loads the scope helper through the osi-lib seam');
expectLibById('zone-rename-fn', 'osiLib', 'osi-lib', 'loads the entity-name helper through the osi-lib seam');
expectOrderedIncludesById('zone-rename-scope-guard', [
  "if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') {",
  "const scopeLoad = osiLib.require('scope');",
  'scope.assertFreshRole(',
  'scope.canMutate(',
  'scope.assertFreshZoneAccess(',
], 'gates the scope helper behind the flag and asserts role before zone access');
expectOrderedIncludesById('zone-rename-fn', [
  'const auth = verifyBearer(',
  "const nameLoad = osiLib.require('entity-name');",
  'nameLoad.value.normalizeEntityName(body.name)',
  'AND user_id=? AND deleted_at IS NULL',
  'nameLoad.value.renameZone(db, { zoneId: zoneId, name: normalized })',
], 'authenticates, normalizes, scopes by owner, then delegates the zone write');
expectIncludesById('zone-rename-fn', 'reason: String(nameError && nameError.code', 'returns the name reason code on a 400');
expectIncludesById('zone-rename-fn', '.close(', 'closes the zone rename database handle');
```

- [ ] **Step 6: Record the size-ratchet entries**

Measure the two new function nodes:

```bash
node -e "
const { nodeSizes, totalChars } = require('./scripts/flows-size-scan');
const f = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const s = nodeSizes(f);
for (const id of ['zone-rename-scope-guard','zone-rename-fn']) console.log(id, s.get(id).chars);
console.log('profile total', totalChars(f));
"
```

`zone-rename-scope-guard` is expected below the 4096-char new-node ceiling and
needs no entry. `zone-rename-fn` carries the inline bearer block and will exceed
it, so add a `new_node_ceilings` entry with the **exact measured number** and the
`total_allowance.delta` raised by `(new profile total) - 1539627`:

```json
    "zone-rename-fn": {
      "max_chars": <exact measured chars>,
      "reason": "Zone/device rename Stage 1, Task 6. PUT /api/irrigation-zones/:id/name handler. Over the 4096-char new-node ceiling because it carries the repo's standard inline getAuthSecret()/verifyBearer() block verbatim (spliced from put-soil-depth-fn with only sourceId substituted), which scripts/verify-auth-flag-off-hermetic.js requires on the OSI_SCOPED_ACCESS-off path: the flag-off route may not resolve osiLib.require('scope'). The rename logic itself is ~40 lines and delegates every write to osi-entity-name through osiLib.require. Measured with verify-flows-size-ratchet's nodeSizes over both byte-identical profiles."
    }
```

and set `total_allowance.delta` from a fresh measurement, with the command in
"Setting a size-ratchet number" near the top of this plan. Do not add this
task's increase to the `41203` already in the file: the ratchet compares each
profile's HEAD total against its `origin/main` total, and five tasks edit this
one number. Give the entry a reason sentence naming this task and the two node
sizes. Re-run:

```bash
node scripts/verify-flows-size-ratchet.js
```

Expected: two `OK conf/...flows.json (total <n>)` lines and
`verify-flows-size-ratchet: OK (HEAD total ... <= origin/main total ...; committed baseline not exceeded)`, exit 0.

- [ ] **Step 7: No osi-lib-binding-audit change, and prove it**

Neither new node belongs in `TASK9_OSI_LIB_NODE_POLICIES`: that policy requires
`libs` to be exactly `[{ var: 'osiLib', module: 'osi-lib' }]` (`hasExactOsiLibOnly`),
and both nodes also bind `osiDb` (and `crypto` in the handler), like their
siblings `scoped-zone-config-guard` and `zone-config-fn`, which are likewise
unpinned. Prove no policy drift:

```bash
node --test scripts/osi-lib-binding-audit.test.js
```

Expected: `# pass 9`, `# fail 0`, exit 0.

- [ ] **Step 8: Wire the new test into CI**

In `.github/workflows/verify-sync-flow.yml`, immediately after the
`Terra zone-config command gates` step, add:

```yaml
      # Rename routes, the entity-name command path and the create/legacy name
      # rule. Each runs the shipped function-node source against an in-memory
      # SQLite fixture through scripts/lib/scoped-access-harness.js.
      - name: Zone and device rename gates
        run: |
          node --test scripts/test-zone-rename-route.js
```

- [ ] **Step 9: Run the flows gate set**

| Gate | Command | Pass signal |
|---|---|---|
| Function-node parse | `node scripts/verify-flows-fn-parse.js` | ends `verify-flows-fn-parse: OK`, exit 0 |
| Output arity | `node scripts/verify-flows-output-arity.js` | ends `verify-flows-output-arity: OK`, exit 0 |
| Wiring guards | `node scripts/test-flows-wiring.js` | ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`, exit 0 |
| Silent catch ratchet | `node scripts/verify-no-new-silent-catch.js` | `verify-no-new-silent-catch: OK`, `87 empty catches ... (baseline 87)` on both profiles, exit 0 |
| Bare require scan | `node scripts/flows-bare-require-scan.js` | no output, exit 0 |
| Size ratchet | `node scripts/verify-flows-size-ratchet.js` | `verify-flows-size-ratchet: OK (...)`, exit 0 |
| Scoped-access ratchet | `node scripts/verify-scoped-access.js` | `verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)`, exit 0 |
| Flag-off hermetic auth | `node scripts/verify-auth-flag-off-hermetic.js` | ends `verify-auth-flag-off-hermetic: OK (...)`, exit 0 |
| Communication contract | `node scripts/verify-communication-contract.js` | ends `Communication contract verification passed`, exit 0 |
| Profile parity | `node scripts/verify-profile-parity.js` | ends `All parity checks passed.`, exit 0 |
| Full sync flow | `node scripts/verify-sync-flow.js` | prints `Sync flow verification passed`, then chains parity and ends `All parity checks passed.`, exit 0 |

Check each command's own exit status; never assert success through a pipe.

- [ ] **Step 10: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-zone-rename-route.js \
        scripts/verify-sync-flow.js \
        scripts/verify-flows-size-ratchet-allowances.json \
        .github/workflows/verify-sync-flow.yml
git commit -m "feat(zones): add PUT /api/irrigation-zones/:id/name"
```

---

### Task 7: Route `PUT /api/devices/:deveui/name`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (adds nodes `device-rename-http`, `device-rename-scope-guard`, `device-rename-fn`, `device-rename-resp`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (mirror)
- Create: `scripts/test-device-rename-route.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `.github/workflows/verify-sync-flow.yml`

**Interfaces:**
- Consumes (Tasks 1, 2 and 4): `normalizeEntityName(raw)` as in Task 6;
  `renameDevice(db, { deveui: string, name: string }) -> { changed, deveui, name, sync_version }`,
  throwing `Error` with `.code === 'not_found'`, `.statusCode === 404`;
  `updateDeviceName(client, devEui, readCurrentName) -> 'updated' | 'unchanged' | 'skipped'`
  from `osiLib.require('chirpstack')`, rejecting on a gRPC failure and carrying
  its own 5 s deadline (`NAME_UPDATE_DEADLINE_MS`) rather than the client's 20 s
  default.
- Consumes (in tree today): `createProvisioningClientFromEnv(env)` from
  `osi-chirpstack-helper`, which **throws synchronously** (`CHIRPSTACK_API_URL is required`
  / `CHIRPSTACK_API_KEY is required`) when provisioning is not configured —
  verified in `osi-chirpstack-helper/index.js`, `normalizeApiUrl` and
  `createMetadata`, both called from the `ChirpStackClient` constructor. That
  throw is the "provisioning not configured" signal; `cs-register-device-fn` and
  `cs-reg-cloud-fn` both call the same factory without a guard, so a gateway with
  no ChirpStack credentials fails their whole registration — this route must not.
- Produces: HTTP route `PUT /api/devices/:deveui/name`, body `{ "name": string }`,
  `200 { deveui, name, sync_version, changed, chirpstack }` with `chirpstack` in
  `updated` | `failed` | `skipped`; `400 { message, reason }`, `401`, `403`, `404`.
  Node ids `device-rename-http`, `device-rename-scope-guard`, `device-rename-fn`,
  `device-rename-resp`.

Mapping of the helper result onto the pinned three response values, decided here
and repeated in the test: helper `'updated'` becomes `updated`; helper
`'unchanged'` and helper `'skipped'` both become `skipped` (nothing had to change
in ChirpStack); a rejected promise, an unavailable helper module and an
unconfigured client become `failed`, `failed` and `skipped` respectively; and a
`changed: false` rename never calls ChirpStack at all and reports `skipped`.

The ChirpStack call is awaited **before** the route closes its database handle,
because `readCurrentName` reads `devices.name` through that same handle at the
moment the per-DevEUI-serialized call actually runs. Awaiting it before the
route answers is accepted here, and Task 4 bounds the wait: both RPCs of a name
update carry `NAME_UPDATE_DEADLINE_MS`, so a ChirpStack that accepts the
connection and never answers costs the caller five seconds, not twenty. The
command path in Task 8 does not await it at all, because there an
acknowledgement is already in flight.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-device-rename-route.js`:

```js
#!/usr/bin/env node
'use strict';

// Behavioural test for PUT /api/devices/:deveui/name (nodes
// device-rename-scope-guard + device-rename-fn in the canonical flows.json).
// The ChirpStack helper is injected as a fake through the harness's
// osiLibModules hook: no gRPC, no network.
//
// Run: node --test scripts/test-device-rename-route.js

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const AUTH_SECRET = 'device-rename-route-test-secret';
const BASE_ENV = { AUTH_TOKEN_SECRET: AUTH_SECRET, CHIRPSTACK_API_URL: 'http://127.0.0.1:8080', CHIRPSTACK_API_KEY: 'k' };
const FLAG_OFF = Object.assign({ OSI_SCOPED_ACCESS: '0' }, BASE_ENV);
const FLAG_ON = Object.assign({ OSI_SCOPED_ACCESS: '1' }, BASE_ENV);
const OWNER = { userId: 2, username: 'res1' };      // owns DENDRO1 and VALVE1
const STRANGER = { userId: 1, username: 'admin1' };
const VIEWER = { userId: 3, username: 'view1' };

function fakeChirpStack(behaviour) {
  const calls = [];
  return {
    calls,
    module: {
      createProvisioningClientFromEnv(env) {
        if (behaviour.unconfigured) throw new Error('CHIRPSTACK_API_URL is required');
        return { marker: 'client', apiUrl: env.get('CHIRPSTACK_API_URL') };
      },
      async updateDeviceName(client, devEui, readCurrentName) {
        const seen = await readCurrentName();
        calls.push({ devEui, seen, client: client && client.marker });
        if (behaviour.reject) throw new Error('14 UNAVAILABLE: no connection');
        return behaviour.outcome || 'updated';
      },
    },
  };
}

function renameRequest({ deveui = 'DENDRO1', name, authorization }) {
  return {
    req: {
      method: 'PUT',
      path: '/api/devices/' + deveui + '/name',
      headers: authorization === undefined ? {} : { authorization },
      params: { deveui },
      body: name === undefined ? {} : { name },
    },
  };
}

function token(identity) {
  return makeAuthHeader({ userId: identity.userId, username: identity.username, secret: AUTH_SECRET });
}

function linkCloud(db) {
  db.exec("INSERT OR REPLACE INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) "
    + "VALUES ('cloud', 1, '0016C001F11715E2', datetime('now'))");
}

async function callRoute(db, env, options, chirpstack) {
  const osiLibModules = chirpstack ? { chirpstack: chirpstack.module } : {};
  const guard = await executeFunction(loadNode('device-rename-scope-guard'), {
    msg: renameRequest(options),
    env,
    db,
    osiLibModules,
  });
  if (guard.result[1]) return { stage: 'guard', result: guard.result[1], warnings: guard.warnings };
  const handler = await executeFunction(loadNode('device-rename-fn'), {
    msg: guard.result[0],
    env,
    db,
    osiLibModules,
  });
  return { stage: 'handler', result: handler.result, warnings: handler.warnings };
}

test('flag-off: the owner renames the device and ChirpStack is updated', async () => {
  const db = seedScopedDb();
  linkCloud(db);
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: '\u00a0Bloc nord\u00a0', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.name, 'Bloc nord');
    assert.equal(result.payload.changed, true);
    assert.equal(result.payload.deveui, 'DENDRO1');
    assert.equal(result.payload.chirpstack, 'updated');
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Bloc nord');
    // readCurrentName runs against the still-open handle and sees the committed name.
    assert.deepEqual(cs.calls.map((c) => [c.devEui, c.seen]), [['DENDRO1', 'Bloc nord']]);
    const events = db.prepare("SELECT op, payload_json FROM sync_outbox WHERE aggregate_type='DEVICE'").all();
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'DEVICE_FLAGS_UPDATED');
    assert.equal(JSON.parse(events[0].payload_json).name, 'Bloc nord');
  } finally {
    db.close();
  }
});

test('a gRPC failure leaves the rename committed and reports chirpstack failed', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ reject: true });
  try {
    const { result, warnings } = await callRoute(db, FLAG_OFF, { name: 'Tree A', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.changed, true);
    assert.equal(result.payload.chirpstack, 'failed');
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree A');
    assert.ok(warnings.some((w) => /ChirpStack update failed/.test(w)), JSON.stringify(warnings));
  } finally {
    db.close();
  }
});

test('an unconfigured provisioning client reports chirpstack skipped, not failed', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ unconfigured: true });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Tree B', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.chirpstack, 'skipped');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree B');
  } finally {
    db.close();
  }
});

test("a ChirpStack 'unchanged' result reports skipped", async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ outcome: 'unchanged' });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Tree C', authorization: token(OWNER) }, cs);
    assert.equal(result.payload.chirpstack, 'skipped');
  } finally {
    db.close();
  }
});

test('an unchanged name writes nothing, emits nothing, and never calls ChirpStack', async () => {
  const db = seedScopedDb();
  linkCloud(db);
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Tree 1', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.changed, false);
    assert.equal(result.payload.chirpstack, 'skipped');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM sync_outbox WHERE aggregate_type='DEVICE'").get().n, 0);
  } finally {
    db.close();
  }
});

test('flag-off: a stranger gets 404 and no ChirpStack call', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Taken', authorization: token(STRANGER) }, cs);
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
  } finally {
    db.close();
  }
});

test('no Authorization header answers 401', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: 'Anything', authorization: undefined }, fakeChirpStack({}));
    assert.equal(result.statusCode, 401, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of [
  ['empty', '', 'name_empty'],
  ['control character', 'Row\u00007', 'name_control_characters'],
  ['over-long', 'a'.repeat(101), 'name_too_long'],
  ['trailing lone surrogate', '\udf31x', 'name_invalid_unicode'],
]) {
  test('flag-off: a ' + label + ' name is 400 with reason ' + reason, async () => {
    const db = seedScopedDb();
    const cs = fakeChirpStack({});
    try {
      const { result } = await callRoute(db, FLAG_OFF, { name: value, authorization: token(OWNER) }, cs);
      assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
      assert.equal(result.payload.reason, reason);
      assert.equal(cs.calls.length, 0);
      assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
    } finally {
      db.close();
    }
  });
}

test('a body with no name field is 400 with reason name_empty', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({});
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name: undefined, authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 400, JSON.stringify(result.payload));
    assert.equal(result.payload.reason, 'name_empty');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
  } finally {
    db.close();
  }
});

test('100 code points of a 2-unit emoji are accepted unchanged', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ outcome: 'updated' });
  const name = '\ud83c\udf31'.repeat(100);
  try {
    const { result } = await callRoute(db, FLAG_OFF, { name, authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.name, name);
  } finally {
    db.close();
  }
});

test('scoped: a granted researcher renames a device owned by someone else', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    // res1 holds grant g-3 on z-2; DENDRO2 sits in zone 2 and is owned by admin1.
    const { result } = await callRoute(db, FLAG_ON, { deveui: 'DENDRO2', name: 'Granted tree', authorization: token(OWNER) }, cs);
    assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO2'").get().name, 'Granted tree');
  } finally {
    db.close();
  }
});

test('scoped: a viewer is refused 403 before any write or ChirpStack call', async () => {
  const db = seedScopedDb();
  const cs = fakeChirpStack({ outcome: 'updated' });
  try {
    const { stage, result } = await callRoute(db, FLAG_ON, { name: 'Viewer edit', authorization: token(VIEWER) }, cs);
    assert.equal(stage, 'guard');
    assert.equal(result.statusCode, 403, JSON.stringify(result.payload));
    assert.equal(result.payload.message, 'Forbidden');
    assert.equal(cs.calls.length, 0);
    assert.equal(db.prepare("SELECT name FROM devices WHERE deveui='DENDRO1'").get().name, 'Tree 1');
  } finally {
    db.close();
  }
});

test('an unknown DevEUI answers 404', async () => {
  const db = seedScopedDb();
  try {
    const { result } = await callRoute(db, FLAG_OFF, { deveui: 'NOPE0001', name: 'Ghost', authorization: token(OWNER) }, fakeChirpStack({}));
    assert.equal(result.statusCode, 404, JSON.stringify(result.payload));
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Run the test and watch it fail for the stated reason**

```bash
node --test scripts/test-device-rename-route.js
```

Expected: every test fails with `Error: node not found: device-rename-scope-guard`,
final `# fail 16`.

- [ ] **Step 3: Add the four nodes to both flows.json profiles**

Save as `$SCRATCH/task7-flows-edit.js` and run from the repository root. The
`guard`, `serialize`, `AUTH_BLOCK` and `RESPONSE_HEADERS` definitions are the
same ones spelled out in Task 6 Step 3 — copy that script's top half verbatim,
substitute `'device-rename-fn'` into `AUTH_BLOCK`, and replace the node
definitions and the `flows.push` call with:

```js
const deviceRenameHttp = {
  id: 'device-rename-http',
  type: 'http in',
  z: 'device-api-tab',
  name: 'PUT /api/devices/:deveui/name',
  method: 'put',
  url: '/api/devices/:deveui/name',
  x: 200,
  y: 2740,
  wires: [['device-rename-scope-guard']],
};

const deviceRenameGuard = {
  id: 'device-rename-scope-guard',
  type: 'function',
  z: 'device-api-tab',
  name: 'Fresh Device Rename Scope',
  outputs: 2,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'osiLib', module: 'osi-lib' },
    { var: 'osiDb', module: 'osi-db-helper' },
  ],
  x: 470,
  y: 2740,
  wires: [['device-rename-fn'], ['device-rename-resp']],
  func: [
    "return (async () => {",
    "const outputs = [null, null];",
    "if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') {",
    "  outputs[0] = msg;",
    "  return outputs;",
    "}",
    "let db;",
    "const closeDb = function() {",
    "  return db ? new Promise(function(resolve) { db.close(function() { resolve(); }); }) : Promise.resolve();",
    "};",
    "try {",
    "  const scopeLoad = osiLib.require('scope');",
    "  if (!scopeLoad.ok) {",
    "    node.error('device rename scope: module unavailable: ' + scopeLoad.error, msg);",
    "    throw Object.assign(new Error('scope resolver unavailable'), { statusCode: 500 });",
    "  }",
    "  const scope = scopeLoad.value;",
    "  const auth = scope.verifyBearer(",
    "    msg.req && msg.req.headers && msg.req.headers.authorization,",
    "    {",
    "      configuredSecret: env.get('AUTH_TOKEN_SECRET') || env.get('JWT_SECRET'),",
    "      fs: global.get('fs'),",
    "      warn: function(message) { node.warn(message); }",
    "    }",
    "  );",
    "  db = new osiDb.Database('/data/db/farming.db');",
    "  const actor = await db.get(",
    "    'SELECT user_uuid,role FROM users WHERE id=? AND username=? LIMIT 1',",
    "    [auth.userId, auth.username]",
    "  );",
    "  if (!actor || !actor.user_uuid) {",
    "    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });",
    "  }",
    "  const actorScope = await scope.assertFreshRole(db, actor.user_uuid, actor.role, { scopedMode: true });",
    "  if (!scope.canMutate(actorScope.role)) {",
    "    throw Object.assign(new Error('insufficient role'), { statusCode: 403 });",
    "  }",
    "  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();",
    "  if (!deveui) {",
    "    throw Object.assign(new Error('Device EUI is required'), { statusCode: 400 });",
    "  }",
    "  const device = await db.get(",
    "    'SELECT deveui,user_id FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1',",
    "    [deveui]",
    "  );",
    "  if (!device) {",
    "    throw Object.assign(new Error('device not found'), { statusCode: 404 });",
    "  }",
    "  await scope.assertFreshDeviceAccess(db, actor.user_uuid, deveui, { scopedMode: true });",
    "  msg._scopedDeviceWriteAuthorized = true;",
    "  msg._scopedDeviceOwnerId = Number(device.user_id);",
    "  msg.actor_user_uuid = actor.user_uuid;",
    "  outputs[0] = msg;",
    "  return outputs;",
    "} catch (error) {",
    "  msg.statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;",
    "  msg.payload = {",
    "    message: msg.statusCode === 404 ? 'Device not found' :",
    "      (msg.statusCode === 403 ? 'Forbidden' : String(error && error.message || error))",
    "  };",
    "  outputs[1] = msg;",
    "  return outputs;",
    "} finally {",
    "  try {",
    "    await closeDb();",
    "  } catch (closeError) {",
    "    node.warn('device rename scope close: ' + String(closeError && closeError.message ? closeError.message : closeError));",
    "  }",
    "}",
    "})();",
  ].join('\n'),
};

const deviceRenameFn = {
  id: 'device-rename-fn',
  type: 'function',
  z: 'device-api-tab',
  name: 'Rename Device',
  outputs: 1,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [
    { var: 'crypto', module: 'crypto' },
    { var: 'osiDb', module: 'osi-db-helper' },
    { var: 'osiLib', module: 'osi-lib' },
  ],
  x: 730,
  y: 2740,
  wires: [['device-rename-resp']],
  func: [
    "return (async () => {",
    AUTH_BLOCK('device-rename-fn'),
    "function respond(statusCode, payload) { msg.statusCode = statusCode; msg.payload = payload; return msg; }",
    "try {",
    "  const auth = verifyBearer(msg.req && msg.req.headers && msg.req.headers.authorization);",
    "  const deveui = String(msg.req && msg.req.params && msg.req.params.deveui || '').trim().toUpperCase();",
    "  if (!deveui) return respond(400, { message: 'Device EUI is required' });",
    "  const nameLoad = osiLib.require('entity-name');",
    "  if (!nameLoad.ok) {",
    "    node.error('Device rename name helper unavailable: ' + nameLoad.error, msg);",
    "    return respond(500, { message: 'Entity name helper unavailable' });",
    "  }",
    "  const body = (msg.req && msg.req.body && typeof msg.req.body === 'object') ? msg.req.body :",
    "    ((msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)) ? msg.payload : {});",
    "  let normalized = '';",
    "  try {",
    "    normalized = nameLoad.value.normalizeEntityName(body.name);",
    "  } catch (nameError) {",
    "    return respond(400, { message: 'Device name is not valid', reason: String(nameError && nameError.code || 'name_empty') });",
    "  }",
    "  const ownerId = msg._scopedDeviceWriteAuthorized ? Number(msg._scopedDeviceOwnerId) : Number(auth.userId);",
    "  const db = new osiDb.Database('/data/db/farming.db');",
    "  const close = () => new Promise((resolve) => db.close(() => resolve()));",
    "  try {",
    "    const owned = await db.get(",
    "      'SELECT deveui FROM devices WHERE deveui=? AND user_id=? AND deleted_at IS NULL LIMIT 1',",
    "      [deveui, ownerId]",
    "    );",
    "    if (!owned) return respond(404, { message: 'Device not found' });",
    "    const renamed = await nameLoad.value.renameDevice(db, { deveui: deveui, name: normalized });",
    "    let chirpstackOutcome = 'skipped';",
    "    if (renamed.changed) {",
    "      const csLoad = osiLib.require('chirpstack');",
    "      if (!csLoad.ok) {",
    "        node.warn('Device rename ChirpStack helper unavailable: ' + csLoad.error);",
    "        chirpstackOutcome = 'failed';",
    "      } else {",
    "        let client = null;",
    "        try {",
    "          client = csLoad.value.createProvisioningClientFromEnv(env);",
    "        } catch (clientError) {",
    "          node.warn('Device rename ChirpStack provisioning not configured: ' + String(clientError && clientError.message ? clientError.message : clientError));",
    "        }",
    "        if (client) {",
    "          try {",
    "            const outcome = await csLoad.value.updateDeviceName(client, deveui, async () => {",
    "              const row = await db.get('SELECT name FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1', [deveui]);",
    "              return row && row.name !== undefined && row.name !== null ? row.name : null;",
    "            });",
    "            chirpstackOutcome = outcome === 'updated' ? 'updated' : 'skipped';",
    "          } catch (csError) {",
    "            node.warn('Device rename ChirpStack update failed for ' + deveui + ': ' + String(csError && csError.message ? csError.message : csError));",
    "            chirpstackOutcome = 'failed';",
    "          }",
    "        }",
    "      }",
    "    }",
    "    return respond(200, {",
    "      deveui: renamed.deveui,",
    "      name: renamed.name,",
    "      sync_version: renamed.sync_version,",
    "      changed: renamed.changed,",
    "      chirpstack: chirpstackOutcome",
    "    });",
    "  } finally {",
    "    try {",
    "      await close();",
    "    } catch (closeError) {",
    "      node.warn('device rename close: ' + String(closeError && closeError.message ? closeError.message : closeError));",
    "    }",
    "  }",
    "} catch (error) {",
    "  const statusCode = Number(error && (error.statusCode || error.status) || 500) || 500;",
    "  return respond(statusCode, {",
    "    message: statusCode === 404 ? 'Device not found' : String(error && error.message || error)",
    "  });",
    "}",
    "})();",
  ].join('\n'),
};

const deviceRenameResp = {
  id: 'device-rename-resp',
  type: 'http response',
  z: 'device-api-tab',
  name: 'Device Rename Response',
  statusCode: '',
  headers: RESPONSE_HEADERS,
  x: 990,
  y: 2740,
  wires: [],
};

for (const id of ['device-rename-http', 'device-rename-scope-guard', 'device-rename-fn', 'device-rename-resp']) {
  if (flows.some((n) => n && n.id === id)) throw new Error('node id already exists: ' + id);
}
flows.push(deviceRenameHttp, deviceRenameGuard, deviceRenameFn, deviceRenameResp);
```

Expected output: the two pre-write `byte-identical: true` lines at the Task 6
size, `Wrote canonical + mirror. New node count: 734`, two post-write
`byte-identical: true` lines.

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test scripts/test-device-rename-route.js
```

Expected: `# pass 16`, `# fail 0`, exit 0.

- [ ] **Step 5: Add the verify-sync-flow assertions**

Add `'/api/devices/:deveui/name'` to `requiredHttpRoutes` (after
`'/api/devices/:deveui/zone-assignments'`), and this block directly after the
Task 6 zone-rename block:

```js
expectNodeTypeById('device-rename-http', 'http in', 'exposes the device rename route');
expectWireById('device-rename-http', 'device-rename-scope-guard', 'routes device renames through the fresh scope guard');
expectWireById('device-rename-scope-guard', 'device-rename-fn', 'passes authorized device renames to the writer');
expectWireById('device-rename-scope-guard', 'device-rename-resp', 'answers refused device renames on the route response node');
expectWireById('device-rename-fn', 'device-rename-resp', 'answers every device rename on the route response node');
expectLibById('device-rename-scope-guard', 'osiLib', 'osi-lib', 'loads the scope helper through the osi-lib seam');
expectLibById('device-rename-fn', 'osiLib', 'osi-lib', 'loads the entity-name and chirpstack helpers through the osi-lib seam');
expectOrderedIncludesById('device-rename-scope-guard', [
  "if (String(env.get('OSI_SCOPED_ACCESS') || '') !== '1') {",
  "const scopeLoad = osiLib.require('scope');",
  'scope.assertFreshRole(',
  'scope.canMutate(',
  'scope.assertFreshDeviceAccess(',
], 'gates the scope helper behind the flag and asserts role before device access');
expectOrderedIncludesById('device-rename-fn', [
  'const auth = verifyBearer(',
  "const nameLoad = osiLib.require('entity-name');",
  'nameLoad.value.normalizeEntityName(body.name)',
  'AND user_id=? AND deleted_at IS NULL',
  'nameLoad.value.renameDevice(db, { deveui: deveui, name: normalized })',
  "const csLoad = osiLib.require('chirpstack');",
  'csLoad.value.createProvisioningClientFromEnv(env)',
  'csLoad.value.updateDeviceName(client, deveui,',
], 'writes the database first and only then updates the ChirpStack name');
expectIncludesById('device-rename-fn', 'reason: String(nameError && nameError.code', 'returns the name reason code on a 400');
expectIncludesById('device-rename-fn', "chirpstackOutcome = 'failed';", 'reports a ChirpStack failure without changing the 200');
expectIncludesById('device-rename-fn', 'Device rename ChirpStack provisioning not configured:', 'treats unconfigured provisioning as a skip, not a failure');
expectIncludesById('device-rename-fn', '.close(', 'closes the device rename database handle');
```

- [ ] **Step 6: Record the size-ratchet entries**

```bash
node -e "
const { nodeSizes, totalChars } = require('./scripts/flows-size-scan');
const f = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const s = nodeSizes(f);
for (const id of ['device-rename-scope-guard','device-rename-fn']) console.log(id, s.get(id).chars);
console.log('profile total', totalChars(f));
"
```

Add a `new_node_ceilings` entry for `device-rename-fn` with the exact measured
`max_chars` and a reason naming this task, the inline bearer block and the
`verify-auth-flag-off-hermetic` constraint, plus one for
`device-rename-scope-guard` only if it measures above 4096. Set
`total_allowance.delta` again from a fresh measurement against `origin/main`
with the command in "Setting a size-ratchet number", never by adding this task's
increase to what Task 6 wrote, and append the new figure to the existing reason
chain in the file's style.
Re-run `node scripts/verify-flows-size-ratchet.js`; expect exit 0 and
`verify-flows-size-ratchet: OK (...)`.

- [ ] **Step 7: No osi-lib-binding-audit change, and prove it**

Both nodes bind `osiDb` and `crypto` alongside `osiLib`, so neither can satisfy
`hasExactOsiLibOnly` and neither belongs in `TASK9_OSI_LIB_NODE_POLICIES`.
`node --test scripts/osi-lib-binding-audit.test.js` must still print `# pass 9`,
`# fail 0`, exit 0.

- [ ] **Step 8: Extend the CI step**

In `.github/workflows/verify-sync-flow.yml`, change the `Zone and device rename gates`
step's `run` block to:

```yaml
        run: |
          node --test scripts/test-zone-rename-route.js \
            scripts/test-device-rename-route.js
```

- [ ] **Step 9: Run the flows gate set**

Run every row of the Task 6 Step 9 table again, unchanged, and check each exit
status. `verify-scoped-access.js` matters most here: the new `http in` node must
have `require('scope')` reachable downstream, which `device-rename-scope-guard`
provides.

- [ ] **Step 10: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-device-rename-route.js \
        scripts/verify-sync-flow.js \
        scripts/verify-flows-size-ratchet-allowances.json \
        .github/workflows/verify-sync-flow.yml
git commit -m "feat(devices): add PUT /api/devices/:deveui/name with best-effort ChirpStack rename"
```

---

### Task 8: Command path, registry, capability and the command contract

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (adds `entity-name-command-apply-fn`; rewires `installation-revision-command-apply-fn`; edits `cmd-type-registry`, `reject-indefinite-open`, `sync-bootstrap-build`, `al-link-build-req`, `sync-force-build`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (mirror)
- Create: `scripts/test-entity-name-command-path.js`
- Modify: `scripts/osi-lib-binding-audit.js`
- Modify: `scripts/osi-lib-binding-audit.test.js`
- Modify: `scripts/test-flows-wiring.js`
- Modify: `scripts/test-journal-bootstrap.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `.github/workflows/verify-sync-flow.yml`
- Modify: `AGENTS.md`
- Modify: `docs/contracts/sync-schema/commands.schema.json`
- Modify: `scripts/test-contract-schemas.js`

**Interfaces:**
- Consumes (Tasks 1 to 3, module `osi-entity-name`):
  `applyNameCommand(db, envelope, runtime) -> { handled: false } | { handled: true, ack }`
  where `envelope` is `cmd._pendingCommandEnvelope`
  (`{ commandId: <positive safe integer>, commandType, payload }`), `runtime` is
  `{ scopedMode: boolean, gateway_device_eui: string, command_type_recognized: boolean }`,
  and `ack` is
  `{ commandId, commandType, effectKey: null, gatewayDeviceEui, status, result, reason, duplicate, appliedSyncVersion, appliedAt, target, requestedAt }`.
  `ack.target` is the `device_eui` for `UPSERT_DEVICE_NAME` and the `zone_uuid`
  for `UPSERT_ZONE_NAME`.
- Owns (contract): `docs/contracts/sync-schema/commands.schema.json` gains both
  command types in its `command_type` enum, one `allOf` branch each, and three
  top-level properties that the root's `additionalProperties: false` would
  otherwise forbid. `scripts/verify-sync-contract.js` asserts that enum equals
  `Command Type Registry` plus the separately routed and the staged commands
  **exactly**, so the schema edit and the registry edit below are one commit;
  steps 12 to 15 carry the schema half. `docs/contracts/sync-schema/resources.schema.json`
  must not change: rows longer than 100 characters already exist legally and
  still travel in bootstrap and in unrelated events (decision D6).
- Consumes (in tree today): `updateDeviceName` / `createProvisioningClientFromEnv`
  as in Task 7.
- Produces: registry entries
  `UPSERT_DEVICE_NAME: { dispatch: 'entity_name_apply', actuator: false, requires_duration: false }`
  and `UPSERT_ZONE_NAME: { ... }` in both `cmd-type-registry` and
  `reject-indefinite-open`'s `COMMAND_TYPES_FALLBACK`; capability string
  `entity_name_commands_v1` in all three `syncCapabilities` builders; function
  node `entity-name-command-apply-fn` ("Apply Entity Name Command") emitting the
  acknowledgement on `devices/<gatewayEui>/command_ack`.

Where the new node sits, and why nothing dead-ends:

```
sync-pending-split / sync-force-build
  -> reject-indefinite-open        (registry lookup; unknown type -> node.warn + drop)
  -> command-dedupe-dispatch       (osi-command-ledger replay guard)
  -> journal-command-apply-fn
  -> terra-zone-config-command-apply-fn
  -> zone-command-apply-fn
  -> weather-zones-command-apply-fn
  -> installation-revision-command-apply-fn
  -> entity-name-command-apply-fn  <- NEW, output 0 to Route Command, output 1 to MQTT
  -> 934bf2bc19a8ce22 "Route Command"
```

`Route Command` routes by an explicit `commandType` if-chain and ends in a bare
`return null;` — it never reads the registry's `dispatch` value at all (verified
by reading node `934bf2bc19a8ce22`). The `dispatch: 'entity_name_apply'` value is
therefore metadata consumed only by `scripts/verify-command-safety.js`, which
checks it is a non-empty string and that it does not match
`/OPEN|VALVE|CLOS|ACTUAT/i` for a non-actuator entry (`entity_name_apply` does
not). Both command types are consumed by the new node before they can reach
`Route Command`, so the dead `return null;` is never taken. That is exactly how
`UPSERT_DEVICE_INSTALLATION_LOCATION` already works.

`command-dedupe-dispatch` passes an unhandled message straight on as
`return [msg, null]`, with the untouched `cmd._pendingCommandEnvelope`; it only
consumes a message when `osi-command-ledger.deduplicatePendingCommand` reports a
replay. Nothing in it requires an `effect_key`, so a name command without one
reaches the new node — Step 1's first test pins that.

Also verified and worth recording: `reject-indefinite-open`'s fallback table is
already missing `UPSERT_DEVICE_INSTALLATION_LOCATION` and
`UPSERT_DEVICE_RADIO_CONFIGURATION`, which the primary registry has.
`verify-command-safety.js` only requires *actuator* keys to be mirrored, so that
gap is legal. This task does not close it; it only adds the two new types to both
tables, as the spec requires.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-entity-name-command-path.js`:

```js
#!/usr/bin/env node
'use strict';

// Command path for UPSERT_DEVICE_NAME / UPSERT_ZONE_NAME: runs the shipped
// function-node sources (command-dedupe-dispatch, the applier chain, and the
// new entity-name-command-apply-fn) with stubbed helpers, and pins the
// registry, the fallback table and the three capability builders.
//
// Run: node --test scripts/test-entity-name-command-path.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = ['bcm2712', 'bcm2709'];
const GATEWAY_EUI = '0016C001F11715E2';
const DEVICE_EUI = 'AABBCCDDEEFF0011';
const ZONE_UUID = '11111111-1111-4111-8111-111111111111';

function loadFlows(profile) {
  return JSON.parse(fs.readFileSync(path.join(
    ROOT, 'conf/full_raspberrypi_bcm27xx_' + profile + '/files/usr/share/flows.json'
  ), 'utf8'));
}

const FLOWS = loadFlows('bcm2712');

function commandMessage(commandType, commandId, target) {
  const payload = {
    command_id: '22222222-2222-4222-8222-222222222222',
    command_type: commandType,
    gateway_device_eui: GATEWAY_EUI,
    actor_user_uuid: '33333333-3333-4333-8333-333333333333',
    requested_at: '2026-09-21T08:00:00.000Z',
    values: { name: 'North block' },
  };
  if (commandType === 'UPSERT_DEVICE_NAME') payload.device_eui = target;
  else payload.zone_uuid = target;
  return {
    _commandTypeRecognized: true,
    payload: {
      commandId,
      commandType,
      command_type: commandType,
      _pendingCommandEnvelope: { commandId, commandType, payload },
    },
  };
}

function flowDbHelper(events) {
  return {
    ok: true,
    value: {
      Database: class FakeFlowDatabase {
        constructor(filename) { events.push(['db-open', filename]); }
        get(sql, params) { events.push(['db-get', sql, params]); return Promise.resolve({ name: 'North block' }); }
        close(callback) { events.push(['db-close']); callback(null); }
      },
    },
  };
}

async function runNode(nodeId, msg, helperResults, events) {
  const node = FLOWS.find((candidate) => candidate.id === nodeId);
  assert.ok(node, 'missing shipped function node ' + nodeId);
  const requested = [];
  const errors = [];
  const warnings = [];
  const sent = [];
  const osiLib = {
    require(name) {
      requested.push(name);
      assert.ok(Object.prototype.hasOwnProperty.call(helperResults, name), 'unexpected helper load ' + name);
      return helperResults[name];
    },
  };
  const nodeApi = {
    error(message, errorMsg) { errors.push({ message, errorMsg }); },
    warn(message) { warnings.push(String(message)); },
    // The applier emits its acknowledgement with node.send before it starts the
    // ChirpStack attempt, so the harness records sends as well as returns, and
    // stamps the shared events array so the two can be ordered against each
    // other.
    send(value) { sent.push(value); if (events) events.push(['node-send']); },
    status() {},
  };
  const env = {
    get(name) {
      if (name === 'DEVICE_EUI') return GATEWAY_EUI;
      if (name === 'OSI_SCOPED_ACCESS') return '1';
      if (name === 'CHIRPSTACK_API_URL') return 'http://127.0.0.1:8080';
      if (name === 'CHIRPSTACK_API_KEY') return 'k';
      return '';
    },
  };
  // eslint-disable-next-line no-new-func
  const runner = new Function('msg', 'node', 'env', 'osiLib', node.func);
  const result = await runner(msg, nodeApi, env, osiLib);
  return { result, requested, errors, warnings, sent };
}

function nameHelper(ack, captured) {
  return {
    ok: true,
    value: {
      async applyNameCommand(_db, envelope, runtime) {
        if (captured) { captured.envelope = envelope; captured.runtime = runtime; }
        if (!ack) return { handled: false };
        return { handled: true, ack };
      },
    },
  };
}

function chirpStackHelper(behaviour, calls, events) {
  return {
    ok: true,
    value: {
      createProvisioningClientFromEnv() {
        if (behaviour.unconfigured) throw new Error('CHIRPSTACK_API_URL is required');
        return { marker: 'client' };
      },
      async updateDeviceName(client, devEui, readCurrentName) {
        if (events) events.push(['chirpstack-start']);
        const seen = await readCurrentName();
        calls.push({ devEui, seen });
        if (behaviour.reject) throw new Error('14 UNAVAILABLE: no connection');
        return 'updated';
      },
    },
  };
}

function appliedAck(commandType, target, extra) {
  return Object.assign({
    commandId: 4101,
    commandType,
    effectKey: null,
    gatewayDeviceEui: GATEWAY_EUI,
    status: 'ACKED',
    result: 'APPLIED',
    reason: null,
    duplicate: false,
    appliedSyncVersion: 7,
    appliedAt: '2026-09-21T08:00:01.000Z',
    target,
    requestedAt: '2026-09-21T08:00:00.000Z',
  }, extra || {});
}

test('a name command without an effect_key survives the dedupe node and reaches the applier', async () => {
  const events = [];
  const msg = commandMessage('UPSERT_ZONE_NAME', 4001, ZONE_UUID);
  let ledgerRuntime = null;
  const dedupe = await runNode('command-dedupe-dispatch', msg, {
    'osi-db-helper': flowDbHelper(events),
    'osi-command-ledger': {
      ok: true,
      value: {
        async deduplicatePendingCommand(_db, envelope, runtime) {
          ledgerRuntime = runtime;
          assert.equal(Object.prototype.hasOwnProperty.call(envelope, 'effectKey'), false);
          return { handled: false };
        },
      },
    },
  });
  assert.deepEqual(dedupe.errors, []);
  assert.equal(dedupe.result[0], msg);
  assert.equal(dedupe.result[1], null);
  assert.equal(ledgerRuntime.gateway_device_eui, GATEWAY_EUI);
  assert.equal(ledgerRuntime.command_type_recognized, true);
});

test('every upstream applier passes a name command through untouched', async () => {
  const events = [];
  for (const nodeId of [
    'journal-command-apply-fn',
    'terra-zone-config-command-apply-fn',
    'zone-command-apply-fn',
    'weather-zones-command-apply-fn',
    'installation-revision-command-apply-fn',
  ]) {
    const msg = commandMessage('UPSERT_DEVICE_NAME', 4002, DEVICE_EUI);
    const run = await runNode(nodeId, msg, {});
    assert.deepEqual(run.requested, [], nodeId + ' must not load a helper for a foreign command type');
    assert.deepEqual(run.errors, [], nodeId);
    assert.equal(run.result[0], msg, nodeId + ' must pass the message on output 0');
    assert.equal(run.result[1], null, nodeId);
  }
  assert.deepEqual(events, []);
});

test('the acknowledgement is sent before the ChirpStack attempt starts', async () => {
  const events = [];
  const calls = [];
  const captured = {};
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4101, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper(events),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI), captured),
    chirpstack: chirpStackHelper({}, calls, events),
  }, events);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.result, [null, null], 'the send already carried the acknowledgement');
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0][0], null);
  assert.equal(run.sent[0][1].topic, 'devices/' + GATEWAY_EUI + '/command_ack');
  assert.equal(run.sent[0][1].qos, 1);
  assert.deepEqual(JSON.parse(run.sent[0][1].payload), appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI));
  assert.equal(captured.envelope.commandId, 4101);
  assert.deepEqual(captured.runtime, {
    scopedMode: true,
    gateway_device_eui: GATEWAY_EUI,
    command_type_recognized: true,
  });
  const names = events.map((entry) => entry[0]);
  assert.ok(
    names.indexOf('node-send') < names.indexOf('chirpstack-start'),
    'a slow ChirpStack must never delay the acknowledgement: ' + JSON.stringify(names)
  );
  assert.deepEqual(calls, [{ devEui: DEVICE_EUI, seen: 'North block' }]);
  // The ChirpStack call is still awaited before the handle closes, or
  // readCurrentName would run against a closed database.
  assert.equal(events[events.length - 1][0], 'db-close');
  assert.ok(events.some((e) => e[0] === 'db-get'));
});

test('a slow ChirpStack does not hold the acknowledgement', async () => {
  const events = [];
  const order = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4111, DEVICE_EUI);
  const slowChirpStack = {
    ok: true,
    value: {
      createProvisioningClientFromEnv() { return { marker: 'client' }; },
      async updateDeviceName() {
        events.push(['chirpstack-start']);
        await new Promise((resolve) => setTimeout(resolve, 120));
        order.push('chirpstack-finished');
        return 'updated';
      },
    },
  };
  const started = Date.now();
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper(events),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI)),
    chirpstack: slowChirpStack,
  }, events);
  const names = events.map((entry) => entry[0]);
  assert.ok(names.indexOf('node-send') < names.indexOf('chirpstack-start'), JSON.stringify(names));
  assert.deepEqual(order, ['chirpstack-finished']);
  assert.ok(Date.now() - started >= 100, 'the node still waits for ChirpStack before it closes the handle');
  assert.equal(run.sent.length, 1);
});

test('a ChirpStack gRPC failure warns but leaves the acknowledgement APPLIED', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4102, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI)),
    chirpstack: chirpStackHelper({ reject: true }, calls),
  });
  assert.deepEqual(run.errors, []);
  assert.equal(JSON.parse(run.sent[0][1].payload).result, 'APPLIED');
  assert.ok(run.warnings.some((w) => /ChirpStack update failed/.test(w)), JSON.stringify(run.warnings));
});

test('unconfigured provisioning skips the ChirpStack call without failing the acknowledgement', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4103, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI)),
    chirpstack: chirpStackHelper({ unconfigured: true }, calls),
  });
  assert.deepEqual(run.errors, []);
  assert.equal(JSON.parse(run.sent[0][1].payload).result, 'APPLIED');
  assert.deepEqual(calls, []);
  assert.ok(run.warnings.some((w) => /provisioning not configured/.test(w)), JSON.stringify(run.warnings));
});

test('a zone rename acknowledges without touching ChirpStack', async () => {
  const msg = commandMessage('UPSERT_ZONE_NAME', 4104, ZONE_UUID);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(appliedAck('UPSERT_ZONE_NAME', ZONE_UUID)),
  });
  assert.deepEqual(run.requested, ['osi-db-helper', 'entity-name']);
  assert.equal(JSON.parse(run.sent[0][1].payload).target, ZONE_UUID);
});

test('a rejected device rename acknowledges without a ChirpStack call', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4105, DEVICE_EUI);
  const rejected = appliedAck('UPSERT_DEVICE_NAME', DEVICE_EUI, {
    status: 'NACKED', result: 'REJECTED_PERMANENT', reason: 'name_too_long', appliedSyncVersion: null,
  });
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(rejected),
    chirpstack: chirpStackHelper({}, calls),
  });
  assert.equal(JSON.parse(run.sent[0][1].payload).reason, 'name_too_long');
  assert.deepEqual(calls, []);
});

// A payload too malformed to name a target leaves ack.target and
// ack.requestedAt null. The publisher must carry the nulls through to the cloud
// rather than turning them into the strings 'null' or 'undefined'.
test('a rejected acknowledgement with a null target and requestedAt still publishes', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4109, DEVICE_EUI);
  const malformed = appliedAck('UPSERT_DEVICE_NAME', null, {
    status: 'NACKED',
    result: 'REJECTED_PERMANENT',
    reason: 'malformed_command',
    appliedSyncVersion: null,
    requestedAt: null,
  });
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(malformed),
    chirpstack: chirpStackHelper({}, calls),
  });
  assert.deepEqual(run.errors, []);
  const published = JSON.parse(run.sent[0][1].payload);
  assert.equal(published.target, null);
  assert.equal(published.requestedAt, null);
  assert.equal(published.reason, 'malformed_command');
  assert.deepEqual(calls, [], 'a rejected rename never touches ChirpStack');
});

test('an APPLIED acknowledgement with a null target skips the ChirpStack call', async () => {
  const calls = [];
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4110, DEVICE_EUI);
  const run = await runNode('entity-name-command-apply-fn', msg, {
    'osi-db-helper': flowDbHelper([]),
    'entity-name': nameHelper(appliedAck('UPSERT_DEVICE_NAME', null)),
    chirpstack: chirpStackHelper({}, calls),
  });
  assert.deepEqual(run.errors, []);
  assert.equal(JSON.parse(run.sent[0][1].payload).target, null);
  assert.deepEqual(calls, [], 'no DevEUI means nothing to rename in ChirpStack');
});

test('a foreign command type is passed on, with no helper load at all', async () => {
  const msg = commandMessage('UPSERT_DEVICE_NAME', 4106, DEVICE_EUI);
  msg.payload.commandType = 'REBOOT';
  msg.payload._pendingCommandEnvelope.commandType = 'REBOOT';
  const run = await runNode('entity-name-command-apply-fn', msg, {});
  assert.deepEqual(run.requested, []);
  assert.equal(run.result[0], msg);
  assert.equal(run.result[1], null);
  assert.deepEqual(run.sent, []);
});

test('a missing delivery envelope fails closed with no output', async () => {
  const msg = commandMessage('UPSERT_ZONE_NAME', 4107, ZONE_UUID);
  delete msg.payload._pendingCommandEnvelope;
  const run = await runNode('entity-name-command-apply-fn', msg, {});
  assert.deepEqual(run.result, [null, null]);
  assert.deepEqual(run.sent, []);
  assert.equal(run.errors.length, 1);
  assert.match(run.errors[0].message, /no protected delivery envelope/);
});

for (const missing of ['osi-db-helper', 'entity-name']) {
  test('an unavailable ' + missing + ' fails the node closed', async () => {
    const msg = commandMessage('UPSERT_ZONE_NAME', 4108, ZONE_UUID);
    const run = await runNode('entity-name-command-apply-fn', msg, {
      'osi-db-helper': missing === 'osi-db-helper' ? { ok: false, error: 'database helper absent' } : flowDbHelper([]),
      'entity-name': missing === 'entity-name' ? { ok: false, error: 'entity name helper absent' } : nameHelper(null),
    });
    assert.deepEqual(run.result, [null, null]);
    assert.deepEqual(run.sent, []);
    assert.equal(run.errors.length, 1);
    assert.match(run.errors[0].message, /Entity name command helpers unavailable/);
  });
}

test('both command types are in the registry and in the fallback table, on both profiles', () => {
  for (const profile of PROFILES) {
    const flows = loadFlows(profile);
    const registry = flows.find((n) => n.id === 'cmd-type-registry');
    const fallback = flows.find((n) => n.id === 'reject-indefinite-open');
    for (const type of ['UPSERT_DEVICE_NAME', 'UPSERT_ZONE_NAME']) {
      const entry = new RegExp(type + ":\\s*\\{\\s*dispatch: 'entity_name_apply',\\s*actuator: false,\\s*requires_duration: false\\s*\\}");
      assert.match(registry.func, entry, profile + ' registry ' + type);
      assert.match(fallback.func, entry, profile + ' fallback ' + type);
    }
  }
});

test('all three capability builders advertise entity_name_commands_v1, on both profiles', () => {
  for (const profile of PROFILES) {
    const flows = loadFlows(profile);
    for (const id of ['sync-bootstrap-build', 'al-link-build-req', 'sync-force-build']) {
      const node = flows.find((n) => n.id === id);
      assert.match(
        node.func,
        /const syncCapabilities = \['linked_auth_sync_v1', 'force_edge_sync_v1', 'installation_recovery_v1', 'installation_locations_v1', 'entity_name_commands_v1'\];/,
        profile + ' ' + id
      );
    }
  }
});

test('the applier is wired between installation revisions and Route Command, on both profiles', () => {
  for (const profile of PROFILES) {
    const flows = loadFlows(profile);
    const upstream = flows.find((n) => n.id === 'installation-revision-command-apply-fn');
    const applier = flows.find((n) => n.id === 'entity-name-command-apply-fn');
    assert.deepEqual(upstream.wires, [['entity-name-command-apply-fn'], ['9d5e3035c3d069c4']], profile);
    assert.deepEqual(applier.wires, [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']], profile);
    assert.deepEqual(applier.libs, [{ var: 'osiLib', module: 'osi-lib' }], profile);
    assert.equal(applier.name, 'Apply Entity Name Command', profile);
  }
});
```

- [ ] **Step 2: Run the test and watch it fail for the stated reason**

```bash
node --test scripts/test-entity-name-command-path.js
```

Expected: the first two tests pass (the upstream chain already passes unknown
types through); everything that touches `entity-name-command-apply-fn` fails with
`missing shipped function node entity-name-command-apply-fn`, and the registry,
capability and wiring tests fail on their `assert.match` / `assert.deepEqual`.
Final line `# fail 14`.

- [ ] **Step 3: Add the applier node, rewire the chain, and edit the five existing nodes**

Save as `$SCRATCH/task8-flows-edit.js` and run from the repository root. Copy the
`guard` / `serialize` / `CANONICAL` / `MIRROR` header verbatim from Task 6
Step 3, then:

```js
const REGISTRY_ENTRIES = [
  "    UPSERT_DEVICE_NAME:        { dispatch: 'entity_name_apply',       actuator: false,   requires_duration: false  },",
  "    UPSERT_ZONE_NAME:          { dispatch: 'entity_name_apply',       actuator: false,   requires_duration: false  },",
].join('\n') + '\n';

// Anchor: the first entry of both tables, present in cmd-type-registry and in
// reject-indefinite-open's COMMAND_TYPES_FALLBACK.
const REGISTRY_ANCHOR = "    OPEN_FOR_DURATION:         { dispatch: 'strega_timed_open',         actuator: true,    requires_duration: true  },\n";

function insertRegistryEntries(node, label) {
  if (node.func.includes('UPSERT_DEVICE_NAME:')) throw new Error(label + ' already lists UPSERT_DEVICE_NAME');
  const at = node.func.indexOf(REGISTRY_ANCHOR);
  if (at < 0) throw new Error(label + ': registry anchor not found');
  node.func = node.func.slice(0, at) + REGISTRY_ENTRIES + node.func.slice(at);
}

const CAPABILITY_BEFORE = "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'installation_recovery_v1', 'installation_locations_v1'];";
const CAPABILITY_AFTER = "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'installation_recovery_v1', 'installation_locations_v1', 'entity_name_commands_v1'];";

function addCapability(node, label) {
  const occurrences = node.func.split(CAPABILITY_BEFORE).length - 1;
  if (occurrences !== 1) throw new Error(label + ': expected exactly one capability list, found ' + occurrences);
  node.func = node.func.replace(CAPABILITY_BEFORE, CAPABILITY_AFTER);
}

const byId = new Map(flows.map((n) => [n.id, n]));
insertRegistryEntries(byId.get('cmd-type-registry'), 'cmd-type-registry');
insertRegistryEntries(byId.get('reject-indefinite-open'), 'reject-indefinite-open');
for (const id of ['sync-bootstrap-build', 'al-link-build-req', 'sync-force-build']) {
  addCapability(byId.get(id), id);
}

const upstream = byId.get('installation-revision-command-apply-fn');
if (JSON.stringify(upstream.wires) !== JSON.stringify([['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']])) {
  throw new Error('installation-revision-command-apply-fn wiring is not the expected baseline');
}
upstream.wires = [['entity-name-command-apply-fn'], ['9d5e3035c3d069c4']];

const applier = {
  id: 'entity-name-command-apply-fn',
  type: 'function',
  z: '93b1537a596e0e6d',
  name: 'Apply Entity Name Command',
  outputs: 2,
  timeout: 0,
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [{ var: 'osiLib', module: 'osi-lib' }],
  x: 2700,
  y: 1170,
  wires: [['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']],
  func: [
    "return (async () => {",
    "  let cmd;",
    "  try {",
    "    cmd = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : (msg.payload || {});",
    "  } catch (parseError) {",
    "    node.error('Entity name command parse failed closed: ' + String(parseError && parseError.message ? parseError.message : parseError), msg);",
    "    return [null, null];",
    "  }",
    "  const envelope = cmd._pendingCommandEnvelope;",
    "  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {",
    "    node.error('Entity name command has no protected delivery envelope', msg);",
    "    return [null, null];",
    "  }",
    "  const commandType = String(envelope.commandType || '').trim().toUpperCase();",
    "  if (!['UPSERT_DEVICE_NAME','UPSERT_ZONE_NAME'].includes(commandType)) return [msg, null];",
    "  const dbLoad = osiLib.require('osi-db-helper');",
    "  const nameLoad = osiLib.require('entity-name');",
    "  if (!dbLoad.ok || !nameLoad.ok) {",
    "    const detail = [dbLoad, nameLoad]",
    "      .filter(function(load) { return !load.ok; })",
    "      .map(function(load) { return load.error; })",
    "      .join('; ');",
    "    node.error('Entity name command helpers unavailable: ' + detail, msg);",
    "    return [null, null];",
    "  }",
    "  const gatewayEui = String(env.get('DEVICE_EUI') || '').trim().toUpperCase();",
    "  const db = new dbLoad.value.Database('/data/db/farming.db');",
    "  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));",
    "  try {",
    "    const result = await nameLoad.value.applyNameCommand(db, envelope, {",
    "      scopedMode: String(env.get('OSI_SCOPED_ACCESS') || '') === '1',",
    "      gateway_device_eui: gatewayEui,",
    "      command_type_recognized: msg._commandTypeRecognized === true",
    "    });",
    "    if (!result.handled) return [msg, null];",
    "    // The acknowledgement leaves before the ChirpStack attempt starts. The",
    "    // label update is best effort (design D3), and a ChirpStack that accepts",
    "    // the connection and never answers must not hold the cloud's answer for",
    "    // the whole deadline. node.send emits it now and the function returns",
    "    // [null, null], so nothing is emitted twice.",
    "    node.send([null, {",
    "      topic: 'devices/' + gatewayEui + '/command_ack',",
    "      payload: JSON.stringify(result.ack),",
    "      qos: 1",
    "    }]);",
    "    if (commandType === 'UPSERT_DEVICE_NAME' && result.ack && result.ack.result === 'APPLIED') {",
    "      // target is null when the payload was too malformed to name one. An",
    "      // APPLIED rename always has one, but the guard below costs nothing and",
    "      // keeps a future ack shape from turning null into the string 'NULL'.",
    "      const devEui = String(result.ack.target === null || result.ack.target === undefined ? '' : result.ack.target).trim().toUpperCase();",
    "      const csLoad = osiLib.require('chirpstack');",
    "      if (!csLoad.ok) {",
    "        node.warn('Entity name command ChirpStack helper unavailable: ' + csLoad.error);",
    "      } else {",
    "        let client = null;",
    "        try {",
    "          client = csLoad.value.createProvisioningClientFromEnv(env);",
    "        } catch (clientError) {",
    "          node.warn('Entity name command ChirpStack provisioning not configured: ' + String(clientError && clientError.message ? clientError.message : clientError));",
    "        }",
    "        if (client && devEui) {",
    "          try {",
    "            await csLoad.value.updateDeviceName(client, devEui, async () => {",
    "              const row = await db.get('SELECT name FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1', [devEui]);",
    "              return row && row.name !== undefined && row.name !== null ? row.name : null;",
    "            });",
    "          } catch (csError) {",
    "            node.warn('Entity name command ChirpStack update failed for ' + devEui + ': ' + String(csError && csError.message ? csError.message : csError));",
    "          }",
    "        }",
    "      }",
    "    }",
    "    return [null, null];",
    "  } catch (error) {",
    "    node.error('Entity name command apply failed closed: ' + String(error && error.message ? error.message : error), msg);",
    "    return [null, null];",
    "  } finally {",
    "    try {",
    "      await close();",
    "    } catch (closeError) {",
    "      node.warn('Entity name command DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));",
    "    }",
    "  }",
    "})();",
  ].join('\n'),
};

if (flows.some((n) => n && n.id === applier.id)) throw new Error('node id already exists: ' + applier.id);
// Keep the applier adjacent to the node it follows, so the JSON diff reads as a
// chain insertion rather than an append at the end of the array.
flows.splice(flows.indexOf(upstream) + 1, 0, applier);

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
console.log('Wrote canonical + mirror. New node count:', flows.length);
guard(CANONICAL);
guard(MIRROR);
```

Expected output: pre-write `byte-identical: true` lines at the Task 7 size,
`Wrote canonical + mirror. New node count: 735`, post-write
`byte-identical: true` lines.

- [ ] **Step 4: Add the reviewed osi-lib binding policy**

Compute the SHA-256 of the new node's `func` — the audit hashes the `func` string
as UTF-8, nothing else:

```bash
node -e "
const c = require('node:crypto');
const f = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const n = f.find((x) => x.id === 'entity-name-command-apply-fn');
console.log(c.createHash('sha256').update(n.func, 'utf8').digest('hex'));
"
```

In `scripts/osi-lib-binding-audit.js`, add the binding constants next to
`INSTALLATION_LOCATION_BINDING`:

```js
const ENTITY_NAME_BINDING = Object.freeze({ variable: 'entityName', module: 'entity-name' });
const CHIRPSTACK_BINDING = Object.freeze({ variable: 'chirpstack', module: 'chirpstack' });
```

and this policy as the last entry of `TASK9_OSI_LIB_NODE_POLICIES`:

```js
  'entity-name-command-apply-fn': Object.freeze({
    // Zone/device rename Stage 1: applies UPSERT_DEVICE_NAME and
    // UPSERT_ZONE_NAME only, delegating the whole transaction to
    // osi-entity-name's applyNameCommand. After an APPLIED device rename it
    // runs the best-effort ChirpStack name update, awaited before the database
    // handle closes because readCurrentName reads devices.name through it. A
    // ChirpStack failure only warns; it never changes the acknowledgement.
    // Last link of the command-apply delegation chain before Route Command.
    funcSha256: '<paste the measured digest>',
    bindings: Object.freeze([DB_BINDING, ENTITY_NAME_BINDING, CHIRPSTACK_BINDING]),
  }),
```

In `scripts/osi-lib-binding-audit.test.js`, add to the `bindings` object:

```js
  entityName: { variable: 'entityName', module: 'entity-name' },
  chirpstack: { variable: 'chirpstack', module: 'chirpstack' },
```

and to `expectedById`:

```js
  'entity-name-command-apply-fn': [bindings.db, bindings.entityName, bindings.chirpstack],
```

The test asserts `Object.keys(TASK9_OSI_LIB_NODE_POLICIES).sort()` equals
`Object.keys(expectedById).sort()`, so both edits are mandatory. Run:

```bash
node --test scripts/osi-lib-binding-audit.test.js
```

Expected: `# pass 9`, `# fail 0`, exit 0. A wrong digest fails with
`function node entity-name-command-apply-fn source does not match its reviewed SHA-256`.

`installation-revision-command-apply-fn` keeps its existing digest: this task
changes only its `wires` array, which the audit does not hash.

- [ ] **Step 5: Re-pin the wiring guard**

In `scripts/test-flows-wiring.js`, change the `installationRevisionApply` block's
expected wires from `[['934bf2bc19a8ce22'], ['9d5e3035c3d069c4']]` to
`[['entity-name-command-apply-fn'], ['9d5e3035c3d069c4']]`, update its failure
message to `'installation revision commands: applier must delegate, close DB, and hand unrecognized commands to the entity-name applier'`,
and add the new node's contract immediately after it:

```js
const entityNameApply = byId['entity-name-command-apply-fn'];
if (!entityNameApply || !requireOsiLibContract(
    entityNameApply,
    [OSI_DB_BINDING, OSI_ENTITY_NAME_BINDING, OSI_CHIRPSTACK_BINDING],
    'entity name commands: applier',
    'Entity name command helpers unavailable:'
) || JSON.stringify(entityNameApply.wires) !== JSON.stringify([
    ['934bf2bc19a8ce22'],
    ['9d5e3035c3d069c4'],
]) || !/applyNameCommand/.test(entityNameApply.func || '') ||
    !/updateDeviceName\(client, devEui,/.test(entityNameApply.func || '') ||
    !/\.close\s*\(/.test(entityNameApply.func || '') ||
    !ackPrecedesChirpStack(entityNameApply)) {
    failures.push('entity name commands: applier must delegate, acknowledge before the ChirpStack attempt, update the ChirpStack name best effort, close DB, and separate legacy fallback from durable ACK');
}
```

with the two binding constants added next to `OSI_INSTALLATION_LOCATION_BINDING`:

```js
const OSI_ENTITY_NAME_BINDING = { variable: 'entityName', module: 'entity-name' };
const OSI_CHIRPSTACK_BINDING = { variable: 'chirpstack', module: 'chirpstack' };
```

and the ordering predicate beside the other helper functions near the top of the
file, under `requireOsiLibContract`:

```js
// A rename must be acknowledged before the best-effort ChirpStack update is
// attempted, or a ChirpStack that accepts the connection and never answers
// holds the cloud's answer for the whole gRPC deadline. Source order is the
// only thing a static guard can see, and in this node it is the truth: the
// send is a plain statement on the path to the ChirpStack block.
function ackPrecedesChirpStack(node) {
    const source = node && typeof node.func === 'string' ? node.func : '';
    const sendAt = source.indexOf('node.send([null, {');
    const chirpStackAt = source.indexOf("osiLib.require('chirpstack')");
    return sendAt >= 0 && chirpStackAt > sendAt;
}
```

Run `node scripts/test-flows-wiring.js`; expected tail
`PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`, exit 0.
The commit message must say the pin changed because the chain gained a link.

- [ ] **Step 6: Update the bootstrap capability test**

In `scripts/test-journal-bootstrap.js`, `EXPECTED_CAPABILITIES` becomes:

```js
const EXPECTED_CAPABILITIES = [
  'linked_auth_sync_v1',
  'force_edge_sync_v1',
  'installation_recovery_v1',
  'installation_locations_v1',
  'entity_name_commands_v1',
  'field_journal_v1',
];
```

`assertSuppressedAdvertisement` asserts the list without the journal entry as
`EXPECTED_CAPABILITIES.slice(0, 4)`; change it to `.slice(0, 5)`. Run:

```bash
node --test scripts/test-journal-bootstrap.js
```

Expected: `# fail 0`, exit 0.

- [ ] **Step 7: Add the verify-sync-flow assertions**

Add this block next to the existing applier assertions, right after the
`weather-zones-command-apply-fn` group and before the `osi-device-commands/weather.js`
file assertions:

```js
expectOrderedIncludesById('entity-name-command-apply-fn', [
  'const envelope = cmd._pendingCommandEnvelope;',
  "const commandType = String(envelope.commandType || '').trim().toUpperCase();",
  "const dbLoad = osiLib.require('osi-db-helper');",
  "const nameLoad = osiLib.require('entity-name');",
  'applyNameCommand(db, envelope, {',
  'node.send([null, {',
  "const csLoad = osiLib.require('chirpstack');",
  'updateDeviceName(client, devEui,',
], 'acknowledges a protected entity-name command before it attempts the ChirpStack rename');
expectIncludesById('entity-name-command-apply-fn', 'Entity name command helpers unavailable:', 'fails closed when entity-name helpers are unavailable');
expectIncludesById('entity-name-command-apply-fn', "'devices/' + gatewayEui + '/command_ack'", 'publishes the entity-name acknowledgement on the command_ack topic');
expectIncludesById('entity-name-command-apply-fn', 'Entity name command ChirpStack update failed for ', 'reports a ChirpStack failure as a warning, never as a rejected command');
expectIncludesById('entity-name-command-apply-fn', '.close(', 'closes the entity-name command database handle');
```

and, in the wiring block, replace

```js
expectWireById('installation-revision-command-apply-fn', '934bf2bc19a8ce22', 'falls through other commands to the existing router');
```

with

```js
expectWireById('installation-revision-command-apply-fn', 'entity-name-command-apply-fn', 'routes non-revision commands through the entity-name applier');
expectWireById('entity-name-command-apply-fn', '934bf2bc19a8ce22', 'falls through other commands to the existing router');
expectWireById('entity-name-command-apply-fn', '9d5e3035c3d069c4', 'publishes atomically persisted entity-name ACKs');
```

Add, next to the existing `cmd-type-registry` assertions:

```js
expectIncludesById('cmd-type-registry', 'UPSERT_DEVICE_NAME:', 'allows cloud device rename commands through the pending-command guard');
expectIncludesById('cmd-type-registry', 'UPSERT_ZONE_NAME:', 'allows cloud zone rename commands through the pending-command guard');
expectIncludes('Reject Indefinite Open', 'UPSERT_DEVICE_NAME:', 'fallback command registry allows device rename commands before startup registry loads');
expectIncludes('Reject Indefinite Open', 'UPSERT_ZONE_NAME:', 'fallback command registry allows zone rename commands before startup registry loads');
expectIncludesForEach(
  ['Build Cloud Bootstrap', 'Build server auth request', 'Run Force Sync'],
  "'entity_name_commands_v1'",
  'advertises the entity-name command capability to the cloud'
);
```

- [ ] **Step 8: Record the size-ratchet entries**

```bash
node -e "
const { nodeSizes, totalChars } = require('./scripts/flows-size-scan');
const f = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const s = nodeSizes(f);
for (const id of ['entity-name-command-apply-fn','cmd-type-registry','reject-indefinite-open','sync-bootstrap-build','al-link-build-req','sync-force-build']) console.log(id, s.get(id).chars);
console.log('profile total', totalChars(f));
"
```

Compare each existing node against its `origin/main` size and its current
allowance (`cmd-type-registry` 6785 with a 847 allowance; `reject-indefinite-open`
7591 / 847; `sync-bootstrap-build` 44929 / 1373; `al-link-build-req` 6682 / 2511;
`sync-force-build` 66591 / 1466). Two registry rows are about 230 characters and
one capability string is 27, so all five are expected to fit inside their
existing headroom; if any does not, raise that entry's `delta` and say why in its
`reason`, in the file's supersede-and-re-measure style. The new node is expected
just under the 4096-char ceiling — measure it, and add a `new_node_ceilings`
entry with the exact number only if it is over. Set `total_allowance.delta` from
a fresh measurement against `origin/main` with the command in "Setting a
size-ratchet number", never by adding this task's increase to what Task 7 wrote.
Re-run `node scripts/verify-flows-size-ratchet.js`; expected
`verify-flows-size-ratchet: OK (...)`, exit 0.

- [ ] **Step 9: Run the test and watch it pass**

```bash
node --test scripts/test-entity-name-command-path.js
```

Expected: `# pass 16`, `# fail 0`, exit 0.

- [ ] **Step 10: Update AGENTS.md**

In `AGENTS.md`, the `Cloud → edge command types` list under `## Sync REST endpoints`
gains the two types. Change the line ending `..., REGISTER_DEVICE.` to end
`..., REGISTER_DEVICE, UPSERT_ZONE_NAME, UPSERT_DEVICE_NAME.` and add one
sentence below it:

```markdown
`UPSERT_ZONE_NAME` and `UPSERT_DEVICE_NAME` are applied by
`entity-name-command-apply-fn` and are only sent to a gateway that reported the
`entity_name_commands_v1` sync capability.
```

Then run the prose checker on the changed file:

```bash
node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md
```

Expected: `slop-check: PASS (no tier-1 findings)`, exit 0.

- [ ] **Step 11: Extend the CI step and run the gate set**

`.github/workflows/verify-sync-flow.yml`, `Zone and device rename gates`:

```yaml
        run: |
          node --test scripts/test-zone-rename-route.js \
            scripts/test-device-rename-route.js \
            scripts/test-entity-name-command-path.js
```

Then run the Task 6 Step 9 table in full, plus these three, which only this task
can break:

| Gate | Command | Pass signal |
|---|---|---|
| Command safety / registry parity | `node scripts/verify-command-safety.js` | ends `verify-command-safety: OK`, with `ok Command Type Registry checked against 2 fallback(s) (56 primary entries)`, exit 0 |
| Sync contract | `node scripts/verify-sync-contract.js` | Red at this point, with `commands.schema.json enum drift: missing=UPSERT_DEVICE_NAME,UPSERT_ZONE_NAME`. That is the designed state between step 3 and step 14, and steps 12 to 15 close it inside this same commit |
| Contract schemas | `node scripts/test-contract-schemas.js` | exit 0 at this point; steps 12 to 15 add the new instances |

- [ ] **Step 12: Write the failing contract tests**

The registry now lists two command types the schema does not, so
`verify-sync-contract.js` is red. These four steps close it, in this commit.

In `scripts/test-contract-schemas.js`, change line 27 to carry the zone rename
type, with the reason:

```js
// UPSERT_ZONE_NAME joins the journal and scoped-access commands as a device_eui
// exemption: it names its target with zone_uuid, and no device is involved.
const DEVICE_EUI_EXEMPT_COMMANDS = [...JOURNAL_COMMANDS, ...SCOPED_ACCESS_COMMANDS, 'UPSERT_ZONE_NAME'];
```

Then, immediately before the final `if (!ok) process.exit(1);` block, add:

```js
const NAME_ACTOR = '12345678-1234-4234-8234-123456789abc';
const NAME_GATEWAY = '0016C001F11715E2';
const NAME_REQUESTED_AT = '2026-09-21T10:00:00.000Z';
const validDeviceName = {
    command_type: 'UPSERT_DEVICE_NAME',
    command_id: UUID,
    device_eui: 'AABBCCDDEEFF0011',
    gateway_device_eui: NAME_GATEWAY,
    actor_user_uuid: NAME_ACTOR,
    requested_at: NAME_REQUESTED_AT,
    values: { name: 'Probe 7' },
};
const validZoneName = {
    command_type: 'UPSERT_ZONE_NAME',
    command_id: UUID,
    zone_uuid: UUID,
    gateway_device_eui: NAME_GATEWAY,
    actor_user_uuid: NAME_ACTOR,
    requested_at: NAME_REQUESTED_AT,
    values: { name: 'North block' },
};
expectValid('UPSERT_DEVICE_NAME command', cmdSchema, validDeviceName);
expectValid('UPSERT_ZONE_NAME command', cmdSchema, validZoneName);
expectValid(
    'UPSERT_DEVICE_NAME accepts a 100-code-point name',
    cmdSchema,
    Object.assign({}, validDeviceName, { values: { name: 'a'.repeat(100) } })
);
expectInvalid(
    'UPSERT_DEVICE_NAME rejects a 101-character name',
    cmdSchema,
    Object.assign({}, validDeviceName, { values: { name: 'a'.repeat(101) } }),
    /name.*longer/
);
expectInvalid(
    'UPSERT_DEVICE_NAME rejects an empty name',
    cmdSchema,
    Object.assign({}, validDeviceName, { values: { name: '' } }),
    /name.*short/
);
expectInvalid(
    'UPSERT_DEVICE_NAME without requested_at',
    cmdSchema,
    (() => { const value = Object.assign({}, validDeviceName); delete value.requested_at; return value; })(),
    /requested_at.*required/
);
expectInvalid(
    'UPSERT_ZONE_NAME without zone_uuid',
    cmdSchema,
    (() => { const value = Object.assign({}, validZoneName); delete value.zone_uuid; return value; })(),
    /zone_uuid.*required/
);
expectInvalid(
    'UPSERT_ZONE_NAME with an extra values field',
    cmdSchema,
    Object.assign({}, validZoneName, { values: { name: 'North block', colour: 'green' } }),
    /colour|additional/
);
expectInvalid(
    'UPSERT_ZONE_NAME with a non-canonical requested_at',
    cmdSchema,
    Object.assign({}, validZoneName, { requested_at: '2026-09-21T10:00:00Z' }),
    /requested_at.*(?:match|format)/
);

// D6: the v1 resource schema keeps no name length bound. A row that predates
// the rule must still travel through bootstrap and through an unrelated event.
expectValid(
    'a Zone resource with a 101-character name stays valid',
    resourcesSchema.definitions.Zone,
    { zone_id: 1, name: 'a'.repeat(101) },
    resourcesSchema
);
expectValid(
    'a Device resource with a 101-character name stays valid',
    resourcesSchema.definitions.Device,
    { deveui: '0016C001F11715E2', type_id: 'DRAGINO_LSN50', name: 'a'.repeat(101) },
    resourcesSchema
);
```

- [ ] **Step 13: Run the contract test and watch it fail**

```bash
node scripts/test-contract-schemas.js
```

Expected: FAIL, exit 1, with
`FAIL UPSERT_DEVICE_NAME command rejected: $.command_type: value is not in enum`,
`FAIL device_eui exemption is missing or does not match gateway-resource commands`,
and a failure for the `UPSERT_ZONE_NAME without device_eui` row of the loop at
line 1744.

- [ ] **Step 14: Add both types to the command schema**

Three edits in `docs/contracts/sync-schema/commands.schema.json`, and a fourth
for the payload branches.

First, inside `properties.command_type.enum`, add `"UPSERT_ZONE_NAME"` directly
after `"UPSERT_ZONE_LOCATION"` and `"UPSERT_DEVICE_NAME"` directly after
`"UPSERT_DEVICE_SOIL_DEPTHS"`:

```json
                "UPSERT_ZONE_LOCATION",
                "UPSERT_ZONE_NAME",
                "ASSIGN_DEVICE_TO_ZONE",
                "UPSERT_DEVICE_FLAGS",
                "UPSERT_DEVICE_RADIO_CONFIGURATION",
                "UPSERT_DEVICE_INSTALLATION_LOCATION",
                "UPSERT_DEVICE_SOIL_DEPTHS",
                "UPSERT_DEVICE_NAME",
```

Second, the top level carries `"additionalProperties": false`, so a property no
branch declares is forbidden everywhere. Add these three after the
`"device_eui"` line:

```json
        "device_eui": {"type": "string", "pattern": "^[0-9A-F]{16}$"},
        "gateway_device_eui": {"type": "string", "pattern": "^[0-9A-F]{16}$"},
        "zone_uuid": {"$ref": "resources.schema.json#/definitions/CanonicalUuid"},
        "requested_at": {"$ref": "resources.schema.json#/definitions/CanonicalUtcTimestamp"},
```

Third, the `allOf` rule whose `else` is `{"required": ["device_eui"]}` lists the
command types that name a gateway resource instead of a device. Append
`"UPSERT_ZONE_NAME"` as the last entry of its `if.properties.command_type.enum`,
so the list reads:

```json
                            "UPSERT_USER_PLOT_ASSIGNMENT",
                            "DELETE_USER_PLOT_ASSIGNMENT",
                            "UPSERT_ZONE_NAME"
                        ]
                    }
                },
                "required": ["command_type"]
            },
            "else": {"required": ["device_eui"]}
        },
```

The check at `scripts/test-contract-schemas.js:1477` compares this enum to
`DEVICE_EUI_EXEMPT_COMMANDS` with `JSON.stringify`, so the order must match the
constant you edited in step 12. Leave the sibling rule that pins `issued_at` and
`expires_at` to canonical timestamps alone; nothing compares the two rules.

Fourth, append these two objects to the end of the `allOf` array, after the
`DELETE_USER_PLOT_ASSIGNMENT` branch and its closing brace:

```json
        ,
        {
            "if": {
                "properties": {"command_type": {"const": "UPSERT_DEVICE_NAME"}},
                "required": ["command_type"]
            },
            "then": {
                "required": [
                    "device_eui",
                    "gateway_device_eui",
                    "actor_user_uuid",
                    "requested_at",
                    "values"
                ],
                "properties": {
                    "values": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["name"],
                        "properties": {
                            "name": {"type": "string", "minLength": 1, "maxLength": 100}
                        }
                    }
                }
            }
        },
        {
            "if": {
                "properties": {"command_type": {"const": "UPSERT_ZONE_NAME"}},
                "required": ["command_type"]
            },
            "then": {
                "required": [
                    "zone_uuid",
                    "gateway_device_eui",
                    "actor_user_uuid",
                    "requested_at",
                    "values"
                ],
                "properties": {
                    "values": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["name"],
                        "properties": {
                            "name": {"type": "string", "minLength": 1, "maxLength": 100}
                        }
                    }
                }
            }
        }
```

`maxLength: 100` counts UTF-16 units in most JSON Schema validators, not code
points, so it is a ceiling and not the rule itself. The receiver from Task 3
applies the real code-point rule.

Do not touch `x-semantic-bindings`. `verify-sync-contract.js` compares it to
`EXACT_COMMAND_SEMANTIC_BINDINGS` with a canonical-JSON equality, and these
commands carry no `effect_key` to bind. Do not touch
`docs/contracts/sync-schema/resources.schema.json` either.

- [ ] **Step 15: Run the contract gates and watch them pass**

```bash
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
node scripts/verify-sync-op-parity.js
node scripts/verify-communication-contract.js
git diff --stat docs/contracts/sync-schema/
```

Expected: `PASS: contract schema checks pass`, exit 0; exit 0 from
`verify-sync-contract.js`, with no `enum drift` line, because the registry and
the schema now agree; `verify-sync-op-parity: OK`, exit 0, which pins only
`scripts/fixtures/sync-contract-staging.json` and is untouched here;
`Communication contract verification passed`, exit 0; and a `git diff --stat`
that names `commands.schema.json` and nothing else under that directory.

- [ ] **Step 16: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-entity-name-command-path.js \
        scripts/osi-lib-binding-audit.js \
        scripts/osi-lib-binding-audit.test.js \
        scripts/test-flows-wiring.js \
        scripts/test-journal-bootstrap.js \
        scripts/verify-sync-flow.js \
        scripts/verify-flows-size-ratchet-allowances.json \
        docs/contracts/sync-schema/commands.schema.json \
        scripts/test-contract-schemas.js \
        .github/workflows/verify-sync-flow.yml \
        AGENTS.md
git commit -m "feat(sync): apply UPSERT_ZONE_NAME and UPSERT_DEVICE_NAME on the edge

The command-apply chain gains entity-name-command-apply-fn between the
installation-revision applier and Route Command, so test-flows-wiring.js and
verify-sync-flow.js re-pin the installation-revision applier's output 0.

The commands.schema.json enum and the cmd-type-registry entries land together:
verify-sync-contract.js requires the two to be equal, so either half alone
would leave the branch red."
```

One commit, not two. `node scripts/verify-sync-contract.js` must be green before
you run `git commit`, and it is only green once both halves are staged.

---

### Task 9: The name rule on the four create paths

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (nodes `post-zone-auth`, `scoped-zone-create-router`, `post-devices-auth`, `cs-reg-cloud-fn`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (mirror)
- Create: `scripts/test-entity-name-create-paths.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `.github/workflows/verify-sync-flow.yml`

**Interfaces:**
- Consumes (Task 1): `normalizeEntityName(raw)` as in Task 6.
- Produces: `POST /api/irrigation-zones` and `POST /api/devices` answer
  `400 { message, reason }` for a name that breaks the rule and store the
  normalized form; `REGISTER_DEVICE` stores the normalized name or, when the
  requested name breaks the rule, falls back to the DevEUI and still registers.
- Downstream, unchanged: `post-zone-insert` reads `flow.get('new_zone_name')` and
  `post-devices-insert` reads `flow.get('new_device_name')`, so normalizing in
  the two auth nodes is enough — neither insert node is edited.

Verified starting points (read from the canonical `flows.json` at `c37207b30`):

| Node | `libs` today | Name handling today |
|---|---|---|
| `post-zone-auth` | `crypto`, `osi-lib` | `if (!name || name.trim() === '')` -> `400 { message: 'Zone name is required' }`; `flow.set('new_zone_name', name.trim())` |
| `scoped-zone-create-router` | `osi-lib`, `osi-db-helper`, `crypto` | `const name = String(body.name || '').trim(); if (!name) throw 400` |
| `post-devices-auth` | `crypto`, `osi-lib` | truthiness only, inside the `deveui, name, type_id` required-field check; `flow.set('new_device_name', name)` stores the raw value |
| `cs-reg-cloud-fn` | `osi-db-helper`, `osi-chirpstack-helper` | line 6: `var name = String(params.name || devEui || 'Device').trim();` |

`cs-reg-cloud-fn` is the only one of the four without an `osiLib` binding, so it
gains one.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-entity-name-create-paths.js`:

```js
#!/usr/bin/env node
'use strict';

// The name rule on the four create paths (spec 5.1 and the 5.3 table):
// post-zone-auth, scoped-zone-create-router, post-devices-auth and
// cs-reg-cloud-fn. Each runs the shipped function-node source.
//
// Run: node --test scripts/test-entity-name-create-paths.js

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  executeFunction,
  loadNode,
  makeAuthHeader,
  seedScopedDb,
} = require('./lib/scoped-access-harness');

const AUTH_SECRET = 'entity-name-create-paths-test-secret';
const FLAG_OFF = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '0' };
const FLAG_ON = { AUTH_TOKEN_SECRET: AUTH_SECRET, OSI_SCOPED_ACCESS: '1', DEVICE_EUI: '0016C001F11715E2' };
const OWNER = { userId: 2, username: 'res1' };
const BAD_NAMES = [
  ['empty', '', 'name_empty'],
  ['blank', '   ', 'name_empty'],
  ['tab', 'Row\t7', 'name_control_characters'],
  ['next line', '\u0085North', 'name_control_characters'],
  ['over-long', 'a'.repeat(101), 'name_too_long'],
  ['lone high surrogate', '\ud83c', 'name_invalid_unicode'],
];

function token() {
  return makeAuthHeader({ userId: OWNER.userId, username: OWNER.username, secret: AUTH_SECRET });
}

async function callZoneAuth(db, name) {
  return executeFunction(loadNode('post-zone-auth'), {
    msg: {
      req: { method: 'POST', path: '/api/irrigation-zones', headers: { authorization: token() }, params: {}, body: { name } },
      payload: { name },
    },
    env: FLAG_OFF,
    db,
  });
}

async function callScopedZoneCreate(db, name) {
  return executeFunction(loadNode('scoped-zone-create-router'), {
    msg: {
      req: { method: 'POST', path: '/api/irrigation-zones', headers: { authorization: token() }, params: {}, body: { name } },
      payload: { name },
    },
    env: FLAG_ON,
    db,
  });
}

async function callDeviceAuth(db, name) {
  const body = { deveui: '70B3D57ED0061234', name, type_id: 'KIWI_SENSOR', appkey: 'A'.repeat(32) };
  return executeFunction(loadNode('post-devices-auth'), {
    msg: {
      req: { method: 'POST', path: '/api/devices', headers: { authorization: token() }, params: {}, body },
      payload: body,
    },
    env: FLAG_OFF,
    db,
  });
}

test('zone create trims and stores the normalized name', async () => {
  const db = seedScopedDb();
  try {
    const run = await callZoneAuth(db, '\ufeffNorth');
    assert.equal(run.result[1], null, JSON.stringify(run.result[1] && run.result[1].payload));
    assert.equal(run.flowState.new_zone_name, 'North');
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of BAD_NAMES) {
  test('zone create refuses a ' + label + ' name with reason ' + reason, async () => {
    const db = seedScopedDb();
    try {
      const run = await callZoneAuth(db, value);
      assert.equal(run.result[0], null);
      assert.equal(run.result[1].statusCode, 400, JSON.stringify(run.result[1].payload));
      assert.equal(run.result[1].payload.reason, reason);
      assert.equal(run.flowState.new_zone_name, undefined);
    } finally {
      db.close();
    }
  });
}

test('scoped zone create stores the normalized name on the new row', async () => {
  const db = seedScopedDb();
  try {
    const run = await callScopedZoneCreate(db, '  North block \n');
    assert.equal(run.result[1].statusCode, 201, JSON.stringify(run.result[1].payload));
    assert.equal(run.result[1].payload.name, 'North block');
    const row = db.prepare("SELECT name FROM irrigation_zones WHERE zone_uuid = ?").get(run.result[1].payload.zone_uuid);
    assert.equal(row.name, 'North block');
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of BAD_NAMES) {
  test('scoped zone create refuses a ' + label + ' name with reason ' + reason, async () => {
    const db = seedScopedDb();
    const before = db.prepare('SELECT count(*) n FROM irrigation_zones').get().n;
    try {
      const run = await callScopedZoneCreate(db, value);
      assert.equal(run.result[1].statusCode, 400, JSON.stringify(run.result[1].payload));
      assert.equal(run.result[1].payload.reason, reason);
      assert.equal(db.prepare('SELECT count(*) n FROM irrigation_zones').get().n, before);
    } finally {
      db.close();
    }
  });
}

test('device create stores the normalized name', async () => {
  const db = seedScopedDb();
  try {
    const run = await callDeviceAuth(db, '\u2028North\u2029');
    assert.equal(run.result[1], null, JSON.stringify(run.result[1] && run.result[1].payload));
    assert.equal(run.flowState.new_device_name, 'North');
  } finally {
    db.close();
  }
});

for (const [label, value, reason] of BAD_NAMES) {
  test('device create refuses a ' + label + ' name with reason ' + reason, async () => {
    const db = seedScopedDb();
    try {
      const run = await callDeviceAuth(db, value);
      assert.equal(run.result[0], null);
      assert.equal(run.result[1].statusCode, 400, JSON.stringify(run.result[1].payload));
      // An empty or blank name is still caught first by the required-field check,
      // which answers 400 without a reason code; every other violation carries one.
      if (reason !== 'name_empty') assert.equal(run.result[1].payload.reason, reason);
      assert.equal(run.flowState.new_device_name, undefined);
    } finally {
      db.close();
    }
  });
}

test('REGISTER_DEVICE keeps a valid name and never loses the registration to a bad one', () => {
  const node = loadNode('cs-reg-cloud-fn');
  assert.deepEqual(
    node.libs,
    [
      { var: 'osiDb', module: 'osi-db-helper' },
      { var: 'chirpstack', module: 'osi-chirpstack-helper' },
      { var: 'osiLib', module: 'osi-lib' },
    ],
    'cs-reg-cloud-fn must bind the osi-lib seam to reach the entity-name helper'
  );
  assert.match(node.func, /var name = String\(devEui \|\| 'Device'\);/);
  assert.match(node.func, /nameLoad\.value\.normalizeEntityName\(params\.name\)/);
  assert.match(node.func, /using the DevEUI as the label/);
  // The fallback must be a warn, never a return: a bad label cannot fail a
  // registration (spec 5.3).
  const branch = node.func.slice(node.func.indexOf("if (commandType !== 'REGISTER_DEVICE')"), node.func.indexOf("const _db = new osiDb.Database"));
  assert.doesNotMatch(branch, /return \[buildAck\('FAILED'[^)]*name/i);
});
```

- [ ] **Step 2: Run the test and watch it fail for the stated reason**

```bash
node --test scripts/test-entity-name-create-paths.js
```

Expected: the three happy-path tests fail because the current nodes store the
raw or `String.prototype.trim()`-ed value (`'\ufeffNorth'` is stored unchanged —
U+FEFF is not in the JavaScript trim set for `String.prototype.trim` in the sense
this rule needs, and `'\u2028North\u2029'` keeps its line separators); every
`reason` assertion fails with `undefined`; the `cs-reg-cloud-fn` test fails on
the `libs` deep-equal. Final `# fail 17`.

- [ ] **Step 3: Edit the four nodes in both flows.json profiles**

Save as `$SCRATCH/task9-flows-edit.js` and run from the repository root. Copy the
`guard` / `serialize` / `CANONICAL` / `MIRROR` header verbatim from Task 6
Step 3, then:

```js
const byId = new Map(flows.map((n) => [n.id, n]));

function replaceOnce(node, before, after, label) {
  const count = node.func.split(before).length - 1;
  if (count !== 1) throw new Error(label + ': expected exactly one match, found ' + count);
  node.func = node.func.replace(before, after);
}

// --- post-zone-auth -------------------------------------------------------
replaceOnce(
  byId.get('post-zone-auth'),
  [
    "const { name, timezone } = msg.payload || {};",
    "if (!name || name.trim() === '') {",
    "  msg.statusCode = 400;",
    "  msg.payload = { message: 'Zone name is required' };",
    "  return [null, msg];",
    "}",
    "flow.set('new_zone_name', name.trim());",
  ].join('\n'),
  [
    "const { name, timezone } = msg.payload || {};",
    "const nameLoad = osiLib.require('entity-name');",
    "if (!nameLoad.ok) {",
    "  node.error('Zone create name helper unavailable: ' + nameLoad.error, msg);",
    "  msg.statusCode = 500;",
    "  msg.payload = { message: 'Entity name helper unavailable' };",
    "  return [null, msg];",
    "}",
    "let normalizedZoneName = '';",
    "try {",
    "  normalizedZoneName = nameLoad.value.normalizeEntityName(name);",
    "} catch (nameError) {",
    "  msg.statusCode = 400;",
    "  msg.payload = { message: 'Zone name is not valid', reason: String(nameError && nameError.code || 'name_empty') };",
    "  return [null, msg];",
    "}",
    "flow.set('new_zone_name', normalizedZoneName);",
  ].join('\n'),
  'post-zone-auth'
);

// --- scoped-zone-create-router -------------------------------------------
replaceOnce(
  byId.get('scoped-zone-create-router'),
  [
    "  const name = String(body.name || '').trim();",
    "  if (!name) {",
    "    const error = new Error('Zone name is required');",
    "    error.statusCode = 400;",
    "    throw error;",
    "  }",
  ].join('\n'),
  [
    "  const nameLoad = osiLib.require('entity-name');",
    "  if (!nameLoad.ok) {",
    "    node.error('Scoped zone create name helper unavailable: ' + nameLoad.error, msg);",
    "    const error = new Error('Entity name helper unavailable');",
    "    error.statusCode = 500;",
    "    throw error;",
    "  }",
    "  let name = '';",
    "  try {",
    "    name = nameLoad.value.normalizeEntityName(body.name);",
    "  } catch (nameError) {",
    "    const error = new Error('Zone name is not valid');",
    "    error.statusCode = 400;",
    "    error.reason = String(nameError && nameError.code || 'name_empty');",
    "    throw error;",
    "  }",
  ].join('\n'),
  'scoped-zone-create-router'
);
replaceOnce(
  byId.get('scoped-zone-create-router'),
  [
    "  msg.payload = {",
    "    message: msg.statusCode === 403",
    "      ? 'Forbidden'",
    "      : String(error && error.message || error)",
    "  };",
    "  return [null, msg];",
  ].join('\n'),
  [
    "  msg.payload = {",
    "    message: msg.statusCode === 403",
    "      ? 'Forbidden'",
    "      : String(error && error.message || error)",
    "  };",
    "  if (error && error.reason) msg.payload.reason = String(error.reason);",
    "  return [null, msg];",
  ].join('\n'),
  'scoped-zone-create-router error shape'
);

// --- post-devices-auth ----------------------------------------------------
replaceOnce(
  byId.get('post-devices-auth'),
  [
    "flow.set('new_device_deveui', deveui_norm);",
    "flow.set('new_device_name', name);",
  ].join('\n'),
  [
    "const nameLoad = osiLib.require('entity-name');",
    "if (!nameLoad.ok) {",
    "  node.error('Device create name helper unavailable: ' + nameLoad.error, msg);",
    "  msg.statusCode = 500;",
    "  msg.payload = { message: 'Entity name helper unavailable' };",
    "  return [null, msg];",
    "}",
    "let normalizedDeviceName = '';",
    "try {",
    "  normalizedDeviceName = nameLoad.value.normalizeEntityName(name);",
    "} catch (nameError) {",
    "  msg.statusCode = 400;",
    "  msg.payload = { message: 'Device name is not valid', reason: String(nameError && nameError.code || 'name_empty') };",
    "  return [null, msg];",
    "}",
    "flow.set('new_device_deveui', deveui_norm);",
    "flow.set('new_device_name', normalizedDeviceName);",
  ].join('\n'),
  'post-devices-auth'
);

// --- cs-reg-cloud-fn ------------------------------------------------------
const csReg = byId.get('cs-reg-cloud-fn');
if (csReg.libs.some((l) => l && l.var === 'osiLib')) throw new Error('cs-reg-cloud-fn already binds osiLib');
csReg.libs.push({ var: 'osiLib', module: 'osi-lib' });
replaceOnce(
  csReg,
  "var name = String(params.name || devEui || 'Device').trim();",
  "var name = String(devEui || 'Device');",
  'cs-reg-cloud-fn default name'
);
// The normalization sits inside the REGISTER_DEVICE branch only: the same node
// also handles SYNC_LINKED_AUTH and FORCE_EDGE_SYNC, whose payloads carry no
// name, and a warn on every one of those would be pure log noise.
replaceOnce(
  csReg,
  [
    "if (commandType !== 'REGISTER_DEVICE') {",
    "  return [buildAck('FAILED', { error: 'Unsupported special command type on gateway: ' + commandType, state: 'FAILED' }), null];",
    "}",
    "",
    "const _db = new osiDb.Database('/data/db/farming.db');",
  ].join('\n'),
  [
    "if (commandType !== 'REGISTER_DEVICE') {",
    "  return [buildAck('FAILED', { error: 'Unsupported special command type on gateway: ' + commandType, state: 'FAILED' }), null];",
    "}",
    "",
    "var nameLoad = osiLib.require('entity-name');",
    "if (!nameLoad.ok) {",
    "  node.warn('CS Register (cloud cmd) name helper unavailable (' + nameLoad.error + '); using the DevEUI as the label');",
    "} else {",
    "  try {",
    "    name = nameLoad.value.normalizeEntityName(params.name);",
    "  } catch (nameError) {",
    "    node.warn('CS Register (cloud cmd) rejected the requested name for ' + devEui + ' (' + String(nameError && nameError.code || 'name_invalid') + '); using the DevEUI as the label');",
    "  }",
    "}",
    "",
    "const _db = new osiDb.Database('/data/db/farming.db');",
  ].join('\n'),
  'cs-reg-cloud-fn normalization'
);

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
console.log('Wrote canonical + mirror. Node count:', flows.length);
guard(CANONICAL);
guard(MIRROR);
```

Expected output: pre-write `byte-identical: true` lines at the Task 8 size,
`Wrote canonical + mirror. Node count: 735` (no node added), post-write
`byte-identical: true` lines. Every `replaceOnce` throwing
`expected exactly one match, found 0` means the node text has moved since this
plan was written: re-read the node with
`node -e "const f=require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');console.log(f.find(n=>n.id==='<id>').func)"`
and re-derive the anchor rather than loosening it.

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test scripts/test-entity-name-create-paths.js
```

Expected: `# pass 17`, `# fail 0`, exit 0.

- [ ] **Step 5: Add the verify-sync-flow assertions**

Add, next to the other create-path assertions:

```js
expectLibById('cs-reg-cloud-fn', 'osiLib', 'osi-lib', 'loads the entity-name helper through the osi-lib seam');
expectIncludesById('post-zone-auth', "osiLib.require('entity-name')", 'applies the shared name rule to zone creation');
expectIncludesById('post-zone-auth', "reason: String(nameError && nameError.code", 'returns the zone name reason code on a 400');
expectExcludesById('post-zone-auth', "if (!name || name.trim() === '') {", 'the ad hoc zone-name check');
expectIncludesById('scoped-zone-create-router', "osiLib.require('entity-name')", 'applies the shared name rule to scoped zone creation');
expectIncludesById('scoped-zone-create-router', 'if (error && error.reason) msg.payload.reason = String(error.reason);', 'surfaces the name reason code on a scoped 400');
expectIncludesById('post-devices-auth', "osiLib.require('entity-name')", 'applies the shared name rule to device creation');
expectIncludesById('post-devices-auth', "flow.set('new_device_name', normalizedDeviceName);", 'hands post-devices-insert the normalized device name');
expectOrderedIncludesById('cs-reg-cloud-fn', [
  "var name = String(devEui || 'Device');",
  "if (commandType !== 'REGISTER_DEVICE') {",
  "var nameLoad = osiLib.require('entity-name');",
  'nameLoad.value.normalizeEntityName(params.name)',
  'using the DevEUI as the label',
], 'falls back to the DevEUI label instead of failing a registration on a bad name');
```

- [ ] **Step 6: Record the size-ratchet entries**

```bash
node -e "
const { nodeSizes, totalChars } = require('./scripts/flows-size-scan');
const f = require('./conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const s = nodeSizes(f);
for (const id of ['post-zone-auth','scoped-zone-create-router','post-devices-auth','cs-reg-cloud-fn']) console.log(id, s.get(id).chars);
console.log('profile total', totalChars(f));
"
```

`post-zone-auth` (5468 at base, 1947 allowance), `post-devices-auth` (6218 /
1953) and `cs-reg-cloud-fn` (19838 / 5391) are expected to fit their existing
headroom. **`scoped-zone-create-router` has no `node_allowances` entry at all**
(its 3962 figure in `new_node_ceilings` applies only while a node is absent from
the base ref, which it no longer is), so any growth fails the ratchet. Add:

```json
    "scoped-zone-create-router": {
      "delta": <measured HEAD chars - origin/main chars>,
      "reason": "Zone/device rename Stage 1, Task 9. The scoped zone create route now normalizes the requested name through osi-entity-name's normalizeEntityName (osiLib.require('entity-name')) instead of String.prototype.trim(), so create and rename accept exactly the same names, and its 400 carries the reason code the GUI translates. Measured with verify-flows-size-ratchet's nodeSizes over both byte-identical profiles: origin/main <n> -> HEAD <n>."
    }
```

with both numbers taken from:

```bash
node -e "
const { execFileSync } = require('node:child_process');
const { nodeSizes } = require('./scripts/flows-size-scan');
const rel = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const base = nodeSizes(JSON.parse(execFileSync('git', ['show', 'origin/main:' + rel], { encoding: 'utf8', maxBuffer: 67108864 })));
const head = nodeSizes(require('./' + rel));
for (const id of ['post-zone-auth','scoped-zone-create-router','post-devices-auth','cs-reg-cloud-fn']) {
  console.log(id, 'base', base.get(id).chars, '-> head', head.get(id).chars, 'delta', head.get(id).chars - base.get(id).chars);
}
"
```

Set `total_allowance.delta` from a fresh measurement against `origin/main` with
the command in "Setting a size-ratchet number", never by adding this task's
increase to what Task 8 wrote. Re-run
`node scripts/verify-flows-size-ratchet.js`; expected
`verify-flows-size-ratchet: OK (...)`, exit 0.

- [ ] **Step 7: No osi-lib-binding-audit change, and prove it**

None of the four nodes is in `TASK9_OSI_LIB_NODE_POLICIES` — all four bind
`crypto`, `osiDb` or `osi-chirpstack-helper` alongside `osiLib`, which
`hasExactOsiLibOnly` rejects. Prove the policy set is untouched:

```bash
node --test scripts/osi-lib-binding-audit.test.js
```

Expected: `# pass 9` (the count from Task 8 onward), `# fail 0`, exit 0.

- [ ] **Step 8: Extend the CI step and run the gate set**

```yaml
        run: |
          node --test scripts/test-zone-rename-route.js \
            scripts/test-device-rename-route.js \
            scripts/test-entity-name-command-path.js \
            scripts/test-entity-name-create-paths.js
```

Run the Task 6 Step 9 table in full. Two rows matter especially here:
`node scripts/verify-auth-flag-off-hermetic.js` (the new
`osiLib.require('entity-name')` call in `post-zone-auth` and `post-devices-auth`
is unconditional, which is allowed — only `osiLib.require('scope')` is banned on
the flag-off path) and `node scripts/test-scoped-access-writes.js`-style
behavioural coverage, which runs inside `node scripts/verify-sync-flow.js`.

Also re-run the three device-registration tests that execute these nodes:

```bash
node scripts/test-sdi12-registration.js
node --test scripts/test-scoped-access-writes.js
node scripts/test-zone-device-assignment-flow.js
```

Expected: exit 0 each. `test-scoped-access-writes.js` covers
`W3: scoped zone creation atomically grants the creator` and
`W5: registration accepts an optional in-scope zone_id` — both build names that
satisfy the rule, so neither should need editing; if one does, the fixture name
is what changes, never the assertion.

- [ ] **Step 9: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-entity-name-create-paths.js \
        scripts/verify-sync-flow.js \
        scripts/verify-flows-size-ratchet-allowances.json \
        .github/workflows/verify-sync-flow.yml
git commit -m "fix(names): apply one name rule to zone and device creation"
```

---

### Task 10: Legacy `UPSERT_ZONE` branch of node `4f4a765f36cee6f3`

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (node `4f4a765f36cee6f3`, "Build UPDATE SQL")
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` (mirror)
- Create: `scripts/test-legacy-upsert-zone-name.js`
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `.github/workflows/verify-sync-flow.yml`

**Interfaces:**
- Consumes (Task 1): `normalizeEntityName(raw)` as in Task 6.
- Produces: the `UPSERT_ZONE` branch emits `name=excluded.name` only for a name
  that passes the rule; otherwise `name=irrigation_zones.name` on conflict and
  `'Zone'` on a first insert, with a `node.warn` for the invalid case.

How the node gets the rule. `4f4a765f36cee6f3` ships with `libs: []` today and
runs as plain synchronous top-level code (no `return (async () => …)` wrapper).
Per `.claude/skills/osi-flows-json-editing/SKILL.md`, a new in-repo module is
reached by binding the loader (`libs: [{ var: 'osiLib', module: 'osi-lib' }]`)
and calling `osiLib.require('entity-name')` at the point of use; a bare
`require()` would fail `node scripts/flows-bare-require-scan.js`, and binding
`osi-entity-name` directly would bypass the registry that
`node scripts/verify-helper-registration.js` checks. `osiLib.require` is
synchronous and never throws, so the node needs no async wrapper and no new
`await`: the existing top-level shape is preserved and the harnesses that build
the node with a plain `new Function(...)` keep working.

The spec's suggested SQL form was
`name = CASE WHEN <valid name> THEN excluded.name ELSE irrigation_zones.name END`.
Validity is already known in JavaScript at the moment the statement is built, so
this task emits either `excluded.name` or `irrigation_zones.name` and skips the
`CASE`. The observable behaviour is identical and the statement stays shorter,
which the size ratchet rewards.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-legacy-upsert-zone-name.js`:

```js
#!/usr/bin/env node
'use strict';

// Legacy UPSERT_ZONE branch of node 4f4a765f36cee6f3 ("Build UPDATE SQL").
// Builds the statement with the shipped function-node source and then runs it
// against a seeded database, so the assertions are about the row, not the SQL
// string.
//
// Run: node --test scripts/test-legacy-upsert-zone-name.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/scoped-access-harness');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = '0016C001F11715E2';
const ZONE_UUID = '44444444-4444-4444-8444-444444444444';
const USER_UUID = '55555555-5555-4555-8555-555555555555';

function fixture({ withZone }) {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) "
    + `VALUES (1,'grower','x','2026-01-01','${USER_UUID}','admin',1)`);
  if (withZone) {
    db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, '
      + 'timezone, created_at, updated_at) '
      + `VALUES (1,'Stored name',1,'${ZONE_UUID}','${GATEWAY}',3,'UTC','2026-01-01','2026-01-01')`);
  }
  return db;
}

function command(name) {
  const cmd = {
    commandType: 'UPSERT_ZONE',
    zoneUuid: ZONE_UUID,
    gatewayDeviceEui: GATEWAY,
    syncVersion: 9,
    user: { userUuid: USER_UUID },
  };
  if (name !== undefined) cmd.name = name;
  return cmd;
}

async function buildAndApply(db, name) {
  const run = await executeFunction(loadNode('4f4a765f36cee6f3'), {
    msg: { payload: command(name) },
    env: { DEVICE_EUI: GATEWAY },
    db,
  });
  assert.equal(typeof run.result.topic, 'string', 'the node must build a statement');
  db.exec(run.result.topic);
  return run;
}

test('a valid name is written, exactly as today', async () => {
  const db = fixture({ withZone: true });
  try {
    await buildAndApply(db, '  North block \n');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'North block');
  } finally {
    db.close();
  }
});

test('a missing name keeps the stored name and does not warn', async () => {
  const db = fixture({ withZone: true });
  try {
    const run = await buildAndApply(db, undefined);
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Stored name');
    assert.deepEqual(run.warnings, []);
  } finally {
    db.close();
  }
});

for (const [label, value, code] of [
  ['blank', '   ', 'name_empty'],
  ['over-long', 'a'.repeat(101), 'name_too_long'],
  ['control character', 'Row\t7', 'name_control_characters'],
  ['lone surrogate', '\ud83c', 'name_invalid_unicode'],
]) {
  test('a ' + label + ' name keeps the stored name and warns', async () => {
    const db = fixture({ withZone: true });
    try {
      const run = await buildAndApply(db, value);
      assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE id=1').get().name, 'Stored name');
      assert.ok(run.warnings.some((w) => w.includes(code)), JSON.stringify(run.warnings));
    } finally {
      db.close();
    }
  });
}

test('an invalid name on a first insert falls back to Zone', async () => {
  const db = fixture({ withZone: false });
  try {
    const run = await buildAndApply(db, 'Row\t7');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name, 'Zone');
    assert.ok(run.warnings.some((w) => w.includes('name_control_characters')), JSON.stringify(run.warnings));
  } finally {
    db.close();
  }
});

test('a missing name on a first insert falls back to Zone', async () => {
  const db = fixture({ withZone: false });
  try {
    await buildAndApply(db, undefined);
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name, 'Zone');
  } finally {
    db.close();
  }
});

test('a valid name on a first insert is written', async () => {
  const db = fixture({ withZone: false });
  try {
    await buildAndApply(db, 'Fresh zone');
    assert.equal(db.prepare('SELECT name FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).name, 'Fresh zone');
  } finally {
    db.close();
  }
});

test('the node binds the osi-lib seam on both profiles and bare-requires nothing', () => {
  for (const profile of ['bcm2712', 'bcm2709']) {
    const flows = JSON.parse(fs.readFileSync(path.join(
      ROOT, 'conf/full_raspberrypi_bcm27xx_' + profile + '/files/usr/share/flows.json'
    ), 'utf8'));
    const node = flows.find((n) => n.id === '4f4a765f36cee6f3');
    assert.deepEqual(node.libs, [{ var: 'osiLib', module: 'osi-lib' }], profile);
    assert.match(node.func, /osiLib\.require\('entity-name'\)/, profile);
    assert.doesNotMatch(node.func, /\brequire\(\s*'\.\.?\//, profile);
  }
});
```

- [ ] **Step 2: Run the test and watch it fail for the stated reason**

```bash
node --test scripts/test-legacy-upsert-zone-name.js
```

Expected: the missing-name and invalid-name tests fail because today's branch
writes `s(cmd.name || 'Zone')` into `name=excluded.name`, so the stored name
becomes `Zone` or the invalid string; the `libs` test fails on `[]`. The "valid
name" tests fail too, because today's `s(cmd.name || 'Zone')` stores the
untrimmed `'  North block \n'`. Final `# fail 8`.

- [ ] **Step 3: Edit the node in both flows.json profiles**

Save as `$SCRATCH/task10-flows-edit.js` and run from the repository root. Copy
the `guard` / `serialize` / `CANONICAL` / `MIRROR` header verbatim from Task 6
Step 3, then:

```js
const node = flows.find((n) => n.id === '4f4a765f36cee6f3');
if (!node) throw new Error('node 4f4a765f36cee6f3 not found');
if (node.name !== 'Build UPDATE SQL') throw new Error('unexpected node name: ' + node.name);

function replaceOnce(before, after, label) {
  const count = node.func.split(before).length - 1;
  if (count !== 1) throw new Error(label + ': expected exactly one match, found ' + count);
  node.func = node.func.replace(before, after);
}

if (node.libs.length !== 0) throw new Error('4f4a765f36cee6f3 already declares libs');
node.libs = [{ var: 'osiLib', module: 'osi-lib' }];

// 1. Decide validity in JS, before the statement is built.
replaceOnce(
  "  if (schedulingMode !== 'server_preferred') schedulingMode = 'local';",
  [
    "  if (schedulingMode !== 'server_preferred') schedulingMode = 'local';",
    "  var zoneName = null;",
    "  var nameLoad = osiLib.require('entity-name');",
    "  if (!nameLoad.ok) {",
    "    node.warn('Build UPDATE SQL: entity-name helper unavailable (' + nameLoad.error + '); keeping the stored zone name');",
    "  } else if (cmd.name !== undefined && cmd.name !== null) {",
    "    try {",
    "      zoneName = nameLoad.value.normalizeEntityName(cmd.name);",
    "    } catch (nameError) {",
    "      node.warn('Build UPDATE SQL: legacy UPSERT_ZONE carried an invalid name for ' + String(zoneUuid) + ' (' + String(nameError && nameError.code || 'name_invalid') + '); keeping the stored zone name');",
    "    }",
    "  }",
    "  var insertName = zoneName === null ? \"'Zone'\" : s(zoneName);",
    "  var conflictName = zoneName === null ? 'irrigation_zones.name' : 'excluded.name';",
  ].join('\n'),
  'UPSERT_ZONE name decision'
);

// 2. First insert: a rejected or absent name falls back to 'Zone'.
replaceOnce(
  "s(cmd.name || 'Zone')",
  'insertName',
  'UPSERT_ZONE insert name'
);

// 3. On conflict: a rejected or absent name leaves the stored name alone.
replaceOnce(
  '"ON CONFLICT(zone_uuid) DO UPDATE SET name=excluded.name,',
  '"ON CONFLICT(zone_uuid) DO UPDATE SET name=" + conflictName + ",',
  'UPSERT_ZONE conflict name'
);

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
console.log('Wrote canonical + mirror. Node count:', flows.length);
guard(CANONICAL);
guard(MIRROR);
```

Expected output: pre-write `byte-identical: true` lines at the Task 9 size,
`Wrote canonical + mirror. Node count: 735`, post-write `byte-identical: true`
lines.

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test scripts/test-legacy-upsert-zone-name.js
```

Expected: `# pass 8`, `# fail 0`, exit 0.

- [ ] **Step 5: Add the verify-sync-flow assertions**

Next to the existing `expectIncludes('Build UPDATE SQL', 'cmd.device_eui', …)`
assertion:

```js
expectLibById('4f4a765f36cee6f3', 'osiLib', 'osi-lib', 'loads the entity-name helper through the osi-lib seam');
expectOrderedIncludesById('4f4a765f36cee6f3', [
  "if (commandType === 'UPSERT_ZONE') {",
  "var nameLoad = osiLib.require('entity-name');",
  'nameLoad.value.normalizeEntityName(cmd.name)',
  "var insertName = zoneName === null ? \"'Zone'\" : s(zoneName);",
  "var conflictName = zoneName === null ? 'irrigation_zones.name' : 'excluded.name';",
  '"ON CONFLICT(zone_uuid) DO UPDATE SET name=" + conflictName + ",',
], 'runs a legacy UPSERT_ZONE name through the rule and keeps the stored name when it fails');
expectExcludesById('4f4a765f36cee6f3', "s(cmd.name || 'Zone')", 'the unguarded legacy zone-name fallback that renamed a zone to "Zone"');
expectIncludesById('4f4a765f36cee6f3', 'keeping the stored zone name', 'warns instead of silently discarding an invalid legacy zone name');
```

- [ ] **Step 6: Record the size-ratchet entries**

```bash
node -e "
const { execFileSync } = require('node:child_process');
const { nodeSizes, totalChars } = require('./scripts/flows-size-scan');
const rel = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const base = nodeSizes(JSON.parse(execFileSync('git', ['show', 'origin/main:' + rel], { encoding: 'utf8', maxBuffer: 67108864 })));
const head = nodeSizes(require('./' + rel));
console.log('4f4a765f36cee6f3 base', base.get('4f4a765f36cee6f3').chars, '-> head', head.get('4f4a765f36cee6f3').chars);
console.log('profile total', totalChars(require('./' + rel)));
"
```

`4f4a765f36cee6f3` measures 18655 at base with a standing allowance of only
**428**, and this change adds roughly 900 characters, so the entry must be
raised. Supersede it in `node_allowances`:

```json
    "4f4a765f36cee6f3": {
      "delta": <measured head - base>,
      "reason": "Supersedes the prior 428 entry, which this change consumes in full. Zone/device rename Stage 1, Task 10 (spec 5.7, defect 5): the legacy UPSERT_ZONE branch built s(cmd.name || 'Zone') into an unguarded ON CONFLICT ... SET name=excluded.name, so a legacy-shaped command without a name renamed an existing zone to 'Zone'. The branch now runs cmd.name through osi-entity-name's normalizeEntityName (reached with osiLib.require('entity-name'); the node gains its first libs binding) and emits name=excluded.name only for a valid name, name=irrigation_zones.name otherwise, with 'Zone' still the first-insert fallback and a node.warn on the invalid case. Measured with verify-flows-size-ratchet's nodeSizes over both byte-identical profiles: origin/main <n> -> HEAD <n>."
    }
```

Set `total_allowance.delta` from a fresh measurement against `origin/main` with
the command in "Setting a size-ratchet number", never by adding this task's
increase to what Task 9 wrote. This is the last of the five tasks that touch the
file, so the number you write here is the branch's final one. Re-run
`node scripts/verify-flows-size-ratchet.js`; expected
`verify-flows-size-ratchet: OK (...)`, exit 0.

- [ ] **Step 7: No osi-lib-binding-audit change, and prove it**

`4f4a765f36cee6f3` now binds exactly `[{ var: 'osiLib', module: 'osi-lib' }]`,
which `hasExactOsiLibOnly` would accept, but the node is deliberately **not**
added to `TASK9_OSI_LIB_NODE_POLICIES`: that policy set pins the command-apply
delegation chain and its SHA-256 would have to be re-reviewed on every
unrelated legacy SQL edit to this 18 KB node. Leaving it out keeps it on
`verify-sync-flow.js`'s ordinary guarded-module check, which is satisfied because
`osiLib` is declared. Prove the policy set is untouched:

```bash
node --test scripts/osi-lib-binding-audit.test.js
```

Expected: `# pass 9`, `# fail 0`, exit 0.

- [ ] **Step 8: Extend the CI step and run the gate set**

```yaml
        run: |
          node --test scripts/test-zone-rename-route.js \
            scripts/test-device-rename-route.js \
            scripts/test-entity-name-command-path.js \
            scripts/test-entity-name-create-paths.js \
            scripts/test-legacy-upsert-zone-name.js
```

Run the Task 6 Step 9 table in full, plus the two gates this node sits under:

| Gate | Command | Pass signal |
|---|---|---|
| Stray DDL ratchet | `node scripts/verify-no-stray-ddl.js` | exit 0; this task adds no `CREATE`/`ALTER` marker |
| Zone command path | `node --test scripts/test-zone-command-path.js` | `# fail 0`, exit 0 |
| Upsert sync versioning | `node --test scripts/test-upsert-sync-versioning.js` | `# fail 0`, exit 0 |

- [ ] **Step 9: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
        scripts/test-legacy-upsert-zone-name.js \
        scripts/verify-sync-flow.js \
        scripts/verify-flows-size-ratchet-allowances.json \
        .github/workflows/verify-sync-flow.yml
git commit -m "fix(zones): stop a nameless legacy UPSERT_ZONE renaming a zone to Zone"
```

---

### Task 11: the name rule in TypeScript

**Files:**
- Create: `web/react-gui/src/utils/entityName.ts`
- Test: `web/react-gui/src/utils/__tests__/entityName.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const ENTITY_NAME_MAX = 100;
  export type EntityNameReason =
    'name_empty' | 'name_too_long' | 'name_control_characters' | 'name_invalid_unicode';
  export type EntityNameResult =
    | { ok: true; name: string }
    | { ok: false; reason: EntityNameReason };
  export function normalizeEntityName(raw: string): EntityNameResult;
  ```

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/utils/__tests__/entityName.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { ENTITY_NAME_MAX, normalizeEntityName } from '../entityName';

// The sixteen vectors of the rename design, section 4, in the order the design
// lists them. Every character that is not plain ASCII is written as a \u escape
// so a diff shows it and no editor can normalise it away.
describe('normalizeEntityName', () => {
  it('keeps a plain name unchanged', () => {
    expect(normalizeEntityName('North block')).toEqual({ ok: true, name: 'North block' });
  });

  it('strips ASCII spaces and a trailing line feed', () => {
    expect(normalizeEntityName('  North block \u000a')).toEqual({ ok: true, name: 'North block' });
  });

  it('strips a no-break space at both ends', () => {
    expect(normalizeEntityName('\u00a0Bloc nord\u00a0')).toEqual({ ok: true, name: 'Bloc nord' });
  });

  it('strips a byte-order mark', () => {
    expect(normalizeEntityName('\ufeffNorth')).toEqual({ ok: true, name: 'North' });
  });

  it('strips a line separator and a paragraph separator at the ends', () => {
    expect(normalizeEntityName('\u2028North\u2029')).toEqual({ ok: true, name: 'North' });
  });

  it('rejects an empty string', () => {
    expect(normalizeEntityName('')).toEqual({ ok: false, reason: 'name_empty' });
  });

  it('rejects whitespace only', () => {
    expect(normalizeEntityName('   ')).toEqual({ ok: false, reason: 'name_empty' });
  });

  it('rejects an interior tab', () => {
    // '\u0009' is the tab; the '7' that follows it is a separate character.
    expect(normalizeEntityName('Row\u00097')).toEqual({ ok: false, reason: 'name_control_characters' });
  });

  it('rejects an interior NUL', () => {
    expect(normalizeEntityName('Row\u00007')).toEqual({ ok: false, reason: 'name_control_characters' });
  });

  it('rejects an interior line separator', () => {
    expect(normalizeEntityName('A\u2028B')).toEqual({ ok: false, reason: 'name_control_characters' });
  });

  it('rejects U+0085, which is Cc and outside the trim set', () => {
    expect(normalizeEntityName('\u0085North')).toEqual({ ok: false, reason: 'name_control_characters' });
  });

  it('accepts exactly 100 code points', () => {
    const name = 'a'.repeat(ENTITY_NAME_MAX);
    expect(normalizeEntityName(name)).toEqual({ ok: true, name });
  });

  it('rejects 101 code points', () => {
    expect(normalizeEntityName('a'.repeat(ENTITY_NAME_MAX + 1)))
      .toEqual({ ok: false, reason: 'name_too_long' });
  });

  it('counts code points, not UTF-16 units', () => {
    // 100 seedlings: 100 code points, 200 UTF-16 units. The cloud column is
    // VARCHAR(100), which counts code points too, so this must be accepted.
    const name = '\ud83c\udf31'.repeat(ENTITY_NAME_MAX);
    expect(name.length).toBe(200);
    expect(normalizeEntityName(name)).toEqual({ ok: true, name });
  });

  it('rejects a lone high surrogate', () => {
    expect(normalizeEntityName('\ud83c')).toEqual({ ok: false, reason: 'name_invalid_unicode' });
  });

  it('rejects a lone low surrogate', () => {
    expect(normalizeEntityName('\udf31x')).toEqual({ ok: false, reason: 'name_invalid_unicode' });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd web/react-gui && npx vitest run src/utils/__tests__/entityName.test.ts
```

Expected: the run fails before any assertion, with
`Failed to resolve import "../entityName"`.

- [ ] **Step 3: Write the implementation**

Create `web/react-gui/src/utils/entityName.ts`:

```ts
/**
 * The name rule of the zone and device rename design, section 4, in the exact
 * order the design runs it. The edge module `osi-entity-name` and the cloud's
 * `EntityNames` implement the same five steps against the same sixteen
 * vectors; a name this file accepts must be a name those two accept, so the
 * three may only change together.
 */

export const ENTITY_NAME_MAX = 100;

export type EntityNameReason =
  | 'name_empty'
  | 'name_too_long'
  | 'name_control_characters'
  | 'name_invalid_unicode';

export type EntityNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: EntityNameReason };

// Categories Cc (U+0000-U+001F and U+007F-U+009F), Zl (U+2028) and Zp
// (U+2029), spelled out rather than written as \p{Cc}: the property escape
// needs the u flag and ES2018, and the edge module's copy of this regex has to
// behave identically on the gateway's Node build.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * True when `value` holds a surrogate code unit without its partner. SQLite and
 * PostgreSQL store UTF-8 and cannot represent one; JavaScript can hold it, so
 * the check has to happen before the value reaches a route.
 *
 * `String.prototype.isWellFormed` answers this in one call but is ES2024, and
 * this project compiles against `"lib": ["ES2020", "DOM", "DOM.Iterable"]`
 * (tsconfig.json), so the call would neither typecheck nor exist on an older
 * browser. Scanning code units is the portable form.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function normalizeEntityName(raw: string): EntityNameResult {
  // The type guard is not decoration: the modals hand this whatever their
  // input state holds, and a caller compiled from JavaScript can pass anything.
  if (typeof raw !== 'string' || hasLoneSurrogate(raw)) {
    return { ok: false, reason: 'name_invalid_unicode' };
  }

  // String.prototype.trim strips exactly the set the rule names: WhiteSpace
  // plus LineTerminator, which is U+0009, U+000A, U+000B, U+000C, U+000D,
  // U+0020, U+00A0, U+2028, U+2029, U+FEFF and every character of category Zs.
  // U+0085 is not in it, which is why that vector reaches the control-character
  // step instead of being trimmed. Java's trim() and strip() use other sets,
  // which is why the Java implementation spells the set out and this one does
  // not have to.
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'name_empty' };
  }

  // Code points, never UTF-16 units: 100 astral characters are 200 units and
  // still fit the cloud's VARCHAR(100).
  if (Array.from(trimmed).length > ENTITY_NAME_MAX) {
    return { ok: false, reason: 'name_too_long' };
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: 'name_control_characters' };
  }

  return { ok: true, name: trimmed };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd web/react-gui && npx vitest run src/utils/__tests__/entityName.test.ts
```

Expected: `Test Files  1 passed (1)`, `Tests  16 passed (16)`, exit 0.

- [ ] **Step 5: Typecheck**

```bash
cd web/react-gui && npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/react-gui/src/utils/entityName.ts web/react-gui/src/utils/__tests__/entityName.test.ts
git commit -m "feat(gui): add the entity name rule helper"
```

---

### Task 12: the shared `EditableName` component

**Files:**
- Create: `web/react-gui/src/components/farming/shared/EditableName.tsx`
- Test: `web/react-gui/src/components/farming/__tests__/EditableName.test.tsx`

**Interfaces:**
- Consumes: `ENTITY_NAME_MAX`, `normalizeEntityName` from Task 11.
- Produces:
  ```ts
  export interface EditableNameProps {
    name: string;
    canEdit: boolean;
    onSave: (name: string) => Promise<void>;
    renameLabel: string;
    inputLabel: string;
    headingClassName?: string;
  }
  export const EditableName: React.FC<EditableNameProps>;
  ```
  Task 13 renders it in eight places and supplies `onSave` from `api.ts`.

The project has no icon library. `web/react-gui/package.json` lists
`echarts`, `leaflet`, `recharts` and `swr` and nothing else drawing icons, and
the existing glyph controls are literal characters (`⚙`, `✕`). The pencil is
therefore an inline SVG, the same choice `ValveGlyph.tsx` makes.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/components/farming/__tests__/EditableName.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditableName } from '../shared/EditableName';

// t() returns the key itself, matching this codebase's convention
// (Sdi12SoilCard.test.tsx, CreateZoneModal.uicore.test.tsx).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const PENCIL = 'rename.device';
const INPUT = 'rename.deviceInputLabel';

function renderName(overrides: {
  name?: string;
  canEdit?: boolean;
  onSave?: (name: string) => Promise<void>;
} = {}) {
  const onSave = overrides.onSave ?? vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);
  render(
    <EditableName
      name={overrides.name ?? 'North block'}
      canEdit={overrides.canEdit ?? true}
      onSave={onSave}
      renameLabel={PENCIL}
      inputLabel={INPUT}
      headingClassName="truncate text-base font-semibold"
    />,
  );
  return { onSave };
}

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: PENCIL }));
  return screen.getByLabelText(INPUT);
}

describe('EditableName read mode', () => {
  it('renders the heading with the caller classes and a pencil when editing is allowed', () => {
    renderName();
    const heading = screen.getByRole('heading', { name: 'North block' });
    expect(heading.className).toContain('truncate');
    expect(screen.getByRole('button', { name: PENCIL })).toBeInTheDocument();
  });

  it('hides the pencil when editing is not allowed', () => {
    renderName({ canEdit: false });
    expect(screen.getByRole('heading', { name: 'North block' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PENCIL })).not.toBeInTheDocument();
  });
});

describe('EditableName saving', () => {
  it('saves the trimmed value on Enter', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: '  South block  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('South block'));
    await waitFor(() => expect(screen.getByRole('button', { name: PENCIL })).toBeInTheDocument());
  });

  it('saves on blur', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('South block'));
  });

  it('calls onSave once for Enter and the blur Enter causes', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('calls onSave once for a fast double trigger', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('closes without saving when the name did not change', async () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: '  North block  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('button', { name: PENCIL })).toBeInTheDocument());
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('EditableName cancelling', () => {
  it('restores the name and focuses the pencil on Escape', () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'North block' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PENCIL })).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('EditableName rejection', () => {
  it('blocks a blank name client-side', () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('rename.reason.name_empty');
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText(INPUT)).toBeInTheDocument();
  });

  it('blocks an over-long name client-side', () => {
    const { onSave } = renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'a'.repeat(101) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('rename.reason.name_too_long');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('ties the error to the input for assistive technology', () => {
    renderName();
    const input = openEditor();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const alert = screen.getByRole('alert');
    expect(alert.id).toBeTruthy();
    expect(screen.getByLabelText(INPUT)).toHaveAttribute('aria-describedby', alert.id);
  });

  it('shows the translated reason a rejected save carries', async () => {
    const failure = Object.assign(new Error('Name is too long'), { reason: 'name_too_long' });
    const { onSave } = renderName({ onSave: vi.fn().mockRejectedValue(failure) });
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('rename.reason.name_too_long'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(INPUT)).toBeInTheDocument();
  });

  it('falls back to the generic failure text for an error with no known reason', async () => {
    renderName({ onSave: vi.fn().mockRejectedValue(new Error('Network Error')) });
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('rename.failed'));
  });

  it('allows a second attempt after a rejection', async () => {
    const onSave = vi.fn<[string], Promise<void>>()
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce(undefined);
    renderName({ onSave });
    const input = openEditor();
    fireEvent.change(input, { target: { value: 'South block' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByLabelText(INPUT), { key: 'Enter' });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd web/react-gui && npx vitest run src/components/farming/__tests__/EditableName.test.tsx
```

Expected: the run fails before any assertion, with
`Failed to resolve import "../shared/EditableName"`.

- [ ] **Step 3: Write the implementation**

Create `web/react-gui/src/components/farming/shared/EditableName.tsx`:

```tsx
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ENTITY_NAME_MAX, normalizeEntityName } from '../../../utils/entityName';

export interface EditableNameProps {
  name: string;
  canEdit: boolean;
  /** Rejects with an error carrying `reason?: string` when the route answers 400. */
  onSave: (name: string) => Promise<void>;
  /** aria-label and title of the pencil button. */
  renameLabel: string;
  /** aria-label of the text input. */
  inputLabel: string;
  /** The read-mode heading's classes, so each card keeps its own look. */
  headingClassName?: string;
}

// The reason codes the routes send. An unknown string from a newer gateway
// falls back to the generic failure text instead of rendering a raw key.
const REASON_CODES: ReadonlySet<string> = new Set([
  'name_empty',
  'name_too_long',
  'name_control_characters',
  'name_invalid_unicode',
]);

// The treatment the ⚙ control next to the name already uses (Sdi12SoilCard.tsx),
// so the pencil sits on the same 48 px target its neighbour does.
const PENCIL_CLASS =
  'touch-target shrink-0 rounded-md p-1.5 text-[var(--text-tertiary)] transition-colors ' +
  'hover:bg-[var(--card)] hover:text-[var(--text)] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]';

// ui-core's INPUT_CLASS tokens (--card, --field-border, --focus, --text) in the
// compact form a card heading row needs. INPUT_CLASS itself is the modal
// treatment (px-4 py-4 text-lg) and would be taller than the card header.
const INPUT_CLASS_COMPACT =
  'touch-target w-full rounded-lg border-2 border-[var(--field-border)] bg-[var(--card)] ' +
  'px-2 py-1 text-base text-[var(--text)] ' +
  'focus:border-[var(--focus)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)]';

export const EditableName: React.FC<EditableNameProps> = ({
  name,
  canEdit,
  onSave,
  renameLabel,
  inputLabel,
  headingClassName,
}) => {
  const { t } = useTranslation('devices');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const pencilRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refs, not state: all three guards are read and written inside one event
  // handler, before React has re-rendered.
  //   saving       — one in-flight save. Enter closes the editor, which blurs
  //                  the input, and the blur handler would otherwise save the
  //                  same value a second time.
  //   suppressBlur — the blur that closing the editor causes belongs to the
  //                  close, not to a new save attempt. Escape and a successful
  //                  save both set it.
  //   restoreFocus — the pencil is unmounted while editing, so focus can only
  //                  be returned after the next render.
  const savingRef = useRef(false);
  const suppressBlurRef = useRef(false);
  const restoreFocusRef = useRef(false);

  // A rename that lands from elsewhere (the SWR poll, another browser) must
  // reach the heading. While the operator is typing, the draft wins.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [editing, name]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      pencilRef.current?.focus();
    }
  }, [editing]);

  const closeEditor = useCallback(() => {
    suppressBlurRef.current = true;
    restoreFocusRef.current = true;
    setError(null);
    setEditing(false);
  }, []);

  const startEdit = useCallback(() => {
    suppressBlurRef.current = false;
    setDraft(name);
    setError(null);
    setEditing(true);
  }, [name]);

  const commit = useCallback(async () => {
    if (savingRef.current) return;

    const result = normalizeEntityName(draft);
    if (!result.ok) {
      setError(t(`rename.reason.${result.reason}`));
      return;
    }
    if (result.name === name) {
      closeEditor();
      return;
    }

    savingRef.current = true;
    try {
      await onSave(result.name);
      closeEditor();
    } catch (caught) {
      const reason = (caught as { reason?: unknown } | null | undefined)?.reason;
      setError(
        typeof reason === 'string' && REASON_CODES.has(reason)
          ? t(`rename.reason.${reason}`)
          : t('rename.failed'),
      );
    } finally {
      savingRef.current = false;
    }
  }, [closeEditor, draft, name, onSave, t]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(name);
      closeEditor();
    }
  };

  const handleBlur = () => {
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    void commit();
  };

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        {/* min-w-0 is what lets the caller's `truncate` still shrink now that
            the heading sits inside a flex row of its own. */}
        <h3 className={headingClassName ? `min-w-0 ${headingClassName}` : 'min-w-0'}>{name}</h3>
        {canEdit && (
          <button
            type="button"
            ref={pencilRef}
            onClick={startEdit}
            aria-label={renameLabel}
            title={renameLabel}
            className={PENCIL_CLASS}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              aria-hidden="true"
              focusable="false"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11.5 1.8a1.7 1.7 0 0 1 2.7 2.7L5.4 13.3 1.8 14.2l0.9-3.6 8.8-8.8Z" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        aria-label={inputLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        // The attribute counts UTF-16 units, the rule counts code points, and
        // 100 code points are at most 200 units — so this cap can never cut a
        // name the rule accepts. normalizeEntityName enforces the real limit.
        maxLength={ENTITY_NAME_MAX * 2}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={INPUT_CLASS_COMPACT}
      />
      {error && (
        <p id={errorId} role="alert" className="text-sm font-semibold text-[var(--error-text)]">
          {error}
        </p>
      )}
    </div>
  );
};
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd web/react-gui && npx vitest run src/components/farming/__tests__/EditableName.test.tsx
```

Expected: `Test Files  1 passed (1)`, `Tests  13 passed (13)`, exit 0.

- [ ] **Step 5: Run the token and touch-target guards**

`tests/errorTokenMisuse.test.ts`, `tests/dangerFgPairing.test.ts`,
`tests/noInertTokenAlpha.test.ts` and `tests/touchTargets.test.ts` all walk
`src/` and would fail on a misused token in the new file.

```bash
cd web/react-gui && npx tsx --test 'tests/*.test.ts'
```

Expected: `# fail 0`, exit 0.

- [ ] **Step 6: Typecheck**

```bash
cd web/react-gui && npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add web/react-gui/src/components/farming/shared/EditableName.tsx \
        web/react-gui/src/components/farming/__tests__/EditableName.test.tsx
git commit -m "feat(gui): add the shared EditableName control"
```

---

### Task 13: API helpers and card wiring

**Files:**
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`
- Modify: `web/react-gui/src/components/farming/KiwiSensorCard.tsx:353-355`
- Modify: `web/react-gui/src/components/farming/StregaValveCard.tsx:840-842`
- Modify: `web/react-gui/src/components/farming/DraginoTempCard.tsx:159`
- Modify: `web/react-gui/src/components/farming/LoRainGaugeCard.tsx:107`
- Modify: `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx:191-193`
- Modify: `web/react-gui/src/components/farming/Sdi12SoilCard.tsx:125-127`
- Modify: `web/react-gui/src/components/farming/valves/ValveTile.tsx:165`
- Modify: `web/react-gui/src/components/farming/valves/ValveControlPanel.tsx`
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx`
- Modify: `web/react-gui/src/components/farming/AddDeviceModal.tsx`
- Modify: `web/react-gui/src/components/farming/ZoneDeviceModal.tsx`
- Modify: `web/react-gui/src/components/farming/CreateZoneModal.tsx`
- Modify: `scripts/verify-sync-flow.js`
- Test: `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardRename.test.tsx` (new)
- Test: `web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx`
- Test: `web/react-gui/src/components/farming/__tests__/AddDeviceModal.test.tsx`,
  `ZoneDeviceModal.test.tsx`, `CreateZoneModal.uicore.test.tsx`
- Test (call-site repair): `IrrigationZoneCardRemoveContext.test.tsx`,
  `IrrigationZoneCardData.test.tsx`, `IrrigationZoneCardLocale.test.tsx`,
  `IrrigationZoneCardSensorGating.test.tsx`

**Interfaces:**
- Consumes: `normalizeEntityName` (Task 11), `EditableName` (Task 12), and the
  two routes Tasks 6 and 7 build:
  `PUT /api/irrigation-zones/:id/name` → `200 { id, zone_uuid, name, sync_version, changed }`,
  `PUT /api/devices/:deveui/name` → `200 { deveui, name, sync_version, changed, chirpstack }`,
  errors `400 { message, reason }`, `401`, `403`, `404`.
- Produces:
  ```ts
  export interface ZoneRenameResult {
    id: number; zone_uuid: string; name: string; sync_version: number; changed: boolean;
  }
  export interface DeviceRenameResult {
    deveui: string; name: string; sync_version: number; changed: boolean;
    chirpstack: 'updated' | 'failed' | 'skipped';
  }
  export interface EntityRenameError extends Error { reason?: string }
  irrigationZonesAPI.rename(zoneId: number, name: string): Promise<ZoneRenameResult>
  devicesAPI.rename(deveui: string, name: string): Promise<DeviceRenameResult>
  ```

Every line number in this task is where the text sat on `origin/main` at
`c37207b30`, and each edit below quotes the code it replaces. Locate each edit
by that quoted text, not by the number: earlier tasks in this plan change
`scripts/verify-sync-flow.js`, and the GUI files move as soon as one edit in
them lands. If a quoted block has no match, re-read the file and re-derive the
anchor rather than loosening the search.

The permission signal is already in place. `useScope().canWrite`
(`src/contexts/ScopeContext.tsx`) reaches `IrrigationZoneCard` as `canWrite` and
every device card as `readOnly`, and those props already gate the ⚙ and ✕
controls. `canEdit` is `canWrite` on the zone card and `!readOnly` on the device
cards; no new plumbing is needed for those seven. `ValveControlPanel` is the one
exception, because `FarmingDashboard` renders it with `onUpdate` and
`batteryByEui` only, so it gains a `canWrite` prop in step 9.

- [ ] **Step 1: Write the failing zone-card wiring test**

Create `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardRename.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrrigationZoneCard } from '../IrrigationZoneCard';
import type { IrrigationZone } from '../../../types/farming';
import { irrigationZonesAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  dendroAnalyticsAPI: { getZoneRecommendations: vi.fn().mockResolvedValue([]) },
  environmentAPI: { getSummary: vi.fn().mockResolvedValue(null) },
  irrigationZonesAPI: {
    delete: vi.fn().mockResolvedValue(undefined),
    removeDevice: vi.fn().mockResolvedValue(undefined),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue({
      id: 12, zone_uuid: 'u', name: 'Zone C', sync_version: 4, changed: true,
    }),
  },
  devicesAPI: { remove: vi.fn(), rename: vi.fn() },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock('../ScheduleSection', () => ({
  ScheduleSection: () => <div />,
  normalizeTriggerMetric: (value: string) => value,
}));
vi.mock('../environment/EnvironmentCard', () => ({ EnvironmentCard: () => <div /> }));
vi.mock('../dendrometer/DendrometerSection', () => ({ DendrometerSection: () => <div /> }));
vi.mock('../../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: vi.fn(() => false) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const zone = {
  id: 12,
  name: 'Zone B',
  device_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  schedule: null,
} as IrrigationZone;

function renderZone(canWrite: boolean, onUpdate = vi.fn()) {
  render(
    <MemoryRouter>
      <IrrigationZoneCard
        zone={zone}
        devices={[]}
        unassignedDevices={[]}
        onUpdate={onUpdate}
        canWrite={canWrite}
      />
    </MemoryRouter>,
  );
  return { onUpdate };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('IrrigationZoneCard rename', () => {
  it('renames through the zone route and refreshes the dashboard', async () => {
    const { onUpdate } = renderZone(true);
    fireEvent.click(screen.getByRole('button', { name: 'rename.zone' }));
    const input = screen.getByLabelText('rename.zoneInputLabel');
    fireEvent.change(input, { target: { value: 'Zone C' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(irrigationZonesAPI.rename).toHaveBeenCalledWith(12, 'Zone C'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('hides the pencil from a role that cannot mutate', () => {
    renderZone(false);
    expect(screen.getByRole('heading', { name: 'Zone B' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'rename.zone' })).not.toBeInTheDocument();
  });

  it('keeps the collapse toggle reachable beside the heading', () => {
    renderZone(true);
    const toggle = screen.getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { expanded: true })).toBe(toggle);
  });
});
```

- [ ] **Step 2: Write the failing device-card wiring cases**

Append to `web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx`,
inside the existing `describe('Sdi12SoilCard', ...)` block, and widen the api
mock at the top of that file.

Replace the mock (lines 14-16 of that file):

```tsx
vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
}));
```

with:

```tsx
vi.mock('../../../services/api', () => ({
  devicesAPI: {
    remove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue({
      deveui: '70B3D5E75E004202',
      name: 'Row 4',
      sync_version: 2,
      changed: true,
      chirpstack: 'updated',
    }),
  },
}));
```

and add these cases:

```tsx
  it('renames the device through the device route and refreshes', async () => {
    const onUpdate = vi.fn();
    render(<Sdi12SoilCard device={makeDevice()} onUpdate={onUpdate} removeContext="farm" />);

    fireEvent.click(screen.getByTitle('rename.device'));
    const input = screen.getByLabelText('rename.deviceInputLabel');
    fireEvent.change(input, { target: { value: 'Row 4' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(devicesAPI.rename).toHaveBeenCalledWith('70B3D5E75E004202', 'Row 4'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('does not offer a rename in readOnly mode', () => {
    render(<Sdi12SoilCard device={makeDevice()} readOnly removeContext="farm" />);
    expect(screen.queryByTitle('rename.device')).not.toBeInTheDocument();
  });
```

- [ ] **Step 3: Write the failing modal validation cases**

In `web/react-gui/src/components/farming/__tests__/CreateZoneModal.uicore.test.tsx`,
widen the mock and add one case. Replace:

```tsx
vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { create: vi.fn() },
}));
```

with:

```tsx
import { irrigationZonesAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { create: vi.fn().mockResolvedValue({}) },
}));
```

and add, inside the existing `describe`:

```tsx
  it('refuses a control character and sends the trimmed name otherwise', async () => {
    render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    const input = screen.getByLabelText('createZoneModal.zoneName');

    fireEvent.change(input, { target: { value: 'Row\u00097' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByText('rename.reason.name_control_characters')).toBeTruthy());
    expect(irrigationZonesAPI.create).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '  North block  ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(irrigationZonesAPI.create).toHaveBeenCalledWith({ name: 'North block' }));
  });
```

(`fireEvent` and `waitFor` join the existing `@testing-library/react` import in
that file.)

In `web/react-gui/src/components/farming/__tests__/AddDeviceModal.test.tsx`, add:

```tsx
  it('refuses an over-long device name before calling the API', async () => {
    render(<AddDeviceModal isOpen onClose={() => {}} onDeviceAdded={() => {}} />);
    await screen.findByLabelText('Device Name');

    fireEvent.change(screen.getByLabelText('DevEUI'), { target: { value: '70B3D5E75E004202' } });
    fireEvent.change(screen.getByLabelText('Device Name'), { target: { value: 'a'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Device' }));

    await waitFor(() => expect(screen.getByText('rename.reason.name_too_long')).toBeTruthy());
    expect(devicesAPI.add).not.toHaveBeenCalled();
  });
```

In `web/react-gui/src/components/farming/__tests__/ZoneDeviceModal.test.tsx`, add:

```tsx
  it('sends a trimmed device name from the zone modal', async () => {
    renderModal();
    await screen.findByLabelText('addModal.deviceName');

    fireEvent.change(screen.getByLabelText('addModal.deveui'), { target: { value: '70B3D5E75E004202' } });
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), { target: { value: '  Row 4  ' } });
    fireEvent.click(screen.getByText('addModal.submit'));

    await waitFor(() =>
      expect(devicesAPI.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Row 4' })));
  });
```

`renderModal` is the helper that file already defines at line 42; it passes
`isOpen`, `onClose`, `onChanged`, `zoneId={7}`, `zoneName="North Block"` and
`availableDevices={devices}`, which are exactly the six props
`ZoneDeviceModalProps` declares. The second tab of that modal is the register
form, so the DevEUI and name fields are the ones the case above fills.

- [ ] **Step 4: Run the four test files and watch them fail**

```bash
cd web/react-gui && npx vitest run \
  src/components/farming/__tests__/IrrigationZoneCardRename.test.tsx \
  src/components/farming/__tests__/Sdi12SoilCard.test.tsx \
  src/components/farming/__tests__/CreateZoneModal.uicore.test.tsx \
  src/components/farming/__tests__/AddDeviceModal.test.tsx \
  src/components/farming/__tests__/ZoneDeviceModal.test.tsx
```

Expected: failures reading `Unable to find an accessible element with the role
"button" and name "rename.zone"`, `Unable to find an element by:
[title="rename.device"]`, and `expected "create" to be called with …`. The
cards and modals do not render or validate anything yet.

- [ ] **Step 5: Add the two API helpers**

In `web/react-gui/src/services/api.ts`, immediately after the closing brace of
`getApiErrorMessage` (line 107) and before the `// Create axios instance`
comment, insert:

```ts
export interface ZoneRenameResult {
  id: number;
  zone_uuid: string;
  name: string;
  sync_version: number;
  changed: boolean;
}

export interface DeviceRenameResult {
  deveui: string;
  name: string;
  sync_version: number;
  changed: boolean;
  /** `skipped` when nothing changed or provisioning is not configured. */
  chirpstack: 'updated' | 'failed' | 'skipped';
}

/** An Error that also carries the `reason` code from a 400 rename response. */
export interface EntityRenameError extends Error {
  reason?: string;
}

/**
 * The rename routes answer `400 { message, reason }`. getApiErrorMessage
 * already lifts `message`; EditableName also needs the machine-readable
 * `reason` so it can show a translated sentence instead of the route's English.
 * Both travel on one Error, which keeps axios out of the component.
 */
function toRenameError(error: unknown, fallback: string): EntityRenameError {
  const mapped: EntityRenameError = new Error(getApiErrorMessage(error, fallback));
  if (axios.isAxiosError<{ reason?: unknown }>(error)) {
    const reason = error.response?.data?.reason;
    if (typeof reason === 'string' && reason.length > 0) {
      mapped.reason = reason;
    }
  }
  return mapped;
}
```

In `devicesAPI` (line 355), add after `remove`:

```ts
  rename: async (deveui: string, name: string): Promise<DeviceRenameResult> => {
    try {
      const response = await api.put<DeviceRenameResult>(`/api/devices/${deveui}/name`, { name });
      return response.data;
    } catch (error) {
      throw toRenameError(error, 'Failed to rename device');
    }
  },
```

In `irrigationZonesAPI` (line 515), add after `delete`:

```ts
  rename: async (zoneId: number, name: string): Promise<ZoneRenameResult> => {
    try {
      const response = await api.put<ZoneRenameResult>(`/api/irrigation-zones/${zoneId}/name`, { name });
      return response.data;
    } catch (error) {
      throw toRenameError(error, 'Failed to rename zone');
    }
  },
```

- [ ] **Step 6: Wire the zone card**

In `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`:

Add the import beside the other `./` imports (after the `ZoneDeviceModal` line):

```tsx
import { EditableName } from './shared/EditableName';
```

Add the handler next to the other handlers inside the component body (any point
after `const { t } = useTranslation('devices')` and before the `return`):

```tsx
  const handleRenameZone = async (nextName: string) => {
    await irrigationZonesAPI.rename(zone.id, nextName);
    onUpdate();
  };
```

Replace lines 397-416, the collapse button that currently wraps the heading:

```tsx
        <button
          className="flex-1 min-w-0 text-left flex items-center gap-2 group"
          aria-expanded={!zoneCollapsed}
          onClick={() => setZoneCollapsed(c => !c)}
        >
          <h3 className="text-3xl font-bold text-[var(--text)] mb-1 high-contrast-text break-words">
            {zone.name}
          </h3>
          <span
            className="text-[var(--text-tertiary)] text-xl transition-transform duration-200 mt-0.5 shrink-0"
            style={{ display: 'inline-block', transform: zoneCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          >
            ▾
          </span>
          <p className="text-[var(--text-secondary)] text-sm mt-1">
            {t('zone.deviceCount', { count: zone.device_count })}
          </p>
        </button>
```

with:

```tsx
        {/* The pencil is a button, so the heading can no longer sit inside the
            collapse button: nested interactive elements are invalid markup and
            make the collapse control ambiguous to assistive technology. The
            heading moves out; the chevron and the device count stay the
            collapse control and keep aria-expanded. */}
        <div className="flex-1 min-w-0">
          <EditableName
            name={zone.name}
            canEdit={canWrite}
            onSave={handleRenameZone}
            renameLabel={t('rename.zone')}
            inputLabel={t('rename.zoneInputLabel')}
            headingClassName="text-3xl font-bold text-[var(--text)] mb-1 high-contrast-text break-words"
          />
          <button
            className="text-left flex items-center gap-2 group"
            aria-expanded={!zoneCollapsed}
            onClick={() => setZoneCollapsed(c => !c)}
          >
            <span
              className="text-[var(--text-tertiary)] text-xl transition-transform duration-200 shrink-0"
              style={{ display: 'inline-block', transform: zoneCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
            >
              ▾
            </span>
            <p className="text-[var(--text-secondary)] text-sm">
              {t('zone.deviceCount', { count: zone.device_count })}
            </p>
          </button>
        </div>
```

Then add `onUpdate={onUpdate}` to the three placements inside this file that do
not have it yet: `DraginoTempCard` (line 794), `Sdi12SoilCard` (line 818) and
`LoRainGaugeCard` (line 868). Each is one added line directly under
`onRemove={() => handleRemoveDevice(device.deveui)}`, for example:

```tsx
                        <Sdi12SoilCard
                          device={device}
                          onOpenSettings={() => setSdi12SettingsDevice(device)}
                          onRemove={() => handleRemoveDevice(device.deveui)}
                          onUpdate={onUpdate}
                          readOnly={!canWrite}
                          removeContext="zone"
                        />
```

- [ ] **Step 7: Repair the six heading-click call sites**

Four existing test files expand the zone card by clicking its heading, which
stops working once the heading leaves the collapse button. Update them in this
commit and state why in the commit body (a guard whose contract changed is
updated with the change, never weakened later).

While the card is collapsed the zone toggle is the only rendered control with
`aria-expanded`, because everything else is behind `{!zoneCollapsed && (` at
line 495, so the role query below is unambiguous and, unlike a name query, is the same in
every locale.

Replace, in each file at each line:

```tsx
fireEvent.click(screen.getByRole('heading', { name: 'Zone B' }));
```

with:

```tsx
fireEvent.click(screen.getByRole('button', { expanded: false }));
```

| File | Lines |
|---|---|
| `src/components/farming/__tests__/IrrigationZoneCardSensorGating.test.tsx` | 106, 332, 394, 453 |
| `src/components/farming/__tests__/IrrigationZoneCardData.test.tsx` | 283, 297, 323, 336 |
| `src/components/farming/__tests__/IrrigationZoneCardLocale.test.tsx` | 185 |

and in `src/components/farming/__tests__/IrrigationZoneCardRemoveContext.test.tsx`
line 111, where the call reads `screen.getByRole('heading', { name: zone.name })`:

```tsx
  fireEvent.click(screen.getByRole('button', { expanded: false }));
```

- [ ] **Step 8: Wire the six device cards**

Each card gets the same three edits: an import, a handler, and the heading
replacement. `canEdit` is `!readOnly` everywhere, which is the same signal that
already hides the card's ⚙ and ✕ controls.

`KiwiSensorCard.tsx`: change line 3 to
`import { deviceMetadataAPI, devicesAPI, kiwiAPI } from '../../services/api';`,
add the handler after `const { t: tc } = useTranslation('common');` (line 321):

```tsx
  const handleRename = async (nextName: string) => {
    await devicesAPI.rename(device.deveui, nextName);
    onUpdate?.();
  };
```

and replace lines 353-355:

```tsx
        <h3 className="text-base font-semibold text-[var(--text)] truncate leading-tight">
          {device.name}
        </h3>
```

with:

```tsx
        <EditableName
          name={device.name}
          canEdit={!readOnly}
          onSave={handleRename}
          renameLabel={t('rename.device')}
          inputLabel={t('rename.deviceInputLabel')}
          headingClassName="text-base font-semibold text-[var(--text)] truncate leading-tight"
        />
```

plus `import { EditableName } from './shared/EditableName';` beside the existing
`./shared/DeviceCardFooter` import.

`StregaValveCard.tsx`: `devicesAPI` is already imported (line 4). Add the
`EditableName` import, add the handler after line 738 (`const { t: tv } = …`)
using `onUpdate()` (the prop is required here, not optional):

```tsx
  const handleRename = async (nextName: string) => {
    await devicesAPI.rename(device.deveui, nextName);
    onUpdate();
  };
```

and replace lines 840-842, the same three heading lines as above, with the
same `<EditableName …>` block.

`DraginoTempCard.tsx`: add
`import { devicesAPI } from '../../services/api';` and the `EditableName`
import, add `onUpdate?.()` handler after line 82, and replace line 159:

```tsx
        <h3 className="text-base font-semibold text-[var(--text)] truncate leading-tight">{device.name}</h3>
```

with the `<EditableName …>` block, `headingClassName="text-base font-semibold text-[var(--text)] truncate leading-tight"`.

`LoRainGaugeCard.tsx`: add both imports and the handler after line 79. Add
`onUpdate?: () => void;` to `LoRainGaugeCardProps` (after `onRemove`) and to the
destructure. Replace line 107:

```tsx
        <h3 className="truncate text-base font-semibold leading-tight text-[var(--text)]">{device.name}</h3>
```

with the `<EditableName …>` block,
`headingClassName="truncate text-base font-semibold leading-tight text-[var(--text)]"`.

`SenseCapWeatherCard.tsx`: change line 4 to
`import { devicesAPI, getApiErrorMessage, s2120API } from '../../services/api';`,
add the `EditableName` import and an `onUpdate?.()` handler after line 167, and
replace lines 191-193 with the `<EditableName …>` block,
`headingClassName="truncate text-base font-semibold leading-tight text-[var(--text)]"`.

`Sdi12SoilCard.tsx`: add `import { devicesAPI } from '../../services/api';` and
the `EditableName` import. Add `onUpdate?: () => void;` to `Sdi12SoilCardProps`
(after `onRemove`) and to the destructure. Add the handler after line 85, then
replace lines 125-127 with the `<EditableName …>` block,
`headingClassName="text-base font-semibold text-[var(--text)] truncate leading-tight"`.

- [ ] **Step 9: Wire the valve tile**

`valves/ValveTile.tsx` renders its own name heading and holds no API calls, because all
its actions arrive as props, so the rename arrives the same way.

Add to `ValveTileProps`, after `onDelete`:

```tsx
  /** True when the caller's role may mutate; false hides the rename pencil. */
  canEdit: boolean;
  /** Renames the valve's device. Rejects so EditableName can show the reason. */
  onRename: (name: string) => Promise<void>;
```

Add both to the destructured parameter list, add
`import { EditableName } from '../shared/EditableName';` and a second
translation handle beside the existing one (line 74):

```tsx
  const { t: tDevices } = useTranslation('devices');
```

Replace line 165:

```tsx
            <h3 className="truncate text-sm font-semibold text-[var(--text)]">{valve.name}</h3>
```

with:

```tsx
            <EditableName
              name={valve.name}
              canEdit={canEdit}
              onSave={onRename}
              renameLabel={tDevices('rename.device')}
              inputLabel={tDevices('rename.deviceInputLabel')}
              headingClassName="truncate text-sm font-semibold text-[var(--text)]"
            />
```

`valves/ValveControlPanel.tsx`: add `canWrite` to its props (line 14):

```tsx
export interface ValveControlPanelProps {
  onUpdate: () => void;
  /** False for a role that cannot mutate; hides the tiles' rename pencils. */
  canWrite?: boolean;
```

destructure it with a default (line 28):
`({ onUpdate, canWrite = true, batteryByEui })`, add the handler after
`refresh` (line 70):

```tsx
  // Deliberately not routed through runAction: that helper swallows the error
  // into the panel's own banner, and EditableName needs the rejection so it can
  // show the route's reason under the input.
  const handleRename = async (eui: string, nextName: string) => {
    await devicesAPI.rename(eui, nextName);
    await refresh();
  };
```

and pass both to the tile (after `onDelete=…`, line 187):

```tsx
              canEdit={canWrite}
              onRename={(nextName: string) => handleRename(valve.deviceEui, nextName)}
```

`src/pages/FarmingDashboard.tsx`: pass the signal in, and give the two cards
that lack one an `onUpdate`:

- line 217: `<ValveControlPanel onUpdate={handleUpdate} canWrite={canWrite} batteryByEui={batteryByEui} />`
- the `Sdi12SoilCard` placement (line ~379): add `onUpdate={handleUpdate}` under `onRemove={handleUpdate}`
- the `LoRainGaugeCard` placement (line ~417): add `onUpdate={handleUpdate}` under `onRemove={handleUpdate}`

- [ ] **Step 10: Wire the three modals**

`CreateZoneModal.tsx`: add
`import { normalizeEntityName } from '../../utils/entityName';` and replace
lines 27-34:

```tsx
    if (!name.trim()) {
      setError(t('createZoneModal.zoneNameRequired'));
      return;
    }

    setLoading(true);
    try {
      await irrigationZonesAPI.create({ name: name.trim() });
```

with:

```tsx
    // One rule for create and for rename (design decision D4): otherwise create
    // accepts names a later rename would refuse.
    const normalized = normalizeEntityName(name);
    if (!normalized.ok) {
      setError(normalized.reason === 'name_empty'
        ? t('createZoneModal.zoneNameRequired')
        : t(`rename.reason.${normalized.reason}`));
      return;
    }

    setLoading(true);
    try {
      await irrigationZonesAPI.create({ name: normalized.name });
```

`AddDeviceModal.tsx`: add the same import and insert, in `handleSubmit`
immediately after the AppKey check (line 60) and before the catalog check:

```tsx
    const normalized = normalizeEntityName(name);
    if (!normalized.ok) {
      setError(t(`rename.reason.${normalized.reason}`));
      return;
    }
```

then change the payload (line 75) from `name,` to `name: normalized.name,`.

`ZoneDeviceModal.tsx`: the same import, the same block inserted in
`handleRegister` after the AppKey check (line 120), and the same payload change
at line 135.

- [ ] **Step 11: Add the path-pinned verifier assertions**

`scripts/verify-sync-flow.js` already reads `api.ts`, `IrrigationZoneCard.tsx`
and `KiwiSensorCard.tsx` by path. Per spec 5.9, new API functions get
assertions there. Anchor on content: Tasks 6 to 10 add assertions to this same
file, so every line number past their insertion points has moved. Find the pair
with

```bash
grep -n "updateCalibration: async (zoneId: number" scripts/verify-sync-flow.js
```

and insert the block below directly after the second of those two
`expectFileIncludes('api.ts', ...)` lines, the one whose needle ends
`calibration`, payload);`. That lands inside the GUI assertion block, well away
from the flow-node section Tasks 6 to 10 edit:

```js
expectFileIncludes('api.ts', reactGuiApiSource, 'rename: async (zoneId: number, name: string)', 'adds a shared client helper for zone rename');
expectFileIncludes('api.ts', reactGuiApiSource, "await api.put<ZoneRenameResult>(`/api/irrigation-zones/${zoneId}/name`, { name });", 'targets the local zone rename endpoint');
expectFileIncludes('api.ts', reactGuiApiSource, 'rename: async (deveui: string, name: string)', 'adds a shared client helper for device rename');
expectFileIncludes('api.ts', reactGuiApiSource, "await api.put<DeviceRenameResult>(`/api/devices/${deveui}/name`, { name });", 'targets the local device rename endpoint');
expectFileIncludes('IrrigationZoneCard.tsx', irrigationZoneCardSource, '<EditableName', 'renames the zone from its card heading');
expectFileIncludes('IrrigationZoneCard.tsx', irrigationZoneCardSource, 'irrigationZonesAPI.rename(zone.id,', 'sends the zone rename through the shared client helper');
expectFileIncludes('KiwiSensorCard.tsx', kiwiSensorCardSource, '<EditableName', 'renames the device from the Kiwi card heading');
expectFileIncludes('KiwiSensorCard.tsx', kiwiSensorCardSource, 'devicesAPI.rename(device.deveui,', 'sends the device rename through the shared client helper');
```

The `${zoneId}` and `${deveui}` inside those double-quoted JavaScript strings are
literal text, exactly as the neighbouring `updateCalibration` assertion already
writes them.

- [ ] **Step 12: Run the wiring tests and watch them pass**

```bash
cd web/react-gui && npx vitest run src/components/farming/__tests__ src/components/farming/valves/__tests__
```

Expected: every file passes, `Tests  … passed`, exit 0. The four repaired
zone-card files must be green here; a red one means a heading click was missed
in step 7.

- [ ] **Step 13: Run the two path-pinned verifiers**

```bash
node scripts/verify-sync-flow.js
node scripts/verify-command-safety.js
```

Expected: the first prints `Sync flow verification passed` and ends
`All parity checks passed.` with exit 0; the second exits 0. Check each exit
code directly. Do not read the result through a pipe.

- [ ] **Step 14: Typecheck**

```bash
cd web/react-gui && npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 15: Commit**

```bash
git add web/react-gui/src scripts/verify-sync-flow.js
git commit -m "feat(gui): rename zones and devices from their cards

The zone heading leaves the collapse button: the rename pencil is a button,
and a button inside a button is invalid markup. The four zone-card test files
that expanded the card by clicking its heading now click the collapse toggle."
```

---

### Task 14: the nine strings in seven locales

**Files:**
- Modify: `web/react-gui/public/locales/en/devices.json:623`
- Modify: `web/react-gui/public/locales/de-CH/devices.json:626`
- Modify: `web/react-gui/public/locales/fr/devices.json:626`
- Modify: `web/react-gui/public/locales/it/devices.json:626`
- Modify: `web/react-gui/public/locales/es/devices.json:626`
- Modify: `web/react-gui/public/locales/pt/devices.json:626`
- Modify: `web/react-gui/public/locales/lg/devices.json:626`
- Modify: `docs/i18n/pending-luganda-translations.md`
- Test: `web/react-gui/tests/renameLocales.test.ts` (new)

**Interfaces:**
- Consumes: the `rename.*` keys read by `EditableName` (Task 12) and by the
  three modals (Task 13).
- Produces: nothing for later tasks.

The seven `devices.json` files are pretty-printed, two-space indented, 736
(`en`) or 739 lines, and every one carries the same nineteen top-level keys in
the same order. They are not minified, so an ordinary text edit is safe; make it
at the exact insertion point below and re-parse with
`node -e "JSON.parse(require('fs').readFileSync(…))"` if an editor reflows
anything.

Insertion point, identical in shape in all seven files: the `"deviceRemoval"`
object closes with `  },` and `  "common": {` opens on the next line. The new
`"rename"` object goes between those two lines: line 623/624 in `en`,
line 626/627 in the other six.

- [ ] **Step 1: Write the failing locale test**

Create `web/react-gui/tests/renameLocales.test.ts`. It follows
`tests/systemPanelLocales.test.ts`, which is the mechanism
`docs/i18n/pending-luganda-translations.md` already names for this shape of
change:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The nine strings the rename affordance needs: the two pencil labels, the two
 * input labels, the four reason texts of the name rule (design section 4) and
 * the generic failure. Read by
 * src/components/farming/shared/EditableName.tsx and by the three device/zone
 * creation modals.
 *
 * Same contract as tests/systemPanelLocales.test.ts: present in all seven
 * bundles, matching interpolation placeholders, translated in the five European
 * locales, and byte-identical English in Luganda until a human pass lands.
 */

const localeRoot = path.resolve(process.cwd(), 'public/locales');
const LOCALES = ['en', 'de-CH', 'es', 'fr', 'it', 'lg', 'pt'];
const EUROPEAN = ['de-CH', 'es', 'fr', 'it', 'pt'];

function readDevices(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'devices.json'), 'utf8'));
}

function getPath(tree: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, tree);
}

const KEYS = [
  'rename.zone',
  'rename.device',
  'rename.zoneInputLabel',
  'rename.deviceInputLabel',
  'rename.reason.name_empty',
  'rename.reason.name_too_long',
  'rename.reason.name_control_characters',
  'rename.reason.name_invalid_unicode',
  'rename.failed',
];

// Luganda is human translation work product: where no reviewed Luganda exists,
// the honest shipped value is the English source text, never a machine
// translation. Every key above is in that state, tracked in
// docs/i18n/pending-luganda-translations.md. A human pass must change both
// files together, and this assertion is what forces that.
const PENDING_HUMAN_LUGANDA = new Set<string>(KEYS);

test('rename keys exist in every shipped locale', () => {
  for (const locale of LOCALES) {
    const devices = readDevices(locale);
    for (const key of KEYS) {
      assert.equal(typeof getPath(devices, key), 'string', `${locale} devices.json missing ${key}`);
    }
  }
});

test('rename interpolation placeholders match English in every locale', () => {
  const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort().join('|');
  const english = readDevices('en');
  for (const locale of LOCALES) {
    const translated = readDevices(locale);
    for (const key of KEYS) {
      assert.equal(
        placeholders(getPath(translated, key) as string),
        placeholders(getPath(english, key) as string),
        `${locale} devices.json placeholder mismatch at ${key}`,
      );
    }
  }
});

test('the five European locales translate every rename key', () => {
  const english = readDevices('en');
  for (const locale of EUROPEAN) {
    const translated = readDevices(locale);
    const identical = KEYS.filter((key) => getPath(translated, key) === getPath(english, key));
    assert.deepEqual(identical, [], `${locale} devices.json has untranslated rename values`);
  }
});

test('Luganda ships the English source text for the rename keys until a human pass lands', () => {
  const english = readDevices('en');
  const luganda = readDevices('lg');
  for (const key of KEYS) {
    if (!PENDING_HUMAN_LUGANDA.has(key)) continue;
    assert.equal(
      getPath(luganda, key),
      getPath(english, key),
      `lg devices.json ${key} changed; drop it from PENDING_HUMAN_LUGANDA and from docs/i18n/pending-luganda-translations.md`,
    );
  }
});
```

- [ ] **Step 2: Run the locale test and watch it fail**

```bash
cd web/react-gui && npx tsx --test tests/renameLocales.test.ts
```

Expected: `# fail 4`, with
`en devices.json missing rename.zone` as the first assertion message.

- [ ] **Step 3: Add the English block**

In `web/react-gui/public/locales/en/devices.json`, between line 623 (`  },`,
which closes `"deviceRemoval"`) and line 624 (`  "common": {`), insert:

```json
  "rename": {
    "zone": "Rename zone",
    "device": "Rename device",
    "zoneInputLabel": "Zone name",
    "deviceInputLabel": "Device name",
    "reason": {
      "name_empty": "Enter a name.",
      "name_too_long": "Use 100 characters or fewer.",
      "name_control_characters": "Remove tabs, line breaks and other control characters.",
      "name_invalid_unicode": "This name contains a character that cannot be saved."
    },
    "failed": "Could not save the name."
  },
```

- [ ] **Step 4: Add the six other blocks**

Same position in each file: between the `  },` that closes `"deviceRemoval"`
(line 626) and `  "common": {` (line 627).

`de-CH`, Swiss standard German, `Sie` form as the rest of the file uses, no `ß`:

```json
  "rename": {
    "zone": "Zone umbenennen",
    "device": "Gerät umbenennen",
    "zoneInputLabel": "Zonenname",
    "deviceInputLabel": "Gerätename",
    "reason": {
      "name_empty": "Geben Sie einen Namen ein.",
      "name_too_long": "Verwenden Sie höchstens 100 Zeichen.",
      "name_control_characters": "Entfernen Sie Tabulatoren, Zeilenumbrüche und andere Steuerzeichen.",
      "name_invalid_unicode": "Dieser Name enthält ein Zeichen, das nicht gespeichert werden kann."
    },
    "failed": "Der Name konnte nicht gespeichert werden."
  },
```

`fr`, `vous` as the rest of the file:

```json
  "rename": {
    "zone": "Renommer la zone",
    "device": "Renommer l'appareil",
    "zoneInputLabel": "Nom de la zone",
    "deviceInputLabel": "Nom de l'appareil",
    "reason": {
      "name_empty": "Saisissez un nom.",
      "name_too_long": "Utilisez 100 caractères au maximum.",
      "name_control_characters": "Supprimez les tabulations, les retours à la ligne et les autres caractères de contrôle.",
      "name_invalid_unicode": "Ce nom contient un caractère qui ne peut pas être enregistré."
    },
    "failed": "Impossible d'enregistrer le nom."
  },
```

`it`, informal as the rest of the file (`il tuo account`):

```json
  "rename": {
    "zone": "Rinomina la zona",
    "device": "Rinomina il dispositivo",
    "zoneInputLabel": "Nome della zona",
    "deviceInputLabel": "Nome del dispositivo",
    "reason": {
      "name_empty": "Inserisci un nome.",
      "name_too_long": "Usa al massimo 100 caratteri.",
      "name_control_characters": "Rimuovi tabulazioni, interruzioni di riga e altri caratteri di controllo.",
      "name_invalid_unicode": "Questo nome contiene un carattere che non può essere salvato."
    },
    "failed": "Impossibile salvare il nome."
  },
```

`es`, informal as the rest of the file (`tu cuenta`):

```json
  "rename": {
    "zone": "Cambiar el nombre de la zona",
    "device": "Cambiar el nombre del dispositivo",
    "zoneInputLabel": "Nombre de la zona",
    "deviceInputLabel": "Nombre del dispositivo",
    "reason": {
      "name_empty": "Escribe un nombre.",
      "name_too_long": "Usa 100 caracteres como máximo.",
      "name_control_characters": "Quita las tabulaciones, los saltos de línea y otros caracteres de control.",
      "name_invalid_unicode": "Este nombre contiene un carácter que no se puede guardar."
    },
    "failed": "No se pudo guardar el nombre."
  },
```

`pt`, European Portuguese as the rest of the file (`registado`, `gateway`):

```json
  "rename": {
    "zone": "Mudar o nome da zona",
    "device": "Mudar o nome do dispositivo",
    "zoneInputLabel": "Nome da zona",
    "deviceInputLabel": "Nome do dispositivo",
    "reason": {
      "name_empty": "Introduza um nome.",
      "name_too_long": "Use no máximo 100 caracteres.",
      "name_control_characters": "Remova tabulações, quebras de linha e outros caracteres de controlo.",
      "name_invalid_unicode": "Este nome contém um carácter que não pode ser guardado."
    },
    "failed": "Não foi possível guardar o nome."
  },
```

`lg`, the English source text, byte for byte, per the edge Luganda policy:

```json
  "rename": {
    "zone": "Rename zone",
    "device": "Rename device",
    "zoneInputLabel": "Zone name",
    "deviceInputLabel": "Device name",
    "reason": {
      "name_empty": "Enter a name.",
      "name_too_long": "Use 100 characters or fewer.",
      "name_control_characters": "Remove tabs, line breaks and other control characters.",
      "name_invalid_unicode": "This name contains a character that cannot be saved."
    },
    "failed": "Could not save the name."
  },
```

- [ ] **Step 5: Record the pending Luganda keys**

In `docs/i18n/pending-luganda-translations.md`, insert a new section
immediately before `## Related keys not listed here` (line 80):

```markdown
## `devices.json` — zone and device rename

| Keys | Reason |
|---|---|
| `rename.zone`, `rename.device`, `rename.zoneInputLabel`, `rename.deviceInputLabel`, `rename.reason.name_empty`, `rename.reason.name_too_long`, `rename.reason.name_control_characters`, `rename.reason.name_invalid_unicode`, `rename.failed` (9 keys in `devices.json`) | New keys for the rename pencil on the zone card and the seven device surfaces, and for the four reason codes of the shared name rule. No native Luganda speaker has translated them yet, so `lg` ships the current English source text rather than an unreviewed machine translation, per the edge lg policy. de-CH/es/fr/it/pt received human-quality translations in the same change. |

Tracked in code at `web/react-gui/tests/renameLocales.test.ts`
(`PENDING_HUMAN_LUGANDA`), which asserts each key's `lg` value is still
byte-identical to `en`, the same mechanism the sections above use. A human
Luganda pass must drop the key from that set and from the table above in the
same change; the test fails otherwise, so the two cannot drift apart.
```

- [ ] **Step 6: Run the locale test and watch it pass**

```bash
cd web/react-gui && npx tsx --test tests/renameLocales.test.ts
```

Expected: `# pass 4`, `# fail 0`, exit 0.

- [ ] **Step 7: Run the whole tsx-runner suite**

`tests/i18nNamespaceCoverage.test.ts` and
`tests/i18nDefaultValueCoverage.test.ts` both walk every source file and every
bundle, so they are the check that the new keys are reachable and that no
`t(key, { defaultValue })` call was left pointing at a key that exists nowhere.

```bash
cd web/react-gui && npm run test:unit:tsx-runner
```

Expected: `# fail 0`, exit 0.

- [ ] **Step 8: Check the prose**

```bash
node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md
```

Expected: `slop-check: PASS (no tier-1 findings)`, exit 0.

- [ ] **Step 9: Commit**

```bash
git add web/react-gui/public/locales web/react-gui/tests/renameLocales.test.ts \
        docs/i18n/pending-luganda-translations.md
git commit -m "feat(gui): add rename strings in seven locales"
```

---

### Task 15: Full gate run, bench check and pull request

**Files:**
- Modify: `AGENTS.md`
- No other file changes. Everything below is verification, documentation and the pull request.

**Interfaces:**
- Consumes: every task. This one proves the branch, it does not add behaviour.
- Produces: the evidence block that goes in the pull-request body, and the
  AGENTS.md entries a later agent will look for.

- [ ] **Step 1: Run the stage-1 gate set from the repository root**

Run each one and check its own exit status. Never prove a gate through a pipe:
`verify-sync-flow.js` chains profile parity, so its last line comes from another
check, and `| tail` hides the exit code.

| Gate | Command | Pass signal |
|---|---|---|
| Full sync/flow contract | `node scripts/verify-sync-flow.js` | prints `Sync flow verification passed`, then chains parity and ends `All parity checks passed.`, exit 0 |
| Sync contract | `node scripts/verify-sync-contract.js` | exit 0, no `enum drift` line |
| Contract schemas | `node scripts/test-contract-schemas.js` | `PASS: contract schema checks pass`, exit 0 |
| Sync op parity | `node scripts/verify-sync-op-parity.js` | ends `verify-sync-op-parity: OK`, exit 0 |
| Profile parity | `node scripts/verify-profile-parity.js` | ends `All parity checks passed.`, exit 0 |
| osi-lib binding audit | `node scripts/osi-lib-binding-audit.js` | no output, exit 0 |
| Module deploy coverage | `node scripts/verify-module-file-deploy-coverage.js` | `OK: all 99 runtime files in deploy.sh-shipped osi-* modules are fetched.`, exit 0 (96 on `origin/main`, plus this branch's three `osi-entity-name` files) |
| Helper registration | `node scripts/verify-helper-registration.js` | `OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-entity-name` among the lines, then `All helper-registration checks passed.`, exit 0 |
| Function-node parse | `node scripts/verify-flows-fn-parse.js` | ends `verify-flows-fn-parse: OK`, exit 0 |
| Flow wiring guards | `node scripts/test-flows-wiring.js` | ends `PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`, exit 0 |
| Silent catch ratchet | `node scripts/verify-no-new-silent-catch.js` | `87 empty catches across 302 function nodes (baseline 87)` on both profiles, exit 0 |
| Bare require scan | `node scripts/flows-bare-require-scan.js` | no output, exit 0 |
| Flows size ratchet | `node scripts/verify-flows-size-ratchet.js` | one `OK conf/...flows.json (total <n>)` line per profile, then `verify-flows-size-ratchet: OK (...)`, exit 0 |
| Communication contract | `node scripts/verify-communication-contract.js` | ends `Communication contract verification passed`, exit 0 |
| Command safety | `node scripts/verify-command-safety.js` | ends `verify-command-safety: OK`, with `ok Command Type Registry checked against 2 fallback(s) (56 primary entries)`, exit 0 (54 on `origin/main`, plus the two name types) |
| Output arity | `node scripts/verify-flows-output-arity.js` | ends `verify-flows-output-arity: OK`, exit 0 |
| Scoped-access ratchet | `node scripts/verify-scoped-access.js` | ends `verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)`, exit 0 |
| Flag-off hermetic auth | `node scripts/verify-auth-flag-off-hermetic.js` | ends `verify-auth-flag-off-hermetic: OK (...)`, exit 0 |
| Stray DDL ratchet | `node scripts/verify-no-stray-ddl.js` | exit 0 |
| Whitespace sanity | `git diff --check` | no output, exit 0 |

The function-node count in the silent-catch line is 297 on `origin/main` and 302
here: Tasks 6 and 7 add two function nodes each (a scope guard and a handler)
and Task 8 adds the applier. The whole node count goes from 726 to 735, because
each route also brings an `http in` and an `http response` node. If either
figure reads anything else, a node was added or dropped that this plan does not
describe.

- [ ] **Step 2: Run every test file this branch touches**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-entity-name/*.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/*.test.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node --test scripts/test-zone-command-path.js
node --test scripts/test-zone-rename-route.js
node --test scripts/test-device-rename-route.js
node --test scripts/test-entity-name-command-path.js
node --test scripts/test-entity-name-create-paths.js
node --test scripts/test-legacy-upsert-zone-name.js
node --test scripts/test-journal-bootstrap.js
node --test scripts/osi-lib-binding-audit.test.js
node --test scripts/test-terra-selection-edge-acceptance.js
node --test scripts/test-scoped-access-writes.js
node --test scripts/test-upsert-sync-versioning.js
node scripts/test-sdi12-registration.js
node scripts/test-zone-device-assignment-flow.js
```

Expected: `# fail 0` and exit 0 from every `node --test` line, exit 0 from the
last two.

- [ ] **Step 3: Run the GUI typecheck and unit tests**

```bash
cd web/react-gui && npm run typecheck
cd web/react-gui && npm run test:unit
```

Expected: `npm run typecheck` exits 0 with no output. `npm run test:unit` runs
the tsx runner (`# fail 0`) and then Vitest (`Test Files … passed`), exit 0.

- [ ] **Step 4: Run the one production build**

```bash
cd web/react-gui && npm run build
```

Expected: exit 0, ending in the Vite `built in …` summary. Run this once, alone.
Two frontend builds at the same time exhaust this workstation's memory, and a
build killed by the out-of-memory killer looks like a code failure.

- [ ] **Step 5: Record the edge routes and the capability in AGENTS.md**

Task 8 already extended the `Cloud → edge command types` list under
`## Sync REST endpoints`. Two facts are still unrecorded there. Immediately
below that list and its `entity-name-command-apply-fn` sentence, add:

```markdown
**Edge rename routes** (local dashboard → gateway, HMAC bearer):
`PUT /api/irrigation-zones/:id/name` answers
`200 { id, zone_uuid, name, sync_version, changed }`, and
`PUT /api/devices/:deveui/name` answers
`200 { deveui, name, sync_version, changed, chirpstack }` with `chirpstack` in
`updated` / `failed` / `skipped`. Both answer `400 { message, reason }` with a
reason code from the shared name rule in `osi-entity-name`, which is also what
zone create, device create, `REGISTER_DEVICE` and both `UPSERT_ZONE` paths
apply. The `chirpstack` update is best effort and carries a 5 s gRPC deadline of
its own, not the 20 s default.

**Sync capabilities the edge reports** (built identically by `sync-bootstrap-build`,
`al-link-build-req` and `sync-force-build`): `linked_auth_sync_v1`,
`force_edge_sync_v1`, `installation_recovery_v1`, `installation_locations_v1`,
`entity_name_commands_v1`, and `field_journal_v1` when the journal is enabled.
The cloud reads the list as `gatewayIdentity.syncCapabilities()` and sends a
name command only to a gateway that reported `entity_name_commands_v1`.
```

Then check the prose:

```bash
node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md
```

Expected: `slop-check: PASS (no tier-1 findings)`, exit 0.

- [ ] **Step 6: Commit the documentation**

```bash
git add AGENTS.md
git commit -m "docs: record the edge rename routes and the entity-name capability"
```

- [ ] **Step 7: Ask for a go-ahead before the bench check**

Stop here and ask the repository owner for two things: permission to deploy this
branch to a test gateway, and which gateway to use. A loaded SSH key is not
consent, and nothing below may run against a gateway that carries a real
irrigation schedule.

Record the answer in the pull-request body. If the answer is no, say so in the
pull request and mark the bench rows below as not run, rather than leaving them
implied.

- [ ] **Step 8: Bench check on a test gateway**

The operator checklist for spec section 10. ChirpStack gRPC behaviour and
browser interaction were checked in source only during design and review, so
this is their first real test. Load the repo skill `osi-live-ops-runbook` before
the first command: it carries the download-then-run rule, the backup step and
the traps that bite on BusyBox.

| # | Action | Expected |
|---|---|---|
| 1 | Take the pre-deploy database backup the runbook describes | A dated backup file exists off the gateway |
| 2 | Deploy the branch to the test gateway with `deploy.sh`, downloaded first and then run | Deploy ends 0; `/srv/node-red/osi-entity-name/` holds `package.json`, `index.js` and `commands.js` |
| 3 | Wait for the Node-RED restart the deploy performs; do not restart it by hand | The dashboard answers again |
| 4 | Rename a zone in the edge dashboard: pencil, type, Enter | The heading shows the new name, no error line appears under the input |
| 5 | Rename a device on a sensor card the same way | Same |
| 6 | Read both rows back over the API with a bearer token | `sync_version` increased by one on each; `changed` was `true` |
| 7 | Open the linked cloud dashboard | Both new names are there, within one sync cycle (30 s) |
| 8 | Open the ChirpStack UI for that device | Its device name is the new one |
| 9 | Rename the zone to a 101-character name | `400` with `reason: "name_too_long"`, the translated sentence under the input, the stored name unchanged |
| 10 | Stop ChirpStack on the gateway | The service is down; the dashboard still loads |
| 11 | Rename the same device again | The rename succeeds, the dashboard shows the new name, and the route's JSON carries `chirpstack: "failed"` |
| 12 | Time step 11 | The response comes back in about five seconds, not twenty. This is the whole point of `NAME_UPDATE_DEADLINE_MS` |
| 13 | Read `devices.name` on the gateway | It holds the new name: a ChirpStack failure never rolls the database write back |
| 14 | Start ChirpStack again and rename once more | `chirpstack: "updated"`, and the ChirpStack UI catches up |
| 15 | Check the Node-RED log for the window of steps 10 to 13 | One `node.warn` per failed attempt, naming the DevEUI. No `node.error`, no unhandled rejection |

Paste the JSON of steps 6, 11 and 14 and the log lines of step 15 into the
pull-request body. A checklist without output is not evidence.

- [ ] **Step 9: Open the pull request**

`docs/engineering-playbook.md` section 2 asks for root cause, the fix, the
deliberate trade-offs and the verification output, so that a reviewer six months
from now can audit the decision without archaeology. The body carries, in this
order:

1. **What this adds.** Rename for zones and devices on the edge: two routes, one
   receiver for `UPSERT_DEVICE_NAME` and `UPSERT_ZONE_NAME`, the capability
   `entity_name_commands_v1`, the rename affordance in the dashboard. A link to
   `docs/superpowers/specs/2026-09-21-zone-device-rename-design.md` and to this
   plan.
2. **The defects it closes**, each with the behaviour before and after: the
   legacy `UPSERT_ZONE` branch that renamed a zone to `Zone` when a
   legacy-shaped command carried no name (spec defect 5); four different name
   checks across the create and command paths (defect 4); `ensureDeviceProvisioned`
   setting the ChirpStack name only at creation (defect 3).
3. **The deliberate trade-offs.** Last-writer-wins by arrival, with no base
   version check (D2). ChirpStack updated on a best-effort basis, so an outage
   never fails a rename (D3). One rule for create and rename, which means create
   now refuses names it used to accept (D4). The name update bounded at five
   seconds rather than the client's twenty, so a restarting ChirpStack costs a
   spinner and not a timeout. `resources.schema.json` untouched, so a row that
   already exceeds 100 characters keeps syncing (D6).
4. **Compatibility.** Stage 1 is safe against an older cloud: it emits only
   `ZONE_UPSERTED` and `DEVICE_FLAGS_UPDATED`, which every deployed cloud
   already applies, and an unknown capability string is ignored. The cloud work
   is stages 2 and 3 in osi-server and is not in this pull request.
5. **Verification.** The gate table of step 1 with each command's real output and
   exit status, the test counts of step 2, the typecheck and unit-test output of
   step 3, the build summary of step 4.
6. **Bench check.** The step 8 table with its results, the pasted JSON and log
   lines, and the name of whoever gave the go-ahead. If it was not run, say so
   and say why.
7. **Follow-ups.** The list under "Issues to file separately" at the end of this
   plan, with the issue numbers once they are filed.

Do not push the branch or open the pull request until the repository owner asks
for it.

---

## Issues to file separately

Each of these was found while the plan was written, each is outside stage 1, and none blocks it. File them before the pull request so the follow-ups have numbers to reference.

- The root of `docs/contracts/sync-schema/commands.schema.json` sets `additionalProperties: false` and does not declare `zone` or `target_sync_version`, so a real `UPSERT_ZONE` payload does not validate against its own schema today. Task 8 adds only the three properties the two new commands need.
- No workflow runs `osi-installation-location-helper/index.test.js`: `grep -rn "installation-location-helper" .github/` returns nothing. The module that this plan's receiver is modelled on has no CI coverage.
- `reject-indefinite-open`'s `COMMAND_TYPES_FALLBACK` is missing `UPSERT_DEVICE_INSTALLATION_LOCATION` and `UPSERT_DEVICE_RADIO_CONFIGURATION`, which `cmd-type-registry` has. `verify-command-safety.js` mirrors only actuator keys, so the gap is legal, but a command of either type that arrives before the startup inject has run is dropped.
- `scoped-device-config-guard` declares `outputs: 24` while carrying 26 `wires` entries and a 25-route table. Node-RED routes by `wires` index, so it works and the editor field is stale.
- `scripts/verify-flows-size-ratchet-allowances.json` gives `scoped-zone-create-router` a `new_node_ceilings` entry and no `node_allowances` entry, so a node that is no longer new has zero growth headroom. Task 9 adds one for this branch; other nodes may carry the same shape.
- The gateway's Node version is pinned nowhere in this repository. `docs/architecture/independent-architecture-review-2026-09-01.md:126` records a Node 20-era OpenWrt package without a build number, and the Pi 4 line may differ again. CI runs Node 22, so a runtime-feature regression would not show up there.
- Spec defect 6 beyond the rename: every other cloud zone edit that travels as a legacy `UPSERT_ZONE` keeps the whole-row overwrite and the unguarded `sync_version`. This plan moves only the rename off that path. The defect needs an issue in both repositories.
- `post-zone-insert` and `post-devices-insert` build their SQL by string concatenation. The new routes use bound parameters; the two older nodes were left as they are (spec section 5.9).
