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
| `/api/journal/entries` | POST | final: `{ entry_uuid, outbox_event_uuid, sync_version }`; draft: `{ entry_uuid, sync_version: 0 }` (201) |
| `/api/journal/entries/:uuid` | PUT | final: `{ entry_uuid, outbox_event_uuid, sync_version }`; draft: `{ entry_uuid, sync_version: 0 }` |
| `/api/journal/entries/:uuid/void` | POST | `{ entry_uuid, outbox_event_uuid, sync_version }` |
| `/api/journal/plots` | GET | `{ plots: JournalPlot[] }` |
| `/api/journal/plots` | POST/PUT | `{ plot, outbox_event_uuid, created }` |
| `/api/journal/plot-groups` | GET | `{ plot_groups: PlotGroup[] }` |
| `/api/journal/plot-groups` | POST/PUT | `{ plot_group, outbox_event_uuid, created }` |
| `/api/journal/export.{csv,package,json,adapt.json}` | GET | streamed export |

**Entries list filters** (`normalizeEntryFilters`): `status` (`draft`\|`final`\|`voided`\|`all`, default `final`), `plot_uuid`, `activity_code`, `occurred_from`/`occurred_to` (ISO), `campaign_uuid`, `protocol_code`, `protocol_version`, `observation_unit_code`, `batch_uuid`, `pass_uuid`, `limit` (default 50, max 100), `cursor` (opaque, filter-bound — a cursor is rejected if the other filters change).

**EntryAggregate** (`buildAggregate`): every sync-visible `journal_entries` column in snake_case plus `values: EntryValue[]`. `context_json` remains the frozen JSON string stored by the edge, or `null`; consumers parse it only when they need the snapshot. **EntryValue**: `{ group_index, attribute_code, value_status, value_num, value_text, unit_code, entered_value_num, entered_unit_code }`, sorted by `(group_index, attribute_code)`.

**Mutation response:** entry create/update/void returns a receipt, not the saved aggregate. Final and void receipts carry `outbox_event_uuid`; draft saves stay local and return `{ entry_uuid, sync_version: 0 }`. The client reloads the relevant entry list after a successful receipt. Entry writes require explicit `status: 'draft' | 'final'`, pinned template/layout versions, `occurred_start_local`, and a write-value shape whose semantic input is `value` (with the stored `value_num`/`value_text` forms accepted for correction compatibility).

**Collection wrappers:** plot reads return `{ plots }`; plot-group reads return `{ plot_groups }`. A plot group exposes its sorted member UUIDs as `members`.

### 2026-07-16 blocker amendment

sol's Phase 1 preflight found that the original Task 1/3 snippets described aggregate mutation responses, unwrapped plot collections, `member_plot_uuids`, and a create payload without `status`. Current `osi-journal/api.js` and `lifecycle.js` contradict those shapes. The corrected tasks below are authoritative for execution. They also add `src/services/__tests__` to the full Vitest runner so `npm run test:unit` executes the new contract tests instead of leaving them reachable only through a targeted command.

**Catalog DTO** (`catalogDto`): `{ catalog_version, catalog_hash, vocab[], templates[], layouts[], products[], mappings[] }`. Each `vocab` row is a `journal_vocab` row **with `labels_json` and `constraints_json` removed**; each `templates`/`layouts` row has **`definition_json` and `labels_json` removed**; each `products` row has **`composition_json` removed**.

### Phase 0 prerequisite — the catalog DTO is a version index, not a form source

The capture flow (Phase 3+) cannot render forms from this DTO: template/layout `definition_json` (sections, fields, `required_if`/`visible_if`, defaults, carry-forward classes), vocab `labels_json` and `constraints_json`, and product `composition_json` (nutrient derivation, U5) are all stripped. The reading surface (Phase 2) needs vocab labels to render activity names.

**Phase 0 resolves this before Phase 3 starts.** Decide and implement one of:

- **0a (recommended):** add a `?include=definitions` edge response that returns parsed `definition`, `constraints`, `composition`, and `labels` for the owner-scoped catalog. Planned in full as `docs/superpowers/plans/2026-07-15-field-journal-slice2-phase0-catalog-definitions.md` (edge-only, additive, both profiles; no schema or flows.json change).
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
- Produces: catalog row/definition types, `EntryValue` plus `EntryValueInput`, `EntryAggregate`, `EntryMutationReceipt`, `JournalPlot`, `PlotGroup`, collection wrappers, `EntryListResponse`, and `EntryListFilters`.

- [ ] **Step 1: Write the types file**

```typescript
// web/react-gui/src/types/journal.ts
// Wire types for the Slice-1 field-journal REST contract. Snake_case mirrors
// osi-journal/api.js catalogDto/plotAggregate/plotGroupAggregate and
// osi-journal/aggregate.js buildAggregate.

export type JsonObject = Record<string, unknown>;
export type VocabKind = 'activity' | 'attribute' | 'unit' | 'choice';
export type ValueType = 'number' | 'text' | 'choice' | 'date' | 'boolean';
export type ValueStatus = 'observed' | 'not_observed' | 'not_applicable' | 'below_detection';
export type EntryStatus = 'draft' | 'final' | 'voided';
export type EntryWriteStatus = Exclude<EntryStatus, 'voided'>;

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
  owner_user_uuid: string | null;
  gateway_device_eui: string | null;
  custom_field_uuid: string | null;
  active: number;
  sort_order: number;
  sync_version: number;
  created_at: string;
  deleted_at: string | null;
  labels?: Record<string, string>;
  constraints?: JsonObject | null;
  catalog_errors: string[];
}

export interface JournalDefinitionRow {
  code: string;
  version: number;
  active: number;
  labels?: Record<string, string>;
  definition?: JsonObject;
  catalog_errors: string[];
}

export interface JournalProductRow {
  product_uuid: string;
  scope: 'core' | 'farm';
  owner_user_uuid: string | null;
  gateway_device_eui: string | null;
  name: string;
  kind: 'mineral' | 'organic_amendment' | 'plant_protection' | 'other';
  active: number;
  sync_version: number;
  created_at: string;
  deleted_at: string | null;
  composition?: JsonObject;
  catalog_errors: string[];
}

export interface JournalMappingRow {
  term_code: string;
  scheme_uri: string;
  scheme_version: string;
  mapping_role: string;
  external_id: string;
  external_parent_id: string | null;
  mapping_relation: string;
  source_uri: string | null;
  active: number;
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

export interface EntryValueInput {
  group_index?: number;
  attribute_code: string;
  value_status?: ValueStatus;
  value?: string | number | boolean | null;
  value_num?: number | null;
  value_text?: string | null;
  unit_code?: string | null;
  entered_value_num?: number | null;
  entered_unit_code?: string | null;
}

export interface EntryAggregate {
  contract_version: number;
  entry_uuid: string;
  owner_user_uuid: string;
  author_principal_uuid: string;
  author_label: string | null;
  gateway_device_eui: string;
  plot_uuid: string | null;
  zone_uuid: string | null;
  device_eui: string | null;
  season_uuid: string | null;
  season_crop: string | null;
  season_variety: string | null;
  campaign_uuid: string | null;
  protocol_code: string | null;
  protocol_version: string | null;
  observation_unit_code: string | null;
  activity_code: string;
  template_code: string;
  template_version: number;
  layout_code: string;
  layout_version: number;
  catalog_version: number;
  occurred_start: string;
  occurred_end: string | null;
  occurred_timezone: string;
  occurred_utc_offset_minutes: number;
  origin: 'edge-ui' | 'cloud-ui';
  status: EntryStatus;
  batch_uuid: string | null;
  pass_uuid: string | null;
  voided_at: string | null;
  voided_by_principal_uuid: string | null;
  void_reason: string | null;
  note: string | null;
  context_json: string | null;
  sync_version: number;
  recorded_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  values: EntryValue[];
}

export interface EntryDraftMutationReceipt {
  entry_uuid: string;
  sync_version: 0;
  outbox_event_uuid?: never;
}

export interface EntryFinalMutationReceipt {
  entry_uuid: string;
  outbox_event_uuid: string;
  sync_version: number;
}

export type EntryMutationReceipt = EntryDraftMutationReceipt | EntryFinalMutationReceipt;

export interface EntryListFilters {
  entry_uuid?: string;
  status?: EntryStatus | 'all';
  plot_uuid?: string;
  zone_uuid?: string;
  activity_code?: string;
  occurred_from?: string;
  occurred_to?: string;
  campaign_uuid?: string;
  protocol_code?: string;
  protocol_version?: string;
  observation_unit_code?: string;
  batch_uuid?: string;
  pass_uuid?: string;
  limit?: number;
  cursor?: string;
}

export interface EntryListResponse {
  entries: EntryAggregate[];
  next_cursor: string | null;
}

export interface JournalPlotSettings {
  layout_code: string;
  updated_at: string;
  updated_by_principal_uuid: string;
  sync_version: number;
}

export interface JournalPlot {
  contract_version: number;
  plot_uuid: string;
  plot_code: string;
  name: string | null;
  zone_uuid: string | null;
  station_code: string | null;
  crop_hint: string | null;
  area_m2: number | null;
  active: number;
  sync_version: number;
  owner_user_uuid: string;
  gateway_device_eui: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  settings: JournalPlotSettings;
}

export interface PlotGroup {
  contract_version: number;
  group_uuid: string;
  label: string;
  owner_user_uuid: string;
  gateway_device_eui: string;
  created_by_principal_uuid: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by_principal_uuid: string | null;
  sync_version: number;
  deleted_at: string | null;
  members: string[];
}

export interface JournalPlotListResponse { plots: JournalPlot[]; }
export interface PlotGroupListResponse { plot_groups: PlotGroup[]; }
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
- Modify: `web/react-gui/package.json` — add the service test directory to `test:unit:vitest`.

**Interfaces:**
- Consumes: `api` (Task 2); types from Task 1.
- Produces: `journalApi.getCatalog(options?): Promise<JournalCatalog>`, `journalApi.listEntries(filters?): Promise<EntryListResponse>`, `journalApi.createEntry(payload): Promise<EntryMutationReceipt>`, `journalApi.updateEntry(uuid, payload): Promise<EntryMutationReceipt>`, `journalApi.voidEntry(uuid, reason, baseVersion): Promise<EntryFinalMutationReceipt>`, `journalApi.listPlots(): Promise<JournalPlot[]>`, `journalApi.listPlotGroups(): Promise<PlotGroup[]>`, and `isJournalUnavailable(err): boolean`.

`updateEntry` is required even before the drafts queue UI lands: POST is
create-only, while draft promotion and final-entry correction use PUT with the
path UUID and current `base_sync_version`. Omitting PUT would make a locally
saved draft impossible to finalize.

- [ ] **Step 1: Write the failing test**

```typescript
// web/react-gui/src/services/__tests__/journalApi.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get, post, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('../api', () => ({ api: { get, post, put } }));

import { journalApi, isJournalUnavailable } from '../journalApi';
import type { CreateEntryPayload, UpdateEntryPayload } from '../journalApi';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
});

describe('journalApi', () => {
  it('fetches the light catalog by default and requests definitions explicitly', async () => {
    get.mockResolvedValue({ data: { catalog_version: 1, catalog_hash: 'h', vocab: [], templates: [], layouts: [], products: [], mappings: [] } });
    await journalApi.getCatalog();
    expect(get).toHaveBeenCalledWith('/api/journal/catalog');
    await journalApi.getCatalog({ includeDefinitions: true });
    expect(get).toHaveBeenLastCalledWith('/api/journal/catalog', { params: { include: 'definitions' } });
  });

  it('passes entry filters as query params', async () => {
    get.mockResolvedValue({ data: { entries: [], next_cursor: null } });
    await journalApi.listEntries({ plot_uuid: 'p1', limit: 20 });
    expect(get).toHaveBeenCalledWith('/api/journal/entries', { params: { plot_uuid: 'p1', limit: 20 } });
  });

  it('sends an explicit write status and preserves final versus draft receipts', async () => {
    const payload: CreateEntryPayload = {
      base_sync_version: 0,
      status: 'final',
      plot_uuid: '11111111-1111-4111-8111-111111111111',
      activity_code: 'irrigation',
      template_code: 'farmer_quick',
      template_version: 1,
      layout_code: 'open_field',
      layout_version: 1,
      occurred_start_local: '2026-07-16T08:30:00',
      occurred_timezone: 'Europe/Zurich',
      values: [{ attribute_code: 'attr.irrigation_depth', value: 12, unit_code: 'unit.mm_water' }],
    };
    post
      .mockResolvedValueOnce({ data: { entry_uuid: 'e1', outbox_event_uuid: 'o1', sync_version: 1 } })
      .mockResolvedValueOnce({ data: { entry_uuid: 'e2', sync_version: 0 } });
    await expect(journalApi.createEntry(payload)).resolves.toEqual({
      entry_uuid: 'e1', outbox_event_uuid: 'o1', sync_version: 1,
    });
    expect(post).toHaveBeenCalledWith('/api/journal/entries', payload);
    const draftPayload: CreateEntryPayload = { ...payload, entry_uuid: 'e2', status: 'draft' };
    await expect(journalApi.createEntry(draftPayload)).resolves.toEqual({
      entry_uuid: 'e2', sync_version: 0,
    });
    expect(post).toHaveBeenLastCalledWith('/api/journal/entries', draftPayload);
  });

  it('unwraps plot and plot-group collection responses', async () => {
    get
      .mockResolvedValueOnce({ data: { plots: [{ plot_uuid: 'p1' }] } })
      .mockResolvedValueOnce({ data: { plot_groups: [{ group_uuid: 'g1', members: ['p1'] }] } });
    await expect(journalApi.listPlots()).resolves.toEqual([{ plot_uuid: 'p1' }]);
    await expect(journalApi.listPlotGroups()).resolves.toEqual([{ group_uuid: 'g1', members: ['p1'] }]);
  });

  it('promotes an existing draft through the UUID-encoded PUT route', async () => {
    const payload: UpdateEntryPayload = {
      base_sync_version: 0,
      status: 'final',
      plot_uuid: '11111111-1111-4111-8111-111111111111',
      activity_code: 'irrigation',
      template_code: 'farmer_quick',
      template_version: 1,
      layout_code: 'open_field',
      layout_version: 1,
      occurred_start_local: '2026-07-16T08:30:00',
      occurred_timezone: 'Europe/Zurich',
      values: [{ attribute_code: 'attr.irrigation_depth', value: 12, unit_code: 'unit.mm_water' }],
    };
    const receipt = { entry_uuid: 'e1/segment', outbox_event_uuid: 'o2', sync_version: 1 };
    put.mockResolvedValue({ data: receipt });
    await expect(journalApi.updateEntry('e1/segment', payload)).resolves.toEqual(receipt);
    expect(put).toHaveBeenCalledWith('/api/journal/entries/e1%2Fsegment', payload);
  });

  it('posts the void reason and current sync version', async () => {
    post.mockResolvedValue({ data: { entry_uuid: 'e1', outbox_event_uuid: 'o2', sync_version: 2 } });
    await journalApi.voidEntry('e1', 'Duplicate', 1);
    expect(post).toHaveBeenCalledWith('/api/journal/entries/e1/void', {
      void_reason: 'Duplicate', base_sync_version: 1,
    });
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
  JournalCatalog, EntryListFilters, EntryListResponse, EntryMutationReceipt,
  EntryFinalMutationReceipt,
  EntryValueInput, EntryWriteStatus, JournalPlot, JournalPlotListResponse,
  PlotGroup, PlotGroupListResponse,
} from '../types/journal';

export interface JournalCatalogOptions {
  includeDefinitions?: boolean;
}

interface EntryWritePayload {
  status: EntryWriteStatus;
  plot_uuid: string | null;
  activity_code: string;
  template_code: string;
  template_version: number;
  layout_code: string;
  layout_version: number;
  occurred_start_local: string;
  occurred_end_local?: string | null;
  occurred_timezone: string;
  values: EntryValueInput[];
  note?: string | null;
  batch_uuid?: string | null;
}

export interface CreateEntryPayload extends EntryWritePayload {
  entry_uuid?: string;
  base_sync_version: 0;
}

export interface UpdateEntryPayload extends EntryWritePayload {
  entry_uuid?: string;
  base_sync_version: number;
}

export const journalApi = {
  getCatalog: async (options: JournalCatalogOptions = {}): Promise<JournalCatalog> => {
    if (options.includeDefinitions) {
      return (await api.get<JournalCatalog>('/api/journal/catalog', {
        params: { include: 'definitions' },
      })).data;
    }
    return (await api.get<JournalCatalog>('/api/journal/catalog')).data;
  },

  listEntries: async (filters: EntryListFilters = {}): Promise<EntryListResponse> =>
    (await api.get<EntryListResponse>('/api/journal/entries', { params: filters })).data,

  createEntry: async (payload: CreateEntryPayload): Promise<EntryMutationReceipt> =>
    (await api.post<EntryMutationReceipt>('/api/journal/entries', payload)).data,

  updateEntry: async (uuid: string, payload: UpdateEntryPayload): Promise<EntryMutationReceipt> =>
    (await api.put<EntryMutationReceipt>(
      `/api/journal/entries/${encodeURIComponent(uuid)}`,
      payload,
    )).data,

  voidEntry: async (uuid: string, void_reason: string, base_sync_version: number): Promise<EntryFinalMutationReceipt> =>
    (await api.post<EntryFinalMutationReceipt>(
      `/api/journal/entries/${encodeURIComponent(uuid)}/void`,
      { void_reason, base_sync_version },
    )).data,

  listPlots: async (): Promise<JournalPlot[]> =>
    (await api.get<JournalPlotListResponse>('/api/journal/plots')).data.plots,

  listPlotGroups: async (): Promise<PlotGroup[]> =>
    (await api.get<PlotGroupListResponse>('/api/journal/plot-groups')).data.plot_groups,
};

// A gateway without the Slice-1 journal backend answers /api/journal/* with
// 404/501; treat that as "feature not on this gateway", distinct from a real
// server error.
export function isJournalUnavailable(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || status === 501;
}
```

- [ ] **Step 4: Add the service contract tests to the full unit gate**

In `web/react-gui/package.json`, append `src/services/__tests__` to the `test:unit:vitest` command before `--passWithNoTests`:

```json
"test:unit:vitest": "vitest run src/analysis/__tests__ src/components/analysis/__tests__ src/components/farming/__tests__ src/components/history/__tests__ src/components/__tests__ src/pages/__tests__ src/utils/__tests__ src/channels/__tests__ src/history/__tests__ src/branding/__tests__ src/services/__tests__ --passWithNoTests"
```

- [ ] **Step 5: Run the targeted test, full unit gate, and typecheck**

Run: `cd web/react-gui && npx vitest run src/services/__tests__/journalApi.test.ts`
Expected: PASS (7 tests).

Run: `cd web/react-gui && npm run test:unit && npx tsc --noEmit`
Expected: both unit runners pass, including `journalApi.test.ts`; TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/react-gui/src/services/journalApi.ts web/react-gui/src/services/__tests__/journalApi.test.ts web/react-gui/package.json
git commit -m "feat(journal): typed journalApi client over the Slice-1 routes"
```

**Phase 1 acceptance:** the shared axios instance remains the only auth/interceptor boundary; the typed client requests full catalog definitions only when asked, sends the actual Slice-1 entry-write shape over create and update routes, can promote a version-zero draft through PUT, returns mutation receipts, unwraps plot/group list envelopes, and its seven contract tests run under `npm run test:unit`.

---

## Phase 2 — Reading surface: entry timeline

Replace the `JournalPage` placeholder body with the real reading surface: a reverse-chron, final-only, filterable timeline (spec §6.3), an empty state, and a graceful "journal not available on this gateway" state when the catalog probe fails.

### 2026-07-16 Phase 2 preflight amendment

The unavailable state is reserved for the capability responses recognized by
`isJournalUnavailable` (`404` and `501`). A timeout, `401`, or `5xx` response is
an operational error, not evidence that the gateway lacks the journal. The
catalog hook therefore exposes `unavailable` separately from `error`, and the
page renders a retryable error card for non-capability failures.

Hook tests use an isolated `SWRConfig` cache and hoisted mocks. The Phase 2
prep commit adds both new test directories to the normal Vitest command. Task 7
adds page-level tests for loading,
unavailable, transient-error, and available states. These are normal unit-gate
inputs, not targeted-test-only coverage.

Before Tasks 4–6 run in parallel, make one Phase 2 prep commit that registers
both `src/journal/__tests__` and `src/components/journal/__tests__` in
`test:unit:vitest`. This gives `package.json` one owner and keeps Tasks 4–6
independent. Run `npm run test:unit` and commit the package-only change as
`test(journal): discover Phase 2 unit suites`.

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
- Test: `web/react-gui/src/journal/__tests__/useJournalCatalog.test.tsx`

**Interfaces:**
- Consumes: `journalApi.getCatalog`, `isJournalUnavailable` (Phase 1).
- Produces: `useJournalCatalog(): { catalog: JournalCatalog | undefined; available: boolean; unavailable: boolean; loading: boolean; error: unknown; retry: () => Promise<JournalCatalog | undefined> }`.

- [ ] **Step 1: Write the failing test**

```typescript
// web/react-gui/src/journal/__tests__/useJournalCatalog.test.tsx
import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { getCatalog, isJournalUnavailable } = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  isJournalUnavailable: vi.fn((e: any) => [404, 501].includes(e?.response?.status)),
}));
vi.mock('../../services/journalApi', () => ({
  journalApi: { getCatalog: () => getCatalog() },
  isJournalUnavailable,
}));

import { loadJournalCatalog, useJournalCatalog } from '../useJournalCatalog';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useJournalCatalog', () => {
  beforeEach(() => getCatalog.mockReset());

  it('reports available with the catalog when the probe succeeds', async () => {
    getCatalog.mockResolvedValue({ catalog_version: 1, vocab: [] });
    const { result } = renderHook(() => useJournalCatalog(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(true);
    expect(result.current.unavailable).toBe(false);
    expect(result.current.catalog?.catalog_version).toBe(1);
  });

  it.each([404, 501])('reports unavailable on a %s capability response', async (status) => {
    getCatalog.mockRejectedValue({ response: { status } });
    await expect(loadJournalCatalog()).resolves.toBeNull();
    const { result } = renderHook(
      () => useJournalCatalog(() => Promise.resolve(null)),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.available).toBe(false);
    expect(result.current.unavailable).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it('keeps operational failures distinct and exposes retry', async () => {
    const failure = { response: { status: 500 } };
    getCatalog.mockRejectedValueOnce(failure).mockResolvedValueOnce({ catalog_version: 1 });
    const { result } = renderHook(() => useJournalCatalog(), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.unavailable).toBe(false);
    await act(async () => { await result.current.retry(); });
    await waitFor(() => expect(result.current.available).toBe(true));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalCatalog.test.tsx`
Expected: FAIL — cannot resolve `../useJournalCatalog`.

- [ ] **Step 3: Write the hook**

```typescript
// web/react-gui/src/journal/useJournalCatalog.ts
import useSWR from 'swr';
import { journalApi, isJournalUnavailable } from '../services/journalApi';
import type { JournalCatalog } from '../types/journal';

type JournalCatalogLoader = () => Promise<JournalCatalog | null>;

export async function loadJournalCatalog(): Promise<JournalCatalog | null> {
  try {
    return await journalApi.getCatalog();
  } catch (failure) {
    if (isJournalUnavailable(failure)) return null;
    throw failure;
  }
}

export function useJournalCatalog(loader: JournalCatalogLoader = loadJournalCatalog) {
  const { data, error, isLoading, mutate } = useSWR<JournalCatalog | null>(
    'journal:catalog',
    loader,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  return {
    catalog: data ?? undefined,
    available: data != null,
    unavailable: data === null,
    loading: isLoading,
    error,
    retry: async () => (await mutate()) ?? undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalCatalog.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/journal/useJournalCatalog.ts web/react-gui/src/journal/__tests__/useJournalCatalog.test.tsx
git commit -m "feat(journal): catalog availability probe hook"
```

### Task 5: Entry list hook

**Files:**
- Create: `web/react-gui/src/journal/useJournalEntries.ts`
- Create: `web/react-gui/src/journal/useJournalPlots.ts`
- Test: `web/react-gui/src/journal/__tests__/useJournalEntries.test.tsx`
- Test: `web/react-gui/src/journal/__tests__/useJournalPlots.test.tsx`

**Interfaces:**
- Consumes: `journalApi.listEntries`, `journalApi.listPlots` (Phase 1), `EntryListFilters`.
- Produces: filter-keyed entry state and plot lookup state. Both expose `retry`; errors remain distinct from successful empty arrays.

- [ ] **Step 1: Write the failing test**

```typescript
// web/react-gui/src/journal/__tests__/useJournalEntries.test.tsx
import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { listEntries } = vi.hoisted(() => ({ listEntries: vi.fn() }));
vi.mock('../../services/journalApi', () => ({ journalApi: { listEntries: (f: any) => listEntries(f) } }));

import { useJournalEntries } from '../useJournalEntries';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useJournalEntries', () => {
  beforeEach(() => listEntries.mockReset());

  it('does not fetch when disabled', () => {
    renderHook(() => useJournalEntries({ status: 'final' }, false), { wrapper });
    expect(listEntries).not.toHaveBeenCalled();
  });

  it('returns entries when enabled', async () => {
    listEntries.mockResolvedValue({ entries: [{ entry_uuid: 'e1' }], next_cursor: null });
    const filters = { status: 'final' as const, limit: 50 };
    const { result } = renderHook(() => useJournalEntries(filters, true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toHaveLength(1);
    expect(listEntries).toHaveBeenCalledWith(filters);
  });

  it('keeps a failed request distinct from an empty result and retries', async () => {
    const failure = new Error('offline');
    listEntries
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ entries: [], next_cursor: null });
    const { result } = renderHook(
      () => useJournalEntries({ status: 'final' }, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.entries).toEqual([]);
    await act(async () => { await result.current.retry(); });
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(listEntries).toHaveBeenCalledTimes(2);
  });
});
```

```typescript
// web/react-gui/src/journal/__tests__/useJournalPlots.test.tsx
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { listPlots } = vi.hoisted(() => ({ listPlots: vi.fn() }));
vi.mock('../../services/journalApi', () => ({ journalApi: { listPlots } }));
import { useJournalPlots } from '../useJournalPlots';

const wrapper = ({ children }: React.PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

describe('useJournalPlots', () => {
  beforeEach(() => listPlots.mockReset());

  it('does not fetch when disabled', () => {
    renderHook(() => useJournalPlots(false), { wrapper });
    expect(listPlots).not.toHaveBeenCalled();
  });

  it('returns plots when enabled', async () => {
    const plots = [{ plot_uuid: 'p1', plot_code: 'N-1' }];
    listPlots.mockResolvedValue(plots);
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.plots).toEqual(plots);
  });

  it('exposes and retries a failed request', async () => {
    const failure = new Error('offline');
    listPlots.mockRejectedValueOnce(failure).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useJournalPlots(true), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(failure));
    await act(async () => { await result.current.retry(); });
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(listPlots).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalEntries.test.tsx src/journal/__tests__/useJournalPlots.test.tsx`
Expected: FAIL — cannot resolve the two hook modules.

- [ ] **Step 3: Write the hook**

```typescript
// web/react-gui/src/journal/useJournalEntries.ts
import useSWR from 'swr';
import { journalApi } from '../services/journalApi';
import type { EntryAggregate, EntryListFilters } from '../types/journal';

export function useJournalEntries(filters: EntryListFilters, enabled: boolean) {
  const key = enabled ? ['journal:entries', filters] : null;
  const { data, error, isLoading, mutate } = useSWR(key, () => journalApi.listEntries(filters), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const entries: EntryAggregate[] = data?.entries ?? [];
  return { entries, loading: enabled && isLoading, error, retry: mutate };
}
```

```typescript
// web/react-gui/src/journal/useJournalPlots.ts
import useSWR from 'swr';
import { journalApi } from '../services/journalApi';
import type { JournalPlot } from '../types/journal';

export function useJournalPlots(enabled: boolean) {
  const { data, error, isLoading, mutate } = useSWR<JournalPlot[]>(
    enabled ? 'journal:plots' : null,
    () => journalApi.listPlots(),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  return {
    plots: data ?? [],
    loading: enabled && isLoading,
    error,
    retry: mutate,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalEntries.test.tsx src/journal/__tests__/useJournalPlots.test.tsx`
Expected: both hook suites pass, including failure-to-retry cases.

- [ ] **Step 5: Commit**

```bash
git add web/react-gui/src/journal/useJournalEntries.ts web/react-gui/src/journal/useJournalPlots.ts web/react-gui/src/journal/__tests__/useJournalEntries.test.tsx web/react-gui/src/journal/__tests__/useJournalPlots.test.tsx
git commit -m "feat(journal): retryable entry and plot read hooks"
```

### Task 6: Entry row component

**Files:**
- Create: `web/react-gui/src/components/journal/JournalEntryRow.tsx`
- Test: `web/react-gui/src/components/journal/__tests__/JournalEntryRow.test.tsx`
- Modify: `web/react-gui/public/locales/{de-CH,en,es,fr,it,lg,pt}/journal.json` (matching key shape; English fallback copy is allowed for this slice)
- Test: `web/react-gui/src/journal/__tests__/journalLocales.test.ts`

**Interfaces:**
- Consumes: `EntryAggregate`.
- Produces: `<JournalEntryRow entry={EntryAggregate} plotLabel={string | null} />` — a solid card row showing localized activity, a human plot label, the occurrence date formatted in `occurred_timezone`, and a status chip. Raw plot UUIDs are never user-facing.

- [ ] **Step 1: Add locale keys**

Add to `web/react-gui/public/locales/en/journal.json`:

```json
"row": {
  "farmLevel": "Farm-level",
  "unknownPlot": "Unknown plot",
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

Create the same `journal.json` key shape for all seven configured locales.
`journalLocales.test.ts` imports each file, recursively compares its keys to
English, and fails if any locale is missing or gains a divergent key. Phase 6
will mirror these source files into the Node-RED feed bundle.

- [ ] **Step 2: Write the failing test**

```typescript
// web/react-gui/src/components/journal/__tests__/JournalEntryRow.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

import { formatOccurredDate, JournalEntryRow } from '../JournalEntryRow';

const entry = {
  entry_uuid: 'e1', activity_code: 'irrigation', plot_uuid: 'p1', status: 'final',
  occurred_start: '2026-07-10T08:00:00.000Z', occurred_timezone: 'Europe/Zurich', values: [],
} as any;

describe('JournalEntryRow', () => {
  it('shows the activity key and a status chip', () => {
    render(<JournalEntryRow entry={entry} plotLabel="North field" />);
    expect(screen.getByText('activity.irrigation')).toBeInTheDocument();
    expect(screen.getByText('row.status.final')).toBeInTheDocument();
    expect(screen.getByText(/North field/)).toBeInTheDocument();
    expect(screen.queryByText(/p1/)).not.toBeInTheDocument();
  });

  it('formats the occurrence in its recorded timezone', () => {
    expect(formatOccurredDate(
      '2026-07-10T23:30:00.000Z',
      'Pacific/Auckland',
      'en-GB',
    )).toContain('11 Jul 2026');
  });
});
```

```typescript
// web/react-gui/src/journal/__tests__/journalLocales.test.ts
import { describe, expect, it } from 'vitest';
import deCH from '../../../public/locales/de-CH/journal.json';
import en from '../../../public/locales/en/journal.json';
import es from '../../../public/locales/es/journal.json';
import fr from '../../../public/locales/fr/journal.json';
import itLocale from '../../../public/locales/it/journal.json';
import lg from '../../../public/locales/lg/journal.json';
import pt from '../../../public/locales/pt/journal.json';

function keyShape(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keyShape(child, prefix ? `${prefix}.${key}` : key));
}

describe('journal locale parity', () => {
  it.each([
    ['de-CH', deCH], ['es', es], ['fr', fr], ['it', itLocale], ['lg', lg], ['pt', pt],
  ])('%s matches the English key shape', (_locale, resource) => {
    expect(keyShape(resource).sort()).toEqual(keyShape(en).sort());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/components/journal/__tests__/JournalEntryRow.test.tsx src/journal/__tests__/journalLocales.test.ts`
Expected: FAIL — the row component and six non-English journal resources do not exist.

- [ ] **Step 4: Write the component**

```typescript
// web/react-gui/src/components/journal/JournalEntryRow.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { EntryAggregate } from '../../types/journal';

export function formatOccurredDate(value: string, timeZone: string, locale?: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  }
}

interface Props { entry: EntryAggregate; plotLabel: string | null; }

export const JournalEntryRow: React.FC<Props> = ({ entry, plotLabel }) => {
  const { t, i18n } = useTranslation('journal');
  const locale = i18n.resolvedLanguage || i18n.language;
  const date = formatOccurredDate(entry.occurred_start, entry.occurred_timezone, locale);
  const statusClass = entry.status === 'final'
    ? 'bg-[var(--success-bg)] text-[var(--success-text)]'
    : entry.status === 'voided'
      ? 'bg-red-100 text-red-800'
      : 'bg-[var(--warn-bg)] text-[var(--warn-text)]';
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
      <div className="min-w-0">
        <p className="truncate font-bold text-[var(--text)]">
          {t(`activity.${entry.activity_code}`, entry.activity_code)}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {entry.plot_uuid ? (plotLabel ?? t('row.unknownPlot')) : t('row.farmLevel')} · {date}
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

Run: `cd web/react-gui && npx vitest run src/components/journal/__tests__/JournalEntryRow.test.tsx src/journal/__tests__/journalLocales.test.ts`
Expected: row behavior, timezone formatting, and locale-key parity all pass.

- [ ] **Step 6: Commit**

```bash
git add web/react-gui/src/components/journal/JournalEntryRow.tsx web/react-gui/src/components/journal/__tests__/JournalEntryRow.test.tsx web/react-gui/public/locales/*/journal.json web/react-gui/src/journal/__tests__/journalLocales.test.ts
git commit -m "feat(journal): timeline entry row"
```

### Task 7: Timeline + JournalPage wiring

**Depends on:** Tasks 4, 5, and 6.

**Files:**
- Create: `web/react-gui/src/components/journal/JournalTimeline.tsx`
- Modify: `web/react-gui/src/pages/JournalPage.tsx`
- Modify: `web/react-gui/public/locales/{de-CH,en,es,fr,it,lg,pt}/journal.json` (matching `timeline.*`, `unavailable.*`, `error.*`, `filters.*`, `logActivity` keys)
- Test: `web/react-gui/src/components/journal/__tests__/JournalTimeline.test.tsx`
- Test: `web/react-gui/src/pages/__tests__/JournalPage.test.tsx`

**Interfaces:**
- Consumes: Tasks 4–6, including plot lookup and retryable reads.
- Produces: `<JournalTimeline entries={EntryAggregate[]} plots={JournalPlot[]} loading={boolean} />`, plus a page with final-entry plot/activity filters. Empty state renders only after successful entry and plot reads.

- [ ] **Step 1: Add locale keys**

Add the same keys to all seven locale files: `"timeline": { "empty": "No activities logged yet.", "loading": "Loading activities…" }`, `"unavailable": { "title": "Journal not available", "body": "This gateway does not yet have the field journal. Update the gateway firmware to enable it." }`, `"error": { "title": "Could not load the journal", "body": "The gateway did not answer successfully. Try again.", "retry": "Try again" }`, `"filters": { "plot": "Plot", "allPlots": "All plots", "activity": "Activity", "allActivities": "All activities" }`, `"logActivity": "Log activity"`. English fallback copy is allowed, but `journalLocales.test.ts` must remain green.

- [ ] **Step 2: Write the failing test**

```typescript
// web/react-gui/src/components/journal/__tests__/JournalTimeline.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { resolvedLanguage: 'en-GB', language: 'en-GB' },
  }),
}));

import { JournalTimeline } from '../JournalTimeline';

describe('JournalTimeline', () => {
  it('shows the loading state while entries are pending', () => {
    render(<JournalTimeline entries={[]} plots={[]} loading />);
    expect(screen.getByText('timeline.loading')).toBeInTheDocument();
  });

  it('shows the empty state when there are no entries', () => {
    render(<JournalTimeline entries={[]} plots={[]} loading={false} />);
    expect(screen.getByText('timeline.empty')).toBeInTheDocument();
  });

  it('renders a row per entry', () => {
    const entries = [
      { entry_uuid: 'e1', activity_code: 'irrigation', plot_uuid: 'p1', status: 'final', occurred_start: '2026-07-10T08:00:00.000Z', values: [] },
      { entry_uuid: 'e2', activity_code: 'harvest', plot_uuid: null, status: 'final', occurred_start: '2026-07-09T08:00:00.000Z', values: [] },
    ] as any;
    const plots = [{ plot_uuid: 'p1', plot_code: 'N-1', name: 'North field' }] as any;
    render(<JournalTimeline entries={entries} plots={plots} loading={false} />);
    const rows = screen.getAllByText(/^activity\./);
    expect(rows.map((row) => row.textContent)).toEqual([
      'activity.irrigation',
      'activity.harvest',
    ]);
    expect(screen.getByText(/North field/)).toBeInTheDocument();
    expect(screen.queryByText(/p1/)).not.toBeInTheDocument();
  });
});
```

```typescript
// web/react-gui/src/pages/__tests__/JournalPage.test.tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  useJournalCatalog: vi.fn(),
  useJournalEntries: vi.fn(),
  useJournalPlots: vi.fn(),
  timeline: vi.fn(),
  retryCatalog: vi.fn(),
  retryEntries: vi.fn(),
  retryPlots: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ username: 'farmer', logout: vi.fn() }),
}));
vi.mock('../../components/AppHeader', () => ({ AppHeader: () => <header /> }));
vi.mock('../../journal/useJournalCatalog', () => ({
  useJournalCatalog: mocks.useJournalCatalog,
}));
vi.mock('../../journal/useJournalEntries', () => ({
  useJournalEntries: mocks.useJournalEntries,
}));
vi.mock('../../journal/useJournalPlots', () => ({
  useJournalPlots: mocks.useJournalPlots,
}));
vi.mock('../../components/journal/JournalTimeline', () => ({
  JournalTimeline: (props: unknown) => {
    mocks.timeline(props);
    return <div data-testid="timeline" />;
  },
}));

import { JournalPage } from '../JournalPage';

const catalog = {
  vocab: [{ code: 'irrigation', kind: 'activity', active: 1 }],
};
const entries = [{ entry_uuid: 'e1' }];
const plots = [{ plot_uuid: 'p1', plot_code: 'N-1', name: 'North field' }];

describe('JournalPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useJournalCatalog.mockReturnValue({
      catalog, available: true, unavailable: false, loading: false,
      error: undefined, retry: mocks.retryCatalog,
    });
    mocks.useJournalEntries.mockReturnValue({
      entries, loading: false, error: undefined, retry: mocks.retryEntries,
    });
    mocks.useJournalPlots.mockReturnValue({
      plots, loading: false, error: undefined, retry: mocks.retryPlots,
    });
  });

  it('does not enable reads while the catalog probe is loading', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined, available: false, unavailable: false, loading: true,
      error: undefined, retry: mocks.retryCatalog,
    });
    render(<JournalPage />);
    expect(screen.getByText('timeline.loading')).toBeInTheDocument();
    expect(mocks.useJournalEntries).toHaveBeenCalledWith(expect.anything(), false);
    expect(mocks.useJournalPlots).toHaveBeenCalledWith(false);
  });

  it('renders capability absence only for unavailable gateways', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined, available: false, unavailable: true, loading: false,
      error: undefined, retry: mocks.retryCatalog,
    });
    render(<JournalPage />);
    expect(screen.getByText('unavailable.title')).toBeInTheDocument();
    expect(screen.queryByText('error.title')).not.toBeInTheDocument();
  });

  it('renders and retries a catalog operational error', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined, available: false, unavailable: false, loading: false,
      error: new Error('offline'), retry: mocks.retryCatalog,
    });
    render(<JournalPage />);
    expect(screen.getByText('error.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));
    expect(mocks.retryCatalog).toHaveBeenCalledOnce();
  });

  it('does not turn an entry-list failure into the empty state', () => {
    mocks.useJournalEntries.mockReturnValue({
      entries: [], loading: false, error: new Error('offline'), retry: mocks.retryEntries,
    });
    render(<JournalPage />);
    expect(screen.getByText('error.title')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));
    expect(mocks.retryEntries).toHaveBeenCalledOnce();
    expect(mocks.retryPlots).toHaveBeenCalledOnce();
  });

  it('renders reads and applies plot and activity filters', async () => {
    render(<JournalPage />);
    expect(screen.getByRole('button', { name: 'logActivity' })).toBeInTheDocument();
    expect(mocks.timeline).toHaveBeenCalledWith(expect.objectContaining({ entries, plots }));

    fireEvent.change(screen.getByLabelText('filters.plot'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('filters.activity'), {
      target: { value: 'irrigation' },
    });
    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      { status: 'final', limit: 50, plot_uuid: 'p1', activity_code: 'irrigation' },
      true,
    ));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web/react-gui && npx vitest run src/components/journal/__tests__/JournalTimeline.test.tsx src/pages/__tests__/JournalPage.test.tsx`
Expected: both suites fail because `JournalTimeline` and the new page behavior do not exist yet.

- [ ] **Step 4: Write the timeline**

```typescript
// web/react-gui/src/components/journal/JournalTimeline.tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { EntryAggregate, JournalPlot } from '../../types/journal';
import { JournalEntryRow } from './JournalEntryRow';

interface Props { entries: EntryAggregate[]; plots: JournalPlot[]; loading: boolean; }

export const JournalTimeline: React.FC<Props> = ({ entries, plots, loading }) => {
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
  const labels = new Map(plots.map((plot) => [
    plot.plot_uuid,
    plot.name?.trim() || plot.plot_code,
  ]));
  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <JournalEntryRow
          key={entry.entry_uuid}
          entry={entry}
          plotLabel={entry.plot_uuid ? (labels.get(entry.plot_uuid) ?? null) : null}
        />
      ))}
    </div>
  );
};
```

- [ ] **Step 5: Replace `JournalPage` with the complete reading surface**

```typescript
// web/react-gui/src/pages/JournalPage.tsx
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '../components/AppHeader';
import { JournalTimeline } from '../components/journal/JournalTimeline';
import { useAuth } from '../contexts/AuthContext';
import { useJournalCatalog } from '../journal/useJournalCatalog';
import { useJournalEntries } from '../journal/useJournalEntries';
import { useJournalPlots } from '../journal/useJournalPlots';
import type { EntryListFilters } from '../types/journal';

export const JournalPage: React.FC = () => {
  const { t } = useTranslation('journal');
  const { username, logout } = useAuth();
  const [plotUuid, setPlotUuid] = useState('');
  const [activityCode, setActivityCode] = useState('');
  const catalogState = useJournalCatalog();
  const filters = useMemo<EntryListFilters>(() => ({
    status: 'final',
    limit: 50,
    ...(plotUuid ? { plot_uuid: plotUuid } : {}),
    ...(activityCode ? { activity_code: activityCode } : {}),
  }), [activityCode, plotUuid]);
  const entryState = useJournalEntries(filters, catalogState.available);
  const plotState = useJournalPlots(catalogState.available);
  const readError = entryState.error || plotState.error;
  const activities = (catalogState.catalog?.vocab ?? [])
    .filter((row) => row.kind === 'activity' && row.active === 1);

  const retryReads = () => Promise.all([entryState.retry(), plotState.retry()]);
  const errorCard = (retry: () => Promise<unknown>) => (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8">
      <h2 className="text-xl font-bold text-[var(--text)]">{t('error.title')}</h2>
      <p className="mt-2 text-[var(--text-secondary)]">{t('error.body')}</p>
      <button
        type="button"
        className="btn-liquid mt-4 rounded-lg px-4 py-2"
        onClick={() => void retry()}
      >
        {t('error.retry')}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <AppHeader
        title={t('title')}
        activeTab="journal"
        username={username}
        onLogout={logout}
      />
      <main className="mx-auto max-w-3xl px-4 py-8">
        {catalogState.loading ? (
          <p className="text-[var(--text-secondary)]">{t('timeline.loading')}</p>
        ) : catalogState.unavailable ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8">
            <h2 className="text-xl font-bold text-[var(--text)]">{t('unavailable.title')}</h2>
            <p className="mt-2 text-[var(--text-secondary)]">{t('unavailable.body')}</p>
          </div>
        ) : catalogState.error ? (
          errorCard(catalogState.retry)
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <label className="min-w-40 flex-1 text-sm text-[var(--text-secondary)]">
                {t('filters.plot')}
                <select
                  aria-label={t('filters.plot')}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[var(--text)]"
                  value={plotUuid}
                  onChange={(event) => setPlotUuid(event.target.value)}
                >
                  <option value="">{t('filters.allPlots')}</option>
                  {plotState.plots.map((plot) => (
                    <option key={plot.plot_uuid} value={plot.plot_uuid}>
                      {plot.name?.trim() || plot.plot_code}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-40 flex-1 text-sm text-[var(--text-secondary)]">
                {t('filters.activity')}
                <select
                  aria-label={t('filters.activity')}
                  className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[var(--text)]"
                  value={activityCode}
                  onChange={(event) => setActivityCode(event.target.value)}
                >
                  <option value="">{t('filters.allActivities')}</option>
                  {activities.map((activity) => (
                    <option key={activity.code} value={activity.code}>
                      {t(`activity.${activity.code}`, activity.code)}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn-liquid rounded-lg px-5 py-2.5 font-bold">
                {t('logActivity')}
              </button>
            </div>
            {readError ? errorCard(retryReads) : (
              <JournalTimeline
                entries={entryState.entries}
                plots={plotState.plots}
                loading={entryState.loading || plotState.loading}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
};
```

- [ ] **Step 6: Run tests + typecheck + build**

Run: `cd web/react-gui && npx vitest run src/components/journal src/journal src/pages/__tests__/JournalPage.test.tsx && npm run test:unit && npx tsc --noEmit && npm run build`
Expected: all journal tests PASS; tsc clean; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/react-gui/src/components/journal/JournalTimeline.tsx web/react-gui/src/pages/JournalPage.tsx web/react-gui/public/locales/*/journal.json web/react-gui/src/components/journal/__tests__/JournalTimeline.test.tsx web/react-gui/src/pages/__tests__/JournalPage.test.tsx
git commit -m "feat(journal): reading-surface timeline on the Journal page with empty + unavailable states"
```

**Phase 2 acceptance:** on a Slice-1 gateway the Journal tab lists final entries newest-first, supports plot/activity filtering, renders human plot labels and occurrence dates in their recorded timezone, and shows an empty state only after successful reads. A pre-journal gateway shows the unavailable card; operational catalog/list/plot failures show a retryable error. `Log activity` is present (wired in Phase 3), and all seven source locales have matching journal keys.

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
