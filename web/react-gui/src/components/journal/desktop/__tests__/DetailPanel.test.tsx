import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { EntryAggregate, JournalCatalog, JournalPlot } from '../../../../types/journal';
import { formatOccurredDate } from '../../JournalEntryRow';

const mocks = vi.hoisted(() => ({
  useJournalEntries: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  voidEntry: vi.fn(),
  discardDraft: vi.fn(),
  listEntries: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en', language: 'en' },
  }),
}));

vi.mock('../../../../journal/useJournalEntries', () => ({
  useJournalEntries: mocks.useJournalEntries,
}));

vi.mock('../../../../services/journalApi', () => ({
  journalApi: {
    createEntry: mocks.createEntry,
    updateEntry: mocks.updateEntry,
    voidEntry: mocks.voidEntry,
    discardDraft: mocks.discardDraft,
    listEntries: mocks.listEntries,
  },
}));

import { DetailPanel } from '../DetailPanel';

const timestamp = '2026-07-16T08:00:05.000Z';

function row(code: string, kind: 'activity' | 'attribute', valueType: 'text' | null = null) {
  return {
    code,
    kind,
    parent_code: null,
    value_type: kind === 'activity' ? null : valueType,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: kind === 'activity' ? 'observation' : null,
    scope: 'core' as const,
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 0,
    sync_version: 0,
    created_at: timestamp,
    deleted_at: null,
    catalog_errors: [],
    labels: { en: code === 'attr.operator' ? 'Operator' : code === 'irrigation' ? 'Irrigation' : code },
    constraints: null,
  };
}

const catalog: JournalCatalog = {
  catalog_version: 1,
  catalog_hash: 'hash-1',
  vocab: [row('irrigation', 'activity'), row('attr.operator', 'attribute', 'text')],
  templates: [{
    code: 'farmer_quick',
    version: 1,
    active: 1,
    catalog_errors: [],
    labels: { en: 'farmer_quick' },
    definition: {
      fields: ['attr.operator'],
      sections: [],
      carry_forward: [],
      require_explicit_choices: false,
      show_standard_mappings: false,
      activity_requirements: {},
      conditional_groups: [],
      requirements: { required: [], optional: [], required_any: [] },
    },
  }],
  layouts: [{
    code: 'open_field',
    version: 1,
    active: 1,
    catalog_errors: [],
    labels: { en: 'open_field' },
    definition: {
      activity_codes: ['irrigation'],
      supported_templates: ['farmer_quick'],
      fields: [],
      minimum_fields: [],
      conditional_fields: {},
      denominator_contract: [],
      option_dependencies: [],
    },
  }],
  products: [],
  mappings: [],
};

function plot(overrides: Partial<JournalPlot> = {}): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: 'plot-1',
    plot_code: 'N-1',
    name: 'North field',
    zone_uuid: null,
    station_code: null,
    crop_hint: null,
    area_m2: null,
    active: 1,
    sync_version: 0,
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: timestamp,
      updated_by_principal_uuid: 'author',
      sync_version: 0,
    },
    ...overrides,
  };
}

function entry(overrides: Partial<EntryAggregate> = {}): EntryAggregate {
  return {
    contract_version: 1,
    entry_uuid: 'entry-1',
    owner_user_uuid: 'owner',
    author_principal_uuid: 'author',
    author_label: null,
    gateway_device_eui: 'gateway',
    plot_uuid: 'plot-1',
    zone_uuid: null,
    device_eui: null,
    season_uuid: null,
    season_crop: null,
    season_variety: null,
    campaign_uuid: 'campaign-1',
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    activity_code: 'irrigation',
    template_code: 'farmer_quick',
    template_version: 1,
    layout_code: 'open_field',
    layout_version: 1,
    catalog_version: 1,
    occurred_start: '2026-07-16T08:00:00.000Z',
    occurred_end: null,
    occurred_timezone: 'Europe/Zurich',
    occurred_utc_offset_minutes: 120,
    origin: 'edge-ui',
    status: 'final',
    batch_uuid: null,
    pass_uuid: null,
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: null,
    context_json: null,
    sync_version: 2,
    recorded_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    values: [
      {
        group_index: 0,
        attribute_code: 'attr.operator',
        value_status: 'observed',
        value_num: null,
        value_text: 'Alex',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      },
    ],
    ...overrides,
  };
}

function mockDetail(overrides: {
  entries?: EntryAggregate[];
  loading?: boolean;
  error?: unknown;
  retry?: () => Promise<unknown>;
} = {}) {
  const retry = overrides.retry ?? vi.fn().mockResolvedValue(undefined);
  mocks.useJournalEntries.mockReturnValue({
    entries: overrides.entries ?? [],
    loading: overrides.loading ?? false,
    error: overrides.error,
    nextCursor: null,
    retry,
  });
  return retry;
}

function renderPanel(overrides: {
  plots?: JournalPlot[];
  selectedEntryUuid?: string | null;
  onFocusReturn?: () => void;
  catalogOverride?: JournalCatalog;
} = {}) {
  const onFocusReturn = overrides.onFocusReturn ?? vi.fn();
  const selectedEntryUuid = 'selectedEntryUuid' in overrides ? overrides.selectedEntryUuid! : 'entry-1';
  const utils = render(
    <DetailPanel
      catalog={overrides.catalogOverride ?? catalog}
      plots={overrides.plots ?? [plot()]}
      selectedEntryUuid={selectedEntryUuid}
      onFocusReturn={onFocusReturn}
    />,
  );
  return { ...utils, onFocusReturn };
}

beforeEach(() => {
  mocks.useJournalEntries.mockReset();
  mocks.createEntry.mockReset();
  mocks.updateEntry.mockReset();
  mocks.voidEntry.mockReset();
  mocks.discardDraft.mockReset();
  mocks.listEntries.mockReset().mockResolvedValue({ entries: [], next_cursor: null });
});

describe('DetailPanel — read-back states', () => {
  it('shows the placeholder when nothing is selected, without fetching anything', () => {
    renderPanel({ selectedEntryUuid: null });

    expect(screen.getByText('workspace.detail.placeholder')).toBeInTheDocument();
    expect(mocks.useJournalEntries).not.toHaveBeenCalled();
  });

  it('fetches the selected entry by uuid across every status, not just final', () => {
    mockDetail({ entries: [entry()] });

    renderPanel({ selectedEntryUuid: 'entry-1' });

    expect(mocks.useJournalEntries).toHaveBeenCalledWith({ entry_uuid: 'entry-1', status: 'all' }, true);
  });

  it('shows a loading state while the detail fetch is in flight', () => {
    mockDetail({ entries: [], loading: true });

    renderPanel();

    expect(screen.getByText('workspace.detail.loading')).toBeInTheDocument();
  });

  it('shows a retryable error state when the detail fetch fails', () => {
    const retry = mockDetail({ entries: [], error: new Error('network') });

    renderPanel();

    expect(screen.getByText('workspace.detail.error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.retry' }));
    expect(retry).toHaveBeenCalled();
  });

  it('shows a safe not-found state when the selected entry changed or was removed underneath', () => {
    mockDetail({ entries: [] });

    renderPanel();

    expect(screen.getByText('workspace.detail.notFound')).toBeInTheDocument();
  });

  it('renders the activity, status, plot, and stored values of a final entry', () => {
    mockDetail({ entries: [entry()] });

    renderPanel();

    expect(screen.getByText('row.status.final')).toBeInTheDocument();
    expect(screen.getByText('North field')).toBeInTheDocument();
    expect(screen.getByText('Alex')).toBeInTheDocument();
  });

  // P2-c: the header used to show the raw `t(`activity.${code}`, code)`
  // fallback — the client-side journal.json activity.* namespace only covers
  // a handful of the shipped activity codes. Reuse the catalog's own label
  // (same source ActivityPicker already reads) so the header shows a human
  // label whenever the catalog has one, not a raw snake_case code.
  it('shows the catalog-provided activity label in the header, not a raw code', () => {
    mockDetail({ entries: [entry({ activity_code: 'irrigation' })] });

    renderPanel();

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Irrigation');
  });

  it('falls back to the raw activity code in the header when the catalog has no matching row', () => {
    mockDetail({ entries: [entry({ activity_code: 'unmapped_activity' })] });

    renderPanel();

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('unmapped_activity');
  });

  // P2-c: a season_crop value is itself a vocab choice code (e.g.
  // agroscope.crop.potato) — show its catalog label when the catalog has one.
  it('shows a localized crop label for season_crop when the catalog has a matching choice row', () => {
    const cropRow = row('agroscope.crop.potato', 'attribute');
    const catalogWithCrop: JournalCatalog = {
      ...catalog,
      vocab: [...catalog.vocab, { ...cropRow, kind: 'choice', labels: { en: 'Potato' } }],
    };
    mockDetail({ entries: [entry({ season_crop: 'agroscope.crop.potato' })] });

    renderPanel({ catalogOverride: catalogWithCrop });

    expect(screen.getByText('workspace.detail.field.season_crop')).toBeInTheDocument();
    expect(screen.getByText('Potato')).toBeInTheDocument();
    expect(screen.queryByText('agroscope.crop.potato')).not.toBeInTheDocument();
  });

  // P2-b (Slice D hardening): a harvest/manual-close/reseed entry that
  // closed a crop cycle keeps its OWN season_crop NULL by design — the
  // detail view must fall back to the edge's closed_crop_code display
  // enrichment (osi-journal/lifecycle.js resolveClosedCropCycleOverrides) so
  // this entry still shows what was harvested/closed.
  it('falls back to closed_crop_code for a closing entry whose own season_crop is null', () => {
    mockDetail({ entries: [entry({
      activity_code: 'harvest', season_crop: null, closed_crop_code: 'agroscope.crop.wheat_winter',
    })] });

    renderPanel();

    expect(screen.getByText('workspace.detail.field.season_crop')).toBeInTheDocument();
    expect(screen.getByText('agroscope.crop.wheat_winter')).toBeInTheDocument();
  });

  it('shows no crop row for a non-closing entry with neither season_crop nor closed_crop_code', () => {
    mockDetail({ entries: [entry({ season_crop: null })] });

    renderPanel();

    expect(screen.queryByText('workspace.detail.field.season_crop')).not.toBeInTheDocument();
  });

  // BUG 2: attr.product_uuid's stored value_text is a per-farm product UUID
  // that is never a model.vocabByCode entry (products are a separate
  // registry, not catalog choices) -- it must resolve through catalog.products
  // the same way the capture confirm screen does (BUG 1), not print raw.
  it('resolves attr.product_uuid to the product name instead of the raw uuid', () => {
    const catalogWithProduct: JournalCatalog = {
      ...catalog,
      vocab: [...catalog.vocab, row('attr.product_uuid', 'attribute', 'text')],
      products: [{
        product_uuid: 'product-1',
        scope: 'farm',
        owner_user_uuid: 'owner',
        gateway_device_eui: 'gateway',
        name: 'Copper Fungicide',
        kind: 'plant_protection',
        active: 1,
        sync_version: 0,
        created_at: timestamp,
        deleted_at: null,
        catalog_errors: [],
      }],
    };
    mockDetail({ entries: [entry({
      values: [{
        group_index: 0,
        attribute_code: 'attr.product_uuid',
        value_status: 'observed',
        value_num: null,
        value_text: 'product-1',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }],
    })] });

    renderPanel({ catalogOverride: catalogWithProduct });

    expect(screen.getByText('Copper Fungicide')).toBeInTheDocument();
    expect(screen.queryByText('product-1')).not.toBeInTheDocument();
  });

  it('falls back to the unknown-product label when the product_uuid matches no catalog product', () => {
    const catalogWithoutProduct: JournalCatalog = {
      ...catalog,
      vocab: [...catalog.vocab, row('attr.product_uuid', 'attribute', 'text')],
    };
    mockDetail({ entries: [entry({
      values: [{
        group_index: 0,
        attribute_code: 'attr.product_uuid',
        value_status: 'observed',
        value_num: null,
        value_text: 'unknown-product-uuid',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }],
    })] });

    renderPanel({ catalogOverride: catalogWithoutProduct });

    expect(screen.getByText('capture.tankMix.unknownProduct')).toBeInTheDocument();
    expect(screen.queryByText('unknown-product-uuid')).not.toBeInTheDocument();
  });

  // NIT 9: an internal valve-expectation linkage id with no user-meaningful
  // label and no friendly resolver -- omit it from the values list entirely
  // rather than print its raw opaque id.
  it('omits attr.actuation_expectation_id from the recorded values list', () => {
    mockDetail({ entries: [entry({
      values: [
        {
          group_index: 0,
          attribute_code: 'attr.operator',
          value_status: 'observed',
          value_num: null,
          value_text: 'Alex',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
        {
          group_index: 0,
          attribute_code: 'attr.actuation_expectation_id',
          value_status: 'observed',
          value_num: null,
          value_text: 'valve-expectation-abc123',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
      ],
    })] });

    renderPanel();

    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.queryByText('valve-expectation-abc123')).not.toBeInTheDocument();
    expect(screen.queryByText('workspace.detail.values.empty')).not.toBeInTheDocument();
  });

  it('shows the empty-values state when the only recorded value is the omitted actuation_expectation_id', () => {
    mockDetail({ entries: [entry({
      values: [{
        group_index: 0,
        attribute_code: 'attr.actuation_expectation_id',
        value_status: 'observed',
        value_num: null,
        value_text: 'valve-expectation-abc123',
        unit_code: null,
        entered_value_num: null,
        entered_unit_code: null,
      }],
    })] });

    renderPanel();

    expect(screen.getByText('workspace.detail.values.empty')).toBeInTheDocument();
  });
});

describe('DetailPanel — correction and void are blocked for draft and voided entries', () => {
  it('offers no correct or void action for a draft entry', () => {
    mockDetail({ entries: [entry({ status: 'draft', sync_version: 0 })] });

    renderPanel();

    expect(screen.queryByRole('button', { name: 'workspace.detail.actions.correct' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'workspace.detail.actions.void' })).not.toBeInTheDocument();
    expect(screen.getByText('workspace.detail.locked.draft')).toBeInTheDocument();
  });

  it('offers no correct or void action for an already-voided entry', () => {
    mockDetail({ entries: [entry({
      status: 'voided',
      voided_at: timestamp,
      void_reason: 'Duplicate entry',
    })] });

    renderPanel();

    expect(screen.queryByRole('button', { name: 'workspace.detail.actions.correct' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'workspace.detail.actions.void' })).not.toBeInTheDocument();
    expect(screen.getByText('workspace.detail.locked.voided')).toBeInTheDocument();
    expect(screen.getByText('Duplicate entry')).toBeInTheDocument();
  });

  it('offers both actions for a final entry', () => {
    mockDetail({ entries: [entry()] });

    renderPanel();

    expect(screen.getByRole('button', { name: 'workspace.detail.actions.correct' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'workspace.detail.actions.void' })).toBeInTheDocument();
  });
});

describe('DetailPanel — void', () => {
  it('requires an explicit reason before it will submit', () => {
    mockDetail({ entries: [entry()] });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.void' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.void.submit' }));

    expect(mocks.voidEntry).not.toHaveBeenCalled();
  });

  it('voids the entry with the current sync_version and reason, then refreshes and returns focus', async () => {
    const retry = mockDetail({ entries: [entry({ sync_version: 4 })] });
    mocks.voidEntry.mockResolvedValue({ entry_uuid: 'entry-1', outbox_event_uuid: 'evt-1', sync_version: 5 });
    const { onFocusReturn } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.void' }));
    fireEvent.change(screen.getByLabelText('workspace.detail.void.reasonLabel'), {
      target: { value: 'Logged against the wrong plot' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.void.submit' }));

    await waitFor(() => expect(mocks.voidEntry).toHaveBeenCalledWith('entry-1', 'Logged against the wrong plot', 4, false));
    await waitFor(() => expect(retry).toHaveBeenCalled());
    await waitFor(() => expect(onFocusReturn).toHaveBeenCalled());
  });

  it('shows a stale-version message when the entry changed underneath during void, and keeps the form open', async () => {
    mockDetail({ entries: [entry()] });
    mocks.voidEntry.mockRejectedValue({ response: { status: 409 } });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.void' }));
    fireEvent.change(screen.getByLabelText('workspace.detail.void.reasonLabel'), {
      target: { value: 'Duplicate' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.void.submit' }));

    await waitFor(() => expect(screen.getByText('workspace.detail.void.stale')).toBeInTheDocument());
    expect(screen.getByLabelText('workspace.detail.void.reasonLabel')).toBeInTheDocument();
  });

  it('cancelling the void form returns focus without calling the API', () => {
    mockDetail({ entries: [entry()] });
    const { onFocusReturn } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.void' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.void.cancel' }));

    expect(mocks.voidEntry).not.toHaveBeenCalled();
    expect(onFocusReturn).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'workspace.detail.actions.void' })).toBeInTheDocument();
  });

  // Slice D Phase 3 (D13/R7): voiding a seeding whose crop cycle has
  // dependent entries is refused (cycle_has_dependents, 409) unless the
  // caller sets cascade_ack. See journal/cropCycle.ts's
  // cycleDependentsFromError and osi-journal/lifecycle.js
  // applyVoidCycleCascade.
  // P2-c: the confirmation must show a human label per dependent (activity
  // · plot · date), not the bare entry UUID the edge refusal carries — see
  // dependentEntryLabel in DetailPanel.tsx. The edge only ever sends UUIDs,
  // so the GUI resolves each one through the same single-entry lookup
  // DetailPanelForEntry itself already uses.
  it('shows the dependent entries from a cycle_has_dependents refusal, resolved to human labels, and requires explicit confirmation before retrying with cascade_ack', async () => {
    const retry = mockDetail({ entries: [entry({ sync_version: 2 })] });
    mocks.voidEntry
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            error: 'cycle_has_dependents',
            message: 'Voiding this seeding would orphan entries that inherit its crop cycle',
            details: { dependentEntryUuids: ['dep-1', 'dep-2'] },
          },
        },
      })
      .mockResolvedValueOnce({ entry_uuid: 'entry-1', outbox_event_uuid: 'evt-2', sync_version: 3 });
    const dependentsByUuid: Record<string, EntryAggregate> = {
      'dep-1': entry({
        entry_uuid: 'dep-1',
        activity_code: 'fertilization',
        occurred_start: '2026-07-18T08:00:00.000Z',
      }),
      'dep-2': entry({
        entry_uuid: 'dep-2',
        activity_code: 'irrigation',
        occurred_start: '2026-07-10T08:00:00.000Z',
      }),
    };
    mocks.listEntries.mockImplementation(async ({ entry_uuid }: { entry_uuid: string }) => {
      const found = dependentsByUuid[entry_uuid];
      return { entries: found ? [found] : [], next_cursor: null };
    });
    const catalogWithFertilization: JournalCatalog = {
      ...catalog,
      vocab: [...catalog.vocab, row('fertilization', 'activity')],
    };
    renderPanel({ catalogOverride: catalogWithFertilization });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.void' }));
    fireEvent.change(screen.getByLabelText('workspace.detail.void.reasonLabel'), {
      target: { value: 'Wrong crop entered' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.void.submit' }));

    await waitFor(() => expect(mocks.voidEntry).toHaveBeenNthCalledWith(1, 'entry-1', 'Wrong crop entered', 2, false));
    await waitFor(() => expect(screen.getByText('capture.cycle.voidDependentsTitle')).toBeInTheDocument());

    const dep1Date = formatOccurredDate('2026-07-18T08:00:00.000Z', 'Europe/Zurich', 'en');
    const dep2Date = formatOccurredDate('2026-07-10T08:00:00.000Z', 'Europe/Zurich', 'en');
    await waitFor(() => expect(screen.getByText(`fertilization · North field · ${dep1Date}`)).toBeInTheDocument());
    expect(screen.getByText(`Irrigation · North field · ${dep2Date}`)).toBeInTheDocument();
    expect(screen.queryByText('dep-1')).not.toBeInTheDocument();
    expect(screen.queryByText('dep-2')).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.voidDependentsConfirm' }));

    await waitFor(() => expect(mocks.voidEntry).toHaveBeenNthCalledWith(2, 'entry-1', 'Wrong crop entered', 2, true));
    await waitFor(() => expect(retry).toHaveBeenCalled());
  });

  it('falls back to the raw entry UUID for a dependent whose lookup fails, instead of hiding it', async () => {
    mockDetail({ entries: [entry({ sync_version: 2 })] });
    mocks.voidEntry.mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'cycle_has_dependents', details: { dependentEntryUuids: ['dep-unresolvable'] } },
      },
    });
    mocks.listEntries.mockRejectedValue(new Error('network down'));
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.void' }));
    fireEvent.change(screen.getByLabelText('workspace.detail.void.reasonLabel'), { target: { value: 'Testing' } });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.void.submit' }));

    await waitFor(() => expect(screen.getByText('dep-unresolvable')).toBeInTheDocument());
  });

  it('lets the operator cancel out of the dependents confirmation without voiding', async () => {
    mockDetail({ entries: [entry({ sync_version: 2 })] });
    mocks.voidEntry.mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'cycle_has_dependents', details: { dependentEntryUuids: ['dep-1'] } },
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.void' }));
    fireEvent.change(screen.getByLabelText('workspace.detail.void.reasonLabel'), { target: { value: 'Testing' } });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.void.submit' }));

    await waitFor(() => expect(screen.getByText('capture.cycle.voidDependentsTitle')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.voidDependentsCancel' }));

    expect(screen.queryByText('capture.cycle.voidDependentsTitle')).not.toBeInTheDocument();
    expect(mocks.voidEntry).toHaveBeenCalledTimes(1);
  });
});

describe('DetailPanel — full-record correction', () => {
  it('moves keyboard focus into the first correction field when correction is requested', async () => {
    mockDetail({ entries: [entry()] });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Operator' })).toHaveFocus());
  });

  it('changing one field preserves every untouched identity, context, occurrence, and value field (the central guarantee)', async () => {
    mockDetail({ entries: [entry({
      campaign_uuid: 'campaign-9',
      protocol_code: 'protocol-9',
      device_eui: 'device-9',
      season_crop: 'wheat',
      pass_uuid: 'pass-9',
      batch_uuid: 'batch-9',
      note: 'keep me',
      values: [
        {
          group_index: 0,
          attribute_code: 'attr.operator',
          value_status: 'observed',
          value_num: null,
          value_text: 'Alex',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
        {
          group_index: 0,
          attribute_code: 'attr.legacy',
          value_status: 'observed',
          value_num: null,
          value_text: 'legacy value',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
      ],
    })] });
    mocks.updateEntry.mockResolvedValue({ entry_uuid: 'entry-1', outbox_event_uuid: 'evt-1', sync_version: 3 });
    const { onFocusReturn } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Operator' }), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.correction.save' }));

    await waitFor(() => expect(mocks.updateEntry).toHaveBeenCalled());
    const [uuid, payload] = mocks.updateEntry.mock.calls[0];
    expect(uuid).toBe('entry-1');
    expect(payload.base_sync_version).toBe(2);
    expect(payload.status).toBe('final');
    expect(payload.campaign_uuid).toBe('campaign-9');
    expect(payload.protocol_code).toBe('protocol-9');
    expect(payload.device_eui).toBe('device-9');
    expect(payload.season_crop).toBe('wheat');
    expect(payload.pass_uuid).toBe('pass-9');
    expect(payload.batch_uuid).toBe('batch-9');
    expect(payload.note).toBe('keep me');
    expect(payload.occurred_timezone).toBe('Europe/Zurich');
    expect(payload.occurred_utc_offset_minutes).toBe(120);

    const operatorValue = payload.values.find((value: { attribute_code: string }) => value.attribute_code === 'attr.operator');
    expect(operatorValue.value).toBe('Sam');
    const legacyValue = payload.values.find((value: { attribute_code: string }) => value.attribute_code === 'attr.legacy');
    expect(legacyValue).toMatchObject({ value_text: 'legacy value', group_index: 0 });

    await waitFor(() => expect(onFocusReturn).toHaveBeenCalled());
  });

  it('shows a stale-version message when the entry changed underneath during correction, and keeps the form open', async () => {
    mockDetail({ entries: [entry()] });
    mocks.updateEntry.mockRejectedValue({ response: { status: 409 } });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.correction.save' }));

    await waitFor(() => expect(screen.getByText('workspace.detail.correction.stale')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Operator' })).toBeInTheDocument();
  });

  it('cancelling correction discards edits and returns focus without calling the API', () => {
    mockDetail({ entries: [entry()] });
    const { onFocusReturn } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Operator' }), { target: { value: 'Someone else' } });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.correction.cancel' }));

    expect(mocks.updateEntry).not.toHaveBeenCalled();
    expect(onFocusReturn).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'workspace.detail.actions.correct' })).toBeInTheDocument();
  });

  it('disables correction when the catalog no longer has the entry template or layout', () => {
    mockDetail({ entries: [entry({ template_code: 'retired_template' })] });
    renderPanel();

    expect(screen.getByRole('button', { name: 'workspace.detail.actions.correct' })).toBeDisabled();
  });

  it('re-emits the full original value set when correction is saved with no edits (a no-op correction must not wipe the record)', async () => {
    mockDetail({ entries: [entry()] });
    mocks.updateEntry.mockResolvedValue({ entry_uuid: 'entry-1', outbox_event_uuid: 'evt-1', sync_version: 3 });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.correction.save' }));

    await waitFor(() => expect(mocks.updateEntry).toHaveBeenCalled());
    const [, payload] = mocks.updateEntry.mock.calls[0];
    expect(payload.values).toHaveLength(1);
    const operatorValue = payload.values.find((value: { attribute_code: string }) => value.attribute_code === 'attr.operator');
    expect(operatorValue).toMatchObject({ value: 'Alex' });
  });

  it('preserves an owned-but-invisible attribute value through a correction (ownership must match emission)', async () => {
    const hiddenCatalog: JournalCatalog = {
      ...catalog,
      vocab: [
        ...catalog.vocab,
        row('attr.hidden', 'attribute', 'text'),
        row('attr.mode', 'attribute', 'text'),
      ],
      templates: [{
        ...catalog.templates[0],
        definition: {
          ...catalog.templates[0].definition,
          fields: [
            'attr.operator',
            { code: 'attr.hidden', visible_if: { field: 'attr.mode', op: 'eq', value: 'special' } },
          ],
        },
      }],
    };
    mockDetail({ entries: [entry({
      values: [
        {
          group_index: 0,
          attribute_code: 'attr.operator',
          value_status: 'observed',
          value_num: null,
          value_text: 'Alex',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
        {
          group_index: 0,
          attribute_code: 'attr.hidden',
          value_status: 'observed',
          value_num: null,
          value_text: 'secret',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
      ],
    })] });
    mocks.updateEntry.mockResolvedValue({ entry_uuid: 'entry-1', outbox_event_uuid: 'evt-1', sync_version: 3 });
    renderPanel({ catalogOverride: hiddenCatalog });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Operator' }), { target: { value: 'Sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.correction.save' }));

    await waitFor(() => expect(mocks.updateEntry).toHaveBeenCalled());
    const [, payload] = mocks.updateEntry.mock.calls[0];
    const hiddenValue = payload.values.find((value: { attribute_code: string }) => value.attribute_code === 'attr.hidden');
    expect(hiddenValue).toMatchObject({ value_text: 'secret' });
  });

  // M1 fix (2026-07-23): the note textarea is a top-level EntryForm field
  // (spec §0.4) but 'note' is never a journal_entry_values row -- it lives on
  // the entry's own `note` column, so the correction form must seed it from
  // aggregate.note and persist an edit back onto the payload explicitly
  // (buildCorrectionPayload's default is the UNEDITED aggregate.note).
  const notesCatalog: JournalCatalog = {
    ...catalog,
    templates: [{
      ...catalog.templates[0],
      definition: {
        ...catalog.templates[0].definition,
        sections: [{ code: 'notes', fields: ['note'] }],
      },
    }],
  };

  it('prefills the note textarea from the entry\'s stored note when correction is opened (M1)', () => {
    mockDetail({ entries: [entry({ note: 'irrigated the north row twice' })] });
    renderPanel({ catalogOverride: notesCatalog });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));

    expect(screen.getByLabelText('capture.form.note')).toHaveValue('irrigated the north row twice');
  });

  it('persists an edited note textarea value on correction save, and allows clearing it (M1)', async () => {
    mockDetail({ entries: [entry({ note: 'original note' })] });
    mocks.updateEntry.mockResolvedValue({ entry_uuid: 'entry-1', outbox_event_uuid: 'evt-1', sync_version: 3 });
    renderPanel({ catalogOverride: notesCatalog });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));
    fireEvent.change(screen.getByLabelText('capture.form.note'), { target: { value: 'updated note' } });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.correction.save' }));

    await waitFor(() => expect(mocks.updateEntry).toHaveBeenCalled());
    const [, updatedPayload] = mocks.updateEntry.mock.calls[0];
    expect(updatedPayload.note).toBe('updated note');
  });

  it('clears the stored note when the textarea is edited down to empty (M1)', async () => {
    mockDetail({ entries: [entry({ note: 'original note' })] });
    mocks.updateEntry.mockResolvedValue({ entry_uuid: 'entry-1', outbox_event_uuid: 'evt-1', sync_version: 3 });
    renderPanel({ catalogOverride: notesCatalog });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.correct' }));
    fireEvent.change(screen.getByLabelText('capture.form.note'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.correction.save' }));

    await waitFor(() => expect(mocks.updateEntry).toHaveBeenCalled());
    const [, clearedPayload] = mocks.updateEntry.mock.calls[0];
    expect(clearedPayload.note).toBeNull();
  });
});

// Copy-entry-and-polish plan (2026-07-23), §A: "copy this entry" -- a brand
// new final entry seeded from the source, never a mutation of it.
describe('DetailPanel — copy an entry', () => {
  it('offers Copy alongside Correct/Void for a final, non-cycle-activity entry', () => {
    mockDetail({ entries: [entry({ activity_code: 'irrigation' })] });
    renderPanel();

    expect(screen.getByRole('button', { name: 'workspace.detail.actions.copy' })).toBeInTheDocument();
  });

  it.each(['seeding', 'planting_transplanting', 'harvest'])(
    'hides Copy entirely for a %s entry (crop-cycle cascade activities are out of scope)',
    (activityCode) => {
      mockDetail({ entries: [entry({ activity_code: activityCode })] });
      renderPanel();

      expect(screen.queryByRole('button', { name: 'workspace.detail.actions.copy' })).not.toBeInTheDocument();
      // Correct/Void are unaffected by the copy-specific scope gate.
      expect(screen.getByRole('button', { name: 'workspace.detail.actions.correct' })).toBeInTheDocument();
    },
  );

  it('offers no Copy action for a draft or voided entry (final-only safety gate)', () => {
    mockDetail({ entries: [entry({ status: 'draft', sync_version: 0 })] });
    renderPanel();
    expect(screen.queryByRole('button', { name: 'workspace.detail.actions.copy' })).not.toBeInTheDocument();

    mockDetail({ entries: [entry({ status: 'voided', voided_at: timestamp })] });
    renderPanel();
    expect(screen.queryByRole('button', { name: 'workspace.detail.actions.copy' })).not.toBeInTheDocument();
  });

  it('disables Copy when the catalog no longer has the entry template or layout', () => {
    mockDetail({ entries: [entry({ template_code: 'retired_template' })] });
    renderPanel();

    expect(screen.getByRole('button', { name: 'workspace.detail.actions.copy' })).toBeDisabled();
  });

  it('saves via createEntry (never updateEntry/voidEntry) with a fresh entry_uuid, no batch/pass/cycle fields, and drops attr.actuation_expectation_id', async () => {
    const sourceEntry = entry({
      activity_code: 'irrigation',
      batch_uuid: 'batch-9',
      pass_uuid: 'pass-9',
      sync_version: 5,
      values: [
        {
          group_index: 0,
          attribute_code: 'attr.operator',
          value_status: 'observed',
          value_num: null,
          value_text: 'Alex',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
        {
          group_index: 0,
          attribute_code: 'attr.actuation_expectation_id',
          value_status: 'observed',
          value_num: null,
          value_text: 'valve-expectation-abc123',
          unit_code: null,
          entered_value_num: null,
          entered_unit_code: null,
        },
      ],
    });
    mockDetail({ entries: [sourceEntry] });
    mocks.createEntry.mockResolvedValue({ entry_uuid: 'new-entry-1', outbox_event_uuid: 'evt-1', sync_version: 1 });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.save' }));

    await waitFor(() => expect(mocks.createEntry).toHaveBeenCalled());
    const [payload] = mocks.createEntry.mock.calls[0];

    // Never-mutate-source (A6): a fresh uuid, never the source's, and the
    // source is never addressed through any mutating call at all.
    expect(payload.entry_uuid).toBeDefined();
    expect(payload.entry_uuid).not.toBe(sourceEntry.entry_uuid);
    expect(payload.base_sync_version).toBe(0);
    expect(payload.status).toBe('final');
    expect(mocks.updateEntry).not.toHaveBeenCalled();
    expect(mocks.voidEntry).not.toHaveBeenCalled();
    expect(mocks.discardDraft).not.toHaveBeenCalled();

    // No batch/pass/cycle-lifecycle fields at all.
    expect(payload).not.toHaveProperty('batch_uuid');
    expect(payload).not.toHaveProperty('pass_uuid');
    expect(payload).not.toHaveProperty('cycle_action');
    expect(payload).not.toHaveProperty('cycle_uuid');
    expect(payload).not.toHaveProperty('ends_crop_cycle');

    // The internal valve-linkage id is dropped from the copied values.
    expect(payload.values.some((value: { attribute_code: string }) =>
      value.attribute_code === 'attr.actuation_expectation_id')).toBe(false);
    expect(payload.values.some((value: { attribute_code: string }) =>
      value.attribute_code === 'attr.operator')).toBe(true);
  });

  it('uses the CURRENT catalog template/layout versions and the plot\'s CURRENT zone, not the source\'s stale ones', async () => {
    mockDetail({ entries: [entry({
      template_version: 9,
      layout_version: 9,
      zone_uuid: 'zone-old',
    })] });
    mocks.createEntry.mockResolvedValue({ entry_uuid: 'new-entry-1', outbox_event_uuid: 'evt-1', sync_version: 1 });
    renderPanel({ plots: [plot({ zone_uuid: 'zone-current' })] });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.save' }));

    await waitFor(() => expect(mocks.createEntry).toHaveBeenCalled());
    const [payload] = mocks.createEntry.mock.calls[0];

    // catalog's own template/layout row is version 1 in this fixture -- the
    // CURRENT version, not the source's stale stored 9.
    expect(payload.template_version).toBe(1);
    expect(payload.layout_version).toBe(1);
    expect(payload.zone_uuid).toBe('zone-current');
    expect(payload.zone_uuid).not.toBe('zone-old');
  });

  it('re-derives season_crop from the plot\'s open crop cycle as of the edited date, never the source\'s stale value', async () => {
    mockDetail({ entries: [entry({ season_crop: 'wheat', season_variety: 'winter' })] });
    mocks.createEntry.mockResolvedValue({ entry_uuid: 'new-entry-1', outbox_event_uuid: 'evt-1', sync_version: 1 });
    renderPanel({ plots: [plot({
      active_crop_cycles: [{
        cycle_uuid: 'cycle-1',
        crop_code: 'agroscope.crop.potato',
        variety: 'Charlotte',
        seeded_on: '2026-05-01',
        opened_by_entry_uuid: 'seed-entry-1',
      }],
    })] });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.change(screen.getByLabelText('workspace.detail.copy.occurredLabel'), {
      target: { value: '2026-08-01T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.save' }));

    await waitFor(() => expect(mocks.createEntry).toHaveBeenCalled());
    const [payload] = mocks.createEntry.mock.calls[0];

    expect(payload.season_crop).toBe('agroscope.crop.potato');
    expect(payload.season_crop).not.toBe('wheat');
    expect(payload.season_variety).toBe('Charlotte');
  });

  it('falls back to a null season_crop when nothing is growing on the plot, rather than carrying the source\'s value', async () => {
    mockDetail({ entries: [entry({ season_crop: 'wheat' })] });
    mocks.createEntry.mockResolvedValue({ entry_uuid: 'new-entry-1', outbox_event_uuid: 'evt-1', sync_version: 1 });
    renderPanel({ plots: [plot({ active_crop_cycles: [] })] });

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.save' }));

    await waitFor(() => expect(mocks.createEntry).toHaveBeenCalled());
    const [payload] = mocks.createEntry.mock.calls[0];
    expect(payload.season_crop).toBeNull();
  });

  it('persists an edited occurred date/time on the new entry', async () => {
    mockDetail({ entries: [entry({ occurred_timezone: 'Europe/Zurich' })] });
    mocks.createEntry.mockResolvedValue({ entry_uuid: 'new-entry-1', outbox_event_uuid: 'evt-1', sync_version: 1 });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.change(screen.getByLabelText('workspace.detail.copy.occurredLabel'), {
      target: { value: '2026-08-01T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.save' }));

    await waitFor(() => expect(mocks.createEntry).toHaveBeenCalled());
    const [payload] = mocks.createEntry.mock.calls[0];
    expect(payload.occurred_start_local).toBe('2026-08-01T10:00');
    expect(payload.occurred_end_local).toBeNull();
    // Europe/Zurich is on summer time (+120) in August, same convention the
    // source used -- resolved fresh against the NEW date, not reused from
    // the source's stored offset.
    expect(payload.occurred_utc_offset_minutes).toBe(120);
  });

  it('closes the copy form and refreshes/returns focus after a successful save', async () => {
    const retry = mockDetail({ entries: [entry()] });
    mocks.createEntry.mockResolvedValue({ entry_uuid: 'new-entry-1', outbox_event_uuid: 'evt-1', sync_version: 1 });
    const { onFocusReturn } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.save' }));

    await waitFor(() => expect(retry).toHaveBeenCalled());
    await waitFor(() => expect(onFocusReturn).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'workspace.detail.actions.copy' })).toBeInTheDocument();
  });

  it('cancelling the copy form discards it and returns focus without calling the API', () => {
    mockDetail({ entries: [entry()] });
    const { onFocusReturn } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.cancel' }));

    expect(mocks.createEntry).not.toHaveBeenCalled();
    expect(onFocusReturn).toHaveBeenCalled();
  });

  // A2: the edge's duplicate-guard 409 on create -- surface the candidate and
  // retry with duplicate_guard_ack_entry_uuid on explicit "save separately".
  it('shows a duplicate-candidate confirmation on a 409 and retries with the acknowledgement on "save separately"', async () => {
    mockDetail({ entries: [entry()] });
    mocks.createEntry
      .mockRejectedValueOnce({
        response: {
          status: 409,
          data: {
            error: 'duplicate_candidate',
            details: { duplicateCandidate: { entryUuid: 'dup-entry-1' } },
          },
        },
      })
      .mockResolvedValueOnce({ entry_uuid: 'new-entry-1', outbox_event_uuid: 'evt-1', sync_version: 1 });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.save' }));

    await waitFor(() => expect(screen.getByText('workspace.detail.copy.duplicateTitle')).toBeInTheDocument());
    expect(mocks.createEntry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.saveSeparately' }));

    await waitFor(() => expect(mocks.createEntry).toHaveBeenCalledTimes(2));
    const [retryPayload] = mocks.createEntry.mock.calls[1];
    expect(retryPayload.duplicate_guard_ack_entry_uuid).toBe('dup-entry-1');
  });

  it('shows a generic error (not the duplicate confirmation) for a non-duplicate save failure, and keeps the form open', async () => {
    mockDetail({ entries: [entry()] });
    mocks.createEntry.mockRejectedValue(new Error('network down'));
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.copy.save' }));

    await waitFor(() => expect(screen.getByText('workspace.detail.copy.error')).toBeInTheDocument());
    expect(screen.queryByText('workspace.detail.copy.duplicateTitle')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'workspace.detail.copy.save' })).toBeInTheDocument();
  });
});
