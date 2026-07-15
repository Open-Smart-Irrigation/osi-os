# Field Journal — Slice 2 (Edge GUI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the AgroLink field-journal edge UI — the reading surface, the mobile capture flow, multi-plot batch entry, plot CRUD, the drafts queue, chart markers, and the desktop three-pane workspace — against the Slice-1 REST contract, in the liquid-glass AgroLink design language.

**Architecture:** A typed `journalApi` client wraps the Slice-1 routes; SWR drives reads; a single template-engine renderer turns pinned template/layout definitions into forms shared by mobile and desktop; the whole feature is gated on the catalog probe so the tab degrades gracefully where the edge lacks the journal backend.

**Tech Stack:** React 18 + TypeScript, axios (shared `api` instance), SWR, react-i18next (`journal` namespace), Vitest + Testing Library, Tailwind v4 with the AgroLink glass tokens. No new runtime dependencies.

## Global Constraints

- Design of record: `docs/superpowers/specs/2026-07-12-field-journal-design.md` (v2) §6, the UX addendum U1–U7 / P1–P9, and the AgroLink journal UX proposal `docs/design/agrolink-journal-ux.md`.
- **REQUIRED SKILL while executing:** `osi-react-gui-patterns` (before touching any `web/react-gui` route, page, component, service, or i18n file).
- Branch: `design-sync/agrolink` (carries the shared `AppHeader`, glass tokens, and the aligned `JournalPage` landing surface this plan replaces).
- Every user-facing string is an i18n key in the `journal` namespace with an English value; other locales fall back to English until the §6.4 locale contract lands. Locale files that Node-RED serves are mirrored into `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/` **only** for namespaces the mirror already carries (`auth`, `dashboard`, `devices`, `history`) — `journal.json` is not mirrored yet; adding it to the mirror is a Phase 6 task, not a silent per-edit step.
- Glass is chrome-only: `btn-liquid` / `glass-chrome` on nav and controls; entry surfaces, tables, and data stay solid (`--card`, `--surface`) and legible. Danger stays red; the brand red is never a general CTA.
- The capture flow's ≤5-tap SLA (spec §6.1) is a Phase 3 acceptance test at 320×568, not an aspiration.
- Live verification requires a gateway running Slice-1 firmware. kaba100 runs pre-journal firmware and returns 401 on `/api/journal/*`; use the mocked-response unit tests plus the design-sync preview shim for development, and hand live checks to a Slice-1 firmware build.

---

## Contract findings (read before Phase 1)

Verified against the merged Slice-1 module `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/`.

**Routes** (all bearer-auth; 401 missing auth, 404 cross-owner):

| Route | Method | Response |
|---|---|---|
| `/api/journal/catalog` | GET | catalog DTO (below) |
| `/api/journal/entries` | GET | `{ entries: EntryAggregate[], next_cursor: string \| null }` |
| `/api/journal/entries` | POST | `EntryAggregate` (201) |
| `/api/journal/entries/:uuid` | PUT | `EntryAggregate` |
| `/api/journal/entries/:uuid/void` | POST | `EntryAggregate` |
| `/api/journal/plots` | GET/POST/PUT | plot rows |
| `/api/journal/plot-groups` | GET/POST/PUT | group rows |
| `/api/journal/export.{csv,package,json,adapt.json}` | GET | streamed export |

**Entries list filters** (`normalizeEntryFilters`): `status` (`draft`\|`final`\|`voided`\|`all`, default `final`), `plot_uuid`, `activity_code`, `occurred_from`/`occurred_to` (ISO), `campaign_uuid`, `protocol_code`, `protocol_version`, `observation_unit_code`, `batch_uuid`, `pass_uuid`, `limit` (default 50, max 100), `cursor` (opaque, filter-bound — a cursor is rejected if the other filters change).

**EntryAggregate** (`buildAggregate`): every `journal_entries` column in snake_case (JSON columns such as `context_json` arrive parsed), plus `values: EntryValue[]`. **EntryValue**: `{ group_index, attribute_code, value_status, value_num, value_text, unit_code, entered_value_num, entered_unit_code }`, sorted by `(group_index, attribute_code)`.

**Catalog DTO** (`catalogDto`): `{ catalog_version, catalog_hash, vocab[], templates[], layouts[], products[], mappings[] }`. Each `vocab` row is a `journal_vocab` row **with `labels_json` and `constraints_json` removed**; each `templates`/`layouts` row has **`definition_json` and `labels_json` removed**; each `products` row has **`composition_json` removed**.

### Phase 0 prerequisite — the catalog DTO is a version index, not a form source

The capture flow (Phase 3+) cannot render forms from this DTO: template/layout `definition_json` (sections, fields, `required_if`/`visible_if`, defaults, carry-forward classes), vocab `labels_json` and `constraints_json`, and product `composition_json` (nutrient derivation, U5) are all stripped. The reading surface (Phase 2) needs vocab labels to render activity names.

**Phase 0 resolves this before Phase 3 starts.** Decide and implement one of:

- **0a (recommended):** add a `?include=definitions` (or a sibling `/api/journal/catalog/full`) edge response that returns `definition_json`, `constraints_json`, and `composition_json` for the owner-scoped catalog, plus a labels delivery (either `labels_json` in that response or per-locale `journal-vocab.<locale>.json` files served like the other locale namespaces). This is an edge change in `osi-journal/api.js` + a sync/verifier pass — schedule it as its own small plan under `osi-schema-change-control`/`osi-flows-json-editing`, **not** in this GUI plan.
- **0b (interim):** ship Phase 1–2 (foundation + reading surface) now — they only need the index DTO plus vocab labels — and gate Phases 3+ on 0a landing.

Phase 0 is a **hard dependency for Phases 3–6**. Phases 1–2 do not depend on it beyond vocab labels; §6.4 labels delivery covers those. Until labels delivery exists, Phase 2 renders `activity_code` verbatim behind an i18n `journal.activity.<code>` key with an English fallback.

---

## Phase overview

| Phase | Deliverable | Depends on |
|---|---|---|
| 0 | Edge catalog-definitions + labels delivery (separate plan) | Slice 1 |
| 1 | `journalApi` client + `types/journal.ts` (foundation) | — |
| 2 | Reading surface: entry timeline on `JournalPage`, empty/unavailable states | 1 |
| 3 | Capture flow: activity picker → dose → confirm-by-reading → save states | 0, 1 |
| 4 | Multi-plot batch entry + plot/plot-group CRUD | 0, 1, 3 |
| 5 | Desktop three-pane workspace (scope rail / table / detail-entry panel) | 2, 3 |
| 6 | Chart markers on history, drafts queue, layout-transition review, locale mirror | 2, 3 |

Phases 1 and 2 are fully task-decomposed below and are executable now. Phases 3–6 are specified at file/interface/acceptance granularity; each is code-decomposed into its own plan section when reached, because their form shapes depend on the Phase 0 definition payload and on the real catalog data Phase 1 returns.

---

## Phase 1 — Foundation: `journalApi` client + types

**File Structure**
- Create `web/react-gui/src/types/journal.ts` — wire types for catalog, entry aggregate, plot, plot-group.
- Create `web/react-gui/src/services/journalApi.ts` — typed functions over the Slice-1 routes.
- Modify `web/react-gui/src/services/api.ts` — export the shared axios instance `api` so `journalApi` reuses its `baseURL` and 401→logout interceptor.
- Create `web/react-gui/src/services/__tests__/journalApi.test.ts` — mocked-axios contract tests.

### Task 1: Journal wire types

**Files:**
- Create: `web/react-gui/src/types/journal.ts`
- Test: none (types only; exercised by Task 3's tests)

**Interfaces:**
- Produces: `JournalCatalog`, `JournalVocabRow`, `JournalDefinitionRow`, `JournalProductRow`, `JournalMappingRow`, `EntryValue`, `EntryAggregate`, `JournalPlot`, `PlotGroup`, `EntryListResponse`, `EntryListFilters`.

- [ ] **Step 1: Write the types file**

```typescript
// web/react-gui/src/types/journal.ts
// Wire types for the Slice-1 field-journal REST contract. Snake_case mirrors
// the edge JSON exactly (see osi-journal/api.js catalogDto + buildAggregate).

export type VocabKind = 'activity' | 'attribute' | 'unit' | 'choice';
export type ValueType = 'number' | 'text' | 'choice' | 'date' | 'boolean';
export type ValueStatus = 'observed' | 'not_observed' | 'not_applicable' | 'below_detection';
export type EntryStatus = 'draft' | 'final' | 'voided';

export interface JournalVocabRow {
  code: string;
  kind: VocabKind;
  parent_code: string | null;
  value_type: ValueType | null;
  quantity_kind: string | null;
  basis: string | null;
  default_unit_code: string | null;
  icon_key: string | null;
  scope: 'core' | 'custom';
  active: number;
  sort_order: number | null;
  // labels_json + constraints_json are stripped by the DTO (Phase 0).
}

export interface JournalDefinitionRow {
  code: string;
  version: number;
  active: number;
  // definition_json + labels_json are stripped by the DTO (Phase 0).
}

export interface JournalProductRow {
  product_uuid: string;
  scope: 'core' | 'farm';
  name: string;
  kind: string;
  active: number;
  // composition_json is stripped by the DTO (Phase 0).
}

export interface JournalMappingRow {
  term_code: string;
  scheme_uri: string;
  scheme_version: string;
  mapping_role: string;
  external_id: string;
  mapping_relation: string;
}

export interface JournalCatalog {
  catalog_version: number;
  catalog_hash: string;
  vocab: JournalVocabRow[];
  templates: JournalDefinitionRow[];
  layouts: JournalDefinitionRow[];
  products: JournalProductRow[];
  mappings: JournalMappingRow[];
}

export interface EntryValue {
  group_index: number;
  attribute_code: string;
  value_status: ValueStatus;
  value_num: number | null;
  value_text: string | null;
  unit_code: string | null;
  entered_value_num: number | null;
  entered_unit_code: string | null;
}

export interface EntryAggregate {
  entry_uuid: string;
  plot_uuid: string | null;
  zone_uuid: string | null;
  device_eui: string | null;
  activity_code: string;
  template_code: string;
  template_version: number;
  layout_code: string;
  layout_version: number;
  occurred_start: string;
  occurred_end: string | null;
  occurred_timezone: string;
  status: EntryStatus;
  batch_uuid: string | null;
  pass_uuid: string | null;
  note: string | null;
  context_json: unknown | null;
  sync_version: number;
  recorded_at: string;
  values: EntryValue[];
}

export interface EntryListFilters {
  status?: EntryStatus | 'all';
  plot_uuid?: string;
  activity_code?: string;
  occurred_from?: string;
  occurred_to?: string;
  batch_uuid?: string;
  pass_uuid?: string;
  limit?: number;
  cursor?: string;
}

export interface EntryListResponse {
  entries: EntryAggregate[];
  next_cursor: string | null;
}

export interface JournalPlot {
  plot_uuid: string;
  plot_code: string;
  name: string | null;
  zone_uuid: string | null;
  station_code: string | null;
  crop_hint: string | null;
  area_m2: number | null;
  active: number;
}

export interface PlotGroup {
  group_uuid: string;
  label: string;
  resolved_at: string | null;
  member_plot_uuids: string[];
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web/react-gui && npx tsc --noEmit`
Expected: no errors referencing `types/journal.ts`.

- [ ] **Step 3: Commit**

```bash
git add web/react-gui/src/types/journal.ts
git commit -m "feat(journal): wire types for the Slice-1 REST contract"
```

### Task 2: Export the shared axios instance

**Files:**
- Modify: `web/react-gui/src/services/api.ts` (the `const api = axios.create(...)` declaration near the top)

**Interfaces:**
- Produces: named export `api` (the configured axios instance with `baseURL: '/'` and the 401→logout interceptor).

- [ ] **Step 1: Add the named export**

Find `const api = axios.create({` and ensure the instance is exported. Add, immediately after the interceptor setup block:

```typescript
// Shared client so feature modules (journalApi) reuse the baseURL,
// bearer header, and 401 -> logout interceptor.
export { api };
```

- [ ] **Step 2: Typecheck**

Run: `cd web/react-gui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/react-gui/src/services/api.ts
git commit -m "refactor(api): export the shared axios instance for feature modules"
```

### Task 3: `journalApi` client with contract tests

**Files:**
- Create: `web/react-gui/src/services/journalApi.ts`
- Test: `web/react-gui/src/services/__tests__/journalApi.test.ts`

**Interfaces:**
- Consumes: `api` (Task 2); types from Task 1.
- Produces: `journalApi.getCatalog(): Promise<JournalCatalog>`, `journalApi.listEntries(filters?: EntryListFilters): Promise<EntryListResponse>`, `journalApi.createEntry(payload): Promise<EntryAggregate>`, `journalApi.voidEntry(uuid, reason, baseVersion): Promise<EntryAggregate>`, `journalApi.listPlots(): Promise<JournalPlot[]>`, `journalApi.listPlotGroups(): Promise<PlotGroup[]>`, and `isJournalUnavailable(err): boolean`.

- [ ] **Step 1: Write the failing test**

```typescript
// web/react-gui/src/services/__tests__/journalApi.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('../api', () => ({ api: { get, post } }));

import { journalApi, isJournalUnavailable } from '../journalApi';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('journalApi', () => {
  it('fetches the catalog', async () => {
    get.mockResolvedValue({ data: { catalog_version: 1, catalog_hash: 'h', vocab: [], templates: [], layouts: [], products: [], mappings: [] } });
    const catalog = await journalApi.getCatalog();
    expect(get).toHaveBeenCalledWith('/api/journal/catalog');
    expect(catalog.catalog_version).toBe(1);
  });

  it('lists final entries by default and passes filters as query params', async () => {
    get.mockResolvedValue({ data: { entries: [], next_cursor: null } });
    await journalApi.listEntries({ plot_uuid: 'p1', limit: 20 });
    expect(get).toHaveBeenCalledWith('/api/journal/entries', { params: { plot_uuid: 'p1', limit: 20 } });
  });

  it('treats a 404 catalog as journal-unavailable', () => {
    expect(isJournalUnavailable({ response: { status: 404 } })).toBe(true);
    expect(isJournalUnavailable({ response: { status: 500 } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/services/__tests__/journalApi.test.ts`
Expected: FAIL — cannot resolve `../journalApi`.

- [ ] **Step 3: Write the client**

```typescript
// web/react-gui/src/services/journalApi.ts
import { api } from './api';
import type {
  JournalCatalog, EntryListFilters, EntryListResponse, EntryAggregate,
  JournalPlot, PlotGroup,
} from '../types/journal';

export interface CreateEntryPayload {
  plot_uuid: string | null;
  activity_code: string;
  template_code: string;
  layout_code: string;
  occurred_start: string;
  occurred_timezone: string;
  base_sync_version: 0;
  values: Array<Omit<EntryAggregate['values'][number], never>>;
  note?: string | null;
  batch_uuid?: string | null;
}

export const journalApi = {
  getCatalog: async (): Promise<JournalCatalog> =>
    (await api.get('/api/journal/catalog')).data,

  listEntries: async (filters: EntryListFilters = {}): Promise<EntryListResponse> =>
    (await api.get('/api/journal/entries', { params: filters })).data,

  createEntry: async (payload: CreateEntryPayload): Promise<EntryAggregate> =>
    (await api.post('/api/journal/entries', payload)).data,

  voidEntry: async (uuid: string, void_reason: string, base_sync_version: number): Promise<EntryAggregate> =>
    (await api.post(`/api/journal/entries/${encodeURIComponent(uuid)}/void`, { void_reason, base_sync_version })).data,

  listPlots: async (): Promise<JournalPlot[]> =>
    (await api.get('/api/journal/plots')).data,

  listPlotGroups: async (): Promise<PlotGroup[]> =>
    (await api.get('/api/journal/plot-groups')).data,
};

// A gateway without the Slice-1 journal backend answers /api/journal/* with
// 404/501; treat that as "feature not on this gateway", distinct from a real
// server error.
export function isJournalUnavailable(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || status === 501;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/services/__tests__/journalApi.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/services/journalApi.ts web/react-gui/src/services/__tests__/journalApi.test.ts
git commit -m "feat(journal): typed journalApi client over the Slice-1 routes"
```

---

## Phase 2 — Reading surface: entry timeline

Replace the `JournalPage` placeholder body with the real reading surface: a reverse-chron, final-only, filterable timeline (spec §6.3), an empty state, and a graceful "journal not available on this gateway" state when the catalog probe fails.

**File Structure**
- Create `web/react-gui/src/journal/useJournalCatalog.ts` — SWR catalog probe + availability.
- Create `web/react-gui/src/journal/useJournalEntries.ts` — SWR entry list with filters.
- Create `web/react-gui/src/components/journal/JournalEntryRow.tsx` — one timeline row.
- Create `web/react-gui/src/components/journal/JournalTimeline.tsx` — list + empty state.
- Modify `web/react-gui/src/pages/JournalPage.tsx` — mount the timeline; keep `AppHeader`.
- Modify `web/react-gui/public/locales/en/journal.json` — timeline strings.
- Tests alongside each component/hook.

### Task 4: Catalog availability hook

**Files:**
- Create: `web/react-gui/src/journal/useJournalCatalog.ts`
- Test: `web/react-gui/src/journal/__tests__/useJournalCatalog.test.ts`

**Interfaces:**
- Consumes: `journalApi.getCatalog`, `isJournalUnavailable` (Phase 1).
- Produces: `useJournalCatalog(): { catalog: JournalCatalog | undefined; available: boolean; loading: boolean; error: unknown }`.

- [ ] **Step 1: Write the failing test**

```typescript
// web/react-gui/src/journal/__tests__/useJournalCatalog.test.ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getCatalog = vi.fn();
vi.mock('../../services/journalApi', () => ({
  journalApi: { getCatalog: () => getCatalog() },
  isJournalUnavailable: (e: any) => e?.response?.status === 404,
}));

import { useJournalCatalog } from '../useJournalCatalog';

describe('useJournalCatalog', () => {
  it('reports available with the catalog when the probe succeeds', async () => {
    getCatalog.mockResolvedValue({ catalog_version: 1, vocab: [] });
    const { result } = renderHook(() => useJournalCatalog());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(true);
    expect(result.current.catalog?.catalog_version).toBe(1);
  });

  it('reports unavailable on a 404 probe', async () => {
    getCatalog.mockRejectedValue({ response: { status: 404 } });
    const { result } = renderHook(() => useJournalCatalog());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalCatalog.test.ts`
Expected: FAIL — cannot resolve `../useJournalCatalog`.

- [ ] **Step 3: Write the hook**

```typescript
// web/react-gui/src/journal/useJournalCatalog.ts
import useSWR from 'swr';
import { journalApi, isJournalUnavailable } from '../services/journalApi';
import type { JournalCatalog } from '../types/journal';

export function useJournalCatalog() {
  const { data, error, isLoading } = useSWR<JournalCatalog>(
    'journal:catalog',
    () => journalApi.getCatalog(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  return {
    catalog: data,
    available: !!data && !error,
    loading: isLoading,
    error: error && !isJournalUnavailable(error) ? error : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalCatalog.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/journal/useJournalCatalog.ts web/react-gui/src/journal/__tests__/useJournalCatalog.test.ts
git commit -m "feat(journal): catalog availability probe hook"
```

### Task 5: Entry list hook

**Files:**
- Create: `web/react-gui/src/journal/useJournalEntries.ts`
- Test: `web/react-gui/src/journal/__tests__/useJournalEntries.test.ts`

**Interfaces:**
- Consumes: `journalApi.listEntries` (Phase 1), `EntryListFilters`.
- Produces: `useJournalEntries(filters: EntryListFilters, enabled: boolean): { entries: EntryAggregate[]; loading: boolean; error: unknown }`.

- [ ] **Step 1: Write the failing test**

```typescript
// web/react-gui/src/journal/__tests__/useJournalEntries.test.ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const listEntries = vi.fn();
vi.mock('../../services/journalApi', () => ({ journalApi: { listEntries: (f: any) => listEntries(f) } }));

import { useJournalEntries } from '../useJournalEntries';

describe('useJournalEntries', () => {
  it('does not fetch when disabled', () => {
    renderHook(() => useJournalEntries({ status: 'final' }, false));
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('returns entries when enabled', async () => {
    listEntries.mockResolvedValue({ entries: [{ entry_uuid: 'e1' }], next_cursor: null });
    const { result } = renderHook(() => useJournalEntries({ status: 'final' }, true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalEntries.test.ts`
Expected: FAIL — cannot resolve `../useJournalEntries`.

- [ ] **Step 3: Write the hook**

```typescript
// web/react-gui/src/journal/useJournalEntries.ts
import useSWR from 'swr';
import { journalApi } from '../services/journalApi';
import type { EntryAggregate, EntryListFilters } from '../types/journal';

export function useJournalEntries(filters: EntryListFilters, enabled: boolean) {
  const key = enabled ? ['journal:entries', JSON.stringify(filters)] : null;
  const { data, error, isLoading } = useSWR(key, () => journalApi.listEntries(filters), {
    revalidateOnFocus: false,
  });
  const entries: EntryAggregate[] = data?.entries ?? [];
  return { entries, loading: enabled && isLoading, error };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalEntries.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/journal/useJournalEntries.ts web/react-gui/src/journal/__tests__/useJournalEntries.test.ts
git commit -m "feat(journal): entry list hook (SWR, filter-keyed)"
```

### Task 6: Entry row component

**Files:**
- Create: `web/react-gui/src/components/journal/JournalEntryRow.tsx`
- Test: `web/react-gui/src/components/journal/__tests__/JournalEntryRow.test.tsx`
- Modify: `web/react-gui/public/locales/en/journal.json` (add `activity.<code>` fallbacks + `row.*` keys)

**Interfaces:**
- Consumes: `EntryAggregate`.
- Produces: `<JournalEntryRow entry={EntryAggregate} />` — a solid card row showing localized activity, plot, occurred date, and a status chip.

- [ ] **Step 1: Add locale keys**

Add to `web/react-gui/public/locales/en/journal.json`:

```json
"row": {
  "farmLevel": "Farm-level",
  "status": { "final": "Final", "draft": "Draft", "voided": "Voided" }
},
"activity": {
  "irrigation": "Irrigation",
  "fertigation": "Fertigation",
  "fertilization": "Fertilization",
  "seeding": "Seeding",
  "harvest": "Harvest",
  "general_observation": "Observation"
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// web/react-gui/src/components/journal/__tests__/JournalEntryRow.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { JournalEntryRow } from '../JournalEntryRow';

const entry = {
  entry_uuid: 'e1', activity_code: 'irrigation', plot_uuid: 'p1', status: 'final',
  occurred_start: '2026-07-10T08:00:00.000Z', values: [],
} as any;

describe('JournalEntryRow', () => {
  it('shows the activity key and a status chip', () => {
    render(<JournalEntryRow entry={entry} />);
    expect(screen.getByText('activity.irrigation')).toBeInTheDocument();
    expect(screen.getByText('row.status.final')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/components/journal/__tests__/JournalEntryRow.test.tsx`
Expected: FAIL — cannot resolve `../JournalEntryRow`.

- [ ] **Step 4: Write the component**

```typescript
// web/react-gui/src/components/journal/JournalEntryRow.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { EntryAggregate } from '../../types/journal';

export const JournalEntryRow: React.FC<{ entry: EntryAggregate }> = ({ entry }) => {
  const { t } = useTranslation('journal');
  const date = new Date(entry.occurred_start).toLocaleDateString();
  const statusClass =
    entry.status === 'final'
      ? 'bg-[var(--success-bg)] text-[var(--success-text)]'
      : 'bg-[var(--warn-bg)] text-[var(--warn-text)]';
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-bold text-[var(--text)]">
          {t(`activity.${entry.activity_code}`, entry.activity_code)}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {entry.plot_uuid ?? t('row.farmLevel')} · {date}
        </p>
      </div>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${statusClass}`}>
        {t(`row.status.${entry.status}`)}
      </span>
    </div>
  );
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/components/journal/__tests__/JournalEntryRow.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add web/react-gui/src/components/journal/JournalEntryRow.tsx web/react-gui/src/components/journal/__tests__/JournalEntryRow.test.tsx web/react-gui/public/locales/en/journal.json
git commit -m "feat(journal): timeline entry row"
```

### Task 7: Timeline + JournalPage wiring

**Files:**
- Create: `web/react-gui/src/components/journal/JournalTimeline.tsx`
- Modify: `web/react-gui/src/pages/JournalPage.tsx`
- Modify: `web/react-gui/public/locales/en/journal.json` (add `timeline.*`, `unavailable.*`, `logActivity`)
- Test: `web/react-gui/src/components/journal/__tests__/JournalTimeline.test.tsx`

**Interfaces:**
- Consumes: `JournalEntryRow` (Task 6), `EntryAggregate`.
- Produces: `<JournalTimeline entries={EntryAggregate[]} loading={boolean} />` (empty state when `!loading && entries.length === 0`).

- [ ] **Step 1: Add locale keys**

Add to `journal.json`: `"timeline": { "empty": "No activities logged yet.", "loading": "Loading activities…" }`, `"unavailable": { "title": "Journal not available", "body": "This gateway does not yet have the field journal. Update the gateway firmware to enable it." }`, `"logActivity": "Log activity"`.

- [ ] **Step 2: Write the failing test**

```typescript
// web/react-gui/src/components/journal/__tests__/JournalTimeline.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { JournalTimeline } from '../JournalTimeline';

describe('JournalTimeline', () => {
  it('shows the empty state when there are no entries', () => {
    render(<JournalTimeline entries={[]} loading={false} />);
    expect(screen.getByText('timeline.empty')).toBeInTheDocument();
  });

  it('renders a row per entry', () => {
    const entries = [
      { entry_uuid: 'e1', activity_code: 'irrigation', plot_uuid: 'p1', status: 'final', occurred_start: '2026-07-10T08:00:00.000Z', values: [] },
      { entry_uuid: 'e2', activity_code: 'harvest', plot_uuid: null, status: 'final', occurred_start: '2026-07-09T08:00:00.000Z', values: [] },
    ] as any;
    render(<JournalTimeline entries={entries} loading={false} />);
    expect(screen.getByText('activity.irrigation')).toBeInTheDocument();
    expect(screen.getByText('activity.harvest')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/components/journal/__tests__/JournalTimeline.test.tsx`
Expected: FAIL — cannot resolve `../JournalTimeline`.

- [ ] **Step 4: Write the timeline**

```typescript
// web/react-gui/src/components/journal/JournalTimeline.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { EntryAggregate } from '../../types/journal';
import { JournalEntryRow } from './JournalEntryRow';

interface Props { entries: EntryAggregate[]; loading: boolean; }

export const JournalTimeline: React.FC<Props> = ({ entries, loading }) => {
  const { t } = useTranslation('journal');
  if (loading) {
    return <p className="text-[var(--text-secondary)]">{t('timeline.loading')}</p>;
  }
  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[var(--text-secondary)]">
        {t('timeline.empty')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {entries.map((e) => <JournalEntryRow key={e.entry_uuid} entry={e} />)}
    </div>
  );
};
```

- [ ] **Step 5: Rewrite `JournalPage` body to mount the timeline**

Replace the placeholder `<main>` content in `web/react-gui/src/pages/JournalPage.tsx` with:

```typescript
// imports at top:
import { useJournalCatalog } from '../journal/useJournalCatalog';
import { useJournalEntries } from '../journal/useJournalEntries';
import { JournalTimeline } from '../components/journal/JournalTimeline';

// inside the component, after useAuth:
const { available, loading: catalogLoading } = useJournalCatalog();
const { entries, loading: entriesLoading } = useJournalEntries({ status: 'final', limit: 50 }, available);

// <main> body:
<main className="mx-auto max-w-3xl px-4 py-8">
  {catalogLoading ? (
    <p className="text-[var(--text-secondary)]">{t('timeline.loading')}</p>
  ) : !available ? (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8">
      <h2 className="text-xl font-bold text-[var(--text)]">{t('unavailable.title')}</h2>
      <p className="mt-2 text-[var(--text-secondary)]">{t('unavailable.body')}</p>
    </div>
  ) : (
    <>
      <div className="mb-4 flex justify-end">
        <button type="button" className="btn-liquid-red rounded-lg px-5 py-2.5 font-bold">
          {t('logActivity')}
        </button>
      </div>
      <JournalTimeline entries={entries} loading={entriesLoading} />
    </>
  )}
</main>
```

- [ ] **Step 6: Run tests + typecheck + build**

Run: `cd web/react-gui && npx vitest run src/components/journal src/journal && npx tsc --noEmit && npm run build`
Expected: all journal tests PASS; tsc clean; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/react-gui/src/components/journal/JournalTimeline.tsx web/react-gui/src/pages/JournalPage.tsx web/react-gui/public/locales/en/journal.json web/react-gui/src/components/journal/__tests__/JournalTimeline.test.tsx
git commit -m "feat(journal): reading-surface timeline on the Journal page with empty + unavailable states"
```

**Phase 2 acceptance:** on a Slice-1 gateway the Journal tab lists final entries newest-first with an empty state; on a pre-journal gateway it shows the unavailable card instead of an error; `Log activity` is present (wired in Phase 3).

---

## Phase 3 — Capture flow (code-decompose when Phase 0 lands)

**Blocked on Phase 0** (needs template/layout `definition_json` + vocab labels/constraints + product composition).

**Files (planned):** `src/components/journal/capture/` — `ActivityPicker.tsx` (U1 shortlist grid + type-ahead + browse-all tree), `EntryForm.tsx` (template-engine renderer driven by `definition_json`: sections → fields, `required_if`/`visible_if`), `NumberStepper.tsx` (P6), `NutrientRepeater.tsx` (P5), `ConfirmStrip.tsx` (P2 read-back sentence), `SaveState.tsx` (four honest states, spec §6.1), `useCaptureDraft.ts` (stable draft UUID, debounced serialized saves, leave-guard). `src/journal/templateEngine.ts` — pure predicate evaluator (`required_if`/`visible_if`), carry-forward classification (P4), unit resolution (P5/STD-1). Entry point: the zone-card "Log activity" CTA + the Add-menu item already routing to `/journal`.

**Interfaces (planned):** `evaluateVisibility(definition, values): FieldState[]`; `buildCreatePayload(form): CreateEntryPayload`; `<ActivityPicker onPick={(activity_code) => …} recents={…} />`.

**Acceptance:** ≤5 primary-control activations from zone CTA to acknowledged save for a common carried-forward entry (spec §6.1) at 320×568 with no horizontal scroll; product/dose/target/waiting-period never silently carried (P4/AGR-7 — explicit "Repeat last treatment" card); confirm-by-reading strip repeats interpreted value + unit before finalize; the four save states render distinctly and a mid-edit failure keeps a sticky loss warning.

## Phase 4 — Multi-plot batch + plot/group CRUD (code-decompose when reached)

**Blocked on Phases 0, 1, 3.**

**Files (planned):** `src/components/journal/where/` — `PlotPicker.tsx`, `StationGrid.tsx` (numbered multi-select + range input `2, 5, 6, 10-12`, U7), `PlotGroupChips.tsx` (one-tap cohort select), `PlotForm.tsx` (lightweight CRUD). `src/journal/rangeSelection.ts` — pure `parseRange('2,5,6,10-12'): number[]` / `formatRange(number[]): string`, station-bounded.

**Acceptance:** a station renders as one collapsible row expanding to a grid, never a list; batch finalize fans out to N create calls sharing a client-generated `batch_uuid`; a harvest batch covering a whole active group offers "Resolve group?"; range field and grid stay in sync.

## Phase 5 — Desktop three-pane workspace (code-decompose when reached)

**Blocked on Phases 2, 3.**

**Files (planned):** `src/components/journal/desktop/` — `JournalWorkspace.tsx` (3-column grid ≥1024px), `ScopeRail.tsx` (stations collapsible, active groups, ungrouped plots, filters), `EntryTable.tsx` (dense sortable keyset-paged rows, bulk export selection), `DetailPanel.tsx` (read-back + context snapshot + void/correct, or the persistent entry/enrichment form). `JournalPage` branches on `isDesktopBrowser()` between the mobile flow and `JournalWorkspace`, per the AppHeader Data-tab precedent.

**Acceptance:** the rail lists a 72-plot station as one row; the same `EntryForm` engine renders as a side panel; keyboard navigation between table rows and form fields; exports scoped to active filters sit on the table header.

## Phase 6 — Chart markers, drafts queue, layout-transition review, locale mirror (code-decompose when reached)

**Blocked on Phases 2, 3.**

**Files (planned):** `src/components/journal/markers/JournalMarkerLane.tsx` + integration into the history chart surfaces (`src/components/history/visualizations/`) — separate event lane, icon+shape+color (not color alone), ≥48px hit targets, rendered-distance clustering with counts, bottom sheet; `src/components/journal/DraftsQueue.tsx` (P7 "needs completion"); layout-transition review sheet blocking finalize (UX-3); then add `journal` to the feed locale mirror in `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/` and extend `tests/agrolinkBranding.test.ts` to enforce it.

**Acceptance:** marker density tested at 0/1/50/500 events at 320px over 24h and season ranges; drafts queue opens the detail panel with field-level focus on what is missing; the locale mirror test covers `journal.json`.

---

## Self-review

- **Spec coverage:** §6.1 entry/save/carry-forward → Phase 3; §6.2 templates×layouts → Phase 3 (`templateEngine`); §6.3 timeline → Phase 2, markers → Phase 6; §6.4 i18n → Phase 6 + the per-task English keys; D10 plot-first/no-zone → Phases 2–4; D11 batch/stations/groups → Phase 4; P7 capture→enrich → Phases 3/5/6. The one gap the spec does not name — the catalog DTO stripping definitions/labels — is captured as the Phase 0 prerequisite.
- **Placeholder scan:** Phases 1–2 carry complete code in every step. Phases 3–6 are deliberately specified at file/interface/acceptance level, not stubbed code, because their forms depend on the Phase 0 payload; each is a "code-decompose when reached" section, not a hidden TODO.
- **Type consistency:** `journalApi`, `CreateEntryPayload`, `EntryAggregate`, `EntryListFilters`, `useJournalCatalog`, `useJournalEntries`, `JournalEntryRow`, `JournalTimeline` names are used identically across the tasks that define and consume them.
