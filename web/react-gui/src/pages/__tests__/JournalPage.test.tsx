import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useJournalCatalog: vi.fn(),
  useJournalEntries: vi.fn(),
  useJournalPlots: vi.fn(),
  useSWR: vi.fn(),
  getZones: vi.fn(),
  journalApi: {
    listEntries: vi.fn(),
    createEntry: vi.fn(),
    updateEntry: vi.fn(),
  },
  captureFlow: vi.fn(),
  useRealCaptureFlow: false,
  timeline: vi.fn(),
  retryCatalog: vi.fn(),
  retryEntries: vi.fn(),
  retryPlots: vi.fn(),
  retryZones: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key === 'capture.save.finalSavedGateway' ? 'Saved on farm gateway' : key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
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
vi.mock('swr', () => ({
  default: mocks.useSWR,
}));
vi.mock('../../services/api', () => ({
  irrigationZonesAPI: { getAll: mocks.getZones },
  environmentAPI: { getSummary: vi.fn() },
  dendroAnalyticsAPI: { getZoneRecommendations: vi.fn() },
}));
vi.mock('../../services/journalApi', () => ({
  journalApi: mocks.journalApi,
}));
vi.mock('../../components/journal/JournalTimeline', () => ({
  JournalTimeline: (props: unknown) => {
    mocks.timeline(props);
    return <div data-testid="timeline" />;
  },
}));
vi.mock('../../components/journal/capture/JournalCaptureFlow', async () => {
  const actual = await vi.importActual<typeof import('../../components/journal/capture/JournalCaptureFlow')>(
    '../../components/journal/capture/JournalCaptureFlow',
  );
  return {
    JournalCaptureFlow: (props: {
      onClose: () => void;
      onOpenExisting: (entryUuid: string) => void;
      onSaved: (receipt: unknown) => void | Promise<void>;
    }) => {
      mocks.captureFlow(props);
      if (mocks.useRealCaptureFlow) {
        return React.createElement(actual.JournalCaptureFlow, props as never);
      }
      return (
        <div data-testid="capture-flow">
          <button type="button" onClick={props.onClose}>mock-close</button>
          <button
            type="button"
            onClick={() => props.onOpenExisting('existing-entry-uuid')}
          >
            mock-open-existing
          </button>
        </div>
      );
    },
  };
});

import { JournalPage } from '../JournalPage';
import { IrrigationZoneCard } from '../../components/farming/IrrigationZoneCard';
import type { EntryAggregate, JournalCatalog, JournalPlot } from '../../types/journal';
import type { IrrigationZone } from '../../types/farming';

const captureCatalog: JournalCatalog = {
  catalog_version: 7,
  catalog_hash: 'catalog-hash',
  vocab: [{
    code: 'irrigation',
    kind: 'activity',
    parent_code: null,
    value_type: null,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: 'water',
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 1,
    sync_version: 0,
    created_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: 'Irrigation' },
    constraints: null,
  }, {
    code: 'attr.crop',
    kind: 'attribute',
    parent_code: null,
    value_type: 'choice',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 2,
    sync_version: 0,
    created_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: 'Crop' },
    constraints: {},
  }, {
    code: 'agroscope.crop.barley_winter',
    kind: 'choice',
    parent_code: 'attr.crop',
    value_type: null,
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 3,
    sync_version: 0,
    created_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: 'barley, winter' },
    constraints: {},
  }, {
    code: 'attr.method',
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 4,
    sync_version: 0,
    created_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: 'Method' },
    constraints: { maxlength: 300 },
  }, {
    code: 'attr.operator',
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 5,
    sync_version: 0,
    created_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: 'Operator' },
    constraints: { maxlength: 160 },
  }, {
    code: 'attr.equipment',
    kind: 'attribute',
    parent_code: null,
    value_type: 'text',
    quantity_kind: null,
    basis: null,
    default_unit_code: null,
    icon_key: null,
    scope: 'core',
    owner_user_uuid: null,
    gateway_device_eui: null,
    custom_field_uuid: null,
    active: 1,
    sort_order: 6,
    sync_version: 0,
    created_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: 'Equipment' },
    constraints: { maxlength: 300 },
  }],
  templates: ['farmer_quick', 'full_record', 'research_observation'].map((code, index) => ({
    code,
    version: index + 1,
    active: 1,
    catalog_errors: [],
    labels: { en: code },
    definition: {
      fields: ['attr.crop', 'attr.method'],
      sections: [],
      carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
      require_explicit_choices: false,
      show_standard_mappings: false,
      activity_requirements: {},
      conditional_groups: [],
      requirements: { required: [], optional: [], required_any: [] },
    },
  })),
  layouts: [{
    code: 'greenhouse',
    version: 6,
    active: 1,
    catalog_errors: [],
    labels: { en: 'Greenhouse' },
    definition: {
      activity_codes: ['irrigation'],
      supported_templates: ['farmer_quick', 'full_record', 'research_observation'],
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

const catalog = {
  vocab: [{ code: 'irrigation', kind: 'activity', active: 1 }],
};
const entries = [{ entry_uuid: 'e1' }];
const plots: JournalPlot[] = [{
  plot_uuid: 'p1',
  plot_code: 'N-1',
  name: 'North field',
  zone_uuid: 'zone-1',
  crop_hint: 'Wheat',
  settings: { layout_code: 'greenhouse' },
} as JournalPlot];
const zones = [{
  id: 1,
  name: 'North zone',
  device_count: 1,
  created_at: '2026-07-16T00:00:00.000Z',
  updated_at: '2026-07-16T00:00:00.000Z',
  schedule: null,
  zone_uuid: 'zone-1',
  timezone: 'Europe/Zurich',
  crop_type: 'Barley',
}];

const carryForwardSource: EntryAggregate = {
  contract_version: 1,
  entry_uuid: '22222222-2222-4222-8222-222222222222',
  owner_user_uuid: 'owner',
  author_principal_uuid: 'author',
  author_label: null,
  gateway_device_eui: 'gateway',
  plot_uuid: 'p1',
  zone_uuid: 'zone-1',
  device_eui: null,
  season_uuid: 'season-1',
  season_crop: 'barley, winter',
  season_variety: null,
  campaign_uuid: null,
  protocol_code: null,
  protocol_version: null,
  observation_unit_code: null,
  activity_code: 'irrigation',
  template_code: 'farmer_quick',
  template_version: 1,
  layout_code: 'greenhouse',
  layout_version: 6,
  catalog_version: 7,
  occurred_start: '2026-07-15T00:00:00.000Z',
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
  sync_version: 1,
  recorded_at: '2026-07-15T00:00:00.000Z',
  created_at: '2026-07-15T00:00:00.000Z',
  updated_at: '2026-07-15T00:00:00.000Z',
  deleted_at: null,
  values: [{
    group_index: 0,
    attribute_code: 'attr.crop',
    value_status: 'observed',
    value_num: null,
    value_text: 'agroscope.crop.barley_winter',
    unit_code: null,
    entered_value_num: null,
    entered_unit_code: null,
  }, {
    group_index: 0,
    attribute_code: 'attr.method',
    value_status: 'observed',
    value_num: null,
    value_text: 'Drip irrigation',
    unit_code: null,
    entered_value_num: null,
    entered_unit_code: null,
  }],
};

function renderPage(initialEntry = '/journal') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/journal" element={<JournalPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function SearchProbe() {
  const [params] = useSearchParams();
  return <output data-testid="search-params">{params.toString()}</output>;
}

function ClearCaptureQuery() {
  const [, setParams] = useSearchParams();
  return <button type="button" onClick={() => setParams({})}>plain-journal-route</button>;
}

describe('JournalPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useRealCaptureFlow = false;
    mocks.getZones.mockResolvedValue(zones);
    mocks.useSWR.mockReturnValue({
      data: zones,
      error: undefined,
      isLoading: false,
      mutate: mocks.retryZones,
    });
    mocks.journalApi.listEntries.mockResolvedValue({ entries: [], next_cursor: null });
    mocks.journalApi.createEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 0,
    });
    mocks.journalApi.updateEntry.mockResolvedValue({
      entry_uuid: '11111111-1111-4111-8111-111111111111',
      sync_version: 1,
      outbox_event_uuid: 'outbox-1',
    });
    mocks.useJournalCatalog.mockReturnValue({
      catalog,
      available: true,
      unavailable: false,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });
    mocks.useJournalEntries.mockReturnValue({
      entries,
      loading: false,
      error: undefined,
      retry: mocks.retryEntries,
    });
    mocks.useJournalPlots.mockReturnValue({
      plots,
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
    });
  });

  it('keeps reads disabled while the catalog probe is loading', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined,
      available: false,
      unavailable: false,
      loading: true,
      error: undefined,
      retry: mocks.retryCatalog,
    });

    renderPage();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByText('timeline.loading')).toBeInTheDocument();
    expect(mocks.useJournalEntries).toHaveBeenCalledWith(expect.anything(), false);
    expect(mocks.useJournalPlots).toHaveBeenCalledWith(false);
  });

  it('renders capability absence only for unavailable gateways', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined,
      available: false,
      unavailable: true,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });

    renderPage();

    expect(screen.getByText('unavailable.title')).toBeInTheDocument();
    expect(screen.queryByText('error.title')).not.toBeInTheDocument();
  });

  it('renders and retries a catalog operational error', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined,
      available: false,
      unavailable: false,
      loading: false,
      error: new Error('offline'),
      retry: mocks.retryCatalog,
    });

    renderPage();

    expect(screen.getByText('error.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));
    expect(mocks.retryCatalog).toHaveBeenCalledOnce();
  });

  it.each([
    ['entry', 'useJournalEntries'],
    ['plot', 'useJournalPlots'],
  ])('does not turn a failed %s read into the empty state', (_kind, hookName) => {
    if (hookName === 'useJournalEntries') {
      mocks.useJournalEntries.mockReturnValue({
        entries: [],
        loading: false,
        error: new Error('offline'),
        retry: mocks.retryEntries,
      });
    } else {
      mocks.useJournalPlots.mockReturnValue({
        plots: [],
        loading: false,
        error: new Error('offline'),
        retry: mocks.retryPlots,
      });
    }

    renderPage();

    expect(screen.getByText('error.title')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));
    expect(mocks.retryEntries).toHaveBeenCalledOnce();
    expect(mocks.retryPlots).toHaveBeenCalledOnce();
  });

  it('renders reads and applies final-only plot and activity filters', async () => {
    renderPage();

    const logActivity = screen.getByRole('button', { name: 'logActivity' });
    expect(logActivity).toHaveClass('btn-liquid');
    expect(mocks.timeline).toHaveBeenCalledWith(expect.objectContaining({ entries, plots }));

    fireEvent.change(screen.getByLabelText('filters.plot'), {
      target: { value: 'p1' },
    });
    fireEvent.change(screen.getByLabelText('filters.activity'), {
      target: { value: 'irrigation' },
    });

    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      {
        status: 'final',
        limit: 50,
        plot_uuid: 'p1',
        activity_code: 'irrigation',
      },
      true,
    ));
  });

  it('opens a generic capture flow from Log activity', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));

    expect(screen.getByTestId('capture-flow')).toBeInTheDocument();
    expect(mocks.captureFlow).toHaveBeenLastCalledWith(expect.objectContaining({
      initialPlot: undefined,
      initialTimezone: undefined,
    }));
  });

  it('opens a known query zone without exposing its identifier and preserves plot crop context', async () => {
    renderPage('/journal?capture=1&zone_uuid=zone-1');

    await waitFor(() => expect(mocks.captureFlow).toHaveBeenCalled());
    const props = mocks.captureFlow.mock.lastCall?.[0];
    expect(props.initialPlot).toEqual(expect.objectContaining({
      plot_uuid: 'p1',
      crop_hint: 'Barley',
    }));
    expect(props.initialPlot).not.toBe(plots[0]);
    expect(props.initialTimezone).toBe('Europe/Zurich');
    expect(props.zoneTimezones).toEqual({ 'zone-1': 'Europe/Zurich' });
    expect(screen.queryByText('zone-1')).not.toBeInTheDocument();
  });

  it('enriches every plot copy with its linked zone crop without mutating hook data', async () => {
    const secondPlot = {
      ...plots[0],
      plot_uuid: 'p2',
      plot_code: 'S-1',
      name: 'South field',
      zone_uuid: 'zone-2',
      crop_hint: null,
    };
    const secondZone = { ...zones[0], zone_uuid: 'zone-2', crop_type: 'Corn', timezone: 'America/Chicago' };
    mocks.useJournalPlots.mockReturnValue({
      plots: [plots[0], secondPlot],
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
    });
    mocks.useSWR.mockReturnValue({
      data: [zones[0], secondZone],
      error: undefined,
      isLoading: false,
      mutate: mocks.retryZones,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));

    await waitFor(() => expect(mocks.captureFlow).toHaveBeenCalled());
    const captureProps = mocks.captureFlow.mock.lastCall?.[0];
    expect(captureProps.plots).toEqual(expect.arrayContaining([
      expect.objectContaining({ plot_uuid: 'p1', crop_hint: 'Barley' }),
      expect.objectContaining({ plot_uuid: 'p2', crop_hint: 'Corn' }),
    ]));
    expect(captureProps.plots[1]).not.toBe(secondPlot);
    expect(secondPlot.crop_hint).toBeNull();
  });

  it('uses the typed irrigation-zone API fetcher for capture enrichment', async () => {
    renderPage();

    const zoneFetcher = mocks.useSWR.mock.calls.find(
      ([key]) => key === 'journal:irrigation-zones',
    )?.[1] as (() => Promise<unknown>) | undefined;
    expect(zoneFetcher).toBeTypeOf('function');
    await expect(zoneFetcher?.()).resolves.toEqual(zones);
    expect(mocks.getZones).toHaveBeenCalledOnce();
  });

  it('uses the authoritative linked zone crop over a stale plot crop hint', async () => {
    mocks.useJournalPlots.mockReturnValue({
      plots: [{ ...plots[0], crop_hint: null }],
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
    });

    renderPage('/journal?capture=1&zone_uuid=zone-1');

    await waitFor(() => expect(mocks.captureFlow).toHaveBeenCalled());
    const props = mocks.captureFlow.mock.lastCall?.[0];
    expect(props.initialPlot).toEqual(expect.objectContaining({ crop_hint: 'Barley' }));
    expect(plots[0].crop_hint).toBe('Wheat');
  });

  it('uses the browser fallback when a known zone has no timezone', async () => {
    mocks.useSWR.mockReturnValue({
      data: [{ ...zones[0], timezone: null }],
      error: undefined,
      isLoading: false,
      mutate: mocks.retryZones,
    });

    renderPage('/journal?capture=1&zone_uuid=zone-1');

    await waitFor(() => expect(mocks.captureFlow).toHaveBeenCalled());
    expect(mocks.captureFlow.mock.lastCall?.[0].initialTimezone).toBeUndefined();
  });

  it('falls back to generic Where for an unknown zone query', async () => {
    renderPage('/journal?capture=1&zone_uuid=missing-zone');

    await waitFor(() => expect(mocks.captureFlow).toHaveBeenCalled());
    expect(mocks.captureFlow.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      initialPlot: undefined,
      initialTimezone: undefined,
    }));
  });

  it('keeps the timeline usable outside capture when zone enrichment fails', () => {
    mocks.useSWR.mockReturnValue({
      data: undefined,
      error: new Error('zones offline'),
      isLoading: false,
      mutate: mocks.retryZones,
    });

    renderPage();

    expect(screen.getByTestId('timeline')).toBeInTheDocument();
    expect(screen.queryByText('error.title')).not.toBeInTheDocument();
  });

  it('blocks query and local capture on zone enrichment failure with a separate retry', () => {
    mocks.useSWR.mockReturnValue({
      data: undefined,
      error: new Error('zones offline'),
      isLoading: false,
      mutate: mocks.retryZones,
    });

    renderPage('/journal?capture=1&zone_uuid=zone-1');

    expect(screen.getByText('error.title')).toBeInTheDocument();
    expect(screen.queryByTestId('capture-flow')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));
    expect(mocks.retryZones).toHaveBeenCalledOnce();
    expect(mocks.retryEntries).not.toHaveBeenCalled();
    expect(mocks.retryPlots).not.toHaveBeenCalled();
  });

  it('blocks local capture until zone enrichment succeeds', () => {
    mocks.useSWR.mockReturnValue({
      data: undefined,
      error: new Error('zones offline'),
      isLoading: false,
      mutate: mocks.retryZones,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));

    expect(screen.getByText('error.title')).toBeInTheDocument();
    expect(screen.queryByTestId('capture-flow')).not.toBeInTheDocument();
  });

  it('clears capture query and local capture state on close', async () => {
    render(
      <MemoryRouter initialEntries={['/journal?capture=1&zone_uuid=zone-1']}>
        <Routes>
          <Route path="/journal" element={<><JournalPage /><SearchProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('capture-flow')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'mock-close' }));

    await waitFor(() => expect(screen.queryByTestId('capture-flow')).not.toBeInTheDocument());
    expect(screen.getByTestId('search-params')).toHaveTextContent('');
  });

  it('closes local capture when same-route navigation removes the capture query', async () => {
    render(
      <MemoryRouter initialEntries={['/journal?capture=1']}>
        <Routes>
          <Route path="/journal" element={<><ClearCaptureQuery /><JournalPage /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('capture-flow')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'plain-journal-route' }));

    await waitFor(() => expect(screen.queryByTestId('capture-flow')).not.toBeInTheDocument());
    expect(screen.getByTestId('timeline')).toBeInTheDocument();
  });

  it('restores keyboard focus to Log activity after capture closes', async () => {
    renderPage();
    const trigger = screen.getByRole('button', { name: 'logActivity' });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('capture-flow')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'mock-close' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'logActivity' })).toHaveFocus());
  });

  it('closes capture and opens an existing entry as an exact final timeline filter', async () => {
    render(
      <MemoryRouter initialEntries={['/journal?capture=1&zone_uuid=zone-1']}>
        <Routes>
          <Route path="/journal" element={<><JournalPage /><SearchProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('capture-flow')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'mock-open-existing' }));

    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      {
        status: 'final',
        limit: 50,
        entry_uuid: 'existing-entry-uuid',
      },
      true,
    ));
    expect(screen.queryByTestId('capture-flow')).not.toBeInTheDocument();
    expect(screen.getByTestId('search-params')).toHaveTextContent('');
    expect(screen.queryByText('existing-entry-uuid')).not.toBeInTheDocument();
  });

  it('clears the exact entry when opening a new capture or changing normal filters', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));
    await waitFor(() => expect(screen.getByTestId('capture-flow')).toBeInTheDocument());
    await act(async () => {
      const onOpenExisting = mocks.captureFlow.mock.lastCall?.[0].onOpenExisting as
        ((entryUuid: string) => void);
      onOpenExisting('existing-entry-uuid');
    });
    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      expect.objectContaining({ entry_uuid: 'existing-entry-uuid' }),
      true,
    ));

    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));
    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      { status: 'final', limit: 50 },
      true,
    ));
    expect(screen.getByTestId('capture-flow')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mock-close' }));
    await waitFor(() => expect(screen.queryByTestId('capture-flow')).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('filters.plot'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('filters.activity'), { target: { value: 'irrigation' } });
    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      {
        status: 'final',
        limit: 50,
        plot_uuid: 'p1',
        activity_code: 'irrigation',
      },
      true,
    ));
  });

  it('awaits final timeline revalidation from onSaved', async () => {
    let resolveRetry: (() => void) | undefined;
    mocks.retryEntries.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveRetry = resolve;
    }));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));

    let onSaved: ((receipt: unknown) => Promise<void>) | undefined;
    let saved: Promise<void> | undefined;
    await waitFor(() => {
      expect(mocks.captureFlow).toHaveBeenCalled();
      onSaved = mocks.captureFlow.mock.lastCall?.[0].onSaved as (receipt: unknown) => Promise<void>;
      saved = onSaved?.({ entry_uuid: 'entry-1', sync_version: 1, outbox_event_uuid: 'outbox-1' });
      expect(mocks.retryEntries).toHaveBeenCalledOnce();
    });
    expect(saved).toBeDefined();
    let settled = false;
    void saved?.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveRetry?.();
    await expect(saved).resolves.toBeUndefined();
  });

  it('completes a safely prefilled zone capture in at most five primary activations', async () => {
    mocks.useRealCaptureFlow = true;
    mocks.useJournalCatalog.mockReturnValue({
      catalog: captureCatalog,
      available: true,
      unavailable: false,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    let primaryActivations = 0;
    mocks.useJournalEntries.mockReturnValue({
      entries: [carryForwardSource],
      loading: false,
      error: undefined,
      retry: mocks.retryEntries,
    });
    mocks.journalApi.listEntries.mockImplementation(async (filters: { entry_uuid?: string; occurred_from?: string }) => {
      if (filters.entry_uuid) {
        return {
          entries: [{
            ...carryForwardSource,
            entry_uuid: '11111111-1111-4111-8111-111111111111',
            status: 'draft',
            values: [],
          }],
          next_cursor: null,
        };
      }
      if (filters.occurred_from) return { entries: [], next_cursor: null };
      return { entries: [carryForwardSource], next_cursor: null };
    });

    const slaZones = [{ ...zones[0], crop_type: 'barley, winter' }];
    mocks.useSWR.mockReturnValue({
      data: slaZones,
      error: undefined,
      isLoading: false,
      mutate: mocks.retryZones,
    });

    const cardZone = {
      id: 1,
      name: 'North zone',
      device_count: 1,
      created_at: '2026-07-16T00:00:00.000Z',
      updated_at: '2026-07-16T00:00:00.000Z',
      schedule: null,
      zone_uuid: 'zone-1',
      crop_type: 'barley, winter',
    } as IrrigationZone;

    render(
      <MemoryRouter initialEntries={['/journal']}>
        <IrrigationZoneCard
          zone={cardZone}
          devices={[]}
          unassignedDevices={[]}
          onUpdate={vi.fn()}
        />
        <Routes>
          <Route path="/journal" element={<JournalPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const zoneCta = screen.getByRole('link', { name: 'addMenu.activity' });
    expect(zoneCta.style.minHeight).toBe('56px');
    expect(getComputedStyle(zoneCta).minHeight).toBe('56px');
    expect(zoneCta.parentElement).toHaveClass('flex', 'flex-wrap');
    expect(zoneCta.parentElement).not.toHaveClass('flex-nowrap', 'overflow-x-auto');
    fireEvent.click(zoneCta);
    primaryActivations += 1;
    await screen.findByRole('heading', { name: 'capture.title' });
    fireEvent.click(screen.getByRole('button', { name: 'Irrigation' }));
    primaryActivations += 1;
    const captureNavigation = screen.getByRole('button', { name: 'capture.next' }).parentElement;
    expect(captureNavigation).toHaveClass('flex', 'flex-wrap');
    expect(captureNavigation).not.toHaveClass('flex-nowrap', 'overflow-x-auto');
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    primaryActivations += 1;
    fireEvent.click(screen.getByRole('button', { name: 'capture.next' }));
    primaryActivations += 1;
    await screen.findByRole('heading', { name: 'capture.confirm.title' });
    expect(screen.getByText('Drip irrigation')).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'capture.finish' }));
    primaryActivations += 1;

    await waitFor(() => expect(screen.getByText('Saved on farm gateway')).toBeInTheDocument());
    expect(primaryActivations).toBeLessThanOrEqual(5);
    expect(mocks.journalApi.updateEntry).toHaveBeenCalledTimes(1);
    expect(mocks.journalApi.updateEntry.mock.calls[0][1]).toEqual(expect.objectContaining({
      season_crop: 'barley, winter',
      values: expect.arrayContaining([
        expect.objectContaining({
          attribute_code: 'attr.crop',
          value: 'agroscope.crop.barley_winter',
        }),
        expect.objectContaining({
          attribute_code: 'attr.method',
          value: 'Drip irrigation',
        }),
      ]),
    }));
    const confirmation = screen.getByRole('heading', { name: 'capture.confirm.title' }).closest('section');
    expect(confirmation?.querySelector(':scope > .grid')).toHaveClass('grid', 'grid-cols-1', 'sm:grid-cols-2');
    expect(confirmation?.querySelector(':scope > .flex.flex-nowrap, :scope > .overflow-x-auto')).toBeNull();
  });
});
