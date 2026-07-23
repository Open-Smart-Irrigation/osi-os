# AgroLink Scoped Access — Phase D Implementation Plan (GUI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The GUI renders only what the signed-in account may see and do: scope profile from `/api/me` drives zone/plot pickers, mutation controls, and navigation; admins get user and grant management screens; viewers get a read-only UI. Flag off = current GUI, byte-identical behavior.

**Architecture:** Per spec §12. The GUI is a presentation layer only — the edge API enforces everything (Phases B/C); the GUI never trusts its own filter. Scope profile loads once per session into a new `ScopeContext`, alongside (not inside) the existing `AuthContext`. All new routes use `PrivateRoute`. New strings go into all 7 locale directories (en mirrored where translations are pending, per i18n workflow).

**Tech Stack:** React + TypeScript (Vite, `base: '/gui/'`, `HashRouter`), SWR, i18next. Load `osi-react-gui-patterns` before edits; read repo-root `architect.yaml` + `RULES.yaml` overlays for every file touched.

**Prerequisites:** Phase B and C complete (`/api/me`, scoped reads, account/grant API live on the edge).

---

## Task D1: Scope profile plumbing

**Files:**
- Modify: `web/react-gui/src/services/api.ts`
- Create: `web/react-gui/src/contexts/ScopeContext.tsx`
- Modify: `web/react-gui/src/App.tsx` (provider wiring only)
- Create: `web/react-gui/src/contexts/__tests__/ScopeContext.test.tsx`

- [ ] **Step 1: Service function + failing context test**

In `api.ts`, add beside the features fetcher (~line 974):

```ts
export interface ScopeProfile {
  username: string;
  user_uuid: string;
  role: 'admin' | 'researcher' | 'viewer';
  zone_uuids: string[] | null; // null = unscoped (flag off / wildcard)
  plot_uuids: string[] | null;
  features: { scoped_access: boolean };
}

export async function fetchScopeProfile(): Promise<ScopeProfile> {
  const res = await api.get('/api/me');
  return res.data as ScopeProfile;
}
```

Write `ScopeContext.test.tsx`:

```tsx
import { renderHook, act } from '@testing-library/react';
import { ScopeProvider, useScope } from '../ScopeContext';

// mock fetchScopeProfile via vi.mock on services/api
test('defaults to unscoped while loading; resolves scoped profile', async () => {
  const { result } = renderHook(() => useScope(), { wrapper: ScopeProvider });
  expect(result.current.loading).toBe(true);
  expect(result.current.isScoped).toBe(false);
  await act(async () => {});
  expect(result.current.role).toBe('researcher');
  expect(result.current.canWrite).toBe(true);
  expect(result.current.isZoneVisible('z-1')).toBe(true);
  expect(result.current.isZoneVisible('z-foreign')).toBe(false);
});

test('flag-off profile yields wildcard: everything visible, canWrite true', async () => {
  // profile { role:'admin', zone_uuids:null, plot_uuids:null, features:{scoped_access:false} }
});
```

- [ ] **Step 2: Implement `ScopeContext.tsx`**

```tsx
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { fetchScopeProfile, ScopeProfile } from '../services/api';
import { useAuth } from './AuthContext';

interface ScopeValue {
  loading: boolean;
  isScoped: boolean;
  role: ScopeProfile['role'];
  canWrite: boolean;             // role !== 'viewer'
  isAdmin: boolean;
  isZoneVisible: (zoneUuid: string) => boolean;
  isPlotVisible: (plotUuid: string) => boolean;
  profile: ScopeProfile | null;
}

const ScopeContext = createContext<ScopeValue | null>(null);

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [profile, setProfile] = useState<ScopeProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!token) { setProfile(null); setLoading(false); return; }
    setLoading(true);
    fetchScopeProfile()
      .then((p) => { if (!cancelled) { setProfile(p); setLoading(false); } })
      .catch(() => { if (!cancelled) { setProfile(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [token]);

  const value = useMemo<ScopeValue>(() => {
    const isScoped = !!profile?.features?.scoped_access;
    const role = profile?.role ?? 'admin';
    const zones = profile?.zone_uuids ?? null;
    const plots = profile?.plot_uuids ?? null;
    return {
      loading,
      isScoped,
      role,
      canWrite: role !== 'viewer',
      isAdmin: role === 'admin',
      isZoneVisible: (z) => !isScoped || zones === null || zones.includes(z),
      isPlotVisible: (p) => !isScoped || plots === null || plots.includes(p),
      profile,
    };
  }, [loading, profile]);

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeValue {
  const v = useContext(ScopeContext);
  if (!v) throw new Error('useScope outside ScopeProvider');
  return v;
}
```

- [ ] **Step 3: Wire provider, run tests + typecheck**

In `App.tsx`, nest `<ScopeProvider>` inside the existing `AuthProvider` around all routes (one-line structural edit; do not touch route definitions).

```bash
cd web/react-gui && npm run typecheck && npm run test:unit -- --run src/contexts
```

- [ ] **Step 4: Commit**

```bash
git add web/react-gui/src/services/api.ts web/react-gui/src/contexts web/react-gui/src/App.tsx
git commit -m "feat(gui): scope profile context from /api/me"
```

---

## Task D2: Scoped navigation and pickers

**Files:**
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx`
- Modify: `web/react-gui/src/pages/HistoryDashboard.tsx`
- Modify: the zone-picker component(s) (locate with `grep -rn "zone" web/react-gui/src/components/ | grep -i picker|select` — record what exists in the execution report)
- Tests: colocated `__tests__` additions per page

- [ ] **Step 1: Filter zone lists**

Wherever the dashboard renders a zone list, pass the rendered array through:

```tsx
const { isZoneVisible, loading: scopeLoading } = useScope();
const visibleZones = useMemo(
  () => (zones ?? []).filter((z) => isZoneVisible(z.zone_uuid)),
  [zones, isZoneVisible]
);
```

While `scopeLoading` and `/api/me` is unresolved, render the existing loading state, not the unfiltered list (missing-data rule: unresolved scope is not "everything"). Devices and cards follow their zone's visibility; weather-class devices (type `SENSECAP_S2120`/`AQUASCOPE_LORAIN`) stay visible regardless of zone filter, mirroring D4.

- [ ] **Step 2: Filter pickers**

Zone and plot selects in schedule editors, claim forms, history filters, and journal views apply the same two predicates. No picker renders an option the predicate rejects.

- [ ] **Step 3: Tests**

Per page: scoped researcher sees own zones/plots only; viewer same; flag off sees all. Run `npm run test:unit`.

- [ ] **Step 4: Commit**

```bash
git add web/react-gui/src/
git commit -m "feat(gui): scoped navigation, zone/plot pickers"
```

---

## Task D3: Mutation-control gating

**Files:**
- Modify: the components rendering valve buttons, schedule editors, zone config forms, claim/register buttons, journal entry editors (locate per family; record in report)
- Create: `web/react-gui/src/components/CanWrite.tsx`

- [ ] **Step 1: Create the gate component**

```tsx
import React from 'react';
import { useScope } from '../contexts/ScopeContext';

export function CanWrite({ zoneUuid, children }: { zoneUuid?: string; children: React.ReactNode }) {
  const { loading, canWrite, isZoneVisible, isScoped } = useScope();
  // Missing-data rule (same principle as Task D2's zone-list filter): while
  // /api/me is unresolved, ScopeContext's canWrite/role default optimistic
  // (role defaults to 'admin' so real admins aren't bounced by AdminOnly
  // before their profile loads — see below). CanWrite is a render gate, not
  // a redirect, so it has no reason to share that optimism: render nothing
  // until the real profile is known, rather than flashing mutation controls
  // at a viewer for one render cycle.
  if (loading) return null;
  if (!canWrite) return null;                       // viewer: no mutation controls
  if (isScoped && zoneUuid && !isZoneVisible(zoneUuid)) return null;
  return <>{children}</>;
}
```

This is not cosmetic. `ScopeContext`'s `isZoneVisible`/`canWrite` are `!isScoped || …` / `role !== 'viewer'` — and while `profile` is null (still loading), `isScoped` is `false` and `role` defaults to `'admin'` (see `ScopeContext.tsx`'s `useMemo`), so every predicate reports "everything visible, full write access" during the fetch window. Task D2 Step 1 already guards against this for zone lists explicitly; `CanWrite` is the shared primitive every mutation control in D3–D5 renders through, so this one `loading` check is what makes "viewers see zero mutation affordances" (the Phase D gate, §15) actually hold from the first paint, not just after `/api/me` resolves. Not a security bypass either way — the edge API is authoritative and rejects the write regardless — but the whole point of `CanWrite` is to not show a viewer a button that will 403.

- [ ] **Step 2: Wrap mutation controls**

Valve open/cancel buttons, schedule edit forms, zone config/location forms, device claim/register buttons, journal entry/void buttons each get wrapped with `CanWrite` (with `zoneUuid` where the control is zone-bound). Read-only displays (values, charts, tables) are never wrapped — viewers keep full read access to their scope.

- [ ] **Step 3: Tests**

Viewer: no valve buttons render, data still renders. Researcher out-of-scope zone: controls absent. In-scope: controls present. Run `npm run test:unit`.

- [ ] **Step 4: Commit**

```bash
git add web/react-gui/src/
git commit -m "feat(gui): role/scope-gated mutation controls"
```

---

## Task D4: Admin screens — users and grants

**Files:**
- Create: `web/react-gui/src/pages/admin/UsersPage.tsx`
- Create: `web/react-gui/src/pages/admin/GrantsPage.tsx`
- Modify: `web/react-gui/src/App.tsx` (two PrivateRoute blocks, admin-gated)
- Modify: `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/types/farming.ts` (shared `AdminUser` type — matches the convention that shared domain types live here, not inline in a service file, per `osi-react-gui-patterns`)
- Create: colocated `__tests__/UsersPage.test.tsx`, `__tests__/GrantsPage.test.tsx`

- [ ] **Step 1: API service functions**

In `web/react-gui/src/types/farming.ts`, add:

```ts
export interface AdminUser { username: string; user_uuid: string; role: string; disabled_at: string | null; created_at: string; }
```

In `api.ts`:

```ts
import type { AdminUser } from '../types/farming';

export const listUsers = () => api.get('/api/users').then((r) => r.data.users as AdminUser[]);
export const createUser = (body: { username: string; password: string; role: string }) => api.post('/api/users', body);
export const resetPassword = (uuid: string, password: string) => api.post(`/api/users/${uuid}/password-reset`, { password });
export const setUserRole = (uuid: string, role: string) => api.put(`/api/users/${uuid}/role`, { role });
export const setUserDisabled = (uuid: string, disabled: boolean) => api.put(`/api/users/${uuid}/disabled`, { disabled });
export const grantZone = (user_uuid: string, zone_uuid: string) => api.post('/api/grants/zone', { user_uuid, zone_uuid });
export const revokeGrant = (kind: 'zone' | 'plot', assignmentUuid: string) => api.delete(`/api/grants/${kind}/${assignmentUuid}`);
```

- [ ] **Step 2: UsersPage**

Table of users (username, role, disabled state, created). Actions per row: role select, disable/enable toggle, reset-password dialog (admin-typed temporary password, twice). A "Create user" dialog (username, password, role). Copy the newest settings-page layout pattern from `SettingsPage.tsx`; no password hashes anywhere in render. 409 from the last-admin guard surfaces as an inline error message ("Cannot disable the last administrator" i18n key), never a crash.

- [ ] **Step 3: GrantsPage**

Two-panel editor: user list on the left; on selection, their current zone/plot grants on the right with add (zone/plot pickers — unfiltered here, admins see all) and revoke actions. Revoke asks for confirmation with a plain-text consequence line (i18n key).

- [ ] **Step 4: Routes**

```tsx
<Route path="/admin/users" element={
  <PrivateRoute><AdminOnly><UsersPage /></AdminOnly></PrivateRoute>
} />
<Route path="/admin/grants" element={
  <PrivateRoute><AdminOnly><GrantsPage /></AdminOnly></PrivateRoute>
} />
```

`AdminOnly` reads `useScope().isAdmin` and redirects non-admins to `/`, but must wait out the loading window first rather than deciding either way immediately:

```tsx
import React from 'react';
import { Navigate } from 'react-router-dom';
import { useScope } from '../contexts/ScopeContext';

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { loading, isAdmin } = useScope();
  // Deliberately does not redirect while loading: role defaults to 'admin'
  // during the /api/me fetch window (see ScopeContext.tsx), so a real admin
  // must not be bounced to "/" before their profile confirms it — but this
  // component also must not render admin page content optimistically for a
  // non-admin during that same window (same missing-data-rule reasoning as
  // CanWrite). Render nothing until loading resolves, then decide once.
  if (loading) return null;
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
```

Navigation entries render only when `isAdmin && isScoped && !loading`.

- [ ] **Step 5: Tests + commit**

Users list renders; role change calls the service; last-admin 409 shows inline; GrantsPage add/revoke flows; non-admin redirect.

```bash
cd web/react-gui && npm run typecheck && npm run test:unit
git add web/react-gui/src/
git commit -m "feat(gui): admin user + grant management screens"
```

---

## Task D5: Viewer mode and disabled-account handling

- [ ] **Step 1: Disabled-account UX**

When the edge returns 403 `account disabled` on any call, `api.ts`'s existing auth-expiry cleanup path handles it the same way as a 401 (token cleared, redirect to `/login`) — verify this path exists and extend it to the 403-disabled body only if it does not already; record the finding in the execution report. Login page shows a neutral "account disabled" message (i18n key) when login itself returns that body.

- [ ] **Step 2: Viewer sweep**

One pass over every page asserting viewers see data but zero mutation affordances (extends D3): schedule lists read-only, journal entries read-only, settings screens hidden (settings are config writes → admin/researcher only; hide nav entry for viewers).

- [ ] **Step 3: Tests + commit**

```bash
git add web/react-gui/src/
git commit -m "feat(gui): viewer read-only mode and disabled-account handling"
```

---

## Task D6: i18n keys

Add every new user-facing string to all 7 locale directories under `web/react-gui/public/locales/` (`de-CH`, `en`, `es`, `fr`, `it`, `lg`, `pt`): scope/admin labels, role names, grant editor strings, error messages (`scope.errors.last_admin`, `scope.errors.account_disabled`, `scope.errors.forbidden`), viewer badges. English text in `en`; other locales may mirror English initially per the i18n workflow (#47 tracks real translations). Run the locale-loading smoke test if one exists; otherwise verify `npm run build` bundles the new keys.

```bash
git add web/react-gui/public/locales/
git commit -m "feat(gui): i18n keys for scoped-access UI"
```

---

## Task D7: Phase D gate

- [ ] **Step 1: Full frontend gates**

```bash
cd web/react-gui
npm run typecheck
npm run test:unit
npm run build
git diff --check
```
All exit 0.

- [ ] **Step 2: Acceptance against spec §15 Phase D gate**

- Scoped rendering covered by unit tests for context, pickers, mutation gating, admin screens, viewer mode.
- Build green; deep links work under `HashRouter`; nothing references paths outside `/gui/`.
- Flag off: every page behaves exactly as before Phase D (one manual smoke pass recorded in the execution report).

## Notes for the executor

- The GUI is never the enforcement boundary; do not add scope logic that the API does not already enforce (Phases B/C).
- Missing-data rule applies to the scope profile itself: while it loads, render loading states, not unrestricted UI.
- Where an existing page hardcodes English strings, add keys for new strings only; do not normalize legacy strings opportunistically (#47 scope discipline).
