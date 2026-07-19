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
- The capture flow's shipped uncached `open_field` path allows at most nine primary-control activations from the zone CTA to the rendered save receipt. That shipped tier is tested at 320×568 and 360×640. A conditional five-activation target applies only when an approved safe-default policy supplies every required field from current plot state or a compatible confirmed record; the current release has no such policy for `open_field`'s four minimum fields, so the five-activation tier becomes testable only after one is approved.
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

## Phase 3 — Mobile capture flow

Phase 0 is green. Its full catalog response exposes the parsed definitions,
labels, constraints, and product composition that this phase consumes.

### Verified catalog and lifecycle facts

- Shipped template fields are strings today, but the edge validator also
  accepts field-rule objects whose identifier is `code`, `attribute_code`, or
  `field`, plus `required`, `required_if`, and `visible_if`. The renderer
  supports every accepted alias and only the edge predicate operators `eq`
  and `in`.
- `farmer_quick@1` contains `activity_code`, `plot_uuid`,
  `occurred_start`, the quick value fields, and `note`. Layouts add
  `activity_codes`, `supported_templates`, `fields`, `minimum_fields`,
  `conditional_fields`, `denominator_contract`, and `option_dependencies`.
  `research_observation@1` also uses section `include_scope`; Agroscope's
  dependency cascade restricts operation choices, devices, and units.
- A draft save resolves and stores the covering `season_uuid`. Safe
  carry-forward therefore first saves the stable draft, reloads that exact
  draft, and compares its non-null season plus pinned layout against older
  final entries. It never guesses a season from `crop_hint`.
- POST final is create-only. POST draft may replace the same owned version-zero
  draft. The client still uses first draft attempt POST with a client UUID;
  later draft saves and final promotion use the PUT client added in Phase 1.
- The edge UI can produce `Saved on farm gateway` or `Not saved`. The save
  state component also renders the cloud-pending state for contract parity,
  but this edge route never claims that state.

### Dependency and delegation graph

```text
Task 8 catalog model + template engine
  ├── Task 9 activity picker
  ├── Task 10 dynamic field controls/form
  ├── Task 11 season-safe carry-forward
  └── Task 12 stable draft/save lifecycle
Tasks 9 + 10 + 11 + 12
  └── Task 13 capture-flow composition
Task 13
  └── Task 14 Journal/zone/Add-menu integration + mobile SLA
```

Tasks 9–12 may run in parallel after Task 8. Task 13 is the convergence
point. Task 14 is the Phase 3 gate. Every task uses TDD, receives separate sol
specification and quality reviews, and commits only its declared files.

### Task 8: Typed catalog model and template engine

**Files:**
- Create `web/react-gui/src/types/journalCapture.ts`.
- Create `web/react-gui/src/journal/catalogModel.ts`.
- Create `web/react-gui/src/journal/templateEngine.ts`.
- Create `web/react-gui/src/journal/occurrence.ts`.
- Create `web/react-gui/src/journal/__tests__/catalogModel.test.ts`.
- Create `web/react-gui/src/journal/__tests__/templateEngine.test.ts`.
- Create `web/react-gui/src/journal/__tests__/occurrence.test.ts`.
- Modify `web/react-gui/src/services/journalApi.ts` and
  `web/react-gui/src/services/__tests__/journalApi.test.ts` only
  to add optional top-level write fields used by the shipped edge contract:
  `zone_uuid`, `device_eui`, `season_crop`, `season_variety`, campaign,
  protocol, observation unit, pass UUID, start/end UTC offsets, and duplicate
  acknowledgement as the exact `duplicate_guard_ack_entry_uuid` field.
- Modify all seven source `public/locales/*/journal.json` files once with the
  complete Phase 3 `capture.*` key tree, and extend
  `web/react-gui/src/journal/__tests__/journalLocales.test.ts`. This is the sole
  locale owner before Tasks 9–12 run in parallel.

**Required interfaces and behavior:**
- Runtime guards parse `JournalDefinitionRow.definition` fail-closed when
  `catalog_errors` contains `definition_json` or when required arrays are
  malformed.
- `catalogLabel(row, locale)` uses the requested locale, then English, then
  the code. `activeDefinition(rows, code)` selects the highest active version.
- `normalizeFieldRule`, `evaluatePredicate`, and
  `deriveFieldStates(template, layout, selections)` mirror the edge's string
  and three object-field aliases, `eq`/`in` predicates, visibility,
  requiredness, activity requirements, conditional groups, section
  `include_scope`, layout `fields`/`minimum_fields`/`conditional_fields`, and
  deterministic ordered deduplication.
- The model parses `activity_codes`, `supported_templates`,
  `denominator_contract`, and every shipped `option_dependencies` shape. It
  derives the effective ordered field set plus currently allowed choices and
  units for the selected activity and earlier values. Invalid dependency
  references fail closed just as invalid definition JSON does.
- Unit helpers resolve every active compatible unit from the attribute and
  unit `quantity_kind`/`basis`/conversion facts, then intersect that family
  with layout dependency restrictions. Conversion produces both the canonical
  `value_num`/`unit_code` and the audit
  `entered_value_num`/`entered_unit_code`; incompatible or cross-basis units
  are rejected. A numeric request row has the exact edge shape
  `{ value_num: canonicalValue, unit_code: canonicalUnit,
  entered_value_num: enteredValue, entered_unit_code: enteredUnit }`. Generic
  `value` is omitted; if a caller supplies it, the builder accepts it only when
  it equals `canonicalValue`.
- `buildEntryValues` preserves nonnumeric semantic `value`, `value_status`,
  numeric canonical/entered facts, and repeat `group_index`; it omits truly
  empty values without coercing zero or false away.
- `ActivityLeafSelection` is declared in `journalCapture.ts` as
  `{ activity_code, dependent_selections: Array<{ attribute_code, value }> }`.
  Task 8 derives these leaves from activity plus the layout's dependent choice
  chain, with a deterministic identity/order; units remain constrained by the
  resulting selections but are chosen in the form.
- `resolveOccurrence(local, timezone, preferredOffset?)` mirrors the edge's
  calendar and IANA-timezone behavior, detects DST gaps, returns both offsets
  for a fold, and requires an explicit choice when ambiguous. Tests cover the
  Zurich spring gap and autumn fold. The capture flow defaults to the browser
  IANA timezone only when the caller has no typed linked-zone timezone; plot
  aggregates themselves do not expose that timezone.
- Tests use fixtures matching all shipped definitions:
  `farmer_quick@1`, `full_record@1`, `research_observation@1`,
  `open_field@1`, `greenhouse@1`, `lysimeter@1`, and
  `agroscope_open_field@1`. They cover invalid definitions, every field-rule
  alias, include-scope fields, zero/false values, conditional requiredness,
  layout/template compatibility, the exact numeric request shape, and the
  Agroscope operation→device→allowed-unit cascade. The journal API contract
  test also asserts the canonical-plus-entered numeric row without generic
  `value`.
- The shared locale tree contains `capture.title/close/back/next/finish`,
  `capture.where.*`, `capture.picker.*`, `capture.form.*`,
  `capture.validation.*`, `capture.carry.*`, `capture.confirm.*`, and
  `capture.save.*`. All seven files receive identical English fallback copy;
  later tasks consume these keys without editing locale files in parallel.

**Gate:** targeted suites, `npm run test:unit`, `npx tsc --noEmit`, and
`git diff --check`. Commit: `feat(journal): catalog-driven capture engine`.

### Task 9: Transparent activity picker

**Files:**
- Create `web/react-gui/src/components/journal/capture/ActivityPicker.tsx`.
- Create
  `web/react-gui/src/components/journal/__tests__/capture/ActivityPicker.test.tsx`.
- Consume the Phase 3 locale keys from Task 8; do not edit locale files.

**Required behavior:**
- Props are catalog rows and distinct `ActivityLeafSelection[]` inputs for
  plot recents, season common, farm recents, and layout fallback, plus whether
  the selected plot is zone-linked, locale, and `onPick`. Each leaf is
  produced by Task 8 from `activity_code` plus the layout's dependent choice
  chain; `onPick` returns the complete typed leaf so Agroscope operation/device
  selections reach form state, never only an opaque label or activity code.
- The default surface is at most six 56px icon+label controls in labelled
  sections: `Recent on this plot`, then `Common this season` for a zone-linked
  plot, then `All options` from layout fallback. No-zone/farm-level selection
  uses farm recents instead of season inference. Ordering is stable and
  transparent; no opaque score is shown.
- Search matches every localized label in the flattened path, English fallback
  labels, and normalized code tokens. The current catalog has no synonym
  field, so the UI does not invent unreviewed agronomic synonyms. Browse all
  starts at activity and walks each dependency-constrained choice level (for
  example operation then device) one labelled screen at a time, with back
  navigation. A layout with no dependent choices ends at the activity leaf;
  the UI never dumps a flat long-tail leaf list.
- Icons come from a closed local allowlist and always have a visible label.
- Tests cover zone-linked season ranking, no-zone farm fallback,
  ranking/deduplication, the six-item cap, cold start, search, one-level guided
  browsing/backtracking, unsupported activities, keyboard activation, and
  English fallback.

**Gate/commit:** targeted + full unit + TypeScript + locale parity +
whitespace; `feat(journal): transparent activity picker`.

### Task 10: Catalog-driven fields and product/numeric controls

**Files:**
- Create `web/react-gui/src/components/journal/capture/NumberStepper.tsx`,
  `web/react-gui/src/components/journal/capture/NutrientRepeater.tsx`, and
  `web/react-gui/src/components/journal/capture/EntryForm.tsx`.
- Create
  `web/react-gui/src/components/journal/__tests__/capture/NumberStepper.test.tsx`,
  `web/react-gui/src/components/journal/__tests__/capture/NutrientRepeater.test.tsx`,
  and
  `web/react-gui/src/components/journal/__tests__/capture/EntryForm.test.tsx`.
- Consume the Phase 3 locale keys from Task 8; do not edit locale files.

**Required behavior:**
- `EntryForm` renders the field states from Task 8 for number, text, choice,
  date, and boolean attributes. Top-level identity/time/plot fields remain the
  capture shell's responsibility.
- Numeric input accepts the locale decimal separator, retains a keyboard
  fallback, exposes large decrement/increment controls, and honours catalog
  `min`/`max`/`step`. One allowed unit renders a fixed suffix; two allowed
  units render the P5 segmented toggle; larger active compatible families use
  an accessible selector. Every choice is further restricted by the current
  layout dependency cascade.
- Numeric submission retains entered value/unit and converts to canonical
  value/unit through Task 8's quantity-kind+basis conversion. It submits
  canonical `value_num`/`unit_code` beside
  `entered_value_num`/`entered_unit_code` and omits generic `value`.
  Incompatible units and cross-basis conversions fail visibly. Nutrient-rate
  rows require explicit fixed nutrient-unit chips and never silently default a
  species.
- Product-first activities show active products before product-rate fields.
  `NutrientRepeater` uses group indices and fixed nutrient-unit chips. It can
  display composition-derived facts from a non-empty fixture but does not
  store derived nutrient values or fabricate composition for the currently
  empty shipped product rows.
- Required visible fields block confirmation with field-level i18n errors.
  Hidden values remain in form state for later template transitions but are
  omitted from the create payload when the edge would reject them.
- Tests cover zero, decimal comma, step/min/max, one-unit suffix, two-unit
  toggle, larger unit family, entered/canonical conversion, incompatible unit,
  dependency-restricted unit, choice restrictions, the Agroscope
  operation→device→unit cascade, product-first order, repeat groups,
  derived-display-only composition, explicit nutrient units, and conditional
  visibility/requiredness.

**Gate/commit:** targeted + full unit + TypeScript + locale parity +
whitespace; `feat(journal): catalog-driven entry controls`.

### Task 11: Season-safe carry-forward

**Files:**
- Create `web/react-gui/src/journal/carryForward.ts`.
- Create `web/react-gui/src/journal/__tests__/carryForward.test.ts`.
- Create
  `web/react-gui/src/components/journal/capture/RepeatTreatmentCard.tsx`.
- Create
  `web/react-gui/src/components/journal/__tests__/capture/RepeatTreatmentCard.test.tsx`.
- Consume the Phase 3 locale keys from Task 8; do not edit locale files.

**Required interfaces and behavior:**
- `loadCarryForwardCandidate(entryUuid)` treats only the stored draft as
  authoritative. It reloads that exact row with `status=all`, requires
  `status === 'draft'`, and derives plot, crop, activity, occurrence, layout,
  and season fences from it rather than accepting them from the caller.
- It pages final-only entries by cursor (up to the endpoint's 100-row page)
  until it finds the newest compatible source or exhausts the result set. It
  returns no candidate unless source and draft share the same non-null
  `season_uuid`, plot, activity, and layout code/version, and
  `source.occurred_start <= draft.occurred_start`.
- `partitionCarryForward` silently pre-fills only template-declared low-risk
  fields. Plant-protection product/authorization, target, dose/basis, treated
  area, and waiting period are always excluded from automatic values.
- An eligible plant-protection source may populate a hollow
  `RepeatTreatmentCard` with source date/crop/product/rate. Values enter form
  state only after explicit confirmation and are invalidated if plot,
  crop, occurrence, season, or layout changes.
- Tests prove cursor pagination, exact-draft authority/status, every
  compatibility fence, every unsafe-field exclusion, and all card
  invalidation inputs.

**Gate/commit:** targeted + full unit + TypeScript + locale parity +
whitespace; `feat(journal): season-safe carry-forward`.

### Task 12: Stable draft and honest save lifecycle

**Files:**
- Create `web/react-gui/src/journal/useCaptureDraft.ts`.
- Create `web/react-gui/src/journal/__tests__/useCaptureDraft.test.tsx`.
- Create `web/react-gui/src/components/journal/capture/SaveState.tsx`.
- Create
  `web/react-gui/src/components/journal/__tests__/capture/SaveState.test.tsx`.
- Consume the Phase 3 locale keys from Task 8; do not edit locale files.

**Required behavior:**
- The hook allocates one `crypto.randomUUID()` per capture session. It never
  writes localStorage or IndexedDB.
- Draft changes are debounced and serialized. First persistence is POST
  `status=draft`; subsequent persistence is UUID-encoded PUT at
  `base_sync_version=0`. A newer change queued during a request is saved after
  that request, never concurrently.
- `finish(finalPayload)` flushes the latest draft and promotes the same UUID
  via PUT. Retry reuses the UUID. Successful final receipts expose
  `outbox_event_uuid` and invalidate the final-entry list.
- Mid-edit failure preserves volatile React state, renders a sticky loss
  warning, and installs/removes a `beforeunload` guard. Pre-edit capability or
  connectivity failure never mounts an editable form.
- `SaveState` distinguishes saving, draft saved on gateway, final saved on
  gateway, cloud saved/waiting for gateway, and not saved. Tests prove exact
  transitions with fake timers, serialization, retry, unmount cleanup, and no
  browser persistence calls.

**Gate/commit:** targeted + full unit + TypeScript + locale parity +
whitespace; `feat(journal): stable drafts and honest save states`.

### Task 13: Confirm-by-reading capture flow

**Files:**
- Create `web/react-gui/src/components/journal/capture/ConfirmStrip.tsx` and
  `web/react-gui/src/components/journal/capture/JournalCaptureFlow.tsx`.
- Create `web/react-gui/src/journal/activityShortlist.ts`.
- Create `web/react-gui/src/journal/__tests__/activityShortlist.test.ts`.
- Create
  `web/react-gui/src/components/journal/__tests__/capture/ConfirmStrip.test.tsx`
  and
  `web/react-gui/src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx`.
- Consume the Phase 3 locale keys from Task 8; do not edit locale files.

**Required behavior:**
- Props include full catalog, plots, optional initial plot, recent entries,
  optional initial timezone, close, open-existing, and saved callbacks. The
  generic flow is Where → Activity → Details → Confirm; a zone-preselected
  flow begins at Activity.
- A selected plot uses its bound layout and shows it as a passive badge. The
  user explicitly selects Quick/Full/Research from layouts that support it;
  Quick is an initial visible choice, never a hidden pin. Farm-level
  `plot_uuid=null` requires an explicit growing-setting choice before Activity;
  `open_field` is never a silent default.
- The details step pins the chosen active template and bound/explicit layout
  versions, uses the catalog form, saves the stable draft, then applies only
  Task 11's safe prefills. Sensorless plots visibly require crop text when no
  covering season can be inferred; farm-level entries may keep
  `plot_uuid=null` but still require explicit layout selection.
- Task 13 owns the paged history query that supplies Task 9. For a zone-linked
  plot it pages final entries at/before the chosen occurrence, derives the
  current season as the newest row with non-null `season_uuid`, and ranks typed
  leaves only from rows sharing that season. If no such row exists, it omits
  `Common this season` and proceeds to layout fallback. Plot recents remain a
  separate list. A no-zone/farm-level selection never relabels farm recents as
  seasonal; it uses explicitly labelled farm recents plus layout fallback.
  Leaf extraction reads activity plus dependency-source/target choice values
  from each aggregate. Cursor pagination continues until exhaustion for the
  selected plot; farm fallback stops after six unique valid leaves or
  exhaustion.
- Occurrence input always shows the chosen timezone. It sends
  `occurred_utc_offset_minutes` (and the end offset when present), so DST folds
  are never resolved silently.
- `ConfirmStrip` renders a plain-language activity, plot, layout, occurrence,
  and every interpreted value+unit. Each token is a button returning to the
  relevant edit step. Finalize stays disabled while validation or duplicate
  submission is in flight.
- Finish promotes the draft and renders `SaveState`; failures remain editable
  with the sticky warning. Close after success calls the saved callback so the
  timeline revalidates.
- After plot/activity/time are known, a preliminary final-only lookup runs the
  ±60-minute duplicate guard. A candidate shows time and key values with
  `Open existing` and `Save separately`. Finalization handles an authoritative
  `duplicate_candidate` response the same way. `Save separately` warns only
  once per draft and retries the same UUID with the exact
  `duplicate_guard_ack_entry_uuid`; this is separate from suppressing repeated
  Finish clicks.
- Tests cover generic and preselected paths, definition/version pinning,
  explicit template and farm-level layout choice, no-zone crop requirement,
  confirm token editing, safe/unsafe prefill, preliminary and authoritative
  duplicate warnings, open-existing/save-separately/warn-once behavior,
  duplicate-click suppression, failure retry, final receipt handling, paged
  season derivation, typed operation/device leaf extraction, and
  first-season/no-history fallback without a seasonal label.

**Gate/commit:** targeted + all capture suites + full unit + TypeScript +
locale parity + build + whitespace; `feat(journal): confirm-by-reading capture flow`.

### Task 14: Entry-point integration and mobile SLA

**Files:**
- Modify `web/react-gui/src/pages/JournalPage.tsx` and
  `web/react-gui/src/pages/__tests__/JournalPage.test.tsx` to open/close the
  capture flow and refresh final entries.
- Modify `web/react-gui/src/components/DashboardHeader.tsx` and
  `web/react-gui/src/components/__tests__/DashboardHeader.test.tsx` so Add →
  Log activity routes to `/journal?capture=1`.
- Modify `web/react-gui/src/types/farming.ts`,
  `web/react-gui/src/services/api.ts`, and create
  `web/react-gui/src/services/__tests__/irrigationZonesApi.test.ts` for explicit
  zone UUID/timezone normalization coverage. The already-shipped `zone_uuid`
  response field receives explicit snake/camel aliases instead of relying on
  `...z` to preserve an untyped property.
- Modify `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` and
  `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardData.test.tsx`
  to add a 56px Journal CTA to `/journal?capture=1&zone_uuid=<uuid>`.
- Consume the Phase 3 entry-point keys from Task 8; do not edit locale files.

**Required behavior:**
- Journal's Log activity button opens the generic flow. Query state opens it
  on arrival and resolves `zone_uuid` to the matching plot without displaying
  an ID. Unknown zone query falls back to the generic Where step.
- The card builds the shortcut from typed `zoneUuid`/`zone_uuid`; a missing
  UUID keeps the CTA available as the generic `/journal?capture=1` flow.
- Journal loads typed irrigation-zone data, matches it by `zone_uuid`, and
  passes its timezone with the preselected plot and crop hint. Browser timezone
  is the editable fallback only for a genuinely missing zone timezone,
  sensorless plot, or farm-level entry. It never overrides a known linked-zone
  timezone and never bypasses catalog/layout or DST validation.
- Tests cover snake/camel UUID aliases, missing-UUID generic fallback, known
  zone timezone, missing timezone fallback, and unknown zone query.
- A test counts primary-control activations for a zone-preselected `open_field`
  entry, including its four required minimum fields, and requires at most nine
  including the initiating zone-card CTA and ending only when the final PUT
  receipt is rendered as `Saved on farm gateway`. It proves the four required
  controls start empty, preserves the shipped `farmer_quick` carry-forward
  fields, proves one final request, and checks for no horizontal-only control
  layout. Five remains a conditional target only after an approved safe-default
  policy covers every required field.
- Browser verification runs the built preview at 320×568 and 360×640: no
  horizontal page scroll, 56px primary controls, visible confirmation text,
  and keyboard focus order. Mocked Slice-1 responses are used because the
  available live gateway is pre-journal.

**Phase 3 gate:** all capture and Phase 1–2 suites, `npm run test:unit`,
`npx tsc --noEmit`, `npm run build`, locale parity, anti-slop on changed copy,
browser screenshots at both viewports, `git diff --check`, clean worktree, and
sol post-check. Commit: `feat(journal): integrate mobile capture entry points`.

## Phase 4 — Multi-plot batch + plot/group CRUD

Task 14 has written external acceptance in `docs/superpowers/prompts/field-journal-slice2-codex/REVIEW-FINDINGS.md` at commit `923b76b6`, under `# Task 14 external re-review — ACCEPTED (2026-07-17)`. Broader Phase 3 remains in review, and the user explicitly authorizes early Phase 4 sequencing. This narrow sequencing authorization does not mark Phase 3 complete and does not waive later Phase 3 findings. Phase 4 also requires the Phase 0 definitions response and the existing Phase 1 contracts.

The old sketch described N create calls and a client-generated `batch_uuid`. The shipped Slice 1 contract is different: one final `POST /api/journal/entries` switches to batch mode when `plot_uuids` is an array; the edge performs duplicate preflight, atomically creates N entries, generates `batch_uuid`, and returns that batch UUID with N independent receipts. The request is capped at 100 plots. Batch drafts and `PUT` batches are rejected. Every task below uses this contract.

### Phase 4 working rules

- The controller is the only Git writer. Workers may edit only their assigned paths; the controller stages exact paths and creates each commit with the subject recorded below. No worker stages, commits, pushes, resets, checkouts, rebases, or cleans.
- Each task follows TDD: write the named RED tests, run the exact focused command and record the missing behavior, add the smallest GREEN implementation, rerun the focused command, then request Sol's specification review followed by the quality review. A task does not advance until both reviews approve or the finding is recorded as a concrete task correction.
- The API boundary keeps snake_case wire names and unwraps only the response envelopes shipped by `osi-journal/api.js`: plot reads use `.plots`, group reads use `.plot_groups`, plot mutations use `.plot`, group mutations use `.plot_group`, and final batch creation returns `{ batch_uuid, entries }` at the response root.
- The batch authoring path has no draft endpoint and no batch `PUT`. Single-plot capture keeps the existing version-zero draft, `PUT /api/journal/entries/:uuid` promotion, scalar duplicate acknowledgement, and the existing uncached `open_field` `<=9` activation SLA.
- All new user-facing strings use the `journal` namespace. The seven source locale files are `web/react-gui/public/locales/{en,de-CH,es,fr,it,lg,pt}/journal.json`; Phase 4 never mirrors `journal.json` into `feeds/`.
- After Sol approves the Phase 4 preflight, the controller commits exactly `docs/superpowers/plans/2026-07-15-field-journal-slice2-gui.md` and `docs/superpowers/prompts/field-journal-slice2-codex/RUN-NOTES.md` as `docs(journal): define Slice 2 Phase 4 GUI execution`. That documentation commit occurs before Task 15; no Task 15–24 source commit includes either planning document.

### Task 15: Atomic entry, plot, and plot-group service contracts

**Files:**
- Modify: `web/react-gui/src/types/journal.ts`
- Modify: `web/react-gui/src/services/journalApi.ts`
- Modify: `web/react-gui/src/services/__tests__/journalApi.test.ts`

**Interfaces:**

```typescript
export interface JournalEntryWriteFields {
  status: 'final' | 'draft';
  plot_uuid?: string | null;
  zone_uuid?: string | null;
  device_eui?: string | null;
  season_crop?: string | null;
  season_variety?: string | null;
  campaign_uuid?: string | null;
  protocol_code?: string | null;
  protocol_version?: string | null;
  observation_unit_code?: string | null;
  pass_uuid?: string | null;
  activity_code: string;
  template_code: string;
  template_version: number;
  layout_code: string;
  layout_version: number;
  occurred_start_local: string;
  occurred_end_local?: string | null;
  occurred_timezone: string;
  occurred_utc_offset_minutes?: number | null;
  occurred_end_utc_offset_minutes?: number | null;
  values: EntryValueInput[];
  note?: string | null;
}

export interface CreateFinalBatchPayload extends Omit<JournalEntryWriteFields, 'status' | 'plot_uuid' | 'zone_uuid'> {
  status: 'final';
  plot_uuids: string[];
  base_sync_version: 0;
  duplicate_guard_ack_entry_uuids?: string[];
}

export interface BatchEntryMutationReceipt {
  plot_uuid: string;
  entry_uuid: string;
  outbox_event_uuid: string;
  sync_version: number;
}

export interface BatchMutationReceipt {
  batch_uuid: string;
  entries: BatchEntryMutationReceipt[];
}

export interface JournalPlotWritePayload {
  plot_uuid: string;
  base_sync_version: number;
  plot_code: string;
  name: string | null;
  zone_uuid: string | null;
  station_code: string | null;
  crop_hint: string | null;
  area_m2: number | null;
  active: 0 | 1;
  layout_code: string;
  layout_version: number;
}

export interface JournalPlotGroupWritePayload {
  group_uuid: string;
  base_sync_version: number;
  label: string;
  members: string[];
  resolved: boolean;
}

```

- [ ] **Step 1: Add the exact batch and resource wire types.** Move the shared entry fields into the exported shape without changing the existing single-entry draft/final receipt union. Keep `CreateEntryPayload` capable of the current single-plot draft flow; make `CreateFinalBatchPayload` final-only with `status: 'final'`, `base_sync_version: 0`, a `string[]` `plot_uuids` field, and optional plural `duplicate_guard_ack_entry_uuids`. This task owns only the compile-time wire-field shape and the exact service pass-through. It does not enforce the runtime 1–100 cardinality rule. Its type and wire payload forbid `entry_uuid`, scalar `plot_uuid`, `zone_uuid`, client `batch_uuid`, singular duplicate acknowledgement, and draft status.
- [ ] **Step 2: Write RED contract tests and compile assertions.** Add Vitest tests named `creates one final batch request with plot_uuids and returns the edge batch receipt`, `creates a plot through POST and returns JournalPlot from data.plot`, `updates a plot through UUID-encoded PUT and returns JournalPlot from data.plot`, `creates a plot group through POST and returns PlotGroup from data.plot_group`, and `updates a plot group through UUID-encoded PUT and returns PlotGroup from data.plot_group`. Add these `@ts-expect-error` assertions beside the valid batch fixture; `tsc --noEmit`, not Vitest, is the evidence for excess-property rejection:

  ```typescript
  // @ts-expect-error batch status is final-only
  const draftBatch: CreateFinalBatchPayload = { ...validBatch, status: 'draft' };
  // @ts-expect-error batch payload has no scalar plot_uuid
  const scalarPlotBatch: CreateFinalBatchPayload = { ...validBatch, plot_uuid: 'p1' };
  // @ts-expect-error batch payload has no zone_uuid
  const zoneBatch: CreateFinalBatchPayload = { ...validBatch, zone_uuid: 'z1' };
  // @ts-expect-error batch payload has no entry_uuid
  const entryBatch: CreateFinalBatchPayload = { ...validBatch, entry_uuid: 'e1' };
  // @ts-expect-error batch_uuid is edge-generated
  const clientBatch: CreateFinalBatchPayload = { ...validBatch, batch_uuid: 'b1' };
  const singularAckBatch: CreateFinalBatchPayload = {
    ...validBatch,
    // @ts-expect-error singular acknowledgement is not a batch wire field
    duplicate_guard_ack_entry_uuid: 'e1',
  };

  void draftBatch;
  void scalarPlotBatch;
  void zoneBatch;
  void entryBatch;
  void clientBatch;
  void singularAckBatch;
  ```

  The `void` statements explicitly consume every invalid fixture so `noUnusedLocals` cannot determine the compile result. The compile evidence therefore isolates the forbidden-property checks. The batch assertion must check one POST to `/api/journal/entries`, `status: 'final'`, `base_sync_version: 0`, a `string[]` `plot_uuids` value, optional plural acknowledgements, and the root `{ batch_uuid, entries }` receipt. Assert that both `zone_uuid` and `plot_uuid` are absent from the wire payload. The batch builder is a later Task 21 seam; this service test covers the exact payload passed to the API without adding cardinality validation here.
- [ ] **Step 3: Run the focused RED commands.** Run the Vitest command and the typecheck as separate commands so a failing Vitest process cannot suppress typecheck evidence:

  ```bash
  cd web/react-gui
  npx vitest run src/services/__tests__/journalApi.test.ts
  npm run typecheck
  ```

  Expected: Vitest fails because the five new service methods and exact unwrapping are absent. After the exact types are added, typecheck consumes the forbidden-property assertions and fails only for still-missing service methods or test implementation, as applicable. Vitest alone is insufficient for this task.
- [ ] **Step 4: Implement the smallest service seam.** Add `journalApi.createFinalBatch(payload)` as exactly one `api.post('/api/journal/entries', payload)` returning `BatchMutationReceipt`; add `POST /api/journal/plots` plus `PUT /api/journal/plots/${encodeURIComponent(uuid)}` and return only `data.plot` as `JournalPlot`; add `POST /api/journal/plot-groups` plus `PUT /api/journal/plot-groups/${encodeURIComponent(uuid)}` and return only `data.plot_group` as `PlotGroup`. The update body UUID must match the path. Keep server `created` and `outbox_event_uuid` outside the UI return. Do not add a batch draft method, a batch update method, N per-plot calls, or a client-generated batch UUID method.
- [ ] **Step 5: Run GREEN and type checks.** Run `cd web/react-gui && npx vitest run src/services/__tests__/journalApi.test.ts && npx tsc --noEmit`. Expected: the focused tests and typecheck pass.
- [ ] **Step 6: Controller-only commit and reviews.** The controller stages only `web/react-gui/src/types/journal.ts`, `web/react-gui/src/services/journalApi.ts`, and `web/react-gui/src/services/__tests__/journalApi.test.ts`, then commits `feat(journal): add atomic batch and plot resource API contracts`. Sol performs the specification review first and the quality review second.

### Task 16: Station-bounded range parsing and natural station ordering

**Files:**
- Create: `web/react-gui/src/journal/rangeSelection.ts`
- Create: `web/react-gui/src/journal/stationModel.ts`
- Create: `web/react-gui/src/journal/__tests__/rangeSelection.test.ts`
- Create: `web/react-gui/src/journal/__tests__/stationModel.test.ts`

**Interfaces:**

```typescript
export type RangeParseResult =
  | { ok: true; values: number[] }
  | {
      ok: false;
      code: 'empty' | 'malformed' | 'duplicate' | 'out_of_station'
        | 'reversed' | 'non_integer' | 'non_positive';
      token: string;
    };

export type RangeParseFailure = Extract<RangeParseResult, { ok: false }>;

export function parseStationRange(
  input: string,
  availableNumbers: ReadonlySet<number>,
): RangeParseResult;

export function formatStationRange(values: readonly number[]): string;

export interface StationPlotPosition {
  plot: JournalPlot;
  gridNumber: number;
  sourceNumber: number;
}

export interface StationModel {
  gridPlots: StationPlotPosition[];
  namedFallbackPlots: JournalPlot[];
  unstationedPlots: JournalPlot[];
}

export function deriveStationModel(
  stationCode: string,
  plots: readonly JournalPlot[],
): StationModel;
```

- [ ] **Step 1: Write pure RED cases.** Cover `2, 5, 6, 10-12` → `[2, 5, 6, 10, 11, 12]`; whitespace normalization; sorted-unique compressed formatting; empty and repeated commas; malformed `2--4`, `2-`, and `a`; decimal and exponent input; zero/negative input; reversed `12-10`; duplicate `5,5` and overlapping `2-4,4-6`; and out-of-station values. Assert each failure is exactly `{ ok: false, code, token }`, with no silently dropped token. For station numbering, extract from `plot_code` first. An accepted source is a string containing exactly one contiguous ASCII digit run whose parsed value is a positive safe integer; `P-07` yields `7`, `Lysimeter 10` yields `10`, and `plot 2` yields `2`. A decimal, exponent, or text with two digit runs such as `plot 2 row 3` has no accepted token; only then fall back to `name` under the same rule. Add RED cases for code precedence, ambiguous code falling back to an unambiguous name, ambiguous strings in both fields, and two same-station plots deriving the same source number. A collision moves every colliding plot to `namedFallbackPlots`, retains each plot exactly once, and emits no duplicate `gridNumber`. Assert that numeric non-colliding members enter `gridPlots`, named nonnumeric members enter `namedFallbackPlots`, plots without a station enter `unstationedPlots`, and no plot disappears.
- [ ] **Step 2: Run focused RED.** Run `cd web/react-gui && npx vitest run src/journal/__tests__/rangeSelection.test.ts src/journal/__tests__/stationModel.test.ts`. Expected: module-not-found or missing-export failures.
- [ ] **Step 3: Implement pure parsing and ordering.** Trim comma-separated tokens; accept one positive integer or one `start-end` pair with integer endpoints; return the exact seven-code failure union for every invalid fact. Expand ranges against `availableNumbers`, reject duplicates and missing numbers, sort successful values numerically, and have `formatStationRange` sort unique values and compress only consecutive runs. Derive a source number with the exact `plot_code`-then-`name` rule from Step 1. Within each station, detect source-number collisions before assigning grid positions; put only unique numeric members in stable numeric order with one-based `gridNumber`, move every colliding plot to `namedFallbackPlots`, and retain unstationed facts separately.
- [ ] **Step 4: Run GREEN.** Rerun the focused command. Expected: all parser and station-ordering cases pass with no DOM or React dependency.
- [ ] **Step 5: Controller-only commit and reviews.** Commit the four exact files as `feat(journal): add bounded station range selection model`. Sol reviews specification, then quality.

### Task 17: SWR plot and group loading, mutation, and revalidation seams

**Files:**
- Modify: `web/react-gui/src/journal/useJournalPlots.ts`
- Create: `web/react-gui/src/journal/useJournalPlotGroups.ts`
- Modify: `web/react-gui/src/journal/__tests__/useJournalPlots.test.tsx`
- Create: `web/react-gui/src/journal/__tests__/useJournalPlotGroups.test.tsx`

**Interfaces:**

```typescript
export interface JournalPlotResourceActions {
  createPlot: (payload: JournalPlotWritePayload) => Promise<JournalPlot>;
  updatePlot: (uuid: string, payload: JournalPlotWritePayload) => Promise<JournalPlot>;
  revalidate: () => Promise<unknown>;
}

export interface JournalPlotsState extends JournalPlotResourceActions {
  plots: JournalPlot[];
  loading: boolean;
  error: unknown | null;
  mutationError: unknown | null;
  retry: () => Promise<unknown>;
}

export interface JournalPlotGroupResourceActions {
  createPlotGroup: (payload: JournalPlotGroupWritePayload) => Promise<PlotGroup>;
  updatePlotGroup: (uuid: string, payload: JournalPlotGroupWritePayload) => Promise<PlotGroup>;
  revalidate: () => Promise<unknown>;
}

export interface JournalPlotGroupsState extends JournalPlotGroupResourceActions {
  groups: PlotGroup[];
  activeGroups: PlotGroup[];
  resolvedGroups: PlotGroup[];
  loading: boolean;
  error: unknown | null;
  mutationError: unknown | null;
  retry: () => Promise<unknown>;
}
```

- [ ] **Step 1: Write RED hook tests.** Extend the plot hook tests with `does not fetch while disabled`, `returns read errors instead of an empty success`, `awaits create then revalidates plots`, `awaits update then revalidates plots`, `does not claim a canonical plot before the server response`, and `surfaces mutation errors`. Add group tests for the same seams plus `retains resolved groups in groups while exposing only active groups to the picker`; assert loading, read error, retry, and mutation-error states separately.
- [ ] **Step 2: Run focused RED.** Run `cd web/react-gui && npx vitest run src/journal/__tests__/useJournalPlots.test.tsx src/journal/__tests__/useJournalPlotGroups.test.tsx`. Expected: the group hook is missing and the mutation actions are missing from the plot hook.
- [ ] **Step 3: Implement the SWR seams.** Keep the existing keys, public `loading` name, and no-focus-revalidation behavior. Each mutation action awaits the unwrapped `JournalPlot` or `PlotGroup` returned by `journalApi`, then awaits SWR `mutate()` with no optimistic data, no `optimisticData`, and no local array replacement. Surface rejected reads and mutations distinctly, expose retry, return `groups` unchanged for management/timeline consumers, derive `activeGroups` by unresolved state, and retain resolved groups in `resolvedGroups` and the raw collection. The hooks own this revalidation; no form-level second revalidation callback exists.
- [ ] **Step 4: Run GREEN and typecheck.** Rerun the focused command and `cd web/react-gui && npx tsc --noEmit`. Expected: all hook tests and TypeScript pass.
- [ ] **Step 5: Controller-only commit and reviews.** Commit the four exact files as `feat(journal): add SWR plot and group mutation seams`. Sol reviews specification, then quality.

### Task 18: Accessible station grid

**Files:**
- Create: `web/react-gui/src/components/journal/where/StationGrid.tsx`
- Create: `web/react-gui/src/components/journal/__tests__/where/StationGrid.test.tsx`

**Interface:**

```typescript
export interface StationGridProps {
  stationCode: string;
  stationLabel: string;
  plots: readonly StationPlotPosition[];
  namedFallbackPlots: readonly JournalPlot[];
  selectedPlotUuids: ReadonlySet<string>;
  rangeText: string;
  rangeError: RangeParseFailure | null;
  onTogglePlot: (plotUuid: string) => void;
  onSelectAll: () => void;
  onInvert: () => void;
  onRangeTextChange: (value: string) => void;
  onApplyRange: () => void;
}
```

- [ ] **Step 1: Write RED component tests.** Name tests `renders one collapsed station row instead of a long plot list`, `expands a numbered grid with toggle buttons`, `keeps select all and invert scoped to the station`, `shows the range input and exact structured parse error`, `calls the accessible apply callback from the button and Enter`, `renders named nonnumeric fallback plots outside the numeric grid`, `renders a selection count and human labels`, `keeps primary controls at least 56px`, and `renders focusable grid controls with visible focus classes`. Keep semantic, class, and focusable-element assertions in this JSDOM suite; real viewport overflow and browser Tab traversal belong to Task 25.
- [ ] **Step 2: Run RED.** Run `cd web/react-gui && npx vitest run src/components/journal/__tests__/where/StationGrid.test.tsx`. Expected: module-not-found failure.
- [ ] **Step 3: Implement the smallest accessible row.** Render one `<details>`/`<summary>` station row with the member count; render numbered `gridPlots` only when expanded; render `namedFallbackPlots` outside that grid; use `aria-pressed`, visible labels, a labelled range input, an Apply button and Enter handler that invoke the same `onApplyRange`, the structured `rangeError` token/code, `min-h-[56px]` on touch controls, visible focus rings, and flex/grid wrapping that does not impose a fixed desktop width. Route all changes through the typed callbacks; do not keep a second canonical selection inside the component.
- [ ] **Step 4: Run GREEN.** Rerun the focused command and inspect the rendered DOM for the accessible name, focus order, and no long-list fallback.
- [ ] **Step 5: Controller-only commit and reviews.** Commit the two exact files as `feat(journal): add accessible station grid selection`. Sol reviews specification, then quality.

### Task 19: PlotPicker composition and active plot-group chips

**Files:**
- Create: `web/react-gui/src/components/journal/where/PlotGroupChips.tsx`
- Create: `web/react-gui/src/components/journal/where/PlotPicker.tsx`
- Create: `web/react-gui/src/components/journal/__tests__/where/PlotGroupChips.test.tsx`
- Create: `web/react-gui/src/components/journal/__tests__/where/PlotPicker.test.tsx`

**Interfaces:**

```typescript
export interface PlotSelection {
  plotUuids: string[];
  layoutCode: string | null;
  isMultiPlot: boolean;
}

export interface PlotPickerProps {
  plots: readonly JournalPlot[];
  activeGroups: readonly PlotGroup[];
  resolvedGroups: readonly PlotGroup[];
  allowNoPlot: boolean;
  maxPlots?: 100;
  value: PlotSelection;
  onChange: (selection: PlotSelection) => void;
  onCreateGroup: (payload: JournalPlotGroupWritePayload) => Promise<PlotGroup>;
  onUpdateGroup: (groupUuid: string, payload: JournalPlotGroupWritePayload) => Promise<PlotGroup>;
}
```

- [ ] **Step 1: Write RED tests.** Cover one-tap active-group selection with member-level deselection; resolved groups absent from the picker but present in the supplied retained collection; station rows plus unstationed plots; explicit `No plot` only when `allowNoPlot` is true; a homogeneous multi-selection producing one layout; mixed-layout selection blocked with an alert before the form callback; a 101st selection rejected with a count/error; and manual multi-selection offering `Create group` whose callback receives `{ group_uuid: crypto.randomUUID(), base_sync_version: 0, label, members: sortedMembers, resolved: false }`. Cover active-group `Edit group` with the existing `group_uuid`, `sync_version`, `label`, `resolved_at: null`, and sorted members, and assert that the payload's `resolved` field is `false`. Model the Axios rejection exactly as `{ response: { data: { error: 'heterogeneous_group', message, details: null } } }` and assert that `response.data` is rendered visibly, not reduced to silent chip removal.
- [ ] **Step 2: Run RED.** Run `cd web/react-gui && npx vitest run src/components/journal/__tests__/where/PlotGroupChips.test.tsx src/components/journal/__tests__/where/PlotPicker.test.tsx`. Expected: missing component/export failures.
- [ ] **Step 3: Implement composition and selection wiring.** Partition active plots by `station_code`, call `deriveStationModel`, and render each station through `StationGrid`; render named fallback and unstationed plots in visible wrapped sections; render active group chips before stations; filter groups whose `resolved_at` is non-null from the picker only and retain them in parent data. A group chip selects all its members, while each member remains individually editable. Keep range text and parser errors per station. On `onApplyRange`, parse against the `sourceNumber` set from that station's unique `gridPlots` only, map valid source numbers to those plot UUIDs, replace only that station's selected UUIDs, and preserve selections from every other station plus named/unstationed plots. Show every parser failure, heterogeneous-layout error, and 100-plot-cap rejection visibly; never truncate selection silently. Recompute the selected layout from all selected plots before invoking `onChange`; if layouts differ, preserve the existing selection, show the response/domain error, and do not render or notify the entry form. Manual multi-select opens a label field whose create action builds the exact new-group payload with `crypto.randomUUID()`, `base_sync_version: 0`, sorted members, and `resolved: false`. Active-group edit uses the existing `group_uuid`, `sync_version` as `base_sync_version`, current label, sorted members, and `resolved: group.resolved_at !== null`; because the edited group is active, assert that this field is `false`. Surface the exact Axios `response.data` error shape through the localized error state and render that data visibly.
- [ ] **Step 4: Run GREEN and typecheck.** From one GUI-directory shell, run:

  ```bash
  cd web/react-gui
  npx vitest run src/components/journal/__tests__/where/PlotGroupChips.test.tsx src/components/journal/__tests__/where/PlotPicker.test.tsx
  npx tsc --noEmit
  ```

  Expected: tests and typecheck pass.
- [ ] **Step 5: Controller-only commit and reviews.** Commit the four exact files as `feat(journal): compose plot picker and active group chips`. Sol reviews specification, then quality.

### Task 20: Lightweight plot CRUD form

**Files:**
- Create: `web/react-gui/src/components/journal/where/PlotForm.tsx`
- Create: `web/react-gui/src/components/journal/__tests__/where/PlotForm.test.tsx`

**Interface:**

```typescript
export interface PlotFormProps {
  mode: 'create' | 'update';
  initialPlot?: JournalPlot;
  layoutOptions: readonly { code: string; version: number; label: string }[];
  onSubmit: (payload: JournalPlotWritePayload) => Promise<JournalPlot>;
  onAfterSave?: (plot: JournalPlot) => void | Promise<void>;
  onCancel: () => void;
}
```

- [ ] **Step 1: Write RED tests.** Name tests `creates with crypto.randomUUID and base version zero`, `sends exactly the shipped plot fields`, `updates with the existing UUID and current sync version`, `requires an explicit catalog layout and never selects open_field silently`, `renders plot code conflict and stale version responses`, `renders heterogeneous-group and unresolved-group deactivation conflicts`, `uses 56px labels and controls`, and `awaits the supplied mutation before optional close notification`. There is no plot/group revalidation callback in this interface.
- [ ] **Step 2: Run RED.** Run `cd web/react-gui && npx vitest run src/components/journal/__tests__/where/PlotForm.test.tsx`. Expected: module-not-found failure.
- [ ] **Step 3: Implement the exact form.** Generate one create-mode UUID with `crypto.randomUUID()`, keep it stable across rerenders, and send exactly `plot_uuid`, `base_sync_version: 0`, `plot_code`, `name`, `zone_uuid`, `station_code`, `crop_hint`, `area_m2`, `active` as `0 | 1`, `layout_code`, and `layout_version`. In update mode send the existing UUID and current `sync_version` as the base. Require a selected active catalog layout; do not substitute `open_field`. Map code-conflict, stale-version, heterogeneous-group, and unresolved-group deactivation errors to visible `role=alert` text and leave entered values intact on failure. Await `onSubmit`, receive the unwrapped `JournalPlot`, and invoke only the optional `onAfterSave` close/notification callback; the hook remains responsible for revalidation.
- [ ] **Step 4: Run GREEN and typecheck.** Rerun the focused command and `cd web/react-gui && npx tsc --noEmit`. Expected: tests and typecheck pass.
- [ ] **Step 5: Controller-only commit and reviews.** Commit the two exact files as `feat(journal): add explicit-layout plot CRUD form`. Sol reviews specification, then quality.

### Task 21: JournalCaptureFlow multi-plot integration

**Files:**
- Modify: `web/react-gui/src/components/journal/capture/JournalCaptureFlow.tsx`
- Modify: `web/react-gui/src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx`
- Modify: `web/react-gui/src/pages/JournalPage.tsx`
- Modify: `web/react-gui/src/pages/__tests__/JournalPage.test.tsx`
- Create: `web/react-gui/src/journal/buildFinalBatchPayload.ts`
- Create: `web/react-gui/src/journal/__tests__/buildFinalBatchPayload.test.ts`
- Modify: `scripts/task14-journal-preview.js`
- Modify: `scripts/test-task14-journal-preview.js`

**Interfaces:**

```typescript
export type JournalSavedReceipt = EntryFinalMutationReceipt | BatchMutationReceipt;

export interface JournalCaptureFlowProps {
  catalog: JournalCatalog;
  plots: JournalPlot[];
  plotGroups: PlotGroup[];
  initialPlot?: JournalPlot;
  recentEntries: EntryAggregate[];
  initialTimezone?: string;
  zoneCrops?: Readonly<Record<string, string>>;
  zoneTimezones?: Readonly<Record<string, string>>;
  plotState: Pick<JournalPlotResourceActions, 'createPlot' | 'updatePlot'>;
  groupState: Pick<JournalPlotGroupResourceActions, 'createPlotGroup' | 'updatePlotGroup'>;
  onClose: () => void;
  onOpenExisting: (entryUuid: string) => void;
  onSaved: (receipt: JournalSavedReceipt) => void | Promise<void>;
}
```

- [ ] **Step 0: Re-read current Phase 3 findings before RED.** Read the current Phase 3 section of `REVIEW-FINDINGS`, including concurrent commit `bbb85004`. Keep P1, P2, and P3 with their Phase 3 owners; adapt to any landed fix without overwriting it. Phase 4 tests must not encode the known unsafe denominator carry-forward behavior as desired behavior.
- [ ] **Step 1: Write RED integration, builder, route, and preview-harness tests.** Add tests named `renders one shared details form only after homogeneous multi-plot selection`, `blocks mixed-layout selections before EntryForm renders`, `confirms every target name and count`, `posts one atomic final batch with sorted plot_uuids and no batch_uuid`, `uses the returned batch receipt`, `shows plural duplicate candidates and retries with duplicate_guard_ack_entry_uuids`, `rejects a 101-plot selection before rendering the form`, `keeps single-plot draft POST then PUT promotion unchanged`, `does not call createEntry once per selected plot`, `preserves the existing nine-activation open_field SLA regression`, `reaches New plot and Edit selected plot controls through the route`, and `reaches group create and active-group edit controls through the route`. Add `buildFinalBatchPayload` RED cases for an empty selection, 101 plots, duplicate UUIDs, and an unsorted valid selection. Assert the exact domain errors `{ error: 'invalid_batch', message: 'Batch plots must be a nonempty array', details: null }`, `{ error: 'batch_too_large', message: 'A journal batch may contain at most 100 plots', details: null }`, and `{ error: 'duplicate_plot', message: 'A journal batch cannot contain duplicate plots', details: null }`; assert valid UUIDs are sorted before the builder returns, and assert a rejected builder result makes no `journalApi.createFinalBatch` POST. The builder tests also assert both `plot_uuid` and `zone_uuid` are absent while the single-entry draft POST and PUT path remains unchanged. Extend the existing `scripts/test-task14-journal-preview.js` suite with cases for numeric and nonnumeric station plots, range Apply/Enter, active/resolved groups, plot/group envelope unwrapping and version rules including generic `resolved: true` PUT wire support, one atomic batch response with edge-generated `batch_uuid` and N receipts, plural duplicate candidates plus acknowledgement retry, plot create/update, and group create/edit.
- [ ] **Step 2: Run RED.** Run:

  ```bash
  cd web/react-gui && npx vitest run src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx src/pages/__tests__/JournalPage.test.tsx src/journal/__tests__/buildFinalBatchPayload.test.ts
  cd ../.. && node scripts/test-task14-journal-preview.js
  ```

  Expected: the GUI suites fail on missing batch selection/save behavior, and the preview suite fails because the harness still exposes one plot, no plot-group resources, single-entry POST behavior, and no plural duplicate response.
- [ ] **Step 3: Extend the guarded preview harness.** Add multiple station plots with numeric and nonnumeric codes, active and resolved groups, and guarded `GET`, `POST`, and UUID-encoded `PUT` handling for plots and plot-groups, including generic `resolved: true` and `resolved: false` wire values. Return the shipped `{ plots }`, `{ plot_groups }`, `{ plot }`, and `{ plot_group }` envelopes; enforce the UI-required `base_sync_version` and current-version rules. Keep the harness mock-only, not production API authority, and continue routing applicable entry payload validation through the shipped edge validator. Task 21's preview scope covers the generic plot-group wire envelope only.
- [ ] **Step 4: Wire the plot/group hooks and CRUD controls through JournalPage.** Load plots and groups from SWR, pass the raw groups plus `plotState.createPlot/updatePlot` and `groupState.createPlotGroup/updatePlotGroup` to capture, and revalidate entries after a successful receipt. Keep unavailable/error states distinct from empty collections. Pass group mutation actions to the picker; plot and group mutation revalidation remains owned by the hooks. Make `New plot` and `Edit selected plot` visible controls, mount `PlotForm`, and pass the active catalog layout options. Make group create and active-group edit visible through the picker/chip controls and the group hook callbacks. Add route-level tests for all four reachability paths.
- [ ] **Step 5: Integrate the picker without changing the single path.** Track selected UUIDs as a sorted set. For one UUID, retain `useCaptureDraft`, the existing `entry_uuid`, scalar duplicate acknowledgement, and final PUT promotion. For multiple homogeneous plots, render the same catalog-driven `EntryForm` once, display the selected plot names/count in `ConfirmStrip`, and bypass draft serialization entirely.
- [ ] **Step 6: Implement the dedicated atomic batch builder and final request.** Add `buildFinalBatchPayload` as the only batch payload construction seam and the defensive runtime authority before the service call. It rejects an empty selection, more than 100 plots, or duplicate UUIDs with the exact structured/domain errors pinned in Step 1; it sorts valid UUIDs before returning one `CreateFinalBatchPayload` with `status: 'final'`, `plot_uuids`, `base_sync_version: 0`, one shared values payload, pinned template/layout versions, occurrence fields, and no `entry_uuid`, `batch_uuid`, `plot_uuid`, `zone_uuid`, or scalar duplicate acknowledgement. The picker’s 100-plot cap remains UX prevention, not the validation authority. Call `journalApi.createFinalBatch` exactly once only after the builder succeeds. Store the returned `BatchMutationReceipt` and pass it to `onSaved`; never loop over plots and never call a batch `PUT`. Keep the existing single-entry draft POST and `PUT` promotion path byte-for-byte in behavior, including its scalar duplicate acknowledgement.
- [ ] **Step 7: Implement plural duplicate acknowledgement/retry in the harness and flow.** In the guarded preview, return the shipped 409 `{ error: 'duplicate_candidates', details: { duplicateCandidates: [{ entryUuid, occurredStart, activityCode, plotUuid }] } }` shape for an unacknowledged duplicate batch, then accept the unchanged batch payload with selected UUIDs in `duplicate_guard_ack_entry_uuids` and return the edge-generated batch receipt. In the flow, show every candidate grouped by plot and retry without dropping candidates, converting the list to a scalar, issuing one request per plot, or creating a batch draft. Keep Finish disabled while the request is in flight.
- [ ] **Step 8: Run GREEN and all Phase 3 regressions.** Run:

  ```bash
  cd web/react-gui && npx vitest run src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx src/pages/__tests__/JournalPage.test.tsx src/journal/__tests__/buildFinalBatchPayload.test.ts && npm run test:unit:tsx-runner
  cd ../.. && node scripts/test-task14-journal-preview.js
  ```

  Expected: the new batch, CRUD, generic resolved-plot-group wire, range, and browser-harness cases pass, the existing preview cases retain their 7/7 pass signal, the single-plot SLA remains green, and no draft request is made for a batch. The harness records each request and response for the generic GUI envelopes; it does not prove real edge atomicity.
- [ ] **Step 9: Controller-only commit and reviews.** The controller stages the eight exact files `web/react-gui/src/components/journal/capture/JournalCaptureFlow.tsx`, `web/react-gui/src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx`, `web/react-gui/src/pages/JournalPage.tsx`, `web/react-gui/src/pages/__tests__/JournalPage.test.tsx`, `web/react-gui/src/journal/buildFinalBatchPayload.ts`, `web/react-gui/src/journal/__tests__/buildFinalBatchPayload.test.ts`, `scripts/task14-journal-preview.js`, and `scripts/test-task14-journal-preview.js`, then commits `feat(journal): integrate atomic multi-plot capture`. Sol reviews specification first and quality second. Any Phase 3 finding discovered here is recorded and sent to its owning Phase 3 task; this task does not mark Phase 3 complete.

### Task 22: Post-save harvest group-resolution nudge

**Files:**
- Create: `web/react-gui/src/journal/groupResolutionNudge.ts`
- Create: `web/react-gui/src/journal/__tests__/groupResolutionNudge.test.ts`
- Create: `web/react-gui/src/components/journal/where/HarvestGroupNudge.tsx`
- Create: `web/react-gui/src/components/journal/__tests__/where/HarvestGroupNudge.test.tsx`
- Modify: `web/react-gui/src/components/journal/capture/JournalCaptureFlow.tsx`
- Modify: `web/react-gui/src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx`
- Modify: `scripts/test-task14-journal-preview.js`

**Interfaces:**

```typescript
export function matchingActiveHarvestGroups(
  activityCode: string,
  selectedPlotUuids: readonly string[],
  groups: readonly PlotGroup[],
): PlotGroup[];

export interface HarvestGroupNudgeProps {
  groups: readonly PlotGroup[];
  onResolve: (group: PlotGroup) => Promise<void>;
  errors: ReadonlyMap<string, string>;
}
```

- [ ] **Step 1: Write RED tests.** Cover exact set equality only; extra selected plots and partial group coverage produce no nudge; non-harvest activity produces no nudge; resolved groups are ignored; multiple matches sort by `label` using a stable case-folded comparison then `group_uuid`; each visible resolve action sends `group_uuid`, the same `label`, the same sorted `members`, `base_sync_version: sync_version`, and `resolved: true`; a successful resolve revalidates groups; a failed resolve remains visible and shows its error; no group resolves automatically. The React capture-flow test owns driving and clicking the visible post-save `HarvestGroupNudge`, then asserting the group-hook update callback, the exact resolved-true payload, and success/error behavior. Extend `scripts/test-task14-journal-preview.js` only with HTTP-level evidence for the exact generic UUID-encoded plot-group `PUT` request and response envelope with `resolved: true`; it does not drive or claim visible React UI behavior.
- [ ] **Step 2: Run RED.** Run these as separate commands:

  ```bash
  cd web/react-gui && npx vitest run src/journal/__tests__/groupResolutionNudge.test.ts src/components/journal/__tests__/where/HarvestGroupNudge.test.tsx src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx
  cd ../.. && node scripts/test-task14-journal-preview.js
  ```

  Expected: the focused GUI suites fail on the missing nudge behavior, including the capture-flow integration assertions, and the preview suite fails its new HTTP-level `resolved: true` request/response evidence even though the generic plot-group endpoint from Task 21 is available.
- [ ] **Step 3: Implement deterministic nudge behavior and record HTTP envelope evidence.** Derive matches only for a successful harvest batch and exact set equality with active groups. Render one opt-in action per matching group after the batch receipt; sort multiple matches by case-folded label and then `group_uuid`. Call the existing UUID-encoded `journalApi.updatePlotGroup` through the group hook with the same `group_uuid`, label, sorted members, current `sync_version` as `base_sync_version`, and `resolved: true`; then await group revalidation. Keep the group label and membership unchanged, show failures beside the action, and never resolve automatically or add an apply-to-all correction action. The React capture-flow test drives the visible post-save action and owns its callback, payload, and success/error assertions. Extend the preview test only to issue the generic HTTP `PUT` and preserve its exact request/response envelope; the endpoint implementation remains owned by Task 21.
- [ ] **Step 4: Run GREEN and typecheck.** Run:

  ```bash
  cd web/react-gui
  npx vitest run src/journal/__tests__/groupResolutionNudge.test.ts src/components/journal/__tests__/where/HarvestGroupNudge.test.tsx src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx
  npx tsc --noEmit
  cd ../..
  node scripts/test-task14-journal-preview.js
  ```

  Expected: all matching, payload, error, ordering, and recorded preview-evidence tests pass.
- [ ] **Step 5: Controller-only commit and reviews.** Commit the seven exact files as `feat(journal): offer harvest plot-group resolution`. Sol reviews specification, then quality. Task 25 retains the real browser wiring acceptance for clicking harvest group resolution at both required phone sizes.

### Task 23: Batch grouping in the timeline

**Files:**
- Modify: `web/react-gui/src/components/journal/JournalTimeline.tsx`
- Modify: `web/react-gui/src/components/journal/__tests__/JournalTimeline.test.tsx`
- Modify: `web/react-gui/src/components/journal/JournalEntryRow.tsx`
- Modify: `web/react-gui/src/components/journal/__tests__/JournalEntryRow.test.tsx`
- Modify: `web/react-gui/src/pages/JournalPage.tsx`
- Modify: `web/react-gui/src/pages/__tests__/JournalPage.test.tsx`
- Create: `web/react-gui/src/journal/hydrateBatchMembership.ts`
- Create: `web/react-gui/src/journal/__tests__/hydrateBatchMembership.test.ts`

**Interface:**

```typescript
export type JournalTimelineItem =
  | { kind: 'entry'; entry: EntryAggregate }
  | {
      kind: 'batch';
      batchUuid: string;
      entries: EntryAggregate[];
      count: number;
      activityCode: string;
      cropSummary: string | null;
    };

export function groupJournalTimelineEntries(
  entries: readonly EntryAggregate[],
): JournalTimelineItem[];

export interface BatchMembershipPage {
  entries: EntryAggregate[];
  next_cursor: string | null;
}

export function hydrateBatchMembership(
  batchUuid: string,
  listPage: (filters: { batch_uuid: string; status: 'all'; limit: 100; cursor?: string }) => Promise<BatchMembershipPage>,
): Promise<EntryAggregate[]>;

export interface JournalTimelineProps {
  entries: EntryAggregate[];
  plots: JournalPlot[];
  loading: boolean;
  listBatchEntries: (filters: { batch_uuid: string; status: 'all'; limit: 100; cursor?: string }) => Promise<BatchMembershipPage>;
}
```

- [ ] **Step 1: Write RED timeline, hydration, and page-wiring tests.** Add `groups final entries sharing a non-null batch_uuid into one collapsed card`, `shows the hydrated batch count and all plot names after expansion`, `keeps entries with null batch_uuid independent`, `orders grouped items by first input occurrence`, `includes activity and crop summary`, and `preserves each child entry_uuid status and base identity for future per-entry actions`. Add hydration tests for `fetches complete membership with status all and limit 100`, `follows next_cursor defensively until null`, `does not fetch a cursor after null`, `shows loading while membership hydrates`, `shows a retryable error when hydration fails`, and `does not issue mutation or apply-to-all calls`. Assert that the callback preserves actual child statuses, including voided children, and that batch creation remains final-only. Add `JournalPage.test.tsx` coverage proving the page passes a typed `listBatchEntries` callback backed by `journalApi.listEntries` (or an equivalent typed adapter) into the required `JournalTimeline` prop. Assert that the grouped card does not invent correction or void controls.
- [ ] **Step 2: Run RED.** From one GUI-directory shell, run:

  ```bash
  cd web/react-gui
  npx vitest run src/components/journal/__tests__/JournalTimeline.test.tsx src/components/journal/__tests__/JournalEntryRow.test.tsx src/journal/__tests__/hydrateBatchMembership.test.ts src/pages/__tests__/JournalPage.test.tsx
  ```

  Expected: the page-wiring, grouped-card, and hydration assertions fail.
- [ ] **Step 3: Implement parent §6.1 grouping and complete-membership hydration.** Wire `JournalPage.tsx` to the required `JournalTimeline` `listBatchEntries` prop using `journalApi.listEntries` directly or an equivalent typed adapter that maps its response to `BatchMembershipPage`. Partition the initially loaded final entries by non-null `batch_uuid`; emit grouped cards in first-occurrence order, preserve input order within each group, and leave null-batch entries independent at their input positions. Batch creation remains final-only. On expansion, call `hydrateBatchMembership(batch_uuid, listBatchEntries)` with `status: 'all'` and `limit: 100` so later voided children remain in complete membership; append pages only while a defensive `next_cursor` is a non-empty string, stop at `null`, and guard against repeated cursors. Display the count, plot labels, and child rows only from the hydrated complete membership, preserving each child's actual `status`, `entry_uuid`, and `sync_version` base identity. Render loading, error, and Retry states and leave the collapsed card usable while hydration is pending. Pass each child identity unchanged to the original `JournalEntryRow` seam for future per-entry actions. Do not add correction or void controls in Phase 4; defer those controls to the Phase 5 detail workspace. Do not issue N mutation calls or expose apply-to-all.
- [ ] **Step 4: Run GREEN.** From one GUI-directory shell, run:

  ```bash
  cd web/react-gui
  npx vitest run src/components/journal/__tests__/JournalTimeline.test.tsx src/components/journal/__tests__/JournalEntryRow.test.tsx src/journal/__tests__/hydrateBatchMembership.test.ts src/pages/__tests__/JournalPage.test.tsx
  npx tsc --noEmit
  ```

  Expected: grouping, complete-membership, loading/error/retry, page-wiring, and entry-identity tests pass.
- [ ] **Step 5: Controller-only commit and reviews.** Commit the eight exact files as `feat(journal): group atomic batches in the journal timeline`. Sol reviews specification, then quality.

### Task 24: Phase 4 locale keys and parity coverage

**Files:**
- Modify: `web/react-gui/public/locales/en/journal.json`
- Modify: `web/react-gui/public/locales/de-CH/journal.json`
- Modify: `web/react-gui/public/locales/es/journal.json`
- Modify: `web/react-gui/public/locales/fr/journal.json`
- Modify: `web/react-gui/public/locales/it/journal.json`
- Modify: `web/react-gui/public/locales/lg/journal.json`
- Modify: `web/react-gui/public/locales/pt/journal.json`
- Modify: `web/react-gui/src/journal/__tests__/journalLocales.test.ts`

- [ ] **Step 1: Write RED parity and component-key assertions.** Extend the English required-key assertion with every user-facing key consumed by Tasks 15–23. The required set includes `where.station`, `where.unstationed`, `where.namedPlots`, `where.noStation`, `where.selectAll`, `where.invert`, `where.range`, `where.applyRange`, `where.rangeSummary`, `where.rangeEmpty`, `where.rangeMalformed`, `where.rangeOutOfStation`, `where.rangeDuplicate`, `where.rangeReversed`, `where.rangeNonInteger`, `where.rangeNonPositive`, `where.mixedLayout`, `where.maxPlots`, `where.maxPlotsError`, `where.noPlot`, `where.selectionCount`, `where.createGroup`, `where.editGroup`, `where.groupLabel`, `where.saveGroup`, `where.cancel`, `where.loading`, `where.retry`, `group.members`, `group.resolved`, `group.resolve`, `group.resolveError`, `group.heterogeneous`, `group.create`, `group.edit`, `group.loading`, `group.error`, `group.retry`, `plot.create`, `plot.update`, `plot.new`, `plot.edit`, `plot.code`, `plot.name`, `plot.zone`, `plot.station`, `plot.cropHint`, `plot.area`, `plot.active`, `plot.layout`, `plot.save`, `plot.cancel`, `plot.layoutRequired`, `plot.stale`, `plot.codeConflict`, `plot.heterogeneousGroup`, `plot.unresolvedGroup`, `plot.loading`, `plot.error`, `plot.retry`, `batch.saving`, `batch.saved`, `batch.confirm`, `batch.confirmCount`, `batch.duplicateTitle`, `batch.duplicateBody`, `batch.duplicateAcknowledge`, `batch.count`, `batch.retry`, `timeline.batch`, `timeline.batchExpand`, `timeline.batchCollapse`, `timeline.batchLoading`, `timeline.batchError`, and `timeline.batchRetry`. Add interpolation checks for `{{count}}`, `{{label}}`, and `{{plot}}` where used. Add a component-key test that imports the English `journal.json` object and asserts every required component key exists at its exact nested path; locale parity alone is insufficient.
- [ ] **Step 2: Run RED.** Run `cd web/react-gui && npx vitest run src/journal/__tests__/journalLocales.test.ts`. Expected: English required-key and six-locale shape/value assertions fail because the Phase 4 tree is absent.
- [ ] **Step 3: Add translations to all seven source files.** Add the same nested key shape to all seven files, translate values where the existing locale policy requires translation, list only reviewed identical terms in `SHARED_WITH_ENGLISH`, preserve interpolation-token sets, and keep Swiss German free of `ß`. Do not add or edit any feed mirror.
- [ ] **Step 4: Run GREEN.** Rerun the focused parity command. Expected: all seven source resources match keys, values, and interpolation tokens.
- [ ] **Step 5: Controller-only commit and reviews.** Commit the eight exact files as `feat(journal): add Phase 4 plot and batch locale keys`. Sol reviews specification, then quality.

### Task 25: Phase 4 final verification and audit

**Files:**
- No source edits; audit the Phase 4 files committed by Tasks 15–24, including the mock preview extensions owned by Tasks 21 and 22. The documentation commit was created before Task 15, so this task expects a clean worktree after the Task 24 commit.

- [ ] **Step 1: Run the complete focused journal set.** Run `cd web/react-gui && npx vitest run src/services/__tests__/journalApi.test.ts src/journal/__tests__/rangeSelection.test.ts src/journal/__tests__/stationModel.test.ts src/journal/__tests__/useJournalPlots.test.tsx src/journal/__tests__/useJournalPlotGroups.test.tsx src/journal/__tests__/groupResolutionNudge.test.ts src/journal/__tests__/buildFinalBatchPayload.test.ts src/journal/__tests__/hydrateBatchMembership.test.ts src/components/journal/__tests__/where/StationGrid.test.tsx src/components/journal/__tests__/where/PlotGroupChips.test.tsx src/components/journal/__tests__/where/PlotPicker.test.tsx src/components/journal/__tests__/where/PlotForm.test.tsx src/components/journal/__tests__/where/HarvestGroupNudge.test.tsx src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx src/components/journal/__tests__/JournalTimeline.test.tsx src/components/journal/__tests__/JournalEntryRow.test.tsx src/journal/__tests__/journalLocales.test.ts src/pages/__tests__/JournalPage.test.tsx`, then run `cd ../.. && node scripts/test-task14-journal-preview.js`. Expected: all Task 15–24 suites pass and the preview suite retains its existing 7/7 cases plus the new plot/group/batch cases.
- [ ] **Step 2: Run the repository GUI gates.** Run `cd web/react-gui && npm run test:unit && npm run typecheck && npm run build`. Expected: the fresh baseline is 94/94 TSX and 939/939 Vitest before Phase 4 additions, all added tests are green, `npm run typecheck` exits 0, and the production build exits 0. Existing Browserslist and large-chunk advisories may remain, but no new error is accepted. The existing uncached `open_field` single-capture path must retain its `<=9` primary-control activation SLA.
- [ ] **Step 3: Run the mocked edge contract gates.** Run `node scripts/test-journal-api.js`, `node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js`, `node conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/index.test.js`, and `node scripts/verify-profile-parity.js`. Expected: the shipped batch, plot, group, lifecycle, and mirrored-profile contracts stay green. No code or edge flow change is part of this Phase 4 plan.
- [ ] **Step 4: Run browser acceptance at both required phone sizes after Task 22.** Build with `cd web/react-gui && npm run build`; start the existing guarded preview with `TASK14_PREVIEW=1 node scripts/task14-journal-preview.js`; use the in-app browser/Chromium at 320×568 and 360×640 against `http://127.0.0.1:41714/gui/#/journal?capture=1&zone_uuid=22222222-2222-4222-8222-222222222222`. At both sizes, exercise range Apply and Enter, keyboard traversal, real no-horizontal-overflow behavior, plot create/update, group create/edit, harvest group resolution, one atomic batch receipt, and plural duplicate acknowledgement. Capture the recorded mock request/response evidence for each CRUD, resolution, batch, and retry envelope plus screenshots at both viewports. The mock harness proves GUI wiring and wire envelopes; it does not prove real edge atomicity. Do not use a pre-journal live gateway.
- [ ] **Step 5: Run prose and audit gates.** From the repository root run `node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-07-15-field-journal-slice2-gui.md docs/superpowers/prompts/field-journal-slice2-codex/RUN-NOTES.md` and `git diff --check -- docs/superpowers/plans/2026-07-15-field-journal-slice2-gui.md docs/superpowers/prompts/field-journal-slice2-codex/RUN-NOTES.md`. Expected: `slop-check: PASS (no tier-1 findings)` and no whitespace output. Review the plan against the fixed decomposition, type shapes, preview authority boundary, Phase 3 ownership, and exact file scopes.
- [ ] **Step 6: Final Sol range audit and gate report.** Sol performs the final specification review, then the quality range audit. The controller verifies no uncommitted changes with `git status --short` and `git diff --exit-code`; an empty result is required after the Task 24 commit. Report the Phase 4 gate only when focused suites, full GUI gates, edge lifecycle/profile checks, browser evidence at 320×568 and 360×640, the single-capture SLA, anti-slop, diff checks, and clean-worktree checks pass. Do not commit in Task 25; the documentation commit happened before Task 15. Phase 4 completion does not imply broader Phase 3 review completion; that status remains separately recorded.

## Phase 5 — Desktop three-pane workspace (code-decompose when reached)

**Blocked on Phases 2, 3.**

**Files (planned):** `src/components/journal/desktop/` — `JournalWorkspace.tsx` (3-column grid ≥1024px), `ScopeRail.tsx` (stations collapsible, active groups, ungrouped plots, filters), `EntryTable.tsx` (dense sortable keyset-paged rows, bulk export selection), `DetailPanel.tsx` (read-back + context snapshot + void/correct, or the persistent entry/enrichment form). `JournalPage` branches on `isDesktopBrowser()` between the mobile flow and `JournalWorkspace`, per the AppHeader Data-tab precedent.

**Acceptance:** the rail lists a 72-plot station as one row; the same `EntryForm` engine renders as a side panel; keyboard navigation between table rows and form fields; exports scoped to active filters sit on the table header.

### Remaining-work decomposition approved at the Phase 5 boundary

The controller reached this boundary on 2026-07-19 after Phase 4 commit `3690d6e1`. Luna inspected the shipped seams and Sol required the corrections below. Tasks 26–35 supersede the two undecomposed Phase 5/6 sketches. They preserve the no-live-gateway and no-`flows.json` boundaries. Migration `0022` remains reserved for the deferred product-composition work; the P4 catalog correction uses a distinct data-migration identity and does not alter schema.

### Task 26: Close Phase 3 review findings P1–P3 and F8

**Files:** `web/react-gui/src/journal/carryForward.ts`, its focused tests, `JournalCaptureFlow.tsx` and its focused tests, plus the shipped-SLA test seam.

- [ ] RED/GREEN P1: derive the plant-protection protected-field expectation from the compiled catalog, include `attr.denominator`, and remove or document phantom codes.
- [ ] RED/GREEN P2: use a complete valid plant-protection source, confirm repeat values, switch plot and layout, and prove protected values are invalidated. Fix only if the reproduction fails.
- [ ] RED/GREEN P3: use a multi-group tank-mix source and require the confirmation disclosure to identify every carried protected row before acceptance.
- [ ] RED/GREEN F8: derive the activation-SLA fixture from the compiled `farmer_quick@1` and `open_field@1` definitions instead of a hand-maintained mirror.
- [ ] Luna implements; Sol reviews specification, then quality; the controller runs the focused set, full GUI tests, typecheck, build, and commits only approved files.

### Task 27: Land adjudicated P4 as catalog version 2

**Files:** `scripts/journal-catalog-core.js`, generator/tests, a new ordered data migration that does not consume reserved `0022`, seed and bundled database artifacts, both profile copies as applicable, `catalogModel.ts`, and focused catalog/capture tests.

- [ ] RED: `farmer_quick@2` visibly contains `attr.operator`, `attr.equipment`, and `attr.method`, carries the three, and preserves `farmer_quick@1` for historical entries.
- [ ] RED: `parseTemplate` rejects any `carry_forward` code outside that template version's visible field set.
- [ ] RED: a quick-entry carry-forward flow visibly marks and submits all three values in the final payload.
- [ ] GREEN: publish a catalog-version-2 data update without rewriting immutable migration `0019`; update the authoritative seed and bundled DB copies, catalog hash/version, checksums, and both-profile parity. Do not change schema or the deferred composition rows.
- [ ] Apply the `osi-schema-change-control` data-migration gates, including seed replay, migration verification, DB consistency, sync/catalog parity, and production-copy rehearsal. Luna implements; Sol reviews specification, then quality.

### Task 28: Desktop shell and scope rail

**Files:** `desktop/JournalWorkspace.tsx`, `desktop/ScopeRail.tsx`, their tests, `JournalPage.tsx`, and its test.

- [ ] RED/GREEN the `isDesktopBrowser()` branch while preserving the mobile capture/timeline route.
- [ ] Render stations, active groups, ungrouped plots, search, and activity/status/date/campaign/protocol filters from existing plot/group data. A 72-plot station is one collapsible row with plot count and sensor-status summary.
- [ ] Keep filter state in the workspace owner and expose keyboard-operable scope controls. Luna implements; Sol reviews specification, then quality.

### Task 29: Keyset table and filter-scoped exports

**Files:** `desktop/EntryTable.tsx`, tests, `journalApi.ts`, service tests, and a typed pagination helper if needed.

- [ ] RED/GREEN dense sortable rows, row selection, Arrow/Home/End keyboard movement, loading/error/empty states, and defensive opaque-cursor pagination.
- [ ] Add typed CSV, JSON, and research-package downloads using the shipped endpoints. Preserve active filters exactly; do not advertise the Slice-1 `501` ADAPT endpoint as available.
- [ ] Put export controls in the table header and prove that selected bulk-entry filters combine with, rather than escape, the active scope. Luna implements; Sol reviews specification, then quality.

### Task 30: Detail read-back and full-record correction

**Files:** `desktop/DetailPanel.tsx`, an aggregate-to-update adapter, focused tests, and `JournalWorkspace.tsx` integration.

- [ ] RED/GREEN read-back for values and parsed context snapshot, final-entry void with explicit reason, and safe stale/error states.
- [ ] Build correction from the selected complete `EntryAggregate`; initialize the shared `EntryForm` engine and submit one complete `UpdateEntryPayload`, preserving all unchanged identity/context fields, occurrence offsets, grouped values, and `batch_uuid`.
- [ ] Block correction for draft/voided entries and prove one changed field does not drop untouched values. Move keyboard focus from the selected table row into the first form field on request. Luna implements; Sol reviews specification, then quality.

## Phase 6 — Chart markers, drafts queue, layout-transition review, locale mirror (code-decompose when reached)

**Blocked on Phases 2, 3.**

**Files (planned):** `src/components/journal/markers/JournalMarkerLane.tsx` + integration into the history chart surfaces (`src/components/history/visualizations/`) — separate event lane, icon+shape+color (not color alone), ≥48px hit targets, rendered-distance clustering with counts, bottom sheet; `src/components/journal/DraftsQueue.tsx` (P7 "needs completion"); layout-transition review sheet blocking finalize (UX-3); then add `journal` to the feed locale mirror in `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/` and extend `tests/agrolinkBranding.test.ts` to enforce it.

**Acceptance:** marker density tested at 0/1/50/500 events at 320px over 24h and season ranges; drafts queue opens the detail panel with field-level focus on what is missing; the locale mirror test covers `journal.json`.

### Task 31: Persisted-draft discard contract and drafts queue

**Files:** both maintained `osi-journal` API/lifecycle copies and tests, GUI types/service tests, `DraftsQueue.tsx` and tests, and page/workspace integration.

- [ ] RED/GREEN an explicit discard operation over the existing journal entry `PUT` transport so `flows.json` remains untouched. It is owner-scoped, accepts only `draft` at sync version zero, transactionally hard-deletes entry values and the draft, emits no tombstone/outbox event, rejects final/voided entries, and treats an exact repeated discard as success.
- [ ] Mirror both profile copies byte-identically and run lifecycle, API, sync/outbox, profile-parity, and no-stray-DDL gates.
- [ ] RED/GREEN the “Needs completion” queue from `status=draft`: loading/retry/empty/stale states, resume into the shared detail/capture form, focus the first missing field, and discard success/error behavior. No browser-only persistence or hidden flag is allowed. Luna implements; Sol reviews specification, then quality.

### Task 32: Layout-transition review sheet

**Files:** capture transition model/tests, `JournalCaptureFlow.tsx`, a focused review-sheet component, capture tests, and locale keys.

- [ ] RED/GREEN a diff of values made invalid or hidden by a layout change, including choices no longer allowed and fields no longer present.
- [ ] Block finalize until every item is explicitly kept under the old setting, replaced with a valid value, or removed. Preserve valid values and never silently sanitize a user-entered value.
- [ ] Cover plot/layout changes, Back navigation, retry, and accessible focus return. Luna implements; Sol reviews specification, then quality.

### Task 33: History-owned journal marker data and pure marker lane

**Files:** a history journal-marker data hook/helper and tests, `JournalMarkerLane.tsx` and tests, `HistoryCardVisualization.tsx`, `HistoryDesktopDetail.tsx`, and focused integration tests.

- [ ] The history detail data layer, not the lane or individual chart components, keyset-pages final entries by `zone_uuid`, visible `occurred_from`, and `occurred_to`; expose loading/error/retry and normalized markers.
- [ ] RED/GREEN the pure lane at 0/1/50/500 events and 320 px over 24-hour and season windows. Cluster by rendered distance, show counts, use icon plus shape plus color, provide at least 48 px targets, keyboard operation, filters, and a details bottom sheet.
- [ ] Integrate one sibling lane through the common `HistoryCardVisualization` seam without duplicating journal requests in chart implementations. Luna implements; Sol reviews specification, then quality.

### Task 34: Journal locale completion and feed mirror

**Files:** all seven source `journal.json` files, the seven feed mirrors, journal locale tests, and `web/react-gui/tests/agrolinkBranding.test.ts`.

- [ ] Add every Task 26–33 user-facing key to all source locales while preserving interpolation-token parity and the de-CH `ß` rule.
- [ ] Copy source resources byte-for-byte into the feed locale tree and extend the branding test to require `journal.json` for every locale.
- [ ] Run JSON, locale, mirror, branding, anti-slop, and diff gates. Luna implements; Sol reviews specification, then quality.

### Task 35: Slice 2 final verification and merge-readiness

- [ ] Run all focused journal, lifecycle, API, migration, sync, profile, locale, history, and preview suites; then full GUI unit tests, typecheck, and production build.
- [ ] Run Playwright acceptance at 320x568, 360x640, and desktop widths for mobile capture, desktop three-pane operation, draft resume/discard, transition review, marker densities, keyboard paths, exports, and no horizontal overflow. Save screenshots and request evidence outside the repository.
- [ ] Re-read `REVIEW-FINDINGS.md`; record P1–P4, P6, F8, deferred F1/0022, native-translation sign-off, and broader Phase 3 review status accurately in `RUN-NOTES.md`.
- [ ] Sol performs final specification and quality range reviews. Write `MERGE-READINESS.md` with exact commits, gates, evidence paths, residual risks, and deployment prerequisites. Require a clean worktree; do not push, merge, or touch a live gateway without a new explicit instruction.

---

## Self-review

- **Spec coverage:** §6.1 entry/save/carry-forward → Phase 3; §6.2 templates×layouts → Phase 3 (`templateEngine`); §6.3 timeline → Phase 2, markers → Phase 6; §6.4 i18n → Phase 6 + the per-task English keys; D10 plot-first/no-zone → Phases 2–4; D11 batch/stations/groups → Phase 4; P7 capture→enrich → Phases 3/5/6. The one gap the spec does not name — the catalog DTO stripping definitions/labels — is captured as the Phase 0 prerequisite.
- **Placeholder scan:** Phases 1–2 carry complete code in every step. Phase 4 is decomposed as Tasks 15–25 with exact files, interfaces, RED/GREEN commands, review gates, and commit boundaries. Only Phases 5–6 remain "code-decompose when reached" sections because their forms depend on later product decisions.
- **Type consistency:** `journalApi`, `CreateEntryPayload`, `EntryAggregate`, `EntryListFilters`, `useJournalCatalog`, `useJournalEntries`, `JournalEntryRow`, `JournalTimeline` names are used identically across the tasks that define and consume them.
