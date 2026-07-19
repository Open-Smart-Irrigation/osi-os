import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scopeRail: vi.fn(),
  entryTable: vi.fn(),
  detailPanel: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../ScopeRail', async () => {
  const actual = await vi.importActual<typeof import('../ScopeRail')>('../ScopeRail');
  return {
    ...actual,
    ScopeRail: (props: unknown) => {
      mocks.scopeRail(props);
      return <div data-testid="scope-rail" />;
    },
  };
});

vi.mock('../EntryTable', () => ({
  EntryTable: (props: unknown) => {
    mocks.entryTable(props);
    const { selectedEntryUuid } = props as EntryTableProps;
    return (
      <div data-testid="entry-table">
        {selectedEntryUuid && (
          // Stands in for Task 29's real per-row element (which carries this
          // same testid) so the focus-return seam can be exercised without
          // depending on EntryTable's real implementation.
          <button type="button" data-testid={`entry-row-${selectedEntryUuid}`} />
        )}
      </div>
    );
  },
}));

vi.mock('../DetailPanel', () => ({
  DetailPanel: (props: unknown) => {
    mocks.detailPanel(props);
    return <div data-testid="detail-panel" />;
  },
}));

import { JournalWorkspace } from '../JournalWorkspace';
import { DEFAULT_SCOPE_RAIL_FILTERS, type ScopeRailProps } from '../ScopeRail';
import type { EntryTableProps } from '../EntryTable';
import type { DetailPanelProps } from '../DetailPanel';
import type { JournalCatalog, JournalPlot, JournalVocabRow, PlotGroup } from '../../../../types/journal';
import type { IrrigationZone } from '../../../../types/farming';

function journalPlot(overrides: Partial<JournalPlot> = {}): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: 'plot-1',
    plot_code: 'N-1',
    name: 'North field',
    zone_uuid: 'zone-1',
    station_code: null,
    crop_hint: null,
    area_m2: 100,
    active: 1,
    sync_version: 0,
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: '2026-07-16T00:00:00.000Z',
      updated_by_principal_uuid: 'author',
      sync_version: 0,
    },
    ...overrides,
  };
}

function vocabRow(code: string): JournalVocabRow {
  return {
    code,
    kind: 'activity',
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
    created_at: '2026-07-16T00:00:00.000Z',
    deleted_at: null,
    catalog_errors: [],
  };
}

const activeGroups: PlotGroup[] = [];

const catalog: JournalCatalog = {
  catalog_version: 1,
  catalog_hash: 'hash-1',
  vocab: [],
  templates: [],
  layouts: [],
  products: [],
  mappings: [],
};

function renderWorkspace(overrides: {
  plots?: JournalPlot[];
  activeGroups?: PlotGroup[];
  zones?: IrrigationZone[];
  activities?: JournalVocabRow[];
  catalog?: JournalCatalog;
} = {}) {
  return render(
    <JournalWorkspace
      plots={overrides.plots ?? [journalPlot()]}
      activeGroups={overrides.activeGroups ?? activeGroups}
      zones={overrides.zones ?? []}
      activities={overrides.activities ?? [vocabRow('irrigation')]}
      catalog={overrides.catalog ?? catalog}
    />,
  );
}

function lastScopeRailProps(): ScopeRailProps {
  return mocks.scopeRail.mock.lastCall?.[0] as ScopeRailProps;
}

function lastEntryTableProps(): EntryTableProps {
  return mocks.entryTable.mock.lastCall?.[0] as EntryTableProps;
}

function lastDetailPanelProps(): DetailPanelProps {
  return mocks.detailPanel.mock.lastCall?.[0] as DetailPanelProps;
}

describe('JournalWorkspace', () => {
  it('renders a three-pane grid with the scope rail, an entry table, and a detail panel', () => {
    const { container } = renderWorkspace();

    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid');
    expect(grid.className).toContain('lg:grid-cols-[320px_1fr_360px]');
    expect(screen.getByTestId('scope-rail')).toBeInTheDocument();
    expect(screen.getByTestId('entry-table')).toBeInTheDocument();
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });

  it('passes the catalog and plots straight through to the detail panel', () => {
    const plots = [journalPlot({ plot_uuid: 'plot-a' })];

    renderWorkspace({ plots, catalog });

    expect(lastDetailPanelProps().catalog).toBe(catalog);
    expect(lastDetailPanelProps().plots).toBe(plots);
  });

  it('keeps the detail panel synced with selectedEntryUuid', () => {
    renderWorkspace();

    expect(lastDetailPanelProps().selectedEntryUuid).toBeNull();
    act(() => lastEntryTableProps().onSelectEntry('entry-1'));

    expect(lastDetailPanelProps().selectedEntryUuid).toBe('entry-1');
  });

  it('exposes a focus-return seam that gives keyboard focus back to the selected entry row', () => {
    renderWorkspace();
    act(() => lastEntryTableProps().onSelectEntry('entry-1'));

    const row = screen.getByTestId('entry-row-entry-1');
    const focusSpy = vi.spyOn(row, 'focus');

    act(() => lastDetailPanelProps().onFocusReturn?.());

    expect(focusSpy).toHaveBeenCalled();
  });

  it('passes plots straight through to the entry table', () => {
    const plots = [journalPlot({ plot_uuid: 'plot-a' })];

    renderWorkspace({ plots });

    expect(lastEntryTableProps().plots).toBe(plots);
  });

  it('owns selectedEntryUuid state, starting at null, and passes updates back down through onSelectEntry', () => {
    renderWorkspace();

    expect(lastEntryTableProps().selectedEntryUuid).toBeNull();
    act(() => lastEntryTableProps().onSelectEntry('entry-1'));

    expect(lastEntryTableProps().selectedEntryUuid).toBe('entry-1');
  });

  it('combines the active scope and rail filters into entry-list filters for the entry table', () => {
    renderWorkspace();

    expect(lastEntryTableProps().filters).toEqual({ status: 'all' });

    act(() => lastScopeRailProps().onScopeChange({ kind: 'plot', plotUuid: 'plot-a' }));
    act(() => lastScopeRailProps().onFiltersChange({
      ...DEFAULT_SCOPE_RAIL_FILTERS,
      activityCode: 'irrigation',
      status: 'final',
      occurredFrom: '2026-07-01',
      occurredTo: '2026-07-31',
      campaignUuid: 'campaign-1',
      protocolCode: 'protocol-1',
    }));

    expect(lastEntryTableProps().filters).toEqual({
      plot_uuid: 'plot-a',
      status: 'final',
      activity_code: 'irrigation',
      occurred_from: '2026-07-01',
      occurred_to: '2026-07-31',
      campaign_uuid: 'campaign-1',
      protocol_code: 'protocol-1',
    });
  });

  it('does not narrow the entry-list filters by plot for station or group scope (the shipped API only accepts one plot_uuid)', () => {
    renderWorkspace();

    act(() => lastScopeRailProps().onScopeChange({ kind: 'station', stationCode: 'ST-1' }));
    expect(lastEntryTableProps().filters).not.toHaveProperty('plot_uuid');

    act(() => lastScopeRailProps().onScopeChange({ kind: 'group', groupUuid: 'group-1' }));
    expect(lastEntryTableProps().filters).not.toHaveProperty('plot_uuid');

    act(() => lastScopeRailProps().onScopeChange({ kind: 'all' }));
    expect(lastEntryTableProps().filters).not.toHaveProperty('plot_uuid');
  });

  it('discloses that the list and exports cover all plots when the scope cannot narrow them (station or group), and stays quiet otherwise', () => {
    renderWorkspace();

    // Global view: no notice.
    expect(screen.queryByText('workspace.table.scopeNotNarrowed')).not.toBeInTheDocument();

    act(() => lastScopeRailProps().onScopeChange({ kind: 'station', stationCode: 'ST-1' }));
    expect(screen.getByText('workspace.table.scopeNotNarrowed')).toBeInTheDocument();

    act(() => lastScopeRailProps().onScopeChange({ kind: 'group', groupUuid: 'group-1' }));
    expect(screen.getByText('workspace.table.scopeNotNarrowed')).toBeInTheDocument();

    // Single-plot scope: the filter really does narrow the list, no notice.
    act(() => lastScopeRailProps().onScopeChange({ kind: 'plot', plotUuid: 'plot-a' }));
    expect(screen.queryByText('workspace.table.scopeNotNarrowed')).not.toBeInTheDocument();

    act(() => lastScopeRailProps().onScopeChange({ kind: 'all' }));
    expect(screen.queryByText('workspace.table.scopeNotNarrowed')).not.toBeInTheDocument();
  });

  it('passes the real plots, active groups, and activities straight through to the scope rail', () => {
    const plots = [journalPlot({ plot_uuid: 'plot-a' })];
    const groups = [{
      contract_version: 1,
      group_uuid: 'group-1',
      label: 'North pair',
      owner_user_uuid: 'owner',
      gateway_device_eui: 'gateway',
      created_by_principal_uuid: 'author',
      created_at: '2026-07-16T00:00:00.000Z',
      resolved_at: null,
      resolved_by_principal_uuid: null,
      sync_version: 0,
      deleted_at: null,
      members: ['plot-a'],
    }];
    const activities = [vocabRow('irrigation'), vocabRow('harvest')];

    renderWorkspace({ plots, activeGroups: groups, activities });

    expect(lastScopeRailProps().plots).toBe(plots);
    expect(lastScopeRailProps().activeGroups).toBe(groups);
    expect(lastScopeRailProps().activities).toBe(activities);
  });

  it('normalizes zone device counts from either snake_case or camelCase zone fields into a sensor-count map', () => {
    const zones = [
      { zone_uuid: 'zone-1', device_count: 3 } as IrrigationZone,
      { zoneUuid: 'zone-2', deviceCount: 5 } as IrrigationZone,
    ];

    renderWorkspace({ zones });

    expect(lastScopeRailProps().sensorCountByZoneUuid).toEqual({ 'zone-1': 3, 'zone-2': 5 });
  });

  it('owns scope selection state and passes updates back down to the scope rail', () => {
    renderWorkspace();

    expect(lastScopeRailProps().scope).toEqual({ kind: 'all' });
    act(() => lastScopeRailProps().onScopeChange({ kind: 'station', stationCode: 'ST-1' }));

    expect(lastScopeRailProps().scope).toEqual({ kind: 'station', stationCode: 'ST-1' });
  });

  it('owns filter state, starting from the shared defaults, and passes updates back down', () => {
    renderWorkspace();

    expect(lastScopeRailProps().filters).toEqual(DEFAULT_SCOPE_RAIL_FILTERS);
    act(() => lastScopeRailProps().onFiltersChange({ ...DEFAULT_SCOPE_RAIL_FILTERS, activityCode: 'irrigation' }));

    expect(lastScopeRailProps().filters).toEqual({ ...DEFAULT_SCOPE_RAIL_FILTERS, activityCode: 'irrigation' });
  });

  it('owns search state and passes updates back down', () => {
    renderWorkspace();

    expect(lastScopeRailProps().search).toBe('');
    act(() => lastScopeRailProps().onSearchChange('north'));

    expect(lastScopeRailProps().search).toBe('north');
  });
});
