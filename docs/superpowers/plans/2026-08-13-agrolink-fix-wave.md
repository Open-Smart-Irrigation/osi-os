# AgroLink fix wave — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear every adjudicated finding on `feat/journal-cloud-primary` so the write-only-scoping pair can merge, the branch can deploy, and the spec §10 two-account walkthrough can run for real.

**Input:** [2026-08-13-agrolink-branch-findings-ledger.md](../reviews/2026-08-13-agrolink-branch-findings-ledger.md). Findings are adjudicated and verified; this plan implements them and does not re-open them. Every MG, BR and SF row owns a task. FU rows are batched into one cleanup task per repo.

**Spec:** [2026-08-12-write-only-scoping-device-add-design.md](../specs/2026-08-12-write-only-scoping-device-add-design.md) v2. Its W and P constraints still bind every fix here — a repair that violates W1/W2/W9/W10 or P1–P11 is a defect no matter what the ledger row says.

**Repos:**
- Edge: `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep`, branch `feat/journal-cloud-primary`, base `7335bebe`.
- Cloud: `/home/phil/Repos/osi-server/.worktrees/agrolink`, branch `feat/journal-cloud-primary`, base `69fc0667`.

Edge task paths are relative to the edge worktree, cloud task paths to the cloud worktree. This plan file lives in the edge repo because plans for both repos do.

**Phases.** Tasks inside a phase are independent unless the task says otherwise; phases are ordered. 37 tasks.

| Phase | Tasks | Contents | Gate |
|---|---|---|---|
| 1 | 9 | Merge gates for the write-only-scoping pair: E1–E5, C1–C4 | The pair cannot merge until all nine are green |
| 2 | 8 | Branch blockers: X1–X7, D1 | The branch cannot deploy until all eight are green |
| 3 | 11 | Should-fixes: E6–E10, C5–C6, X8–X11 | None |
| L | 3 | Live-state repairs: L1–L3 (ledger D4, D5, D3+D6) | Runs against live systems; own rules, own skill |
| 4 | 6 | Batched cleanups, the full cloud sweep, the deploy-day mirror gate, the §10 walkthrough | Walkthrough is the branch's exit gate |

**Ledger coverage.** Every MG, BR, SF and D row maps to a task; the four FU rows are batched, one per repo plus one branch-wide.

| Ledger rows | Task | Phase |
|---|---|---|
| E1, E2, E3, E4, E5 | E1–E5 | 1 |
| C1, C2, C3, C4 | C1–C4 | 1 |
| X1, X2, X3, X4, X5, X6, X7 | X1–X7 | 2 |
| D1 | D1 | 2 |
| E6, E7, E8, E9, E10 | E6–E10 | 3 |
| C5, C6 | C5, C6 | 3 |
| X8, X9, X10, X11 | X8–X11 | 3 |
| D4 | L1 | L |
| D5 | L2 | L |
| D3, D6 | L3 | L |
| E11 (FU) | E11 | 4 |
| C7 (FU) | C7 | 4 |
| X12 (FU) | X12 | 4 |
| C8 (FU) | C8 | 4 |
| D2, D8 | D2, plus gates in the rollout law and the Phase L preamble | 4 |
| Spec §10 | W | 4 |
| D7 | No task. The Agroscope banner on the cloud branch is deliberate (`f6bc5491`); the ledger records it as a non-issue. Do not "fix" it. | — |

## Rollout law

Quoted from the ledger, and binding on every task below:

> Cloud merges and deploys before any edge flows/firmware rollout — never the reverse. No firmware images until X1 lands. The §10 two-account walkthrough runs after the MG set is fixed on both sides. Deploy day itself is gated on D8 (gateway back online), then D2 (mirrors verified populated) before anyone calls the deployment done.

Consequences the executor must honor:

- No `git push`, no deploy, no live-Pi work in the code phases (1, 2, 3, 4). Every task there ends at a local commit. Phase L is the one exception and says so in its own preamble.
- Nothing in Phase 2 may be reordered so that an edge flows change reaches a gateway before the paired cloud change is deployed. X6 and X7 exist precisely because that ordering was violated in the design.
- `scripts/build-firmware-image.sh` and any image-producing path stays untouched and unrun until X1's provenance regeneration and its CI gate are committed.
- Deploy day is not scheduled until agrolink-test-01 answers on SSH and `:1880` again (D8), and the edge half of the D2 emit-gate check has been run on it.
- After the lockstep deploy, `gateway_user_mirrors` must be verified non-empty for both linked gateways **before** the deployment is called done (D2). Today it has zero rows and `last_acknowledged_at` is NULL on both accounts, and the widened read path throws without a mirror row, so a deploy that skips this check leaves every read 403ing and the dashboard dead. Task D2 in Phase 4 owns the check and its recovery steps.
- The Phase 4 walkthrough runs only after Phase 1 is green in both repos, the cloud half is deployed to `agro-link.ch`, and task D2 has passed.

## Global constraints

These are carried forward from the two write-only-scoping plans and apply to every task.

**Both repos**

- Each task commits separately. The failing test lands in the same commit as its fix (TDD order inside the task, one commit at the end).
- Never run two frontend builds concurrently — this workstation OOMs, because swap is zram with no disk fallback. Reviewers do not build.
- No push, no deploy, no SSH to a gateway or to a cloud host.

**Edge**

- **bcm2712 is the edit source; bcm2709 is a byte-identical mirror.** This covers `flows.json`, `osi-scope-helper/`, `osi-journal/` and `osi-command-ledger/`. Never hand-edit the mirror; the edit script writes both.
- **`flows.json` edits follow the `osi-flows-json-editing` skill.** Load `.claude/skills/osi-flows-json-editing` before touching the file. One-shot Node script in the scratchpad only, never an Edit-tool string replacement. Run the byte-identical roundtrip guard before and after every mutation. The Task 1 skeleton in [2026-08-12-write-only-scoping-edge.md](2026-08-12-write-only-scoping-edge.md) is the canonical script; reuse it verbatim and swap only the MUTATE block.
- **Flag-off byte-equivalence.** Every node touched here already branches on `String(env.get('OSI_SCOPED_ACCESS') || '') === '1'`. The `else` side is production behavior on Silvan, kaba100 and Uganda and must come out unchanged. E5 is entirely about restoring that promise where Task 15 broke it.
- **Never touch:** `write-strega-expectation`, the internals of `assertFreshDeviceAccess`, `EdgeOwnershipService`, and `sync-init-fn`. The actuation dual-gate (P4), the shared write hubs (P6), workspaces (P3) and journal custom vocabulary (W9) stay as they are.
- **The size ratchet is measure-and-raise.** `scripts/verify-flows-size-ratchet-allowances.json` pins an absolute `max_chars` per function node plus a per-profile `max_total`, and every ceiling sits at exactly the committed size. Any growth, a comment included, fails `node scripts/verify-flows-size-ratchet.js`. Measure with `scripts/flows-size-scan`, set the new value, append the reason to that node's existing `reason` string, and do the same for `total_allowance`. A node that shrank gets its ceiling lowered. Never regenerate the file wholesale.
- Frontend tests: `cd web/react-gui && npm run test:unit`. Never bare `npx vitest run` — it skips the `tsx --test` half.
- Flows gate before every `flows.json` commit: `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js && node scripts/verify-flows-size-ratchet.js`.

**Cloud**

- Backend, iterating: `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test --tests '<pattern>' -x buildFrontend -x buildTerraIntelligenceFrontend`. The two `-x` flags are not optional during iteration — a bare `./gradlew test` triggers **two** frontend builds, which is the concurrent-build case that OOMs this workstation. The full sweep without them runs once, in C8.
- Testcontainers ITs need `api.version=1.44` in `~/.docker-java.properties` (present and verified on this workstation); run `./gradlew --stop` after any Docker or environment change.
- Frontend: `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit`. A single-file `npx vitest run --environment jsdom src/<path>` is for iteration only, never a pass gate.
- Do not touch `EdgeOwnershipService`, `ScopedAccessUserApplier`, `ScopedAccessZoneAssignmentApplier`, `ScopedAccessPlotAssignmentApplier` or `EdgeSyncService`.
- Never edit the main osi-server checkout.

---

# Phase 1 — merge gates for the write-only-scoping pair

Nine tasks. The edge and cloud halves of the write-only-scoping work cannot merge until all nine are green, in both repos, because each one breaks a promise the spec makes: E1 and C3 make the feature unusable, E2 and C4 hide working surfaces, E3 and C1 make the trigger bug recur under a new name, E4 and C2 are authorization holes, and E5 breaks the flag-off guarantee for Silvan, kaba100 and Uganda.

E1–E5 are edge; C1–C4 are cloud. Within a repo the tasks are independent. Across repos they are independent too, but see the rollout law: the cloud half deploys first.

## Task E1 — the add-device modals send the selected type

Both modals compute `type_id` from `catalog[0].id` and throw away the dropdown selection, so every device registers as the first catalog entry (`KIWI_SENSOR` in practice) in both flag modes. `ZoneDeviceModal.test.tsx` cannot catch it: its catalog mock has one item, which is simultaneously `catalog[0].id` and the only selectable option. `AddDeviceModal` has no test file at all.

**Files**
- Modify: `web/react-gui/src/components/farming/AddDeviceModal.tsx` (lines 52-58)
- Modify: `web/react-gui/src/components/farming/ZoneDeviceModal.tsx` (lines 97-105)
- Modify: `web/react-gui/src/components/farming/__tests__/ZoneDeviceModal.test.tsx` (catalog mock at lines 29-36)
- Create: `web/react-gui/src/components/farming/__tests__/AddDeviceModal.test.tsx`

**Interfaces**
- Unchanged: `devicesAPI.add({ deveui, name, type_id, appkey?, zone_id? })`, both modals' props.
- Changed: `type_id` is the value of the `device-type` `<select>` (`selectedType`), which the catalog effect already seeds with `data[0].id` on open.

**Steps**

- [ ] **Widen the ZoneDeviceModal catalog mock to two items.** In `__tests__/ZoneDeviceModal.test.tsx`, replace the `beforeEach` catalog stub:

```tsx
    vi.mocked(devicesAPI.getCatalog).mockResolvedValue([
      { id: 'DRAGINO_LSN50', name: 'Dragino LSN50' },
    ] as never);
```

  with

```tsx
    // Two entries, deliberately: with a single-item catalog `catalog[0].id` and
    // the selected option are the same string, so the assertion below cannot
    // tell "sent the selection" from "sent the first catalog row".
    vi.mocked(devicesAPI.getCatalog).mockResolvedValue([
      { id: 'DRAGINO_LSN50', name: 'Dragino LSN50' },
      { id: 'STREGA_VALVE', name: 'Strega valve' },
    ] as never);
```

  Then add a case that picks the second entry:

```tsx
  it('registers the device type the operator selected, not the first catalog row', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'zoneDeviceModal.tabRegister' }));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Strega valve' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText('addModal.deviceType'), {
      target: { value: 'STREGA_VALVE' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deviceName'), {
      target: { value: 'North valve' },
    });
    fireEvent.change(screen.getByLabelText('addModal.deveui'), {
      target: { value: 'BBBB000000000003' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'zoneDeviceModal.registerSubmit' }));

    await waitFor(() =>
      expect(devicesAPI.add).toHaveBeenCalledWith(
        expect.objectContaining({ type_id: 'STREGA_VALVE' }),
      ),
    );
  });
```

- [ ] **Create `__tests__/AddDeviceModal.test.tsx`.** Follow the mock conventions of `ZoneDeviceModal.test.tsx` verbatim (`// @vitest-environment jsdom` header, the `vi.mock('react-i18next', …)` key-echo stub, `vi.mock('../../../services/api', …)`), with the same two-item catalog. Cover: the header flow registers the selected type and sends no `zone_id`; a malformed DevEUI is rejected before any API call; a malformed AppKey is rejected. The header flow registering unassigned is the W3 behavior the spec pins, so assert the absence of `zone_id` explicitly:

```tsx
    await waitFor(() =>
      expect(devicesAPI.add).toHaveBeenCalledWith({
        deveui: 'AAAA000000000001',
        name: 'Header sensor',
        type_id: 'STREGA_VALVE',
        appkey: undefined,
      }),
    );
```

- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit`
  Expected failure: both new cases fail with `type_id: 'DRAGINO_LSN50'` received where `'STREGA_VALVE'` is asserted.

- [ ] **Fix both modals.** In each file replace

```tsx
      const currentCatalog = catalog.length > 0 ? catalog : await devicesAPI.getCatalog();
      const typeId = currentCatalog[0]?.id ?? selectedType;
```

  with

```tsx
      // The dropdown is the source of truth. The catalog effect already seeds
      // selectedType with data[0].id when the modal opens, so there is nothing
      // to re-fetch here -- and re-deriving from catalog[0] discarded the pick.
      const typeId = selectedType;
```

  The two source lines are byte-identical across the two files, so make the edit file by file rather than with a repo-wide replace. `ZoneDeviceModal.tsx` is identifiable by the `zone_id: zoneId,` line that follows in its `devicesAPI.add` call.

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit && npm run typecheck` → both exit 0. `devicesAPI.getCatalog` may now be unused inside the submit handlers; leave the import and the load effect alone, both still populate the dropdown.

- [ ] **Commit:**
```bash
git add web/react-gui/src/components/farming/AddDeviceModal.tsx web/react-gui/src/components/farming/ZoneDeviceModal.tsx web/react-gui/src/components/farming/__tests__/ZoneDeviceModal.test.tsx web/react-gui/src/components/farming/__tests__/AddDeviceModal.test.tsx
git commit -m "fix(gui): register the selected device type, not the first catalog row"
```

---

## Task E2 — zone-assigned weather stations stay on their zone card

The Task 10 rewrite added `&& !weatherDevice` to the `byZone` branch. On the base the branch read `device.irrigation_zone_id && visibleZoneIds.has(device.irrigation_zone_id)`, with `weatherDevice` appearing only in the `else if` that swept weather stations out of *invisible* zones — a scope carve-out. Dropping the scope term was correct; negating the weather term on the zone branch was not. Today every zone-assigned S2120 and LoRain lands in "Unassigned" in both flag modes, and a zone whose only device is a weather station renders its empty state. Silvan, kaba100 and Uganda are affected, which makes this a flag-off production regression.

**Files**
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx` (lines 89-115)
- Modify: `web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx` (the `IrrigationZoneCard` mock at lines 114-116)

**Interfaces**
- Unchanged: `devicesByZone: Map<number, Device[]>`, `unassignedDevices: Device[]`, and the `unassignedS2120` / `unassignedLoRain` derived lists (genuinely unassigned weather stations still have their own sections).
- Changed: a device whose `irrigation_zone_id` matches a zone in the list goes to that zone's bucket regardless of type. `IrrigationZoneCard` keeps rendering its own weather section from the devices it receives; the dashboard does not pre-empt that.

**Steps**

- [ ] **Unmock `IrrigationZoneCard` far enough to see the devices prop.** The current stub discards `devices` entirely, so no assertion about `devicesByZone` can reach the DOM. Replace:

```tsx
vi.mock('../../components/farming/IrrigationZoneCard', () => ({
  IrrigationZoneCard: ({ zone }: { zone: { name: string } }) => <article>{zone.name}</article>,
}));
```

  with

```tsx
// The stub renders the devices prop so assertions about devicesByZone have
// something to see. Mocking it away entirely is why the weather-station
// regression shipped unnoticed.
vi.mock('../../components/farming/IrrigationZoneCard', () => ({
  IrrigationZoneCard: ({
    zone,
    devices,
  }: {
    zone: { id: number; name: string };
    devices: Array<{ deveui: string; name: string }>;
  }) => (
    <article data-testid={`zone-card-${zone.id}`}>
      {zone.name}
      {devices.map((device) => (
        <span key={device.deveui} data-testid={`zone-${zone.id}-device-${device.deveui}`}>
          {device.name}
        </span>
      ))}
    </article>
  ),
}));
```

- [ ] **Write the failing test.** Add to `FarmingDashboardHeaderWiring.test.tsx`:

```tsx
  it.each([
    ['SENSECAP_S2120'],
    ['AQUASCOPE_LORAIN'],
  ])('keeps a zone-assigned %s on its zone card', async (typeId) => {
    getZones.mockResolvedValue([
      {
        id: 1,
        name: 'Owned zone',
        zone_uuid: 'zone-visible',
        device_count: 1,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        schedule: null,
      },
    ]);
    getDevices.mockResolvedValue([
      {
        deveui: 'WX00000000000001',
        name: 'Field weather',
        type_id: typeId,
        irrigation_zone_id: 1,
      },
    ]);

    renderDashboard();

    await waitFor(() =>
      expect(screen.getByTestId('zone-1-device-WX00000000000001')).toBeInTheDocument(),
    );
  });
```

  **Executor note:** read the file's existing `getDevices` fixtures first and match their shape — the `Device` type has more fields than the four above, and the mock is typed. Reuse the file's existing device factory if one is present.

- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit`
  Expected failure: `keeps a zone-assigned SENSECAP_S2120 on its zone card` fails with `Unable to find an element by: [data-testid="zone-1-device-WX00000000000001"]` — the device is in the unassigned bucket.

- [ ] **Fix the memo.** In `FarmingDashboard.tsx` replace lines 99-110:

```tsx
      const weatherDevice =
        device.type_id === 'SENSECAP_S2120' || device.type_id === 'AQUASCOPE_LORAIN';
      // Weather stations render in their own multi-zone section even when they
      // are zone-assigned -- that is the multi-zone table design, not a scope
      // carve-out. The scope carve-out (visible-zone membership) is gone (W1).
      if (device.irrigation_zone_id && zoneIds.has(device.irrigation_zone_id) && !weatherDevice) {
```

  with

```tsx
      // Write-only scoping (W1) removed the visible-zone term from this branch.
      // The weather-station term went with it: it existed only to sweep weather
      // stations out of zones the caller could not see. A zone-assigned weather
      // station belongs on its zone card, where IrrigationZoneCard renders its
      // own weather section; unassignedS2120/unassignedLoRain still cover the
      // genuinely unassigned ones.
      if (device.irrigation_zone_id && zoneIds.has(device.irrigation_zone_id)) {
```

- [ ] **Run to see it pass:** `cd web/react-gui && npm run test:unit && npm run typecheck` → both exit 0. TypeScript will flag `weatherDevice` as unused if you left it; delete the const.

- [ ] **Commit:**
```bash
git add web/react-gui/src/pages/FarmingDashboard.tsx web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx
git commit -m "fix(gui): keep zone-assigned weather stations on their zone card"
```

---
## Task E3 — the lifecycle predicate stops hiding cloud-assigned devices

`get-devices-query`'s scoped `whereClause` is `d.user_id IS NOT NULL`. It was chosen because `DELETE /api/devices` unclaims (`user_id = NULL`) instead of tombstoning, so the clause is what makes a deleted device leave the list. It also hides every device the cloud assigned to a zone without setting `user_id` — which is exactly what Task 15's `INSERT OR IGNORE` plus its `user_id`-preserving UPDATE produces. Proven end to end: the REGISTER_DEVICE ACK reports SUCCESS, the device sits in `irrigation_zones`, and it appears in no list. Plan v3 of the write-only-scoping edge plan carries the same defect.

The repair keeps the lifecycle meaning and adds the zone as a second liveness signal: an unclaimed device with no zone is gone, an unclaimed device sitting in a zone is a cloud-introduced device that has not synced its owner yet.

**Files**
- Modify: `scripts/test-scoped-access-reads.js`
- Modify: both `flows.json` profiles (node `get-devices-query`)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces**
- Changed: the scoped `whereClause` becomes `(d.user_id IS NOT NULL OR d.irrigation_zone_id IS NOT NULL)`. It is consumed at the node's `'WHERE ' + whereClause + ' AND d.deleted_at IS NULL'` line; the parenthesis matters, because that `AND` would otherwise bind to the `OR`.
- Unchanged: the flag-off `d.user_id = ' + userId` branch, and `assertEnabledAccount` (P1).

**Steps**

- [ ] **Write the failing test.** In `scripts/test-scoped-access-reads.js`, next to the existing `'F1: an unclaimed device is out of the account-wide list for everyone'` case, add:

```js
test('F1: a cloud-assigned device with no local owner is visible', async () => {
  const db = seedScopedDb();
  // What the REGISTER_DEVICE applier leaves behind: INSERT OR IGNORE keeps an
  // existing row's user_id, and a cloud-introduced row has none, while the
  // zoneUuid resolution assigns it. user_id IS NOT NULL alone hides it.
  db.exec(`
    INSERT INTO devices (
      deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at
    ) VALUES
      ('CLOUDONLY1', 'Cloud LSN50', 'DRAGINO_LSN50', NULL, 1, '2026-01-01', '2026-01-01');
  `);
  try {
    for (const userId of [1, 2, 3]) {
      scopeHelper._resetForTests();
      const deveuis = (await deviceList(db, userId)).map((row) => row.deveui);
      assert.ok(
        deveuis.includes('CLOUDONLY1'),
        `user ${userId} must see a zone-assigned device the cloud introduced`
      );
    }
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});
```

  Leave `'F1: an unclaimed device is out of the account-wide list for everyone'` exactly as it is. It seeds `user_id = NULL, irrigation_zone_id = NULL` and must stay green — it is the guard that stops this fix from turning into "show everything".

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-reads.js`
  Expected failure: `F1: a cloud-assigned device with no local owner is visible` fails on `user 1 must see a zone-assigned device the cloud introduced`.

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-e3.js` — the Task 1 skeleton from the write-only-scoping edge plan with this MUTATE section:

```js
replaceOnce(
  nodeById(flows, 'get-devices-query'),
  `      // d.user_id IS NOT NULL is a LIFECYCLE filter, not a scope filter: DELETE
      // /api/devices unclaims (user_id = NULL) instead of tombstoning, so this
      // clause is the only thing that makes a deleted device leave the list.
      // Do NOT strip it as "leftover per-user scoping" in a later simplification.
      whereClause = 'd.user_id IS NOT NULL';`,
  `      // LIFECYCLE filter, not a scope filter. DELETE /api/devices unclaims
      // (user_id = NULL) instead of tombstoning, so an owner or a zone is what
      // marks a row as live. The zone arm is load-bearing: the REGISTER_DEVICE
      // applier's INSERT OR IGNORE leaves user_id NULL on a cloud-introduced
      // device, and owner-only would hide it from every list while its ACK said
      // SUCCESS. Keep the parentheses -- the caller appends AND d.deleted_at IS
      // NULL, which would otherwise bind to the OR.
      // Do NOT strip either arm as "leftover per-user scoping".
      whereClause = '(d.user_id IS NOT NULL OR d.irrigation_zone_id IS NOT NULL)';`
);
```

- [ ] **Run to see it pass:** `node --test scripts/test-scoped-access-reads.js` → exit 0.

- [ ] **Run the rest of the edge backend suite:** `node --test scripts/test-scoped-access-writes.js scripts/test-scoped-access-command-path.js`
  Expected: exit 0. This is the 91-test set the ledger records as staying green under this predicate; a red here means the fix is wrong, not that the test is stale.

- [ ] **Raise the size ceiling for `get-devices-query`** and `total_allowance.max_total` in `scripts/verify-flows-size-ratchet-allowances.json`. Measure first:

```bash
node -e "const {nodeSizes,totalChars}=require('./scripts/flows-size-scan');const fs=require('fs');const f=JSON.parse(fs.readFileSync('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json','utf8'));const m=nodeSizes(f);for(const id of ['get-devices-query']) console.log(id, m.get(id).chars); console.log('total', totalChars(f));"
```

  Set the measured values and append to both `reason` strings, naming E3 and the cloud-introduced-device case.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js && node scripts/verify-flows-size-ratchet.js` → all pass.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-reads.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json
git commit -m "fix(scope): keep cloud-assigned devices with no local owner in the device list"
```

---

## Task E4 — gateway card-preference writes go through the admin gate

`scopeRouteForRequest` keys the gateway route on `method === 'GET'`, so `PUT /api/history/gateways/:eui/cards/:cardId/preferences` and `POST .../opened` resolve to `route === null`. `scopeCheckForRoute` then runs only the disabled-account check and skips `assertRole(..., 'admin', ...)`. An enabled viewer gets a gateway-existence oracle (`getGatewayContext` 404s on an unknown EUI and 200s on a real one) plus a write into the preference table. P2 says gateway history is admin-only, reads included; a write is worse than a read.

**Files**
- Modify: `scripts/test-scoped-access-reads.js`
- Modify: both `flows.json` profiles (node `history-api-router-fn`)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces**
- Changed: `scopeRouteForRequest(method, requestPath, params)` returns `{ kind: 'gateway' }` for any method on `/api/history/gateways/:eui/…`. The `params` argument stays unused; do not remove it, `scripts/verify-history-api-contract.js` pins the call shape.
- Unchanged: the workspace branch (already method-agnostic), `scopeCheckForRoute`, and `getPreferenceRowsForScope` / `upsertPreference`, which keep their own `user_id` filters (P3).

**Steps**

- [ ] **Write the failing test.** In `scripts/test-scoped-access-reads.js`, extend the existing `'F4b: gateway history is admin-only while scoped access is enabled'` neighbourhood with:

```js
test('P2: gateway card-preference writes are admin-only too', async () => {
  for (const [label, method, path, params] of [
    ['preferences PUT', 'PUT', '/api/history/gateways/0016C001F1000001/cards/some-card/preferences',
      { gatewayEui: '0016C001F1000001', cardId: 'some-card' }],
    ['opened POST', 'POST', '/api/history/gateways/0016C001F1000001/cards/some-card/opened',
      { gatewayEui: '0016C001F1000001', cardId: 'some-card' }],
  ]) {
    scopeHelper._resetForTests();
    const db = seedScopedDb();
    try {
      const response = await executeFunction(loadNode('history-api-router-fn'), {
        msg: historyRequest(3, 'view1', method, path, params, {}),
        env: ENV,
        db,
      });
      assert.equal(
        response.result && response.result.statusCode,
        403,
        `${label}: a viewer must not write a gateway card preference`
      );
    } finally {
      db.close();
    }
  }
  scopeHelper._resetForTests();
});

test('P2: an admin still writes gateway card preferences', async () => {
  scopeHelper._resetForTests();
  const db = seedScopedDb();
  try {
    const response = await executeFunction(loadNode('history-api-router-fn'), {
      msg: historyRequest(
        1,
        'admin1',
        'POST',
        '/api/history/gateways/0016C001F1000001/cards/some-card/opened',
        { gatewayEui: '0016C001F1000001', cardId: 'some-card' },
        {}
      ),
      env: ENV,
      db,
    });
    assert.notEqual(
      response.result && response.result.statusCode,
      403,
      'the admin path must not regress into a blanket denial'
    );
  } finally {
    db.close();
    scopeHelper._resetForTests();
  }
});
```

  **Executor note:** read `historyRequest`'s signature in the file first — the gateway EUI in the fixtures must match whatever `seedScopedDb` and `ENV.DEVICE_EUI` use, otherwise the admin case 404s before the assertion means anything. Use the seeded value, not the literal above, if they differ.

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-reads.js`
  Expected failure: `P2: gateway card-preference writes are admin-only too` fails on `preferences PUT: a viewer must not write a gateway card preference` with `200 !== 403`.

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-e4.js` with this MUTATE section:

```js
replaceOnce(
  nodeById(flows, 'history-api-router-fn'),
  `  if (method === 'GET' && /^\\/api\\/history\\/gateways\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'gateway' };
  }`,
  `  // P2: gateway history is admin-only for every method. The GET conjunct that
  // used to sit here let PUT .../preferences and POST .../opened resolve to a
  // null route, which skipped the admin assertion in scopeCheckForRoute and
  // handed an enabled viewer a gateway-existence oracle plus a write.
  if (/^\\/api\\/history\\/gateways\\/[^/]+\\//.test(requestPath)) {
    return { kind: 'gateway' };
  }`
);
```

- [ ] **Run to see it pass:**
```bash
node --test scripts/test-scoped-access-reads.js
node scripts/verify-history-api-contract.js
node --test scripts/verify-history-api-contract.test.js
```
  Expected: all exit 0.

- [ ] **Raise the size ceiling for `history-api-router-fn`** and `total_allowance.max_total`, measured as in E3, appending the E4 reason.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js && node scripts/verify-flows-size-ratchet.js` → all pass.

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-reads.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json
git commit -m "fix(scope): apply the admin gate to gateway card-preference writes"
```

---

## Task E5 — the REGISTER_DEVICE zone seam is scoped-mode only

`cs-reg-cloud-fn` reads no flag. It resolves `params.zoneUuid` against `irrigation_zones` on every gateway, assigns the device, and puts `zoneAssignedId` / `zoneWarning` on the ACK; `cs-reg-cloud-ack-fn` forwards both onto `devices/<eui>/command_ack` unconditionally. Silvan, kaba100 and Uganda run flag-off and would honor a cloud-supplied `zoneUuid` and emit two ACK fields their cloud has never seen. Spec §10 promises flag-off gateways see no behavior change, and the cloud has not signed off on an amendment, so the seam gets gated.

Gating it is also what makes the ACK shape honest: `zoneAssignedId` and `zoneWarning` become fields that exist exactly when scoped mode is on, rather than fields that are always present and always null on three quarters of the fleet.

**Files**
- Modify: `scripts/test-scoped-access-writes.js`
- Modify: `scripts/verify-sync-flow.js` (the five `expectIncludesById` assertions for `cs-reg-cloud-fn` / `cs-reg-cloud-ack-fn`, around line 4218)
- Modify: both `flows.json` profiles (nodes `cs-reg-cloud-fn`, `cs-reg-cloud-ack-fn`)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces**
- Consumes: `env.get('OSI_SCOPED_ACCESS')`, already available in both nodes.
- Produces, scoped mode: unchanged from today — `zoneAssignedId: number | null`, `zoneWarning: string | null` on the ACK, and the precondition-guarded assignment UPDATE.
- Produces, flag-off: the pre-Task-15 ACK exactly — `{ state, deviceEui, provisionedInChirpStack }` with neither zone key present — and no zone resolution, no assignment UPDATE, no `node.warn`.
- Unchanged: authorization. This is a cloud-authorized command; do not add `verifyBearer`, `assertFreshRole` or any `assertFresh*` call to either node.

**Steps**

- [ ] **Write the failing tests.** Append to `scripts/test-scoped-access-writes.js`, reusing the existing `REGISTER_ENV`, `applyRegister` and `fakeChirpstackLib` helpers:

```js
const REGISTER_ENV_FLAG_OFF = Object.assign({}, REGISTER_ENV, { OSI_SCOPED_ACCESS: '0' });

async function applyRegisterFlagOff(db, devEui, extras) {
  return executeFunction(loadNode('cs-reg-cloud-fn'), {
    msg: registerCommand(devEui, extras),
    env: REGISTER_ENV_FLAG_OFF,
    db,
    libOverrides: { chirpstack: fakeChirpstackLib() },
  });
}

test('§10: a flag-off gateway ignores a cloud zoneUuid and keeps the legacy ACK shape', async () => {
  const db = seedScopedDb();
  try {
    const response = await applyRegisterFlagOff(db, 'FLAGOFF1', { zoneUuid: 'z-1' });
    const ack = response.result[0].specialAck;

    assert.equal(ack.result, 'SUCCESS');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(ack, 'zoneAssignedId'),
      'flag-off ACKs must not gain zoneAssignedId'
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(ack, 'zoneWarning'),
      'flag-off ACKs must not gain zoneWarning'
    );
    assert.equal(
      db.prepare("SELECT irrigation_zone_id FROM devices WHERE deveui='FLAGOFF1'").get()
        .irrigation_zone_id,
      null,
      'a flag-off gateway must not honor a cloud-supplied zoneUuid'
    );
  } finally {
    db.close();
  }
});

test('§10: the flag-off command ACK payload carries no zone keys', async () => {
  const db = seedScopedDb();
  try {
    const applied = await applyRegisterFlagOff(db, 'FLAGOFF2', { zoneUuid: 'z-1' });
    const ackMessage = await executeFunction(loadNode('cs-reg-cloud-ack-fn'), {
      msg: applied.result[0],
      env: REGISTER_ENV_FLAG_OFF,
      db,
    });
    const payload = JSON.parse(ackMessage.result.payload);

    assert.equal(payload.commandType, 'REGISTER_DEVICE');
    assert.equal(payload.result, 'SUCCESS');
    assert.ok(!('zoneAssignedId' in payload), 'no zoneAssignedId on a flag-off ACK payload');
    assert.ok(!('zoneWarning' in payload), 'no zoneWarning on a flag-off ACK payload');
  } finally {
    db.close();
  }
});
```

  The five existing scoped-mode `P9:` / `W4:` REGISTER_DEVICE tests stay untouched and must stay green — together with the two above they are the both-modes pin.

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-writes.js`
  Expected failure: `§10: a flag-off gateway ignores a cloud zoneUuid and keeps the legacy ACK shape` fails on `flag-off ACKs must not gain zoneAssignedId`, and the `irrigation_zone_id` assertion fails with `1 !== null`.

- [ ] **Load the osi-flows-json-editing skill**, then run `<scratchpad>/flows-edit-e5.js` with this MUTATE section:

```js
const reg = nodeById(flows, 'cs-reg-cloud-fn');

// 1. Read the flag and gate the zone resolution behind it.
replaceOnce(
  reg,
  `  // W5/P9: the cloud sends zoneUuid, never an edge-local integer id. An unknown
  // or deleted zone must not fail the whole registration -- the device registers
  // unassigned and the ACK carries a warning the cloud can surface.
  let zoneId = null;
  let zoneWarning = null;
  var requestedZoneUuid = String(params.zoneUuid || params.zone_uuid || '').trim();`,
  `  // W5/P9: the cloud sends zoneUuid, never an edge-local integer id. An unknown
  // or deleted zone must not fail the whole registration -- the device registers
  // unassigned and the ACK carries a warning the cloud can surface.
  // Spec section 10: this whole seam is scoped-mode only. A flag-off gateway
  // (Silvan, kaba100, Uganda) must ignore a cloud-supplied zoneUuid and emit the
  // pre-seam ACK shape, because its cloud has never seen these fields.
  var scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
  let zoneId = null;
  let zoneWarning = null;
  var requestedZoneUuid = scopedOn
    ? String(params.zoneUuid || params.zone_uuid || '').trim()
    : '';`
);

// 2. Report the outcome only in scoped mode.
replaceOnce(
  reg,
  `  return [buildAck('SUCCESS', { state: 'APPLIED', deviceEui: devEui, provisionedInChirpStack: true, zoneAssignedId: zoneId, zoneWarning: zoneWarning }), null];`,
  `  var successExtras = { state: 'APPLIED', deviceEui: devEui, provisionedInChirpStack: true };
  if (scopedOn) {
    successExtras.zoneAssignedId = zoneId;
    successExtras.zoneWarning = zoneWarning;
  }
  return [buildAck('SUCCESS', successExtras), null];`
);

// 3. Forward the fields only when the applier set them.
replaceOnce(
  nodeById(flows, 'cs-reg-cloud-ack-fn'),
  `  // P9: zone resolution outcome. Present on every REGISTER_DEVICE ACK so the
  // cloud can tell "assigned" from "registered unassigned because the zone
  // vanished" without inferring it from a missing field.
  payload.zoneAssignedId = ack.zoneAssignedId != null ? Number(ack.zoneAssignedId) : null;
  payload.zoneWarning = ack.zoneWarning ? String(ack.zoneWarning) : null;`,
  `  // P9: zone resolution outcome, scoped mode only. The applier omits both keys
  // on a flag-off gateway, and this ACK payload omits them in turn -- a cloud
  // that predates the seam must see the shape it was built against.
  if (Object.prototype.hasOwnProperty.call(ack, 'zoneAssignedId')) {
    payload.zoneAssignedId = ack.zoneAssignedId != null ? Number(ack.zoneAssignedId) : null;
  }
  if (Object.prototype.hasOwnProperty.call(ack, 'zoneWarning')) {
    payload.zoneWarning = ack.zoneWarning ? String(ack.zoneWarning) : null;
  }`
);
```

  **Executor note:** `zoneId` and `zoneWarning` stay declared unconditionally so the assignment UPDATE at `if (zoneId !== null)` needs no edit — with `requestedZoneUuid` empty, `zoneId` is never set, and that block is already inert.

- [ ] **Re-point the contract assertions.** `scripts/verify-sync-flow.js` pins the old ACK line as an exact string; three of its five assertions no longer match. Replace:

```js
expectIncludesById('cs-reg-cloud-fn', "return [buildAck('SUCCESS', { state: 'APPLIED', deviceEui: devEui, provisionedInChirpStack: true, zoneAssignedId: zoneId, zoneWarning: zoneWarning }), null];", 'preserves the success ACK shape and reports the P9 zone-resolution outcome');
expectIncludesById('cs-reg-cloud-ack-fn', 'payload.zoneAssignedId = ack.zoneAssignedId != null ? Number(ack.zoneAssignedId) : null;', 'forwards the P9 zone assignment outcome');
expectIncludesById('cs-reg-cloud-ack-fn', 'payload.zoneWarning = ack.zoneWarning ? String(ack.zoneWarning) : null;', 'forwards the P9 zone resolution warning');
```

  with:

```js
expectIncludesById('cs-reg-cloud-fn', "var scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';", 'gates the P9 zone seam on scoped mode so flag-off gateways are unchanged');
expectIncludesById('cs-reg-cloud-fn', "var successExtras = { state: 'APPLIED', deviceEui: devEui, provisionedInChirpStack: true };", 'preserves the pre-seam success ACK shape as the flag-off baseline');
expectIncludesById('cs-reg-cloud-fn', 'successExtras.zoneAssignedId = zoneId;', 'reports the P9 zone-resolution outcome in scoped mode');
expectIncludesById('cs-reg-cloud-ack-fn', "Object.prototype.hasOwnProperty.call(ack, 'zoneAssignedId')", 'forwards the P9 zone assignment outcome only when the applier set it');
expectIncludesById('cs-reg-cloud-ack-fn', "Object.prototype.hasOwnProperty.call(ack, 'zoneWarning')", 'forwards the P9 zone resolution warning only when the applier set it');
```

  Keep the two zone-resolution assertions (`SELECT id FROM irrigation_zones …` and `AND irrigation_zone_id IS NULL`) as they are — both strings survive the edit.

- [ ] **Run to see it pass:** `node --test scripts/test-scoped-access-writes.js` → exit 0, with the five pre-existing scoped REGISTER_DEVICE cases still green.

- [ ] **Raise the size ceilings for `cs-reg-cloud-fn` and `cs-reg-cloud-ack-fn`** and `total_allowance.max_total`, measured as in E3, appending the E5 reason to each.

- [ ] **Run the flows gate:** `node scripts/verify-sync-flow.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-scoped-access.js && node scripts/verify-flows-size-ratchet.js` → all pass, `verify-sync-flow.js` ending `All parity checks passed.`

- [ ] **Commit:**
```bash
git add scripts/test-scoped-access-writes.js scripts/verify-sync-flow.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json
git commit -m "fix(scope): gate the REGISTER_DEVICE zone seam on scoped mode"
```

**Deferred to X7:** the JSON-schema pin for the ACK extras. `docs/contracts/sync-schema/commands.schema.json` describes command *requests* only and has no ACK object; adding one is a mirrored cross-repo contract edit, and X7 is already opening that file for the capability matrix. Note it there rather than half-pinning it here.

---
## Task C1 — a granted researcher can assign an unassigned device

`DeviceMutationService.authorize` (`DeviceMutationService.java:404-435`) branches on the device's *current* zone. When the device has none, it falls through to `else if (device.getClaimedBy() == null || !actor.getId().equals(device.getClaimedBy().getId()))` and throws `404 Device not found`. A granted researcher assigning a device someone else claimed never reaches `assign`'s own `requireWriteZone` on the next line — `authorize` runs first (`:72`), 404s, and the write-scope check at `:73` is dead code for that shape.

**The widening decision, as the ledger states it:** *widen the zoneless branch to target-zone write scope*. Concretely — when the device sits in no zone, the gate is write scope on the zone the device is going **into**, not claimer identity. Claimer identity stays the fallback only for the callers that have no target zone (`upsert`, `unassign`, `unclaim`), so nothing outside the assign path changes. This is the same rule the edge enforces: assignment operates on unassigned devices and is gated on the destination zone (P7, W4), never on who registered the hardware.

`authorizePhysicalCommand` (`:132-187`) deliberately implements the opposite rule for actuation — a zoneless device is always denied there, never falling back to `claimedBy` — and its javadoc at `:136` cites "matching `authorize`'s existing scope-over-ownership precedent". That sentence stops being true. Update the javadoc; do not touch the method body, which is P4.

**Files**
- Modify: `backend/src/main/java/org/osi/server/device/DeviceMutationService.java` (`authorize` at 404-435, `assign` at 62-78, the `authorizePhysicalCommand` javadoc at 132-147)
- Modify: `backend/src/test/java/org/osi/server/zone/IrrigationZoneDeviceAssignmentScopeTest.java` (the duplicate at 192-195)
- Create: `backend/src/test/java/org/osi/server/device/DeviceMutationServiceAssignScopeTest.java`

**Interfaces**
- Produces: `private Authorization authorize(User actor, Device device, IrrigationZone targetZone)` — the existing body, with the zoneless branch reading `targetZone` before it reads `claimedBy`.
- Produces: `private Authorization authorize(User actor, Device device)` delegating with `null`, so `upsert` (`:50`), `unassign` (`:91`) and `unclaim` (`:104`) are untouched.
- Changed: `assign` (`:72`) calls the three-argument form with the destination zone. Keep the `requireWriteZone` on the line after; it is now redundant for the zoneless case and still load-bearing for the already-assigned case.
- Unchanged: `requireMutation()` ordering, the `LinkedGatewayAccount` / `device_desired_state_v1` check, every thrown status.

**Steps**

- [ ] **Write the failing test, unmocked.** Create `DeviceMutationServiceAssignScopeTest` exercising the real `DeviceMutationService` with `@Mock ZoneGatewayAccess gatewayAccess`, `@Mock LinkedGatewayAccountRepository linkedAccountRepository` and whatever else the constructor takes. Cases:

  - `grantedResearcherAssignsDeviceClaimedByAnotherUser()` — device with `irrigationZone == null`, `claimedBy` = user 9, actor = user 7; stub `gatewayAccess.resolve` with an `Access` whose `requireMutation()` passes and whose `requireWriteZone("zone-target")` passes; assert `assign(actor, device, zone)` returns a result and throws nothing. **This is the case that fails today with 404.**
  - `researcherWithoutWriteScopeOnTargetZoneIsDenied()` — same fixture, `requireWriteZone` throws; assert the denial propagates.
  - `alreadyAssignedDeviceStillChecksItsCurrentZone()` — device in `zone-current`, target `zone-target`; assert `requireWriteZone` was called with the *current* zone uuid, pinning that the existing branch is unchanged.
  - `unassignStillRequiresClaimerIdentityForAZonelessDevice()` — call `unassign` with a zoneless device claimed by someone else; assert `404`. This pins that the widening did not leak into the callers with no target zone.

  Build the `Access` stub rather than mocking `ZoneGatewayAccess.Access` if it is a record — check its shape first (`backend/src/main/java/org/osi/server/zone/ZoneGatewayAccess.java`) and construct it directly where possible, so `requireWriteZone`'s real throw shape is what the test sees.

- [ ] **Fix the two vacuous controller tests.** In `IrrigationZoneDeviceAssignmentScopeTest`, `deviceClaimedByAnotherUserIsAssignableWithinScope` (`:192-195`) is a bare call to `grantedResearcherAssignsUnassignedDevice()`, and that test stubs `deviceMutationService.assign` (`:85-86`), so the service under test never runs. Delete the duplicate and add a comment on `grantedResearcherAssignsUnassignedDevice` naming what it does and does not cover:

```java
    // Controller-level only: deviceMutationService is a mock, so this pins the
    // 202 wiring, not the authorization rule. The rule is pinned unmocked in
    // DeviceMutationServiceAssignScopeTest.
```

- [ ] **Run to see it fail:**
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests "org.osi.server.device.DeviceMutationServiceAssignScopeTest" -x buildFrontend -x buildTerraIntelligenceFrontend
```
  Expected failure: `grantedResearcherAssignsDeviceClaimedByAnotherUser` fails with `ResponseStatusException: 404 NOT_FOUND "Device not found"`.

- [ ] **Implement the widening.** Split `authorize` into the two forms above. The zoneless branch becomes:

```java
        if (device.getIrrigationZone() != null) {
            access.requireWriteZone(device.getIrrigationZone().getZoneUuid());
        } else if (targetZone != null) {
            // An unassigned device belongs to nobody in scope terms (W3): the
            // gate is write scope on the zone it is moving INTO, matching the
            // edge's P7 precondition. Claimer identity would 404 every granted
            // researcher on hardware a colleague registered.
            access.requireWriteZone(targetZone.getZoneUuid());
        } else if (device.getClaimedBy() == null
                || !actor.getId().equals(device.getClaimedBy().getId())) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.NOT_FOUND,
                    "Device not found");
        }
```

- [ ] **Correct the `authorizePhysicalCommand` javadoc** at `:136` and `:143-147`: it may no longer claim to match `authorize`'s precedent. State instead that actuation denies a zoneless device outright, that `authorize` gates a zoneless device on the destination zone's write scope, and that the two rules are deliberately different because actuation has no destination.

- [ ] **Run to see it pass:**
```bash
./gradlew test --tests "org.osi.server.device.*" --tests "org.osi.server.zone.*" -x buildFrontend -x buildTerraIntelligenceFrontend
```
  Expected: BUILD SUCCESSFUL, with `DeviceMutationServiceTest`, `ZoneMutationServiceTest` and `DeviceMutationServiceTransactionIT` green and unedited.

- [ ] **Commit:** `git add -A && git commit -m "fix(devices): gate assignment of an unassigned device on the target zone's write scope"`

---

## Task C2 — the gateway-mismatch check fails closed

`IrrigationZoneController.gatewayMismatch` (`:1777-1789`) returns `false` — no mismatch — whenever `device.getGatewayDeviceEui()` is null or blank, because the fallback at `:1786` additionally requires `device.getIrrigationZone() != null`. Every cloud-registered device has a null gateway EUI until the edge mirror lands, so in that window a cross-account `ASSIGN_DEVICE_TO_ZONE` is issuable against any zone the caller can write. Membership in the device's own gateway is never checked at all.

**Files**
- Modify: `backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java` (`gatewayMismatch` at 1777-1789, `assignDevice` at 438-442)
- Modify: `backend/src/test/java/org/osi/server/zone/IrrigationZoneDeviceAssignmentScopeTest.java`

**Interfaces**
- Changed: `private boolean gatewayMismatch(Device device, IrrigationZone zone)` returns `true` when the zone carries a gateway EUI and the device carries none. The cloud-local case (zone with no gateway EUI) still returns `false` — that branch is not about edge devices.
- Produces, in `assignDevice`, a separate membership gate after the mismatch check: `403` when `!gatewayReadAccess.isMember(user, device.getGatewayDeviceEui())`. `gatewayReadAccess` is already injected in this controller (used at `:1734`) and is the `GatewayReadAccess` interface — reference the interface, not `GatewayReadAccessService`.
- Unchanged: the `X-Sync-Error: Device belongs to a different gateway` header on the mismatch 409, `removeDevice`, and the second, unrelated `gatewayMismatch` in `WeatherStationZoneService` (C5 touches that file).

Two statuses, deliberately (P8): a mismatch is a 409 about the resource, a non-member is a 403 about the caller. Collapsing them would tell an outsider which gateway a device belongs to.

**Steps**

- [ ] **Write the failing tests.** Add to `IrrigationZoneDeviceAssignmentScopeTest`:

```java
    @Test
    void deviceWithNoGatewayEuiCannotBeAssignedToAnEdgeZone() {
        // A cloud-registered device carries no gateway EUI until the edge mirror
        // lands. Failing open in that window made a cross-account assignment
        // issuable against any zone the caller could write.
    }

    @Test
    void nonMemberOfTheDevicesGatewayIsForbidden() {
        // isMember false for the device's gateway -> 403, not 409: the caller,
        // not the resource, is the problem, and a 409 would confirm the device
        // exists on a gateway the caller cannot see.
    }

    @Test
    void memberAssigningAMatchingGatewayDeviceStillSucceeds() {
    }
```

  Fill each body following the file's existing fixtures (`user(...)`, `zone(...)`, `device(...)`, `setupWritableZone(...)`, `principal(...)` at the top of the file) and stub `gatewayReadAccess.isMember` per case. Assert on `response.getStatusCode().value()`.

- [ ] **Run to see it fail:**
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests "org.osi.server.zone.IrrigationZoneDeviceAssignmentScopeTest" -x buildFrontend -x buildTerraIntelligenceFrontend
```
  Expected failure: `deviceWithNoGatewayEuiCannotBeAssignedToAnEdgeZone` gets `202` where `409` is asserted; `nonMemberOfTheDevicesGatewayIsForbidden` gets `202` where `403` is asserted.

- [ ] **Fail closed in `gatewayMismatch`:**

```java
    private boolean gatewayMismatch(Device device, IrrigationZone zone) {
        String zoneGateway = zone.getGatewayDeviceEui();
        if (zoneGateway == null || zoneGateway.isBlank()) {
            // Cloud-local zone: there is no edge gateway to disagree with.
            return false;
        }
        String deviceGateway = device.getGatewayDeviceEui();
        if (deviceGateway == null || deviceGateway.isBlank()) {
            // Fail closed. Every cloud-registered device has a null gateway EUI
            // until its edge mirror lands, and treating that as "no mismatch"
            // made a cross-account assignment issuable in exactly that window.
            return true;
        }
        if (!zoneGateway.equalsIgnoreCase(deviceGateway)) {
            return true;
        }
        return device.getIrrigationZone() != null
                && device.getIrrigationZone().getGatewayDeviceEui() != null
                && !zoneGateway.equalsIgnoreCase(device.getIrrigationZone().getGatewayDeviceEui());
    }
```

- [ ] **Add the membership gate** in `assignDevice`, immediately after the mismatch 409 at `:438-442`:

```java
            if (!gatewayReadAccess.isMember(user, device.getGatewayDeviceEui())) {
                // The zone's write scope says the caller may write HERE; this
                // says the caller is entitled to the device at all. A 403 rather
                // than a 409 so a non-member learns nothing about the device.
                return ResponseEntity.status(403).build();
            }
```

- [ ] **Run to see it pass:** `./gradlew test --tests "org.osi.server.zone.*" -x buildFrontend -x buildTerraIntelligenceFrontend` → BUILD SUCCESSFUL.

- [ ] **Commit:** `git add -A && git commit -m "fix(zones): fail closed on a null device gateway EUI and require gateway membership to assign"`

---

## Task C3 — the New device tab is translated

Twenty-one `addModal.*` keys are referenced across `AddDeviceModal.tsx` and `AssignDeviceModal.tsx`. Three exist in the locale files (`targetGateway`, `switchOnSettings`, `notAvailableForRole`) — the three that carry no inline English default and would otherwise render as raw key strings. The other **18** exist in no locale, `en` included, and render through `t(key, 'English default')` on every gateway in every language.

The ledger says eleven; on `69fc0667` the verified count is 18 missing of 21 referenced. Fix the set that exists, not the number: the test below derives the required keys from the source rather than hard-coding a count, so the two can never disagree again.

**Files**
- Modify: `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/devices.json` (the `addModal` object)
- Modify: `frontend/tests/addDeviceModalLocales.test.ts`

**Interfaces**
- Produces: an `addModal` object in all seven `devices.json` carrying every key referenced from `frontend/src`, each a non-empty string.
- Changed: `addDeviceModalLocales.test.ts` stops hard-coding `['targetGateway', 'switchOnSettings', 'notAvailableForRole']` and instead scans `frontend/src` for `t('addModal.<key>'` / `t("addModal.<key>"` occurrences, then asserts every discovered key resolves in every locale.

**Steps**

- [ ] **Rewrite the locale fence to be referenced-key driven.** Replace the hard-coded array in `frontend/tests/addDeviceModalLocales.test.ts` with a scan. Keep it `node:test` + `node:assert/strict` — this file runs under the `tsx --test` half of `npm run test:unit`, not vitest:

```ts
const SRC = path.join(frontendRoot, 'src');

function referencedAddModalKeys(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/['"`]addModal\.([A-Za-z0-9_]+)['"`]/g)) {
        found.add(match[1]);
      }
    }
  };
  walk(SRC);
  return [...found].sort();
}

test('every locale carries every addModal key the UI references', () => {
  const required = referencedAddModalKeys();
  assert.ok(required.length > 0, 'the scan found no addModal keys -- the regex has drifted');
  for (const locale of LOCALES) {
    const devices = JSON.parse(
      fs.readFileSync(path.join(frontendRoot, `public/locales/${locale}/devices.json`), 'utf8'),
    );
    for (const key of required) {
      assert.equal(typeof devices.addModal?.[key], 'string', `${locale} devices.addModal.${key}`);
      assert.notEqual(devices.addModal[key].trim(), '', `${locale} devices.addModal.${key}`);
    }
  }
});
```

- [ ] **Run to see it fail:** `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit`
  Expected failure: the fence lists 18 missing keys per locale, starting `en devices.addModal.appkey`.

- [ ] **Add the keys to all seven locales.** Take the English wording from each call site's existing inline default so the rendered UI does not change in English, then translate. `lg` (Luganda) is the Uganda ship gate: if you cannot produce a real translation, add the key with the English string **and** say so in the commit body as a draft awaiting the native pass. Do not leave English in `de-CH`, `es`, `fr`, `it` or `pt`.

- [ ] **Remove the now-redundant inline defaults**, or keep them — decide once and apply consistently. Keeping them is the safer choice: they are the fallback if a locale file fails to load over HTTP, and the fence now guarantees they are never the rendered value. Say which you chose in the commit body.

- [ ] **Run to see it pass:** `npm run test:unit` → both halves green.

- [ ] **Commit:** `git add -A && git commit -m "fix(i18n): translate every addModal key in all seven locales"`

---

## Task C4 — the zone card's add-device flow is gated on device write, not zone capability

`IrrigationZoneCard.tsx:151` computes `const editable = canWrite && mutationsSupported;` and uses it for everything: the config gear, the add-device button (`:241`, `:519`) and the `AssignDeviceModal` mount (`:534`, `:541`). `mutationsSupported` is `zoneMutationsSupported` — the *zone desired-state* capability, which `gatewayCapabilities.ts:34-48` documents as explicitly not applying to device commands, because `REGISTER_DEVICE` and friends predate the desired-state overlay and ride pending-commands on every linked gateway. On a gateway without that capability the whole fixed-zone add-device flow is unreachable, including the register tab this branch just built.

The card already carries the right prop. `deviceWritable` is declared at `:26-32` with a comment saying it exists so the two authorities never collapse, and it is used in exactly one place (`:500`, the device grid's `readOnly`).

The only test pinning the gate queries `zone.assignDevice`, a key the component stopped using when the button was renamed to `zone.addDevice`. `queryByRole` returns null unconditionally, so `IrrigationZoneCard.capabilities.test.tsx:207` — the sole assertion that add-device hides when `mutationsSupported: false` — passes vacuously, as does `:199`.

**Files**
- Modify: `frontend/src/components/farming/IrrigationZoneCard.tsx` (151, 236-257, 519-526, 533-542)
- Modify: `frontend/src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx` (194, 197-210)

**Interfaces**
- Produces: `const zoneEditable = canWrite && mutationsSupported;` gating the config gear, the zone-config modal and the not-available badge — unchanged behavior under a new name.
- Produces: `const deviceEditable = deviceWritable;` gating both add-device buttons and the `AssignDeviceModal` `isOpen` / `writable` props.
- Unchanged: `IrrigationZoneCardProps`, the device grid's `readOnly` at `:500`, `zone.notAvailableOnGateway` (still keyed on the zone capability, which is what it describes).

**Steps**

- [ ] **Repair the dead queries and add the real gate tests.** In `IrrigationZoneCard.capabilities.test.tsx`, change the `zone.assignDevice` queries at `:199` and `:207` to `zone.addDevice` — the key the component actually renders — and add:

```tsx
  it('offers add-device on a gateway without the zone desired-state capability', () => {
    renderCard({ mutationsSupported: false, deviceWritable: true });
    expect(screen.getByRole('button', { name: 'zone.addDevice' })).toBeInTheDocument();
  });

  it('hides add-device when device writes are not permitted', () => {
    renderCard({ mutationsSupported: true, deviceWritable: false });
    expect(screen.queryByRole('button', { name: 'zone.addDevice' })).not.toBeInTheDocument();
  });

  it('still hides the config gear on a gateway without the zone capability', () => {
    renderCard({ mutationsSupported: false, deviceWritable: true });
    expect(screen.queryByTitle('Configure')).not.toBeInTheDocument();
    expect(screen.getByText('zone.notAvailableOnGateway')).toBeInTheDocument();
  });
```

  **Executor note:** repairing `:207` will make the `mutationsSupported: false` case assert the opposite of the new first test. Delete that line from `shows the explicit not-available state on old gateways (D4)` — the not-available badge and the schedule section are what that test is for; add-device is now covered above.

- [ ] **Run to see it fail:** `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit`
  Expected failure: `offers add-device on a gateway without the zone desired-state capability` fails with `Unable to find an accessible element with the role "button" and name "zone.addDevice"`.

- [ ] **Split the gate** in `IrrigationZoneCard.tsx`. Replace `:151` with two consts and re-point each use site:

```tsx
  // Two authorities, deliberately separate (gatewayCapabilities.ts D4/D5):
  // zoneEditable rides the zone desired-state overlay; device registration and
  // assignment predate it and ride pending-commands on every linked gateway.
  // Collapsing them made the whole fixed-zone add-device flow unreachable on
  // gateways without the zone capability.
  const zoneEditable = canWrite && mutationsSupported;
  const deviceEditable = deviceWritable;
```

  Then: `:236` and the gear at `:241-249` and the config-modal mount at `:545` keep `zoneEditable`; the add-device button at `:250-255`, the empty-state button at `:519-526`, and the `AssignDeviceModal` `isOpen` / `writable` at `:534` / `:541` take `deviceEditable`. Note `:241` currently wraps the gear and the add-device button in one `{editable && (<>…</>)}` fragment — split it into two conditionals rather than nesting.

- [ ] **Run to see it pass:** `npm run test:unit` → both suites green.

- [ ] **Commit:** `git add -A && git commit -m "fix(farming): gate the zone card's add-device flow on device write authority"`

---
# Phase 2 — branch blockers

Eight tasks. These are defects the branch carries independently of the scoping work, and each one is a deploy stopper: X1 ships images that cannot boot, X2 and X5 are cross-account writes, X3 corrupts journal data on a path that then always fails, X4 registers a device with no key, X6 and X7 break the moment the deployment order this plan mandates is followed, and D1 keeps telemetry and journal events terminally rejected.

X1 gates firmware images. X6 and X7 are the deployment-ordering fixes and must both land before any edge rollout.

## Task X1 — regenerate factory-image provenance and gate it in CI

`node scripts/verify-factory-image-provenance.js` fails today with `[verify-factory-image-provenance] bcm2712 image-guard manifest hash mismatch`. The seed database grew on this branch and the provenance bundle was never regenerated, so a fresh image boots with no `/data/db/farming.db`. No workflow runs any of the four provenance scripts, which is why the mismatch survived the whole branch.

**Files**
- Modify: `scripts/factory-image-provenance.json` (or whatever path the generator writes — read the generator's output target before running it)
- Create: `.github/workflows/factory-image-provenance.yml`

**Interfaces**
- The generator's flag pairing is enforced: `--preserve-image-build-id` requires `--refresh-bound-hashes` (`generate-factory-image-provenance.js:146`) and vice versa (`:147`), and `--refresh-bound-hashes` refuses `--image-build-id` (`:148`) and `--profile` (`:149`). The three-flag invocation below is the only shape that regenerates hashes without minting a new image build id.

**Steps**

- [ ] **Record the failure first.** Run and keep the output in the commit body:

```bash
node scripts/verify-factory-image-provenance.js; echo "exit=$?"
node scripts/verify-built-factory-image-provenance.js; echo "exit=$?"
```
  Expected: the first prints `bcm2712 image-guard manifest hash mismatch` and exits non-zero.

- [ ] **Regenerate**, with exactly this command and no others:

```bash
node scripts/generate-factory-image-provenance.js --refresh-bound-hashes --preserve-image-build-id --write
```

  `--preserve-image-build-id` is what keeps this a hash refresh rather than a new image identity. If the command errors on flag validation, do not "fix" it by dropping a flag — read `:130-150` and report, because the pairing rules above are deliberate.

- [ ] **Verify:** `node scripts/verify-factory-image-provenance.js && node scripts/verify-built-factory-image-provenance.js && node --test scripts/generate-factory-image-provenance.test.js scripts/verify-factory-image-provenance.test.js scripts/verify-built-factory-image-provenance.test.js scripts/factory-image-provenance-cli.test.js`
  Expected: all exit 0.

- [ ] **Add the CI gate.** Create `.github/workflows/factory-image-provenance.yml` modelled on the existing `verify-sync-flow.yml` (same runner, same Node setup, same checkout action versions — copy them rather than inventing). Its `on:` block must fire on this branch, not only on `main`:

```yaml
on:
  push:
    branches: [main, master, AgroLink, 'feat/**', 'fix/**', 'docs/**']
  pull_request:
  workflow_dispatch:
```

  One job, `provenance`, running the two verifiers and the four `*.test.js` files above. The verifiers are the gate; the tests are the regression net for the generator itself.

- [ ] **Confirm the workflow parses:** `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/factory-image-provenance.yml'))"` → no output, exit 0.

- [ ] **Commit:**
```bash
git add scripts/factory-image-provenance.json .github/workflows/factory-image-provenance.yml
git commit -m "fix(image): refresh factory-image provenance hashes and gate them in CI"
```

**Blocking note:** no firmware image may be built until this task is committed. That is the rollout law, and this task is the thing it waits on.

---

## Task X2 — journal update authorizes the entry's own plot

`resolveJournalWrite` in `osi-journal/api.js` runs an if/else chain at `:1258-1270`. The `else if (plotUuid)` arm sits **before** `else if (mode === 'update')`, so any update carrying a `plot_uuid` in its body authorizes that plot and never looks at the entry's real one. A grantee whose access to the entry's plot was revoked can still overwrite the entry, and can re-parent it into a plot they do hold, by supplying the destination in the body.

**Files**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js`
- Mirror: the bcm2709 copy of the same file (byte-identical; copy, never hand-edit)
- Modify: the journal scoped-write test file — find it with `grep -rln "assertEntryWrite\|resolveJournalWrite" scripts/ conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/`

**Interfaces**
- Changed: on `mode === 'update'`, `assertEntryWrite(db, principal, body.entry_uuid)` always runs. When the body also names a plot, `assertPlotWrite` runs **in addition**, so a re-parent needs write scope on both the source and the destination.
- Unchanged: `assertPlotSetWrite` for batches (it already owns the multi-plot case), the create path, and `assertPlotZoneMatch`.

**Steps**

- [ ] **Write the failing tests.** Two cases against the scoped journal harness:
  - `a grantee without scope on the entry's plot cannot update it` — entry lives in plot A, caller holds only plot B, body carries `plot_uuid: B`. Expect the 404 `not_found` that `assertPlotWrite` throws for plot A. **Fails today with a successful update.**
  - `re-parenting an entry requires write scope on both plots` — caller holds A and B; assert success. Caller holds only A, entry in A, body names B; assert denial.

- [ ] **Run to see it fail** with the journal suite's own command (read the test file's header for it; the journal package uses `node --test`).

- [ ] **Reorder the chain.** Replace `:1258-1270`:

```js
  if (batchMembers) {
    principal = await assertPlotSetWrite(
      db,
      principal,
      batchMembers.map(function(member) { return member.plot_uuid; })
    );
  } else if (plotUuid) {
    principal = await assertPlotWrite(db, principal, plotUuid);
  } else if (mode === 'update') {
    principal = await assertEntryWrite(db, principal, body.entry_uuid);
  } else if (zoneUuid) {
    await assertZoneWrite(db, principal, zoneUuid);
  }
```

  with:

```js
  if (batchMembers) {
    principal = await assertPlotSetWrite(
      db,
      principal,
      batchMembers.map(function(member) { return member.plot_uuid; })
    );
  } else if (mode === 'update') {
    // The entry's OWN plot is the authority on an update. Checking only the
    // body-supplied plot let a revoked grantee overwrite an entry, and
    // re-parent it, by naming a plot they still hold.
    principal = await assertEntryWrite(db, principal, body.entry_uuid);
    if (plotUuid) {
      // A re-parent needs write scope on the destination too, and the
      // destination owner is the principal the write is attributed to.
      principal = await assertPlotWrite(db, principal, plotUuid);
    }
  } else if (plotUuid) {
    principal = await assertPlotWrite(db, principal, plotUuid);
  } else if (zoneUuid) {
    principal = await assertZoneWrite(db, principal, zoneUuid);
  }
```

  The `principal =` on the `zoneUuid` arm is X3's fix; land it here or there, not twice. If X3 goes first, leave that line alone.

- [ ] **Mirror and verify:** copy the edited file over the bcm2709 copy, then `node --test` the journal suite plus `node scripts/verify-sync-flow.js` (it chains profile parity and must end `All parity checks passed.`).

- [ ] **Commit:**
```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js <test file>
git commit -m "fix(journal): authorize an update against the entry's own plot"
```

---

## Task X3 — `assertZoneWrite` rewrites the principal

`assertZoneWrite` (`api.js:654-664`) checks zone access and returns `principal` unchanged. Its sibling `assertPlotWrite` (`:666-687`) resolves the plot's owner and returns a principal carrying `user_id` and `owner_user_uuid` rewritten to that owner. The zone path skips that, so on a scoped gateway the zone-entry flow runs as the *caller* rather than the farm owner: `ensureZonePlot` probes for the zone's plot under the caller's ownership, misses the existing one, creates a duplicate, ships an outbox event for it, and then `assertPlotZoneMatch` fails — every time. The result is an orphan plot plus a shipped event, and a 4xx to the user.

Line `:1269` compounds it by discarding the return value: `await assertZoneWrite(db, principal, zoneUuid);` with no assignment.

**Files**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js` (654-664, and 1269 if X2 has not already fixed it)
- Mirror: the bcm2709 copy
- Modify: the journal scoped-write test file

**Interfaces**
- Changed: `assertZoneWrite` returns `Object.assign({}, principal, { user_id, owner_user_uuid })` resolved from the zone's owner, mirroring `assertPlotWrite` exactly. Unresolvable zone → `apiError(404, 'not_found', 'Zone was not found')`.
- Unchanged: `scopedWriteHelper(principal, 'assertFreshZoneAccess')` and the early return for a non-scoped principal. Flag-off is untouched, because `scopedWriteHelper` returns falsy there.

**Steps**

- [ ] **Write the failing test.** `a scoped zone entry reuses the zone's existing plot`: seed a zone owned by user A with its journal plot already present, have granted user B post a zone-keyed entry, then assert (a) the entry succeeds, (b) `SELECT COUNT(*) FROM journal_plots WHERE ...` for that zone is still 1, and (c) no new `JOURNAL_PLOT` row appeared in `sync_outbox`. All three fail today — (a) with the `assertPlotZoneMatch` error, (b) with 2, (c) with an extra row.

- [ ] **Run to see it fail** with the journal suite command.

- [ ] **Rewrite `assertZoneWrite`:**

```js
async function assertZoneWrite(db, principal, zoneUuid) {
  const scopeHelper = scopedWriteHelper(principal, 'assertFreshZoneAccess');
  if (!scopeHelper) return principal;
  await scopeHelper.assertFreshZoneAccess(
    db,
    principal.author_principal_uuid,
    zoneUuid,
    { scopedMode: true }
  );
  // Same principal rewrite assertPlotWrite does. Without it the zone-entry path
  // runs as the CALLER, so ensureZonePlot cannot see the farm owner's existing
  // plot for this zone: it creates a duplicate, ships an outbox event for it,
  // and then assertPlotZoneMatch rejects the write. Orphan plot, shipped event,
  // guaranteed failure.
  const owner = await dbGet(
    db,
    'SELECT z.user_id AS owner_user_id,u.user_uuid AS owner_user_uuid ' +
      'FROM irrigation_zones AS z JOIN users AS u ON u.id=z.user_id ' +
      'WHERE z.zone_uuid=? AND z.deleted_at IS NULL LIMIT 1',
    [zoneUuid]
  );
  if (!owner) throw apiError(404, 'not_found', 'Zone was not found');
  return Object.assign({}, principal, {
    user_id: Number(owner.owner_user_id),
    owner_user_uuid: owner.owner_user_uuid,
  });
}
```

  **Executor note:** confirm the column names against the live schema before writing the query — `sqlite3 database/seed-blank.sql` is not runnable, so read the `CREATE TABLE irrigation_zones` block in `database/seed-blank.sql` and check that the owner column is `user_id`. If it is not, adjust the join and say so in the commit body.

- [ ] **Assign the return at the call site** (`:1269`), if X2 did not already: `principal = await assertZoneWrite(db, principal, zoneUuid);`. Also check `:760` and `:1001`, the two other `assertZoneWrite` callers, and assign there too where the following code uses `principal`.

- [ ] **Mirror, run the journal suite and `node scripts/verify-sync-flow.js`.**

- [ ] **Commit:**
```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/api.js <test file>
git commit -m "fix(journal): rewrite the principal to the zone owner on a zone-keyed write"
```

---

## Task X4 — an all-zero AppKey is rejected at validation

`ensureDeviceProvisioned` validates the requested key with `/^[0-9A-F]{32}$/` (`osi-chirpstack-helper/index.js:656`), which 32 zeros satisfy. `canonicalStoredKey` (`:332-335`) maps an empty read-back to `UNSET_KEY_ZEROS`, so `storedKeyEqual(a, b)` (`:337-339`) reports a match between "the caller asked for zeros" and "ChirpStack has no key set". Registration reports success with no key written, and the device never joins.

**Files**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.js`
- Mirror: the bcm2709 copy
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js` (+ mirror)

**Interfaces**
- Changed: `ensureDeviceProvisioned` throws `boundedError('validate', 'INVALID_ARGUMENT')` when the normalized key equals `UNSET_KEY_ZEROS`. This is the same error shape the three existing validation failures use, so every caller's error handling is unchanged.
- Unchanged: `canonicalStoredKey` and `storedKeyEqual`. Their canonicalization is correct for *read-back* comparison — that is the ChirpStack 4.12 zero-readback behavior the helper exists to handle. The defect is accepting zeros as a *requested* key, and the fix belongs at the input boundary, not in the comparator. Do not "fix" `storedKeyEqual`; it would break the read-back verify that this helper was rewritten for.

**Steps**

- [ ] **Write the failing test.** In `index.test.js`, next to the existing validation cases:

```js
test('an all-zero requested AppKey is rejected at validation', async () => {
  const client = makeClient();
  await assert.rejects(
    () => client.ensureDeviceProvisioned({
      devEui: 'AABBCCDDEEFF0011',
      appKey: '00000000000000000000000000000000',
      applicationId: 'app-1',
      deviceProfileId: 'profile-1',
    }),
    (error) => error.step === 'validate' && error.code === 'INVALID_ARGUMENT'
  );
});
```

  **Executor note:** match the file's own client-construction helper and its assertion style rather than the sketch above; read the three neighbouring `INVALID_ARGUMENT` tests first.

- [ ] **Run to see it fail:** `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js`
  Expected failure: the call resolves instead of rejecting.

- [ ] **Add the guard** immediately after the existing hex check at `:656`:

```js
    if (nwkKey === UNSET_KEY_ZEROS) {
      // ChirpStack 4.12+ reports an unset key as 32 zeros, and canonicalStoredKey
      // maps an empty read-back to the same value. Accepting zeros as a REQUESTED
      // key therefore "verifies" against a device that has no key at all: the ACK
      // says SUCCESS and the device can never join. Reject at the boundary; do not
      // relax the comparator, which needs that canonicalization to work.
      throw boundedError('validate', 'INVALID_ARGUMENT');
    }
```

- [ ] **Run to see it pass:** `node --test conf/.../osi-chirpstack-helper/index.test.js` → exit 0, with the existing read-back tests still green (they are what pins that the comparator was not touched).

- [ ] **Mirror**, then `node scripts/verify-sync-flow.js` → `All parity checks passed.`

- [ ] **Commit:**
```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/ conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-chirpstack-helper/
git commit -m "fix(chirpstack): reject an all-zero requested AppKey at validation"
```

---

## Task X5 — REGISTER_DEVICE refuses an EUI another account already claimed

`cs-reg-cloud-fn` provisions in ChirpStack first and writes locally with `INSERT OR IGNORE`. For an EUI a different account already claimed, the ChirpStack write goes through — rewriting the live device including its root key — while the local insert silently no-ops. The ACK says SUCCESS. The original owner's device stops joining, and the new account believes it owns hardware it does not.

**Files**
- Modify: `scripts/test-scoped-access-writes.js`
- Modify: both `flows.json` profiles (node `cs-reg-cloud-fn`)
- Modify: `scripts/verify-sync-flow.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces**
- Produces: a claim fence that runs **before** any ChirpStack call. An existing, non-deleted `devices` row whose `user_id` is neither NULL nor the resolved local user for `params.cloudUserId` yields `buildAck('FAILED', { error: …, state: 'FAILED', step: 'claim', code: 'ALREADY_CLAIMED' })` and returns without provisioning.
- Produces: an existing row claimed by the *same* user is idempotent — `buildAck('SUCCESS', { state: 'ALREADY_REGISTERED', deviceEui: devEui, provisionedInChirpStack: false })`, plus the scoped zone extras when E5's `scopedOn` is true.
- Unchanged: the fresh-EUI path, the `INSERT OR IGNORE` (now reached only when the fence passed), and E5's zone gating.

**Ordering:** this task edits the same node as E5. Land E5 first; the `scopedOn` const it introduces is what the idempotent branch reads. If X5 runs first, add the const here and drop it from E5's mutate block.

**Steps**

- [ ] **Write the failing tests.** Append to `scripts/test-scoped-access-writes.js`, using the existing `applyRegister` helper:

```js
test('X5: REGISTER_DEVICE refuses an EUI another account already claimed', async () => {
  const db = seedScopedDb();
  try {
    // DENDRO1 is claimed by user 1 in the fixture; the command names a different
    // cloud user. Nothing may reach ChirpStack.
    const response = await applyRegister(db, 'DENDRO1', { cloudUserId: 4242 });
    const ack = response.result[0].specialAck;

    assert.equal(ack.result, 'FAILED');
    assert.equal(ack.code, 'ALREADY_CLAIMED');
    assert.equal(ack.step, 'claim');
    assert.equal(
      db.prepare("SELECT user_id FROM devices WHERE deveui='DENDRO1'").get().user_id,
      1,
      'the original claim must survive'
    );
  } finally {
    db.close();
  }
});

test('X5: re-registering an EUI the same account already owns is idempotent', async () => {
  const db = seedScopedDb();
  try {
    const response = await applyRegister(db, 'DENDRO1');
    const ack = response.result[0].specialAck;
    assert.equal(ack.result, 'SUCCESS');
    assert.equal(ack.state, 'ALREADY_REGISTERED');
    assert.equal(ack.provisionedInChirpStack, false);
  } finally {
    db.close();
  }
});
```

  **Executor note:** the fake ChirpStack lib in the harness resolves everything, so "nothing reached ChirpStack" is not observable through it. Add a counter to `fakeChirpstackLib` (`let provisionCalls = 0;` incremented in `ensureDeviceProvisioned`, exposed on the returned object) and assert it stayed at 0 in the first test. Without that the test cannot tell "refused" from "provisioned then refused", which is the whole finding.

- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-writes.js`
  Expected failure: `X5: REGISTER_DEVICE refuses an EUI another account already claimed` fails with `ack.result === 'SUCCESS'` and a non-zero provision count.

- [ ] **Load the osi-flows-json-editing skill** and add the fence in `<scratchpad>/flows-edit-x5.js`, immediately before the ChirpStack client is created. Resolve the caller's local user from `cloudUserId` with the same lookup the node already uses for `userExpr`, then:

```js
  var existing = await get(
    'SELECT user_id FROM devices WHERE deveui = ? AND deleted_at IS NULL LIMIT 1',
    [devEui]
  );
  if (existing) {
    var claimant = existing.user_id === null ? null : Number(existing.user_id);
    if (claimant !== null && claimant !== resolvedLocalUserId) {
      // Fence BEFORE ChirpStack. Provisioning first rewrote the live device --
      // root key included -- while INSERT OR IGNORE no-opped locally, so the ACK
      // said SUCCESS, the original owner's device stopped joining, and the new
      // account believed it owned the hardware.
      return [buildAck('FAILED', {
        error: 'DevEUI ' + devEui + ' is already claimed on this gateway',
        state: 'FAILED',
        step: 'claim',
        code: 'ALREADY_CLAIMED'
      }), null];
    }
    var idempotentExtras = { state: 'ALREADY_REGISTERED', deviceEui: devEui, provisionedInChirpStack: false };
    if (scopedOn) {
      idempotentExtras.zoneAssignedId = null;
      idempotentExtras.zoneWarning = null;
    }
    return [buildAck('SUCCESS', idempotentExtras), null];
  }
```

  **Executor note:** read the node's existing `cloudUserId` → local user resolution before writing `resolvedLocalUserId`; reuse it rather than adding a second lookup, and make sure the `_db` handle is closed on both early returns the same way the other early returns in this node close it.

- [ ] **Run to see it pass:** `node --test scripts/test-scoped-access-writes.js` → exit 0, with E5's flag-off cases and the five `P9:` cases still green.

- [ ] **Pin the fence** in `scripts/verify-sync-flow.js` with `expectIncludesById('cs-reg-cloud-fn', "code: 'ALREADY_CLAIMED'", 'refuses an EUI another account already claimed before touching ChirpStack')`.

- [ ] **Raise the size ceiling for `cs-reg-cloud-fn`** and `total_allowance.max_total`; run the flows gate; commit:

```bash
git add scripts/test-scoped-access-writes.js scripts/verify-sync-flow.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/verify-flows-size-ratchet-allowances.json
git commit -m "fix(chirpstack): fence REGISTER_DEVICE on an already-claimed EUI before provisioning"
```

---
## Task X6 — a missing `expires_at` means a legacy issuer, not a malformed command

`physicalActionExpiry` (`osi-command-ledger/index.js:103-145`) collects the four places an expiry can arrive (`envelope.expiresAt`, `envelope.expires_at`, `payload.expiresAt`, `payload.expires_at`), drops blanks, and then treats **`parsed.length === 0`** exactly like a garbage timestamp: `{ terminal: true, result: 'REJECTED_PERMANENT', reason: 'invalid_expires_at' }`. The caller (`:477-483`) short-circuits on `expiry.terminal` before dispatch, so a command with no expiry is NACKed permanently and never reaches the valve.

The deployed cloud does not send `expires_at`. Under the rollout law the cloud deploys first, but a gateway that takes the new flows while its paired cloud is mid-rollout, or any cloud that predates the field, terminally NACKs **every** STREGA and valve physical action. An absent fence is a legacy issuer, which is the one case that must degrade to "no fence" rather than "reject".

**Files**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.js`
- Mirror: the bcm2709 copy
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js` (+ mirror)

**Interfaces**
- Changed: no expiry supplied → `physicalActionExpiry` returns `null`, the same value it returns for a non-physical command type (`:104`), so the caller's `if (expiry && expiry.terminal)` falls through and the command dispatches unfenced.
- Unchanged: a malformed timestamp stays `REJECTED_PERMANENT / invalid_expires_at`; two supplied values that disagree stay `REJECTED_PERMANENT`; an elapsed expiry stays `terminal: true, result: 'EXPIRED'`. Only the empty case moves.

**Steps**

- [ ] **Write the failing test.** In `index.test.js`, beside `'deduplicatePendingCommand rejects malformed physical-action expiry without dispatch'` (`:553`):

```js
test('deduplicatePendingCommand dispatches a physical action with no expiry (legacy issuer)', async () => {
  // A cloud that predates the expiry fence sends no expires_at anywhere. That is
  // a legacy issuer, not a malformed command: fencing it terminally NACKed every
  // STREGA action the moment a new edge met an un-upgraded cloud.
});
```

  Build the body from the `:695-701` case, which is the closest positive control — take its envelope and delete every expiry field rather than setting one. Assert the result is `{ handled: false }` (falls through to normal dispatch), and assert `result.ack` is undefined, so the test distinguishes "dispatched" from "acked with something friendlier".

- [ ] **Run to see it fail:** `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/index.test.js`
  Expected failure: the call returns `{ handled: true, ack: { result: 'REJECTED_PERMANENT', reason: 'invalid_expires_at' } }`.

- [ ] **Split the empty case out** of the terminal branch at `:121-129`:

```js
  if (parsed.length === 0) {
    // No expiry anywhere means a legacy issuer, not a malformed command. The
    // deployed cloud does not send expires_at, and fencing its commands NACKed
    // every STREGA/valve physical action permanently. No fence, no rejection.
    return null;
  }
  if (parsed.some(function(value) { return !Number.isFinite(value.millis); }) ||
      parsed.some(function(value) { return value.millis !== parsed[0].millis; })) {
    return {
      terminal: true,
      result: 'REJECTED_PERMANENT',
      reason: 'invalid_expires_at',
      expiresAt: null,
    };
  }
```

- [ ] **Run to see it pass:** `node --test .../osi-command-ledger/index.test.js` → exit 0, with the malformed, disagreeing and elapsed cases (`:553`, `:532`, `:617`, `:633`) still green. Those three are what pin that only the empty case moved.

- [ ] **Mirror**, then `node scripts/verify-sync-flow.js` → `All parity checks passed.`

- [ ] **Commit:**
```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-command-ledger/ conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-command-ledger/
git commit -m "fix(ledger): treat a missing expires_at as a legacy issuer, not a malformed command"
```

---

## Task X7 — the seven new event ops are staged until the cloud deploys

`docs/contracts/sync-schema/sync-contract-golden.json` declares `eventOperations.staged: []` (`:156`) and `commandTypes.staged: []` (`:261`), and `scripts/verify-sync-op-parity.js` backs both with `EXACT_CLOUD_DEFERRED_OPS = []` (`:27`). That is a claim about the **deployed** cloud, and it is false: seven ops the edge emits today have no handler on `main`, which is what `osicloud.ch` and `agro-link.ch` run right now. A deployed cloud answers `unknown_op`, the edge stamps `rejected_at`, and the drain query never looks at that row again — permanent mirror divergence, with no replay path (see D3).

The seven, confirmed by running the parity verifier against both cloud branches:

```
USER_UPSERTED
USER_ZONE_ASSIGNMENT_UPSERTED
USER_ZONE_ASSIGNMENT_DELETED
USER_PLOT_ASSIGNMENT_UPSERTED
USER_PLOT_ASSIGNMENT_DELETED
ZONE_IRRIGATION_CALIBRATION_UPSERTED
WEATHER_STATION_ZONES_REPLACED
```

**Chosen option: the capability matrix.** Declare the seven staged so the contract is true for the rollout window, then un-stage them in the deploy runbook once the cloud is live. Two commits, with the cloud deploy between them. The alternative the ledger offers — leave `staged: []`, rely on the rollout law's cloud-first ordering, and document an outbox replay for anything already rejected — is not planned here for two reasons: the contract would keep asserting something false for the whole window, and the replay half has no artifact behind it (D3 establishes that no re-enqueue tooling exists in either repo, and that a naive edge-side un-reject returns `DUPLICATE` because the cloud dedups on `event_uuid`). Staging costs one extra commit and needs no new tooling.

**Three files hold this state, not one.** The golden carries `eventOperations.staged` (`:156`) and `commandTypes.staged` (`:261`). The staging manifest is a separate fixture, `scripts/fixtures/sync-contract-staging.json`, pinned at `verify-sync-op-parity.js:10`, whose `eventOps.cloudDeferred` is the array the partition logic reads. And `EXACT_CLOUD_DEFERRED_OPS` in the verifier is the actual policy — the comment at `:1337-1338` says the fixture is evidence, the constant is the rule. All three must move together or the verifier's own key-shape check fails.

**Files**
- Modify: `docs/contracts/sync-schema/sync-contract-golden.json` (`eventOperations.staged` at 156)
- Modify: `scripts/fixtures/sync-contract-staging.json` (`eventOps.cloudDeferred`)
- Modify: `scripts/verify-sync-op-parity.js` (`EXACT_CLOUD_DEFERRED_OPS` at 27)
- Modify: `scripts/verify-sync-op-parity.test.js`
- Modify: the deploy runbook under `docs/operations/` (locate the AgroLink lockstep deploy doc; if none exists, add the un-stage step to this plan's Phase 4 task D2 instead and say so)

**Interfaces**
- The manifest's root keys must stay exactly `commands, eventOps, version` (`verify-sync-op-parity.js:743`), `commands` exactly `cloudDeferred, edgeDeferred` (`:752`), and `eventOps` exactly `cloudDeferred, edgeDeferred, edgeModuleOwned` (`:760`). `edgeModuleOwned ∪ edgeDeferred` must equal the reviewed edge event-op set (`:787-794`). Only `eventOps.cloudDeferred` changes here; leave `edgeModuleOwned`'s five journal ops and both `edgeDeferred` arrays alone.
- `cloudDeferred` excludes an op from the **required server-handler set** (`:1466`). It does not stop the edge emitting it. The runtime protection is the rollout law's cloud-first ordering; this task makes the contract agree with it.

**Steps**

- [ ] **Write the failing test.** In `scripts/verify-sync-op-parity.test.js`, add a case asserting `EXACT_CLOUD_DEFERRED_OPS` contains the seven ops above and that the golden's `eventOperations.staged` and `staging.eventOps.cloudDeferred` both equal that list. It fails today against three empty arrays.

- [ ] **Run to see it fail:** `node --test scripts/verify-sync-op-parity.test.js`

- [ ] **Stage the seven** in all three places: `EXACT_CLOUD_DEFERRED_OPS`, `eventOperations.staged`, `staging.eventOps.cloudDeferred`. Add a comment above `EXACT_CLOUD_DEFERRED_OPS` naming the deploy-day step that empties it again, so the next reader does not treat staging as permanent.

- [ ] **Verify against both cloud branches.** The pairing must be pinned explicitly — the default fallback warns `This is not a trustworthy branch pairing`:

```bash
# against the DEPLOYED cloud: the seven must show as deferred, not as a diff
OSI_SERVER_EDGE_SYNC_SERVICE=/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
  node scripts/verify-sync-op-parity.js
# against the BRANCH cloud: still OK
OSI_SERVER_EDGE_SYNC_SERVICE=/home/phil/Repos/osi-server/.worktrees/agrolink/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java \
  node scripts/verify-sync-op-parity.js
```
  Expected: both end `verify-sync-op-parity: OK` with no fallback warning. Confirm `/home/phil/Repos/osi-server` is still on `main` before trusting the first run.

- [ ] **Run the contract gate:** `node scripts/verify-sync-contract.js && node --test scripts/verify-sync-op-parity.test.js` → both exit 0.

- [ ] **Write the deploy-day un-stage step** into the runbook: after the cloud is deployed and answering, revert this commit's three edits and re-run both parity invocations. Reference it from Phase 4 task D2, because the same deploy window owns both.

- [ ] **Commit:**
```bash
git add docs/contracts/sync-schema/sync-contract-golden.json scripts/verify-sync-op-parity.js scripts/verify-sync-op-parity.test.js docs/operations/
git commit -m "fix(sync): stage the seven event ops the deployed cloud cannot handle"
```

**Interaction with D2:** the five `USER*` ops in this list are exactly the events that populate `gateway_user_mirrors`. Staging them is a statement about the deployed cloud, not an emit gate — the edge triggers keep firing (subject to `scoped_access_emit.enabled`, which is a separate switch and currently 0). Do not "complete" this task by adding an emit gate keyed on `cloudDeferred`; that would block D2's mirrors from ever arriving.

---

## Task D1 — the absent-resource bootstrap covers telemetry and journal types

Commit `8ac15856` opened absent-resource bootstrap for `DEVICE` and the zone family. `ABSENT_RESOURCE_ALLOWED` (`EdgeOwnershipService.java:47-50`) still excludes `DEVICE_DATA`, `DEVICE_DATA_ROW`, `DENDRO`, `DENDRO_ROW`, `CHAMELEON`, `CHAMELEON_ROW`, so telemetry for a device the cloud has never seen is terminally rejected — which is the mechanism behind D3's 14,386 dead rows on agrolink-test-01.

Journal types are worse than excluded. `resolve()` (`:65-97`) has **no case** for `JOURNAL_ENTRY`, `JOURNAL_VOCAB`, `JOURNAL_PLOT` or `JOURNAL_PLOT_GROUP`; they fall to `default ->` (`:93`), which logs `unknown resourceType` and yields `UnknownType()`, and `canMutate` denies `UnknownType` unconditionally (`:120`) whatever the whitelist says. Adding journal types to `ABSENT_RESOURCE_ALLOWED` alone changes nothing. They need a `resolve()` case first. This is the ~111 `ownership_denied` journal rejections on kaba100 (D6).

**Per-type review is the work here, not the whitelist edit.** The existing Javadoc (`:20-45`) is the safety argument for every current member, and it names the exact reason each excluded type is excluded: telemetry appliers create an absent device through `DeviceService.upsertFromHeartbeat` **without recording any `gateway_device_eui`**, so opening them as written would let any gateway attribute telemetry to an unregistered EUI with no ownership ever assigned. Opening the telemetry types therefore requires the applier to record the owner, not just a whitelist entry.

**Files**
- Modify: `backend/src/main/java/org/osi/server/security/EdgeOwnershipService.java`
- Modify: `backend/src/main/java/org/osi/server/device/DeviceService.java` (`upsertFromHeartbeat`)
- Modify: `backend/src/test/java/org/osi/server/security/EdgeOwnershipServiceTest.java`
- Modify: `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceOwnershipIntegrationTest.java`

**Interfaces**
- Changed: `upsertFromHeartbeat` records the incoming `gatewayDeviceEui` on a device it creates. That is the precondition the Javadoc names; without it the whitelist entry is unsafe.
- Produces: `resolve()` cases for the four `JOURNAL_*` types, resolving the owner from the journal repositories' `gateway_device_eui`, mirroring the zone-family shape.
- Changed: `ABSENT_RESOURCE_ALLOWED` gains `DEVICE_DATA`, `DEVICE_DATA_ROW`, `DENDRO`, `DENDRO_ROW`, `CHAMELEON`, `CHAMELEON_ROW` and the four `JOURNAL_*` types, each with its own Javadoc sentence.
- Unchanged: `GATEWAY`, `WORK_REQUEST` and the `USER*` family stay closed. Their `resolveId` derives the owner from the resourceId itself, so they never legitimately produce `Absent` — only a malformed resourceId does, and that must keep failing closed.
- Unchanged: `WEATHER_STATION_ZONES` stays closed. Its applier requires the station to exist and never creates one, so opening it is a no-op.

**Steps**

- [ ] **Write the failing tests**, one per type family, copying the shape of `absentDeviceDataRowStaysDeniedBecauseItsApplierDoesNotAssignOwnership` (`EdgeOwnershipServiceTest.java:107-122`) and inverting it. Add `absentJournalEntryResolvesRatherThanFallingToUnknownType()` asserting `canMutate` is true for a matching gateway and **false for a different one** — that second assertion is what proves the new `resolve()` case did not become a blanket allow.
- [ ] Add an `EdgeSyncServiceOwnershipIntegrationTest` case asserting that a telemetry event for an unseen EUI is applied and that the created device carries the submitting gateway's EUI.
- [ ] **Run to see it fail:** `./gradlew test --tests "org.osi.server.security.EdgeOwnershipServiceTest" --tests "org.osi.server.sync.EdgeSyncServiceOwnershipIntegrationTest" -x buildFrontend -x buildTerraIntelligenceFrontend`
- [ ] **Record the ownership** in `upsertFromHeartbeat` first, then add the `resolve()` journal cases, then extend the whitelist. Rewrite the "Deliberately NOT included" paragraph so it describes what is still excluded and why — a stale safety argument on a widened whitelist is worse than none.
- [ ] **Run to see it pass**, then `./gradlew test --tests "org.osi.server.security.*" --tests "org.osi.server.sync.*" -x buildFrontend -x buildTerraIntelligenceFrontend`.
- [ ] **Commit:** `git add -A && git commit -m "fix(sync): bootstrap absent telemetry and journal resources instead of rejecting them"`

**Scope note:** this task fixes the rejection *going forward*. It does not replay the rows already stamped `rejected_at` — that is D3, in Phase L, and it needs cloud-side dead-letter clearing as well.

---
# Phase 3 — should-fixes

Eleven tasks: five edge, two cloud, four branch-wide. None blocks the merge on its own, and each one is a hole the §10 walkthrough or a support ticket will find. C5 and C6 are called out in the ledger as visible during the walkthrough itself, so land them before Phase 4.

## Task E6 — `POST /api/devices` stops moving an existing device

`post-devices-insert` builds its UPDATE branch as `UPDATE devices SET user_id = <userId>, irrigation_zone_id = <msg._deviceZoneId or NULL> …` (`:66-67`). Re-posting an existing device therefore writes the zone unconditionally: with no `zone_id` it unassigns the device, and with a different `zone_id` it moves it out of whatever zone it was in. Both bypass the P7 precondition and the W4 rule that moving a device is an explicit unassign followed by an assign.

**Files**
- Modify: `scripts/test-scoped-access-writes.js`
- Modify: both `flows.json` profiles (nodes `scoped-device-claim-router`, `post-devices-insert`)
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces**
- Changed, for a row that already exists: `irrigation_zone_id` is written only when the row's current value is NULL and `msg._deviceZoneId` is an integer. Absent `zone_id` leaves the column alone.
- Produces: `409` with `{ message, current_zone_id, current_zone_name }` — the same body `scoped-device-assign-router` already returns — when the row sits in a zone and `_deviceZoneId` names a different one. Re-posting into the zone the device is already in is accepted (idempotent).
- Unchanged: the INSERT branch (`:80-82`), the claim of an unclaimed row, and every `zone_id` validation Task 7 added to `scoped-device-claim-router`.

**Steps**

- [ ] **Write the failing tests** in `scripts/test-scoped-access-writes.js`, next to the `W5:` registration cases: re-post `DENDRO1` (in zone 1) with no `zone_id` and assert `irrigation_zone_id` is still 1; re-post it with `zone_id: 2` and assert `409` plus `current_zone_id === 1` and an unchanged row; re-post it with `zone_id: 1` and assert success.
- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-writes.js` — the first case fails with `null !== 1`, the second with `200 !== 409`.
- [ ] **Load the osi-flows-json-editing skill.** Add the conflict check to `scoped-device-claim-router`, where the existing-row lookup and the zone-name join already belong, and make `post-devices-insert`'s UPDATE emit `irrigation_zone_id = COALESCE(irrigation_zone_id, <value>)` so an existing assignment survives while a NULL one is filled. Carry a comment naming W4 and pointing at `scoped-device-assign-router` as the only path that moves a device.
- [ ] **Run to see it pass**, raise the ceilings for both touched nodes plus `max_total`, run the flows gate, and commit as `fix(scope): stop POST /api/devices moving or unassigning an existing device`.

---

## Task E7 — zone delete releases every member device

`delete-zone-unassign` builds `UPDATE devices SET irrigation_zone_id = NULL … WHERE irrigation_zone_id = ${zoneId} AND user_id = ${userId}`. The `user_id` term is the deleter's. On a multi-user gateway every device owned by someone else keeps pointing at a zone that no longer exists, and there is no way back: assign returns the E6/P7 conflict naming the dead zone, and unassign 404s on it. The conflict body makes it worse — `current_zone_name` comes from a `LEFT JOIN … AND iz.deleted_at IS NULL`, so a soft-deleted zone yields NULL and the modal renders `already in zone ""`.

**Files**
- Modify: `scripts/test-scoped-access-writes.js`
- Modify: both `flows.json` profiles (nodes `delete-zone-unassign`, `scoped-device-assign-router`)
- Modify: `web/react-gui/src/components/farming/ZoneDeviceModal.tsx` and its test
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Interfaces**
- Changed: the unassign UPDATE drops `AND user_id = ${userId}` and gains `AND deleted_at IS NULL`. This changes flag-off behavior deliberately — it is the ledger's E7 fix, and the constraint elsewhere in this plan is about *accidental* flag-off drift. Say so in the commit body.
- Changed: the assign 409 resolves the current zone's name without the `deleted_at IS NULL` join condition, and adds `current_zone_deleted: boolean`.
- Changed: the modal renders a distinct string when `current_zone_deleted` is true or `current_zone_name` is null, instead of interpolating an empty name.

**Steps**

- [ ] **Write the failing tests:** a zone owned by user 1 holding a device owned by user 2 is deleted; assert the device's `irrigation_zone_id` is NULL afterwards. Then assert an assign conflict against a soft-deleted zone returns a non-null `current_zone_name` and `current_zone_deleted: true`.
- [ ] **Run to see it fail:** `node --test scripts/test-scoped-access-writes.js`.
- [ ] **Edit both nodes** through the flows-editing skill, then the modal and its test (`cd web/react-gui && npm run test:unit`).
- [ ] **Raise the ceilings**, run the flows gate, commit as `fix(zones): release every member device on zone delete and name a deleted zone in the conflict`.

**Not in scope:** repairing rows already stranded on live gateways. That is live-state work; if the §10 walkthrough finds any on agrolink-test-01, add it to Phase L.

---

## Task E8 — finish the `showAdmin` and `scopeLoading` migration

Two sites were missed. `CrossZoneAnalysisPage.tsx:173` still reads `showAdmin={isAdmin && isScoped && !scopeLoading}` — the `isScoped` conjunct the migration removed everywhere else (`FarmingDashboard.tsx:150`, `JournalPage.tsx:225`, `HistoryDashboard.tsx:407`), which hides the admin menu on a flag-off gateway. And `JournalPage.tsx:231` gates the page body on `{scopeLoading || catalogState.loading ? …}`, so a `/api/me` that never resolves parks the Journal on a spinner forever. Spec §7 says a failed `/api/me` degrades to read-only, not to a blank page; `HistoryShell` already has the test for it.

**Files**
- Modify: `web/react-gui/src/pages/CrossZoneAnalysisPage.tsx` (173)
- Modify: `web/react-gui/src/pages/JournalPage.tsx` (128, 192, 231)
- Modify: `web/react-gui/src/pages/__tests__/JournalPage.test.tsx`
- Modify or create: the CrossZoneAnalysisPage test file

**Interfaces**
- Changed: `showAdmin={isAdmin && !scopeLoading}`, matching the other three pages exactly.
- Changed: `scopeLoading` gates write affordances only. Line 228's `{!scopeLoading && !canWrite && <ReadOnlyNotice …>}` stays — that is a write affordance. Lines 128, 192 and 231 drop the conjunct.

**Steps**

- [ ] **Copy the never-resolves test.** `web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx` has `renders the zone list even when the scope profile never resolves`, which sets `scopeState.loading = true` and asserts content still appears. Port it to `JournalPage.test.tsx` as `renders the journal timeline even when the scope profile never resolves`.
- [ ] Add a CrossZoneAnalysisPage case asserting `showAdmin` is true for an admin with `isScoped: false`.
- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit` — the Journal case hangs on the spinner, the admin case receives `false`.
- [ ] **Make both edits**, re-run `npm run test:unit && npm run typecheck`, commit as `fix(gui): finish the showAdmin migration and stop scopeLoading gating the journal body`.

---

## Task E9 — the header-wiring test can catch a `showAdmin` revert

`FarmingDashboardHeaderWiring.test.tsx`'s admin case sets `isScoped = true`, so `isAdmin && isScoped && !scopeLoading` and `isAdmin && !scopeLoading` both evaluate true. Reverting the migration would leave the suite green. The revert is only observable with `isScoped: false`.

The ledger's other two test-honesty items land elsewhere: the single-item `ZoneDeviceModal` catalog mock and the missing `AddDeviceModal` test file are both fixed in E1. This task owns the remaining one.

**Files**
- Modify: `web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx`

**Steps**

- [ ] Replace the single `shows the admin menu for a scoped admin` case with an `it.each` over `[['scoped', true], ['flag-off', false]]`, asserting `headerProps[headerProps.length - 1]?.showAdmin` is true in both. Add a comment saying the `isScoped: false` row is the one that fails on a revert.
- [ ] **Prove it catches the revert:** temporarily restore `isAdmin && isScoped && !scopeLoading` in `FarmingDashboard.tsx:150`, run `npm run test:unit`, confirm the flag-off row fails, then restore the correct expression. Record the observed failure message in the commit body. A test that was never seen failing is not a test.
- [ ] Commit as `test(gui): pin showAdmin against a flag-off revert`.

---

## Task E10 — the AppKey field is translated

Four keys are referenced from `AddDeviceModal.tsx` (`:47`, `:126`, `:127`, `:135`) and `ZoneDeviceModal.tsx` (`:92`, `:224`, `:225`, `:233`) and exist in none of the seven locales: `addModal.appkeyInvalid`, `addModal.appkey`, `addModal.appkeyHint`, `addModal.appkeyPlaceholder`. All four render through their inline English default everywhere, `lg` included.

**Files**
- Modify: `web/react-gui/public/locales/{de-CH,en,es,fr,it,lg,pt}/*.json` (the file holding `addModal` — confirm which before editing)
- Modify: the edge locale-completeness test (find it with `grep -rln addModal web/react-gui/src/__tests__ web/react-gui/tests 2>/dev/null`)

**Steps**

- [ ] **Extend the locale test to referenced-key completeness**, scanning `web/react-gui/src` for `addModal.<key>` occurrences rather than hard-coding a list. The cloud half of this fix (C3) writes the same scan; port that implementation rather than writing a second one, adjusting only the locale root path. Where the two repos' test harnesses differ, keep the assertion identical.
- [ ] **Run to see it fail:** `cd web/react-gui && npm run test:unit` — four missing keys per locale.
- [ ] **Add the four keys to all seven locales**, taking English from each call site's inline default. `lg` is the Uganda ship gate: a real translation, or the English string plus a note in the commit body flagging it as a draft.
- [ ] Run `npm run test:unit`, commit as `fix(i18n): translate the AppKey field in all seven locales`.

---

## Task C5 — `devicesForZone` drops the owner filter

`IrrigationZoneController.devicesForZone` (`:1795-1805`) filters on `device.getClaimedBy().getId().equals(zone.getUser().getId())`. With reads widened to gateway membership, a zone on a multi-user gateway comes back missing every device a colleague claimed. The sibling implementation in `ZoneEnvironmentService.devicesForZone` (`:463-469`) already has no such filter, so the two disagree about what is in a zone.

**Files**
- Modify: `backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java` (1795-1805)
- Modify or create: the zone-devices read test

**Interfaces**
- Deleted: the `claimedBy` filter. The gateway-EUI filter on the next lines stays — that is star-topology gateway selection, not read scoping.
- Result: the two `devicesForZone` implementations agree.

**Steps**

- [ ] Write `zoneDevicesIncludeDevicesClaimedByAnotherMember()` asserting a device claimed by user B appears in user A's read of a zone on a gateway both are members of. It fails today with an empty list.
- [ ] **Run to see it fail:** `./gradlew test --tests "org.osi.server.zone.*" -x buildFrontend -x buildTerraIntelligenceFrontend`
- [ ] Delete the two filter lines, re-run, and confirm `ZoneEnvironmentServiceTest` stays green.
- [ ] Commit as `fix(zones): return every device in a zone, not only the caller's claims`.

---

## Task C6 — 409 bodies say which conflict happened

Two different 409s leave `assignDevice`. The gateway-mismatch one is `ResponseEntity.status(409).header("X-Sync-Error", …).build()` with **no body** (`:438-441`); the already-assigned one carries `message`, `current_zone_id` and `current_zone_name` (`:447-455`). The frontend treats them alike: `AssignDeviceModal.tsx:79-83` renders `assignModal.conflictTitle` with `zoneName: err.response.data?.current_zone_name ?? ''`, so a gateway mismatch shows as `already in zone ""`.

The advisory precondition itself is a second problem. It reads `device.getIrrigationZone()` from the mirror, so a device the edge has already unassigned still looks assigned until the mirror catches up, and the cloud refuses a legal assign in that window. The comment at `:443-444` already says the edge's conditional UPDATE is authoritative.

**Files**
- Modify: `backend/src/main/java/org/osi/server/zone/IrrigationZoneController.java` (438-456)
- Modify: `frontend/src/components/farming/AssignDeviceModal.tsx` (79-86)
- Modify: `frontend/src/locales/*/devices.json` (one new key, seven locales)
- Modify: `backend/src/test/java/org/osi/server/zone/IrrigationZoneDeviceAssignmentScopeTest.java`
- Modify: `frontend/src/components/farming/__tests__/AssignDeviceModal.test.tsx`

**Interfaces**
- Changed: the gateway-mismatch 409 gains a body `Map.of("message", …, "reason", "gateway_mismatch")`, keeping the `X-Sync-Error` header for existing consumers.
- Changed: the already-assigned 409 gains `"reason", "already_assigned"`.
- Changed: the modal branches on `reason` and falls back to the generic failure string when `current_zone_name` is absent, never interpolating an empty name.

**Command-through on a stale mirror:** the ledger raises it as a consideration, not a decision. This task does **not** implement it. Rationale to record in the commit body: the mirror is the only assignment state the cloud has, and issuing `ASSIGN_DEVICE_TO_ZONE` against a device the mirror says is assigned would race the edge's own conditional UPDATE with no way to reconcile the loser. The honest 409 tells the operator to retry after sync. Revisit if the walkthrough shows the window is long enough to matter.

**Steps**

- [ ] Write the two backend cases asserting each 409 carries its `reason`, and the modal case asserting a body-less mismatch 409 renders the generic failure rather than `zone ""`.
- [ ] **Run to see it fail:** the backend suite and `npm run test:unit`.
- [ ] Implement, add the locale key to all seven, re-run both suites, and commit as `fix(zones): distinguish the two assign conflicts in the body and the modal`.

---

## Task X8 — the login path cannot hang

`auth-process-result` (tab `auth-tab`) calls `linkedPasswordValue` → `installation.verifierSubject(password, version, installation_uuid, linkedGatewayDeviceEui(user))` inside the `server` auth branch, with no guard. `linkedGatewayDeviceEui` returns `''` for a placeholder EUI (`normalizeGatewayDeviceEui` maps `0101010101010101` to empty), and `verifierSubject` throws on that input. The function node's throw reaches the auth tab's catch node, which has no http-response node downstream, so the request hangs until the client times out.

**Files**
- Modify: both `flows.json` profiles (node `auth-process-result`, and the auth-tab catch node's wiring)
- Modify: `scripts/test-device-api-auth-status.js` or the auth-path test the executor identifies
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`

**Steps**

- [ ] **Read the auth tab's wiring first.** List every node with `z === 'auth-tab'`, find the `catch` node, and record what its `wires` point at. The fix has two halves and the second depends on what you find: either wire the catch node into the existing http-response node, or give it a small function node that sets a 500 and returns.
- [ ] **Write the failing test:** a `server`-auth user with a placeholder gateway EUI must get a `500` (or `401`), not an unresolved promise. Assert on the returned `statusCode`, and put a timeout on the call so a hang fails the test rather than hanging the suite.
- [ ] **Run to see it fail** — the assertion never runs, or the test times out.
- [ ] **Guard the call** in `linkedPasswordValue`: when `linkedGatewayDeviceEui(user)` is empty, fall back to the `server_password_hash` comparison the same branch already uses when `server_offline_verifier` is blank, and `node.warn` the reason. Then fix the catch-node wiring.
- [ ] Raise the ceiling, run the flows gate, commit as `fix(auth): stop a placeholder-EUI linked login hanging the request`.

---

## Task X9 — four auth and provisioning repairs

Four independent items, one commit each inside this task, or one commit for the set if the executor prefers — say which in the commit body.

**(a) Duplicated auth-secret generators.** `getAuthSecret()` in `auth-process-result` reads `/data/db/osi_auth_token_secret`, and on a miss generates 48 random bytes and writes the file. Find every other copy (`grep -c osi_auth_token_secret` across both `flows.json` profiles, then locate each node) and collapse them onto one shared helper. On a fresh gateway two nodes racing this path mint two different secrets, and whichever loses invalidates the other's tokens. Test: two concurrent calls on an empty secret path yield the same secret.

**(b) Password reset leaves old tokens valid.** `issueSignedToken` sets `exp: now + (7 * 24 * 60 * 60 * 1000)` and nothing consults a revocation signal, so a token minted before a reset stays valid for up to seven days. Two options; take the second only if the first is judged insufficient during the task, and record which: document the disable-then-re-enable procedure in the admin runbook as the supported revocation path, or add a per-user token epoch bumped on reset and checked in `verifyBearer`. The epoch is a schema change and goes through the `osi-schema-change-control` skill if chosen.

**(c) `verifyKeys` mismatch skips the rollback with no ACK signal.** In `osi-chirpstack-helper/index.js`, the mismatch branches at `:515` and `:532` return `reconciliationRequiredError('verifyKeys', 'keys')` without rolling the key back and without a field the ACK can carry. Add a distinguishing field to the bounded error and surface it on the ACK, so the cloud can tell "provisioned" from "provisioned but the key did not verify". Do not add a rollback in the same task; that changes the 4.12 read-back semantics this helper was rewritten for, and needs its own review.

**(d) `cs-register-device-fn` double HTTP response on compensation failure.** In the node's catch block, `node.error(…, msg)` on a failed compensation routes `msg` through `device-api-catch` → `device-api-http500` → `device-response`, and then the same catch block's `return [null, msg]` reaches `device-response` on the node's second output. Same `msg.res`, two responses, and Node-RED logs the second as an error. Use `node.error(message)` without the `msg` argument for the compensation log so only the explicit return responds. Test: assert exactly one message reaches the response output on a compensation failure.

Each item: failing test first, then the fix, then `node --test` on the touching suite plus the flows gate where `flows.json` changed. Commit prefix `fix(auth)` / `fix(chirpstack)` as appropriate.

---

## Task X10 — journal void and catalog work for grantees

Two items.

**(a) Plotless entries are readable but not voidable.** `assertEntryWrite` (`api.js:703-712`) throws `404 not_found` when `!entry.plot_uuid`. `voidEntry` (`:1299`) routes through it, so a scoped user can read an entry with no plot and cannot void it. Fix: when the entry exists but has no plot, fall back to `assertJournalWriteRole(db, principal)` instead of 404. Test: a scoped researcher voids a plotless entry; a viewer still cannot.

**(b) The catalog GET is not owner-rewritten.** `:419` returns `catalogDto(await loadCatalog(db, principal), options)` with the caller's principal, and `loadCatalog` filters custom vocabulary on `owner_user_uuid` (W9 keeps that owner-only). A grantee therefore sees an empty custom vocabulary where the farm owner's entries use it, and cannot read back the fields on entries they can see. Fix: resolve the vocabulary owner the same way `assertPlotWrite` does when the request carries a plot or zone context, and leave the owner-only filter itself intact — W9 is not being widened. Test: a grantee reading the catalog in a plot context sees the plot owner's custom fields; a grantee with no context still sees only their own.

**Files:** `osi-journal/api.js` (+ bcm2709 mirror) and the journal test suite. Mirror, then `node scripts/verify-sync-flow.js`. Commit as `fix(journal): allow voiding plotless entries and resolve the catalog owner for grantees`.

---

## Task X11 — CI runs the gates on this branch

Nine workflows exist and none of their triggers matches `feat/journal-cloud-primary`. Six fire on `[main, master]` (`codecs`, `edge-behavior`, `field-journal`, `history-router`, `migrations`, `typecheck`, `verify-sync-flow` — seven, counting both), and two fire on `[AgroLink]` (`journal-catalog`, `ui-core`), a branch this work never touches. Zero gates ran. X1 adds the provenance workflow with a branch trigger; this task widens the rest and wires the unrun suites.

Three specifics the executor should not rediscover:

- `verify-sync-op-parity` **does** run today, in `migrations.yml:92` (the `.test.js`) and `:95` (the verifier, with a positional `osi-server/backend/.../EdgeSyncService.java` argument), but main-only. The positional argument is a valid pinning; the hazard is a job that omits it.
- `OSI_EXPECT_FLOW_RED` appears in no workflow. The gate it controls is `osi-chirpstack-helper/index.test.js:1195` (`const RUN_FLOW_RED = process.env.OSI_EXPECT_FLOW_RED === '1';`) in both profiles.
- The seven `test-journal-v2-*.js` scripts and the `osi-journal-replication` package tests are unreferenced, while `journal-v2-replication-tick` runs on a 30-second inject with `once: true`. The suite covers code that is live.

**Files**
- Modify: every file in `.github/workflows/`
- Create: `backend`-side test files for `osi-zone-commands` and `osi-scoped-access-commands` (edge packages under `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`)

**Interfaces**
- Every workflow's `on:` gains the same branch set X1 uses: `[main, master, AgroLink, 'feat/**', 'fix/**', 'docs/**']` plus `pull_request` and `workflow_dispatch`. Keep `AgroLink` so `journal-catalog` and `ui-core` do not lose the trigger they have. Copy X1's block so the ten agree.
- `verify-sync-op-parity` runs with a **pinned** pairing. Its default fallback prints `no osi-server worktree named "…" was found; falling back to the sibling checkout's CURRENT branch … This is not a trustworthy branch pairing.` and still exits 0, so an unpinned CI job proves nothing. Pin with `OSI_SERVER_EDGE_SYNC_SERVICE` pointing at a checked-out osi-server revision, and **fail the job if the fallback warning appears in the output** — grep the captured output for `not a trustworthy branch pairing` and exit non-zero on a hit.
- Flow tests run with `OSI_EXPECT_FLOW_RED=1`. The `flowTest` cases in `osi-chirpstack-helper/index.test.js` are `test.skip` without it, which is why X4's neighbourhood had no coverage.

**Steps**

- [ ] **Enumerate what is unwired.** For each `scripts/test-*.js`, `scripts/verify-*.test.js` and package-level `*.test.js`, grep the nine workflows for its filename and list the misses. The ledger counts ten contract/command-path suites plus the journal-V2 suite; produce the actual list and put it in the commit body rather than trusting the count.
- [ ] **Widen the nine `on:` blocks**, then `python3 -c "import yaml; [yaml.safe_load(open(f)) for f in __import__('glob').glob('.github/workflows/*.yml')]"` to confirm they all parse.
- [ ] **Add the missing suites** to the workflow that already owns their area, creating a new workflow only where none fits.
- [ ] **Add the pinned parity job** with the trustworthiness grep described above.
- [ ] **Add the `OSI_EXPECT_FLOW_RED=1` flow-test job.** Expect it to be red on first run — that is the point. Fix what it reports, or, if a failure is a known-red case the branch does not own, record it in the commit body with the reason.
- [ ] **Write first tests for the two untested command modules.** `osi-zone-commands` (802 lines) and `osi-scoped-access-commands` (479) have none. First tests, not full coverage: for each exported command handler, one applied case and one rejected case, so a future change has something to break. Wire both into the workflow that runs the other edge package suites.
- [ ] Commit as `ci: run the branch gates on feature branches and cover the command modules`.

---
# Phase L — live-state repairs

Three tasks against running systems, from the maintainer's 2026-08-13 sweep. They repair state, not code, so they sit outside the code phases and outside their no-live-work rule.

**Rules for this phase, all of them mandatory:**

- **Load `.claude/skills/osi-live-ops-runbook` before the first command.** It owns SSH, backup and safety judgment for live gateways and the production cloud.
- **Take a backup before every write**, per the runbook's pre-repair procedure. A repair with no backup does not start.
- **Never reseed or overwrite `/data/db/farming.db`.** These are targeted `UPDATE`s on existing rows.
- **agrolink-test-01 must be reachable first (D8).** It went offline mid-session with an SSH and `:1880` timeout after being healthy an hour earlier, which looks like site network or power rather than the deploys. Confirm it answers before scheduling anything here or on deploy day.
- **Production access is not implied.** kaba100 is a demo gateway; `osicloud.ch` is production and needs explicit per-turn consent. L3's cloud half touches a cloud database — get that consent before starting, or stop at the edge half and report.
- These tasks produce no repo commits. Record what was run and what changed in the session notes.

## Task L1 — kaba100 stores two plaintext passwords (D4)

`Farmer` and `admin` on kaba100 have plaintext `password_hash` values; `test` is correctly bcrypt. The login path tolerates it: `auth-process-result` falls through to `passwordValid = (user.password_hash === password)` when the stored value does not start with `$2`. kaba100 is flag-off and untouched by this branch, so this is pre-existing.

- [ ] Load the live-ops runbook. Back up `/data/db/farming.db` per its procedure.
- [ ] Confirm the scope: `SELECT id, username, auth_mode, substr(password_hash,1,4) FROM users;`. A row whose `auth_mode` is `server` reads `server_offline_verifier` or `server_password_hash` instead, and re-hashing `password_hash` there changes nothing — check before writing.
- [ ] Re-hash each plaintext row with `bcryptjs` at **cost 10**, matching all three `hashSync` call sites in the flows. Guard the statement with `AND password_hash NOT LIKE '$2%'` so a re-run cannot double-hash. Pass the plaintext through an environment variable, never argv, so it stays out of the process list and shell history.
- [ ] Verify by logging in as each repaired account through `:1880/gui`, then confirm `substr(password_hash,1,4) = '$2'` for every row.
- [ ] **Check Silvan and Uganda for the same pattern** and repair them the same way if found. Uganda is production irrigation; treat it with the runbook's production caution.

## Task L2 — the 0034 backfill promoted the wrong account (D5)

`0034__scoped_access_backfill.sql` ends with `UPDATE users SET role = 'admin' … WHERE id = (SELECT MIN(id) FROM users WHERE disabled_at IS NULL) AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`. On kaba100 the oldest enabled account is `Farmer` (id 1), so `Farmer` is now an enabled admin.

Two halves: correct the live data, and stop the next gateway inheriting it.

- [ ] **Live:** confirm with `SELECT id, username, role, disabled_at FROM users ORDER BY id;`, back up, then set the intended admin and demote `Farmer` — using the guarded SQL, not a bare `UPDATE`, so the last-enabled-admin invariant holds. Promote first, demote second; the reverse order trips the guard.
- [ ] **Guard for future gateways:** `MIN(id)` is a proxy for "the operator's account" and it is wrong whenever a farm account predates the operator's. Decide one of: promote nobody and require an explicit admin designation at provisioning, or key the promotion on something that identifies the operator rather than row order. Whichever you choose, it is a migration change and goes through the `osi-schema-change-control` skill, with its own task and its own review. Do not edit `0034` in place — it has already run on live gateways.
- [ ] Note the `NOT EXISTS` subquery has no `disabled_at` filter, so a single disabled admin suppresses the promotion entirely. Fold that into the same decision.

## Task L3 — dead outbox rows on agrolink-test-01 and kaba100 (D3, D6)

14,386 rejected rows on agrolink-test-01 and 381 on kaba100 (222 `stale_sync_version`, 48 `equal_version_payload_conflict`, ~111 journal `ownership_denied`). The drain query skips any row with `rejected_at IS NOT NULL`, so they are invisible forever, and the pile grows while the sim tabs run: a sim device whose DEVICE-create died before the bootstrap fix is still unregistered cloud-side, so all of its telemetry keeps rejecting.

**Read this before planning the repair.** The ledger points at a re-enqueue recipe in the `sync-ownership-bootstrap-gap-2026-08-12` memory. That memory records the opposite — that rejections are terminal and never replayed — and no re-enqueue tooling exists in either repo. Clearing `rejected_at` on the edge alone does **not** work: re-sent rows keep their original `event_uuid`, and the cloud dedups on it (`SyncEventTxExecutor` checks the inbox and the dead-letter table and answers `DUPLICATE`). A working replay is a two-sided operation.

- [ ] **Stop the growth first.** D1 fixes the ownership rejection going forward; it must be deployed before any replay, or the replayed rows reject again. Until then, consider disabling the sim tabs on agrolink-test-01 — decide with the maintainer, since the sims are the parity test bed.
- [ ] **Measure, do not guess.** On each gateway: `SELECT rejection_reason, aggregate_type, COUNT(*) FROM sync_outbox WHERE rejected_at IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC;`. Only `ownership_denied` rows are candidates. `stale_sync_version` and `equal_version_payload_conflict` mean the cloud already holds a newer or conflicting version and replaying them is wrong.
- [ ] **Decide per class, and write the decision down**: replay, or accept the loss and re-register the affected devices so future telemetry lands. Re-registering the sims is the smaller operation and may be the whole answer for D3.
- [ ] **If replaying:** it needs an edge-side clear (`rejected_at`, `rejection_reason`, `retry_count`, `last_retryable_failure_at`) **and** a cloud-side removal of the matching `event_uuid` rows from the inbox and dead-letter tables, in that order, inside one maintenance window. Back up both sides first. This is production cloud data — get explicit consent for that turn.
- [ ] **Verify** by watching the outbox drain and the cloud mirror populate, then re-running the count query. Record before and after numbers.

---

# Phase 4 — cleanups, deploy-day gates, and the walkthrough

Six tasks. The three cleanup tasks are batched follow-ups and can run in parallel with anything. C8, D2 and the walkthrough are ordered and close the branch.

## Task E11 — edge follow-up cleanups

Four items from the ledger's FU row, one commit.

- [ ] **Assign lost idempotency.** Re-assigning a device to the zone it is already in returns 409. The write-only-scoping cloud plan explicitly wanted `reassigningToTheSameZoneIsAccepted` → 202; the edge disagrees. Make the edge match: a 409 only when the current zone differs from the target.
- [ ] **Stale migration scripts emit deleted helper calls.** `scripts/migrate-flows-scoped-access-phase-*.js` generate calls to helpers Task 14 removed. Either delete the scripts (they have already run) or update them. Deleting is preferred; say why in the commit body.
- [ ] **Tablist accessibility** on the two-tab device modal: `role="tablist"` / `role="tab"` / `role="tabpanel"` with `aria-selected` and arrow-key navigation. E1's tests already query by `role: 'tab'`, so they pin part of this.
- [ ] **`HistoryDashboard` loadingMessage still includes `scopeLoading`.** Task 12 removed it from `shellReady` and the empty state but left it in the loading message, so a hung `/api/me` still shows "loading" text over a rendered list.

Run `cd web/react-gui && npm run test:unit && npm run typecheck` plus the flows gate if any node changed. Commit as `chore(scope): edge follow-up cleanups from the branch review`.

## Task C7 — cloud follow-up cleanups

Five items, one commit.

- [ ] **`JournalQueryService.find`** — confirm whether any `main` caller remains after Task 9 pointed the write paths at `findWithinWriteScope`. Delete it if not; keep it with a comment naming its caller if so.
- [ ] **`findOwnedS2120`** — dead after Task 6 rewrote `getWeatherStationZoneAssignments`. Delete it and its test.
- [ ] **Stray `@Transactional(readOnly = true)` on a write helper** — locate it, and either drop the annotation or drop `readOnly`, whichever matches what the method does. A `readOnly` transaction around a write is a latent failure, not a style issue.
- [ ] **Resolve-then-catch one level up from `tryResolve`** — a caller wraps `resolve` in a try/catch instead of calling `tryResolve`. That is the exact pattern Task 1 introduced `tryResolve` to remove, because catching outside the `@Transactional` boundary leaves the participating transaction rollback-only. Re-point the caller.
- [ ] **ArchUnit omitted-dependency counters were re-baselined upward.** The ledger cites +4552. Verify that number against the baseline file before acting: if the counter exists and moved, either justify the new value in the file's own comment or restore the old one and fix what pushed it up. If the number cannot be reproduced, say so in the commit body rather than inventing a justification — it is the one item in this row that could not be confirmed from the branch.

Run `./gradlew test -x buildFrontend -x buildTerraIntelligenceFrontend`. Commit as `chore(scope): cloud follow-up cleanups from the branch review`.

## Task X12 — branch-wide follow-up cleanups

Five items, one commit.

- [ ] **`action:` effect keys are inert on un-upgraded gateway ledgers.** The grammar at `osi-command-ledger/index.js:239-245` is only honored by a ledger that has the branch's code. Document the version dependency where the grammar is defined, and in `effect-keys.md`.
- [ ] **`effect-keys.md:124-130` understates the implemented dedupe.** The replay-rules section names zone and irrigation-config as the types requiring a matching canonical intent hash; the code also enforces it for device-desired-state types (`index.js:512-522`) and enforces journal provenance plus `submittedIntentHash` (`:500-511`). Bring the doc up to what runs.
- [ ] **`canonicalization-v2.md:3-4` says V2 authorizes no producer**, while `journal-v2-replication-tick` runs on a 30-second inject with `once: true`. The runtime is safe; the doc is wrong. Correct it, and say what the tick actually does.
- [ ] **Guarded-SQL string surgery is unpinned.** `scoped-admin-account-router` rewrites the helper's SQL with `.replace('SET role = ?', …)` (func L114-117) and `.replace('SET disabled_at =', …)` (L135-138). If `buildDeroleUserGuardedSql` or `buildDisableUserGuardedSql` ever changes its wording, the replace silently no-ops and the guard is lost. Add an assertion that each replace actually changed the string, and a test pinning both substrings against the helper's output.
- [ ] **The derole guard is over-strict with a disabled admin.** `buildDeroleUserGuardedSql` (`osi-scope-helper/index.js:296-300`) has no `disabled_at IS NOT NULL` exclusion on the target row, while its counting subquery excludes disabled admins — so deroling an already-disabled admin with one enabled admin left yields zero changes and a 409 "Cannot remove the last enabled admin", even though the target contributes nothing to the count. The disable variant (`:289-294`) and the command-path guard (`osi-scoped-access-commands/index.js:245-248`) both get this right; copy their shape.

Commit as `chore: branch-wide follow-up cleanups and doc corrections`.

## Task C8 — the full cloud sweep, with artifacts preserved

The 1,601-test sweep recorded in `69fc0667` cannot be verified from its artifacts: the preservation rerun clobbered the reports. Run it once more, at the end, with the reports kept.

- [ ] `cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew --stop && ./gradlew test`
  This is the one run without `-x buildFrontend -x buildTerraIntelligenceFrontend`. Run it alone; no other build may be running (zram swap, no disk fallback).
- [ ] **Copy the reports before anything else touches them.** `cp -r backend/build/reports/tests/test <somewhere outside build/>` immediately on completion. That is the step the previous sweep skipped.
- [ ] **Read the copied report, not the console.** Record total, failures and **skips**. The Testcontainers ITs (`DeviceMutationServiceTransactionIT`, `ScopedAccessMigrationIT`, `IrrigationConfigMigrationIT`) must be green, not skipped — a skipped IT reads as a pass in the totals and is why this row exists.
- [ ] `cd ../frontend && npm run test:unit` — both halves green.
- [ ] **Confirm the untouched-suite set is still untouched:** `DeviceMutationServiceTest`, `ZoneMutationServiceTest`, `ScheduleMutationServiceTest`, `IrrigationCalibrationMutationServiceTest`, `WeatherStationZoneMutationServiceTest`, `ScopedAccessMutationServiceTest`, `ScopedAccessControllerTest`, `JournalAccessServiceTest`, `JournalControllerTest`. `git log --stat` over the branch must not show them. C1 and C2 edit `IrrigationZoneDeviceAssignmentScopeTest` and add new files, which is fine; those nine are the write-gate proof.
- [ ] Commit the preserved summary as `test: full cloud sweep with preserved artifacts`.

## Task D2 — deploy-day gate: mirrors must populate

There is no dedicated AgroLink lockstep deploy runbook under `docs/operations/`; this
task owns the X7 deploy-day un-staging step and its two pinned parity checks.

`gateway_user_mirrors` has zero rows on the live cloud and `last_acknowledged_at` is NULL on both linked accounts. `GatewayScopeService:70-73` throws `403 "Gateway membership has not been confirmed by the edge"` without a mirror row, surfaced to the user as `"Gateway membership is required"` (`GatewayReadAccessService:47`). Every widened read is that path. Deploy without this gate and the dashboard is dead for everyone.

The edge machinery exists but has never emitted. `scoped_access_emit` is a one-row SQLite table seeded `enabled = 0` by `0033__scoped_access_schema.sql:44-50`, read only by the seven trigger `WHEN` clauses, and **written by nothing in runtime code** — no node, no API, no flag. Flipping it is a manual `UPDATE` on the gateway. That is why no USER event has ever been produced.

**Run the edge half before deploy day, as a diagnostic. Run the rest after the cloud is deployed.**

- [ ] **Pre-deploy diagnostic** (needs D8: the gateway back online). On agrolink-test-01, via the live-ops runbook:
  - `SELECT id, enabled FROM scoped_access_emit;` — expect `1|0`, which is the whole answer.
  - `SELECT aggregate_type, op, COUNT(*), SUM(delivered_at IS NOT NULL), SUM(rejected_at IS NOT NULL) FROM sync_outbox WHERE aggregate_type LIKE 'USER%' GROUP BY 1, 2;` — expect no rows.
  - `SELECT peer_node, gateway_device_eui FROM sync_link_state WHERE peer_node = 'cloud';` — **a second gate, easy to miss.** Every USER trigger takes its `gateway_device_eui` from this row, not from `env DEVICE_EUI`. A missing or NULL value means the events emit with a null owner, the cloud builds resourceId `"|<key>"`, and `EdgeOwnershipService` denies them. Fix this before flipping the emit gate.
  - Report all three before anyone schedules the deploy.
- [ ] **After the cloud is deployed and answering:** flip the gate with a backup first — `UPDATE scoped_access_emit SET enabled = 1 WHERE id = 1;`.
- [ ] **Fire the triggers.** The insert and role arms are `AFTER INSERT` and `AFTER UPDATE OF username, role, disabled_at`; existing rows need a touch. A no-op-looking `UPDATE users SET role = role WHERE …` does fire `AFTER UPDATE OF role`. Do it for both linked accounts. A `password_hash`-only update does **not** fire anything.
- [ ] **Verify on the cloud:** `SELECT gateway_eui, local_user_uuid, username, gateway_role, disabled_at FROM gateway_user_mirrors;` must return rows for **both** gateways. Until it does, the deployment is not done.
- [ ] **Un-stage the seven ops** from X7 now that the cloud handles them: revert X7's three edits and re-run both pinned `verify-sync-op-parity` invocations. Commit as `chore(sync): un-stage the seven event ops now the cloud handles them`.
- [ ] If mirrors do not populate, diagnose before retrying: re-check the emit flag, the `sync_link_state` EUI, and the outbox for `USER%` rows with `rejected_at` set. A rejected USER event is D1's territory, not a reason to touch the mirrors table by hand.

## Task W — the spec §10 two-account walkthrough

The branch's exit gate. It runs only when Phase 1 is green in both repos, the cloud is deployed to `agro-link.ch`, and D2 has passed. The vendored-contract CI has never run for AgroLink branches, so this walkthrough is the verification, not a formality.

Two accounts on `agrolink-test-01` and `agro-link.ch`: a granted researcher and a viewer. Walk both GUIs, both sides.

- [ ] Device list shows the unassigned LSN50 `A840412D385E7D00` for both accounts, on both sides.
- [ ] A cloud-registered device with no local owner appears in the edge list (E3's case).
- [ ] Both modal tabs work from the zone card. The register tab lands the device in the zone after the next sync, and **registers the type the dropdown showed** (E1) — pick something other than the first catalog entry deliberately.
- [ ] The zone card's add-device button is present for a researcher who does not own the gateway (C4).
- [ ] A zone-assigned weather station renders on its zone card, not in "Unassigned" (E2).
- [ ] Assigning an already-assigned device returns a 409 naming its current zone, on both sides, and the modal shows the name rather than `zone ""` (C6, E7).
- [ ] A foreign zone's history renders for both accounts; a journal entry from another account is readable (W1, W2).
- [ ] The viewer is denied one write per surface — zone config, device flag, assign — and the researcher is denied a write on an ungranted zone.
- [ ] Gateway history, `/api/sync/state` and `/api/users` still reject the non-admin accounts (P2), **and a card-preference PUT on a gateway route is rejected for a viewer** (E4).
- [ ] The admin menu appears for an admin on the cross-zone analysis page (E8).
- [ ] Every string in the New device tab renders in the account's language, `lg` included (C3, E10).
- [ ] A STREGA action from the deployed cloud reaches the valve rather than being NACKed (X6).
- [ ] Silvan, kaba100 and Uganda behave exactly as before: no zone honored on a REGISTER_DEVICE, no new ACK fields, weather stations on their zone cards (E5, E2).

Record the result per line. A line that could not be exercised is not a pass — say which and why. If anything fails, the fix goes back into the phase that owns it and the walkthrough re-runs from the top.
