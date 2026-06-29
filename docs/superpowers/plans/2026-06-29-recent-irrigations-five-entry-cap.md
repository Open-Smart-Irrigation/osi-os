# Recent Irrigations Five-Entry Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit the edge GUI Recent irrigations card to the five newest actuation rows.

**Architecture:** Keep the local Node-RED `/api/irrigation/recent-actuations` endpoint unchanged at its current 50-row response limit. Derive a capped display list in `IrrigationOutcomesPanel` and render compact and advanced views from that list.

**Tech Stack:** React 18, TypeScript, i18next, `node:test`, `@testing-library/react`, Vite.

---

### Task 1: Add Failing Render-Cap Tests

**Files:**
- Modify: `web/react-gui/tests/irrigationOutcomesPanel.test.ts`

- [ ] **Step 1: Add a multi-actuation fixture helper**

Insert this helper after `responseWithActuation`:

```ts
function responseWithActuations(count: number): IrrigationActuationsResponse {
  return {
    generatedAt: '2026-05-29T10:20:00Z',
    actuations: Array.from({ length: count }, (_, index) => actuationFixture({
      expectationId: `exp-${index + 1}`,
      commandId: `cmd-uuid-${index + 1}`,
      deviceEui: `70B3D57708000${String(index + 1).padStart(3, '0')}`,
      deviceName: `Valve ${index + 1}`,
      zoneId: 12,
      zoneName: `Zone ${index + 1}`,
      commandedAt: new Date(Date.parse('2026-05-29T10:20:00Z') - index * 60_000).toISOString(),
    })),
  };
}
```

- [ ] **Step 2: Add compact-view cap test**

Insert this test after `default view shows commanded date, duration, and effective irrigation depth`:

```ts
test('default view renders only the five newest recent irrigations', async () => {
  window.localStorage.clear();
  try {
    await renderControlledPanel(responseWithActuations(7));

    for (let i = 1; i <= 5; i += 1) {
      assert.match(document.body.textContent ?? '', new RegExp(`Zone ${i}(?!\\d)`));
    }
    assert.doesNotMatch(document.body.textContent ?? '', /Zone 6(?!\d)/);
    assert.doesNotMatch(document.body.textContent ?? '', /Zone 7(?!\d)/);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 3: Add advanced-view cap test**

Insert this test after `advanced view shows status, total volume, depth, and confirmed timestamps`:

```ts
test('advanced view renders only the five newest recent irrigations', async () => {
  window.localStorage.setItem('osi.recentIrrigations.advancedView', 'true');
  try {
    await renderControlledPanel(responseWithActuations(7));

    for (let i = 1; i <= 5; i += 1) {
      assert.match(document.body.textContent ?? '', new RegExp(`Zone ${i}(?!\\d)`));
      assert.match(document.body.textContent ?? '', new RegExp(`Valve ${i}(?!\\d)`));
    }
    assert.doesNotMatch(document.body.textContent ?? '', /Zone 6(?!\d)/);
    assert.doesNotMatch(document.body.textContent ?? '', /Valve 6(?!\d)/);
    assert.doesNotMatch(document.body.textContent ?? '', /Zone 7(?!\d)/);
    assert.doesNotMatch(document.body.textContent ?? '', /Valve 7(?!\d)/);
  } finally {
    cleanup();
    window.localStorage.clear();
  }
});
```

- [ ] **Step 4: Run tests and verify RED**

Run:

```bash
cd web/react-gui && npm run test:unit:tsx-runner -- tests/irrigationOutcomesPanel.test.ts
```

Expected result: the new compact and advanced cap tests fail because `Zone 6` / `Valve 6` still render.

### Task 2: Add Minimal Display Cap

**Files:**
- Modify: `web/react-gui/src/components/farming/IrrigationOutcomesPanel.tsx`

- [ ] **Step 1: Add a named cap constant**

Insert after `ADVANCED_VIEW_STORAGE_KEY`:

```ts
const RECENT_IRRIGATION_DISPLAY_LIMIT = 5;
```

- [ ] **Step 2: Derive a capped display list**

Insert after `viewState` is computed:

```ts
  const displayActuations = viewState.actuations.slice(0, RECENT_IRRIGATION_DISPLAY_LIMIT);
```

- [ ] **Step 3: Render from the capped list**

Replace the empty/list condition block with:

```tsx
      {!viewState.loading && !viewState.error && displayActuations.length === 0 && (
        <p className="text-sm text-[var(--text-tertiary)]">
          {t('irrigationOutcomes.empty', { defaultValue: 'No recent irrigations recorded yet.' })}
        </p>
      )}

      {displayActuations.length > 0 && (
        <ul className="flex flex-col gap-2">
          {displayActuations.map((row) => {
            const zoneContext = zoneContextFor(row);
            return advancedView ? (
              <AdvancedActuationRow key={row.expectationId} row={row} zoneContext={zoneContext} />
            ) : (
              <CompactActuationRow key={row.expectationId} row={row} zoneContext={zoneContext} />
            );
          })}
        </ul>
      )}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd web/react-gui && npm run test:unit:tsx-runner -- tests/irrigationOutcomesPanel.test.ts
```

Expected result: all tests pass.

### Task 3: Verify, Review, And Deploy

**Files:**
- No code changes unless review finds an issue.

- [ ] **Step 1: Run local verification**

Run:

```bash
cd web/react-gui && npm run test:unit
cd web/react-gui && npm run build
git diff --check
```

Expected result: all commands exit 0.

- [ ] **Step 2: Self-review changed files**

Check:

```bash
git diff -- web/react-gui/src/components/farming/IrrigationOutcomesPanel.tsx web/react-gui/tests/irrigationOutcomesPanel.test.ts
```

Expected result: only the display cap and its tests changed; no API, schema, translation, or profile files changed.

- [ ] **Step 3: Deploy to reachable gateways**

Use the existing deploy workflow from this worktree after building `web/react-gui/build`. Preserve the live DB and create runtime backups according to `AGENTS.md`.

Targets:

- Kaba100
- Silvan, if reachable
- Uganda, if reachable

- [ ] **Step 4: Verify deployed gateways**

For each reachable gateway, check the GUI is served successfully, Node-RED is running, the deployed GUI artifacts match the local build, the deployed bundle contains the five-entry display cap, and the live database passes `PRAGMA quick_check`. If authenticated local API access is available, inspect `/api/irrigation/recent-actuations`; otherwise verify the served GUI artifact and runtime health without modifying live data.

## Plan Self-Review

- Spec coverage: cap behavior, compact view, advanced view, unchanged states, unchanged API, and deploy verification are covered.
- Placeholder scan: no TBD/TODO/later placeholders.
- Type consistency: tests use the existing `IrrigationActuation` and `IrrigationActuationsResponse` types; implementation uses the existing `viewState.actuations` array.
