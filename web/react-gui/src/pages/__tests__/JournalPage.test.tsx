import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useJournalCatalog: vi.fn(),
  useJournalEntries: vi.fn(),
  useJournalPlots: vi.fn(),
  useJournalPlotGroups: vi.fn(),
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
  retryGroups: vi.fn(),
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
vi.mock('../../journal/useJournalPlotGroups', () => ({
  useJournalPlotGroups: mocks.useJournalPlotGroups,
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
import { partitionCarryForward } from '../../journal/carryForward';
import type {
  EntryAggregate,
  JournalCatalog,
  JournalPlot,
  JournalVocabRow,
  PlotGroup,
} from '../../types/journal';
import type { UpdateEntryPayload } from '../../services/journalApi';
import type { IrrigationZone } from '../../types/farming';

const openFieldActivityCodes = [
  'irrigation',
  'fertilization',
  'fertigation',
  'plant_protection_application',
  'weed_control_nonchemical',
  'seeding',
  'planting_transplanting',
  'pruning',
  'crop_care',
  'tillage_soil_work',
  'mowing',
  'harvest',
  'sampling',
  'general_observation',
  'pest_disease_observation',
  'equipment_maintenance',
] as const;

function catalogVocabRow(
  code: string,
  kind: JournalVocabRow['kind'],
  overrides: Partial<JournalVocabRow> = {},
): JournalVocabRow {
  return {
    parent_code: null,
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
    sort_order: 0,
    sync_version: 0,
    created_at: '2026-07-12T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
    labels: { en: code },
    constraints: null,
    ...overrides,
    code,
    kind,
  };
}

const captureCatalog: JournalCatalog = {
  catalog_version: 1,
  catalog_hash: 'catalog-hash',
  vocab: [
    ...openFieldActivityCodes.map((code, index) => catalogVocabRow(code, 'activity', {
      icon_key: code === 'irrigation' ? 'water' : null,
      labels: { en: code === 'irrigation' ? 'Irrigation' : code },
      sort_order: index + 1,
    })),
    catalogVocabRow('attr.crop', 'attribute', {
      value_type: 'choice', labels: { en: 'Crop' }, constraints: {}, sort_order: 60,
    }),
    catalogVocabRow('agroscope.crop.barley_winter', 'choice', {
      parent_code: 'attr.crop', labels: { en: 'barley, winter' }, sort_order: 61,
    }),
    catalogVocabRow('attr.operator', 'attribute', {
      value_type: 'text', labels: { en: 'Operator' }, constraints: { maxlength: 160 }, sort_order: 65,
    }),
    catalogVocabRow('attr.equipment', 'attribute', {
      value_type: 'text', labels: { en: 'Equipment' }, constraints: { maxlength: 300 }, sort_order: 66,
    }),
    catalogVocabRow('attr.method', 'attribute', {
      value_type: 'text', labels: { en: 'Method' }, constraints: { maxlength: 300 }, sort_order: 67,
    }),
    catalogVocabRow('attr.amount_mass_area_product', 'attribute', {
      value_type: 'number',
      quantity_kind: 'mass_area',
      basis: 'product',
      default_unit_code: 'unit.kg_per_ha_product',
      labels: { en: 'Product mass per area' },
      constraints: { min: 0 },
      sort_order: 101,
    }),
    catalogVocabRow('attr.amount_volume_area_product', 'attribute', {
      value_type: 'number',
      quantity_kind: 'volume_area',
      basis: 'product',
      default_unit_code: 'unit.l_per_ha_product',
      labels: { en: 'Product volume per area' },
      constraints: { min: 0 },
      sort_order: 102,
    }),
    catalogVocabRow('attr.irrigation_depth', 'attribute', {
      value_type: 'number',
      quantity_kind: 'water_depth',
      basis: 'water',
      default_unit_code: 'unit.mm_water',
      labels: { en: 'Irrigation depth' },
      constraints: { min: 0 },
      sort_order: 108,
    }),
    catalogVocabRow('attr.treated_area', 'attribute', {
      value_type: 'number',
      quantity_kind: 'area',
      basis: 'land_area',
      default_unit_code: 'unit.m2_area',
      labels: { en: 'Treated area' },
      constraints: { min: 0 },
      sort_order: 111,
    }),
    catalogVocabRow('attr.block_bed_row', 'attribute', {
      value_type: 'text', labels: { en: 'Block / bed / row' }, constraints: { maxlength: 160 }, sort_order: 143,
    }),
    catalogVocabRow('attr.cover_type', 'attribute', {
      value_type: 'choice', labels: { en: 'Cover type' }, constraints: {}, sort_order: 144,
    }),
    catalogVocabRow('attr.denominator', 'attribute', {
      value_type: 'choice', labels: { en: 'Application denominator' }, constraints: {}, sort_order: 145,
    }),
    catalogVocabRow('unit.kg_per_ha_product', 'unit', {
      quantity_kind: 'mass_area',
      basis: 'product',
      labels: { en: 'kg/ha' },
      constraints: {
        dimension: 'mass_product_per_area',
        to_canonical: { unit_code: 'unit.kg_per_ha_product', scale: 1, offset: 0 },
      },
      sort_order: 502,
    }),
    catalogVocabRow('unit.l_per_ha_product', 'unit', {
      quantity_kind: 'volume_area',
      basis: 'product',
      labels: { en: 'L/ha' },
      constraints: {
        dimension: 'volume_product_per_area',
        to_canonical: { unit_code: 'unit.l_per_ha_product', scale: 1, offset: 0 },
      },
      sort_order: 504,
    }),
    catalogVocabRow('unit.m2_area', 'unit', {
      quantity_kind: 'area',
      basis: 'land_area',
      labels: { en: 'm²' },
      constraints: {
        dimension: 'area',
        to_canonical: { unit_code: 'unit.m2_area', scale: 1, offset: 0 },
      },
      sort_order: 512,
    }),
    catalogVocabRow('unit.mm_water', 'unit', {
      quantity_kind: 'water_depth',
      basis: 'water',
      labels: { en: 'mm' },
      constraints: {
        dimension: 'water_depth',
        to_canonical: { unit_code: 'unit.mm_water', scale: 1, offset: 0 },
      },
      sort_order: 522,
    }),
    catalogVocabRow('choice.cover.bare', 'choice', {
      parent_code: 'attr.cover_type', labels: { en: 'Bare soil' }, sort_order: 10,
    }),
    catalogVocabRow('choice.cover.crop', 'choice', {
      parent_code: 'attr.cover_type', labels: { en: 'Crop cover' }, sort_order: 20,
    }),
    catalogVocabRow('choice.cover.mulch', 'choice', {
      parent_code: 'attr.cover_type', labels: { en: 'Mulch' }, sort_order: 30,
    }),
    catalogVocabRow('choice.denominator.area', 'choice', {
      parent_code: 'attr.denominator', labels: { en: 'Per area' }, sort_order: 10,
    }),
    catalogVocabRow('choice.denominator.plant', 'choice', {
      parent_code: 'attr.denominator', labels: { en: 'Per plant' }, sort_order: 20,
    }),
    catalogVocabRow('choice.denominator.row', 'choice', {
      parent_code: 'attr.denominator', labels: { en: 'Per row length' }, sort_order: 30,
    }),
  ],
  templates: [{
    code: 'farmer_quick',
    version: 1,
    active: 1,
    catalog_errors: [],
    labels: { en: 'Quick' },
    definition: {
      sections: [
        { code: 'what_where_when', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
        {
          code: 'key_values',
          fields: [
            'attr.irrigation_depth',
            'attr.amount_mass_area_product',
            'attr.amount_volume_area_product',
            'note',
          ],
        },
      ],
      max_primary_fields: 5,
      carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
    },
  }, {
    code: 'full_record',
    version: 1,
    active: 1,
    catalog_errors: [],
    labels: { en: 'Full record' },
    definition: { sections: [] },
  }, {
    code: 'research_observation',
    version: 1,
    active: 1,
    catalog_errors: [],
    labels: { en: 'Research' },
    definition: { sections: [] },
  }],
  layouts: [{
    code: 'open_field',
    version: 1,
    active: 1,
    catalog_errors: [],
    labels: { en: 'Open field' },
    definition: {
      activity_codes: [...openFieldActivityCodes],
      supported_templates: ['farmer_quick', 'full_record', 'research_observation'],
      minimum_fields: ['attr.block_bed_row', 'attr.treated_area', 'attr.cover_type', 'attr.denominator'],
      denominator_contract: ['area', 'plant', 'row'],
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
const ROUTE_FIXTURE_IDS = {
  primaryPlot: '11111111-1111-4111-8111-111111111111',
  secondaryPlot: '22222222-2222-4222-8222-222222222222',
  numericPlot: '44444444-4444-4444-8444-444444444444',
  namedPlot: '55555555-5555-4555-8555-555555555555',
  primaryGroup: '33333333-3333-4333-8333-333333333333',
} as const;

function journalPlot(overrides: Partial<JournalPlot> = {}): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: ROUTE_FIXTURE_IDS.primaryPlot,
    plot_code: 'N-1',
    name: 'North field',
    zone_uuid: 'zone-1',
    station_code: null,
    crop_hint: 'Wheat',
    area_m2: 100,
    active: 1,
    sync_version: 0,
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    settings: {
      layout_code: 'greenhouse',
      updated_at: '2026-07-16T00:00:00.000Z',
      updated_by_principal_uuid: 'author',
      sync_version: 0,
    },
    ...overrides,
  };
}

function journalPlotGroup(overrides: Partial<PlotGroup> = {}): PlotGroup {
  return {
    contract_version: 1,
    group_uuid: ROUTE_FIXTURE_IDS.primaryGroup,
    label: 'North pair',
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_by_principal_uuid: 'author',
    created_at: '2026-07-16T00:00:00.000Z',
    resolved_at: null,
    resolved_by_principal_uuid: null,
    sync_version: 0,
    deleted_at: null,
    members: [ROUTE_FIXTURE_IDS.primaryPlot],
    ...overrides,
  };
}

const plots: JournalPlot[] = [journalPlot()];
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
  plot_uuid: ROUTE_FIXTURE_IDS.primaryPlot,
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
  layout_code: 'open_field',
  layout_version: 1,
  catalog_version: 1,
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
      createPlot: vi.fn(),
      updatePlot: vi.fn(),
    });
    mocks.useJournalPlotGroups.mockReturnValue({
      groups: [],
      activeGroups: [],
      resolvedGroups: [],
      loading: false,
      error: undefined,
      retry: mocks.retryGroups,
      createPlotGroup: vi.fn(),
      updatePlotGroup: vi.fn(),
      revalidate: mocks.retryGroups,
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
      target: { value: ROUTE_FIXTURE_IDS.primaryPlot },
    });
    fireEvent.change(screen.getByLabelText('filters.activity'), {
      target: { value: 'irrigation' },
    });

    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      {
        status: 'final',
        limit: 50,
        plot_uuid: ROUTE_FIXTURE_IDS.primaryPlot,
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

  it('reaches New plot and Edit selected plot controls through the route', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));

    const props = mocks.captureFlow.mock.lastCall?.[0];
    expect(props.plotState).toEqual(expect.objectContaining({
      createPlot: expect.any(Function),
      updatePlot: expect.any(Function),
    }));
    expect(props.plots).toEqual(expect.arrayContaining([
      expect.objectContaining({ plot_uuid: ROUTE_FIXTURE_IDS.primaryPlot, name: 'North field' }),
    ]));
  });

  it('operates New plot and Edit selected plot through the real route controls', async () => {
    mocks.useRealCaptureFlow = true;
    mocks.useJournalCatalog.mockReturnValue({
      catalog: captureCatalog,
      available: true,
      unavailable: false,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });
    const editablePlot = {
      ...plots[0],
      active: 1,
      deleted_at: null,
      station_code: 'ST-1',
      settings: { ...plots[0].settings, layout_code: 'open_field' },
    };
    const createPlot = vi.fn().mockResolvedValue(editablePlot);
    const updatePlot = vi.fn().mockResolvedValue(editablePlot);
    mocks.useJournalPlots.mockReturnValue({
      plots: [editablePlot],
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
      createPlot,
      updatePlot,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));
    expect(screen.queryByTestId('capture-flow')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'plot.new' }));
    fireEvent.change(screen.getByLabelText('plot.code'), { target: { value: 'NEW-1' } });
    fireEvent.change(screen.getByLabelText('plot.layout'), { target: { value: 'open_field' } });
    fireEvent.click(screen.getByRole('button', { name: 'plot.save' }));
    await waitFor(() => expect(createPlot).toHaveBeenCalledWith(expect.objectContaining({
      plot_code: 'NEW-1',
      layout_code: 'open_field',
      base_sync_version: 0,
    })));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'plot.new' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'plot.edit' }));
    fireEvent.change(screen.getByLabelText('plot.name'), { target: { value: 'Renamed field' } });
    fireEvent.click(screen.getByRole('button', { name: 'plot.save' }));
    await waitFor(() => expect(updatePlot).toHaveBeenCalledWith(
      ROUTE_FIXTURE_IDS.primaryPlot,
      expect.objectContaining({ name: 'Renamed field', base_sync_version: 0 }),
    ));
  });

  it('reaches group create and active-group edit controls through the route', () => {
    const group = journalPlotGroup();
    mocks.useJournalPlotGroups.mockReturnValue({
      groups: [group],
      activeGroups: [group],
      resolvedGroups: [],
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
      createPlotGroup: vi.fn(),
      updatePlotGroup: vi.fn(),
      revalidate: mocks.retryPlots,
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));

    const props = mocks.captureFlow.mock.lastCall?.[0];
    expect(props.plotGroups).toEqual([group]);
    expect(props.groupState).toEqual(expect.objectContaining({
      createPlotGroup: expect.any(Function),
      updatePlotGroup: expect.any(Function),
    }));
  });

  it('operates group create and active-group edit through the real route controls', async () => {
    mocks.useRealCaptureFlow = true;
    mocks.useJournalCatalog.mockReturnValue({
      catalog: captureCatalog,
      available: true,
      unavailable: false,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });
    const firstPlot = {
      ...plots[0],
      active: 1,
      deleted_at: null,
      station_code: 'ST-1',
      settings: { ...plots[0].settings, layout_code: 'open_field' },
    };
    const secondPlot = {
      ...firstPlot,
      plot_uuid: ROUTE_FIXTURE_IDS.secondaryPlot,
      plot_code: 'N-2',
      name: 'North second',
    };
    const activeGroup = journalPlotGroup({
      members: [ROUTE_FIXTURE_IDS.primaryPlot, ROUTE_FIXTURE_IDS.secondaryPlot],
      sync_version: 3,
    });
    const createPlotGroup = vi.fn().mockResolvedValue(activeGroup);
    const updatePlotGroup = vi.fn().mockResolvedValue(activeGroup);
    mocks.useJournalPlots.mockReturnValue({
      plots: [firstPlot, secondPlot],
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
      createPlot: vi.fn(),
      updatePlot: vi.fn(),
    });
    mocks.useJournalPlotGroups.mockReturnValue({
      groups: [activeGroup],
      activeGroups: [activeGroup],
      resolvedGroups: [],
      loading: false,
      error: undefined,
      retry: mocks.retryGroups,
      createPlotGroup,
      updatePlotGroup,
      revalidate: mocks.retryGroups,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));
    fireEvent.click(screen.getByRole('button', { name: 'North pair' }));
    fireEvent.click(screen.getByRole('button', { name: 'where.createGroup' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'where.groupLabel' }), {
      target: { value: 'Created pair' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'where.saveGroup' }));
    await waitFor(() => expect(createPlotGroup).toHaveBeenCalledWith(expect.objectContaining({
      group_uuid: expect.any(String),
      base_sync_version: 0,
      label: 'Created pair',
      members: [ROUTE_FIXTURE_IDS.primaryPlot, ROUTE_FIXTURE_IDS.secondaryPlot],
      resolved: false,
    })));

    fireEvent.click(screen.getByRole('button', { name: /where.editGroup North pair/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'where.groupLabel' }), {
      target: { value: 'Renamed pair' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'where.saveGroup' }));
    await waitFor(() => expect(updatePlotGroup).toHaveBeenCalledWith(
      ROUTE_FIXTURE_IDS.primaryGroup,
      expect.objectContaining({
        group_uuid: ROUTE_FIXTURE_IDS.primaryGroup,
        base_sync_version: 3,
        label: 'Renamed pair',
        members: [ROUTE_FIXTURE_IDS.primaryPlot, ROUTE_FIXTURE_IDS.secondaryPlot],
        resolved: false,
      }),
    ));
  });

  it('proves shipped numeric and nonnumeric station range selection for Apply and Enter', async () => {
    mocks.useRealCaptureFlow = true;
    const stationPlot = (uuid: string, plotCode: string, name: string): JournalPlot => ({
      ...plots[0],
      plot_uuid: uuid,
      plot_code: plotCode,
      name,
      station_code: 'ST-1',
      active: 1,
      deleted_at: null,
      settings: { ...plots[0].settings, layout_code: 'open_field' },
    });
    const numericOne = stationPlot(ROUTE_FIXTURE_IDS.numericPlot, '1', 'Numeric one');
    const numericTwo = stationPlot(ROUTE_FIXTURE_IDS.secondaryPlot, '2', 'Numeric two');
    const named = stationPlot(ROUTE_FIXTURE_IDS.namedPlot, 'NORTH-A', 'Named bed');
    mocks.useJournalCatalog.mockReturnValue({
      catalog: captureCatalog,
      available: true,
      unavailable: false,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });
    mocks.useJournalPlots.mockReturnValue({
      plots: [numericOne, numericTwo, named],
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
      createPlot: vi.fn(),
      updatePlot: vi.fn(),
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));
    fireEvent.click(screen.getByText('ST-1', { exact: true }));
    const range = screen.getByRole('textbox', { name: 'where.range' });
    expect(screen.getByRole('button', { name: 'Named bed' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Named bed' }));

    fireEvent.change(range, { target: { value: '1-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'where.applyRange' }));
    expect(screen.getByRole('button', { name: /Numeric one$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Numeric two$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Named bed' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(range, { target: { value: '2' } });
    fireEvent.keyDown(range, { key: 'Enter', code: 'Enter' });
    expect(screen.getByRole('button', { name: /Numeric one$/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Numeric two$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Named bed' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => {});
  });

  it('opens a known query zone without exposing its identifier and preserves plot crop context', async () => {
    renderPage('/journal?capture=1&zone_uuid=zone-1');

    await waitFor(() => expect(mocks.captureFlow).toHaveBeenCalled());
    const props = mocks.captureFlow.mock.lastCall?.[0];
    expect(props.initialPlot).toEqual(expect.objectContaining({
      plot_uuid: ROUTE_FIXTURE_IDS.primaryPlot,
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
      plot_uuid: ROUTE_FIXTURE_IDS.secondaryPlot,
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
      expect.objectContaining({ plot_uuid: ROUTE_FIXTURE_IDS.primaryPlot, crop_hint: 'Barley' }),
      expect.objectContaining({ plot_uuid: ROUTE_FIXTURE_IDS.secondaryPlot, crop_hint: 'Corn' }),
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

  it('keeps the ordinary timeline usable when plot-group enrichment fails', () => {
    mocks.useJournalPlotGroups.mockReturnValue({
      groups: [],
      activeGroups: [],
      resolvedGroups: [],
      loading: false,
      error: new Error('groups offline'),
      retry: mocks.retryGroups,
      createPlotGroup: vi.fn(),
      updatePlotGroup: vi.fn(),
      revalidate: mocks.retryGroups,
    });

    renderPage();

    expect(screen.getByTestId('timeline')).toBeInTheDocument();
    expect(screen.queryByText('error.title')).not.toBeInTheDocument();
  });

  it('scopes a capture plot-group error and retry to the group resource', () => {
    mocks.useJournalPlotGroups.mockReturnValue({
      groups: [],
      activeGroups: [],
      resolvedGroups: [],
      loading: false,
      error: new Error('groups offline'),
      retry: mocks.retryGroups,
      createPlotGroup: vi.fn(),
      updatePlotGroup: vi.fn(),
      revalidate: mocks.retryGroups,
    });

    renderPage('/journal?capture=1');

    expect(screen.getByText('error.title')).toBeInTheDocument();
    expect(screen.queryByTestId('capture-flow')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));
    expect(mocks.retryGroups).toHaveBeenCalledOnce();
    expect(mocks.retryEntries).not.toHaveBeenCalled();
    expect(mocks.retryPlots).not.toHaveBeenCalled();
    expect(mocks.retryZones).not.toHaveBeenCalled();
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
    fireEvent.change(screen.getByLabelText('filters.plot'), { target: { value: ROUTE_FIXTURE_IDS.primaryPlot } });
    fireEvent.change(screen.getByLabelText('filters.activity'), { target: { value: 'irrigation' } });
    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      {
        status: 'final',
        limit: 50,
        plot_uuid: ROUTE_FIXTURE_IDS.primaryPlot,
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

  it('revalidates entries after onSaved receives a BatchMutationReceipt', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'logActivity' }));
    await waitFor(() => expect(mocks.captureFlow).toHaveBeenCalled());

    const onSaved = mocks.captureFlow.mock.lastCall?.[0].onSaved as (receipt: unknown) => Promise<void>;
    await onSaved({
      batch_uuid: 'batch-1',
      entries: [{
        plot_uuid: ROUTE_FIXTURE_IDS.primaryPlot,
        entry_uuid: 'entry-1',
        outbox_event_uuid: 'outbox-1',
        sync_version: 1,
      }],
    });

    expect(mocks.retryEntries).toHaveBeenCalledOnce();
  });

  it('preserves the existing nine-activation open_field SLA regression', async () => {
    expect(captureCatalog.templates.find(({ code }) => code === 'farmer_quick')?.definition).toEqual({
      sections: [
        { code: 'what_where_when', fields: ['activity_code', 'plot_uuid', 'occurred_start'] },
        {
          code: 'key_values',
          fields: [
            'attr.irrigation_depth',
            'attr.amount_mass_area_product',
            'attr.amount_volume_area_product',
            'note',
          ],
        },
      ],
      max_primary_fields: 5,
      carry_forward: ['attr.operator', 'attr.equipment', 'attr.method'],
    });
    expect(captureCatalog.layouts.find(({ code }) => code === 'open_field')?.definition).toEqual({
      activity_codes: [
        'irrigation',
        'fertilization',
        'fertigation',
        'plant_protection_application',
        'weed_control_nonchemical',
        'seeding',
        'planting_transplanting',
        'pruning',
        'crop_care',
        'tillage_soil_work',
        'mowing',
        'harvest',
        'sampling',
        'general_observation',
        'pest_disease_observation',
        'equipment_maintenance',
      ],
      supported_templates: ['farmer_quick', 'full_record', 'research_observation'],
      minimum_fields: ['attr.block_bed_row', 'attr.treated_area', 'attr.cover_type', 'attr.denominator'],
      denominator_contract: ['area', 'plant', 'row'],
      option_dependencies: [],
    });
    expect(partitionCarryForward(carryForwardSource, {
      definition: captureCatalog.templates.find(({ code }) => code === 'farmer_quick')?.definition,
    }).automaticValues).toEqual(expect.arrayContaining([{
      attribute_code: 'attr.method',
      group_index: 0,
      value_status: 'observed',
      value_text: 'Drip irrigation',
    }]));
    expect(plots[0].settings.layout_code).toBe('greenhouse');
    mocks.useRealCaptureFlow = true;
    mocks.useJournalCatalog.mockReturnValue({
      catalog: captureCatalog,
      available: true,
      unavailable: false,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });
    const openFieldPlots = [{
      ...plots[0],
      settings: { ...plots[0].settings, layout_code: 'open_field' },
    }];
    mocks.useJournalPlots.mockReturnValue({
      plots: openFieldPlots,
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
    });
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    let primaryActivations = 0;
    const primaryActivate = (dispatch: () => unknown) => {
      dispatch();
      primaryActivations += 1;
    };
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
    primaryActivate(() => fireEvent.click(zoneCta));
    await screen.findByRole('heading', { name: 'capture.title' });
    primaryActivate(() => fireEvent.click(screen.getByRole('button', { name: 'Irrigation' })));
    const captureNavigation = screen.getByRole('button', { name: 'capture.next' }).parentElement;
    expect(captureNavigation).toHaveClass('flex', 'flex-wrap');
    expect(captureNavigation).not.toHaveClass('flex-nowrap', 'overflow-x-auto');
    primaryActivate(() => fireEvent.click(screen.getByRole('button', { name: 'capture.next' })));
    expect(screen.getByLabelText(/Block \/ bed \/ row/)).toHaveValue('');
    expect(screen.getByLabelText(/Treated area/)).toHaveValue('');
    expect(screen.getByLabelText(/Cover type/)).toHaveValue('');
    expect(screen.getByLabelText(/Application denominator/)).toHaveValue('');
    primaryActivate(() => fireEvent.change(
      screen.getByLabelText(/Block \/ bed \/ row/),
      { target: { value: 'B-12' } },
    ));
    primaryActivate(() => fireEvent.change(
      screen.getByLabelText(/Treated area/),
      { target: { value: '1200' } },
    ));
    primaryActivate(() => fireEvent.change(
      screen.getByLabelText(/Cover type/),
      { target: { value: 'choice.cover.crop' } },
    ));
    primaryActivate(() => fireEvent.change(
      screen.getByLabelText(/Application denominator/),
      { target: { value: 'choice.denominator.area' } },
    ));
    primaryActivate(() => fireEvent.click(screen.getByRole('button', { name: 'capture.next' })));
    await screen.findByRole('heading', { name: 'capture.confirm.title' });
    expect(screen.getAllByRole('main')).toHaveLength(1);
    primaryActivate(() => fireEvent.click(screen.getByRole('button', { name: 'capture.finish' })));

    await waitFor(() => expect(screen.getByText('Saved on farm gateway')).toBeInTheDocument());
    expect(primaryActivations).toBe(9);
    expect(primaryActivations).toBeLessThanOrEqual(9);
    expect(mocks.journalApi.updateEntry).toHaveBeenCalledTimes(1);
    const finalPayload = mocks.journalApi.updateEntry.mock.calls[0][1] as UpdateEntryPayload;
    expect(finalPayload).toEqual(expect.objectContaining({
      status: 'final',
      season_crop: 'barley, winter',
      values: expect.arrayContaining([
        expect.objectContaining({
          attribute_code: 'attr.crop',
          value: 'agroscope.crop.barley_winter',
        }),
      ]),
    }));
    const requiredCodes = new Set([
      'attr.block_bed_row',
      'attr.treated_area',
      'attr.cover_type',
      'attr.denominator',
    ]);
    const requiredValues = finalPayload.values
      .filter(({ attribute_code }) => requiredCodes.has(attribute_code))
      .sort((left, right) => left.attribute_code.localeCompare(right.attribute_code));
    expect(requiredValues).toEqual([
      {
        attribute_code: 'attr.block_bed_row',
        value: 'B-12',
      },
      {
        attribute_code: 'attr.cover_type',
        value: 'choice.cover.crop',
      },
      {
        attribute_code: 'attr.denominator',
        value: 'choice.denominator.area',
      },
      {
        attribute_code: 'attr.treated_area',
        entered_unit_code: 'unit.m2_area',
        entered_value_num: 1200,
        unit_code: 'unit.m2_area',
        value_num: 1200,
      },
    ]);
    const confirmation = screen.getByRole('heading', { name: 'capture.confirm.title' }).closest('section');
    expect(confirmation?.querySelector(':scope > .grid')).toHaveClass('grid', 'grid-cols-1', 'sm:grid-cols-2');
    expect(confirmation?.querySelector(':scope > .flex.flex-nowrap, :scope > .overflow-x-auto')).toBeNull();
  });
});
