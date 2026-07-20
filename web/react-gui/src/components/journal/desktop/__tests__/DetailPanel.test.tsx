import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { EntryAggregate, JournalCatalog, JournalPlot } from '../../../../types/journal';

const mocks = vi.hoisted(() => ({
  useJournalEntries: vi.fn(),
  updateEntry: vi.fn(),
  voidEntry: vi.fn(),
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
    updateEntry: mocks.updateEntry,
    voidEntry: mocks.voidEntry,
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
  mocks.updateEntry.mockReset();
  mocks.voidEntry.mockReset();
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
  it('shows the dependent entries from a cycle_has_dependents refusal and requires explicit confirmation before retrying with cascade_ack', async () => {
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
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.actions.void' }));
    fireEvent.change(screen.getByLabelText('workspace.detail.void.reasonLabel'), {
      target: { value: 'Wrong crop entered' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.detail.void.submit' }));

    await waitFor(() => expect(mocks.voidEntry).toHaveBeenNthCalledWith(1, 'entry-1', 'Wrong crop entered', 2, false));
    await waitFor(() => expect(screen.getByText('capture.cycle.voidDependentsTitle')).toBeInTheDocument());
    expect(screen.getByText('dep-1')).toBeInTheDocument();
    expect(screen.getByText('dep-2')).toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'capture.cycle.voidDependentsConfirm' }));

    await waitFor(() => expect(mocks.voidEntry).toHaveBeenNthCalledWith(2, 'entry-1', 'Wrong crop entered', 2, true));
    await waitFor(() => expect(retry).toHaveBeenCalled());
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
});
