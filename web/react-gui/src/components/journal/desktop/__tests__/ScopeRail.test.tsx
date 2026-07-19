import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      if (options && typeof options === 'object' && 'count' in options) return `${key}:${options.count}`;
      return key;
    },
  }),
}));

import { ScopeRail, DEFAULT_SCOPE_RAIL_FILTERS, type ScopeSelection } from '../ScopeRail';
import type { JournalPlot, PlotGroup } from '../../../../types/journal';

function journalPlot(overrides: Partial<JournalPlot> = {}): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: 'plot-1',
    plot_code: 'N-1',
    name: 'North field',
    zone_uuid: null,
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

function plotGroup(overrides: Partial<PlotGroup> = {}): PlotGroup {
  return {
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
    members: [],
    ...overrides,
  };
}

const noop = () => {};

function baseProps() {
  return {
    plots: [] as JournalPlot[],
    activeGroups: [] as PlotGroup[],
    activities: [{ code: 'irrigation' }, { code: 'harvest' }],
    sensorCountByZoneUuid: {} as Record<string, number>,
    scope: { kind: 'all' } as ScopeSelection,
    onScopeChange: noop,
    filters: DEFAULT_SCOPE_RAIL_FILTERS,
    onFiltersChange: noop,
    search: '',
    onSearchChange: noop,
  };
}

describe('ScopeRail', () => {
  it('renders a 72-plot station as a single row carrying the plot count and sensor summary', () => {
    const plots = Array.from({ length: 72 }, (_, index) => journalPlot({
      plot_uuid: `plot-${index + 1}`,
      plot_code: String(index + 1),
      name: null,
      station_code: 'ST-1',
      zone_uuid: 'zone-1',
    }));

    render(<ScopeRail {...baseProps()} plots={plots} sensorCountByZoneUuid={{ 'zone-1': 3 }} />);

    const stationButtons = screen.getAllByRole('button', { name: /ST-1/ });
    expect(stationButtons).toHaveLength(1);
    expect(stationButtons[0]).toHaveTextContent('where.rangePlotCount:72');
    expect(stationButtons[0]).toHaveTextContent('workspace.scope.sensors:3');
    // Individual plot codes are never listed as separate scope rows.
    expect(screen.queryByRole('button', { name: '1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '72' })).not.toBeInTheDocument();
  });

  it('shows the no-sensors label when a station has no linked zone devices', () => {
    const plots = [journalPlot({ station_code: 'ST-2', zone_uuid: null })];

    render(<ScopeRail {...baseProps()} plots={plots} />);

    expect(screen.getByRole('button', { name: /ST-2/ })).toHaveTextContent('workspace.scope.noSensors');
  });

  it('selects a station scope and reflects it via aria-pressed', () => {
    const plots = [journalPlot({ station_code: 'ST-1' })];
    const onScopeChange = vi.fn();

    const { rerender } = render(
      <ScopeRail {...baseProps()} plots={plots} onScopeChange={onScopeChange} />,
    );
    const stationButton = screen.getByRole('button', { name: /ST-1/ });
    expect(stationButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(stationButton);
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'station', stationCode: 'ST-1' });

    rerender(
      <ScopeRail
        {...baseProps()}
        plots={plots}
        onScopeChange={onScopeChange}
        scope={{ kind: 'station', stationCode: 'ST-1' }}
      />,
    );
    expect(screen.getByRole('button', { name: /ST-1/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders active groups with a member count and sensor summary, and selects a group scope', () => {
    const plots = [
      journalPlot({ plot_uuid: 'plot-a', zone_uuid: 'zone-a' }),
      journalPlot({ plot_uuid: 'plot-b', zone_uuid: 'zone-a', plot_code: 'N-2' }),
    ];
    const groups = [plotGroup({ group_uuid: 'group-1', label: 'North pair', members: ['plot-a', 'plot-b'] })];
    const onScopeChange = vi.fn();

    render(
      <ScopeRail
        {...baseProps()}
        plots={plots}
        activeGroups={groups}
        sensorCountByZoneUuid={{ 'zone-a': 4 }}
        onScopeChange={onScopeChange}
      />,
    );

    const groupButton = screen.getByRole('button', { name: /North pair/ });
    expect(groupButton).toHaveTextContent('group.members:2');
    // Sensor count is deduplicated by zone: two plots share one zone, so this
    // must report the zone's device count once, not doubled.
    expect(groupButton).toHaveTextContent('workspace.scope.sensors:4');

    fireEvent.click(groupButton);
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'group', groupUuid: 'group-1' });
  });

  it('does not render a deleted group', () => {
    const groups = [plotGroup({ label: 'Gone group', deleted_at: '2026-07-18T00:00:00.000Z' })];

    render(<ScopeRail {...baseProps()} activeGroups={groups} />);

    expect(screen.queryByRole('button', { name: /Gone group/ })).not.toBeInTheDocument();
  });

  it('renders ungrouped (unstationed) plots individually and selects a plot scope', () => {
    const plots = [
      journalPlot({ plot_uuid: 'plot-solo', name: 'Solo field', station_code: null }),
      journalPlot({ plot_uuid: 'plot-stationed', station_code: 'ST-1' }),
    ];
    const onScopeChange = vi.fn();

    render(<ScopeRail {...baseProps()} plots={plots} onScopeChange={onScopeChange} />);

    const plotButton = screen.getByRole('button', { name: 'Solo field' });
    fireEvent.click(plotButton);
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'plot', plotUuid: 'plot-solo' });
    // The stationed plot must not also appear as an individual ungrouped row.
    expect(screen.queryByRole('button', { name: 'N-1' })).not.toBeInTheDocument();
  });

  it('excludes inactive and deleted plots from stations and ungrouped rows', () => {
    const plots = [
      journalPlot({ plot_uuid: 'plot-inactive', name: 'Retired field', active: 0, station_code: null }),
      journalPlot({ plot_uuid: 'plot-deleted', name: 'Deleted field', deleted_at: '2026-07-18T00:00:00.000Z', station_code: null }),
    ];

    render(<ScopeRail {...baseProps()} plots={plots} />);

    expect(screen.queryByRole('button', { name: 'Retired field' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deleted field' })).not.toBeInTheDocument();
  });

  it('exposes an "All plots" scope control selected by default', () => {
    render(<ScopeRail {...baseProps()} />);

    expect(screen.getByRole('button', { name: 'filters.allPlots' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('filters the visible stations, groups, and ungrouped plots by the search text', () => {
    const plots = [
      journalPlot({ plot_uuid: 'plot-north', station_code: 'ST-NORTH' }),
      journalPlot({ plot_uuid: 'plot-south', station_code: 'ST-SOUTH', plot_code: 'S-1' }),
      journalPlot({ plot_uuid: 'plot-solo', name: 'Solo field', station_code: null }),
    ];
    const groups = [plotGroup({ group_uuid: 'group-1', label: 'North pair', members: ['plot-north'] })];

    render(<ScopeRail {...baseProps()} plots={plots} activeGroups={groups} search="north" />);

    expect(screen.getByRole('button', { name: /ST-NORTH/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ST-SOUTH/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /North pair/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Solo field' })).not.toBeInTheDocument();
  });

  it('reports search text changes through a labeled search control', () => {
    const onSearchChange = vi.fn();
    render(<ScopeRail {...baseProps()} onSearchChange={onSearchChange} />);

    const search = screen.getByRole('searchbox', { name: 'workspace.search' });
    fireEvent.change(search, { target: { value: 'north' } });
    expect(onSearchChange).toHaveBeenCalledWith('north');
  });

  it('exposes activity, status, date range, campaign, and protocol filter controls', () => {
    const onFiltersChange = vi.fn();
    render(<ScopeRail {...baseProps()} onFiltersChange={onFiltersChange} />);

    fireEvent.change(screen.getByLabelText('filters.activity'), { target: { value: 'irrigation' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_SCOPE_RAIL_FILTERS, activityCode: 'irrigation' });

    fireEvent.change(screen.getByLabelText('filters.status'), { target: { value: 'final' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_SCOPE_RAIL_FILTERS, status: 'final' });

    fireEvent.change(screen.getByLabelText('filters.dateFrom'), { target: { value: '2026-07-01' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_SCOPE_RAIL_FILTERS, occurredFrom: '2026-07-01' });

    fireEvent.change(screen.getByLabelText('filters.dateTo'), { target: { value: '2026-07-31' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_SCOPE_RAIL_FILTERS, occurredTo: '2026-07-31' });

    fireEvent.change(screen.getByLabelText('filters.campaign'), { target: { value: 'camp-1' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_SCOPE_RAIL_FILTERS, campaignUuid: 'camp-1' });

    fireEvent.change(screen.getByLabelText('filters.protocol'), { target: { value: 'proto-1' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_SCOPE_RAIL_FILTERS, protocolCode: 'proto-1' });
  });

  it('lists every active-status option under the status filter', () => {
    render(<ScopeRail {...baseProps()} />);

    const status = screen.getByLabelText('filters.status') as HTMLSelectElement;
    const optionValues = within(status).getAllByRole('option').map((option) => (option as HTMLOptionElement).value);
    expect(optionValues).toEqual(['all', 'draft', 'final', 'voided']);
  });

  it('renders every scope row as a native button so it is reachable by keyboard', () => {
    const plots = [
      journalPlot({ plot_uuid: 'plot-station', station_code: 'ST-1' }),
      journalPlot({ plot_uuid: 'plot-solo', name: 'Solo field', station_code: null }),
    ];
    const groups = [plotGroup({ members: ['plot-station'] })];

    render(<ScopeRail {...baseProps()} plots={plots} activeGroups={groups} />);

    for (const name of [/filters\.allPlots/, /ST-1/, /North pair/, /Solo field/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('type', 'button');
    }
  });
});
