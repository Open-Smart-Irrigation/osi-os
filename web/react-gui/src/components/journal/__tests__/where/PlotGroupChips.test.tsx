// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JournalPlot, PlotGroup } from '../../../../types/journal';
import { PlotGroupChips } from '../../where/PlotGroupChips';

const translationMocks = vi.hoisted(() => ({
  t: vi.fn((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translationMocks.t }),
}));

const timestamp = '2026-07-18T00:00:00.000Z';

function plot(
  plotUuid: string,
  plotCode: string,
  name: string | null = null,
  overrides: Partial<JournalPlot> = {},
): JournalPlot {
  return {
    contract_version: 1,
    plot_uuid: plotUuid,
    plot_code: plotCode,
    name,
    zone_uuid: null,
    station_code: 'ST-1',
    crop_hint: null,
    area_m2: null,
    active: 1,
    sync_version: 1,
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    settings: {
      layout_code: 'open_field',
      updated_at: timestamp,
      updated_by_principal_uuid: 'author',
      sync_version: 1,
    },
    ...overrides,
  };
}

function group(overrides: Partial<PlotGroup> = {}): PlotGroup {
  return {
    contract_version: 1,
    group_uuid: 'group-1',
    label: 'North block',
    owner_user_uuid: 'owner',
    gateway_device_eui: 'gateway',
    created_by_principal_uuid: 'author',
    created_at: timestamp,
    resolved_at: null,
    resolved_by_principal_uuid: null,
    sync_version: 7,
    deleted_at: null,
    members: ['plot-b', 'plot-a'],
    ...overrides,
  };
}

const plots = [plot('plot-a', 'A-1', 'Alpha'), plot('plot-b', 'B-2', 'Beta')];

function renderChips(overrides: Partial<React.ComponentProps<typeof PlotGroupChips>> = {}) {
  const props: React.ComponentProps<typeof PlotGroupChips> = {
    groups: [group()],
    plots,
    selectedPlotUuids: new Set(),
    onSelectGroup: vi.fn(),
    onTogglePlot: vi.fn(),
    onEditGroup: vi.fn(),
    ...overrides,
  };
  return { ...render(<PlotGroupChips {...props} />), props };
}

describe('PlotGroupChips', () => {
  beforeEach(() => {
    translationMocks.t.mockClear();
  });

  it('renders active groups as selectable chips with individual member controls', () => {
    const onSelectGroup = vi.fn();
    const onTogglePlot = vi.fn();
    renderChips({ onSelectGroup, onTogglePlot });

    fireEvent.click(screen.getByRole('button', { name: 'North block' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    expect(onSelectGroup).toHaveBeenCalledWith(expect.objectContaining({ group_uuid: 'group-1' }));
    expect(onTogglePlot).toHaveBeenCalledWith('plot-a');
    expect(screen.getByText('Alpha')).toBeVisible();
    expect(screen.getByText('Beta')).toBeVisible();
  });

  it('marks selected members and keeps the edit action available', () => {
    const onEditGroup = vi.fn();
    renderChips({ selectedPlotUuids: new Set(['plot-a', 'plot-b']), onEditGroup });

    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /edit group north block/i }));
    expect(onEditGroup).toHaveBeenCalledWith(expect.objectContaining({ group_uuid: 'group-1' }));
  });

  it('keeps primary chip controls touch-sized and visibly focusable', () => {
    renderChips();

    expect(screen.getByRole('button', { name: 'North block' })).toHaveClass('min-h-[56px]');
    expect(screen.getByRole('button', { name: 'North block' })).toHaveClass('focus-visible:ring-2');
  });

  it('shows stale membership without rendering inactive, deleted, or unknown UUID controls', () => {
    renderChips({
      plots: [
        plot('plot-a', 'A-1', 'Alpha'),
        plot('inactive-id', 'inactive', null, { active: 0 }),
        plot('deleted-id', 'deleted', null, { deleted_at: timestamp }),
      ],
      groups: [group({ members: ['plot-a', 'inactive-id', 'deleted-id', 'unknown-id'] })],
    });

    expect(screen.getByRole('button', { name: 'Alpha' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'inactive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'deleted' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'unknown-id' })).not.toBeInTheDocument();
    expect(screen.queryByText('unknown-id')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Some group members are unavailable.');
    expect(translationMocks.t).toHaveBeenCalledWith('group.unavailableMembers', {
      defaultValue: 'Some group members are unavailable.',
    });
  });

  it('disables group selection, member toggles, and editing while a save is pending', () => {
    const onSelectGroup = vi.fn();
    const onTogglePlot = vi.fn();
    const onEditGroup = vi.fn();
    renderChips({ disabled: true, onSelectGroup, onTogglePlot, onEditGroup });

    const groupButton = screen.getByRole('button', { name: 'North block' });
    const memberButton = screen.getByRole('button', { name: 'Alpha' });
    const editButton = screen.getByRole('button', { name: /edit group north block/i });
    expect(groupButton).toBeDisabled();
    expect(memberButton).toBeDisabled();
    expect(editButton).toBeDisabled();

    fireEvent.click(groupButton);
    fireEvent.click(memberButton);
    fireEvent.click(editButton);
    expect(onSelectGroup).not.toHaveBeenCalled();
    expect(onTogglePlot).not.toHaveBeenCalled();
    expect(onEditGroup).not.toHaveBeenCalled();
  });
});
