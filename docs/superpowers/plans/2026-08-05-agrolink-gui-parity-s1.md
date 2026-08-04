# AgroLink GUI Parity — Slice S1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the cloud zones, schedules and irrigation-calibration pages to cohesion parity with the edge GUI: gateway-scoped rendering (D3), capability-gated mutations (D4), fail-closed write access (D5), first real consumers for the ui-core primitives on both sides, and the two edge dark-on-dark hover fixes carried over from the S0 close-out.

**Architecture:** The cloud already has substantial zone/schedule/calibration implementations (matrix rows verified `partial`); S1 closes gaps on those existing pages instead of building new ones. Cloud mutations already ride the versioned-command surfaces in `frontend/src/services/api.ts` (`irrigationZonesAPI.create/delete/assignDevice/removeDevice/updateSchedule/updateCalibration/updateConfig`), and every response is normalised into a `DesiredStateOperation` whose `pending/acknowledged/applied/conflicted/rejected/expired/superseded` status the existing `PendingStateNotice` component renders for zones, schedules and calibration. S1 adds what is missing around that core: the S1 pages consume `useGateway()` for scoping and capability flags, a `GatewayScopeBanner` ports the edge `ScopeStatusBanner` fail-closed pattern, and both GUIs' S1 pages begin importing the ui-core primitives (`Surface`/`Button`/`Modal`/`FormField`/`EmptyState`/`Banner`) that S0 extracted.

**Tech Stack:** React 18, TypeScript, Tailwind v4 (edge, CSS-first) / Tailwind v3.4 (cloud, `presets`), Vite 5, Vitest + `tsx --test` runners in both repos, POSIX `sh` vendor verifiers.

**Working directories (both checkouts are on branch `AgroLink`):**
- Edge (canonical): `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep` — GUI at `web/react-gui/`
- Cloud (vendored): `/home/phil/Repos/osi-server/.worktrees/agrolink` — GUI at `frontend/`
- Never touch `/home/phil/Repos/osi-server/.worktrees/terra-rehaul-*` or `/home/phil/Repos/osi-os/.worktrees/firmware-image-builder`.

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md`; every task's requirements implicitly include these.

- S1 scope row: "Zones, schedules, irrigation calibration — Mutations issue the existing versioned commands; conflict/rejection surfacing mirrors edge patterns."
- "The edge stays canonical for farm state. Every cloud mutation rides the existing versioned-command and sync layer; this program adds no new sync surface."
- "Gateway context, not gateway chrome: one linked gateway means no selector anywhere; multiple linked gateways are switched on the Settings page" (D3).
- "Capability-gated rendering — A page renders only what the selected gateway's capability handshake advertises; older gateways get an explicit 'not available on this gateway' state, never a broken page" (D4).
- "Fail-closed scope UX ported from edge — The cloud pages adopt the edge `ScopeContext` pattern (deny-while-loading, closed scope on profile-fetch failure) mapped to the cloud's 403-on-dormant convention" (D5).
- "Cohesion beats replication: cloud pages may deviate slightly from the edge design where that produces a more cohesive look across the cloud app … Token and primitive parity (ui-core) still binds; the freedom is at page composition level" (D7).
- "`ui-core` canonical in osi-os, byte-mirrored to osi-server, CI-gated both sides" (D2). The vendor byte-parity gate (`scripts/verify-ui-core-vendor.sh`, both repos) must stay green after every task: any ui-core change lands canonical-first in osi-os and is re-vendored to osi-server **in the same task**, never split across tasks.
- "Eight primitives, no more: glass surface/card, button, chip/badge, modal, banner, form field, table shell, empty state." — "A primitive is admitted to `ui-core` only when both GUIs use it; single-sided components stay local." S1 adds **zero** new primitives.
- "This program works on the `AgroLink` branches only and does not modify Terra files; if a slice needs a file Terra also touches, the slice waits."
- "all GUI-parity work lands on the same pair of `AgroLink` branches, keeping the deploy-from-branch model intact".
- Matrix rule: rows may flip toward `parity` "only after a real side-by-side walkthrough against the edge GUI running on `agrolink-test-01`". This plan runs no walkthrough, so every row it touches ends at `partial (pending walkthrough)` with a dated provenance line.

Plan-level readings of the spec, applied throughout (each is a resolved ambiguity):

1. **Edge changes are in scope.** S0's bundle-parity one-shot has passed and is not re-run; S1 edge changes (the two hover fixes, ui-core adoption in S1-scope files) go through the normal test suite and review, per the S0 close-out.
2. **aria-live on ui-core `Banner`.** The S0 close-out requires restoring explicit `aria-live="polite"` when a banner migrates onto the primitive. `Banner` renders `role="status"` for warn/success and `role="alert"` for errors; the change adds `aria-live="polite"` to status banners and `aria-live="assertive"` to alert banners, so the error tone is not downgraded from its implicit assertive politeness level.
3. **Capability flag mapping (D4).** Zone, schedule and calibration mutations ride the desired-state command overlay, so `LinkedGatewaySummary.zoneDesiredStateSupported` is the S1 capability gate. A gateway that does not advertise it gets the explicit `zone.notAvailableOnGateway` state in place of mutation controls.
4. **Write authority (D5).** `LinkedGatewaySummary.gatewayRole === 'viewer'` means read-only (mirror of the edge `canWrite = role !== 'viewer'`); a null/absent `gatewayRole` is the owner account and may write. While the gateway context is loading or failed, writes are denied and `GatewayScopeBanner` offers retry: deny-while-loading, closed on failure.
5. **Cloud-local accounts stay functional.** An account with zero linked gateways (resolved, no error) has no gateway to scope by: its zones stay visible and writable, and `CreateZoneModal` keeps its create-without-gateway path. Fail-closed applies to *unresolved* state, not to the legitimate zero-gateway state.
6. **D3 kills the in-modal gateway selector.** The cloud `CreateZoneModal` currently fetches linked gateways itself and renders a `<select>`. Under "no selector anywhere", zones are created on the active gateway; the modal shows the target EUI read-only and points at the Settings page for switching.
7. **Zone and device visibility on linked accounts.** A zone whose `gatewayDeviceEui` is null (cloud-local) stays visible; a non-null EUI must match `activeGateway.gatewayDeviceEui`. Cloud `Device` rows carry no gateway EUI (verified against `types/farming.ts`), so devices scope through membership: a device inside a hidden zone is dropped (the edge `FarmingDashboard` `visibleZoneIds` behavior), a `GATEWAY`-type row scopes by its own `deviceEui`, and unassigned devices stay visible so they can be assigned.
8. **`PendingStateNotice` stays cloud-local.** The edge GUI mutates canonical state directly and has no desired-state overlay, so the notice has one consumer and the two-consumer admission rule keeps it out of ui-core.
9. **`Modal`'s default `closeLabel` stays `'Close'`.** Neither repo's `common.json` has a `close` key; adding one across 7 locales is out of S1 scope. Recorded as a walkthrough note, not silently shipped as done.
10. **Cloud `ZoneConfigModal` keeps its own markup.** It is a single-sided 829-line modal with a denser field treatment than `INPUT_CLASS`; forcing the edge input scale into it would hurt cohesion (D7). S1 gates access to it at the zone card and leaves its internals alone; the calibration save flow inside it already submits through `irrigationZonesAPI.updateCalibration` and renders `PendingStateNotice`.

## Versioned-command surfaces (reference, verified 2026-08-05)

All in `/home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/services/api.ts`:

| Mutation | Call | Endpoint |
|---|---|---|
| Zone create | `irrigationZonesAPI.create` | `POST /api/v1/irrigation-zones` |
| Zone delete | `irrigationZonesAPI.delete` | `DELETE /api/v1/irrigation-zones/{id}` |
| Device assign/remove | `irrigationZonesAPI.assignDevice` / `removeDevice` | `PUT`/`DELETE /api/v1/irrigation-zones/{id}/devices/{eui}` |
| Schedule save | `irrigationZonesAPI.updateSchedule` | `PUT /api/v1/irrigation-zones/{id}/schedule` |
| Calibration save | `irrigationZonesAPI.updateCalibration` | `POST /api/v1/irrigation-zones/{id}/calibration` |
| Zone config save | `irrigationZonesAPI.updateConfig` | `PUT /api/v1/irrigation-zones/{id}/config` |
| Zone location | `irrigationZonesAPI.setZoneLocation` | `PUT /api/v1/irrigation-zones/{id}/location` |

`normaliseZone`, `normaliseSchedule` and `normaliseIrrigationCalibration` each attach a `desiredState: DesiredStateOperation | null` (`types/desiredState.ts`) carrying `baseSyncVersion`/`targetSyncVersion`, `rejectionCode`, `rejectionDetail`. `PendingStateNotice` (`components/sync/PendingStateNotice.tsx`) renders every non-`applied` status with a retry hook; it is already mounted for the zone (`IrrigationZoneCard.tsx:239`), the schedule (`ScheduleSection.tsx:425`) and calibration (`ZoneConfigModal.tsx`, `calibrationOperation` state). S1 changes none of these calls.

## File map

| File | Repo | Task |
|---|---|---|
| `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` (hover fix), `SystemPanel.tsx` (hover fix), `tests/errorButtonHover.test.ts` | osi-os | T1 |
| `web/react-gui/src/ui-core/Banner.tsx`, `ui-core/__tests__/feedback.test.tsx`; re-vendored `frontend/src/ui-core/**` | both | T2 |
| `web/react-gui/src/components/ScopeStatusBanner.tsx`, `components/__tests__/ScopeStatusBanner.test.tsx` | osi-os | T3 |
| `frontend/src/contexts/gatewayCapabilities.ts` + test, `components/GatewayScopeBanner.tsx` + test, 7× `public/locales/*/common.json`, `tests/gatewayScopeLocales.test.ts` | osi-server | T4 |
| `frontend/src/components/farming/IrrigationZoneCard.tsx` (gating), `__tests__/IrrigationZoneCard.capabilities.test.tsx`, 7× `public/locales/*/devices.json`, `tests/zoneGatingLocales.test.ts` | osi-server | T5 |
| `frontend/src/pages/Dashboard.tsx`, `pages/__tests__/Dashboard.gatewayScope.test.tsx` | osi-server | T6 |
| `frontend/src/components/farming/IrrigationZoneCard.tsx` (cohesion), `tests/zoneCardCohesion.test.ts` | osi-server | T7 |
| `frontend/src/components/farming/CreateZoneModal.tsx`, `__tests__/CreateZoneModal.gateway.test.tsx`, 7× `public/locales/*/devices.json` | osi-server | T8 |
| `web/react-gui/src/components/farming/CreateZoneModal.tsx`, `__tests__/CreateZoneModal.uicore.test.tsx` | osi-os | T9 |
| `web/react-gui/src/pages/FarmingDashboard.tsx`, `tests/farmingDashboardUiCore.test.ts` | osi-os | T10 |
| `docs/superpowers/plans/agrolink-gui-parity-matrix.md` | osi-os | T11 |
| (verification only) | both | T12 |

---

### Task 1: Fix the two edge dark-on-dark error-button hovers

Carried from the S0 close-out. The S0 `--error-bg` token fix made the light theme's error background a light wash (`#FEE2E2`), so the two edge buttons that still declare `hover:bg-red-700` now flip from a light wash to dark red under a dark-red text color on hover. The cloud twins already use `hover:opacity-90` (`frontend/src/pages/Dashboard.tsx:128`, `frontend/src/components/farming/IrrigationZoneCard.tsx:375`); the edge adopts the same treatment. `src/pages/AccountLink.tsx:368` also uses `hover:bg-red-700`, but over `bg-red-600 text-white`, which stays readable; the guard test therefore forbids only the pairing with `var(--error-bg)`.

**Files:**
- Modify: `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`, `web/react-gui/src/components/farming/SystemPanel.tsx`
- Test: `web/react-gui/tests/errorButtonHover.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo-wide guard against reintroducing the `bg-[var(--error-bg)]` + `hover:bg-red-700` pairing.

- [ ] **Step 1: Write the failing guard test**

Create `web/react-gui/tests/errorButtonHover.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no class string pairs bg-[var(--error-bg)] with hover:bg-red-700', () => {
  const offenders: string[] = [];
  for (const filePath of listSourceFiles(srcRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(/className="([^"]*)"/g)) {
      if (match[1].includes('bg-[var(--error-bg)]') && match[1].includes('hover:bg-red-700')) {
        offenders.push(path.relative(srcRoot, filePath));
      }
    }
  }
  assert.deepEqual(offenders, []);
});
```

(Both offenders use plain string `className` attributes, so the literal regex reaches them.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/errorButtonHover.test.ts
```

Expected: FAIL listing `components/farming/IrrigationZoneCard.tsx` and `components/farming/SystemPanel.tsx`.

- [ ] **Step 3: Apply the two fixes**

In `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` (line 243), change the delete-zone button class:

```
- className="touch-target bg-[var(--error-bg)] hover:bg-red-700 disabled:bg-[var(--border)] text-[var(--error-text)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
+ className="touch-target bg-[var(--error-bg)] hover:opacity-90 disabled:bg-[var(--border)] text-[var(--error-text)] px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
```

In `web/react-gui/src/components/farming/SystemPanel.tsx` (line 221), change the reboot-confirm button class:

```
- className="bg-[var(--error-bg)] hover:bg-red-700 text-[var(--error-text)] font-bold px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center gap-2"
+ className="bg-[var(--error-bg)] hover:opacity-90 text-[var(--error-text)] font-bold px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center gap-2"
```

- [ ] **Step 4: Run the test and targeted checks**

```bash
npx tsx --test tests/errorButtonHover.test.ts && npm run typecheck
npx vitest run src/components/farming/__tests__/IrrigationZoneCardData.test.tsx
```

Expected: guard PASS, typecheck clean, existing zone-card tests green.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/components/farming/IrrigationZoneCard.tsx web/react-gui/src/components/farming/SystemPanel.tsx web/react-gui/tests/errorButtonHover.test.ts
git commit -m "fix: error-token buttons hover via opacity, not red-700 (S1 twin fix)"
```

---

### Task 2: ui-core `Banner` gains explicit `aria-live` (canonical + re-vendor, one task)

The S0 close-out mandate: when any banner migrates onto ui-core `Banner`, the explicit `aria-live="polite"` must be restored. T3 (edge `ScopeStatusBanner`) and T4 (cloud `GatewayScopeBanner`) both land on the primitive, so the attribute goes in first. Status tones get `polite`; the error tone keeps assertive announcement by declaring it explicitly (plan-level reading 2).

**Files:**
- Modify (osi-os, canonical): `web/react-gui/src/ui-core/Banner.tsx`, `web/react-gui/src/ui-core/__tests__/feedback.test.tsx`
- Re-vendor (osi-server): `frontend/src/ui-core/Banner.tsx`, `frontend/src/ui-core/__tests__/feedback.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Banner` renders `aria-live="polite"` (`role="status"`) or `aria-live="assertive"` (`role="alert"`); T3/T4 rely on it.

- [ ] **Step 1: Extend the canonical test (fails first)**

In `web/react-gui/src/ui-core/__tests__/feedback.test.tsx`, append inside `describe('Banner', …)` after the `tone="error"` test:

```tsx
  it('declares its politeness level explicitly', () => {
    render(<Banner>Restarting</Banner>);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    cleanup();
    render(<Banner tone="error">Failed</Banner>);
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('assertive');
  });
```

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx vitest run src/ui-core/__tests__/feedback.test.tsx
```

Expected: FAIL — `aria-live` is null.

- [ ] **Step 2: Implement in the canonical `Banner`**

In `web/react-gui/src/ui-core/Banner.tsx`, change the render to:

```tsx
export function Banner({ tone = 'warn', className = '', children }: BannerProps) {
  const role = tone === 'error' ? 'alert' : 'status';
  return (
    <div
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
      className={`border-b px-4 py-3 text-center text-sm font-semibold ${TONE_CLASSES[tone]} ${className}`.trim()}
    >
      {children}
    </div>
  );
}
```

Run the test again — expected PASS — then `npm run typecheck`.

- [ ] **Step 3: Re-vendor to osi-server and verify byte parity both ways**

```bash
rsync -a --delete /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/ui-core/ /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core/
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh
cd /home/phil/Repos/osi-server/.worktrees/agrolink
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
cd frontend && npx vitest run --environment jsdom src/ui-core/__tests__/feedback.test.tsx
```

Expected: `verify-ui-core-vendor: OK` twice; the vendored test passes in the cloud runner.

- [ ] **Step 4: Commit both repos**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/ui-core/Banner.tsx web/react-gui/src/ui-core/__tests__/feedback.test.tsx
git commit -m "feat: ui-core Banner declares aria-live explicitly (S0 close-out mandate)"
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/ui-core/Banner.tsx frontend/src/ui-core/__tests__/feedback.test.tsx
git commit -m "chore: re-vendor ui-core (Banner aria-live)"
```

---

### Task 3: Edge `ScopeStatusBanner` migrates onto ui-core `Banner`

The current banner styles itself with `--danger-bg`/`--danger-text`/`--danger-border`, three names `tokens.css` never defines (noted and deferred in S0 T1), so today it renders with an unset background. Migrating onto `Banner tone="error"` styles it from the defined `--error-*`/`--danger-fg` tokens, gives the edge its first Banner consumer (the cloud's arrives in T4, satisfying the two-consumer rule), and picks up T2's explicit `aria-live`. Behavior (mounted in `App.tsx`, `role="alert"`, retry button) is unchanged; the existing test proves it.

**Files:**
- Modify: `web/react-gui/src/components/ScopeStatusBanner.tsx`, `web/react-gui/src/components/__tests__/ScopeStatusBanner.test.tsx`

**Interfaces:**
- Consumes: `Banner` from `../ui-core` (T2), `useScope()` unchanged.
- Produces: no API change; the component keeps its name and props (none).

- [ ] **Step 1: Extend the existing test (fails first)**

In `web/react-gui/src/components/__tests__/ScopeStatusBanner.test.tsx`, replace the line

```tsx
    expect(await screen.findByRole('alert')).toHaveTextContent('Permissions could not be loaded.');
```

with:

```tsx
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Permissions could not be loaded.');
    expect(alert.className).toContain('bg-[var(--error-bg)]');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
```

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx vitest run src/components/__tests__/ScopeStatusBanner.test.tsx
```

Expected: FAIL — the class contains `bg-[var(--danger-bg)]`, not `bg-[var(--error-bg)]`.

- [ ] **Step 2: Migrate the component**

Replace `web/react-gui/src/components/ScopeStatusBanner.tsx` in full with:

```tsx
import { useTranslation } from 'react-i18next';
import { useScope } from '../contexts/ScopeContext';
import { Banner } from '../ui-core';

export function ScopeStatusBanner() {
  const { t } = useTranslation('common');
  const { error, retry } = useScope();

  if (!error) return null;

  return (
    <Banner tone="error" className="flex items-center justify-center gap-3">
      <span>{t('scope.loadError')}</span>
      <button
        type="button"
        className="rounded border border-current px-3 py-1 hover:bg-black/5"
        onClick={retry}
      >
        {t('retry')}
      </button>
    </Banner>
  );
}
```

- [ ] **Step 3: Verify no undefined danger tokens remain**

```bash
npx vitest run src/components/__tests__/ScopeStatusBanner.test.tsx
grep -rn -- "--danger-bg\|--danger-text\|--danger-border" src
npm run typecheck
```

Expected: test PASS; the grep prints nothing (this file was the only consumer of the undefined names); typecheck clean.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/components/ScopeStatusBanner.tsx web/react-gui/src/components/__tests__/ScopeStatusBanner.test.tsx
git commit -m "feat: edge ScopeStatusBanner on ui-core Banner (defined error tokens)"
```

---

### Task 4: Cloud capability helpers + `GatewayScopeBanner` (D4/D5) + locale keys

Three pure functions encode the D4/D5 semantics once (plan-level readings 3–5, 7) so pages do not re-derive them, and a `GatewayScopeBanner` ports the edge `ScopeStatusBanner` onto `useGateway()`: same layout, ui-core `Banner`, retry wired to the provider's `retry()`.

**Files:**
- Create: `frontend/src/contexts/gatewayCapabilities.ts`, `frontend/src/contexts/__tests__/gatewayCapabilities.test.ts`, `frontend/src/components/GatewayScopeBanner.tsx`, `frontend/src/components/__tests__/GatewayScopeBanner.test.tsx`, `frontend/tests/gatewayScopeLocales.test.ts`
- Modify: `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/common.json`

**Interfaces:**
- Consumes: `GatewayContextValue` from T8/S0 (`contexts/GatewayContext.tsx`), `Banner` from `../ui-core`.
- Produces (T5, T6, T8 depend on these exact names):

```ts
export type GatewayScopeState = Pick<GatewayContextValue, 'loading' | 'error' | 'gateways' | 'activeGateway'>;
export function canWriteZones(state: GatewayScopeState): boolean;
export function zoneMutationsSupported(state: GatewayScopeState): boolean;
export function visibleOnActiveGateway(state: GatewayScopeState, gatewayDeviceEui: string | null | undefined): boolean;
export function GatewayScopeBanner(): JSX.Element | null;
```

plus the locale key `common:gatewayScope.loadError`.

- [ ] **Step 1: Write the failing helper test**

Create `frontend/src/contexts/__tests__/gatewayCapabilities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { LinkedGatewaySummary } from '../../types/farming';
import { canWriteZones, visibleOnActiveGateway, zoneMutationsSupported } from '../gatewayCapabilities';

function summary(overrides: Partial<LinkedGatewaySummary> = {}): LinkedGatewaySummary {
  return {
    gatewayDeviceEui: 'EUI-A',
    offlineVerifierVersion: 1,
    authSyncStatus: 'SYNCED',
    linkedAuthSyncSupported: true,
    forceEdgeSyncSupported: true,
    fieldJournalSupported: true,
    scopedAccessSyncSupported: true,
    scopedAccessCommandsSupported: true,
    zoneDesiredStateSupported: true,
    ...overrides,
  };
}

function state(gateways: LinkedGatewaySummary[], overrides = {}) {
  return {
    loading: false,
    error: null as string | null,
    gateways,
    activeGateway: gateways[0] ?? null,
    ...overrides,
  };
}

describe('canWriteZones (D5)', () => {
  it('denies while the gateway context is loading', () => {
    expect(canWriteZones(state([], { loading: true }))).toBe(false);
  });
  it('denies when the linked-gateway fetch failed', () => {
    expect(canWriteZones(state([], { error: 'linked_gateways_unavailable' }))).toBe(false);
  });
  it('allows cloud-local accounts with zero linked gateways', () => {
    expect(canWriteZones(state([]))).toBe(true);
  });
  it('denies a viewer grant and allows owner and researcher', () => {
    expect(canWriteZones(state([summary({ gatewayRole: 'viewer' })]))).toBe(false);
    expect(canWriteZones(state([summary({ gatewayRole: 'researcher' })]))).toBe(true);
    expect(canWriteZones(state([summary()]))).toBe(true);
  });
});

describe('zoneMutationsSupported (D4)', () => {
  it('follows zoneDesiredStateSupported on the active gateway', () => {
    expect(zoneMutationsSupported(state([summary()]))).toBe(true);
    expect(zoneMutationsSupported(state([summary({ zoneDesiredStateSupported: false })]))).toBe(false);
  });
  it('treats cloud-local accounts as supported and unresolved state as not', () => {
    expect(zoneMutationsSupported(state([]))).toBe(true);
    expect(zoneMutationsSupported(state([summary()], { loading: true }))).toBe(false);
  });
});

describe('visibleOnActiveGateway (D3)', () => {
  const linked = state([summary(), summary({ gatewayDeviceEui: 'EUI-B' })]);
  it('shows rows on the active gateway and cloud-local rows', () => {
    expect(visibleOnActiveGateway(linked, 'EUI-A')).toBe(true);
    expect(visibleOnActiveGateway(linked, null)).toBe(true);
    expect(visibleOnActiveGateway(linked, undefined)).toBe(true);
  });
  it('hides rows scoped to another linked gateway', () => {
    expect(visibleOnActiveGateway(linked, 'EUI-B')).toBe(false);
  });
  it('shows everything on cloud-local accounts and nothing while unresolved', () => {
    expect(visibleOnActiveGateway(state([]), 'EUI-A')).toBe(true);
    expect(visibleOnActiveGateway(state([summary()], { error: 'linked_gateways_unavailable' }), 'EUI-A')).toBe(false);
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/contexts/__tests__/gatewayCapabilities.test.ts
```

Expected: FAIL — cannot resolve `../gatewayCapabilities`.

- [ ] **Step 2: Implement the helpers**

Create `frontend/src/contexts/gatewayCapabilities.ts`:

```ts
import type { GatewayContextValue } from './GatewayContext';

export type GatewayScopeState = Pick<
  GatewayContextValue,
  'loading' | 'error' | 'gateways' | 'activeGateway'
>;

/**
 * Write authority for zone/schedule/calibration mutations (D5, fail-closed):
 * denied while the linked-gateway list is loading or failed; a 'viewer'
 * grant is read-only; a null/absent gatewayRole is the owner account.
 * Accounts with zero linked gateways run cloud-local and stay writable.
 */
export function canWriteZones(state: GatewayScopeState): boolean {
  if (state.loading || state.error !== null) return false;
  if (state.gateways.length === 0) return true;
  if (!state.activeGateway) return false;
  return state.activeGateway.gatewayRole !== 'viewer';
}

/**
 * Capability gate (D4): zone, schedule and calibration mutations ride the
 * desired-state command overlay, so a gateway that does not advertise
 * zoneDesiredStateSupported gets the explicit not-available state instead
 * of mutation controls. Cloud-local accounts mutate cloud rows directly.
 */
export function zoneMutationsSupported(state: GatewayScopeState): boolean {
  if (state.loading || state.error !== null) return false;
  if (state.gateways.length === 0) return true;
  return state.activeGateway?.zoneDesiredStateSupported === true;
}

/**
 * D3 scoping: a row belongs on the page when it targets the active gateway
 * or carries no gateway at all (cloud-local rows). Unresolved context shows
 * nothing (deny-while-loading).
 */
export function visibleOnActiveGateway(
  state: GatewayScopeState,
  gatewayDeviceEui: string | null | undefined,
): boolean {
  if (state.loading || state.error !== null) return false;
  if (state.gateways.length === 0) return true;
  if (!state.activeGateway) return false;
  return gatewayDeviceEui == null
    || gatewayDeviceEui === state.activeGateway.gatewayDeviceEui;
}
```

Run the helper test — expected PASS (10 tests).

- [ ] **Step 3: Write the failing banner test**

Create `frontend/src/components/__tests__/GatewayScopeBanner.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGateway } from '../../contexts/GatewayContext';
import { GatewayScopeBanner } from '../GatewayScopeBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../contexts/GatewayContext', () => ({ useGateway: vi.fn() }));

function scope(overrides = {}) {
  return {
    loading: false,
    error: null as string | null,
    gateways: [],
    activeGateway: null,
    hasMultipleGateways: false,
    selectGateway: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

describe('GatewayScopeBanner (D5)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders nothing while the context is healthy', () => {
    vi.mocked(useGateway).mockReturnValue(scope());
    const { container } = render(<GatewayScopeBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('announces a failed lookup on error tokens and retries through the provider', () => {
    const state = scope({ error: 'linked_gateways_unavailable' });
    vi.mocked(useGateway).mockReturnValue(state);
    render(<GatewayScopeBanner />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('gatewayScope.loadError');
    expect(alert.className).toContain('bg-[var(--error-bg)]');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(state.retry).toHaveBeenCalledTimes(1);
  });
});
```

Run:

```bash
npx vitest run --environment jsdom src/components/__tests__/GatewayScopeBanner.test.tsx
```

Expected: FAIL — cannot resolve `../GatewayScopeBanner`.

- [ ] **Step 4: Implement the banner**

Create `frontend/src/components/GatewayScopeBanner.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { useGateway } from '../contexts/GatewayContext';
import { Banner } from '../ui-core';

export function GatewayScopeBanner() {
  const { t } = useTranslation('common');
  const { error, retry } = useGateway();

  if (!error) return null;

  return (
    <Banner tone="error" className="flex items-center justify-center gap-3">
      <span>{t('gatewayScope.loadError')}</span>
      <button
        type="button"
        className="rounded border border-current px-3 py-1 hover:bg-black/5"
        onClick={retry}
      >
        {t('retry')}
      </button>
    </Banner>
  );
}
```

Run the banner test — expected PASS (2 tests).

- [ ] **Step 5: Locale keys + locale test**

Create `frontend/tests/gatewayScopeLocales.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const frontendRoot = path.resolve(import.meta.dirname, '..');
const LOCALES = ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt'];

test('every locale carries the gateway-scope banner key', () => {
  for (const locale of LOCALES) {
    const common = JSON.parse(
      fs.readFileSync(path.join(frontendRoot, `public/locales/${locale}/common.json`), 'utf8'),
    );
    assert.equal(typeof common.gatewayScope?.loadError, 'string', `${locale} common.gatewayScope.loadError`);
    assert.notEqual(common.gatewayScope.loadError.trim(), '', `${locale} common.gatewayScope.loadError`);
  }
});
```

Run `npx tsx --test tests/gatewayScopeLocales.test.ts` (expected: FAIL). Then add to each locale's `common.json` a `gatewayScope` object (the existing `retry` key is reused; `lg` is a machine draft pending the human-native pass that gates Uganda):

| Locale | gatewayScope.loadError |
|---|---|
| en | Linked gateways could not be loaded. Zone editing stays locked until they load. |
| de-CH | Verknüpfte Gateways konnten nicht geladen werden. Die Zonenbearbeitung bleibt gesperrt, bis sie geladen sind. |
| fr | Impossible de charger les gateways liés. La modification des zones reste verrouillée jusqu'à leur chargement. |
| it | Impossibile caricare i gateway collegati. La modifica delle zone resta bloccata finché non vengono caricati. |
| es | No se pudieron cargar los gateways vinculados. La edición de zonas queda bloqueada hasta que se carguen. |
| pt | Não foi possível carregar os gateways ligados. A edição de zonas fica bloqueada até serem carregados. |
| lg | Gateway ezigattiddwa tezisobose kutikka. Okukyusa ebitundu kusibiddwa okutuusa nga zitikkiddwa. |

JSON shape per file: `"gatewayScope": { "loadError": "…" }` as a new top-level key.

- [ ] **Step 6: Run all task tests and the cloud suite**

```bash
npx vitest run --environment jsdom src/contexts/__tests__/gatewayCapabilities.test.ts src/components/__tests__/GatewayScopeBanner.test.tsx
npx tsx --test tests/gatewayScopeLocales.test.ts
npm run test:unit
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/contexts/gatewayCapabilities.ts frontend/src/contexts/__tests__/gatewayCapabilities.test.ts frontend/src/components/GatewayScopeBanner.tsx frontend/src/components/__tests__/GatewayScopeBanner.test.tsx frontend/tests/gatewayScopeLocales.test.ts frontend/public/locales/de-CH/common.json frontend/public/locales/en/common.json frontend/public/locales/es/common.json frontend/public/locales/fr/common.json frontend/public/locales/it/common.json frontend/public/locales/lg/common.json frontend/public/locales/pt/common.json
git commit -m "feat: gateway capability helpers + GatewayScopeBanner (D4/D5)"
```

---

### Task 5: Cloud `IrrigationZoneCard` write and capability gating

The edge card takes `canWrite` from the page and gates every mutation control and modal on it; the cloud card has no gating at all. This task adds `canWrite` and `mutationsSupported` props (default `true`, so all existing call sites and tests keep their behavior until T6 wires real values), the D4 not-available state, and gates the same surfaces the edge gates: header buttons, delete confirm, `ScheduleSection` mount, the empty-devices assign button, `PendingStateNotice` retry, and the three modals.

**Files:**
- Modify: `frontend/src/components/farming/IrrigationZoneCard.tsx`, `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/devices.json`
- Create: `frontend/src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx`, `frontend/tests/zoneGatingLocales.test.ts`

**Interfaces:**
- Consumes: nothing new (props are plain booleans; T6 supplies them from the T4 helpers).
- Produces:

```ts
interface IrrigationZoneCardProps {
  zone: IrrigationZone;
  devices: Device[];
  unassignedDevices: Device[];
  onUpdate: () => void;
  canWrite?: boolean;          // default true; D5 write authority
  mutationsSupported?: boolean; // default true; D4 capability gate
}
```

plus the locale key `devices:zone.notAvailableOnGateway`.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { IrrigationZone } from '../../../types/farming';
import { IrrigationZoneCard } from '../IrrigationZoneCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { removeDevice: vi.fn(), delete: vi.fn() },
  environmentAPI: { getSummary: vi.fn().mockResolvedValue(null) },
  dendroAnalyticsAPI: { getZoneRecommendations: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../history/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ flags: { historyUxEnabled: false } }),
}));
vi.mock('../../../utils/displayPreferences', () => ({
  useDisplayPreferences: () => ({
    swtUnit: 'kPa',
    modules: { waterCard: true, schedulerUi: true, environment: false, predictionAdvisory: false },
  }),
}));
vi.mock('../deviceRegistry', () => ({ DEVICE_SECTIONS: [] }));
vi.mock('../ScheduleSection', () => ({
  ScheduleSection: () => <div data-testid="schedule-section" />,
}));
vi.mock('../dendrometer/DendrometerSection', () => ({ DendrometerSection: () => <div /> }));
vi.mock('../environment/EnvironmentCard', () => ({ EnvironmentCard: () => <div /> }));
vi.mock('../prediction/PredictionCard', () => ({ PredictionCard: () => <div /> }));
vi.mock('../AssignDeviceModal', () => ({
  AssignDeviceModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="assign-modal" /> : null),
}));
vi.mock('../ZoneConfigModal', () => ({
  ZoneConfigModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="config-modal" /> : null),
}));
vi.mock('../AdvancedScheduleDrawer', () => ({ AdvancedScheduleDrawer: () => null }));

const zone = {
  id: 29,
  name: 'Zone B',
  zoneUuid: '5bf9d958-f886-4faf-8dcf-e84efe76163a',
  gatewayDeviceEui: '0016C001F11766E7',
  deviceCount: 0,
  devices: [],
} as unknown as IrrigationZone;

function renderCard(props: Partial<ComponentProps<typeof IrrigationZoneCard>> = {}) {
  return render(
    <IrrigationZoneCard zone={zone} devices={[]} unassignedDevices={[]} onUpdate={() => {}} {...props} />,
  );
}

describe('IrrigationZoneCard write gating (D4/D5)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps full edit controls with the default props', async () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'zone.assignDevice' })).toBeInTheDocument();
    expect(screen.queryByText('zone.notAvailableOnGateway')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Zone B/ }));
    expect(screen.getByTestId('schedule-section')).toBeInTheDocument();
  });

  it('hides mutation controls for read-only accounts (D5)', () => {
    renderCard({ canWrite: false });
    expect(screen.queryByRole('button', { name: 'zone.assignDevice' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Configure')).not.toBeInTheDocument();
    expect(screen.queryByText('zone.notAvailableOnGateway')).not.toBeInTheDocument();
  });

  it('shows the explicit not-available state on old gateways (D4)', async () => {
    renderCard({ mutationsSupported: false });
    expect(screen.getByText('zone.notAvailableOnGateway')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'zone.assignDevice' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Zone B/ }));
    expect(screen.queryByTestId('schedule-section')).not.toBeInTheDocument();
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx
```

Expected: the first test PASSES (defaults) and the other two FAIL — the card ignores the props.

- [ ] **Step 2: Implement the gating**

All edits in `frontend/src/components/farming/IrrigationZoneCard.tsx`.

1. Extend the props interface and destructuring:

```tsx
interface IrrigationZoneCardProps {
  zone: IrrigationZone;
  devices: Device[];
  unassignedDevices: Device[];
  onUpdate: () => void;
  canWrite?: boolean;
  mutationsSupported?: boolean;
}
```

```tsx
export const IrrigationZoneCard: React.FC<IrrigationZoneCardProps> = ({
  zone,
  devices,
  unassignedDevices,
  onUpdate,
  canWrite = true,
  mutationsSupported = true,
}) => {
```

2. Directly after `const soilNow = classifySoil(devices);`, add the combined gate:

```tsx
  const editable = canWrite && mutationsSupported;
```

3. Header buttons — replace the opening of the button group `{!pendingCreate && <div className="flex gap-1.5 shrink-0">` so the not-available state renders and the mutation buttons are gated:

```tsx
        {!pendingCreate && <div className="flex gap-1.5 shrink-0 items-center">
          {canWrite && !mutationsSupported && (
            <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--text-tertiary)]">
              {t('zone.notAvailableOnGateway')}
            </span>
          )}
          {editable && (
            <>
              <button
                onClick={() => setShowConfigModal(true)}
                className="p-2 rounded-md text-[var(--text-secondary)] hover:bg-[var(--card)] transition-colors text-xl"
                title="Configure"
              >
                ⚙
              </button>
              <button
                onClick={() => setShowAssignModal(true)}
                className="px-2.5 py-1.5 rounded-md bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white text-xs font-semibold transition-colors"
              >
                {t('zone.assignDevice')}
              </button>
            </>
          )}
          {!isDesktopBrowser() && flags.historyUxEnabled && (
            <Link
              to={`/history/zones/${zone.id}`}
              className="bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors inline-flex items-center justify-center"
            >
              {t('zone.data')}
            </Link>
          )}
          {editable && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isDeleting}
              className="p-1.5 rounded-md bg-[var(--error-bg)] text-[var(--error-text)] hover:opacity-80 transition-opacity disabled:opacity-40 text-sm"
              title={tc('delete')}
            >
              ✕
            </button>
          )}
        </div>}
```

(The history `Link` is read-only and stays ungated, matching the edge card's `showZoneDataLink` treatment.)

4. `PendingStateNotice` retry — the retry re-opens the config modal, a mutation path:

```tsx
      <PendingStateNotice
        operation={zone.desiredState}
        resourceLabel={t('desiredState.zoneLabel')}
        onRetry={pendingCreate || !editable
          ? undefined
          : () => setShowConfigModal(true)}
      />
```

5. Delete confirm block: change `{showDeleteConfirm && (` to `{editable && showDeleteConfirm && (`.

6. `ScheduleSection` mount: change `{preferences.modules.schedulerUi && (` to `{editable && preferences.modules.schedulerUi && (`.

7. Prediction-advisory disabled row — its button opens the config modal; make the click a no-op when gated by changing its `onClick` to:

```tsx
            onClick={() => { if (editable) setShowConfigModal(true); }}
```

8. Empty-devices assign button — wrap it:

```tsx
            {editable && (
              <button
                onClick={() => setShowAssignModal(true)}
                className="bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold px-6 py-3 rounded-lg transition-colors"
              >
                {t('zone.assignFirst')}
              </button>
            )}
```

9. Modals — gate `isOpen` exactly like the edge card does:

```tsx
      {!pendingCreate && <AssignDeviceModal
        isOpen={editable && showAssignModal}
```

```tsx
      {!pendingCreate && <ZoneConfigModal
        isOpen={editable && showConfigModal}
```

```tsx
      {!pendingCreate && <AdvancedScheduleDrawer
        isOpen={editable && showAdvancedDrawer}
```

- [ ] **Step 3: Locale key + locale test**

Create `frontend/tests/zoneGatingLocales.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const frontendRoot = path.resolve(import.meta.dirname, '..');
const LOCALES = ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt'];

test('every locale carries the zone not-available key', () => {
  for (const locale of LOCALES) {
    const devices = JSON.parse(
      fs.readFileSync(path.join(frontendRoot, `public/locales/${locale}/devices.json`), 'utf8'),
    );
    assert.equal(typeof devices.zone?.notAvailableOnGateway, 'string', `${locale} devices.zone.notAvailableOnGateway`);
    assert.notEqual(devices.zone.notAvailableOnGateway.trim(), '', `${locale} devices.zone.notAvailableOnGateway`);
  }
});
```

Run `npx tsx --test tests/zoneGatingLocales.test.ts` (expected: FAIL). Add `notAvailableOnGateway` inside each locale's existing `zone` object (`lg` machine draft pending the human gate):

| Locale | zone.notAvailableOnGateway |
|---|---|
| en | Editing is not available on this gateway's software version. |
| de-CH | Die Bearbeitung ist mit der Softwareversion dieses Gateways nicht verfügbar. |
| fr | La modification n'est pas disponible avec la version logicielle de ce gateway. |
| it | La modifica non è disponibile con la versione software di questo gateway. |
| es | La edición no está disponible con la versión de software de este gateway. |
| pt | A edição não está disponível com a versão de software deste gateway. |
| lg | Okukyusa tekusoboka ku ddala lino erya software ya gateway eno. |

- [ ] **Step 4: Run the task tests and the cloud suite**

```bash
npx vitest run --environment jsdom src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx src/components/farming/__tests__/IrrigationZoneCard.removeDevice.test.tsx
npx tsx --test tests/zoneGatingLocales.test.ts
npm run test:unit
```

Expected: all PASS (the removeDevice test exercises the default-props path and must stay green).

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/farming/IrrigationZoneCard.tsx frontend/src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx frontend/tests/zoneGatingLocales.test.ts frontend/public/locales/de-CH/devices.json frontend/public/locales/en/devices.json frontend/public/locales/es/devices.json frontend/public/locales/fr/devices.json frontend/public/locales/it/devices.json frontend/public/locales/lg/devices.json frontend/public/locales/pt/devices.json
git commit -m "feat: zone card write + capability gating with not-available state (D4/D5)"
```

---

### Task 6: Cloud `Dashboard` scopes by the active gateway and wires the gates

The dashboard consumes `useGateway()` once and derives everything through the T4 helpers: zones and devices filtered by `visibleOnActiveGateway`, the zone cards receiving `canWrite`/`mutationsSupported`, `GatewayScopeBanner` mounted under the header, and the page spinner covering the gateway resolution phase (deny-while-loading). The empty state moves onto ui-core `EmptyState`/`Button`, and the error box's container drops its hardcoded `red-50` palette for the error tokens.

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`
- Create: `frontend/src/pages/__tests__/Dashboard.gatewayScope.test.tsx`

**Interfaces:**
- Consumes: `useGateway()`, `canWriteZones`/`zoneMutationsSupported`/`visibleOnActiveGateway` (T4), `GatewayScopeBanner` (T4), `IrrigationZoneCard` props (T5), `EmptyState`/`Button` from `../ui-core`.
- Produces: no new exports; page behavior only.

- [ ] **Step 1: Write the failing page test**

Create `frontend/src/pages/__tests__/Dashboard.gatewayScope.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LinkedGatewaySummary } from '../../types/farming';
import { useGateway } from '../../contexts/GatewayContext';
import { Dashboard } from '../Dashboard';

const zoneCardProps: any[] = [];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ username: 'amina', logout: vi.fn(), isSuperAdmin: false }),
}));
vi.mock('../../contexts/GatewayContext', () => ({ useGateway: vi.fn() }));
vi.mock('../../services/websocket', () => ({ subscribeToDevice: () => () => {} }));
vi.mock('../../services/api', () => ({
  devicesAPI: { getAll: vi.fn().mockResolvedValue([]) },
  irrigationZonesAPI: {
    getAll: vi.fn().mockResolvedValue([
      { id: 1, name: 'ZoneA', zoneUuid: 'uuid-a', gatewayDeviceEui: 'EUI-A', deviceCount: 0, devices: [] },
      { id: 2, name: 'ZoneB', zoneUuid: 'uuid-b', gatewayDeviceEui: 'EUI-B', deviceCount: 0, devices: [] },
      { id: 3, name: 'ZoneLocal', zoneUuid: 'uuid-l', gatewayDeviceEui: null, deviceCount: 0, devices: [] },
    ]),
  },
  normaliseDevice: (device: unknown) => device,
}));
vi.mock('../../history/useFeatureFlags', () => ({
  useFeatureFlags: () => ({ flags: { historyUxEnabled: false } }),
}));
vi.mock('../../utils/displayPreferences', () => ({
  useDisplayPreferences: () => ({ dashboardAutoRefresh: false }),
  dashboardRefreshInterval: () => 0,
}));
vi.mock('../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: () => false }));
vi.mock('../../components/farming/deviceRegistry', () => ({ DEVICE_SECTIONS: [] }));
vi.mock('../../components/DashboardHeader', () => ({ DashboardHeader: () => <header /> }));
vi.mock('../../components/GatewayScopeBanner', () => ({
  GatewayScopeBanner: () => <div data-testid="scope-banner" />,
}));
vi.mock('../../components/farming/GatewayCard', () => ({ GatewayCard: () => <div /> }));
vi.mock('../../components/farming/AddDeviceModal', () => ({ AddDeviceModal: () => null }));
vi.mock('../../components/farming/CreateZoneModal', () => ({ CreateZoneModal: () => null }));
vi.mock('../../components/farming/IrrigationZoneCard', () => ({
  IrrigationZoneCard: (props: any) => {
    zoneCardProps.push(props);
    return <div data-testid={`zone-${props.zone.name}`} />;
  },
}));

function gateway(eui: string, overrides: Partial<LinkedGatewaySummary> = {}): LinkedGatewaySummary {
  return {
    gatewayDeviceEui: eui,
    offlineVerifierVersion: 1,
    authSyncStatus: 'SYNCED',
    linkedAuthSyncSupported: true,
    forceEdgeSyncSupported: true,
    fieldJournalSupported: true,
    scopedAccessSyncSupported: true,
    scopedAccessCommandsSupported: true,
    zoneDesiredStateSupported: true,
    ...overrides,
  };
}

describe('Dashboard gateway scoping (D3/D4/D5)', () => {
  it('shows only active-gateway and cloud-local zones, viewer grant read-only', async () => {
    const gateways = [gateway('EUI-A', { gatewayRole: 'viewer' }), gateway('EUI-B')];
    vi.mocked(useGateway).mockReturnValue({
      loading: false,
      error: null,
      gateways,
      activeGateway: gateways[0],
      hasMultipleGateways: true,
      selectGateway: vi.fn(),
      retry: vi.fn(),
    });

    render(<Dashboard />);
    expect(screen.getByTestId('scope-banner')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('zone-ZoneA')).toBeInTheDocument());
    expect(screen.getByTestId('zone-ZoneLocal')).toBeInTheDocument();
    expect(screen.queryByTestId('zone-ZoneB')).not.toBeInTheDocument();
    expect(zoneCardProps.every((props) => props.canWrite === false)).toBe(true);
    expect(zoneCardProps.every((props) => props.mutationsSupported === true)).toBe(true);
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/pages/__tests__/Dashboard.gatewayScope.test.tsx
```

Expected: FAIL — no scope banner, `ZoneB` renders, and the card props carry no `canWrite`.

- [ ] **Step 2: Implement the scoping in `Dashboard.tsx`**

1. Add imports next to the existing context import:

```tsx
import { useGateway } from '../contexts/GatewayContext';
import { canWriteZones, visibleOnActiveGateway, zoneMutationsSupported } from '../contexts/gatewayCapabilities';
import { GatewayScopeBanner } from '../components/GatewayScopeBanner';
import { Button, EmptyState } from '../ui-core';
```

2. Inside the component, after `const { username, logout, isSuperAdmin } = useAuth();`:

```tsx
  const gatewayScope = useGateway();
  const writable = canWriteZones(gatewayScope);
  const mutationsAvailable = zoneMutationsSupported(gatewayScope);
```

3. After the two `useSWR` blocks, derive the scoped views (devices carry no gateway EUI, so scoping runs through zone membership; plan-level reading 7):

```tsx
  const visibleZones = useMemo(
    () => (zones ?? []).filter((zone) => visibleOnActiveGateway(gatewayScope, zone.gatewayDeviceEui)),
    [gatewayScope, zones],
  );
  const visibleZoneIds = useMemo(
    () => new Set(visibleZones.map((zone) => zone.id)),
    [visibleZones],
  );
```

4. Replace the whole `devicesByZone` memo with the scoped grouping (a `GATEWAY` row's own `deviceEui` is its gateway identity; devices in zones scoped to another gateway are dropped, matching the edge `FarmingDashboard`):

```tsx
  const { devicesByZone, unassignedDevices, gatewayDevices } = useMemo(() => {
    if (!devices || !zones) return { devicesByZone: new Map<number, Device[]>(), unassignedDevices: [], gatewayDevices: [] };

    const byZone = new Map<number, Device[]>();
    const unassigned: Device[] = [];
    const gateways: Device[] = [];

    devices.forEach((device) => {
      const s2120ZoneIds = device.type === 'SENSECAP_S2120'
        ? Array.from(new Set((device.zone_ids ?? device.zoneIds ?? []).filter((id): id is number => Number.isFinite(id))))
        : [];
      const visibleS2120ZoneIds = s2120ZoneIds.filter((zoneId) => visibleZoneIds.has(zoneId));
      if (device.type === 'GATEWAY') {
        if (visibleOnActiveGateway(gatewayScope, device.deviceEui)) {
          gateways.push(device);
        }
      } else if (visibleS2120ZoneIds.length > 0) {
        visibleS2120ZoneIds.forEach(zoneId => {
          const zoneDevices = byZone.get(zoneId) || [];
          zoneDevices.push(device);
          byZone.set(zoneId, zoneDevices);
        });
      } else if (device.irrigationZoneId) {
        if (visibleZoneIds.has(device.irrigationZoneId)) {
          const zoneDevices = byZone.get(device.irrigationZoneId) || [];
          zoneDevices.push(device);
          byZone.set(device.irrigationZoneId, zoneDevices);
        }
      } else {
        unassigned.push(device);
      }
    });

    return { devicesByZone: byZone, unassignedDevices: unassigned, gatewayDevices: gateways };
  }, [devices, gatewayScope, visibleZoneIds, zones]);
```

5. Loading covers the gateway phase: change

```tsx
  const isLoading = !devices && !devicesError && !zones && !zonesError;
```

to

```tsx
  const isLoading = gatewayScope.loading || (!devices && !devicesError && !zones && !zonesError);
```

6. Mount the banner directly under the header:

```tsx
      <DashboardHeader
        …
      />
      <GatewayScopeBanner />
```

7. Error box container — replace its class:

```
- <div className="bg-red-50 border-2 border-red-300 text-red-800 px-6 py-4 rounded-lg text-center">
+ <div className="bg-[var(--error-bg)] border-2 border-[var(--danger-fg)] text-[var(--error-text)] px-6 py-4 rounded-lg text-center">
```

8. Empty state — replace the whole `devices.length === 0 && zones.length === 0` block with (the condition mirrors the edge page's `devices.length === 0 && visibleZones.length === 0`):

```tsx
            {devices.length === 0 && visibleZones.length === 0 && (
              <EmptyState title={t('emptyState.title')} subtitle={t('emptyState.subtitle')}>
                {writable && mutationsAvailable && (
                  <>
                    <Button onClick={() => setIsCreateZoneModalOpen(true)} className="text-lg px-8 py-4 shadow-lg">
                      {t('emptyState.createZone')}
                    </Button>
                    <Button onClick={() => setIsAddDeviceModalOpen(true)} className="text-lg px-8 py-4 shadow-lg">
                      {t('emptyState.claimDevice')}
                    </Button>
                  </>
                )}
              </EmptyState>
            )}
```

9. Zones section — render the scoped list with the gates:

```tsx
            {visibleZones.length > 0 && (
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-[var(--text)] mb-4">{t('irrigationZones')}</h2>
                {visibleZones.map((zone) => (
                  <IrrigationZoneCard
                    key={zone.id ?? zone.zoneUuid}
                    zone={zone}
                    devices={devicesByZone.get(zone.id) || []}
                    unassignedDevices={unassignedDevices}
                    onUpdate={handleUpdate}
                    canWrite={writable}
                    mutationsSupported={mutationsAvailable}
                  />
                ))}
              </div>
            )}
```

(`gatewayDevices` and `unassignedDevices` come out of the reworked memo, so both sections are already scoped; leave their JSX as is.)

- [ ] **Step 3: Run the page test and the cloud suite**

```bash
npx vitest run --environment jsdom src/pages/__tests__/Dashboard.gatewayScope.test.tsx
npm run test:unit && npm run build
```

Expected: all PASS; the build proves the new imports compile.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/pages/Dashboard.tsx frontend/src/pages/__tests__/Dashboard.gatewayScope.test.tsx
git commit -m "feat: dashboard scopes zones/devices by active gateway (D3/D4/D5)"
```

---

### Task 7: Cloud zone-card cohesion — water card onto tokens, per-sensor chip labels

Two cohesion gaps against the edge card. The cloud water card paints a hardcoded sky/teal/cyan/amber palette (`bg-[linear-gradient(135deg,#f0f9ff,…)]`, `ring-sky-100`, `text-sky-700`) that ignores the ui-core tokens and breaks in dark theme; the edge card (`web/react-gui/src/components/farming/IrrigationZoneCard.tsx:295-367`) draws the same card from `--border`/`--card`/`--surface`/`--primary`/`--success-text`/`--warn-text`. And the cloud schedule chip labels only `DENDRO`/`SWT_WM1`/`SWT_WM2`/`SWT_AVG`, collapsing `SWT_1/2/3` to a generic label the edge distinguishes. Cloud-specific content (the `formatSchedulingMode` chip, `irrigationTodayLiters` fields) stays; D7 binds tokens, not composition.

**Files:**
- Modify: `frontend/src/components/farming/IrrigationZoneCard.tsx`
- Create: `frontend/tests/zoneCardCohesion.test.ts`

**Interfaces:**
- Consumes: ui-core token names via Tailwind arbitrary values (no imports).
- Produces: `data-testid="water-today-card"` marker matching the edge card.

- [ ] **Step 1: Write the failing guard test**

Create `frontend/tests/zoneCardCohesion.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const cardPath = path.resolve(
  import.meta.dirname,
  '../src/components/farming/IrrigationZoneCard.tsx',
);

test('the water card styles from ui-core tokens, not a hardcoded palette', () => {
  const source = fs.readFileSync(cardPath, 'utf8');
  const banned = [
    'linear-gradient(135deg,#f0f9ff',
    'border-sky-100',
    'border-sky-200',
    'text-sky-700',
    'ring-sky-100',
    'ring-teal-100',
    'ring-cyan-100',
    'ring-amber-100',
    'bg-white/80',
    'bg-white/70',
    'border-amber-200',
    'bg-amber-50',
  ];
  for (const cls of banned) {
    assert.ok(!source.includes(cls), `hardcoded palette class still present: ${cls}`);
  }
  assert.ok(source.includes('data-testid="water-today-card"'), 'water-card marker missing');
});

test('schedule chips label the per-sensor SWT metrics like the edge card', () => {
  const source = fs.readFileSync(cardPath, 'utf8');
  for (const metricCase of ["case 'SWT_1'", "case 'SWT_2'", "case 'SWT_3'"]) {
    assert.ok(source.includes(metricCase), `${metricCase} missing from the chip labels`);
  }
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/zoneCardCohesion.test.ts
```

Expected: FAIL on both tests.

- [ ] **Step 2: Retheme the water card**

In `frontend/src/components/farming/IrrigationZoneCard.tsx`, replace the whole `{preferences.modules.waterCard && environmentSummary?.water && ( … )}` block with:

```tsx
      {preferences.modules.waterCard && environmentSummary?.water && (
        <div data-testid="water-today-card" className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary)]">Water Today</p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {environmentSummary.water.action?.reasoning ?? 'Daily rain, irrigation, and crop demand summary for this zone.'}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 text-xs text-[var(--text-tertiary)]">
              <div>Updated {environmentSummary.water.observedAt ? new Date(environmentSummary.water.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</div>
              <div className="flex flex-wrap justify-end gap-1">
                <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 font-semibold text-[var(--primary)]">
                  {formatDisplayMode(environmentSummary.display?.mode)}
                </span>
                <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 font-semibold text-[var(--text-secondary)]">
                  {formatSchedulingMode(environmentSummary.display?.schedulingMode ?? zone.schedulingMode)}
                </span>
              </div>
            </div>
          </div>
          {environmentSummary.display?.fallbackReason && (
            <div className="mt-3 rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-text)]">
              {environmentSummary.display.fallbackReason}
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Rain today</p>
              <p className="mt-2 text-2xl font-bold text-[var(--primary)]">{formatWaterValue(environmentSummary.water.rainTodayMm, 'mm', 1)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Irrigation today</p>
              <p className="mt-2 text-2xl font-bold text-[var(--success-text)]">{formatWaterValue(environmentSummary.water.irrigationTodayLiters, 'L', 0)}</p>
              {environmentSummary.water.irrigationTodayNetMm != null && (
                <p className="mt-1 text-xs text-[var(--text-secondary)]">{formatWaterValue(environmentSummary.water.irrigationTodayNetMm, 'mm', 1)} effective</p>
              )}
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Next rain</p>
              <p className="mt-2 text-2xl font-bold text-[var(--primary)]">{formatWaterValue(environmentSummary.water.next24hRainMm, 'mm', 1)}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">Forecast next 24 h</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Action</p>
              <p className="mt-2 text-2xl font-bold text-[var(--warn-text)]">{formatWaterAction(environmentSummary.water.action?.code)}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {environmentSummary.water.action?.source === 'dendro' ? 'Driven by dendrometer recommendation' : 'Driven by water balance'}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Soil now</p>
              <p className="mt-1 text-lg font-semibold text-[var(--text)]">
                {formatSwtValue(soilNow.swt, preferences.swtUnit) ?? '—'}
              </p>
              <p className="text-sm text-[var(--text-secondary)]">{soilNow.label}</p>
            </div>
            {hasDendroDevices && (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Tree stress</p>
                <p className="mt-1 text-lg font-semibold text-[var(--text)]">
                  {latestZoneRecommendation?.zone_stress_summary?.replace(/_/g, ' ') ?? 'Awaiting recommendation'}
                </p>
                <p className="text-sm text-[var(--text-secondary)]">
                  {latestZoneRecommendation?.zone_confidence_score != null
                    ? `${Math.round(latestZoneRecommendation.zone_confidence_score * 100)}% confidence`
                    : 'Confidence updates with the latest dendro run'}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
```

- [ ] **Step 3: Extend the chip metric labels**

In the same file, replace the chip metric switch:

```tsx
            <span>⏱</span> {(() => {
              switch (schedMetric) {
                case 'DENDRO':  return 'Dendro trigger';
                case 'SWT_WM1': return 'Soil tension (S1)';
                case 'SWT_WM2': return 'Soil tension (S2)';
                case 'SWT_1':   return 'Soil tension (S1)';
                case 'SWT_2':   return 'Soil tension (S2)';
                case 'SWT_3':   return 'Soil tension (S3)';
                case 'SWT_AVG': return 'Soil tension (avg)';
                default:        return 'Soil tension';
              }
            })()} enabled
```

- [ ] **Step 4: Run the guard, targeted tests and the suite**

```bash
npx tsx --test tests/zoneCardCohesion.test.ts
npx vitest run --environment jsdom src/components/farming/__tests__/IrrigationZoneCard.capabilities.test.tsx src/components/farming/__tests__/IrrigationZoneCard.removeDevice.test.tsx
npm run test:unit
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/farming/IrrigationZoneCard.tsx frontend/tests/zoneCardCohesion.test.ts
git commit -m "feat: zone water card on ui-core tokens; SWT_1/2/3 chip labels"
```

---

### Task 8: Cloud `CreateZoneModal` — active gateway, no selector (D3), ui-core shell

The modal stops fetching linked gateways itself: `useGateway()` already holds the resolved list, the active selection and the capability flags. The `<select>` disappears (D3); the target gateway shows read-only with a pointer to the Settings switcher. Submission is fail-closed on unresolved context and viewer grants (D5) and shows the not-available state on gateways without zone commands (D4). The shell moves onto ui-core `Modal`/`FormField`/`Button` with the shared `INPUT_CLASS`.

The keys `createZoneModal.gateway`, `selectGateway`, `gatewayRequired` and `gatewayHint` become unused; they stay in the locale files (deleting across 7 locales is churn this task does not need) and are listed for the i18n dead-key sweep follow-up.

**Files:**
- Modify: `frontend/src/components/farming/CreateZoneModal.tsx` (full rewrite), `frontend/src/components/farming/__tests__/CreateZoneModal.gateway.test.tsx` (full rewrite), `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/devices.json`

**Interfaces:**
- Consumes: `useGateway()`, `canWriteZones`/`zoneMutationsSupported` (T4), `Button`/`FormField`/`INPUT_CLASS`/`Modal` from `../../ui-core`, `irrigationZonesAPI.create` (versioned-command surface, unchanged).
- Produces: same component props (`isOpen`, `onClose`, `onZoneCreated`); new locale keys `createZoneModal.targetGateway`, `createZoneModal.switchOnSettings`.

- [ ] **Step 1: Rewrite the test first**

Replace `frontend/src/components/farming/__tests__/CreateZoneModal.gateway.test.tsx` in full with:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { irrigationZonesAPI } from '../../../services/api';
import type { LinkedGatewaySummary } from '../../../types/farming';
import { useGateway } from '../../../contexts/GatewayContext';
import { CreateZoneModal } from '../CreateZoneModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { create: vi.fn() },
}));
vi.mock('../../../contexts/GatewayContext', () => ({ useGateway: vi.fn() }));

function gateway(eui: string, overrides: Partial<LinkedGatewaySummary> = {}): LinkedGatewaySummary {
  return {
    gatewayDeviceEui: eui,
    offlineVerifierVersion: 1,
    authSyncStatus: 'SYNCED',
    linkedAuthSyncSupported: true,
    forceEdgeSyncSupported: true,
    fieldJournalSupported: true,
    scopedAccessSyncSupported: true,
    scopedAccessCommandsSupported: true,
    zoneDesiredStateSupported: true,
    ...overrides,
  };
}

function scope(gateways: LinkedGatewaySummary[], overrides = {}) {
  return {
    loading: false,
    error: null as string | null,
    gateways,
    activeGateway: gateways[0] ?? null,
    hasMultipleGateways: gateways.length > 1,
    selectGateway: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

describe('CreateZoneModal gateway targeting (D3/D4/D5)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the active gateway read-only and creates the zone on it', async () => {
    vi.mocked(useGateway).mockReturnValue(scope([gateway('EUI-A')]));
    vi.mocked(irrigationZonesAPI.create).mockResolvedValue({} as never);
    const onZoneCreated = vi.fn();
    render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={onZoneCreated} />);
    expect(screen.getByText('EUI-A')).toBeInTheDocument();
    expect(screen.getByText('createZoneModal.switchOnSettings')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('createZoneModal.zoneName'), 'North');
    await userEvent.click(screen.getByRole('button', { name: 'createZoneModal.submit' }));
    await waitFor(() => expect(irrigationZonesAPI.create).toHaveBeenCalledWith({
      name: 'North',
      gatewayDeviceEui: 'EUI-A',
    }));
    expect(onZoneCreated).toHaveBeenCalledTimes(1);
  });

  it('creates a cloud-local zone when the account has no linked gateways', async () => {
    vi.mocked(useGateway).mockReturnValue(scope([]));
    vi.mocked(irrigationZonesAPI.create).mockResolvedValue({} as never);
    render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    expect(screen.getByText('createZoneModal.cloudLocalHint')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('createZoneModal.zoneName'), 'Local');
    await userEvent.click(screen.getByRole('button', { name: 'createZoneModal.submit' }));
    await waitFor(() => expect(irrigationZonesAPI.create).toHaveBeenCalledWith({ name: 'Local' }));
  });

  it('locks submission while the gateway context is loading or failed (D5)', () => {
    vi.mocked(useGateway).mockReturnValue(scope([], { loading: true }));
    const { rerender } = render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    expect(screen.getByRole('button', { name: 'createZoneModal.submit' })).toBeDisabled();
    vi.mocked(useGateway).mockReturnValue(scope([], { error: 'linked_gateways_unavailable' }));
    rerender(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    expect(screen.getByText('createZoneModal.gatewayLoadFailed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'createZoneModal.submit' })).toBeDisabled();
  });

  it('shows the not-available state on a gateway without zone commands (D4)', () => {
    vi.mocked(useGateway).mockReturnValue(
      scope([gateway('EUI-OLD', { zoneDesiredStateSupported: false })]),
    );
    render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    expect(screen.getByText('zone.notAvailableOnGateway')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'createZoneModal.submit' })).toBeDisabled();
  });

  it('blocks a viewer grant from creating zones (D5)', () => {
    vi.mocked(useGateway).mockReturnValue(scope([gateway('EUI-A', { gatewayRole: 'viewer' })]));
    render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    expect(screen.getByRole('button', { name: 'createZoneModal.submit' })).toBeDisabled();
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/components/farming/__tests__/CreateZoneModal.gateway.test.tsx
```

Expected: FAIL — the current modal fetches via `userAPI.getLinkedGateways` and renders a combobox.

- [ ] **Step 2: Rewrite the modal**

Replace `frontend/src/components/farming/CreateZoneModal.tsx` in full with:

```tsx
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { irrigationZonesAPI } from '../../services/api';
import { useGateway } from '../../contexts/GatewayContext';
import { canWriteZones, zoneMutationsSupported } from '../../contexts/gatewayCapabilities';
import { Button, FormField, INPUT_CLASS, Modal } from '../../ui-core';

interface CreateZoneModalProps {
  isOpen: boolean;
  onClose: () => void;
  onZoneCreated: () => void;
}

export const CreateZoneModal: React.FC<CreateZoneModalProps> = ({
  isOpen,
  onClose,
  onZoneCreated,
}) => {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const gatewayScope = useGateway();
  const { loading: gatewaysLoading, error: gatewaysError, gateways, activeGateway } = gatewayScope;
  const cloudLocalAccount = !gatewaysLoading && gatewaysError === null && gateways.length === 0;
  const commandsSupported = zoneMutationsSupported(gatewayScope);
  const writable = canWriteZones(gatewayScope) && commandsSupported;

  useEffect(() => {
    if (isOpen) setError('');
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError(t('createZoneModal.zoneNameRequired'));
      return;
    }
    if (gatewaysError !== null) {
      setError(t('createZoneModal.gatewayLoadFailed'));
      return;
    }
    if (!writable) return;

    setLoading(true);
    try {
      await irrigationZonesAPI.create({
        name: name.trim(),
        ...(activeGateway
          ? { gatewayDeviceEui: activeGateway.gatewayDeviceEui }
          : {}),
      });
      setName('');
      onZoneCreated();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.message || t('createZoneModal.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={t('createZoneModal.title')} onClose={onClose}>
      {error && (
        <div className="mb-4 bg-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <FormField id="zone-name" label={t('createZoneModal.zoneName')}>
          <input
            id="zone-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={t('createZoneModal.zoneNamePlaceholder')}
            className={INPUT_CLASS}
          />
        </FormField>

        {gatewaysLoading && (
          <p className="text-sm text-[var(--text-tertiary)]">
            {t('createZoneModal.loadingGateways')}
          </p>
        )}

        {gatewaysError !== null && (
          <p className="rounded-lg bg-[var(--error-bg)] px-3 py-2 text-sm text-[var(--error-text)]">
            {t('createZoneModal.gatewayLoadFailed')}
          </p>
        )}

        {activeGateway && (
          <div>
            <p className="block text-[var(--text)] text-lg font-semibold mb-2">
              {t('createZoneModal.targetGateway')}
            </p>
            <p className="rounded-lg border-2 border-[var(--border)] bg-[var(--surface)] px-4 py-3 font-mono text-sm text-[var(--text-secondary)]">
              {activeGateway.gatewayDeviceEui}
            </p>
            <p className="mt-2 text-sm text-[var(--text-tertiary)]">
              {t('createZoneModal.switchOnSettings')}
            </p>
          </div>
        )}

        {activeGateway && !commandsSupported && (
          <p className="rounded-lg border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-text)]">
            {t('zone.notAvailableOnGateway')}
          </p>
        )}

        {cloudLocalAccount && (
          <p className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-secondary)]">
            {t('createZoneModal.cloudLocalHint')}
          </p>
        )}

        <div className="flex gap-4 pt-4">
          <Button variant="secondary" onClick={onClose} className="flex-1 text-lg py-4">
            {tc('cancel')}
          </Button>
          <Button
            type="submit"
            disabled={loading || gatewaysLoading || !writable}
            className="flex-1 text-lg py-4 shadow-lg"
          >
            {loading ? t('createZoneModal.creating') : t('createZoneModal.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
```

- [ ] **Step 3: Locale keys**

Add inside each locale's existing `createZoneModal` object in `devices.json` (`lg` machine draft pending the human gate):

| Locale | targetGateway | switchOnSettings |
|---|---|---|
| en | Target gateway | Zones are created on the active gateway. You can switch it on the Settings page. |
| de-CH | Ziel-Gateway | Zonen werden auf dem aktiven Gateway erstellt. Sie können es auf der Einstellungsseite wechseln. |
| fr | Gateway cible | Les zones sont créées sur le gateway actif. Vous pouvez en changer sur la page des réglages. |
| it | Gateway di destinazione | Le zone vengono create sul gateway attivo. Puoi cambiarlo nella pagina delle impostazioni. |
| es | Gateway de destino | Las zonas se crean en el gateway activo. Puedes cambiarlo en la página de ajustes. |
| pt | Gateway de destino | As zonas são criadas no gateway ativo. Pode mudá-lo na página de definições. |
| lg | Gateway egendererwako | Ebitundu bikolebwa ku gateway ekozesebwa. Osobola okugikyusa ku lupapula lw'enteekateeka. |

Extend `frontend/tests/zoneGatingLocales.test.ts` (T5) with a second test in the same file:

```ts
test('every locale carries the create-zone target-gateway keys', () => {
  for (const locale of LOCALES) {
    const devices = JSON.parse(
      fs.readFileSync(path.join(frontendRoot, `public/locales/${locale}/devices.json`), 'utf8'),
    );
    for (const key of ['targetGateway', 'switchOnSettings']) {
      assert.equal(typeof devices.createZoneModal?.[key], 'string', `${locale} devices.createZoneModal.${key}`);
      assert.notEqual(devices.createZoneModal[key].trim(), '', `${locale} devices.createZoneModal.${key}`);
    }
  }
});
```

- [ ] **Step 4: Run the task tests and the cloud suite**

```bash
npx vitest run --environment jsdom src/components/farming/__tests__/CreateZoneModal.gateway.test.tsx
npx tsx --test tests/zoneGatingLocales.test.ts
npm run test:unit && npm run build
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/farming/CreateZoneModal.tsx frontend/src/components/farming/__tests__/CreateZoneModal.gateway.test.tsx frontend/tests/zoneGatingLocales.test.ts frontend/public/locales/de-CH/devices.json frontend/public/locales/en/devices.json frontend/public/locales/es/devices.json frontend/public/locales/fr/devices.json frontend/public/locales/it/devices.json frontend/public/locales/lg/devices.json frontend/public/locales/pt/devices.json
git commit -m "feat: CreateZoneModal targets the active gateway on ui-core shell (D3/D4/D5)"
```

---

### Task 9: Edge `CreateZoneModal` migrates onto ui-core `Modal`/`FormField`/`Button`

The edge modal's markup is what S0 copied into the primitives, so the migration is import-path moves: `Modal` reproduces the overlay/dialog shell (adding the `role="dialog"` the hand-rolled version lacked), `INPUT_CLASS` is byte-identical to the current input class, and `Button` reproduces the footer buttons. Submit logic is untouched; `FarmingDashboard` keeps gating `isOpen={canWrite && isCreateZoneModalOpen}`.

**Files:**
- Modify: `web/react-gui/src/components/farming/CreateZoneModal.tsx` (full rewrite)
- Create: `web/react-gui/src/components/farming/__tests__/CreateZoneModal.uicore.test.tsx`

**Interfaces:**
- Consumes: `Button`/`FormField`/`INPUT_CLASS`/`Modal` from `../../ui-core`; `irrigationZonesAPI.create` unchanged.
- Produces: same props (`isOpen`, `onClose`, `onZoneCreated`); the dialog is now labelled for assistive tech.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/components/farming/__tests__/CreateZoneModal.uicore.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateZoneModal } from '../CreateZoneModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../services/api', () => ({
  irrigationZonesAPI: { create: vi.fn() },
}));

afterEach(cleanup);

describe('CreateZoneModal on ui-core', () => {
  it('renders a labelled dialog with the shared input treatment', () => {
    render(<CreateZoneModal isOpen onClose={() => {}} onZoneCreated={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'createZoneModal.title' })).toBeTruthy();
    expect(screen.getByLabelText('createZoneModal.zoneName').className).toContain('touch-target');
  });

  it('renders nothing while closed', () => {
    const { container } = render(
      <CreateZoneModal isOpen={false} onClose={() => {}} onZoneCreated={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('closes from the dialog close control', () => {
    const onClose = vi.fn();
    render(<CreateZoneModal isOpen onClose={onClose} onZoneCreated={() => {}} />);
    screen.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx vitest run src/components/farming/__tests__/CreateZoneModal.uicore.test.tsx
```

Expected: FAIL — the current markup has no `role="dialog"`.

- [ ] **Step 2: Rewrite the modal**

Replace `web/react-gui/src/components/farming/CreateZoneModal.tsx` in full with:

```tsx
import React, { useState } from 'react';
import { irrigationZonesAPI } from '../../services/api';
import { useTranslation } from 'react-i18next';
import { Button, FormField, INPUT_CLASS, Modal } from '../../ui-core';

interface CreateZoneModalProps {
  isOpen: boolean;
  onClose: () => void;
  onZoneCreated: () => void;
}

export const CreateZoneModal: React.FC<CreateZoneModalProps> = ({
  isOpen,
  onClose,
  onZoneCreated,
}) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError(t('createZoneModal.zoneNameRequired'));
      return;
    }

    setLoading(true);
    try {
      await irrigationZonesAPI.create({ name: name.trim() });
      setName('');
      onZoneCreated();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.message || t('createZoneModal.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={t('createZoneModal.title')} onClose={onClose}>
      {error && (
        <div className="mb-4 bg-[var(--error-bg)] border border-[var(--error-bg)] text-[var(--error-text)] px-3 py-2 rounded-lg text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <FormField id="zone-name" label={t('createZoneModal.zoneName')}>
          <input
            id="zone-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={t('createZoneModal.zoneNamePlaceholder')}
            className={INPUT_CLASS}
          />
        </FormField>

        <div className="flex gap-4 pt-4">
          <Button variant="secondary" onClick={onClose} className="flex-1 text-lg py-4">
            {tc('cancel')}
          </Button>
          <Button type="submit" disabled={loading} className="flex-1 text-lg py-4 shadow-lg">
            {loading ? t('createZoneModal.creating') : t('createZoneModal.submit')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
```

- [ ] **Step 3: Run the test and the edge suite**

```bash
npx vitest run src/components/farming/__tests__/CreateZoneModal.uicore.test.tsx
npm run typecheck && npm run test:unit
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/components/farming/CreateZoneModal.tsx web/react-gui/src/components/farming/__tests__/CreateZoneModal.uicore.test.tsx
git commit -m "feat: edge CreateZoneModal on ui-core Modal/FormField/Button"
```

---

### Task 10: Edge `FarmingDashboard` empty state onto ui-core `EmptyState`/`Button`

`EmptyState` was copied from this exact block in S0, so the swap reproduces the rendered markup (`bg-[var(--surface)] rounded-xl border-2`, `text-2xl font-bold` title, centered action row); the buttons pick up `Button`'s `touch-target` base plus the size classes the originals carried.

**Files:**
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx`
- Create: `web/react-gui/tests/farmingDashboardUiCore.test.ts`

**Interfaces:**
- Consumes: `Button`/`EmptyState` from `../ui-core`.
- Produces: no API change.

- [ ] **Step 1: Write the failing guard test**

Create `web/react-gui/tests/farmingDashboardUiCore.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pagePath = path.resolve(import.meta.dirname, '../src/pages/FarmingDashboard.tsx');

test('the farming dashboard renders its empty state through ui-core', () => {
  const source = fs.readFileSync(pagePath, 'utf8');
  assert.match(source, /from '\.\.\/ui-core'/);
  assert.ok(source.includes('<EmptyState'), 'EmptyState primitive not used');
  assert.ok(
    !source.includes('text-center py-12 bg-[var(--surface)] rounded-xl'),
    'hand-rolled empty-state markup still present',
  );
});
```

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/farmingDashboardUiCore.test.ts
```

Expected: FAIL — no ui-core import.

- [ ] **Step 2: Swap the block**

In `web/react-gui/src/pages/FarmingDashboard.tsx`, add the import next to the other component imports:

```tsx
import { Button, EmptyState } from '../ui-core';
```

and replace the whole `{devices.length === 0 && visibleZones.length === 0 && ( … )}` block with:

```tsx
            {devices.length === 0 && visibleZones.length === 0 && (
              <EmptyState title={t('emptyState.title')} subtitle={t('emptyState.subtitle')}>
                {canWrite && (
                  <>
                    <Button
                      onClick={() => setIsCreateZoneModalOpen(true)}
                      className="text-lg px-8 py-4 shadow-lg"
                    >
                      {t('emptyState.createZone')}
                    </Button>
                    <Button
                      onClick={() => setIsAddDeviceModalOpen(true)}
                      className="text-lg px-8 py-4 shadow-lg"
                    >
                      {t('emptyState.addDevice')}
                    </Button>
                  </>
                )}
              </EmptyState>
            )}
```

(The `canWrite` guard is new and correct: the page already gates both modals on `canWrite`, so for a scoped viewer the old buttons opened nothing. This is the same dead-control fix D4/D5 demand on the cloud side.)

- [ ] **Step 3: Run the guard, existing page tests and the edge suite**

```bash
npx tsx --test tests/farmingDashboardUiCore.test.ts
npx vitest run src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx
npm run typecheck && npm run test:unit
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/pages/FarmingDashboard.tsx web/react-gui/tests/farmingDashboardUiCore.test.ts
git commit -m "feat: farming dashboard empty state on ui-core EmptyState/Button"
```

---

### Task 11: Update the GUI-parity matrix (S1 rows)

Per the matrix rules: only touched rows change, each touched row gets today's provenance date, and nothing flips to `parity` because S1 ran no `agrolink-test-01` walkthrough. All edits in `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (osi-os).

**Files:**
- Modify: `docs/superpowers/plans/agrolink-gui-parity-matrix.md`

- [ ] **Step 1: Edit the three existing rows**

Replace the "Farming dashboard" row with:

```markdown
| Farming dashboard | `web/react-gui/src/pages/FarmingDashboard.tsx` (368 lines) | partial (pending walkthrough): cloud `pages/Dashboard.tsx` now scopes zones/devices by the active gateway (D3), passes `canWrite`/`mutationsSupported` to zone cards (D4/D5), mounts `GatewayScopeBanner`, and renders its empty state on ui-core `EmptyState`/`Button` (S1 T6); edge empty state also on ui-core (S1 T10); page composition still thinner than the edge page | pending | 2026-08-05 verified (S1) |
```

Replace the "Scope status banner" row with:

```markdown
| Scope status banner | `web/react-gui/src/components/ScopeStatusBanner.tsx` (on ui-core `Banner` since S1 T3, fixing its undefined `--danger-*` classes) | partial (pending walkthrough): cloud `components/GatewayScopeBanner.tsx` ports the D5 fail-closed pattern over `useGateway()` with retry (S1 T4); both banners announce via explicit `aria-live` (S1 T2) | pending | 2026-08-05 verified (S1) |
```

Replace the "Zone / device modals" row with:

```markdown
| Zone / device modals | `web/react-gui/src/components/farming/CreateZoneModal.tsx` (on ui-core since S1 T9), `AddDeviceModal.tsx` (196 lines) | partial (pending walkthrough): cloud `CreateZoneModal.tsx` targets the active gateway with no in-modal selector (D3) on the ui-core `Modal`/`FormField`/`Button` shell, fail-closed and capability-gated (S1 T8); `AddDeviceModal` untouched (S2) | pending | 2026-08-05 verified (S1) |
```

- [ ] **Step 2: Append three S1 rows to the "Edge screens and widgets" table**

```markdown
| Irrigation zone card | `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` (609 lines; S1 fixed its delete-button hover) | partial (pending walkthrough): cloud card (512 lines) gains `canWrite`/`mutationsSupported` gating with the explicit not-available state (S1 T5), water card rethemed onto ui-core tokens and SWT_1/2/3 chip labels (S1 T7); zone-level conflict/rejection surfacing already live via `PendingStateNotice` | pending | 2026-08-05 verified (S1) |
| Schedule section + advanced drawer | `web/react-gui/src/components/farming/ScheduleSection.tsx` (415 lines), `AdvancedScheduleDrawer.tsx` (471 lines) | partial (pending walkthrough): cloud `ScheduleSection.tsx` (505 lines) carries the full edge trigger vocabulary plus desired-state surfacing with retry (`ScheduleSection.desiredState.test.tsx`); cloud drawer (463 lines) close in size; mounts now write/capability gated at the card (S1 T5); cohesion depth needs the walkthrough | pending | 2026-08-05 verified (S1) |
| Zone config + irrigation calibration | `web/react-gui/src/components/farming/ZoneConfigModal.tsx` (536 lines) | partial (pending walkthrough): cloud modal (829 lines) already submits config and calibration through `updateConfig`/`updateCalibration` and renders `PendingStateNotice` for the calibration operation; access gated at the card (S1 T5); ui-core adoption inside the modal deliberately deferred (D7 cohesion, single-sided component) | pending | 2026-08-05 verified (S1) |
```

- [ ] **Step 3: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add docs/superpowers/plans/agrolink-gui-parity-matrix.md
git commit -m "docs: matrix S1 rows — zones/schedules/calibration partial pending walkthrough"
```

---

### Task 12: Full verification, both repos

No code changes. Every gate S1 could have disturbed runs once, from clean state.

- [ ] **Step 1: Edge suite, build and vendor parity**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npm run typecheck && npm run test:unit && npm run build
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
sh scripts/verify-ui-core-vendor.test.sh
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh
```

Expected: typecheck clean; full edge suite green (the node-test count grows by 3 files: `errorButtonHover`, `farmingDashboardUiCore`, plus S0's baseline; Vitest grows by the T2/T3/T9 tests); `vite build` succeeds; `verify-ui-core-vendor.test: OK`; `verify-ui-core-vendor: OK`.

- [ ] **Step 2: Cloud suite, build and vendor parity**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npm run test:unit && npm run build
cd /home/phil/Repos/osi-server/.worktrees/agrolink
sh scripts/verify-ui-core-vendor.test.sh
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
```

Expected: full cloud suite green (tsx-runner picks up the three new `tests/*.test.ts` files; Vitest picks up the four new `src/**/__tests__` files); build succeeds; both verifier outputs `OK`.

- [ ] **Step 3: Scope audit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git log --oneline -8 -- frontend
git status --short
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git log --oneline -8
git status --short
```

Expected: only the files named in this plan's File map appear in the S1 commits; no `terra-intelligence` or Terra composition-root paths; both worktrees clean. If anything else shows up, stop and report before proceeding.
